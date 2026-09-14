import assert from "node:assert/strict";
import test from "node:test";
import { MeetingTraceStore, type MeetingTraceChange } from "../src/lib/meeting/trace.js";
import { materializeHumanEvaluationAttemptProjectionV2, selectAffectedEvaluationTraces } from "../src/lib/meeting/human-evaluation-attempt-projection.js";
import type { HumanEvaluationProjectionV2 } from "../src/lib/meeting/human-ground-truth-v2.js";
import type { MeetingTrace } from "../src/lib/meeting/types.js";

function trace(id: string, unit = id): MeetingTrace {
  return { id, kind: "voice", status: "success", startedAt: 1, steps: [], inputs: [], outputs: [], metadata: {
    effectiveCurrentQuestionSettlementId: `settlement:${id}`,
    effectiveCurrentQuestionSettlementSessionId: "session",
    effectiveCurrentQuestionSettlementRuntimeEpoch: 1,
    effectiveCurrentQuestionSettlementUnitId: unit,
    effectiveCurrentQuestionSettlementRevision: 1,
    effectiveCurrentQuestionSettlementSourceHash: `source:${unit}`,
    effectiveCurrentQuestionSettlementQuestionType: "coding",
    effectiveCurrentQuestionSettlementRelation: "followup-parent",
    questionInstanceId: `question:${unit}`,
  } };
}

test("OP2 observer mutations reuse every unaffected trace and publish terminals synchronously", () => {
  const store = new MeetingTraceStore();
  store.hydrate(Array.from({ length: 500 }, (_, i) => trace(`t${i}`)));
  let snapshot: MeetingTrace[] = [];
  let delta: MeetingTraceChange | undefined;
  const unsubscribe = store.subscribe((next, change) => { snapshot = next; delta = change; });
  const before = snapshot;
  store.updateMetadata("t42", { answerCommitted: true });
  assert.equal(delta?.changed.length, 1);
  assert.equal(delta?.changed[0].id, "t42");
  for (let i = 0; i < before.length; i++) {
    if (before[i].id === "t42") assert.notEqual(snapshot[i], before[i]);
    else assert.equal(snapshot[i], before[i]);
  }
  assert.equal(before.find((t) => t.id === "t42")?.metadata?.answerCommitted, undefined);
  const read = store.getTrace("t42")!;
  read.metadata!.answerCommitted = false;
  assert.equal(store.getTrace("t42")?.metadata?.answerCommitted, true);
  store.finishTrace("t42", "error", "terminal");
  assert.equal(delta?.changed[0].status, "error");
  const latest = snapshot;
  unsubscribe(); store.updateMetadata("t42", { later: true });
  assert.equal(snapshot, latest);
});

test("OP2 eviction, reset and subscription replacement have explicit deltas", () => {
  const store = new MeetingTraceStore();
  store.hydrate(Array.from({ length: 500 }, (_, i) => trace(`t${i}`)));
  let previousCalls = 0;
  const oldUnsubscribe = store.subscribe(() => { previousCalls++; });
  const deltas: MeetingTraceChange[] = [];
  store.subscribe((_rows, change) => { deltas.push(change); });
  oldUnsubscribe();
  store.startTrace("screen", {}, 10);
  assert.equal(previousCalls, 1);
  assert.equal(deltas.at(-1)?.removedTraceIds.length, 1);
  assert.equal(store.getObserverSnapshot().length, 500);
  store.clear();
  assert.equal(deltas.at(-1)?.reset, true);
  assert.equal(deltas.at(-1)?.removedTraceIds.length, 500);
  assert.equal(store.getObserverSnapshot().length, 0);
});

test("OP3 exact old/new LQU identity and explicit correction references select dependent attempts", () => {
  const a = trace("a", "shared"), b = trace("b", "shared"), c = trace("c");
  const linked = trace("linked"); linked.metadata!.parentCorrectionTraceId = "a";
  const changed = { ...a, metadata: { ...a.metadata, effectiveCurrentQuestionSettlementUnitId: "new", effectiveCurrentQuestionSettlementSourceHash: "source:new" } };
  const next = trace("next", "new");
  const selected = selectAffectedEvaluationTraces({ traces: [changed, b, c, linked, next], previousTraces: [a, b, c, linked], changed: [changed], removedTraceIds: [] });
  assert.deepEqual(selected.map((t) => t.id), ["a", "b", "linked", "next"]);
  const removed = selectAffectedEvaluationTraces({ traces: [b, c, linked], previousTraces: [a, b, c, linked], changed: [], removedTraceIds: ["a"] });
  assert.deepEqual(removed.map((t) => t.id), ["b", "linked"]);
  const otherEpoch = { ...b, metadata: { ...b.metadata, effectiveCurrentQuestionSettlementRuntimeEpoch: 2 } };
  assert.deepEqual(selectAffectedEvaluationTraces({ traces: [a, otherEpoch], previousTraces: [a, otherEpoch], changed: [a], removedTraceIds: [] }).map((t) => t.id), ["a"]);
});

test("OP3/OP4 incremental materialization equals a full sweep as primary-ask evidence arrives and leaves", () => {
  let all = [trace("a", "shared"), trace("b", "shared"), trace("unrelated")];
  let full: HumanEvaluationProjectionV2[] = [], incremental: HumanEvaluationProjectionV2[] = [];
  const apply = (rows: MeetingTrace[], projections: HumanEvaluationProjectionV2[]) => {
    for (const t of rows) projections = materializeHumanEvaluationAttemptProjectionV2({ trace: t, traces: all, currentSessionId: "session", events: [], projections, now: 123 }).projections;
    return projections;
  };
  full = apply(all, full); incremental = apply(all, incremental);
  for (const target of ["Explain the implementation", "Compare the two approaches", undefined]) {
    const previous = all;
    const changed = { ...all[0], metadata: { ...all[0].metadata, responseOpportunityDecisionTarget: target, responseOpportunityDecision: "output-request", responseOpportunityParseValid: true } };
    all = [changed, ...all.slice(1)];
    const affected = selectAffectedEvaluationTraces({ traces: all, previousTraces: previous, changed: [changed], removedTraceIds: [] });
    assert.deepEqual(affected.map((t) => t.id), ["a", "b"]);
    full = apply(all, full); incremental = apply(affected, incremental);
    assert.deepEqual(incremental, full);
    for (const t of affected) assert.equal(materializeHumanEvaluationAttemptProjectionV2({ trace: t, traces: all, currentSessionId: "session", events: [], projections: incremental, now: 456 }).changed, false);
  }
});
