import assert from "node:assert/strict";
import test from "node:test";
import {
  scoreSemanticInterviewerIntentEmbeddings,
} from "../src/lib/meeting/semantic-interviewer-intent-resolver.js";

test("multi-head semantic intent scores each axis independently", () => {
  const decision = scoreSemanticInterviewerIntentEmbeddings({
    unitEmbedding: [1, 0],
    relationEmbedding: [0, 1],
    activeParentAvailable: true,
  });

  assert.equal(decision.schemaVersion, 1);
  assert.equal(typeof decision.speechAct.accepted, "boolean");
  assert.equal(typeof decision.relation.accepted, "boolean");
  assert.equal(typeof decision.evidenceMode.accepted, "boolean");
});

test("relation is deterministically none when no active parent exists", () => {
  const decision = scoreSemanticInterviewerIntentEmbeddings({
    unitEmbedding: [1, 0],
    activeParentAvailable: false,
  });

  assert.equal(decision.relation.accepted, true);
  assert.equal(decision.relation.candidate, "none");
  assert.deepEqual(decision.relation.rejectionReasons, [
    "active-parent-unavailable",
  ]);
});
