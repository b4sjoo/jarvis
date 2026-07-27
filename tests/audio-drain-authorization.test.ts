import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeAudioSegmentCommit,
  createAudioDrainAuthorization,
  isOpenAudioDrainAuthorizationForNativeEvent,
  sealAudioDrainAuthorization,
} from "../src/lib/meeting/audio-drain-authorization.js";

const candidate = {
  source: "system-audio",
  audioSessionId: "audio-1",
  segmentSequence: 4,
  nativeCaptureSessionId: "capture-1",
  nativeCaptureGeneration: 7,
};

test("active capture remains the normal segment commit authority", () => {
  const decision = authorizeAudioSegmentCommit({
    candidate,
    runtimeActive: true,
    currentAudioSessionId: "audio-1",
    activeCaptureSessionId: "capture-1",
    activeCaptureGeneration: 7,
    drainAuthorization: null,
    now: 100,
  });

  assert.equal(decision.authorized, true);
  assert.equal(decision.authority, "active-capture");
});

test("an exact sealed drain lease authorizes a tail after capture stops", () => {
  const authorization = sealAudioDrainAuthorization(
    createAudioDrainAuthorization({
      operationId: "pause-1",
      kind: "pause",
      audioSessionId: "audio-1",
      captureSessionId: "capture-1",
      captureGeneration: 7,
      issuedAt: 100,
      expiresAt: 5_000,
    }),
    {
      maximumSegmentSequence: 4,
      expiresAt: 4_100,
    }
  );
  const decision = authorizeAudioSegmentCommit({
    candidate,
    runtimeActive: false,
    currentAudioSessionId: "audio-inactive",
    activeCaptureSessionId: null,
    activeCaptureGeneration: null,
    drainAuthorization: authorization,
    now: 1_000,
  });

  assert.equal(decision.authorized, true);
  assert.equal(decision.authority, "drain");
  assert.equal(decision.drainOperationId, "pause-1");
});

test("drain lease rejects a new generation and a segment beyond its boundary", () => {
  const authorization = sealAudioDrainAuthorization(
    createAudioDrainAuthorization({
      operationId: "stop-1",
      kind: "stop",
      audioSessionId: "audio-1",
      captureSessionId: "capture-1",
      captureGeneration: 7,
      issuedAt: 100,
      expiresAt: 5_000,
    }),
    {
      maximumSegmentSequence: 4,
      expiresAt: 4_100,
    }
  );

  assert.equal(
    authorizeAudioSegmentCommit({
      candidate: {
        ...candidate,
        nativeCaptureGeneration: 8,
      },
      runtimeActive: true,
      currentAudioSessionId: "audio-2",
      activeCaptureSessionId: "capture-2",
      activeCaptureGeneration: 8,
      drainAuthorization: authorization,
      now: 1_000,
    }).reason,
    "native-capture-generation-mismatch"
  );
  assert.equal(
    authorizeAudioSegmentCommit({
      candidate: {
        ...candidate,
        segmentSequence: 5,
      },
      runtimeActive: false,
      currentAudioSessionId: "audio-inactive",
      activeCaptureSessionId: null,
      activeCaptureGeneration: null,
      drainAuthorization: authorization,
      now: 1_000,
    }).reason,
    "drain-sequence-exceeded"
  );
});

test("expired drain lease cannot authorize a late result", () => {
  const authorization = createAudioDrainAuthorization({
    operationId: "termination-1",
    kind: "termination",
    audioSessionId: "audio-1",
    captureSessionId: "capture-1",
    captureGeneration: 7,
    issuedAt: 100,
    expiresAt: 500,
  });
  const decision = authorizeAudioSegmentCommit({
    candidate,
    runtimeActive: false,
    currentAudioSessionId: "audio-inactive",
    activeCaptureSessionId: null,
    activeCaptureGeneration: null,
    drainAuthorization: authorization,
    now: 501,
  });

  assert.equal(decision.authorized, false);
  assert.equal(decision.reason, "drain-lease-expired");
});

test("only an open exact drain lease accepts a late native event", () => {
  const open = createAudioDrainAuthorization({
    operationId: "pause-2",
    kind: "pause",
    audioSessionId: "audio-1",
    captureSessionId: "capture-1",
    captureGeneration: 7,
    issuedAt: 100,
    expiresAt: 5_000,
  });
  assert.equal(
    isOpenAudioDrainAuthorizationForNativeEvent({
      authorization: open,
      captureSessionId: "capture-1",
      captureGeneration: 7,
      now: 200,
    }),
    true
  );
  assert.equal(
    isOpenAudioDrainAuthorizationForNativeEvent({
      authorization: sealAudioDrainAuthorization(open, {
        maximumSegmentSequence: 4,
        expiresAt: 4_100,
      }),
      captureSessionId: "capture-1",
      captureGeneration: 7,
      now: 200,
    }),
    false
  );
});
