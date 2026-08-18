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
  buildTaskRelationAdjudicationPrompts,
  parseTaskRelationAdjudicationOutput,
  type TaskRelationAdjudicationParseResult,
  type TaskRelationAdjudicationRequest,
} from "./task-relation-adjudication.js";
import { getRuntimeInferenceOperationDefinition } from "./runtime-inference.js";
import { consumeRuntimeInferenceResponse } from "./runtime-inference-response.js";

const OPERATION = getRuntimeInferenceOperationDefinition(
  "task-relation-adjudication"
);

export interface TaskRelationAdjudicationRequestResult {
  rawOutput: string;
  parsed: TaskRelationAdjudicationParseResult;
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

export async function requestTaskRelationAdjudication(input: {
  request: TaskRelationAdjudicationRequest;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  signal: AbortSignal;
  executionIdentity?: AIResponseExecutionIdentityInput;
  onFirstToken?: (at: number) => void;
}): Promise<TaskRelationAdjudicationRequestResult> {
  const prompts = buildTaskRelationAdjudicationPrompts(input.request);
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
      executionPlanId:
        input.executionIdentity?.executionPlanId ??
        `${input.request.activeParent.parentId}:revision:${input.request.activeParent.revision}`,
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
    operationLabel: "Task relation adjudication",
    onFirstToken: input.onFirstToken,
  });
  const { rawOutput, providerDisposition } = providerResponse;
  const parsed =
    providerDisposition === "completed-with-content"
      ? parseTaskRelationAdjudicationOutput(
          rawOutput,
          input.request
        )
      : ({
          ok: false,
          reason: providerDisposition,
          errorKind: "provider",
          evidenceSpansValid: false,
        } satisfies TaskRelationAdjudicationParseResult);
  return {
    ...providerResponse,
    parsed,
    parseDisposition:
      providerDisposition === "completed-with-content"
        ? parsed.ok
          ? parsed.schemaAliasApplied
            ? "valid-json-schema-alias"
            : "valid-json"
          : parsed.reason
        : `not-run-${providerDisposition}`,
  };
}
