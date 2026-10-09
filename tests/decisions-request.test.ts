import assert from "node:assert/strict";
import test from "node:test";
import { DECISIONS_MODEL, DECISIONS_PROVIDER_ID, readDecisionsProviderConfiguration } from "../src/config/decisions.constants.js";
import { parseDecisionsChoice, requestDecisionsChoice } from "../src/lib/meeting/decisions-request.js";
import { RuntimeInferenceProviderAdmissionCoordinator } from "../src/lib/meeting/runtime-inference-provider-admission.js";

const question = { name: "decision", instructions: "Choose a language.", choices: [{ value: "en" }, { value: "zh" }, { value: "other" }] };
const identity = { requestId: "request", executionPlanId: "operation", modelId: DECISIONS_MODEL,
  sessionId: "synthetic-session", runtimeEpoch: 1, logicalQuestionUnitId: "source", logicalQuestionRevision: 1 };
const config = readDecisionsProviderConfiguration({ provider: DECISIONS_PROVIDER_ID, variables: { api_key: "synthetic-secret", model: DECISIONS_MODEL } }).snapshot!;
const input = () => ({ configuration: config, question, modelInput: "Hello", executionIdentity: identity,
  signal: new AbortController().signal, deadlineAt: Date.now() + 5000 });
const raw = (patch: Record<string, unknown> = {}) => JSON.stringify({ answers: [{ name: "decision", type: "choice", choice: "en",
  confidence: .4, probabilities: [{ value: "en", probability: .8 }], ...patch }] });

test("DR205: independent configuration never inherits STT credentials and freezes its own key", () => {
  assert.equal(readDecisionsProviderConfiguration(undefined).snapshot, undefined);
  assert.equal(readDecisionsProviderConfiguration({ provider: "azure-mai-transcribe", variables: { api_key: "azure-secret" } }).snapshot, undefined);
  assert.equal(readDecisionsProviderConfiguration({ provider: DECISIONS_PROVIDER_ID, variables: {} }).snapshot, undefined);
  assert.equal(readDecisionsProviderConfiguration({ provider: DECISIONS_PROVIDER_ID, variables: { api_key: "x", model: "not-supported" } }).snapshot, undefined);
  const selected = { provider: DECISIONS_PROVIDER_ID, variables: { API_KEY: " first " } };
  const snapshot = readDecisionsProviderConfiguration(selected).snapshot!;
  selected.variables.API_KEY = "second";
  assert.equal(snapshot.apiKey, "first");assert.equal(Object.isFrozen(snapshot), true);
});

test("DR205: selected probability wins including zero, independent of another choice's larger score", () => {
  for (const score of [0, .2, 1]) {
    const result = parseDecisionsChoice(raw({ confidence: 1, probabilities: [{ value: "en", probability: score }, { value: "zh", probability: 1 }] }), question);
    assert.ok(result.ok);assert.equal(result.choice, "en");assert.equal(result.executionScore, score);
    assert.equal(result.scoreSource, "selected-probability");
  }
  const result = parseDecisionsChoice(raw({ confidence: "invalid" }), question);
  assert.ok(result.ok);assert.equal(result.executionScore, .8);assert.equal(result.nativeConfidence, "invalid");
});

test("DR205: missing, duplicate and invalid selected probabilities fall back only to native confidence", () => {
  for (const probabilities of [undefined, null, {}, [], [{ value: "zh", probability: 1 }],
    [{ value: "en", probability: .8 }, { value: "en", probability: .8 }],
    ...[-1, 2, null, "0.8"].map(probability => [{ value: "en", probability }])]) {
    const result = parseDecisionsChoice(raw({ probabilities }), question);
    assert.ok(result.ok);assert.equal(result.executionScore, .4);assert.equal(result.scoreSource, "native-confidence");
  }
  assert.equal(parseDecisionsChoice(raw({ probabilities: [], confidence: null }), question).ok, false);
});

test("DR205: envelope/identity/refusal/choice failures stay failures; legal semantic unknown remains a choice", () => {
  for (const text of ["", "{", "null", "{}", raw({ name: "wrong" }), raw({ type: "refusal" }), raw({ choice: "unknown" }),
    JSON.stringify({ answers: [JSON.parse(raw()).answers[0], JSON.parse(raw()).answers[0]] })]) {
    assert.equal(parseDecisionsChoice(text, question).ok, false);
  }
  const result = parseDecisionsChoice(raw({ choice: "unknown", probabilities: [{ value: "unknown", probability: .7 }] }),
    { ...question, choices: [{ value: "unknown" }, { value: "coding" }] });
  assert.ok(result.ok);assert.equal(result.choice, "unknown");assert.equal(result.executionScore, .7);
});

test("DR205: actual transport uses Decisions contract and exposes typed-ready time without a fake first token", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: any, init: RequestInit) => {
    calls++;assert.equal(url, "https://api.openai.com/v1/decisions");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-secret");
    assert.deepEqual(JSON.parse(String(init.body)), { model: DECISIONS_MODEL, input: "Hello", questions: [{ ...question, type: "choice" }] });
    return new Response(raw());
  });
  const result = await requestDecisionsChoice(input());
  assert.equal(calls, 1);assert.equal(result.providerDisposition, "completed-with-content");
  assert.equal(result.firstTokenAt, undefined);assert.ok(result.decisionReadyAt);assert.ok(result.headersAt);
  assert.equal(result.providerOutcome.maxAttempts, 1);assert.equal(result.providerOutcome.modelId, DECISIONS_MODEL);
  assert.equal(result.decision.ok, true);assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
});

test("DR205: missing configuration and an expired deadline never dispatch", async t => {
  t.mock.method(globalThis, "fetch", async () => { assert.fail("no request expected"); });
  const absent = await requestDecisionsChoice({ ...input(), configuration: undefined });
  assert.equal(absent.providerOutcome.failureClass, "configuration");assert.equal(absent.decision.ok, false);
  const late = await requestDecisionsChoice({ ...input(), deadlineAt: Date.now() - 1 });
  assert.equal(late.providerOutcome.status, "timed-out");assert.equal(late.decision.ok, false);
});

test("DR205: HTTP and transport errors are distinct, redacted and never silently retried", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;if (calls === 4) throw new Error("private provider detail synthetic-secret");
    return new Response("private provider detail synthetic-secret", { status: [401, 429, 500][calls - 1] });
  });
  for (const failureClass of ["authentication", "rate-limit", "provider-http", "transport"]) {
    const r = await requestDecisionsChoice(input());assert.equal(r.providerOutcome.failureClass, failureClass);
    assert.equal(r.decision.ok, false);assert.doesNotMatch(JSON.stringify(r), /private provider detail|synthetic-secret/);
  }
  assert.equal(calls, 4);
});

test("DR205: timeout settles even when a transport ignores abort; late content cannot overwrite it", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let complete!: (response: Response) => void;let signal: AbortSignal | null | undefined;
  t.mock.method(globalThis, "fetch", async (_url: any, init: RequestInit) => {
    signal = init.signal;return new Promise<Response>(resolve => { complete = resolve; });
  });
  const pending = requestDecisionsChoice({ ...input(), deadlineAt: Date.now() + 100 });
  t.mock.timers.tick(101);
  const result = await pending;assert.equal(result.providerOutcome.status, "timed-out");assert.equal(signal?.aborted, true);
  complete(new Response(raw()));await Promise.resolve();
  assert.equal(result.decision.ok, false);assert.equal(result.rawOutput, "");
});

test("DR205: external cancellation is not a model failure and propagates as AbortError", async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => new Promise<Response>(() => {}));
  const pending = requestDecisionsChoice({ ...input(), signal: controller.signal });
  controller.abort();await assert.rejects(pending, { name: "AbortError" });
});

test("DR205: explicit actual-provider grouping shares slots across nominal tiers and keeps Gemini independent", async () => {
  const admission = new RuntimeInferenceProviderAdmissionCoordinator(1, 0);
  admission.configureProviderGroups({ fastFingerprint: "gemini", intelligentFingerprint: "claude" });
  const started: string[] = [];let release!: () => void;
  const first = admission.run({ operationId: "first", lane: "critical", providerTier: "fast", providerConfigFingerprint: "openai-decisions",
    signal: new AbortController().signal, execute: () => { started.push("first");return new Promise<void>(resolve => { release = resolve; }); } });
  const second = admission.run({ operationId: "second", lane: "critical", providerTier: "intelligent", providerConfigFingerprint: "openai-decisions",
    signal: new AbortController().signal, execute: async () => { started.push("second"); } });
  await admission.run({ operationId: "gemini", lane: "critical", providerTier: "fast", signal: new AbortController().signal,
    execute: async () => { started.push("gemini"); } });
  assert.deepEqual(started, ["first", "gemini"]);release();await first;await second;
  assert.deepEqual(started, ["first", "gemini", "second"]);
});
