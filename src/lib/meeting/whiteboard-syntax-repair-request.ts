import { fetchAIResponse } from "@/lib/functions/ai-response.function";
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
import { classifyTaxonomyAdjudicationProviderOutput } from "./taxonomy-adjudication-response.js";
import { getRuntimeInferenceOperationDefinition } from "./runtime-inference.js";

const WHITEBOARD_REPAIR_OPERATION =
  getRuntimeInferenceOperationDefinition("whiteboard-syntax-repair");

export async function requestWhiteboardSyntaxRepair(input: {
  request: WhiteboardSyntaxRepairRequest;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  signal: AbortSignal;
  onFirstToken?: (at: number) => void;
}): Promise<WhiteboardSyntaxRepairRequestResult> {
  const prompts = buildWhiteboardSyntaxRepairPrompts(input.request);
  const responseStream = fetchAIResponse({
    provider: input.provider,
    selectedProvider: input.selectedProvider,
    systemPrompt: prompts.systemPrompt,
    userMessage: prompts.userMessage,
    signal: input.signal,
    applyResponseSettings: false,
    requestOptions: {
      timeoutMs: WHITEBOARD_REPAIR_OPERATION.timeoutMs,
      maxOutputTokens: WHITEBOARD_REPAIR_OPERATION.maxOutputTokens,
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
    if (rawOutput.length > WHITEBOARD_SYNTAX_REPAIR_MAX_RAW_OUTPUT_CHARS) {
      throw new Error("Whiteboard syntax repair output exceeded limit");
    }
  }
  if (input.signal.aborted) {
    throw new DOMException("Whiteboard syntax repair aborted", "AbortError");
  }

  const providerDisposition =
    classifyTaxonomyAdjudicationProviderOutput(rawOutput);
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
    rawOutput,
    parsed,
    providerDisposition,
    parseDisposition: parsed.ok
      ? "valid-json"
      : providerDisposition === "completed-with-content"
        ? parsed.reason
        : `not-run-${providerDisposition}`,
    firstTokenAt,
    completedAt: Date.now(),
  };
}
