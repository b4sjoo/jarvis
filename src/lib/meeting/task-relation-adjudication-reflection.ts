import type {
  HumanExpectedParentAction,
  InterviewTaskRelation,
  QuestionHumanEvaluation,
} from "./types.js";

export interface TaskRelationAdjudicationRecordedDecision {
  recordedAt: number;
  sessionId?: string;
  traceId: string;
  taskId?: string;
  metadata: Record<string, unknown>;
}

export interface TaskRelationAdjudicationReflectionRow {
  key: string;
  sessionId?: string;
  traceId: string;
  taskId?: string;
  operationId?: string;
  disposition?: string;
  deterministicRelation?: InterviewTaskRelation;
  candidateRelation?: InterviewTaskRelation;
  comparisonOutcome?: string;
  comparisonEligible: boolean;
  expectedRelation?: InterviewTaskRelation;
  expectedParentAction?: HumanExpectedParentAction;
  deterministicCorrect?: boolean;
  candidateCorrect?: boolean;
  contextOutcome?: "correct" | "contaminated" | "missing";
  stale: boolean;
  mutationApplied: boolean;
  durationMs?: number;
}

export interface TaskRelationRateMetric {
  numerator: number;
  denominator: number;
  rate: number | null;
}

export interface TaskRelationLatencyMetric {
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface TaskRelationAdjudicationReflectionReport {
  version: 1;
  generatedAt: number;
  metrics: {
    operations: number;
    eligible: number;
    candidateAvailable: number;
    deterministicComparisonEligible: number;
    deterministicAgreement: TaskRelationRateMetric;
    labeled: number;
    llmAccuracy: TaskRelationRateMetric;
    deterministicAccuracy: TaskRelationRateMetric;
    newParentPrecision: TaskRelationRateMetric;
    falseParent: number;
    falseChild: number;
    falseResume: number;
    contextLoss: number;
    contextContamination: number;
    stale: number;
    mutationApplied: number;
    disposition: Record<string, number>;
    expectedRelation: Record<string, number>;
    candidateRelation: Record<string, number>;
    latencyMs: TaskRelationLatencyMetric;
    unmatchedEvaluationCount: number;
  };
  rows: TaskRelationAdjudicationReflectionRow[];
  unmatchedEvaluations: Array<{
    evaluationId: string;
    questionId: string;
    traceIds: string[];
  }>;
}

export function buildTaskRelationAdjudicationReflectionReport(input: {
  decisions: TaskRelationAdjudicationRecordedDecision[];
  evaluations: QuestionHumanEvaluation[];
  now?: number;
}): TaskRelationAdjudicationReflectionReport {
  const decisions = dedupeLatestDecisions(input.decisions);
  const evaluationByTrace = indexLatestEvaluations(input.evaluations);
  const matchedEvaluationIds = new Set<string>();
  const rows = decisions.map((decision) => {
    const metadata = decision.metadata ?? {};
    const evaluation = evaluationByTrace.get(decision.traceId);
    if (evaluation) matchedEvaluationIds.add(evaluation.id);
    const deterministicRelation = normalizeRelation(
      metadata.taskRelationAdjudicationDeterministicRelation
    );
    const candidateRelation = normalizeRelation(
      metadata.taskRelationAdjudicationCandidateRelation
    );
    const expectedRelation = evaluation?.expectedRelation;
    const expectedParentAction = evaluation?.expectedParentAction;
    const contextOutcome =
      evaluation?.taxonomyAdjudication?.contextOutcome;
    return {
      key: decisionKey(decision),
      sessionId: decision.sessionId,
      traceId: decision.traceId,
      taskId: decision.taskId,
      operationId: readString(
        metadata.taskRelationAdjudicationOperationId
      ),
      disposition: readString(
        metadata.taskRelationAdjudicationDisposition
      ),
      deterministicRelation,
      candidateRelation,
      comparisonOutcome: readString(
        metadata.taskRelationAdjudicationComparisonOutcome
      ),
      comparisonEligible:
        metadata.taskRelationAdjudicationComparisonEligible === true,
      expectedRelation,
      expectedParentAction,
      deterministicCorrect:
        deterministicRelation && expectedRelation
          ? deterministicRelation === expectedRelation
          : undefined,
      candidateCorrect:
        candidateRelation && expectedRelation
          ? candidateRelation === expectedRelation
          : undefined,
      contextOutcome,
      stale:
        readString(metadata.taskRelationAdjudicationDisposition) === "stale" ||
        Boolean(readString(metadata.taskRelationAdjudicationStaleReason)),
      mutationApplied:
        metadata.taskRelationAdjudicationAppliedToRuntime === true ||
        metadata.taskRelationAdjudicationBehaviorMutationBlocked === false,
      durationMs: readNumber(
        metadata.taskRelationAdjudicationDurationMs
      ),
    } satisfies TaskRelationAdjudicationReflectionRow;
  });
  const labeledRows = rows.filter((row) => row.expectedRelation);
  const llmLabeledRows = labeledRows.filter((row) => row.candidateRelation);
  const deterministicLabeledRows = labeledRows.filter(
    (row) => row.deterministicRelation
  );
  const comparisonRows = rows.filter(
    (row) =>
      row.comparisonEligible &&
      row.deterministicRelation &&
      row.candidateRelation
  );
  const newParentRows = llmLabeledRows.filter(
    (row) => row.candidateRelation === "new-parent"
  );
  const unmatchedEvaluations = input.evaluations
    .filter(
      (evaluation) =>
        evaluation.expectedRelation &&
        !matchedEvaluationIds.has(evaluation.id)
    )
    .map((evaluation) => ({
      evaluationId: evaluation.id,
      questionId: evaluation.questionId,
      traceIds: [...evaluation.traceIds],
    }));

  return {
    version: 1,
    generatedAt: input.now ?? Date.now(),
    metrics: {
      operations: rows.length,
      eligible: rows.filter(
        (row) =>
          row.disposition !== "not-eligible" &&
          row.disposition !== "disabled"
      ).length,
      candidateAvailable: rows.filter((row) => row.candidateRelation).length,
      deterministicComparisonEligible: comparisonRows.length,
      deterministicAgreement: rate(
        comparisonRows.filter(
          (row) => row.deterministicRelation === row.candidateRelation
        ).length,
        comparisonRows.length
      ),
      labeled: labeledRows.length,
      llmAccuracy: rate(
        llmLabeledRows.filter((row) => row.candidateCorrect).length,
        llmLabeledRows.length
      ),
      deterministicAccuracy: rate(
        deterministicLabeledRows.filter((row) => row.deterministicCorrect)
          .length,
        deterministicLabeledRows.length
      ),
      newParentPrecision: rate(
        newParentRows.filter((row) => row.candidateCorrect).length,
        newParentRows.length
      ),
      falseParent: countFalseRelation(rows, "new-parent"),
      falseChild: countFalseRelation(rows, "child-probe"),
      falseResume: countFalseRelation(rows, "resume-parent"),
      contextLoss: rows.filter((row) => row.contextOutcome === "missing")
        .length,
      contextContamination: rows.filter(
        (row) => row.contextOutcome === "contaminated"
      ).length,
      stale: rows.filter((row) => row.stale).length,
      mutationApplied: rows.filter((row) => row.mutationApplied).length,
      disposition: countValues(rows.map((row) => row.disposition)),
      expectedRelation: countValues(
        rows.map((row) => row.expectedRelation)
      ),
      candidateRelation: countValues(
        rows.map((row) => row.candidateRelation)
      ),
      latencyMs: distribution(
        rows.map((row) => row.durationMs).filter(isNumber)
      ),
      unmatchedEvaluationCount: unmatchedEvaluations.length,
    },
    rows,
    unmatchedEvaluations,
  };
}

export function renderTaskRelationAdjudicationReflectionMarkdown(
  report: TaskRelationAdjudicationReflectionReport
) {
  const metrics = report.metrics;
  const lines = [
    "# Task Relation Adjudication Reflection",
    "",
    `- Operations: ${metrics.operations}`,
    `- Candidate available: ${metrics.candidateAvailable}`,
    `- Human-labeled: ${metrics.labeled}`,
    `- Deterministic/LLM agreement: ${formatRate(metrics.deterministicAgreement)}`,
    `- LLM accuracy: ${formatRate(metrics.llmAccuracy)}`,
    `- Deterministic accuracy: ${formatRate(metrics.deterministicAccuracy)}`,
    `- New-parent precision: ${formatRate(metrics.newParentPrecision)}`,
    `- False parent / child / resume: ${metrics.falseParent} / ${metrics.falseChild} / ${metrics.falseResume}`,
    `- Context loss / contamination: ${metrics.contextLoss} / ${metrics.contextContamination}`,
    `- Stale: ${metrics.stale}`,
    `- Runtime mutation applied: ${metrics.mutationApplied}`,
    `- Latency P50 / P95: ${formatMs(metrics.latencyMs.p50Ms)} / ${formatMs(metrics.latencyMs.p95Ms)}`,
    `- Unmatched expected-relation labels: ${metrics.unmatchedEvaluationCount}`,
    "",
    "## Rows",
    "",
    "| Trace | Deterministic | LLM | Expected | Outcome | Disposition |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of report.rows) {
    lines.push(
      `| ${row.traceId} | ${row.deterministicRelation ?? "-"} | ${row.candidateRelation ?? "-"} | ${row.expectedRelation ?? "-"} | ${row.comparisonOutcome ?? "-"} | ${row.disposition ?? "-"} |`
    );
  }
  return `${lines.join("\n")}\n`;
}

function dedupeLatestDecisions(
  decisions: TaskRelationAdjudicationRecordedDecision[]
) {
  const latest = new Map<string, TaskRelationAdjudicationRecordedDecision>();
  for (const decision of decisions) {
    const key = decisionKey(decision);
    const existing = latest.get(key);
    if (!existing || decision.recordedAt >= existing.recordedAt) {
      latest.set(key, decision);
    }
  }
  return Array.from(latest.values()).sort(
    (left, right) => left.recordedAt - right.recordedAt
  );
}

function decisionKey(decision: TaskRelationAdjudicationRecordedDecision) {
  return (
    readString(decision.metadata.taskRelationAdjudicationOperationId) ??
    `${decision.sessionId ?? "session"}:${decision.traceId}`
  );
}

function indexLatestEvaluations(evaluations: QuestionHumanEvaluation[]) {
  const byTrace = new Map<string, QuestionHumanEvaluation>();
  for (const evaluation of [...evaluations].sort(
    (left, right) => left.updatedAt - right.updatedAt
  )) {
    for (const traceId of evaluation.traceIds) {
      byTrace.set(traceId, evaluation);
    }
  }
  return byTrace;
}

function countFalseRelation(
  rows: TaskRelationAdjudicationReflectionRow[],
  relation: InterviewTaskRelation
) {
  return rows.filter(
    (row) =>
      row.candidateRelation === relation &&
      row.expectedRelation &&
      row.expectedRelation !== relation
  ).length;
}

function rate(numerator: number, denominator: number): TaskRelationRateMetric {
  return {
    numerator,
    denominator,
    rate: denominator ? numerator / denominator : null,
  };
}

function distribution(values: number[]): TaskRelationLatencyMetric {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

function percentile(values: number[], quantile: number) {
  if (!values.length) return null;
  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.ceil(values.length * quantile) - 1)
  );
  return values[index];
}

function countValues(values: Array<string | undefined>) {
  const counts: Record<string, number> = {};
  for (const value of values) {
    if (!value) continue;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function normalizeRelation(
  value: unknown
): InterviewTaskRelation | undefined {
  return value === "new-parent" ||
    value === "followup-parent" ||
    value === "child-probe" ||
    value === "resume-parent" ||
    value === "logistics" ||
    value === "correction" ||
    value === "unknown"
    ? value
    : undefined;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isNumber(value: number | undefined): value is number {
  return value !== undefined;
}

function formatRate(metric: TaskRelationRateMetric) {
  return metric.rate === null
    ? "-"
    : `${(metric.rate * 100).toFixed(1)}% (${metric.numerator}/${metric.denominator})`;
}

function formatMs(value: number | null) {
  return value === null ? "-" : `${Math.round(value)} ms`;
}
