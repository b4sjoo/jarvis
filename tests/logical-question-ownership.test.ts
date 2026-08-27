import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeLogicalQuestionUnitLease,
  createCanonicalLogicalQuestionLineage,
  createLogicalQuestionUnitLease,
  createResponseRecoveryQuestionLineage,
  decideLogicalQuestionMaterialization,
  decideLogicalQuestionPublication,
} from "../src/lib/meeting/logical-question-ownership.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import { composeLogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";

test("authorizes only the exact canonical logical-question revision", () => {
  const current = makeLogicalQuestionUnit();
  const lease = createLogicalQuestionUnitLease(current);

  assert.deepEqual(authorizeLogicalQuestionUnitLease(lease, current), {
    authorized: true,
    reason: "logical-question-current",
  });
  assert.equal(
    authorizeLogicalQuestionUnitLease(
      lease,
      { ...current, revision: current.revision + 1 }
    ).reason,
    "logical-question-revision-mismatch"
  );
  assert.equal(
    authorizeLogicalQuestionUnitLease(
      lease,
      { ...current, id: "logical-question-b" }
    ).reason,
    "logical-question-id-mismatch"
  );
  assert.equal(
    authorizeLogicalQuestionUnitLease(lease, undefined).reason,
    "logical-question-missing"
  );
});

test("source ownership is immutable even when id and revision match", () => {
  const current = makeLogicalQuestionUnit();
  const lease = createLogicalQuestionUnitLease(current);

  assert.equal(
    authorizeLogicalQuestionUnitLease(lease, {
      ...current,
      sourceTurnIds: ["turn_1", "turn_3"],
    }).reason,
    "logical-question-source-turns-mismatch"
  );
  assert.deepEqual(lease.sourceTurnIds, ["turn_1", "turn_2"]);
});

test("materializes every non-filler turn as a recoverable logical question", () => {
  assert.deepEqual(
    decideLogicalQuestionMaterialization({
      action: "answer-refresh",
      wordEquivalent: 1,
    }),
    { materialize: true, reason: "answer-refresh" }
  );
  assert.deepEqual(
    decideLogicalQuestionMaterialization({
      action: "ignore",
      wordEquivalent: 8,
    }),
    {
      materialize: true,
      reason: "substantive-non-filler-turn",
    }
  );
  assert.deepEqual(
    decideLogicalQuestionMaterialization({
      action: "ignore",
      wordEquivalent: 2,
    }),
    { materialize: true, reason: "substantive-non-filler-turn" }
  );
  assert.deepEqual(
    decideLogicalQuestionMaterialization({
      action: "ignore",
      wordEquivalent: 4,
      exactHighFiller: true,
    }),
    { materialize: false, reason: "exact-high-filler" }
  );
});

test("keeps every runtime-reviewed intent provisional so it cannot invalidate a generation", () => {
  const materialization = decideLogicalQuestionMaterialization({
    action: "answer-refresh",
    wordEquivalent: 2,
  });

  assert.deepEqual(
    decideLogicalQuestionPublication({
      materialization,
      runtimeIntentSettlementPending: true,
    }),
    {
      publishCanonical: false,
      mayInvalidateGeneration: false,
      reason: "provisional-intent-settlement",
    }
  );
  assert.deepEqual(
    decideLogicalQuestionPublication({
      materialization,
      runtimeIntentSettlementPending: false,
    }),
    {
      publishCanonical: true,
      mayInvalidateGeneration: true,
      reason: "canonical-substantive-turn",
    }
  );
});

test("canonical lineage keeps one question identity across revisions", () => {
  const first = makeLogicalQuestionUnit();
  const revised = {
    ...first,
    revision: 3,
    currentTurnId: "turn_3",
    sourceTurnIds: [...first.sourceTurnIds, "turn_3"],
  };

  const firstLineage = createCanonicalLogicalQuestionLineage({
    unit: first,
    traceId: "trace_1",
  });
  const revisedLineage = createCanonicalLogicalQuestionLineage({
    unit: revised,
    traceId: "trace_3",
  });

  assert.equal(firstLineage.questionInstanceId, revisedLineage.questionInstanceId);
  assert.equal(revisedLineage.triggerTurnId, "turn_3");
  assert.equal(revisedLineage.identityState, "canonical");
});

test("response recovery lineage is provisional and revision scoped", () => {
  const unit = makeLogicalQuestionUnit();
  const lineage = createResponseRecoveryQuestionLineage({
    unit,
    traceId: "trace_recovery",
  });

  assert.equal(lineage.questionInstanceId, "recovery:lqu:logical-question-a:2");
  assert.equal(lineage.identityState, "provisional");
  assert.equal(lineage.triggerTurnId, "turn_2");
});

test("a split-question revision stales every lease bound to the earlier turn", () => {
  const first = composeLogicalQuestionUnit({
    currentTurn: {
      id: "turn_1",
      speaker: "them",
      source: "system-audio",
      text: "Design a retrieval service",
      startedAt: 10,
      endedAt: 20,
      isFinal: true,
    },
    sessionId: "session_1",
    runtimeEpoch: 4,
    intentDecision: {
      intent: "direct-question",
      confidence: 0.9,
      evidence: ["explicit-design-request"],
      action: "answer-refresh",
      recommendedAction: "answer-refresh",
      reason: "direct-question",
      contextPromptEligible: true,
      enforcement: "allow",
      wouldSuppress: false,
      executionAuthorized: true,
    },
    now: 20,
  });
  const firstLease = createLogicalQuestionUnitLease(first);
  const revised = composeLogicalQuestionUnit({
    currentTurn: {
      id: "turn_2",
      speaker: "them",
      source: "system-audio",
      text: "and explain how you would evaluate it",
      startedAt: 30,
      endedAt: 40,
      isFinal: true,
    },
    sessionId: "session_1",
    runtimeEpoch: 4,
    previousUnit: first,
    intentDecision: {
      intent: "constraint-or-follow-up",
      confidence: 0.9,
      evidence: ["elliptical-continuation"],
      action: "answer-refresh",
      recommendedAction: "answer-refresh",
      reason: "scoped-follow-up",
      contextPromptEligible: true,
      enforcement: "allow",
      wouldSuppress: false,
      executionAuthorized: true,
    },
    now: 40,
  });

  assert.equal(revised.id, first.id);
  assert.equal(revised.revision, first.revision + 1);
  assert.equal(
    authorizeLogicalQuestionUnitLease(firstLease, revised).reason,
    "logical-question-revision-mismatch"
  );
});

function makeLogicalQuestionUnit(): LogicalQuestionUnit {
  return {
    id: "logical-question-a",
    revision: 2,
    sessionId: "session_1",
    runtimeEpoch: 4,
    currentTurnId: "turn_2",
    sourceTurnIds: ["turn_1", "turn_2"],
    sources: [
      {
        turnId: "turn_1",
        text: "Design a ranking service",
        startedAt: 10,
        endedAt: 20,
      },
      {
        turnId: "turn_2",
        text: "and explain the online metrics",
        startedAt: 30,
        endedAt: 40,
      },
    ],
    normalizedText:
      "Design a ranking service\nand explain the online metrics",
    startedAt: 10,
    updatedAt: 40,
    compositionReasons: ["bounded-continuation"],
    boundaryReason: "bounded-continuation",
    truncated: false,
  };
}
