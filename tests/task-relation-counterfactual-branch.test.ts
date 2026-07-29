import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTaskRelationCounterfactualBranchV1,
  type TaskRelationCounterfactualBranchInputV1,
  type TaskRelationCounterfactualOperationV1,
} from "../src/lib/meeting/task-relation-counterfactual-branch.js";

const source = {
  manifestHash: "manifest-relation-a",
  recordingSchemaVersion: 7,
  traceSummaryVersion: 30,
};

function parent(revision = 4) {
  return {
    id: "parent-ride-sharing",
    revision,
    questionType: "general-system-design",
    topic: "Design a ride-sharing system",
    phase: "high_level_design",
  };
}

function operation(
  overrides: Partial<TaskRelationCounterfactualOperationV1> &
    Pick<
      TaskRelationCounterfactualOperationV1,
      "operationId" | "occurredAt" | "candidateRelation"
    >
): TaskRelationCounterfactualOperationV1 {
  return {
    schemaVersion: 1,
    sessionId: "session-relation-a",
    logicalQuestionUnitId: `lqu-${overrides.operationId}`,
    logicalQuestionRevision: 1,
    semanticValidity: "valid",
    productionApplicability: "applicable",
    admission: "reviewed-shadow",
    sourceParentId: "parent-ride-sharing",
    questionType: "field-knowledge",
    topic: "Explain consistent hashing",
    traceId: `trace-${overrides.operationId}`,
    sourceTurnIds: [`turn-${overrides.operationId}`],
    ...overrides,
  };
}

function input(
  operations: TaskRelationCounterfactualOperationV1[]
): TaskRelationCounterfactualBranchInputV1 {
  return {
    schemaVersion: 1,
    sessionId: "session-relation-a",
    initialState: { parent: parent() },
    source,
    operations,
    knownSourceRefs: operations.flatMap((item) => [
      `trace:${item.traceId}`,
      ...(item.sourceTurnIds ?? []).map((id) => `turn:${id}`),
    ]),
    generatedAt: 100,
  };
}

test("replays a reviewed child proposal followed by a shadow-only resume", () => {
  const child = operation({
    operationId: "child",
    occurredAt: 10,
    candidateRelation: "child-probe",
    confidence: 0.95,
  });
  const resume = operation({
    operationId: "resume",
    occurredAt: 20,
    candidateRelation: "resume-parent",
    productionApplicability: "inapplicable",
    questionType: undefined,
    topic: undefined,
    confidence: 0.97,
  });

  const branch = buildTaskRelationCounterfactualBranchV1(
    input([resume, child])
  );

  assert.deepEqual(
    branch.operationResults.map((item) => [
      item.operationId,
      item.productionApplicability,
      item.counterfactualShadowApplicability,
      item.status,
    ]),
    [
      ["child", "applicable", "applicable", "applied"],
      ["resume", "inapplicable", "applicable", "applied"],
    ]
  );
  assert.deepEqual(
    branch.graph.transitions.map((item) => item.kind),
    ["child-probe", "resume-parent"]
  );
  assert.equal(branch.graph.metrics.counterfactualTransitionCount, 2);
  assert.equal(branch.finalState.parent?.id, "parent-ride-sharing");
  assert.equal(branch.finalState.parent?.revision, 6);
  assert.equal(branch.finalState.child, undefined);
});

test("keeps resume inapplicable when no reviewed branch child exists", () => {
  const resume = operation({
    operationId: "resume-only",
    occurredAt: 10,
    candidateRelation: "resume-parent",
    productionApplicability: "inapplicable",
    questionType: undefined,
    topic: undefined,
  });

  const branch = buildTaskRelationCounterfactualBranchV1(input([resume]));

  assert.equal(branch.events.length, 0);
  assert.equal(
    branch.operationResults[0]?.counterfactualShadowApplicability,
    "inapplicable"
  );
  assert.equal(
    branch.operationResults[0]?.reason,
    "resume-requires-counterfactual-child"
  );
  assert.deepEqual(branch.finalState, { parent: parent() });
});

test("rejects stale, invalid, and unreviewed proposals without graph mutation", () => {
  const branch = buildTaskRelationCounterfactualBranchV1(
    input([
      operation({
        operationId: "stale",
        occurredAt: 10,
        candidateRelation: "child-probe",
        stale: true,
      }),
      operation({
        operationId: "invalid",
        occurredAt: 20,
        candidateRelation: "new-parent",
        semanticValidity: "invalid",
      }),
      operation({
        operationId: "unreviewed",
        occurredAt: 30,
        candidateRelation: "child-probe",
        admission: "unreviewed",
      }),
    ])
  );

  assert.equal(branch.events.length, 0);
  assert.deepEqual(
    branch.operationResults.map((item) => item.reason),
    [
      "stale-operation",
      "semantic-candidate-invalid",
      "unreviewed-shadow-proposal",
    ]
  );
  assert.ok(
    branch.operationResults.every(
      (item) =>
        item.counterfactualShadowApplicability === "not-evaluated"
    )
  );
});

test("creates deterministic human-expected parent transitions without mutating input", () => {
  const newParent = operation({
    operationId: "human-new-parent",
    occurredAt: 10,
    candidateRelation: "new-parent",
    admission: "human-expected",
    questionType: "coding",
    topic: "Implement an LRU cache",
  });
  const branchInput = input([newParent]);
  const original = structuredClone(branchInput);

  const first = buildTaskRelationCounterfactualBranchV1(branchInput);
  const second = buildTaskRelationCounterfactualBranchV1(branchInput);

  assert.equal(first.branchId, second.branchId);
  assert.equal(first.events[0]?.stream, "human-expected");
  assert.equal(first.events[0]?.status, "proposed");
  assert.equal(first.events[0]?.counterfactualEligible, true);
  assert.equal(first.finalState.parent?.questionType, "coding");
  assert.equal(first.finalState.parent?.topic, "Implement an LRU cache");
  assert.deepEqual(branchInput, original);
});

test("records followup-parent as applicable without inventing a graph transition", () => {
  const followup = operation({
    operationId: "followup",
    occurredAt: 10,
    candidateRelation: "followup-parent",
    topic: "How does surge pricing change the write path?",
  });

  const branch = buildTaskRelationCounterfactualBranchV1(
    input([followup])
  );

  assert.equal(branch.events.length, 0);
  assert.equal(branch.operationResults[0]?.status, "state-preserved");
  assert.equal(
    branch.operationResults[0]?.counterfactualShadowApplicability,
    "applicable"
  );
  assert.deepEqual(branch.finalState, branch.initialState);
});

test("fails closed when the proposal source parent diverges from the branch", () => {
  const mismatched = operation({
    operationId: "wrong-parent",
    occurredAt: 10,
    candidateRelation: "child-probe",
    sourceParentId: "parent-food-delivery",
  });

  const branch = buildTaskRelationCounterfactualBranchV1(
    input([mismatched])
  );

  assert.equal(branch.events.length, 0);
  assert.equal(
    branch.operationResults[0]?.reason,
    "source-parent-diverged"
  );
  assert.equal(
    branch.operationResults[0]?.counterfactualShadowApplicability,
    "inapplicable"
  );
});

test("fails closed on missing lineage and duplicate operation identities", () => {
  const missingLineage = operation({
    operationId: "missing-lineage",
    occurredAt: 5,
    candidateRelation: "followup-parent",
    sourceParentId: undefined,
  });
  const duplicate = operation({
    operationId: "duplicate",
    occurredAt: 10,
    candidateRelation: "child-probe",
  });

  const branch = buildTaskRelationCounterfactualBranchV1(
    input([missingLineage, duplicate, { ...duplicate }])
  );

  assert.equal(branch.events.length, 0);
  assert.deepEqual(
    branch.operationResults.map((item) => item.reason),
    [
      "missing-source-parent-id",
      "duplicate-operation-id",
      "duplicate-operation-id",
    ]
  );
});

test("uses operation time, sequence, and revision for stable replay order", () => {
  const first = operation({
    operationId: "first",
    occurredAt: 10,
    sequence: 1,
    candidateRelation: "followup-parent",
  });
  const second = operation({
    operationId: "second",
    occurredAt: 10,
    sequence: 2,
    candidateRelation: "followup-parent",
  });

  const branch = buildTaskRelationCounterfactualBranchV1(
    input([second, first])
  );

  assert.deepEqual(
    branch.operationResults.map((item) => item.operationId),
    ["first", "second"]
  );
});
