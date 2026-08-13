import assert from "node:assert/strict";
import test from "node:test";
import { ActiveCallRuntime, createOperationLease, parseGuidanceFrame, parseRuntimeSettlement, resolveAdvisorAuthority } from "../src/lib/calling/index.js";

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

test("runtime owns Advisor authority when model fields contradict", () => {
  const runtime = new ActiveCallRuntime({ callSessionId: "call-1", createdAt: 1 });
  runtime.dispatch({ type: "StartCall", occurredAt: 2 });
  runtime.dispatch({ type: "CaptureStarted", occurredAt: 3 });
  runtime.dispatch({ type: "SubmitTranscriptTurn", momentUnitId: "m1", turn: { id: "t1", speaker: "them", text: "That is useful background.", occurredAt: 4 } });
  runtime.dispatch({
    type: "ApplyRuntimeSettlement",
    settlement: {
      callSessionId: "call-1",
      momentUnitId: "m1",
      evidenceRevision: 1,
      disposition: "context-only",
      counterpartyMove: "informational",
      phaseSignal: "hold",
      candidateUpdates: [],
      responseAuthorized: true,
      settledAt: 5,
    },
  });
  const settlement = runtime.snapshot().latestSettlement;
  assert.equal(settlement?.modelResponseAuthorized, true);
  assert.equal(settlement?.responseAuthorized, false);
  assert.equal(settlement?.advisorAuthorityNormalized, true);
  assert.equal(settlement?.advisorAuthorityReason, "context-only-disposition");
});

test("runtime authorizes actionable evidence despite a negative model recommendation", () => {
  const decision = resolveAdvisorAuthority({
    callSessionId: "call-1",
    momentUnitId: "m1",
    evidenceRevision: 1,
    disposition: "actionable",
    counterpartyMove: "request",
    phaseSignal: "hold",
    candidateUpdates: [],
    responseAuthorized: false,
    settledAt: 5,
  });
  assert.deepEqual(decision, {
    modelRequested: false,
    responseAuthorized: true,
    normalized: true,
    reason: "actionable-disposition",
  });
});

test("transition observer rebinding is single-owner and stale detach is harmless", () => {
  const runtime = new ActiveCallRuntime({ callSessionId: "call-1", createdAt: 1 });
  const observed: string[] = [];
  const first = runtime.bindTransitionObserver("recording:call-1", () => {
    observed.push("first");
  });
  const second = runtime.bindTransitionObserver("recording:call-1", () => {
    observed.push("second");
  });
  assert.equal(first.detach(), false);
  runtime.dispatch({ type: "StartCall", occurredAt: 2 });
  assert.deepEqual(observed, ["second"]);
  assert.equal(second.detach(), true);
  runtime.dispatch({ type: "CaptureStarted", occurredAt: 3 });
  assert.deepEqual(observed, ["second"]);
});
