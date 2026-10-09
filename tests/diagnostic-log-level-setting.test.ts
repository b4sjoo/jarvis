// Task 178 LG, the Log Level setting and its apply receipt: LG1 (default and the
// same value on both sides), LG2 (the level is independent of Debug, is not an
// Artifact-reuse input and is read nowhere else) and LG7 (tolerant load, apply
// failure, reload, key set, existing entries).
//
// Real, loaded from source and evaluated: the Hook's settings defaults, reader,
// writer and setters, the level block (its two states and two refs from their
// initialisers, the one level effect with its dependency array, the projection
// expression and the member of the Hook's return value that carries it) and the
// Artifact-reuse reader. Real, imported: src/lib/meeting/diagnostic-log.ts, one fresh instance
// per mounted Hook as after a page load, with the Tauri invoke entry it imports.
// Controlled: the native side of the IPC boundary, storage, timers and React.
// React is modelled as renders: a render applies the queued state and record
// updates, records what the Hook returns (one frame) and runs the effect again
// when its real dependency array moved.
// tests/preview-controls-consumer.test.mjs mounts the same code with the real
// React in a real browser; tests/diagnostic-log-level-consumer.test.mjs runs
// whole turns at every level.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {
  DEFAULT_DIAGNOSTIC_LOG_LEVEL,
  DIAGNOSTIC_LOG_LEVELS,
  DIAGNOSTIC_LOG_LIMITS,
  DIAGNOSTIC_LOG_MALFORMED_RECEIPT_MESSAGE,
  DIAGNOSTIC_LOG_NO_REPLY_MESSAGE,
  beginDiagnosticLogLevelApply,
  isDiagnosticLogLevel,
  projectDiagnosticLogLevel,
  settleDiagnosticLogLevelApply,
  type DiagnosticLogLevel,
  type DiagnosticLogLevelApply,
  type DiagnosticLogLevelProjection,
  type DiagnosticLogReceipt,
} from "../src/lib/meeting/diagnostic-log.js";
import { UnpublishedArtifactSlot, type ArtifactReuseInputs } from "../src/lib/meeting/unpublished-artifact.js";
import { commitStableAnswerRevision } from "../src/lib/meeting/stable-answer.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import type { ArtifactRegenerationTarget } from "../src/lib/meeting/artifact-regeneration.js";
import type { MeetingDiagnosticLogLevel } from "../src/lib/meeting/types.js";

type Logger = typeof import("../src/lib/meeting/diagnostic-log.js");

// The settings union and the logger's level are one set of literals. Either line fails to compile if they part.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const settingAndLoggerLevelsAreOneType: Same<MeetingDiagnosticLogLevel, DiagnosticLogLevel> = true;

const HOOK = "src/hooks/useMeetingAssistant.ts";
const hookText = readFileSync(HOOK, "utf8");
const hook = ts.createSourceFile("hook.ts", hookText, ts.ScriptTarget.Latest, true);
const LEVELS = ["error", "warn", "info", "debug", "trace"] as const;
const SETTINGS_KEY = "test-settings";
// The keys the settings held before this slice, and the one it adds.
const PREVIOUS_SETTINGS_KEYS = ["activeScreenTaskTimeoutMinutes", "audio", "codingModel", "debugMode", "decisionsRuntimeEnabled", "microphoneContextEnabled",
  "nativeStallDiagnosticsEnabled", "personalEvidenceGuardrailMode", "response", "runtimeCrossChecksEnabled", "taxonomyAdjudication", "useMemory"];
const INVALID_LEVEL = "Diagnostic log level is not one of error, warn, info, debug, trace";

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
let declarations: Map<string, ts.VariableDeclaration | ts.FunctionDeclaration> | undefined;
function expression(name: string): ts.Node {
  if (!declarations) {
    declarations = new Map();
    for (const node of findAll(hook, (candidate) => ts.isVariableDeclaration(candidate) || ts.isFunctionDeclaration(candidate))) {
      const declared = (node as ts.VariableDeclaration | ts.FunctionDeclaration).name?.getText(hook);
      if (declared && !declarations.has(declared)) declarations.set(declared, node as ts.VariableDeclaration | ts.FunctionDeclaration);
    }
  }
  const node = declarations.get(name);
  assert.ok(node, `production declaration ${name} must exist`);
  return ts.isVariableDeclaration(node) ? node.initializer! : node;
}
function hookCall(name: string): ts.CallExpression {
  const node = expression(name);
  assert.ok(ts.isCallExpression(node), `${name} is declared by a hook call`);
  return node;
}
const transpiled = new Map<string, string>();
function evaluate(node: ts.Node, globals: Record<string, any>): any {
  const code = node.getText(hook);
  let output = transpiled.get(code);
  if (output === undefined) {
    output = ts.transpileModule(`(${code})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    transpiled.set(code, output);
  }
  return vm.runInContext(output, globals as vm.Context);
}
const plain = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

// ---- the production nodes of the level block ----

const levelEffect = only<ts.CallExpression>(findAll(hook, (node) => ts.isCallExpression(node) &&
  node.expression.getText(hook) === "useEffect" && node.getText(hook).includes("applyDiagnosticLogLevel(")), "level effect");
const applyState = only<ts.VariableDeclaration>(findAll(hook, (node) => ts.isVariableDeclaration(node) &&
  ts.isArrayBindingPattern(node.name) && node.name.elements[0]?.getText(hook) === "diagnosticLogLevelApply"), "apply record state");
const reapplyState = only<ts.VariableDeclaration>(findAll(hook, (node) => ts.isVariableDeclaration(node) &&
  ts.isArrayBindingPattern(node.name) && node.name.elements[0]?.getText(hook) === "diagnosticLogLevelReapply"), "re-apply counter state");
const projectionExpression = expression("diagnosticLogLevelStatus");
const hookFunction = expression("useMeetingAssistant") as ts.FunctionDeclaration;
const hookReturn = only<ts.ReturnStatement>(findAll(hookFunction, (node) =>
  ts.isReturnStatement(node) && Boolean(node.expression) && ts.isObjectLiteralExpression(node.expression!) &&
  node.expression!.properties.some((property) => property.name?.getText(hook) === "setDiagnosticLogLevel")), "Hook return value");
const exportedMember = only<ts.ObjectLiteralElementLike>((hookReturn.expression as ts.ObjectLiteralExpression).properties
  .filter((property) => property.name?.getText(hook) === "diagnosticLogLevelStatus"), "exported projection");

let instances = 0;
async function loadLogger(): Promise<Logger> {
  const url = new URL(`../src/lib/meeting/diagnostic-log.js?setting=${++instances}`, import.meta.url);
  return (await import(url.href)) as Logger;
}

interface IpcCall { name: string; args: { level: unknown; entries: unknown[] } }
interface HeldCall { args: IpcCall["args"]; resolve(value: unknown): void; reject(error: unknown): void }
interface Frame { level: DiagnosticLogLevel; shown: DiagnosticLogLevelProjection; apply: DiagnosticLogLevelApply | null; threshold: DiagnosticLogLevel }
interface MountOptions { stored?: Record<string, unknown> | string; native?: "auto" | "hold" | "reject" | "malformed" }

const receiptFor = (level: unknown, entries: unknown[] = [], patch: Partial<DiagnosticLogReceipt> = {}): DiagnosticLogReceipt => ({
  v: 1, appliedLevel: level as DiagnosticLogLevel, accepted: entries.length, filtered: 0, rejected: 0, dropped: 0,
  sink: { state: "ready", droppedTotal: 0, writeFailures: 0, unsavedAtExit: 0 }, ...patch,
});

// The native side of the boundary and the timers, shared by every Hook mounted in one test.
function boundary(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ipc: IpcCall[] = [];
  const held: HeldCall[] = [];
  const control: { native: NonNullable<MountOptions["native"]>; receipt?: (args: IpcCall["args"]) => unknown } = { native: "auto" };
  (globalThis as any).window = { __TAURI_INTERNALS__: { invoke: (name: string, args: unknown) => {
    const wire = plain(args) as IpcCall["args"];
    ipc.push({ name, args: wire });
    if (name !== "write_diagnostic_log") return Promise.reject(new Error(`Uncontrolled native command: ${name}`));
    if (control.native === "reject") return Promise.reject("the sink directory is not writable");
    if (control.native === "malformed") return Promise.resolve(null);
    if (control.native === "hold") return new Promise((resolve, reject) => { held.push({ args: wire, resolve, reject }); });
    // As on native: an invalid level rejects and applies nothing.
    if (!LEVELS.includes(wire.level as DiagnosticLogLevel)) return Promise.reject(INVALID_LEVEL);
    return Promise.resolve(control.receipt ? control.receipt(wire) : receiptFor(wire.level, wire.entries));
  } } };
  t.after(() => { delete (globalThis as any).window; });
  const advance = async (ms = 0) => {
    t.mock.timers.tick(ms);
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  };
  return { ipc, held, control, advance };
}
type Boundary = ReturnType<typeof boundary>;

// One mounted Hook, as far as the Log Level is concerned, with its own logger instance.
async function mount(b: Boundary, options: MountOptions = {}) {
  if (options.native) b.control.native = options.native;
  const logger = await loadLogger();
  const stored = options.stored === undefined ? undefined
    : typeof options.stored === "string" ? options.stored : JSON.stringify(options.stored);
  const storageWrites: string[] = [];
  const frames: Frame[] = [];
  const globals = vm.createContext({
    Error, Promise, String,
    STORAGE_KEYS: { MEETING_ASSISTANT_SETTINGS: SETTINGS_KEY },
    safeLocalStorage: { getItem: () => stored ?? null, setItem: (_key: string, value: string) => { storageWrites.push(value); } },
    // The five functions the Hook imports from the diagnostic log module; the apply is this mount's logger.
    isDiagnosticLogLevel, beginDiagnosticLogLevelApply, settleDiagnosticLogLevelApply, projectDiagnosticLogLevel,
    applyDiagnosticLogLevel: logger.applyDiagnosticLogLevel,
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
  ]) globals[name] = evaluate(expression(name), globals);
  const initialSettings = only<ts.PropertyAssignment>(findAll(expression("INITIAL_STATE"), (node) =>
    ts.isPropertyAssignment(node) && node.name.getText(hook) === "settings" && node.parent === expression("INITIAL_STATE")), "initial settings");
  globals.DEFAULT_MEETING_ASSISTANT_SETTINGS = evaluate(initialSettings.initializer, globals);
  const defaults = plain(globals.DEFAULT_MEETING_ASSISTANT_SETTINGS);

  // React, reduced to what this block uses.
  const effect = evaluate(levelEffect.arguments[0]!, globals) as () => void;
  const readDependencies = () => evaluate(levelEffect.arguments[1]!, globals) as unknown[];
  const exported = () => {
    globals.diagnosticLogLevelStatus = evaluate(projectionExpression, globals);
    return plain(ts.isShorthandPropertyAssignment(exportedMember) ? globals.diagnosticLogLevelStatus
      : evaluate((exportedMember as ts.PropertyAssignment).initializer, globals)) as DiagnosticLogLevelProjection;
  };
  const pendingState: Array<(state: any) => any> = [];
  const pendingApply: unknown[] = [];
  const pendingReapply: Array<(count: number) => number> = [];
  let dependencies: unknown[] | undefined;
  let rendering = false;
  let again = false;
  let effectRuns = 0;
  const render = () => {
    if (rendering) { again = true; return; }
    rendering = true;
    try {
      do {
        again = false;
        for (const update of pendingState.splice(0)) globals.state = update(globals.state);
        for (const update of pendingApply.splice(0)) {
          globals.diagnosticLogLevelApply = typeof update === "function" ? update(globals.diagnosticLogLevelApply) : update;
        }
        for (const update of pendingReapply.splice(0)) globals.diagnosticLogLevelReapply = update(globals.diagnosticLogLevelReapply);
        frames.push({ level: globals.state.settings.diagnosticLogLevel, shown: exported(),
          apply: plain(globals.diagnosticLogLevelApply), threshold: logger.readDiagnosticLogSnapshot().threshold });
        const next = readDependencies();
        if (!dependencies || next.some((value, index) => !Object.is(value, dependencies![index]))) {
          dependencies = next;
          effect();
          effectRuns += 1;
        }
        if (pendingState.length || pendingApply.length || pendingReapply.length) again = true;
      } while (again);
    } finally { rendering = false; }
  };
  globals.setState = (update: (state: any) => any) => { pendingState.push(update); render(); };
  globals.state = { settings: globals.readMeetingAssistantSettings() };
  globals.traceStoreRef = { current: { setDebugEnabled: () => undefined } };
  globals.runtimeCrossChecksEnabledRef = { current: globals.state.settings.runtimeCrossChecksEnabled };
  globals.sessionRecordingManagerRef = { current: undefined };
  globals.updateSettings = evaluate(hookCall("updateSettings").arguments[0]!, globals);
  for (const name of ["setDebugMode", "setDiagnosticLogLevel", "setNativeStallDiagnosticsEnabled", "setRuntimeCrossChecksEnabled"]) {
    globals[name] = evaluate(hookCall(name).arguments[0]!, globals);
  }
  // The level block: its two states, its two refs and its effect, from their own initialisers.
  globals.diagnosticLogLevelApply = (evaluate(applyState.initializer!, globals) as unknown[])[0];
  globals.setDiagnosticLogLevelApply = (update: unknown) => { pendingApply.push(update); render(); };
  globals.diagnosticLogLevelRequestIdRef = evaluate(expression("diagnosticLogLevelRequestIdRef"), globals);
  globals.diagnosticLogLevelRef = evaluate(expression("diagnosticLogLevelRef"), globals);
  globals.diagnosticLogLevelReapply = (evaluate(reapplyState.initializer!, globals) as unknown[])[0];
  globals.setDiagnosticLogLevelReapply = (update: (count: number) => number) => { pendingReapply.push(update); render(); };
  const loadedThreshold = logger.readDiagnosticLogSnapshot().threshold;
  render();

  return {
    logger, globals, frames, storageWrites, defaults, loadedThreshold,
    settings: () => plain(globals.state.settings) as Record<string, any>,
    shown: () => frames.at(-1)!.shown,
    record: () => plain(globals.diagnosticLogLevelApply) as DiagnosticLogLevelApply | null,
    threshold: () => logger.readDiagnosticLogSnapshot().threshold,
    effectRuns: () => effectRuns,
    setLevel: (level: DiagnosticLogLevel) => globals.setDiagnosticLogLevel(level),
    setDebug: (enabled: boolean) => globals.setDebugMode(enabled),
    // The settings object itself: what a dependency on `state.settings` compares.
    settingsObject: () => globals.state.settings as object,
    lastStored: () => storageWrites.at(-1),
  };
}
const applies = (b: Boundary) => b.ipc.map((call) => [call.name, JSON.stringify(call.args)]);
const applyOf = (level: string) => ["write_diagnostic_log", JSON.stringify({ level, entries: [] })];
// No frame may show a level as applied that native did not confirm for that very level.
function assertNeverFalselyApplied(frames: Frame[], confirmed: (level: DiagnosticLogLevel) => boolean) {
  for (const [index, frame] of frames.entries()) {
    assert.equal(frame.shown.level, frame.level, `frame ${index} shows the saved level`);
    if (frame.shown.phase === "applied") {
      assert.equal(frame.shown.appliedLevel, frame.level, `frame ${index}`);
      assert.ok(confirmed(frame.level), `frame ${index} shows ${frame.level} as applied`);
    }
  }
}

// ---- LG1 ----

test("LG1 the level defaults to info in the settings, in the logger and in the type; the settings union and the logger declare the same five literals", async (t) => {
  assert.equal(settingAndLoggerLevelsAreOneType, true);
  const b = boundary(t);
  const h = await mount(b, { native: "hold" });
  assert.equal(h.defaults.diagnosticLogLevel, "info");
  assert.equal(DEFAULT_DIAGNOSTIC_LOG_LEVEL, "info");
  assert.equal(h.loadedThreshold, "info", "a logger nothing has configured filters at info");
  assert.equal(h.settings().diagnosticLogLevel, "info");
  assert.deepEqual(h.shown(), { phase: "pending", level: "info" }, "native is not shown as confirmed before it answered");
  // The union in types.ts, read from its declaration.
  const types = ts.createSourceFile("types.ts", readFileSync("src/lib/meeting/types.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const union = only<ts.TypeAliasDeclaration>(findAll(types, (node) => ts.isTypeAliasDeclaration(node) &&
    node.name.text === "MeetingDiagnosticLogLevel"), "settings level union");
  assert.ok(ts.isUnionTypeNode(union.type));
  assert.deepEqual(union.type.types.map((member) => JSON.parse(member.getText(types))), [...DIAGNOSTIC_LOG_LEVELS]);
  assert.deepEqual([...DIAGNOSTIC_LOG_LEVELS], [...LEVELS]);
  const settingsType = only<ts.InterfaceDeclaration>(findAll(types, (node) => ts.isInterfaceDeclaration(node) &&
    node.name.text === "MeetingAssistantSettings"), "settings type");
  const member = settingsType.members.find((candidate) => candidate.name?.getText(types) === "diagnosticLogLevel") as ts.PropertySignature;
  assert.equal(member.type!.getText(types), "MeetingDiagnosticLogLevel");
  assert.equal(member.questionToken, undefined, "the setting is always present");
});

test("LG1 each of the five levels, loaded or selected: the frontend threshold, the level sent and the level native answers are one value", async (t) => {
  const b = boundary(t);
  for (const level of LEVELS) {
    const before = b.ipc.length;
    const h = await mount(b, { stored: { diagnosticLogLevel: level } });
    assert.equal(h.loadedThreshold, "info", "before the effect the logger is at its default");
    assert.equal(h.threshold(), level, "the effect sets the frontend threshold at once");
    assert.deepEqual(h.shown(), { phase: "pending", level });
    await b.advance();
    assert.deepEqual(applies(b).slice(before), [applyOf(level)], "one call, with the level and an empty batch");
    assert.deepEqual(h.shown(), { phase: "applied", level, appliedLevel: level, sinkState: "ready" });
    assert.deepEqual([h.settings().diagnosticLogLevel, h.threshold(), h.logger.readDiagnosticLogSnapshot().native.appliedLevel], [level, level, level]);
    assert.deepEqual(h.storageWrites, [], "loading and applying write nothing");
  }
  // Selected one after the other in one mounted Hook.
  const h = await mount(b);
  await b.advance();
  let reselections = 0;
  for (const level of [...LEVELS, ...[...LEVELS].reverse()]) {
    const before = b.ipc.length;
    const changes = h.settings().diagnosticLogLevel !== level;
    const [object, writes] = [h.settingsObject(), h.storageWrites.length];
    h.setLevel(level);
    assert.deepEqual([h.settings().diagnosticLogLevel, h.threshold()], [level, level]);
    await b.advance();
    // Selected or selected again, the level is sent once. Only a change is saved.
    assert.deepEqual(applies(b).slice(before), [applyOf(level)], level);
    assert.equal(h.storageWrites.length - writes, changes ? 1 : 0, level);
    assert.equal(h.settingsObject() === object, !changes, `${level}: the settings object is replaced by a change and by nothing else`);
    assert.deepEqual(h.shown(), { phase: "applied", level, appliedLevel: level, sinkState: "ready" });
    assert.equal(h.logger.readDiagnosticLogSnapshot().native.appliedLevel, level);
    reselections += changes ? 0 : 1;
  }
  assert.equal(reselections, 1, "trace was selected once while it was the saved level");
  assertNeverFalselyApplied(h.frames, () => true);
  assert.deepEqual(b.ipc.map((call) => call.name).filter((name) => name !== "write_diagnostic_log"), []);
});

// ---- LG7: the setting ----

test("LG7 tolerant load: a missing, unknown or mistyped stored level loads as info without a write, and every other stored entry is unchanged", async (t) => {
  const b = boundary(t);
  const defaults = (await mount(b)).defaults;
  const existing = { ...defaults, debugMode: true, useMemory: false, personalEvidenceGuardrailMode: "shadow", runtimeCrossChecksEnabled: true,
    nativeStallDiagnosticsEnabled: true, microphoneContextEnabled: false, activeScreenTaskTimeoutMinutes: 60,
    response: { length: "detailed", language: "chinese" } };
  // A store written before this slice has no level.
  const { diagnosticLogLevel: _absent, ...before } = existing;
  const old = await mount(b, { stored: before });
  assert.deepEqual(old.settings(), { ...existing, diagnosticLogLevel: "info" }, "every existing entry is read as it was");
  assert.deepEqual(old.storageWrites, [], "reading migrates nothing");
  for (const bad of ["", "INFO", "Info", "verbose", "fatal", "off", "all", "warning", " info", 0, 2, true, false, null, ["info"], { level: "trace" }]) {
    const h = await mount(b, { stored: { ...before, diagnosticLogLevel: bad } });
    assert.deepEqual(h.settings(), { ...existing, diagnosticLogLevel: "info" }, JSON.stringify(bad));
    assert.deepEqual(h.storageWrites, [], JSON.stringify(bad));
    assert.equal(h.threshold(), "info");
  }
  for (const level of LEVELS) {
    const h = await mount(b, { stored: { ...before, diagnosticLogLevel: level } });
    assert.deepEqual(h.settings(), { ...existing, diagnosticLogLevel: level });
  }
  for (const broken of ["{broken", "null", "[]", "42", '"trace"']) {
    const h = await mount(b, { stored: broken });
    assert.equal(h.settings().diagnosticLogLevel, "info", broken);
    assert.deepEqual(h.storageWrites, []);
  }
  await b.advance();
  // What was sent for all of the above: only valid levels, each with an empty batch.
  for (const call of b.ipc) assert.ok(LEVELS.includes(call.args.level as DiagnosticLogLevel) && call.args.entries.length === 0, JSON.stringify(call));
});

test("LG7 the settings key set is the previous one plus diagnosticLogLevel; the setter writes that one key and a reload reads it back and applies it again", async (t) => {
  const b = boundary(t);
  const h = await mount(b);
  await b.advance();
  assert.deepEqual(Object.keys(h.settings()).sort(), [...PREVIOUS_SETTINGS_KEYS, "diagnosticLogLevel"].sort());
  const before = h.settings();
  h.setLevel("trace");
  assert.deepEqual(h.settings(), { ...before, diagnosticLogLevel: "trace" }, "no other setting moves");
  assert.equal(h.storageWrites.length, 1);
  assert.deepEqual(JSON.parse(h.storageWrites[0]!), { ...before, diagnosticLogLevel: "trace" });
  await b.advance();
  assert.deepEqual(h.shown(), { phase: "applied", level: "trace", appliedLevel: "trace", sinkState: "ready" });
  // Reload: a new page, a new logger at its default, the same store.
  const callsBeforeReload = b.ipc.length;
  const reloaded = await mount(b, { stored: h.lastStored() });
  assert.equal(reloaded.loadedThreshold, "info", "the new page's logger starts at info until the effect has run");
  assert.deepEqual(reloaded.settings(), { ...before, diagnosticLogLevel: "trace" });
  assert.equal(reloaded.threshold(), "trace");
  assert.deepEqual(reloaded.frames.map((frame) => frame.shown.phase), ["pending", "pending"], "pending until native answers the new page");
  await b.advance();
  assert.deepEqual(applies(b).slice(callsBeforeReload), [applyOf("trace")], "the level is applied again after a reload");
  assert.deepEqual(reloaded.shown(), { phase: "applied", level: "trace", appliedLevel: "trace", sinkState: "ready" });
  assert.deepEqual(reloaded.storageWrites, [], "the reload writes nothing");
  assert.equal(reloaded.effectRuns(), 1);
  // Other setters leave the level and send nothing.
  const quiet = b.ipc.length;
  reloaded.setDebug(true);
  reloaded.globals.setRuntimeCrossChecksEnabled(true);
  reloaded.globals.setNativeStallDiagnosticsEnabled(true);
  await b.advance();
  assert.equal(reloaded.settings().diagnosticLogLevel, "trace");
  assert.deepEqual([b.ipc.length, reloaded.effectRuns()], [quiet, 1], "the effect depends on the level alone");
});

test("LG7 apply failure: the projection is failed with the reason and is never applied; the saved setting and the frontend threshold stay", async (t) => {
  const b = boundary(t);
  const h = await mount(b, { native: "reject", stored: { diagnosticLogLevel: "debug" } });
  assert.deepEqual(h.shown(), { phase: "pending", level: "debug" });
  await b.advance();
  assert.deepEqual(h.shown(), { phase: "failed", level: "debug", message: "the sink directory is not writable" });
  assert.deepEqual([h.settings().diagnosticLogLevel, h.threshold()], ["debug", "debug"]);
  assert.deepEqual(h.storageWrites, [], "a failure is not saved and changes no setting");
  // A reply that is not a receipt, and a receipt for another level, are failures too.
  b.control.native = "malformed";
  h.setLevel("trace");
  await b.advance();
  assert.deepEqual(h.shown(), { phase: "failed", level: "trace", message: DIAGNOSTIC_LOG_MALFORMED_RECEIPT_MESSAGE });
  b.control.native = "auto";
  b.control.receipt = (args) => receiptFor("info", args.entries);
  h.setLevel("warn");
  await b.advance();
  assert.deepEqual(h.shown(), { phase: "failed", level: "warn", message: "Native reports info." });
  assert.equal(h.threshold(), "warn");
  // The next change is applied normally: a failure is not sticky.
  b.control.receipt = (args) => receiptFor(args.level, args.entries, { sink: { state: "degraded", droppedTotal: 4, writeFailures: 2, unsavedAtExit: 0 } });
  h.setLevel("error");
  await b.advance();
  assert.deepEqual(h.shown(), { phase: "applied", level: "error", appliedLevel: "error", sinkState: "degraded" });
  // Nothing was ever shown as applied except the one level native confirmed.
  assertNeverFalselyApplied(h.frames, (level) => level === "error");
  assert.deepEqual(h.frames.filter((frame) => frame.shown.phase === "applied").map((frame) => frame.level), ["error"]);
  assert.deepEqual(h.storageWrites.map((write) => JSON.parse(write).diagnosticLogLevel), ["trace", "warn", "error"], "only the user's selections are saved");
});

test("LG7 selecting the saved level again retries the apply and saves nothing: no storage write, the same settings object, a new request", async (t) => {
  const b = boundary(t);
  const h = await mount(b, { native: "reject", stored: { diagnosticLogLevel: "debug", debugMode: true } });
  await b.advance();
  assert.deepEqual(h.shown(), { phase: "failed", level: "debug", message: "the sink directory is not writable" });
  assert.deepEqual(h.record(), { requestId: 1, level: "debug", status: "failed", message: "the sink directory is not writable" });
  const object = h.settingsObject();
  // Still failing: the retry is a new request, shown as pending and then failed again.
  h.setLevel("debug");
  assert.deepEqual(h.shown(), { phase: "pending", level: "debug" }, "a retry is pending until native answers it");
  await b.advance();
  assert.deepEqual(h.record(), { requestId: 2, level: "debug", status: "failed", message: "the sink directory is not writable" });
  // Native is back: the same click confirms the level.
  b.control.native = "auto";
  h.setLevel("debug");
  await b.advance();
  assert.deepEqual(h.record(), { requestId: 3, level: "debug", status: "applied", appliedLevel: "debug", sinkState: "ready" });
  assert.deepEqual(h.shown(), { phase: "applied", level: "debug", appliedLevel: "debug", sinkState: "ready" });
  assert.deepEqual(applies(b), [applyOf("debug"), applyOf("debug"), applyOf("debug")]);
  // Nothing was saved and nothing that depends on the settings saw a change.
  assert.deepEqual(h.storageWrites, []);
  assert.equal(h.settingsObject(), object, "the settings object is the one that was loaded");
  assert.equal(h.effectRuns(), 3);
  assertNeverFalselyApplied(h.frames, (level) => level === "debug");
  // The control: a change of the level, like a change of any other setting, does replace the settings object. It is
  // the write that dependents of `state.settings` see, whatever the value is.
  h.setLevel("trace");
  const afterLevel = h.settingsObject();
  assert.notEqual(afterLevel, object);
  h.setDebug(true);
  assert.notEqual(h.settingsObject(), afterLevel, "a setter of another setting replaces it too, even with the value it already had");
  assert.deepEqual(h.storageWrites.map((write) => [JSON.parse(write).diagnosticLogLevel, JSON.parse(write).debugMode]), [["trace", true], ["trace", true]]);
});

test("LG7 a failed reload: the saved level is kept, shown as not confirmed, and applied on the next page that reaches native", async (t) => {
  const b = boundary(t);
  const h = await mount(b, { native: "reject", stored: { diagnosticLogLevel: "trace", debugMode: true } });
  await b.advance();
  assert.equal(h.shown().phase, "failed");
  assert.deepEqual([h.settings().diagnosticLogLevel, h.settings().debugMode, h.threshold()], ["trace", true, "trace"]);
  const reloaded = await mount(b, { native: "auto", stored: { diagnosticLogLevel: "trace", debugMode: true } });
  await b.advance();
  assert.deepEqual(reloaded.shown(), { phase: "applied", level: "trace", appliedLevel: "trace", sinkState: "ready" });
});

test("LG7 ordering: records are ordered by the Hook-local request id; a stale reply never overwrites a newer one and pending holds until the latest reply", async (t) => {
  const b = boundary(t);
  const h = await mount(b, { native: "hold" });
  await b.advance();
  assert.equal(b.held.length, 1, "the mount apply is in flight");
  assert.deepEqual(h.record(), { requestId: 1, level: "info", status: "pending" });
  // Two changes while the first call is unanswered: they wait for it and leave as one call with the newest level.
  h.setLevel("debug");
  h.setLevel("trace");
  await b.advance();
  assert.deepEqual(h.record(), { requestId: 3, level: "trace", status: "pending" });
  assert.equal(b.held.length, 1, "one call at a time");
  // The first call answers info. It is the reply of request 1: nothing shown changes.
  b.held[0]!.resolve(receiptFor("info"));
  await b.advance();
  await b.advance();
  assert.deepEqual(h.record(), { requestId: 3, level: "trace", status: "pending" });
  assert.deepEqual(h.shown(), { phase: "pending", level: "trace" });
  assert.deepEqual(applies(b), [applyOf("info"), applyOf("trace")], "debug was superseded before it was sent");
  // A rejection of the second call would belong to requests 2 and 3; only request 3 is current.
  b.held[1]!.resolve(receiptFor("trace"));
  await b.advance();
  assert.deepEqual(h.record(), { requestId: 3, level: "trace", status: "applied", appliedLevel: "trace", sinkState: "ready" });
  assert.deepEqual(h.frames.map((frame) => `${frame.level}:${frame.shown.phase}`).filter((entry, index, all) => entry !== all[index - 1]),
    ["info:pending", "debug:pending", "trace:pending", "trace:applied"], "info and debug were never shown as applied");
  assertNeverFalselyApplied(h.frames, (level) => level === "trace");
  // A reply that arrives after a newer request was issued and answered is dropped by the request id.
  const stale = { requestId: 9, level: "trace" as const, status: "applied" as const, appliedLevel: "trace" as const, sinkState: "ready" as const };
  assert.equal(settleDiagnosticLogLevelApply(stale, 8, { message: "late failure of request 8" }), stale);
  assert.equal(settleDiagnosticLogLevelApply(stale, 9, { message: "second reply of request 9" }), stale, "a settled record is not settled again");
  assert.equal(settleDiagnosticLogLevelApply(null, 1, { receipt: receiptFor("info") }), null);
});

test("LG7 a reply that never arrives is pending, then failed after the timeout; the Hook and the setting are not held up", async (t) => {
  const b = boundary(t);
  const h = await mount(b, { native: "hold", stored: { diagnosticLogLevel: "warn" } });
  await b.advance();
  await b.advance(DIAGNOSTIC_LOG_LIMITS.replyTimeoutMs - 1);
  assert.deepEqual(h.shown(), { phase: "pending", level: "warn" });
  // Meanwhile the user changes other settings and the level itself: all of it is saved at once.
  h.setDebug(true);
  h.setLevel("error");
  assert.deepEqual([h.settings().debugMode, h.settings().diagnosticLogLevel, h.threshold(), h.storageWrites.length], [true, "error", "error", 2]);
  await b.advance(1);
  await b.advance();
  // The first call timed out. Its record was already replaced, so what is shown is the new request, still unanswered.
  assert.deepEqual(h.shown(), { phase: "pending", level: "error" });
  assert.deepEqual(applies(b), [applyOf("warn"), applyOf("error")]);
  await b.advance(DIAGNOSTIC_LOG_LIMITS.replyTimeoutMs);
  assert.deepEqual(h.shown(), { phase: "failed", level: "error", message: DIAGNOSTIC_LOG_NO_REPLY_MESSAGE });
  assertNeverFalselyApplied(h.frames, () => false);
});

test("LG7 the projection: pending, applied and failed from the record alone, for every level", () => {
  for (const level of LEVELS) {
    assert.deepEqual(projectDiagnosticLogLevel({ level, apply: null }), { phase: "pending", level });
    const pending = beginDiagnosticLogLevelApply(4, level);
    assert.deepEqual(pending, { requestId: 4, level, status: "pending" });
    assert.deepEqual(projectDiagnosticLogLevel({ level, apply: pending }), { phase: "pending", level });
    for (const sinkState of ["ready", "degraded", "failed"] as const) {
      const applied = settleDiagnosticLogLevelApply(pending, 4, { receipt: receiptFor(level, [], { sink: { state: sinkState, droppedTotal: 1, writeFailures: 1, unsavedAtExit: 1 } }) });
      assert.deepEqual(applied, { requestId: 4, level, status: "applied", appliedLevel: level, sinkState });
      assert.deepEqual(projectDiagnosticLogLevel({ level, apply: applied }), { phase: "applied", level, appliedLevel: level, sinkState });
      // The record of another level is never the status of this one.
      for (const other of LEVELS.filter((candidate) => candidate !== level)) {
        assert.deepEqual(projectDiagnosticLogLevel({ level: other, apply: applied }), { phase: "pending", level: other });
      }
    }
    const failed = settleDiagnosticLogLevelApply(pending, 4, { message: `${INVALID_LEVEL} ${"x ".repeat(400)}` });
    assert.equal(failed!.status, "failed");
    assert.equal(failed!.message!.length, 256, "the reason is bounded");
    assert.deepEqual(projectDiagnosticLogLevel({ level, apply: failed }), { phase: "failed", level, message: failed!.message });
    // A receipt for another level, or one that is not a receipt, never becomes applied.
    for (const other of LEVELS.filter((candidate) => candidate !== level)) {
      assert.deepEqual(settleDiagnosticLogLevelApply(pending, 4, { receipt: receiptFor(other) }),
        { requestId: 4, level, status: "failed", message: `Native reports ${other}.` });
    }
    assert.equal(settleDiagnosticLogLevelApply(pending, 4, { receipt: { v: 2 } as unknown as DiagnosticLogReceipt })!.message,
      DIAGNOSTIC_LOG_MALFORMED_RECEIPT_MESSAGE);
    assert.equal(settleDiagnosticLogLevelApply(pending, 3, { receipt: receiptFor(level) }), pending, "another request's reply");
  }
});

// ---- LG2: independence ----

test("LG2 Debug and Log Level are stored and applied separately in both directions: all twenty cells", async (t) => {
  const b = boundary(t);
  for (const debug of [false, true]) for (const level of LEVELS) {
    const label = JSON.stringify({ debug, level });
    const h = await mount(b, { stored: { debugMode: debug, diagnosticLogLevel: level } });
    await b.advance();
    assert.deepEqual([h.settings().debugMode, h.settings().diagnosticLogLevel, h.threshold()], [debug, level, level], label);
    const calls = b.ipc.length;
    // Debug flips: the level, the logger threshold and native are untouched.
    h.setDebug(!debug);
    await b.advance();
    assert.deepEqual([h.settings().debugMode, h.settings().diagnosticLogLevel, h.threshold()], [!debug, level, level], label);
    assert.equal(b.ipc.length, calls, `${label}: flipping Debug sends no level`);
    assert.deepEqual(JSON.parse(h.lastStored()!), { ...h.defaults, debugMode: !debug, diagnosticLogLevel: level }, label);
    // The level changes: Debug is untouched.
    const next = LEVELS[(LEVELS.indexOf(level) + 2) % LEVELS.length]!;
    h.setLevel(next);
    await b.advance();
    assert.deepEqual([h.settings().debugMode, h.settings().diagnosticLogLevel, h.threshold()], [!debug, next, next], label);
    assert.deepEqual(JSON.parse(h.lastStored()!), { ...h.defaults, debugMode: !debug, diagnosticLogLevel: next }, label);
    assert.deepEqual(applies(b).slice(calls), [applyOf(next)], label);
  }
  // Neither setter names the other setting, and the level effect names no Debug state.
  assert.doesNotMatch(hookCall("setDebugMode").arguments[0]!.getText(hook), /[dD]iagnosticLog/);
  assert.doesNotMatch(hookCall("setDiagnosticLogLevel").arguments[0]!.getText(hook), /[dD]ebug/);
  assert.doesNotMatch(levelEffect.getText(hook), /[dD]ebug|[rR]ecording|[cC]rossChecks/);
});

const content = "Answer: Accepted answer.\n\nCode:\n```ts\nreturn 42;\n```\n\nComplexity: O(1)";
const parsed = parseMeetingAnswer(content);
const stableAnswer = () => commitStableAnswerRevision({ candidate: { id: "G1", content, meetingAnswer: parsed, sourceTraceId: "G1",
  kind: "answer", confidence: "high", createdAt: 1, basedOnTurnIds: [], basedOnObservationIds: [] },
  authorizedArtifacts: ["answer"], taskId: "parent", logicalQuestionUnitId: "lqu", logicalQuestionRevision: 1,
  sessionId: "session", runtimeEpoch: 1, settlementId: "S1", questionSourceHash: "source" })!;
const regenerationTarget = (answer: ReturnType<typeof stableAnswer>): ArtifactRegenerationTarget => ({
  sessionId: "session", runtimeEpoch: 1, visibleAnswerRevision: answer.revision,
  logicalQuestionUnitId: "lqu", logicalQuestionRevision: 1, settlementId: "S1", sourceHash: "source",
  parentId: "parent", parentRevision: 3, questionType: "coding", playbookPhase: "implementation_validation",
  phaseOwnerKind: "parent", phaseOwnerId: "parent", phaseOwnerRevision: 3,
  sectionOwner: { kind: "parent-mainline", parentId: "parent" }, artifactFamilies: ["code", "complexity"] });

test("LG2 the level never appears in the Artifact-reuse inputs: they are identical at all five levels, and a candidate offered at one level is reused at any other", async (t) => {
  const b = boundary(t);
  const reuse = async (stored: Record<string, unknown> = {}) => {
    const h = await mount(b, { stored });
    Object.assign(h.globals, {
      structuredClone,
      artifactReuseSettingsRef: { get current() { return h.globals.state.settings; } },
      manualCorrectionRevisionRef: { current: 0 },
      preparationRuntimeContextRef: { current: { preparationContextRevision: 1 } },
      latestScreenHashRef: { current: "screen-hash" },
      contextManagerRef: { current: { getState: () => ({ transcriptTurns: [{ id: "turn-1" }], screenObservations: [{ id: "observation-1" }] }) } },
    });
    const read = evaluate(hookCall("readArtifactReuseInputs").arguments[0]!, h.globals) as () => ArtifactReuseInputs;
    return { ...h, read: () => plain(read()) as ArtifactReuseInputs };
  };
  for (const debug of [false, true]) for (const crossChecks of [false, true]) {
    const inputs: ArtifactReuseInputs[] = [];
    for (const level of LEVELS) {
      const h = await reuse({ debugMode: debug, runtimeCrossChecksEnabled: crossChecks, diagnosticLogLevel: level });
      const read = h.read();
      assert.equal(h.settings().diagnosticLogLevel, level);
      assert.equal(read.settings.diagnosticLogLevel, "info", "the reuse inputs hold the level at one constant");
      // Every other setting is compared with its real value; Cross-checks keeps its own constant.
      assert.deepEqual(read.settings, { ...h.settings(), runtimeCrossChecksEnabled: false, diagnosticLogLevel: "info" });
      inputs.push(read);
    }
    for (const read of inputs) assert.deepEqual(read, inputs[0], JSON.stringify({ debug, crossChecks }));
  }
  let pairs = 0;
  for (const atOffer of LEVELS) for (const atTake of LEVELS) {
    const h = await reuse({ diagnosticLogLevel: atOffer });
    const slot = new UnpublishedArtifactSlot();
    const answer = stableAnswer();
    const offered = h.read();
    slot.accepted({ stable: answer, current: answer, target: regenerationTarget(answer), currentInputs: h.read(),
      offer: { parsed, inputs: offered, authorizedArtifacts: ["answer"] } });
    assert.equal(slot.present, true);
    h.setLevel(atTake);
    const taken = slot.take({ target: regenerationTarget(answer), stable: answer, inputs: h.read() });
    assert.equal(taken.reason, "matched", `offered at ${atOffer}, taken at ${atTake}`);
    pairs += 1;
  }
  assert.equal(pairs, 25);
  // The control: a setting that is an answer input still invalidates the candidate, at any level.
  const h = await reuse({ diagnosticLogLevel: "trace" });
  const slot = new UnpublishedArtifactSlot();
  const answer = stableAnswer();
  slot.accepted({ stable: answer, current: answer, target: regenerationTarget(answer), currentInputs: h.read(),
    offer: { parsed, inputs: h.read(), authorizedArtifacts: ["answer"] } });
  h.setDebug(true);
  h.setLevel("error");
  assert.equal(slot.take({ target: regenerationTarget(answer), stable: answer, inputs: h.read() }).reason, "inputs-changed");
});

// The statement of the Hook, or of its module, that a node belongs to.
function site(node: ts.Node): string {
  let current: ts.Node = node;
  while (current.parent && current.parent !== hook && !(ts.isBlock(current.parent) && current.parent === hookFunction.body)) current = current.parent;
  if (ts.isImportDeclaration(current)) return "import";
  if (ts.isReturnStatement(current)) return "return";
  if (ts.isFunctionDeclaration(current)) return current.name!.text;
  if (ts.isVariableStatement(current)) {
    const name = current.declarationList.declarations[0]!.name;
    return ts.isArrayBindingPattern(name) ? name.elements[0]!.getText(hook) : name.getText(hook);
  }
  if (ts.isExpressionStatement(current) && ts.isCallExpression(current.expression)) return `${current.expression.expression.getText(hook)}()`;
  return ts.SyntaxKind[current.kind];
}

test("LG2 the level is read and written at twelve sites of the Hook and in four files of src; no capture, recording, fact or answer path names it", () => {
  const mentions = findAll(hook, (node) => (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && /diagnosticLogLevel/i.test(node.text));
  const sites = [...new Set(mentions.map(site))];
  assert.deepEqual(sites, [
    "import",                         // the five functions and two types of the diagnostic log module, and the settings union
    "INITIAL_STATE",                  // the default
    "readMeetingAssistantSettings",   // the tolerant reader
    "readArtifactReuseInputs",        // projected to a constant
    "diagnosticLogLevelApply",        // the record of the latest apply
    "diagnosticLogLevelRequestIdRef", // its ordering key
    "diagnosticLogLevelRef",          // the saved level as the setter reads it
    "diagnosticLogLevelReapply",      // raised when the saved level is selected again
    "useEffect()",                    // the one apply
    "diagnosticLogLevelStatus",       // the projection the panel shows
    "setDiagnosticLogLevel",          // the setter
    "return",                         // the two members handed to the page
  ]);
  // One effect and one call of the apply in the whole Hook, fire-and-forget: its promise is consumed where it is made.
  const applyCalls = findAll(hook, (node) => ts.isCallExpression(node) && node.expression.getText(hook) === "applyDiagnosticLogLevel");
  assert.equal(applyCalls.length, 1);
  assert.equal(site(applyCalls[0]!), "useEffect()");
  assert.equal(mentions.filter((node) => site(node) === "useEffect()").every((node) => {
    let current: ts.Node = node;
    while (current !== levelEffect && current.parent) current = current.parent;
    return current === levelEffect;
  }), true, "every mention inside an effect is inside the one level effect");
  assert.deepEqual(levelEffect.arguments[1]!.getText(hook).replace(/\s+/g, ""), "[state.settings.diagnosticLogLevel,diagnosticLogLevelReapply]");
  // The record is read by the projection alone; the request counter by the effect alone. The saved-level ref and the
  // re-apply counter stay between the setter and the effect: no capture, recording, fact or answer path reads them.
  const readers = (name: string) => [...new Set(findAll(hook, (node) => ts.isIdentifier(node) && node.text === name).map(site))];
  assert.deepEqual(readers("diagnosticLogLevelApply"), ["diagnosticLogLevelApply", "diagnosticLogLevelStatus"]);
  assert.deepEqual(readers("diagnosticLogLevelRequestIdRef"), ["diagnosticLogLevelRequestIdRef", "useEffect()"]);
  assert.deepEqual(readers("diagnosticLogLevelRef"), ["diagnosticLogLevelRef", "useEffect()", "setDiagnosticLogLevel"]);
  assert.deepEqual(readers("diagnosticLogLevelReapply"), ["diagnosticLogLevelReapply", "useEffect()"]);
  assert.deepEqual(readers("setDiagnosticLogLevelReapply"), ["diagnosticLogLevelReapply", "setDiagnosticLogLevel"]);
  assert.deepEqual(readers("diagnosticLogLevelStatus"), ["diagnosticLogLevelStatus", "return"]);
  // In src, the level and the threshold are named by the logger, the settings type, the Hook and the page. Nothing else:
  // the trace store, which logs since commit 3, passes each entry its own level and never names the level type or the threshold.
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(ts|tsx)$/.test(entry.name) && /diagnosticLogLevel|DiagnosticLogLevel|DiagnosticLogThreshold/.test(readFileSync(file, "utf8"))) files.push(file);
    }
  };
  walk("src");
  assert.deepEqual(files.sort(), ["src/hooks/useMeetingAssistant.ts", "src/lib/meeting/diagnostic-log.ts", "src/lib/meeting/types.ts",
    "src/pages/app/components/meeting/index.tsx"]);
  // The page takes a type from the module and nothing that runs; the module itself imports the Tauri invoke entry alone.
  const page = ts.createSourceFile("page.tsx", readFileSync("src/pages/app/components/meeting/index.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const pageImports = page.statements.filter(ts.isImportDeclaration).filter((node) => /diagnostic-log/.test(node.moduleSpecifier.getText(page)));
  assert.deepEqual(pageImports.map((node) => node.importClause?.isTypeOnly), [true]);
  const leaf = ts.createSourceFile("leaf.ts", readFileSync("src/lib/meeting/diagnostic-log.ts", "utf8"), ts.ScriptTarget.Latest, true);
  assert.deepEqual(leaf.statements.filter(ts.isImportDeclaration).map((node) => node.getText(leaf)), ['import { invoke } from "@tauri-apps/api/core";']);
  assert.equal(findAll(leaf, (node) => ts.isCallExpression(node) && node.expression.getText(leaf) === "invoke").length, 1, "one call of the command");
  assert.equal(/\bimport\.meta\b|\bwindow\b|\blocalStorage\b|\bdocument\b/.test(leaf.getFullText().replace(/\/\/.*$/gm, "")), false);
});
