import type {
  SemanticTaxonomyEmbeddingResult,
  SemanticTaxonomyRuntimeSnapshot,
} from "./semantic-taxonomy-runtime.js";
import type {
  HybridQuestionTypeDecision,
  SemanticTaxonomyDecision,
} from "./semantic-taxonomy-resolver.js";
import type { QuestionTypeInferenceDecision } from "./task-taxonomy.js";
import type { CanonicalQuestionType } from "./task-taxonomy.js";
import type { SemanticTaxonomyMode } from "./types.js";

export const SEMANTIC_TAXONOMY_SHADOW_VERSION =
  "semantic-taxonomy-shadow-v1";

export interface SemanticTaxonomyShadowEligibility {
  eligible: boolean;
  reason: string;
  wordEquivalent: number;
}

export interface SemanticTaxonomyUnknownRescueDecision {
  applied: boolean;
  effectiveType: CanonicalQuestionType;
  recommendedType?: CanonicalQuestionType;
  reason: string;
  parentMutationBlocked: boolean;
}

export function decideSemanticTaxonomyUnknownRescue({
  mode,
  lexicalType,
  deterministicType,
  recommendedType,
  wouldRescue,
  activeParentType,
  hasManualCorrection,
}: {
  mode: SemanticTaxonomyMode;
  lexicalType: CanonicalQuestionType;
  deterministicType: CanonicalQuestionType;
  recommendedType?: CanonicalQuestionType;
  wouldRescue: boolean;
  activeParentType?: CanonicalQuestionType;
  hasManualCorrection: boolean;
}): SemanticTaxonomyUnknownRescueDecision {
  const effectiveType =
    deterministicType !== "unknown" ? deterministicType : lexicalType;
  const baseline = {
    applied: false,
    effectiveType,
    recommendedType,
    parentMutationBlocked: Boolean(
      wouldRescue && recommendedType && recommendedType !== "unknown"
    ),
  };
  if (mode === "shadow") {
    return { ...baseline, reason: "semantic-taxonomy-shadow-mode" };
  }
  if (hasManualCorrection) {
    return { ...baseline, reason: "manual-correction-authoritative" };
  }
  if (lexicalType !== "unknown") {
    return { ...baseline, reason: "concrete-lexical-type-authoritative" };
  }
  if (!activeParentType && deterministicType !== "unknown") {
    return { ...baseline, reason: "deterministic-route-type-authoritative" };
  }
  if (!wouldRescue || !recommendedType || recommendedType === "unknown") {
    return { ...baseline, reason: "no-calibrated-semantic-rescue" };
  }
  return {
    ...baseline,
    reason: activeParentType
      ? "semantic-evidence-non-authoritative-with-active-parent"
      : "semantic-evidence-non-authoritative",
  };
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
  if (
    turnGateAction !== "answer-refresh" &&
    turnGateAction !== "ignore" &&
    turnGateAction !== "append-only" &&
    turnGateAction !== "state-update"
  ) {
    return {
      eligible: false,
      reason: `turn-gate-${turnGateAction || "unknown"}`,
      wordEquivalent,
    };
  }
  if (wordEquivalent < 3) {
    return { eligible: false, reason: "turn-too-short", wordEquivalent };
  }
  return {
    eligible: true,
    reason:
      turnGateAction === "answer-refresh"
        ? "accepted-latest-interviewer-turn"
        : "substantive-suppressed-or-context-turn",
    wordEquivalent,
  };
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
  mode = "shadow",
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
  mode?: SemanticTaxonomyMode;
}): Record<string, unknown> {
  return {
    semanticTaxonomyShadowVersion: SEMANTIC_TAXONOMY_SHADOW_VERSION,
    semanticTaxonomyMode: mode,
    semanticTaxonomyTurnId: turnId,
    semanticTaxonomySessionId: sessionId,
    semanticTaxonomyRuntimeEpoch: runtimeEpoch,
    taxonomyKeywordType: lexical.type ?? "unknown",
    taxonomyKeywordLegacyType: lexical.legacyType ?? "unknown",
    taxonomyKeywordCertainty: lexical.certainty,
    taxonomyKeywordAuthorityReason: lexical.authorityReason,
    taxonomyKeywordConflictingTypes: lexical.conflictingTypes,
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
    taxonomySemanticQueueWaitMs: embedding?.telemetry.queueWaitMs,
    taxonomySemanticComputeMs: embedding?.telemetry.computeMs,
    taxonomySemanticConsumer: embedding?.telemetry.consumer,
    taxonomySemanticDeadlineProfile:
      embedding?.telemetry.deadlineProfile,
    taxonomySemanticDeadlinePhase: embedding?.telemetry.deadlinePhase,
    taxonomySemanticDeadlineMs: embedding?.telemetry.deadlineMs,
    taxonomySemanticRuntimeOutcome: embedding?.telemetry.outcome,
    taxonomySemanticCoalesced: embedding?.telemetry.coalesced,
    taxonomySemanticStale: embedding?.telemetry.stale,
    taxonomySemanticAbandoned: embedding?.telemetry.abandoned,
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
    taxonomyHybridSemanticDisposition:
      hybrid?.semanticDisposition ?? "abstain",
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
