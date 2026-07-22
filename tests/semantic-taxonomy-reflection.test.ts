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

test("reports unavailable ratios as N/A and exposes rejected semantic leaders", () => {
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
          taxonomyHybridEffectiveType: "unknown",
          taxonomySemanticPerTypeScores: {
            coding: 0.8296,
            "ai-ml-system-design": 0.8292,
          },
          taxonomySemanticRejectionReasons: ["insufficient-margin"],
        },
      },
    ],
    evaluations: [],
  });

  assert.equal(report.metrics.rescuePrecision, null);
  assert.equal(report.metrics.rescueRecall, null);
  assert.equal(report.metrics.cacheHitRate, null);
  assert.equal(report.rows[0].semanticCandidateType, undefined);
  assert.equal(report.rows[0].semanticTopCandidateType, "coding");
  assert.equal(report.rows[0].semanticRunnerUpType, "ai-ml-system-design");
  assert.match(renderSemanticTaxonomyReflectionMarkdown(report), /N\/A/);
  assert.match(
    renderSemanticTaxonomyReflectionMarkdown(report),
    /coding 0\.830 \(rejected\): insufficient-margin/
  );
});

test("detects a correct new-parent classification whose mutation was lost", () => {
  const report = buildSemanticTaxonomyReflectionReport({
    decisions: [
      {
        recordedAt: 10,
        sessionId: "session_1",
        traceId: "trace_general_sd",
        metadata: {
          semanticTaxonomySessionId: "session_1",
          semanticTaxonomyTurnId: "turn_general_sd",
          taxonomyKeywordType: "general-system-design",
          taxonomyHybridEffectiveType: "general-system-design",
        },
      },
    ],
    evaluations: [
      {
        id: "eval_general_sd",
        questionId: "question_general_sd",
        traceIds: ["trace_general_sd"],
        questionType: "general-system-design",
        classification: { verdict: "ok" },
        updatedAt: 20,
      },
    ],
    runtimeTraces: [
      {
        id: "trace_general_sd",
        status: "cancelled",
        metadata: {
          questionInstanceId: "question_general_sd",
          questionTypeInferenceType: "general-system-design",
          taskRelation: "new-parent",
          advisorTaskMutationCommitParent: true,
          runtimeCommitAuthorized: true,
          advisorJobOutcome: "cancelled-by-new-job",
          runtimeExpectedParentId: "parent_coding",
          runtimeExpectedParentType: "coding",
          activeMeetingParentId: "parent_coding",
          activeMeetingParentQuestionType: "coding",
        },
      },
    ],
  });

  assert.equal(report.metrics.trajectory.questions, 1);
  assert.equal(
    report.metrics.trajectory.classificationCorrectButMutationLost,
    1
  );
  assert.deepEqual(report.trajectoryRows[0].failureKinds, [
    "classification-correct-but-mutation-lost",
  ]);
});
