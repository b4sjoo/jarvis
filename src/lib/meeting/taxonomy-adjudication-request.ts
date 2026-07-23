import { fetchAIResponse } from "@/lib/functions/ai-response.function";
import type { TYPE_PROVIDER } from "@/types";
import type { SelectedProviderState } from "./types.js";
import {
  buildTaxonomyAdjudicationPrompts,
  type TaxonomyAdjudicationRequest,
} from "./taxonomy-adjudication.js";
import {
  consumeTaxonomyAdjudicationResponse,
  type TaxonomyAdjudicationRequestResult,
} from "./taxonomy-adjudication-response.js";

export const TAXONOMY_ADJUDICATION_TIMEOUT_MS = 4_000;
export const TAXONOMY_ADJUDICATION_MAX_OUTPUT_TOKENS = 256;

export async function requestTaxonomyAdjudication(input: {
  request: TaxonomyAdjudicationRequest;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  signal: AbortSignal;
  onFirstToken?: (at: number) => void;
}): Promise<TaxonomyAdjudicationRequestResult> {
  const prompts = buildTaxonomyAdjudicationPrompts(input.request);
  const responseStream = fetchAIResponse({
    provider: input.provider,
    selectedProvider: input.selectedProvider,
    systemPrompt: prompts.systemPrompt,
    userMessage: prompts.userMessage,
    signal: input.signal,
    applyResponseSettings: false,
    requestOptions: {
      timeoutMs: TAXONOMY_ADJUDICATION_TIMEOUT_MS,
      maxOutputTokens: TAXONOMY_ADJUDICATION_MAX_OUTPUT_TOKENS,
    },
  });
  return consumeTaxonomyAdjudicationResponse({
    request: input.request,
    responseStream,
    signal: input.signal,
    onFirstToken: input.onFirstToken,
  });
}
