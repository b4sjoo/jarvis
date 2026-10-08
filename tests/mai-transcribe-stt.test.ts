import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import ts from "typescript";

const root = process.cwd();
const loaded = build({
  stdin: { resolveDir: root, contents: `
    export * from './src/config/stt.constants.ts';
    export * from './src/lib/functions/stt.function.ts';
    export {extractVariables} from './src/lib/functions/common.function.ts';
    export * from './src/lib/meeting/stt-request-evidence.ts';
    export * from './src/lib/meeting/stt-continuation-prompt.ts';
    export * from './src/lib/meeting/transcription.service.ts';
  ` },
  bundle: true, write: false, platform: "node", format: "cjs",
  plugins: [{ name: "stt-entry", setup(b) {
    b.onResolve({ filter: /^@\/lib\/functions$/ }, () => ({ path: path.join(root, "src/lib/functions/stt.function.ts") }));
  } }],
}).then(result => {
  const module = { exports: {} as any };
  new Function("require", "module", "exports", result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
});
const selectedProvider = { provider: "azure-mai-transcribe", variables: {
  endpoint: "https://mai-fixture.cognitiveservices.azure.com/", api_key: "synthetic-secret",
} };
const audio = () => new Blob([new Uint8Array([82, 73, 70, 70, 1, 2, 3])], { type: "audio/wav" });
const providerOf = (api: any, id = selectedProvider.provider) => api.SPEECH_TO_TEXT_PROVIDERS.find((p: any) => p.id === id);

test("MAI203: built-in configuration exposes only endpoint and key", async () => {
  const api = await loaded, provider = providerOf(api);
  assert.equal(provider.name, "Azure MAI-Transcribe-2");
  assert.equal(provider.streaming, false);
  assert.equal(provider.responseContentPath, "combinedPhrases[0].text");
  assert.deepEqual(api.extractVariables(provider.curl).map((v: any) => v.key), ["endpoint", "api_key"]);
  assert.ok(api.extractVariables(provider.curl, true).some((v: any) => v.key === "stt_terms_json"));
});

test("MAI203: actual multipart and Meeting consumer preserve audio, terms and transcript", async t => {
  const api = await loaded, provider = providerOf(api), input = audio();
  const terms = ['HNSW', 'a "quoted" term', 'path\\name', 'two\nlines', 'x=y', '{{MODEL}}'];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: any, init: RequestInit) => {
    calls++;
    assert.equal(url, "https://mai-fixture.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("Ocp-Apim-Subscription-Key"), "synthetic-secret");
    assert.equal(headers.has("Content-Type"), false);
    const form = init.body as FormData;
    assert.deepEqual([...form.keys()], ["audio", "definition"]);
    const file = form.get("audio") as File;
    assert.equal(file.name, "audio.wav");assert.equal(file.type, "audio/wav");
    assert.deepEqual(await file.arrayBuffer(), await input.arrayBuffer());
    assert.deepEqual(JSON.parse(String(form.get("definition"))), {
      enhancedMode: { enabled: true, model: "MAI-Transcribe-2", modelOptions: { transcribeStyle: "verbatim" } },
      phraseList: { phrases: terms },
    });
    assert.equal(init.redirect, undefined);
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json({ combinedPhrases: [{ text: "Explain how an LRU cache handles eviction." }] });
  });
  const result = await api.transcribeMeetingAudio({ provider, selectedProvider, audio: input, terms,
    prompt: "This free-form prompt must not be sent.", signal: new AbortController().signal,
    speaker: "them", startedAt: 1000, endedAt: 5000 });
  assert.equal(calls, 1);assert.equal(result.validation.disposition, "accepted");
  assert.equal(result.turn.text, "Explain how an LRU cache handles eviction.");
  assert.equal(result.turn.speaker, "them");assert.equal(result.turn.startedAt, 1000);
});

test("MAI203: no terms sends an empty JSON array and hostname input is supported", async t => {
  const api = await loaded;
  t.mock.method(globalThis, "fetch", async (url: any, init: RequestInit) => {
    assert.match(String(url), /^https:\/\/mai-fixture\.cognitiveservices\.azure\.com\//);
    assert.deepEqual(JSON.parse(String((init.body as FormData).get("definition"))).phraseList, { phrases: [] });
    return Response.json({ combinedPhrases: [{ text: "hello" }] });
  });
  assert.equal(await api.fetchSTT({ provider: providerOf(api), audio: audio(), selectedProvider: {
    ...selectedProvider, variables: { ...selectedProvider.variables, endpoint: "mai-fixture.cognitiveservices.azure.com" },
  } }), "hello");
});

test("MAI203: missing credentials and wrong endpoint classes fail before upload", async t => {
  const api = await loaded;
  t.mock.method(globalThis, "fetch", async () => { assert.fail("invalid configuration must not dispatch"); });
  for (const endpoint of ["", "https://example.services.ai.azure.com/api/projects/test", "https://example.openai.azure.com",
    "http://mai-fixture.cognitiveservices.azure.com", "https://mai-fixture.cognitiveservices.azure.com/path",
    "https://mai-fixture.cognitiveservices.azure.com?key=secret", "https://user:pass@mai-fixture.cognitiveservices.azure.com",
    "https://mai-fixture.cognitiveservices.azure.com.evil.invalid"]) {
    await assert.rejects(api.fetchSTT({ provider: providerOf(api), audio: audio(), selectedProvider: {
      ...selectedProvider, variables: { ...selectedProvider.variables, endpoint },
    } }), /Azure Speech resource endpoint/);
  }
  await assert.rejects(api.fetchSTT({ provider: providerOf(api), audio: audio(), selectedProvider: {
    ...selectedProvider, variables: { ...selectedProvider.variables, api_key: " " },
  } }), /API key is required/);
});

test("MAI203: actual request preserves HTTP errors, missing results and cancellation without retry", async t => {
  const api = await loaded;let calls = 0;const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_url: any, init: RequestInit) => {
    calls++;
    if (calls === 1) return new Response("denied", { status: 401 });
    if (calls === 2) return Response.json({ combinedPhrases: [] });
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
  });
  const input = { provider: providerOf(api), selectedProvider, audio: audio() };
  await assert.rejects(api.fetchSTT(input), /HTTP 401/);
  assert.equal(await api.fetchSTT(input), "No transcription found");
  const pending = api.fetchSTT({ ...input, signal: controller.signal });
  while (calls < 3) await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort();await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(api.fetchSTT({ ...input, signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 3);
});

test("MAI203: old OpenAI/file and custom named AUDIO parts keep their contracts", async t => {
  const api = await loaded;
  for (const field of ["file", "audio", "data_file"]) {
    const provider = { id: "custom", curl: `curl -X POST https://stt.invalid -H 'content-type: multipart/form-data' -F '${field}=@{{AUDIO}}' -F 'tag=a=b'` };
    const mock = t.mock.method(globalThis, "fetch", async (_url: any, init: RequestInit) => {
      const form = init.body as FormData;
      assert.deepEqual([...form.keys()], [field, "tag"]);assert.ok(form.get(field) instanceof Blob);
      assert.equal(form.get("tag"), "a=b");assert.equal(new Headers(init.headers).has("content-type"), false);
      return Response.json({ text: "ok" });
    });
    assert.equal(await api.fetchSTT({ provider, selectedProvider: { provider: "custom", variables: {} }, audio: audio() }), "ok");
    mock.mock.restore();
  }
  t.mock.method(globalThis, "fetch", async (_url: any, init: RequestInit) => {
    const form = init.body as FormData;assert.deepEqual([...form.keys()], ["file", "model", "prompt"]);
    assert.equal(form.get("model"), "gpt-4o-mini-transcribe");assert.equal(form.get("prompt"), "Original prompt.");
    return Response.json({ text: "ok" });
  });
  await api.fetchSTT({ provider: providerOf(api, "openai-whisper"), audio: audio(), prompt: "Original prompt.",
    selectedProvider: { provider: "openai-whisper", variables: { api_key: "synthetic", model: "gpt-4o-mini-transcribe" } } });
});

test("MAI203: request evidence records actual phrase hints, model and automatic language, not unsent text", async () => {
  const api = await loaded;
  const evidence = api.buildSttRequestEvidence({ provider: providerOf(api), selectedProvider,
    prompt: "This free text is not transmitted.", promptKind: "speech-bias+continuation", terms: ["HNSW"] });
  assert.equal(evidence.modelId, "MAI-Transcribe-2");assert.equal(evidence.modelSource, "provider-template");
  assert.equal(evidence.languageMode, "automatic");assert.equal(evidence.promptKind, "speech-bias");
  assert.equal(evidence.promptChars, 0);assert.equal(evidence.termCount, 1);
  assert.doesNotMatch(JSON.stringify(api.formatSttRequestEvidenceForTrace(evidence)), /synthetic-secret|HNSW|This free text/);
});

test("MAI203: the real Hook preparation block does not consume a text continuation for phrase-only STT", async () => {
  const api = await loaded;
  const source = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
  const ast = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = new Map<string, ts.VariableStatement>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations) {
      if (ts.isIdentifier(d.name)) declarations.set(d.name.text, node);
    }
    ts.forEachChild(node, visit);
  };visit(ast);
  const start = declarations.get("phraseListOnly")!, end = declarations.get("sttRequestTraceMetadata")!;
  assert.ok(start && end);
  const code = ts.transpileModule(source.slice(start.getStart(ast), end.getEnd()) +
    "\nreturn { composedSttPrompt, sttRequestTraceMetadata, continuationLeaseForPrompt, sttRequestEvidence };", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  for (const id of ["azure-mai-transcribe", "openai-whisper"]) {
    const now = Date.now();
    const lease = api.createSttContinuationPromptLease({ operationId: "op", audioSessionId: "audio", speaker: "them", source: "system-audio",
      sourceTurnId: "turn", sourceTraceId: "trace", sourceSegmentSequence: 1, sourceText: "Explain the cache",
      nativeCaptureSessionId: "capture", nativeCaptureGeneration: 1, candidateSegmentSequence: 2, createdAt: now, expiresAt: now + 10000 });
    const pending = { current: { continuationPromptLease: lease, operationId: "op" } };
    const globals = { ...api, sttProvider: providerOf(api, id), selectedSttProvider: { ...selectedProvider, provider: id },
      pendingSentenceCompletionRef: pending, speechBias: { prompt: "Prefer cache terminology.", terms: [{ term: "cache" }] },
      segment: { sessionId: "audio", nativeSegmentSequence: 2, speaker: "them", source: "system-audio", nativeCaptureSessionId: "capture", nativeCaptureGeneration: 1 },
      traceId: "current", traceStoreRef: { current: { recordInput() {}, updateMetadata() {} } },
    };
    const result = new Function(...Object.keys(globals), code)(...Object.values(globals));
    const metadata = result.sttRequestTraceMetadata;
    if (id === "azure-mai-transcribe") {
      assert.equal(result.composedSttPrompt.prompt, "");assert.equal(result.continuationLeaseForPrompt, undefined);
      assert.equal(pending.current.continuationPromptLease.consumedAt, undefined);
      assert.equal(metadata.sttContinuationReason, "provider-text-prompt-unsupported");
      assert.equal(metadata.sttRequestPromptChars, 0);assert.equal(metadata.sttRequestContinuationChars, 0);
      assert.equal(metadata.sttRequestPromptKind, "speech-bias");assert.equal(metadata.sttRequestPromptHash, undefined);
    } else {
      assert.ok(result.continuationLeaseForPrompt);assert.ok(result.composedSttPrompt.prompt.length > 0);
      assert.equal(metadata.sttContinuationDisposition, "consumed");assert.equal(metadata.sttRequestPromptKind, "speech-bias+continuation");
    }
  }
});
