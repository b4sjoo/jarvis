import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import { coordinateOrderedSettlement } from "../src/lib/meeting/ordered-settlement-coordinator.js";
import { decideOrderedTaskRelationResolution } from "../src/lib/meeting/task-relation-split-shadow.js";

test("runs the existing matrix without a Relation handle for a first parent", () => {
  const decision = coordinateOrderedSettlement({
    sourceKind: "voice",
    currentQuestionType: "coding",
  });

  assert.equal(decision.stage, "no-parent-matrix");
  assert.equal(decision.relationHandleRequired, false);
  assert.equal(decision.relation.stage, "runtime-matrix");
  assert.equal(decision.relation.relation, "new-parent");
  assert.equal("responseOnly" in decision.relation, false);
});

test("projects a non-parent type to the no-parent null hypothesis", () => {
  const decision = coordinateOrderedSettlement({
    sourceKind: "voice",
    currentQuestionType: "unknown",
  });

  assert.equal(decision.stage, "no-parent-matrix");
  assert.equal(decision.relation.relation, undefined);
  assert.equal("responseOnly" in decision.relation, false);
});

test("keeps an already resolved Ordered Relation authoritative", () => {
  const ordered = decideOrderedTaskRelationResolution({
    sourceKind: "voice",
    currentQuestionType: "general-system-design",
    activeParentQuestionType: "general-system-design",
    hasActiveChild: false,
    parentAffinity: {
      schemaVersion: 1,
      affinityKind: "parent",
      decision: "related",
      confidence: 0.98,
      currentEvidenceSpans: ["same system"],
      branchEvidenceSpans: ["parent system"],
    },
    finalizeWithNullHypothesis: true,
  });
  const decision = coordinateOrderedSettlement({
    sourceKind: "voice",
    currentQuestionType: "general-system-design",
    activeMeetingTask: task(),
    orderedRelation: ordered,
  });

  assert.equal(decision.stage, "ordered-relation-result");
  assert.equal(decision.relation.relation, "followup-parent");
  assert.equal(decision.relation.reason, "same-type-parent-related");
});

test("uses the topology null hypothesis only after Ordered Relation is unavailable", () => {
  const decision = coordinateOrderedSettlement({
    sourceKind: "voice",
    currentQuestionType: "general-system-design",
    activeMeetingTask: task(),
  });

  assert.equal(decision.stage, "topology-null-hypothesis");
  assert.equal(decision.relation.stage, "source-topology-null-hypothesis");
  assert.equal(decision.relation.relation, "followup-parent");
});

test("uses an authoritative Screen milestone as the bounded new-parent fallback", () => {
  const decision = coordinateOrderedSettlement({
    sourceKind: "screen",
    currentQuestionType: "behavioral",
    activeMeetingTask: task(),
    screenBoundaryPrior: true,
    screenTypeEvidenceAuthorized: true,
  });

  assert.equal(decision.stage, "topology-null-hypothesis");
  assert.equal(decision.relation.relation, "new-parent");
  assert.equal(decision.relation.reason, "screen-milestone-new-parent");
});

function task(): ActiveMeetingTask {
  return {
    id: "parent-design",
    runtimeRevision: 1,
    source: "voice",
    parent: {
      id: "parent-design",
      questionType: "general-system-design",
      topic: "Design a URL shortener.",
      playbookPhase: "requirement_clarification",
      phaseProgress: {},
      supportedFactAnchors: [],
      revisions: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  };
}
