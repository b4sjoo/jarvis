import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

function renderPage(file: string, settings: Record<string, unknown>) {
  const seen: Array<{ component: string; props: any }> = [];
  const component = (name: string) => (props: any) => {
    seen.push({ component: name, props });
    return React.createElement("div", { "data-component": name }, props.children);
  };
  const imports: Record<string, any> = {
    "react/jsx-runtime": jsx,
    "./components": Object.fromEntries(["AudioSelection", "STTProviders", "AIProviders", "DecisionsProvider", "MemoryBase"].map(name => [name, component(name)])),
    "@/hooks": { useSettings: () => settings },
    "@/layouts": { PageLayout: component("PageLayout") },
    "@/lib": { getPlatform: () => "macos" },
  };
  const exports: any = {};
  const context = vm.createContext({ exports, require: (id: string) => {
    assert.ok(Object.hasOwn(imports, id), `Unexpected page dependency: ${id}`);
    return imports[id];
  } });
  vm.runInContext(ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, context);
  renderToStaticMarkup(React.createElement(exports.default));
  return seen;
}

test("AU203: Audio owns the existing STT editor and passes the unchanged shared configuration/setter", () => {
  const selectedSttProvider = { provider: "azure-mai-transcribe", variables: { endpoint: "fixture.cognitiveservices.azure.com", api_key: "synthetic" } };
  const onSetSelectedSttProvider = () => { throw new Error("render must not modify settings"); };
  const settings = { selectedSttProvider, onSetSelectedSttProvider, allSttProviders: [], sttVariables: [] };
  const seen = renderPage("src/pages/audio/index.tsx", settings);
  assert.equal(seen.find(x => x.component === "PageLayout")?.props.title, "Audio Settings");
  assert.equal(seen.filter(x => x.component === "AudioSelection").length, 1);
  const editors = seen.filter(x => x.component === "STTProviders");
  assert.equal(editors.length, 1);
  assert.equal(editors[0].props.selectedSttProvider, selectedSttProvider);
  assert.equal(editors[0].props.onSetSelectedSttProvider, onSetSelectedSttProvider);
  assert.equal(seen.some(x => x.component === "AIProviders"), false);
});

test("AU203: Dev Space retains AI/memory and no longer mounts or exports a second STT editor", () => {
  const seen = renderPage("src/pages/dev/index.tsx", {});
  assert.equal(seen.filter(x => x.component === "STTProviders").length, 0);
  assert.equal(seen.filter(x => x.component === "AIProviders").length, 1);
  assert.equal(seen.filter(x => x.component === "MemoryBase").length, 1);
  assert.doesNotMatch(readFileSync("src/pages/dev/components/index.ts", "utf8"), /stt-configs/);
  for (const name of ["index.tsx", "Providers.tsx", "CustomProvider.tsx", "CreateEditProvider.tsx"]) {
    assert.equal(existsSync(`src/pages/dev/components/stt-configs/${name}`), false);
    assert.equal(existsSync(`src/pages/audio/components/stt-configs/${name}`), true);
  }
});
