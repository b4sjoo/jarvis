import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyForceAdviseRepairCause,
  decideForceAdviseEligibility,
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

test("force advise remains blocked while the same revision is running or committed", () => {
  assert.equal(
    decideForceAdviseEligibility({ status: "advising" }).eligible,
    false
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
    }),
    "failed"
  );
});
