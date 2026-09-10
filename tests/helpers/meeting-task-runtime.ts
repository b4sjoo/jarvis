import type { MeetingTaskDeadlineDelta } from "../../src/lib/meeting/meeting-task-contracts.js";
import type { MeetingContextManager } from "../../src/lib/meeting/context-manager.js";
import type { ActiveInterviewParent, ActiveScreenTask } from "../../src/lib/meeting/types.js";
import type { MeetingTaskRuntimeTransitionKind } from "../../src/lib/meeting/active-meeting-task.js";

let testMutationSequence = 0;

export function setTestActiveParent(
  manager: MeetingContextManager,
  parent: ActiveInterviewParent,
  deadlineDelta?: MeetingTaskDeadlineDelta
) {
  return setTestTaskRuntime(manager, { parent }, deadlineDelta);
}

export function setTestScreenAttachment(
  manager: MeetingContextManager,
  screenAttachment: ActiveScreenTask,
  deadlineDelta?: MeetingTaskDeadlineDelta
) {
  return setTestTaskRuntime(manager, { screenAttachment }, deadlineDelta);
}

export function setTestTaskRuntime(
  manager: MeetingContextManager,
  patch: {
    parent?: ActiveInterviewParent | null;
    screenAttachment?: ActiveScreenTask | null;
  },
  deadlineDelta?: MeetingTaskDeadlineDelta
) {
  const before = manager.getTaskRuntimeState();
  const hasParent = Object.prototype.hasOwnProperty.call(patch, "parent");
  const hasScreen = Object.prototype.hasOwnProperty.call(
    patch,
    "screenAttachment"
  );

  if (hasParent && patch.parent === null) {
    const clearResult = manager.clearTaskRuntime({
      id: nextTestMutationId("clear-parent"),
      scope: "parent",
      reason: "test-seed-clear-parent",
      expectedRevision: before.revision,
    });
    assertAuthorized(clearResult);
    if (!hasScreen) return clearResult;
  }

  const current = manager.getTaskRuntimeState();
  const parent = hasParent ? patch.parent ?? undefined : current.parent;
  const screenAttachment = hasScreen
    ? patch.screenAttachment ?? undefined
    : current.screenAttachment;
  const transition = selectTestTransition({
    beforeParent: current.parent,
    afterParent: parent,
    hasParent,
  });
  const result = manager.commitTaskRuntimeTransition({
    id: nextTestMutationId(transition),
    transition,
    reason: "test-seed-task-runtime",
    expectedRevision: current.revision,
    deadlineDelta,
    ...(hasParent ? { parent: parent ?? null } : {}),
    ...(hasScreen ? { screenAttachment: screenAttachment ?? null } : {}),
  });
  assertAuthorized(result);
  return result;
}

export function clearTestTaskRuntime(
  manager: MeetingContextManager,
  scope: "all" | "parent" | "screen" = "all"
) {
  const state = manager.getTaskRuntimeState();
  const result = manager.clearTaskRuntime({
    id: nextTestMutationId(`clear-${scope}`),
    scope,
    reason: "test-clear-task-runtime",
    expectedRevision: state.revision,
  });
  assertAuthorized(result);
  return result;
}

function selectTestTransition(input: {
  beforeParent?: ActiveInterviewParent;
  afterParent?: ActiveInterviewParent;
  hasParent: boolean;
}): MeetingTaskRuntimeTransitionKind {
  const { beforeParent, afterParent, hasParent } = input;
  if (!hasParent) return "update-source-attachment";
  if (!beforeParent && afterParent) return "create-parent";
  if (
    beforeParent &&
    afterParent &&
    (beforeParent.id !== afterParent.id ||
      beforeParent.stableKind !== afterParent.stableKind)
  ) {
    return "replace-parent";
  }
  if (beforeParent && afterParent && !beforeParent.child && afterParent.child) {
    return "attach-child";
  }
  if (beforeParent?.child && afterParent && !afterParent.child) {
    return "resume-parent";
  }
  if (
    beforeParent &&
    afterParent &&
    beforeParent.playbookPhase !== afterParent.playbookPhase
  ) {
    return "set-phase";
  }
  return "update-parent-context";
}

function nextTestMutationId(label: string) {
  testMutationSequence += 1;
  return `test-task-runtime-${label}-${testMutationSequence}`;
}

function assertAuthorized(result: {
  authorized: boolean;
  reason: string;
}) {
  if (!result.authorized) {
    throw new Error(`Test task runtime mutation rejected: ${result.reason}`);
  }
}
