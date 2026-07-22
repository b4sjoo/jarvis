import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSemanticTaxonomyReflectionReport,
  renderSemanticTaxonomyReflectionMarkdown,
} from "../src/lib/meeting/semantic-taxonomy-reflection.js";

test("joins late semantic evidence to HITL labels and reports rescue quality", () => {
  const report = buildSemanticTaxonomyReflectionReport({
    decisions: [
      {
        recordedAt: 10,
        sessionId: "session_1",
        traceId: "trace_1",
        metadata: {
          semanticTaxonomySessionId: "session_1",
          semanticTaxonomyTurnId: "turn_1",
          semanticTaxonomyMode: "enforcement",
          taxonomyKeywordType: "unknown",
          taxonomySemanticEmbeddingStatus: "success",
          taxonomySemanticDurationMs: 24,
          taxonomySemanticCacheHit: false,
          taxonomySemanticCandidateType: "coding",
          taxonomyHybridRecommendedType: "coding",
          taxonomyHybridWouldRescue: true,
          taxonomyHybridEffectiveType: "unknown",
          taxonomySemanticRescueApplied: false,
        },
      },
      {
        recordedAt: 20,
        sessionId: "session_1",
        traceId: "trace_1",
        metadata: {
          semanticTaxonomySessionId: "session_1",
          semanticTaxonomyTurnId: "turn_1",
          taxonomyHybridEffectiveType: "coding",
          taxonomySemanticRescueApplied: true,
          taxonomySemanticEnforcementReason:
            "semantic-rescued-lexical-unknown-without-parent",
        },
      },
    ],
    evaluations: [
      {
        id: "eval_1",
        questionId: "question_1",
        traceIds: ["trace_1"],
        questionType: "coding",
        classification: { verdict: "ok" },
        updatedAt: 30,
      },
    ],
  });

  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].effectiveType, "coding");
  assert.equal(report.rows[0].labelOutcome, "confirmed");
  assert.equal(report.metrics.rescuePrecision, 1);
  assert.equal(report.metrics.rescueRecall, 1);
  assert.equal(report.metrics.embeddingLatency.p95Ms, 24);
  assert.match(renderSemanticTaxonomyReflectionMarkdown(report), /turn_1/);
});

test("keeps correction and missing-evidence diagnostics explicit", () => {
  const report = buildSemanticTaxonomyReflectionReport({
    decisions: [
      {
        recordedAt: 10,
        sessionId: "session_1",
        traceId: "trace_1",
        metadata: {
          semanticTaxonomySessionId: "session_1",
          semanticTaxonomyTurnId: "turn_1",
          taxonomyKeywordType: "unknown",
          taxonomySemanticCandidateType: "general-system-design",
          taxonomyHybridRecommendedType: "general-system-design",
          taxonomyHybridWouldRescue: true,
          taxonomyHybridEffectiveType: "general-system-design",
          taxonomySemanticRescueApplied: true,
          taxonomySemanticEmbeddingStatus: "success",
        },
      },
    ],
    evaluations: [
      {
        id: "eval_1",
        questionId: "question_1",
        traceIds: ["trace_1"],
        questionType: "general-system-design",
        correctedQuestionType: "ai-ml-system-design",
        manualQuestionTypeCorrectionId: "correction_1",
        classification: { verdict: "wrong" },
        updatedAt: 20,
      },
      {
        id: "eval_2",
        questionId: "question_2",
        traceIds: ["trace_missing"],
        questionType: "coding",
        classification: { verdict: "ok" },
        updatedAt: 30,
      },
    ],
  });

  assert.equal(report.rows[0].correctionAfterRescue, true);
  assert.equal(report.metrics.rescuePrecision, 0);
  assert.equal(report.metrics.correctionAfterRescue, 1);
  assert.equal(report.unmatchedLabeledQuestions.length, 1);
  assert.equal(report.reviewProposals.thresholdCandidates.length, 1);
  assert.equal(report.reviewProposals.automaticMutationAllowed, false);
});
