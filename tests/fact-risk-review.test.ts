import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import path from "node:path";
import { buildSync } from "esbuild";
import { buildFactAnchorDecision } from "../src/lib/meeting/fact-anchor-guardrail.js";
import { RuntimeInferenceProviderAdmissionCoordinator, type RuntimeInferenceAdmissionClock } from "../src/lib/meeting/runtime-inference-provider-admission.js";
import { resolveRuntimeInferenceModelRouteFromSnapshot } from "../src/lib/meeting/meeting-model-route.js";
import { commitStableAnswerRevision, type StableAnswerRevision } from "../src/lib/meeting/stable-answer.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import { createMeetingFocusDisplayModel } from "../src/lib/meeting/focus-display.js";
import { EMPTY_MEETING_FOCUS_SNAPSHOT } from "../src/lib/meeting/focus-window.js";

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
