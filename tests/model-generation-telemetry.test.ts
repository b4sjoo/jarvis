import assert from "node:assert/strict";
import test from "node:test";
import {
  buildModelGenerationIdentityForTrace,
  formatModelGenerationTimingForTrace,
} from "../src/lib/meeting/model-generation-telemetry.js";

test("builds a privacy-safe model identity and stable generation fingerprint", () => {
  const input = {
    requestOrigin: "advisor" as const,
    providerId: "gemini",
    modelId: "gemini-2.5-pro",
    modelRoute: "main",
    streamingConfigured: true,
    requestOptions: { timeoutMs: 30_000, maxOutputTokens: 4_096 },
    responseConfig: { length: "normal" as const, language: "auto" as const },
    promptContractId: "meeting-answer:system-design",
    promptContractVersion: "meeting-advisor-prompt-v1",
  };
  const first = buildModelGenerationIdentityForTrace(input);
  const second = buildModelGenerationIdentityForTrace(input);

  assert.equal(first.modelGenerationModelId, "gemini-2.5-pro");
  assert.equal(first.modelGenerationStreamingConfigured, true);
  assert.equal(
    first.modelGenerationConfigFingerprint,
    second.modelGenerationConfigFingerprint
  );
  assert.equal(first.modelGenerationNetworkFirstByteObservable, false);
});

test("hashes unsafe identifiers and distinguishes content from network first byte", () => {
  const identity = buildModelGenerationIdentityForTrace({
    requestOrigin: "screen",
    providerId: "private provider name",
    modelId: "secret model\nlabel",
    modelRoute: "coding-override",
    streamingConfigured: false,
    promptContractId: "meeting-answer:coding",
    promptContractVersion: "meeting-advisor-prompt-v1",
  });
  const timing = formatModelGenerationTimingForTrace({
    requestStartedAt: 1_000,
    firstContentAt: 1_250,
    firstVisiblePartialAt: 1_400,
    completedAt: 1_900,
    chunkCount: 4,
  });

  assert.match(String(identity.modelGenerationProviderId), /^provider-hash-/);
  assert.match(String(identity.modelGenerationModelId), /^model-hash-/);
  assert.equal(identity.modelGenerationTimingSemantics, "first-content-not-network-first-byte");
  assert.equal(timing.modelGenerationFirstContentMs, 250);
  assert.equal(timing.modelGenerationFirstVisiblePartialMs, 400);
  assert.equal(timing.modelGenerationDurationMs, 900);
  assert.equal(timing.modelGenerationChunkCount, 4);
});
