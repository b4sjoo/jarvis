import type { MeetingContextState } from "./meeting-context-contracts.js";
import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import {
  selectLatestEffectiveQuestionSourceRecords,
  type EffectiveQuestionSourceRecord,
} from "./effective-question-source-ledger.js";
import type { MeetingPhaseOwner } from "./meeting-task-runtime-transition.js";
import type { StableAnswerRevision } from "./stable-answer.js";
import { indexAuthorizedEffectiveSourceRecords } from "./authorized-effective-source-context.js";

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

export function resolveResponseActionLogicalQuestionUnit(input: {
  currentLogicalQuestionUnit: LogicalQuestionUnit | undefined;
  effectiveQuestionSources: EffectiveQuestionSourceRecord[];
  meetingContext: MeetingContextState;
  runtimeEpoch: number;
  preferScreen: boolean;
  phaseOwner?: MeetingPhaseOwner;
}): LogicalQuestionUnit | undefined {
  const index = indexAuthorizedEffectiveSourceRecords({
    effectiveRecords: input.effectiveQuestionSources,
    logicalQuestionUnit: input.currentLogicalQuestionUnit,
    sessionId: input.meetingContext.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    activeMeetingTask: input.meetingContext.activeMeetingTask,
  });
  const current = index.currentLogicalQuestionUnit;
  const currentRecord = current && index.byLogicalQuestionUnitId.get(current.id);
  const currentIsValid = current &&
    (!index.latestByLogicalQuestionUnitId.has(current.id) || currentRecord) &&
    current.sourceTurnIds.every((id) => !index.knownSourceTurnIds.has(id) ||
      index.bySourceTurnId.get(id)?.logicalQuestionUnitId === current.id);
  // Correction retains its current-question target; phase actions select the branch.
  if (!input.phaseOwner && currentIsValid) return current;
  if (!input.phaseOwner && !input.preferScreen) return undefined;
  const task = input.meetingContext.activeMeetingTask;
  if (!task) return undefined;
  const owner = input.phaseOwner ?? (
    task.child
      ? { kind: "child", id: task.child.id }
      : { kind: "parent", id: task.parent.id }
  );
  if (
    (owner.kind === "parent" && task.child) ||
    owner.id !== (owner.kind === "child" ? task.child?.id : task.parent.id)
  ) {
    return undefined;
  }
  const record = selectLatestEffectiveQuestionSourceRecords(
    input.effectiveQuestionSources
  )
    .filter((candidate) =>
      candidate.sessionId === input.meetingContext.sessionId &&
      candidate.runtimeEpoch <= input.runtimeEpoch &&
      candidate.owner.parentId === task.parent.id &&
      (owner.kind === "child"
        ? candidate.owner.kind === "active-child" &&
          candidate.owner.childId === owner.id
        : candidate.owner.kind === "parent-mainline"))
    // Regenerating an older visible answer updates settlement time, not source order.
    .sort((a, b) => b.updatedAt - a.updatedAt || b.settledAt - a.settledAt)
    .at(0);
  if (!record || !hasCompleteEffectiveSourceRecord(record)) return undefined;
  if (
    currentIsValid && current.id === record.logicalQuestionUnitId &&
    current.revision > record.logicalQuestionRevision
  ) return undefined;
  const unit = reconstructEffectiveSourceQuestion(record, input.meetingContext);
  return createProvisionalCurrentQuestion({
    logicalQuestionUnit: unit,
    sourceKind: record.sourceKind,
    sourceObservationIds: record.sourceObservationIds,
  }).sourceHash === record.sourceHash ? unit : undefined;
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
    stable.runtimeEpoch > input.runtimeEpoch
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
  if (stable.taskId && stable.taskId !== activeParentId) {
    return reject("visible-answer-parent-changed", "parent");
  }

  // The visible answer's execution epoch is not the source's birth epoch.
  // Preserve provenance from its effective record or exact current LQU below.
  const sourceRecords = selectLatestEffectiveQuestionSourceRecords(
    input.effectiveQuestionSources ?? []
  );
  const matchingSourceRecords = sourceRecords.filter(
    (record) =>
      record.sessionId === input.meetingContext.sessionId &&
      record.runtimeEpoch <= input.runtimeEpoch &&
      record.logicalQuestionUnitId === stable.logicalQuestionUnitId &&
      record.logicalQuestionRevision === stable.logicalQuestionRevision
  );
  const sourceRecord = matchingSourceRecords.find(
    (record) => record.sourceHash === stable.questionSourceHash
  );
  const current = input.currentLogicalQuestionUnit;
  if (
    current?.sessionId === input.meetingContext.sessionId &&
    current.runtimeEpoch <= input.runtimeEpoch &&
    current.id === stable.logicalQuestionUnitId &&
    current.revision > stable.logicalQuestionRevision
  ) {
    return reject(
      "visible-answer-effective-source-mismatch",
      "superseded-revision"
    );
  }
  const currentMatchesVisibleAnswer =
    current?.sessionId === input.meetingContext.sessionId &&
    current.runtimeEpoch <= input.runtimeEpoch &&
    current.id === stable.logicalQuestionUnitId &&
    current.revision === stable.logicalQuestionRevision;
  const settlementSnapshot = readSettlementSnapshot(stable);
  // A parentless Voice answer has no owner-ledger entry. Its exact live LQU
  // remains the source; Screen and previously bound questions still need the ledger.
  const unboundCurrentVoice = Boolean(
    currentMatchesVisibleAnswer && !stable.taskId && !activeParentId &&
    settlementSnapshot?.sourceKind === "voice" &&
    !sourceRecords.some((record) =>
      record.sessionId === input.meetingContext.sessionId &&
      record.logicalQuestionUnitId === stable.logicalQuestionUnitId
    )
  );
  if (input.effectiveQuestionSources && !unboundCurrentVoice) {
    if (!sourceRecord) {
      return matchingSourceRecords.length
        ? reject("visible-answer-effective-source-mismatch", "effective-source-hash")
        : reject("visible-answer-effective-source-missing", "effective-source");
    }
    if (!hasCompleteEffectiveSourceRecord(sourceRecord)) {
      return reject(
        "visible-answer-effective-source-incomplete",
        "effective-source-payload"
      );
    }
    if (
      sourceRecord.owner.parentId !== activeParentId ||
      (sourceRecord.owner.kind === "active-child" &&
        sourceRecord.owner.childId !== input.meetingContext.activeMeetingTask?.child?.id)
    ) {
      return reject("visible-answer-parent-changed", "source-owner");
    }
  }
  if (currentMatchesVisibleAnswer) {
    if (sourceRecord && sourceRecord.runtimeEpoch !== current.runtimeEpoch) {
      return reject("visible-answer-effective-source-mismatch", "source-birth-epoch");
    }
    const currentSource = sourceRecord ??
      (unboundCurrentVoice ? settlementSnapshot : undefined);
    if (!currentSource && current.runtimeEpoch < input.runtimeEpoch) {
      return reject("visible-answer-effective-source-missing", "effective-source");
    }
    if (
      currentSource && createProvisionalCurrentQuestion({
        logicalQuestionUnit: current,
        sourceKind: currentSource.sourceKind ?? "voice",
        sourceObservationIds: currentSource.sourceObservationIds,
      }).sourceHash !== currentSource.sourceHash
    ) {
      return reject("visible-answer-effective-source-mismatch", "current-source-hash");
    }
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
      appliedSpeechCorrectionIds: record.correctionIds?.length
        ? [...record.correctionIds]
        : undefined,
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
      appliedSpeechCorrectionIds: record.correctionIds?.length
        ? [...record.correctionIds]
        : undefined,
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
              appliedSpeechCorrectionIds: record.correctionIds?.length
                ? [...record.correctionIds]
                : undefined,
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
  sourceKind: CurrentQuestionSettlementDecision["sourceKind"];
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
