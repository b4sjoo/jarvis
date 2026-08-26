#!/usr/bin/env node

import { appendFile, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SCHEMA_VERSION = 1;
const DEFAULT_SESSION_ROOT = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "dev.seasonsg.jarvis",
  "meeting-session-recordings"
);

export function parseSessionEvaluationProvenanceArgs(argv) {
  let session;
  let scriptedValidation;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--session") {
      session = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--scripted") {
      if (scriptedValidation === false) {
        throw new Error("Choose exactly one of --scripted or --organic.");
      }
      scriptedValidation = true;
      continue;
    }
    if (value === "--organic") {
      if (scriptedValidation === true) {
        throw new Error("Choose exactly one of --scripted or --organic.");
      }
      scriptedValidation = false;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  if (!session) throw new Error("Provide --session <session-folder>.");
  if (scriptedValidation === undefined) {
    throw new Error("Choose exactly one of --scripted or --organic.");
  }
  return { session, scriptedValidation };
}

export async function resolveSessionEvaluationDirectory(input, root = process.env.JARVIS_SESSION_RECORDINGS_DIR || DEFAULT_SESSION_ROOT) {
  if (path.isAbsolute(input)) return realpath(input);
  if (!input || input === "." || input === ".." || input.includes("/") || input.includes("\\")) {
    throw new Error("Session must be a folder name or an absolute path.");
  }
  const rootPath = await realpath(root);
  const sessionPath = await realpath(path.join(rootPath, input));
  if (!sessionPath.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error("Session resolves outside the recording root.");
  }
  return sessionPath;
}

export async function setSessionEvaluationProvenance(input) {
  const manifestPath = path.join(input.sessionDirectory, "manifest.json");
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const forcedScriptedValidation =
    manifest.scriptedValidationForced === true;
  if (forcedScriptedValidation && input.scriptedValidation === false) {
    throw new Error(
      "This recording is permanently scripted by Scenario Runner and cannot be marked organic."
    );
  }
  const sessionRecordingId = readNonEmptyString(manifest.sessionId) || path.basename(input.sessionDirectory);
  const evaluationDirectory = path.join(input.sessionDirectory, "evaluation");
  const recordPath = path.join(evaluationDirectory, "session-provenance.json");
  const historyPath = path.join(evaluationDirectory, "session-provenance-history.jsonl");
  const previous = await readOptionalJson(recordPath);
  if (
    previous?.sessionRecordingId === sessionRecordingId &&
    previous?.effectiveScriptedValidation === input.scriptedValidation
  ) {
    return {
      changed: false,
      sessionRecordingId,
      scriptedValidation: input.scriptedValidation,
      manifestUnchanged: true,
    };
  }

  const updatedAt = input.now ?? Date.now();
  const record = {
    schemaVersion: SCHEMA_VERSION,
    sessionRecordingId,
    effectiveScriptedValidation: input.scriptedValidation,
    ...(forcedScriptedValidation ? { forced: true } : {}),
    ...(readNonEmptyString(manifest.scenarioRunId)
      ? { scenarioRunId: readNonEmptyString(manifest.scenarioRunId) }
      : {}),
    updatedAt,
    source: "reflection-cli",
  };
  const history = {
    ...record,
    action: input.scriptedValidation ? "mark-scripted" : "mark-organic",
  };
  await mkdir(evaluationDirectory, { recursive: true });
  await atomicWriteJson(recordPath, record);
  await appendFile(historyPath, `${JSON.stringify(history)}\n`, "utf8");
  const manifestAfter = await readFile(manifestPath);
  return {
    changed: true,
    sessionRecordingId,
    scriptedValidation: input.scriptedValidation,
    manifestUnchanged: manifestBytes.equals(manifestAfter),
  };
}

async function atomicWriteJson(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function readNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function main() {
  const args = parseSessionEvaluationProvenanceArgs(process.argv.slice(2));
  const sessionDirectory = await resolveSessionEvaluationDirectory(args.session);
  const result = await setSessionEvaluationProvenance({
    sessionDirectory,
    scriptedValidation: args.scriptedValidation,
  });
  process.stdout.write(
    `${result.changed ? "Updated" : "Unchanged"} ${path.basename(sessionDirectory)}: scriptedValidation=${result.scriptedValidation}.\n`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
