import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTaskRelationAdjudicationReflectionReport,
  type TaskRelationAdjudicationRecordedDecision,
} from "../src/lib/meeting/task-relation-adjudication-reflection.js";
import { buildTaskRelationAuthorityConvergenceReportV1 } from "../src/lib/meeting/task-relation-authority-convergence.js";
import { buildSessionLongitudinalEvaluationReport } from "../src/lib/meeting/session-longitudinal-evaluation.js";
import type {
  HumanExpectedParentAction,
  InterviewTaskRelation,
  QuestionHumanEvaluation,
} from "../src/lib/meeting/types.js";

test("replays a reviewed child-to-resume path outside production state", () => {
  const relationReport = buildTaskRelationAdjudicationReflectionReport({
    decisions: [
      decision({
        traceId: "trace-child",
        operationId: "operation-child",
        recordedAt: 100,
        parentId: "parent-design",
        deterministicRelation: "followup-parent",
        candidateRelation: "child-probe",
      }),
      decision({
        traceId: "trace-resume",
        operationId: "operation-resume",
        recordedAt: 200,
        parentId: "parent-design",
        deterministicRelation: "followup-parent",
        candidateRelation: "resume-parent",
      }),
    ],
    evaluations: [
      evaluation({
        id: "evaluation-child",
        traceId: "trace-child",
        expectedRelation: "child-probe",
        expectedParentAction: "attach-child",
      }),
      evaluation({
        id: "evaluation-resume",
        traceId: "trace-resume",
        expectedRelation: "resume-parent",
        expectedParentAction: "resume",
      }),
    ],
    now: 300,
  });

  const report = buildTaskRelationAuthorityConvergenceReportV1({
    relationReport,
    now: 400,
  });

  assert.deepEqual(report.metrics.observed.accuracy, {
    numerator: 0,
    denominator: 2,
    rate: 0,
  });
  assert.deepEqual(report.metrics.counterfactual.accuracy, {
    numerator: 2,
    denominator: 2,
    rate: 1,
  });
  assert.equal(report.metrics.counterfactualRescues, 2);
  assert.equal(
    report.metrics.semanticCorrectProductionInapplicable,
    1
  );
  assert.deepEqual(
    report.rows.map((row) => row.counterfactualApplicability),
    ["applicable", "applicable"]
  );
  assert.equal(report.candidateBranches.length, 1);
  assert.deepEqual(
    report.candidateBranches[0]?.graph.transitions.map(
      (transition) => transition.kind
    ),
    ["child-probe", "resume-parent"]
  );
});

test("reports a false new parent as context-loss risk and regression", () => {
  const relationReport = buildTaskRelationAdjudicationReflectionReport({
    decisions: [
      decision({
        traceId: "trace-followup",
        operationId: "operation-followup",
        recordedAt: 100,
        parentId: "parent-ride-sharing",
        deterministicRelation: "followup-parent",
        candidateRelation: "new-parent",
      }),
    ],
    evaluations: [
      evaluation({
        id: "evaluation-followup",
        traceId: "trace-followup",
        expectedRelation: "followup-parent",
        expectedParentAction: "preserve",
      }),
    ],
  });

  const report = buildTaskRelationAuthorityConvergenceReportV1({
    relationReport,
    thresholds: { minimumLabeledOperations: 1 },
  });

  assert.equal(report.metrics.counterfactual.falseParent, 1);
  assert.equal(report.metrics.counterfactualRegressions, 1);
  assert.equal(report.metrics.relationContextLossRisk, 1);
  assert.equal(report.metrics.relationContaminationRisk, 0);
  assert.equal(report.graduation.status, "blocked");
  assert.equal(report.graduation.automaticReleaseAuthorized, false);
});

test("excludes an incompatible human relation and parent-action tuple", () => {
  const relationReport = buildTaskRelationAdjudicationReflectionReport({
    decisions: [
      decision({
        traceId: "trace-child",
        operationId: "operation-child",
        recordedAt: 100,
        parentId: "parent-design",
        deterministicRelation: "child-probe",
        candidateRelation: "child-probe",
      }),
    ],
    evaluations: [
      evaluation({
        id: "evaluation-child",
        traceId: "trace-child",
        expectedRelation: "child-probe",
        expectedParentAction: "preserve",
      }),
    ],
  });

  const report =
    buildTaskRelationAuthorityConvergenceReportV1({
      relationReport,
    });

  assert.equal(report.metrics.humanLabeled, 1);
  assert.equal(report.metrics.compatibleHumanLabels, 0);
  assert.equal(report.metrics.incompatibleHumanLabels, 1);
  assert.equal(report.metrics.counterfactual.accuracy.denominator, 0);
  assert.equal(report.humanExpectedBranches.length, 0);
  assert.equal(report.graduation.status, "blocked");
});

test("keeps invalid structured output out of relation accuracy", () => {
  const invalid = decision({
    traceId: "trace-invalid",
    operationId: "operation-invalid",
    recordedAt: 100,
    parentId: "parent-design",
    deterministicRelation: "followup-parent",
  });
  invalid.metadata.taskRelationAdjudicationParseValid = false;
  invalid.metadata.taskRelationAdjudicationEvidenceSpansValid = false;
  invalid.metadata.taskRelationAdjudicationParseDisposition =
    "invalid-json";
  const relationReport = buildTaskRelationAdjudicationReflectionReport({
    decisions: [invalid],
    evaluations: [
      evaluation({
        id: "evaluation-invalid",
        traceId: "trace-invalid",
        expectedRelation: "followup-parent",
        expectedParentAction: "preserve",
      }),
    ],
  });

  const report =
    buildTaskRelationAuthorityConvergenceReportV1({
      relationReport,
    });

  assert.deepEqual(report.metrics.structuredOutputValidity, {
    numerator: 0,
    denominator: 1,
    rate: 0,
  });
  assert.equal(report.metrics.semantic.accuracy.denominator, 0);
  assert.deepEqual(report.metrics.counterfactual.accuracy, {
    numerator: 0,
    denominator: 1,
    rate: 0,
  });
  assert.equal(report.graduation.status, "blocked");
});

test("keeps branch results isolated when sessions reuse an operation id", () => {
  const relationReport = buildTaskRelationAdjudicationReflectionReport({
    decisions: [
      decision({
        sessionId: "session-child",
        traceId: "trace-child",
        operationId: "operation-shared",
        recordedAt: 100,
        parentId: "parent-child",
        deterministicRelation: "followup-parent",
        candidateRelation: "child-probe",
      }),
      decision({
        sessionId: "session-resume",
        traceId: "trace-resume",
        operationId: "operation-shared",
        recordedAt: 200,
        parentId: "parent-resume",
        deterministicRelation: "followup-parent",
        candidateRelation: "resume-parent",
      }),
    ],
    evaluations: [
      evaluation({
        id: "evaluation-child",
        traceId: "trace-child",
        expectedRelation: "child-probe",
        expectedParentAction: "attach-child",
      }),
      evaluation({
        id: "evaluation-resume",
        traceId: "trace-resume",
        expectedRelation: "resume-parent",
        expectedParentAction: "resume",
      }),
    ],
  });

  const report =
    buildTaskRelationAuthorityConvergenceReportV1({
      relationReport,
    });

  assert.deepEqual(
    report.rows.map((row) => [
      row.traceId,
      row.counterfactualApplicability,
    ]),
    [
      ["trace-child", "applicable"],
      ["trace-resume", "inapplicable"],
    ]
  );
});

test("requires complete class evidence and explicit sample threshold before review", () => {
  const cases: Array<{
    relation: Exclude<InterviewTaskRelation, "logistics" | "correction" | "unknown">;
    action: HumanExpectedParentAction;
    activeChildId?: string;
  }> = [
    { relation: "new-parent", action: "create" },
    { relation: "followup-parent", action: "preserve" },
    { relation: "child-probe", action: "attach-child" },
    {
      relation: "resume-parent",
      action: "resume",
      activeChildId: "child-existing",
    },
  ];
  const decisions = cases.map((item, index) =>
    decision({
      traceId: `trace-${item.relation}`,
      operationId: `operation-${item.relation}`,
      recordedAt: 100 + index,
      parentId: `parent-${item.relation}`,
      activeChildId: item.activeChildId,
      deterministicRelation: item.relation,
      candidateRelation: item.relation,
    })
  );
  const evaluations = cases.map((item) =>
    evaluation({
      id: `evaluation-${item.relation}`,
      traceId: `trace-${item.relation}`,
      expectedRelation: item.relation,
      expectedParentAction: item.action,
    })
  );
  const relationReport = buildTaskRelationAdjudicationReflectionReport({
    decisions,
    evaluations,
  });

  const withoutMinimum =
    buildTaskRelationAuthorityConvergenceReportV1({
      relationReport,
    });
  const withMinimum =
    buildTaskRelationAuthorityConvergenceReportV1({
      relationReport,
      thresholds: { minimumLabeledOperations: 4 },
    });

  assert.equal(
    withoutMinimum.graduation.status,
    "insufficient-evidence"
  );
  assert.equal(
    withMinimum.graduation.status,
    "eligible-for-manual-review"
  );
  assert.equal(
    withMinimum.graduation.automaticReleaseAuthorized,
    false
  );
  assert.deepEqual(withMinimum.metrics.counterfactual.accuracy, {
    numerator: 4,
    denominator: 4,
    rate: 1,
  });
});

test("feeds convergence denominators into longitudinal evaluation", () => {
  const relationReport = buildTaskRelationAdjudicationReflectionReport({
    decisions: [
      decision({
        traceId: "trace-followup",
        operationId: "operation-followup",
        recordedAt: 100,
        parentId: "parent-design",
        deterministicRelation: "followup-parent",
        candidateRelation: "followup-parent",
      }),
    ],
    evaluations: [
      evaluation({
        id: "evaluation-followup",
        traceId: "trace-followup",
        expectedRelation: "followup-parent",
        expectedParentAction: "preserve",
      }),
    ],
  });
  const convergence =
    buildTaskRelationAuthorityConvergenceReportV1({
      relationReport,
    });

  const report = buildSessionLongitudinalEvaluationReport([
    {
      directory: "/recordings/session-convergence",
      manifest: { sessionId: "session-convergence" },
      transcriptTurns: [],
      traceSummaries: [],
      questionEvaluations: [],
      taskRelationAdjudicationReport: relationReport,
      taskRelationConvergenceReport: convergence,
    },
  ]);

  assert.deepEqual(
    report.relationAdjudicationFunnel.counterfactualAccuracy,
    {
      numerator: 1,
      denominator: 1,
      rate: 1,
    }
  );
  assert.equal(
    report.relationAdjudicationFunnel.graduation[
      "insufficient-evidence"
    ],
    1
  );
});

function decision(input: {
  sessionId?: string;
  traceId: string;
  operationId: string;
  recordedAt: number;
  parentId: string;
  activeChildId?: string;
  deterministicRelation: InterviewTaskRelation;
  candidateRelation?: InterviewTaskRelation;
}): TaskRelationAdjudicationRecordedDecision {
  return {
    recordedAt: input.recordedAt,
    sessionId: input.sessionId ?? "session-convergence",
    traceId: input.traceId,
    taskId: input.parentId,
    metadata: {
      taskRelationAdjudicationOperationId: input.operationId,
      taskRelationAdjudicationUnitId: `lqu-${input.operationId}`,
      taskRelationAdjudicationUnitRevision: 1,
      taskRelationAdjudicationParentId: input.parentId,
      taskRelationAdjudicationParentRevision: 3,
      taskRelationAdjudicationActiveChildId: input.activeChildId,
      taskRelationAdjudicationRecentSourceEvidenceTurnIds: [
        `turn-${input.operationId}`,
      ],
      taskRelationAdjudicationDeterministicRelation:
        input.deterministicRelation,
      taskRelationAdjudicationCandidateRelation:
        input.candidateRelation,
      taskRelationAdjudicationConfidence: input.candidateRelation
        ? 0.98
        : undefined,
      taskRelationAdjudicationDisposition: "shadow-observed",
      taskRelationAdjudicationParseDisposition:
        input.candidateRelation ? "valid-json" : "not-run",
      taskRelationAdjudicationParseValid: Boolean(
        input.candidateRelation
      ),
      taskRelationAdjudicationEvidenceSpansValid: Boolean(
        input.candidateRelation
      ),
      taskRelationAdjudicationAppliedToRuntime: false,
    },
  };
}

function evaluation(input: {
  id: string;
  traceId: string;
  expectedRelation: InterviewTaskRelation;
  expectedParentAction: HumanExpectedParentAction;
}): QuestionHumanEvaluation {
  const empty = { verdict: "not_applicable" as const, reasons: [] };
  return {
    id: input.id,
    sessionId: "session-convergence",
    questionId: `question-${input.id}`,
    traceIds: [input.traceId],
    expectedRelation: input.expectedRelation,
    expectedParentAction: input.expectedParentAction,
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
    memoryEntryLabels: [],
    missingExpectedMemory: [],
    createdAt: 1,
    updatedAt: 1,
  };
}
