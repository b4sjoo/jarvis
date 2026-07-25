import assert from "node:assert/strict";
import test from "node:test";
import {
  AudioSegmentDispositionLedger,
  createAudioSegmentDispositionKey,
  formatAudioSegmentObservationForTrace,
  formatAudioSegmentSettlementForTrace,
} from "../src/lib/meeting/audio-segment-disposition.js";

const IDENTITY = {
  captureSessionId: "capture-test",
  captureGeneration: 3,
  segmentSequence: 7,
};

test("records repeated payloads as observations without a second canonical failure", () => {
  const ledger = new AudioSegmentDispositionLedger();
  const first = ledger.observe({
    identity: IDENTITY,
    traceId: "voice-trace",
    observedAt: 100,
  });
  const duplicate = ledger.observe({
    identity: IDENTITY,
    observedAt: 110,
  });
  const accepted = ledger.settle({
    identity: IDENTITY,
    traceId: "voice-trace",
    disposition: "accepted",
    settledAt: 120,
  });
  const conflicting = ledger.settle({
    identity: IDENTITY,
    disposition: "invalid-sequence",
    settledAt: 130,
  });

  assert.equal(first.observationDisposition, "first-observation");
  assert.equal(duplicate.observationDisposition, "duplicate-observation");
  assert.equal(duplicate.observationCount, 2);
  assert.equal(accepted.canonicalCommitted, true);
  assert.equal(accepted.canonicalDisposition, "accepted");
  assert.equal(conflicting.canonicalCommitted, false);
  assert.equal(conflicting.canonicalDisposition, "accepted");
  assert.equal(conflicting.proposedDisposition, "invalid-sequence");
});

test("formats payload-free canonical disposition evidence", () => {
  const ledger = new AudioSegmentDispositionLedger();
  const observation = ledger.observe({
    identity: IDENTITY,
    traceId: "voice-trace",
    observedAt: 100,
  });
  const settlement = ledger.settle({
    identity: IDENTITY,
    disposition: "prompt-echo-retry-accepted",
    reason: "unbiased-retry-produced-a-turn",
    settledAt: 120,
  });

  assert.equal(
    createAudioSegmentDispositionKey(IDENTITY),
    "capture-test:3:7"
  );
  assert.deepEqual(formatAudioSegmentObservationForTrace(observation), {
    audioSegmentDispositionKey: "capture-test:3:7",
    audioSegmentObservationDisposition: "first-observation",
    audioSegmentObservationCount: 1,
    audioSegmentDuplicateObservationCount: 0,
    audioSegmentCanonicalDisposition: undefined,
    audioSegmentCanonicalSettledAt: undefined,
  });
  assert.equal(
    formatAudioSegmentSettlementForTrace(settlement)
      .audioSegmentCanonicalDisposition,
    "prompt-echo-retry-accepted"
  );
  assert.equal(
    formatAudioSegmentSettlementForTrace(settlement)
      .audioSegmentDispositionReason,
    "unbiased-retry-produced-a-turn"
  );
});

test("retains only a bounded number of segment identities", () => {
  const ledger = new AudioSegmentDispositionLedger(2);
  for (const segmentSequence of [1, 2, 3]) {
    ledger.observe({
      identity: { ...IDENTITY, segmentSequence },
      observedAt: segmentSequence,
    });
  }

  assert.equal(
    ledger.get({ ...IDENTITY, segmentSequence: 1 }),
    undefined
  );
  assert.ok(ledger.get({ ...IDENTITY, segmentSequence: 2 }));
  assert.ok(ledger.get({ ...IDENTITY, segmentSequence: 3 }));
});
