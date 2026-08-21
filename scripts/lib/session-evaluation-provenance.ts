import { readFile } from "node:fs/promises";
import path from "node:path";

export interface EffectiveSessionEvaluationProvenance {
  scriptedValidation: boolean;
  source: "override" | "manifest-marker" | "legacy-manifest" | "default";
}

export async function readEffectiveSessionEvaluationProvenance(
  sessionDirectory: string
): Promise<EffectiveSessionEvaluationProvenance> {
  const override = await readOptionalJson(
    path.join(sessionDirectory, "evaluation", "session-provenance.json")
  );
  if (typeof override?.effectiveScriptedValidation === "boolean") {
    return {
      scriptedValidation: override.effectiveScriptedValidation,
      source: "override",
    };
  }

  const manifest = await readOptionalJson(
    path.join(sessionDirectory, "manifest.json")
  );
  if (manifest?.scriptedValidation === true) {
    return { scriptedValidation: true, source: "manifest-marker" };
  }
  if (manifest?.evaluationProvenance === "scripted-validation") {
    return { scriptedValidation: true, source: "legacy-manifest" };
  }
  return { scriptedValidation: false, source: "default" };
}

async function readOptionalJson(filePath: string) {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return isRecord(value) ? value : undefined;
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

function isMissingFileError(error: unknown) {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
