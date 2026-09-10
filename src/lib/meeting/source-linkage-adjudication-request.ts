import { requestRuntimeInferenceResponse } from "./runtime-inference-request.js";
import type { TYPE_PROVIDER } from "@/types";
import type {
  AIResponseExecutionIdentityInput,
  AIResponseTerminalOutcome,
} from "../functions/ai-response-events.js";
import { getRuntimeInferenceOperationDefinition } from "./runtime-inference.js";

import {
  buildSourceLinkageAdjudicationPrompts,
  parseSourceLinkageAdjudicationOutput,
  type SourceLinkageAdjudicationParseResult,
  type SourceLinkageAdjudicationRequest,
} from "./source-linkage-adjudication.js";
import type { SelectedProviderState } from "./types.js";

const OPERATION = getRuntimeInferenceOperationDefinition(
  "source-linkage-adjudication"
);

export interface SourceLinkageAdjudicationRequestResult {
  rawOutput: string;
  parsed: SourceLinkageAdjudicationParseResult;
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

export async function requestSourceLinkageAdjudication(input: {
  request: SourceLinkageAdjudicationRequest;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  signal: AbortSignal;
  executionIdentity?: AIResponseExecutionIdentityInput;
  onFirstToken?: (at: number) => void;
}): Promise<SourceLinkageAdjudicationRequestResult> {
  const prompts = buildSourceLinkageAdjudicationPrompts(input.request);
  const providerResponse = await requestRuntimeInferenceResponse({
    provider: input.provider,
    selectedProvider: input.selectedProvider,
    systemPrompt: prompts.systemPrompt,
    userMessage: prompts.userMessage,
    signal: input.signal,
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
    operationLabel: "Source linkage adjudication",
    onFirstToken: input.onFirstToken,
  });

  const { rawOutput, providerDisposition } = providerResponse;
  const parsed =
    providerDisposition === "completed-with-content"
      ? parseSourceLinkageAdjudicationOutput(rawOutput, input.request)
      : ({
          ok: false,
          reason: providerDisposition,
          errorKind: "provider",
          evidenceSpansValid: false,
        } satisfies SourceLinkageAdjudicationParseResult);
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
