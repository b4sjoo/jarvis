import assert from "node:assert/strict";
import test from "node:test";
import {
  attachQuestionLineageToSuggestion,
  createAuthorizedQuestionLineage,
  isCurrentQuestionLineage,
  promoteQuestionLineage,
} from "../src/lib/meeting/question-lineage.js";

test("creates provisional lineage only for an authorized answer refresh", () => {
  const lineage = createAuthorizedQuestionLineage({
    traceId: "trace_1",
    triggerTurnId: "turn_1",
    sessionId: "session_1",
    runtimeEpoch: 3,
    action: "answer-refresh",
    executionAuthorized: true,
  });

  assert.deepEqual(lineage, {
    questionInstanceId: "trace:trace_1",
    questionOriginTraceId: "trace_1",
    triggerTurnId: "turn_1",
    sessionId: "session_1",
    runtimeEpoch: 3,
    identityState: "provisional",
  });

  for (const action of ["ignore", "append-only", "state-update"] as const) {
    assert.equal(
      createAuthorizedQuestionLineage({
        traceId: "trace_1",
        triggerTurnId: "turn_1",
        sessionId: "session_1",
        runtimeEpoch: 3,
        action,
        executionAuthorized: true,
      }),
      undefined
    );
  }
});

test("keeps inherited lineage stable across answer actions", () => {
  const inherited = {
    questionInstanceId: "trace:trace_origin",
    questionOriginTraceId: "trace_origin",
    sourceSuggestionId: "suggestion_origin",
    sessionId: "session_1",
    runtimeEpoch: 2,
    identityState: "canonical" as const,
  };

  assert.deepEqual(
    createAuthorizedQuestionLineage({
      sessionId: "session_1",
      runtimeEpoch: 2,
      executionAuthorized: true,
      inherited,
    }),
    inherited
  );
});

test("binds lineage to the visible suggestion and validates runtime ownership", () => {
  const lineage = attachQuestionLineageToSuggestion(
    {
      questionInstanceId: "trace:trace_1",
      questionOriginTraceId: "trace_1",
      sessionId: "session_1",
      runtimeEpoch: 3,
      identityState: "provisional",
    },
    { id: "suggestion_1" }
  );
  const suggestion = {
    id: "suggestion_1",
    sourceTraceId: "trace_1",
    kind: "answer" as const,
    content: "Answer",
    createdAt: 1,
    basedOnTurnIds: [],
    basedOnObservationIds: [],
    confidence: "medium" as const,
    questionLineage: lineage,
  };

  assert.equal(
    isCurrentQuestionLineage({
      lineage,
      suggestion,
      sessionId: "session_1",
      runtimeEpoch: 3,
    }),
    true
  );
  assert.equal(
    isCurrentQuestionLineage({
      lineage,
      suggestion,
      sessionId: "session_1",
      runtimeEpoch: 4,
    }),
    false
  );
  assert.equal(promoteQuestionLineage(lineage)?.identityState, "canonical");
});
