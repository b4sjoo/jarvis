import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("MOSS uses an isolated bundle identity and database", async () => {
  const [tauriConfig, packageManifest, rustBootstrap] = await Promise.all([
    read("src-tauri/tauri.conf.json"),
    read("package.json"),
    read("src-tauri/src/lib.rs"),
  ]);

  assert.match(tauriConfig, /dev\.seasonsg\.moss/);
  assert.match(tauriConfig, /sqlite:moss\.db/);
  assert.match(packageManifest, /"name":\s*"moss"/);
  assert.match(rustBootstrap, /sqlite:moss\.db/);

  for (const source of [tauriConfig, packageManifest, rustBootstrap]) {
    assert.doesNotMatch(source, /sqlite:jarvis\.db/);
  }
});

test("MOSS migration history adds an isolated Case domain without interview tables", async () => {
  const [migrationRegistry, baseline, preparation] = await Promise.all([
    read("src-tauri/src/db/main.rs"),
    read("src-tauri/src/db/migrations/moss-runtime-baseline.sql"),
    read("src-tauri/src/db/migrations/moss-case-preparation.sql"),
  ]);

  assert.match(migrationRegistry, /version:\s*1/);
  assert.match(migrationRegistry, /version:\s*2/);
  assert.match(baseline, /call_runtime_sessions/);
  assert.match(baseline, /call_recording_close_attempts/);
  assert.doesNotMatch(baseline, /interview|preparation|jarvis/i);
  assert.match(preparation, /CREATE TABLE IF NOT EXISTS cases/);
  assert.match(preparation, /call_session_preparation_bindings/);
  assert.doesNotMatch(preparation, /InterviewProcess|InterviewRound|jarvis/i);
});
