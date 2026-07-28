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
  CurrentQuestionSettlementProposal,
  ProvisionalCurrentQuestion,
} from "./current-question-settlement.js";
import type { RuntimeInferenceRuntimeJob } from "./runtime-inference-runtime.js";
import type { TaxonomyAdjudicationLease } from "./taxonomy-adjudication.js";
import type { MeetingQuestionTypeAdjudicationMode } from "./types.js";

export const QUESTION_TYPE_ADJUDICATION_SCHEMA_VERSION = 1;
export const QUESTION_TYPE_ADJUDICATION_PROMPT_VERSION =
  "question-type-adjudication-v1";
export const QUESTION_TYPE_ADJUDICATION_MAX_OUTPUT_CHARS = 2_048;

export interface QuestionTypeAdjudicationRequest {
  schemaVersion: 1;
  promptVersion: string;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
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
}): QuestionTypeAdjudicationRequest {
  return {
    schemaVersion: QUESTION_TYPE_ADJUDICATION_SCHEMA_VERSION,
    promptVersion: QUESTION_TYPE_ADJUDICATION_PROMPT_VERSION,
    logicalQuestionUnitId: input.logicalQuestionUnit.id,
    logicalQuestionUnitRevision: input.logicalQuestionUnit.revision,
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
}): QuestionTypeAdjudicationEligibilityDecision {
  const skip = (reason: string) => ({
    eligible: false,
    reason,
    triggerReasons: [] as string[],
  });
  if (input.mode === "off") return skip("question-type-operation-off");
  if (input.speaker !== "them") return skip("speaker-is-not-interviewer");
  if (!input.projection.safe) return skip("unsafe-question-projection");
  if (input.manualCorrectionActive) {
    return skip("manual-correction-authoritative");
  }
  if (input.lexical.certainty === "exact-high") {
    return skip("local-exact-high-authoritative");
  }
  if (estimateWordEquivalents(input.projection.text) < 3) {
    return skip("question-unit-too-short");
  }

  return {
    eligible: true,
    reason: "local-type-abstained",
    triggerReasons: [
      "local-type-abstained",
      input.turnGateAction === "answer-refresh"
        ? "source-owned-answer-opportunity"
        : `turn-gate:${input.turnGateAction || "unknown"}`,
    ],
  };
}

export function buildQuestionTypeAdjudicationPrompts(
  request: QuestionTypeAdjudicationRequest
) {
  return {
    systemPrompt: [
      "Classify only the question type of one bounded interviewer question for Jarvis.",
      "Return one JSON object only. Do not answer the interview question.",
      "Do not decide task relation, parent or child status, response action, playbook phase, evidence mode, or meeting metadata.",
      "Use only question.sourceTurns. Ignore quoted examples and classify the current primary or terminal ask.",
      "Allowed questionType values: behavioral, coding, general-system-design, ai-ml-system-design, project-deep-dive, field-knowledge, unknown.",
      "behavioral asks for a past personal situation or action.",
      "coding asks to implement, write, debug, or analyze code or an algorithm.",
      "general-system-design asks for software, backend, distributed-system, or product architecture.",
      "ai-ml-system-design asks for an end-to-end ML, LLM, RAG, search, ranking, recommendation, training, inference, or evaluation system.",
      "project-deep-dive asks about the candidate's resume, prior work, ownership, implementation, or project decisions.",
      "field-knowledge asks for a factual or conceptual explanation without asking for a full system design.",
      "Use unknown for logistics, compensation, scheduling, filler, incomplete content, or genuine ambiguity.",
      "evidenceSpans must contain one or more exact verbatim substrings from question.sourceTurns.",
      "Schema: {schemaVersion:1,questionType,confidence,evidenceSpans,ambiguityReason?}.",
    ].join(" "),
    userMessage: JSON.stringify({
      schemaVersion: request.schemaVersion,
      promptVersion: request.promptVersion,
      logicalQuestionUnitId: request.logicalQuestionUnitId,
      logicalQuestionUnitRevision:
        request.logicalQuestionUnitRevision,
      question: {
        sourceTurns: request.question.sourceTurns,
        omittedSourceTurnIds:
          request.question.omittedSourceTurnIds,
        projectionReason: request.question.projectionReason,
      },
    }),
  };
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
