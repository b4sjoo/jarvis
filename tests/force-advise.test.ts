import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyForceAdviseRepairCause,
  decideForceAdviseEligibility,
  deriveForceAdviseTargetStatus,
  forceAdviseStatusAfterAdvisorOutcome,
  matchesForceAdviseTargetTransition,
} from "../src/lib/meeting/force-advise.js";

test("force advise is available for a suppressed response recovery target", () => {
  assert.deepEqual(decideForceAdviseEligibility({ status: "ready" }), {
    eligible: true,
    retryable: true,
    reason: "recovery-target-ready",
  });
});

test("a newer recovery target is eligible even after the canonical answer committed", () => {
  assert.equal(
    decideForceAdviseEligibility({
      status: "already-advised",
      automaticExecutionState: "visible-committed",
    }).eligible,
    false
  );
  assert.deepEqual(
    decideForceAdviseEligibility({
      status: "ready",
      automaticExecutionState: "not-started",
      manualExecutionState: "idle",
    }),
    {
      eligible: true,
      retryable: true,
      reason: "recovery-target-ready",
    }
  );
});

test("recovery transitions require the exact target identity", () => {
  const current = {
    targetId: "response-recovery:trace-new:turn-new:lqu-a:2",
    targetKind: "response-recovery" as const,
    logicalQuestionUnitId: "lqu-a",
    logicalQuestionUnitRevision: 2,
  };

  assert.equal(
    matchesForceAdviseTargetTransition(current, {
      logicalQuestionUnitId: "lqu-a",
      logicalQuestionUnitRevision: 2,
    }),
    false
  );
  assert.equal(
    matchesForceAdviseTargetTransition(current, {
      targetId: "response-recovery:trace-old:turn-old:lqu-a:2",
      logicalQuestionUnitId: "lqu-a",
      logicalQuestionUnitRevision: 2,
    }),
    false
  );
  assert.equal(
    matchesForceAdviseTargetTransition(current, {
      targetId: current.targetId,
      logicalQuestionUnitId: "lqu-a",
      logicalQuestionUnitRevision: 2,
    }),
    true
  );
});

test("force advise becomes retryable after an advisor execution failure", () => {
  assert.deepEqual(decideForceAdviseEligibility({ status: "failed" }), {
    eligible: true,
    retryable: true,
    reason: "previous-advisor-attempt-failed",
  });
  assert.equal(
    classifyForceAdviseRepairCause({ executionAuthorized: true }),
    "advisor-execution-failure"
  );
});

test("force advise remains available until the current answer is visible", () => {
  assert.deepEqual(decideForceAdviseEligibility({ status: "advising" }), {
    eligible: true,
    retryable: true,
    reason: "automatic-advisor-running",
  });
  assert.deepEqual(
    decideForceAdviseEligibility({ status: "delivery-pending" }),
    {
      eligible: true,
      retryable: true,
      reason: "delivery-pending-without-visible-commit",
    }
  );
  assert.equal(
    decideForceAdviseEligibility({ status: "already-advised" }).eligible,
    false
  );
  assert.equal(
    decideForceAdviseEligibility({ status: "repairing" }).eligible,
    false
  );
  assert.equal(
    decideForceAdviseEligibility({ status: "repaired" }).eligible,
    false
  );
  assert.equal(
    decideForceAdviseEligibility({ status: "stale" }).eligible,
    false
  );
});

test("force advise distinguishes intent misses from execution failures", () => {
  assert.equal(
    classifyForceAdviseRepairCause({ executionAuthorized: false }),
    "intent-false-negative"
  );
  assert.equal(
    forceAdviseStatusAfterAdvisorOutcome({
      committedVisibleAnswer: true,
    }),
    "already-advised"
  );
  assert.equal(
    forceAdviseStatusAfterAdvisorOutcome({
      committedVisibleAnswer: false,
      deliveryPending: true,
    }),
    "delivery-pending"
  );
  assert.equal(
    forceAdviseStatusAfterAdvisorOutcome({
      committedVisibleAnswer: false,
    }),
    "failed"
  );
  assert.equal(
    classifyForceAdviseRepairCause({
      executionAuthorized: true,
      automaticExecutionState: "delivery-pending",
    }),
    "visible-delivery-recovery"
  );
});

test("manual execution state outranks automatic background state", () => {
  assert.equal(
    deriveForceAdviseTargetStatus({
      automaticExecutionState: "running",
      manualExecutionState: "running",
    }),
    "repairing"
  );
  assert.equal(
    deriveForceAdviseTargetStatus({
      automaticExecutionState: "visible-committed",
      manualExecutionState: "visible-committed",
    }),
    "repaired"
  );
  assert.deepEqual(
    decideForceAdviseEligibility({
      status: "repairing",
      automaticExecutionState: "running",
      manualExecutionState: "running",
    }),
    {
      eligible: false,
      retryable: false,
      reason: "manual-repair-running",
    }
  );
  assert.equal(
    deriveForceAdviseTargetStatus({
      automaticExecutionState: "visible-committed",
      manualExecutionState: "failed",
    }),
    "already-advised"
  );
  assert.deepEqual(
    decideForceAdviseEligibility({
      status: "repairing",
      automaticExecutionState: "visible-committed",
      manualExecutionState: "running",
    }),
    {
      eligible: false,
      retryable: false,
      reason: "advisor-committed",
    }
  );
});
