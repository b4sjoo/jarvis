import assert from "node:assert/strict";
import test from "node:test";
import {
  assignTaxonomyEvaluationSplit,
  detectTaxonomyEvaluationLanguage,
  evaluateTaxonomyCorpus,
  importPrivateTaxonomyCorpus,
  splitTaxonomyEvaluationCorpus,
} from "../src/lib/meeting/taxonomy-evaluation.js";
import { inferQuestionTypeDecisionFromText } from "../src/lib/meeting/task-taxonomy.js";
import { TAXONOMY_EVALUATION_CORPUS } from "./fixtures/taxonomy-evaluation-corpus.js";

test("evaluates the deterministic lexical taxonomy baseline", () => {
  const report = evaluateTaxonomyCorpus(
    TAXONOMY_EVALUATION_CORPUS,
    (example) => inferQuestionTypeDecisionFromText(example.text)
  );

  assert.equal(report.version, 1);
  assert.equal(report.corpusSize, TAXONOMY_EVALUATION_CORPUS.length);
  assert.equal(
    Object.values(report.confusionMatrix).reduce(
      (total, row) =>
        total + Object.values(row).reduce((sum, count) => sum + count, 0),
      0
    ),
    TAXONOMY_EVALUATION_CORPUS.length
  );
  assert.ok(report.metrics.answerableTechnicalCount > 0);
  assert.ok(report.metrics.answerableTechnicalUnknownCount > 0);
  assert.ok(report.metrics.answerableTechnicalUnknownRate > 0);
  assert.equal(report.metrics.falseActivationCount, 0);
  assert.ok(report.perType.coding.support > 0);
  assert.ok(report.perType["ai-ml-system-design"].support > 0);
  assert.ok(report.slices["tag:semantic-recall"].total > 0);
  assert.ok(report.slices["parent:active"].total > 0);
  assert.equal(report.latency.samples, TAXONOMY_EVALUATION_CORPUS.length);
});

test("keeps every paraphrase group in exactly one deterministic split", () => {
  const first = splitTaxonomyEvaluationCorpus(TAXONOMY_EVALUATION_CORPUS);
  const second = splitTaxonomyEvaluationCorpus(TAXONOMY_EVALUATION_CORPUS);
  assert.deepEqual(first, second);

  const groupSplits = new Map<string, Set<string>>();
  for (const [split, examples] of Object.entries(first)) {
    for (const example of examples) {
      const splits = groupSplits.get(example.groupId) ?? new Set<string>();
      splits.add(split);
      groupSplits.set(example.groupId, splits);
      assert.equal(
        split,
        assignTaxonomyEvaluationSplit(example.groupId)
      );
    }
  }

  assert.ok(groupSplits.size > 10);
  for (const splits of groupSplits.values()) {
    assert.equal(splits.size, 1);
  }
});

test("imports only reviewed private labels and binds them to the nearest prior interviewer turn", () => {
  const result = importPrivateTaxonomyCorpus({
    sessionId: "private-session-test",
    turns: [
      {
        id: "turn-old",
        speaker: "them",
        text: "Design a ride-sharing service.",
        startedAt: 100,
        endedAt: 200,
      },
      {
        id: "turn-me",
        speaker: "me",
        text: "Let me think.",
        startedAt: 250,
        endedAt: 300,
      },
      {
        id: "turn-latest",
        speaker: "them",
        text: "设计一个 self-evolving travel recommendation agent。",
        startedAt: 400,
        endedAt: 500,
      },
    ],
    evaluations: [
      {
        id: "eval-corrected",
        questionId: "trace:voice-1",
        questionType: "general-system-design",
        correctedQuestionType: "ai-ml-system-design",
        manualQuestionTypeCorrectionSource: "focus-mode",
        classification: {
          verdict: "wrong",
          reasons: ["manual-runtime-correction"],
        },
        createdAt: 550,
      },
      {
        id: "eval-unreviewed",
        questionId: "trace:voice-2",
        questionType: "coding",
        classification: { verdict: "not_applicable" },
        createdAt: 560,
      },
    ],
  });

  assert.equal(result.examples.length, 1);
  assert.equal(result.examples[0].text, "设计一个 self-evolving travel recommendation agent。");
  assert.equal(result.examples[0].expectedType, "ai-ml-system-design");
  assert.equal(result.examples[0].language, "mixed");
  assert.ok(result.examples[0].tags.includes("manual-correction"));
  assert.deepEqual(result.skipped, [
    {
      evaluationId: "eval-unreviewed",
      reason: "missing-reviewed-label",
    },
  ]);
});

test("does not attach an evaluation to a stale transcript turn", () => {
  const result = importPrivateTaxonomyCorpus({
    sessionId: "private-session-test",
    turns: [
      {
        id: "turn-stale",
        speaker: "them",
        text: "Explain RAG.",
        startedAt: 100,
        endedAt: 200,
      },
    ],
    evaluations: [
      {
        id: "eval-late",
        questionId: "trace:voice-late",
        questionType: "field-knowledge",
        classification: { verdict: "ok" },
        createdAt: 500_000,
      },
    ],
  });

  assert.equal(result.examples.length, 0);
  assert.deepEqual(result.skipped, [
    {
      evaluationId: "eval-late",
      reason: "missing-nearby-interviewer-turn",
    },
  ]);
});

test("detects English, Chinese, and code-mixed corpus slices", () => {
  assert.equal(detectTaxonomyEvaluationLanguage("Explain vector search"), "en");
  assert.equal(detectTaxonomyEvaluationLanguage("解释向量检索"), "zh");
  assert.equal(detectTaxonomyEvaluationLanguage("解释 RAG 的流程"), "mixed");
});
