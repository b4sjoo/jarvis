import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import type { RuntimeInferenceRuntimeJob } from "./runtime-inference-runtime.js";
import type { TaxonomyAdjudicationLease } from "./taxonomy-adjudication.js";
import { calculateWordEquivalent } from "./transcript-fusion.js";
import type { ActiveMeetingTask } from "./active-meeting-task.js";
import type { TranscriptTurn } from "./types.js";
import type {
  AdvisorTurnIntentDecision,
} from "./advisor-turn-intent.js";

export const SHORT_INTENT_GATE_SCHEMA_VERSION = 1;
export const SHORT_INTENT_GATE_PROMPT_VERSION = "short-intent-gate-v1";
export const SHORT_INTENT_GATE_MAX_OUTPUT_CHARS = 1_024;
export const SHORT_INTENT_GATE_MAX_CONTEXT_TURNS = 2;
export const SHORT_INTENT_GATE_SESSION_START_LIMIT = 120;

export type ShortIntentGateAction =
  | "ignore"
  | "append-context"
  | "answer";

export type ShortIntentLocalDisposition =
  | "not-short"
  | "deterministic-ignore"
  | "deterministic-append"
  | "deterministic-answer"
  | "runtime-required";

export interface ShortIntentLocalDecision {
  disposition: ShortIntentLocalDisposition;
  reason: string;
  wordEquivalent: number;
  highInformation: boolean;
}

export interface ShortIntentGateRequest {
  schemaVersion: 1;
  promptVersion: string;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  currentTurn: {
    turnId: string;
    text: string;
  };
  contextTurns: Array<{
    turnId: string;
    speaker: TranscriptTurn["speaker"];
    text: string;
  }>;
  pendingConfirmation: boolean;
  activeTask?: {
    questionType: string;
    topic: string;
  };
}

export interface LlmShortIntentGateDecision {
  schemaVersion: 1;
  action: ShortIntentGateAction;
  confidence: number;
  evidenceSpans: string[];
}

export type ShortIntentGateParseResult =
  | {
      ok: true;
      value: LlmShortIntentGateDecision;
      evidenceSpansValid: true;
    }
  | {
      ok: false;
      reason: string;
      errorKind: "parse" | "schema" | "evidence" | "provider";
      evidenceSpansValid: boolean;
    };

export interface ShortIntentGateJob extends RuntimeInferenceRuntimeJob {
  traceId: string;
  lease: TaxonomyAdjudicationLease;
  request: ShortIntentGateRequest;
  sourceTurnId: string;
  sourceTextHash: string;
}

export interface ShortIntentGateSessionBudgetDecision {
  authorized: boolean;
  reason: "authorized" | "duplicate-operation" | "session-limit-exhausted";
  startsBefore: number;
  startsAfter: number;
  limit: number;
}

export class ShortIntentGateSessionBudget {
  private readonly operationKeysBySession = new Map<string, Set<string>>();

  authorize(
    sessionId: string,
    operationKey: string
  ): ShortIntentGateSessionBudgetDecision {
    const operationKeys =
      this.operationKeysBySession.get(sessionId) ?? new Set<string>();
    const startsBefore = operationKeys.size;
    if (operationKeys.has(operationKey)) {
      return {
        authorized: false,
        reason: "duplicate-operation",
        startsBefore,
        startsAfter: startsBefore,
        limit: SHORT_INTENT_GATE_SESSION_START_LIMIT,
      };
    }
    if (startsBefore >= SHORT_INTENT_GATE_SESSION_START_LIMIT) {
      return {
        authorized: false,
        reason: "session-limit-exhausted",
        startsBefore,
        startsAfter: startsBefore,
        limit: SHORT_INTENT_GATE_SESSION_START_LIMIT,
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
      limit: SHORT_INTENT_GATE_SESSION_START_LIMIT,
    };
  }
}

export function decideShortIntentLocalRoute(input: {
  text: string;
  decision: AdvisorTurnIntentDecision;
  pendingConfirmation?: boolean;
}): ShortIntentLocalDecision {
  const wordEquivalent = calculateWordEquivalent(input.text);
  if (
    input.pendingConfirmation &&
    isShortConfirmationResponse(input.text)
  ) {
    return {
      disposition: "deterministic-answer",
      reason: "pending-confirmation-response",
      wordEquivalent,
      highInformation: true,
    };
  }
  if (input.decision.action === "ignore") {
    return {
      disposition: "deterministic-ignore",
      reason: input.decision.reason,
      wordEquivalent,
      highInformation: false,
    };
  }
  if (wordEquivalent >= 3) {
    return {
      disposition: "not-short",
      reason: "three-or-more-word-equivalents",
      wordEquivalent,
      highInformation: false,
    };
  }
  if (
    input.decision.action === "append-only" ||
    input.decision.action === "state-update"
  ) {
    return {
      disposition: "deterministic-append",
      reason: input.decision.reason,
      wordEquivalent,
      highInformation: false,
    };
  }
  if (
    input.decision.enforcement === "allow" ||
    isHighInformationShortTurn(input.text)
  ) {
    return {
      disposition: "deterministic-answer",
      reason:
        input.decision.enforcement === "allow"
          ? input.decision.reason
          : "high-information-short-turn",
      wordEquivalent,
      highInformation: true,
    };
  }
  return {
    disposition: "runtime-required",
    reason: "residual-short-intent-ambiguity",
    wordEquivalent,
    highInformation: false,
  };
}

export function buildShortIntentGateRequest(input: {
  logicalQuestionUnit: LogicalQuestionUnit;
  currentTurn: TranscriptTurn;
  previousTurns: TranscriptTurn[];
  pendingConfirmation: boolean;
  activeMeetingTask?: ActiveMeetingTask;
}): ShortIntentGateRequest {
  return {
    schemaVersion: SHORT_INTENT_GATE_SCHEMA_VERSION,
    promptVersion: SHORT_INTENT_GATE_PROMPT_VERSION,
    logicalQuestionUnitId: input.logicalQuestionUnit.id,
    logicalQuestionUnitRevision: input.logicalQuestionUnit.revision,
    currentTurn: {
      turnId: input.currentTurn.id,
      text: input.currentTurn.text.trim(),
    },
    contextTurns: input.previousTurns
      .filter(
        (turn) =>
          turn.id !== input.currentTurn.id &&
          Boolean(turn.text.trim())
      )
      .slice(-SHORT_INTENT_GATE_MAX_CONTEXT_TURNS)
      .map((turn) => ({
        turnId: turn.id,
        speaker: turn.speaker,
        text: turn.text.trim().slice(0, 500),
      })),
    pendingConfirmation: input.pendingConfirmation,
    activeTask: input.activeMeetingTask
      ? {
          questionType: input.activeMeetingTask.parent.questionType,
          topic: input.activeMeetingTask.parent.topic.slice(0, 300),
        }
      : undefined,
  };
}

export function buildShortIntentGatePrompts(
  request: ShortIntentGateRequest
) {
  return {
    systemPrompt: [
      "Classify only whether one short interviewer turn should create new Jarvis answer work.",
      "Return one JSON object only. Do not answer the interview question.",
      "Use contextTurns and activeTask only to resolve references; currentTurn alone owns the action.",
      "Allowed action values are ignore, append-context, and answer.",
      "Use ignore only for a greeting, acknowledgement, filler, or closing phrase that adds no useful context.",
      "Use append-context for meaningful information that should be retained but does not ask for a response.",
      "Use answer for a question, directive, correction, constraint, or substantive follow-up.",
      "When a short technical entity could be a follow-up under the active task, prefer answer over ignore.",
      "evidenceSpans must contain one or more exact verbatim substrings from currentTurn.text.",
      "Do not classify question type, task relation, parent, playbook phase, or artifact intent.",
      "Schema: {schemaVersion:1,action,confidence,evidenceSpans}.",
    ].join(" "),
    userMessage: JSON.stringify(request),
  };
}

export function parseShortIntentGateOutput(
  rawOutput: string,
  request: ShortIntentGateRequest
): ShortIntentGateParseResult {
  const trimmed = stripJsonFence(rawOutput.trim());
  if (!trimmed) return parseFailure("empty-output", "parse");
  if (trimmed.length > SHORT_INTENT_GATE_MAX_OUTPUT_CHARS) {
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
    "action",
    "confidence",
    "evidenceSpans",
  ]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
    return parseFailure("non-intent-field-present", "schema");
  }
  if (candidate.schemaVersion !== SHORT_INTENT_GATE_SCHEMA_VERSION) {
    return parseFailure("unsupported-schema-version", "schema");
  }
  if (
    candidate.action !== "ignore" &&
    candidate.action !== "append-context" &&
    candidate.action !== "answer"
  ) {
    return parseFailure("invalid-action", "schema");
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
    candidate.evidenceSpans.length > 4 ||
    candidate.evidenceSpans.some(
      (span) => typeof span !== "string" || !span.trim()
    )
  ) {
    return parseFailure("invalid-evidence-spans", "schema");
  }
  const evidenceSpans = candidate.evidenceSpans as string[];
  if (
    evidenceSpans.some(
      (span) => !request.currentTurn.text.includes(span)
    )
  ) {
    return parseFailure("invalid-evidence-span", "evidence");
  }
  return {
    ok: true,
    value: {
      schemaVersion: SHORT_INTENT_GATE_SCHEMA_VERSION,
      action: candidate.action,
      confidence: candidate.confidence,
      evidenceSpans,
    },
    evidenceSpansValid: true,
  };
}

export function createShortIntentGateAdvisorDecision(input: {
  result: LlmShortIntentGateDecision;
  original: AdvisorTurnIntentDecision;
}): AdvisorTurnIntentDecision {
  const evidence = [
    ...input.original.evidence,
    "runtime-short-intent-gate",
    ...input.result.evidenceSpans.map(
      (span) => `runtime-evidence:${span}`
    ),
  ];
  if (input.result.action === "answer") {
    return {
      ...input.original,
      confidence: input.result.confidence,
      evidence,
      action: "answer-refresh",
      recommendedAction: "answer-refresh",
      reason: "runtime-short-intent-answer",
      contextPromptEligible: true,
      enforcement: "allow",
      wouldSuppress: false,
      executionAuthorized: true,
      authoritySource: "runtime-intent-gate",
    };
  }
  const action =
    input.result.action === "ignore" ? "ignore" : "append-only";
  return {
    ...input.original,
    intent:
      input.result.action === "ignore"
        ? "confirmation"
        : "informational",
    confidence: input.result.confidence,
    evidence,
    action,
    recommendedAction: action,
    reason: `runtime-short-intent-${input.result.action}`,
    contextPromptEligible: input.result.action === "append-context",
    enforcement: "enforce",
    wouldSuppress: true,
    executionAuthorized: false,
    authoritySource: "runtime-intent-gate",
  };
}

export function formatShortIntentLocalDecisionForTrace(
  decision: ShortIntentLocalDecision
) {
  return {
    shortIntentLocalDisposition: decision.disposition,
    shortIntentLocalReason: decision.reason,
    shortIntentWordEquivalent: decision.wordEquivalent,
    shortIntentHighInformation: decision.highInformation,
    canonicalFillerSuppressed:
      decision.disposition === "deterministic-ignore",
    shortHighInformationAllowed:
      decision.disposition === "deterministic-answer" &&
      decision.highInformation,
    residualShortIntentAdjudicationRequired:
      decision.disposition === "runtime-required",
  };
}

export function hashShortIntentSourceText(text: string) {
  let hash = 2_166_136_261;
  for (const character of text.trim().toLocaleLowerCase()) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isHighInformationShortTurn(text: string) {
  const trimmed = text.trim();
  if (/[?？]/u.test(trimmed)) return true;
  if (
    /^(?:why|what|how|where|when|who|which|can|could|would|should|do|does|did|is|are|use|write|code|implement)\b/iu.test(
      trimmed
    )
  ) {
    return true;
  }
  if (/^(?:为什么|什么|怎么|如何|哪里|哪儿|谁|是否|用|写|实现)/u.test(trimmed)) {
    return true;
  }
  return trimmed
    .split(/\s+/u)
    .some((token) => /^[A-Z][A-Z0-9+#.-]{1,}$/u.test(token));
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
): ShortIntentGateParseResult {
  return {
    ok: false,
    reason,
    errorKind,
    evidenceSpansValid: false,
  };
}
