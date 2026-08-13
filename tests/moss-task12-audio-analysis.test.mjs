import test from "node:test";
import assert from "node:assert/strict";
import { analyzeCallAudioEvidence } from "../scripts/analyze-call-audio.mjs";

test("Task 12E aligns STT outcomes with generation-scoped audio evidence", () => {
  const report = analyzeCallAudioEvidence({
    callSessionId: "call-test",
    audioManifest: {
      state: "partial",
      retentionMode: "temporary",
      channels: [
        { channel: "them", gapCount: 1, overflowCount: 2 },
        { channel: "me", gapCount: 0, overflowCount: 0 },
      ],
      chunks: [{
        channel: "them",
        captureGeneration: 2,
        startedAt: 1_000,
        endedAt: 2_000,
      }],
    },
    events: [
      {
        kind: "audio-segment-observed",
        payload: {
          captureSessionId: "capture-a",
          captureGeneration: 2,
          segmentSequence: 1,
          speechStartedAtMs: 1_100,
          speechEndedAtMs: 1_500,
        },
      },
      {
        kind: "stt-operation-returned",
        payload: {
          captureSessionId: "capture-a",
          captureGeneration: 2,
          segmentSequence: 1,
          status: "success",
          transcript: "",
        },
      },
      {
        kind: "audio-segment-observed",
        payload: {
          captureSessionId: "capture-b",
          captureGeneration: 3,
          segmentSequence: 1,
          speechStartedAtMs: 3_000,
          speechEndedAtMs: 3_500,
        },
      },
      {
        kind: "stt-operation-returned",
        payload: {
          captureSessionId: "capture-b",
          captureGeneration: 3,
          segmentSequence: 1,
          status: "failed",
        },
      },
      { kind: "rollover-transcript-family", payload: { status: "degraded" } },
    ],
  });

  assert.equal(report.metrics.observedSegmentCount, 2);
  assert.equal(report.metrics.audioBackedSegmentCount, 1);
  assert.equal(report.metrics.audioCaptureCoverageRatio, 400 / 900);
  assert.equal(report.metrics.audioChunkGapCount, 1);
  assert.equal(report.metrics.audioWriterOverflowCount, 2);
  assert.equal(report.metrics.stt.empty, 1);
  assert.equal(report.metrics.stt.failed, 1);
  assert.equal(report.metrics.stt.failuresWithAudioEvidence, 1);
  assert.equal(report.metrics.rolloverOutcomes.degraded, 1);
  assert.deepEqual(report.missingAudioEvidence, ["capture-b:3:1"]);
});
