import assert from "node:assert/strict";
import test from "node:test";
import { classifyInterviewTransitionTurn } from "../src/lib/meeting/interview-section-transition.js";

test("keeps a pure interview section announcement answerless", () => {
  for (const text of [
    "Okay, let's move on to general system design.",
    "Next question: coding.",
    "接下来进入行为题环节。",
  ]) {
    const decision = classifyInterviewTransitionTurn(text);
    assert.equal(decision.detected, true, text);
    assert.equal(decision.disposition, "hint-only", text);
  }
});

test("routes a transition that already contains a complete question", () => {
  const decision = classifyInterviewTransitionTurn(
    "Okay, looks good. So let's move on to the next question. This question is maybe some system design questions, but in this task, we will need you to design a food delivery app like Uber Eats or DoorDash. How will you begin with that?"
  );

  assert.equal(decision.detected, true);
  assert.equal(decision.disposition, "complete-question");
});

test("does not treat ordinary interview questions as section transitions", () => {
  const decision = classifyInterviewTransitionTurn(
    "How would you design a distributed cache?"
  );

  assert.deepEqual(decision, {
    detected: false,
    disposition: "none",
    reason: "no-transition-frame",
  });
});
