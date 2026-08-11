import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  DEFAULT_VAD_CONFIG,
  applyAudioProfile,
  normalizeAudioSettings,
} from "../src/lib/calling/audio-settings.js";
import { MOSS_WINDOW_PROFILES } from "../src/lib/calling/interface-mode.js";
import {
  DEFAULT_SHORTCUT_SETTINGS,
  normalizeShortcutSettings,
  validateShortcutSettings,
} from "../src/lib/calling/shortcut-settings.js";

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

test("control and companion profiles keep distinct window responsibilities", () => {
  assert.equal(MOSS_WINDOW_PROFILES.control.alwaysOnTop, false);
  assert.equal(MOSS_WINDOW_PROFILES.companion.alwaysOnTop, true);
  assert.ok(
    MOSS_WINDOW_PROFILES.control.width > MOSS_WINDOW_PROFILES.companion.width
  );
  assert.ok(
    MOSS_WINDOW_PROFILES.control.height > MOSS_WINDOW_PROFILES.companion.height
  );
});

test("interface modes share one Calling Assistant owner", () => {
  const appShell = source("src/pages/app/index.tsx");
  const callingView = source("src/pages/calling/index.tsx");
  assert.equal((appShell.match(/useCallingAssistant\(\)/g) ?? []).length, 1);
  assert.doesNotMatch(callingView, /useCallingAssistant\(\)/);
  assert.match(callingView, /controller: CallingAssistantController/);
});

test("audio profiles map to bounded native VAD values", () => {
  const sensitive = applyAudioProfile(DEFAULT_VAD_CONFIG, "sensitive");
  assert.equal(sensitive.sensitivity_rms, 0.008);
  assert.equal(sensitive.noise_gate_threshold, 0.002);
  assert.equal(sensitive.silence_duration_ms, 813);

  const bounded = normalizeAudioSettings({
    revision: -4,
    profile: "custom",
    vadConfig: {
      ...DEFAULT_VAD_CONFIG,
      sensitivity_rms: 2,
      silence_duration_ms: 40,
      minimum_speech_duration_ms: 9_000,
    },
  });
  assert.equal(bounded.revision, 1);
  assert.equal(bounded.vadConfig.sensitivity_rms, 1);
  assert.equal(bounded.vadConfig.silence_duration_ms, 100);
  assert.equal(bounded.vadConfig.minimum_speech_duration_ms, 5_000);
});

test("global shortcut settings reject collisions before native registration", () => {
  const defaults = normalizeShortcutSettings(DEFAULT_SHORTCUT_SETTINGS);
  assert.doesNotThrow(() => validateShortcutSettings(defaults));

  const collision = structuredClone(defaults);
  collision.bindings["end-call"] = collision.bindings["request-guidance"];
  assert.throws(
    () => validateShortcutSettings(collision),
    /conflicts with Request guidance/
  );
});

test("model routes and shortcuts live outside the companion surface", () => {
  const callingView = source("src/pages/calling/index.tsx");
  const appShell = source("src/pages/app/index.tsx");
  assert.doesNotMatch(callingView, /ProviderSettings|Open model settings/);
  assert.match(appShell, /ModelSettingsPage/);
  assert.match(appShell, /ShortcutSettingsPage/);
  assert.match(appShell, /recordShortcutAction/);
});

test("session history exposes recording evidence without adding a new evaluation ontology", () => {
  const sessionsView = source("src/pages/sessions/index.tsx");
  assert.match(sessionsView, /humanEvaluationCount/);
  assert.match(sessionsView, /exportCallRecording/);
  assert.match(sessionsView, /revealCallRecording/);
  assert.match(sessionsView, /retryRecoveredRecording/);
  assert.doesNotMatch(sessionsView, /question type|artifact intent|parent action/i);
});
