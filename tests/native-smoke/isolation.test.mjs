import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { root, createBuildConfig } from "./build.mjs";

const read = file => fs.readFileSync(`${root}/${file}`, "utf8");

test("ordinary frontend and default test scripts do not activate native smoke", () => {
  for (const file of ["src/main.tsx", "vite.config.ts", "src-tauri/tauri.conf.json"]) {
    assert.doesNotMatch(read(file), /native-smoke|native-app-smoke/);
  }
  const scripts = JSON.parse(read("package.json")).scripts;
  for (const key of ["dev", "build", "test", "verify:next-major"]) {
    assert.doesNotMatch(scripts[key], /native-smoke\/(?:build|launch)/);
  }
});

test("native observer is opt-in and release cannot include it", () => {
  const source = read("src-tauri/src/app_shutdown.rs");
  assert.match(source, /cfg\(all\(feature = "native-app-smoke", not\(debug_assertions\)\)\)/);
  assert.match(source, /compile_error!/);
  assert.match(source, /cfg\(all\(feature = "native-app-smoke", debug_assertions, target_os = "macos"\)\)/);
  const observer = read("src-tauri/src/native_app_smoke.rs");
  assert.doesNotMatch(observer, /#\[tauri::command\]|invoke_handler|spawn|sleep|TaskRuntime|useMeeting/);
  assert.match(read("src-tauri/build.rs"), /Native and frontend smoke build identities differ/);
});

test("observer adds no IPC capability and never modifies production capability files", () => {
  const config = createBuildConfig({app:{windows:[]}},"/tmp/frontend","build");
  assert.equal(config.app.security,undefined);
  assert.doesNotMatch(read("src-tauri/capabilities/default.json"),/native-smoke/);
  assert.doesNotMatch(read("tests/native-smoke/status.js"),/@tauri-apps|fetch\(|invoke\(/);
});
