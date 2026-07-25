import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSttRequestEvidence,
  formatSttRequestEvidenceForTrace,
} from "../src/lib/meeting/stt-request-evidence.js";

test("records selected STT model and automatic language without prompt contents", () => {
  const evidence = buildSttRequestEvidence({
    provider: {
      id: "openai-whisper",
      curl: `curl -X POST "https://api.openai.com/v1/audio/transcriptions" \
        -H "Authorization: Bearer {{API_KEY}}" \
        -F "file={{AUDIO}}" \
        -F "model={{MODEL}}" \
        -F "prompt={{STT_PROMPT}}"`,
    },
    selectedProvider: {
      provider: "openai-whisper",
      variables: {
        API_KEY: "secret-value",
        MODEL: "gpt-4o-mini-transcribe",
      },
    },
    prompt: "Prefer HNSW and retrieval augmented generation.",
    terms: ["HNSW", "retrieval augmented generation"],
  });

  assert.deepEqual(evidence, {
    providerId: "openai-whisper",
    configuredProviderId: "openai-whisper",
    providerIdentityStatus: "matched",
    modelId: "gpt-4o-mini-transcribe",
    modelSource: "selected-provider-variable",
    language: undefined,
    languageMode: "automatic",
    languageSource: "not-observed",
    promptKind: "speech-bias",
    promptChars: 47,
    termCount: 2,
    confidenceCapability: "not-exposed-by-text-adapter",
  });
  assert.equal(
    JSON.stringify(formatSttRequestEvidenceForTrace(evidence)).includes(
      "secret-value"
    ),
    false
  );
  assert.equal(
    JSON.stringify(formatSttRequestEvidenceForTrace(evidence)).includes(
      "HNSW"
    ),
    false
  );
});

test("reads fixed nested language configuration from a provider template", () => {
  const evidence = buildSttRequestEvidence({
    provider: {
      id: "google-stt",
      curl: `curl -X POST "https://speech.googleapis.com/v1/speech:recognize" \
        -H "Content-Type: application/json" \
        -d '{"config":{"languageCode":"en-US","model":"latest_long"}}'`,
    },
    selectedProvider: {
      provider: "google-stt",
      variables: {},
    },
  });

  assert.equal(evidence.modelId, "latest_long");
  assert.equal(evidence.modelSource, "provider-template");
  assert.equal(evidence.language, "en-US");
  assert.equal(evidence.languageMode, "explicit");
  assert.equal(evidence.languageSource, "provider-template");
  assert.equal(evidence.promptKind, "none");
});

test("reads array-like form configuration and selected model variables", () => {
  const evidence = buildSttRequestEvidence({
    provider: {
      id: "groq",
      curl: `curl -X POST "https://api.groq.com/openai/v1/audio/transcriptions" \
        -F "file={{AUDIO}}" \
        -F "model={{MODEL}}" \
        -F "language=en"`,
    },
    selectedProvider: {
      provider: "groq",
      variables: {
        model: "whisper-large-v3-turbo",
      },
    },
    prompt: "Custom context without terms.",
  });

  assert.equal(evidence.modelId, "whisper-large-v3-turbo");
  assert.equal(evidence.modelSource, "selected-provider-variable");
  assert.equal(evidence.language, "en");
  assert.equal(evidence.languageSource, "provider-template");
  assert.equal(evidence.promptKind, "custom");
});

test("degrades to identity-only evidence when a custom curl cannot be parsed", () => {
  const evidence = buildSttRequestEvidence({
    provider: {
      id: "custom-stt",
      curl: "not a curl command",
    },
    selectedProvider: {
      provider: "different-provider",
      variables: {
        API_KEY: "must-not-appear",
      },
    },
  });

  assert.equal(evidence.providerIdentityStatus, "mismatched");
  assert.equal(evidence.modelId, undefined);
  assert.equal(evidence.modelSource, "not-observed");
  assert.equal(evidence.languageMode, "automatic");
});
