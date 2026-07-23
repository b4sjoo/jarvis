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

function job(revision: number) {
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

test("starts no more than two requests for one logical unit", async () => {
  const runtime = new TaxonomyAdjudicationRuntime<number>();
  const dispositions: string[] = [];
  for (const revision of [1, 2, 3]) {
    runtime.schedule(
      {
        job: job(revision),
        execute: async () => revision,
        onSettled: (result) => dispositions.push(result.disposition),
      },
      0
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(dispositions.filter((item) => item === "completed").length, 2);
  assert.ok(dispositions.includes("budget-exhausted"));
});
