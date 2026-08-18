import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const MEETING_ROOT = join(process.cwd(), "src/lib/meeting");

test("Meeting runtime consumers cannot use the legacy string response adapter", () => {
  const files = collectTypeScriptFiles(MEETING_ROOT);
  files.push(join(process.cwd(), "src/hooks/useMeetingAssistant.ts"));

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /\bfetchAIResponse\s*\(/u,
      `${file} must consume typed AI response events`
    );
  }
});

test("Runtime inference request adapters cannot classify provider errors from text", () => {
  const requestFiles = collectTypeScriptFiles(MEETING_ROOT).filter((file) =>
    file.endsWith("-request.ts")
  );
  for (const file of requestFiles) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /classifyTaxonomyAdjudicationProviderOutput/u,
      `${file} must use typed terminal outcomes`
    );
  }
});

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}
