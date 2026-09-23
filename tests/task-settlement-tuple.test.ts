import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateTaskSettlementTupleCompatibilityV2,
  projectObservedParentAction,
  type CommittedLifecycleEvidence,
} from "../src/lib/meeting/task-settlement-tuple.js";

function project(evidence: CommittedLifecycleEvidence) {
  return projectObservedParentAction({
    relation: "child-probe",
    mutationAuthorized: true,
    committedLifecycleEvidence: evidence,
    currentOnly: false,
  });
}

test("projects a first child attachment as attach-child", () => {
  assert.equal(
    project({
      command: "attach-child",
      parentBeforeId: "parent-1",
      parentAfterId: "parent-1",
      childAfterId: "child-1",
      authority: "source-transition-durable-receipt",
    }),
    "attach-child"
  );
});

test("projects an idempotent same-child upsert as preserve", () => {
  assert.equal(
    project({
      command: "attach-child",
      parentBeforeId: "parent-1",
      parentAfterId: "parent-1",
      childBeforeId: "child-1",
      childAfterId: "child-1",
      authority: "source-transition-durable-receipt",
    }),
    "preserve"
  );
});

test("projects a different child attachment as attach-child", () => {
  assert.equal(
    project({
      command: "attach-child",
      parentBeforeId: "parent-1",
      parentAfterId: "parent-1",
      childBeforeId: "child-1",
      childAfterId: "child-2",
      authority: "source-transition-durable-receipt",
    }),
    "attach-child"
  );
});

test("accepts a same-parent retype for a related follow-up", () => {
  assert.deepEqual(
    evaluateTaskSettlementTupleCompatibilityV2({
      relation: "followup-parent",
      parentAction: "retype",
    }),
    {
      compatible: true,
      relation: "followup-parent",
      parentAction: "retype",
      recommendedParentAction: "preserve",
      reason: undefined,
    }
  );
});

test("A1: none accepts a confirmed preserve without recommending it away", () => {
  for (const parentAction of ["none", "preserve"] as const) {
    const tuple = evaluateTaskSettlementTupleCompatibilityV2({ relation: "none", parentAction });
    assert.equal(tuple.compatible, true);
    assert.equal(tuple.recommendedParentAction, parentAction);
  }
});
