import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeAdvisorExecution,
  decideAdvisorTurnIntent,
} from "../src/lib/meeting/advisor-turn-intent.js";

test("enforces abstention for a technical declarative statement", () => {
  const decision = decideAdvisorTurnIntent(
    "The control plane sends configuration to the data plane.",
    { hasActiveTask: false }
  );

  assert.equal(decision.intent, "informational");
  assert.equal(decision.action, "append-only");
  assert.equal(decision.enforcement, "enforce");
  assert.equal(decision.executionAuthorized, false);
  assert.ok(decision.confidence >= 0.85);
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
    assert.equal(decision.action, "answer-refresh", text);
    assert.equal(decision.executionAuthorized, true, text);
  }
});

test("keeps incomplete speech in shadow mode until sentence buffering exists", () => {
  const decision = decideAdvisorTurnIntent("Can you describe...", {
    hasActiveTask: false,
  });

  assert.equal(decision.intent, "incomplete");
  assert.equal(decision.enforcement, "shadow");
  assert.equal(decision.recommendedAction, "append-only");
  assert.equal(decision.action, "answer-refresh");
  assert.equal(decision.executionAuthorized, true);
});

test("preserves active-task constraints and elliptical technical probes", () => {
  const constraint = decideAdvisorTurnIntent(
    "Assume we have 10 million daily users",
    { hasActiveTask: true }
  );
  assert.equal(constraint.intent, "constraint-or-follow-up");
  assert.equal(constraint.executionAuthorized, true);

  const elliptical = decideAdvisorTurnIntent("Latency", {
    hasActiveTask: true,
  });
  assert.equal(elliptical.intent, "constraint-or-follow-up");
  assert.equal(elliptical.reason, "active-task-elliptical-probe");
  assert.equal(elliptical.executionAuthorized, true);
});

test("keeps useful active-task statements without refreshing the answer", () => {
  const decision = decideAdvisorTurnIntent(
    "The cache stores the active user profiles",
    { hasActiveTask: true }
  );

  assert.equal(decision.intent, "informational");
  assert.equal(decision.action, "append-only");
  assert.equal(decision.contextPromptEligible, true);
  assert.equal(decision.executionAuthorized, false);
});

test("recognizes compact recruiter-style elliptical prompts", () => {
  const decision = decideAdvisorTurnIntent(
    "Your experience with Kubernetes",
    { hasActiveTask: false }
  );

  assert.equal(decision.intent, "direct-question");
  assert.equal(decision.reason, "interview-elliptical-prompt");
  assert.equal(decision.executionAuthorized, true);
});

test("keeps medium-confidence ambiguous turns in shadow fail-open mode", () => {
  const decision = decideAdvisorTurnIntent("Kubernetes", {
    hasActiveTask: false,
  });

  assert.equal(decision.intent, "unknown");
  assert.equal(decision.enforcement, "shadow");
  assert.equal(decision.wouldSuppress, true);
  assert.equal(decision.action, "answer-refresh");
  assert.equal(decision.executionAuthorized, true);
});

test("requires context before a short confirmation can refresh an answer", () => {
  const unscoped = decideAdvisorTurnIntent("Yes", {
    hasActiveTask: true,
  });
  assert.equal(unscoped.intent, "confirmation");
  assert.equal(unscoped.executionAuthorized, false);

  const contextual = decideAdvisorTurnIntent("Yes", {
    hasActiveTask: true,
    hasPendingConfirmation: true,
  });
  assert.equal(contextual.intent, "confirmation");
  assert.equal(contextual.executionAuthorized, true);
});

test("execution authorization fails closed unless intent or an explicit action permits work", () => {
  assert.deepEqual(
    authorizeAdvisorExecution({
      force: false,
      hasExplicitAction: false,
    }),
    {
      authorized: false,
      reason: "missing-turn-intent-decision",
      bypassed: false,
    }
  );

  assert.deepEqual(
    authorizeAdvisorExecution({
      force: false,
      hasExplicitAction: true,
    }),
    {
      authorized: true,
      reason: "explicit-action-bypass",
      bypassed: true,
    }
  );
});
