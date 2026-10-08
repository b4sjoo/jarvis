import curl2Json from "@bany/curl-to-json";
import type { TYPE_PROVIDER } from "@/types";
import type { SelectedProviderState } from "./types";

export type SttRequestValueSource =
  | "selected-provider-variable"
  | "provider-template"
  | "not-observed";

export type SttRequestLanguageMode =
  | "explicit"
  | "automatic"
  | "unknown";

export type SttRequestPromptKind =
  | "none"
  | "speech-bias"
  | "continuation"
  | "speech-bias+continuation"
  | "custom";

export interface SttRequestEvidence {
  providerId?: string;
  configuredProviderId?: string;
  providerIdentityStatus:
    | "matched"
    | "mismatched"
    | "provider-only"
    | "configured-only"
    | "unknown";
  modelId?: string;
  modelSource: SttRequestValueSource;
  language?: string;
  languageMode: SttRequestLanguageMode;
  languageSource: SttRequestValueSource;
  promptKind: SttRequestPromptKind;
  promptChars: number;
  termCount: number;
  confidenceCapability: "not-exposed-by-text-adapter";
}

const MODEL_KEYS = new Set([
  "model",
  "modelid",
  "modelname",
  "sttmodel",
  "deployment",
  "deploymentid",
]);

const LANGUAGE_KEYS = new Set([
  "lang",
  "language",
  "languagecode",
  "locale",
]);

const MAX_RECORDED_VALUE_CHARS = 120;

export function isPhraseListOnlySttProvider(
  provider: TYPE_PROVIDER | undefined
): boolean {
  return (
    Boolean(provider?.curl.includes("{{STT_TERMS_JSON}}")) &&
    !provider?.curl.includes("{{STT_PROMPT}}")
  );
}

export function buildSttRequestEvidence({
  provider,
  selectedProvider,
  prompt,
  promptKind,
  terms = [],
}: {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  prompt?: string;
  promptKind?: SttRequestPromptKind;
  terms?: string[];
}): SttRequestEvidence {
  const selectedVariables = normalizeSelectedVariables(
    selectedProvider.variables
  );
  const parsedFields = readProviderTemplateFields(
    provider?.curl,
    selectedVariables
  );
  const selectedModel = readFirstVariable(selectedVariables, MODEL_KEYS);
  const selectedLanguage = readFirstVariable(
    selectedVariables,
    LANGUAGE_KEYS
  );
  const model = selectedModel ?? parsedFields.model;
  const language = selectedLanguage ?? parsedFields.language;
  const termsOnly = isPhraseListOnlySttProvider(provider);

  return {
    providerId: cleanRecordedValue(provider?.id),
    configuredProviderId: cleanRecordedValue(selectedProvider.provider),
    providerIdentityStatus: resolveProviderIdentityStatus(
      provider?.id,
      selectedProvider.provider
    ),
    modelId: model?.value,
    modelSource: model?.source ?? "not-observed",
    language: language?.value,
    languageMode: language
      ? "explicit"
      : provider
        ? "automatic"
        : "unknown",
    languageSource: language?.source ?? "not-observed",
    promptKind: termsOnly
      ? (terms.length ? "speech-bias" : "none")
      : promptKind ?? resolvePromptKind(prompt, terms),
    promptChars: termsOnly ? 0 : prompt?.length ?? 0,
    termCount: terms.length,
    confidenceCapability: "not-exposed-by-text-adapter",
  };
}

export function formatSttRequestEvidenceForTrace(
  evidence: SttRequestEvidence
): Record<string, string | number | undefined> {
  return {
    sttRequestProviderId: evidence.providerId,
    sttRequestConfiguredProviderId: evidence.configuredProviderId,
    sttRequestProviderIdentityStatus: evidence.providerIdentityStatus,
    sttRequestModelId: evidence.modelId,
    sttRequestModelSource: evidence.modelSource,
    sttRequestLanguage: evidence.language,
    sttRequestLanguageMode: evidence.languageMode,
    sttRequestLanguageSource: evidence.languageSource,
    sttRequestPromptKind: evidence.promptKind,
    sttRequestPromptChars: evidence.promptChars,
    sttRequestTermCount: evidence.termCount,
    sttRequestConfidenceCapability: evidence.confidenceCapability,
  };
}

function resolveProviderIdentityStatus(
  providerId: string | undefined,
  configuredProviderId: string | undefined
): SttRequestEvidence["providerIdentityStatus"] {
  if (providerId && configuredProviderId) {
    return providerId === configuredProviderId ? "matched" : "mismatched";
  }
  if (providerId) return "provider-only";
  if (configuredProviderId) return "configured-only";
  return "unknown";
}

function resolvePromptKind(
  prompt: string | undefined,
  terms: string[]
): SttRequestPromptKind {
  if (!prompt?.trim()) return "none";
  return terms.length > 0 ? "speech-bias" : "custom";
}

function normalizeSelectedVariables(
  variables: Record<string, string>
): Map<string, string> {
  const normalized = new Map<string, string>();
  for (const [key, value] of Object.entries(variables)) {
    const cleanValue = cleanRecordedValue(value);
    if (!cleanValue) continue;
    normalized.set(normalizeFieldKey(key), cleanValue);
  }
  return normalized;
}

function readFirstVariable(
  variables: Map<string, string>,
  acceptedKeys: Set<string>
): { value: string; source: SttRequestValueSource } | undefined {
  for (const key of acceptedKeys) {
    const value = variables.get(key);
    if (value) {
      return {
        value,
        source: "selected-provider-variable",
      };
    }
  }
  return undefined;
}

function readProviderTemplateFields(
  curl: string | undefined,
  selectedVariables: Map<string, string>
): {
  model?: { value: string; source: SttRequestValueSource };
  language?: { value: string; source: SttRequestValueSource };
} {
  if (!curl) return {};

  try {
    const parsed = curl2Json(curl) as unknown;
    const candidates: Array<{ key: string; value: unknown }> = [];
    collectKnownFields(parsed, candidates);

    const model = readTemplateCandidate(
      candidates,
      MODEL_KEYS,
      selectedVariables
    );
    const language = readTemplateCandidate(
      candidates,
      LANGUAGE_KEYS,
      selectedVariables
    );
    return { model, language };
  } catch {
    return {};
  }
}

function collectKnownFields(
  value: unknown,
  output: Array<{ key: string; value: unknown }>
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") {
        collectFormField(item, output);
      } else {
        collectKnownFields(item, output);
      }
    }
    return;
  }

  if (!value || typeof value !== "object") return;

  for (const [key, nestedValue] of Object.entries(
    value as Record<string, unknown>
  )) {
    const normalizedKey = normalizeFieldKey(key);
    if (MODEL_KEYS.has(normalizedKey) || LANGUAGE_KEYS.has(normalizedKey)) {
      output.push({ key: normalizedKey, value: nestedValue });
    }
    collectKnownFields(nestedValue, output);
  }
}

function collectFormField(
  field: string,
  output: Array<{ key: string; value: unknown }>
): void {
  const separatorIndex = field.indexOf("=");
  if (separatorIndex <= 0) return;

  const key = normalizeFieldKey(field.slice(0, separatorIndex));
  const rawValue = field.slice(separatorIndex + 1).trim();
  if (MODEL_KEYS.has(key) || LANGUAGE_KEYS.has(key)) {
    output.push({ key, value: rawValue });
  }

  if (!rawValue.startsWith("{")) return;
  try {
    collectKnownFields(
      JSON.parse(rawValue.replaceAll("{{STT_TERMS_JSON}}", "[]")), output
    );
  } catch {
    // A malformed optional config field should not affect the STT request.
  }
}

function readTemplateCandidate(
  candidates: Array<{ key: string; value: unknown }>,
  acceptedKeys: Set<string>,
  selectedVariables: Map<string, string>
): { value: string; source: SttRequestValueSource } | undefined {
  for (const candidate of candidates) {
    if (!acceptedKeys.has(candidate.key)) continue;
    const rawValue =
      typeof candidate.value === "string"
        ? decodeTemplateValue(candidate.value)
        : undefined;
    if (!rawValue) continue;

    const placeholder = readSinglePlaceholder(rawValue);
    if (placeholder) {
      const selectedValue = selectedVariables.get(
        normalizeFieldKey(placeholder)
      );
      if (selectedValue) {
        return {
          value: selectedValue,
          source: "selected-provider-variable",
        };
      }
      continue;
    }

    const value = cleanRecordedValue(rawValue);
    if (value) {
      return {
        value,
        source: "provider-template",
      };
    }
  }
  return undefined;
}

function decodeTemplateValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function readSinglePlaceholder(value: string): string | undefined {
  const match = value.trim().match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
  return match?.[1];
}

function normalizeFieldKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cleanRecordedValue(value: string | undefined): string | undefined {
  const clean = value?.replace(/[\r\n\t]+/g, " ").trim();
  if (!clean || clean.includes("{{")) return undefined;
  return clean.slice(0, MAX_RECORDED_VALUE_CHARS);
}
