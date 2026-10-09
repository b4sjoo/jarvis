import type { SelectedAiProviderConfig } from "../types/provider.type";

export const DECISIONS_PROVIDER_ID = "openai-decisions";
export const DECISIONS_MODEL = "gpt-6-luna";
export const DECISIONS_ENDPOINT = "https://api.openai.com/v1/decisions";

export interface DecisionsProviderSnapshot {
  readonly providerId: typeof DECISIONS_PROVIDER_ID;
  readonly modelId: typeof DECISIONS_MODEL;
  readonly apiKey: string;
}

export function readDecisionsProviderConfiguration(
  selected: SelectedAiProviderConfig | undefined
): { snapshot?: Readonly<DecisionsProviderSnapshot>; error?: string } {
  if (!selected?.provider) return { error: "Configure the OpenAI Decisions provider." };
  if (selected.provider !== DECISIONS_PROVIDER_ID) {
    return { error: "Only the OpenAI Decisions provider is supported." };
  }
  const variables = Object.fromEntries(
    Object.entries(selected.variables ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  if (variables.model && variables.model !== DECISIONS_MODEL) {
    return { error: `The supported Decisions model is ${DECISIONS_MODEL}.` };
  }
  const apiKey = typeof variables.api_key === "string" ? variables.api_key.trim() : "";
  if (!apiKey) return { error: "OpenAI Decisions API key is required." };
  return { snapshot: Object.freeze({ providerId: DECISIONS_PROVIDER_ID, modelId: DECISIONS_MODEL, apiKey }) };
}
