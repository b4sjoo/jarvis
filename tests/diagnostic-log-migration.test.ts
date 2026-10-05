// Task 178 LG, commit 3: the migrated call sites (LG7), their levels (LG1), what they
// leave alone (LG2), what they never carry (LG4) and what a failing delivery changes (LG5).
// Decisions A8: the cause a catch of a native command or of local persistence carries,
// and the two catches that carry none.
//
// The migration ledger is the `migration` part of the rows of DIAGNOSTIC_LOG_LEDGER in
// tests/helpers/diagnostic-log-spy.ts: what each site printed before, the fixed text
// that is gone, and the calls the site still makes. Each migrated call site is driven
// through its own production code: here, or in the test file of the harness that
// already ran that code, which the row names:
//   Stop (native stop and evaluation capture)   tests/app-shutdown-hook.test.ts
//   evaluation commit                           tests/human-evaluation-store.test.ts
//   Native Stall Diagnostics request            tests/native-stall-diagnostics-receipt.test.ts
//   capture start failure                       tests/raw-zero-input-probe.test.ts
//   capture start blocked, no STT provider      tests/local-model-retirement.test.ts
//
// Real: the Hook fragments, read from the source and evaluated as they are written; the
// trace store as compiled; the logger leaf of each spy; the capture lifecycle
// coordinator, the native event authorizers and metadata builders, the audio segment
// ledger and the raw-zero episode. Controlled: the identifier environment of each
// fragment (refs, recorder, native invoke, timers), and the logger's delivery boundary,
// timers, clock and console (see the helper). No product code has a test hook.
//
// A site's kept calls and its logger call are recorded in one sequence. The logger is
// entered in it at the moment it is called, whatever the threshold is, so the sequence
// has to be the same at every level and with every failing delivery.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { RawZeroInputEpisode, authorizeNativeAudioLivenessEvent, buildAudioInputLivenessTraceMetadata } from "../src/lib/meeting/audio-input-liveness.js";
import { AudioSegmentDispositionLedger, formatAudioSegmentObservationForTrace, formatAudioSegmentSettlementForTrace } from "../src/lib/meeting/audio-segment-disposition.js";
import { CaptureLifecycleCoordinator } from "../src/lib/meeting/capture-lifecycle.js";
import type * as Leaf from "../src/lib/meeting/diagnostic-log.js";
import { createManualRuntimeActionEvent } from "../src/lib/meeting/manual-runtime-action.js";
import { authorizeNativeAudioLifecycleEvent, buildNativeAudioLifecycleTraceMetadata, parseNativeAudioSegmentDroppedEvent } from "../src/lib/meeting/native-audio-lifecycle.js";
import { authorizeNativeSpeechDetectedEvent, authorizeNativeSpeechStartEvent, buildNativeSpeechEventTraceMetadata, buildNativeSpeechStartTraceMetadata,
  parseNativeAudioObservation } from "../src/lib/meeting/native-speech-event.js";
import { MIGRATED_SEQUENCES } from "./fixtures/diagnostic-log-migration-sequences.js";
import {
  CAPTURE_LIFECYCLE_DETAILS,
  CAPTURE_LIFECYCLE_STAGE_LEVELS,
  CAUSE_CHARS,
  CAUSE_LIMIT,
  DIAGNOSTIC_LOG_LEDGER,
  DIAGNOSTIC_LOG_NOT_ADDED,
  DIAGNOSTIC_LOG_NOT_MIGRATED,
  DIAGNOSTIC_LOG_SPY_FAILING_DELIVERIES,
  DIAGNOSTIC_LOG_SPY_LEVELS,
  LABEL,
  NO_CAUSE_ON_PROVIDER_PATH,
  PLANTED,
  PLANTED_IN_CAUSE_ONLY,
  PLANTED_NOWHERE,
  PLANTED_VALUES,
  RAW_ZERO_EPISODE_DISPOSITIONS,
  RAW_ZERO_PROBE_ACTION_STAGES,
  RAW_ZERO_PROBE_METADATA_KEYS,
  RAW_ZERO_PROBE_STAGE_LEVELS,
  RAW_ZERO_PROBE_STAGES,
  RECORDING_STOP_REASONS,
  TRACE_STORE_CHANGE_LEVELS,
  assertEntryInLedger,
  assertNothingPlanted,
  assertPlantedOnlyInCause,
  createDiagnosticLogSpy,
  createTraceStoreModule,
  type DiagnosticLogSpyDelivery,
} from "./helpers/diagnostic-log-spy.js";

type Level = Leaf.DiagnosticLogLevel;
type Entry = Leaf.DiagnosticLogEntry;
type Sequence = Array<[string, unknown?]>;

const HOOK = "src/hooks/useMeetingAssistant.ts";
const THIS_TEST = "tests/diagnostic-log-migration.test.ts";
const hookText = readFileSync(HOOK, "utf8");
const hook = ts.createSourceFile("hook.ts", hookText, ts.ScriptTarget.Latest, true);
const NOW = 1_759_570_000_000;

function collect<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(root);
  return found;
}
function one<T extends ts.Node>(found: T[], what: string): T {
  assert.equal(found.length, 1, `exactly one ${what}`);
  return found[0]!;
}
// The function a `const name = useCallback(<function>, deps)` of the Hook declares.
function hookCallback(name: string): ts.Node {
  const declaration = one(collect(hook, (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && node.name.getText(hook) === name &&
    node.initializer !== undefined && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(hook) === "useCallback"), `useCallback ${name}`);
  return (declaration.initializer as ts.CallExpression).arguments[0]!;
}
// The function of the one `useEffect` of the Hook whose text holds the marker.
function hookEffect(marker: string): ts.Node {
  return one(collect(hook, (node): node is ts.ArrowFunction => ts.isArrowFunction(node) && ts.isCallExpression(node.parent) &&
    node.parent.expression.getText(hook) === "useEffect" && node.getText(hook).includes(marker)), `effect with ${marker}`);
}
// A Hook fragment as it is written, evaluated with an explicit identifier environment.
// The environment object is the fragment's global scope itself, so a value a scenario changes later is the value the fragment reads.
const BUILTINS = { Date, Promise, Set, Map, Error, JSON, Math, Boolean, Object, Array, structuredClone };
function evaluate(node: ts.Node, environment: Record<string, unknown>): any {
  const code = ts.transpileModule(`(${node.getText(hook)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  for (const [name, value] of Object.entries(BUILTINS)) if (!(name in environment)) environment[name] = value;
  return vm.runInContext(code, vm.createContext(environment));
}
// `{ current: null }` for every `<name>.current` the fragment reads: a ref the scenario does not set stays empty.
function emptyRefs(node: ts.Node): Record<string, { current: unknown }> {
  const refs: Record<string, { current: unknown }> = {};
  for (const access of collect(node, (child): child is ts.PropertyAccessExpression => ts.isPropertyAccessExpression(child) &&
    child.name.text === "current" && ts.isIdentifier(child.expression))) refs[(access.expression as ts.Identifier).text] = { current: null };
  return refs;
}
// What a call was given, as data: a function or nothing becomes null.
const plain = (value: unknown) => { const text = JSON.stringify(value); return text === undefined ? null : JSON.parse(text); };
const settle = async () => { for (let turn = 0; turn < 40; turn += 1) await Promise.resolve(); };

// One run of one scenario: its logger, and the one sequence its kept calls and its logger calls are entered in.
interface World {
  level: Level;
  spy: ReturnType<typeof createDiagnosticLogSpy>;
  sequence: Sequence;
  logDiagnostic: typeof Leaf.logDiagnostic;
  // The two names a Hook fragment takes from the logger leaf: the entry call, entered in the sequence, and the leaf's
  // own summary of a caught value.
  leaf: Pick<typeof Leaf, "logDiagnostic" | "diagnosticLogCause">;
  // A recorder: every method called on it is entered in the sequence with its arguments.
  recorder(name: string, answers?: Record<string, (...args: any[]) => unknown>): any;
  note(name: string): (...args: unknown[]) => void;
}
function world(level: Level, delivery: DiagnosticLogSpyDelivery): World {
  const spy = createDiagnosticLogSpy({ threshold: level, now: () => NOW, delivery });
  const sequence: Sequence = [];
  const note = (name: string) => (...args: unknown[]) => { sequence.push(args.length ? [name, plain(args.length === 1 ? args[0] : args)] : [name]); };
  const logDiagnostic: typeof Leaf.logDiagnostic = (entryLevel, source, event, detail) => {
    sequence.push(["logDiagnostic", `${source} ${event}`]);
    const result = spy.logDiagnostic(entryLevel, source, event, detail);
    assert.equal(result, undefined, "the logger call returns nothing: there is nothing to await");
  };
  return {
    level, spy, sequence, note, logDiagnostic,
    leaf: { logDiagnostic, diagnosticLogCause: spy.logger.diagnosticLogCause },
    recorder: (name, answers = {}) => new Proxy({}, { get: (_target, method) => (...args: unknown[]) => {
      note(`${name}.${String(method)}`)(...args);
      return answers[String(method)]?.(...args);
    } }),
  };
}

// What a scenario's entries are compared by: level, tags, references and data. `at` is the fixed clock.
const shown = (entry: Entry) => [entry.level, `${entry.source} ${entry.event}`, entry.refs ?? {}, entry.data ?? {}];
type Shown = ReturnType<typeof shown>;
const passes = (threshold: Level, level: Level) => DIAGNOSTIC_LOG_SPY_LEVELS.indexOf(level) <= DIAGNOSTIC_LOG_SPY_LEVELS.indexOf(threshold);

// ---------------------------------------------------------------------------
// The error texts of the scenarios (decisions A8, item 1).
// ---------------------------------------------------------------------------

// What a native command or a local store fails with. Such a text can name a path or a device, so these do: each is in
// the field `cause` of its entry, cut at 160 UTF-16 code units, and in no other part of any entry. A scenario throws
// one as an Error, whose summary starts with its name, or as a string, which is how the Tauri bridge rejects a command.
const NATIVE_PATH_ERROR = `failed to write ${PLANTED.filePath}: No space left on device (os error 28)`;
const NATIVE_DEVICE_ERROR = `${PLANTED.deviceLabel}: the output device is no longer available`;
const causeOfError = (message: string) => `Error: ${message}`;
// What the rejection of a queued segment can carry: a speech-to-text provider's response, with what was said. None of
// it is in any entry, and the path it names is not either, because these two catches carry no cause.
const PROVIDER_RESPONSE_ERROR = `${PLANTED.providerError}: ${PLANTED.transcript} / ${PLANTED.answer} (key ${PLANTED.secret}) at ${PLANTED.filePath}`;
for (const text of [NATIVE_PATH_ERROR, NATIVE_DEVICE_ERROR]) assert.ok(causeOfError(text).length <= CAUSE_CHARS, "written whole into its entry");

// ---------------------------------------------------------------------------
// Fixed native payloads. The texts a real payload can carry are the planted ones.
// ---------------------------------------------------------------------------

const LIVENESS = { schemaVersion: 1, snapshotSequence: 4, captureSessionId: "capture_current", captureGeneration: 3, owner: "meeting", source: "system-audio",
  occurredAtMs: 10_000, sampleRate: 48_000, state: "awaiting-silence", trigger: "periodic", candidateSegmentSequence: 3, candidateStartedAtMs: 8_000,
  candidateDurationMs: 2_000, silenceDurationMs: 640, intervalDurationMs: 2_005, intervalChunkCount: 94, intervalSignalChunkCount: 60,
  intervalSpeechChunkCount: 40, intervalMaxRms: 0.03, intervalMaxPeak: 0.08, processedChunkCount: 300, signalChunkCount: 180, speechChunkCount: 120,
  speechCandidateCount: 3, segmentEmittedCount: 2, candidateDiscardedCount: 0, lastSignalObservedAtMs: 9_980, lastSpeechCandidateAtMs: 8_000,
  lastSegmentEmittedAtMs: 7_500, vadConfigRevision: 1, hopSize: 1_024, sensitivityRms: 0.012, peakThreshold: 0.035, noiseGateThreshold: 0.003,
  silenceTargetMs: 960, minimumSpeechMs: 149, maximumSegmentMs: 30_000 };
const SPEECH_START = { captureSessionId: "capture_current", captureGeneration: 3, candidateSegmentSequence: 8, owner: "meeting", source: "system-audio",
  occurredAtMs: 1_300, sampleRate: 48_000 };
const SPEECH = { captureSessionId: "capture_current", captureGeneration: 3, segmentSequence: 7, owner: "meeting", capturedAtMs: 2_300, speechStartedAtMs: 1_000,
  speechEndedAtMs: 2_250, segmentEmittedAtMs: 2_300, sampleStart: 48_000, sampleEnd: 108_000, sampleRate: 48_000, durationMs: 1_250, endReason: "silence",
  overlapSampleCount: 0, overlapDurationMs: 0, vadSilenceTargetSamples: 50_160, vadMinimumSpeechSamples: 7_824, vadPreSpeechSamples: 13_392,
  vadMaximumSegmentSamples: 1_440_000, mediaType: "audio/wav", audioBase64: "UklGRg==" };
const LIFECYCLE = { eventType: "stopped", captureSessionId: "capture_current", captureGeneration: 3, owner: "meeting", occurredAtMs: 1_234,
  reason: "buffer-overflow", message: PLANTED.providerError, sampleRate: 48_000, expected: false, recoverability: "retry-once",
  diagnostics: { droppedSamples: 24_000, consecutiveDrops: 51, bufferCapacity: 131_072, faultInjected: false, faultInjectionId: null, faultKind: null,
    nativeTailFlushOperationId: null, nativeTailFlushRequestedAtMs: null, nativeTailFlushAcknowledgedAtMs: null, nativeTailFlushDurationMs: null,
    nativeTailFlushDisposition: null, nativeTailFlushCandidateSegmentSequence: null, nativeTailFlushCandidateDurationMs: null,
    nativeTailFlushEmittedSegmentSequence: null, nativeTailFlushNoQualifyingCandidateReason: null } };
const DROPPED = { captureSessionId: "capture_current", captureGeneration: 3, attemptedSegmentSequence: 9, owner: "meeting", occurredAtMs: 5_000,
  reason: "wav-encoding-failed", message: `${PLANTED.providerError} at ${PLANTED.filePath}` };

// ---------------------------------------------------------------------------
// The scenarios. Each drives one or more migrated call sites through the Hook's own code.
// ---------------------------------------------------------------------------

interface Scenario {
  // The `source event` of every ledger row the scenario drives.
  sites: readonly string[];
  drive(world: World): Promise<void> | void;
  // At trace: every entry, in order.
  entries: Shown[];
  // The kept calls and the logger calls, in order.
  sequence: Sequence;
}

// M1. The real trace store with the spy's logger as its import. The store content and the change notifications are the kept part.
const traceStore: Scenario = {
  sites: ["meeting.trace store-event"],
  drive(w) {
    let clock = 1_000;
    // The store's import is the spy's logger, with its entry call entered in the sequence like every other site's.
    const { MeetingTraceStore } = createTraceStoreModule({ logger: { ...w.spy.logger, logDiagnostic: w.logDiagnostic } }, { now: () => clock });
    const store = new MeetingTraceStore();
    store.subscribe((_traces, change) => w.note("store.change")({ changed: change.changed.map((trace) => trace.id),
      removed: change.removedTraceIds, reset: change.reset }));
    store.setDebugEnabled(true);
    // The same value again: the store is not told anything new and logs nothing.
    store.setDebugEnabled(true);
    const trace = store.startTrace("voice", { question: PLANTED.transcript, device: PLANTED.deviceLabel }, clock);
    const step = store.startStep(trace.id, "Advisor model response", { prompt: PLANTED.transcript });
    store.recordInput(trace.id, "Advisor prompt", PLANTED.transcript, { path: PLANTED.filePath });
    store.recordOutput(trace.id, "Advisor answer", `Answer: ${PLANTED.answer}`, { stream: true, chunks: 3 });
    store.updateMetadata(trace.id, { providerError: PLANTED.providerError, key: PLANTED.secret, device: PLANTED.deviceLabel });
    clock += 250;
    store.finishStep(trace.id, step, "error", { reason: PLANTED.providerError }, new Error(PLANTED.providerError));
    clock += 50;
    store.finishTrace(trace.id, "error", new Error(PLANTED.providerError));
    // A step that is already finished is not finished twice, and a step of an unknown trace is not logged as finished.
    store.finishStep(trace.id, step, "success");
    store.finishStep("voice_trace_unknown", step, "success");
    store.setDebugEnabled(false);
    w.note("store.content")(store.getTraces());
    store.clear();
    w.note("store.content")(store.getTraces());
  },
  entries: [
    ["info", "meeting.trace store-event", {}, { change: "debug-mode", enabled: true }],
    ["debug", "meeting.trace store-event", { traceId: "voice_trace_1" }, { change: "trace-started", kind: "voice", metadataKeys: 2 }],
    ["trace", "meeting.trace store-event", { traceId: "voice_trace_1" }, { change: "step-started", step: "Advisor model response", metadataKeys: 1 }],
    ["trace", "meeting.trace store-event", { traceId: "voice_trace_1" }, { change: "input-recorded", valueChars: PLANTED.transcript.length, metadataKeys: 1 }],
    ["trace", "meeting.trace store-event", { traceId: "voice_trace_1" }, { change: "output-recorded", valueChars: PLANTED.answer.length + 8, metadataKeys: 2 }],
    ["trace", "meeting.trace store-event", { traceId: "voice_trace_1" }, { change: "trace-metadata-updated", metadataKeys: 3 }],
    ["debug", "meeting.trace store-event", { traceId: "voice_trace_1" },
      { change: "step-finished", step: "Advisor model response", status: "error", durationMs: 250, metadataKeys: 2 }],
    ["debug", "meeting.trace store-event", { traceId: "voice_trace_1" }, { change: "trace-finished", kind: "voice", status: "error", durationMs: 300 }],
    ["info", "meeting.trace store-event", {}, { change: "debug-mode", enabled: false }],
    ["info", "meeting.trace store-event", {}, { change: "traces-cleared" }],
  ],
  sequence: [],
};

// Manual timers of a fragment that uses `window.setTimeout`.
function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    window: { setTimeout: (callback: () => void) => { const id = ++next; pending.set(id, callback); return id; },
      clearTimeout: (id: number) => { pending.delete(id); } },
    count: () => pending.size,
    async runNext() {
      const [id, callback] = pending.entries().next().value as [number, () => void];
      pending.delete(id);
      callback();
      await settle();
    },
  };
}

// M2. The trace metrics write fails: once with a retry, then finally; and once during shutdown, when no retry is scheduled.
const traceMetricsPersistence: Scenario = {
  sites: ["meeting.trace-metrics persist-failed"],
  async drive(w) {
    const timers = manualTimers();
    let payload = "payload-1";
    const environment = {
      ...emptyRefs(hookCallback("scheduleTraceMetricsPersistence")),
      ...w.leaf, window: timers.window, TRACE_METRICS_PERSIST_DEBOUNCE_MS: 750,
      serializeMeetingTraceMetrics: () => payload,
      invoke: async (command: string, args: { payload: string }) => {
        w.note(`invoke ${command}`)(args.payload);
        throw new Error(NATIVE_PATH_ERROR);
      },
    } as Record<string, any>;
    environment.shutdownRequestedRef.current = false;
    environment.traceMetricsPersistenceReadyRef.current = true;
    environment.queuedTraceMetricsPayloadsRef.current = new Set();
    environment.traceMetricsPersistQueueRef.current = Promise.resolve();
    environment.traceStoreRef.current = { getPersistableTraces: () => [] };
    environment.sessionRecordingManagerRef.current = w.recorder("recording");
    const schedule = evaluate(hookCallback("scheduleTraceMetricsPersistence"), environment);
    schedule();
    await timers.runNext();
    assert.equal(timers.count(), 1, "the first failure scheduled its one retry");
    await timers.runNext();
    assert.equal(timers.count(), 0, "the second failure schedules nothing");
    // Shutdown begins while the write of another payload is under way: its failure is not retried.
    payload = "payload-2";
    schedule();
    // This time the command rejects as the Tauri bridge does, with a string.
    environment.invoke = async (command: string, args: { payload: string }) => {
      w.note(`invoke ${command}`)(args.payload);
      environment.shutdownRequestedRef.current = true;
      throw NATIVE_PATH_ERROR;
    };
    await timers.runNext();
    assert.equal(timers.count(), 0, "no retry during shutdown");
    assert.equal(environment.lastTraceMetricsPayloadRef.current, null, "nothing was saved");
  },
  entries: [
    ["debug", "meeting.trace-metrics persist-failed", {}, { attempt: 1, retryScheduled: true, cause: causeOfError(NATIVE_PATH_ERROR) }],
    ["warn", "meeting.trace-metrics persist-failed", {}, { attempt: 2, retryScheduled: false, cause: causeOfError(NATIVE_PATH_ERROR) }],
    ["warn", "meeting.trace-metrics persist-failed", {}, { attempt: 1, retryScheduled: false, cause: NATIVE_PATH_ERROR }],
  ],
  sequence: [],
};

// M3. The Hook's reporter under the real coordinator, through all ten stages.
const captureLifecycle: Scenario = {
  sites: ["meeting.capture-lifecycle stage-reported"],
  async drive(w) {
    const reporter = one(collect(hook, (node): node is ts.NewExpression => ts.isNewExpression(node) &&
      node.expression.getText(hook) === "CaptureLifecycleCoordinator"), "coordinator construction").arguments![0]!;
    const recording = { recordCaptureLifecycle: (metadata: { occurredAt: number }) => w.note("recording.recordCaptureLifecycle")({ ...metadata, occurredAt: typeof metadata.occurredAt }) };
    const coordinator = new CaptureLifecycleCoordinator(evaluate(reporter, { ...w.leaf, sessionRecordingManagerRef: { current: recording } }));
    const start = coordinator.claim("start");
    coordinator.authorize(start, "commit-start-error");
    coordinator.recordNativeCompletion(start, "start_meeting_audio_session");
    await coordinator.run(start, async () => "started");
    const stale = coordinator.claim("pause");
    coordinator.claim("stop");
    await coordinator.run(stale, async () => "never");
    await coordinator.cleanupStale(stale, "late-native-start-completion", async () => undefined);
    await coordinator.cleanupStale(stale, "late-native-start-completion", async () => { throw new Error(`${PLANTED.providerError} on ${PLANTED.deviceLabel}`); });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = coordinator.runCoalesced("resume", () => gate);
    const second = coordinator.runCoalesced("resume", () => gate);
    release();
    await Promise.all([first, second]);
  },
  entries: [
    ["info", { stage: "claimed", action: "start", authorized: true, captureOperationId: 1 }],
    ["debug", { stage: "authorization-checked", action: "start", authorized: true, captureOperationId: 1, detail: "commit-start-error" }],
    ["debug", { stage: "native-completed", action: "start", authorized: true, captureOperationId: 1, detail: "start_meeting_audio_session" }],
    ["debug", { stage: "dequeued", action: "start", authorized: true, captureOperationId: 1 }],
    ["info", { stage: "finished", action: "start", authorized: true, captureOperationId: 1 }],
    ["info", { stage: "claimed", action: "pause", authorized: true, captureOperationId: 2 }],
    ["info", { stage: "claimed", action: "stop", authorized: true, captureOperationId: 3 }],
    ["debug", { stage: "dequeued", action: "pause", authorized: false, captureOperationId: 2 }],
    ["debug", { stage: "skipped-before-run", action: "pause", authorized: false, captureOperationId: 2 }],
    ["debug", { stage: "stale-cleanup-started", action: "pause", authorized: false, captureOperationId: 2, detail: "late-native-start-completion" }],
    ["debug", { stage: "stale-cleanup-finished", action: "pause", authorized: false, captureOperationId: 2, detail: "late-native-start-completion" }],
    ["debug", { stage: "stale-cleanup-started", action: "pause", authorized: false, captureOperationId: 2, detail: "late-native-start-completion" }],
    ["warn", { stage: "stale-cleanup-failed", action: "pause", authorized: false, captureOperationId: 2, detail: "late-native-start-completion" }],
    ["info", { stage: "claimed", action: "resume", authorized: true, captureOperationId: 4 }],
    ["debug", { stage: "coalesced", action: "resume", authorized: true, captureOperationId: 4 }],
    ["debug", { stage: "dequeued", action: "resume", authorized: true, captureOperationId: 4 }],
    ["info", { stage: "finished", action: "resume", authorized: true, captureOperationId: 4 }],
  ].map(([level, data]) => [level as Level, "meeting.capture-lifecycle stage-reported", {}, data as Record<string, unknown>]),
  sequence: [],
};

// M4. The Hook's listener effect: every native event it listens to, authorized or not.
function listenerEnvironment(w: World, listen: (name: string, handler: (event: { payload: unknown }) => unknown) => Promise<() => void>) {
  const effect = hookEffect("setupListeners");
  const environment = { ...emptyRefs(effect), ...emptyRefs(hookCallback("observeNativeAudioSegment")) } as Record<string, any>;
  Object.assign(environment, {
    ...w.leaf, listen,
    invoke: async (command: string, args: unknown) => { w.note(`invoke ${command}`)(args); throw new Error(NATIVE_DEVICE_ERROR); },
    authorizeNativeAudioLivenessEvent, buildAudioInputLivenessTraceMetadata, authorizeNativeSpeechStartEvent, buildNativeSpeechStartTraceMetadata,
    authorizeNativeSpeechDetectedEvent, buildNativeSpeechEventTraceMetadata, formatAudioSegmentObservationForTrace, formatAudioSegmentSettlementForTrace,
    parseNativeAudioSegmentDroppedEvent, authorizeNativeAudioLifecycleEvent, buildNativeAudioLifecycleTraceMetadata, parseNativeAudioObservation,
  });
  // The Hook's own observation callback, over the real segment ledger.
  environment.observeNativeAudioSegment = evaluate(hookCallback("observeNativeAudioSegment"), environment);
  environment.audioSegmentDispositionLedgerRef.current = new AudioSegmentDispositionLedger();
  environment.sessionRecordingManagerRef.current = w.recorder("recording");
  environment.traceStoreRef.current = w.recorder("traceStore");
  environment.nativeCaptureSessionIdRef.current = "capture_current";
  environment.nativeCaptureGenerationRef.current = 3;
  environment.lastNativeSegmentSequenceRef.current = 7;
  environment.lastNativeAudioLivenessSequenceRef.current = 0;
  environment.lastNativeSpeechStartCandidateSequenceRef.current = 0;
  environment.shutdownRequestedRef.current = false;
  environment.nativeTerminalEvidenceRef.current = {};
  // The two terminal events of this scenario were handled before: the listener records the repeat and goes no further.
  environment.handledNativeTerminalKeysRef.current = new Set(["meeting:capture_current:3:stopped:buffer-overflow", "meeting:capture_current:3:error:buffer-overflow"]);
  return { effect, environment };
}
const nativeAudioListeners: Scenario = {
  sites: ["meeting.native-audio liveness-rejected", "meeting.native-audio stall-marker-ack-failed", "meeting.native-audio speech-start-rejected",
    "meeting.native-audio speech-segment-observed", "meeting.native-audio speech-segment-rejected", "meeting.native-audio segment-dropped",
    "meeting.native-audio lifecycle-event"],
  async drive(w) {
    const handlers = new Map<string, (event: { payload: unknown }) => unknown>();
    const { effect, environment } = listenerEnvironment(w, async (name, handler) => { handlers.set(name, handler); return () => undefined; });
    evaluate(effect, environment)();
    await settle();
    assert.deepEqual([...handlers.keys()].sort(), ["native-audio-lifecycle", "native-audio-liveness", "native-audio-observation", "native-audio-segment-dropped",
      "speech-detected", "speech-start"]);
    const emit = async (name: string, payload: unknown) => { w.note("native event")(name); await handlers.get(name)!({ payload }); await settle(); };
    const other = { captureSessionId: "capture_other" };
    // Liveness: an envelope that cannot be read, then a marker of another capture, whose acknowledgement native rejects.
    await emit("native-audio-liveness", { label: PLANTED.deviceLabel });
    await emit("native-audio-liveness", { ...LIVENESS, ...other, diagnosticRunId: "nsd_run_1" });
    // Speech start: unreadable, then an older generation.
    await emit("speech-start", { text: PLANTED.transcript });
    await emit("speech-start", { ...SPEECH_START, captureGeneration: 2 });
    // A segment: unreadable; of another capture; the last accepted sequence again, twice; and an older sequence.
    await emit("speech-detected", { transcript: PLANTED.transcript });
    await emit("speech-detected", { ...SPEECH, ...other });
    await emit("speech-detected", SPEECH);
    await emit("speech-detected", SPEECH);
    await emit("speech-detected", { ...SPEECH, segmentSequence: 5 });
    // A dropped segment: unreadable, of another capture, of this capture.
    await emit("native-audio-segment-dropped", { message: PLANTED.providerError });
    await emit("native-audio-segment-dropped", { ...DROPPED, ...other });
    await emit("native-audio-segment-dropped", DROPPED);
    // Lifecycle: unreadable; of another capture; then started, stopped and error of this capture.
    await emit("native-audio-lifecycle", { message: PLANTED.providerError });
    await emit("native-audio-lifecycle", { ...LIFECYCLE, ...other, eventType: "error" });
    await emit("native-audio-lifecycle", { ...LIFECYCLE, eventType: "started", reason: null, message: null, expected: true, recoverability: "not-applicable" });
    await emit("native-audio-lifecycle", LIFECYCLE);
    await emit("native-audio-lifecycle", { ...LIFECYCLE, eventType: "error", recoverability: "manual" });
  },
  entries: ([
    ["debug", "liveness-rejected", {}, { reason: "invalid-envelope" }],
    ["debug", "liveness-rejected", {}, { reason: "capture-session-mismatch", captureSessionId: "capture_other", captureGeneration: 3, snapshotSequence: 4 }],
    ["warn", "stall-marker-ack-failed", {}, { captureSessionId: "capture_other", captureGeneration: 3, snapshotSequence: 4,
      cause: causeOfError(NATIVE_DEVICE_ERROR) }],
    ["debug", "speech-start-rejected", {}, { reason: "invalid-envelope" }],
    ["debug", "speech-start-rejected", {}, { reason: "capture-generation-mismatch", captureSessionId: "capture_current", captureGeneration: 2, candidateSegmentSequence: 8 }],
    ["debug", "speech-segment-rejected", {}, { reason: "invalid-envelope", authority: "active-capture" }],
    ["debug", "speech-segment-rejected", {}, { reason: "capture-session-mismatch", authority: "active-capture", captureSessionId: "capture_other",
      captureGeneration: 3, segmentSequence: 7 }],
    ["debug", "speech-segment-observed", {}, { reason: "duplicate-sequence", captureSessionId: "capture_current", captureGeneration: 3, segmentSequence: 7,
      observationDisposition: "first-observation", observationCount: 1, duplicateObservationCount: 0 }],
    ["debug", "speech-segment-observed", {}, { reason: "duplicate-sequence", captureSessionId: "capture_current", captureGeneration: 3, segmentSequence: 7,
      observationDisposition: "duplicate-observation", observationCount: 2, duplicateObservationCount: 1, canonicalDisposition: "duplicate" }],
    ["debug", "speech-segment-observed", {}, { reason: "non-monotonic-sequence", captureSessionId: "capture_current", captureGeneration: 3, segmentSequence: 5,
      observationDisposition: "first-observation", observationCount: 1, duplicateObservationCount: 0 }],
    ["debug", "segment-dropped", {}, { authorized: false, envelopeValid: false }],
    ["debug", "segment-dropped", {}, { authorized: false, envelopeValid: true, owner: "meeting", captureSessionId: "capture_other", captureGeneration: 3,
      attemptedSegmentSequence: 9 }],
    ["warn", "segment-dropped", {}, { authorized: true, envelopeValid: true, owner: "meeting", captureSessionId: "capture_current", captureGeneration: 3,
      attemptedSegmentSequence: 9 }],
    ["debug", "lifecycle-event", {}, { authorized: false, rejectionReason: "invalid-envelope" }],
    ["debug", "lifecycle-event", {}, { authorized: false, rejectionReason: "capture-session-mismatch", eventType: "error", owner: "meeting",
      captureSessionId: "capture_other", captureGeneration: 3, expected: false, recoverability: "retry-once" }],
    ["info", "lifecycle-event", {}, { authorized: true, eventType: "started", owner: "meeting", captureSessionId: "capture_current", captureGeneration: 3,
      expected: true, recoverability: "not-applicable" }],
    ["info", "lifecycle-event", {}, { authorized: true, eventType: "stopped", owner: "meeting", captureSessionId: "capture_current", captureGeneration: 3,
      expected: false, recoverability: "retry-once" }],
    ["warn", "lifecycle-event", {}, { authorized: true, eventType: "error", owner: "meeting", captureSessionId: "capture_current", captureGeneration: 3,
      expected: false, recoverability: "manual" }],
  ] as Array<[Level, string, object, object]>).map(([level, event, refs, data]) => [level, `meeting.native-audio ${event}`, refs, data]),
  sequence: [],
};
const nativeAudioListenerSetup: Scenario = {
  sites: ["meeting.native-audio listener-setup-failed"],
  async drive(w) {
    const { effect, environment } = listenerEnvironment(w, async (name) => {
      w.note("listen")(name);
      throw new Error(NATIVE_DEVICE_ERROR);
    });
    const dispose = evaluate(effect, environment)();
    await settle();
    dispose();
  },
  entries: [["error", "meeting.native-audio listener-setup-failed", {}, { cause: causeOfError(NATIVE_DEVICE_ERROR) }]],
  sequence: [],
};

// M5. Pause: the native stop fails and Pause goes on.
const pause: Scenario = {
  sites: ["meeting.capture pause-native-failed"],
  async drive(w) {
    const node = hookCallback("pause");
    let state: Record<string, unknown> = { status: "listening", partialSuggestion: "partial", error: "earlier" };
    const environment = { ...emptyRefs(node), ...w.leaf } as Record<string, any>;
    for (const name of ["openAudioDrainAuthorization", "cancelNativeAudioFaultTraces", "cancelActiveAdvisorJob", "revokeAudioDrainAuthorization",
      "invalidateRuntimeWork", "invalidateAudioProcessingSession"]) environment[name] = w.note(name);
    Object.assign(environment, {
      readNativeCaptureLease: () => ({ captureSessionId: "capture_current", captureGeneration: 3 }),
      stopNativeMeetingCapture: async (lease: unknown) => { w.note("stopNativeMeetingCapture")(lease); throw new Error(NATIVE_DEVICE_ERROR); },
      drainSystemAudioQueueForNativeStop: async (...args: unknown[]) => { w.note("drainSystemAudioQueueForNativeStop")(...args); },
      setState: (update: (previous: Record<string, unknown>) => Record<string, unknown>) => { state = update(state); w.note("setState")(state); },
    });
    environment.shutdownRequestedRef.current = false;
    environment.microphoneVadDisposeRef.current = w.note("microphoneVadDispose");
    environment.activeRef.current = true;
    environment.runtimeActiveRef.current = true;
    environment.captureLifecycleCoordinatorRef.current = new CaptureLifecycleCoordinator((event) => w.note("lifecycle")([event.stage, event.authorized, event.detail ?? null]));
    await evaluate(node, environment)();
    w.note("refs")([environment.activeRef.current, environment.runtimeActiveRef.current, environment.microphoneSpeakingRef.current]);
  },
  entries: [["warn", "meeting.capture pause-native-failed", {}, { captureOperationId: 1, cause: causeOfError(NATIVE_DEVICE_ERROR) }]],
  sequence: [],
};

// M5. A queued segment with no STT provider: the native stop that follows fails.
const missingProviderStop: Scenario = {
  sites: ["meeting.capture missing-provider-stop-failed"],
  async drive(w) {
    const node = hookCallback("processQueuedSpeechSegment");
    let state: Record<string, unknown> = { status: "transcribing", partialSuggestion: "partial", error: null };
    const environment = { ...emptyRefs(node), ...w.leaf } as Record<string, any>;
    for (const name of ["settleNativeAudioSegment", "invalidateAudioProcessingSession", "cancelActiveAdvisorJob"]) environment[name] = w.note(name);
    Object.assign(environment, {
      sttProvider: undefined, MISSING_STT_MESSAGE: "Configure a speech-to-text provider.",
      readAudioSegmentCommitAuthorization: () => ({ authorized: true }),
      formatAudioSegmentCommitAuthorizationForTrace: () => ({ audioSegmentCommitAuthorized: true }),
      stopNativeMeetingCapture: async () => { w.note("stopNativeMeetingCapture")(); throw NATIVE_DEVICE_ERROR; },
      setState: (update: (previous: Record<string, unknown>) => Record<string, unknown>) => { state = update(state); w.note("setState")(state); },
    });
    environment.traceStoreRef.current = w.recorder("traceStore");
    environment.audioSessionIdRef.current = "audio-1";
    environment.activeRef.current = true;
    environment.runtimeActiveRef.current = true;
    environment.captureLifecycleCoordinatorRef.current = new CaptureLifecycleCoordinator((event) => w.note("lifecycle")([event.stage, event.authorized, event.detail ?? null]));
    await evaluate(node, environment)({ traceId: "voice_trace_7", queueStepId: "trace_step_7", queuedAt: NOW - 40, dequeuedAt: NOW, sequence: 4, sessionId: "audio-1",
      speaker: "them", source: "system-audio", queueDepthAtEnqueue: 1, queueDepthAtDequeue: 0, queueDequeueAuthorized: true });
  },
  entries: [["warn", "meeting.capture missing-provider-stop-failed", { traceId: "voice_trace_7" }, { captureOperationId: 1, cause: NATIVE_DEVICE_ERROR }]],
  sequence: [],
};

// M5. The two audio queues: the queued segment's processing rejects with what a speech-to-text provider answered. These
// two entries carry no cause.
const audioQueues: Scenario = {
  sites: ["meeting.audio-queue system-segment-failed", "meeting.audio-queue microphone-segment-failed"],
  async drive(w) {
    for (const [name, call] of [["enqueueSpeechDetected", (enqueue: Function) => enqueue({ ...SPEECH, segmentSequence: 8 })],
      ["enqueueMicrophoneSpeech", (enqueue: Function) => enqueue({ size: 3200, type: "audio/wav" }, NOW - 900, NOW - 100)]] as const) {
      const node = hookCallback(name);
      let traces = 0;
      const environment = { ...emptyRefs(node), ...w.leaf, buildNativeSpeechEventTraceMetadata,
        isOpenAudioDrainAuthorizationForNativeEvent: () => false, observeNativeAudioSegment: w.note("observeNativeAudioSegment"),
        processQueuedSpeechSegment: async (segment: { sequence: number; traceId: string }) => {
          w.note("processQueuedSpeechSegment")([segment.sequence, segment.traceId]);
          throw new Error(PROVIDER_RESPONSE_ERROR);
        } } as Record<string, any>;
      environment.shutdownRequestedRef = { current: false };
      environment.activeRef.current = true;
      environment.microphoneContextEnabledRef = { current: true };
      environment.nativeCaptureSessionIdRef = { current: "capture_current" };
      environment.nativeCaptureGenerationRef = { current: 3 };
      environment.audioSessionIdRef.current = "audio-1";
      environment.audioSegmentSeqRef.current = 3;
      environment.captureLifecycleCoordinatorRef.current = { getTraceMetadata: () => ({}) };
      environment.sttEvaluationCaptureManagerRef = { current: { getState: () => ({ active: false }) } };
      for (const tracker of ["systemAudioQueueTrackerRef", "microphoneAudioQueueTrackerRef"]) {
        environment[tracker] = { current: { enqueue: () => 1, dequeue: () => ({ queueDepthAtDequeue: 0, authorized: true }) } };
      }
      for (const tail of ["systemAudioQueueTailRef", "microphoneAudioQueueTailRef"]) environment[tail] = { current: Promise.resolve() };
      environment.traceStoreRef.current = w.recorder("traceStore", {
        startTrace: () => ({ id: `voice_trace_${++traces}` }), startStep: () => "trace_step_1" });
      w.note("enqueue")(name);
      call(evaluate(node, environment));
      await settle();
    }
  },
  entries: [
    ["warn", "meeting.audio-queue system-segment-failed", { traceId: "voice_trace_1" }, { segmentSequence: 4 }],
    ["warn", "meeting.audio-queue microphone-segment-failed", { traceId: "voice_trace_1" }, { segmentSequence: 4 }],
  ],
  sequence: [],
};

// M6. The raw-zero probe report, with the real episode: a Screen that resets the wait, the warning, the probe with its
// restart, the signal that returns, and a caller that passes keys the report sets itself. The four reports of an action
// of the probe are info; the others are debug.
const rawZeroProbe: Scenario = {
  sites: ["meeting.raw-zero-input probe-observed"],
  drive(w) {
    const node = hookCallback("reportRawZeroProbe");
    const episode = new RawZeroInputEpisode();
    let clock = 200_000;
    let activeScreenOperationId: string | null = "screen_operation_1";
    const environment = { ...emptyRefs(node), ...w.leaf, Date: class extends Date { static now() { return clock; } } } as Record<string, any>;
    environment.rawZeroInputEpisodeRef.current = episode;
    environment.nativeCaptureSessionIdRef.current = "capture_current";
    environment.nativeCaptureGenerationRef.current = 3;
    environment.screenOperationCoordinatorRef.current = { getActiveOperationId: () => activeScreenOperationId };
    environment.sessionRecordingManagerRef.current = w.recorder("recording");
    const report = evaluate(node, environment);
    // A Screen is admitted before any zero input: its caller names the operation.
    report("screen-wait-reset", { screenOperationId: "screen_operation_1" });
    // A silent source since 100 s and a second Screen admitted at 150 s: the episode carries its warning and waits 90 s
    // from that Screen. This caller names no Screen operation: the entry has the active one.
    episode.observe({ ...LIVENESS, rawSignalChunkCount: 1, rawZeroDurationMs: 0, occurredAtMs: 100_000, lastRawSignalObservedAtMs: 100_000 } as never);
    episode.observe({ ...LIVENESS, rawSignalChunkCount: 1, rawZeroDurationMs: 95_000, occurredAtMs: 195_000, lastRawSignalObservedAtMs: 100_000 } as never);
    episode.screenAdmitted(150_000);
    activeScreenOperationId = "screen_operation_2";
    report("screen-wait", { disposition: "screen-wait" });
    // The wait is over and no Screen is active: the probe is ready and is requested.
    clock = 250_000;
    activeScreenOperationId = null;
    report("probe-ready", { disposition: "probe-ready" });
    report("requested", { recoveryAttemptId: "raw_zero_probe_1" });
    // The restart. The Hook clears the lease before it reports, so the capture is the previous one of the attempt.
    episode.markProbeStarted();
    environment.nativeCaptureSessionIdRef.current = null;
    environment.nativeCaptureGenerationRef.current = null;
    report("native-restart-started", { recoveryAttemptId: "raw_zero_probe_1", operationId: 4, previousCaptureSessionId: "capture_current", previousCaptureGeneration: 3 });
    environment.nativeCaptureSessionIdRef.current = "capture_next";
    environment.nativeCaptureGenerationRef.current = 4;
    report("native-restart-completed", { recoveryAttemptId: "raw_zero_probe_1", operationId: 4, signalRestored: false });
    // Real signal returns on the new capture.
    clock = 260_000;
    assert.equal(episode.observe({ ...LIVENESS, rawSignalChunkCount: 2, rawZeroDurationMs: 0, occurredAtMs: 260_000, lastRawSignalObservedAtMs: 259_000 } as never), true);
    report("signal-restored", { snapshotSequence: 12, signalRestored: true });
    // The keys the report sets itself, passed by a caller: they replace the recorded observation's values, as they did
    // before the migration, and none of them reaches the entry. No caller in the Hook passes them (LG4 static).
    report("request-finished", { recoveryAttemptId: "raw_zero_probe_1", stage: PLANTED.transcript, captureSessionId: PLANTED.deviceLabel,
      captureGeneration: PLANTED.filePath, warning: PLANTED.providerError, probeUsed: PLANTED.transcript, zeroSince: PLANTED.secret,
      waitUntil: PLANTED.providerError });
  },
  entries: [
    ["debug", "meeting.raw-zero-input probe-observed", {}, { stage: "screen-wait-reset", captureSessionId: "capture_current", captureGeneration: 3,
      screenOperationId: "screen_operation_1", warning: false, episodeDisposition: "waiting", probeUsed: false }],
    ["debug", "meeting.raw-zero-input probe-observed", {}, { stage: "screen-wait", captureSessionId: "capture_current", captureGeneration: 3,
      screenOperationId: "screen_operation_2", warning: true, episodeDisposition: "screen-wait", probeUsed: false, zeroDurationMs: 100_000, waitRemainingMs: 40_000 }],
    ["debug", "meeting.raw-zero-input probe-observed", {}, { stage: "probe-ready", captureSessionId: "capture_current", captureGeneration: 3,
      warning: true, episodeDisposition: "probe-ready", probeUsed: false, zeroDurationMs: 150_000, waitRemainingMs: 0 }],
    ["info", "meeting.raw-zero-input probe-observed", {}, { stage: "requested", captureSessionId: "capture_current", captureGeneration: 3,
      recoveryAttemptId: "raw_zero_probe_1", warning: true, episodeDisposition: "probe-ready", probeUsed: false, zeroDurationMs: 150_000, waitRemainingMs: 0 }],
    // No capture: the identifier and the generation are left out, not sent as null.
    ["info", "meeting.raw-zero-input probe-observed", {}, { stage: "native-restart-started", captureOperationId: 4, recoveryAttemptId: "raw_zero_probe_1",
      previousCaptureSessionId: "capture_current", previousCaptureGeneration: 3, warning: true, episodeDisposition: "probe-used", probeUsed: true,
      zeroDurationMs: 150_000, waitRemainingMs: 0 }],
    ["info", "meeting.raw-zero-input probe-observed", {}, { stage: "native-restart-completed", captureSessionId: "capture_next", captureGeneration: 4,
      captureOperationId: 4, recoveryAttemptId: "raw_zero_probe_1", signalRestored: false, warning: true, episodeDisposition: "probe-used", probeUsed: true,
      zeroDurationMs: 150_000, waitRemainingMs: 0 }],
    ["info", "meeting.raw-zero-input probe-observed", {}, { stage: "signal-restored", captureSessionId: "capture_next", captureGeneration: 4,
      snapshotSequence: 12, signalRestored: true, warning: false, episodeDisposition: "waiting", probeUsed: false }],
    ["debug", "meeting.raw-zero-input probe-observed", {}, { stage: "request-finished", captureSessionId: "capture_next", captureGeneration: 4,
      recoveryAttemptId: "raw_zero_probe_1", warning: false, episodeDisposition: "waiting", probeUsed: false }],
  ],
  sequence: [],
};

// M7. The observed projection of an evaluated attempt is not saved.
const observedProjection: Scenario = {
  sites: ["meeting.evaluation observed-projection-persist-failed"],
  async drive(w) {
    const node = hookCallback("refreshHumanEvaluationObservedProjectionForTrace");
    const projection = { projectionId: "human_projection_v2_1a2b3c", observed: { traceId: "voice_trace_7", answer: PLANTED.transcript } };
    const environment = { ...emptyRefs(node), ...w.leaf,
      materializeHumanEvaluationAttemptProjectionV2: () => ({ changed: true, projection, projections: [projection] }),
      setHumanEvaluationProjectionsV2: w.note("setHumanEvaluationProjectionsV2"),
      humanEvaluationStore: { saveObservation: async (saved: unknown) => { w.note("humanEvaluationStore.saveObservation")(saved); throw new Error(NATIVE_PATH_ERROR); } },
    } as Record<string, any>;
    environment.contextManagerRef.current = { getState: () => ({ sessionId: "meeting_1" }) };
    environment.humanGroundTruthEventsV2Ref.current = [];
    environment.humanEvaluationProjectionsV2Ref.current = [];
    environment.sessionRecordingManagerRef.current = w.recorder("recording");
    evaluate(node, environment)({ id: "voice_trace_7", kind: "voice", status: "success" }, []);
    await settle();
  },
  entries: [["warn", "meeting.evaluation observed-projection-persist-failed", { traceId: "voice_trace_7" },
    { projectionId: "human_projection_v2_1a2b3c", cause: "evaluation-store-operation-failed" }]],
  sequence: [],
};

// M7. The trace metrics cannot be read at mount: the native read command rejects with `failure`.
const traceMetricsLoadFailing = (failure: unknown, entries: Shown[]): Scenario => ({
  sites: ["meeting.trace-metrics load-failed"],
  async drive(w) {
    const node = hookEffect("loadPersistedTraceMetrics");
    const environment = { ...emptyRefs(node), ...w.leaf, window: manualTimers().window,
      invoke: async (command: string) => { w.note(`invoke ${command}`)(); throw failure; },
      parseMeetingTraceMetrics: () => assert.fail("nothing was read"), scheduleTraceMetricsPersistence: w.note("scheduleTraceMetricsPersistence") } as Record<string, any>;
    environment.traceStoreRef.current = w.recorder("traceStore");
    const dispose = evaluate(node, environment)();
    await settle();
    w.note("ready")(environment.traceMetricsPersistenceReadyRef.current);
    dispose();
  },
  entries,
  sequence: [],
});
const traceMetricsLoad = traceMetricsLoadFailing(NATIVE_PATH_ERROR, [["warn", "meeting.trace-metrics load-failed", {}, { cause: NATIVE_PATH_ERROR }]]);

// M7. The automatic export of a finished trace fails.
const autoExport: Scenario = {
  sites: ["meeting.trace-export auto-export-failed"],
  async drive(w) {
    const node = hookCallback("maybeAutoExportTraces");
    const environment = { ...emptyRefs(node), ...w.leaf, shouldAutoExportTrace: () => true, getAutoExportTrigger: () => "auto-error",
      exportTraceObject: async (trace: { id: string }, trigger: string) => { w.note("exportTraceObject")([trace.id, trigger]); throw NATIVE_PATH_ERROR; },
    } as Record<string, any>;
    environment.shutdownRequestedRef.current = false;
    environment.autoExportProcessedTraceIdsRef.current = new Set();
    environment.traceMetricsPersistenceReadyRef.current = true;
    environment.debugModeRef.current = true;
    evaluate(node, environment)([{ id: "voice_trace_running", kind: "voice", status: "running" },
      { id: "screen_trace_9", kind: "screen", status: "error", error: PLANTED.providerError, metadata: { question: PLANTED.transcript } }]);
    await settle();
  },
  entries: [["warn", "meeting.trace-export auto-export-failed", { traceId: "screen_trace_9" }, { kind: "screen", status: "error", cause: NATIVE_PATH_ERROR }]],
  sequence: [],
};

// M7. STT Evaluation Capture: each of its five call sites outside Stop.
const sttEvaluationCapture: Scenario = {
  sites: ["meeting.stt-evaluation-capture initialize-failed", "meeting.stt-evaluation-capture refresh-failed", "meeting.stt-evaluation-capture authorization-stop-failed",
    "meeting.stt-evaluation-capture update-failed", "meeting.stt-evaluation-capture delete-failed"],
  async drive(w) {
    const failing = (method: string) => async (...args: unknown[]) => { w.note(`capture.${method}`)(...args); throw new Error(NATIVE_PATH_ERROR); };
    const manager = { cleanupExpired: async () => { w.note("capture.cleanupExpired")(); }, refresh: failing("refresh"), stop: failing("stop"), start: failing("start"),
      deleteCurrent: failing("deleteCurrent") };
    const base = () => ({ ...w.leaf, sttEvaluationCaptureManagerRef: { current: manager } });
    // At mount: cleanup, then a refresh that fails.
    evaluate(hookEffect("cleanupExpired"), base())();
    await settle();
    // While a capture is active: the two-second refresh fails each time it runs.
    let tick!: () => void;
    const interval = { setInterval: (callback: () => void, period: number) => { tick = callback; w.note("setInterval")(period); return 1; }, clearInterval: w.note("clearInterval") };
    const disposeRefresh = evaluate(hookEffect("refresh-failed"), { ...base(), window: interval, state: { sttEvaluationCapture: { active: true } } })();
    tick(); await settle(); tick(); await settle();
    disposeRefresh();
    // The authorization source is gone while a capture is active: the stop fails.
    evaluate(hookEffect("authorization-source-disabled"), { ...base(),
      state: { sttEvaluationCapture: { active: true }, settings: { debugMode: false }, sessionRecording: { active: false } } })();
    await settle();
    // The user turns the capture on and off, and deletes it.
    const setEnabled = hookCallback("setSttEvaluationCaptureEnabled");
    const environment = { ...emptyRefs(setEnabled), ...base(), setState: w.note("setState"),
      state: { settings: { debugMode: true }, sessionRecording: { active: false } } } as Record<string, any>;
    environment.shutdownRequestedRef.current = false;
    environment.activeRef.current = false;
    evaluate(setEnabled, environment)(true);
    await settle();
    evaluate(setEnabled, environment)(false);
    await settle();
    evaluate(hookCallback("deleteSttEvaluationCapture"), base())();
    await settle();
  },
  entries: [
    ["warn", "meeting.stt-evaluation-capture initialize-failed", {}, { cause: causeOfError(NATIVE_PATH_ERROR) }],
    ["debug", "meeting.stt-evaluation-capture refresh-failed", {}, { cause: causeOfError(NATIVE_PATH_ERROR) }],
    ["debug", "meeting.stt-evaluation-capture refresh-failed", {}, { cause: causeOfError(NATIVE_PATH_ERROR) }],
    ["warn", "meeting.stt-evaluation-capture authorization-stop-failed", {}, { cause: causeOfError(NATIVE_PATH_ERROR) }],
    ["warn", "meeting.stt-evaluation-capture update-failed", {}, { enabled: true, cause: causeOfError(NATIVE_PATH_ERROR) }],
    ["warn", "meeting.stt-evaluation-capture update-failed", {}, { enabled: false, cause: causeOfError(NATIVE_PATH_ERROR) }],
    ["warn", "meeting.stt-evaluation-capture delete-failed", {}, { cause: causeOfError(NATIVE_PATH_ERROR) }],
  ],
  sequence: [],
};

// M10. A type correction at each of its stages, and another action, which is not logged.
const manualAction: Scenario = {
  sites: ["meeting.manual-action type-correction-recorded"],
  drive(w) {
    const node = hookCallback("recordManualRuntimeAction");
    const environment = { ...emptyRefs(node), ...w.leaf, createManualRuntimeActionEvent,
      emitRuntimeCriticalEvent: (event: { fact: string; stage: string }) => w.note("emitRuntimeCriticalEvent")([event.fact, event.stage]) } as Record<string, any>;
    environment.contextManagerRef.current = { getState: () => ({ sessionId: "meeting_1" }) };
    environment.runtimeEpochRef.current = 2;
    environment.visibleAnswerRevisionRef.current = 5;
    environment.manualActionCriticalOriginRef.current = new Map();
    environment.sessionRecordingManagerRef.current = w.recorder("recording");
    const record = evaluate(node, environment);
    const action = { actionId: "manual_action_1", action: "type-correction", correctedType: "system-design", uiSurface: "focus-mode", ingressSource: "shortcut",
      ingressReceivedAt: NOW - 5, occurredAt: NOW, traceId: "voice_trace_7" };
    record({ ...action, stage: "requested" });
    record({ ...action, stage: "accepted" });
    record({ ...action, stage: "terminal", terminalDisposition: "rejected", reason: PLANTED.transcript });
    record({ actionId: "manual_action_2", action: "force-advise", stage: "requested", occurredAt: NOW });
  },
  entries: (["requested", "accepted", "terminal"] as const).map((stage) => ["info", "meeting.manual-action type-correction-recorded",
    { traceId: "voice_trace_7", operationId: "manual_action_1" },
    { stage, uiSurface: "focus-mode", ingressSource: "shortcut", ...(stage === "terminal" ? { terminalDisposition: "rejected" } : {}) }]),
  sequence: [],
};

// M10. An Interview Brief update, and its removal.
const interviewBrief: Scenario = {
  sites: ["meeting.interview-brief brief-updated"],
  drive(w) {
    const node = hookCallback("setInterviewSessionBrief");
    let state: Record<string, unknown> = { status: "idle" };
    const environment = { ...emptyRefs(node), ...w.leaf,
      normalizeInterviewSessionBrief: (brief: unknown) => brief, persistInterviewSessionBrief: w.note("persistInterviewSessionBrief"),
      setState: (update: (previous: Record<string, unknown>) => Record<string, unknown>) => { state = update(state); w.note("setState")(Object.keys(state)); },
    } as Record<string, any>;
    environment.sessionRecordingManagerRef.current = w.recorder("recording");
    environment.contextManagerRef.current = w.recorder("context", { getState: () => ({ interviewSessionBrief: undefined, interviewSessionContext: undefined,
      screenObservations: [], taskRuntime: undefined, activeMeetingTask: undefined }) });
    const setBrief = evaluate(node, environment);
    setBrief({ company: PLANTED.deviceLabel, role: PLANTED.transcript, interviewTypes: ["coding", "system-design"] }, "focus-mode");
    setBrief(undefined);
  },
  entries: [
    ["info", "meeting.interview-brief brief-updated", {}, { uiSurface: "focus-mode", briefPresent: true, interviewTypeCount: 2 }],
    ["info", "meeting.interview-brief brief-updated", {}, { uiSurface: "normal-mode", briefPresent: false, interviewTypeCount: 0 }],
  ],
  sequence: [],
};

// Added (decisions A8, item 4). The Session Recording close: the manager's stop rejects, on a Stop of the meeting, on
// Quit, which asks for the error, and on a manual stop with the default reason. A stop that succeeds logs nothing.
const recordingClose: Scenario = {
  sites: ["meeting.recording close-failed"],
  async drive(w) {
    const node = hookCallback("stopSessionRecording");
    let state: Record<string, unknown> = { error: null, sessionRecording: { active: true, lifecycle: "active" } };
    let failing = true;
    const recording = { active: true, lifecycle: "active", sessionId: "session_recording_1", eventCount: 3, artifactCount: 0, lastError: undefined as string | undefined };
    const environment = { ...emptyRefs(node), ...w.leaf, setScriptedValidation: w.note("setScriptedValidation"),
      setState: (update: (previous: Record<string, unknown>) => Record<string, unknown>) => { state = update(state); w.note("setState")(state); },
    } as Record<string, any>;
    environment.sessionRecordingManagerRef.current = w.recorder("recording", {
      getState: () => ({ ...recording }),
      stop: async () => {
        if (!failing) return { active: false, lifecycle: "idle", eventCount: 0, artifactCount: 0 };
        Object.assign(recording, { active: false, lifecycle: "close-failed", lastError: NATIVE_PATH_ERROR });
        throw new Error(NATIVE_PATH_ERROR);
      } });
    const stop = evaluate(node, environment);
    w.note("returned")([await stop("meeting-assistant-stopped") ?? null]);
    await assert.rejects(stop("application-shutdown", { throwOnError: true }), (error: Error) => error.message === NATIVE_PATH_ERROR);
    w.note("rethrown")();
    w.note("returned")([await stop() ?? null]);
    failing = false;
    w.note("returned")([await stop("manual-close-retry", { throwOnError: true })]);
  },
  entries: (["meeting-assistant-stopped", "application-shutdown", "manual"] as const).map((reason) => ["error", "meeting.recording close-failed",
    { recordingSessionId: "session_recording_1" }, { reason, cause: causeOfError(NATIVE_PATH_ERROR) }]),
  sequence: [],
};

const SCENARIOS: Record<string, Scenario> = { traceStore, traceMetricsPersistence, captureLifecycle, nativeAudioListeners, nativeAudioListenerSetup, pause,
  missingProviderStop, audioQueues, rawZeroProbe, observedProjection, traceMetricsLoad, autoExport, sttEvaluationCapture, manualAction, interviewBrief,
  recordingClose };

// One run. The clock every fragment and library reads stands still, so that two runs record the same times.
async function run(scenario: Scenario, level: Level, delivery: DiagnosticLogSpyDelivery = "ok") {
  const w = world(level, delivery);
  const realNow = Date.now;
  Date.now = () => NOW;
  try { await scenario.drive(w); } finally { Date.now = realNow; }
  const entries = w.spy.entries();
  return { entries, sequence: plain(w.sequence) as Sequence, counters: w.spy.snapshot(), mirrored: w.spy.mirrored };
}

// The pinned sequences are data of their own, tests/fixtures/diagnostic-log-migration-sequences.ts, so that a scenario
// reads as code and its kept calls as a table.
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  assert.ok(name in MIGRATED_SEQUENCES, `${name} has a pinned sequence`);
  scenario.sequence = MIGRATED_SEQUENCES[name] as unknown as Sequence;
}
assert.deepEqual(Object.keys(MIGRATED_SEQUENCES).sort(), Object.keys(SCENARIOS).sort());

const migrated = DIAGNOSTIC_LOG_LEDGER.filter((row) => row.migration);
const tag = (row: { source: string; event: string }) => `${row.source} ${row.event}`;
const srcFiles = (() => {
  const files: string[] = [];
  const walk = (directory: string, pattern: RegExp) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file, pattern);
      else if (pattern.test(entry.name)) files.push(file.split(path.sep).join("/"));
    }
  };
  walk("src", /\.(ts|tsx)$/);
  walk("src-tauri/src", /\.rs$/);
  return files;
})();
const sourceOf = (() => { const cache = new Map<string, string>(); return (file: string) => cache.get(file) ?? cache.set(file, readFileSync(file, "utf8")).get(file)!; })();

test("LG7 the migration ledger names every migrated call site once, with what it printed before, what it still does and the test that drives it", () => {
  assert.equal(migrated.length, 33, "thirty-one prints and the two added entries");
  const byId: Record<string, number> = {};
  for (const row of migrated) byId[row.migration!.id] = (byId[row.migration!.id] ?? 0) + 1;
  assert.deepEqual(byId, { M1: 1, M2: 1, M3: 1, M4: 8, M5: 6, M6: 1, M7: 10, M8: 1, M10: 2, added: 2 });
  // The two added entries: a capture start that failed, on its two branches, and a Session Recording close that failed.
  assert.deepEqual(migrated.filter((row) => row.migration!.id === "added").map((row) => [tag(row), row.callSites ?? 1]),
    [["meeting.capture start-failed", 2], ["meeting.recording close-failed", 1]]);
  // The rows of commit 2 are summaries that replaced nothing.
  assert.equal(DIAGNOSTIC_LOG_LEDGER.length - migrated.length, 8);
  const driven = Object.values(SCENARIOS).flatMap((scenario) => scenario.sites);
  assert.equal(new Set(driven).size, driven.length, "a site belongs to one scenario");
  for (const row of migrated) {
    const { migration } = row;
    assert.ok(migration!.oldOutput.length > 0 && migration!.kept !== undefined, tag(row));
    if (migration!.test === THIS_TEST) assert.ok(driven.includes(tag(row)), `${tag(row)} is driven by a scenario of this file`);
    else {
      // Driven in the file of the harness that already ran that code: the file names the tag and the acceptance id.
      assert.equal(driven.includes(tag(row)), false, tag(row));
      const text = readFileSync(migration!.test, "utf8");
      assert.ok(text.includes("LG7") && text.includes(row.event) && text.includes("createDiagnosticLogSpy"), `${migration!.test} drives ${tag(row)}`);
    }
    if (row.levels.length > 1) assert.ok(migration!.levelBy, `${tag(row)}: the typed value its level is read from`);
  }
  assert.deepEqual(driven.filter((site) => !migrated.some((row) => tag(row) === site)), [], "every scenario site is a migrated row");
  // Nothing the rulings name is left out since A8: the recording close that failed has its entry, and the help text of
  // Log Level no longer names it as a gap.
  assert.deepEqual(DIAGNOSTIC_LOG_NOT_ADDED.map((row) => row.id), []);
  assert.equal(/no error entry yet/.test(sourceOf("src/pages/app/components/meeting/index.tsx").replace(/\s+/g, " ")), false);
});

for (const [name, scenario] of Object.entries(SCENARIOS)) {
  test(`LG7 ${name}: through its real call site, each entry has the level, tags and fields of the ledger (LG1) and nothing planted (LG4); the site's other calls are made as before, in order, at every level (LG2) and with every failing delivery (LG5)`, async () => {
    const reference = await run(scenario, "trace");
    assert.deepEqual(reference.entries.map(shown), scenario.entries, "the entries at trace");
    assert.deepEqual(reference.sequence, scenario.sequence, "the kept calls and the logger calls, in order");
    assert.deepEqual([...new Set(reference.entries.map(tag))].sort(), [...scenario.sites].sort(), "every site of the scenario logged");
    for (const entry of reference.entries) {
      assertEntryInLedger(entry);
      assert.equal(entry.at, NOW);
    }
    // One logger call per entry, and nothing refused, cut or failed on the way.
    assert.equal(reference.sequence.filter(([what]) => what === "logDiagnostic").length, reference.entries.length);
    const counters = reference.counters;
    assert.deepEqual([counters.refusedEntries, counters.refusedFields, counters.truncatedFields, counters.oversizeEntries, counters.detailFailures,
      counters.reentrantCalls, counters.internalErrors], [0, 0, 0, 0, 0, 0, 0]);
    // LG4 and A8: no provider error body, transcript sentence, answer sentence or key is in an entry or in its console
    // mirror; a path or a device label is in the field `cause` or nowhere.
    assertPlantedOnlyInCause(reference.entries, name);
    assertPlantedOnlyInCause(reference.mirrored.map((line) => line.entry), `${name} console mirror`);
    // An entry has a cause exactly when the ledger says its catch carries one, and then it is a text within the cut.
    for (const entry of reference.entries) {
      const carries = DIAGNOSTIC_LOG_LEDGER.find((row) => tag(row) === tag(entry))!.caught?.cause === true;
      assert.equal(typeof entry.data?.cause === "string", carries, `${tag(entry)}: cause`);
    }

    // LG2 and LG1: at every level the site does the same and logs exactly what passes that level.
    for (const level of DIAGNOSTIC_LOG_SPY_LEVELS) {
      const current = await run(scenario, level);
      assert.deepEqual(current.sequence, reference.sequence, `${level}: the same calls in the same order`);
      assert.deepEqual(current.entries.map(shown), scenario.entries.filter(([entryLevel]) => passes(level, entryLevel as Level)), `${level}: the entries that pass`);
      assert.equal(current.counters.filtered, scenario.entries.length - current.entries.length, `${level}: the rest were filtered before anything was built`);
    }
    // LG5: a delivery that rejects, never answers, answers something else or throws changes nothing at the site.
    for (const delivery of DIAGNOSTIC_LOG_SPY_FAILING_DELIVERIES) {
      const current = await run(scenario, "trace", delivery);
      assert.deepEqual(current.sequence, reference.sequence, `${delivery}: the same calls in the same order`);
      assert.deepEqual(current.entries.map(shown), scenario.entries, `${delivery}: the same entries were handed over`);
      assert.equal(current.counters.undeliveredEntries, scenario.entries.length, `${delivery}: none was delivered`);
    }
  });
}

test("LG1 M1: each of the nine store changes has the level A7 states, and an error status is never above debug", async () => {
  const { entries } = await run(traceStore, "trace");
  const seen = new Map(entries.map((entry) => [entry.data!.change as string, entry.level]));
  assert.deepEqual(Object.fromEntries(seen), TRACE_STORE_CHANGE_LEVELS);
  assert.deepEqual(TRACE_STORE_CHANGE_LEVELS, { "debug-mode": "info", "traces-cleared": "info", "trace-started": "debug", "step-finished": "debug",
    "trace-finished": "debug", "step-started": "trace", "input-recorded": "trace", "output-recorded": "trace", "trace-metadata-updated": "trace" });
  assert.deepEqual(entries.filter((entry) => entry.data!.status === "error").map((entry) => [entry.data!.change, entry.level]),
    [["step-finished", "debug"], ["trace-finished", "debug"]]);
  // The table the store reads is the one the ledger states.
  const store = sourceOf("src/lib/meeting/trace.ts");
  for (const [change, level] of Object.entries(TRACE_STORE_CHANGE_LEVELS)) assert.ok(store.includes(`"${change}": "${level}",`), change);
});

test("LG1 M3: each of the ten capture lifecycle stages has the level A7 states", async () => {
  const { entries } = await run(captureLifecycle, "trace");
  const seen = new Map(entries.map((entry) => [entry.data!.stage as string, entry.level]));
  assert.deepEqual([...seen.keys()].sort(), Object.keys(CAPTURE_LIFECYCLE_STAGE_LEVELS).sort(), "all ten stages were reported");
  for (const entry of entries) assert.equal(entry.level, CAPTURE_LIFECYCLE_STAGE_LEVELS[entry.data!.stage as keyof typeof CAPTURE_LIFECYCLE_STAGE_LEVELS], String(entry.data!.stage));
  assert.deepEqual(Object.entries(CAPTURE_LIFECYCLE_STAGE_LEVELS).filter(([, level]) => level !== "debug"),
    [["claimed", "info"], ["finished", "info"], ["stale-cleanup-failed", "warn"]]);
  // The stages are the type's: the union in the coordinator's module has these ten members and no other.
  const union = /export type CaptureLifecycleEventStage =([^;]+);/.exec(sourceOf("src/lib/meeting/capture-lifecycle.ts"))![1]!;
  assert.deepEqual([...union.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort(), Object.keys(CAPTURE_LIFECYCLE_STAGE_LEVELS).sort());
});

test("LG1 M4: rejected and observed events are debug; a dropped segment is warn when authorized and debug when not; lifecycle started and stopped are info, error is warn and any unauthorized event debug; a failed acknowledgement is warn and a failed setup error", async () => {
  const { entries } = await run(nativeAudioListeners, "trace");
  const levels = (event: string, key: (entry: Entry) => string) => Object.fromEntries(entries.filter((entry) => entry.event === event).map((entry) => [key(entry), entry.level]));
  for (const event of ["liveness-rejected", "speech-start-rejected", "speech-segment-rejected", "speech-segment-observed"]) {
    assert.deepEqual([...new Set(entries.filter((entry) => entry.event === event).map((entry) => entry.level))], ["debug"], event);
  }
  assert.deepEqual(levels("segment-dropped", (entry) => `authorized=${entry.data!.authorized}`), { "authorized=false": "debug", "authorized=true": "warn" });
  assert.deepEqual(levels("lifecycle-event", (entry) => `${entry.data!.authorized ? "authorized" : "unauthorized"} ${entry.data!.eventType ?? "unreadable"}`),
    { "unauthorized unreadable": "debug", "unauthorized error": "debug", "authorized started": "info", "authorized stopped": "info", "authorized error": "warn" });
  assert.deepEqual(levels("stall-marker-ack-failed", () => "ack"), { ack: "warn" });
  assert.deepEqual((await run(nativeAudioListenerSetup, "trace")).entries.map((entry) => entry.level), ["error"]);
});

test("LG1 M2, M5, M6, M7, M8, M10 and the added entries: the levels of the ledger are the ones A7 and A8 state", async () => {
  const levelsOf = (id: string) => Object.fromEntries(migrated.filter((row) => row.migration!.id === id).map((row) => [row.event, [...row.levels].sort().join("/")]));
  assert.deepEqual(levelsOf("M2"), { "persist-failed": "debug/warn" });
  assert.deepEqual(levelsOf("M5"), { "stop-native-failed": "warn", "meeting-stop-failed": "warn", "missing-provider-stop-failed": "warn",
    "pause-native-failed": "warn", "system-segment-failed": "warn", "microphone-segment-failed": "warn" });
  // A8, item 2: the raw-zero probe report is info for its four action stages and debug for the others.
  assert.deepEqual(levelsOf("M6"), { "probe-observed": "debug/info" });
  assert.deepEqual(Object.entries(RAW_ZERO_PROBE_STAGE_LEVELS).filter(([, level]) => level === "info").map(([stage]) => stage).sort(),
    ["native-restart-completed", "native-restart-started", "requested", "signal-restored"]);
  assert.deepEqual([...RAW_ZERO_PROBE_ACTION_STAGES].sort(), ["native-restart-completed", "native-restart-started", "requested", "signal-restored"]);
  assert.equal(Object.keys(RAW_ZERO_PROBE_STAGE_LEVELS).length, 13);
  // Through the real report: each stage the scenario reports has that level, the four action stages among them.
  const probe = (await run(rawZeroProbe, "trace")).entries;
  for (const entry of probe) assert.equal(entry.level, RAW_ZERO_PROBE_STAGE_LEVELS[entry.data!.stage as keyof typeof RAW_ZERO_PROBE_STAGE_LEVELS], String(entry.data!.stage));
  assert.deepEqual(probe.filter((entry) => entry.level === "info").map((entry) => entry.data!.stage),
    ["requested", "native-restart-started", "native-restart-completed", "signal-restored"]);
  // At the default level the run log of the probe is those four entries, with or without a recording.
  assert.deepEqual((await run(rawZeroProbe, "info")).entries.map((entry) => entry.data!.stage),
    ["requested", "native-restart-started", "native-restart-completed", "signal-restored"]);
  // The level is read from the stage argument alone: the four literals, compared in the first argument of the one logger call.
  const probeCall = one(collect(hookCallback("reportRawZeroProbe"), (node): node is ts.CallExpression => ts.isCallExpression(node) &&
    node.expression.getText(hook) === "logDiagnostic"), "logger call of the report");
  const levelArgument = probeCall.arguments[0]!;
  assert.deepEqual(collect(levelArgument, ts.isIdentifier).map((identifier) => identifier.text), ["stage", "stage", "stage", "stage"]);
  assert.deepEqual(collect(levelArgument, ts.isStringLiteralLike).map((literal) => literal.text),
    ["requested", "native-restart-started", "native-restart-completed", "signal-restored", "info", "debug"]);
  assert.deepEqual(levelsOf("M7"), { "persistence-failed": "error", "recording-closed-before-mirror": "warn", "observed-projection-persist-failed": "warn",
    "load-failed": "warn", "auto-export-failed": "warn", "initialize-failed": "warn", "refresh-failed": "debug", "authorization-stop-failed": "warn",
    "update-failed": "warn", "delete-failed": "warn" });
  assert.deepEqual(levelsOf("M8"), { "request-failed": "warn" });
  assert.deepEqual(levelsOf("M10"), { "type-correction-recorded": "info", "brief-updated": "info" });
  assert.deepEqual(levelsOf("added"), { "start-failed": "error", "close-failed": "error" });
});

test("LG7 static: the old prints and the string IPC are gone, the not-migrated prints are where they were, and nothing bans a console call", () => {
  // No source file names the retired command: not as a call, a registration or a definition.
  assert.deepEqual(srcFiles.filter((file) => sourceOf(file).includes("write_meeting_trace_log")), []);
  const contract = JSON.parse(readFileSync("architecture/architecture-contract.json", "utf8")) as { ipc: Record<string, string[]> };
  for (const list of ["registeredCommands", "staticFrontendInvokes"]) {
    assert.equal(contract.ipc[list]!.includes("write_meeting_trace_log"), false, list);
    assert.ok(contract.ipc[list]!.includes("write_diagnostic_log") && contract.ipc[list]!.includes("write_preparation_trace_log"), list);
  }
  // The fixed text of each old print is in no frontend source file.
  const frontend = srcFiles.filter((file) => file.startsWith("src/"));
  for (const row of migrated) for (const text of row.migration!.removedText) {
    assert.deepEqual(frontend.filter((file) => sourceOf(file).includes(text)), [], `${tag(row)}: ${text}`);
  }
  // The console calls that are left in the Hook are the not-migrated ones, and the trace store has none.
  const consoleCalls = (file: string) => {
    const source = ts.createSourceFile(file, sourceOf(file), ts.ScriptTarget.Latest, true);
    return collect(source, (node): node is ts.CallExpression => ts.isCallExpression(node) && /^console\.\w+$/.test(node.expression.getText(source)))
      .map((call) => `${call.expression.getText(source)} ${call.arguments[0]?.getText(source).split("\n")[0] ?? ""}`.trim());
  };
  assert.deepEqual(consoleCalls(HOOK), ['console.warn "Meeting task runtime transition rejected"', 'console.warn "Meeting task runtime clear rejected"',
    'console.warn "Failed to retrieve meeting memory context"', 'console.warn "Screen preflight failed; continuing without it"']);
  assert.deepEqual(consoleCalls("src/lib/meeting/trace.ts"), []);
  // What this commit leaves as it is, is still there.
  for (const row of DIAGNOSTIC_LOG_NOT_MIGRATED) for (const [file, text] of row.present) {
    assert.ok(sourceOf(file).includes(text), `${row.id}: ${file} still has ${text}`);
  }
  // The two prints inside the realtime audio callback are as they were.
  assert.equal(sourceOf("src-tauri/src/speaker/macos.rs").split("eprintln!(").length - 1, 2);
  assert.equal(/logDiagnostic|diagnostic_log|tracing::(?:warn|info|debug|trace)!/.test(sourceOf("src-tauri/src/speaker/macos.rs")), false);
  // No lint rule or gate bans a console call.
  const packageJson = readFileSync("package.json", "utf8");
  assert.equal(/no-console/.test(packageJson), false);
  for (const file of readdirSync(".").filter((name) => /eslint/i.test(name))) assert.equal(/no-console/.test(readFileSync(file, "utf8")), false, file);
});

test("LG4 static: the texts the entries carry are fixed in the source: every trace step name is a label written there, every lifecycle detail and probe stage a code of the ledger", () => {
  const literalsOf = (node: ts.Expression | undefined, at: ts.Node): string[] => {
    if (!node) return assert.fail(`no argument at line ${hook.getLineAndCharacterOfPosition(at.getStart(hook)).line + 1}`);
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isConditionalExpression(node)) return [...literalsOf(node.whenTrue, at), ...literalsOf(node.whenFalse, at)];
    if (ts.isIdentifier(node)) {
      // A constant of the same callback, itself made of literals.
      const declarations = collect(hook, (child): child is ts.VariableDeclaration => ts.isVariableDeclaration(child) && child.name.getText(hook) === node.text &&
        child.initializer !== undefined && (ts.isConditionalExpression(child.initializer) || ts.isStringLiteralLike(child.initializer)));
      if (declarations.length > 0) return declarations.flatMap((declaration) => literalsOf(declaration.initializer, at));
    }
    return [`<${node.getText(hook).slice(0, 60)}>`];
  };
  const calls = (method: string) => collect(hook, (node): node is ts.CallExpression => ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === method);
  // Trace step names: the store's `step` field. The Hook is the store's only user.
  assert.deepEqual(srcFiles.filter((file) => file.startsWith("src/") && sourceOf(file).includes("MeetingTraceStore")).sort(), [HOOK, "src/lib/meeting/trace.ts"]);
  const steps = [...new Set(calls("startStep").flatMap((call) => literalsOf(call.arguments[1], call)))];
  assert.ok(steps.length > 60, `${steps.length} step names`);
  for (const step of steps) assert.match(step, LABEL, `step name ${step}`);
  // Every one of them passes the real logger as it is, in the store's projection.
  const spy = createDiagnosticLogSpy({ threshold: "trace", now: () => NOW });
  for (const step of steps) spy.logDiagnostic("trace", "meeting.trace", "store-event", () => ({ refs: { traceId: "voice_trace_1" },
    data: { change: "step-started", step, metadataKeys: 1 } }));
  assert.deepEqual(spy.entries().map((entry) => entry.data!.step), steps);
  assert.deepEqual([spy.snapshot().refusedFields, spy.snapshot().truncatedFields], [0, 0]);
  // Capture lifecycle details: the second argument of every coordinator call that reports one.
  const details = [...new Set(["authorize", "recordNativeCompletion", "cleanupStale"].flatMap((method) => calls(method)
    .filter((call) => /coordinator/i.test((call.expression as ts.PropertyAccessExpression).expression.getText(hook)))
    .flatMap((call) => literalsOf(call.arguments[1], call))))];
  assert.deepEqual(details.sort(), [...CAPTURE_LIFECYCLE_DETAILS].sort());
  // Raw-zero probe stages: eight literals, and the episode disposition of the one caller that passes it.
  const stages = collect(hook, (node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(hook) === "reportRawZeroProbe")
    .map((call) => (ts.isStringLiteralLike(call.arguments[0]!) ? call.arguments[0].text : `<${call.arguments[0]!.getText(hook)}>`));
  assert.deepEqual([...new Set(stages)].sort(), [...RAW_ZERO_PROBE_STAGES.slice(0, 8), "<disposition>"].sort());
  const dispositions = [...sourceOf("src/lib/meeting/audio-input-liveness.ts").matchAll(/"(waiting|probe-used|screen-wait|screen-deferred|probe-ready)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(dispositions)].sort(), ["probe-ready", "probe-used", "screen-deferred", "screen-wait", "waiting"]);
  // Reported only with a warning, so never "waiting"; "inactive" is the Hook's own value for a capture that is not active.
  assert.deepEqual([...RAW_ZERO_PROBE_STAGES.slice(8)].sort(), ["inactive", "probe-ready", "probe-used", "screen-deferred", "screen-wait"]);
});

test("LG4 static M6: the probe report's entry reads the capture, the Screen operation and the episode itself, and from a caller only typed identifiers, counts and one flag, by name", () => {
  // What a caller may add: the members of one type, each an identifier, a count or a flag.
  const metadataType = one(collect(hook, (node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === "RawZeroProbeReportMetadata"),
    "RawZeroProbeReportMetadata");
  assert.deepEqual(metadataType.members.map((member) => `${member.name!.getText(hook)}${(member as ts.PropertySignature).questionToken ? "?" : ""}: ${(member as ts.PropertySignature).type!.getText(hook)}`),
    ["recoveryAttemptId?: string", "operationId?: number", "previousCaptureSessionId?: string", "previousCaptureGeneration?: number", "signalRestored?: boolean",
      "snapshotSequence?: number", "screenOperationId?: string", "disposition?: string"]);
  assert.deepEqual(metadataType.members.map((member) => member.name!.getText(hook)), [...RAW_ZERO_PROBE_METADATA_KEYS]);
  const reporter = hookCallback("reportRawZeroProbe") as ts.ArrowFunction;
  assert.deepEqual(reporter.parameters.map((parameter) => parameter.type!.getText(hook)), ["string", "RawZeroProbeReportMetadata"]);
  // Every caller passes an object written there, with those keys alone: no spread, no computed key, and none of the keys the report sets itself.
  const reports = collect(hook, (node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(hook) === "reportRawZeroProbe");
  assert.ok(reports.length > 0);
  const passed = new Set<string>();
  for (const call of reports) {
    const line = hook.getLineAndCharacterOfPosition(call.getStart(hook)).line + 1;
    assert.ok(call.arguments.length === 2 && ts.isObjectLiteralExpression(call.arguments[1]!), `line ${line}: the metadata is an object literal`);
    for (const property of (call.arguments[1] as ts.ObjectLiteralExpression).properties) {
      assert.ok((ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && ts.isIdentifier(property.name), `line ${line}: a plain key`);
      assert.ok((RAW_ZERO_PROBE_METADATA_KEYS as readonly string[]).includes(property.name.text), `line ${line}: ${property.name.text}`);
      passed.add(property.name.text);
    }
  }
  assert.deepEqual([...passed].sort(), [...RAW_ZERO_PROBE_METADATA_KEYS].sort(), "every key of the type has a caller");
  // The entry: nothing is read from the merged observation, and from the metadata only by name, never the caller's disposition (that is the stage).
  const detail = one(collect(reporter, (node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(hook) === "logDiagnostic"),
    "logger call of the report").arguments[3]!;
  assert.ok(ts.isArrowFunction(detail));
  const names = collect(detail, ts.isIdentifier).map((identifier) => identifier.text);
  assert.equal(names.includes("observation"), false, "the merged observation is not read");
  const metadataReads = collect(detail, (node): node is ts.PropertyAccessExpression => ts.isPropertyAccessExpression(node) && node.expression.getText(hook) === "metadata")
    .map((access) => access.name.text);
  assert.deepEqual(metadataReads.sort(), RAW_ZERO_PROBE_METADATA_KEYS.filter((key) => key !== "disposition").sort());
  assert.equal(names.filter((name) => name === "metadata").length, metadataReads.length, "the metadata is read by name alone: it is not spread or passed on");
  // The episode is read without the Screen state, so its disposition is never "screen-deferred".
  assert.equal(reporter.getText(hook).split("rawZeroInputEpisodeRef.current.read(Date.now(), false)").length - 1, 1);
  assert.deepEqual([...RAW_ZERO_EPISODE_DISPOSITIONS].sort(), ["probe-ready", "probe-used", "screen-wait", "waiting"]);
});

// Decisions A8, item 1. A migrated catch used to print the error it caught, and for most of them that print was the
// only copy of the cause. Which catches carry the cause now, which two do not, and why.
test("LG7 and A8 the catches that no longer print the error they caught: each one that guards a native command or local persistence carries the bounded cause, made from the caught value inside the lazy detail; the two that guard the speech-to-text provider path bind no error and carry none", () => {
  // The handler a logger call sits in, without crossing another function: a `catch` clause, which guards its try block,
  // or the function given to `.catch(`, which guards the promise chain before it.
  const caughtBy = (call: ts.CallExpression): { binding: string | undefined; guard: ts.Node } | undefined => {
    for (let current: ts.Node | undefined = call.parent; current; current = current.parent) {
      if (ts.isCatchClause(current)) return { binding: current.variableDeclaration?.name.getText(hook), guard: (current.parent as ts.TryStatement).tryBlock };
      if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
        const parent = current.parent;
        const isCatchHandler = ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression) && parent.expression.name.text === "catch" &&
          parent.arguments[0] === current;
        return isCatchHandler ? { binding: current.parameters[0]?.name.getText(hook), guard: (parent.expression as ts.PropertyAccessExpression).expression } : undefined;
      }
      if (ts.isFunctionLike(current)) return undefined;
    }
    return undefined;
  };
  const calls = collect(hook, (node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(hook) === "logDiagnostic");
  const compact = (text: string) => text.replace(/\s+/g, "");

  // The provider path, as far as names show it. The shared provider function layer sends a request through three
  // functions. A function or class of the meeting library is on the provider path when it names one of them, or names
  // one that is on it; a Hook callback, when it names one of those or a Hook callback that is. Names are compared as
  // names, so this errs towards more of the Hook being on the path.
  const LAYER = ["fetchAIResponse", "fetchAIResponseEvents", "fetchSTT"];
  const layerExports = ["src/lib/functions/ai-response.function.ts", "src/lib/functions/stt.function.ts"].flatMap((file) =>
    [...sourceOf(file).matchAll(/^export async function\*? (\w+)\(/gm)].map((match) => match[1]!));
  assert.deepEqual(layerExports.sort(), LAYER);
  const identifiersOf = (node: ts.Node) => new Set(collect(node, ts.isIdentifier).map((identifier) => identifier.text));
  // Grows `path` until nothing is added: name -> the name that puts it on the path.
  const close = (declared: Map<string, Set<string>>, path: Map<string, string>, onPath: (name: string) => boolean) => {
    for (let grew = true; grew;) {
      grew = false;
      for (const [name, names] of declared) {
        if (path.has(name)) continue;
        const through = [...names].find((other) => other !== name && (onPath(other) || path.has(other)));
        if (through !== undefined) { path.set(name, through); grew = true; }
      }
    }
    return path;
  };
  const library = new Map<string, Set<string>>();
  for (const file of srcFiles.filter((candidate) => /^src\/lib\/meeting\/[^/]+\.ts$/.test(candidate))) {
    const source = ts.createSourceFile(file, sourceOf(file), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      const declarations: Array<[string, ts.Node]> = [];
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) declarations.push([statement.name.text, statement]);
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) ||
          ts.isFunctionExpression(declaration.initializer))) declarations.push([declaration.name.text, declaration.initializer]);
      }
      for (const [name, node] of declarations) library.set(name, new Set([...(library.get(name) ?? []), ...identifiersOf(node)]));
    }
  }
  const libraryPath = close(library, new Map(), (name) => LAYER.includes(name));
  // The functions the Hook itself calls for a request are among them: speech to text, the Screen preflight and solver,
  // and the request functions of the model operations.
  for (const name of ["transcribeMeetingAudio", "preflightScreenObservation", "solveScreenAnchoredTask", "requestTaskRelationProviderCandidates",
    "requestMeetingMetadataInference", "requestFactRiskReview", "AdvisorEngine"]) assert.ok(libraryPath.has(name), `${name} is on the provider path`);
  // What a Hook callback names. A handler given to `listen` is left out of the callback that registers it: it runs when
  // native emits its event, and its failure is not a failure of the registration.
  const hookNames = (root: ts.Node) => {
    const names = new Set<string>();
    const visit = (node: ts.Node) => {
      if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isCallExpression(node.parent) && node.parent.arguments.includes(node) &&
        /^listen\b/.test(node.parent.expression.getText(hook))) return;
      if (ts.isIdentifier(node)) names.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(root);
    return names;
  };
  const callbacks = new Map<string, Set<string>>();
  for (const declaration of collect(hook, (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
    node.initializer !== undefined && ((ts.isCallExpression(node.initializer) && node.initializer.expression.getText(hook) === "useCallback") ||
      ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))) {
    const body = ts.isCallExpression(declaration.initializer!) ? declaration.initializer.arguments[0]! : declaration.initializer!;
    callbacks.set(declaration.name.getText(hook), new Set([...(callbacks.get(declaration.name.getText(hook)) ?? []), ...hookNames(body)]));
  }
  const onLibraryPath = (name: string) => LAYER.includes(name) || libraryPath.has(name);
  const hookPath = close(callbacks, new Map(), onLibraryPath);
  assert.ok(hookPath.size >= 20, `${hookPath.size} Hook callbacks are on the provider path: the closure is not empty`);
  for (const name of ["processQueuedSpeechSegment", "runAdvisor", "captureScreenContext"]) assert.ok(hookPath.has(name), `${name} is on the provider path`);
  const providerPathOf = (guard: ts.Node) => [...hookNames(guard)].filter((name) => onLibraryPath(name) || hookPath.has(name)).map((name) => {
    const chain = [name];
    for (let current = name; hookPath.has(current) || libraryPath.has(current);) { current = (hookPath.get(current) ?? libraryPath.get(current))!; chain.push(current); }
    return chain.join(" -> ");
  });

  const withCause: string[] = [];
  const withoutCause: string[] = [];
  for (const row of DIAGNOSTIC_LOG_LEDGER.filter((candidate) => candidate.file === HOOK)) {
    const rowCalls = calls.filter((candidate) => ts.isStringLiteralLike(candidate.arguments[1]!) && candidate.arguments[1].text === row.source &&
      ts.isStringLiteralLike(candidate.arguments[2]!) && candidate.arguments[2].text === row.event);
    assert.equal(rowCalls.length, row.callSites ?? 1, `call sites of ${tag(row)}`);
    const caught = rowCalls.map((call) => ({ call, handler: caughtBy(call) })).filter((site) => site.handler !== undefined);
    const causeProperties = (call: ts.CallExpression) => collect(call, (node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) &&
      node.name.getText(hook) === "cause").map((property) => property.initializer.getText(hook));
    if (!row.caught) {
      // Not in a catch: nothing was caught, so the entry has no cause made from an error.
      assert.equal(caught.length, 0, `${tag(row)} does not sit in a catch`);
      for (const call of rowCalls) assert.equal(causeProperties(call).some((value) => value.includes("diagnosticLogCause")), false, tag(row));
      assert.notEqual(row.data.cause, "bounded-text", tag(row));
      continue;
    }
    // One call of the row sits in a catch. (The capture start has a second call, on the branch that catches nothing.)
    assert.equal(caught.length, 1, `${tag(row)}: one call in a catch`);
    const { call, handler } = caught[0]!;
    // What the ledger says the catch guards is what its try block or its promise chain calls.
    const guarded = compact(handler!.guard.getText(hook));
    assert.ok(row.caught.guards.length > 0, tag(row));
    for (const text of row.caught.guards) assert.ok(guarded.includes(compact(text)), `${tag(row)} guards ${text}`);
    if (row.caught.cause) {
      if (row.caught.safeCode) {
        assert.deepEqual(causeProperties(call), [JSON.stringify(row.caught.safeCode)], tag(row));
        assert.deepEqual(row.data.cause, [row.caught.safeCode], tag(row));
        assert.equal(collect(call, (node): node is ts.Identifier => ts.isIdentifier(node) &&
          node.text === handler!.binding).length, 0, `${tag(row)} does not read the caught value`);
        assert.deepEqual(providerPathOf(handler!.guard), [], tag(row));
        withCause.push(tag(row));
        continue;
      }
      // The catch binds the error, and its one use inside the logger call is `cause: diagnosticLogCause(<error>)`, in
      // the function given as the detail: nothing is summarised for an entry that is filtered.
      assert.ok(handler!.binding, `${tag(row)} binds the error`);
      assert.deepEqual(causeProperties(call), [`diagnosticLogCause(${handler!.binding})`], tag(row));
      const detail = call.arguments[3]!;
      assert.ok(ts.isArrowFunction(detail), `${tag(row)}: a lazy detail`);
      assert.deepEqual(collect(call, (node): node is ts.Identifier => ts.isIdentifier(node) && node.text === handler!.binding).map((use) =>
        use.getStart(hook) > detail.getStart(hook) && use.getEnd() <= detail.getEnd()), [true], `${tag(row)}: the error is read once, inside the detail`);
      assert.equal(row.data.cause, "bounded-text", tag(row));
      assert.ok(row.knownLimits?.includes(CAUSE_LIMIT), `${tag(row)} states the limit of a cause`);
      // Why it may: what it guards is a native command or local persistence, and neither that code nor any Hook
      // callback or library function it names, however far, names a function that sends a request to a provider.
      assert.deepEqual(providerPathOf(handler!.guard), [], `${tag(row)} guards no provider request`);
      withCause.push(tag(row));
    } else {
      // The catch does not bind the error at all: no part of it can reach the entry.
      assert.equal(handler!.binding, undefined, `${tag(row)} binds nothing`);
      assert.deepEqual(causeProperties(call), [], tag(row));
      assert.equal("cause" in row.data, false, tag(row));
      assert.ok(row.knownLimits?.includes(NO_CAUSE_ON_PROVIDER_PATH), `${tag(row)} states why it has no cause`);
      // Why it may not: the chain it guards runs the queued-segment processor, which awaits the speech-to-text provider.
      assert.deepEqual(providerPathOf(handler!.guard), ["processQueuedSpeechSegment -> transcribeMeetingAudio -> fetchSTT"], tag(row));
      withoutCause.push(tag(row));
    }
  }
  assert.deepEqual(withoutCause.sort(), ["meeting.audio-queue microphone-segment-failed", "meeting.audio-queue system-segment-failed"]);
  assert.deepEqual(withCause.sort(), ["meeting.capture missing-provider-stop-failed", "meeting.capture pause-native-failed", "meeting.capture start-failed",
    "meeting.capture stop-native-failed", "meeting.evaluation observed-projection-persist-failed", "meeting.evaluation persistence-failed",
    "meeting.native-audio listener-setup-failed", "meeting.native-audio stall-marker-ack-failed", "meeting.native-stall-diagnostics request-failed",
    "meeting.recording close-failed", "meeting.stt-evaluation-capture authorization-stop-failed", "meeting.stt-evaluation-capture delete-failed",
    "meeting.stt-evaluation-capture initialize-failed", "meeting.stt-evaluation-capture meeting-stop-failed", "meeting.stt-evaluation-capture refresh-failed",
    "meeting.stt-evaluation-capture update-failed", "meeting.trace-export auto-export-failed", "meeting.trace-metrics load-failed",
    "meeting.trace-metrics persist-failed"]);
  // The ledger rows with a caught error are these twenty-one, and no other row has a bounded text.
  assert.deepEqual(DIAGNOSTIC_LOG_LEDGER.filter((row) => row.caught).map(tag).sort(), [...withCause, ...withoutCause].sort());
  const rawCauseSites = DIAGNOSTIC_LOG_LEDGER.filter(row => row.caught?.cause && !row.caught.safeCode).map(tag).sort();
  assert.deepEqual(DIAGNOSTIC_LOG_LEDGER.filter((row) => Object.values(row.data).includes("bounded-text")).map(tag).sort(), rawCauseSites);
  assert.equal(rawCauseSites.length, 17);
  // The summary function is named in the Hook by its import and those seventeen source-reviewed calls, and by no other source file
  // but the leaf that declares it: the trace store and the provider layer never summarise an error for the log.
  assert.equal(collect(hook, (node): node is ts.Identifier => ts.isIdentifier(node) && node.text === "diagnosticLogCause").length, rawCauseSites.length + 1);
  assert.deepEqual(srcFiles.filter((file) => file.startsWith("src/") && sourceOf(file).includes("diagnosticLogCause")).sort(),
    [HOOK, "src/lib/meeting/diagnostic-log.ts"]);
  // The two that rethrow do so under Quit, where the shutdown owner receives the error; the recording close rethrows
  // when its caller asked for the error.
  assert.deepEqual(migrated.filter((row) => row.migration!.kept.includes("the rethrow under Quit")).map(tag).sort(),
    ["meeting.capture stop-native-failed", "meeting.stt-evaluation-capture meeting-stop-failed"]);
  // The reason of a recording close is a fixed code: every caller of the Hook's stop in src passes one of the five, or
  // none, which is the default.
  const stopCalls = srcFiles.filter((file) => file.startsWith("src/")).flatMap((file) => {
    const source = file === HOOK ? hook : ts.createSourceFile(file, sourceOf(file), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    return collect(source, (node): node is ts.CallExpression => ts.isCallExpression(node) && /^(?:stopSessionRecording|onSessionRecordingStop)$/.test(node.expression.getText(source)))
      .map((call) => (call.arguments[0] === undefined ? "<default>" : ts.isStringLiteralLike(call.arguments[0]) ? call.arguments[0].text : `<${call.arguments[0].getText(source)}>`));
  });
  assert.deepEqual(stopCalls.sort(), ["application-shutdown", "manual", "manual-close-retry", "meeting-assistant-stopped", "scenario-runner-stopped"]);
  assert.deepEqual([...RECORDING_STOP_REASONS].sort(), [...new Set(stopCalls)].sort());
  assert.match(hookCallback("stopSessionRecording").getText(hook), /reason = "manual",/);
});

// Decisions A8, item 1: `cause` is a string data value like any other, so the logger's shape backstop applies to it.
// Driven through a real catch: the trace metrics read at mount, whose native command rejects with each text.
test("LG4 and A8 the cause at a real catch: a path and a device label are written in cause; a credential-shaped error leaves the field out and keeps the entry, also when the cut would divide the credential; a long error is cut at 160; the site does the same in every case", async () => {
  const load = async (failure: unknown) => {
    const { entries, sequence, counters, mirrored } = await run(traceMetricsLoadFailing(failure, []), "trace");
    assert.deepEqual(sequence, MIGRATED_SEQUENCES.traceMetricsLoad, "the site's other calls, in order");
    assert.equal(entries.length, 1);
    assertEntryInLedger(entries[0]!);
    assert.deepEqual(mirrored.map((line) => line.entry), entries, "the console mirror holds the same entry");
    return { entry: entries[0]!, counters };
  };
  // A path and a device label: in cause, whole.
  const named = await load(`${NATIVE_PATH_ERROR} on ${PLANTED.deviceLabel}`);
  assert.deepEqual(named.entry.data, { cause: `${NATIVE_PATH_ERROR} on ${PLANTED.deviceLabel}` });
  for (const value of PLANTED_IN_CAUSE_ONLY) assert.ok((named.entry.data!.cause as string).includes(value));
  assert.deepEqual([named.counters.refusedFields, named.counters.truncatedFields], [0, 0]);
  // A credential-shaped message, as an Error and as the string the bridge rejects with: no cause, the entry is kept, and
  // the logger counts one refused field.
  const CREDENTIALS = [
    `request to https://api.example.test/v1/audio failed: Authorization: Bearer ${PLANTED.secret}`,
    `provider answered 401 for api_key=${PLANTED.secret}`,
    `could not open ${PLANTED.filePath}: last request used ${PLANTED.secret}`,
  ];
  for (const text of CREDENTIALS) for (const failure of [new Error(text), text]) {
    const refused = await load(failure);
    assert.deepEqual([refused.entry.level, refused.entry.event, refused.entry.data], ["warn", "load-failed", undefined], text);
    assert.equal(refused.counters.refusedFields, 1, text);
    assertNothingPlanted([refused.entry], PLANTED_VALUES, text);
  }
  // A credential the cut at 160 would divide: its first part is not left behind. The key starts ten characters before
  // the cut, so a plain cut would keep `sk-PLANTED` and lose the rest.
  // (The text before it is words: one unbroken run of 96 characters would be refused as an encoded blob on its own.)
  const lead = "the retry failed ".repeat(12).slice(0, CAUSE_CHARS - 10 - " key ".length);
  const straddling = await load(`${lead} key ${PLANTED.secret} and more`);
  assert.equal(`${lead} key ${PLANTED.secret}`.slice(0, CAUSE_CHARS).endsWith(" key sk-PLANTED"), true, "the cut falls inside the key");
  assert.deepEqual([straddling.entry.data, straddling.counters.refusedFields], [undefined, 1]);
  assert.equal(JSON.stringify(straddling.entry).includes("sk-PLANTED"), false);
  // A long error with no restricted shape: cut at 160 by the summary itself, so the logger cuts nothing.
  const long = `${NATIVE_PATH_ERROR}; ${"then the retry failed as well; ".repeat(12)}`;
  const cut = await load(new Error(long));
  assert.equal(cut.entry.data!.cause, `Error: ${long}`.slice(0, CAUSE_CHARS));
  assert.deepEqual([(cut.entry.data!.cause as string).length, cut.counters.truncatedFields, cut.counters.refusedFields], [CAUSE_CHARS, 0, 0]);
  // A value that cannot be read as text gives the leaf's fixed word, and the catch goes on.
  const unreadable = await load(Object.create(null));
  assert.deepEqual(unreadable.entry.data, { cause: "unreadable" });
  // What the provider path can carry is in no entry: the two queued-segment entries have no cause at all.
  const queued = await run(audioQueues, "trace");
  assert.deepEqual(queued.entries.map((entry) => [tag(entry), Object.keys(entry.data ?? {})]),
    [["meeting.audio-queue system-segment-failed", ["segmentSequence"]], ["meeting.audio-queue microphone-segment-failed", ["segmentSequence"]]]);
  assertNothingPlanted(queued.entries, [...PLANTED_NOWHERE, ...PLANTED_IN_CAUSE_ONLY], "queued segments");
});

test("LG4 M1: the projection carries no metadata value, error text, recorded value or label at any level, whatever the trace holds", async () => {
  for (const level of DIAGNOSTIC_LOG_SPY_LEVELS) {
    const { entries, sequence } = await run(traceStore, level);
    for (const entry of entries) {
      assert.deepEqual(Object.keys(entry).sort(), entry.refs ? ["at", "data", "event", "level", "refs", "source", "v"] : ["at", "data", "event", "level", "source", "v"]);
      for (const [key, value] of Object.entries(entry.data!)) {
        // A count, a duration, a flag, or one of the store's own fixed words.
        if (typeof value === "string") assert.ok(["change", "kind", "status", "step"].includes(key), `${level}: ${key}`);
        else assert.ok(typeof value === "number" || typeof value === "boolean", `${level}: ${key}`);
      }
    }
    assertNothingPlanted(entries, PLANTED_VALUES, `M1 at ${level}`);
    // The store itself holds every planted value: the projection, not the input, is what keeps them out.
    const content = JSON.stringify(sequence.filter(([what]) => what === "store.content"));
    for (const value of PLANTED_VALUES) assert.ok(content.includes(value), `the store holds ${value.slice(0, 16)}`);
  }
});

test("LG4 M1: a change below the level builds no projection: the store calls it only inside the logger's detail, and a filtered change does not count its metadata", () => {
  // Static: `log` calls its projection once, inside the function it gives the logger as the detail, and every caller of `log` passes a function.
  const text = sourceOf("src/lib/meeting/trace.ts");
  const source = ts.createSourceFile("trace.ts", text, ts.ScriptTarget.Latest, true);
  const log = one(collect(source, (node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(source) === "log"), "the store's log method");
  const detail = one(collect(log, (node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(source) === "logDiagnostic"),
    "logger call").arguments[3]!;
  assert.ok(ts.isArrowFunction(detail), "the detail is a function");
  const projections = collect(log, (node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(source) === "project");
  assert.equal(projections.length, 1, "one call of the projection");
  assert.ok(projections[0]!.getStart(source) > detail.getStart(source) && projections[0]!.getEnd() <= detail.getEnd(), "inside the detail");
  // `project` is named twice in `log`: as its parameter and in that one call. Nothing else reads it.
  assert.equal(collect(log, (node): node is ts.Identifier => ts.isIdentifier(node) && node.text === "project").length, 2);
  const logCalls = collect(source, (node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(source) === "this.log");
  assert.equal(logCalls.length, 9, "the nine changes");
  // Each projection is an object written inside its function, so it is built when the function is called and not before.
  for (const call of logCalls) {
    const projection = call.arguments[1];
    assert.ok(call.arguments.length === 1 || (call.arguments.length === 2 && ts.isArrowFunction(projection!) &&
      ts.isParenthesizedExpression(projection.body) && ts.isObjectLiteralExpression(projection.body.expression)), call.getText(source).slice(0, 40));
  }
  // Dynamic, for the four changes of a turn that are trace entries, which are most of what the store logs: the metadata a
  // caller passes is an object that counts each enumeration of its keys. The store enumerates it when it copies a trace,
  // the same number of times at every level; the projection enumerates it once more, to count the keys, and only when the
  // change passes the level.
  const run = (level: Level) => {
    const spy = createDiagnosticLogSpy({ threshold: level, now: () => NOW });
    const store = new (createTraceStoreModule(spy).MeetingTraceStore)();
    let enumerations = 0;
    const metadata = () => new Proxy({ a: 1, b: 2 }, { ownKeys(target) { enumerations += 1; return Reflect.ownKeys(target); } });
    const trace = store.startTrace("voice");
    store.startStep(trace.id, "Advisor model response", metadata());
    store.recordInput(trace.id, "Advisor prompt", "text", metadata());
    store.recordOutput(trace.id, "Advisor answer", "text", metadata());
    store.updateMetadata(trace.id, metadata());
    const entries = spy.entries();
    assert.deepEqual([spy.snapshot().detailFailures, spy.snapshot().internalErrors], [0, 0]);
    return { enumerations, built: entries.filter((entry) => entry.level === "trace").map((entry) => [entry.data!.change, entry.data!.metadataKeys]) };
  };
  const filtered = Object.fromEntries((["error", "warn", "info", "debug"] as const).map((level) => [level, run(level)]));
  const passing = run("trace");
  for (const [level, result] of Object.entries(filtered)) {
    assert.deepEqual(result.built, [], `${level}: no trace entry`);
    assert.equal(result.enumerations, filtered.error!.enumerations, `${level}: the store's own copies alone`);
  }
  assert.ok(filtered.error!.enumerations > 0, "the store does enumerate the metadata it copies: the counter works");
  assert.deepEqual(passing.built, [["step-started", 2], ["input-recorded", 2], ["output-recorded", 2], ["trace-metadata-updated", 2]]);
  assert.equal(passing.enumerations - filtered.error!.enumerations, 4, "one count per change that passes, none for a change that is filtered");
});

test("LG7 M1: Debug Mode no longer decides what the store logs; the flag is read by its own setter alone, to report a change once", async () => {
  const text = sourceOf("src/lib/meeting/trace.ts");
  const source = ts.createSourceFile("trace.ts", text, ts.ScriptTarget.Latest, true);
  const reads = collect(source, (node): node is ts.PropertyAccessExpression => ts.isPropertyAccessExpression(node) && node.name.text === "debugEnabled" &&
    node.expression.kind === ts.SyntaxKind.ThisKeyword && !(ts.isBinaryExpression(node.parent) && node.parent.left === node &&
      node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken));
  assert.deepEqual(reads.map((read) => {
    for (let current: ts.Node | undefined = read.parent; current; current = current.parent) if (ts.isMethodDeclaration(current)) return current.name.getText(source);
    return "<class>";
  }), ["setDebugEnabled"]);
  // One logger call in the store, in its private `log`, and the store reaches native through nothing else.
  assert.equal(text.split("logDiagnostic(").length - 1, 1);
  assert.equal(/@tauri-apps|invoke\(|console\./.test(text), false);
  // With Debug Mode off and the level at trace, each of the seven changes is logged; with Debug Mode on and the level at
  // warn, none is; at info, the one entry is the Debug Mode change itself.
  for (const [debug, level, expected] of [[false, "trace", 7], [true, "warn", 0], [true, "info", 1]] as const) {
    const spy = createDiagnosticLogSpy({ threshold: level, now: () => NOW });
    const store = new (createTraceStoreModule(spy).MeetingTraceStore)();
    store.setDebugEnabled(debug);
    const trace = store.startTrace("screen", { a: 1 });
    const step = store.startStep(trace.id, "Screen preflight");
    store.recordInput(trace.id, "Screen preflight prompt", "text");
    store.recordOutput(trace.id, "Screen preflight output", "text");
    store.updateMetadata(trace.id, { b: 2 });
    store.finishStep(trace.id, step);
    store.finishTrace(trace.id);
    assert.equal(spy.entries().length, expected, `debug=${debug} level=${level}`);
  }
});
