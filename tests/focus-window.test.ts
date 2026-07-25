import assert from "node:assert/strict";
import test from "node:test";
import { guardAsyncUnlisten } from "../src/lib/meeting/focus-window.js";

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
