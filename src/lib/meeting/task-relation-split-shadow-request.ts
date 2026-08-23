import { fetchAIResponseEvents } from "@/lib/functions/ai-response.function";
import type { TYPE_PROVIDER } from "@/types";
import type {
  AIResponseExecutionIdentityInput,
  AIResponseTerminalOutcome,
} from "../functions/ai-response-events.js";
import { getRuntimeInferenceOperationDefinition } from "./runtime-inference.js";
import { consumeRuntimeInferenceResponse } from "./runtime-inference-response.js";
import {
  buildTaskRelationAffinityPrompts,
  buildTaskRelationCanonicalShadowPrompts,
  hashTaskRelationSplitOutput,
  parseTaskRelationAffinityOutput,
  parseTaskRelationCanonicalShadowOutput,
  type TaskRelationAffinityParseResult,
  type TaskRelationAffinityRequest,
  type TaskRelationCanonicalShadowParseResult,
  type TaskRelationCanonicalShadowRequest,
} from "./task-relation-split-shadow.js";
import type { SelectedProviderState } from "./types.js";

export type TaskRelationSplitShadowParseResult =
  | TaskRelationAffinityParseResult
  | TaskRelationCanonicalShadowParseResult;

export interface TaskRelationSplitShadowRequestResult {
  rawOutput: string;
  outputHash?: string;
  parsed: TaskRelationSplitShadowParseResult;
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

export async function requestTaskRelationSplitShadow(input: {
  request: TaskRelationAffinityRequest | TaskRelationCanonicalShadowRequest;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  signal: AbortSignal;
  executionIdentity?: AIResponseExecutionIdentityInput;
  onFirstToken?: (at: number) => void;
}): Promise<TaskRelationSplitShadowRequestResult> {
  const prompts =
    input.request.operationKind === "task-relation-canonical-shadow"
      ? buildTaskRelationCanonicalShadowPrompts(input.request)
      : buildTaskRelationAffinityPrompts(input.request);
  const operation = getRuntimeInferenceOperationDefinition(
    input.request.operationKind
  );
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
        input.request.identity.logicalQuestionUnitId,
      logicalQuestionRevision:
        input.executionIdentity?.logicalQuestionRevision ??
        input.request.identity.logicalQuestionUnitRevision,
    },
  });
  const providerResponse = await consumeRuntimeInferenceResponse({
    responseEvents,
    signal: input.signal,
    operationLabel: input.request.operationKind,
    onFirstToken: input.onFirstToken,
  });
  const { rawOutput, providerDisposition } = providerResponse;
  const parsed =
    providerDisposition === "completed-with-content"
      ? input.request.operationKind === "task-relation-canonical-shadow"
        ? parseTaskRelationCanonicalShadowOutput(rawOutput, input.request)
        : parseTaskRelationAffinityOutput(rawOutput, input.request)
      : ({
          ok: false,
          reason: providerDisposition,
          errorKind: "provider",
          evidenceSpansValid: false,
        } satisfies TaskRelationSplitShadowParseResult);
  return {
    ...providerResponse,
    parsed,
    outputHash: rawOutput
      ? hashTaskRelationSplitOutput(rawOutput)
      : undefined,
    parseDisposition:
      providerDisposition === "completed-with-content"
        ? parsed.ok
          ? "valid-json"
          : parsed.reason
        : `not-run-${providerDisposition}`,
  };
}
