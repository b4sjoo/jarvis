import {
  CANONICAL_QUESTION_TYPES,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";

export interface SemanticTaxonomyRecordedDecision {
  recordedAt: number;
  sessionId?: string;
  traceId: string;
  taskId?: string;
  metadata: Record<string, unknown>;
}

export interface SemanticTaxonomyEvaluationLabel {
  id: string;
  questionId: string;
  traceIds: string[];
  questionType?: string;
  correctedQuestionType?: string;
  manualQuestionTypeCorrectionId?: string;
  classification?: {
    verdict?: "ok" | "partial" | "wrong" | "not_applicable";
  };
  updatedAt: number;
}

export interface SemanticTaxonomyReflectionRow {
  key: string;
  sessionId?: string;
  turnId?: string;
  traceIds: string[];
  taskIds: string[];
  mode?: string;
  lexicalType: CanonicalQuestionType;
  lexicalConfidence?: number;
  lexicalMargin?: number;
  semanticCandidateType?: CanonicalQuestionType;
  semanticConfidence?: number;
  semanticMargin?: number;
  hybridOutcome?: string;
  hybridRecommendedType?: CanonicalQuestionType;
  effectiveType: CanonicalQuestionType;
  wouldRescue: boolean;
  rescueApplied: boolean;
  parentMutationBlocked: boolean;
  enforcementReason?: string;
  embeddingStatus?: string;
  embeddingDurationMs?: number;
  cacheHit?: boolean;
  evaluationId?: string;
  questionId?: string;
  expectedType?: CanonicalQuestionType;
  labelOutcome: "confirmed" | "corrected" | "unlabeled";
  rescueCorrect?: boolean;
  correctionAfterRescue: boolean;
}

export interface SemanticTaxonomyReflectionReport {
  version: 1;
  generatedAt: number;
  sessions: string[];
  metrics: {
    decisions: number;
    labeled: number;
    unlabeled: number;
    missingSemanticEvidenceForLabels: number;
    wouldRescue: number;
    rescueApplied: number;
    labeledRescueApplied: number;
    correctRescueApplied: number;
    rescuePrecision: number;
    rescueRecall: number;
    correctionAfterRescue: number;
    parentMutationBlocked: number;
    embeddingStatus: Record<string, number>;
    cacheHitRate: number;
    embeddingLatency: {
      samples: number;
      p50Ms: number;
      p95Ms: number;
      maxMs: number;
    };
  };
  confusionMatrix: Record<
    CanonicalQuestionType,
    Record<CanonicalQuestionType, number>
  >;
  rows: SemanticTaxonomyReflectionRow[];
  unmatchedLabeledQuestions: Array<{
    evaluationId: string;
    questionId: string;
    expectedType?: CanonicalQuestionType;
    traceIds: string[];
    reason: "missing-semantic-taxonomy-evidence";
  }>;
  reviewProposals: {
    reviewOnly: true;
    automaticMutationAllowed: false;
    prototypeCandidates: Array<{
      expectedType: CanonicalQuestionType;
      observedType?: CanonicalQuestionType;
      evidenceKeys: string[];
      recommendation: string;
    }>;
    thresholdCandidates: Array<{
      candidateType: CanonicalQuestionType;
      evidenceKeys: string[];
      recommendation: string;
    }>;
  };
}

export function buildSemanticTaxonomyReflectionReport({
  decisions,
  evaluations,
}: {
  decisions: SemanticTaxonomyRecordedDecision[];
  evaluations: SemanticTaxonomyEvaluationLabel[];
}): SemanticTaxonomyReflectionReport {
  const grouped = groupDecisions(decisions);
  const matchedEvaluationIds = new Set<string>();
  const rows = Array.from(grouped.entries())
    .map(([key, records]) => {
      const traceIds = unique(records.map((record) => record.traceId));
      const evaluation = findEvaluationForTraces(evaluations, traceIds);
      if (evaluation) matchedEvaluationIds.add(evaluation.id);
      return buildReflectionRow(key, records, evaluation);
    })
    .sort((left, right) => left.key.localeCompare(right.key));

  const unmatchedLabeledQuestions = evaluations
    .filter((evaluation) => !matchedEvaluationIds.has(evaluation.id))
    .map((evaluation) => ({
      evaluationId: evaluation.id,
      questionId: evaluation.questionId,
      expectedType: resolveExpectedType(evaluation),
      traceIds: unique(evaluation.traceIds),
      reason: "missing-semantic-taxonomy-evidence" as const,
    }));
  const labeledRows = rows.filter((row) => row.expectedType);
  const appliedRescues = rows.filter((row) => row.rescueApplied);
  const labeledAppliedRescues = appliedRescues.filter((row) => row.expectedType);
  const correctAppliedRescues = labeledAppliedRescues.filter(
    (row) => row.rescueCorrect
  );
  const rescueOpportunities = labeledRows.filter(
    (row) => row.lexicalType === "unknown" && row.expectedType !== "unknown"
  );
  const correctRescues = rescueOpportunities.filter(
    (row) => row.rescueApplied && row.rescueCorrect
  );
  const successfulEmbeddings = rows.filter(
    (row) => row.embeddingStatus === "success"
  );
  const embeddingDurations = rows
    .map((row) => row.embeddingDurationMs)
    .filter((value): value is number => typeof value === "number");

  return {
    version: 1,
    generatedAt: Date.now(),
    sessions: unique(rows.map((row) => row.sessionId).filter(isString)),
    metrics: {
      decisions: rows.length,
      labeled: labeledRows.length,
      unlabeled: rows.length - labeledRows.length,
      missingSemanticEvidenceForLabels: unmatchedLabeledQuestions.length,
      wouldRescue: rows.filter((row) => row.wouldRescue).length,
      rescueApplied: appliedRescues.length,
      labeledRescueApplied: labeledAppliedRescues.length,
      correctRescueApplied: correctAppliedRescues.length,
      rescuePrecision: ratio(
        correctAppliedRescues.length,
        labeledAppliedRescues.length
      ),
      rescueRecall: ratio(correctRescues.length, rescueOpportunities.length),
      correctionAfterRescue: rows.filter((row) => row.correctionAfterRescue)
        .length,
      parentMutationBlocked: rows.filter((row) => row.parentMutationBlocked)
        .length,
      embeddingStatus: countStrings(
        rows.map((row) => row.embeddingStatus ?? "unknown")
      ),
      cacheHitRate: ratio(
        successfulEmbeddings.filter((row) => row.cacheHit).length,
        successfulEmbeddings.length
      ),
      embeddingLatency: summarizeLatency(embeddingDurations),
    },
    confusionMatrix: buildConfusionMatrix(labeledRows),
    rows,
    unmatchedLabeledQuestions,
    reviewProposals: buildReviewProposals(rows),
  };
}

export function renderSemanticTaxonomyReflectionMarkdown(
  report: SemanticTaxonomyReflectionReport
) {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const lines = [
    "# Semantic Taxonomy Reflection",
    "",
    `Generated: ${new Date(report.generatedAt).toISOString()}`,
    `Sessions: ${report.sessions.join(", ") || "-"}`,
    "",
    "## Summary",
    "",
    `- Decisions: ${report.metrics.decisions}`,
    `- Labeled / unlabeled: ${report.metrics.labeled} / ${report.metrics.unlabeled}`,
    `- Missing semantic evidence for labels: ${report.metrics.missingSemanticEvidenceForLabels}`,
    `- Would rescue / applied: ${report.metrics.wouldRescue} / ${report.metrics.rescueApplied}`,
    `- Rescue precision / recall: ${percent(report.metrics.rescuePrecision)} / ${percent(report.metrics.rescueRecall)}`,
    `- Correction after rescue: ${report.metrics.correctionAfterRescue}`,
    `- Parent mutation blocked: ${report.metrics.parentMutationBlocked}`,
    `- Embedding p50 / p95: ${report.metrics.embeddingLatency.p50Ms.toFixed(1)}ms / ${report.metrics.embeddingLatency.p95Ms.toFixed(1)}ms`,
    "",
    "## Decision Evidence",
    "",
    "| Turn | Lexical | Semantic | Effective | Rescue | Parent block | HITL | Latency |",
    "|---|---|---|---|---|---|---|---|",
    ...report.rows.map(
      (row) =>
        `| ${escapeCell(row.turnId ?? row.key)} | ${row.lexicalType} | ${row.semanticCandidateType ?? "-"} | ${row.effectiveType} | ${row.rescueApplied ? "applied" : row.wouldRescue ? "would" : "-"} | ${row.parentMutationBlocked ? "yes" : "no"} | ${row.expectedType ? `${row.labelOutcome}:${row.expectedType}` : "unlabeled"} | ${row.embeddingDurationMs?.toFixed(1) ?? "-"}ms |`
    ),
    "",
    "## Review Proposals",
    "",
    "These are review-only proposals. This report never mutates runtime prototypes or thresholds.",
    "",
    ...report.reviewProposals.prototypeCandidates.map(
      (proposal) =>
        `- Prototype: ${proposal.recommendation} Evidence: ${proposal.evidenceKeys.join(", ")}.`
    ),
    ...report.reviewProposals.thresholdCandidates.map(
      (proposal) =>
        `- Threshold: ${proposal.recommendation} Evidence: ${proposal.evidenceKeys.join(", ")}.`
    ),
  ];
  if (
    !report.reviewProposals.prototypeCandidates.length &&
    !report.reviewProposals.thresholdCandidates.length
  ) {
    lines.push("- No reviewed change proposal from the available labels.");
  }
  if (report.unmatchedLabeledQuestions.length) {
    lines.push("", "## Joinability Gaps", "");
    for (const item of report.unmatchedLabeledQuestions) {
      lines.push(
        `- ${item.evaluationId}: ${item.reason}; traces=${item.traceIds.join(", ") || "-"}.`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function groupDecisions(decisions: SemanticTaxonomyRecordedDecision[]) {
  const grouped = new Map<string, SemanticTaxonomyRecordedDecision[]>();
  for (const decision of decisions) {
    const turnId = readString(decision.metadata, "semanticTaxonomyTurnId");
    const sessionId =
      readString(decision.metadata, "semanticTaxonomySessionId") ??
      decision.sessionId ??
      "unknown-session";
    const key = `${sessionId}:${turnId ?? decision.traceId}`;
    const records = grouped.get(key) ?? [];
    records.push(decision);
    grouped.set(key, records);
  }
  for (const records of grouped.values()) {
    records.sort((left, right) => left.recordedAt - right.recordedAt);
  }
  return grouped;
}

function buildReflectionRow(
  key: string,
  records: SemanticTaxonomyRecordedDecision[],
  evaluation?: SemanticTaxonomyEvaluationLabel
): SemanticTaxonomyReflectionRow {
  const metadata = records.map((record) => record.metadata).reverse();
  const lexicalType =
    readCanonical(metadata, "taxonomyKeywordType") ?? "unknown";
  const effectiveType =
    readCanonical(metadata, "taxonomyHybridEffectiveType") ?? lexicalType;
  const expectedType = evaluation ? resolveExpectedType(evaluation) : undefined;
  const rescueApplied = readBoolean(metadata, "taxonomySemanticRescueApplied");
  const corrected = Boolean(evaluation?.correctedQuestionType);
  return {
    key,
    sessionId:
      readFirst(metadata, "semanticTaxonomySessionId") ?? records[0]?.sessionId,
    turnId: readFirst(metadata, "semanticTaxonomyTurnId"),
    traceIds: unique(records.map((record) => record.traceId)),
    taskIds: unique(records.map((record) => record.taskId).filter(isString)),
    mode: readFirst(metadata, "semanticTaxonomyMode"),
    lexicalType,
    lexicalConfidence: readNumber(metadata, "taxonomyKeywordConfidence"),
    lexicalMargin: readNumber(metadata, "taxonomyKeywordMargin"),
    semanticCandidateType: readCanonical(
      metadata,
      "taxonomySemanticCandidateType"
    ),
    semanticConfidence: readNumber(metadata, "taxonomySemanticConfidence"),
    semanticMargin: readNumber(metadata, "taxonomySemanticMargin"),
    hybridOutcome: readFirst(metadata, "taxonomyHybridOutcome"),
    hybridRecommendedType: readCanonical(
      metadata,
      "taxonomyHybridRecommendedType"
    ),
    effectiveType,
    wouldRescue: readBoolean(metadata, "taxonomyHybridWouldRescue"),
    rescueApplied,
    parentMutationBlocked: readBoolean(
      metadata,
      "taxonomySemanticParentMutationBlocked"
    ),
    enforcementReason: readFirst(
      metadata,
      "taxonomySemanticEnforcementReason"
    ),
    embeddingStatus: readFirst(metadata, "taxonomySemanticEmbeddingStatus"),
    embeddingDurationMs: readNumber(metadata, "taxonomySemanticDurationMs"),
    cacheHit: readBoolean(metadata, "taxonomySemanticCacheHit"),
    evaluationId: evaluation?.id,
    questionId: evaluation?.questionId,
    expectedType,
    labelOutcome: expectedType
      ? corrected
        ? "corrected"
        : "confirmed"
      : "unlabeled",
    rescueCorrect:
      rescueApplied && expectedType
        ? effectiveType === expectedType
        : undefined,
    correctionAfterRescue:
      rescueApplied && corrected && expectedType !== effectiveType,
  };
}

function findEvaluationForTraces(
  evaluations: SemanticTaxonomyEvaluationLabel[],
  traceIds: string[]
) {
  const traceSet = new Set(traceIds);
  return evaluations
    .filter((evaluation) =>
      evaluation.traceIds.some((traceId) => traceSet.has(traceId))
    )
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

function resolveExpectedType(evaluation: SemanticTaxonomyEvaluationLabel) {
  const corrected = normalizeCanonicalQuestionType(
    evaluation.correctedQuestionType
  );
  if (corrected) return corrected;
  if (evaluation.classification?.verdict !== "ok") return undefined;
  return normalizeCanonicalQuestionType(evaluation.questionType);
}

function buildConfusionMatrix(rows: SemanticTaxonomyReflectionRow[]) {
  const matrix = Object.fromEntries(
    CANONICAL_QUESTION_TYPES.map((expected) => [
      expected,
      Object.fromEntries(
        CANONICAL_QUESTION_TYPES.map((observed) => [observed, 0])
      ),
    ])
  ) as Record<
    CanonicalQuestionType,
    Record<CanonicalQuestionType, number>
  >;
  for (const row of rows) {
    if (row.expectedType) matrix[row.expectedType][row.effectiveType] += 1;
  }
  return matrix;
}

function buildReviewProposals(rows: SemanticTaxonomyReflectionRow[]) {
  const falseRescues = rows.filter(
    (row) =>
      (row.rescueApplied || row.wouldRescue) &&
      row.expectedType &&
      row.hybridRecommendedType &&
      row.hybridRecommendedType !== row.expectedType
  );
  const missed = rows.filter(
    (row) =>
      row.lexicalType === "unknown" &&
      row.expectedType &&
      row.expectedType !== "unknown" &&
      !row.wouldRescue
  );
  const thresholdGroups = groupBy(
    falseRescues,
    (row) => row.hybridRecommendedType ?? row.semanticCandidateType
  );
  const prototypeGroups = groupBy(missed, (row) => row.expectedType);
  return {
    reviewOnly: true as const,
    automaticMutationAllowed: false as const,
    prototypeCandidates: Array.from(prototypeGroups.entries()).map(
      ([expectedType, evidence]) => ({
        expectedType,
        observedType: evidence[0]?.semanticCandidateType,
        evidenceKeys: evidence.map((row) => row.key),
        recommendation: `Review positive prototypes or hard negatives for ${expectedType}; do not auto-add session text.`,
      })
    ),
    thresholdCandidates: Array.from(thresholdGroups.entries()).map(
      ([candidateType, evidence]) => ({
        candidateType,
        evidenceKeys: evidence.map((row) => row.key),
        recommendation: `Review ${candidateType} calibration because labeled evidence disagreed with a proposed rescue.`,
      })
    ),
  };
}

function groupBy(
  rows: SemanticTaxonomyReflectionRow[],
  keyOf: (row: SemanticTaxonomyReflectionRow) => CanonicalQuestionType | undefined
) {
  const grouped = new Map<CanonicalQuestionType, SemanticTaxonomyReflectionRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const values = grouped.get(key) ?? [];
    values.push(row);
    grouped.set(key, values);
  }
  return grouped;
}

function summarizeLatency(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
  };
}

function percentile(sorted: number[], percentileValue: number) {
  if (!sorted.length) return 0;
  return sorted[Math.ceil((sorted.length - 1) * percentileValue)] ?? 0;
}

function countStrings(values: string[]) {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function readCanonical(
  sources: Record<string, unknown>[],
  key: string
) {
  return normalizeCanonicalQuestionType(readFirst(sources, key));
}

function readFirst(sources: Record<string, unknown>[], key: string) {
  for (const source of sources) {
    const value = readString(source, key);
    if (value) return value;
  }
  return undefined;
}

function readString(source: Record<string, unknown>, key: string) {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(sources: Record<string, unknown>[], key: string) {
  for (const source of sources) {
    if (typeof source[key] === "boolean") return source[key] as boolean;
  }
  return false;
}

function readNumber(sources: Record<string, unknown>[], key: string) {
  for (const source of sources) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function ratio(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : 0;
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}

function isString(value: string | undefined): value is string {
  return Boolean(value);
}

function escapeCell(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
