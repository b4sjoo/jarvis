import { fetchAIResponse } from "@/lib/functions/ai-response.function";
import type { TYPE_PROVIDER } from "@/types";
import type { SelectedProviderState } from "./types.js";
import {
  buildTaxonomyAdjudicationPrompts,
  parseTaxonomyAdjudicationOutput,
  type TaxonomyAdjudicationParseResult,
  type TaxonomyAdjudicationRequest,
} from "./taxonomy-adjudication.js";

export const TAXONOMY_ADJUDICATION_TIMEOUT_MS = 4_000;
export const TAXONOMY_ADJUDICATION_MAX_OUTPUT_TOKENS = 256;

export interface TaxonomyAdjudicationRequestResult {
  rawOutput: string;
  parsed: TaxonomyAdjudicationParseResult;
  firstTokenAt?: number;
  completedAt: number;
}

export async function requestTaxonomyAdjudication(input: {
  request: TaxonomyAdjudicationRequest;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  signal: AbortSignal;
  onFirstToken?: (at: number) => void;
}): Promise<TaxonomyAdjudicationRequestResult> {
  const prompts = buildTaxonomyAdjudicationPrompts(input.request);
  let rawOutput = "";
  let firstTokenAt: number | undefined;
  for await (const chunk of fetchAIResponse({
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
  })) {
    if (input.signal.aborted) break;
    if (firstTokenAt === undefined && chunk) {
      firstTokenAt = Date.now();
      input.onFirstToken?.(firstTokenAt);
    }
    rawOutput += chunk;
  }
  if (input.signal.aborted) {
    throw new DOMException("Taxonomy adjudication aborted", "AbortError");
  }
  return {
    rawOutput,
    parsed: parseTaxonomyAdjudicationOutput(rawOutput, input.request),
    firstTokenAt,
    completedAt: Date.now(),
  };
}
