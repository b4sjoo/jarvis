import { fetchAIResponseEvents } from "@/lib/functions/ai-response.function";
import type { TYPE_PROVIDER } from "@/types";
import type {
  AIResponseExecutionIdentityInput,
  AIResponseTerminalOutcome,
} from "../functions/ai-response-events.js";
import {
  buildAnswerRecoveryAdjudicationPrompts,
  isAnswerRecoveryOutputTruncated,
  parseAnswerRecoveryAdjudicationOutput,
  type AnswerRecoveryAdjudicationParseResult,
  type AnswerRecoveryAdjudicationRequest,
} from "./answer-recovery-adjudication.js";
import { getRuntimeInferenceOperationDefinition } from "./runtime-inference.js";
import { consumeRuntimeInferenceResponse } from "./runtime-inference-response.js";
import type { SelectedProviderState } from "./types.js";

export interface AnswerRecoveryAdjudicationRequestResult {
  rawOutput: string;
  parsed: AnswerRecoveryAdjudicationParseResult;
  providerDisposition:
    | "completed-with-content"
    | "completed-empty"
    | "provider-error-content"
    | "provider-auth-error";
  parseDisposition: string;
  outputTruncated: boolean;
  providerOutcome?: Readonly<AIResponseTerminalOutcome>;
  firstTokenAt?: number;
  completedAt: number;
}

export async function requestAnswerRecoveryAdjudication(input: {
  request: AnswerRecoveryAdjudicationRequest;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  signal: AbortSignal;
  executionIdentity?: AIResponseExecutionIdentityInput;
  onFirstToken?: (at: number) => void;
}): Promise<AnswerRecoveryAdjudicationRequestResult> {
  const operation = getRuntimeInferenceOperationDefinition(
    input.request.operationKind
  );
  const prompts = buildAnswerRecoveryAdjudicationPrompts(input.request);
  const responseEvents = fetchAIResponseEvents({
    provider: input.provider,
    selectedProvider: input.selectedProvider,
    systemPrompt: prompts.systemPrompt,
    userMessage: prompts.userMessage,
    signal: input.signal,
    applyResponseSettings: false,
    requestOptions: {
      timeoutMs: operation.timeoutMs,
      maxOutputTokens: operation.maxOutputTokens,
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
    operationLabel:
      input.request.operationKind === "answer-resolution"
        ? "Answer resolution adjudication"
        : "Evidence requirement adjudication",
    onFirstToken: input.onFirstToken,
  });
  const { rawOutput, providerDisposition } = providerResponse;
  const outputTruncated =
    providerDisposition === "completed-with-content" &&
    isAnswerRecoveryOutputTruncated(rawOutput);
  const parsed =
    outputTruncated
      ? ({
          ok: false,
          reason: "output-truncated",
          errorKind: "parse",
          evidenceSpansValid: false,
        } satisfies AnswerRecoveryAdjudicationParseResult)
      : providerDisposition === "completed-with-content"
      ? parseAnswerRecoveryAdjudicationOutput(rawOutput, input.request)
      : ({
          ok: false,
          reason: providerDisposition,
          errorKind: "provider",
          evidenceSpansValid: false,
        } satisfies AnswerRecoveryAdjudicationParseResult);
  return {
    ...providerResponse,
    parsed,
    outputTruncated,
    parseDisposition:
      outputTruncated
        ? "output-truncated"
        : providerDisposition === "completed-with-content"
        ? parsed.ok
          ? "valid-json"
          : parsed.reason
        : `not-run-${providerDisposition}`,
  };
}
