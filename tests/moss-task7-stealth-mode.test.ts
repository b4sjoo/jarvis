import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  DEFAULT_APPLICATION_SETTINGS,
  normalizeApplicationSettings,
} from "../src/lib/calling/application-settings.js";

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

test("application settings default to the existing stealth baseline", () => {
  assert.deepEqual(DEFAULT_APPLICATION_SETTINGS, {
    revision: 1,
    stealthMode: true,
  });
  assert.deepEqual(normalizeApplicationSettings(undefined), {
    revision: 1,
    stealthMode: true,
  });
});

test("application settings preserve an explicit visible Dock choice", () => {
  assert.deepEqual(
    normalizeApplicationSettings({ revision: 4.4, stealthMode: false }),
    { revision: 4, stealthMode: false }
  );
});

test("stealth mode owns Dock visibility without changing content protection", () => {
  const appShell = source("src/pages/app/index.tsx");
  const nativeShell = source("src-tauri/src/lib.rs");
  const tauriConfig = JSON.parse(source("src-tauri/tauri.conf.json"));

  assert.match(appShell, /applyNativeStealthMode/);
  assert.match(appShell, /set-stealth-mode/);
  assert.match(nativeShell, /fn set_stealth_mode/);
  assert.match(nativeShell, /ActivationPolicy::Accessory/);
  assert.match(nativeShell, /ActivationPolicy::Regular/);
  assert.equal(tauriConfig.app.windows[0].contentProtected, true);
});
