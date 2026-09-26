import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function parse(file: string) {
  return ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function find<T extends ts.Node>(source: ts.Node, predicate: (node: ts.Node) => node is T): T | undefined {
  if (predicate(source)) return source;
  return ts.forEachChild(source, child => find(child, predicate));
}

test("HNSD: temporary hooks and fixture commands are gone, real diagnostics remain", () => {
  const paths = ["src/contexts/app.context.tsx", "src/hooks/useMeetingAssistant.ts", "src/pages/app/components/meeting/index.tsx", "src-tauri/src/lib.rs", "src-tauri/src/native_stall_diagnostics.rs", "architecture/architecture-contract.json"];
  for (const file of paths) {
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /VITE_NSD_FIXED_PROVIDER|debug_arm_native_stall_stage|debug_block_main_thread_for_stall_test|hold_emit_for_debug|debug_sampler_denied_marker|struct DebugFault/, file);
  }
  assert.equal(fs.existsSync("scripts/nsd-fixed-provider-server.mjs"), false);
  assert.equal(fs.existsSync("tests/nsd-fixed-provider-server.test.mjs"), false);
  assert.equal(JSON.parse(fs.readFileSync("package.json", "utf8")).scripts["test:nsd-fixed-provider"], undefined);
  const native = fs.readFileSync("src-tauri/src/native_stall_diagnostics.rs", "utf8");
  for (const symbol of ["CaptureCallbackCounters", "set_native_stall_diagnostics", "acknowledge_native_stall_marker", "start_observer", "sample_incident", "publish_sample_report"]) assert.ok(native.includes(symbol), symbol);
  assert.match(fs.readFileSync("src-tauri/src/lib.rs", "utf8"), /speaker::debug_inject_native_audio_fault/);
});

test("HNSD: actual AppContext projects the original Provider arrays and selected identities", () => {
  const source = parse("src/contexts/app.context.tsx");
  const declaration = find(source, (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && node.name.getText(source) === "value" && node.type?.getText(source) === "IContextType");
  assert.ok(declaration?.initializer && ts.isObjectLiteralExpression(declaration.initializer));
  const keys = ["allAiProviders", "selectedAIProvider", "allSttProviders", "selectedSttProvider"];
  const properties = declaration.initializer.properties.filter(node => node.name && keys.includes(node.name.getText(source)));
  assert.equal(properties.length, keys.length);
  assert.ok(properties.every(ts.isShorthandPropertyAssignment));
  const bindings = Object.fromEntries(keys.map(key => [key, Object.freeze({ identity: key })]));
  const result = vm.runInNewContext(`({${properties.map(p => p.getText(source)).join(",")}})`, bindings);
  for (const key of keys) assert.equal(result[key], bindings[key]);
});

test("HNSD: actual Replay action and UI both require DEV and Debug Mode", () => {
  const hook = parse("src/hooks/useMeetingAssistant.ts");
  const declaration = find(hook, (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && node.name.getText(hook) === "startRuntimeRegressionRun");
  assert.ok(declaration?.initializer && ts.isCallExpression(declaration.initializer));
  const callback = declaration.initializer.arguments[0];
  assert.ok(ts.isArrowFunction(callback) && ts.isBlock(callback.body));
  const gate = callback.body.statements.find(statement => ts.isIfStatement(statement) && statement.expression.getText(hook).includes("import.meta.env.DEV"));
  assert.ok(gate && ts.isIfStatement(gate));
  const page = parse("src/pages/app/components/meeting/index.tsx");
  const visible = find(page, (node): node is ts.ConditionalExpression => ts.isConditionalExpression(node) && node.condition.getText(page).includes("import.meta.env.DEV") && node.whenTrue.getText(page).includes("Replay Lab"));
  assert.ok(visible);
  for (const dev of [false, true]) for (const debug of [false, true]) {
    const env = { DEV: dev, debugMode: debug, debugModeRef: { current: debug } };
    const rejected = vm.runInNewContext(gate.expression.getText(hook).replaceAll("import.meta.env.DEV", "DEV"), env);
    const shown = vm.runInNewContext(visible.condition.getText(page).replaceAll("import.meta.env.DEV", "DEV"), env);
    assert.equal(rejected, !(dev && debug));
    assert.equal(shown, dev && debug);
  }
});
