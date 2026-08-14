import type {
  ForceAdviseAutomaticExecutionState,
  ForceAdviseManualExecutionState,
  ForceAdviseTargetPresentation,
  ForceAdviseTargetStatus,
} from "./types.js";

export type ForceAdviseEligibilityReason =
  | "no-recovery-target"
  | "recovery-target-ready"
  | "previous-advisor-attempt-failed"
  | "automatic-advisor-running"
  | "automatic-model-completed"
  | "delivery-pending-without-visible-commit"
  | "advisor-committed"
  | "manual-repair-running"
  | "manual-repair-committed"
  | "stale-recovery-target";

export interface ForceAdviseEligibilityDecision {
  eligible: boolean;
  retryable: boolean;
  reason: ForceAdviseEligibilityReason;
}

export function matchesForceAdviseTargetTransition(
  current: Pick<
    ForceAdviseTargetPresentation,
    | "targetId"
    | "targetKind"
    | "logicalQuestionUnitId"
    | "logicalQuestionUnitRevision"
  >,
  incoming: {
    targetId?: string;
    logicalQuestionUnitId: string | null | undefined;
    logicalQuestionUnitRevision: number | null | undefined;
  }
): boolean {
  if (
    !incoming.logicalQuestionUnitId ||
    incoming.logicalQuestionUnitRevision === null ||
    incoming.logicalQuestionUnitRevision === undefined
  ) {
    return false;
  }
  if (incoming.targetId) {
    return current.targetId === incoming.targetId;
  }
  return (
    current.targetKind === "canonical-question" &&
    current.logicalQuestionUnitId === incoming.logicalQuestionUnitId &&
    current.logicalQuestionUnitRevision ===
      incoming.logicalQuestionUnitRevision
  );
}

export type ForceAdviseRepairCause =
  | "intent-false-negative"
  | "advisor-execution-failure"
  | "manual-expedite"
  | "visible-delivery-recovery";

export function decideForceAdviseEligibility(
  target:
    | (Pick<ForceAdviseTargetPresentation, "status"> &
        Partial<
          Pick<
            ForceAdviseTargetPresentation,
            "automaticExecutionState" | "manualExecutionState"
          >
        >)
    | undefined
): ForceAdviseEligibilityDecision {
  if (!target) {
    return {
      eligible: false,
      retryable: false,
      reason: "no-recovery-target",
    };
  }

  if (target.manualExecutionState === "visible-committed") {
    return {
      eligible: false,
      retryable: false,
      reason: "manual-repair-committed",
    };
  }
  if (target.automaticExecutionState === "visible-committed") {
    return {
      eligible: false,
      retryable: false,
      reason: "advisor-committed",
    };
  }
  if (target.manualExecutionState === "running") {
    return {
      eligible: false,
      retryable: false,
      reason: "manual-repair-running",
    };
  }
  if (target.automaticExecutionState === "running") {
    return {
      eligible: true,
      retryable: true,
      reason: "automatic-advisor-running",
    };
  }
  if (target.automaticExecutionState === "model-completed") {
    return {
      eligible: true,
      retryable: true,
      reason: "automatic-model-completed",
    };
  }
  if (target.automaticExecutionState === "delivery-pending") {
    return {
      eligible: true,
      retryable: true,
      reason: "delivery-pending-without-visible-commit",
    };
  }

  switch (target.status) {
    case "ready":
      return {
        eligible: true,
        retryable: true,
        reason: "recovery-target-ready",
      };
    case "failed":
      return {
        eligible: true,
        retryable: true,
        reason: "previous-advisor-attempt-failed",
      };
    case "advising":
      return {
        eligible: true,
        retryable: true,
        reason: "automatic-advisor-running",
      };
    case "delivery-pending":
      return {
        eligible: true,
        retryable: true,
        reason: "delivery-pending-without-visible-commit",
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
        reason: "stale-recovery-target",
      };
  }
}

export function classifyForceAdviseRepairCause({
  executionAuthorized,
  automaticExecutionState,
}: Pick<ForceAdviseTargetPresentation, "executionAuthorized"> &
  Partial<
    Pick<ForceAdviseTargetPresentation, "automaticExecutionState">
  >): ForceAdviseRepairCause {
  if (automaticExecutionState === "running") return "manual-expedite";
  if (
    automaticExecutionState === "model-completed" ||
    automaticExecutionState === "delivery-pending"
  ) {
    return "visible-delivery-recovery";
  }
  return executionAuthorized
    ? "advisor-execution-failure"
    : "intent-false-negative";
}

export function forceAdviseStatusAfterAdvisorOutcome({
  committedVisibleAnswer,
  deliveryPending = false,
}: {
  committedVisibleAnswer: boolean;
  deliveryPending?: boolean;
}): ForceAdviseTargetStatus {
  if (committedVisibleAnswer) return "already-advised";
  return deliveryPending ? "delivery-pending" : "failed";
}

export function deriveForceAdviseTargetStatus(input: {
  automaticExecutionState: ForceAdviseAutomaticExecutionState;
  manualExecutionState: ForceAdviseManualExecutionState;
}): ForceAdviseTargetStatus {
  if (input.manualExecutionState === "visible-committed") return "repaired";
  if (input.automaticExecutionState === "visible-committed") {
    return "already-advised";
  }
  if (input.manualExecutionState === "running") return "repairing";
  if (input.manualExecutionState === "failed") return "failed";
  if (input.manualExecutionState === "stale") return "stale";

  switch (input.automaticExecutionState) {
    case "not-started":
      return "ready";
    case "running":
    case "model-completed":
      return "advising";
    case "delivery-pending":
      return "delivery-pending";
    case "failed":
      return "failed";
    case "stale":
      return "stale";
  }
}
