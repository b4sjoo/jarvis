import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decideSameOwnerAnswerCommitRebase } from "../src/lib/meeting/same-owner-answer-commit-rebase.js";
import type {
  ActiveMeetingTask,
  MeetingTaskRuntimeState,
} from "../src/lib/meeting/active-meeting-task.js";
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
