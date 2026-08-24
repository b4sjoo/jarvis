import type { RuntimeInferenceRuntimeJob } from "./runtime-inference-runtime.js";
import { buildRuntimeInferenceModelInput } from "./runtime-inference.js";

export const ANSWER_RECOVERY_ADJUDICATION_SCHEMA_VERSION = 2;
export const ANSWER_RESOLUTION_PROMPT_VERSION =
  "answer-resolution-adjudication-v1";
export const EVIDENCE_REQUIREMENT_PROMPT_VERSION =
  "visual-evidence-check-v2-question-only";
export const ANSWER_RECOVERY_MAX_OUTPUT_CHARS = 2_048;
export const ANSWER_RECOVERY_MAX_QUESTION_CHARS = 1_200;
export const ANSWER_RECOVERY_MAX_ANSWER_CHARS = 1_800;
export const ANSWER_RECOVERY_MAX_EVIDENCE_SPAN_CHARS = 160;

export type AnswerRecoveryOperationKind =
  | "answer-resolution"
  | "evidence-requirement";

export type AnswerResolutionDecision =
  | "resolved"
  | "unresolved"
  | "unclear";

export type EvidenceRequirementDecision =
  | "visual-sufficient"
  | "visual-missing"
  | "not-visual"
  | "unclear";

interface AnswerRecoveryRequestIdentity {
  schemaVersion: 2;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  answerRevision: number;
  sourceHash: string;
  questionText: string;
}

export interface AnswerResolutionAdjudicationRequest
  extends AnswerRecoveryRequestIdentity {
  promptVersion: typeof ANSWER_RESOLUTION_PROMPT_VERSION;
  operationKind: "answer-resolution";
  answerText: string;
}

export interface VisualEvidenceCheckRequest
  extends AnswerRecoveryRequestIdentity {
  promptVersion: typeof EVIDENCE_REQUIREMENT_PROMPT_VERSION;
  operationKind: "evidence-requirement";
  screenQuestion?: string;
  screenEvidenceSummary?: string;
  codeArtifactSummary?: string;
}

export type AnswerRecoveryAdjudicationRequest =
  | AnswerResolutionAdjudicationRequest
  | VisualEvidenceCheckRequest;

export interface AnswerResolutionSemanticPayload {
  questionText: string;
  answerText: string;
}

export interface VisualEvidenceCheckSemanticPayload {
  questionText: string;
  screenQuestion?: string;
  screenEvidenceSummary?: string;
  codeArtifactSummary?: string;
}

export interface AnswerResolutionAdjudication {
  schemaVersion: 2;
  decision: AnswerResolutionDecision;
  questionEvidenceSpans: string[];
  answerEvidenceSpans: string[];
  ambiguityReason?: string;
}

export interface EvidenceRequirementAdjudication {
  schemaVersion: 2;
  decision: EvidenceRequirementDecision;
  questionEvidenceSpans: string[];
  visualEvidenceSpans: string[];
  ambiguityReason?: string;
}

export type AnswerRecoveryAdjudication =
  | AnswerResolutionAdjudication
  | EvidenceRequirementAdjudication;

export type AnswerRecoveryLedgerTransition =
  | {
      action: "create";
      reason: "definite-visual-recovery";
    }
  | {
      action: "cancel";
      reason: "definite-non-recovery";
    }
  | {
      action: "preserve";
      reason: "revision-not-authorized" | "pair-not-definite";
    };

export type AnswerRecoveryAdjudicationParseResult =
  | {
      ok: true;
      value: AnswerRecoveryAdjudication;
      evidenceSpansValid: true;
    }
  | {
      ok: false;
      reason: string;
      errorKind: "parse" | "schema" | "evidence" | "provider";
      evidenceSpansValid: false;
    };

export interface AnswerRecoveryAdjudicationLease {
  operationId: string;
  operationKind: AnswerRecoveryOperationKind;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  answerRevision: number;
  sourceHash: string;
  manualCorrectionRevision: number;
  createdAt: number;
}

export interface AnswerRecoveryAdjudicationJob
  extends RuntimeInferenceRuntimeJob {
  traceId: string;
  lease: AnswerRecoveryAdjudicationLease;
  request: AnswerRecoveryAdjudicationRequest;
}

export function buildAnswerRecoveryAdjudicationRequest(input: {
  operationKind: "answer-resolution";
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  answerRevision: number;
  questionText: string;
  answerText: string;
}): AnswerRecoveryAdjudicationRequest | undefined {
  const questionText = boundText(
    input.questionText,
    ANSWER_RECOVERY_MAX_QUESTION_CHARS
  );
  const answerText = boundText(
    input.answerText,
    ANSWER_RECOVERY_MAX_ANSWER_CHARS
  );
  if (!questionText || !answerText) return undefined;
  return {
    schemaVersion: ANSWER_RECOVERY_ADJUDICATION_SCHEMA_VERSION,
    promptVersion: ANSWER_RESOLUTION_PROMPT_VERSION,
    operationKind: "answer-resolution",
    logicalQuestionUnitId: input.logicalQuestionUnitId,
    logicalQuestionUnitRevision: input.logicalQuestionUnitRevision,
    answerRevision: input.answerRevision,
    sourceHash: hashAnswerRecoverySource(questionText, answerText),
    questionText,
    answerText,
  };
}

export function buildVisualEvidenceCheckRequest(input: {
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  questionSourceHash: string;
  questionText: string;
  screenQuestion?: string;
  screenEvidenceSummary?: string;
  codeArtifactSummary?: string;
}): VisualEvidenceCheckRequest | undefined {
  const questionText = boundText(
    input.questionText,
    ANSWER_RECOVERY_MAX_QUESTION_CHARS
  );
  const questionSourceHash = input.questionSourceHash.trim();
  if (!questionText || !questionSourceHash) return undefined;
  const screenQuestion = optionalBoundText(input.screenQuestion);
  const screenEvidenceSummary = optionalBoundText(
    input.screenEvidenceSummary
  );
  const codeArtifactSummary = optionalBoundText(input.codeArtifactSummary);
  return {
    schemaVersion: ANSWER_RECOVERY_ADJUDICATION_SCHEMA_VERSION,
    promptVersion: EVIDENCE_REQUIREMENT_PROMPT_VERSION,
    operationKind: "evidence-requirement",
    logicalQuestionUnitId: input.logicalQuestionUnitId,
    logicalQuestionUnitRevision: input.logicalQuestionUnitRevision,
    answerRevision: 0,
    sourceHash: hashAnswerRecoverySource(
      questionSourceHash,
      [questionText, screenQuestion, screenEvidenceSummary, codeArtifactSummary]
        .filter(Boolean)
        .join("\n")
    ),
    questionText,
    screenQuestion,
    screenEvidenceSummary,
    codeArtifactSummary,
  };
}

export function buildAnswerRecoveryAdjudicationPrompts(
  request: AnswerRecoveryAdjudicationRequest
) {
  const shared = [
    "Return one JSON object only. Do not answer or rewrite the interview content.",
    "Every evidence span must be an exact verbatim substring of the matching input field.",
    "For unclear, return empty evidence arrays and one short ambiguityReason. Do not include ambiguityReason for a definite decision.",
    "Use unclear when the bounded evidence does not support a definite decision.",
    "Do not classify question type, task relation, source linkage, parent action, playbook phase, memory, or artifact intent.",
  ];
  if (request.operationKind === "answer-resolution") {
    const semanticPayload: AnswerResolutionSemanticPayload = {
      questionText: request.questionText,
      answerText: request.answerText,
    };
    return buildRuntimeInferenceModelInput({
      systemPrompt: [
          "Decide one thing only: whether answerText resolves the substantive request in questionText.",
          "Use only questionText and answerText.",
          "Use resolved when the requested substance is actually provided.",
          "Use unresolved when the answer explicitly defers the substance, lacks required information, or asks for evidence before it can answer.",
          "A correct admission that evidence is missing is unresolved, not a failed answer.",
          "For a definite decision, return exactly one question evidence span and one answer evidence span, each no longer than 160 characters.",
          "Schema: {schemaVersion:2,decision:'resolved'|'unresolved'|'unclear',questionEvidenceSpans:string[],answerEvidenceSpans:string[],ambiguityReason?:string}.",
          ...shared,
        ].join(" "),
      semanticPayload,
    });
  }
  const semanticPayload: VisualEvidenceCheckSemanticPayload = {
    questionText: request.questionText,
    ...(request.screenQuestion
      ? { screenQuestion: request.screenQuestion }
      : {}),
    ...(request.screenEvidenceSummary
      ? { screenEvidenceSummary: request.screenEvidenceSummary }
      : {}),
    ...(request.codeArtifactSummary
      ? { codeArtifactSummary: request.codeArtifactSummary }
      : {}),
  };
  return buildRuntimeInferenceModelInput({
    systemPrompt: [
      "Decide one thing only: whether questionText requires visible evidence and whether the supplied bounded visual evidence covers it.",
      "Do not inspect, predict, or evaluate any model answer.",
      "Use visual-missing when the question requires code lines, a diagram, screenshot content, a visible error, cursor focus, or UI state and the supplied evidence does not cover it.",
      "Use visual-sufficient only when screenQuestion, screenEvidenceSummary, or codeArtifactSummary directly covers the requested visible evidence.",
      "Use not-visual for conceptual, requirement, business-fact, interviewer-choice, or personal-fact questions that visible evidence would not directly answer.",
      "For visual-sufficient, return one questionEvidenceSpans item and one visualEvidenceSpans item.",
      "For visual-missing or not-visual, return one questionEvidenceSpans item and an empty visualEvidenceSpans array.",
      "Schema: {schemaVersion:2,decision:'visual-sufficient'|'visual-missing'|'not-visual'|'unclear',questionEvidenceSpans:string[],visualEvidenceSpans:string[],ambiguityReason?:string}.",
      ...shared,
    ].join(" "),
    semanticPayload,
  });
}

export function parseAnswerRecoveryAdjudicationOutput(
  rawOutput: string,
  request: AnswerRecoveryAdjudicationRequest
): AnswerRecoveryAdjudicationParseResult {
  const trimmed = stripJsonFence(rawOutput.trim());
  if (!trimmed) return parseFailure("empty-output", "parse");
  if (trimmed.length > ANSWER_RECOVERY_MAX_OUTPUT_CHARS) {
    return parseFailure("output-too-large", "parse");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    return parseFailure("invalid-json", "parse");
  }
  if (!isRecord(decoded)) {
    return parseFailure("output-is-not-object", "schema");
  }
  const evidenceField =
    request.operationKind === "answer-resolution"
      ? "answerEvidenceSpans"
      : "visualEvidenceSpans";
  const allowedKeys = new Set([
    "schemaVersion",
    "decision",
    "questionEvidenceSpans",
    evidenceField,
    "ambiguityReason",
  ]);
  if (Object.keys(decoded).some((key) => !allowedKeys.has(key))) {
    return parseFailure("unexpected-field", "schema");
  }
  if (decoded.schemaVersion !== ANSWER_RECOVERY_ADJUDICATION_SCHEMA_VERSION) {
    return parseFailure("unsupported-schema-version", "schema");
  }
  const decisionValid =
    request.operationKind === "answer-resolution"
      ? decoded.decision === "resolved" ||
        decoded.decision === "unresolved" ||
        decoded.decision === "unclear"
      : decoded.decision === "visual-sufficient" ||
        decoded.decision === "visual-missing" ||
        decoded.decision === "not-visual" ||
        decoded.decision === "unclear";
  if (!decisionValid) return parseFailure("invalid-decision", "schema");
  if (
    !isEvidenceSpanArray(decoded.questionEvidenceSpans) ||
    !isEvidenceSpanArray(decoded[evidenceField])
  ) {
    return parseFailure("invalid-evidence-spans", "schema");
  }
  if (
    decoded.ambiguityReason !== undefined &&
    (typeof decoded.ambiguityReason !== "string" ||
      decoded.ambiguityReason.trim().length > 240)
  ) {
    return parseFailure("invalid-ambiguity-reason", "schema");
  }
  const questionEvidenceSpans = decoded.questionEvidenceSpans.map((span) =>
    span.trim()
  );
  const secondaryEvidenceSpans = decoded[evidenceField].map((span) =>
    span.trim()
  );
  const secondaryCorpus =
    request.operationKind === "answer-resolution"
      ? request.answerText
      : [
          request.screenQuestion,
          request.screenEvidenceSummary,
          request.codeArtifactSummary,
        ]
          .filter(Boolean)
          .join("\n");
  if (
    !allSpansGrounded(questionEvidenceSpans, request.questionText) ||
    !allSpansGrounded(secondaryEvidenceSpans, secondaryCorpus)
  ) {
    return parseFailure("ungrounded-evidence-span", "evidence");
  }
  const secondaryEvidenceRequired =
    request.operationKind === "answer-resolution" ||
    decoded.decision === "visual-sufficient";
  if (
    decoded.decision !== "unclear" &&
    (questionEvidenceSpans.length !== 1 ||
      secondaryEvidenceSpans.length !== (secondaryEvidenceRequired ? 1 : 0))
  ) {
    return parseFailure("definite-decision-requires-evidence", "evidence");
  }
  if (
    decoded.decision === "unclear" &&
    (questionEvidenceSpans.length !== 0 ||
      secondaryEvidenceSpans.length !== 0 ||
      typeof decoded.ambiguityReason !== "string" ||
      !decoded.ambiguityReason.trim())
  ) {
    return parseFailure("unclear-requires-reason-only", "evidence");
  }
  if (
    decoded.decision !== "unclear" &&
    decoded.ambiguityReason !== undefined
  ) {
    return parseFailure("definite-decision-forbids-ambiguity", "schema");
  }
  const ambiguityReason =
    typeof decoded.ambiguityReason === "string"
      ? decoded.ambiguityReason.trim()
      : undefined;
  return request.operationKind === "answer-resolution"
    ? {
        ok: true,
        evidenceSpansValid: true,
        value: {
          schemaVersion: ANSWER_RECOVERY_ADJUDICATION_SCHEMA_VERSION,
          decision: decoded.decision as AnswerResolutionDecision,
          questionEvidenceSpans,
          answerEvidenceSpans: secondaryEvidenceSpans,
          ambiguityReason,
        },
      }
    : {
        ok: true,
        evidenceSpansValid: true,
        value: {
          schemaVersion: ANSWER_RECOVERY_ADJUDICATION_SCHEMA_VERSION,
          decision: decoded.decision as EvidenceRequirementDecision,
          questionEvidenceSpans,
          visualEvidenceSpans: secondaryEvidenceSpans,
          ambiguityReason,
        },
      };
}

export function decideAnswerRecoveryLedgerTransition(input: {
  revisionAuthorized: boolean;
  answerResolution?: AnswerResolutionDecision;
  evidenceRequirement?: EvidenceRequirementDecision;
}): AnswerRecoveryLedgerTransition {
  if (!input.revisionAuthorized) {
    return { action: "preserve", reason: "revision-not-authorized" };
  }
  if (
    !input.answerResolution ||
    !input.evidenceRequirement ||
    input.answerResolution === "unclear" ||
    input.evidenceRequirement === "unclear"
  ) {
    return { action: "preserve", reason: "pair-not-definite" };
  }
  if (
    input.answerResolution === "unresolved" &&
    input.evidenceRequirement === "visual-missing"
  ) {
    return { action: "create", reason: "definite-visual-recovery" };
  }
  return { action: "cancel", reason: "definite-non-recovery" };
}

export function isAnswerRecoveryOutputTruncated(rawOutput: string) {
  const trimmed = rawOutput.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("```") && !trimmed.endsWith("```")) return true;
  return trimmed.startsWith("{") && !trimmed.endsWith("}");
}

export function createAnswerRecoveryAdjudicationLease(input: {
  sessionId: string;
  runtimeEpoch: number;
  request: AnswerRecoveryAdjudicationRequest;
  manualCorrectionRevision: number;
  createdAt?: number;
}): AnswerRecoveryAdjudicationLease {
  return {
    operationId: [
      input.request.operationKind,
      input.sessionId,
      input.runtimeEpoch,
      input.request.logicalQuestionUnitId,
      input.request.logicalQuestionUnitRevision,
      input.request.answerRevision,
      input.request.sourceHash,
      input.manualCorrectionRevision,
    ].join(":"),
    operationKind: input.request.operationKind,
    sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    logicalQuestionUnitId: input.request.logicalQuestionUnitId,
    logicalQuestionUnitRevision: input.request.logicalQuestionUnitRevision,
    answerRevision: input.request.answerRevision,
    sourceHash: input.request.sourceHash,
    manualCorrectionRevision: input.manualCorrectionRevision,
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function authorizeAnswerRecoveryAdjudicationLease(
  lease: AnswerRecoveryAdjudicationLease,
  current: {
    currentOperationId?: string;
    sessionId: string;
    runtimeEpoch: number;
    logicalQuestionUnitId: string;
    logicalQuestionUnitRevision: number;
    answerRevision: number;
    sourceHash: string;
    manualCorrectionRevision: number;
  }
): { authorized: true } | { authorized: false; reason: string } {
  const reject = (reason: string) => ({ authorized: false as const, reason });
  if (lease.operationId !== current.currentOperationId) {
    return reject("operation-id-mismatch");
  }
  if (lease.sessionId !== current.sessionId) return reject("session-mismatch");
  if (lease.runtimeEpoch !== current.runtimeEpoch) {
    return reject("runtime-epoch-mismatch");
  }
  if (lease.logicalQuestionUnitId !== current.logicalQuestionUnitId) {
    return reject("logical-question-mismatch");
  }
  if (
    lease.logicalQuestionUnitRevision !== current.logicalQuestionUnitRevision
  ) {
    return reject("logical-question-revision-mismatch");
  }
  if (lease.answerRevision !== current.answerRevision) {
    return reject("answer-revision-mismatch");
  }
  if (lease.sourceHash !== current.sourceHash) return reject("source-mismatch");
  if (lease.manualCorrectionRevision !== current.manualCorrectionRevision) {
    return reject("manual-correction-revision-mismatch");
  }
  return { authorized: true };
}

export function formatAnswerRecoveryAdjudicationForTrace(input: {
  request: AnswerRecoveryAdjudicationRequest;
  disposition: string;
  candidate?: AnswerRecoveryAdjudication;
  leaseAuthorized?: boolean;
  staleReason?: string;
  durationMs?: number;
  queueWaitMs?: number;
}) {
  const answerEvidenceSpans =
    input.candidate && "answerEvidenceSpans" in input.candidate
      ? input.candidate.answerEvidenceSpans
      : undefined;
  const visualEvidenceSpans =
    input.candidate && "visualEvidenceSpans" in input.candidate
      ? input.candidate.visualEvidenceSpans
      : undefined;
  return {
    answerRecoveryOperationKind: input.request.operationKind,
    answerRecoveryPromptVersion: input.request.promptVersion,
    answerRecoverySchemaVersion: input.request.schemaVersion,
    answerRecoveryLogicalQuestionUnitId:
      input.request.logicalQuestionUnitId,
    answerRecoveryLogicalQuestionRevision:
      input.request.logicalQuestionUnitRevision,
    answerRecoveryAnswerRevision: input.request.answerRevision,
    answerRecoverySourceHash: input.request.sourceHash,
    answerRecoveryDisposition: input.disposition,
    answerRecoveryDecision: input.candidate?.decision,
    answerRecoveryQuestionEvidenceSpans:
      input.candidate?.questionEvidenceSpans,
    answerRecoveryAnswerEvidenceSpans: answerEvidenceSpans,
    answerRecoveryVisualEvidenceSpans: visualEvidenceSpans,
    answerRecoveryAmbiguityReason: input.candidate?.ambiguityReason,
    answerRecoveryLeaseAuthorized: input.leaseAuthorized,
    answerRecoveryStaleReason: input.staleReason,
    answerRecoveryDurationMs: input.durationMs,
    answerRecoveryQueueWaitMs: input.queueWaitMs,
    answerRecoveryAppliedToRuntime: false,
  };
}

function parseFailure(
  reason: string,
  errorKind: "parse" | "schema" | "evidence" | "provider"
): AnswerRecoveryAdjudicationParseResult {
  return { ok: false, reason, errorKind, evidenceSpansValid: false };
}

function stripJsonFence(value: string) {
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isEvidenceSpanArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 1 &&
    value.every(
      (span) =>
        typeof span === "string" &&
        Boolean(span.trim()) &&
        span.trim().length <= ANSWER_RECOVERY_MAX_EVIDENCE_SPAN_CHARS
    )
  );
}

function allSpansGrounded(spans: string[], corpus: string) {
  return spans.every((span) => corpus.includes(span));
}

function boundText(text: string, maxChars: number) {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxChars) return trimmed;
  const marker = " ... ";
  const remaining = Math.max(2, maxChars - marker.length);
  const head = Math.floor(remaining / 2);
  return `${trimmed.slice(0, head)}${marker}${trimmed.slice(
    -(remaining - head)
  )}`;
}

function optionalBoundText(value: string | undefined) {
  const text = boundText(value ?? "", ANSWER_RECOVERY_MAX_ANSWER_CHARS);
  return text || undefined;
}

function hashAnswerRecoverySource(questionText: string, answerText: string) {
  let hash = 2_166_136_261;
  for (const character of `${questionText}\u001f${answerText}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
