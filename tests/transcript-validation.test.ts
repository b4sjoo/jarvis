import assert from "node:assert/strict";
import test from "node:test";
import { validateTranscriptCandidate } from "../src/lib/meeting/transcript-validation.js";
import { RECORDED_RECRUITER_SPEECH_BIAS_PROMPT as RECORDED_SPEECH_BIAS_PROMPT } from "./fixtures/recruiter-screen-session.js";

test("rejects the exact speech-bias prompt echo from the recruiter session", () => {
  const decision = validateTranscriptCandidate({
    text: RECORDED_SPEECH_BIAS_PROMPT,
    speechBiasPrompt: RECORDED_SPEECH_BIAS_PROMPT,
    startedAt: 1_000,
    endedAt: 2_000,
  });

  assert.equal(decision.disposition, "rejected");
  assert.equal(decision.reason, "prompt-echo-exact");
  assert.equal(decision.promptSimilarity, 1);
  assert.equal(decision.densitySuspicious, true);
});

test("rejects a normalized prompt echo with punctuation and whitespace changes", () => {
  const echoedText = RECORDED_SPEECH_BIAS_PROMPT
    .replace(/,/g, "  ")
    .replace(/\./g, " ! ")
    .replace(/\s+/g, " ");
  const decision = validateTranscriptCandidate({
    text: echoedText,
    speechBiasPrompt: RECORDED_SPEECH_BIAS_PROMPT,
  });

  assert.equal(decision.disposition, "rejected");
  assert.equal(decision.reason, "prompt-echo-similar");
  assert.ok(decision.promptSimilarity >= 0.72);
});

test("rejects a substantial prompt prefix even when the provider truncates it", () => {
  const promptPrefix = RECORDED_SPEECH_BIAS_PROMPT.slice(0, 240);
  const decision = validateTranscriptCandidate({
    text: promptPrefix,
    speechBiasPrompt: RECORDED_SPEECH_BIAS_PROMPT,
  });

  assert.equal(decision.disposition, "rejected");
  assert.equal(decision.reason, "prompt-echo-similar");
});

test("accepts valid speech that uses several speech-bias terms", () => {
  const decision = validateTranscriptCandidate({
    text:
      "At Snowflake, would this role focus more on RAG evaluation and vector retrieval, or on the broader ML platform APIs?",
    speechBiasPrompt: RECORDED_SPEECH_BIAS_PROMPT,
  });

  assert.equal(decision.disposition, "accepted");
  assert.equal(decision.reason, "valid");
});

test("accepts a short clarification that repeats a biased acronym", () => {
  const decision = validateTranscriptCandidate({
    text: "RAG, right?",
    speechBiasPrompt: RECORDED_SPEECH_BIAS_PROMPT,
  });

  assert.equal(decision.disposition, "accepted");
});

test("reports empty STT output without treating it as a rejected echo", () => {
  const decision = validateTranscriptCandidate({
    text: "   ",
    speechBiasPrompt: RECORDED_SPEECH_BIAS_PROMPT,
  });

  assert.equal(decision.disposition, "empty");
  assert.equal(decision.reason, "empty");
});

test("rejects the no-transcription provider sentinel", () => {
  const decision = validateTranscriptCandidate({
    text: "  No transcription found.  ",
    speechBiasPrompt: RECORDED_SPEECH_BIAS_PROMPT,
  });

  assert.equal(decision.disposition, "rejected");
  assert.equal(decision.reason, "provider-sentinel");
});

test("rejects a provider warning followed by the no-transcription sentinel", () => {
  const decision = validateTranscriptCandidate({
    text: "Audio exceeds 10MB limit; No transcription found",
    speechBiasPrompt: RECORDED_SPEECH_BIAS_PROMPT,
  });

  assert.equal(decision.disposition, "rejected");
  assert.equal(decision.reason, "provider-warning");
});

test("accepts a real short no response", () => {
  const decision = validateTranscriptCandidate({
    text: "No",
    speechBiasPrompt: RECORDED_SPEECH_BIAS_PROMPT,
  });

  assert.equal(decision.disposition, "accepted");
  assert.equal(decision.reason, "valid");
});

test("does not reject natural speech that mentions missing transcription", () => {
  const decision = validateTranscriptCandidate({
    text:
      "No transcription was found in that recording, so I checked the original notes instead.",
    speechBiasPrompt: RECORDED_SPEECH_BIAS_PROMPT,
  });

  assert.equal(decision.disposition, "accepted");
  assert.equal(decision.reason, "valid");
});

test("records suspicious transcript density without rejecting valid speech", () => {
  const text =
    "I would start by defining the production API boundary, the request path, the storage model, the cache policy, the reliability target, and the rollout constraints before discussing the detailed implementation.";
  const decision = validateTranscriptCandidate({
    text,
    speechBiasPrompt: RECORDED_SPEECH_BIAS_PROMPT,
    startedAt: 1_000,
    endedAt: 2_000,
  });

  assert.equal(decision.disposition, "accepted");
  assert.equal(decision.densitySuspicious, true);
});
