import {
  formatSourceOwnedTransitionForTrace,
  prepareSourceOwnedTransition,
  type SourceOwnedTransitionCandidate,
  type SourceOwnedTransitionPreparationResult,
} from "./source-owned-transition-transaction.js";
import type {
  ActiveInterviewParent,
  ActiveScreenTask,
} from "./types.js";
import type { MeetingTaskRuntimeTransitionKind } from "./active-meeting-task.js";

export interface SourceOwnedRuntimeSnapshot {
  revision: number;
  parent?: ActiveInterviewParent;
  screenAttachment?: ActiveScreenTask;
}

export interface SourceOwnedRuntimeMutationResult {
  authorized: boolean;
  mutationApplied: boolean;
  reason: string;
}

export interface SourceOwnedDurableTransitionReceipt {
  sourceResult: SourceOwnedTransitionPreparationResult;
  runtimeResult?: SourceOwnedRuntimeMutationResult;
  expectedTaskRuntimeRevision: number;
  runtimeTransition?: MeetingTaskRuntimeTransitionKind;
  reason: string;
}

export function resolveSourceOwnedRuntimeTransition(input: {
  sourceResult: SourceOwnedTransitionPreparationResult;
  runtimeBefore: SourceOwnedRuntimeSnapshot;
}): MeetingTaskRuntimeTransitionKind {
  const { sourceResult, runtimeBefore } = input;
  if (sourceResult.candidate.kind === "child-probe") {
    return "attach-child";
  }
  if (sourceResult.candidate.kind === "resume-parent") {
    return "resume-parent";
  }
  if (sourceResult.candidate.kind === "phase-progress") {
    return sourceResult.phaseBefore !== sourceResult.phaseAfter
      ? "set-phase"
      : "update-parent-context";
  }
  return runtimeBefore.parent ? "replace-parent" : "create-parent";
}

export function commitSourceOwnedTransitionToRuntime(input: {
  candidate: SourceOwnedTransitionCandidate;
  runtimeBefore: SourceOwnedRuntimeSnapshot;
  expectedTaskRuntimeRevision: number;
  currentSessionId: string;
  currentRuntimeEpoch: number;
  commitRuntime: (input: {
    sourceResult: SourceOwnedTransitionPreparationResult;
    runtimeBefore: SourceOwnedRuntimeSnapshot;
    expectedTaskRuntimeRevision: number;
  }) => {
    runtimeResult: SourceOwnedRuntimeMutationResult;
    runtimeTransition: MeetingTaskRuntimeTransitionKind;
  };
  now?: number;
}): SourceOwnedDurableTransitionReceipt {
  const sourceResult = prepareSourceOwnedTransition({
    candidate: input.candidate,
    currentTask: input.runtimeBefore.parent,
    currentSessionId: input.currentSessionId,
    currentRuntimeEpoch: input.currentRuntimeEpoch,
    now: input.now,
  });
  if (input.runtimeBefore.revision !== input.expectedTaskRuntimeRevision) {
    return {
      sourceResult,
      expectedTaskRuntimeRevision: input.expectedTaskRuntimeRevision,
      reason: "task-runtime-revision-mismatch",
    };
  }
  if (
    sourceResult.candidate.state !== "committed" ||
    !sourceResult.mutationApplied
  ) {
    return {
      sourceResult,
      expectedTaskRuntimeRevision: input.expectedTaskRuntimeRevision,
      reason: sourceResult.reason,
    };
  }

  const committed = input.commitRuntime({
    sourceResult,
    runtimeBefore: input.runtimeBefore,
    expectedTaskRuntimeRevision: input.expectedTaskRuntimeRevision,
  });
  return {
    sourceResult,
    runtimeResult: committed.runtimeResult,
    expectedTaskRuntimeRevision: input.expectedTaskRuntimeRevision,
    runtimeTransition: committed.runtimeTransition,
    reason: committed.runtimeResult.reason,
  };
}

export function sourceOwnedTransitionDurableMutationApplied(
  receipt: SourceOwnedDurableTransitionReceipt | undefined
) {
  return Boolean(
    receipt?.runtimeResult?.authorized &&
      receipt.runtimeResult.mutationApplied
  );
}

export function sourceOwnedTransitionCommittedPhaseIdentityChange(
  receipt: SourceOwnedDurableTransitionReceipt | undefined
) {
  return Boolean(
    sourceOwnedTransitionDurableMutationApplied(receipt) &&
      receipt?.sourceResult.candidate.kind === "phase-progress" &&
      receipt.sourceResult.phaseBefore !== receipt.sourceResult.phaseAfter
  );
}

export function sourceOwnedTransitionCommittedFreshCodingChildImplementation(
  receipt: SourceOwnedDurableTransitionReceipt | undefined
) {
  const result = receipt?.sourceResult;
  const child = result?.task?.child;
  return Boolean(
    sourceOwnedTransitionDurableMutationApplied(receipt) &&
      result?.candidate.kind === "child-probe" &&
      result.childAfterId &&
      result.childAfterId !== result.childBeforeId &&
      child?.questionType === "coding" &&
      child.phaseState?.phase === "implementation_validation"
  );
}

export function sourceOwnedTransitionDurablySatisfied(
  receipt: SourceOwnedDurableTransitionReceipt | undefined
) {
  if (!receipt) return false;
  if (sourceOwnedTransitionDurableMutationApplied(receipt)) return true;
  if (
    receipt.runtimeResult?.authorized &&
    receipt.runtimeResult.reason === "preserved"
  ) {
    return true;
  }
  return (
    !receipt.runtimeResult &&
    receipt.sourceResult.candidate.state === "committed" &&
    !receipt.sourceResult.mutationApplied &&
    receipt.sourceResult.reason === "already-applied"
  );
}

export function sourceOwnedDurableTransitionSurvivesModelOutcome(
  receipt: SourceOwnedDurableTransitionReceipt | undefined,
  outcome: "cancelled" | "error" | "empty-output" | "stale-result" | "success"
) {
  return sourceOwnedTransitionDurablySatisfied(receipt) && outcome !== "success";
}

export function sourceOwnedTransitionCommittedFreshParent(
  receipt: SourceOwnedDurableTransitionReceipt | undefined
) {
  return Boolean(
    sourceOwnedTransitionDurableMutationApplied(receipt) &&
      (receipt?.sourceResult.candidate.kind === "new-parent" ||
        receipt?.sourceResult.candidate.kind === "reseed-parent")
  );
}

export function formatSourceOwnedDurableTransitionForTrace(
  receipt: SourceOwnedDurableTransitionReceipt | undefined,
  extra: {
    modelRequestStartedAt?: number;
    modelOutcome?: string;
    survivedModelOutcome?: boolean;
  } = {}
) {
  return {
    ...formatSourceOwnedTransitionForTrace(receipt?.sourceResult, {
      committedBeforeModel: sourceOwnedTransitionDurablySatisfied(receipt),
      ...extra,
    }),
    sourceTransitionExpectedTaskRuntimeRevision:
      receipt?.expectedTaskRuntimeRevision,
    sourceTransitionRuntimeKind: receipt?.runtimeTransition,
    sourceTransitionDurableAuthorized: receipt?.runtimeResult?.authorized,
    sourceTransitionDurableMutationApplied:
      receipt?.runtimeResult?.mutationApplied,
    sourceTransitionDurableReason: receipt?.reason,
  };
}
