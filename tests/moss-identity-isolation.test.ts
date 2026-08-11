import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("MOSS uses an isolated bundle identity and database", async () => {
  const [tauriConfig, databaseConfig, rustBootstrap] = await Promise.all([
    read("src-tauri/tauri.conf.json"),
    read("src/lib/database/config.ts"),
    read("src-tauri/src/lib.rs"),
  ]);

  assert.match(tauriConfig, /dev\.seasonsg\.moss/);
  assert.match(tauriConfig, /sqlite:moss\.db/);
  assert.match(databaseConfig, /sqlite:moss\.db/);
  assert.match(rustBootstrap, /sqlite:moss\.db/);

  for (const source of [tauriConfig, databaseConfig, rustBootstrap]) {
    assert.doesNotMatch(source, /sqlite:jarvis\.db/);
  }
});

test("MOSS migration history starts at version one without interview tables", async () => {
  const [migrationRegistry, baseline] = await Promise.all([
    read("src-tauri/src/db/main.rs"),
    read("src-tauri/src/db/migrations/moss-runtime-baseline.sql"),
  ]);

  assert.match(migrationRegistry, /version:\s*1/);
  assert.doesNotMatch(migrationRegistry, /version:\s*(?:[2-9]|\d{2,})/);
  assert.match(baseline, /call_runtime_sessions/);
  assert.match(baseline, /call_recording_close_attempts/);
  assert.doesNotMatch(baseline, /interview|preparation|jarvis/i);
});
