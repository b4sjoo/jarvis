import type {
  ActiveMeetingTask,
  MeetingTaskRuntimeState,
} from "./active-meeting-task.js";
import type { StableAnswerRevision } from "./stable-answer.js";

export type SameOwnerAnswerCommitRebaseReason =
  | "authorized"
  | "owner-missing"
  | "owner-mismatch"
  | "not-single-answer-commit"
  | "stable-answer-receipt-mismatch"
  | "semantic-task-drift";

export interface SameOwnerAnswerCommitRebaseDecision {
  authorized: boolean;
  reason: SameOwnerAnswerCommitRebaseReason;
  expectedParentRevision?: number;
  currentParentRevision?: number;
  expectedTaskRuntimeRevision?: number;
  currentTaskRuntimeRevision?: number;
}

export function decideSameOwnerAnswerCommitRebase(input: {
  expectedTask?: ActiveMeetingTask;
  currentTask?: ActiveMeetingTask;
  expectedTaskRuntimeRevision: number;
  currentTaskRuntime: MeetingTaskRuntimeState;
  stableAnswer?: StableAnswerRevision | null;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  jobScheduledAt: number;
}): SameOwnerAnswerCommitRebaseDecision {
  const expectedParentRevision = input.expectedTask?.parent.revisions;
  const currentParentRevision = input.currentTask?.parent.revisions;
  const base = {
    expectedParentRevision,
    currentParentRevision,
    expectedTaskRuntimeRevision: input.expectedTaskRuntimeRevision,
    currentTaskRuntimeRevision: input.currentTaskRuntime.revision,
  };
  if (!input.expectedTask || !input.currentTask) {
    return { ...base, authorized: false, reason: "owner-missing" };
  }
  if (!input.logicalQuestionUnitId.trim()) {
    return { ...base, authorized: false, reason: "owner-missing" };
  }

  const expectedBranchId =
    input.expectedTask.child?.id ?? input.expectedTask.parent.id;
  const currentBranchId =
    input.currentTask.child?.id ?? input.currentTask.parent.id;
  if (
    input.expectedTask.parent.id !== input.currentTask.parent.id ||
    expectedBranchId !== currentBranchId
  ) {
    return { ...base, authorized: false, reason: "owner-mismatch" };
  }

  const receipt = input.currentTaskRuntime.lastMutation;
  if (
    expectedParentRevision === undefined ||
    currentParentRevision !== expectedParentRevision + 1 ||
    input.currentTaskRuntime.revision !==
      input.expectedTaskRuntimeRevision + 1 ||
    receipt?.kind !== "commit-transition" ||
    receipt.reason !== "advisor-answer-continuity-committed" ||
    receipt.appliedAt < input.jobScheduledAt
  ) {
    return {
      ...base,
      authorized: false,
      reason: "not-single-answer-commit",
    };
  }

  const stable = input.stableAnswer;
  const stableBranchId =
    stable?.suggestion.childTaskId ?? stable?.taskId ?? undefined;
  if (
    !stable ||
    stable.sessionId !== input.sessionId ||
    stable.runtimeEpoch !== input.runtimeEpoch ||
    stable.taskId !== input.currentTask.parent.id ||
    stableBranchId !== currentBranchId ||
    stable.committedAt < input.jobScheduledAt ||
    !stable.logicalQuestionUnitId ||
    stable.logicalQuestionUnitId === input.logicalQuestionUnitId
  ) {
    return {
      ...base,
      authorized: false,
      reason: "stable-answer-receipt-mismatch",
    };
  }

  if (
    taskAuthorityFingerprint(input.expectedTask) !==
    taskAuthorityFingerprint(input.currentTask)
  ) {
    return { ...base, authorized: false, reason: "semantic-task-drift" };
  }

  return { ...base, authorized: true, reason: "authorized" };
}

export function formatSameOwnerAnswerCommitRebaseForTrace(
  decision: SameOwnerAnswerCommitRebaseDecision,
  durationMs: number,
  stage: string
): Record<string, unknown> {
  return {
    sameOwnerAnswerCommitRebaseAttempted: true,
    sameOwnerAnswerCommitRebaseAuthorized: decision.authorized,
    sameOwnerAnswerCommitRebaseReason: decision.reason,
    sameOwnerAnswerCommitRebaseStage: stage,
    sameOwnerAnswerCommitRebaseExpectedParentRevision:
      decision.expectedParentRevision,
    sameOwnerAnswerCommitRebaseCurrentParentRevision:
      decision.currentParentRevision,
    sameOwnerAnswerCommitRebaseExpectedTaskRuntimeRevision:
      decision.expectedTaskRuntimeRevision,
    sameOwnerAnswerCommitRebaseCurrentTaskRuntimeRevision:
      decision.currentTaskRuntimeRevision,
    sameOwnerAnswerCommitRebaseCheckDurationMs: durationMs,
  };
}

function taskAuthorityFingerprint(task: ActiveMeetingTask) {
  const parent = task.parent;
  const child = task.child;
  const screen = task.screen;
  return JSON.stringify([
    task.id,
    task.source,
    parent.id,
    parent.questionType,
    parent.topic,
    parent.playbook?.id,
    parent.playbook?.phase,
    parent.playbookPhase,
    Object.entries(parent.phaseProgress).sort(([left], [right]) =>
      left.localeCompare(right)
    ),
    parent.projectBinding?.projectId,
    parent.projectBinding?.projectName,
    parent.projectBinding?.source,
    parent.projectBinding?.revision,
    parent.supportedFactAnchors,
    parent.whiteboardArtifact?.id,
    parent.whiteboardArtifact?.revision,
    parent.originQuestionId,
    parent.startTurnId,
    parent.startObservationId,
    parent.latestScreenObservationId,
    parent.promptTranscriptStartTurnId,
    parent.canonicalQuestionSourceTurnIds,
    parent.sourceQuestionUnitId,
    parent.sourceQuestionRevision,
    parent.settlementId,
    parent.parentContextHandoff?.sourceParentId,
    parent.parentContextHandoff?.sourceQuestionId,
    child?.id,
    child?.questionType,
    child?.intent,
    child?.question,
    child?.compactSummary,
    child?.artifactId,
    child?.basedOnTurnIds,
    child?.basedOnObservationIds,
    child?.latestScreenObservationId,
    child?.phaseState?.phase,
    child?.phaseState?.revision,
    child?.phaseState?.playbook.id,
    child?.returnCapsule?.parentId,
    child?.returnCapsule?.parentRevisionAtAttach,
    screen?.activeScreenTaskId,
    screen?.observationId,
    screen?.basedOnObservationId,
    screen?.language,
    screen?.question,
    screen?.askFrame,
    screen?.topicDomain,
    screen?.projectAnchor,
    task.divergence?.reason,
    task.divergence?.screenTaskId,
    task.divergence?.interviewParentId,
    task.divergence?.screenQuestionType,
    task.divergence?.parentQuestionType,
  ]);
}
