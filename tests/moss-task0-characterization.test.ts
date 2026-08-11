import assert from "node:assert/strict";
import test from "node:test";
import {
  AudioSegmentDispositionLedger,
  authorizeNativeSpeechSegment,
  createCancellableOperation,
  OperationAbortError,
  type CancellableOperationEvent,
  authorizeOperationCommit,
  createOperationLease,
} from "../src/lib/calling/index.js";

const nativeSegment = {
  captureSessionId: "capture-moss-a",
  captureGeneration: 2,
  segmentSequence: 4,
  owner: "call" as const,
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
  mediaType: "audio/wav" as const,
  audioBase64: "UklGRg==",
};

test("MOSS preservation gate: stale native audio cannot enter STT", () => {
  const stale = authorizeNativeSpeechSegment({
    payload: nativeSegment,
    activeCaptureSessionId: "capture-moss-b",
    activeCaptureGeneration: 2,
    lastAcceptedSequence: 0,
    expectedOwner: "call",
  });
  assert.equal(stale.authorized, false);
  if (!stale.authorized) {
    assert.equal(stale.reason, "capture-session-mismatch");
    assert.equal(stale.event?.captureSessionId, "capture-moss-a");
    assert.equal(stale.event?.segmentSequence, 4);
  }

  const current = authorizeNativeSpeechSegment({
    payload: nativeSegment,
    activeCaptureSessionId: "capture-moss-a",
    activeCaptureGeneration: 2,
    lastAcceptedSequence: 3,
    expectedOwner: "call",
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
  const events: CancellableOperationEvent[] = [];
  let resolveProvider!: (value: string) => void;
  const provider = new Promise<string>((resolve) => {
    resolveProvider = resolve;
  });
  const request = createCancellableOperation({
    operationId: "stt-moss-a",
    timeoutMs: 1_000,
    execute: () => provider,
    onEvent: (event) => events.push(event),
  });

  await Promise.resolve();
  assert.equal(request.cancel("audio-session-invalidated"), true);
  await assert.rejects(
    request.promise,
    (error) =>
      error instanceof OperationAbortError &&
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
    callSessionId: "call-moss-a",
    momentUnitId: "moment-a",
    evidenceRevision: 2,
    logicalRevision: 4,
  };
  const token = createOperationLease({ envelope: {
    ...snapshot,
    operationId: "advisor-moss-a",
    operationKind: "guidance",
    route: "advisor",
    contextSnapshotHash: "hash-a",
    timeoutMs: 10_000,
    input: {},
  }});

  assert.equal(
    authorizeOperationCommit({
      lease: token,
      current: snapshot,
      activeOperationId: "advisor-moss-a",
      expectedRoute: "advisor",
    }).authorized,
    true
  );
  const wrongSession = authorizeOperationCommit({
    lease: token,
    current: { ...snapshot, callSessionId: "call-moss-b" },
    activeOperationId: "advisor-moss-a",
    expectedRoute: "advisor",
  });
  assert.equal(wrongSession.authorized, false);
  if (!wrongSession.authorized) assert.equal(wrongSession.reason, "session-mismatch");

  const wrongOwner = authorizeOperationCommit({
    lease: token,
    current: snapshot,
    activeOperationId: "advisor-moss-b",
    expectedRoute: "advisor",
  });
  assert.equal(wrongOwner.authorized, false);
  if (!wrongOwner.authorized) {
    assert.equal(wrongOwner.reason, "operation-owner-mismatch");
  }
});
