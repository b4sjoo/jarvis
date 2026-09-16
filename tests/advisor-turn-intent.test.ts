import assert from "node:assert/strict";
import test from "node:test";
import {
  applySourceOwnedPhaseControlToTurnIntent,
  decideAdvisorTurnIntent,
  formatAdvisorTurnIntentForTrace,
} from "../src/lib/meeting/advisor-turn-intent.js";
import { decideInterviewerAssumptionAuthorization } from "../src/lib/meeting/playbook-phase.js";

function assertContentOnly(value: object) {
  for (const key of ["action", "executionAuthorized", "enforcement", "confidence", "recommendedAction",
    "contextPromptEligible", "wouldSuppress", "authoritySource", "advisorTurnEnforcement",
    "advisorWouldSuppress", "advisorTurnConfidence", "advisorProviderCallAvoided", "advisorSuppressionOperation"]) {
    assert.equal(key in value, false, `local content evidence must not produce ${key}`);
  }
}

test("admits an authorized interviewer phase-control statement as a substantive refresh", () => {
  const base = decideAdvisorTurnIntent(
    "You can make the hypothesis by yourself.",
    { hasActiveTask: true }
  );
  const phaseControl = decideInterviewerAssumptionAuthorization({
    text: "You can make the hypothesis by yourself.",
    speaker: "them",
    activeQuestionType: "general-system-design",
    currentPhase: "requirement_clarification",
    sourceTurnId: "turn-assumption",
  }).phaseControl;
  const decision = applySourceOwnedPhaseControlToTurnIntent(
    base,
    phaseControl
  );

  assert.equal(base.phaseControl, undefined);
  assertContentOnly(decision);
  assertContentOnly(decision);
  assert.equal(decision.followupScopeSource, "active-task");
  assert.equal(decision.phaseControl?.signal, "assumption-authorized");
  assert.equal(
    formatAdvisorTurnIntentForTrace(decision).phaseSignal,
    "assumption-authorized"
  );
});

test("labels a technical declarative statement without response authority", () => {
  const decision = decideAdvisorTurnIntent(
    "The control plane sends configuration to the data plane.",
    { hasActiveTask: false }
  );

  assert.equal(decision.intent, "informational");
  assertContentOnly(decision);
  assertContentOnly(decision);
  assertContentOnly(decision);
  assertContentOnly(decision);
});

test("preserves explicit coding and system-design requests", () => {
  for (const text of [
    "Implement a stack using two queues",
    "Design a ticket selling system",
    "Can you explain how the cache should be invalidated?",
    "Give me an example of a time when you had to persuade someone",
    "Share an example of working through an ambiguous deadline",
    "Please introduce yourself",
    "Let me ask you how the write path scales",
  ]) {
    const decision = decideAdvisorTurnIntent(text, { hasActiveTask: false });
    assert.equal(decision.intent, "direct-question", text);
    assertContentOnly(decision);
    assertContentOnly(decision);
  }
});

test("recognizes discourse-prefixed and sentence-merged direct questions", () => {
  for (const text of [
    "Yeah, if you're using a RAG system for that, then where does your data storage live",
    "Okay, assuming the cache is distributed, how would you invalidate stale entries",
    "那么如果使用 RAG，数据应该存在哪里？",
  ]) {
    const decision = decideAdvisorTurnIntent(text, {
      hasActiveTask: true,
    });
    assert.equal(decision.intent, "direct-question", text);
    assertContentOnly(decision);
    assertContentOnly(decision);
    assert.ok(
      decision.evidence.some((item) =>
        /embedded-interrogative|cjk-question/.test(item)
      ),
      text
    );
  }
});

test("keeps indirect wh clauses as declarative context", () => {
  for (const text of [
    "We discussed where the data is stored.",
    "The document explains how retrieval works.",
    "我们刚才讨论了数据应该存在哪里。",
  ]) {
    const decision = decideAdvisorTurnIntent(text, {
      hasActiveTask: true,
    });
    assertContentOnly(decision);
    assertContentOnly(decision);
  }
});

test("labels incomplete speech without granting or suppressing a response", () => {
  const decision = decideAdvisorTurnIntent("Can you describe...", {
    hasActiveTask: false,
  });

  assert.equal(decision.intent, "incomplete");
  assertContentOnly(decision);
  assertContentOnly(decision);
  assertContentOnly(decision);
  assertContentOnly(decision);
});

test("preserves active-task constraints and elliptical technical probes", () => {
  const constraint = decideAdvisorTurnIntent(
    "Assume we have 10 million daily users",
    { hasActiveTask: true }
  );
  assert.equal(constraint.intent, "constraint-or-follow-up");
  assertContentOnly(constraint);

  const elliptical = decideAdvisorTurnIntent("Latency", {
    hasActiveTask: true,
  });
  assert.equal(elliptical.intent, "constraint-or-follow-up");
  assert.equal(elliptical.reason, "active-task-elliptical-probe");
  assertContentOnly(elliptical);
});

test("uses provisional question scope for corrections and follow-ups", () => {
  const correction = decideAdvisorTurnIntent(
    "You are over-designing it, just write the code",
    { hasActiveTask: false, hasRecentQuestionContext: true }
  );
  assert.equal(correction.intent, "correction");
  assertContentOnly(correction);
  assert.equal(correction.reason, "scoped-correction-direct-ask");
  assert.equal(correction.followupScopeSource, "provisional-question");

  const constraint = decideAdvisorTurnIntent(
    "Find all the text files instead of only the first one",
    { hasActiveTask: false, hasRecentQuestionContext: true }
  );
  assert.equal(constraint.intent, "correction");
  assertContentOnly(constraint);
  assert.equal(constraint.reason, "recent-question-correction");
  assert.equal(constraint.followupScopeSource, "provisional-question");
});

test("allows an explicit language constraint only with provisional question scope", () => {
  const scoped = decideAdvisorTurnIntent("In Python.", {
    hasActiveTask: false,
    hasRecentQuestionContext: true,
  });
  assert.equal(scoped.intent, "constraint-or-follow-up");
  assertContentOnly(scoped);
  assert.equal(scoped.reason, "recent-question-constraint");
  assert.equal(scoped.followupScopeSource, "provisional-question");
  assert.ok(scoped.evidence.includes("programming-language:Python"));

  const unscoped = decideAdvisorTurnIntent("In Python.", {
    hasActiveTask: false,
    hasRecentQuestionContext: false,
  });
  assert.equal(unscoped.intent, "informational");
  assertContentOnly(unscoped);
  assert.equal(unscoped.reason, "unscoped-constraint");
  assertContentOnly(unscoped);
});

test("preserves a self-contained direct ask when the same turn adds constraints", () => {
  for (const text of [
    "Please implement an LRU cache with O(1) get and put in Python.",
    "Design a ride-sharing service for 10 million users.",
    "Write the solution without extra space.",
    "Design an API that must support 5000 requests per second.",
  ]) {
    const decision = decideAdvisorTurnIntent(text, {
      hasActiveTask: false,
      hasRecentQuestionContext: false,
    });
    assert.equal(decision.intent, "constraint-or-follow-up", text);
    assertContentOnly(decision);
    assert.equal(
      decision.reason,
      "self-contained-constraint-direct-ask",
      text
    );
    assertContentOnly(decision);
  }
});

test("allows each bounded adjacent constraint family with provisional scope", () => {
  for (const text of [
    "For 10 million users.",
    "Return the indices.",
    "Without extra space.",
  ]) {
    const decision = decideAdvisorTurnIntent(text, {
      hasActiveTask: false,
      hasRecentQuestionContext: true,
    });
    assert.equal(decision.intent, "constraint-or-follow-up", text);
    assertContentOnly(decision);
    assert.equal(decision.reason, "recent-question-constraint", text);
  }
});

test("direct asks survive correction wording without question scope", () => {
  const decision = decideAdvisorTurnIntent(
    "Not a recommendation system. Can you explain RAG instead?",
    { hasActiveTask: false, hasRecentQuestionContext: false }
  );

  assert.equal(decision.intent, "correction");
  assertContentOnly(decision);
  assert.equal(decision.reason, "self-contained-correction-direct-ask");
  assert.equal(decision.followupScopeSource, "none");
});

test("keeps a truly unscoped correction append-only", () => {
  const decision = decideAdvisorTurnIntent("Not recommendation, RAG", {
    hasActiveTask: false,
    hasRecentQuestionContext: false,
  });

  assert.equal(decision.intent, "correction");
  assertContentOnly(decision);
  assert.equal(decision.reason, "unscoped-correction");
  assert.equal(decision.followupScopeSource, "none");
});

test("keeps useful active-task statements without refreshing the answer", () => {
  const decision = decideAdvisorTurnIntent(
    "The cache stores the active user profiles",
    { hasActiveTask: true }
  );

  assert.equal(decision.intent, "informational");
  assertContentOnly(decision);
  assertContentOnly(decision);
  assertContentOnly(decision);
});

test("recognizes compact recruiter-style elliptical prompts", () => {
  const decision = decideAdvisorTurnIntent(
    "Your experience with Kubernetes",
    { hasActiveTask: false }
  );

  assert.equal(decision.intent, "direct-question");
  assert.equal(decision.reason, "interview-elliptical-prompt");
  assertContentOnly(decision);
});

test("leaves ambiguous content unknown without fabricated confidence or permissions", () => {
  const decision = decideAdvisorTurnIntent("Kubernetes", {
    hasActiveTask: false,
  });

  assert.equal(decision.intent, "unknown");
  assertContentOnly(decision);
  assertContentOnly(decision);
  assertContentOnly(decision);
  assertContentOnly(decision);
});

test("requires context before a short confirmation can refresh an answer", () => {
  const unscoped = decideAdvisorTurnIntent("Yes", {
    hasActiveTask: true,
  });
  assert.equal(unscoped.intent, "confirmation");
  assertContentOnly(unscoped);

  const contextual = decideAdvisorTurnIntent("Yes", {
    hasActiveTask: true,
    hasPendingConfirmation: true,
  });
  assert.equal(contextual.intent, "confirmation");
  assertContentOnly(contextual);
});

test("suppresses exact acknowledgement variants without suppressing a real add-on ask", () => {
  for (const text of [
    "Looks good.",
    "Looks good to me.",
    "That looks good to me.",
    "This sounds good to me.",
    "Mm, OK.",
    "Mm-hmm, okay.",
  ]) {
    const decision = decideAdvisorTurnIntent(text, {
      hasActiveTask: true,
    });
    assert.equal(decision.intent, "confirmation", text);
    assertContentOnly(decision);
    assert.equal(decision.reason, "exact-acknowledgement", text);
    assertContentOnly(decision);
    assert.ok(decision.evidence.includes("exact-acknowledgement"), text);
    assertContentOnly(formatAdvisorTurnIntentForTrace(decision));
  }

  const addOn = decideAdvisorTurnIntent(
    "That looks good to me, now write merge sort.",
    { hasActiveTask: true }
  );
  assert.equal(addOn.intent, "direct-question");
  assertContentOnly(addOn);
  assertContentOnly(addOn);

  const acousticAddOn = decideAdvisorTurnIntent(
    "Mm, OK, now estimate QPS.",
    { hasActiveTask: true }
  );
  assert.equal(acousticAddOn.intent, "direct-question");
  assertContentOnly(acousticAddOn);
  assertContentOnly(acousticAddOn);
});
