import { requestRuntimeInferenceResponse } from "./runtime-inference-request.js";
import type {
  AIResponseExecutionIdentityInput,
  AIResponseTerminalOutcome,
} from "../functions/ai-response-events.js";
import type { TYPE_PROVIDER } from "@/types";
import type { SelectedProviderState } from "./types.js";
import {
  buildMeetingMetadataInferencePrompts,
  parseMeetingMetadataInferenceOutput,
  type MeetingMetadataInferenceParseResult,
  type MeetingMetadataInferenceRequest,
} from "./meeting-metadata-inference.js";
import { getRuntimeInferenceOperationDefinition } from "./runtime-inference.js";

const OPERATION = getRuntimeInferenceOperationDefinition(
  "meeting-metadata-inference"
);

export interface MeetingMetadataInferenceRequestResult {
  rawOutput: string;
  parsed: MeetingMetadataInferenceParseResult;
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

export async function requestMeetingMetadataInference(input: {
  request: MeetingMetadataInferenceRequest;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  signal: AbortSignal;
  executionIdentity?: AIResponseExecutionIdentityInput;
  onFirstToken?: (at: number) => void;
}): Promise<MeetingMetadataInferenceRequestResult> {
  const prompts = buildMeetingMetadataInferencePrompts(input.request);
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
      sessionId:
        input.executionIdentity?.sessionId ?? input.request.sessionId,
      logicalQuestionUnitId:
        input.executionIdentity?.logicalQuestionUnitId ??
        `meeting-metadata:${input.request.sessionId}`,
      logicalQuestionRevision:
        input.executionIdentity?.logicalQuestionRevision ??
        input.request.operationRevision,
    },
    operationLabel: "Meeting metadata inference",
    onFirstToken: input.onFirstToken,
  });

  const { rawOutput, providerDisposition } = providerResponse;
  const parsed =
    providerDisposition === "completed-with-content"
      ? parseMeetingMetadataInferenceOutput(rawOutput, input.request)
      : ({
          ok: false,
          reason: providerDisposition,
          errorKind: "provider",
          evidenceSpansValid: false,
        } satisfies MeetingMetadataInferenceParseResult);
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
