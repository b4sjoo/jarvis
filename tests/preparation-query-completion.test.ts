import assert from "node:assert/strict";
import test from "node:test";
import { AIResponseEventBuilder, type AIResponseTerminalInput } from "../src/lib/functions/ai-response-events.js";
import { createPreparationContextComposer } from "../src/lib/preparation/context-composer.js";
import { createPreparationConversationExecutionService } from "../src/lib/preparation/conversation-execution.js";
import type { PreparationFetchRequest, PreparationFetchResponseEvents } from "../src/lib/preparation/context-types.js";
import type { PreparationModelRoute } from "../src/lib/preparation/model-route.js";
import { createPreparationQueryRewriter } from "../src/lib/preparation/query-rewrite.js";
import { preparationPurposeFixture } from "./helpers/preparation-purpose-fixture.js";

const queries = { guidance: "iterate principle", "personal-context": "experiment alternative" };
const raw = JSON.stringify(queries);
const originalQuery = "Find another experience for this principle";
const route: PreparationModelRoute = {
  status: "ready", selectedProvider: { provider: "fixture", variables: { API_KEY: "fixture-secret-never-log" } },
  provider: { id: "fixture", name: "Fixture", curl: "unused" } as never,
  missingRequiredVariables: [], supportsVision: false,
};

function builder() {
  return new AIResponseEventBuilder("fixture", {
    requestId: "query-request", executionPlanId: "query-plan", modelId: "fixture-model", sessionId: "fixture",
    runtimeEpoch: 0, logicalQuestionUnitId: "query", logicalQuestionRevision: 1,
    attemptId: "query-attempt", attemptNumber: 1, maxAttempts: 1,
  });
}

async function fixture(rewrite: PreparationFetchResponseEvents) {
  const h = await preparationPurposeFixture();
  await h.seedHistory("Oracle iterate principle and an earlier experience.");
  const answerRequests: PreparationFetchRequest[] = [];
  let rewriteCalls = 0;
  const service = createPreparationConversationExecutionService({
    conversations: h.conversations, interviewProcesses: h.interviewProcesses, materials: h.materialRepo,
    contextComposer: createPreparationContextComposer({
      materials: h.contextRepo, materialInventory: h.materialRepo, retrieveKmb: h.retrieveKmb,
    }),
    materialExtraction: {
      async inspect() { throw new Error("No extraction"); },
      async commitCloudImageText() { throw new Error("No OCR"); },
      async commitRecoveredText() { throw new Error("No recovery"); },
      async flagQuality() { throw new Error("No promotion"); },
    },
    imageGateway: {
      async read() { throw new Error("No image"); },
      async readVisuals() { throw new Error("No visual recovery"); },
    },
    fetchQueryResponseEvents(input) {
      rewriteCalls++;
      assert.equal(input.requestOptions?.timeoutMs, 15000);
      assert.equal(input.requestOptions?.maxOutputTokens, 2048);
      assert.equal(input.requestOptions?.retryPolicy?.maxAttempts, 1);
      return rewrite(input);
    },
    fetchResponse: async function* (input) { answerRequests.push(input); yield "Answer from supplied sources."; },
  });
  return {
    ...h, service, answerRequests, rewriteCalls: () => rewriteCalls,
    run: (signal?: AbortSignal) => service.execute({ processId: "p", conversationId: h.conversation.id, content: originalQuery, route, signal }),
    async snapshot() {
      const detail = await h.conversations.load("p", h.conversation.id);
      const snapshot = detail.messages.at(-1)?.contextSnapshot;
      assert.ok(snapshot?.retrieval);
      return { ...snapshot, retrieval: snapshot.retrieval };
    },
  };
}

test("PQ-C1 final accepted success ends query consumption without advancing beyond terminal", async () => {
  let advancedPastTerminal = false, closed = false;
  const h = await fixture(async function* () {
    const b = builder();
    try {
      yield b.content(raw);
      yield b.terminal({ status: "success", retryable: false, completionSignal: "anthropic-message-stop" });
      advancedPastTerminal = true;
      throw new Error("Consumer advanced beyond final terminal");
    } finally { closed = true; }
  });
  try {
    assert.equal((await h.run()).status, "committed");
    assert.equal((await h.snapshot()).retrieval.disposition, "rewritten");
    assert.deepEqual(h.queries.map((q) => q.query), Object.values(queries));
    assert.equal(advancedPastTerminal, false);
    assert.equal(closed, true);
    assert.equal(h.rewriteCalls(), 1);
  } finally { h.close(); }
});

test("PQ-C2 nonfinal retrying success cannot authorize rewritten queries", async () => {
  const h = await fixture(async function* () {
    const b = builder();
    yield b.content(raw);
    const terminal = b.terminal({ status: "success", retryable: false });
    assert.equal(terminal.type, "terminal");
    terminal.outcome.final = false;
    terminal.outcome.disposition = "retrying";
    yield terminal;
  });
  try {
    await h.run();
    assert.equal((await h.snapshot()).retrieval.disposition, "fallback");
    assert.deepEqual(h.queries.map((q) => q.query), [originalQuery.toLowerCase(), originalQuery.toLowerCase()]);
    assert.equal(h.rewriteCalls(), 1);
  } finally { h.close(); }
});

test("PQ-C1 successful multichunk output is parsed once at terminal and persisted with consumer/transport timing", async (t) => {
  const parse = t.mock.method(JSON, "parse");
  const parses = () => parse.mock.calls.filter((call) => call.arguments[0] === raw).length;
  const h = await fixture(async function* () {
    const b = builder();
    t.mock.timers.tick(12);
    yield b.content(raw.slice(0, 20));
    t.mock.timers.tick(8);
    yield b.content(raw.slice(20));
    assert.equal(parses(), 0, "even complete JSON is not parsed on a content delta");
    t.mock.timers.tick(15);
    b.observeProviderMetadata({ usage: { input_tokens: 100, output_tokens: 20 }, stop_reason: "end_turn" });
    yield b.terminal({ status: "success", retryable: false, completionSignal: "anthropic-message-stop" });
  });
  try {
    await h.material("principle-source", "guidance", { content: "iterate principle guidance" });
    await h.material("experience-source", "personal-context", { content: "experiment alternative experience" });
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    await h.run();
    const snapshot = await h.snapshot();
    const trace = snapshot.retrieval;
    const c = trace.completion!;
    assert.equal(parses(), 1);
    assert.equal(c.requestStartedAt, 1_000_000);
    assert.equal(c.firstContentAt, 1_000_012);
    assert.equal(c.lastContentAt, 1_000_020);
    assert.equal(c.providerTerminalReceivedAt, 1_000_035);
    assert.equal(c.finishedAt, 1_000_035);
    assert.equal(trace.durationMs, 35);
    assert.equal(c.rawOutput, raw);
    assert.equal(c.outputTruncated, false);
    assert.equal(c.jsonValid, true);
    assert.equal(c.queriesValid, true);
    assert.equal(c.timedOut, false);
    assert.equal(c.parseFailure, undefined);
    assert.equal(c.requestId, "query-request");
    assert.equal(c.attemptId, "query-attempt");
    assert.deepEqual(c.providerTerminal, {
      requestId: "query-request", attemptId: "query-attempt", providerId: "fixture", modelId: "fixture-model",
      status: "success", disposition: "accepted", final: true, completionSignal: "anthropic-message-stop",
      startedAt: 1_000_000, firstContentAt: 1_000_012, lastContentAt: 1_000_020, finishedAt: 1_000_035,
      nativeFinishReason: "end_turn",
    });
    assert.deepEqual(trace.tokenUsage, { inputTokens: 100, outputTokens: 20 });
    assert.equal(trace.outputChars, raw.length);
    assert.equal(trace.historyMessageIds.length, 2);
    assert.ok(snapshot.operationId);
    assert.match(h.answerRequests[0].userMessage, /iterate principle guidance/);
    assert.match(h.answerRequests[0].userMessage, /experiment alternative experience/);
    assert.doesNotMatch(h.answerRequests[0].userMessage, /rawOutput|providerTerminal/);
    assert.doesNotMatch(JSON.stringify(trace), /fixture-secret-never-log|API_KEY|variables|curl/);
    assert.equal(h.rewriteCalls(), 1);
  } finally { t.mock.timers.reset(); h.close(); }
});

const ordinaryFailures: Array<{
  name: string; output: string; terminal?: AIResponseTerminalInput; jsonValid: boolean; queriesValid: boolean;
}> = [
  { name: "no content or terminal", output: "", jsonValid: false, queriesValid: false },
  { name: "incomplete JSON at success", output: '{"guidance":"unfinished', terminal: { status: "success", retryable: false }, jsonValid: false, queriesValid: false },
  { name: "complete JSON without terminal at EOF", output: raw, jsonValid: true, queriesValid: true },
  { name: "explicit transport failure after valid content", output: raw, terminal: { status: "failed", failureClass: "transport", retryable: true, completionSignal: "request-failure", safeErrorSummary: "Fixture transport failed" }, jsonValid: true, queriesValid: true },
  { name: "provider timeout after partial content", output: '{"guidance":', terminal: { status: "timed-out", retryable: true, completionSignal: "request-timeout" }, jsonValid: false, queriesValid: false },
  { name: "empty provider terminal", output: "", terminal: { status: "empty", retryable: false }, jsonValid: false, queriesValid: false },
  ...[
    { ...queries, extra: "unapproved field" }, { guidance: queries.guidance },
    { ...queries, guidance: " " }, { ...queries, guidance: "x".repeat(2001) },
    { ...queries, guidance: 1 }, [], null,
  ].map((value, index) => ({
    name: `valid JSON violates strict two-query contract ${index + 1}`, output: JSON.stringify(value),
    terminal: { status: "success" as const, retryable: false }, jsonValid: true, queriesValid: false,
  })),
];

for (const sample of ordinaryFailures) {
  test(`PQ-C1/C2 ${sample.name}: bounded diagnosis and original-query fallback`, async () => {
    const h = await fixture(async function* () {
      const b = builder();
      if (sample.output) yield b.content(sample.output);
      if (sample.terminal) yield b.terminal(sample.terminal);
    });
    try {
      assert.equal((await h.run()).status, "committed");
      const trace = (await h.snapshot()).retrieval;
      assert.equal(trace.disposition, "fallback");
      assert.equal(trace.completion?.rawOutput, sample.output);
      assert.equal(trace.completion?.jsonValid, sample.jsonValid);
      assert.equal(trace.completion?.queriesValid, sample.queriesValid);
      assert.equal(Boolean(trace.completion?.parseFailure), !sample.queriesValid);
      assert.equal(trace.completion?.providerTerminal?.status, sample.terminal?.status);
      assert.equal(trace.completion?.providerTerminal?.failureClass, sample.terminal?.failureClass);
      assert.equal(trace.completion?.timedOut, sample.terminal?.status === "timed-out");
      assert.equal(trace.completion?.firstContentAt !== undefined, Boolean(sample.output));
      assert.equal(trace.completion?.providerTerminalReceivedAt !== undefined, Boolean(sample.terminal));
      assert.deepEqual(h.queries.map((q) => q.query), [originalQuery.toLowerCase(), originalQuery.toLowerCase()]);
      assert.equal(h.answerRequests.length, 1);
      assert.equal(h.rewriteCalls(), 1);
    } finally { h.close(); }
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const output of ["", '{"guidance":"unfinished', raw]) {
  test(`PQ-C1 15s timeout with ${output ? output === raw ? "complete JSON" : "partial JSON" : "no content"} diagnoses once and ignores late terminal`, async (t) => {
    const waiting = deferred(), release = deferred(), closed = deferred();
    let querySignal: AbortSignal | undefined;
    const parse = t.mock.method(JSON, "parse");
    const parses = () => parse.mock.calls.filter((call) => call.arguments[0] === output).length;
    const h = await fixture(async function* (input) {
      querySignal = input.signal;
      const b = builder();
      try {
        t.mock.timers.tick(20);
        if (output) yield b.content(output);
        assert.equal(parses(), 0);
        waiting.resolve();
        await release.promise;
        yield b.terminal(output ? { status: "success", retryable: false } : { status: "empty", retryable: false });
      } finally { closed.resolve(); }
    });
    try {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 2_000_000 });
      const pending = h.run();
      await waiting.promise;
      t.mock.timers.tick(14979);
      assert.equal(h.answerRequests.length, 0);
      assert.equal(h.queries.length, 0);
      assert.equal(parses(), 0);
      t.mock.timers.tick(1);
      await pending;
      const snapshot = await h.snapshot();
      const c = snapshot.retrieval.completion!;
      assert.equal(snapshot.retrieval.disposition, "fallback");
      assert.match(snapshot.retrieval.failure!, /timed out/);
      assert.equal(snapshot.retrieval.durationMs, 15000);
      assert.equal(c.finishedAt - c.requestStartedAt, 15000);
      assert.equal(c.firstContentAt, output ? 2_000_020 : undefined);
      assert.equal(c.lastContentAt, c.firstContentAt);
      assert.equal(c.providerTerminal, undefined);
      assert.equal(c.providerTerminalReceivedAt, undefined);
      assert.equal(c.rawOutput, output);
      assert.equal(c.jsonValid, output === raw);
      assert.equal(c.queriesValid, output === raw);
      assert.equal(c.timedOut, true);
      assert.equal(querySignal?.aborted, true);
      assert.equal(parses(), 1);
      assert.equal(h.rewriteCalls(), 1);
      assert.deepEqual(h.queries.map((q) => q.query), [originalQuery.toLowerCase(), originalQuery.toLowerCase()]);
      release.resolve();
      await closed.promise;
      assert.equal(parses(), 1, "late terminal does not reparse output");
      assert.deepEqual(await h.snapshot(), snapshot);
      assert.equal(h.answerRequests.length, 1);
    } finally { release.resolve(); t.mock.timers.reset(); h.close(); }
  });
}

test("PQ-C1 raw diagnostics stay within 12000 characters even when a chunk exceeds the budget", async (t) => {
  const output = raw.padEnd(12000, " ") + "diagnostic-overflow-must-not-be-retained".repeat(1000);
  const parse = t.mock.method(JSON, "parse");
  let closed = false;
  const h = await fixture(async function* () {
    const b = builder();
    try { yield b.content(output); } finally { closed = true; }
  });
  try {
    await h.run();
    const trace = (await h.snapshot()).retrieval;
    assert.equal(trace.disposition, "fallback");
    assert.match(trace.failure!, /exceeded budget/);
    assert.equal(trace.outputChars, output.length);
    assert.equal(trace.completion?.rawOutput, output.slice(0, 12000));
    assert.equal(trace.completion?.outputTruncated, true);
    assert.equal(trace.completion?.jsonValid, true);
    assert.equal(trace.completion?.queriesValid, true);
    assert.equal(parse.mock.calls.filter((call) => call.arguments[0] === raw).length, 1);
    assert.doesNotMatch(JSON.stringify(trace), /diagnostic-overflow/);
    assert.equal(closed, true);
    assert.deepEqual(h.queries.map((q) => q.query), [originalQuery.toLowerCase(), originalQuery.toLowerCase()]);
  } finally { h.close(); }
});

test("PQ-C1 private raw diagnostic cannot become a later history fact or query/context input", async () => {
  const marker = "DIAGNOSTIC_ONLY_UNTRUSTED_STORY";
  const invalid = JSON.stringify({ ...queries, diagnosticOnly: marker });
  const requests: PreparationFetchRequest[] = [];
  const h = await fixture(async function* (input) {
    requests.push(input);
    const b = builder();
    yield b.content(requests.length === 1 ? invalid : raw);
    yield b.terminal({ status: "success", retryable: false });
  });
  try {
    await h.run();
    assert.equal((await h.snapshot()).retrieval.completion?.rawOutput, invalid);
    await h.run();
    for (const input of [...requests, ...h.answerRequests]) {
      assert.doesNotMatch(JSON.stringify({ history: input.history, systemPrompt: input.systemPrompt, userMessage: input.userMessage }), new RegExp(marker));
    }
    assert.doesNotMatch(JSON.stringify(h.queries), new RegExp(marker));
    assert.equal(requests.length, 2);
    assert.equal(h.answerRequests.length, 2);
  } finally { h.close(); }
});

for (const failure of ["authentication", "configuration", "aborted", "stale"] as const) {
  test(`PQ-C2 provider ${failure} remains visible/stopped with no retrieval or answer`, async () => {
    const h = await fixture(async function* () {
      const b = builder();
      yield b.content(raw);
      const terminal = b.terminal(failure === "stale"
        ? { status: "success", retryable: false }
        : failure === "aborted" ? { status: "aborted", retryable: false }
        : { status: "failed", failureClass: failure, retryable: false, safeErrorSummary: `Fixture ${failure}` });
      assert.equal(terminal.type, "terminal");
      if (failure === "stale") terminal.outcome.disposition = "stale";
      yield terminal;
    });
    try {
      await assert.rejects(h.run(), failure === "authentication" || failure === "configuration"
        ? new RegExp(`Fixture ${failure}`) : /Preparation query/);
      assert.equal(h.queries.length, 0);
      assert.equal(h.answerRequests.length, 0);
      assert.equal(h.rewriteCalls(), 1);
      assert.equal((await h.conversations.load("p", h.conversation.id)).messages.filter((m) => m.role === "assistant").length, 1);
    } finally { h.close(); }
  });
}

for (const interruption of ["parent cancel", "operation cancel", "stale lease"] as const) {
  test(`PQ-C2 ${interruption} after complete content cannot retrieve or commit a late answer`, async () => {
    const waiting = deferred(), release = deferred(), closed = deferred();
    const parent = new AbortController();
    const h = await fixture(async function* () {
      const b = builder();
      try {
        yield b.content(raw);
        waiting.resolve();
        await release.promise;
        yield b.terminal({ status: "success", retryable: false });
      } finally { closed.resolve(); }
    });
    try {
      const pending = h.run(parent.signal);
      const rejected = interruption === "stale lease" ? undefined : assert.rejects(pending, /cancelled/);
      await waiting.promise;
      if (interruption === "parent cancel") parent.abort();
      else if (interruption === "operation cancel") h.service.cancel();
      else h.db.exec("UPDATE preparation_conversations SET active_operation_id='new-owner',revision=revision+1");
      if (rejected) await rejected;
      release.resolve();
      await closed.promise;
      if (interruption === "stale lease") assert.equal((await pending).status, "stale");
      assert.equal(h.queries.length, 0);
      assert.equal(h.answerRequests.length, 0);
      assert.equal(h.rewriteCalls(), 1);
      const detail = await h.conversations.load("p", h.conversation.id);
      assert.equal(detail.messages.filter((m) => m.role === "assistant").length, 1);
      if (interruption === "stale lease") assert.equal(detail.conversation.activeOperationId, "new-owner");
    } finally { release.resolve(); h.close(); }
  });
}

test("PQ-C2 an already-cancelled parent never starts the actual query consumer", async () => {
  const parent = new AbortController();
  parent.abort();
  let calls = 0;
  const rewrite = createPreparationQueryRewriter({
    route, signal: parent.signal, assertCurrent: async () => {},
    fetchResponseEvents: async function* () { calls++; yield builder().content(raw); },
  });
  await assert.rejects(rewrite({ query: originalQuery, history: [], historyMessageIds: [], sourceRefs: [] }), /cancelled/);
  assert.equal(calls, 0);
});

test("PQ-C1 exact 12000-character boundary preserves existing JSON fence and query whitespace handling", async () => {
  const output = ("```json\n" + JSON.stringify({
    guidance: ` ${queries.guidance} `, "personal-context": ` ${queries["personal-context"]} `,
  }) + "\n```").padEnd(12000, " ");
  const rewrite = createPreparationQueryRewriter({
    route, assertCurrent: async () => {},
    fetchResponseEvents: async function* () {
      const b = builder();
      yield b.content(output.slice(0, 8000));
      yield b.content(output.slice(8000));
      yield b.terminal({ status: "success", retryable: false });
    },
  });
  const result = await rewrite({ query: originalQuery, history: [], historyMessageIds: [], sourceRefs: [] });
  assert.equal(result.disposition, "rewritten");
  assert.deepEqual(result.queries, queries);
  assert.equal(result.outputChars, 12000);
  assert.equal(result.completion?.rawOutput, output);
  assert.equal(result.completion?.outputTruncated, false);
  assert.equal(result.completion?.queriesValid, true);
});
