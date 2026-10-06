import { invoke } from "@tauri-apps/api/core";
import { dirname, resolve } from "@tauri-apps/api/path";
import type { ScreenCaptureTarget } from "./types.js";
import type { CaptureScreenContextResponse } from "./screen-observation.service.js";
import type { SessionProcedureFileRef } from "./session-procedure.js";
import { readRuntimeRegressionScenario, readRuntimeRegressionScenarioManifest, type RuntimeRegressionScenario } from "./runtime-regression-scenario.js";

export interface RuntimeRegressionFilePayload {
  absolutePath: string;
  sha256: string;
  text?: string | null;
  base64?: string | null;
  mediaType?: string | null;
}
export interface RuntimeRegressionFileReader {
  dirname(path: string): Promise<string>;
  resolve(...paths: string[]): Promise<string>;
  read(input: { assetRoot: string; path: string; allowAbsolute: boolean; expectedSha256?: string; image: boolean }): Promise<RuntimeRegressionFilePayload>;
}
const NATIVE_READER: RuntimeRegressionFileReader = {
  dirname, resolve,
  read: input => invoke("read_runtime_regression_file", input),
};

export interface LoadedRuntimeRegressionScenario extends RuntimeRegressionScenario {
  manifestPath: string;
  assetRoot: string;
  screenInputs: ReadonlyMap<string, CaptureScreenContextResponse>;
  loadedAt: number;
  loadDurationMs: number;
}

export async function loadRuntimeRegressionScenario(manifestPath: string, reader = NATIVE_READER): Promise<LoadedRuntimeRegressionScenario> {
  const startedAt = Date.now();
  const manifestRoot = await reader.dirname(manifestPath);
  const manifestFile = await reader.read({ assetRoot: manifestRoot, path: manifestPath, allowAbsolute: true, image: false });
  const manifest = readRuntimeRegressionScenarioManifest(JSON.parse(manifestFile.text ?? ""));
  const assetRoot = await reader.resolve(manifestRoot, manifest.assetRoot);
  const read = async (ref: SessionProcedureFileRef, image: boolean, root = assetRoot) => {
    const result = await reader.read({ assetRoot: root, path: ref.path, allowAbsolute: manifest.allowAbsoluteAssets, expectedSha256: ref.sha256, image });
    if (result.sha256 !== ref.sha256 || (ref.mediaType && result.mediaType !== ref.mediaType)) throw new Error("Replay asset digest/media type mismatch.");
    if (image ? !result.base64 : !result.text) throw new Error("Replay asset payload is empty.");
    return result;
  };
  const procedureFile = await read(manifest.procedure, false, manifestRoot);
  const scenario = readRuntimeRegressionScenario(manifest, JSON.parse(procedureFile.text!));
  const screenInputs = new Map<string, CaptureScreenContextResponse>();
  let imageChars = 0;
  for (const [index, input] of scenario.inputs.entries()) {
    if (input.kind !== "screen-input") continue;
    const image = await read(input.screen.image, true);
    const focus = input.screen.focusImage ? await read(input.screen.focusImage, true) : undefined;
    imageChars += image.base64!.length + (focus?.base64?.length ?? 0);
    if (imageChars > 80 * 1024 * 1024) throw new Error("Replay images exceed the recording payload budget.");
    const metadata = input.screen.metadata ? JSON.parse((await read(input.screen.metadata, false)).text!) : undefined;
    if (metadata?.imageMediaType && metadata.imageMediaType !== image.mediaType) throw new Error("Replay metadata does not match the main image.");
    if (metadata?.focusImageMediaType && metadata.focusImageMediaType !== focus?.mediaType) throw new Error("Replay metadata does not match the focus image.");
    const target = metadata === undefined ? undefined : readCaptureTarget(metadata.captureTarget);
    if (target?.focusRegion && !focus) throw new Error("Replay focus metadata has no paired image.");
    screenInputs.set(scenario.procedure.steps[index].id, {
      imageBase64: image.base64!, imageMediaType: image.mediaType!,
      focusImageBase64: focus?.base64 ?? undefined, focusImageMediaType: focus?.mediaType ?? undefined,
      target,
    });
  }
  return { ...scenario, manifestPath: manifestFile.absolutePath, assetRoot, screenInputs, loadedAt: Date.now(), loadDurationMs: Date.now() - startedAt };
}

// Retain only capture evidence. Old observation IDs, timings, task IDs, preflight
// answers and the current mouse position cannot become this run's source facts.
function readCaptureTarget(value: unknown): ScreenCaptureTarget | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Replay capture metadata is invalid.");
  const raw = value as Record<string, unknown>;
  if (!["active-window", "current-monitor", "selection"].includes(String(raw.targetType))) throw new Error("Replay capture target type is invalid.");
  const numeric = (key: string, required = false) => {
    const value = raw[key];
    if (value === undefined && !required) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Replay capture ${key} is invalid.`);
    return value;
  };
  const target: ScreenCaptureTarget = { targetType: raw.targetType as ScreenCaptureTarget["targetType"],
    x: numeric("x", true)!, y: numeric("y", true)!, width: numeric("width", true)!, height: numeric("height", true)! };
  if (target.width <= 0 || target.height <= 0) throw new Error("Replay capture dimensions are invalid.");
  for (const key of ["appName", "title", "monitorName", "selectionReason", "captureMethod", "fallbackReason"] as const) {
    if (raw[key] == null) continue;
    if (typeof raw[key] !== "string") throw new Error(`Replay capture ${key} is invalid.`);
    target[key] = raw[key];
  }
  for (const key of ["imageWidth", "imageHeight", "originalImageWidth", "originalImageHeight"] as const) target[key] = numeric(key);
  if (raw.optimizedForScreenContext !== undefined) {
    if (typeof raw.optimizedForScreenContext !== "boolean") throw new Error("Replay capture optimization flag is invalid.");
    target.optimizedForScreenContext = raw.optimizedForScreenContext;
  }
  for (const key of ["cursor", "focusRegion"] as const) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const item = raw[key];
    if (typeof item !== "object" || Array.isArray(item)) throw new Error(`Replay ${key} is invalid.`);
    const allowed = key === "cursor" ? ["globalX", "globalY", "targetX", "targetY", "normalizedX", "normalizedY"]
      : ["x", "y", "width", "height", "imageWidth", "imageHeight", "originalImageWidth", "originalImageHeight", "cursorX", "cursorY"];
    const result: Record<string, unknown> = {};
    for (const field of allowed) {
      const number = (item as Record<string, unknown>)[field];
      if (key === "cursor" && ["normalizedX", "normalizedY"].includes(field) && number === undefined) continue;
      if (typeof number !== "number" || !Number.isFinite(number)) throw new Error(`Replay ${key}.${field} is invalid.`);
      result[field] = number;
    }
    const source = (item as Record<string, unknown>).source;
    if (source !== undefined && typeof source !== "string") throw new Error(`Replay ${key} source is invalid.`);
    if (source !== undefined) result.source = source;
    if (key === "cursor") {
      const inside = (item as Record<string, unknown>).insideTarget;
      if (typeof inside !== "boolean") throw new Error("Replay cursor position is invalid.");
      result.insideTarget = inside;
      target.cursor = result as unknown as ScreenCaptureTarget["cursor"];
    } else target.focusRegion = result as unknown as ScreenCaptureTarget["focusRegion"];
  }
  return target;
}
