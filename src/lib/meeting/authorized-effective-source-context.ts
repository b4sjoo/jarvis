import type { ActiveMeetingTask } from "./active-meeting-task.js";
import type {
  EffectiveQuestionSourceOwner,
  EffectiveQuestionSourceRecord,
} from "./effective-question-source-ledger.js";
import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import {
  projectEffectiveLogicalQuestionSources,
  type AdvisorTranscriptProjection,
  type EffectiveLogicalQuestionSourceProjection,
} from "./logical-question-effective-projection.js";
import type { TranscriptTurn } from "./types.js";

export interface AuthorizedEffectiveSourceRecordIndex {
  byLogicalQuestionUnitId: ReadonlyMap<string, EffectiveQuestionSourceRecord>;
  bySourceTurnId: ReadonlyMap<string, EffectiveQuestionSourceRecord>;
  latestByLogicalQuestionUnitId: ReadonlyMap<string, EffectiveQuestionSourceRecord>;
  knownSourceTurnIds: ReadonlySet<string>;
  rejectedSourceTurnIds: ReadonlySet<string>;
  originSourceTurnIds: ReadonlySet<string>;
  currentLogicalQuestionUnit?: LogicalQuestionUnit;
  currentProjection?: EffectiveLogicalQuestionSourceProjection;
}

export function indexAuthorizedEffectiveSourceRecords(input: {
  effectiveRecords?: readonly EffectiveQuestionSourceRecord[];
  sessionId: string;
  runtimeEpoch: number;
  activeMeetingTask?: ActiveMeetingTask;
  logicalQuestionUnit?: LogicalQuestionUnit;
}): AuthorizedEffectiveSourceRecordIndex {
  const latestByLogicalQuestionUnitId = new Map<string, EffectiveQuestionSourceRecord>();
  const knownSourceTurnIds = new Set<string>();
  for (const record of input.effectiveRecords ?? []) {
    for (const id of recordSourceIds(record)) knownSourceTurnIds.add(id);
    if (record.sessionId !== input.sessionId || record.runtimeEpoch !== input.runtimeEpoch) continue;
    const previous = latestByLogicalQuestionUnitId.get(record.logicalQuestionUnitId);
    if (!previous || compareRevision(previous, record) < 0) {
      latestByLogicalQuestionUnitId.set(record.logicalQuestionUnitId, record);
    }
  }
  const byLogicalQuestionUnitId = new Map<string, EffectiveQuestionSourceRecord>();
  const bySourceTurnId = new Map<string, EffectiveQuestionSourceRecord>();
  // Resolve competing source claims before owner filtering too: rejected winners
  // must not reveal an older stream or its raw text through the same source ID.
  const winningClaimBySourceId = new Map<string, EffectiveQuestionSourceRecord>();
  for (const record of [...latestByLogicalQuestionUnitId.values()].sort(compareSourceClaim)) {
    for (const id of recordSourceIds(record)) winningClaimBySourceId.set(id, record);
    const task = input.activeMeetingTask;
    if (task && record.owner.parentId === task.parent.id &&
        (record.owner.kind === "parent-mainline" || record.owner.childId === task.child?.id)) {
      byLogicalQuestionUnitId.set(record.logicalQuestionUnitId, record);
    }
  }
  for (const [id, record] of winningClaimBySourceId) {
    if (byLogicalQuestionUnitId.get(record.logicalQuestionUnitId) === record) bySourceTurnId.set(id, record);
  }
  const index: AuthorizedEffectiveSourceRecordIndex = {
    byLogicalQuestionUnitId, bySourceTurnId, latestByLogicalQuestionUnitId, knownSourceTurnIds,
    rejectedSourceTurnIds: new Set([...knownSourceTurnIds].filter((id) => !bySourceTurnId.has(id))),
    originSourceTurnIds: new Set([
      ...(input.activeMeetingTask?.parent.canonicalQuestionSourceTurnIds ?? []),
      ...(input.activeMeetingTask?.child?.basedOnTurnIds ?? []),
    ]),
  };
  const currentLogicalQuestionUnit = selectCurrentUnit(input, index);
  return {
    ...index,
    currentLogicalQuestionUnit,
    currentProjection: currentLogicalQuestionUnit && projectEffectiveLogicalQuestionSources(currentLogicalQuestionUnit),
  };
}

export interface AuthorizedEffectiveSourceContext {
  transcriptProjection: AdvisorTranscriptProjection;
  selectedSourceTurnIds: string[];
  missingSourceTurnIds: string[];
  rejectedSourceTurnIds: string[];
  // Authorized per-source spans only; never a whole-LQU substitute for a span.
  effectiveSourceTexts: Array<{ turnId: string; text: string }>;
}

export function readAuthorizedEffectiveSourceText(input: {
  recordIndex: AuthorizedEffectiveSourceRecordIndex;
  logicalQuestionUnitId?: string;
  sourceTurnIds: readonly string[];
  selectedSourceTurnIds?: readonly string[];
  sourceObservationIds?: readonly string[];
  owner: EffectiveQuestionSourceOwner;
  logicalQuestionUnit?: LogicalQuestionUnit;
  sessionId: string;
  runtimeEpoch: number;
}): { text: string | undefined; sourceTurnIds: string[]; missingSourceTurnIds: string[]; rejectedSourceTurnIds: string[] } {
  const index = input.recordIndex;
  const current = selectCurrentUnit(input, index);
  const matchesOrigin = (unitId: string, turnIds: readonly string[], observationIds: readonly string[] = []) =>
    input.logicalQuestionUnitId ? unitId === input.logicalQuestionUnitId :
      input.sourceTurnIds.length > 0 ? sameIds(turnIds, input.sourceTurnIds) :
        Boolean(input.sourceObservationIds?.length && sameIds(observationIds, input.sourceObservationIds));
  const latestCurrent = current && index.latestByLogicalQuestionUnitId.get(current.id);
  const currentMatches = current && matchesOrigin(current.id, currentSourceIds(current)) &&
    (!latestCurrent || ownerMatches(latestCurrent.owner, input.owner)) &&
    currentSourceIds(current).every((id) => !index.knownSourceTurnIds.has(id) ||
      index.bySourceTurnId.get(id)?.logicalQuestionUnitId === current.id);
  const record = input.logicalQuestionUnitId
    ? index.byLogicalQuestionUnitId.get(input.logicalQuestionUnitId)
    : [...index.byLogicalQuestionUnitId.values()].find((record) =>
        matchesOrigin(record.logicalQuestionUnitId, record.sourceTurnIds, record.sourceObservationIds) &&
        ownerMatches(record.owner, input.owner));
  const authorized = record && ownerMatches(record.owner, input.owner) ? record : undefined;
  const projection = currentMatches ? currentProjectionForIndex(current, index) : undefined;
  const originIds = projection ? currentSourceIds(current!) : authorized ? recordSourceIds(authorized) : [];
  const ids = projection ? originIds : originIds.filter((id) => index.bySourceTurnId.get(id) === authorized);
  const requestedIds = input.sourceTurnIds.length ? [...new Set(input.sourceTurnIds)] : originIds;
  const selectedIds = input.selectedSourceTurnIds === undefined ? requestedIds
    : requestedIds.filter((id) => input.selectedSourceTurnIds!.includes(id));
  const spans = projection?.effectiveSourceTexts ?? authorized?.effectiveSourceTexts ?? [];
  const fullText = projection?.effectiveText ?? authorized?.text;
  const fullySelected = originIds.length > 0 && selectedIds.length > 0 &&
    originIds.every((id) => selectedIds.includes(id) && ids.includes(id));
  const text = fullText && fullySelected ? fullText : selectedIds
    .map((id) => ids.includes(id) ? spans.find((source) => source.turnId === id)?.text : undefined)
    .filter((value): value is string => Boolean(value)).join(" ") || undefined;
  return {
    text,
    sourceTurnIds: selectedIds.filter((id) => ids.includes(id)),
    missingSourceTurnIds: selectedIds.filter((id) =>
      (!ids.includes(id) && !index.knownSourceTurnIds.has(id)) ||
      (ids.includes(id) && !fullySelected && !spans.some((source) => source.turnId === id))),
    rejectedSourceTurnIds: selectedIds.filter((id) => !ids.includes(id) && index.knownSourceTurnIds.has(id)),
  };
}

interface SourceText {
  id: string;
  text?: string;
  startedAt: number;
  rawTurn?: TranscriptTurn;
  record?: EffectiveQuestionSourceRecord;
  current?: boolean;
  screen: boolean;
}

export function resolveAuthorizedEffectiveSourceContext(input: {
  selectedSourceTurnIds: readonly string[];
  transcriptTurns: readonly TranscriptTurn[];
  effectiveRecords?: readonly EffectiveQuestionSourceRecord[];
  sessionId: string;
  runtimeEpoch: number;
  activeMeetingTask?: ActiveMeetingTask;
  logicalQuestionUnit?: LogicalQuestionUnit;
  meTurnLabel?: "Me" | "Me (clarification)";
  // Reuse only within the same fixed, synchronous context construction.
  recordIndex?: AuthorizedEffectiveSourceRecordIndex;
}): AuthorizedEffectiveSourceContext {
  const index = input.recordIndex ?? indexAuthorizedEffectiveSourceRecords(input);
  const selectedIds = [...new Set(input.selectedSourceTurnIds)];
  const rawById = new Map(input.transcriptTurns.map((turn) => [turn.id, turn]));
  const current = selectCurrentUnit(input, index);
  const currentProjection = current && currentProjectionForIndex(current, index);
  const currentIds = new Set(current ? currentSourceIds(current) : []);
  const missingSourceTurnIds: string[] = [];
  const rejectedSourceTurnIds: string[] = [];
  const sources: SourceText[] = [];
  const rawOrder = new Map(input.transcriptTurns.map((turn, order) => [turn.id, order]));
  for (const id of selectedIds) {
    const rawTurn = rawById.get(id);
    if (rawTurn?.contextPromptEligible === false) {
      rejectedSourceTurnIds.push(id);
      continue;
    }
    if (current && currentProjection && currentIds.has(id)) {
      const source = current.sources.find((source) => source.turnId === id);
      sources.push({ id, rawTurn, current: true, screen: id.startsWith("screen:"),
        startedAt: source?.startedAt ?? current.startedAt,
        text: currentProjection.effectiveSourceTexts.find((source) => source.turnId === id)?.text ??
          (currentIds.size === 1 ? currentProjection.effectiveText : undefined) });
      continue;
    }
    const record = index.bySourceTurnId.get(id);
    if (record) {
      sources.push({ id, rawTurn, record, screen: record.sourceKind === "screen" || id.startsWith("screen:"),
        startedAt: rawTurn?.startedAt ?? record.startedAt,
        text: record.effectiveSourceTexts?.find((source) => source.turnId === id)?.text ??
          (recordSourceIds(record).length === 1 ? record.text : undefined) });
    } else if (index.knownSourceTurnIds.has(id)) {
      rejectedSourceTurnIds.push(id);
    } else if (index.originSourceTurnIds.has(id)) {
      missingSourceTurnIds.push(id);
    } else if (rawTurn) {
      sources.push({ id, rawTurn, text: rawTurn.text, startedAt: rawTurn.startedAt, screen: false });
    } else {
      missingSourceTurnIds.push(id);
    }
  }
  // updatedAt is correction time, never input order. Stable ties retain the
  // consumer's selected order; source order inside a multi-turn LQU is canonical.
  sources.sort((left, right) => {
    if (left.record && left.record === right.record) {
      return recordSourceIds(left.record).indexOf(left.id) - recordSourceIds(right.record).indexOf(right.id);
    }
    return left.startedAt - right.startedAt ||
      (rawOrder.has(left.id) && rawOrder.has(right.id) ? rawOrder.get(left.id)! - rawOrder.get(right.id)! : 0);
  });
  const byId = new Map(sources.map((source) => [source.id, source]));
  const consumed = new Set<string>();
  const corrections = new Set<string>();
  const lquIds = new Set<string>();
  const anchors: string[] = [];
  const lines: string[] = [];
  const renderedTextById = new Map<string, string>();
  let projectedTurnCount = 0;
  for (let sourcePosition = 0; sourcePosition < sources.length; sourcePosition += 1) {
    const source = sources[sourcePosition];
    if (consumed.has(source.id)) continue;
    const record = source.record;
    const ids = source.current ? [...currentIds] : record ? recordSourceIds(record) : [source.id];
    const fullySelected = ids.every((id) => {
      const member = byId.get(id);
      return member && (source.current ? member.current : member.record === record);
    });
    const correctionIds = source.current ? currentProjection!.correctionIds : record?.correctionIds ?? [];
    const groupText = source.current ? currentProjection!.effectiveText : record?.text;
    // Whole-LQU text is safe only when all its sources are selected. A partial
    // source with no retained span is missing, never an excuse to read raw text.
    const contiguous = ids.every((id, offset) => sources[sourcePosition + offset]?.id === id);
    const sameModality = ids.every((id) => byId.get(id)?.screen === source.screen);
    const grouped = Boolean(fullySelected && contiguous && sameModality && groupText);
    const text = grouped ? groupText : source.text;
    if (!text?.trim()) {
      missingSourceTurnIds.push(source.id);
      continue;
    }
    const renderedIds = grouped ? ids : [source.id];
    for (const id of renderedIds) {
      consumed.add(id);
      renderedTextById.set(id, text);
    }
    const lquId = source.current ? current!.id : record?.logicalQuestionUnitId;
    const revision = source.current ? current!.revision : record?.logicalQuestionRevision;
    const label = source.screen ? "Screen" : source.rawTurn?.speaker === "me" ? input.meTurnLabel ?? "Me" : "Them";
    const marker = correctionIds.length && lquId ? `[Corrected LQU ${lquId} revision ${revision}] ` : "";
    lines.push(`${label}: ${marker}${text}`);
    if (marker) {
      correctionIds.forEach((id) => corrections.add(id));
      lquIds.add(lquId!);
      anchors.push(renderedIds[renderedIds.length - 1]);
      projectedTurnCount += renderedIds.length;
    }
  }
  const transcript = lines.join("\n");
  const selectedSourceTurnIds = sources.filter((source) => consumed.has(source.id)).map((source) => source.id);
  const latestRaw = input.transcriptTurns.filter((turn) => consumed.has(turn.id)).at(-1);
  const latestText = latestRaw && current && currentProjection && latestRaw.id === current.currentTurnId &&
    [...currentIds].every((id) => consumed.has(id)) ? currentProjection.answerFocusText :
    latestRaw && renderedTextById.get(latestRaw.id);
  const rawText = input.transcriptTurns.filter((turn) => selectedIds.includes(turn.id))
    .map((turn) => `${turn.speaker === "me" ? input.meTurnLabel ?? "Me" : "Them"}: ${turn.text}`).join("\n");
  return {
    selectedSourceTurnIds, missingSourceTurnIds, rejectedSourceTurnIds,
    effectiveSourceTexts: sources.flatMap((source) => consumed.has(source.id) && source.text?.trim()
      ? [{ turnId: source.id, text: source.text }] : []),
    transcriptProjection: {
      transcript,
      latestTurn: latestRaw ? { ...latestRaw, text: latestText ?? latestRaw.text } : undefined,
      replaced: projectedTurnCount > 0, rawChars: rawText.length, effectiveChars: transcript.length,
      correctionIds: [...corrections], anchorTurnId: anchors.at(-1), anchorTurnIds: anchors,
      projectedLogicalQuestionUnitIds: [...lquIds], projectedTurnCount,
    },
  };
}

function currentSourceIds(unit: LogicalQuestionUnit) {
  return unit.sourceTurnIds.length ? unit.sourceTurnIds : unit.currentTurnId.startsWith("screen:") ? [unit.currentTurnId] : [];
}

function selectCurrentUnit(input: { logicalQuestionUnit?: LogicalQuestionUnit; sessionId: string; runtimeEpoch: number }, index: AuthorizedEffectiveSourceRecordIndex) {
  const unit = input.logicalQuestionUnit;
  const latest = unit && index.latestByLogicalQuestionUnitId.get(unit.id);
  return unit && unit.sessionId === input.sessionId && unit.runtimeEpoch === input.runtimeEpoch &&
    (!latest || unit.revision >= latest.logicalQuestionRevision) ? unit : undefined;
}

function currentProjectionForIndex(unit: LogicalQuestionUnit, index: AuthorizedEffectiveSourceRecordIndex) {
  return index.currentLogicalQuestionUnit === unit && index.currentProjection
    ? index.currentProjection : projectEffectiveLogicalQuestionSources(unit);
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function ownerMatches(left: EffectiveQuestionSourceOwner, right: EffectiveQuestionSourceOwner) {
  return left.parentId === right.parentId && left.kind === right.kind &&
    (left.kind === "parent-mainline" || right.kind === "active-child" && left.childId === right.childId);
}

function recordSourceIds(record: EffectiveQuestionSourceRecord) {
  return record.sourceTurnIds.length ? record.sourceTurnIds : record.currentTurnId?.startsWith("screen:") ? [record.currentTurnId] : [];
}

function compareRevision(left: EffectiveQuestionSourceRecord, right: EffectiveQuestionSourceRecord) {
  return left.logicalQuestionRevision - right.logicalQuestionRevision || left.settledAt - right.settledAt ||
    left.updatedAt - right.updatedAt || left.recordId.localeCompare(right.recordId);
}

function compareSourceClaim(left: EffectiveQuestionSourceRecord, right: EffectiveQuestionSourceRecord) {
  return left.updatedAt - right.updatedAt || left.logicalQuestionRevision - right.logicalQuestionRevision ||
    left.logicalQuestionUnitId.localeCompare(right.logicalQuestionUnitId);
}
