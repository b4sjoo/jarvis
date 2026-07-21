import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveMeetingModelRouteFromSnapshot,
  resolveManualCorrectionRegenerationRoute,
  type MeetingModelProviderSnapshot,
} from "../src/lib/meeting/meeting-model-route.js";

const snapshot: MeetingModelProviderSnapshot = {
  providers: [
    { id: "main", curl: "https://main.test" },
    { id: "coding", curl: "https://coding.test/{{IMAGE}}" },
  ],
  selectedProvider: { provider: "main", variables: { MODEL: "fast" } },
  codingProvider: { provider: "coding", variables: { MODEL: "smart" } },
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
