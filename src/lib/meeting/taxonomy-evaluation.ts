import {
  CANONICAL_QUESTION_TYPES,
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
