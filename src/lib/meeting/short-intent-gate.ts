import type { AdvisorTurnIntentDecision } from "./advisor-turn-intent.js";
import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import {
  RESPONSE_OPPORTUNITY_COMPACT_OUTPUT_WORST_CASE,
  RESPONSE_OPPORTUNITY_MAX_OUTPUT_CHARS,
  RESPONSE_OPPORTUNITY_MAX_OUTPUT_TOKENS,
  RESPONSE_OPPORTUNITY_PROMPT_VERSION,
  RESPONSE_OPPORTUNITY_SCHEMA_VERSION,
} from "./response-opportunity-contract.js";
import type { RuntimeInferenceRuntimeJob } from "./runtime-inference-runtime.js";
import { calculateWordEquivalent } from "./transcript-fusion.js";

export {
  RESPONSE_OPPORTUNITY_COMPACT_OUTPUT_WORST_CASE,
  RESPONSE_OPPORTUNITY_MAX_OUTPUT_CHARS,
  RESPONSE_OPPORTUNITY_MAX_OUTPUT_TOKENS,
  RESPONSE_OPPORTUNITY_PROMPT_VERSION,
  RESPONSE_OPPORTUNITY_SCHEMA_VERSION,
};
export const RESPONSE_OPPORTUNITY_SESSION_START_LIMIT = 120;
export const RESPONSE_OPPORTUNITY_RELEASE_MIN_CONFIDENCE = 0.85;
export const RESPONSE_OPPORTUNITY_MAX_SOURCE_CHARS = 1_800;
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

const RESPONSE_OPPORTUNITY_FALLBACK_ACTION_WORDS = new Set([
  "analyze",
  "analyse",
  "build",
  "calculate",
  "code",
  "compare",
  "create",
  "debug",
  "describe",
  "design",
  "discuss",
  "draw",
  "estimate",
  "explain",
  "find",
  "fix",
  "give",
  "implement",
  "optimize",
  "optimise",
  "provide",
  "refine",
  "show",
  "solve",
  "store",
  "stored",
  "tell",
  "update",
  "walk",
  "write",
]);
const RESPONSE_OPPORTUNITY_FALLBACK_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "can",
  "could",
  "for",
  "how",
  "is",
  "me",
  "of",
  "please",
  "should",
  "that",
  "the",
  "this",
  "to",
  "we",
  "what",
  "where",
  "would",
  "you",
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

export interface ResponseOpportunityFailureFallbackDecision {
  authorized: boolean;
  reason:
    | "explicit-phase-control"
    | "explicit-task-action-with-object"
    | "automatic-authority-not-concrete";
}

export interface ResponseOpportunitySourceSpan {
  turnId: string;
  text: string;
}

export interface ResponseOpportunityRequest {
  schemaVersion: 3;
  promptVersion: string;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  currentTurnId: string;
  sourceHash: string;
  sourceSpans: ResponseOpportunitySourceSpan[];
  manualForceAdvise: boolean;
}

export interface LlmResponseOpportunityDecision {
  schemaVersion: 3;
  decision: ResponseOpportunityDecision;
  confidence: number;
  evidenceSpans: ResponseOpportunitySourceSpan[];
  reason: string;
}

export type ResponseOpportunityParseResult =
  | {
      ok: true;
      value: LlmResponseOpportunityDecision;
      evidenceSpansValid: true;
    }
  | {
      ok: false;
      reason: string;
      errorKind: "parse" | "schema" | "evidence" | "provider";
      evidenceSpansValid: boolean;
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
  evidenceSpans: ResponseOpportunitySourceSpan[];
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
  advisorDecision?: AdvisorTurnIntentDecision;
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
    input.decision.action === "ignore" &&
    (input.decision.reason === "exact-acknowledgement" ||
      input.decision.reason === "empty-transcript")
  ) {
    return {
      disposition: "deterministic-no-output",
      reason: input.decision.reason,
      wordEquivalent,
      decision: "no-output-request",
      runtimeReviewRequired: false,
    };
  }
  if (
    input.decision.action === "answer-refresh" &&
    input.decision.executionAuthorized
  ) {
    return {
      disposition: "deterministic-output",
      reason: input.decision.reason,
      wordEquivalent,
      decision: "output-request",
      runtimeReviewRequired: true,
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

export function decideResponseOpportunityFailureFallback(input: {
  text: string;
  decision: AdvisorTurnIntentDecision;
}): ResponseOpportunityFailureFallbackDecision {
  if (input.decision.phaseControl) {
    return { authorized: true, reason: "explicit-phase-control" };
  }

  const normalized = input.text
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const explicitTaskAction =
    /\b(?:analy[sz]e|build|calculate|code|compare|create|debug|describe|design|discuss|draw|estimate|explain|find|fix|give|implement|optimi[sz]e|provide|refine|show|solve|store|stored|tell|update|walk|write)\b/.test(
      normalized
    );
  const objectTokens = normalized
    .split(" ")
    .filter(Boolean)
    .filter(
      (token) =>
        !RESPONSE_OPPORTUNITY_FALLBACK_STOP_WORDS.has(token) &&
        !RESPONSE_OPPORTUNITY_FALLBACK_ACTION_WORDS.has(token)
    );
  if (
    input.decision.executionAuthorized &&
    explicitTaskAction &&
    objectTokens.length >= 2
  ) {
    return {
      authorized: true,
      reason: "explicit-task-action-with-object",
    };
  }
  return {
    authorized: false,
    reason: "automatic-authority-not-concrete",
  };
}

export function buildResponseOpportunityRequest(input: {
  logicalQuestionUnit: LogicalQuestionUnit;
  manualForceAdvise?: boolean;
}): ResponseOpportunityRequest {
  const selectedSources = input.logicalQuestionUnit.sources.slice(-2);
  let remainingChars = RESPONSE_OPPORTUNITY_MAX_SOURCE_CHARS;
  const sourceSpans: ResponseOpportunitySourceSpan[] = [];
  for (const [index, source] of selectedSources.entries()) {
    if (remainingChars <= 0) break;
    const isCurrent =
      source.turnId === input.logicalQuestionUnit.currentTurnId;
    const laterSourceCount = selectedSources.length - index - 1;
    const reserveForLater = Math.min(
      remainingChars,
      laterSourceCount * 600
    );
    const available = Math.max(1, remainingChars - reserveForLater);
    const text = projectBoundedSourceText(
      source.text,
      Math.min(available, isCurrent ? 1_200 : 600)
    );
    if (!text) continue;
    sourceSpans.push({ turnId: source.turnId, text });
    remainingChars -= text.length;
  }
  const sourceHash = hashResponseOpportunityEvidence(sourceSpans);
  return {
    schemaVersion: RESPONSE_OPPORTUNITY_SCHEMA_VERSION,
    promptVersion: RESPONSE_OPPORTUNITY_PROMPT_VERSION,
    logicalQuestionUnitId: input.logicalQuestionUnit.id,
    logicalQuestionUnitRevision: input.logicalQuestionUnit.revision,
    currentTurnId: input.logicalQuestionUnit.currentTurnId,
    sourceHash,
    sourceSpans,
    manualForceAdvise: input.manualForceAdvise ?? false,
  };
}

export function buildResponseOpportunityPrompts(
  request: ResponseOpportunityRequest
) {
  return {
    systemPrompt: [
      "Decide one thing only: whether the interviewer-owned source evidence currently asks the candidate for an output that Jarvis should help produce.",
      "Return one JSON object only. Do not answer the interview content.",
      "Use output-request for a question, directive, requested explanation, requested design or code, correction that requires a revised answer, constraint on an active answer, or an explicit phase-control instruction.",
      "Use no-output-request for greetings, acknowledgements, closings, logistics, or information supplied in response to the candidate's own question when the interviewer does not ask anything back.",
      "Use unclear when the bounded source is incomplete or does not support either conclusion.",
      "Do not classify question type, task relation, parent, evidence mode, context scope, playbook phase, or artifact intent.",
      "Return only this compact schema: {v:3,d:'o'|'n'|'u',c:number,e:number[],r:string}.",
      "d means o=output-request, n=no-output-request, u=unclear. c is confidence from 0 to 1.",
      "e contains only zero-based indexes into sourceSpans; never copy source text or turn IDs into the output.",
      "r must be exactly one of: ask,directive,correction,constraint,phase-control,acknowledgement,greeting,closing,logistics,answer-to-candidate,bounded-source-insufficient.",
    ].join(" "),
    userMessage: JSON.stringify(request),
  };
}

export function parseResponseOpportunityOutput(
  rawOutput: string,
  request: ResponseOpportunityRequest
): ResponseOpportunityParseResult {
  const trimmed = stripJsonFence(rawOutput.trim());
  if (!trimmed) return parseFailure("empty-output", "parse");
  if (trimmed.length > RESPONSE_OPPORTUNITY_MAX_OUTPUT_CHARS) {
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
  const allowedKeys = new Set(["v", "d", "c", "e", "r"]);
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
    !Array.isArray(candidate.e) ||
    candidate.e.length === 0 ||
    candidate.e.length > request.sourceSpans.length
  ) {
    return parseFailure("invalid-evidence-spans", "schema");
  }
  const evidenceIndexes = new Set<number>();
  const evidenceSpans: ResponseOpportunitySourceSpan[] = [];
  for (const value of candidate.e) {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 0 ||
      value >= request.sourceSpans.length ||
      evidenceIndexes.has(value)
    ) {
      return parseFailure("invalid-evidence-index", "evidence");
    }
    evidenceIndexes.add(value);
    evidenceSpans.push({ ...request.sourceSpans[value] });
  }
  const decision =
    candidate.d === "o"
      ? "output-request"
      : candidate.d === "n"
        ? "no-output-request"
        : "unclear";
  return {
    ok: true,
    value: {
      schemaVersion: RESPONSE_OPPORTUNITY_SCHEMA_VERSION,
      decision,
      confidence: candidate.c,
      evidenceSpans,
      reason: candidate.r,
    },
    evidenceSpansValid: true,
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
    evidenceSpans: input.result.evidenceSpans.map((span) => ({ ...span })),
    source: "runtime-llm",
    capability: "settlement-proposal",
    disposition: "success",
    createdAt,
    expiresAt: createdAt + RESPONSE_OPPORTUNITY_PROPOSAL_TTL_MS,
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
    advisorDecision: {
      ...input.original,
      intent: "direct-question",
      confidence: input.result.confidence,
      evidence: [
        ...input.original.evidence,
        "runtime-response-opportunity",
        ...input.result.evidenceSpans.map(
          (span) =>
            `runtime-evidence:${span.turnId}:${span.text}`
        ),
      ],
      action: "answer-refresh",
      recommendedAction: "answer-refresh",
      reason: "runtime-response-opportunity-output-request",
      contextPromptEligible: true,
      enforcement: "allow",
      wouldSuppress: false,
      executionAuthorized: true,
      authoritySource: "runtime-intent-gate",
    },
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
        responseOpportunityProposalEvidenceSpans:
          proposal.evidenceSpans,
        responseOpportunityProposalSource: proposal.source,
        responseOpportunityProposalCapability: proposal.capability,
        responseOpportunityProposalDisposition: proposal.disposition,
        responseOpportunityProposalCreatedAt: proposal.createdAt,
        responseOpportunityProposalExpiresAt: proposal.expiresAt,
      }
    : {};
}

export function hashResponseOpportunityEvidence(
  sourceSpans: ResponseOpportunitySourceSpan[]
) {
  let hash = 2_166_136_261;
  for (const character of sourceSpans
    .flatMap((span) => [span.turnId, span.text])
    .join("\u001f")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function projectBoundedSourceText(text: string, maxChars: number) {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const marker = "\n...[source omitted]...\n";
  const available = Math.max(2, maxChars - marker.length);
  const headChars = Math.min(300, Math.floor(available / 3));
  const tailChars = available - headChars;
  return `${trimmed.slice(0, headChars)}${marker}${trimmed.slice(-tailChars)}`;
}

function isShortConfirmationResponse(text: string) {
  return /^(?:yes|yeah|yep|no|nope|correct|right|是|对|不是|不对)[.!。！]?$/iu.test(
    text.trim()
  );
}

function stripJsonFence(value: string) {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(value);
  return match?.[1]?.trim() ?? value;
}

function parseFailure(
  reason: string,
  errorKind: "parse" | "schema" | "evidence" | "provider"
): ResponseOpportunityParseResult {
  return {
    ok: false,
    reason,
    errorKind,
    evidenceSpansValid: false,
  };
}
