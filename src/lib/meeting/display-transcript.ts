import { deduplicateRolloverTranscript } from "./rollover-transcript.js";
import type {
  DisplayTranscriptArtifact,
  DisplayTranscriptFinalization,
  DisplayTranscriptHistoryEntry,
  DisplayTranscriptWindow,
  TranscriptTurn,
} from "./types";

export const DISPLAY_TRANSCRIPT_HISTORY_MAX_ENTRIES = 3;
export const DISPLAY_TRANSCRIPT_HISTORY_CHAR_BUDGET = 1_800;

export type BatchTranscriptEndReason =
  | "silence"
  | "forced-rollover"
  | "stop-drain"
  | "termination-drain"
  | "continuous-stop";

export interface BatchDisplayTranscriptFragment {
  sessionId: string;
  segmentSequence: number;
  nativeSegmentSequence?: number;
  rolloverFamilyId?: string;
  overlapSampleCount?: number;
  endReason?: BatchTranscriptEndReason;
  turnId: string;
  speaker: TranscriptTurn["speaker"];
  source: TranscriptTurn["source"];
  text: string;
  providerText: string;
  startedAt: number;
  endedAt: number;
}

export type BatchDisplayTranscriptDisposition =
  | "standalone-finalized"
  | "rollover-provisional"
  | "rollover-finalized"
  | "duplicate-fragment"
  | "stale-fragment";

export interface BatchDisplayTranscriptDecision {
  artifact: DisplayTranscriptArtifact;
  disposition: BatchDisplayTranscriptDisposition;
  semanticCommitAuthorized: boolean;
  providerText: string;
  appendedTextChars: number;
  overlapCharsRemoved: number;
}

interface PendingBatchUtterance {
  artifact: DisplayTranscriptArtifact;
  providerText: string;
  lastSegmentSequence: number;
}

export class BatchDisplayTranscriptAssembler {
  private readonly pendingByFamily = new Map<string, PendingBatchUtterance>();

  accept(
    fragment: BatchDisplayTranscriptFragment
  ): BatchDisplayTranscriptDecision {
    const text = fragment.text.trim();
    const providerText = fragment.providerText.trim();
    const segmentId = buildSegmentId(fragment);
    const familyKey = fragment.rolloverFamilyId
      ? buildFamilyKey(fragment)
      : undefined;

    if (!familyKey) {
      const artifact: DisplayTranscriptArtifact = {
        utteranceId: `utterance:${fragment.turnId}`,
        revision: 1,
        speaker: fragment.speaker,
        source: fragment.source,
        segmentIds: [segmentId],
        sourceTurnIds: [fragment.turnId],
        providerChars: providerText.length,
        displayChars: text.length,
        overlapCharsRemoved: 0,
        omittedChars: 0,
        text,
        finalization: mapFinalization(fragment.endReason),
        startedAt: fragment.startedAt,
        endedAt: fragment.endedAt,
      };
      return {
        artifact,
        disposition: "standalone-finalized",
        semanticCommitAuthorized: true,
        providerText,
        appendedTextChars: text.length,
        overlapCharsRemoved: 0,
      };
    }

    const previous = this.pendingByFamily.get(familyKey);
    if (
      previous &&
      fragment.segmentSequence <= previous.lastSegmentSequence
    ) {
      return {
        artifact: previous.artifact,
        disposition:
          fragment.segmentSequence === previous.lastSegmentSequence
            ? "duplicate-fragment"
            : "stale-fragment",
        semanticCommitAuthorized: false,
        providerText: previous.providerText,
        appendedTextChars: 0,
        overlapCharsRemoved: 0,
      };
    }

    const displayContribution = resolveFragmentContribution(
      previous?.artifact.text,
      text,
      fragment.overlapSampleCount
    );
    const providerContribution = resolveFragmentContribution(
      previous?.providerText,
      providerText,
      fragment.overlapSampleCount
    );
    const assembledText = appendFragment(
      previous?.artifact.text,
      displayContribution.text
    );
    const assembledProviderText = appendFragment(
      previous?.providerText,
      providerContribution.text
    );
    const finalization = mapFinalization(fragment.endReason);
    const semanticCommitAuthorized = finalization !== "provisional";
    const artifact: DisplayTranscriptArtifact = {
      utteranceId:
        previous?.artifact.utteranceId ??
        `utterance:${fragment.sessionId}:${fragment.rolloverFamilyId}`,
      revision: (previous?.artifact.revision ?? 0) + 1,
      speaker: fragment.speaker,
      source: fragment.source,
      segmentIds: appendUnique(
        previous?.artifact.segmentIds ?? [],
        segmentId
      ),
      sourceTurnIds: appendUnique(
        previous?.artifact.sourceTurnIds ?? [],
        fragment.turnId
      ),
      providerChars:
        (previous?.artifact.providerChars ?? 0) + providerText.length,
      displayChars: assembledText.length,
      overlapCharsRemoved:
        (previous?.artifact.overlapCharsRemoved ?? 0) +
        displayContribution.removedChars,
      omittedChars: previous?.artifact.omittedChars ?? 0,
      text: assembledText,
      finalization,
      startedAt: previous?.artifact.startedAt ?? fragment.startedAt,
      endedAt: fragment.endedAt,
    };

    if (semanticCommitAuthorized) {
      this.pendingByFamily.delete(familyKey);
    } else {
      this.pendingByFamily.set(familyKey, {
        artifact,
        providerText: assembledProviderText,
        lastSegmentSequence: fragment.segmentSequence,
      });
    }

    return {
      artifact,
      disposition: semanticCommitAuthorized
        ? "rollover-finalized"
        : "rollover-provisional",
      semanticCommitAuthorized,
      providerText: assembledProviderText,
      appendedTextChars: displayContribution.text.length,
      overlapCharsRemoved: displayContribution.removedChars,
    };
  }

  finalizePending(input: {
    sessionId: string;
    rolloverFamilyId: string;
    segmentSequence: number;
    nativeSegmentSequence?: number;
    endedAt: number;
    endReason: Exclude<BatchTranscriptEndReason, "forced-rollover">;
  }): BatchDisplayTranscriptDecision | undefined {
    const familyKey = `${input.sessionId}:${input.rolloverFamilyId}`;
    const previous = this.pendingByFamily.get(familyKey);
    if (!previous) return undefined;

    const artifact: DisplayTranscriptArtifact = {
      ...previous.artifact,
      revision: previous.artifact.revision + 1,
      segmentIds: appendUnique(
        previous.artifact.segmentIds,
        `${input.sessionId}:${
          input.nativeSegmentSequence ?? input.segmentSequence
        }`
      ),
      finalization: mapFinalization(input.endReason),
      endedAt: input.endedAt,
    };
    this.pendingByFamily.delete(familyKey);
    return {
      artifact,
      disposition: "rollover-finalized",
      semanticCommitAuthorized: true,
      providerText: previous.providerText,
      appendedTextChars: 0,
      overlapCharsRemoved: 0,
    };
  }

  reset() {
    this.pendingByFamily.clear();
  }
}

export function formatDisplayTranscriptForTrace(
  decision: BatchDisplayTranscriptDecision
) {
  return {
    displayTranscriptUtteranceId: decision.artifact.utteranceId,
    displayTranscriptRevision: decision.artifact.revision,
    displayTranscriptDisposition: decision.disposition,
    displayTranscriptFinalization: decision.artifact.finalization,
    displayTranscriptSegmentCount: decision.artifact.segmentIds.length,
    displayTranscriptSourceTurnCount:
      decision.artifact.sourceTurnIds.length,
    displayTranscriptProviderChars: decision.artifact.providerChars,
    displayTranscriptChars: decision.artifact.displayChars,
    displayTranscriptOverlapCharsRemoved:
      decision.artifact.overlapCharsRemoved,
    displayTranscriptOmittedChars: decision.artifact.omittedChars,
    displayTranscriptAppendedChars: decision.appendedTextChars,
    displayTranscriptSemanticCommitAuthorized:
      decision.semanticCommitAuthorized,
  };
}

export function projectDisplayTranscriptWindow(input: {
  current?: DisplayTranscriptArtifact;
  transcriptTurns: TranscriptTurn[];
  maxHistoryEntries?: number;
  historyCharBudget?: number;
}): DisplayTranscriptWindow {
  const maxHistoryEntries = Math.max(
    0,
    input.maxHistoryEntries ?? DISPLAY_TRANSCRIPT_HISTORY_MAX_ENTRIES
  );
  const historyCharBudget = Math.max(
    0,
    input.historyCharBudget ?? DISPLAY_TRANSCRIPT_HISTORY_CHAR_BUDGET
  );
  const excludedTurnIds = new Set([
    input.current?.utteranceId,
    ...(input.current?.sourceTurnIds ?? []),
  ]);
  const selected: DisplayTranscriptHistoryEntry[] = [];
  const selectedIds = new Set<string>();
  let historyChars = 0;

  for (
    let index = input.transcriptTurns.length - 1;
    index >= 0 && selected.length < maxHistoryEntries;
    index -= 1
  ) {
    const turn = input.transcriptTurns[index];
    const text = turn.text.trim();
    if (
      turn.speaker === "me" ||
      turn.contextFusionStatus === "duplicate-suppressed" ||
      !text ||
      excludedTurnIds.has(turn.id) ||
      selectedIds.has(turn.id)
    ) {
      continue;
    }

    const nextChars = historyChars + text.length;
    if (selected.length > 0 && nextChars > historyCharBudget) {
      break;
    }

    selected.push({
      utteranceId: turn.id,
      sourceTurnIds: [turn.id],
      text,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
    });
    selectedIds.add(turn.id);
    historyChars = nextChars;
  }

  return {
    current: input.current,
    history: selected.reverse(),
    historyChars,
  };
}

export function formatDisplayTranscriptWindowForTrace(
  window: DisplayTranscriptWindow
) {
  return {
    displayTranscriptWindowCurrentUtteranceId:
      window.current?.utteranceId,
    displayTranscriptWindowCurrentRevision: window.current?.revision,
    displayTranscriptWindowHistoryCount: window.history.length,
    displayTranscriptWindowHistoryChars: window.historyChars,
    displayTranscriptWindowHistoryUtteranceIds: window.history.map(
      (entry) => entry.utteranceId
    ),
  };
}

function resolveFragmentContribution(
  previousText: string | undefined,
  currentText: string,
  overlapSampleCount = 0
) {
  if (!previousText || overlapSampleCount <= 0) {
    return { text: currentText, removedChars: 0 };
  }

  const deduplication = deduplicateRolloverTranscript(
    previousText,
    currentText
  );
  return {
    text: deduplication.text,
    removedChars: deduplication.changed
      ? Math.max(0, currentText.length - deduplication.text.length)
      : 0,
  };
}

function appendFragment(previousText: string | undefined, text: string) {
  const previous = previousText?.trim() ?? "";
  const next = text.trim();
  if (!previous) return next;
  if (!next) return previous;
  return `${previous} ${next}`;
}

function appendUnique(values: string[], value: string) {
  return values.includes(value) ? values : [...values, value];
}

function buildFamilyKey(fragment: BatchDisplayTranscriptFragment) {
  return `${fragment.sessionId}:${fragment.rolloverFamilyId}`;
}

function buildSegmentId(fragment: BatchDisplayTranscriptFragment) {
  return `${fragment.sessionId}:${
    fragment.nativeSegmentSequence ?? fragment.segmentSequence
  }`;
}

function mapFinalization(
  endReason: BatchTranscriptEndReason | undefined
): DisplayTranscriptFinalization {
  switch (endReason) {
    case "forced-rollover":
      return "provisional";
    case "stop-drain":
    case "continuous-stop":
      return "stop";
    case "termination-drain":
      return "termination";
    case "silence":
      return "silence";
    default:
      return "provider-final";
  }
}
