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

export interface EffectiveSourceTurnGroupProjection<
  TSource extends { turnId: string; text: string },
> {
  sources: TSource[];
  replaced: boolean;
  replacedTurnIds: string[];
  correctionIds: string[];
  logicalQuestionUnitIds: string[];
  logicalQuestionRevisions: number[];
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
  meTurnLabel?: "Me" | "Me (clarification)";
}): AdvisorTranscriptProjection {
  const includedTurnIds = new Set(input.includedTurnIds ?? []);
  const selectedTurns = input.includedTurnIds !== undefined
    ? input.turns.filter((turn) => includedTurnIds.has(turn.id))
    : input.turns;
  const rawChars = selectedTurns.reduce(
    (chars, turn, index) =>
      chars +
      transcriptTurnPrefix(turn, input.meTurnLabel).length +
      turn.text.length +
      Number(index > 0),
    0
  );
  const projections = selectLatestModelContextProjections(input).filter(
    (projection) =>
      projection.correctionIds.length > 0 && projection.effectiveText
  );
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
  const anchorTurnIdByProjection = new Map<string, string>();
  const selectedTextByProjection = new Map<string, string[]>();
  for (const turn of selectedTurns) {
    const projection = projectionByTurnId.get(turn.id);
    if (projection) {
      anchorTurnIdByProjection.set(projection.streamKey, turn.id);
      const texts = selectedTextByProjection.get(projection.streamKey) ?? [];
      texts.push(
        projection.effectiveSourceTexts.find(
          (source) => source.turnId === turn.id
        )?.text ?? turn.text
      );
      selectedTextByProjection.set(projection.streamKey, texts);
    }
  }
  const fullySelected = (projection: ModelContextProjection) =>
    projection.sourceTurnIds.every(
      (turnId) => projectionByTurnId.get(turnId) === projection
    );
  const selectedProjectionText = (projection: ModelContextProjection) =>
    fullySelected(projection)
      ? projection.effectiveText
      : (selectedTextByProjection.get(projection.streamKey) ?? []).join(" ");
  const projectedLogicalQuestionUnitIds: string[] = [];
  const projectedCorrectionIds: string[] = [];
  const anchorTurnIds: string[] = [];
  const transcript = selectedTurns
    .flatMap((turn) => {
      const projection = projectionByTurnId.get(turn.id);
      if (!projection) return [formatTranscriptTurn(turn, input.meTurnLabel)];
      if (turn.id !== anchorTurnIdByProjection.get(projection.streamKey)) {
        return [];
      }
      projectedLogicalQuestionUnitIds.push(projection.logicalQuestionUnitId);
      projectedCorrectionIds.push(...projection.correctionIds);
      anchorTurnIds.push(turn.id);
      return [
        `Them: [Corrected LQU ${projection.logicalQuestionUnitId} revision ${projection.logicalQuestionRevision}] ${selectedProjectionText(projection)}`,
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
      ? {
          ...latestTurn,
          text: fullySelected(latestTurnProjection)
            ? latestTurnProjection.answerFocusText
            : selectedProjectionText(latestTurnProjection),
        }
        : latestTurn
          ? { ...latestTurn }
          : undefined,
    replaced: projectionByTurnId.size > 0,
    rawChars,
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
  return projectSelectedSourceTurn(
    input.text,
    indexEffectiveSourceTurnProjections(input, new Set([input.turnId])).get(
      input.turnId
    )
  );
}

function projectSelectedSourceTurn(
  text: string,
  selected: { projection: ModelContextProjection; sourceText?: string } | undefined
): EffectiveSourceTurnTextProjection {
  if (!selected) {
    return {
      text,
      replaced: false,
      correctionIds: [],
    };
  }
  const { projection, sourceText } = selected;
  const effectiveText =
    sourceText ??
    (projection.sourceTurnIds.length === 1
      ? projection.effectiveText
      : text);
  return {
    text: effectiveText,
    replaced: effectiveText !== text,
    logicalQuestionUnitId: projection.logicalQuestionUnitId,
    logicalQuestionRevision: projection.logicalQuestionRevision,
    correctionIds: [...projection.correctionIds],
  };
}

export function projectEffectiveSourceTurnGroup<
  TSource extends { turnId: string; text: string },
>(input: {
  sources: readonly TSource[];
  effectiveRecords?: EffectiveLogicalQuestionModelRecord[];
  logicalQuestionUnit?: LogicalQuestionUnit;
  // Only reuse the projection of this unit from the same synchronous read.
  logicalQuestionProjection?: EffectiveLogicalQuestionSourceProjection;
  sessionId: string;
  runtimeEpoch: number;
}): EffectiveSourceTurnGroupProjection<TSource> {
  const projectionByTurnId = indexEffectiveSourceTurnProjections(
    input,
    new Set(input.sources.map((source) => source.turnId))
  );
  const projections = input.sources.map((source) => ({
    source,
    projection: projectSelectedSourceTurn(
      source.text,
      projectionByTurnId.get(source.turnId)
    ),
  }));
  return {
    sources: projections.map(({ source, projection }) => ({
      ...source,
      text: projection.text,
    })),
    replaced: projections.some(({ projection }) => projection.replaced),
    replacedTurnIds: projections
      .filter(({ projection }) => projection.replaced)
      .map(({ source }) => source.turnId),
    correctionIds: uniqueStrings(
      projections.flatMap(({ projection }) => projection.correctionIds)
    ),
    logicalQuestionUnitIds: uniqueStrings(
      projections
        .map(({ projection }) => projection.logicalQuestionUnitId)
        .filter((value): value is string => Boolean(value))
    ),
    logicalQuestionRevisions: Array.from(
      new Set(
        projections
          .map(({ projection }) => projection.logicalQuestionRevision)
          .filter((value): value is number => typeof value === "number")
      )
    ).sort((left, right) => left - right),
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

function indexEffectiveSourceTurnProjections(
  input: Parameters<typeof selectLatestModelContextProjections>[0],
  selectedTurnIds: Set<string>
) {
  const byTurnId = new Map<
    string,
    { projection: ModelContextProjection; sourceText?: string }
  >();
  if (selectedTurnIds.size === 0) return byTurnId;
  const projections = selectLatestModelContextProjections(input)
    .filter(
      (candidate) =>
        candidate.correctionIds.length > 0 &&
        candidate.effectiveText &&
        candidate.sourceTurnIds.some((turnId) => selectedTurnIds.has(turnId))
    )
    .sort(compareProjectionOwnership);
  for (const projection of projections) {
    const sourceTexts = new Map<string, string>();
    for (const source of projection.effectiveSourceTexts) {
      if (selectedTurnIds.has(source.turnId) && !sourceTexts.has(source.turnId)) {
        sourceTexts.set(source.turnId, source.text);
      }
    }
    for (const turnId of projection.sourceTurnIds) {
      if (selectedTurnIds.has(turnId)) {
        byTurnId.set(turnId, { projection, sourceText: sourceTexts.get(turnId) });
      }
    }
  }
  return byTurnId;
}

function selectLatestModelContextProjections(input: {
  effectiveRecords?: EffectiveLogicalQuestionModelRecord[];
  logicalQuestionUnit?: LogicalQuestionUnit;
  logicalQuestionProjection?: EffectiveLogicalQuestionSourceProjection;
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
        (runtimeEpoch === undefined || record.runtimeEpoch <= runtimeEpoch)
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
      logicalQuestionUnit.runtimeEpoch <= runtimeEpoch)
  ) {
    const projection =
      input.logicalQuestionProjection ??
      projectEffectiveLogicalQuestionSources(logicalQuestionUnit);
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

function formatTranscriptTurn(turn: TranscriptTurn, meTurnLabel = "Me") {
  return `${transcriptTurnPrefix(turn, meTurnLabel)}${turn.text}`;
}

function transcriptTurnPrefix(turn: TranscriptTurn, meTurnLabel = "Me") {
  return turn.speaker === "me" ? `${meTurnLabel}: ` : "Them: ";
}
