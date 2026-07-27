import assert from "node:assert/strict";
import test from "node:test";
import { BatchDisplayTranscriptAssembler } from "../src/lib/meeting/display-transcript.js";

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
