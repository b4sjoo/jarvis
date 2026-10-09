import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { RawZeroInputEpisode } from "../src/lib/meeting/audio-input-liveness.js";
import { CaptureLifecycleCoordinator } from "../src/lib/meeting/capture-lifecycle.js";
import { getNativeAudioCaptureStartPolicy, pruneNativeAudioRecoveryAttempts, resolveNativeAudioCaptureStartFailure } from "../src/lib/meeting/native-audio-lifecycle.js";
import { assertEntryInLedger, assertPlantedOnlyInCause, createDiagnosticLogSpy, DIAGNOSTIC_LOG_SPY_FAILING_DELIVERIES, DIAGNOSTIC_LOG_SPY_LEVELS,
  PLANTED, type DiagnosticLogSpyDelivery } from "./helpers/diagnostic-log-spy.js";

const source = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
function productionCallback(name: string, env: Record<string, unknown>) {
  let callback: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      callback = (node.initializer as ts.CallExpression).arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(callback);
  return vm.runInNewContext(ts.transpileModule(`(${callback.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, env);
}

function harness() {
  const now = 100_000;
  const episode = new RawZeroInputEpisode();
  const event: any = { occurredAtMs: now, rawZeroDurationMs: 99_000,
    rawSignalChunkCount: 1, lastRawSignalObservedAtMs: 1_000,
    captureSessionId: "old", captureGeneration: 1 };
  episode.observe(event);
  const coordinator = new CaptureLifecycleCoordinator();
  const calls: string[] = [];
  const records: any[] = [];
  let screen: string | null = null;
  let value: any = { status: "listening", latestSuggestion: { content: "stable" },
    partialSuggestion: "partial", taskRuntime: { phase: "implementation" } };
  let permission: () => Promise<boolean> = async () => true;
  let nativeStart: () => Promise<any> = async () => ({ active: true, captureSessionId: "new", captureGeneration: 2 });
  const context = { sessionId: "session", taskRuntime: value.taskRuntime };
  const env: any = {
    Date: class extends Date { static now() { return now; } },
    shutdownRequestedRef: { current: false }, runtimeRegressionRunRef: { current: null },
    rawZeroInputEpisodeRef: { current: episode }, activeRef: { current: true },
    runtimeActiveRef: { current: true },
    latestNativeAudioLivenessRef: { current: { event, observedAtMs: now } },
    nativeCaptureSessionIdRef: { current: "old" }, nativeCaptureGenerationRef: { current: 1 },
    nativeRecoveryAttemptTimestampsRef: { current: [] },
    nativeAudioManualRecoveryRef: { current: null },
    lastNativeSegmentSequenceRef: { current: 0 }, lastNativeSpeechStartCandidateSequenceRef: { current: 0 },
    latestNativeSpeechStartRef: { current: null }, lastNativeAudioLivenessSequenceRef: { current: 1 },
    screenOperationCoordinatorRef: { current: { getActiveOperationId: () => screen } },
    captureLifecycleCoordinatorRef: { current: coordinator },
    NATIVE_AUDIO_RECOVERY_WINDOW_MS: 60_000, NATIVE_AUDIO_MAX_RECOVERY_ATTEMPTS_PER_WINDOW: 2,
    getNativeAudioCaptureStartPolicy, pruneNativeAudioRecoveryAttempts,
    reportRawZeroProbe: (stage: string, data: any) => records.push({ stage, ...data }),
    sessionRecordingManagerRef: { current: { recordCaptureLifecycle: (data: any) => records.push(data) } },
    setState: (update: (v: any) => any) => { value = update(value); },
    readNativeCaptureLease: () => ({ captureSessionId: "old", captureGeneration: 1 }),
    revokeAudioDrainAuthorization: () => calls.push("revoke-drain"),
    selectedAudioDevices: { output: { id: "default" } }, sttProvider: {},
    state: { settings: { audio: { config: {} }, useMemory: false } },
    invoke: async (command: string) => {
      calls.push(command);
      return command === "check_system_audio_access" ? permission() : nativeStart();
    },
    stopNativeMeetingCapture: async () => { calls.push("stop"); },
    cancelActiveAdvisorJob: () => { calls.push("cancel-advisor"); },
    invalidateAudioProcessingSession: () => calls.push("invalidate-audio"),
    startAudioProcessingSession: () => calls.push("start-audio"),
    prewarmSemanticTaxonomyRuntime: () => {},
    contextManagerRef: { current: { getState: () => context, getDisplayTranscriptTurns: () => [] } },
  };
  const attempt = { id: "probe", startedAt: now, previousCaptureSessionId: "old",
    previousCaptureGeneration: 1, reason: "raw-zero-input" };
  const run = () => productionCallback("startCapture", env)("automatic-recovery", attempt);
  return { env, episode, coordinator, calls, records, run, get value() { return value; },
    screen: (id: string | null) => { screen = id; },
    permission: (fn: typeof permission) => { permission = fn; },
    nativeStart: (fn: typeof nativeStart) => { nativeStart = fn; },
  };
}

test("production restart preserves runtime and stable output; native start does not claim restored signal", async () => {
  const h = harness();
  await h.run();
  assert.ok(h.calls.includes("stop"));
  assert.ok(h.calls.includes("start_meeting_audio_session"));
  assert.equal(h.calls.includes("cancel-advisor"), false);
  assert.equal(h.value.latestSuggestion.content, "stable");
  assert.equal(h.value.taskRuntime.phase, "implementation");
  assert.equal(h.value.partialSuggestion, "partial");
  assert.equal(h.env.runtimeActiveRef.current, true);
  assert.equal(h.episode.read(200_000, false).disposition, "probe-used");
  assert.ok(h.records.some((r) => r.stage === "native-restart-completed" && r.signalRestored === false));
  assert.equal(h.records.some((r) => r.stage === "automatic-recovery-succeeded"), false);
});

test("Screen admitted during the permission await defers before any native stop or budget consumption", async () => {
  const h = harness();
  h.permission(async () => { h.screen("screen-new"); h.episode.screenAdmitted(100_000); return true; });
  await h.run();
  assert.equal(h.calls.includes("stop"), false);
  assert.equal(h.env.nativeCaptureSessionIdRef.current, "old");
  assert.equal(h.env.nativeRecoveryAttemptTimestampsRef.current.length, 0);
  assert.equal(h.episode.read(200_000, false).probeUsed, false);
});

test("Pause supersedes queued probe without restarting or clearing its native lease", async () => {
  const h = harness();
  h.permission(async () => { h.coordinator.claim("pause"); h.env.activeRef.current = false; return true; });
  await h.run();
  assert.equal(h.calls.includes("stop"), false);
  assert.equal(h.calls.includes("start_meeting_audio_session"), false);
});

test("Screen admitted after restart began is not cancelled by recovery completion", async () => {
  const h = harness();
  h.nativeStart(async () => {
    h.screen("new-screen");
    h.env.setState((v: any) => ({ ...v, status: "analyzing-screen", partialSuggestion: "new Screen stream" }));
    return { active: true, captureSessionId: "new", captureGeneration: 2 };
  });
  await h.run();
  assert.equal(h.value.status, "analyzing-screen");
  assert.equal(h.value.partialSuggestion, "new Screen stream");
  assert.equal(h.calls.includes("cancel-advisor"), false);
});

test("old or delayed observations and exhausted shared rate budget do not restart", async () => {
  for (const alter of [
    (h: ReturnType<typeof harness>) => { h.env.nativeCaptureSessionIdRef.current = "replacement"; },
    (h: ReturnType<typeof harness>) => { h.env.latestNativeAudioLivenessRef.current.event.occurredAtMs = 1_000; },
    (h: ReturnType<typeof harness>) => { h.env.nativeRecoveryAttemptTimestampsRef.current = [90_000, 99_000]; },
    (h: ReturnType<typeof harness>) => { h.env.shutdownRequestedRef.current = true; },
  ]) {
    const h = harness(); alter(h); await h.run();
    assert.equal(h.calls.includes("stop"), false);
  }
});

// ---- Task 178 LG, commit 3 (LG7): the added entry of a capture start that failed, at its catch ----
//
// A capture start that failed printed nothing: it reached the panel and an active recording. The branch that handles
// a failure whose operation is still current now makes one error entry, with the bounded summary of the native
// command's error as its cause (decisions A8). Driven through the real startCapture: the native start of an automatic
// recovery rejects with a text that names a device. (The other branch of the same entry, a start blocked by a missing
// speech-to-text provider, is driven in tests/local-model-retirement.test.ts.)
const NATIVE_START_ERROR = `${PLANTED.deviceLabel}: the output device is no longer available`;
test("LG7 capture start failure: one error entry on the authorized failure branch, with typed fields and its cause; a superseded failure logs nothing; the recording, the state and the native calls are as before at every level and with a failing log delivery", async () => {
  const failed = async (level: (typeof DIAGNOSTIC_LOG_SPY_LEVELS)[number], delivery?: DiagnosticLogSpyDelivery, superseded = false) => {
    const h = harness();
    const spy = createDiagnosticLogSpy({ threshold: level, now: () => 100_000, delivery });
    h.env.logDiagnostic = spy.logDiagnostic;
    h.env.diagnosticLogCause = spy.logger.diagnosticLogCause;
    h.env.resolveNativeAudioCaptureStartFailure = resolveNativeAudioCaptureStartFailure;
    // The rejection is an Error of this realm, so the callback reads its message as it does in the app.
    h.env.Error = Error;
    h.nativeStart(async () => {
      // Superseded: a Pause claims the lifecycle while the native start is under way.
      if (superseded) h.coordinator.claim("pause");
      throw new Error(NATIVE_START_ERROR);
    });
    await h.run();
    return { entries: spy.entries(), observed: { calls: [...h.calls], records: JSON.parse(JSON.stringify(h.records)), value: JSON.parse(JSON.stringify(h.value)),
      refs: [h.env.activeRef.current, h.env.runtimeActiveRef.current, h.env.nativeCaptureSessionIdRef.current] } };
  };
  const reference = await failed("trace");
  assert.deepEqual(reference.entries.map((entry) => [entry.level, `${entry.source} ${entry.event}`, entry.refs ?? {}, entry.data]), [
    ["error", "meeting.capture start-failed", {}, { mode: "automatic-recovery", captureOperationId: 1, nativeStartAttempted: true,
      automaticRecovery: true, manualRecovery: false, silentSourceProbe: true, cause: `Error: ${NATIVE_START_ERROR}` }]]);
  for (const entry of reference.entries) assertEntryInLedger(entry);
  // LG4 and A8: the failure text is in the recording and the panel state, as before. The entry has its bounded summary
  // as the cause, and the device it names is in no other part of the entry. This branch names no block.
  assertPlantedOnlyInCause(reference.entries, "capture start failure");
  assert.equal("blocked" in reference.entries[0]!.data!, false);
  assert.ok(reference.observed.records.some((record: any) => record.stage === "automatic-recovery-failed" && String(record.error).includes(PLANTED.deviceLabel)));
  assert.ok(reference.observed.records.some((record: any) => record.stage === "capture-start-failure-reconciled"));
  assert.equal(reference.observed.value.error, NATIVE_START_ERROR);
  // LG2 and LG5: the same recording writes, state and native calls at every level and with every failing delivery.
  for (const level of DIAGNOSTIC_LOG_SPY_LEVELS) {
    const current = await failed(level);
    assert.deepEqual(current.observed, reference.observed, level);
    assert.equal(current.entries.length, 1, `${level}: an error entry passes every level`);
  }
  for (const delivery of DIAGNOSTIC_LOG_SPY_FAILING_DELIVERIES) {
    const current = await failed("trace", delivery);
    assert.deepEqual(current.observed, reference.observed, delivery);
    assert.deepEqual(current.entries, reference.entries, delivery);
  }
  // A failure that arrives after another operation claimed the lifecycle is not this start's to report: no entry, and
  // the stale error goes to the recording alone, as before.
  const stale = await failed("trace", undefined, true);
  assert.deepEqual(stale.entries, []);
  assert.ok(stale.observed.records.some((record: any) => record.stage === "stale-native-start-error"));
  assert.equal(stale.observed.records.some((record: any) => record.stage === "capture-start-failure-reconciled"), false);
  // The same before the native start was attempted: the permission check rejects after a Pause claimed the lifecycle.
  // Nothing is logged, recorded or shown for a start that is no longer the current operation.
  const early = harness();
  const spy = createDiagnosticLogSpy({ threshold: "trace" });
  early.env.logDiagnostic = spy.logDiagnostic;
  early.env.diagnosticLogCause = spy.logger.diagnosticLogCause;
  early.env.resolveNativeAudioCaptureStartFailure = resolveNativeAudioCaptureStartFailure;
  early.permission(async () => { early.coordinator.claim("pause"); throw new Error(NATIVE_START_ERROR); });
  await early.run();
  assert.deepEqual([spy.entries(), early.records, early.calls], [[], [], ["check_system_audio_access"]]);
});
