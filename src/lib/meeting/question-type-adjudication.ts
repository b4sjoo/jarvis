import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import {
  projectLogicalQuestionForAdjudication,
  type TaxonomyAdjudicationProjection,
} from "./taxonomy-adjudication.js";
import {
  isCanonicalQuestionType,
  type CanonicalQuestionType,
  type QuestionTypeInferenceDecision,
} from "./task-taxonomy.js";
import type {
  CurrentQuestionSettlementDecision,
  CurrentQuestionSettlementProposal,
  ProvisionalCurrentQuestion,
} from "./current-question-settlement.js";
import type { RuntimeInferenceRuntimeJob } from "./runtime-inference-runtime.js";
import { buildRuntimeInferenceModelInput } from "./runtime-inference.js";
import type { RuntimeAxisConflictDecision } from "./runtime-axis-conflict.js";
import type { TaxonomyAdjudicationLease } from "./taxonomy-adjudication.js";
import type { MeetingQuestionTypeAdjudicationMode } from "./types.js";

export const QUESTION_TYPE_ADJUDICATION_SCHEMA_VERSION = 1;
export const QUESTION_TYPE_ADJUDICATION_PROMPT_VERSION =
  "question-type-adjudication-v2";
export const QUESTION_TYPE_ADJUDICATION_MAX_OUTPUT_CHARS = 2_048;
export const QUESTION_TYPE_ENFORCEMENT_MIN_CONFIDENCE = 0.95;
export const QUESTION_TYPE_ENFORCEMENT_WAIT_BUDGET_MS = 1_200;

export interface QuestionTypeAdjudicationRequest {
  schemaVersion: 1;
  promptVersion: string;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  reviewScope?: "full" | "field-vs-coding";
  question: TaxonomyAdjudicationProjection;
}

export interface QuestionTypeAdjudicationJob
  extends RuntimeInferenceRuntimeJob {
  traceId: string;
  lease: TaxonomyAdjudicationLease;
  request: QuestionTypeAdjudicationRequest;
  triggerReasons: string[];
}

export interface LlmQuestionTypeAdjudication {
  schemaVersion: 1;
  questionType: CanonicalQuestionType;
  confidence: number;
  evidenceSpans: string[];
  ambiguityReason?: string;
}

export type QuestionTypeAdjudicationParseResult =
  | {
      ok: true;
      value: LlmQuestionTypeAdjudication;
      evidenceSpansValid: true;
    }
  | {
      ok: false;
      reason: string;
      errorKind: "parse" | "schema" | "evidence" | "provider";
      evidenceSpansValid: boolean;
    };

export interface QuestionTypeAdjudicationEligibilityDecision {
  eligible: boolean;
  reason: string;
  triggerReasons: string[];
  executionMode:
    | "none"
    | "shadow-observation"
    | "enforcement-window";
  wordEquivalent: number;
  sentenceCount: number;
}

export type QuestionTypeEnforcementReason =
  | "authorized"
  | "operation-not-enforcement"
  | "source-not-substantive"
  | "manual-authority-conflict"
  | "operation-lease-not-authorized"
  | "candidate-missing"
  | "candidate-type-unknown"
  | "field-knowledge-requires-narrow-review"
  | "candidate-confidence-below-threshold"
  | "settlement-type-mutation-not-authorized"
  | "advisor-release-window-closed";

export interface QuestionTypeEnforcementDecision {
  authorized: boolean;
  reason: QuestionTypeEnforcementReason;
  localQuestionType: CanonicalQuestionType;
  proposedQuestionType: CanonicalQuestionType;
  confidence: number;
  minimumConfidence: number;
}

export interface QuestionTypeAdjudicationRuntimeOutcome {
  disposition: string;
  enforcement: QuestionTypeEnforcementDecision;
  settlement?: CurrentQuestionSettlementDecision;
  operationId?: string;
}

export const QUESTION_TYPE_ADJUDICATION_OUTCOME_SCHEMA_VERSION = 2;

export type QuestionTypeAdjudicationOutcomeStage =
  | "release"
  | "advisor-start"
  | "model-complete"
  | "delivery";

export type QuestionTypeAdjudicationOutcomeDisposition =
  | "enforcement-denied"
  | "settlement-applied"
  | "advisor-started"
  | "model-completed"
  | "delivery-pending"
  | "visible-committed"
  | "suppressed"
  | "stale-dropped"
  | "cancelled-by-new-job"
  | "cancelled-by-runtime-boundary"
  | "error";

export interface QuestionTypeAdjudicationOutcomeEvent {
  schemaVersion: 1 | typeof QUESTION_TYPE_ADJUDICATION_OUTCOME_SCHEMA_VERSION;
  outcomeId: string;
  operationId: string;
  recordingSessionId?: string;
  runtimeSessionId?: string;
  originTraceId?: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  traceId: string;
  taskId?: string;
  settlementOperationId?: string;
  settlementId?: string;
  outputAuthorityId?: string;
  advisorJobId?: string;
  visibleAnswerRevision?: number;
  proposedQuestionType?: CanonicalQuestionType;
  stage: QuestionTypeAdjudicationOutcomeStage;
  disposition: QuestionTypeAdjudicationOutcomeDisposition;
  enforcementAuthorized: boolean;
  settlementApplied: boolean;
  appliedToResponse?: boolean;
  appliedToSettlement?: boolean;
  appliedToParent?: boolean;
  advisorStarted: boolean;
  modelCompleted: boolean;
  deliveryPending: boolean;
  visibleCommitted: boolean;
  reason?: string;
  recordedAt: number;
}

export function createQuestionTypeAdjudicationOutcomeEvent(input: {
  operationId: string;
  sessionId: string;
  recordingSessionId?: string;
  runtimeSessionId?: string;
  originTraceId?: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  traceId: string;
  taskId?: string;
  settlementOperationId?: string;
  settlementId?: string;
  outputAuthorityId?: string;
  advisorJobId?: string;
  visibleAnswerRevision?: number;
  proposedQuestionType?: CanonicalQuestionType;
  stage: QuestionTypeAdjudicationOutcomeStage;
  disposition: QuestionTypeAdjudicationOutcomeDisposition;
  enforcementAuthorized?: boolean;
  settlementApplied?: boolean;
  appliedToResponse?: boolean;
  appliedToSettlement?: boolean;
  appliedToParent?: boolean;
  advisorStarted?: boolean;
  modelCompleted?: boolean;
  deliveryPending?: boolean;
  visibleCommitted?: boolean;
  reason?: string;
  recordedAt?: number;
}): QuestionTypeAdjudicationOutcomeEvent {
  const recordedAt = input.recordedAt ?? Date.now();
  return {
    schemaVersion: QUESTION_TYPE_ADJUDICATION_OUTCOME_SCHEMA_VERSION,
    outcomeId: `${input.operationId}:${input.stage}:${recordedAt}`,
    operationId: input.operationId,
    recordingSessionId: input.recordingSessionId,
    runtimeSessionId: input.runtimeSessionId ?? input.sessionId,
    originTraceId: input.originTraceId ?? input.traceId,
    sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    logicalQuestionUnitId: input.logicalQuestionUnitId,
    logicalQuestionUnitRevision: input.logicalQuestionUnitRevision,
    traceId: input.traceId,
    taskId: input.taskId,
    settlementOperationId: input.settlementOperationId,
    settlementId: input.settlementId,
    outputAuthorityId: input.outputAuthorityId,
    advisorJobId: input.advisorJobId,
    visibleAnswerRevision: input.visibleAnswerRevision,
    proposedQuestionType: input.proposedQuestionType,
    stage: input.stage,
    disposition: input.disposition,
    enforcementAuthorized: input.enforcementAuthorized ?? false,
    settlementApplied: input.settlementApplied ?? false,
    appliedToResponse: input.appliedToResponse ?? false,
    appliedToSettlement:
      input.appliedToSettlement ?? input.settlementApplied ?? false,
    appliedToParent: input.appliedToParent ?? false,
    advisorStarted: input.advisorStarted ?? false,
    modelCompleted: input.modelCompleted ?? false,
    deliveryPending: input.deliveryPending ?? false,
    visibleCommitted: input.visibleCommitted ?? false,
    reason: input.reason,
    recordedAt,
  };
}

export function formatQuestionTypeAdjudicationOutcomeForTrace(
  outcome: QuestionTypeAdjudicationOutcomeEvent
) {
  return {
    questionTypeAdjudicationOutcomeId: outcome.outcomeId,
    questionTypeAdjudicationOutcomeOperationId: outcome.operationId,
    questionTypeAdjudicationOutcomeRuntimeSessionId:
      outcome.runtimeSessionId,
    questionTypeAdjudicationOutcomeOriginTraceId: outcome.originTraceId,
    questionTypeAdjudicationOutcomeStage: outcome.stage,
    questionTypeAdjudicationOutcomeDisposition: outcome.disposition,
    questionTypeAdjudicationOutcomeRecordedAt: outcome.recordedAt,
    questionTypeAdjudicationOutcomeSettlementId: outcome.settlementId,
    questionTypeAdjudicationOutcomeSettlementOperationId:
      outcome.settlementOperationId,
    questionTypeAdjudicationOutcomeAuthorityId: outcome.outputAuthorityId,
    questionTypeAdjudicationOutcomeAdvisorJobId: outcome.advisorJobId,
    questionTypeAdjudicationOutcomeVisibleAnswerRevision:
      outcome.visibleAnswerRevision,
    questionTypeAdjudicationOutcomeEnforcementAuthorized:
      outcome.enforcementAuthorized,
    questionTypeAdjudicationOutcomeSettlementApplied:
      outcome.settlementApplied,
    questionTypeAdjudicationOutcomeAppliedToResponse:
      outcome.appliedToResponse,
    questionTypeAdjudicationOutcomeAppliedToSettlement:
      outcome.appliedToSettlement,
    questionTypeAdjudicationOutcomeAppliedToParent:
      outcome.appliedToParent,
    questionTypeAdjudicationOutcomeAdvisorStarted:
      outcome.advisorStarted,
    questionTypeAdjudicationOutcomeModelCompleted:
      outcome.modelCompleted,
    questionTypeAdjudicationOutcomeDeliveryPending:
      outcome.deliveryPending,
    questionTypeAdjudicationOutcomeVisibleCommitted:
      outcome.visibleCommitted,
    questionTypeAdjudicationOutcomeReason: outcome.reason,
  };
}

export function normalizeQuestionTypeAdjudicationMode(
  value: unknown,
  legacyEnabled = true
): MeetingQuestionTypeAdjudicationMode {
  if (
    value === "off" ||
    value === "shadow" ||
    value === "enforcement"
  ) {
    return value;
  }
  return legacyEnabled ? "shadow" : "off";
}

export function buildQuestionTypeAdjudicationRequest(input: {
  logicalQuestionUnit: LogicalQuestionUnit;
  reviewScope?: QuestionTypeAdjudicationRequest["reviewScope"];
}): QuestionTypeAdjudicationRequest {
  return {
    schemaVersion: QUESTION_TYPE_ADJUDICATION_SCHEMA_VERSION,
    promptVersion: QUESTION_TYPE_ADJUDICATION_PROMPT_VERSION,
    logicalQuestionUnitId: input.logicalQuestionUnit.id,
    logicalQuestionUnitRevision: input.logicalQuestionUnit.revision,
    reviewScope: input.reviewScope ?? "full",
    question: projectLogicalQuestionForAdjudication(
      input.logicalQuestionUnit
    ),
  };
}

export function decideQuestionTypeAdjudicationEligibility(input: {
  mode: MeetingQuestionTypeAdjudicationMode;
  speaker: "me" | "them" | "unknown";
  projection: TaxonomyAdjudicationProjection;
  lexical: QuestionTypeInferenceDecision;
  manualCorrectionActive: boolean;
  turnGateAction: string;
  sameAxisConflict?: RuntimeAxisConflictDecision<CanonicalQuestionType>;
  mandatoryFieldKnowledgeReview?: boolean;
}): QuestionTypeAdjudicationEligibilityDecision {
  const wordEquivalent = estimateWordEquivalents(
    input.projection.text
  );
  const sentenceCount = countQuestionSentences(
    input.projection
  );
  const skip = (reason: string) => ({
    eligible: false,
    reason,
    triggerReasons: [] as string[],
    executionMode: "none" as const,
    wordEquivalent,
    sentenceCount,
  });
  if (input.mode === "off" && !input.mandatoryFieldKnowledgeReview) {
    return skip("question-type-operation-off");
  }
  if (input.speaker !== "them") return skip("speaker-is-not-interviewer");
  if (!input.projection.safe) return skip("unsafe-question-projection");
  if (wordEquivalent < 3) {
    return skip("question-unit-too-short");
  }

  const shadowObservation = (
    reason: string,
    triggerReasons: string[]
  ): QuestionTypeAdjudicationEligibilityDecision => ({
    eligible: true,
    reason,
    triggerReasons,
    executionMode: "shadow-observation",
    wordEquivalent,
    sentenceCount,
  });
  if (input.manualCorrectionActive) {
    return shadowObservation(
      "manual-correction-shadow-observation",
      ["manual-type-authority-present"]
    );
  }
  if (input.turnGateAction !== "answer-refresh") {
    return shadowObservation("non-answer-turn-shadow-observation", [
      `turn-gate:${input.turnGateAction || "unknown"}`,
    ]);
  }
  if (input.mandatoryFieldKnowledgeReview) {
    return {
      eligible: true,
      reason: "field-knowledge-review-required",
      triggerReasons: ["automatic-field-knowledge-proposal"],
      executionMode: "enforcement-window",
      wordEquivalent,
      sentenceCount,
    };
  }
  if (input.mode === "shadow") {
    return shadowObservation("operation-shadow-observation", [
      input.lexical.type && input.lexical.type !== "unknown"
        ? "local-type-concrete"
        : "local-type-abstained",
    ]);
  }

  const simpleHighConfidenceLocal = Boolean(
    input.lexical.type &&
      input.lexical.type !== "unknown" &&
      input.lexical.confidence >=
        QUESTION_TYPE_ENFORCEMENT_MIN_CONFIDENCE &&
      wordEquivalent < 24 &&
      sentenceCount <= 1 &&
      input.projection.projectionReason === "within-limit" &&
      input.projection.omittedSourceTurnIds.length === 0 &&
      !input.sameAxisConflict?.conflict
  );
  if (simpleHighConfidenceLocal) {
    return shadowObservation(
      "high-confidence-simple-local-shadow",
      ["local-confidence-at-least-enforcement-threshold"]
    );
  }

  const triggerReasons = [
    !input.lexical.type || input.lexical.type === "unknown"
      ? "local-type-abstained"
      : input.lexical.confidence <
          QUESTION_TYPE_ENFORCEMENT_MIN_CONFIDENCE
        ? "local-confidence-below-enforcement-threshold"
        : undefined,
    wordEquivalent >= 24 ? "long-question-unit" : undefined,
    sentenceCount >= 2 ? "multi-sentence-question-unit" : undefined,
    input.projection.projectionReason !== "within-limit" ||
    input.projection.omittedSourceTurnIds.length > 0
      ? "bounded-question-projection"
      : undefined,
    input.sameAxisConflict?.conflict
      ? "same-axis-proposal-conflict"
      : undefined,
    input.turnGateAction === "answer-refresh"
      ? "source-owned-answer-opportunity"
      : `turn-gate:${input.turnGateAction || "unknown"}`,
  ].filter((reason): reason is string => Boolean(reason));

  return {
    eligible: true,
    reason: "enforcement-review-required",
    triggerReasons,
    executionMode: "enforcement-window",
    wordEquivalent,
    sentenceCount,
  };
}

export function buildQuestionTypeAdjudicationPrompts(
  request: QuestionTypeAdjudicationRequest
) {
  const semanticPayload = {
    question: {
      sourceTexts: request.question.sourceTurns.map((source) => source.text),
    },
  };
  const systemPrompt = request.reviewScope === "field-vs-coding"
    ? [
        "Review one automatic Field Knowledge proposal for Jarvis.",
        "Return one JSON object only. Do not answer the interview question.",
        "Classify only whether the current request asks the candidate to solve, implement, debug, trace, or analyze code or an algorithm, versus explain an independently answerable technical concept.",
        "Allowed questionType values: coding, field-knowledge, unknown.",
        "Use coding for implementation, debugging, algorithm derivation, complexity-driven solution work, or requests whose expected deliverable is code or pseudocode.",
        "Use field-knowledge only for a factual or conceptual explanation that does not require producing or repairing a solution.",
        "Use unknown when the bounded evidence cannot distinguish the two.",
        "Do not decide task relation, parent or child status, response action, playbook phase, evidence mode, or meeting metadata.",
        "evidenceSpans must contain one or more exact verbatim substrings from question.sourceTexts.",
        "Schema: {schemaVersion:1,questionType,confidence,evidenceSpans,ambiguityReason?}.",
      ].join(" ")
    : [
      "Classify only the question type of one bounded interviewer question for Jarvis.",
      "Return one JSON object only. Do not answer the interview question.",
      "Do not decide task relation, parent or child status, response action, playbook phase, evidence mode, or meeting metadata.",
      "Use only question.sourceTexts. Ignore quoted examples and classify the current primary or terminal ask.",
      "Allowed questionType values: behavioral, coding, general-system-design, ai-ml-system-design, project-deep-dive, field-knowledge, unknown.",
      "behavioral asks for a past personal situation or action.",
      "coding asks to implement, write, debug, or analyze code or an algorithm.",
      "general-system-design asks for software, backend, distributed-system, or product architecture.",
      "ai-ml-system-design asks for an end-to-end ML, LLM, RAG, search, ranking, recommendation, training, inference, or evaluation system.",
      "project-deep-dive asks about the candidate's resume, prior work, ownership, implementation, or project decisions.",
      "A question about why a named candidate project made a concrete implementation choice, or how that project handled failures, depends on actual project facts and is project-deep-dive even when it mentions a technical concept.",
      "field-knowledge asks for a factual or conceptual explanation that can be answered independently of what the candidate actually implemented in a project.",
      "Use unknown for logistics, compensation, scheduling, filler, incomplete content, or genuine ambiguity.",
      "evidenceSpans must contain one or more exact verbatim substrings from question.sourceTexts.",
      "Schema: {schemaVersion:1,questionType,confidence,evidenceSpans,ambiguityReason?}.",
      ].join(" ");
  return buildRuntimeInferenceModelInput({ systemPrompt, semanticPayload });
}

export function parseQuestionTypeAdjudicationOutput(
  rawOutput: string,
  request: QuestionTypeAdjudicationRequest
): QuestionTypeAdjudicationParseResult {
  const trimmed = stripJsonFence(rawOutput.trim());
  if (!trimmed) return parseFailure("empty-output", "parse");
  if (trimmed.length > QUESTION_TYPE_ADJUDICATION_MAX_OUTPUT_CHARS) {
    return parseFailure("output-too-large", "parse");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    return parseFailure("invalid-json", "parse");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return parseFailure("output-is-not-object", "schema");
  }
  const candidate = decoded as Record<string, unknown>;
  const allowedKeys = new Set([
    "schemaVersion",
    "questionType",
    "confidence",
    "evidenceSpans",
    "ambiguityReason",
  ]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
    return parseFailure("non-type-field-present", "schema");
  }
  if (
    candidate.schemaVersion !==
    QUESTION_TYPE_ADJUDICATION_SCHEMA_VERSION
  ) {
    return parseFailure("unsupported-schema-version", "schema");
  }
  if (!isCanonicalQuestionType(candidate.questionType)) {
    return parseFailure("invalid-question-type", "schema");
  }
  if (
    request.reviewScope === "field-vs-coding" &&
    candidate.questionType !== "coding" &&
    candidate.questionType !== "field-knowledge" &&
    candidate.questionType !== "unknown"
  ) {
    return parseFailure("question-type-outside-review-scope", "schema");
  }
  if (
    typeof candidate.confidence !== "number" ||
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1
  ) {
    return parseFailure("invalid-confidence", "schema");
  }
  if (
    !Array.isArray(candidate.evidenceSpans) ||
    candidate.evidenceSpans.length === 0 ||
    candidate.evidenceSpans.length > 8 ||
    candidate.evidenceSpans.some(
      (span) => typeof span !== "string" || !span.trim()
    )
  ) {
    return parseFailure("invalid-evidence-spans", "schema");
  }
  if (
    candidate.ambiguityReason !== undefined &&
    typeof candidate.ambiguityReason !== "string"
  ) {
    return parseFailure("invalid-ambiguity-reason", "schema");
  }

  const allowedEvidence = request.question.sourceTurns
    .map((source) => source.text)
    .join("\n")
    .toLocaleLowerCase();
  const evidenceSpans = (candidate.evidenceSpans as string[]).map(
    (span) => span.trim()
  );
  const evidenceSpansValid = evidenceSpans.every((span) =>
    allowedEvidence.includes(span.toLocaleLowerCase())
  );
  if (!evidenceSpansValid) {
    return parseFailure("invalid-evidence-span", "evidence");
  }

  return {
    ok: true,
    evidenceSpansValid: true,
    value: {
      schemaVersion: QUESTION_TYPE_ADJUDICATION_SCHEMA_VERSION,
      questionType: candidate.questionType,
      confidence: candidate.confidence,
      evidenceSpans,
      ambiguityReason: candidate.ambiguityReason as
        | string
        | undefined,
    },
  };
}

export function createQuestionTypeSettlementProposal(input: {
  currentQuestion: ProvisionalCurrentQuestion;
  adjudication: LlmQuestionTypeAdjudication;
  expectedParentId?: string;
  expectedParentRevision?: number;
}): CurrentQuestionSettlementProposal {
  return {
    source: "llm-type-repair",
    sessionId: input.currentQuestion.sessionId,
    runtimeEpoch: input.currentQuestion.runtimeEpoch,
    logicalQuestionUnitId:
      input.currentQuestion.logicalQuestionUnitId,
    revision: input.currentQuestion.revision,
    sourceHash: input.currentQuestion.sourceHash,
    questionType: input.adjudication.questionType,
    relation: "unknown",
    confidence: input.adjudication.confidence,
    typeEvidenceAuthorized: true,
    relationEvidenceAuthorized: false,
    actionEvidenceAuthorized: false,
    expectedParentId: input.expectedParentId,
    expectedParentRevision: input.expectedParentRevision,
    reasons: [
      "question-type-runtime-operation",
      "relation-authority-withheld",
      "parent-mutation-withheld",
    ],
  };
}

export function decideQuestionTypeEnforcement(input: {
  mode: MeetingQuestionTypeAdjudicationMode;
  localQuestionType?: unknown;
  candidate?: LlmQuestionTypeAdjudication;
  settlement?: CurrentQuestionSettlementDecision;
  sourceOwnedSubstantive: boolean;
  manualAuthorityConflict: boolean;
  operationLeaseAuthorized: boolean;
  advisorReleaseWindowOpen: boolean;
  reviewScope?: QuestionTypeAdjudicationRequest["reviewScope"];
  minimumConfidence?: number;
}): QuestionTypeEnforcementDecision {
  const localQuestionType =
    normalizeQuestionType(input.localQuestionType);
  const proposedQuestionType = normalizeQuestionType(
    input.candidate?.questionType
  );
  const confidence = clampConfidence(input.candidate?.confidence);
  const minimumConfidence = clampConfidence(
    input.minimumConfidence ?? QUESTION_TYPE_ENFORCEMENT_MIN_CONFIDENCE
  );
  const reject = (
    reason: Exclude<QuestionTypeEnforcementReason, "authorized">
  ): QuestionTypeEnforcementDecision => ({
    authorized: false,
    reason,
    localQuestionType,
    proposedQuestionType,
    confidence,
    minimumConfidence,
  });

  if (input.mode !== "enforcement") {
    return reject("operation-not-enforcement");
  }
  if (!input.sourceOwnedSubstantive) {
    return reject("source-not-substantive");
  }
  if (input.manualAuthorityConflict) {
    return reject("manual-authority-conflict");
  }
  if (!input.operationLeaseAuthorized) {
    return reject("operation-lease-not-authorized");
  }
  if (!input.candidate) return reject("candidate-missing");
  if (proposedQuestionType === "unknown") {
    return reject("candidate-type-unknown");
  }
  if (
    proposedQuestionType === "field-knowledge" &&
    input.reviewScope !== "field-vs-coding"
  ) {
    return reject("field-knowledge-requires-narrow-review");
  }
  if (confidence < minimumConfidence) {
    return reject("candidate-confidence-below-threshold");
  }
  if (!input.settlement?.typeMutationAuthorized) {
    return reject("settlement-type-mutation-not-authorized");
  }
  if (!input.advisorReleaseWindowOpen) {
    return reject("advisor-release-window-closed");
  }

  return {
    authorized: true,
    reason: "authorized",
    localQuestionType,
    proposedQuestionType,
    confidence,
    minimumConfidence,
  };
}

export function formatQuestionTypeEnforcementForTrace(
  decision: QuestionTypeEnforcementDecision | undefined
) {
  return {
    questionTypeAdjudicationEnforcementAuthorized:
      decision?.authorized ?? false,
    questionTypeAdjudicationEnforcementReason: decision?.reason,
    questionTypeAdjudicationEnforcementLocalType:
      decision?.localQuestionType,
    questionTypeAdjudicationEnforcementProposedType:
      decision?.proposedQuestionType,
    questionTypeAdjudicationEnforcementConfidence:
      decision?.confidence,
    questionTypeAdjudicationEnforcementMinimumConfidence:
      decision?.minimumConfidence,
  };
}

export function formatQuestionTypeAdjudicationForTrace(input: {
  mode: MeetingQuestionTypeAdjudicationMode;
  eligibility?: QuestionTypeAdjudicationEligibilityDecision;
  request?: QuestionTypeAdjudicationRequest;
  disposition?: string;
  candidate?: LlmQuestionTypeAdjudication;
}) {
  return {
    questionTypeAdjudicationMode: input.mode,
    questionTypeAdjudicationEligible:
      input.eligibility?.eligible,
    questionTypeAdjudicationEligibilityReason:
      input.eligibility?.reason,
    questionTypeAdjudicationTriggerReasons:
      input.eligibility?.triggerReasons,
    questionTypeAdjudicationExecutionMode:
      input.eligibility?.executionMode,
    questionTypeAdjudicationWordEquivalent:
      input.eligibility?.wordEquivalent,
    questionTypeAdjudicationSentenceCount:
      input.eligibility?.sentenceCount,
    questionTypeAdjudicationUnitId:
      input.request?.logicalQuestionUnitId,
    questionTypeAdjudicationUnitRevision:
      input.request?.logicalQuestionUnitRevision,
    questionTypeAdjudicationInputChars:
      input.request?.question.projectedChars,
    questionTypeAdjudicationOriginalChars:
      input.request?.question.originalChars,
    questionTypeAdjudicationProjectionReason:
      input.request?.question.projectionReason,
    questionTypeAdjudicationDisposition: input.disposition,
    questionTypeAdjudicationCandidateType:
      input.candidate?.questionType,
    questionTypeAdjudicationConfidence:
      input.candidate?.confidence,
    questionTypeAdjudicationEvidenceSpans:
      input.candidate?.evidenceSpans,
    questionTypeAdjudicationAmbiguityReason:
      input.candidate?.ambiguityReason,
    questionTypeAdjudicationRelationMutationBlocked: true,
    questionTypeAdjudicationParentMutationBlocked: true,
  };
}

function parseFailure(
  reason: string,
  errorKind: "parse" | "schema" | "evidence" | "provider"
): QuestionTypeAdjudicationParseResult {
  return {
    ok: false,
    reason,
    errorKind,
    evidenceSpansValid: false,
  };
}

function stripJsonFence(value: string) {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(value);
  return match?.[1]?.trim() ?? value;
}

function estimateWordEquivalents(value: string) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const cjkCharacters =
    normalized.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
    )?.length ?? 0;
  const words = normalized
    .replace(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
      " "
    )
    .split(/\s+/u)
    .filter(Boolean).length;
  return words + Math.ceil(cjkCharacters / 2);
}

function countQuestionSentences(
  projection: TaxonomyAdjudicationProjection
) {
  return projection.sourceTurns.reduce((count, source) => {
    const sentenceCount = source.text
      .split(/[.!?。！？]+/u)
      .map((sentence) => sentence.trim())
      .filter(Boolean).length;
    return count + Math.max(1, sentenceCount);
  }, 0);
}

function normalizeQuestionType(value: unknown): CanonicalQuestionType {
  return isCanonicalQuestionType(value) ? value : "unknown";
}

function clampConfidence(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
}
