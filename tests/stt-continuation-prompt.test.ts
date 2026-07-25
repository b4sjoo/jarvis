import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeSttContinuationPromptLease,
  composeSttPrompt,
  consumeSttContinuationPromptLease,
  createSttContinuationPromptLease,
  STT_CONTINUATION_MAX_SOURCE_CHARS,
} from "../src/lib/meeting/stt-continuation-prompt.js";

function createLease() {
  const lease = createSttContinuationPromptLease({
    operationId: "sentence-buffer-1",
    audioSessionId: "audio-session-1",
    speaker: "them",
    source: "system-audio",
    sourceTurnId: "turn-1",
    sourceTraceId: "trace-1",
    sourceSegmentSequence: 4,
    sourceText: "Can you explain how the retrieval pipeline",
    nativeCaptureSessionId: "capture-1",
    nativeCaptureGeneration: 2,
    candidateSegmentSequence: 5,
    createdAt: 1_000,
    expiresAt: 4_000,
  });
  assert.ok(lease);
  return lease;
}

test("authorizes one matching adjacent continuation lease", () => {
  const lease = createLease();
  const decision = authorizeSttContinuationPromptLease({
    lease,
    segment: {
      sessionId: "audio-session-1",
      speaker: "them",
      source: "system-audio",
      nativeCaptureSessionId: "capture-1",
      nativeCaptureGeneration: 2,
      nativeSegmentSequence: 5,
    },
    now: 2_000,
  });

  assert.equal(decision.authorized, true);

  const consumed = consumeSttContinuationPromptLease(lease, 2_000);
  const duplicate = authorizeSttContinuationPromptLease({
    lease: consumed,
    segment: {
      sessionId: "audio-session-1",
      speaker: "them",
      source: "system-audio",
      nativeCaptureSessionId: "capture-1",
      nativeCaptureGeneration: 2,
      nativeSegmentSequence: 5,
    },
    now: 2_100,
  });
  assert.equal(duplicate.authorized, false);
  if (!duplicate.authorized) {
    assert.equal(duplicate.reason, "lease-already-consumed");
  }
});

test("rejects stale and mismatched continuation leases", () => {
  const lease = createLease();
  const wrongSegment = authorizeSttContinuationPromptLease({
    lease,
    segment: {
      sessionId: "audio-session-1",
      speaker: "them",
      source: "system-audio",
      nativeCaptureSessionId: "capture-1",
      nativeCaptureGeneration: 2,
      nativeSegmentSequence: 6,
    },
    now: 2_000,
  });
  assert.equal(wrongSegment.authorized, false);
  if (!wrongSegment.authorized) {
    assert.equal(wrongSegment.reason, "candidate-sequence-mismatch");
  }

  const expired = authorizeSttContinuationPromptLease({
    lease,
    segment: {
      sessionId: "audio-session-1",
      speaker: "them",
      source: "system-audio",
      nativeCaptureSessionId: "capture-1",
      nativeCaptureGeneration: 2,
      nativeSegmentSequence: 5,
    },
    now: 4_000,
  });
  assert.equal(expired.authorized, false);
  if (!expired.authorized) {
    assert.equal(expired.reason, "lease-expired");
  }
});

test("composes bounded and independently labeled continuation prompts", () => {
  const lease = createLease();
  const combined = composeSttPrompt({
    speechBiasPrompt: "Likely terms: HNSW, RAG.",
    continuationLease: lease,
  });

  assert.equal(combined.kind, "speech-bias+continuation");
  assert.match(combined.prompt, /immediately preceding incomplete transcript/);
  assert.match(combined.prompt, /Speech-bias glossary/);
  assert.equal(combined.continuationChars, lease.sourceTail.length);
  assert.ok(combined.promptHash);

  const continuationOnly = composeSttPrompt({
    continuationLease: lease,
  });
  assert.equal(continuationOnly.kind, "continuation");
});

test("continuation source is capped to the final 240 source characters", () => {
  const lease = createSttContinuationPromptLease({
    operationId: "sentence-buffer-long",
    audioSessionId: "audio-session-1",
    speaker: "them",
    source: "system-audio",
    sourceTurnId: "turn-long",
    sourceTraceId: "trace-long",
    sourceSegmentSequence: 8,
    sourceText: `${"discarded ".repeat(40)}important final clause`,
    nativeCaptureSessionId: "capture-1",
    nativeCaptureGeneration: 2,
    candidateSegmentSequence: 9,
    createdAt: 1_000,
    expiresAt: 4_000,
  });
  assert.ok(lease);
  assert.ok(lease.sourceTail.length <= STT_CONTINUATION_MAX_SOURCE_CHARS);
  assert.match(lease.sourceTail, /important final clause$/);
});
