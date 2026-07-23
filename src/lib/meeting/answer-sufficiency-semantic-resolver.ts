import prototypeVectorsPayload from "../../../model-manifests/answer-sufficiency-semantic-prototype-vectors.v1.json" with {
  type: "json",
};
import {
  ANSWER_SUFFICIENCY_SEMANTIC_PROTOTYPES,
  ANSWER_SUFFICIENCY_SEMANTIC_PROTOTYPE_VERSION,
  type AnswerSufficiencySemanticClass,
  type AnswerSufficiencySemanticPrototype,
} from "./answer-sufficiency-semantic-prototypes.js";
import { SEMANTIC_TAXONOMY_MODEL_VERSION } from "./semantic-taxonomy-model.js";

export const ANSWER_SUFFICIENCY_SEMANTIC_CALIBRATION_VERSION =
  "answer-sufficiency-semantic-calibration-v1";

export interface AnswerSufficiencySemanticDecision {
  candidateStatus?: AnswerSufficiencySemanticClass;
  topCandidateStatus?: AnswerSufficiencySemanticClass;
  confidence: number;
  margin: number;
  accepted: boolean;
  rejectionReasons: string[];
  prototypeIds: string[];
  modelVersion: string;
  prototypeVersion: string;
  calibrationVersion: string;
}

interface PrototypeVectorRecord {
  prototype: AnswerSufficiencySemanticPrototype;
  vector: number[];
}

const PROTOTYPE_VECTORS = readPrototypeVectors();
const MINIMUM_POSITIVE_SCORE = 0.75;
const MINIMUM_CLASS_MARGIN = 0.012;

export function scoreAnswerSufficiencySemanticEmbedding(
  queryEmbedding: number[],
  prototypes: PrototypeVectorRecord[] = PROTOTYPE_VECTORS
): AnswerSufficiencySemanticDecision {
  const grouped = new Map<
    AnswerSufficiencySemanticClass,
    PrototypeVectorRecord[]
  >();
  for (const record of prototypes) {
    const current = grouped.get(record.prototype.semanticClass) ?? [];
    current.push(record);
    grouped.set(record.prototype.semanticClass, current);
  }
  const scores = [...grouped.entries()]
    .map(([semanticClass, records]) => {
      const ranked = records
        .map((record) => ({
          record,
          score: cosineSimilarity(queryEmbedding, record.vector),
        }))
        .sort((left, right) => right.score - left.score);
      const selected = ranked.slice(0, 2);
      return {
        semanticClass,
        score: mean(selected.map((item) => item.score)),
        prototypeIds: selected.map((item) => item.record.prototype.id),
      };
    })
    .sort((left, right) => right.score - left.score);
  const top = scores[0];
  const runnerUp = scores[1];
  if (!top) {
    return {
      confidence: 0,
      margin: 0,
      accepted: false,
      rejectionReasons: ["prototype-bank-empty"],
      prototypeIds: [],
      modelVersion: SEMANTIC_TAXONOMY_MODEL_VERSION,
      prototypeVersion: ANSWER_SUFFICIENCY_SEMANTIC_PROTOTYPE_VERSION,
      calibrationVersion: ANSWER_SUFFICIENCY_SEMANTIC_CALIBRATION_VERSION,
    };
  }
  const margin = top.score - (runnerUp?.score ?? 0);
  const rejectionReasons = [
    ...(top.score < MINIMUM_POSITIVE_SCORE
      ? ["positive-score-below-threshold"]
      : []),
    ...(margin < MINIMUM_CLASS_MARGIN
      ? ["class-margin-below-threshold"]
      : []),
  ];
  const accepted = rejectionReasons.length === 0;
  return {
    candidateStatus: accepted ? top.semanticClass : undefined,
    topCandidateStatus: top.semanticClass,
    confidence: round(top.score),
    margin: round(margin),
    accepted,
    rejectionReasons,
    prototypeIds: top.prototypeIds,
    modelVersion: SEMANTIC_TAXONOMY_MODEL_VERSION,
    prototypeVersion: ANSWER_SUFFICIENCY_SEMANTIC_PROTOTYPE_VERSION,
    calibrationVersion: ANSWER_SUFFICIENCY_SEMANTIC_CALIBRATION_VERSION,
  };
}

function readPrototypeVectors(): PrototypeVectorRecord[] {
  const payload = prototypeVectorsPayload as {
    modelVersion?: string;
    prototypeVersion?: string;
    vectors?: Array<{ id: string; vector: number[] }>;
  };
  if (
    payload.modelVersion !== SEMANTIC_TAXONOMY_MODEL_VERSION ||
    payload.prototypeVersion !==
      ANSWER_SUFFICIENCY_SEMANTIC_PROTOTYPE_VERSION
  ) {
    return [];
  }
  const byId = new Map(
    (payload.vectors ?? []).map((record) => [record.id, record.vector])
  );
  return ANSWER_SUFFICIENCY_SEMANTIC_PROTOTYPES.flatMap((prototype) => {
    const vector = byId.get(prototype.id);
    return vector ? [{ prototype, vector }] : [];
  });
}

function cosineSimilarity(left: number[], right: number[]) {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function mean(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function round(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
