import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeNativeAudioLivenessEvent,
  buildAudioInputLivenessTraceMetadata,
  parseNativeAudioLivenessEvent,
  resolveAudioInputLivenessPresentation,
  RawZeroInputEpisode,
  projectRawZeroInputWarning,
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

test("raw-zero episodes require actual pre-gate signal and survive native generations", () => {
  const episode = new RawZeroInputEpisode();
  episode.observe({ ...FIXTURE, rawSignalChunkCount: 0, rawZeroDurationMs: 100_000 });
  assert.equal(episode.read(200_000, false).warning, false);
  episode.observe({ ...FIXTURE, rawSignalChunkCount: 1, rawZeroDurationMs: 0,
    occurredAtMs: 200_000, lastRawSignalObservedAtMs: 200_000 });
  episode.observe({ ...FIXTURE, rawSignalChunkCount: 1, rawZeroDurationMs: 89_999,
    occurredAtMs: 289_999, lastRawSignalObservedAtMs: 200_000 });
  assert.equal(episode.read(289_999, false).warning, false);
  assert.equal(episode.read(290_000, false).disposition, "probe-ready");
  episode.markProbeStarted();
  episode.observe({ ...FIXTURE, captureGeneration: 3, rawSignalChunkCount: 0,
    rawZeroDurationMs: 90_000, occurredAtMs: 380_000 });
  assert.equal(episode.read(380_000, false).disposition, "probe-used");
  assert.equal(episode.observe({ ...FIXTURE, captureGeneration: 3, rawSignalChunkCount: 1,
    rawZeroDurationMs: 0, occurredAtMs: 380_010, lastRawSignalObservedAtMs: 380_010 }), true);
  assert.equal(episode.read(380_010, false).warning, false);
});

test("Screen admission resets automatic wait without hiding silence or replenishing the probe", () => {
  const episode = new RawZeroInputEpisode();
  episode.observe({ ...FIXTURE, occurredAtMs: 100_000, rawSignalChunkCount: 1,
    rawZeroDurationMs: 99_000, lastRawSignalObservedAtMs: 1_000 });
  episode.screenAdmitted(100_000);
  assert.equal(episode.read(100_000, false).warning, true);
  assert.equal(episode.read(189_999, false).disposition, "screen-wait");
  assert.equal(episode.read(190_000, true).disposition, "screen-deferred");
  assert.equal(episode.read(220_000, false).disposition, "probe-ready");
  episode.markProbeStarted();
  episode.screenAdmitted(220_000);
  assert.equal(episode.read(310_000, false).disposition, "probe-used");
  const warning = projectRawZeroInputWarning(resolveAudioInputLivenessPresentation({
    captureActive: true, vadEnabled: true, nowMs: 220_000,
  }), episode.read(220_000, false), true);
  assert.equal(warning?.label, "Checking audio input");
  assert.equal(warning?.severity, "warning");
});

test("missing legacy raw observations cannot authorize a probe", () => {
  const episode = new RawZeroInputEpisode();
  episode.observe(FIXTURE);
  assert.equal(episode.read(999_999, false).warning, false);
  const parsed = parseNativeAudioLivenessEvent({ ...FIXTURE, rawZeroDurationMs: 90_000,
    rawSignalChunkCount: 2, lastRawSignalObservedAtMs: 1_000 });
  assert.equal(parsed?.rawZeroDurationMs, 90_000);
  assert.equal(buildAudioInputLivenessTraceMetadata(parsed!, 100_000).rawSignalChunkCount, 2);
});

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

test("diagnostic marker is optional and never changes liveness authorization", () => {
  const marked = { ...FIXTURE, diagnosticRunId: "diagnostic-run-1" };
  assert.equal(parseNativeAudioLivenessEvent(marked)?.diagnosticRunId, "diagnostic-run-1");
  assert.equal(parseNativeAudioLivenessEvent(FIXTURE)?.diagnosticRunId, undefined);
  assert.equal(parseNativeAudioLivenessEvent({ ...FIXTURE, diagnosticRunId: 5 }), null);
  assert.equal(authorizeNativeAudioLivenessEvent({
    payload: marked,
    activeCaptureSessionId: "capture-1",
    activeCaptureGeneration: 2,
    expectedOwner: "meeting",
    expectedSource: "system-audio",
    lastSnapshotSequence: 3,
  }).authorized, true);
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
