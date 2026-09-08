import assert from "node:assert/strict";
import test from "node:test";
import {
  AIResponseEventBuilder,
  boundAIResponseErrorText,
  classifyAIResponseHttpFailure,
  coordinateAIResponseAttempts,
  createAIResponseAttemptIdentity,
  normalizeAIResponseRetryPolicy,
  shouldLegacyYieldAIResponseFailure,
  type AIResponseEvent,
  type AIResponseExecutionIdentity,
} from "../src/lib/functions/ai-response-events.js";

const executionIdentity: AIResponseExecutionIdentity = {
  requestId: "request-1",
  executionPlanId: "plan-1",
  modelId: "model-1",
  sessionId: "session-1",
  runtimeEpoch: 4,
  logicalQuestionUnitId: "lqu-1",
  logicalQuestionRevision: 7,
};

test("bounded retry uses the original deadline and never starts after it", async () => {
  let now = 100;
  const calls: number[] = [];
  const events = await collectEvents(coordinateAIResponseAttempts({
    identity: executionIdentity,
    retryPolicy: { maxAttempts: 2, retryableFailureClasses: ["provider-http"] },
    readRetryDeadlineAt: () => 150,
    now: () => now,
    runAttempt: async function* (id) {
      calls.push(id.attemptNumber);
      now = 151;
      yield new AIResponseEventBuilder("provider-a", id).terminal({
        status: "failed", failureClass: "provider-http", retryable: true, statusCode: 503,
      });
    },
  }));
  assert.deepEqual(calls, [1]);
  const end = events.at(-1);
  assert.equal(end?.type === "terminal" && end.outcome.final, true);
});

test("bounded retry checks source liveness before a retry request", async () => {
  let current = true;
  const calls: number[] = [];
  const events = await collectEvents(coordinateAIResponseAttempts({
    identity: executionIdentity,
    retryPolicy: { maxAttempts: 2 },
    isExecutionCurrent: () => current,
    readRetryDeadlineAt: () => Date.now() + 1000,
    runAttempt: async function* (id) {
      calls.push(id.attemptNumber);
      current = false;
      yield new AIResponseEventBuilder("provider-a", id).terminal({
        status: "failed", failureClass: "transport", retryable: true,
      });
    },
  }));
  assert.deepEqual(calls, [1]);
  assert.equal(events.at(-1)?.type === "terminal" && (events.at(-1) as any).outcome.disposition, "stale");
});

function attemptIdentity(attemptNumber = 1, maxAttempts = 1) {
  return {
    ...executionIdentity,
    attemptId: `attempt-${attemptNumber}`,
    attemptNumber,
    maxAttempts,
  };
}

async function collectEvents(events: AsyncIterable<AIResponseEvent>) {
  const collected: AIResponseEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

test("builds content separately from exactly one successful terminal outcome", () => {
  const identity = attemptIdentity();
  const builder = new AIResponseEventBuilder("provider-a", identity, 100);
  const first = builder.content("hel", 110);
  const second = builder.content("lo", 120);
  const terminal = builder.terminal(
    { status: "success", retryable: false },
    130
  );

  assert.deepEqual(first, {
    type: "content-delta",
    content: "hel",
    index: 1,
    emittedAt: 110,
    requestId: "request-1",
    attemptId: "attempt-1",
    attemptNumber: 1,
  });
  assert.deepEqual(second, {
    type: "content-delta",
    content: "lo",
    index: 2,
    emittedAt: 120,
    requestId: "request-1",
    attemptId: "attempt-1",
    attemptNumber: 1,
  });
  assert.deepEqual(terminal, {
    type: "terminal",
    outcome: {
      status: "success",
      retryable: false,
      ...identity,
      final: true,
      disposition: "accepted",
      providerId: "provider-a",
      startedAt: 100,
      firstContentAt: 110,
      lastContentAt: 120,
      finishedAt: 130,
      chunkCount: 2,
      observedContentChars: 5,
      observedContentHash: "4f9f2cab",
      text: "hello",
    },
  });
  assert.throws(
    () => builder.terminal({ status: "empty", retryable: false }),
    /terminal outcome already emitted/
  );
});

test("keeps partial content out of a failed terminal outcome", () => {
  const builder = new AIResponseEventBuilder(
    "provider-a",
    attemptIdentity(),
    100
  );
  builder.content("partial", 110);
  const terminal = builder.terminal(
    {
      status: "failed",
      failureClass: "stream-read",
      retryable: true,
      safeErrorSummary: "stream interrupted",
    },
    120
  );

  assert.equal(terminal.type, "terminal");
  if (terminal.type !== "terminal") return;
  assert.equal(terminal.outcome.status, "failed");
  assert.equal(terminal.outcome.chunkCount, 1);
  assert.equal(terminal.outcome.lastContentAt, 110);
  assert.equal(terminal.outcome.observedContentChars, 7);
  assert.equal(terminal.outcome.observedContentHash, "c54d769a");
  assert.equal(terminal.outcome.text, undefined);
});

test("requires content for success and a failure class for failure", () => {
  assert.throws(
    () =>
      new AIResponseEventBuilder(
        "provider-a",
        attemptIdentity()
      ).terminal({
        status: "success",
        retryable: false,
      }),
    /requires content/
  );
  assert.throws(
    () =>
      new AIResponseEventBuilder(
        "provider-a",
        attemptIdentity()
      ).terminal({
        status: "failed",
        retryable: false,
      }),
    /requires a failure class/
  );
});

test("classifies HTTP failures and isolates legacy compatibility behavior", () => {
  assert.equal(classifyAIResponseHttpFailure(401), "authentication");
  assert.equal(classifyAIResponseHttpFailure(403), "authentication");
  assert.equal(classifyAIResponseHttpFailure(429), "rate-limit");
  assert.equal(classifyAIResponseHttpFailure(503), "provider-http");
  assert.equal(shouldLegacyYieldAIResponseFailure("rate-limit"), true);
  assert.equal(shouldLegacyYieldAIResponseFailure("configuration"), false);
  assert.equal(shouldLegacyYieldAIResponseFailure("unexpected"), false);
});

test("bounds provider error text before it enters diagnostic metadata", () => {
  const bounded = boundAIResponseErrorText(`  ${"x".repeat(1_100)}\nsecret `);
  assert.equal(bounded.length, 1_000);
  assert.equal(bounded.includes("\n"), false);
});

test("retries an explicitly retryable attempt without changing request identity", async () => {
  const events = await collectEvents(
    coordinateAIResponseAttempts({
      identity: executionIdentity,
      providerId: "provider-a",
      retryPolicy: { maxAttempts: 2 },
      runAttempt: async function* (identity) {
        const builder = new AIResponseEventBuilder("provider-a", identity);
        if (identity.attemptNumber === 1) {
          yield builder.terminal({
            status: "failed",
            failureClass: "transport",
            retryable: true,
          });
          return;
        }
        yield builder.content("answer");
        yield builder.terminal({ status: "success", retryable: false });
      },
    })
  );

  const terminals = events.filter((event) => event.type === "terminal");
  assert.equal(terminals.length, 2);
  assert.equal(terminals[0]?.type, "terminal");
  assert.equal(terminals[1]?.type, "terminal");
  if (terminals[0]?.type !== "terminal" || terminals[1]?.type !== "terminal") {
    return;
  }
  assert.equal(terminals[0].outcome.requestId, "request-1");
  assert.equal(terminals[0].outcome.attemptNumber, 1);
  assert.equal(terminals[0].outcome.final, false);
  assert.equal(terminals[0].outcome.disposition, "retrying");
  assert.equal(terminals[1].outcome.requestId, "request-1");
  assert.equal(terminals[1].outcome.attemptNumber, 2);
  assert.equal(terminals[1].outcome.final, true);
  assert.equal(terminals[1].outcome.disposition, "accepted");
  assert.notEqual(terminals[0].outcome.attemptId, terminals[1].outcome.attemptId);
});

test("marks a completed attempt stale when its execution identity is obsolete", async () => {
  const events = await collectEvents(
    coordinateAIResponseAttempts({
      identity: executionIdentity,
      isExecutionCurrent: () => false,
      runAttempt: async function* (identity) {
        const builder = new AIResponseEventBuilder("provider-a", identity);
        yield builder.content("obsolete");
        yield builder.terminal({ status: "success", retryable: false });
      },
    })
  );
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "terminal");
  if (terminal?.type !== "terminal") return;
  assert.equal(terminal.outcome.status, "success");
  assert.equal(terminal.outcome.final, true);
  assert.equal(terminal.outcome.disposition, "stale");
});

test("emits an aborted terminal when cancellation wins during retry delay", async () => {
  const controller = new AbortController();
  const events = await collectEvents(
    coordinateAIResponseAttempts({
      identity: executionIdentity,
      providerId: "provider-a",
      signal: controller.signal,
      retryPolicy: { maxAttempts: 2, retryDelayMs: 10 },
      runAttempt: async function* (identity) {
        const builder = new AIResponseEventBuilder("provider-a", identity);
        yield builder.terminal({
          status: "failed",
          failureClass: "transport",
          retryable: true,
        });
        controller.abort();
      },
    })
  );
  const terminals = events.filter((event) => event.type === "terminal");
  assert.equal(terminals.length, 2);
  const final = terminals[1];
  assert.equal(final?.type, "terminal");
  if (final?.type !== "terminal") return;
  assert.equal(final.outcome.status, "aborted");
  assert.equal(final.outcome.attemptNumber, 2);
  assert.equal(final.outcome.final, true);
});

test("converts an attempt exception into one terminal failure", async () => {
  const events = await collectEvents(
    coordinateAIResponseAttempts({
      identity: executionIdentity,
      providerId: "provider-a",
      runAttempt: async function* () {
        throw new Error("attempt exploded");
      },
    })
  );
  assert.equal(events.length, 1);
  const terminal = events[0];
  assert.equal(terminal?.type, "terminal");
  if (terminal?.type !== "terminal") return;
  assert.equal(terminal.outcome.status, "failed");
  assert.equal(terminal.outcome.failureClass, "unexpected");
  assert.equal(terminal.outcome.safeErrorSummary, "attempt exploded");
});

test("keeps retries opt-in and caps the attempt budget", () => {
  assert.equal(normalizeAIResponseRetryPolicy(undefined).maxAttempts, 1);
  assert.equal(
    normalizeAIResponseRetryPolicy({ maxAttempts: 99 }).maxAttempts,
    3
  );
  assert.equal(
    normalizeAIResponseRetryPolicy({ maxAttempts: Number.NaN }).maxAttempts,
    1
  );
  const first = createAIResponseAttemptIdentity(executionIdentity, 1, 2);
  const second = createAIResponseAttemptIdentity(executionIdentity, 2, 2);
  assert.equal(first.requestId, second.requestId);
  assert.notEqual(first.attemptId, second.attemptId);
});
