import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRetrievalRuntime,
  type MemorySnapshotLoadResult,
} from "../src/lib/memory/retrieval-runtime.js";
import type { MemoryEntry } from "../src/lib/memory/types.js";

test("coalesces concurrent snapshot loads and reuses the warm snapshot", async () => {
  const runtime = new MemoryRetrievalRuntime({ usageDebounceMs: 60_000 });
  const deferred = createDeferred<MemorySnapshotLoadResult>();
  let loadCount = 0;
  const loader = async () => {
    loadCount += 1;
    return deferred.promise;
  };

  const firstRead = runtime.readSnapshot({ sessionId: "session-a", loader });
  const secondRead = runtime.readSnapshot({ sessionId: "session-a", loader });
  deferred.resolve(buildLoadResult([buildEntry("entry-a")]));

  const [first, second] = await Promise.all([firstRead, secondRead]);
  const warm = await runtime.readSnapshot({
    sessionId: "session-a",
    loader,
  });

  assert.equal(loadCount, 1);
  assert.equal(first.telemetry.cacheState, "miss");
  assert.equal(second.telemetry.cacheState, "load-coalesced");
  assert.equal(warm.telemetry.cacheState, "hit");
  assert.equal(warm.telemetry.cacheHit, true);
  assert.equal(warm.entries[0]?.id, "entry-a");
});

test("serves the pinned snapshot while an invalidation refresh is pending", async () => {
  const runtime = new MemoryRetrievalRuntime({ usageDebounceMs: 60_000 });
  const refreshDeferred = createDeferred<MemorySnapshotLoadResult>();
  let loadCount = 0;
  const loader = async () => {
    loadCount += 1;
    if (loadCount === 1) {
      return buildLoadResult([buildEntry("entry-v1")]);
    }
    return refreshDeferred.promise;
  };

  await runtime.readSnapshot({ sessionId: "session-a", loader });
  runtime.invalidateSnapshot("entry-enable-state-changed");

  const stale = await runtime.readSnapshot({
    sessionId: "session-a",
    loader,
  });
  assert.equal(stale.telemetry.cacheState, "stale-while-refresh");
  assert.match(stale.telemetry.degradedReason ?? "", /refresh-pending/);
  assert.equal(stale.entries[0]?.id, "entry-v1");

  refreshDeferred.resolve(buildLoadResult([buildEntry("entry-v2")]));
  await waitForMicrotasks();
  const refreshed = await runtime.readSnapshot({
    sessionId: "session-a",
    loader,
  });
  assert.equal(refreshed.telemetry.cacheState, "hit");
  assert.equal(refreshed.entries[0]?.id, "entry-v2");
  assert.equal(loadCount, 2);
});

test("deduplicates usage marks into one non-blocking batch", async () => {
  const runtime = new MemoryRetrievalRuntime({ usageDebounceMs: 60_000 });
  const writes: string[][] = [];
  const flushes: string[] = [];
  const writer = async (entryIds: string[]) => {
    writes.push(entryIds);
  };

  const first = runtime.enqueueUsage({
    entryIds: ["a", "b"],
    writer,
    onFlush: (result) => flushes.push(result.batchId),
  });
  const second = runtime.enqueueUsage({
    entryIds: ["b", "c"],
    writer,
    onFlush: (result) => flushes.push(result.batchId),
  });

  assert.equal(first.batchId, second.batchId);
  assert.equal(first.queueDepth, 2);
  assert.equal(second.queueDepth, 3);
  assert.equal(second.addedEntryCount, 1);

  const result = await runtime.flushUsage();
  assert.equal(result?.success, true);
  assert.deepEqual(writes, [["a", "b", "c"]]);
  assert.deepEqual(flushes, [first.batchId, first.batchId]);
  assert.equal(runtime.getUsageQueueDepth(), 0);
});

test("a slow usage flush does not block warm snapshot reads", async () => {
  const runtime = new MemoryRetrievalRuntime({ usageDebounceMs: 60_000 });
  const loader = async () => buildLoadResult([buildEntry("entry-a")]);
  await runtime.readSnapshot({ sessionId: "session-a", loader });

  const writeDeferred = createDeferred<void>();
  runtime.enqueueUsage({
    entryIds: ["entry-a"],
    writer: async () => writeDeferred.promise,
  });
  const flush = runtime.flushUsage();

  const warmRead = await runtime.readSnapshot({
    sessionId: "session-a",
    loader,
  });
  assert.equal(warmRead.telemetry.cacheState, "hit");
  assert.equal(warmRead.entries[0]?.id, "entry-a");

  writeDeferred.resolve();
  assert.equal((await flush)?.success, true);
});

test("returns an explicit empty degraded snapshot when the first load fails", async () => {
  const runtime = new MemoryRetrievalRuntime({ usageDebounceMs: 60_000 });
  const result = await runtime.readSnapshot({
    sessionId: "session-a",
    loader: async () => {
      throw new Error("database unavailable");
    },
  });

  assert.equal(result.telemetry.cacheState, "unavailable");
  assert.equal(result.telemetry.cacheHit, false);
  assert.match(result.telemetry.degradedReason ?? "", /database unavailable/);
  assert.deepEqual(result.entries, []);
});

test("keeps sustained warm snapshot lookup inside the local latency budget", async () => {
  const runtime = new MemoryRetrievalRuntime({ usageDebounceMs: 60_000 });
  let loadCount = 0;
  const loader = async () => {
    loadCount += 1;
    return buildLoadResult([buildEntry("entry-a")]);
  };
  await runtime.readSnapshot({ sessionId: "session-a", loader });

  const samples: number[] = [];
  for (let index = 0; index < 250; index += 1) {
    const result = await runtime.readSnapshot({
      sessionId: "session-a",
      loader,
    });
    samples.push(result.telemetry.cacheLookupMs);
  }
  samples.sort((left, right) => left - right);
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? Infinity;
  const max = samples[samples.length - 1] ?? Infinity;

  assert.equal(loadCount, 1);
  assert.ok(p95 <= 150, `expected warm p95 <= 150ms, got ${p95}ms`);
  assert.ok(max <= 500, `expected warm max <= 500ms, got ${max}ms`);
});

function buildLoadResult(entries: MemoryEntry[]): MemorySnapshotLoadResult {
  return {
    entries,
    timings: {
      databaseAcquireMs: 1,
      databaseReadMs: 2,
      rowMappingMs: 3,
    },
  };
}

function buildEntry(id: string): MemoryEntry {
  return {
    id,
    sourceIds: ["source"],
    type: "profile",
    title: id,
    content: id,
    scope: "global",
    tags: [],
    keywords: [],
    priority: "normal",
    enabled: true,
    injectionMode: "retrieval",
    useCases: ["general_chat"],
    confidentiality: "normal",
    curationStatus: "curated",
    relatedEntryIds: [],
    evidenceEntryIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}
