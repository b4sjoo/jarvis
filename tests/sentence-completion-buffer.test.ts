import assert from "node:assert/strict";
import test from "node:test";
import { decideAdvisorTurnIntent } from "../src/lib/meeting/advisor-turn-intent.js";
import {
  decideSentenceCompletionContinuation,
  decideSentenceCompletion,
  mergeSentenceFragments,
} from "../src/lib/meeting/sentence-completion-buffer.js";

test("buffers only high-confidence incomplete interviewer fragments", () => {
  for (const text of [
    "Can you describe...",
    "The next one is:",
    "I could not finish because",
    "I received an email from my",
  ]) {
    const decision = decideSentenceCompletion(text);
    assert.equal(decision.disposition, "buffer", text);
    assert.ok(decision.confidence >= 0.85, text);
  }
});

test("complete direct questions and explicit tasks bypass the buffer", () => {
  for (const text of [
    "Can you describe your experience with Kubernetes?",
    "Can you describe your experience with Kubernetes",
    "Design a ticket selling system",
    "Assume we have 10 million daily users",
    "What about latency?",
    "Can you explain why",
    "What is the CAP theorem...",
  ]) {
    assert.equal(
      decideSentenceCompletion(text).disposition,
      "bypass",
      text
    );
  }
});

test("merges fragments into one normalized logical transcript", () => {
  assert.equal(
    mergeSentenceFragments([
      "Can you describe...",
      "how you handled a difficult deadline?",
    ]),
    "Can you describe how you handled a difficult deadline?"
  );
});

test("a timed-out buffered fragment becomes enforced append-only context", () => {
  const decision = decideAdvisorTurnIntent("Can you describe...", {
    hasActiveTask: true,
    enforceBufferedIncomplete: true,
  });

  assert.equal(decision.intent, "incomplete");
  assert.equal(decision.action, "append-only");
  assert.equal(decision.enforcement, "enforce");
  assert.equal(decision.executionAuthorized, false);
  assert.equal(decision.contextPromptEligible, true);
});

test("matching native speech start grants one bounded continuation extension", () => {
  const decision = decideSentenceCompletionContinuation({
    pending: {
      source: "system-audio",
      heldAt: 2_000,
      firstHeldAt: 2_000,
      extensionUsed: false,
      nativeCaptureSessionId: "capture-1",
      nativeCaptureGeneration: 4,
      nativeSegmentSequence: 11,
      nativeCapturedAtMs: 1_900,
    },
    speechStart: {
      source: "system-audio",
      captureSessionId: "capture-1",
      captureGeneration: 4,
      candidateSegmentSequence: 12,
      occurredAtMs: 2_100,
    },
    now: 2_300,
  });

  assert.deepEqual(decision, {
    authorized: true,
    reason: "matching-native-speech-start",
    deadlineAt: 3_800,
    extensionBudgetMs: 1_500,
    absoluteDeadlineAt: 6_000,
  });
});

test("continuation extension rejects mismatched identity and absolute timeout", () => {
  const basePending = {
    source: "system-audio",
    heldAt: 2_000,
    firstHeldAt: 2_000,
    extensionUsed: false,
    nativeCaptureSessionId: "capture-1",
    nativeCaptureGeneration: 4,
    nativeSegmentSequence: 11,
    nativeCapturedAtMs: 1_900,
  };
  const baseSpeechStart = {
    source: "system-audio",
    captureSessionId: "capture-1",
    captureGeneration: 4,
    candidateSegmentSequence: 12,
    occurredAtMs: 2_100,
  };

  const wrongCandidate = decideSentenceCompletionContinuation({
    pending: basePending,
    speechStart: {
      ...baseSpeechStart,
      candidateSegmentSequence: 13,
    },
    now: 2_300,
  });
  assert.equal(wrongCandidate.authorized, false);
  if (!wrongCandidate.authorized) {
    assert.equal(wrongCandidate.reason, "candidate-sequence-mismatch");
  }

  const expired = decideSentenceCompletionContinuation({
    pending: basePending,
    speechStart: baseSpeechStart,
    now: 6_000,
  });
  assert.equal(expired.authorized, false);
  if (!expired.authorized) {
    assert.equal(expired.reason, "absolute-deadline-expired");
  }
});

test("a continuation lease cannot be extended twice", () => {
  const decision = decideSentenceCompletionContinuation({
    pending: {
      source: "system-audio",
      heldAt: 2_000,
      firstHeldAt: 2_000,
      extensionUsed: true,
      nativeCaptureSessionId: "capture-1",
      nativeCaptureGeneration: 4,
      nativeSegmentSequence: 11,
    },
    speechStart: {
      source: "system-audio",
      captureSessionId: "capture-1",
      captureGeneration: 4,
      candidateSegmentSequence: 12,
      occurredAtMs: 2_100,
    },
    now: 2_300,
  });

  assert.equal(decision.authorized, false);
  if (!decision.authorized) {
    assert.equal(decision.reason, "extension-already-used");
  }
});
