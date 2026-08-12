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
  assert.doesNotMatch(shortcutPage, /Scheme \{SHORTCUT_SCHEME_VERSION\}|settings-revision/);
  assert.doesNotMatch(shortcutRuntime, /localStorage|moss\.shortcut-settings/);
  assert.match(shortcutPage, /shortcutDisplayParts/);
  assert.match(appShell, /shortcutSchemeVersion: SHORTCUT_SCHEME_VERSION/);
  assert.doesNotMatch(appShell, /shortcutConfigRevision/);
});

test("dropdowns use one rounded custom MOSS surface instead of native menus", () => {
  const caseStyles = source("src/pages/cases/cases.css");
  const reviewedState = source("src/pages/cases/ReviewedStatePanel.tsx");
  const modelPage = source("src/pages/models/index.tsx");
  const selectComponent = source("src/components/ui/MossSelect.tsx");
  const selectStyles = source("src/components/ui/moss-select.css");
  const packageManifest = JSON.parse(source("package.json"));
  const shortcutStyles = source("src/pages/shortcuts/shortcuts.css");
  const settingsStyles = source("src/pages/settings/settings.css");

  assert.match(packageManifest.dependencies["@radix-ui/react-select"], /^\^2\./);
  assert.match(selectComponent, /@radix-ui\/react-select/);
  assert.match(selectComponent, /ChevronDown/);
  assert.match(selectStyles, /\.moss-select-trigger\s*\{[^}]*height: 42px;[^}]*border-radius: 12px/s);
  assert.match(selectStyles, /width: var\(--radix-select-trigger-width\)/);
  assert.match(selectStyles, /\.moss-select-item\s*\{[^}]*min-height: 42px;[^}]*border-radius: 10px/s);
  assert.match(caseStyles, /\.case-section-toolbar \.moss-select-trigger \{[^}]*min-width: 210px;[^}]*border-radius: 12px;[^}]*background: var\(--surface-raised\);[^}]*color: var\(--text-primary\)/s);
  assert.match(caseStyles, /\.case-modal-layer \{[^}]*inset: 0\.5px;[^}]*border-radius: 15\.5px/s);
  assert.match(caseStyles, /\.case-modal input \{ height: 42px; padding: 0 13px;/);
  assert.match(caseStyles, /\.case-modal textarea \{[^}]*padding: 10px 13px/s);
  assert.match(reviewedState, /<label>Jurisdiction<textarea/);
  assert.doesNotMatch(modelPage, /<select/);
  assert.doesNotMatch(modelPage, /settings-revision|Revision \{controller\.settings\.revision\}/);
  assert.doesNotMatch(shortcutStyles, /\.shortcut-row\s*\{[^}]*border-bottom/s);
  assert.doesNotMatch(settingsStyles, /\.app-setting-row\s*\{[^}]*border-bottom/s);
});

test("neutral visual tokens replace the blue administration palette", () => {
  const globalStyles = source("src/global.css");
  const appStyles = source("src/pages/app/app.css");
  const audioStyles = source("src/pages/audio/audio.css");
  const shortcutStyles = source("src/pages/shortcuts/shortcuts.css");

  assert.match(globalStyles, /--surface-page: #ffffff/);
  assert.match(globalStyles, /--accent-strong: #18181b/);
  assert.match(globalStyles, /--border-window: rgb\(63 63 70 \/ 10%\)/);
  assert.doesNotMatch(
    `${globalStyles}\n${appStyles}`,
    /#1769aa|#0f568e|#eaf3fc/i
  );
  assert.match(appStyles, /\.nav-item-active\s*{[^}]*var\(--accent-soft\)/s);
  assert.match(audioStyles, /\.profile-option-active\s*{[^}]*var\(--accent-strong\)/s);
  assert.match(shortcutStyles, /\.shortcut-keycaps kbd/);
});

test("shared typography keeps dense product surfaces readable", () => {
  const globalStyles = source("src/global.css");
  const caseStyles = source("src/pages/cases/cases.css");
  const allPageStyles = [
    "app",
    "audio",
    "calling",
    "cases",
    "models",
    "sessions",
    "settings",
    "shortcuts",
  ].map((page) => source(`src/pages/${page}/${page}.css`)).join("\n");

  assert.match(globalStyles, /--font-micro: 10px/);
  assert.match(globalStyles, /--font-body: 14px/);
  assert.match(caseStyles, /font-size: var\(--font-ui\)/);
  assert.doesNotMatch(allPageStyles, /font-size:\s*[789]px/);
});
