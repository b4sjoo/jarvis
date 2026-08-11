import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  listCallRecordings,
  listRecoverableCallRecordings,
} from "../src/lib/calling/call-recording.js";
import {
  isTauriRuntime,
  requireTauriRuntime,
} from "../src/lib/calling/runtime-environment.js";

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

const capabilityPermissions = (path: string) => {
  const capability = JSON.parse(source(path)) as {
    permissions: Array<string | { identifier: string }>;
  };
  return new Set(
    capability.permissions.map((permission) =>
      typeof permission === "string" ? permission : permission.identifier
    )
  );
};

test("desktop capabilities authorize every window and shortcut command used by the shell", () => {
  const required = [
    "global-shortcut:allow-register",
    "global-shortcut:allow-unregister",
    "global-shortcut:allow-is-registered",
    "core:window:allow-set-min-size",
    "core:window:allow-set-size",
    "core:window:allow-set-always-on-top",
    "core:window:allow-center",
    "core:window:allow-hide",
    "core:window:allow-show",
    "core:window:allow-set-focus",
  ];

  for (const path of [
    "src-tauri/capabilities/default.json",
    "src-tauri/capabilities/cross-platform.json",
  ]) {
    const permissions = capabilityPermissions(path);
    for (const permission of required) {
      assert.ok(permissions.has(permission), `${path} is missing ${permission}`);
    }
    assert.ok(!permissions.has("global-shortcut:default"));
  }
});

test("browser preview avoids native recording transport and exposes a bounded desktop boundary", async () => {
  assert.equal(isTauriRuntime(), false);
  assert.deepEqual(await listCallRecordings(), []);
  assert.deepEqual(await listRecoverableCallRecordings(), []);
  assert.throws(
    () => requireTauriRuntime("Call recording"),
    /available only in the MOSS desktop app/
  );

  const hook = source("src/hooks/useCallingAssistant.ts");
  const callPage = source("src/pages/calling/index.tsx");
  assert.match(hook, /if \(!nativeRuntimeAvailable\) return;/);
  assert.match(hook, /Start calls from the MOSS desktop app/);
  assert.match(callPage, /Browser preview is active/);
  assert.match(callPage, /disabled=\{!controller\.nativeRuntimeAvailable\}/);
});

test("companion commits after native window profile application and settings has one quit surface", () => {
  const appShell = source("src/pages/app/index.tsx");
  const callingPage = source("src/pages/calling/index.tsx");
  const appSettings = source("src/pages/settings/index.tsx");

  assert.match(
    appShell,
    /await appWindow\.center\(\);\s+interfaceModeRef\.current = mode;\s+setInterfaceMode\(mode\);/
  );
  assert.doesNotMatch(appShell, /setInterfaceMode\(previousMode\)/);
  assert.doesNotMatch(appSettings, /Quit MOSS|onQuit|danger-button/);
  assert.match(appShell, /className="nav-item quit-item"/);
  assert.doesNotMatch(
    appShell,
    /<header className="workspace-header" data-tauri-drag-region>/
  );
  assert.doesNotMatch(
    callingPage,
    /<header className="moss-topbar" data-tauri-drag-region>/
  );
  assert.match(appShell, /<div data-tauri-drag-region>/);
  assert.match(callingPage, /className="moss-brand" data-tauri-drag-region/);
});
