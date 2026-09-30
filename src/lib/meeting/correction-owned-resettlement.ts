import {
  createRuntimeTypeAdjudicationSettlementProposal,
  createProvisionalCurrentQuestion,
  settleCurrentQuestion,
  type CurrentQuestionRelation,
  type CurrentQuestionSourceKind,
  type CurrentQuestionSettlementDecision,
  type RuntimeTypeAdjudicationSettlementCandidate,
} from "./current-question-settlement.js";
import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import {
  isParentCanonicalQuestionType,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
  type QuestionTypeInferenceDecision,
} from "./task-taxonomy.js";

interface CorrectionParentOrigin {
  sourceQuestionUnitId?: string;
  sourceQuestionRevision?: number;
  canonicalQuestionSourceTurnIds?: string[];
  startTurnId?: string;
}

export const CORRECTION_OWNED_ADJUDICATION_BUDGET_MS = 3_500;
export const CORRECTION_OWNED_ADJUDICATION_MIN_CONFIDENCE = 0.88;

export interface CorrectionOwnedAdjudicationTriggerDecision {
  shouldAdjudicate: boolean;
  reason:
    | "local-type-changed"
    | "corrected-type-conflicts-with-parent"
    | "active-parent-unknown"
    | "strong-domain-term-invalidates-topic"
    | "same-domain-fast-path"
    | "no-active-parent";
  originalLocalType: CanonicalQuestionType;
  correctedLocalType: CanonicalQuestionType;
  activeParentType: CanonicalQuestionType;
  strongDomainTerm: boolean;
}

export type CorrectionOwnedResettlementDisposition =
  | "same-domain-fast-path"
  | "same-question-retype"
  | "semantic-result-rejected"
  | "semantic-result-stale"
  | "semantic-result-timeout"
  | "semantic-provider-unavailable";

export interface CorrectionOwnedResettlementDecision {
  disposition: CorrectionOwnedResettlementDisposition;
  parentMutationAuthorized: boolean;
  correctedType: CanonicalQuestionType;
  relation: CurrentQuestionRelation;
  confidence: number;
  reason: string;
  settlement?: CurrentQuestionSettlementDecision;
}

export function decideCorrectionOwnedAdjudicationTrigger(input: {
  original: QuestionTypeInferenceDecision;
  corrected: QuestionTypeInferenceDecision;
  activeParentType?: unknown;
  normalizedTerm: string;
  activeParentTopic?: string;
}): CorrectionOwnedAdjudicationTriggerDecision {
  const originalLocalType =
    normalizeCanonicalQuestionType(input.original.type) ?? "unknown";
  const correctedLocalType =
    normalizeCanonicalQuestionType(input.corrected.type) ?? "unknown";
  const activeParentType =
    normalizeCanonicalQuestionType(input.activeParentType) ?? "unknown";
  const strongDomainTerm = isStrongDomainCorrectionTerm(
    input.normalizedTerm
  );

  const base = {
    originalLocalType,
    correctedLocalType,
    activeParentType,
    strongDomainTerm,
  };
  if (!input.activeParentType) {
    return {
      ...base,
      shouldAdjudicate: false,
      reason: "no-active-parent",
    };
  }
  if (activeParentType === "unknown") {
    return {
      ...base,
      shouldAdjudicate: true,
      reason: "active-parent-unknown",
    };
  }
  if (
    correctedLocalType !== "unknown" &&
    originalLocalType !== correctedLocalType
  ) {
    return {
      ...base,
      shouldAdjudicate: true,
      reason: "local-type-changed",
    };
  }
  if (
    correctedLocalType !== "unknown" &&
    correctedLocalType !== activeParentType
  ) {
    return {
      ...base,
      shouldAdjudicate: true,
      reason: "corrected-type-conflicts-with-parent",
    };
  }
  if (
    strongDomainTerm &&
    !normalizeText(input.activeParentTopic).includes(
      normalizeText(input.normalizedTerm)
    ) &&
    activeParentType === "general-system-design"
  ) {
    return {
      ...base,
      shouldAdjudicate: true,
      reason: "strong-domain-term-invalidates-topic",
    };
  }
  return {
    ...base,
    shouldAdjudicate: false,
    reason: "same-domain-fast-path",
  };
}

export function resolveCorrectionOwnedTypeResettlement<
  TCandidate extends RuntimeTypeAdjudicationSettlementCandidate,
>(input: {
  logicalQuestionUnit: LogicalQuestionUnit;
  adjudication?: TCandidate;
  operationAuthorized: boolean;
  operationAuthorizationReason?: string;
  activeParentId?: string;
  activeParentRevision?: number;
  activeParentType?: unknown;
  targetOwnsActiveParent: boolean;
  manualCorrectionRevision: number;
  sourceKind?: CurrentQuestionSourceKind;
  sourceObservationIds?: readonly string[];
  minConfidence?: number;
  orderedRelation?: Exclude<CurrentQuestionRelation, "unknown">;
  orderedRelationReason?: string;
  orderedRelationProvenance?: import("./relation-decision-provenance.js").OrderedRelationProvenance;
}): CorrectionOwnedResettlementDecision {
  const activeParentType =
    normalizeCanonicalQuestionType(input.activeParentType) ?? "unknown";
  const adjudication = input.adjudication;
  if (!input.operationAuthorized) {
    return {
      disposition: "semantic-result-stale",
      parentMutationAuthorized: false,
      correctedType: activeParentType,
      relation: "unknown",
      confidence: adjudication?.confidence ?? 0,
      reason:
        input.operationAuthorizationReason ??
        "correction-owned-operation-not-authorized",
    };
  }
  if (!adjudication) {
    return {
      disposition: "semantic-result-rejected",
      parentMutationAuthorized: false,
      correctedType: activeParentType,
      relation: "unknown",
      confidence: 0,
      reason: "correction-owned-type-adjudication-missing",
    };
  }

  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: input.logicalQuestionUnit,
    sourceKind: input.sourceKind ?? "voice",
    sourceObservationIds: input.sourceObservationIds
      ? [...input.sourceObservationIds]
      : undefined,
  });
  const typeProposal = createRuntimeTypeAdjudicationSettlementProposal({
    currentQuestion,
    adjudication,
    expectedParentId: input.activeParentId,
    expectedParentRevision: input.activeParentRevision,
  });
  const settlement = settleCurrentQuestion({
    currentQuestion,
    llmProposal: input.orderedRelation
      ? {
          ...typeProposal,
          relation: input.orderedRelation,
          orderedRelationProvenance: input.orderedRelationProvenance,
          relationEvidenceAuthorized: true,
          reasons: [
            ...(typeProposal.reasons ?? []),
            `ordered-relation:${input.orderedRelationReason ?? "coordinator"}`,
          ],
        }
      : typeProposal,
    activeParentId: input.activeParentId,
    activeParentRevision: input.activeParentRevision,
    manualCorrectionRevision: input.manualCorrectionRevision,
    policy: {
      allowRuntimeTypeAdjudication: true,
      allowLlmRelationRepair: Boolean(input.orderedRelation),
      allowLlmActionRepair: false,
      runtimeTypeAdjudicationMinConfidence:
        input.minConfidence ?? CORRECTION_OWNED_ADJUDICATION_MIN_CONFIDENCE,
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: Boolean(input.orderedRelation),
    },
  });
  const correctedType = settlement.questionType;
  if (
    correctedType === "unknown" ||
    !isParentCanonicalQuestionType(correctedType) ||
    settlement.typeAuthoritySource !== "runtime-adjudication" ||
    !settlement.typeMutationAuthorized
  ) {
    return {
      disposition: "semantic-result-rejected",
      parentMutationAuthorized: false,
      correctedType: activeParentType,
      relation: "unknown",
      confidence: adjudication.confidence,
      reason: "correction-owned-type-settlement-not-authorized",
      settlement,
    };
  }
  if (correctedType === activeParentType) {
    return {
      disposition: "same-domain-fast-path",
      parentMutationAuthorized: false,
      correctedType,
      relation: settlement.relation,
      confidence: adjudication.confidence,
      reason: "corrected-question-remains-in-active-parent-domain",
      settlement,
    };
  }
  if (!input.targetOwnsActiveParent) {
    return {
      disposition: "semantic-result-rejected",
      parentMutationAuthorized: false,
      correctedType,
      relation: "unknown",
      confidence: adjudication.confidence,
      reason: "correction-target-does-not-own-active-parent",
      settlement,
    };
  }
  return {
    disposition: "same-question-retype",
    parentMutationAuthorized: true,
    correctedType,
    relation: settlement.relation,
    confidence: adjudication.confidence,
    reason: "human-correction-changed-current-question-domain",
    settlement,
  };
}

export function correctionTargetOwnsParentOrigin(input: {
  logicalQuestionUnit: LogicalQuestionUnit;
  parent: CorrectionParentOrigin | undefined;
}) {
  const parent = input.parent;
  if (
    !parent?.sourceQuestionUnitId ||
    parent.sourceQuestionRevision === undefined ||
    parent.sourceQuestionUnitId !== input.logicalQuestionUnit.id ||
    input.logicalQuestionUnit.revision < parent.sourceQuestionRevision
  ) {
    return false;
  }

  const parentSourceTurnIds =
    parent.canonicalQuestionSourceTurnIds?.length
      ? parent.canonicalQuestionSourceTurnIds
      : parent.startTurnId
        ? [parent.startTurnId]
        : [];
  return (
    parentSourceTurnIds.length > 0 &&
    parentSourceTurnIds.every((turnId) =>
      input.logicalQuestionUnit.sourceTurnIds.includes(turnId)
    )
  );
}

export function mapCorrectionOwnedPlaybookPhase(input: {
  previousType?: unknown;
  correctedType: CanonicalQuestionType;
  previousPhase?: string;
}) {
  const previousType =
    normalizeCanonicalQuestionType(input.previousType) ?? "unknown";
  const systemDesignRetype =
    (previousType === "general-system-design" ||
      previousType === "ai-ml-system-design") &&
    (input.correctedType === "general-system-design" ||
      input.correctedType === "ai-ml-system-design");
  if (
    systemDesignRetype &&
    (input.previousPhase === "requirement_clarification" ||
      input.previousPhase === "design_framing" ||
      input.previousPhase === "follow_up")
  ) {
    return input.previousPhase;
  }
  return undefined;
}

export function formatCorrectionOwnedResettlementForTrace(input: {
  trigger?: CorrectionOwnedAdjudicationTriggerDecision;
  decision?: CorrectionOwnedResettlementDecision;
  operationId?: string;
  durationMs?: number;
  timedOut?: boolean;
}) {
  return {
    correctionOwnedAdjudicationOperationId: input.operationId,
    correctionOwnedAdjudicationTriggered:
      input.trigger?.shouldAdjudicate ?? false,
    correctionOwnedAdjudicationTriggerReason: input.trigger?.reason,
    correctionOwnedOriginalLocalType:
      input.trigger?.originalLocalType,
    correctionOwnedCorrectedLocalType:
      input.trigger?.correctedLocalType,
    correctionOwnedActiveParentType:
      input.trigger?.activeParentType,
    correctionOwnedStrongDomainTerm:
      input.trigger?.strongDomainTerm,
    correctionOwnedAdjudicationDurationMs: input.durationMs,
    correctionOwnedAdjudicationTimedOut: input.timedOut,
    correctionOwnedResettlementDisposition:
      input.decision?.disposition,
    correctionOwnedResettlementAuthorized:
      input.decision?.parentMutationAuthorized,
    correctionOwnedResettledType: input.decision?.correctedType,
    correctionOwnedResettledRelation: input.decision?.relation,
    correctionOwnedResettlementConfidence:
      input.decision?.confidence,
    correctionOwnedResettlementReason: input.decision?.reason,
    correctionOwnedSettlementId:
      input.decision?.settlement?.settlementId,
  };
}

function isStrongDomainCorrectionTerm(value: string) {
  return /\b(rag|retrieval[- ]augmented generation|vector (?:db|database|store)|embedding(?:s)?|hnsw|ann|llm|transformer|rerank(?:er|ing)?|recommendation|recommender)\b/i.test(
    value.trim()
  );
}

function normalizeText(value: string | undefined) {
  return (value ?? "").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}
