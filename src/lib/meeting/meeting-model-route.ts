import type { TYPE_PROVIDER } from "@/types";
import type { SelectedProviderState } from "./types";
import type { CanonicalQuestionType } from "./task-taxonomy";

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
