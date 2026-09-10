import {
  fetchAIResponseEvents,
  type AIResponseParams,
} from "../functions/ai-response.function.js";
import {
  consumeRuntimeInferenceResponse,
  type RuntimeInferenceProviderResponse,
} from "./runtime-inference-response.js";

export type RuntimeInferenceRequest = Omit<
  AIResponseParams,
  "applyResponseSettings" | "signal"
> & {
  signal: AbortSignal;
  operationLabel: string;
  onFirstToken?: (at: number) => void;
  maxOutputChars?: number;
};

export function requestRuntimeInferenceResponse(
  input: RuntimeInferenceRequest
): Promise<RuntimeInferenceProviderResponse> {
  const { operationLabel, onFirstToken, maxOutputChars, ...request } = input;
  return consumeRuntimeInferenceResponse({
    responseEvents: fetchAIResponseEvents({
      ...request,
      applyResponseSettings: false,
    }),
    signal: request.signal,
    operationLabel,
    onFirstToken,
    maxOutputChars,
  });
}
