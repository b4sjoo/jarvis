import prototypeVectorsPayload from "../../../model-manifests/semantic-interviewer-intent-prototype-vectors.v1.json" with {
  type: "json",
};
import {
  SEMANTIC_INTERVIEWER_INTENT_PROTOTYPES,
  SEMANTIC_INTERVIEWER_INTENT_PROTOTYPE_VERSION,
  type SemanticInterviewerIntentHead,
  type SemanticInterviewerIntentPrototype,
  type SemanticInterviewerIntentValue,
} from "./semantic-interviewer-intent-prototypes.js";
import { SEMANTIC_TAXONOMY_MODEL_VERSION } from "./semantic-taxonomy-model.js";

export const SEMANTIC_INTERVIEWER_INTENT_CALIBRATION_VERSION =
  "semantic-interviewer-intent-calibration-v1";

export interface SemanticInterviewerIntentHeadDecision {
  head: SemanticInterviewerIntentHead;
  candidate?: SemanticInterviewerIntentValue;
  topCandidate?: SemanticInterviewerIntentValue;
  confidence: number;
  margin: number;
  hardNegativeMargin: number;
  accepted: boolean;
  rejectionReasons: string[];
  positivePrototypeIds: string[];
  hardNegativePrototypeIds: string[];
}

export interface SemanticInterviewerIntentDecision {
  schemaVersion: 1;
  speechAct: SemanticInterviewerIntentHeadDecision;
  relation: SemanticInterviewerIntentHeadDecision;
  evidenceMode: SemanticInterviewerIntentHeadDecision;
  modelVersion: string;
  prototypeVersion: string;
  calibrationVersion: string;
}

interface PrototypeVectorRecord {
  prototype: SemanticInterviewerIntentPrototype;
  vector: number[];
}

const PROTOTYPE_VECTORS = readPrototypeVectors();

const CALIBRATION: Record<
  SemanticInterviewerIntentHead,
  {
    minimumScore: number;
    minimumMargin: number;
    minimumHardNegativeMargin: number;
  }
> = {
  "speech-act": {
    minimumScore: 0.72,
    minimumMargin: 0.008,
    minimumHardNegativeMargin: 0.005,
  },
  relation: {
    minimumScore: 0.72,
    minimumMargin: 0.008,
    minimumHardNegativeMargin: 0.005,
  },
  "evidence-mode": {
    minimumScore: 0.73,
    minimumMargin: 0.01,
    minimumHardNegativeMargin: 0.008,
  },
};

export function scoreSemanticInterviewerIntentEmbeddings(input: {
  unitEmbedding: number[];
  relationEmbedding?: number[];
  activeParentAvailable: boolean;
}): SemanticInterviewerIntentDecision {
  return {
    schemaVersion: 1,
    speechAct: scoreHead("speech-act", input.unitEmbedding),
    relation: input.activeParentAvailable && input.relationEmbedding
      ? scoreHead("relation", input.relationEmbedding)
      : fixedRelationNoneDecision(),
    evidenceMode: scoreHead("evidence-mode", input.unitEmbedding),
    modelVersion: SEMANTIC_TAXONOMY_MODEL_VERSION,
    prototypeVersion: SEMANTIC_INTERVIEWER_INTENT_PROTOTYPE_VERSION,
    calibrationVersion: SEMANTIC_INTERVIEWER_INTENT_CALIBRATION_VERSION,
  };
}

export function formatSemanticInterviewerIntentForTrace(
  decision: SemanticInterviewerIntentDecision | undefined,
  metadata: {
    embeddingStatus: string;
    durationMs?: number;
    cacheHit?: boolean;
    parentId?: string;
    parentRevision?: number;
    logicalQuestionUnitId?: string;
    logicalQuestionUnitRevision?: number;
    staleResultDropped?: boolean;
  }
) {
  return {
    interviewerIntentSemanticSchemaVersion: decision?.schemaVersion ?? 1,
    interviewerIntentSemanticEmbeddingStatus: metadata.embeddingStatus,
    interviewerIntentSemanticDurationMs: metadata.durationMs,
    interviewerIntentSemanticCacheHit: metadata.cacheHit ?? false,
    interviewerIntentSemanticParentId: metadata.parentId,
    interviewerIntentSemanticParentRevision: metadata.parentRevision,
    interviewerIntentSemanticLogicalQuestionUnitId:
      metadata.logicalQuestionUnitId,
    interviewerIntentSemanticLogicalQuestionUnitRevision:
      metadata.logicalQuestionUnitRevision,
    interviewerIntentSemanticStaleResultDropped:
      metadata.staleResultDropped ?? false,
    interviewerIntentSemanticSpeechAct:
      decision?.speechAct.candidate,
    interviewerIntentSemanticSpeechActTopCandidate:
      decision?.speechAct.topCandidate,
    interviewerIntentSemanticSpeechActConfidence:
      decision?.speechAct.confidence,
    interviewerIntentSemanticSpeechActMargin:
      decision?.speechAct.margin,
    interviewerIntentSemanticSpeechActAccepted:
      decision?.speechAct.accepted ?? false,
    interviewerIntentSemanticSpeechActRejectionReasons:
      decision?.speechAct.rejectionReasons ?? [],
    interviewerIntentSemanticRelation: decision?.relation.candidate,
    interviewerIntentSemanticRelationTopCandidate:
      decision?.relation.topCandidate,
    interviewerIntentSemanticRelationConfidence:
      decision?.relation.confidence,
    interviewerIntentSemanticRelationMargin:
      decision?.relation.margin,
    interviewerIntentSemanticRelationAccepted:
      decision?.relation.accepted ?? false,
    interviewerIntentSemanticRelationRejectionReasons:
      decision?.relation.rejectionReasons ?? [],
    interviewerIntentSemanticEvidenceMode:
      decision?.evidenceMode.candidate,
    interviewerIntentSemanticEvidenceModeTopCandidate:
      decision?.evidenceMode.topCandidate,
    interviewerIntentSemanticEvidenceModeConfidence:
      decision?.evidenceMode.confidence,
    interviewerIntentSemanticEvidenceModeMargin:
      decision?.evidenceMode.margin,
    interviewerIntentSemanticEvidenceModeAccepted:
      decision?.evidenceMode.accepted ?? false,
    interviewerIntentSemanticEvidenceModeRejectionReasons:
      decision?.evidenceMode.rejectionReasons ?? [],
    interviewerIntentSemanticModelVersion: decision?.modelVersion,
    interviewerIntentSemanticPrototypeVersion:
      decision?.prototypeVersion,
    interviewerIntentSemanticCalibrationVersion:
      decision?.calibrationVersion,
    interviewerIntentSemanticBehaviorMutationBlocked: true,
  };
}

function scoreHead(
  head: SemanticInterviewerIntentHead,
  query: number[]
): SemanticInterviewerIntentHeadDecision {
  const records = PROTOTYPE_VECTORS.filter(
    (record) => record.prototype.head === head
  );
  const values = [...new Set(records.map((record) => record.prototype.value))];
  const scores = values
    .map((value) => {
      const positives = rank(
        query,
        records.filter(
          (record) =>
            record.prototype.value === value &&
            record.prototype.polarity === "positive"
        )
      ).slice(0, 2);
      const negatives = rank(
        query,
        records.filter(
          (record) =>
            record.prototype.value === value &&
            record.prototype.polarity === "hard-negative"
        )
      ).slice(0, 1);
      const positiveScore = mean(positives.map((item) => item.score));
      const negativeScore = negatives[0]?.score ?? 0;
      return {
        value,
        positiveScore,
        hardNegativeMargin: positiveScore - negativeScore,
        positivePrototypeIds: positives.map(
          (item) => item.record.prototype.id
        ),
        hardNegativePrototypeIds: negatives.map(
          (item) => item.record.prototype.id
        ),
      };
    })
    .sort((left, right) => right.positiveScore - left.positiveScore);
  const top = scores[0];
  const runnerUp = scores[1];
  if (!top) return emptyHeadDecision(head);
  const margin = top.positiveScore - (runnerUp?.positiveScore ?? 0);
  const calibration = CALIBRATION[head];
  const rejectionReasons = [
    ...(top.positiveScore < calibration.minimumScore
      ? ["positive-score-below-threshold"]
      : []),
    ...(margin < calibration.minimumMargin
      ? ["head-margin-below-threshold"]
      : []),
    ...(top.hardNegativeMargin < calibration.minimumHardNegativeMargin
      ? ["hard-negative-margin-below-threshold"]
      : []),
  ];
  const accepted = rejectionReasons.length === 0;
  return {
    head,
    candidate: accepted ? top.value : undefined,
    topCandidate: top.value,
    confidence: round(top.positiveScore),
    margin: round(margin),
    hardNegativeMargin: round(top.hardNegativeMargin),
    accepted,
    rejectionReasons,
    positivePrototypeIds: top.positivePrototypeIds,
    hardNegativePrototypeIds: top.hardNegativePrototypeIds,
  };
}

function fixedRelationNoneDecision(): SemanticInterviewerIntentHeadDecision {
  return {
    head: "relation",
    candidate: "none",
    topCandidate: "none",
    confidence: 1,
    margin: 1,
    hardNegativeMargin: 1,
    accepted: true,
    rejectionReasons: ["active-parent-unavailable"],
    positivePrototypeIds: [],
    hardNegativePrototypeIds: [],
  };
}

function emptyHeadDecision(
  head: SemanticInterviewerIntentHead
): SemanticInterviewerIntentHeadDecision {
  return {
    head,
    confidence: 0,
    margin: 0,
    hardNegativeMargin: 0,
    accepted: false,
    rejectionReasons: ["prototype-bank-empty"],
    positivePrototypeIds: [],
    hardNegativePrototypeIds: [],
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
      SEMANTIC_INTERVIEWER_INTENT_PROTOTYPE_VERSION
  ) {
    return [];
  }
  const vectors = new Map(
    (payload.vectors ?? []).map((record) => [record.id, record.vector])
  );
  return SEMANTIC_INTERVIEWER_INTENT_PROTOTYPES.flatMap((prototype) => {
    const vector = vectors.get(prototype.id);
    return vector ? [{ prototype, vector }] : [];
  });
}

function rank(query: number[], records: PrototypeVectorRecord[]) {
  return records
    .map((record) => ({
      record,
      score: cosineSimilarity(query, record.vector),
    }))
    .sort((left, right) => right.score - left.score);
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
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : 0;
}

function round(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
