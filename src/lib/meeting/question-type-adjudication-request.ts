import { requestRuntimeInferenceResponse } from "./runtime-inference-request.js";
import type {
  AIResponseExecutionIdentityInput,
  AIResponseTerminalOutcome,
  AIResponseRetryPolicy,
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
  providerAttempts?: readonly Readonly<AIResponseTerminalOutcome>[];
  firstTokenAt?: number;
  completedAt: number;
  cacheHit?: boolean;
}

export async function requestQuestionTypeAdjudication(input: {
  request: QuestionTypeAdjudicationRequest;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  signal: AbortSignal;
  executionIdentity?: AIResponseExecutionIdentityInput;
  onFirstToken?: (at: number) => void;
  timeoutMs?: number;
  maxOutputTokens?: number;
  readRetryDeadlineAt?: () => number | undefined;
  isExecutionCurrent?: () => boolean;
}): Promise<QuestionTypeAdjudicationRequestResult> {
  const prompts = buildQuestionTypeAdjudicationPrompts(input.request);
  const retryEnabled = Boolean(input.readRetryDeadlineAt && input.request.reviewScope !== "field-vs-coding");
  const providerResponse = await requestRuntimeInferenceResponse({
    provider: input.provider,
    selectedProvider: input.selectedProvider,
    systemPrompt: prompts.systemPrompt,
    userMessage: prompts.userMessage,
    signal: input.signal,
    requestOptions: {
      timeoutMs: input.timeoutMs ?? OPERATION.timeoutMs,
      maxOutputTokens: input.maxOutputTokens ?? OPERATION.maxOutputTokens,
      isExecutionCurrent: input.isExecutionCurrent,
      ...(retryEnabled ? {
        retryPolicy: { maxAttempts: 2, retryableFailureClasses: ["transport", "provider-http"] } satisfies AIResponseRetryPolicy,
        readRetryDeadlineAt: input.readRetryDeadlineAt,
        retryCompletedOutput: (outcome: Readonly<AIResponseTerminalOutcome>) => {
          const parsedAttempt = parseQuestionTypeAdjudicationOutput(outcome.text ?? "", input.request);
          return !parsedAttempt.ok && (parsedAttempt.errorKind === "parse" || parsedAttempt.errorKind === "schema");
        },
      } : {}),
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
