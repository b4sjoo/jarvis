import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeAwaitingVisualEvidenceRecovery,
  createAwaitingVisualEvidenceRecoveryFact,
} from "../src/lib/meeting/visual-evidence-recovery.js";

const resolution = {
  state: "awaiting-evidence" as const,
  awaitingVisualEvidence: true,
  evidence: ["question-references-code-lines"],
};

test("authorizes only the exact next visual-evidence transaction", () => {
  const fact = createAwaitingVisualEvidenceRecoveryFact({
    resolution,
    sessionId: "session-1",
    runtimeEpoch: 4,
    logicalQuestionUnitId: "question-lines",
    logicalQuestionRevision: 2,
    answerRevision: 1,
    visibleAnswerRevision: 7,
    parentTaskId: "parent-coding",
    parentRevision: 3,
    sourceHash: "source-lines",
    sourceTurnIds: ["turn-lines"],
    manualCorrectionRevision: 0,
    createdAt: 100,
    ttlMs: 1_000,
  });
  assert.ok(fact);

  const authorized = authorizeAwaitingVisualEvidenceRecovery({
    fact,
    sessionId: "session-1",
    runtimeEpoch: 4,
    logicalQuestionUnitId: "question-lines",
    logicalQuestionRevision: 2,
    visibleAnswerRevision: 7,
    parentTaskId: "parent-coding",
    parentRevision: 3,
    sourceHash: "source-lines",
    manualCorrectionRevision: 0,
    now: 500,
  });
  const stale = authorizeAwaitingVisualEvidenceRecovery({
    fact,
    sessionId: "session-1",
    runtimeEpoch: 4,
    logicalQuestionUnitId: "question-lines",
    logicalQuestionRevision: 3,
    visibleAnswerRevision: 7,
    parentTaskId: "parent-coding",
    parentRevision: 3,
    sourceHash: "source-lines",
    manualCorrectionRevision: 0,
    now: 500,
  });

  assert.deepEqual(authorized, { authorized: true, reason: "authorized" });
  assert.deepEqual(stale, {
    authorized: false,
    reason: "logical-question-revision-mismatch",
  });
});

test("rejects expired or manually corrected recovery", () => {
  const fact = createAwaitingVisualEvidenceRecoveryFact({
    resolution,
    sessionId: "session-1",
    runtimeEpoch: 4,
    logicalQuestionUnitId: "question-lines",
    logicalQuestionRevision: 2,
    answerRevision: 1,
    visibleAnswerRevision: 7,
    parentTaskId: "parent-coding",
    parentRevision: 3,
    sourceHash: "source-lines",
    manualCorrectionRevision: 1,
    createdAt: 100,
    ttlMs: 1_000,
  });
  assert.ok(fact);

  const base = {
    fact,
    sessionId: "session-1",
    runtimeEpoch: 4,
    logicalQuestionUnitId: "question-lines",
    logicalQuestionRevision: 2,
    visibleAnswerRevision: 7,
    parentTaskId: "parent-coding",
    parentRevision: 3,
    sourceHash: "source-lines",
  };
  assert.equal(
    authorizeAwaitingVisualEvidenceRecovery({
      ...base,
      manualCorrectionRevision: 1,
      now: 1_101,
    }).reason,
    "expired"
  );
  assert.equal(
    authorizeAwaitingVisualEvidenceRecovery({
      ...base,
      manualCorrectionRevision: 2,
      now: 500,
    }).reason,
    "manual-correction-revision-mismatch"
  );
});
