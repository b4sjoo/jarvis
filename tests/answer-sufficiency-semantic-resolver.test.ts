import assert from "node:assert/strict";
import test from "node:test";
import {
  scoreAnswerSufficiencySemanticEmbedding,
} from "../src/lib/meeting/answer-sufficiency-semantic-resolver.js";

test("answer sufficiency semantic scorer accepts a separated insufficiency cluster", () => {
  const decision = scoreAnswerSufficiencySemanticEmbedding(
    [1, 0],
    [
      record("context-insufficient", "insufficient-1", [1, 0]),
      record("context-insufficient", "insufficient-2", [0.99, 0.01]),
      record("not-context-insufficient", "sufficient-1", [0, 1]),
      record("not-context-insufficient", "sufficient-2", [0.01, 0.99]),
    ]
  );

  assert.equal(decision.accepted, true);
  assert.equal(decision.candidateStatus, "context-insufficient");
  assert.deepEqual(decision.prototypeIds, [
    "insufficient-1",
    "insufficient-2",
  ]);
});

test("answer sufficiency semantic scorer rejects an ambiguous boundary", () => {
  const decision = scoreAnswerSufficiencySemanticEmbedding(
    [1, 0],
    [
      record("context-insufficient", "insufficient-1", [0.8, 0.6]),
      record("context-insufficient", "insufficient-2", [0.79, 0.61]),
      record("not-context-insufficient", "sufficient-1", [0.79, 0.61]),
      record("not-context-insufficient", "sufficient-2", [0.78, 0.62]),
    ]
  );

  assert.equal(decision.accepted, false);
  assert.equal(decision.candidateStatus, undefined);
  assert.ok(
    decision.rejectionReasons.includes("class-margin-below-threshold")
  );
});

function record(
  semanticClass:
    | "context-insufficient"
    | "not-context-insufficient",
  id: string,
  vector: number[]
) {
  return {
    prototype: {
      id,
      semanticClass,
      text: id,
      language: "en" as const,
      scenarioTags: [],
    },
    vector,
  };
}
