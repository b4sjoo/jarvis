import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeNativeAudioLifecycleEvent,
  buildNativeAudioLifecycleTraceMetadata,
  parseNativeAudioLifecycleEvent,
} from "../src/lib/meeting/native-audio-lifecycle.js";

const STOPPED_EVENT = {
  eventType: "stopped",
  captureSessionId: "capture-meeting",
  captureGeneration: 4,
  owner: "meeting",
  occurredAtMs: 1_234,
  reason: "stream-ended",
  message: null,
  sampleRate: null,
} as const;

test("parses typed native audio lifecycle envelopes", () => {
  assert.deepEqual(parseNativeAudioLifecycleEvent(STOPPED_EVENT), STOPPED_EVENT);
  assert.equal(parseNativeAudioLifecycleEvent({ ...STOPPED_EVENT, owner: "other" }), null);
});

test("authorizes terminal events only for the active owner lease", () => {
  assert.equal(
    authorizeNativeAudioLifecycleEvent({
      payload: STOPPED_EVENT,
      expectedOwner: "meeting",
      activeCaptureSessionId: "capture-meeting",
      activeCaptureGeneration: 4,
    }).authorized,
    true
  );

  const stale = authorizeNativeAudioLifecycleEvent({
    payload: STOPPED_EVENT,
    expectedOwner: "meeting",
    activeCaptureSessionId: "capture-meeting",
    activeCaptureGeneration: 5,
  });
  assert.equal(stale.authorized, false);
  if (!stale.authorized) {
    assert.equal(stale.reason, "capture-generation-mismatch");
  }
});

test("trace metadata keeps lifecycle identity and excludes no hidden payload", () => {
  assert.deepEqual(buildNativeAudioLifecycleTraceMetadata(STOPPED_EVENT), {
    nativeAudioEventType: "stopped",
    nativeCaptureOwner: "meeting",
    nativeCaptureSessionId: "capture-meeting",
    nativeCaptureGeneration: 4,
    nativeAudioOccurredAtMs: 1_234,
    nativeAudioReason: "stream-ended",
    nativeAudioMessage: null,
    nativeSampleRate: null,
  });
});
