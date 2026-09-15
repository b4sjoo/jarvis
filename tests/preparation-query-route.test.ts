import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { AIResponseEventBuilder } from "../src/lib/functions/ai-response-events.js";
import { createPreparationContextComposer } from "../src/lib/preparation/context-composer.js";
import {
  createPreparationConversationExecutionService,
  type PreparationConversationExecutionDependencies,
  type PreparationConversationExecutionEvent,
} from "../src/lib/preparation/conversation-execution.js";
import type { PreparationFetchRequest, PreparationFetchResponse, PreparationFetchResponseEvents } from "../src/lib/preparation/context-types.js";
import { resolvePreparationModelRoute, type PreparationModelRoute } from "../src/lib/preparation/model-route.js";
import { memoryEntry, preparationPurposeFixture } from "./helpers/preparation-purpose-fixture.js";

const originalQuery = "Find another experience for this principle";
const queries = { guidance: "iterate principle", "personal-context": "experiment alternative" };
const raw = JSON.stringify(queries);

function readyRoute(role: "advisor" | "preparation", version = 1): PreparationModelRoute {
  const id = `${role}-${version}`;
  return resolvePreparationModelRoute({
    providers: [{ id, streaming: false, responseContentPath: "choices[0].message.content",
      curl: `curl https://${id}.fixture.test/v1/chat/completions -H 'Authorization: Bearer {{API_KEY}}' -d '{"model":"{{MODEL}}","messages":[{"role":"system","content":"{{SYSTEM_PROMPT}}"},{"role":"user","content":"{{TEXT}}"}]}'` }],
    selectedProvider: { provider: id, variables: { api_key: `${id}-secret-never-log`, model: `${id}-model` } },
  });
}

function builder(input: PreparationFetchRequest) {
  return new AIResponseEventBuilder(input.provider?.id ?? input.selectedProvider.provider, {
    requestId: "query-request", executionPlanId: "query-plan", modelId: input.selectedProvider.variables.model,
    sessionId: "fixture", runtimeEpoch: 0, logicalQuestionUnitId: "query", logicalQuestionRevision: 1,
    attemptId: "query-attempt", attemptNumber: 1, maxAttempts: 1,
  });
}

async function* queryEvents(input: PreparationFetchRequest) {
  const b = builder(input);
  yield b.content(raw);
  yield b.terminal({ status: "success", retryable: false, completionSignal: "non-streaming-response" });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(options: {
  history?: boolean;
  rewrite?: PreparationFetchResponseEvents;
  answer?: PreparationFetchResponse;
  beforeProcess?: () => Promise<void>;
  materialExtraction?: Partial<PreparationConversationExecutionDependencies["materialExtraction"]>;
  imageGateway?: Partial<PreparationConversationExecutionDependencies["imageGateway"]>;
} = {}) {
  const h = await preparationPurposeFixture();
  if (options.history !== false) await h.seedHistory("Oracle iterate principle and an earlier experience.");
  const route = readyRoute("preparation"), queryRoute = readyRoute("advisor");
  const queryRequests: PreparationFetchRequest[] = [], answerRequests: PreparationFetchRequest[] = [];
  const events: PreparationConversationExecutionEvent[] = [];
  const service = createPreparationConversationExecutionService({
    conversations: h.conversations, materials: h.materialRepo,
    interviewProcesses: { ...h.interviewProcesses, async getProcess(id) {
      await options.beforeProcess?.();
      return h.interviewProcesses.getProcess(id);
    } },
    contextComposer: createPreparationContextComposer({ materials: h.contextRepo, materialInventory: h.materialRepo, retrieveKmb: h.retrieveKmb }),
    materialExtraction: {
      async inspect() { throw new Error("No extraction in text fixture"); },
      async commitCloudImageText() { throw new Error("No OCR"); },
      async commitRecoveredText() { throw new Error("No recovery mutation"); },
      async flagQuality() { throw new Error("No automatic promotion"); },
      ...options.materialExtraction,
    },
    imageGateway: {
      async read() { throw new Error("No image"); },
      async readVisuals() { throw new Error("No visual recovery"); },
      ...options.imageGateway,
    },
    fetchQueryResponseEvents(input) { queryRequests.push(input); return (options.rewrite ?? queryEvents)(input); },
    fetchResponse(input) { answerRequests.push(input); return (options.answer ?? (async function* () { yield "Answer from supplied sources."; }))(input); },
    onEvent(event) { events.push(event); },
  });
  return {
    ...h, route, queryRoute, service, queryRequests, answerRequests, events,
    run: (overrides: Partial<Parameters<typeof service.execute>[0]> = {}) => service.execute({
      processId: "p", conversationId: h.conversation.id, content: originalQuery, route, queryRoute, ...overrides,
    }),
    async snapshot() {
      const detail = await h.conversations.load("p", h.conversation.id);
      const snapshot = detail.messages.at(-1)?.contextSnapshot;
      assert.ok(snapshot?.retrieval);
      return { ...snapshot, retrieval: snapshot.retrieval };
    },
  };
}

// Bundle the existing transport unchanged; only native HTTP is forbidden. Tests intercept browser fetch.
async function transport() {
  const result = await build({
    entryPoints: ["src/lib/functions/ai-response.function.ts"], bundle: true, write: false,
    platform: "node", format: "cjs",
    plugins: [{ name: "no-native-provider", setup(b) {
      b.onResolve({ filter: /^@tauri-apps\/plugin-http$/ }, () => ({ path: "native-http", namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const fetch = () => { throw Error('Native provider calls forbidden'); };" }));
    } }],
  });
  const module = { exports: {} as { fetchAIResponse: PreparationFetchResponse; fetchAIResponseEvents: PreparationFetchResponseEvents } };
  new Function("require", "module", "exports", result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
}

for (const sharedProvider of [false, true]) {
test(`PQ-R1/R5 real service and HTTP builder use distinct query/answer credentials and models with ${sharedProvider ? "the same" : "different"} provider IDs`, async (t) => {
  const http: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.ok(init?.body);
    http.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return Response.json({ choices: [{ message: { content: http.length === 1 ? raw : "Only current supplied sources support this answer." }, finish_reason: "stop" }] });
  });
  const real = await transport();
  const h = await fixture({ rewrite: real.fetchAIResponseEvents, answer: real.fetchAIResponse });
  try {
    if (sharedProvider) {
      h.route.provider = h.queryRoute.provider;
      h.route.selectedProvider.provider = h.queryRoute.selectedProvider.provider;
    }
    const answerProviderId = sharedProvider ? "advisor-1" : "preparation-1";
    await h.material("principle-source", "guidance", { chunks: 5, content: "iterate principle guidance" });
    await h.material("experience-source", "personal-context", { chunks: 5, content: "experiment alternative experience" });
    h.memory.push(...[0, 1, 2].map((i) => memoryEntry(`guide-${i}`, "interview_framework")),
      ...[0, 1, 2].map((i) => memoryEntry(`experience-${i}`)));
    assert.equal((await h.run()).status, "committed");
    assert.equal(http.length, 2);
    assert.deepEqual(http.map((r) => [r.url, r.headers.get("Authorization"), r.body.model, r.body.max_completion_tokens]), [
      ["https://advisor-1.fixture.test/v1/chat/completions", "Bearer advisor-1-secret-never-log", "advisor-1-model", 2048],
      [`https://${answerProviderId}.fixture.test/v1/chat/completions`, "Bearer preparation-1-secret-never-log", "preparation-1-model", 16384],
    ]);
    assert.deepEqual(h.queryRequests[0].requestOptions, { timeoutMs: 15000, maxOutputTokens: 2048, retryPolicy: { maxAttempts: 1 } });
    assert.deepEqual(h.answerRequests[0].requestOptions, { timeoutMs: 180000, maxOutputTokens: 16384 });
    assert.equal(h.queryRequests[0].applyResponseSettings, false);
    assert.match(h.queryRequests[0].systemPrompt!, /^Rewrite the latest preparation request into two standalone retrieval queries\./);
    assert.match(h.queryRequests[0].systemPrompt!, /Assistant history and old source references are reference-resolution hints, not facts or permission to read sources/);
    assert.deepEqual(JSON.parse(h.queryRequests[0].userMessage), { request: originalQuery, sourceRefs: [] });
    assert.match(JSON.stringify(http[0].body.messages), /Oracle iterate principle/);
    assert.ok((h.queryRequests[0].history?.length ?? 0) <= 16);
    assert.ok((h.queryRequests[0].history ?? []).reduce((n, m) => n + String(m.content).length, 0) <= 12000);
    assert.deepEqual(h.queries.map((q) => [q.preparationPurpose, q.query]), [["guidance", queries.guidance], ["personal-context", queries["personal-context"]]]);
    assert.match(JSON.stringify(http[1].body.messages), /iterate principle guidance/);
    assert.match(JSON.stringify(http[1].body.messages), /experiment alternative experience/);
    const snapshot = await h.snapshot();
    assert.equal(snapshot.providerId, answerProviderId);
    assert.equal(snapshot.retrieval.disposition, "rewritten");
    assert.equal(snapshot.retrieval.requestedProviderId, "advisor-1");
    assert.equal(snapshot.retrieval.requestedModelId, "advisor-1-model");
    assert.equal(snapshot.retrieval.completion?.providerTerminal?.providerId, "advisor-1");
    assert.equal(snapshot.retrieval.completion?.providerTerminal?.modelId, "advisor-1-model");
    assert.equal(snapshot.budget.selectedMaterialChunks, 6);
    assert.equal(snapshot.budget.selectedKmbEntries, 3);
    assert.ok(snapshot.budget.materialChars <= 8000 && snapshot.budget.kmbChars <= 4000 && snapshot.budget.totalChars <= 30000);
    assert.deepEqual(JSON.parse(JSON.stringify(h.events.find((e) => e.name === "Preparation context composed")?.retrieval)), snapshot.retrieval);
    assert.ok(h.events.filter((e) => e.name.startsWith("Preparation model")).every((e) => e.providerId === answerProviderId));
    assert.doesNotMatch(JSON.stringify({ snapshot, events: h.events }), /secret-never-log|API_KEY|Authorization|variables|curl/);
  } finally { h.close(); }
});
}

for (const state of ["missing", "provider-not-configured", "provider-not-found", "missing-required-variables"] as const) {
  test(`PQ-R4 ${state} main Advisor configuration blocks only an actual rewrite`, async () => {
    const h = await fixture();
    try {
      const queryRoute = state === "missing" ? undefined : { ...readyRoute("advisor"), status: state,
        missingRequiredVariables: state === "missing-required-variables" ? ["API_KEY"] : [] };
      await assert.rejects(h.run({ queryRoute }), /Configure the main Advisor model for preparation query rewriting/);
      assert.equal(h.service.getSnapshot()?.status, "failed");
      assert.match(h.service.getSnapshot()?.error ?? "", /main Advisor/);
      assert.equal(h.queryRequests.length, 0);
      assert.equal(h.answerRequests.length, 0);
      assert.equal(h.queries.length, 0);
      assert.equal((await h.conversations.load("p", h.conversation.id)).messages.filter((m) => m.role === "assistant").length, 1);
      assert.equal((await h.run()).status, "committed", "fixing the configuration enables the next request");
      assert.equal(h.queryRequests.length, 1);
    } finally { h.close(); }
  });
}

for (const path of ["no-history", "inventory", "image", "recovery"] as const) {
  for (const configured of [false, true]) {
    test(`PQ-R4 ${path} skips rewrite with ${configured ? "not-ready" : "missing"} query route`, async () => {
      const recovered: Array<{ materialId: string; baseRevisionId: string }> = [];
      const h = await fixture({ history: path !== "no-history",
        answer: path === "recovery" ? async function* () {
          yield '<material_recovery_result>{"summary":"Recovered text for review.","materials":[{"materialId":"asset","extractedText":"Recovered fixture text","qualitySignals":[]}]}</material_recovery_result>';
        } : undefined,
        imageGateway: { async read() { return { base64: "fixture-image", mediaType: "image/png", sizeBytes: 1 }; } },
        materialExtraction: { async inspect(workspaceId, materialId) {
          return { candidate: { workspaceId, materialId, extension: "txt", revisionId: "r-asset", revision: 1,
            sourceChecksumSha256: "asset", status: "ready", reviewStatus: "unreviewed", qualitySignals: [] }, chunks: [] };
        }, async commitRecoveredText(input) { recovered.push({ materialId: input.materialId, baseRevisionId: input.baseRevisionId }); return undefined; } },
      });
      try {
        const overrides: Parameters<typeof h.run>[0] = {
          queryRoute: configured ? { ...readyRoute("advisor"), status: "missing-required-variables", missingRequiredVariables: ["API_KEY"] } : undefined,
        };
        if (path === "inventory") overrides.content = "What materials can you see now?";
        if (path === "image" || path === "recovery") {
          await h.material("asset", "personal-context");
          if (path === "image") {
            h.db.exec("UPDATE preparation_materials SET mime_type='image/png' WHERE id='asset'");
            h.route.supportsVision = true;
            overrides.image = { materialId: "asset", operation: "analyze" };
          } else {
            overrides.recovery = { materialIds: ["asset"] };
          }
        }
        assert.equal((await h.run(overrides)).status, "committed");
        assert.equal(h.queryRequests.length, 0);
        assert.equal(h.answerRequests.length, 1);
        assert.equal(h.answerRequests[0].selectedProvider.provider, "preparation-1");
        const snapshot = await h.snapshot();
        assert.equal(snapshot.retrieval.requestedProviderId, undefined);
        assert.equal(snapshot.retrieval.completion, undefined);
        if (path === "no-history" || path === "inventory") assert.equal(snapshot.retrieval.disposition, path);
        if (path === "image") assert.deepEqual(h.answerRequests[0].imagesBase64, [{ base64: "fixture-image", mediaType: "image/png" }]);
        if (path === "recovery") assert.deepEqual(recovered, [{ materialId: "asset", baseRevisionId: "r-asset" }]);
      } finally { h.close(); }
    });
  }
}

test("PQ-R3 both routes, provider definitions and variables freeze before the first await; next request uses changes", async () => {
  const entered = deferred(), release = deferred(), queryEntered = deferred(), queryRelease = deferred();
  let first = true;
  const h = await fixture({
    async beforeProcess() { if (first) { entered.resolve(); await release.promise; } },
    rewrite: async function* (input) {
      if (first) { queryEntered.resolve(); await queryRelease.promise; }
      yield* queryEvents(input);
    },
  });
  const pending = h.run();
  try {
    await entered.promise;
    const oldRoute = readyRoute("preparation"), oldQueryRoute = readyRoute("advisor");
    for (const [target, role] of [[h.route, "preparation"], [h.queryRoute, "advisor"]] as const) {
      const next = readyRoute(role, 2);
      Object.assign(target.provider!, next.provider);
      target.selectedProvider.provider = next.selectedProvider.provider;
      Object.assign(target.selectedProvider.variables, next.selectedProvider.variables);
      target.supportsVision = true;
      target.missingRequiredVariables.push("later-change");
    }
    release.resolve();
    await queryEntered.promise;
    assert.deepEqual(h.queryRequests[0].provider, oldQueryRoute.provider);
    assert.deepEqual(h.queryRequests[0].selectedProvider, oldQueryRoute.selectedProvider);
    // Replace the whole route contents while the query is pending, before answer construction.
    Object.assign(h.route, readyRoute("preparation", 3));
    Object.assign(h.queryRoute, readyRoute("advisor", 3));
    queryRelease.resolve();
    assert.equal((await pending).status, "committed");
    assert.deepEqual(h.answerRequests[0].provider, oldRoute.provider);
    assert.deepEqual(h.answerRequests[0].selectedProvider, oldRoute.selectedProvider);
    const initial = await h.snapshot();
    assert.equal(initial.providerId, "preparation-1");
    assert.equal(initial.retrieval.requestedProviderId, "advisor-1");
    assert.equal(initial.retrieval.requestedModelId, "advisor-1-model");
    first = false;
    await h.run();
    assert.deepEqual(h.queryRequests[1].provider, h.queryRoute.provider);
    assert.deepEqual(h.queryRequests[1].selectedProvider, h.queryRoute.selectedProvider);
    assert.deepEqual(h.answerRequests[1].provider, h.route.provider);
    assert.deepEqual(h.answerRequests[1].selectedProvider, h.route.selectedProvider);
    const next = await h.snapshot();
    assert.equal(next.providerId, "preparation-3");
    assert.equal(next.retrieval.requestedProviderId, "advisor-3");
    assert.equal(next.retrieval.requestedModelId, "advisor-3-model");
    assert.equal(h.queryRequests.length, 2);
  } finally { release.resolve(); queryRelease.resolve(); await pending.catch(() => {}); h.close(); }
});

for (const interruption of ["parent cancel", "operation cancel", "stale lease"] as const) {
  test(`PQ-R3 ${interruption} stops the Advisor query before retrieval or a late Preparation answer`, async () => {
    const entered = deferred(), release = deferred(), closed = deferred();
    const parent = new AbortController();
    const h = await fixture({ rewrite: async function* (input) {
      try {
        const b = builder(input);
        yield b.content(raw);
        entered.resolve();
        await release.promise;
        yield b.terminal({ status: "success", retryable: false });
      } finally { closed.resolve(); }
    } });
    const pending = h.run({ signal: parent.signal });
    const rejected = interruption === "stale lease" ? undefined : assert.rejects(pending, /cancelled/);
    try {
      await entered.promise;
      assert.equal(h.queryRequests[0].provider?.id, "advisor-1");
      if (interruption === "parent cancel") parent.abort();
      else if (interruption === "operation cancel") h.service.cancel();
      else h.db.exec("UPDATE preparation_conversations SET active_operation_id='new-owner',revision=revision+1");
      if (rejected) await rejected;
      release.resolve();
      await closed.promise;
      if (interruption === "stale lease") assert.equal((await pending).status, "stale");
      assert.equal(h.queryRequests[0].signal?.aborted, true);
      assert.equal(h.queryRequests.length, 1);
      assert.equal(h.queries.length, 0);
      assert.equal(h.answerRequests.length, 0);
      const detail = await h.conversations.load("p", h.conversation.id);
      assert.equal(detail.messages.filter((m) => m.role === "assistant").length, 1);
      if (interruption === "stale lease") assert.equal(detail.conversation.activeOperationId, "new-owner");
    } finally { release.resolve(); await pending.catch(() => {}); await closed.promise; h.close(); }
  });
}

for (const output of ["", '{"guidance":"unfinished']) {
  test(`PQ-R5 timeout preserves requested Advisor identity with ${output ? "partial" : "no"} output and no terminal`, async (t) => {
    const entered = deferred(), release = deferred(), closed = deferred();
    const h = await fixture({ rewrite: async function* (input) {
      try {
        const b = builder(input);
        if (output) yield b.content(output);
        entered.resolve();
        await release.promise;
        yield b.terminal({ status: "success", retryable: false });
      } finally { closed.resolve(); }
    } });
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000000 });
    const pending = h.run();
    try {
      await entered.promise;
      t.mock.timers.tick(14999);
      assert.equal(h.queries.length, 0);
      assert.equal(h.answerRequests.length, 0);
      t.mock.timers.tick(1);
      assert.equal((await pending).status, "committed");
      const snapshot = await h.snapshot();
      const trace = snapshot.retrieval;
      assert.equal(trace.disposition, "fallback");
      assert.equal(trace.durationMs, 15000);
      assert.equal(trace.requestedProviderId, "advisor-1");
      assert.equal(trace.requestedModelId, "advisor-1-model");
      assert.equal(trace.completion?.rawOutput, output);
      assert.equal(trace.completion?.providerTerminal, undefined);
      assert.equal(trace.completion?.timedOut, true);
      assert.equal(snapshot.providerId, "preparation-1");
      assert.deepEqual(JSON.parse(JSON.stringify(h.events.find((e) => e.name === "Preparation context composed")?.retrieval)), trace);
      assert.deepEqual(h.queries.map((q) => q.query), [originalQuery.toLowerCase(), originalQuery.toLowerCase()]);
      assert.equal(h.queryRequests[0].signal?.aborted, true);
      assert.equal(h.queryRequests.length, 1);
      assert.equal(h.answerRequests.length, 1);
      assert.doesNotMatch(JSON.stringify({ snapshot, events: h.events }), /secret-never-log|API_KEY|Authorization|variables|curl/);
      release.resolve();
      await closed.promise;
      assert.deepEqual(await h.snapshot(), snapshot);
      assert.equal(h.answerRequests.length, 1);
    } finally { release.resolve(); await pending.catch(() => {}); await closed.promise; t.mock.timers.reset(); h.close(); }
  });
}
