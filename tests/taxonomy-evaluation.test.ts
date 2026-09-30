import assert from "node:assert/strict";
import test from "node:test";
import {
  assignTaxonomyEvaluationSplit,
  detectTaxonomyEvaluationLanguage,
  evaluateTaxonomyCorpus,
  importPrivateTaxonomyCorpus,
  importPrivateTaxonomySessionCorpus,
  splitTaxonomyEvaluationCorpus,
} from "../scripts/lib/taxonomy-evaluation.js";
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

test("prefers confirmed native V2 labels and binds their exact source turns", () => {
  const result = importPrivateTaxonomySessionCorpus({
    sessionId: "session-v2",
    evaluations: [
      {
        id: "eval-1",
        questionId: "question-1",
        questionType: "general-system-design",
        classification: { verdict: "ok" },
        createdAt: 700,
      },
    ],
    projections: [
      {
        projectionId: "projection-1",
        subject: {
          attemptId: "trace-attempt-1",
          questionId: "question-1",
          sourceTurnIds: ["turn-1", "turn-2"],
        },
        activeFacts: {
          "expected-task-settlement": {
            confirmation: "confirmed",
            fact: {
              kind: "expected-task-settlement",
              expectedQuestionType: "ai-ml-system-design",
            },
            provenance: {
              source: "explicit-ui",
              recordedAt: 800,
            },
          },
        },
        conflicts: [],
        computedAt: 900,
      },
    ],
    turns: [
      {
        id: "turn-1",
        speaker: "them",
        text: "Design a recommendation agent",
        startedAt: 100,
        endedAt: 200,
      },
      {
        id: "turn-2",
        speaker: "them",
        text: "that learns from user feedback.",
        startedAt: 210,
        endedAt: 300,
      },
    ],
  });

  assert.equal(result.examples.length, 1);
  assert.equal(result.examples[0].expectedType, "ai-ml-system-design");
  assert.equal(
    result.examples[0].text,
    "Design a recommendation agent that learns from user feedback."
  );
  assert.equal(result.examples[0].groupId, "private:session-v2:question-1");
  assert.ok(result.examples[0].tags.includes("v2-active-projection"));
  assert.equal(result.stats.matchedSubjectCount, 1);
  assert.equal(result.stats.disagreementCount, 1);
  assert.equal(result.stats.nativeV2ConfirmedCount, 1);
  assert.equal(result.stats.directTurnBindingCount, 1);
  assert.ok(
    result.warnings.some(
      (warning) => warning.code === "v1-v2-type-disagreement"
    )
  );
});

test("deduplicates imported legacy V2 mirrors and skips unresolved V2 labels", () => {
  const result = importPrivateTaxonomySessionCorpus({
    sessionId: "session-mixed",
    evaluations: [
      {
        id: "eval-legacy",
        questionId: "question-legacy",
        questionType: "coding",
        classification: { verdict: "ok" },
        createdAt: 300,
      },
    ],
    projections: [
      {
        projectionId: "projection-legacy",
        subject: {
          questionId: "question-legacy",
          sourceTurnIds: ["turn-coding"],
        },
        activeFacts: {
          "expected-question-type": {
            confirmation: "confirmed",
            fact: {
              kind: "expected-question-type",
              expectedQuestionType: "coding",
            },
            provenance: {
              source: "imported-legacy",
              recordedAt: 300,
            },
          },
        },
        conflicts: [],
        computedAt: 400,
      },
      {
        projectionId: "projection-suggested",
        subject: {
          attemptId: "trace-attempt-suggested",
          questionId: "question-suggested",
          sourceTurnIds: ["turn-suggested"],
        },
        activeFacts: {
          "expected-task-settlement": {
            confirmation: "suggested",
            fact: {
              kind: "expected-task-settlement",
              expectedQuestionType: "field-knowledge",
            },
            provenance: {
              source: "explicit-ui",
              recordedAt: 500,
            },
          },
        },
        conflicts: [],
        computedAt: 500,
      },
      {
        projectionId: "projection-conflict",
        subject: {
          attemptId: "trace-attempt-conflict",
          questionId: "question-conflict",
          sourceTurnIds: ["turn-conflict"],
        },
        activeFacts: {
          "expected-task-settlement": {
            confirmation: "confirmed",
            fact: {
              kind: "expected-task-settlement",
              expectedQuestionType: "behavioral",
            },
            provenance: {
              source: "explicit-ui",
              recordedAt: 600,
            },
          },
        },
        conflicts: [{ factKind: "expected-task-settlement" }],
        computedAt: 600,
      },
    ],
    turns: [
      {
        id: "turn-coding",
        speaker: "them",
        text: "Implement a stack.",
        startedAt: 100,
        endedAt: 200,
      },
      {
        id: "turn-suggested",
        speaker: "them",
        text: "Explain HNSW.",
        startedAt: 400,
        endedAt: 450,
      },
      {
        id: "turn-conflict",
        speaker: "them",
        text: "Tell me about a conflict.",
        startedAt: 500,
        endedAt: 550,
      },
    ],
  });

  assert.equal(result.examples.length, 1);
  assert.equal(result.examples[0].expectedType, "coding");
  assert.ok(result.examples[0].tags.includes("v1-compatible-label"));
  assert.equal(result.stats.importedLegacyProjectionCount, 0);
  assert.equal(result.stats.suggestedSkippedCount, 1);
  assert.equal(result.stats.conflictSkippedCount, 1);
  assert.equal(result.stats.importedCount, 1);
  assert.ok(
    result.warnings.some(
      (warning) => warning.code === "attempt-subject-missing"
    )
  );
});

test("detects English, Chinese, and code-mixed corpus slices", () => {
  assert.equal(detectTaxonomyEvaluationLanguage("Explain vector search"), "en");
  assert.equal(detectTaxonomyEvaluationLanguage("解释向量检索"), "zh");
  assert.equal(detectTaxonomyEvaluationLanguage("解释 RAG 的流程"), "mixed");
});
