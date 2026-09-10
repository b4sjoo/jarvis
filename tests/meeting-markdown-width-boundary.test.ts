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
const globalStyles = await readFile(
  path.join(process.cwd(), "src/global.css"),
  "utf8"
);
const sharedMarkdownSource = await readFile(
  path.join(process.cwd(), "src/pages/app/components/meeting/meeting-markdown-text.tsx"), "utf8"
);
const nativeFocusSource = await readFile(
  path.join(process.cwd(), "src/pages/app/components/meeting/focus-window.tsx"), "utf8"
);
const recordedScreenOutput = await readFile(
  path.join(
    process.cwd(),
    "tests/fixtures/task-192-screen-output.md"
  ),
  "utf8"
);

test("scopes generated markdown width containment to Meeting Assistant", () => {
  assert.match(
    sharedMarkdownSource,
    /meeting-assistant-markdown min-w-0 w-full max-w-full overflow-x-hidden/
  );
  for (const consumer of [meetingUiSource, nativeFocusSource]) {
    assert.match(consumer, /import \{ MeetingMarkdownText \} from "\.\/meeting-markdown-text"/);
    assert.match(consumer, /<MeetingMarkdownText/);
  }
  assert.match(
    globalStyles,
    /\.meeting-assistant-markdown \[data-streamdown="table-wrapper"\] > div:last-child \{[\s\S]*?overflow-x: auto;/
  );
  assert.match(
    globalStyles,
    /\.meeting-assistant-markdown \[data-streamdown="table"\] \{[\s\S]*?max-width: none !important;/
  );
  assert.match(
    globalStyles,
    /\.meeting-assistant-markdown \[data-streamdown="mermaid-block"\] svg \{[\s\S]*?max-width: 100%;/
  );
  assert.match(
    globalStyles,
    /\.meeting-assistant-markdown \{\s*overflow-wrap: anywhere;/
  );
});

test("contains the Meeting ScrollArea intrinsic-width wrapper", () => {
  assert.match(
    meetingUiSource,
    /meeting-assistant-main-scroll min-h-0 min-w-0 max-w-full flex-1 overflow-hidden/
  );
  assert.match(
    globalStyles,
    /\.meeting-assistant-main-scroll > \[data-slot="scroll-area-viewport"\] > div \{[\s\S]*?display: block !important;/
  );
  assert.match(
    globalStyles,
    /\.meeting-assistant-main-scroll,[\s\S]*?min-width: 0 !important;[\s\S]*?width: 100% !important;[\s\S]*?max-width: 100% !important;/
  );
});

test("keeps the recorded Screen response as the width regression fixture", () => {
  assert.ok(recordedScreenOutput.length >= 4_000);
  assert.match(recordedScreenOutput, /multi-region failover/);
  assert.match(recordedScreenOutput, /\$\$62\^7/);
  assert.match(recordedScreenOutput, /Clarifying options:/);
  assert.match(recordedScreenOutput, /Cross-Region Async Replication/);
});
