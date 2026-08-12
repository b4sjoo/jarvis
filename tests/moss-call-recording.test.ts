import assert from "node:assert/strict";
import test from "node:test";
import {
  ActiveCallRuntime,
  CallRecordingProjection,
  createSessionBoundRecordingWriter,
  type CallRecordingEvent,
  type CallRecordingStatus,
  type CallRecordingTransport,
} from "../src/lib/calling/index.js";

const openStatus = (callSessionId: string): CallRecordingStatus => ({
  callSessionId,
  recordingPath: `/recordings/${callSessionId}`,
  state: "open",
  attempt: 0,
  eventCount: 0,
  attemptedEventCount: 0,
  persistedEventCount: 0,
  droppedEventCount: 0,
  health: "healthy",
  incompletenessReasons: [],
  startedAt: 1,
});

test("recording projection serializes concurrent events without sequence gaps", async () => {
  let status = openStatus("call-recording-1");
  const events: CallRecordingEvent[] = [];
  const transport: CallRecordingTransport = {
    async start() {
      return structuredClone(status);
    },
    async append({ eventPayload }) {
      const event = JSON.parse(eventPayload) as CallRecordingEvent;
      assert.equal(event.sequence, status.eventCount + 1);
      await new Promise((resolve) => setTimeout(resolve, event.sequence === 1 ? 8 : 0));
      events.push(event);
      status = { ...status, eventCount: event.sequence };
      return structuredClone(status);
    },
    async close() {
      status = { ...status, state: "closed", attempt: status.attempt + 1 };
      return structuredClone(status);
    },
    async retry() {
      throw new Error("retry should not run");
    },
    async abandon() {
      throw new Error("abandon should not run");
    },
  };
  const recording = new CallRecordingProjection({
    callSessionId: status.callSessionId,
    transport,
  });
  await recording.start(1);
  await Promise.all([
    recording.append("audio-segment-observed", { segment: 1 }, 2),
    recording.append("audio-segment-settled", { segment: 1 }, 3),
    recording.append("runtime-command", { type: "SubmitTranscriptTurn" }, 4),
  ]);

  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
  assert.deepEqual(events.map((event) => event.kind), [
    "audio-segment-observed",
    "audio-segment-settled",
    "runtime-command",
  ]);
  assert.equal((await recording.close(5))?.state, "closed");
});

test("recording close remains retryable after a transport failure", async () => {
  let status = openStatus("call-recording-2");
  let closeAttempts = 0;
  const transport: CallRecordingTransport = {
    async start() {
      return structuredClone(status);
    },
    async append({ eventPayload }) {
      const event = JSON.parse(eventPayload) as CallRecordingEvent;
      status = { ...status, eventCount: event.sequence };
      return structuredClone(status);
    },
    async close() {
      closeAttempts += 1;
      status = {
        ...status,
        state: "close-failed",
        attempt: closeAttempts,
        lastError: "disk busy",
      };
      throw new Error("disk busy");
    },
    async retry() {
      closeAttempts += 1;
      status = {
        ...status,
        state: "closed",
        attempt: closeAttempts,
        lastError: undefined,
      };
      return structuredClone(status);
    },
    async abandon() {
      throw new Error("abandon should not run");
    },
  };
  const recording = new CallRecordingProjection({
    callSessionId: status.callSessionId,
    transport,
  });
  await recording.start(1);
  await recording.append("call-close-attempt", { retry: false }, 2);
  await assert.rejects(recording.close(3), /disk busy/);
  assert.equal((await recording.retryClose(4))?.state, "closed");
  assert.equal(closeAttempts, 2);
});

test("an append failure remains visible as incomplete after later events and close", async () => {
  let status = openStatus("call-recording-incomplete");
  let appendAttempts = 0;
  let closeCompleteness: unknown;
  const transport: CallRecordingTransport = {
    async start() {
      return structuredClone(status);
    },
    async append({ eventPayload }) {
      appendAttempts += 1;
      if (appendAttempts === 1) throw new Error("disk unavailable");
      const event = JSON.parse(eventPayload) as CallRecordingEvent;
      status = {
        ...status,
        eventCount: event.sequence,
        persistedEventCount: event.sequence,
      };
      return structuredClone(status);
    },
    async close(input) {
      closeCompleteness = input.completeness;
      status = {
        ...status,
        state: "closed",
        health: "incomplete",
        attemptedEventCount: input.completeness?.attemptedEventCount ?? 0,
        persistedEventCount: input.completeness?.persistedEventCount ?? 0,
        droppedEventCount: input.completeness?.droppedEventCount ?? 0,
        incompletenessReasons: input.completeness?.incompletenessReasons ?? [],
      };
      return structuredClone(status);
    },
    async retry() {
      throw new Error("retry should not run");
    },
    async abandon() {
      throw new Error("abandon should not run");
    },
  };
  const recording = new CallRecordingProjection({
    callSessionId: status.callSessionId,
    transport,
  });
  await recording.start(1);
  await assert.rejects(
    recording.append("audio-segment-observed", { segment: 1 }, 2),
    /disk unavailable/
  );
  await recording.append("audio-segment-observed", { segment: 2 }, 3);
  const closed = await recording.close(4);

  assert.equal(closed?.health, "incomplete");
  assert.equal(closed?.attemptedEventCount, 2);
  assert.equal(closed?.persistedEventCount, 1);
  assert.equal(closed?.droppedEventCount, 1);
  assert.match(JSON.stringify(closeCompleteness), /disk unavailable/);
});

test("session-bound writers cannot redirect a late event into a newer recording", async () => {
  const events = new Map<string, CallRecordingEvent[]>();
  const makeTransport = (callSessionId: string): CallRecordingTransport => {
    let status = openStatus(callSessionId);
    events.set(callSessionId, []);
    return {
      async start() {
        return structuredClone(status);
      },
      async append({ eventPayload }) {
        const event = JSON.parse(eventPayload) as CallRecordingEvent;
        events.get(callSessionId)?.push(event);
        status = {
          ...status,
          eventCount: event.sequence,
          persistedEventCount: event.sequence,
        };
        return structuredClone(status);
      },
      async close() {
        return { ...status, state: "closed" };
      },
      async retry() {
        return { ...status, state: "closed" };
      },
      async abandon() {
        return { ...status, state: "abandoned" };
      },
    };
  };
  const firstRecording = new CallRecordingProjection({
    callSessionId: "call-first",
    transport: makeTransport("call-first"),
  });
  const secondRecording = new CallRecordingProjection({
    callSessionId: "call-second",
    transport: makeTransport("call-second"),
  });
  await firstRecording.start(1);
  await secondRecording.start(2);
  const firstWriter = createSessionBoundRecordingWriter({
    recording: firstRecording,
  });
  const secondWriter = createSessionBoundRecordingWriter({
    recording: secondRecording,
  });

  await secondWriter.record("model-operation-dispatched", { operationId: "new" });
  await firstWriter.record("model-operation-returned", { operationId: "late-old" });

  assert.deepEqual(
    events.get("call-first")?.map((event) => event.payload),
    [{ operationId: "late-old" }]
  );
  assert.deepEqual(
    events.get("call-second")?.map((event) => event.payload),
    [{ operationId: "new" }]
  );
});

test("a full runtime lifecycle is reconstructable from transition events", () => {
  const transitions: string[] = [];
  const runtime = new ActiveCallRuntime({
    callSessionId: "call-lifecycle",
    createdAt: 1,
    onTransition: ({ command }) => transitions.push(command.type),
  });
  runtime.dispatch({ type: "StartCall", occurredAt: 2 });
  runtime.dispatch({ type: "CaptureStarted", occurredAt: 3 });
  runtime.dispatch({
    type: "SubmitTranscriptTurn",
    momentUnitId: "moment-1",
    turn: {
      id: "turn-1",
      speaker: "them",
      text: "Can you confirm the balance?",
      occurredAt: 4,
    },
  });
  runtime.dispatch({
    type: "ApplyRuntimeSettlement",
    settlement: {
      callSessionId: "call-lifecycle",
      momentUnitId: "moment-1",
      evidenceRevision: 1,
      disposition: "actionable",
      counterpartyMove: "question",
      phaseSignal: "hold",
      candidateUpdates: [],
      responseAuthorized: true,
      settledAt: 5,
    },
  });
  const envelope = runtime.selectOperation({
    operationId: "advisor-1",
    operationKind: "guidance",
    route: "advisor",
    contextSnapshotHash: "hash-1",
    timeoutMs: 1_000,
    input: {},
    occurredAt: 6,
  });
  runtime.commitGuidance({
    envelope,
    frame: {
      say: ["Confirm the balance shown in the account record."],
      ask: [],
      avoid: [],
      evidence: ["Counterparty asked for confirmation."],
      callState: "Balance confirmation",
      nextMove: "Wait for the counterparty response.",
    },
    occurredAt: 7,
  });
  runtime.dispatch({ type: "CloseCall", occurredAt: 8 });
  runtime.dispatch({ type: "CloseSucceeded", occurredAt: 9 });

  assert.deepEqual(transitions, [
    "StartCall",
    "CaptureStarted",
    "SubmitTranscriptTurn",
    "ApplyRuntimeSettlement",
    "SelectOperation",
    "RecordReceipt",
    "CommitGuidance",
    "CloseCall",
    "CloseSucceeded",
  ]);
  assert.equal(runtime.snapshot().state, "closed");
  assert.equal(runtime.snapshot().guidanceRevision, 1);
});

test("human evaluation is append-only for each visible guidance revision", () => {
  const runtime = new ActiveCallRuntime({
    callSessionId: "call-evaluation",
    createdAt: 1,
  });
  runtime.dispatch({ type: "StartCall", occurredAt: 2 });
  runtime.dispatch({ type: "CaptureStarted", occurredAt: 3 });
  runtime.dispatch({
    type: "SubmitTranscriptTurn",
    momentUnitId: "moment-1",
    turn: { id: "turn-1", speaker: "them", text: "Help?", occurredAt: 4 },
  });
  const envelope = runtime.selectOperation({
    operationId: "advisor-evaluation",
    operationKind: "guidance",
    route: "advisor",
    contextSnapshotHash: "hash",
    timeoutMs: 1_000,
    input: {},
  });
  runtime.commitGuidance({
    envelope,
    frame: {
      say: ["Ask what outcome they need."],
      ask: [],
      avoid: [],
      evidence: [],
      callState: "Clarification",
      nextMove: "Listen",
    },
    occurredAt: 5,
  });
  runtime.dispatch({
    type: "RecordHumanEvaluation",
    fact: {
      id: "evaluation-1",
      callSessionId: "call-evaluation",
      guidanceRevision: 1,
      label: "helpful",
      occurredAt: 6,
    },
  });
  runtime.dispatch({
    type: "RecordHumanEvaluation",
    fact: {
      id: "evaluation-2",
      callSessionId: "call-evaluation",
      guidanceRevision: 1,
      label: "not-useful",
      occurredAt: 7,
    },
  });
  assert.deepEqual(runtime.snapshot().humanEvaluations.map((fact) => fact.label), [
    "helpful",
  ]);
});
