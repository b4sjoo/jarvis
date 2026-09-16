import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_MEETING_FOCUS_SNAPSHOT as empty,
  MEETING_FOCUS_ACTION_EVENT as actionEvent,
  MEETING_FOCUS_SNAPSHOT_EVENT as snapshotEvent,
  type MeetingFocusSnapshotEnvelope,
  type MeetingFocusWindowKind,
} from "../src/lib/meeting/focus-window.js";
import { createMeetingFocusConsumer, createMeetingFocusPublisher, type MeetingFocusTransport } from "../src/lib/meeting/focus-window-protocol.js";
import { createMeetingFocusDisplayModel } from "../src/lib/meeting/focus-display.js";
import { formatChineseThinkingText, normalizeMeetingMarkdown } from "../src/lib/meeting/meeting-display-text.js";

class Bus {
  listeners = new Map<string, Set<(value: unknown) => void>>();
  messages: { event: string; payload: any }[] = [];
  sent: { event: string; payload: any }[] = [];
  async listen(event: string, receive: (value: unknown) => void) {
    const handlers = this.listeners.get(event) ?? new Set();
    handlers.add(receive); this.listeners.set(event, handlers);
    return () => { handlers.delete(receive); };
  }
  async emit(event: string, payload: unknown) {
    const message = { event, payload: JSON.parse(JSON.stringify(payload)) };
    this.messages.push(message); this.sent.push(message);
  }
  deliver(index = 0) {
    const [message] = this.messages.splice(index, 1);
    assert.ok(message, "transport message must exist");
    this.listeners.get(message.event)?.forEach((receive) => receive(message.payload));
    return message;
  }
  drain() {
    let count = 0;
    while (this.messages.length) { assert.ok(++count < 100, "no protocol feedback loop"); this.deliver(); }
  }
  endpoint(receiveEvent: string, emitEvent: string): MeetingFocusTransport {
    return { subscribe: (receive) => this.listen(receiveEvent, receive), send: (payload) => this.emit(emitEvent, payload) };
  }
}
const fail = (error: Error) => { throw error; };

test("Focus carries the original Type Correction request identity to the main window", async () => {
  const bus = new Bus(), p = publisher(bus), c = consumer(bus, "controls");
  await p.start(); await c.start(); await p.publish({ ...empty, active: true }); bus.drain();
  await c.dispatch({ type: "correct-question-type", correctedType: "coding", source: "focus-mode",
    actionId: "focus-click-1", requestedAt: 123 });
  bus.drain();
  assert.deepEqual(p.actions, [{ type: "correct-question-type", correctedType: "coding", source: "focus-mode",
    actionId: "focus-click-1", requestedAt: 123 }]);
});

test("audio warning is display-only and survives the independent Focus transport", async () => {
  const bus = new Bus(), p = publisher(bus), c = consumer(bus, "controls");
  await p.start(); await c.start();
  await p.publish(createMeetingFocusDisplayModel({ ...empty,
    audioInputWarning: { label: "Checking audio input", detail: "Actual signal is required." },
  }));
  bus.drain();
  assert.deepEqual(c.received.at(-1)?.payload.audioInputWarning,
    { label: "Checking audio input", detail: "Actual signal is required." });
  assert.equal(p.actions.length, 0);
});
function consumer(bus: Bus | MeetingFocusTransport, windowKind: MeetingFocusWindowKind = "answer") {
  const received: MeetingFocusSnapshotEnvelope[] = [];
  const errors: Error[] = [];
  const rejected: string[] = [];
  const adapter = createMeetingFocusConsumer({ transport: bus instanceof Bus ? bus.endpoint(snapshotEvent, actionEvent) : bus, windowKind,
    onSnapshot: (value) => received.push(value), onError: (error) => errors.push(error),
    observe: (event) => { if (event.event === "rejected") rejected.push(event.reason!); },
  });
  return { ...adapter, received, errors, rejected };
}
function publisher(bus: Bus, publisherInstanceId = "publisher-A") {
  const actions: unknown[] = [];
  const adapter = createMeetingFocusPublisher({ transport: bus.endpoint(actionEvent, snapshotEvent), publisherInstanceId,
    onAction: (action) => actions.push(action), onError: fail });
  return { ...adapter, actions };
}

test("real adapters wait for listener registration; dispose late registration without a request", async () => {
  const bus = new Bus();
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const delayed: MeetingFocusTransport = { send: (payload) => bus.emit(actionEvent, payload), subscribe: async (handler) => {
    await ready; return bus.listen(snapshotEvent, handler);
  } };
  const a = consumer(delayed);
  const starting = a.start();
  assert.equal(bus.sent.length, 0);
  release(); await starting;
  assert.equal(bus.sent.length, 1);
  assert.equal(bus.sent[0].payload.type, "request-snapshot");
  a.dispose();
  assert.equal(bus.listeners.get(snapshotEvent)?.size, 0);
  const b = consumer(delayed); const second = b.start(); b.dispose(); await second;
  assert.equal(bus.sent.length, 1);
  assert.equal(bus.listeners.get(snapshotEvent)?.size, 0);
});

test("request before first projection gets one correlated response, ACK is explicit and independent per window", async () => {
  const bus = new Bus(), p = publisher(bus), a = consumer(bus), c = consumer(bus, "controls");
  await p.start(); await a.start(); await c.start(); bus.drain();
  assert.equal(a.received.length, 0);
  await p.publish(empty); bus.drain();
  assert.equal(a.received.length, 1); assert.equal(c.received.length, 1);
  assert.equal(p.getLatestApplied("answer"), undefined);
  const published = bus.sent.filter((m) => m.event === snapshotEvent).length;
  a.applied(a.received[0]); bus.drain();
  assert.equal(p.getLatestApplied("answer")?.sequence, 1);
  assert.equal(p.getLatestApplied("controls"), undefined);
  c.applied(c.received[0]); bus.drain();
  assert.equal(p.getLatestApplied("controls")?.sequence, 1);
  a.applied(a.received[0]); bus.drain();
  assert.equal(bus.sent.filter((m) => m.event === snapshotEvent).length, published);
  assert.equal(p.actions.length, 0);
});

test("out-of-order and duplicate broadcasts cannot replace current controls or answer; no ACK gating", async () => {
  const bus = new Bus(), p = publisher(bus), a = consumer(bus);
  await p.start(); await p.publish(empty); await a.start(); bus.drain();
  await p.publish({ ...empty, latestTurnText: "second" });
  await p.publish({ ...empty, latestTurnText: "third", audioControl: { ...empty.audioControl, label: "Resume" } });
  const latest = bus.deliver(1); bus.deliver();
  await bus.emit(snapshotEvent, latest.payload); bus.drain();
  assert.equal(a.received.at(-1)?.sequence, 3);
  assert.equal(a.received.at(-1)?.payload.latestTurnText, "third");
  assert.equal(a.received.at(-1)?.payload.audioControl.label, "Resume");
  assert.equal(p.getLatestApplied("answer"), undefined);
  assert.ok(a.rejected.includes("stale-sequence"));
  a.applied(a.received[0]); bus.drain();
  assert.equal(p.getLatestApplied("answer"), undefined);
  a.applied(a.received.at(-1)!); bus.drain();
  assert.equal(p.getLatestApplied("answer")?.sequence, 3);
});

test("each publisher transition requires fresh request correlation and retired publishers stay rejected", async () => {
  const bus = new Bus(), p = publisher(bus), a = consumer(bus);
  await p.start(); await p.publish(empty); await a.start(); bus.drain();
  const old = { ...a.received[0], sequence: 500 };
  p.dispose();
  const q = publisher(bus, "publisher-B"); await q.start();
  await q.publish({ ...empty, latestTurnText: "restart" });
  bus.deliver();
  assert.equal(a.received.at(-1)?.publisherInstanceId, "publisher-A");
  assert.equal(bus.messages[0].payload.publisherInstanceId, "publisher-B");
  bus.drain();
  assert.equal(a.received.at(-1)?.publisherInstanceId, "publisher-B");
  assert.equal(a.received.at(-1)?.sequence, 1);
  await bus.emit(snapshotEvent, old); bus.drain();
  assert.equal(a.received.at(-1)?.publisherInstanceId, "publisher-B");
  q.dispose();
  const r = publisher(bus, "publisher-C"); await r.start(); await r.publish(empty); bus.drain();
  assert.equal(a.received.at(-1)?.publisherInstanceId, "publisher-C");
  assert.ok(a.rejected.includes("retired-publisher"));
});

test("late initialization response cannot steal a newer candidate; remount ignores old response and ACK", async () => {
  const bus = new Bus(), p = publisher(bus), a = consumer(bus);
  await p.start(); await p.publish(empty); bus.drain(); await a.start();
  bus.deliver(); const oldResponse = bus.messages.shift()!;
  p.dispose(); const q = publisher(bus, "publisher-B"); await q.start(); await q.publish(empty);
  bus.deliver(); // Candidate B prompts its own request.
  await bus.emit(snapshotEvent, oldResponse.payload); bus.deliver(1);
  assert.equal(a.received.length, 0);
  bus.drain(); assert.equal(a.received.at(-1)?.publisherInstanceId, "publisher-B");
  a.applied(a.received.at(-1)!); const oldAck = bus.messages.shift()!;
  a.dispose(); const remount = consumer(bus); await remount.start(); bus.drain();
  await bus.emit(snapshotEvent, oldResponse.payload);
  await bus.emit(actionEvent, oldAck.payload); bus.drain();
  assert.equal(q.getLatestApplied("answer"), undefined);
  remount.applied(remount.received.at(-1)!); bus.drain();
  assert.equal(q.getLatestApplied("answer")?.sequence, 1);
});

test("version, malformed payload, listen and send errors are explicit, retaining last accepted state", async () => {
  const bus = new Bus(), p = publisher(bus), a = consumer(bus);
  await p.start(); await p.publish(empty); await a.start(); bus.drain();
  await bus.emit(snapshotEvent, { ...a.received[0], schemaVersion: 99 });
  await bus.emit(snapshotEvent, { ...a.received[0], sequence: 2, payload: { sections: null } }); bus.drain();
  assert.equal(a.received.length, 1); assert.equal(a.errors.length, 2);
  assert.match(a.errors[0].message, /Reopen Focus/);
  const broken = consumer({ subscribe: async () => { throw Error("listen failed"); }, send: (payload) => bus.emit(actionEvent, payload) });
  await assert.rejects(broken.start(), /listen failed/);
  assert.equal(broken.errors.length, 1);
  const sendFailure = consumer({ subscribe: (receive) => bus.listen(snapshotEvent, receive), send: async () => { throw Error("send failed"); } });
  await sendFailure.start(); await Promise.resolve();
  assert.equal(sendFailure.errors[0].message, "send failed");
});

test("all existing user intents reach the original handler unchanged; protocol actions do not", async () => {
  const bus = new Bus(), p = publisher(bus), a = consumer(bus);
  await p.start(); await a.start(); bus.drain();
  const actions = [
    { type: "toggle-listening" }, { type: "regenerate" }, { type: "force-advise" }, { type: "capture-screen" },
    { type: "submit-correction", correction: "RAG not rec" }, { type: "deactivate-correction", correctionId: "term-1" },
    { type: "correct-question-type", correctedType: "coding", source: "focus-mode" },
    { type: "update-interview-types", interviewTypes: ["coding"] },
    { type: "clarifying-answer", answer: "option", option: { label: "A", value: "a" } },
    { type: "new-task" }, { type: "same-task" }, { type: "dismiss-clarifying-question" },
  ] as const;
  for (const action of actions) await bus.emit(actionEvent, action);
  await a.dispatch({ type: "regenerate" }); bus.drain();
  assert.deepEqual(p.actions, [...actions, { type: "regenerate" }]);
});

test("display whitelist freezes a detached serializable DTO without full runtime state or nested secrets", () => {
  const input = { ...empty, providerSecret: "secret", sections: { ...empty.sections, parsedAnswer: { raw: "secret" } },
    factGuardrailNotice: { kind: "generic-hypothetical-fallback" as const, message: "Use as hypothetical", private: "secret" },
    manualQuestionTypeCorrection: { taskId: "task", questionId: "question", correctedType: "coding" as const, status: "pending" as const, regenerationStatus: "running" as const, sourceObservationIds: ["private"] },
  };
  const display = createMeetingFocusDisplayModel(input);
  assert.ok(Object.isFrozen(display.sections));
  assert.equal(display.factGuardrailNotice?.message, "Use as hypothetical");
  input.sections.primaryAnswer = "changed later";
  assert.equal(display.sections.primaryAnswer, "");
  assert.doesNotMatch(JSON.stringify(display), /secret|private|providerSecret|parsedAnswer|sourceObservationIds/);
  assert.throws(() => createMeetingFocusDisplayModel({ ...empty, latestTurnText: 7 } as any));
});

test("shared text formatting retains fenced code and the established main-window math normalization", () => {
  assert.equal(formatChineseThinkingText("  一\r\n\n 二  "), "一\n二");
  assert.equal(normalizeMeetingMarkdown("$\\mathrm{n} \\leq 3$\n```ts\nconst cost = '$x$';\n```"), "n <= 3\n```ts\nconst cost = '$x$';\n```");
});

test("latest ACK rejects future sequence, duplicate, old request and schema without publishing", async () => {
  const bus = new Bus(), p = publisher(bus), a = consumer(bus);
  await p.start(); await p.publish(empty); await a.start(); bus.drain();
  a.applied(a.received[0]); bus.drain();
  const ack = p.getLatestApplied("answer")!;
  const count = bus.sent.filter(m => m.event === snapshotEvent).length;
  for (const patch of [{}, { sequence: 999 }, { sequence: 0 }, { requestId: "old-window" }, { publisherInstanceId: "old-publisher" }]) {
    await bus.emit(actionEvent, { ...ack, ...patch }); bus.drain();
    assert.deepEqual(p.getLatestApplied("answer"), ack);
  }
  assert.equal(bus.sent.filter(m => m.event === snapshotEvent).length, count);
  assert.deepEqual(p.actions, []);
  await bus.emit(actionEvent, { ...ack, schemaVersion: 99 });
  assert.throws(() => bus.drain(), /Unsupported Focus snapshot version/);
  assert.deepEqual(p.getLatestApplied("answer"), ack);
});

test("newer broadcast received during publisher handshake is applied only after valid confirmation", async () => {
  const bus = new Bus(), p = publisher(bus), a = consumer(bus);
  await p.start(); await p.publish(empty); await a.start(); bus.drain(); p.dispose();
  const q = publisher(bus, "B"); await q.start(); await q.publish({ ...empty, latestTurnText: "B first" });
  bus.deliver(); bus.deliver(); // Broadcast triggers request; response is now queued.
  await q.publish({ ...empty, latestTurnText: "B newer" });
  bus.deliver(1); // Newer broadcast overtakes the correlated response.
  assert.equal(a.received.at(-1)?.publisherInstanceId, "publisher-A");
  bus.deliver();
  assert.equal(a.received.at(-1)?.publisherInstanceId, "B");
  assert.equal(a.received.at(-1)?.sequence, 2);
  assert.equal(a.received.at(-1)?.payload.latestTurnText, "B newer");
  a.applied(a.received.at(-1)!); bus.drain();
  assert.equal(q.getLatestApplied("answer")?.sequence, 2);
});

test("fixed partial sequence measures local projection/transport cost and bounded ACK count", async (t) => {
  const bus = new Bus(), p = publisher(bus), a = consumer(bus), c = consumer(bus, "controls");
  await p.start(); await p.publish(empty); await a.start(); await c.start(); bus.drain();
  a.applied(a.received.at(-1)!); c.applied(c.received.at(-1)!); bus.drain();
  bus.sent = [];
  let legacyBytes = 0;
  const start = performance.now();
  for (let i = 1; i <= 32; i++) {
    const snapshot = { ...empty, latestTurnText: `turn ${i}`, sections: { ...empty.sections, primaryAnswer: "partial ".repeat(i * 32) } };
    legacyBytes += Buffer.byteLength(JSON.stringify(snapshot)) * 2;
    await p.publish(snapshot); bus.drain();
    a.applied(a.received.at(-1)!); c.applied(c.received.at(-1)!); bus.drain();
  }
  const elapsedMs = performance.now() - start;
  const publications = bus.sent.filter(m => m.event === snapshotEvent);
  const acks = bus.sent.filter(m => m.payload.type === "snapshot-applied");
  assert.equal(publications.length, 32); assert.equal(acks.length, 64);
  assert.equal(a.received.at(-1)?.sequence, 33); assert.equal(c.received.at(-1)?.sequence, 33);
  const bytes = bus.sent.reduce((total,m) => total + Buffer.byteLength(JSON.stringify(m.payload)), 0);
  t.diagnostic(JSON.stringify({ samples:32, legacySnapshotMessages:64, snapshotMessages:publications.length,
    ackMessages:acks.length, legacyPayloadBytes:legacyBytes, protocolPayloadBytes:bytes,
    projectionAndLocalTransportMs: Math.round(elapsedMs*100)/100 }));
});
