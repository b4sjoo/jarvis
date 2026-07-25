import assert from "node:assert/strict";
import test from "node:test";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import {
  buildTaxonomyAdjudicationRequest,
  createTaxonomyAdjudicationLease,
} from "../src/lib/meeting/taxonomy-adjudication.js";
import { TaxonomyAdjudicationRuntime } from "../src/lib/meeting/taxonomy-adjudication-runtime.js";

function unit(revision: number): LogicalQuestionUnit {
  const text = `Design a recommendation service revision ${revision}`;
  return {
    id: "logical-a",
    revision,
    sessionId: "session-a",
    runtimeEpoch: 1,
    currentTurnId: `turn-${revision}`,
    sourceTurnIds: [`turn-${revision}`],
    sources: [
      {
        turnId: `turn-${revision}`,
        text,
        startedAt: revision,
        endedAt: revision,
      },
    ],
    normalizedText: text,
    startedAt: revision,
    updatedAt: revision,
    compositionReasons: ["test"],
    boundaryReason: "test",
    truncated: false,
  };
}

function job(
  revision: number,
  budgetSlot: "ambient" | "substantive" = "substantive"
) {
  const logicalUnit = unit(revision);
  return {
    traceId: `trace-${revision}`,
    lease: createTaxonomyAdjudicationLease({
      operationId: `operation-${revision}`,
      sessionId: "session-a",
      runtimeEpoch: 1,
      logicalQuestionUnit: logicalUnit,
      taskBoundaryEpoch: 1,
      manualCorrectionRevision: 0,
    }),
    request: buildTaxonomyAdjudicationRequest({
      logicalQuestionUnit: logicalUnit,
    }),
    triggerReasons: ["lexical-unknown"],
    budgetSlot,
    budgetReason:
      budgetSlot === "ambient"
        ? "ambiguous-ambient"
        : "source-owned-primary-ask",
  };
}

test("coalesces pending revisions and executes only the latest", async () => {
  const runtime = new TaxonomyAdjudicationRuntime<number>();
  const executed: number[] = [];
  const settled: string[] = [];
  const execute = async (current: ReturnType<typeof job>) => {
    executed.push(current.lease.logicalQuestionUnitRevision);
    return current.lease.logicalQuestionUnitRevision;
  };
  runtime.schedule(
    {
      job: job(1),
      execute,
      onSettled: (result) => settled.push(`${result.job.traceId}:${result.disposition}`),
    },
    10
  );
  runtime.schedule(
    {
      job: job(2),
      execute,
      onSettled: (result) => settled.push(`${result.job.traceId}:${result.disposition}`),
    },
    10
  );
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(executed, [2]);
  assert.ok(settled.includes("trace-1:superseded"));
  assert.ok(settled.includes("trace-2:completed"));
});

test("reserves one substantive start after ambient budget is exhausted", async () => {
  const runtime = new TaxonomyAdjudicationRuntime<number>();
  const settlements: Array<{
    disposition: string;
    slot: string;
    reservedSubstantiveAvailable: boolean;
  }> = [];
  for (const [revision, slot] of [
    [1, "ambient"],
    [2, "ambient"],
    [3, "substantive"],
    [4, "substantive"],
  ] as const) {
    runtime.schedule(
      {
        job: job(revision, slot),
        execute: async () => revision,
        onSettled: (result) =>
          settlements.push({
            disposition: result.disposition,
            slot: result.budget.slot,
            reservedSubstantiveAvailable:
              result.budget.reservedSubstantiveAvailable,
          }),
      },
      0
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(
    settlements.map((item) => `${item.slot}:${item.disposition}`),
    [
      "ambient:completed",
      "ambient:budget-exhausted",
      "substantive:completed",
      "substantive:budget-exhausted",
    ]
  );
  assert.equal(settlements[0]?.reservedSubstantiveAvailable, true);
  assert.equal(settlements[2]?.reservedSubstantiveAvailable, false);
});

test("a superseded pending revision does not consume its requested slot", async () => {
  const runtime = new TaxonomyAdjudicationRuntime<number>();
  const settlements: string[] = [];
  runtime.schedule(
    {
      job: job(1, "ambient"),
      execute: async () => 1,
      onSettled: (result) =>
        settlements.push(
          `${result.job.traceId}:${result.disposition}:${result.budget.startsAfter}`
        ),
    },
    20
  );
  runtime.schedule(
    {
      job: job(2, "ambient"),
      execute: async () => 2,
      onSettled: (result) =>
        settlements.push(
          `${result.job.traceId}:${result.disposition}:${result.budget.startsAfter}`
        ),
    },
    0
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(settlements.includes("trace-1:superseded:0"));
  assert.ok(settlements.includes("trace-2:completed:1"));
});
