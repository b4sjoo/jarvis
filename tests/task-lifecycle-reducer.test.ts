import assert from "node:assert/strict";
import test from "node:test";
import {
  buildActiveMeetingTask,
  type ActiveMeetingTask,
} from "../src/lib/meeting/active-meeting-task.js";
import type { CurrentQuestionSettlementDecision } from "../src/lib/meeting/current-question-settlement.js";
import type { MeetingModelProviderSnapshot } from "../src/lib/meeting/meeting-model-route.js";
import {
  authorizeSettledAdvisorExecutionPlan,
  buildSettledAdvisorExecutionPlan,
} from "../src/lib/meeting/settled-advisor-execution-plan.js";
import {
  createTaskLifecycleTransaction,
  reduceTaskLifecycleTransaction,
} from "../src/lib/meeting/task-lifecycle-reducer.js";
import type {
  ActiveInterviewParent,
  ActiveScreenTask,
  SelectedInterviewPlaybook,
} from "../src/lib/meeting/types.js";

const providers: MeetingModelProviderSnapshot = {
  providers: [
    { id: "main", curl: "https://main.test" },
    { id: "coding", curl: "https://coding.test" },
  ],
  selectedProvider: { provider: "main", variables: {} },
  codingProvider: { provider: "coding", variables: {} },
};

function parent(
  stableKind: ActiveInterviewParent["stableKind"],
  overrides: Partial<ActiveInterviewParent> = {}
): ActiveInterviewParent {
  return {
    id: "parent-a",
    source: "voice",
    stableKind,
    topic: "Design a ride-sharing system",
    playbookPhase:
      stableKind === "coding"
        ? "baseline_reasoning"
        : "requirement_clarification",
    phaseProgress: {},
    supportedFactAnchors: [],
    createdAt: 10,
    updatedAt: 20,
    revisions: 3,
    ...overrides,
  };
}

function screen(
  kind: ActiveScreenTask["kind"]
): ActiveScreenTask {
  return {
    id: "screen-a",
    observationId: "observation-a",
    createdAt: 10,
    updatedAt: 20,
    question:
      kind === "coding"
        ? "Implement Merge Sort"
        : "Design a ride-sharing system",
    kind,
    content: "",
    basedOnTurnIds: ["turn-a"],
    basedOnObservationId: "observation-a",
  };
}

function settlement(
  overrides: Partial<CurrentQuestionSettlementDecision> = {}
): CurrentQuestionSettlementDecision {
  return {
    settlementId: "settlement-correction",
    logicalQuestionUnitId: "question-a",
    revision: 2,
    sessionId: "session-a",
    runtimeEpoch: 4,
    sourceKind: "voice",
    sourceTurnIds: ["turn-a"],
    sourceObservationIds: [],
    sourceHash: "source-a",
    questionType: "coding",
    relation: "correction",
    action: "answer",
    evidenceMode: "hypothetical-design",
    authority: "llm-type-repair",
    authoritySource: "llm-type-repair",
    typeAuthoritySource: "llm-type-repair",
    relationAuthoritySource: "llm-type-repair",
    actionAuthoritySource: "deterministic-fast-path",
    typeMutationAuthorized: true,
    relationMutationAuthorized: true,
    parentMutationAuthorized: true,
    responseAuthorized: true,
    confidence: 0.98,
    manualCorrectionRevision: 1,
    rejectedProposals: [],
    reasons: ["human-correction-changed-current-question-domain"],
    ...overrides,
  };
}

function playbook(): SelectedInterviewPlaybook {
  return {
    id: "coding_algorithm",
    label: "Coding",
    phase: "implementation_validation",
    questionType: "coding",
    confidence: 1,
    reason: "manual correction",
    memoryPolicy: { id: "coding" },
    firstMove: "Explain the direct approach.",
    clarifyingStrategy: "Clarify only missing constraints.",
    outputContract: "Return code and complexity.",
    followUpPolicy: "Preserve the coding artifact.",
  };
}

function meetingTask(
  activeParent: ActiveInterviewParent,
  activeScreen?: ActiveScreenTask,
  runtimeRevision = 3
) {
  return buildActiveMeetingTask({
    parent: activeParent,
    screenAttachment: activeScreen,
    runtimeRevision,
  })!;
}

function correctionPlan(input: {
  before: ActiveMeetingTask;
  after: ActiveMeetingTask;
}) {
  return buildSettledAdvisorExecutionPlan({
    settlement: settlement(),
    activeMeetingTask: input.after,
    expectedActiveMeetingTask: input.before,
    preBoundaryQuestionType: input.before.parent.questionType,
    taskBoundaryCommitted: true,
    childOwnsResponse: false,
    providerSnapshot: providers,
    playbook: playbook(),
    memoryUseCase: "coding_interview",
    askFrame: "direct-answer",
    topicDomain: "backend",
    subtaskIntent: "implementation-probe",
    sourceQuestion: "Implement Merge Sort",
    explicitTaskMutationCommand: {
      kind: "replace-parent",
      type: "coding",
      topic: "Implement Merge Sort",
    },
    createdAt: 100,
  });
}

test("atomically replaces a corrected parent under one settled plan", () => {
  const beforeParent = parent("general-system-design");
  const beforeScreen = screen("general-system-design");
  const afterParent = parent("coding", {
    topic: "Implement Merge Sort",
    playbook: playbook(),
    playbookPhase: "implementation_validation",
    phaseProgress: { implementation_validation: true },
    whiteboardArtifact: undefined,
    sourceQuestionUnitId: "question-a",
    sourceQuestionRevision: 2,
    settlementId: "settlement-correction",
    revisions: 4,
  });
  const afterScreen = screen("coding");
  const before = meetingTask(beforeParent, beforeScreen);
  const after = meetingTask(afterParent, afterScreen);
  const plan = correctionPlan({ before, after });
  const preAuthorization = authorizeSettledAdvisorExecutionPlan({
    plan,
    currentSettlement: settlement(),
    currentSessionId: "session-a",
    currentRuntimeEpoch: 4,
    currentLogicalQuestionUnitId: "question-a",
    currentLogicalQuestionRevision: 2,
    currentSourceHash: "source-a",
    currentActiveMeetingTask: before,
    stage: "pre-task-mutation",
  });
  assert.equal(preAuthorization.authorized, true);

  const transaction = createTaskLifecycleTransaction({
    plan,
    manualCorrectionRevision: 1,
    proposedActiveInterviewTask: afterParent,
    proposedActiveScreenTask: afterScreen,
  });
  const reduction = reduceTaskLifecycleTransaction({
    transaction,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 4,
    currentLogicalQuestionUnitId: "question-a",
    currentLogicalQuestionRevision: 2,
    currentManualCorrectionRevision: 1,
    currentTaskRuntimeRevision: 3,
    currentActiveInterviewTask: beforeParent,
    currentActiveScreenTask: beforeScreen,
  });

  assert.equal(reduction.authorized, true);
  assert.equal(reduction.mutationApplied, true);
  assert.equal(reduction.reason, "committed");
  assert.equal(reduction.activeMeetingTask?.runtimeRevision, 4);
  assert.equal(
    reduction.activeMeetingTask?.parent.questionType,
    "coding"
  );
  assert.equal(
    reduction.activeMeetingTask?.parent.whiteboardArtifact,
    undefined
  );
  assert.equal(plan.modelRoute.route, "coding-override");
  assert.equal(plan.artifactIntent, "revise-code");

  const postAuthorization = authorizeSettledAdvisorExecutionPlan({
    plan,
    currentSettlement: settlement(),
    currentSessionId: "session-a",
    currentRuntimeEpoch: 4,
    currentLogicalQuestionUnitId: "question-a",
    currentLogicalQuestionRevision: 2,
    currentSourceHash: "source-a",
    currentActiveMeetingTask: reduction.activeMeetingTask,
  });
  assert.equal(postAuthorization.authorized, true);
});

test("consumes a settled follow-up as one same-parent context update", () => {
  const beforeParent = parent("coding", {
    topic: "Implement an LRU cache",
  });
  const afterParent = parent("coding", {
    topic: "Implement an LRU cache",
    latestUsefulAnswer: "Explain the eviction helper.",
    revisions: 4,
    updatedAt: 30,
  });
  const beforeScreen = screen("coding");
  const before = meetingTask(beforeParent, beforeScreen, 3);
  const after = meetingTask(afterParent, beforeScreen, 4);
  const followupSettlement = settlement({
    settlementId: "settlement-followup",
    relation: "followup-parent",
    parentMutationAuthorized: false,
    reasons: [
      "runtime-relation-settlement",
      "relation-does-not-create-parent",
    ],
  });
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: followupSettlement,
    activeMeetingTask: after,
    expectedActiveMeetingTask: before,
    preBoundaryQuestionType: "coding",
    taskBoundaryCommitted: false,
    childOwnsResponse: false,
    providerSnapshot: providers,
    playbook: playbook(),
    memoryUseCase: "coding_interview",
    askFrame: "direct-answer",
    topicDomain: "backend",
    sourceQuestion: "Explain the eviction helper.",
    createdAt: 100,
  });

  assert.equal(plan.contextReadScope, "active-parent-read");
  assert.deepEqual(plan.taskMutationPolicy, {
    kind: "update-parent-context",
  });
  const reduction = reduceTaskLifecycleTransaction({
    transaction: createTaskLifecycleTransaction({
      plan,
      manualCorrectionRevision: 1,
      proposedActiveInterviewTask: afterParent,
      proposedActiveScreenTask: beforeScreen,
    }),
    currentSessionId: "session-a",
    currentRuntimeEpoch: 4,
    currentLogicalQuestionUnitId: "question-a",
    currentLogicalQuestionRevision: 2,
    currentManualCorrectionRevision: 1,
    currentTaskRuntimeRevision: 3,
    currentActiveInterviewTask: beforeParent,
    currentActiveScreenTask: beforeScreen,
  });

  assert.equal(reduction.authorized, true);
  assert.equal(reduction.mutationApplied, true);
  assert.equal(reduction.reason, "committed");
  assert.equal(reduction.parentBeforeId, "parent-a");
  assert.equal(reduction.parentAfterId, "parent-a");
  assert.equal(reduction.parentAfterRevision, 4);
  assert.equal(
    reduction.parent?.latestUsefulAnswer,
    "Explain the eviction helper."
  );
  assert.equal(reduction.screenAttachment?.id, "screen-a");
});

test("rejects a stale correction revision without changing the parent", () => {
  const beforeParent = parent("general-system-design");
  const afterParent = parent("coding", {
    topic: "Implement Merge Sort",
    revisions: 4,
  });
  const before = meetingTask(beforeParent);
  const after = meetingTask(afterParent);
  const plan = correctionPlan({ before, after });
  const reduction = reduceTaskLifecycleTransaction({
    transaction: createTaskLifecycleTransaction({
      plan,
      manualCorrectionRevision: 1,
      proposedActiveInterviewTask: afterParent,
    }),
    currentSessionId: "session-a",
    currentRuntimeEpoch: 4,
    currentLogicalQuestionUnitId: "question-a",
    currentLogicalQuestionRevision: 2,
    currentManualCorrectionRevision: 2,
    currentTaskRuntimeRevision: 3,
    currentActiveInterviewTask: beforeParent,
  });

  assert.equal(reduction.authorized, false);
  assert.equal(
    reduction.reason,
    "manual-correction-revision-mismatch"
  );
  assert.equal(
    reduction.parent?.stableKind,
    "general-system-design"
  );
});

test("rejects a stale parent revision without applying a partial transition", () => {
  const expectedParent = parent("general-system-design");
  const currentParent = parent("general-system-design", {
    revisions: 4,
  });
  const afterParent = parent("coding", {
    topic: "Implement Merge Sort",
    revisions: 4,
  });
  const plan = correctionPlan({
    before: meetingTask(expectedParent),
    after: meetingTask(afterParent),
  });
  const reduction = reduceTaskLifecycleTransaction({
    transaction: createTaskLifecycleTransaction({
      plan,
      manualCorrectionRevision: 1,
      proposedActiveInterviewTask: afterParent,
    }),
    currentSessionId: "session-a",
    currentRuntimeEpoch: 4,
    currentLogicalQuestionUnitId: "question-a",
    currentLogicalQuestionRevision: 2,
    currentManualCorrectionRevision: 1,
    currentTaskRuntimeRevision: 3,
    currentActiveInterviewTask: currentParent,
  });

  assert.equal(reduction.authorized, false);
  assert.equal(reduction.reason, "parent-revision-mismatch");
  assert.equal(
    reduction.parent?.stableKind,
    "general-system-design"
  );
});

test("rejects an incomplete correction projection without mutating the parent", () => {
  const beforeParent = parent("general-system-design");
  const afterParent = parent("coding", {
    topic: "Implement Merge Sort",
    revisions: 4,
  });
  const plan = correctionPlan({
    before: meetingTask(beforeParent),
    after: meetingTask(afterParent),
  });
  const reduction = reduceTaskLifecycleTransaction({
    transaction: createTaskLifecycleTransaction({
      plan,
      manualCorrectionRevision: 1,
    }),
    currentSessionId: "session-a",
    currentRuntimeEpoch: 4,
    currentLogicalQuestionUnitId: "question-a",
    currentLogicalQuestionRevision: 2,
    currentManualCorrectionRevision: 1,
    currentTaskRuntimeRevision: 3,
    currentActiveInterviewTask: beforeParent,
  });

  assert.equal(reduction.authorized, false);
  assert.equal(reduction.mutationApplied, false);
  assert.equal(reduction.reason, "proposed-parent-required");
  assert.equal(
    reduction.parent?.stableKind,
    "general-system-design"
  );
  assert.equal(reduction.activeMeetingTask, undefined);
});

test("rejects a retype that retains an incompatible whiteboard", () => {
  const whiteboard = {
    id: "whiteboard-a",
    parentTaskId: "parent-a",
    domainTrack: "general_sd" as const,
    archetypeIds: [],
    selectedOverlayIds: [],
    currentPhase: "requirement_clarification" as const,
    title: "Ride sharing",
    content: "graph TD",
    summary: "Old architecture",
    revision: 1,
    updateSource: "model-output" as const,
    updatedAt: 20,
    createdAt: 10,
  };
  const beforeParent = parent("general-system-design", {
    whiteboardArtifact: whiteboard,
  });
  const afterParent = parent("coding", {
    topic: "Implement Merge Sort",
    revisions: 4,
    whiteboardArtifact: whiteboard,
  });
  const plan = correctionPlan({
    before: meetingTask(beforeParent),
    after: meetingTask(afterParent),
  });
  const reduction = reduceTaskLifecycleTransaction({
    transaction: createTaskLifecycleTransaction({
      plan,
      manualCorrectionRevision: 1,
      proposedActiveInterviewTask: afterParent,
    }),
    currentSessionId: "session-a",
    currentRuntimeEpoch: 4,
    currentLogicalQuestionUnitId: "question-a",
    currentLogicalQuestionRevision: 2,
    currentManualCorrectionRevision: 1,
    currentTaskRuntimeRevision: 3,
    currentActiveInterviewTask: beforeParent,
  });

  assert.equal(reduction.authorized, false);
  assert.equal(reduction.reason, "incompatible-artifact-retained");
});
