import { getItem, saveItem } from "tauri-plugin-keychain";
import {
  getChatProvider,
  getSttProvider,
  inferChatProvider,
  inferSttProvider,
  isChatProviderId,
  isSttProviderId,
  type ChatProviderId,
  type SttProviderId,
} from "./provider-catalog.js";
import { isTauriRuntime } from "./runtime-environment.js";

export type ChatRouteId = "runtime" | "advisor" | "complex";

export interface ChatModelRouteConfig {
  id: ChatRouteId;
  provider: ChatProviderId;
  endpoint: string;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
}

export interface SttRouteConfig {
  provider: SttProviderId;
  endpoint: string;
  model: string;
  language: string;
}

export interface ModelRouteSettings {
  revision: number;
  chat: Record<ChatRouteId, ChatModelRouteConfig>;
  stt: SttRouteConfig;
}

const SETTINGS_KEY = "moss.model-routes.v1";
const secretKey = (route: ChatRouteId | "stt") =>
  `moss.provider.${route}.api-key`;

export const DEFAULT_MODEL_ROUTES: ModelRouteSettings = {
  revision: 1,
  chat: {
    runtime: {
      id: "runtime",
      provider: "openai",
      endpoint: getChatProvider("openai").endpoint,
      model: "gpt-4.1-mini",
      timeoutMs: 8_000,
      maxOutputTokens: 500,
    },
    advisor: {
      id: "advisor",
      provider: "openai",
      endpoint: getChatProvider("openai").endpoint,
      model: "gpt-4.1",
      timeoutMs: 30_000,
      maxOutputTokens: 1_200,
    },
    complex: {
      id: "complex",
      provider: "openai",
      endpoint: getChatProvider("openai").endpoint,
      model: "o3",
      timeoutMs: 120_000,
      maxOutputTokens: 4_000,
    },
  },
  stt: {
    provider: "openai-whisper",
    endpoint: getSttProvider("openai-whisper").endpoint,
    model: "gpt-4o-mini-transcribe",
    language: "en",
  },
};

const objectValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const positiveInteger = (value: unknown, fallback: number) =>
  Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;

const nonEmptyString = (value: unknown, fallback: string) =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;

const normalizeChatRoute = (id: ChatRouteId, value: unknown) => {
  const fallback = DEFAULT_MODEL_ROUTES.chat[id];
  const route = objectValue(value);
  const provider = isChatProviderId(route.provider)
    ? route.provider
    : inferChatProvider(route.endpoint) ?? fallback.provider;
  return {
    id,
    provider,
    endpoint: getChatProvider(provider).endpoint,
    model: nonEmptyString(route.model, fallback.model),
    timeoutMs: positiveInteger(route.timeoutMs, fallback.timeoutMs),
    maxOutputTokens: positiveInteger(
      route.maxOutputTokens,
      fallback.maxOutputTokens
    ),
  } satisfies ChatModelRouteConfig;
};

const normalizeSttRoute = (value: unknown) => {
  const fallback = DEFAULT_MODEL_ROUTES.stt;
  const route = objectValue(value);
  const provider = isSttProviderId(route.provider)
    ? route.provider
    : inferSttProvider(route.endpoint) ?? fallback.provider;
  return {
    provider,
    endpoint: getSttProvider(provider).endpoint,
    model: nonEmptyString(route.model, fallback.model),
    language:
      typeof route.language === "string"
        ? route.language.trim()
        : fallback.language,
  } satisfies SttRouteConfig;
};

export function normalizeModelRouteSettings(value: unknown): ModelRouteSettings {
  const settings = objectValue(value);
  const chat = objectValue(settings.chat);
  return {
    revision: positiveInteger(settings.revision, DEFAULT_MODEL_ROUTES.revision),
    chat: {
      runtime: normalizeChatRoute("runtime", chat.runtime),
      advisor: normalizeChatRoute("advisor", chat.advisor),
      complex: normalizeChatRoute("complex", chat.complex),
    },
    stt: normalizeSttRoute(settings.stt),
  };
}

export function loadModelRouteSettings(): ModelRouteSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return structuredClone(DEFAULT_MODEL_ROUTES);
    return normalizeModelRouteSettings(JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT_MODEL_ROUTES);
  }
}

export function saveModelRouteSettings(settings: ModelRouteSettings) {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify(normalizeModelRouteSettings(settings))
  );
}

const browserSecrets = new Map<string, string>();

export async function loadProviderSecret(route: ChatRouteId | "stt") {
  const key = secretKey(route);
  if (!isTauriRuntime()) return browserSecrets.get(key) ?? "";
  return (await getItem(key)) ?? "";
}

export async function saveProviderSecret(route: ChatRouteId | "stt", secret: string) {
  const key = secretKey(route);
  if (!isTauriRuntime()) {
    browserSecrets.set(key, secret);
    return;
  }
  await saveItem(key, secret);
}
