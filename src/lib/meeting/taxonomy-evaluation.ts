import {
  CANONICAL_QUESTION_TYPES,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
  type QuestionTypeInferenceDecision,
} from "./task-taxonomy.js";

export type TaxonomyEvaluationLanguage = "en" | "zh" | "mixed";
export type TaxonomyEvaluationSplit = "train" | "calibration" | "held-out";

export interface TaxonomyEvaluationExample {
  id: string;
  groupId: string;
  text: string;
  expectedType: CanonicalQuestionType;
  language: TaxonomyEvaluationLanguage;
  answerableTechnical: boolean;
  activeParentType?: CanonicalQuestionType;
  tags: string[];
  source: "generic-curated" | "private-session";
}

export interface TaxonomyEvaluationPrediction {
  type?: CanonicalQuestionType;
  confidence?: number;
  margin?: number;
}

export interface TaxonomyTypeMetrics {
  support: number;
  predicted: number;
  truePositive: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface TaxonomySliceMetrics {
  total: number;
  correct: number;
  accuracy: number;
  answerableTechnicalCount: number;
  answerableTechnicalUnknownCount: number;
  answerableTechnicalUnknownRate: number;
  unknownExpectedCount: number;
  falseActivationCount: number;
  falseActivationRate: number;
}

export interface TaxonomyLatencySummary {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface TaxonomyEvaluationRow {
  id: string;
  groupId: string;
  expectedType: CanonicalQuestionType;
  predictedType: CanonicalQuestionType;
  correct: boolean;
  confidence?: number;
  margin?: number;
  durationMs: number;
  language: TaxonomyEvaluationLanguage;
  activeParentType?: CanonicalQuestionType;
  tags: string[];
}

export interface TaxonomyEvaluationReport {
  version: 1;
  corpusSize: number;
  metrics: TaxonomySliceMetrics;
  perType: Record<CanonicalQuestionType, TaxonomyTypeMetrics>;
  confusionMatrix: Record<
    CanonicalQuestionType,
    Record<CanonicalQuestionType, number>
  >;
  slices: Record<string, TaxonomySliceMetrics>;
  latency: TaxonomyLatencySummary;
  rows: TaxonomyEvaluationRow[];
}

export interface PrivateQuestionEvaluationRecord {
  id: string;
  questionId: string;
  taskId?: string;
  traceIds?: string[];
  questionType?: CanonicalQuestionType;
  correctedQuestionType?: CanonicalQuestionType;
  manualQuestionTypeCorrectionSource?: string;
  classification?: {
    verdict?: "ok" | "partial" | "wrong" | "not_applicable";
    reasons?: string[];
  };
  createdAt: number;
}

export interface PrivateTranscriptTurnRecord {
  id: string;
  speaker: "me" | "them";
  text: string;
  startedAt: number;
  endedAt: number;
  isFinal?: boolean;
}

export interface PrivateCorpusImportResult {
  examples: TaxonomyEvaluationExample[];
  skipped: Array<{
    evaluationId: string;
    reason: "missing-reviewed-label" | "missing-nearby-interviewer-turn";
  }>;
}

export interface PrivateHumanGroundTruthEventRecord {
  confirmation?: "confirmed" | "suggested";
  fact?: {
    kind?: string;
    expectedQuestionType?: string;
  };
  provenance?: {
    source?: string;
    recordedAt?: number;
  };
}

export interface PrivateHumanEvaluationProjectionRecord {
  projectionId: string;
  sessionId?: string;
  subject?: {
    questionId?: string;
    traceIds?: string[];
    sourceTurnIds?: string[];
  };
  activeFacts?: {
    "expected-task-settlement"?: PrivateHumanGroundTruthEventRecord;
    "expected-question-type"?: PrivateHumanGroundTruthEventRecord;
  };
  conflicts?: Array<{
    factKind?: string;
  }>;
  computedAt?: number;
}

export type PrivateTaxonomyImportWarningCode =
  | "v1-only-evaluation"
  | "v2-only-projection"
  | "v1-v2-type-disagreement"
  | "v2-conflicting-facts"
  | "v2-suggested-type-skipped"
  | "v2-imported-legacy-fallback"
  | "ambiguous-subject-match"
  | "missing-source-turn"
  | "projection-history-fallback"
  | "duplicate-sample-suppressed";

export interface PrivateTaxonomyImportWarning {
  code: PrivateTaxonomyImportWarningCode;
  subjectKey?: string;
  detail?: string;
}

export interface PrivateTaxonomySessionImportStats {
  v1EvaluationCount: number;
  v2ProjectionCount: number;
  matchedSubjectCount: number;
  v1OnlyCount: number;
  v2OnlyCount: number;
  agreementCount: number;
  disagreementCount: number;
  nativeV2ConfirmedCount: number;
  importedLegacyProjectionCount: number;
  conflictSkippedCount: number;
  suggestedSkippedCount: number;
  directTurnBindingCount: number;
  timestampFallbackCount: number;
  missingTurnCount: number;
  deduplicatedCount: number;
  importedCount: number;
}

export interface PrivateTaxonomySessionImportResult
  extends PrivateCorpusImportResult {
  warnings: PrivateTaxonomyImportWarning[];
  stats: PrivateTaxonomySessionImportStats;
}

const TECHNICAL_TYPES = new Set<CanonicalQuestionType>([
  "coding",
  "general-system-design",
  "ai-ml-system-design",
  "project-deep-dive",
  "field-knowledge",
]);

export function evaluateTaxonomyCorpus(
  corpus: TaxonomyEvaluationExample[],
  classify: (
    example: TaxonomyEvaluationExample
  ) => TaxonomyEvaluationPrediction | QuestionTypeInferenceDecision
): TaxonomyEvaluationReport {
  const rows = corpus.map((example) => {
    const startedAt = readHighResolutionNow();
    const prediction = classify(example);
    const durationMs = Math.max(0, readHighResolutionNow() - startedAt);
    const predictedType = prediction.type ?? "unknown";

    return {
      id: example.id,
      groupId: example.groupId,
      expectedType: example.expectedType,
      predictedType,
      correct: predictedType === example.expectedType,
      confidence: prediction.confidence,
      margin: prediction.margin,
      durationMs,
      language: example.language,
      activeParentType: example.activeParentType,
      tags: [...example.tags],
    } satisfies TaxonomyEvaluationRow;
  });

  const confusionMatrix = createConfusionMatrix();
  for (const row of rows) {
    confusionMatrix[row.expectedType][row.predictedType] += 1;
  }

  const perType = Object.fromEntries(
    CANONICAL_QUESTION_TYPES.map((type) => {
      const support = rows.filter((row) => row.expectedType === type).length;
      const predicted = rows.filter((row) => row.predictedType === type).length;
      const truePositive = rows.filter(
        (row) => row.expectedType === type && row.predictedType === type
      ).length;
      const precision = safeRatio(truePositive, predicted);
      const recall = safeRatio(truePositive, support);
      return [
        type,
        {
          support,
          predicted,
          truePositive,
          precision,
          recall,
          f1: precision + recall ? roundMetric((2 * precision * recall) / (precision + recall)) : 0,
        },
      ];
    })
  ) as Record<CanonicalQuestionType, TaxonomyTypeMetrics>;

  const slices: Record<string, TaxonomySliceMetrics> = {};
  for (const language of ["en", "zh", "mixed"] as const) {
    slices[`language:${language}`] = summarizeRows(
      rows.filter((row) => row.language === language),
      corpus
    );
  }
  slices["parent:none"] = summarizeRows(
    rows.filter((row) => !row.activeParentType),
    corpus
  );
  slices["parent:active"] = summarizeRows(
    rows.filter((row) => Boolean(row.activeParentType)),
    corpus
  );

  const allTags = Array.from(new Set(corpus.flatMap((example) => example.tags))).sort();
  for (const tag of allTags) {
    slices[`tag:${tag}`] = summarizeRows(
      rows.filter((row) => row.tags.includes(tag)),
      corpus
    );
  }

  return {
    version: 1,
    corpusSize: corpus.length,
    metrics: summarizeRows(rows, corpus),
    perType,
    confusionMatrix,
    slices,
    latency: summarizeLatency(rows.map((row) => row.durationMs)),
    rows,
  };
}

export function assignTaxonomyEvaluationSplit(
  groupId: string,
  seed = "jarvis-taxonomy-v1"
): TaxonomyEvaluationSplit {
  const bucket = stableHash(`${seed}:${groupId}`) % 100;
  if (bucket < 60) return "train";
  if (bucket < 80) return "calibration";
  return "held-out";
}

export function splitTaxonomyEvaluationCorpus(
  corpus: TaxonomyEvaluationExample[],
  seed?: string
): Record<TaxonomyEvaluationSplit, TaxonomyEvaluationExample[]> {
  const result: Record<TaxonomyEvaluationSplit, TaxonomyEvaluationExample[]> = {
    train: [],
    calibration: [],
    "held-out": [],
  };

  for (const example of corpus) {
    result[assignTaxonomyEvaluationSplit(example.groupId, seed)].push(example);
  }
  return result;
}

export function importPrivateTaxonomyCorpus({
  sessionId,
  evaluations,
  turns,
  maximumTurnDistanceMs = 120_000,
}: {
  sessionId: string;
  evaluations: PrivateQuestionEvaluationRecord[];
  turns: PrivateTranscriptTurnRecord[];
  maximumTurnDistanceMs?: number;
}): PrivateCorpusImportResult {
  const examples: TaxonomyEvaluationExample[] = [];
  const skipped: PrivateCorpusImportResult["skipped"] = [];
  const interviewerTurns = turns
    .filter(
      (turn) =>
        turn.speaker === "them" &&
        turn.isFinal !== false &&
        Boolean(turn.text.trim())
    )
    .sort((left, right) => left.endedAt - right.endedAt);

  for (const evaluation of evaluations) {
    const expectedType = resolveReviewedQuestionType(evaluation);
    if (!expectedType) {
      skipped.push({
        evaluationId: evaluation.id,
        reason: "missing-reviewed-label",
      });
      continue;
    }

    const sourceTurn = findNearestPriorTurn(
      interviewerTurns,
      evaluation.createdAt,
      maximumTurnDistanceMs
    );
    if (!sourceTurn) {
      skipped.push({
        evaluationId: evaluation.id,
        reason: "missing-nearby-interviewer-turn",
      });
      continue;
    }

    const corrected = Boolean(evaluation.correctedQuestionType);
    examples.push({
      id: `private-${stableHash(
        `${sessionId}:${evaluation.id}:${sourceTurn.id}`
      ).toString(16)}`,
      groupId: `private:${sessionId}:${evaluation.questionId}`,
      text: sourceTurn.text.trim(),
      expectedType,
      language: detectTaxonomyEvaluationLanguage(sourceTurn.text),
      answerableTechnical: TECHNICAL_TYPES.has(expectedType),
      tags: [
        "human-reviewed",
        corrected ? "manual-correction" : "classification-confirmed",
        ...(evaluation.classification?.reasons ?? []).map(
          (reason) => `reason:${reason}`
        ),
        ...(evaluation.manualQuestionTypeCorrectionSource
          ? [`correction-source:${evaluation.manualQuestionTypeCorrectionSource}`]
          : []),
      ],
      source: "private-session",
    });
  }

  return { examples, skipped };
}

export function importPrivateTaxonomySessionCorpus({
  sessionId,
  evaluations,
  projections,
  turns,
  projectionHistoryFallback = false,
  maximumTurnDistanceMs = 120_000,
}: {
  sessionId: string;
  evaluations: PrivateQuestionEvaluationRecord[];
  projections: PrivateHumanEvaluationProjectionRecord[];
  turns: PrivateTranscriptTurnRecord[];
  projectionHistoryFallback?: boolean;
  maximumTurnDistanceMs?: number;
}): PrivateTaxonomySessionImportResult {
  const examples: TaxonomyEvaluationExample[] = [];
  const skipped: PrivateCorpusImportResult["skipped"] = [];
  const warnings: PrivateTaxonomyImportWarning[] = [];
  const stats: PrivateTaxonomySessionImportStats = {
    v1EvaluationCount: evaluations.length,
    v2ProjectionCount: projections.length,
    matchedSubjectCount: 0,
    v1OnlyCount: 0,
    v2OnlyCount: 0,
    agreementCount: 0,
    disagreementCount: 0,
    nativeV2ConfirmedCount: 0,
    importedLegacyProjectionCount: 0,
    conflictSkippedCount: 0,
    suggestedSkippedCount: 0,
    directTurnBindingCount: 0,
    timestampFallbackCount: 0,
    missingTurnCount: 0,
    deduplicatedCount: 0,
    importedCount: 0,
  };
  if (projectionHistoryFallback) {
    warnings.push({ code: "projection-history-fallback" });
  }

  const interviewerTurns = turns
    .filter(
      (turn) =>
        turn.speaker === "them" &&
        turn.isFinal !== false &&
        Boolean(turn.text.trim())
    )
    .sort(
      (left, right) =>
        left.startedAt - right.startedAt || left.id.localeCompare(right.id)
    );
  const interviewerTurnById = new Map(
    interviewerTurns.map((turn) => [turn.id, turn])
  );
  const v1ByKey = new Map<string, PrivateQuestionEvaluationRecord>();
  for (const evaluation of evaluations) {
    const key = `question:${evaluation.questionId}`;
    const previous = v1ByKey.get(key);
    if (previous) {
      stats.deduplicatedCount += 1;
      warnings.push({
        code: "duplicate-sample-suppressed",
        subjectKey: key,
        detail: "duplicate-v1-evaluation",
      });
    }
    if (!previous || evaluation.createdAt >= previous.createdAt) {
      v1ByKey.set(key, evaluation);
    }
  }

  const v2ByKey = new Map<
    string,
    PrivateHumanEvaluationProjectionRecord
  >();
  for (const projection of projections) {
    const key = resolvePrivateProjectionSubjectKey(
      projection,
      evaluations
    );
    if (!key) {
      warnings.push({
        code: "ambiguous-subject-match",
        detail: projection.projectionId,
      });
      continue;
    }
    const previous = v2ByKey.get(key);
    if (previous) {
      stats.deduplicatedCount += 1;
      warnings.push({
        code: "duplicate-sample-suppressed",
        subjectKey: key,
        detail: "duplicate-v2-projection",
      });
    }
    if (
      !previous ||
      (projection.computedAt ?? 0) >= (previous.computedAt ?? 0)
    ) {
      v2ByKey.set(key, projection);
    }
  }

  const subjectKeys = Array.from(
    new Set([...v1ByKey.keys(), ...v2ByKey.keys()])
  ).sort();
  for (const subjectKey of subjectKeys) {
    const evaluation = v1ByKey.get(subjectKey);
    const projection = v2ByKey.get(subjectKey);
    if (evaluation && projection) stats.matchedSubjectCount += 1;

    const v1Type = evaluation
      ? resolveReviewedQuestionType(evaluation)
      : undefined;
    const v2Resolution = projection
      ? resolveProjectionQuestionType(projection, subjectKey, warnings, stats)
      : undefined;
    const v2Label = v2Resolution?.label;
    if (v1Type && !v2Label) {
      stats.v1OnlyCount += 1;
      warnings.push({ code: "v1-only-evaluation", subjectKey });
    }
    if (v2Label && !v1Type) {
      stats.v2OnlyCount += 1;
      warnings.push({ code: "v2-only-projection", subjectKey });
    }
    if (projection && v2Resolution?.blocked && !v2Label) {
      continue;
    }
    if (v1Type && v2Label) {
      if (v1Type === v2Label.expectedType) {
        stats.agreementCount += 1;
      } else {
        stats.disagreementCount += 1;
        warnings.push({
          code: "v1-v2-type-disagreement",
          subjectKey,
          detail: `${v1Type}->${v2Label.expectedType}`,
        });
      }
    }

    const useV2 =
      Boolean(v2Label) &&
      (!v2Label?.importedLegacy || !evaluation);
    const expectedType = useV2 ? v2Label?.expectedType : v1Type;
    if (!expectedType) {
      skipped.push({
        evaluationId:
          evaluation?.id ?? projection?.projectionId ?? subjectKey,
        reason: "missing-reviewed-label",
      });
      continue;
    }

    let sourceTurns: PrivateTranscriptTurnRecord[] = [];
    let usedTimestampFallback = false;
    if (useV2 && projection) {
      sourceTurns = uniqueStrings(projection.subject?.sourceTurnIds ?? [])
        .map((turnId) => interviewerTurnById.get(turnId))
        .filter(
          (turn): turn is PrivateTranscriptTurnRecord => Boolean(turn)
        )
        .sort(
          (left, right) =>
            left.startedAt - right.startedAt ||
            left.id.localeCompare(right.id)
        );
      if (sourceTurns.length) {
        stats.directTurnBindingCount += 1;
      } else if (v2Label?.recordedAt !== undefined) {
        const fallback = findNearestPriorTurn(
          interviewerTurns,
          v2Label.recordedAt,
          maximumTurnDistanceMs
        );
        if (fallback) {
          sourceTurns = [fallback];
          usedTimestampFallback = true;
          stats.timestampFallbackCount += 1;
        }
      }
    } else if (evaluation) {
      const fallback = findNearestPriorTurn(
        interviewerTurns,
        evaluation.createdAt,
        maximumTurnDistanceMs
      );
      if (fallback) {
        sourceTurns = [fallback];
        usedTimestampFallback = true;
        stats.timestampFallbackCount += 1;
      }
    }
    if (!sourceTurns.length) {
      stats.missingTurnCount += 1;
      warnings.push({ code: "missing-source-turn", subjectKey });
      skipped.push({
        evaluationId:
          evaluation?.id ?? projection?.projectionId ?? subjectKey,
        reason: "missing-nearby-interviewer-turn",
      });
      continue;
    }

    const text = sourceTurns
      .map((turn) => turn.text.trim())
      .filter(Boolean)
      .join(" ");
    const corrected = Boolean(evaluation?.correctedQuestionType);
    examples.push({
      id: `private-${stableHash(
        `${sessionId}:${subjectKey}:${sourceTurns
          .map((turn) => turn.id)
          .join(",")}`
      ).toString(16)}`,
      groupId: `private:${sessionId}:${subjectKey.replace(
        /^(?:question|projection|source):/,
        ""
      )}`,
      text,
      expectedType,
      language: detectTaxonomyEvaluationLanguage(text),
      answerableTechnical: TECHNICAL_TYPES.has(expectedType),
      tags: [
        "human-reviewed",
        useV2 ? "v2-active-projection" : "v1-compatible-label",
        ...(usedTimestampFallback ? ["timestamp-fallback"] : []),
        ...(corrected ? ["manual-correction"] : []),
        ...(evaluation?.classification?.reasons ?? []).map(
          (reason) => `reason:${reason}`
        ),
        ...(evaluation?.manualQuestionTypeCorrectionSource
          ? [
              `correction-source:${evaluation.manualQuestionTypeCorrectionSource}`,
            ]
          : []),
      ],
      source: "private-session",
    });
  }

  stats.importedCount = examples.length;
  return { examples, skipped, warnings, stats };
}

export function detectTaxonomyEvaluationLanguage(
  text: string
): TaxonomyEvaluationLanguage {
  const hasHan = /[\u3400-\u9fff]/.test(text);
  const hasLatin = /[a-z]/i.test(text);
  if (hasHan && hasLatin) return "mixed";
  if (hasHan) return "zh";
  return "en";
}

function resolveReviewedQuestionType(
  evaluation: PrivateQuestionEvaluationRecord
): CanonicalQuestionType | undefined {
  if (evaluation.correctedQuestionType) return evaluation.correctedQuestionType;
  if (evaluation.classification?.verdict === "ok") return evaluation.questionType;
  return undefined;
}

function resolveProjectionQuestionType(
  projection: PrivateHumanEvaluationProjectionRecord,
  subjectKey: string,
  warnings: PrivateTaxonomyImportWarning[],
  stats: PrivateTaxonomySessionImportStats
) {
  const conflictKinds = new Set(
    (projection.conflicts ?? [])
      .map((conflict) => conflict.factKind)
      .filter((value): value is string => Boolean(value))
  );
  const candidates = [
    projection.activeFacts?.["expected-task-settlement"],
    projection.activeFacts?.["expected-question-type"],
  ];
  let blocked = false;
  for (const candidate of candidates) {
    if (!candidate?.fact?.kind) continue;
    if (conflictKinds.has(candidate.fact.kind)) {
      blocked = true;
      stats.conflictSkippedCount += 1;
      warnings.push({
        code: "v2-conflicting-facts",
        subjectKey,
        detail: candidate.fact.kind,
      });
      continue;
    }
    if (candidate.confirmation !== "confirmed") {
      blocked = true;
      stats.suggestedSkippedCount += 1;
      warnings.push({
        code: "v2-suggested-type-skipped",
        subjectKey,
        detail: candidate.fact.kind,
      });
      continue;
    }
    const expectedType = normalizeCanonicalQuestionType(
      candidate.fact.expectedQuestionType
    );
    if (!expectedType) continue;
    const importedLegacy =
      candidate.provenance?.source === "imported-legacy";
    if (importedLegacy) {
      stats.importedLegacyProjectionCount += 1;
      warnings.push({
        code: "v2-imported-legacy-fallback",
        subjectKey,
      });
    } else {
      stats.nativeV2ConfirmedCount += 1;
    }
    return {
      blocked: false,
      label: {
        expectedType,
        importedLegacy,
        recordedAt:
          typeof candidate.provenance?.recordedAt === "number"
            ? candidate.provenance.recordedAt
            : undefined,
      },
    };
  }
  return { blocked, label: undefined };
}

function resolvePrivateProjectionSubjectKey(
  projection: PrivateHumanEvaluationProjectionRecord,
  evaluations: PrivateQuestionEvaluationRecord[]
) {
  const questionId = projection.subject?.questionId?.trim();
  if (questionId) return `question:${questionId}`;

  const traceIds = new Set(
    uniqueStrings(projection.subject?.traceIds ?? [])
  );
  if (traceIds.size) {
    const matchingEvaluations = evaluations.filter((evaluation) =>
      (evaluation.traceIds ?? []).some((traceId) => traceIds.has(traceId))
    );
    if (matchingEvaluations.length === 1) {
      return `question:${matchingEvaluations[0].questionId}`;
    }
    if (matchingEvaluations.length > 1) return undefined;
  }

  const sourceTurnIds = uniqueStrings(
    projection.subject?.sourceTurnIds ?? []
  ).sort();
  if (sourceTurnIds.length) {
    return `source:${sourceTurnIds.join(",")}`;
  }
  return projection.projectionId
    ? `projection:${projection.projectionId}`
    : undefined;
}

function findNearestPriorTurn(
  turns: PrivateTranscriptTurnRecord[],
  timestamp: number,
  maximumDistanceMs: number
) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.endedAt > timestamp) continue;
    if (timestamp - turn.endedAt > maximumDistanceMs) return undefined;
    return turn;
  }
  return undefined;
}

function uniqueStrings(values: string[]) {
  return Array.from(
    new Set(
      values.filter(
        (value): value is string =>
          typeof value === "string" && Boolean(value.trim())
      )
    )
  );
}

function createConfusionMatrix() {
  return Object.fromEntries(
    CANONICAL_QUESTION_TYPES.map((expected) => [
      expected,
      Object.fromEntries(
        CANONICAL_QUESTION_TYPES.map((predicted) => [predicted, 0])
      ),
    ])
  ) as Record<
    CanonicalQuestionType,
    Record<CanonicalQuestionType, number>
  >;
}

function summarizeRows(
  rows: TaxonomyEvaluationRow[],
  corpus: TaxonomyEvaluationExample[]
): TaxonomySliceMetrics {
  const ids = new Set(rows.map((row) => row.id));
  const examples = corpus.filter((example) => ids.has(example.id));
  const answerableTechnical = examples.filter(
    (example) => example.answerableTechnical
  );
  const answerableTechnicalUnknownCount = rows.filter(
    (row) =>
      ids.has(row.id) &&
      answerableTechnical.some((example) => example.id === row.id) &&
      row.predictedType === "unknown"
  ).length;
  const unknownExpectedCount = rows.filter(
    (row) => row.expectedType === "unknown"
  ).length;
  const falseActivationCount = rows.filter(
    (row) => row.expectedType === "unknown" && row.predictedType !== "unknown"
  ).length;
  const correct = rows.filter((row) => row.correct).length;

  return {
    total: rows.length,
    correct,
    accuracy: safeRatio(correct, rows.length),
    answerableTechnicalCount: answerableTechnical.length,
    answerableTechnicalUnknownCount,
    answerableTechnicalUnknownRate: safeRatio(
      answerableTechnicalUnknownCount,
      answerableTechnical.length
    ),
    unknownExpectedCount,
    falseActivationCount,
    falseActivationRate: safeRatio(falseActivationCount, unknownExpectedCount),
  };
}

function summarizeLatency(durations: number[]): TaxonomyLatencySummary {
  const sorted = [...durations].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50Ms: roundDuration(readPercentile(sorted, 0.5)),
    p95Ms: roundDuration(readPercentile(sorted, 0.95)),
    maxMs: roundDuration(sorted.length ? sorted[sorted.length - 1] : 0),
  };
}

function readPercentile(sorted: number[], percentile: number) {
  if (!sorted.length) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentile) - 1)
  );
  return sorted[index];
}

function readHighResolutionNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function safeRatio(numerator: number, denominator: number) {
  return denominator ? roundMetric(numerator / denominator) : 0;
}

function roundMetric(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function roundDuration(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function stableHash(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
