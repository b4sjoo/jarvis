import assert from "node:assert/strict";
import test from "node:test";
import {
  resolvePreparationModelRoute,
  type PreparationModelRouteStatus,
} from "../src/lib/preparation/model-route.js";
import type { TYPE_PROVIDER } from "../src/types/provider.type.js";

const textProvider: TYPE_PROVIDER = {
  id: "text-model",
  curl: "curl https://example.test -H 'Authorization: Bearer {{API_KEY}}' -d '{{TEXT}}'",
};
const visionProvider: TYPE_PROVIDER = {
  id: "vision-model",
  curl: "curl https://example.test -H 'Authorization: Bearer {{API_KEY}}' -d '{{TEXT}} {{IMAGE}} {{IMAGE_MEDIA_TYPE}}'",
};

test("preparation route never falls back when its role is unconfigured", () => {
  const route = resolvePreparationModelRoute({
    providers: [textProvider],
    selectedProvider: { provider: "", variables: {} },
  });

  assert.equal(route.status, "provider-not-configured");
  assert.equal(route.provider, undefined);
});

test("preparation route reports stale provider selections", () => {
  const route = resolvePreparationModelRoute({
    providers: [textProvider],
    selectedProvider: { provider: "removed-provider", variables: {} },
  });

  assert.equal(route.status, "provider-not-found");
});

test("preparation route reports missing role-specific credentials", () => {
  const route = resolvePreparationModelRoute({
    providers: [textProvider],
    selectedProvider: { provider: "text-model", variables: {} },
  });

  assert.equal(route.status, "missing-required-variables");
  assert.deepEqual(route.missingRequiredVariables, ["API_KEY"]);
});

test("preparation route accepts case-insensitive variable keys", () => {
  const route = resolvePreparationModelRoute({
    providers: [textProvider],
    selectedProvider: {
      provider: "text-model",
      variables: { api_key: "secret" },
    },
  });

  assert.equal(route.status, "ready" satisfies PreparationModelRouteStatus);
  assert.equal(route.supportsVision, false);
});

test("preparation route requires an explicitly vision-capable provider", () => {
  const rejected = resolvePreparationModelRoute({
    providers: [textProvider],
    selectedProvider: {
      provider: "text-model",
      variables: { api_key: "secret" },
    },
    requiresVision: true,
  });
  const accepted = resolvePreparationModelRoute({
    providers: [visionProvider],
    selectedProvider: {
      provider: "vision-model",
      variables: { api_key: "secret" },
    },
    requiresVision: true,
  });

  assert.equal(rejected.status, "vision-not-supported");
  assert.equal(accepted.status, "ready");
  assert.equal(accepted.supportsVision, true);
});
