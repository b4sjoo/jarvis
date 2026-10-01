import assert from "node:assert/strict";
import test from "node:test";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import type { ActiveInterviewParent, ActiveScreenTask } from "../src/lib/meeting/types.js";
import type { TaskLifecycleCommand } from "../src/lib/meeting/meeting-task-contracts.js";

function fixture() {
  const manager = new MeetingContextManager();
  manager.reset({ sessionId: "command-session" });
  const before: ActiveInterviewParent = {
    id: "parent-a", source: "voice", stableKind: "general-system-design",
    topic: "Design a ride-sharing system", revisions: 3, playbookPhase: "requirement_clarification",
    phaseProgress: {}, supportedFactAnchors: [], createdAt: 1, updatedAt: 1,
  };
  assert.equal(manager.commitTaskRuntimeTransition({ id: "seed", transition: "create-parent", parent: before, reason: "fixture" }).authorized, true);
  const after = { ...before, stableKind: "ai-ml-system-design" as const, revisions: 4 };
  const command: TaskLifecycleCommand = { kind: "replace-parent", type: after.stableKind, topic: after.topic };
  return { manager, before, after, command };
}

for (const scenario of ["no-revision", "skipped-revision", "type", "topic", "screen-type"] as const) {
  test(`common manager rejects invalid correction command: ${scenario}`, () => {
    const { manager, before, after, command } = fixture();
    let screen: ActiveScreenTask | undefined;
    if (scenario === "no-revision") after.revisions = 3;
    if (scenario === "skipped-revision") after.revisions = 5;
    if (scenario === "type") command.type = "coding";
    if (scenario === "topic") command.topic = "What would you monitor in production?";
    if (scenario === "screen-type") screen = { id: "screen", observationId: "image", basedOnObservationId: "image",
      kind: "coding", question: "Implement a cache", content: "", basedOnTurnIds: [], createdAt: 1, updatedAt: 1 };
    const prepared = manager.prepareTaskRuntimeTransition({ id: "correct", transition: "replace-parent",
      command, parent: after, screenAttachment: screen, reason: "correction" });
    assert.equal(prepared.result.authorized, false);
    assert.equal(prepared.result.reason, scenario === "type" || scenario === "screen-type" ? "command-type-mismatch"
      : scenario === "topic" ? "command-topic-mismatch" : "command-transition-mismatch");
    assert.equal(manager.commitPreparedTaskRuntimeTransition(prepared).authorized, false);
    assert.deepEqual(manager.getTaskRuntimeState().parent, before);
  });
}

test("same-ID retype revision invariant also applies without a Plan command", () => {
  const { manager, after } = fixture();
  const result = manager.commitTaskRuntimeTransition({ id: "bad", transition: "replace-parent",
    parent: { ...after, revisions: 3 }, reason: "unplanned" });
  assert.equal(result.authorized, false);
  assert.equal(result.reason, "invalid-transition");
});

test("common prepare validates once and commit installs that candidate exactly once", () => {
  const { manager, after, command } = fixture();
  const prepared = manager.prepareTaskRuntimeTransition({ id: "valid", transition: "replace-parent", command, parent: after, reason: "correct" });
  assert.equal(prepared.result.authorized, true);
  assert.equal(manager.getTaskRuntimeState().parent!.stableKind, "general-system-design");
  assert.strictEqual(manager.commitPreparedTaskRuntimeTransition(prepared), prepared.result);
  assert.deepEqual(manager.getTaskRuntimeState().parent, after);
  assert.equal(manager.commitPreparedTaskRuntimeTransition(prepared).authorized, false);
});

test("different-owner replacement can start at revision1", () => {
  const { manager, after, command } = fixture();
  const replacement = { ...after, id: "parent-b", revisions: 1 };
  assert.equal(manager.commitTaskRuntimeTransition({ id: "new", transition: "replace-parent", command,
    parent: replacement, reason: "independent" }).authorized, true);
});
