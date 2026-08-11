import assert from "node:assert/strict";
import test from "node:test";
import { ActiveCallRuntime, createOperationLease, parseGuidanceFrame, parseRuntimeSettlement } from "../src/lib/calling/index.js";

test("ActiveCallRuntime is the single writer for a complete call lifecycle", () => {
  const runtime = new ActiveCallRuntime({ callSessionId: "call-1", createdAt: 1 });
  runtime.dispatch({ type: "StartCall", occurredAt: 2 });
  runtime.dispatch({ type: "CaptureStarted", occurredAt: 3 });
  runtime.dispatch({ type: "SubmitTranscriptTurn", momentUnitId: "moment-1", turn: { id: "turn-1", speaker: "them", text: "Can you confirm the deadline?", occurredAt: 4 } });
  assert.equal(runtime.snapshot().state, "live");
  assert.equal(runtime.snapshot().evidenceRevision, 1);
  runtime.dispatch({ type: "PauseCall", occurredAt: 5 });
  assert.equal(runtime.snapshot().state, "paused");
  runtime.dispatch({ type: "ResumeCall", occurredAt: 6 });
  runtime.dispatch({ type: "CaptureStarted", occurredAt: 7 });
  assert.equal(runtime.snapshot().state, "live");
});

test("a newer transcript invalidates an older advisor lease", () => {
  const runtime = new ActiveCallRuntime({ callSessionId: "call-1", createdAt: 1 });
  runtime.dispatch({ type: "StartCall", occurredAt: 2 });
  runtime.dispatch({ type: "CaptureStarted", occurredAt: 3 });
  runtime.dispatch({ type: "SubmitTranscriptTurn", momentUnitId: "m1", turn: { id: "t1", speaker: "them", text: "First", occurredAt: 4 } });
  const envelope = runtime.selectOperation({ operationId: "advisor-1", operationKind: "guidance", route: "advisor", contextSnapshotHash: "h1", timeoutMs: 1_000, input: {} });
  runtime.dispatch({ type: "SubmitTranscriptTurn", momentUnitId: "m2", turn: { id: "t2", speaker: "them", text: "Second", occurredAt: 5 } });
  assert.equal(runtime.authorize(createOperationLease({ envelope }), "advisor").authorized, false);
});

test("guidance commits atomically only for its exact operation", () => {
  const runtime = new ActiveCallRuntime({ callSessionId: "call-1", createdAt: 1 });
  runtime.dispatch({ type: "StartCall", occurredAt: 2 });
  runtime.dispatch({ type: "CaptureStarted", occurredAt: 3 });
  runtime.dispatch({ type: "SubmitTranscriptTurn", momentUnitId: "m1", turn: { id: "t1", speaker: "them", text: "What is the deadline?", occurredAt: 4 } });
  const envelope = runtime.selectOperation({ operationId: "advisor-1", operationKind: "guidance", route: "advisor", contextSnapshotHash: "h1", timeoutMs: 1_000, input: {} });
  const frame = { say: ["The current record shows Friday."], ask: [], avoid: [], evidence: ["Call note"], callState: "Deadline confirmation", nextMove: "Confirm timezone" };
  assert.equal(runtime.commitGuidance({ envelope, frame, occurredAt: 5 }).committed, true);
  assert.deepEqual(runtime.snapshot().visibleGuidance, frame);
});

test("model parsers enforce narrow MOSS contracts", () => {
  const settlement = parseRuntimeSettlement({ raw: '{"disposition":"actionable","counterpartyMove":"question","phaseSignal":"hold","responseAuthorized":true,"candidateUpdates":[]}', callSessionId: "c", momentUnitId: "m", evidenceRevision: 1, settledAt: 2 });
  assert.equal(settlement.counterpartyMove, "question");
  const frame = parseGuidanceFrame('{"say":["Confirm it."],"ask":[],"avoid":[],"evidence":[],"callState":"Verification","nextMove":"Wait"}');
  assert.equal(frame.say[0], "Confirm it.");
  assert.throws(() => parseGuidanceFrame('{"say":[],"ask":[],"avoid":[],"evidence":[],"callState":"","nextMove":""}'));
});
