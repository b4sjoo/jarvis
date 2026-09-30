import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runSemanticScheduling } from "./helpers/semantic-observation-hook.js";

const source = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
for (const embeddingStatus of ["success", "timeout", "error", "unavailable"]) {
  for (const parent of [false, true]) {
    test(`formal handles remain independent of ${embeddingStatus} observation; parent=${parent}`, async () => {
      const result = await runSemanticScheduling(source, { embeddingStatus, parent });
      const stages = result.events.map((event: any[]) => event[0]);
      assert.equal(stages.filter((stage: string) => stage === "type").length, 1);
      assert.equal(stages.filter((stage: string) => stage === "relation").length, 1);
      assert.ok(stages.indexOf("pin") < stages.indexOf("type"));
      assert.ok(stages.indexOf("type") < stages.indexOf("relation"));
      assert.ok(stages.indexOf("relation") < stages.indexOf("embed"));
      assert.equal(result.lateAuthorization.authorized, false);
      assert.ok(stages.includes("taxonomy"));
    });
  }
}
test("ineligible observation leaves formal inference running; stale observation cannot produce authority", async () => {
  const skipped = await runSemanticScheduling(source, { eligible: false });
  assert.equal(skipped.events.some((event: any[]) => event[0] === "embed"), false);
  assert.equal(skipped.events.filter((event: any[]) => event[0] === "type" || event[0] === "relation").length, 2);
  const stale = await runSemanticScheduling(source, { stale: true });
  assert.ok(stale.events.some((event: any[]) => event[0] === "finish" && event[3] === "cancelled"));
});
test("three actual callers use the formal scheduler and the observer returns no product handle", () => {
  assert.equal((source.match(/scheduleQuestionRuntime\(\{/g) ?? []).length, 3);
  assert.doesNotMatch(source, /scheduleSemanticTaxonomyShadow/);
  const observer = source.slice(source.indexOf("const prepareSemanticTaxonomyObservation"), source.indexOf("const scheduleQuestionRuntime"));
  assert.doesNotMatch(observer, /scheduleQuestionTypeAdjudication|scheduleTaskRelationAdjudication|RuntimeAdjudicationScheduleHandle/);
  const linkage = source.slice(source.indexOf("const scheduleSourceLinkageAdjudication"), source.indexOf("const scheduleWhiteboardSyntaxRepairShadow"));
  assert.doesNotMatch(linkage, /runtimeReleaseRequested|evaluationActive|debugModeRef|sessionRecordingManagerRef\.current\?\.getState/);
});
