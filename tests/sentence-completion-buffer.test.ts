import assert from "node:assert/strict";
import test from "node:test";
import { decideAdvisorTurnIntent } from "../src/lib/meeting/advisor-turn-intent.js";
import {
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
