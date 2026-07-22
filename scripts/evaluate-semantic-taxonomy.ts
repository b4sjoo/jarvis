import path from "node:path";
import process from "node:process";
import { env, pipeline } from "@huggingface/transformers";
import {
  evaluateTaxonomyCorpus,
  splitTaxonomyEvaluationCorpus,
  type TaxonomyEvaluationExample,
} from "../src/lib/meeting/taxonomy-evaluation.js";
import {
  resolveHybridQuestionType,
  scoreSemanticTaxonomyEmbedding,
} from "../src/lib/meeting/semantic-taxonomy-resolver.js";
import { SEMANTIC_TAXONOMY_MODEL } from "../src/lib/meeting/semantic-taxonomy-model.js";
import { inferQuestionTypeDecisionFromText } from "../src/lib/meeting/task-taxonomy.js";
import { TAXONOMY_EVALUATION_CORPUS } from "../tests/fixtures/taxonomy-evaluation-corpus.js";

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = `${path.join(process.cwd(), "public", "models")}${path.sep}`;

const extractor = await pipeline(
  "feature-extraction",
  SEMANTIC_TAXONOMY_MODEL.modelId,
  {
    dtype: SEMANTIC_TAXONOMY_MODEL.dtype,
    device: "cpu",
    revision: SEMANTIC_TAXONOMY_MODEL.revision,
    local_files_only: true,
  }
);
const output = await extractor(
  TAXONOMY_EVALUATION_CORPUS.map((example) => `query: ${example.text}`),
  { pooling: "mean", normalize: true }
);
const queryVectors = output.tolist() as number[][];
await extractor.dispose();

const vectorById = new Map(
  TAXONOMY_EVALUATION_CORPUS.map((example, index) => [
    example.id,
    queryVectors[index],
  ])
);
const semanticById = new Map(
  TAXONOMY_EVALUATION_CORPUS.map((example) => [
    example.id,
    scoreSemanticTaxonomyEmbedding(readVector(example.id)),
  ])
);

const full = evaluateSlice(TAXONOMY_EVALUATION_CORPUS);
const splits = splitTaxonomyEvaluationCorpus(TAXONOMY_EVALUATION_CORPUS);
const report = {
  modelId: SEMANTIC_TAXONOMY_MODEL.modelId,
  full,
  calibration: evaluateSlice(splits.calibration),
  heldOut: evaluateSlice(splits["held-out"]),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function evaluateSlice(corpus: TaxonomyEvaluationExample[]) {
  const lexical = evaluateTaxonomyCorpus(corpus, (example) =>
    inferQuestionTypeDecisionFromText(example.text)
  );
  const semantic = evaluateTaxonomyCorpus(corpus, (example) => {
    const decision = semanticById.get(example.id);
    return {
      type: decision?.candidateType,
      confidence: decision?.calibratedConfidence,
      margin: decision?.margin,
    };
  });
  const hybrid = evaluateTaxonomyCorpus(corpus, (example) => {
    const lexicalDecision = inferQuestionTypeDecisionFromText(example.text);
    const decision = resolveHybridQuestionType({
      lexical: lexicalDecision,
      semantic: semanticById.get(example.id),
    });
    return {
      type:
        lexicalDecision.type ??
        (decision.wouldRescue ? decision.recommendedType : undefined),
    };
  });
  const rescues = corpus
    .map((example) => ({
      example,
      lexical: inferQuestionTypeDecisionFromText(example.text),
      semantic: semanticById.get(example.id),
    }))
    .filter(
      (row) => !row.lexical.type && Boolean(row.semantic?.candidateType)
    );
  const correctRescues = rescues.filter(
    (row) => row.semantic?.candidateType === row.example.expectedType
  );
  const baselineUnknown = lexical.metrics.answerableTechnicalUnknownCount;
  const hybridUnknown = hybrid.metrics.answerableTechnicalUnknownCount;
  return {
    corpusSize: corpus.length,
    lexical: compact(lexical),
    semantic: compact(semantic),
    hybrid: compact(hybrid),
    rescue: {
      count: rescues.length,
      correct: correctRescues.length,
      precision: ratio(correctRescues.length, rescues.length),
      answerableTechnicalUnknownRelativeReduction: baselineUnknown
        ? (baselineUnknown - hybridUnknown) / baselineUnknown
        : 0,
      rows: rescues.map((row) => ({
        id: row.example.id,
        expectedType: row.example.expectedType,
        candidateType: row.semantic?.candidateType,
        correct: row.semantic?.candidateType === row.example.expectedType,
        language: row.example.language,
      })),
    },
    englishConcretePrecision: {
      lexical: concretePrecision(lexical, corpus, "en"),
      hybrid: concretePrecision(hybrid, corpus, "en"),
    },
  };
}

function compact(report: ReturnType<typeof evaluateTaxonomyCorpus>) {
  return {
    accuracy: report.metrics.accuracy,
    answerableTechnicalUnknownCount:
      report.metrics.answerableTechnicalUnknownCount,
    answerableTechnicalUnknownRate:
      report.metrics.answerableTechnicalUnknownRate,
    falseActivationCount: report.metrics.falseActivationCount,
    falseActivationRate: report.metrics.falseActivationRate,
    perType: report.perType,
    confusionMatrix: report.confusionMatrix,
  };
}

function concretePrecision(
  report: ReturnType<typeof evaluateTaxonomyCorpus>,
  corpus: TaxonomyEvaluationExample[],
  language: TaxonomyEvaluationExample["language"]
) {
  const ids = new Set(
    corpus.filter((example) => example.language === language).map((item) => item.id)
  );
  const predicted = report.rows.filter(
    (row) => ids.has(row.id) && row.predictedType !== "unknown"
  );
  return ratio(
    predicted.filter((row) => row.correct).length,
    predicted.length
  );
}

function readVector(id: string) {
  const vector = vectorById.get(id);
  if (!vector) throw new Error(`Missing query vector for ${id}`);
  return vector;
}

function ratio(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : 0;
}
