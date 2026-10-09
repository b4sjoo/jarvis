import type { TYPE_PROVIDER } from "../../types/provider.type.js";
import type { AIResponseExecutionIdentityInput } from "../functions/ai-response-events.js";
import type { SelectedProviderState } from "./types.js";
import type { RuntimeInferenceProviderAdmissionCoordinator, RuntimeInferenceSharedAdmissionReceipt } from "./runtime-inference-provider-admission.js";
import type { RuntimeInferenceLane } from "./runtime-inference.js";
import { createProviderConfigFingerprint } from "./meeting-model-route.js";
import { requestRuntimeInferenceResponse } from "./runtime-inference-request.js";
import { runDecisionProviderRequest } from "./decision-provider-request.js";
import { formatRuntimeInferenceProviderOutcomeForTrace, type RuntimeInferenceProviderResponse } from "./runtime-inference-response.js";

export async function requestDecisionsEvidence(input: {
  provider?: TYPE_PROVIDER; selectedProvider: SelectedProviderState;
  systemPrompt: string; userMessage: string; maxOutputTokens: number;
  deadlineAt: number; signal: AbortSignal;
  admission: RuntimeInferenceProviderAdmissionCoordinator; lane: RuntimeInferenceLane;
  executionIdentity: AIResponseExecutionIdentityInput & { requestId: string };
  prefix: string;
  onRequest?: (at: number) => void;
  onAdmitted?: (receipt: RuntimeInferenceSharedAdmissionReceipt) => void;
}): Promise<{ response?: RuntimeInferenceProviderResponse; metadata: Record<string, unknown> }> {
  const { prefix } = input;
  const metadata: Record<string, unknown> = { [`${prefix}Requested`]: false, [`${prefix}DeadlineAt`]: input.deadlineAt };
  input.signal.throwIfAborted();
  if (!input.provider || Date.now() >= input.deadlineAt) {
    return { metadata: { ...metadata, [`${prefix}Disposition`]: input.provider ? "no-remaining-budget" : "provider-unavailable" } };
  }
  const fingerprint = createProviderConfigFingerprint({ provider: input.provider, selectedProvider: input.selectedProvider });
  try {
    const response = await runDecisionProviderRequest({
      operationId: input.executionIdentity.requestId, providerTier: "fast", lane: input.lane,
      providerConfigFingerprint: fingerprint, admission: input.admission, signal: input.signal, deadlineAt: input.deadlineAt,
      onAdmitted: receipt => {
        metadata[`${prefix}QueueWaitMs`] = receipt.waitMs;metadata[`${prefix}ProviderGroupKey`] = receipt.providerGroupKey;
        input.onAdmitted?.(receipt);
      },
      execute: signal => {
        metadata[`${prefix}Requested`] = true;
        metadata[`${prefix}AttemptStartedAt`] = Date.now();
        metadata[`${prefix}SystemPrompt`] = input.systemPrompt;
        metadata[`${prefix}ModelInput`] = input.userMessage;
        metadata[`${prefix}MaxOutputTokens`] = input.maxOutputTokens;
        input.onRequest?.(Date.now());
        return requestRuntimeInferenceResponse({ provider: input.provider, selectedProvider: input.selectedProvider,
          systemPrompt: input.systemPrompt, userMessage: input.userMessage, signal,
          executionIdentity: { ...input.executionIdentity, modelId: undefined },
          operationLabel: "Decision evidence extraction",
          requestOptions: { timeoutMs: Math.max(1, input.deadlineAt - Date.now()), maxOutputTokens: input.maxOutputTokens },
        });
      },
    });
    return { response, metadata: { ...metadata, ...formatRuntimeInferenceProviderOutcomeForTrace(response?.providerOutcome, prefix),
      [`${prefix}ModelId`]: response?.providerOutcome.modelId, [`${prefix}ProviderId`]: response?.providerOutcome.providerId,
      [`${prefix}Disposition`]: response?.providerDisposition ?? "deadline", [`${prefix}RawOutput`]: response?.rawOutput,
      [`${prefix}CompletedAt`]: Date.now(), [`${prefix}FirstTokenAt`]: response?.firstTokenAt } };
  } catch (error) {
    input.signal.throwIfAborted();
    return { metadata: { ...metadata, [`${prefix}Disposition`]: "extraction-error", [`${prefix}CompletedAt`]: Date.now(),
      [`${prefix}ErrorKind`]: error instanceof Error ? error.name : "unknown" } };
  }
}
