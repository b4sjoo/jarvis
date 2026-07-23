import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTaxonomyAdjudicationReflectionReport,
  renderTaxonomyAdjudicationReflectionMarkdown,
} from "../src/lib/meeting/taxonomy-adjudication-reflection.js";

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
        taxonomyAdjudicationTriggerReasons: ["lexical-unknown"],
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
        correctedRelation: "new-parent",
        taxonomyAdjudication: {
          needed: true,
          typeCorrect: true,
          relationCorrect: true,
          repairDisposition: "automatic-repair",
          contextPreserved: true,
          timely: true,
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
  assert.equal(report.metrics.substantiveUnits, 3);
  assert.equal(report.metrics.triggeredCalls, 2);
  assert.equal(report.metrics.triggerRate, 2 / 3);
  assert.equal(report.metrics.triggerRateWarning, true);
  assert.equal(report.metrics.triggerRateTarget, 0.15);
  assert.deepEqual(report.metrics.triggerReasons, {
    "lexical-unknown": 1,
    "semantic-conflict": 1,
  });
  assert.deepEqual(report.metrics.providerDispositions, {
    "completed-with-content": 2,
  });
  assert.deepEqual(report.metrics.parseDispositions, { "valid-json": 2 });
  assert.equal(report.metrics.typePrecision, 1);
  assert.equal(report.metrics.relationPrecision, 1);
  assert.equal(report.metrics.correctButOperationallyUnusable, 1);
  assert.equal(report.metrics.repairApplied, 0);
  assert.deepEqual(report.metrics.providers, { "fast-provider": 1 });
  assert.deepEqual(report.metrics.models, { "fast-model": 1 });
  assert.equal(report.metrics.latency.p50Ms, 600);
  assert.equal(report.metrics.latency.p95Ms, 1_800);
  assert.equal(report.typeConfusion.coding?.coding, 1);
  assert.match(
    renderTaxonomyAdjudicationReflectionMarkdown(report),
    /Shadow evidence only/
  );
  assert.match(
    renderTaxonomyAdjudicationReflectionMarkdown(report),
    /Trigger-rate review: WARNING/
  );
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
    },
  ]);
});

function decision(
  traceId: string,
  unitId: string,
  revision: number,
  metadata: Record<string, unknown>
) {
  return {
    recordedAt: revision * 100,
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
