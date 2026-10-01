import {
  getLogicalQuestionSemanticEvidenceText,
  type LogicalQuestionUnit,
} from "./logical-question-unit.js";
import type {
  InterviewerEvidenceMode,
  InterviewerIntentAction,
  InterviewerIntentRelation,
} from "./interviewer-intent.js";
import {
  isParentCanonicalQuestionType,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import type { InterviewTaskRelation } from "./types.js";
import { adoptedOrderedRelationProvenance, type OrderedRelationProvenance } from "./relation-decision-provenance.js";
import {
  resolveCurrentQuestionSourceKind,
  type CurrentQuestionSourceKind,
} from "./current-question-source.js";

export {
  authorizeSettlementOwnedQuestionContext,
  formatSettlementOwnedQuestionContextForTrace,
  resolveCurrentQuestionSourceKind,
  resolveSettlementOwnedQuestionSource,
  type CurrentQuestionSourceKind,
  type SettlementOwnedQuestionContextDecision,
  type SettlementOwnedQuestionContextReason,
} from "./current-question-source.js";

export type CurrentQuestionAuthority =
  | "explicit-manual"
  | "deterministic-fast-path"
  | "runtime-adjudication"
  | "provisional-only";

export type CurrentQuestionAuthoritySource =
  | "manual-correction"
  | "opening-route"
  | "accepted-transcript"
  | "semantic-unknown-rescue"
  | "accepted-llm-type-first-parent"
  | "runtime-adjudication"
  | "provisional-only";

export type CurrentQuestionRelation =
  | InterviewTaskRelation
  | InterviewerIntentRelation;

export interface ProvisionalCurrentQuestion {
  logicalQuestionUnitId: string;
  revision: number;
  sessionId: string;
  runtimeEpoch: number;
  normalizedText: string;
  sourceTurnIds: string[];
  sourceObservationIds: string[];
  sourceKind: CurrentQuestionSourceKind;
  sourceHash: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

export type CurrentQuestionSettlementIdentityMismatchReason =
  | "session-mismatch"
  | "runtime-epoch-mismatch"
  | "logical-question-unit-mismatch"
  | "logical-question-revision-mismatch"
  | "source-hash-mismatch";

export interface CurrentQuestionSettlementIdentityValidation {
  authorized: boolean;
  reasons: CurrentQuestionSettlementIdentityMismatchReason[];
}

export interface CurrentQuestionMutationAuthorityDecision {
  authority: CurrentQuestionAuthority;
  authoritySource: CurrentQuestionAuthoritySource;
  questionType: CanonicalQuestionType;
  relation: CurrentQuestionRelation;
  typeMutationAuthorized: boolean;
  relationMutationAuthorized: boolean;
  parentMutationAuthorized: boolean;
  responseAuthorized: boolean;
  reasons: string[];
}

export type CurrentQuestionSettlementProposalSource =
  | "manual-correction"
  | "deterministic-fast-path"
  | "runtime-adjudication";

export type CurrentQuestionSettlementProposalRejectionReason =
  | "session-mismatch"
  | "runtime-epoch-mismatch"
  | "logical-question-unit-mismatch"
  | "logical-question-revision-mismatch"
  | "source-hash-mismatch"
  | "manual-correction-revision-mismatch"
  | "expected-parent-mismatch"
  | "expected-parent-revision-mismatch"
  | "runtime-adjudication-disabled"
  | "runtime-adjudication-low-confidence"
  | "question-type-unresolved"
  | "type-evidence-not-authorized"
  | "relation-evidence-not-authorized"
  | "llm-relation-shadow-only"
  | "llm-relation-repair-low-confidence"
  | "llm-action-repair-disabled";

export interface CurrentQuestionSettlementProposal {
  orderedRelationProvenance?: OrderedRelationProvenance;
  source: CurrentQuestionSettlementProposalSource;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  revision: number;
  sourceHash?: string;
  questionType?: unknown;
  relation?: CurrentQuestionRelation;
  preserveActiveChild?: boolean;
  action?: InterviewerIntentAction;
  evidenceMode?: InterviewerEvidenceMode;
  confidence?: number;
  typeEvidenceAuthorized?: boolean;
  relationEvidenceAuthorized?: boolean;
  actionEvidenceAuthorized?: boolean;
  manualCorrectionRevision?: number;
  expectedParentId?: string;
  expectedParentRevision?: number;
  reasons?: string[];
}

export interface RuntimeTypeAdjudicationSettlementCandidate {
  questionType: CanonicalQuestionType;
  confidence: number;
}

export function createRuntimeTypeAdjudicationSettlementProposal<
  TCandidate extends RuntimeTypeAdjudicationSettlementCandidate,
>(input: {
  currentQuestion: ProvisionalCurrentQuestion;
  adjudication: TCandidate;
  expectedParentId?: string;
  expectedParentRevision?: number;
}): CurrentQuestionSettlementProposal {
  return {
    source: "runtime-adjudication",
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

export interface CurrentQuestionSettlementProposalRejection {
  source: CurrentQuestionSettlementProposalSource;
  reasons: CurrentQuestionSettlementProposalRejectionReason[];
}

export interface CurrentQuestionSettlementPolicy {
  allowRuntimeTypeAdjudication?: boolean;
  allowLlmRelationRepair?: boolean;
  allowLlmActionRepair?: boolean;
  runtimeTypeAdjudicationMinConfidence?: number;
  llmRelationRepairMinConfidence?: number;
  runtimeMutationAuthorized: boolean;
  questionComplete: boolean;
  commitParent: boolean;
}

export interface CurrentQuestionSettlementDecision {
  orderedRelationProvenance?: OrderedRelationProvenance;
  settlementId: string;
  operationId?: string;
  logicalQuestionUnitId: string;
  revision: number;
  sessionId: string;
  runtimeEpoch: number;
  sourceKind: CurrentQuestionSourceKind;
  sourceTurnIds: string[];
  sourceObservationIds: string[];
  sourceHash: string;
  questionType: CanonicalQuestionType;
  relation: CurrentQuestionRelation;
  preserveActiveChild?: boolean;
  action: InterviewerIntentAction;
  evidenceMode: InterviewerEvidenceMode;
  authority: CurrentQuestionAuthority;
  authoritySource: CurrentQuestionAuthoritySource;
  typeAuthoritySource: CurrentQuestionSettlementProposalSource | "provisional";
  relationAuthoritySource:
    | CurrentQuestionSettlementProposalSource
    | "provisional";
  actionAuthoritySource:
    | CurrentQuestionSettlementProposalSource
    | "provisional";
  typeMutationAuthorized: boolean;
  relationMutationAuthorized: boolean;
  parentMutationAuthorized: boolean;
  responseAuthorized: boolean;
  confidence: number;
  activeParentId?: string;
  activeParentRevision?: number;
  manualCorrectionRevision: number;
  rejectedProposals: CurrentQuestionSettlementProposalRejection[];
  reasons: string[];
}

export interface EffectiveCurrentQuestionSettlement
  extends CurrentQuestionSettlementDecision {
  effective: true;
  effectiveRevision: number;
  rawQuestionType: CanonicalQuestionType;
  rawRelation: CurrentQuestionRelation;
  nullHypothesisApplied: boolean;
  nullHypothesisReason?:
    | "active-child-preserved"
    | "active-parent-preserved"
    | "deliberate-screen-milestone"
    | "no-parent-current-question";
  effectiveParentId?: string;
  effectiveParentRevision?: number;
  effectiveChildId?: string;
}

export function selectCommittedSettlementForLogicalQuestionUnit(input: {
  settlement?: CurrentQuestionSettlementDecision;
  logicalQuestionUnit?: Pick<LogicalQuestionUnit, "id" | "revision">;
}) {
  const { settlement, logicalQuestionUnit } = input;
  if (
    !settlement ||
    !logicalQuestionUnit ||
    settlement.logicalQuestionUnitId !== logicalQuestionUnit.id ||
    settlement.revision !== logicalQuestionUnit.revision
  ) {
    return undefined;
  }
  return settlement;
}





export type CurrentQuestionSettlementDisposition =
  | "domain-resolved-provisional"
  | "domain-resolved-unknown"
  | "unresolved-provisional"
  | "committed-parent"
  | "stale-dropped"
  | "manual-authority";

export function resolveCurrentQuestionSettlementDisposition(input: {
  settlement: CurrentQuestionSettlementDecision;
  parentCommitted?: boolean;
  staleDropped?: boolean;
  transientDomainResolved?: boolean;
}): CurrentQuestionSettlementDisposition {
  if (input.staleDropped) return "stale-dropped";
  if (input.settlement.authority === "explicit-manual") {
    return "manual-authority";
  }
  if (input.parentCommitted) return "committed-parent";
  if (
    input.transientDomainResolved &&
    input.settlement.questionType === "unknown"
  ) {
    return "domain-resolved-unknown";
  }
  if (input.settlement.questionType === "unknown") {
    return "unresolved-provisional";
  }
  return "domain-resolved-provisional";
}

export function createProvisionalCurrentQuestion(input: {
  logicalQuestionUnit: LogicalQuestionUnit;
  sourceKind: CurrentQuestionSourceKind;
  sourceObservationIds?: string[];
  expiresAt?: number;
  now?: number;
}): ProvisionalCurrentQuestion {
  const { logicalQuestionUnit } = input;
  const semanticEvidenceText =
    getLogicalQuestionSemanticEvidenceText(logicalQuestionUnit);
  const sourceTurnIds = uniqueStrings(logicalQuestionUnit.sourceTurnIds);
  const sourceObservationIds = uniqueStrings(
    input.sourceObservationIds ?? []
  );
  const sourceHash = hashCurrentQuestionSource({
    sessionId: logicalQuestionUnit.sessionId,
    runtimeEpoch: logicalQuestionUnit.runtimeEpoch,
    logicalQuestionUnitId: logicalQuestionUnit.id,
    revision: logicalQuestionUnit.revision,
    normalizedText: semanticEvidenceText,
    sourceTurnIds,
    sourceObservationIds,
  });

  return {
    logicalQuestionUnitId: logicalQuestionUnit.id,
    revision: logicalQuestionUnit.revision,
    sessionId: logicalQuestionUnit.sessionId,
    runtimeEpoch: logicalQuestionUnit.runtimeEpoch,
    normalizedText: semanticEvidenceText,
    sourceTurnIds,
    sourceObservationIds,
    sourceKind: resolveCurrentQuestionSourceKind({
      sourceTurnIds,
      sourceObservationIds,
      fallback: input.sourceKind,
    }),
    sourceHash,
    createdAt: logicalQuestionUnit.startedAt,
    updatedAt: input.now ?? logicalQuestionUnit.updatedAt,
    expiresAt: input.expiresAt,
  };
}

export function validateCurrentQuestionSettlementIdentity(input: {
  settlement: Pick<
    CurrentQuestionSettlementDecision,
    | "sessionId"
    | "runtimeEpoch"
    | "logicalQuestionUnitId"
    | "revision"
    | "sourceHash"
  >;
  currentQuestion: Pick<
    ProvisionalCurrentQuestion,
    | "sessionId"
    | "runtimeEpoch"
    | "logicalQuestionUnitId"
    | "revision"
    | "sourceHash"
  >;
}): CurrentQuestionSettlementIdentityValidation {
  const reasons: CurrentQuestionSettlementIdentityMismatchReason[] = [];
  if (input.settlement.sessionId !== input.currentQuestion.sessionId) {
    reasons.push("session-mismatch");
  }
  if (input.settlement.runtimeEpoch !== input.currentQuestion.runtimeEpoch) {
    reasons.push("runtime-epoch-mismatch");
  }
  if (
    input.settlement.logicalQuestionUnitId !==
    input.currentQuestion.logicalQuestionUnitId
  ) {
    reasons.push("logical-question-unit-mismatch");
  }
  if (input.settlement.revision !== input.currentQuestion.revision) {
    reasons.push("logical-question-revision-mismatch");
  }
  if (input.settlement.sourceHash !== input.currentQuestion.sourceHash) {
    reasons.push("source-hash-mismatch");
  }
  return { authorized: reasons.length === 0, reasons };
}

export function formatCurrentQuestionSettlementIdentityValidationForTrace(
  validation: CurrentQuestionSettlementIdentityValidation | undefined
): Record<string, unknown> {
  return {
    currentQuestionSettlementInputIdentityAuthorized:
      validation?.authorized,
    currentQuestionSettlementInputIdentityMismatchReasons:
      validation?.reasons ?? [],
  };
}

export function createCurrentQuestionSourceSettlementId(
  question: Pick<
    ProvisionalCurrentQuestion,
    | "sessionId"
    | "runtimeEpoch"
    | "logicalQuestionUnitId"
    | "revision"
    | "sourceTurnIds"
  >
) {
  return `question_source_settlement_${hashStableText(
    [
      question.sessionId,
      question.runtimeEpoch,
      question.logicalQuestionUnitId,
      question.revision,
      uniqueStrings(question.sourceTurnIds).join(","),
    ].join("|")
  )}`;
}

export function decideCurrentQuestionMutationAuthority(input: {
  currentQuestion: ProvisionalCurrentQuestion;
  proposedQuestionType?: unknown;
  proposedRelation: CurrentQuestionRelation;
  authoritySource: CurrentQuestionAuthoritySource;
  typeEvidenceAuthorized: boolean;
  relationEvidenceAuthorized: boolean;
  runtimeMutationAuthorized: boolean;
  questionComplete: boolean;
  commitParent: boolean;
}): CurrentQuestionMutationAuthorityDecision {
  const questionType =
    normalizeCanonicalQuestionType(input.proposedQuestionType) ?? "unknown";
  const authority = resolveCurrentQuestionAuthority(input.authoritySource);
  const typeMutationAuthorized =
    input.typeEvidenceAuthorized && questionType !== "unknown";
  const relationMutationAuthorized =
    input.relationEvidenceAuthorized &&
    input.proposedRelation !== "unknown";
  const responseAuthorized = Boolean(
    input.currentQuestion.normalizedText.trim()
  );
  const parentMutationAuthorized =
    typeMutationAuthorized &&
    relationMutationAuthorized &&
    input.runtimeMutationAuthorized &&
    input.questionComplete &&
    input.commitParent &&
    input.proposedRelation === "new-parent" &&
    isParentCanonicalQuestionType(questionType);

  const reasons: string[] = [];
  if (!responseAuthorized) reasons.push("current-question-empty");
  if (questionType === "unknown") reasons.push("question-type-unresolved");
  if (!input.typeEvidenceAuthorized) {
    reasons.push("type-evidence-not-authorized");
  }
  if (input.proposedRelation === "unknown") {
    reasons.push("question-relation-unresolved");
  } else if (!input.relationEvidenceAuthorized) {
    reasons.push("relation-evidence-not-authorized");
  }
  if (!input.runtimeMutationAuthorized) {
    reasons.push("runtime-mutation-not-authorized");
  }
  if (!input.questionComplete) reasons.push("question-incomplete");
  if (!input.commitParent) reasons.push("parent-commit-not-requested");
  if (
    input.proposedRelation !== "new-parent" &&
    input.proposedRelation !== "unknown"
  ) {
    reasons.push("relation-does-not-create-parent");
  }
  if (
    questionType !== "unknown" &&
    !isParentCanonicalQuestionType(questionType)
  ) {
    reasons.push("question-type-not-parent-eligible");
  }
  if (parentMutationAuthorized) reasons.push("parent-mutation-authorized");
  if (!reasons.length) {
    reasons.push("response-authorized-without-parent-mutation");
  }

  return {
    authority,
    authoritySource: input.authoritySource,
    questionType,
    relation: input.proposedRelation,
    typeMutationAuthorized,
    relationMutationAuthorized,
    parentMutationAuthorized,
    responseAuthorized,
    reasons,
  };
}

export function settleCurrentQuestion(input: {
  currentQuestion: ProvisionalCurrentQuestion;
  operationId?: string;
  deterministicProposal?: CurrentQuestionSettlementProposal;
  llmProposal?: CurrentQuestionSettlementProposal;
  runtimeTypeProposal?: CurrentQuestionSettlementProposal;
  runtimeRelationProposal?: CurrentQuestionSettlementProposal;
  manualProposal?: CurrentQuestionSettlementProposal;
  activeParentId?: string;
  activeParentRevision?: number;
  manualCorrectionRevision: number;
  policy: CurrentQuestionSettlementPolicy;
}): CurrentQuestionSettlementDecision {
  const rejectedProposals: CurrentQuestionSettlementProposalRejection[] = [];
  const validManual = validateSettlementProposal({
    proposal: input.manualProposal,
    expectedSource: "manual-correction",
    currentQuestion: input.currentQuestion,
    activeParentId: input.activeParentId,
    activeParentRevision: input.activeParentRevision,
    manualCorrectionRevision: input.manualCorrectionRevision,
    policy: input.policy,
  });
  const validDeterministic = validateSettlementProposal({
    proposal: input.deterministicProposal,
    expectedSource: "deterministic-fast-path",
    currentQuestion: input.currentQuestion,
    activeParentId: input.activeParentId,
    activeParentRevision: input.activeParentRevision,
    manualCorrectionRevision: input.manualCorrectionRevision,
    policy: input.policy,
  });
  const validLlm = validateSettlementProposal({
    proposal: input.llmProposal,
    expectedSource: "runtime-adjudication",
    currentQuestion: input.currentQuestion,
    activeParentId: input.activeParentId,
    activeParentRevision: input.activeParentRevision,
    manualCorrectionRevision: input.manualCorrectionRevision,
    policy: input.policy,
  });
  const validRuntimeType = validateSettlementProposal({
    proposal: input.runtimeTypeProposal,
    expectedSource: "runtime-adjudication",
    currentQuestion: input.currentQuestion,
    activeParentId: input.activeParentId,
    activeParentRevision: input.activeParentRevision,
    manualCorrectionRevision: input.manualCorrectionRevision,
    policy: input.policy,
  });
  const validRuntimeRelation = validateSettlementProposal({
    proposal: input.runtimeRelationProposal,
    expectedSource: "runtime-adjudication",
    currentQuestion: input.currentQuestion,
    activeParentId: input.activeParentId,
    activeParentRevision: input.activeParentRevision,
    manualCorrectionRevision: input.manualCorrectionRevision,
    policy: input.policy,
  });

  for (const validation of [
    validManual,
    validDeterministic,
    validLlm,
    validRuntimeType,
    validRuntimeRelation,
  ]) {
    if (validation.rejection) {
      rejectedProposals.push(validation.rejection);
    }
  }

  const typeSelection = selectQuestionType({
    manual: validManual.proposal,
    deterministic: validDeterministic.proposal,
    llm: validRuntimeType.proposal ?? validLlm.proposal,
    policy: input.policy,
    rejectedProposals,
  });
  const relationSelection = selectQuestionRelation({
    manual: validManual.proposal,
    deterministic: validDeterministic.proposal,
    llm: validRuntimeRelation.proposal ?? validLlm.proposal,
    policy: input.policy,
    rejectedProposals,
  });
  const actionSelection = selectQuestionAction({
    manual: validManual.proposal,
    deterministic: validDeterministic.proposal,
    llm: validRuntimeType.proposal ?? validLlm.proposal,
    policy: input.policy,
    rejectedProposals,
  });
  const evidenceModeSelection = selectEvidenceMode({
    manual: validManual.proposal,
    deterministic: validDeterministic.proposal,
    llm:
      validRuntimeType.proposal ??
      validRuntimeRelation.proposal ??
      validLlm.proposal,
    questionType: typeSelection.value,
  });
  const authoritySource = proposalSourceToAuthoritySource(
    typeSelection.source,
    relationSelection.source,
    actionSelection.source
  );
  const mutationAuthority = decideCurrentQuestionMutationAuthority({
    currentQuestion: input.currentQuestion,
    proposedQuestionType: typeSelection.value,
    proposedRelation: relationSelection.value,
    authoritySource,
    typeEvidenceAuthorized: typeSelection.authorized,
    relationEvidenceAuthorized: relationSelection.authorized,
    runtimeMutationAuthorized: input.policy.runtimeMutationAuthorized,
    questionComplete: input.policy.questionComplete,
    commitParent: input.policy.commitParent,
  });
  const responseAuthorized =
    mutationAuthority.responseAuthorized &&
    actionSelection.value === "answer";
  const reasons = uniqueStrings([
    ...mutationAuthority.reasons,
    ...(typeSelection.proposal?.reasons ?? []),
    ...(relationSelection.proposal?.reasons ?? []),
    ...(actionSelection.proposal?.reasons ?? []),
    responseAuthorized
      ? "response-authorized"
      : `response-not-authorized:${actionSelection.value}`,
    ...rejectedProposals.flatMap((rejection) =>
      rejection.reasons.map(
        (reason) => `proposal-rejected:${rejection.source}:${reason}`
      )
    ),
  ]);
  const confidence = Math.max(
    typeSelection.confidence,
    relationSelection.confidence,
    actionSelection.confidence
  );
  const settlementId = createSettlementId({
    currentQuestion: input.currentQuestion,
    questionType: typeSelection.value,
    relation: relationSelection.value,
    action: actionSelection.value,
    authority: mutationAuthority.authority,
    preserveActiveChild: relationSelection.proposal?.preserveActiveChild,
    typeAuthoritySource: typeSelection.source,
    relationAuthoritySource: relationSelection.source,
    actionAuthoritySource: actionSelection.source,
    activeParentId: input.activeParentId,
    activeParentRevision: input.activeParentRevision,
    manualCorrectionRevision: input.manualCorrectionRevision,
  });

  return {
    settlementId,
    orderedRelationProvenance: relationSelection.authorized
      ? adoptedOrderedRelationProvenance(relationSelection.proposal, input.currentQuestion) : undefined,
    operationId: input.operationId,
    logicalQuestionUnitId:
      input.currentQuestion.logicalQuestionUnitId,
    revision: input.currentQuestion.revision,
    sessionId: input.currentQuestion.sessionId,
    runtimeEpoch: input.currentQuestion.runtimeEpoch,
    sourceKind: input.currentQuestion.sourceKind,
    sourceTurnIds: [...input.currentQuestion.sourceTurnIds],
    sourceObservationIds: [
      ...input.currentQuestion.sourceObservationIds,
    ],
    sourceHash: input.currentQuestion.sourceHash,
    questionType: typeSelection.value,
    relation: relationSelection.value,
    action: actionSelection.value,
    evidenceMode: evidenceModeSelection,
    preserveActiveChild: relationSelection.proposal?.preserveActiveChild,
    authority: mutationAuthority.authority,
    authoritySource,
    typeAuthoritySource: typeSelection.source,
    relationAuthoritySource: relationSelection.source,
    actionAuthoritySource: actionSelection.source,
    typeMutationAuthorized:
      mutationAuthority.typeMutationAuthorized,
    relationMutationAuthorized:
      mutationAuthority.relationMutationAuthorized,
    parentMutationAuthorized:
      mutationAuthority.parentMutationAuthorized,
    responseAuthorized,
    confidence,
    activeParentId: input.activeParentId,
    activeParentRevision: input.activeParentRevision,
    manualCorrectionRevision: input.manualCorrectionRevision,
    rejectedProposals,
    reasons,
  };
}

export function finalizeCurrentQuestionFirstParentSettlement(input: {
  currentQuestion: ProvisionalCurrentQuestion;
  typeOnlySettlement: CurrentQuestionSettlementDecision;
}): CurrentQuestionSettlementDecision | undefined {
  const { currentQuestion, typeOnlySettlement } = input;
  if (
    typeOnlySettlement.logicalQuestionUnitId !==
      currentQuestion.logicalQuestionUnitId ||
    typeOnlySettlement.revision !== currentQuestion.revision ||
    typeOnlySettlement.sessionId !== currentQuestion.sessionId ||
    typeOnlySettlement.runtimeEpoch !== currentQuestion.runtimeEpoch ||
    typeOnlySettlement.sourceHash !== currentQuestion.sourceHash ||
    typeOnlySettlement.activeParentId !== undefined ||
    typeOnlySettlement.typeAuthoritySource !== "runtime-adjudication" ||
    !typeOnlySettlement.typeMutationAuthorized ||
    typeOnlySettlement.relationMutationAuthorized ||
    typeOnlySettlement.relation !== "unknown" ||
    !isParentCanonicalQuestionType(typeOnlySettlement.questionType)
  ) {
    return undefined;
  }

  const relation = "new-parent" as const;
  const action = "answer" as const;
  const settlementId = createSettlementId({
    currentQuestion,
    questionType: typeOnlySettlement.questionType,
    relation,
    action,
    authority: "runtime-adjudication",
    typeAuthoritySource: typeOnlySettlement.typeAuthoritySource,
    relationAuthoritySource: "deterministic-fast-path",
    actionAuthoritySource: "deterministic-fast-path",
    manualCorrectionRevision:
      typeOnlySettlement.manualCorrectionRevision,
  });

  return {
    ...typeOnlySettlement,
    settlementId,
    sourceKind: currentQuestion.sourceKind,
    sourceTurnIds: [...currentQuestion.sourceTurnIds],
    sourceObservationIds: [...currentQuestion.sourceObservationIds],
    sourceHash: currentQuestion.sourceHash,
    relation,
    action,
    authority: "runtime-adjudication",
    authoritySource: "accepted-llm-type-first-parent",
    relationAuthoritySource: "deterministic-fast-path",
    actionAuthoritySource: "deterministic-fast-path",
    relationMutationAuthorized: true,
    parentMutationAuthorized: true,
    responseAuthorized: true,
    reasons: uniqueStrings([
      ...typeOnlySettlement.reasons,
      "first-parent-relation-deterministically-composed",
      "parent-mutation-authorized",
      "response-authorized",
    ]),
  };
}

export function settlementAuthorizesFollowupParentScope(
  decision: CurrentQuestionSettlementDecision | undefined
) {
  return Boolean(
    decision?.relation === "followup-parent" &&
      decision.relationMutationAuthorized &&
      decision.activeParentId
  );
}

export function settlementAuthorizesTaskTransition(
  decision: CurrentQuestionSettlementDecision | undefined
) {
  if (!decision) return false;
  if (decision.relation === "new-parent") {
    return decision.parentMutationAuthorized;
  }
  return Boolean(
    (decision.relation === "followup-parent" ||
      decision.relation === "child-probe" ||
      decision.relation === "resume-parent") &&
      decision.relationMutationAuthorized &&
      decision.activeParentId
  );
}


export function formatProvisionalCurrentQuestionForTrace(
  question: ProvisionalCurrentQuestion | undefined
): Record<string, unknown> {
  if (!question) return {};
  return {
    currentQuestionUnitId: question.logicalQuestionUnitId,
    currentQuestionRevision: question.revision,
    currentQuestionSessionId: question.sessionId,
    currentQuestionRuntimeEpoch: question.runtimeEpoch,
    currentQuestionSourceTurnIds: question.sourceTurnIds,
    currentQuestionSourceObservationIds: question.sourceObservationIds,
    currentQuestionSourceKind: question.sourceKind,
    currentQuestionSourceHash: question.sourceHash,
    currentQuestionChars: question.normalizedText.length,
    currentQuestionPreview: previewCurrentQuestion(question.normalizedText),
    currentQuestionState: "provisional",
  };
}

export function formatCurrentQuestionMutationAuthorityForTrace(
  decision: CurrentQuestionMutationAuthorityDecision | undefined
): Record<string, unknown> {
  if (!decision) return {};
  return {
    currentQuestionAuthority: decision.authority,
    currentQuestionAuthoritySource: decision.authoritySource,
    currentQuestionProposedType: decision.questionType,
    currentQuestionProposedRelation: decision.relation,
    currentQuestionTypeMutationAuthorized:
      decision.typeMutationAuthorized,
    currentQuestionRelationMutationAuthorized:
      decision.relationMutationAuthorized,
    currentQuestionParentMutationAuthorized:
      decision.parentMutationAuthorized,
    currentQuestionResponseAuthorized: decision.responseAuthorized,
    currentQuestionAuthorityReasons: decision.reasons,
  };
}

export function formatCurrentQuestionSettlementForTrace(
  decision: CurrentQuestionSettlementDecision | undefined
): Record<string, unknown> {
  if (!decision) return {};
  return {
    currentQuestionSettlementId: decision.settlementId,
    currentQuestionSettlementOperationId: decision.operationId,
    currentQuestionSettlementUnitId: decision.logicalQuestionUnitId,
    currentQuestionSettlementRevision: decision.revision,
    currentQuestionSettlementSessionId: decision.sessionId,
    currentQuestionSettlementRuntimeEpoch: decision.runtimeEpoch,
    currentQuestionSettlementSourceKind: decision.sourceKind,
    currentQuestionSettlementSourceTurnIds: decision.sourceTurnIds,
    currentQuestionSettlementSourceObservationIds:
      decision.sourceObservationIds,
    currentQuestionSettlementSourceHash: decision.sourceHash,
    currentQuestionSettlementType: decision.questionType,
    currentQuestionSettlementRelation: decision.relation,
    currentQuestionSettlementPreserveActiveChild: decision.preserveActiveChild,
    currentQuestionSettlementAction: decision.action,
    currentQuestionSettlementEvidenceMode: decision.evidenceMode,
    currentQuestionSettlementAuthority: decision.authority,
    currentQuestionSettlementAuthoritySource: decision.authoritySource,
    currentQuestionSettlementTypeAuthoritySource:
      decision.typeAuthoritySource,
    currentQuestionSettlementRelationAuthoritySource:
      decision.relationAuthoritySource,
    currentQuestionSettlementOrderedRelationProvenance: decision.orderedRelationProvenance ?? null,
    currentQuestionSettlementActionAuthoritySource:
      decision.actionAuthoritySource,
    currentQuestionSettlementTypeMutationAuthorized:
      decision.typeMutationAuthorized,
    currentQuestionSettlementRelationMutationAuthorized:
      decision.relationMutationAuthorized,
    currentQuestionSettlementParentMutationAuthorized:
      decision.parentMutationAuthorized,
    currentQuestionSettlementFollowupParentScopeAuthorized:
      settlementAuthorizesFollowupParentScope(decision),
    currentQuestionSettlementResponseAuthorized:
      decision.responseAuthorized,
    currentQuestionSettlementConfidence: decision.confidence,
    currentQuestionSettlementActiveParentId: decision.activeParentId,
    currentQuestionSettlementActiveParentRevision:
      decision.activeParentRevision,
    currentQuestionSettlementManualCorrectionRevision:
      decision.manualCorrectionRevision,
    currentQuestionSettlementRejectedProposals:
      decision.rejectedProposals,
    currentQuestionSettlementReasons: decision.reasons,
  };
}



function resolveCurrentQuestionAuthority(
  source: CurrentQuestionAuthoritySource
): CurrentQuestionAuthority {
  if (source === "manual-correction") return "explicit-manual";
  if (source === "opening-route" || source === "accepted-transcript") {
    return "deterministic-fast-path";
  }
  if (
    source === "semantic-unknown-rescue" ||
    source === "accepted-llm-type-first-parent" ||
    source === "runtime-adjudication"
  ) {
    return "runtime-adjudication";
  }
  return "provisional-only";
}

function validateSettlementProposal(input: {
  proposal: CurrentQuestionSettlementProposal | undefined;
  expectedSource: CurrentQuestionSettlementProposalSource;
  currentQuestion: ProvisionalCurrentQuestion;
  activeParentId?: string;
  activeParentRevision?: number;
  manualCorrectionRevision: number;
  policy: CurrentQuestionSettlementPolicy;
}): {
  proposal?: CurrentQuestionSettlementProposal;
  rejection?: CurrentQuestionSettlementProposalRejection;
} {
  const proposal = input.proposal;
  if (!proposal) return {};

  const reasons: CurrentQuestionSettlementProposalRejectionReason[] = [];
  if (proposal.source !== input.expectedSource) {
    return {
      rejection: {
        source: input.expectedSource,
        reasons: ["logical-question-unit-mismatch"],
      },
    };
  }
  if (proposal.sessionId !== input.currentQuestion.sessionId) {
    reasons.push("session-mismatch");
  }
  if (proposal.runtimeEpoch !== input.currentQuestion.runtimeEpoch) {
    reasons.push("runtime-epoch-mismatch");
  }
  if (
    proposal.logicalQuestionUnitId !==
    input.currentQuestion.logicalQuestionUnitId
  ) {
    reasons.push("logical-question-unit-mismatch");
  }
  if (proposal.revision !== input.currentQuestion.revision) {
    reasons.push("logical-question-revision-mismatch");
  }
  if (
    proposal.sourceHash &&
    proposal.sourceHash !== input.currentQuestion.sourceHash
  ) {
    reasons.push("source-hash-mismatch");
  }
  if (
    proposal.source === "manual-correction" &&
    proposal.manualCorrectionRevision !==
      input.manualCorrectionRevision
  ) {
    reasons.push("manual-correction-revision-mismatch");
  }
  if (
    proposal.expectedParentId !== undefined &&
    proposal.expectedParentId !== input.activeParentId
  ) {
    reasons.push("expected-parent-mismatch");
  }
  if (
    proposal.expectedParentRevision !== undefined &&
    proposal.expectedParentRevision !== input.activeParentRevision
  ) {
    reasons.push("expected-parent-revision-mismatch");
  }

  return reasons.length
    ? {
        rejection: {
          source: proposal.source,
          reasons: uniqueRejectionReasons(reasons),
        },
      }
    : { proposal };
}

function selectQuestionType(input: {
  manual?: CurrentQuestionSettlementProposal;
  deterministic?: CurrentQuestionSettlementProposal;
  llm?: CurrentQuestionSettlementProposal;
  policy: CurrentQuestionSettlementPolicy;
  rejectedProposals: CurrentQuestionSettlementProposalRejection[];
}) {
  for (const proposal of [input.manual, input.deterministic]) {
    if (!proposal) continue;
    if (proposal.typeEvidenceAuthorized === false) continue;
    const questionType =
      normalizeCanonicalQuestionType(proposal.questionType) ?? "unknown";
    if (questionType === "unknown") {
      addProposalRejection(
        input.rejectedProposals,
        proposal.source,
        "question-type-unresolved"
      );
      continue;
    }
    return selection(
      questionType,
      proposal.source,
      true,
      proposal
    );
  }

  const llm = input.llm;
  if (llm) {
    const questionType =
      normalizeCanonicalQuestionType(llm.questionType) ?? "unknown";
    const minConfidence = clampConfidence(
      input.policy.runtimeTypeAdjudicationMinConfidence ?? 0.85
    );
    if (!input.policy.allowRuntimeTypeAdjudication) {
      addProposalRejection(
        input.rejectedProposals,
        llm.source,
        "runtime-adjudication-disabled"
      );
    } else if (questionType === "unknown") {
      addProposalRejection(
        input.rejectedProposals,
        llm.source,
        "question-type-unresolved"
      );
    } else if (llm.typeEvidenceAuthorized === false) {
      addProposalRejection(
        input.rejectedProposals,
        llm.source,
        "type-evidence-not-authorized"
      );
    } else if (clampConfidence(llm.confidence) < minConfidence) {
      addProposalRejection(
        input.rejectedProposals,
        llm.source,
        "runtime-adjudication-low-confidence"
      );
    } else {
      return selection(
        questionType,
        llm.source,
        true,
        llm
      );
    }
  }

  return selection<CanonicalQuestionType>(
    "unknown",
    "provisional",
    false
  );
}

function selectQuestionRelation(input: {
  manual?: CurrentQuestionSettlementProposal;
  deterministic?: CurrentQuestionSettlementProposal;
  llm?: CurrentQuestionSettlementProposal;
  policy: CurrentQuestionSettlementPolicy;
  rejectedProposals: CurrentQuestionSettlementProposalRejection[];
}) {
  for (const proposal of [input.manual, input.deterministic]) {
    if (!proposal?.relation || proposal.relation === "unknown" ||
        (proposal.relation === "none" && proposal.relationEvidenceAuthorized !== true)) {
      continue;
    }
    if (proposal.relationEvidenceAuthorized === false) {
      addProposalRejection(
        input.rejectedProposals,
        proposal.source,
        "relation-evidence-not-authorized"
      );
      continue;
    }
    return selection(
      proposal.relation,
      proposal.source,
      true,
      proposal
    );
  }

  const llm = input.llm;
  if (llm?.relation && llm.relation !== "unknown" &&
      (llm.relation !== "none" || llm.relationEvidenceAuthorized === true)) {
    const minConfidence = clampConfidence(
      input.policy.llmRelationRepairMinConfidence ??
        input.policy.runtimeTypeAdjudicationMinConfidence ??
        0.85
    );
    if (!input.policy.allowLlmRelationRepair) {
      addProposalRejection(
        input.rejectedProposals,
        llm.source,
        "llm-relation-shadow-only"
      );
    } else if (llm.relationEvidenceAuthorized === false) {
      addProposalRejection(
        input.rejectedProposals,
        llm.source,
        "relation-evidence-not-authorized"
      );
    } else if (clampConfidence(llm.confidence) < minConfidence) {
      addProposalRejection(
        input.rejectedProposals,
        llm.source,
        "llm-relation-repair-low-confidence"
      );
    } else {
      return selection(llm.relation, llm.source, true, llm);
    }
  }
  return selection<CurrentQuestionRelation>(
    "unknown",
    "provisional",
    false
  );
}

function selectQuestionAction(input: {
  manual?: CurrentQuestionSettlementProposal;
  deterministic?: CurrentQuestionSettlementProposal;
  llm?: CurrentQuestionSettlementProposal;
  policy: CurrentQuestionSettlementPolicy;
  rejectedProposals: CurrentQuestionSettlementProposalRejection[];
}) {
  for (const proposal of [input.manual, input.deterministic]) {
    if (!proposal?.action) continue;
    if (proposal.actionEvidenceAuthorized === false) continue;
    return selection(
      proposal.action,
      proposal.source,
      true,
      proposal
    );
  }
  if (input.llm?.action) {
    if (
      input.policy.allowLlmActionRepair &&
      input.llm.actionEvidenceAuthorized !== false
    ) {
      return selection(
        input.llm.action,
        input.llm.source,
        true,
        input.llm
      );
    }
    addProposalRejection(
      input.rejectedProposals,
      input.llm.source,
      "llm-action-repair-disabled"
    );
  }
  return selection<InterviewerIntentAction>(
    "answer",
    "provisional",
    false
  );
}

function selectEvidenceMode(input: {
  manual?: CurrentQuestionSettlementProposal;
  deterministic?: CurrentQuestionSettlementProposal;
  llm?: CurrentQuestionSettlementProposal;
  questionType: CanonicalQuestionType;
}): InterviewerEvidenceMode {
  for (const proposal of [
    input.manual,
    input.deterministic,
    input.llm,
  ]) {
    if (proposal?.evidenceMode) return proposal.evidenceMode;
  }
  switch (input.questionType) {
    case "behavioral":
    case "project-deep-dive":
      return "personal-experience";
    case "coding":
    case "general-system-design":
    case "ai-ml-system-design":
      return "hypothetical-design";
    case "field-knowledge":
      return "factual-explanation";
    case "unknown":
      return "unknown";
  }
}

function selection<T>(
  value: T,
  source:
    | CurrentQuestionSettlementProposalSource
    | "provisional",
  authorized: boolean,
  proposal?: CurrentQuestionSettlementProposal
) {
  return {
    value,
    source,
    authorized,
    proposal,
    confidence: clampConfidence(proposal?.confidence),
  };
}

function proposalSourceToAuthoritySource(
  typeSource:
    | CurrentQuestionSettlementProposalSource
    | "provisional",
  relationSource:
    | CurrentQuestionSettlementProposalSource
    | "provisional",
  actionSource:
    | CurrentQuestionSettlementProposalSource
    | "provisional"
): CurrentQuestionAuthoritySource {
  const sources = [typeSource, relationSource, actionSource];
  if (sources.includes("manual-correction")) {
    return "manual-correction";
  }
  if (typeSource === "runtime-adjudication") {
    return "runtime-adjudication";
  }
  if (sources.includes("deterministic-fast-path")) {
    return "accepted-transcript";
  }
  return "provisional-only";
}

function addProposalRejection(
  rejections: CurrentQuestionSettlementProposalRejection[],
  source: CurrentQuestionSettlementProposalSource,
  reason: CurrentQuestionSettlementProposalRejectionReason
) {
  const existing = rejections.find(
    (rejection) => rejection.source === source
  );
  if (existing) {
    existing.reasons = uniqueRejectionReasons([
      ...existing.reasons,
      reason,
    ]);
    return;
  }
  rejections.push({ source, reasons: [reason] });
}

function createSettlementId(input: {
  currentQuestion: ProvisionalCurrentQuestion;
  questionType: CanonicalQuestionType;
  relation: CurrentQuestionRelation;
  preserveActiveChild?: boolean;
  action: InterviewerIntentAction;
  authority: CurrentQuestionAuthority;
  typeAuthoritySource:
    | CurrentQuestionSettlementProposalSource
    | "provisional";
  relationAuthoritySource:
    | CurrentQuestionSettlementProposalSource
    | "provisional";
  actionAuthoritySource:
    | CurrentQuestionSettlementProposalSource
    | "provisional";
  activeParentId?: string;
  activeParentRevision?: number;
  manualCorrectionRevision: number;
}) {
  return `question_settlement_${hashStableText(
    [
      input.currentQuestion.sessionId,
      input.currentQuestion.runtimeEpoch,
      input.currentQuestion.logicalQuestionUnitId,
      input.currentQuestion.revision,
      input.currentQuestion.sourceHash,
      input.questionType,
      input.relation,
      input.action,
      input.authority,
      input.typeAuthoritySource,
      input.relationAuthoritySource,
      input.actionAuthoritySource,
      input.activeParentId ?? "",
      input.activeParentRevision ?? "",
      input.manualCorrectionRevision,
      ...(input.preserveActiveChild === undefined ? [] : [input.preserveActiveChild]),
    ].join("|")
  )}`;
}

function hashCurrentQuestionSource(input: {
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  revision: number;
  normalizedText: string;
  sourceTurnIds: string[];
  sourceObservationIds: string[];
}) {
  const raw = [
    input.sessionId,
    input.runtimeEpoch,
    input.logicalQuestionUnitId,
    input.revision,
    input.normalizedText.trim(),
    input.sourceTurnIds.join(","),
    input.sourceObservationIds.join(","),
  ].join("|");
  return `question_source_${hashStableText(raw)}`;
}

function uniqueStrings(values: string[]) {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean))
  );
}

function previewCurrentQuestion(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 240
    ? `${normalized.slice(0, 237)}...`
    : normalized;
}

function uniqueRejectionReasons(
  values: CurrentQuestionSettlementProposalRejectionReason[]
) {
  return Array.from(new Set(values));
}

function clampConfidence(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function hashStableText(raw: string) {
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
