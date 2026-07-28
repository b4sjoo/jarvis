import prototypeVectorsPayload from "../../../model-manifests/semantic-taxonomy-prototype-vectors.v1.json" with {
  type: "json",
};
import type {
  CanonicalQuestionType,
  QuestionTypeInferenceDecision,
} from "./task-taxonomy.js";
import {
  SEMANTIC_TAXONOMY_PROTOTYPES,
  SEMANTIC_TAXONOMY_PROTOTYPE_VERSION,
  type ConcreteSemanticQuestionType,
  type TaxonomySemanticPrototype,
} from "./semantic-taxonomy-prototypes.js";
import { SEMANTIC_TAXONOMY_MODEL_VERSION } from "./semantic-taxonomy-model.js";

export const SEMANTIC_TAXONOMY_CALIBRATION_VERSION =
  "semantic-taxonomy-calibration-v1";

export interface SemanticTaxonomyTypeCalibration {
  minimumPositiveScore: number;
  minimumTypeMargin: number;
  minimumHardNegativeMargin: number;
}

export const SEMANTIC_TAXONOMY_CALIBRATION: Record<
  ConcreteSemanticQuestionType,
  SemanticTaxonomyTypeCalibration
> = {
  behavioral: {
    minimumPositiveScore: 0.82,
    minimumTypeMargin: 0.015,
    minimumHardNegativeMargin: 0.02,
  },
  coding: {
    minimumPositiveScore: 0.82,
    minimumTypeMargin: 0.01,
    minimumHardNegativeMargin: 0.015,
  },
  "general-system-design": {
    minimumPositiveScore: 0.81,
    minimumTypeMargin: 0.006,
    minimumHardNegativeMargin: 0.015,
  },
  "ai-ml-system-design": {
    minimumPositiveScore: 0.835,
    minimumTypeMargin: 0.01,
    minimumHardNegativeMargin: 0.01,
  },
  "project-deep-dive": {
    minimumPositiveScore: 0.795,
    minimumTypeMargin: 0.015,
    minimumHardNegativeMargin: 0.02,
  },
  "field-knowledge": {
    minimumPositiveScore: 0.8,
    minimumTypeMargin: 0.015,
    minimumHardNegativeMargin: 0.02,
  },
};

export interface SemanticTaxonomyTypeScore {
  questionType: ConcreteSemanticQuestionType;
  positiveScore: number;
  hardNegativeScore: number;
  hardNegativeMargin: number;
  typeMargin: number;
  passesPositiveGate: boolean;
  passesTypeMarginGate: boolean;
  passesHardNegativeGate: boolean;
  positivePrototypeIds: string[];
  hardNegativePrototypeIds: string[];
}

export interface SemanticTaxonomyDecision {
  candidateType?: ConcreteSemanticQuestionType;
  calibratedConfidence: number;
  margin: number;
  accepted: boolean;
  rejectionReasons: string[];
  perTypeScores: Partial<
    Record<ConcreteSemanticQuestionType, SemanticTaxonomyTypeScore>
  >;
  positivePrototypeIds: string[];
  hardNegativePrototypeIds: string[];
  modelVersion: string;
  prototypeVersion: string;
  calibrationVersion: string;
}

export type HybridTaxonomyOutcome =
  | "lexical-semantic-agree"
  | "lexical-semantic-conflict"
  | "keep-lexical"
  | "semantic-would-rescue"
  | "semantic-rejected"
  | "semantic-unavailable";

export type SemanticTaxonomyDisposition =
  | "support"
  | "conflict"
  | "abstain";

export interface HybridQuestionTypeDecision {
  lexicalType: CanonicalQuestionType;
  effectiveType: CanonicalQuestionType;
  recommendedType?: ConcreteSemanticQuestionType;
  outcome: HybridTaxonomyOutcome;
  semanticDisposition: SemanticTaxonomyDisposition;
  reason: string;
  wouldRescue: boolean;
  lexicalAuthoritative: boolean;
  semantic: SemanticTaxonomyDecision | undefined;
}

interface PrototypeVectorRecord {
  prototype: TaxonomySemanticPrototype;
  vector: number[];
}

const PROTOTYPE_VECTORS = readPrototypeVectors();

export function scoreSemanticTaxonomyEmbedding(
  queryEmbedding: number[],
  prototypes: PrototypeVectorRecord[] = PROTOTYPE_VECTORS
): SemanticTaxonomyDecision {
  const grouped = new Map<ConcreteSemanticQuestionType, PrototypeVectorRecord[]>();
  for (const record of prototypes) {
    const current = grouped.get(record.prototype.questionType) ?? [];
    current.push(record);
    grouped.set(record.prototype.questionType, current);
  }

  const scores: SemanticTaxonomyTypeScore[] = Array.from(
    grouped.entries()
  ).map(([questionType, records]) => {
    const positives = rankPrototypeSimilarity(
      queryEmbedding,
      records.filter((record) => record.prototype.polarity === "positive")
    );
    const negatives = rankPrototypeSimilarity(
      queryEmbedding,
      records.filter((record) => record.prototype.polarity === "hard-negative")
    );
    const selectedPositives = positives.slice(0, 3);
    const selectedNegatives = negatives.slice(0, 1);
    const positiveScore = mean(selectedPositives.map((item) => item.score));
    const hardNegativeScore = selectedNegatives[0]?.score ?? 0;
    return {
      questionType,
      positiveScore,
      hardNegativeScore,
      hardNegativeMargin: positiveScore - hardNegativeScore,
      typeMargin: 0,
      passesPositiveGate: false,
      passesTypeMarginGate: false,
      passesHardNegativeGate: false,
      positivePrototypeIds: selectedPositives.map(
        (item) => item.record.prototype.id
      ),
      hardNegativePrototypeIds: selectedNegatives.map(
        (item) => item.record.prototype.id
      ),
    };
  });
  scores.sort((left, right) => right.positiveScore - left.positiveScore);

  for (const score of scores) {
    const strongestAlternative = scores.find(
      (candidate) => candidate.questionType !== score.questionType
    );
    score.typeMargin =
      score.positiveScore - (strongestAlternative?.positiveScore ?? 0);
    const calibration = SEMANTIC_TAXONOMY_CALIBRATION[score.questionType];
    score.passesPositiveGate =
      score.positiveScore >= calibration.minimumPositiveScore;
    score.passesTypeMarginGate =
      score.typeMargin >= calibration.minimumTypeMargin;
    score.passesHardNegativeGate =
      score.hardNegativeMargin >= calibration.minimumHardNegativeMargin;
  }

  const top = scores[0];
  if (!top) return emptySemanticDecision("prototype-bank-empty");
  const rejectionReasons = [
    ...(!top.passesPositiveGate ? ["positive-score-below-threshold"] : []),
    ...(!top.passesTypeMarginGate ? ["type-margin-below-threshold"] : []),
    ...(!top.passesHardNegativeGate
      ? ["hard-negative-margin-below-threshold"]
      : []),
  ];
  const accepted = rejectionReasons.length === 0;

  return {
    candidateType: accepted ? top.questionType : undefined,
    calibratedConfidence: roundScore(top.positiveScore),
    margin: roundScore(top.typeMargin),
    accepted,
    rejectionReasons,
    perTypeScores: Object.fromEntries(
      scores.map((score) => [score.questionType, roundTypeScore(score)])
    ),
    positivePrototypeIds: top.positivePrototypeIds,
    hardNegativePrototypeIds: top.hardNegativePrototypeIds,
    modelVersion: SEMANTIC_TAXONOMY_MODEL_VERSION,
    prototypeVersion: SEMANTIC_TAXONOMY_PROTOTYPE_VERSION,
    calibrationVersion: SEMANTIC_TAXONOMY_CALIBRATION_VERSION,
  };
}

export function resolveHybridQuestionType({
  lexical,
  semantic,
}: {
  lexical: QuestionTypeInferenceDecision;
  semantic?: SemanticTaxonomyDecision;
}): HybridQuestionTypeDecision {
  const lexicalType = lexical.type ?? "unknown";
  if (!semantic) {
    return {
      lexicalType,
      effectiveType: lexicalType,
      outcome: "semantic-unavailable",
      semanticDisposition: "abstain",
      reason: "semantic-decision-unavailable",
      wouldRescue: false,
      lexicalAuthoritative: lexicalType !== "unknown",
      semantic,
    };
  }

  if (lexicalType !== "unknown") {
    const agrees = semantic.candidateType === lexicalType;
    return {
      lexicalType,
      effectiveType: lexicalType,
      recommendedType: semantic.candidateType,
      outcome: agrees
        ? "lexical-semantic-agree"
        : semantic.candidateType
          ? "lexical-semantic-conflict"
          : "keep-lexical",
      semanticDisposition: agrees
        ? "support"
        : semantic.candidateType
          ? "conflict"
          : "abstain",
      reason: agrees
        ? "semantic-confirms-authoritative-lexical-result"
        : semantic.candidateType
          ? "lexical-result-preserved-on-semantic-conflict"
          : "semantic-did-not-pass-calibrated-gates",
      wouldRescue: false,
      lexicalAuthoritative: true,
      semantic,
    };
  }

  if (semantic.candidateType) {
    return {
      lexicalType,
      effectiveType: "unknown",
      recommendedType: semantic.candidateType,
      outcome: "semantic-would-rescue",
      semanticDisposition: "abstain",
      reason: "calibrated-semantic-candidate-for-lexical-unknown",
      wouldRescue: true,
      lexicalAuthoritative: false,
      semantic,
    };
  }

  return {
    lexicalType,
    effectiveType: "unknown",
    outcome: "semantic-rejected",
    semanticDisposition: "abstain",
    reason: semantic.rejectionReasons.join(",") || "semantic-candidate-rejected",
    wouldRescue: false,
    lexicalAuthoritative: false,
    semantic,
  };
}

function readPrototypeVectors(): PrototypeVectorRecord[] {
  if (
    prototypeVectorsPayload.modelVersion !== SEMANTIC_TAXONOMY_MODEL_VERSION ||
    prototypeVectorsPayload.prototypeVersion !==
      SEMANTIC_TAXONOMY_PROTOTYPE_VERSION
  ) {
    throw new Error("Semantic taxonomy prototype vector version mismatch");
  }
  const vectors = new Map(
    prototypeVectorsPayload.vectors.map((record) => [record.id, record.vector])
  );
  return SEMANTIC_TAXONOMY_PROTOTYPES.map((prototype) => {
    const vector = vectors.get(prototype.id);
    if (!vector) throw new Error(`Missing prototype vector: ${prototype.id}`);
    return { prototype, vector };
  });
}

function rankPrototypeSimilarity(
  queryEmbedding: number[],
  records: PrototypeVectorRecord[]
) {
  return records
    .map((record) => ({
      record,
      score: cosineSimilarity(queryEmbedding, record.vector),
    }))
    .sort((left, right) => right.score - left.score);
}

function cosineSimilarity(left: number[], right: number[]) {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator ? dot / denominator : 0;
}

function roundTypeScore(
  score: SemanticTaxonomyTypeScore
): SemanticTaxonomyTypeScore {
  return {
    ...score,
    positiveScore: roundScore(score.positiveScore),
    hardNegativeScore: roundScore(score.hardNegativeScore),
    hardNegativeMargin: roundScore(score.hardNegativeMargin),
    typeMargin: roundScore(score.typeMargin),
  };
}

function emptySemanticDecision(reason: string): SemanticTaxonomyDecision {
  return {
    calibratedConfidence: 0,
    margin: 0,
    accepted: false,
    rejectionReasons: [reason],
    perTypeScores: {},
    positivePrototypeIds: [],
    hardNegativePrototypeIds: [],
    modelVersion: SEMANTIC_TAXONOMY_MODEL_VERSION,
    prototypeVersion: SEMANTIC_TAXONOMY_PROTOTYPE_VERSION,
    calibrationVersion: SEMANTIC_TAXONOMY_CALIBRATION_VERSION,
  };
}

function mean(values: number[]) {
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : 0;
}

function roundScore(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
