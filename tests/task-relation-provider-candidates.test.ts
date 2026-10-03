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
    onObservation: (event: TaskRelationCandidateObservation): void => { events.push(event); } };
  const run = (selectorClock: RuntimeInferenceAdmissionClock = clock) => requestTaskRelationProviderCandidates(input, { clock: selectorClock, request: p => new Promise((resolve, reject) => {
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

// ---- ST183: the selector is the single stage-deadline arbiter ----

test("ST183-1 D1 the deadline timer is registered with the time remaining at registration", async () => {
  const h = harness();
  const delays: number[] = [];
  const now = h.clock.now, schedule = h.clock.schedule;
  let reads = 0;
  // 2 ms of synchronous work between the selector's first clock read and its timer registration.
  h.clock.now = () => { const at = now(); if (reads++ === 0) h.clock.time += 2; return at; };
  h.clock.schedule = (fn, ms) => { delays.push(ms); return schedule(fn, ms); };
  const promise = h.run();
  assert.equal(delays[0], 3998, "remaining time is recomputed from the absolute deadline");
  assert.deepEqual([...h.clock.timers.values()].map(timer => timer.at), [4000], "the timer is due at the stage deadline");
  h.clock.advance(2); await flush();
  h.clock.advance(500); h.calls.get("fast")!.resolve(result()); await flush();
  h.clock.advance(4000);
  const chosen = await promise;
  assert.equal(chosen.selectedProviderTier, "fast");
  assert.equal(chosen.selectedCandidateCompletedAt, 500);
  assert.equal(h.clock.now(), 4000, "selected at the deadline, not after it");
});

test("ST183-1 D1 a deadline that passes during setup is registered with a zero delay and regains no budget", async () => {
  const h = harness();
  const delays: number[] = [];
  const now = h.clock.now, schedule = h.clock.schedule;
  let reads = 0;
  h.clock.time = 3999;
  h.clock.now = () => { const at = now(); if (reads++ === 0) h.clock.time += 5; return at; };
  h.clock.schedule = (fn, ms) => { delays.push(ms); return schedule(fn, ms); };
  const promise = h.run();
  assert.equal(delays[0], 0);
  await flush(); h.clock.advance(4004); await flush();
  const chosen = await promise;
  assert.equal(chosen.parseDisposition, "candidate-deadline-expired");
  assert.equal(h.calls.size, 0, "no candidate is dispatched after the deadline");
});

// A completion is judged at one instant: the clock value read when its callback
// begins. Time that passes inside the callback (a synchronous observation sink,
// a pause between statements) can neither refuse a candidate that was on time nor
// stamp an accepted one past the deadline, where the consumer's cutoff drops it.
for (const tier of ["intelligent", "fast"] as const) for (const [name, pauseAfterRead, sinkCostMs] of [
  ["the observation sink costs 1 ms", () => 0, 1],
  ["1 ms passes after every clock read", () => 1, 0],
  ["2 ms pass between the second and the third clock read", (read: number) => (read === 2 ? 2 : 0), 0],
] as const) {
  test(`ST183-1 ST183-7 P1 ${tier === "intelligent" ? "an Intelligent" : "a Fast"} completion that begins 1 ms before the deadline keeps that one time when ${name}`, async () => {
    const h = harness();
    let armed = false, reads = 0;
    // The selector's own clock: once armed, time passes after each of its reads.
    const selectorClock: RuntimeInferenceAdmissionClock = { schedule: h.clock.schedule, cancel: h.clock.cancel,
      now: () => { const at = h.clock.time; if (armed) h.clock.time += pauseAfterRead(++reads); return at; } };
    h.input.onObservation = (event) => {
      h.events.push(event);
      if (armed && event.event === "completed") h.clock.time += sinkCostMs;
    };
    const promise = h.run(selectorClock); h.clock.advance(0); await flush();
    h.clock.advance(3999);
    armed = true;
    h.calls.get(tier)!.resolve(result("independent")); await flush();
    armed = false;
    // A cached Fast is selected by the deadline timer; an Intelligent result already ended the stage.
    h.clock.advance(Math.max(h.clock.time, 4000));
    const chosen = await promise;
    assert.equal(chosen.selectedProviderTier, tier);
    assert.equal(chosen.parsed.ok && "decision" in chosen.parsed.value && chosen.parsed.value.decision, "independent");
    assert.equal(chosen.selectedCandidateCompletedAt, 3999, "recorded completion time is the time the callback began");
    assert.ok(chosen.selectedCandidateCompletedAt! <= chosen.stageDeadlineAt, "the consumer's cutoff keeps the selection");
    assert.deepEqual(h.events.filter(e => e.event === "completed" && e.result).map(e => [e.providerTier, e.at]), [[tier, 3999]],
      "the observed completion time is the same instant");
  });
}

test("ST183-5 P1 a completion whose callback begins at the deadline is refused whatever a later clock read returns", async () => {
  const h = harness();
  let armed = false, reads = 0;
  // Only the time the callback began counts: a later, earlier-looking read cannot rescue the candidate.
  const selectorClock: RuntimeInferenceAdmissionClock = { schedule: h.clock.schedule, cancel: h.clock.cancel,
    now: () => (armed && ++reads > 1 ? 3999 : h.clock.time) };
  const promise = h.run(selectorClock); h.clock.advance(0); await flush();
  h.clock.advance(3999);
  h.clock.time = 4000;
  armed = true;
  h.calls.get("intelligent")!.resolve(result("independent")); await flush();
  armed = false;
  const chosen = await promise;
  assert.equal(chosen.selectedProviderTier, undefined);
  assert.equal(chosen.parseDisposition, "candidate-deadline-expired");
  assert.deepEqual(h.events.filter(e => e.event === "completed" && e.result).map(e => [e.providerTier, e.at]), [["intelligent", 4000]]);
});

// Collects what the selector reports about its own observation callback.
async function withCapturedWarnings<T>(run: (warnings: unknown[][]) => Promise<T>) {
  const warn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try { return await run(warnings); } finally { console.warn = warn; }
}

test("ST183-4 ST183-7 a failing observation sink cannot leave the selection unsettled or change it, and is reported", async () => {
  for (const failing of ["queued", "admitted", "completed", "selected", "cancelled"] as const) {
    await withCapturedWarnings(async warnings => {
      const h = harness();
      h.input.onObservation = (event) => {
        h.events.push(event);
        if (event.event === failing) throw new Error(`sink failed at ${failing}`);
      };
      const promise = h.run(); h.clock.advance(0); await flush();
      assert.equal(h.calls.size, 2, failing);
      h.clock.advance(500); h.calls.get("fast")!.resolve(result()); await flush();
      h.clock.advance(4000);
      const chosen = await promise;
      assert.equal(chosen.selectedProviderTier, "fast", failing);
      assert.equal(chosen.selectedCandidateCompletedAt, 500, failing);
      assert.equal(h.calls.get("intelligent")!.input.signal.aborted, true, failing);
      await flush();
      assert.equal(h.admission.readSnapshot("fast").activeCount + h.admission.readSnapshot("intelligent").activeCount, 0, failing);
      // The failure is isolated, not hidden: every failed observation is reported once.
      const failedObservations = h.events.filter(event => event.event === failing).length;
      assert.ok(failedObservations >= 1, failing);
      assert.deepEqual(warnings.map(([message, error]) => [message, (error as Error).message]),
        Array.from({ length: failedObservations }, () =>
          ["Relation candidate observation callback failed", `sink failed at ${failing}`]), failing);
    });
  }
});

test("ST183-4 a working observation sink reports nothing", async () => {
  await withCapturedWarnings(async warnings => {
    const h = harness();
    const promise = h.run(); h.clock.advance(0); await flush();
    h.clock.advance(500); h.calls.get("fast")!.resolve(result()); await flush();
    h.clock.advance(4000);
    assert.equal((await promise).selectedProviderTier, "fast");
    assert.deepEqual(warnings, []);
  });
});

test("ST183-4 a failing observation sink cannot swallow a source cancellation", async () => {
  await withCapturedWarnings(async () => {
    const h = harness();
    h.input.onObservation = (event) => { if (event.event === "cancelled") throw new Error("sink failed"); };
    const promise = h.run(); h.clock.advance(0); await flush();
    h.controller.abort();
    const settled = await Promise.race([
      promise.then(() => "resolved", (error: Error) => error.name),
      flush().then(() => "pending"),
    ]);
    assert.equal(settled, "AbortError");
  });
});

test("ST183-5 a candidate returning after the stage ended never rewrites the selection", async () => {
  const h = harness();
  const late = new Map<string, (r: TaskRelationSplitShadowRequestResult) => void>();
  // A provider that ignores cancellation and answers after the deadline.
  const promise = requestTaskRelationProviderCandidates(h.input, { clock: h.clock,
    request: p => new Promise(resolve => late.set(p.selectedProvider.variables.model, resolve)) });
  h.clock.advance(0); await flush();
  h.clock.advance(500); late.get("fast")!(result("independent")); await flush();
  h.clock.advance(4000);
  const chosen = await promise;
  h.clock.advance(4050); late.get("intelligent")!(result("related")); await flush();
  assert.equal(chosen.selectedProviderTier, "fast");
  assert.equal(chosen.parsed.ok && "decision" in chosen.parsed.value && chosen.parsed.value.decision, "independent");
  assert.equal(h.events.filter(e => e.event === "selected").length, 1);
});

// A blocked event loop can deliver a provider completion before the deadline timer
// that was due earlier. The stage ended at its deadline all the same: the selector
// refuses the completion where it arrives. Nothing behind the selector filters a
// Canonical selection, so this is what keeps a late answer out of the result.
const deliverDueTimers = (clock: Clock) => {
  for (const [id, timer] of [...clock.timers]) if (timer.at <= clock.time) { clock.timers.delete(id); timer.fn(); }
};
for (const [lateTier, cachedFast, processedAt] of [
  ["intelligent", false, 4050], ["intelligent", true, 4050], ["fast", false, 4050],
  ["intelligent", false, 4000], ["intelligent", true, 4000],
] as const) {
  test(`ST183-5 D6 ${lateTier === "intelligent" ? "an Intelligent" : "a Fast"} candidate processed at ${processedAt} ms, before the undelivered deadline timer, is refused (cached Fast=${cachedFast})`, async () => {
    const h = harness();
    let settled = false;
    const promise = h.run().then(chosen => { settled = true; return chosen; });
    h.clock.advance(0); await flush();
    if (cachedFast) { h.clock.advance(500); h.calls.get("fast")!.resolve(result("independent")); await flush(); }
    h.clock.advance(3999); await flush();
    assert.equal(settled, false, "the stage is open 1 ms before its deadline");
    // The event loop is blocked across the deadline: the timer due at 4000 has not run.
    h.clock.time = processedAt;
    assert.deepEqual([...h.clock.timers.values()].map(timer => timer.at), [4000], "the deadline timer is still undelivered");
    h.calls.get(lateTier)!.resolve(result("related")); await flush();
    assert.equal(settled, true, "the late completion ends the stage without waiting for the late timer");
    assert.equal(h.clock.timers.size, 0, "the deadline timer is cancelled");
    deliverDueTimers(h.clock); await flush();
    const chosen = await promise;
    assert.equal(chosen.selectedProviderTier, cachedFast ? "fast" : undefined);
    assert.equal(chosen.selectedCandidateCompletedAt, cachedFast ? 500 : undefined, "only a completion time before the deadline is reported");
    assert.equal(chosen.parsed.ok && "decision" in chosen.parsed.value && chosen.parsed.value.decision,
      cachedFast ? "independent" : false, "the late answer is not the selection");
    assert.equal(chosen.parseDisposition, cachedFast ? "valid-json" : "candidate-deadline-expired");
    assert.equal(chosen.stageDeadlineAt, 4000);
    // The late completion is observed as evidence, and never selected.
    assert.deepEqual(h.events.filter(e => e.event === "completed" && e.result).map(e => [e.providerTier, e.at]),
      [...(cachedFast ? [["fast", 500]] : []), [lateTier, processedAt]]);
    assert.deepEqual(h.events.filter(e => e.event === "selected").map(e => [e.providerTier, e.at]),
      cachedFast ? [["fast", processedAt]] : []);
    const otherTier = lateTier === "intelligent" ? "fast" : "intelligent";
    if (!cachedFast) assert.equal(h.calls.get(otherTier)!.input.signal.aborted, true, "the remaining request is cancelled");
  });
}

test("ST183-4 ST183-6 a selector entered at or after its deadline ends the stage at once: no timer, no queued candidate, no dispatch", async () => {
  for (const enteredAt of [4000, 4200]) {
    const h = harness();
    h.clock.time = enteredAt;
    let settled = false;
    const promise = h.run().then(chosen => { settled = true; return chosen; });
    assert.equal(h.clock.timers.size, 0, "no deadline timer and no admission timer is registered");
    assert.deepEqual(h.events.map(e => [e.providerTier, e.event]), [["intelligent", "cancelled"], ["fast", "cancelled"]],
      "no candidate is queued; both are reported as cancelled");
    await flush();
    assert.equal(settled, true, "settled without any timer being delivered");
    const chosen = await promise;
    assert.equal(chosen.parseDisposition, "candidate-deadline-expired");
    assert.equal(chosen.selectedProviderTier, undefined);
    assert.equal(chosen.completedAt, enteredAt);
    assert.equal(h.calls.size, 0, "no candidate is dispatched");
    assert.equal(h.admission.readSnapshot("fast").queuedCount + h.admission.readSnapshot("intelligent").queuedCount, 0);
  }
});

test("ST183-5 only a valid cached Fast is selected at the deadline; an invalid one is not reported as selected", async () => {
  const h = harness(), promise = h.run(); h.clock.advance(0); await flush();
  h.clock.advance(500); h.calls.get("fast")!.resolve(result("invalid")); await flush();
  h.clock.advance(4000);
  const chosen = await promise;
  assert.equal(chosen.parsed.ok, false);
  assert.equal(chosen.selectedProviderTier, undefined);
  assert.equal(chosen.selectedCandidateCompletedAt, undefined);
  assert.equal(h.events.some(e => e.event === "selected"), false);
  assert.equal(h.calls.get("intelligent")!.input.signal.aborted, true);
});
