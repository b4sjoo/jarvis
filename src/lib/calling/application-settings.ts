import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./runtime-environment.js";

export interface ApplicationSettings {
  revision: number;
  stealthMode: boolean;
}

export const DEFAULT_APPLICATION_SETTINGS: ApplicationSettings = {
  revision: 1,
  stealthMode: true,
};

const STORAGE_KEY = "moss.application-settings.v1";

export function normalizeApplicationSettings(value: unknown): ApplicationSettings {
  const input = (value ?? {}) as Partial<ApplicationSettings>;
  return {
    revision:
      typeof input.revision === "number" && Number.isFinite(input.revision)
        ? Math.max(1, Math.round(input.revision))
        : DEFAULT_APPLICATION_SETTINGS.revision,
    stealthMode:
      typeof input.stealthMode === "boolean"
        ? input.stealthMode
        : DEFAULT_APPLICATION_SETTINGS.stealthMode,
  };
}

export function loadApplicationSettings(): ApplicationSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored
      ? normalizeApplicationSettings(JSON.parse(stored))
      : structuredClone(DEFAULT_APPLICATION_SETTINGS);
  } catch {
    return structuredClone(DEFAULT_APPLICATION_SETTINGS);
  }
}

export function persistApplicationSettings(settings: ApplicationSettings) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(normalizeApplicationSettings(settings))
  );
}

export async function applyNativeStealthMode(enabled: boolean) {
  if (!isTauriRuntime()) return;
  await invoke("set_stealth_mode", { enabled });
}
