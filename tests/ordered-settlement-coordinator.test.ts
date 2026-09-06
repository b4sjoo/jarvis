import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import {
  coordinateOrderedSettlement,
  createOrderedRelationPhaseBudget,
  createOrderedSettlementDeadline,
  createOrderedSettlementReleaseGate,
  readOrderedRelationAffinityRemainingMs,
  readOrderedSettlementRemainingMs,
} from "../src/lib/meeting/ordered-settlement-coordinator.js";
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

test("shares one absolute deadline across ordered settlement stages", () => {
  const deadline = createOrderedSettlementDeadline({
    startedAt: 1_000,
    budgetMs: 4_000,
  });

  assert.deepEqual(deadline, {
    startedAt: 1_000,
    deadlineAt: 5_000,
    budgetMs: 4_000,
  });
  assert.equal(readOrderedSettlementRemainingMs(deadline, 2_200), 2_800);
  assert.equal(readOrderedSettlementRemainingMs(deadline, 5_100), 0);
});

test("reserves one bounded Canonical window inside the shared relation deadline", () => {
  const voiceDeadline = createOrderedSettlementDeadline({
    startedAt: 1_000,
    budgetMs: 4_000,
  });
  const screenDeadline = createOrderedSettlementDeadline({
    startedAt: 1_000,
    budgetMs: 7_000,
  });

  const voicePhase = createOrderedRelationPhaseBudget(voiceDeadline);
  const screenPhase = createOrderedRelationPhaseBudget(screenDeadline);

  assert.deepEqual(voicePhase, {
    affinityCutoffAt: 3_000,
    canonicalReserveMs: 2_000,
  });
  assert.deepEqual(screenPhase, {
    affinityCutoffAt: 6_000,
    canonicalReserveMs: 2_000,
  });
  assert.equal(readOrderedRelationAffinityRemainingMs(voicePhase, 2_500), 500);
  assert.equal(readOrderedRelationAffinityRemainingMs(voicePhase, 3_100), 0);
});

test("releases one canonical child result before the shared deadline", () => {
  const deadline = createOrderedSettlementDeadline({
    startedAt: 1_000,
    budgetMs: 4_000,
  });
  const gate = createOrderedSettlementReleaseGate(deadline);
  const canonical = decideOrderedTaskRelationResolution({
    sourceKind: "voice",
    currentQuestionType: "coding",
    activeParentQuestionType: "ai-ml-system-design",
    hasActiveChild: false,
    canonical: {
      schemaVersion: 3,
      relation: "child-probe",
      confidence: 0.95,
      currentQuestionEvidenceSpans: ["implement the merge function"],
      parentEvidenceSpans: ["enterprise RAG system"],
    },
  });

  const canonicalRelease = gate.tryRelease({
    source: "settled",
    at: 4_400,
  });
  const deadlineRelease = gate.tryRelease({
    source: "deadline",
    at: 5_000,
  });

  assert.equal(canonical.relation, "child-probe");
  assert.equal(canonicalRelease.accepted, true);
  assert.equal(deadlineRelease.accepted, false);
  assert.equal(deadlineRelease.reason, "already-released");
  assert.equal(gate.readReceipt()?.source, "settled");
});

test("rejects a late canonical result and releases the deadline fallback once", () => {
  const deadline = createOrderedSettlementDeadline({
    startedAt: 1_000,
    budgetMs: 4_000,
  });
  const gate = createOrderedSettlementReleaseGate(deadline);

  const lateCanonical = gate.tryRelease({
    source: "settled",
    at: 5_100,
  });
  const fallback = gate.tryRelease({
    source: "deadline",
    at: 5_100,
  });
  const duplicate = gate.tryRelease({
    source: "settled",
    at: 5_200,
  });

  assert.equal(lateCanonical.accepted, false);
  assert.equal(lateCanonical.reason, "settled-after-deadline");
  assert.equal(fallback.accepted, true);
  assert.equal(duplicate.accepted, false);
  assert.equal(gate.readReceipt()?.source, "deadline");
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

test("settles a fresh Coding LQU as a child of a related AI/ML parent", () => {
  const activeMeetingTask = task("ai-ml-system-design");
  const ordered = decideOrderedTaskRelationResolution({
    sourceKind: "voice",
    currentQuestionType: "coding",
    activeParentQuestionType: "ai-ml-system-design",
    hasActiveChild: false,
    parentAffinity: {
      schemaVersion: 1,
      affinityKind: "parent",
      decision: "related",
      confidence: 0.95,
      currentEvidenceSpans: ["Within this RAG system"],
      branchEvidenceSpans: ["Design a RAG system for enterprise search"],
    },
    finalizeWithNullHypothesis: true,
  });
  const decision = coordinateOrderedSettlement({
    sourceKind: "voice",
    currentQuestionType: "coding",
    activeMeetingTask,
    orderedRelation: ordered,
  });

  assert.equal(decision.relation.relation, "child-probe");
  assert.equal(decision.relation.reason, "allowed-child-parent-related");
});

function task(
  questionType: ActiveMeetingTask["parent"]["questionType"] =
    "general-system-design"
): ActiveMeetingTask {
  return {
    id: "parent-design",
    runtimeRevision: 1,
    source: "voice",
    parent: {
      id: "parent-design",
      questionType,
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
