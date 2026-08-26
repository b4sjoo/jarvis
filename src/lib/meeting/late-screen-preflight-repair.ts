import type { CanonicalQuestionType } from "./task-taxonomy.js";

export interface LateScreenPreflightRepairLease {
  sourceOperationId: string;
  sourcePreflightLeaseRevision: number;
  sourceObservationId: string;
  sessionId: string;
  runtimeEpoch: number;
  settlementId: string;
  settlementRevision: number;
  baseVisibleAnswerRevision: number;
  manualCorrectionRevision: number;
  questionType: CanonicalQuestionType;
  createdAt: number;
}

export type LateScreenPreflightRepairRejectionReason =
  | "runtime-inactive"
  | "operation-mismatch"
  | "newer-operation-active"
  | "session-mismatch"
  | "runtime-epoch-mismatch"
  | "observation-mismatch"
  | "settlement-mismatch"
  | "settlement-revision-mismatch"
  | "visible-answer-revision-changed"
  | "manual-correction-revision-changed"
  | "question-type-unresolved";

export interface LateScreenPreflightRepairAuthorization {
  authorized: boolean;
  reason: "authorized" | LateScreenPreflightRepairRejectionReason;
}

export function authorizeLateScreenPreflightRepair(input: {
  stage: "candidate" | "replay";
  lease: LateScreenPreflightRepairLease;
  runtimeActive: boolean;
  activeOperationId?: string | null;
  currentSessionId: string;
  currentRuntimeEpoch: number;
  currentObservationId?: string;
  currentSettlementId?: string;
  currentSettlementRevision?: number;
  currentVisibleAnswerRevision: number;
  currentManualCorrectionRevision: number;
}): LateScreenPreflightRepairAuthorization {
  if (!input.runtimeActive) {
    return { authorized: false, reason: "runtime-inactive" };
  }
  if (input.lease.questionType === "unknown") {
    return { authorized: false, reason: "question-type-unresolved" };
  }
  if (input.stage === "candidate") {
    if (input.activeOperationId !== input.lease.sourceOperationId) {
      return { authorized: false, reason: "operation-mismatch" };
    }
  } else if (input.activeOperationId) {
    return { authorized: false, reason: "newer-operation-active" };
  }
  if (input.currentSessionId !== input.lease.sessionId) {
    return { authorized: false, reason: "session-mismatch" };
  }
  if (input.currentRuntimeEpoch !== input.lease.runtimeEpoch) {
    return { authorized: false, reason: "runtime-epoch-mismatch" };
  }
  if (input.currentObservationId !== input.lease.sourceObservationId) {
    return { authorized: false, reason: "observation-mismatch" };
  }
  if (input.currentSettlementId !== input.lease.settlementId) {
    return { authorized: false, reason: "settlement-mismatch" };
  }
  if (
    input.currentSettlementRevision !== input.lease.settlementRevision
  ) {
    return {
      authorized: false,
      reason: "settlement-revision-mismatch",
    };
  }
  if (
    input.currentVisibleAnswerRevision !==
    input.lease.baseVisibleAnswerRevision
  ) {
    return {
      authorized: false,
      reason: "visible-answer-revision-changed",
    };
  }
  if (
    input.currentManualCorrectionRevision !==
    input.lease.manualCorrectionRevision
  ) {
    return {
      authorized: false,
      reason: "manual-correction-revision-changed",
    };
  }
  return { authorized: true, reason: "authorized" };
}

export function formatLateScreenPreflightRepairForTrace(input: {
  lease: LateScreenPreflightRepairLease;
  authorization: LateScreenPreflightRepairAuthorization;
  stage: "candidate" | "replay" | "terminal";
}) {
  return {
    lateScreenPreflightRepairStage: input.stage,
    lateScreenPreflightRepairAuthorized: input.authorization.authorized,
    lateScreenPreflightRepairReason: input.authorization.reason,
    lateScreenPreflightRepairSourceOperationId:
      input.lease.sourceOperationId,
    lateScreenPreflightRepairSourceLeaseRevision:
      input.lease.sourcePreflightLeaseRevision,
    lateScreenPreflightRepairSourceObservationId:
      input.lease.sourceObservationId,
    lateScreenPreflightRepairSettlementId: input.lease.settlementId,
    lateScreenPreflightRepairSettlementRevision:
      input.lease.settlementRevision,
    lateScreenPreflightRepairBaseVisibleAnswerRevision:
      input.lease.baseVisibleAnswerRevision,
    lateScreenPreflightRepairManualCorrectionRevision:
      input.lease.manualCorrectionRevision,
    lateScreenPreflightRepairQuestionType: input.lease.questionType,
  };
}
