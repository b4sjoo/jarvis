import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

function statusView(native) {
  const elements = {
    "identity-error": { textContent: "" },
    status: { children: [], replaceChildren(...children) { this.children = children; } },
  };
  const listeners = new Map();
  vm.runInNewContext(fs.readFileSync(new URL("./status.js", import.meta.url), "utf8"), {
    __NATIVE_SMOKE_BUILD_ID__: "current", __JARVIS_APP_VERSION__: "test",
    __JARVIS_GIT_COMMIT__: "commit", __JARVIS_GIT_DIRTY__: true, __JARVIS_BUILD_TIMESTAMP__: "now",
    document: { getElementById: id => elements[id], createElement: () => ({textContent:""}) },
    window: { __NATIVE_SMOKE_SNAPSHOT__: native, addEventListener: (name, fn) => listeners.set(name, fn) },
  });
  return { elements, listeners };
}

test("status rendering is read-only, bounded per AX node and has no provider or timer dependency", () => {
  const native = { buildId: "current", windows: [{label:"main",visible:true}], pid:123 };
  const original = structuredClone(native);
  const { elements, listeners } = statusView(native);
  assert.deepEqual(native, original);
  assert.equal(elements["identity-error"].textContent, "");
  const lines = elements.status.children.map(node => node.textContent);
  assert.ok(lines.every(line => line.length < 512));
  assert.equal(JSON.parse(lines.join("\n")).native.pid,123);
  assert.deepEqual([...listeners.keys()],["native-smoke-snapshot"]);
});

test("a mismatched refresh visibly fails without changing the source snapshot", () => {
  const { elements, listeners } = statusView({buildId:"current"});
  const late = {buildId:"old", windows:[]};
  listeners.get("native-smoke-snapshot")({detail:late});
  assert.equal(elements["identity-error"].textContent,"BUILD ID MISMATCH");
  assert.deepEqual(late,{buildId:"old",windows:[]});
});
