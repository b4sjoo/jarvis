import type { TYPE_PROVIDER } from "@/types";
import type { InterviewTaskRelation, SelectedProviderState } from "./types";
import {
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";

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

export type MeetingResponseOwnerSource =
  | "committed-parent"
  | "authorized-child"
  | "canonical-parent"
  | "current-question";

export interface MeetingResponseOwnerResolution {
  questionType: CanonicalQuestionType;
  source: MeetingResponseOwnerSource;
  preBoundaryType?: CanonicalQuestionType;
  committedType?: CanonicalQuestionType;
  relation: InterviewTaskRelation;
}

export function resolveMeetingResponseOwner(input: {
  preBoundaryType?: unknown;
  postBoundaryParentType?: unknown;
  proposedQuestionType?: unknown;
  relation: InterviewTaskRelation;
  taskBoundaryCommitted: boolean;
  childOwnsResponse: boolean;
}): MeetingResponseOwnerResolution {
  const preBoundaryType =
    normalizeCanonicalQuestionType(input.preBoundaryType) ?? undefined;
  const postBoundaryParentType =
    normalizeCanonicalQuestionType(input.postBoundaryParentType) ?? undefined;
  const proposedQuestionType =
    normalizeCanonicalQuestionType(input.proposedQuestionType) ?? "unknown";

  if (input.taskBoundaryCommitted && postBoundaryParentType) {
    return {
      questionType: postBoundaryParentType,
      source: "committed-parent",
      preBoundaryType,
      committedType: postBoundaryParentType,
      relation: input.relation,
    };
  }

  if (
    input.relation === "child-probe" &&
    input.childOwnsResponse &&
    proposedQuestionType !== "unknown"
  ) {
    return {
      questionType: proposedQuestionType,
      source: "authorized-child",
      preBoundaryType,
      relation: input.relation,
    };
  }

  if (postBoundaryParentType) {
    return {
      questionType: postBoundaryParentType,
      source: "canonical-parent",
      preBoundaryType,
      relation: input.relation,
    };
  }

  return {
    questionType: proposedQuestionType,
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

export function formatTaxonomyAdjudicationModelRouteForTrace(
  route: TaxonomyAdjudicationModelRouteResolution
) {
  return {
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
