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
  const mainRoute: TaxonomyAdjudicationModelRouteResolution = {
    provider: mainProvider,
    selectedProvider: snapshot.selectedProvider,
    route: "main",
    reason,
    mainProviderId: mainProvider?.id,
    taxonomyAdjudicationProviderId: override?.provider || undefined,
    resolvedProviderId: mainProvider?.id,
    resolutionSource: "execution-snapshot",
  };
  if (!override?.provider) {
    return { ...mainRoute, fallbackReason: "taxonomy-provider-not-configured" };
  }
  const provider = snapshot.providers.find(
    (candidate) => candidate.id === override.provider
  );
  if (!provider) {
    return { ...mainRoute, fallbackReason: "taxonomy-provider-not-found" };
  }
  return {
    provider,
    selectedProvider: override,
    route: "taxonomy-adjudication-override",
    reason,
    mainProviderId: mainProvider?.id,
    taxonomyAdjudicationProviderId: provider.id,
    resolvedProviderId: provider.id,
    resolutionSource: "execution-snapshot",
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
  };
}
