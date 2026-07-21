import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeNativeAudioLifecycleEvent,
  buildNativeAudioLifecycleTraceMetadata,
  decideNativeAudioTerminalDisposition,
  parseNativeAudioLifecycleEvent,
  parseNativeAudioSegmentDroppedEvent,
  pruneNativeAudioRecoveryAttempts,
} from "../src/lib/meeting/native-audio-lifecycle.js";

const STOPPED_EVENT = {
  eventType: "stopped",
  captureSessionId: "capture-meeting",
  captureGeneration: 4,
  owner: "meeting",
  occurredAtMs: 1_234,
  reason: "buffer-overflow",
  message: null,
  sampleRate: 48_000,
  expected: false,
  recoverability: "retry-once",
  diagnostics: {
    droppedSamples: 24_000,
    consecutiveDrops: 51,
    bufferCapacity: 131_072,
  },
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
    nativeAudioReason: "buffer-overflow",
    nativeAudioMessage: null,
    nativeSampleRate: 48_000,
    nativeAudioExpected: false,
    nativeAudioRecoverability: "retry-once",
    nativeAudioDroppedSamples: 24_000,
    nativeAudioConsecutiveDrops: 51,
    nativeAudioBufferCapacity: 131_072,
  });
});

test("reconciles expected, recoverable, and exhausted terminal outcomes", () => {
  assert.equal(
    decideNativeAudioTerminalDisposition(
      {
        ...STOPPED_EVENT,
        reason: "requested-stop",
        expected: true,
        recoverability: "not-applicable",
      },
      true
    ),
    "expected-stop"
  );
  assert.equal(
    decideNativeAudioTerminalDisposition(STOPPED_EVENT, true),
    "recovering"
  );
  assert.equal(
    decideNativeAudioTerminalDisposition(STOPPED_EVENT, false),
    "fatal"
  );
  assert.equal(
    decideNativeAudioTerminalDisposition(
      { ...STOPPED_EVENT, recoverability: "manual" },
      true
    ),
    "fatal"
  );
});

test("recovery circuit breaker retains only attempts inside its time window", () => {
  assert.deepEqual(
    pruneNativeAudioRecoveryAttempts(
      [Number.NaN, 1_000, 59_999, 60_000, 60_001, 70_000],
      70_000,
      10_000
    ),
    [60_001, 70_000]
  );
});

test("parses lease-qualified segment drops without any audio payload", () => {
  assert.deepEqual(
    parseNativeAudioSegmentDroppedEvent({
      captureSessionId: "capture-meeting",
      captureGeneration: 4,
      attemptedSegmentSequence: 8,
      owner: "meeting",
      occurredAtMs: 2_000,
      reason: "wav-encoding-failed",
      message: "writer failed",
    }),
    {
      captureSessionId: "capture-meeting",
      captureGeneration: 4,
      attemptedSegmentSequence: 8,
      owner: "meeting",
      occurredAtMs: 2_000,
      reason: "wav-encoding-failed",
      message: "writer failed",
    }
  );
});
