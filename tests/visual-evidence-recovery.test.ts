import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeVisualRecoveryCommit,
  createAwaitingVisualEvidenceRecoveryFact,
  decideVisualRecoveryPostCommitRebase,
  projectBoundVisualRecoveryApplication,
  resolveBoundVisualRecoveryRelation,
  resolveSourceLinkageFallback,
  selectVisualRecoveryOpportunity,
  upsertVisualRecoveryOpportunity,
} from "../src/lib/meeting/visual-evidence-recovery.js";

const resolution = {
  state: "awaiting-evidence" as const,
  awaitingVisualEvidence: true,
  evidence: ["question-references-code-lines"],
};

test("selects the current recovery owner and rejects a replaced owner", () => {
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

  const authorized = selectVisualRecoveryOpportunity({
    facts: [fact],
    sessionId: "session-1",
    runtimeEpoch: 4,
    topology: { parentId: "parent-coding", currentLogicalQuestionUnitId: "question-lines" },
    manualCorrectionRevision: 0,
    now: 500,
  });
  const stale = selectVisualRecoveryOpportunity({
    facts: [fact],
    sessionId: "session-1",
    runtimeEpoch: 4,
    topology: { parentId: "different-parent", currentLogicalQuestionUnitId: "different-question" },
    manualCorrectionRevision: 0,
    now: 500,
  });

  assert.equal(authorized.fact, fact);
  assert.equal(stale.fact, undefined);
  assert.deepEqual(stale.expiredFactIds, [fact.id]);
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
    facts: [fact],
    sessionId: "session-1",
    runtimeEpoch: 4,
    topology: { parentId: "parent-coding", currentLogicalQuestionUnitId: "question-lines" },
  };
  assert.equal(
    selectVisualRecoveryOpportunity({
      ...base,
      manualCorrectionRevision: 1,
      now: 1_101,
    }).fact,
    undefined
  );
  assert.equal(
    selectVisualRecoveryOpportunity({
      ...base,
      manualCorrectionRevision: 2,
      now: 500,
    }).fact,
    undefined
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
    selectVisualRecoveryOpportunity({
      facts: [fact],
      sessionId: "session-1",
      runtimeEpoch: 4,
      topology: { currentLogicalQuestionUnitId: "question-lines" },
      manualCorrectionRevision: 0,
      now: 200,
    }).fact,
    fact
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

test("keeps a parent opportunity suspended under a child and resumes it later", () => {
  const parent = createAwaitingVisualEvidenceRecoveryFact({
    resolution,
    sessionId: "session-1",
    runtimeEpoch: 4,
    logicalQuestionUnitId: "question-parent-lines",
    logicalQuestionRevision: 1,
    answerRevision: 0,
    visibleAnswerRevision: 2,
    parentTaskId: "parent-coding",
    parentRevision: 3,
    ownerKind: "parent",
    ownerBranchId: "parent-coding",
    questionType: "coding",
    questionText: "Explain lines 35 through 38.",
    sourceHash: "voice-source",
    manualCorrectionRevision: 0,
    createdAt: 100,
  });
  assert.ok(parent);
  const facts = upsertVisualRecoveryOpportunity(new Map(), parent);

  const underChild = selectVisualRecoveryOpportunity({
    facts: facts.values(),
    sessionId: "session-1",
    runtimeEpoch: 4,
    manualCorrectionRevision: 0,
    topology: {
      parentId: "parent-coding",
      parentQuestionType: "coding",
      childId: "child-field",
      childQuestionType: "field-knowledge",
    },
    screenQuestionType: "coding",
    now: 200,
  });
  assert.equal(underChild.fact?.id, parent.id);
  assert.equal(underChild.reason, "screen-type-parent-owner");
  assert.deepEqual(
    resolveBoundVisualRecoveryRelation({
      fact: parent,
      topology: {
        parentId: "parent-coding",
        childId: "child-field",
      },
    }),
    {
      authorized: true,
      relation: "resume-parent",
      reason: "bound-parent-resumed",
      ownerBranchId: "parent-coding",
    }
  );

  const afterResume = selectVisualRecoveryOpportunity({
    facts: facts.values(),
    sessionId: "session-1",
    runtimeEpoch: 4,
    manualCorrectionRevision: 0,
    topology: {
      parentId: "parent-coding",
      parentQuestionType: "coding",
    },
    now: 300,
  });
  assert.equal(afterResume.fact?.id, parent.id);
  const resumedParentRelation = resolveBoundVisualRecoveryRelation({
    fact: parent,
    topology: { parentId: "parent-coding" },
  });
  assert.equal(resumedParentRelation.authorized, true);
  assert.equal(
    resumedParentRelation.authorized
      ? resumedParentRelation.relation
      : undefined,
    "followup-parent"
  );
});

test("prefers the active child opportunity and expires removed owners", () => {
  const child = createAwaitingVisualEvidenceRecoveryFact({
    resolution,
    sessionId: "session-1",
    runtimeEpoch: 4,
    logicalQuestionUnitId: "question-child-lines",
    logicalQuestionRevision: 1,
    answerRevision: 0,
    visibleAnswerRevision: 3,
    parentTaskId: "parent-coding",
    parentRevision: 4,
    ownerKind: "child",
    ownerBranchId: "child-coding",
    questionType: "coding",
    questionText: "Explain the child implementation.",
    sourceHash: "child-source",
    manualCorrectionRevision: 0,
    createdAt: 100,
  });
  assert.ok(child);

  const selected = selectVisualRecoveryOpportunity({
    facts: [child],
    sessionId: "session-1",
    runtimeEpoch: 4,
    manualCorrectionRevision: 0,
    topology: {
      parentId: "parent-coding",
      childId: "child-coding",
    },
    now: 200,
  });
  assert.equal(selected.reason, "active-child-owner");
  const childRelation = resolveBoundVisualRecoveryRelation({
    fact: child,
    topology: {
      parentId: "parent-coding",
      childId: "child-coding",
    },
  });
  assert.equal(childRelation.authorized, true);
  assert.equal(
    childRelation.authorized ? childRelation.relation : undefined,
    "child-probe"
  );

  const removed = selectVisualRecoveryOpportunity({
    facts: [child],
    sessionId: "session-1",
    runtimeEpoch: 4,
    manualCorrectionRevision: 0,
    topology: { parentId: "parent-coding" },
    now: 300,
  });
  assert.equal(removed.fact, undefined);
  assert.deepEqual(removed.expiredFactIds, [child.id]);
});

test("projects the same exact recovery application for every bind-voice entry", () => {
  const parent = createAwaitingVisualEvidenceRecoveryFact({
    resolution,
    sessionId: "session-1",
    runtimeEpoch: 4,
    logicalQuestionUnitId: "question-parent-lines",
    logicalQuestionRevision: 1,
    answerRevision: 0,
    visibleAnswerRevision: 2,
    parentTaskId: "parent-coding",
    parentRevision: 3,
    ownerKind: "parent",
    ownerBranchId: "parent-coding",
    questionType: "coding",
    questionText: "Explain lines 35 through 38.",
    sourceHash: "parent-source",
    manualCorrectionRevision: 0,
    createdAt: 100,
  });
  assert.ok(parent);

  const application = projectBoundVisualRecoveryApplication({
    fact: parent,
    topology: { parentId: "parent-coding" },
  });
  assert.equal(application.applied, true);
  assert.equal(application.exactVisualEvidenceRecovery, true);
  assert.equal(application.relation, "followup-parent");
  assert.equal(application.branchRelation.reason, "bound-parent-preserved");

  const currentQuestion = createAwaitingVisualEvidenceRecoveryFact({
    resolution,
    sessionId: "session-1",
    runtimeEpoch: 4,
    logicalQuestionUnitId: "question-current-lines",
    logicalQuestionRevision: 1,
    answerRevision: 0,
    visibleAnswerRevision: 0,
    ownerKind: "current-question",
    ownerBranchId: "question-current-lines",
    questionType: "coding",
    questionText: "Explain the visible code.",
    sourceHash: "current-source",
    manualCorrectionRevision: 0,
    createdAt: 100,
  });
  assert.ok(currentQuestion);
  const currentApplication = projectBoundVisualRecoveryApplication({
    fact: currentQuestion,
    topology: {
      currentLogicalQuestionUnitId: "question-current-lines",
    },
  });
  assert.equal(currentApplication.applied, true);
  assert.equal(currentApplication.exactVisualEvidenceRecovery, true);
  assert.equal(currentApplication.relation, undefined);
  assert.equal(
    currentApplication.branchRelation.reason,
    "owner-current-question-has-no-durable-relation"
  );
  assert.equal(
    projectBoundVisualRecoveryApplication({
      fact: currentQuestion,
      topology: { currentLogicalQuestionUnitId: "question-newer" },
    }).applied,
    false
  );
});

test("uses Question Type only for the Source Linkage failure fallback", () => {
  assert.equal(
    resolveSourceLinkageFallback({
      voiceQuestionType: "coding",
      screenQuestionType: "coding",
    }),
    "bind-voice"
  );
  assert.equal(
    resolveSourceLinkageFallback({
      voiceQuestionType: "coding",
      screenQuestionType: "behavioral",
    }),
    "use-screen"
  );
  assert.equal(
    resolveSourceLinkageFallback({
      voiceQuestionType: "coding",
      screenQuestionType: "unknown",
    }),
    "bind-voice"
  );
});
