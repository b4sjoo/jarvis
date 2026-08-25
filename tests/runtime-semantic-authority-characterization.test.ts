import assert from "node:assert/strict";
import test from "node:test";
import {
  RUNTIME_SEMANTIC_AUTHORITY_CASES,
  type RuntimeSemanticAuthorityCaseId,
} from "./fixtures/runtime-semantic-authority-cases.js";

const EXPECTED_CASES: readonly RuntimeSemanticAuthorityCaseId[] = [
  "transition-substantive-residual",
  "transition-negation",
  "strong-anchor-empty-decisions",
  "generated-answer-screen-source",
  "released-response-dispatch",
  "no-mutation-post-generation",
  "screen-source-transition",
  "exact-project-before-deictic",
  "fenced-answer-section-label",
];

test("keeps the accepted semantic-authority regression corpus complete", () => {
  assert.deepEqual(
    RUNTIME_SEMANTIC_AUTHORITY_CASES.map((item) => item.id),
    EXPECTED_CASES
  );
  assert.equal(
    new Set(RUNTIME_SEMANTIC_AUTHORITY_CASES.map((item) => item.id)).size,
    RUNTIME_SEMANTIC_AUTHORITY_CASES.length
  );
});

test("assigns every semantic-authority case to an existing owner boundary", () => {
  for (const item of RUNTIME_SEMANTIC_AUTHORITY_CASES) {
    assert.ok(item.ownerTasks.length > 0, `${item.id} has no owner task`);
    assert.ok(item.expectedInvariant.trim().length > 0);
    assert.ok(item.forbiddenEffect.trim().length > 0);
  }
});

test("does not encode a replacement runtime taxonomy in the corpus", () => {
  const fixtureJson = JSON.stringify(RUNTIME_SEMANTIC_AUTHORITY_CASES);
  for (const forbidden of [
    "child-followup",
    "transition-only-task",
    "unsupported-answer",
    "screen-recovery-task",
  ]) {
    assert.equal(fixtureJson.includes(forbidden), false);
  }
});
