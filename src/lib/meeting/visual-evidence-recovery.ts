export const AWAITING_VISUAL_EVIDENCE_TTL_MS = 5 * 60 * 1_000;

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
  parentTaskId: string;
  parentRevision: number;
  sourceHash: string;
  sourceTurnIds: string[];
  manualCorrectionRevision: number;
  createdAt: number;
  expiresAt: number;
  evidence: string[];
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
    | "source-hash-mismatch"
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
  sourceHash?: string | null;
  sourceTurnIds?: string[];
  manualCorrectionRevision: number;
  createdAt?: number;
  ttlMs?: number;
}): AwaitingVisualEvidenceRecoveryFact | undefined {
  const parentTaskId = input.parentTaskId?.trim();
  const sourceHash = input.sourceHash?.trim();
  if (
    input.resolution.state !== "awaiting-evidence" ||
    !input.resolution.awaitingVisualEvidence ||
    !input.logicalQuestionUnitId.trim() ||
    !parentTaskId ||
    input.parentRevision === undefined ||
    input.parentRevision === null ||
    !sourceHash
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
    parentTaskId,
    parentRevision: input.parentRevision,
    sourceHash,
    sourceTurnIds: uniqueStrings(input.sourceTurnIds ?? []),
    manualCorrectionRevision: input.manualCorrectionRevision,
    createdAt,
    expiresAt: createdAt + ttlMs,
    evidence: uniqueStrings(input.resolution.evidence),
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
  sourceHash?: string | null;
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
  if (input.parentTaskId !== fact.parentTaskId) {
    return { authorized: false, reason: "parent-mismatch" };
  }
  if (input.parentRevision !== fact.parentRevision) {
    return { authorized: false, reason: "parent-revision-mismatch" };
  }
  if (input.sourceHash !== fact.sourceHash) {
    return { authorized: false, reason: "source-hash-mismatch" };
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
    awaitingVisualEvidenceRecoverySourceHash: fact?.sourceHash,
    awaitingVisualEvidenceRecoverySourceTurnIds: fact?.sourceTurnIds ?? [],
    awaitingVisualEvidenceRecoveryEvidence: fact?.evidence ?? [],
    awaitingVisualEvidenceRecoveryExpiresAt: fact?.expiresAt,
  };
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
