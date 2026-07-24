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

test("serves the pinned snapshot while a soft invalidation refresh is pending", async () => {
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
  runtime.invalidateSnapshot({
    kind: "soft",
    reason: "entry-content-updated",
  });

  const stale = await runtime.readSnapshot({
    sessionId: "session-a",
    loader,
  });
  assert.equal(stale.telemetry.cacheState, "stale-while-refresh");
  assert.match(stale.telemetry.degradedReason ?? "", /refresh-pending/);
  assert.equal(stale.entries[0]?.id, "entry-v1");
  assert.equal(stale.telemetry.invalidationKind, "soft");
  assert.equal(stale.telemetry.invalidationReason, "entry-content-updated");
  assert.equal(stale.telemetry.invalidationFirstRead, true);
  assert.equal(stale.telemetry.authorityRevision, 0);

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

test("hard invalidation never serves the stale authority snapshot", async () => {
  const runtime = new MemoryRetrievalRuntime({ usageDebounceMs: 60_000 });
  const refreshDeferred = createDeferred<MemorySnapshotLoadResult>();
  const usageWrites: string[][] = [];
  let loadCount = 0;
  const loader = async () => {
    loadCount += 1;
    if (loadCount === 1) {
      return buildLoadResult([buildEntry("entry-a")]);
    }
    return refreshDeferred.promise;
  };

  const initial = await runtime.readSnapshot({
    sessionId: "session-a",
    loader,
  });
  assert.equal(initial.telemetry.snapshotVersion, 1);

  runtime.enqueueUsage({
    entryIds: ["entry-a"],
    writer: async (entryIds) => {
      usageWrites.push(entryIds);
    },
  });
  runtime.invalidateSnapshot({
    kind: "hard",
    reason: "memory-entry-disabled",
    affectedEntryIds: ["entry-a"],
  });

  let readResolved = false;
  const blockedRead = runtime
    .readSnapshot({ sessionId: "session-a", loader })
    .then((result) => {
      readResolved = true;
      return result;
    });
  await waitForMicrotasks();
  assert.equal(readResolved, false);

  await runtime.flushUsage();
  refreshDeferred.resolve(
    buildLoadResult([
      buildEntry("entry-a", { enabled: false }),
      buildEntry("entry-b"),
    ])
  );
  const refreshed = await blockedRead;

  assert.deepEqual(usageWrites, [["entry-a"]]);
  assert.equal(refreshed.telemetry.cacheState, "load-coalesced");
  assert.equal(refreshed.telemetry.authorityRevision, 1);
  assert.equal(refreshed.telemetry.invalidationKind, "hard");
  assert.equal(refreshed.telemetry.invalidationReason, "memory-entry-disabled");
  assert.equal(refreshed.telemetry.invalidationPreviousSnapshotVersion, 1);
  assert.equal(refreshed.telemetry.invalidationNewSnapshotVersion, 2);
  assert.equal(
    refreshed.telemetry.hardInvalidationDisposition,
    "fresh-snapshot-loaded-after-fail-closed"
  );
  assert.deepEqual(refreshed.telemetry.hardInvalidationAffectedEntryIds, [
    "entry-a",
  ]);
  assert.equal(refreshed.telemetry.hardInvalidationTargetsExcluded, true);
  assert.equal(
    refreshed.telemetry.hardInvalidationStaleSnapshotServed,
    false
  );
  assert.equal(
    refreshed.entries.find((entry) => entry.id === "entry-a")?.enabled,
    false
  );
});

test("hard invalidation rejects an older in-flight generation", async () => {
  const runtime = new MemoryRetrievalRuntime({ usageDebounceMs: 60_000 });
  const oldLoad = createDeferred<MemorySnapshotLoadResult>();
  const currentLoad = createDeferred<MemorySnapshotLoadResult>();
  let loadCount = 0;
  const loader = async () => {
    loadCount += 1;
    return loadCount === 1 ? oldLoad.promise : currentLoad.promise;
  };

  const readBeforeInvalidation = runtime.readSnapshot({
    sessionId: "session-a",
    loader,
  });
  runtime.invalidateSnapshot({
    kind: "hard",
    reason: "curation-authority-reduced",
  });
  const readAfterInvalidation = runtime.readSnapshot({
    sessionId: "session-a",
    loader,
  });

  oldLoad.resolve(buildLoadResult([buildEntry("stale-entry")]));
  await waitForMicrotasks();
  currentLoad.resolve(buildLoadResult([buildEntry("fresh-entry")]));

  const results = await Promise.all([
    readBeforeInvalidation,
    readAfterInvalidation,
  ]);
  assert.equal(loadCount, 2);
  assert.deepEqual(
    results.map((result) => result.entries[0]?.id),
    ["fresh-entry", "fresh-entry"]
  );
  const invalidationResult = results.find(
    (result) => result.telemetry.invalidationFirstRead
  );
  assert.equal(invalidationResult?.telemetry.invalidationKind, "hard");
  assert.equal(
    invalidationResult?.telemetry.hardInvalidationStaleSnapshotServed,
    false
  );
});

test("a soft update cannot dissolve a pending hard authority barrier", async () => {
  const runtime = new MemoryRetrievalRuntime({ usageDebounceMs: 60_000 });
  const obsoleteHardRefresh = createDeferred<MemorySnapshotLoadResult>();
  const currentRefresh = createDeferred<MemorySnapshotLoadResult>();
  let loadCount = 0;
  const loader = async () => {
    loadCount += 1;
    if (loadCount === 1) {
      return buildLoadResult([buildEntry("entry-a")]);
    }
    return loadCount === 2
      ? obsoleteHardRefresh.promise
      : currentRefresh.promise;
  };

  await runtime.readSnapshot({ sessionId: "session-a", loader });
  runtime.invalidateSnapshot({
    kind: "hard",
    reason: "memory-entry-disabled",
    affectedEntryIds: ["entry-a"],
  });
  runtime.invalidateSnapshot({
    kind: "soft",
    reason: "memory-entry-enabled",
  });

  const read = runtime.readSnapshot({ sessionId: "session-a", loader });
  obsoleteHardRefresh.resolve(
    buildLoadResult([buildEntry("entry-a")])
  );
  await waitForMicrotasks();
  currentRefresh.resolve(
    buildLoadResult([buildEntry("entry-a", { enabled: false })])
  );
  const result = await read;

  assert.equal(loadCount, 3);
  assert.equal(result.telemetry.invalidationKind, "hard");
  assert.equal(
    result.telemetry.invalidationReason,
    "memory-entry-disabled+memory-entry-enabled"
  );
  assert.equal(result.telemetry.hardInvalidationTargetsExcluded, true);
  assert.equal(result.telemetry.hardInvalidationStaleSnapshotServed, false);
});

test("hard invalidation fails closed when the authority refresh fails", async () => {
  const runtime = new MemoryRetrievalRuntime({ usageDebounceMs: 60_000 });
  let loadCount = 0;
  const loader = async () => {
    loadCount += 1;
    if (loadCount === 1) {
      return buildLoadResult([buildEntry("entry-a")]);
    }
    throw new Error("authority refresh unavailable");
  };

  await runtime.readSnapshot({ sessionId: "session-a", loader });
  runtime.invalidateSnapshot({
    kind: "hard",
    reason: "privacy-authority-reduced",
    affectedEntryIds: ["entry-a"],
  });
  await waitForMicrotasks();

  const result = await runtime.readSnapshot({
    sessionId: "session-a",
    loader,
  });
  assert.deepEqual(result.entries, []);
  assert.equal(result.telemetry.cacheState, "unavailable");
  assert.equal(result.telemetry.invalidationKind, "hard");
  assert.equal(
    result.telemetry.hardInvalidationDisposition,
    "fail-closed-load-failed"
  );
  assert.equal(result.telemetry.hardInvalidationTargetsExcluded, true);
  assert.equal(result.telemetry.hardInvalidationStaleSnapshotServed, false);
  assert.match(
    result.telemetry.degradedReason ?? "",
    /authority refresh unavailable/
  );
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

function buildEntry(
  id: string,
  overrides: Partial<MemoryEntry> = {}
): MemoryEntry {
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
    ...overrides,
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
