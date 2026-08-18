import assert from "node:assert/strict";
import test from "node:test";
import {
  AIResponseEventBuilder,
  boundAIResponseErrorText,
  classifyAIResponseHttpFailure,
  shouldLegacyYieldAIResponseFailure,
} from "../src/lib/functions/ai-response-events.js";

test("builds content separately from exactly one successful terminal outcome", () => {
  const builder = new AIResponseEventBuilder("provider-a", 100);
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
  });
  assert.deepEqual(second, {
    type: "content-delta",
    content: "lo",
    index: 2,
    emittedAt: 120,
  });
  assert.deepEqual(terminal, {
    type: "terminal",
    outcome: {
      status: "success",
      retryable: false,
      providerId: "provider-a",
      startedAt: 100,
      firstContentAt: 110,
      finishedAt: 130,
      chunkCount: 2,
      text: "hello",
    },
  });
  assert.throws(
    () => builder.terminal({ status: "empty", retryable: false }),
    /terminal outcome already emitted/
  );
});

test("keeps partial content out of a failed terminal outcome", () => {
  const builder = new AIResponseEventBuilder("provider-a", 100);
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
  assert.equal(terminal.outcome.text, undefined);
});

test("requires content for success and a failure class for failure", () => {
  assert.throws(
    () =>
      new AIResponseEventBuilder("provider-a").terminal({
        status: "success",
        retryable: false,
      }),
    /requires content/
  );
  assert.throws(
    () =>
      new AIResponseEventBuilder("provider-a").terminal({
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
