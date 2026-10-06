import assert from "node:assert/strict";
import test from "node:test";
import { waitForRuntimeRegressionCompletion, type RuntimeRegressionCompletionRoot } from "../src/lib/meeting/runtime-regression-completion.js";
import type { RuntimeCriticalEventInput } from "../src/lib/meeting/runtime-critical-event.js";
import { createRuntimeCriticalEventHarness } from "./helpers/runtime-critical-events.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function harness(root: RuntimeRegressionCompletionRoot = { traceId: "trace" }, waitForDisplay = true, timeoutMs = 5000) {
  const h = createRuntimeCriticalEventHarness({ sessionId: "run", observe: false });
  const wait = waitForRuntimeRegressionCompletion({ subscribe: listener => h.stream.subscribe(listener), runtimeSessionId: "run", runtimeEpoch: 1, root, waitForDisplay, timeoutMs });
  let settled = false;
  void wait.promise.then(() => { settled = true; }, () => { settled = true; });
  const emit = (value: Partial<RuntimeCriticalEventInput> & Pick<RuntimeCriticalEventInput, "fact">) => {
    h.stream.emit({ stage: "test-owner", purpose: "formal", runtimeSessionId: "run", runtimeEpoch: 1, ...value });
    h.flush();
  };
  const generate = (traceId = "trace") => emit({ fact: "generation-admitted", refs: { traceId, generationLeaseId: "lease" } });
  const commit = (traceId = "trace") => {
    emit({ fact: "terminal", refs: { traceId, generationLeaseId: "lease" }, terminal: { object: "generation", disposition: "committed" } });
    emit({ fact: "stable-answer-committed", refs: { traceId, suggestionId: "answer", stableRevision: 2 } });
  };
  const apply = () => emit({ fact: "stable-answer-applied", refs: { traceId: "trace", suggestionId: "answer", stableRevision: 2 }, runtimeEpoch: undefined });
  return { ...h, wait, emit, generate, commit, apply, settled: () => settled };
}

test("SR187 waits for generation, commit and exact stable application, not first content", async () => {
  const h = harness();
  h.wait.dispatched();
  h.generate();
  h.emit({ fact: "provider-request-started", refs: { traceId: "trace", requestId: "r".repeat(200) } });
  h.emit({ fact: "terminal", refs: { traceId: "trace", requestId: "r".repeat(200) }, terminal: { object: "provider-request", disposition: "success" } });
  h.emit({ fact: "first-visible-content", refs: { generationId: "answer", traceId: "trace" } });
  h.commit();
  await tick();
  assert.equal(h.settled(), false);
  h.emit({ fact: "stable-answer-applied", refs: { suggestionId: "other", stableRevision: 2 } });
  await tick();
  assert.equal(h.settled(), false);
  h.apply();
  assert.equal((await h.wait.promise).disposition, "visible");
});

test("SR187 pinned background completes without display, unlock requires the selected version ACK", async () => {
  const h = harness({ traceId: "trace" }, false);
  h.wait.dispatched(); h.generate(); h.commit();
  assert.equal((await h.wait.promise).disposition, "committed-hidden");
  const u = harness({ manualAction: "toggle-advise-pin" });
  u.wait.dispatched({ suggestionId: "answer", stableRevision: 2 });
  u.emit({ fact: "terminal", refs: { manualActionId: "unlock", manualAction: "toggle-advise-pin" }, terminal: { object: "manual-action", disposition: "completed" } });
  await tick(); assert.equal(u.settled(), false);
  u.apply();
  assert.equal((await u.wait.promise).disposition, "completed");
});

test("SR187 no-generation completion needs an input terminal even after dispatch returns", async () => {
  const h = harness();
  h.emit({ fact: "input-accepted", refs: { traceId: "trace" } });
  h.wait.dispatched();
  await tick(); assert.equal(h.settled(), false);
  h.emit({ fact: "terminal", refs: { traceId: "trace" }, terminal: { object: "turn-input", disposition: "completed" } });
  assert.equal((await h.wait.promise).disposition, "suppressed");
});

test("SR187 cached artifact or pending-answer publication still waits for display without a new generation", async () => {
  const h = harness({ manualAction: "force-advise" });
  h.wait.dispatched();
  h.emit({ fact: "input-accepted", refs: { manualActionId: "force", manualAction: "force-advise", traceId: "trace" } });
  h.emit({ fact: "stable-answer-committed", refs: { traceId: "trace", suggestionId: "answer", stableRevision: 2 } });
  h.emit({ fact: "terminal", refs: { manualActionId: "force", manualAction: "force-advise", traceId: "trace" }, terminal: { object: "manual-action", disposition: "completed" } });
  await tick(); assert.equal(h.settled(), false);
  h.apply();
  assert.equal((await h.wait.promise).disposition, "visible");
});

test("SR187 manual completion joins its own generation trace, not the previous displayed trace", async () => {
  const h = harness({ manualAction: "regenerate" });
  h.emit({ fact: "input-accepted", refs: { manualAction: "regenerate", manualActionId: "action", traceId: "previous" } });
  h.wait.dispatched(); h.generate(); h.commit(); h.apply();
  await tick(); assert.equal(h.settled(), false);
  h.emit({ fact: "terminal", refs: { manualAction: "regenerate", manualActionId: "action", traceId: "trace" }, terminal: { object: "manual-action", disposition: "completed" } });
  assert.equal((await h.wait.promise).disposition, "visible");
});

test("SR187 Screen completion requires its own operation terminal as well as generation", async () => {
  const h = harness({ screen: true });
  h.emit({ fact: "input-accepted", refs: { operationId: "screen", traceId: "trace", sourceKind: "screen" } });
  h.wait.dispatched(); h.generate(); h.commit(); h.apply();
  await tick(); assert.equal(h.settled(), false);
  h.emit({ fact: "terminal", refs: { operationId: "screen", traceId: "trace" }, terminal: { object: "screen-operation", disposition: "released" } });
  assert.equal((await h.wait.promise).disposition, "visible");
});

for (const disposition of ["failed", "cancelled", "stale-rejected"]) test(`SR187 keeps actual ${disposition} and unsubscribes`, async () => {
  const h = harness(); h.wait.dispatched(); h.generate();
  h.emit({ fact: "terminal", refs: { traceId: "trace", generationLeaseId: "lease" }, terminal: { object: "generation", disposition } });
  assert.equal((await h.wait.promise).disposition, disposition === "failed" ? "error" : disposition === "stale-rejected" ? "stale" : "cancelled");
  assert.equal(h.stream.getStats().subscribers, 0);
});

test("SR187 old epoch and observation cannot satisfy a barrier; closing rejects it", async () => {
  const h = harness(); h.wait.dispatched();
  h.emit({ fact: "terminal", runtimeEpoch: 0, refs: { traceId: "trace" }, terminal: { object: "turn-input", disposition: "completed" } });
  h.emit({ fact: "terminal", purpose: "observation", refs: { traceId: "trace" }, terminal: { object: "turn-input", disposition: "completed" } });
  await tick(); assert.equal(h.settled(), false);
  h.stream.closeSubscriptions("reset"); h.flush();
  await assert.rejects(h.wait.promise, /closed/);
});

test("SR187 missing evidence and explicit Stop cannot wait forever", async () => {
  const h = harness({ traceId: "trace" }, true, 5); h.wait.dispatched();
  await assert.rejects(h.wait.promise, /timed out/);
  const stopped = harness(); stopped.wait.cancel();
  await assert.rejects(stopped.wait.promise, /stopped/);
});

test("SR187 subscription refusal is available before any input dispatch", async () => {
  const wait = waitForRuntimeRegressionCompletion({ subscribe: () => ({ accepted: false, reason: "subscriber-limit", unsubscribe() {} }),
    runtimeSessionId: "run", runtimeEpoch: 1, root: { traceId: "trace" }, waitForDisplay: true });
  assert.equal(wait.accepted, false);
  await assert.rejects(wait.promise, /subscriber-limit/);
});
