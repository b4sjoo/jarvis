import assert from "node:assert/strict";
import test from "node:test";
import { consumeRuntimeInferenceResponse, didRuntimeInferenceProviderTimeOut, formatRuntimeInferenceProviderOutcomeForTrace } from "../src/lib/meeting/runtime-inference-response.js";
import { AIResponseEventBuilder, coordinateAIResponseAttempts } from "../src/lib/functions/ai-response-events.js";
import { MeetingAIResponseOutcomeError } from "../src/lib/meeting/meeting-ai-response.js";

test("cancelled Runtime inference retains completed attempts without returning a candidate", async () => {
  let calls = 0;
  const events = coordinateAIResponseAttempts({
    identity: { requestId: "type-op", executionPlanId: "type-op", modelId: "m", sessionId: "s", runtimeEpoch: 1, logicalQuestionUnitId: "q", logicalQuestionRevision: 1 },
    retryPolicy: { maxAttempts: 2 },
    runAttempt: async function* (identity) {
      calls++;
      const builder = new AIResponseEventBuilder("p", identity);
      yield builder.terminal(identity.attemptNumber === 1
        ? { status: "failed", failureClass: "provider-http", retryable: true, statusCode: 503 }
        : { status: "aborted", retryable: false });
    },
  });
  await assert.rejects(consumeRuntimeInferenceResponse({
    responseEvents: events, signal: new AbortController().signal, operationLabel: "Type",
  }), (error: unknown) => {
    assert.ok(error instanceof MeetingAIResponseOutcomeError);
    assert.equal(error.name, "AbortError");
    assert.equal(error.attempts.length, 2);
    assert.equal(error.attempts[0].statusCode, 503);
    assert.equal(error.attempts[1].status, "aborted");
    assert.equal(formatRuntimeInferenceProviderOutcomeForTrace(error.attempts[0], "type").typeProviderHttpStatus, 503);
    return true;
  });
  assert.equal(calls, 2);
});

test("uses typed provider timeout before compatibility error text", () => {
  assert.equal(
    didRuntimeInferenceProviderTimeOut({
      outcome: { status: "timed-out" },
    }),
    true
  );
  assert.equal(
    didRuntimeInferenceProviderTimeOut({
      outcome: { status: "failed" },
      error: new Error("provider timeout"),
    }),
    true
  );
  assert.equal(
    didRuntimeInferenceProviderTimeOut({
      outcome: { status: "failed" },
      error: new Error("invalid output"),
    }),
    false
  );
});
