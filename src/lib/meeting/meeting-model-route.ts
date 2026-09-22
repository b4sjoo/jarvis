import type { TYPE_PROVIDER } from "@/types";
import type {
  EffectiveInterviewTaskRelation,
  SelectedProviderState,
} from "./types";
import {
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import {
  getRuntimeInferenceOperationDefinition,
  type RuntimeInferenceOperationKind,
  type RuntimeInferenceProviderTier,
} from "./runtime-inference.js";

export interface MeetingModelRouteResolution {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  route: "main" | "coding-override";
  reason: string;
  fallbackReason?: string;
  mainProviderId?: string;
  codingProviderId?: string;
  resolvedProviderId?: string;
  resolutionSource: "execution-snapshot";
}

export interface MeetingModelProviderSnapshot {
  providers: TYPE_PROVIDER[];
  selectedProvider: SelectedProviderState;
  codingProvider: SelectedProviderState;
  taxonomyAdjudicationProvider?: SelectedProviderState;
}

export interface TaxonomyAdjudicationModelRouteResolution {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  route: "main" | "taxonomy-adjudication-override";
  reason: string;
  fallbackReason?: string;
  mainProviderId?: string;
  taxonomyAdjudicationProviderId?: string;
  resolvedProviderId?: string;
  resolutionSource: "execution-snapshot";
  configurationStatus:
    | "ready"
    | "inherited-main-variables"
    | "provider-not-configured"
    | "provider-not-found"
    | "missing-required-variables";
  inheritedVariableKeys: string[];
  missingRequiredVariables: string[];
}

export interface RuntimeInferenceModelRouteResolution {
  operationKind: RuntimeInferenceOperationKind;
  providerTier: RuntimeInferenceProviderTier;
  configFingerprint: string;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  route: "main" | "runtime-inference-override";
  reason: string;
  fallbackReason?: string;
  mainProviderId?: string;
  runtimeInferenceProviderId?: string;
  resolvedProviderId?: string;
  resolutionSource: "execution-snapshot";
  configurationStatus:
    | "ready"
    | "inherited-main-variables"
    | "provider-not-configured"
    | "provider-not-found"
    | "missing-required-variables";
  inheritedVariableKeys: string[];
  missingRequiredVariables: string[];
}

export type MeetingResponseOwnerSource =
  | "committed-parent"
  | "authorized-child"
  | "active-child-preserved"
  | "canonical-parent"
  | "current-question"
  | "transient-personal-status";

export interface MeetingResponseOwnerResolution {
  questionType: CanonicalQuestionType;
  source: MeetingResponseOwnerSource;
  preBoundaryType?: CanonicalQuestionType;
  committedType?: CanonicalQuestionType;
  relation: EffectiveInterviewTaskRelation;
}

export function resolveMeetingResponseOwner(input: {
  preBoundaryType?: unknown;
  postBoundaryParentType?: unknown;
  activeChildType?: unknown;
  proposedQuestionType?: unknown;
  relation: EffectiveInterviewTaskRelation;
  taskBoundaryCommitted: boolean;
  childOwnsResponse: boolean;
}): MeetingResponseOwnerResolution {
  const preBoundaryType =
    normalizeCanonicalQuestionType(input.preBoundaryType) ?? undefined;
  const postBoundaryParentType =
    normalizeCanonicalQuestionType(input.postBoundaryParentType) ?? undefined;
  const proposedQuestionType =
    normalizeCanonicalQuestionType(input.proposedQuestionType) ?? "unknown";
  const activeChildType =
    normalizeCanonicalQuestionType(input.activeChildType) ?? undefined;

  if (input.taskBoundaryCommitted && postBoundaryParentType && input.relation !== "none") {
    return {
      questionType: postBoundaryParentType,
      source: "committed-parent",
      preBoundaryType,
      committedType: postBoundaryParentType,
      relation: input.relation,
    };
  }

  if (input.relation === "child-probe" && proposedQuestionType !== "unknown") {
    return {
      questionType: proposedQuestionType,
      source: input.childOwnsResponse ? "authorized-child" : "current-question",
      preBoundaryType,
      relation: input.relation,
    };
  }

  if (
    postBoundaryParentType &&
    (input.relation === "followup-parent" ||
      input.relation === "resume-parent") &&
    (proposedQuestionType === "unknown" ||
      postBoundaryParentType === proposedQuestionType)
  ) {
    return {
      questionType: postBoundaryParentType,
      source: "canonical-parent",
      preBoundaryType,
      relation: input.relation,
    };
  }

  return {
    questionType:
      proposedQuestionType !== "unknown"
        ? proposedQuestionType
        : input.relation === "child-probe"
          ? activeChildType ?? "unknown"
          : "unknown",
    source: "current-question",
    preBoundaryType,
    relation: input.relation,
  };
}

export function formatMeetingResponseOwnerForTrace(
  resolution: MeetingResponseOwnerResolution
) {
  return {
    responseOwnerQuestionType: resolution.questionType,
    responseOwnerSource: resolution.source,
    responseOwnerPreBoundaryType: resolution.preBoundaryType,
    responseOwnerCommittedType: resolution.committedType,
    responseOwnerTaskRelation: resolution.relation,
  };
}

export function resolveMeetingModelRouteFromSnapshot({
  snapshot,
  useCodingModel,
  requiresVision = false,
  reason,
}: {
  snapshot: MeetingModelProviderSnapshot;
  useCodingModel: boolean;
  requiresVision?: boolean;
  reason: string;
}): MeetingModelRouteResolution {
  const mainProvider = snapshot.providers.find(
    (candidate) => candidate.id === snapshot.selectedProvider.provider
  );
  const codingProvider = snapshot.providers.find(
    (candidate) => candidate.id === snapshot.codingProvider.provider
  );
  const mainRoute: MeetingModelRouteResolution = {
    provider: mainProvider,
    selectedProvider: snapshot.selectedProvider,
    route: "main",
    reason,
    mainProviderId: mainProvider?.id,
    codingProviderId: snapshot.codingProvider.provider || undefined,
    resolvedProviderId: mainProvider?.id,
    resolutionSource: "execution-snapshot",
  };

  if (!useCodingModel) return mainRoute;

  if (!snapshot.codingProvider.provider) {
    return {
      ...mainRoute,
      fallbackReason: "coding-provider-not-configured",
    };
  }

  if (!codingProvider) {
    return {
      ...mainRoute,
      fallbackReason: "coding-provider-not-found",
    };
  }

  if (requiresVision && !codingProvider.curl.includes("{{IMAGE}}")) {
    return {
      ...mainRoute,
      fallbackReason: "coding-provider-no-vision",
      codingProviderId: codingProvider.id,
    };
  }

  return {
    provider: codingProvider,
    selectedProvider: snapshot.codingProvider,
    route: "coding-override",
    reason,
    mainProviderId: mainProvider?.id,
    codingProviderId: codingProvider.id,
    resolvedProviderId: codingProvider.id,
    resolutionSource: "execution-snapshot",
  };
}

export function formatMeetingModelRouteForTrace(
  route: MeetingModelRouteResolution
) {
  return {
    modelRoute: route.route,
    modelRouteReason: route.reason,
    modelRouteFallbackReason: route.fallbackReason,
    modelRouteResolutionSource: route.resolutionSource,
    resolvedProviderId: route.resolvedProviderId,
    mainProviderId: route.mainProviderId,
    codingProviderId: route.codingProviderId,
  };
}

export function resolveManualCorrectionRegenerationRoute({
  snapshot,
  correctedType,
}: {
  snapshot: MeetingModelProviderSnapshot;
  correctedType: CanonicalQuestionType;
}) {
  const useCodingModel = correctedType === "coding";
  return resolveMeetingModelRouteFromSnapshot({
    snapshot,
    useCodingModel,
    reason: useCodingModel
      ? "manual-correction-coding-task"
      : "manual-correction-main",
  });
}

export function resolveTaxonomyAdjudicationModelRouteFromSnapshot({
  snapshot,
  reason = "taxonomy-adjudication-shadow",
}: {
  snapshot: MeetingModelProviderSnapshot;
  reason?: string;
}): TaxonomyAdjudicationModelRouteResolution {
  const mainProvider = snapshot.providers.find(
    (candidate) => candidate.id === snapshot.selectedProvider.provider
  );
  const override = snapshot.taxonomyAdjudicationProvider;
  const mainReadiness = resolveProviderVariableReadiness(
    mainProvider,
    snapshot.selectedProvider
  );
  const mainRoute: TaxonomyAdjudicationModelRouteResolution = {
    provider: mainReadiness.ready ? mainProvider : undefined,
    selectedProvider: snapshot.selectedProvider,
    route: "main",
    reason,
    mainProviderId: mainProvider?.id,
    taxonomyAdjudicationProviderId: override?.provider || undefined,
    resolvedProviderId: mainReadiness.ready ? mainProvider?.id : undefined,
    resolutionSource: "execution-snapshot",
    configurationStatus: mainReadiness.ready
      ? "ready"
      : "missing-required-variables",
    inheritedVariableKeys: [],
    missingRequiredVariables: mainReadiness.missingRequiredVariables,
  };
  if (!override?.provider) {
    return {
      ...mainRoute,
      configurationStatus: mainReadiness.ready
        ? "provider-not-configured"
        : "missing-required-variables",
      fallbackReason: "taxonomy-provider-not-configured",
    };
  }
  const provider = snapshot.providers.find(
    (candidate) => candidate.id === override.provider
  );
  if (!provider) {
    return {
      ...mainRoute,
      configurationStatus: "provider-not-found",
      fallbackReason: "taxonomy-provider-not-found",
    };
  }
  const inherited = inheritMainProviderVariables({
    mainProviderId: snapshot.selectedProvider.provider,
    override,
    mainSelectedProvider: snapshot.selectedProvider,
  });
  const readiness = resolveProviderVariableReadiness(
    provider,
    inherited.selectedProvider
  );
  if (!readiness.ready) {
    return {
      ...mainRoute,
      provider: undefined,
      selectedProvider: inherited.selectedProvider,
      route: "taxonomy-adjudication-override",
      taxonomyAdjudicationProviderId: provider.id,
      resolvedProviderId: undefined,
      configurationStatus: "missing-required-variables",
      inheritedVariableKeys: inherited.inheritedVariableKeys,
      missingRequiredVariables: readiness.missingRequiredVariables,
      fallbackReason: "taxonomy-provider-missing-required-variables",
    };
  }
  return {
    provider,
    selectedProvider: inherited.selectedProvider,
    route: "taxonomy-adjudication-override",
    reason,
    mainProviderId: mainProvider?.id,
    taxonomyAdjudicationProviderId: provider.id,
    resolvedProviderId: provider.id,
    resolutionSource: "execution-snapshot",
    configurationStatus: inherited.inheritedVariableKeys.length
      ? "inherited-main-variables"
      : "ready",
    inheritedVariableKeys: inherited.inheritedVariableKeys,
    missingRequiredVariables: [],
  };
}

export function resolveRuntimeInferenceModelRouteFromSnapshot({
  snapshot,
  operationKind,
  providerTier: providerTierOverride,
  reason = `runtime-inference-${operationKind}`,
}: {
  snapshot: MeetingModelProviderSnapshot;
  operationKind: RuntimeInferenceOperationKind;
  providerTier?: RuntimeInferenceProviderTier;
  reason?: string;
}): RuntimeInferenceModelRouteResolution {
  const providerTier = providerTierOverride ?? getRuntimeInferenceOperationDefinition(
    operationKind
  ).providerTier;
  if (providerTier === "intelligent") {
    const mainProvider = snapshot.providers.find(
      (candidate) => candidate.id === snapshot.selectedProvider.provider
    );
    const readiness = resolveProviderVariableReadiness(
      mainProvider,
      snapshot.selectedProvider
    );
    return {
      operationKind,
      providerTier,
      configFingerprint: createProviderConfigFingerprint({
        provider: mainProvider,
        selectedProvider: snapshot.selectedProvider,
      }),
      provider: readiness.ready ? mainProvider : undefined,
      selectedProvider: snapshot.selectedProvider,
      route: "main",
      reason,
      fallbackReason: readiness.ready
        ? undefined
        : "main-provider-missing-required-variables",
      mainProviderId: mainProvider?.id,
      resolvedProviderId: readiness.ready ? mainProvider?.id : undefined,
      resolutionSource: "execution-snapshot",
      configurationStatus: readiness.ready
        ? "ready"
        : mainProvider
          ? "missing-required-variables"
          : "provider-not-found",
      inheritedVariableKeys: [],
      missingRequiredVariables: readiness.missingRequiredVariables,
    };
  }
  const taxonomyRoute =
    resolveTaxonomyAdjudicationModelRouteFromSnapshot({
      snapshot,
      reason,
    });
  return {
    operationKind,
    providerTier,
    configFingerprint: createProviderConfigFingerprint({
      provider: taxonomyRoute.provider,
      selectedProvider: taxonomyRoute.selectedProvider,
    }),
    provider: taxonomyRoute.provider,
    selectedProvider: taxonomyRoute.selectedProvider,
    route:
      taxonomyRoute.route === "taxonomy-adjudication-override"
        ? "runtime-inference-override"
        : "main",
    reason: taxonomyRoute.reason,
    fallbackReason: normalizeRuntimeInferenceFallbackReason(
      taxonomyRoute.fallbackReason
    ),
    mainProviderId: taxonomyRoute.mainProviderId,
    runtimeInferenceProviderId:
      taxonomyRoute.taxonomyAdjudicationProviderId,
    resolvedProviderId: taxonomyRoute.resolvedProviderId,
    resolutionSource: taxonomyRoute.resolutionSource,
    configurationStatus: taxonomyRoute.configurationStatus,
    inheritedVariableKeys: taxonomyRoute.inheritedVariableKeys,
    missingRequiredVariables: taxonomyRoute.missingRequiredVariables,
  };
}

export function formatRuntimeInferenceModelRouteForTrace(
  route: RuntimeInferenceModelRouteResolution
) {
  return {
    runtimeInferenceModelRoute: route.route,
    runtimeInferenceModelRouteReason: route.reason,
    runtimeInferenceModelRouteFallbackReason: route.fallbackReason,
    runtimeInferenceOperationKind: route.operationKind,
    runtimeInferenceProviderTier: route.providerTier,
    runtimeInferenceProviderConfigFingerprint: route.configFingerprint,
    runtimeInferenceProviderId: route.resolvedProviderId,
    runtimeInferenceMainProviderId: route.mainProviderId,
    runtimeInferenceProviderConfigurationStatus:
      route.configurationStatus,
    runtimeInferenceInheritedVariableKeys: route.inheritedVariableKeys,
    runtimeInferenceMissingRequiredVariables:
      route.missingRequiredVariables,
  };
}

export function createProviderConfigFingerprint(input: {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
}) {
  const serialized = JSON.stringify({
    providerId: input.provider?.id ?? input.selectedProvider.provider,
    curl: input.provider?.curl ?? "",
    streaming: input.provider?.streaming ?? false,
    responseContentPath: input.provider?.responseContentPath ?? "",
    variables: Object.entries(input.selectedProvider.variables).sort(
      ([left], [right]) => left.localeCompare(right)
    ),
  });
  return [2_166_136_261, 2_246_822_519, 3_266_489_917, 668_265_263]
    .map((seed) => {
      let hash = seed;
      for (const character of serialized) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16_777_619);
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
    })
    .join("");
}

export function formatTaxonomyAdjudicationModelRouteForTrace(
  route: TaxonomyAdjudicationModelRouteResolution
) {
  return {
    runtimeInferenceModelRoute:
      route.route === "taxonomy-adjudication-override"
        ? "runtime-inference-override"
        : "main",
    runtimeInferenceModelRouteReason: route.reason,
    runtimeInferenceModelRouteFallbackReason:
      normalizeRuntimeInferenceFallbackReason(route.fallbackReason),
    runtimeInferenceOperationKind: "taxonomy-adjudication",
    runtimeInferenceProviderId: route.resolvedProviderId,
    runtimeInferenceMainProviderId: route.mainProviderId,
    runtimeInferenceProviderConfigurationStatus:
      route.configurationStatus,
    runtimeInferenceInheritedVariableKeys:
      route.inheritedVariableKeys,
    runtimeInferenceMissingRequiredVariables:
      route.missingRequiredVariables,
    taxonomyAdjudicationModelRoute: route.route,
    taxonomyAdjudicationModelRouteReason: route.reason,
    taxonomyAdjudicationModelRouteFallbackReason: route.fallbackReason,
    taxonomyAdjudicationProviderId: route.resolvedProviderId,
    taxonomyAdjudicationMainProviderId: route.mainProviderId,
    taxonomyAdjudicationProviderConfigurationStatus:
      route.configurationStatus,
    taxonomyAdjudicationInheritedVariableKeys:
      route.inheritedVariableKeys,
    taxonomyAdjudicationMissingRequiredVariables:
      route.missingRequiredVariables,
  };
}

function normalizeRuntimeInferenceFallbackReason(
  reason: string | undefined
) {
  return reason?.replace(/^taxonomy-provider-/, "runtime-provider-");
}

function inheritMainProviderVariables(input: {
  mainProviderId: string;
  override: SelectedProviderState;
  mainSelectedProvider: SelectedProviderState;
}) {
  if (input.override.provider !== input.mainProviderId) {
    return {
      selectedProvider: input.override,
      inheritedVariableKeys: [] as string[],
    };
  }

  const variables = { ...input.mainSelectedProvider.variables };
  const inheritedVariableKeys: string[] = [];
  for (const [key, value] of Object.entries(input.override.variables)) {
    if (value.trim()) variables[key] = value;
  }
  for (const [key, value] of Object.entries(input.mainSelectedProvider.variables)) {
    if (
      value.trim() &&
      !readProviderVariable(input.override.variables, key)
    ) {
      inheritedVariableKeys.push(key);
    }
  }
  return {
    selectedProvider: {
      provider: input.override.provider,
      variables,
    },
    inheritedVariableKeys,
  };
}

function resolveProviderVariableReadiness(
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: SelectedProviderState
) {
  if (!provider) {
    return { ready: false, missingRequiredVariables: [] as string[] };
  }
  const requiredVariables = Array.from(
    provider.curl.matchAll(/\{\{([A-Z_]+)\}\}/g),
    (match) => match[1]
  ).filter(
    (key, index, values) =>
      !["SYSTEM_PROMPT", "TEXT", "IMAGE", "IMAGE_MEDIA_TYPE", "AUDIO"].includes(
        key
      ) && values.indexOf(key) === index
  );
  const missingRequiredVariables = requiredVariables.filter(
    (key) => !readProviderVariable(selectedProvider.variables, key)
  );
  return {
    ready: missingRequiredVariables.length === 0,
    missingRequiredVariables,
  };
}

function readProviderVariable(
  variables: Record<string, string>,
  key: string
) {
  const match = Object.entries(variables).find(
    ([candidate]) => candidate.toUpperCase() === key.toUpperCase()
  );
  return match?.[1]?.trim() ?? "";
}
