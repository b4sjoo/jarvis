// 178/168 PC, commit C3: the Preview group, the Fact Risk Review selector and the
// Meeting Metadata selector in the Interview Brief area.
//
// The Hook's real settings defaults, reader, writer and setters and the page's
// real panel components and call-site prop expressions are loaded from source
// and evaluated. Only storage, React state and the leaf UI primitives (Button,
// Switch, Input, Label, Badge, icons) are substituted. The help-text tests also
// run the real guardrail, Metadata commit decision and context manager for the
// mode a rendered control stored. tests/preview-controls-consumer.test.mjs mounts
// the same panels with the real Hook in a real browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MeetingTraceStore } from "../src/lib/meeting/trace.js";
import { UnpublishedArtifactSlot, type ArtifactReuseInputs } from "../src/lib/meeting/unpublished-artifact.js";
import { commitStableAnswerRevision } from "../src/lib/meeting/stable-answer.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import type { ArtifactRegenerationTarget } from "../src/lib/meeting/artifact-regeneration.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import { buildFactAnchorDecision } from "../src/lib/meeting/fact-anchor-guardrail.js";
import { enforceFactAnchorOutput, projectFactAnchorStreamingPartial } from "../src/lib/meeting/fact-anchor-output-guardrail.js";
import { buildMeetingMetadataInferenceRequest, decideMeetingMetadataInferenceCommit, parseMeetingMetadataInferenceOutput,
  projectMeetingMetadataOpeningEvidence } from "../src/lib/meeting/meeting-metadata-inference.js";
import type { InterviewSessionBrief, MeetingMetadataInferenceMode, TranscriptTurn } from "../src/lib/meeting/types.js";
import {
  beginDiagnosticLogLevelApply, isDiagnosticLogLevel, projectDiagnosticLogLevel, settleDiagnosticLogLevelApply,
  type DiagnosticLogLevelProjection, type DiagnosticLogReceipt,
} from "../src/lib/meeting/diagnostic-log.js";

const hookText = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
const uiText = readFileSync("src/pages/app/components/meeting/index.tsx", "utf8");
const focusWindowText = readFileSync("src/pages/app/components/meeting/focus-window.tsx", "utf8");
const hook = ts.createSourceFile("hook.ts", hookText, ts.ScriptTarget.Latest, true);
const ui = ts.createSourceFile("meeting.tsx", uiText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function findAll(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(root);
  return found;
}
function find(root: ts.Node, predicate: (node: ts.Node) => boolean, what = "production declaration"): ts.Node {
  const found = findAll(root, predicate);
  assert.ok(found.length > 0, `${what} must exist`);
  return found[0]!;
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
function callback(name: string) {
  const node = expression(hook, name);
  assert.ok(ts.isCallExpression(node), `${name} is a hook callback`);
  return node.arguments[0]!;
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
function load(source: ts.SourceFile, globals: Record<string, any>, names: string[]) {
  for (const name of names) globals[name] = evaluate(expression(source, name), source, globals);
}
// Evaluates a page expression whose free names are all inert stand-ins, except the ones given.
function evaluateWithStubs(node: ts.Node, source: ts.SourceFile, known: Record<string, unknown>): any {
  const inert: any = new Proxy(function () {}, {
    get: (_target, key) => (key === Symbol.toPrimitive ? () => "" : inert),
    apply: () => inert,
    construct: () => inert,
  });
  const scope = new Proxy({}, {
    has: (_target, key) => typeof key === "string",
    get: (_target, key) => typeof key !== "string" ? undefined
      : key in known ? known[key] : key in globalThis ? (globalThis as any)[key] : inert,
  });
  const output = ts.transpileModule(`(${node.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
  }).outputText.replace(/^\s*"use strict";/, "");
  return new Function("scope", `with (scope) { return ${output} }`)(scope);
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const compact = (value: string) => value.replace(/\s+/g, "");

// ---- the real settings owner ----

const SETTINGS_KEY = "test-settings";
const BRIEF_KEY = "test-brief";
const REAL_SETTERS = [
  "setDebugMode", "setNativeStallDiagnosticsEnabled", "setDiagnosticLogLevel", "setRuntimeCrossChecksEnabled", "setUseMemory",
  "setPersonalEvidenceGuardrailMode", "setCodingModelConfig", "setTaxonomyAdjudicationConfig",
];
// Every other function the two call sites pass down. A call is recorded, never performed.
const RECORDED_ACTIONS = [
  "setResponseConfig", "setActiveScreenTaskTimeoutMinutes", "setMeetingAudioProfile", "setMeetingAudioConfig",
  "setMicrophoneContextEnabled", "setSessionRecordingEnabled", "stopSessionRecording", "abandonSessionRecording",
  "setSessionScriptedValidation", "startRuntimeRegressionRun", "stopRuntimeRegressionRun", "resetRuntimeRegressionRun",
  "submitRuntimeRegressionText", "setSttEvaluationCaptureEnabled", "deleteSttEvaluationCapture",
  "setInterviewSessionBrief", "clearInterviewSessionBrief", "setPreparationRuntimeCapabilities",
];
const brief = Object.freeze({
  targetCompany: "Oracle", targetCompanyNormalized: "oracle", companyLocked: true,
  interviewTypes: Object.freeze(["coding"]), updatedAt: 1,
});
const preparationRuntime = Object.freeze({
  mode: "neutral", loadState: "ready", snapshot: undefined,
  capabilities: { runtimeReinforcement: { enabled: false, available: false }, personalizedGuidance: { enabled: false, available: false } },
});

// panelState replaces the initial value of a ConfigurationsPanel useState, by its declared name.
interface HarnessOptions { dev?: boolean; state?: Record<string, unknown>; panelState?: Record<string, unknown> }

// The names ConfigurationsPanel declares with useState, in call order.
let panelStateNames: string[] | undefined;
function configurationsPanelStateNames() {
  panelStateNames ??= findAll(expression(ui, "ConfigurationsPanel"), (node) => ts.isVariableDeclaration(node) &&
    ts.isArrayBindingPattern(node.name) && Boolean(node.initializer) && ts.isCallExpression(node.initializer!) &&
    node.initializer.expression.getText(ui) === "useState")
    .map((node) => ((node as ts.VariableDeclaration).name as ts.ArrayBindingPattern).elements[0]!.getText(ui));
  return panelStateNames;
}

function harness(stored?: string, options: HarnessOptions = {}) {
  const writes: Array<{ key: string; value: string }> = [];
  const actions: Array<{ name: string; args: unknown[] }> = [];
  const globals = vm.createContext({
    STORAGE_KEYS: { MEETING_ASSISTANT_SETTINGS: SETTINGS_KEY, MEETING_INTERVIEW_BRIEF: BRIEF_KEY },
    safeLocalStorage: {
      getItem: (key: string) => (key === SETTINGS_KEY ? stored ?? null : null),
      setItem: (key: string, value: string) => { writes.push({ key, value }); },
    },
    // Task 178 LG: the one function the settings reader imports from the diagnostic log module.
    isDiagnosticLogLevel,
  }) as Record<string, any>;
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
    ts.isPropertyAssignment(node) && node.name.getText(hook) === "settings") as ts.PropertyAssignment;
  globals.DEFAULT_MEETING_ASSISTANT_SETTINGS = evaluate(initialSettings.initializer, hook, globals);
  globals.state = {
    status: "idle", isActive: false, audioStatus: undefined, nativeStallDiagnostics: undefined,
    // Task 178 LG: this harness holds no level apply and no logger, so the page is given no Log Level status and no loss counts.
    diagnosticLogLevelStatus: undefined,
    diagnosticLogLoss: undefined,
    settings: globals.readMeetingAssistantSettings(),
    interviewSessionBrief: brief, preparationRuntime,
    aiProviders: [{ id: "test-provider", curl: "" }],
    sessionRecording: { lifecycle: "idle", active: false }, scriptedValidation: false,
    runtimeRegression: { active: false, status: "idle", steps: [] },
    sttEvaluationCapture: { lifecycle: "idle", active: false },
    ...options.state,
  };
  globals.setState = (update: (state: any) => any) => { globals.state = update(globals.state); };
  globals.traceStoreRef = { current: new MeetingTraceStore() };
  // The refs start from the loaded settings, as the Hook declares and syncs them.
  globals.runtimeCrossChecksEnabledRef = { current: globals.state.settings.runtimeCrossChecksEnabled };
  globals.taxonomyAdjudicationSettingsRef = { current: globals.state.settings.taxonomyAdjudication };
  // Task 178 LG: the saved level as the level setter reads it, and the counter it raises when that level is selected again.
  globals.diagnosticLogLevelRef = { current: globals.state.settings.diagnosticLogLevel };
  globals.diagnosticLogLevelReapplies = 0;
  globals.setDiagnosticLogLevelReapply = (update: (count: number) => number) => {
    globals.diagnosticLogLevelReapplies = update(globals.diagnosticLogLevelReapplies);
  };
  globals.sessionRecordingManagerRef = { current: undefined };
  globals.updateSettings = evaluate(callback("updateSettings"), hook, globals);
  for (const name of REAL_SETTERS) globals[name] = evaluate(callback(name), hook, globals);
  // What the page receives from the Hook: its state and its functions.
  globals.meeting = new Proxy({}, {
    get: (_target, key) => {
      if (typeof key !== "string") return undefined;
      if (key in globals.state) return globals.state[key];
      if (REAL_SETTERS.includes(key)) return globals[key];
      if (RECORDED_ACTIONS.includes(key)) return (...args: unknown[]) => { actions.push({ name: key, args }); };
      throw new Error(`The call site reads an unknown Hook member: meeting.${key}`);
    },
  });

  // The page's own locals at the two call sites and the leaf primitives.
  const passthrough = (tag: string) => ({ children }: any) => React.createElement(tag, null, children);
  // Counts the useState calls of one ConfigurationsPanel invocation; -1 outside of it.
  let panelStateCall = -1;
  Object.assign(globals, {
    React, exports: {}, importMeta: { env: { DEV: options.dev ?? false } },
    useState: (initial: any) => {
      const name = panelStateCall >= 0 ? configurationsPanelStateNames()[panelStateCall++] : undefined;
      const overridden = name !== undefined && options.panelState !== undefined && name in options.panelState;
      return [overridden ? options.panelState![name!] : initial, () => undefined];
    },
    useEffect: () => undefined, useCallback: (fn: any) => fn,
    cn: (...values: any[]) => values.filter(Boolean).join(" "),
    Button: ({ children, onClick, disabled, variant, title }: any) =>
      React.createElement("button", { onClick, disabled, title, "data-variant": variant }, children),
    Switch: ({ checked, disabled }: any) =>
      React.createElement("input", { type: "checkbox", checked: Boolean(checked), disabled, readOnly: true }),
    Label: passthrough("div"), Badge: passthrough("span"), Input: "input", Textarea: "textarea", MeetingAudioSlider: () => null,
    Dialog: passthrough("div"), DialogTrigger: passthrough("div"), DialogContent: passthrough("div"), DialogTitle: passthrough("div"),
    DialogDescription: passthrough("div"), DialogFooter: passthrough("div"), DialogClose: passthrough("div"),
    extractVariables: () => [],
    configurationsOpen: true, interviewBriefOpen: true,
    setConfigurationsOpen: () => undefined, setInterviewBriefOpen: () => undefined,
    nativeAudioFaultFeedback: { inFlightKind: null, lastResult: null },
    handleNativeAudioFaultInjection: async () => undefined,
  });
  for (const icon of panelIcons()) globals[icon] = () => null;
  load(ui, globals, [
    "WRAP_TEXT_CLASS", "responseLengthOptions", "responseLanguageOptions", "enforcementShadowModeOptions",
    "diagnosticLogLevelOptions", "meetingAudioProfileOptions", "TASK_TIMEOUT_OPTIONS", "formatTaskTimeout", "formatSilenceDuration",
    "EMPTY_INTERVIEW_SESSION_BRIEF", "interviewBriefTypeOptions", "concreteInterviewBriefTypes", "toggleInterviewBriefType",
    "getEditableInterviewSessionBrief", "isEditableInterviewSessionBriefEmpty", "formatInterviewBriefType",
    "formatInterviewBriefSummary", "formatPreparationRuntimeIdentity", "formatPreparationRuntimeDetail",
    "InterviewTypeButtonGrid", "ConfigurationGroup", "ConfigButtonGrid", "MeetingModelOverrideConfig",
    "ConfigurationsPanel", "InterviewSessionBriefPanel",
  ]);
  const configurationsPanel = globals.ConfigurationsPanel;
  globals.ConfigurationsPanel = (props: any) => {
    panelStateCall = 0;
    try { return configurationsPanel(props); } finally { panelStateCall = -1; }
  };
  const settingsWrites = () => writes.filter((write) => write.key === SETTINGS_KEY).map((write) => write.value);
  return { globals, writes, actions, settingsWrites, settings: () => plain(globals.state.settings) };
}
type Harness = ReturnType<typeof harness>;

let iconNames: string[] | undefined;
function panelIcons() {
  iconNames ??= ["ConfigurationsPanel", "InterviewSessionBriefPanel", "MeetingModelOverrideConfig", "InterviewTypeButtonGrid"]
    .flatMap((name) => findAll(expression(ui, name), (candidate) =>
      ts.isJsxSelfClosingElement(candidate) && candidate.tagName.getText(ui).endsWith("Icon")))
    .map((node) => (node as ts.JsxSelfClosingElement).tagName.getText(ui));
  return iconNames;
}

// ---- rendering the real panels through their real call sites ----

type PanelName = "ConfigurationsPanel" | "InterviewSessionBriefPanel";
const callSites = new Map<PanelName, Record<string, ts.Expression>>();
function callSiteExpressions(panel: PanelName): Record<string, ts.Expression> {
  let expressions = callSites.get(panel);
  if (expressions) return expressions;
  const sites = findAll(ui, (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText(ui) === panel);
  assert.equal(sites.length, 1, `${panel} is rendered from one call site`);
  expressions = {};
  for (const property of (sites[0] as ts.JsxSelfClosingElement).attributes.properties) {
    assert.ok(ts.isJsxAttribute(property), "the call site spreads no props");
    const value = property.initializer;
    assert.ok(value && ts.isJsxExpression(value) && value.expression);
    expressions[property.name.getText(ui)] = value.expression;
  }
  callSites.set(panel, expressions);
  return expressions;
}
function callSiteProps(h: Harness, panel: PanelName) {
  return Object.fromEntries(Object.entries(callSiteExpressions(panel))
    .map(([name, node]) => [name, evaluate(node, ui, h.globals)]));
}

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

function renderPanel(h: Harness, panel: PanelName) {
  const props = callSiteProps(h, panel);
  const tree = renderTree(React.createElement(h.globals[panel], props));
  const all = nodes(tree);
  const of = (type: any, within: Rendered[] = all) => within.filter((node) => node.type === type);
  return {
    tree, all, of, props,
    html: () => renderToStaticMarkup(React.createElement(h.globals[panel], props)),
    grid: (label: string) => {
      const grids = of(h.globals.ConfigButtonGrid).filter((node) => node.props.label === label);
      assert.equal(grids.length, 1, `one "${label}" selector`);
      const buttons = of(h.globals.Button, nodes(grids[0]!.children));
      return {
        node: grids[0]!, buttons,
        options: buttons.map((button) => text(button.children)),
        selected: buttons.filter((button) => button.props.variant === "default").map((button) => text(button.children)),
        click: (option: string) => {
          const button = buttons.find((candidate) => text(candidate.children) === option);
          assert.ok(button, `option ${option}`);
          button.props.onClick();
        },
      };
    },
  };
}
function configurations(h: Harness) {
  const panel = renderPanel(h, "ConfigurationsPanel");
  const groups = panel.of(h.globals.ConfigurationGroup);
  const group = (title: string) => {
    const found = groups.filter((node) => node.props.title === title);
    assert.equal(found.length, 1, `one ${title} group`);
    return { node: found[0]!, all: nodes(found[0]!.children), text: text(found[0]!.children) };
  };
  const crossChecks = () => {
    const switches = panel.of(h.globals.Switch, group("Preview").all);
    assert.equal(switches.length, 1, "one switch in the Preview group");
    return switches[0]!;
  };
  return { ...panel, groups, group, crossChecks, factRisk: () => panel.grid("Fact Guardrail & Review") };
}
function briefPanel(h: Harness) {
  const panel = renderPanel(h, "InterviewSessionBriefPanel");
  return { ...panel, metadata: () => panel.grid("Meeting Metadata"), text: text(panel.tree) };
}
// What the three controls show for the settings currently held.
function shown(h: Harness) {
  const c = configurations(h);
  const b = briefPanel(h);
  return {
    crossChecks: c.crossChecks().props.checked,
    factRisk: c.factRisk().selected,
    metadata: b.metadata().selected,
    metadataOffNote: /Stored mode is Off/.test(b.text),
  };
}

// Verbatim UI text of this commit.
const CROSS_CHECKS_HELP = "Allows four extra record-only comparison runs: split Relation with Canonical, Whiteboard syntax repair, " +
  "Meeting Metadata against a company that is already set, and Semantic Type / Interviewer Intent. Formal Question Type, " +
  "Relation, answers and Fact Risk Review are not controlled by this switch. On adds model requests.";
const FACT_RISK_HELP = "Both modes review eligible answers after display. Enforcement shows risk notes; Shadow records them. " +
  "The same mode controls fact guardrails: for Behavioral and Project Deep Dive, Enforcement buffers incomplete sentences " +
  "and removes invalid Supporting anchor IDs while retaining narrative text. For personal logistics it may sanitize or " +
  "replace unsupported claims. Shadow leaves generated output unchanged. The review itself never rewrites answers.";
const METADATA_HELP = "Enforcement can set the company for this session from grounded opening evidence when none is set; " +
  "the Target company field above and the saved Brief are not edited. Shadow makes the same request and only records the " +
  "result. Neither mode changes a company that is already set. Saved as a Meeting setting; Clear does not reset it.";
const METADATA_OFF_NOTE = "Stored mode is Off: no request is made until you pick a mode.";

// ---- PC1: frontend and settings ----

test("PC1 Preview is a grouping with exactly two controls and no master switch", () => {
  const h = harness();
  const c = configurations(h);
  assert.deepEqual(c.groups.map((node) => node.props.title), ["Response", "Context", "Audio", "Preview", "Debug"]);
  const preview = c.group("Preview");
  // The group is given a title, an icon and its rows. Nothing switches it and it holds no value.
  assert.deepEqual(Object.keys(preview.node.props).sort(), ["children", "icon", "title"]);
  const header = preview.all.find((node) => typeof node.props.className === "string" && node.props.className.includes("font-semibold"));
  assert.ok(header, "the group header");
  assert.equal(text(header.children), "Preview");
  assert.equal(nodes(header.children).filter((node) =>
    node.type === h.globals.Switch || node.type === h.globals.Button || node.type === "input" || node.type === "button").length, 0);
  // Exactly two controls: one Switch and one two-option selector.
  const switches = c.of(h.globals.Switch, preview.all);
  const grids = c.of(h.globals.ConfigButtonGrid, preview.all);
  const buttons = c.of(h.globals.Button, preview.all);
  assert.equal(switches.length, 1);
  assert.equal(grids.length, 1);
  assert.deepEqual(grids.map((node) => node.props.label), ["Fact Guardrail & Review"]);
  assert.deepEqual(buttons.map((node) => text(node.children)), ["Enforcement", "Shadow"]);
  assert.deepEqual(c.of(h.globals.Button, nodes(grids[0]!.children)).length, 2, "both buttons belong to the selector");
  for (const other of ["select", "textarea", h.globals.MeetingModelOverrideConfig, h.globals.MeetingAudioSlider]) {
    assert.equal(c.of(other, preview.all).length, 0);
  }
  assert.equal(preview.all.filter((node) => node.type === "input").length, 1, "the only input is the Cross-checks switch");
  const labels = preview.all.filter((node) => typeof node.props.className === "string" &&
    node.props.className.includes("uppercase")).map((node) => text(node.children));
  assert.deepEqual(labels, ["Runtime Cross-checks", "Fact Guardrail & Review"]);
  assert.doesNotMatch(preview.text, /\bOff\b|Preview mode|Enable Preview/);
  assert.deepEqual(h.writes, [], "rendering writes nothing");
  assert.deepEqual(h.actions, []);
  // No Preview state exists: no setting, no panel prop, no Hook member.
  assert.equal(Object.keys(h.settings()).some((key) => /preview/i.test(key)), false);
  assert.equal(Object.keys(c.props).some((key) => /preview/i.test(key)), false);
  const previewState = /\bpreviewMode\b|\bpreviewEnabled\b|\bsetPreview[A-Z]|\bonPreview[A-Z]/;
  assert.equal(previewState.test(hookText), false, "the Hook holds no Preview state");
  assert.equal(previewState.test(uiText), false, "the page holds no Preview state");
});

test("PC1 Runtime Cross-checks is a two-state switch, off by default, written through the Hook's setter and read back after a reload", () => {
  const h = harness();
  assert.equal(h.settings().runtimeCrossChecksEnabled, false, "the default is false");
  const before = h.settings();
  const first = configurations(h).crossChecks();
  assert.equal(first.props.checked, false);
  assert.equal(first.props.disabled, undefined, "nothing disables it: not Debug, not Recording");
  assert.equal(first.props.onCheckedChange, h.globals.setRuntimeCrossChecksEnabled, "the Hook's own setter");
  first.props.onCheckedChange(true);
  assert.equal(h.globals.runtimeCrossChecksEnabledRef.current, true);
  assert.deepEqual(h.settings(), { ...before, runtimeCrossChecksEnabled: true }, "no other setting moves");
  assert.deepEqual(h.writes.map((write) => write.key), [SETTINGS_KEY]);
  assert.deepEqual(JSON.parse(h.settingsWrites()[0]!), { ...before, runtimeCrossChecksEnabled: true });
  assert.equal(configurations(h).crossChecks().props.checked, true);
  // Refresh.
  const reloaded = harness(h.settingsWrites()[0]);
  assert.deepEqual(reloaded.settings(), { ...before, runtimeCrossChecksEnabled: true });
  assert.equal(configurations(reloaded).crossChecks().props.checked, true);
  assert.deepEqual(reloaded.writes, [], "reading and rendering write nothing");
  configurations(reloaded).crossChecks().props.onCheckedChange(false);
  assert.deepEqual(harness(reloaded.settingsWrites()[0]).settings(), before);
  assert.deepEqual(h.actions.concat(reloaded.actions), []);
});

test("PC1 Fact Risk Review is an Enforcement / Shadow selector bound to the existing personalEvidenceGuardrailMode and its setter, with no Off", () => {
  const h = harness();
  const before = h.settings();
  assert.equal(before.personalEvidenceGuardrailMode, "enforcement", "the existing default");
  const first = configurations(h).factRisk();
  assert.deepEqual(first.options, ["Enforcement", "Shadow"]);
  assert.deepEqual(first.selected, ["Enforcement"]);
  assert.deepEqual(plain(first.node.props.options), [{ id: "enforcement", label: "Enforcement" }, { id: "shadow", label: "Shadow" }]);
  assert.equal(first.node.props.onChange, h.globals.setPersonalEvidenceGuardrailMode, "the existing setter, unwrapped");
  first.click("Shadow");
  assert.deepEqual(h.settings(), { ...before, personalEvidenceGuardrailMode: "shadow" }, "only the existing key is written");
  assert.deepEqual(configurations(h).factRisk().selected, ["Shadow"]);
  const reloaded = harness(h.settingsWrites()[0]);
  assert.deepEqual(reloaded.settings(), { ...before, personalEvidenceGuardrailMode: "shadow" });
  assert.deepEqual(configurations(reloaded).factRisk().selected, ["Shadow"]);
  configurations(reloaded).factRisk().click("Enforcement");
  assert.deepEqual(harness(reloaded.settingsWrites()[0]).settings(), before);
  // The value type still has two members and the reader still falls back to the default for anything else.
  const types = readFileSync("src/lib/meeting/types.ts", "utf8");
  assert.equal(types.includes('export type PersonalEvidenceGuardrailMode = "enforcement" | "shadow";'), true);
  for (const stored of ["off", "", 0, null, { mode: "shadow" }]) {
    const odd = harness(JSON.stringify({ personalEvidenceGuardrailMode: stored }));
    assert.equal(odd.settings().personalEvidenceGuardrailMode, "enforcement", JSON.stringify(stored));
    assert.deepEqual(configurations(odd).factRisk().selected, ["Enforcement"]);
    assert.deepEqual(odd.writes, []);
  }
});

test("PC1 the Rescue entry and the two old switch rows are gone from Configurations; the Fast Runtime model selector stays in Context", () => {
  const h = harness();
  const c = configurations(h);
  const html = c.html();
  assert.doesNotMatch(html, /Semantic Type Rescue|unknown-only rescue|Personal Fact Guardrail|Meeting Metadata Enforcement/);
  assert.equal(/Semantic Type Rescue|[sS]emanticTaxonomyMode|Personal Fact Guardrail|Meeting Metadata Enforcement/.test(uiText), false,
    "the page source carries none of the retired labels or props");
  // No Meeting Metadata control is left in Configurations.
  assert.equal(c.of(h.globals.ConfigButtonGrid).some((node) => node.props.label === "Meeting Metadata"), false);
  // "Log Level" is the selector Task 178 LG added to the Debug group.
  assert.deepEqual(c.of(h.globals.ConfigButtonGrid).map((node) => node.props.label), ["Length", "Language", "Fact Guardrail & Review", "Log Level"]);
  const context = c.group("Context");
  const models = c.of(h.globals.MeetingModelOverrideConfig, context.all);
  assert.deepEqual(models.map((node) => node.props.label), ["Fast Runtime model"]);
  assert.equal(c.of(h.globals.Switch, context.all).length, 1, "Use Memory is the only switch left in Context");
  assert.match(context.text, /Use Memory/);
  assert.equal(c.of("select").length, 2, "coding and runtime provider selectors remain");
  assert.equal(c.of(h.globals.MeetingModelOverrideConfig, c.group("Preview").all).length, 0);
});

test("PC1 Meeting Metadata is a two-option selector inside the Interview Brief panel that writes settings.taxonomyAdjudication through the existing setter and nothing of the Brief", () => {
  const h = harness(JSON.stringify({ taxonomyAdjudication: { provider: "runtime", variables: { MODEL: "runtime-model" }, meetingMetadataMode: "shadow" } }));
  const before = h.settings();
  const briefBefore = JSON.stringify(h.globals.state.interviewSessionBrief);
  const b = briefPanel(h);
  assert.match(b.text, /^Interview Brief/, "rendered by the Interview Brief panel");
  const metadata = b.metadata();
  assert.deepEqual(metadata.options, ["Enforcement", "Shadow"], "no Off option");
  assert.deepEqual(metadata.selected, ["Shadow"]);
  assert.equal(b.props.onTaxonomyAdjudicationChange, h.globals.setTaxonomyAdjudicationConfig, "the existing setter");
  assert.equal(b.props.taxonomyAdjudication, h.globals.state.settings.taxonomyAdjudication, "the existing owner object");
  const headerBefore = b.html().split("Preparation snapshot")[0];
  metadata.click("Enforcement");
  // One write, to the settings key, of the same payload shape the old switch sent.
  assert.deepEqual(h.writes.map((write) => write.key), [SETTINGS_KEY]);
  assert.deepEqual(h.settings(), { ...before, taxonomyAdjudication: { ...before.taxonomyAdjudication, meetingMetadataMode: "enforcement" } });
  assert.deepEqual(plain(h.globals.taxonomyAdjudicationSettingsRef.current), h.settings().taxonomyAdjudication, "the scheduler's ref moves in the same call");
  assert.deepEqual(h.settings().taxonomyAdjudication, { enabled: true, questionTypeMode: "enforcement", taskRelationMode: "shadow",
    meetingMetadataMode: "enforcement", provider: "runtime", variables: { MODEL: "runtime-model" } });
  // Nothing of the Brief, the Preparation snapshot or Context was asked to change.
  assert.deepEqual(h.actions, [], "no Brief change, no Clear, no Preparation capability change");
  assert.equal(JSON.stringify(h.globals.state.interviewSessionBrief), briefBefore);
  assert.equal(h.globals.state.interviewSessionBrief, brief, "the same frozen Brief object");
  const after = briefPanel(h);
  assert.deepEqual(after.metadata().selected, ["Enforcement"]);
  assert.equal(after.html().split("Preparation snapshot")[0], headerBefore, "summary and Active badge are unchanged");
  assert.match(headerBefore!, /Oracle \/ locked \/ Coding/);
  assert.match(headerBefore!, /Active/);
  // The setter reaches only the settings owner: it is evaluated without a context manager,
  // a Brief writer or a Preparation runtime in scope, and it names none of them.
  assert.doesNotMatch(callback("setTaxonomyAdjudicationConfig").getText(hook),
    /contextManagerRef|[bB]rief|[pP]reparation|targetCompany|companyLocked|interviewSessionContext/);
  // Refresh.
  const reloaded = harness(h.settingsWrites()[0]);
  assert.deepEqual(reloaded.settings(), h.settings());
  assert.deepEqual(briefPanel(reloaded).metadata().selected, ["Enforcement"]);
  assert.deepEqual(reloaded.writes, []);
});

test("PC1 the Brief's own controls still write only the Brief, and Clear does not touch the Metadata mode", () => {
  const h = harness(JSON.stringify({ taxonomyAdjudication: { meetingMetadataMode: "enforcement" } }));
  const b = briefPanel(h);
  const inMetadata = new Set(b.metadata().buttons);
  const clear = b.of(h.globals.Button).find((node) => text(node.children).trim() === "Clear");
  assert.ok(clear && !inMetadata.has(clear));
  assert.equal(clear.props.disabled, false);
  clear.props.onClick();
  assert.deepEqual(h.actions.map((action) => action.name), ["clearInterviewSessionBrief"]);
  const company = b.all.find((node) => node.type === "input" && node.props.placeholder);
  assert.ok(company);
  company.props.onChange({ currentTarget: { value: "Anthropic" } });
  assert.equal(h.actions[1]!.name, "setInterviewSessionBrief");
  assert.equal((h.actions[1]!.args[0] as any).targetCompany, "Anthropic");
  assert.equal("meetingMetadataMode" in (h.actions[1]!.args[0] as any), false);
  assert.equal("taxonomyAdjudication" in (h.actions[1]!.args[0] as any), false);
  assert.deepEqual(h.writes, [], "no settings write from a Brief edit or from Clear");
  assert.equal(h.settings().taxonomyAdjudication.meetingMetadataMode, "enforcement");
});

test("PC1 a stored legacy Metadata off shows neither option and a one-line note, is not rewritten by rendering, and selecting a mode writes that mode", () => {
  const stored = { useMemory: false, taxonomyAdjudication: { provider: "runtime", variables: { MODEL: "m" }, meetingMetadataMode: "off" } };
  for (const picked of ["Enforcement", "Shadow"]) {
    const h = harness(JSON.stringify(stored));
    assert.equal(h.settings().taxonomyAdjudication.meetingMetadataMode, "off", "the reader keeps the stored off");
    const before = h.settings();
    const b = briefPanel(h);
    const metadata = b.metadata();
    assert.deepEqual(metadata.options, ["Enforcement", "Shadow"], "Off is not offered");
    assert.deepEqual(metadata.selected, [], "neither option is selected");
    assert.deepEqual(metadata.buttons.map((button) => button.props.variant), ["outline", "outline"]);
    const notes = b.all.filter((node) => text(node.children) === METADATA_OFF_NOTE);
    assert.equal(notes.length, 1, "one note line");
    assert.equal(b.of(h.globals.Button).some((button) => /^off$/i.test(text(button.children).trim())), false);
    // Rendering, and an unrelated save, leave the stored off in place for the backend.
    assert.deepEqual(h.writes, []);
    assert.equal(h.globals.taxonomyAdjudicationSettingsRef.current.meetingMetadataMode, "off");
    h.globals.setDebugMode(true);
    assert.equal(JSON.parse(h.settingsWrites()[0]!).taxonomyAdjudication.meetingMetadataMode, "off");
    assert.deepEqual(briefPanel(harness(h.settingsWrites()[0])).metadata().selected, []);
    // Picking a mode writes exactly that mode and keeps the rest of the owner object.
    briefPanel(h).metadata().click(picked);
    const mode = picked.toLowerCase();
    assert.deepEqual(h.settings(), { ...before, debugMode: true, taxonomyAdjudication: { ...before.taxonomyAdjudication, meetingMetadataMode: mode } });
    assert.equal(h.globals.taxonomyAdjudicationSettingsRef.current.meetingMetadataMode, mode);
    const after = briefPanel(h);
    assert.deepEqual(after.metadata().selected, [picked]);
    assert.doesNotMatch(after.text, /Stored mode is Off/);
    const reloaded = harness(h.settingsWrites().at(-1));
    assert.deepEqual(reloaded.settings(), h.settings());
    assert.deepEqual(briefPanel(reloaded).metadata().selected, [picked]);
    assert.deepEqual(h.actions, []);
  }
  // The note appears for off only.
  for (const mode of ["shadow", "enforcement"]) {
    const h = harness(JSON.stringify({ taxonomyAdjudication: { meetingMetadataMode: mode } }));
    assert.doesNotMatch(briefPanel(h).text, /Stored mode is Off/);
  }
});

test("PC1 stored old values load without a write and render truthfully; the default is false; a save then a reload reads back the same values", () => {
  const defaults = harness();
  assert.deepEqual(shown(defaults), { crossChecks: false, factRisk: ["Enforcement"], metadata: ["Shadow"], metadataOffNote: false });
  assert.deepEqual(defaults.writes, []);
  const absent = Symbol("absent");
  const crossChecks: Array<[unknown, boolean]> = [[absent, false], [false, false], [true, true], ["true", false], [1, false], [null, false], [{ enabled: true }, false]];
  const guardrail: Array<[unknown, string]> = [[absent, "Enforcement"], ["enforcement", "Enforcement"], ["shadow", "Shadow"], ["off", "Enforcement"]];
  const metadata: Array<[unknown, string[], boolean]> = [[absent, ["Shadow"], false], ["off", [], true], ["shadow", ["Shadow"], false],
    ["enforcement", ["Enforcement"], false], ["garbage", ["Shadow"], false]];
  let cases = 0;
  for (const [storedCrossChecks, expectedCrossChecks] of crossChecks) {
    for (const [storedGuardrail, expectedGuardrail] of guardrail) {
      for (const [storedMetadata, expectedMetadata, expectedNote] of metadata) {
        // An older store: Debug on, the retired semantic mode present, no Preview key of any kind.
        const stored: Record<string, unknown> = { debugMode: true, semanticTaxonomyMode: "enforcement", useMemory: false };
        if (storedCrossChecks !== absent) stored.runtimeCrossChecksEnabled = storedCrossChecks;
        if (storedGuardrail !== absent) stored.personalEvidenceGuardrailMode = storedGuardrail;
        if (storedMetadata !== absent) stored.taxonomyAdjudication = { provider: "runtime", variables: {}, meetingMetadataMode: storedMetadata };
        const label = JSON.stringify(stored);
        const h = harness(JSON.stringify(stored));
        const expected = { crossChecks: expectedCrossChecks, factRisk: [expectedGuardrail], metadata: expectedMetadata, metadataOffNote: expectedNote };
        assert.deepEqual(shown(h), expected, label);
        assert.equal(h.settings().runtimeCrossChecksEnabled, expectedCrossChecks, label);
        assert.equal(h.settings().debugMode, true, label);
        assert.deepEqual(h.writes, [], `loading and rendering perform no migration write: ${label}`);
        // An unrelated save, then a reload: the same values and the same display.
        const loaded = h.settings();
        h.globals.setUseMemory(true);
        const reloaded = harness(h.settingsWrites()[0]);
        assert.deepEqual(reloaded.settings(), { ...loaded, useMemory: true }, label);
        assert.equal("semanticTaxonomyMode" in reloaded.settings(), false);
        assert.deepEqual(shown(reloaded), expected, label);
        assert.deepEqual(h.actions.concat(reloaded.actions), [], label);
        cases += 1;
      }
    }
  }
  assert.equal(cases, 7 * 4 * 5);
  for (const broken of ["{broken", "null", "[]"]) {
    assert.deepEqual(shown(harness(broken)), shown(defaults), broken);
  }
});

test("PC1 the Fast Runtime model selector and the Meeting Metadata selector keep each other's stored fields", () => {
  const fastRuntime = (h: Harness) => {
    const c = configurations(h);
    const model = c.of(h.globals.MeetingModelOverrideConfig).find((node) => node.props.label === "Fast Runtime model");
    assert.ok(model);
    const select = nodes(model.children).find((node) => node.type === "select");
    assert.ok(select);
    return select;
  };
  for (const mode of ["off", "shadow", "enforcement"]) {
    const h = harness(JSON.stringify({ taxonomyAdjudication: { provider: "", variables: {}, meetingMetadataMode: mode } }));
    fastRuntime(h).props.onChange({ target: { value: "test-provider" } });
    assert.deepEqual(h.settings().taxonomyAdjudication, { enabled: true, questionTypeMode: "enforcement", taskRelationMode: "shadow",
      meetingMetadataMode: mode, provider: "test-provider", variables: {} }, `the model change keeps ${mode}`);
    assert.equal(fastRuntime(h).props.value, "test-provider");
    assert.equal(/Stored mode is Off/.test(briefPanel(h).text), mode === "off");
    briefPanel(h).metadata().click("Shadow");
    assert.deepEqual(h.settings().taxonomyAdjudication, { enabled: true, questionTypeMode: "enforcement", taskRelationMode: "shadow",
      meetingMetadataMode: "shadow", provider: "test-provider", variables: {} }, "the mode change keeps the model");
    fastRuntime(h).props.onChange({ target: { value: "" } });
    assert.equal(h.settings().taxonomyAdjudication.meetingMetadataMode, "shadow");
    assert.equal(h.settings().taxonomyAdjudication.provider, "");
    assert.deepEqual(h.actions, []);
  }
});

test("PC1 both call sites bind the existing owner values and setters; no setting key, store, page or Focus copy is added", () => {
  const configurationsSite = callSiteExpressions("ConfigurationsPanel");
  const briefSite = callSiteExpressions("InterviewSessionBriefPanel");
  const bound = (site: Record<string, ts.Expression>, name: string) => compact(site[name]!.getText(ui));
  assert.equal(bound(configurationsSite, "runtimeCrossChecksEnabled"), "meeting.settings.runtimeCrossChecksEnabled");
  assert.equal(bound(configurationsSite, "onRuntimeCrossChecksEnabledChange"), "meeting.setRuntimeCrossChecksEnabled");
  assert.equal(bound(configurationsSite, "personalEvidenceGuardrailMode"), "meeting.settings.personalEvidenceGuardrailMode");
  assert.equal(bound(configurationsSite, "onPersonalEvidenceGuardrailModeChange"), "meeting.setPersonalEvidenceGuardrailMode");
  assert.equal(bound(configurationsSite, "taxonomyAdjudication"), "meeting.settings.taxonomyAdjudication");
  assert.equal(bound(configurationsSite, "onTaxonomyAdjudicationChange"), "meeting.setTaxonomyAdjudicationConfig");
  assert.equal(bound(briefSite, "taxonomyAdjudication"), "meeting.settings.taxonomyAdjudication");
  assert.equal(bound(briefSite, "onTaxonomyAdjudicationChange"), "meeting.setTaxonomyAdjudicationConfig");
  assert.equal(bound(briefSite, "onBriefChange"), "meeting.setInterviewSessionBrief");
  assert.equal(bound(briefSite, "onClear"), "meeting.clearInterviewSessionBrief");
  // The settings object has the keys it had before this commit, and diagnosticLogLevel, which Task 178 LG added later.
  assert.deepEqual(Object.keys(harness().settings()).sort(), ["activeScreenTaskTimeoutMinutes", "audio", "codingModel", "debugMode",
    "diagnosticLogLevel", "microphoneContextEnabled", "nativeStallDiagnosticsEnabled", "personalEvidenceGuardrailMode", "response",
    "runtimeCrossChecksEnabled", "taxonomyAdjudication", "useMemory"]);
  // One Hook instance feeds the page, and neither panel reads or writes storage itself.
  assert.equal(uiText.split("useMeetingAssistant(").length - 1, 1);
  for (const panel of ["ConfigurationsPanel", "InterviewSessionBriefPanel"]) {
    assert.doesNotMatch(expression(ui, panel).getText(ui), /safeLocalStorage|localStorage|STORAGE_KEYS/, panel);
  }
  // Focus has no copy of the three controls and its snapshot carries no setting.
  const settingNames = /runtimeCrossChecks|[pP]ersonalEvidenceGuardrailMode|taxonomyAdjudication|meetingMetadataMode|enforcementShadowModeOptions/;
  assert.equal(settingNames.test(expression(ui, "FocusModePanel").getText(ui)), false, "FocusModePanel");
  assert.equal(settingNames.test(focusWindowText), false, "focus-window.tsx");
  assert.equal(settingNames.test(readFileSync("src/lib/meeting/focus-window.ts", "utf8")), false, "focus-window.ts");
  const crossCheckSwitches = findAll(ui, (node) => ts.isJsxAttribute(node) && node.name.getText(ui) === "onCheckedChange" &&
    Boolean(node.initializer?.getText(ui).includes("RuntimeCrossChecks")));
  assert.equal(crossCheckSwitches.length, 1, "one Cross-checks control in the page");
});

test("PC1 labels and help text say what each control governs and promise no stopped request", () => {
  const h = harness(JSON.stringify({ taxonomyAdjudication: { meetingMetadataMode: "off" } }));
  const preview = configurations(h).group("Preview");
  const lines = (all: Rendered[]) => all.filter((node) => node.type === "div" && node.children.every((child) => typeof child === "string"))
    .map((node) => text(node.children));
  assert.deepEqual(lines(preview.all), ["Runtime Cross-checks", CROSS_CHECKS_HELP, "Fact Guardrail & Review", FACT_RISK_HELP]);
  const b = briefPanel(h);
  const metadataRow = b.all.find((node) => node.type === "div" && node.children.some((child) =>
    typeof child !== "string" && child.type === h.globals.ConfigButtonGrid && child.props.label === "Meeting Metadata"));
  assert.ok(metadataRow);
  assert.deepEqual(lines(nodes(metadataRow.children)), ["Meeting Metadata", METADATA_HELP, METADATA_OFF_NOTE]);
  // Shadow is described as a mode that still requests, never as a stop.
  for (const help of [FACT_RISK_HELP, METADATA_HELP]) {
    assert.doesNotMatch(help, /no request|stops? (the |its )?request|does not (send|request)|turns? off|disabled?/i);
  }
  assert.match(FACT_RISK_HELP, /Both modes review eligible answers after display/);
  // The mode is named for more than the review: Enforcement can change the visible answer, Shadow does not.
  assert.match(FACT_RISK_HELP, /same mode controls fact guardrails/);
  assert.match(FACT_RISK_HELP, /removes invalid Supporting anchor IDs while retaining narrative text/);
  assert.match(FACT_RISK_HELP, /For personal logistics it may sanitize or replace unsupported claims/);
  assert.match(FACT_RISK_HELP, /Shadow leaves generated output unchanged/);
  assert.match(FACT_RISK_HELP, /review itself never rewrites answers/);
  assert.match(METADATA_HELP, /Shadow makes the same request/);
  // The selector sits under the Brief's Target company input and says that it does not fill that input.
  assert.match(METADATA_HELP, /^Enforcement can set the company for this session from grounded opening evidence when none is set;/);
  assert.match(METADATA_HELP, /the Target company field above and the saved Brief are not edited/);
  assert.doesNotMatch(METADATA_HELP, /fill an empty target company/);
  const company = b.text.indexOf("Target company");
  assert.ok(company >= 0 && company < b.text.indexOf("Meeting Metadata"), "the Target company field is above the selector");
  // The legacy note is one short sentence that says the stored value is off.
  assert.match(METADATA_OFF_NOTE, /^Stored mode is Off: /);
  assert.equal(METADATA_OFF_NOTE.split(/(?<=[.!?])\s+/).length, 1, "one sentence");
  assert.ok(METADATA_OFF_NOTE.length <= 64, "short enough for one line of the panel");
  // Cross-checks names its four families and does not claim to govern formal inference.
  for (const family of ["split Relation with Canonical", "Whiteboard syntax repair", "Meeting Metadata against a company that is already set",
    "Semantic Type / Interviewer Intent"]) assert.ok(CROSS_CHECKS_HELP.includes(family), family);
  assert.match(CROSS_CHECKS_HELP, /Formal Question Type, Relation, answers and Fact Risk Review are not controlled by this switch/);
});

test("PC1 the Fact Risk Review help is true of the mode the selector writes: Enforcement can hold back and replace a personal answer, Shadow leaves it as generated", () => {
  const h = harness();
  // The guardrail's own decision, streaming projection and commit step, given the mode the selector stored.
  const guardrail = (questionType: "unknown" | "behavioral", questionText: string, generated: string, streaming: string) => {
    const decision = buildFactAnchorDecision({ questionType, questionText,
      personalEvidenceGuardrailMode: h.settings().personalEvidenceGuardrailMode });
    const parsedAnswer = parseMeetingAnswer(generated);
    return { decision, generated: parsedAnswer.rawContent, streamed: projectFactAnchorStreamingPartial({ decision, content: streaming }),
      committed: enforceFactAnchorOutput({ decision, parsedAnswer }) };
  };
  // A personal-status question whose generated answer makes claims that no evidence supports.
  const status = () => guardrail("unknown", "Are you authorized to work in the United States?",
    "Answer: I require a $300,000 salary. I have no health restrictions.\nAnswer disposition: factual-with-anchor",
    "Answer: I require a $300,000 salary. I have no");
  // A behavioural question whose generated answer cites an anchor it was not given.
  const story = () => guardrail("behavioral", "Tell me about a time you disagreed with your manager.",
    "Answer: We improved latency by 40%.\nAnswer disposition: factual-with-anchor\nSupporting anchor IDs: mem_old_project",
    "Answer: We improved latency by 40%. And then");

  assert.deepEqual(configurations(h).factRisk().selected, ["Enforcement"]);
  const enforcedStatus = status();
  assert.equal(enforcedStatus.decision.personalEvidence.enforced, true);
  // "hold back streamed text": nothing of the unfinished, unsupported sentence is shown.
  assert.equal(enforcedStatus.streamed.bufferingEnabled, true);
  assert.equal(enforcedStatus.streamed.visibleContent, "");
  assert.ok(enforcedStatus.streamed.heldTrailingChars > 0);
  // "remove or replace unsupported personal claims": the committed answer is not the generated one.
  assert.equal(enforcedStatus.committed.commitSource, "sanitized-model-output");
  assert.equal(enforcedStatus.committed.modelOutputAuthorized, false);
  assert.notEqual(enforcedStatus.committed.effectiveContent, enforcedStatus.generated);
  assert.doesNotMatch(enforcedStatus.committed.effectiveContent, /300,000|health restrictions/);
  const enforcedStory = story();
  assert.equal(enforcedStory.streamed.bufferingEnabled, true);
  assert.equal(enforcedStory.streamed.visibleContent, "Answer: We improved latency by 40%.", "the unfinished sentence is held");
  assert.equal(enforcedStory.committed.commitSource, "sanitized-model-output");
  assert.doesNotMatch(enforcedStory.committed.effectiveContent, /mem_old_project/);
  assert.match(enforcedStory.committed.effectiveContent, /We improved latency by 40%\./,
    "the shared mode removes an invalid citation but retains ordinary Behavioral narrative");

  // The user picks Shadow in the rendered selector.
  configurations(h).factRisk().click("Shadow");
  assert.equal(h.settings().personalEvidenceGuardrailMode, "shadow");
  for (const shadow of [status(), story()]) {
    assert.equal(shadow.decision.personalEvidence.enforced, false);
    // "leaves the answer as generated": nothing is held and the generated text is committed unchanged.
    assert.equal(shadow.streamed.bufferingEnabled, false);
    assert.equal(shadow.streamed.heldTrailingChars, 0);
    assert.equal(shadow.committed.commitSource, "model-output");
    assert.equal(shadow.committed.modelOutputAuthorized, true);
    assert.equal(shadow.committed.effectiveContent, shadow.generated);
    // "only records what it observed".
    assert.equal(shadow.committed.reason, "shadow-observed");
  }
  assert.equal(status().decision.unsupportedClaimRisk, "shadow-observed");
  assert.equal(story().committed.shadowWouldCommitSource, "sanitized-model-output");
  // The Hook gives that decision the stored mode itself, for a Voice answer and for a Screen answer.
  const decisions = findAll(hook, (node) => ts.isCallExpression(node) && node.expression.getText(hook) === "buildFactAnchorDecision");
  assert.equal(decisions.length, 2);
  for (const decision of decisions) {
    const mode = ((decision as ts.CallExpression).arguments[0] as ts.ObjectLiteralExpression).properties
      .find((property) => property.name?.getText(hook) === "personalEvidenceGuardrailMode");
    assert.ok(mode && ts.isPropertyAssignment(mode));
    assert.equal(compact(mode.initializer.getText(hook)), "state.settings.personalEvidenceGuardrailMode");
  }
});

test("PC1 the Meeting Metadata help is true of the mode the selector writes: Enforcement sets the session company only when none is set, and the Brief field, the stored Brief and the panel stay as they were", () => {
  const opening: TranscriptTurn = { id: "them-1", text: "Welcome to the Stripe interview loop.", speaker: "them",
    startedAt: 1_000, endedAt: 1_500, isFinal: true, source: "system-audio" };
  // A valid, grounded, high-confidence proposal, parsed by the real parser for the real request.
  const proposal = (manager: MeetingContextManager) => parseMeetingMetadataInferenceOutput(JSON.stringify({ schemaVersion: 1,
    company: "Stripe", confidence: 0.99, evidenceSpans: ["Welcome to the Stripe interview loop"], abstainReason: null }),
    buildMeetingMetadataInferenceRequest({ sessionId: manager.getState().sessionId,
      evidence: projectMeetingMetadataOpeningEvidence({ transcriptTurns: [opening], sessionStartedAt: 500 }),
      authoritativeCompany: manager.getState().interviewSessionContext?.targetCompany }));
  const entered: InterviewSessionBrief = { targetCompany: "Oracle", targetCompanyNormalized: "oracle", companyLocked: false,
    interviewTypes: [], updatedAt: 9 };
  const companyInput = (h: Harness) => {
    const input = briefPanel(h).all.find((node) => node.type === "input" && node.props.placeholder);
    assert.ok(input, "the Target company input");
    return input.props.value;
  };
  // The Brief panel is given the Brief and nothing of the session context.
  assert.equal(compact(callSiteExpressions("InterviewSessionBriefPanel").brief!.getText(ui)), "meeting.interviewSessionBrief");
  assert.doesNotMatch(expression(ui, "InterviewSessionBriefPanel").getText(ui), /interviewSessionContext|runtime-inference/);

  for (const picked of ["Enforcement", "Shadow"]) for (const storedBrief of [undefined, entered]) {
    const label = `${picked}, Brief company ${storedBrief?.targetCompany ?? "empty"}`;
    const h = harness(JSON.stringify({ taxonomyAdjudication: { meetingMetadataMode: picked === "Enforcement" ? "shadow" : "enforcement" } }),
      { state: { interviewSessionBrief: storedBrief } });
    const headerBefore = briefPanel(h).html().split("Preparation snapshot")[0];
    briefPanel(h).metadata().click(picked);
    const mode: MeetingMetadataInferenceMode = h.settings().taxonomyAdjudication.meetingMetadataMode;
    assert.equal(mode, picked.toLowerCase(), label);
    // The session the mode acts on: the real context manager, started from the same Brief.
    const manager = new MeetingContextManager({ interviewSessionBrief: storedBrief });
    const before = manager.getState();
    const decision = decideMeetingMetadataInferenceCommit({ mode, leaseAuthorized: true,
      currentCompany: before.interviewSessionContext?.targetCompany, parseResult: proposal(manager) });
    const commits = picked === "Enforcement" && !storedBrief;
    assert.equal(decision.authorized, commits, label);
    if (decision.authorized) {
      const committed = manager.commitRuntimeInferredTargetCompany({ expectedSessionId: before.sessionId, targetCompany: decision.targetCompany });
      assert.equal(committed.committed, true, label);
    } else {
      // Shadow only records; a company that is already set is refused in either mode.
      assert.equal(decision.reason, picked === "Shadow" ? "mode-not-enforcement" : "company-already-resolved", label);
    }
    if (storedBrief) {
      // The commit itself also refuses to replace a company that is already set.
      assert.deepEqual(manager.commitRuntimeInferredTargetCompany({ expectedSessionId: before.sessionId,
        targetCompany: { value: "Stripe", normalized: "stripe", confidence: 0.99, evidence: "Welcome to the Stripe interview loop" } }),
        { committed: false, reason: "company-already-resolved" }, label);
    }
    const after = manager.getState();
    const company = after.interviewSessionContext?.targetCompany;
    if (commits) {
      assert.equal(company?.value, "Stripe", label);
      assert.equal(company?.source, "runtime-inference", "set for the session, not entered in the Brief");
    } else {
      assert.equal(company?.value, storedBrief?.targetCompany, label);
      assert.equal(company?.source, storedBrief ? "brief" : undefined, label);
    }
    // The Brief the session holds is the one it started with.
    assert.deepEqual(after.interviewSessionBrief, before.interviewSessionBrief, label);
    // The page after the commit: the session context moved, the Brief did not.
    h.globals.state = { ...h.globals.state, interviewSessionContext: after.interviewSessionContext };
    assert.equal(companyInput(h), storedBrief?.targetCompany ?? "", `the Target company field is not edited: ${label}`);
    assert.equal(briefPanel(h).html().split("Preparation snapshot")[0], headerBefore, label);
    assert.deepEqual(h.writes.map((write) => write.key), [SETTINGS_KEY], "only the mode was saved");
    assert.deepEqual(h.actions, [], label);
  }
});

// ---- PC7: cache and UI behaviour ----

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

// The Hook's real reuse-input reader over the settings the rendered controls write.
function reuseHarness() {
  const h = harness();
  Object.assign(h.globals, {
    structuredClone,
    artifactReuseSettingsRef: { get current() { return h.globals.state.settings; } },
    manualCorrectionRevisionRef: { current: 0 },
    preparationRuntimeContextRef: { current: { preparationContextRevision: 1 } },
    latestScreenHashRef: { current: "screen-hash" },
    contextManagerRef: { current: { getState: () => ({ transcriptTurns: [{ id: "turn-1" }], screenObservations: [{ id: "observation-1" }] }) } },
  });
  const read = evaluate(callback("readArtifactReuseInputs"), hook, h.globals) as () => ArtifactReuseInputs;
  return { ...h, read: () => plain(read()) as ArtifactReuseInputs };
}
function offeredCandidate(h: ReturnType<typeof reuseHarness>) {
  const slot = new UnpublishedArtifactSlot();
  const answer = stableAnswer();
  slot.accepted({ stable: answer, current: answer, target: regenerationTarget(answer), currentInputs: h.read(),
    offer: { parsed, inputs: h.read(), authorizedArtifacts: ["answer"] } });
  assert.equal(slot.present, true);
  return { slot, take: () => slot.take({ target: regenerationTarget(answer), stable: answer, inputs: h.read() }) };
}

test("PC7 the Cross-checks switch in the panel keeps a reusable Artifact matched and grants no generation", () => {
  for (const start of [false, true]) {
    const h = reuseHarness();
    if (start) configurations(h).crossChecks().props.onCheckedChange(true);
    const { take } = offeredCandidate(h);
    // The user flips the rendered switch, more than once, between the offer and the take.
    for (const value of [!start, start, !start]) {
      configurations(h).crossChecks().props.onCheckedChange(value);
      assert.equal(h.settings().runtimeCrossChecksEnabled, value);
    }
    const taken = take();
    assert.equal(taken.reason, "matched", `reused with the switch starting ${start}`);
    assert.deepEqual(plain(taken.candidate!.sections), { code: parsed.sections.code, complexity: parsed.sections.complexity });
  }
  // With nothing to reuse, the switch creates nothing.
  const h = reuseHarness();
  const empty = new UnpublishedArtifactSlot();
  const answer = stableAnswer();
  for (const value of [true, false, true]) {
    configurations(h).crossChecks().props.onCheckedChange(value);
    assert.equal(empty.present, false);
    assert.equal(empty.take({ target: regenerationTarget(answer), stable: answer, inputs: h.read() }).reason, "candidate-missing");
  }
  assert.deepEqual(h.actions, [], "the switch asks for no generation, recording or Brief change");
});

test("PC7 the product settings behind the other two controls still invalidate a reusable Artifact", () => {
  const changes: Array<[string, (h: ReturnType<typeof reuseHarness>) => void]> = [
    ["Fact Guardrail & Review", (h) => configurations(h).factRisk().click("Shadow")],
    ["Meeting Metadata", (h) => briefPanel(h).metadata().click("Enforcement")],
    ["Debug Mode", (h) => {
      const debug = configurations(h).of(h.globals.Switch, configurations(h).group("Debug").all)
        .find((node) => node.props.onCheckedChange === h.globals.setDebugMode);
      assert.ok(debug);
      debug.props.onCheckedChange(true);
    }],
  ];
  for (const [name, change] of changes) {
    const h = reuseHarness();
    const { take } = offeredCandidate(h);
    change(h);
    // The observation switch moving as well does not rescue the candidate.
    configurations(h).crossChecks().props.onCheckedChange(true);
    assert.equal(take().reason, "inputs-changed", name);
  }
});

// Debug x Recording x Cross-checks, plus the fourth input each gate has.
const booleans = [false, true];

test("PC7 STT Evaluation Capture keeps its Debug-or-Recording entry gate in the panel, the Hook guard and the auto-stop; Cross-checks is no input", () => {
  const canEnable = callSiteExpressions("ConfigurationsPanel").sttEvaluationCaptureCanEnable!;
  assert.doesNotMatch(canEnable.getText(ui), /runtimeCrossChecks|personalEvidence|taxonomyAdjudication/);
  const guard = callback("setSttEvaluationCaptureEnabled");
  const autoStop = find(hook, (node) => ts.isCallExpression(node) && node.expression.getText(hook) === "useEffect" &&
    node.getText(hook).includes("authorization-source-disabled"), "the STT auto-stop effect") as ts.CallExpression;
  assert.doesNotMatch(guard.getText(hook) + autoStop.getText(hook), /runtimeCrossChecks/);
  assert.equal(compact(autoStop.arguments[1]!.getText(hook)),
    "[state.sessionRecording.active,state.settings.debugMode,state.sttEvaluationCapture.active,]");
  let cells = 0;
  for (const debug of booleans) for (const recording of booleans) for (const crossChecks of booleans) for (const meetingActive of booleans) {
    const label = JSON.stringify({ debug, recording, crossChecks, meetingActive });
    // 1. The panel prop, evaluated from the call site, and the switch it disables.
    const h = harness(JSON.stringify({ debugMode: debug, runtimeCrossChecksEnabled: crossChecks }),
      { state: { isActive: meetingActive, sessionRecording: { lifecycle: recording ? "active" : "idle", active: recording } } });
    const allowed = !meetingActive && (debug || recording);
    const c = configurations(h);
    assert.equal(c.props.sttEvaluationCaptureCanEnable, allowed, label);
    const stt = c.of(h.globals.Switch, c.group("Debug").all).find((node) => node.props.onCheckedChange === c.props.onSttEvaluationCaptureChange);
    assert.ok(stt, "the STT switch is in the Debug group");
    assert.equal(Boolean(stt.props.disabled), !allowed, label);
    assert.equal(/Turn on Debug Mode or Session Recording, then enable before meeting audio\./.test(c.group("Debug").text), !allowed, label);
    // 2. The Hook's own guard.
    const started: unknown[] = [];
    const guardGlobals = vm.createContext({
      console, state: h.globals.state, shutdownRequestedRef: { current: false }, activeRef: { current: meetingActive },
      setState: (update: (state: any) => any) => { guardGlobals.error = update({}).error; },
      sttEvaluationCaptureManagerRef: { current: { start: async (hours: number) => { started.push(hours); }, stop: async () => undefined } },
      error: undefined as string | undefined,
    }) as Record<string, any>;
    evaluate(guard, hook, guardGlobals)(true);
    assert.deepEqual(started, allowed ? [72] : [], label);
    assert.equal(Boolean(guardGlobals.error), !allowed, label);
    // 3. The auto-stop when both authorising sources are off.
    for (const captureActive of booleans) {
      const stopped: string[] = [];
      evaluate(autoStop.arguments[0]!, hook, vm.createContext({
        console,
        state: { sttEvaluationCapture: { active: captureActive }, sessionRecording: { active: recording },
          settings: { debugMode: debug, runtimeCrossChecksEnabled: crossChecks } },
        sttEvaluationCaptureManagerRef: { current: { stop: async (reason: string) => { stopped.push(reason); } } },
      }))();
      assert.deepEqual(stopped, captureActive && !debug && !recording ? ["authorization-source-disabled"] : [], label);
    }
    cells += 1;
  }
  assert.equal(cells, 16);
});

test("PC7 Native Stall Diagnostics arms on its own setting and an active recording only, defaults to off and keeps its place", () => {
  const arming = find(hook, (node) => ts.isCallExpression(node) && node.expression.getText(hook) === "useEffect" &&
    node.getText(hook).includes("queueNativeStallDiagnostics(enabled"), "the arming effect") as ts.CallExpression;
  assert.doesNotMatch(arming.getText(hook), /runtimeCrossChecks|debugMode/);
  assert.equal(harness().settings().nativeStallDiagnosticsEnabled, false, "default off");
  let cells = 0;
  for (const setting of booleans) for (const recording of booleans) for (const folderName of [undefined, "folder-1"])
    for (const crossChecks of booleans) for (const debug of booleans) {
      const label = JSON.stringify({ setting, recording, folderName, crossChecks, debug });
      const queued: Array<[boolean, string | undefined]> = [];
      const cleanup = evaluate(arming.arguments[0]!, hook, vm.createContext({
        Boolean,
        state: { settings: { nativeStallDiagnosticsEnabled: setting, runtimeCrossChecksEnabled: crossChecks, debugMode: debug },
          sessionRecording: { active: recording, folderName } },
        queueNativeStallDiagnostics: (enabled: boolean, folder?: string) => { queued.push([enabled, folder]); },
      }))();
      const armed = setting && recording && Boolean(folderName);
      assert.deepEqual(queued, [[armed, folderName]], label);
      cleanup();
      assert.deepEqual(queued.slice(1), armed ? [[false, undefined]] : [], label);
      cells += 1;
    }
  assert.equal(cells, 32);
  // The switch stays in the Debug group, enabled, bound to its own setting and setter.
  for (const crossChecks of booleans) {
    const h = harness(JSON.stringify({ runtimeCrossChecksEnabled: crossChecks }));
    const c = configurations(h);
    const nsd = c.of(h.globals.Switch, c.group("Debug").all).find((node) => node.props.onCheckedChange === h.globals.setNativeStallDiagnosticsEnabled);
    assert.ok(nsd);
    assert.equal(nsd.props.checked, false);
    assert.equal(nsd.props.disabled, undefined);
    nsd.props.onCheckedChange(true);
    assert.equal(h.settings().nativeStallDiagnosticsEnabled, true);
    assert.equal(h.settings().runtimeCrossChecksEnabled, crossChecks);
    assert.match(c.group("Debug").text, /Native Stall DiagnosticsArms only while Session Recording is active/);
  }
});

test("PC7 Replay Lab and the native fault test stay behind DEV and Debug Mode inside the Debug group, whatever Cross-checks says", () => {
  const gates = ["startRuntimeRegressionRun", "injectNativeAudioFault"].map((name) => {
    const body = callback(name);
    assert.ok(ts.isArrowFunction(body) && ts.isBlock(body.body));
    const gate = body.body.statements.find((statement) => ts.isIfStatement(statement) &&
      statement.expression.getText(hook).includes("import.meta.env.DEV"));
    assert.ok(gate && ts.isIfStatement(gate), `${name} gate`);
    assert.equal(compact(gate.expression.getText(hook)), "!import.meta.env.DEV||!debugModeRef.current", name);
    return gate.expression;
  });
  let cells = 0;
  for (const dev of booleans) for (const debug of booleans) for (const crossChecks of booleans) {
    const label = JSON.stringify({ dev, debug, crossChecks });
    const h = harness(JSON.stringify({ debugMode: debug, runtimeCrossChecksEnabled: crossChecks }), { dev });
    const c = configurations(h);
    const debugGroup = c.group("Debug");
    for (const entry of ["Replay Lab", "Native Audio Fault Test"]) {
      assert.equal(debugGroup.text.includes(entry), dev && debug, `${entry} ${label}`);
      assert.equal(c.group("Preview").text.includes(entry), false);
    }
    assert.equal(debugGroup.text.includes("Scripted validation"), debug, label);
    for (const gate of gates) {
      const rejected = evaluate(gate, hook, vm.createContext({ exports: {}, importMeta: { env: { DEV: dev } },
        debugModeRef: { current: debug }, runtimeCrossChecksEnabledRef: { current: crossChecks } }));
      assert.equal(rejected, !(dev && debug), label);
    }
    cells += 1;
  }
  assert.equal(cells, 8);

  // The fault test's availability prop, from the call site, while meeting audio is and is not being captured.
  const available = callSiteExpressions("ConfigurationsPanel").nativeAudioFaultAvailable!;
  assert.doesNotMatch(available.getText(ui), /runtimeCrossChecks/);
  const capturing = { systemCaptureActive: true, captureOwner: "meeting", captureSessionId: "capture-1", captureGeneration: 0 };
  const audio: Array<[Record<string, unknown> | undefined, boolean]> = [[undefined, false], [capturing, true],
    [{ ...capturing, systemCaptureActive: false }, false], [{ ...capturing, captureOwner: "dictation" }, false],
    [{ ...capturing, captureSessionId: undefined }, false], [{ ...capturing, captureGeneration: undefined }, false]];
  let faultCells = 0;
  for (const dev of booleans) for (const debug of booleans) for (const crossChecks of booleans) for (const [audioStatus, captured] of audio) {
    const label = JSON.stringify({ dev, debug, crossChecks, audioStatus });
    const h = harness(JSON.stringify({ debugMode: debug, runtimeCrossChecksEnabled: crossChecks }), { dev, state: { audioStatus } });
    const c = configurations(h);
    const expected = dev && debug && captured;
    assert.equal(c.props.nativeAudioFaultAvailable, expected, label);
    const faults = c.of(h.globals.Button, c.group("Debug").all).filter((button) => ["Recoverable", "Fatal"].includes(text(button.children)));
    assert.equal(faults.length, dev && debug ? 2 : 0, label);
    for (const fault of faults) assert.equal(Boolean(fault.props.disabled), !expected, label);
    assert.equal(c.group("Debug").text.includes("Start meeting audio to enable fault injection."), dev && debug && !expected, label);
    faultCells += 1;
  }
  assert.equal(faultCells, 48);

  // The opened Replay Lab. The panel keeps "open" and the typed text in its own state.
  assert.deepEqual(configurationsPanelStateNames(), ["replayLabOpen", "replayText", "recordingRecoveryError"]);
  const runs = [{ active: false, status: "idle", steps: [] }, { active: false, status: "starting", steps: [] },
    { active: true, status: "ready", steps: [], scenarioRunId: "run-1" }];
  let labCells = 0;
  for (const dev of booleans) for (const debug of booleans) for (const runtimeRegression of runs) for (const lifecycle of ["idle", "active"]) {
    const label = JSON.stringify({ dev, debug, runtimeRegression: runtimeRegression.status, lifecycle });
    const opened = (crossChecks: boolean) => {
      const h = harness(JSON.stringify({ debugMode: debug, runtimeCrossChecksEnabled: crossChecks }), { dev,
        panelState: { replayLabOpen: true, replayText: "Next question" },
        state: { runtimeRegression, sessionRecording: { lifecycle, active: lifecycle === "active" } } });
      const c = configurations(h);
      const group = c.group("Debug");
      return { h, c, group, html: renderToStaticMarkup(React.createElement(h.globals.ConfigurationGroup, group.node.props)) };
    };
    const off = opened(false);
    assert.equal(opened(true).html, off.html, `the opened lab is the same with Cross-checks on: ${label}`);
    const named = (name: string) => off.c.of(off.h.globals.Button, off.group.all).filter((button) => text(button.children).trim() === name);
    const lab = dev && debug;
    assert.equal(named("Close").length, lab ? 1 : 0, label);
    assert.equal(named("Start Fresh Run").length, lab && !runtimeRegression.active ? 1 : 0, label);
    assert.equal(named("Send").length, lab && runtimeRegression.active ? 1 : 0, label);
    for (const start of named("Start Fresh Run")) {
      assert.equal(Boolean(start.props.disabled), runtimeRegression.status === "starting" || lifecycle !== "idle", label);
    }
    for (const send of named("Send")) assert.equal(Boolean(send.props.disabled), false, label);
    assert.equal(off.c.of("textarea", off.group.all).length, lab && runtimeRegression.active ? 1 : 0, label);
    labCells += 1;
  }
  assert.equal(labCells, 24);
  // Nothing in the Debug group, opened or closed, reads the Cross-checks setting.
  const debugGroup = find(expression(ui, "ConfigurationsPanel"), (node) => ts.isJsxElement(node) &&
    node.openingElement.tagName.getText(ui) === "ConfigurationGroup" &&
    node.openingElement.attributes.properties.some((property) => property.getText(ui) === 'title="Debug"'), "the Debug group");
  assert.doesNotMatch(debugGroup.getText(ui), /[rR]untimeCrossChecks/);
  assert.match(debugGroup.getText(ui), /Start Fresh Run/);
});

test("PC7 the Debug group is the same with Cross-checks on and off, and Session Recording, Native Stall Diagnostics and STT Evaluation Capture keep their place", () => {
  for (const dev of booleans) for (const debug of booleans) for (const recording of booleans) {
    const render = (crossChecks: boolean, guardrail: string) => {
      const h = harness(JSON.stringify({ debugMode: debug, runtimeCrossChecksEnabled: crossChecks, personalEvidenceGuardrailMode: guardrail }),
        { dev, state: { sessionRecording: { lifecycle: recording ? "active" : "idle", active: recording } } });
      const c = configurations(h);
      const group = c.group("Debug");
      return { h, c, group, html: renderToStaticMarkup(React.createElement(h.globals.ConfigurationGroup, group.node.props)) };
    };
    const off = render(false, "enforcement");
    const on = render(true, "shadow");
    assert.equal(on.html, off.html, JSON.stringify({ dev, debug, recording }));
    const { h, c, group } = off;
    // The entries by their own labels. The Log Level help text (Task 178 LG) names two of them, so a text search would find it first.
    const entryLabels = group.all.filter((node) => typeof node.props.className === "string" && node.props.className.includes("uppercase"))
      .map((node) => text(node.children));
    const order = ["Debug Mode", "Native Stall Diagnostics", "Session Recording", "STT Evaluation Capture"].map((entry) => entryLabels.indexOf(entry));
    assert.ok(order.every((index, position) => index >= 0 && (position === 0 || index > order[position - 1]!)), "entries in their order");
    const switches = c.of(h.globals.Switch, group.all);
    const handlers = switches.map((node) => node.props.onCheckedChange);
    for (const handler of [h.globals.setDebugMode, h.globals.setNativeStallDiagnosticsEnabled, c.props.onSessionRecordingChange,
      c.props.onSttEvaluationCaptureChange]) assert.equal(handlers.filter((candidate) => candidate === handler).length, 1);
    assert.equal(handlers.includes(h.globals.setRuntimeCrossChecksEnabled), false, "Cross-checks is not a Debug entry");
    const recordingSwitch = switches.find((node) => node.props.onCheckedChange === c.props.onSessionRecordingChange)!;
    assert.equal(recordingSwitch.props.checked, recording);
    assert.equal(Boolean(recordingSwitch.props.disabled), false);
    for (const title of ["Response", "Context", "Audio", "Preview"]) {
      const other = c.group(title).text;
      for (const entry of ["Debug Mode", "Native Stall Diagnostics", "Session Recording", "STT Evaluation Capture"]) {
        assert.equal(other.includes(entry), false, `${entry} is not in ${title}`);
      }
    }
  }
  // Recording lifecycle states disable the Session Recording switch as before.
  for (const lifecycle of ["idle", "active", "starting", "closing", "close-failed"]) {
    const h = harness(JSON.stringify({ runtimeCrossChecksEnabled: true }), { state: { sessionRecording: { lifecycle, active: lifecycle === "active" } } });
    const c = configurations(h);
    const recordingSwitch = c.of(h.globals.Switch, c.group("Debug").all).find((node) => node.props.onCheckedChange === c.props.onSessionRecordingChange)!;
    assert.equal(Boolean(recordingSwitch.props.disabled), ["starting", "closing", "close-failed"].includes(lifecycle), lifecycle);
  }
  assert.deepEqual([harness().settings().debugMode, harness().settings().nativeStallDiagnosticsEnabled], [false, false]);
});

test("PC7 Normal and Focus surfaces display one fact-risk result read from the Hook for the displayed answer", () => {
  // The behaviour is exercised in a real browser by tests/fact-risk-consumer.test.mjs. This pins the single source.
  const reads = findAll(ui, (node) => ts.isCallExpression(node) && node.expression.getText(ui) === "meeting.readFactRiskReview");
  assert.equal(reads.length, 1);
  assert.equal(compact(reads[0]!.parent.getText(ui)), "adviseDisplay.streaming?undefined:meeting.readFactRiskReview(adviseDisplay.stable)");
  const results = (source: ts.SourceFile) => findAll(source, (node) => ts.isJsxSelfClosingElement(node) &&
    node.tagName.getText(source) === "FactRiskNotice").map((node) => {
    const result = (node as ts.JsxSelfClosingElement).attributes.properties.find((property) => property.name?.getText(source) === "result") as ts.JsxAttribute;
    return compact(result.initializer!.getText(source));
  });
  assert.deepEqual(results(ui), ["{focusSnapshot.factRiskReview}", "{focusSnapshot.factRiskReview}", "{factRiskReview}"]);
  const focusPanel = find(ui, (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText(ui) === "FocusModePanel") as ts.JsxSelfClosingElement;
  const passed = focusPanel.attributes.properties.find((property) => property.name?.getText(ui) === "factRiskReview") as ts.JsxAttribute;
  assert.equal(compact(passed.initializer!.getText(ui)), "{focusSnapshot.factRiskReview}");
  const focusWindow = ts.createSourceFile("focus.tsx", focusWindowText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.deepEqual(results(focusWindow), ["{snapshot.factRiskReview}"]);
  // The page builds the Focus snapshot from that same read. The browser test's host composes its own
  // payload, so the page's composition is executed here: every other name is an inert stand-in.
  assert.equal(compact(expression(ui, "factRiskReview").getText(ui)),
    "adviseDisplay.streaming?undefined:meeting.readFactRiskReview(adviseDisplay.stable)");
  const memo = expression(ui, "focusSnapshot");
  assert.ok(ts.isCallExpression(memo) && memo.expression.getText(ui) === "useMemo", "focusSnapshot is a memo");
  const [compose, dependencies] = memo.arguments;
  assert.ok(compose && ts.isArrowFunction(compose) && dependencies && ts.isArrayLiteralExpression(dependencies));
  const composeWith = (factRiskReview: unknown) => {
    const composed: any[] = [];
    evaluateWithStubs(compose, ui, { factRiskReview,
      createMeetingFocusDisplayModel: (input: any) => { composed.push(input); return input; } })();
    assert.equal(composed.length, 1, "one snapshot is composed");
    return composed[0];
  };
  const review = Object.freeze({ answerKey: "displayed-answer", status: "completed", flags: [] });
  assert.equal(composeWith(review).factRiskReview, review, "the snapshot carries the single read");
  assert.equal("factRiskReview" in composeWith(undefined), true);
  assert.equal(composeWith(undefined).factRiskReview, undefined, "and nothing while the answer is streaming");
  assert.equal(dependencies.elements.filter((element) => element.getText(ui) === "factRiskReview").length, 1,
    "the snapshot is rebuilt when the read changes");
  // That one snapshot is what the in-page surfaces read and what is published to the Focus window.
  assert.equal(findAll(ui, (node) => ts.isCallExpression(node) &&
    compact(node.getText(ui)) === "focusPublisherRef.current?.publish(focusSnapshot)").length, 1);
  // The Hook decides display from the one existing mode; the selector is the only place the page sets it.
  assert.equal(hookText.includes(
    'readFactRiskReview: (stable: StableAnswerRevision | null | undefined) => state.settings.personalEvidenceGuardrailMode === "enforcement"'), true);
  assert.equal(uiText.split("onPersonalEvidenceGuardrailModeChange(").length - 1, 0, "the panel passes the setter through and wraps no logic around it");
  assert.equal(uiText.split("setPersonalEvidenceGuardrailMode").length - 1, 1);
});

// ---- Task 178 LG: the Log Level selector and its status line in the Debug group ----
// The projections are built by the real begin / settle / project functions of the diagnostic log
// module and handed to the page as the Hook member the call site reads. The Hook's own level block
// is exercised in tests/diagnostic-log-level-setting.test.ts and, mounted, in
// tests/preview-controls-consumer.test.mjs.

const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"] as const;
const LOG_LEVEL_LABELS = ["Error", "Warn", "Info", "Debug", "Trace"];
// Verbatim UI text of the selector.
const LOG_LEVEL_HELP = "Sets the threshold of the diagnostic log: entries at this level and every more severe level go to the terminal and to " +
  "local log files, which keep at most 50 MiB or 14 days. Errors and warnings cover failed Voice answers, capture, " +
  "recording and saving failures and lost model results. Info adds capture start and stop, manual corrections and Brief " +
  "updates. Debug and Trace add operation summaries and every trace and step change. No entry holds transcript, prompt or " +
  "answer text. Debug Mode alone no longer prints trace lines: they are Debug and Trace entries of this log. Saved " +
  "separately from Debug Mode. Log Level does not control Preparation, the focus window, shutdown messages, other console " +
  "and native prints, Session Recording or Native Stall Diagnostics files, and starts no model request, sampler or " +
  "capture.";
const logLevelPending = (level: string) => `Status: ${level} requested, waiting for the native reply. Not yet confirmed on native.`;
const logLevelApplied = (level: string, sink: string) => `Status: native applied ${level}. Log sink at that time: ${sink}.`;
const logLevelFailed = (level: string, message: string) => `Status: native did not confirm ${level}. Select ${level} again to retry. Reason: ${message}`;
const logLevelReceipt = (level: string, state: "ready" | "degraded" | "failed" = "ready"): DiagnosticLogReceipt => ({
  v: 1, appliedLevel: level as DiagnosticLogReceipt["appliedLevel"], accepted: 0, filtered: 0, rejected: 0, dropped: 0,
  sink: { state, droppedTotal: 0, writeFailures: 0, unsavedAtExit: 0 } });

// The Log Level block of the Debug group as rendered: the selector, the help text and the status lines.
function logLevelBlock(h: Harness) {
  const c = configurations(h);
  const debug = c.group("Debug");
  const grid = c.grid("Log Level");
  const block = debug.all.find((node) => node.children.includes(grid.node));
  assert.ok(block, "the Log Level block is in the Debug group");
  const rows = block.children.filter((child): child is Rendered => typeof child !== "string");
  assert.equal(rows[0], grid.node, "the selector comes first");
  const status = rows.slice(2);
  return { h, c, debug, grid, block, help: text(rows[1]!.children), status,
    statusText: status.map((node) => text(node.children)),
    red: status.map((node) => String(node.props.className).split(/\s+/).includes("text-red-600")) };
}

test("LG UI the Log Level selector is one five-option ConfigButtonGrid in the Debug group, under Debug Mode, with Debug on or off; it shows the saved level and writes it through the Hook's setter", () => {
  const site = callSiteExpressions("ConfigurationsPanel");
  assert.equal(compact(site.diagnosticLogLevel!.getText(ui)), "meeting.settings.diagnosticLogLevel");
  assert.equal(compact(site.onDiagnosticLogLevelChange!.getText(ui)), "meeting.setDiagnosticLogLevel");
  assert.equal(compact(site.diagnosticLogLevelStatus!.getText(ui)), "meeting.diagnosticLogLevelStatus");
  assert.equal(compact(site.diagnosticLogLoss!.getText(ui)), "meeting.diagnosticLogLoss");
  let cells = 0;
  for (const dev of booleans) for (const debug of booleans) for (const level of LOG_LEVELS) {
    const label = JSON.stringify({ dev, debug, level });
    const h = harness(JSON.stringify({ debugMode: debug, diagnosticLogLevel: level }), { dev });
    const { c, debug: group, grid, block } = logLevelBlock(h);
    assert.deepEqual(grid.options, LOG_LEVEL_LABELS, label);
    assert.deepEqual(grid.selected, [LOG_LEVEL_LABELS[LOG_LEVELS.indexOf(level)]], label);
    assert.equal(grid.node.props.value, level);
    assert.equal(grid.node.props.onChange, h.globals.setDiagnosticLogLevel, "the Hook's own setter, with nothing wrapped around it");
    assert.equal(c.of(h.globals.ConfigButtonGrid).filter((node) => node.props.label === "Log Level").length, 1, "one selector in the panel");
    // In the Debug group, directly after the Debug Mode row, and in no other group.
    const entryLabels = group.all.filter((node) => typeof node.props.className === "string" && node.props.className.includes("uppercase"))
      .map((node) => text(node.children));
    assert.deepEqual(entryLabels.slice(0, 3), ["Debug Mode", "Log Level", "Native Stall Diagnostics"], label);
    for (const title of ["Response", "Context", "Audio", "Preview"]) assert.equal(c.group(title).text.includes("Log Level"), false, title);
    // Buttons only: no switch, input, select or text area belongs to it.
    assert.equal(c.of(h.globals.Button, nodes(block.children)).length, 5, label);
    for (const other of [h.globals.Switch, "select", "input", "textarea"]) assert.equal(c.of(other, nodes(block.children)).length, 0, label);
    assert.equal(c.of("select").length, 2, "the panel still holds its two provider selectors and no new one");
    assert.deepEqual(h.writes, [], "rendering writes nothing");
    cells += 1;
  }
  assert.equal(cells, 20);
  // A click on each option, through the rendered button.
  for (const debug of booleans) {
    const h = harness(JSON.stringify({ debugMode: debug }));
    const before = h.settings();
    assert.equal(before.diagnosticLogLevel, "info", "the default");
    for (const [index, option] of LOG_LEVEL_LABELS.entries()) {
      logLevelBlock(h).grid.click(option);
      assert.deepEqual(h.settings(), { ...before, diagnosticLogLevel: LOG_LEVELS[index] }, "no other setting moves, Debug Mode included");
      assert.deepEqual(JSON.parse(h.settingsWrites().at(-1)!), { ...before, diagnosticLogLevel: LOG_LEVELS[index] });
      assert.deepEqual(logLevelBlock(h).grid.selected, [option]);
    }
    assert.equal(h.settingsWrites().length, 5);
    assert.deepEqual(h.actions, []);
    // And the Debug Mode switch leaves the level where it is.
    const debugSwitch = configurations(h).of(h.globals.Switch, configurations(h).group("Debug").all)
      .find((node) => node.props.onCheckedChange === h.globals.setDebugMode)!;
    debugSwitch.props.onCheckedChange(!debug);
    assert.deepEqual(h.settings(), { ...before, debugMode: !debug, diagnosticLogLevel: "trace" });
  }
});

test("LG UI one status line per projection state with exact text: pending, applied with the sink state, failed with the reason; no line when the Hook gives none", () => {
  const render = (level: string, status: DiagnosticLogLevelProjection | undefined, debug = false) =>
    logLevelBlock(harness(JSON.stringify({ debugMode: debug, diagnosticLogLevel: level }), { state: { diagnosticLogLevelStatus: status } }));
  let rendered = 0;
  for (const debug of booleans) for (const level of LOG_LEVELS) {
    const selected = [LOG_LEVEL_LABELS[LOG_LEVELS.indexOf(level)]];
    // No projection: the selector and the help, and no status.
    const none = render(level, undefined, debug);
    assert.deepEqual([none.statusText, none.grid.selected], [[], selected]);
    assert.equal(none.help, LOG_LEVEL_HELP);
    // Pending: before the first reply and while a request is unanswered.
    const request = beginDiagnosticLogLevelApply(1, level);
    for (const apply of [null, request]) {
      const pending = render(level, projectDiagnosticLogLevel({ level, apply }), debug);
      assert.deepEqual(pending.statusText, [logLevelPending(level)]);
      assert.deepEqual(pending.red, [false]);
      assert.deepEqual(pending.grid.selected, selected, "the selector shows the saved level");
      rendered += 1;
    }
    // Applied: the level native answered and the sink state of that answer.
    for (const sink of ["ready", "degraded", "failed"] as const) {
      const applied = render(level, projectDiagnosticLogLevel({ level,
        apply: settleDiagnosticLogLevelApply(request, 1, { receipt: logLevelReceipt(level, sink) }) }), debug);
      assert.deepEqual(applied.statusText, [logLevelApplied(level, sink)]);
      assert.deepEqual(applied.red, [sink === "failed"]);
      rendered += 1;
    }
    // Failed: native rejected, answered another level, answered something else, or did not answer.
    const failures: Array<[Parameters<typeof settleDiagnosticLogLevelApply>[2], string]> = [
      [{ message: "Diagnostic log level is not one of error, warn, info, debug, trace" }, "Diagnostic log level is not one of error, warn, info, debug, trace"],
      [{ message: "No native reply within 5000 ms." }, "No native reply within 5000 ms."],
      [{ receipt: logLevelReceipt(level === "info" ? "warn" : "info") }, `Native reports ${level === "info" ? "warn" : "info"}.`],
      [{ receipt: { v: 3 } as unknown as DiagnosticLogReceipt }, "The native reply was not a version 1 diagnostic log receipt."],
    ];
    for (const [outcome, message] of failures) {
      const failed = render(level, projectDiagnosticLogLevel({ level, apply: settleDiagnosticLogLevelApply(request, 1, outcome) }), debug);
      assert.deepEqual(failed.statusText, [logLevelFailed(level, message)]);
      assert.deepEqual(failed.red, [true]);
      assert.deepEqual(failed.grid.selected, selected, "the saved level stays selected; the line says it is not confirmed");
      rendered += 1;
    }
    // The record of another level is never this level's status: it reads as pending.
    const other = LOG_LEVELS[(LOG_LEVELS.indexOf(level) + 1) % LOG_LEVELS.length]!;
    const stale = render(level, projectDiagnosticLogLevel({ level,
      apply: settleDiagnosticLogLevelApply(beginDiagnosticLogLevelApply(1, other), 1, { receipt: logLevelReceipt(other) }) }), debug);
    assert.deepEqual(stale.statusText, [logLevelPending(level)]);
  }
  assert.equal(rendered, 2 * 5 * 9);
  // The status is text only, and the words that claim a native state belong to the applied line alone.
  const pending = render("trace", { phase: "pending", level: "trace" });
  const failed = render("trace", { phase: "failed", level: "trace", message: "boom" });
  const applied = render("trace", { phase: "applied", level: "trace", appliedLevel: "trace", sinkState: "ready" });
  for (const state of [pending, failed, applied]) {
    const controls = [state.h.globals.Button, state.h.globals.Switch, "button", "input", "select", "textarea", "a"];
    assert.equal(nodes(state.status).filter((node) => controls.includes(node.type)).length, 0, "no control in the status line");
    assert.equal(state.status.length, 1, "one line");
    assert.equal(state.help, LOG_LEVEL_HELP);
  }
  assert.match(text(applied.block.children), /native applied trace/);
  for (const state of [pending, failed]) {
    assert.doesNotMatch(text(state.block.children), /native applied|is active|in effect|Log sink/);
  }
  assert.match(text(pending.block.children), /Not yet confirmed on native/);
  assert.match(text(failed.block.children), /native did not confirm trace\. Select trace again to retry\. Reason: boom/);
});

// Task 178 LG (A4, A5, A6): the loss counts of the diagnostic log, as the Hook reads them from the logger's counters.
const NO_LOG_LOSS = { frontendShed: 0, frontendRefusedEntries: 0, frontendDetailLeftOut: 0, frontendInternalErrors: 0, frontendUndelivered: 0,
  nativeRejected: 0, nativeDropped: 0, nativeWriteFailures: 0 };
test("LG UI the loss line: absent while every count is zero, and otherwise one red text line that names each non-zero count in a fixed order, under the status", () => {
  const render = (loss: Record<string, number> | undefined, status?: DiagnosticLogLevelProjection) =>
    logLevelBlock(harness(JSON.stringify({ diagnosticLogLevel: "info" }), { state: { diagnosticLogLevelStatus: status, diagnosticLogLoss: loss } }));
  // Nothing lost, or nothing known: no line, with or without a status.
  const applied: DiagnosticLogLevelProjection = { phase: "applied", level: "info", appliedLevel: "info", sinkState: "ready" };
  for (const loss of [undefined, NO_LOG_LOSS]) {
    assert.deepEqual(render(loss).statusText, []);
    assert.deepEqual(render(loss, applied).statusText, [logLevelApplied("info", "ready")]);
  }
  // Each count alone, verbatim.
  for (const [key, line] of [
    ["frontendShed", "Log loss: frontend shed 3."],
    ["frontendRefusedEntries", "Log loss: frontend refused 3."],
    ["frontendDetailLeftOut", "Log loss: frontend detail left out 3."],
    ["frontendInternalErrors", "Log loss: frontend internal errors 3."],
    ["frontendUndelivered", "Log loss: frontend not delivered 3."],
    ["nativeRejected", "Log loss: native rejected 3."],
    ["nativeDropped", "Log loss: native dropped 3."],
    ["nativeWriteFailures", "Log loss: native write failures 3."],
  ] as const) {
    const alone = render({ ...NO_LOG_LOSS, [key]: 3 });
    assert.deepEqual([alone.statusText, alone.red], [[line], [true]], key);
  }
  // All of them, in the fixed order, under an unchanged status line.
  const all = render({ frontendShed: 5, frontendRefusedEntries: 1, frontendDetailLeftOut: 2, frontendInternalErrors: 4, frontendUndelivered: 64,
    nativeRejected: 3, nativeDropped: 7, nativeWriteFailures: 2 }, applied);
  assert.deepEqual(all.statusText, [logLevelApplied("info", "ready"),
    "Log loss: frontend shed 5, frontend refused 1, frontend detail left out 2, frontend internal errors 4, frontend not delivered 64, native rejected 3, native dropped 7, native write failures 2."]);
  // What native had not saved at exit is known only at exit: the page takes no such count and names none.
  assert.equal(/unsavedAtExit|not saved at exit/i.test(uiText), false);
  // Every count the Hook hands over is shown: the line has one part per member, and no member is left unnamed.
  assert.deepEqual(Object.keys(NO_LOG_LOSS).length, all.statusText[1]!.split(", ").length);
  assert.deepEqual(all.red, [false, true], "the applied line keeps its own colour");
  assert.equal(all.help, LOG_LEVEL_HELP);
  // Text only: the line holds no control, and a loss never changes what the selector shows or writes.
  const controls = [all.h.globals.Button, all.h.globals.Switch, "button", "input", "select", "textarea", "a"];
  assert.equal(nodes(all.status).filter((node) => controls.includes(node.type)).length, 0, "no control in the status lines");
  assert.deepEqual([all.grid.selected, all.h.writes], [["Info"], []]);
  // The page reads the counts from the Hook member alone: it imports nothing that runs from the logger module.
  assert.equal(/readDiagnosticLogSnapshot|logDiagnostic\(/.test(uiText), false);
});

test("LG UI the help text states what Log Level controls and what it does not, in the same words with Debug on and off", () => {
  for (const dev of booleans) for (const debug of booleans) for (const recording of booleans) {
    const h = harness(JSON.stringify({ debugMode: debug, diagnosticLogLevel: "trace" }),
      { dev, state: { sessionRecording: { lifecycle: recording ? "active" : "idle", active: recording } } });
    const { help, block } = logLevelBlock(h);
    assert.equal(help, LOG_LEVEL_HELP, JSON.stringify({ dev, debug, recording }));
    assert.equal(text(block.children), `Log Level${LOG_LEVEL_LABELS.join("")}${LOG_LEVEL_HELP}`, "the selector, the help and nothing else");
  }
  // The text is the design owner's ruling (decisions A8, item 7), sentence by sentence: the threshold and the retention
  // bounds; what each group of levels holds; what no entry holds; the consequence of the migration for Debug Mode; that
  // the level is saved on its own; and what it does not control.
  assert.deepEqual(LOG_LEVEL_HELP.split(/(?<=\.) /), [
    "Sets the threshold of the diagnostic log: entries at this level and every more severe level go to the terminal and to local log files, which keep at most 50 MiB or 14 days.",
    "Errors and warnings cover failed Voice answers, capture, recording and saving failures and lost model results.",
    "Info adds capture start and stop, manual corrections and Brief updates.",
    "Debug and Trace add operation summaries and every trace and step change.",
    "No entry holds transcript, prompt or answer text.",
    "Debug Mode alone no longer prints trace lines: they are Debug and Trace entries of this log.",
    "Saved separately from Debug Mode.",
    "Log Level does not control Preparation, the focus window, shutdown messages, other console and native prints, Session Recording or Native Stall Diagnostics files, and starts no model request, sampler or capture.",
  ]);
  // It claims no entry per Relation decision, no sameness of the levels and no gap that is closed since: the recording
  // close that fails has its error entry now.
  assert.doesNotMatch(LOG_LEVEL_HELP, /each Relation decision|every level gives the same output|holds only|no error entry yet/);
  // What it does not control is named, and nothing wider is promised. Debug Mode trace printing is not on that list:
  // there is none left to control.
  const notControlled = LOG_LEVEL_HELP.slice(LOG_LEVEL_HELP.indexOf("Log Level does not control "));
  assert.doesNotMatch(notControlled, /Debug Mode/);
  // The retention bounds of the local files, as the sink enforces them.
  assert.match(LOG_LEVEL_HELP, /local log files, which keep at most 50 MiB or 14 days\./);
  assert.match(LOG_LEVEL_HELP, /Saved separately from Debug Mode\./);
  assert.doesNotMatch(LOG_LEVEL_HELP, /all logs|every log|controls the console|recording level/i);
  // The page source holds each sentence once, in the Debug group.
  const debugGroup = find(expression(ui, "ConfigurationsPanel"), (node) => ts.isJsxElement(node) &&
    node.openingElement.tagName.getText(ui) === "ConfigurationGroup" &&
    node.openingElement.attributes.properties.some((property) => property.getText(ui) === 'title="Debug"'), "the Debug group");
  assert.equal(uiText.split('label="Log Level"').length - 1, 1);
  assert.equal(debugGroup.getText(ui).split('label="Log Level"').length - 1, 1);
  // The selector and its status sit outside every Debug Mode, DEV and recording condition of the group.
  const selector = find(debugGroup, (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText(ui) === "ConfigButtonGrid") as ts.JsxSelfClosingElement;
  for (let node: ts.Node = selector; node !== debugGroup; node = node.parent) {
    assert.equal(ts.isConditionalExpression(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken),
      false, "no condition encloses the selector");
  }
});
