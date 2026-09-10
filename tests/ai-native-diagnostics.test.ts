import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import curl2Json from "@bany/curl-to-json";
import * as responseEvents from "../src/lib/functions/ai-response-events.js";
import * as common from "../src/lib/functions/common.function.js";
import { decodeServerSentEventStream } from "../src/lib/functions/server-sent-event-stream.js";
import { consumeRuntimeInferenceResponse, formatRuntimeInferenceProviderOutcomeForTrace } from "../src/lib/meeting/runtime-inference-response.js";
import * as typeLogic from "../src/lib/meeting/question-type-adjudication.js";
import { getRuntimeInferenceOperationDefinition, formatRuntimeInferenceOperationForTrace } from "../src/lib/meeting/runtime-inference.js";
import { SessionRecordingManager, type SessionRecordingInvoke } from "../src/lib/meeting/session-recording.js";
import type { MeetingAssistantSettings } from "../src/lib/meeting/types.js";

function loadModule(file: string, modules: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const code = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports, module: { exports }, AbortController, DOMException, Error,
    setTimeout, clearTimeout, ...globals,
    require: (name: string) => {
      assert.ok(name in modules, `uncontrolled import ${name}`);
      return modules[name];
    },
  }, { filename: file });
  return exports as any;
}

const text = "What is HNSW?";
const valid = JSON.stringify({ v: 1, t: "field-knowledge", c: 0.97, e: "HNSW" });
const request = typeLogic.buildQuestionTypeAdjudicationRequest({
  logicalQuestionUnit: {
    id: "lqu", revision: 1, sessionId: "session", runtimeEpoch: 1,
    currentTurnId: "turn", sourceTurnIds: ["turn"], normalizedText: text,
    sources: [{ turnId: "turn", text, startedAt: 1, endedAt: 2 }],
    startedAt: 1, updatedAt: 2, compositionReasons: ["independent-current-turn"],
    boundaryReason: "independent-current-turn", truncated: false,
  },
});

function sse(frames: unknown[], stop = "[DONE]") {
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + `data: ${stop}\n\n`);
}

function harness(responses: (() => Response)[], streaming = true, responseContentPath = "choices[0].delta.content", signal?: AbortSignal,
  origin?: { sourceKind: "voice" | "screen" | "mixed"; correctionOwned: boolean }) {
  const calls: any[] = [];
  const transport = loadModule("src/lib/functions/ai-response.function.ts", {
    "./common.function": common,
    "@tauri-apps/plugin-http": { fetch: () => assert.fail("unexpected native fetch") },
    "@bany/curl-to-json": { default: curl2Json },
    "../response-settings.constants": { RESPONSE_LENGTHS: [], LANGUAGES: [] },
    "../storage/response-settings.storage": { getResponseSettings: () => assert.fail("response settings disabled") },
    "@/config/constants": { MARKDOWN_FORMATTING_INSTRUCTIONS: "" },
    "./ai-response-events.js": responseEvents,
    "./server-sent-event-stream.js": { decodeServerSentEventStream },
  }, { fetch: async (_url: string, options: any) => {
    const index = calls.length;
    calls.push(JSON.parse(options.body));
    return responses[index]();
  } });
  const runtimeRequest = loadModule("src/lib/meeting/runtime-inference-request.ts", {
    "../functions/ai-response.function.js": transport,
    "./runtime-inference-response.js": { consumeRuntimeInferenceResponse },
  });
  const typeRequest = loadModule("src/lib/meeting/question-type-adjudication-request.ts", {
    "./runtime-inference-request.js": runtimeRequest,
    "./question-type-adjudication.js": typeLogic,
    "./runtime-inference.js": { getRuntimeInferenceOperationDefinition },
  });
  const params = {
    request,
    provider: { id: "fixture", streaming, responseContentPath,
      curl: `curl https://provider.invalid/chat -H 'Content-Type: application/json' -d '{"model":"fixture","max_tokens":512,"messages":[{"role":"user","content":"{{TEXT}}"}]}'` },
    selectedProvider: { provider: "fixture", variables: {} },
    signal: signal ?? new AbortController().signal, timeoutMs: 4000,
    readRetryDeadlineAt: () => Date.now() + 4000,
  };
  if (!origin) return { calls, traceBudget: undefined, run: () => typeRequest.requestQuestionTypeAdjudication(params) };
  const scheduled = loadSchedulerBudgetExecution(origin, typeRequest.requestQuestionTypeAdjudication, params);
  return { calls, ...scheduled };
}

function loadSchedulerBudgetExecution(origin: { sourceKind: string; correctionOwned: boolean }, requestFn: any, params: any) {
  const file = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
  let schedule: ts.ArrowFunction | undefined;
  const findSchedule = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "scheduleQuestionTypeAdjudication" &&
      node.initializer && ts.isCallExpression(node.initializer)) schedule = node.initializer.arguments[0] as ts.ArrowFunction;
    ts.forEachChild(node, findSchedule);
  };
  findSchedule(file);
  assert.ok(schedule && ts.isBlock(schedule.body));
  const declarations = schedule.body.statements.flatMap(s => ts.isVariableStatement(s) ? [...s.declarationList.declarations] : []);
  const initializer = (name: string) => {
    const declaration = declarations.find(d => d.name.getText(file) === name);
    assert.ok(declaration?.initializer, `missing production ${name}`);
    return declaration.initializer;
  };
  const env: Record<string, any> = { sourceKind: origin.sourceKind, forceRuntimeExecution: origin.correctionOwned,
    formatRuntimeInferenceOperationForTrace };
  const evaluate = (node: ts.Node) => vm.runInNewContext(ts.transpileModule(`(${node.getText(file)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, env);
  env.operationMetadata = evaluate(initializer("operationMetadata"));
  env.maxOutputTokens = evaluate(initializer("maxOutputTokens"));
  const base = initializer("baseMetadata");
  assert.ok(ts.isObjectLiteralExpression(base));
  const property = base.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(file) === "runtimeInferenceMaxOutputTokens");
  assert.ok(property && ts.isPropertyAssignment(property));
  const traceBudget = evaluate(property.initializer);
  let execute: ts.ArrowFunction | undefined;
  const findExecute = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === "execute" && ts.isArrowFunction(node.initializer)) execute = node.initializer;
    ts.forEachChild(node, findExecute);
  };
  findExecute(schedule.body);
  assert.ok(execute);
  Object.assign(env, { cachedCandidate: undefined, modelRoute: params, providerTimeoutMs: 4000,
    retryEnabled: origin.sourceKind === "voice" && !origin.correctionOwned,
    retryDeadlineAt: Date.now() + 4000, authorizeTypeOperation: () => ({ authorized: true }),
    requestQuestionTypeAdjudication: requestFn, readSelectedProviderModelId: () => "fixture",
    traceId: "trace", traceStoreRef: { current: { updateMetadata() {} } } });
  const run = evaluate(execute);
  return { traceBudget, run: () => run({ request, operationId: "type-budget", sessionId: "session",
    lease: { operationId: "type-budget", runtimeEpoch: 1 } }, params.signal) };
}

test("TB1 ordinary Voice scheduler passes 1024 through adapter, retry and actual body with matching trace", async () => {
  const run = harness([
    () => sse([{ choices: [{ delta: { content: '{"v":1' }, finish_reason: "length" }] }]),
    () => sse([{ choices: [{ delta: { content: valid }, finish_reason: "stop" }] }]),
  ], true, "choices[0].delta.content", undefined, { sourceKind: "voice", correctionOwned: false });
  const result = await run.run();
  assert.equal(result.parsed.ok, true);
  assert.equal(run.traceBudget, 1024);
  assert.deepEqual(run.calls.map(c => c.max_tokens), [1024, 1024]);
  assert.equal(result.providerAttempts.length, 2);
});

test("TB2 Screen, mixed, correction-owned and default adapter budgets stay 512", async () => {
  const origins = [undefined, { sourceKind: "voice" as const, correctionOwned: true },
    { sourceKind: "screen" as const, correctionOwned: false }, { sourceKind: "screen" as const, correctionOwned: true },
    { sourceKind: "mixed" as const, correctionOwned: false }];
  for (const origin of origins) {
    const run = harness([() => sse([{ choices: [{ delta: { content: valid } }] }])], true, "choices[0].delta.content", undefined, origin);
    await run.run();
    assert.deepEqual(run.calls.map(c => c.max_tokens), [512]);
    if (origin) assert.equal(run.traceBudget, 512);
  }
  assert.equal(getRuntimeInferenceOperationDefinition("question-type-adjudication").maxOutputTokens, 512);
});

test("native finish reason and usage survive actual transport, Type parser and trace projection", async () => {
  const run = harness([() => sse([
    { choices: [{ delta: { content: valid }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50,
      completion_tokens_details: { reasoning_tokens: 5 } } },
  ])]);
  const result = await run.run();
  assert.equal(result.parsed.ok, true, JSON.stringify(result));
  assert.equal(run.calls.length, 1);
  assert.equal(result.providerOutcome.nativeFinishReason, "stop");
  assert.deepEqual(JSON.parse(JSON.stringify(result.providerOutcome.tokenUsage)), {
    inputTokens: 30, outputTokens: 20, totalTokens: 50, reasoningTokens: 5,
  });
  const recorded = JSON.parse(JSON.stringify(formatRuntimeInferenceProviderOutcomeForTrace(result.providerOutcome, "type")));
  assert.equal(recorded.typeProviderNativeFinishReason, "stop");
  assert.deepEqual(recorded.typeProviderTokenUsage, result.providerOutcome.tokenUsage);
});

test("retry keeps native diagnostics per attempt without changing strict rejection", async () => {
  const run = harness([
    () => sse([{ choices: [{ delta: { content: '{"v":1,"t":"field-' }, finish_reason: "length" }],
      usage: { completion_tokens: 512 } }]),
    () => sse([{ choices: [{ delta: { content: valid }, finish_reason: "stop" }],
      usage: { completion_tokens: 24 } }]),
  ]);
  const result = await run.run();
  assert.equal(result.parsed.ok, true);
  assert.equal(run.calls.length, 2);
  assert.deepEqual(result.providerAttempts.map((a: any) => a.nativeFinishReason), ["length", "stop"]);
  assert.deepEqual(result.providerAttempts.map((a: any) => a.tokenUsage.outputTokens), [512, 24]);
  assert.equal(result.providerAttempts[0].final, false);
  assert.equal(result.providerAttempts[1].final, true);
  assert.notEqual(result.providerAttempts[0].attemptId, result.providerAttempts[1].attemptId);
});

test("native reasons are diagnostic and missing metadata remains absent", async () => {
  for (const metadata of [{}, { finish_reason: "length" }, { finish_reason: { bad: true } }]) {
    const run = harness([() => sse([{ choices: [{ delta: { content: valid }, ...metadata }] }])]);
    const result = await run.run();
    assert.equal(result.parsed.ok, true);
    assert.equal(run.calls.length, 1);
    assert.equal(result.providerOutcome.status, "success");
    assert.equal(result.providerOutcome.completionSignal, "openai-done");
    assert.equal(result.providerOutcome.tokenUsage, undefined);
    assert.equal(result.providerOutcome.nativeFinishReason, typeof metadata.finish_reason === "string" ? metadata.finish_reason : undefined);
  }
});

test("Anthropic cumulative usage is merged, not summed or copied from arbitrary fields", async () => {
  const run = harness([() => sse([
    { type: "message_start", message: { usage: { input_tokens: 30, output_tokens: 0 } } },
    { type: "content_block_delta", delta: { text: valid } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 25 } },
    { type: "message_delta", usage: { output_tokens: 25, input_tokens: "bad", total_tokens: -1, secret: "do-not-copy" } },
  ], JSON.stringify({ type: "message_stop" }))], true, "delta.text");
  const result = await run.run();
  assert.equal(result.parsed.ok, true);
  assert.equal(result.providerOutcome.nativeFinishReason, "end_turn");
  assert.equal(result.providerOutcome.completionSignal, "anthropic-message-stop");
  assert.deepEqual(result.providerOutcome.tokenUsage, { inputTokens: 30, outputTokens: 25 });
});

test("nonstreaming native Gemini retains native reason and supplied usage only", async () => {
  const run = harness([() => Response.json({
    candidates: [{ content: { parts: [{ text: valid }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 25, thoughtsTokenCount: 7 },
  })], false, "candidates[0].content.parts[0].text");
  const result = await run.run();
  assert.equal(result.parsed.ok, true);
  assert.equal(result.providerOutcome.nativeFinishReason, "STOP");
  assert.deepEqual(result.providerOutcome.tokenUsage, { inputTokens: 30, outputTokens: 25, reasoningTokens: 7 });
  assert.equal(result.providerOutcome.tokenUsage.totalTokens, undefined);
});

test("diagnostic frames preserve request, content, parse and attempt count", async () => {
  const plain = harness([() => sse([{ choices: [{ delta: { content: valid } }] }])]);
  const observed = harness([() => sse([
    { choices: [{ delta: { content: valid }, finish_reason: "stop" }] },
    { usage: null }, { usage: { completion_tokens: "wrong" } },
    { usage: { prompt_tokens: 0, completion_tokens: 25 } },
    { usage: { prompt_tokens: 0, completion_tokens: 25 } },
  ])]);
  const left = await plain.run();
  const right = await observed.run();
  assert.deepEqual(observed.calls, plain.calls);
  assert.equal(right.rawOutput, left.rawOutput);
  assert.deepEqual(right.parsed, left.parsed);
  assert.equal(right.providerOutcome.status, left.providerOutcome.status);
  assert.equal(right.providerAttempts.length, left.providerAttempts.length);
  assert.deepEqual(right.providerOutcome.tokenUsage, { inputTokens: 0, outputTokens: 25 });
});

test("cancellation retains already observed diagnostics without retry or candidate publication", async () => {
  const abort = new AbortController();
  const run = harness([() => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
        choices: [{ delta: { content: '{"v":1' } }], usage: { completion_tokens: 3 },
      })}\n\n`));
      setTimeout(() => {
        abort.abort();
        controller.error(new DOMException("controlled abort", "AbortError"));
      }, 10);
    },
  }))], true, "choices[0].delta.content", abort.signal);
  await assert.rejects(run.run(), (error: any) => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.attempts.length, 1);
    assert.equal(error.attempts[0].status, "aborted");
    assert.deepEqual(error.attempts[0].tokenUsage, { outputTokens: 3 });
    assert.equal(error.attempts[0].text, undefined);
    return true;
  });
  assert.equal(run.calls.length, 1);
});

test("diagnostics survive the actual recording writer without waiting for disk", async () => {
  for (const mode of ["normal", "disabled", "blocked", "failed"] as const) {
    const writes: Array<{ command: string; args: Record<string, unknown> }> = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const invoke: SessionRecordingInvoke = async <T>(command: string, args: Record<string, unknown> = {}) => {
      writes.push({ command, args });
      if (command === "start_meeting_session_recording") return `/recordings/${args.folderName}` as T;
      if (args.relativePath === "taxonomy/question-type-adjudications.jsonl") {
        if (mode === "blocked") await gate;
        if (mode === "failed") throw new Error("controlled disk error");
      }
      return "written" as T;
    };
    const manager = new SessionRecordingManager(undefined, invoke);
    if (mode !== "disabled") await manager.start({
      meetingSessionId: "session",
      settings: { codingModel: { enabled: false, provider: "", variables: {} },
        taxonomyAdjudication: { enabled: true, provider: "", variables: {} } } as unknown as MeetingAssistantSettings,
      providerSummary: { hasMainProvider: false, hasCodingProvider: false, hasTaxonomyAdjudicationProvider: false,
        hasSttProvider: false, mainSupportsImages: false, codingSupportsImages: false },
    });
    const now = Date.now();
    manager.recordTrace({ id: "type-trace", kind: "voice", status: "success", startedAt: now,
      endedAt: now + 1, durationMs: 1, steps: [], inputs: [], outputs: [], metadata: {} }, "manual");
    const run = harness([() => sse([{ choices: [{ delta: { content: valid }, finish_reason: "stop" }],
      usage: { completion_tokens: 25 } }])]);
    const result = await run.run();
    manager.recordQuestionTypeAdjudicationDecision({ traceId: "type-trace", metadata: {
      questionTypeAdjudicationAttempts: result.providerAttempts.map((attempt: any) =>
        formatRuntimeInferenceProviderOutcomeForTrace(attempt, "questionTypeAdjudication")),
    } });
    assert.equal(result.parsed.ok, true);
    assert.equal(run.calls.length, 1);
    // Foreground work has finished while the controlled write is still blocked.
    release();
    if (mode !== "disabled") await manager.stop("test-complete");
    const records = writes.filter(w => w.args.relativePath === "taxonomy/question-type-adjudications.jsonl");
    assert.equal(records.length, mode === "disabled" ? 0 : 1);
    if (records.length) {
      const payload = JSON.parse(String(records[0].args.content ?? records[0].args.payload));
      assert.equal(payload.metadata.questionTypeAdjudicationAttempts[0].questionTypeAdjudicationProviderNativeFinishReason, "stop");
      assert.deepEqual(payload.metadata.questionTypeAdjudicationAttempts[0].questionTypeAdjudicationProviderTokenUsage, { outputTokens: 25 });
    }
  }
});
