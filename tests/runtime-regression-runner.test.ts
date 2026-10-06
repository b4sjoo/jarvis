import assert from "node:assert/strict";
import test from "node:test";
import { executeRuntimeRegressionScenario, type RuntimeRegressionScenarioReport, type RuntimeRegressionStepResult } from "../src/lib/meeting/runtime-regression-runner.js";
import { readRuntimeRegressionScenario, readRuntimeRegressionScenarioManifest } from "../src/lib/meeting/runtime-regression-scenario.js";

function scenario(purpose: "practice" | "regression" = "regression") {
  return readRuntimeRegressionScenario(readRuntimeRegressionScenarioManifest({ schemaVersion: 1, id: "approved", revision: 1,
    procedure: { path: "procedure.json", sha256: `sha256:${"a".repeat(64)}` }, assetRoot: ".", allowAbsoluteAssets: false,
    review: { status: "reviewed", purpose, reviewedBy: "approved-deterministic-fixture", preconditions: { useMemory: false } },
  }), { schemaVersion: 1, id: "source-procedure", source: { recordingSessionId: "old-recording", folderName: "old-folder", sourceDigest: "original-inputs", scriptedValidation: true, forcedScripted: false },
    execution: { defaultBarrier: "typed-terminal" }, reviewStatus: "ready", evidenceGaps: [], steps: [1, 2].map(ordinal => ({
    id: `step-${ordinal}`, ordinal, kind: "them-text", input: { text: `Question ${ordinal}` }, reviewStatus: "ready", evidenceGaps: [],
    expected: purpose === "regression" ? { questionType: "coding" } : undefined,
    expectedEvidenceRefs: purpose === "regression" ? [{ eventId: "review", factKind: "expected-task-settlement" }] : [],
  })) });
}
function result(stepId: string, type: "coding" | "unknown" = "coding"): RuntimeRegressionStepResult {
  return { scenarioRunId: "new-run", runtimeSessionId: "new-session", scenarioStepId: stepId, startedAt: 1, endedAt: 2,
    completion: { disposition: "visible", facts: [], traceId: `fresh-${stepId}` },
    observed: { traceId: `fresh-${stepId}`, traceHash: "fresh-hash", questionType: type } };
}
function harness(purpose: "practice" | "regression" = "regression") {
  const input = scenario(purpose), original = JSON.stringify(input);
  const controller = new AbortController();
  const calls: string[] = [], progress: RuntimeRegressionScenarioReport[] = [];
  let memory = false;
  let execute = async (_input: unknown, step: string) => result(step);
  const run = () => executeRuntimeRegressionScenario({ scenario: input, signal: controller.signal, environment: () => ({ useMemory: memory }),
    start: async () => { calls.push("start"); return { scenarioRunId: "new-run", runtimeSessionId: "new-session" }; },
    execute: async (value, step) => { assert.doesNotMatch(JSON.stringify(value), /expected|old-run|review/); calls.push(step); return execute(value, step); },
    stop: async () => { calls.push("stop"); }, progress: report => progress.push(report),
  });
  return { input, original, calls, progress, controller, run, setExecute: (next: typeof execute) => { execute = next; }, setMemory: (value: boolean) => { memory = value; } };
}

test("SR187 sequential loop cannot dispatch the next step before the first completes", async () => {
  const h = harness(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  h.setExecute(async (_value, step) => { if (step === "step-1") await gate; return result(step); });
  const running = h.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls, ["start", "step-1"]);
  release(); const report = await running;
  assert.equal(report.status, "passed");
  assert.deepEqual(h.calls, ["start", "step-1", "step-2", "stop"]);
  assert.equal(JSON.stringify(h.input), h.original);
  assert.equal(h.progress[0].steps.length, 0, "earlier progress snapshots retain their step count");
});

test("SR187 first mismatch or missing comparison evidence stops once without retries", async () => {
  for (const missing of [false, true]) {
    const h = harness(); h.setExecute(async (_value, step) => ({ ...result(step, "unknown"), ...(missing ? { observed: undefined } : {}) }));
    const report = await h.run();
    assert.equal(report.status, missing ? "unevaluated" : "failed");
    assert.deepEqual(h.calls, ["start", "step-1", "stop"]);
    assert.equal(report.firstDivergence?.stepId, "step-1");
  }
});

test("HR187 practice never turns missing Expected into a regression pass", async () => {
  const h = harness("practice"); const report = await h.run();
  assert.equal(report.status, "unevaluated"); assert.equal(report.steps.length, 2);
  assert.deepEqual(report.steps.map(step => step.assertions), [[], []]);
});

test("SR187 prerequisite failure starts no run/input and settings changing between steps stops the run", async () => {
  const initial = harness(); initial.setMemory(true);
  await assert.rejects(initial.run(), /prerequisite/); assert.deepEqual(initial.calls, []);
  const changed = harness(); changed.setExecute(async (_value, step) => { changed.setMemory(true); return result(step); });
  assert.equal((await changed.run()).status, "failed");
  assert.deepEqual(changed.calls, ["start", "step-1", "stop"]);
});

test("SR187 stop and foreign run results cannot cause a later dispatch or cross-run comparison", async () => {
  const stopped = harness(); stopped.controller.abort();
  await assert.rejects(stopped.run(), /stopped/); assert.deepEqual(stopped.calls, []);
  const active = harness(); active.setExecute(async (_value, step) => { active.controller.abort(); return result(step); });
  assert.equal((await active.run()).status, "stopped"); assert.deepEqual(active.calls, ["start", "step-1", "stop"]);
  const foreign = harness(); foreign.setExecute(async (_value, step) => ({ ...result(step), scenarioRunId: "OLD_RUN" }));
  assert.equal((await foreign.run()).status, "failed"); assert.deepEqual(foreign.calls, ["start", "step-1", "stop"]);
});
