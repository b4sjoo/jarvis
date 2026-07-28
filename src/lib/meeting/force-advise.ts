import type {
  ForceAdviseTargetPresentation,
  ForceAdviseTargetStatus,
} from "./types.js";

export type ForceAdviseEligibilityReason =
  | "no-canonical-target"
  | "canonical-target-ready"
  | "previous-advisor-attempt-failed"
  | "advisor-running"
  | "advisor-committed"
  | "manual-repair-running"
  | "manual-repair-committed"
  | "stale-canonical-target";

export interface ForceAdviseEligibilityDecision {
  eligible: boolean;
  retryable: boolean;
  reason: ForceAdviseEligibilityReason;
}

export type ForceAdviseRepairCause =
  | "intent-false-negative"
  | "advisor-execution-failure";

export function decideForceAdviseEligibility(
  target:
    | Pick<ForceAdviseTargetPresentation, "status">
    | undefined
): ForceAdviseEligibilityDecision {
  if (!target) {
    return {
      eligible: false,
      retryable: false,
      reason: "no-canonical-target",
    };
  }

  switch (target.status) {
    case "ready":
      return {
        eligible: true,
        retryable: true,
        reason: "canonical-target-ready",
      };
    case "failed":
      return {
        eligible: true,
        retryable: true,
        reason: "previous-advisor-attempt-failed",
      };
    case "advising":
      return {
        eligible: false,
        retryable: false,
        reason: "advisor-running",
      };
    case "already-advised":
      return {
        eligible: false,
        retryable: false,
        reason: "advisor-committed",
      };
    case "repairing":
      return {
        eligible: false,
        retryable: false,
        reason: "manual-repair-running",
      };
    case "repaired":
      return {
        eligible: false,
        retryable: false,
        reason: "manual-repair-committed",
      };
    case "stale":
      return {
        eligible: false,
        retryable: false,
        reason: "stale-canonical-target",
      };
  }
}

export function classifyForceAdviseRepairCause({
  executionAuthorized,
}: Pick<
  ForceAdviseTargetPresentation,
  "executionAuthorized"
>): ForceAdviseRepairCause {
  return executionAuthorized
    ? "advisor-execution-failure"
    : "intent-false-negative";
}

export function forceAdviseStatusAfterAdvisorOutcome({
  committedVisibleAnswer,
}: {
  committedVisibleAnswer: boolean;
}): ForceAdviseTargetStatus {
  return committedVisibleAnswer ? "already-advised" : "failed";
}
