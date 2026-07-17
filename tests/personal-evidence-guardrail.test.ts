import assert from "node:assert/strict";
import test from "node:test";
import { detectPersonalEvidenceRequirement } from "../src/lib/meeting/personal-evidence-guardrail.js";

test("detects a direct project contribution question with high confidence", () => {
  const decision = detectPersonalEvidenceRequirement({
    questionText: "What did you implement in this feature?",
    questionType: "coding",
    mode: "enforcement",
  });

  assert.equal(decision.requirement, "autobiographical-project");
  assert.equal(decision.confidenceTier, "high");
  assert.equal(decision.enforced, true);
});

test("treats proposed testing methods as question text rather than evidence", () => {
  const decision = detectPersonalEvidenceRequirement({
    questionText:
      "Did you use manual tests, load tests, automation, or a canary rollout?",
    questionType: "unknown",
  });

  assert.equal(decision.requirement, "autobiographical-project");
  assert.equal(decision.enforced, true);
  assert.deepEqual(decision.signals, ["past-tool-or-method-choice"]);
});

test("detects explicit behavioral history independently of taxonomy", () => {
  const decision = detectPersonalEvidenceRequirement({
    questionText:
      "Tell me about a time when you persuaded someone who disagreed with you.",
    questionType: "field-knowledge",
  });

  assert.equal(decision.requirement, "autobiographical-behavioral");
  assert.equal(decision.confidenceTier, "high");
  assert.equal(decision.enforced, true);
});

test("does not treat a hypothetical coding request as autobiography", () => {
  const decision = detectPersonalEvidenceRequirement({
    questionText: "How would you implement a stack with two queues?",
    questionType: "coding",
  });

  assert.equal(decision.requirement, "not-required");
  assert.equal(decision.enforced, false);
  assert.ok(decision.counterSignals.includes("hypothetical-how-would"));
});

test("does not treat system design as personal history", () => {
  const decision = detectPersonalEvidenceRequirement({
    questionText: "Design a ticket selling system for high concurrency.",
    questionType: "general-system-design",
  });

  assert.equal(decision.requirement, "not-required");
  assert.equal(decision.enforced, false);
});

test("does not require personal evidence for field knowledge", () => {
  const decision = detectPersonalEvidenceRequirement({
    questionText: "What is retrieval-augmented generation?",
    questionType: "field-knowledge",
  });

  assert.equal(decision.requirement, "not-required");
});

test("detects personal logistics without requiring project evidence", () => {
  const decision = detectPersonalEvidenceRequirement({
    questionText: "Are you authorized to work in the United States?",
    questionType: "unknown",
  });

  assert.equal(decision.requirement, "personal-logistics");
  assert.equal(decision.confidenceTier, "high");
  assert.equal(decision.enforced, false);
});

test("keeps medium-confidence personal language telemetry-only", () => {
  const decision = detectPersonalEvidenceRequirement({
    questionText: "What is your experience with vector databases?",
    questionType: "field-knowledge",
  });

  assert.equal(decision.requirement, "autobiographical-project");
  assert.equal(decision.confidenceTier, "medium");
  assert.equal(decision.enforced, false);
});

test("shadow mode records high-confidence detection without enforcement", () => {
  const decision = detectPersonalEvidenceRequirement({
    questionText: "How did you validate this system in production?",
    questionType: "unknown",
    mode: "shadow",
  });

  assert.equal(decision.requirement, "autobiographical-project");
  assert.equal(decision.confidenceTier, "high");
  assert.equal(decision.mode, "shadow");
  assert.equal(decision.enforced, false);
});
