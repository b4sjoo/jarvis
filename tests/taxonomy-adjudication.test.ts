import assert from "node:assert/strict";
import test from "node:test";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import {
  authorizeTaxonomyAdjudicationLease,
  createTaxonomyAdjudicationLease,
  projectLogicalQuestionForAdjudication,
} from "../src/lib/meeting/taxonomy-adjudication.js";

function unit(text: string, revision = 1): LogicalQuestionUnit {
  return {
    id: "logical-a",
    revision,
    sessionId: "session-a",
    runtimeEpoch: 2,
    currentTurnId: "turn-a",
    sourceTurnIds: ["turn-a"],
    sources: [
      { turnId: "turn-a", text, startedAt: 10, endedAt: 20 },
    ],
    normalizedText: text,
    startedAt: 10,
    updatedAt: 20,
    compositionReasons: ["independent-current-turn"],
    boundaryReason: "independent-current-turn",
    truncated: false,
  };
}

test("preserves first anchor and latest constraint when projecting overflow", () => {
  const logicalUnit = unit("ignored");
  logicalUnit.sourceTurnIds = ["turn-a", "turn-b", "turn-c"];
  logicalUnit.sources = [
    {
      turnId: "turn-a",
      text: `Design an enterprise retrieval service ${"anchor ".repeat(120)}`,
      startedAt: 10,
      endedAt: 20,
    },
    {
      turnId: "turn-b",
      text: `Some repeated background ${"filler ".repeat(180)}`,
      startedAt: 30,
      endedAt: 40,
    },
    {
      turnId: "turn-c",
      text: "Now switch to hybrid search and keep p99 latency under 100ms.",
      startedAt: 50,
      endedAt: 60,
    },
  ];
  logicalUnit.normalizedText = logicalUnit.sources
    .map((source) => source.text)
    .join("\n");

  const projection = projectLogicalQuestionForAdjudication(logicalUnit, 420);
  assert.equal(projection.safe, true);
  assert.ok(projection.text.length <= 420);
  assert.ok(
    projection.sourceTurns.reduce(
      (total, source, index) =>
        total + source.text.length + (index > 0 ? 1 : 0),
      0
    ) <= 420
  );
  assert.deepEqual(
    projection.sourceTurnIds,
    projection.sourceTurns.map((source) => source.turnId)
  );
  assert.match(projection.text, /Design an enterprise retrieval service/);
  assert.match(projection.text, /hybrid search/);
  assert.equal(projection.projectionReason, "anchor-switch-latest-constraint");
});

test("lease authorization retains revision, parent, and correction guards", () => {
  const logicalUnit = unit("Design an Uber-like service.", 2);
  const lease = createTaxonomyAdjudicationLease({
    operationId: "operation-a",
    sessionId: "session-a",
    runtimeEpoch: 2,
    logicalQuestionUnit: logicalUnit,
    manualCorrectionRevision: 4,
    sourceSettlementId: "question-source-a",
    questionSourceHash: "question-hash-a",
    expectedParentId: "parent-a",
    requestedAt: 100,
  });
  const current = {
    currentOperationId: "operation-a",
    sessionId: "session-a",
    runtimeEpoch: 2,
    logicalQuestionUnit: logicalUnit,
    sourceSettlementId: "question-source-a",
    questionSourceHash: "question-hash-a",
    manualCorrectionRevision: 4,
    activeParentId: "parent-a",
    activeParentRevision: undefined,
    logicalUnitClosed: false,
    selfHealingBudgetConsumed: false,
  };
  assert.deepEqual(authorizeTaxonomyAdjudicationLease(lease, current), {
    authorized: true,
  });
  assert.equal("sourceTurnIdsHash" in lease, false);
  assert.equal("taskBoundaryEpoch" in lease, false);
  assert.deepEqual(
    authorizeTaxonomyAdjudicationLease(lease, {
      ...current,
      logicalQuestionUnit: { ...logicalUnit, revision: 3 },
    }),
    {
      authorized: false,
      reason: "logical-unit-revision-mismatch",
    }
  );
  assert.deepEqual(
    authorizeTaxonomyAdjudicationLease(lease, {
      ...current,
      manualCorrectionRevision: 5,
    }),
    {
      authorized: false,
      reason: "manual-correction-revision-mismatch",
    }
  );
  assert.deepEqual(
    authorizeTaxonomyAdjudicationLease(lease, {
      ...current,
      sourceSettlementId: "question-source-b",
    }),
    {
      authorized: false,
      reason: "source-settlement-mismatch",
    }
  );
  assert.deepEqual(
    authorizeTaxonomyAdjudicationLease(lease, {
      ...current,
      activeParentId: "parent-b",
    }),
    { authorized: false, reason: "expected-parent-mismatch" }
  );
});
