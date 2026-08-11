import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { MOSS_WINDOW_PROFILES } from "../src/lib/calling/interface-mode.js";

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
