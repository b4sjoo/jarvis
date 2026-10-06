// Task 178A (AE5, parts of AE2/AE3/AE4/AE6): the event layer itself.
//
// These tests exercise the leaf module only. They do not stand in for the
// producer proofs: every AE1/AE2/AE6/AE7 producer claim is made in the existing
// harnesses that execute real Hook callbacks.
import assert from "node:assert/strict";
import test from "node:test";
import {
  RUNTIME_CRITICAL_EVENT_JOURNAL_PATH,
  RUNTIME_CRITICAL_EVENT_LIMITS,
  RUNTIME_CRITICAL_EVENT_SCHEMA_VERSION,
  RUNTIME_CRITICAL_FACT_KINDS,
  RUNTIME_CRITICAL_TERMINAL_OBJECTS,
  RuntimeCriticalEventStream,
  parseRuntimeCriticalEventJournal,
  runtimeCriticalEventIdentifierReference,
  runtimeCriticalEventQueueDepthBound,
  type RuntimeCriticalEventDelivery,
  type RuntimeCriticalEventInput,
  type RuntimeCriticalEventLimits,
} from "../src/lib/meeting/runtime-critical-event.js";
import {
  ManualRuntimeCriticalEventClock,
  createRuntimeCriticalEventHarness,
  describeRuntimeCriticalEventShape,
} from "./helpers/runtime-critical-events.js";

const SESSION = "meeting_session_a";

function input(
  overrides: Partial<RuntimeCriticalEventInput> = {}
): RuntimeCriticalEventInput {
  return {
    fact: "generation-admitted",
    stage: "ledger-entry-created",
    purpose: "formal",
    runtimeSessionId: SESSION,
    runtimeEpoch: 3,
    occurredAt: 1_000,
    refs: { generationLeaseId: "lease-1", traceId: "trace-1" },
    ...overrides,
  };
}

test("AE5 frozen limits: every limit is asserted with its exact reviewed value, the hard queue bound is 262, and none can be mutated", () => {
  const limits = RUNTIME_CRITICAL_EVENT_LIMITS;
  // The originally frozen list.
  assert.equal(limits.queueCapacity, 256, "events queued for delivery");
  assert.equal(limits.deliveryBatchSize, 32, "items delivered per macrotask");
  assert.equal(limits.maxEventJsonChars, 2048, "one event as JSON");
  assert.equal(limits.maxReferenceChars, 128, "one reference");
  assert.equal(limits.maxSourceReferences, 8, "source references per event");
  assert.equal(limits.maxSubscribers, 2, "subscribers");
  assert.equal(limits.maxFailureDetails, 8, "failure details kept");
  assert.equal(limits.maxFailureDetailChars, 120, "one failure detail");
  // Added beyond that list.
  assert.equal(limits.maxFirstKeys, 512, "first-key window, per first-key family");
  assert.equal(limits.maxIdentifierSourceChars, 512, "the longest owner identifier still carried, as a digest");
  // Nothing else is a limit.
  assert.deepEqual(Object.keys(limits).sort(), ["deliveryBatchSize", "maxEventJsonChars", "maxFailureDetailChars",
    "maxFailureDetails", "maxFirstKeys", "maxIdentifierSourceChars", "maxReferenceChars", "maxSourceReferences",
    "maxSubscribers", "queueCapacity"]);
  // The hard bound of the delivery queue is 262 items. Events are queued only
  // below the capacity of 256. A subscription cohort adds at most three
  // markers: one gap marker for each of the two drop reasons (queue-overflow,
  // payload-limit) and one closed marker. At most two cohorts can be waiting
  // for delivery, one per subscriber: 256 + (2 + 1) * 2 = 262.
  assert.equal(runtimeCriticalEventQueueDepthBound(), 262);
  assert.equal(limits.queueCapacity + (2 + 1) * limits.maxSubscribers, 262);
  // The digest form of an identifier longer than one reference: the first 111
  // characters, "~" and 16 hexadecimal digits, 128 characters in all. One that
  // fits is carried as it is; one longer than 512 characters is not carried.
  const fits = "i".repeat(128);
  assert.equal(runtimeCriticalEventIdentifierReference(fits), fits);
  const digested = runtimeCriticalEventIdentifierReference("i".repeat(129));
  assert.match(digested ?? "", /^i{111}~[0-9a-f]{16}$/);
  assert.equal(digested?.length, 128);
  assert.equal(runtimeCriticalEventIdentifierReference("i".repeat(512))?.length, 128);
  assert.equal(runtimeCriticalEventIdentifierReference("i".repeat(513)), undefined);
  assert.equal(Object.isFrozen(RUNTIME_CRITICAL_EVENT_LIMITS), true);
  assert.throws(() => {
    (RUNTIME_CRITICAL_EVENT_LIMITS as { queueCapacity: number }).queueCapacity = 1;
  }, TypeError);
  assert.equal(RUNTIME_CRITICAL_EVENT_SCHEMA_VERSION, 1);
  assert.equal(RUNTIME_CRITICAL_EVENT_JOURNAL_PATH, "runtime-events/critical-events.v1.jsonl");
  assert.deepEqual([...RUNTIME_CRITICAL_FACT_KINDS], [
    "input-accepted", "lqu-committed", "type-settled", "relation-settled",
    "lifecycle-committed", "generation-admitted", "provider-request-started",
    "stable-answer-committed", "artifact-committed", "first-visible-content", "stable-answer-applied", "terminal",
  ]);
  assert.deepEqual([...RUNTIME_CRITICAL_TERMINAL_OBJECTS], [
    "provider-request", "generation", "screen-operation", "manual-action", "lifecycle-transition", "turn-input",
  ]);
});

test("AE5 an event is a versioned, sequenced, deep-frozen value of plain references", () => {
  const h = createRuntimeCriticalEventHarness({ sessionId: SESSION });
  const first = h.stream.emit(input());
  const second = h.stream.emit(input({ refs: { generationLeaseId: "lease-2" }, runtimeEpoch: undefined, occurredAt: undefined }));
  assert.ok(first && second);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(first.eventId, `rce:${SESSION}:1`);
  assert.equal(first.runtimeSessionId, SESSION);
  assert.equal(first.runtimeEpoch, 3);
  assert.equal(first.occurredAt, 1_000);
  assert.equal(first.purpose, "formal");
  // A missing identity stays missing; it is never filled from a neighbour.
  assert.equal("runtimeEpoch" in second, false);
  assert.equal(typeof second.occurredAt, "number");
  assert.deepEqual(describeRuntimeCriticalEventShape(first), []);
  assert.throws(() => { (first as { sequence: number }).sequence = 9; }, TypeError);
  assert.throws(() => { (first.refs as { traceId?: string }).traceId = "x"; }, TypeError);
  assert.deepEqual(h.events().map((event) => event.sequence), [1, 2]);
});

test("SR187 stable application is distinct from first content and permits a later reapplication", () => {
  const h = createRuntimeCriticalEventHarness({ sessionId: SESSION });
  const refs = { traceId: "trace", suggestionId: "answer", generationId: "answer", stableRevision: 2 };
  assert.ok(h.stream.emit(input({ fact: "first-visible-content", stage: "streaming", refs })));
  assert.ok(h.stream.emit(input({ fact: "stable-answer-applied", stage: "stable-display-ack", refs })));
  assert.ok(h.stream.emit(input({ fact: "stable-answer-applied", stage: "stable-display-ack", refs })));
  assert.equal(h.stream.emit(input({ fact: "stable-answer-applied", refs: { traceId: "trace" } })), undefined);
  const terminal = input({ fact: "terminal", refs: { traceId: "trace" }, terminal: { object: "turn-input", disposition: "completed" } });
  assert.ok(h.stream.emit(terminal));
  assert.equal(h.stream.emit(terminal), undefined);
});

test("AE5 only whitelisted bounded references are copied; a business object, a long text, free text or a secret is refused and named", () => {
  const h = createRuntimeCriticalEventHarness({ sessionId: SESSION });
  const manager = { commitTaskRuntimeTransition() {}, secret: "sk-live-abc" };
  const longText = "p".repeat(RUNTIME_CRITICAL_EVENT_LIMITS.maxIdentifierSourceChars + 1);
  const event = h.stream.emit(input({
    refs: {
      traceId: "trace-1",
      // Not in the contract at all: never copied.
      ...( { prompt: "You are an interviewer...", answer: "The answer is 42", manager, apiKey: "sk-live-abc" } as object ),
      // In the contract but not a bounded primitive: refused and named.
      operationId: manager as unknown as string,
      requestId: longText,
      // A code reference that is free text, not a code.
      operationKind: "Provider error: Incorrect API key provided: sk-proj-abc123",
      transport: "",
      logicalQuestionRevision: Number.NaN,
      sourceTurnIds: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"],
      sourceObservationIds: ["o1"],
    },
  }));
  assert.ok(event);
  assert.deepEqual(Object.keys(event.refs).sort(), ["sourceTurnIds", "traceId"]);
  assert.deepEqual(event.refs.sourceTurnIds, ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"]);
  assert.deepEqual([...(event.omittedRefs ?? [])].sort(),
    ["logicalQuestionRevision", "operationId", "operationKind", "requestId", "sourceObservationIds", "sourceTurnIds", "transport"]);
  assert.equal(event.digestedRefs, undefined);
  const serialized = JSON.stringify(event);
  for (const forbidden of ["sk-live-abc", "sk-proj-abc123", "You are an interviewer", "The answer is 42", longText]) {
    assert.equal(serialized.includes(forbidden), false, forbidden.slice(0, 24));
  }
  assert.deepEqual(describeRuntimeCriticalEventShape(event), []);
  assert.equal(h.stream.getStats().referencesOmitted, 7);
});

test("AE5 stage, disposition and reason are owner codes: free text such as an error message never enters an event", () => {
  const h = createRuntimeCriticalEventHarness({ sessionId: SESSION });
  const secret = "Provider error: Incorrect API key provided: sk-proj-abc123";
  const terminal = h.stream.emit(input({ fact: "terminal", stage: "manual-action-terminal",
    terminal: { object: "manual-action", disposition: "failed", reason: secret }, refs: { manualActionId: "a1" } }));
  assert.ok(terminal);
  assert.deepEqual(terminal.terminal, { object: "manual-action", disposition: "failed" });
  assert.deepEqual(terminal.omittedRefs, ["terminal.reason"], "the refused reason is named, not copied");
  assert.equal(JSON.stringify(terminal).includes("sk-proj"), false);
  // The owner's own codes pass unchanged.
  for (const reason of ["revision-mismatch", "stable-answer-publication-install-exception", "pre-mutation:session-mismatch",
    "cancelled-by-new-job", "meeting-assistant-stopped"]) {
    const coded = h.stream.emit(input({ fact: "terminal", stage: "task-writer-rejected",
      terminal: { object: "lifecycle-transition", disposition: "rejected", reason } }));
    assert.equal(coded?.terminal?.reason, reason);
    assert.equal(coded?.omittedRefs, undefined);
  }
  // A stage or a disposition that is not a code is a construction failure.
  assert.equal(h.stream.emit(input({ stage: "the request has started" })), undefined);
  assert.equal(h.stream.emit(input({ fact: "terminal", stage: "generation-result",
    terminal: { object: "generation", disposition: "it went wrong" }, refs: { generationLeaseId: "l9" } })), undefined);
  assert.equal(h.stream.getStats().constructionFailures, 2);
});

test("AE5 no subscriber: nothing is retained and no timer is scheduled", () => {
  const clock = new ManualRuntimeCriticalEventClock();
  const stream = new RuntimeCriticalEventStream({ clock });
  stream.bind(SESSION);
  for (let index = 0; index < 1_000; index += 1) {
    assert.ok(stream.emit(input({ refs: { generationLeaseId: `lease-${index}` } })));
  }
  const stats = stream.getStats();
  assert.equal(stats.produced, 1_000);
  assert.equal(stats.queueDepth, 0);
  assert.equal(stats.queuePeak, 0);
  assert.equal(stats.drainsScheduled, 0);
  assert.equal(clock.scheduled, 0);
  assert.equal(clock.pendingCount(), 0);
});

test("AE4/AE5 delivery is asynchronous, one bounded batch per macrotask, and never runs in the producer's stack", () => {
  const clock = new ManualRuntimeCriticalEventClock();
  const stream = new RuntimeCriticalEventStream({ clock });
  stream.bind(SESSION);
  const seen: number[] = [];
  let producerDepth = 0;
  let deliveredInsideProducer = 0;
  const subscription = stream.subscribe((delivery) => {
    if (producerDepth > 0) deliveredInsideProducer += 1;
    if (delivery.kind === "event") seen.push(delivery.event.sequence);
  });
  assert.equal(subscription.accepted, true);
  for (let index = 0; index < 70; index += 1) {
    producerDepth += 1;
    stream.emit(input({ refs: { generationLeaseId: `lease-${index}` } }));
    producerDepth -= 1;
  }
  assert.deepEqual(seen, [], "nothing is delivered synchronously");
  assert.equal(clock.pendingCount(), 1, "one drain is scheduled for the whole burst");
  assert.equal(clock.runNext(), true);
  assert.equal(seen.length, 32);
  assert.equal(clock.runNext(), true);
  assert.equal(seen.length, 64);
  assert.equal(clock.runNext(), true);
  assert.equal(seen.length, 70);
  assert.equal(clock.runNext(), false, "an empty queue schedules nothing more");
  assert.deepEqual(seen, Array.from({ length: 70 }, (_, index) => index + 1));
  assert.equal(deliveredInsideProducer, 0);
  assert.equal(stream.getStats().queuePeak, 70);
});

test("AE5 queue overflow drops the new event, keeps its sequence, and coalesces one in-band gap marker; retention stays bounded", () => {
  const clock = new ManualRuntimeCriticalEventClock();
  const stream = new RuntimeCriticalEventStream({ clock });
  stream.bind(SESSION);
  const deliveries: RuntimeCriticalEventDelivery[] = [];
  stream.subscribe((delivery) => { deliveries.push(delivery); });
  const produced = [];
  for (let index = 0; index < 400; index += 1) {
    produced.push(stream.emit(input({ refs: { generationLeaseId: `lease-${index}` } })));
  }
  // The value still reaches the Recording owner; only delivery lost it.
  assert.equal(produced.every(Boolean), true);
  const beforeDrain = stream.getStats();
  assert.equal(beforeDrain.queueDepth, RUNTIME_CRITICAL_EVENT_LIMITS.queueCapacity + 1);
  assert.equal(beforeDrain.queuePeak, RUNTIME_CRITICAL_EVENT_LIMITS.queueCapacity + 1);
  assert.equal(beforeDrain.overflowDropped, 144);
  assert.equal(beforeDrain.gapMarkers, 1);
  clock.runAll();
  const gaps = deliveries.filter((delivery) => delivery.kind === "gap");
  assert.deepEqual(gaps, [{
    kind: "gap", schemaVersion: 1, runtimeSessionId: SESSION, reason: "queue-overflow",
    firstSequence: 257, lastSequence: 400, count: 144,
  }]);
  assert.equal(Object.isFrozen(gaps[0]), true);
  const sequences = deliveries.flatMap((delivery) => delivery.kind === "event" ? [delivery.event.sequence] : []);
  assert.deepEqual(sequences, Array.from({ length: 256 }, (_, index) => index + 1));
  // After the gap, later events continue with their own sequence.
  const later = stream.emit(input({ refs: { generationLeaseId: "lease-later" } }));
  assert.equal(later?.sequence, 401);
  clock.runAll();
  assert.equal(stream.getStats().queueDepth, 0);
  const last = deliveries.at(-1);
  assert.ok(last?.kind === "event");
  assert.equal(last.event.sequence, 401);
});

test("AE5 a payload over the limit is dropped with its sequence and an explicit payload gap, for delivery and for Recording", () => {
  const clock = new ManualRuntimeCriticalEventClock();
  const stream = new RuntimeCriticalEventStream({ clock, limits: { maxEventJsonChars: 320 } });
  stream.bind(SESSION);
  const deliveries: RuntimeCriticalEventDelivery[] = [];
  stream.subscribe((delivery) => { deliveries.push(delivery); });
  const fitting = stream.emit(input());
  const oversized = stream.emit(input({
    refs: {
      traceId: "t".repeat(100), operationId: "o".repeat(100), requestId: "r".repeat(100),
      generationLeaseId: "g".repeat(100),
    },
  }));
  const after = stream.emit(input({ refs: { generationLeaseId: "lease-3" } }));
  assert.ok(fitting && after);
  assert.equal(oversized, undefined, "nothing is handed to the Recording owner either");
  assert.equal(after.sequence, 3, "the dropped event kept sequence 2");
  clock.runAll();
  assert.deepEqual(deliveries.map((delivery) => delivery.kind), ["event", "gap", "event"]);
  assert.deepEqual(deliveries[1], {
    kind: "gap", schemaVersion: 1, runtimeSessionId: SESSION, reason: "payload-limit",
    firstSequence: 2, lastSequence: 2, count: 1,
  });
  assert.equal(stream.getStats().payloadDropped, 1);
  for (const delivery of deliveries) {
    if (delivery.kind === "event") assert.ok(JSON.stringify(delivery.event).length <= 320);
  }

  // A first-only fact that was dropped for its size was never announced. The
  // guard does not remember it, so the owner's later emission is still a first.
  const guarded = new RuntimeCriticalEventStream({ limits: { maxEventJsonChars: 480 } });
  guarded.bind(SESSION);
  const bulk = { traceId: "t".repeat(100), operationId: "o".repeat(100), requestId: "r".repeat(100), executionPlanId: "e".repeat(100) };
  const firstOnly: Array<[string, RuntimeCriticalEventInput]> = [
    ["LQU", input({ fact: "lqu-committed", stage: "canonical-publish",
      refs: { logicalQuestionUnitId: "q1", logicalQuestionRevision: 1 } })],
    ["first visible", input({ fact: "first-visible-content", stage: "stable", runtimeEpoch: undefined,
      refs: { generationId: "g1", suggestionId: "g1", stableRevision: 1 } })],
    ["terminal", input({ fact: "terminal", stage: "generation-result",
      terminal: { object: "generation", disposition: "committed" }, refs: { generationLeaseId: "lease-1" } })],
    ["Type settled", input({ fact: "type-settled", stage: "settlement-adopted",
      refs: { settlementId: "s1", questionType: "coding" } })],
    ["Relation settled", input({ fact: "relation-settled", stage: "settlement-adopted",
      refs: { settlementId: "s1", relation: "new-parent" } })],
  ];
  for (const [name, fact] of firstOnly) {
    assert.equal(guarded.emit({ ...fact, refs: { ...fact.refs, ...bulk } }), undefined, `${name}: dropped for its size`);
    const announced = guarded.emit(fact);
    assert.ok(announced, `${name}: the later emission is announced`);
    assert.ok(JSON.stringify(announced).length <= 480);
    assert.equal(guarded.emit(fact), undefined, `${name}: and only then is a repeat suppressed`);
    assert.equal(guarded.emit({ ...fact, refs: { ...fact.refs, ...bulk } }), undefined, `${name}: also a repeat that would not fit`);
  }
  // The settlement memory follows the same rule: an adoption of s2 that was
  // dropped for its size does not make s2 the last adopted settlement.
  const s2 = input({ fact: "type-settled", stage: "settlement-adopted", refs: { settlementId: "s2", questionType: "coding" } });
  assert.equal(guarded.emit({ ...s2, refs: { ...s2.refs, ...bulk } }), undefined);
  assert.equal(guarded.emit(firstOnly[3]![1]), undefined, "s1 is still the last adopted settlement: nothing to say");
  assert.equal(guarded.emit(s2)?.refs.settlementId, "s2");
  const guardedStats = guarded.getStats();
  assert.deepEqual([guardedStats.payloadDropped, guardedStats.produced, guardedStats.duplicateSuppressed], [6, 6, 11]);
  // A dropped event still took its sequence: 6 produced among 12 sequences.
  assert.equal(guardedStats.lastSequence, 12);
});

test("AE5 the delivery queue is hard-bounded: markers count, mixed drop reasons and repeated Stop never add an item per lost event", () => {
  const bound = runtimeCriticalEventQueueDepthBound();
  const oversized = { traceId: "t".repeat(100), operationId: "o".repeat(100), requestId: "r".repeat(100),
    generationLeaseId: "g".repeat(100), executionPlanId: "e".repeat(100) };

  // Alternating overflow and payload drops at capacity: one marker per reason.
  const clock = new ManualRuntimeCriticalEventClock();
  const stream = new RuntimeCriticalEventStream({ clock, limits: { maxEventJsonChars: 420 } });
  stream.bind(SESSION);
  const deliveries: RuntimeCriticalEventDelivery[] = [];
  stream.subscribe((delivery) => { deliveries.push(delivery); });
  for (let index = 0; index < 256; index += 1) {
    assert.ok(stream.emit(input({ refs: { generationLeaseId: `lease-${index}` } })));
  }
  for (let index = 0; index < 5_000; index += 1) {
    assert.ok(stream.emit(input({ refs: { generationLeaseId: `over-${index}` } })), "overflow still returns the value");
    assert.equal(stream.emit(input({ refs: oversized })), undefined);
  }
  const full = stream.getStats();
  assert.equal(full.queueDepth, 256 + 2, "256 events and one marker per reason");
  assert.equal(full.gapMarkers, 2);
  assert.deepEqual([full.overflowDropped, full.payloadDropped], [5_000, 5_000]);
  clock.runAll();
  const gaps = deliveries.filter((delivery) => delivery.kind === "gap");
  assert.deepEqual(gaps, [
    { kind: "gap", schemaVersion: 1, runtimeSessionId: SESSION, reason: "queue-overflow",
      firstSequence: 257, lastSequence: 10_255, count: 5_000 },
    { kind: "gap", schemaVersion: 1, runtimeSessionId: SESSION, reason: "payload-limit",
      firstSequence: 258, lastSequence: 10_256, count: 5_000 },
  ]);
  assert.equal(deliveries.filter((delivery) => delivery.kind === "event").length, 256);

  // Repeated Stop on one session, with a fresh subscriber each time and no
  // drain in between: subscribers are bounded, so closed markers are too.
  const stopClock = new ManualRuntimeCriticalEventClock();
  const stopped = new RuntimeCriticalEventStream({ clock: stopClock, limits: { maxEventJsonChars: 420 } });
  stopped.bind(SESSION);
  let accepted = 0;
  for (let cycle = 0; cycle < 2_000; cycle += 1) {
    if (stopped.subscribe(() => undefined).accepted) accepted += 1;
    for (let index = 0; index < 300; index += 1) {
      stopped.emit(input({ refs: { generationLeaseId: `c${cycle}-${index}` } }));
    }
    stopped.emit(input({ refs: oversized }));
    assert.equal(cycle % 2 === 0 ? stopped.closeSubscriptions("stopped") : stopped.close("stopped"), true);
    assert.equal(stopped.bind(SESSION), true);
    assert.ok(stopped.getStats().queueDepth <= bound, `cycle ${cycle}: ${stopped.getStats().queueDepth}`);
  }
  const worst = stopped.getStats();
  assert.equal(accepted, 2, "a third subscriber is refused until an ended one is delivered its closed marker");
  assert.ok(worst.queuePeak <= bound, `queue peak ${worst.queuePeak} within ${bound}`);
  assert.equal(worst.queuePeak, bound, "the bound is reached, and it is the hard bound");
  assert.equal(worst.subscribers, 2);
  stopClock.runAll();
  assert.deepEqual([stopped.getStats().queueDepth, stopped.getStats().subscribers], [0, 0]);
});

test("AE5 the queue bound holds under any interleaving of emits, drops, subscriptions, Stop, close, rebind and partial delivery", () => {
  const limits = { queueCapacity: 8, deliveryBatchSize: 3, maxEventJsonChars: 420 };
  const bound = runtimeCriticalEventQueueDepthBound({ queueCapacity: 8, maxSubscribers: 2 });
  assert.equal(bound, 8 + 3 * 2);
  const oversized = { traceId: "t".repeat(100), operationId: "o".repeat(100), requestId: "r".repeat(100),
    generationLeaseId: "g".repeat(100), executionPlanId: "e".repeat(100) };
  // A fixed pseudo-random walk: the same operations on every run.
  let seed = 0x2f6e2b1;
  const next = (range: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed % range;
  };
  const clock = new ManualRuntimeCriticalEventClock();
  const stream = new RuntimeCriticalEventStream({ clock, limits });
  const sessions = ["session-a", "session-b"];
  let session = sessions[0]!;
  stream.bind(session);
  const subscriptions: Array<{ unsubscribe(): void }> = [];
  let delivered = 0;
  let closedMarkers = 0;
  let peak = 0;
  for (let step = 0; step < 20_000; step += 1) {
    const action = next(100);
    if (action < 55) stream.emit(input({ runtimeSessionId: session, refs: { generationLeaseId: `lease-${step}` } }));
    else if (action < 65) stream.emit(input({ runtimeSessionId: session, refs: oversized }));
    else if (action < 75) {
      const subscription = stream.subscribe((delivery) => {
        delivered += 1;
        if (delivery.kind === "closed") closedMarkers += 1;
        if (next(40) === 0) throw new Error("observer failure");
      });
      if (subscription.accepted) subscriptions.push(subscription);
    } else if (action < 79) subscriptions.splice(next(subscriptions.length || 1), 1)[0]?.unsubscribe();
    else if (action < 84) stream.closeSubscriptions("stopped");
    else if (action < 87) { stream.close("closed"); stream.bind(session); }
    else if (action < 90) { session = sessions[next(2)]!; stream.bind(session); }
    else if (action < 91) { stream.release("released"); stream.bind(session); }
    else clock.runNext();
    const stats = stream.getStats();
    peak = Math.max(peak, stats.queueDepth);
    assert.ok(stats.queueDepth <= bound, `step ${step}: queue depth ${stats.queueDepth} exceeds ${bound}`);
    assert.ok(stats.subscribers <= 2, `step ${step}: ${stats.subscribers} subscribers`);
  }
  const stats = stream.getStats();
  assert.ok(stats.queuePeak <= bound);
  assert.ok(peak > 8, `the walk reached past the event capacity (${peak})`);
  assert.ok(delivered > 1_000 && closedMarkers > 10 && stats.overflowDropped > 0 && stats.payloadDropped > 0 &&
    stats.subscriberFailures > 0 && stats.discardedUndelivered > 0, JSON.stringify({ deliveredToObservers: delivered, closedMarkers, ...stats }));
  clock.runAll();
  stream.release("done");
  assert.deepEqual([stream.getStats().queueDepth, stream.getStats().subscribers, clock.pendingCount()], [0, 0, 0]);
});

test("AE4/AE5 a throwing subscriber is cut off, the other subscriber and the producer are unaffected, and failures are bounded without an error storm", () => {
  const clock = new ManualRuntimeCriticalEventClock();
  const stream = new RuntimeCriticalEventStream({ clock });
  stream.bind(SESSION);
  let throwing = 0;
  const healthy: number[] = [];
  stream.subscribe(() => {
    throwing += 1;
    throw new Error("subscriber failure ".repeat(40));
  });
  stream.subscribe((delivery) => {
    if (delivery.kind === "event") healthy.push(delivery.event.sequence);
  });
  assert.equal(stream.subscribe(() => undefined).reason, "subscriber-limit");
  const results = [];
  for (let index = 0; index < 50; index += 1) {
    results.push(stream.emit(input({ refs: { generationLeaseId: `lease-${index}` } })));
  }
  clock.runAll();
  assert.equal(results.every(Boolean), true, "the producer always got its event");
  assert.equal(throwing, 1, "a failed subscriber receives nothing further");
  assert.equal(healthy.length, 50);
  const stats = stream.getStats();
  assert.equal(stats.subscriberFailures, 1);
  assert.equal(stats.subscribers, 1);
  assert.equal(stats.produced, 50, "a failure produces no event about itself");
  assert.equal(stats.failureDetails.length, 1);
  assert.equal(stats.failureDetails[0]!.kind, "subscriber");
  assert.equal(stats.failureDetails[0]!.message.length, RUNTIME_CRITICAL_EVENT_LIMITS.maxFailureDetailChars);

  // Many failures keep at most the configured number of details.
  const storm = new RuntimeCriticalEventStream({ clock });
  storm.bind(SESSION);
  for (let index = 0; index < 40; index += 1) {
    storm.emit({ ...input(), fact: "not-a-fact" as never });
  }
  const stormStats = storm.getStats();
  assert.equal(stormStats.constructionFailures, 40);
  assert.equal(stormStats.failureDetails.length, RUNTIME_CRITICAL_EVENT_LIMITS.maxFailureDetails);
  assert.equal(stormStats.failureDetailsTruncated, true);
  assert.equal(stormStats.produced, 0);
});

test("AE4 emit is total: malformed input, a throwing getter and a failing clock never reach the producer", () => {
  const failingClock = {
    now: () => { throw new Error("clock read failed"); },
    schedule: () => { throw new Error("schedule failed"); },
    cancel: () => { throw new Error("cancel failed"); },
  };
  const stream = new RuntimeCriticalEventStream({ clock: failingClock });
  stream.bind(SESSION);
  const subscription = stream.subscribe(() => undefined);
  const hostile = { get traceId(): string { throw new Error("getter failed"); } };
  assert.doesNotThrow(() => {
    assert.equal(stream.emit(undefined as never), undefined);
    assert.equal(stream.emit(input({ refs: hostile })), undefined);
    assert.equal(stream.emit(input({ occurredAt: undefined })), undefined, "clock read failed inside the event layer");
    assert.equal(stream.emit(input({ stage: "" })), undefined);
    assert.equal(stream.emit(input({ purpose: "preview" as never })), undefined);
    assert.equal(stream.emit(input({ terminal: { object: "generation", disposition: "committed" } })), undefined);
    assert.equal(stream.emit(input({ fact: "terminal" })), undefined);
    // A valid event with a failing scheduler is still produced and returned.
    assert.ok(stream.emit(input()));
    subscription.unsubscribe();
    stream.close("done");
    stream.release("done");
  });
  const stats = stream.getStats();
  assert.equal(stats.constructionFailures, 7);
  assert.equal(stats.scheduleFailures >= 1, true);
  assert.equal(stats.produced, 1);
});

test("AE4 the event layer is total for a failure it cannot describe: an Error whose message cannot be converted never reaches a producer, a Recording caller or the delivery macrotask", () => {
  // An Error whose message is not a string and throws when converted.
  const unprintable = new Error("x");
  Object.defineProperty(unprintable, "message", { value: { toString() { throw new Error("conversion failed"); } } });
  const bound = (clock?: ConstructorParameters<typeof RuntimeCriticalEventStream>[0]) => {
    const stream = new RuntimeCriticalEventStream(clock);
    stream.bind(SESSION);
    return stream;
  };
  const throwing = () => { throw unprintable; };

  // emit: a getter of the input, the clock read and the scheduler each throw it.
  const fromInput = bound();
  const hostileInput = Object.defineProperty(input(), "stage", { get: throwing });
  assert.doesNotThrow(() => assert.equal(fromInput.emit(hostileInput), undefined));
  assert.equal(fromInput.getStats().constructionFailures, 1);
  const fromClock = bound({ clock: { now: throwing, schedule: () => 1, cancel: () => undefined } });
  assert.doesNotThrow(() => assert.equal(fromClock.emit(input({ occurredAt: undefined })), undefined));
  assert.equal(fromClock.getStats().constructionFailures, 1);
  const fromSchedule = bound({ clock: { now: () => 1, schedule: throwing, cancel: () => undefined } });
  fromSchedule.subscribe(() => undefined);
  assert.doesNotThrow(() => assert.equal(fromSchedule.emit(input())?.sequence, 1, "the event is still produced and returned"));
  // Stop and unmount with the same failing scheduler.
  assert.doesNotThrow(() => assert.equal(fromSchedule.closeSubscriptions("stop"), true));
  let handles = 0;
  const fromCancel = bound({ clock: { now: () => 1, schedule: () => ++handles, cancel: throwing } });
  fromCancel.subscribe(() => undefined);
  fromCancel.emit(input());
  assert.doesNotThrow(() => assert.equal(fromCancel.release("unmount"), true));
  assert.ok(fromSchedule.getStats().scheduleFailures >= 2 && fromCancel.getStats().scheduleFailures === 1);

  // The Hook's catch path: the Recording owner threw it, or a symbol, or returned no disposition.
  const recording = bound();
  assert.doesNotThrow(() => {
    recording.noteRecordingFailure(unprintable);
    recording.noteRecordingFailure(Symbol("thrown symbol"));
    recording.noteRecording({ toString: throwing } as never);
    recording.noteRecording("toString" as never);
  });
  assert.deepEqual({ ...recording.getStats().recording }, { accepted: 0, "not-recording": 0, "rejected-late": 0, failed: 2 });
  assert.deepEqual(recording.getStats().failureDetails,
    [{ kind: "recording", message: "unreadable failure" }, { kind: "recording", message: "Symbol(thrown symbol)" }]);

  // Delivery: a subscriber throws it. The macrotask does not throw, the
  // subscriber is cut off, and the other subscriber keeps receiving.
  const clock = new ManualRuntimeCriticalEventClock(() => 1);
  const delivery = bound({ clock });
  let calls = 0;
  delivery.subscribe(() => { calls += 1; throw unprintable; });
  const received: string[] = [];
  delivery.subscribe((item) => { received.push(item.kind); });
  delivery.emit(input());
  delivery.emit(input({ refs: { generationLeaseId: "lease-2" } }));
  assert.doesNotThrow(() => clock.runAll());
  assert.equal(calls, 1, "cut off after its first failure");
  assert.deepEqual(received, ["event", "event"]);
  const delivered = delivery.getStats();
  assert.deepEqual([delivered.subscriberFailures, delivered.subscribers, delivered.queueDepth], [1, 1, 0]);
  assert.deepEqual(delivered.failureDetails, [{ kind: "subscriber", message: "unreadable failure" }]);

  // A reason that cannot be converted is bounded the same way.
  const closing = bound({ clock });
  const closed: RuntimeCriticalEventDelivery[] = [];
  closing.subscribe((item) => { closed.push(item); });
  assert.doesNotThrow(() => closing.closeSubscriptions({ toString: throwing } as never));
  clock.runAll();
  assert.deepEqual(closed.map((item) => item.kind === "closed" && item.reason), ["unreadable failure"]);
});

test("AE3/AE5 a new session restarts the sequence, an old session's late input is counted and dropped, and a missing session never chains", () => {
  const h = createRuntimeCriticalEventHarness({ sessionId: "session-old" });
  assert.equal(h.stream.emit(input({ runtimeSessionId: "session-old" }))?.sequence, 1);
  assert.equal(h.stream.emit(input({ runtimeSessionId: "session-old", refs: { generationLeaseId: "b" } }))?.sequence, 2);
  // Both were delivered while their session was the current one.
  h.flush();
  h.stream.bind("session-new");
  const observerNew: RuntimeCriticalEventDelivery[] = [];
  h.stream.subscribe((delivery) => { observerNew.push(delivery); });
  // The old epoch's late terminal carries its own session: refused, not renumbered.
  assert.equal(h.stream.emit(input({ runtimeSessionId: "session-old" })), undefined);
  assert.equal(h.stream.emit(input({ runtimeSessionId: undefined })), undefined);
  assert.equal(h.stream.emit(input({ runtimeSessionId: null })), undefined);
  const fresh = h.stream.emit(input({ runtimeSessionId: "session-new" }));
  assert.equal(fresh?.sequence, 1);
  assert.equal(fresh?.eventId, "rce:session-new:1");
  h.flush();
  // The old session's observer saw its own events and one closed marker, then nothing.
  assert.deepEqual(h.deliveries.map((delivery) => delivery.kind), ["event", "event", "closed"]);
  assert.deepEqual(h.deliveries.at(-1), {
    kind: "closed", schemaVersion: 1, runtimeSessionId: "session-old", reason: "session-rebound", lastSequence: 2,
    discarded: 0,
  });
  assert.deepEqual(observerNew.map((delivery) => delivery.kind === "event" && delivery.event.runtimeSessionId), ["session-new"]);
  const stats = h.stream.getStats();
  assert.equal(stats.staleSessionRejected, 1);
  assert.equal(stats.missingIdentityRejected, 2);
  assert.equal(stats.subscribers, 1, "the old session's subscriber was dropped after its closed marker");
});

test("AE5 close stops accepting, still delivers what was queued plus one closed marker, then drops subscribers; release drops everything at once", () => {
  const h = createRuntimeCriticalEventHarness({ sessionId: SESSION });
  h.stream.emit(input());
  h.stream.emit(input({ refs: { generationLeaseId: "lease-2" } }));
  assert.equal(h.stream.close("meeting-assistant-stopped"), true);
  assert.equal(h.stream.close("again"), false);
  assert.equal(h.stream.emit(input({ refs: { generationLeaseId: "late" } })), undefined);
  assert.equal(h.stream.subscribe(() => undefined).reason, "not-accepting");
  h.flush();
  assert.deepEqual(h.deliveries.map((delivery) => delivery.kind), ["event", "event", "closed"]);
  assert.deepEqual(h.deliveries.at(-1), {
    kind: "closed", schemaVersion: 1, runtimeSessionId: SESSION,
    reason: "meeting-assistant-stopped", lastSequence: 2, discarded: 0,
  });
  const closed = h.stream.getStats();
  assert.equal(closed.lateAfterClose, 1);
  assert.equal(closed.subscribers, 0);
  assert.equal(closed.queueDepth, 0);
  assert.equal(h.manualClock?.pendingCount(), 0);

  const r = createRuntimeCriticalEventHarness({ sessionId: SESSION });
  for (let index = 0; index < 10; index += 1) {
    r.stream.emit(input({ refs: { generationLeaseId: `lease-${index}` } }));
  }
  assert.equal(r.manualClock?.pendingCount(), 1);
  r.stream.release("meeting-hook-unmounted");
  assert.equal(r.manualClock?.pendingCount(), 0, "the delivery timer is cancelled");
  r.flush();
  assert.deepEqual(r.deliveries, [], "nothing is delivered after release");
  const released = r.stream.getStats();
  assert.equal(released.discardedUndelivered, 10);
  assert.equal(released.subscribers, 0);
  assert.equal(released.queueDepth, 0);
  assert.equal(released.accepting, false);
  // The same session can be bound again: its sequence continues, it does not restart.
  r.stream.bind(SESSION);
  assert.equal(r.stream.emit(input({ refs: { generationLeaseId: "after" } }))?.sequence, 11);
});

test("AE5 Stop ends the subscriptions, not the session: the ended observer gets what was queued and one closed marker, later facts of the same session are still produced, and a new observer is not touched by the old marker", () => {
  const h = createRuntimeCriticalEventHarness({ sessionId: SESSION });
  h.stream.emit(input());
  h.stream.emit(input({ refs: { generationLeaseId: "lease-2" } }));
  assert.equal(h.stream.closeSubscriptions("meeting-assistant-stopped"), true);
  assert.equal(h.stream.getStats().accepting, true, "the session id did not change");
  // Subscribed after Stop and before any delivery ran.
  const later: RuntimeCriticalEventDelivery[] = [];
  const subscription = h.stream.subscribe((delivery) => { later.push(delivery); });
  assert.deepEqual([subscription.accepted, subscription.runtimeSessionId], [true, SESSION]);
  // A terminal of work that Stop cancelled, and an idle fact after Stop.
  const lateTerminal = h.stream.emit(input({ fact: "terminal", stage: "provider-attempt-final",
    terminal: { object: "provider-request", disposition: "aborted" }, refs: { requestId: "r1", attemptId: "r1:1" } }));
  const idle = h.stream.emit(input({ fact: "input-accepted", stage: "screen-operation-claimed", refs: { operationId: "screen-1" } }));
  assert.deepEqual([lateTerminal?.sequence, idle?.sequence], [3, 4], "the sequence continues: one session, one order");
  h.flush();
  assert.deepEqual(h.deliveries.map((delivery) => delivery.kind), ["event", "event", "closed"]);
  assert.deepEqual(h.deliveries.at(-1), { kind: "closed", schemaVersion: 1, runtimeSessionId: SESSION,
    reason: "meeting-assistant-stopped", lastSequence: 2, discarded: 0 });
  assert.deepEqual(later.map((delivery) => delivery.kind === "event" ? delivery.event.sequence : delivery.kind), [3, 4],
    "the new observer got no earlier event and no closed marker");
  const stats = h.stream.getStats();
  assert.deepEqual([stats.lateAfterClose, stats.subscribers, stats.queueDepth, stats.produced], [0, 1, 0, 4]);
  // The first-key guard continues across Stop: the same terminal is still one.
  assert.equal(h.stream.emit(input({ fact: "terminal", stage: "provider-attempt-final",
    terminal: { object: "provider-request", disposition: "aborted" }, refs: { requestId: "r1", attemptId: "r1:1" } })), undefined);
  // Nothing to end twice, and a closed or released stream has no subscriptions to end.
  assert.equal(h.stream.closeSubscriptions("again"), true);
  h.flush();
  assert.equal(later.at(-1)?.kind, "closed");
  h.stream.release("unmounted");
  assert.equal(h.stream.closeSubscriptions("after-release"), false);
  assert.equal(h.stream.emit(input({ refs: { generationLeaseId: "after-release" } })), undefined);
  assert.equal(h.stream.getStats().lateAfterClose, 1);
});

test("AE5 an unsubscribed session retains nothing and cancels its timer", () => {
  const clock = new ManualRuntimeCriticalEventClock();
  const stream = new RuntimeCriticalEventStream({ clock });
  stream.bind(SESSION);
  const subscription = stream.subscribe(() => assert.fail("must not be delivered"));
  stream.emit(input());
  stream.emit(input({ refs: { generationLeaseId: "lease-2" } }));
  assert.equal(stream.getStats().queueDepth, 2);
  subscription.unsubscribe();
  subscription.unsubscribe();
  const stats = stream.getStats();
  assert.equal(stats.queueDepth, 0);
  assert.equal(stats.subscribers, 0);
  assert.equal(stats.discardedUndelivered, 2);
  assert.equal(clock.pendingCount(), 0);
});

test("AE2/AE5 first-key guards: one LQU per id and revision, a settlement fact for each change of its adopted value (there and back), one first visible per generation, one terminal per object", () => {
  const h = createRuntimeCriticalEventHarness({ sessionId: SESSION });
  const lqu = (id: string, revision: number) => h.stream.emit(input({
    fact: "lqu-committed", stage: "canonical-publish",
    refs: { logicalQuestionUnitId: id, logicalQuestionRevision: revision },
  }));
  assert.ok(lqu("q1", 1));
  assert.equal(lqu("q1", 1), undefined, "the same id and revision is one commit");
  assert.ok(lqu("q1", 2), "a new revision is a new commit");
  assert.ok(lqu("q2", 1));
  assert.equal(h.stream.emit(input({ fact: "lqu-committed", stage: "canonical-publish", refs: {} })), undefined);

  // A settlement announces the value it adopts, and again each time an
  // assignment changes that value. Assigning it again with the value already
  // announced says nothing.
  const settled = (fact: "type-settled" | "relation-settled", stage: string, refs: RuntimeCriticalEventInput["refs"]) =>
    h.stream.emit(input({ fact, stage, refs: { settlementId: "s1", ...refs } }));
  assert.ok(settled("type-settled", "settlement-adopted", { questionType: "unknown" }));
  assert.ok(settled("relation-settled", "settlement-adopted", { relation: "unknown" }));
  assert.equal(settled("type-settled", "settlement-adopted", { questionType: "unknown" }), undefined);
  assert.equal(settled("relation-settled", "settlement-adopted", { relation: "unknown" }), undefined);
  assert.equal(settled("type-settled", "effective-settlement-adopted", { questionType: "unknown" }), undefined,
    "an effective view with the same Type is not a second Type fact");
  const effective = settled("relation-settled", "effective-settlement-adopted", { relation: "followup-parent" });
  assert.deepEqual([effective?.stage, effective?.refs.relation, effective?.refs.settlementId],
    ["effective-settlement-adopted", "followup-parent", "s1"], "the changed Relation is announced once, with the same settlement id");
  assert.equal(settled("relation-settled", "effective-settlement-adopted", { relation: "followup-parent" }), undefined);
  // There and back. A re-run assigns the raw settlement again after the
  // effective one: the Relation returned to its first value, and that is said.
  const rawAgain = settled("relation-settled", "settlement-adopted", { relation: "unknown" });
  assert.deepEqual([rawAgain?.stage, rawAgain?.refs.relation], ["settlement-adopted", "unknown"],
    "a Relation that returns to an earlier value is announced again");
  assert.equal(settled("relation-settled", "settlement-adopted", { relation: "unknown" }), undefined);
  // A manual retype of the owner, four times: every change of the adopted Type
  // is a fact, so the last fact of the settlement names the Type adopted now.
  const retypes = ["coding", "project-deep-dive", "coding", "project-deep-dive"].map((questionType) =>
    settled("type-settled", "manual-retype-projection", { questionType }));
  assert.deepEqual(retypes.map((event) => event?.refs.questionType), ["coding", "project-deep-dive", "coding", "project-deep-dive"]);
  assert.equal(settled("type-settled", "manual-retype-projection", { questionType: "project-deep-dive" }), undefined,
    "the same Type assigned again is not a change");
  assert.equal(settled("relation-settled", "manual-retype-projection", { relation: "unknown" }), undefined,
    "a retype that leaves the Relation as it was says nothing about the Relation");
  const lastTypeOfS1 = h.events().filter((event) => event.fact === "type-settled" && event.refs.settlementId === "s1").at(-1);
  assert.equal(lastTypeOfS1?.refs.questionType, "project-deep-dive");
  // Another settlement has its own memory, and an observation one never stands in for it.
  assert.ok(h.stream.emit(input({ fact: "type-settled", stage: "settlement-adopted",
    refs: { settlementId: "s2", questionType: "project-deep-dive" } })));
  assert.ok(h.stream.emit(input({ fact: "type-settled", stage: "settlement-adopted", purpose: "observation",
    refs: { settlementId: "s2", questionType: "project-deep-dive" } })));
  assert.equal(h.stream.emit(input({ fact: "type-settled", stage: "settlement-adopted", refs: { questionType: "coding" } })), undefined,
    "a settlement fact names its settlement");

  const visible = (refs: RuntimeCriticalEventInput["refs"], stage: string) =>
    h.stream.emit(input({ fact: "first-visible-content", stage, runtimeEpoch: undefined, refs }));
  const streaming = { traceId: "t", generationId: "g" };
  const stable = { traceId: "t", generationId: "g", suggestionId: "g", stableRevision: 4 };
  assert.equal(visible(streaming, "streaming")?.stage, "streaming");
  assert.equal(visible(streaming, "streaming"), undefined, "a repeated ACK is not a new fact");
  assert.equal(visible({ ...streaming, displaySurface: "focus-mode" }, "streaming"), undefined,
    "another window showing the same target is not a new first");
  assert.equal(visible(stable, "stable"), undefined,
    "the stable ACK of a generation that was already visible while streaming is not a second first");
  assert.equal(visible({ ...stable, stableRevision: 5 }, "stable"), undefined, "nor is a later revision of that generation");
  assert.equal(visible({ ...stable, traceId: "origin-trace" }, "stable"), undefined, "nor the same generation under another trace reference");
  // A generation that was never streamed is first visible when its stable answer is applied.
  assert.equal(visible({ traceId: "t2", generationId: "g2", suggestionId: "g2", stableRevision: 6 }, "stable")?.stage, "stable");
  assert.ok(visible({ suggestionId: "g3", stableRevision: 7 }, "stable"), "the suggestion names the generation when no generation id is held");
  assert.equal(visible({ traceId: "t" }, "stable"), undefined, "an empty display target shows no content");
  assert.equal(visible({}, "streaming"), undefined);

  const terminal = (object: (typeof RUNTIME_CRITICAL_TERMINAL_OBJECTS)[number], refs: RuntimeCriticalEventInput["refs"], disposition: string) =>
    h.stream.emit(input({ fact: "terminal", stage: "terminal", terminal: { object, disposition }, refs }));
  assert.ok(terminal("generation", { generationLeaseId: "lease-1" }, "superseded"));
  assert.equal(terminal("generation", { generationLeaseId: "lease-1" }, "committed"), undefined,
    "the first terminal of an object wins");
  assert.ok(terminal("provider-request", { requestId: "r1", attemptId: "r1:1" }, "failed"));
  assert.ok(terminal("provider-request", { requestId: "r1", attemptId: "r1:2" }, "success"), "each physical attempt has its own terminal");
  assert.equal(terminal("provider-request", { requestId: "r1", attemptId: "r1:2" }, "success"), undefined);
  assert.equal(terminal("screen-operation", {}, "released"), undefined, "a terminal without its object identity is refused");
  assert.ok(terminal("screen-operation", { operationId: "screen-1" }, "superseded"));
  assert.equal(terminal("screen-operation", { operationId: "screen-1" }, "released"), undefined);
  assert.ok(terminal("manual-action", { manualActionId: "a1" }, "completed"));
  // The task writer answers every call. Distinct rejected calls that share an
  // operation id are distinct terminals.
  const rejected = [
    terminal("lifecycle-transition", { receiptId: "op-1", transition: "set-phase", taskRuntimeRevision: 4 }, "rejected"),
    terminal("lifecycle-transition", { receiptId: "op-1", transition: "update-parent-context", taskRuntimeRevision: 4 }, "rejected"),
    terminal("lifecycle-transition", { receiptId: "op-1", transition: "set-phase", taskRuntimeRevision: 5 }, "rejected"),
  ];
  assert.deepEqual(rejected.map((event) => event?.refs.transition), ["set-phase", "update-parent-context", "set-phase"]);

  const stats = h.stream.getStats();
  assert.equal(stats.duplicateSuppressed, 16);
  assert.equal(stats.missingIdentityRejected, 5);
  // A suppressed duplicate consumes no sequence: the stream stays contiguous.
  const sequences = h.events().map((event) => event.sequence);
  assert.deepEqual(sequences, sequences.map((_, index) => index + 1));
});

test("AE3 an observation fact never suppresses or satisfies a formal one that shares its identifiers", () => {
  const h = createRuntimeCriticalEventHarness({ sessionId: SESSION });
  const refs = { requestId: "relation-op:fast", operationId: "relation-op", operationKind: "task-relation-parent-affinity" };
  const terminal = (purpose: "formal" | "observation") => h.stream.emit(input({
    fact: "terminal", stage: "candidate-terminal", purpose,
    terminal: { object: "provider-request", disposition: "success" }, refs,
  }));
  assert.equal(terminal("observation")?.purpose, "observation");
  assert.equal(terminal("formal")?.purpose, "formal", "the formal terminal is not hidden by the observation one");
  assert.equal(terminal("observation"), undefined);
  assert.equal(terminal("formal"), undefined);
  // A barrier written for a formal fact is a filter on purpose as well as identity.
  const formalFacts = h.events().filter((event) => event.purpose === "formal" && event.refs.requestId === refs.requestId);
  assert.equal(formalFacts.length, 1);
});

test("AE5 an identifier longer than the reference bound is carried as a bounded digest: a start still pairs with its terminal, and the logical operation stays apart from its physical candidates", () => {
  const h = createRuntimeCriticalEventHarness({ sessionId: SESSION });
  // The shape of a production Relation operation with an active child.
  const operationId = "task-relation-canonical-shadow:meeting_1791075101245_k3j9x2:12:logical_question_1791075101301_q8w2e1:2:1:" +
    "interview_child_1791075101377_p0o9i8:0:5f11eace";
  assert.ok(operationId.length > RUNTIME_CRITICAL_EVENT_LIMITS.maxReferenceChars);
  const candidate = (tier: string, fact: "provider-request-started" | "terminal") => h.stream.emit(input({
    fact, stage: fact === "terminal" ? "candidate-terminal" : "request-start",
    ...(fact === "terminal" ? { terminal: { object: "provider-request" as const, disposition: "cancelled" } } : {}),
    refs: { requestId: `${operationId}:${tier}`, operationId, operationKind: "task-relation-canonical-shadow", providerTier: tier },
  }));
  const started = { fast: candidate("fast", "provider-request-started"), intelligent: candidate("intelligent", "provider-request-started") };
  const ended = { fast: candidate("fast", "terminal"), intelligent: candidate("intelligent", "terminal") };
  assert.ok(started.fast && started.intelligent && ended.fast && ended.intelligent);
  for (const event of [started.fast, started.intelligent, ended.fast, ended.intelligent]) {
    assert.deepEqual(event.digestedRefs, ["operationId", "requestId"]);
    assert.equal(event.omittedRefs, undefined);
    assert.equal(event.refs.requestId?.length, RUNTIME_CRITICAL_EVENT_LIMITS.maxReferenceChars);
    assert.equal(event.refs.operationId?.length, RUNTIME_CRITICAL_EVENT_LIMITS.maxReferenceChars);
    assert.match(event.refs.requestId ?? "", /^task-relation-canonical-shadow:meeting_.*~[0-9a-f]{16}$/);
    assert.ok(JSON.stringify(event).length <= RUNTIME_CRITICAL_EVENT_LIMITS.maxEventJsonChars);
  }
  // Start and terminal of one candidate carry the same reference.
  assert.equal(started.fast.refs.requestId, ended.fast.refs.requestId);
  assert.equal(started.intelligent.refs.requestId, ended.intelligent.refs.requestId);
  // The two physical candidates differ; both name the same logical operation.
  assert.notEqual(started.fast.refs.requestId, started.intelligent.refs.requestId);
  assert.equal(started.fast.refs.operationId, started.intelligent.refs.operationId);
  assert.notEqual(started.fast.refs.operationId, started.fast.refs.requestId);
  // Another operation of the same kind for the same question is told apart.
  const sibling = h.stream.emit(input({ fact: "provider-request-started", stage: "request-start",
    refs: { operationId: operationId.replace("5f11eace", "5f11eacf"), operationKind: "task-relation-canonical-shadow" } }));
  assert.notEqual(sibling?.refs.operationId, started.fast.refs.operationId);
  // The long identifier still deduplicates its terminal.
  assert.equal(candidate("fast", "terminal"), undefined);
  assert.equal(h.stream.getStats().referencesDigested, 9);
  // Beyond the digest bound the identifier is refused, as a reference and as a key.
  const absurd = "x".repeat(RUNTIME_CRITICAL_EVENT_LIMITS.maxIdentifierSourceChars + 1);
  const refused = h.stream.emit(input({ refs: { requestId: absurd, traceId: "trace-1" } }));
  assert.deepEqual([refused?.refs.requestId, refused?.omittedRefs], [undefined, ["requestId"]]);
  assert.equal(h.stream.emit(input({ fact: "terminal", stage: "candidate-terminal",
    terminal: { object: "provider-request", disposition: "cancelled" }, refs: { requestId: absurd } })), undefined);
  assert.equal(h.stream.getStats().missingIdentityRejected, 1);
});

test("AE5/AE6 a reader maps an owner's raw identifier to the reference an event carries with the exported pure function", () => {
  const h = createRuntimeCriticalEventHarness({ sessionId: SESSION });
  const short = "relation-op:fast";
  const long = `task-relation-parent-affinity:${"trace_".repeat(20)}:candidate:intelligent`;
  const other = `task-relation-parent-affinity:${"trace_".repeat(20)}:candidate:fast`;
  assert.ok(long.length > RUNTIME_CRITICAL_EVENT_LIMITS.maxReferenceChars && long.length === other.length + 7);
  const started = (requestId: string) => h.stream.emit(input({ fact: "provider-request-started", stage: "request-start",
    refs: { requestId } }))!;
  // The reference of an identifier that fits is the identifier.
  assert.equal(runtimeCriticalEventIdentifierReference(short), short);
  assert.equal(started(short).refs.requestId, short);
  // A longer one: the function returns exactly what the event carries, so a
  // raw id read from a trace file finds its journal lines.
  const carried = started(long);
  assert.notEqual(carried.refs.requestId, long);
  assert.equal(carried.refs.requestId, runtimeCriticalEventIdentifierReference(long));
  assert.deepEqual(carried.digestedRefs, ["requestId"]);
  assert.equal(carried.refs.requestId!.length, RUNTIME_CRITICAL_EVENT_LIMITS.maxReferenceChars);
  // Candidates of one operation share a long prefix and still map apart.
  assert.notEqual(runtimeCriticalEventIdentifierReference(other), runtimeCriticalEventIdentifierReference(long));
  assert.equal(started(other).refs.requestId, runtimeCriticalEventIdentifierReference(other));
  // Too long to carry, empty or not a string: no reference, as in an event.
  assert.equal(runtimeCriticalEventIdentifierReference("x".repeat(RUNTIME_CRITICAL_EVENT_LIMITS.maxIdentifierSourceChars + 1)), undefined);
  assert.equal(runtimeCriticalEventIdentifierReference(""), undefined);
  assert.equal(runtimeCriticalEventIdentifierReference(undefined as never), undefined);
  // The same limits as the stream that produced the events.
  assert.equal(runtimeCriticalEventIdentifierReference("abcdefghijklmnopqrstuvwxyz", { maxReferenceChars: 20, maxIdentifierSourceChars: 64 })?.length, 20);
});

test("AE5 the first-key memory is bounded per family by count and by size, a repeated key is never the one evicted, and an eviction is counted", () => {
  const stream = new RuntimeCriticalEventStream({ limits: { maxFirstKeys: 4 } });
  stream.bind(SESSION);
  const visible = (generationId: string) => stream.emit(input({ fact: "first-visible-content", stage: "stable",
    runtimeEpoch: undefined, refs: { generationId, suggestionId: generationId, stableRevision: 1 } }));
  const lqu = (id: string) => stream.emit(input({ fact: "lqu-committed", stage: "canonical-publish",
    refs: { logicalQuestionUnitId: id, logicalQuestionRevision: 1 } }));
  assert.ok(visible("pinned"));
  for (let index = 0; index < 50; index += 1) {
    assert.ok(visible(`g${index}`));
    // The pinned answer keeps being acknowledged while later answers are shown.
    assert.equal(visible("pinned"), undefined, `repeat ${index} of the live target is still suppressed`);
    assert.ok(lqu(`q${index}`));
  }
  const stats = stream.getStats();
  assert.equal(stats.retainedFirstKeys, 8, "four keys per family, two families in use");
  assert.equal(stats.firstKeysEvicted, (51 - 4) + (50 - 4), "every key that left a window is counted");
  // Another family's traffic never evicts a display target.
  for (let index = 0; index < 100; index += 1) lqu(`later-${index}`);
  assert.equal(visible("pinned"), undefined);
  assert.equal(visible("g49"), undefined);
  // Outside the window the guard no longer knows the key, and the counter says so.
  assert.ok(visible("g0"), "a key evicted long ago is produced again");
  assert.ok(stream.getStats().firstKeysEvicted > 0);

  // The settlement family is bounded the same way. It holds one entry per
  // settlement and fact (the value last announced), never one per value.
  const settlements = new RuntimeCriticalEventStream({ limits: { maxFirstKeys: 4 } });
  settlements.bind(SESSION);
  const typed = (settlementId: string, questionType: string) => settlements.emit(input({ fact: "type-settled",
    stage: "settlement-adopted", refs: { settlementId, questionType } }));
  assert.ok(typed("current", "coding"));
  for (let index = 0; index < 50; index += 1) {
    assert.ok(typed(`other-${index}`, "coding"));
    // The current settlement is retyped there and back while others are adopted.
    assert.ok(typed("current", index % 2 ? "coding" : "system-design"), `change ${index} of the current settlement is announced`);
    assert.equal(typed("current", index % 2 ? "coding" : "system-design"), undefined, `and its repeat ${index} is not`);
  }
  assert.equal(settlements.getStats().retainedFirstKeys, 4 + 1,
    "fifty changes of one settlement hold one entry; one more names the settlement last adopted");
  assert.equal(settlements.getStats().firstKeysEvicted, 51 - 4);

  // Size: key parts are bounded like references, whatever the producer passes.
  const sized = new RuntimeCriticalEventStream();
  sized.bind(SESSION);
  const huge = "y".repeat(400);
  assert.ok(sized.emit(input({ fact: "terminal", stage: "generation-result",
    terminal: { object: "generation", disposition: "superseded" }, refs: { generationLeaseId: huge } })));
  assert.equal(sized.emit(input({ fact: "terminal", stage: "generation-result",
    terminal: { object: "generation", disposition: "superseded" }, refs: { generationLeaseId: huge } })), undefined);
  assert.equal(sized.emit(input({ fact: "terminal", stage: "generation-result",
    terminal: { object: "generation", disposition: "superseded" }, refs: { generationLeaseId: "z".repeat(100_000) } })), undefined,
    "an identifier too long to bound is no identity");
  assert.deepEqual([sized.getStats().retainedFirstKeys, sized.getStats().missingIdentityRejected], [1, 1]);
});

test("AE5/AE8 the work of one event does not depend on how many events the session has produced", () => {
  const stream = new RuntimeCriticalEventStream();
  stream.bind(SESSION);
  const measure = (count: number) => {
    const started = process.hrtime.bigint();
    for (let index = 0; index < count; index += 1) {
      stream.emit(input({ refs: { generationLeaseId: `lease-${index}`, traceId: "trace" } }));
    }
    return Number(process.hrtime.bigint() - started) / count;
  };
  measure(2_000);
  const early = measure(20_000);
  for (let index = 0; index < 200_000; index += 1) {
    stream.emit(input({ refs: { generationLeaseId: `warm-${index}` } }));
  }
  const late = measure(20_000);
  const stats = stream.getStats();
  assert.equal(stats.queueDepth, 0);
  assert.equal(stats.retainedFirstKeys, 0);
  assert.equal(stats.lastSequence, 242_000);
  // Structural claim, with a wide tolerance for a shared machine.
  assert.ok(late < early * 8 + 2_000, `per-event ns early=${early.toFixed(0)} late=${late.toFixed(0)}`);
});

test("AE6 the journal reader: missing file, unknown version, grouping by runtime session, explicit gaps and disorder", () => {
  assert.deepEqual(parseRuntimeCriticalEventJournal(undefined), { status: "not-provided" });
  assert.deepEqual(parseRuntimeCriticalEventJournal(null), { status: "not-provided" });

  const stream = new RuntimeCriticalEventStream();
  const line = (event: unknown, extra: object = {}) => `${JSON.stringify({ ...(event as object), ...extra })}\n`;
  stream.bind("session-1");
  const a1 = stream.emit(input({ runtimeSessionId: "session-1" }))!;
  const a2 = stream.emit(input({ runtimeSessionId: "session-1", refs: { generationLeaseId: "l2" } }))!;
  const a3 = stream.emit(input({ runtimeSessionId: "session-1", refs: { generationLeaseId: "l3" } }))!;
  const a4 = stream.emit(input({ runtimeSessionId: "session-1", fact: "terminal", stage: "generation-result",
    terminal: { object: "generation", disposition: "superseded", reason: "newer-turn" }, refs: { generationLeaseId: "l3" } }))!;
  stream.bind("session-2");
  const b1 = stream.emit(input({ runtimeSessionId: "session-2" }))!;
  const generation = { recordingSessionId: "session_recording_1", recordingGenerationId: "recording_generation_1" };

  const complete = parseRuntimeCriticalEventJournal(
    line(a1, generation) + line(a2, generation) + "\n" + line(a3, generation) + line(a4, generation) + line(b1, generation));
  assert.equal(complete.status, "ok");
  assert.ok(complete.status === "ok");
  assert.equal(complete.contiguous, true);
  assert.equal(complete.eventCount, 5);
  assert.deepEqual(complete.sessions.map((session) => [session.runtimeSessionId, session.firstSequence, session.lastSequence, session.gaps.length]),
    [["session-1", 1, 4, 0], ["session-2", 1, 1, 0]]);
  // Identity, order and the original terminal read back as they were produced.
  assert.deepEqual(complete.sessions[0]!.events.map((event) => event.eventId), [a1, a2, a3, a4].map((event) => event.eventId));
  assert.deepEqual(complete.sessions[0]!.events[3]!.terminal, { object: "generation", disposition: "superseded", reason: "newer-turn" });
  assert.equal(complete.sessions[0]!.events[0]!.recordingGenerationId, "recording_generation_1");

  const holed = parseRuntimeCriticalEventJournal(line(a2) + line(a4) + "not json\n" + line(a3) + line(b1));
  assert.ok(holed.status === "ok");
  assert.equal(holed.contiguous, false);
  assert.equal(holed.malformedLines, 1);
  assert.deepEqual(holed.sessions[0]!.gaps, [
    { firstMissingSequence: 1, lastMissingSequence: 1 },
    { firstMissingSequence: 3, lastMissingSequence: 3 },
  ]);
  assert.equal(holed.sessions[0]!.orderViolations, 1);
  assert.deepEqual(holed.sessions[1]!.gaps, []);

  assert.deepEqual(parseRuntimeCriticalEventJournal(line(a1) + line({ ...a2, schemaVersion: 2 })),
    { status: "unsupported-version", schemaVersion: 2, line: 2 });
  // A line that names no version is a damaged line: it is counted, the events
  // around it are still returned, and the journal is not reported as another version.
  for (const damaged of [{}, { label: "advise-display-applied" }, { ...a3, schemaVersion: undefined }]) {
    const read = parseRuntimeCriticalEventJournal(line(a1) + line(a2) + line(damaged) + line(a4));
    assert.ok(read.status === "ok", JSON.stringify(damaged));
    assert.deepEqual([read.eventCount, read.malformedLines, read.contiguous], [3, 1, false]);
    assert.deepEqual(read.sessions[0]!.events.map((event) => event.sequence), [1, 2, 4]);
  }
  assert.deepEqual(parseRuntimeCriticalEventJournal(line({ label: "advise-display-applied" })),
    { status: "ok", sessions: [], eventCount: 0, malformedLines: 1, contiguous: false });
  // A version 1 line that lacks a field every event has is not an event.
  const { purpose: _purpose, ...noPurpose } = a2;
  const { stage: _stage, ...noStage } = a2;
  const { eventId: _eventId, ...noEventId } = a2;
  const { occurredAt: _occurredAt, ...noTime } = a2;
  const { terminal: _terminal, ...terminalWithoutObject } = a4;
  const incomplete: unknown[] = [
    noPurpose, noStage, noEventId, noTime, terminalWithoutObject,
    { ...a2, purpose: "preview" },
    { ...a4, terminal: { object: "answer", disposition: "committed" } },
    { ...a4, terminal: { object: "generation" } },
    { ...a2, terminal: { object: "generation", disposition: "committed" } },
    { ...a2, refs: [] },
    { schemaVersion: 1, runtimeSessionId: "session-1", sequence: 2, fact: "terminal", refs: {} },
  ];
  for (const record of incomplete) {
    const read = parseRuntimeCriticalEventJournal(line(a1) + line(record) + line(a3));
    assert.ok(read.status === "ok");
    assert.deepEqual([read.eventCount, read.malformedLines, read.contiguous], [2, 1, false], JSON.stringify(record));
    assert.deepEqual(read.sessions[0]!.gaps, [{ firstMissingSequence: 2, lastMissingSequence: 2 }]);
    assert.ok(read.sessions[0]!.events.every((event) => event.purpose === "formal" && event.stage && event.eventId));
  }
  const empty = parseRuntimeCriticalEventJournal("");
  assert.ok(empty.status === "ok");
  assert.equal(empty.eventCount, 0);
});

test("AE4/AE6 the Recording outcome of an event is counted, and its failure is bounded and separate from delivery", () => {
  const stream = new RuntimeCriticalEventStream();
  stream.bind(SESSION);
  stream.noteRecording("accepted");
  stream.noteRecording("accepted");
  stream.noteRecording("not-recording");
  stream.noteRecording("rejected-late");
  stream.noteRecording("unknown" as never);
  stream.noteRecordingFailure(new Error("disk full"));
  const stats = stream.getStats();
  // "accepted" is the write queue taking the line; it is not a claim that the line is on disk.
  assert.deepEqual({ ...stats.recording }, { accepted: 2, "not-recording": 1, "rejected-late": 1, failed: 1 });
  assert.deepEqual(stats.failureDetails, [{ kind: "recording", message: "disk full" }]);
  assert.equal(stats.subscriberFailures, 0);
  assert.equal(Object.isFrozen(stats), true);
});

test("AE2/AE5 the session's current settlement: adopting another settlement than the last one is announced even when its values were announced before, so the last Type and Relation facts always name the current settlement, in bounded memory", () => {
  const h = createRuntimeCriticalEventHarness({ sessionId: SESSION });
  const adopt = (settlementId: string, questionType: string, relation: string, purpose: "formal" | "observation" = "formal") => [
    h.stream.emit(input({ fact: "type-settled", stage: "settlement-adopted", purpose, refs: { settlementId, questionType } })),
    h.stream.emit(input({ fact: "relation-settled", stage: "settlement-adopted", purpose, refs: { settlementId, relation } })),
  ];
  const produced = (pair: ReturnType<typeof adopt>) => pair.map((event) => Boolean(event));
  const last = (fact: string) => h.events().filter((event) => event.fact === fact && event.purpose === "formal").at(-1)?.refs;

  // The first answer adopts S1, a follow-up adopts S2, and a regenerate of the
  // first answer adopts S1 again with the values it always had.
  assert.deepEqual(produced(adopt("s1", "project-deep-dive", "new-parent")), [true, true]);
  assert.deepEqual(produced(adopt("s1", "project-deep-dive", "new-parent")), [false, false], "the same settlement again says nothing");
  assert.deepEqual(produced(adopt("s2", "project-deep-dive", "followup-parent")), [true, true]);
  assert.deepEqual([last("type-settled")?.settlementId, last("relation-settled")?.settlementId], ["s2", "s2"]);
  assert.deepEqual(produced(adopt("s1", "project-deep-dive", "new-parent")), [true, true],
    "the return to S1 is announced although both of its values were announced before");
  assert.deepEqual([last("type-settled")?.settlementId, last("type-settled")?.questionType,
    last("relation-settled")?.settlementId, last("relation-settled")?.relation],
  ["s1", "project-deep-dive", "s1", "new-parent"], "the last facts name the current settlement");
  assert.deepEqual(produced(adopt("s1", "project-deep-dive", "new-parent")), [false, false], "and S1 again is a repeat again");
  // Type and Relation each follow their own assignment order.
  assert.ok(h.stream.emit(input({ fact: "type-settled", stage: "settlement-adopted", refs: { settlementId: "s2", questionType: "project-deep-dive" } })));
  assert.equal(h.stream.emit(input({ fact: "relation-settled", stage: "settlement-adopted", refs: { settlementId: "s1", relation: "new-parent" } })), undefined,
    "S1 is still the settlement whose Relation was adopted last");
  // An observation settlement never moves the formal one.
  assert.deepEqual(produced(adopt("s9", "coding", "new-parent", "observation")), [true, true]);
  assert.equal(h.stream.emit(input({ fact: "type-settled", stage: "settlement-adopted", refs: { settlementId: "s2", questionType: "project-deep-dive" } })), undefined);
  // A change of value on the current settlement is still announced, under its stage.
  const retyped = h.stream.emit(input({ fact: "type-settled", stage: "manual-retype-projection", refs: { settlementId: "s2", questionType: "coding" } }));
  assert.deepEqual([retyped?.stage, retyped?.refs.questionType], ["manual-retype-projection", "coding"]);

  // Bounded: the guard holds the window of settlement keys and one name of
  // the last adopted settlement per fact and purpose, whatever the session does.
  const bounded = new RuntimeCriticalEventStream({ limits: { maxFirstKeys: 16 } });
  bounded.bind(SESSION);
  const adoptAll = (settlementId: string) => {
    let announced = 0;
    for (const purpose of ["formal", "observation"] as const) {
      for (const fact of ["type-settled", "relation-settled"] as const) {
        if (bounded.emit(input({ fact, stage: "settlement-adopted", purpose,
          refs: { settlementId, questionType: "coding", relation: "new-parent" } }))) announced += 1;
      }
    }
    return announced;
  };
  let announced = 0;
  for (let index = 0; index < 2_000; index += 1) announced += adoptAll(`s${index % 3}`);
  assert.equal(announced, 8_000, "three settlements adopted in turn: every adoption changes the current settlement");
  assert.deepEqual([bounded.getStats().retainedFirstKeys, bounded.getStats().firstKeysEvicted], [12 + 4, 0],
    "twelve settlement keys, all inside the window, and four names of the last adopted settlement");
  for (let index = 0; index < 500; index += 1) adoptAll(`other-${index}`);
  assert.equal(bounded.getStats().retainedFirstKeys, 16 + 4, "the window and the four names, however many settlements were adopted");
  // A new session starts with no settlement adopted.
  bounded.bind("session-next");
  assert.equal(bounded.getStats().retainedFirstKeys, 0);
  assert.ok(bounded.emit(input({ runtimeSessionId: "session-next", fact: "type-settled", stage: "settlement-adopted",
    refs: { settlementId: "s0", questionType: "coding" } })));
});

test("AE4/AE5 a subscriber that fails asynchronously is cut off like one that throws: an async listener and a returned rejected promise receive nothing further, one failure is counted per subscriber, nothing is awaited and no rejection is left unhandled", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  // Rejection handlers are microtasks; a macrotask later every one has run.
  const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    const clock = new ManualRuntimeCriticalEventClock();
    const stream = new RuntimeCriticalEventStream({ clock });
    stream.bind(SESSION);
    let asyncCalls = 0;
    stream.subscribe(async () => {
      asyncCalls += 1;
      throw new Error("async observer failure");
    });
    const healthy: number[] = [];
    stream.subscribe((delivery) => { if (delivery.kind === "event") healthy.push(delivery.event.sequence); });
    for (let index = 0; index < 3; index += 1) {
      assert.ok(stream.emit(input({ refs: { generationLeaseId: `lease-${index}` } })));
    }
    clock.runAll();
    // Delivery did not wait for the listener: the batch was handed over
    // before the first rejection could run.
    assert.equal(asyncCalls, 3);
    assert.deepEqual(healthy, [1, 2, 3]);
    assert.equal(stream.getStats().subscriberFailures, 0, "nothing was awaited");
    await settled();
    const failed = stream.getStats();
    assert.deepEqual([failed.subscriberFailures, failed.subscribers], [1, 1], "three rejected promises, one failure, one subscriber left");
    assert.deepEqual(failed.failureDetails, [{ kind: "subscriber", message: "async observer failure" }]);
    for (let index = 3; index < 6; index += 1) {
      assert.ok(stream.emit(input({ refs: { generationLeaseId: `lease-${index}` } })), "the producer is unaffected");
    }
    clock.runAll();
    await settled();
    assert.equal(asyncCalls, 3, "the failed subscriber receives nothing further");
    assert.deepEqual(healthy, [1, 2, 3, 4, 5, 6]);
    assert.equal(stream.getStats().produced, 6, "a failure produces no event about itself");

    // A plain listener that returns a rejected promise, and one whose promise
    // rejects later: the same cut-off, each counted once.
    let returned = 0;
    stream.subscribe(() => {
      returned += 1;
      return Promise.reject(new Error("returned rejection"));
    });
    stream.emit(input({ refs: { generationLeaseId: "lease-6" } }));
    stream.emit(input({ refs: { generationLeaseId: "lease-7" } }));
    clock.runAll();
    await settled();
    assert.equal(returned, 2);
    stream.emit(input({ refs: { generationLeaseId: "lease-8" } }));
    clock.runAll();
    await settled();
    assert.equal(returned, 2);
    assert.deepEqual([stream.getStats().subscriberFailures, stream.getStats().subscribers], [2, 1]);
    assert.deepEqual(healthy, [1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // A listener that keeps working returns promises that resolve: it stays.
    const kept: number[] = [];
    stream.subscribe(async (delivery) => { if (delivery.kind === "event") kept.push(delivery.event.sequence); });
    stream.emit(input({ refs: { generationLeaseId: "lease-9" } }));
    clock.runAll();
    await settled();
    assert.deepEqual([kept, stream.getStats().subscriberFailures, stream.getStats().subscribers], [[10], 2, 2]);

    // The only subscriber fails asynchronously with a backlog: what was still
    // queued for it is dropped, nothing is retained and the timer is cancelled.
    const soleClock = new ManualRuntimeCriticalEventClock();
    const sole = new RuntimeCriticalEventStream({ clock: soleClock });
    sole.bind(SESSION);
    let soleCalls = 0;
    sole.subscribe(async () => {
      soleCalls += 1;
      throw new Error("x".repeat(400));
    });
    for (let index = 0; index < 40; index += 1) sole.emit(input({ refs: { generationLeaseId: `lease-${index}` } }));
    assert.equal(soleClock.runNext(), true);
    assert.equal(soleCalls, 32, "one batch");
    assert.equal(soleClock.pendingCount(), 1, "the next batch is scheduled");
    await settled();
    const alone = sole.getStats();
    assert.deepEqual([alone.subscriberFailures, alone.subscribers, alone.queueDepth, alone.discardedUndelivered, soleClock.pendingCount()],
      [1, 0, 0, 8, 0]);
    assert.equal(alone.failureDetails[0]!.message.length, RUNTIME_CRITICAL_EVENT_LIMITS.maxFailureDetailChars);
    assert.equal(soleCalls, 32);

    // A thenable whose "then" cannot even be read is a failure of its listener too.
    const hostileClock = new ManualRuntimeCriticalEventClock();
    const hostile = new RuntimeCriticalEventStream({ clock: hostileClock });
    hostile.bind(SESSION);
    let hostileCalls = 0;
    hostile.subscribe((() => {
      hostileCalls += 1;
      return Object.defineProperty({}, "then", { get() { throw new Error("then cannot be read"); } });
    }) as never);
    hostile.emit(input());
    hostile.emit(input({ refs: { generationLeaseId: "lease-2" } }));
    assert.doesNotThrow(() => hostileClock.runAll());
    assert.deepEqual([hostileCalls, hostile.getStats().subscriberFailures, hostile.getStats().subscribers], [1, 1, 0]);

    await settled();
    assert.deepEqual(unhandled, [], "every rejection was handled by the event layer");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("AE5 a session change discards what was still queued for the ended session: its observer receives one closed marker with the reason and the discarded count, never a fact of the ended session after the new session is bound, and an unmount delivers no marker", () => {
  const closedMarker = (reason: string, lastSequence: number, discarded: number) =>
    ({ kind: "closed", schemaVersion: 1, runtimeSessionId: "session-old", reason, lastSequence, discarded });
  const observed = (limits?: Partial<RuntimeCriticalEventLimits>) => {
    const clock = new ManualRuntimeCriticalEventClock();
    const stream = new RuntimeCriticalEventStream({ clock, limits });
    stream.bind("session-old");
    const all: RuntimeCriticalEventDelivery[] = [];
    const afterRebind: RuntimeCriticalEventDelivery[] = [];
    const state = { rebound: false };
    stream.subscribe((delivery) => {
      all.push(delivery);
      if (state.rebound) afterRebind.push(delivery);
    });
    const emitOld = (count: number, from = 0) => {
      for (let index = 0; index < count; index += 1) {
        stream.emit(input({ runtimeSessionId: "session-old", refs: { generationLeaseId: `old-${from + index}` } }));
      }
    };
    const rebind = () => {
      assert.equal(stream.bind("session-new"), true);
      state.rebound = true;
    };
    return { clock, stream, all, afterRebind, emitOld, rebind };
  };

  // 70 facts of the old session, one batch delivered, then the session changes.
  const backlog = observed();
  backlog.emitOld(70);
  assert.equal(backlog.clock.runNext(), true);
  assert.equal(backlog.all.length, 32, "one batch was delivered while the session was the current one");
  backlog.rebind();
  assert.equal(backlog.stream.getStats().queueDepth, 1, "the 38 undelivered events are gone at once; only the marker waits");
  const fresh: RuntimeCriticalEventDelivery[] = [];
  backlog.stream.subscribe((delivery) => { fresh.push(delivery); });
  assert.equal(backlog.stream.emit(input({ runtimeSessionId: "session-new" }))?.sequence, 1);
  backlog.clock.runAll();
  assert.deepEqual(backlog.afterRebind, [closedMarker("session-rebound", 70, 38)],
    "after the new session was bound the old observer was handed the closed marker and nothing else");
  assert.equal(backlog.all.length, 33);
  assert.deepEqual(fresh.map((delivery) => delivery.kind === "event" && [delivery.event.runtimeSessionId, delivery.event.sequence]),
    [["session-new", 1]], "the new session's observer sees its own facts only");
  const stats = backlog.stream.getStats();
  assert.deepEqual([stats.discardedUndelivered, stats.subscribers, stats.queueDepth, stats.boundSessionId], [38, 1, 0, "session-new"]);

  // Nothing was queued: the marker says so.
  const drained = observed();
  drained.emitOld(3);
  drained.clock.runAll();
  drained.rebind();
  drained.clock.runAll();
  assert.deepEqual(drained.afterRebind, [closedMarker("session-rebound", 3, 0)]);

  // Stop first, then the session changes before the stopped run's queue was
  // delivered. The marker keeps the reason that ended the subscription first,
  // and counts what the session change discarded. Facts produced after Stop
  // were never queued for the stopped run.
  const stopped = observed();
  stopped.emitOld(5);
  assert.equal(stopped.stream.closeSubscriptions("meeting-assistant-stopped"), true);
  stopped.emitOld(2, 5);
  stopped.rebind();
  stopped.clock.runAll();
  assert.deepEqual(stopped.all, [closedMarker("meeting-assistant-stopped", 5, 5)]);
  assert.equal(stopped.stream.getStats().subscribers, 0);

  // A gap marker that was still queued stood for facts the observer was never
  // told about: they are counted too.
  const gapped = observed({ queueCapacity: 4 });
  gapped.emitOld(10);
  assert.deepEqual([gapped.stream.getStats().queueDepth, gapped.stream.getStats().overflowDropped], [5, 6]);
  gapped.rebind();
  gapped.clock.runAll();
  assert.deepEqual(gapped.all, [closedMarker("session-rebound", 10, 10)], "four events and the six of the gap marker");
  assert.equal(gapped.stream.getStats().discardedUndelivered, 4, "four events were in the queue");

  // Two session changes before any delivery: each ended session keeps its own marker.
  const twice = observed();
  twice.emitOld(2);
  twice.rebind();
  const second: RuntimeCriticalEventDelivery[] = [];
  twice.stream.subscribe((delivery) => { second.push(delivery); });
  twice.stream.emit(input({ runtimeSessionId: "session-new" }));
  twice.stream.bind("session-third");
  twice.clock.runAll();
  assert.deepEqual(twice.all, [closedMarker("session-rebound", 2, 2)]);
  assert.deepEqual(second, [{ ...closedMarker("session-rebound", 1, 1), runtimeSessionId: "session-new" }]);

  // An unmount ends the subscription with nothing: no fact and no closed marker.
  const unmounted = observed();
  unmounted.emitOld(3);
  unmounted.stream.release("meeting-hook-unmounted");
  unmounted.clock.runAll();
  assert.deepEqual(unmounted.all, [], "no closed marker is delivered on unmount");
  assert.deepEqual([unmounted.stream.getStats().subscribers, unmounted.stream.getStats().discardedUndelivered], [0, 3]);
});
