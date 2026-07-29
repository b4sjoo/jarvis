import {
  buildTaskRelationCounterfactualBranchV1,
  type TaskRelationCounterfactualBranchV1,
  type TaskRelationCounterfactualOperationResultV1,
  type TaskRelationCounterfactualOperationV1,
} from "./task-relation-counterfactual-branch.js";
import type {
  TaskRelationAdjudicationReflectionReport,
  TaskRelationAdjudicationReflectionRow,
  TaskRelationRateMetric,
} from "./task-relation-adjudication-reflection.js";
import type { RuntimeTaskRelation } from "./task-relation-adjudication.js";
import type { HumanExpectedParentAction } from "./types.js";

export const TASK_RELATION_CONVERGENCE_REPORT_VERSION = 1 as const;

const SCORABLE_RELATIONS = [
  "new-parent",
  "followup-parent",
  "child-probe",
  "resume-parent",
] as const;

type ScorableRelation = (typeof SCORABLE_RELATIONS)[number];

export interface TaskRelationConvergenceThresholds {
  relationAccuracy: number;
  newParentPrecision: number;
  structuredOutputValidity: number;
  minimumLabeledOperations?: number;
}

export interface TaskRelationConvergenceRow {
  operationId?: string;
  traceId: string;
  expectedRelation?: ScorableRelation;
  expectedParentAction?: HumanExpectedParentAction;
  expectedTupleCompatible?: boolean;
  observedProductionDecision?: ScorableRelation;
  semanticCandidate?: RuntimeTaskRelation;
  semanticCorrect?: boolean;
  productionApplicability:
    | "applicable"
    | "inapplicable"
    | "not-evaluated";
  counterfactualApplicability?:
    | "applicable"
    | "inapplicable"
    | "not-evaluated";
  humanPathApplicability?:
    | "applicable"
    | "inapplicable"
    | "not-evaluated";
  observedCorrect?: boolean;
  counterfactualPathCorrect?: boolean;
  counterfactualRescue: boolean;
  counterfactualRegression: boolean;
  semanticCorrectProductionInapplicable: boolean;
  relationContextLossRisk: boolean;
  relationContaminationRisk: boolean;
  stale: boolean;
  mutationApplied: boolean;
  contextOutcome?: "correct" | "contaminated" | "missing";
  counterfactualReason?: string;
  humanPathReason?: string;
}

export interface TaskRelationConvergenceGate {
  id: string;
  evaluated: boolean;
  passed?: boolean;
  actual: number | null;
  requirement: string;
}

export interface TaskRelationProjectionMetrics {
  accuracy: TaskRelationRateMetric;
  newParentPrecision: TaskRelationRateMetric;
  falseParent: number;
  falseChild: number;
  falseResume: number;
}

export interface TaskRelationAuthorityConvergenceReportV1 {
  version: typeof TASK_RELATION_CONVERGENCE_REPORT_VERSION;
  generatedAt: number;
  thresholds: TaskRelationConvergenceThresholds;
  metrics: {
    operations: number;
    humanLabeled: number;
    compatibleHumanLabels: number;
    incompatibleHumanLabels: number;
    expectedClassCoverage: Record<ScorableRelation, number>;
    structuredOutputValidity: TaskRelationRateMetric;
    observed: TaskRelationProjectionMetrics;
    semantic: TaskRelationProjectionMetrics;
    counterfactual: TaskRelationProjectionMetrics;
    counterfactualJoined: number;
    humanPathJoined: number;
    humanPathInapplicable: number;
    candidatePathInapplicable: number;
    semanticCorrectProductionInapplicable: number;
    counterfactualRescues: number;
    counterfactualRegressions: number;
    relationContextLossRisk: number;
    relationContaminationRisk: number;
    observedContextLoss: number;
    observedContextContamination: number;
    stale: number;
    staleMutationApplied: number;
    shadowMutationApplied: number;
    unmatchedEvaluationCount: number;
  };
  graduation: {
    status:
      | "insufficient-evidence"
      | "blocked"
      | "eligible-for-manual-review";
    automaticReleaseAuthorized: false;
    reasons: string[];
    gates: TaskRelationConvergenceGate[];
  };
  rows: TaskRelationConvergenceRow[];
  candidateBranches: TaskRelationCounterfactualBranchV1[];
  humanExpectedBranches: TaskRelationCounterfactualBranchV1[];
}

export function buildTaskRelationAuthorityConvergenceReportV1(input: {
  relationReport: TaskRelationAdjudicationReflectionReport;
  thresholds?: Partial<TaskRelationConvergenceThresholds>;
  now?: number;
}): TaskRelationAuthorityConvergenceReportV1 {
  const thresholds: TaskRelationConvergenceThresholds = {
    relationAccuracy: 0.95,
    newParentPrecision: 0.97,
    structuredOutputValidity: 0.99,
    ...input.thresholds,
  };
  const branches = buildRelationEvaluationBranches(
    input.relationReport
  );
  const candidateResults = indexBranchResults(
    branches.candidateBranches
  );
  const humanResults = indexBranchResults(
    branches.humanExpectedBranches
  );
  const rows = input.relationReport.rows.map((row) => {
    const resultKey = relationResultKey(row);
    return buildConvergenceRow({
      row,
      candidateResult: resultKey
        ? candidateResults.get(resultKey)
        : undefined,
      humanResult: resultKey
        ? humanResults.get(resultKey)
        : undefined,
    });
  });
  const compatibleRows = rows.filter(
    (row) => row.expectedTupleCompatible === true
  );
  const parseRows = input.relationReport.rows.filter(
    (row) => row.parseAttempted
  );
  const structuredOutputValidity = rate(
    parseRows.filter((row) => row.semanticValidity === "valid").length,
    parseRows.length
  );
  const observed = projectionMetrics(
    compatibleRows,
    (row) => row.observedProductionDecision,
    (row) => row.observedCorrect
  );
  const semantic = projectionMetrics(
    compatibleRows,
    (row) => toScorableRelation(row.semanticCandidate),
    (row) => row.semanticCorrect
  );
  const counterfactual = projectionMetrics(
    compatibleRows.filter(
      (row) => row.humanPathApplicability === "applicable"
    ),
    (row) =>
      row.counterfactualApplicability === "applicable"
        ? toScorableRelation(row.semanticCandidate)
        : undefined,
    (row) => row.counterfactualPathCorrect,
    true
  );
  const expectedClassCoverage = Object.fromEntries(
    SCORABLE_RELATIONS.map((relation) => [
      relation,
      compatibleRows.filter(
        (row) => row.expectedRelation === relation
      ).length,
    ])
  ) as Record<ScorableRelation, number>;
  const metrics = {
    operations: rows.length,
    humanLabeled: rows.filter((row) => row.expectedRelation).length,
    compatibleHumanLabels: compatibleRows.length,
    incompatibleHumanLabels: rows.filter(
      (row) => row.expectedTupleCompatible === false
    ).length,
    expectedClassCoverage,
    structuredOutputValidity,
    observed,
    semantic,
    counterfactual,
    counterfactualJoined: rows.filter(
      (row) => row.counterfactualApplicability
    ).length,
    humanPathJoined: rows.filter(
      (row) => row.humanPathApplicability
    ).length,
    humanPathInapplicable: rows.filter(
      (row) => row.humanPathApplicability === "inapplicable"
    ).length,
    candidatePathInapplicable: rows.filter(
      (row) => row.counterfactualApplicability === "inapplicable"
    ).length,
    semanticCorrectProductionInapplicable: rows.filter(
      (row) => row.semanticCorrectProductionInapplicable
    ).length,
    counterfactualRescues: rows.filter(
      (row) => row.counterfactualRescue
    ).length,
    counterfactualRegressions: rows.filter(
      (row) => row.counterfactualRegression
    ).length,
    relationContextLossRisk: rows.filter(
      (row) => row.relationContextLossRisk
    ).length,
    relationContaminationRisk: rows.filter(
      (row) => row.relationContaminationRisk
    ).length,
    observedContextLoss: rows.filter(
      (row) => row.contextOutcome === "missing"
    ).length,
    observedContextContamination: rows.filter(
      (row) => row.contextOutcome === "contaminated"
    ).length,
    stale: rows.filter((row) => row.stale).length,
    staleMutationApplied: rows.filter(
      (row) => row.stale && row.mutationApplied
    ).length,
    shadowMutationApplied: rows.filter(
      (row) => row.mutationApplied
    ).length,
    unmatchedEvaluationCount:
      input.relationReport.metrics.unmatchedEvaluationCount,
  };
  const graduation = evaluateGraduation(metrics, thresholds);

  return {
    version: TASK_RELATION_CONVERGENCE_REPORT_VERSION,
    generatedAt: input.now ?? Date.now(),
    thresholds,
    metrics,
    graduation,
    rows,
    candidateBranches: branches.candidateBranches,
    humanExpectedBranches: branches.humanExpectedBranches,
  };
}

export function renderTaskRelationAuthorityConvergenceMarkdown(
  report: TaskRelationAuthorityConvergenceReportV1
) {
  const { metrics } = report;
  const lines = [
    "# Task Relation Authority Convergence",
    "",
    `- Status: ${report.graduation.status}`,
    "- Automatic release authorized: no",
    `- Operations / compatible labels: ${metrics.operations} / ${metrics.compatibleHumanLabels}`,
    `- Structured output validity: ${formatRate(metrics.structuredOutputValidity)}`,
    `- Observed decision accuracy: ${formatRate(metrics.observed.accuracy)}`,
    `- Semantic candidate accuracy: ${formatRate(metrics.semantic.accuracy)}`,
    `- Counterfactual path accuracy: ${formatRate(metrics.counterfactual.accuracy)}`,
    `- Semantic new-parent precision: ${formatRate(metrics.semantic.newParentPrecision)}`,
    `- Counterfactual rescues / regressions: ${metrics.counterfactualRescues} / ${metrics.counterfactualRegressions}`,
    `- Semantic-correct but production-inapplicable / counterfactual-inapplicable / human-path-inapplicable: ${metrics.semanticCorrectProductionInapplicable} / ${metrics.candidatePathInapplicable} / ${metrics.humanPathInapplicable}`,
    `- Context-loss / contamination risk: ${metrics.relationContextLossRisk} / ${metrics.relationContaminationRisk}`,
    `- Stale / stale mutation / Shadow mutation: ${metrics.stale} / ${metrics.staleMutationApplied} / ${metrics.shadowMutationApplied}`,
    `- Incompatible labels / unmatched labels: ${metrics.incompatibleHumanLabels} / ${metrics.unmatchedEvaluationCount}`,
    "",
    "## Graduation Gates",
    "",
    "| Gate | Evaluated | Passed | Actual | Requirement |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const gate of report.graduation.gates) {
    lines.push(
      `| ${gate.id} | ${gate.evaluated ? "yes" : "no"} | ${
        gate.passed === undefined ? "-" : gate.passed ? "yes" : "no"
      } | ${gate.actual ?? "-"} | ${gate.requirement} |`
    );
  }
  lines.push("", "## Rows", "");
  lines.push(
    "| Operation | Observed | Shadow | Expected | Production | Counterfactual | Result |"
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const row of report.rows) {
    lines.push(
      `| ${row.operationId ?? row.traceId} | ${row.observedProductionDecision ?? "-"} | ${row.semanticCandidate ?? "-"} | ${row.expectedRelation ?? "-"} | ${row.productionApplicability} | ${row.counterfactualApplicability ?? "-"} | ${
        row.counterfactualPathCorrect === undefined
          ? "-"
          : row.counterfactualPathCorrect
            ? "correct"
            : "incorrect"
      } |`
    );
  }
  return `${lines.join("\n")}\n`;
}

function buildRelationEvaluationBranches(
  report: TaskRelationAdjudicationReflectionReport
) {
  const groups = new Map<string, TaskRelationAdjudicationReflectionRow[]>();
  for (const row of report.rows) {
    if (!row.operationId || !row.sessionId || !row.parentId) continue;
    const key = JSON.stringify([
      row.sessionId,
      row.parentId,
      row.activeChildId ?? "no-child",
    ]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const candidateBranches: TaskRelationCounterfactualBranchV1[] = [];
  const humanExpectedBranches: TaskRelationCounterfactualBranchV1[] = [];
  for (const rows of groups.values()) {
    const ordered = [...rows].sort(
      (left, right) =>
        left.recordedAt - right.recordedAt ||
        (left.operationId ?? "").localeCompare(
          right.operationId ?? ""
        )
    );
    const first = ordered[0];
    if (!first?.sessionId || !first.parentId) continue;
    const initialState = {
      parent: {
        id: first.parentId,
        revision: first.parentRevision,
      },
      child: first.activeChildId
        ? { id: first.activeChildId, revision: 1 }
        : undefined,
    };
    const knownSourceRefs = uniqueStrings(
      ordered.flatMap((row) => [
        `trace:${row.traceId}`,
        ...row.sourceTurnIds.map((id) => `turn:${id}`),
      ])
    );
    const source = {
      manifestHash: `relation-decisions:${first.sessionId}`,
      recordingSchemaVersion: 0,
      traceSummaryVersion: 0,
      builderVersion: "task-relation-convergence-v1",
    };
    const candidateOperations = ordered
      .map(toCandidateOperation)
      .filter(
        (
          operation
        ): operation is TaskRelationCounterfactualOperationV1 =>
          Boolean(operation)
      );
    if (candidateOperations.length) {
      candidateBranches.push(
        buildTaskRelationCounterfactualBranchV1({
          schemaVersion: 1,
          sessionId: first.sessionId,
          initialState,
          source,
          operations: candidateOperations,
          knownSourceRefs,
          generatedAt: latestRecordedAt(ordered),
        })
      );
    }
    const humanOperations = ordered
      .map(toHumanExpectedOperation)
      .filter(
        (
          operation
        ): operation is TaskRelationCounterfactualOperationV1 =>
          Boolean(operation)
      );
    if (humanOperations.length) {
      humanExpectedBranches.push(
        buildTaskRelationCounterfactualBranchV1({
          schemaVersion: 1,
          sessionId: first.sessionId,
          initialState,
          source,
          operations: humanOperations,
          knownSourceRefs,
          generatedAt: latestRecordedAt(ordered),
        })
      );
    }
  }
  return { candidateBranches, humanExpectedBranches };
}

function toCandidateOperation(
  row: TaskRelationAdjudicationReflectionRow
): TaskRelationCounterfactualOperationV1 | undefined {
  const relation = toRuntimeRelation(row.candidateRelation);
  if (!row.operationId || !row.sessionId || !row.parentId || !relation) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    operationId: row.operationId,
    sessionId: row.sessionId,
    occurredAt: row.recordedAt,
    traceId: row.traceId,
    logicalQuestionUnitId:
      row.logicalQuestionUnitId ?? `trace:${row.traceId}`,
    logicalQuestionRevision: row.logicalQuestionUnitRevision ?? 0,
    candidateRelation: relation,
    semanticValidity: row.semanticValidity,
    productionApplicability: row.productionApplicability,
    productionApplicabilityReason:
      row.productionApplicabilityReason,
    admission:
      isCompatibleHumanTuple(row) === true
        ? "reviewed-shadow"
        : "unreviewed",
    stale: row.stale,
    confidence: row.candidateConfidence,
    sourceParentId: row.parentId,
    sourceParentRevision: row.parentRevision,
    sourceTurnIds: row.sourceTurnIds,
  };
}

function toHumanExpectedOperation(
  row: TaskRelationAdjudicationReflectionRow
): TaskRelationCounterfactualOperationV1 | undefined {
  const relation = toScorableRelation(row.expectedRelation);
  if (
    !row.operationId ||
    !row.sessionId ||
    !row.parentId ||
    !relation ||
    isCompatibleHumanTuple(row) !== true
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    operationId: row.operationId,
    sessionId: row.sessionId,
    occurredAt: row.recordedAt,
    traceId: row.traceId,
    logicalQuestionUnitId:
      row.logicalQuestionUnitId ?? `trace:${row.traceId}`,
    logicalQuestionRevision: row.logicalQuestionUnitRevision ?? 0,
    candidateRelation: relation,
    semanticValidity: "valid",
    productionApplicability: "not-evaluated",
    productionApplicabilityReason: "human-expected-path",
    admission: "human-expected",
    sourceParentId: row.parentId,
    sourceParentRevision: row.parentRevision,
    questionType: row.expectedQuestionType,
    sourceTurnIds: row.sourceTurnIds,
  };
}

function buildConvergenceRow(input: {
  row: TaskRelationAdjudicationReflectionRow;
  candidateResult?: TaskRelationCounterfactualOperationResultV1;
  humanResult?: TaskRelationCounterfactualOperationResultV1;
}): TaskRelationConvergenceRow {
  const expectedRelation = toScorableRelation(
    input.row.expectedRelation
  );
  const expectedTupleCompatible = expectedRelation
    ? isCompatibleHumanTuple(input.row)
    : undefined;
  const observedProductionDecision = toScorableRelation(
    input.row.deterministicRelation
  );
  const semanticCandidate = toRuntimeRelation(
    input.row.candidateRelation
  );
  const scorable =
    expectedRelation && expectedTupleCompatible === true;
  const observedCorrect =
    scorable && observedProductionDecision
      ? observedProductionDecision === expectedRelation
      : undefined;
  const semanticCorrect =
    scorable && semanticCandidate
      ? semanticCandidate === expectedRelation
      : undefined;
  const humanPathApplicable =
    input.humanResult?.counterfactualShadowApplicability ===
    "applicable";
  const candidatePathApplicable =
    input.candidateResult?.counterfactualShadowApplicability ===
    "applicable";
  const counterfactualPathCorrect =
    scorable && humanPathApplicable
      ? candidatePathApplicable && semanticCandidate
        ? semanticCandidate === expectedRelation
        : false
      : undefined;
  const relationContextLossRisk = Boolean(
    scorable &&
      humanPathApplicable &&
      (input.candidateResult?.counterfactualShadowApplicability ===
        "inapplicable" ||
        (semanticCandidate === "new-parent" &&
          expectedRelation !== "new-parent"))
  );
  const relationContaminationRisk = Boolean(
    scorable &&
      humanPathApplicable &&
      expectedRelation === "new-parent" &&
      semanticCandidate &&
      semanticCandidate !== "new-parent" &&
      candidatePathApplicable
  );

  return {
    operationId: input.row.operationId,
    traceId: input.row.traceId,
    expectedRelation,
    expectedParentAction: input.row.expectedParentAction,
    expectedTupleCompatible,
    observedProductionDecision,
    semanticCandidate,
    semanticCorrect,
    productionApplicability: input.row.productionApplicability,
    counterfactualApplicability:
      input.candidateResult?.counterfactualShadowApplicability,
    humanPathApplicability:
      input.humanResult?.counterfactualShadowApplicability,
    observedCorrect,
    counterfactualPathCorrect,
    counterfactualRescue:
      observedCorrect === false &&
      counterfactualPathCorrect === true,
    counterfactualRegression:
      observedCorrect === true &&
      counterfactualPathCorrect === false,
    semanticCorrectProductionInapplicable:
      semanticCorrect === true &&
      input.row.productionApplicability === "inapplicable",
    relationContextLossRisk,
    relationContaminationRisk,
    stale: input.row.stale,
    mutationApplied: input.row.mutationApplied,
    contextOutcome: input.row.contextOutcome,
    counterfactualReason: input.candidateResult?.reason,
    humanPathReason: input.humanResult?.reason,
  };
}

function projectionMetrics(
  rows: TaskRelationConvergenceRow[],
  prediction: (
    row: TaskRelationConvergenceRow
  ) => ScorableRelation | undefined,
  correctness: (
    row: TaskRelationConvergenceRow
  ) => boolean | undefined,
  includeMissingPredictionInAccuracy = false
): TaskRelationProjectionMetrics {
  const scored = rows.filter(
    (row) =>
      row.expectedRelation &&
      (includeMissingPredictionInAccuracy || prediction(row)) &&
      correctness(row) !== undefined
  );
  const predictedNewParent = rows.filter(
    (row) => prediction(row) === "new-parent"
  );
  return {
    accuracy: rate(
      scored.filter((row) => correctness(row) === true).length,
      scored.length
    ),
    newParentPrecision: rate(
      predictedNewParent.filter(
        (row) => row.expectedRelation === "new-parent"
      ).length,
      predictedNewParent.length
    ),
    falseParent: falseRelation(rows, prediction, "new-parent"),
    falseChild: falseRelation(rows, prediction, "child-probe"),
    falseResume: falseRelation(rows, prediction, "resume-parent"),
  };
}

function falseRelation(
  rows: TaskRelationConvergenceRow[],
  prediction: (
    row: TaskRelationConvergenceRow
  ) => ScorableRelation | undefined,
  relation: ScorableRelation
) {
  return rows.filter(
    (row) =>
      prediction(row) === relation &&
      row.expectedRelation &&
      row.expectedRelation !== relation
  ).length;
}

function evaluateGraduation(
  metrics: TaskRelationAuthorityConvergenceReportV1["metrics"],
  thresholds: TaskRelationConvergenceThresholds
): TaskRelationAuthorityConvergenceReportV1["graduation"] {
  const gates: TaskRelationConvergenceGate[] = [
    rateGate(
      "structured-output-validity",
      metrics.structuredOutputValidity,
      thresholds.structuredOutputValidity
    ),
    rateGate(
      "relation-accuracy",
      metrics.counterfactual.accuracy,
      thresholds.relationAccuracy
    ),
    rateGate(
      "new-parent-precision",
      metrics.counterfactual.newParentPrecision,
      thresholds.newParentPrecision
    ),
    countGate(
      "stale-mutation",
      metrics.staleMutationApplied,
      0
    ),
    countGate(
      "shadow-mutation",
      metrics.shadowMutationApplied,
      0
    ),
    countGate(
      "false-parent-candidate",
      metrics.counterfactual.falseParent,
      0
    ),
    countGate(
      "incompatible-human-label",
      metrics.incompatibleHumanLabels,
      0
    ),
    countGate(
      "human-path-inapplicable",
      metrics.humanPathInapplicable,
      0
    ),
    countGate(
      "unmatched-human-label",
      metrics.unmatchedEvaluationCount,
      0
    ),
    {
      id: "expected-class-coverage",
      evaluated: true,
      passed: SCORABLE_RELATIONS.every(
        (relation) => metrics.expectedClassCoverage[relation] > 0
      ),
      actual: SCORABLE_RELATIONS.filter(
        (relation) => metrics.expectedClassCoverage[relation] > 0
      ).length,
      requirement: `all ${SCORABLE_RELATIONS.length} relation classes labeled`,
    },
    {
      id: "minimum-labeled-operations",
      evaluated:
        thresholds.minimumLabeledOperations !== undefined,
      passed:
        thresholds.minimumLabeledOperations === undefined
          ? undefined
          : metrics.compatibleHumanLabels >=
            thresholds.minimumLabeledOperations,
      actual: metrics.compatibleHumanLabels,
      requirement:
        thresholds.minimumLabeledOperations === undefined
          ? "explicit review threshold required"
          : `>= ${thresholds.minimumLabeledOperations}`,
    },
  ];
  const failed = gates.filter(
    (gate) => gate.evaluated && gate.passed === false
  );
  const unevaluated = gates.filter((gate) => !gate.evaluated);
  const evidenceGateIds = new Set([
    "expected-class-coverage",
    "minimum-labeled-operations",
  ]);
  const behaviorFailures = failed.filter(
    (gate) => !evidenceGateIds.has(gate.id)
  );
  const evidenceFailures = failed.filter((gate) =>
    evidenceGateIds.has(gate.id)
  );
  const reasons = [
    ...failed.map((gate) => `failed:${gate.id}`),
    ...unevaluated.map((gate) => `unevaluated:${gate.id}`),
  ];
  const status =
    behaviorFailures.length > 0
      ? "blocked"
      : unevaluated.length > 0 || evidenceFailures.length > 0
        ? "insufficient-evidence"
        : "eligible-for-manual-review";
  return {
    status,
    automaticReleaseAuthorized: false,
    reasons,
    gates,
  };
}

function rateGate(
  id: string,
  metric: TaskRelationRateMetric,
  threshold: number
): TaskRelationConvergenceGate {
  return {
    id,
    evaluated: metric.rate !== null,
    passed:
      metric.rate === null ? undefined : metric.rate >= threshold,
    actual: metric.rate,
    requirement: `>= ${threshold}`,
  };
}

function countGate(
  id: string,
  actual: number,
  expected: number
): TaskRelationConvergenceGate {
  return {
    id,
    evaluated: true,
    passed: actual === expected,
    actual,
    requirement: `= ${expected}`,
  };
}

function indexBranchResults(
  branches: TaskRelationCounterfactualBranchV1[]
) {
  const results = new Map<
    string,
    TaskRelationCounterfactualOperationResultV1
  >();
  for (const branch of branches) {
    for (const result of branch.operationResults) {
      results.set(
        branchResultKey(branch.sessionId, result.operationId),
        result
      );
    }
  }
  return results;
}

function relationResultKey(
  row: Pick<
    TaskRelationAdjudicationReflectionRow,
    "sessionId" | "operationId"
  >
) {
  return row.sessionId && row.operationId
    ? branchResultKey(row.sessionId, row.operationId)
    : undefined;
}

function branchResultKey(sessionId: string, operationId: string) {
  return JSON.stringify([sessionId, operationId]);
}

function isCompatibleHumanTuple(
  row: TaskRelationAdjudicationReflectionRow
) {
  const expected = toScorableRelation(row.expectedRelation);
  if (!expected) return undefined;
  return expectedParentAction(expected) === row.expectedParentAction;
}

function expectedParentAction(
  relation: ScorableRelation
): HumanExpectedParentAction {
  if (relation === "new-parent") return "create";
  if (relation === "child-probe") return "attach-child";
  if (relation === "resume-parent") return "resume";
  return "preserve";
}

function toRuntimeRelation(
  relation: string | undefined
): RuntimeTaskRelation | undefined {
  return relation === "new-parent" ||
    relation === "followup-parent" ||
    relation === "child-probe" ||
    relation === "resume-parent" ||
    relation === "unknown"
    ? relation
    : undefined;
}

function toScorableRelation(
  relation: string | undefined
): ScorableRelation | undefined {
  return SCORABLE_RELATIONS.find((candidate) => candidate === relation);
}

function latestRecordedAt(
  rows: TaskRelationAdjudicationReflectionRow[]
) {
  return rows.reduce(
    (latest, row) => Math.max(latest, row.recordedAt),
    0
  );
}

function rate(numerator: number, denominator: number) {
  return {
    numerator,
    denominator,
    rate: denominator ? numerator / denominator : null,
  };
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function formatRate(metric: TaskRelationRateMetric) {
  return metric.rate === null
    ? "-"
    : `${(metric.rate * 100).toFixed(1)}% (${metric.numerator}/${metric.denominator})`;
}
