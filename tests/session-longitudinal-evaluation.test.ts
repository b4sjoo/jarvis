import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionLongitudinalEvaluationReport,
  renderSessionLongitudinalEvaluationMarkdown,
  type LongitudinalSessionInput,
} from "../src/lib/meeting/session-longitudinal-evaluation.js";
import {
  createHumanGroundTruthEventV2,
  deriveHumanEvaluationProjectionV2,
} from "../src/lib/meeting/human-ground-truth-v2.js";

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

test("builds product outcomes only from human-reviewed critical moments", () => {
  const momentSubject = {
    momentId: "moment_success",
    traceIds: ["trace_success", "trace_regeneration"],
    sourceTurnIds: ["turn_success"],
  };
  const momentSettlement = createHumanGroundTruthEventV2({
    eventId: "moment-success-settlement",
    sessionId: "session-product",
    subject: momentSubject,
    source: "explicit-ui",
    fact: {
      kind: "expected-task-settlement",
      expectedQuestionType: "coding",
      expectedRelation: "new-parent",
      expectedParentAction: "create",
    },
    now: 1,
  });
  const momentProjection = deriveHumanEvaluationProjectionV2({
    sessionId: "session-product",
    subject: momentSubject,
    events: [momentSettlement],
    now: 2,
  });
  const report = buildSessionLongitudinalEvaluationReport([
    {
      directory: "/recordings/session-product",
      manifest: { sessionId: "session-product" },
      transcriptTurns: [
        {
          id: "turn_success",
          speaker: "them",
          text: "Design a queue.",
          startedAt: 100,
          endedAt: 200,
        },
        {
          id: "turn_missed",
          speaker: "them",
          text: "Explain RAG.",
          startedAt: 700,
          endedAt: 800,
        },
        {
          id: "turn_filler",
          speaker: "them",
          text: "Looks good.",
          startedAt: 900,
          endedAt: 950,
        },
        {
          id: "turn_unreviewed",
          speaker: "them",
          text: "One more thing.",
          startedAt: 1_000,
          endedAt: 1_050,
        },
      ],
      traceSummaries: [
        {
          traceId: "trace_success",
          startedAt: 210,
          endedAt: 500,
          logicalQuestionSourceTurnIds: ["turn_success"],
          advisorExecutionAuthorized: true,
          advisorOutputCommittedToUi: true,
        },
        {
          traceId: "trace_regeneration",
          startedAt: 510,
          endedAt: 550,
          logicalQuestionSourceTurnIds: ["turn_success"],
          advisorExecutionAuthorized: true,
          advisorOutputCommittedToUi: true,
        },
        {
          traceId: "trace_filler",
          startedAt: 960,
          endedAt: 980,
          logicalQuestionSourceTurnIds: ["turn_filler"],
          advisorExecutionAuthorized: true,
          advisorOutputCommittedToUi: true,
        },
      ],
      questionEvaluations: [],
      humanEvaluationProjectionsV2: [momentProjection],
      criticalMomentCandidates: [
        {
          momentId: "moment_success",
          sessionId: "session-product",
          sourceTurnIds: ["turn_success"],
          sourceText: "Design a queue.",
          opportunityEndAt: 200,
          proposedTraceIds: ["trace_success", "trace_regeneration"],
          traceJoinStatus: "ambiguous",
        },
        {
          momentId: "moment_missed",
          sessionId: "session-product",
          sourceTurnIds: ["turn_missed"],
          sourceText: "Explain RAG.",
          opportunityEndAt: 800,
          proposedTraceIds: [],
          traceJoinStatus: "none",
        },
        {
          momentId: "moment_filler",
          sessionId: "session-product",
          sourceTurnIds: ["turn_filler"],
          sourceText: "Looks good.",
          opportunityEndAt: 950,
          proposedTraceIds: ["trace_filler"],
          traceJoinStatus: "exact",
        },
        {
          momentId: "moment_unreviewed",
          sessionId: "session-product",
          sourceTurnIds: ["turn_unreviewed"],
          sourceText: "One more thing.",
          opportunityEndAt: 1_050,
          proposedTraceIds: [],
          traceJoinStatus: "none",
        },
      ],
      criticalMomentEvaluations: [
        {
          momentId: "moment_success",
          sessionId: "session-product",
          sourceTurnIds: ["turn_success"],
          traceIds: ["trace_success", "trace_regeneration"],
          eligibility: "critical",
          expectedQuestionType: "coding",
          firstUsefulAt: 500,
          opportunityEndAt: 200,
          userSpeechStartAt: 600,
          useful: true,
          trustworthy: true,
          naturalStart: true,
          waitedForJarvis: false,
          readFromJarvis: false,
          interactionRequired: false,
          failureReasons: [],
        },
        {
          momentId: "moment_missed",
          sessionId: "session-product",
          sourceTurnIds: ["turn_missed"],
          traceIds: [],
          eligibility: "critical",
          expectedQuestionType: "field-knowledge",
          expectedAdvisorAction: "advise",
          useful: false,
          trustworthy: false,
          naturalStart: false,
          failureReasons: ["no-advice"],
        },
        {
          momentId: "moment_filler",
          sessionId: "session-product",
          sourceTurnIds: ["turn_filler"],
          traceIds: ["trace_filler"],
          eligibility: "not-critical",
          expectedAdvisorAction: "ignore",
          failureReasons: [],
        },
      ],
    },
  ]);

  assert.equal(report.version, 2);
  assert.equal(report.productOutcomes.candidateCount, 4);
  assert.equal(report.productOutcomes.criticalMomentCount, 2);
  assert.equal(report.productOutcomes.cmsr.numerator, 1);
  assert.equal(report.productOutcomes.cmsr.denominator, 2);
  assert.equal(
    report.productOutcomes.zeroTraceOpportunityMissRate.numerator,
    1
  );
  assert.equal(report.productOutcomes.falseActivationRate.numerator, 1);
  assert.equal(report.productOutcomes.ttugMs.p50Ms, 300);
  assert.equal(
    report.productOutcomes.guidanceBeforeSpeechCoverage.denominator,
    2
  );
  assert.equal(
    report.productOutcomes.guidanceBeforeSpeechCoverage.numerator,
    1
  );
  assert.equal(report.productOutcomes.manyTraceMomentCount, 1);
  assert.equal(report.productOutcomes.ambiguousJoinCount, 1);
  assert.equal(report.productOutcomes.unresolvedCandidateCount, 1);
  assert.equal(report.productOutcomes.failureReasons["no-advice"], 1);
  assert.deepEqual(report.productOutcomes.expectedFactJoins, {
    exactMoment: 1,
    exactSourceTurns: 0,
    legacyFallback: 2,
    missing: 1,
    ambiguous: 0,
    conflicting: 0,
  });

  const markdown = renderSessionLongitudinalEvaluationMarkdown(report);
  assert.ok(
    markdown.indexOf("## Product Outcomes") <
      markdown.indexOf("## Type Funnel")
  );
});

test("reports whiteboard validation, repair, fallback, and latency denominators", () => {
  const report = buildSessionLongitudinalEvaluationReport([
    {
      directory: "/recordings/session-whiteboard",
      manifest: { sessionId: "session-whiteboard" },
      transcriptTurns: [],
      questionEvaluations: [],
      traceSummaries: [
        {
          traceId: "trace_valid",
          whiteboard: {
            validationOperationId: "validation_valid",
            validationDisposition: "valid-mermaid",
            validationDurationMs: 12,
            sanitationDisposition: "applied",
            sanitationChanges: ["quoted-node-label"],
            renderStatus: "valid-mermaid",
            mermaidEligible: true,
            mermaidRequested: true,
            mermaidCommitted: true,
          },
        },
        {
          traceId: "trace_repaired",
          whiteboard: {
            validationOperationId: "validation_repaired",
            validationDisposition: "invalid-mermaid",
            validationDurationMs: 20,
            preservedLastValid: true,
            renderStatus: "preserved-last-valid",
            fallbackKind: "last-valid",
            repairOperationId: "repair_1",
            repairDisposition: "shadow-valid",
            repairQueueWaitMs: 15,
            repairDurationMs: 420,
            repairRevalidationDisposition: "valid-mermaid",
            mermaidEligible: true,
            mermaidRequested: true,
            mermaidCommitted: false,
          },
        },
        {
          traceId: "trace_ascii",
          whiteboard: {
            validationOperationId: "validation_ascii",
            validationDisposition: "invalid-mermaid",
            validationDurationMs: 30,
            renderStatus: "ascii-fallback",
            fallbackKind: "deterministic-ascii",
            repairOperationId: "repair_2",
            repairDisposition: "revalidation-failed",
            repairQueueWaitMs: 25,
            repairDurationMs: 700,
            repairRevalidationDisposition: "invalid-mermaid",
            mermaidEligible: true,
            mermaidRequested: true,
            mermaidCommitted: false,
            formatPolicyMiss: true,
            formatConversionAttempted: true,
            formatConversionDisposition: "no-flow-structure",
            asciiFallback: true,
            asciiFallbackReason: "no-flow-structure",
          },
        },
      ],
    },
  ]);

  assert.equal(report.whiteboardRenderFunnel.observedCandidates, 3);
  assert.equal(report.whiteboardRenderFunnel.invalidCandidates, 2);
  assert.equal(report.whiteboardRenderFunnel.sanitationAttempts, 1);
  assert.equal(report.whiteboardRenderFunnel.sanitationSuccesses, 1);
  assert.equal(report.whiteboardRenderFunnel.repairAttempts, 2);
  assert.equal(report.whiteboardRenderFunnel.settledRepairAttempts, 2);
  assert.equal(report.whiteboardRenderFunnel.successfulShadowRepairs, 1);
  assert.equal(report.whiteboardRenderFunnel.validationFailureRate.rate, 2 / 3);
  assert.equal(report.whiteboardRenderFunnel.repairSuccessRate.rate, 0.5);
  assert.equal(report.whiteboardRenderFunnel.preservedLastValidRate.rate, 0.5);
  assert.equal(report.whiteboardRenderFunnel.asciiFallbackRate.rate, 0.5);
  assert.equal(report.whiteboardRenderFunnel.mermaidEligibleCount, 3);
  assert.equal(report.whiteboardRenderFunnel.mermaidRequestedCount, 3);
  assert.equal(report.whiteboardRenderFunnel.mermaidCommittedCount, 1);
  assert.equal(report.whiteboardRenderFunnel.mermaidCommitRate.rate, 1 / 3);
  assert.equal(report.whiteboardRenderFunnel.formatPolicyMissCount, 1);
  assert.equal(report.whiteboardRenderFunnel.formatConversionAttemptCount, 1);
  assert.equal(report.whiteboardRenderFunnel.formatAsciiFallbackCount, 1);
  assert.equal(report.whiteboardRenderFunnel.validationLatencyMs.p50Ms, 20);
  assert.equal(report.whiteboardRenderFunnel.repairQueueWaitMs.p95Ms, 25);
  assert.equal(report.whiteboardRenderFunnel.repairDurationMs.maxMs, 700);

  const markdown = renderSessionLongitudinalEvaluationMarkdown(report);
  assert.match(markdown, /## Whiteboard Render Integrity/);
  assert.match(markdown, /Repair success rate: 50.0% \(1\/2\)/);
  assert.match(markdown, /Deterministic sanitation attempts \/ successes: 1 \/ 1/);
  assert.match(markdown, /Mermaid eligible \/ requested \/ committed: 3 \/ 3 \/ 1/);
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
      expectedParentAction: "create",
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
