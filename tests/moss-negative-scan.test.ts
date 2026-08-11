import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const forbiddenProductionTerms = [
  "InterviewQuestionType",
  "behavioral",
  "general_system_design",
  "ai_ml_system_design",
  "project_deep_dive",
  "activeScreenTask",
  "activeInterviewTask",
  "activeMeetingTask",
  "codingArtifact",
  "complexityArtifact",
  "whiteboardArtifact",
  "InterviewProcess",
  "InterviewRound",
  "LeadershipPrinciple",
  "useMeetingAssistant",
];

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:ts|tsx|rs|sql)$/.test(entry.name) ? [target] : [];
  }));
  return nested.flat();
}

async function exists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

test("MOSS production source has no interview ontology or artifact aliases", async () => {
  const files = [
    ...(await sourceFiles("src")),
    ...(await sourceFiles("src-tauri/src")),
  ];
  const violations: string[] = [];
  await Promise.all(files.map(async (file) => {
    const content = await readFile(file, "utf8");
    for (const term of forbiddenProductionTerms) {
      if (content.includes(term)) violations.push(`${file}: ${term}`);
    }
  }));
  assert.deepEqual(violations, []);
});

test("MOSS removed obsolete routes, model assets, scripts, and dependencies", async () => {
  const removedPaths = [
    "src/config",
    "src/dev",
    "src/lib/meeting",
    "src/lib/database",
    "src/lib/storage",
    "src/types",
    "src-tauri/src/shortcuts.rs",
    "src-tauri/src/stt_evaluation.rs",
    "src-tauri/src/window.rs",
    "public/models",
    "public/transformers-wasm",
  ];
  assert.deepEqual(
    await Promise.all(removedPaths.map((target) => exists(target))),
    removedPaths.map(() => false)
  );

  const packageManifest = JSON.parse(await readFile("package.json", "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const dependencies = Object.keys(packageManifest.dependencies ?? {});
  for (const obsolete of [
    "@bany/curl-to-json",
    "@huggingface/transformers",
    "@tauri-apps/plugin-autostart",
    "@tauri-apps/plugin-opener",
    "@tauri-apps/plugin-process",
    "mermaid",
    "tauri-plugin-macos-permissions-api",
  ]) {
    assert.equal(dependencies.includes(obsolete), false, obsolete);
  }

  const cargoManifest = await readFile("src-tauri/Cargo.toml", "utf8");
  for (const obsolete of [
    "tauri-plugin-autostart",
    "tauri-plugin-machine-uid",
    "tauri-plugin-opener",
    "tauri-plugin-shell",
    "tauri-nspanel",
  ]) {
    assert.equal(cargoManifest.includes(obsolete), false, obsolete);
  }
});
