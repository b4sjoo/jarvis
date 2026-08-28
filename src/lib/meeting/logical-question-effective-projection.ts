import {
  getLogicalQuestionAnswerFocusText,
  getLogicalQuestionSemanticEvidenceText,
  type LogicalQuestionSource,
  type LogicalQuestionUnit,
} from "./logical-question-unit.js";
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
}

export interface AdvisorTranscriptProjection {
  transcript: string;
  latestTurn?: TranscriptTurn;
  replaced: boolean;
  rawChars: number;
  effectiveChars: number;
  correctionIds: string[];
  anchorTurnId?: string;
}

export function projectEffectiveLogicalQuestionSources(
  unit: LogicalQuestionUnit
): EffectiveLogicalQuestionSourceProjection {
  const correctionIds = collectLogicalQuestionCorrectionIds(unit);
  const corrected = correctionIds.length > 0;
  const effectiveText = getLogicalQuestionSemanticEvidenceText(unit).trim();
  const answerFocusText = getLogicalQuestionAnswerFocusText(unit).trim();
  const rawSourceTurnIds = [...unit.sourceTurnIds];

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
  };
}

export function projectAdvisorTranscriptForLogicalQuestion(input: {
  turns: TranscriptTurn[];
  includedTurnIds?: string[];
  logicalQuestionUnit?: LogicalQuestionUnit;
}): AdvisorTranscriptProjection {
  const includedTurnIds = new Set(input.includedTurnIds ?? []);
  const selectedTurns = input.includedTurnIds?.length
    ? input.turns.filter((turn) => includedTurnIds.has(turn.id))
    : [...input.turns];
  const rawTranscript = formatTranscriptTurns(selectedTurns);
  const logicalQuestionUnit = input.logicalQuestionUnit;
  if (!logicalQuestionUnit) {
    return unchangedTranscriptProjection(rawTranscript, selectedTurns);
  }

  const projection = projectEffectiveLogicalQuestionSources(logicalQuestionUnit);
  if (!projection.corrected || !projection.effectiveText) {
    return unchangedTranscriptProjection(rawTranscript, selectedTurns);
  }

  const coveredTurnIds = new Set(logicalQuestionUnit.sourceTurnIds);
  const coveredTurns = selectedTurns.filter((turn) => coveredTurnIds.has(turn.id));
  if (!coveredTurns.length) {
    return unchangedTranscriptProjection(rawTranscript, selectedTurns);
  }
  const anchorTurnId = coveredTurns[coveredTurns.length - 1]?.id;
  const transcript = selectedTurns
    .flatMap((turn) => {
      if (!coveredTurnIds.has(turn.id)) return [formatTranscriptTurn(turn)];
      if (turn.id !== anchorTurnId) return [];
      return [
        `Them: [Corrected LQU ${logicalQuestionUnit.id} revision ${logicalQuestionUnit.revision}] ${projection.effectiveText}`,
      ];
    })
    .join("\n");
  const latestTurn = selectedTurns[selectedTurns.length - 1];

  return {
    transcript,
    latestTurn:
      latestTurn && coveredTurnIds.has(latestTurn.id)
        ? { ...latestTurn, text: projection.answerFocusText }
        : latestTurn
          ? { ...latestTurn }
          : undefined,
    replaced: transcript !== rawTranscript,
    rawChars: rawTranscript.length,
    effectiveChars: transcript.length,
    correctionIds: projection.correctionIds,
    anchorTurnId,
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
  };
}

function formatTranscriptTurns(turns: TranscriptTurn[]) {
  return turns.map(formatTranscriptTurn).join("\n");
}

function formatTranscriptTurn(turn: TranscriptTurn) {
  return `${turn.speaker === "me" ? "Me" : "Them"}: ${turn.text}`;
}
