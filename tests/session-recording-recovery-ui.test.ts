import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { SessionRecordingManager } from "../src/lib/meeting/session-recording.js";
import type { MeetingAssistantSettings } from "../src/lib/meeting/types.js";

const source = readFileSync("src/pages/app/components/meeting/index.tsx", "utf8");
const file = ts.createSourceFile("meeting.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate: (node: ts.Node) => boolean, root: ts.Node = file): ts.Node {
  let result: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (result) return;
    if (predicate(node)) result = node;
    else ts.forEachChild(node, visit);
  }
  visit(root);
  assert.ok(result, "Missing production recording UI wiring");
  return result;
}
function attribute(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string) {
  return node.attributes.properties.find((property) =>
    ts.isJsxAttribute(property) && property.name.getText(file) === name
  ) as ts.JsxAttribute | undefined;
}
function attributeExpression(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string) {
  const value = attribute(node, name)?.initializer;
  assert.ok(value && ts.isJsxExpression(value) && value.expression);
  return value.expression.getText(file);
}
const switchNode = find((node) => ts.isJsxSelfClosingElement(node) &&
  node.tagName.getText(file) === "Switch" &&
  attribute(node, "onCheckedChange")?.initializer?.getText(file) === "{onSessionRecordingChange}"
);
const recordingSection = switchNode.parent.parent;
assert.ok(ts.isJsxElement(recordingSection));
const panelCall = find((node) => ts.isJsxSelfClosingElement(node) &&
  node.tagName.getText(file) === "ConfigurationsPanel"
) as ts.JsxSelfClosingElement;

type Element = { type: string; props: Record<string, any>; children: any[] };
function elements(root: any): Element[] {
  if (Array.isArray(root)) return root.flatMap(elements);
  if (!root || typeof root !== "object" || !root.type) return [];
  return [root, ...root.children.flatMap(elements)];
}
function text(root: any): string {
  if (Array.isArray(root)) return root.map(text).join("");
  return typeof root === "string" ? root : root?.children?.map(text).join("") ?? "";
}
function button(root: any, label: string) {
  const result = elements(root).find((node) => node.type === "Button" && text(node).trim() === label);
  assert.ok(result, `Missing ${label} button`);
  return result;
}
function evaluate(code: string, context: vm.Context) {
  return vm.runInContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
  }).outputText, context);
}

async function harness() {
  const calls: Array<{ command: string; args: Record<string, any> }> = [];
  const actions: any[] = [];
  let failTerminal = true;
  let failAbandonMarker = false;
  const context = vm.createContext({
    Error, String, sessionRecording: undefined, recordingRecoveryError: null,
    debugMode: false, scriptedValidation: false,
    React: { createElement: (type: string, props: Record<string, any>, ...children: any[]) => ({ type, props: props ?? {}, children }) },
    onSessionRecordingChange: () => { throw new Error("Must not start a new recording"); },
    onSessionScriptedValidationChange: () => {},
  });
  context.setRecordingRecoveryError = (message: string | null) => { context.recordingRecoveryError = message; };
  const manager = new SessionRecordingManager((state) => { context.sessionRecording = state; }, async <T>(command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    if (failTerminal && args.relativePath === "manifest.json" && JSON.parse(String(args.payload)).status === "stopped") {
      throw new Error("Final manifest unavailable");
    }
    if (failAbandonMarker && args.relativePath === "abandon.json") throw new Error("Disk still unavailable");
    return `/recordings/${args.folderName}` as T;
  });
  await manager.start({
    meetingSessionId: "meeting-already-stopped",
    settings: { codingModel: { enabled: false, provider: "", variables: {} }, taxonomyAdjudication: { enabled: true, provider: "", variables: {} } } as unknown as MeetingAssistantSettings,
    providerSummary: { hasMainProvider: false, hasCodingProvider: false, hasTaxonomyAdjudicationProvider: false, hasSttProvider: false, mainSupportsImages: false, codingSupportsImages: false },
  });
  await assert.rejects(manager.stop(), /Final manifest unavailable/);
  const owner = manager.getState();
  context.meeting = {
    isActive: false,
    stopSessionRecording: (reason: string, options: unknown) => {
      actions.push({ action: "stop", reason, options });
      return manager.stop(reason);
    },
    abandonSessionRecording: (reason: string) => {
      actions.push({ action: "abandon", reason });
      return manager.abandon(reason);
    },
  };
  // Resolve the actual parent JSX prop expressions, not hand-wired test props.
  for (const name of ["onSessionRecordingStop", "onSessionRecordingAbandon"]) {
    context[name] = evaluate(attributeExpression(panelCall, name), context);
  }
  for (const name of ["retryRecordingClose", "abandonRecordingClose"]) {
    const declaration = find((node) => ts.isVariableDeclaration(node) && node.name.getText(file) === name) as ts.VariableDeclaration;
    assert.ok(declaration.initializer && ts.isCallExpression(declaration.initializer));
    evaluate(`globalThis.${name} = ${declaration.initializer.arguments[0]!.getText(file)};`, context);
  }
  function collectTags(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(file);
      if (tag[0] === tag[0].toUpperCase()) context[tag] = tag;
    }
    ts.forEachChild(node, collectTags);
  }
  collectTags(recordingSection);
  evaluate(`globalThis.render = () => (${recordingSection.getText(file)});`, context);
  return {
    context, calls, actions, manager, owner,
    render: () => context.render(),
    restoreDisk: () => { failTerminal = false; },
    failMarker: () => { failAbandonMarker = true; },
    async click(label: string) {
      button(context.render(), label).props.onClick?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

test("RC UI: recovery remains reachable with Meeting stopped, Debug off and recording inactive", async () => {
  const h = await harness();
  const tree = h.render();
  assert.equal(h.manager.getState().active, false);
  assert.ok(button(tree, "Retry save"));
  assert.ok(button(tree, "Abandon close"));
  assert.ok(text(tree).includes(h.owner.folderPath!));
  assert.match(text(tree), /Final manifest unavailable/);
  const recordingSwitch = elements(tree).find((node) => node.type === "Switch")!;
  assert.equal(recordingSwitch.props.checked, false);
  assert.equal(recordingSwitch.props.disabled, true);
});

test("RC UI: actual Retry click retains error on failure then republishes the same payload and clears the error", async () => {
  const h = await harness();
  await h.click("Retry save");
  assert.equal(h.actions[0].action, "stop");
  assert.equal(h.actions[0].options.throwOnError, true);
  assert.equal(h.manager.getState().lifecycle, "close-failed");
  assert.match(text(h.render()), /Final manifest unavailable/);
  const beforeRetry = h.calls.length;
  h.restoreDisk();
  await h.click("Retry save");
  assert.equal(h.calls.length, beforeRetry + 1);
  const manifestWrites = h.calls.filter(({ args }) => args.relativePath === "manifest.json" && JSON.parse(args.payload).status === "stopped");
  assert.equal(manifestWrites.length, 3);
  assert.ok(manifestWrites.every(({ args }) => args.payload === manifestWrites[0].args.payload && args.folderName === h.owner.folderName));
  assert.equal(h.manager.getState().lifecycle, "idle");
  assert.equal(h.context.recordingRecoveryError, null);
  assert.doesNotMatch(text(h.render()), /Final manifest unavailable|Retry save|Abandon close/);
  assert.equal(h.context.meeting.isActive, false);
});

test("RC UI: only confirmed Abandon calls the owner; trigger and Cancel do not", async () => {
  const h = await harness();
  const tree = h.render();
  const trigger = elements(tree).find((node) => node.type === "DialogTrigger")!;
  assert.ok(button(trigger, "Abandon close"));
  assert.equal(button(trigger, "Abandon close").props.onClick, undefined);
  const confirmation = elements(tree).find((node) => node.type === "DialogContent")!;
  assert.match(text(confirmation), /in-process retry/);
  assert.match(text(confirmation), /No files will be deleted/);
  assert.ok(elements(confirmation).some((node) => node.type === "DialogClose" && text(node).trim() === "Cancel"));
  await h.click("Cancel");
  assert.equal(h.actions.length, 0);
  assert.equal(h.manager.getState().lifecycle, "close-failed");
  await h.click("Confirm abandon");
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].action, "abandon");
  assert.equal(h.manager.getState().lifecycle, "idle");
  const marker = h.calls.find(({ args }) => args.relativePath === "abandon.json")!;
  assert.equal(marker.args.folderName, h.owner.folderName);
  assert.equal(JSON.parse(marker.args.payload).status, "incomplete");
  assert.equal(h.calls.some(({ command }) => /delete|remove/.test(command)), false);
});

test("RC UI: Abandon marker failure stays visible after owner release", async () => {
  const h = await harness();
  h.failMarker();
  await h.click("Confirm abandon");
  assert.equal(h.manager.getState().lifecycle, "idle");
  assert.match(text(h.render()), /marker could not be persisted.*Disk still unavailable/);
});

test("RC UI: closing disables Start and removes recovery controls; stale handlers do nothing", async () => {
  const h = await harness();
  h.context.sessionRecording = { ...h.owner, lifecycle: "closing" };
  const tree = h.render();
  assert.equal(elements(tree).find((node) => node.type === "Switch")!.props.disabled, true);
  assert.doesNotMatch(text(tree), /Retry save|Confirm abandon/);
  await h.context.retryRecordingClose();
  await h.context.abandonRecordingClose();
  assert.equal(h.actions.length, 0);
});

test("RC UI: failed or unavailable recovery handler produces a visible error", async () => {
  const h = await harness();
  h.context.onSessionRecordingAbandon = async () => { throw new Error("Owner unavailable"); };
  await h.click("Confirm abandon");
  assert.match(text(h.render()), /Owner unavailable/);
  h.context.onSessionRecordingStop = async () => undefined;
  await h.click("Retry save");
  assert.match(text(h.render()), /Recording close is still unresolved/);
});
