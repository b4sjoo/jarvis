import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import {
  isParentCanonicalQuestionType,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import type { InterviewTaskRelation } from "./types.js";

export type CurrentQuestionSourceKind = "voice" | "screen" | "mixed";

export type CurrentQuestionAuthority =
  | "explicit-manual"
  | "deterministic-fast-path"
  | "llm-type-repair"
  | "provisional-only";

export type CurrentQuestionAuthoritySource =
  | "manual-correction"
  | "opening-route"
  | "accepted-transcript"
  | "semantic-unknown-rescue"
  | "llm-type-repair"
  | "provisional-only";

export interface ProvisionalCurrentQuestion {
  logicalQuestionUnitId: string;
  revision: number;
  sessionId: string;
  runtimeEpoch: number;
  normalizedText: string;
  sourceTurnIds: string[];
  sourceObservationIds: string[];
  sourceKind: CurrentQuestionSourceKind;
  sourceHash: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

export interface CurrentQuestionMutationAuthorityDecision {
  authority: CurrentQuestionAuthority;
  authoritySource: CurrentQuestionAuthoritySource;
  questionType: CanonicalQuestionType;
  relation: InterviewTaskRelation;
  typeMutationAuthorized: boolean;
  relationMutationAuthorized: boolean;
  parentMutationAuthorized: boolean;
  responseAuthorized: boolean;
  reasons: string[];
}

export function createProvisionalCurrentQuestion(input: {
  logicalQuestionUnit: LogicalQuestionUnit;
  sourceKind: CurrentQuestionSourceKind;
  sourceObservationIds?: string[];
  expiresAt?: number;
  now?: number;
}): ProvisionalCurrentQuestion {
  const { logicalQuestionUnit } = input;
  const sourceTurnIds = uniqueStrings(logicalQuestionUnit.sourceTurnIds);
  const sourceObservationIds = uniqueStrings(
    input.sourceObservationIds ?? []
  );
  const sourceHash = hashCurrentQuestionSource({
    sessionId: logicalQuestionUnit.sessionId,
    runtimeEpoch: logicalQuestionUnit.runtimeEpoch,
    logicalQuestionUnitId: logicalQuestionUnit.id,
    revision: logicalQuestionUnit.revision,
    normalizedText: logicalQuestionUnit.normalizedText,
    sourceTurnIds,
    sourceObservationIds,
  });

  return {
    logicalQuestionUnitId: logicalQuestionUnit.id,
    revision: logicalQuestionUnit.revision,
    sessionId: logicalQuestionUnit.sessionId,
    runtimeEpoch: logicalQuestionUnit.runtimeEpoch,
    normalizedText: logicalQuestionUnit.normalizedText,
    sourceTurnIds,
    sourceObservationIds,
    sourceKind: input.sourceKind,
    sourceHash,
    createdAt: logicalQuestionUnit.startedAt,
    updatedAt: input.now ?? logicalQuestionUnit.updatedAt,
    expiresAt: input.expiresAt,
  };
}

export function decideCurrentQuestionMutationAuthority(input: {
  currentQuestion: ProvisionalCurrentQuestion;
  proposedQuestionType?: unknown;
  proposedRelation: InterviewTaskRelation;
  authoritySource: CurrentQuestionAuthoritySource;
  typeEvidenceAuthorized: boolean;
  relationEvidenceAuthorized: boolean;
  runtimeMutationAuthorized: boolean;
  questionComplete: boolean;
  commitParent: boolean;
}): CurrentQuestionMutationAuthorityDecision {
  const questionType =
    normalizeCanonicalQuestionType(input.proposedQuestionType) ?? "unknown";
  const authority = resolveCurrentQuestionAuthority(input.authoritySource);
  const typeMutationAuthorized =
    input.typeEvidenceAuthorized && questionType !== "unknown";
  const relationMutationAuthorized =
    input.relationEvidenceAuthorized &&
    input.proposedRelation !== "unknown";
  const responseAuthorized = Boolean(
    input.currentQuestion.normalizedText.trim()
  );
  const parentMutationAuthorized =
    typeMutationAuthorized &&
    relationMutationAuthorized &&
    input.runtimeMutationAuthorized &&
    input.questionComplete &&
    input.commitParent &&
    input.proposedRelation === "new-parent" &&
    isParentCanonicalQuestionType(questionType);

  const reasons: string[] = [];
  if (!responseAuthorized) reasons.push("current-question-empty");
  if (questionType === "unknown") reasons.push("question-type-unresolved");
  if (!input.typeEvidenceAuthorized) {
    reasons.push("type-evidence-not-authorized");
  }
  if (input.proposedRelation === "unknown") {
    reasons.push("question-relation-unresolved");
  } else if (!input.relationEvidenceAuthorized) {
    reasons.push("relation-evidence-not-authorized");
  }
  if (!input.runtimeMutationAuthorized) {
    reasons.push("runtime-mutation-not-authorized");
  }
  if (!input.questionComplete) reasons.push("question-incomplete");
  if (!input.commitParent) reasons.push("parent-commit-not-requested");
  if (
    input.proposedRelation !== "new-parent" &&
    input.proposedRelation !== "unknown"
  ) {
    reasons.push("relation-does-not-create-parent");
  }
  if (
    questionType !== "unknown" &&
    !isParentCanonicalQuestionType(questionType)
  ) {
    reasons.push("question-type-not-parent-eligible");
  }
  if (parentMutationAuthorized) reasons.push("parent-mutation-authorized");
  if (!reasons.length) reasons.push("response-only");

  return {
    authority,
    authoritySource: input.authoritySource,
    questionType,
    relation: input.proposedRelation,
    typeMutationAuthorized,
    relationMutationAuthorized,
    parentMutationAuthorized,
    responseAuthorized,
    reasons,
  };
}

export function formatProvisionalCurrentQuestionForTrace(
  question: ProvisionalCurrentQuestion | undefined
): Record<string, unknown> {
  if (!question) return {};
  return {
    currentQuestionUnitId: question.logicalQuestionUnitId,
    currentQuestionRevision: question.revision,
    currentQuestionSessionId: question.sessionId,
    currentQuestionRuntimeEpoch: question.runtimeEpoch,
    currentQuestionSourceTurnIds: question.sourceTurnIds,
    currentQuestionSourceObservationIds: question.sourceObservationIds,
    currentQuestionSourceKind: question.sourceKind,
    currentQuestionSourceHash: question.sourceHash,
    currentQuestionChars: question.normalizedText.length,
    currentQuestionState: "provisional",
  };
}

export function formatCurrentQuestionMutationAuthorityForTrace(
  decision: CurrentQuestionMutationAuthorityDecision | undefined
): Record<string, unknown> {
  if (!decision) return {};
  return {
    currentQuestionAuthority: decision.authority,
    currentQuestionAuthoritySource: decision.authoritySource,
    currentQuestionProposedType: decision.questionType,
    currentQuestionProposedRelation: decision.relation,
    currentQuestionTypeMutationAuthorized:
      decision.typeMutationAuthorized,
    currentQuestionRelationMutationAuthorized:
      decision.relationMutationAuthorized,
    currentQuestionParentMutationAuthorized:
      decision.parentMutationAuthorized,
    currentQuestionResponseAuthorized: decision.responseAuthorized,
    currentQuestionAuthorityReasons: decision.reasons,
  };
}

function resolveCurrentQuestionAuthority(
  source: CurrentQuestionAuthoritySource
): CurrentQuestionAuthority {
  if (source === "manual-correction") return "explicit-manual";
  if (source === "opening-route" || source === "accepted-transcript") {
    return "deterministic-fast-path";
  }
  if (
    source === "semantic-unknown-rescue" ||
    source === "llm-type-repair"
  ) {
    return "llm-type-repair";
  }
  return "provisional-only";
}

function hashCurrentQuestionSource(input: {
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  revision: number;
  normalizedText: string;
  sourceTurnIds: string[];
  sourceObservationIds: string[];
}) {
  const raw = [
    input.sessionId,
    input.runtimeEpoch,
    input.logicalQuestionUnitId,
    input.revision,
    input.normalizedText.trim(),
    input.sourceTurnIds.join(","),
    input.sourceObservationIds.join(","),
  ].join("|");
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `question_source_${(hash >>> 0).toString(36)}`;
}

function uniqueStrings(values: string[]) {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean))
  );
}
