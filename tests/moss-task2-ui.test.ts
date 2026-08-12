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

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

test("control and companion profiles keep distinct window responsibilities", () => {
  const tauriConfig = JSON.parse(source("src-tauri/tauri.conf.json"));
  const appStyles = source("src/pages/app/app.css");
  assert.equal(MOSS_WINDOW_PROFILES.control.alwaysOnTop, false);
  assert.equal(MOSS_WINDOW_PROFILES.companion.alwaysOnTop, true);
  assert.equal(tauriConfig.app.windows[0].alwaysOnTop, false);
  assert.equal(tauriConfig.app.windows[0].transparent, true);
  assert.equal(tauriConfig.app.windows[0].shadow, true);
  assert.match(appStyles, /\.app-shell\s*\{[^}]*border-radius: 16px/s);
  assert.match(appStyles, /\.app-shell\s*\{[^}]*border: 0\.5px solid var\(--border-window\)/s);
  assert.match(appStyles, /\.companion-shell\s*\{[^}]*border-radius: 16px/s);
  assert.match(appStyles, /\.companion-shell\s*\{[^}]*border: 0\.5px solid var\(--border-window\)/s);
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

test("audio settings keep advanced speech controls visible without internal revisions", () => {
  const audioPage = source("src/pages/audio/index.tsx");
  const audioStyles = source("src/pages/audio/audio.css");
  assert.match(audioPage, /<div className="advanced-audio">/);
  assert.doesNotMatch(audioPage, /<details|<summary|revision-badge|Audio revision/);
  assert.match(
    audioStyles,
    /\.settings-section-heading\s*\{[^}]*border-bottom: 1px solid var\(--border-subtle\)/s
  );
  assert.doesNotMatch(audioStyles, /\.settings-section\s*\{[^}]*border-bottom/s);
  assert.doesNotMatch(audioStyles, /\.advanced-audio\s*\{[^}]*border-top/s);
});

test("model routes and shortcuts live outside the companion surface", () => {
  const callingView = source("src/pages/calling/index.tsx");
  const appShell = source("src/pages/app/index.tsx");
  assert.doesNotMatch(callingView, /ProviderSettings|Open model settings/);
  assert.match(appShell, /ModelSettingsPage/);
  assert.match(appShell, /ShortcutReferencePage/);
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

test("application settings expose privacy and desktop stealth without duplicate actions", () => {
  const appShell = source("src/pages/app/index.tsx");
  const appSettings = source("src/pages/settings/index.tsx");
  const callingStyles = source("src/pages/calling/calling.css");
  assert.match(appShell, /recordInterfaceAction/);
  assert.match(appShell, /setWindowError\(detail\)/);
  assert.match(appSettings, /Stealth Mode/);
  assert.match(appSettings, /raw audio/i);
  assert.doesNotMatch(
    appSettings,
    /Call recordings|Window mode|Dock-hidden operation|Open folder|Hide MOSS/
  );
  assert.doesNotMatch(callingStyles, /moss-settings-backdrop|route-grid/);
});
