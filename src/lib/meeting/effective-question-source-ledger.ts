import type { ActiveMeetingTask } from "./meeting-task-contracts.js";

import { isExplicitMeetingLogisticsTranscript } from "./meeting-logistics.js";
import type {
  CurrentQuestionSettlementDecision,
  EffectiveCurrentQuestionSettlement,
} from "./current-question-settlement.js";
import {
  getLogicalQuestionAnswerFocusText,
  getLogicalQuestionSemanticEvidenceText,
  type LogicalQuestionUnit,
} from "./logical-question-unit.js";
import { projectEffectiveLogicalQuestionSources } from "./logical-question-effective-projection.js";
import { projectPrimaryAsk } from "./primary-ask-projection.js";
import { hasConstraintOrCorrectionSignal } from "./transcript-fusion.js";
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
  sourceKind?: CurrentQuestionSettlementDecision["sourceKind"];
  currentTurnId?: string;
  sourceTurnIds: string[];
  sourceObservationIds?: string[];
  contextSourceTurnIds?: string[];
  recentLogicalQuestionSourceTurnIds?: string[];
  correctionIds?: string[];
  effectiveSourceTexts?: Array<{ turnId: string; text: string }>;
  text: string;
  answerFocusText?: string;
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
  sourceObservationIds: string[];
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

export type RevisionStableTopologyRelation = Extract<
  EffectiveCurrentQuestionSettlement["relation"],
  "new-parent" | "followup-parent" | "child-probe" | "resume-parent"
>;

export interface RevisionStableTopologyBinding {
  relation: RevisionStableTopologyRelation;
  owner: EffectiveQuestionSourceOwner;
  source:
    | "active-parent-origin"
    | "active-child-origin"
    | "effective-question-source-ledger";
  boundRevision: number;
}

export function consumeRevisionStableTopologyBinding<
  TSettlement extends CurrentQuestionSettlementDecision,
>(input: {
  settlement: TSettlement;
  binding: RevisionStableTopologyBinding;
  logicalQuestionUnit: LogicalQuestionUnit;
}) {
  const { settlement, binding, logicalQuestionUnit } = input;
  if (
    settlement.sessionId !== logicalQuestionUnit.sessionId ||
    settlement.runtimeEpoch !== logicalQuestionUnit.runtimeEpoch ||
    settlement.logicalQuestionUnitId !== logicalQuestionUnit.id ||
    settlement.revision !== logicalQuestionUnit.revision ||
    binding.boundRevision > logicalQuestionUnit.revision
  ) {
    return {
      settlement,
      consumed: false,
      reason: "settlement-identity-mismatch" as const,
      previousRelation: settlement.relation,
    };
  }
  const previousRelation = settlement.relation;
  if (settlement.relationAuthoritySource === "manual-correction") {
    return { settlement, consumed: false, reason: "explicit-manual-relation-preserved" as const, previousRelation };
  }
  const projected = {
    ...settlement,
    relation: binding.relation,
    orderedRelationProvenance: undefined,
    relationAuthoritySource: "deterministic-fast-path" as const,
    relationMutationAuthorized: true,
    parentMutationAuthorized: false,
    reasons: Array.from(
      new Set([
        ...settlement.reasons,
        `revision-stable-relation:${binding.source}`,
      ])
    ),
    ...(isEffectiveSettlement(settlement)
      ? {
          rawRelation: settlement.rawRelation,
          effectiveParentId: binding.owner.parentId,
          effectiveChildId:
            binding.owner.kind === "active-child"
              ? binding.owner.childId
              : undefined,
        }
      : {}),
  } satisfies CurrentQuestionSettlementDecision;
  return {
    settlement: Object.freeze(projected) as TSettlement,
    consumed: true,
    reason: "revision-stable-relation-consumed" as const,
    previousRelation,
  };
}

function isEffectiveSettlement(
  settlement: CurrentQuestionSettlementDecision
): settlement is EffectiveCurrentQuestionSettlement {
  return (
    "effective" in settlement &&
    settlement.effective === true &&
    "rawRelation" in settlement
  );
}

export class EffectiveQuestionSourceLedger {
  private records: EffectiveQuestionSourceRecord[] = [];
  private retainedParent?: RetainedParentSourceReferences;

  constructor(private readonly maxEntries = 96) {}

  upsert(record: EffectiveQuestionSourceRecord) {
    this.records = this.prepareUpsert(record).nextRecords;
    return cloneRecord(record);
  }

  prepareUpsert(record: EffectiveQuestionSourceRecord) {
    const index = this.records.findIndex(
      (candidate) => candidate.recordId === record.recordId
    );
    const next = [...this.records];
    if (index >= 0) next[index] = cloneRecord(record);
    else next.push(cloneRecord(record));
    return { previousRecords: this.records, nextRecords: this.trimRecords(next) };
  }

  installPreparedUpsert(prepared: ReturnType<EffectiveQuestionSourceLedger["prepareUpsert"]>) {
    if (this.records !== prepared.previousRecords) return false;
    this.records = prepared.nextRecords;
    return true;
  }

  rollbackPreparedUpsert(prepared: ReturnType<EffectiveQuestionSourceLedger["prepareUpsert"]>) {
    if (this.records === prepared.previousRecords) return true;
    if (this.records !== prepared.nextRecords) return false;
    this.records = prepared.previousRecords;
    return true;
  }

  getRetainedParentSourceReferences() {
    return this.retainedParent;
  }

  // Retention changes only reference existing source-owner storage. The original
  // records remain subject to the total entry budget; oversized slots fail closed.
  retainParentSources(input: {
    sessionId: string;
    parentId: string;
    originLogicalQuestionUnitId?: string;
    requiredTurnIds: readonly string[];
    requiredObservationIds: readonly string[];
  }) {
    const records = this.list().filter(record => record.sessionId === input.sessionId &&
      record.owner.parentId === input.parentId && record.owner.kind === "parent-mainline");
    const turns = new Set(records.flatMap(record => record.sourceTurnIds));
    const observations = new Set(records.flatMap(record => record.sourceObservationIds ?? []));
    const budget = Math.min(24, Math.max(0, this.maxEntries - 1));
    if (!records.length || records.length > budget ||
      (!input.originLogicalQuestionUnitId && !input.requiredTurnIds.length && !input.requiredObservationIds.length) ||
      (input.originLogicalQuestionUnitId && !records.some(record => record.logicalQuestionUnitId === input.originLogicalQuestionUnitId)) ||
      input.requiredTurnIds.some(id => !turns.has(id)) || input.requiredObservationIds.some(id => !observations.has(id))) {
      this.retainedParent = undefined;
      return undefined;
    }
    this.retainedParent = Object.freeze({
      sessionId: input.sessionId, parentId: input.parentId,
      sources: Object.freeze(records.map(record => Object.freeze({
        recordId: record.recordId, logicalQuestionUnitId: record.logicalQuestionUnitId,
        logicalQuestionRevision: record.logicalQuestionRevision, sourceHash: record.sourceHash,
      }))),
    });
    return this.retainedParent;
  }

  restoreRetainedParentSourceReferences(expected: RetainedParentSourceReferences | undefined, previous: RetainedParentSourceReferences | undefined) {
    if (this.retainedParent !== expected) return false;
    this.retainedParent = previous;
    return true;
  }

  releaseRetainedParentSources() {
    this.retainedParent = undefined;
  }

  getRetainedParentSourceEvidence(input: {
    sessionId: string;
    runtimeEpoch: number;
    parentId: string;
    availableObservationIds: readonly string[];
  }): RetainedParentSourceEvidence | undefined {
    const retained = this.retainedParent;
    if (retained?.sessionId !== input.sessionId || retained.parentId !== input.parentId) return undefined;
    const records: EffectiveQuestionSourceRecord[] = [];
    for (const reference of retained.sources) {
      const record = this.findLogicalQuestion({ ...input,
        logicalQuestionUnitId: reference.logicalQuestionUnitId, logicalQuestionRevision: reference.logicalQuestionRevision });
      if (!record || record.recordId !== reference.recordId || record.sourceHash !== reference.sourceHash ||
        record.owner.parentId !== input.parentId || record.owner.kind !== "parent-mainline") return undefined;
      records.push(record);
    }
    const observationIds = [...new Set(records.flatMap(record => record.sourceObservationIds ?? []))];
    const available = new Set(input.availableObservationIds);
    return { sessionId: input.sessionId, parentId: input.parentId, records, observationIds,
      missingObservationIds: observationIds.filter(id => !available.has(id)),
      retainedTextBytes: records.reduce((size, record) => size + new TextEncoder().encode(record.text).length, 0),
      retainedRecordBytes: new TextEncoder().encode(JSON.stringify(records)).length };
  }

  prepareOwnerCorrection(input: {
    operationId: string;
    sessionId: string;
    runtimeEpoch: number;
    logicalQuestionUnitId: string;
    logicalQuestionRevision: number;
    sourceHash: string;
    expectedOwner: EffectiveQuestionSourceOwner;
    nextOwner: EffectiveQuestionSourceOwner;
    relation: RevisionStableTopologyRelation;
    restoredParentId?: string;
    availableObservationIds?: readonly string[];
    now?: number;
  }): PreparedEffectiveSourceOwnerCorrection | undefined {
    const source = this.findLogicalQuestion(input);
    if (!source || source.sourceHash !== input.sourceHash || !sameSourceOwner(source.owner, input.expectedOwner)) return undefined;
    if (source.sourceObservationIds?.some(id => !input.availableObservationIds?.includes(id))) return undefined;
    if (input.restoredParentId) {
      const evidence = this.getRetainedParentSourceEvidence({ ...input,
        parentId: input.restoredParentId, availableObservationIds: input.availableObservationIds ?? [] });
      if (!evidence || evidence.missingObservationIds.length || input.nextOwner.parentId !== input.restoredParentId) return undefined;
    }
    const recordId = `${source.recordId}:manual-owner:${input.operationId}`;
    if (this.records.some(record => record.recordId === recordId)) return undefined;
    return {
      previousRecords: this.records,
      previousRetention: this.retainedParent,
      expectedOwner: { ...input.expectedOwner },
      nextRecord: { ...cloneRecord(source), recordId, owner: { ...input.nextOwner }, relation: input.relation,
        settledAt: Math.max(input.now ?? Date.now(), source.settledAt + 1) },
      releaseRetention: !!input.restoredParentId,
    };
  }

  installPreparedOwnerCorrection(prepared: PreparedEffectiveSourceOwnerCorrection) {
    if (prepared.installedRecords || this.records !== prepared.previousRecords || this.retainedParent !== prepared.previousRetention) return false;
    if (prepared.releaseRetention) this.retainedParent = undefined;
    this.records = this.trimRecords([...this.records, cloneRecord(prepared.nextRecord)]);
    prepared.installedRecords = this.records;
    return true;
  }

  rollbackPreparedOwnerCorrection(prepared: PreparedEffectiveSourceOwnerCorrection) {
    if (!prepared.installedRecords) return true;
    if (this.records !== prepared.installedRecords) return false;
    this.records = prepared.previousRecords;
    this.retainedParent = prepared.previousRetention;
    prepared.installedRecords = undefined;
    return true;
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
    // Current execution ceiling; the returned record keeps its source birth epoch.
    runtimeEpoch: number;
    logicalQuestionUnitId: string;
    logicalQuestionRevision: number;
  }) {
    const matchingRecords = this.records.filter(
      (candidate) =>
        candidate.sessionId === input.sessionId &&
        candidate.runtimeEpoch <= input.runtimeEpoch &&
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
    this.records = [];
    this.retainedParent = undefined;
  }

  private trimRecords(records: EffectiveQuestionSourceRecord[]) {
    const retainedIds = new Set(this.retainedParent?.sources.map(source => source.recordId));
    const next = [...records];
    while (next.length > this.maxEntries) {
      const index = next.findIndex(record => !retainedIds.has(record.recordId));
      if (index < 0) break;
      next.splice(index, 1);
    }
    return next;
  }
}

export interface RetainedParentSourceReferences {
  readonly sessionId: string;
  readonly parentId: string;
  readonly sources: readonly Readonly<Pick<EffectiveQuestionSourceRecord,
    "recordId" | "logicalQuestionUnitId" | "logicalQuestionRevision" | "sourceHash">>[];
}

export interface RetainedParentSourceEvidence {
  sessionId: string;
  parentId: string;
  records: EffectiveQuestionSourceRecord[];
  observationIds: string[];
  missingObservationIds: string[];
  retainedTextBytes: number;
  retainedRecordBytes: number;
}

export interface PreparedEffectiveSourceOwnerCorrection {
  previousRecords: EffectiveQuestionSourceRecord[];
  previousRetention?: RetainedParentSourceReferences;
  expectedOwner: EffectiveQuestionSourceOwner;
  nextRecord: EffectiveQuestionSourceRecord;
  releaseRetention: boolean;
  installedRecords?: EffectiveQuestionSourceRecord[];
}

function sameSourceOwner(left: EffectiveQuestionSourceOwner, right: EffectiveQuestionSourceOwner) {
  return left.kind === right.kind && left.parentId === right.parentId &&
    (left.kind === "parent-mainline" || right.kind === "active-child" && left.childId === right.childId);
}

export function resolveRevisionStableTopologyBinding(input: {
  records: EffectiveQuestionSourceRecord[];
  logicalQuestionUnit: LogicalQuestionUnit;
  activeMeetingTask?: ActiveMeetingTask;
}): RevisionStableTopologyBinding | undefined {
  const { logicalQuestionUnit, activeMeetingTask } = input;
  const parent = activeMeetingTask?.parent;
  if (
    input.records.some((record) =>
      record.sessionId === logicalQuestionUnit.sessionId &&
      record.runtimeEpoch === logicalQuestionUnit.runtimeEpoch &&
      record.logicalQuestionUnitId === logicalQuestionUnit.id &&
      record.logicalQuestionRevision > logicalQuestionUnit.revision
    )
  ) return undefined;
  const latestBoundRecord = input.records
    .filter(
      (record) =>
        record.sessionId === logicalQuestionUnit.sessionId &&
        record.runtimeEpoch === logicalQuestionUnit.runtimeEpoch &&
        record.logicalQuestionUnitId === logicalQuestionUnit.id &&
        record.logicalQuestionRevision <= logicalQuestionUnit.revision &&
        isRevisionStableTopologyRelation(record.relation)
    )
    .sort(compareEffectiveQuestionSourceRecords)
    .at(-1);
  if (latestBoundRecord) {
    if (!ownerMatchesActiveTask(latestBoundRecord.owner, activeMeetingTask)) {
      return undefined;
    }
    return {
      relation: latestBoundRecord.relation as RevisionStableTopologyRelation,
      owner: { ...latestBoundRecord.owner },
      source: "effective-question-source-ledger",
      boundRevision: latestBoundRecord.logicalQuestionRevision,
    };
  }

  if (
    parent?.sourceQuestionUnitId === logicalQuestionUnit.id &&
    (parent.sourceQuestionRevision === undefined ||
      logicalQuestionUnit.revision >= parent.sourceQuestionRevision)
  ) {
    return {
      relation: "new-parent",
      owner: { kind: "parent-mainline", parentId: parent.id },
      source: "active-parent-origin",
      boundRevision: parent.sourceQuestionRevision ?? 1,
    };
  }

  const child = activeMeetingTask?.child;
  const sourceTurnIds = new Set(
    logicalQuestionUnit.sources.map((source) => source.turnId)
  );
  if (
    parent &&
    child?.basedOnTurnIds.length &&
    child.basedOnTurnIds.every((turnId) => sourceTurnIds.has(turnId))
  ) {
    return {
      relation: "child-probe",
      owner: {
        kind: "active-child",
        parentId: parent.id,
        childId: child.id,
      },
      source: "active-child-origin",
      boundRevision: logicalQuestionUnit.revision,
    };
  }

  return undefined;
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
  ).trim();
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
    sourceKind: input.settlement.sourceKind,
    currentTurnId: input.logicalQuestionUnit.currentTurnId,
    sourceTurnIds: [...input.logicalQuestionUnit.sourceTurnIds],
    sourceObservationIds: [...input.settlement.sourceObservationIds],
    contextSourceTurnIds: [
      ...(input.logicalQuestionUnit.contextSourceTurnIds ?? []),
    ],
    recentLogicalQuestionSourceTurnIds: [
      ...(input.logicalQuestionUnit.recentLogicalQuestionSourceTurnIds ?? []),
    ],
    correctionIds: [...sourceProjection.correctionIds],
    effectiveSourceTexts: sourceProjection.effectiveSourceTexts.map(
      (source) => ({ ...source })
    ),
    text,
    answerFocusText: getLogicalQuestionAnswerFocusText(
      input.logicalQuestionUnit
    ),
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
      record.runtimeEpoch <= currentLogicalQuestionUnit.runtimeEpoch &&
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
      // Known rejected and superseded sources cannot return as raw supplements.
      ...input.records.flatMap((record) => record.sourceTurnIds),
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
  const parentObservationBoundaryAt = latestObservationBoundary(parentRecords);
  const branchObservationBoundaryAt = latestObservationBoundary(branchRecords);
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
            childBoundaryIndex &&
          turn.endedAt >= branchObservationBoundaryAt
      )
    : [];
  const parentRaw = childId && childBoundaryIndex >= 0
    ? rawCandidates.filter(
        (turn) =>
          input.transcriptTurns.findIndex((item) => item.id === turn.id) <
            childBoundaryIndex &&
          turn.endedAt >= parentObservationBoundaryAt
      )
    : rawCandidates.filter(
        (turn) => turn.endedAt >= parentObservationBoundaryAt
      );

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

function latestObservationBoundary(records: EffectiveQuestionSourceRecord[]) {
  return records
    .filter((record) => (record.sourceObservationIds?.length ?? 0) > 0)
    .reduce(
      (latest, record) => Math.max(latest, record.updatedAt),
      Number.NEGATIVE_INFINITY
    );
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
      sourceObservationIds: [...(record.sourceObservationIds ?? [])],
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
      sourceObservationIds: [],
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
    sourceObservationIds: [...(record.sourceObservationIds ?? [])],
    contextSourceTurnIds: [...(record.contextSourceTurnIds ?? [])],
    recentLogicalQuestionSourceTurnIds: [
      ...(record.recentLogicalQuestionSourceTurnIds ?? []),
    ],
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

function isRevisionStableTopologyRelation(
  relation: EffectiveCurrentQuestionSettlement["relation"]
): relation is RevisionStableTopologyRelation {
  return (
    relation === "new-parent" ||
    relation === "followup-parent" ||
    relation === "child-probe" ||
    relation === "resume-parent"
  );
}

function ownerMatchesActiveTask(
  owner: EffectiveQuestionSourceOwner,
  task: ActiveMeetingTask | undefined
) {
  if (!task || owner.parentId !== task.parent.id) return false;
  return owner.kind === "parent-mainline"
    ? true
    : owner.childId === task.child?.id;
}
