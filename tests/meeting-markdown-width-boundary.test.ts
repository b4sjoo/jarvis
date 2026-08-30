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

test("scopes generated markdown width containment to Meeting Assistant", () => {
  assert.match(
    meetingUiSource,
    /meeting-assistant-markdown min-w-0 w-full max-w-full overflow-x-hidden/
  );
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
