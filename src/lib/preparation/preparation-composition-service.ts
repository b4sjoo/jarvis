import type { InterviewProcessRepository } from "./interview-types.js";
import {
  PREPARATION_NARRATIVE_EDGE_RELATIONS,
  PREPARATION_NARRATIVE_NODE_KINDS,
  PREPARATION_NARRATIVE_SUBJECT_KINDS,
  type InterviewPreparationProfileRevision,
  type PreparationCompositionRepository,
  type PreparationNarrativeEdgeRelation,
  type PreparationNarrativeGraph,
  type PreparationNarrativeNodeKind,
  type PreparationNarrativeReviewStatus,
  type PreparationNarrativeSubjectKind,
  type PreparationProfileContent,
  type PreparationStatementRepository,
  type PreparationStatementWithSources,
} from "./statement-types.js";
import type { PreparationConversationScope } from "./conversation-types.js";
import {
  resolvePreparationModelRoute,
  type PreparationModelRoute,
} from "./model-route.js";
import { stablePreparationHash } from "./statement-proposal-service.js";
import type {
  Message,
  SelectedAiProviderConfig,
  TYPE_PROVIDER,
} from "../../types/index.js";

const NARRATIVE_TIMEOUT_MS = 180_000;
const NARRATIVE_MAX_OUTPUT_TOKENS = 12_288;
const MAX_NARRATIVE_OUTPUT_CHARS = 45_000;
const MAX_NARRATIVE_NODES = 12;
const MAX_NARRATIVE_EDGES = 20;

type PreparationFetchResponse = (input: {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedAiProviderConfig;
  systemPrompt?: string;
  history?: Message[];
  userMessage: string;
  signal?: AbortSignal;
  applyResponseSettings?: boolean;
  requestOptions?: { timeoutMs?: number; maxOutputTokens?: number };
}) => AsyncIterable<string>;

export interface PreparationCompositionEvent {
  name:
    | "Preparation profile composed"
    | "Preparation profile reused"
    | "Preparation narrative started"
    | "Preparation narrative edge contract repaired"
    | "Preparation narrative finished"
    | "Preparation narrative failed"
    | "Preparation narrative stale result dropped";
  timestamp: number;
  processId: string;
  roundId?: string;
  profileRevision?: number;
  graphRevision?: number;
  statementCount?: number;
  nodeCount?: number;
  edgeCount?: number;
  normalizedEdgeCount?: number;
  droppedEdgeCount?: number;
  normalizedEdgeRelations?: string[];
  droppedEdgeRelations?: string[];
  durationMs?: number;
  error?: string;
}

export function createPreparationCompositionService(dependencies: {
  statements: PreparationStatementRepository;
  composition: PreparationCompositionRepository;
  interviewProcesses: InterviewProcessRepository;
  fetchResponse: PreparationFetchResponse;
  now?: () => number;
  createId?: () => string;
  onEvent?: (event: PreparationCompositionEvent) => void;
}) {
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? (() => crypto.randomUUID());
  const emit = (event: PreparationCompositionEvent) =>
    dependencies.onEvent?.(event);

  return {
    resolveRoute(input: {
      providers: TYPE_PROVIDER[];
      selectedProvider: SelectedAiProviderConfig;
    }) {
      return resolvePreparationModelRoute(input);
    },

    async composeProfile(input: {
      processId: string;
      scope: PreparationConversationScope;
    }) {
      const startedAt = now();
      await requireWritableScope(dependencies.interviewProcesses, input);
      const statements = await dependencies.statements.list({
        processId: input.processId,
        roundId: input.scope.kind === "round" ? input.scope.roundId : undefined,
      });
      const confirmed = statements
        .filter((statement) => statement.status === "confirmed")
        .sort(statementOrder);
      if (!confirmed.length) {
        throw new Error("Confirm at least one statement before composing a profile.");
      }
      const unresolved = statements
        .filter((statement) => statement.status === "unresolved")
        .sort(statementOrder);
      const sourceFingerprint = createPreparationProfileSourceFingerprint(confirmed);
      const existing = await dependencies.composition.getProfileByFingerprint({
        processId: input.processId,
        scope: input.scope,
        sourceFingerprint,
      });
      if (existing) {
        emit({
          name: "Preparation profile reused",
          timestamp: now(),
          processId: input.processId,
          roundId: input.scope.kind === "round" ? input.scope.roundId : undefined,
          profileRevision: existing.revision,
          statementCount: confirmed.length,
          durationMs: now() - startedAt,
        });
        return { profile: existing, created: false };
      }
      const latest = await dependencies.composition.getLatestProfile(input);
      const content = composeProfileContent(confirmed);
      const profile: InterviewPreparationProfileRevision = {
        id: `preparation-profile-${createId()}`,
        processId: input.processId,
        scope: input.scope,
        revision: (latest?.revision ?? 0) + 1,
        sourceFingerprint,
        contentHash: stablePreparationHash(JSON.stringify(content)),
        content,
        confirmedStatementIds: confirmed.map((statement) => statement.id),
        unresolvedStatementIds: unresolved.map((statement) => statement.id),
        createdAt: now(),
      };
      await dependencies.composition.insertProfile({
        profile,
        statementRevisions: confirmed.map((statement) => ({
          statementId: statement.id,
          statementRevision: statement.revision,
        })),
      });
      emit({
        name: "Preparation profile composed",
        timestamp: now(),
        processId: input.processId,
        roundId: input.scope.kind === "round" ? input.scope.roundId : undefined,
        profileRevision: profile.revision,
        statementCount: confirmed.length,
        durationMs: now() - startedAt,
      });
      return { profile, created: true };
    },

    getLatestProfile(input: {
      processId: string;
      scope: PreparationConversationScope;
    }) {
      return dependencies.composition.getLatestProfile(input);
    },

    listProfiles(input: {
      processId: string;
      scope: PreparationConversationScope;
    }) {
      return dependencies.composition.listProfiles(input);
    },

    listNarratives(input: { processId: string; roundId?: string }) {
      return dependencies.composition.listNarrativeGraphs(input);
    },

    async generateNarrative(input: {
      processId: string;
      scope: PreparationConversationScope;
      profileRevisionId: string;
      statementIds: string[];
      subjectKind: PreparationNarrativeSubjectKind;
      subjectId: string;
      title: string;
      route: PreparationModelRoute;
      signal?: AbortSignal;
    }) {
      requireReadyRoute(input.route);
      const startedAt = now();
      await requireWritableScope(dependencies.interviewProcesses, input);
      if (!PREPARATION_NARRATIVE_SUBJECT_KINDS.includes(input.subjectKind)) {
        throw new Error("Unknown narrative subject kind.");
      }
      const profile = await dependencies.composition.getLatestProfile({
        processId: input.processId,
        scope: input.scope,
      });
      if (!profile || profile.id !== input.profileRevisionId) {
        throw new Error("Compose or refresh the current profile first.");
      }
      const visibleStatements = await dependencies.statements.list({
        processId: input.processId,
        roundId: input.scope.kind === "round" ? input.scope.roundId : undefined,
        statuses: ["confirmed"],
      });
      const visibleById = new Map(
        visibleStatements.map((statement) => [statement.id, statement])
      );
      if (
        profile.sourceFingerprint !==
        createPreparationProfileSourceFingerprint(visibleStatements)
      ) {
        throw new Error("Compose or refresh the current profile first.");
      }
      const selectedIds = Array.from(new Set(input.statementIds));
      if (!selectedIds.length) {
        throw new Error("Select at least one confirmed statement.");
      }
      const selected = selectedIds.map((statementId) => {
        const statement = visibleById.get(statementId);
        if (
          !statement ||
          !profile.confirmedStatementIds.includes(statementId) ||
          statement.status !== "confirmed"
        ) {
          throw new Error("A selected statement is not in the current profile.");
        }
        return statement;
      });
      const sourceFingerprint = stablePreparationHash(
        JSON.stringify({
          profileRevisionId: profile.id,
          statements: selected.map((statement) => ({
            id: statement.id,
            revision: statement.revision,
          })),
          subjectKind: input.subjectKind,
          subjectId: normalizeSubject(input.subjectId),
        })
      );
      emit({
        name: "Preparation narrative started",
        timestamp: startedAt,
        processId: input.processId,
        roundId: input.scope.kind === "round" ? input.scope.roundId : undefined,
        profileRevision: profile.revision,
        statementCount: selected.length,
      });

      try {
        let response = "";
        for await (const chunk of dependencies.fetchResponse({
          provider: input.route.provider,
          selectedProvider: input.route.selectedProvider,
          systemPrompt: PREPARATION_NARRATIVE_SYSTEM_PROMPT,
          userMessage: buildNarrativePrompt({
            subjectKind: input.subjectKind,
            subjectId: normalizeSubject(input.subjectId),
            title: normalizeSubject(input.title),
            statements: selected,
          }),
          signal: input.signal,
          applyResponseSettings: false,
          requestOptions: {
            timeoutMs: NARRATIVE_TIMEOUT_MS,
            maxOutputTokens: NARRATIVE_MAX_OUTPUT_TOKENS,
          },
        })) {
          response += chunk;
          if (response.length > MAX_NARRATIVE_OUTPUT_CHARS) {
            throw new Error("Narrative response exceeded its output budget.");
          }
        }
        if (input.signal?.aborted) {
          return { status: "cancelled" as const };
        }
        const parsed = parsePreparationNarrative(response, selected);
        if (
          parsed.edgeDiagnostics.normalized.length ||
          parsed.edgeDiagnostics.dropped.length
        ) {
          emit({
            name: "Preparation narrative edge contract repaired",
            timestamp: now(),
            processId: input.processId,
            roundId:
              input.scope.kind === "round" ? input.scope.roundId : undefined,
            profileRevision: profile.revision,
            statementCount: selected.length,
            edgeCount: parsed.edges.length,
            normalizedEdgeCount: parsed.edgeDiagnostics.normalized.length,
            droppedEdgeCount: parsed.edgeDiagnostics.dropped.length,
            normalizedEdgeRelations: parsed.edgeDiagnostics.normalized,
            droppedEdgeRelations: parsed.edgeDiagnostics.dropped,
            durationMs: now() - startedAt,
          });
        }
        const currentProfile = await dependencies.composition.getLatestProfile({
          processId: input.processId,
          scope: input.scope,
        });
        const currentStatements = await dependencies.statements.list({
          processId: input.processId,
          roundId: input.scope.kind === "round" ? input.scope.roundId : undefined,
          statuses: ["confirmed"],
        });
        const currentRevisions = new Map(
          currentStatements.map((statement) => [statement.id, statement.revision])
        );
        const stale =
          currentProfile?.id !== profile.id ||
          currentProfile.sourceFingerprint !==
            createPreparationProfileSourceFingerprint(currentStatements) ||
          selected.some(
            (statement) =>
              currentRevisions.get(statement.id) !== statement.revision
          );
        if (stale) {
          emit({
            name: "Preparation narrative stale result dropped",
            timestamp: now(),
            processId: input.processId,
            roundId:
              input.scope.kind === "round" ? input.scope.roundId : undefined,
            profileRevision: profile.revision,
            statementCount: selected.length,
            durationMs: now() - startedAt,
          });
          return { status: "stale" as const };
        }
        const revision = await dependencies.composition.nextNarrativeRevision({
          processId: input.processId,
          scope: input.scope,
          subjectKind: input.subjectKind,
          subjectId: normalizeSubject(input.subjectId),
        });
        const graphId = `preparation-narrative-${createId()}`;
        const createdAt = now();
        const nodeIds = new Map(
          parsed.nodes.map((node) => [node.localId, `preparation-node-${createId()}`])
        );
        const graph: PreparationNarrativeGraph = {
          id: graphId,
          processId: input.processId,
          scope: input.scope,
          profileRevisionId: profile.id,
          subjectKind: input.subjectKind,
          subjectId: normalizeSubject(input.subjectId),
          revision,
          sourceFingerprint,
          status: "current",
          createdAt,
          updatedAt: createdAt,
          nodes: parsed.nodes.map((node, ordinal) => ({
            id: nodeIds.get(node.localId)!,
            graphId,
            ordinal,
            kind: node.kind,
            title: node.title,
            contentDraft: node.content,
            targetSeconds: node.targetSeconds,
            statementIds: node.statementIds,
            reviewStatus: "proposed",
            revision: 0,
            createdAt,
            updatedAt: createdAt,
          })),
          edges: parsed.edges.map((edge) => ({
            id: `preparation-edge-${createId()}`,
            graphId,
            fromNodeId: nodeIds.get(edge.from)!,
            toNodeId: nodeIds.get(edge.to)!,
            relation: edge.relation,
            createdAt,
          })),
        };
        await dependencies.composition.insertNarrativeGraph({
          graph,
          statementRevisions: new Map(
            selected.map((statement) => [statement.id, statement.revision])
          ),
        });
        emit({
          name: "Preparation narrative finished",
          timestamp: now(),
          processId: input.processId,
          roundId: input.scope.kind === "round" ? input.scope.roundId : undefined,
          profileRevision: profile.revision,
          graphRevision: graph.revision,
          statementCount: selected.length,
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
          durationMs: now() - startedAt,
        });
        return { status: "committed" as const, graph };
      } catch (error) {
        emit({
          name: "Preparation narrative failed",
          timestamp: now(),
          processId: input.processId,
          roundId: input.scope.kind === "round" ? input.scope.roundId : undefined,
          profileRevision: profile.revision,
          statementCount: selected.length,
          durationMs: now() - startedAt,
          error: errorMessage(error),
        });
        throw error;
      }
    },

    async reviewNarrativeNode(input: {
      processId: string;
      graphId: string;
      nodeId: string;
      expectedRevision: number;
      contentDraft: string;
      reviewStatus: PreparationNarrativeReviewStatus;
    }) {
      const process = await dependencies.interviewProcesses.getProcess(
        input.processId
      );
      if (!process) throw new Error("Interview process not found.");
      if (process.status !== "active") {
        throw new Error("Archived interview processes are read-only.");
      }
      const graph = await dependencies.composition.getNarrativeGraph(
        input.processId,
        input.graphId
      );
      const node = graph?.nodes.find((candidate) => candidate.id === input.nodeId);
      if (!graph || !node) throw new Error("Narrative node not found.");
      if (node.revision !== input.expectedRevision) {
        throw new Error("This narrative node changed while it was being reviewed.");
      }
      const contentDraft = normalizeNarrativeText(input.contentDraft, 4_000);
      if (input.reviewStatus === "confirmed") {
        const statements = await dependencies.statements.list({
          processId: input.processId,
          roundId: graph.scope.kind === "round" ? graph.scope.roundId : undefined,
          statuses: ["confirmed"],
        });
        const byId = new Map(statements.map((statement) => [statement.id, statement]));
        for (const statementId of node.statementIds) {
          const statement = byId.get(statementId);
          if (!statement || statement.ownership === "unresolved") {
            throw new Error(
              "Resolve every supporting statement before confirming this narrative."
            );
          }
        }
      }
      const updated = await dependencies.composition.reviewNarrativeNode({
        processId: input.processId,
        nodeId: input.nodeId,
        expectedRevision: input.expectedRevision,
        contentDraft,
        reviewStatus: input.reviewStatus,
        updatedAt: now(),
      });
      if (!updated) {
        throw new Error("This narrative node changed while it was being reviewed.");
      }
      return dependencies.composition.getNarrativeGraph(
        input.processId,
        input.graphId
      );
    },
  };
}

export const PREPARATION_NARRATIVE_SYSTEM_PROMPT = [
  "You draft modular interview narratives from user-confirmed statements.",
  "Use only the statement labels supplied in this request.",
  "Do not add achievements, metrics, ownership, chronology, mechanisms, or outcomes not present in those statements.",
  "Keep each node independently reviewable and speakable.",
  `Edge relation must be exactly one of: ${PREPARATION_NARRATIVE_EDGE_RELATIONS.join(", ")}. Omit an edge when none applies.`,
  "Return only one <preparation_narrative_graph> JSON block with root schema {\"nodes\":[...],\"edges\":[...]}",
].join(" ");

function buildNarrativePrompt(input: {
  subjectKind: PreparationNarrativeSubjectKind;
  subjectId: string;
  title: string;
  statements: PreparationStatementWithSources[];
}) {
  return [
    `<subject kind=${JSON.stringify(input.subjectKind)} id=${JSON.stringify(input.subjectId)} title=${JSON.stringify(input.title)} />`,
    `<allowed_node_kinds>${PREPARATION_NARRATIVE_NODE_KINDS.join(", ")}</allowed_node_kinds>`,
    "<confirmed_statements>",
    ...input.statements.map(
      (statement, index) =>
        `[S${index + 1}] domain=${statement.domain} ownership=${statement.ownership} content=${JSON.stringify(statement.content)} allowedWording=${JSON.stringify(statement.allowedWording ?? "")} prohibitedWording=${JSON.stringify(statement.prohibitedWording)}`
    ),
    "</confirmed_statements>",
    `Each node must include localId, kind, title, content, targetSeconds, and statementLabels. Every edge must reference node localIds and relation must exactly equal one of: ${PREPARATION_NARRATIVE_EDGE_RELATIONS.join(", ")}. Omit uncertain edges. Return at most 12 nodes and 20 edges.`,
  ].join("\n");
}

export function composeProfileContent(
  statements: PreparationStatementWithSources[]
): PreparationProfileContent {
  const content: PreparationProfileContent = {
    logistics: [],
    evidence: [],
    terminology: [],
    strategy: [],
    companyGuidance: [],
    interviewPolicy: [],
    questions: [],
    risks: [],
    other: [],
  };
  for (const statement of statements) {
    switch (statement.domain) {
      case "interview-logistics":
        content.logistics.push(statement.content);
        break;
      case "candidate-fact":
      case "project-evidence":
        content.evidence.push(statement.content);
        break;
      case "terminology":
        content.terminology.push(statement.content);
        break;
      case "strategy":
        content.strategy.push(statement.content);
        break;
      case "company-guidance":
        content.companyGuidance.push(statement.content);
        break;
      case "interview-policy":
        content.interviewPolicy.push(statement.content);
        break;
      case "question-to-ask":
        content.questions.push(statement.content);
        break;
      case "risk":
        content.risks.push(statement.content);
        break;
      case "unknown":
        content.other.push(statement.content);
        break;
    }
  }
  return content;
}

interface ParsedNarrativeNode {
  localId: string;
  kind: PreparationNarrativeNodeKind;
  title: string;
  content: string;
  targetSeconds?: number;
  statementIds: string[];
}

interface ParsedNarrativeEdge {
  from: string;
  to: string;
  relation: PreparationNarrativeEdgeRelation;
}

interface ParsedNarrativeEdgeDiagnostics {
  normalized: string[];
  dropped: string[];
}

export function parsePreparationNarrative(
  response: string,
  statements: PreparationStatementWithSources[]
): {
  nodes: ParsedNarrativeNode[];
  edges: ParsedNarrativeEdge[];
  edgeDiagnostics: ParsedNarrativeEdgeDiagnostics;
} {
  const match = /<preparation_narrative_graph>\s*([\s\S]*?)\s*<\/preparation_narrative_graph>/iu.exec(
    response
  );
  if (!match) {
    throw new Error("The Preparation Model omitted the narrative contract.");
  }
  const normalized = (match[1] ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  let payload: unknown;
  try {
    payload = JSON.parse(normalized);
  } catch {
    throw new Error("The Preparation Model returned invalid narrative JSON.");
  }
  const record = asRecord(payload);
  const statementLabels = new Map(
    statements.map((statement, index) => [`S${index + 1}`, statement.id])
  );
  const nodes = (Array.isArray(record.nodes) ? record.nodes : [])
    .slice(0, MAX_NARRATIVE_NODES)
    .map((raw): ParsedNarrativeNode => {
      const item = asRecord(raw);
      const localId = normalizeLocalId(stringValue(item.localId));
      const kind = stringValue(item.kind);
      if (!PREPARATION_NARRATIVE_NODE_KINDS.includes(kind as never)) {
        throw new Error("The Preparation Model returned an unknown narrative node kind.");
      }
      const labels = stringArray(item.statementLabels);
      if (!labels.length || labels.some((label) => !statementLabels.has(label))) {
        throw new Error("A narrative node referenced an unknown statement.");
      }
      return {
        localId,
        kind: kind as PreparationNarrativeNodeKind,
        title: normalizeNarrativeText(stringValue(item.title), 160),
        content: normalizeNarrativeText(stringValue(item.content), 4_000),
        targetSeconds:
          typeof item.targetSeconds === "number" && item.targetSeconds > 0
            ? Math.min(600, Math.floor(item.targetSeconds))
            : undefined,
        statementIds: Array.from(
          new Set(labels.map((label) => statementLabels.get(label)!))
        ),
      };
    });
  if (!nodes.length) throw new Error("The Preparation Model returned no narrative nodes.");
  const localIds = new Set(nodes.map((node) => node.localId));
  if (localIds.size !== nodes.length) {
    throw new Error("The Preparation Model duplicated a narrative node id.");
  }
  const edges: ParsedNarrativeEdge[] = [];
  const normalizedRelations: string[] = [];
  const droppedRelations: string[] = [];
  const edgeKeys = new Set<string>();
  for (const raw of (Array.isArray(record.edges) ? record.edges : []).slice(
    0,
    MAX_NARRATIVE_EDGES
  )) {
    const item = asRecord(raw);
    const from = optionalLocalId(item.from);
    const to = optionalLocalId(item.to);
    const rawRelation = stringValue(item.relation);
    const resolved = resolveNarrativeEdgeRelation(rawRelation);
    if (!from || !to || !localIds.has(from) || !localIds.has(to) || from === to) {
      droppedRelations.push(`invalid-node:${boundedDiagnostic(rawRelation)}`);
      continue;
    }
    if (!resolved.relation) {
      droppedRelations.push(`unknown:${boundedDiagnostic(rawRelation)}`);
      continue;
    }
    if (resolved.normalized) {
      normalizedRelations.push(
        `${boundedDiagnostic(rawRelation)}->${resolved.relation}`
      );
    }
    const key = `${from}\u0000${to}\u0000${resolved.relation}`;
    if (edgeKeys.has(key)) {
      droppedRelations.push(`duplicate:${resolved.relation}`);
      continue;
    }
    edgeKeys.add(key);
    edges.push({ from, to, relation: resolved.relation });
  }
  return {
    nodes,
    edges,
    edgeDiagnostics: {
      normalized: Array.from(new Set(normalizedRelations)),
      dropped: Array.from(new Set(droppedRelations)),
    },
  };
}

async function requireWritableScope(
  repository: InterviewProcessRepository,
  input: { processId: string; scope: PreparationConversationScope }
) {
  const process = await repository.getProcess(input.processId);
  if (!process) throw new Error("Interview process not found.");
  if (process.status !== "active") {
    throw new Error("Archived interview processes are read-only.");
  }
  if (input.scope.kind === "round") {
    const round = await repository.getRound(input.scope.roundId);
    if (!round || round.processId !== input.processId || round.archivedAt) {
      throw new Error("Interview round does not belong to this process.");
    }
  }
}

export function createPreparationProfileSourceFingerprint(
  statements: PreparationStatementWithSources[]
) {
  const confirmed = statements
    .filter((statement) => statement.status === "confirmed")
    .slice()
    .sort(statementOrder);
  return stablePreparationHash(
    JSON.stringify(
      confirmed.map((statement) => ({
        id: statement.id,
        revision: statement.revision,
        content: statement.normalizedContent,
      }))
    )
  );
}

function statementOrder(
  left: PreparationStatementWithSources,
  right: PreparationStatementWithSources
) {
  return (
    left.domain.localeCompare(right.domain) ||
    left.normalizedContent.localeCompare(right.normalizedContent) ||
    left.id.localeCompare(right.id)
  );
}

function normalizeSubject(value: string) {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized) throw new Error("Narrative subject is required.");
  return normalized.slice(0, 200);
}

function normalizeNarrativeText(value: string, maxChars: number) {
  const normalized = value.normalize("NFKC").replace(/\r\n/gu, "\n").trim();
  if (!normalized) throw new Error("Narrative content is required.");
  if (normalized.length > maxChars) {
    throw new Error("Narrative content exceeded its bounded field size.");
  }
  return normalized;
}

function normalizeLocalId(value: string) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/u.test(normalized)) {
    throw new Error("The Preparation Model returned an invalid narrative node id.");
  }
  return normalized;
}

function requireReadyRoute(route: PreparationModelRoute) {
  if (route.status !== "ready") {
    throw new Error("Choose a valid Preparation Model in Dev Space first.");
  }
}

const NARRATIVE_EDGE_RELATION_ALIASES: Record<
  string,
  PreparationNarrativeEdgeRelation
> = {
  expand: "expands",
  "expands-on": "expands",
  elaborates: "expands",
  "elaborates-on": "expands",
  support: "supports",
  reinforces: "supports",
  "evidence-for": "supports",
  contrast: "contrasts",
  "contrasts-with": "contrasts",
  "answers-followup": "answers-follow-up",
  "answer-follow-up": "answers-follow-up",
  "responds-to-follow-up": "answers-follow-up",
};

function resolveNarrativeEdgeRelation(value: string): {
  relation?: PreparationNarrativeEdgeRelation;
  normalized: boolean;
} {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[\s_]+/gu, "-")
    .replace(/-+/gu, "-");
  if (PREPARATION_NARRATIVE_EDGE_RELATIONS.includes(normalized as never)) {
    return {
      relation: normalized as PreparationNarrativeEdgeRelation,
      normalized: normalized !== value,
    };
  }
  return {
    relation: NARRATIVE_EDGE_RELATION_ALIASES[normalized],
    normalized: Boolean(NARRATIVE_EDGE_RELATION_ALIASES[normalized]),
  };
}

function optionalLocalId(value: unknown) {
  try {
    return normalizeLocalId(stringValue(value));
  } catch {
    return undefined;
  }
}

function boundedDiagnostic(value: string) {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return normalized.slice(0, 80) || "<empty>";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? Array.from(
        new Set(
          value
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean)
        )
      )
    : [];
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
