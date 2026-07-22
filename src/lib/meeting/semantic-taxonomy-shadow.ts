import type {
  SemanticTaxonomyEmbeddingResult,
  SemanticTaxonomyRuntimeSnapshot,
} from "./semantic-taxonomy-runtime.js";
import type {
  HybridQuestionTypeDecision,
  SemanticTaxonomyDecision,
} from "./semantic-taxonomy-resolver.js";
import type { QuestionTypeInferenceDecision } from "./task-taxonomy.js";

export const SEMANTIC_TAXONOMY_SHADOW_VERSION =
  "semantic-taxonomy-shadow-v1";

export interface SemanticTaxonomyShadowEligibility {
  eligible: boolean;
  reason: string;
  wordEquivalent: number;
}

export function decideSemanticTaxonomyShadowEligibility({
  speaker,
  turnGateAction,
  wordEquivalent,
}: {
  speaker: "me" | "them" | "unknown";
  turnGateAction: string;
  wordEquivalent: number;
}): SemanticTaxonomyShadowEligibility {
  if (speaker !== "them") {
    return { eligible: false, reason: "speaker-is-not-interviewer", wordEquivalent };
  }
  if (turnGateAction !== "answer-refresh") {
    return {
      eligible: false,
      reason: `turn-gate-${turnGateAction || "unknown"}`,
      wordEquivalent,
    };
  }
  if (wordEquivalent < 3) {
    return { eligible: false, reason: "turn-too-short", wordEquivalent };
  }
  return { eligible: true, reason: "accepted-latest-interviewer-turn", wordEquivalent };
}

export function formatSemanticTaxonomyShadowMetadata({
  turnId,
  sessionId,
  runtimeEpoch,
  lexical,
  eligibility,
  runtime,
  embedding,
  semantic,
  hybrid,
}: {
  turnId: string;
  sessionId: string;
  runtimeEpoch: number;
  lexical: QuestionTypeInferenceDecision;
  eligibility: SemanticTaxonomyShadowEligibility;
  runtime: SemanticTaxonomyRuntimeSnapshot;
  embedding?: SemanticTaxonomyEmbeddingResult;
  semantic?: SemanticTaxonomyDecision;
  hybrid?: HybridQuestionTypeDecision;
}): Record<string, unknown> {
  return {
    semanticTaxonomyShadowVersion: SEMANTIC_TAXONOMY_SHADOW_VERSION,
    semanticTaxonomyMode: "shadow",
    semanticTaxonomyTurnId: turnId,
    semanticTaxonomySessionId: sessionId,
    semanticTaxonomyRuntimeEpoch: runtimeEpoch,
    taxonomyKeywordType: lexical.type ?? "unknown",
    taxonomyKeywordConfidence: lexical.confidence,
    taxonomyKeywordMargin: lexical.margin,
    taxonomyKeywordEvidence: lexical.evidence,
    taxonomyKeywordScores: lexical.scores,
    taxonomySemanticEligible: eligibility.eligible,
    taxonomySemanticEligibilityReason: eligibility.reason,
    taxonomySemanticWordEquivalent: eligibility.wordEquivalent,
    taxonomySemanticRuntimeReadiness: runtime.readiness,
    taxonomySemanticWarmupDurationMs: runtime.warmupDurationMs,
    taxonomySemanticReusedAfterAudioRecovery:
      runtime.reusedAfterAudioRecovery,
    taxonomySemanticEmbeddingStatus: embedding?.status ?? "not-requested",
    taxonomySemanticEmbeddingReason:
      embedding && embedding.status !== "success" ? embedding.reason : undefined,
    taxonomySemanticDurationMs: embedding?.durationMs,
    taxonomySemanticCacheHit:
      embedding?.status === "success" ? embedding.cacheHit : false,
    taxonomySemanticTimeout: embedding?.status === "timeout",
    taxonomySemanticCandidateType: semantic?.candidateType,
    taxonomySemanticAccepted: semantic?.accepted ?? false,
    taxonomySemanticConfidence: semantic?.calibratedConfidence,
    taxonomySemanticMargin: semantic?.margin,
    taxonomySemanticRejectionReasons: semantic?.rejectionReasons ?? [],
    taxonomySemanticPositivePrototypeIds:
      semantic?.positivePrototypeIds ?? [],
    taxonomySemanticHardNegativePrototypeIds:
      semantic?.hardNegativePrototypeIds ?? [],
    taxonomySemanticPerTypeScores: semantic?.perTypeScores ?? {},
    taxonomySemanticModelVersion:
      semantic?.modelVersion ?? embedding?.modelVersion ?? runtime.modelVersion,
    taxonomySemanticPrototypeVersion: semantic?.prototypeVersion,
    taxonomySemanticCalibrationVersion: semantic?.calibrationVersion,
    taxonomyHybridOutcome: hybrid?.outcome ?? "semantic-unavailable",
    taxonomyHybridReason:
      hybrid?.reason ??
      (eligibility.eligible
        ? "semantic-result-unavailable"
        : eligibility.reason),
    taxonomyHybridRecommendedType: hybrid?.recommendedType,
    taxonomyHybridWouldRescue: hybrid?.wouldRescue ?? false,
    taxonomyHybridEffectiveType: lexical.type ?? "unknown",
    taxonomySemanticRescueApplied: false,
    taxonomySemanticBehaviorMutationBlocked: true,
  };
}
