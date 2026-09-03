import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  authorizeAnswerGenerationLease,
  createAnswerGenerationLease,
  rebaseAnswerGenerationLeaseAfterOwnedParentMutation,
} from "../src/lib/meeting/answer-generation-lease.js";
import { decideSameOwnerAnswerCommitRebase } from "../src/lib/meeting/same-owner-answer-commit-rebase.js";
import {
  authorizeRuntimeCommit,
  createRuntimeCommitToken,
  rebaseRuntimeCommitToken,
} from "../src/lib/meeting/runtime-commit-authorization.js";
import {
  authorizeSettledAdvisorExecutionPlan,
  buildSettledAdvisorExecutionPlan,
  rebaseSettledAdvisorExecutionPlanAfterOwnedParentMutation,
} from "../src/lib/meeting/settled-advisor-execution-plan.js";
import type {
  ActiveMeetingTask,
  MeetingTaskRuntimeState,
} from "../src/lib/meeting/active-meeting-task.js";
import type { CurrentQuestionSettlementDecision } from "../src/lib/meeting/current-question-settlement.js";
import type { MeetingModelProviderSnapshot } from "../src/lib/meeting/meeting-model-route.js";
import type { StableAnswerRevision } from "../src/lib/meeting/stable-answer.js";

test("rebases only one same-owner Stable Answer continuity commit", () => {
  const expected = task(1);
  const current = task(2, {
    updatedAt: 130,
    latestUsefulAnswer: "A concise answer summary.",
  });
  const decision = decideSameOwnerAnswerCommitRebase({
    expectedTask: expected,
    currentTask: current,
    expectedTaskRuntimeRevision: 4,
    currentTaskRuntime: runtime(5),
    stableAnswer: stable(),
    sessionId: "session-1",
    runtimeEpoch: 2,
    logicalQuestionUnitId: "lqu-followup",
    jobScheduledAt: 100,
  });

  assert.equal(decision.authorized, true);
  assert.equal(decision.reason, "authorized");
  assert.equal(decision.currentParentRevision, 2);
});

test("rebases token, plan, and generation lease as one consumer transaction", () => {
  const expected = task(1);
  expected.runtimeRevision = 4;
  expected.parent.sourceQuestionUnitId = "lqu-parent";
  expected.parent.sourceQuestionRevision = 1;
  expected.parent.settlementId = "settlement-parent";
  const current = task(2, {
    updatedAt: 130,
    latestUsefulAnswer: "A concise answer summary.",
  });
  current.runtimeRevision = 5;
  current.parent.sourceQuestionUnitId = "lqu-parent";
  current.parent.sourceQuestionRevision = 1;
  current.parent.settlementId = "settlement-parent";
  const currentQuestionSettlement = settlement();
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: currentQuestionSettlement,
    activeMeetingTask: expected,
    taskBoundaryCommitted: false,
    childOwnsResponse: false,
    providerSnapshot: providers,
    memoryUseCase: "behavioral_interview",
    askFrame: "past-project",
    topicDomain: "backend",
    sourceQuestion: "What did you do, and what was the outcome?",
    createdAt: 100,
  });
  const generationLease = createAnswerGenerationLease({
    sessionId: "session-1",
    runtimeEpoch: 2,
    preparationContextRevision: 0,
    taskId: "parent-1",
    taskRevision: 1,
    logicalQuestionUnitId: "lqu-followup",
    logicalQuestionRevision: 1,
    baseVisibleAnswerRevision: 1,
    sourceTurnIds: ["turn-followup"],
    manualCorrectionRevision: 0,
    responseActionRevision: 0,
    modelRoute: "main",
    artifactOwnerId: "parent-1",
    requestedArtifacts: ["answer"],
    startedAt: 100,
  });
  const runtimeToken = createRuntimeCommitToken({
    operationId: "advisor-followup",
    pipeline: "advisor",
    snapshot: {
      runtimeEpoch: 2,
      sessionId: "session-1",
      parentId: "parent-1",
      parentRevision: 1,
    },
  });
  const currentSnapshot = {
    runtimeEpoch: 2,
    sessionId: "session-1",
    parentId: "parent-1",
    parentRevision: 2,
  };

  assert.equal(
    authorizeRuntimeCommit({
      token: runtimeToken,
      current: currentSnapshot,
      currentOperationId: "advisor-followup",
    }).reason,
    "parent-revision-mismatch"
  );
  assert.equal(
    authorizeSettledAdvisorExecutionPlan({
      plan,
      currentSettlement: currentQuestionSettlement,
      currentSessionId: "session-1",
      currentRuntimeEpoch: 2,
      currentLogicalQuestionUnitId: "lqu-followup",
      currentLogicalQuestionRevision: 1,
      currentSourceHash: "source-followup",
      currentActiveMeetingTask: current,
    }).reason,
    "expected-parent-revision-mismatch"
  );
  assert.equal(
    authorizeAnswerGenerationLease(generationLease, {
      sessionId: "session-1",
      runtimeEpoch: 2,
      preparationContextRevision: 0,
      taskId: "parent-1",
      taskRevision: 2,
      logicalQuestionUnitId: "lqu-followup",
      logicalQuestionRevision: 1,
      visibleAnswerRevision: 2,
      manualCorrectionRevision: 0,
      responseActionRevision: 0,
      artifactOwnerId: "parent-1",
      authorizedArtifacts: ["answer"],
    }).reason,
    "task-revision-mismatch"
  );

  const decision = decideSameOwnerAnswerCommitRebase({
    expectedTask: expected,
    currentTask: current,
    expectedTaskRuntimeRevision: 4,
    currentTaskRuntime: runtime(5),
    stableAnswer: stable(),
    sessionId: "session-1",
    runtimeEpoch: 2,
    logicalQuestionUnitId: "lqu-followup",
    jobScheduledAt: 100,
  });
  const rebasedPlan =
    rebaseSettledAdvisorExecutionPlanAfterOwnedParentMutation({
      plan,
      activeMeetingTask: current,
    });
  const rebasedGenerationLease =
    rebaseAnswerGenerationLeaseAfterOwnedParentMutation({
      lease: generationLease,
      taskId: "parent-1",
      taskRevision: 2,
      visibleAnswerRevision: 2,
      expectedVisibleAnswerRevisionDelta: 1,
    });
  const rebasedRuntimeToken = rebaseRuntimeCommitToken({
    token: runtimeToken,
    snapshot: currentSnapshot,
  });

  assert.equal(decision.authorized, true);
  assert.ok(rebasedPlan);
  assert.ok(rebasedGenerationLease);
  assert.deepEqual(rebasedGenerationLease.requestedArtifacts, ["answer"]);
  assert.equal(
    authorizeRuntimeCommit({
      token: rebasedRuntimeToken,
      current: currentSnapshot,
      currentOperationId: "advisor-followup",
    }).authorized,
    true
  );
  assert.equal(
    authorizeSettledAdvisorExecutionPlan({
      plan: rebasedPlan,
      currentSettlement: currentQuestionSettlement,
      currentSessionId: "session-1",
      currentRuntimeEpoch: 2,
      currentLogicalQuestionUnitId: "lqu-followup",
      currentLogicalQuestionRevision: 1,
      currentSourceHash: "source-followup",
      currentActiveMeetingTask: current,
    }).authorized,
    true
  );
  assert.equal(
    authorizeAnswerGenerationLease(rebasedGenerationLease, {
      sessionId: "session-1",
      runtimeEpoch: 2,
      preparationContextRevision: 0,
      taskId: "parent-1",
      taskRevision: 2,
      logicalQuestionUnitId: "lqu-followup",
      logicalQuestionRevision: 1,
      visibleAnswerRevision: 2,
      manualCorrectionRevision: 0,
      responseActionRevision: 0,
      artifactOwnerId: "parent-1",
      authorizedArtifacts: ["answer"],
    }).authorized,
    true
  );
});

test("rejects phase, child, Screen, and project drift", () => {
  const mutations: Array<{
    apply: (value: ActiveMeetingTask) => void;
    reason: "owner-mismatch" | "semantic-task-drift";
  }> = [
    {
      apply: (value) => {
        value.parent.playbookPhase = "implementation_validation";
      },
      reason: "semantic-task-drift",
    },
    {
      apply: (value) => {
        value.child = {
          id: "child-1",
          createdAt: 100,
          updatedAt: 100,
          questionType: "coding",
          relation: "child-probe",
          intent: "implementation-probe",
          question: "Implement it.",
          basedOnTurnIds: ["turn-child"],
          basedOnObservationIds: [],
        };
      },
      reason: "owner-mismatch",
    },
    {
      apply: (value) => {
        value.screen = {
          activeScreenTaskId: "screen-task",
          observationId: "screen-2",
          basedOnObservationId: "screen-2",
        };
      },
      reason: "semantic-task-drift",
    },
    {
      apply: (value) => {
        value.parent.projectBinding = {
          projectId: "project-2",
          projectName: "Other project",
          primaryEntryId: "entry-2",
          evidenceEntryIds: ["entry-2"],
          source: "user-selection",
          confidence: 1,
          lockedAt: 120,
          revision: 1,
          reason: "test mutation",
        };
      },
      reason: "semantic-task-drift",
    },
  ];

  for (const mutation of mutations) {
    const current = task(2, { updatedAt: 130 });
    mutation.apply(current);
    assert.equal(
      decideSameOwnerAnswerCommitRebase({
        expectedTask: task(1),
        currentTask: current,
        expectedTaskRuntimeRevision: 4,
        currentTaskRuntime: runtime(5),
        stableAnswer: stable(),
        sessionId: "session-1",
        runtimeEpoch: 2,
        logicalQuestionUnitId: "lqu-followup",
        jobScheduledAt: 100,
      }).reason,
      mutation.reason
    );
  }
});

test("rejects stale receipts, multiple revisions, and another branch", () => {
  assert.equal(
    decideSameOwnerAnswerCommitRebase({
      expectedTask: task(1),
      currentTask: task(3),
      expectedTaskRuntimeRevision: 4,
      currentTaskRuntime: runtime(6),
      stableAnswer: stable(),
      sessionId: "session-1",
      runtimeEpoch: 2,
      logicalQuestionUnitId: "lqu-followup",
      jobScheduledAt: 100,
    }).reason,
    "not-single-answer-commit"
  );

  const otherBranch = task(2);
  otherBranch.child = {
    id: "child-2",
    createdAt: 100,
    updatedAt: 100,
    questionType: "coding",
    relation: "child-probe",
    intent: "implementation-probe",
    question: "Implement it.",
    basedOnTurnIds: ["turn-child"],
    basedOnObservationIds: [],
  };
  assert.equal(
    decideSameOwnerAnswerCommitRebase({
      expectedTask: task(1),
      currentTask: otherBranch,
      expectedTaskRuntimeRevision: 4,
      currentTaskRuntime: runtime(5),
      stableAnswer: stable(),
      sessionId: "session-1",
      runtimeEpoch: 2,
      logicalQuestionUnitId: "lqu-followup",
      jobScheduledAt: 100,
    }).reason,
    "owner-mismatch"
  );
});

test("keeps the rebase behind the exact parent revision rejection", () => {
  const hook = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
  const start = hook.indexOf("const trySameOwnerAnswerCommitRebase");
  const end = hook.indexOf("const terminalizeAuthorizationRejection", start);
  const implementation = hook.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(
    hook,
    /decision\.reason === "parent-revision-mismatch"[\s\S]*trySameOwnerAnswerCommitRebase\(stage\)/
  );
  assert.match(
    implementation,
    /rebaseSettledAdvisorExecutionPlanAfterOwnedParentMutation/
  );
  assert.match(
    implementation,
    /rebaseAnswerGenerationLeaseAfterOwnedParentMutation/
  );
  assert.match(
    implementation,
    /formatSameOwnerAnswerCommitRebaseForTrace\([\s\S]*durationMs[\s\S]*stage/
  );
});

function task(
  revisions: number,
  overrides: { updatedAt?: number; latestUsefulAnswer?: string } = {}
): ActiveMeetingTask {
  return {
    id: "parent-1",
    runtimeRevision: revisions,
    source: "voice",
    parent: {
      id: "parent-1",
      questionType: "behavioral",
      topic: "Tell me about a time you went above and beyond.",
      playbookPhase: "story_selection",
      phaseProgress: {},
      supportedFactAnchors: [],
      latestUsefulAnswer: overrides.latestUsefulAnswer,
      createdAt: 80,
      updatedAt: overrides.updatedAt ?? 90,
      canonicalQuestionSourceTurnIds: ["turn-parent"],
      revisions,
    },
  };
}

function runtime(revision: number): MeetingTaskRuntimeState {
  return {
    revision,
    lastMutation: {
      id: "mutation-answer",
      kind: "commit-transition",
      reason: "advisor-answer-continuity-committed",
      appliedAt: 120,
    },
  };
}

function stable(): StableAnswerRevision {
  return {
    revision: 2,
    sessionId: "session-1",
    runtimeEpoch: 2,
    taskId: "parent-1",
    logicalQuestionUnitId: "lqu-initial",
    logicalQuestionRevision: 1,
    suggestion: {
      id: "answer-1",
      kind: "answer",
      content: "Answer",
      createdAt: 120,
      basedOnTurnIds: ["turn-parent"],
      basedOnObservationIds: [],
      confidence: "medium",
      parentTaskId: "parent-1",
    },
    sections: {
      answer: section(),
      code: section(0),
      complexity: section(0),
      whiteboard: section(0),
    },
    committedAt: 121,
  };
}

function section(revision = 1) {
  return {
    revision,
    ownerId: "parent-1",
    sourceSuggestionId: "answer-1",
    updatedAt: 121,
  };
}

const providers: MeetingModelProviderSnapshot = {
  providers: [{ id: "main", curl: "https://main.test" }],
  selectedProvider: { provider: "main", variables: {} },
  codingProvider: { provider: "main", variables: {} },
};

function settlement(): CurrentQuestionSettlementDecision {
  return {
    settlementId: "settlement-followup",
    logicalQuestionUnitId: "lqu-followup",
    revision: 1,
    sessionId: "session-1",
    runtimeEpoch: 2,
    sourceKind: "voice",
    sourceTurnIds: ["turn-followup"],
    sourceObservationIds: [],
    sourceHash: "source-followup",
    questionType: "behavioral",
    relation: "followup-parent",
    action: "answer",
    evidenceMode: "personal-experience",
    authority: "runtime-adjudication",
    authoritySource: "runtime-adjudication",
    typeAuthoritySource: "runtime-adjudication",
    relationAuthoritySource: "runtime-adjudication",
    actionAuthoritySource: "runtime-adjudication",
    typeMutationAuthorized: false,
    relationMutationAuthorized: false,
    parentMutationAuthorized: false,
    responseAuthorized: true,
    confidence: 0.95,
    manualCorrectionRevision: 0,
    rejectedProposals: [],
    reasons: ["same-parent-followup"],
  };
}
