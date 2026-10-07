import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeNativeSpeechDetectedEvent,
  authorizeNativeSpeechStartEvent,
  buildNativeSpeechEventTraceMetadata,
  buildNativeSpeechStartTraceMetadata,
  parseNativeSpeechDetectedEvent,
  parseNativeSpeechStartEvent,
  parseNativeAudioObservation,
  measureNativeAudioDelivery,
} from "../src/lib/meeting/native-speech-event.js";

const FIXTURE = {
  captureSessionId: "capture-test",
  captureGeneration: 3,
  segmentSequence: 7,
  owner: "system",
  capturedAtMs: 2_300,
  speechStartedAtMs: 1_000,
  speechEndedAtMs: 2_250,
  segmentEmittedAtMs: 2_300,
  sampleStart: 48_000,
  sampleEnd: 108_000,
  sampleRate: 48_000,
  durationMs: 1_250,
  endReason: "forced-rollover",
  rolloverFamilyId: "rollover-test",
  overlapSampleCount: 19_200,
  overlapDurationMs: 400,
  vadSilenceTargetSamples: 50_160,
  vadMinimumSpeechSamples: 7_824,
  vadPreSpeechSamples: 13_392,
  vadMaximumSegmentSamples: 1_440_000,
  mediaType: "audio/wav",
  audioBase64: "UklGRg==",
};

const START_FIXTURE = {
  captureSessionId: "capture-test",
  captureGeneration: 3,
  candidateSegmentSequence: 8,
  owner: "meeting",
  source: "system-audio",
  occurredAtMs: 1300,
  sampleRate: 48_000,
};

test("format boundaries retain capture identity and their own sample-rate contract", () => {
  const event = parseNativeSpeechDetectedEvent({ ...FIXTURE, owner: "meeting", endReason: "format-boundary",
    sampleRate: 24_000, durationMs: 2_500, rolloverFamilyId: undefined,
    overlapSampleCount: 0, overlapDurationMs: 0 });
  assert.ok(event);
  assert.equal(event.captureSessionId, FIXTURE.captureSessionId);
  assert.equal(event.captureGeneration, FIXTURE.captureGeneration);
  assert.equal(event.endReason, "format-boundary");
  assert.equal(event.sampleRate, 24_000);
});

test("timebase observations preserve native source timing without answer authority", () => {
  const input = { captureSessionId: "capture", captureGeneration: 2, owner: "meeting",
    stage: "audio-timebase-span", sampleRate: 24000, sampleStart: 480000,
    sourceStartedAtMs: 12000, occurredAtMs: 12100, timeBasis: "native-input-clock",
    reason: "sample-rate-changed", sourceGapMs: 117.6 };
  const output = parseNativeAudioObservation(input);
  assert.ok(output && "sampleRate" in output);
  assert.equal(output.sampleRate, 24000);
  assert.equal(output.sourceStartedAtMs, 12000);
  assert.equal(output.sourceGapMs, 117.6);
  assert.equal("audioBase64" in output, false);
  assert.equal(parseNativeAudioObservation({ ...input, sourceGapMs: NaN }), null);
  assert.equal(parseNativeAudioObservation({ ...input, sampleRate: 0 }), null);
  assert.equal(parseNativeAudioObservation({ ...input, timeBasis: "wall-guess" }), null);
});

test("delivery timing joins by exact segment and distinguishes encode, emit, JS and queue delays", () => {
  const deliveryTiming = { rawReadyAtMs: 2_300, encodeStartedAtMs: 2_305,
    encodedAtMs: 2_405, encodeDurationMicros: 100_000, emitStartedAtMs: 2_410 };
  const event = parseNativeSpeechDetectedEvent({ ...FIXTURE, deliveryTiming })!;
  const receipt = parseNativeAudioObservation({ ...FIXTURE, owner: "meeting", stage: "segment-delivery",
    deliveryTiming, emitFinishedAtMs: 2_430, emitDurationMicros: 20_000, emitSucceeded: true });
  assert.equal(receipt?.nativeCaptureSessionId, event.captureSessionId);
  assert.ok(receipt && "nativeSegmentSequence" in receipt);
  assert.equal(receipt.nativeSegmentSequence, event.segmentSequence);
  assert.equal("audioBase64" in receipt!, false);
  assert.deepEqual(measureNativeAudioDelivery({ timing: event.deliveryTiming,
    emitDurationMicros: 20_000, jsReceivedAtMs: 2_800, queuedAtMs: 2_815, dequeuedAtMs: 2_900 }), {
    rawReadyToEncodeMs: 5, encodeDurationMs: 100, nativeEmitDurationMs: 20,
    emitStartToJsMs: 390, jsToEnqueueMs: 15, queueWaitMs: 85,
  });
  assert.equal(measureNativeAudioDelivery({}).encodeDurationMs, undefined);
  assert.equal(measureNativeAudioDelivery({ timing: deliveryTiming, jsReceivedAtMs: 1 }).emitStartToJsMs, undefined);
});

test("diagnostic fields never change speech content or source authorization", () => {
  const invalid = parseNativeSpeechDetectedEvent({ ...FIXTURE, deliveryTiming: { bad: true }, jsReceivedAtMs: 12 });
  assert.deepEqual(invalid, FIXTURE);
  assert.equal(parseNativeAudioObservation({ stage: "segment-delivery", owner: "meeting" }), null);
  const route = parseNativeAudioObservation({ captureSessionId: "c", captureGeneration: 1,
    owner: "meeting", stage: "capture-format", occurredAtMs: 1,
    actualRoute: { outputUid: "output", tapUid: "tap", aggregateUid: "aggregate", audioFormat: "mono48k", forbidden: "discard" } });
  assert.ok(route && "actualRoute" in route);
  assert.equal(route.actualRoute.outputUid, "output");
  assert.equal("forbidden" in route.actualRoute, false);
});

test("parses the Rust native speech serialization fixture", () => {
  assert.deepEqual(parseNativeSpeechDetectedEvent(FIXTURE), FIXTURE);
  assert.equal(parseNativeSpeechDetectedEvent(FIXTURE.audioBase64), null);
});

test("does not compare sample-derived speech time against the emit wall clock", () => {
  const event = {
    ...FIXTURE,
    speechEndedAtMs: 2_350,
    segmentEmittedAtMs: 2_300,
  };

  assert.deepEqual(parseNativeSpeechDetectedEvent(event), event);
});

test("rejects an old native capture session before audio processing", () => {
  const decision = authorizeNativeSpeechDetectedEvent({
    payload: FIXTURE,
    activeCaptureSessionId: "capture-new",
    lastAcceptedSequence: 0,
  });

  assert.equal(decision.authorized, false);
  if (!decision.authorized) {
    assert.equal(decision.reason, "capture-session-mismatch");
  }
});

test("accepts current native segments once and in increasing order", () => {
  assert.equal(
    authorizeNativeSpeechDetectedEvent({
      payload: FIXTURE,
      activeCaptureSessionId: "capture-test",
      lastAcceptedSequence: 6,
    }).authorized,
    true
  );

  const duplicate = authorizeNativeSpeechDetectedEvent({
    payload: FIXTURE,
    activeCaptureSessionId: "capture-test",
    lastAcceptedSequence: 7,
  });
  assert.equal(duplicate.authorized, false);
  if (!duplicate.authorized) {
    assert.equal(duplicate.reason, "duplicate-sequence");
  }

  const outOfOrder = authorizeNativeSpeechDetectedEvent({
    payload: { ...FIXTURE, segmentSequence: 6 },
    activeCaptureSessionId: "capture-test",
    lastAcceptedSequence: 7,
  });
  assert.equal(outOfOrder.authorized, false);
  if (!outOfOrder.authorized) {
    assert.equal(outOfOrder.reason, "non-monotonic-sequence");
  }
});

test("rejects a segment owned by another audio consumer", () => {
  const decision = authorizeNativeSpeechDetectedEvent({
    payload: FIXTURE,
    activeCaptureSessionId: "capture-test",
    lastAcceptedSequence: 0,
    expectedOwner: "meeting",
  });

  assert.equal(decision.authorized, false);
  if (!decision.authorized) {
    assert.equal(decision.reason, "capture-owner-mismatch");
  }
});

test("trace metadata excludes native audio payloads", () => {
  const event = parseNativeSpeechDetectedEvent(FIXTURE);
  assert.ok(event);
  const metadata = buildNativeSpeechEventTraceMetadata(event);

  assert.equal(metadata.nativeCaptureSessionId, "capture-test");
  assert.equal(metadata.nativeSegmentSequence, 7);
  assert.equal(metadata.nativeSegmentEndReason, "forced-rollover");
  assert.equal(metadata.nativeRolloverFamilyId, "rollover-test");
  assert.equal(metadata.nativeOverlapDurationMs, 400);
  assert.equal(metadata.audioBase64Chars, 8);
  assert.equal("audioBase64" in metadata, false);
  assert.equal(JSON.stringify(metadata).includes("UklGRg=="), false);
});

test("parses and authorizes an identity-bearing native speech start", () => {
  assert.deepEqual(parseNativeSpeechStartEvent(START_FIXTURE), START_FIXTURE);
  const authorization = authorizeNativeSpeechStartEvent({
    payload: START_FIXTURE,
    activeCaptureSessionId: "capture-test",
    activeCaptureGeneration: 3,
    lastObservedCandidateSequence: 7,
    expectedOwner: "meeting",
    expectedSource: "system-audio",
  });

  assert.equal(authorization.authorized, true);
  const event = parseNativeSpeechStartEvent(START_FIXTURE);
  assert.ok(event);
  assert.deepEqual(buildNativeSpeechStartTraceMetadata(event, 1310), {
    nativeSpeechEventType: "speech-start",
    nativeCaptureSessionId: "capture-test",
    nativeCaptureGeneration: 3,
    nativeCandidateSegmentSequence: 8,
    nativeCaptureOwner: "meeting",
    nativeSpeechSource: "system-audio",
    nativeSpeechStartedAtMs: 1300,
    nativeSpeechStartObservedAtMs: 1310,
    nativeSampleRate: 48_000,
  });
});

test("rejects stale or duplicate native speech-start candidates", () => {
  const staleSession = authorizeNativeSpeechStartEvent({
    payload: START_FIXTURE,
    activeCaptureSessionId: "capture-new",
    activeCaptureGeneration: 3,
    lastObservedCandidateSequence: 0,
  });
  assert.equal(staleSession.authorized, false);
  if (!staleSession.authorized) {
    assert.equal(staleSession.reason, "capture-session-mismatch");
  }

  const duplicate = authorizeNativeSpeechStartEvent({
    payload: START_FIXTURE,
    activeCaptureSessionId: "capture-test",
    activeCaptureGeneration: 3,
    lastObservedCandidateSequence: 8,
  });
  assert.equal(duplicate.authorized, false);
  if (!duplicate.authorized) {
    assert.equal(duplicate.reason, "non-monotonic-candidate");
  }
});
