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
      parent: parent(),
      screenAttachment: screen(),
    },
  }).state;
  const result = reduceMeetingTaskRuntimeMutation({
    state,
    mutation: {
      id: "mutation-expire",
      kind: "expire",
      reason: "timer",
      now: 50,
      deadlineControl: {
        parent: { ownerId: "parent-1", deadline: 50 },
        screen: { ownerId: "screen-1", deadline: 50 },
      },
    },
  });

  assert.equal(result.mutationApplied, true);
  assert.equal(result.state.revision, state.revision + 1);
  assert.equal(result.state.lastMutation?.kind, "expire");
  assert.equal(result.state.parent, undefined);
  assert.equal(result.state.screenAttachment, undefined);
  assert.equal("expiresAt" in state.parent!, false);
  assert.equal("expiresAt" in state.screenAttachment!, false);
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
      transition: "set-phase",
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

test("allows only topology-compatible child attachments", () => {
  const state = reduceMeetingTaskRuntimeMutation({
    state: createMeetingTaskRuntimeState(),
    mutation: {
      id: "mutation-seed",
      kind: "commit-transition",
      transition: "create-parent",
      reason: "seed",
      parent: parent(),
    },
  }).state;
  const accepted = reduceMeetingTaskRuntimeMutation({
    state,
    mutation: {
      id: "mutation-child",
      kind: "commit-transition",
      transition: "attach-child",
      reason: "bounded-concept-probe",
      parent: parent({
        revisions: 2,
        child: child("field-knowledge"),
      }),
    },
  });

  assert.equal(accepted.authorized, true);
  assert.equal(accepted.mutationApplied, true);
  assert.equal(accepted.state.parent?.child?.questionType, "field-knowledge");
});

test("rejects same-type and unsupported child attachments without mutation", () => {
  const generalDesignState = reduceMeetingTaskRuntimeMutation({
    state: createMeetingTaskRuntimeState(),
    mutation: {
      id: "mutation-seed-design",
      kind: "commit-transition",
      transition: "create-parent",
      reason: "seed",
      parent: parent(),
    },
  }).state;
  const sameType = reduceMeetingTaskRuntimeMutation({
    state: generalDesignState,
    mutation: {
      id: "mutation-same-type-child",
      kind: "commit-transition",
      transition: "attach-child",
      reason: "invalid-same-type-child",
      parent: parent({
        revisions: 2,
        child: child("general-system-design"),
      }),
    },
  });
  const behavioralState = reduceMeetingTaskRuntimeMutation({
    state: createMeetingTaskRuntimeState(),
    mutation: {
      id: "mutation-seed-behavioral",
      kind: "commit-transition",
      transition: "create-parent",
      reason: "seed",
      parent: parent({ stableKind: "behavioral" }),
    },
  }).state;
  const unsupported = reduceMeetingTaskRuntimeMutation({
    state: behavioralState,
    mutation: {
      id: "mutation-unsupported-child",
      kind: "commit-transition",
      transition: "attach-child",
      reason: "invalid-behavioral-child",
      parent: parent({
        stableKind: "behavioral",
        revisions: 2,
        child: child("field-knowledge"),
      }),
    },
  });

  assert.equal(sameType.authorized, false);
  assert.equal(sameType.reason, "child-type-not-allowed");
  assert.equal(sameType.state.revision, generalDesignState.revision);
  assert.equal(sameType.state.parent?.child, undefined);
  assert.equal(unsupported.authorized, false);
  assert.equal(unsupported.reason, "child-type-not-allowed");
  assert.equal(unsupported.state.revision, behavioralState.revision);
  assert.equal(unsupported.state.parent?.child, undefined);
});

test("admits a childless Field Knowledge parent", () => {
  const fieldKnowledgeParent = {
    ...parent(),
    stableKind: "field-knowledge",
  } as unknown as ActiveInterviewParent;
  const result = reduceMeetingTaskRuntimeMutation({
    state: createMeetingTaskRuntimeState(),
    mutation: {
      id: "mutation-field-parent",
      kind: "commit-transition",
      transition: "create-parent",
      reason: "unreleased-field-parent",
      parent: fieldKnowledgeParent,
    },
  });

  assert.equal(result.authorized, true);
  assert.equal(result.reason, "committed");
  assert.equal(result.state.revision, 1);
  assert.equal(result.state.parent?.stableKind, "field-knowledge");
});

test("rejects every child attachment under a Field Knowledge parent", () => {
  const fieldKnowledgeParent = {
    ...parent(),
    stableKind: "field-knowledge",
  } as ActiveInterviewParent;
  const state = reduceMeetingTaskRuntimeMutation({
    state: createMeetingTaskRuntimeState(),
    mutation: {
      id: "mutation-field-parent",
      kind: "commit-transition",
      transition: "create-parent",
      reason: "standalone-field-knowledge",
      parent: fieldKnowledgeParent,
    },
  }).state;
  const result = reduceMeetingTaskRuntimeMutation({
    state,
    mutation: {
      id: "mutation-field-child",
      kind: "commit-transition",
      transition: "attach-child",
      reason: "field-parent-must-remain-childless",
      parent: {
        ...fieldKnowledgeParent,
        revisions: 2,
        child: child("coding"),
      },
    },
  });

  assert.equal(result.authorized, false);
  assert.equal(result.reason, "child-type-not-allowed");
  assert.equal(result.state.parent?.child, undefined);
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

function child(
  questionType: NonNullable<ActiveInterviewParent["child"]>["questionType"]
): NonNullable<ActiveInterviewParent["child"]> {
  return {
    id: `child-${questionType}`,
    createdAt: 2,
    updatedAt: 3,
    questionType,
    relation: "child-probe",
    intent: "concept-probe",
    question: "Bounded follow-up",
    basedOnTurnIds: ["turn-child"],
    basedOnObservationIds: [],
  };
}
