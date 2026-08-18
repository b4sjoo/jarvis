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
  buildQuestionTypeAdjudicationPrompts,
  parseQuestionTypeAdjudicationOutput,
  type QuestionTypeAdjudicationParseResult,
  type QuestionTypeAdjudicationRequest,
} from "./question-type-adjudication.js";
import { getRuntimeInferenceOperationDefinition } from "./runtime-inference.js";
import { consumeRuntimeInferenceResponse } from "./runtime-inference-response.js";

const OPERATION = getRuntimeInferenceOperationDefinition(
  "question-type-adjudication"
);

export interface QuestionTypeAdjudicationRequestResult {
  rawOutput: string;
  parsed: QuestionTypeAdjudicationParseResult;
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

export async function requestQuestionTypeAdjudication(input: {
  request: QuestionTypeAdjudicationRequest;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  signal: AbortSignal;
  executionIdentity?: AIResponseExecutionIdentityInput;
  onFirstToken?: (at: number) => void;
}): Promise<QuestionTypeAdjudicationRequestResult> {
  const prompts = buildQuestionTypeAdjudicationPrompts(input.request);
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
    operationLabel: "Question type adjudication",
    onFirstToken: input.onFirstToken,
  });
  const { rawOutput, providerDisposition } = providerResponse;
  const parsed =
    providerDisposition === "completed-with-content"
      ? parseQuestionTypeAdjudicationOutput(
          rawOutput,
          input.request
        )
      : ({
          ok: false,
          reason: providerDisposition,
          errorKind: "provider",
          evidenceSpansValid: false,
        } satisfies QuestionTypeAdjudicationParseResult);
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
