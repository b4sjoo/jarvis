import assert from "node:assert/strict";
import test from "node:test";
import { requestTaskRelationProviderCandidates, type TaskRelationCandidateObservation } from "../src/lib/meeting/task-relation-provider-candidates.js";
import { RuntimeInferenceProviderAdmissionCoordinator, type RuntimeInferenceAdmissionClock } from "../src/lib/meeting/runtime-inference-provider-admission.js";
import { resolveRuntimeInferenceModelRouteFromSnapshot } from "../src/lib/meeting/meeting-model-route.js";
import type { TaskRelationAffinityRequest } from "../src/lib/meeting/task-relation-split-shadow.js";
import type { TaskRelationSplitShadowRequestResult } from "../src/lib/meeting/task-relation-split-shadow-request.js";

class Clock implements RuntimeInferenceAdmissionClock {
  time = 0;
  timers = new Map<number, { at: number; fn: () => void }>();
  serial = 0;
  now = () => this.time;
  schedule = (fn: () => void, ms: number) => { const id = ++this.serial; this.timers.set(id, { at: this.time + ms, fn }); return id; };
  cancel = (id: unknown) => { this.timers.delete(id as number); };
  advance(at: number) {
    for (;;) {
      const next = [...this.timers].filter(([, t]) => t.at <= at).sort((a,b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].fn();
    }
    this.time = at;
  }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function result(decision: "related" | "independent" | "unclear" | "invalid" = "related"): TaskRelationSplitShadowRequestResult {
  return { rawOutput: decision, parsed: decision === "invalid"
    ? { ok: false, reason: "malformed-json", errorKind: "parse", evidenceSpansValid: false }
    : { ok: true, value: { schemaVersion: 1, affinityKind: "parent", decision, confidence: 0.1, currentEvidenceSpans: ["ask"], branchEvidenceSpans: ["parent"] }, evidenceSpansValid: true },
    providerDisposition: "completed-with-content", parseDisposition: decision === "invalid" ? "malformed-json" : "valid-json", completedAt: 0 };
}
function harness() {
  const clock = new Clock(), admission = new RuntimeInferenceProviderAdmissionCoordinator(3, 0, clock);
  const snapshot = { providers: [{ id: "p", curl: "https://p.test" }],
    selectedProvider: { provider: "p", variables: { model: "intelligent" } },
    taxonomyAdjudicationProvider: { provider: "p", variables: { model: "fast" } },
    codingProvider: { provider: "p", variables: { model: "coding" } } };
  const routes = {
    intelligent: resolveRuntimeInferenceModelRouteFromSnapshot({ snapshot, operationKind: "task-relation-parent-affinity" }),
    fast: resolveRuntimeInferenceModelRouteFromSnapshot({ snapshot, operationKind: "task-relation-parent-affinity", providerTier: "fast" }),
  };
  admission.configureProviderGroups({ fastFingerprint: routes.fast.configFingerprint, intelligentFingerprint: routes.intelligent.configFingerprint });
  const calls = new Map<string, { input: any; resolve: (r: TaskRelationSplitShadowRequestResult) => void; reject: (e: Error) => void }>();
  const events: TaskRelationCandidateObservation[] = [];
  const controller = new AbortController();
  const input = { request: { operationKind: "task-relation-parent-affinity" } as TaskRelationAffinityRequest,
    operationId: "op", routes, admission, lane: "critical" as const, deadlineAt: 4000, signal: controller.signal,
    executionIdentity: { requestId: "logical", executionPlanId: "logical", modelId: "must-not-leak-to-fast", sessionId: "s" },
    onObservation: (event: TaskRelationCandidateObservation) => events.push(event) };
  const run = () => requestTaskRelationProviderCandidates(input, { clock, request: p => new Promise((resolve, reject) => {
    calls.set(p.selectedProvider.variables.model, { input: p, resolve, reject });
    p.signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
  }) });
  return { clock, admission, calls, events, controller, input, run };
}

test("PA1 Fast caches with no publication; timely valid Intelligent including unclear and low confidence wins", async () => {
  for (const primary of ["related", "unclear"] as const) {
    const h = harness(); let published = 0;
    const promise = h.run().then(r => { published++; return r; });
    h.clock.advance(0); await flush();
    assert.equal(h.calls.size, 2);
    for (const call of h.calls.values()) {
      assert.equal(call.input.request, h.input.request);
      assert.equal(call.input.timeoutMs, 4000);
      assert.equal(call.input.executionIdentity.executionPlanId, "logical");
      assert.equal(call.input.executionIdentity.modelId, undefined);
    }
    assert.notEqual(h.calls.get("fast")!.input.executionIdentity.requestId, h.calls.get("intelligent")!.input.executionIdentity.requestId);
    h.clock.advance(600); h.calls.get("fast")!.resolve(result("independent")); await flush();
    assert.equal(published, 0);
    h.clock.advance(1200); h.calls.get("intelligent")!.resolve(result(primary)); await flush();
    const chosen = await promise;
    assert.equal(chosen.selectedProviderTier, "intelligent");
    assert.equal(chosen.parsed.ok && "decision" in chosen.parsed.value && chosen.parsed.value.decision, primary);
    assert.equal(published, 1);
    assert.equal(h.events.filter(e => e.event === "selected").length, 1);
  }
});

test("PA2 invalid primary uses cached Fast early; pending primary uses Fast at common deadline with no extra wait", async () => {
  for (const invalid of [false, true]) {
    const h = harness(), promise = h.run(); h.clock.advance(0); await flush();
    h.clock.advance(500); h.calls.get("fast")!.resolve(result()); await flush();
    if (invalid) { h.clock.advance(700); h.calls.get("intelligent")!.resolve(result("invalid")); await flush(); }
    else h.clock.advance(4000);
    const chosen = await promise;
    assert.equal(chosen.selectedProviderTier, "fast");
    assert.equal(h.clock.now(), invalid ? 700 : 4000);
    assert.equal(h.calls.get("intelligent")!.input.signal.aborted, true);
  }
});

test("PA2 deadline excludes candidate at4000 but admits3999; both unavailable stay unresolved", async () => {
  for (const at of [3999, 4000]) {
    const h = harness(), promise = h.run(); h.clock.advance(0); await flush();
    h.clock.advance(at); h.calls.get("intelligent")!.resolve(result()); await flush();
    const chosen = await promise;
    assert.equal(chosen.selectedProviderTier, at === 3999 ? "intelligent" : undefined);
    assert.equal(chosen.parsed.ok, at === 3999);
  }
});

test("PA3 source cancellation rejects and cancels both instead of selecting cached Fast", async () => {
  const h = harness(), promise = h.run(); h.clock.advance(0); await flush();
  h.calls.get("fast")!.resolve(result()); await flush();
  h.controller.abort();
  await assert.rejects(promise, { name: "AbortError" });
  assert.equal(h.events.some(e => e.event === "selected"), false);
  assert.equal(h.calls.get("intelligent")!.input.signal.aborted, true);
});

test("PA3 client failure surfaces without Fast semantic fallback; internal failure rejects", async () => {
  for (const failureClass of ["authentication", "configuration", "unexpected"] as const) {
    const h = harness(), promise = h.run(); h.clock.advance(0); await flush();
    h.calls.get("fast")!.resolve(result()); await flush();
    const failure = result("invalid");
    failure.providerOutcome = { status: "failed", failureClass } as any;
    h.calls.get("intelligent")!.resolve(failure);
    if (failureClass === "unexpected") await assert.rejects(promise, /Internal Relation/);
    else { const chosen = await promise; assert.equal(chosen.selectedProviderTier, "intelligent"); assert.equal(chosen.parsed.ok, false); }
  }
});

test("PA4 admission queue consumes stage budget; expired queued candidate never dispatches", async () => {
  const h = harness();
  const blockers: Array<() => void> = [];
  for (const tier of ["fast", "intelligent"] as const) for (let i = 0; i < 3; i++) {
    void h.admission.run({ operationId: `${tier}-block${i}`, lane: "critical", providerTier: tier,
      signal: new AbortController().signal, execute: () => new Promise<void>(resolve => blockers.push(resolve)) });
  }
  h.clock.advance(0); await flush();
  const promise = h.run(); h.clock.advance(0); await flush();
  assert.equal(h.calls.size, 0);
  h.clock.advance(4000); const chosen = await promise;
  blockers.forEach(release => release()); await flush(); h.clock.advance(4001); await flush();
  assert.equal(chosen.parsed.ok, false); assert.equal(h.calls.size, 0);
});

test("PA4 queued candidate receives remaining time, and physical admissions keep existing cap", async () => {
  const h = harness(); const releases: Array<() => void> = [];
  for (let i = 0; i < 3; i++) void h.admission.run({ operationId: `block${i}`, lane: "critical", providerTier: "fast",
    signal: new AbortController().signal, execute: () => new Promise<void>(resolve => releases.push(resolve)) });
  h.clock.advance(0); await flush(); const promise = h.run(); h.clock.advance(0); await flush();
  h.clock.advance(1000); releases[0](); await flush(); h.clock.advance(1000); await flush();
  assert.equal(h.calls.get("fast")!.input.timeoutMs, 3000);
  assert.ok(h.events.filter(e => e.admission).every(e => e.admission!.activeCountAtAdmission <= 3));
  h.calls.get("intelligent")!.resolve(result()); await promise; releases.slice(1).forEach(r => r());
});

test("PA4 admission at deadline before timer delivery still selects already cached Fast", async () => {
  const h = harness(), releases: Array<() => void> = [];
  for (let i = 0; i < 3; i++) void h.admission.run({ operationId: `block${i}`, lane: "critical", providerTier: "intelligent",
    signal: new AbortController().signal, execute: () => new Promise<void>(resolve => releases.push(resolve)) });
  h.clock.advance(0); await flush();
  const promise = h.run(); h.clock.advance(0); await flush();
  h.clock.advance(500); h.calls.get("fast")!.resolve(result()); await flush();
  const deadlineTimer = [...h.clock.timers].find(([, timer]) => timer.at === 4000)![0];
  h.clock.time = 4000;
  releases[0](); await flush();
  for (const [id, timer] of [...h.clock.timers]) {
    if (id !== deadlineTimer && timer.at <= 4000) { h.clock.timers.delete(id); timer.fn(); }
  }
  await flush();
  const chosen = await promise;
  assert.equal(chosen.selectedProviderTier, "fast");
  assert.equal(chosen.selectedCandidateCompletedAt, 500);
  assert.equal(h.calls.has("intelligent"), false);
  assert.equal(h.controller.signal.aborted, false);
  releases.slice(1).forEach(release => release());
});
