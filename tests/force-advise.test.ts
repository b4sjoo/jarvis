import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyForceAdviseRepairCause,
  decideForceAdviseEligibility,
  deriveForceAdviseTargetStatus,
  forceAdviseStatusAfterAdvisorOutcome,
} from "../src/lib/meeting/force-advise.js";

test("force advise is available for a suppressed canonical target", () => {
  assert.deepEqual(decideForceAdviseEligibility({ status: "ready" }), {
    eligible: true,
    retryable: true,
    reason: "canonical-target-ready",
  });
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
