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
import { createRuntimeCriticalEventHarness, RUNTIME_CRITICAL_EVENT_HOOK_CALLBACKS } from "./helpers/runtime-critical-events.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import { createMeetingId } from "../src/lib/meeting/meeting-id.js";
import { assertEntryInLedger, createDiagnosticLogSpy, DIAGNOSTIC_LOG_SPY_FAILING_DELIVERIES, DIAGNOSTIC_LOG_SPY_LEVELS,
  type DiagnosticLogSpyDelivery } from "./helpers/diagnostic-log-spy.js";

// Same AST/VM technique as session-recording-orchestration: execute the production Hook
// callbacks with real capture coordinator, trace store and 127 manager, stubbing only I/O/UI.
const source = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
const names = ["stop", "stopNativeMeetingCapture", "stopSessionRecording", "drainSystemAudioQueueForNativeStop",
  "readNativeCaptureLease",
  "readArtifactReuseInputs",
  "abandonSessionRecording",
  "recordCompletedTracesForSession",
  "startCapture", "startRuntimeRegressionRun", "startSessionRecording", "captureScreenContext", "runAdvisor", "enqueueMicrophoneSpeech",
  // Task 178A: the real Hook emit callbacks run in this environment too.
  ...RUNTIME_CRITICAL_EVENT_HOOK_CALLBACKS];
const nodes = new Map<string, ts.Node>();
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "publishDisplay" && node.initializer && ts.isArrowFunction(node.initializer)) nodes.set("publishDisplay", node.initializer);
  if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(source))) {
    assert.ok(node.initializer && ts.isCallExpression(node.initializer));
    nodes.set(node.name.getText(source), node.initializer.arguments[0]!);
  }
  // Task 178A: the anonymous unmount effect and the Stop clear's real adapter.
  if (ts.isArrowFunction(node) && ts.isCallExpression(node.parent) && node.parent.expression.getText(source) === "useEffect" &&
    node.body.getText(source).includes("stopOnUnmountRef.current()")) nodes.set("unmountEffect", node);
  if (ts.isFunctionDeclaration(node) && node.name?.text === "submitTaskRuntimeClear") nodes.set("realSubmitTaskRuntimeClear", node);
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
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); }

// Task 178 LG: the Stop callback and the lifecycle listener log through `logDiagnostic`. The harness hands them the
// real logger with its delivery boundary controlled (see the helper), at the level and delivery a test asks for.
async function harness(owner: "meeting" | "system" = "meeting",
  log: { level?: (typeof DIAGNOSTIC_LOG_SPY_LEVELS)[number]; delivery?: DiagnosticLogSpyDelivery } = {}) {
  const diagnosticLog = createDiagnosticLogSpy({ threshold: log.level ?? "trace", delivery: log.delivery });
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
  // Task 178A: the real stream, bound to this harness's runtime session.
  const criticalEvents = createRuntimeCriticalEventHarness({ sessionId: "meeting-A" });
  Object.assign(globals, criticalEvents.hookRefs);
  // What application shutdown cancels, in order: [runtime ref, reason].
  const runtimeCancels: Array<[string, unknown]> = [];
  for (const name of ["responseOpportunityRuntimeRef", "responseOpportunityGenerationGateRef", "meetingMetadataInferenceRuntimeRef",
    "questionTypeAdjudicationRuntimeRef", "taskRelationChildAffinityRuntimeRef", "taskRelationParentAffinityRuntimeRef",
    "taskRelationCanonicalShadowRuntimeRef", "taskRelationChildAffinityObservationRuntimeRef",
    "taskRelationParentAffinityObservationRuntimeRef", "taskRelationCanonicalShadowObservationRuntimeRef",
    "answerResolutionRuntimeRef", "evidenceRequirementRuntimeRef",
    "sourceLinkageAdjudicationRuntimeRef", "whiteboardSyntaxRepairRuntimeRef"]) {
    globals[name] = { current: { cancelAll: (reason: unknown) => { runtimeCancels.push([name, reason]); } } };
  }
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const traces = new MeetingTraceStore();
  const disposeMicrophone = async () => { calls.push("mic-dispose"); };
  let ui: any = { presentationArtifactResetRevision: 0, status: "listening" };
  Object.assign(globals, {
    console: { info: noop, warn: noop }, logDiagnostic: diagnosticLog.logDiagnostic, diagnosticLogCause: diagnosticLog.logger.diagnosticLogCause,
    Date, Promise, Set, Map, Error, structuredClone, exports: {}, importMeta: { env: { DEV: false } },
    artifactReuseSettingsRef: { current: { useMemory: false } },
    manualCorrectionRevisionRef: { current: 0 },
    preparationRuntimeContextRef: { current: { preparationContextRevision: 0 } },
    latestTraces: [], timer: undefined, previousObservationTracesRef: { current: [] }, selectAffectedEvaluationTraces,
    interviewPreparationConversationExecutionService: { cancelAndWait: async () => {} },
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
    contextManagerRef: { current: { getState: () => ({ sessionId: "meeting-A", transcriptTurns: [], screenObservations: [] }), clearInterviewSessionContext: noop } },
    semanticTaxonomyRuntimeRef: { current: { releaseSession: noop } },
    traceMetricsPersistQueueRef: { current: Promise.resolve() },
    sttEvaluationCaptureManagerRef: { current: {
      drain: async () => { calls.push("eval-drain"); if (failEvaluation) throw new Error("evaluation failure"); },
      getState: () => ({ active: true, lastError: evaluationLastError }),
      stop: async () => { calls.push("eval-stop"); return { active: false, manifestFinalized: true }; },
    } },
    microphoneVad: { listening: true, dispose: disposeMicrophone },
    microphoneVadDisposeRef: { current: disposeMicrophone },
    microphoneSpeakingRef: { current: true },
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
    globals, calls, nativeCommands, files, recording, traces, nativeReply, nativeEntered, queue, errors, runtimeCancels, criticalEvents, diagnosticLog,
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
    assert.ok(h.calls.indexOf("mic-dispose") >= 0);
    assert.ok(h.calls.indexOf("mic-dispose") < h.calls.indexOf(h.nativeCommands[0].command));
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

test("PC6 application shutdown disposes the observation Relation runtimes together with the formal ones", async () => {
  const h = await harness();
  await h.quit(); await h.nativeEntered.promise;
  const relation = h.runtimeCancels.filter(([name]) => name.startsWith("taskRelation"));
  assert.deepEqual(relation, [
    ["taskRelationChildAffinityRuntimeRef", "disposed"],
    ["taskRelationParentAffinityRuntimeRef", "disposed"],
    ["taskRelationCanonicalShadowRuntimeRef", "disposed"],
    ["taskRelationChildAffinityObservationRuntimeRef", "disposed"],
    ["taskRelationParentAffinityObservationRuntimeRef", "disposed"],
    ["taskRelationCanonicalShadowObservationRuntimeRef", "disposed"],
  ]);
  h.nativeReply.resolve(); await settle();
  await h.terminal(); h.queue.resolve(); await settle();
  assert.equal(h.exits, 1);
  assert.deepEqual(h.errors, []);
});

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
  assert.equal(h.calls.includes("mic-dispose"), true, "Stop releases the browser microphone before waiting on capture");
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
  assert.deepEqual(h.calls, ["advisor-cancelled", "mic-dispose"]);
});

test("Q2 actual shutdown freeze awaits microphone disposal even while not listening", async () => {
  const h = await harness();
  const released = deferred();
  let settled = false;
  h.globals.microphoneVad.listening = false;
  h.globals.microphoneVad.loading = true;
  h.globals.microphoneVad.dispose = async () => {
    h.calls.push("mic-dispose-pending");
    await released.promise;
  };
  const freeze = h.globals.shutdownOwner.freezeNewWork().then((result: string) => {
    settled = true;
    return result;
  });
  try {
    await settle();
    assert.equal(h.globals.shutdownRequestedRef.current, true);
    assert.equal(h.calls.includes("mic-dispose-pending"), true);
    assert.equal(settled, false, "freeze cannot settle before pending microphone disposal");
    assert.equal(h.nativeCommands.length, 0);
  } finally { released.resolve(); }
  assert.equal(await freeze, "settled");
  assert.equal(h.globals.microphoneSpeakingRef.current, false);
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

// ---- Task 178 LG, commit 3 (LG7, LG1, LG2, LG5): Stop's two migrated call sites, through the real Stop ----
//
// The native stop that fails and the evaluation capture stop that fails each printed a console warning. Each is now
// one warn entry, on the branch where Stop goes on and on the branch where Quit hands the error on, with the bounded
// summary of the caught error as its cause (decisions A8: both errors come from native commands). What Stop does
// is compared as this harness observes it: its calls in order, the recording files it wrote, the recording's
// lifecycle, the panel state and whether the application exited.
test("LG7 Stop: a failed native stop and a failed evaluation capture stop are one warn entry each, with its cause, on a normal Stop and under Quit; at every level and with a failing log delivery Stop does what it did", async () => {
  type Log = Parameters<typeof harness>[1];
  const observed = (h: Awaited<ReturnType<typeof harness>>) => ({ calls: [...h.calls], files: h.files.map((file) => [file.command, file.args.relativePath ?? null]),
    lifecycle: h.recording.getState().lifecycle, recordingActive: h.recording.getState().active, shutdownRequested: h.globals.shutdownRequestedRef.current,
    exits: h.exits, waiting: h.waiting, status: h.ui().status, errors: h.errors.length });
  const stops = (h: Awaited<ReturnType<typeof harness>>) => {
    const entries = h.diagnosticLog.entries();
    for (const entry of entries) assertEntryInLedger(entry);
    // The text of each failure is in the cause of its own entry and in no other part of any entry.
    assert.equal(/native failure|evaluation failure/.test(JSON.stringify(entries.map((entry) => ({ ...entry, data: { ...entry.data, cause: undefined } })))), false);
    return entries.filter((entry) => entry.event === "stop-native-failed" || entry.event === "meeting-stop-failed")
      .map((entry) => [entry.level, `${entry.source} ${entry.event}`, entry.refs ?? {}, entry.data]);
  };
  const SCENARIOS = {
    // A normal Stop: both stops fail and Stop goes on to its end.
    "normal Stop": { run: async (log: Log) => {
      const h = await harness("meeting", log);
      h.failure("native", true); h.failure("evaluation", true); h.queue.resolve();
      await h.globals.stop();
      return h;
    }, entries: [["warn", "meeting.capture stop-native-failed", {}, { captureOperationId: 1, shutdownRequested: false, cause: "Error: native failure" }],
      ["warn", "meeting.stt-evaluation-capture meeting-stop-failed", {}, { captureOperationId: 1, shutdownRequested: false, cause: "Error: evaluation failure" }]] },
    // Quit: the native stop fails and the error is handed on; the attempt stays unresolved.
    "Quit, native stop": { run: async (log: Log) => {
      const h = await harness("meeting", log);
      h.failure("native", true);
      await h.quit(); await h.nativeEntered.promise;
      h.nativeReply.resolve(); await h.terminal(); h.queue.resolve(); await settle();
      return h;
    }, entries: [["warn", "meeting.capture stop-native-failed", {}, { captureOperationId: 1, shutdownRequested: true, cause: "Error: native failure" }]] },
    // Quit: the evaluation capture cannot be stopped; the attempt stays unresolved.
    "Quit, evaluation capture": { run: async (log: Log) => {
      const h = await harness("meeting", log);
      h.failure("evaluation", true);
      await h.quit(); await h.nativeEntered.promise;
      h.nativeReply.resolve(); await h.terminal(); h.queue.resolve(); await settle();
      return h;
    }, entries: [["warn", "meeting.stt-evaluation-capture meeting-stop-failed", {}, { captureOperationId: 1, shutdownRequested: true, cause: "Error: evaluation failure" }]] },
  };
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    const reference = await scenario.run({ level: "trace" });
    assert.deepEqual(stops(reference), scenario.entries, name);
    const expected = observed(reference);
    if (name === "normal Stop") assert.deepEqual([expected.lifecycle, expected.shutdownRequested, expected.exits], ["idle", false, 0], name);
    else assert.deepEqual([expected.recordingActive, expected.exits, expected.waiting], [true, 0, false], `${name}: the attempt failed and can be retried`);
    for (const level of DIAGNOSTIC_LOG_SPY_LEVELS) {
      const current = await scenario.run({ level });
      assert.deepEqual(observed(current), expected, `${name} at ${level}`);
      // A warn entry passes every level but error.
      assert.deepEqual(stops(current), level === "error" ? [] : scenario.entries, `${name} at ${level}`);
    }
    for (const delivery of DIAGNOSTIC_LOG_SPY_FAILING_DELIVERIES) {
      const current = await scenario.run({ level: "trace", delivery });
      assert.deepEqual(observed(current), expected, `${name} with a log delivery that fails (${delivery})`);
      assert.deepEqual(stops(current), scenario.entries, `${name}: the same entries were handed over (${delivery})`);
    }
  }
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

// ===========================================================================
// Task 178A (AE5): the stream's lifecycle at the Hook's real Stop and at the
// real unmount cleanup. The producer is the Stop clear itself, through the
// real adapter and the real sole task writer.
// ===========================================================================

function withRealStopClear(h: Awaited<ReturnType<typeof harness>>) {
  const manager = new MeetingContextManager();
  manager.reset({ sessionId: "meeting-A" });
  const seeded = manager.commitTaskRuntimeTransition({
    id: "seed-parent", transition: "create-parent", reason: "fixture",
    parent: { id: "parent-a", source: "voice", stableKind: "coding", topic: "Explain the queue invariant",
      playbookPhase: "baseline_reasoning", phaseProgress: {}, supportedFactAnchors: [], revisions: 1,
      createdAt: 1000, updatedAt: 1000 } as never,
    deadlineDelta: { parent: { ownerId: "parent-a", deadline: Date.now() + 600_000 } },
  });
  assert.equal(seeded.mutationApplied, true);
  h.globals.contextManagerRef.current = manager;
  h.globals.createMeetingId = createMeetingId;
  h.globals.submitTaskRuntimeClear = h.globals.realSubmitTaskRuntimeClear;
  return manager;
}

const JOURNAL_PATH = "runtime-events/critical-events.v1.jsonl";
const savedEvents = (h: Awaited<ReturnType<typeof harness>>) =>
  h.files.filter((file) => file.args.relativePath === JOURNAL_PATH).map((file) => JSON.parse(String(file.args.payload)));
function seedParent(manager: MeetingContextManager, id: string) {
  assert.equal(manager.commitTaskRuntimeTransition({
    id: `seed-${id}`, transition: "create-parent", reason: "fixture",
    parent: { id, source: "voice", stableKind: "coding", topic: "Later", playbookPhase: "baseline_reasoning",
      phaseProgress: {}, supportedFactAnchors: [], revisions: 1, createdAt: 2000, updatedAt: 2000 } as never,
  }).mutationApplied, true);
}

test("AE5 real Stop: the stopped run's observer receives the Stop clear and one closed marker and nothing later; the session id is unchanged, so its later idle facts are still produced and a new observer receives them", async () => {
  const h = await harness();
  const manager = withRealStopClear(h);
  const stream = h.criticalEvents.stream;
  const normal = h.globals.stop();
  await h.nativeEntered.promise;
  assert.equal(stream.getStats().subscribers, 1, "Stop has not reached its reset yet");
  h.nativeReply.resolve(); h.queue.resolve(); await settle();
  await normal;
  assert.equal(manager.getTaskRuntimeState().parent, undefined, "the real writer cleared the task");
  const stopped = stream.getStats();
  assert.equal(stopped.accepting, true, "the runtime session did not end with Stop");
  assert.equal(stopped.boundSessionId, "meeting-A", "Stop does not change the runtime session");
  h.criticalEvents.flush();
  assert.deepEqual(h.criticalEvents.deliveries.map((delivery) => delivery.kind), ["event", "closed"]);
  const [cleared, closed] = h.criticalEvents.deliveries;
  assert.ok(cleared?.kind === "event");
  assert.deepEqual([cleared.event.fact, cleared.event.refs.transition, cleared.event.refs.taskRuntimeRevision],
    ["lifecycle-committed", "clear-all", manager.getTaskRuntimeState().revision]);
  assert.equal(cleared.event.refs.receiptId, manager.getTaskRuntimeState().lastMutation?.id);
  assert.equal(cleared.event.runtimeSessionId, "meeting-A");
  assert.deepEqual(closed, { kind: "closed", schemaVersion: 1, runtimeSessionId: "meeting-A",
    reason: "meeting-assistant-stopped", lastSequence: 1, discarded: 0 });
  assert.equal(stream.getStats().subscribers, 0, "the stopped run's observer was released");
  // The Stop clear was recorded by the recording that Stop then sealed.
  assert.deepEqual(savedEvents(h).map((event) => event.eventId), [cleared.event.eventId]);

  // The same session keeps running idle after Stop (a Screen capture, a manual
  // action). A new observer can subscribe, and the idle fact is produced with
  // the session's next sequence. The stopped run's observer sees none of it.
  const later: unknown[] = [];
  const subscription = stream.subscribe((delivery) => { later.push(delivery); });
  assert.deepEqual([subscription.accepted, subscription.runtimeSessionId], [true, "meeting-A"]);
  seedParent(manager, "parent-b");
  const late = h.globals.submitTaskRuntimeClear(manager, { scope: "all", reason: "active-task-cleared" },
    h.globals.observeTaskRuntimeWriter({ runtimeSessionId: "meeting-A" }));
  assert.equal(late.mutationApplied, true);
  h.criticalEvents.flush();
  const after = stream.getStats();
  assert.deepEqual([after.lateAfterClose, after.lastSequence, after.produced], [0, 2, 2]);
  assert.equal(h.criticalEvents.deliveries.length, 2, "nothing reaches the stopped run's observer after its closed marker");
  assert.deepEqual(later.map((delivery: any) => [delivery.kind, delivery.event?.sequence, delivery.event?.refs.transition]),
    [["event", 2, "clear-all"]]);
  // Recording was sealed by Stop: the idle fact is in memory only, and says so.
  assert.equal(after.recording["not-recording"], 1);
  assert.equal(savedEvents(h).length, 1);
});

test("AE6 a fact produced after Stop ended the subscriptions and before the recording sealed is saved by the generation Stop is closing, with the session's next sequence", async () => {
  const h = await harness();
  const manager = withRealStopClear(h);
  const stream = h.criticalEvents.stream;
  // Stop's first await after it ended the subscriptions is held open.
  const reached = deferred();
  const release = deferred();
  h.globals.flushMemoryContextUsage = async () => { reached.resolve(); await release.promise; return { success: true }; };
  const normal = h.globals.stop();
  await h.nativeEntered.promise;
  h.nativeReply.resolve(); h.queue.resolve();
  await reached.promise;
  // The subscriptions of the stopped run have ended; the recording is still open.
  assert.equal(h.recording.getState().active, true);
  // The terminal of work that Stop cancelled arrives now: a real writer result
  // through the real adapter and the Hook's own observer.
  seedParent(manager, "parent-late");
  const rejected = h.globals.submitTaskRuntimeClear(manager,
    { scope: "all", reason: "late-terminal-of-stopped-work", expectedRevision: manager.getTaskRuntimeState().revision - 1 },
    h.globals.observeTaskRuntimeWriter({ runtimeSessionId: "meeting-A", traceId: "trace-of-stopped-work" }));
  assert.equal(rejected.authorized, false, "the writer's own rejection");
  assert.equal(stream.getStats().recording.accepted, 2, "the closing recording took the Stop clear and the late terminal");
  release.resolve();
  await normal;
  h.criticalEvents.flush();
  assert.deepEqual(h.criticalEvents.deliveries.map((delivery) => delivery.kind), ["event", "closed"],
    "the stopped run's observer ended at its closed marker");
  const saved = savedEvents(h);
  assert.deepEqual(saved.map((event) => [event.sequence, event.fact, event.terminal?.object, event.terminal?.disposition]), [
    [1, "lifecycle-committed", undefined, undefined],
    [2, "terminal", "lifecycle-transition", "rejected"],
  ]);
  assert.equal(new Set(saved.map((event) => event.recordingGenerationId)).size, 1, "one generation, the one Stop closed");
  const manifest = JSON.parse(String(h.files.filter((file) => file.args.relativePath === "manifest.json").at(-1)!.args.payload));
  assert.equal(manifest.status, "stopped");
  assert.equal(manifest.recordingIntegrity.status, "complete");
  assert.equal(saved[0].recordingGenerationId, manifest.recordingLifecycle.generationId);
  assert.deepEqual([stream.getStats().lateAfterClose, stream.getStats().lastSequence], [0, 2]);
});

test("AE5 real unmount cleanup: the stream is released at once, its queue, timer and observers are gone, and a fact produced afterwards reaches nobody; a development remount accepts the same session again and the unmounted Stop does not end the new observer", async () => {
  const h = await harness();
  const manager = withRealStopClear(h);
  const stream = h.criticalEvents.stream;
  const realStop = h.globals.stop;
  let stopCalls = 0;
  let unmountStop: Promise<unknown> | undefined;
  h.globals.stopOnUnmountRef = { current: () => { stopCalls += 1; unmountStop = realStop(); return unmountStop; } };
  h.globals.semanticTaxonomyRuntimeRef.current.dispose = () => undefined;
  // A fact is still queued for delivery when the Hook unmounts.
  h.globals.submitTaskRuntimeClear(manager, { scope: "all", reason: "active-task-cleared" },
    h.globals.observeTaskRuntimeWriter({ runtimeSessionId: "meeting-A" }));
  assert.equal(stream.getStats().queueDepth, 1);
  assert.equal(h.criticalEvents.manualClock?.pendingCount(), 1);
  const cleanup = h.globals.unmountEffect();
  assert.equal(typeof cleanup, "function");
  assert.equal(stream.getStats().accepting, true, "mounting leaves a bound stream accepting");
  cleanup();
  assert.equal(stopCalls, 1, "the unmount still asks for Stop first");
  const released = stream.getStats();
  assert.deepEqual([released.accepting, released.queueDepth, released.subscribers, released.discardedUndelivered],
    [false, 0, 0, 1]);
  assert.equal(h.criticalEvents.manualClock?.pendingCount(), 0, "the delivery timer was cancelled");
  h.criticalEvents.flush();
  assert.deepEqual(h.criticalEvents.deliveries, [], "nothing is delivered after unmount");
  assert.equal(h.runtimeCancels.length > 0, true, "the runtimes were disposed as before");
  // After the unmount nothing is accepted and nothing can be observed.
  assert.equal(stream.subscribe(() => undefined).reason, "not-accepting");

  // A development remount runs the same effect again while the Stop that the
  // cleanup started is still in flight.
  const remountCleanup = h.globals.unmountEffect();
  assert.equal(stream.getStats().accepting, true, "the remounted Hook's session accepts again");
  const remounted: unknown[] = [];
  assert.equal(stream.subscribe((delivery) => { remounted.push(delivery); }).accepted, true);
  // The earlier mount's Stop still has a task to clear when it gets there.
  seedParent(manager, "parent-after-remount");
  await h.nativeEntered.promise;
  h.nativeReply.resolve(); h.queue.resolve(); await settle();
  await unmountStop;
  h.criticalEvents.flush();
  // The unmounted Stop's own clear is a fact of the session; it ends no subscription of the new mount.
  assert.deepEqual(remounted.map((delivery: any) => [delivery.kind, delivery.event?.refs.transition]), [["event", "clear-all"]]);
  assert.equal(stream.getStats().subscribers, 1, "the remounted observer was not closed by the earlier mount's Stop");
  assert.equal(typeof remountCleanup, "function");
});
