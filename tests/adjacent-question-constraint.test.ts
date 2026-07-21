import assert from "node:assert/strict";
import test from "node:test";
import {
  ADJACENT_QUESTION_SCOPE_TTL_MS,
  classifyAdjacentConstraintKinds,
  createAdjacentQuestionScope,
  resolveAdjacentConstraintInheritance,
} from "../src/lib/meeting/adjacent-question-constraint.js";

const lineage = {
  questionInstanceId: "trace:trace-question",
  questionOriginTraceId: "trace-question",
  triggerTurnId: "turn-question",
  sessionId: "session-a",
  runtimeEpoch: 3,
  identityState: "provisional" as const,
};

test("inherits explicit adjacent constraints within the bounded question scope", () => {
  const scope = createAdjacentQuestionScope({
    lineage,
    questionTurnId: "turn-question",
    questionTraceId: "trace-question",
    questionText: "Show me the sort method.",
    sessionId: "session-a",
    runtimeEpoch: 3,
    now: 1_000,
  });

  for (const [text, expectedKind] of [
    ["In Python.", "programming-language"],
    ["For 10 million users.", "scale"],
    ["Return the indices.", "output-format"],
    ["Without extra space.", "algorithm-constraint"],
  ] as const) {
    const decision = resolveAdjacentConstraintInheritance({
      scope,
      text,
      sessionId: "session-a",
      runtimeEpoch: 3,
      now: 3_000,
    });

    assert.equal(decision.inherited, true, text);
    assert.equal(decision.reason, "inherited-explicit-constraint", text);
    assert.ok(decision.constraintKinds.includes(expectedKind), text);
    assert.equal(decision.lineage?.questionInstanceId, lineage.questionInstanceId);
    assert.equal(decision.deltaMs, 2_000);
  }
});

test("does not promote filler or arbitrary short technical fragments", () => {
  const scope = createAdjacentQuestionScope({
    lineage,
    questionTurnId: "turn-question",
    questionTraceId: "trace-question",
    questionText: "Show me the sort method.",
    sessionId: "session-a",
    runtimeEpoch: 3,
    now: 1_000,
  });

  for (const text of ["Good.", "Hmm.", "Let me see.", "Kubernetes."]) {
    const decision = resolveAdjacentConstraintInheritance({
      scope,
      text,
      sessionId: "session-a",
      runtimeEpoch: 3,
      now: 2_000,
    });
    assert.equal(decision.inherited, false, text);
    assert.equal(decision.reason, "no-explicit-constraint", text);
  }
});

test("rejects stale, cross-session, and overlong constraint inheritance", () => {
  const scope = createAdjacentQuestionScope({
    lineage,
    questionTurnId: "turn-question",
    questionTraceId: "trace-question",
    questionText: "Show me the sort method.",
    sessionId: "session-a",
    runtimeEpoch: 3,
    now: 1_000,
  });

  assert.equal(
    resolveAdjacentConstraintInheritance({
      scope,
      text: "In Python.",
      sessionId: "session-b",
      runtimeEpoch: 3,
      now: 2_000,
    }).reason,
    "session-mismatch"
  );
  assert.equal(
    resolveAdjacentConstraintInheritance({
      scope,
      text: "In Python.",
      sessionId: "session-a",
      runtimeEpoch: 4,
      now: 2_000,
    }).reason,
    "runtime-epoch-mismatch"
  );
  assert.equal(
    resolveAdjacentConstraintInheritance({
      scope,
      text: "In Python.",
      sessionId: "session-a",
      runtimeEpoch: 3,
      now: 1_000 + ADJACENT_QUESTION_SCOPE_TTL_MS + 1,
    }).reason,
    "scope-expired"
  );
  assert.equal(
    resolveAdjacentConstraintInheritance({
      scope,
      text: `In Python ${"with another unnecessary condition ".repeat(8)}`,
      sessionId: "session-a",
      runtimeEpoch: 3,
      now: 2_000,
    }).reason,
    "constraint-too-long"
  );
});

test("classifies only the supported explicit constraint families", () => {
  assert.deepEqual(classifyAdjacentConstraintKinds("Use Java and return indices"), [
    "programming-language",
    "output-format",
  ]);
  assert.deepEqual(classifyAdjacentConstraintKinds("Sounds good"), []);
});
