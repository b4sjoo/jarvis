import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const meetingUiSource = await readFile(
  path.join(
    process.cwd(),
    "src/pages/app/components/meeting/index.tsx"
  ),
  "utf8"
);
const focusUiSource = await readFile(
  path.join(
    process.cwd(),
    "src/pages/app/components/meeting/focus-window.tsx"
  ),
  "utf8"
);

test("tracked manual controls remain observable while visually unavailable", () => {
  assert.doesNotMatch(
    meetingUiSource,
    /\sdisabled=\{!forceAdviseAvailable\}/
  );
  assert.doesNotMatch(
    focusUiSource,
    /\sdisabled=\{!snapshot\.forceAdviseAvailable\}/
  );
  assert.match(
    meetingUiSource,
    /aria-disabled=\{!forceAdviseAvailable\}/
  );
  assert.match(
    focusUiSource,
    /aria-disabled=\{!snapshot\.forceAdviseAvailable\}/
  );
  assert.match(
    meetingUiSource,
    /aria-disabled=\{isBusy \|\| !hasMeetingContext\}/
  );
});

test("manual-action shortcuts dispatch before semantic availability checks", () => {
  const shortcutSection = meetingUiSource.slice(
    meetingUiSource.indexOf("const handleRegenerateShortcut"),
    meetingUiSource.indexOf("const meetingShortcutCallbacks")
  );
  assert.doesNotMatch(shortcutSection, /isBusy \|\|/);
  assert.doesNotMatch(shortcutSection, /!hasSuggestion/);
  assert.doesNotMatch(shortcutSection, /!hasActiveMeetingTask/);
  assert.match(shortcutSection, /meeting\.regenerateSuggestion\(\)/);
  assert.match(shortcutSection, /meeting\.applyResponseAction\(action\)/);
  assert.match(
    shortcutSection,
    /meeting\.applyResponseAction\("regenerate-artifacts"\)/
  );
  assert.match(
    meetingUiSource,
    /title="Regenerate artifacts"[\s\S]*aria-disabled=/
  );
});
