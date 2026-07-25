import assert from "node:assert/strict";
import test from "node:test";
import {
  formatSttPromptEchoRecoveryForTrace,
  runSttPromptEchoRecovery,
  type SttAttemptIdentity,
} from "../src/lib/meeting/stt-prompt-echo-retry.js";
import type { MeetingTranscriptionResult } from "../src/lib/meeting/transcription.service.js";

function result(
  disposition: "accepted" | "empty" | "rejected",
  reason:
    | "valid"
    | "empty"
    | "provider-sentinel"
    | "prompt-echo-exact"
    | "prompt-echo-similar",
  text = ""
): MeetingTranscriptionResult {
  return {
    rawText: text,
    turn:
      disposition === "accepted"
        ? {
            id: "turn-1",
            speaker: "them",
            text,
            startedAt: 1,
            endedAt: 2,
            isFinal: true,
            source: "system-audio",
          }
        : null,
    validation: {
      disposition,
      reason,
      promptSimilarity: 0,
      normalizedTranscriptChars: text.length,
      normalizedPromptChars: 0,
      densitySuspicious: false,
    },
  };
}

test("returns an accepted first attempt without retrying", async () => {
  const attempts: SttAttemptIdentity[] = [];
  const recovery = await runSttPromptEchoRecovery({
    traceId: "trace-1",
    audioSessionId: "session-1",
    segmentSequence: 4,
    initialPromptKind: "speech-bias",
    authorizeRetry: () => true,
    runAttempt: async (identity) => {
      attempts.push(identity);
      return result("accepted", "valid", "Explain HNSW.");
    },
  });

  assert.equal(attempts.length, 1);
  assert.equal(recovery.retryDisposition, "not-needed");
  assert.equal(recovery.finalAttempt.attemptNumber, 1);
});

test("retries one prompt echo without prompt authority", async () => {
  const attempts: SttAttemptIdentity[] = [];
  const recovery = await runSttPromptEchoRecovery({
    traceId: "trace-2",
    audioSessionId: "session-1",
    segmentSequence: 5,
    initialPromptKind: "speech-bias+continuation",
    authorizeRetry: () => true,
    runAttempt: async (identity) => {
      attempts.push(identity);
      return identity.attemptNumber === 1
        ? result("rejected", "prompt-echo-exact", "Likely terms...")
        : result("accepted", "valid", "How does HNSW search work?");
    },
  });

  assert.equal(attempts.length, 2);
  assert.equal(attempts[1]?.promptMode, "unbiased");
  assert.equal(attempts[1]?.promptKind, "none");
  assert.equal(recovery.retryDisposition, "recovered");
  assert.equal(recovery.finalResult.rawText, "How does HNSW search work?");
  assert.equal(recovery.finalAttempt.attemptNumber, 2);
});

test("never retries a stale segment or a provider sentinel", async () => {
  let staleCalls = 0;
  const stale = await runSttPromptEchoRecovery({
    traceId: "trace-3",
    audioSessionId: "session-1",
    segmentSequence: 6,
    initialPromptKind: "speech-bias",
    authorizeRetry: () => false,
    runAttempt: async () => {
      staleCalls += 1;
      return result("rejected", "prompt-echo-similar");
    },
  });
  assert.equal(staleCalls, 1);
  assert.equal(stale.retryDisposition, "retry-suppressed-stale");

  let sentinelCalls = 0;
  const sentinel = await runSttPromptEchoRecovery({
    traceId: "trace-4",
    audioSessionId: "session-1",
    segmentSequence: 7,
    initialPromptKind: "speech-bias",
    authorizeRetry: () => true,
    runAttempt: async () => {
      sentinelCalls += 1;
      return result("rejected", "provider-sentinel");
    },
  });
  assert.equal(sentinelCalls, 1);
  assert.equal(sentinel.retryDisposition, "not-eligible");
});

test("stops after one failed unbiased retry and exposes attempt evidence", async () => {
  const recovery = await runSttPromptEchoRecovery({
    traceId: "trace-5",
    audioSessionId: "session-1",
    segmentSequence: 8,
    initialPromptKind: "speech-bias",
    authorizeRetry: () => true,
    runAttempt: async () =>
      result("rejected", "prompt-echo-similar", "Likely terms..."),
  });

  assert.equal(recovery.attempts.length, 2);
  assert.equal(recovery.retryDisposition, "retry-exhausted");
  assert.deepEqual(formatSttPromptEchoRecoveryForTrace(recovery), {
    sttAttemptCount: 2,
    sttInitialAttemptId: "stt_attempt_trace-5_session-1_8_1",
    sttInitialValidationDisposition: "rejected",
    sttInitialValidationReason: "prompt-echo-similar",
    sttRetryTriggered: true,
    sttRetryDisposition: "retry-exhausted",
    sttRetryReason: "prompt-echo-similar",
    sttRetryAttemptId: "stt_attempt_trace-5_session-1_8_2",
    sttRetryValidationDisposition: "rejected",
    sttRetryValidationReason: "prompt-echo-similar",
    sttFinalAttemptId: "stt_attempt_trace-5_session-1_8_2",
    sttFinalAttemptNumber: 2,
    sttFinalPromptMode: "unbiased",
  });
});
