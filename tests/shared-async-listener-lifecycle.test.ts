import assert from "node:assert/strict";
import test from "node:test";
import { createSharedAsyncListenerLifecycle } from "../src/hooks/shared-async-listener-lifecycle.js";

test("keeps a pending setup alive across a Strict Mode remount", async () => {
  const setup = deferred<Array<() => void>>();
  const cleanupCalls = [0, 0];
  let setupCalls = 0;
  const lifecycle = createSharedAsyncListenerLifecycle({
    setup: () => {
      setupCalls += 1;
      return setup.promise;
    },
  });

  const releaseFirstMount = lifecycle.acquire();
  releaseFirstMount();
  const releaseSecondMount = lifecycle.acquire();
  assert.equal(setupCalls, 1);

  setup.resolve([
    () => {
      cleanupCalls[0] += 1;
    },
    () => {
      cleanupCalls[1] += 1;
    },
  ]);
  await settle(setup.promise);
  assert.deepEqual(cleanupCalls, [0, 0]);

  releaseSecondMount();
  releaseSecondMount();
  assert.deepEqual(cleanupCalls, [1, 1]);
});

test("cleans up a late setup when no subscriber returns", async () => {
  const setup = deferred<Array<() => void>>();
  let cleanupCalls = 0;
  const lifecycle = createSharedAsyncListenerLifecycle({
    setup: () => setup.promise,
  });

  const release = lifecycle.acquire();
  release();
  setup.resolve([
    () => {
      cleanupCalls += 1;
    },
  ]);
  await settle(setup.promise);

  assert.equal(cleanupCalls, 1);
});

test("shares one installed listener set until the final subscriber exits", async () => {
  let setupCalls = 0;
  let cleanupCalls = 0;
  const lifecycle = createSharedAsyncListenerLifecycle({
    setup: async () => {
      setupCalls += 1;
      return [
        () => {
          cleanupCalls += 1;
        },
      ];
    },
  });

  const releaseA = lifecycle.acquire();
  const releaseB = lifecycle.acquire();
  await Promise.resolve();
  assert.equal(setupCalls, 1);

  releaseA();
  assert.equal(cleanupCalls, 0);
  releaseB();
  assert.equal(cleanupCalls, 1);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settle(promise: Promise<unknown>) {
  await promise;
  await Promise.resolve();
}
