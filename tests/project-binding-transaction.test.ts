import assert from "node:assert/strict";
import test from "node:test";
import {
  commitProjectBindingSettlement,
} from "../src/lib/meeting/project-binding-transaction.js";
import type {
  ActiveInterviewParent,
  ProjectBindingDecision,
} from "../src/lib/meeting/types.js";

test("commits a project binding before model output", () => {
  const parent = makeParent();
  const result = commitProjectBindingSettlement({
    currentTask: parent,
    decision: makeDecision("bind", "agentic-memory", 1),
    expectedParentId: parent.id,
    expectedParentRevision: parent.revisions,
    now: 20,
  });

  assert.equal(result.committed, true);
  assert.equal(result.task?.projectBinding?.projectId, "agentic-memory");
  assert.equal(result.task?.revisions, 5);
  assert.equal(result.invalidateProjectState, false);
  assert.deepEqual(result.invalidatedState, []);
  assert.deepEqual(result.task?.supportedFactAnchors, parent.supportedFactAnchors);
  assert.deepEqual(result.task?.child, { ...parent.child, returnCapsule: undefined });
  assert.equal(result.task?.whiteboardArtifact, parent.whiteboardArtifact);
  assertPureParentPayload(result.task);
});

test("rebind invalidates stale project state atomically", () => {
  const parent = makeParent({
    projectBinding: makeDecision(
      "bind",
      "throttling",
      2
    ).binding,
  });
  const result = commitProjectBindingSettlement({
    currentTask: parent,
    decision: makeDecision("rebind", "agentic-memory", 3),
    expectedParentRevision: parent.revisions,
  });

  assert.equal(result.committed, true);
  assert.equal(result.task?.projectBinding?.projectId, "agentic-memory");
  assert.deepEqual(result.task?.supportedFactAnchors, []);
  assert.equal(result.task?.playbookPhase, "project_narrative");
  assert.equal(result.task?.child, undefined);
  assert.equal(result.task?.whiteboardArtifact, undefined);
  assert.equal(result.invalidateProjectState, true);
  assert.deepEqual(result.invalidatedState, [
    "supported-fact-anchors",
    "playbook-phase",
    "child",
    "whiteboard-artifact",
    "latest-answer",
    "previous-answer",
  ]);
  assertPureParentPayload(result.task);
});

test("invalidate exposes the same output clear decision as rebind", () => {
  const parent = makeParent({
    projectBinding: makeDecision("bind", "throttling", 2).binding,
  });
  const result = commitProjectBindingSettlement({
    currentTask: parent,
    decision: {
      ...makeDecision("rebind", "agentic-memory", 3),
      action: "invalidate",
      binding: undefined,
    },
    expectedParentRevision: parent.revisions,
  });

  assert.equal(result.committed, true);
  assert.equal(result.invalidateProjectState, true);
  assert.equal(result.task?.projectBinding, undefined);
  assert.deepEqual(result.task?.supportedFactAnchors, []);
  assert.equal(result.task?.child, undefined);
  assert.equal(result.task?.whiteboardArtifact, undefined);
  assert.deepEqual(result.task?.phaseProgress, {});
  assert.ok(result.invalidatedState.includes("latest-answer"));
  assert.ok(result.invalidatedState.includes("previous-answer"));
  assertPureParentPayload(result.task);
});

test("an already settled binding preserves output clear intent", () => {
  const decision = makeDecision("bind", "agentic-memory", 1);
  const parent = makeParent({ projectBinding: decision.binding });
  const result = commitProjectBindingSettlement({ currentTask: parent, decision });

  assert.equal(result.committed, false);
  assert.equal(result.reason, "binding-already-settled");
  assert.equal(result.invalidateProjectState, false);
  assert.deepEqual(result.invalidatedState, []);
  assertPureParentPayload(result.task);
});

test("rejects a stale parent revision", () => {
  const parent = makeParent();
  const result = commitProjectBindingSettlement({
    currentTask: parent,
    decision: makeDecision("bind", "agentic-memory", 1),
    expectedParentRevision: parent.revisions - 1,
  });

  assert.equal(result.committed, false);
  assert.equal(result.reason, "stale-parent-revision");
  assert.equal(result.task?.revisions, parent.revisions);
  assert.equal(result.invalidateProjectState, false);
  assert.deepEqual(result.invalidatedState, []);
  assertPureParentPayload(result.task);
});

test("a rejected rebind does not request output clearing", () => {
  const parent = makeParent();
  const result = commitProjectBindingSettlement({
    currentTask: parent,
    decision: makeDecision("rebind", "agentic-memory", 2),
    expectedParentRevision: parent.revisions - 1,
  });

  assert.equal(result.committed, false);
  assert.equal(result.invalidateProjectState, false);
  assert.deepEqual(result.invalidatedState, []);
});

function assertPureParentPayload(parent: ActiveInterviewParent | undefined) {
  assert.ok(parent);
  assert.equal("latestUsefulAnswer" in parent, false);
  assert.equal("previousUsefulAnswer" in parent, false);
  assert.equal("expiresAt" in parent, false);
  if (parent.child) assert.equal("compactSummary" in parent.child, false);
}

function makeDecision(
  action: "bind" | "rebind",
  projectId: string,
  revision: number
): ProjectBindingDecision {
  return {
    action,
    binding: {
      projectId,
      projectName:
        projectId === "agentic-memory"
          ? "Agentic Memory"
          : "Distributed Inference Throttling",
      primaryEntryId: `mem_${projectId}`,
      evidenceEntryIds: [`mem_${projectId}`],
      source: "interviewer-explicit",
      confidence: 1,
      lockedAt: 1,
      revision,
      reason: "test",
      authority: "interviewer-explicit",
      sourceTurnIds: ["turn_1"],
      sourceObservationIds: [],
    },
    candidates: [],
    changed: true,
    sourceAuthority: "interviewer-explicit",
    sourceTurnIds: ["turn_1"],
    sourceObservationIds: [],
    topicCompatible: true,
    bindingRevision: revision,
    reason: "test",
  };
}

function makeParent(
  overrides: Partial<ActiveInterviewParent> = {}
): ActiveInterviewParent {
  return {
    id: "parent_1",
    source: "voice",
    stableKind: "project-deep-dive",
    topic: "Project",
    canonicalQuestionSourceTurnIds: ["turn_1"],
    supportedFactAnchors: ["mem_old"],
    projectBinding: undefined,
    playbookPhase: "project_narrative",
    phaseProgress: { project_narrative: true },
    child: {
      id: "child_1",
      createdAt: 1,
      updatedAt: 1,
      questionType: "field-knowledge",
      relation: "child-probe",
      intent: "concept-probe",
      question: "What is memory consolidation?",
      basedOnTurnIds: ["turn_2"],
      basedOnObservationIds: [],
    },
    whiteboardArtifact: {
      id: "whiteboard_1",
      parentTaskId: "parent_1",
      domainTrack: "general_sd",
      archetypeIds: [],
      selectedOverlayIds: [],
      currentPhase: "project_narrative",
      content: "graph TD",
      title: "Architecture",
      summary: "Architecture",
      updateSource: "model-output",
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
    },
    createdAt: 1,
    updatedAt: 1,
    revisions: 4,
    ...overrides,
  };
}
