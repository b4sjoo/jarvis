import assert from "node:assert/strict";
import test from "node:test";
import { buildFactAnchorDecision } from "../src/lib/meeting/fact-anchor-guardrail.js";
import { prepareGeneratedAnswer, prepareGeneratedAnswerPartial } from "../src/lib/meeting/generated-answer-consumer.js";

const decision = buildFactAnchorDecision({ questionType: "coding", questionText: "Implement LRU in Python." });

test("SG shared candidate preserves code and does not create artifact permission", () => {
  const result = prepareGeneratedAnswer({ content: "Answer: Use a dictionary.\nApproach: Preserve the method.\nCode: ```python\nclass LRUCache: pass\n```\nComplexity: O(1)",
    profile: "coding", factAnchorDecision: decision, whiteboardPreference: "none" });
  assert.match(result.parsedAnswer.sections.answer ?? "", /dictionary/);
  assert.match(result.parsedAnswer.sections.code ?? "", /class LRUCache/);
  assert.equal("authorizedArtifacts" in result, false);
  assert.equal("taskMutation" in result, false);
  assert.equal(decision.requiredFor, "none");
});

test("SG shared partial keeps source-specific admission and strips artifacts", () => {
  for (const explicitRequest of [false, true]) {
    let reads = 0;
    const result = prepareGeneratedAnswerPartial({ content: "Answer: Use a dictionary.\nCode: forbidden partial code",
      factAnchorDecision: decision, readDelivery: content => {
        reads++;
        assert.doesNotMatch(content, /forbidden partial code/);
        return { explicitRequest, automaticVoiceAuthorized: false, stableAnswerPresent: true,
          guardrailHeld: false, visibleStreamStarted: false };
      } });
    assert.equal(reads, 1);
    assert.equal(result.delivery.visible, explicitRequest);
  }
});

test("SG denial remains stronger than explicit request and does not mutate input", () => {
  const before = structuredClone(decision);
  const result = prepareGeneratedAnswerPartial({ content: "Answer: Candidate.", factAnchorDecision: decision,
    readDelivery: () => ({ explicitRequest: true, stableAnswerPresent: true, guardrailHeld: true, visibleStreamStarted: false }) });
  assert.equal(result.delivery.visible, false);
  assert.equal(result.delivery.reason, "guardrail-held");
  assert.deepEqual(decision, before);
});
