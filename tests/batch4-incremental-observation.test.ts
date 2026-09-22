import assert from "node:assert/strict";
import test from "node:test";
import { materializeHumanEvaluationAttemptProjectionV2, selectAffectedEvaluationTraces } from "../src/lib/meeting/human-evaluation-attempt-projection.js";
import { createHumanGroundTruthEventV2, type HumanEvaluationProjectionV2, type HumanGroundTruthEventV2 } from "../src/lib/meeting/human-ground-truth-v2.js";
import type { MeetingTrace } from "../src/lib/meeting/types.js";

function trace(id: string, unit = id): MeetingTrace {
  return { id, kind: "voice", status: "success", startedAt: 1, steps: [], inputs: [], outputs: [], metadata: {
    effectiveCurrentQuestionSettlementId: `settlement:${id}`,
    effectiveCurrentQuestionSettlementSessionId: "batch4",
    effectiveCurrentQuestionSettlementRuntimeEpoch: 1,
    effectiveCurrentQuestionSettlementUnitId: unit,
    effectiveCurrentQuestionSettlementRevision: 1,
    effectiveCurrentQuestionSettlementSourceHash: `source:${unit}`,
    effectiveCurrentQuestionSettlementQuestionType: "coding",
    effectiveCurrentQuestionSettlementRelation: "followup-parent",
    questionInstanceId: `question:${unit}`,
  } };
}

for (const size of [20, 100, 300, 500]) {
  test(`LC1 ${size} histories: incremental/full parity for late primary ask, correction, removal, backfill and truth`, () => {
    const correction = trace("correction", "shared");
    Object.assign(correction.metadata!, { manualQuestionTypeCorrectionId: "correction-id", taskLifecycleAuthorized: true,
      taskLifecycleMutationApplied: true, settledExecutionPlanTaskMutationCommand: "replace-parent",
      taskLifecycleParentBeforeId: "parent", taskLifecycleParentAfterId: "parent",
      taskLifecycleParentBeforeType: "general-system-design", taskLifecycleParentAfterType: "coding" });
    const generated = trace("generated", "shared");
    Object.assign(generated.metadata!, { parentCorrectionTraceId: "correction", manualQuestionTypeCorrectionId: "correction-id", settledExecutionPlanTaskMutationCommand: "replace-parent" });
    const otherEpoch = trace("other-epoch", "shared");
    otherEpoch.metadata!.effectiveCurrentQuestionSettlementRuntimeEpoch = 2;
    let all = [trace("ask", "shared"), generated, otherEpoch,
      ...Array.from({ length: size - 3 }, (_, index) => trace(`unrelated-${index}`))];
    let full: HumanEvaluationProjectionV2[] = [], incremental: HumanEvaluationProjectionV2[] = [];
    let events: HumanGroundTruthEventV2[] = [];
    const apply = (rows: MeetingTrace[], projections: HumanEvaluationProjectionV2[]) => {
      for (const item of rows) projections = materializeHumanEvaluationAttemptProjectionV2({
        trace: item, traces: all, currentSessionId: "batch4", events, projections, now: 123,
      }).projections;
      return projections;
    };
    full = apply(all, full);
    incremental = apply(all, incremental);
    const untouched = incremental.find(p => p.subject.traceIds.includes("unrelated-0"))!;
    assert.ok(untouched);
    const checkpoint = (changed: MeetingTrace[], removedTraceIds: string[] = []) => {
      const previousTraces = all;
      all = all.filter(item => !removedTraceIds.includes(item.id)).map(item => changed.find(next => next.id === item.id) ?? item);
      all.push(...changed.filter(item => !previousTraces.some(previous => previous.id === item.id)));
      const affected = selectAffectedEvaluationTraces({ traces: all, previousTraces, changed, removedTraceIds });
      assert.ok(affected.length <= 3, `unexpected fanout: ${affected.map(t => t.id)}`);
      assert.ok(affected.every(item => !item.id.startsWith("unrelated-") && item.id !== "other-epoch"));
      full = apply(all, full);
      incremental = apply(affected, incremental);
      assert.deepEqual(incremental, full);
      assert.equal(incremental.find(p => p.subject.traceIds.includes("unrelated-0")), untouched);
      for (const item of affected) assert.equal(materializeHumanEvaluationAttemptProjectionV2({
        trace: item, traces: all, currentSessionId: "batch4", events, projections: incremental, now: 999,
      }).changed, false, "stable observations must not write another projection");
    };
    checkpoint([{ ...all[0], metadata: { ...all[0].metadata, responseOpportunityDecision: "output-request", responseOpportunityParseValid: true, responseOpportunityDecisionTarget: "Explain the visible implementation." } }]);
    assert.ok(incremental.some(p => p.observed?.primaryAsk === "Explain the visible implementation."));
    checkpoint([correction]);
    assert.equal(incremental.find(p => p.subject.traceIds.includes("generated"))?.observed?.parentAction, "retype");
    checkpoint([], ["correction"]);
    assert.equal(incremental.find(p => p.subject.traceIds.includes("generated"))?.observed?.parentAction, undefined);
    checkpoint([correction]);
    checkpoint([{ ...all[0], metadata: { ...all[0].metadata, responseOpportunityDecisionTarget: "Compare the two implementations." } }]);
    checkpoint([], ["ask"]);
    checkpoint([trace("ask", "shared")]);
    const target = incremental.find(p => p.subject.traceIds.includes("generated"))!;
    events = [createHumanGroundTruthEventV2({ eventId: "manual-truth", sessionId: "batch4", subject: target.subject,
      source: "explicit-ui", fact: { kind: "expected-question-type", expectedQuestionType: "field-knowledge" }, now: 120 })];
    checkpoint([all.find(item => item.id === "generated")!]);
    assert.ok(incremental.some(p => p.inputEventIds.includes("manual-truth")));
  });
}
