import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveHybridQuestionType,
  scoreSemanticTaxonomyEmbedding,
  type SemanticTaxonomyDecision,
} from "../src/lib/meeting/semantic-taxonomy-resolver.js";
import { inferQuestionTypeDecisionFromText } from "../src/lib/meeting/task-taxonomy.js";

test("scores a synthetic embedding using positive and hard-negative gates", () => {
  const semantic = scoreSemanticTaxonomyEmbedding(
    [1, 0],
    [
      record("coding", "positive", "coding-positive-1", [1, 0]),
      record("coding", "positive", "coding-positive-2", [0.99, 0.01]),
      record("coding", "positive", "coding-positive-3", [0.98, 0.02]),
      record("coding", "hard-negative", "coding-negative", [0.7, 0.7]),
      record("field-knowledge", "positive", "field-positive-1", [0.7, 0.7]),
      record("field-knowledge", "positive", "field-positive-2", [0.69, 0.71]),
      record("field-knowledge", "positive", "field-positive-3", [0.68, 0.72]),
      record("field-knowledge", "hard-negative", "field-negative", [0, 1]),
    ]
  );

  assert.equal(semantic.accepted, true);
  assert.equal(semantic.candidateType, "coding");
  assert.deepEqual(semantic.positivePrototypeIds, [
    "coding-positive-1",
    "coding-positive-2",
    "coding-positive-3",
  ]);
});

test("hard-negative similarity blocks an otherwise strong candidate", () => {
  const semantic = scoreSemanticTaxonomyEmbedding(
    [1, 0],
    [
      record("coding", "positive", "coding-positive-1", [1, 0]),
      record("coding", "positive", "coding-positive-2", [0.99, 0.01]),
      record("coding", "positive", "coding-positive-3", [0.98, 0.02]),
      record("coding", "hard-negative", "coding-negative", [1, 0]),
      record("field-knowledge", "positive", "field-positive-1", [0, 1]),
      record("field-knowledge", "positive", "field-positive-2", [0.01, 0.99]),
      record("field-knowledge", "positive", "field-positive-3", [0.02, 0.98]),
      record("field-knowledge", "hard-negative", "field-negative", [0, 1]),
    ]
  );

  assert.equal(semantic.accepted, false);
  assert.equal(semantic.candidateType, undefined);
  assert.ok(
    semantic.rejectionReasons.includes("hard-negative-margin-below-threshold")
  );
});

test("semantic evidence cannot override a concrete lexical decision", () => {
  const lexical = inferQuestionTypeDecisionFromText(
    "Tell me about a time you disagreed with a teammate."
  );
  const hybrid = resolveHybridQuestionType({
    lexical,
    semantic: acceptedSemantic("coding"),
  });

  assert.equal(hybrid.effectiveType, "behavioral");
  assert.equal(hybrid.outcome, "lexical-semantic-conflict");
  assert.equal(hybrid.semanticDisposition, "conflict");
  assert.equal(hybrid.lexicalAuthoritative, true);
  assert.equal(hybrid.wouldRescue, false);
});

test("accepted semantic evidence is only a rescue recommendation for lexical unknown", () => {
  const lexical = inferQuestionTypeDecisionFromText(
    "I need the routine that walks the tree and gives back every matching path."
  );
  assert.equal(lexical.type, undefined);
  const hybrid = resolveHybridQuestionType({
    lexical,
    semantic: acceptedSemantic("coding"),
  });

  assert.equal(hybrid.effectiveType, "unknown");
  assert.equal(hybrid.recommendedType, "coding");
  assert.equal(hybrid.outcome, "semantic-would-rescue");
  assert.equal(hybrid.semanticDisposition, "abstain");
  assert.equal(hybrid.wouldRescue, true);
});

test("local abstention keeps semantic evidence non-authoritative in shadow", () => {
  const lexical = inferQuestionTypeDecisionFromText(
    "Could you contrast these two approaches for me?"
  );
  assert.equal(lexical.type, undefined);
  const hybrid = resolveHybridQuestionType({
    lexical,
    semantic: acceptedSemantic("field-knowledge"),
  });

  assert.equal(hybrid.effectiveType, "unknown");
  assert.equal(hybrid.outcome, "semantic-would-rescue");
  assert.equal(hybrid.semanticDisposition, "abstain");
  assert.equal(hybrid.recommendedType, "field-knowledge");
  assert.equal(hybrid.lexicalAuthoritative, false);
});

function record(
  questionType: "coding" | "field-knowledge",
  polarity: "positive" | "hard-negative",
  id: string,
  vector: number[]
) {
  return {
    prototype: {
      id,
      questionType,
      polarity,
      text: id,
      language: "en" as const,
      scenarioTags: [],
      source: "generic-curated" as const,
    },
    vector,
  };
}

function acceptedSemantic(
  candidateType: Exclude<
    NonNullable<SemanticTaxonomyDecision["candidateType"]>,
    undefined
  >
): SemanticTaxonomyDecision {
  return {
    candidateType,
    calibratedConfidence: 0.9,
    margin: 0.1,
    accepted: true,
    rejectionReasons: [],
    perTypeScores: {},
    positivePrototypeIds: [],
    hardNegativePrototypeIds: [],
    modelVersion: "test-model",
    prototypeVersion: "test-prototypes",
    calibrationVersion: "test-calibration",
  };
}
