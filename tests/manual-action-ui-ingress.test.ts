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
const globalShortcutSource = await readFile(
  path.join(process.cwd(), "src/hooks/useGlobalShortcuts.ts"),
  "utf8"
);
const shortcutHookSource = await readFile(
  path.join(process.cwd(), "src/hooks/useShortcuts.ts"),
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
  assert.match(
    shortcutSection,
    /meeting\.regenerateSuggestion\([\s\S]*manualShortcutInvocation\(invocation\)/
  );
  assert.match(
    shortcutSection,
    /meeting\.applyResponseAction\([\s\S]*manualShortcutInvocation\(invocation\)/
  );
  assert.match(
    shortcutSection,
    /meeting\.applyResponseAction\(\s*"regenerate-artifacts",\s*manualShortcutInvocation\(invocation\)/
  );
  assert.match(
    meetingUiSource,
    /title="Regenerate artifacts"[\s\S]*aria-disabled=/
  );
  assert.doesNotMatch(
    shortcutSection,
    /isJarvisEditableElementFocused\(\)\) return/
  );
  assert.match(
    meetingUiSource,
    /preflightRejectionReason:[\s\S]*shortcut-debounced[\s\S]*editable-focus/
  );
  assert.match(
    globalShortcutSource,
    /if \(invocation\.disposition === "debounced"\) \{[\s\S]*callback\?\.\(invocation\);[\s\S]*return;/
  );
});

test("global shortcuts use one shared cleanup-safe listener subscription", () => {
  assert.equal(
    shortcutHookSource.match(/useGlobalShortcuts\(\)/g)?.length,
    1
  );
  assert.match(
    globalShortcutSource,
    /createSharedAsyncListenerLifecycle\(/
  );
  assert.match(
    globalShortcutSource,
    /return globalEventListenerLifecycle\.acquire\(\)/
  );
});
