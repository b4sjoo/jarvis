import type {
  AnswerContextDefect,
  AnswerRepairRecommendation,
  AnswerSufficiencyDecision,
  AnswerSufficiencyStatus,
} from "./answer-sufficiency.js";
import { createMeetingId } from "./context-manager.js";
import { buildRuntimeInferenceModelInput } from "./runtime-inference.js";

export const ANSWER_SUFFICIENCY_ADJUDICATION_SCHEMA_VERSION = 1;
export const ANSWER_SUFFICIENCY_ADJUDICATION_PROMPT_VERSION =
  "answer-sufficiency-adjudication-prompt-v1";
export const ANSWER_SUFFICIENCY_ADJUDICATION_MAX_QUESTION_CHARS = 1_200;
export const ANSWER_SUFFICIENCY_ADJUDICATION_MAX_ANSWER_CHARS = 1_600;
export const ANSWER_SUFFICIENCY_ADJUDICATION_MAX_CONTEXT_CHARS = 800;
export const ANSWER_SUFFICIENCY_LLM_SHADOW_DEFAULT_ENABLED = false;

export interface AnswerSufficiencyAdjudicationRequest {
  schemaVersion: 1;
  promptVersion: string;
  identity: {
    traceId: string;
    questionId: string;
    logicalQuestionUnitId: string;
    logicalQuestionUnitRevision: number;
    answerRevision: number;
  };
  questionText: string;
  answerText: string;
  artifactState: {
    expected: string[];
    missing: string[];
  };
  nearbySourceContext?: string;
}

export interface LlmAnswerSufficiencyAdjudication {
  schemaVersion: 1;
  answerStatus:
    | "sufficient"
    | "context-insufficient"
    | "legitimate-wait"
    | "clarification-needed"
    | "unknown";
  contextDefect: AnswerContextDefect;
  recommendedRepair: AnswerRepairRecommendation;
  evidenceSpans: string[];
  confidence: number;
  ambiguityReason?: string;
}

export type AnswerSufficiencyAdjudicationParseResult =
  | {
      ok: true;
      value: LlmAnswerSufficiencyAdjudication;
      evidenceSpansValid: true;
    }
  | { ok: false; reason: string; evidenceSpansValid: boolean };

export interface AnswerSufficiencyAdjudicationLease {
  operationId: string;
  sessionId: string;
  runtimeEpoch: number;
  traceId: string;
  questionId: string;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  answerRevision: number;
  sourceTurnIdsHash: string;
  expectedParentId?: string;
  expectedParentRevision?: number;
  manualCorrectionRevision: number;
  requestedAt: number;
}

export interface AnswerSufficiencyAdjudicationLeaseSnapshot {
  currentOperationId?: string;
  sessionId: string;
  runtimeEpoch: number;
  traceId: string;
  questionId: string;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  answerRevision: number;
  sourceTurnIdsHash: string;
  activeParentId?: string;
  activeParentRevision?: number;
  manualCorrectionRevision: number;
}

export function decideAnswerSufficiencyLlmEligibility(input: {
  enabled: boolean;
  decision: AnswerSufficiencyDecision;
}) {
  if (!input.enabled) {
    return { eligible: false, reason: "llm-sufficiency-shadow-disabled" };
  }
  if (
    input.decision.answerStatus === "execution-failure" ||
    input.decision.answerStatus === "fact-anchor-missing"
  ) {
    return { eligible: false, reason: "terminal-non-context-failure" };
  }
  if (
    input.decision.answerStatus === "context-insufficient" &&
    input.decision.confidence >= 0.94 &&
    input.decision.semanticStatus === "context-insufficient"
  ) {
    return { eligible: false, reason: "high-confidence-local-agreement" };
  }
  if (
    input.decision.answerStatus === "sufficient" &&
    input.decision.confidence >= 0.8 &&
    input.decision.semanticStatus !== "context-insufficient"
  ) {
    return { eligible: false, reason: "high-confidence-sufficient" };
  }
  return { eligible: true, reason: "ambiguous-answer-sufficiency" };
}

export function buildAnswerSufficiencyAdjudicationRequest(input: {
  decision: AnswerSufficiencyDecision;
  questionText: string;
  answerText: string;
  nearbySourceContext?: string;
}): AnswerSufficiencyAdjudicationRequest {
  return {
    schemaVersion: ANSWER_SUFFICIENCY_ADJUDICATION_SCHEMA_VERSION,
    promptVersion: ANSWER_SUFFICIENCY_ADJUDICATION_PROMPT_VERSION,
    identity: {
      traceId: input.decision.traceId,
      questionId: input.decision.questionId,
      logicalQuestionUnitId: input.decision.logicalQuestionUnitId,
      logicalQuestionUnitRevision:
        input.decision.logicalQuestionUnitRevision,
      answerRevision: input.decision.answerRevision,
    },
    questionText: clip(
      input.questionText,
      ANSWER_SUFFICIENCY_ADJUDICATION_MAX_QUESTION_CHARS
    ),
    answerText: clip(
      input.answerText,
      ANSWER_SUFFICIENCY_ADJUDICATION_MAX_ANSWER_CHARS
    ),
    artifactState: {
      expected: [...input.decision.expectedArtifactKinds],
      missing: [...input.decision.missingArtifactKinds],
    },
    nearbySourceContext: input.nearbySourceContext
      ? clip(
          input.nearbySourceContext,
          ANSWER_SUFFICIENCY_ADJUDICATION_MAX_CONTEXT_CHARS
        )
      : undefined,
  };
}

export function buildAnswerSufficiencyAdjudicationPrompts(
  request: AnswerSufficiencyAdjudicationRequest
) {
  const semanticPayload = {
    questionText: request.questionText,
    answerText: request.answerText,
    artifactState: request.artifactState,
    ...(request.nearbySourceContext
      ? { nearbySourceContext: request.nearbySourceContext }
      : {}),
  };
  const systemPrompt = [
      "Judge whether one Jarvis answer sufficiently addresses its bounded current question.",
      "Return one JSON object only. Do not rewrite or improve the answer.",
      "Distinguish context insufficiency from a legitimate wait, a useful clarification, and an otherwise sufficient answer.",
      "Use only the supplied question, answer, artifact state, and nearby source-owned context.",
      "Evidence spans must be verbatim substrings of the supplied question, answer, or nearby source context.",
      "Schema: {schemaVersion:1,answerStatus,contextDefect,recommendedRepair,evidenceSpans,confidence,ambiguityReason?}.",
    ].join(" ");
  return buildRuntimeInferenceModelInput({ systemPrompt, semanticPayload });
}

export function parseAnswerSufficiencyAdjudicationOutput(
  rawOutput: string,
  request: AnswerSufficiencyAdjudicationRequest
): AnswerSufficiencyAdjudicationParseResult {
  if (!rawOutput.trim()) {
    return { ok: false, reason: "empty-output", evidenceSpansValid: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(rawOutput));
  } catch {
    return { ok: false, reason: "malformed-json", evidenceSpansValid: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "output-is-not-object", evidenceSpansValid: false };
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.schemaVersion !==
    ANSWER_SUFFICIENCY_ADJUDICATION_SCHEMA_VERSION
  ) {
    return {
      ok: false,
      reason: "unsupported-schema-version",
      evidenceSpansValid: false,
    };
  }
  if (!isAdjudicatedStatus(candidate.answerStatus)) {
    return { ok: false, reason: "invalid-answer-status", evidenceSpansValid: false };
  }
  if (!isContextDefect(candidate.contextDefect)) {
    return { ok: false, reason: "invalid-context-defect", evidenceSpansValid: false };
  }
  if (!isRepairRecommendation(candidate.recommendedRepair)) {
    return { ok: false, reason: "invalid-repair", evidenceSpansValid: false };
  }
  if (
    typeof candidate.confidence !== "number" ||
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1
  ) {
    return { ok: false, reason: "invalid-confidence", evidenceSpansValid: false };
  }
  if (
    !Array.isArray(candidate.evidenceSpans) ||
    candidate.evidenceSpans.length === 0 ||
    candidate.evidenceSpans.some(
      (span) => typeof span !== "string" || !span.trim()
    )
  ) {
    return { ok: false, reason: "missing-evidence", evidenceSpansValid: false };
  }
  const allowedEvidence = [
    request.questionText,
    request.answerText,
    request.nearbySourceContext,
  ]
    .filter(Boolean)
    .join("\n")
    .toLocaleLowerCase();
  const evidenceSpans = candidate.evidenceSpans as string[];
  const evidenceSpansValid = evidenceSpans.every((span) =>
    allowedEvidence.includes(normalize(span).toLocaleLowerCase())
  );
  if (!evidenceSpansValid) {
    return { ok: false, reason: "invalid-evidence-span", evidenceSpansValid };
  }
  if (
    candidate.ambiguityReason !== undefined &&
    typeof candidate.ambiguityReason !== "string"
  ) {
    return {
      ok: false,
      reason: "invalid-ambiguity-reason",
      evidenceSpansValid: true,
    };
  }
  return {
    ok: true,
    evidenceSpansValid: true,
    value: {
      schemaVersion: ANSWER_SUFFICIENCY_ADJUDICATION_SCHEMA_VERSION,
      answerStatus: candidate.answerStatus,
      contextDefect: candidate.contextDefect,
      recommendedRepair: candidate.recommendedRepair,
      evidenceSpans,
      confidence: candidate.confidence,
      ambiguityReason: candidate.ambiguityReason as string | undefined,
    },
  };
}

export function createAnswerSufficiencyAdjudicationLease(input: {
  sessionId: string;
  runtimeEpoch: number;
  decision: AnswerSufficiencyDecision;
  sourceTurnIds: string[];
  expectedParentId?: string;
  expectedParentRevision?: number;
  manualCorrectionRevision: number;
  operationId?: string;
  requestedAt?: number;
}): AnswerSufficiencyAdjudicationLease {
  return {
    operationId:
      input.operationId ?? createMeetingId("answer_sufficiency_adjudication"),
    sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    traceId: input.decision.traceId,
    questionId: input.decision.questionId,
    logicalQuestionUnitId: input.decision.logicalQuestionUnitId,
    logicalQuestionUnitRevision:
      input.decision.logicalQuestionUnitRevision,
    answerRevision: input.decision.answerRevision,
    sourceTurnIdsHash: hashSourceTurnIds(input.sourceTurnIds),
    expectedParentId: input.expectedParentId,
    expectedParentRevision: input.expectedParentRevision,
    manualCorrectionRevision: input.manualCorrectionRevision,
    requestedAt: input.requestedAt ?? Date.now(),
  };
}

export function authorizeAnswerSufficiencyAdjudicationLease(
  lease: AnswerSufficiencyAdjudicationLease,
  current: AnswerSufficiencyAdjudicationLeaseSnapshot
) {
  const checks: Array<[boolean, string]> = [
    [
      lease.operationId === current.currentOperationId,
      "current-operation-mismatch",
    ],
    [lease.sessionId === current.sessionId, "session-mismatch"],
    [lease.runtimeEpoch === current.runtimeEpoch, "runtime-epoch-mismatch"],
    [lease.traceId === current.traceId, "trace-mismatch"],
    [lease.questionId === current.questionId, "question-mismatch"],
    [
      lease.logicalQuestionUnitId === current.logicalQuestionUnitId,
      "logical-unit-id-mismatch",
    ],
    [
      lease.logicalQuestionUnitRevision ===
        current.logicalQuestionUnitRevision,
      "logical-unit-revision-mismatch",
    ],
    [lease.answerRevision === current.answerRevision, "answer-revision-mismatch"],
    [
      lease.sourceTurnIdsHash === current.sourceTurnIdsHash,
      "source-turn-hash-mismatch",
    ],
    [lease.expectedParentId === current.activeParentId, "parent-mismatch"],
    [
      lease.expectedParentRevision === current.activeParentRevision,
      "parent-revision-mismatch",
    ],
    [
      lease.manualCorrectionRevision === current.manualCorrectionRevision,
      "manual-correction-revision-mismatch",
    ],
  ];
  const rejection = checks.find(([valid]) => !valid);
  return rejection
    ? { authorized: false as const, reason: rejection[1] }
    : { authorized: true as const };
}

export function hashAnswerSufficiencySourceTurnIds(sourceTurnIds: string[]) {
  return hashSourceTurnIds(sourceTurnIds);
}

const ADJUDICATED_STATUSES: AnswerSufficiencyStatus[] = [
  "sufficient",
  "context-insufficient",
  "legitimate-wait",
  "clarification-needed",
  "unknown",
];
const CONTEXT_DEFECTS: AnswerContextDefect[] = [
  "none",
  "missing-antecedent",
  "fragmented-question",
  "underspecified-action",
  "unresolved-slot",
  "artifact-placeholder",
  "generic-meta-fallback",
  "prior-parent-leakage",
  "recent-correction-contradiction",
];
const REPAIRS: AnswerRepairRecommendation[] = [
  "none",
  "enhance",
  "narrow",
  "buffer",
  "ignore",
  "wait",
  "manual-clarification",
];

function isAdjudicatedStatus(value: unknown): value is LlmAnswerSufficiencyAdjudication["answerStatus"] {
  return (
    typeof value === "string" &&
    ADJUDICATED_STATUSES.includes(value as AnswerSufficiencyStatus)
  );
}

function isContextDefect(value: unknown): value is AnswerContextDefect {
  return (
    typeof value === "string" &&
    CONTEXT_DEFECTS.includes(value as AnswerContextDefect)
  );
}

function isRepairRecommendation(
  value: unknown
): value is AnswerRepairRecommendation {
  return (
    typeof value === "string" &&
    REPAIRS.includes(value as AnswerRepairRecommendation)
  );
}

function hashSourceTurnIds(sourceTurnIds: string[]) {
  let hash = 2_166_136_261;
  for (const character of sourceTurnIds.join("\u001f")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function clip(value: string, maxChars: number) {
  const normalized = normalize(value);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function stripJsonFence(value: string) {
  const trimmed = value.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

function normalize(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}
