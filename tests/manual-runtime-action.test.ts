import assert from "node:assert/strict";
import test from "node:test";
import {
  createManualRuntimeActionEvent,
  decideManualRuntimeActionIngress,
  manualRuntimeActionEventIsReplayInput,
} from "../src/lib/meeting/manual-runtime-action.js";

test("creates a requested manual action without an injected target", () => {
  const event = createManualRuntimeActionEvent({
    actionId: "manual-action-1",
    action: "force-advise",
    stage: "requested",
    runtimeSessionId: "meeting-1",
    runtimeEpoch: 3,
    occurredAt: 100,
  });

  assert.equal(event.schemaVersion, 1);
  assert.equal(event.uiSurface, "meeting-response-actions");
  assert.equal(event.occurredAt, 100);
  assert.equal(event.observedLogicalQuestionUnitId, undefined);
  assert.equal(manualRuntimeActionEventIsReplayInput(event), true);
});

test("keeps resolved identity on terminal evidence only", () => {
  const event = createManualRuntimeActionEvent({
    actionId: "manual-action-2",
    action: "enhance-context",
    stage: "terminal",
    runtimeSessionId: "meeting-1",
    runtimeEpoch: 3,
    traceId: "trace-2",
    observedLogicalQuestionUnitId: "lqu-2",
    observedLogicalQuestionUnitRevision: 4,
    observedTaskId: "parent-2",
    observedVisibleAnswerRevision: 7,
    terminalDisposition: "stale",
    reason: "source-hash-mismatch",
    occurredAt: 200,
  });

  assert.equal(event.terminalDisposition, "stale");
  assert.equal(event.observedLogicalQuestionUnitId, "lqu-2");
  assert.equal(manualRuntimeActionEventIsReplayInput(event), false);
});

test("keeps presentation availability separate from runtime authorization", () => {
  assert.deepEqual(
    decideManualRuntimeActionIngress({
      action: "next-phase",
      busy: true,
      hasMeetingContext: true,
      hasVisibleAnswer: true,
      hasActiveTask: true,
    }),
    { authorized: false, reason: "meeting-busy" }
  );
  assert.deepEqual(
    decideManualRuntimeActionIngress({
      action: "enhance-context",
      busy: false,
      hasMeetingContext: true,
      hasVisibleAnswer: false,
      hasActiveTask: true,
    }),
    { authorized: false, reason: "no-visible-answer" }
  );
  assert.deepEqual(
    decideManualRuntimeActionIngress({
      action: "regenerate",
      busy: false,
      hasMeetingContext: false,
      hasVisibleAnswer: false,
      hasActiveTask: false,
    }),
    { authorized: false, reason: "no-meeting-context" }
  );
  assert.deepEqual(
    decideManualRuntimeActionIngress({
      action: "force-advise",
      busy: true,
      hasMeetingContext: false,
      hasVisibleAnswer: false,
      hasActiveTask: false,
    }),
    { authorized: true }
  );
});
