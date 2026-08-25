import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyInterviewTransitionTurn,
  consumeInterviewSectionHint,
  consumeInterviewTaskBoundary,
  createPendingInterviewSectionHint,
  createPendingInterviewTaskBoundary,
  detectInterviewSectionTransition,
  reconcileInterviewTransitionTurnWithPrimaryAsk,
} from "../src/lib/meeting/interview-section-transition.js";

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
  for (const text of [
    "Okay, looks good. So let's move on to the next question. This question is maybe some system design questions, but in this task, we will need you to design a food delivery app like Uber Eats or DoorDash. How will you begin with that?",
    "Now please design a ride-sharing system. Start with requirements and provide a high-level infrastructure whiteboard.",
    "Design a distributed cache. Start with requirements.",
    "Let's start with the simplest correct solution.",
    "We are going to use Python.",
  ]) {
    const decision = classifyInterviewTransitionTurn(text);
    assert.equal(decision.detected, true, text);
    assert.equal(decision.disposition, "complete-question", text);
  }
});

test("does not manufacture positive transition evidence from negation", () => {
  for (const text of [
    "Let us not move on to coding questions.",
    "We should not move on to behavioral questions yet.",
    "不要进入下一题。",
  ]) {
    assert.deepEqual(classifyInterviewTransitionTurn(text), {
      detected: false,
      disposition: "none",
      reason: "negated-transition-frame",
    });
    assert.deepEqual(detectInterviewSectionTransition(text), {
      detected: false,
      confidence: 0,
      reason: "negated-transition-frame",
    });
  }
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

test("lets canonical primary-ask evidence override an inconsistent hint-only proposal", () => {
  const reconciled = reconcileInterviewTransitionTurnWithPrimaryAsk(
    {
      detected: true,
      disposition: "hint-only",
      reason: "transition-announcement-only",
    },
    "design a ride-sharing system"
  );

  assert.deepEqual(reconciled, {
    detected: true,
    disposition: "complete-question",
    reason: "transition-with-primary-ask-projection",
  });
  assert.equal(
    reconcileInterviewTransitionTurnWithPrimaryAsk(reconciled, undefined),
    reconciled
  );
});

test("detects immediate canonical sections but rejects future and retrospective mentions", () => {
  assert.equal(
    detectInterviewSectionTransition(
      "Now let's move on to AI/ML system design."
    ).questionType,
    "ai-ml-system-design"
  );
  assert.equal(
    detectInterviewSectionTransition("接下来进入算法题环节。").questionType,
    "coding"
  );
  assert.equal(
    detectInterviewSectionTransition(
      "Later we will discuss coding questions."
    ).detected,
    false
  );
  assert.equal(
    detectInterviewSectionTransition(
      "The coding questions were difficult."
    ).detected,
    false
  );
});

test("applies one pending hint to an unknown question exactly once", () => {
  const hint = createPendingInterviewSectionHint({
    detection: detectInterviewSectionTransition(
      "Now let's move on to general system design."
    ),
    sourceTurnId: "turn_section",
    sourceText: "Now let's move on to general system design.",
    sessionId: "session-a",
    runtimeEpoch: 2,
    observedAt: 1_000,
    id: "hint-a",
  });
  const filler = consumeInterviewSectionHint({
    hint,
    questionId: "turn_filler",
    currentQuestionType: "unknown",
    substantive: false,
    sessionId: "session-a",
    runtimeEpoch: 2,
    now: 2_000,
  });
  const applied = consumeInterviewSectionHint({
    hint: filler.nextHint,
    questionId: "question-a",
    currentQuestionType: "unknown",
    substantive: true,
    sessionId: "session-a",
    runtimeEpoch: 2,
    now: 3_000,
  });

  assert.equal(filler.disposition, "retained");
  assert.equal(applied.disposition, "applied");
  assert.equal(applied.effectiveQuestionType, "general-system-design");
  assert.equal(applied.hint?.consumedByQuestionId, "question-a");
  assert.equal(applied.nextHint, undefined);
});

test("lets a concrete conflicting question win and expires stale hints", () => {
  const hint = createPendingInterviewSectionHint({
    detection: detectInterviewSectionTransition(
      "Let's start with coding questions."
    ),
    sourceTurnId: "turn_section",
    sourceText: "Let's start with coding questions.",
    sessionId: "session-a",
    runtimeEpoch: 1,
    observedAt: 1_000,
    id: "hint-coding",
  });
  const conflict = consumeInterviewSectionHint({
    hint,
    questionId: "question-behavioral",
    currentQuestionType: "behavioral",
    substantive: true,
    sessionId: "session-a",
    runtimeEpoch: 1,
    now: 2_000,
  });
  const expired = consumeInterviewSectionHint({
    hint,
    questionId: "question-late",
    currentQuestionType: "unknown",
    substantive: true,
    sessionId: "session-a",
    runtimeEpoch: 1,
    now: 100_000,
  });

  assert.equal(conflict.disposition, "conflicted");
  assert.equal(conflict.effectiveQuestionType, "behavioral");
  assert.equal(expired.disposition, "expired");
});

test("carries an untyped transition to exactly one later substantive question", () => {
  const boundary = createPendingInterviewTaskBoundary({
    sourceTurnId: "turn_transition",
    sourceText: "Okay, let's move on.",
    sessionId: "session-a",
    runtimeEpoch: 3,
    observedAt: 1_000,
    id: "boundary-a",
  });
  const filler = consumeInterviewTaskBoundary({
    boundary,
    questionId: "turn_filler",
    substantive: false,
    sessionId: "session-a",
    runtimeEpoch: 3,
    now: 2_000,
  });
  const applied = consumeInterviewTaskBoundary({
    boundary: filler.nextBoundary,
    questionId: "question-next",
    substantive: true,
    sessionId: "session-a",
    runtimeEpoch: 3,
    now: 3_000,
  });
  const consumedAgain = consumeInterviewTaskBoundary({
    boundary: applied.nextBoundary,
    questionId: "question-later",
    substantive: true,
    sessionId: "session-a",
    runtimeEpoch: 3,
    now: 4_000,
  });

  assert.equal(filler.disposition, "retained");
  assert.equal(applied.disposition, "applied");
  assert.equal(applied.boundary?.consumedByQuestionId, "question-next");
  assert.equal(applied.nextBoundary, undefined);
  assert.equal(consumedAgain.disposition, "no-boundary");
});
