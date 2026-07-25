import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeNativeAudioLivenessEvent,
  buildAudioInputLivenessTraceMetadata,
  parseNativeAudioLivenessEvent,
  resolveAudioInputLivenessPresentation,
} from "../src/lib/meeting/audio-input-liveness.js";

const FIXTURE = {
  schemaVersion: 1,
  snapshotSequence: 4,
  captureSessionId: "capture-1",
  captureGeneration: 2,
  owner: "meeting",
  source: "system-audio",
  occurredAtMs: 10_000,
  sampleRate: 48_000,
  state: "awaiting-silence",
  trigger: "periodic",
  candidateSegmentSequence: 3,
  candidateStartedAtMs: 8_000,
  candidateDurationMs: 2_000,
  silenceDurationMs: 640,
  intervalDurationMs: 2_005,
  intervalChunkCount: 94,
  intervalSignalChunkCount: 60,
  intervalSpeechChunkCount: 40,
  intervalMaxRms: 0.03,
  intervalMaxPeak: 0.08,
  processedChunkCount: 300,
  signalChunkCount: 180,
  speechChunkCount: 120,
  speechCandidateCount: 3,
  segmentEmittedCount: 2,
  candidateDiscardedCount: 0,
  lastSignalObservedAtMs: 9_980,
  lastSpeechCandidateAtMs: 8_000,
  lastSegmentEmittedAtMs: 7_500,
  vadConfigRevision: 1,
  hopSize: 1_024,
  sensitivityRms: 0.012,
  peakThreshold: 0.035,
  noiseGateThreshold: 0.003,
  silenceTargetMs: 960,
  minimumSpeechMs: 149,
  maximumSegmentMs: 30_000,
} as const;

test("parses and authorizes a lease-qualified liveness snapshot", () => {
  const parsed = parseNativeAudioLivenessEvent(FIXTURE);
  assert.ok(parsed);
  assert.equal(parsed.captureSessionId, "capture-1");
  assert.equal(parsed.snapshotSequence, 4);
  assert.equal(parsed.state, "awaiting-silence");
  assert.equal(parsed.intervalSignalChunkCount, 60);
  assert.equal(
    authorizeNativeAudioLivenessEvent({
      payload: FIXTURE,
      activeCaptureSessionId: "capture-1",
      activeCaptureGeneration: 2,
      expectedOwner: "meeting",
      expectedSource: "system-audio",
      lastSnapshotSequence: 3,
    }).authorized,
    true
  );
});

test("rejects stale sessions and duplicate liveness snapshots", () => {
  const stale = authorizeNativeAudioLivenessEvent({
    payload: FIXTURE,
    activeCaptureSessionId: "capture-new",
    activeCaptureGeneration: 2,
    lastSnapshotSequence: 0,
  });
  assert.equal(stale.authorized, false);
  if (!stale.authorized) {
    assert.equal(stale.reason, "capture-session-mismatch");
  }

  const duplicate = authorizeNativeAudioLivenessEvent({
    payload: FIXTURE,
    activeCaptureSessionId: "capture-1",
    activeCaptureGeneration: 2,
    lastSnapshotSequence: 4,
  });
  assert.equal(duplicate.authorized, false);
  if (!duplicate.authorized) {
    assert.equal(duplicate.reason, "non-monotonic-snapshot");
  }
});

test("keeps normal silence quiet and reports a stale native heartbeat", () => {
  const quiet = resolveAudioInputLivenessPresentation({
    captureActive: true,
    vadEnabled: true,
    captureStartedAtMs: 9_000,
    nowMs: 10_000,
  });
  assert.equal(quiet?.state, "idle");
  assert.equal(quiet?.severity, "normal");

  const unavailable = resolveAudioInputLivenessPresentation({
    captureActive: true,
    vadEnabled: true,
    latestEvent: FIXTURE,
    latestObservedAtMs: 10_010,
    nowMs: 17_000,
  });
  assert.equal(unavailable?.state, "unavailable");
  assert.equal(unavailable?.severity, "warning");
});

test("reports only over-cap candidates as stalled", () => {
  const active = resolveAudioInputLivenessPresentation({
    captureActive: true,
    vadEnabled: true,
    latestEvent: FIXTURE,
    latestObservedAtMs: 10_010,
    nowMs: 10_500,
  });
  assert.equal(active?.state, "awaiting-silence");
  assert.equal(active?.severity, "normal");

  const stalledFixture = {
    ...FIXTURE,
    state: "segment-open",
    candidateStartedAtMs: 1_000,
    candidateDurationMs: 31_500,
  } as const;
  const stalled = resolveAudioInputLivenessPresentation({
    captureActive: true,
    vadEnabled: true,
    latestEvent: stalledFixture,
    latestObservedAtMs: 33_500,
    nowMs: 33_500,
  });
  assert.equal(stalled?.state, "stalled");
  assert.equal(stalled?.severity, "warning");
});

test("trace metadata remains compact and audio-free", () => {
  const metadata = buildAudioInputLivenessTraceMetadata(FIXTURE, 10_020);
  assert.equal(metadata.audioInputLivenessState, "awaiting-silence");
  assert.equal(metadata.audioInputLivenessObservationDelayMs, 20);
  assert.equal(metadata.vadSegmentEmittedCount, 2);
  assert.equal("audioBase64" in metadata, false);
});
