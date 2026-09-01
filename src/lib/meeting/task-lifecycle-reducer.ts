import {
  buildActiveMeetingTask,
  type ActiveMeetingTask,
} from "./active-meeting-task.js";
import type { SettledAdvisorExecutionPlan } from "./settled-advisor-execution-plan.js";
import {
  areCompatibleParentContinuityTypes,
  normalizeCanonicalQuestionType,
} from "./task-taxonomy.js";
import type {
  ActiveInterviewParent,
  ActiveScreenTask,
} from "./types.js";

export interface TaskLifecycleTransaction {
  id: string;
  executionPlanId: string;
  settlementId: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionRevision: number;
  manualCorrectionRevision: number;
  expectedParentId?: string;
  expectedParentRevision?: number;
  proposedActiveInterviewTask?: ActiveInterviewParent | null;
  proposedActiveScreenTask?: ActiveScreenTask | null;
  plan: SettledAdvisorExecutionPlan;
  createdAt: number;
}

export type TaskLifecycleReductionReason =
  | "committed"
  | "preserved"
  | "session-mismatch"
  | "runtime-epoch-mismatch"
  | "logical-question-unit-mismatch"
  | "logical-question-revision-mismatch"
  | "manual-correction-revision-mismatch"
  | "settlement-mismatch"
  | "parent-id-mismatch"
  | "parent-revision-mismatch"
  | "proposed-parent-required"
  | "command-type-mismatch"
  | "command-topic-mismatch"
  | "command-transition-mismatch"
  | "post-mutation-plan-mismatch"
  | "incompatible-artifact-retained";

export interface TaskLifecycleReduction {
  transactionId: string;
  executionPlanId: string;
  authorized: boolean;
  mutationApplied: boolean;
  reason: TaskLifecycleReductionReason;
  parent?: ActiveInterviewParent | null;
  screenAttachment?: ActiveScreenTask | null;
  activeMeetingTask?: ActiveMeetingTask;
  parentBeforeId?: string;
  parentBeforeRevision?: number;
  parentBeforeType?: string;
  parentAfterId?: string;
  parentAfterRevision?: number;
  parentAfterType?: string;
  artifactOwnerBeforeId?: string;
  artifactOwnerAfterId?: string;
}

export function createTaskLifecycleTransaction(input: {
  plan: SettledAdvisorExecutionPlan;
  manualCorrectionRevision: number;
  proposedActiveInterviewTask?: ActiveInterviewParent | null;
  proposedActiveScreenTask?: ActiveScreenTask | null;
  createdAt?: number;
}): TaskLifecycleTransaction {
  return {
    id: `task_lifecycle_${input.plan.id}`,
    executionPlanId: input.plan.id,
    settlementId: input.plan.settlementId,
    sessionId: input.plan.sessionId,
    runtimeEpoch: input.plan.runtimeEpoch,
    logicalQuestionUnitId: input.plan.logicalQuestionUnitId,
    logicalQuestionRevision: input.plan.logicalQuestionRevision,
    manualCorrectionRevision: input.manualCorrectionRevision,
    expectedParentId: input.plan.expectedParentId,
    expectedParentRevision: input.plan.expectedParentRevision,
    proposedActiveInterviewTask:
      input.proposedActiveInterviewTask === undefined
        ? undefined
        : cloneInterviewParent(input.proposedActiveInterviewTask),
    proposedActiveScreenTask:
      input.proposedActiveScreenTask === undefined
        ? undefined
        : cloneScreenTask(input.proposedActiveScreenTask),
    plan: input.plan,
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function reduceTaskLifecycleTransaction(input: {
  transaction: TaskLifecycleTransaction;
  currentSessionId: string;
  currentRuntimeEpoch: number;
  currentLogicalQuestionUnitId?: string;
  currentLogicalQuestionRevision?: number;
  currentManualCorrectionRevision: number;
  currentTaskRuntimeRevision: number;
  currentActiveInterviewTask?: ActiveInterviewParent;
  currentActiveScreenTask?: ActiveScreenTask;
}): TaskLifecycleReduction {
  const { transaction } = input;
  const reject = (
    reason: TaskLifecycleReductionReason
  ): TaskLifecycleReduction =>
    buildReduction({
      transaction,
      authorized: false,
      mutationApplied: false,
      reason,
      before: input.currentActiveInterviewTask,
      after: input.currentActiveInterviewTask,
      parent: input.currentActiveInterviewTask,
      screenAttachment: input.currentActiveScreenTask,
    });

  if (transaction.sessionId !== input.currentSessionId) {
    return reject("session-mismatch");
  }
  if (transaction.runtimeEpoch !== input.currentRuntimeEpoch) {
    return reject("runtime-epoch-mismatch");
  }
  if (
    transaction.logicalQuestionUnitId !==
    input.currentLogicalQuestionUnitId
  ) {
    return reject("logical-question-unit-mismatch");
  }
  if (
    transaction.logicalQuestionRevision !==
    input.currentLogicalQuestionRevision
  ) {
    return reject("logical-question-revision-mismatch");
  }
  if (
    transaction.manualCorrectionRevision !==
    input.currentManualCorrectionRevision
  ) {
    return reject("manual-correction-revision-mismatch");
  }
  if (transaction.settlementId !== transaction.plan.settlementId) {
    return reject("settlement-mismatch");
  }
  if (
    transaction.expectedParentId !==
    input.currentActiveInterviewTask?.id
  ) {
    return reject("parent-id-mismatch");
  }
  if (
    transaction.expectedParentRevision !== undefined &&
    transaction.expectedParentRevision !==
      input.currentActiveInterviewTask?.revisions
  ) {
    return reject("parent-revision-mismatch");
  }

  const command = transaction.plan.taskMutationPolicy;
  if (command.kind === "preserve") {
    return buildReduction({
      transaction,
      authorized: true,
      mutationApplied: false,
      reason: "preserved",
      before: input.currentActiveInterviewTask,
      after: input.currentActiveInterviewTask,
      parent: input.currentActiveInterviewTask,
      screenAttachment: input.currentActiveScreenTask,
    });
  }

  const proposedParent = transaction.proposedActiveInterviewTask;
  if (!proposedParent) return reject("proposed-parent-required");

  const commandValidation = validateCommandTransition({
    command,
    before: input.currentActiveInterviewTask,
    after: proposedParent,
  });
  if (commandValidation) return reject(commandValidation);

  const proposedScreen =
    transaction.proposedActiveScreenTask === undefined
      ? input.currentActiveScreenTask
      : transaction.proposedActiveScreenTask ?? undefined;
  if (
    (command.kind === "create-parent" ||
      command.kind === "replace-parent") &&
    proposedScreen &&
    normalizeCanonicalQuestionType(proposedScreen.kind) !==
      normalizeCanonicalQuestionType(proposedParent.stableKind)
  ) {
    return reject("command-type-mismatch");
  }
  if (
    retainsIncompatibleWhiteboard(
      input.currentActiveInterviewTask,
      proposedParent
    )
  ) {
    return reject("incompatible-artifact-retained");
  }

  const activeMeetingTask = buildActiveMeetingTask({
    screenAttachment: proposedScreen,
    parent: proposedParent,
    runtimeRevision: input.currentTaskRuntimeRevision + 1,
  });
  if (
    !activeMeetingTask ||
    activeMeetingTask.parent.id !==
      transaction.plan.postMutationParentId ||
    activeMeetingTask.parent.revisions !==
      transaction.plan.postMutationParentRevision ||
    normalizeCanonicalQuestionType(
      activeMeetingTask.parent.questionType
    ) !==
      normalizeCanonicalQuestionType(
        transaction.plan.taskSnapshot?.parent.questionType
      )
  ) {
    return reject("post-mutation-plan-mismatch");
  }

  return buildReduction({
    transaction,
    authorized: true,
    mutationApplied: true,
    reason: "committed",
    before: input.currentActiveInterviewTask,
    after: proposedParent,
    parent: proposedParent,
    screenAttachment: proposedScreen,
    activeMeetingTask,
  });
}

export function formatTaskLifecycleReductionForTrace(
  reduction: TaskLifecycleReduction | undefined
): Record<string, unknown> {
  if (!reduction) return {};
  return {
    taskLifecycleTransactionId: reduction.transactionId,
    taskLifecycleExecutionPlanId: reduction.executionPlanId,
    taskLifecycleAuthorized: reduction.authorized,
    taskLifecycleMutationApplied: reduction.mutationApplied,
    taskLifecycleReductionReason: reduction.reason,
    taskLifecycleParentBeforeId: reduction.parentBeforeId,
    taskLifecycleParentBeforeRevision:
      reduction.parentBeforeRevision,
    taskLifecycleParentBeforeType: reduction.parentBeforeType,
    taskLifecycleParentAfterId: reduction.parentAfterId,
    taskLifecycleParentAfterRevision:
      reduction.parentAfterRevision,
    taskLifecycleParentAfterType: reduction.parentAfterType,
    taskLifecycleArtifactOwnerBeforeId:
      reduction.artifactOwnerBeforeId,
    taskLifecycleArtifactOwnerAfterId:
      reduction.artifactOwnerAfterId,
  };
}

function validateCommandTransition(input: {
  command: SettledAdvisorExecutionPlan["taskMutationPolicy"];
  before?: ActiveInterviewParent;
  after: ActiveInterviewParent;
}): TaskLifecycleReductionReason | undefined {
  const { command, before, after } = input;
  if (
    command.kind === "create-parent" ||
    command.kind === "replace-parent"
  ) {
    if (
      normalizeCanonicalQuestionType(command.type) !==
      normalizeCanonicalQuestionType(after.stableKind)
    ) {
      return "command-type-mismatch";
    }
    if (normalizeText(command.topic) !== normalizeText(after.topic)) {
      return "command-topic-mismatch";
    }
    if (command.kind === "replace-parent" && !before) {
      return "command-transition-mismatch";
    }
    if (
      command.kind === "create-parent" &&
      before?.id === after.id
    ) {
      return "command-transition-mismatch";
    }
    if (
      command.kind === "replace-parent" &&
      before?.id === after.id &&
      after.revisions !== before.revisions + 1
    ) {
      return "command-transition-mismatch";
    }
    return undefined;
  }
  if (!before || before.id !== after.id) {
    return "command-transition-mismatch";
  }
  if (
    after.revisions !== before.revisions + 1 &&
    command.kind !== "preserve"
  ) {
    return "command-transition-mismatch";
  }
  if (command.kind === "attach-child") {
    return after.child &&
      normalizeCanonicalQuestionType(after.child.questionType) ===
        normalizeCanonicalQuestionType(command.type) &&
      normalizeText(after.child.question) ===
        normalizeText(command.question)
      ? undefined
      : "command-transition-mismatch";
  }
  if (command.kind === "resume-parent") {
    return before.child && !after.child
      ? undefined
      : "command-transition-mismatch";
  }
  if (command.kind === "set-phase") {
    if (command.owner.kind === "parent") {
      return command.owner.id === after.id &&
        !before.child &&
        !after.child &&
        before.playbookPhase !== after.playbookPhase &&
        after.playbookPhase === command.phase
        ? undefined
        : "command-transition-mismatch";
    }
    return command.owner.id === before.child?.id &&
      command.owner.id === after.child?.id &&
      before.child.phaseState &&
      after.child.phaseState &&
      before.child.phaseState.phase !== after.child.phaseState.phase &&
      after.child.phaseState.phase === command.phase
      ? undefined
      : "command-transition-mismatch";
  }
  if (command.kind === "update-parent-context") return undefined;
  return "command-transition-mismatch";
}

function retainsIncompatibleWhiteboard(
  before: ActiveInterviewParent | undefined,
  after: ActiveInterviewParent
) {
  if (!before?.whiteboardArtifact || !after.whiteboardArtifact) {
    return false;
  }
  return !areCompatibleParentContinuityTypes(
    before.stableKind,
    after.stableKind
  );
}

function buildReduction(input: {
  transaction: TaskLifecycleTransaction;
  authorized: boolean;
  mutationApplied: boolean;
  reason: TaskLifecycleReductionReason;
  before?: ActiveInterviewParent;
  after?: ActiveInterviewParent;
  parent?: ActiveInterviewParent | null;
  screenAttachment?: ActiveScreenTask | null;
  activeMeetingTask?: ActiveMeetingTask;
}): TaskLifecycleReduction {
  return {
    transactionId: input.transaction.id,
    executionPlanId: input.transaction.executionPlanId,
    authorized: input.authorized,
    mutationApplied: input.mutationApplied,
    reason: input.reason,
    parent: cloneInterviewParent(input.parent),
    screenAttachment: cloneScreenTask(input.screenAttachment),
    activeMeetingTask: input.activeMeetingTask
      ? cloneActiveMeetingTask(input.activeMeetingTask)
      : undefined,
    parentBeforeId: input.before?.id,
    parentBeforeRevision: input.before?.revisions,
    parentBeforeType: input.before?.stableKind,
    parentAfterId: input.after?.id,
    parentAfterRevision: input.after?.revisions,
    parentAfterType: input.after?.stableKind,
    artifactOwnerBeforeId:
      input.before?.whiteboardArtifact?.parentTaskId ??
      input.before?.id,
    artifactOwnerAfterId:
      input.after?.whiteboardArtifact?.parentTaskId ??
      input.after?.id,
  };
}

function cloneInterviewParent<T extends ActiveInterviewParent | null | undefined>(
  value: T
): T {
  return clone(value);
}

function cloneScreenTask<T extends ActiveScreenTask | null | undefined>(
  value: T
): T {
  return clone(value);
}

function cloneActiveMeetingTask(value: ActiveMeetingTask) {
  return clone(value);
}

function clone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}
