import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeNativeSpeechDetectedEvent,
  buildNativeSpeechEventTraceMetadata,
  parseNativeSpeechDetectedEvent,
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
    assert.equal(duplicate.reason, "non-monotonic-sequence");
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
