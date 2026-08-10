import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeAnswerGenerationLease,
  authorizeRuntimeTypeRepairOutputAuthority,
  createAnswerGenerationLease,
  createRuntimeTypeRepairOutputAuthority,
  decideRefreshAuthority,
  formatAnswerGenerationLeaseForTrace,
} from "../src/lib/meeting/answer-generation-lease.js";
import { decideAdvisorTurnIntent } from "../src/lib/meeting/advisor-turn-intent.js";
import type { CurrentQuestionSettlementDecision } from "../src/lib/meeting/current-question-settlement.js";

test("grants refresh authority to substantive turns and explicit actions", () => {
  const substantive = decideRefreshAuthority({
    source: "live-turn",
    turnIntentDecision: decideAdvisorTurnIntent(
      "Implement a queue using two stacks.",
      { hasActiveTask: false }
    ),
  });
  const manual = decideRefreshAuthority({
    source: "manual-correction",
  });

  assert.equal(substantive.authorized, true);
  assert.equal(substantive.kind, "automatic-substantive");
  assert.equal(substantive.hardOverride, false);
  assert.equal(manual.authorized, true);
  assert.equal(manual.kind, "manual-hard-override");
  assert.equal(manual.hardOverride, true);
});

test("does not let an acknowledgement supersede a valid generation", () => {
  const authority = decideRefreshAuthority({
    source: "live-turn",
    turnIntentDecision: decideAdvisorTurnIntent("Yeah, yeah.", {
      hasActiveTask: true,
    }),
  });

  assert.equal(authority.authorized, false);
  assert.equal(authority.kind, "denied");
  assert.equal(authority.maySupersedeGeneration, false);
});

test("does not let shadow fail-open become visible refresh authority", () => {
  const authority = decideRefreshAuthority({
    source: "live-turn",
    turnIntentDecision: decideAdvisorTurnIntent("Kubernetes.", {
      hasActiveTask: true,
    }),
  });

  assert.equal(authority.authorized, false);
  assert.equal(authority.kind, "denied");
  assert.equal(authority.reason, "shadow-fail-open-disallowed");
  assert.equal(authority.hardOverride, false);
  assert.equal(authority.maySupersedeGeneration, false);
});

test("grants action-only refresh authority to a released runtime intent answer", () => {
  const base = decideAdvisorTurnIntent("Kubernetes.", {
    hasActiveTask: true,
  });
  const authority = decideRefreshAuthority({
    source: "live-turn",
    turnIntentDecision: {
      ...base,
      action: "answer-refresh",
      recommendedAction: "answer-refresh",
      enforcement: "allow",
      wouldSuppress: false,
      executionAuthorized: true,
      authoritySource: "runtime-intent-gate",
    },
  });

  assert.equal(authority.authorized, true);
  assert.equal(authority.kind, "runtime-intent-answer");
  assert.equal(authority.hardOverride, false);
});

function buildTypeRepairSettlement(
  overrides: Partial<CurrentQuestionSettlementDecision> = {}
): CurrentQuestionSettlementDecision {
  return {
    settlementId: "settlement-a",
    logicalQuestionUnitId: "question-a",
    revision: 2,
    sessionId: "session-a",
    runtimeEpoch: 4,
    sourceHash: "source-a",
    questionType: "general-system-design",
    relation: "unknown",
    action: "answer",
    evidenceMode: "hypothetical-design",
    authority: "llm-type-repair",
    authoritySource: "llm-type-repair",
    typeAuthoritySource: "llm-type-repair",
    relationAuthoritySource: "provisional",
    actionAuthoritySource: "provisional",
    typeMutationAuthorized: true,
    relationMutationAuthorized: false,
    parentMutationAuthorized: false,
    responseAuthorized: true,
    confidence: 0.95,
    manualCorrectionRevision: 1,
    rejectedProposals: [],
    reasons: ["response-authorized"],
    ...overrides,
  };
}

test("turns an accepted type repair into one answer-only refresh authority", () => {
  const authority = createRuntimeTypeRepairOutputAuthority({
    operationId: "type-operation-a",
    settlement: buildTypeRepairSettlement(),
    manualCorrectionRevision: 1,
    createdAt: 100,
  });

  assert.ok(authority);
  assert.deepEqual(authority.authorizedArtifacts, ["answer"]);
  assert.equal(authority.typeAuthority, "llm-type-repair");
  const refresh = decideRefreshAuthority({
    source: "live-turn",
    turnIntentDecision: decideAdvisorTurnIntent("Kubernetes.", {
      hasActiveTask: true,
    }),
    runtimeTypeRepairOutputAuthority: authority,
  });
  assert.equal(refresh.authorized, true);
  assert.equal(refresh.kind, "runtime-type-repair");
  assert.equal(refresh.authorityId, authority.id);
});

test("rejects stale type-repair output authority and broader mutation", () => {
  const authority = createRuntimeTypeRepairOutputAuthority({
    operationId: "type-operation-a",
    settlement: buildTypeRepairSettlement(),
    manualCorrectionRevision: 1,
  });
  assert.ok(authority);
  assert.deepEqual(
    authorizeRuntimeTypeRepairOutputAuthority(authority, {
      settlementId: "settlement-a",
      sessionId: "session-a",
      runtimeEpoch: 4,
      logicalQuestionUnitId: "question-a",
      logicalQuestionRevision: 3,
      manualCorrectionRevision: 1,
    }),
    {
      authorized: false,
      reason: "logical-question-revision-mismatch",
    }
  );
  assert.equal(
    createRuntimeTypeRepairOutputAuthority({
      operationId: "type-operation-b",
      settlement: buildTypeRepairSettlement({
        relationMutationAuthorized: true,
      }),
      manualCorrectionRevision: 1,
    }),
    undefined
  );
});

function buildLease() {
  return createAnswerGenerationLease({
    sessionId: "session-a",
    runtimeEpoch: 4,
    preparationContextRevision: 7,
    taskId: "parent-a",
    taskRevision: 3,
    logicalQuestionUnitId: "question-a",
    logicalQuestionRevision: 2,
    baseVisibleAnswerRevision: 8,
    sourceTurnIds: ["turn-a", "turn-b"],
    manualCorrectionRevision: 1,
    responseActionRevision: 5,
    modelRoute: "coding-override:provider-a",
    artifactOwnerId: "parent-a",
    requestedArtifacts: ["answer", "code", "complexity"],
    startedAt: 100,
  });
}

function buildCurrentSnapshot() {
  return {
    sessionId: "session-a",
    runtimeEpoch: 4,
    preparationContextRevision: 7,
    taskId: "parent-a",
    taskRevision: 3,
    logicalQuestionUnitId: "question-a",
    logicalQuestionRevision: 2,
    visibleAnswerRevision: 8,
    manualCorrectionRevision: 1,
    responseActionRevision: 5,
    artifactOwnerId: "parent-a",
    authorizedArtifacts: ["answer", "code", "complexity"] as const,
  };
}

test("authorizes only the exact visible answer and question revision", () => {
  const lease = buildLease();
  const current = buildCurrentSnapshot();

  assert.equal(
    authorizeAnswerGenerationLease(lease, {
      ...current,
      authorizedArtifacts: [...current.authorizedArtifacts],
    }).authorized,
    true
  );
  assert.equal(
    authorizeAnswerGenerationLease(lease, {
      ...current,
      preparationContextRevision: 8,
      authorizedArtifacts: [...current.authorizedArtifacts],
    }).reason,
    "preparation-context-revision-mismatch"
  );
  assert.equal(
    authorizeAnswerGenerationLease(lease, {
      ...current,
      visibleAnswerRevision: 9,
      authorizedArtifacts: [...current.authorizedArtifacts],
    }).reason,
    "visible-answer-revision-mismatch"
  );
  assert.equal(
    authorizeAnswerGenerationLease(lease, {
      ...current,
      logicalQuestionRevision: 3,
      authorizedArtifacts: [...current.authorizedArtifacts],
    }).reason,
    "logical-question-revision-mismatch"
  );
});

test("rejects stale manual actions, task owners, and artifact authority", () => {
  const lease = buildLease();
  const current = buildCurrentSnapshot();

  assert.equal(
    authorizeAnswerGenerationLease(lease, {
      ...current,
      responseActionRevision: 6,
      authorizedArtifacts: [...current.authorizedArtifacts],
    }).reason,
    "response-action-revision-mismatch"
  );
  assert.equal(
    authorizeAnswerGenerationLease(lease, {
      ...current,
      taskId: "parent-b",
      artifactOwnerId: "parent-b",
      authorizedArtifacts: [...current.authorizedArtifacts],
    }).reason,
    "task-owner-mismatch"
  );
  const artifactDecision = authorizeAnswerGenerationLease(lease, {
    ...current,
    authorizedArtifacts: ["answer"],
  });
  assert.equal(artifactDecision.reason, "artifact-authority-revoked");
  assert.deepEqual(artifactDecision.rejectedArtifacts, [
    "code",
    "complexity",
  ]);
});

test("formats replay-safe lease metadata for stale commits", () => {
  const lease = buildLease();
  const authorization = authorizeAnswerGenerationLease(lease, {
    ...buildCurrentSnapshot(),
    visibleAnswerRevision: 9,
    authorizedArtifacts: ["answer", "code", "complexity"],
  });
  const metadata = formatAnswerGenerationLeaseForTrace(
    lease,
    authorization,
    "final-commit"
  );

  assert.equal(metadata.answerGenerationLeaseId, lease.id);
  assert.equal(
    metadata.answerGenerationLeasePreparationContextRevision,
    7
  );
  assert.equal(metadata.leaseAuthorizedAtCommit, false);
  assert.equal(metadata.staleCommitRejected, true);
  assert.equal(metadata.staleReason, "visible-answer-revision-mismatch");
  assert.equal(metadata.baseVisibleAnswerRevision, 8);
});
