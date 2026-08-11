import { getItem, saveItem } from "tauri-plugin-keychain";

export type ChatRouteId = "runtime" | "advisor" | "complex";

export interface ChatModelRouteConfig {
  id: ChatRouteId;
  endpoint: string;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
}

export interface SttRouteConfig {
  endpoint: string;
  model: string;
  language: string;
}

export interface ModelRouteSettings {
  chat: Record<ChatRouteId, ChatModelRouteConfig>;
  stt: SttRouteConfig;
}

const SETTINGS_KEY = "moss.model-routes.v1";
const secretKey = (route: ChatRouteId | "stt") => `moss.provider.${route}.api-key`;

export const DEFAULT_MODEL_ROUTES: ModelRouteSettings = {
  chat: {
    runtime: { id: "runtime", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4.1-mini", timeoutMs: 8_000, maxOutputTokens: 500 },
    advisor: { id: "advisor", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4.1", timeoutMs: 30_000, maxOutputTokens: 1_200 },
    complex: { id: "complex", endpoint: "https://api.openai.com/v1/chat/completions", model: "o3", timeoutMs: 120_000, maxOutputTokens: 4_000 },
  },
  stt: { endpoint: "https://api.openai.com/v1/audio/transcriptions", model: "gpt-4o-mini-transcribe", language: "en" },
};

export function loadModelRouteSettings(): ModelRouteSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return structuredClone(DEFAULT_MODEL_ROUTES);
    const parsed = JSON.parse(raw) as Partial<ModelRouteSettings>;
    return {
      chat: {
        runtime: { ...DEFAULT_MODEL_ROUTES.chat.runtime, ...parsed.chat?.runtime, id: "runtime" },
        advisor: { ...DEFAULT_MODEL_ROUTES.chat.advisor, ...parsed.chat?.advisor, id: "advisor" },
        complex: { ...DEFAULT_MODEL_ROUTES.chat.complex, ...parsed.chat?.complex, id: "complex" },
      },
      stt: { ...DEFAULT_MODEL_ROUTES.stt, ...parsed.stt },
    };
  } catch {
    return structuredClone(DEFAULT_MODEL_ROUTES);
  }
}

export function saveModelRouteSettings(settings: ModelRouteSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

const browserSecrets = new Map<string, string>();

export async function loadProviderSecret(route: ChatRouteId | "stt") {
  const key = secretKey(route);
  if (!("__TAURI_INTERNALS__" in window)) return browserSecrets.get(key) ?? "";
  return (await getItem(key)) ?? "";
}

export async function saveProviderSecret(route: ChatRouteId | "stt", secret: string) {
  const key = secretKey(route);
  if (!("__TAURI_INTERNALS__" in window)) {
    browserSecrets.set(key, secret);
    return;
  }
  await saveItem(key, secret);
}
