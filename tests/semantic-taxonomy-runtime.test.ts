import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  SemanticTaxonomyRuntime,
  type SemanticEmbeddingRuntimeTelemetry,
  type SemanticTaxonomyEmbeddingSchedule,
  type SemanticTaxonomyWorkerLike,
} from "../src/lib/meeting/semantic-taxonomy-runtime.js";
import { SEMANTIC_TAXONOMY_MODEL_VERSION } from "../src/lib/meeting/semantic-taxonomy-model.js";
import type {
  SemanticTaxonomyEmbeddingInput,
  SemanticTaxonomyWorkerRequest,
  SemanticTaxonomyWorkerResponse,
} from "../src/lib/meeting/semantic-taxonomy-runtime.protocol.js";

class FakeSemanticWorker implements SemanticTaxonomyWorkerLike {
  onmessage:
    | ((event: MessageEvent<SemanticTaxonomyWorkerResponse>) => void)
    | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  embedCount = 0;
  activeEmbedCount = 0;
  maxActiveEmbedCount = 0;
  deferredEmbeds = new Map<string, SemanticTaxonomyWorkerRequest>();
  deferredInitialize?: Extract<
    SemanticTaxonomyWorkerRequest,
    { type: "initialize" }
  >;

  constructor(
    private readonly deferEmbeds = false,
    private readonly deferInitialize = false,
    private readonly embeddingForTexts: (texts: string[]) => number[][] =
      (texts) => texts.map(() => [1, 0, 0])
  ) {}

  postMessage(message: SemanticTaxonomyWorkerRequest) {
    if (message.type === "initialize") {
      if (this.deferInitialize) {
        this.deferredInitialize = message;
        return;
      }
      queueMicrotask(() =>
        this.emit({
          type: "ready",
          requestId: message.requestId,
          modelVersion: "test-model",
          durationMs: 12,
        })
      );
      return;
    }
    if (message.type === "dispose") {
      queueMicrotask(() =>
        this.emit({ type: "disposed", requestId: message.requestId })
      );
      return;
    }
    this.embedCount += 1;
    this.activeEmbedCount += 1;
    this.maxActiveEmbedCount = Math.max(
      this.maxActiveEmbedCount,
      this.activeEmbedCount
    );
    if (this.deferEmbeds) {
      this.deferredEmbeds.set(message.requestId, message);
      return;
    }
    queueMicrotask(() => {
      this.activeEmbedCount -= 1;
      this.emit({
        type: "embedding",
        requestId: message.requestId,
        input: message.input,
        embeddings: this.embeddingForTexts(message.input.texts),
        durationMs: 8,
      });
    });
  }

  completeDeferredInitialize() {
    const request = this.deferredInitialize;
    if (!request) return false;
    this.deferredInitialize = undefined;
    this.emit({
      type: "ready",
      requestId: request.requestId,
      modelVersion: "test-model",
      durationMs: 12,
    });
    return true;
  }

  triggerError(message: string) {
    this.onerror?.({ message } as ErrorEvent);
  }

  completeNextDeferredEmbed() {
    const next = this.deferredEmbeds.entries().next().value as
      | [string, SemanticTaxonomyWorkerRequest]
      | undefined;
    if (!next) return false;
    const [requestId, request] = next;
    this.deferredEmbeds.delete(requestId);
    if (request.type !== "embed") return false;
    this.activeEmbedCount -= 1;
    this.emit({
      type: "embedding",
      requestId,
      input: request.input,
      embeddings: this.embeddingForTexts(request.input.texts),
      durationMs: 8,
    });
    return true;
  }

  completeDeferredEmbeds() {
    while (this.completeNextDeferredEmbed()) {
      // Drain responses in submission order.
    }
  }

  terminate() {
    this.terminated = true;
  }

  private emit(response: SemanticTaxonomyWorkerResponse) {
    this.onmessage?.({ data: response } as MessageEvent<SemanticTaxonomyWorkerResponse>);
  }
}

function embeddingInput(turnId: string, text = turnId) {
  return {
    sessionId: "meeting-1",
    runtimeEpoch: 1,
    turnId,
    texts: [text],
    kind: "query" as const,
  };
}

function embeddingSchedule(
  revision: number,
  overrides: Partial<SemanticTaxonomyEmbeddingSchedule> = {}
): SemanticTaxonomyEmbeddingSchedule {
  return {
    consumer: "interviewer-intent",
    coalescingKey: "meeting-1:current-question",
    revision,
    ...overrides,
  };
}

function cachedKeys(runtime: SemanticTaxonomyRuntime): string[] {
  return Array.from(
    (runtime as unknown as { embeddingCache: Map<string, number[][]> })
      .embeddingCache.keys()
  );
}

function normalizeCacheText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function exactCacheKey(input: Pick<SemanticTaxonomyEmbeddingInput, "kind" | "texts">): string {
  return JSON.stringify([
    SEMANTIC_TAXONOMY_MODEL_VERSION,
    input.kind,
    input.texts.map(normalizeCacheText),
  ]);
}

function legacyCacheKey(input: Pick<SemanticTaxonomyEmbeddingInput, "kind" | "texts">): string {
  const normalized = input.texts.map(normalizeCacheText).join("\u001f");
  const value = `${SEMANTIC_TAXONOMY_MODEL_VERSION}\u001e${input.kind}\u001e${normalized}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${input.kind}:${(hash >>> 0).toString(16)}`;
}

function assertCacheSnapshot(runtime: SemanticTaxonomyRuntime, expectedCount: number) {
  const snapshot = runtime.getSnapshot();
  const keys = cachedKeys(runtime);
  assert.equal(snapshot.embeddingCacheEntryCount, expectedCount);
  assert.equal(keys.length, expectedCount);
  assert.equal(
    snapshot.embeddingCacheKeyCodeUnits,
    keys.reduce((sum, key) => sum + key.length, 0)
  );
  assert.ok(snapshot.embeddingCacheEntryCount <= 256);
}

test("prewarms once and returns embeddings only for the active session identity", async () => {
  const worker = new FakeSemanticWorker();
  const runtime = new SemanticTaxonomyRuntime({ workerFactory: () => worker });
  runtime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 2 });

  const firstWarmup = await runtime.prewarm();
  const secondWarmup = await runtime.prewarm();
  assert.equal(firstWarmup.readiness, "ready");
  assert.equal(secondWarmup.readiness, "ready");

  const result = await runtime.embed({
    sessionId: "meeting-1",
    runtimeEpoch: 2,
    turnId: "turn-1",
    texts: ["explain vector search"],
    kind: "query",
  }, embeddingSchedule(1));
  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.deepEqual(result.embeddings, [[1, 0, 0]]);
    assert.equal(result.cacheHit, false);
    assert.equal(result.telemetry.deadlineProfile, "cold");
    assert.equal(result.telemetry.computeMs, 8);
  }

  const cached = await runtime.embed({
    sessionId: "meeting-1",
    runtimeEpoch: 2,
    turnId: "turn-2",
    texts: ["  Explain   Vector Search  "],
    kind: "query",
  }, embeddingSchedule(2));
  assert.equal(cached.status, "success");
  if (cached.status === "success") {
    assert.equal(cached.cacheHit, true);
    assert.equal(cached.telemetry.deadlineProfile, "cache");
  }

  const warm = await runtime.embed({
    sessionId: "meeting-1",
    runtimeEpoch: 2,
    turnId: "turn-3",
    texts: ["compare vector and lexical search"],
    kind: "query",
  }, embeddingSchedule(3));
  assert.equal(warm.status, "success");
  if (warm.status === "success") {
    assert.equal(warm.telemetry.deadlineProfile, "warm");
  }
  assert.equal(worker.embedCount, 2);
});

test("separates known legacy hash collisions through the embedding consumer", async () => {
  const firstText = "audit-1vqgez7-1y0t";
  const secondText = "audit-1yrx0pg-3d8s";
  const worker = new FakeSemanticWorker(false, false, (texts) =>
    texts.map((text) => text === firstText ? [1, 0] : [0, 1])
  );
  const runtime = new SemanticTaxonomyRuntime({ workerFactory: () => worker });
  runtime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 1 });
  await runtime.prewarm();

  assert.equal(legacyCacheKey(embeddingInput("a", firstText)), "query:a66f498");
  assert.equal(legacyCacheKey(embeddingInput("b", secondText)), "query:a66f498");

  for (const [revision, text, vector, cacheHit] of [
    [1, firstText, [1, 0], false],
    [2, secondText, [0, 1], false],
    [3, firstText, [1, 0], true],
    [4, secondText, [0, 1], true],
  ] as const) {
    const result = await runtime.embed(
      embeddingInput(`turn-${revision}`, text),
      embeddingSchedule(revision)
    );
    assert.equal(result.status, "success");
    if (result.status === "success") {
      assert.deepEqual(result.embeddings, [vector]);
      assert.equal(result.cacheHit, cacheHit);
      assert.equal(result.telemetry.outcome, cacheHit ? "cache-hit" : "success");
    }
  }
  assert.equal(worker.embedCount, 2);
  assertCacheSnapshot(runtime, 2);
});

test("keeps model, kind, array boundaries, order, escapes and normalization in cache identity", async () => {
  const seenWorkerTexts: string[][] = [];
  const worker = new FakeSemanticWorker(false, false, (texts) => {
    seenWorkerTexts.push(texts);
    return texts.map(() => [1]);
  });
  const runtime = new SemanticTaxonomyRuntime({ workerFactory: () => worker });
  runtime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 1 });
  await runtime.prewarm();

  const distinctInputs: Array<Pick<SemanticTaxonomyEmbeddingInput, "kind" | "texts">> = [
    { kind: "query", texts: [] },
    { kind: "query", texts: [""] },
    { kind: "query", texts: ["a\u001fb"] },
    { kind: "query", texts: ["a", "b"] },
    { kind: "query", texts: ["left", "right"] },
    { kind: "query", texts: ["right", "left"] },
    { kind: "query", texts: ["a\"b", "c\\d"] },
    { kind: "query", texts: ["mixed case"] },
    { kind: "passage", texts: ["mixed case"] },
  ];
  assert.equal(legacyCacheKey(distinctInputs[0]!), legacyCacheKey(distinctInputs[1]!));
  assert.equal(legacyCacheKey(distinctInputs[2]!), legacyCacheKey(distinctInputs[3]!));

  for (const [index, input] of distinctInputs.entries()) {
    const result = await runtime.embed(
      { ...embeddingInput(`turn-${index}`), ...input },
      embeddingSchedule(index + 1)
    );
    assert.equal(result.status, "success");
    if (result.status === "success") assert.equal(result.cacheHit, false);
    assertCacheSnapshot(runtime, index + 1);
  }
  assert.equal(worker.embedCount, distinctInputs.length);
  assert.deepEqual(seenWorkerTexts, distinctInputs.map((input) => input.texts));
  assert.deepEqual(cachedKeys(runtime), distinctInputs.map(exactCacheKey));
  assert.deepEqual(JSON.parse(cachedKeys(runtime)[0]!), [
    SEMANTIC_TAXONOMY_MODEL_VERSION,
    "query",
    [],
  ]);

  const normalized = await runtime.embed(
    embeddingInput("normalized", "  MIXED \t Case  "),
    embeddingSchedule(distinctInputs.length + 1)
  );
  assert.equal(normalized.status, "success");
  if (normalized.status === "success") assert.equal(normalized.cacheHit, true);
  assert.equal(worker.embedCount, distinctInputs.length);
  assertCacheSnapshot(runtime, distinctInputs.length);
  assert.equal(JSON.stringify(runtime.getSnapshot()).includes("mixed case"), false);
});

test("preserves legacy cache outcomes for non-colliding consumer inputs", async () => {
  const embeddingForTexts = (texts: string[]) =>
    texts.map((text) => [text.length, text.charCodeAt(0) || 0]);
  const worker = new FakeSemanticWorker(false, false, embeddingForTexts);
  const runtime = new SemanticTaxonomyRuntime({ workerFactory: () => worker });
  const legacyCache = new Map<string, number[][]>();
  runtime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 1 });
  await runtime.prewarm();

  const sequence: Array<Pick<SemanticTaxonomyEmbeddingInput, "kind" | "texts">> = [
    { kind: "query", texts: ["alpha"] },
    { kind: "query", texts: [" ALPHA "] },
    { kind: "query", texts: ["beta"] },
    { kind: "passage", texts: ["beta"] },
    { kind: "query", texts: ["left", "right"] },
    { kind: "query", texts: ["right", "left"] },
    { kind: "query", texts: ["alpha"] },
    { kind: "passage", texts: ["beta"] },
  ];
  let expectedWorkerCalls = 0;
  for (const [index, input] of sequence.entries()) {
    const key = legacyCacheKey(input);
    const expectedHit = legacyCache.has(key);
    const embeddings = legacyCache.get(key) ?? embeddingForTexts(input.texts);
    if (!expectedHit) expectedWorkerCalls += 1;
    legacyCache.delete(key);
    legacyCache.set(key, embeddings);

    const result = await runtime.embed(
      { ...embeddingInput(`turn-${index}`), ...input },
      embeddingSchedule(index + 1)
    );
    assert.equal(result.status, "success");
    if (result.status === "success") {
      assert.deepEqual(result.embeddings, embeddings);
      assert.equal(result.cacheHit, expectedHit);
      assert.equal(result.telemetry.outcome, expectedHit ? "cache-hit" : "success");
    }
    assert.equal(worker.embedCount, expectedWorkerCalls);
  }
  assertCacheSnapshot(runtime, legacyCache.size);
});

test("bounds LRU at 256 entries and keeps admission ahead of cache hits", async () => {
  const workers: FakeSemanticWorker[] = [];
  const runtime = new SemanticTaxonomyRuntime({
    workerFactory: () => {
      const worker = new FakeSemanticWorker();
      workers.push(worker);
      return worker;
    },
  });
  runtime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 1 });
  await runtime.prewarm();
  assertCacheSnapshot(runtime, 0);

  let revision = 0;
  const submit = (text: string, identity = { sessionId: "meeting-1", runtimeEpoch: 1 }) =>
    runtime.embed(
      { ...embeddingInput(`turn-${++revision}`, text), ...identity },
      embeddingSchedule(revision)
    );
  await submit("item-0");
  assertCacheSnapshot(runtime, 1);
  for (let index = 1; index < 256; index += 1) {
    await submit(`item-${index}`);
  }
  assertCacheSnapshot(runtime, 256);
  assert.equal(workers[0]!.embedCount, 256);

  const recentlyUsed = await submit("item-0");
  assert.equal(recentlyUsed.status, "success");
  if (recentlyUsed.status === "success") assert.equal(recentlyUsed.cacheHit, true);
  await submit("item-256");
  assertCacheSnapshot(runtime, 256);
  assert.ok(cachedKeys(runtime).includes(exactCacheKey(embeddingInput("x", "item-0"))));
  assert.equal(cachedKeys(runtime).includes(exactCacheKey(embeddingInput("x", "item-1"))), false);
  assert.equal(workers[0]!.embedCount, 257);

  const kept = await submit("item-0");
  assert.equal(kept.status, "success");
  if (kept.status === "success") assert.equal(kept.cacheHit, true);
  const evicted = await submit("item-1");
  assert.equal(evicted.status, "success");
  if (evicted.status === "success") assert.equal(evicted.cacheHit, false);
  assert.equal(workers[0]!.embedCount, 258);
  assertCacheSnapshot(runtime, 256);

  runtime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 2 });
  const staleEpoch = await submit("item-0");
  assert.equal(staleEpoch.status, "stale");
  assert.equal(staleEpoch.telemetry.outcome, "stale");
  assert.equal(workers[0]!.embedCount, 258);
  const cachedNewEpoch = await submit("item-0", { sessionId: "meeting-1", runtimeEpoch: 2 });
  assert.equal(cachedNewEpoch.status, "success");
  if (cachedNewEpoch.status === "success") assert.equal(cachedNewEpoch.cacheHit, true);
  const staleSession = await submit("item-0", { sessionId: "meeting-other", runtimeEpoch: 2 });
  assert.equal(staleSession.status, "stale");
  assert.equal(workers[0]!.embedCount, 258);
  const duplicateRevision = await runtime.embed(
    { ...embeddingInput("duplicate", "item-0"), runtimeEpoch: 2 },
    embeddingSchedule(revision - 1)
  );
  assert.equal(duplicateRevision.status, "stale");
  assert.equal(workers[0]!.embedCount, 258);

  await runtime.dispose("test-clear");
  assertCacheSnapshot(runtime, 0);
  runtime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 3 });
  const afterClear = await submit("item-0", { sessionId: "meeting-1", runtimeEpoch: 3 });
  assert.equal(afterClear.status, "success");
  if (afterClear.status === "success") assert.equal(afterClear.cacheHit, false);
  assert.equal(workers.length, 2);
  assert.equal(workers[1]!.embedCount, 1);
  assertCacheSnapshot(runtime, 1);
});

test("does not cache an old-epoch worker response after admission changes", async () => {
  const worker = new FakeSemanticWorker(true);
  const runtime = new SemanticTaxonomyRuntime({ workerFactory: () => worker });
  runtime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 1 });
  await runtime.prewarm();

  const old = runtime.embed(embeddingInput("old", "shared text"), embeddingSchedule(1));
  runtime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 2 });
  const stale = await old;
  assert.equal(stale.status, "stale");
  assert.equal(worker.completeNextDeferredEmbed(), true);
  assertCacheSnapshot(runtime, 0);

  const fresh = runtime.embed(
    { ...embeddingInput("fresh", "shared text"), runtimeEpoch: 2 },
    embeddingSchedule(2)
  );
  assert.equal(worker.embedCount, 2);
  assert.equal(worker.completeNextDeferredEmbed(), true);
  const result = await fresh;
  assert.equal(result.status, "success");
  if (result.status === "success") assert.equal(result.cacheHit, false);
  assertCacheSnapshot(runtime, 1);
});

test("drops a deferred embedding when the runtime epoch changes", async () => {
  const worker = new FakeSemanticWorker(true);
  const runtime = new SemanticTaxonomyRuntime({ workerFactory: () => worker });
  runtime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 1 });
  await runtime.prewarm();

  const pending = runtime.embed(
    {
      sessionId: "meeting-1",
      runtimeEpoch: 1,
      turnId: "turn-old",
      texts: ["old question"],
      kind: "query",
    },
    embeddingSchedule(1, {
      deadlines: {
        coldComputeMs: 1_000,
        warmComputeMs: 1_000,
      },
    })
  );
  runtime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 2 });
  const result = await pending;
  assert.equal(result.status, "stale");
  if (result.status === "stale") {
    assert.equal(result.reason, "session-or-epoch-changed");
  }

  worker.completeDeferredEmbeds();
  assert.equal(runtime.readiness(), "ready");
});

test("fails open when the model is unavailable or an active compute times out", async () => {
  const coldRuntime = new SemanticTaxonomyRuntime();
  coldRuntime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 1 });
  const cold = await coldRuntime.embed(
    embeddingInput("turn-cold", "question"),
    embeddingSchedule(1)
  );
  assert.equal(cold.status, "unavailable");
  assert.equal(coldRuntime.getSnapshot().coldFallbackCount, 1);

  const stalledWorker = new FakeSemanticWorker(true);
  const stalledRuntime = new SemanticTaxonomyRuntime({
    workerFactory: () => stalledWorker,
  });
  stalledRuntime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 1 });
  await stalledRuntime.prewarm();
  const timedOut = await stalledRuntime.embed(
    embeddingInput("turn-timeout", "question"),
    embeddingSchedule(1, {
      deadlines: {
        coldComputeMs: 1,
        warmComputeMs: 1,
      },
    })
  );
  assert.equal(timedOut.status, "timeout");
  assert.equal(timedOut.telemetry.deadlinePhase, "compute");
  assert.equal(timedOut.telemetry.abandoned, true);
  await stalledRuntime.dispose("test-complete");
});

test("does not post the next compute until a timed-out active result arrives", async () => {
  const worker = new FakeSemanticWorker(true);
  const events: SemanticEmbeddingRuntimeTelemetry[] = [];
  const runtime = new SemanticTaxonomyRuntime({
    workerFactory: () => worker,
  });
  runtime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 1 });
  await runtime.prewarm();

  const first = runtime.embed(
    embeddingInput("turn-1"),
    embeddingSchedule(1, {
      deadlines: { coldComputeMs: 2, warmComputeMs: 2 },
      onTelemetry: (event) => events.push(event),
    })
  );
  const second = runtime.embed(
    embeddingInput("answer-1"),
    embeddingSchedule(1, {
      consumer: "answer-sufficiency",
      coalescingKey: "meeting-1:latest-answer",
      deadlines: { coldComputeMs: 100, warmComputeMs: 100 },
      onTelemetry: (event) => events.push(event),
    })
  );

  const firstResult = await first;
  assert.equal(firstResult.status, "timeout");
  assert.equal(worker.embedCount, 1);
  assert.equal(worker.maxActiveEmbedCount, 1);

  worker.completeNextDeferredEmbed();
  assert.equal(worker.embedCount, 2);
  assert.ok(
    events.some(
      (event) =>
        event.requestId === firstResult.telemetry.requestId &&
        event.outcome === "abandoned" &&
        event.event === "late-result"
    )
  );

  worker.completeNextDeferredEmbed();
  const secondResult = await second;
  assert.equal(secondResult.status, "success");
  assert.equal(worker.maxActiveEmbedCount, 1);
});

test("recycles a permanently hung worker and completes the next queued request", async () => {
  const hungWorker = new FakeSemanticWorker(true);
  const replacementWorker = new FakeSemanticWorker();
  const workers = [hungWorker, replacementWorker];
  const events: SemanticEmbeddingRuntimeTelemetry[] = [];
  let workerFactoryCalls = 0;
  const runtime = new SemanticTaxonomyRuntime({
    workerFactory: () => workers[workerFactoryCalls++]!,
    hardStallGraceMs: 2,
  });
  runtime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 1 });
  await runtime.prewarm();

  const hung = runtime.embed(
    embeddingInput("turn-hung"),
    embeddingSchedule(1, {
      deadlines: {
        coldComputeMs: 2,
        warmComputeMs: 2,
        coldQueueWaitMs: 100,
        warmQueueWaitMs: 100,
      },
      onTelemetry: (event) => events.push(event),
    })
  );
  const hungResult = await hung;
  assert.equal(hungResult.status, "timeout");

  const next = runtime.embed(
    embeddingInput("turn-after-recycle"),
    embeddingSchedule(2, {
      deadlines: {
        coldComputeMs: 100,
        warmComputeMs: 20,
        coldQueueWaitMs: 100,
        warmQueueWaitMs: 100,
      },
      onTelemetry: (event) => events.push(event),
    })
  );
  const nextResult = await next;

  assert.equal(nextResult.status, "success");
  assert.equal(hungWorker.terminated, true);
  assert.equal(workerFactoryCalls, 2);
  assert.equal(nextResult.telemetry.deadlineProfile, "cold");
  assert.ok(
    events.some(
      (event) =>
        event.requestId === hungResult.telemetry.requestId &&
        event.event === "recycled" &&
        event.outcome === "recycled"
    )
  );
});

test("ignores late messages from a recycled worker generation", async () => {
  const hungWorker = new FakeSemanticWorker(true);
  const replacementWorker = new FakeSemanticWorker();
  const workers = [hungWorker, replacementWorker];
  const events: SemanticEmbeddingRuntimeTelemetry[] = [];
  let workerFactoryCalls = 0;
  const runtime = new SemanticTaxonomyRuntime({
    workerFactory: () => workers[workerFactoryCalls++]!,
    hardStallGraceMs: 2,
  });
  runtime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 1 });
  await runtime.prewarm();

  const firstResult = await runtime.embed(
    embeddingInput("turn-old-generation"),
    embeddingSchedule(1, {
      deadlines: {
        coldComputeMs: 2,
        warmComputeMs: 2,
        coldQueueWaitMs: 100,
        warmQueueWaitMs: 100,
      },
      onTelemetry: (event) => events.push(event),
    })
  );
  assert.equal(firstResult.status, "timeout");

  const nextResult = await runtime.embed(
    embeddingInput("turn-new-generation"),
    embeddingSchedule(2, {
      deadlines: {
        coldComputeMs: 100,
        warmComputeMs: 20,
        coldQueueWaitMs: 100,
        warmQueueWaitMs: 100,
      },
      onTelemetry: (event) => events.push(event),
    })
  );
  assert.equal(nextResult.status, "success");
  const eventCountBeforeLateMessage = events.length;

  assert.equal(hungWorker.completeNextDeferredEmbed(), true);
  await Promise.resolve();

  assert.equal(events.length, eventCountBeforeLateMessage);
  assert.equal(runtime.readiness(), "ready");
  assert.equal(replacementWorker.embedCount, 1);
});

test("uses a cold compute deadline after worker failure and restart", async () => {
  const firstWorker = new FakeSemanticWorker();
  const replacementWorker = new FakeSemanticWorker();
  const workers = [firstWorker, replacementWorker];
  let workerFactoryCalls = 0;
  const runtime = new SemanticTaxonomyRuntime({
    workerFactory: () => workers[workerFactoryCalls++]!,
  });
  runtime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 1 });
  await runtime.prewarm();

  const warmupCompute = await runtime.embed(
    embeddingInput("turn-before-failure"),
    embeddingSchedule(1)
  );
  assert.equal(warmupCompute.status, "success");
  firstWorker.triggerError("worker-crashed");
  assert.equal(runtime.readiness(), "failed");

  const restarted = await runtime.embed(
    embeddingInput("turn-after-failure"),
    embeddingSchedule(2, {
      deadlines: {
        coldComputeMs: 100,
        warmComputeMs: 1,
      },
    })
  );

  assert.equal(restarted.status, "success");
  assert.equal(restarted.telemetry.deadlineProfile, "cold");
  assert.equal(workerFactoryCalls, 2);
});

test("dispose after caller timeout records cancellation without a fake late result", async () => {
  const worker = new FakeSemanticWorker(true);
  const events: SemanticEmbeddingRuntimeTelemetry[] = [];
  const runtime = new SemanticTaxonomyRuntime({
    workerFactory: () => worker,
    hardStallGraceMs: 1_000,
  });
  runtime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 1 });
  await runtime.prewarm();

  const result = await runtime.embed(
    embeddingInput("turn-timeout-before-dispose"),
    embeddingSchedule(1, {
      deadlines: {
        coldComputeMs: 2,
        warmComputeMs: 2,
      },
      onTelemetry: (event) => events.push(event),
    })
  );
  assert.equal(result.status, "timeout");

  await runtime.dispose("test-dispose");
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(
    events.some((event) => event.event === "late-result"),
    false
  );
  assert.ok(
    events.some(
      (event) =>
        event.event === "cancelled" &&
        event.outcome === "cancelled" &&
        event.reason === "runtime-disposed"
    )
  );
});

test("dispose wins over an in-flight initialize generation", async () => {
  const worker = new FakeSemanticWorker(false, true);
  const runtime = new SemanticTaxonomyRuntime({
    workerFactory: () => worker,
  });
  runtime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 1 });

  const prewarm = runtime.prewarm();
  await runtime.dispose("dispose-during-initialize");
  const snapshot = await prewarm;
  worker.completeDeferredInitialize();
  await Promise.resolve();

  assert.equal(snapshot.readiness, "disposed");
  assert.equal(runtime.readiness(), "disposed");
});

test("applies queue-wait and compute deadlines as separate phases", async () => {
  const worker = new FakeSemanticWorker(true);
  const runtime = new SemanticTaxonomyRuntime({
    workerFactory: () => worker,
  });
  runtime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 1 });
  await runtime.prewarm();

  const active = runtime.embed(
    embeddingInput("turn-active"),
    embeddingSchedule(1, {
      deadlines: { coldComputeMs: 100, warmComputeMs: 100 },
    })
  );
  const queued = runtime.embed(
    embeddingInput("answer-queued"),
    embeddingSchedule(1, {
      consumer: "answer-sufficiency",
      coalescingKey: "meeting-1:latest-answer",
      deadlines: { coldQueueWaitMs: 2, warmQueueWaitMs: 2 },
    })
  );

  const queuedResult = await queued;
  assert.equal(queuedResult.status, "timeout");
  assert.equal(queuedResult.telemetry.deadlinePhase, "queue");
  assert.equal(worker.embedCount, 1);

  worker.completeNextDeferredEmbed();
  const activeResult = await active;
  assert.equal(activeResult.status, "success");
  assert.equal(worker.embedCount, 1);
});

test("keeps only the newest queued revision for a consumer key", async () => {
  const worker = new FakeSemanticWorker(true);
  const runtime = new SemanticTaxonomyRuntime({
    workerFactory: () => worker,
  });
  runtime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 1 });
  await runtime.prewarm();

  const first = runtime.embed(
    embeddingInput("turn-1"),
    embeddingSchedule(1)
  );
  const second = runtime.embed(
    embeddingInput("turn-2"),
    embeddingSchedule(2)
  );
  const third = runtime.embed(
    embeddingInput("turn-3"),
    embeddingSchedule(3)
  );
  const lateOlder = runtime.embed(
    embeddingInput("turn-late-older"),
    embeddingSchedule(2)
  );

  const [firstResult, secondResult, lateOlderResult] = await Promise.all([
    first,
    second,
    lateOlder,
  ]);
  assert.equal(firstResult.status, "stale");
  assert.equal(firstResult.telemetry.outcome, "coalesced");
  assert.equal(secondResult.status, "stale");
  assert.equal(secondResult.telemetry.outcome, "coalesced");
  assert.equal(lateOlderResult.status, "stale");
  if (lateOlderResult.status === "stale") {
    assert.equal(
      lateOlderResult.reason,
      "older-or-duplicate-submitted-revision"
    );
  }
  assert.equal(worker.embedCount, 1);
  assert.equal(runtime.getSnapshot().queueDepth, 1);

  worker.completeNextDeferredEmbed();
  assert.equal(worker.embedCount, 2);
  worker.completeNextDeferredEmbed();
  const thirdResult = await third;
  assert.equal(thirdResult.status, "success");
  assert.equal(thirdResult.input.turnId, "turn-3");
  assert.equal(worker.maxActiveEmbedCount, 1);
});

test("bounds sustained multi-consumer load while submissions remain non-blocking", async () => {
  const worker = new FakeSemanticWorker(true);
  const events: SemanticEmbeddingRuntimeTelemetry[] = [];
  const runtime = new SemanticTaxonomyRuntime({
    workerFactory: () => worker,
    maxQueuedRequests: 3,
  });
  runtime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 1 });
  await runtime.prewarm();

  let advisorHotPathReached = false;
  const requests: Array<Promise<unknown>> = [];
  for (let revision = 1; revision <= 40; revision += 1) {
    const interviewerIntent = revision % 2 === 1;
    requests.push(
      runtime.embed(
        embeddingInput(`turn-${revision}`),
        embeddingSchedule(revision, {
          consumer: interviewerIntent
            ? "interviewer-intent"
            : "answer-sufficiency",
          coalescingKey: interviewerIntent
            ? `question-${revision % 4}`
            : `answer-${revision % 4}`,
          onTelemetry: (event) => events.push(event),
        })
      )
    );
    advisorHotPathReached = true;
    assert.ok(runtime.getSnapshot().queueDepth <= 3);
  }

  assert.equal(advisorHotPathReached, true);
  assert.equal(worker.embedCount, 1);
  assert.equal(worker.maxActiveEmbedCount, 1);
  worker.completeDeferredEmbeds();
  await Promise.all(requests);

  assert.ok(runtime.getSnapshot().maxQueueDepth <= 3);
  assert.equal(worker.maxActiveEmbedCount, 1);
  assert.ok(events.some((event) => event.coalesced || event.stale));
  assert.ok(events.some((event) => event.outcome === "abandoned"));
});

test("keeps the worker warm through audio recovery and disposes after idle grace", async () => {
  const worker = new FakeSemanticWorker();
  const runtime = new SemanticTaxonomyRuntime({
    workerFactory: () => worker,
    idleGraceMs: 1,
  });
  runtime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 1 });
  await runtime.prewarm();

  runtime.releaseSession({ recoveryTokenActive: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(runtime.readiness(), "ready");
  assert.equal(worker.terminated, false);

  runtime.pinSession(
    { sessionId: "meeting-1", runtimeEpoch: 1 },
    "fatal-audio-resume"
  );
  assert.equal(runtime.getSnapshot().reusedAfterAudioRecovery, true);
  runtime.releaseSession({ recoveryTokenActive: false });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(runtime.readiness(), "disposed");
  assert.equal(worker.terminated, true);
});

test("compares legacy and tuple cache key CPU and character payload in Node", (t) => {
  type CacheInput = Pick<SemanticTaxonomyEmbeddingInput, "kind" | "texts">;
  type KeyFunction = (input: CacheInput) => string;
  const median = (samples: number[]) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(4));
  };
  const measure = (inputs: CacheInput[], batches: number, keyOf: KeyFunction) => {
    const construct: number[] = [];
    const hitLru: number[] = [];
    const insert: number[] = [];
    const constructAndHit: number[] = [];
    const sampleKeys = inputs.map(keyOf);
    assert.equal(new Set(sampleKeys).size, 256);

    for (let batch = 0; batch < batches; batch += 1) {
      let started = performance.now();
      const keys = inputs.map(keyOf);
      construct.push(performance.now() - started);

      const hitMap = new Map(keys.map((key) => [key, 1]));
      started = performance.now();
      for (const key of keys) {
        const value = hitMap.get(key);
        if (value === undefined) throw new Error("benchmark seed missing");
        hitMap.delete(key);
        hitMap.set(key, value);
      }
      hitLru.push(performance.now() - started);

      const insertMap = new Map<string, number>();
      started = performance.now();
      for (const key of keys) insertMap.set(key, 1);
      insert.push(performance.now() - started);
      assert.equal(insertMap.size, 256);

      started = performance.now();
      for (const input of inputs) {
        const key = keyOf(input);
        const value = hitMap.get(key);
        if (value === undefined) throw new Error("benchmark lookup missing");
        hitMap.delete(key);
        hitMap.set(key, value);
      }
      constructAndHit.push(performance.now() - started);
    }

    return {
      medianBatchMs: {
        construct: median(construct),
        hitLru: median(hitLru),
        insert: median(insert),
        constructAndHit: median(constructAndHit),
      },
      keyCodeUnits: sampleKeys.reduce((sum, key) => sum + key.length, 0),
    };
  };

  for (const [scenario, sizes, batches] of [
    ["single-1600", [1596], 101],
    ["pair-1200-1600", [1196, 1596], 101],
    ["long-single-16000", [15996], 9],
  ] as const) {
    const inputs: CacheInput[] = Array.from({ length: 256 }, (_, index) => ({
      kind: "query",
      texts: sizes.map((size, position) =>
        `${String.fromCharCode(97 + position).repeat(size)}${String(index).padStart(4, "0")}`
      ),
    }));
    const legacy = measure(inputs, batches, legacyCacheKey);
    const tuple = measure(inputs, batches, exactCacheKey);
    assert.ok(tuple.keyCodeUnits > legacy.keyCodeUnits);
    t.diagnostic(JSON.stringify({
      environment: `Node ${process.version}`,
      scenario,
      batches,
      batchSize: inputs.length,
      legacy,
      tuple,
      estimatedUtf16PayloadBytes: {
        legacy: legacy.keyCodeUnits * 2,
        tuple: tuple.keyCodeUnits * 2,
      },
    }));
  }
});
