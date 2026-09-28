import assert from "node:assert/strict";
import test from "node:test";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import type { ActiveInterviewParent, ActiveInterviewChild, ProjectBindingDecision, SelectedInterviewPlaybook, WhiteboardArtifact } from "../src/lib/meeting/types.js";
import { setTestActiveParent } from "./helpers/meeting-task-runtime.js";
import { applyActiveBranchPhase, resolveEffectiveBranchPhase } from "../src/lib/meeting/active-branch-phase.js";
import { commitProjectBindingSettlement } from "../src/lib/meeting/project-binding-transaction.js";

function parent(): ActiveInterviewParent {
  return {
    id: "parent", source: "voice", stableKind: "general-system-design", topic: "Design a cache",
    playbookPhase: "requirement_clarification", phaseProgress: {}, supportedFactAnchors: [],
    createdAt: 1, updatedAt: 2, revisions: 1,
  };
}

for (const [field, value] of [
  ["stableKind", "coding"], ["playbookPhase", "project_QA"],
  ["topic", "A different question"], ["source", "screen"],
  ["createdAt", 99], ["originQuestionId", "other-question"],
  ["child", { id: "injected-child", questionType: "coding" }],
] as const) {
  test(`J2: real context writer rejects context-update mutation of ${field}`, () => {
    const manager = new MeetingContextManager();
    const before = parent();
    setTestActiveParent(manager, before);
    const snapshot = manager.getTaskRuntimeState();
    const result = manager.commitTaskRuntimeTransition({
      id: "context-update", transition: "update-parent-context", reason: "test-context-write",
      expectedRevision: snapshot.revision,
      parent: { ...before, revisions: 2, [field]: value } as ActiveInterviewParent,
    });
    assert.equal(result.authorized, false);
    assert.equal(result.reason, "invalid-transition");
    assert.deepEqual(manager.getTaskRuntimeState(), snapshot);
  });
}

test("J2: real phase writer rejects a phase transition with a hidden Type change", () => {
  const manager = new MeetingContextManager();
  const before = parent();
  setTestActiveParent(manager, before);
  const snapshot = manager.getTaskRuntimeState();
  const result = manager.commitTaskRuntimeTransition({
    id: "phase-update", transition: "set-phase", reason: "test-phase-write",
    expectedRevision: snapshot.revision,
    parent: { ...before, revisions: 2, playbookPhase: "project_QA", stableKind: "coding" },
  });
  assert.equal(result.authorized, false);
  assert.deepEqual(manager.getTaskRuntimeState(), snapshot);
});

function whiteboard(): WhiteboardArtifact {
  return {
    id: "whiteboard", parentTaskId: "parent", domainTrack: "general_sd", archetypeIds: [], selectedOverlayIds: [],
    currentPhase: "requirement_clarification", content: "graph TD; A-->B", title: "Cache", summary: "Cache",
    updateSource: "model-output", createdAt: 1, updatedAt: 2, revision: 1,
  };
}

function child(): ActiveInterviewChild {
  return {
    id: "child", createdAt: 1, updatedAt: 2, questionType: "coding", relation: "child-probe",
    intent: "implementation-probe", question: "Implement the cache", basedOnTurnIds: ["turn"], basedOnObservationIds: [],
    phaseState: { playbook: codingPlaybook(), phase: "baseline_reasoning", phaseProgress: {}, revision: 1 },
  };
}

function codingPlaybook(): SelectedInterviewPlaybook {
  return {
    id: "coding_algorithm", label: "Coding", phase: "baseline_reasoning", questionType: "coding",
    confidence: 1, reason: "fixture", memoryPolicy: { id: "coding" }, firstMove: "Clarify",
    clarifyingStrategy: "Constraints", outputContract: "Code", followUpPolicy: "Preserve",
  };
}

for (const field of ["latestUsefulAnswer", "previousUsefulAnswer"] as const) {
  for (const incrementRevision of [false, true]) {
    test(`Task176: generated ${field} cannot write Task Fields, revision increment=${incrementRevision}`, () => {
      const manager = new MeetingContextManager();
      const before = { ...parent(), whiteboardArtifact: whiteboard() };
      setTestActiveParent(manager, before);
      const snapshot = manager.getTaskRuntimeState();
      const candidate = {
        ...before,
        [field]: "Generated answer summary",
        updatedAt: 30,
        revisions: before.revisions + Number(incrementRevision),
      };
      const result = manager.commitTaskRuntimeTransition({
        id: "visible-answer", transition: "update-parent-context", reason: "generation-result-atomic-commit",
        parent: candidate, expectedRevision: snapshot.revision,
      });
      assert.equal(result.authorized, false);
      assert.equal(result.reason, "invalid-transition");
      assert.equal(result.mutationApplied, false);
      assert.deepEqual(manager.getTaskRuntimeState(), snapshot);
      assert.equal(field in manager.getTaskRuntimeState().parent!, false);
    });
  }
}

test("Task176: generated child summary cannot enter Task Fields alongside a legal artifact update", () => {
  const manager = new MeetingContextManager();
  const before = { ...parent(), child: child() };
  setTestActiveParent(manager, before);
  const snapshot = manager.getTaskRuntimeState();
  const candidate = {
    ...before, updatedAt: 30, revisions: before.revisions + 1,
    child: { ...before.child, updatedAt: 30, compactSummary: "New child summary", artifactId: "existing-artifact-ref" },
  };
  const result = manager.commitTaskRuntimeTransition({
    id: "child-summary", transition: "update-parent-context", reason: "advisor-answer-continuity-committed",
    expectedRevision: snapshot.revision, parent: candidate,
  });
  assert.equal(result.authorized, false);
  assert.equal(result.reason, "invalid-transition");
  assert.equal(result.mutationApplied, false);
  assert.deepEqual(manager.getTaskRuntimeState(), snapshot);
});

test("Task176: a real child artifact reference remains a legal context mutation", () => {
  const manager = new MeetingContextManager();
  const before = { ...parent(), child: child() };
  setTestActiveParent(manager, before);
  const snapshot = manager.getTaskRuntimeState();
  const candidate: ActiveInterviewParent = {
    ...before, updatedAt: 30, revisions: before.revisions + 1,
    child: { ...before.child, updatedAt: 30, artifactId: "existing-artifact-ref" },
  };
  const input = {
    id: "child-artifact", transition: "update-parent-context" as const, reason: "artifact-reference-committed",
    expectedRevision: snapshot.revision, parent: candidate,
  };
  const result = manager.commitTaskRuntimeTransition(input);
  assert.equal(result.authorized, true);
  assert.equal(result.mutationApplied, true);
  assert.equal(result.state.revision, snapshot.revision + 1);
  assert.equal(result.state.parent?.revisions, before.revisions + 1);
  assert.equal(result.state.parent?.child?.artifactId, "existing-artifact-ref");
  assert.deepEqual(result.state.parent?.child, {
    ...before.child, updatedAt: 30, artifactId: "existing-artifact-ref",
  });
  assert.equal("compactSummary" in result.state.parent!.child!, false);
  const duplicate = manager.commitTaskRuntimeTransition(input);
  assert.equal(duplicate.reason, "revision-mismatch");
  assert.equal(duplicate.authorized, false);
  assert.deepEqual(manager.getTaskRuntimeState(), result.state);
});

for (const mutation of ["identity", "type", "phase", "phase-extra-field"] as const) {
  test(`J2: context update rejects hidden child ${mutation}`, () => {
    const manager = new MeetingContextManager();
    const before = { ...parent(), child: child() };
    setTestActiveParent(manager, before);
    const snapshot = manager.getTaskRuntimeState();
    const nextChild = structuredClone(before.child);
    if (mutation === "identity") nextChild.id = "other-child";
    if (mutation === "type") nextChild.questionType = "field-knowledge";
    if (mutation === "phase") nextChild.phaseState!.phase = "implementation_validation";
    if (mutation === "phase-extra-field") Object.assign(nextChild.phaseState!, { unauthorized: true });
    const result = manager.commitTaskRuntimeTransition({
      id: "bad-child", transition: "update-parent-context", reason: "test", parent: { ...before, child: nextChild, revisions: 2 },
    });
    assert.equal(result.authorized, false);
    assert.deepEqual(manager.getTaskRuntimeState(), snapshot);
  });
}

for (const activeChild of [false, true]) {
  test(`J2: real Next/Back phase producer preserves non-target state, active child=${activeChild}`, () => {
    const manager = new MeetingContextManager();
    const before: ActiveInterviewParent = activeChild
      ? { ...parent(), child: child(), whiteboardArtifact: whiteboard() }
      : { ...parent(), stableKind: "coding", playbook: codingPlaybook(), playbookPhase: "baseline_reasoning" };
    setTestActiveParent(manager, before);
    for (const targetPhase of ["implementation_validation", "baseline_reasoning"] as const) {
      const snapshot = manager.getTaskRuntimeState();
      const current = snapshot.parent!;
      const owner = resolveEffectiveBranchPhase(current);
      assert.equal(owner.status, "resolved");
      if (owner.status !== "resolved") throw new Error("Expected phase owner");
      const candidate = applyActiveBranchPhase({ parent: current, owner: owner.view, targetPhase, phaseProgress: owner.view.phaseProgress, now: 30 });
      assert.ok(candidate);
      const result = manager.commitTaskRuntimeTransition({
        id: `phase-${targetPhase}`, transition: "set-phase", reason: "manual-phase", parent: candidate, expectedRevision: snapshot.revision,
      });
      assert.equal(result.authorized, true);
      assert.equal(result.state.parent?.stableKind, before.stableKind);
      assert.deepEqual(result.state.parent?.whiteboardArtifact, before.whiteboardArtifact);
      if (activeChild) {
        assert.equal(result.state.parent?.playbookPhase, before.playbookPhase);
        assert.equal(result.state.parent?.child?.phaseState?.phase, targetPhase);
      } else assert.equal(result.state.parent?.playbookPhase, targetPhase);
    }
  });
}

test("J2: same-phase progress updates retain child identity and are legal context changes", () => {
  const manager = new MeetingContextManager();
  const before = { ...parent(), child: child() };
  setTestActiveParent(manager, before);
  const owner = resolveEffectiveBranchPhase(before);
  assert.equal(owner.status, "resolved");
  if (owner.status !== "resolved") throw new Error("Expected child owner");
  const candidate = applyActiveBranchPhase({ parent: before, owner: owner.view, targetPhase: owner.view.phase, phaseProgress: { constraints: true }, now: 30 });
  const result = manager.commitTaskRuntimeTransition({ id: "progress", transition: "update-parent-context", reason: "phase-progress", parent: candidate });
  assert.equal(result.authorized, true);
  assert.deepEqual(result.state.parent?.child?.phaseState?.phaseProgress, { constraints: true });
});

for (const authorized of [false, true]) {
  test(`J2: actual writer requires explicit existing Whiteboard permission, authorized=${authorized}`, () => {
    const manager = new MeetingContextManager();
    const before = { ...parent(), whiteboardArtifact: whiteboard() };
    setTestActiveParent(manager, before);
    const snapshot = manager.getTaskRuntimeState();
    const result = manager.commitTaskRuntimeTransition({
      id: "whiteboard-update", transition: "update-parent-context", reason: "manual-artifact-regeneration",
      authorizedArtifacts: authorized ? ["whiteboard"] : ["answer"], expectedRevision: snapshot.revision,
      parent: { ...before, revisions: 2, whiteboardArtifact: { ...before.whiteboardArtifact, content: "graph TD; B-->C", revision: 2 } },
    });
    assert.equal(result.authorized, authorized);
    if (!authorized) assert.deepEqual(manager.getTaskRuntimeState(), snapshot);
    else assert.equal(manager.getTaskRuntimeState().parent?.whiteboardArtifact?.revision, 2);
  });
}

function bindingDecision(action: "bind" | "rebind" | "invalidate", revision: number): ProjectBindingDecision {
  return {
    action, binding: action === "invalidate" ? undefined : {
      projectId: `project-${revision}`, projectName: `Project ${revision}`, primaryEntryId: "entry", evidenceEntryIds: ["entry"],
      source: "interviewer-explicit", authority: "interviewer-explicit", sourceTurnIds: ["turn"], sourceObservationIds: [],
      confidence: 1, lockedAt: 1, revision, reason: "explicit selection",
    },
    candidates: [], changed: true, sourceAuthority: "interviewer-explicit", sourceTurnIds: ["turn"], sourceObservationIds: [],
    topicCompatible: true, bindingRevision: revision, reason: "explicit selection",
  };
}

for (const action of ["bind", "rebind", "invalidate"] as const) {
  test(`J2: real project ${action} producer reaches the writer with its authorized clearing semantics`, () => {
    const manager = new MeetingContextManager();
    const before: ActiveInterviewParent = {
      ...parent(), stableKind: "project-deep-dive", playbookPhase: "follow_up",
      playbook: { ...codingPlaybook(), questionType: "project-deep-dive", phase: "follow_up" },
      projectBinding: action === "bind" ? undefined : bindingDecision("bind", 1).binding,
      child: { ...child(), questionType: "field-knowledge", phaseState: undefined },
      supportedFactAnchors: ["old-fact"],
      whiteboardArtifact: whiteboard(),
    };
    setTestActiveParent(manager, before);
    const producer = commitProjectBindingSettlement({ currentTask: before, decision: bindingDecision(action, 2), now: 30 });
    assert.equal(producer.committed, true);
    assert.equal(producer.invalidateProjectState, action !== "bind");
    assert.equal(producer.invalidatedState.includes("latest-answer"), action !== "bind");
    assert.equal(producer.invalidatedState.includes("previous-answer"), action !== "bind");
    const result = manager.commitTaskRuntimeTransition({
      id: `project-${action}`, transition: "update-parent-context", reason: "project-binding-settlement-committed", parent: producer.task,
    });
    assert.equal(result.authorized, true);
    assert.deepEqual(result.state.parent, JSON.parse(JSON.stringify(producer.task)));
    if (action !== "bind") {
      assert.equal(result.state.parent?.child, undefined);
      assert.equal(result.state.parent?.playbookPhase, "project_summary");
    }
    assert.equal("latestUsefulAnswer" in result.state.parent!, false);
    assert.equal("previousUsefulAnswer" in result.state.parent!, false);
  });
}
