// 178/168 PC, commit C2: the Runtime Cross-checks setting itself.
// The Hook's real defaults, reader, writer, setter and Artifact-reuse reader are
// loaded from the source and evaluated; only storage, React state and the
// recorder's disk are substituted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { MeetingTraceStore } from "../src/lib/meeting/trace.js";
import { SessionRecordingManager } from "../src/lib/meeting/session-recording.js";
import { UnpublishedArtifactSlot, type ArtifactReuseInputs } from "../src/lib/meeting/unpublished-artifact.js";
import { commitStableAnswerRevision } from "../src/lib/meeting/stable-answer.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import type { ArtifactRegenerationTarget } from "../src/lib/meeting/artifact-regeneration.js";
import type { MeetingAssistantSettings } from "../src/lib/meeting/types.js";

const hookText = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
const hook = ts.createSourceFile("hook.ts", hookText, ts.ScriptTarget.Latest, true);

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
function expression(name: string): ts.Node {
  const node = find(hook, (candidate) =>
    (ts.isVariableDeclaration(candidate) || ts.isFunctionDeclaration(candidate)) && candidate.name?.getText(hook) === name
  ) as ts.VariableDeclaration | ts.FunctionDeclaration;
  return ts.isVariableDeclaration(node) ? node.initializer! : node;
}
function callback(name: string) {
  const node = expression(name);
  assert.ok(ts.isCallExpression(node));
  return node.arguments[0]!;
}
function evaluate(node: ts.Node, globals: vm.Context): any {
  return vm.runInContext(ts.transpileModule(`(${node.getText(hook)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, globals);
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

interface RecorderFile { command: string; args: Record<string, any> }
function recorder() {
  const files: RecorderFile[] = [];
  const manager = new SessionRecordingManager(undefined, async <T>(command: string, args: Record<string, unknown> = {}) => {
    files.push({ command, args });
    return `/recordings/${args.folderName}` as T;
  });
  return { manager, files };
}

// `deferState` holds React state updates back, as React does until the next render.
function settingsHarness(stored?: string, options: { deferState?: boolean; manager?: SessionRecordingManager } = {}) {
  const writes: string[] = [];
  const pendingState: Array<(state: any) => any> = [];
  const globals = vm.createContext({
    STORAGE_KEYS: { MEETING_ASSISTANT_SETTINGS: "test-settings" },
    safeLocalStorage: {
      getItem: () => stored ?? null,
      setItem: (_key: string, value: string) => writes.push(value),
    },
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
  const initialSettings = find(expression("INITIAL_STATE"), (node) =>
    ts.isPropertyAssignment(node) && node.name.getText(hook) === "settings"
  ) as ts.PropertyAssignment;
  globals.DEFAULT_MEETING_ASSISTANT_SETTINGS = evaluate(initialSettings.initializer, globals);
  globals.state = { status: "idle", settings: globals.readMeetingAssistantSettings() };
  globals.setState = (update: (state: any) => any) => {
    if (options.deferState) pendingState.push(update);
    else globals.state = update(globals.state);
  };
  globals.traceStoreRef = { current: new MeetingTraceStore() };
  // The ref starts from the loaded setting, as the Hook declares it.
  globals.runtimeCrossChecksEnabledRef = { current: globals.state.settings.runtimeCrossChecksEnabled };
  globals.sessionRecordingManagerRef = { current: options.manager };
  globals.updateSettings = evaluate(callback("updateSettings"), globals);
  globals.setDebugMode = evaluate(callback("setDebugMode"), globals);
  globals.setRuntimeCrossChecksEnabled = evaluate(callback("setRuntimeCrossChecksEnabled"), globals);
  return { globals, writes, render: () => { for (const update of pendingState.splice(0)) globals.state = update(globals.state); } };
}

test("PC6 Runtime Cross-checks defaults to false and loads only from its own boolean, never from Debug or a retired mode", () => {
  const defaults = plain(settingsHarness().globals.state.settings);
  assert.equal(defaults.runtimeCrossChecksEnabled, false);
  assert.equal("previewMode" in defaults, false);
  for (const stored of [
    {},
    { debugMode: true },
    { debugMode: true, nativeStallDiagnosticsEnabled: true },
    { semanticTaxonomyMode: "enforcement" },
    { debugMode: true, semanticTaxonomyMode: "enforcement", previewMode: true },
    { runtimeCrossChecksEnabled: "true" },
    { runtimeCrossChecksEnabled: 1 },
    { runtimeCrossChecksEnabled: null },
    { runtimeCrossChecksEnabled: { enabled: true } },
    { runtimeCrossChecksEnabled: false, debugMode: true },
  ]) {
    const h = settingsHarness(JSON.stringify(stored));
    assert.equal(h.globals.state.settings.runtimeCrossChecksEnabled, false, JSON.stringify(stored));
    assert.equal(h.globals.runtimeCrossChecksEnabledRef.current, false);
    assert.deepEqual(h.writes, [], "reading performs no migration write");
  }
  for (const debugMode of [false, true]) {
    const h = settingsHarness(JSON.stringify({ runtimeCrossChecksEnabled: true, debugMode }));
    assert.equal(h.globals.state.settings.runtimeCrossChecksEnabled, true);
    assert.equal(h.globals.state.settings.debugMode, debugMode);
  }
  for (const broken of ["{broken", "null"]) {
    assert.equal(settingsHarness(broken).globals.state.settings.runtimeCrossChecksEnabled, false);
  }
});

test("PC6 the setter assigns the ref synchronously, persists through updateSettings, survives a reload and changes no other setting", () => {
  const h = settingsHarness(JSON.stringify({ debugMode: true, useMemory: false }), { deferState: true });
  const before = plain(h.globals.state.settings);
  h.globals.setRuntimeCrossChecksEnabled(true);
  // Before React has applied the state update: a scheduling callback already reads the new value.
  assert.equal(h.globals.runtimeCrossChecksEnabledRef.current, true);
  assert.equal(h.globals.state.settings.runtimeCrossChecksEnabled, false);
  assert.deepEqual(h.writes, []);
  h.render();
  assert.deepEqual(plain(h.globals.state.settings), { ...before, runtimeCrossChecksEnabled: true });
  assert.equal(h.writes.length, 1);
  assert.deepEqual(JSON.parse(h.writes[0]!), { ...before, runtimeCrossChecksEnabled: true });
  // Refresh: the stored value reads back.
  const reloaded = settingsHarness(h.writes[0]);
  assert.deepEqual(plain(reloaded.globals.state.settings), { ...before, runtimeCrossChecksEnabled: true });
  assert.equal(reloaded.globals.runtimeCrossChecksEnabledRef.current, true);
  // Debug and Cross-checks do not move each other.
  reloaded.globals.setDebugMode(false);
  assert.equal(reloaded.globals.state.settings.runtimeCrossChecksEnabled, true);
  assert.equal(reloaded.globals.runtimeCrossChecksEnabledRef.current, true);
  reloaded.globals.setRuntimeCrossChecksEnabled(false);
  assert.equal(reloaded.globals.runtimeCrossChecksEnabledRef.current, false);
  assert.deepEqual(plain(reloaded.globals.state.settings), { ...before, debugMode: false, runtimeCrossChecksEnabled: false });
});

test("PC6 the setter is exported, kept in sync by an effect, and the setting is no part of a mode, registry or scheduler", () => {
  const returned = find(expression("useMeetingAssistant"), (node) =>
    ts.isReturnStatement(node) && Boolean(node.expression) && ts.isObjectLiteralExpression(node.expression!) &&
    node.expression!.properties.some((property) => property.name?.getText(hook) === "setDebugMode")) as ts.ReturnStatement;
  const names = (returned.expression as ts.ObjectLiteralExpression).properties.map((property) => property.name?.getText(hook));
  assert.ok(names.includes("setRuntimeCrossChecksEnabled"), "exported for the C3 control");
  assert.match(hookText, /useEffect\(\(\) => \{\s+runtimeCrossChecksEnabledRef\.current =\s+state\.settings\.runtimeCrossChecksEnabled;\s+\}, \[state\.settings\.runtimeCrossChecksEnabled\]\);/);
  assert.match(hookText, /const runtimeCrossChecksEnabledRef = useRef\(\s*state\.settings\.runtimeCrossChecksEnabled\s*\);/);
  assert.doesNotMatch(hookText, /previewMode|observerRegistry|observationScheduler/);
  const setter = callback("setRuntimeCrossChecksEnabled").getText(hook);
  // The setter only flips the ref, records the change and persists. It starts and cancels nothing.
  assert.doesNotMatch(setter, /cancelAll|dispose|releaseSession|setState|schedule[A-Z]|runAdvisor|invalidateRuntimeWork|unpublishedArtifactSlotRef/);
});

async function startRecording(manager: SessionRecordingManager, settings: MeetingAssistantSettings) {
  await manager.start({
    meetingSessionId: "meeting-A", settings,
    providerSummary: { hasMainProvider: false, hasCodingProvider: false, hasTaxonomyAdjudicationProvider: false,
      hasSttProvider: false, mainSupportsImages: false, codingSupportsImages: false },
  });
}
const lifecycleEvents = (files: RecorderFile[]) => files
  .filter((file) => file.args.relativePath === "timeline.jsonl")
  .flatMap((file) => String(file.args.payload).split("\n").filter(Boolean).map((line) => JSON.parse(line)))
  .filter((event) => event.kind === "capture-lifecycle" && event.metadata?.stage === "runtime-cross-checks-updated");

test("PC6 a change of the switch is recorded through the capture lifecycle while a recording is active, and nothing reaches disk when Recording is off", async () => {
  const { manager, files } = recorder();
  const h = settingsHarness(undefined, { manager });
  // Recording off: the change is applied and nothing is written or started.
  h.globals.setRuntimeCrossChecksEnabled(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.globals.state.settings.runtimeCrossChecksEnabled, true);
  assert.equal(files.length, 0, "no recorder write and no recording started");
  assert.equal(manager.getState().active, false);

  // Recording on: the start snapshot carries the current value, with no recorder change.
  await startRecording(manager, h.globals.state.settings);
  const snapshot = files.find((file) => file.args.relativePath === "settings/meeting-assistant-settings.json");
  assert.ok(snapshot, "settings snapshot written at recording start");
  assert.equal(JSON.parse(String(snapshot.args.payload)).settings.runtimeCrossChecksEnabled, true);
  const manifest = files.find((file) => file.args.relativePath === "manifest.json");
  assert.equal(JSON.parse(String(manifest!.args.payload)).settings.runtimeCrossChecksEnabled, true);
  const startedAt = Date.now();
  h.globals.setRuntimeCrossChecksEnabled(false);
  // Setting the value it already has is not a change.
  h.globals.setRuntimeCrossChecksEnabled(false);
  h.globals.setRuntimeCrossChecksEnabled(true);
  // Debug changes are not Cross-checks changes.
  h.globals.setDebugMode(true);
  await manager.stop("test-complete");
  const events = lifecycleEvents(files);
  assert.deepEqual(events.map((event) => event.metadata), [
    { stage: "runtime-cross-checks-updated", runtimeCrossChecksEnabled: false, previousRuntimeCrossChecksEnabled: true },
    { stage: "runtime-cross-checks-updated", runtimeCrossChecksEnabled: true, previousRuntimeCrossChecksEnabled: false },
  ]);
  // Each record carries the time of the change.
  for (const event of events) assert.ok(event.createdAt >= startedAt && event.createdAt <= Date.now());
});

// ---- PC7: Artifact reuse ----

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

// The Hook's real reuse-input reader over the settings the real setters produce.
function reuseHarness() {
  const h = settingsHarness();
  Object.assign(h.globals, {
    structuredClone,
    artifactReuseSettingsRef: { get current() { return h.globals.state.settings; } },
    manualCorrectionRevisionRef: { current: 0 },
    preparationRuntimeContextRef: { current: { preparationContextRevision: 1 } },
    latestScreenHashRef: { current: "screen-hash" },
    contextManagerRef: { current: { getState: () => ({ transcriptTurns: [{ id: "turn-1" }], screenObservations: [{ id: "observation-1" }] }) } },
  });
  const read = evaluate(callback("readArtifactReuseInputs"), h.globals) as () => ArtifactReuseInputs;
  return { ...h, read: () => plain(read()) as ArtifactReuseInputs };
}

test("PC7 toggling Cross-checks between offer and take keeps a reusable Artifact; the reuse inputs hold it at one constant", () => {
  for (const [atOffer, atTake] of [[false, true], [true, false], [false, false], [true, true]]) {
    const h = reuseHarness();
    h.globals.setRuntimeCrossChecksEnabled(atOffer);
    const offered = h.read();
    assert.equal(h.globals.state.settings.runtimeCrossChecksEnabled, atOffer);
    // The switch is projected to one constant; every other setting is compared with its real value.
    assert.deepEqual(offered.settings, { ...plain(h.globals.state.settings), runtimeCrossChecksEnabled: false });
    assert.deepEqual([offered.manualCorrectionRevision, offered.preparationContextRevision, offered.screenHash,
      offered.latestTurnId, offered.latestObservationId], [0, 1, "screen-hash", "turn-1", "observation-1"]);
    const slot = new UnpublishedArtifactSlot();
    const answer = stableAnswer();
    // The switch changes between the generation that produced the offer and its acceptance, and again before the take.
    h.globals.setRuntimeCrossChecksEnabled(atTake);
    slot.accepted({ stable: answer, current: answer, target: regenerationTarget(answer), currentInputs: h.read(),
      offer: { parsed, inputs: offered, authorizedArtifacts: ["answer"] } });
    assert.equal(slot.present, true, `candidate installed with the switch ${atOffer} -> ${atTake}`);
    h.globals.setRuntimeCrossChecksEnabled(atOffer);
    h.globals.setRuntimeCrossChecksEnabled(atTake);
    const taken = slot.take({ target: regenerationTarget(answer), stable: answer, inputs: h.read() });
    assert.equal(taken.reason, "matched", `reused with the switch ${atOffer} -> ${atTake}`);
    assert.deepEqual(plain(taken.candidate!.sections), { code: parsed.sections.code, complexity: parsed.sections.complexity });
  }
});

test("PC7 toggling Cross-checks grants no generation: with no candidate there is still none, and an ineligible offer stays out", () => {
  const h = reuseHarness();
  const slot = new UnpublishedArtifactSlot();
  const answer = stableAnswer();
  for (const value of [true, false, true]) {
    h.globals.setRuntimeCrossChecksEnabled(value);
    assert.equal(slot.present, false);
    assert.equal(slot.take({ target: regenerationTarget(answer), stable: answer, inputs: h.read() }).reason, "candidate-missing");
  }
  // An offer whose Artifacts were already published is not a candidate, whatever the switch says.
  slot.accepted({ stable: answer, current: answer, target: regenerationTarget(answer), currentInputs: h.read(),
    offer: { parsed, inputs: h.read(), authorizedArtifacts: ["answer", "code", "complexity"] } });
  assert.equal(slot.present, false);
});

test("PC7 every other setting still invalidates a reusable Artifact", () => {
  const changes: Array<[string, (globals: Record<string, any>) => void]> = [
    ["debugMode", (globals) => globals.setDebugMode(true)],
    ["useMemory", (globals) => globals.updateSettings((previous: MeetingAssistantSettings) => ({ ...previous, useMemory: !previous.useMemory }))],
    ["personalEvidenceGuardrailMode", (globals) => globals.updateSettings((previous: MeetingAssistantSettings) =>
      ({ ...previous, personalEvidenceGuardrailMode: "shadow" }))],
    ["response", (globals) => globals.updateSettings((previous: MeetingAssistantSettings) =>
      ({ ...previous, response: { ...previous.response, length: "detailed" } }))],
    ["codingModel", (globals) => globals.updateSettings((previous: MeetingAssistantSettings) =>
      ({ ...previous, codingModel: { ...previous.codingModel, provider: "another" } }))],
    ["taxonomyAdjudication", (globals) => globals.updateSettings((previous: MeetingAssistantSettings) =>
      ({ ...previous, taxonomyAdjudication: { ...previous.taxonomyAdjudication, meetingMetadataMode: "enforcement" } }))],
    ["microphoneContextEnabled", (globals) => globals.updateSettings((previous: MeetingAssistantSettings) =>
      ({ ...previous, microphoneContextEnabled: !previous.microphoneContextEnabled }))],
    ["nativeStallDiagnosticsEnabled", (globals) => globals.updateSettings((previous: MeetingAssistantSettings) =>
      ({ ...previous, nativeStallDiagnosticsEnabled: !previous.nativeStallDiagnosticsEnabled }))],
    ["activeScreenTaskTimeoutMinutes", (globals) => globals.updateSettings((previous: MeetingAssistantSettings) =>
      ({ ...previous, activeScreenTaskTimeoutMinutes: previous.activeScreenTaskTimeoutMinutes + 1 }))],
    ["audio", (globals) => globals.updateSettings((previous: MeetingAssistantSettings) =>
      ({ ...previous, audio: { ...previous.audio, profile: "custom" } }))],
  ];
  // Every setting except the observation switch is covered by a change above.
  const defaults = settingsHarness().globals.state.settings;
  assert.deepEqual(changes.map(([key]) => key).sort(),
    Object.keys(defaults).filter((key) => key !== "runtimeCrossChecksEnabled").sort());
  for (const [key, change] of changes) {
    const h = reuseHarness();
    const slot = new UnpublishedArtifactSlot();
    const answer = stableAnswer();
    const offered = h.read();
    slot.accepted({ stable: answer, current: answer, target: regenerationTarget(answer), currentInputs: h.read(),
      offer: { parsed, inputs: offered, authorizedArtifacts: ["answer"] } });
    assert.equal(slot.present, true);
    change(h.globals);
    // With the observation switch flipped as well, the product setting is what decides.
    h.globals.setRuntimeCrossChecksEnabled(true);
    assert.equal(slot.take({ target: regenerationTarget(answer), stable: answer, inputs: h.read() }).reason, "inputs-changed", key);
  }
});

test("PC7 the existing diagnostic and capture gates do not read the observation setting", () => {
  for (const name of ["setSttEvaluationCaptureEnabled", "setNativeStallDiagnosticsEnabled", "setSessionRecordingEnabled",
    "startRuntimeRegressionRun", "injectNativeAudioFault", "setDebugMode"]) {
    assert.doesNotMatch(callback(name).getText(hook), /runtimeCrossChecks/, name);
  }
  // Native stall diagnostics still arms on its own setting and an active recording only.
  assert.match(hookText, /const enabled = state\.settings\.nativeStallDiagnosticsEnabled &&/);
});
