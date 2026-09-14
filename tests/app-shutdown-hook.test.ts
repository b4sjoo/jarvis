import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { CaptureLifecycleCoordinator } from "../src/lib/meeting/capture-lifecycle.js";
import { SessionRecordingManager } from "../src/lib/meeting/session-recording.js";
import { MeetingTraceStore, serializeMeetingTraceMetrics } from "../src/lib/meeting/trace.js";
import { selectAffectedEvaluationTraces } from "../src/lib/meeting/human-evaluation-attempt-projection.js";
import { authorizeNativeAudioLifecycleEvent, buildNativeAudioLifecycleTraceMetadata } from "../src/lib/meeting/native-audio-lifecycle.js";
import { assertShutdownQueueDrained, createNativeStopTerminalWait, createAcceptedTraceTerminalWait, stopShutdownEvaluationCapture } from "../src/lib/meeting/shutdown-drain.js";
import { ApplicationShutdownCoordinator, connectApplicationShutdownOwner, requestApplicationShutdown, type ShutdownTransport, type ApplicationShutdownOwner } from "../src/lib/app-shutdown.js";
import type { MeetingAssistantSettings, MeetingAudioStatus } from "../src/lib/meeting/types.js";

// Same AST/VM technique as session-recording-orchestration: execute the production Hook
// callbacks with real capture coordinator, trace store and 127 manager, stubbing only I/O/UI.
const source = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
const names = ["stop", "stopNativeMeetingCapture", "stopSessionRecording", "drainSystemAudioQueueForNativeStop",
  "readNativeCaptureLease",
  "abandonSessionRecording",
  "recordCompletedTracesForSession",
  "startCapture", "startRuntimeRegressionRun", "startSessionRecording", "captureScreenContext", "runAdvisor", "enqueueMicrophoneSpeech"];
const nodes = new Map<string, ts.Node>();
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "publishDisplay" && node.initializer && ts.isArrowFunction(node.initializer)) nodes.set("publishDisplay", node.initializer);
  if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(source))) {
    assert.ok(node.initializer && ts.isCallExpression(node.initializer));
    nodes.set(node.name.getText(source), node.initializer.arguments[0]!);
  }
  if (ts.isCallExpression(node)) {
    if (node.expression.getText(source) === "useApplicationShutdown") nodes.set("shutdownOwner", node.arguments[0]!);
    if (node.expression.getText(source) === "listen" && node.arguments[0]?.getText(source) === '"native-audio-lifecycle"') nodes.set("onLifecycle", node.arguments[1]!);
    if (node.expression.getText(source) === "traceStoreRef.current.subscribe") nodes.set("onTraces", node.arguments[0]!);
  }
  ts.forEachChild(node, visit);
}
visit(source);
const compiled = new Map([...nodes].map(([name, node]) => [name, ts.transpileModule(
  `globalThis.${name} = (${node.getText(source)});`,
  {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
    transformers: { before: [(context) => (root) => {
      const visitMeta: ts.Visitor = (child) => ts.isMetaProperty(child)
        ? context.factory.createIdentifier("importMeta") : ts.visitEachChild(child, visitMeta, context);
      return ts.visitNode(root, visitMeta) as ts.SourceFile;
    }] },
  },
).outputText]));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function settle() { for (let n = 0; n < 100; n++) await Promise.resolve(); }

async function harness(owner: "meeting" | "system" = "meeting") {
  const calls: string[] = [];
  const nativeCommands: Array<{ command: string; args: Record<string, unknown> }> = [];
  const files: Array<{ command: string; args: Record<string, any> }> = [];
  let failManifest = false;
  let failNative = false;
  let failMetrics = false;
  let failEvaluation = false;
  let evaluationLastError: string | undefined;
  const nativeReply = deferred();
  const nativeEntered = deferred();
  const queue = deferred();
  let status: MeetingAudioStatus = { active: owner === "meeting", systemCaptureActive: true,
    captureOwner: owner, captureSessionId: "capture-A", captureGeneration: 9,
    deviceId: null, sampleRate: 48000, vadEnabled: true, startedAtMs: 1 };
  let readStatus = async () => ({ ...status });
  const recording = new SessionRecordingManager(undefined, async <T>(command: string, args: Record<string, unknown> = {}) => {
    files.push({ command, args });
    if (args.relativePath === "manifest.json" && JSON.parse(String(args.payload)).status === "stopped") {
      calls.push("127-terminal");
      if (failManifest) throw new Error("injected manifest failure");
    }
    return `/recordings/${args.folderName}` as T;
  });
  await recording.start({
    meetingSessionId: "meeting-A",
    settings: { codingModel: { enabled: false, provider: "", variables: {} }, taxonomyAdjudication: { enabled: true, provider: "", variables: {} } } as unknown as MeetingAssistantSettings,
    providerSummary: { hasMainProvider: false, hasCodingProvider: false, hasTaxonomyAdjudicationProvider: false,
      hasSttProvider: false, mainSupportsImages: false, codingSupportsImages: false },
  });
  const globals: Record<string, any> = {};
  for (const node of nodes.values()) {
    const collect = (child: ts.Node) => {
      if (ts.isPropertyAccessExpression(child) && child.name.text === "current" && ts.isIdentifier(child.expression)) {
        globals[child.expression.text] ??= { current: null };
      }
      ts.forEachChild(child, collect);
    };
    collect(node);
  }
  const noop = () => undefined;
  for (const name of ["responseOpportunityRuntimeRef", "responseOpportunityGenerationGateRef", "meetingMetadataInferenceRuntimeRef",
    "questionTypeAdjudicationRuntimeRef", "taskRelationChildAffinityRuntimeRef", "taskRelationParentAffinityRuntimeRef",
    "taskRelationCanonicalShadowRuntimeRef", "answerResolutionRuntimeRef", "evidenceRequirementRuntimeRef",
    "sourceLinkageAdjudicationRuntimeRef", "whiteboardSyntaxRepairRuntimeRef"]) globals[name] = { current: { cancelAll: noop } };
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const traces = new MeetingTraceStore();
  let ui: any = { presentationArtifactResetRevision: 0, status: "listening" };
  Object.assign(globals, {
    console: { info: noop, warn: noop }, Date, Promise, Set, Map, Error, exports: {}, importMeta: { env: { DEV: false } },
    latestTraces: [], timer: undefined, previousObservationTracesRef: { current: [] }, selectAffectedEvaluationTraces,
    window: { setTimeout: (callback: () => void, delay: number) => {
      if (!delay) { void Promise.resolve().then(callback); return 0; }
      const id = ++timerId; timers.set(id, callback); return id;
    }, clearTimeout: (id: number) => timers.delete(id) },
    NATIVE_AUDIO_TAIL_DRAIN_QUEUE_TIMEOUT_MS: 3000,
    captureLifecycleCoordinatorRef: { current: new CaptureLifecycleCoordinator() },
    shutdownRequestedRef: { current: false }, nativeTerminalEvidenceRef: { current: {} },
    activeRef: { current: true }, runtimeActiveRef: { current: true },
    nativeCaptureSessionIdRef: { current: owner === "meeting" ? "capture-A" : null },
    nativeCaptureGenerationRef: { current: owner === "meeting" ? 9 : null },
    activeSttRequestsRef: { current: new Map() },
    systemAudioQueueTailRef: { current: queue.promise }, microphoneAudioQueueTailRef: { current: Promise.resolve() },
    systemAudioQueueTrackerRef: { current: { getDepth: () => 0 } },
    microphoneAudioQueueTrackerRef: { current: { getDepth: () => 0 } },
    traceStoreRef: { current: traces }, sessionRecordingManagerRef: { current: recording },
    sessionRecordedTraceIdsRef: { current: new Set() },
    contextManagerRef: { current: { getState: () => ({}), clearInterviewSessionContext: noop } },
    semanticTaxonomyRuntimeRef: { current: { releaseSession: noop } },
    traceMetricsPersistQueueRef: { current: Promise.resolve() },
    sttEvaluationCaptureManagerRef: { current: {
      drain: async () => { calls.push("eval-drain"); if (failEvaluation) throw new Error("evaluation failure"); },
      getState: () => ({ active: true, lastError: evaluationLastError }),
      stop: async () => { calls.push("eval-stop"); return { active: false, manifestFinalized: true }; },
    } },
    microphoneVad: { listening: true, pause: async () => { calls.push("mic-pause"); } },
    flushMemoryContextUsage: async () => ({ success: true }),
    clearPendingAnswerCommitTimer: noop, cancelActiveAdvisorJob: () => calls.push("advisor-cancelled"),
    cancelNativeAudioFaultTraces: noop, advanceRuntimeEpoch: noop,
    submitTaskRuntimeClear: noop, isScreenAnchoredSuggestion: () => false,
    toAnswerDeliveryPresentation: () => ({}), setScriptedValidation: noop,
    setState: (update: (previous: any) => any) => { ui = update(ui); },
    invalidateAudioProcessingSession: noop,
    openAudioDrainAuthorization: (_kind: string, operationId: string) => { globals.audioDrainAuthorizationRef.current = { operationId }; },
    sealAudioDrainAuthorizationForQueue: () => { calls.push("queue-sealed"); return {}; },
    revokeAudioDrainAuthorization: () => { globals.audioDrainAuthorizationRef.current = null; },
    recordCompletedTracesForSession: noop, refreshCriticalMomentCandidates: noop,
    buildHumanEvaluationAttemptEvidenceIndexV2: () => ({}), refreshHumanEvaluationObservedProjectionForTrace: noop,
    getAutoExportTrigger: () => "manual",
    scheduleTraceMetricsPersistence: noop, maybeAutoExportTraces: noop,
    serializeMeetingTraceMetrics, createNativeStopTerminalWait, createAcceptedTraceTerminalWait,
    assertShutdownQueueDrained, stopShutdownEvaluationCapture,
    authorizeNativeAudioLifecycleEvent, buildNativeAudioLifecycleTraceMetadata,
    invoke: async (command: string, args?: Record<string, unknown>) => {
      if (command === "get_meeting_audio_status") {
        calls.push(command);
        return readStatus();
      }
      if (command === "write_meeting_trace_metrics") {
        calls.push("metrics"); if (failMetrics) throw new Error("metrics failure"); return;
      }
      assert.ok(command === "stop_meeting_audio_session" || command === "stop_system_audio_capture", command);
      nativeCommands.push({ command, args: args ?? {} });
      calls.push(command); nativeEntered.resolve();
      if (failNative) throw new Error("native failure");
      await nativeReply.promise;
      if (args?.expectedCaptureSessionId !== status.captureSessionId
        || args?.expectedCaptureGeneration !== status.captureGeneration) {
        return { disposition: "stale-request", status: { ...status } };
      }
      status = { ...status, active: false, systemCaptureActive: false, captureOwner: null, captureSessionId: null, captureGeneration: null };
      return { disposition: "stopped", status };
    },
  });
  globals.setTimeout = globals.window.setTimeout;
  globals.clearTimeout = globals.window.clearTimeout;
  const sandbox = vm.createContext(globals);
  for (const code of compiled.values()) vm.runInContext(code, sandbox);
  traces.subscribe(globals.onTraces);
  const errors: unknown[] = [];
  let listener: (event: { payload: { generation: number; attempt: number } }) => void;
  let attempt = 1;
  let waiting = true;
  let requested = false;
  let exits = 0;
  const transport: ShutdownTransport = {
    listen: async (_name, callback) => { listener = callback as typeof listener; return noop; },
    invoke: async <T>(command: string, args?: Record<string, unknown>) => {
      if (command === "get_app_shutdown") return null as T;
      if (command === "exit_app") {
        if (!requested) { requested = true; listener({ payload: { generation: 1, attempt } }); }
        return undefined as T;
      }
      if (!waiting || args?.attempt !== attempt) return false as T;
      if (command === "report_app_shutdown") {
        if ((args.receipt as { result: string }).result === "failed-retryable") waiting = false;
        return true as T;
      }
      assert.equal(command, "complete_app_shutdown"); exits++; return undefined as T;
    },
  };
  const coordinator = new ApplicationShutdownCoordinator(globals.shutdownOwner as ApplicationShutdownOwner, transport);
  await connectApplicationShutdownOwner(coordinator, transport, (error) => errors.push(error));
  return {
    globals, calls, nativeCommands, files, recording, traces, nativeReply, nativeEntered, queue, errors,
    getStatus: () => ({ ...status }),
    setStatusRead: (read: typeof readStatus) => { readStatus = read; },
    replaceCapture: (captureSessionId: string | null, captureGeneration: number | null) => {
      status = { ...status, active: captureSessionId !== null, systemCaptureActive: captureSessionId !== null,
        captureOwner: captureSessionId ? owner : null, captureSessionId, captureGeneration };
      globals.nativeCaptureSessionIdRef.current = captureSessionId;
      globals.nativeCaptureGenerationRef.current = captureGeneration;
    },
    ui: () => ui,
    get exits() { return exits; },
    get waiting() { return waiting; },
    quit: () => requestApplicationShutdown(transport),
    settleAttempt: () => coordinator.accept({ generation: 1, attempt }),
    retry: async () => { attempt++; waiting = true; listener({ payload: { generation: 1, attempt } }); await settle(); },
    timeout: () => { waiting = false; },
    queueTimeout: () => { for (const callback of [...timers.values()]) callback(); },
    failure: (kind: "manifest" | "native" | "metrics" | "evaluation" | "evaluation-write", value: boolean) => {
      if (kind === "manifest") failManifest = value;
      if (kind === "native") failNative = value;
      if (kind === "metrics") failMetrics = value;
      if (kind === "evaluation") failEvaluation = value;
      if (kind === "evaluation-write") evaluationLastError = value ? "write failed" : undefined;
    },
    terminal: async (generation = 9) => {
      await globals.onLifecycle({ payload: {
        eventType: "stopped", owner, captureSessionId: "capture-A", captureGeneration: generation,
        occurredAtMs: Date.now(), expected: true, recoverability: "not-applicable", reason: "requested-stop",
        sampleRate: 48000, message: null,
        diagnostics: { droppedSamples: 0, consecutiveDrops: 0, bufferCapacity: null,
          nativeTailFlushDisposition: "timeout", nativeTailFlushOperationId: "native-existing-policy",
          nativeTailFlushRequestedAtMs: 1, nativeTailFlushAcknowledgedAtMs: 751,
          nativeTailFlushDurationMs: 750, nativeTailFlushCandidateDurationMs: 0 },
      } });
      await settle();
    },
  };
}

for (const owner of ["meeting", "system"] as const) {
  test(`Q2 actual Hook ${owner} lease: native reply < accepted terminal < queue/evaluation < 127 seal`, async () => {
    const h = await harness(owner);
    await h.quit(); await h.nativeEntered.promise;
    h.nativeReply.resolve(); await settle();
    assert.equal(h.calls.includes("queue-sealed"), false);
    assert.equal(h.calls.includes("127-terminal"), false);
    await h.terminal(8);
    assert.equal(h.calls.includes("queue-sealed"), false, "stale generation cannot unblock Stop");
    await h.terminal();
    assert.equal(h.calls.includes("queue-sealed"), true);
    assert.equal(h.calls.includes("127-terminal"), false);
    h.queue.resolve(); await settle();
    assert.equal(h.exits, 1);
    assert.equal(h.nativeCommands[0]?.args.expectedCaptureSessionId, "capture-A");
    assert.equal(h.nativeCommands[0]?.args.expectedCaptureGeneration, 9);
    assert.ok(h.calls.indexOf("eval-stop") < h.calls.indexOf("127-terminal"));
    assert.equal(h.recording.getState().lifecycle, "idle");
    const terminalIndex = h.files.findIndex((file) => file.args.relativePath === "timeline.jsonl" && String(file.args.payload).includes("nativeAudioEventType"));
    const manifestIndex = h.files.findIndex((file) => file.args.relativePath === "manifest.json" && JSON.parse(String(file.args.payload)).status === "stopped");
    assert.ok(terminalIndex >= 0 && terminalIndex < manifestIndex);
    assert.deepEqual(h.errors, []);
  });
}

test("Q1 actual ordinary in-flight Stop and Quit share the native Stop and lifecycle claim", async () => {
  const h = await harness();
  const ordinary = h.globals.stop();
  await h.nativeEntered.promise;
  const claimed = h.globals.captureLifecycleCoordinatorRef.current.getTraceMetadata().captureLifecycleOperationId;
  await h.quit(); await settle();
  assert.equal(h.globals.captureLifecycleCoordinatorRef.current.getTraceMetadata().captureLifecycleOperationId, claimed);
  h.nativeReply.resolve(); await settle();
  assert.equal(h.calls.includes("queue-sealed"), false);
  await h.terminal(8);
  assert.equal(h.calls.includes("queue-sealed"), false);
  await h.terminal(); h.queue.resolve();
  await ordinary; await settle();
  assert.equal(h.calls.filter((call) => call === "stop_meeting_audio_session").length, 1);
  assert.equal(h.calls.filter((call) => call === "127-terminal").length, 1);
  assert.equal(h.exits, 1);
  assert.equal(h.calls.includes("get_meeting_audio_status"), false);
});

test("normal Stop finishes without terminal delivery or a status query, ignoring an old waiter", async () => {
  const h = await harness();
  h.globals.nativeStopTerminalWaitRef.current = createNativeStopTerminalWait({
    owner: "system", captureSessionId: "unrelated-old-capture", captureGeneration: 3,
  });
  let completed = false;
  const normal = h.globals.stop().then(() => { completed = true; });
  await h.nativeEntered.promise;
  h.nativeReply.resolve(); h.queue.resolve(); await settle();
  assert.equal(completed, true, "normal Stop must not wait for the missing terminal event");
  await normal;
  assert.equal(h.calls.includes("get_meeting_audio_status"), false);
  assert.equal(h.nativeCommands[0]?.args.expectedCaptureSessionId, "capture-A");
  assert.equal(h.globals.nativeStopTerminalWaitRef.current, null);
});

test("normal Stop freezes A at invocation even if refs and native status become B while queued", async () => {
  const h = await harness();
  const queued = deferred();
  const coordinator = h.globals.captureLifecycleCoordinatorRef.current as CaptureLifecycleCoordinator;
  const preceding = coordinator.run(coordinator.claim("pause"), () => queued.promise);
  await settle();
  h.globals.screenAnalysisAbortRef.current = { abort: () => h.calls.push("screen-cancelled") };
  const normal = h.globals.stop();
  assert.equal(h.calls.includes("advisor-cancelled"), true, "Stop cancels Advisor before the capture queue becomes available");
  assert.equal(h.calls.includes("screen-cancelled"), true, "Stop cancels Screen before waiting on capture");
  h.replaceCapture("capture-B", 10);
  queued.resolve(); h.nativeReply.resolve(); h.queue.resolve();
  await preceding; await normal;
  assert.equal(h.calls.includes("get_meeting_audio_status"), false);
  assert.equal(h.nativeCommands.length, 1);
  assert.equal(h.nativeCommands[0]?.args.expectedCaptureSessionId, "capture-A");
  assert.equal(h.nativeCommands[0]?.args.expectedCaptureGeneration, 9);
  assert.equal(h.getStatus().captureSessionId, "capture-B");
  assert.equal(h.getStatus().active, true);
});

for (const reply of ["snapshot-A", "latest-B"] as const) {
  test(`Quit rechecks coordinator after delayed status (${reply}); superseded Stop cannot touch B`, async () => {
    const h = await harness();
    const readEntered = deferred();
    const readReply = deferred();
    const snapshot = h.getStatus();
    h.setStatusRead(async () => {
      readEntered.resolve(); await readReply.promise;
      return reply === "snapshot-A" ? snapshot : h.getStatus();
    });
    await h.quit(); await readEntered.promise;
    h.globals.captureLifecycleCoordinatorRef.current.claim("start");
    h.replaceCapture("capture-B", 10);
    readReply.resolve(); await settle();
    assert.equal(h.nativeCommands.length, 0);
    assert.equal(h.waiting, false);
    assert.equal(h.exits, 0);
    assert.equal(h.getStatus().captureSessionId, "capture-B");
    assert.equal(h.getStatus().active, true);
  });
}

test("stale status A still issues only exact A; native lease rejection preserves replacement B", async () => {
  const h = await harness();
  const readEntered = deferred();
  const readReply = deferred();
  const snapshot = h.getStatus();
  h.setStatusRead(async () => { readEntered.resolve(); await readReply.promise; return snapshot; });
  await h.quit(); await readEntered.promise;
  h.replaceCapture("capture-B", 10);
  readReply.resolve(); h.nativeReply.resolve(); await settle();
  assert.equal(h.nativeCommands.length, 1);
  assert.equal(h.nativeCommands[0]?.args.expectedCaptureSessionId, "capture-A");
  assert.equal(h.getStatus().captureSessionId, "capture-B");
  assert.equal(h.getStatus().active, true);
  assert.equal(h.waiting, false);
  assert.equal(h.exits, 0);
});

test("Quit joining during normal queue drain waits for exact A and then drains newly accepted work", async () => {
  const h = await harness();
  const normal = h.globals.stop();
  await h.nativeEntered.promise;
  h.nativeReply.resolve(); await settle();
  assert.equal(h.calls.includes("queue-sealed"), true);
  await h.quit(); await settle();
  h.queue.resolve(); await settle();
  assert.equal(h.exits, 0);
  assert.equal(h.calls.includes("127-terminal"), false);
  const acceptedTail = deferred();
  h.globals.systemAudioQueueTailRef.current = acceptedTail.promise;
  await h.terminal();
  assert.equal(h.exits, 0);
  acceptedTail.resolve(); await normal; await settle();
  assert.equal(h.exits, 1);
  assert.equal(h.nativeCommands.length, 1);
  assert.equal(h.calls.includes("get_meeting_audio_status"), false);
});

test("idle Quit does not await an unrelated previous native waiter", async () => {
  const h = await harness();
  h.replaceCapture(null, null);
  h.globals.nativeStopTerminalWaitRef.current = createNativeStopTerminalWait({
    owner: "meeting", captureSessionId: "old-unrelated", captureGeneration: 2,
  });
  h.queue.resolve(); await h.quit(); await h.settleAttempt();
  assert.equal(h.nativeCommands.length, 0);
  assert.equal(h.globals.nativeStopTerminalWaitRef.current, null);
  assert.equal(h.exits, 1);
});

test("Q4 timeout, Retry and late terminal continue same pending Hook Stop", async () => {
  const h = await harness();
  await h.quit(); await h.nativeEntered.promise;
  h.nativeReply.resolve(); await settle(); h.timeout();
  await h.retry(); await h.terminal(); h.queue.resolve(); await settle();
  assert.equal(h.calls.filter((call) => call === "stop_meeting_audio_session").length, 1);
  assert.equal(h.exits, 1);
});

for (const failure of ["manifest", "native", "metrics", "evaluation", "evaluation-write"] as const) {
  test(`Q3 real Hook ${failure} failure stays unresolved and Retry reuses recording owner`, async () => {
    const h = await harness();
    h.failure(failure, true);
    const identity = h.recording.getState();
    await h.quit(); await h.nativeEntered.promise;
    h.nativeReply.resolve(); await h.terminal(); h.queue.resolve(); await settle();
    assert.equal(h.exits, 0);
    assert.equal(h.waiting, false);
    if (failure === "manifest") {
      assert.equal(h.recording.getState().lifecycle, "close-failed");
      assert.equal(h.recording.getState().active, false);
    } else assert.equal(h.recording.getState().active, true);
    assert.equal(h.recording.getState().folderName, identity.folderName);
    h.failure(failure, false);
    await h.retry(); await settle();
    assert.equal(h.exits, 1);
    assert.ok(h.files.filter((file) => file.args.relativePath === "manifest.json")
      .every((file) => file.args.folderName === identity.folderName));
    if (failure !== "native") assert.equal(h.calls.filter((call) => call === "stop_meeting_audio_session").length, 1);
  });
}

test("Q3 actual queue timeout is failure, not success; retry does not issue another native Stop", async () => {
  const h = await harness();
  await h.quit(); await h.nativeEntered.promise;
  h.nativeReply.resolve(); await h.terminal();
  h.queueTimeout(); await settle();
  assert.equal(h.exits, 0);
  assert.equal(h.waiting, false);
  assert.equal(h.recording.getState().active, true);
  h.queue.resolve(); await h.retry(); await settle();
  assert.equal(h.calls.filter((call) => call === "stop_meeting_audio_session").length, 1);
  assert.equal(h.exits, 1);
});

test("Q2 accepted runtime trace must reach recorded terminal before sealing", async () => {
  const h = await harness();
  const trace = h.traces.startTrace("voice");
  await h.quit(); await h.nativeEntered.promise;
  h.nativeReply.resolve(); await h.terminal(); h.queue.resolve(); await settle();
  assert.equal(h.calls.includes("127-terminal"), false);
  h.traces.finishTrace(trace.id, "cancelled"); await settle();
  assert.equal(h.exits, 1);
  assert.ok(h.files.some((file) => file.args.relativePath === `traces/${trace.id}/summary.json`));
});

test("Q2 frozen Hook rejects actual capture, recording, Replay, screen, Advisor and microphone ingress", async () => {
  const h = await harness();
  await h.globals.shutdownOwner.freezeNewWork();
  const before = h.files.length;
  await h.globals.startCapture("fresh-start");
  await h.globals.startRuntimeRegressionRun();
  await h.globals.startSessionRecording();
  await h.globals.captureScreenContext();
  await h.globals.runAdvisor();
  h.globals.enqueueMicrophoneSpeech({}, 1, 2);
  assert.equal(h.files.length, before);
  assert.deepEqual(h.calls, ["advisor-cancelled", "mic-pause"]);
});

test("ordinary Stop retains its soft native/evaluation error contract outside Quit", async () => {
  const h = await harness();
  h.failure("native", true);
  h.failure("evaluation", true);
  h.queue.resolve();
  await h.globals.stop();
  assert.equal(h.globals.shutdownRequestedRef.current, false);
  assert.equal(h.recording.getState().lifecycle, "idle");
  assert.equal(h.exits, 0);
});

for (const pending of ["system-queue", "microphone-queue", "stt-request"] as const) {
  test(`Q3 actual Hook rejects nonempty ${pending} after the queue Promise resolves`, async () => {
    const h = await harness();
    let depth = 1;
    if (pending === "system-queue") h.globals.systemAudioQueueTrackerRef.current.getDepth = () => depth;
    if (pending === "microphone-queue") h.globals.microphoneAudioQueueTrackerRef.current.getDepth = () => depth;
    if (pending === "stt-request") h.globals.activeSttRequestsRef.current.set("pending", {});
    await h.quit(); await h.nativeEntered.promise;
    h.nativeReply.resolve(); await h.terminal(); h.queue.resolve(); await settle();
    assert.equal(h.waiting, false);
    assert.equal(h.exits, 0);
    assert.equal(h.calls.includes("127-terminal"), false);
    depth = 0; h.globals.activeSttRequestsRef.current.clear();
    await h.retry(); await settle();
    assert.equal(h.exits, 1);
    assert.equal(h.calls.filter((call) => call === "stop_meeting_audio_session").length, 1);
  });
}

for (const action of ["stopSessionRecording", "abandonSessionRecording"] as const) {
  for (const newerError of [false, true]) {
    test(`127 ${action} clears only its prior public banner (newer unrelated error=${newerError})`, async () => {
      const h = await harness();
      h.failure("manifest", true);
      await assert.rejects(h.globals.stopSessionRecording("test", { throwOnError: true }), /manifest failure/);
      assert.match(h.ui().error, /injected manifest failure/);
      assert.equal(h.ui().error, h.recording.getState().lastError);
      h.failure("manifest", false);
      const recovery = h.globals[action]("recovery", { throwOnError: true });
      if (newerError) h.globals.setState((previous: any) => ({ ...previous, error: "newer screen failure" }));
      await recovery;
      assert.equal(h.ui().error, newerError ? "newer screen failure" : null);
      assert.equal(h.recording.getState().lifecycle, "idle");
    });
  }
}
