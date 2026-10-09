import { DECISIONS_MODEL, DECISIONS_PROVIDER_ID, readDecisionsProviderConfiguration, type DecisionsProviderSnapshot } from "../../config/decisions.constants.js";
import type { SelectedAiProviderConfig } from "../../types/provider.type.js";
import type { AIResponseExecutionIdentity, AIResponseExecutionIdentityInput } from "../functions/ai-response-events.js";
import { createMeetingId } from "./meeting-id.js";
import { createProviderConfigFingerprint } from "./meeting-model-route.js";
import { getRuntimeInferenceOperationDefinition, type RuntimeInferenceOperationKind, type RuntimeInferenceProviderTier } from "./runtime-inference.js";

export type RuntimeDecisionBackend = Readonly<{ kind: "existing" }> | Readonly<{
  kind: "decisions";
  configuration?: Readonly<DecisionsProviderSnapshot>;
  configurationError?: string;
  providerConfigFingerprint: string;
}>;

export const EXISTING_RUNTIME_DECISION_BACKEND: RuntimeDecisionBackend = Object.freeze({ kind: "existing" });

export function createDecisionsProviderFingerprint(configuration: Readonly<DecisionsProviderSnapshot> | undefined) {
  return createProviderConfigFingerprint({ provider: undefined, selectedProvider: {
    provider: DECISIONS_PROVIDER_ID,
    variables: { api_key: configuration?.apiKey ?? "", model: configuration?.modelId ?? DECISIONS_MODEL },
  } });
}

export function captureRuntimeDecisionBackend(enabled: boolean, selected: SelectedAiProviderConfig | undefined): RuntimeDecisionBackend {
  if (!enabled) return EXISTING_RUNTIME_DECISION_BACKEND;
  const { snapshot, error } = readDecisionsProviderConfiguration(selected);
  return Object.freeze({ kind: "decisions", configuration: snapshot, configurationError: error,
    providerConfigFingerprint: createDecisionsProviderFingerprint(snapshot) });
}

export function createDecisionsExecutionIdentity(input: AIResponseExecutionIdentityInput | undefined, question: {
  logicalQuestionUnitId: string; logicalQuestionRevision: number;
}): AIResponseExecutionIdentity {
  const requestId = input?.requestId ?? createMeetingId("decision_request");
  return { requestId, executionPlanId: input?.executionPlanId ?? requestId, modelId: DECISIONS_MODEL,
    sessionId: input?.sessionId ?? "unscoped", runtimeEpoch: input?.runtimeEpoch ?? 0,
    logicalQuestionUnitId: input?.logicalQuestionUnitId ?? question.logicalQuestionUnitId,
    logicalQuestionRevision: input?.logicalQuestionRevision ?? question.logicalQuestionRevision };
}

export function formatRuntimeDecisionBackendForTrace(backend: RuntimeDecisionBackend) {
  return backend.kind === "existing" ? { runtimeDecisionBackend: "existing" } : {
    runtimeDecisionBackend: "decisions", runtimeDecisionProviderId: DECISIONS_PROVIDER_ID,
    runtimeDecisionModelId: DECISIONS_MODEL, runtimeDecisionConfigurationAvailable: Boolean(backend.configuration),
    runtimeDecisionProviderConfigFingerprint: backend.providerConfigFingerprint,
    runtimeDecisionScorePolicy: "selected-probability-then-native-confidence",
  };
}

export function formatDecisionsModelRouteForTrace(backend: Extract<RuntimeDecisionBackend, { kind: "decisions" }>, operationKind: RuntimeInferenceOperationKind,
  providerTier: RuntimeInferenceProviderTier = getRuntimeInferenceOperationDefinition(operationKind).providerTier) {
  return { ...formatRuntimeDecisionBackendForTrace(backend), runtimeInferenceModelRoute: "decisions",
    runtimeInferenceModelRouteReason: "decisions-runtime-preview", runtimeInferenceOperationKind: operationKind,
    runtimeInferenceProviderTier: providerTier,
    runtimeInferenceProviderId: DECISIONS_PROVIDER_ID, runtimeInferenceProviderConfigFingerprint: backend.providerConfigFingerprint,
    runtimeInferenceProviderConfigurationStatus: backend.configuration ? "configured" : "configuration-error",
  };
}
