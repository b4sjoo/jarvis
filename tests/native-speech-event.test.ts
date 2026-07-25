import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeNativeSpeechDetectedEvent,
  authorizeNativeSpeechStartEvent,
  buildNativeSpeechEventTraceMetadata,
  buildNativeSpeechStartTraceMetadata,
  parseNativeSpeechDetectedEvent,
  parseNativeSpeechStartEvent,
} from "../src/lib/meeting/native-speech-event.js";

const FIXTURE = {
  captureSessionId: "capture-test",
  captureGeneration: 3,
  segmentSequence: 7,
  owner: "system",
  capturedAtMs: 1234,
  sampleRate: 48_000,
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

test("parses the Rust native speech serialization fixture", () => {
  assert.deepEqual(parseNativeSpeechDetectedEvent(FIXTURE), FIXTURE);
  assert.equal(parseNativeSpeechDetectedEvent(FIXTURE.audioBase64), null);
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
