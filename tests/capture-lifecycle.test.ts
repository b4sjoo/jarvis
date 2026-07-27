import assert from "node:assert/strict";
import test from "node:test";
import {
  CaptureLifecycleCoordinator,
  type CaptureLifecycleEvent,
} from "../src/lib/meeting/capture-lifecycle.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function allowQueuedOperationToStart() {
  await Promise.resolve();
  await Promise.resolve();
}

test("late start completion cannot restore capture after stop", async () => {
  const events: CaptureLifecycleEvent[] = [];
  const coordinator = new CaptureLifecycleCoordinator((event) =>
    events.push(event)
  );
  const nativeStart = deferred<void>();
  const nativeState: string[] = [];
  let status = "starting";

  const start = coordinator.claim("start");
  const startRun = coordinator.run(start, async () => {
    await nativeStart.promise;
    nativeState.push("start-completed");
    if (!coordinator.recordNativeCompletion(start, "native-start")) {
      await coordinator.cleanupStale(start, "late-native-start", async () => {
        nativeState.push("compensating-stop");
      });
      return;
    }
    status = "listening";
  });
  await allowQueuedOperationToStart();

  const stop = coordinator.claim("stop");
  status = "idle";
  const stopRun = coordinator.run(stop, async () => {
    nativeState.push("stop-completed");
    coordinator.recordNativeCompletion(stop, "native-stop");
    if (coordinator.authorize(stop, "commit-stop")) status = "idle";
  });

  nativeStart.resolve();
  await Promise.all([startRun, stopRun]);

  assert.equal(status, "idle");
  assert.deepEqual(nativeState, [
    "start-completed",
    "compensating-stop",
    "stop-completed",
  ]);
  assert.ok(events.some((event) => event.stage === "stale-cleanup-finished"));
});

test("newer start owns status and session after an older deferred start", async () => {
  const coordinator = new CaptureLifecycleCoordinator();
  const firstNativeStart = deferred<void>();
  let status = "starting";
  let session = "none";

  const first = coordinator.claim("start");
  const firstRun = coordinator.run(first, async () => {
    await firstNativeStart.promise;
    if (!coordinator.recordNativeCompletion(first, "native-start")) {
      await coordinator.cleanupStale(first, "late-native-start", async () => {});
      return;
    }
    status = "listening";
    session = "first";
  });
  await allowQueuedOperationToStart();

  const second = coordinator.claim("start");
  const secondRun = coordinator.run(second, async () => {
    coordinator.recordNativeCompletion(second, "native-start");
    if (!coordinator.authorize(second, "commit-start")) return;
    status = "listening";
    session = "second";
  });

  firstNativeStart.resolve();
  await Promise.all([firstRun, secondRun]);

  assert.equal(status, "listening");
  assert.equal(session, "second");
});

test("pause and resume overlap preserves the newest transition", async () => {
  const coordinator = new CaptureLifecycleCoordinator();
  const nativePause = deferred<void>();
  let status = "listening";

  const pause = coordinator.claim("pause");
  const pauseRun = coordinator.run(pause, async () => {
    await nativePause.promise;
    coordinator.recordNativeCompletion(pause, "native-stop");
    if (coordinator.authorize(pause, "commit-pause")) status = "paused";
  });
  await allowQueuedOperationToStart();

  const resume = coordinator.claim("resume");
  const resumeRun = coordinator.run(resume, async () => {
    coordinator.recordNativeCompletion(resume, "native-start");
    if (coordinator.authorize(resume, "commit-resume")) status = "listening";
  });

  nativePause.resolve();
  await Promise.all([pauseRun, resumeRun]);
  assert.equal(status, "listening");
});

test("duplicate pause requests share one lifecycle operation", async () => {
  const events: CaptureLifecycleEvent[] = [];
  const coordinator = new CaptureLifecycleCoordinator((event) =>
    events.push(event)
  );
  const nativePause = deferred<void>();
  let executions = 0;

  const firstPause = coordinator.runCoalesced("pause", async () => {
    executions += 1;
    await nativePause.promise;
  });
  await allowQueuedOperationToStart();

  const secondPause = coordinator.runCoalesced("pause", async () => {
    executions += 1;
  });

  nativePause.resolve();
  const [firstResult, secondResult] = await Promise.all([
    firstPause,
    secondPause,
  ]);

  assert.equal(executions, 1);
  assert.equal(firstResult.executed, true);
  assert.equal(secondResult.executed, true);
  assert.ok(events.some((event) => event.stage === "coalesced"));
  assert.equal(
    events.filter((event) => event.stage === "claimed").length,
    1
  );
});

test("stale initialization failure cannot clear a newer successful transition", async () => {
  const coordinator = new CaptureLifecycleCoordinator();
  const initialization = deferred<void>();
  let status = "starting";

  const first = coordinator.claim("start");
  const firstRun = coordinator.run(first, async () => {
    try {
      await initialization.promise;
    } catch {
      if (coordinator.authorize(first, "commit-start-error")) status = "error";
    }
  });
  await allowQueuedOperationToStart();

  const second = coordinator.claim("resume");
  const secondRun = coordinator.run(second, async () => {
    if (coordinator.authorize(second, "commit-resume")) status = "listening";
  });

  initialization.reject(new Error("permission initialization failed"));
  await Promise.all([firstRun, secondRun]);
  assert.equal(status, "listening");
});
