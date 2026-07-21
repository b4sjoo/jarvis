import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeNativeAudioLifecycleEvent,
  buildNativeAudioLifecycleTraceMetadata,
  createNativeAudioManualRecoveryState,
  decideNativeAudioTerminalDisposition,
  getNativeAudioCaptureStartPolicy,
  parseNativeAudioLifecycleEvent,
  parseNativeAudioSegmentDroppedEvent,
  pruneNativeAudioRecoveryAttempts,
  resolveNativeAudioPrimaryControlAction,
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
    faultInjected: false,
    faultInjectionId: null,
    faultKind: null,
  },
} as const;

test("parses typed native audio lifecycle envelopes", () => {
  assert.deepEqual(parseNativeAudioLifecycleEvent(STOPPED_EVENT), STOPPED_EVENT);
  assert.deepEqual(
    parseNativeAudioLifecycleEvent({
      ...STOPPED_EVENT,
      diagnostics: {
        droppedSamples: 24_000,
        consecutiveDrops: 51,
        bufferCapacity: 131_072,
      },
    }),
    STOPPED_EVENT
  );
  assert.equal(parseNativeAudioLifecycleEvent({ ...STOPPED_EVENT, owner: "other" }), null);
});

test("requires complete fault identity on synthetic lifecycle envelopes", () => {
  const injected = {
    ...STOPPED_EVENT,
    diagnostics: {
      ...STOPPED_EVENT.diagnostics,
      faultInjected: true,
      faultInjectionId: "native_audio_fault_1",
      faultKind: "recoverable-stream-end",
    },
  } as const;
  assert.deepEqual(parseNativeAudioLifecycleEvent(injected), injected);
  assert.equal(
    parseNativeAudioLifecycleEvent({
      ...injected,
      diagnostics: { ...injected.diagnostics, faultInjectionId: null },
    }),
    null
  );
  assert.equal(
    parseNativeAudioLifecycleEvent({
      ...STOPPED_EVENT,
      diagnostics: {
        ...STOPPED_EVENT.diagnostics,
        faultInjectionId: "unexpected",
      },
    }),
    null
  );
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
    nativeAudioFaultInjected: false,
    nativeAudioFaultInjectionId: null,
    nativeAudioFaultKind: null,
    productionReliabilityEligible: true,
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

test("capture start policies keep manual recovery context and reset its acknowledged breaker", () => {
  assert.deepEqual(getNativeAudioCaptureStartPolicy("fresh-start"), {
    lifecycleAction: "start",
    resetContext: true,
    resetRecoveryBudget: true,
    pendingStatus: "starting",
  });
  assert.deepEqual(getNativeAudioCaptureStartPolicy("resume"), {
    lifecycleAction: "resume",
    resetContext: false,
    resetRecoveryBudget: false,
    pendingStatus: "starting",
  });
  assert.deepEqual(getNativeAudioCaptureStartPolicy("automatic-recovery"), {
    lifecycleAction: "resume",
    resetContext: false,
    resetRecoveryBudget: false,
    pendingStatus: "reconnecting",
  });
  assert.deepEqual(getNativeAudioCaptureStartPolicy("manual-recovery"), {
    lifecycleAction: "resume",
    resetContext: false,
    resetRecoveryBudget: true,
    pendingStatus: "reconnecting",
  });
});

test("primary audio control resumes only explicit pause or native failure state", () => {
  assert.equal(
    resolveNativeAudioPrimaryControlAction({
      status: "error",
      manualRecoveryRequired: true,
    }),
    "manual-recovery"
  );
  assert.equal(
    resolveNativeAudioPrimaryControlAction({
      status: "reconnecting",
      manualRecoveryRequired: true,
    }),
    "stop"
  );
  assert.equal(
    resolveNativeAudioPrimaryControlAction({
      status: "error",
      manualRecoveryRequired: false,
    }),
    "start"
  );
  assert.equal(
    resolveNativeAudioPrimaryControlAction({
      status: "paused",
      manualRecoveryRequired: false,
    }),
    "resume"
  );
  assert.equal(
    resolveNativeAudioPrimaryControlAction({
      status: "listening",
      manualRecoveryRequired: false,
    }),
    "stop"
  );
});

test("fatal terminal evidence creates an exact manual recovery token", () => {
  assert.deepEqual(
    createNativeAudioManualRecoveryState({
      event: {
        ...STOPPED_EVENT,
        eventType: "error",
        reason: "capture-panic",
        message: "capture failed",
        recoverability: "manual",
      },
      circuitBreakerOpen: false,
      requiredAt: 2_000,
    }),
    {
      requiredAt: 2_000,
      reason: "capture-panic",
      message: "capture failed",
      interruptedCaptureSessionId: "capture-meeting",
      interruptedCaptureGeneration: 4,
      circuitBreakerOpen: false,
    }
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
