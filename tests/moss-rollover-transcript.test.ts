import assert from "node:assert/strict";
import test from "node:test";
import {
  RolloverTranscriptAssembler,
  mergeRolloverTranscripts,
  type NativeSpeechSegment,
} from "../src/lib/calling/index.js";

const segment = (
  sequence: number,
  endReason: NativeSpeechSegment["endReason"],
  rolloverFamilyId?: string
): NativeSpeechSegment => ({
  captureSessionId: "capture-1",
  captureGeneration: 1,
  segmentSequence: sequence,
  owner: "call",
  capturedAtMs: sequence * 100,
  speechStartedAtMs: sequence * 100,
  speechEndedAtMs: sequence * 100 + 90,
  segmentEmittedAtMs: sequence * 100 + 100,
  sampleStart: sequence * 1_000,
  sampleEnd: sequence * 1_000 + 900,
  sampleRate: 16_000,
  durationMs: 100,
  endReason,
  rolloverFamilyId,
  overlapSampleCount: rolloverFamilyId ? 6_400 : 0,
  overlapDurationMs: rolloverFamilyId ? 400 : 0,
  mediaType: "audio/wav",
  audioBase64: "AA==",
});

test("rollover transcript merge removes only a confident token overlap", () => {
  const result = mergeRolloverTranscripts(
    "Please explain the account balance and payment schedule",
    "payment schedule before we approve the transfer"
  );
  assert.equal(
    result.text,
    "Please explain the account balance and payment schedule before we approve the transfer"
  );
  assert.equal(result.uncertain, false);
  assert.ok(result.overlapRemovedChars > 0);
});

test("uncertain rollover transcript merge preserves both source texts", () => {
  const result = mergeRolloverTranscripts(
    "The first segment ends here",
    "A different transcription begins here"
  );
  assert.equal(result.uncertain, true);
  assert.match(result.text, /first segment/);
  assert.match(result.text, /different transcription/);
});

test("a rollover family produces one logical transcript after its final segment", () => {
  const assembler = new RolloverTranscriptAssembler();
  const first = assembler.accept({
    segment: segment(1, "forced-rollover", "family-1"),
    transcript: "Walk me through the proposed payment schedule",
    completedAtMs: 1_000,
  });
  assert.equal(first.status, "pending");

  const final = assembler.accept({
    segment: segment(2, "silence", "family-1"),
    transcript: "payment schedule and the approval path",
    completedAtMs: 2_000,
  });
  assert.equal(final.status, "ready");
  assert.equal(final.segmentCount, 2);
  assert.equal(
    final.text,
    "Walk me through the proposed payment schedule and the approval path"
  );
  assert.deepEqual(assembler.abandonAll(), []);
});

test("ordinary segments remain immediate logical transcripts", () => {
  const assembler = new RolloverTranscriptAssembler();
  const result = assembler.accept({
    segment: segment(1, "silence"),
    transcript: "Could you confirm the renewal date?",
    completedAtMs: 1_000,
  });
  assert.equal(result.status, "ready");
  assert.equal(result.segmentCount, 1);
  assert.equal(result.text, "Could you confirm the renewal date?");
});
