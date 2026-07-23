import assert from "node:assert/strict";
import test from "node:test";
import {
  SemanticTaxonomyRuntime,
  type SemanticEmbeddingRuntimeTelemetry,
  type SemanticTaxonomyEmbeddingSchedule,
  type SemanticTaxonomyWorkerLike,
} from "../src/lib/meeting/semantic-taxonomy-runtime.js";
import type {
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
    private readonly deferInitialize = false
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
        embeddings: message.input.texts.map(() => [1, 0, 0]),
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
      embeddings: request.input.texts.map(() => [1, 0, 0]),
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
