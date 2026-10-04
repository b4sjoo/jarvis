import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { buildSync } from "esbuild";
import { buildFactAnchorDecision } from "../src/lib/meeting/fact-anchor-guardrail.js";
import { RuntimeInferenceProviderAdmissionCoordinator, type RuntimeInferenceAdmissionClock } from "../src/lib/meeting/runtime-inference-provider-admission.js";
import { resolveRuntimeInferenceModelRouteFromSnapshot } from "../src/lib/meeting/meeting-model-route.js";
import { commitStableAnswerRevision, type StableAnswerRevision } from "../src/lib/meeting/stable-answer.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import { createMeetingFocusDisplayModel } from "../src/lib/meeting/focus-display.js";
import { EMPTY_MEETING_FOCUS_SNAPSHOT } from "../src/lib/meeting/focus-window.js";
import { createRuntimeCriticalEventHarness, RUNTIME_CRITICAL_EVENT_HOOK_CALLBACKS } from "./helpers/runtime-critical-events.js";
import { assertEntryInLedger, assertNothingPlanted, createDiagnosticLogSpy, DIAGNOSTIC_LOG_SPY_FAILING_DELIVERIES, PLANTED, PLANTED_VALUES,
  type DiagnosticLogSpyDelivery } from "./helpers/diagnostic-log-spy.js";

const require = createRequire(path.resolve("package.json"));
const bundle = buildSync({ entryPoints:["src/lib/meeting/fact-risk-review.ts"], bundle:true,
  platform:"node", format:"cjs", write:false, logLevel:"silent", alias:{"@":path.resolve("src")} });
const module = {exports:{}};
new Function("require","module","exports",bundle.outputFiles[0].text)(require,module,module.exports);
const { buildFactRiskReviewPrompts, captureFactRiskReviewInput, FactRiskReviewRuntime, factRiskReviewAnswerKey, parseFactRiskReviewOutput } =
  module.exports as typeof import("../src/lib/meeting/fact-risk-review.js");

const input = { question: "What did you measure?", evidence: "[fact] We moved inference to an asynchronous stage.", eligibleFactIds: ["fact"], sourceIds: ["fact"] };
const flag = { section: "answer" as const, quote: "40%", reason: "Measurement needs verification.", sourceIds: ["fact"] };
function stable(id = "A", current?: StableAnswerRevision): StableAnswerRevision {
  const content = `Answer: We measured a 40% improvement for ${id}.\nApproach: Original reasoning.`;
  const value = commitStableAnswerRevision({ current, candidate: { id, kind: "answer", content,
    meetingAnswer: parseMeetingAnswer(content), createdAt: 1, basedOnTurnIds: [], basedOnObservationIds: [], confidence: "high", factRiskReviewInput: input },
    sessionId: "session", runtimeEpoch: 1, taskId: "parent", logicalQuestionUnitId: id[0], logicalQuestionRevision: 1,
    authorizedArtifacts: ["answer"], committedAt: 1 });
  assert.ok(value); return value;
}
class Clock implements RuntimeInferenceAdmissionClock {
  value = 0; next = 0; timers = new Map<number, { at: number; fn: () => void }>();
  now = () => this.value;
  schedule = (fn: () => void, ms: number) => { const id = ++this.next; this.timers.set(id, { at: this.value + ms, fn }); return id; };
  cancel = (id: unknown) => { this.timers.delete(id as number); };
  advance(ms: number) {
    const target = this.value + ms;
    while (true) {
      const next = [...this.timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break; this.value = next[1].at; this.timers.delete(next[0]); next[1].fn();
    }
    this.value = target;
  }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function setup() {
  const clock = new Clock(), admission = new RuntimeInferenceProviderAdmissionCoordinator(1, 0, clock);
  const events: Record<string, unknown>[] = []; let updates = 0;
  const runtime = new FactRiskReviewRuntime(admission, () => updates++, e => events.push(e), clock);
  return { clock, admission, runtime, events, updates: () => updates };
}

test("RG7 exact Answer quotes and known sources, without semantic repair", () => {
  const answer = stable().suggestion.meetingAnswer!.sections.answer!;
  assert.equal(parseFactRiskReviewOutput('```json\n'+JSON.stringify({v:1,flags:[flag]})+'\n```', input, answer).ok, true);
  for (const value of [{ ...flag, section: "approach" }, { ...flag, quote: "50%" }, { ...flag, sourceIds: ["unknown"] }, { ...flag, reason: "" }]) {
    assert.equal(parseFactRiskReviewOutput(JSON.stringify({ v:1, flags:[value] }), input, answer).ok, false);
  }
  assert.equal(parseFactRiskReviewOutput('{"v":1,"flags":[', input, answer).ok, false);
  const prompt = buildFactRiskReviewPrompts(input, answer);
  const payload = JSON.parse(prompt.userMessage);
  assert.deepEqual(Object.keys(payload.answerSections), ["answer"]);
  assert.doesNotMatch(prompt.userMessage, /Original reasoning/);
});

test("RG1 input is fact-scoped, detached and bounded rather than silently truncated", () => {
  const decision = buildFactAnchorDecision({ questionType:"project-deep-dive", questionText:"Tell me about your project." });
  const sourceIds = ["fact"];
  const captured = captureFactRiskReviewInput({ decision, question:"Original question", evidence:"Original evidence", sourceIds });
  assert.ok(captured); sourceIds.push("later");
  assert.deepEqual(captured.sourceIds, ["fact"]); assert.ok(Object.isFrozen(captured));
  const oversized = captureFactRiskReviewInput({ decision, question:"q", evidence:"x".repeat(16001) });
  assert.equal(oversized?.unavailableReason, "input-unavailable-or-unbounded");
  assert.equal(oversized?.evidence, "");
  assert.equal(captureFactRiskReviewInput({ decision:{...decision,requiredFor:"none"}, question:"q" }), undefined);
});

test("RG2 at most once per Answer section, independent of Artifact publication", async () => {
  const {runtime, updates} = setup(); const a = stable(); const before = JSON.stringify(a);
  runtime.retain([a]); let calls = 0;
  const execute = async () => { calls++; return {ok:true as const,flags:[flag]}; };
  runtime.start(a, execute); runtime.start(a, execute); await flush();
  const artifactOnly = {...a, revision:a.revision+1,suggestion:{...a.suggestion,id:"artifact-only"}};
  runtime.retain([artifactOnly]); runtime.start(artifactOnly, execute); await flush();
  assert.equal(calls,1); assert.equal(runtime.read(artifactOnly)?.status,"completed");
  assert.equal(factRiskReviewAnswerKey(a),factRiskReviewAnswerKey(artifactOnly));
  assert.equal(JSON.stringify(a),before); assert.equal(updates(),2);
  const focus = createMeetingFocusDisplayModel({...EMPTY_MEETING_FOCUS_SNAPSHOT,factRiskReview:runtime.read(a)});
  assert.equal(focus.factRiskReview?.flags[0].quote,"40%");
});

test("RG3 hidden B is not automatically reviewed; first visible B uses its own snapshot", async () => {
  const {runtime} = setup(); const a=stable(), b=stable("B"); let complete!: (x:{ok:true;flags:typeof flag[]})=>void;
  runtime.retain([b,a]); let calls=0;
  runtime.start(a,async request=>{calls++;assert.match(request.answer,/for A/);return new Promise(resolve=>{complete=resolve;});});
  await flush(); assert.equal(calls,1); assert.equal(runtime.read(b)?.reason,"not-started");
  complete({ok:true,flags:[flag]}); await flush();
  runtime.retain([b]);runtime.start(b,async request=>{calls++;assert.match(request.answer,/for B/);return {ok:true,flags:[]};});await flush();
  assert.equal(calls,2);assert.equal(runtime.read(b)?.flags.length,0);assert.equal(runtime.read(a),undefined);
});

test("RG4 late A cannot attach to A-prime or a new session", async () => {
  const {runtime,events}=setup();const a=stable();let complete!:(x:{ok:true;flags:typeof flag[]})=>void;
  runtime.retain([a]);runtime.start(a,async()=>new Promise(resolve=>{complete=resolve;}));await flush();
  const next=stable("A-prime",a);runtime.retain([next]);
  complete({ok:true,flags:[flag]});await flush();
  assert.equal(runtime.read(next)?.reason,"not-started");assert.equal(runtime.read(a),undefined);
  assert.ok(events.some(e=>e.stage==="late-result-discarded"));runtime.clear();assert.equal(runtime.read(next),undefined);
});

test("RG5 total deadline includes queue; an expired queued review never invokes Provider", async () => {
  const {runtime,admission,clock}=setup();let release!:()=>void;
  const busy=admission.run({operationId:"critical",lane:"critical",providerTier:"intelligent",signal:new AbortController().signal,
    execute:()=>new Promise<void>(resolve=>{release=resolve;})});await flush();
  const a=stable();runtime.retain([a]);let calls=0;
  runtime.start(a,async()=>{calls++;return {ok:true,flags:[]};});
  clock.advance(10000);await flush();assert.equal(runtime.read(a)?.reason,"deadline-exceeded");assert.equal(calls,0);
  release();await busy;await flush();runtime.start(a,async()=>{calls++;return {ok:true,flags:[]};});await flush();assert.equal(calls,0);
});

test("RG5 dispatch uses only the remaining budget and late output is discarded", async () => {
  const {runtime,admission,clock}=setup();let release!:()=>void;
  const busy=admission.run({operationId:"critical",lane:"critical",providerTier:"intelligent",signal:new AbortController().signal,
    execute:()=>new Promise<void>(resolve=>{release=resolve;})});await flush();
  const a=stable();runtime.retain([a]);let complete!:(x:{ok:true;flags:typeof flag[]})=>void;
  runtime.start(a,async request=>{assert.equal(request.remainingMs,3000);return new Promise(resolve=>{complete=resolve;});});
  clock.advance(7000);release();await busy;await flush();clock.advance(3000);complete({ok:true,flags:[flag]});await flush();
  assert.equal(runtime.read(a)?.status,"failed");assert.equal(runtime.read(a)?.flags.length,0);
});

test("RG5 errors and cancellation are terminal without a retry or answer mutation", async () => {
  for(const error of ["fact-risk-provider-unavailable","malformed-json"]) {
    const {runtime}=setup();const a=stable();runtime.retain([a]);let calls=0;
    const execute=async()=>{calls++;throw new Error(error);};runtime.start(a,execute);await flush();runtime.start(a,execute);
    assert.equal(calls,1);assert.equal(runtime.read(a)?.reason,error);
  }
  const {runtime}=setup(),a=stable();runtime.retain([a]);let finish!:(x:{ok:true;flags:never[]})=>void;
  runtime.start(a,async()=>new Promise(resolve=>{finish=resolve;}));await flush();runtime.cancel();finish({ok:true,flags:[]});await flush();
  assert.equal(runtime.read(a)?.reason,"runtime-invalidated");runtime.clear();
});

test("RG8 review route uses ordinary Advisor and never the Coding override or Fast credentials", () => {
  const route=resolveRuntimeInferenceModelRouteFromSnapshot({operationKind:"fact-risk-review",snapshot:{
    providers:[{id:"main",curl:"https://main.test"},{id:"coding",curl:"https://coding.test"},{id:"fast",curl:"https://fast.test"}],
    selectedProvider:{provider:"main",variables:{MODEL:"advisor"}},codingProvider:{provider:"coding",variables:{MODEL:"coding"}},
    taxonomyAdjudicationProvider:{provider:"fast",variables:{MODEL:"fast"}},
  }});
  assert.equal(route.provider?.id,"main");assert.equal(route.selectedProvider.variables.MODEL,"advisor");assert.equal(route.providerTier,"intelligent");
});

// ---------------------------------------------------------------------------
// 178/168 PC4: Fact Risk Review keeps its own product contract. The Hook's real
// display-applied callback is evaluated with the real review runtime, prompt
// builder and route resolver. Its environment holds no Debug ref, no Recording
// state and no Runtime Cross-checks ref at all: reading any of them would throw.
// ---------------------------------------------------------------------------

const hookText = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
const hookAst = ts.createSourceFile("hook.ts", hookText, ts.ScriptTarget.Latest, true);
function hookNode(name: string): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && node.name.getText(hookAst) === name && node.initializer && ts.isCallExpression(node.initializer)) {
      found = node.initializer.arguments[0];
    } else if (ts.isFunctionDeclaration(node) && node.name?.getText(hookAst) === name) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(hookAst);
  assert.ok(found, `production declaration ${name}`);
  return found;
}
const hookCode = (name: string) => ts.transpileModule(`(${hookNode(name).getText(hookAst)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

// Task 178A: the Hook's own emit callbacks, extracted once. The event stream is
// not a Debug, Recording or Cross-checks switch; the environment still holds none.
const criticalEventCallbackCode = Object.fromEntries(
  RUNTIME_CRITICAL_EVENT_HOOK_CALLBACKS.map((name) => [name, hookCode(name)])
) as Record<string, string>;

async function displayApplied(mode: "enforcement" | "shadow") {
  const { runtime, events } = setup();
  const committed = stable();
  // The displayed Answer names the trace that produced it, as a real one does.
  const answer: StableAnswerRevision = { ...committed, suggestion: { ...committed.suggestion, sourceTraceId: "trace" } };
  const requests: any[] = [], inputs: any[] = [], routes: any[] = [], metadata: Record<string, unknown> = {};
  const snapshot = { providers: [{ id: "main", curl: "https://main.test" }, { id: "fast", curl: "https://fast.test" }],
    selectedProvider: { provider: "main", variables: { MODEL: "advisor" } },
    taxonomyAdjudicationProvider: { provider: "fast", variables: { MODEL: "fast" } } };
  const target = { traceId: "trace", sessionId: "session", logicalQuestionUnitId: "A", logicalQuestionRevision: 1 };
  const context = vm.createContext({
    Date, Error,
    state: { settings: { personalEvidenceGuardrailMode: mode } },
    window: { cancelAnimationFrame() {}, requestAnimationFrame: () => 1 },
    pinReleaseFrameRef: { current: null }, shutdownRequestedRef: { current: false }, runtimeEpochRef: { current: 1 },
    manualAdviseDisplayRef: { current: { locked: false, selectedStable: undefined, acknowledgeApplied() {},
      awaitingApplication: () => false, capture: () => ({ stable: answer, streaming: false }) } },
    stableAnswerRevisionRef: { current: answer },
    contextManagerRef: { current: { getState: () => ({ sessionId: "session" }) } },
    traceStoreRef: { current: { getTraces: () => [{ id: "trace", metadata }],
      updateMetadata: (_id: string, update: Record<string, unknown>) => Object.assign(metadata, update),
      recordInput: (_id: string, label: string, value: string, meta: unknown) => inputs.push({ label, value, meta }),
      recordOutput() {} } },
    sessionRecordingManagerRef: { current: { recordCaptureLifecycle() {}, recordModelInput() {}, recordModelOutput() {} } },
    refreshRecordedCompletedTrace() {},
    factRiskReviewRuntimeRef: { current: runtime },
    meetingModelProviderSnapshotRef: { current: snapshot },
    resolveRuntimeInferenceModelRouteFromSnapshot: (request: any) => {
      routes.push({ operationKind: request.operationKind, reason: request.reason });
      return resolveRuntimeInferenceModelRouteFromSnapshot(request);
    },
    formatRuntimeInferenceModelRouteForTrace: () => ({}),
    buildFactRiskReviewPrompts,
    requestFactRiskReview: async (request: any) => {
      requests.push(request);
      return { response: { rawOutput: '{"v":1,"flags":[]}', providerDisposition: "completed-with-content" }, parsed: { ok: true, flags: [] } };
    },
  });
  context.formatTraceModelInput = vm.runInContext(hookCode("formatTraceModelInput"), context);
  createRuntimeCriticalEventHarness({ sessionId: "session" }).install(context,
    (name) => vm.runInContext(criticalEventCallbackCode[name], context));
  const recordAdviseDisplayApplied = vm.runInContext(hookCode("recordAdviseDisplayApplied"), context);
  runtime.retain([answer]);
  recordAdviseDisplayApplied(target, "normal-mode");
  await flush();
  // The same Answer shown again is not reviewed again.
  recordAdviseDisplayApplied(target, "focus-mode");
  await flush();
  return { runtime, events, answer, requests, inputs, routes, metadata };
}

test("PC4 Fact Risk Review is requested once for a displayed stable Answer in both modes, with the same prompt, route and budget, and cannot read the observation switch", async () => {
  const runs = { enforcement: await displayApplied("enforcement"), shadow: await displayApplied("shadow") };
  for (const [mode, run] of Object.entries(runs)) {
    assert.equal(run.requests.length, 1, `${mode}: one request per displayed Answer`);
    assert.deepEqual(run.routes, [{ operationKind: "fact-risk-review", reason: "visible-answer-fact-review" }]);
    assert.equal(run.requests[0].provider.id, "main", "Intelligent route: the ordinary Advisor provider");
    assert.equal(run.requests[0].selectedProvider.variables.MODEL, "advisor");
    assert.equal(run.requests[0].remainingMs, 10_000, "the whole 10 s budget");
    assert.equal(run.requests[0].executionIdentity.requestId, `fact-risk:${factRiskReviewAnswerKey(run.answer)}`);
    assert.equal(run.inputs.length, 1);
    assert.equal(run.inputs[0].meta.mode, mode);
    assert.doesNotMatch(run.inputs[0].value, /Original reasoning/, "Approach is not sent");
    assert.equal(run.runtime.read(run.answer)?.status, "completed");
    // The mode decides only the display: Enforcement marks the completed review as shown, Shadow keeps it as an observation.
    assert.equal(run.metadata.factRiskReviewDisplayAnswerKey, mode === "enforcement" ? factRiskReviewAnswerKey(run.answer) : undefined);
  }
  const comparable = (run: typeof runs.enforcement) => JSON.parse(JSON.stringify({
    request: { ...run.requests[0], signal: undefined }, prompt: run.inputs[0].value, routes: run.routes }));
  assert.deepEqual(comparable(runs.shadow), comparable(runs.enforcement), "both modes send the same request");
  // The review's own budget definition is the brief's contract and is not part of this slice.
  const { getRuntimeInferenceOperationDefinition } = await import("../src/lib/meeting/runtime-inference.js");
  assert.deepEqual(getRuntimeInferenceOperationDefinition("fact-risk-review"), {
    workloadClass: "runtime", operationKind: "fact-risk-review", providerTier: "intelligent",
    lane: "background", timeoutMs: 10_000, maxOutputTokens: 2048, quiescenceMs: 0, maxStartsPerBudgetSlot: 1 });
  assert.doesNotMatch(hookNode("recordAdviseDisplayApplied").getText(hookAst), /runtimeCrossChecks|debugModeRef/);
});

// ---------------------------------------------------------------------------
// Task 178 LG, summary site 5: Fact Risk Review, graded in the Hook's own
// observe callback. The callback is the third argument of the Hook's
// `new FactRiskReviewRuntime(...)`, evaluated with an explicit environment that
// holds the logger by hand, and given to the real review runtime with the real
// admission coordinator. Only the review request, the clock, the trace and
// recording sinks and the logger's delivery boundary are substituted.
// ---------------------------------------------------------------------------

const observeCallbackCode = (() => {
  const found: ts.NewExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && node.expression.getText(hookAst) === "FactRiskReviewRuntime") found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(hookAst);
  assert.equal(found.length, 1, "the Hook constructs one review runtime");
  return ts.transpileModule(`(${found[0]!.arguments![2]!.getText(hookAst)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
})();

function reviewWithHookObserver(level: "error" | "warn" | "info" | "debug" | "trace" = "trace", delivery?: DiagnosticLogSpyDelivery) {
  const clock = new Clock(), admission = new RuntimeInferenceProviderAdmissionCoordinator(1, 0, clock);
  const diagnosticLog = createDiagnosticLogSpy({ threshold: level, now: () => clock.now(), delivery });
  const lifecycle: Record<string, unknown>[] = [], traceUpdates: Record<string, unknown>[] = [], refreshed: unknown[] = [];
  const observe = vm.runInContext(observeCallbackCode, vm.createContext({
    logDiagnostic: diagnosticLog.logDiagnostic,
    sessionRecordingManagerRef: { current: { recordCaptureLifecycle: (row: Record<string, unknown>) => lifecycle.push(row),
      refreshRecordedTrace: (trace: unknown) => refreshed.push(trace) } },
    traceStoreRef: { current: { updateMetadata: (_id: string, update: Record<string, unknown>) => traceUpdates.push(update),
      getTrace: () => ({ id: "trace", status: "success" }) } },
    getAutoExportTrigger: () => "manual",
  })) as (event: Record<string, unknown>) => void;
  let updates = 0;
  const runtime = new FactRiskReviewRuntime(admission, () => updates++, observe, clock);
  const committed = stable();
  const answer: StableAnswerRevision = { ...committed, suggestion: { ...committed.suggestion, sourceTraceId: "trace" } };
  runtime.retain([answer]);
  // What the callback did before it had a logger: one recording row and one trace update per event.
  const sinks = () => JSON.parse(JSON.stringify({ lifecycle, traceUpdates, refreshed: refreshed.length, read: runtime.read(answer), updates }));
  return { clock, admission, runtime, answer, diagnosticLog, sinks };
}
type ReviewHarness = ReturnType<typeof reviewWithHookObserver>;
const held = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(done => { resolve = done; }); return { promise, resolve }; };
const reviewRefs = { traceId: "trace", runtimeSessionId: "session" };
// What a failing review request can carry in its message: the provider's text with a credential in it.
const REVIEW_ERROR_TEXT = `${PLANTED.providerError} (key ${PLANTED.secret})`;

const FACT_RISK_ROWS: Array<{ name: string; drive: (h: ReviewHarness) => Promise<void>; entries: Array<[string, Record<string, unknown>, Record<string, unknown> | undefined]>;
  result: [string | undefined, string | undefined] }> = [
  // Timeout table 3.1, row 4: the review does not finish within its 10 s; the answer stays as it is.
  { name: "Timeout 4: the review request is still running at its deadline", result: ["failed", "deadline-exceeded"],
    drive: async (h) => { h.runtime.start(h.answer, () => new Promise(() => {})); await flush(); h.clock.advance(10_000); await flush(); },
    entries: [["warn", { stage: "settled", status: "failed", cause: "deadline-exceeded", flagCount: 0, durationMs: 10_000, answerRevision: 1 }, reviewRefs]] },
  { name: "Timeout 4: the review waits for admission past its deadline and its request is never sent", result: ["failed", "deadline-exceeded"],
    drive: async (h) => {
      let release!: () => void;
      const busy = h.admission.run({ operationId: "critical", lane: "critical", providerTier: "intelligent", signal: new AbortController().signal,
        execute: () => new Promise<void>(resolve => { release = resolve; }) });
      await flush();
      let calls = 0;
      h.runtime.start(h.answer, async () => { calls++; return { ok: true, flags: [] }; });
      h.clock.advance(10_000); await flush(); release(); await busy; await flush();
      assert.equal(calls, 0, "the provider is never invoked");
    },
    // One failure, one warning: the refused dispatch after the deadline adds no second report.
    entries: [["warn", { stage: "settled", status: "failed", cause: "deadline-exceeded", flagCount: 0, durationMs: 10_000, answerRevision: 1 }, reviewRefs]] },
  // Row 5: the result arrives after the deadline settled the review.
  { name: "Timeout 4 then 5: the result arrives after the deadline", result: ["failed", "deadline-exceeded"],
    drive: async (h) => { const request = held(); h.runtime.start(h.answer, () => request.promise); await flush();
      h.clock.advance(10_000); await flush(); request.resolve({ ok: true, flags: [flag] }); await flush(); },
    entries: [["warn", { stage: "settled", status: "failed", cause: "deadline-exceeded", flagCount: 0, durationMs: 10_000, answerRevision: 1 }, reviewRefs],
      ["debug", { stage: "late-result-discarded", answerRevision: 1 }, reviewRefs]] },
  // A generic failure is a warning with its class alone: the reason of the review record is error text.
  { name: "a generic failure whose reason is the provider's error text", result: ["failed", REVIEW_ERROR_TEXT],
    drive: async (h) => { h.runtime.start(h.answer, async () => { throw new Error(REVIEW_ERROR_TEXT); }); await flush(); },
    entries: [["warn", { stage: "settled", status: "failed", flagCount: 0, durationMs: 0, answerRevision: 1 }, reviewRefs]] },
  { name: "an unparseable review output", result: ["failed", "malformed-json"],
    drive: async (h) => { h.runtime.start(h.answer, async () => ({ ok: false, reason: "malformed-json" })); await flush(); },
    entries: [["warn", { stage: "settled", status: "failed", flagCount: 0, durationMs: 0, answerRevision: 1 }, reviewRefs]] },
  // Controls.
  { name: "control: a completed review with one flag", result: ["completed", undefined],
    drive: async (h) => { h.runtime.start(h.answer, async () => { h.clock.advance(1_200); return { ok: true, flags: [flag] }; }); await flush(); },
    entries: [["debug", { stage: "settled", status: "completed", flagCount: 1, durationMs: 1_200, answerRevision: 1 }, reviewRefs]] },
  { name: "control: Stop cancels a pending review, whose record then reads failed, and its result arrives late", result: ["failed", "runtime-invalidated"],
    drive: async (h) => { const request = held(); h.runtime.start(h.answer, () => request.promise); await flush();
      h.runtime.cancel(); request.resolve({ ok: true, flags: [] }); await flush(); },
    entries: [["debug", { stage: "cancelled", cause: "runtime-invalidated" }, undefined],
      ["debug", { stage: "late-result-discarded", answerRevision: 1 }, reviewRefs]] },
  { name: "control: a newer answer retires the reviewed one (latest wins), and the old result arrives late", result: [undefined, undefined],
    drive: async (h) => { const request = held(); h.runtime.start(h.answer, () => request.promise); await flush();
      h.runtime.retain([stable("A-prime", h.answer)]); request.resolve({ ok: true, flags: [flag] }); await flush(); },
    entries: [["debug", { stage: "discarded", cause: "answer-retired" }, undefined],
      ["debug", { stage: "late-result-discarded", answerRevision: 1 }, reviewRefs]] },
];
for (const row of FACT_RISK_ROWS) {
  test(`LG1 LG3 LG4 Fact Risk Review, ${row.name}: ${row.entries.map(([level, data]) => `${level} ${data.stage}`).join(", then ")}`, async () => {
    const h = reviewWithHookObserver();
    await row.drive(h);
    // The review's own result is what it is without a logger.
    const read = h.runtime.read(h.answer);
    assert.deepEqual([read?.status, read?.reason], row.result);
    const entries = h.diagnosticLog.entries();
    for (const entry of entries) {
      assertEntryInLedger(entry);
      assert.deepEqual([entry.source, entry.event], ["meeting.fact-risk-review", "review-ended"]);
    }
    assert.deepEqual(entries.map(entry => [entry.level, entry.data, entry.refs]), row.entries);
    assert.equal(entries.filter(entry => entry.level === "warn" || entry.level === "error").length,
      row.entries.filter(([level]) => level === "warn").length, "warnings and errors");
    // The question, the evidence, the answer and the review's error text never reach an entry.
    assertNothingPlanted(entries, [...PLANTED_VALUES, input.question, input.evidence, "We measured a 40% improvement"], row.name);
    const counters = h.diagnosticLog.snapshot();
    assert.deepEqual([counters.refusedEntries, counters.refusedFields, counters.truncatedFields, counters.detailFailures], [0, 0, 0, 0]);
    // Every event still reached the recorder under its own stage, the generic failure with its reason text included.
    const sinks = h.sinks();
    assert.ok(sinks.lifecycle.every((rowWritten: any) => String(rowWritten.stage).startsWith("fact-risk-review:")));
    if (row.result[1] === REVIEW_ERROR_TEXT) {
      assert.equal(sinks.lifecycle.at(-1).reason, REVIEW_ERROR_TEXT, "the recording keeps the reason the review recorded");
    }
  });
}

test("LG2 Fact Risk Review at the five levels: the review result, every recording row and every trace update are identical; the entries are filtered by level alone", async () => {
  for (const row of FACT_RISK_ROWS) {
    const reference = reviewWithHookObserver("trace");
    await row.drive(reference);
    for (const level of ["error", "warn", "info", "debug", "trace"] as const) {
      const h = reviewWithHookObserver(level);
      await row.drive(h);
      assert.deepEqual(h.sinks(), reference.sinks(), `${row.name} at ${level}`);
      const order = ["error", "warn", "info", "debug", "trace"];
      assert.deepEqual(h.diagnosticLog.entries().map(entry => entry.level),
        row.entries.map(([entryLevel]) => entryLevel).filter(entryLevel => order.indexOf(entryLevel) <= order.indexOf(level)), `${row.name} at ${level}`);
    }
  }
});

test("LG2 Fact Risk Review with the log delivery failing, at the five levels: the review result, every recording row and every trace update are what they are with a working delivery, and the same entries are handed to the logger", async () => {
  const order = ["error", "warn", "info", "debug", "trace"] as const;
  for (const row of FACT_RISK_ROWS) {
    const reference = reviewWithHookObserver("trace");
    await row.drive(reference);
    assert.equal(reference.diagnosticLog.snapshot().undeliveredEntries, 0, "the reference delivers");
    for (const delivery of DIAGNOSTIC_LOG_SPY_FAILING_DELIVERIES) for (const level of order) {
      const name = `${row.name} with ${delivery} at ${level}`;
      const h = reviewWithHookObserver(level, delivery);
      await row.drive(h);
      assert.deepEqual(h.sinks(), reference.sinks(), name);
      const handedOver = h.diagnosticLog.entries();
      assert.deepEqual(handedOver.map(entry => [entry.level, entry.event, entry.data]),
        reference.diagnosticLog.entries().filter(entry => order.indexOf(entry.level) <= order.indexOf(level))
          .map(entry => [entry.level, entry.event, entry.data]), name);
      const counters = h.diagnosticLog.snapshot();
      assert.deepEqual([counters.undeliveredEntries, counters.ipcFailures + counters.ipcTimeouts + counters.ipcMalformedReceipts,
        counters.internalErrors, counters.queued, counters.inFlight], [handedOver.length, counters.ipcCalls, 0, 0, false], name);
    }
  }
});

test("LG1 Fact Risk Review: scheduling and admission are not summaries and make no entry; a skipped review is debug", async () => {
  const h = reviewWithHookObserver();
  h.runtime.start(h.answer, () => new Promise(() => {}));
  await flush();
  assert.deepEqual(h.sinks().lifecycle.map((row: any) => row.stage), ["fact-risk-review:scheduled", "fact-risk-review:admitted"]);
  assert.deepEqual(h.diagnosticLog.entries(), []);
  const skipped = reviewWithHookObserver();
  const unbounded: StableAnswerRevision = { ...skipped.answer, suggestion: { ...skipped.answer.suggestion,
    factRiskReviewInput: { ...input, unavailableReason: "no-eligible-fact" } as any } };
  skipped.runtime.retain([unbounded]);
  skipped.runtime.start(unbounded, async () => ({ ok: true, flags: [] }));
  await flush();
  assert.deepEqual(skipped.diagnosticLog.entries().map(entry => [entry.level, entry.data]),
    [["debug", { stage: "settled", status: "skipped", flagCount: 0, durationMs: 0, answerRevision: 1 }]]);
});
