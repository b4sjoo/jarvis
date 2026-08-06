import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeAdvisorExecution,
  decideAdvisorTurnIntent,
  formatAdvisorTurnIntentForTrace,
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
    assert.equal(decision.action, "answer-refresh", text);
    assert.equal(decision.executionAuthorized, true, text);
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
    assert.equal(decision.action, "append-only", text);
    assert.equal(decision.executionAuthorized, false, text);
  }
});

test("keeps unbuffered incomplete speech in shadow mode as a fail-open fallback", () => {
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

test("uses provisional question scope for corrections and follow-ups", () => {
  const correction = decideAdvisorTurnIntent(
    "You are over-designing it, just write the code",
    { hasActiveTask: false, hasRecentQuestionContext: true }
  );
  assert.equal(correction.intent, "correction");
  assert.equal(correction.action, "answer-refresh");
  assert.equal(correction.reason, "scoped-correction-direct-ask");
  assert.equal(correction.followupScopeSource, "provisional-question");

  const constraint = decideAdvisorTurnIntent(
    "Find all the text files instead of only the first one",
    { hasActiveTask: false, hasRecentQuestionContext: true }
  );
  assert.equal(constraint.intent, "correction");
  assert.equal(constraint.action, "answer-refresh");
  assert.equal(constraint.reason, "recent-question-correction");
  assert.equal(constraint.followupScopeSource, "provisional-question");
});

test("allows an explicit language constraint only with provisional question scope", () => {
  const scoped = decideAdvisorTurnIntent("In Python.", {
    hasActiveTask: false,
    hasRecentQuestionContext: true,
  });
  assert.equal(scoped.intent, "constraint-or-follow-up");
  assert.equal(scoped.action, "answer-refresh");
  assert.equal(scoped.reason, "recent-question-constraint");
  assert.equal(scoped.followupScopeSource, "provisional-question");
  assert.ok(scoped.evidence.includes("programming-language:Python"));

  const unscoped = decideAdvisorTurnIntent("In Python.", {
    hasActiveTask: false,
    hasRecentQuestionContext: false,
  });
  assert.equal(unscoped.intent, "informational");
  assert.equal(unscoped.action, "append-only");
  assert.equal(unscoped.reason, "unscoped-constraint");
  assert.equal(unscoped.executionAuthorized, false);
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
    assert.equal(decision.action, "answer-refresh", text);
    assert.equal(decision.reason, "recent-question-constraint", text);
  }
});

test("direct asks survive correction wording without question scope", () => {
  const decision = decideAdvisorTurnIntent(
    "Not a recommendation system. Can you explain RAG instead?",
    { hasActiveTask: false, hasRecentQuestionContext: false }
  );

  assert.equal(decision.intent, "correction");
  assert.equal(decision.action, "answer-refresh");
  assert.equal(decision.reason, "self-contained-correction-direct-ask");
  assert.equal(decision.followupScopeSource, "none");
});

test("keeps a truly unscoped correction append-only", () => {
  const decision = decideAdvisorTurnIntent("Not recommendation, RAG", {
    hasActiveTask: false,
    hasRecentQuestionContext: false,
  });

  assert.equal(decision.intent, "correction");
  assert.equal(decision.action, "append-only");
  assert.equal(decision.reason, "unscoped-correction");
  assert.equal(decision.followupScopeSource, "none");
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
    assert.equal(decision.action, "ignore", text);
    assert.equal(decision.reason, "exact-acknowledgement", text);
    assert.equal(decision.executionAuthorized, false, text);
    assert.ok(decision.evidence.includes("exact-acknowledgement"), text);
    assert.deepEqual(
      {
        operation:
          formatAdvisorTurnIntentForTrace(decision).advisorSuppressionOperation,
        avoided:
          formatAdvisorTurnIntentForTrace(decision).advisorProviderCallAvoided,
      },
      {
        operation: "exact-acknowledgement",
        avoided: true,
      },
      text
    );
  }

  const addOn = decideAdvisorTurnIntent(
    "That looks good to me, now write merge sort.",
    { hasActiveTask: true }
  );
  assert.equal(addOn.intent, "direct-question");
  assert.equal(addOn.action, "answer-refresh");
  assert.equal(addOn.executionAuthorized, true);

  const acousticAddOn = decideAdvisorTurnIntent(
    "Mm, OK, now estimate QPS.",
    { hasActiveTask: true }
  );
  assert.equal(acousticAddOn.intent, "direct-question");
  assert.equal(acousticAddOn.action, "answer-refresh");
  assert.equal(acousticAddOn.executionAuthorized, true);
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
