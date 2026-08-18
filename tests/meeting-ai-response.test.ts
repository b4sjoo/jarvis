import assert from "node:assert/strict";
import test from "node:test";
import {
  AIResponseEventBuilder,
  type AIResponseAttemptIdentity,
  type AIResponseEvent,
} from "../src/lib/functions/ai-response-events.js";
import {
  collectMeetingAIResponseCandidate,
  requireMeetingAIResponseCandidate,
} from "../src/lib/meeting/meeting-ai-response.js";

function identity(
  attemptNumber = 1,
  maxAttempts = 1
): AIResponseAttemptIdentity {
  return {
    requestId: "request-1",
    attemptId: `attempt-${attemptNumber}`,
    executionPlanId: "plan-1",
    modelId: "model-1",
    sessionId: "session-1",
    runtimeEpoch: 2,
    logicalQuestionUnitId: "lqu-1",
    logicalQuestionRevision: 3,
    attemptNumber,
    maxAttempts,
  };
}

async function* stream(events: AIResponseEvent[]) {
  yield* events;
}

test("creates an immutable candidate only from accepted terminal success", async () => {
  const builder = new AIResponseEventBuilder("provider-a", identity());
  const result = await collectMeetingAIResponseCandidate({
    events: stream([
      builder.content("answer"),
      builder.terminal({ status: "success", retryable: false }),
    ]),
  });

  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.equal(result.candidate.content, "answer");
  assert.equal(Object.isFrozen(result.candidate), true);
  assert.equal(Object.isFrozen(result.candidate.outcome), true);
});

test("never turns provider failure text or partial output into a candidate", async () => {
  const builder = new AIResponseEventBuilder("provider-a", identity());
  const resets: string[] = [];
  const result = await collectMeetingAIResponseCandidate({
    events: stream([
      builder.content("partial model text"),
      builder.terminal({
        status: "failed",
        failureClass: "transport",
        retryable: true,
        safeErrorSummary: "Network error during API request: secret",
      }),
    ]),
    onPartialReset: (outcome) => resets.push(outcome.status),
  });

  assert.equal(result.accepted, false);
  assert.equal(result.providerDisposition, "provider-error-content");
  assert.deepEqual(resets, ["failed"]);
  assert.throws(
    () => requireMeetingAIResponseCandidate(result),
    /Network error during API request/
  );
});

test("discards retrying attempt content and accepts only the final attempt", async () => {
  const first = new AIResponseEventBuilder("provider-a", identity(1, 2));
  const second = new AIResponseEventBuilder("provider-a", identity(2, 2));
  const firstContent = first.content("obsolete partial");
  const firstTerminal = first.terminal({
    status: "failed",
    failureClass: "transport",
    retryable: true,
  });
  if (firstTerminal.type !== "terminal") return;
  const result = await collectMeetingAIResponseCandidate({
    events: stream([
      firstContent,
      {
        type: "terminal",
        outcome: {
          ...firstTerminal.outcome,
          final: false,
          disposition: "retrying",
        },
      },
      second.content("final answer"),
      second.terminal({ status: "success", retryable: false }),
    ]),
  });

  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.equal(result.candidate.content, "final answer");
  assert.equal(result.candidate.outcome.attemptNumber, 2);
});

test("rejects stale success and empty output without parsing either", async () => {
  const builder = new AIResponseEventBuilder("provider-a", identity());
  const content = builder.content("stale answer");
  const terminal = builder.terminal({ status: "success", retryable: false });
  if (terminal.type !== "terminal") return;
  const stale = await collectMeetingAIResponseCandidate({
    events: stream([
      content,
      {
        type: "terminal",
        outcome: { ...terminal.outcome, disposition: "stale" },
      },
    ]),
  });
  assert.equal(stale.accepted, false);

  const emptyBuilder = new AIResponseEventBuilder("provider-a", identity());
  const empty = await collectMeetingAIResponseCandidate({
    events: stream([
      emptyBuilder.terminal({ status: "empty", retryable: false }),
    ]),
  });
  assert.equal(empty.accepted, false);
  assert.equal(empty.providerDisposition, "completed-empty");
});

test("rejects the complete provider failure matrix as answer candidates", async () => {
  const cases = [
    { status: "timed-out", retryable: true },
    { status: "aborted", retryable: false },
    { status: "empty", retryable: false },
    {
      status: "failed",
      failureClass: "configuration",
      retryable: false,
    },
    {
      status: "failed",
      failureClass: "transport",
      retryable: true,
    },
    {
      status: "failed",
      failureClass: "authentication",
      retryable: false,
    },
    {
      status: "failed",
      failureClass: "rate-limit",
      retryable: true,
    },
    {
      status: "failed",
      failureClass: "provider-http",
      retryable: true,
    },
    {
      status: "failed",
      failureClass: "provider-response-parse",
      retryable: false,
    },
    {
      status: "failed",
      failureClass: "stream-unavailable",
      retryable: false,
    },
    {
      status: "failed",
      failureClass: "stream-read",
      retryable: true,
    },
    {
      status: "failed",
      failureClass: "unexpected",
      retryable: false,
    },
  ] as const;

  for (const terminalInput of cases) {
    const builder = new AIResponseEventBuilder("provider-a", identity());
    const result = await collectMeetingAIResponseCandidate({
      events: stream([
        builder.terminal({
          ...terminalInput,
          safeErrorSummary: "Answer: unsafe provider diagnostic",
        }),
      ]),
    });
    assert.equal(result.accepted, false, JSON.stringify(terminalInput));
    assert.equal(
      result.providerDisposition,
      terminalInput.status === "empty"
        ? "completed-empty"
        : "failureClass" in terminalInput &&
            terminalInput.failureClass === "authentication"
          ? "provider-auth-error"
          : "provider-error-content"
    );
  }
});
