import {
  fetchAIResponseEvents,
} from "@/lib/functions/ai-response.function";
import type {
  AIResponseExecutionIdentityInput,
  AIResponseTerminalOutcome,
} from "../functions/ai-response-events.js";
import type { TYPE_PROVIDER } from "@/types";
import type { SelectedProviderState } from "./types.js";
import {
  buildResponseOpportunityPrompts,
  parseResponseOpportunityOutput,
  type ResponseOpportunityParseResult,
  type ResponseOpportunityRequest,
} from "./short-intent-gate.js";
import { getRuntimeInferenceOperationDefinition } from "./runtime-inference.js";
import { consumeRuntimeInferenceResponse } from "./runtime-inference-response.js";

const OPERATION = getRuntimeInferenceOperationDefinition(
  "response-opportunity-inference"
);

export interface ResponseOpportunityRequestResult {
  rawOutput: string;
  parsed: ResponseOpportunityParseResult;
  providerDisposition:
    | "completed-with-content"
    | "completed-empty"
    | "provider-error-content"
    | "provider-auth-error";
  parseDisposition: string;
  providerOutcome?: Readonly<AIResponseTerminalOutcome>;
  firstTokenAt?: number;
  completedAt: number;
}

export async function requestResponseOpportunity(input: {
  request: ResponseOpportunityRequest;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  signal: AbortSignal;
  executionIdentity?: AIResponseExecutionIdentityInput;
  onFirstToken?: (at: number) => void;
}): Promise<ResponseOpportunityRequestResult> {
  const prompts = buildResponseOpportunityPrompts(input.request);
  const responseEvents = fetchAIResponseEvents({
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
  const providerResponse = await consumeRuntimeInferenceResponse({
    responseEvents,
    signal: input.signal,
    operationLabel: "Response opportunity inference",
    onFirstToken: input.onFirstToken,
  });
  const { rawOutput, providerDisposition } = providerResponse;
  const parsed =
    providerDisposition === "completed-with-content"
      ? parseResponseOpportunityOutput(rawOutput, input.request)
      : ({
          ok: false,
          reason: providerDisposition,
          errorKind: "provider",
          evidenceSpansValid: false,
        } satisfies ResponseOpportunityParseResult);
  return {
    ...providerResponse,
    parsed,
    parseDisposition:
      providerDisposition === "completed-with-content"
        ? parsed.ok
          ? "valid-json"
          : parsed.reason
        : `not-run-${providerDisposition}`,
  };
}
