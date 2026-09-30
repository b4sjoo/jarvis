import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTaxonomyAdjudicationReflectionReport,
  renderTaxonomyAdjudicationReflectionMarkdown,
} from "../scripts/lib/taxonomy-adjudication-reflection.js";

test("compares lexical, semantic, LLM, runtime, and human adjudication evidence", () => {
  const report = buildTaxonomyAdjudicationReflectionReport({
    decisions: [
      decision("trace_1", "unit_1", 1, {
        taxonomyAdjudicationEligible: true,
        taxonomyAdjudicationDisposition: "completed",
        taxonomyAdjudicationCandidateType: "coding",
        taxonomyAdjudicationRelation: "new-parent",
        taxonomyAdjudicationParseValid: true,
        taxonomyAdjudicationWouldRepair: true,
        taxonomyAdjudicationRepairApplied: false,
        taxonomyAdjudicationArrivalStage: "before-advisor-execution",
        taxonomyAdjudicationDurationMs: 600,
        taxonomyAdjudicationInputChars: 400,
        taxonomyAdjudicationOutputChars: 160,
        taxonomyAdjudicationProviderId: "fast-provider",
        taxonomyAdjudicationModelId: "fast-model",
        taxonomyAdjudicationProviderDisposition: "completed-with-content",
        taxonomyAdjudicationParseDisposition: "valid-json",
        taxonomyAdjudicationOutputEnvelope: "direct",
        taxonomyAdjudicationTriggerReasons: ["lexical-unknown"],
        interviewerIntentLlmSpeechAct: "directive",
        interviewerIntentLlmEvidenceMode: "hypothetical-design",
        interviewerIntentLlmAction: "answer",
      }),
      decision("trace_2", "unit_2", 1, {
        taxonomyAdjudicationEligible: true,
        taxonomyAdjudicationDisposition: "stale",
        taxonomyAdjudicationCandidateType: "ai-ml-system-design",
        taxonomyAdjudicationRelation: "new-parent",
        taxonomyAdjudicationParseValid: true,
        taxonomyAdjudicationWouldRepair: true,
        taxonomyAdjudicationArrivalStage: "post-visible-answer",
        taxonomyAdjudicationDurationMs: 1_800,
        taxonomyAdjudicationProviderDisposition: "completed-with-content",
        taxonomyAdjudicationParseDisposition: "valid-json",
        taxonomyAdjudicationOutputEnvelope: "result-wrapper",
        taxonomyAdjudicationTriggerReasons: ["semantic-conflict"],
      }),
      decision("trace_3", "unit_3", 1, {
        taxonomyAdjudicationEligible: false,
        taxonomyAdjudicationSkipReason: "high-confidence-local-classification",
      }),
    ],
    traces: [
      trace("trace_1", "unknown", "coding", "unknown"),
      trace(
        "trace_2",
        "general-system-design",
        "ai-ml-system-design",
        "general-system-design"
      ),
      trace("trace_3", "behavioral", "behavioral", "behavioral"),
    ],
    evaluations: [
      {
        id: "eval_1",
        questionId: "question_1",
        traceIds: ["trace_1"],
        correctedQuestionType: "coding",
        expectedRelation: "new-parent",
        taxonomyAdjudication: {
          needed: true,
          typeCorrect: true,
          relationCorrect: true,
          repairDisposition: "automatic-repair",
          contextPreserved: true,
          timely: true,
        },
        advisorIntent: {
          expectedAction: "advise",
        },
        updatedAt: 10,
      },
      {
        id: "eval_2",
        questionId: "question_2",
        traceIds: ["trace_2"],
        correctedQuestionType: "ai-ml-system-design",
        taxonomyAdjudication: {
          typeCorrect: true,
          repairDisposition: "suggest-only",
          timely: false,
        },
        updatedAt: 20,
      },
    ],
  });

  assert.equal(report.metrics.observedUnits, 3);
  assert.equal(report.metrics.observedOperations, 3);
  assert.equal(report.metrics.operationsWithId, 0);
  assert.equal(report.metrics.legacyFallbackOperations, 3);
  assert.equal(report.metrics.retriedUnits, 0);
  assert.equal(report.metrics.retryOperations, 0);
  assert.equal(report.metrics.maxOperationsPerUnit, 1);
  assert.equal(report.metrics.substantiveUnits, 3);
  assert.equal(report.metrics.triggeredCalls, 2);
  assert.equal(report.metrics.triggerRate, 2 / 3);
  assert.equal(report.metrics.callRateSemantics, "reason-coded-observational");
  assert.deepEqual(report.metrics.triggerReasons, {
    "lexical-unknown": 1,
    "semantic-conflict": 1,
  });
  assert.deepEqual(report.metrics.providerDispositions, {
    "completed-with-content": 2,
  });
  assert.deepEqual(report.metrics.parseDispositions, { "valid-json": 2 });
  assert.deepEqual(report.metrics.parseErrorKinds, {});
  assert.deepEqual(report.metrics.outputEnvelopes, {
    direct: 1,
    "result-wrapper": 1,
  });
  assert.equal(report.metrics.typePrecision, 1);
  assert.equal(report.metrics.relationPrecision, 1);
  assert.equal(report.metrics.actionPrecision, 1);
  assert.deepEqual(report.metrics.actionProposals, { answer: 1 });
  assert.equal(report.metrics.correctButOperationallyUnusable, 1);
  assert.equal(report.metrics.repairApplied, 0);
  assert.deepEqual(report.metrics.providers, { "fast-provider": 1 });
  assert.deepEqual(report.metrics.models, { "fast-model": 1 });
  assert.equal(report.metrics.latency.p50Ms, 600);
  assert.equal(report.metrics.latency.p95Ms, 1_800);
  assert.equal(report.funnel.transcriptionUnits.count, 3);
  assert.equal(report.funnel.substantiveUnits.count, 3);
  assert.equal(report.funnel.eligibleUnits.count, 2);
  assert.equal(report.funnel.triggeredCalls.count, 2);
  assert.equal(report.funnel.providerValidOutputs.count, 2);
  assert.equal(report.funnel.joinedHumanLabels.count, 2);
  assert.equal(report.funnel.taxonomyAgreements.count, 2);
  assert.equal(report.funnel.trajectoryAgreements.count, 1);
  assert.equal(report.funnel.actionAgreements.count, 1);
  assert.equal(report.typeConfusion.coding?.coding, 1);
  assert.match(
    renderTaxonomyAdjudicationReflectionMarkdown(report),
    /Shadow evidence only/
  );
  assert.match(
    renderTaxonomyAdjudicationReflectionMarkdown(report),
    /Observational call rate: 66\.7% \(reason-coded; not a pass\/fail target\)/
  );
});

test("retains separate operations for one LQU revision and dedupes each operation to its latest record", () => {
  const report = buildTaxonomyAdjudicationReflectionReport({
    decisions: [
      decisionAt("trace_retry_a", "unit_retry", 4, 100, {
        taxonomyAdjudicationOperationId: "operation_a",
        taxonomyAdjudicationEligible: true,
        taxonomyAdjudicationDisposition: "scheduled",
        taxonomyAdjudicationTriggerReasons: ["lexical-unknown"],
      }),
      decisionAt("trace_retry_b", "unit_retry", 4, 200, {
        taxonomyAdjudicationOperationId: "operation_b",
        taxonomyAdjudicationEligible: true,
        taxonomyAdjudicationDisposition: "stale",
        taxonomyAdjudicationProviderDisposition: "completed-with-content",
        taxonomyAdjudicationParseDisposition: "valid-json",
        taxonomyAdjudicationParseValid: true,
        taxonomyAdjudicationOutputEnvelope: "direct",
        taxonomyAdjudicationDurationMs: 500,
        taxonomyAdjudicationTriggerReasons: ["semantic-conflict"],
      }),
      decisionAt("trace_retry_a", "unit_retry", 4, 300, {
        taxonomyAdjudicationOperationId: "operation_a",
        taxonomyAdjudicationEligible: true,
        taxonomyAdjudicationDisposition: "provider-error-output",
        taxonomyAdjudicationProviderDisposition: "provider-auth-error",
        taxonomyAdjudicationParseDisposition: "not-run-provider-auth-error",
        taxonomyAdjudicationParseErrorKind: "provider",
        taxonomyAdjudicationParseValid: false,
        taxonomyAdjudicationDurationMs: 900,
        taxonomyAdjudicationTriggerReasons: ["provider-retry"],
      }),
    ],
    traces: [],
    evaluations: [],
  });

  assert.equal(report.version, 5);
  assert.equal(report.rows.length, 2);
  assert.deepEqual(
    report.rows.map((row) => row.operationId),
    ["operation_b", "operation_a"]
  );
  assert.equal(
    report.rows.find((row) => row.operationId === "operation_a")?.disposition,
    "provider-error-output"
  );
  assert.equal(report.metrics.observedOperations, 2);
  assert.equal(report.metrics.observedUnits, 1);
  assert.equal(report.metrics.operationsWithId, 2);
  assert.equal(report.metrics.legacyFallbackOperations, 0);
  assert.equal(report.metrics.retriedUnits, 1);
  assert.equal(report.metrics.retryOperations, 1);
  assert.equal(report.metrics.maxOperationsPerUnit, 2);
  assert.deepEqual(report.metrics.triggerReasons, {
    "provider-retry": 1,
    "semantic-conflict": 1,
  });
  assert.deepEqual(report.metrics.parseErrorKinds, { provider: 1 });
  assert.deepEqual(report.metrics.outputEnvelopes, { direct: 1 });
});

test("measures isolated budgets and terminal no-answer boundaries without counting semantic repair", () => {
  const report = buildTaxonomyAdjudicationReflectionReport({
    decisions: [
      decisionAt("trace_ack", "unit_shared", 1, 100, {
        taxonomyAdjudicationOperationId: "operation_ack",
        taxonomyAdjudicationEligible: true,
        taxonomyAdjudicationDisposition: "completed",
        taxonomyAdjudicationProviderDisposition: "completed-with-content",
        taxonomyAdjudicationParseDisposition: "valid-json",
        taxonomyAdjudicationParseValid: true,
        taxonomyAdjudicationDurationMs: 300,
        taxonomyAdjudicationBudgetSlot: "ambient",
        taxonomyAdjudicationBudgetReason: "ambient-discourse",
        taxonomyAdjudicationSourceOwnedSubstantive: false,
        taxonomyAdjudicationBudgetStartsBefore: 0,
        taxonomyAdjudicationBudgetStartsAfter: 1,
        taxonomyAdjudicationBudgetLimit: 1,
        taxonomyAdjudicationBudgetRemaining: 0,
        taxonomyAdjudicationAmbientStarts: 1,
        taxonomyAdjudicationSubstantiveStarts: 0,
        taxonomyAdjudicationReservedSubstantiveAvailable: true,
        currentQuestionTerminalNoAnswerDisposition: "terminal-no-answer",
        currentQuestionTerminalNoAnswerOperationKind:
          "informational-no-primary-ask",
        currentQuestionTerminalNoAnswerAuthorized: true,
        interviewerIntentLlmTerminalNoAnswerApplied: true,
        interviewerIntentLlmTerminalNoAnswerApplyReason:
          "authorized-before-visible-answer",
        interviewerIntentLlmTerminalNoAnswerAdvisorCancelled: true,
        taxonomyAdjudicationTerminalNoAnswerMemoryStarted: false,
        taxonomyAdjudicationTerminalNoAnswerModelStarted: false,
        taxonomyAdjudicationTerminalNoAnswerAvoidedMemoryOpportunity: true,
        taxonomyAdjudicationTerminalNoAnswerAvoidedModelOpportunity: true,
        taxonomyAdjudicationRepairApplied: false,
      }),
      decisionAt("trace_ack_repeat", "unit_shared", 2, 200, {
        taxonomyAdjudicationOperationId: "operation_ack_repeat",
        taxonomyAdjudicationEligible: true,
        taxonomyAdjudicationDisposition: "budget-exhausted",
        taxonomyAdjudicationBudgetSlot: "ambient",
        taxonomyAdjudicationBudgetReason: "ambient-discourse",
        taxonomyAdjudicationSourceOwnedSubstantive: false,
        taxonomyAdjudicationBudgetStartsBefore: 1,
        taxonomyAdjudicationBudgetStartsAfter: 1,
        taxonomyAdjudicationBudgetLimit: 1,
        taxonomyAdjudicationBudgetRemaining: 0,
        taxonomyAdjudicationAmbientStarts: 1,
        taxonomyAdjudicationSubstantiveStarts: 0,
        taxonomyAdjudicationReservedSubstantiveAvailable: true,
      }),
      decisionAt("trace_real_ask", "unit_new", 1, 300, {
        taxonomyAdjudicationOperationId: "operation_real_ask",
        taxonomyAdjudicationEligible: true,
        taxonomyAdjudicationDisposition: "completed",
        taxonomyAdjudicationProviderDisposition: "completed-with-content",
        taxonomyAdjudicationParseDisposition: "valid-json",
        taxonomyAdjudicationParseValid: true,
        taxonomyAdjudicationDurationMs: 450,
        taxonomyAdjudicationBudgetSlot: "substantive",
        taxonomyAdjudicationBudgetReason: "source-owned-primary-ask",
        taxonomyAdjudicationSourceOwnedSubstantive: true,
        taxonomyAdjudicationBudgetStartsBefore: 0,
        taxonomyAdjudicationBudgetStartsAfter: 1,
        taxonomyAdjudicationBudgetLimit: 1,
        taxonomyAdjudicationBudgetRemaining: 0,
        taxonomyAdjudicationAmbientStarts: 1,
        taxonomyAdjudicationSubstantiveStarts: 1,
        taxonomyAdjudicationReservedSubstantiveAvailable: false,
        taxonomyAdjudicationRepairApplied: false,
      }),
    ],
    traces: [
      {
        ...trace("trace_ack", "unknown", "unknown", "unknown"),
        startedAt: 100,
        logicalQuestionUnitId: "unit_shared",
        logicalQuestionUnitRevision: 1,
        logicalQuestionBoundaryReason:
          "terminal-no-answer-ambient-continuation",
      },
      {
        ...trace("trace_ack_repeat", "unknown", "unknown", "unknown"),
        startedAt: 200,
        logicalQuestionUnitId: "unit_shared",
        logicalQuestionUnitRevision: 2,
        logicalQuestionBoundaryReason:
          "terminal-no-answer-ambient-continuation",
      },
      {
        ...trace("trace_real_ask", "unknown", "coding", "coding"),
        startedAt: 300,
        logicalQuestionUnitId: "unit_new",
        logicalQuestionUnitRevision: 1,
        logicalQuestionBoundaryReason:
          "terminal-no-answer-substantive-boundary",
      },
    ],
    evaluations: [],
  });

  assert.equal(report.metrics.ambientTriggeredCalls, 1);
  assert.equal(report.metrics.substantiveTriggeredCalls, 1);
  assert.equal(report.metrics.ambientBudgetExhausted, 1);
  assert.equal(report.metrics.substantiveBudgetExhausted, 0);
  assert.equal(
    report.metrics.ambientCallsPreservingSubstantiveReservation,
    1
  );
  assert.equal(report.metrics.substantiveCallsAfterAmbientStart, 1);
  assert.equal(report.metrics.terminalNoAnswerCandidates, 1);
  assert.equal(report.metrics.terminalNoAnswerAuthorized, 1);
  assert.equal(report.metrics.terminalNoAnswerApplied, 1);
  assert.deepEqual(report.metrics.terminalNoAnswerOperationKinds, {
    "informational-no-primary-ask": 1,
  });
  assert.equal(report.metrics.terminalNoAnswerAdvisorCancelled, 1);
  assert.equal(
    report.metrics.terminalNoAnswerAvoidedMemoryOpportunity,
    1
  );
  assert.equal(
    report.metrics.terminalNoAnswerAvoidedModelOpportunity,
    1
  );
  assert.equal(report.metrics.terminalNoAnswerAmbientContinuations, 2);
  assert.equal(report.metrics.terminalNoAnswerSubstantiveBoundaries, 1);
  assert.equal(report.metrics.repairApplied, 0);
  assert.deepEqual(report.metrics.budgetSlots, {
    ambient: 2,
    substantive: 1,
  });
  assert.match(
    renderTaxonomyAdjudicationReflectionMarkdown(report),
    /Terminal no-answer candidates \/ authorized \/ applied: 1 \/ 1 \/ 1/
  );
  assert.match(
    renderTaxonomyAdjudicationReflectionMarkdown(report),
    /never increment repairApplied/
  );
});

test("renders call rate as reason-coded observation without a fixed threshold", () => {
  const report = buildTaxonomyAdjudicationReflectionReport({
    decisions: [
      decision("trace_all_called", "unit_all_called", 1, {
        taxonomyAdjudicationOperationId: "operation_all_called",
        taxonomyAdjudicationEligible: true,
        taxonomyAdjudicationDisposition: "completed",
        taxonomyAdjudicationProviderDisposition: "completed-with-content",
        taxonomyAdjudicationParseDisposition: "valid-json",
        taxonomyAdjudicationParseValid: true,
        taxonomyAdjudicationDurationMs: 100,
        taxonomyAdjudicationTriggerReasons: ["dense-terminal-ask"],
      }),
    ],
    traces: [],
    evaluations: [],
  });

  assert.equal(report.metrics.triggerRate, 1);
  assert.deepEqual(report.metrics.triggerReasons, {
    "dense-terminal-ask": 1,
  });
  const markdown = renderTaxonomyAdjudicationReflectionMarkdown(report);
  assert.match(
    markdown,
    /Observational call rate: 100\.0% \(reason-coded; not a pass\/fail target\)/
  );
  assert.doesNotMatch(markdown, /WARNING|within target|target <=/);
});

test("reports adjudication labels that cannot join a recorded trace", () => {
  const report = buildTaxonomyAdjudicationReflectionReport({
    decisions: [],
    traces: [],
    evaluations: [
      {
        id: "eval_missing",
        questionId: "question_missing",
        traceIds: ["trace_missing"],
        taxonomyAdjudication: { needed: true },
        updatedAt: 10,
      },
    ],
  });

  assert.deepEqual(report.unmatchedEvaluations, [
    {
      evaluationId: "eval_missing",
      questionId: "question_missing",
      traceIds: ["trace_missing"],
      expectedType: undefined,
      expectedRelation: undefined,
      reason: "missing-recorded-decision",
    },
  ]);
});

test("excludes provider authentication failures from taxonomy agreement denominators", () => {
  const report = buildTaxonomyAdjudicationReflectionReport({
    decisions: [
      decision("trace_auth", "unit_auth", 1, {
        taxonomyAdjudicationEligible: true,
        taxonomyAdjudicationDisposition: "provider-error-output",
        taxonomyAdjudicationProviderDisposition: "provider-auth-error",
        taxonomyAdjudicationParseDisposition: "not-run-provider-auth-error",
        taxonomyAdjudicationParseValid: false,
        taxonomyAdjudicationDurationMs: 10,
      }),
    ],
    traces: [trace("trace_auth", "unknown", "coding", "unknown")],
    evaluations: [
      {
        id: "eval_auth",
        questionId: "question_auth",
        traceIds: ["trace_auth"],
        correctedQuestionType: "coding",
        taxonomyAdjudication: {
          needed: true,
          typeCorrect: false,
        },
        updatedAt: 10,
      },
    ],
  });

  assert.equal(report.funnel.triggeredCalls.count, 1);
  assert.equal(report.funnel.providerValidOutputs.count, 0);
  assert.equal(report.funnel.joinedHumanLabels.count, 0);
  assert.equal(report.metrics.labeledTypeProposals, 0);
  assert.equal(report.metrics.typePrecision, null);
});

test("retains unmatched type labels even without a taxonomy adjudication block", () => {
  const report = buildTaxonomyAdjudicationReflectionReport({
    decisions: [],
    traces: [],
    evaluations: [
      {
        id: "eval_type_only",
        questionId: "question_type_only",
        traceIds: ["trace_missing"],
        correctedQuestionType: "coding",
        updatedAt: 10,
      },
    ],
  });

  assert.equal(report.unmatchedEvaluations.length, 1);
  assert.equal(report.unmatchedEvaluations[0].expectedType, "coding");
  assert.equal(
    report.unmatchedEvaluations[0].reason,
    "missing-recorded-decision"
  );
});

function decision(
  traceId: string,
  unitId: string,
  revision: number,
  metadata: Record<string, unknown>
) {
  return decisionAt(traceId, unitId, revision, revision * 100, metadata);
}

function decisionAt(
  traceId: string,
  unitId: string,
  revision: number,
  recordedAt: number,
  metadata: Record<string, unknown>
) {
  return {
    recordedAt,
    sessionId: "session_1",
    traceId,
    metadata: {
      taxonomyAdjudicationUnitId: unitId,
      taxonomyAdjudicationUnitRevision: revision,
      ...metadata,
    },
  };
}

function trace(
  traceId: string,
  keywordType: string,
  semanticCandidateType: string,
  runtimeType: string
) {
  return {
    sessionId: "session_1",
    traceId,
    canonicalQuestionType: runtimeType,
    semanticTaxonomy: {
      keywordType,
      semanticCandidateType,
      hybridOutcome: "semantic-would-rescue",
    },
  };
}
