import assert from "node:assert/strict";
import test from "node:test";
import {
  attachQuestionLineageToSuggestion,
  createAuthorizedQuestionLineage,
  isCurrentQuestionLineage,
  promoteQuestionLineage,
  resolveInheritedQuestionLineageForTurnIntent,
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

test("inherits provisional lineage only for explicitly scoped follow-ups", () => {
  const lineage = createAuthorizedQuestionLineage({
    traceId: "trace-origin",
    triggerTurnId: "turn-origin",
    sessionId: "session-a",
    runtimeEpoch: 1,
    action: "answer-refresh",
    executionAuthorized: true,
  });
  assert.ok(lineage);

  assert.equal(
    resolveInheritedQuestionLineageForTurnIntent(
      {
        intent: "correction",
        confidence: 0.96,
        evidence: ["explicit-correction"],
        action: "answer-refresh",
        recommendedAction: "answer-refresh",
        reason: "recent-question-correction",
        contextPromptEligible: true,
        enforcement: "allow",
        wouldSuppress: false,
        executionAuthorized: true,
        followupScopeSource: "provisional-question",
      },
      lineage
    ),
    lineage
  );
  assert.equal(
    resolveInheritedQuestionLineageForTurnIntent(
      {
        intent: "direct-question",
        confidence: 0.97,
        evidence: ["question-mark"],
        action: "answer-refresh",
        recommendedAction: "answer-refresh",
        reason: "direct-question-or-task",
        contextPromptEligible: true,
        enforcement: "allow",
        wouldSuppress: false,
        executionAuthorized: true,
      },
      lineage
    ),
    undefined
  );
});
