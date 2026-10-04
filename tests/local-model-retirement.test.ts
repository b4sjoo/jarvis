import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CaptureLifecycleCoordinator } from "../src/lib/meeting/capture-lifecycle.js";
import { RawZeroInputEpisode } from "../src/lib/meeting/audio-input-liveness.js";
import * as nativeLifecycle from "../src/lib/meeting/native-audio-lifecycle.js";
import { MeetingTraceStore } from "../src/lib/meeting/trace.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import { ScreenOperationCoordinator } from "../src/lib/meeting/screen-operation-coordinator.js";
import * as screenScope from "../src/lib/meeting/screen-task-scope.js";
import * as recovery from "../src/lib/meeting/visual-evidence-recovery.js";
import * as supersession from "../src/lib/meeting/advisor-generation-supersession.js";
import * as generationLease from "../src/lib/meeting/answer-generation-lease.js";
import * as commitAuthorization from "../src/lib/meeting/runtime-commit-authorization.js";
import * as sourceTransition from "../src/lib/meeting/source-owned-transition-runtime.js";
import * as metadataInference from "../src/lib/meeting/meeting-metadata-inference.js";
import * as runtimeInference from "../src/lib/meeting/runtime-inference.js";
import { hashTaxonomySourceTurnIds } from "../src/lib/meeting/taxonomy-adjudication.js";
import { createScreenPreflightDeadlineArbiter } from "../src/lib/meeting/screen-preflight-deadline.js";
import { createMeetingId } from "../src/lib/meeting/meeting-id.js";
import {
  createRuntimeCriticalEventHarness,
  RUNTIME_CRITICAL_EVENT_HOOK_CALLBACKS,
} from "./helpers/runtime-critical-events.js";

const hook = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
const ui = ts.createSourceFile("meeting.tsx", readFileSync("src/pages/app/components/meeting/index.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function find(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node {
  let result: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (result) return;
    if (predicate(node)) result = node;
    else ts.forEachChild(node, visit);
  };
  visit(root);
  assert.ok(result, "production declaration must exist");
  return result;
}

function declaration(source: ts.SourceFile, name: string) {
  return find(source, (node) =>
    (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(source) === name
  ) as ts.VariableDeclaration | ts.FunctionDeclaration;
}

function expression(source: ts.SourceFile, name: string): ts.Node {
  const node = declaration(source, name);
  return ts.isVariableDeclaration(node) ? node.initializer! : node;
}

function callback(name: string) {
  const node = expression(hook, name);
  assert.ok(ts.isCallExpression(node));
  return node.arguments[0]!;
}

function evaluate(node: ts.Node, source: ts.SourceFile, globals: Record<string, any>): any {
  const code = ts.transpileModule(`(${node.getText(source)})`, {
    fileName: source.fileName,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
    transformers: { before: [(context) => (root) => {
      const visit: ts.Visitor = (child) => ts.isMetaProperty(child)
        ? context.factory.createIdentifier("importMeta") : ts.visitEachChild(child, visit, context);
      return ts.visitNode(root, visit) as ts.SourceFile;
    }] },
  }).outputText;
  return vm.runInContext(code, globals);
}

// Task 178A: the Hook's own emit callbacks, extracted once.
const criticalEventCallbackNodes = Object.fromEntries(
  RUNTIME_CRITICAL_EVENT_HOOK_CALLBACKS.map((name) => [name, callback(name)])
) as Record<string, ts.Node>;

function load(source: ts.SourceFile, globals: Record<string, any>, names: string[]) {
  for (const name of names) globals[name] = evaluate(expression(source, name), source, globals);
}

const oldSettings = [
  {},
  { privacyMode: "text-and-screen-to-cloud", screenContextEnabled: true },
  { privacyMode: "memory-only", screenContextEnabled: false },
  { privacyMode: "text-and-screen-to-cloud", screenContextEnabled: false },
  { privacyMode: "memory-only", screenContextEnabled: true },
  // Task 168 (PC C1): values a store may still hold for the retired Semantic Type Rescue mode.
  { semanticTaxonomyMode: "enforcement" },
  { semanticTaxonomyMode: "shadow" },
  { semanticTaxonomyMode: "off" },
  { privacyMode: "memory-only", screenContextEnabled: false, semanticTaxonomyMode: { not: "a mode" } },
];

function settingsHarness(stored?: string) {
  const writes: string[] = [];
  const globals = vm.createContext({
    STORAGE_KEYS: { MEETING_ASSISTANT_SETTINGS: "test-settings" },
    safeLocalStorage: {
      getItem: () => stored ?? null,
      setItem: (_key: string, value: string) => writes.push(value),
    },
  });
  load(hook, globals, [
    "DEFAULT_ACTIVE_SCREEN_TASK_TIMEOUT_MINUTES", "MIN_ACTIVE_SCREEN_TASK_TIMEOUT_MINUTES", "MAX_ACTIVE_SCREEN_TASK_TIMEOUT_MINUTES",
    "DEFAULT_MEETING_AUDIO_CONFIG", "MEETING_AUDIO_PROFILE_CONFIGS", "DEFAULT_MEETING_RESPONSE_CONFIG",
    "DEFAULT_MEETING_CODING_MODEL_SETTINGS", "DEFAULT_TAXONOMY_ADJUDICATION_SETTINGS",
    "isRecord", "normalizeNumber", "normalizeVadDurationMs", "normalizeActiveScreenTaskTimeoutMinutes",
    "normalizeMeetingResponseConfig", "normalizeMeetingCodingModelSettings", "normalizeTaxonomyAdjudicationSettings",
    "normalizeMeetingAudioSettings", "normalizeMeetingAudioProfile", "normalizeMeetingAudioConfig",
    "isPersonalEvidenceGuardrailMode", "readMeetingAssistantSettings",
  ]);
  const initialSettings = find(expression(hook, "INITIAL_STATE"), (node) =>
    ts.isPropertyAssignment(node) && node.name.getText(hook) === "settings"
  ) as ts.PropertyAssignment;
  globals.DEFAULT_MEETING_ASSISTANT_SETTINGS = evaluate(initialSettings.initializer, hook, globals);
  globals.state = { status: "idle", settings: globals.readMeetingAssistantSettings() };
  globals.setState = (update: any) => { globals.state = update(globals.state); };
  globals.traceStoreRef = { current: new MeetingTraceStore() };
  globals.updateSettings = evaluate(callback("updateSettings"), hook, globals);
  globals.setDebugMode = evaluate(callback("setDebugMode"), hook, globals);
  return { globals, writes };
}

function plain(value: any) { return JSON.parse(JSON.stringify(value)); }

test("L115-D2 actual defaults/read/write ignore all retired key combinations and preserve current fields", () => {
  const defaults = plain(settingsHarness().globals.state.settings);
  assert.equal("privacyMode" in defaults, false);
  assert.equal("screenContextEnabled" in defaults, false);
  const valid = {
    ...defaults, activeScreenTaskTimeoutMinutes: 60, useMemory: false,
    personalEvidenceGuardrailMode: "shadow",
    microphoneContextEnabled: false, response: { length: "detailed", language: "chinese" },
    codingModel: { provider: "coding", variables: { API_KEY: "fixture-only", MODEL: "coding-model" } },
    taxonomyAdjudication: { ...defaults.taxonomyAdjudication, provider: "runtime", variables: { MODEL: "runtime-model" }, meetingMetadataMode: "off" },
    audio: { ...defaults.audio, profile: "custom", config: { ...defaults.audio.config, sensitivity_rms: 0.009 } },
  };
  for (const old of oldSettings) {
    const h = settingsHarness(JSON.stringify({ ...valid, ...old }));
    assert.deepEqual(plain(h.globals.state.settings), valid);
    assert.deepEqual(h.writes, [], "read has no migration write");
    h.globals.setDebugMode(true);
    assert.equal(h.writes.length, 1);
    assert.deepEqual(JSON.parse(h.writes[0]!), { ...valid, debugMode: true });
    assert.deepEqual(plain(settingsHarness(h.writes[0]).globals.state.settings), { ...valid, debugMode: true });
  }
  for (const invalid of ["{broken", "null"]) {
    assert.deepEqual(plain(settingsHarness(invalid).globals.state.settings), defaults);
  }
});

test("L115-D2 reader never even accesses retired fields", () => {
  const h = settingsHarness("{}");
  const accessed: string[] = [];
  h.globals.JSON = { parse: () => new Proxy({}, {
    get: (_target, key) => { accessed.push(String(key)); return undefined; },
  }) };
  h.globals.readMeetingAssistantSettings();
  assert.equal(accessed.includes("privacyMode"), false);
  assert.equal(accessed.includes("screenContextEnabled"), false);
  assert.equal(accessed.includes("semanticTaxonomyMode"), false);
  assert.deepEqual(h.writes, []);
});

// Task 168 (PC C1): the Semantic Type Rescue mode is retired. Stored values of the old key,
// valid or not, must behave exactly like a store that never had it.
const legacySemanticModes: unknown[] = [
  "enforcement", "shadow", "off", "", "garbage", 0, 42, true, null, ["enforcement"], { mode: "enforcement" },
];

function legacySemanticStore() {
  const defaults = plain(settingsHarness().globals.state.settings);
  return {
    ...defaults, useMemory: false, personalEvidenceGuardrailMode: "shadow",
    taxonomyAdjudication: { ...defaults.taxonomyAdjudication, meetingMetadataMode: "off" },
  };
}

test("168-C1 defaults and the settings type carry no semantic rescue mode", () => {
  const defaults = plain(settingsHarness().globals.state.settings);
  assert.equal("semanticTaxonomyMode" in defaults, false);
  assert.equal(defaults.debugMode, false);
  const settingsType = find(
    ts.createSourceFile("types.ts", readFileSync("src/lib/meeting/types.ts", "utf8"), ts.ScriptTarget.Latest, true),
    (node) => ts.isInterfaceDeclaration(node) && node.name.text === "MeetingAssistantSettings"
  ) as ts.InterfaceDeclaration;
  assert.deepEqual(
    settingsType.members.map((member) => (member.name as ts.Identifier).text).sort(),
    Object.keys(defaults).sort()
  );
});

test("168-C1 a stored semanticTaxonomyMode of any value loads without error, without a write, and is dropped by the next save", () => {
  const stored = legacySemanticStore();
  assert.deepEqual(plain(settingsHarness(JSON.stringify(stored)).globals.state.settings), stored);
  for (const legacy of legacySemanticModes) {
    const label = JSON.stringify(legacy);
    const h = settingsHarness(JSON.stringify({ ...stored, semanticTaxonomyMode: legacy }));
    // Equal to the store without the key: no error fallback to defaults and nothing derived from it.
    assert.deepEqual(plain(h.globals.state.settings), stored, label);
    assert.deepEqual(h.writes, [], `read has no migration write: ${label}`);
    h.globals.setDebugMode(true);
    assert.equal(h.writes.length, 1, label);
    const saved = JSON.parse(h.writes[0]!);
    assert.equal("semanticTaxonomyMode" in saved, false, label);
    assert.deepEqual(saved, { ...stored, debugMode: true }, label);
    assert.deepEqual(plain(settingsHarness(h.writes[0]).globals.state.settings), { ...stored, debugMode: true }, label);
  }
});

test("168-C1 the reader never accesses a stored semanticTaxonomyMode", () => {
  const stored = legacySemanticStore();
  for (const legacy of legacySemanticModes) {
    const h = settingsHarness(JSON.stringify({ ...stored, semanticTaxonomyMode: legacy }));
    const accessed: string[] = [];
    h.globals.JSON = { parse: (text: string) => new Proxy(JSON.parse(text), {
      get: (target, key, receiver) => { accessed.push(String(key)); return Reflect.get(target, key, receiver); },
    }) };
    assert.deepEqual(plain(h.globals.readMeetingAssistantSettings()), stored);
    assert.equal(accessed.includes("personalEvidenceGuardrailMode"), true, "the access recorder sees the live fields");
    assert.equal(accessed.includes("semanticTaxonomyMode"), false, JSON.stringify(legacy));
    assert.deepEqual(h.writes, []);
  }
});

function metadataHarness(storedSettings: Record<string, unknown>) {
  const { globals } = settingsHarness(JSON.stringify(storedSettings));
  const turn = { id: "opening", speaker: "them", text: "Welcome to Oracle. I am the interviewer for the backend engineering role.",
    source: "system-audio", isFinal: true, startedAt: 100, endedAt: 200 };
  const observations: Record<string, unknown> = {};
  const requests: unknown[] = [];
  let scheduled = 0;
  Object.assign(globals, metadataInference, runtimeInference, {
    AbortController, hashTaxonomySourceTurnIds,
    shutdownRequestedRef: { current: false }, debugModeRef: { current: false }, runtimeEpochRef: { current: 1 },
    contextManagerRef: { current: { getState: () => ({ sessionId: "s", startedAt: 100, transcriptTurns: [turn],
      interviewSessionContext: { targetCompany: undefined } }) } },
    taxonomyAdjudicationSettingsRef: { current: undefined },
    meetingModelProviderSnapshotRef: { current: {} },
    meetingMetadataInferenceCircuitRef: { current: { read: () => ({ open: false }) } },
    meetingMetadataInferenceRuntimeRef: { current: { getCurrentOperationId: () => undefined, schedule: (operation: any) => {
      scheduled += 1;
      operation.onStarted?.(operation.job, 300, { startsBefore: 0, startsAfter: 1, remaining: 1 });
      operation.execute(operation.job, new AbortController().signal);
    } } },
    traceStoreRef: { current: { updateMetadata: (_id: string, value: object) => Object.assign(observations, value),
      recordInput() {}, startStep: () => "step" } },
    sessionRecordingManagerRef: { current: { getState: () => ({ active: false }), recordModelInput() {} } },
    resolveRuntimeInferenceModelRouteFromSnapshot: () => ({ provider: { id: "provider" }, selectedProvider: { provider: "provider", variables: { model: "fixture" } } }),
    formatRuntimeInferenceModelRouteForTrace: () => ({}), readSelectedProviderModelId: () => "fixture",
    requestMeetingMetadataInference: (args: unknown) => requests.push(args),
  });
  // The production effect body that hands the stored mode to the scheduler.
  evaluate(find(hook, (node) => ts.isBinaryExpression(node) &&
    node.left.getText(hook) === "taxonomyAdjudicationSettingsRef.current" &&
    node.right.getText(hook) === "state.settings.taxonomyAdjudication"), hook, globals);
  evaluate(callback("scheduleMeetingMetadataInference"), hook, globals)({ turn, traceId: "trace" });
  return { observations, requests, scheduled: () => scheduled };
}

test("168-C1 a stored Meeting Metadata off is still honoured next to any legacy semantic mode", () => {
  const stored = legacySemanticStore();
  for (const legacy of legacySemanticModes) {
    const off = metadataHarness({ ...stored, semanticTaxonomyMode: legacy });
    assert.equal(off.observations.meetingMetadataInferenceMode, "off");
    assert.equal(off.observations.meetingMetadataInferenceDisposition, "operation-disabled");
    assert.equal(off.observations.meetingMetadataInferenceSkipReason, "runtime-inference-disabled");
    assert.equal(off.scheduled(), 0);
    assert.deepEqual(off.requests, []);
  }
  // Control: the same unresolved-company opening is requested once when the stored mode is not off.
  for (const mode of ["shadow", "enforcement"]) {
    const on = metadataHarness({ ...stored, semanticTaxonomyMode: "enforcement",
      taxonomyAdjudication: { ...stored.taxonomyAdjudication, meetingMetadataMode: mode } });
    assert.equal(on.observations.meetingMetadataInferenceMode, mode);
    assert.equal(on.scheduled(), 1);
    assert.equal(on.requests.length, 1);
  }
});

// Run the complete production callbacks, supplying native I/O and UI state only.
function entryHarness(old = {}) {
  const { globals } = settingsHarness(JSON.stringify(old));
  const calls: string[] = [];
  for (const name of ["startCapture", "captureScreenContext"]) {
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === "current" && ts.isIdentifier(node.expression)) {
        globals[node.expression.text] ??= { current: null };
      }
      ts.forEachChild(node, visit);
    };
    visit(callback(name));
  }
  Object.assign(globals, nativeLifecycle, {
    AbortController,
    sttProvider: { id: "stt" }, aiProvider: null,
    selectedAudioDevices: { output: { id: "default" } },
    readNativeCaptureLease: () => ({}),
    revokeAudioDrainAuthorization: () => undefined,
    invalidateAudioProcessingSession: () => undefined,
    cancelActiveAdvisorJob: () => undefined,
    resetMeetingRuntimeForNewSession: async () => undefined,
    stopNativeMeetingCapture: async () => { calls.push("stop-native"); },
    startAudioProcessingSession: () => { calls.push("audio-processing"); },
    reportRawZeroProbe: () => undefined,
    prewarmMemoryContextSnapshot: () => undefined,
    prewarmSemanticTaxonomyRuntime: () => undefined,
    invoke: async (command: string) => {
      calls.push(command);
      if (command === "check_system_audio_access") return true;
      assert.equal(command, "start_meeting_audio_session");
      return { active: true, captureSessionId: "test-capture", captureGeneration: 1 };
    },
  });
  globals.captureLifecycleCoordinatorRef.current = new CaptureLifecycleCoordinator();
  globals.rawZeroInputEpisodeRef.current = new RawZeroInputEpisode();
  globals.handledNativeTerminalKeysRef.current = new Set();
  globals.contextManagerRef.current = { getState: () => ({ sessionId: "session", transcriptTurns: [], screenObservations: [] }) };
  // Task 178A: the real stream and the real Hook emit callbacks.
  const criticalEvents = createRuntimeCriticalEventHarness({ sessionId: "session" });
  criticalEvents.install(globals, (name) => evaluate(criticalEventCallbackNodes[name], hook, globals));
  load(hook, globals, ["MISSING_STT_MESSAGE", "MISSING_AI_MESSAGE", "MISSING_VISION_MESSAGE"]);
  for (const name of ["startCapture", "start", "resume", "captureScreenContext"]) {
    globals[name] = evaluate(callback(name), hook, globals);
  }
  globals.setupWarnings = evaluate(callback("setupWarnings"), hook, globals);
  return { globals, calls, criticalEvents };
}

test("L115-D4 actual Meeting Start/Resume accept current providers regardless of retired keys", async () => {
  for (const old of oldSettings) {
    const h = entryHarness(old);
    assert.deepEqual(h.calls, [], "settings and entry construction do not start capture");
    await h.globals.start();
    assert.equal(h.globals.state.status, "listening");
    assert.equal(h.globals.state.error, null);
    assert.deepEqual(h.calls, ["check_system_audio_access", "stop-native", "start_meeting_audio_session", "audio-processing"]);
    await h.globals.resume();
    assert.equal(h.calls.filter((call) => call === "start_meeting_audio_session").length, 2);
  }
});

test("L115-D4 Meeting keeps provider, native permission, Replay and shutdown checks", async () => {
  const missing = entryHarness(oldSettings[2]);
  missing.globals.sttProvider = null;
  await missing.globals.start();
  assert.equal(missing.globals.state.error, missing.globals.MISSING_STT_MESSAGE);
  assert.deepEqual(missing.calls, []);
  const denied = entryHarness();
  denied.globals.invoke = async (command: string) => { denied.calls.push(command); return false; };
  await denied.globals.start();
  assert.match(denied.globals.state.error, /System audio permission is required/);
  assert.deepEqual(denied.calls, ["check_system_audio_access"]);
  const replay = entryHarness();
  replay.globals.runtimeRegressionRunRef.current = {};
  await replay.globals.start();
  assert.match(replay.globals.state.error, /Stop Replay Lab/);
  assert.deepEqual(replay.calls, []);
  const shutdown = entryHarness();
  shutdown.globals.shutdownRequestedRef.current = true;
  await shutdown.globals.start();
  await shutdown.globals.captureScreenContext();
  assert.deepEqual(shutdown.calls, []);
});

test("L115-D4 actual setup warnings retain STT, AI and image capability checks", () => {
  const h = entryHarness(oldSettings[2]);
  h.globals.sttProvider = null;
  assert.deepEqual(plain(h.globals.setupWarnings()).map((w: any) => w.code), ["stt-provider-missing", "ai-provider-missing"]);
  h.globals.sttProvider = { id: "stt" };
  h.globals.aiProvider = { curl: "text only" };
  assert.deepEqual(plain(h.globals.setupWarnings()).map((w: any) => w.code), ["vision-provider-missing"]);
  h.globals.aiProvider = { curl: "{{IMAGE}}" };
  assert.deepEqual(plain(h.globals.setupWarnings()), []);
});

function screenHarness(old = {}) {
  const h = entryHarness(old);
  const g = h.globals;
  const manager = new MeetingContextManager();
  const traces = new MeetingTraceStore();
  Object.assign(g, screenScope, recovery, supersession, generationLease, commitAuthorization, sourceTransition, {
    Error, createMeetingId,
    screenshotConfiguration: { mode: "manual" },
    selectedAIProvider: { provider: "vision", variables: { API_KEY: "fixture-only" } },
    flushPendingSentenceCompletion: () => undefined,
    shouldIncludeTurnInAdvisorPrompt: () => true,
    readRuntimeCommitSnapshot: () => commitAuthorization.buildRuntimeCommitSnapshot({
      runtimeEpoch: g.runtimeEpochRef.current, contextState: manager.getState(),
    }),
    captureScreenObservation: async ({ source }: any) => {
      h.calls.push(`capture:${source}`);
      return { id: "screen-fixture", source, capturedAt: 1, hash: "fixture-hash", changed: true, imageBase64: "fixture-image", imageMediaType: "image/png" };
    },
    createScreenPreflightDeadlineArbiter: (options: any) => createScreenPreflightDeadlineArbiter({
      ...options, schedule: () => 0 as any, cancelSchedule: () => undefined,
    }),
    preflightScreenObservation: (input: any) => {
      h.calls.push("preflight");
      assert.equal(input.provider, g.aiProvider);
      assert.equal(input.selectedProvider, g.selectedAIProvider);
      assert.equal(input.observation.imageBase64, "fixture-image");
      // End this bounded entry test at the provider boundary, before semantic inference.
      throw new Error("fixture provider boundary");
    },
  });
  g.contextManagerRef.current = manager;
  // Task 178A: the stream follows the runtime session of this real manager.
  h.criticalEvents.bind(manager.getState().sessionId).observe();
  g.traceStoreRef.current = traces;
  g.screenOperationCoordinatorRef.current = new ScreenOperationCoordinator();
  g.awaitingVisualEvidenceRecoveryRef.current = new Map();
  g.runtimeEpochRef.current = 1;
  g.visibleAnswerRevisionRef.current = 0;
  g.manualCorrectionRevisionRef.current = 0;
  g.responseActionRevisionRef.current = 0;
  load(hook, g, ["formatTraceMetadata", "getMeetingScreenAutoPrompt", "formatRecentTranscript", "SCREEN_PREFLIGHT_TIMEOUT_MS"]);
  return { ...h, manager, traces };
}

test("L115-D4 actual Screen captures only on request and retains missing AI/vision checks", async () => {
  for (const old of oldSettings) {
    for (const provider of [null, { id: "text", curl: "text-only" }]) {
      const h = screenHarness(old);
      h.globals.aiProvider = provider;
      assert.deepEqual(h.calls, []);
      await h.globals.captureScreenContext("hotkey");
      assert.deepEqual(h.calls, ["capture:hotkey"]);
      assert.equal(h.globals.state.error, provider ? h.globals.MISSING_VISION_MESSAGE : h.globals.MISSING_AI_MESSAGE);
      assert.equal(h.manager.getState().screenObservations.length, 1);
      const trace = h.traces.getTraces()[0]!;
      assert.equal(trace.status, "error");
      assert.equal("privacyMode" in trace.metadata!, false);
      assert.equal("screenContextEnabled" in trace.metadata!, false);
      assert.equal(h.globals.screenOperationCoordinatorRef.current.getActiveOperationId(), null);
      // Task 178A: a missing provider ends the operation with an error after
      // its capture. Its release says so; it is not a flow that ran to its end.
      const facts = plain(h.criticalEvents.events()).map((event: any) => [event.fact, event.stage, event.terminal]);
      assert.deepEqual(facts, [
        ["input-accepted", "screen-operation-claimed", undefined],
        ["terminal", "screen-operation-release", { object: "screen-operation", disposition: "released", reason: "operation-error" }],
      ]);
    }
  }
});

test("L115-D4 actual Screen forwards configured provider/credentials to preflight with retired keys ignored", async () => {
  for (const old of oldSettings) {
    const h = screenHarness(old);
    h.globals.aiProvider = { id: "vision", curl: "{{IMAGE}}" };
    await h.globals.captureScreenContext();
    assert.deepEqual(h.calls, ["capture:full-screen", "preflight"]);
    assert.equal(h.globals.state.error, "fixture provider boundary");
    assert.equal(h.traces.getTraces()[0]!.metadata!.screenPreflightEnabled, true);
    assert.equal(h.globals.screenAnalysisAbortRef.current, null);
  }
});

test("L115-D4 actual Screen rejects stale capture before observation commit or provider request", async () => {
  const h = screenHarness(oldSettings[2]);
  h.globals.aiProvider = { id: "vision", curl: "{{IMAGE}}" };
  const capture = h.globals.captureScreenObservation;
  h.globals.captureScreenObservation = async (input: any) => {
    const result = await capture(input);
    h.globals.runtimeEpochRef.current += 1;
    return result;
  };
  await h.globals.captureScreenContext();
  assert.deepEqual(h.calls, ["capture:full-screen"]);
  assert.equal(h.manager.getState().screenObservations.length, 0);
  assert.equal(h.traces.getTraces()[0]!.status, "cancelled");
  assert.equal(h.traces.getTraces()[0]!.metadata!.runtimeCommitAuthorizationReason, "runtime-epoch-mismatch");
});

function uiHarness() {
  const { globals } = settingsHarness();
  const passthrough = ({ children }: any) => React.createElement("div", null, children);
  Object.assign(globals, {
    React, exports: {}, importMeta: { env: { DEV: false } },
    useState: (initial: any) => [initial, () => undefined], useEffect: () => undefined,
    useCallback: (fn: any) => fn, cn: (...values: any[]) => values.filter(Boolean).join(" "),
    Button: ({ children, onClick, disabled }: any) => React.createElement("button", { onClick, disabled }, children),
    Label: passthrough, Switch: () => React.createElement("input", { type: "checkbox" }),
    MeetingAudioSlider: () => null, Input: "input",
    extractVariables: () => [],
  });
  const panel = expression(ui, "ConfigurationsPanel");
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ui).endsWith("Icon")) {
      globals[node.tagName.getText(ui)] = () => null;
    }
    ts.forEachChild(node, visit);
  };
  visit(panel);
  load(ui, globals, ["responseLengthOptions", "responseLanguageOptions", "enforcementShadowModeOptions", "meetingAudioProfileOptions", "TASK_TIMEOUT_OPTIONS",
    "formatTaskTimeout", "formatSilenceDuration", "ConfigurationGroup", "ConfigButtonGrid", "MeetingModelOverrideConfig", "ConfigurationsPanel"]);
  const settings = globals.state.settings;
  const changes: any[] = [];
  const props = {
    open: true, responseConfig: settings.response, codingModel: settings.codingModel,
    taxonomyAdjudication: settings.taxonomyAdjudication, aiProviders: [{ id: "test-provider", curl: "" }],
    activeScreenTaskTimeoutMinutes: 30, audioProfile: "balanced", audioConfig: settings.audio.config,
    sessionRecording: { lifecycle: "idle" }, runtimeRegression: { active: false, status: "idle" }, sttEvaluationCapture: { lifecycle: "idle" },
    onCodingModelChange: (value: any) => changes.push(plain(value)),
  };
  return { globals, props, changes };
}

function expand(element: any): any {
  if (Array.isArray(element)) return element.map(expand);
  if (!React.isValidElement(element)) return element;
  const node = element as React.ReactElement<any>;
  if (typeof node.type === "function") return expand((node.type as any)(node.props));
  return React.cloneElement(node, {}, expand(node.props.children));
}

function elements(tree: any): React.ReactElement<any>[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!React.isValidElement(tree)) return [];
  const node = tree as React.ReactElement<any>;
  return [node, ...elements(node.props.children)];
}

test("L115-D1 actual settings rendering has static processing text and functional provider selectors", () => {
  const h = uiHarness();
  const tree = expand(h.globals.ConfigurationsPanel(h.props));
  const html = renderToStaticMarkup(tree);
  assert.match(html, /Configured provider API/);
  assert.doesNotMatch(html, /Local Model|Cloud API|Privacy/);
  const nodes = elements(tree);
  assert.equal(nodes.filter((node) => node.type === "p" && node.props.children === "Configured provider API").length, 1);
  const selects = nodes.filter((node) => node.type === "select");
  assert.equal(selects.length, 2, "coding and runtime provider selectors remain");
  assert.match(html, /test-provider/);
  assert.deepEqual(h.changes, [], "rendering invokes no setting setter");
  selects[0]!.props.onChange({ target: { value: "test-provider" } });
  assert.deepEqual(h.changes, [{ provider: "test-provider", variables: {} }]);
});

test("168-C1 actual settings rendering has no Semantic Type Rescue entry and keeps the neighbouring controls", () => {
  const h = uiHarness();
  const html = renderToStaticMarkup(expand(h.globals.ConfigurationsPanel(h.props)));
  assert.doesNotMatch(html, /Semantic Type Rescue|unknown-only rescue|Shadow mode \(recommended\)/);
  // 178 (PC C3) renamed and moved the two neighbours. The guardrail mode is now the
  // "Fact Risk Review" selector in the Preview group of this panel. The Meeting
  // Metadata mode is rendered by the Interview Brief panel, so it is no longer in
  // this markup; tests/preview-controls-ui.test.ts renders it there. The Fast
  // Runtime model selector that shared its container stays here.
  assert.doesNotMatch(html, /Personal Fact Guardrail|Meeting Metadata Enforcement/);
  assert.match(html, /Fact Risk Review/);
  assert.match(html, /Fast Runtime model/);
  const panel = expression(ui, "ConfigurationsPanel");
  assert.doesNotMatch(panel.getText(ui), /[sS]emanticTaxonomyMode/);
  assert.equal(/[sS]emanticTaxonomyMode/.test(ui.getFullText()), false, "no prop is passed from the page either");
  assert.deepEqual(h.changes, [], "rendering invokes no setting setter");
});

test("L115-D1 actual Screen button retains lifecycle disabling and explicit capture action", () => {
  const button = find(ui, (node) => ts.isJsxElement(node) &&
    node.openingElement.attributes.properties.some((attribute) =>
      ts.isJsxAttribute(attribute) && attribute.name.getText(ui) === "title" &&
      attribute.initializer?.getText(ui) === '"Capture current screen context"'
    )
  );
  for (const status of ["idle", "paused", "listening", "starting", "reconnecting"]) {
    let captures = 0;
    const globals = vm.createContext({
      React, Button: "button", CameraIcon: () => null,
      meeting: { status, captureScreenContext: () => { captures += 1; } },
    });
    const element = evaluate(button, ui, globals);
    assert.equal(element.props.disabled, status === "starting" || status === "reconnecting");
    assert.equal(captures, 0);
    if (!element.props.disabled) {
      element.props.onClick();
      assert.equal(captures, 1);
    }
  }
});

test("L115-D3 live production files contain no retired state, API, gates or messages", () => {
  for (const file of ["src/hooks/useMeetingAssistant.ts", "src/lib/meeting/types.ts", "src/pages/app/components/meeting/index.tsx"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /MeetingPrivacyMode|privacyMode|screenContextEnabled|setPrivacyMode|setScreenContextEnabled|privacyOptions|memory-only|text-and-screen-to-cloud|local-only-unavailable|LOCAL_ONLY_UNAVAILABLE_MESSAGE|SCREEN_CONTEXT_DISABLED_MESSAGE/);
  }
});
