import assert from "node:assert/strict";
import test from "node:test";
import {
  SemanticTaxonomyRuntime,
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
  deferredEmbeds = new Map<string, SemanticTaxonomyWorkerRequest>();

  constructor(private readonly deferEmbeds = false) {}

  postMessage(message: SemanticTaxonomyWorkerRequest) {
    if (message.type === "initialize") {
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
    if (this.deferEmbeds) {
      this.deferredEmbeds.set(message.requestId, message);
      return;
    }
    this.embedCount += 1;
    queueMicrotask(() =>
      this.emit({
        type: "embedding",
        requestId: message.requestId,
        input: message.input,
        embeddings: message.input.texts.map(() => [1, 0, 0]),
        durationMs: 8,
      })
    );
  }

  completeDeferredEmbeds() {
    for (const [requestId, request] of this.deferredEmbeds) {
      if (request.type !== "embed") continue;
      this.emit({
        type: "embedding",
        requestId,
        input: request.input,
        embeddings: request.input.texts.map(() => [1, 0, 0]),
        durationMs: 8,
      });
    }
    this.deferredEmbeds.clear();
  }

  terminate() {
    this.terminated = true;
  }

  private emit(response: SemanticTaxonomyWorkerResponse) {
    this.onmessage?.({ data: response } as MessageEvent<SemanticTaxonomyWorkerResponse>);
  }
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
  });
  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.deepEqual(result.embeddings, [[1, 0, 0]]);
    assert.equal(result.cacheHit, false);
  }

  const cached = await runtime.embed({
    sessionId: "meeting-1",
    runtimeEpoch: 2,
    turnId: "turn-2",
    texts: ["  Explain   Vector Search  "],
    kind: "query",
  });
  assert.equal(cached.status, "success");
  if (cached.status === "success") assert.equal(cached.cacheHit, true);
  assert.equal(worker.embedCount, 1);
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
    1_000
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

test("fails open when the model is cold or a worker response times out", async () => {
  const coldWorker = new FakeSemanticWorker();
  const coldRuntime = new SemanticTaxonomyRuntime({
    workerFactory: () => coldWorker,
  });
  coldRuntime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 1 });
  const cold = await coldRuntime.embed({
    sessionId: "meeting-1",
    runtimeEpoch: 1,
    turnId: "turn-cold",
    texts: ["question"],
    kind: "query",
  });
  assert.equal(cold.status, "unavailable");
  assert.equal(coldRuntime.getSnapshot().coldFallbackCount, 1);

  const stalledWorker = new FakeSemanticWorker(true);
  const stalledRuntime = new SemanticTaxonomyRuntime({
    workerFactory: () => stalledWorker,
  });
  stalledRuntime.pinSession({ sessionId: "meeting-1", runtimeEpoch: 1 });
  await stalledRuntime.prewarm();
  const timedOut = await stalledRuntime.embed(
    {
      sessionId: "meeting-1",
      runtimeEpoch: 1,
      turnId: "turn-timeout",
      texts: ["question"],
      kind: "query",
    },
    1
  );
  assert.equal(timedOut.status, "timeout");
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
