import assert from "node:assert/strict";
import test from "node:test";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import {
  reduceMeetingTaskRuntimeMutation,
  validateTaskTransitionFieldChanges,
  type MeetingTaskDeadlineDelta,
} from "../src/lib/meeting/active-meeting-task.js";
import type {
  ActiveInterviewParent,
  ActiveScreenTask,
} from "../src/lib/meeting/types.js";

function parent(overrides: Partial<ActiveInterviewParent> = {}): ActiveInterviewParent {
  return {
    id: "parent-1",
    source: "voice",
    stableKind: "ai-ml-system-design",
    topic: "Design retrieval",
    playbookPhase: "design_framing",
    phaseProgress: {},
    supportedFactAnchors: [],
    createdAt: 0,
    updatedAt: 0,
    revisions: 1,
    ...overrides,
  };
}

function screen(): ActiveScreenTask {
  return {
    id: "screen-1",
    observationId: "observation-1",
    basedOnObservationId: "observation-1",
    basedOnTurnIds: [],
    createdAt: 0,
    updatedAt: 0,
    kind: "coding",
    question: "Implement retrieval",
    content: "",
  };
}

function seed(overrides: Partial<ActiveInterviewParent> = {}) {
  const manager = new MeetingContextManager();
  manager.reset({ sessionId: "session-1" });
  const result = manager.commitTaskRuntimeTransition({
    id: "source-create",
    transition: "create-parent",
    reason: "source-created-parent",
    parent: parent(overrides),
    screenAttachment: screen(),
    deadlineDelta: {
      parent: { ownerId: "parent-1", deadline: 600_000 },
      screen: { ownerId: "screen-1", deadline: 600_000 },
    },
    appliedAt: 0,
  });
  assert.equal(result.authorized, true);
  return manager;
}

function prepareDeadline(manager: MeetingContextManager, deadlineDelta: MeetingTaskDeadlineDelta) {
  return manager.prepareTaskDeadlineUpdate({
    expectedSessionId: manager.getState().sessionId,
    deadlineDelta,
  });
}

test("TTL substrate: t60 + TTL600 installs deadline660 without task changes", (t) => {
  let clock = 0;
  t.mock.method(Date, "now", () => clock);
  const manager = seed();
  const before = manager.getTaskRuntimeState();
  clock = 60_000;
  const update = prepareDeadline(manager, {
    parent: { ownerId: "parent-1", deadline: Date.now() + 600_000 },
  });
  assert.equal(manager.getTaskDeadlineControl().parent?.deadline, 600_000);
  assert.deepEqual(manager.getTaskRuntimeState(), before);
  assert.equal(manager.installPreparedTaskDeadlineUpdate(update), true);
  assert.equal(manager.getTaskDeadlineControl().parent?.deadline, 660_000);
  assert.equal(manager.getTaskDeadlineControl().screen?.deadline, 600_000);
  assert.deepEqual(manager.getTaskRuntimeState(), before);
  assert.equal("expiresAt" in manager.getState().activeMeetingTask!.parent, false);
  assert.equal("expiresAt" in manager.getTaskRuntimeState().parent!, false);
});

test("TTL substrate: pending at t80 retains the deadline calculated at t60", (t) => {
  let clock = 0;
  t.mock.method(Date, "now", () => clock);
  const manager = seed();
  clock = 60_000;
  const update = prepareDeadline(manager, {
    screen: { ownerId: "screen-1", deadline: Date.now() + 600_000 },
  });
  const before = manager.getTaskRuntimeState();
  clock = 80_000;
  assert.equal(manager.getTaskDeadlineControl().screen?.deadline, 600_000);
  assert.equal(manager.installPreparedTaskDeadlineUpdate(update), true);
  assert.equal(manager.getTaskDeadlineControl().screen?.deadline, 660_000);
  assert.deepEqual(manager.getTaskRuntimeState(), before);
});

test("TTL substrate: unused preparation and no-renewal delta preserve deadlines", () => {
  const manager = seed();
  const before = manager.getTaskDeadlineControl();
  const unused = prepareDeadline(manager, {
    parent: { ownerId: "parent-1", deadline: 660_000 },
  });
  assert.equal(manager.rollbackPreparedTaskDeadlineUpdate(unused), true);
  assert.deepEqual(manager.getTaskDeadlineControl(), before);
  const noRenewal = prepareDeadline(manager, {});
  assert.equal(manager.installPreparedTaskDeadlineUpdate(noRenewal), true);
  assert.deepEqual(manager.getTaskDeadlineControl(), before);
  assert.equal(manager.rollbackPreparedTaskDeadlineUpdate(noRenewal), true);
  assert.deepEqual(manager.getTaskDeadlineControl(), before);
});

test("TTL substrate: manual shortening replaces only Screen; later authorized activity can extend", () => {
  const manager = seed();
  const before = manager.getTaskRuntimeState();
  const shortened = prepareDeadline(manager, {
    screen: { ownerId: "screen-1", deadline: 70_000 + 60_000 },
  });
  assert.equal(manager.installPreparedTaskDeadlineUpdate(shortened), true);
  assert.equal(manager.getTaskDeadlineControl().screen?.deadline, 130_000);
  assert.equal(manager.getTaskDeadlineControl().parent?.deadline, 600_000);
  // Candidate freshness remains the publication owner's responsibility. An old
  // pending candidate rejected there must never call the install primitive.
  const activity = prepareDeadline(manager, {
    screen: { ownerId: "screen-1", deadline: 200_000 },
  });
  assert.equal(manager.installPreparedTaskDeadlineUpdate(activity), true);
  assert.equal(manager.getTaskDeadlineControl().screen?.deadline, 200_000);
  assert.equal(manager.rollbackPreparedTaskDeadlineUpdate(shortened), false);
  assert.equal(manager.getTaskDeadlineControl().screen?.deadline, 200_000);
  assert.deepEqual(manager.getTaskRuntimeState(), before);
});

test("TTL substrate: real command merges into current control rather than its preparation snapshot", () => {
  const manager = seed();
  const before = manager.getTaskRuntimeState();
  const command = manager.prepareTaskRuntimeTransition({
    id: "source-facts",
    transition: "update-parent-context",
    reason: "source-facts",
    parent: { ...before.parent!, supportedFactAnchors: ["source-fact"], revisions: 2 },
    appliedAt: 61_000,
  });
  const output = prepareDeadline(manager, {
    parent: { ownerId: "parent-1", deadline: 660_000 },
  });
  assert.equal(manager.installPreparedTaskDeadlineUpdate(output), true);
  assert.equal(manager.commitPreparedTaskRuntimeTransition(command).authorized, true);
  assert.equal(manager.getTaskDeadlineControl().parent?.deadline, 660_000);
  assert.equal(manager.getTaskRuntimeState().revision, before.revision + 1);
  assert.equal(manager.rollbackPreparedTaskRuntimeTransition(command), true);
  assert.equal(manager.getTaskDeadlineControl().parent?.deadline, 660_000);
  assert.deepEqual(manager.getTaskRuntimeState(), before);
});

test("TTL substrate: output install after its own task install preserves untouched command deadline", () => {
  const manager = seed();
  const before = manager.getTaskRuntimeState();
  const command = manager.prepareTaskRuntimeTransition({
    id: "source-update",
    transition: "update-parent-context",
    reason: "source-update",
    parent: { ...before.parent!, supportedFactAnchors: ["fact"], revisions: 2 },
    deadlineDelta: { screen: { ownerId: "screen-1", deadline: 700_000 } },
    appliedAt: 60_000,
  });
  const output = prepareDeadline(manager, {
    parent: { ownerId: "parent-1", deadline: 660_000 },
  });
  assert.equal(manager.commitPreparedTaskRuntimeTransition(command).authorized, true);
  const acceptedTask = manager.getTaskRuntimeState();
  assert.equal(manager.installPreparedTaskDeadlineUpdate(output), true);
  assert.equal(manager.getTaskDeadlineControl().screen?.deadline, 700_000);
  assert.equal(manager.getTaskDeadlineControl().parent?.deadline, 660_000);
  assert.equal(manager.rollbackPreparedTaskDeadlineUpdate(output), true);
  assert.deepEqual(manager.getTaskRuntimeState(), acceptedTask);
  assert.equal(manager.getTaskDeadlineControl().screen?.deadline, 700_000);
  assert.equal(manager.getTaskDeadlineControl().parent?.deadline, 600_000);
  assert.equal(manager.rollbackPreparedTaskRuntimeTransition(command), true);
  assert.deepEqual(manager.getTaskRuntimeState(), before);
  assert.equal(manager.getTaskDeadlineControl().screen?.deadline, 600_000);
});

test("TTL substrate: deadline-only output cannot use a task command without its payload", () => {
  const manager = seed();
  const before = manager.getTaskRuntimeState();
  const result = manager.commitTaskRuntimeTransition({
    id: "authorized-renewal",
    transition: "update-parent-context",
    reason: "authorized-renewal",
    deadlineDelta: { parent: { ownerId: "parent-1", deadline: 660_000 } },
  });
  assert.equal(result.authorized, false);
  assert.equal(result.mutationApplied, false);
  assert.equal(manager.getTaskDeadlineControl().parent?.deadline, 600_000);
  assert.deepEqual(manager.getTaskRuntimeState(), before);
});

test("TTL substrate: same-clock manual command with unchanged payload still increments runtime revision", (t) => {
  t.mock.method(Date, "now", () => 70_000);
  const manager = seed();
  const before = manager.getTaskRuntimeState();
  const result = manager.commitTaskRuntimeTransition({
    id: "manual-timeout",
    transition: "update-source-attachment",
    reason: "manual-timeout",
    parent: before.parent,
    screenAttachment: before.screenAttachment,
    deadlineDelta: { screen: { ownerId: "screen-1", deadline: 130_000 } },
  });
  assert.equal(result.authorized, true);
  assert.equal(result.mutationApplied, true);
  assert.equal(manager.getTaskRuntimeState().revision, before.revision + 1);
  assert.deepEqual(manager.getTaskRuntimeState().parent, before.parent);
  assert.deepEqual(manager.getTaskRuntimeState().screenAttachment, before.screenAttachment);
  assert.equal(manager.getTaskDeadlineControl().screen?.deadline, 130_000);
});

test("TTL substrate: explicit deadline removal is scoped and rollback restores it", () => {
  const manager = seed();
  const before = manager.getTaskRuntimeState();
  const removal = prepareDeadline(manager, {
    parent: { ownerId: "parent-1", deadline: undefined },
  });
  assert.equal(manager.installPreparedTaskDeadlineUpdate(removal), true);
  assert.equal(manager.getTaskDeadlineControl().parent, undefined);
  assert.equal(manager.getTaskDeadlineControl().screen?.deadline, 600_000);
  assert.equal(manager.rollbackPreparedTaskDeadlineUpdate(removal), true);
  assert.equal(manager.getTaskDeadlineControl().parent?.deadline, 600_000);
  assert.deepEqual(manager.getTaskRuntimeState(), before);
});

test("TTL substrate: stale owner and invalid deadlines reject the whole update atomically", () => {
  const manager = seed();
  const before = manager.getTaskDeadlineControl();
  for (const delta of [
    { parent: { ownerId: "old-parent", deadline: 660_000 } },
    { parent: { ownerId: "parent-1", deadline: NaN } },
    { parent: { ownerId: "parent-1", deadline: Infinity } },
    {
      parent: { ownerId: "parent-1", deadline: 660_000 },
      screen: { ownerId: "old-screen", deadline: 660_000 },
    },
  ]) {
    assert.equal(manager.installPreparedTaskDeadlineUpdate(prepareDeadline(manager, delta)), false);
    assert.deepEqual(manager.getTaskDeadlineControl(), before);
  }
  const state = manager.getTaskRuntimeState();
  const result = manager.commitTaskRuntimeTransition({
    id: "invalid-owner-command",
    transition: "update-parent-context",
    reason: "invalid-owner-command",
    parent: { ...state.parent!, supportedFactAnchors: ["not-installed"] },
    deadlineDelta: { parent: { ownerId: "old-parent", deadline: 660_000 } },
  });
  assert.equal(result.authorized, false);
  assert.deepEqual(manager.getTaskRuntimeState(), state);
  assert.deepEqual(manager.getTaskDeadlineControl(), before);
});

test("TTL substrate: an older removal rollback cannot resurrect a later removed deadline", () => {
  const manager = seed();
  const removal = { parent: { ownerId: "parent-1", deadline: undefined } };
  const older = prepareDeadline(manager, removal);
  const newer = prepareDeadline(manager, removal);
  assert.equal(manager.installPreparedTaskDeadlineUpdate(older), true);
  assert.equal(manager.installPreparedTaskDeadlineUpdate(newer), true);
  assert.equal(manager.rollbackPreparedTaskDeadlineUpdate(older), false);
  assert.equal(manager.getTaskDeadlineControl().parent, undefined);
  assert.equal(manager.rollbackPreparedTaskDeadlineUpdate(newer), true);
  assert.equal(manager.rollbackPreparedTaskDeadlineUpdate(older), true);
  assert.equal(manager.getTaskDeadlineControl().parent?.deadline, 600_000);
});

test("TTL substrate: command rollback also preserves a later deadline removal", () => {
  const manager = seed();
  const before = manager.getTaskRuntimeState();
  const command = {
    id: "remove-timeout",
    transition: "update-parent-context" as const,
    reason: "manual-timeout-removal",
    parent: before.parent,
    deadlineDelta: { parent: { ownerId: "parent-1", deadline: undefined } },
  };
  const older = manager.prepareTaskRuntimeTransition(command);
  assert.equal(manager.commitPreparedTaskRuntimeTransition(older).authorized, true);
  const newer = prepareDeadline(manager, command.deadlineDelta);
  assert.equal(manager.installPreparedTaskDeadlineUpdate(newer), true);
  assert.equal(manager.rollbackPreparedTaskRuntimeTransition(older), false);
  assert.equal(manager.getTaskDeadlineControl().parent, undefined);
  assert.equal(manager.rollbackPreparedTaskDeadlineUpdate(newer), true);
  assert.equal(manager.rollbackPreparedTaskRuntimeTransition(older), true);
  assert.equal(manager.getTaskDeadlineControl().parent?.deadline, 600_000);
  assert.deepEqual(manager.getTaskRuntimeState(), before);
});

test("TTL substrate: new parent prunes the exited owner and accepts only its own deadline", () => {
  const manager = seed();
  const old = prepareDeadline(manager, {
    parent: { ownerId: "parent-1", deadline: 660_000 },
  });
  const next = prepareDeadline(manager, {
    parent: { ownerId: "parent-2", deadline: 700_000 },
  });
  assert.equal(manager.installPreparedTaskDeadlineUpdate(next), false);
  assert.equal(manager.commitTaskRuntimeTransition({
    id: "replace",
    transition: "replace-parent",
    reason: "new-source",
    parent: parent({ id: "parent-2" }),
  }).authorized, true);
  assert.equal(manager.getTaskDeadlineControl().parent, undefined);
  assert.equal(manager.getTaskDeadlineControl().screen?.deadline, 600_000);
  assert.equal(manager.installPreparedTaskDeadlineUpdate(old), false);
  assert.equal(manager.installPreparedTaskDeadlineUpdate(next), true);
  assert.equal(manager.getTaskDeadlineControl().parent?.ownerId, "parent-2");
});

test("TTL substrate: rollback preserves later writes, including an unrelated scope", () => {
  const manager = seed();
  const output = prepareDeadline(manager, {
    parent: { ownerId: "parent-1", deadline: 660_000 },
  });
  assert.equal(manager.installPreparedTaskDeadlineUpdate(output), true);
  assert.equal(manager.installPreparedTaskDeadlineUpdate(output), false);
  assert.equal(manager.installPreparedTaskDeadlineUpdate(prepareDeadline(manager, {
    screen: { ownerId: "screen-1", deadline: 130_000 },
  })), true);
  assert.equal(manager.rollbackPreparedTaskDeadlineUpdate(output), true);
  assert.equal(manager.getTaskDeadlineControl().parent?.deadline, 600_000);
  assert.equal(manager.getTaskDeadlineControl().screen?.deadline, 130_000);
  const sameScope = prepareDeadline(manager, {
    parent: { ownerId: "parent-1", deadline: 660_000 },
  });
  assert.equal(manager.installPreparedTaskDeadlineUpdate(sameScope), true);
  assert.equal(manager.installPreparedTaskDeadlineUpdate(prepareDeadline(manager, {
    parent: { ownerId: "parent-1", deadline: 660_000 },
  })), true);
  assert.equal(manager.rollbackPreparedTaskDeadlineUpdate(sameScope), false);
  assert.equal(manager.getTaskDeadlineControl().parent?.deadline, 660_000);
});

test("TTL substrate: parent and Screen expire independently with an active child and pure reads", (t) => {
  let clock = 0;
  t.mock.method(Date, "now", () => clock);
  for (const first of ["parent", "screen"] as const) {
    const manager = seed({
      child: {
        id: "child-1",
        createdAt: 0,
        updatedAt: 0,
        questionType: "coding",
        relation: "child-probe",
        intent: "implementation-probe",
        question: "Implement retrieval",
        basedOnTurnIds: [],
        basedOnObservationIds: [],
      },
    });
    const other = first === "parent" ? "screen" : "parent";
    assert.equal(manager.installPreparedTaskDeadlineUpdate(prepareDeadline(manager, {
      parent: { ownerId: "parent-1", deadline: first === "parent" ? 100 : 200 },
      screen: { ownerId: "screen-1", deadline: first === "screen" ? 100 : 200 },
    })), true);
    const before = manager.getTaskRuntimeState();
    clock = 100;
    for (let index = 0; index < 3; index += 1) {
      manager.getState();
      manager.getTaskDeadlineControl();
      manager.buildAdvisorPromptContext();
    }
    assert.deepEqual(manager.getTaskRuntimeState(), before);
    assert.equal(manager.clearExpiredActiveMeetingTask(99), false);
    assert.equal(manager.clearExpiredActiveMeetingTask(), true);
    assert.equal(manager.getTaskRuntimeState().revision, before.revision + 1);
    assert.equal(manager.getTaskRuntimeState().lastMutation?.kind, "expire");
    assert.equal(manager.getTaskDeadlineControl()[first], undefined);
    assert.equal(manager.getTaskDeadlineControl()[other]?.deadline, 200);
    assert.equal(Boolean(manager.getTaskRuntimeState().parent), first === "screen");
    assert.equal(Boolean(manager.getTaskRuntimeState().parent?.child), first === "screen");
    assert.equal(Boolean(manager.getTaskRuntimeState().screenAttachment), first === "parent");
    assert.equal(manager.clearExpiredActiveMeetingTask(), false);
    clock = 200;
    assert.equal(manager.clearExpiredActiveMeetingTask(), true);
    assert.equal(manager.getTaskRuntimeState().revision, before.revision + 2);
    assert.equal(manager.getState().activeMeetingTask, undefined);
    assert.equal(manager.getTaskDeadlineControl().parent, undefined);
    assert.equal(manager.getTaskDeadlineControl().screen, undefined);
  }
});

test("TTL substrate: Screen expiry retains existing clearing of Screen-sourced parent and child", () => {
  const manager = seed({
    source: "screen",
    child: {
      id: "child-1",
      createdAt: 0,
      updatedAt: 0,
      questionType: "coding",
      relation: "child-probe",
      intent: "implementation-probe",
      question: "Implement retrieval",
      basedOnTurnIds: [],
      basedOnObservationIds: [],
    },
  });
  assert.equal(manager.installPreparedTaskDeadlineUpdate(prepareDeadline(manager, {
    screen: { ownerId: "screen-1", deadline: 100 },
  })), true);
  assert.equal(manager.clearExpiredActiveMeetingTask(100), true);
  assert.equal(manager.getTaskRuntimeState().parent, undefined);
  assert.equal(manager.getTaskRuntimeState().screenAttachment, undefined);
  assert.equal(manager.getTaskDeadlineControl().parent, undefined);
  assert.equal(manager.getTaskDeadlineControl().screen, undefined);
});

test("TTL substrate: explicit expiration before late input rejects the expired owner's callback", () => {
  const manager = seed();
  const pending = prepareDeadline(manager, {
    parent: { ownerId: "parent-1", deadline: 700_000 },
  });
  assert.equal(manager.clearExpiredActiveMeetingTask(600_001), true);
  assert.equal(manager.commitTaskRuntimeTransition({
    id: "late-new-source",
    transition: "create-parent",
    reason: "new-source-after-expiration",
    parent: parent({ id: "parent-2", createdAt: 600_001, updatedAt: 600_001 }),
    deadlineDelta: { parent: { ownerId: "parent-2", deadline: 1_200_001 } },
    appliedAt: 600_001,
  }).authorized, true);
  assert.equal(manager.installPreparedTaskDeadlineUpdate(pending), false);
  assert.equal(manager.getTaskDeadlineControl().parent?.deadline, 1_200_001);
  assert.equal(manager.getTaskDeadlineControl().screen, undefined);
  assert.equal(manager.getTaskRuntimeState().revision, 3);
});

test("TTL substrate: expire reducer ignores mismatched owner control and handles deadline zero", () => {
  const manager = seed();
  const state = manager.getTaskRuntimeState();
  const wrongOwner = reduceMeetingTaskRuntimeMutation({
    state,
    mutation: {
      id: "expire-old-owner",
      kind: "expire",
      reason: "timer",
      now: 1_000_000,
      deadlineControl: { parent: { ownerId: "old-parent", deadline: 0 } },
    },
  });
  assert.equal(wrongOwner.mutationApplied, false);
  assert.deepEqual(wrongOwner.state, state);
  const zeroDeadline = reduceMeetingTaskRuntimeMutation({
    state,
    mutation: {
      id: "expire-zero",
      kind: "expire",
      reason: "timer",
      now: 0,
      appliedAt: 0,
      deadlineControl: { parent: { ownerId: "parent-1", deadline: 0 } },
    },
  });
  assert.equal(zeroDeadline.mutationApplied, true);
  assert.equal(zeroDeadline.state.parent, undefined);
  assert.equal(zeroDeadline.state.screenAttachment?.id, "screen-1");
  assert.equal(zeroDeadline.state.revision, state.revision + 1);
});

test("TTL substrate: clear prunes its established scope and rejects old callback resurrection", () => {
  for (const scope of ["parent", "screen", "all"] as const) {
    const manager = seed();
    const old = prepareDeadline(manager, {
      parent: { ownerId: "parent-1", deadline: 660_000 },
      screen: { ownerId: "screen-1", deadline: 660_000 },
    });
    assert.equal(manager.installPreparedTaskDeadlineUpdate(old), true);
    assert.equal(manager.clearTaskRuntime({ id: "clear", scope, reason: "manual" }).authorized, true);
    assert.equal(Boolean(manager.getTaskDeadlineControl().parent), scope === "screen");
    assert.equal(Boolean(manager.getTaskDeadlineControl().screen), scope === "parent");
    const afterClear = manager.getTaskDeadlineControl();
    assert.equal(manager.rollbackPreparedTaskDeadlineUpdate(old), false);
    assert.deepEqual(manager.getTaskDeadlineControl(), afterClear);
  }
});

test("TTL substrate: reset clears deadlines and rejects prior-session installs and rollbacks", () => {
  const manager = seed();
  const oldOutput = prepareDeadline(manager, {
    parent: { ownerId: "parent-1", deadline: 660_000 },
  });
  const oldCommand = manager.prepareTaskRuntimeTransition({
    id: "old-command",
    transition: "update-parent-context",
    reason: "old-command",
    parent: { ...manager.getTaskRuntimeState().parent!, updatedAt: 60_000 },
  });
  assert.equal(manager.commitPreparedTaskRuntimeTransition(oldCommand).authorized, true);
  assert.equal(manager.installPreparedTaskDeadlineUpdate(oldOutput), true);
  const pending = prepareDeadline(manager, {
    parent: { ownerId: "parent-1", deadline: 800_000 },
  });
  manager.reset({ sessionId: "session-2" });
  assert.equal(manager.getTaskRuntimeState().revision, 0);
  assert.equal(manager.getTaskDeadlineControl().parent, undefined);
  assert.equal(manager.getTaskDeadlineControl().screen, undefined);
  assert.equal(manager.rollbackPreparedTaskDeadlineUpdate(oldOutput), false);
  assert.equal(manager.rollbackPreparedTaskRuntimeTransition(oldCommand), false);
  assert.equal(manager.installPreparedTaskDeadlineUpdate(pending), false);
  assert.equal(manager.commitPreparedTaskRuntimeTransition(oldCommand).authorized, false);
  assert.equal(manager.commitTaskRuntimeTransition({
    id: "new-session-parent",
    transition: "create-parent",
    reason: "new-session",
    parent: parent(),
    deadlineDelta: { parent: { ownerId: "parent-1", deadline: 900_000 } },
  }).authorized, true);
  assert.equal(manager.installPreparedTaskDeadlineUpdate(pending), false);
  assert.equal(manager.getTaskDeadlineControl().parent?.deadline, 900_000);
});

test("TTL substrate: prepared inputs and read snapshots do not alias active deadlines", () => {
  const manager = seed();
  const delta = { parent: { ownerId: "parent-1", deadline: 660_000 } };
  const update = prepareDeadline(manager, delta);
  delta.parent.deadline = 1;
  const snapshot = manager.getTaskDeadlineControl();
  snapshot.parent!.deadline = 2;
  assert.equal(manager.getTaskDeadlineControl().parent?.deadline, 600_000);
  assert.equal(manager.installPreparedTaskDeadlineUpdate(update), true);
  update.deadlineDelta.parent!.deadline = 3;
  assert.equal(manager.getTaskDeadlineControl().parent?.deadline, 660_000);
});

test("TTL substrate: task update permissions no longer include payload expiresAt", () => {
  const before = parent();
  const after = { ...before, expiresAt: 660_000 };
  assert.equal(validateTaskTransitionFieldChanges({
    transition: "update-parent-context",
    beforeParent: before,
    afterParent: after,
  }), false);
  const beforeScreen = screen();
  const afterScreen = { ...beforeScreen, expiresAt: 660_000 };
  assert.equal(validateTaskTransitionFieldChanges({
    transition: "update-parent-context",
    beforeScreen,
    afterScreen,
  }), false);
});
