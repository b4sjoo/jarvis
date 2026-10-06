import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createHash } from "node:crypto";
import { assertRuntimeRegressionPreconditions, compareRuntimeRegressionExpected, readRuntimeRegressionScenario, readRuntimeRegressionScenarioManifest, readRuntimeRegressionSourceInput } from "../src/lib/meeting/runtime-regression-scenario.js";
import { loadRuntimeRegressionScenario, type RuntimeRegressionFileReader } from "../src/lib/meeting/runtime-regression-loader.js";
import type { SessionProcedureStepV1, SessionProcedureV1 } from "../src/lib/meeting/session-procedure.js";
import { classifyMeTurn } from "../src/lib/meeting/transcript-fusion.js";

const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const manifest = () => readRuntimeRegressionScenarioManifest({ schemaVersion: 1, id: "reviewed-case", revision: 1,
  procedure: { path: "procedure.json", sha256: sha("procedure"), mediaType: "application/json" }, assetRoot: "assets", allowAbsoluteAssets: false,
  review: { status: "reviewed", purpose: "regression", reviewedBy: "approved-deterministic-fixture", preconditions: { useMemory: false } } });
const step = (extra: Partial<SessionProcedureStepV1> = {}): SessionProcedureStepV1 => ({ id: "step-1", ordinal: 1, kind: "them-text", occurredAt: 1,
  delayAfterPreviousMs: 0, replaySupport: "ready", input: { text: "Design a service." }, reviewStatus: "ready", evidenceGaps: [],
  expected: { questionType: "general-system-design" }, expectedEvidenceRefs: [{ eventId: "explicit-review", factKind: "expected-task-settlement" }],
  provenance: { timelineEventId: "old-timeline", traceIds: ["OLD_TRACE"], sourceTurnIds: ["OLD_TURN"] }, ...extra });
const procedure = (steps = [step()]): SessionProcedureV1 => ({ schemaVersion: 1, id: "original", source: { recordingSessionId: "OLD_SESSION", folderName: "old-folder",
  sourceDigest: sha("original"), scriptedValidation: true, forcedScripted: false }, execution: { defaultBarrier: "typed-terminal" },
  generatedAt: 1, reviewStatus: "ready", evidenceGaps: [], steps });

test("SR187 source adapter emits only fresh user-expressible input, never old identity or Expected", () => {
  const value = step({ kind: "type-correction", input: { correctedType: "coding", correctionIntent: { kind: "retype-parent", parentId: "OLD_PARENT" } },
    expected: { expectedParentId: "OLD_PARENT", relation: "followup-parent" } });
  const original = JSON.stringify(value);
  assert.deepEqual(readRuntimeRegressionSourceInput(value), { kind: "type-correction", correctedType: "coding", correctionIntentKind: "retype-parent" });
  assert.equal(JSON.stringify(value), original);
  assert.doesNotMatch(JSON.stringify(readRuntimeRegressionScenario(manifest(), procedure([value])).inputs), /OLD_|expected|trace|provenance/);
});

test("SR187 preflight rejects unknown input, barrier, order, target leakage and unreviewed Expected", () => {
  for (const invalid of [
    { ...manifest(), review: { ...manifest().review, status: "draft" } },
    { ...manifest(), schemaVersion: 8 }, { ...manifest(), procedure: { path: "x", sha256: "missing" } },
  ]) assert.throws(() => readRuntimeRegressionScenarioManifest(invalid));
  for (const invalid of [
    procedure([step({ kind: "audio" as any })]), procedure([step({ ordinal: 4 })]),
    procedure([step({ reviewStatus: "needs-review" })]), procedure([step({ expected: undefined })]),
    procedure([step({ expectedEvidenceRefs: [] })]), procedure([step({ evidenceGaps: ["ambiguous-expected"] })]),
    { ...procedure(), execution: { defaultBarrier: "after-delay" } },
    procedure([step({ input: { text: "ask", targetStepId: "previous" } as any })]),
  ]) assert.throws(() => readRuntimeRegressionScenario(manifest(), invalid));
});

test("SR187 declared environment mismatch rejects without changing settings", () => {
  const actual = { useMemory: false, model: "current", snapshotId: null };
  assertRuntimeRegressionPreconditions({ useMemory: false }, actual);
  assert.throws(() => assertRuntimeRegressionPreconditions({ useMemory: true }, actual), /useMemory/);
  assert.throws(() => assertRuntimeRegressionPreconditions({ secret: "not-an-exposed-field" }, actual), /secret/);
  assert.deepEqual(actual, { useMemory: false, model: "current", snapshotId: null });
});

test("HR187 reviewed practice may omit labels; regression and conflicts do not silently pass", () => {
  const practice = { ...manifest(), review: { ...manifest().review, purpose: "practice" as const } };
  const unlabelled = procedure([step({ expected: undefined, expectedEvidenceRefs: [], reviewStatus: "needs-human-labels" })]);
  assert.equal(readRuntimeRegressionScenario(practice, unlabelled).inputs.length, 1);
  assert.throws(() => readRuntimeRegressionScenario(manifest(), unlabelled), /Expected/);
  assert.deepEqual(compareRuntimeRegressionExpected(undefined, undefined, new Map()), []);
});

test("Replay Me duration uses the original classifier without backdating or creating speech-start truth", () => {
  const turn = { id: "new-me", text: "Do you mean the cache capacity?", speaker: "me" as const, source: "microphone" as const,
    startedAt: 1000, endedAt: 1000, isFinal: true };
  const before = JSON.stringify(turn);
  assert.deepEqual(classifyMeTurn(turn, true, 25000), classifyMeTurn({ ...turn, endedAt: 26000 }, true));
  assert.notEqual(classifyMeTurn(turn, true).tier, classifyMeTurn(turn, true, 25000).tier);
  assert.equal(JSON.stringify(turn), before);
  assert.equal(Object.hasOwn(turn, "speechStartedAt"), false);
});

test("SR187 comparison uses common Observed phase, bijective comparison-only identities, no automatic answer-quality label", () => {
  const identities = new Map<string, string>();
  const observed = { traceId: "new", traceHash: "new-hash", settledParentId: "P1", settledBranchId: "C1", playbookPhase: "implementation_validation" as const };
  assert.deepEqual(compareRuntimeRegressionExpected({ expectedParentId: "OLD_P", expectedBranchId: "OLD_C", playbookPhase: "implementation_validation", answerOutcome: "useful" }, observed, identities).map(row => row.verdict), ["pass", "pass", "pass", "unevaluated"]);
  assert.equal(compareRuntimeRegressionExpected({ expectedParentId: "NEW_P" }, observed, identities)[0].verdict, "fail");
  assert.equal(compareRuntimeRegressionExpected({ expectedParentId: "OLD_P" }, { ...observed, settledParentId: "P2" }, identities)[0].verdict, "fail");
  assert.equal(compareRuntimeRegressionExpected({ playbookPhase: "implementation_validation" }, { ...observed, playbookPhase: undefined }, identities)[0].verdict, "unevaluated");
  assert.deepEqual(compareRuntimeRegressionExpected({ terminalDisposition: "committed-hidden", requestedArtifacts: ["answer", "code"], committedArtifacts: ["code"] }, observed, identities,
    { completion: { disposition: "committed-hidden", facts: [] }, requestedArtifacts: ["code", "answer"], committedArtifacts: ["code"] }).map(row => row.verdict), ["pass", "pass", "pass"]);
});

function fileHarness() {
  const files = new Map<string, { text?: string; base64?: string; mediaType: string }>();
  const capture = { id: "OLD_SCREEN", capturedAt: 1, preflight: { question: "OLD_ANSWER" }, captureTarget: {
    targetType: "active-window", x: 0, y: 0, width: 100, height: 50, captureTimingsMs: { totalMs: 10000 }, windowId: 999,
    cursor: { globalX: 10, globalY: 10, targetX: 10, targetY: 10, insideTarget: true },
  } };
  files.set("/case/assets/main.png", { base64: "main-bytes", mediaType: "image/png" });
  files.set("/case/assets/focus.png", { base64: "focus-bytes", mediaType: "image/png" });
  files.set("/case/assets/capture.json", { text: JSON.stringify(capture), mediaType: "application/json" });
  const ref = (name: string) => {
    const file = files.get(`/case/assets/${name}`)!;
    return { path: name, sha256: sha(file.text ?? file.base64!), mediaType: file.mediaType };
  };
  const data = procedure([step({
    kind: "screen-input", replaySupport: "capture-only",
    input: { screen: { image: ref("main.png"), focusImage: ref("focus.png"), metadata: ref("capture.json") } },
  })]);
  const text = JSON.stringify(data);
  files.set("/case/procedure.json", { text, mediaType: "application/json" });
  files.set("/case/scenario.json", { text: JSON.stringify({ ...manifest(), procedure: { path: "procedure.json", sha256: sha(text) } }), mediaType: "application/json" });
  const requests: unknown[] = [];
  const reader: RuntimeRegressionFileReader = {
    dirname: async value => path.dirname(value), resolve: async (...values) => path.resolve(...values),
    read: async input => {
      requests.push(input);
      const absolutePath = path.resolve(input.assetRoot, input.path);
      const file = files.get(absolutePath);
      if (!file) throw new Error("missing-file");
      return { ...file, absolutePath, sha256: sha(file.text ?? file.base64!) };
    },
  };
  return { files, requests, reader };
}

test("SR187 loader pairs images/metadata and strips old identity, semantics and capture timings", async () => {
  const h = fileHarness(); const before = JSON.stringify([...h.files]);
  const loaded = await loadRuntimeRegressionScenario("/case/scenario.json", h.reader);
  assert.equal(loaded.screenInputs.get("step-1")?.focusImageBase64, "focus-bytes");
  assert.equal(loaded.screenInputs.get("step-1")?.target?.cursor?.insideTarget, true);
  assert.doesNotMatch(JSON.stringify([...loaded.screenInputs]), /OLD_|windowId|captureTimingsMs|preflight/);
  assert.equal(JSON.stringify([...h.files]), before);
  assert.equal(h.requests.length, 5);
});

test("SR187 loader refuses missing, changed and mismatched declared assets before runtime dispatch", async () => {
  for (const mutate of [
    (h: ReturnType<typeof fileHarness>) => h.files.delete("/case/assets/focus.png"),
    (h: ReturnType<typeof fileHarness>) => { h.files.get("/case/assets/main.png")!.base64 = "changed"; },
    (h: ReturnType<typeof fileHarness>) => { h.files.get("/case/assets/main.png")!.mediaType = "image/jpeg"; },
  ]) {
    const h = fileHarness(); mutate(h);
    await assert.rejects(loadRuntimeRegressionScenario("/case/scenario.json", h.reader));
  }
});
