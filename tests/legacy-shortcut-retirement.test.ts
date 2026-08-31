import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  removeRetiredDefaultShortcutBindings,
  RETIRED_DEFAULT_SHORTCUT_ACTION_IDS,
} from "../src/lib/storage/retired-shortcuts.js";

test("retired Cluely shortcuts are absent from defaults", () => {
  const shortcutsSource = readFileSync("src/config/shortcuts.ts", "utf8");
  const rustSource = readFileSync("src-tauri/src/shortcuts.rs", "utf8");
  for (const retiredId of RETIRED_DEFAULT_SHORTCUT_ACTION_IDS) {
    assert.equal(shortcutsSource.includes(`id: \"${retiredId}\"`), false);
    assert.equal(rustSource.includes(`\"${retiredId}\" =>`), false);
  }
  assert.match(shortcutsSource, /id: "meeting_regenerate_artifacts"/);
  assert.match(shortcutsSource, /macos: "cmd\+shift\+a"/);
});

test("stored known bindings are removed without deleting custom key choices", () => {
  const migrated = removeRetiredDefaultShortcutBindings({
    audio_recording: {
      action: "audio_recording",
      key: "cmd+shift+a",
      enabled: true,
    },
    custom_prepare: {
      action: "custom_prepare",
      key: "cmd+shift+a",
      enabled: true,
    },
  });

  assert.deepEqual(migrated, {
    custom_prepare: {
      action: "custom_prepare",
      key: "cmd+shift+a",
      enabled: true,
    },
  });
});
