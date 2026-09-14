import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hookSource = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");

test("reuses observer snapshots and selects only affected evaluation attempts", () => {
  const refreshStart = hookSource.indexOf(
    "const refreshHumanEvaluationObservedProjectionForTrace"
  );
  const refreshEnd = hookSource.indexOf(
    "const refreshRecordedCompletedTrace",
    refreshStart
  );
  const refreshBlock = hookSource.slice(refreshStart, refreshEnd);
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);
  assert.match(
    refreshBlock,
    /trace: MeetingTrace,[\s\S]*traces: MeetingTrace\[\],[\s\S]*traceIndex\?: HumanEvaluationAttemptEvidenceIndexV2/
  );
  assert.match(
    refreshBlock,
    /materializeHumanEvaluationAttemptProjectionV2\(\{[\s\S]*?traces,/
  );
  assert.doesNotMatch(
    refreshBlock,
    /traceStoreRef\.current\.getTraces\(\)/
  );

  const subscriberStart = hookSource.indexOf(
    "const recordCompletedTracesForSession"
  );
  const subscriberEnd = hookSource.indexOf(
    "const maybeAutoExportTraces",
    subscriberStart
  );
  const subscriberBlock = hookSource.slice(subscriberStart, subscriberEnd);
  assert.match(
    subscriberBlock,
    /const traceIndex = buildHumanEvaluationAttemptEvidenceIndexV2\(traces\);/
  );
  assert.match(subscriberBlock, /selectAffectedEvaluationTraces/);
  assert.match(subscriberBlock, /for \(const trace of affected\)/);
  assert.match(
    subscriberBlock,
    /refreshHumanEvaluationObservedProjectionForTrace\([\s\S]*trace,[\s\S]*traces,[\s\S]*traceIndex[\s\S]*\)/
  );

  const lateRefreshStart = hookSource.indexOf(
    "const refreshRecordedCompletedTrace"
  );
  const lateRefreshEnd = hookSource.indexOf(
    "const transitionForceAdviseTarget",
    lateRefreshStart
  );
  const lateRefreshBlock = hookSource.slice(
    lateRefreshStart,
    lateRefreshEnd
  );
  assert.equal(
    lateRefreshBlock.match(/traceStoreRef\.current\.getObserverSnapshot\(\)/g)?.length,
    1
  );
  assert.match(
    lateRefreshBlock,
    /buildHumanEvaluationAttemptEvidenceIndexV2\(traces\)/
  );
  assert.match(
    lateRefreshBlock,
    /refreshHumanEvaluationObservedProjectionForTrace\(\s*completedTrace,\s*traces,\s*traceIndex\s*\)/
  );
});
