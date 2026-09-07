import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import type { EffectiveQuestionSourceRecord } from "./effective-question-source-ledger.js";
import type { StableAnswerRevision } from "./stable-answer.js";
import type { MeetingContextState } from "./types.js";
import {
  createProvisionalCurrentQuestion,
  type CurrentQuestionSettlementDecision,
} from "./current-question-settlement.js";

export type VisibleAnswerResponseActionTargetReason =
  | "current-lqu-matches-visible-answer"
  | "reconstructed-from-effective-source-record"
  | "visible-answer-missing"
  | "visible-answer-session-mismatch"
  | "visible-answer-runtime-epoch-mismatch"
  | "visible-answer-question-identity-missing"
  | "visible-answer-parent-changed"
  | "visible-answer-effective-source-missing"
  | "visible-answer-effective-source-mismatch"
  | "visible-answer-effective-source-incomplete";

export interface VisibleAnswerResponseActionTargetDecision {
  authorized: boolean;
  reason: VisibleAnswerResponseActionTargetReason;
  logicalQuestionUnit?: LogicalQuestionUnit;
  requestedVisibleAnswerRevision?: number;
  requestedParentId?: string | null;
  resolvedLogicalQuestionUnitId?: string;
  resolvedLogicalQuestionRevision?: number;
  sourceHash?: string;
  sourceKind?: EffectiveQuestionSourceRecord["sourceKind"];
  sourceObservationIds?: string[];
  sourceRecordId?: string;
  sourceOwner?: EffectiveQuestionSourceRecord["owner"];
  settlementId?: string;
  settlementSnapshot?: CurrentQuestionSettlementDecision;
  mismatchFacets: string[];
}

export function resolveVisibleAnswerResponseActionTarget(input: {
  stableAnswer?: StableAnswerRevision | null;
  currentLogicalQuestionUnit?: LogicalQuestionUnit;
  effectiveQuestionSources?: EffectiveQuestionSourceRecord[];
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

  const sourceRecords = input.effectiveQuestionSources ?? [];
  const matchingSourceRecords = sourceRecords.filter(
    (record) =>
      record.sessionId === input.meetingContext.sessionId &&
      record.runtimeEpoch === input.runtimeEpoch &&
      record.logicalQuestionUnitId === stable.logicalQuestionUnitId &&
      record.logicalQuestionRevision === stable.logicalQuestionRevision
  );
  const sourceRecord = matchingSourceRecords.find(
    (record) => record.sourceHash === stable.questionSourceHash
  );
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
      "current-lqu-matches-visible-answer",
      sourceRecord
    );
  }
  if (matchingSourceRecords.length === 0) {
    return reject(
      "visible-answer-effective-source-missing",
      "effective-source"
    );
  }
  if (!sourceRecord) {
    return reject(
      "visible-answer-effective-source-mismatch",
      "effective-source-hash"
    );
  }
  if (!hasCompleteEffectiveSourceRecord(sourceRecord)) {
    return reject(
      "visible-answer-effective-source-incomplete",
      "effective-source-payload"
    );
  }
  const logicalQuestionUnit = reconstructEffectiveSourceQuestion(
    sourceRecord,
    input.meetingContext
  );
  const reconstructedCurrentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit,
    sourceKind: sourceRecord.sourceKind ?? "voice",
    sourceObservationIds: sourceRecord.sourceObservationIds,
  });
  if (reconstructedCurrentQuestion.sourceHash !== sourceRecord.sourceHash) {
    return reject(
      "visible-answer-effective-source-mismatch",
      "effective-source-reconstruction-hash"
    );
  }
  return accepted(
    stable,
    logicalQuestionUnit,
    "reconstructed-from-effective-source-record",
    sourceRecord
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
    responseActionTargetSourceKind: decision.sourceKind,
    responseActionTargetSourceObservationIds: decision.sourceObservationIds,
    responseActionTargetSourceRecordId: decision.sourceRecordId,
    responseActionTargetSourceOwnerKind: decision.sourceOwner?.kind,
    responseActionTargetSourceOwnerParentId: decision.sourceOwner?.parentId,
    responseActionTargetSourceOwnerChildId:
      decision.sourceOwner?.kind === "active-child"
        ? decision.sourceOwner.childId
        : undefined,
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
    | "reconstructed-from-effective-source-record"
  >,
  sourceRecord?: EffectiveQuestionSourceRecord
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
    sourceKind: sourceRecord?.sourceKind,
    sourceObservationIds: sourceRecord?.sourceObservationIds
      ? [...sourceRecord.sourceObservationIds]
      : undefined,
    sourceRecordId: sourceRecord?.recordId,
    sourceOwner: sourceRecord?.owner
      ? { ...sourceRecord.owner }
      : undefined,
    settlementId: stable.settlementId,
    settlementSnapshot: readSettlementSnapshot(stable),
    mismatchFacets: [],
  };
}

function reconstructEffectiveSourceQuestion(
  record: CompleteEffectiveQuestionSourceRecord,
  meetingContext: MeetingContextState
): LogicalQuestionUnit {
  const sourceByTurnId = new Map(
    meetingContext.transcriptTurns.map((turn) => [turn.id, turn])
  );
  const sourcesFromRecord = (record.effectiveSourceTexts ?? [])
    .map((source) => ({
      turnId: source.turnId,
      text: source.text.trim(),
      startedAt: sourceByTurnId.get(source.turnId)?.startedAt ?? record.startedAt,
      endedAt: sourceByTurnId.get(source.turnId)?.endedAt ?? record.updatedAt,
    }))
    .filter((source) => source.text.length > 0);
  const sourcesFromTurns = record.sourceTurnIds
    .map((turnId) => sourceByTurnId.get(turnId))
    .filter((turn): turn is NonNullable<typeof turn> => Boolean(turn))
    .map((turn) => ({
      turnId: turn.id,
      text: turn.text.trim(),
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
    }))
    .filter((source) => source.text.length > 0);
  const fallbackSourceId =
    record.sourceObservationIds?.at(-1) ?? record.recordId;
  const sources =
    sourcesFromRecord.length > 0
      ? sourcesFromRecord
      : sourcesFromTurns.length > 0
        ? sourcesFromTurns
        : [
            {
              turnId: `source-record:${fallbackSourceId}`,
              text: record.text,
              startedAt: record.startedAt,
              endedAt: record.updatedAt,
            },
          ];
  return {
    id: record.logicalQuestionUnitId,
    revision: record.logicalQuestionRevision,
    sessionId: record.sessionId,
    runtimeEpoch: record.runtimeEpoch,
    currentTurnId: record.currentTurnId,
    sourceTurnIds: [...record.sourceTurnIds],
    contextSourceTurnIds: [...record.contextSourceTurnIds],
    recentLogicalQuestionSourceTurnIds: [
      ...record.recentLogicalQuestionSourceTurnIds,
    ],
    sources,
    normalizedText: record.text,
    restoredAnswerFocusText: record.answerFocusText,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    compositionReasons: ["visible-answer-effective-source-record"],
    boundaryReason: "visible-answer-effective-source-record",
    truncated: false,
  };
}

function hasCompleteEffectiveSourceRecord(
  record: EffectiveQuestionSourceRecord
): record is CompleteEffectiveQuestionSourceRecord {
  return Boolean(
    record.currentTurnId &&
      record.sourceKind &&
      record.text.trim() &&
      record.answerFocusText?.trim() &&
      Array.isArray(record.contextSourceTurnIds) &&
      Array.isArray(record.recentLogicalQuestionSourceTurnIds)
  );
}

interface CompleteEffectiveQuestionSourceRecord
  extends EffectiveQuestionSourceRecord {
  currentTurnId: string;
  contextSourceTurnIds: string[];
  recentLogicalQuestionSourceTurnIds: string[];
  answerFocusText: string;
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
