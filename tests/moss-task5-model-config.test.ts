import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { CALL_STATUS_LABELS, callStatusLabel } from "../src/lib/calling/call-status.js";
import {
  CHAT_PROVIDERS,
  STT_LANGUAGES,
  STT_PROVIDERS,
  getChatProvider,
  getSttProvider,
} from "../src/lib/calling/provider-catalog.js";
import {
  DEFAULT_MODEL_ROUTES,
  commitProviderConfigurationTransaction,
  normalizeModelRouteSettings,
} from "../src/lib/calling/model-routes.js";
import {
  buildChatProviderRequest,
  buildMultimodalProviderRequest,
  buildTranscriptionProviderRequest,
  parseChatProviderResponse,
} from "../src/lib/calling/provider-client.js";

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

test("control and companion consume one complete call-status projection", () => {
  assert.equal(callStatusLabel("planned"), "Ready");
  assert.equal(callStatusLabel("live"), "Listening");
  assert.equal(Object.keys(CALL_STATUS_LABELS).length, 10);

  const app = source("src/pages/app/index.tsx");
  const companion = source("src/pages/calling/index.tsx");
  assert.match(app, /callStatusLabel\(controller\.runtime\.state\)/);
  assert.match(companion, /callStatusLabel\(state\)/);
  assert.doesNotMatch(app, /\{controller\.runtime\.state\}\s*<\/div>/);
});

test("provider catalogs expose only resolved and unique presets", () => {
  assert.equal(
    new Set(CHAT_PROVIDERS.map((provider) => provider.id)).size,
    CHAT_PROVIDERS.length
  );
  assert.equal(
    new Set(STT_PROVIDERS.map((provider) => provider.id)).size,
    STT_PROVIDERS.length
  );
  for (const provider of [...CHAT_PROVIDERS, ...STT_PROVIDERS]) {
    assert.match(provider.endpoint, /^https?:\/\//);
    assert.ok(provider.name.length > 0);
  }
  assert.ok(STT_LANGUAGES.some((language) => language.code === ""));
  assert.ok(STT_LANGUAGES.some((language) => language.code === "en"));
  assert.ok(STT_LANGUAGES.every((language) => language.flag.length > 0));
});

test("route normalization infers legacy providers and rejects endpoint drift", () => {
  const normalized = normalizeModelRouteSettings({
    revision: 7,
    chat: {
      runtime: {
        endpoint: getChatProvider("anthropic").endpoint,
        model: "claude-sonnet-4-5",
        timeoutMs: 9_000,
        maxOutputTokens: 700,
      },
      advisor: {
        provider: "gemini",
        endpoint: "https://wrong.invalid/chat",
        model: "gemini-2.5-flash",
      },
      complex: {
        provider: "unsupported",
        endpoint: "https://wrong.invalid/chat",
      },
    },
    stt: {
      endpoint: getSttProvider("groq-whisper").endpoint,
      model: "whisper-large-v3-turbo",
      language: "en",
    },
  });

  assert.equal(normalized.revision, 7);
  assert.equal(normalized.chat.runtime.provider, "anthropic");
  assert.equal(
    normalized.chat.runtime.endpoint,
    getChatProvider("anthropic").endpoint
  );
  assert.equal(normalized.chat.advisor.provider, "gemini");
  assert.equal(
    normalized.chat.advisor.endpoint,
    getChatProvider("gemini").endpoint
  );
  assert.equal(
    normalized.chat.complex.provider,
    DEFAULT_MODEL_ROUTES.chat.complex.provider
  );
  assert.equal(normalized.stt.provider, "groq-whisper");
});

test("chat adapters keep OpenAI-compatible and Anthropic protocols distinct", () => {
  const openAiRoute = DEFAULT_MODEL_ROUTES.chat.runtime;
  const openAiRequest = buildChatProviderRequest({
    route: openAiRoute,
    apiKey: "openai-secret",
    messages: [
      { role: "system", content: "System" },
      { role: "user", content: "Question" },
    ],
  });
  assert.equal(openAiRequest.endpoint, getChatProvider("openai").endpoint);
  assert.equal(
    (openAiRequest.init.headers as Record<string, string>).Authorization,
    "Bearer openai-secret"
  );
  assert.equal(
    (openAiRequest.init.headers as Record<string, string>)[
      "anthropic-dangerous-direct-browser-access"
    ],
    undefined
  );
  assert.deepEqual(
    JSON.parse(String(openAiRequest.init.body)).messages[0],
    { role: "system", content: "System" }
  );

  const anthropicRoute = normalizeModelRouteSettings({
    chat: {
      runtime: {
        ...openAiRoute,
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      },
    },
  }).chat.runtime;
  const anthropicRequest = buildChatProviderRequest({
    route: anthropicRoute,
    apiKey: "anthropic-secret",
    messages: [
      { role: "system", content: "System" },
      { role: "user", content: "Question" },
    ],
  });
  const anthropicBody = JSON.parse(String(anthropicRequest.init.body));
  assert.equal(
    (anthropicRequest.init.headers as Record<string, string>)["x-api-key"],
    "anthropic-secret"
  );
  assert.equal(
    (anthropicRequest.init.headers as Record<string, string>)[
      "anthropic-dangerous-direct-browser-access"
    ],
    "true"
  );
  assert.equal(anthropicBody.system, "System");
  assert.deepEqual(anthropicBody.messages, [
    { role: "user", content: "Question" },
  ]);
  assert.equal(
    parseChatProviderResponse(anthropicRoute, {
      content: [{ type: "text", text: "Answer" }],
    }),
    "Answer"
  );
});

test("Anthropic multimodal requests opt into the same direct desktop transport", () => {
  const anthropicRoute = normalizeModelRouteSettings({
    chat: {
      complex: {
        ...DEFAULT_MODEL_ROUTES.chat.complex,
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      },
    },
  }).chat.complex;
  const request = buildMultimodalProviderRequest({
    route: anthropicRoute,
    apiKey: "anthropic-secret",
    prompt: "Read this document.",
    mediaType: "application/pdf",
    base64Data: "cGRm",
    fileName: "case.pdf",
  });
  const headers = request.init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "anthropic-secret");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["anthropic-dangerous-direct-browser-access"], "true");

  const body = JSON.parse(String(request.init.body));
  assert.equal(body.messages[0].content[1].type, "document");
});

test("STT adapters translate model and language fields per provider", () => {
  const audio = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });
  const openAiRequest = buildTranscriptionProviderRequest({
    route: DEFAULT_MODEL_ROUTES.stt,
    apiKey: "openai-secret",
    audio,
    prompt: "MOSS",
  });
  const openAiForm = openAiRequest.init.body as FormData;
  assert.equal(openAiForm.get("model"), "gpt-4o-mini-transcribe");
  assert.equal(openAiForm.get("language"), "en");
  assert.equal(openAiForm.get("prompt"), "MOSS");

  const elevenLabsRoute = normalizeModelRouteSettings({
    stt: {
      provider: "elevenlabs",
      model: "scribe_v1",
      language: "zh",
    },
  }).stt;
  const elevenLabsRequest = buildTranscriptionProviderRequest({
    route: elevenLabsRoute,
    apiKey: "eleven-secret",
    audio,
    prompt: "ignored by this protocol",
  });
  const elevenLabsForm = elevenLabsRequest.init.body as FormData;
  assert.equal(elevenLabsForm.get("model_id"), "scribe_v1");
  assert.equal(elevenLabsForm.get("language_code"), "zh");
  assert.equal(elevenLabsForm.get("prompt"), null);
  assert.equal(
    (elevenLabsRequest.init.headers as Record<string, string>)["xi-api-key"],
    "eleven-secret"
  );
});

test("model settings expose provider and language choices without endpoint inputs", () => {
  const models = source("src/pages/models/index.tsx");
  assert.match(models, /CHAT_PROVIDERS\.map/);
  assert.match(models, /STT_PROVIDERS\.map/);
  assert.match(models, /STT_LANGUAGES\.map/);
  assert.doesNotMatch(models, /<label>\s*Endpoint/);
  assert.match(models, /<MossSelect/);
  assert.doesNotMatch(models, /<select/);

  const hook = source("src/hooks/useCallingAssistant.ts");
  assert.match(hook, /providerChanged/);
  assert.match(hook, /API key after changing/);
  assert.match(hook, /provider: saved\.chat\.runtime\.provider/);
});

test("desktop credentials use MOSS-owned narrow commands and readable failures", () => {
  const routes = source("src/lib/calling/model-routes.ts");
  const nativeStore = source("src-tauri/src/credential_store.rs");
  const nativeShell = source("src-tauri/src/lib.rs");
  const packageManifest = source("package.json");

  assert.match(routes, /invoke<string \| null>\("get_provider_secret"/);
  assert.match(routes, /MOSS could not \$\{action\} provider credentials/);
  assert.match(nativeStore, /const ALLOWED_KEYS: \[&str; 4\]/);
  assert.match(nativeStore, /provider-credentials\.json/);
  assert.match(nativeStore, /create_new\(true\)/);
  assert.match(nativeStore, /Permissions::from_mode\(0o600\)/);
  assert.doesNotMatch(nativeStore, /get_generic_password|security_framework/);
  assert.match(nativeShell, /credential_store::get_provider_secret/);
  assert.doesNotMatch(nativeShell, /tauri_plugin_keychain::init/);
  assert.doesNotMatch(packageManifest, /tauri-plugin-keychain/);
});

test("provider configuration compensates earlier key writes before rejecting a partial save", async () => {
  const stored = new Map<string, string>([
    ["runtime", "old-runtime"],
    ["advisor", "old-advisor"],
  ]);
  const events: string[] = [];
  await assert.rejects(
    commitProviderConfigurationTransaction({
      revision: 9,
      previousSecrets: {
        runtime: "old-runtime",
        advisor: "old-advisor",
        complex: "",
        stt: "",
      },
      nextSecrets: {
        runtime: "new-runtime",
        advisor: "new-advisor",
        complex: "",
        stt: "",
      },
      changedRoutes: ["runtime", "advisor"],
      writeSecret: async (route, value) => {
        if (route === "advisor" && value === "new-advisor") {
          throw new Error("vault denied write");
        }
        stored.set(route, value);
      },
      removeSecret: async (route) => {
        stored.delete(route);
      },
      commitSettings: () => {
        throw new Error("settings must not commit");
      },
      onEvent: (event) => events.push(event.status),
    }),
    /vault denied write/
  );
  assert.equal(stored.get("runtime"), "old-runtime");
  assert.equal(stored.get("advisor"), "old-advisor");
  assert.deepEqual(events, ["started", "compensated"]);
});

test("provider configuration restores keys when the settings revision cannot commit", async () => {
  const stored = new Map<string, string>([["stt", "old-stt"]]);
  await assert.rejects(
    commitProviderConfigurationTransaction({
      revision: 10,
      previousSecrets: {
        runtime: "",
        advisor: "",
        complex: "",
        stt: "old-stt",
      },
      nextSecrets: {
        runtime: "",
        advisor: "",
        complex: "",
        stt: "new-stt",
      },
      changedRoutes: ["stt"],
      writeSecret: async (route, value) => {
        stored.set(route, value);
      },
      removeSecret: async (route) => {
        stored.delete(route);
      },
      commitSettings: () => {
        throw new Error("local storage unavailable");
      },
    }),
    /local storage unavailable/
  );
  assert.equal(stored.get("stt"), "old-stt");
});
