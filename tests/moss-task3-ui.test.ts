import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  FIXED_SHORTCUT_DEFINITIONS,
  SHORTCUT_SCHEME_VERSION,
  shortcutDisplayParts,
  validateFixedShortcutDefinitions,
} from "../src/lib/calling/shortcut-settings.js";

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

test("fixed global shortcuts are complete, platform friendly, and collision free", () => {
  assert.equal(SHORTCUT_SCHEME_VERSION, 1);
  assert.doesNotThrow(() => validateFixedShortcutDefinitions());
  assert.deepEqual(
    FIXED_SHORTCUT_DEFINITIONS.map(({ action, accelerator }) => ({
      action,
      accelerator,
    })),
    [
      { action: "toggle-visibility", accelerator: "CommandOrControl+Shift+M" },
      { action: "toggle-interface", accelerator: "CommandOrControl+Shift+L" },
      { action: "toggle-listening", accelerator: "CommandOrControl+Shift+P" },
      { action: "request-guidance", accelerator: "CommandOrControl+Shift+A" },
      { action: "end-call", accelerator: "CommandOrControl+Shift+E" },
    ]
  );
  assert.deepEqual(shortcutDisplayParts("toggle-visibility", "macos"), [
    "⌘",
    "⇧",
    "M",
  ]);
  assert.deepEqual(shortcutDisplayParts("toggle-visibility", "other"), [
    "Ctrl",
    "Shift",
    "M",
  ]);

  const collision = FIXED_SHORTCUT_DEFINITIONS.map((definition) => ({
    ...definition,
  }));
  collision[4].accelerator = collision[3].accelerator;
  assert.throws(
    () => validateFixedShortcutDefinitions(collision),
    /conflicts with Request guidance/
  );
});

test("shortcut UI is read-only and records a fixed scheme version", () => {
  const shortcutPage = source("src/pages/shortcuts/index.tsx");
  const shortcutRuntime = source("src/lib/calling/shortcut-settings.ts");
  const appShell = source("src/pages/app/index.tsx");
  assert.doesNotMatch(shortcutPage, /<input|onSave|Use defaults|Save shortcuts/);
  assert.doesNotMatch(shortcutPage, /CommandOrControl/);
  assert.doesNotMatch(shortcutRuntime, /localStorage|moss\.shortcut-settings/);
  assert.match(shortcutPage, /shortcutDisplayParts/);
  assert.match(appShell, /shortcutSchemeVersion: SHORTCUT_SCHEME_VERSION/);
  assert.doesNotMatch(appShell, /shortcutConfigRevision/);
});

test("neutral visual tokens replace the blue administration palette", () => {
  const globalStyles = source("src/global.css");
  const appStyles = source("src/pages/app/app.css");
  const audioStyles = source("src/pages/audio/audio.css");
  const shortcutStyles = source("src/pages/shortcuts/shortcuts.css");

  assert.match(globalStyles, /--surface-page: #ffffff/);
  assert.match(globalStyles, /--accent-strong: #18181b/);
  assert.doesNotMatch(
    `${globalStyles}\n${appStyles}`,
    /#1769aa|#0f568e|#eaf3fc/i
  );
  assert.match(appStyles, /\.nav-item-active\s*{[^}]*var\(--accent-soft\)/s);
  assert.match(audioStyles, /\.profile-option-active\s*{[^}]*var\(--accent-strong\)/s);
  assert.match(shortcutStyles, /\.shortcut-keycaps kbd/);
});
