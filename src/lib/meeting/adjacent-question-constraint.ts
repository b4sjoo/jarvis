import { inferExplicitProgrammingLanguageFromText } from "./programming-language.js";
import { calculateWordEquivalent } from "./transcript-fusion.js";
import type { QuestionInstanceLineage } from "./types.js";

export const ADJACENT_QUESTION_SCOPE_TTL_MS = 8_000;
export const ADJACENT_CONSTRAINT_MAX_CHARS = 160;
export const ADJACENT_CONSTRAINT_MAX_WORD_EQUIVALENT = 12;

export type AdjacentConstraintKind =
  | "programming-language"
  | "scale"
  | "output-format"
  | "algorithm-constraint";

export interface AdjacentQuestionScope {
  lineage: QuestionInstanceLineage;
  questionTurnId: string;
  questionTraceId: string;
  questionText: string;
  sessionId: string;
  runtimeEpoch: number;
  createdAt: number;
  expiresAt: number;
}

export interface AdjacentConstraintInheritanceDecision {
  inherited: boolean;
  reason:
    | "inherited-explicit-constraint"
    | "missing-provisional-question"
    | "session-mismatch"
    | "runtime-epoch-mismatch"
    | "scope-expired"
    | "constraint-too-long"
    | "no-explicit-constraint";
  constraintKinds: AdjacentConstraintKind[];
  deltaMs?: number;
  lineage?: QuestionInstanceLineage;
  scope?: AdjacentQuestionScope;
  shouldClearScope: boolean;
}

export function createAdjacentQuestionScope({
  lineage,
  questionTurnId,
  questionTraceId,
  questionText,
  sessionId,
  runtimeEpoch,
  now = Date.now(),
}: {
  lineage: QuestionInstanceLineage;
  questionTurnId: string;
  questionTraceId: string;
  questionText: string;
  sessionId: string;
  runtimeEpoch: number;
  now?: number;
}): AdjacentQuestionScope {
  return {
    lineage: { ...lineage },
    questionTurnId,
    questionTraceId,
    questionText: questionText.trim(),
    sessionId,
    runtimeEpoch,
    createdAt: now,
    expiresAt: now + ADJACENT_QUESTION_SCOPE_TTL_MS,
  };
}

export function resolveAdjacentConstraintInheritance({
  scope,
  text,
  sessionId,
  runtimeEpoch,
  now = Date.now(),
}: {
  scope: AdjacentQuestionScope | null | undefined;
  text: string;
  sessionId: string;
  runtimeEpoch: number;
  now?: number;
}): AdjacentConstraintInheritanceDecision {
  if (!scope) {
    return rejectedDecision("missing-provisional-question", false);
  }
  if (scope.sessionId !== sessionId) {
    return rejectedDecision("session-mismatch", true);
  }
  if (scope.runtimeEpoch !== runtimeEpoch) {
    return rejectedDecision("runtime-epoch-mismatch", true);
  }
  if (now > scope.expiresAt) {
    return rejectedDecision("scope-expired", true, now - scope.createdAt);
  }

  const trimmed = text.trim();
  const deltaMs = Math.max(0, now - scope.createdAt);
  if (
    trimmed.length > ADJACENT_CONSTRAINT_MAX_CHARS ||
    calculateWordEquivalent(trimmed) > ADJACENT_CONSTRAINT_MAX_WORD_EQUIVALENT
  ) {
    return rejectedDecision("constraint-too-long", false, deltaMs);
  }

  const constraintKinds = classifyAdjacentConstraintKinds(trimmed);
  if (constraintKinds.length === 0) {
    return rejectedDecision("no-explicit-constraint", false, deltaMs);
  }

  return {
    inherited: true,
    reason: "inherited-explicit-constraint",
    constraintKinds,
    deltaMs,
    lineage: { ...scope.lineage },
    scope,
    shouldClearScope: false,
  };
}

export function classifyAdjacentConstraintKinds(
  text: string
): AdjacentConstraintKind[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const kinds: AdjacentConstraintKind[] = [];
  if (inferExplicitProgrammingLanguageFromText(trimmed)) {
    kinds.push("programming-language");
  }
  if (
    /\b\d+(?:\.\d+)?\s*(?:k|m|b|thousand|million|billion)?\s*(?:qps|tps|rps|users?|requests?|queries|events?|items?|records?|rows?|nodes?|ms|milliseconds?|seconds?|minutes?|kb|mb|gb|tb)\b/i.test(
      trimmed
    )
  ) {
    kinds.push("scale");
  }
  if (
    /\b(?:return|output|respond with|provide|show)\s+(?:the\s+)?(?:indices?|indexes?|values?|count|path|paths|boolean|list|array|object|code)\b/i.test(
      trimmed
    ) ||
    /\b(?:as|in)\s+(?:json|yaml|xml|csv|plain text|ascii)\b/i.test(trimmed) ||
    /\b(?:code only|just the code|no explanation)\b/i.test(trimmed)
  ) {
    kinds.push("output-format");
  }
  if (
    /\b(?:without (?:any )?(?:extra|additional) space|constant space|o\s*\(\s*1\s*\)\s+space|in[ -]?place|no recursion|without recursion|iterative only|recursive only|single pass|one pass|linear time|o\s*\(\s*n\s*\))\b/i.test(
      trimmed
    )
  ) {
    kinds.push("algorithm-constraint");
  }

  return kinds;
}

export function formatAdjacentQuestionScopeForTrace(
  scope: AdjacentQuestionScope
) {
  return {
    adjacentQuestionScopeCreated: true,
    adjacentQuestionScopeExpiresAt: scope.expiresAt,
    adjacentQuestionOriginTraceId: scope.questionTraceId,
    adjacentQuestionTurnId: scope.questionTurnId,
    adjacentQuestionInstanceId: scope.lineage.questionInstanceId,
  };
}

export function formatAdjacentConstraintDecisionForTrace(
  decision: AdjacentConstraintInheritanceDecision
) {
  return {
    adjacentConstraintInherited: decision.inherited,
    adjacentConstraintDecisionReason: decision.reason,
    adjacentConstraintKinds: decision.constraintKinds.join(","),
    adjacentConstraintDeltaMs: decision.deltaMs,
    adjacentQuestionOriginTraceId: decision.scope?.questionTraceId,
    adjacentQuestionTurnId: decision.scope?.questionTurnId,
    adjacentQuestionInstanceId: decision.lineage?.questionInstanceId,
  };
}

function rejectedDecision(
  reason: Exclude<
    AdjacentConstraintInheritanceDecision["reason"],
    "inherited-explicit-constraint"
  >,
  shouldClearScope: boolean,
  deltaMs?: number
): AdjacentConstraintInheritanceDecision {
  return {
    inherited: false,
    reason,
    constraintKinds: [],
    deltaMs,
    shouldClearScope,
  };
}
