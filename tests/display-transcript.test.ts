import assert from "node:assert/strict";
import test from "node:test";
import {
  BatchDisplayTranscriptAssembler,
  projectDisplayTranscriptWindow,
} from "../src/lib/meeting/display-transcript.js";
import type {
  DisplayTranscriptArtifact,
  TranscriptTurn,
} from "../src/lib/meeting/types.js";

function fragment(
  overrides: Partial<
    Parameters<BatchDisplayTranscriptAssembler["accept"]>[0]
  > = {}
) {
  return {
    sessionId: "session-1",
    segmentSequence: 1,
    nativeSegmentSequence: 1,
    rolloverFamilyId: undefined,
    overlapSampleCount: 0,
    endReason: "silence" as const,
    turnId: "turn-1",
    speaker: "them" as const,
    source: "system-audio" as const,
    text: "Design a ticket selling system.",
    providerText: "Design a ticket selling system.",
    startedAt: 100,
    endedAt: 200,
    ...overrides,
  };
}

test("finalizes an ordinary batch transcript immediately", () => {
  const assembler = new BatchDisplayTranscriptAssembler();
  const decision = assembler.accept(fragment());

  assert.equal(decision.disposition, "standalone-finalized");
  assert.equal(decision.semanticCommitAuthorized, true);
  assert.equal(decision.artifact.finalization, "silence");
  assert.equal(decision.artifact.text, "Design a ticket selling system.");
  assert.deepEqual(decision.artifact.sourceTurnIds, ["turn-1"]);
});

test("assembles one semantic utterance across forced rollover fragments", () => {
  const assembler = new BatchDisplayTranscriptAssembler();
  const provisional = assembler.accept(
    fragment({
      rolloverFamilyId: "family-1",
      endReason: "forced-rollover",
      text: "Design a ticket selling system with an HNSW index",
      providerText: "Design a ticket selling system with an HNSW index",
    })
  );
  const finalized = assembler.accept(
    fragment({
      segmentSequence: 2,
      nativeSegmentSequence: 2,
      rolloverFamilyId: "family-1",
      overlapSampleCount: 3200,
      endReason: "silence",
      turnId: "turn-2",
      text: "an HNSW index, then explain the consistency tradeoff.",
      providerText:
        "an HNSW index, then explain the consistency tradeoff.",
      startedAt: 180,
      endedAt: 320,
    })
  );

  assert.equal(provisional.disposition, "rollover-provisional");
  assert.equal(provisional.semanticCommitAuthorized, false);
  assert.equal(finalized.disposition, "rollover-finalized");
  assert.equal(finalized.semanticCommitAuthorized, true);
  assert.equal(finalized.artifact.utteranceId, provisional.artifact.utteranceId);
  assert.equal(finalized.artifact.revision, 2);
  assert.equal(
    finalized.artifact.text,
    "Design a ticket selling system with an HNSW index then explain the consistency tradeoff."
  );
  assert.deepEqual(finalized.artifact.sourceTurnIds, ["turn-1", "turn-2"]);
  assert.deepEqual(finalized.artifact.segmentIds, [
    "session-1:1",
    "session-1:2",
  ]);
  assert.ok(finalized.artifact.overlapCharsRemoved > 0);
});

test("does not let duplicate or stale fragments revise a pending utterance", () => {
  const assembler = new BatchDisplayTranscriptAssembler();
  const first = assembler.accept(
    fragment({
      segmentSequence: 4,
      nativeSegmentSequence: 4,
      rolloverFamilyId: "family-2",
      endReason: "forced-rollover",
    })
  );
  const duplicate = assembler.accept(
    fragment({
      segmentSequence: 4,
      nativeSegmentSequence: 4,
      rolloverFamilyId: "family-2",
      endReason: "forced-rollover",
      turnId: "turn-duplicate",
      text: "Duplicate text",
    })
  );
  const stale = assembler.accept(
    fragment({
      segmentSequence: 3,
      nativeSegmentSequence: 3,
      rolloverFamilyId: "family-2",
      endReason: "forced-rollover",
      turnId: "turn-stale",
      text: "Stale text",
    })
  );

  assert.equal(duplicate.disposition, "duplicate-fragment");
  assert.equal(stale.disposition, "stale-fragment");
  assert.equal(duplicate.artifact.revision, first.artifact.revision);
  assert.equal(stale.artifact.text, first.artifact.text);
});

test("finalizes accepted rollover text when the terminal fragment has no text", () => {
  const assembler = new BatchDisplayTranscriptAssembler();
  const provisional = assembler.accept(
    fragment({
      rolloverFamilyId: "family-3",
      endReason: "forced-rollover",
      text: "Explain the complete architecture",
      providerText: "Explain the complete architecture",
    })
  );
  const finalized = assembler.finalizePending({
    sessionId: "session-1",
    rolloverFamilyId: "family-3",
    segmentSequence: 2,
    nativeSegmentSequence: 2,
    endedAt: 400,
    endReason: "termination-drain",
  });

  assert.ok(finalized);
  assert.equal(finalized.semanticCommitAuthorized, true);
  assert.equal(finalized.artifact.text, provisional.artifact.text);
  assert.equal(finalized.artifact.finalization, "termination");
  assert.equal(finalized.artifact.revision, 2);
});

function transcriptTurn(
  id: string,
  text: string,
  startedAt: number
): TranscriptTurn {
  return {
    id,
    speaker: "them",
    source: "system-audio",
    text,
    startedAt,
    endedAt: startedAt + 100,
    isFinal: true,
  };
}

function displayArtifact(
  utteranceId: string,
  text: string,
  revision = 1
): DisplayTranscriptArtifact {
  return {
    utteranceId,
    revision,
    speaker: "them",
    source: "system-audio",
    segmentIds: [`segment:${utteranceId}`],
    sourceTurnIds: [utteranceId],
    providerChars: text.length,
    displayChars: text.length,
    overlapCharsRemoved: 0,
    omittedChars: 0,
    text,
    finalization: "silence",
    startedAt: 1_000,
    endedAt: 1_100,
  };
}

test("keeps a prior long utterance as lower-emphasis display history", () => {
  const previousText = "Architecture context ".repeat(45).trim();
  const current = displayArtifact(
    "utterance-current",
    "That is all the background content."
  );
  const window = projectDisplayTranscriptWindow({
    current,
    transcriptTurns: [
      transcriptTurn("utterance-previous", previousText, 100),
      transcriptTurn("utterance-current", current.text, 1_000),
    ],
  });

  assert.equal(window.current?.utteranceId, "utterance-current");
  assert.deepEqual(
    window.history.map((entry) => entry.utteranceId),
    ["utterance-previous"]
  );
  assert.equal(window.history[0].text, previousText);
});

test("same-utterance revisions never duplicate the current artifact into history", () => {
  const current = displayArtifact(
    "utterance-family",
    "A complete long interviewer utterance.",
    3
  );
  const window = projectDisplayTranscriptWindow({
    current,
    transcriptTurns: [
      transcriptTurn("utterance-before", "Earlier context.", 100),
      transcriptTurn("utterance-family", current.text, 1_000),
    ],
  });

  assert.deepEqual(
    window.history.map((entry) => entry.utteranceId),
    ["utterance-before"]
  );
});

test("bounds display history by recency, entry count, and a soft character budget", () => {
  const current = displayArtifact("utterance-current", "Current question.");
  const window = projectDisplayTranscriptWindow({
    current,
    transcriptTurns: [
      transcriptTurn("oldest", "a".repeat(500), 100),
      transcriptTurn("older", "b".repeat(500), 200),
      transcriptTurn("recent", "c".repeat(500), 300),
      transcriptTurn("newest", "d".repeat(500), 400),
    ],
    maxHistoryEntries: 3,
    historyCharBudget: 1_100,
  });

  assert.deepEqual(
    window.history.map((entry) => entry.utteranceId),
    ["recent", "newest"]
  );
  assert.equal(window.historyChars, 1_000);
});

test("excludes me and duplicate-suppressed turns from display history", () => {
  const current = displayArtifact("utterance-current", "Current question.");
  const meTurn = {
    ...transcriptTurn("me-turn", "My private response.", 100),
    speaker: "me" as const,
    source: "microphone" as const,
  };
  const duplicateTurn = {
    ...transcriptTurn("duplicate", "Duplicated output.", 200),
    contextFusionStatus: "duplicate-suppressed" as const,
  };
  const window = projectDisplayTranscriptWindow({
    current,
    transcriptTurns: [
      transcriptTurn("valid", "Earlier interviewer context.", 50),
      meTurn,
      duplicateTurn,
    ],
  });

  assert.deepEqual(
    window.history.map((entry) => entry.utteranceId),
    ["valid"]
  );
});
