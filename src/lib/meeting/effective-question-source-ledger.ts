import type { ActiveMeetingTask } from "./active-meeting-task.js";
import { isExplicitMeetingLogisticsTranscript } from "./meeting-logistics.js";
import type { EffectiveCurrentQuestionSettlement } from "./current-question-settlement.js";
import {
  getLogicalQuestionSemanticEvidenceText,
  type LogicalQuestionUnit,
} from "./logical-question-unit.js";
import {
  projectEffectiveLogicalQuestionSources,
} from "./logical-question-effective-projection.js";
import { projectPrimaryAsk } from "./primary-ask-projection.js";
import {
  hasConstraintOrCorrectionSignal,
} from "./transcript-fusion.js";
import { classifyInterviewTransitionTurn } from "./interview-section-transition.js";
import type { TranscriptTurn } from "./types.js";

export type EffectiveQuestionSourceOwner =
  | { kind: "parent-mainline"; parentId: string }
  | { kind: "active-child"; parentId: string; childId: string };

export interface EffectiveQuestionSourceRecord {
  recordId: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionRevision: number;
  sourceHash: string;
  sourceTurnIds: string[];
  correctionIds?: string[];
  effectiveSourceTexts?: Array<{ turnId: string; text: string }>;
  text: string;
  startedAt: number;
  updatedAt: number;
  speechAct: ReturnType<typeof projectPrimaryAsk>["speechAct"];
  disposition: ReturnType<typeof projectPrimaryAsk>["disposition"];
  relation: EffectiveCurrentQuestionSettlement["relation"];
  owner: EffectiveQuestionSourceOwner;
  settledAt: number;
}

export interface OwnerScopedRelationEvidence {
  sourceId: string;
  text: string;
  role?: "question" | "constraint" | "transition";
  sourceTurnIds: string[];
  selectionReason: "lqu-projection" | "raw-recent-turn";
  ownerKind: EffectiveQuestionSourceOwner["kind"];
}

export interface OwnerScopedRelationEvidenceSelection {
  recentBranchEvidence: OwnerScopedRelationEvidence[];
  recentParentEvidence: OwnerScopedRelationEvidence[];
  diagnostics: {
    lquSelectedCount: number;
    rawSupplementCount: number;
    acknowledgementExcludedCount: number;
    logisticsExcludedCount: number;
    coveredTurnCount: number;
    branchEvidenceCount: number;
    parentEvidenceCount: number;
    supersededRecordCount: number;
  };
}

export class EffectiveQuestionSourceLedger {
  private readonly records: EffectiveQuestionSourceRecord[] = [];

  constructor(private readonly maxEntries = 96) {}

  upsert(record: EffectiveQuestionSourceRecord) {
    const index = this.records.findIndex(
      (candidate) => candidate.recordId === record.recordId
    );
    if (index >= 0) this.records[index] = cloneRecord(record);
    else this.records.push(cloneRecord(record));
    if (this.records.length > this.maxEntries) {
      this.records.splice(0, this.records.length - this.maxEntries);
    }
    return cloneRecord(record);
  }

  list() {
    return selectLatestEffectiveQuestionSourceRecords(this.records).map(
      cloneRecord
    );
  }

  listHistory() {
    return this.records.map(cloneRecord);
  }

  findLogicalQuestion(input: {
    sessionId: string;
    runtimeEpoch: number;
    logicalQuestionUnitId: string;
    logicalQuestionRevision: number;
  }) {
    const matchingRecords = this.records.filter(
      (candidate) =>
        candidate.sessionId === input.sessionId &&
        candidate.runtimeEpoch === input.runtimeEpoch &&
        candidate.logicalQuestionUnitId === input.logicalQuestionUnitId
    );
    const latestRevision = matchingRecords.reduce(
      (latest, candidate) =>
        Math.max(latest, candidate.logicalQuestionRevision),
      -1
    );
    if (input.logicalQuestionRevision !== latestRevision) return undefined;
    const record = [...matchingRecords]
      .sort(compareEffectiveQuestionSourceRecords)
      .reverse()
      .find(
        (candidate) =>
          candidate.logicalQuestionRevision ===
            input.logicalQuestionRevision
      );
    return record ? cloneRecord(record) : undefined;
  }

  clear() {
    this.records.length = 0;
  }
}

export function createEffectiveQuestionSourceRecord(input: {
  logicalQuestionUnit: LogicalQuestionUnit;
  settlement: EffectiveCurrentQuestionSettlement;
  activeMeetingTask?: ActiveMeetingTask;
  settledAt?: number;
}): EffectiveQuestionSourceRecord | undefined {
  const parent = input.activeMeetingTask?.parent;
  if (!parent) return undefined;
  const text = getLogicalQuestionSemanticEvidenceText(
    input.logicalQuestionUnit
  )
    .trim()
    .slice(0, 1_200);
  if (!text) return undefined;
  const projection =
    input.logicalQuestionUnit.primaryAskProjection ??
    projectPrimaryAsk({
      turnId: input.logicalQuestionUnit.currentTurnId,
      text,
    });
  const child = input.activeMeetingTask?.child;
  const sourceProjection = projectEffectiveLogicalQuestionSources(
    input.logicalQuestionUnit
  );
  const owner: EffectiveQuestionSourceOwner =
    input.settlement.relation === "child-probe" && child
      ? { kind: "active-child", parentId: parent.id, childId: child.id }
      : { kind: "parent-mainline", parentId: parent.id };
  return {
    recordId: [
      "effective-question-source",
      input.logicalQuestionUnit.sessionId,
      input.logicalQuestionUnit.runtimeEpoch,
      input.logicalQuestionUnit.id,
      input.logicalQuestionUnit.revision,
      input.settlement.sourceHash,
    ].join(":"),
    sessionId: input.logicalQuestionUnit.sessionId,
    runtimeEpoch: input.logicalQuestionUnit.runtimeEpoch,
    logicalQuestionUnitId: input.logicalQuestionUnit.id,
    logicalQuestionRevision: input.logicalQuestionUnit.revision,
    sourceHash: input.settlement.sourceHash,
    sourceTurnIds: [...input.logicalQuestionUnit.sourceTurnIds],
    correctionIds: [...sourceProjection.correctionIds],
    effectiveSourceTexts: sourceProjection.effectiveSourceTexts.map(
      (source) => ({ ...source })
    ),
    text,
    startedAt: input.logicalQuestionUnit.startedAt,
    updatedAt: input.logicalQuestionUnit.updatedAt,
    speechAct: projection.speechAct,
    disposition: projection.disposition,
    relation: input.settlement.relation,
    owner,
    settledAt: input.settledAt ?? Date.now(),
  };
}

export function selectOwnerScopedRelationEvidence(input: {
  records: EffectiveQuestionSourceRecord[];
  currentLogicalQuestionUnit: LogicalQuestionUnit;
  activeMeetingTask: ActiveMeetingTask;
  transcriptTurns: TranscriptTurn[];
}): OwnerScopedRelationEvidenceSelection {
  const { currentLogicalQuestionUnit, activeMeetingTask } = input;
  const parentId = activeMeetingTask.parent.id;
  const childId = activeMeetingTask.child?.id;
  const currentTurnIds = new Set(currentLogicalQuestionUnit.sourceTurnIds);
  let acknowledgementExcludedCount = 0;
  let logisticsExcludedCount = 0;
  const latestRecords = selectLatestEffectiveQuestionSourceRecords(
    input.records
  );
  const ownedRecords = latestRecords.filter(
    (record) =>
      record.sessionId === currentLogicalQuestionUnit.sessionId &&
      record.runtimeEpoch === currentLogicalQuestionUnit.runtimeEpoch &&
      record.logicalQuestionUnitId !== currentLogicalQuestionUnit.id &&
      record.owner.parentId === parentId
  );
  const eligibleRecords = ownedRecords.filter((record) => {
    if (record.speechAct === "acknowledgement") {
      acknowledgementExcludedCount += 1;
      return false;
    }
    if (
      record.speechAct === "logistics" ||
      isExplicitMeetingLogisticsTranscript(record.text)
    ) {
      logisticsExcludedCount += 1;
      return false;
    }
    return true;
  });
  const branchRecords = childId
    ? eligibleRecords.filter(
        (record) =>
          record.owner.kind === "active-child" &&
          record.owner.childId === childId
      )
    : [];
  const parentRecords = eligibleRecords.filter(
    (record) => record.owner.kind === "parent-mainline"
  );
  const recentBranchEvidence = selectLquEvidence(branchRecords, 3, 480);
  const recentParentEvidence = selectLquEvidence(parentRecords, 5, 720);
  const coveredTurnIds = new Set(
    [
      ...recentBranchEvidence.flatMap((item) => item.sourceTurnIds),
      ...recentParentEvidence.flatMap((item) => item.sourceTurnIds),
      ...ownedRecords.flatMap((record) => record.sourceTurnIds),
      ...(activeMeetingTask.parent.canonicalQuestionSourceTurnIds ?? []),
      activeMeetingTask.parent.startTurnId,
      activeMeetingTask.parent.promptTranscriptStartTurnId,
      ...(activeMeetingTask.child?.basedOnTurnIds ?? []),
    ].filter((turnId): turnId is string => Boolean(turnId))
  );

  const parentBoundaryIndex = findEarliestTurnIndex(
    input.transcriptTurns,
    [
      activeMeetingTask.parent.promptTranscriptStartTurnId,
      activeMeetingTask.parent.startTurnId,
      ...(activeMeetingTask.parent.canonicalQuestionSourceTurnIds ?? []),
    ]
  );
  const childBoundaryIndex = findEarliestTurnIndex(
    input.transcriptTurns,
    activeMeetingTask.child?.basedOnTurnIds ?? []
  );
  const rawCandidates = input.transcriptTurns.filter((turn, index) => {
    if (
      turn.speaker !== "them" ||
      currentTurnIds.has(turn.id) ||
      coveredTurnIds.has(turn.id) ||
      turn.contextFusionStatus === "duplicate-suppressed" ||
      !turn.text.trim() ||
      (parentBoundaryIndex >= 0 && index < parentBoundaryIndex)
    ) {
      return false;
    }
    const projection = projectPrimaryAsk({ turnId: turn.id, text: turn.text });
    if (projection.speechAct === "acknowledgement") {
      acknowledgementExcludedCount += 1;
      return false;
    }
    if (
      projection.speechAct === "logistics" ||
      isExplicitMeetingLogisticsTranscript(turn.text)
    ) {
      logisticsExcludedCount += 1;
      return false;
    }
    return true;
  });
  const branchRaw = childId && childBoundaryIndex >= 0
    ? rawCandidates.filter(
        (turn) =>
          input.transcriptTurns.findIndex((item) => item.id === turn.id) >=
          childBoundaryIndex
      )
    : [];
  const parentRaw = childId && childBoundaryIndex >= 0
    ? rawCandidates.filter(
        (turn) =>
          input.transcriptTurns.findIndex((item) => item.id === turn.id) <
          childBoundaryIndex
      )
    : rawCandidates;

  supplementRawEvidence(recentBranchEvidence, branchRaw, 3, 480, "active-child");
  supplementRawEvidence(recentParentEvidence, parentRaw, 5, 720, "parent-mainline");
  const rawSupplementCount = [
    ...recentBranchEvidence,
    ...recentParentEvidence,
  ].filter((item) => item.selectionReason === "raw-recent-turn").length;
  return {
    recentBranchEvidence,
    recentParentEvidence,
    diagnostics: {
      lquSelectedCount:
        recentBranchEvidence.length +
        recentParentEvidence.length -
        rawSupplementCount,
      rawSupplementCount,
      acknowledgementExcludedCount,
      logisticsExcludedCount,
      coveredTurnCount: coveredTurnIds.size,
      branchEvidenceCount: recentBranchEvidence.length,
      parentEvidenceCount: recentParentEvidence.length,
      supersededRecordCount: input.records.length - latestRecords.length,
    },
  };
}

export function selectLatestEffectiveQuestionSourceRecords(
  records: EffectiveQuestionSourceRecord[]
) {
  const latestByRevisionStream = new Map<
    string,
    EffectiveQuestionSourceRecord
  >();
  for (const record of records) {
    const key = effectiveQuestionSourceRevisionStreamKey(record);
    const current = latestByRevisionStream.get(key);
    if (!current || compareEffectiveQuestionSourceRecords(current, record) < 0) {
      latestByRevisionStream.set(key, record);
    }
  }
  return [...latestByRevisionStream.values()]
    .sort(compareEffectiveQuestionSourceRecords)
    .map(cloneRecord);
}

function selectLquEvidence(
  records: EffectiveQuestionSourceRecord[],
  maxCount: number,
  maxChars: number
) {
  const selected: OwnerScopedRelationEvidence[] = [];
  let chars = 0;
  for (const record of [...records].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (selected.length >= maxCount || chars >= maxChars) break;
    const text = record.text.slice(0, Math.max(0, maxChars - chars));
    if (!text) continue;
    selected.unshift({
      sourceId: record.recordId,
      text,
      role: classifyRole(record.text),
      sourceTurnIds: [...record.sourceTurnIds],
      selectionReason: "lqu-projection",
      ownerKind: record.owner.kind,
    });
    chars += text.length;
  }
  return selected;
}

function supplementRawEvidence(
  selected: OwnerScopedRelationEvidence[],
  turns: TranscriptTurn[],
  maxCount: number,
  maxChars: number,
  ownerKind: EffectiveQuestionSourceOwner["kind"]
) {
  let chars = selected.reduce((sum, item) => sum + item.text.length, 0);
  for (const turn of [...turns].sort((a, b) => b.endedAt - a.endedAt)) {
    if (selected.length >= maxCount || chars >= maxChars) break;
    const text = turn.text.trim().slice(0, Math.max(0, maxChars - chars));
    if (!text) continue;
    selected.unshift({
      sourceId: `raw-turn:${turn.id}`,
      text,
      role: classifyRole(text),
      sourceTurnIds: [turn.id],
      selectionReason: "raw-recent-turn",
      ownerKind,
    });
    chars += text.length;
  }
}

function classifyRole(text: string) {
  if (classifyInterviewTransitionTurn(text).detected) {
    return "transition" as const;
  }
  if (hasConstraintOrCorrectionSignal(text)) return "constraint" as const;
  const projection = projectPrimaryAsk({ turnId: "role", text });
  return projection.normalizedPrimaryAsk ? ("question" as const) : undefined;
}

function findEarliestTurnIndex(turns: TranscriptTurn[], ids: Array<string | undefined>) {
  const targets = new Set(ids.filter((id): id is string => Boolean(id)));
  if (!targets.size) return -1;
  return turns.reduce(
    (earliest, turn, index) =>
      targets.has(turn.id) && (earliest < 0 || index < earliest)
        ? index
        : earliest,
    -1
  );
}

function cloneRecord(record: EffectiveQuestionSourceRecord) {
  return {
    ...record,
    sourceTurnIds: [...record.sourceTurnIds],
    correctionIds: record.correctionIds
      ? [...record.correctionIds]
      : undefined,
    effectiveSourceTexts: record.effectiveSourceTexts?.map((source) => ({
      ...source,
    })),
    owner: { ...record.owner },
  } as EffectiveQuestionSourceRecord;
}

function effectiveQuestionSourceRevisionStreamKey(
  record: EffectiveQuestionSourceRecord
) {
  return [
    record.sessionId,
    record.runtimeEpoch,
    record.logicalQuestionUnitId,
  ].join(":");
}

function compareEffectiveQuestionSourceRecords(
  left: EffectiveQuestionSourceRecord,
  right: EffectiveQuestionSourceRecord
) {
  return (
    left.logicalQuestionRevision - right.logicalQuestionRevision ||
    left.settledAt - right.settledAt ||
    left.updatedAt - right.updatedAt ||
    left.recordId.localeCompare(right.recordId)
  );
}
