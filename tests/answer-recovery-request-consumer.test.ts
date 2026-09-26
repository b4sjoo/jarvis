import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import curl2Json from "@bany/curl-to-json";
import { MARKDOWN_FORMATTING_INSTRUCTIONS } from "../src/config/constants.js";
import * as events from "../src/lib/functions/ai-response-events.js";
import * as common from "../src/lib/functions/common.function.js";
import { decodeServerSentEventStream } from "../src/lib/functions/server-sent-event-stream.js";
import * as response from "../src/lib/meeting/runtime-inference-response.js";
import * as recovery from "../src/lib/meeting/answer-recovery-adjudication.js";
import * as visual from "../src/lib/meeting/visual-evidence-recovery.js";
import * as runtime from "../src/lib/meeting/runtime-inference.js";
import * as linkage from "../src/lib/meeting/source-linkage-adjudication.js";
import { formatRuntimeInferenceSharedAdmissionForTrace } from "../src/lib/meeting/runtime-inference-provider-admission.js";

function loadModule(file: string, modules: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, {
    exports, module: { exports }, AbortController, DOMException, Error, setTimeout, clearTimeout,
    ...globals,
    require: (name: string) => {
      assert.ok(name in modules, `uncontrolled import ${name}`);
      return modules[name];
    },
  }, { filename: file });
  return exports as any;
}

const question = "Explain lines 46 through 49.";
const answer = "I need those lines before I can explain them.";
const resolutionRequest = recovery.buildAnswerRecoveryAdjudicationRequest({ operationKind: "answer-resolution", logicalQuestionUnitId: "q", logicalQuestionUnitRevision: 2, answerRevision: 3, questionText: question, answerText: answer })!;
const visualRequest = recovery.buildVisualEvidenceCheckRequest({ logicalQuestionUnitId: "q", logicalQuestionUnitRevision: 2, questionSourceHash: "source", questionText: question, screenEvidenceSummary: "Lines 46 through 49 are visible." })!;
const linkageRequest = linkage.buildSourceLinkageAdjudicationRequest({ logicalQuestionUnitId: "q", logicalQuestionUnitRevision: 2, screenObservationId: "screen", voiceSourceHash: "source", voiceQuestion: question, screenQuestion: question, screenEvidenceSummary: question })!;

function output(decision: string) {
  const field = ["resolved", "unresolved"].includes(decision) ? "answerEvidenceSpans" : "visualEvidenceSpans";
  return JSON.stringify({ schemaVersion: 2, decision, questionEvidenceSpans: [question],
    [field]: field === "answerEvidenceSpans" ? [answer] : decision === "visual-sufficient" ? ["Lines 46 through 49"] : [] });
}

function sse(content: string) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 25, total_tokens: 65 } })}\n\ndata: [DONE]\n\n`);
}

function transportHarness(raw: string, mode: "sse" | "wait" | "http-error" = "sse") {
  const calls: any[] = [];
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
  const transport = loadModule("src/lib/functions/ai-response.function.ts", {
    "./common.function": common,
    "@bany/curl-to-json": { default: curl2Json },
    "../response-settings.constants": { RESPONSE_LENGTHS: [], LANGUAGES: [] },
    "../storage/response-settings.storage": { getResponseSettings: () => assert.fail("response settings must stay disabled") },
    "@/config/constants": { MARKDOWN_FORMATTING_INSTRUCTIONS },
    "./ai-response-events.js": events,
    "./server-sent-event-stream.js": { decodeServerSentEventStream },
  }, {
    setTimeout: (callback: () => void, ms: number) => { timers.push({ callback, ms, cleared: false }); return timers.length - 1; },
    clearTimeout: (id: number) => { timers[id].cleared = true; },
    fetch: async (url: string, options: any) => {
      assert.equal(url, "https://provider.invalid/chat");
      calls.push({ body: JSON.parse(options.body), signal: options.signal });
      if (mode === "wait") return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (options.signal.aborted) abort();
        else options.signal.addEventListener("abort", abort, { once: true });
      });
      return mode === "http-error" ? new Response("unavailable", { status: 503 }) : sse(raw);
    },
  });
  const request = loadModule("src/lib/meeting/runtime-inference-request.ts", {
    "../functions/ai-response.function.js": transport,
    "./runtime-inference-response.js": response,
  });
  const adapter = loadModule("src/lib/meeting/answer-recovery-adjudication-request.ts", {
    "./runtime-inference-request.js": request,
    "./answer-recovery-adjudication.js": recovery,
    "./runtime-inference.js": runtime,
  });
  const linkageAdapter = loadModule("src/lib/meeting/source-linkage-adjudication-request.ts", {
    "./runtime-inference-request.js": request,
    "./source-linkage-adjudication.js": linkage,
    "./runtime-inference.js": runtime,
  });
  const run = (input: any, signal = new AbortController().signal) => {
    const fn = "screenObservationId" in input ? linkageAdapter.requestSourceLinkageAdjudication : adapter.requestAnswerRecoveryAdjudication;
    return fn({ request: input, signal,
      provider: { id: "fixture", streaming: true, responseContentPath: "choices[0].delta.content",
        curl: `curl https://provider.invalid/chat -H 'Content-Type: application/json' -d '{"model":"fixture","max_tokens":1024,"messages":[{"role":"system","content":"{{SYSTEM_PROMPT}}"},{"role":"user","content":"{{TEXT}}"}]}'` },
      selectedProvider: { provider: "fixture", variables: {} },
    });
  };
  return { calls, timers, run };
}

for (const [request, tokens, timeout] of [[visualRequest, 256, 3000], [resolutionRequest, 512, 1500], [linkageRequest, 256, 2000]] as const) {
  const kind = "operationKind" in request ? request.operationKind : "source-linkage-adjudication";
  test(`RC2 actual ${kind} request retains budget, single attempt and cancellation`, async () => {
    const h = transportHarness(request === linkageRequest ? JSON.stringify({ schemaVersion: 1, decision: "use-screen", voiceEvidenceSpans: [], screenEvidenceSpans: [question] }) : output(request === resolutionRequest ? "unresolved" : "visual-missing"));
    const result = await h.run(request);
    assert.equal(result.parsed.ok, true);
    assert.equal(h.calls.length, 1);
    assert.equal(result.providerAttempts.length, 1);
    assert.equal(h.calls[0].body.max_tokens, tokens);
    assert.equal(h.timers[0].ms, timeout);
    assert.equal(h.timers[0].cleared, true);
    const definition = runtime.getRuntimeInferenceOperationDefinition(kind);
    assert.equal(definition.providerTier, "fast");
    assert.equal(definition.lane, request === resolutionRequest ? "background" : "critical");
    assert.equal(definition.maxStartsPerBudgetSlot, 1);
    const prompts = "operationKind" in request ? recovery.buildAnswerRecoveryAdjudicationPrompts(request) : linkage.buildSourceLinkageAdjudicationPrompts(request);
    assert.equal(h.calls[0].body.messages[0].content, `${prompts.systemPrompt} ${MARKDOWN_FORMATTING_INSTRUCTIONS}`);
    assert.equal(h.calls[0].body.messages[1].content, prompts.userMessage);
    assert.equal(result.providerOutcome.nativeFinishReason, "stop");
    assert.equal(result.providerOutcome.tokenUsage.outputTokens, 25);
    const cancelled = transportHarness("");
    const cancelledController = new AbortController();
    cancelledController.abort();
    await assert.rejects(cancelled.run(request, cancelledController.signal), { name: "AbortError" });
    assert.equal(cancelled.calls.length, 0, "an already-cancelled request never starts fetch");

    for (const terminal of ["timeout", "cancel", "http-error"] as const) {
      const controller = new AbortController();
      const failure = transportHarness("", terminal === "http-error" ? "http-error" : "wait");
      const pending = failure.run(request, controller.signal);
      assert.equal(failure.calls.length, 1);
      if (terminal === "cancel") {
        const rejected = assert.rejects(pending, { name: "AbortError" });
        controller.abort();
        await rejected;
      } else {
        if (terminal === "timeout") failure.timers[0].callback();
        const failed = await pending;
        assert.equal(failed.parsed.ok, false);
        assert.equal(failed.providerAttempts.length, 1);
        if (terminal === "timeout") assert.equal(failed.providerOutcome.completionSignal, "request-timeout");
      }
      assert.equal(failure.calls.length, 1, "no retry after terminal");
      assert.equal(failure.timers[0].ms, timeout);
    }
  });
}

const hook = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
function find(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (!found && predicate(node)) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(root);
  assert.ok(found, "production callback must exist");
  return found;
}
function callback(name: string) {
  const declaration = find(hook, n => ts.isVariableDeclaration(n) && n.name.getText(hook) === name) as ts.VariableDeclaration;
  return (declaration.initializer as ts.CallExpression).arguments[0];
}
function evaluate(node: ts.Node, env: Record<string, any>) {
  return vm.runInNewContext(ts.transpileModule(`(${node.getText(hook)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, env);
}
function settlementCallback(name: string) {
  return (find(callback(name), n => ts.isPropertyAssignment(n) && n.name.getText(hook) === "onSettled") as ts.PropertyAssignment).initializer;
}
const visualConsumer = (find(hook, n => ts.isCallExpression(n) && n.expression.getText(hook) === "visualEvidenceCheckPromise.then") as ts.CallExpression).arguments[0];

// Execute the actual hook callbacks and ledger helpers without mounting unrelated UI.
function consumerHarness() {
  const pending: any = { sourceKind: "voice", sessionId: "session", runtimeEpoch: 1,
    logicalQuestionUnitId: "q", logicalQuestionRevision: 2, answerRevision: 3,
    visibleAnswerRevision: 3, parentTaskId: "parent", parentRevision: 1,
    ownerKind: "parent", ownerBranchId: "parent", questionType: "coding", questionText: question,
    sourceHash: "source", adjudicationSourceHash: resolutionRequest.sourceHash,
    manualCorrectionRevision: 0, sourceTurnIds: ["turn"],
    localResolution: { state: "awaiting-evidence", awaitingVisualEvidence: true },
    answerResolutionSettled: false, evidenceRequirementSettled: false };
  const metadata: any = {};
  const lifecycle: any[] = [];
  const rawOutputs: any[] = [];
  const env: any = { ...recovery, ...visual, ...runtime, ...response, formatRuntimeInferenceSharedAdmissionForTrace,
    Date, Map, traceId: "trace", taskId: "parent", stepId: undefined,
    pendingAnswerResolutionCommitByTraceRef: { current: new Map([["trace", pending]]) },
    awaitingVisualEvidenceRecoveryRef: { current: new Map() },
    contextManagerRef: { current: { getState: () => ({ sessionId: "session", activeMeetingTask: { parent: { id: "parent", revisions: 1 } } }) } },
    runtimeEpochRef: { current: 1 }, manualCorrectionRevisionRef: { current: 0 },
    logicalQuestionUnitRef: { current: { id: "q", revision: 2 } },
    stableAnswerRevisionRef: { current: { revision: 3 } },
    traceStoreRef: { current: { updateMetadata: (_id: string, value: any) => Object.assign(metadata, value) } },
    sessionRecordingManagerRef: { current: { getState: () => ({ active: true }), recordCaptureLifecycle: (value: any) => lifecycle.push(value), recordModelOutput: (value: any) => rawOutputs.push(value) } },
    debugModeRef: { current: false }, refreshRecordedCompletedTrace: () => {},
    answerRecoveryCircuitRef: { current: { open: () => assert.fail("unexpected circuit") } },
  };
  env.settleAwaitingVisualEvidenceRecovery = evaluate(callback("settleAwaitingVisualEvidenceRecovery"), env);
  env.finalizeAnswerRecoveryAdjudication = evaluate(callback("finalizeAnswerRecoveryAdjudication"), env);
  const consumeVisual = evaluate(visualConsumer, env);
  const leases = [visualRequest, resolutionRequest].map(request => recovery.createAnswerRecoveryAdjudicationLease({ sessionId: "session", runtimeEpoch: 1, request, manualCorrectionRevision: 0 }));
  return { env, pending, metadata, lifecycle, rawOutputs,
    deliver(request: typeof visualRequest | typeof resolutionRequest, result: any) {
      const isVisual = request.operationKind === "evidence-requirement";
      const lease = leases[isVisual ? 0 : 1];
      Object.assign(env, { request, lease, input: { traceId: "trace" }, resolve: consumeVisual,
        runtime: { getCurrentOperationId: () => lease.operationId },
        evidenceRequirementRuntimeRef: { current: { getCurrentOperationId: () => lease.operationId } },
        scheduledMetadata: { ...runtime.formatRuntimeInferenceOperationForTrace(request.operationKind),
          ...recovery.formatAnswerRecoveryAdjudicationForTrace({ request, disposition: "scheduled" }) } });
      evaluate(settlementCallback(isVisual ? "scheduleQuestionOnlyVisualEvidenceCheck" : "scheduleAnswerRecoveryAdjudications"), env)({
        job: { lease, request }, result, disposition: "completed", durationMs: 10, queueWaitMs: 0,
      });
    },
  };
}

test("RC4/RC5 request -> parser -> production authorization -> ledger works in either completion order", async () => {
  for (const reverse of [false, true]) {
    const h = consumerHarness();
    const pairs = [[visualRequest, "visual-missing"], [resolutionRequest, "unresolved"]] as const;
    for (const [request, decision] of reverse ? [...pairs].reverse() : pairs) {
      const result = await transportHarness(output(decision)).run(request);
      h.deliver(request, result);
      assert.equal(h.metadata.answerRecoveryPromptVersion, request.promptVersion);
      assert.equal(h.metadata.runtimeInferenceMaxOutputTokens, request === resolutionRequest ? 512 : 256);
      assert.equal(h.metadata.runtimeInferenceTimeoutMs, request === resolutionRequest ? 1500 : 3000);
      assert.equal(h.metadata.answerRecoveryLeaseAuthorized, true);
      const prefix = request === resolutionRequest ? "answerRecovery" : "visualEvidenceCheck";
      assert.equal(h.metadata[`${prefix}ProviderOutcomeStatus`], "success");
      assert.equal(h.metadata[`${prefix}ProviderNativeFinishReason`], "stop");
      assert.equal(h.metadata[`${prefix}ProviderTokenUsage`].outputTokens, 25);
    }
    const fact = h.env.awaitingVisualEvidenceRecoveryRef.current.get("parent");
    assert.ok(fact);
    assert.equal(fact.logicalQuestionUnitId, "q");
    assert.equal(fact.answerRevision, 3);
    assert.equal(fact.sourceHash, "source");
    assert.ok(fact.evidence.includes(answer));
    assert.equal(h.metadata.answerRecoveryLedgerAction, "create");
    assert.equal(h.metadata.answerRecoveryParseDisposition, "valid-json");
    assert.equal(h.metadata.answerRecoveryProviderDisposition, "completed-with-content");
    assert.equal(h.rawOutputs.length, 2);
    assert.equal(h.lifecycle.length, 1);
  }
});

test("RC4 invalid and unclear pairs preserve an existing opportunity", async () => {
  for (const invalidKind of ["visual", "resolution"]) for (const raw of ["{}", '{"schemaVersion":2', JSON.stringify({ schemaVersion: 2, decision: "unclear", questionEvidenceSpans: [], [invalidKind === "visual" ? "visualEvidenceSpans" : "answerEvidenceSpans"]: [], ambiguityReason: "Insufficient evidence." })]) {
    const h = consumerHarness();
    const existing = { id: "existing", ownerBranchId: "parent" };
    h.env.awaitingVisualEvidenceRecoveryRef.current.set("parent", existing);
    h.deliver(visualRequest, await transportHarness(invalidKind === "visual" ? raw : output("visual-missing")).run(visualRequest));
    h.deliver(resolutionRequest, await transportHarness(invalidKind === "resolution" ? raw : output("unresolved")).run(resolutionRequest));
    assert.equal(h.metadata.answerRecoveryLedgerAction, "preserve");
    assert.equal(h.env.awaitingVisualEvidenceRecoveryRef.current.get("parent"), existing);
    assert.equal(h.lifecycle.length, 0);
  }
});

test("RC4 settled model results wait for the visible answer revision before creating recovery", async () => {
  const h = consumerHarness();
  h.pending.visibleAnswerRevision = undefined;
  h.deliver(visualRequest, await transportHarness(output("visual-missing")).run(visualRequest));
  h.deliver(resolutionRequest, await transportHarness(output("unresolved")).run(resolutionRequest));
  assert.equal(h.env.awaitingVisualEvidenceRecoveryRef.current.size, 0);
  assert.equal(h.lifecycle.length, 0);
  h.pending.visibleAnswerRevision = 3;
  h.env.finalizeAnswerRecoveryAdjudication("trace");
  assert.equal(h.env.awaitingVisualEvidenceRecoveryRef.current.size, 1);
  assert.equal(h.lifecycle.length, 1);
  h.env.finalizeAnswerRecoveryAdjudication("trace");
  assert.equal(h.lifecycle.length, 1, "completed candidates cannot create twice");
});

test("RC4 stale source, LQU, answer, visible answer, epoch and human correction cannot mutate ledger", async () => {
  const mutations: ((h: ReturnType<typeof consumerHarness>) => void)[] = [
    h => { h.pending.adjudicationSourceHash = "replacement-source"; },
    h => { h.env.logicalQuestionUnitRef.current.id = "replacement-q"; },
    h => { h.env.logicalQuestionUnitRef.current.revision++; },
    h => { h.pending.answerRevision++; },
    h => { h.env.stableAnswerRevisionRef.current.revision++; },
    h => { h.env.runtimeEpochRef.current++; },
    h => { h.env.manualCorrectionRevisionRef.current++; },
  ];
  for (const mutate of mutations) for (const decision of ["resolved", "unresolved"]) {
    const h = consumerHarness();
    const existing = { id: "existing", ownerBranchId: "parent" };
    h.env.awaitingVisualEvidenceRecoveryRef.current.set("parent", existing);
    const visualResult = await transportHarness(output("visual-missing")).run(visualRequest);
    const resolutionResult = await transportHarness(output(decision)).run(resolutionRequest);
    mutate(h);
    h.deliver(visualRequest, visualResult);
    h.deliver(resolutionRequest, resolutionResult);
    assert.equal(h.metadata.answerRecoveryLedgerAction, "preserve");
    assert.equal(h.env.awaitingVisualEvidenceRecoveryRef.current.get("parent"), existing);
    assert.equal(h.lifecycle.length, 0);
  }
});

test("RC4 all other definite pairs keep the existing cancellation semantics", async () => {
  for (const answerDecision of ["resolved", "unresolved"]) for (const visualDecision of ["visual-missing", "visual-sufficient", "not-visual"]) {
    if (answerDecision === "unresolved" && visualDecision === "visual-missing") continue;
    const h = consumerHarness();
    const fact = visual.createAwaitingVisualEvidenceRecoveryFact({ ...h.pending, resolution: { state: "awaiting-evidence", awaitingVisualEvidence: true, evidence: [question] } })!;
    h.env.awaitingVisualEvidenceRecoveryRef.current.set("parent", fact);
    h.deliver(visualRequest, await transportHarness(output(visualDecision)).run(visualRequest));
    h.deliver(resolutionRequest, await transportHarness(output(answerDecision)).run(resolutionRequest));
    assert.equal(h.metadata.answerRecoveryLedgerAction, "cancel");
    assert.equal(h.env.awaitingVisualEvidenceRecoveryRef.current.size, 0);
    assert.equal(h.lifecycle[0].stage, "awaiting-visual-evidence-cancelled");
  }
});
