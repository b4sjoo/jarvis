import type { AdvisorTurnGateAction } from "./advisor-turn-intent.js";
import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import type { QuestionInstanceLineage } from "./types.js";

export interface LogicalQuestionUnitLease {
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  sessionId: string;
  runtimeEpoch: number;
  currentTurnId: string;
  sourceTurnIds: string[];
}

export type LogicalQuestionLeaseAuthorizationReason =
  | "logical-question-current"
  | "logical-question-missing"
  | "logical-question-id-mismatch"
  | "logical-question-revision-mismatch"
  | "logical-question-session-mismatch"
  | "logical-question-runtime-mismatch"
  | "logical-question-current-turn-mismatch"
  | "logical-question-source-turns-mismatch";

export interface LogicalQuestionLeaseAuthorization {
  authorized: boolean;
  reason: LogicalQuestionLeaseAuthorizationReason;
}

export interface LogicalQuestionMaterializationDecision {
  materialize: boolean;
  reason:
    | "answer-refresh"
    | "substantive-non-filler-turn"
    | "exact-high-filler"
    | "empty-or-punctuation-only-turn";
}

export function createLogicalQuestionUnitLease(
  unit: LogicalQuestionUnit
): LogicalQuestionUnitLease {
  return {
    logicalQuestionUnitId: unit.id,
    logicalQuestionUnitRevision: unit.revision,
    sessionId: unit.sessionId,
    runtimeEpoch: unit.runtimeEpoch,
    currentTurnId: unit.currentTurnId,
    sourceTurnIds: [...unit.sourceTurnIds],
  };
}

export function authorizeLogicalQuestionUnitLease(
  lease: LogicalQuestionUnitLease,
  current: LogicalQuestionUnit | undefined
): LogicalQuestionLeaseAuthorization {
  if (!current) {
    return { authorized: false, reason: "logical-question-missing" };
  }
  if (lease.sessionId !== current.sessionId) {
    return {
      authorized: false,
      reason: "logical-question-session-mismatch",
    };
  }
  if (lease.runtimeEpoch !== current.runtimeEpoch) {
    return {
      authorized: false,
      reason: "logical-question-runtime-mismatch",
    };
  }
  if (lease.logicalQuestionUnitId !== current.id) {
    return { authorized: false, reason: "logical-question-id-mismatch" };
  }
  if (lease.logicalQuestionUnitRevision !== current.revision) {
    return {
      authorized: false,
      reason: "logical-question-revision-mismatch",
    };
  }
  if (lease.currentTurnId !== current.currentTurnId) {
    return {
      authorized: false,
      reason: "logical-question-current-turn-mismatch",
    };
  }
  if (!sameOrderedValues(lease.sourceTurnIds, current.sourceTurnIds)) {
    return {
      authorized: false,
      reason: "logical-question-source-turns-mismatch",
    };
  }
  return { authorized: true, reason: "logical-question-current" };
}

export function decideLogicalQuestionMaterialization({
  action,
  wordEquivalent,
  exactHighFiller = false,
}: {
  action: AdvisorTurnGateAction;
  wordEquivalent: number;
  exactHighFiller?: boolean;
}): LogicalQuestionMaterializationDecision {
  if (exactHighFiller) {
    return { materialize: false, reason: "exact-high-filler" };
  }
  if (action === "answer-refresh") {
    return { materialize: true, reason: "answer-refresh" };
  }
  if (wordEquivalent >= 1) {
    return {
      materialize: true,
      reason: "substantive-non-filler-turn",
    };
  }
  return {
    materialize: false,
    reason: "empty-or-punctuation-only-turn",
  };
}

export function createCanonicalLogicalQuestionLineage({
  unit,
  traceId,
}: {
  unit: LogicalQuestionUnit;
  traceId: string;
}): QuestionInstanceLineage {
  return {
    questionInstanceId: `lqu:${unit.id}`,
    questionOriginTraceId: traceId,
    triggerTurnId: unit.currentTurnId,
    sessionId: unit.sessionId,
    runtimeEpoch: unit.runtimeEpoch,
    identityState: "canonical",
  };
}

export function formatLogicalQuestionLeaseForTrace(
  lease: LogicalQuestionUnitLease | undefined,
  authorization?: LogicalQuestionLeaseAuthorization,
  stage?: string
) {
  if (!lease) return {};
  return {
    logicalQuestionLeaseUnitId: lease.logicalQuestionUnitId,
    logicalQuestionLeaseRevision: lease.logicalQuestionUnitRevision,
    logicalQuestionLeaseSessionId: lease.sessionId,
    logicalQuestionLeaseRuntimeEpoch: lease.runtimeEpoch,
    logicalQuestionLeaseCurrentTurnId: lease.currentTurnId,
    logicalQuestionLeaseSourceTurnIds: lease.sourceTurnIds,
    logicalQuestionLeaseAuthorized: authorization?.authorized,
    logicalQuestionLeaseAuthorizationReason: authorization?.reason,
    logicalQuestionLeaseAuthorizationStage: stage,
  };
}

function sameOrderedValues(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
