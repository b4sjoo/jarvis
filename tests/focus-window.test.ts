import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_MEETING_FOCUS_SNAPSHOT,
  guardAsyncUnlisten,
  resolveFocusControlsGeometry,
} from "../src/lib/meeting/focus-window.js";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("focus listener cleanup releases an established listener", async () => {
  let unlistenCalls = 0;
  const dispose = guardAsyncUnlisten(
    Promise.resolve(() => {
      unlistenCalls += 1;
    })
  );

  await Promise.resolve();
  dispose();

  assert.equal(unlistenCalls, 1);
});

test("focus listener cleanup releases a listener that registers late", async () => {
  const registration = createDeferred<() => void>();
  let unlistenCalls = 0;
  const dispose = guardAsyncUnlisten(registration.promise);

  dispose();
  registration.resolve(() => {
    unlistenCalls += 1;
  });
  await Promise.resolve();

  assert.equal(unlistenCalls, 1);
});

test("focus listener registration errors are reported without leaking cleanup", async () => {
  const expected = new Error("registration failed");
  let reported: unknown;
  const dispose = guardAsyncUnlisten(Promise.reject(expected), (error) => {
    reported = error;
  });

  await Promise.resolve();
  await Promise.resolve();
  dispose();

  assert.equal(reported, expected);
});

test("focus snapshot excludes historical transcripts", () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      EMPTY_MEETING_FOCUS_SNAPSHOT,
      "transcriptHistory"
    ),
    false
  );
});

test("focus controls keep short transcripts at the compact base geometry", () => {
  assert.deepEqual(
    resolveFocusControlsGeometry({
      measuredTranscriptHeight: 60,
    }),
    {
      preferredWidth: 920,
      preferredHeight: 230,
      measuredTranscriptHeight: 60,
      estimatedTranscriptHeight: 60,
      reservedAuxiliaryHeight: 0,
      transcriptScrollRequired: false,
    }
  );
});

test("focus controls expand width before consuming vertical space", () => {
  const decision = resolveFocusControlsGeometry({
    measuredTranscriptHeight: 120,
  });

  assert.equal(decision.preferredWidth, 1_080);
  assert.ok(decision.preferredHeight > 230);
  assert.equal(decision.transcriptScrollRequired, false);
});

test("focus controls cap very long transcripts and require local scrolling", () => {
  const decision = resolveFocusControlsGeometry({
    measuredTranscriptHeight: 500,
  });

  assert.equal(decision.preferredWidth, 1_280);
  assert.equal(decision.preferredHeight, 410);
  assert.equal(decision.transcriptScrollRequired, true);
});

test("focus controls reserve correction history without shrinking transcript", () => {
  const decision = resolveFocusControlsGeometry({
    measuredTranscriptHeight: 500,
    reservedAuxiliaryHeight: 24,
  });

  assert.equal(decision.preferredWidth, 1_280);
  assert.equal(decision.preferredHeight, 434);
  assert.equal(decision.reservedAuxiliaryHeight, 24);
  assert.equal(decision.transcriptScrollRequired, true);
});
