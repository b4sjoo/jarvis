import type {
  SelectedAiProviderConfig,
  TYPE_PROVIDER,
} from "../../types/provider.type.js";

export type PreparationModelRouteStatus =
  | "ready"
  | "provider-not-configured"
  | "provider-not-found"
  | "missing-required-variables"
  | "vision-not-supported";

export interface PreparationModelRoute {
  status: PreparationModelRouteStatus;
  selectedProvider: SelectedAiProviderConfig;
  provider?: TYPE_PROVIDER;
  missingRequiredVariables: string[];
  supportsVision: boolean;
}

export function resolvePreparationModelRoute(input: {
  providers: TYPE_PROVIDER[];
  selectedProvider: SelectedAiProviderConfig;
  requiresVision?: boolean;
}): PreparationModelRoute {
  const { providers, selectedProvider } = input;
  const base = {
    selectedProvider,
    missingRequiredVariables: [] as string[],
    supportsVision: false,
  };

  if (!selectedProvider.provider) {
    return { ...base, status: "provider-not-configured" };
  }

  const provider = providers.find(
    (candidate) => candidate.id === selectedProvider.provider
  );
  if (!provider) {
    return { ...base, status: "provider-not-found" };
  }

  const supportsVision = provider.curl.includes("{{IMAGE}}");
  const missingRequiredVariables = requiredProviderVariables(
    provider.curl
  ).filter(
    (key) => !readProviderVariable(selectedProvider.variables, key)
  );

  if (missingRequiredVariables.length > 0) {
    return {
      ...base,
      provider,
      supportsVision,
      missingRequiredVariables,
      status: "missing-required-variables",
    };
  }

  if (input.requiresVision && !supportsVision) {
    return {
      ...base,
      provider,
      supportsVision,
      status: "vision-not-supported",
    };
  }

  return {
    ...base,
    provider,
    supportsVision,
    status: "ready",
  };
}

function requiredProviderVariables(curl: string) {
  const ignored = new Set([
    "SYSTEM_PROMPT",
    "TEXT",
    "IMAGE",
    "IMAGE_MEDIA_TYPE",
    "AUDIO",
  ]);
  return Array.from(curl.matchAll(/\{\{([A-Z_]+)\}\}/g), (match) => match[1])
    .filter((key) => !ignored.has(key))
    .filter((key, index, values) => values.indexOf(key) === index);
}

function readProviderVariable(variables: Record<string, string>, key: string) {
  const entry = Object.entries(variables).find(
    ([candidate]) => candidate.toUpperCase() === key.toUpperCase()
  );
  return entry?.[1]?.trim() ?? "";
}
