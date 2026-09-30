import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskRelationAdjudicationReflectionReport } from "../scripts/lib/task-relation-adjudication-reflection.js";
import type { QuestionHumanEvaluation } from "../src/lib/meeting/types.js";

test("aggregates independent relation agreement and labeled failure modes", () => {
  const report = buildTaskRelationAdjudicationReflectionReport({
    decisions: [
      decision("trace_1", "operation_1", {
        taskRelationAdjudicationDeterministicRelation: "followup-parent",
        taskRelationAdjudicationCandidateRelation: "new-parent",
        taskRelationAdjudicationComparisonEligible: true,
        taskRelationAdjudicationComparisonOutcome: "disagreement",
        taskRelationAdjudicationDisposition: "shadow-observed",
        taskRelationAdjudicationDurationMs: 250,
        taskRelationAdjudicationAppliedToRuntime: false,
      }),
      decision("trace_2", "operation_2", {
        taskRelationAdjudicationDeterministicRelation: "resume-parent",
        taskRelationAdjudicationCandidateRelation: "resume-parent",
        taskRelationAdjudicationComparisonEligible: true,
        taskRelationAdjudicationComparisonOutcome: "agreement",
        taskRelationAdjudicationDisposition: "shadow-observed",
        taskRelationAdjudicationDurationMs: 400,
        taskRelationAdjudicationAppliedToRuntime: false,
      }),
    ],
    evaluations: [
      evaluation("evaluation_1", "trace_1", "followup-parent", "preserve", {
        contextOutcome: "contaminated",
      }),
      evaluation("evaluation_2", "trace_2", "resume-parent", "resume"),
    ],
    now: 1_000,
  });

  assert.deepEqual(report.metrics.deterministicAgreement, {
    numerator: 1,
    denominator: 2,
    rate: 0.5,
  });
  assert.deepEqual(report.metrics.llmAccuracy, {
    numerator: 1,
    denominator: 2,
    rate: 0.5,
  });
  assert.equal(report.metrics.falseParent, 1);
  assert.equal(report.metrics.falseResume, 0);
  assert.equal(report.metrics.contextContamination, 1);
  assert.equal(report.metrics.mutationApplied, 0);
  assert.equal(report.metrics.latencyMs.p50Ms, 250);
  assert.equal(report.metrics.latencyMs.p95Ms, 400);
});

test("uses latest operation record and excludes unavailable candidates", () => {
  const first = decision("trace_1", "operation_1", {
    taskRelationAdjudicationDisposition: "scheduled",
  });
  const latest = {
    ...decision("trace_1", "operation_1", {
      taskRelationAdjudicationDisposition: "stale",
      taskRelationAdjudicationStaleReason: "revision-changed",
    }),
    recordedAt: first.recordedAt + 10,
  };
  const report = buildTaskRelationAdjudicationReflectionReport({
    decisions: [first, latest],
    evaluations: [
      evaluation("evaluation_1", "trace_1", "child-probe", "attach-child"),
    ],
  });

  assert.equal(report.metrics.operations, 1);
  assert.equal(report.metrics.candidateAvailable, 0);
  assert.equal(report.metrics.stale, 1);
  assert.equal(report.metrics.llmAccuracy.denominator, 0);
});

test("preserves lineage, parse validity, and production applicability for branch replay", () => {
  const report = buildTaskRelationAdjudicationReflectionReport({
    decisions: [
      decision("trace_resume", "operation_resume", {
        taskRelationAdjudicationUnitId: "lqu_resume",
        taskRelationAdjudicationUnitRevision: 4,
        taskRelationAdjudicationParentId: "parent_design",
        taskRelationAdjudicationParentRevision: 7,
        taskRelationAdjudicationRecentSourceEvidenceTurnIds: [
          "turn_question",
          "turn_followup",
        ],
        taskRelationAdjudicationDeterministicRelation:
          "followup-parent",
        taskRelationAdjudicationCandidateRelation: "resume-parent",
        taskRelationAdjudicationConfidence: 0.94,
        taskRelationAdjudicationParseDisposition: "valid-json",
        taskRelationAdjudicationParseValid: true,
        taskRelationAdjudicationEvidenceSpansValid: true,
        taskRelationAdjudicationDisposition: "shadow-observed",
      }),
    ],
    evaluations: [
      evaluation(
        "evaluation_resume",
        "trace_resume",
        "resume-parent",
        "resume"
      ),
    ],
  });

  assert.deepEqual(
    {
      recordedAt: report.rows[0]?.recordedAt,
      logicalQuestionUnitId:
        report.rows[0]?.logicalQuestionUnitId,
      logicalQuestionUnitRevision:
        report.rows[0]?.logicalQuestionUnitRevision,
      parentId: report.rows[0]?.parentId,
      parentRevision: report.rows[0]?.parentRevision,
      sourceTurnIds: report.rows[0]?.sourceTurnIds,
      candidateConfidence: report.rows[0]?.candidateConfidence,
      semanticValidity: report.rows[0]?.semanticValidity,
      productionApplicability:
        report.rows[0]?.productionApplicability,
      productionApplicabilityReason:
        report.rows[0]?.productionApplicabilityReason,
    },
    {
      recordedAt: 100,
      logicalQuestionUnitId: "lqu_resume",
      logicalQuestionUnitRevision: 4,
      parentId: "parent_design",
      parentRevision: 7,
      sourceTurnIds: ["turn_question", "turn_followup"],
      candidateConfidence: 0.94,
      semanticValidity: "valid",
      productionApplicability: "inapplicable",
      productionApplicabilityReason:
        "resume-requires-active-child-binding",
    }
  );
});

test("aggregates split relation results and active-child owner identity", () => {
  const expected = evaluation(
    "evaluation_split_resume",
    "trace_split_resume",
    "resume-parent",
    "resume"
  );
  expected.expectedParentId = "parent_design";
  expected.expectedBranchId = "parent_design";
  expected.expectedContextOwnerId = "parent_design";
  const report = buildTaskRelationAdjudicationReflectionReport({
    decisions: [
      decision("trace_split_resume", "operation_split_resume", {
        taskRelationAdjudicationParentId: "parent_design",
        taskRelationAdjudicationActiveChildId: "child_hnsw",
        taskRelationChildAffinityDecision: "unrelated",
        taskRelationChildAffinityConfidence: 0.98,
        taskRelationParentAffinityDecision: "related",
        taskRelationParentAffinityConfidence: 0.99,
        taskRelationSplitCanonicalRelation: "resume-parent",
        taskRelationSplitCanonicalConfidence: 0.98,
        taskRelationFirstBatchReleasedRelation: "resume-parent",
        effectiveCurrentQuestionSettlementRelation: "resume-parent",
        effectiveCurrentQuestionSettlementParentId: "parent_design",
        effectiveCurrentQuestionSettlementChildId: undefined,
        effectiveCurrentQuestionContextReadScope: "active-parent-read",
        taskRelationAdjudicationDisposition: "shadow-observed",
      }),
    ],
    evaluations: [expected],
  });

  assert.deepEqual(report.metrics.splitCanonicalAccuracy, {
    numerator: 1,
    denominator: 1,
    rate: 1,
  });
  assert.deepEqual(report.metrics.firstBatchReleaseAccuracy, {
    numerator: 1,
    denominator: 1,
    rate: 1,
  });
  assert.equal(report.metrics.childAffinityAvailable, 1);
  assert.equal(report.metrics.parentAffinityAvailable, 1);
  assert.equal(report.metrics.activeChildOperations, 1);
  assert.deepEqual(report.metrics.activeChildAffinityCoverage, {
    numerator: 1,
    denominator: 1,
    rate: 1,
  });
  assert.deepEqual(report.metrics.parentIdentityAccuracy, {
    numerator: 1,
    denominator: 1,
    rate: 1,
  });
  assert.deepEqual(report.metrics.branchIdentityAccuracy, {
    numerator: 1,
    denominator: 1,
    rate: 1,
  });
  assert.deepEqual(report.metrics.contextOwnerAccuracy, {
    numerator: 1,
    denominator: 1,
    rate: 1,
  });
});

function decision(
  traceId: string,
  operationId: string,
  metadata: Record<string, unknown>
) {
  return {
    recordedAt: 100,
    sessionId: "session_1",
    traceId,
    taskId: "task_1",
    metadata: {
      taskRelationAdjudicationOperationId: operationId,
      ...metadata,
    },
  };
}

function evaluation(
  id: string,
  traceId: string,
  expectedRelation: QuestionHumanEvaluation["expectedRelation"],
  expectedParentAction: QuestionHumanEvaluation["expectedParentAction"],
  taxonomyAdjudication?: QuestionHumanEvaluation["taxonomyAdjudication"]
): QuestionHumanEvaluation {
  const empty = { verdict: "not_applicable" as const, reasons: [] };
  return {
    id,
    sessionId: "session_1",
    questionId: `question_${id}`,
    traceIds: [traceId],
    expectedRelation,
    expectedParentAction,
    selectedDiagramOverlayIds: [],
    classification: { ...empty },
    playbook: { ...empty },
    playbookPhase: { ...empty },
    memory: { ...empty },
    whiteboard: { ...empty },
    manualPhaseTransition: { ...empty },
    diagramOverlay: { ...empty },
    guardrail: { ...empty },
    answer: { ...empty },
    taxonomyAdjudication,
    memoryEntryLabels: [],
    missingExpectedMemory: [],
    createdAt: 1,
    updatedAt: 1,
  };
}
