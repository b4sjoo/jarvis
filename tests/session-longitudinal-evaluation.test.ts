import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionLongitudinalEvaluationReport,
  renderSessionLongitudinalEvaluationMarkdown,
  type LongitudinalSessionInput,
} from "../src/lib/meeting/session-longitudinal-evaluation.js";

test("builds type, intent, and continuity funnels without inventing denominators", () => {
  const report = buildSessionLongitudinalEvaluationReport([SESSION]);

  assert.equal(report.cohort.productionTraceCount, 3);
  assert.equal(report.cohort.syntheticTraceCount, 1);
  assert.equal(report.typeFunnel.stageCoverage.keyword.denominator, 3);
  assert.equal(report.typeFunnel.agreementWithHuman.runtime.denominator, 2);
  assert.equal(report.typeFunnel.agreementWithHuman.runtime.numerator, 1);
  assert.equal(report.typeFunnel.manualCorrectionCount, 1);
  assert.equal(report.intentFunnel.falseActivation.denominator, 1);
  assert.equal(report.intentFunnel.falseActivation.numerator, 1);
  assert.equal(report.intentFunnel.falseSuppression.denominator, 2);
  assert.equal(report.intentFunnel.falseSuppression.numerator, 1);
  assert.equal(report.continuityFunnel.relationAgreement.denominator, 1);
  assert.equal(report.continuityFunnel.relationAgreement.numerator, 1);
  assert.equal(report.continuityFunnel.expectedContextCoverage.rate, 1);
  assert.equal(report.evidenceGaps.labelsWithoutMatchingTrace, 1);
});

test("renders N/A for a missing human-label denominator", () => {
  const report = buildSessionLongitudinalEvaluationReport([
    {
      ...SESSION,
      questionEvaluations: [],
    },
  ]);
  const markdown = renderSessionLongitudinalEvaluationMarkdown(report);

  assert.equal(report.intentFunnel.falseActivation.rate, null);
  assert.match(markdown, /False activation: N\/A/);
});

const SESSION: LongitudinalSessionInput = {
  directory: "/recordings/session-a",
  manifest: {
    sessionId: "session-a",
    startedAt: 1,
    build: {
      appVersion: "0.1.9",
      gitCommit: "abc123",
    },
  },
  transcriptTurns: [
    { id: "turn_1", speaker: "them", text: "Implement a stack." },
    { id: "turn_2", speaker: "them", text: "Looks good." },
  ],
  traceSummaries: [
    {
      traceId: "trace_coding",
      traceKind: "voice",
      questionType: "coding",
      rawQuestionType: "coding",
      taskRelation: "new-parent",
      advisorTurnIntent: "direct-question",
      advisorWouldSuppress: false,
      advisorExecutionAuthorized: true,
      taskMutationAuthorized: true,
      advisorOutputDisposition: "committed",
      advisorOutputCommittedToUi: true,
      visibleAnswerChanged: true,
      logicalQuestionUnitId: "lqu_1",
      logicalQuestionSourceTurnIds: ["turn_1"],
      logicalQuestionCompositionReasons: ["new-question"],
      advisorPromptIncludedLogicalQuestion: true,
      taskBoundary: {
        mutationDisposition: "commit-before-advisor",
        sourceTurnIds: ["turn_1"],
      },
      semanticTaxonomy: {
        keywordType: "coding",
        semanticCandidateType: "coding",
        rescueApplied: false,
        durationMs: 20,
      },
      taxonomyAdjudication: {
        candidateType: "coding",
        durationMs: 300,
      },
      timingsMs: { advisor: 800 },
    },
    {
      traceId: "trace_filler",
      traceKind: "voice",
      questionType: "coding",
      rawQuestionType: "unknown",
      taskRelation: "followup-parent",
      advisorTurnIntent: "low-value",
      advisorWouldSuppress: true,
      advisorExecutionAuthorized: true,
      taskMutationAuthorized: false,
      advisorOutputDisposition: "committed",
      advisorOutputCommittedToUi: true,
      visibleAnswerChanged: true,
      timingsMs: { advisor: 500 },
    },
    {
      traceId: "trace_missed",
      traceKind: "voice",
      questionType: "unknown",
      rawQuestionType: "unknown",
      advisorTurnIntent: "statement",
      advisorWouldSuppress: true,
      advisorExecutionAuthorized: false,
      taskMutationAuthorized: false,
    },
    {
      traceId: "synthetic",
      syntheticValidation: true,
      questionType: "coding",
    },
  ],
  questionEvaluations: [
    {
      id: "eval_coding",
      questionId: "question_coding",
      traceIds: ["trace_coding"],
      questionType: "coding",
      correctedQuestionType: "coding",
      classification: { verdict: "ok" },
      advisorIntent: {
        verdict: "ok",
        expectedAction: "advise",
        observedAction: "advised",
        source: "explicit-human-label",
        originalTraceId: "trace_coding",
      },
      expectedRelation: "new-parent",
      expectedParentAction: "commit-before-advisor",
      expectedContextTurnIds: ["turn_1"],
      updatedAt: 1,
    },
    {
      id: "eval_filler",
      questionId: "question_filler",
      traceIds: ["trace_filler"],
      questionType: "coding",
      correctedQuestionType: "behavioral",
      manualQuestionTypeCorrectionId: "correction_1",
      classification: { verdict: "wrong" },
      advisorIntent: {
        verdict: "false-positive",
        expectedAction: "ignore",
        observedAction: "advised",
        source: "explicit-human-label",
        originalTraceId: "trace_filler",
      },
      updatedAt: 2,
    },
    {
      id: "eval_missed",
      questionId: "question_missed",
      traceIds: ["trace_missed"],
      advisorIntent: {
        verdict: "false-negative",
        expectedAction: "advise",
        observedAction: "suppressed",
        source: "explicit-human-label",
        originalTraceId: "trace_missed",
      },
      updatedAt: 3,
    },
    {
      id: "eval_unmatched",
      questionId: "question_unmatched",
      traceIds: ["trace_missing"],
      questionType: "coding",
      classification: { verdict: "ok" },
      updatedAt: 4,
    },
  ],
};
