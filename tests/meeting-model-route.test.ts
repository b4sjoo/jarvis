import assert from "node:assert/strict";
import test from "node:test";
import {
  formatMeetingResponseOwnerForTrace,
  resolveMeetingModelRouteFromSnapshot,
  resolveMeetingResponseOwner,
  resolveManualCorrectionRegenerationRoute,
  resolveTaxonomyAdjudicationModelRouteFromSnapshot,
  type MeetingModelProviderSnapshot,
} from "../src/lib/meeting/meeting-model-route.js";

const snapshot: MeetingModelProviderSnapshot = {
  providers: [
    { id: "main", curl: "https://main.test" },
    { id: "coding", curl: "https://coding.test/{{IMAGE}}" },
  ],
  selectedProvider: { provider: "main", variables: { MODEL: "fast" } },
  codingProvider: { provider: "coding", variables: { MODEL: "smart" } },
  taxonomyAdjudicationProvider: {
    provider: "main",
    variables: { MODEL: "classifier" },
  },
};

test("resolves the main provider from the execution snapshot", () => {
  const route = resolveMeetingModelRouteFromSnapshot({
    snapshot,
    useCodingModel: false,
    reason: "advisor-main",
  });

  assert.equal(route.route, "main");
  assert.equal(route.provider?.id, "main");
  assert.equal(route.selectedProvider.variables.MODEL, "fast");
  assert.equal(route.resolutionSource, "execution-snapshot");
});

test("routes taxonomy adjudication to its independent provider variables", () => {
  const route = resolveTaxonomyAdjudicationModelRouteFromSnapshot({ snapshot });
  assert.equal(route.route, "taxonomy-adjudication-override");
  assert.equal(route.provider?.id, "main");
  assert.equal(route.selectedProvider.variables.MODEL, "classifier");

  const fallback = resolveTaxonomyAdjudicationModelRouteFromSnapshot({
    snapshot: {
      ...snapshot,
      taxonomyAdjudicationProvider: { provider: "", variables: {} },
    },
  });
  assert.equal(fallback.route, "main");
  assert.equal(fallback.fallbackReason, "taxonomy-provider-not-configured");
});

test("routes coding questions to the configured coding provider", () => {
  const route = resolveMeetingModelRouteFromSnapshot({
    snapshot,
    useCodingModel: true,
    requiresVision: true,
    reason: "active-coding-task",
  });

  assert.equal(route.route, "coding-override");
  assert.equal(route.provider?.id, "coding");
  assert.equal(route.selectedProvider.variables.MODEL, "smart");
});

test("returns an explainable missing-provider route without stale fallback", () => {
  const route = resolveMeetingModelRouteFromSnapshot({
    snapshot: {
      providers: snapshot.providers,
      selectedProvider: { provider: "removed", variables: {} },
      codingProvider: { provider: "", variables: {} },
    },
    useCodingModel: false,
    reason: "advisor-main",
  });

  assert.equal(route.provider, undefined);
  assert.equal(route.resolvedProviderId, undefined);
  assert.equal(route.mainProviderId, undefined);
});

test("manual correction composes corrected taxonomy with provider routing", () => {
  const codingRoute = resolveManualCorrectionRegenerationRoute({
    snapshot,
    correctedType: "coding",
  });
  const systemDesignRoute = resolveManualCorrectionRegenerationRoute({
    snapshot,
    correctedType: "ai-ml-system-design",
  });

  assert.equal(codingRoute.route, "coding-override");
  assert.equal(codingRoute.provider?.id, "coding");
  assert.equal(systemDesignRoute.route, "main");
  assert.equal(systemDesignRoute.provider?.id, "main");
});

test("a committed incompatible parent owns routing over the previous coding parent", () => {
  const owner = resolveMeetingResponseOwner({
    preBoundaryType: "coding",
    postBoundaryParentType: "general-system-design",
    proposedQuestionType: "general-system-design",
    relation: "new-parent",
    taskBoundaryCommitted: true,
    childOwnsResponse: false,
  });
  const route = resolveMeetingModelRouteFromSnapshot({
    snapshot,
    useCodingModel: owner.questionType === "coding",
    reason: `response-owner-${owner.source}`,
  });

  assert.equal(owner.source, "committed-parent");
  assert.equal(owner.questionType, "general-system-design");
  assert.equal(route.route, "main");
});

test("an authorized coding child owns its response under a design parent", () => {
  const owner = resolveMeetingResponseOwner({
    preBoundaryType: "general-system-design",
    postBoundaryParentType: "general-system-design",
    proposedQuestionType: "coding",
    relation: "child-probe",
    taskBoundaryCommitted: false,
    childOwnsResponse: true,
  });

  assert.equal(owner.source, "authorized-child");
  assert.equal(owner.questionType, "coding");
});

test("a non-authoritative child signal cannot take provider authority", () => {
  const owner = resolveMeetingResponseOwner({
    preBoundaryType: "general-system-design",
    postBoundaryParentType: "general-system-design",
    proposedQuestionType: "coding",
    relation: "child-probe",
    taskBoundaryCommitted: false,
    childOwnsResponse: false,
  });

  assert.equal(owner.source, "canonical-parent");
  assert.equal(owner.questionType, "general-system-design");
});

test("response-owner trace explains pre-boundary and committed types", () => {
  const metadata = formatMeetingResponseOwnerForTrace(
    resolveMeetingResponseOwner({
      preBoundaryType: "coding",
      postBoundaryParentType: "ai-ml-system-design",
      proposedQuestionType: "ai-ml-system-design",
      relation: "new-parent",
      taskBoundaryCommitted: true,
      childOwnsResponse: false,
    })
  );

  assert.equal(metadata.responseOwnerPreBoundaryType, "coding");
  assert.equal(metadata.responseOwnerCommittedType, "ai-ml-system-design");
  assert.equal(metadata.responseOwnerQuestionType, "ai-ml-system-design");
  assert.equal(metadata.responseOwnerSource, "committed-parent");
});
