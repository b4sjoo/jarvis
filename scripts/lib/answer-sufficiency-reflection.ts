export interface RecordedAnswerSufficiencyDecision {
  recordedAt: number;
  sessionId?: string;
  traceId: string;
  taskId?: string;
  decision: {
    operationId: string;
    questionId: string;
    answerRevision: number;
    answerStatus: string;
    recommendedRepair: string;
    resolvableByNearbyContext: boolean;
    semanticStatus?: "context-insufficient" | "not-context-insufficient";
    semanticDisposition?: string;
  };
}

export interface AnswerSufficiencyEvaluationLabel {
  id: string;
  questionId: string;
  traceIds: string[];
  answerSufficiency?: {
    observedStatus?: "sufficient" | "insufficient";
    nearbyContextExisted?: boolean;
    expectedRepair?: string;
    expectedContextKinds?: string[];
    operationId?: string;
    answerRevision?: number;
  };
}

export interface AnswerSufficiencyReflectionRow {
  operationId: string;
  traceId: string;
  questionId: string;
  answerRevision: number;
  lexicalStatus: string;
  semanticStatus?: "context-insufficient" | "not-context-insufficient";
  semanticDisposition?: string;
  contextResolvable: boolean;
  recommendedRepair: string;
  expectedStatus?: "sufficient" | "insufficient";
  expectedNearbyContext?: boolean;
  expectedRepair?: string;
  lexicalCorrect?: boolean;
  semanticCorrect?: boolean;
  contextResolvableCorrect?: boolean;
}

export interface AnswerSufficiencyReflectionReport {
  version: 1;
  generatedAt: number;
  metrics: {
    operations: number;
    labeled: number;
    unlabeled: number;
    semanticAvailable: number;
    lexical: BinaryDetectorMetrics;
    semantic: BinaryDetectorMetrics;
    contextResolvability: BinaryDetectorMetrics;
    legitimateWaitFalsePositives: number;
    repairDistribution: Record<string, number>;
    semanticDisposition: Record<string, number>;
    unmatchedLabels: number;
  };
  rows: AnswerSufficiencyReflectionRow[];
  unmatchedLabels: Array<{
    evaluationId: string;
    questionId: string;
    operationId?: string;
    traceIds: string[];
  }>;
}

interface BinaryDetectorMetrics {
  samples: number;
  truePositive: number;
  trueNegative: number;
  falsePositive: number;
  falseNegative: number;
  precision: number | null;
  recall: number | null;
  accuracy: number | null;
}

export function buildAnswerSufficiencyReflectionReport({
  decisions,
  evaluations,
}: {
  decisions: RecordedAnswerSufficiencyDecision[];
  evaluations: AnswerSufficiencyEvaluationLabel[];
}): AnswerSufficiencyReflectionReport {
  const latestByOperation = new Map<
    string,
    RecordedAnswerSufficiencyDecision
  >();
  for (const record of decisions) {
    const current = latestByOperation.get(record.decision.operationId);
    if (!current || preferDecisionRecord(record, current)) {
      latestByOperation.set(record.decision.operationId, record);
    }
  }
  const matchedEvaluationIds = new Set<string>();
  const rows = [...latestByOperation.values()]
    .map((record) => {
      const evaluation = findEvaluation(record, evaluations);
      if (evaluation) matchedEvaluationIds.add(evaluation.id);
      return buildRow(record, evaluation);
    })
    .sort((left, right) => left.operationId.localeCompare(right.operationId));
  const unmatchedLabels = evaluations
    .filter(
      (evaluation) =>
        evaluation.answerSufficiency?.observedStatus &&
        !matchedEvaluationIds.has(evaluation.id)
    )
    .map((evaluation) => ({
      evaluationId: evaluation.id,
      questionId: evaluation.questionId,
      operationId: evaluation.answerSufficiency?.operationId,
      traceIds: evaluation.traceIds,
    }));

  const labeled = rows.filter((row) => row.expectedStatus);
  const semanticLabeled = labeled.filter((row) => row.semanticStatus);
  const resolvabilityLabeled = rows.filter(
    (row) => typeof row.expectedNearbyContext === "boolean"
  );
  return {
    version: 1,
    generatedAt: Date.now(),
    metrics: {
      operations: rows.length,
      labeled: labeled.length,
      unlabeled: rows.length - labeled.length,
      semanticAvailable: rows.filter((row) => row.semanticStatus).length,
      lexical: binaryMetrics(
        labeled.map((row) => ({
          predicted: row.lexicalStatus === "context-insufficient",
          expected: row.expectedStatus === "insufficient",
        }))
      ),
      semantic: binaryMetrics(
        semanticLabeled.map((row) => ({
          predicted: row.semanticStatus === "context-insufficient",
          expected: row.expectedStatus === "insufficient",
        }))
      ),
      contextResolvability: binaryMetrics(
        resolvabilityLabeled.map((row) => ({
          predicted: row.contextResolvable,
          expected: Boolean(row.expectedNearbyContext),
        }))
      ),
      legitimateWaitFalsePositives: rows.filter(
        (row) =>
          row.expectedRepair === "wait" &&
          (row.lexicalStatus === "context-insufficient" ||
            row.semanticStatus === "context-insufficient")
      ).length,
      repairDistribution: countStrings(
        rows.map((row) => row.recommendedRepair)
      ),
      semanticDisposition: countStrings(
        rows.map((row) => row.semanticDisposition ?? "unavailable")
      ),
      unmatchedLabels: unmatchedLabels.length,
    },
    rows,
    unmatchedLabels,
  };
}

export function renderAnswerSufficiencyReflectionMarkdown(
  report: AnswerSufficiencyReflectionReport
) {
  const metricRows = [
    ["Lexical", report.metrics.lexical],
    ["Semantic", report.metrics.semantic],
    ["Context resolvability", report.metrics.contextResolvability],
  ] as const;
  return [
    "# Answer Sufficiency Reflection",
    "",
    `Generated: ${new Date(report.generatedAt).toISOString()}`,
    "",
    `- Operations: ${report.metrics.operations}`,
    `- Labeled: ${report.metrics.labeled}`,
    `- Semantic available: ${report.metrics.semanticAvailable}`,
    `- Legitimate-wait false positives: ${report.metrics.legitimateWaitFalsePositives}`,
    `- Unmatched labels: ${report.metrics.unmatchedLabels}`,
    "",
    "| Detector | Samples | Precision | Recall | Accuracy | FP | FN |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...metricRows.map(
      ([name, metrics]) =>
        `| ${name} | ${metrics.samples} | ${formatRatio(metrics.precision)} | ${formatRatio(metrics.recall)} | ${formatRatio(metrics.accuracy)} | ${metrics.falsePositive} | ${metrics.falseNegative} |`
    ),
    "",
    "## Repair Distribution",
    "",
    ...renderCounts(report.metrics.repairDistribution),
    "",
    "## Semantic Disposition",
    "",
    ...renderCounts(report.metrics.semanticDisposition),
    "",
  ].join("\n");
}

function preferDecisionRecord(
  candidate: RecordedAnswerSufficiencyDecision,
  current: RecordedAnswerSufficiencyDecision
) {
  const candidateHasSemantic = Boolean(
    candidate.decision.semanticStatus ||
      candidate.decision.semanticDisposition
  );
  const currentHasSemantic = Boolean(
    current.decision.semanticStatus || current.decision.semanticDisposition
  );
  if (candidateHasSemantic !== currentHasSemantic) return candidateHasSemantic;
  return candidate.recordedAt >= current.recordedAt;
}

function findEvaluation(
  record: RecordedAnswerSufficiencyDecision,
  evaluations: AnswerSufficiencyEvaluationLabel[]
) {
  return evaluations.find(
    (evaluation) =>
      evaluation.answerSufficiency?.operationId ===
        record.decision.operationId ||
      (evaluation.questionId === record.decision.questionId &&
        evaluation.traceIds.includes(record.traceId))
  );
}

function buildRow(
  record: RecordedAnswerSufficiencyDecision,
  evaluation?: AnswerSufficiencyEvaluationLabel
): AnswerSufficiencyReflectionRow {
  const expectedStatus = evaluation?.answerSufficiency?.observedStatus;
  const lexicalInsufficient =
    record.decision.answerStatus === "context-insufficient";
  const semanticInsufficient =
    record.decision.semanticStatus === "context-insufficient";
  return {
    operationId: record.decision.operationId,
    traceId: record.traceId,
    questionId: record.decision.questionId,
    answerRevision: record.decision.answerRevision,
    lexicalStatus: record.decision.answerStatus,
    semanticStatus: record.decision.semanticStatus,
    semanticDisposition: record.decision.semanticDisposition,
    contextResolvable: record.decision.resolvableByNearbyContext,
    recommendedRepair: record.decision.recommendedRepair,
    expectedStatus,
    expectedNearbyContext:
      evaluation?.answerSufficiency?.nearbyContextExisted,
    expectedRepair: evaluation?.answerSufficiency?.expectedRepair,
    lexicalCorrect:
      expectedStatus === undefined
        ? undefined
        : lexicalInsufficient === (expectedStatus === "insufficient"),
    semanticCorrect:
      expectedStatus === undefined ||
      record.decision.semanticStatus === undefined
        ? undefined
        : semanticInsufficient === (expectedStatus === "insufficient"),
    contextResolvableCorrect:
      evaluation?.answerSufficiency?.nearbyContextExisted === undefined
        ? undefined
        : record.decision.resolvableByNearbyContext ===
          evaluation.answerSufficiency.nearbyContextExisted,
  };
}

function binaryMetrics(
  rows: Array<{ predicted: boolean; expected: boolean }>
): BinaryDetectorMetrics {
  const truePositive = rows.filter(
    (row) => row.predicted && row.expected
  ).length;
  const trueNegative = rows.filter(
    (row) => !row.predicted && !row.expected
  ).length;
  const falsePositive = rows.filter(
    (row) => row.predicted && !row.expected
  ).length;
  const falseNegative = rows.filter(
    (row) => !row.predicted && row.expected
  ).length;
  return {
    samples: rows.length,
    truePositive,
    trueNegative,
    falsePositive,
    falseNegative,
    precision: ratio(truePositive, truePositive + falsePositive),
    recall: ratio(truePositive, truePositive + falseNegative),
    accuracy: ratio(truePositive + trueNegative, rows.length),
  };
}

function countStrings(values: string[]) {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : null;
}

function formatRatio(value: number | null) {
  return value === null ? "-" : `${(value * 100).toFixed(1)}%`;
}

function renderCounts(counts: Record<string, number>) {
  const entries = Object.entries(counts).sort(
    ([left], [right]) => left.localeCompare(right)
  );
  return entries.length > 0
    ? entries.map(([name, count]) => `- ${name}: ${count}`)
    : ["- No samples"];
}
