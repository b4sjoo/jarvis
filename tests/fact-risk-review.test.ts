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
