import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeLateScreenPreflightRepair,
  type LateScreenPreflightRepairLease,
} from "../src/lib/meeting/late-screen-preflight-repair.js";

const lease: LateScreenPreflightRepairLease = {
  sourceOperationId: "screen-op-a",
  sourcePreflightLeaseRevision: 1,
  sourceObservationId: "screen-a",
  sessionId: "session-a",
  runtimeEpoch: 4,
  settlementId: "settlement-a",
  settlementRevision: 1,
  baseVisibleAnswerRevision: 3,
  manualCorrectionRevision: 0,
  questionType: "behavioral",
  createdAt: 100,
};

function authorize(
  overrides: Partial<
    Parameters<typeof authorizeLateScreenPreflightRepair>[0]
  > = {}
) {
  return authorizeLateScreenPreflightRepair({
    stage: "candidate",
    lease,
    runtimeActive: true,
    activeOperationId: "screen-op-a",
    currentSessionId: "session-a",
    currentRuntimeEpoch: 4,
    currentObservationId: "screen-a",
    currentSettlementId: "settlement-a",
    currentSettlementRevision: 1,
    currentVisibleAnswerRevision: 3,
    currentManualCorrectionRevision: 0,
    ...overrides,
  });
}

test("authorizes one late candidate while its Screen operation is still pre-visible", () => {
  assert.deepEqual(authorize(), {
    authorized: true,
    reason: "authorized",
  });
  assert.deepEqual(
    authorize({ stage: "replay", activeOperationId: null }),
    { authorized: true, reason: "authorized" }
  );
});

test("rejects newer Screen operations and changed source identity", () => {
  assert.equal(
    authorize({ activeOperationId: "screen-op-b" }).reason,
    "operation-mismatch"
  );
  assert.equal(
    authorize({ currentObservationId: "screen-b" }).reason,
    "observation-mismatch"
  );
  assert.equal(
    authorize({
      stage: "replay",
      activeOperationId: "screen-op-b",
    }).reason,
    "newer-operation-active"
  );
});

test("rejects post-visible, corrected, and resettled candidates", () => {
  assert.equal(
    authorize({ currentVisibleAnswerRevision: 4 }).reason,
    "visible-answer-revision-changed"
  );
  assert.equal(
    authorize({ currentManualCorrectionRevision: 1 }).reason,
    "manual-correction-revision-changed"
  );
  assert.equal(
    authorize({ currentSettlementRevision: 2 }).reason,
    "settlement-revision-mismatch"
  );
});

test("rejects runtime changes and unresolved late types", () => {
  assert.equal(authorize({ runtimeActive: false }).reason, "runtime-inactive");
  assert.equal(
    authorize({ currentRuntimeEpoch: 5 }).reason,
    "runtime-epoch-mismatch"
  );
  assert.equal(
    authorize({
      lease: { ...lease, questionType: "unknown" },
    }).reason,
    "question-type-unresolved"
  );
});
