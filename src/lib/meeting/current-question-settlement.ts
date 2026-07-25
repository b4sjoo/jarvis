import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import type {
  InterviewerEvidenceMode,
  InterviewerIntentAction,
  InterviewerIntentRelation,
  InterviewerSpeechAct,
} from "./interviewer-intent.js";
import {
  isParentCanonicalQuestionType,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import type { InterviewTaskRelation } from "./types.js";

export type CurrentQuestionSourceKind = "voice" | "screen" | "mixed";

export type CurrentQuestionAuthority =
  | "explicit-manual"
  | "deterministic-fast-path"
  | "llm-type-repair"
  | "provisional-only";

export type CurrentQuestionAuthoritySource =
  | "manual-correction"
  | "opening-route"
  | "accepted-transcript"
  | "semantic-unknown-rescue"
  | "llm-type-repair"
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
  | "llm-type-repair";

export type CurrentQuestionSettlementProposalRejectionReason =
  | "session-mismatch"
  | "runtime-epoch-mismatch"
  | "logical-question-unit-mismatch"
  | "logical-question-revision-mismatch"
  | "source-hash-mismatch"
  | "manual-correction-revision-mismatch"
  | "expected-parent-mismatch"
  | "expected-parent-revision-mismatch"
  | "llm-type-repair-disabled"
  | "llm-type-repair-low-confidence"
  | "question-type-unresolved"
  | "type-evidence-not-authorized"
  | "relation-evidence-not-authorized"
  | "llm-relation-shadow-only"
  | "llm-action-repair-disabled";

export interface CurrentQuestionSettlementProposal {
  source: CurrentQuestionSettlementProposalSource;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  revision: number;
  sourceHash?: string;
  questionType?: unknown;
  relation?: CurrentQuestionRelation;
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

export interface CurrentQuestionSettlementProposalRejection {
  source: CurrentQuestionSettlementProposalSource;
  reasons: CurrentQuestionSettlementProposalRejectionReason[];
}

export interface CurrentQuestionSettlementPolicy {
  allowLlmTypeRepair?: boolean;
  allowLlmActionRepair?: boolean;
  llmTypeRepairMinConfidence?: number;
  runtimeMutationAuthorized: boolean;
  questionComplete: boolean;
  commitParent: boolean;
}

export interface CurrentQuestionSettlementDecision {
  settlementId: string;
  logicalQuestionUnitId: string;
  revision: number;
  sessionId: string;
  runtimeEpoch: number;
  sourceHash: string;
  questionType: CanonicalQuestionType;
  relation: CurrentQuestionRelation;
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

export type CurrentQuestionTerminalNoAnswerDisposition =
  | "terminal-no-answer"
  | "operation-not-authorized"
  | "proposal-stale-or-invalid"
  | "substantive-source-protected"
  | "semantic-contract-mismatch"
  | "confidence-below-threshold";

export interface CurrentQuestionTerminalNoAnswerDecision {
  logicalQuestionUnitId: string;
  revision: number;
  sessionId: string;
  runtimeEpoch: number;
  sourceHash: string;
  sourceTurnIds: string[];
  operationId?: string;
  disposition: CurrentQuestionTerminalNoAnswerDisposition;
  terminalNoAnswerAuthorized: boolean;
  speechAct?: InterviewerSpeechAct;
  action?: InterviewerIntentAction;
  confidence: number;
  settledAt: number;
  reasons: string[];
}

export interface CurrentQuestionTerminalNoAnswerCandidate {
  proposal: CurrentQuestionSettlementProposal;
  speechAct: InterviewerSpeechAct;
  normalizedQuestion: string;
  primaryAskSpanCount: number;
  budgetSlot: "ambient" | "substantive";
  sourceOwnedSubstantive: boolean;
  operationId?: string;
}

export type CurrentQuestionSettlementDisposition =
  | "domain-resolved-provisional"
  | "domain-resolved-unknown"
  | "unresolved-provisional"
  | "response-only"
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
  if (input.settlement.responseAuthorized) return "response-only";
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
  const sourceTurnIds = uniqueStrings(logicalQuestionUnit.sourceTurnIds);
  const sourceObservationIds = uniqueStrings(
    input.sourceObservationIds ?? []
  );
  const sourceHash = hashCurrentQuestionSource({
    sessionId: logicalQuestionUnit.sessionId,
    runtimeEpoch: logicalQuestionUnit.runtimeEpoch,
    logicalQuestionUnitId: logicalQuestionUnit.id,
    revision: logicalQuestionUnit.revision,
    normalizedText: logicalQuestionUnit.normalizedText,
    sourceTurnIds,
    sourceObservationIds,
  });

  return {
    logicalQuestionUnitId: logicalQuestionUnit.id,
    revision: logicalQuestionUnit.revision,
    sessionId: logicalQuestionUnit.sessionId,
    runtimeEpoch: logicalQuestionUnit.runtimeEpoch,
    normalizedText: logicalQuestionUnit.normalizedText,
    sourceTurnIds,
    sourceObservationIds,
    sourceKind: input.sourceKind,
    sourceHash,
    createdAt: logicalQuestionUnit.startedAt,
    updatedAt: input.now ?? logicalQuestionUnit.updatedAt,
    expiresAt: input.expiresAt,
  };
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
  if (!reasons.length) reasons.push("response-only");

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
  deterministicProposal?: CurrentQuestionSettlementProposal;
  llmProposal?: CurrentQuestionSettlementProposal;
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
    expectedSource: "llm-type-repair",
    currentQuestion: input.currentQuestion,
    activeParentId: input.activeParentId,
    activeParentRevision: input.activeParentRevision,
    manualCorrectionRevision: input.manualCorrectionRevision,
    policy: input.policy,
  });

  for (const validation of [validManual, validDeterministic, validLlm]) {
    if (validation.rejection) {
      rejectedProposals.push(validation.rejection);
    }
  }

  const typeSelection = selectQuestionType({
    manual: validManual.proposal,
    deterministic: validDeterministic.proposal,
    llm: validLlm.proposal,
    policy: input.policy,
    rejectedProposals,
  });
  const relationSelection = selectQuestionRelation({
    manual: validManual.proposal,
    deterministic: validDeterministic.proposal,
    llm: validLlm.proposal,
    rejectedProposals,
  });
  const actionSelection = selectQuestionAction({
    manual: validManual.proposal,
    deterministic: validDeterministic.proposal,
    llm: validLlm.proposal,
    policy: input.policy,
    rejectedProposals,
  });
  const evidenceModeSelection = selectEvidenceMode({
    manual: validManual.proposal,
    deterministic: validDeterministic.proposal,
    llm: validLlm.proposal,
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
    typeAuthoritySource: typeSelection.source,
    relationAuthoritySource: relationSelection.source,
    actionAuthoritySource: actionSelection.source,
    activeParentId: input.activeParentId,
    activeParentRevision: input.activeParentRevision,
    manualCorrectionRevision: input.manualCorrectionRevision,
  });

  return {
    settlementId,
    logicalQuestionUnitId:
      input.currentQuestion.logicalQuestionUnitId,
    revision: input.currentQuestion.revision,
    sessionId: input.currentQuestion.sessionId,
    runtimeEpoch: input.currentQuestion.runtimeEpoch,
    sourceHash: input.currentQuestion.sourceHash,
    questionType: typeSelection.value,
    relation: relationSelection.value,
    action: actionSelection.value,
    evidenceMode: evidenceModeSelection,
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

export function settleCurrentQuestionTerminalNoAnswer(input: {
  currentQuestion: ProvisionalCurrentQuestion;
  candidate?: CurrentQuestionTerminalNoAnswerCandidate;
  operationAuthorized: boolean;
  operationAuthorizationReason?: string;
  activeParentId?: string;
  activeParentRevision?: number;
  manualCorrectionRevision: number;
  minConfidence?: number;
  now?: number;
}): CurrentQuestionTerminalNoAnswerDecision {
  const confidence = clampConfidence(
    input.candidate?.proposal.confidence
  );
  const base = {
    logicalQuestionUnitId:
      input.currentQuestion.logicalQuestionUnitId,
    revision: input.currentQuestion.revision,
    sessionId: input.currentQuestion.sessionId,
    runtimeEpoch: input.currentQuestion.runtimeEpoch,
    sourceHash: input.currentQuestion.sourceHash,
    sourceTurnIds: [...input.currentQuestion.sourceTurnIds],
    operationId: input.candidate?.operationId,
    speechAct: input.candidate?.speechAct,
    action: input.candidate?.proposal.action,
    confidence,
    settledAt: input.now ?? Date.now(),
  };
  const reject = (
    disposition: Exclude<
      CurrentQuestionTerminalNoAnswerDisposition,
      "terminal-no-answer"
    >,
    reasons: string[]
  ): CurrentQuestionTerminalNoAnswerDecision => ({
    ...base,
    disposition,
    terminalNoAnswerAuthorized: false,
    reasons,
  });

  if (!input.operationAuthorized) {
    return reject("operation-not-authorized", [
      input.operationAuthorizationReason ??
        "operation-lease-not-authorized",
    ]);
  }
  if (!input.candidate) {
    return reject("semantic-contract-mismatch", [
      "terminal-no-answer-candidate-missing",
    ]);
  }

  const validation = validateSettlementProposal({
    proposal: input.candidate.proposal,
    expectedSource: "llm-type-repair",
    currentQuestion: input.currentQuestion,
    activeParentId: input.activeParentId,
    activeParentRevision: input.activeParentRevision,
    manualCorrectionRevision: input.manualCorrectionRevision,
    policy: {
      runtimeMutationAuthorized: false,
      questionComplete: false,
      commitParent: false,
    },
  });
  if (!validation.proposal) {
    return reject("proposal-stale-or-invalid", [
      ...(validation.rejection?.reasons ?? [
        "terminal-no-answer-proposal-invalid",
      ]),
    ]);
  }
  if (
    input.candidate.budgetSlot !== "ambient" ||
    input.candidate.sourceOwnedSubstantive
  ) {
    return reject("substantive-source-protected", [
      `budget-slot:${input.candidate.budgetSlot}`,
      input.candidate.sourceOwnedSubstantive
        ? "source-owned-substantive"
        : "source-owned-substantive:false",
    ]);
  }

  const proposal = validation.proposal;
  const semanticContractMatches =
    proposal.action === "ignore" &&
    proposal.actionEvidenceAuthorized === true &&
    (input.candidate.speechAct === "acknowledgement" ||
      input.candidate.speechAct === "logistics") &&
    (normalizeCanonicalQuestionType(proposal.questionType) ??
      "unknown") === "unknown" &&
    (proposal.relation ?? "none") === "none" &&
    (proposal.evidenceMode ?? "unknown") === "unknown" &&
    input.candidate.normalizedQuestion.trim().length === 0 &&
    input.candidate.primaryAskSpanCount === 0;
  if (!semanticContractMatches) {
    return reject("semantic-contract-mismatch", [
      `speech-act:${input.candidate.speechAct}`,
      `question-type:${
        normalizeCanonicalQuestionType(proposal.questionType) ??
        "unknown"
      }`,
      `relation:${proposal.relation ?? "none"}`,
      `evidence-mode:${proposal.evidenceMode ?? "unknown"}`,
      `action:${proposal.action ?? "missing"}`,
      `normalized-question-chars:${input.candidate.normalizedQuestion.trim().length}`,
      `primary-ask-spans:${input.candidate.primaryAskSpanCount}`,
    ]);
  }

  const minConfidence = clampConfidence(
    input.minConfidence ?? 0.98
  );
  if (confidence < minConfidence) {
    return reject("confidence-below-threshold", [
      `confidence:${confidence}`,
      `minimum:${minConfidence}`,
    ]);
  }

  return {
    ...base,
    disposition: "terminal-no-answer",
    terminalNoAnswerAuthorized: true,
    reasons: [
      "operation-lease-authorized",
      "ambient-budget-slot",
      "source-owned-substantive:false",
      `speech-act:${input.candidate.speechAct}`,
      "action:ignore",
      `confidence:${confidence}`,
    ],
  };
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
    currentQuestionSettlementUnitId: decision.logicalQuestionUnitId,
    currentQuestionSettlementRevision: decision.revision,
    currentQuestionSettlementSessionId: decision.sessionId,
    currentQuestionSettlementRuntimeEpoch: decision.runtimeEpoch,
    currentQuestionSettlementSourceHash: decision.sourceHash,
    currentQuestionSettlementType: decision.questionType,
    currentQuestionSettlementRelation: decision.relation,
    currentQuestionSettlementAction: decision.action,
    currentQuestionSettlementEvidenceMode: decision.evidenceMode,
    currentQuestionSettlementAuthority: decision.authority,
    currentQuestionSettlementAuthoritySource: decision.authoritySource,
    currentQuestionSettlementTypeAuthoritySource:
      decision.typeAuthoritySource,
    currentQuestionSettlementRelationAuthoritySource:
      decision.relationAuthoritySource,
    currentQuestionSettlementActionAuthoritySource:
      decision.actionAuthoritySource,
    currentQuestionSettlementTypeMutationAuthorized:
      decision.typeMutationAuthorized,
    currentQuestionSettlementRelationMutationAuthorized:
      decision.relationMutationAuthorized,
    currentQuestionSettlementParentMutationAuthorized:
      decision.parentMutationAuthorized,
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

export function formatCurrentQuestionTerminalNoAnswerForTrace(
  decision: CurrentQuestionTerminalNoAnswerDecision | undefined
): Record<string, unknown> {
  if (!decision) return {};
  return {
    currentQuestionTerminalNoAnswerDisposition:
      decision.disposition,
    currentQuestionTerminalNoAnswerAuthorized:
      decision.terminalNoAnswerAuthorized,
    currentQuestionTerminalNoAnswerUnitId:
      decision.logicalQuestionUnitId,
    currentQuestionTerminalNoAnswerRevision: decision.revision,
    currentQuestionTerminalNoAnswerSessionId: decision.sessionId,
    currentQuestionTerminalNoAnswerRuntimeEpoch:
      decision.runtimeEpoch,
    currentQuestionTerminalNoAnswerSourceHash:
      decision.sourceHash,
    currentQuestionTerminalNoAnswerSourceTurnIds:
      decision.sourceTurnIds,
    currentQuestionTerminalNoAnswerOperationId:
      decision.operationId,
    currentQuestionTerminalNoAnswerSpeechAct:
      decision.speechAct,
    currentQuestionTerminalNoAnswerAction: decision.action,
    currentQuestionTerminalNoAnswerConfidence:
      decision.confidence,
    currentQuestionTerminalNoAnswerSettledAt:
      decision.settledAt,
    currentQuestionTerminalNoAnswerReasons: decision.reasons,
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
    source === "llm-type-repair"
  ) {
    return "llm-type-repair";
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
    const questionType =
      normalizeCanonicalQuestionType(proposal?.questionType) ?? "unknown";
    if (!proposal) continue;
    if (questionType === "unknown") {
      addProposalRejection(
        input.rejectedProposals,
        proposal.source,
        "question-type-unresolved"
      );
      continue;
    }
    if (proposal.typeEvidenceAuthorized === false) {
      addProposalRejection(
        input.rejectedProposals,
        proposal.source,
        "type-evidence-not-authorized"
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
      input.policy.llmTypeRepairMinConfidence ?? 0.85
    );
    if (!input.policy.allowLlmTypeRepair) {
      addProposalRejection(
        input.rejectedProposals,
        llm.source,
        "llm-type-repair-disabled"
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
        "llm-type-repair-low-confidence"
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
  rejectedProposals: CurrentQuestionSettlementProposalRejection[];
}) {
  for (const proposal of [input.manual, input.deterministic]) {
    if (!proposal?.relation || isUnresolvedRelation(proposal.relation)) {
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

  if (input.llm?.relation && !isUnresolvedRelation(input.llm.relation)) {
    addProposalRejection(
      input.rejectedProposals,
      input.llm.source,
      "llm-relation-shadow-only"
    );
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
  if (typeSource === "llm-type-repair") {
    return "llm-type-repair";
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

function isUnresolvedRelation(relation: CurrentQuestionRelation) {
  return relation === "unknown" || relation === "none";
}

function createSettlementId(input: {
  currentQuestion: ProvisionalCurrentQuestion;
  questionType: CanonicalQuestionType;
  relation: CurrentQuestionRelation;
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
