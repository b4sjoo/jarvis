import assert from "node:assert/strict";
import test from "node:test";
import {
  AudioSegmentDispositionLedger,
} from "../src/lib/meeting/audio-segment-disposition.js";
import {
  authorizeNativeSpeechDetectedEvent,
} from "../src/lib/meeting/native-speech-event.js";
import {
  createCancellableSttRequest,
  SttRequestAbortError,
  type SttRequestLifecycleEvent,
} from "../src/lib/meeting/stt-request-lifecycle.js";
import {
  authorizeRuntimeCommit,
  createRuntimeCommitToken,
} from "../src/lib/meeting/runtime-commit-authorization.js";

const nativeSegment = {
  captureSessionId: "capture-moss-a",
  captureGeneration: 2,
  segmentSequence: 4,
  owner: "meeting" as const,
  capturedAtMs: 2_300,
  speechStartedAtMs: 1_000,
  speechEndedAtMs: 2_250,
  segmentEmittedAtMs: 2_300,
  sampleStart: 48_000,
  sampleEnd: 108_000,
  sampleRate: 48_000,
  durationMs: 1_250,
  endReason: "silence" as const,
  overlapSampleCount: 0,
  overlapDurationMs: 0,
  vadSilenceTargetSamples: 50_160,
  vadMinimumSpeechSamples: 7_824,
  vadPreSpeechSamples: 13_392,
  vadMaximumSegmentSamples: 1_440_000,
  mediaType: "audio/wav" as const,
  audioBase64: "UklGRg==",
};

test("MOSS preservation gate: stale native audio cannot enter STT", () => {
  const stale = authorizeNativeSpeechDetectedEvent({
    payload: nativeSegment,
    activeCaptureSessionId: "capture-moss-b",
    activeCaptureGeneration: 2,
    lastAcceptedSequence: 0,
    expectedOwner: "meeting",
  });
  assert.equal(stale.authorized, false);
  if (!stale.authorized) {
    assert.equal(stale.reason, "capture-session-mismatch");
    assert.equal(stale.event?.captureSessionId, "capture-moss-a");
    assert.equal(stale.event?.segmentSequence, 4);
  }

  const current = authorizeNativeSpeechDetectedEvent({
    payload: nativeSegment,
    activeCaptureSessionId: "capture-moss-a",
    activeCaptureGeneration: 2,
    lastAcceptedSequence: 3,
    expectedOwner: "meeting",
  });
  assert.equal(current.authorized, true);
});

test("MOSS preservation gate: one segment receives one canonical disposition", () => {
  const ledger = new AudioSegmentDispositionLedger();
  const identity = {
    captureSessionId: "capture-moss-a",
    captureGeneration: 2,
    segmentSequence: 4,
  };
  ledger.observe({ identity, observedAt: 100 });
  ledger.observe({ identity, observedAt: 110 });
  const first = ledger.settle({
    identity,
    disposition: "accepted",
    settledAt: 120,
  });
  const lateConflict = ledger.settle({
    identity,
    disposition: "stale",
    settledAt: 130,
  });

  assert.equal(first.canonicalCommitted, true);
  assert.equal(first.duplicateObservationCount, 1);
  assert.equal(lateConflict.canonicalCommitted, false);
  assert.equal(lateConflict.canonicalDisposition, "accepted");
});

test("MOSS preservation gate: cancelled STT cannot surface a late provider result", async () => {
  const events: SttRequestLifecycleEvent[] = [];
  let resolveProvider!: (value: string) => void;
  const provider = new Promise<string>((resolve) => {
    resolveProvider = resolve;
  });
  const request = createCancellableSttRequest({
    requestId: "stt-moss-a",
    timeoutMs: 1_000,
    execute: () => provider,
    onEvent: (event) => events.push(event),
  });

  await Promise.resolve();
  assert.equal(request.cancel("audio-session-invalidated"), true);
  await assert.rejects(
    request.promise,
    (error) =>
      error instanceof SttRequestAbortError &&
      error.reason === "audio-session-invalidated"
  );
  resolveProvider("late transcript");
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(events.some((event) => event.type === "abort-requested"));
  assert.ok(events.some((event) => event.type === "orphan-completion"));
  assert.equal(events.some((event) => event.type === "completed"), false);
});

test("MOSS preservation gate: async output commits only to its exact runtime owner", () => {
  const snapshot = {
    runtimeEpoch: 3,
    sessionId: "call-moss-a",
    parentId: "legacy-parent",
    parentRevision: 2,
  };
  const token = createRuntimeCommitToken({
    operationId: "advisor-moss-a",
    pipeline: "advisor",
    snapshot,
  });

  assert.equal(
    authorizeRuntimeCommit({
      token,
      current: snapshot,
      currentOperationId: "advisor-moss-a",
    }).authorized,
    true
  );
  assert.equal(
    authorizeRuntimeCommit({
      token,
      current: { ...snapshot, sessionId: "call-moss-b" },
      currentOperationId: "advisor-moss-a",
    }).reason,
    "session-mismatch"
  );
  assert.equal(
    authorizeRuntimeCommit({
      token,
      current: snapshot,
      currentOperationId: "advisor-moss-b",
    }).reason,
    "pipeline-owner-mismatch"
  );
});
