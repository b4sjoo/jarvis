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
    assert.equal(chosen.selectionReason, "intelligent-valid");
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
    // The same tier and the same valid result, for two different triggers.
    assert.equal(chosen.selectionReason, invalid ? "intelligent-invalid-fast-valid" : "candidate-deadline-expired");
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
    assert.equal(chosen.selectionReason, at === 3999 ? "intelligent-valid" : "candidate-deadline-expired");
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
    else {
      const chosen = await promise; assert.equal(chosen.selectedProviderTier, "intelligent"); assert.equal(chosen.parsed.ok, false);
      // A selected tier is not a usable candidate: the reason says why the stage ended.
      assert.equal(chosen.selectionReason, "client-error");
    }
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
  assert.equal(chosen.selectionReason, "candidate-deadline-expired");
});

test("PA4 queued candidate receives remaining time, and physical admissions keep existing cap", async () => {
  const h = harness(); const releases: Array<() => void> = [];
  for (let i = 0; i < 3; i++) void h.admission.run({ operationId: `block${i}`, lane: "critical", providerTier: "fast",
    signal: new AbortController().signal, execute: () => new Promise<void>(resolve => releases.push(resolve)) });
  h.clock.advance(0); await flush(); const promise = h.run(); h.clock.advance(0); await flush();
  h.clock.advance(1000); releases[0](); await flush(); h.clock.advance(1000); await flush();
  assert.equal(h.calls.get("fast")!.input.timeoutMs, 3000);
  assert.ok(h.events.filter(e => e.admission).every(e => e.admission!.activeCountAtAdmission <= 3));
  h.calls.get("intelligent")!.resolve(result());
  assert.equal((await promise).selectionReason, "intelligent-valid");
  releases.slice(1).forEach(r => r());
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
  assert.equal(chosen.selectionReason, "candidate-deadline-expired");
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
  assert.equal(chosen.selectionReason, "candidate-deadline-expired");
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
  assert.equal(chosen.selectionReason, "candidate-deadline-expired");
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
    // A valid Intelligent ends the stage itself; a cached Fast is selected by the deadline timer.
    assert.equal(chosen.selectionReason, tier === "intelligent" ? "intelligent-valid" : "candidate-deadline-expired");
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
  assert.equal(chosen.selectionReason, "candidate-deadline-expired");
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
      assert.equal(chosen.selectionReason, "candidate-deadline-expired", failing);
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
    const chosen = await promise;
    assert.equal(chosen.selectedProviderTier, "fast");
    assert.equal(chosen.selectionReason, "candidate-deadline-expired");
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
  assert.equal(chosen.selectionReason, "candidate-deadline-expired", "the late answer does not rewrite the reason either");
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
    assert.equal(chosen.selectionReason, "candidate-deadline-expired", "ended by a completion that arrived at or after the deadline");
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
    assert.equal(chosen.selectionReason, "candidate-deadline-expired");
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
  // The recorded parse reason is the cached candidate's; the deadline is named by the reason.
  assert.equal(chosen.parseDisposition, "malformed-json");
  assert.equal(chosen.selectionReason, "candidate-deadline-expired");
  assert.equal(chosen.selectedCandidateCompletedAt, undefined);
  assert.equal(h.events.some(e => e.event === "selected"), false);
  assert.equal(h.calls.get("intelligent")!.input.signal.aborted, true);
});

// ---------------------------------------------------------------------------
// Task 178 LG3. The selection reason is the branch that ended the stage. It is
// passed as an argument where the selector already decides, so it can be read
// next to a selected tier that does not say why it was selected. Each row drives
// one of those branches through the real selector, the real admission
// coordinator and real route resolution; only the physical request and the
// clock are substituted. Next to the reason, every row states the facts the
// reason must not change: the selected tier, the parse result and disposition,
// the completion time, the stage deadline, the physical calls with their
// timeouts and aborted signals, the selector's timer registrations and the
// ordered observation list.
// ---------------------------------------------------------------------------

type Lg3Harness = ReturnType<typeof harness> & { registrations: number[]; start: () => ReturnType<ReturnType<typeof harness>["run"]> };
function lg3Harness(): Lg3Harness {
  const h = harness();
  const registrations: number[] = [];
  // The selector's own clock: what it registers is recorded, the admission coordinator's timers are not.
  const selectorClock: RuntimeInferenceAdmissionClock = { now: () => h.clock.now(), cancel: h.clock.cancel,
    schedule: (fn, ms) => { registrations.push(ms); return h.clock.schedule(fn, ms); } };
  return Object.assign(h, { registrations, start: () => h.run(selectorClock) });
}
function failed(failureClass: "authentication" | "configuration" | "unexpected" | undefined,
  providerDisposition: TaskRelationSplitShadowRequestResult["providerDisposition"] = "completed-with-content") {
  const failure = result("invalid");
  failure.providerDisposition = providerDisposition;
  if (failureClass) failure.providerOutcome = { status: "failed", failureClass } as any;
  return failure;
}
// Three busy slots of one tier, so that a candidate of that tier waits for admission.
async function occupy(h: Lg3Harness, tier: "intelligent" | "fast") {
  const releases: Array<() => void> = [];
  for (let index = 0; index < 3; index++) void h.admission.run({ operationId: `block-${tier}-${index}`, lane: "critical", providerTier: tier,
    signal: new AbortController().signal, execute: () => new Promise<void>(resolve => releases.push(resolve)) });
  h.clock.advance(0); await flush();
  return releases;
}
interface Lg3Facts {
  reason: string | null; tier: string | null; parsedOk: boolean; parseDisposition: string; providerDisposition: string;
  selectedCandidateCompletedAt: number | null; stageDeadlineAt: number;
  // [model, per-call timeout, aborted signal], in dispatch order.
  calls: Array<[string, number, boolean]>;
  // The delays the selector registered with its clock.
  registrations: number[];
  // "tier:event@time", in the order the observations were made.
  events: string[];
}
// Both candidates queued and admitted at once: a slot of each tier is free.
const STARTED = ["intelligent:queued@0", "intelligent:admitted@0", "fast:queued@0", "fast:admitted@0"];
const BOTH_ABORTED: Lg3Facts["calls"] = [["intelligent", 4000, true], ["fast", 4000, true]];
const cacheFast = async (h: Lg3Harness, at: number, decision: Parameters<typeof result>[0] = "independent") => {
  h.clock.advance(at); h.calls.get("fast")!.resolve(result(decision)); await flush();
};

interface Lg3Row {
  name: string;
  // Before the selector starts: the clock or the admission slots.
  before?: (h: Lg3Harness) => Promise<Array<() => void> | void>;
  after: (h: Lg3Harness, releases: Array<() => void>) => Promise<void>;
  expected: Lg3Facts;
}
const LG3_ROWS: Lg3Row[] = [
  { name: "entered at its deadline, before any candidate is queued",
    before: async (h) => { h.clock.time = 4000; },
    after: async () => {},
    expected: { reason: "candidate-deadline-expired", tier: null, parsedOk: false, parseDisposition: "candidate-deadline-expired",
      providerDisposition: "provider-error-content", selectedCandidateCompletedAt: null, stageDeadlineAt: 4000, calls: [], registrations: [],
      events: ["intelligent:cancelled@4000", "fast:cancelled@4000"] } },
  { name: "deadline timer with a valid Fast cached and Intelligent silent",
    after: async (h) => { h.clock.advance(0); await flush(); await cacheFast(h, 500); h.clock.advance(4000); },
    expected: { reason: "candidate-deadline-expired", tier: "fast", parsedOk: true, parseDisposition: "valid-json",
      providerDisposition: "completed-with-content", selectedCandidateCompletedAt: 500, stageDeadlineAt: 4000, calls: BOTH_ABORTED, registrations: [4000],
      events: [...STARTED, "fast:completed@500", "fast:selected@4000", "intelligent:cancelled@4000", "intelligent:completed@4000"] } },
  { name: "deadline timer with nothing cached",
    after: async (h) => { h.clock.advance(0); await flush(); h.clock.advance(4000); },
    expected: { reason: "candidate-deadline-expired", tier: null, parsedOk: false, parseDisposition: "candidate-deadline-expired",
      providerDisposition: "provider-error-content", selectedCandidateCompletedAt: null, stageDeadlineAt: 4000, calls: BOTH_ABORTED, registrations: [4000],
      events: [...STARTED, "intelligent:cancelled@4000", "fast:cancelled@4000", "intelligent:completed@4000", "fast:completed@4000"] } },
  // The case the recorded parse reason hides: an invalid Intelligent is cached, Fast never answers, and the stage ends at its deadline.
  { name: "deadline timer with an invalid Intelligent cached and Fast silent until the deadline",
    after: async (h) => { h.clock.advance(0); await flush(); h.clock.advance(700); h.calls.get("intelligent")!.resolve(result("invalid")); await flush(); h.clock.advance(4000); },
    expected: { reason: "candidate-deadline-expired", tier: null, parsedOk: false, parseDisposition: "malformed-json",
      providerDisposition: "completed-with-content", selectedCandidateCompletedAt: null, stageDeadlineAt: 4000, calls: BOTH_ABORTED, registrations: [4000],
      events: [...STARTED, "intelligent:completed@700", "fast:cancelled@4000", "fast:completed@4000"] } },
  { name: "deadline timer with an invalid Fast cached and Intelligent silent",
    after: async (h) => { h.clock.advance(0); await flush(); await cacheFast(h, 500, "invalid"); h.clock.advance(4000); },
    expected: { reason: "candidate-deadline-expired", tier: null, parsedOk: false, parseDisposition: "malformed-json",
      providerDisposition: "completed-with-content", selectedCandidateCompletedAt: null, stageDeadlineAt: 4000, calls: BOTH_ABORTED, registrations: [4000],
      events: [...STARTED, "fast:completed@500", "intelligent:cancelled@4000", "intelligent:completed@4000"] } },
  { name: "admission granted at the deadline with a valid Fast cached",
    before: (h) => occupy(h, "intelligent"),
    after: async (h, releases) => {
      h.clock.advance(0); await flush(); await cacheFast(h, 500);
      // The slot is granted at the deadline, before the selector's own deadline timer is delivered.
      const deadlineTimer = [...h.clock.timers].find(([, timer]) => timer.at === 4000)![0];
      h.clock.time = 4000; releases[0]!(); await flush();
      for (const [id, timer] of [...h.clock.timers]) if (id !== deadlineTimer && timer.at <= 4000) { h.clock.timers.delete(id); timer.fn(); }
      await flush(); releases.slice(1).forEach(release => release());
    },
    expected: { reason: "candidate-deadline-expired", tier: "fast", parsedOk: true, parseDisposition: "valid-json",
      providerDisposition: "completed-with-content", selectedCandidateCompletedAt: 500, stageDeadlineAt: 4000, calls: [["fast", 4000, true]], registrations: [4000],
      events: ["intelligent:queued@0", "fast:queued@0", "fast:admitted@0", "fast:completed@500", "intelligent:admitted@4000", "fast:selected@4000", "intelligent:cancelled@4000", "intelligent:completed@4000"] } },
  { name: "admission granted at the deadline with nothing cached",
    before: (h) => occupy(h, "intelligent"),
    after: async (h, releases) => {
      h.clock.advance(0); await flush();
      const deadlineTimer = [...h.clock.timers].find(([, timer]) => timer.at === 4000)![0];
      h.clock.time = 4000; releases[0]!(); await flush();
      for (const [id, timer] of [...h.clock.timers]) if (id !== deadlineTimer && timer.at <= 4000) { h.clock.timers.delete(id); timer.fn(); }
      await flush(); releases.slice(1).forEach(release => release());
    },
    expected: { reason: "candidate-deadline-expired", tier: null, parsedOk: false, parseDisposition: "candidate-deadline-expired",
      providerDisposition: "provider-error-content", selectedCandidateCompletedAt: null, stageDeadlineAt: 4000, calls: [["fast", 4000, true]], registrations: [4000],
      events: ["intelligent:queued@0", "fast:queued@0", "fast:admitted@0", "intelligent:admitted@4000", "intelligent:cancelled@4000", "fast:cancelled@4000", "intelligent:completed@4000", "fast:completed@4000"] } },
  { name: "completion processed at the deadline with a valid Fast cached",
    after: async (h) => { h.clock.advance(0); await flush(); await cacheFast(h, 500);
      h.clock.advance(3999); await flush(); h.clock.time = 4000; h.calls.get("intelligent")!.resolve(result("related")); await flush(); },
    expected: { reason: "candidate-deadline-expired", tier: "fast", parsedOk: true, parseDisposition: "valid-json",
      providerDisposition: "completed-with-content", selectedCandidateCompletedAt: 500, stageDeadlineAt: 4000, calls: BOTH_ABORTED, registrations: [4000],
      events: [...STARTED, "fast:completed@500", "intelligent:completed@4000", "fast:selected@4000"] } },
  { name: "completion processed after the deadline with nothing cached",
    after: async (h) => { h.clock.advance(0); await flush(); h.clock.advance(3999); await flush(); h.clock.time = 4050;
      h.calls.get("fast")!.resolve(result("related")); await flush(); },
    expected: { reason: "candidate-deadline-expired", tier: null, parsedOk: false, parseDisposition: "candidate-deadline-expired",
      providerDisposition: "provider-error-content", selectedCandidateCompletedAt: null, stageDeadlineAt: 4000, calls: BOTH_ABORTED, registrations: [4000],
      events: [...STARTED, "fast:completed@4050", "intelligent:cancelled@4050", "intelligent:completed@4050"] } },
  { name: "Intelligent authentication failure after a valid Fast was cached",
    after: async (h) => { h.clock.advance(0); await flush(); await cacheFast(h, 500);
      h.clock.advance(700); h.calls.get("intelligent")!.resolve(failed("authentication")); await flush(); },
    expected: { reason: "client-error", tier: "intelligent", parsedOk: false, parseDisposition: "malformed-json",
      providerDisposition: "completed-with-content", selectedCandidateCompletedAt: 700, stageDeadlineAt: 4000, calls: BOTH_ABORTED, registrations: [4000],
      events: [...STARTED, "fast:completed@500", "intelligent:completed@700", "intelligent:selected@700"] } },
  // A selected Fast tier that is not a usable candidate: the tier alone would read as an expected switch.
  { name: "Fast configuration failure while Intelligent is pending",
    after: async (h) => { h.clock.advance(0); await flush(); h.clock.advance(300); h.calls.get("fast")!.resolve(failed("configuration")); await flush(); },
    expected: { reason: "client-error", tier: "fast", parsedOk: false, parseDisposition: "malformed-json",
      providerDisposition: "completed-with-content", selectedCandidateCompletedAt: 300, stageDeadlineAt: 4000, calls: BOTH_ABORTED, registrations: [4000],
      events: [...STARTED, "fast:completed@300", "fast:selected@300", "intelligent:cancelled@300", "intelligent:completed@300"] } },
  { name: "Intelligent answers with the provider's authentication error content",
    after: async (h) => { h.clock.advance(0); await flush(); h.clock.advance(300); h.calls.get("intelligent")!.resolve(failed(undefined, "provider-auth-error")); await flush(); },
    expected: { reason: "client-error", tier: "intelligent", parsedOk: false, parseDisposition: "malformed-json",
      providerDisposition: "provider-auth-error", selectedCandidateCompletedAt: 300, stageDeadlineAt: 4000, calls: BOTH_ABORTED, registrations: [4000],
      events: [...STARTED, "intelligent:completed@300", "intelligent:selected@300", "fast:cancelled@300", "fast:completed@300"] } },
  { name: "Intelligent valid while Fast is pending",
    after: async (h) => { h.clock.advance(0); await flush(); h.clock.advance(1200); h.calls.get("intelligent")!.resolve(result("related")); await flush(); },
    expected: { reason: "intelligent-valid", tier: "intelligent", parsedOk: true, parseDisposition: "valid-json",
      providerDisposition: "completed-with-content", selectedCandidateCompletedAt: 1200, stageDeadlineAt: 4000, calls: BOTH_ABORTED, registrations: [4000],
      events: [...STARTED, "intelligent:completed@1200", "intelligent:selected@1200", "fast:cancelled@1200", "fast:completed@1200"] } },
  // A parse-valid "unclear" is a model result, not a failure: it wins over a cached Fast like any valid Intelligent.
  { name: "Intelligent parse-valid unclear after a valid Fast was cached",
    after: async (h) => { h.clock.advance(0); await flush(); await cacheFast(h, 600);
      h.clock.advance(1200); h.calls.get("intelligent")!.resolve(result("unclear")); await flush(); },
    expected: { reason: "intelligent-valid", tier: "intelligent", parsedOk: true, parseDisposition: "valid-json",
      providerDisposition: "completed-with-content", selectedCandidateCompletedAt: 1200, stageDeadlineAt: 4000, calls: BOTH_ABORTED, registrations: [4000],
      events: [...STARTED, "fast:completed@600", "intelligent:completed@1200", "intelligent:selected@1200"] } },
  { name: "Intelligent invalid after a valid Fast was cached",
    after: async (h) => { h.clock.advance(0); await flush(); await cacheFast(h, 500);
      h.clock.advance(700); h.calls.get("intelligent")!.resolve(result("invalid")); await flush(); },
    expected: { reason: "intelligent-invalid-fast-valid", tier: "fast", parsedOk: true, parseDisposition: "valid-json",
      providerDisposition: "completed-with-content", selectedCandidateCompletedAt: 500, stageDeadlineAt: 4000, calls: BOTH_ABORTED, registrations: [4000],
      events: [...STARTED, "fast:completed@500", "intelligent:completed@700", "fast:selected@700"] } },
  { name: "Fast valid after an invalid Intelligent was cached",
    after: async (h) => { h.clock.advance(0); await flush(); h.clock.advance(300); h.calls.get("intelligent")!.resolve(result("invalid")); await flush();
      await cacheFast(h, 900); },
    expected: { reason: "intelligent-invalid-fast-valid", tier: "fast", parsedOk: true, parseDisposition: "valid-json",
      providerDisposition: "completed-with-content", selectedCandidateCompletedAt: 900, stageDeadlineAt: 4000, calls: BOTH_ABORTED, registrations: [4000],
      events: [...STARTED, "intelligent:completed@300", "fast:completed@900", "fast:selected@900"] } },
  { name: "both candidates ended with invalid output",
    after: async (h) => { h.clock.advance(0); await flush(); await cacheFast(h, 500, "invalid");
      h.clock.advance(700); h.calls.get("intelligent")!.resolve(result("invalid")); await flush(); },
    expected: { reason: "candidates-ended-unusable", tier: null, parsedOk: false, parseDisposition: "malformed-json",
      providerDisposition: "completed-with-content", selectedCandidateCompletedAt: null, stageDeadlineAt: 4000, calls: BOTH_ABORTED, registrations: [4000],
      events: [...STARTED, "fast:completed@500", "intelligent:completed@700"] } },
];

for (const row of LG3_ROWS) {
  test(`LG3 selection reason: ${row.name}`, async () => {
    const h = lg3Harness();
    const releases = (await row.before?.(h)) ?? [];
    const promise = h.start();
    await row.after(h, releases);
    const chosen = await promise;
    await flush();
    const actual: Lg3Facts = { reason: chosen.selectionReason ?? null, tier: chosen.selectedProviderTier ?? null, parsedOk: chosen.parsed.ok,
      parseDisposition: chosen.parseDisposition, providerDisposition: chosen.providerDisposition,
      selectedCandidateCompletedAt: chosen.selectedCandidateCompletedAt ?? null, stageDeadlineAt: chosen.stageDeadlineAt,
      calls: [...h.calls].map(([model, call]) => [model, call.input.timeoutMs, call.input.signal.aborted]),
      registrations: h.registrations, events: h.events.map(e => `${e.providerTier}:${e.event}@${e.at}`) };
    assert.deepEqual(actual, row.expected);
  });
}

// The controls: a cancelled stage and an internal failure reject. There is no
// selection, so nothing can carry a reason for them.
test("LG3 control: a cancelled stage and an internal failure reject without a selection, with or without a cached valid Fast", async () => {
  for (const cachedFast of [false, true]) {
    for (const end of ["source cancellation", "internal failure"] as const) {
      const h = lg3Harness();
      const outcome: { resolved?: unknown; rejected?: Error } = {};
      const promise = h.start().then(chosen => { outcome.resolved = chosen; }, (error: Error) => { outcome.rejected = error; });
      h.clock.advance(0); await flush();
      if (cachedFast) await cacheFast(h, 500);
      if (end === "source cancellation") h.controller.abort();
      else h.calls.get("intelligent")!.resolve(failed("unexpected"));
      await flush(); await promise;
      const label = `${end}, cached Fast=${cachedFast}`;
      assert.equal(outcome.resolved, undefined, label);
      assert.equal(outcome.rejected?.name, end === "source cancellation" ? "AbortError" : "Error", label);
      assert.equal("selectionReason" in (outcome.rejected ?? {}), false, label);
      assert.equal(h.events.some(e => e.event === "selected"), false, label);
      assert.deepEqual([...h.calls].map(([model, call]) => [model, call.input.timeoutMs, call.input.signal.aborted]), BOTH_ABORTED, label);
      assert.deepEqual(h.registrations, [4000], label);
    }
  }
});
