import assert from "node:assert/strict";
import test from "node:test";
import { resolveOrderedTaskRelationWithinWindow, type TaskRelationAdjudicationScheduleHandle } from "../src/lib/meeting/ordered-relation-operation.js";

const dependencies = {
  now: () => 1_000,
  withTimeout: <T>(promise: Promise<T>) => promise,
  recordMetadata: (_traceId: string, _metadata: Record<string, unknown>) => {},
};
const handle = (): TaskRelationAdjudicationScheduleHandle => ({ releaseWindowRequested: true,
  authorizeOperation: () => ({ authorized: true, reason: "authorized" }) });

test("OR direct operation uses the shared first-parent matrix without Canonical", async () => {
  const h = handle();
  h.startCanonical = () => { throw new Error("unexpected Canonical invocation"); };
  const result = await resolveOrderedTaskRelationWithinWindow({ handle: h, traceId: "first-parent",
    sourceKind: "voice", currentQuestionType: "coding", waitBudgetMs: 8_000 }, dependencies);
  assert.equal(result.terminalDisposition, "resolved");
  assert.equal(result.decision.relation, "new-parent");
  assert.equal(result.metadata.taskRelationOrderedResolutionWaitMs, 0);
});

test("OR invalid operation cannot release even a deterministic decision", async () => {
  let cancelled = 0;
  const h = { ...handle(), authorizeOperation: () => ({ authorized: false, reason: "epoch-changed" }),
    cancelForegroundWork: () => { cancelled++; } };
  const result = await resolveOrderedTaskRelationWithinWindow({ handle: h, traceId: "stale",
    sourceKind: "screen", currentQuestionType: "coding", waitBudgetMs: 8_000 }, dependencies);
  assert.equal(result.terminalDisposition, "cancelled");
  assert.equal(result.operationAuthorization.reason, "epoch-changed");
  assert.equal(cancelled, 1);
});

test("OR unexpected affinity failure propagates without semantic fallback", async () => {
  const error = new Error("broken internal invariant");
  const h = { ...handle(), affinityOutcome: Promise.reject(error) };
  await assert.rejects(resolveOrderedTaskRelationWithinWindow({ handle: h, traceId: "failure",
    sourceKind: "voice", currentQuestionType: "coding", waitBudgetMs: 8_000 }, dependencies),
  caught => caught === error);
});
