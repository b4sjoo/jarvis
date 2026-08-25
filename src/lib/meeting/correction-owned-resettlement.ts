import {
  createProvisionalCurrentQuestion,
  settleCurrentQuestion,
  type CurrentQuestionRelation,
  type CurrentQuestionSettlementDecision,
  type CurrentQuestionSettlementProposal,
  type ProvisionalCurrentQuestion,
} from "./current-question-settlement.js";
import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import {
  isParentCanonicalQuestionType,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
  type QuestionTypeInferenceDecision,
} from "./task-taxonomy.js";
import type { LlmTaxonomyAdjudication } from "./taxonomy-adjudication.js";

interface CorrectionOwnedQuestionTypeCandidate {
  schemaVersion: 1;
  questionType: CanonicalQuestionType;
  confidence: number;
  evidenceSpans: string[];
  ambiguityReason?: string;
  fieldCodingScores?: {
    codingScore: number;
    fieldKnowledgeScore: number;
    unknownScore: number;
    codingMajorityMargin: number;
  };
}

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

export function resolveCorrectionOwnedResettlement(input: {
  logicalQuestionUnit: LogicalQuestionUnit;
  adjudication?: LlmTaxonomyAdjudication;
  operationAuthorized: boolean;
  operationAuthorizationReason?: string;
  activeParentId?: string;
  activeParentRevision?: number;
  activeParentType?: unknown;
  targetOwnsActiveParent: boolean;
  manualCorrectionRevision: number;
  minConfidence?: number;
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
      reason: "correction-owned-adjudication-missing",
    };
  }

  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: input.logicalQuestionUnit,
    sourceKind: "voice",
  });
  const settlement = settleCurrentQuestion({
    currentQuestion,
    llmProposal: {
      source: "llm-type-repair",
      sessionId: input.logicalQuestionUnit.sessionId,
      runtimeEpoch: input.logicalQuestionUnit.runtimeEpoch,
      logicalQuestionUnitId: input.logicalQuestionUnit.id,
      revision: input.logicalQuestionUnit.revision,
      sourceHash: currentQuestion.sourceHash,
      questionType: adjudication.questionType,
      relation: adjudication.relation,
      action: adjudication.action,
      evidenceMode: adjudication.evidenceMode,
      confidence: adjudication.confidence,
      typeEvidenceAuthorized: true,
      relationEvidenceAuthorized: true,
      actionEvidenceAuthorized: true,
      expectedParentId: input.activeParentId,
      expectedParentRevision: input.activeParentRevision,
      reasons: [
        "human-term-correction-owned-adjudication",
        `speech-act:${adjudication.speechAct}`,
      ],
    },
    activeParentId: input.activeParentId,
    activeParentRevision: input.activeParentRevision,
    manualCorrectionRevision: input.manualCorrectionRevision,
    policy: {
      allowLlmTypeRepair: true,
      allowLlmRelationRepair: true,
      allowLlmActionRepair: false,
      llmTypeRepairMinConfidence:
        input.minConfidence ??
        CORRECTION_OWNED_ADJUDICATION_MIN_CONFIDENCE,
      llmRelationRepairMinConfidence:
        input.minConfidence ??
        CORRECTION_OWNED_ADJUDICATION_MIN_CONFIDENCE,
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: false,
    },
  });
  const correctedType = settlement.questionType;
  const semanticContractValid =
    adjudication.action === "answer" &&
    adjudication.primaryAskSpans.length > 0 &&
    adjudication.normalizedQuestion.trim().length > 0 &&
    correctedType !== "unknown" &&
    isParentCanonicalQuestionType(correctedType);
  if (!semanticContractValid) {
    return {
      disposition: "semantic-result-rejected",
      parentMutationAuthorized: false,
      correctedType: activeParentType,
      relation: settlement.relation,
      confidence: adjudication.confidence,
      reason: "correction-owned-semantic-contract-mismatch",
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
  if (
    settlement.typeAuthoritySource !== "llm-type-repair" ||
    !settlement.typeMutationAuthorized
  ) {
    return {
      disposition: "semantic-result-rejected",
      parentMutationAuthorized: false,
      correctedType: activeParentType,
      relation: settlement.relation,
      confidence: adjudication.confidence,
      reason: "correction-owned-type-settlement-not-authorized",
      settlement,
    };
  }
  if (!input.targetOwnsActiveParent) {
    return {
      disposition: "semantic-result-rejected",
      parentMutationAuthorized: false,
      correctedType,
      relation: settlement.relation,
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

export function resolveCorrectionOwnedTypeResettlement(input: {
  logicalQuestionUnit: LogicalQuestionUnit;
  adjudication?: CorrectionOwnedQuestionTypeCandidate;
  operationAuthorized: boolean;
  operationAuthorizationReason?: string;
  activeParentId?: string;
  activeParentRevision?: number;
  activeParentType?: unknown;
  targetOwnsActiveParent: boolean;
  manualCorrectionRevision: number;
  minConfidence?: number;
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
    sourceKind: "voice",
  });
  const settlement = settleCurrentQuestion({
    currentQuestion,
    llmProposal: createCorrectionOwnedTypeSettlementProposal({
      currentQuestion,
      adjudication,
      expectedParentId: input.activeParentId,
      expectedParentRevision: input.activeParentRevision,
    }),
    activeParentId: input.activeParentId,
    activeParentRevision: input.activeParentRevision,
    manualCorrectionRevision: input.manualCorrectionRevision,
    policy: {
      allowLlmTypeRepair: true,
      allowLlmRelationRepair: false,
      allowLlmActionRepair: false,
      llmTypeRepairMinConfidence:
        input.minConfidence ?? CORRECTION_OWNED_ADJUDICATION_MIN_CONFIDENCE,
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: false,
    },
  });
  const correctedType = settlement.questionType;
  if (
    correctedType === "unknown" ||
    !isParentCanonicalQuestionType(correctedType) ||
    settlement.typeAuthoritySource !== "llm-type-repair" ||
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
      relation: "followup-parent",
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
    relation: "followup-parent",
    confidence: adjudication.confidence,
    reason: "human-correction-changed-current-question-domain",
    settlement,
  };
}

function createCorrectionOwnedTypeSettlementProposal(input: {
  currentQuestion: ProvisionalCurrentQuestion;
  adjudication: CorrectionOwnedQuestionTypeCandidate;
  expectedParentId?: string;
  expectedParentRevision?: number;
}): CurrentQuestionSettlementProposal {
  return {
    source: "llm-type-repair",
    sessionId: input.currentQuestion.sessionId,
    runtimeEpoch: input.currentQuestion.runtimeEpoch,
    logicalQuestionUnitId: input.currentQuestion.logicalQuestionUnitId,
    revision: input.currentQuestion.revision,
    sourceHash: input.currentQuestion.sourceHash,
    questionType: input.adjudication.questionType,
    relation: "unknown",
    confidence: input.adjudication.confidence,
    typeEvidenceAuthorized: true,
    relationEvidenceAuthorized: false,
    actionEvidenceAuthorized: false,
    expectedParentId: input.expectedParentId,
    expectedParentRevision: input.expectedParentRevision,
    reasons: [
      "question-type-runtime-operation",
      "relation-authority-withheld",
      "parent-mutation-withheld",
    ],
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
