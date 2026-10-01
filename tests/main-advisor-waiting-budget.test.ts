import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import ts from "typescript";
import type { AIResponseEvent, AIResponseBudgetObservation } from "../src/lib/functions/ai-response-events.js";
import type { AIResponseParams } from "../src/lib/functions/ai-response.function.js";
import { buildCompactTraceSummary } from "../src/lib/meeting/session-recording.js";
import { buildModelGenerationIdentityForTrace, formatModelGenerationBudgetObservationForTrace, formatModelGenerationTerminalForTrace } from "../src/lib/meeting/model-generation-telemetry.js";
import { ManualScheduler } from "./helpers/manual-scheduler.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import { ManualAdviseDisplay } from "../src/lib/meeting/manual-advise-display.js";
import { commitStableAnswerRevision } from "../src/lib/meeting/stable-answer.js";
import { buildMeetingAnswerDisplayModel } from "../src/lib/meeting/meeting-answer-display.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import { decideStagedAnswerPartial, formatStagedAnswerDeliveryForTrace } from "../src/lib/meeting/staged-answer-delivery.js";
import { generationFailureDispositionFromProviderStatus } from "../src/lib/meeting/generation-result-ledger.js";
import { formatTaskBoundaryCandidateForTrace, taskBoundarySurvivesAdvisorOutcome } from "../src/lib/meeting/task-boundary-transaction.js";
import { formatSourceOwnedDurableTransitionForTrace, sourceOwnedDurableTransitionSurvivesModelOutcome } from "../src/lib/meeting/source-owned-transition-runtime.js";

const require = createRequire(path.join(process.cwd(), "package.json"));
const compiled = buildSync({ stdin: { contents: `export {fetchAIResponseEvents} from './src/lib/functions/ai-response.function';
  export {AdvisorEngine} from './src/lib/meeting/advisor-engine';
  export {MeetingAIResponseOutcomeError} from './src/lib/meeting/meeting-ai-response';`, loader: "ts", resolveDir: process.cwd() },
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent", alias: { "@": path.join(process.cwd(), "src") } });
const module = { exports: {} as {
  fetchAIResponseEvents: (input: AIResponseParams) => AsyncIterable<AIResponseEvent>;
  AdvisorEngine: new () => import("../src/lib/meeting/advisor-engine.js").AdvisorEngine;
  MeetingAIResponseOutcomeError: typeof import("../src/lib/meeting/meeting-ai-response.js").MeetingAIResponseOutcomeError;
} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(require, module, module.exports);
const { fetchAIResponseEvents, AdvisorEngine } = module.exports;
const hook = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
const declarations = hook.statements.filter(n => (ts.isFunctionDeclaration(n) && n.name?.text === "getMeetingModelRequestOptions") ||
  (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => ["CODING_MODEL_REQUEST_TIMEOUT_MS", "CODING_MODEL_MAX_OUTPUT_TOKENS", "MAIN_ADVISOR_PROGRESS_BUDGET"].includes(d.name.getText(hook)))));
assert.equal(declarations.length, 4);
const getOptions = new Function(ts.transpileModule(declarations.map(n => n.getText(hook)).join("\n") + "\nreturn getMeetingModelRequestOptions;", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText)() as (route: { route: "main" | "coding-override" }, origin: "advisor" | "screen", observer?: (o: AIResponseBudgetObservation) => void) => AIResponseParams["requestOptions"];
const provider = { id: "synthetic", streaming: true, responseContentPath: "choices[0].message.content",
  curl: `curl https://waiting.fixture/model -H 'Content-Type: application/json' -d '${JSON.stringify({model: "fixture",messages: [{role:"user",content:"{{TEXT}}"}]})}'` };
const selectedProvider = { provider: "synthetic", variables: {} };
const base = { provider, selectedProvider, userMessage: "Explain the queue.", applyResponseSettings: false };
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 5000 && !condition(); i++) await Promise.resolve();
  assert.ok(condition(), "the controlled stream must reach the expected event before advancing time");
};

function fixture(t: TestContext, mode: "stream" | "headers" | "json" | "http-error" = "stream") {
  const clock = new ManualScheduler();
  let timerSchedules = 0;
  t.mock.method(Date, "now", () => 1_000_000 + clock.now());
  t.mock.method(globalThis, "setTimeout", (callback: () => void, ms = 0) => { timerSchedules++; return clock.schedule(ms, callback); });
  t.mock.method(globalThis, "clearTimeout", (id: number) => clock.cancel(id));
  const requests: Array<{ signal?: AbortSignal | null; push: (data: string) => void; end: () => void; cancelled: boolean; body: unknown }> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const request = { signal: init.signal, push: (_data: string) => {}, end: () => {}, cancelled: false, body: JSON.parse(String(init.body)) };
    requests.push(request);
    if (mode === "headers") return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => {
      request.cancelled = true; reject(new DOMException("Aborted", "AbortError"));
    }, { once: true }));
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel() { closed = true; request.cancelled = true; } });
    request.push = data => { if (!closed) controller.enqueue(new TextEncoder().encode(data)); };
    request.end = () => { if (!closed) { closed = true; controller.close(); } };
    init.signal?.addEventListener("abort", () => {
      request.cancelled = true;
      if (!closed) { closed = true; controller.error(new DOMException("Aborted", "AbortError")); }
    }, { once: true });
    return new Response(stream, { status: mode === "http-error" ? 503 : 200 });
  });
  const observations: AIResponseBudgetObservation[] = [];
  const start = (options = getOptions({ route: "main" }, "advisor", o => observations.push(o)), signal?: AbortSignal) => {
    const events: AIResponseEvent[] = [];
    let finished = false;
    const done = (async () => { for await (const event of fetchAIResponseEvents({ ...base, provider: mode === "json" ? { ...provider, streaming: false } : provider,
      requestOptions: options, signal })) events.push(event); finished = true; })();
    return { events, done, finished: () => finished };
  };
  const advance = async (ms: number) => { clock.advanceBy(ms); await flush(); };
  const content = (text: string, index = 0) => requests[index].push(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  const terminal = (events: AIResponseEvent[]) => {
    const terminals = events.filter(e => e.type === "terminal"); assert.equal(terminals.length, 1);
    return terminals[0].outcome;
  };
  return { clock, requests, observations, start, advance, content, terminal, schedules: () => timerSchedules };
}

test("201B route policy changes only ordinary Advisor Main", () => {
  const main = getOptions({ route: "main" }, "advisor")!;
  assert.deepEqual(main.progressBudget, { firstContentTimeoutMs: 15000, contentIdleTimeoutMs: 15000, totalElapsedWarningMs: 30000 });
  assert.equal(main.timeoutMs, undefined);
  assert.equal(main.retryPolicy, undefined);
  assert.equal(getOptions({ route: "main" }, "screen"), undefined);
  for (const origin of ["advisor", "screen"] as const) assert.deepEqual(getOptions({ route: "coding-override" }, origin), {
    timeoutMs: 120000, maxOutputTokens: 16384,
  });
  const calls: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText(hook) === "getMeetingModelRequestOptions") calls.push(n);
    ts.forEachChild(n, visit);
  };
  visit(hook);
  assert.deepEqual(calls.map(c => c.arguments.slice(0, 2).map(a => a.getText(hook))), [
    ["advisorModelRoute", '"advisor"'], ["screenModelRoute", '"screen"'],
  ]);
});

for (const mode of ["headers", "stream", "json", "http-error"] as const) {
  test(`201B first-content timeout releases ${mode} with one typed terminal`, async t => {
    const f = fixture(t, mode), run = f.start(); await flush();
    await f.advance(14999); assert.equal(run.finished(), false);
    await f.advance(1); await run.done;
    const outcome = f.terminal(run.events);
    assert.equal(outcome.status, "timed-out"); assert.equal(outcome.budgetTimeout?.kind, "first-content");
    assert.equal(outcome.budgetTimeout?.observedAt, 1015000); assert.equal(outcome.text, undefined);
    assert.equal(f.requests.length, 1); assert.equal(f.clock.pendingCount(), 0);
    assert.equal(f.observations.length, 1);
  });
}

test("201B usage/heartbeat/empty/malformed frames never extend first-content budget", async t => {
  const f = fixture(t), run = f.start(); await flush();
  for (let i = 0; i < 3; i++) {
    await f.advance(4000);
    f.requests[0].push(': ping\n\ndata: {"usage":{"output_tokens":1}}\n\ndata: not-json\n\ndata: {"choices":[{"delta":{"content":""}}]}\n\n');
    await flush();
  }
  await f.advance(3000); await run.done;
  assert.equal(f.terminal(run.events).budgetTimeout?.kind, "first-content");
  assert.equal(run.events.some(e => e.type === "content-delta"), false);
});

test("201B subsequent content advances idle deadline without per-chunk timer churn", async t => {
  const f = fixture(t), run = f.start(); await flush();
  await f.advance(1000); f.content("first"); await flush();
  const schedules = f.schedules();
  for (let i = 0; i < 100; i++) f.content("x");
  await until(() => run.events.length === 101); assert.equal(f.schedules(), schedules);
  await f.advance(14999); f.content("last"); await flush();
  await f.advance(1); assert.equal(run.finished(), false, "the old idle deadline has no authority");
  await f.advance(14998); assert.equal(run.finished(), false);
  await f.advance(1); await run.done;
  const outcome = f.terminal(run.events);
  assert.equal(outcome.status, "timed-out"); assert.equal(outcome.budgetTimeout?.kind, "content-idle");
  assert.equal(outcome.lastContentAt, 1015999); assert.equal(outcome.budgetTimeout?.deadlineAt, 1030999);
  assert.equal(outcome.text, undefined); assert.equal(outcome.observedContentChars, 109);
  assert.equal(f.observations.filter(o => o.kind === "total-elapsed").length, 1);
  assert.equal(f.clock.pendingCount(), 0);
});

test("201B continuous output survives 60 seconds and observes total elapsed only once", async t => {
  const f = fixture(t), run = f.start(); await flush();
  for (let i = 0; i < 12; i++) {
    await f.advance(5000); f.content("part"); await flush(); assert.equal(run.finished(), false);
  }
  assert.equal(f.observations.length, 1); assert.equal(f.observations[0].kind, "total-elapsed");
  assert.equal(f.observations[0].observedAt, 1030000);
  f.requests[0].push("data: [DONE]\n\n"); await run.done;
  const outcome = f.terminal(run.events);
  assert.equal(outcome.status, "success"); assert.equal(outcome.text, "part".repeat(12));
  assert.equal(outcome.totalElapsedWarningAt, 1030000); assert.equal(outcome.budgetTimeout, undefined);
  assert.equal(f.clock.pendingCount(), 0);
  await f.advance(60000); assert.equal(f.observations.length, 1);
});

for (const finish of ["done", "anthropic", "eof"] as const) {
  test(`201B ${finish} finishes immediately and cleans timers even without HTTP close`, async t => {
    const f = fixture(t), run = f.start(); await flush(); f.content("Answer"); await flush();
    if (finish === "eof") f.requests[0].end();
    else f.requests[0].push(finish === "done" ? "data: [DONE]\n\n" : 'data: {"type":"message_stop"}\n\n');
    await run.done; assert.equal(f.terminal(run.events).status, "success");
    assert.equal(f.clock.pendingCount(), 0); await f.advance(60000); assert.equal(f.observations.length, 0);
  });
}

test("201B old cancellation and timers cannot abort the successor request", async t => {
  const f = fixture(t); const aController = new AbortController();
  const a = f.start(undefined, aController.signal); await flush(); await f.advance(10000);
  aController.abort(); await a.done; assert.equal(f.terminal(a.events).status, "aborted");
  const b = f.start(); await flush(); await f.advance(5000);
  assert.equal(b.finished(), false); assert.equal(f.requests[1].signal?.aborted, false);
  f.content("new", 1); await flush(); f.requests[1].push("data: [DONE]\n\n"); await b.done;
  assert.equal(f.terminal(b.events).status, "success"); assert.equal(f.observations.length, 0);
  await f.advance(60000); assert.equal(f.clock.pendingCount(), 0);
});

test("201B timeout wins once; late chunks and external cancellation cannot revive it", async t => {
  const f = fixture(t); const controller = new AbortController(); const run = f.start(undefined, controller.signal);
  await flush(); await f.advance(15000); controller.abort(); f.content("late"); f.requests[0].push("data: [DONE]\n\n");
  await run.done; assert.equal(f.terminal(run.events).status, "timed-out");
  assert.equal(run.events.filter(e => e.type === "content-delta").length, 0);
});

test("201B does not add timers or shorten an unbudgeted non-Meeting request", async t => {
  const f = fixture(t), run = f.start({}); await flush();
  assert.equal(f.clock.pendingCount(), 0); await f.advance(60000); assert.equal(run.finished(), false);
  f.content("unchanged"); f.requests[0].end(); await run.done;
  assert.equal(f.terminal(run.events).status, "success"); assert.equal(f.observations.length, 0);
});

test("201B preserves the legacy non-streaming cancellation result outside its policy", async t => {
  const f = fixture(t, "json"), controller = new AbortController();
  const run = f.start({}, controller.signal); await flush(); controller.abort(); await run.done;
  const outcome = f.terminal(run.events);
  assert.equal(outcome.status, "failed"); assert.equal(outcome.failureClass, "provider-response-parse");
  assert.equal(outcome.budgetTimeout, undefined);
});

test("201B a signal already cancelled starts no fetch and owns no timer", async t => {
  const f = fixture(t), controller = new AbortController(); controller.abort();
  const run = f.start(undefined, controller.signal); await run.done;
  assert.equal(f.terminal(run.events).status, "aborted");
  assert.equal(f.requests.length, 0); assert.equal(f.clock.pendingCount(), 0);
});

test("201B empty EOF keeps its existing empty outcome instead of inventing a timeout", async t => {
  const f = fixture(t), run = f.start(); await flush(); f.requests[0].end(); await run.done;
  assert.equal(f.terminal(run.events).status, "empty"); assert.equal(f.observations.length, 0);
  assert.equal(f.clock.pendingCount(), 0);
});

test("201B records timer lateness separately from the configured deadline", async t => {
  const f = fixture(t), run = f.start(); await flush(); await f.advance(20000); await run.done;
  const observation = f.terminal(run.events).budgetTimeout!;
  assert.equal(observation.limitMs, 15000);
  assert.equal(observation.deadlineAt, 1015000);
  assert.equal(observation.observedAt, 1020000);
  assert.equal(f.clock.pendingCount(), 0);
});

test("201B normal content/body are identical with and without the policy", async t => {
  const f = fixture(t);
  const old = f.start({}); await flush(); f.content("Answer: same"); f.requests[0].end(); await old.done;
  const current = f.start(); await flush(); f.content("Answer: same", 1); f.requests[1].end(); await current.done;
  assert.deepEqual(f.requests[0].body, f.requests[1].body);
  assert.equal(f.terminal(old.events).text, f.terminal(current.events).text);
  assert.equal(f.terminal(current.events).status, "success"); assert.equal(f.requests.length, 2);
});

test("201B existing absolute Coding timeout remains 120 seconds", async t => {
  const f = fixture(t), run = f.start(getOptions({ route: "coding-override" }, "advisor")); await flush();
  await f.advance(119999); assert.equal(run.finished(), false);
  await f.advance(1); await run.done;
  const outcome = f.terminal(run.events); assert.equal(outcome.status, "timed-out"); assert.equal(outcome.budgetTimeout, undefined);
  assert.equal(f.observations.length, 0); assert.equal(f.clock.pendingCount(), 0);
});

test("201B budget observation cannot gain cancellation authority by throwing", async t => {
  const f = fixture(t); t.mock.method(console, "warn", () => {});
  const run = f.start(getOptions({ route: "main" }, "advisor", () => { throw new Error("logger unavailable"); })); await flush();
  for (let i = 0; i < 7; i++) { await f.advance(5000); f.content("x"); await flush(); }
  f.requests[0].end(); await run.done; assert.equal(f.terminal(run.events).status, "success");
});

test("201B production AdvisorEngine consumes idle timeout as failure, never a candidate", async t => {
  const f = fixture(t); const events: unknown[] = [], outcomes: any[] = [];
  const run = (async () => { try {
    for await (const event of new AdvisorEngine().streamSuggestion({ requestId: "visible-job", provider, selectedProvider,
      promptContext: { transcript: "Them: Explain the queue.", screenContext: "", taskRuntime: { revision: 0 } },
      requestOptions: getOptions({ route: "main" }, "advisor"), trace: { onTerminal: o => outcomes.push(o) } })) events.push(event);
    return undefined;
  } catch (error) { return error; } })();
  await flush(); f.content("Answer: Partial."); await flush(); await f.advance(15000);
  const error = await run;
  assert.equal((error as any).outcome.status, "timed-out"); assert.equal(outcomes.length, 1);
  assert.deepEqual(events.map((e: any) => e.type), ["content-delta"]);
  assert.equal(f.clock.pendingCount(), 0);
});

for (const kind of ["first-content", "content-idle", "total-elapsed"] as const) {
test(`201B actual Hook ${kind} observation round-trips into recording`, async t => {
  const f = fixture(t);
  let declaration: ts.VariableDeclaration | undefined;
  const visit = (n: ts.Node) => { if (ts.isVariableDeclaration(n) && n.name.getText(hook) === "advisorModelRequestOptions") declaration = n; ts.forEachChild(n, visit); };
  visit(hook); assert.ok(declaration?.initializer);
  const metadata: Record<string, unknown> = {};
  const steps: any[] = [];
  const traceStore = { updateMetadata: (_id: string, m: object) => Object.assign(metadata, m),
    startStep: (_id: string, name: string, m: object) => { steps.push({ id: "budget-step", name, startedAt: Date.now(), status: "running", metadata: m }); return "budget-step"; },
    finishStep: (_id: string, _step: string, status: string) => { steps.at(-1).status = status; } };
  const expression = ts.transpileModule(`return ${declaration.initializer.getText(hook)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const options = new Function("getMeetingModelRequestOptions", "advisorModelRoute", "traceId", "traceStoreRef", "formatModelGenerationBudgetObservationForTrace", expression)(
    getOptions, { route: "main" }, "trace-budget", { current: traceStore }, formatModelGenerationBudgetObservationForTrace);
  const run = f.start(options); await flush();
  Object.assign(metadata, buildModelGenerationIdentityForTrace({ requestOrigin: "advisor", modelRoute: "main", streamingConfigured: true,
    promptContractId: "meeting-answer:compact-spoken", promptContractVersion: "fixture", requestOptions: options }));
  if (kind === "total-elapsed") {
    for (let i = 0; i < 6; i++) { await f.advance(5000); f.content("x"); await flush(); }
    f.requests[0].push("data: [DONE]\n\n");
  } else {
    if (kind === "content-idle") { f.content("x"); await flush(); }
    await f.advance(15000);
  }
  await run.done;
  Object.assign(metadata, formatModelGenerationTerminalForTrace(f.terminal(run.events)));
  assert.equal(steps.length, 1); assert.equal(steps[0].status, kind === "total-elapsed" ? "success" : "error");
  const summary = buildCompactTraceSummary({ sessionId: "s", trigger: "manual", traceExportPath: "trace.json", summaryPath: "summary.json",
    trace: { id: "trace-budget", kind: "voice", status: "error", startedAt: 1000000, endedAt: Date.now(), steps, inputs: [], outputs: [], metadata } });
  assert.equal(summary.modelGeneration?.firstContentTimeoutMs, 15000);
  assert.equal(summary.modelGeneration?.contentIdleTimeoutMs, 15000);
  assert.equal(summary.modelGeneration?.totalElapsedWarningMs, 30000);
  assert.equal(summary.modelGeneration?.budgetKind, kind);
  assert.equal(summary.modelGeneration?.budgetObservedAt, kind === "total-elapsed" ? 1030000 : 1015000);
  assert.equal(summary.modelGeneration?.budgetRequestId, f.terminal(run.events).requestId);
  assert.equal(summary.modelGeneration?.completionSignal, kind === "total-elapsed" ? "openai-done" : "request-timeout");
  if (kind === "total-elapsed") assert.equal(summary.modelGeneration?.totalElapsedWarningAt, 1030000);
});
}

function hookNode(predicate: (node: ts.Node) => boolean) {
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) matches.push(node); ts.forEachChild(node, visit); };
  visit(hook); assert.equal(matches.length, 1);
  return matches[0];
}
function hookCallback(name: string, env: Record<string, unknown>) {
  const node = hookNode(n => ts.isVariableDeclaration(n) && n.name.getText(hook) === name) as ts.VariableDeclaration;
  const expr = ts.isCallExpression(node.initializer!) ? node.initializer.arguments[0] : node.initializer!;
  return new Function(...Object.keys(env), ts.transpileModule(`return ${expr.getText(hook)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText)(...Object.values(env));
}

for (const displayCase of ["visible-partial", "pinned-stream", "pinned-stable", "delivery-held", "superseded"] as const) {
  test(`201B actual Advisor failure catch preserves stable/task/artifacts: ${displayCase}`, async t => {
    const f = fixture(t), engine = new AdvisorEngine();
    const pendingError = (async () => { try {
      for await (const _event of engine.streamSuggestion({ requestId: "failed-job", provider, selectedProvider,
        promptContext: { transcript: "Them: Explain the queue", screenContext: "", taskRuntime: { revision: 0 } },
        requestOptions: getOptions({ route: "main" }, "advisor") })) { /* The production stream cannot yield a successful candidate. */ }
      return undefined;
    } catch (error) { return error; } })();
    await flush(); f.content("Answer: unfinished"); await flush(); await f.advance(15000);
    const error = await pendingError; assert.ok(error instanceof module.exports.MeetingAIResponseOutcomeError);
    const manager = new MeetingContextManager(); manager.reset({ sessionId: "s" });
    manager.commitTaskRuntimeTransition({ id: "committed-parent", transition: "create-parent", reason: "fixture", parent: {
      id: "p", source: "voice", stableKind: "general-system-design", topic: "Queue", playbookPhase: "design_framing",
      phaseProgress: {}, supportedFactAnchors: [], createdAt: 1, updatedAt: 1, revisions: 2,
    } });
    const taskBefore = manager.getTaskRuntimeState();
    const content = "Answer: stable answer\n\nCode:\n```ts\nkeep();\n```\n\nWhiteboard: retained diagram";
    const parsed = parseMeetingAnswer(content);
    const stable = commitStableAnswerRevision({ candidate: { id: "old", kind: "answer", content, meetingAnswer: parsed,
      createdAt: 1, basedOnTurnIds: [], basedOnObservationIds: [], confidence: "high" },
      taskId: "p", sessionId: "s", runtimeEpoch: 1, logicalQuestionUnitId: "A", logicalQuestionRevision: 1,
      revision: 1, authorizedArtifacts: ["answer", "code", "whiteboard"] }); assert.ok(stable);
    const old = { target: { sessionId: "s", logicalQuestionUnitId: "A", logicalQuestionRevision: 1,
      traceId: "old-trace", suggestionId: "old", stableRevision: 1 },
      sections: buildMeetingAnswerDisplayModel({ content, parsedAnswer: parsed }), stable, streaming: false };
    const partial = { ...old, target: { sessionId: "s", logicalQuestionUnitId: "B", logicalQuestionRevision: 1,
      traceId: "failed-trace", generationId: "failed-job" }, stable: null, streaming: true,
      sections: buildMeetingAnswerDisplayModel({ content: "Answer: unfinished", parsedAnswer: parseMeetingAnswer("Answer: unfinished") }) };
    const display = new ManualAdviseDisplay();
    if (displayCase === "pinned-stable") { display.select(old, old); assert.ok(display.toggle().accepted); }
    else { display.select(partial, old); if (displayCase === "pinned-stream") assert.ok(display.toggle().accepted); }
    const partialDecision = decideStagedAnswerPartial({ accumulated: "Answer: unfinished", explicitRequest: true,
      stableAnswerPresent: true, guardrailHeld: false, deliveryLockActive: displayCase === "delivery-held", visibleStreamStarted: false });
    let ui: any = { latestSuggestion: stable.suggestion, latestReliableSuggestion: stable.suggestion,
      partialSuggestion: displayCase === "superseded" ? "new active partial" : partialDecision.visible ? "Answer: unfinished" : "", status: "thinking" };
    const terminalized: any[] = [], attempts: any[] = [], receipts: any[] = [];
    const env: Record<string, any> = {
      manualAdviseDisplayRef: { current: display }, sessionRecordingManagerRef: { current: { recordCaptureLifecycle: (e: unknown) => receipts.push(e) } },
      displayedStreamRef: { current: { traceId: displayCase === "superseded" ? "next-trace" : "failed-trace" } }, traceId: "failed-trace",
      setState: (update: (s: any) => any) => { ui = update(ui); },
      stagedAnswerDeliveryVisible: partialDecision.visible, stagedAnswerDeliveryExplicitRequest: true,
      stagedAnswerDeliveryChunkCount: 1, stagedAnswerDeliveryFirstChunkAt: 1, stagedAnswerDeliveryFirstVisiblePartialAt: 1,
      stagedAnswerDeliveryLastPartialReason: partialDecision.reason, automaticVoiceStreamingAuthorized: () => true,
      isStagedAnswerDeliveryLockActive: () => displayCase === "delivery-held", formatStagedAnswerDeliveryForTrace,
      traceStoreRef: { current: { updateMetadata: () => {} } },
      answerGenerationLease: { id: "lease" }, MeetingAIResponseOutcomeError: module.exports.MeetingAIResponseOutcomeError,
      generationResultLedgerRef: { current: { recordProviderAttempt: (_lease: unknown, outcome: unknown) => attempts.push(outcome) } },
      terminalizeGenerationLease: (value: unknown) => terminalized.push(value), generationFailureDispositionFromProviderStatus,
      advisorJob: { id: "failed-job" }, activeAdvisorJobRef: { current: { id: displayCase === "superseded" ? "next-job" : "failed-job" } },
      readCommitDecision: () => ({ authorized: displayCase !== "superseded", reason: "fixture" }),
      updateForceAdviseTargetForAdvisorOutcome: () => {}, finishRunningAdvisorJobTrace: () => {}, releaseAdvisorJob: () => {},
      taskBoundaryCandidate: undefined, taskBoundaryCommittedBeforeAdvisor: true,
      formatTaskBoundaryCandidateForTrace, taskBoundarySurvivesAdvisorOutcome,
      formatAdvisorTriggerJobForTrace: () => ({}), sourceOwnedTransitionReceipt: undefined,
      formatSourceOwnedDurableTransitionForTrace, sourceOwnedDurableTransitionSurvivesModelOutcome,
      runtimeActiveRef: { current: true }, options: {}, force: false, returnStatus: "listening",
    };
    env.revokeIncompleteAdvisePin = hookCallback("revokeIncompleteAdvisePin", env);
    env.rollbackStagedAnswerDelivery = hookCallback("rollbackStagedAnswerDelivery", env);
    const catchNode = hookNode(n => ts.isCatchClause(n) && n.block.getText(hook).includes("rollbackStagedAnswerDelivery(") &&
      n.block.getText(hook).includes("terminalizeGenerationLease({")) as ts.CatchClause;
    new Function(...Object.keys(env), "error", ts.transpileModule(catchNode.block.getText(hook), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText)(...Object.values(env), error);
    assert.equal(attempts.length, 1); assert.equal(terminalized.length, 1);
    assert.equal(terminalized[0].disposition, "timed-out"); assert.equal(terminalized[0].candidateFormed, false);
    assert.equal(ui.partialSuggestion, displayCase === "superseded" ? "new active partial" : "");
    assert.strictEqual(ui.latestSuggestion, stable.suggestion); assert.strictEqual(ui.latestReliableSuggestion, stable.suggestion);
    assert.strictEqual(display.select(old, old).stable, stable);
    assert.deepEqual(manager.getTaskRuntimeState(), taskBefore);
    assert.equal(receipts.length, displayCase === "pinned-stream" ? 1 : 0);
  });
}
