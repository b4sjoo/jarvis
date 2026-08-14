export const MODEL_GENERATION_TELEMETRY_SCHEMA_VERSION = 1;
export const MEETING_ADVISOR_PROMPT_CONTRACT_VERSION =
  "meeting-advisor-prompt-v1";

export interface ModelGenerationIdentityInput {
  requestOrigin: "advisor" | "screen";
  providerId?: string;
  modelId?: string;
  modelRoute: string;
  streamingConfigured: boolean;
  requestOptions?: {
    timeoutMs?: number;
    maxOutputTokens?: number;
  };
  responseConfig?: {
    length?: string;
    language?: string;
  };
  promptContractId: string;
  promptContractVersion: string;
}

export interface ModelGenerationTimingInput {
  requestStartedAt?: number;
  firstContentAt?: number;
  firstVisiblePartialAt?: number;
  completedAt?: number;
  chunkCount: number;
}

export function buildModelGenerationIdentityForTrace(
  input: ModelGenerationIdentityInput
): Record<string, unknown> {
  const providerId = privacySafeIdentifier(input.providerId, "provider");
  const modelId = privacySafeIdentifier(input.modelId, "model");
  const fingerprint = hashStableValue(
    JSON.stringify([
      MODEL_GENERATION_TELEMETRY_SCHEMA_VERSION,
      input.requestOrigin,
      providerId,
      modelId,
      input.modelRoute,
      input.streamingConfigured,
      input.requestOptions?.timeoutMs ?? null,
      input.requestOptions?.maxOutputTokens ?? null,
      input.responseConfig?.length ?? null,
      input.responseConfig?.language ?? null,
      input.promptContractId,
      input.promptContractVersion,
    ])
  );

  return {
    modelGenerationTelemetryVersion:
      MODEL_GENERATION_TELEMETRY_SCHEMA_VERSION,
    modelGenerationRequestOrigin: input.requestOrigin,
    modelGenerationProviderId: providerId,
    modelGenerationModelId: modelId,
    modelGenerationRoute: input.modelRoute,
    modelGenerationStreamingConfigured: input.streamingConfigured,
    modelGenerationTimeoutMs: input.requestOptions?.timeoutMs,
    modelGenerationMaxOutputTokens:
      input.requestOptions?.maxOutputTokens,
    modelGenerationResponseLength: input.responseConfig?.length,
    modelGenerationResponseLanguage: input.responseConfig?.language,
    modelGenerationPromptContractId: input.promptContractId,
    modelGenerationPromptContractVersion: input.promptContractVersion,
    modelGenerationConfigFingerprint: fingerprint,
    modelGenerationTimingSemantics:
      "first-content-not-network-first-byte",
    modelGenerationNetworkFirstByteObservable: false,
  };
}

export function formatModelGenerationTimingForTrace(
  input: ModelGenerationTimingInput
): Record<string, unknown> {
  return {
    modelGenerationRequestStartedAt: input.requestStartedAt,
    modelGenerationFirstContentAt: input.firstContentAt,
    modelGenerationFirstVisiblePartialAt:
      input.firstVisiblePartialAt,
    modelGenerationCompletedAt: input.completedAt,
    modelGenerationChunkCount: input.chunkCount,
    modelGenerationFirstContentMs: elapsed(
      input.requestStartedAt,
      input.firstContentAt
    ),
    modelGenerationFirstVisiblePartialMs: elapsed(
      input.requestStartedAt,
      input.firstVisiblePartialAt
    ),
    modelGenerationDurationMs: elapsed(
      input.requestStartedAt,
      input.completedAt
    ),
  };
}

function elapsed(startedAt?: number, endedAt?: number) {
  if (startedAt === undefined || endedAt === undefined) return undefined;
  return Math.max(0, endedAt - startedAt);
}

function privacySafeIdentifier(
  value: string | undefined,
  prefix: string
) {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (
    normalized.length <= 128 &&
    /^[a-z0-9._:/-]+$/iu.test(normalized)
  ) {
    return normalized;
  }
  return `${prefix}-hash-${hashStableValue(normalized)}`;
}

function hashStableValue(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
