import { isExactLowValueAcknowledgement, type AdvisorTurnIntentDecision } from "./advisor-turn-intent.js";
import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import { parseRuntimeJsonObject } from "./runtime-json-object.js";
import {
  RESPONSE_OPPORTUNITY_COMPACT_OUTPUT_WORST_CASE,
  RESPONSE_OPPORTUNITY_MAX_OUTPUT_CHARS,
  RESPONSE_OPPORTUNITY_MAX_OUTPUT_TOKENS,
  RESPONSE_OPPORTUNITY_MAX_CLARIFICATION_CHARS,
  RESPONSE_OPPORTUNITY_MAX_DECISION_SPANS,
  RESPONSE_OPPORTUNITY_MAX_SOURCE_CHARS,
  RESPONSE_OPPORTUNITY_PROMPT_VERSION,
  RESPONSE_OPPORTUNITY_SCHEMA_VERSION,
  buildResponseOpportunityRequest,
  selectResponseOpportunityContextSources,
  createResponseOpportunityContextCapsule,
  hashResponseOpportunityEvidence,
  projectResponseOpportunitySemanticPayload,
  type ResponseOpportunityRequest,
  type ResponseOpportunityContextCapsule,
  type ResponseOpportunitySemanticPayload,
  type ResponseOpportunityDecisionSpan,
} from "./response-opportunity-contract.js";
import type { RuntimeInferenceRuntimeJob } from "./runtime-inference-runtime.js";
import { buildRuntimeInferenceModelInput } from "./runtime-inference.js";
import { calculateWordEquivalent } from "./transcript-fusion.js";

export {
  RESPONSE_OPPORTUNITY_COMPACT_OUTPUT_WORST_CASE,
  RESPONSE_OPPORTUNITY_MAX_OUTPUT_CHARS,
  RESPONSE_OPPORTUNITY_MAX_OUTPUT_TOKENS,
  RESPONSE_OPPORTUNITY_MAX_CLARIFICATION_CHARS,
  RESPONSE_OPPORTUNITY_MAX_DECISION_SPANS,
  RESPONSE_OPPORTUNITY_MAX_SOURCE_CHARS,
  RESPONSE_OPPORTUNITY_PROMPT_VERSION,
  RESPONSE_OPPORTUNITY_SCHEMA_VERSION,
  buildResponseOpportunityRequest,
  selectResponseOpportunityContextSources,
  createResponseOpportunityContextCapsule,
  hashResponseOpportunityEvidence,
  projectResponseOpportunitySemanticPayload,
  type ResponseOpportunityRequest,
  type ResponseOpportunityContextCapsule,
  type ResponseOpportunitySemanticPayload,
  type ResponseOpportunityDecisionSpan,
};
export const RESPONSE_OPPORTUNITY_SESSION_START_LIMIT = 600;
export const RESPONSE_OPPORTUNITY_RELEASE_MIN_CONFIDENCE = 0.85;
export const RESPONSE_OPPORTUNITY_PROPOSAL_TTL_MS = 30_000;

export type ResponseOpportunityDecision =
  | "output-request"
  | "no-output-request"
  | "unclear";

const RESPONSE_OPPORTUNITY_REASON_CODES = new Set([
  "ask",
  "directive",
  "correction",
  "constraint",
  "phase-control",
  "acknowledgement",
  "greeting",
  "closing",
  "logistics",
  "answer-to-candidate",
  "bounded-source-insufficient",
]);
const RESPONSE_OPPORTUNITY_OUTPUT_REASON_CODES = new Set([
  "ask",
  "directive",
  "correction",
  "constraint",
  "phase-control",
]);
const RESPONSE_OPPORTUNITY_NO_OUTPUT_REASON_CODES = new Set([
  "acknowledgement",
  "greeting",
  "closing",
  "logistics",
  "answer-to-candidate",
]);

export type ResponseOpportunityLocalDisposition =
  | "deterministic-no-output"
  | "deterministic-output"
  | "runtime-required";

export type ResponseOpportunityExecutionMode =
  | "authoritative"
  | "speculative-authoritative"
  | "shadow-observation";

export interface ResponseOpportunityLocalDecision {
  disposition: ResponseOpportunityLocalDisposition;
  reason: string;
  wordEquivalent: number;
  decision: ResponseOpportunityDecision;
  runtimeReviewRequired: boolean;
}

export interface LlmResponseOpportunityDecision {
  schemaVersion: 4;
  decision: ResponseOpportunityDecision;
  confidence: number;
  decisionTarget: string;
  targetSpans: ResponseOpportunityDecisionSpan[];
  reason: string;
}

export type ResponseOpportunityParseResult =
  | {
      ok: true;
      value: LlmResponseOpportunityDecision;
      targetSpansValid: true;
    }
  | {
      ok: false;
      reason: string;
      errorKind: "parse" | "schema" | "evidence" | "provider";
      targetSpansValid: boolean;
    };

export interface ResponseOpportunityLease {
  operationId: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  sourceHash: string;
  manualCorrectionRevision: number;
  createdAt: number;
}

export interface ResponseOpportunityJob extends RuntimeInferenceRuntimeJob {
  traceId: string;
  lease: ResponseOpportunityLease;
  request: ResponseOpportunityRequest;
  sourceTurnId: string;
}

export interface ResponseOpportunityProposal {
  operationId: string;
  snapshotId: string;
  logicalQuestionUnitId: string;
  logicalQuestionRevision: number;
  decision: ResponseOpportunityDecision;
  confidence: number;
  decisionTarget: string;
  targetSpans: ResponseOpportunityDecisionSpan[];
  source: "runtime-llm";
  capability: "settlement-proposal";
  disposition: "success";
  createdAt: number;
  expiresAt: number;
}

export interface ResponseOpportunityReleaseDecision {
  released: boolean;
  generationDisposition:
    | "output-authorized"
    | "output-suppressed"
    | "unresolved";
  reason:
    | "high-confidence-output-request"
    | "high-confidence-no-output-request"
    | "output-confidence-below-threshold"
    | "unclear";
}

export interface ResponseOpportunitySessionBudgetDecision {
  authorized: boolean;
  reason: "authorized" | "duplicate-operation" | "session-limit-exhausted";
  startsBefore: number;
  startsAfter: number;
  limit: number;
}

export class ResponseOpportunitySessionBudget {
  private readonly operationKeysBySession = new Map<string, Set<string>>();

  authorize(
    sessionId: string,
    operationKey: string
  ): ResponseOpportunitySessionBudgetDecision {
    const operationKeys =
      this.operationKeysBySession.get(sessionId) ?? new Set<string>();
    const startsBefore = operationKeys.size;
    if (operationKeys.has(operationKey)) {
      return {
        authorized: false,
        reason: "duplicate-operation",
        startsBefore,
        startsAfter: startsBefore,
        limit: RESPONSE_OPPORTUNITY_SESSION_START_LIMIT,
      };
    }
    if (startsBefore >= RESPONSE_OPPORTUNITY_SESSION_START_LIMIT) {
      return {
        authorized: false,
        reason: "session-limit-exhausted",
        startsBefore,
        startsAfter: startsBefore,
        limit: RESPONSE_OPPORTUNITY_SESSION_START_LIMIT,
      };
    }
    operationKeys.add(operationKey);
    this.operationKeysBySession.set(sessionId, operationKeys);
    while (this.operationKeysBySession.size > 4) {
      const oldestSessionId =
        this.operationKeysBySession.keys().next().value;
      if (!oldestSessionId) break;
      this.operationKeysBySession.delete(oldestSessionId);
    }
    return {
      authorized: true,
      reason: "authorized",
      startsBefore,
      startsAfter: operationKeys.size,
      limit: RESPONSE_OPPORTUNITY_SESSION_START_LIMIT,
    };
  }
}

export function decideResponseOpportunityLocalRoute(input: {
  text: string;
  decision: AdvisorTurnIntentDecision;
  pendingConfirmation?: boolean;
}): ResponseOpportunityLocalDecision {
  const wordEquivalent = calculateWordEquivalent(input.text);
  if (
    input.pendingConfirmation &&
    isShortConfirmationResponse(input.text)
  ) {
    return {
      disposition: "deterministic-output",
      reason: "pending-confirmation-response",
      wordEquivalent,
      decision: "output-request",
      runtimeReviewRequired: true,
    };
  }
  if (
    (!input.text.trim() || isExactLowValueAcknowledgement(input.text))
  ) {
    return {
      disposition: "deterministic-no-output",
      reason: input.text.trim() ? "exact-acknowledgement" : "empty-transcript",
      wordEquivalent,
      decision: "no-output-request",
      runtimeReviewRequired: false,
    };
  }
  return {
    disposition: "runtime-required",
    reason: "residual-response-opportunity-ambiguity",
    wordEquivalent,
    decision: "unclear",
    runtimeReviewRequired: true,
  };
}

export function resolveResponseOpportunityExecutionMode(
  decision: ResponseOpportunityLocalDecision
): ResponseOpportunityExecutionMode | undefined {
  if (!decision.runtimeReviewRequired) return undefined;
  return decision.disposition === "runtime-required"
    ? "authoritative"
    : "speculative-authoritative";
}

export function buildResponseOpportunityPrompts(
  request: ResponseOpportunityRequest
) {
  const semanticPayload = projectResponseOpportunitySemanticPayload(request);
  const systemPrompt = [
      "Decide one thing only: whether the interviewer-owned source evidence currently asks the candidate for an output that Jarvis should help produce.",
      "Return one JSON object only. Do not answer the interview content.",
      "Read ALL current decisionSpans together, using boundedContext to interpret them. Decide whether this current input requests an answer, explanation, design, code, revision, constraint response, or phase-control response. Then select evidence supporting that decision. A greeting, acknowledgement or polite ending cannot cancel a substantive request earlier in the SAME current input.",
      "Use no-output-request only when the current input as a whole has no request for candidate output: greeting, acknowledgement, closing, logistics, or information answering the candidate without an ask back. Do not first select a non-request tail and use only that tail to suppress a substantive current request.",
      "Use unclear when the bounded source is incomplete or does not support either conclusion.",
      ...(semanticPayload.pendingClarification
        ? [
            "The pendingClarification summary is read-only context from Jarvis's last stable, output-authorized answer. A short confirmation, constraint, or permission that resolves it is an output-request because Jarvis should continue the existing answer. Do not infer any other task state from the summary.",
          ]
        : []),
      "Do not classify question type, task relation, parent, evidence mode, context scope, playbook phase, or artifact intent.",
      "decisionSpans are mechanically split CURRENT source candidates. boundedContext also contains earlier source context. A current fragment that clearly qualifies the method, scope or requested output of a preceding request can itself be an output-request with reason constraint, directive or correction. Unrelated background or bare acknowledgement is not automatically such a qualifier. A request present only in older context must not trigger a new response when the current input merely acknowledges it.",
      "Select the necessary current spans that best support the overall current decision, including the substantive ask and any necessary qualifier. t is a bounded evidence selection, not an enumeration of every input span. Never select only polite framing when other current spans contain the substantive ask.",
      'Return exactly the fields v,d,c,t,r as one compact valid JSON object, with double-quoted keys and string values. v is the number 4. Format-only examples: {"v":4,"d":"o","c":0.9,"t":[0],"r":"ask"}; {"v":4,"d":"n","c":0.9,"t":[0],"r":"greeting"}; {"v":4,"d":"u","c":0.5,"t":[],"r":"bounded-source-insufficient"}. Select the actual decision and indexes from the input; these examples do not recommend an outcome.',
      "d means o=output-request, n=no-output-request, u=unclear. Always include c as a JSON number from 0 to 1 inclusive.",
      "t contains only unique zero-based indexes into decisionSpans in ascending source order; never copy source text or turn IDs into the output. Select only the necessary current spans. For o or n, select at least one index and at most the number of available decisionSpans. Use an empty array for u when no target is supported.",
      "r must match d: for o use ask, directive, correction, constraint or phase-control; for n use acknowledgement, greeting, closing, logistics or answer-to-candidate; for u use bounded-source-insufficient. r explains why the current response decision applies, not just the surface speech act. A confirmation that actually resolves pendingClarification and requests continuation must use an output-compatible reason, not acknowledgement.",
    ].join(" ");
  return buildRuntimeInferenceModelInput({
    systemPrompt,
    semanticPayload,
  });
}

export function parseResponseOpportunityOutput(
  rawOutput: string,
  request: ResponseOpportunityRequest
): ResponseOpportunityParseResult {
  const parsed = parseRuntimeJsonObject(rawOutput, {
    maxChars: RESPONSE_OPPORTUNITY_MAX_OUTPUT_CHARS,
  });
  if (!parsed.ok) return parseFailure(parsed.reason, parsed.errorKind);
  const candidate = parsed.value;
  const allowedKeys = new Set(["v", "d", "c", "t", "r"]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
    return parseFailure("non-opportunity-field-present", "schema");
  }
  if (candidate.v !== RESPONSE_OPPORTUNITY_SCHEMA_VERSION) {
    return parseFailure("unsupported-schema-version", "schema");
  }
  if (
    candidate.d !== "o" &&
    candidate.d !== "n" &&
    candidate.d !== "u"
  ) {
    return parseFailure("invalid-decision", "schema");
  }
  if (
    typeof candidate.c !== "number" ||
    !Number.isFinite(candidate.c) ||
    candidate.c < 0 ||
    candidate.c > 1
  ) {
    return parseFailure("invalid-confidence", "schema");
  }
  if (
    typeof candidate.r !== "string" ||
    !RESPONSE_OPPORTUNITY_REASON_CODES.has(candidate.r)
  ) {
    return parseFailure("invalid-reason", "schema");
  }
  if (
    !Array.isArray(candidate.t) ||
    candidate.t.length > request.decisionSpans.length ||
    (candidate.d !== "u" && candidate.t.length === 0)
  ) {
    return parseFailure("invalid-decision-target", "schema");
  }
  const targetIndexes = new Set<number>();
  const targetSpans: ResponseOpportunityDecisionSpan[] = [];
  for (const value of candidate.t) {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 0 ||
      value >= request.decisionSpans.length ||
      targetIndexes.has(value)
    ) {
      return parseFailure("invalid-target-index", "evidence");
    }
    targetIndexes.add(value);
  }
  const orderedTargetIndexes = [...targetIndexes].sort(
    (left, right) => left - right
  );
  for (const index of orderedTargetIndexes) {
    targetSpans.push({ ...request.decisionSpans[index] });
  }
  const decision =
    candidate.d === "o"
      ? "output-request"
      : candidate.d === "n"
        ? "no-output-request"
        : "unclear";
  const reasonMatchesDecision =
    (decision === "output-request" &&
      RESPONSE_OPPORTUNITY_OUTPUT_REASON_CODES.has(candidate.r)) ||
    (decision === "no-output-request" &&
      RESPONSE_OPPORTUNITY_NO_OUTPUT_REASON_CODES.has(candidate.r)) ||
    (decision === "unclear" &&
      candidate.r === "bounded-source-insufficient");
  if (!reasonMatchesDecision) {
    return parseFailure("decision-reason-mismatch", "schema");
  }
  const decisionTarget = targetSpans
    .map((span) => span.text.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  if (decision !== "unclear" && !decisionTarget) {
    return parseFailure("empty-decision-target", "evidence");
  }
  return {
    ok: true,
    value: {
      schemaVersion: RESPONSE_OPPORTUNITY_SCHEMA_VERSION,
      decision,
      confidence: candidate.c,
      decisionTarget,
      targetSpans,
      reason: candidate.r,
    },
    targetSpansValid: true,
  };
}

export function createResponseOpportunityLease(input: {
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnit: LogicalQuestionUnit;
  request: ResponseOpportunityRequest;
  manualCorrectionRevision: number;
  createdAt?: number;
}): ResponseOpportunityLease {
  return {
    operationId: [
      "response_opportunity",
      input.sessionId,
      input.runtimeEpoch,
      input.logicalQuestionUnit.id,
      input.logicalQuestionUnit.revision,
      input.request.sourceHash,
      input.manualCorrectionRevision,
    ].join(":"),
    sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    logicalQuestionUnitId: input.logicalQuestionUnit.id,
    logicalQuestionUnitRevision: input.logicalQuestionUnit.revision,
    sourceHash: input.request.sourceHash,
    manualCorrectionRevision: input.manualCorrectionRevision,
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function authorizeResponseOpportunityLease(
  lease: ResponseOpportunityLease,
  current: {
    currentOperationId?: string;
    sessionId: string;
    runtimeEpoch: number;
    logicalQuestionUnit: LogicalQuestionUnit;
    request: ResponseOpportunityRequest;
    manualCorrectionRevision: number;
    logicalUnitClosed: boolean;
  }
): { authorized: true } | { authorized: false; reason: string } {
  const reject = (reason: string) => ({
    authorized: false as const,
    reason,
  });
  if (lease.operationId !== current.currentOperationId) {
    return reject("operation-id-mismatch");
  }
  if (lease.sessionId !== current.sessionId) {
    return reject("session-id-mismatch");
  }
  if (lease.runtimeEpoch !== current.runtimeEpoch) {
    return reject("runtime-epoch-mismatch");
  }
  if (lease.logicalQuestionUnitId !== current.logicalQuestionUnit.id) {
    return reject("logical-question-id-mismatch");
  }
  if (
    lease.logicalQuestionUnitRevision !==
    current.logicalQuestionUnit.revision
  ) {
    return reject("logical-question-revision-mismatch");
  }
  if (lease.sourceHash !== current.request.sourceHash) {
    return reject("source-hash-mismatch");
  }
  if (
    lease.manualCorrectionRevision !== current.manualCorrectionRevision
  ) {
    return reject("manual-correction-revision-mismatch");
  }
  if (current.logicalUnitClosed) {
    return reject("logical-question-closed");
  }
  return { authorized: true };
}

export function createResponseOpportunityProposal(input: {
  operationId: string;
  request: ResponseOpportunityRequest;
  result: LlmResponseOpportunityDecision;
  createdAt?: number;
}): ResponseOpportunityProposal {
  const createdAt = input.createdAt ?? Date.now();
  return {
    operationId: input.operationId,
    snapshotId: [
      input.request.logicalQuestionUnitId,
      input.request.logicalQuestionUnitRevision,
      input.request.sourceHash,
    ].join(":"),
    logicalQuestionUnitId: input.request.logicalQuestionUnitId,
    logicalQuestionRevision:
      input.request.logicalQuestionUnitRevision,
    decision: input.result.decision,
    confidence: input.result.confidence,
    decisionTarget: input.result.decisionTarget,
    targetSpans: input.result.targetSpans.map((span) => ({ ...span })),
    source: "runtime-llm",
    capability: "settlement-proposal",
    disposition: "success",
    createdAt,
    expiresAt: createdAt + RESPONSE_OPPORTUNITY_PROPOSAL_TTL_MS,
  };
}

export function applyResponseOpportunityDecisionTarget(input: {
  logicalQuestionUnit: LogicalQuestionUnit;
  request: ResponseOpportunityRequest;
  result: LlmResponseOpportunityDecision;
}): LogicalQuestionUnit {
  const decisionTarget = input.result.decisionTarget.trim();
  if (!decisionTarget || input.result.decision === "unclear") {
    return input.logicalQuestionUnit;
  }
  return {
    ...input.logicalQuestionUnit,
    responseOpportunityTarget: {
      text: decisionTarget,
      sourceHash: input.request.sourceHash,
      source: "runtime-llm",
      decision: input.result.decision,
      sourceTurnIds: Array.from(
        new Set(input.result.targetSpans.map((span) => span.turnId))
      ),
    },
  };
}

export function decideResponseOpportunityRelease(input: {
  result: LlmResponseOpportunityDecision;
  original: AdvisorTurnIntentDecision;
}): ResponseOpportunityReleaseDecision {
  if (input.result.decision === "unclear") {
    return {
      released: false,
      generationDisposition: "unresolved",
      reason: "unclear",
    };
  }
  if (
    input.result.confidence <
    RESPONSE_OPPORTUNITY_RELEASE_MIN_CONFIDENCE
  ) {
    return {
      released: false,
      generationDisposition: "unresolved",
      reason: "output-confidence-below-threshold",
    };
  }
  if (input.result.decision === "no-output-request") {
    return {
      released: false,
      generationDisposition: "output-suppressed",
      reason: "high-confidence-no-output-request",
    };
  }
  return {
    released: true,
    generationDisposition: "output-authorized",
    reason: "high-confidence-output-request",
  };
}

export function formatResponseOpportunityLocalDecisionForTrace(
  decision: ResponseOpportunityLocalDecision
) {
  const legacyDisposition =
    decision.disposition === "deterministic-no-output"
      ? "deterministic-ignore"
      : decision.disposition === "deterministic-output"
        ? "deterministic-answer"
        : decision.disposition;
  const canonicalFillerSuppressed =
    decision.disposition === "deterministic-no-output" &&
    (decision.reason === "exact-acknowledgement" ||
      decision.reason === "empty-transcript");
  return {
    responseOpportunityLocalDisposition: decision.disposition,
    responseOpportunityLocalReason: decision.reason,
    responseOpportunityLocalDecision: decision.decision,
    responseOpportunityWordEquivalent: decision.wordEquivalent,
    canonicalFillerSuppressed,
    shortHighInformationAllowed:
      decision.disposition === "deterministic-output" &&
      decision.wordEquivalent <= 3,
    residualResponseOpportunityInferenceRequired:
      decision.runtimeReviewRequired,
    responseOpportunityRuntimeReviewRequired:
      decision.runtimeReviewRequired,
    // Compatibility fields remain decode-only until Task 168 removes the
    // historical short-intent vocabulary from stored summaries.
    shortIntentLocalDisposition: legacyDisposition,
    shortIntentLocalReason: decision.reason,
    shortIntentWordEquivalent: decision.wordEquivalent,
    residualShortIntentAdjudicationRequired:
      decision.disposition === "runtime-required",
  };
}

export function formatResponseOpportunityProposalForTrace(
  proposal: ResponseOpportunityProposal | undefined
) {
  return proposal
    ? {
        responseOpportunityProposalOperationId: proposal.operationId,
        responseOpportunityProposalSnapshotId: proposal.snapshotId,
        responseOpportunityProposalDecision: proposal.decision,
        responseOpportunityProposalConfidence: proposal.confidence,
        responseOpportunityProposalDecisionTarget:
          proposal.decisionTarget,
        responseOpportunityProposalTargetSpans:
          proposal.targetSpans,
        responseOpportunityProposalSource: proposal.source,
        responseOpportunityProposalCapability: proposal.capability,
        responseOpportunityProposalDisposition: proposal.disposition,
        responseOpportunityProposalCreatedAt: proposal.createdAt,
        responseOpportunityProposalExpiresAt: proposal.expiresAt,
      }
    : {};
}

function isShortConfirmationResponse(text: string) {
  return /^(?:yes|yeah|yep|no|nope|correct|right|是|对|不是|不对)[.!。！]?$/iu.test(
    text.trim()
  );
}

function parseFailure(
  reason: string,
  errorKind: "parse" | "schema" | "evidence" | "provider"
): ResponseOpportunityParseResult {
  return {
    ok: false,
    reason,
    errorKind,
    targetSpansValid: false,
  };
}
