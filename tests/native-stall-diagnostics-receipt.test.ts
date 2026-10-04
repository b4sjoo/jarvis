// Tasks 145/183 NDI, frontend part: NDI1 eligibility, NDI2 receipt projection and
// the NDI6 panel.
//
// Real, loaded from source and evaluated: the Hook's settings defaults, reader,
// writer and setters, the recording manager's change handler, the diagnostics
// state and ref initialisers and its render-time statement,
// queueNativeStallDiagnostics, the arming effect and its dependency array, the
// projection expression and the member of the Hook's return value that carries
// it, the page's call-site prop expressions and ConfigurationsPanel. Real,
// imported: the leaf module and SessionRecordingManager.
// Controlled: the Tauri invoke (a stand-in for the native command that keeps one
// run id per recording folder, as native does), the recorder's disk, storage,
// the leaf UI primitives and React itself. React is modelled as renders: each
// render applies the queued state and receipt updates, evaluates the Hook's
// render-time statement and its exported projection (one frame), and runs the
// effect again, cleanup first, when its real dependency array changed. By
// default every update is its own render. In manual mode updates wait for
// flush(), which is how one commit can go from recording A to recording B.
// Anything else the evaluated code reaches for is a ReferenceError: no recording
// start, capture command, provider request or timer is in scope.
// tests/preview-controls-consumer.test.mjs mounts the same code with the real
// React in a real browser.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { SessionRecordingManager } from "../src/lib/meeting/session-recording.js";
import {
  NATIVE_STALL_DIAGNOSTICS_NO_RUN_ID_MESSAGE,
  beginNativeStallDiagnosticsRequest,
  createNativeStallDiagnosticsRequest,
  isNativeStallDiagnosticsRequestRecording,
  nativeStallDiagnosticsEvidencePath,
  projectNativeStallDiagnostics,
  settleNativeStallDiagnosticsRequest,
  type NativeStallDiagnosticsProjection,
  type NativeStallDiagnosticsReceipt,
  type NativeStallDiagnosticsReceiptStatus,
} from "../src/lib/meeting/native-stall-diagnostics-receipt.js";
import { isDiagnosticLogLevel } from "../src/lib/meeting/diagnostic-log.js";

const HOOK = "src/hooks/useMeetingAssistant.ts";
const PAGE = "src/pages/app/components/meeting/index.tsx";
const LEAF = "src/lib/meeting/native-stall-diagnostics-receipt.ts";
const hookText = readFileSync(HOOK, "utf8");
const uiText = readFileSync(PAGE, "utf8");
const leafText = readFileSync(LEAF, "utf8");
const hook = ts.createSourceFile("hook.ts", hookText, ts.ScriptTarget.Latest, true);
const ui = ts.createSourceFile("meeting.tsx", uiText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const leaf = ts.createSourceFile("leaf.ts", leafText, ts.ScriptTarget.Latest, true);

function findAll(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(root);
  return found;
}
function only<T extends ts.Node>(nodes: ts.Node[], what: string): T {
  assert.equal(nodes.length, 1, `exactly one ${what}`);
  return nodes[0] as T;
}
// First declaration of each name, in source order, indexed once per file.
const declarations = new Map<ts.SourceFile, Map<string, ts.VariableDeclaration | ts.FunctionDeclaration>>();
function expression(source: ts.SourceFile, name: string): ts.Node {
  let index = declarations.get(source);
  if (!index) {
    index = new Map();
    for (const node of findAll(source, (candidate) => ts.isVariableDeclaration(candidate) || ts.isFunctionDeclaration(candidate))) {
      const declared = (node as ts.VariableDeclaration | ts.FunctionDeclaration).name?.getText(source);
      if (declared && !index.has(declared)) index.set(declared, node as ts.VariableDeclaration | ts.FunctionDeclaration);
    }
    declarations.set(source, index);
  }
  const node = index.get(name);
  assert.ok(node, `production declaration ${name} must exist`);
  return ts.isVariableDeclaration(node) ? node.initializer! : node;
}
function hookCall(name: string): ts.CallExpression {
  const node = expression(hook, name);
  assert.ok(ts.isCallExpression(node), `${name} is declared by a hook call`);
  return node;
}
const transpiled = new Map<string, string>();
function evaluateText(code: string, globals: Record<string, any>): any {
  let output = transpiled.get(code);
  if (output === undefined) {
    output = ts.transpileModule(`(${code})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
      transformers: { before: [(context) => (root) => {
        const visit: ts.Visitor = (child) => ts.isMetaProperty(child)
          ? context.factory.createIdentifier("importMeta") : ts.visitEachChild(child, visit, context);
        return ts.visitNode(root, visit) as ts.SourceFile;
      }] },
    }).outputText;
    transpiled.set(code, output);
  }
  return vm.runInContext(output, globals as vm.Context);
}
const evaluate = (node: ts.Node, source: ts.SourceFile, globals: Record<string, any>) =>
  evaluateText(node.getText(source), globals);
const plain = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const compact = (value: string) => value.replace(/\s+/g, " ").trim();
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const booleans = [false, true];

// ---- the production nodes of the diagnostics block ----

const queueDeclaration = hookCall("queueNativeStallDiagnostics");
const queueCallback = queueDeclaration.arguments[0]!;
const armingEffect = only<ts.CallExpression>(findAll(hook, (node) => ts.isCallExpression(node) &&
  node.expression.getText(hook) === "useEffect" && node.getText(hook).includes("queueNativeStallDiagnostics(")), "arming effect");
const projectionExpression = expression(hook, "nativeStallDiagnostics");
const receiptState = only<ts.VariableDeclaration>(findAll(hook, (node) => ts.isVariableDeclaration(node) &&
  ts.isArrayBindingPattern(node.name) && node.name.elements[0]?.getText(hook) === "nativeStallDiagnosticsReceipt"), "receipt state");
const managerConstruction = only<ts.NewExpression>(findAll(hook, (node) => ts.isNewExpression(node) &&
  node.expression.getText(hook) === "SessionRecordingManager"), "recording manager construction");
const hookReturn = only<ts.ReturnStatement>(findAll(expression(hook, "useMeetingAssistant"), (node) =>
  ts.isReturnStatement(node) && Boolean(node.expression) && ts.isObjectLiteralExpression(node.expression!) &&
  node.expression!.properties.some((property) => property.name?.getText(hook) === "setNativeStallDiagnosticsEnabled")), "Hook return value");
// The member of the Hook's return value that hands the projection to the page.
const exportedMember = only<ts.ObjectLiteralElementLike>((hookReturn.expression as ts.ObjectLiteralExpression).properties
  .filter((property) => property.name?.getText(hook) === "nativeStallDiagnostics"), "exported projection");
// The statement of the block that runs during render: the switch, mirrored for the queue function. The
// harness evaluates what it finds in every render; that there is exactly one, and where, is asserted below.
const settingRefAssignments = findAll(hook, (node) => ts.isBinaryExpression(node) &&
  node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText(hook) === "nativeStallDiagnosticsSettingRef.current");
const panelCallSite = only<ts.JsxSelfClosingElement>(findAll(ui, (node) => ts.isJsxSelfClosingElement(node) &&
  node.tagName.getText(ui) === "ConfigurationsPanel"), "ConfigurationsPanel call site");

const SETTINGS_KEY = "test-settings";
const SETTINGS_KEYS = ["activeScreenTaskTimeoutMinutes", "audio", "codingModel", "debugMode", "diagnosticLogLevel", "microphoneContextEnabled",
  "nativeStallDiagnosticsEnabled", "personalEvidenceGuardrailMode", "response", "runtimeCrossChecksEnabled",
  "taxonomyAdjudication", "useMemory"];
const COMMAND = "set_native_stall_diagnostics";
const DISARM = { name: COMMAND, args: { enabled: false, folderName: null } };
const arm = (folderName: string | undefined) => ({ name: COMMAND, args: { enabled: true, folderName } });

interface IpcCall { name: string; args: Record<string, unknown> }
interface HeldRequest { args: { enabled: boolean; folderName: string | null }; resolve(value: string | null): void; reject(error: unknown): void; settled: boolean }
interface RecorderFile { command: string; args: Record<string, any> }
interface MountOptions { stored?: Record<string, unknown> | string; native?: "auto" | "hold"; dev?: boolean; commits?: "each" | "manual" }
// One render of the Hook: the state it rendered with and the projection it returned.
interface Frame {
  setting: boolean; active: boolean; folderName?: string; folderPath?: string;
  shown: NativeStallDiagnosticsProjection;
  receipt: NativeStallDiagnosticsReceipt | null;
  // The latest arming receipt that native answered with a run id, and the frame it was first rendered in.
  lastArmedWrite?: { folderPath?: string; frame: number };
}
// The requests as sent, with each run of disarms as one entry: how many disarms a Stop sends depends on how
// the recording states fall into commits (see the test that counts them), so most tests assert the shape.
const shape = (calls: IpcCall[]) => calls.reduce<string[]>((entries, call) => {
  assert.equal(call.name, COMMAND);
  const entry = call.args.enabled ? `arm ${call.args.folderName}` : "disarms";
  if (entry !== "disarms") assert.deepEqual(Object.keys(call.args), ["enabled", "folderName"]);
  else assert.deepEqual(call.args, DISARM.args);
  return entry === "disarms" && entries.at(-1) === "disarms" ? entries : [...entries, entry];
}, []);

// One mounted Hook, as far as Native Stall Diagnostics is concerned.
function mount(options: MountOptions = {}) {
  const stored = options.stored === undefined ? undefined
    : typeof options.stored === "string" ? options.stored : JSON.stringify(options.stored);
  const ipc: IpcCall[] = [];
  const held: HeldRequest[] = [];
  const files: RecorderFile[] = [];
  const storageWrites: string[] = [];
  const warnings: unknown[][] = [];
  const receiptWrites: Array<NativeStallDiagnosticsReceipt | null> = [];
  const actions: string[] = [];
  const frames: Frame[] = [];
  // The run id native gave each recording folder.
  const runs = new Map<string, string>();

  // What native answers: null for a disarm, one run id per recording folder for an arm,
  // the same id again when that folder is armed again.
  let nativeRun: { folderName: string; runId: string } | undefined;
  let nativeRuns = 0;
  const nativeReply = (args: { enabled: boolean; folderName: string | null }) => {
    if (!args.enabled) return null;
    if (typeof args.folderName !== "string") throw "Recording folder is required";
    if (nativeRun?.folderName !== args.folderName) nativeRun = { folderName: args.folderName, runId: `run-${++nativeRuns}` };
    runs.set(nativeRun.folderName, nativeRun.runId);
    return nativeRun.runId;
  };
  const invoke = (name: string, args: any) => {
    ipc.push({ name, args: plain(args) });
    if (name !== COMMAND) return Promise.reject(new Error(`Uncontrolled native command: ${name}`));
    if ((options.native ?? "auto") === "auto") {
      try { return Promise.resolve(nativeReply(args)); } catch (error) { return Promise.reject(error); }
    }
    return new Promise<string | null>((resolve, reject) => {
      const request: HeldRequest = { args: plain(args), settled: false,
        resolve: (value) => { request.settled = true; resolve(value); },
        reject: (error) => { request.settled = true; reject(error); } };
      held.push(request);
    });
  };

  const globals = vm.createContext({
    Error, Promise,
    STORAGE_KEYS: { MEETING_ASSISTANT_SETTINGS: SETTINGS_KEY },
    safeLocalStorage: { getItem: () => stored ?? null, setItem: (_key: string, value: string) => { storageWrites.push(value); } },
    console: { warn: (...args: unknown[]) => { warnings.push(args); } },
    invoke,
    // The five functions the Hook imports from the leaf module.
    beginNativeStallDiagnosticsRequest, createNativeStallDiagnosticsRequest, isNativeStallDiagnosticsRequestRecording,
    projectNativeStallDiagnostics, settleNativeStallDiagnosticsRequest,
    // Task 178 LG: the one function the settings reader imports from the diagnostic log module.
    isDiagnosticLogLevel,
    useRef: (value: unknown) => ({ current: value }),
    useState: (initial: unknown) => [initial],
  }) as Record<string, any>;
  for (const name of [
    "DEFAULT_ACTIVE_SCREEN_TASK_TIMEOUT_MINUTES", "MIN_ACTIVE_SCREEN_TASK_TIMEOUT_MINUTES", "MAX_ACTIVE_SCREEN_TASK_TIMEOUT_MINUTES",
    "DEFAULT_MEETING_AUDIO_CONFIG", "MEETING_AUDIO_PROFILE_CONFIGS", "DEFAULT_MEETING_RESPONSE_CONFIG",
    "DEFAULT_MEETING_CODING_MODEL_SETTINGS", "DEFAULT_TAXONOMY_ADJUDICATION_SETTINGS",
    "isRecord", "normalizeNumber", "normalizeVadDurationMs", "normalizeActiveScreenTaskTimeoutMinutes",
    "normalizeMeetingResponseConfig", "normalizeMeetingCodingModelSettings", "normalizeTaxonomyAdjudicationSettings",
    "normalizeMeetingAudioSettings", "normalizeMeetingAudioProfile", "normalizeMeetingAudioConfig",
    "isPersonalEvidenceGuardrailMode", "readMeetingAssistantSettings",
  ]) globals[name] = evaluate(expression(hook, name), hook, globals);
  const initialSettings = only<ts.PropertyAssignment>(findAll(expression(hook, "INITIAL_STATE"), (node) =>
    ts.isPropertyAssignment(node) && node.name.getText(hook) === "settings" && node.parent === expression(hook, "INITIAL_STATE")), "initial settings");
  globals.DEFAULT_MEETING_ASSISTANT_SETTINGS = evaluate(initialSettings.initializer, hook, globals);

  // React, reduced to what this block uses. A render applies the queued updates in order, runs the
  // block's render-time statement, records what the Hook returns (one frame), then reads the effect's
  // real dependency array and re-runs the effect, cleanup first, if it moved. Updates made by the effect
  // are rendered next, as React does.
  const effect = evaluate(armingEffect.arguments[0]!, hook, globals) as () => void | (() => void);
  const readDependencies = () => evaluate(armingEffect.arguments[1]!, hook, globals) as unknown[];
  // What the Hook hands to the page: the member of its return value, over the projection declaration.
  const exported = () => {
    globals.nativeStallDiagnostics = evaluate(projectionExpression, hook, globals);
    return plain(ts.isShorthandPropertyAssignment(exportedMember) ? globals.nativeStallDiagnostics
      : evaluate((exportedMember as ts.PropertyAssignment).initializer, hook, globals)) as NativeStallDiagnosticsProjection;
  };
  const pendingState: Array<(state: any) => any> = [];
  const pendingReceipt: unknown[] = [];
  let lastArmedWrite: Frame["lastArmedWrite"];
  let mounted = false;
  let rendering = false;
  let again = false;
  let cleanup: void | (() => void);
  let dependencies: unknown[] | undefined;
  let effectRuns = 0;
  const render = () => {
    if (!mounted) return;
    if (rendering) { again = true; return; }
    rendering = true;
    try {
      do {
        again = false;
        for (const update of pendingState.splice(0)) globals.state = update(globals.state);
        for (const update of pendingReceipt.splice(0)) {
          const next = typeof update === "function" ? update(globals.nativeStallDiagnosticsReceipt) : update;
          globals.nativeStallDiagnosticsReceipt = next;
          receiptWrites.push(plain(next));
          if (next?.enabled && next.status === "armed") lastArmedWrite = { folderPath: next.folderPath, frame: frames.length };
        }
        for (const assignment of settingRefAssignments) evaluate(assignment, hook, globals);
        const recording = globals.state.sessionRecording;
        frames.push({ setting: globals.state.settings.nativeStallDiagnosticsEnabled, active: recording.active,
          folderName: recording.folderName, folderPath: recording.folderPath, shown: exported(),
          receipt: plain(globals.nativeStallDiagnosticsReceipt), ...(lastArmedWrite ? { lastArmedWrite } : {}) });
        const next = readDependencies();
        if (!dependencies || next.some((value, index) => !Object.is(value, dependencies![index]))) {
          if (cleanup) cleanup();
          dependencies = next;
          cleanup = effect();
          effectRuns += 1;
        }
        if (pendingState.length || pendingReceipt.length) again = true;
      } while (again);
    } finally { rendering = false; }
  };
  const scheduled = () => { if ((options.commits ?? "each") === "each") render(); };

  globals.setState = (update: (state: any) => any) => { pendingState.push(update); scheduled(); };
  const manager = new SessionRecordingManager(
    evaluate(managerConstruction.arguments![0]!, hook, globals),
    async <T>(command: string, args: Record<string, unknown> = {}) => {
      files.push({ command, args });
      return `/recordings/${args.folderName}` as T;
    });
  globals.sessionRecordingManagerRef = { current: manager };
  globals.state = {
    settings: globals.readMeetingAssistantSettings(), sessionRecording: manager.getState(),
    // What the panel's call site reads besides the two above.
    status: "idle", isActive: false, audioStatus: undefined, aiProviders: [{ id: "test-provider", curl: "" }],
    scriptedValidation: false, runtimeRegression: { active: false, status: "idle", stepOrdinal: 0 },
    sttEvaluationCapture: { active: false, lifecycle: "idle" },
  };
  globals.traceStoreRef = { current: { setDebugEnabled: () => undefined } };
  globals.runtimeCrossChecksEnabledRef = { current: globals.state.settings.runtimeCrossChecksEnabled };
  globals.updateSettings = evaluate(hookCall("updateSettings").arguments[0]!, hook, globals);
  for (const name of ["setDebugMode", "setNativeStallDiagnosticsEnabled", "setRuntimeCrossChecksEnabled"]) {
    globals[name] = evaluate(hookCall(name).arguments[0]!, hook, globals);
  }

  // The diagnostics block: its state, its three refs and its queue function, from their own initialisers.
  globals.nativeStallDiagnosticsReceipt = (evaluate(receiptState.initializer!, hook, globals) as unknown[])[0];
  globals.setNativeStallDiagnosticsReceipt = (update: unknown) => { pendingReceipt.push(update); scheduled(); };
  for (const name of ["nativeStallDiagnosticsRequestIdRef", "nativeStallDiagnosticsSettingRef", "nativeStallDiagnosticsUpdateRef"]) {
    globals[name] = evaluate(expression(hook, name), hook, globals);
  }
  globals.queueNativeStallDiagnostics = evaluate(queueCallback, hook, globals);

  mounted = true;
  render();

  let meetings = 0;
  const recording = () => manager.getState();
  const start = async () => {
    await manager.start({
      meetingSessionId: `meeting-${++meetings}`, settings: globals.state.settings,
      providerSummary: { hasMainProvider: false, hasCodingProvider: false, hasTaxonomyAdjudicationProvider: false,
        hasSttProvider: false, mainSupportsImages: false, codingSupportsImages: false },
    });
    await tick();
    const state = recording();
    assert.equal(state.active, true);
    return { folderName: state.folderName!, sessionId: state.sessionId!, folderPath: state.folderPath! };
  };
  const stop = async () => { await manager.stop("manual"); await tick(); assert.equal(recording().active, false); };
  // The oldest request native has not answered yet.
  const head = () => {
    const request = held.find((candidate) => !candidate.settled);
    assert.ok(request, "a native request is in flight");
    return request;
  };
  // The queue reaches native one turn after a request is enqueued, and the next request one turn after a reply.
  const release = async () => { await tick(); const request = head(); request.resolve(nativeReply(request.args)); await tick(); return request.args; };
  const fail = async (error: unknown) => { await tick(); const request = head(); request.reject(error); await tick(); return request.args; };
  const drain = async () => { await tick(); while (held.some((candidate) => !candidate.settled)) await release(); };
  // Native answers the disarms at the head of the queue, up to the next arm request; how many there were.
  const releaseDisarms = async () => {
    let count = 0;
    for (await tick(); held.some((candidate) => !candidate.settled) && !head().args.enabled; count++) await release();
    return count;
  };
  // The diagnostics receipts one recording folder holds, in the order they were written.
  const timeline = (folderName: string) => files
    .filter((file) => file.args.folderName === folderName && file.args.relativePath === "timeline.jsonl")
    .flatMap((file) => String(file.args.payload).split("\n").filter(Boolean).map((line) => JSON.parse(line)))
    .filter((event) => event.kind === "capture-lifecycle" && String(event.metadata?.stage).startsWith("native-stall-diagnostics"))
    .map((event) => ({ sessionId: event.sessionId, ...event.metadata }));
  return {
    globals, manager, ipc, held, files, storageWrites, warnings, receiptWrites, actions, frames, runs,
    start, stop, recording, release, releaseDisarms, fail, drain, timeline, settle: tick, flush: render, head,
    setSwitch: (enabled: boolean) => globals.setNativeStallDiagnosticsEnabled(enabled),
    settings: () => plain(globals.state.settings),
    receipt: () => plain(globals.nativeStallDiagnosticsReceipt) as NativeStallDiagnosticsReceipt | null,
    // What the Hook exports: the real return member over the real projection expression, the state and the receipt.
    shown: exported,
    dependencies: () => plain(readDependencies().slice(1)),
    effectRuns: () => effectRuns,
    armCalls: () => ipc.filter((call) => call.args.enabled === true),
    inFlight: () => held.filter((candidate) => !candidate.settled).length,
  };
}
type Mounted = ReturnType<typeof mount>;
const evidence = (folderPath: string) => `${folderPath}/diagnostics/native-stall`;

// ---- NDI1: eligibility ----

test("NDI1 the four switch x Recording combinations reach set_native_stall_diagnostics with exact arguments through the real effect and queue", async () => {
  // Mounting sends one disarm and nothing else.
  const idle = mount();
  await idle.settle();
  assert.deepEqual(idle.ipc, [DISARM]);
  assert.equal(idle.settings().nativeStallDiagnosticsEnabled, false, "default off");
  assert.deepEqual(idle.shown(), { phase: "off" });
  assert.deepEqual(idle.files, []);

  for (const switchOn of booleans) for (const recordingOn of booleans) for (const switchFirst of booleans) {
    const label = JSON.stringify({ switchOn, recordingOn, switchFirst });
    const h = mount();
    let folderName: string | undefined;
    const steps = [
      async () => { if (switchOn) h.setSwitch(true); },
      async () => { if (recordingOn) folderName = (await h.start()).folderName; },
    ];
    for (const step of switchFirst ? steps : steps.reverse()) { await step(); await h.settle(); }
    const expected = switchOn && recordingOn ? [DISARM, DISARM, arm(folderName)]
      : switchOn || recordingOn ? [DISARM, DISARM] : [DISARM];
    assert.deepEqual(h.ipc, expected, label);
    for (const call of h.ipc) assert.deepEqual(Object.keys(call.args), ["enabled", "folderName"], label);
    assert.equal(h.armCalls().length, switchOn && recordingOn ? 1 : 0, label);
    assert.equal(h.shown().phase, !switchOn ? "off" : !recordingOn ? "waiting-for-recording" : "armed", label);
    assert.equal(h.recording().active, recordingOn, label);
    if (!recordingOn) {
      // No Recording: the switch alone starts nothing and writes nothing.
      assert.deepEqual(h.files, [], label);
      assert.equal(h.recording().lifecycle, "idle", label);
      assert.equal(h.receipt()!.status, "disarmed", label);
      assert.equal(h.receiptWrites.some((receipt) => receipt?.status === "armed"), false, label);
    } else {
      assert.equal(h.files.filter((file) => file.command === "start_meeting_session_recording").length, 1, label);
    }
    assert.deepEqual(h.warnings, [], label);
  }
});

test("NDI1 the switch with no Recording never arms and starts no recording, capture or model work", async () => {
  const h = mount();
  // The evaluated code sees no recording start, capture command, provider or timer: reaching for one throws.
  for (const absent of ["startSessionRecording", "setSessionRecordingEnabled", "startCapture", "runAdvisor", "fetch", "listen",
    "setTimeout", "setInterval"]) assert.equal(absent in h.globals, false, absent);
  for (const value of [true, false, true, true, false, true]) { h.setSwitch(value); await h.settle(); }
  assert.equal(h.settings().nativeStallDiagnosticsEnabled, true);
  assert.equal(h.ipc.length, 6, "one disarm at mount and one for each of the five changes of the value");
  assert.deepEqual(h.ipc, Array.from({ length: 6 }, () => DISARM));
  assert.deepEqual(h.armCalls(), []);
  assert.deepEqual(h.files, [], "the recorder was not asked for anything");
  assert.deepEqual([h.recording().active, h.recording().lifecycle], [false, "idle"]);
  assert.deepEqual(h.shown(), { phase: "waiting-for-recording" });
  assert.equal(h.receiptWrites.some((receipt) => receipt?.enabled || receipt?.status === "armed" || receipt?.runId), false);
  // The setter itself only stores the setting.
  assert.equal(compact(hookCall("setNativeStallDiagnosticsEnabled").arguments[0]!.getText(hook)),
    "(nativeStallDiagnosticsEnabled: boolean) => { updateSettings((previous) => ({ ...previous, nativeStallDiagnosticsEnabled })); }");
});

test("NDI1 Debug and Runtime Cross-checks neither authorize nor revoke: the IPC sequence is the same in all sixteen cells", async () => {
  let cells = 0;
  for (const switchOn of booleans) for (const recordingOn of booleans) {
    const sequences: string[] = [];
    for (const debug of booleans) for (const crossChecks of booleans) {
      const label = JSON.stringify({ switchOn, recordingOn, debug, crossChecks });
      // The two settings are already stored when the Hook mounts.
      const h = mount({ stored: { debugMode: debug, runtimeCrossChecksEnabled: crossChecks } });
      assert.deepEqual([h.settings().debugMode, h.settings().runtimeCrossChecksEnabled], [debug, crossChecks], label);
      if (switchOn) h.setSwitch(true);
      const folderName = recordingOn ? (await h.start()).folderName : undefined;
      await h.settle();
      const before = { ipc: plain(h.ipc), dependencies: h.dependencies(), shown: h.shown(), effectRuns: h.effectRuns(), receipt: h.receipt() };
      // Both are then toggled through the Hook's own setters, in every order.
      for (const [name, value] of [["setDebugMode", !debug], ["setRuntimeCrossChecksEnabled", !crossChecks],
        ["setDebugMode", debug], ["setRuntimeCrossChecksEnabled", crossChecks], ["setRuntimeCrossChecksEnabled", !crossChecks],
        ["setDebugMode", !debug]] as const) {
        h.globals[name](value);
        await h.settle();
        assert.deepEqual(h.ipc, before.ipc, `${label} ${name}(${value}) sends no diagnostics request`);
        assert.deepEqual(h.dependencies(), before.dependencies, `${label} ${name} moves no dependency of the arming effect`);
        assert.equal(h.effectRuns(), before.effectRuns, label);
        assert.deepEqual(h.shown(), before.shown, label);
        assert.deepEqual(h.receipt(), before.receipt, label);
      }
      assert.deepEqual([h.settings().debugMode, h.settings().runtimeCrossChecksEnabled], [!debug, !crossChecks], label);
      assert.equal(h.armCalls().length, switchOn && recordingOn ? 1 : 0, label);
      assert.equal(h.shown().phase, !switchOn ? "off" : !recordingOn ? "waiting-for-recording" : "armed", label);
      sequences.push(JSON.stringify(h.ipc).replaceAll(JSON.stringify(folderName ?? "no-recording"), '"<folder>"'));
      cells += 1;
    }
    assert.equal(new Set(sequences).size, 1, `one IPC sequence for ${JSON.stringify({ switchOn, recordingOn })}`);
  }
  assert.equal(cells, 16);
  // Neither setting is an input of the block or of the leaf module.
  for (const [what, text] of [["queue", queueCallback.getText(hook)], ["effect", armingEffect.getText(hook)],
    ["projection", projectionExpression.getText(hook)], ["setter", hookCall("setNativeStallDiagnosticsEnabled").getText(hook)],
    ["exported member", exportedMember.getText(hook)], ["setting ref", settingRefAssignments.map((node) => node.getText(hook)).join("\n")]]) {
    assert.doesNotMatch(text!, /debugMode|[rR]untimeCrossChecks|import\.meta/, what);
  }
  const leafIdentifiers = findAll(leaf, (node) => ts.isIdentifier(node)).map((node) => node.getText(leaf));
  assert.equal(leafIdentifiers.some((name) => /debug|crossChecks/i.test(name)), false);
});

test("NDI1 the setting is persistent: stored once, it arms every later recording from that value, with no new settings key", async () => {
  const first = mount();
  first.setSwitch(true);
  assert.equal(first.storageWrites.length, 1);
  assert.deepEqual(JSON.parse(first.storageWrites[0]!), { ...first.settings(), nativeStallDiagnosticsEnabled: true });
  assert.deepEqual(Object.keys(first.settings()).sort(), SETTINGS_KEYS, "the settings hold the keys they held before");

  // The app is opened again: nothing is armed until a recording is active, then each recording is armed in turn.
  const h = mount({ stored: first.storageWrites[0]! });
  await h.settle();
  assert.equal(h.settings().nativeStallDiagnosticsEnabled, true);
  assert.deepEqual(h.ipc, [DISARM]);
  assert.deepEqual(h.shown(), { phase: "waiting-for-recording" });
  const a = await h.start();
  await h.settle();
  await h.stop();
  await h.settle();
  const b = await h.start();
  await h.settle();
  assert.notEqual(a.folderName, b.folderName);
  assert.deepEqual(shape(h.ipc), ["disarms", `arm ${a.folderName}`, "disarms", `arm ${b.folderName}`]);
  assert.deepEqual(h.shown(), { phase: "armed", runId: "run-2", evidencePath: evidence(b.folderPath), evidenceOwner: "current-recording" });
  assert.deepEqual(h.storageWrites, [], "arming writes no setting");
});

// ---- NDI2: receipt projection ----

test("NDI2 success: waiting, then arming while native has not answered, then armed with the run id and the evidence path", async () => {
  const h = mount({ native: "hold" });
  await h.release();
  assert.deepEqual(h.shown(), { phase: "off" });
  h.setSwitch(true);
  await h.release();
  // User intent alone is not shown as armed.
  assert.deepEqual(h.shown(), { phase: "waiting-for-recording" });
  const a = await h.start();
  assert.deepEqual(h.ipc.at(-1), arm(a.folderName));
  assert.equal(h.inFlight(), 1);
  assert.deepEqual(h.shown(), { phase: "arming" });
  assert.deepEqual(h.receipt(), { requestId: 3, enabled: true, folderName: a.folderName, recordingSessionId: a.sessionId,
    folderPath: a.folderPath, status: "pending" });
  assert.deepEqual(h.timeline(a.folderName), [], "nothing is recorded before native answers");
  await h.release();
  assert.deepEqual(h.shown(), { phase: "armed", runId: "run-1", evidencePath: evidence(a.folderPath), evidenceOwner: "current-recording" });
  assert.equal(h.shown().evidencePath, `/recordings/${a.folderName}/diagnostics/native-stall`);
  assert.deepEqual(h.receipt(), { requestId: 3, enabled: true, folderName: a.folderName, recordingSessionId: a.sessionId,
    folderPath: a.folderPath, status: "armed", runId: "run-1" });
  await h.settle();
  assert.deepEqual(h.timeline(a.folderName), [{ sessionId: a.sessionId, stage: "native-stall-diagnostics", enabled: true, runId: "run-1",
    folderName: a.folderName, recordingSessionId: a.sessionId, requestId: 3 }]);
  assert.deepEqual(h.warnings, []);
  // The path is derived: the recorder was asked for no listing and native for nothing but the command.
  assert.deepEqual([...new Set(h.ipc.map((call) => call.name))], [COMMAND]);
  assert.deepEqual([...new Set(h.files.map((file) => file.command))].sort(),
    ["start_meeting_session_recording", "write_meeting_session_recording_text"]);
});

test("NDI2 failure: the message is shown for that recording only, never as armed, and the next recording does not inherit it", async () => {
  for (const [rejection, message] of [[new Error("Cannot start diagnostics observer"), "Cannot start diagnostics observer"],
    ["Session recording is not active on disk", "Session recording is not active on disk"]] as const) {
    const h = mount({ native: "hold", stored: { nativeStallDiagnosticsEnabled: true } });
    await h.release();
    const a = await h.start();
    assert.deepEqual(h.shown(), { phase: "arming" });
    await h.fail(rejection);
    assert.deepEqual(h.shown(), { phase: "failed", message });
    assert.deepEqual(h.receipt(), { requestId: 2, enabled: true, folderName: a.folderName, recordingSessionId: a.sessionId,
      folderPath: a.folderPath, status: "failed", message });
    assert.deepEqual(h.warnings, [["Native stall diagnostics could not be armed", message]]);
    await h.settle();
    assert.deepEqual(h.timeline(a.folderName), [{ sessionId: a.sessionId, stage: "native-stall-diagnostics-error", enabled: true, message,
      folderName: a.folderName, recordingSessionId: a.sessionId, requestId: 2 }]);
    assert.equal(h.receiptWrites.some((receipt) => receipt?.status === "armed"), false);

    // Stop, then a new recording: the old failure is not this recording's state.
    await h.stop();
    assert.deepEqual(h.shown(), { phase: "waiting-for-recording" }, "a failed recording leaves no evidence folder to point at");
    await h.drain();
    const b = await h.start();
    assert.deepEqual(h.shown(), { phase: "arming" });
    await h.release();
    assert.deepEqual(h.shown(), { phase: "armed", runId: "run-1", evidencePath: evidence(b.folderPath), evidenceOwner: "current-recording" });
    await h.settle();
    assert.deepEqual(h.timeline(b.folderName).map((entry) => entry.stage), ["native-stall-diagnostics"]);
    assert.equal(h.timeline(a.folderName).length, 1);
  }
});

test("NDI2 a late reply of an older request changes nothing that is shown; receipts are ordered by request id", async () => {
  const h = mount({ native: "hold", stored: { nativeStallDiagnosticsEnabled: true } });
  await h.release();
  const a = await h.start();
  // Request 2 (arm) is in flight. The switch goes off and on again before native answers.
  h.setSwitch(false);
  assert.deepEqual(h.shown(), { phase: "off" });
  h.setSwitch(true);
  assert.equal(h.globals.nativeStallDiagnosticsRequestIdRef.current, 5, "arm, two disarms, arm: the queue holds them in order");
  assert.equal(h.inFlight(), 1, "the serial queue sends one request at a time");
  assert.deepEqual(h.shown(), { phase: "arming" });
  const writesBefore = h.receiptWrites.length;

  // Native now answers request 2 with a run id. It is not the latest request.
  assert.deepEqual(await h.release(), { enabled: true, folderName: a.folderName });
  assert.deepEqual(h.shown(), { phase: "arming" }, "an older request's success is not shown as armed");
  assert.deepEqual(h.receipt(), { requestId: 5, enabled: true, folderName: a.folderName, recordingSessionId: a.sessionId,
    folderPath: a.folderPath, status: "pending" });
  // The two disarms answer; still nothing is shown as armed.
  await h.release();
  await h.release();
  assert.deepEqual(h.shown(), { phase: "arming" });
  assert.equal(h.receiptWrites.length, writesBefore, "no stale reply reached the receipt");
  // The latest request answers. Native returns the same run id for the same recording.
  await h.release();
  assert.deepEqual(h.shown(), { phase: "armed", runId: "run-1", evidencePath: evidence(a.folderPath), evidenceOwner: "current-recording" });
  assert.equal(h.receipt()!.requestId, 5);
  assert.equal(h.receiptWrites.length, writesBefore + 1);
  assert.deepEqual(h.ipc, [DISARM, arm(a.folderName), DISARM, DISARM, arm(a.folderName)]);
  await h.settle();
  // Every reply belonged to this recording and is recorded in it, each with its own request id.
  assert.deepEqual(h.timeline(a.folderName).map((entry) => [entry.requestId, entry.enabled, entry.runId, entry.folderName, entry.recordingSessionId]), [
    [2, true, "run-1", a.folderName, a.sessionId], [3, false, null, a.folderName, a.sessionId],
    [4, false, null, a.folderName, a.sessionId], [5, true, "run-1", a.folderName, a.sessionId]]);

  // The same for a late failure: an older request's error is not shown once a newer request exists.
  const f = mount({ native: "hold", stored: { nativeStallDiagnosticsEnabled: true } });
  await f.release();
  await f.start();
  f.setSwitch(false);
  f.setSwitch(true);
  await f.fail(new Error("Cannot start diagnostics observer"));
  assert.deepEqual(f.shown(), { phase: "arming" }, "an older request's failure is not shown as failed");
  await f.drain();
  assert.equal(f.shown().phase, "armed");
});

test("NDI2 rapid off / on / off inside one recording: intent is never shown as armed, and a re-arm returns the same run id", async () => {
  const h = mount({ native: "hold", stored: { nativeStallDiagnosticsEnabled: true } });
  await h.release();
  const a = await h.start();
  await h.release();
  assert.equal(h.shown().phase, "armed");
  const shown: string[] = [];
  for (const value of [false, true, false]) { h.setSwitch(value); shown.push(h.shown().phase); }
  assert.deepEqual(shown, ["off", "arming", "off"], "while native has answered none of them");
  await h.settle();
  assert.equal(h.inFlight(), 1);
  await h.drain();
  assert.deepEqual(h.shown(), { phase: "off" });
  assert.deepEqual(h.ipc, [DISARM, arm(a.folderName), DISARM, DISARM, arm(a.folderName), DISARM, DISARM]);
  assert.equal(h.receipt()!.status, "disarmed");
  assert.equal(h.receipt()!.requestId, 7);
  // The arm in the middle was answered with a run id and was never the latest request when it answered.
  assert.deepEqual(h.receiptWrites.filter((receipt) => receipt?.status === "armed").map((receipt) => receipt!.requestId), [2]);

  // On again inside the same recording: native returns the same run id; the receipt is the newer request.
  h.setSwitch(true);
  assert.deepEqual(h.shown(), { phase: "arming" }, "the earlier armed receipt of this recording is not reused");
  await h.release();
  assert.deepEqual(h.shown(), { phase: "armed", runId: "run-1", evidencePath: evidence(a.folderPath), evidenceOwner: "current-recording" });
  assert.equal(h.receipt()!.requestId, 8);
  await h.settle();
  const arms = h.timeline(a.folderName).filter((entry) => entry.enabled);
  assert.deepEqual(arms.map((entry) => [entry.requestId, entry.runId]), [[2, "run-1"], [5, "run-1"], [8, "run-1"]],
    "one run id, three requests: the request id is what orders them");
  assert.deepEqual(h.storageWrites.map((value) => JSON.parse(value).nativeStallDiagnosticsEnabled), [false, true, false, true]);
});

test("NDI2 a reply that resolves after the recording changed is not written to the new recording and is not its state", async () => {
  for (const outcome of ["resolves", "rejects"] as const) {
    const h = mount({ native: "hold", stored: { nativeStallDiagnosticsEnabled: true } });
    await h.release();
    const a = await h.start();
    assert.equal(h.inFlight(), 1, "the arm request of recording A is in flight");
    // Stop does not wait for it, and neither does the next recording.
    await h.stop();
    assert.deepEqual(h.shown(), { phase: "waiting-for-recording" }, "A was never shown as armed, so there is no last armed recording");
    const b = await h.start();
    assert.notEqual(b.folderName, a.folderName);
    assert.equal(h.inFlight(), 1, "still the same request");
    assert.deepEqual(h.shown(), { phase: "arming" });
    assert.equal(h.receipt()!.folderName, b.folderName);
    const requestOfB = h.receipt()!.requestId;
    const filesOfA = h.files.filter((file) => file.args.folderName === a.folderName).length;
    const eventsOfB = h.recording().eventCount;

    // Native answers A's request while B is the writable recording.
    if (outcome === "resolves") assert.deepEqual(await h.release(), { enabled: true, folderName: a.folderName });
    else await h.fail(new Error("Cannot start diagnostics observer"));
    await h.settle();
    assert.deepEqual(h.shown(), { phase: "arming" }, `A's reply (${outcome}) is neither armed nor failed for B`);
    assert.equal(h.receipt()!.folderName, b.folderName);
    assert.equal(h.receipt()!.status, "pending");
    assert.deepEqual(h.timeline(b.folderName), [], "nothing of A in B's timeline");
    assert.equal(h.recording().eventCount, eventsOfB, "B counted no event for it");
    assert.equal(h.files.filter((file) => file.args.folderName === a.folderName).length, filesOfA, "and A, sealed, was not written again");
    assert.deepEqual(h.timeline(a.folderName), []);

    // An idle render separates the two recordings here, so the disarms queued when A stopped were issued
    // while the manager held sealed A or no recording: none is written to B. (When Stop and Start share one
    // commit, the disarm of that commit is issued under B; the test of that commit below shows it.)
    assert.ok(await h.releaseDisarms() >= 1);
    assert.deepEqual(h.timeline(b.folderName), []);
    assert.equal(h.recording().eventCount, eventsOfB);
    assert.deepEqual(h.shown(), { phase: "arming" });
    // B's own request.
    assert.deepEqual(await h.release(), { enabled: true, folderName: b.folderName });
    await h.settle();
    const runId = outcome === "resolves" ? "run-2" : "run-1";
    assert.deepEqual(h.shown(), { phase: "armed", runId, evidencePath: evidence(b.folderPath), evidenceOwner: "current-recording" });
    assert.deepEqual(h.timeline(b.folderName), [{ sessionId: b.sessionId, stage: "native-stall-diagnostics", enabled: true, runId,
      folderName: b.folderName, recordingSessionId: b.sessionId, requestId: requestOfB }]);
    assert.deepEqual(shape(h.ipc), ["disarms", `arm ${a.folderName}`, "disarms", `arm ${b.folderName}`]);
    assert.deepEqual(h.warnings.length, outcome === "rejects" ? 1 : 0);
  }
});

test("NDI2 Stop then a new recording: the evidence folder of the last armed recording stays until the next arming request", async () => {
  const h = mount({ native: "hold", stored: { nativeStallDiagnosticsEnabled: true } });
  await h.release();
  const a = await h.start();
  await h.release();
  assert.deepEqual(h.shown(), { phase: "armed", runId: "run-1", evidencePath: evidence(a.folderPath), evidenceOwner: "current-recording" });

  // Stop: not armed any more, and the folder is named as that of the last armed recording.
  await h.stop();
  const afterStop = { phase: "waiting-for-recording", evidencePath: evidence(a.folderPath), evidenceOwner: "last-armed-recording" };
  assert.deepEqual(h.shown(), afterStop, "before native has answered the disarm");
  assert.equal(h.inFlight(), 1, "Stop did not wait for the diagnostics queue");
  await h.drain();
  assert.deepEqual(h.shown(), afterStop);
  const { requestId: lastDisarm, ...kept } = h.receipt()!;
  assert.deepEqual(kept, { enabled: false, status: "disarmed",
    lastArmed: { folderName: a.folderName, recordingSessionId: a.sessionId, folderPath: a.folderPath, runId: "run-1" } });
  assert.deepEqual(shape(h.ipc), ["disarms", `arm ${a.folderName}`, "disarms"]);
  assert.deepEqual(h.timeline(a.folderName).map((entry) => entry.requestId), [2], "the disarm after Stop is not in the sealed recording");

  // The next arming request: the old folder is gone at once, before native answers.
  const b = await h.start();
  assert.deepEqual(h.shown(), { phase: "arming" });
  assert.equal(h.receipt()!.lastArmed, undefined);
  assert.equal(h.receipt()!.requestId, lastDisarm + 1);
  await h.release();
  assert.deepEqual(h.shown(), { phase: "armed", runId: "run-2", evidencePath: evidence(b.folderPath), evidenceOwner: "current-recording" });
  await h.settle();
  assert.deepEqual(h.timeline(b.folderName).map((entry) => [entry.requestId, entry.runId, entry.recordingSessionId]), [[lastDisarm + 1, "run-2", b.sessionId]]);
  assert.deepEqual(h.timeline(a.folderName).length, 1);

  // An arming request that fails also ends the old folder's display: Stop after it names no folder.
  const f = mount({ native: "hold", stored: { nativeStallDiagnosticsEnabled: true } });
  await f.release();
  await f.start();
  await f.release();
  await f.stop();
  await f.drain();
  assert.equal(f.shown().evidenceOwner, "last-armed-recording");
  await f.start();
  await f.fail("Cannot start diagnostics observer");
  assert.deepEqual(f.shown(), { phase: "failed", message: "Cannot start diagnostics observer" });
  await f.stop();
  await f.drain();
  assert.deepEqual(f.shown(), { phase: "waiting-for-recording" });
});

test("NDI2 turning the switch off forgets the last armed recording for good: after Stop, during the recording and across a later recording", async () => {
  const waiting = { phase: "waiting-for-recording" };
  const lastArmed = (folderPath: string) => ({ ...waiting, evidencePath: evidence(folderPath), evidenceOwner: "last-armed-recording" });

  // After Stop: off hides the folder, and on again does not bring it back.
  const h = mount({ stored: { nativeStallDiagnosticsEnabled: true } });
  const a = await h.start();
  await h.settle();
  await h.stop();
  await h.settle();
  assert.deepEqual(h.shown(), lastArmed(a.folderPath));
  h.setSwitch(false);
  assert.deepEqual(h.shown(), { phase: "off" });
  assert.equal(h.receipt()!.lastArmed, undefined, "the disarm issued with the switch off dropped it");
  await h.settle();
  h.setSwitch(true);
  await h.settle();
  assert.deepEqual(h.shown(), waiting, "on again with no new arming request: no folder is named");
  assert.equal(h.receipt()!.lastArmed, undefined);
  assert.deepEqual(shape(h.ipc), ["disarms", `arm ${a.folderName}`, "disarms"], "forgetting sent nothing but the disarms the effect already sends");

  // Off while the armed recording is still running, then Stop, then on.
  const d = mount({ stored: { nativeStallDiagnosticsEnabled: true } });
  const first = await d.start();
  await d.settle();
  assert.equal(d.shown().phase, "armed");
  d.setSwitch(false);
  await d.settle();
  assert.equal(d.receipt()!.lastArmed, undefined, "an armed receipt is not carried by a disarm issued with the switch off");
  await d.stop();
  await d.settle();
  assert.deepEqual(d.shown(), { phase: "off" });
  d.setSwitch(true);
  await d.settle();
  assert.deepEqual(d.shown(), waiting, "the recording that was armed before the switch went off is not named");
  // A whole later recording with the switch off, then on again: still nothing of the first.
  d.setSwitch(false);
  await d.start();
  await d.settle();
  await d.stop();
  await d.settle();
  d.setSwitch(true);
  await d.settle();
  assert.deepEqual(d.shown(), waiting);
  const firstOff = d.frames.findIndex((frame) => !frame.setting);
  assert.ok(firstOff > 0);
  assert.equal(d.frames.slice(firstOff).some((frame) => frame.shown.evidencePath !== undefined), false,
    "no frame rendered after the switch went off names a folder");
  assert.equal(d.armCalls().length, 1, "and only the first recording was armed");
  // A new arming is a new last armed recording.
  const third = await d.start();
  await d.settle();
  assert.equal(d.shown().phase, "armed");
  await d.stop();
  await d.settle();
  assert.deepEqual(d.shown(), lastArmed(third.folderPath));
  assert.notEqual(third.folderPath, first.folderPath);

  // Forgetting does not wait for native: the Stop disarms are still unanswered when the switch goes off and on.
  const p = mount({ native: "hold", stored: { nativeStallDiagnosticsEnabled: true } });
  await p.release();
  const held = await p.start();
  await p.release();
  await p.stop();
  assert.deepEqual(p.shown(), lastArmed(held.folderPath));
  assert.equal(p.inFlight(), 1);
  p.setSwitch(false);
  p.setSwitch(true);
  assert.deepEqual(p.shown(), waiting);
  await p.drain();
  assert.deepEqual(p.shown(), waiting);
  assert.equal(p.receiptWrites.at(-1)!.lastArmed, undefined);
});

test("NDI2 Stop A and Start B in one commit: B's first frame is arming, no frame shows A's run or folder for B, and the one disarm of that commit is recorded as B's", async () => {
  const brief = (entry: Record<string, any>) => [entry.requestId, entry.stage, entry.enabled, entry.runId, entry.folderName, entry.recordingSessionId, entry.sessionId];
  for (const answered of booleans) {
    const label = answered ? "A armed" : "A's arm request unanswered";
    const h = mount({ native: "hold", commits: "manual", stored: { nativeStallDiagnosticsEnabled: true } });
    await h.release();
    h.flush();
    const a = await h.start();
    h.flush();
    if (answered) {
      await h.release();
      h.flush();
      assert.deepEqual(h.shown(), { phase: "armed", runId: "run-1", evidencePath: evidence(a.folderPath), evidenceOwner: "current-recording" }, label);
    } else assert.deepEqual(h.shown(), { phase: "arming" }, label);

    // No render between Stop and the next Start: the Hook's state goes from A active to B active.
    await h.stop();
    const b = await h.start();
    const before = h.frames.length;
    h.flush();
    const rendered = h.frames.slice(before);
    assert.deepEqual(rendered.map((frame) => [frame.folderName, frame.active, frame.shown]),
      [[b.folderName, true, { phase: "arming" }], [b.folderName, true, { phase: "arming" }]], label);
    // The first of the two is the render the folder comparison exists for: B is current and the receipt is still A's.
    assert.deepEqual([rendered[0]!.receipt!.folderName, rendered[0]!.receipt!.status, rendered[0]!.receipt!.runId],
      answered ? [a.folderName, "armed", "run-1"] : [a.folderName, "pending", undefined], label);
    assert.deepEqual([rendered[1]!.receipt!.folderName, rendered[1]!.receipt!.status, rendered[1]!.receipt!.requestId], [b.folderName, "pending", 4], label);

    if (!answered) {
      // A's own reply arrives now, while B is the writable recording: neither shown nor recorded.
      assert.deepEqual(await h.release(), { enabled: true, folderName: a.folderName }, label);
      h.flush();
      await h.settle();
      assert.deepEqual(h.shown(), { phase: "arming" }, label);
      assert.deepEqual(h.timeline(b.folderName), [], label);
    }
    // That commit issued one disarm, the cleanup of A's effect, while the manager already held B. It is
    // recorded in B as B's disarm: no run id and nothing of A. Before this slice the same reply also
    // landed in B, without identity.
    assert.deepEqual(await h.release(), DISARM.args, label);
    h.flush();
    await h.settle();
    assert.deepEqual(h.shown(), { phase: "arming" }, label);
    const disarmOfB = [3, "native-stall-diagnostics", false, null, b.folderName, b.sessionId, b.sessionId];
    assert.deepEqual(h.timeline(b.folderName).map(brief), [disarmOfB], label);
    // B's own reply.
    assert.deepEqual(await h.release(), { enabled: true, folderName: b.folderName }, label);
    h.flush();
    await h.settle();
    const armedB = { phase: "armed", runId: "run-2", evidencePath: evidence(b.folderPath), evidenceOwner: "current-recording" };
    assert.deepEqual(h.shown(), armedB, label);
    assert.deepEqual(h.timeline(b.folderName).map(brief),
      [disarmOfB, [4, "native-stall-diagnostics", true, "run-2", b.folderName, b.sessionId, b.sessionId]], label);
    assert.deepEqual(h.timeline(a.folderName).map(brief),
      answered ? [[2, "native-stall-diagnostics", true, "run-1", a.folderName, a.sessionId, a.sessionId]] : [], label);
    assert.deepEqual(h.ipc, [DISARM, arm(a.folderName), DISARM, arm(b.folderName)], label);
    assert.deepEqual([h.runs.get(a.folderName), h.runs.get(b.folderName)], ["run-1", "run-2"], label);
    // In no frame is B shown with A's run id or A's folder.
    const framesOfB = h.frames.filter((frame) => frame.folderName === b.folderName);
    assert.ok(framesOfB.length >= 3, label);
    for (const frame of framesOfB) {
      assert.notEqual(frame.shown.runId, "run-1", label);
      assert.notEqual(frame.shown.evidencePath, evidence(a.folderPath), label);
      if (frame.shown.phase !== "arming") assert.deepEqual(frame.shown, armedB, label);
    }
    assert.deepEqual(h.warnings, [], label);
  }
});

test("NDI2 Stop sends disarms only: three, two or one, as the recording states fall into commits", async () => {
  // The count is a property of the unchanged arming effect and of how React batches the manager's states
  // (sealed with the folder still named, then cleared). It is not a contract; the display ends the same way.
  const stored = { nativeStallDiagnosticsEnabled: true };
  // Every state its own render: cleanup and body for the sealed state, body again for the cleared one.
  const each = mount({ stored });
  const a = await each.start();
  await each.settle();
  await each.stop();
  await each.settle();
  assert.deepEqual(each.ipc, [DISARM, arm(a.folderName), DISARM, DISARM, DISARM]);
  // Stop rendered as one commit: cleanup and body.
  const one = mount({ commits: "manual", stored });
  one.flush();
  const b = await one.start();
  one.flush();
  await one.settle();
  one.flush();
  await one.stop();
  one.flush();
  await one.settle();
  one.flush();
  assert.deepEqual(one.ipc, [DISARM, arm(b.folderName), DISARM, DISARM]);
  // Stop and the next Start rendered as one commit: the cleanup alone, then the new arm.
  const both = mount({ commits: "manual", stored });
  both.flush();
  const c = await both.start();
  both.flush();
  await both.settle();
  both.flush();
  await both.stop();
  const next = await both.start();
  both.flush();
  await both.settle();
  both.flush();
  assert.deepEqual(both.ipc, [DISARM, arm(c.folderName), DISARM, arm(next.folderName)]);

  const lastArmed = (folderPath: string) => ({ phase: "waiting-for-recording", evidencePath: evidence(folderPath), evidenceOwner: "last-armed-recording" });
  assert.deepEqual(each.shown(), lastArmed(a.folderPath));
  assert.deepEqual(one.shown(), lastArmed(b.folderPath));
  assert.deepEqual(both.shown(), { phase: "armed", runId: "run-2", evidencePath: evidence(next.folderPath), evidenceOwner: "current-recording" });
  for (const h of [each, one, both]) {
    assert.deepEqual(h.ipc.filter((call) => !call.args.enabled), h.ipc.filter((call) => !call.args.enabled).map(() => DISARM));
    assert.equal(h.armCalls().length, h === both ? 2 : 1);
  }
});

test("NDI2 an arming reply without a run id is shown as failed, never as armed or as the last armed recording; its recording entry keeps the existing stage", async () => {
  const h = mount({ native: "hold", stored: { nativeStallDiagnosticsEnabled: true } });
  await h.release();
  const a = await h.start();
  await h.settle();
  // Native returns a run id for every successful arm. A fixture that answers null is the only way here.
  assert.deepEqual(h.head().args, { enabled: true, folderName: a.folderName });
  h.head().resolve(null);
  await h.settle();
  assert.deepEqual(h.shown(), { phase: "failed", message: NATIVE_STALL_DIAGNOSTICS_NO_RUN_ID_MESSAGE });
  assert.deepEqual(h.receipt(), { requestId: 2, enabled: true, folderName: a.folderName, recordingSessionId: a.sessionId,
    folderPath: a.folderPath, status: "failed", message: NATIVE_STALL_DIAGNOSTICS_NO_RUN_ID_MESSAGE });
  // The recording write is what it was before this slice plus the identity: the success stage with a null
  // run id, and no console warning. Only the display treats it as a failure.
  await h.settle();
  assert.deepEqual(h.timeline(a.folderName), [{ sessionId: a.sessionId, stage: "native-stall-diagnostics", enabled: true, runId: null,
    folderName: a.folderName, recordingSessionId: a.sessionId, requestId: 2 }]);
  assert.deepEqual(h.warnings, []);
  await h.stop();
  await h.drain();
  assert.deepEqual(h.shown(), { phase: "waiting-for-recording" }, "nothing was armed, so no folder is named");
  assert.equal(h.receiptWrites.some((receipt) => receipt?.status === "armed" || receipt?.lastArmed), false);
});

// A small deterministic generator, so a failing run can be replayed from its seed.
function generator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test("NDI2 every rendered frame of random runs in both commit modes: armed and failed belong to the current recording, a folder is never named once the switch was rendered off, and each timeline holds its own recording only", async (t) => {
  const RUNS = 150;
  const STEPS = 36;
  const seen = { frames: 0, armed: 0, failed: 0, lastArmed: 0, armedReceiptOfAnotherRecording: 0, failedReceiptOfAnotherRecording: 0,
    onAfterOff: 0, timelineEntries: 0, recordings: 0 };
  for (const commits of ["each", "manual"] as const) for (let seed = 1; seed <= RUNS; seed++) {
    const label = `${commits} seed ${seed}`;
    const random = generator(seed + (commits === "manual" ? 100000 : 0));
    const h = mount({ native: "hold", commits, stored: { nativeStallDiagnosticsEnabled: random() < 0.5 } });
    const recordings = new Map<string, { sessionId: string; folderPath: string }>();
    // The messages native rejected arm requests with, by the folder each request named.
    const rejected = new Map<string, string[]>();
    let rejections = 0;
    for (let step = 0; step < STEPS; step++) {
      const roll = random();
      const start = async () => { const started = await h.start(); recordings.set(started.folderName, started); };
      if (roll < 0.18) h.setSwitch(random() < 0.5);
      else if (roll < 0.36) {
        if (!h.recording().active) await start();
      } else if (roll < 0.46) {
        if (h.recording().active) await h.stop();
      } else if (roll < 0.56) {
        // Stop and the next Start with no flush between them: one commit in manual mode.
        if (h.recording().active) { await h.stop(); await start(); }
      } else if (roll < 0.84) {
        await h.settle();
        if (h.inFlight() === 0) continue;
        const request = h.head();
        if (request.args.enabled && random() < 0.3) {
          const message = `rejected-${++rejections}`;
          rejected.set(request.args.folderName!, [...(rejected.get(request.args.folderName!) ?? []), message]);
          await h.fail(random() < 0.5 ? new Error(message) : message);
        } else if (!request.args.enabled && random() < 0.1) await h.fail(`disarm-rejected-${++rejections}`);
        else await h.release();
      } else h.flush();
    }
    h.flush();
    await h.drain();
    h.flush();
    await h.settle();
    h.flush();

    // The latest frame rendered with the switch off.
    let offAt = -1;
    h.frames.forEach((frame, index) => {
      const where = `${label} frame ${index} ${JSON.stringify(frame)}`;
      const shown = frame.shown;
      seen.frames += 1;
      if (!frame.setting) { offAt = index; assert.deepEqual(shown, { phase: "off" }, where); return; }
      if (!frame.active || frame.folderName === undefined) {
        assert.equal(shown.phase, "waiting-for-recording", where);
        assert.deepEqual([shown.runId, shown.message], [undefined, undefined], where);
        const armedWrite = frame.lastArmedWrite;
        if (shown.evidencePath !== undefined) {
          seen.lastArmed += 1;
          assert.equal(shown.evidenceOwner, "last-armed-recording", where);
          assert.ok(armedWrite?.folderPath, where);
          assert.equal(shown.evidencePath, evidence(armedWrite.folderPath), where);
          assert.ok(offAt < armedWrite.frame, `the switch was rendered off after that arming: ${where}`);
        } else {
          assert.equal(shown.evidenceOwner, undefined, where);
          if (armedWrite && offAt >= armedWrite.frame) seen.onAfterOff += 1;
        }
        return;
      }
      // The frames the folder comparison exists for: this recording is current and the receipt is another one's.
      if (frame.receipt?.enabled && frame.receipt.folderName !== frame.folderName) {
        if (frame.receipt.status === "armed") seen.armedReceiptOfAnotherRecording += 1;
        if (frame.receipt.status === "failed") seen.failedReceiptOfAnotherRecording += 1;
      }
      if (shown.phase === "armed") {
        seen.armed += 1;
        // The run id native gave this folder, and this recording's own path.
        assert.deepEqual(shown, { phase: "armed", runId: h.runs.get(frame.folderName), evidencePath: evidence(frame.folderPath!),
          evidenceOwner: "current-recording" }, where);
      } else if (shown.phase === "failed") {
        seen.failed += 1;
        assert.deepEqual(Object.keys(shown).sort(), ["message", "phase"], where);
        assert.ok(rejected.get(frame.folderName)?.includes(shown.message!), `a rejection of another recording or of a disarm: ${where}`);
      } else assert.deepEqual(shown, { phase: "arming" }, where);
    });

    for (const [folderName, recording] of recordings) {
      seen.recordings += 1;
      let previousRequest = 0;
      for (const entry of h.timeline(folderName)) {
        const where = `${label} ${folderName} ${JSON.stringify(entry)}`;
        seen.timelineEntries += 1;
        assert.deepEqual([entry.folderName, entry.recordingSessionId, entry.sessionId], [folderName, recording.sessionId, recording.sessionId], where);
        assert.ok(entry.requestId > previousRequest, where);
        previousRequest = entry.requestId;
        if (entry.stage === "native-stall-diagnostics") assert.equal(entry.runId, entry.enabled ? h.runs.get(folderName) : null, where);
        else {
          assert.equal(entry.stage, "native-stall-diagnostics-error", where);
          if (entry.enabled) assert.ok(rejected.get(folderName)?.includes(entry.message), where);
        }
      }
    }
    for (const call of h.ipc) assert.deepEqual(Object.keys(call.args), ["enabled", "folderName"], label);
  }
  t.diagnostic(`random runs ${JSON.stringify(seen)}`);
  // The runs reached the frames each rule is about.
  for (const [what, count] of Object.entries(seen)) assert.ok(count > 0, `${what} was exercised: ${JSON.stringify(seen)}`);
});

test("NDI2 a request native never answers stays at arming: no timer settles it, and Stop and a new recording proceed", async () => {
  const h = mount({ native: "hold", stored: { nativeStallDiagnosticsEnabled: true } });
  await h.release();
  await h.start();
  for (let turn = 0; turn < 5; turn++) await h.settle();
  assert.deepEqual(h.shown(), { phase: "arming" });
  assert.equal(h.ipc.length, 2, "no retry and no poll");
  await h.stop();
  assert.equal(h.recording().active, false);
  assert.deepEqual(h.shown(), { phase: "waiting-for-recording" });
  const b = await h.start();
  assert.equal(h.recording().active, true);
  assert.deepEqual(h.shown(), { phase: "arming" });
  assert.equal(h.ipc.length, 2, "later requests wait in the same serial queue");
  assert.equal(h.receipt()!.folderName, b.folderName);
});

test("NDI2 the existing queue is reused: one command call site, two receipt writers, no timer, listener, poll or second owner", () => {
  // The IPC call and the arming effect read exactly as they did.
  const invokes = findAll(queueCallback, (node) => ts.isCallExpression(node) && node.expression.getText(hook) === "invoke");
  assert.equal(invokes.length, 1);
  assert.equal(compact(invokes[0]!.getText(hook)),
    'invoke<string | null>("set_native_stall_diagnostics", { enabled, folderName: enabled ? folderName : null, })');
  assert.equal(compact(armingEffect.getText(hook)), compact(`useEffect(() => {
    const enabled = state.settings.nativeStallDiagnosticsEnabled &&
      state.sessionRecording.active && Boolean(state.sessionRecording.folderName);
    queueNativeStallDiagnostics(enabled, state.sessionRecording.folderName);
    return () => {
      if (enabled) queueNativeStallDiagnostics(false);
    };
  }, [
    queueNativeStallDiagnostics,
    state.settings.nativeStallDiagnosticsEnabled,
    state.sessionRecording.active,
    state.sessionRecording.folderName,
  ])`));
  assert.equal(queueDeclaration.arguments[1]!.getText(hook), "[]", "the queue function keeps one identity");
  assert.match(compact(queueCallback.getText(hook)),
    /nativeStallDiagnosticsUpdateRef\.current = nativeStallDiagnosticsUpdateRef\.current \.catch\(\(\) => undefined\) \.then\(async \(\) => \{/);

  // One call site of the command in the whole frontend, and no other diagnostics command or event.
  const sources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(path.join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(directory, entry.name)] : []);
  const mentions = sources("src").flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/["'`]([a-z_-]*native[_-]stall[a-z_-]*)["'`]/g)].map((match) => `${file}: ${match[1]}`));
  assert.deepEqual(mentions.sort(), [
    `${HOOK}: acknowledge_native_stall_marker`,
    `${HOOK}: native-stall-diagnostics`,
    `${HOOK}: native-stall-diagnostics-error`,
    `${HOOK}: set_native_stall_diagnostics`,
  ]);

  // Exactly two writers of the receipt, both inside the queue function; the second is behind the request-id comparison.
  const inside = (node: ts.Node, ancestor: ts.Node) => node.pos >= ancestor.pos && node.end <= ancestor.end;
  const writers = findAll(hook, (node) => ts.isCallExpression(node) && node.expression.getText(hook) === "setNativeStallDiagnosticsReceipt");
  assert.equal(writers.length, 2);
  assert.ok(writers.every((writer) => inside(writer, queueCallback)));
  assert.match(compact(writers[0]!.getText(hook)), /^setNativeStallDiagnosticsReceipt\(\(previous\) => beginNativeStallDiagnosticsRequest\(previous, request, settingEnabled\)\)$/);
  const settle = only<ts.VariableDeclaration>(findAll(queueCallback, (node) => ts.isVariableDeclaration(node) && node.name.getText(hook) === "settle"), "settle");
  assert.ok(inside(writers[1]!, settle));
  assert.match(compact(settle.getText(hook)),
    /if \(requestId !== nativeStallDiagnosticsRequestIdRef\.current\) return; setNativeStallDiagnosticsReceipt\(\(previous\) => settleNativeStallDiagnosticsRequest\(previous, requestId, outcome\)\);/);

  // The receipt, the counter, the setting mirror and the queue tail are used by nothing outside this block.
  const uses = (name: string) => findAll(hook, (node) => ts.isIdentifier(node) && node.text === name);
  const settingRefAssignment = only<ts.BinaryExpression>(settingRefAssignments, "render-time assignment of the setting ref");
  const block = [receiptState, queueDeclaration.parent, armingEffect, projectionExpression.parent,
    hookCall("nativeStallDiagnosticsRequestIdRef").parent, hookCall("nativeStallDiagnosticsUpdateRef").parent,
    hookCall("nativeStallDiagnosticsSettingRef").parent, settingRefAssignment];
  for (const name of ["nativeStallDiagnosticsReceipt", "setNativeStallDiagnosticsReceipt", "nativeStallDiagnosticsRequestIdRef",
    "nativeStallDiagnosticsSettingRef", "nativeStallDiagnosticsUpdateRef", "queueNativeStallDiagnostics"]) {
    assert.ok(uses(name).every((use) => block.some((owner) => inside(use, owner))), `${name} stays inside the diagnostics block`);
  }
  // The setting mirror: declared from the setting, assigned once, in every render and under no condition, and
  // read once, at enqueue. Its value reaches the first receipt writer and nothing else: not the IPC arguments,
  // not the recording write and no condition of the queue.
  const hookBody = (expression(hook, "useMeetingAssistant") as ts.FunctionDeclaration).body!;
  assert.equal(compact(hookCall("nativeStallDiagnosticsSettingRef").getText(hook)), "useRef( state.settings.nativeStallDiagnosticsEnabled )");
  assert.equal(compact(settingRefAssignment.getText(hook)), "nativeStallDiagnosticsSettingRef.current = state.settings.nativeStallDiagnosticsEnabled");
  assert.ok(ts.isExpressionStatement(settingRefAssignment.parent) && settingRefAssignment.parent.parent === hookBody, "a statement of the Hook body itself");
  assert.equal(uses("nativeStallDiagnosticsSettingRef").length, 3, "its declaration, its assignment and one read");
  assert.equal(uses("nativeStallDiagnosticsSettingRef").filter((use) => inside(use, queueCallback)).length, 1);
  const settingRead = only<ts.VariableDeclaration>(findAll(queueCallback, (node) => ts.isVariableDeclaration(node) &&
    node.name.getText(hook) === "settingEnabled"), "setting read at enqueue");
  assert.equal(compact(settingRead.getText(hook)), "settingEnabled = nativeStallDiagnosticsSettingRef.current");
  const settingUses = findAll(queueCallback, (node) => ts.isIdentifier(node) && node.text === "settingEnabled");
  assert.equal(settingUses.length, 2, "declared, then passed to the first writer");
  assert.ok(inside(settingUses[1]!, writers[0]!));
  // The receipt value is read in one place, the projection: nothing decides a request from it.
  assert.equal(uses("nativeStallDiagnosticsReceipt").filter((use) => !inside(use, receiptState)).length, 1);
  assert.ok(inside(uses("nativeStallDiagnosticsReceipt").find((use) => !inside(use, receiptState))!, projectionExpression));
  // So Stop, Quit and cancel cannot await the queue: its tail is touched by the queue function alone.
  assert.equal(uses("nativeStallDiagnosticsUpdateRef").filter((use) => !inside(use, queueCallback)).length, 1, "its declaration");
  assert.equal(uses("queueNativeStallDiagnostics").filter((use) => !inside(use, armingEffect)).length, 1, "its declaration");

  // No timer, listener, event or second command in the block, and nothing in the leaf module at all.
  const blockText = [queueCallback, armingEffect, projectionExpression].map((node) => node.getText(hook)).join("\n");
  assert.doesNotMatch(blockText, /setTimeout|setInterval|requestAnimationFrame|\blisten\(|\bemit\(|addEventListener|useLayoutEffect/);
  assert.equal(findAll(leaf, (node) => ts.isImportDeclaration(node) || ts.isAwaitExpression(node)).length, 0, "the leaf module imports and awaits nothing");
  assert.doesNotMatch(leafText, /invoke|setTimeout|setInterval|Date\.now|localStorage|window\./);
  // The Hook exports the projection, not the receipt and not an error string.
  const exported = (hookReturn.expression as ts.ObjectLiteralExpression).properties.map((property) => property.name?.getText(hook) ?? "")
    .filter((name) => /nativeStall/i.test(name));
  assert.deepEqual(exported, ["setNativeStallDiagnosticsEnabled", "nativeStallDiagnostics"]);
  // It hands the page the projection itself: a shorthand member, so no condition (Debug, DEV, Cross-checks or
  // any other) stands between the phase function and the panel.
  assert.ok(ts.isShorthandPropertyAssignment(exportedMember), "the return member is the projection, under no condition");
  // The projection is declared once, in every render, from exactly the four inputs of the phase function.
  const projectionStatement = projectionExpression.parent.parent.parent;
  assert.ok(ts.isVariableStatement(projectionStatement) && projectionStatement.parent === hookBody, "a statement of the Hook body itself");
  assert.equal(uses("nativeStallDiagnostics").length, 2, "its declaration and the return member");
  assert.equal(compact(projectionExpression.getText(hook)), compact(`projectNativeStallDiagnostics({
    settingEnabled: state.settings.nativeStallDiagnosticsEnabled,
    recordingActive: state.sessionRecording.active,
    folderName: state.sessionRecording.folderName,
    receipt: nativeStallDiagnosticsReceipt,
  })`));
  // The projection is kept out of the settings and out of the Hook's state object.
  assert.doesNotMatch(expression(hook, "INITIAL_STATE").getText(hook), /nativeStallDiagnostics(?!Enabled)/);
});

// ---- NDI2: the pure functions of the leaf module ----

const receipt = (fields: Partial<NativeStallDiagnosticsReceipt>): NativeStallDiagnosticsReceipt =>
  ({ requestId: 1, enabled: true, status: "pending", ...fields });

test("NDI2 the phase function over every combination: armed and failed only for a settled arming receipt of the current recording", () => {
  // The rows a reader would write by hand.
  const armedA = receipt({ folderName: "A", recordingSessionId: "sA", folderPath: "/r/A", status: "armed", runId: "run-A" });
  const lastArmed = { folderName: "A", recordingSessionId: "sA", folderPath: "/r/A", runId: "run-A" };
  const rows: Array<[string, Parameters<typeof projectNativeStallDiagnostics>[0], NativeStallDiagnosticsProjection]> = [
    ["switch off", { settingEnabled: false, recordingActive: true, folderName: "A", receipt: armedA }, { phase: "off" }],
    ["switch off, last armed kept", { settingEnabled: false, recordingActive: false, receipt: receipt({ enabled: false, status: "disarmed", lastArmed }) }, { phase: "off" }],
    ["on, no recording, no receipt", { settingEnabled: true, recordingActive: false, receipt: null }, { phase: "waiting-for-recording" }],
    ["on, no recording, disarmed", { settingEnabled: true, recordingActive: false, receipt: receipt({ enabled: false, status: "disarmed" }) }, { phase: "waiting-for-recording" }],
    ["on, no recording, an old failure", { settingEnabled: true, recordingActive: false, receipt: receipt({ folderName: "A", status: "failed", message: "x" }) }, { phase: "waiting-for-recording" }],
    ["on, recording closing failed (inactive, folder kept)", { settingEnabled: true, recordingActive: false, folderName: "A", receipt: receipt({ enabled: false, status: "disarmed", lastArmed }) },
      { phase: "waiting-for-recording", evidencePath: "/r/A/diagnostics/native-stall", evidenceOwner: "last-armed-recording" }],
    ["on, stopped, the armed receipt not yet replaced", { settingEnabled: true, recordingActive: false, receipt: armedA },
      { phase: "waiting-for-recording", evidencePath: "/r/A/diagnostics/native-stall", evidenceOwner: "last-armed-recording" }],
    ["on, stopped, disarm pending", { settingEnabled: true, recordingActive: false, receipt: receipt({ enabled: false, lastArmed }) },
      { phase: "waiting-for-recording", evidencePath: "/r/A/diagnostics/native-stall", evidenceOwner: "last-armed-recording" }],
    ["on, stopped, a settled arming receipt without a run id (the writers never produce it)", { settingEnabled: true, recordingActive: false,
      receipt: receipt({ folderName: "A", folderPath: "/r/A", status: "armed" }) }, { phase: "waiting-for-recording" }],
    ["on, stopped, the last armed recording forgotten by a switch-off", { settingEnabled: true, recordingActive: false, receipt: receipt({ enabled: false, status: "disarmed" }) },
      { phase: "waiting-for-recording" }],
    ["on, recording, no receipt", { settingEnabled: true, recordingActive: true, folderName: "A", receipt: null }, { phase: "arming" }],
    ["on, recording, a disarm receipt", { settingEnabled: true, recordingActive: true, folderName: "A", receipt: receipt({ enabled: false, folderName: "A", status: "disarmed", lastArmed }) }, { phase: "arming" }],
    ["on, recording, pending", { settingEnabled: true, recordingActive: true, folderName: "A", receipt: receipt({ folderName: "A" }) }, { phase: "arming" }],
    ["on, recording B, armed receipt of A", { settingEnabled: true, recordingActive: true, folderName: "B", receipt: armedA }, { phase: "arming" }],
    ["on, recording B, failed receipt of A", { settingEnabled: true, recordingActive: true, folderName: "B", receipt: receipt({ folderName: "A", status: "failed", message: "x" }) }, { phase: "arming" }],
    ["on, recording, armed", { settingEnabled: true, recordingActive: true, folderName: "A", receipt: armedA },
      { phase: "armed", runId: "run-A", evidencePath: "/r/A/diagnostics/native-stall", evidenceOwner: "current-recording" }],
    ["on, recording, armed, no path captured", { settingEnabled: true, recordingActive: true, folderName: "A", receipt: receipt({ folderName: "A", status: "armed", runId: "run-A" }) },
      { phase: "armed", runId: "run-A" }],
    ["on, recording, failed", { settingEnabled: true, recordingActive: true, folderName: "A", receipt: receipt({ folderName: "A", folderPath: "/r/A", status: "failed", message: "Cannot start diagnostics observer" }) },
      { phase: "failed", message: "Cannot start diagnostics observer" }],
    ["on, recording, settled without a run id", { settingEnabled: true, recordingActive: true, folderName: "A", receipt: receipt({ folderName: "A", status: "armed" }) },
      { phase: "failed", message: NATIVE_STALL_DIAGNOSTICS_NO_RUN_ID_MESSAGE }],
  ];
  for (const [name, input, expected] of rows) assert.deepEqual(projectNativeStallDiagnostics(input), expected, name);

  // Every combination of the four inputs.
  const statuses: NativeStallDiagnosticsReceiptStatus[] = ["pending", "armed", "disarmed", "failed"];
  const receipts: Array<NativeStallDiagnosticsReceipt | null> = [null];
  for (const enabled of booleans) for (const status of statuses) for (const folderName of [undefined, "A", "B"])
    for (const runId of [undefined, "run-1"]) for (const folderPath of [undefined, "/r/x"]) for (const carried of [undefined, lastArmed, { folderName: "A", runId: "run-A" }]) {
      receipts.push({ requestId: 7, enabled, status, ...(folderName ? { folderName } : {}), ...(runId ? { runId } : {}),
        ...(folderPath ? { folderPath } : {}), ...(status === "failed" ? { message: "m" } : {}), ...(carried ? { lastArmed: carried } : {}) });
    }
  let combinations = 0;
  const phases = new Set<string>();
  for (const settingEnabled of booleans) for (const recordingActive of booleans) for (const folderName of [undefined, "A"]) for (const kept of receipts) {
    const label = JSON.stringify({ settingEnabled, recordingActive, folderName, kept });
    const shown = projectNativeStallDiagnostics({ settingEnabled, recordingActive, folderName, receipt: kept });
    combinations += 1;
    phases.add(shown.phase);
    const current = settingEnabled && recordingActive && folderName !== undefined;
    const own = current && kept !== null && kept.enabled && kept.folderName === folderName;
    if (!settingEnabled) assert.deepEqual(shown, { phase: "off" }, label);
    else if (!current) assert.equal(shown.phase, "waiting-for-recording", label);
    // Armed is shown exactly for an armed receipt with a run id, of an arming request, for the current folder.
    assert.equal(shown.phase === "armed", own && kept!.status === "armed" && kept!.runId !== undefined, label);
    // Failed is never shown for another recording, a disarm, a pending request or a switch that is off.
    if (shown.phase === "failed") assert.ok(own && kept!.status !== "pending", label);
    if (current && !own) assert.deepEqual(shown, { phase: "arming" }, label);
    if (current && own && kept!.status === "pending") assert.deepEqual(shown, { phase: "arming" }, label);
    assert.equal(shown.runId !== undefined, shown.phase === "armed", label);
    assert.equal(shown.message !== undefined, shown.phase === "failed", label);
    // The path is derived from the receipt and from nothing else.
    if (shown.evidencePath !== undefined) {
      if (shown.phase === "armed") assert.deepEqual([shown.evidencePath, shown.evidenceOwner], [`${kept!.folderPath}/diagnostics/native-stall`, "current-recording"], label);
      else {
        assert.equal(shown.phase, "waiting-for-recording", label);
        const source = kept!.lastArmed ?? kept!;
        assert.deepEqual([shown.evidencePath, shown.evidenceOwner], [`${source.folderPath}/diagnostics/native-stall`, "last-armed-recording"], label);
        assert.ok(kept!.lastArmed !== undefined || (kept!.enabled && kept!.status === "armed" && kept!.runId !== undefined), label);
      }
    } else assert.equal(shown.evidenceOwner, undefined, label);
    assert.deepEqual(Object.keys(shown).filter((key) => !["phase", "runId", "message", "evidencePath", "evidenceOwner"].includes(key)), [], label);
  }
  assert.equal(combinations, 2 * 2 * 2 * (1 + 2 * 4 * 3 * 2 * 2 * 3));
  assert.deepEqual([...phases].sort(), ["armed", "arming", "failed", "off", "waiting-for-recording"]);
  assert.equal(nativeStallDiagnosticsEvidencePath(undefined), undefined);
  assert.equal(nativeStallDiagnosticsEvidencePath(""), undefined);
  assert.equal(nativeStallDiagnosticsEvidencePath("/recordings/session-1"), "/recordings/session-1/diagnostics/native-stall");
});

test("NDI2 the two receipt writers: identity is captured at enqueue, a stale or repeated reply changes nothing", () => {
  const a = { folderName: "A", sessionId: "sA", folderPath: "/r/A", active: true };
  // An arming request names the folder it arms; the session id and path come only from the manager holding that folder.
  assert.deepEqual(createNativeStallDiagnosticsRequest({ requestId: 4, enabled: true, folderName: "A", recording: a }),
    { requestId: 4, enabled: true, folderName: "A", recordingSessionId: "sA", folderPath: "/r/A", status: "pending" });
  assert.deepEqual(createNativeStallDiagnosticsRequest({ requestId: 4, enabled: true, folderName: "A", recording: { folderName: "B", sessionId: "sB", folderPath: "/r/B" } }),
    { requestId: 4, enabled: true, folderName: "A", status: "pending" });
  assert.deepEqual(createNativeStallDiagnosticsRequest({ requestId: 4, enabled: true, folderName: "A", recording: undefined }),
    { requestId: 4, enabled: true, folderName: "A", status: "pending" });
  // A disarm names the recording it was issued in, whatever folder argument came with it.
  assert.deepEqual(createNativeStallDiagnosticsRequest({ requestId: 5, enabled: false, recording: a }),
    { requestId: 5, enabled: false, folderName: "A", recordingSessionId: "sA", folderPath: "/r/A", status: "pending" });
  assert.deepEqual(createNativeStallDiagnosticsRequest({ requestId: 5, enabled: false, folderName: "ignored", recording: { eventCount: 0 } as object }),
    { requestId: 5, enabled: false, status: "pending" });
  assert.deepEqual(createNativeStallDiagnosticsRequest({ requestId: 5, enabled: false, recording: null }), { requestId: 5, enabled: false, status: "pending" });

  // First writer. An arming request replaces everything; a disarm issued while the switch is on carries the
  // armed recording forward; a disarm issued while it is off does not.
  const armed = receipt({ requestId: 2, folderName: "A", recordingSessionId: "sA", folderPath: "/r/A", status: "armed", runId: "run-A" });
  const lastArmed = { folderName: "A", recordingSessionId: "sA", folderPath: "/r/A", runId: "run-A" };
  const disarm = receipt({ requestId: 3, enabled: false });
  assert.deepEqual(beginNativeStallDiagnosticsRequest(armed, disarm, true), { ...disarm, lastArmed });
  assert.deepEqual(beginNativeStallDiagnosticsRequest({ ...disarm, lastArmed }, receipt({ requestId: 4, enabled: false }), true), { ...receipt({ requestId: 4, enabled: false }), lastArmed });
  assert.deepEqual(beginNativeStallDiagnosticsRequest(null, disarm, true), disarm);
  for (const never of [receipt({ folderName: "A", folderPath: "/r/A" }), receipt({ folderName: "A", status: "failed", message: "x" }),
    receipt({ enabled: false, status: "disarmed" }), receipt({ folderName: "A", status: "armed" }),
    receipt({ folderName: "A", folderPath: "/r/A", status: "failed", message: "x", runId: "run-A" })]) {
    assert.deepEqual(beginNativeStallDiagnosticsRequest(never, disarm, true), disarm, "only a recording shown as armed is carried");
  }
  // The switch off: neither an armed receipt nor a carried recording survives the disarm.
  for (const previous of [armed, { ...disarm, lastArmed }, { ...disarm, status: "disarmed" as const, lastArmed }, null, receipt({ folderName: "A" })]) {
    assert.equal(beginNativeStallDiagnosticsRequest(previous, disarm, false), disarm, "a disarm issued with the switch off keeps no recording");
  }
  const next = receipt({ requestId: 9, folderName: "B" });
  for (const settingEnabled of booleans) {
    assert.equal(beginNativeStallDiagnosticsRequest({ ...disarm, lastArmed }, next, settingEnabled), next, "the next arming request drops it");
    assert.equal(beginNativeStallDiagnosticsRequest(armed, next, settingEnabled), next);
  }

  // Second writer. Only the pending receipt of the same request settles.
  const pending = receipt({ requestId: 6, folderName: "A" });
  assert.deepEqual(settleNativeStallDiagnosticsRequest(pending, 6, { runId: "run-A" }), { ...pending, status: "armed", runId: "run-A" });
  assert.deepEqual(settleNativeStallDiagnosticsRequest(pending, 6, { message: "no" }), { ...pending, status: "failed", message: "no" });
  assert.deepEqual(settleNativeStallDiagnosticsRequest({ ...disarm, lastArmed }, 3, { runId: null }), { ...disarm, status: "disarmed", lastArmed });
  assert.deepEqual(settleNativeStallDiagnosticsRequest(disarm, 3, { runId: "run-A" }), { ...disarm, status: "disarmed" }, "a disarm is never armed");
  for (const runId of [null, ""]) {
    assert.deepEqual(settleNativeStallDiagnosticsRequest(pending, 6, { runId }),
      { ...pending, status: "failed", message: "The native reply carried no run id." }, "no run id is not armed");
  }
  assert.equal(settleNativeStallDiagnosticsRequest(pending, 5, { runId: "run-A" }), pending, "another request's reply");
  assert.equal(settleNativeStallDiagnosticsRequest(armed, 2, { message: "late" }), armed, "already settled");
  assert.equal(settleNativeStallDiagnosticsRequest(null, 1, { runId: "run-A" }), null);

  // The recording gate of the timeline write.
  const request = { folderName: "A", recordingSessionId: "sA" };
  assert.equal(isNativeStallDiagnosticsRequestRecording(request, a), true);
  assert.equal(isNativeStallDiagnosticsRequestRecording(request, { ...a, active: false } as object), true, "writability is the manager's decision");
  for (const other of [undefined, null, {}, { folderName: "B", sessionId: "sB" }, { folderName: "A", sessionId: "sB" }, { folderName: "B", sessionId: "sA" }]) {
    assert.equal(isNativeStallDiagnosticsRequestRecording(request, other), false, JSON.stringify(other));
  }
  assert.equal(isNativeStallDiagnosticsRequestRecording({}, {}), false, "a request issued outside a recording belongs to none");
  assert.equal(isNativeStallDiagnosticsRequestRecording({ folderName: "A" }, { folderName: "A" }), false);
});

// ---- NDI6: the panel ----

const CAPTION = "Arms only while Session Recording is active. The setting is saved: once on, each later recording re-arms from it.";
const STATUS = {
  off: "Status: switch off.",
  waiting: "Status: waiting for a recording. Arming is requested when one starts.",
  arming: "Status: arming requested for this recording, waiting for the native reply.",
  armed: (runId: string) => `Status: armed for this recording, run ${runId}. Armed means only that the native observer started.`,
  failed: (message: string) => `Status: arming failed for this recording: ${message}`,
};
const PATH = {
  current: (folderPath: string) => `Evidence folder for this recording (may be empty): ${folderPath}/diagnostics/native-stall`,
  lastArmed: (folderPath: string) => `Evidence folder of the last armed recording (may be empty): ${folderPath}/diagnostics/native-stall`,
};

interface Rendered { type: any; props: Record<string, any>; children: Array<Rendered | string> }
function renderTree(node: any): Array<Rendered | string> {
  if (Array.isArray(node)) return node.flatMap(renderTree);
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (!React.isValidElement(node)) return [];
  const element = node as React.ReactElement<any>;
  const inner = typeof element.type === "function" ? (element.type as any)(element.props) : element.props.children;
  return [{ type: element.type, props: element.props, children: renderTree(inner) }];
}
const nodes = (tree: Array<Rendered | string>): Rendered[] =>
  tree.flatMap((node) => (typeof node === "string" ? [] : [node, ...nodes(node.children)]));
const text = (tree: Array<Rendered | string>): string =>
  tree.map((node) => (typeof node === "string" ? node : text(node.children))).join("");

let panelIconNames: string[] | undefined;
// The real ConfigurationsPanel over the props its real call site computes from the mounted Hook above.
function panel(h: Mounted, options: { dev?: boolean; withoutProjection?: boolean } = {}) {
  const globals = h.globals;
  if (!globals.ConfigurationsPanel) {
    const passthrough = (tag: string) => ({ children }: any) => React.createElement(tag, null, children);
    Object.assign(globals, {
      React, exports: {}, Boolean,
      useEffect: () => undefined, useCallback: (fn: unknown) => fn,
      cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
      Button: ({ children, onClick, disabled }: any) => React.createElement("button", { onClick, disabled }, children),
      Switch: ({ checked, disabled }: any) => React.createElement("input", { type: "checkbox", checked: Boolean(checked), disabled, readOnly: true }),
      Label: passthrough("div"), Badge: passthrough("span"), Input: "input", Textarea: "textarea", MeetingAudioSlider: () => null,
      Dialog: passthrough("div"), DialogTrigger: passthrough("div"), DialogContent: passthrough("div"), DialogTitle: passthrough("div"),
      DialogDescription: passthrough("div"), DialogFooter: passthrough("div"), DialogClose: passthrough("div"),
      extractVariables: () => [],
      configurationsOpen: true, setConfigurationsOpen: () => undefined,
      nativeAudioFaultFeedback: { inFlightKind: null, lastResult: null }, handleNativeAudioFaultInjection: async () => undefined,
    });
    // The panel's own useState calls; the Hook's initialisers above were evaluated before this point.
    globals.useState = (initial: unknown) => [initial, () => undefined];
    panelIconNames ??= ["ConfigurationsPanel", "MeetingModelOverrideConfig"].flatMap((name) => findAll(expression(ui, name), (candidate) =>
      ts.isJsxSelfClosingElement(candidate) && candidate.tagName.getText(ui).endsWith("Icon")))
      .map((node) => (node as ts.JsxSelfClosingElement).tagName.getText(ui));
    for (const icon of panelIconNames) globals[icon] = () => null;
    for (const name of ["responseLengthOptions", "responseLanguageOptions", "enforcementShadowModeOptions", "diagnosticLogLevelOptions",
      "meetingAudioProfileOptions", "TASK_TIMEOUT_OPTIONS", "formatTaskTimeout", "formatSilenceDuration", "ConfigurationGroup", "ConfigButtonGrid",
      "MeetingModelOverrideConfig", "ConfigurationsPanel"]) globals[name] = evaluate(expression(ui, name), ui, globals);
  }
  globals.importMeta = { env: { DEV: options.dev ?? false } };
  const real = ["setDebugMode", "setNativeStallDiagnosticsEnabled", "setRuntimeCrossChecksEnabled"];
  // What the page receives from the Hook: its state, the projection it exports and its functions.
  globals.meeting = new Proxy({}, {
    get: (_target, key) => {
      if (typeof key !== "string") return undefined;
      if (key === "nativeStallDiagnostics") return h.shown();
      // Task 178 LG: this harness holds no level apply, so the page is given no Log Level status.
      if (key === "diagnosticLogLevelStatus") return undefined;
      if (key in globals.state) return globals.state[key];
      if (real.includes(key)) return globals[key];
      return () => { h.actions.push(key); };
    },
  });
  const props: Record<string, any> = {};
  for (const property of panelCallSite.attributes.properties) {
    assert.ok(ts.isJsxAttribute(property) && property.initializer && ts.isJsxExpression(property.initializer));
    props[property.name.getText(ui)] = evaluate(property.initializer.expression!, ui, globals);
  }
  if (options.withoutProjection) delete props.nativeStallDiagnostics;
  const tree = renderTree(React.createElement(globals.ConfigurationsPanel, props));
  const debug = nodes(tree).filter((node) => node.type === globals.ConfigurationGroup && node.props.title === "Debug");
  assert.equal(debug.length, 1, "one Debug group");
  // The group's rows, in order.
  const rows = nodes(debug[0]!.children).find((node) => Array.isArray(node.props.children) && node.children.length > 2 &&
    node.children.some((child) => typeof child !== "string" && text(child.children).startsWith("Debug Mode")));
  assert.ok(rows, "the rows of the Debug group");
  const entries = rows.children.filter((child): child is Rendered => typeof child !== "string");
  const rowIndex = entries.findIndex((entry) => nodes([entry]).some((node) => node.type === globals.Switch &&
    node.props.onCheckedChange === globals.setNativeStallDiagnosticsEnabled));
  assert.ok(rowIndex > 0, "the Native Stall Diagnostics row");
  const row = entries[rowIndex]!;
  const after = entries[rowIndex + 1];
  const block = after && text(after.children).startsWith("Status: ") ? after : undefined;
  const lines = block ? block.children.filter((child): child is Rendered => typeof child !== "string") : [];
  return {
    props, row, block, debugText: text(debug[0]!.children),
    rowText: text(row.children),
    switchNode: nodes([row]).filter((node) => node.type === globals.Switch),
    lines: lines.map((line) => text(line.children)),
    lineClasses: lines.map((line) => line.props.className),
    controls: block ? nodes([block]).filter((node) => typeof node.type !== "string" || ["button", "a", "input", "select", "textarea"].includes(node.type)
      || Object.keys(node.props).some((key) => /^on[A-Z]/.test(key))).length : 0,
  };
}

test("NDI6 the real panel shows one status line and one path line for each phase, with exact text, through the real Hook block and call site", async () => {
  const h = mount({ native: "hold" });
  await h.release();
  // off
  let view = panel(h);
  assert.equal(view.rowText, `Native Stall Diagnostics${CAPTION}`);
  assert.deepEqual(view.lines, [STATUS.off]);
  assert.equal(view.switchNode.length, 1);
  assert.deepEqual([view.switchNode[0]!.props.checked, view.switchNode[0]!.props.disabled], [false, undefined]);
  // waiting for a recording: the switch shows intent, the status line says nothing is armed yet
  view.switchNode[0]!.props.onCheckedChange(true);
  await h.release();
  view = panel(h);
  assert.equal(view.switchNode[0]!.props.checked, true);
  assert.deepEqual(view.lines, [STATUS.waiting]);
  // arming
  const a = await h.start();
  view = panel(h);
  assert.deepEqual(view.lines, [STATUS.arming]);
  // armed, with the run id and the evidence path
  await h.release();
  view = panel(h);
  assert.deepEqual(view.lines, [STATUS.armed("run-1"), PATH.current(a.folderPath)]);
  assert.equal(view.lines[1], `Evidence folder for this recording (may be empty): /recordings/${a.folderName}/diagnostics/native-stall`);
  assert.deepEqual(view.lineClasses, [undefined, "break-all"]);
  // after Stop: the last armed recording's folder, labelled as such
  await h.stop();
  await h.drain();
  view = panel(h);
  assert.deepEqual(view.lines, [STATUS.waiting, PATH.lastArmed(a.folderPath)]);
  // failed, for the next recording: the message, in red, and no path
  await h.start();
  view = panel(h);
  assert.deepEqual(view.lines, [STATUS.arming], "the next arming request drops the old folder");
  await h.fail("Cannot start diagnostics observer");
  view = panel(h);
  assert.deepEqual(view.lines, [STATUS.failed("Cannot start diagnostics observer")]);
  assert.deepEqual(view.lineClasses, ["text-red-600"]);
  // off again
  view.switchNode[0]!.props.onCheckedChange(false);
  view = panel(h);
  assert.deepEqual(view.lines, [STATUS.off]);
  assert.equal(view.switchNode[0]!.props.checked, false);

  // Rendering is read-only: it called no Hook function, wrote no setting and sent no request.
  const before = { ipc: h.ipc.length, storage: h.storageWrites.length, receipts: h.receiptWrites.length };
  for (let pass = 0; pass < 3; pass++) panel(h);
  assert.deepEqual({ ipc: h.ipc.length, storage: h.storageWrites.length, receipts: h.receiptWrites.length }, before);
  assert.deepEqual(h.actions, []);
});

test("NDI6 the wording keeps intent and receipt apart: armed appears only in the armed phase and nothing claims evidence, health or a sample", async () => {
  const views: Record<string, ReturnType<typeof panel>> = {};
  const h = mount({ native: "hold" });
  await h.release();
  views.off = panel(h);
  h.setSwitch(true);
  await h.release();
  views.waiting = panel(h);
  await h.start();
  views.arming = panel(h);
  await h.release();
  views.armed = panel(h);
  await h.stop();
  views.stopped = panel(h);
  await h.drain();
  await h.start();
  await h.fail(new Error("Cannot start diagnostics observer"));
  views.failed = panel(h);
  const texts = Object.fromEntries(Object.entries(views).map(([phase, view]) => [phase, view.lines]));
  assert.deepEqual(Object.values(texts).map((lines) => lines.length), [1, 1, 1, 2, 2, 1]);
  for (const [phase, lines] of Object.entries(texts)) {
    assert.equal(/\barmed for this recording\b/.test(lines[0]!), phase === "armed", phase);
    assert.equal(/\brun run-/.test(lines.join(" ")), phase === "armed", phase);
    // No claim that evidence exists, that capture or audio is healthy, or that a sample was taken or allowed.
    assert.doesNotMatch(`${CAPTION} ${lines.join(" ")}`,
      /health|capturing|capture is|audio is|working|protected|monitor|sampl|stack|saved evidence|evidence (was|is|has|exists)|files? (was|were|is|are|exist)/i, phase);
    assert.ok(lines.length <= 2, "one status line and at most one path line");
  }
  assert.match(texts.armed![0]!, /Armed means only that the native observer started\.$/);
  // Off and waiting are statements about the switch and the Hook's own request, not about native.
  assert.equal(texts.off![0], "Status: switch off.");
  for (const phase of ["off", "waiting", "stopped"]) assert.doesNotMatch(texts[phase]![0]!, /disarmed|stopped|not armed|inactive|native/i, phase);
  for (const phase of ["armed", "stopped"]) assert.match(texts[phase]![1]!, /\(may be empty\): /, phase);
  // The persistent meaning of the setting is stated next to the switch, in every phase.
  assert.match(CAPTION, /The setting is saved: once on, each later recording re-arms from it\.$/);
  // Read-only: no button, link, input or handler in the status block; the switch is the only control of the row.
  for (const [phase, view] of Object.entries(views)) {
    assert.ok(view.block, phase);
    assert.equal(view.controls, 0, phase);
    assert.equal(nodes([view.row]).filter((node) => node.type === "button" || node.type === "a").length, 0, phase);
    assert.equal(view.switchNode.length, 1, phase);
  }
});

test("NDI6 a rejected disarm is not a phase: the line states the switch or the wait, and the rejection reaches the console and the recording", async () => {
  // The switch goes off inside an armed recording and both disarm requests are rejected (a transport failure;
  // native's disarm itself cannot fail). Whether the native observer stopped is unknown to the Hook.
  const h = mount({ native: "hold", stored: { nativeStallDiagnosticsEnabled: true } });
  await h.release();
  const a = await h.start();
  await h.release();
  assert.equal(h.shown().phase, "armed");
  h.setSwitch(false);
  await h.fail(new Error("ipc channel closed"));
  await h.fail(new Error("ipc channel closed"));
  await h.settle();
  assert.equal(h.inFlight(), 0);
  assert.deepEqual([h.receipt()!.enabled, h.receipt()!.status, h.receipt()!.message], [false, "failed", "ipc channel closed"]);
  assert.deepEqual(h.shown(), { phase: "off" });
  const view = panel(h);
  assert.deepEqual(view.lines, ["Status: switch off."], "the line states the switch; it does not say that native stopped");
  assert.deepEqual(view.lineClasses, [undefined]);
  assert.deepEqual(h.warnings, Array.from({ length: 2 }, () => ["Native stall diagnostics could not be armed", "ipc channel closed"]));
  assert.deepEqual(h.timeline(a.folderName).map((entry) => [entry.requestId, entry.stage, entry.enabled, entry.message]), [
    [2, "native-stall-diagnostics", true, undefined],
    [3, "native-stall-diagnostics-error", false, "ipc channel closed"], [4, "native-stall-diagnostics-error", false, "ipc channel closed"]]);

  // Stop with every disarm rejected: waiting and the last armed folder; the failed line is for arming only.
  const s = mount({ native: "hold", stored: { nativeStallDiagnosticsEnabled: true } });
  await s.release();
  const b = await s.start();
  await s.release();
  await s.stop();
  let rejections = 0;
  for (await s.settle(); s.inFlight() > 0; rejections++) await s.fail("ipc channel closed");
  assert.ok(rejections >= 1);
  assert.deepEqual(panel(s).lines, [STATUS.waiting, PATH.lastArmed(b.folderPath)]);
  assert.deepEqual(panel(s).lineClasses, [undefined, "break-all"]);
  assert.equal(s.warnings.length, rejections);
  assert.deepEqual(s.timeline(b.folderName).map((entry) => entry.requestId), [2], "the recording was sealed before the rejections arrived");
});

test("NDI6 the row and its status are outside every Debug, DEV and Cross-checks condition", async () => {
  // In the source: no ancestor of the switch or of the status block is conditional on them.
  const panelSource = expression(ui, "ConfigurationsPanel");
  const nsdSwitch = only<ts.JsxSelfClosingElement>(findAll(panelSource, (node) => ts.isJsxSelfClosingElement(node) &&
    node.tagName.getText(ui) === "Switch" && node.getText(ui).includes("onNativeStallDiagnosticsChange")), "diagnostics switch");
  const statusBlock = only<ts.ConditionalExpression>(findAll(panelSource, (node) => ts.isConditionalExpression(node) &&
    node.condition.getText(ui) === "nativeStallDiagnostics"), "status block");
  for (const [what, start] of [["switch", nsdSwitch], ["status block", statusBlock]] as const) {
    for (let node: ts.Node = start.parent; node !== panelSource; node = node.parent) {
      const condition = ts.isConditionalExpression(node) ? node.condition.getText(ui)
        : ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? node.left.getText(ui)
        : ts.isIfStatement(node) ? node.expression.getText(ui) : "";
      assert.doesNotMatch(condition, /debugMode|import\.meta|[rR]untimeCrossChecks/, `${what} under ${condition}`);
    }
  }
  assert.doesNotMatch(statusBlock.getText(ui), /debugMode|import\.meta|[rR]untimeCrossChecks|onClick|<Button|<a |href/);
  const group = statusBlock.parent.parent;
  assert.ok(ts.isJsxElement(group) && group.openingElement.getText(ui).includes('title="Debug"'), "the block is a direct row of the Debug group");

  // Rendered: the same row and the same status in all eight cells, for a phase with both lines.
  const rendered: string[] = [];
  for (const dev of booleans) for (const debug of booleans) for (const crossChecks of booleans) {
    const h = mount({ stored: { debugMode: debug, runtimeCrossChecksEnabled: crossChecks, nativeStallDiagnosticsEnabled: true } });
    const a = await h.start();
    await h.settle();
    const view = panel(h, { dev });
    assert.deepEqual(view.lines, [STATUS.armed("run-1"), PATH.current(a.folderPath)], JSON.stringify({ dev, debug, crossChecks }));
    assert.equal(view.switchNode[0]!.props.disabled, undefined);
    rendered.push(JSON.stringify([view.rowText, view.lines.map((line) => line.replaceAll(a.folderName, "<folder>")), view.lineClasses]));
    assert.equal(view.debugText.includes("Replay Lab"), dev && debug, "the Debug-only entries still follow DEV and Debug");
  }
  assert.equal(new Set(rendered).size, 1);
});

test("NDI6 the projection prop is one, optional and guarded: a panel that is not given it renders the row and no status", () => {
  const diagnosticsProps = panelCallSite.attributes.properties.map((property) => property.name!.getText(ui)).filter((name) => /nativeStall/i.test(name));
  assert.deepEqual(diagnosticsProps, ["nativeStallDiagnosticsEnabled", "onNativeStallDiagnosticsChange", "nativeStallDiagnostics"]);
  const callSiteValue = panelCallSite.attributes.properties.find((property) => property.name!.getText(ui) === "nativeStallDiagnostics") as ts.JsxAttribute;
  assert.equal(callSiteValue.initializer!.getText(ui), "{meeting.nativeStallDiagnostics}");
  const declared = only<ts.PropertySignature>(findAll(expression(ui, "ConfigurationsPanel"), (node) => ts.isPropertySignature(node) &&
    node.name.getText(ui) === "nativeStallDiagnostics"), "prop type");
  assert.ok(declared.questionToken, "optional");
  assert.equal(declared.type!.getText(ui), "NativeStallDiagnosticsProjection");
  assert.doesNotMatch(uiText, /nativeStallDiagnosticsError/);
  assert.doesNotMatch(hookText, /nativeStallDiagnosticsError/);

  const h = mount({ stored: { nativeStallDiagnosticsEnabled: true } });
  const without = panel(h, { withoutProjection: true });
  assert.equal("nativeStallDiagnostics" in without.props, false);
  assert.equal(without.rowText, `Native Stall Diagnostics${CAPTION}`);
  assert.equal(without.block, undefined);
  assert.doesNotMatch(without.debugText, /Status: |Evidence folder/);
  assert.equal(without.switchNode[0]!.props.checked, true);
  const withProjection = panel(h);
  assert.deepEqual(withProjection.lines, [STATUS.waiting]);
  // No Focus surface carries it.
  for (const file of ["src/pages/app/components/meeting/focus-window.tsx", "src/lib/meeting/focus-window.ts",
    "src/lib/meeting/focus-window-protocol.ts", "src/lib/meeting/focus-display.ts"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /nativeStall|native-stall/i, file);
  }
});
