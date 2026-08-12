import assert from "node:assert/strict";
import test from "node:test";
import {
  cloneMeetingTaskRuntimeState,
  createMeetingTaskRuntimeState,
  projectActiveMeetingTask,
  reduceMeetingTaskRuntimeMutation,
} from "../src/lib/meeting/active-meeting-task.js";
import type {
  ActiveInterviewParent,
  ActiveScreenTask,
} from "../src/lib/meeting/types.js";

test("stores parent and screen attachment under one runtime revision", () => {
  const result = reduceMeetingTaskRuntimeMutation({
    state: createMeetingTaskRuntimeState(),
    mutation: {
      id: "mutation-1",
      kind: "commit-transition",
      transition: "create-parent",
      reason: "characterization",
      parent: parent(),
      screenAttachment: screen(),
      appliedAt: 100,
    },
  });

  assert.equal(result.authorized, true);
  assert.equal(result.mutationApplied, true);
  assert.equal(result.state.revision, 1);
  assert.equal(result.state.lastMutation?.id, "mutation-1");
  assert.equal(
    projectActiveMeetingTask({ state: result.state })?.parent.id,
    "parent-1"
  );
  assert.equal(
    projectActiveMeetingTask({ state: result.state })?.screen
      ?.activeScreenTaskId,
    "screen-1"
  );
});

test("rejects a stale runtime revision without partial mutation", () => {
  const initial = reduceMeetingTaskRuntimeMutation({
    state: createMeetingTaskRuntimeState(),
    mutation: {
      id: "mutation-1",
      kind: "commit-transition",
      transition: "create-parent",
      reason: "seed",
      parent: parent(),
    },
  }).state;
  const result = reduceMeetingTaskRuntimeMutation({
    state: initial,
    mutation: {
      id: "mutation-stale",
      kind: "commit-transition",
      transition: "update-source-attachment",
      reason: "stale",
      expectedRevision: 0,
      screenAttachment: screen(),
    },
  });

  assert.equal(result.authorized, false);
  assert.equal(result.reason, "revision-mismatch");
  assert.equal(result.state.revision, 1);
  assert.equal(result.state.screenAttachment, undefined);
  assert.equal(result.state.parent?.id, "parent-1");
});

test("clears a screen-owned parent atomically with its attachment", () => {
  const seeded = reduceMeetingTaskRuntimeMutation({
    state: createMeetingTaskRuntimeState(),
    mutation: {
      id: "mutation-1",
      kind: "commit-transition",
      transition: "create-parent",
      reason: "seed",
      parent: parent({ source: "screen" }),
      screenAttachment: screen(),
    },
  }).state;
  const result = reduceMeetingTaskRuntimeMutation({
    state: seeded,
    mutation: {
      id: "mutation-clear",
      kind: "clear",
      scope: "screen",
      reason: "manual-clear",
    },
  });

  assert.equal(result.state.revision, 2);
  assert.equal(result.state.parent, undefined);
  assert.equal(result.state.screenAttachment, undefined);
  assert.equal(projectActiveMeetingTask({ state: result.state }), undefined);
});

test("cloned runtime snapshots cannot mutate the canonical root", () => {
  const state = reduceMeetingTaskRuntimeMutation({
    state: createMeetingTaskRuntimeState(),
    mutation: {
      id: "mutation-1",
      kind: "commit-transition",
      transition: "create-parent",
      reason: "seed",
      parent: parent(),
      screenAttachment: screen(),
    },
  }).state;
  const snapshot = cloneMeetingTaskRuntimeState(state);

  snapshot.parent!.topic = "mutated";
  snapshot.screenAttachment!.content = "mutated";

  assert.equal(state.parent?.topic, "Design a URL shortener");
  assert.equal(state.screenAttachment?.content, "Answer");
});

test("expires parent and screen attachment through one runtime mutation", () => {
  const state = reduceMeetingTaskRuntimeMutation({
    state: createMeetingTaskRuntimeState(),
    mutation: {
      id: "mutation-1",
      kind: "commit-transition",
      transition: "create-parent",
      reason: "seed",
      parent: parent({ expiresAt: 50 }),
      screenAttachment: screen({ expiresAt: 50 }),
    },
  }).state;
  const result = reduceMeetingTaskRuntimeMutation({
    state,
    mutation: {
      id: "mutation-expire",
      kind: "expire",
      reason: "timer",
      now: 50,
    },
  });

  assert.equal(result.mutationApplied, true);
  assert.equal(result.state.parent, undefined);
  assert.equal(result.state.screenAttachment, undefined);
});

test("accepts a semantic phase command and rejects a mislabeled transition", () => {
  const state = reduceMeetingTaskRuntimeMutation({
    state: createMeetingTaskRuntimeState(),
    mutation: {
      id: "mutation-1",
      kind: "commit-transition",
      transition: "create-parent",
      reason: "seed",
      parent: parent(),
    },
  }).state;
  const phaseParent = parent({
    playbookPhase: "design_framing",
    revisions: 2,
  });
  const accepted = reduceMeetingTaskRuntimeMutation({
    state,
    mutation: {
      id: "phase-1",
      kind: "commit-transition",
      transition: "advance-phase",
      reason: "manual-next",
      parent: phaseParent,
    },
  });
  const rejected = reduceMeetingTaskRuntimeMutation({
    state,
    mutation: {
      id: "phase-invalid",
      kind: "commit-transition",
      transition: "attach-child",
      reason: "mislabeled",
      parent: phaseParent,
    },
  });

  assert.equal(accepted.authorized, true);
  assert.equal(accepted.state.parent?.playbookPhase, "design_framing");
  assert.equal(rejected.authorized, false);
  assert.equal(rejected.reason, "invalid-transition");
  assert.equal(rejected.state.parent?.playbookPhase, "requirement_clarification");
});

function parent(
  overrides: Partial<ActiveInterviewParent> = {}
): ActiveInterviewParent {
  return {
    id: "parent-1",
    source: "voice",
    stableKind: "general-system-design",
    topic: "Design a URL shortener",
    playbookPhase: "requirement_clarification",
    phaseProgress: {},
    supportedFactAnchors: [],
    createdAt: 1,
    updatedAt: 2,
    revisions: 1,
    ...overrides,
  };
}

function screen(
  overrides: Partial<ActiveScreenTask> = {}
): ActiveScreenTask {
  return {
    id: "screen-1",
    observationId: "observation-1",
    createdAt: 1,
    updatedAt: 2,
    question: "Design a URL shortener",
    kind: "general-system-design",
    content: "Answer",
    basedOnTurnIds: [],
    basedOnObservationId: "observation-1",
    ...overrides,
  };
}
