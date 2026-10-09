import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { captureRuntimeDecisionBackend, formatRuntimeDecisionBackendForTrace } from "../src/lib/meeting/decisions-runtime.js";
import { RuntimeInferenceSessionCircuitBreaker } from "../src/lib/meeting/runtime-inference-health.js";
import { RuntimeInferenceProviderAdmissionCoordinator } from "../src/lib/meeting/runtime-inference-provider-admission.js";
import { RuntimeInferenceOperationRuntime } from "../src/lib/meeting/runtime-inference-runtime.js";
import type * as TypeRequest from "../src/lib/meeting/question-type-adjudication-request.js";
import { buildQuestionTypeAdjudicationRequest } from "../src/lib/meeting/question-type-adjudication.js";
import { composeCanonicalTurnCandidate } from "../src/lib/meeting/logical-question-unit.js";
import type * as RoRequest from "../src/lib/meeting/short-intent-gate-request.js";
import { buildResponseOpportunityRequest, decideResponseOpportunityRelease } from "../src/lib/meeting/short-intent-gate.js";
import type * as RelationRequest from "../src/lib/meeting/task-relation-decisions-request.js";
import { decideOrderedTaskRelationResolution, projectOrderedTaskRelationAdjudication,
  type TaskRelationAffinityRequest, type TaskRelationCanonicalShadowRequest } from "../src/lib/meeting/task-relation-split-shadow.js";
import { resolveRuntimeInferenceModelRouteFromSnapshot } from "../src/lib/meeting/meeting-model-route.js";
import type { TaskRelationCandidateObservation } from "../src/lib/meeting/task-relation-provider-candidates.js";

const require = createRequire(import.meta.url);
const bundle = await require("esbuild").build({ stdin: { resolveDir: process.cwd(), loader: "ts", contents: [
  "question-type-adjudication-request", "short-intent-gate-request", "task-relation-decisions-request",
].map(name => `export * from './src/lib/meeting/${name}.ts';`).join("\n") }, bundle: true, write: false,
  platform: "node", format: "cjs", logLevel: "silent" });
const loaded = { exports: {} as typeof TypeRequest & typeof RoRequest & typeof RelationRequest };
new Function("module", "exports", "require", bundle.outputFiles[0].text)(loaded, loaded.exports, require);
const { requestQuestionTypeAdjudication, requestResponseOpportunity, requestTaskRelationDecisions } = loaded.exports;

const provider = { id: "fixture", streaming: false, responseContentPath: "text",
  curl: `curl https://fast.fixture/request -H 'Content-Type: application/json' -d '{"model":"fast-fixture","messages":[{"role":"system","content":"{{SYSTEM_PROMPT}}"},{"role":"user","content":"{{TEXT}}"}]}'` };
const selectedProvider = { provider: "fixture", variables: { model: "fast-fixture" } };
const backend = captureRuntimeDecisionBackend(true, { provider: "openai-decisions", variables: { api_key: "synthetic-secret" } });
assert.equal(backend.kind, "decisions");
const decisionsBackend = backend as Extract<typeof backend, { kind: "decisions" }>;
const original = { intent: "direct-question" as const, evidence: [], reason: "fixture" };
const turn = { id: "turn", speaker: "them" as const, source: "system-audio" as const, text: "How do we evict entries?", startedAt: 1, endedAt: 2, isFinal: true };
const unit = composeCanonicalTurnCandidate({ currentTurn: turn, sessionId: "s", runtimeEpoch: 1, intentDecision: original });
const identity = { requestId: "request", executionPlanId: "plan", modelId: "ignored", sessionId: "s", runtimeEpoch: 1,
  logicalQuestionUnitId: unit.id, logicalQuestionRevision: unit.revision };
const core = (name: string, choice: string, probability = .4) => new Response(JSON.stringify({ answers: [{ name, type: "choice", choice,
  confidence: .99, probabilities: [{ value: choice, probability }] }] }));
const fast = (text: string) => new Response(JSON.stringify({ text }), { headers: { "Content-Type": "application/json" } });
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const roInput = () => ({ request: buildResponseOpportunityRequest({ logicalQuestionUnit: unit }), provider, selectedProvider,
  backend, signal: new AbortController().signal, admission: new RuntimeInferenceProviderAdmissionCoordinator(), executionIdentity: identity });
const fastRoute = resolveRuntimeInferenceModelRouteFromSnapshot({ snapshot: { providers: [provider], selectedProvider,
  taxonomyAdjudicationProvider: selectedProvider, codingProvider: selectedProvider }, operationKind: "task-relation-parent-affinity", providerTier: "fast" });
const relationIdentity = { sessionId: "s", runtimeEpoch: 1, logicalQuestionUnitId: unit.id, logicalQuestionUnitRevision: unit.revision,
  sourceSettlementId: "settlement", sourceHash: "source", parentId: "parent", parentRevision: 1, manualCorrectionRevision: 0 };
const affinity: TaskRelationAffinityRequest<"parent"> = { operationKind: "task-relation-parent-affinity", affinityKind: "parent", promptVersion: "fixture", schemaVersion: 1,
  identity: relationIdentity, semanticPayloadDigest: "fixture", semanticPayload: { currentQuestion: { sourceTexts: [turn.text] },
    activeParent: { topic: "Design a cache", objective: "Design a cache", acceptedConstraints: [], sourceEvidence: ["Design a cache"] }, recentParentEvidence: [] } };
const canonical: TaskRelationCanonicalShadowRequest = { operationKind: "task-relation-canonical-shadow", promptVersion: "fixture", schemaVersion: 3,
  identity: relationIdentity, semanticPayloadDigest: "fixture", semanticPayload: { currentQuestion: { sourceTexts: [turn.text] },
    activeParent: { topic: "Design a cache", objective: "Design a cache", acceptedConstraints: [] }, recentEvidence: [], affinity: { parent: { status: "unknown" } } } };
const relationInput = () => ({ request: affinity, backend: decisionsBackend, operationId: "relation", executionIdentity: identity, fastRoute,
  admission: new RuntimeInferenceProviderAdmissionCoordinator(), lane: "critical" as const, signal: new AbortController().signal, deadlineAt: Date.now() + 4000 });

test("DR205 snapshot and circuit: no credential inheritance, stable in-flight configuration, separate actual-provider health", () => {
  const selected = { provider: "openai-decisions", variables: { api_key: "first-secret" } };
  const pinned = captureRuntimeDecisionBackend(true, selected);assert.equal(pinned.kind, "decisions");
  selected.variables.api_key = "second-secret";
  assert.equal(pinned.kind === "decisions" && pinned.configuration?.apiKey, "first-secret");
  assert.doesNotMatch(JSON.stringify(formatRuntimeDecisionBackendForTrace(pinned)), /first-secret|second-secret/);
  assert.deepEqual(captureRuntimeDecisionBackend(false, selected), { kind: "existing" });
  const circuit = new RuntimeInferenceSessionCircuitBreaker();
  circuit.open({ operationKind: "question-type-adjudication", sessionId: "s", reason: "provider-auth-error" });
  assert.equal(circuit.read("question-type-adjudication", "s", "decisions-key").open, false);
  circuit.open({ operationKind: "question-type-adjudication", sessionId: "s", providerConfigFingerprint: "decisions-key", reason: "provider-auth-error" });
  assert.equal(circuit.read("question-type-adjudication", "s").open, true);
  assert.equal(circuit.read("question-type-adjudication", "s", "new-key").open, false);
  assert.equal(circuit.read("question-type-adjudication", "new-session", "decisions-key").open, false);
});

test("DR205 Type: one Decisions call, no evidence model, low known score retained; narrow Screen review stays legacy", async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: any, init: RequestInit) => {
    calls.push(String(url));const body = JSON.parse(String(init.body));
    if (body.questions) {
      assert.doesNotMatch(body.questions[0].instructions, /Schema:|Always include v/);
      return core("question_type", "coding", .1);
    }
    return fast(JSON.stringify({ v: 1, cs: .8, fs: .1, us: .1, e: "evict entries" }));
  });
  const request = buildQuestionTypeAdjudicationRequest({ logicalQuestionUnit: unit });
  const result = await requestQuestionTypeAdjudication({ request, provider, selectedProvider, backend, signal: new AbortController().signal, executionIdentity: identity });
  assert.ok(result.parsed.ok);assert.equal(result.parsed.value.questionType, "coding");assert.equal(result.parsed.value.confidence, .1);
  assert.deepEqual(result.parsed.value.evidenceSpans, []);assert.equal(calls.length, 1);
  const narrow = await requestQuestionTypeAdjudication({ request: { ...request, reviewScope: "field-vs-coding" }, provider, selectedProvider,
    backend, signal: new AbortController().signal, executionIdentity: identity });
  assert.ok(narrow.parsed.ok);assert.equal(narrow.parsed.value.fieldCodingScores?.codingScore, .8);
  assert.deepEqual(calls, ["https://api.openai.com/v1/decisions", "https://fast.fixture/request"]);
});

test("DR205 RO: only core decides; no-output needs no extraction and known low scores remain authoritative", async t => {
  let choice = "no-output-request", calls = 0;
  t.mock.method(globalThis, "fetch", async (url: any) => { calls++;assert.match(String(url), /api.openai.com/);return core("response_opportunity", choice, .1); });
  const result = await requestResponseOpportunity(roInput());assert.ok(result.parsed.ok);
  assert.equal(decideResponseOpportunityRelease({ result: result.parsed.value, original }).generationDisposition, "output-suppressed");
  assert.equal(result.decisionMetadata?.responseOpportunityTargetExtractionRequested, false);assert.equal(calls, 1);
  choice = "unclear";
  const unknown = await requestResponseOpportunity(roInput());assert.ok(unknown.parsed.ok);
  assert.equal(decideResponseOpportunityRelease({ result: unknown.parsed.value, original }).generationDisposition, "unresolved");assert.equal(calls, 2);
});

test("DR205 RO: invalid targets fall back locally; Fast cannot change the core decision or score", async t => {
  let target = '{"t":[0],"d":"n","c":1}';let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: any) => { calls++;return String(url).includes("api.openai.com")
    ? core("response_opportunity", "output-request", .2) : fast(target); });
  for (const valid of [true, false]) {
    if (!valid) target = '{"t":[999]}';
    const result = await requestResponseOpportunity(roInput());assert.ok(result.parsed.ok);
    assert.equal(result.parsed.value.decision, "output-request");assert.equal(result.parsed.value.confidence, .2);
    assert.equal(Boolean(result.parsed.value.decisionTarget), valid);
    assert.equal(decideResponseOpportunityRelease({ result: result.parsed.value, original }).generationDisposition, "output-authorized");
  }
  assert.equal(calls, 4);
});

test("DR205 RO: the shared deadline bounds extraction without losing the ready core", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });let fastStarted = false;
  t.mock.method(globalThis, "fetch", async (url: any) => {
    if (String(url).includes("api.openai.com")) return core("response_opportunity", "output-request");
    fastStarted = true;return new Promise<Response>(() => {});
  });
  const pending = requestResponseOpportunity({ ...roInput(), deadlineAt: 3200 });await flush();assert.equal(fastStarted, true);
  t.mock.timers.tick(2200);await flush();
  const result = await pending;assert.ok(result.parsed.ok);assert.equal(result.parsed.value.decision, "output-request");
  assert.equal(result.parsed.value.decisionTarget, "");assert.equal(result.completedAt, 3200);
});

test("DR205 Affinity: Fast quotes only, core low score and decision preserved, distinct provider admissions", async t => {
  const events: TaskRelationCandidateObservation[] = [];
  t.mock.method(globalThis, "fetch", async (url: any) => String(url).includes("api.openai.com") ? core("affinity", "related", .4)
    : fast('{"q":"evict entries","b":"Design a cache","d":"i","c":1}'));
  const result = await requestTaskRelationDecisions({ ...relationInput(), onObservation: event => { events.push(event); } });
  assert.ok(result.parsed.ok && "affinityKind" in result.parsed.value);
  assert.equal(result.parsed.value.decision, "related");assert.equal(result.parsed.value.confidence, .4);
  assert.deepEqual(result.parsed.value.currentEvidenceSpans, ["evict entries"]);
  assert.equal(events.filter(e => e.event === "selected").length, 1);
  assert.equal(events.find(e => e.event === "selected")?.role, "decision");
  const admitted = events.filter(e => e.event === "admitted");assert.equal(admitted.length, 2);
  assert.notEqual(admitted[0].admission?.providerGroupKey, admitted[1].admission?.providerGroupKey);
  assert.equal(result.decisionMetadata?.taskRelationParentAffinityDecisionSelectedProbability, .4);
});

test("DR205 Affinity: missing evidence never vetoes core; unknown/config error never call Fast", async t => {
  let choice = "related", calls = 0;
  t.mock.method(globalThis, "fetch", async (url: any) => { calls++;return String(url).includes("api.openai.com") ? core("affinity", choice) : fast('{"q":"invented","b":"invented"}'); });
  const result = await requestTaskRelationDecisions(relationInput());assert.ok(result.parsed.ok && "affinityKind" in result.parsed.value);
  assert.deepEqual(result.parsed.value.currentEvidenceSpans, []);assert.equal(result.parsed.value.decision, "related");assert.equal(calls, 2);
  choice = "unclear";
  const unknown = await requestTaskRelationDecisions(relationInput());assert.ok(unknown.parsed.ok);assert.equal(calls, 3);
  const missing = await requestTaskRelationDecisions({ ...relationInput(), backend: { ...decisionsBackend, configuration: undefined } });
  assert.equal(missing.parsed.ok, false);assert.equal(missing.selectionReason, "client-error");assert.equal(calls, 3);
});

test("DR205 Canonical: no trace-only evidence call; valid quote-free core reaches the same ordered relation projection", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: any) => { calls++;assert.match(String(url), /api.openai.com/);return core("canonical_relation", "followup-parent", .2); });
  const result = await requestTaskRelationDecisions({ ...relationInput(), request: canonical });
  assert.ok(result.parsed.ok && "relation" in result.parsed.value);
  const resolution = decideOrderedTaskRelationResolution({ sourceKind: "voice", currentQuestionType: "general-system-design",
    activeParentQuestionType: "general-system-design", hasActiveChild: false, canonical: result.parsed.value });
  assert.equal(resolution.stage, "canonical-relation");assert.equal(resolution.relation, "followup-parent");
  assert.equal(projectOrderedTaskRelationAdjudication(resolution)?.relation, "followup-parent");assert.equal(calls, 1);
});

test("DR205 Affinity: extraction deadline preserves the earlier core receipt and cannot publish a late quote", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let finishEvidence!: (response: Response) => void;
  const events: TaskRelationCandidateObservation[] = [];
  t.mock.method(globalThis, "fetch", async (url: any) => String(url).includes("api.openai.com") ? core("affinity", "related", .7)
    : new Promise<Response>(resolve => { finishEvidence = resolve; }));
  const pending = requestTaskRelationDecisions({ ...relationInput(), onObservation: event => events.push(event) });
  await flush();assert.ok(finishEvidence);
  t.mock.timers.tick(4000);await flush();
  const result = await pending;
  assert.ok(result.parsed.ok && "affinityKind" in result.parsed.value);
  assert.equal(result.parsed.value.decision, "related");assert.equal(result.selectedCandidateCompletedAt, 1000);
  assert.equal(result.completedAt, 5000);assert.deepEqual(result.parsed.value.currentEvidenceSpans, []);
  finishEvidence(fast('{"q":"evict entries","b":"Design a cache"}'));await flush();
  assert.deepEqual(result.parsed.value.currentEvidenceSpans, []);
  assert.equal(events.filter(e => e.event === "selected").length, 1);
});

test("DR205 cancellation during evidence rejects the operation; authentication never starts auxiliary or old-chain calls", async t => {
  let calls = 0, evidenceStarted = false, authenticationFailure = false;
  t.mock.method(globalThis, "fetch", async (url: any) => {
    calls++;
    if (String(url).includes("api.openai.com")) return authenticationFailure ? new Response("denied", { status: 401 }) : core("affinity", "related");
    evidenceStarted = true;return new Promise<Response>(() => {});
  });
  const controller = new AbortController();
  const events: TaskRelationCandidateObservation[] = [];
  const pending = requestTaskRelationDecisions({ ...relationInput(), signal: controller.signal, onObservation: event => events.push(event) });
  await flush();assert.equal(evidenceStarted, true);controller.abort();
  await assert.rejects(pending, error => error instanceof Error && error.name === "AbortError");
  assert.equal(events.filter(e => e.event === "selected").length, 0);
  authenticationFailure = true;calls = 0;
  const rejected = await requestTaskRelationDecisions(relationInput());
  assert.equal(rejected.parsed.ok, false);assert.equal(rejected.selectionReason, "client-error");assert.equal(calls, 1);
});

test("DR205 request-owned admission releases OpenAI while Fast extraction remains pending", async t => {
  let finishFast!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", async (url: any) => String(url).includes("api.openai.com") ? core("response_opportunity", "output-request")
    : new Promise<Response>(resolve => { finishFast = resolve; }));
  const admission = new RuntimeInferenceProviderAdmissionCoordinator(1, 0);
  const runtime = new RuntimeInferenceOperationRuntime<any, any>("response-opportunity-inference", admission);
  const complete = new Promise<void>(resolve => runtime.schedule({
    job: { operationId: "ro", operationKind: "response-opportunity-inference", sessionId: "s", budgetKey: "question", budgetSlot: "intent",
      budgetReason: "fixture", providerAdmissionManagedByRequest: true },
    execute: (_job, signal) => requestResponseOpportunity({ ...roInput(), admission, signal }),
    onSettled: () => resolve(),
  }, 0));
  await new Promise(resolve => setTimeout(resolve, 0));await flush();assert.ok(finishFast);
  let entered = false;
  await admission.run({ operationId: "next-openai", lane: "critical", providerTier: "intelligent",
    providerConfigFingerprint: decisionsBackend.providerConfigFingerprint, signal: new AbortController().signal,
    execute: async () => { entered = true; } });
  assert.equal(entered, true);finishFast(fast('{"t":[0]}'));await complete;
});
