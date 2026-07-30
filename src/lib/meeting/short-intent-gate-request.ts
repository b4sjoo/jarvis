import { fetchAIResponse } from "@/lib/functions/ai-response.function";
import type { TYPE_PROVIDER } from "@/types";
import type { SelectedProviderState } from "./types.js";
import {
  buildShortIntentGatePrompts,
  parseShortIntentGateOutput,
  type ShortIntentGateParseResult,
  type ShortIntentGateRequest,
} from "./short-intent-gate.js";
import { getRuntimeInferenceOperationDefinition } from "./runtime-inference.js";
import { classifyTaxonomyAdjudicationProviderOutput } from "./taxonomy-adjudication-response.js";

const OPERATION = getRuntimeInferenceOperationDefinition(
  "short-intent-gate"
);

export interface ShortIntentGateRequestResult {
  rawOutput: string;
  parsed: ShortIntentGateParseResult;
  providerDisposition:
    | "completed-with-content"
    | "completed-empty"
    | "provider-error-content"
    | "provider-auth-error";
  parseDisposition: string;
  firstTokenAt?: number;
  completedAt: number;
}

export async function requestShortIntentGate(input: {
  request: ShortIntentGateRequest;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  signal: AbortSignal;
  onFirstToken?: (at: number) => void;
}): Promise<ShortIntentGateRequestResult> {
  const prompts = buildShortIntentGatePrompts(input.request);
  const responseStream = fetchAIResponse({
    provider: input.provider,
    selectedProvider: input.selectedProvider,
    systemPrompt: prompts.systemPrompt,
    userMessage: prompts.userMessage,
    signal: input.signal,
    applyResponseSettings: false,
    requestOptions: {
      timeoutMs: OPERATION.timeoutMs,
      maxOutputTokens: OPERATION.maxOutputTokens,
    },
  });
  let rawOutput = "";
  let firstTokenAt: number | undefined;
  for await (const chunk of responseStream) {
    if (input.signal.aborted) break;
    if (firstTokenAt === undefined && chunk) {
      firstTokenAt = Date.now();
      input.onFirstToken?.(firstTokenAt);
    }
    rawOutput += chunk;
  }
  if (input.signal.aborted) {
    throw new DOMException("Short intent gate aborted", "AbortError");
  }

  const providerDisposition =
    classifyTaxonomyAdjudicationProviderOutput(rawOutput);
  const parsed =
    providerDisposition === "completed-with-content"
      ? parseShortIntentGateOutput(rawOutput, input.request)
      : ({
          ok: false,
          reason: providerDisposition,
          errorKind: "provider",
          evidenceSpansValid: false,
        } satisfies ShortIntentGateParseResult);
  return {
    rawOutput,
    parsed,
    providerDisposition,
    parseDisposition:
      providerDisposition === "completed-with-content"
        ? parsed.ok
          ? "valid-json"
          : parsed.reason
        : `not-run-${providerDisposition}`,
    firstTokenAt,
    completedAt: Date.now(),
  };
}
