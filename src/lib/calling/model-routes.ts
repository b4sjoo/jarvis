import { invoke } from "@tauri-apps/api/core";
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

const credentialFailure = (action: "read" | "save", cause: unknown) => {
  console.error(`[moss-credentials] Failed to ${action} provider credentials.`, cause);
  const nextStep =
    action === "read"
      ? "Open Models and save the affected API key again."
      : "Open Models and try saving the API key again.";
  return new Error(
    `MOSS could not ${action} provider credentials in its local private vault. ${nextStep}`
  );
};

export async function loadProviderSecret(route: ChatRouteId | "stt") {
  const key = secretKey(route);
  if (!isTauriRuntime()) return browserSecrets.get(key) ?? "";
  try {
    return (await invoke<string | null>("get_provider_secret", { key })) ?? "";
  } catch (cause) {
    throw credentialFailure("read", cause);
  }
}

export async function saveProviderSecret(route: ChatRouteId | "stt", secret: string) {
  const key = secretKey(route);
  if (!isTauriRuntime()) {
    browserSecrets.set(key, secret);
    return;
  }
  try {
    await invoke("save_provider_secret", { key, secret });
  } catch (cause) {
    throw credentialFailure("save", cause);
  }
}

export async function removeProviderSecret(route: ChatRouteId | "stt") {
  const key = secretKey(route);
  if (!isTauriRuntime()) {
    browserSecrets.delete(key);
    return;
  }
  try {
    await invoke("remove_provider_secret", { key });
  } catch (cause) {
    throw credentialFailure("save", cause);
  }
}

export type ProviderSecretRoute = ChatRouteId | "stt";

export interface ProviderSecretTransactionEvent {
  status: "started" | "succeeded" | "compensated" | "failed";
  revision: number;
  routes: ProviderSecretRoute[];
  failedStage?: "credential-write" | "settings-commit" | "compensation";
}

export async function commitProviderConfigurationTransaction(input: {
  revision: number;
  previousSecrets: Record<ProviderSecretRoute, string>;
  nextSecrets: Record<ProviderSecretRoute, string>;
  changedRoutes: ProviderSecretRoute[];
  writeSecret?: (route: ProviderSecretRoute, value: string) => Promise<void>;
  removeSecret?: (route: ProviderSecretRoute) => Promise<void>;
  commitSettings: () => void | Promise<void>;
  onEvent?: (event: ProviderSecretTransactionEvent) => void;
}) {
  const write = input.writeSecret ?? saveProviderSecret;
  const remove = input.removeSecret ?? removeProviderSecret;
  const applied: ProviderSecretRoute[] = [];
  const routes = [...input.changedRoutes];
  input.onEvent?.({
    status: "started",
    revision: input.revision,
    routes,
  });

  let failedStage: ProviderSecretTransactionEvent["failedStage"] =
    "credential-write";
  try {
    for (const route of routes) {
      const value = input.nextSecrets[route];
      if (value) await write(route, value);
      else await remove(route);
      applied.push(route);
    }
    failedStage = "settings-commit";
    await input.commitSettings();
    input.onEvent?.({
      status: "succeeded",
      revision: input.revision,
      routes,
    });
  } catch (error) {
    const compensationErrors: string[] = [];
    for (const route of applied.reverse()) {
      try {
        const previous = input.previousSecrets[route];
        if (previous) await write(route, previous);
        else await remove(route);
      } catch (compensationError) {
        compensationErrors.push(
          `${route}: ${compensationError instanceof Error ? compensationError.message : String(compensationError)}`
        );
      }
    }
    input.onEvent?.({
      status: compensationErrors.length ? "failed" : "compensated",
      revision: input.revision,
      routes,
      failedStage: compensationErrors.length ? "compensation" : failedStage,
    });
    if (compensationErrors.length) {
      throw new Error(
        `Provider configuration failed and credential compensation was incomplete (${compensationErrors.join("; ")}).`
      );
    }
    throw error;
  }
}
