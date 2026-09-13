import {
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";

export const AWAITING_VISUAL_EVIDENCE_TTL_MS = 5 * 60 * 1_000;

export type VisualRecoveryOwnerKind = "parent" | "child" | "current-question";

interface VisualEvidenceResolutionInput {
  state: "resolved" | "awaiting-evidence" | "failed";
  awaitingVisualEvidence: boolean;
  evidence: string[];
}

export interface AwaitingVisualEvidenceRecoveryFact {
  id: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionRevision: number;
  answerRevision: number;
  visibleAnswerRevision: number;
  parentTaskId?: string;
  parentRevision?: number;
  ownerKind: VisualRecoveryOwnerKind;
  ownerBranchId: string;
  questionType: CanonicalQuestionType;
  questionText: string;
  sourceHash: string;
  sourceSettlementId?: string;
  sourceTurnIds: string[];
  manualCorrectionRevision: number;
  createdAt: number;
  expiresAt: number;
  evidence: string[];
}

export interface VisualRecoveryActiveTopology {
  parentId?: string;
  parentQuestionType?: unknown;
  childId?: string;
  childQuestionType?: unknown;
  currentLogicalQuestionUnitId?: string;
}

export interface VisualRecoveryOpportunitySelection {
  fact?: AwaitingVisualEvidenceRecoveryFact;
  reason:
    | "active-child-owner"
    | "screen-type-parent-owner"
    | "active-parent-owner"
    | "current-question-owner"
    | "no-current-opportunity";
  expiredFactIds: string[];
}

export type BoundVisualRecoveryRelationDecision =
  | {
      authorized: true;
      relation: "followup-parent" | "child-probe" | "resume-parent";
      reason:
        | "bound-parent-preserved"
        | "bound-child-preserved"
        | "bound-parent-resumed";
      ownerBranchId: string;
    }
  | {
      authorized: false;
      reason:
        | "owner-parent-missing"
        | "owner-child-missing"
        | "owner-current-question-has-no-durable-relation";
      ownerBranchId: string;
    };

export interface BoundVisualRecoveryApplicationDecision {
  applied: boolean;
  exactVisualEvidenceRecovery: boolean;
  relation?: "followup-parent" | "child-probe" | "resume-parent";
  branchRelation: BoundVisualRecoveryRelationDecision;
}

export interface AwaitingVisualEvidenceRecoveryAuthorization {
  authorized: boolean;
  reason:
    | "authorized"
    | "no-recovery-fact"
    | "expired"
    | "session-mismatch"
    | "runtime-epoch-mismatch"
    | "logical-question-mismatch"
    | "logical-question-revision-mismatch"
    | "visible-answer-revision-mismatch"
    | "parent-mismatch"
    | "parent-revision-mismatch"
    | "manual-correction-revision-mismatch";
}

export type VisualRecoveryCommitAuthorization =
  | { authorized: true; reason: "authorized" }
  | {
      authorized: false;
      reason:
        | "source-not-voice"
        | "session-mismatch"
        | "runtime-epoch-mismatch"
        | "manual-correction-revision-mismatch"
        | "logical-question-mismatch"
        | "logical-question-revision-mismatch"
        | "visible-answer-revision-mismatch"
        | "parent-mismatch"
        | "parent-revision-mismatch";
    };

export function authorizeVisualRecoveryCommit(input: {
  sourceKind: "voice" | "screen";
  sessionId: string;
  currentSessionId: string;
  runtimeEpoch: number;
  currentRuntimeEpoch: number;
  manualCorrectionRevision: number;
  currentManualCorrectionRevision: number;
  logicalQuestionUnitId: string;
  currentLogicalQuestionUnitId?: string;
  logicalQuestionRevision: number;
  currentLogicalQuestionRevision?: number;
  visibleAnswerRevision: number;
  currentVisibleAnswerRevision?: number;
  parentTaskId?: string;
  currentParentTaskId?: string;
  parentRevision?: number;
  currentParentRevision?: number;
}): VisualRecoveryCommitAuthorization {
  const reject = (
    reason: Exclude<VisualRecoveryCommitAuthorization, { authorized: true }>["reason"]
  ): VisualRecoveryCommitAuthorization => ({ authorized: false, reason });
  if (input.sourceKind !== "voice") return reject("source-not-voice");
  if (input.sessionId !== input.currentSessionId) {
    return reject("session-mismatch");
  }
  if (input.runtimeEpoch !== input.currentRuntimeEpoch) {
    return reject("runtime-epoch-mismatch");
  }
  if (
    input.manualCorrectionRevision !== input.currentManualCorrectionRevision
  ) {
    return reject("manual-correction-revision-mismatch");
  }
  if (input.logicalQuestionUnitId !== input.currentLogicalQuestionUnitId) {
    return reject("logical-question-mismatch");
  }
  if (
    input.logicalQuestionRevision !== input.currentLogicalQuestionRevision
  ) {
    return reject("logical-question-revision-mismatch");
  }
  if (input.visibleAnswerRevision !== input.currentVisibleAnswerRevision) {
    return reject("visible-answer-revision-mismatch");
  }
  if (input.parentTaskId !== input.currentParentTaskId) {
    return reject("parent-mismatch");
  }
  if (input.parentRevision !== input.currentParentRevision) {
    return reject("parent-revision-mismatch");
  }
  return { authorized: true, reason: "authorized" };
}

export type VisualRecoveryPostCommitRebaseDecision =
  | {
      disposition: "unchanged" | "rebased";
      reason: "same-parent-revision" | "owned-parent-revision-advanced";
      parentRevision: number;
    }
  | {
      disposition: "rejected";
      reason:
        | "source-not-voice"
        | "logical-question-mismatch"
        | "stable-task-mismatch"
        | "active-parent-mismatch"
        | "parent-revision-regressed";
    };

export function decideVisualRecoveryPostCommitRebase(input: {
  sourceKind: "voice" | "screen";
  logicalQuestionUnitId: string;
  logicalQuestionRevision: number;
  parentTaskId?: string;
  parentRevision?: number;
  stableLogicalQuestionUnitId?: string | null;
  stableLogicalQuestionRevision?: number | null;
  stableTaskId?: string | null;
  activeParentId?: string;
  activeParentRevision?: number;
}): VisualRecoveryPostCommitRebaseDecision {
  if (input.sourceKind !== "voice") {
    return { disposition: "rejected", reason: "source-not-voice" };
  }
  if (
    input.stableLogicalQuestionUnitId !== input.logicalQuestionUnitId ||
    input.stableLogicalQuestionRevision !== input.logicalQuestionRevision
  ) {
    return { disposition: "rejected", reason: "logical-question-mismatch" };
  }
  if (!input.parentTaskId || input.stableTaskId !== input.parentTaskId) {
    return { disposition: "rejected", reason: "stable-task-mismatch" };
  }
  if (input.activeParentId !== input.parentTaskId) {
    return { disposition: "rejected", reason: "active-parent-mismatch" };
  }
  if (
    input.parentRevision === undefined ||
    input.activeParentRevision === undefined ||
    input.activeParentRevision < input.parentRevision
  ) {
    return { disposition: "rejected", reason: "parent-revision-regressed" };
  }
  if (input.activeParentRevision === input.parentRevision) {
    return {
      disposition: "unchanged",
      reason: "same-parent-revision",
      parentRevision: input.parentRevision,
    };
  }
  return {
    disposition: "rebased",
    reason: "owned-parent-revision-advanced",
    parentRevision: input.activeParentRevision,
  };
}

export function createAwaitingVisualEvidenceRecoveryFact(input: {
  resolution: VisualEvidenceResolutionInput;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionRevision: number;
  answerRevision: number;
  visibleAnswerRevision: number;
  parentTaskId?: string | null;
  parentRevision?: number | null;
  ownerKind?: VisualRecoveryOwnerKind;
  ownerBranchId?: string | null;
  questionType?: unknown;
  questionText?: string;
  sourceHash?: string | null;
  sourceSettlementId?: string | null;
  sourceTurnIds?: string[];
  manualCorrectionRevision: number;
  createdAt?: number;
  ttlMs?: number;
}): AwaitingVisualEvidenceRecoveryFact | undefined {
  const parentTaskId = input.parentTaskId?.trim();
  const sourceHash = input.sourceHash?.trim();
  const ownerKind =
    input.ownerKind ?? (parentTaskId ? "parent" : "current-question");
  const ownerBranchId =
    input.ownerBranchId?.trim() ||
    (ownerKind === "current-question"
      ? input.logicalQuestionUnitId.trim()
      : parentTaskId);
  if (
    input.resolution.state !== "awaiting-evidence" ||
    !input.resolution.awaitingVisualEvidence ||
    !input.logicalQuestionUnitId.trim() ||
    !sourceHash ||
    !ownerBranchId
  ) {
    return undefined;
  }

  const createdAt = input.createdAt ?? Date.now();
  const ttlMs = Math.max(1_000, input.ttlMs ?? AWAITING_VISUAL_EVIDENCE_TTL_MS);
  return {
    id: [
      "awaiting_visual_evidence",
      input.sessionId,
      input.runtimeEpoch,
      input.logicalQuestionUnitId,
      input.logicalQuestionRevision,
      input.answerRevision,
    ].join(":"),
    sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    logicalQuestionUnitId: input.logicalQuestionUnitId,
    logicalQuestionRevision: input.logicalQuestionRevision,
    answerRevision: input.answerRevision,
    visibleAnswerRevision: input.visibleAnswerRevision,
    parentTaskId: parentTaskId || undefined,
    parentRevision:
      input.parentRevision === null ? undefined : input.parentRevision,
    ownerKind,
    ownerBranchId,
    questionType:
      normalizeCanonicalQuestionType(input.questionType) ?? "unknown",
    questionText:
      input.questionText?.trim() || input.resolution.evidence.join(" ").trim(),
    sourceHash,
    sourceSettlementId: input.sourceSettlementId?.trim() || undefined,
    sourceTurnIds: uniqueStrings(input.sourceTurnIds ?? []),
    manualCorrectionRevision: input.manualCorrectionRevision,
    createdAt,
    expiresAt: createdAt + ttlMs,
    evidence: uniqueStrings(input.resolution.evidence),
  };
}

export function upsertVisualRecoveryOpportunity(
  facts: ReadonlyMap<string, AwaitingVisualEvidenceRecoveryFact>,
  fact: AwaitingVisualEvidenceRecoveryFact
) {
  const next = new Map(facts);
  next.set(fact.ownerBranchId, fact);
  return next;
}

export function selectVisualRecoveryOpportunity(input: {
  facts: Iterable<AwaitingVisualEvidenceRecoveryFact>;
  sessionId: string;
  runtimeEpoch: number;
  manualCorrectionRevision: number;
  topology: VisualRecoveryActiveTopology;
  screenQuestionType?: unknown;
  now?: number;
}): VisualRecoveryOpportunitySelection {
  const now = input.now ?? Date.now();
  const valid: AwaitingVisualEvidenceRecoveryFact[] = [];
  const expiredFactIds: string[] = [];
  for (const fact of input.facts) {
    const ownerStillExists =
      fact.ownerKind === "parent"
        ? fact.parentTaskId === input.topology.parentId &&
          fact.ownerBranchId === input.topology.parentId
        : fact.ownerKind === "child"
          ? fact.parentTaskId === input.topology.parentId &&
            fact.ownerBranchId === input.topology.childId
          : fact.ownerBranchId === input.topology.currentLogicalQuestionUnitId;
    if (
      fact.sessionId !== input.sessionId ||
      fact.runtimeEpoch > input.runtimeEpoch ||
      fact.manualCorrectionRevision !== input.manualCorrectionRevision ||
      now > fact.expiresAt ||
      !ownerStillExists
    ) {
      expiredFactIds.push(fact.id);
      continue;
    }
    valid.push(fact);
  }

  const parentFact = valid.find((fact) => fact.ownerKind === "parent");
  const childFact = valid.find((fact) => fact.ownerKind === "child");
  const currentQuestionFact = valid.find(
    (fact) => fact.ownerKind === "current-question"
  );
  const screenType = normalizeCanonicalQuestionType(input.screenQuestionType);
  const parentType = normalizeCanonicalQuestionType(
    input.topology.parentQuestionType
  );
  if (
    input.topology.childId &&
    parentFact &&
    screenType &&
    screenType !== "unknown" &&
    screenType === parentType
  ) {
    return {
      fact: parentFact,
      reason: "screen-type-parent-owner",
      expiredFactIds,
    };
  }
  if (input.topology.childId && childFact) {
    return { fact: childFact, reason: "active-child-owner", expiredFactIds };
  }
  if (parentFact) {
    return { fact: parentFact, reason: "active-parent-owner", expiredFactIds };
  }
  if (currentQuestionFact) {
    return {
      fact: currentQuestionFact,
      reason: "current-question-owner",
      expiredFactIds,
    };
  }
  return { reason: "no-current-opportunity", expiredFactIds };
}

export function resolveSourceLinkageFallback(input: {
  voiceQuestionType?: unknown;
  screenQuestionType?: unknown;
}): "bind-voice" | "use-screen" {
  const voiceType = normalizeCanonicalQuestionType(input.voiceQuestionType);
  const screenType = normalizeCanonicalQuestionType(input.screenQuestionType);
  if (
    !voiceType ||
    voiceType === "unknown" ||
    !screenType ||
    screenType === "unknown"
  ) {
    return "bind-voice";
  }
  return voiceType === screenType ? "bind-voice" : "use-screen";
}

export function resolveBoundVisualRecoveryRelation(input: {
  fact: AwaitingVisualEvidenceRecoveryFact;
  topology: VisualRecoveryActiveTopology;
}): BoundVisualRecoveryRelationDecision {
  const { fact, topology } = input;
  if (fact.ownerKind === "current-question") {
    return {
      authorized: false,
      reason: "owner-current-question-has-no-durable-relation",
      ownerBranchId: fact.ownerBranchId,
    };
  }
  if (fact.ownerKind === "child") {
    return fact.parentTaskId === topology.parentId &&
      fact.ownerBranchId === topology.childId
      ? {
          authorized: true,
          relation: "child-probe",
          reason: "bound-child-preserved",
          ownerBranchId: fact.ownerBranchId,
        }
      : {
          authorized: false,
          reason: "owner-child-missing",
          ownerBranchId: fact.ownerBranchId,
        };
  }
  if (fact.parentTaskId !== topology.parentId) {
    return {
      authorized: false,
      reason: "owner-parent-missing",
      ownerBranchId: fact.ownerBranchId,
    };
  }
  return topology.childId
    ? {
        authorized: true,
        relation: "resume-parent",
        reason: "bound-parent-resumed",
        ownerBranchId: fact.ownerBranchId,
      }
    : {
        authorized: true,
        relation: "followup-parent",
        reason: "bound-parent-preserved",
        ownerBranchId: fact.ownerBranchId,
      };
}

export function projectBoundVisualRecoveryApplication(input: {
  fact: AwaitingVisualEvidenceRecoveryFact;
  topology: VisualRecoveryActiveTopology;
}): BoundVisualRecoveryApplicationDecision {
  const branchRelation = resolveBoundVisualRecoveryRelation(input);
  const applied =
    branchRelation.authorized ||
    (input.fact.ownerKind === "current-question" &&
      input.fact.ownerBranchId ===
        input.topology.currentLogicalQuestionUnitId);
  return {
    applied,
    exactVisualEvidenceRecovery: applied,
    relation: branchRelation.authorized
      ? branchRelation.relation
      : undefined,
    branchRelation,
  };
}

export function authorizeAwaitingVisualEvidenceRecovery(input: {
  fact?: AwaitingVisualEvidenceRecoveryFact;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId?: string | null;
  logicalQuestionRevision?: number | null;
  visibleAnswerRevision?: number | null;
  parentTaskId?: string | null;
  parentRevision?: number | null;
  manualCorrectionRevision: number;
  now?: number;
}): AwaitingVisualEvidenceRecoveryAuthorization {
  const fact = input.fact;
  if (!fact) return { authorized: false, reason: "no-recovery-fact" };
  if ((input.now ?? Date.now()) > fact.expiresAt) {
    return { authorized: false, reason: "expired" };
  }
  if (input.sessionId !== fact.sessionId) {
    return { authorized: false, reason: "session-mismatch" };
  }
  if (input.runtimeEpoch !== fact.runtimeEpoch) {
    return { authorized: false, reason: "runtime-epoch-mismatch" };
  }
  if (input.logicalQuestionUnitId !== fact.logicalQuestionUnitId) {
    return { authorized: false, reason: "logical-question-mismatch" };
  }
  if (input.logicalQuestionRevision !== fact.logicalQuestionRevision) {
    return {
      authorized: false,
      reason: "logical-question-revision-mismatch",
    };
  }
  if (input.visibleAnswerRevision !== fact.visibleAnswerRevision) {
    return {
      authorized: false,
      reason: "visible-answer-revision-mismatch",
    };
  }
  if (fact.parentTaskId && input.parentTaskId !== fact.parentTaskId) {
    return { authorized: false, reason: "parent-mismatch" };
  }
  if (
    fact.parentRevision !== undefined &&
    input.parentRevision !== fact.parentRevision
  ) {
    return { authorized: false, reason: "parent-revision-mismatch" };
  }
  if (input.manualCorrectionRevision !== fact.manualCorrectionRevision) {
    return {
      authorized: false,
      reason: "manual-correction-revision-mismatch",
    };
  }
  return { authorized: true, reason: "authorized" };
}

export function formatAwaitingVisualEvidenceRecoveryForTrace(
  fact: AwaitingVisualEvidenceRecoveryFact | undefined,
  options: {
    stage: "created" | "authorized" | "consumed" | "cancelled";
    reason: string;
  }
): Record<string, unknown> {
  return {
    awaitingVisualEvidenceRecoveryStage: options.stage,
    awaitingVisualEvidenceRecoveryReason: options.reason,
    awaitingVisualEvidenceRecoveryId: fact?.id,
    awaitingVisualEvidenceRecoveryLogicalQuestionUnitId:
      fact?.logicalQuestionUnitId,
    awaitingVisualEvidenceRecoveryLogicalQuestionRevision:
      fact?.logicalQuestionRevision,
    awaitingVisualEvidenceRecoveryAnswerRevision: fact?.answerRevision,
    awaitingVisualEvidenceRecoveryVisibleAnswerRevision:
      fact?.visibleAnswerRevision,
    awaitingVisualEvidenceRecoveryParentTaskId: fact?.parentTaskId,
    awaitingVisualEvidenceRecoveryParentRevision: fact?.parentRevision,
    awaitingVisualEvidenceRecoveryOwnerKind: fact?.ownerKind,
    awaitingVisualEvidenceRecoveryOwnerBranchId: fact?.ownerBranchId,
    awaitingVisualEvidenceRecoveryQuestionType: fact?.questionType,
    awaitingVisualEvidenceRecoverySourceHash: fact?.sourceHash,
    awaitingVisualEvidenceRecoverySourceSettlementId:
      fact?.sourceSettlementId,
    awaitingVisualEvidenceRecoverySourceTurnIds: fact?.sourceTurnIds ?? [],
    awaitingVisualEvidenceRecoveryEvidence: fact?.evidence ?? [],
    awaitingVisualEvidenceRecoveryExpiresAt: fact?.expiresAt,
  };
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
