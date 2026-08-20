import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import type { ManualScreenSourcePacket } from "./screen-task-scope.js";
import type { TranscriptTurn } from "./types.js";

export function buildManualScreenLogicalQuestionUnit(input: {
  packet: ManualScreenSourcePacket;
  sessionId: string;
  runtimeEpoch: number;
  createdAt: number;
  transcriptTurns?: TranscriptTurn[];
}): LogicalQuestionUnit | undefined {
  const primaryAsk = input.packet.primaryAsk;
  if (!primaryAsk?.text.trim()) return undefined;

  const screenObservationId =
    input.packet.visualEvidence.screenObservationId;
  const fallbackSourceId = `screen:${screenObservationId}`;
  const voiceOwned =
    primaryAsk.source === "voice-lqu" &&
    Boolean(primaryAsk.logicalQuestionUnitId) &&
    typeof primaryAsk.revision === "number";
  const sourceTurnIds = voiceOwned
    ? uniqueStrings(primaryAsk.sourceTurnIds)
    : [];
  const transcriptById = new Map(
    (input.transcriptTurns ?? []).map((turn) => [turn.id, turn])
  );
  const transcriptSources = sourceTurnIds
    .map((turnId) => transcriptById.get(turnId))
    .filter((turn): turn is TranscriptTurn => Boolean(turn))
    .map((turn) => ({
      turnId: turn.id,
      text: turn.text,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
    }));
  const fallbackTurnId =
    sourceTurnIds[sourceTurnIds.length - 1] ?? fallbackSourceId;
  const sources = transcriptSources.length
    ? transcriptSources
    : [
        {
          turnId: fallbackTurnId,
          text: primaryAsk.text.trim(),
          startedAt: input.createdAt,
          endedAt: input.createdAt,
        },
      ];

  return {
    id: voiceOwned
      ? primaryAsk.logicalQuestionUnitId!
      : `screen-answer-sufficiency:${screenObservationId}`,
    revision: voiceOwned ? primaryAsk.revision! : 1,
    sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    currentTurnId: fallbackTurnId,
    sourceTurnIds,
    sources,
    normalizedText: primaryAsk.text.trim(),
    startedAt: Math.min(...sources.map((source) => source.startedAt)),
    updatedAt: Math.max(...sources.map((source) => source.endedAt)),
    compositionReasons: [
      voiceOwned
        ? "manual-screen-bound-voice-question"
        : "visible-screen-question",
    ],
    boundaryReason: voiceOwned
      ? "manual-screen-visual-evidence"
      : "visible-screen-question",
    truncated: false,
  };
}

function uniqueStrings(values: readonly string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}
