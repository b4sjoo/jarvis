import { requestRuntimeInferenceResponse } from "./runtime-inference-request.js";
import type { AIResponseExecutionIdentityInput } from "../functions/ai-response-events.js";
import type { TYPE_PROVIDER } from "@/types";
import type { SelectedProviderState } from "./types.js";
import {
  buildWhiteboardSyntaxRepairPrompts,
  parseWhiteboardSyntaxRepairOutput,
  WHITEBOARD_SYNTAX_REPAIR_MAX_RAW_OUTPUT_CHARS,
  type WhiteboardSyntaxRepairParseResult,
  type WhiteboardSyntaxRepairRequest,
  type WhiteboardSyntaxRepairRequestResult,
} from "./whiteboard-syntax-repair.js";
import { getRuntimeInferenceOperationDefinition } from "./runtime-inference.js";

const WHITEBOARD_REPAIR_OPERATION =
  getRuntimeInferenceOperationDefinition("whiteboard-syntax-repair");

export async function requestWhiteboardSyntaxRepair(input: {
  request: WhiteboardSyntaxRepairRequest;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  signal: AbortSignal;
  executionIdentity?: AIResponseExecutionIdentityInput;
  onFirstToken?: (at: number) => void;
}): Promise<WhiteboardSyntaxRepairRequestResult> {
  const prompts = buildWhiteboardSyntaxRepairPrompts(input.request);
  const providerResponse = await requestRuntimeInferenceResponse({
    provider: input.provider,
    selectedProvider: input.selectedProvider,
    systemPrompt: prompts.systemPrompt,
    userMessage: prompts.userMessage,
    signal: input.signal,
    requestOptions: {
      timeoutMs: WHITEBOARD_REPAIR_OPERATION.timeoutMs,
      maxOutputTokens: WHITEBOARD_REPAIR_OPERATION.maxOutputTokens,
    },
    executionIdentity: input.executionIdentity,
    operationLabel: "Whiteboard syntax repair",
    onFirstToken: input.onFirstToken,
    maxOutputChars: WHITEBOARD_SYNTAX_REPAIR_MAX_RAW_OUTPUT_CHARS,
  });

  const { rawOutput, providerDisposition } = providerResponse;
  const parsed =
    providerDisposition === "completed-with-content"
      ? parseWhiteboardSyntaxRepairOutput(rawOutput, input.request)
      : ({
          ok: false,
          reason:
            providerDisposition === "completed-empty"
              ? "empty-output"
              : "non-json-output",
        } satisfies WhiteboardSyntaxRepairParseResult);
  return {
    ...providerResponse,
    parsed,
    parseDisposition: parsed.ok
      ? "valid-json"
      : providerDisposition === "completed-with-content"
        ? parsed.reason
        : `not-run-${providerDisposition}`,
  };
}
