import assert from "node:assert/strict";
import test from "node:test";
import { buildCompactTraceSummary } from "../src/lib/meeting/session-recording.js";
import type { MeetingTrace } from "../src/lib/meeting/types.js";

test("compacts clarifying selection authority and lifecycle metadata", () => {
  const trace: MeetingTrace = {
    id: "trace_clarifying",
    kind: "voice",
    status: "success",
    startedAt: 1_000,
    endedAt: 1_250,
    durationMs: 250,
    steps: [],
    inputs: [],
    outputs: [],
    metadata: {
      clarifyingRequestId: "clarifying_request_1",
      clarifyingQuestionKey: "question_1",
      clarifyingOptionSource: "project-binding",
      clarifyingOptionCount: 3,
      clarifyingBooleanFallbackUsed: false,
      clarifyingMisleadingBooleanFallbackPrevented: true,
      clarifyingSelectedLabel: "Agentic Memory",
      clarifyingSelectionState: "succeeded",
      clarifyingSelectionTerminalReason: "visible-answer-committed",
      clarifyingSelectionStartedAt: 1_050,
      clarifyingSelectionCompletedAt: 1_200,
    },
  };

  const summary = buildCompactTraceSummary({
    sessionId: "session_clarifying",
    trace,
    trigger: "manual",
    traceExportPath: "traces/trace_clarifying/trace.json",
    summaryPath: "traces/trace_clarifying/summary.json",
  });

  assert.deepEqual(summary.clarifyingInteraction, {
    requestId: "clarifying_request_1",
    questionKey: "question_1",
    optionSource: "project-binding",
    optionCount: 3,
    booleanFallbackUsed: false,
    misleadingBooleanFallbackPrevented: true,
    selectedLabel: "Agentic Memory",
    state: "succeeded",
    terminalReason: "visible-answer-committed",
    startedAt: 1_050,
    completedAt: 1_200,
  });
});
