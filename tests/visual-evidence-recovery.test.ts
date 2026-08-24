import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeAwaitingVisualEvidenceRecovery,
  authorizeVisualRecoveryCommit,
  createAwaitingVisualEvidenceRecoveryFact,
  decideVisualRecoveryPostCommitRebase,
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

test("allows a pre-answer recovery fact before a parent exists", () => {
  const fact = createAwaitingVisualEvidenceRecoveryFact({
    resolution,
    sessionId: "session-1",
    runtimeEpoch: 4,
    logicalQuestionUnitId: "question-lines",
    logicalQuestionRevision: 1,
    answerRevision: 0,
    visibleAnswerRevision: 2,
    sourceHash: "voice-source",
    sourceSettlementId: "voice-settlement",
    manualCorrectionRevision: 0,
    createdAt: 100,
  });

  assert.ok(fact);
  assert.equal(fact.parentTaskId, undefined);
  assert.equal(fact.sourceSettlementId, "voice-settlement");
  assert.equal(
    authorizeAwaitingVisualEvidenceRecovery({
      fact,
      sessionId: "session-1",
      runtimeEpoch: 4,
      logicalQuestionUnitId: "question-lines",
      logicalQuestionRevision: 1,
      visibleAnswerRevision: 2,
      manualCorrectionRevision: 0,
      now: 200,
    }).authorized,
    true
  );
});

test("rebases recovery authority only across its own same-parent visible commit", () => {
  const rebased = decideVisualRecoveryPostCommitRebase({
    sourceKind: "voice",
    logicalQuestionUnitId: "question-lines",
    logicalQuestionRevision: 2,
    parentTaskId: "parent-coding",
    parentRevision: 5,
    stableLogicalQuestionUnitId: "question-lines",
    stableLogicalQuestionRevision: 2,
    stableTaskId: "parent-coding",
    activeParentId: "parent-coding",
    activeParentRevision: 6,
  });
  const unrelated = decideVisualRecoveryPostCommitRebase({
    sourceKind: "voice",
    logicalQuestionUnitId: "question-lines",
    logicalQuestionRevision: 2,
    parentTaskId: "parent-coding",
    parentRevision: 5,
    stableLogicalQuestionUnitId: "question-other",
    stableLogicalQuestionRevision: 2,
    stableTaskId: "parent-coding",
    activeParentId: "parent-coding",
    activeParentRevision: 6,
  });

  assert.deepEqual(rebased, {
    disposition: "rebased",
    reason: "owned-parent-revision-advanced",
    parentRevision: 6,
  });
  assert.deepEqual(unrelated, {
    disposition: "rejected",
    reason: "logical-question-mismatch",
  });
});

test("reports the exact post-commit recovery authorization facet", () => {
  const base = {
    sourceKind: "voice" as const,
    sessionId: "session-1",
    currentSessionId: "session-1",
    runtimeEpoch: 4,
    currentRuntimeEpoch: 4,
    manualCorrectionRevision: 1,
    currentManualCorrectionRevision: 1,
    logicalQuestionUnitId: "question-lines",
    currentLogicalQuestionUnitId: "question-lines",
    logicalQuestionRevision: 2,
    currentLogicalQuestionRevision: 2,
    visibleAnswerRevision: 7,
    currentVisibleAnswerRevision: 7,
    parentTaskId: "parent-coding",
    currentParentTaskId: "parent-coding",
    parentRevision: 6,
    currentParentRevision: 6,
  };

  assert.deepEqual(authorizeVisualRecoveryCommit(base), {
    authorized: true,
    reason: "authorized",
  });
  assert.deepEqual(
    authorizeVisualRecoveryCommit({
      ...base,
      currentParentRevision: 7,
    }),
    {
      authorized: false,
      reason: "parent-revision-mismatch",
    }
  );
});
