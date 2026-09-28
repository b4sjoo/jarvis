import assert from "node:assert/strict";
import test from "node:test";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import {
  commitSourceOwnedTransitionToRuntime,
  prepareSourceOwnedRuntimeTransition,
  resolveSourceOwnedRuntimeTransition,
  sourceOwnedTransitionDurableMutationApplied,
  sourceOwnedTransitionDurablySatisfied,
} from "../src/lib/meeting/source-owned-transition-runtime.js";
import { createSourceOwnedTransitionCandidate } from "../src/lib/meeting/source-owned-transition-transaction.js";
import type { ActiveInterviewParent } from "../src/lib/meeting/types.js";

function fixture() {
  const manager = new MeetingContextManager();
  manager.reset({ sessionId: "preparation-session" });
  const parent: ActiveInterviewParent = { id: "parent", source: "voice", stableKind: "general-system-design",
    topic: "Design the serving system.", playbookPhase: "design_framing", phaseProgress: {}, supportedFactAnchors: [],
    createdAt: 1, updatedAt: 1, revisions: 1 };
  manager.commitTaskRuntimeTransition({ id: "parent", transition: "create-parent", parent, reason: "fixture" });
  manager.commitTaskRuntimeTransition({ id: "child", transition: "attach-child", reason: "fixture", parent: {
    ...parent, revisions: 2, child: { id: "child", questionType: "field-knowledge", relation: "child-probe", intent: "concept-probe",
      question: "Explain HNSW.", basedOnTurnIds: ["child-source"], basedOnObservationIds: [], createdAt: 2, updatedAt: 2 },
  } });
  const runtimeBefore = manager.getTaskRuntimeState();
  const candidate = createSourceOwnedTransitionCandidate({ sessionId: "preparation-session", runtimeEpoch: 1,
    source: "voice", sourceTurnIds: ["resume-source"], existingTask: runtimeBefore.parent,
    relation: "resume-parent", authoritySource: "manual-correction", mutationAuthorized: true,
    questionType: "general-system-design", question: "Return to the serving system.", now: 3 });
  assert.ok(candidate);
  const input = { candidate, runtimeBefore, expectedTaskRuntimeRevision: runtimeBefore.revision,
    currentSessionId: "preparation-session", currentRuntimeEpoch: 1, now: 4 };
  return { manager, input };
}

test("canonical pure preparation creates only a proposal; the existing runtime commit owns durable success", () => {
  const { manager, input } = fixture();
  const before = manager.getTaskRuntimeState();
  const candidateBefore = JSON.stringify(input.candidate);
  const prepared = prepareSourceOwnedRuntimeTransition(input);
  assert.equal(prepared.readyToCommit, true);
  assert.equal(prepared.sourceResult.task!.child, undefined);
  assert.deepEqual(manager.getTaskRuntimeState(), before);
  assert.equal(JSON.stringify(input.candidate), candidateBefore);
  assert.equal(sourceOwnedTransitionDurableMutationApplied(prepared), false);
  assert.equal(sourceOwnedTransitionDurablySatisfied(prepared), false);

  let writerCalls = 0;
  const receipt = commitSourceOwnedTransitionToRuntime({ ...input, commitRuntime: ({ sourceResult, runtimeBefore, expectedTaskRuntimeRevision }) => {
    writerCalls++;
    const runtimeTransition = resolveSourceOwnedRuntimeTransition({ sourceResult, runtimeBefore });
    const runtimeResult = manager.commitTaskRuntimeTransition({ id: "real-resume", transition: runtimeTransition,
      expectedRevision: expectedTaskRuntimeRevision, parent: sourceResult.task, reason: "real-writer" });
    return { runtimeResult, runtimeTransition };
  } });
  assert.equal(writerCalls, 1);
  assert.equal(sourceOwnedTransitionDurableMutationApplied(receipt), true);
  assert.equal(manager.getTaskRuntimeState().parent!.child, undefined);
  assert.equal(manager.getTaskRuntimeState().revision, before.revision + 1);
});

test("canonical preparation and original commit reject the same stale revision without calling a writer", () => {
  const { manager, input } = fixture();
  const before = manager.getTaskRuntimeState();
  const stale = { ...input, expectedTaskRuntimeRevision: input.expectedTaskRuntimeRevision - 1 };
  const prepared = prepareSourceOwnedRuntimeTransition(stale);
  assert.equal(prepared.readyToCommit, false);
  assert.equal(prepared.reason, "task-runtime-revision-mismatch");
  const receipt = commitSourceOwnedTransitionToRuntime({ ...stale, commitRuntime: () => { throw new Error("stale preparation reached writer"); } });
  assert.equal(receipt.reason, prepared.reason);
  assert.equal(receipt.runtimeResult, undefined);
  assert.deepEqual(manager.getTaskRuntimeState(), before);
});

test("canonical pure preparation does not authorize an old parent or another session", () => {
  const { manager, input } = fixture();
  const before = manager.getTaskRuntimeState();
  const oldParent = prepareSourceOwnedRuntimeTransition({ ...input, candidate: { ...input.candidate, expectedParentId: "retired-parent" } });
  assert.equal(oldParent.readyToCommit, false);
  assert.equal(oldParent.reason, "parent-id-mismatch");
  const otherSession = prepareSourceOwnedRuntimeTransition({ ...input, currentSessionId: "other-session" });
  assert.equal(otherSession.readyToCommit, false);
  assert.equal(otherSession.reason, "session-mismatch");
  assert.deepEqual(manager.getTaskRuntimeState(), before);
});
