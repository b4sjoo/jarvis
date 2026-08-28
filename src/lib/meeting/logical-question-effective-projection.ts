import {
  getLogicalQuestionAnswerFocusText,
  getLogicalQuestionSemanticEvidenceText,
  type LogicalQuestionSource,
  type LogicalQuestionUnit,
} from "./logical-question-unit.js";
import { applySpeechCorrectionReplacement } from "./term-correction-projection.js";
import type { TranscriptTurn } from "./types.js";

export interface EffectiveLogicalQuestionSourceProjection {
  sources: LogicalQuestionSource[];
  sourceTurnIds: string[];
  rawSourceTurnIds: string[];
  effectiveText: string;
  answerFocusText: string;
  corrected: boolean;
  correctionIds: string[];
  anchorTurnId?: string;
  effectiveSourceTexts: Array<{ turnId: string; text: string }>;
}

export interface AdvisorTranscriptProjection {
  transcript: string;
  latestTurn?: TranscriptTurn;
  replaced: boolean;
  rawChars: number;
  effectiveChars: number;
  correctionIds: string[];
  anchorTurnId?: string;
  anchorTurnIds: string[];
  projectedLogicalQuestionUnitIds: string[];
  projectedTurnCount: number;
}

export interface EffectiveLogicalQuestionModelRecord {
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionRevision: number;
  sourceTurnIds: string[];
  text: string;
  correctionIds?: string[];
  effectiveSourceTexts?: Array<{ turnId: string; text: string }>;
  updatedAt: number;
  settledAt?: number;
}

export interface EffectiveSourceTurnTextProjection {
  text: string;
  replaced: boolean;
  logicalQuestionUnitId?: string;
  logicalQuestionRevision?: number;
  correctionIds: string[];
}

export function projectEffectiveLogicalQuestionSources(
  unit: LogicalQuestionUnit
): EffectiveLogicalQuestionSourceProjection {
  const correctionIds = collectLogicalQuestionCorrectionIds(unit);
  const corrected = correctionIds.length > 0;
  const effectiveText = getLogicalQuestionSemanticEvidenceText(unit).trim();
  const answerFocusText = getLogicalQuestionAnswerFocusText(unit).trim();
  const rawSourceTurnIds = [...unit.sourceTurnIds];
  const effectiveSourceTexts = unit.sources.map((source) => ({
    turnId: source.turnId,
    text: (unit.termCorrectionOverlays ?? []).reduce(
      (text, overlay) =>
        applySpeechCorrectionReplacement({
          text,
          from: overlay.replacedText ?? overlay.sourceTerm,
          to: overlay.normalizedTerm,
        }),
      source.text
    ),
  }));

  if (!corrected) {
    return {
      sources: unit.sources.map((source) => ({ ...source })),
      sourceTurnIds: [...unit.sourceTurnIds],
      rawSourceTurnIds,
      effectiveText,
      answerFocusText,
      corrected: false,
      correctionIds,
      anchorTurnId: unit.currentTurnId,
      effectiveSourceTexts,
    };
  }

  const anchor =
    [...unit.sources]
      .reverse()
      .find((source) => source.turnId === unit.currentTurnId) ??
    unit.sources[unit.sources.length - 1];
  const anchorTurnId = anchor?.turnId ?? unit.currentTurnId;
  const projectedSource: LogicalQuestionSource = {
    turnId: anchorTurnId,
    text: effectiveText || unit.normalizedText.trim(),
    startedAt: unit.startedAt,
    endedAt: unit.updatedAt,
  };

  return {
    sources: projectedSource.text ? [projectedSource] : [],
    sourceTurnIds: projectedSource.text ? [anchorTurnId] : [],
    rawSourceTurnIds,
    effectiveText,
    answerFocusText,
    corrected: true,
    correctionIds,
    anchorTurnId,
    effectiveSourceTexts,
  };
}

export function projectAdvisorTranscriptForLogicalQuestion(input: {
  turns: TranscriptTurn[];
  includedTurnIds?: string[];
  logicalQuestionUnit?: LogicalQuestionUnit;
  effectiveRecords?: EffectiveLogicalQuestionModelRecord[];
  sessionId?: string;
  runtimeEpoch?: number;
}): AdvisorTranscriptProjection {
  const includedTurnIds = new Set(input.includedTurnIds ?? []);
  const selectedTurns = input.includedTurnIds?.length
    ? input.turns.filter((turn) => includedTurnIds.has(turn.id))
    : [...input.turns];
  const rawTranscript = formatTranscriptTurns(selectedTurns);
  const projections = selectLatestModelContextProjections(input).filter(
    (projection) =>
      projection.correctionIds.length > 0 && projection.effectiveText
  );
  if (!projections.length) {
    return unchangedTranscriptProjection(rawTranscript, selectedTurns);
  }

  const selectedThemTurnIds = new Set(
    selectedTurns
      .filter((turn) => turn.speaker === "them")
      .map((turn) => turn.id)
  );
  const projectionByTurnId = new Map<string, ModelContextProjection>();
  for (const projection of [...projections].sort(compareProjectionOwnership)) {
    for (const turnId of projection.sourceTurnIds) {
      if (selectedThemTurnIds.has(turnId)) {
        projectionByTurnId.set(turnId, projection);
      }
    }
  }
  if (!projectionByTurnId.size) {
    return unchangedTranscriptProjection(rawTranscript, selectedTurns);
  }

  const anchorTurnIdByProjection = new Map<string, string>();
  for (const turn of selectedTurns) {
    const projection = projectionByTurnId.get(turn.id);
    if (projection) {
      anchorTurnIdByProjection.set(projection.streamKey, turn.id);
    }
  }
  const projectedLogicalQuestionUnitIds: string[] = [];
  const projectedCorrectionIds: string[] = [];
  const anchorTurnIds: string[] = [];
  const transcript = selectedTurns
    .flatMap((turn) => {
      const projection = projectionByTurnId.get(turn.id);
      if (!projection) return [formatTranscriptTurn(turn)];
      if (turn.id !== anchorTurnIdByProjection.get(projection.streamKey)) {
        return [];
      }
      projectedLogicalQuestionUnitIds.push(projection.logicalQuestionUnitId);
      projectedCorrectionIds.push(...projection.correctionIds);
      anchorTurnIds.push(turn.id);
      return [
        `Them: [Corrected LQU ${projection.logicalQuestionUnitId} revision ${projection.logicalQuestionRevision}] ${projection.effectiveText}`,
      ];
    })
    .join("\n");
  const latestTurn = selectedTurns[selectedTurns.length - 1];
  const latestTurnProjection = latestTurn
    ? projectionByTurnId.get(latestTurn.id)
    : undefined;

  return {
    transcript,
    latestTurn: latestTurnProjection
      ? { ...latestTurn, text: latestTurnProjection.answerFocusText }
        : latestTurn
          ? { ...latestTurn }
          : undefined,
    replaced: transcript !== rawTranscript,
    rawChars: rawTranscript.length,
    effectiveChars: transcript.length,
    correctionIds: uniqueStrings(projectedCorrectionIds),
    anchorTurnId: anchorTurnIds[anchorTurnIds.length - 1],
    anchorTurnIds,
    projectedLogicalQuestionUnitIds: uniqueStrings(
      projectedLogicalQuestionUnitIds
    ),
    projectedTurnCount: projectionByTurnId.size,
  };
}

export function projectEffectiveTextForSourceTurn(input: {
  turnId: string;
  text: string;
  effectiveRecords?: EffectiveLogicalQuestionModelRecord[];
  logicalQuestionUnit?: LogicalQuestionUnit;
  sessionId: string;
  runtimeEpoch: number;
}): EffectiveSourceTurnTextProjection {
  const projection = selectLatestModelContextProjections(input)
    .filter(
      (candidate) =>
        candidate.correctionIds.length > 0 &&
        candidate.effectiveText &&
        candidate.sourceTurnIds.includes(input.turnId)
    )
    .sort(compareProjectionOwnership)
    .at(-1);
  if (!projection) {
    return {
      text: input.text,
      replaced: false,
      correctionIds: [],
    };
  }
  const sourceText = projection.effectiveSourceTexts.find(
    (source) => source.turnId === input.turnId
  )?.text;
  const effectiveText =
    sourceText ??
    (projection.sourceTurnIds.length === 1
      ? projection.effectiveText
      : input.text);
  return {
    text: effectiveText,
    replaced: effectiveText !== input.text,
    logicalQuestionUnitId: projection.logicalQuestionUnitId,
    logicalQuestionRevision: projection.logicalQuestionRevision,
    correctionIds: [...projection.correctionIds],
  };
}

export function collectLogicalQuestionCorrectionIds(unit: LogicalQuestionUnit) {
  return Array.from(
    new Set(
      [
        ...(unit.termCorrectionOverlays ?? []).map(
          (overlay) => overlay.correctionId
        ),
        ...unit.sources.flatMap(
          (source) => source.appliedSpeechCorrectionIds ?? []
        ),
      ]
        .map((correctionId) => correctionId.trim())
        .filter(Boolean)
    )
  );
}

function unchangedTranscriptProjection(
  transcript: string,
  turns: TranscriptTurn[]
): AdvisorTranscriptProjection {
  const latestTurn = turns[turns.length - 1];
  return {
    transcript,
    latestTurn: latestTurn ? { ...latestTurn } : undefined,
    replaced: false,
    rawChars: transcript.length,
    effectiveChars: transcript.length,
    correctionIds: [],
    anchorTurnIds: [],
    projectedLogicalQuestionUnitIds: [],
    projectedTurnCount: 0,
  };
}

interface ModelContextProjection {
  streamKey: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionRevision: number;
  sourceTurnIds: string[];
  effectiveText: string;
  answerFocusText: string;
  correctionIds: string[];
  effectiveSourceTexts: Array<{ turnId: string; text: string }>;
  updatedAt: number;
  settledAt: number;
  inFlight: boolean;
}

function selectLatestModelContextProjections(input: {
  effectiveRecords?: EffectiveLogicalQuestionModelRecord[];
  logicalQuestionUnit?: LogicalQuestionUnit;
  sessionId?: string;
  runtimeEpoch?: number;
}) {
  const sessionId = input.sessionId ?? input.logicalQuestionUnit?.sessionId;
  const runtimeEpoch =
    input.runtimeEpoch ?? input.logicalQuestionUnit?.runtimeEpoch;
  const candidates: ModelContextProjection[] = (input.effectiveRecords ?? [])
    .filter(
      (record) =>
        (!sessionId || record.sessionId === sessionId) &&
        (runtimeEpoch === undefined || record.runtimeEpoch === runtimeEpoch)
    )
    .map((record) => ({
      streamKey: modelContextRevisionStreamKey(record),
      sessionId: record.sessionId,
      runtimeEpoch: record.runtimeEpoch,
      logicalQuestionUnitId: record.logicalQuestionUnitId,
      logicalQuestionRevision: record.logicalQuestionRevision,
      sourceTurnIds: [...record.sourceTurnIds],
      effectiveText: record.text.trim(),
      answerFocusText: record.text.trim(),
      correctionIds: uniqueStrings(record.correctionIds ?? []),
      effectiveSourceTexts: (record.effectiveSourceTexts ?? []).map(
        (source) => ({ ...source })
      ),
      updatedAt: record.updatedAt,
      settledAt: record.settledAt ?? record.updatedAt,
      inFlight: false,
    }));
  const logicalQuestionUnit = input.logicalQuestionUnit;
  if (
    logicalQuestionUnit &&
    (!sessionId || logicalQuestionUnit.sessionId === sessionId) &&
    (runtimeEpoch === undefined ||
      logicalQuestionUnit.runtimeEpoch === runtimeEpoch)
  ) {
    const projection = projectEffectiveLogicalQuestionSources(
      logicalQuestionUnit
    );
    candidates.push({
      streamKey: modelContextRevisionStreamKey({
        sessionId: logicalQuestionUnit.sessionId,
        runtimeEpoch: logicalQuestionUnit.runtimeEpoch,
        logicalQuestionUnitId: logicalQuestionUnit.id,
      }),
      sessionId: logicalQuestionUnit.sessionId,
      runtimeEpoch: logicalQuestionUnit.runtimeEpoch,
      logicalQuestionUnitId: logicalQuestionUnit.id,
      logicalQuestionRevision: logicalQuestionUnit.revision,
      sourceTurnIds: [...logicalQuestionUnit.sourceTurnIds],
      effectiveText: projection.effectiveText,
      answerFocusText: projection.answerFocusText,
      correctionIds: [...projection.correctionIds],
      effectiveSourceTexts: projection.effectiveSourceTexts.map((source) => ({
        ...source,
      })),
      updatedAt: logicalQuestionUnit.updatedAt,
      settledAt: logicalQuestionUnit.updatedAt,
      inFlight: true,
    });
  }

  const latestByStream = new Map<string, ModelContextProjection>();
  for (const candidate of candidates) {
    const current = latestByStream.get(candidate.streamKey);
    if (!current || compareModelContextRevision(current, candidate) < 0) {
      latestByStream.set(candidate.streamKey, candidate);
    }
  }
  return [...latestByStream.values()];
}

function modelContextRevisionStreamKey(input: {
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
}) {
  return [
    input.sessionId,
    input.runtimeEpoch,
    input.logicalQuestionUnitId,
  ].join(":");
}

function compareModelContextRevision(
  left: ModelContextProjection,
  right: ModelContextProjection
) {
  return (
    left.logicalQuestionRevision - right.logicalQuestionRevision ||
    Number(left.inFlight) - Number(right.inFlight) ||
    left.settledAt - right.settledAt ||
    left.updatedAt - right.updatedAt ||
    left.streamKey.localeCompare(right.streamKey)
  );
}

function compareProjectionOwnership(
  left: ModelContextProjection,
  right: ModelContextProjection
) {
  return (
    left.updatedAt - right.updatedAt ||
    left.logicalQuestionRevision - right.logicalQuestionRevision ||
    left.streamKey.localeCompare(right.streamKey)
  );
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function formatTranscriptTurns(turns: TranscriptTurn[]) {
  return turns.map(formatTranscriptTurn).join("\n");
}

function formatTranscriptTurn(turn: TranscriptTurn) {
  return `${turn.speaker === "me" ? "Me" : "Them"}: ${turn.text}`;
}
