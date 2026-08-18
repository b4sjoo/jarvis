import {
  fetchAIResponseEvents,
} from "@/lib/functions/ai-response.function";
import type { AIResponseExecutionIdentityInput } from "../functions/ai-response-events.js";
import type { TYPE_PROVIDER } from "@/types";
import type { SelectedProviderState } from "./types.js";
import {
  buildTaxonomyAdjudicationPrompts,
  type TaxonomyAdjudicationRequest,
} from "./taxonomy-adjudication.js";
import {
  consumeTypedTaxonomyAdjudicationResponse,
  type TaxonomyAdjudicationRequestResult,
} from "./taxonomy-adjudication-response.js";
import { getRuntimeInferenceOperationDefinition } from "./runtime-inference.js";

const TAXONOMY_OPERATION =
  getRuntimeInferenceOperationDefinition("taxonomy-adjudication");

export const TAXONOMY_ADJUDICATION_TIMEOUT_MS =
  TAXONOMY_OPERATION.timeoutMs;
export const TAXONOMY_ADJUDICATION_MAX_OUTPUT_TOKENS =
  TAXONOMY_OPERATION.maxOutputTokens;

export async function requestTaxonomyAdjudication(input: {
  request: TaxonomyAdjudicationRequest;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  signal: AbortSignal;
  executionIdentity?: AIResponseExecutionIdentityInput;
  onFirstToken?: (at: number) => void;
}): Promise<TaxonomyAdjudicationRequestResult> {
  const prompts = buildTaxonomyAdjudicationPrompts(input.request);
  const responseEvents = fetchAIResponseEvents({
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
    executionIdentity: {
      ...input.executionIdentity,
      logicalQuestionUnitId:
        input.executionIdentity?.logicalQuestionUnitId ??
        input.request.logicalQuestionUnitId,
      logicalQuestionRevision:
        input.executionIdentity?.logicalQuestionRevision ??
        input.request.logicalQuestionUnitRevision,
    },
  });
  return consumeTypedTaxonomyAdjudicationResponse({
    request: input.request,
    responseEvents,
    signal: input.signal,
    onFirstToken: input.onFirstToken,
  });
}
