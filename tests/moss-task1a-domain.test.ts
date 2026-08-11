import assert from "node:assert/strict";
import test from "node:test";
import {
  CALL_PLAN_TRANSITIONS,
  CASE_TRANSITIONS,
  SNAPSHOT_TRANSITIONS,
  requireCaseScope,
  requireExpectedRevision,
  requireStatementConfirmation,
  requireTransition,
} from "../src/lib/preparation/index.js";

test("case, call plan, and snapshot lifecycles remain independent", () => {
  assert.doesNotThrow(() =>
    requireTransition({
      entity: "Case",
      from: "open",
      to: "waiting",
      allowed: CASE_TRANSITIONS,
    })
  );
  assert.doesNotThrow(() =>
    requireTransition({
      entity: "CallPlan",
      from: "ready",
      to: "used",
      allowed: CALL_PLAN_TRANSITIONS,
    })
  );
  assert.doesNotThrow(() =>
    requireTransition({
      entity: "Snapshot",
      from: "ready",
      to: "superseded",
      allowed: SNAPSHOT_TRANSITIONS,
    })
  );
  assert.throws(
    () =>
      requireTransition({
        entity: "Snapshot",
        from: "invalidated",
        to: "ready",
        allowed: SNAPSHOT_TRANSITIONS,
      }),
    /cannot transition/
  );
});

test("case scope and compare-and-swap revisions fail closed", () => {
  assert.throws(
    () =>
      requireCaseScope({
        expectedCaseId: "case-a",
        actualCaseId: "case-b",
        entity: "CallPlan",
      }),
    /different case/
  );
  assert.throws(
    () =>
      requireExpectedRevision({ entity: "Case", expected: 2, actual: 3 }),
    /revision conflict/
  );
});

test("unsupported high-impact statements cannot be confirmed", () => {
  assert.throws(
    () =>
      requireStatementConfirmation({
        reviewState: "proposed",
        sourceCount: 0,
        highImpact: true,
      }),
    /require a source/
  );
  assert.doesNotThrow(() =>
    requireStatementConfirmation({
      reviewState: "proposed",
      sourceCount: 1,
      highImpact: true,
    })
  );
});
