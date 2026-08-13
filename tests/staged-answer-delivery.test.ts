import assert from "node:assert/strict";
import test from "node:test";
import {
  decideStagedAnswerPartial,
  hasDisplayableMeetingSection,
} from "../src/lib/meeting/staged-answer-delivery.js";

test("explicit generation keeps the stable answer until a valid section has content", () => {
  const waiting = decideStagedAnswerPartial({
    accumulated: "中文思路:\n",
    explicitRequest: true,
    stableAnswerPresent: true,
    guardrailHeld: false,
    visibleStreamStarted: false,
  });
  const ready = decideStagedAnswerPartial({
    accumulated: "中文思路:\n先澄清核心规模。",
    explicitRequest: true,
    stableAnswerPresent: true,
    guardrailHeld: false,
    visibleStreamStarted: false,
  });

  assert.equal(waiting.visible, false);
  assert.equal(waiting.reason, "explicit-waiting-valid-section");
  assert.equal(ready.visible, true);
  assert.equal(ready.startsVisibleStream, true);
});

test("an authorized explicit stream remains visible after its first valid section", () => {
  const decision = decideStagedAnswerPartial({
    accumulated: "中文思路:\n先澄清核心规模。\nAnswer:\nI would",
    explicitRequest: true,
    stableAnswerPresent: true,
    guardrailHeld: false,
    visibleStreamStarted: true,
  });

  assert.equal(decision.visible, true);
  assert.equal(decision.reason, "explicit-stream-continued");
});

test("fact guardrails suppress partial output for explicit requests", () => {
  const decision = decideStagedAnswerPartial({
    accumulated: "Answer:\nI led the project.",
    explicitRequest: true,
    stableAnswerPresent: false,
    guardrailHeld: true,
    visibleStreamStarted: false,
  });

  assert.equal(decision.visible, false);
  assert.equal(decision.reason, "guardrail-held");
});

test("automatic generation retains the previous stable-answer policy", () => {
  const held = decideStagedAnswerPartial({
    accumulated: "Answer:\nA complete response.",
    explicitRequest: false,
    stableAnswerPresent: true,
    guardrailHeld: false,
    visibleStreamStarted: false,
  });
  const emptySurface = decideStagedAnswerPartial({
    accumulated: "Answer:\nA complete response.",
    explicitRequest: false,
    stableAnswerPresent: false,
    guardrailHeld: false,
    visibleStreamStarted: false,
  });

  assert.equal(held.visible, false);
  assert.equal(emptySurface.visible, true);
});

test("displayable section detection ignores a bare heading", () => {
  assert.equal(hasDisplayableMeetingSection("Answer:\n"), false);
  assert.equal(hasDisplayableMeetingSection("Answer:\nSure."), true);
});
