import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import type { StableAnswerRevision } from "./stable-answer.js";
import type { MeetingContextState } from "./types.js";
import type { CurrentQuestionSettlementDecision } from "./current-question-settlement.js";

export type VisibleAnswerResponseActionTargetReason =
  | "current-lqu-matches-visible-answer"
  | "reconstructed-from-visible-answer-sources"
  | "visible-answer-missing"
  | "visible-answer-session-mismatch"
  | "visible-answer-runtime-epoch-mismatch"
  | "visible-answer-question-identity-missing"
  | "visible-answer-parent-changed"
  | "visible-answer-source-turns-unavailable";

export interface VisibleAnswerResponseActionTargetDecision {
  authorized: boolean;
  reason: VisibleAnswerResponseActionTargetReason;
  logicalQuestionUnit?: LogicalQuestionUnit;
  requestedVisibleAnswerRevision?: number;
  requestedParentId?: string | null;
  resolvedLogicalQuestionUnitId?: string;
  resolvedLogicalQuestionRevision?: number;
  sourceHash?: string;
  settlementId?: string;
  settlementSnapshot?: CurrentQuestionSettlementDecision;
  mismatchFacets: string[];
}

export function resolveVisibleAnswerResponseActionTarget(input: {
  stableAnswer?: StableAnswerRevision | null;
  currentLogicalQuestionUnit?: LogicalQuestionUnit;
  meetingContext: MeetingContextState;
  runtimeEpoch: number;
}): VisibleAnswerResponseActionTargetDecision {
  const stable = input.stableAnswer;
  const reject = (
    reason: VisibleAnswerResponseActionTargetReason,
    ...mismatchFacets: string[]
  ): VisibleAnswerResponseActionTargetDecision => ({
    authorized: false,
    reason,
    requestedVisibleAnswerRevision: stable?.revision,
    requestedParentId: stable?.taskId,
    sourceHash: stable?.questionSourceHash,
    settlementId: stable?.settlementId,
    settlementSnapshot: readSettlementSnapshot(stable),
    mismatchFacets,
  });
  if (!stable) return reject("visible-answer-missing", "visible-answer");
  if (
    stable.sessionId &&
    stable.sessionId !== input.meetingContext.sessionId
  ) {
    return reject("visible-answer-session-mismatch", "session");
  }
  if (
    stable.runtimeEpoch !== undefined &&
    stable.runtimeEpoch !== input.runtimeEpoch
  ) {
    return reject("visible-answer-runtime-epoch-mismatch", "runtime-epoch");
  }
  if (
    !stable.logicalQuestionUnitId ||
    stable.logicalQuestionRevision === null
  ) {
    return reject(
      "visible-answer-question-identity-missing",
      "logical-question"
    );
  }
  const activeParentId = input.meetingContext.activeMeetingTask?.parent.id;
  if (stable.taskId && activeParentId && stable.taskId !== activeParentId) {
    return reject("visible-answer-parent-changed", "parent");
  }

  const current = input.currentLogicalQuestionUnit;
  if (
    current?.sessionId === input.meetingContext.sessionId &&
    current.runtimeEpoch === input.runtimeEpoch &&
    current.id === stable.logicalQuestionUnitId &&
    current.revision === stable.logicalQuestionRevision
  ) {
    return accepted(
      stable,
      current,
      "current-lqu-matches-visible-answer"
    );
  }

  const sourceTurnIds = Array.from(
    new Set(stable.suggestion.basedOnTurnIds.filter(Boolean))
  );
  const sourceTurns = sourceTurnIds
    .map((turnId) =>
      input.meetingContext.transcriptTurns.find((turn) => turn.id === turnId)
    )
    .filter((turn): turn is NonNullable<typeof turn> => Boolean(turn))
    .sort((left, right) => left.startedAt - right.startedAt);
  if (sourceTurns.length === 0) {
    return reject(
      "visible-answer-source-turns-unavailable",
      "source-turns"
    );
  }
  const normalizedText = sourceTurns
    .map((turn) => turn.text.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!normalizedText) {
    return reject(
      "visible-answer-source-turns-unavailable",
      "source-turns"
    );
  }
  const logicalQuestionUnit: LogicalQuestionUnit = {
    id: stable.logicalQuestionUnitId,
    revision: stable.logicalQuestionRevision,
    sessionId: input.meetingContext.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    currentTurnId: sourceTurns[sourceTurns.length - 1].id,
    sourceTurnIds: sourceTurns.map((turn) => turn.id),
    sources: sourceTurns.map((turn) => ({
      turnId: turn.id,
      text: turn.text,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
    })),
    normalizedText,
    startedAt: sourceTurns[0].startedAt,
    updatedAt: sourceTurns[sourceTurns.length - 1].endedAt,
    compositionReasons: ["visible-answer-response-owner"],
    boundaryReason: "visible-answer-response-owner",
    truncated: false,
  };
  return accepted(
    stable,
    logicalQuestionUnit,
    "reconstructed-from-visible-answer-sources"
  );
}

export function formatVisibleAnswerResponseActionTargetForTrace(
  decision: VisibleAnswerResponseActionTargetDecision
) {
  return {
    responseActionTargetAuthorized: decision.authorized,
    responseActionTargetReason: decision.reason,
    responseActionRequestedVisibleAnswerRevision:
      decision.requestedVisibleAnswerRevision,
    responseActionRequestedParentId: decision.requestedParentId,
    responseActionResolvedLogicalQuestionUnitId:
      decision.resolvedLogicalQuestionUnitId,
    responseActionResolvedLogicalQuestionRevision:
      decision.resolvedLogicalQuestionRevision,
    responseActionTargetSourceHash: decision.sourceHash,
    responseActionTargetSettlementId: decision.settlementId,
    responseActionTargetMismatchFacets: decision.mismatchFacets,
  };
}

function accepted(
  stable: StableAnswerRevision,
  logicalQuestionUnit: LogicalQuestionUnit,
  reason: Extract<
    VisibleAnswerResponseActionTargetReason,
    | "current-lqu-matches-visible-answer"
    | "reconstructed-from-visible-answer-sources"
  >
): VisibleAnswerResponseActionTargetDecision {
  return {
    authorized: true,
    reason,
    logicalQuestionUnit,
    requestedVisibleAnswerRevision: stable.revision,
    requestedParentId: stable.taskId,
    resolvedLogicalQuestionUnitId: logicalQuestionUnit.id,
    resolvedLogicalQuestionRevision: logicalQuestionUnit.revision,
    sourceHash: stable.questionSourceHash,
    settlementId: stable.settlementId,
    settlementSnapshot: readSettlementSnapshot(stable),
    mismatchFacets: [],
  };
}

function readSettlementSnapshot(
  stable: StableAnswerRevision | null | undefined
): CurrentQuestionSettlementDecision | undefined {
  const snapshot = stable?.settlementSnapshot;
  const candidate = snapshot as
    | Partial<CurrentQuestionSettlementDecision>
    | undefined;
  if (
    !stable ||
    !candidate ||
    candidate.settlementId !== stable.settlementId ||
    candidate.logicalQuestionUnitId !== stable.logicalQuestionUnitId ||
    candidate.revision !== stable.logicalQuestionRevision ||
    candidate.sourceHash !== stable.questionSourceHash
  ) {
    return undefined;
  }
  return candidate as CurrentQuestionSettlementDecision;
}
