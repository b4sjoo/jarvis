import assert from "node:assert/strict";
import test from "node:test";
import {
  RuntimeInferenceProviderAdmissionCoordinator,
  type RuntimeInferenceAdmissionClock,
} from "../src/lib/meeting/runtime-inference-provider-admission.js";
import { RuntimeInferenceOperationRuntime } from "../src/lib/meeting/runtime-inference-runtime.js";

test("prioritizes critical then evaluation work across one provider", async () => {
  const coordinator = new RuntimeInferenceProviderAdmissionCoordinator(1, 15);
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const run = (operationId: string, lane: "critical" | "evaluation" | "background") =>
    coordinator.run({
      operationId,
      lane,
      signal: new AbortController().signal,
      execute: () =>
        new Promise<string>((resolve) => {
          started.push(operationId);
          releases.set(operationId, () => resolve(operationId));
        }),
    });

  const background = run("background", "background");
  const evaluation = run("evaluation", "evaluation");
  const critical = run("critical", "critical");
  await waitFor(() => started.length === 1);
  assert.deepEqual(started, ["critical"]);
  releases.get("critical")?.();
  await critical;
  await waitFor(() => started.length === 2);
  assert.deepEqual(started, ["critical", "evaluation"]);
  releases.get("evaluation")?.();
  await evaluation;
  await waitFor(() => started.length === 3);
  assert.deepEqual(started, ["critical", "evaluation", "background"]);
  releases.get("background")?.();
  await background;
});

test("shares one non-critical admission epoch across a provider group", async () => {
  const clock = new ControlledAdmissionClock(100);
  const coordinator = new RuntimeInferenceProviderAdmissionCoordinator(
    1,
    15,
    clock
  );
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const run = (
    operationId: string,
    lane: "critical" | "evaluation" | "background"
  ) =>
    coordinator.run({
      operationId,
      lane,
      signal: new AbortController().signal,
      execute: () =>
        new Promise<string>((resolve) => {
          started.push(operationId);
          releases.set(operationId, () => resolve(operationId));
        }),
    });

  const background = run("background", "background");
  clock.advanceBy(1);
  const evaluation = run("evaluation", "evaluation");
  clock.advanceBy(1);
  const critical = run("critical", "critical");
  await waitFor(() => started.length === 1);
  assert.deepEqual(started, ["critical"]);

  releases.get("critical")?.();
  await critical;
  clock.advanceTo(115);
  await waitFor(() => started.length === 2);
  assert.deepEqual(started, ["critical", "evaluation"]);

  releases.get("evaluation")?.();
  await evaluation;
  await waitFor(() => started.length === 3);
  assert.deepEqual(started, ["critical", "evaluation", "background"]);
  releases.get("background")?.();
  await background;
});

test("caps concurrent provider work and reports admission receipts", async () => {
  const coordinator = new RuntimeInferenceProviderAdmissionCoordinator(2, 0);
  const releases: Array<() => void> = [];
  const receipts: number[] = [];
  const activeCounts: number[] = [];
  const runs = [0, 1, 2].map((index) =>
    coordinator.run({
      operationId: `critical-${index}`,
      lane: "critical",
      signal: new AbortController().signal,
      onAdmitted: (receipt) => {
        receipts.push(receipt.queueDepthAtAdmission);
        activeCounts.push(receipt.activeCountAtAdmission);
        assert.equal(receipt.maxConcurrent, 2);
      },
      execute: () =>
        new Promise<number>((resolve) => {
          releases.push(() => resolve(index));
        }),
    })
  );

  await waitFor(() => releases.length === 2);
  assert.deepEqual(coordinator.readSnapshot(), {
    activeCount: 2,
    queuedCount: 1,
    maxConcurrent: 2,
  });
  releases.shift()?.();
  await waitFor(() => releases.length === 2);
  while (releases.length) releases.shift()?.();
  await Promise.all(runs);
  assert.equal(receipts.length, 3);
  assert.ok(activeCounts.every((count) => count <= 2));
});

test("isolates different provider fingerprints and shares identical configurations", async () => {
  const isolated = new RuntimeInferenceProviderAdmissionCoordinator(1, 0);
  isolated.configureProviderGroups({
    fastFingerprint: "fast-a",
    intelligentFingerprint: "smart-b",
  });
  const isolatedStarted: string[] = [];
  const isolatedReleases = new Map<string, () => void>();
  const run = (
    coordinator: RuntimeInferenceProviderAdmissionCoordinator,
    operationId: string,
    providerTier: "fast" | "intelligent",
    started: string[],
    releases: Map<string, () => void>
  ) =>
    coordinator.run({
      operationId,
      lane: "critical",
      providerTier,
      signal: new AbortController().signal,
      execute: () =>
        new Promise<string>((resolve) => {
          started.push(operationId);
          releases.set(operationId, () => resolve(operationId));
        }),
    });
  const isolatedFast = run(
    isolated,
    "fast",
    "fast",
    isolatedStarted,
    isolatedReleases
  );
  const isolatedSmart = run(
    isolated,
    "smart",
    "intelligent",
    isolatedStarted,
    isolatedReleases
  );
  await waitFor(() => isolatedStarted.length === 2);
  isolatedReleases.get("fast")?.();
  isolatedReleases.get("smart")?.();
  await Promise.all([isolatedFast, isolatedSmart]);

  const shared = new RuntimeInferenceProviderAdmissionCoordinator(1, 0);
  shared.configureProviderGroups({
    fastFingerprint: "same",
    intelligentFingerprint: "same",
  });
  const sharedStarted: string[] = [];
  const sharedReleases = new Map<string, () => void>();
  const sharedFast = run(
    shared,
    "shared-fast",
    "fast",
    sharedStarted,
    sharedReleases
  );
  const sharedSmart = run(
    shared,
    "shared-smart",
    "intelligent",
    sharedStarted,
    sharedReleases
  );
  await waitFor(() => sharedStarted.length === 1);
  sharedReleases.get(sharedStarted[0])?.();
  await waitFor(() => sharedStarted.length === 2);
  sharedReleases.get(sharedStarted[1])?.();
  await Promise.all([sharedFast, sharedSmart]);
});

test("removes an aborted queued operation without consuming a slot", async () => {
  const coordinator = new RuntimeInferenceProviderAdmissionCoordinator(1, 0);
  let releaseActive: (() => void) | undefined;
  const active = coordinator.run({
    operationId: "active",
    lane: "critical",
    signal: new AbortController().signal,
    execute: () =>
      new Promise<void>((resolve) => {
        releaseActive = resolve;
      }),
  });
  await waitFor(() => Boolean(releaseActive));

  const queuedController = new AbortController();
  const queued = coordinator.run({
    operationId: "queued",
    lane: "critical",
    signal: queuedController.signal,
    execute: async () => undefined,
  });
  queuedController.abort();
  await assert.rejects(queued, { name: "AbortError" });
  assert.equal(coordinator.readSnapshot().queuedCount, 0);
  releaseActive?.();
  await active;
});

test("coordinates otherwise independent operation runtimes", async () => {
  const coordinator = new RuntimeInferenceProviderAdmissionCoordinator(1, 0);
  const responseRuntime = new RuntimeInferenceOperationRuntime<
    TestJob,
    string
  >("response-opportunity-inference", coordinator);
  const metadataRuntime = new RuntimeInferenceOperationRuntime<
    TestJob,
    string
  >("meeting-metadata-inference", coordinator);
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const settlements: string[] = [];
  const schedule = (
    runtime: RuntimeInferenceOperationRuntime<TestJob, string>,
    operationId: string,
    operationKind: TestJob["operationKind"]
  ) =>
    runtime.schedule(
      {
        job: {
          operationId,
          operationKind,
          sessionId: "session-a",
          budgetKey: operationId,
          budgetSlot: "slot",
          budgetReason: "test",
        },
        execute: async () =>
          new Promise<string>((resolve) => {
            started.push(operationId);
            releases.set(operationId, () => resolve(operationId));
          }),
        onSettled: (settlement) => {
          if (settlement.result) settlements.push(settlement.result);
        },
      },
      0
    );

  schedule(
    responseRuntime,
    "response",
    "response-opportunity-inference"
  );
  schedule(
    metadataRuntime,
    "metadata",
    "meeting-metadata-inference"
  );
  await waitFor(() => started.length === 1);
  assert.deepEqual(started, ["response"]);
  releases.get("response")?.();
  await waitFor(() => started.length === 2);
  releases.get("metadata")?.();
  await waitFor(() => settlements.length === 2);
  assert.deepEqual(settlements.sort(), ["metadata", "response"]);
});

interface TestJob {
  operationId: string;
  operationKind:
    | "response-opportunity-inference"
    | "meeting-metadata-inference";
  sessionId: string;
  budgetKey: string;
  budgetSlot: string;
  budgetReason: string;
}

class ControlledAdmissionClock implements RuntimeInferenceAdmissionClock {
  private sequence = 0;
  private readonly timers = new Map<
    number,
    { at: number; callback: () => void }
  >();

  constructor(private currentTime: number) {}

  now() {
    return this.currentTime;
  }

  schedule(callback: () => void, delayMs: number) {
    const id = this.sequence++;
    this.timers.set(id, {
      at: this.currentTime + Math.max(0, delayMs),
      callback,
    });
    return id;
  }

  cancel(handle: unknown) {
    if (typeof handle === "number") this.timers.delete(handle);
  }

  advanceBy(durationMs: number) {
    this.advanceTo(this.currentTime + durationMs);
  }

  advanceTo(targetTime: number) {
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= targetTime)
        .sort(
          ([leftId, left], [rightId, right]) =>
            left.at - right.at || leftId - rightId
        )[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.currentTime = timer.at;
      timer.callback();
    }
    this.currentTime = targetTime;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 500) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for admission state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
