import assert from "node:assert/strict";
import test from "node:test";
import {
  AudioSegmentQueueTracker,
  createCancellableSttRequest,
  SttRequestAbortError,
  type SttRequestLifecycleEvent,
} from "../src/lib/meeting/stt-request-lifecycle.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("completes one current STT request without cancellation", async () => {
  const events: SttRequestLifecycleEvent[] = [];
  const request = createCancellableSttRequest({
    requestId: "attempt-1",
    timeoutMs: 1_000,
    execute: async () => "transcript",
    onEvent: (event) => events.push(event),
  });

  assert.equal(await request.promise, "transcript");
  assert.deepEqual(
    events.map((event) => event.type),
    ["started", "completed"]
  );
  assert.equal(request.cancel("runtime-boundary"), false);
});

test("cancels immediately and records when the provider observes abort", async () => {
  const events: SttRequestLifecycleEvent[] = [];
  const provider = deferred<string>();
  const request = createCancellableSttRequest({
    requestId: "attempt-2",
    timeoutMs: 1_000,
    execute: (signal) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        provider.reject(error);
      });
      return provider.promise;
    },
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
  await Promise.resolve();

  assert.deepEqual(
    events.map((event) => event.type),
    ["started", "abort-requested", "abort-observed"]
  );
});

test("records an orphan completion when a provider ignores abort", async () => {
  const events: SttRequestLifecycleEvent[] = [];
  const provider = deferred<string>();
  const request = createCancellableSttRequest({
    requestId: "attempt-3",
    timeoutMs: 1_000,
    execute: () => provider.promise,
    onEvent: (event) => events.push(event),
  });

  await Promise.resolve();
  request.cancel("stale-lease");
  await assert.rejects(request.promise, SttRequestAbortError);
  provider.resolve("late transcript");
  await Promise.resolve();
  await Promise.resolve();

  const orphan = events.find(
    (event) => event.type === "orphan-completion"
  );
  assert.ok(orphan);
  if (orphan.type === "orphan-completion") {
    assert.equal(orphan.providerOutcome, "resolved");
    assert.equal(orphan.reason, "stale-lease");
  }
});

test("times out a provider request and marks timeout as the abort reason", async () => {
  const events: SttRequestLifecycleEvent[] = [];
  const request = createCancellableSttRequest({
    requestId: "attempt-4",
    timeoutMs: 5,
    execute: () => new Promise<string>(() => {}),
    onEvent: (event) => events.push(event),
  });

  await assert.rejects(
    request.promise,
    (error) =>
      error instanceof SttRequestAbortError && error.reason === "timeout"
  );
  const aborted = events.find((event) => event.type === "abort-requested");
  assert.ok(aborted);
  if (aborted.type === "abort-requested") {
    assert.equal(aborted.providerTimeout, true);
  }
});

test("stale queue work cannot decrement a replacement session", () => {
  const tracker = new AudioSegmentQueueTracker();
  tracker.reset("session-1");
  assert.equal(tracker.enqueue("session-1"), 1);
  assert.equal(tracker.enqueue("session-1"), 2);
  assert.deepEqual(tracker.dequeue("session-1"), {
    authorized: true,
    queueDepthAtDequeue: 1,
  });

  tracker.reset("session-2");
  assert.equal(tracker.enqueue("session-2"), 1);
  assert.deepEqual(tracker.dequeue("session-1"), {
    authorized: false,
    queueDepthAtDequeue: 1,
  });
  assert.equal(tracker.getDepth(), 1);
  assert.deepEqual(tracker.dequeue("session-2"), {
    authorized: true,
    queueDepthAtDequeue: 0,
  });
});
