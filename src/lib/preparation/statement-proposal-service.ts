import type { InterviewProcessRepository } from "./interview-types.js";
import type { createPreparationConversationService } from "./conversation-service.js";
import type { createPreparationContextComposer } from "./context-composer.js";
import type {
  PreparationContextSourceRef,
  PreparationConversationScope,
  PreparationMessage,
} from "./conversation-types.js";
import {
  resolvePreparationModelRoute,
  type PreparationModelRoute,
} from "./model-route.js";
import {
  PREPARATION_STATEMENT_DOMAINS,
  type PreparationProposalSourceManifestItem,
  type PreparationStatement,
  type PreparationStatementOwnership,
  type PreparationStatementProposal,
  type PreparationStatementRepository,
  type PreparationStatementSource,
} from "./statement-types.js";
import {
  normalizeStatementContent,
  normalizeStatementKey,
} from "./statement-service.js";
import type {
  Message,
  SelectedAiProviderConfig,
  TYPE_PROVIDER,
} from "../../types/index.js";

const MAX_USER_MESSAGES = 6;
const MAX_USER_MESSAGE_CHARS = 8_000;
const MAX_PROPOSALS = 8;
const MAX_OUTPUT_CHARS = 30_000;
const PROPOSAL_TIMEOUT_MS = 180_000;
const PROPOSAL_MAX_OUTPUT_TOKENS = 8_192;

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

export interface PreparationStatementProposalEvent {
  name:
    | "Preparation statement proposal started"
    | "Preparation statement proposal finished"
    | "Preparation statement proposal failed"
    | "Preparation statement proposal stale result dropped";
  timestamp: number;
  processId: string;
  conversationId: string;
  operationId: string;
  providerId?: string;
  sourceCount?: number;
  returnedCount?: number;
  acceptedCount?: number;
  rejectedCount?: number;
  durationMs?: number;
  error?: string;
}

export function createPreparationStatementProposalService(dependencies: {
  statements: PreparationStatementRepository;
  conversations: ReturnType<typeof createPreparationConversationService>;
  contextComposer: ReturnType<typeof createPreparationContextComposer>;
  interviewProcesses: InterviewProcessRepository;
  fetchResponse: PreparationFetchResponse;
  now?: () => number;
  createId?: () => string;
  onEvent?: (event: PreparationStatementProposalEvent) => void;
}) {
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? (() => crypto.randomUUID());
  const emit = (event: PreparationStatementProposalEvent) =>
    dependencies.onEvent?.(event);

  return {
    resolveRoute(input: {
      providers: TYPE_PROVIDER[];
      selectedProvider: SelectedAiProviderConfig;
    }) {
      return resolvePreparationModelRoute(input);
    },

    async generate(input: {
      processId: string;
      conversationId: string;
      route: PreparationModelRoute;
      signal?: AbortSignal;
    }) {
      requireReadyRoute(input.route);
      const startedAt = now();
      const operationId = `preparation-statement-proposal-${createId()}`;
      const process = await dependencies.interviewProcesses.getProcess(
        input.processId
      );
      if (!process) throw new Error("Interview process not found.");
      if (process.status !== "active") {
        throw new Error("Archived interview processes are read-only.");
      }
      const detail = await dependencies.conversations.load(
        input.processId,
        input.conversationId
      );
      const scope = detail.conversation.scope;
      const round =
        scope.kind === "round"
          ? await dependencies.interviewProcesses.getRound(scope.roundId)
          : undefined;
      if (
        scope.kind === "round" &&
        (!round || round.processId !== process.id || round.archivedAt)
      ) {
        throw new Error("Interview round does not belong to this process.");
      }
      const userMessages = selectUserEvidence(detail.messages);
      const queryMessage = userMessages.at(-1);
      if (!queryMessage) {
        throw new Error(
          "This conversation needs a committed user message before proposals can be generated."
        );
      }
      const composition = await dependencies.contextComposer.compose({
        process,
        round,
        lease: {
          conversation: detail.conversation,
          userMessage: queryMessage,
          operationId,
          logicalTurnId: queryMessage.logicalTurnId,
          expectedRevision: detail.conversation.revision,
        },
        messages: detail.messages,
      });
      const manifest = buildProposalSourceManifest(
        userMessages,
        composition.sourceRefs,
        composition.systemContext
      );
      const persistedManifest = manifest.map(({ content: _content, ...source }) => source);
      const sourceManifestJson = JSON.stringify(persistedManifest);
      const sourceManifestHash = stablePreparationHash(sourceManifestJson);
      await dependencies.statements.beginProposalOperation({
        id: operationId,
        processId: process.id,
        scope,
        conversationId: detail.conversation.id,
        expectedConversationRevision: detail.conversation.revision,
        providerId:
          input.route.provider?.id ?? input.route.selectedProvider.provider,
        sourceManifestJson,
        sourceManifestHash,
        status: "staging",
        createdAt: startedAt,
      });
      emit({
        name: "Preparation statement proposal started",
        timestamp: startedAt,
        processId: process.id,
        conversationId: detail.conversation.id,
        operationId,
        providerId: input.route.provider?.id,
        sourceCount: manifest.length,
      });

      try {
        let response = "";
        for await (const chunk of dependencies.fetchResponse({
          provider: input.route.provider,
          selectedProvider: input.route.selectedProvider,
          systemPrompt: PREPARATION_STATEMENT_PROPOSAL_SYSTEM_PROMPT,
          userMessage: buildProposalPrompt({
            scope,
            userMessages,
            systemContext: evidenceOnlyContext(
              composition.systemContext,
              manifest
            ),
            manifest,
          }),
          signal: input.signal,
          applyResponseSettings: false,
          requestOptions: {
            timeoutMs: PROPOSAL_TIMEOUT_MS,
            maxOutputTokens: PROPOSAL_MAX_OUTPUT_TOKENS,
          },
        })) {
          response += chunk;
          if (response.length > MAX_OUTPUT_CHARS) {
            throw new Error("Statement proposal response exceeded its output budget.");
          }
        }
        if (input.signal?.aborted) {
          await dependencies.statements.settleProposalOperation({
            operationId,
            status: "cancelled",
            settledAt: now(),
          });
          return { status: "cancelled" as const, acceptedCount: 0 };
        }
        const parsed = parsePreparationStatementProposals(response, scope);
        const accepted = validateAndDedupeProposals(parsed, manifest, scope);
        const existing = await dependencies.statements.list({
          processId: process.id,
          roundId: scope.kind === "round" ? scope.roundId : undefined,
        });
        const existingKeys = new Set(
          existing
            .filter((statement) => sameScope(statement.scope, scope))
            .map((statement) => statement.normalizedContent)
        );
        const fresh = accepted.filter(
          (proposal) => !existingKeys.has(normalizeStatementKey(proposal.content))
        );
        const createdAt = now();
        const staged = fresh.map((proposal) => {
          const statementId = `preparation-statement-${createId()}`;
          const sources = proposal.sourceLabels.map((label) => {
            const source = manifest.find((candidate) => candidate.label === label)!;
            return proposalSourceToStatementSource(
              source,
              statementId,
              createdAt,
              createId
            );
          });
          const statement: PreparationStatement = {
            id: statementId,
            processId: process.id,
            scope,
            domain: proposal.domain,
            content: normalizeStatementContent(proposal.content),
            normalizedContent: normalizeStatementKey(proposal.content),
            status: "proposed",
            authority: "model-generated",
            ownership: proposal.ownership,
            allowedWording: proposal.allowedWording,
            prohibitedWording: proposal.prohibitedWording,
            allowedInterviewFamilies: proposal.allowedInterviewFamilies,
            proposalOperationId: operationId,
            sourceMessageId: sources.find(
              (source) => source.sourceType === "preparation-message"
            )?.sourceId,
            confidence: proposal.confidence,
            revision: 0,
            lastReviewAction: "proposed",
            lastReviewActor: "model",
            createdAt,
            updatedAt: createdAt,
          };
          return { statement, sources };
        });
        await dependencies.statements.stageProposalBatch({
          operationId,
          statements: staged,
        });
        const committed = await dependencies.statements.commitProposalOperation({
          operationId,
          settledAt: now(),
        });
        if (!committed) {
          emit({
            name: "Preparation statement proposal stale result dropped",
            timestamp: now(),
            processId: process.id,
            conversationId: detail.conversation.id,
            operationId,
            providerId: input.route.provider?.id,
            returnedCount: parsed.length,
            acceptedCount: 0,
            rejectedCount: parsed.length,
            durationMs: now() - startedAt,
          });
          return { status: "stale" as const, acceptedCount: 0 };
        }
        emit({
          name: "Preparation statement proposal finished",
          timestamp: now(),
          processId: process.id,
          conversationId: detail.conversation.id,
          operationId,
          providerId: input.route.provider?.id,
          returnedCount: parsed.length,
          acceptedCount: staged.length,
          rejectedCount: Math.max(0, parsed.length - staged.length),
          durationMs: now() - startedAt,
        });
        return {
          status: "committed" as const,
          acceptedCount: staged.length,
          duplicateCount: accepted.length - fresh.length,
        };
      } catch (error) {
        await dependencies.statements.settleProposalOperation({
          operationId,
          status: input.signal?.aborted ? "cancelled" : "failed",
          settledAt: now(),
          error: errorMessage(error),
        });
        emit({
          name: "Preparation statement proposal failed",
          timestamp: now(),
          processId: process.id,
          conversationId: detail.conversation.id,
          operationId,
          providerId: input.route.provider?.id,
          durationMs: now() - startedAt,
          error: errorMessage(error),
        });
        throw error;
      }
    },
  };
}

export const PREPARATION_STATEMENT_PROPOSAL_SYSTEM_PROMPT = [
  "You extract reviewable interview-preparation statements from bounded evidence.",
  "You propose; you never confirm truth.",
  "Use only the labeled user messages, material excerpts, and curated-memory excerpts supplied in this request.",
  "Do not use assistant answers, generated summaries, filenames alone, or outside knowledge as evidence.",
  "Each statement must be atomic, independently reviewable, and cite one or more exact source labels.",
  "Keep candidate work distinct from team work, upstream behavior, and future design.",
  "Return only one <preparation_statement_proposals> JSON block with root schema {\"statements\":[...]}",
].join(" ");

function buildProposalPrompt(input: {
  scope: PreparationConversationScope;
  userMessages: PreparationMessage[];
  systemContext: string;
  manifest: PreparationProposalSourceManifestItem[];
}) {
  const userEvidence = input.userMessages
    .map((message, index) => `[U${index + 1}] ${message.content}`)
    .join("\n\n");
  return [
    `<target_scope>${input.scope.kind === "process" ? "process" : "round"}</target_scope>`,
    `<allowed_domains>${PREPARATION_STATEMENT_DOMAINS.join(", ")}</allowed_domains>`,
    `<allowed_ownership>candidate-owned, team-owned, upstream-existing, future-design, unresolved</allowed_ownership>`,
    `<source_manifest>\n${input.manifest
      .map(
        (source) =>
          `${source.label}: type=${source.sourceType} id=${source.sourceId} title=${JSON.stringify(source.title)}`
      )
      .join("\n")}\n</source_manifest>`,
    `<user_message_evidence>\n${userEvidence}\n</user_message_evidence>`,
    input.systemContext
      ? `<source_evidence>\n${input.systemContext}\n</source_evidence>`
      : "",
    "For each statement return: domain, content, scope, sourceLabels, ownership, confidence, allowedWording, prohibitedWording, allowedInterviewFamilies. Return at most 8 statements. The scope must exactly match target_scope.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parsePreparationStatementProposals(
  response: string,
  expectedScope: PreparationConversationScope
): PreparationStatementProposal[] {
  const match = /<preparation_statement_proposals>\s*([\s\S]*?)\s*<\/preparation_statement_proposals>/iu.exec(
    response
  );
  if (!match) {
    throw new Error(
      "The Preparation Model omitted the required statement-proposal contract."
    );
  }
  const normalized = (match[1] ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  let payload: unknown;
  try {
    payload = JSON.parse(normalized);
  } catch {
    throw new Error("The Preparation Model returned invalid statement JSON.");
  }
  const record = asRecord(payload);
  const statements = Array.isArray(record.statements) ? record.statements : [];
  return statements.slice(0, MAX_PROPOSALS).map((raw) => {
    const item = asRecord(raw);
    const domain = stringValue(item.domain);
    const scopeValue = stringValue(item.scope);
    const ownership = stringValue(item.ownership);
    if (!PREPARATION_STATEMENT_DOMAINS.includes(domain as never)) {
      throw new Error("The Preparation Model returned an unknown statement domain.");
    }
    if (scopeValue !== expectedScope.kind) {
      throw new Error("The Preparation Model attempted to change statement scope.");
    }
    if (!isOwnership(ownership)) {
      throw new Error("The Preparation Model returned unknown statement ownership.");
    }
    return {
      domain: domain as PreparationStatementProposal["domain"],
      content: normalizeStatementContent(stringValue(item.content)),
      scope: expectedScope,
      sourceLabels: stringArray(item.sourceLabels).slice(0, 12),
      ownership,
      confidence:
        typeof item.confidence === "number"
          ? Math.max(0, Math.min(1, item.confidence))
          : undefined,
      allowedWording: optionalString(item.allowedWording),
      prohibitedWording: stringArray(item.prohibitedWording).slice(0, 20),
      allowedInterviewFamilies: stringArray(
        item.allowedInterviewFamilies
      ).slice(0, 20),
    };
  });
}

function validateAndDedupeProposals(
  proposals: PreparationStatementProposal[],
  manifest: PreparationProposalSourceManifestItem[],
  scope: PreparationConversationScope
) {
  const allowedLabels = new Set(manifest.map((source) => source.label));
  const seen = new Set<string>();
  return proposals.filter((proposal) => {
    if (!sameScope(proposal.scope, scope)) return false;
    if (!proposal.sourceLabels.length) return false;
    if (proposal.sourceLabels.some((label) => !allowedLabels.has(label))) {
      return false;
    }
    const key = normalizeStatementKey(proposal.content);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildProposalSourceManifest(
  userMessages: PreparationMessage[],
  sourceRefs: PreparationContextSourceRef[],
  systemContext: string
): PreparationProposalSourceManifestItem[] {
  const labeledEvidence = extractLabeledEvidence(systemContext);
  const users = userMessages.map((message, index) => ({
    label: `U${index + 1}`,
    sourceType: "preparation-message" as const,
    sourceId: message.id,
    title: "User message",
    content: message.content,
    contentHash: stablePreparationHash(message.content),
  }));
  let materialIndex = 0;
  let kmbIndex = 0;
  const refs = sourceRefs.flatMap((source) => {
      const label = source.kind === "material"
        ? `M${++materialIndex}`
        : `K${++kmbIndex}`;
      const eligible =
        source.kind === "kmb" ||
        (source.sourceMethod !== "material-inventory" &&
          source.materialStatus !== "needs-review" &&
          Boolean(source.materialRevisionId));
      if (!eligible) return [];
      return {
        label,
        sourceType:
          source.kind === "material"
            ? ("material-chunk" as const)
            : ("curated-kmb" as const),
        sourceId: source.id,
        title: source.title,
        content: labeledEvidence.get(label) ?? "",
        materialId: source.materialId,
        materialRevisionId: source.materialRevisionId,
        page: source.page,
        section: source.section,
        contentHash: stablePreparationHash(
          labeledEvidence.get(label) ??
            JSON.stringify({
              id: source.id,
              revision: source.materialRevisionId,
              selectedChars: source.selectedChars,
            })
        ),
      };
    });
  return [...users, ...refs];
}

function extractLabeledEvidence(systemContext: string) {
  const evidence = new Map<string, string>();
  for (const match of systemContext.matchAll(
    /^\[([MK]\d+)\]\s+([\s\S]*?)(?=\n\n\[[MK]\d+\]|\n<\/|$)/gmu
  )) {
    const label = match[1];
    const content = match[2]?.trim();
    if (label && content) evidence.set(label, content);
  }
  return evidence;
}

function proposalSourceToStatementSource(
  source: PreparationProposalSourceManifestItem,
  statementId: string,
  createdAt: number,
  createId: () => string
): PreparationStatementSource {
  return {
    id: `preparation-statement-source-${createId()}`,
    statementId,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    title: source.title,
    materialId: source.materialId,
    materialRevisionId: source.materialRevisionId,
    page: source.page,
    section: source.section,
    contentHash: source.contentHash,
    createdAt,
  };
}

function selectUserEvidence(messages: PreparationMessage[]) {
  const selected: PreparationMessage[] = [];
  let chars = 0;
  for (const message of [...messages].reverse()) {
    if (message.role !== "user" || !message.committedAt) continue;
    if (selected.length >= MAX_USER_MESSAGES) break;
    if (chars + message.content.length > MAX_USER_MESSAGE_CHARS && selected.length) {
      break;
    }
    selected.push(message);
    chars += message.content.length;
  }
  return selected.reverse();
}

function evidenceOnlyContext(
  systemContext: string,
  manifest: PreparationProposalSourceManifestItem[]
) {
  const allowedLabels = new Set(manifest.map((source) => source.label));
  return Array.from(
    systemContext.matchAll(
      /<(untrusted_material_evidence|curated_memory_evidence)>\s*([\s\S]*?)\s*<\/\1>/giu
    ),
    (match) => {
      const entries = (match[2] ?? "")
        .split(/\n\n(?=\[[MK]\d+\])/gu)
        .filter((entry) => {
          const label = /^\[([MK]\d+)\]/u.exec(entry.trim())?.[1];
          return Boolean(label && allowedLabels.has(label));
        });
      return entries.length
        ? `<${match[1]}>\n${entries.join("\n\n")}\n</${match[1]}>`
        : "";
    }
  )
    .filter(Boolean)
    .join("\n\n");
}

export function stablePreparationHash(value: string) {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ (code + index), 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

function sameScope(
  left: PreparationConversationScope,
  right: PreparationConversationScope
) {
  return (
    left.kind === right.kind &&
    (left.kind === "process" ||
      (right.kind === "round" && left.roundId === right.roundId))
  );
}

function requireReadyRoute(route: PreparationModelRoute) {
  if (route.status !== "ready") {
    throw new Error("Choose a valid Preparation Model in Dev Space first.");
  }
}

function isOwnership(value: string): value is PreparationStatementOwnership {
  return [
    "candidate-owned",
    "team-owned",
    "upstream-existing",
    "future-design",
    "unresolved",
  ].includes(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown) {
  const text = stringValue(value).normalize("NFKC").replace(/\s+/gu, " ").trim();
  return text ? text.slice(0, 1_200) : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? Array.from(
        new Set(
          value
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.normalize("NFKC").replace(/\s+/gu, " ").trim())
            .filter(Boolean)
        )
      )
    : [];
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
