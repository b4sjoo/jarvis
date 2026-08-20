import type {
  PreparationEvidenceItem,
  PreparationNarrativePackGraph,
  PreparationNarrativePackNode,
  PreparationOpeningPackItem,
  PreparationPlaybookOverlay,
  PreparationRuntimeBrief,
  PreparationSpeechBiasTerm,
  PreparationStrategy,
} from "../preparation/index.js";
import type {
  AdvisorPersonalizedPreparationEvidence,
  InterviewPlaybookPhase,
  InterviewBriefType,
  InterviewSessionBrief,
  InterviewTaskRelation,
  OpeningRouteContext,
  ScreenTaskKind,
  SpeechBiasTerm,
} from "./types.js";
import {
  adaptQuestionTypePrior,
  type QuestionTypePriorObservation,
} from "./question-type-consumer-observation.js";
import { readInterviewBriefType } from "./task-taxonomy.js";
import type {
  PreparationKmbEvidenceHint,
  PreparationQuestionTypePrior,
  PreparationRuntimeContext,
  PreparationRuntimeProjection,
} from "./preparation-runtime-context.js";

export interface PreparationRuntimeReinforcement {
  enabled: boolean;
  effectiveInterviewBrief?: InterviewSessionBrief;
  runtimeBrief?: PreparationRuntimeProjection<PreparationRuntimeBrief>;
  questionTypePrior?: PreparationRuntimeProjection<PreparationQuestionTypePrior>;
  questionTypePriorObservation?: QuestionTypePriorObservation;
  programmingLanguage?: PreparationRuntimeProjection<string>;
  speechBiasTerms: Array<
    PreparationRuntimeProjection<PreparationSpeechBiasTerm>
  >;
}

export interface SelectedPreparationStrategy {
  projection: PreparationRuntimeProjection<PreparationStrategy>;
  value: Partial<PreparationStrategy>;
  usedArtifactIds: string[];
}

export interface SelectedPreparationFactEvidence {
  projection: PreparationRuntimeProjection<PreparationEvidenceItem>;
  value: PreparationEvidenceItem;
  usedArtifactIds: string[];
}

export interface SelectedPreparationKmbHint {
  projection: PreparationRuntimeProjection<PreparationKmbEvidenceHint>;
  value: PreparationKmbEvidenceHint;
  usedArtifactIds: string[];
}

export interface SelectedPreparationOpeningItem {
  projection: PreparationRuntimeProjection<PreparationOpeningPackItem>;
  value: PreparationOpeningPackItem;
  usedArtifactIds: string[];
}

export interface SelectedPreparationNarrative {
  projection: PreparationRuntimeProjection<PreparationNarrativePackGraph>;
  graphId: string;
  subjectKind: PreparationNarrativePackGraph["subjectKind"];
  subjectId: string;
  nodes: PreparationNarrativePackNode[];
  usedArtifactIds: string[];
}

export interface SelectedPreparationPlaybookOverlay {
  projection: PreparationRuntimeProjection<PreparationPlaybookOverlay>;
  value: PreparationPlaybookOverlay;
  usedArtifactIds: string[];
}

export interface PreparationPersonalizedGuidance {
  enabled: boolean;
  strategy?: SelectedPreparationStrategy;
  factEvidence: SelectedPreparationFactEvidence[];
  kmbEvidenceHints: SelectedPreparationKmbHint[];
  openingItems: SelectedPreparationOpeningItem[];
  narratives: SelectedPreparationNarrative[];
  playbookOverlay?: SelectedPreparationPlaybookOverlay;
}

export interface ResolvePreparationPersonalizedGuidanceInput {
  questionType?: ScreenTaskKind | string;
  taskRelation?: InterviewTaskRelation;
  playbookId?: string;
  playbookPhase?: InterviewPlaybookPhase;
  openingRoute?: OpeningRouteContext;
  projectAnchor?: string;
  query?: string;
}

export function resolvePreparationRuntimeReinforcement(
  context: PreparationRuntimeContext,
  fallbackBrief?: InterviewSessionBrief
): PreparationRuntimeReinforcement {
  const lowImpact = context.projections?.lowImpact;
  const enabled = Boolean(
    context.mode === "prepared" &&
      context.loadState === "ready" &&
      context.capabilities.runtimeReinforcement.enabled &&
      lowImpact
  );
  if (!enabled || !lowImpact) {
    const questionTypePriorObservation = fallbackBrief?.interviewTypes.length
      ? adaptQuestionTypePrior({
          source: "interview-brief",
          types: fallbackBrief.interviewTypes,
        })
      : undefined;
    return {
      enabled: false,
      effectiveInterviewBrief: fallbackBrief
        ? cloneInterviewBrief(fallbackBrief)
        : undefined,
      questionTypePriorObservation,
      speechBiasTerms: [],
    };
  }

  const runtimeBrief = lowImpact.runtimeBrief.value;
  const questionTypePriorObservation = adaptQuestionTypePrior({
    source: "preparation-snapshot",
    sourceId: lowImpact.questionTypePrior.projectionId,
    types: lowImpact.questionTypePrior.value.expectedInterviewTypes,
    expectedTypePolicy:
      lowImpact.questionTypePrior.value.expectedTypePolicy,
  });
  const preparedTypes = questionTypePriorObservation.legacyInterviewBriefTypes
    .map(readInterviewBriefType)
    .filter((type): type is InterviewBriefType => Boolean(type));
  const targetCompany = runtimeBrief.company?.trim();
  const fallbackTypes = fallbackBrief?.interviewTypes ?? [];
  const effectiveInterviewBrief: InterviewSessionBrief | undefined =
    targetCompany || preparedTypes.length || fallbackBrief
      ? {
          targetCompany:
            targetCompany ?? fallbackBrief?.targetCompany ?? "",
          targetCompanyNormalized: targetCompany
            ? normalizeCompany(targetCompany)
            : fallbackBrief?.targetCompanyNormalized,
          companyLocked: targetCompany
            ? true
            : Boolean(
                fallbackBrief?.targetCompany.trim() &&
                  fallbackBrief.companyLocked
              ),
          interviewTypes:
            preparedTypes.length > 0
              ? preparedTypes
              : [...fallbackTypes],
          updatedAt: fallbackBrief?.updatedAt,
        }
      : undefined;

  return {
    enabled: true,
    effectiveInterviewBrief,
    runtimeBrief: lowImpact.runtimeBrief,
    questionTypePrior: lowImpact.questionTypePrior,
    questionTypePriorObservation,
    programmingLanguage: lowImpact.programmingLanguage,
    speechBiasTerms: [...lowImpact.speechBiasTerms],
  };
}

export function resolvePreparationPersonalizedGuidance(
  context: PreparationRuntimeContext,
  input: ResolvePreparationPersonalizedGuidanceInput
): PreparationPersonalizedGuidance {
  const personalized = context.projections?.personalized;
  const enabled = Boolean(
    context.mode === "prepared" &&
      context.loadState === "ready" &&
      context.capabilities.runtimeReinforcement.enabled &&
      context.capabilities.personalizedGuidance.enabled &&
      personalized
  );
  if (!enabled || !personalized) {
    return emptyPersonalizedGuidance();
  }

  const interviewFamily = toPreparationInterviewFamily(input.questionType);
  const query = [input.query, input.projectAnchor]
    .filter(Boolean)
    .join(" ")
    .trim();
  const openingItems = selectOpeningItems(
    personalized.openingItems,
    input.openingRoute,
    input.projectAnchor,
    query
  );
  const narratives = selectNarratives(
    personalized.narrativeGraphs,
    input.openingRoute,
    input.questionType,
    input.projectAnchor,
    query
  );
  const referencedStatementIds = new Set([
    ...openingItems.flatMap((item) => item.value.statementIds),
    ...narratives.flatMap((narrative) =>
      narrative.nodes.flatMap((node) => node.statementIds)
    ),
  ]);
  const factEvidence = selectFactEvidence(
    personalized.factEvidence,
    interviewFamily,
    query,
    referencedStatementIds
  );
  const playbookOverlay = selectPlaybookOverlay(
    personalized.playbookOverlays,
    interviewFamily,
    input.playbookId
  );

  return {
    enabled: true,
    strategy: selectStrategy(personalized.strategy, input),
    factEvidence,
    kmbEvidenceHints: selectKmbHints(
      personalized.kmbEvidenceHints,
      query
    ),
    openingItems,
    narratives,
    playbookOverlay,
  };
}

export function toAdvisorPersonalizedPreparationEvidence(
  guidance: PreparationPersonalizedGuidance
): AdvisorPersonalizedPreparationEvidence | undefined {
  if (!guidance.enabled) return undefined;
  return {
    strategy: guidance.strategy?.value,
    factEvidence: guidance.factEvidence.map(({ value }) => ({
      statementId: value.statementId,
      content: value.content,
      ownership: value.ownership,
      allowedWording: value.allowedWording,
      prohibitedWording: [...value.prohibitedWording],
      sourceIds: [...value.sourceIds],
    })),
    openingItems: guidance.openingItems.map(({ value }) => ({
      ...value,
      statementIds: [...value.statementIds],
    })),
    narratives: guidance.narratives.map((narrative) => ({
      graphId: narrative.graphId,
      subjectKind: narrative.subjectKind,
      subjectId: narrative.subjectId,
      nodes: narrative.nodes.map((node) => ({
        ...node,
        statementIds: [...node.statementIds],
      })),
    })),
    playbookOverlay: guidance.playbookOverlay
      ? {
          ...guidance.playbookOverlay.value,
          evidenceStatementIds: [
            ...guidance.playbookOverlay.value.evidenceStatementIds,
          ],
          companyCriteria: [
            ...guidance.playbookOverlay.value.companyCriteria,
          ],
          prohibitedOverclaims: [
            ...guidance.playbookOverlay.value.prohibitedOverclaims,
          ],
        }
      : undefined,
  };
}

export function toPreparedSpeechBiasTerms(
  projections: Array<
    PreparationRuntimeProjection<PreparationSpeechBiasTerm>
  >
): SpeechBiasTerm[] {
  const terms = new Map<string, SpeechBiasTerm>();
  const add = (term: string) => {
    const normalized = term.trim();
    if (!normalized) return;
    const key = normalized.toLocaleLowerCase();
    if (!terms.has(key)) {
      terms.set(key, {
        term: normalized,
        source: "preparation",
        weight: "high",
      });
    }
  };
  for (const projection of projections) {
    add(projection.value.canonicalTerm);
    for (const alias of projection.value.aliases) add(alias);
  }
  return Array.from(terms.values());
}

export function preparationProjectionArtifactIds<T>(
  projection: PreparationRuntimeProjection<T>,
  pathPrefixes: string[] = []
): string[] {
  const refs = pathPrefixes.length
    ? projection.artifactRefs.filter((artifact) =>
        pathPrefixes.some(
          (prefix) =>
            artifact.artifactPath === prefix ||
            artifact.artifactPath.startsWith(`${prefix}/`)
        )
      )
    : projection.artifactRefs;
  return refs.map((artifact) => artifact.artifactId);
}

function emptyPersonalizedGuidance(): PreparationPersonalizedGuidance {
  return {
    enabled: false,
    factEvidence: [],
    kmbEvidenceHints: [],
    openingItems: [],
    narratives: [],
  };
}

function selectStrategy(
  projection: PreparationRuntimeProjection<PreparationStrategy>,
  input: ResolvePreparationPersonalizedGuidanceInput
): SelectedPreparationStrategy | undefined {
  const categories = new Set<keyof PreparationStrategy>([
    "priorities",
    "risks",
  ]);
  if (
    input.taskRelation === "new-parent" ||
    input.openingRoute ||
    isRequirementPhase(input.playbookPhase)
  ) {
    categories.add("questionsToAsk");
    categories.add("timeAllocation");
  }
  if (
    input.taskRelation === "child-probe" ||
    input.taskRelation === "followup-parent" ||
    input.taskRelation === "resume-parent"
  ) {
    categories.add("likelyBranches");
  }

  const value: Partial<PreparationStrategy> = {};
  const pathPrefixes: string[] = [];
  for (const category of categories) {
    const values = projection.value[category];
    if (!values.length) continue;
    value[category] = [...values];
    pathPrefixes.push(`strategy/${category}`);
  }
  const usedArtifactIds = preparationProjectionArtifactIds(
    projection,
    pathPrefixes
  );
  return usedArtifactIds.length
    ? { projection, value, usedArtifactIds }
    : undefined;
}

function selectFactEvidence(
  projections: Array<PreparationRuntimeProjection<PreparationEvidenceItem>>,
  interviewFamily: string | undefined,
  query: string,
  referencedStatementIds: Set<string>
): SelectedPreparationFactEvidence[] {
  return projections
    .filter((projection) => {
      const allowed = projection.value.allowedInterviewFamilies;
      return !allowed.length || Boolean(interviewFamily && allowed.includes(interviewFamily));
    })
    .map((projection) => ({
      projection,
      score:
        (referencedStatementIds.has(projection.value.statementId) ? 100 : 0) +
        relevanceScore(
          [projection.value.content, projection.value.allowedWording]
            .filter(Boolean)
            .join(" "),
          query
        ),
    }))
    .filter(({ projection, score }) => {
      if (referencedStatementIds.has(projection.value.statementId)) return true;
      if (!query) return false;
      return score > 0;
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 6)
    .map(({ projection }) => ({
      projection,
      value: projection.value,
      usedArtifactIds: preparationProjectionArtifactIds(projection),
    }));
}

function selectKmbHints(
  projections: Array<PreparationRuntimeProjection<PreparationKmbEvidenceHint>>,
  query: string
): SelectedPreparationKmbHint[] {
  if (!query) return [];
  return projections
    .map((projection) => ({
      projection,
      score: relevanceScore(projection.value.title, query),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map(({ projection }) => ({
      projection,
      value: projection.value,
      usedArtifactIds: preparationProjectionArtifactIds(projection),
    }));
}

function selectOpeningItems(
  projections: Array<PreparationRuntimeProjection<PreparationOpeningPackItem>>,
  openingRoute: OpeningRouteContext | undefined,
  projectAnchor: string | undefined,
  query: string
): SelectedPreparationOpeningItem[] {
  if (!openingRoute) return [];
  const expectedSubject =
    openingRoute.kind === "self-intro" ||
    openingRoute.kind === "resume-walkthrough"
      ? "self-introduction"
      : "project";
  return projections
    .filter((projection) => projection.value.subjectKind === expectedSubject)
    .map((projection) => ({
      projection,
      score:
        (openingNodeKindScore(projection.value.nodeKind) ?? 0) +
        relevanceScore(
          [
            projection.value.subjectId,
            projection.value.title,
            projection.value.renderedDraft,
          ].join(" "),
          [projectAnchor, query].filter(Boolean).join(" ")
        ),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, openingRoute.kind === "self-intro" ? 2 : 1)
    .map(({ projection }) => ({
      projection,
      value: projection.value,
      usedArtifactIds: preparationProjectionArtifactIds(projection),
    }));
}

function selectNarratives(
  projections: Array<PreparationRuntimeProjection<PreparationNarrativePackGraph>>,
  openingRoute: OpeningRouteContext | undefined,
  questionType: ScreenTaskKind | string | undefined,
  projectAnchor: string | undefined,
  query: string
): SelectedPreparationNarrative[] {
  const expectedSubject = openingRoute
    ? openingRoute.kind === "self-intro" ||
      openingRoute.kind === "resume-walkthrough"
      ? "self-introduction"
      : "project"
    : toPreparationInterviewFamily(questionType) === "project-deep-dive"
      ? "project"
      : undefined;
  if (!expectedSubject) return [];

  return projections
    .filter((projection) => projection.value.subjectKind === expectedSubject)
    .map((projection) => ({
      projection,
      score: relevanceScore(
        [
          projection.value.subjectId,
          ...projection.value.nodes.flatMap((node) => [node.title, node.content]),
        ].join(" "),
        [projectAnchor, query].filter(Boolean).join(" ")
      ),
    }))
    .filter(({ score }) =>
      expectedSubject === "self-introduction" ? true : score > 0
    )
    .sort((left, right) => right.score - left.score)
    .slice(0, 1)
    .map(({ projection }) => {
      const nodes = selectNarrativeNodes(
        projection.value.nodes,
        openingRoute,
        query
      );
      const selectedNodeIds = new Set(nodes.map((node) => node.nodeId));
      const pathPrefixes = [
        ...nodes.map(
          (node) =>
            `narratives/${encodeURIComponent(projection.value.graphId)}/nodes/${encodeURIComponent(node.nodeId)}`
        ),
        ...projection.value.edges
          .filter(
            (edge) =>
              selectedNodeIds.has(edge.fromNodeId) &&
              selectedNodeIds.has(edge.toNodeId)
          )
          .map(
            (edge) =>
              `narratives/${encodeURIComponent(projection.value.graphId)}/edges/${encodeURIComponent(edge.fromNodeId)}-${encodeURIComponent(edge.relation)}-${encodeURIComponent(edge.toNodeId)}`
          ),
      ];
      return {
        projection,
        graphId: projection.value.graphId,
        subjectKind: projection.value.subjectKind,
        subjectId: projection.value.subjectId,
        nodes,
        usedArtifactIds: preparationProjectionArtifactIds(
          projection,
          pathPrefixes
        ),
      };
    })
    .filter((selection) => selection.nodes.length && selection.usedArtifactIds.length);
}

function selectNarrativeNodes(
  nodes: PreparationNarrativePackNode[],
  openingRoute: OpeningRouteContext | undefined,
  query: string
) {
  const preferredKinds = openingRoute
    ? new Set([
        "positioning",
        "intro-30s",
        "main-story-90s",
        "role-mapping",
      ])
    : new Set([
        "main-story-90s",
        "architecture",
        "tradeoff",
        "failure-recovery",
        "retrospective",
        "follow-up",
      ]);
  return nodes
    .map((node) => ({
      node,
      score:
        (preferredKinds.has(node.kind) ? 20 : 0) +
        relevanceScore([node.title, node.content].join(" "), query),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, openingRoute ? 3 : 4)
    .map(({ node }) => ({ ...node, statementIds: [...node.statementIds] }));
}

function selectPlaybookOverlay(
  projections: Array<PreparationRuntimeProjection<PreparationPlaybookOverlay>>,
  interviewFamily: string | undefined,
  playbookId: string | undefined
): SelectedPreparationPlaybookOverlay | undefined {
  if (!interviewFamily || !playbookId) return undefined;
  const projection = projections.find(
    (candidate) =>
      candidate.value.expectedInterviewType === interviewFamily &&
      candidate.value.canonicalPlaybookId === playbookId
  );
  return projection
    ? {
        projection,
        value: projection.value,
        usedArtifactIds: preparationProjectionArtifactIds(projection),
      }
    : undefined;
}

function toPreparationInterviewFamily(
  questionType: ScreenTaskKind | string | undefined
) {
  if (questionType === "system-design") return "general-system-design";
  if (
    questionType === "behavioral" ||
    questionType === "coding" ||
    questionType === "general-system-design" ||
    questionType === "ai-ml-system-design" ||
    questionType === "project-deep-dive" ||
    questionType === "field-knowledge"
  ) {
    return questionType;
  }
  return undefined;
}

function isRequirementPhase(phase: InterviewPlaybookPhase | undefined) {
  return Boolean(
    phase &&
      (phase.includes("requirement") || phase.includes("clarification"))
  );
}

function openingNodeKindScore(kind: PreparationOpeningPackItem["nodeKind"]) {
  if (kind === "intro-30s") return 30;
  if (kind === "positioning") return 20;
  if (kind === "main-story-90s") return 10;
  return 0;
}

function relevanceScore(candidate: string, query: string) {
  const candidateNormalized = normalizeSearchText(candidate);
  const queryNormalized = normalizeSearchText(query);
  if (!candidateNormalized || !queryNormalized) return 0;
  let score = 0;
  if (
    candidateNormalized.includes(queryNormalized) ||
    queryNormalized.includes(candidateNormalized)
  ) {
    score += 25;
  }
  const candidateTokens = new Set(tokenizeSearchText(candidateNormalized));
  for (const token of tokenizeSearchText(queryNormalized)) {
    if (candidateTokens.has(token)) score += token.length >= 8 ? 6 : 3;
  }
  return score;
}

function tokenizeSearchText(value: string) {
  return value
    .split(" ")
    .filter(
      (token) =>
        token.length >= 3 &&
        !SEARCH_STOP_WORDS.has(token)
    );
}

function normalizeSearchText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const SEARCH_STOP_WORDS = new Set([
  "about",
  "and",
  "can",
  "could",
  "for",
  "from",
  "how",
  "please",
  "tell",
  "that",
  "the",
  "this",
  "what",
  "when",
  "where",
  "with",
  "would",
  "you",
  "your",
]);

function cloneInterviewBrief(
  brief: InterviewSessionBrief
): InterviewSessionBrief {
  return {
    ...brief,
    interviewTypes: [...brief.interviewTypes],
  };
}

function normalizeCompany(value: string) {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}
