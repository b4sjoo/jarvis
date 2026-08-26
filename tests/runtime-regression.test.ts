import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeRegressionRunRecord,
  createRuntimeRegressionStepEvent,
} from "../src/lib/meeting/runtime-regression.js";

test("creates a forced manual replay run contract", () => {
  assert.deepEqual(
    createRuntimeRegressionRunRecord({
      scenarioRunId: "run-1",
      runtimeSessionId: "meeting-1",
      startedAt: 100,
    }),
    {
      schemaVersion: 1,
      scenarioRunId: "run-1",
      runtimeSessionId: "meeting-1",
      mode: "manual-replay",
      forcedScripted: true,
      status: "running",
      startedAt: 100,
      endedAt: undefined,
      reason: undefined,
    }
  );
});

test("creates append-only injected and terminal step events", () => {
  const injected = createRuntimeRegressionStepEvent({
    scenarioRunId: "run-1",
    scenarioStepId: "step-1",
    ordinal: 1,
    event: "injected",
    inputKind: "them-text",
    runtimeSessionId: "meeting-1",
    traceId: "trace-1",
    textChars: 24,
    sourceHash: "source-1",
    occurredAt: 110,
  });
  const terminal = createRuntimeRegressionStepEvent({
    ...injected,
    event: "terminal",
    terminalDisposition: "visible",
    settlementId: "settlement-1",
    executionPlanId: "plan-1",
    visibleAnswerRevision: 2,
    occurredAt: 120,
  });

  assert.equal(injected.schemaVersion, 1);
  assert.equal(injected.event, "injected");
  assert.equal(terminal.event, "terminal");
  assert.equal(terminal.terminalDisposition, "visible");
  assert.equal(terminal.visibleAnswerRevision, 2);
});
