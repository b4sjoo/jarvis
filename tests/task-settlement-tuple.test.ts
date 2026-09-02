import assert from "node:assert/strict";
import test from "node:test";

import {
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
