import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSemanticTaxonomyReflectionReport,
  renderSemanticTaxonomyReflectionMarkdown,
} from "../scripts/lib/semantic-taxonomy-reflection.js";

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
            coding: {
              positiveScore: 0.8296,
              hardNegativeScore: 0.2,
            },
            "ai-ml-system-design": {
              positiveScore: 0.8292,
              hardNegativeScore: 0.3,
            },
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

test("separates human labels from runtime corrections and requires prompt evidence for context loss", () => {
  const report = buildSemanticTaxonomyReflectionReport({
    decisions: [
      {
        recordedAt: 10,
        sessionId: "session_1",
        traceId: "trace_followup",
        metadata: {
          semanticTaxonomySessionId: "session_1",
          semanticTaxonomyTurnId: "turn_followup",
          taxonomyKeywordType: "coding",
          taxonomyHybridEffectiveType: "coding",
        },
      },
    ],
    evaluations: [
      {
        id: "eval_followup",
        questionId: "question_followup",
        traceIds: ["trace_followup"],
        questionType: "coding",
        correctedQuestionType: "coding",
        classification: { verdict: "ok" },
        updatedAt: 20,
      },
    ],
    runtimeTraces: [
      {
        id: "trace_followup",
        status: "success",
        metadata: {
          questionInstanceId: "question_followup",
          questionTypeInferenceType: "coding",
          taskRelation: "followup-parent",
          runtimeExpectedParentId: "parent_coding",
          activeMeetingParentId: "parent_coding",
          logicalQuestionSourceTurnIds: ["turn_followup"],
          canonicalQuestionSourceTurnIds: ["turn_original"],
          advisorPromptIncludedLogicalQuestion: true,
        },
      },
    ],
  });

  assert.equal(report.rows[0].labelOutcome, "confirmed");
  assert.equal(report.trajectoryRows[0].manualCorrectionApplied, false);
  assert.equal(
    report.trajectoryRows[0].inheritedParentQuestionAvailable,
    true
  );
  assert.equal(report.trajectoryRows[0].currentLogicalQuestionCoverage, 0);
  assert.deepEqual(report.trajectoryRows[0].failureKinds, []);
});

test("reports context loss only when the advisor prompt explicitly omitted the logical question", () => {
  const report = buildSemanticTaxonomyReflectionReport({
    decisions: [
      {
        recordedAt: 10,
        sessionId: "session_1",
        traceId: "trace_missing_prompt",
        metadata: {
          semanticTaxonomySessionId: "session_1",
          semanticTaxonomyTurnId: "turn_missing_prompt",
          taxonomyKeywordType: "general-system-design",
          taxonomyHybridEffectiveType: "general-system-design",
        },
      },
    ],
    evaluations: [],
    runtimeTraces: [
      {
        id: "trace_missing_prompt",
        status: "success",
        metadata: {
          taskRelation: "new-parent",
          logicalQuestionSourceTurnIds: ["turn_missing_prompt"],
          canonicalQuestionSourceTurnIds: [],
          advisorPromptIncludedLogicalQuestion: false,
        },
      },
    ],
  });

  assert.equal(
    report.trajectoryRows[0].advisorPromptIncludedLogicalQuestion,
    false
  );
  assert.ok(
    report.trajectoryRows[0].failureKinds.includes(
      "late-parent-missing-question-context"
    )
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
