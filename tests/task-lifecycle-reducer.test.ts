import type { ActiveMeetingTask } from "../src/lib/meeting/meeting-task-contracts.js";
import assert from "node:assert/strict";
import test from "node:test";
import { buildActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import {
  createProvisionalCurrentQuestion,
  type CurrentQuestionSettlementDecision,
} from "../src/lib/meeting/current-question-settlement.js";
import {
  authorizeManualCorrectionLifecycle,
  settleManualQuestionTypeCorrection,
} from "../src/lib/meeting/manual-correction-settlement.js";
import {
  buildManualCorrectionParentTransition,
  decideManualCorrectionScope,
  decideManualQuestionTypeCorrection,
} from "../src/lib/meeting/manual-question-type-correction.js";
import type { MeetingModelProviderSnapshot } from "../src/lib/meeting/meeting-model-route.js";
import {
  authorizeSettledAdvisorExecutionPlan,
  buildSettledAdvisorExecutionPlan,
} from "../src/lib/meeting/settled-advisor-execution-plan.js";
import {
  createTaskLifecycleTransaction,
  reduceTaskLifecycleTransaction,
} from "../src/lib/meeting/task-lifecycle-reducer.js";
import { normalizeCanonicalQuestionType } from "../src/lib/meeting/task-taxonomy.js";
import {
  evaluateTaskSettlementTupleCompatibilityV2,
  projectObservedParentAction,
} from "../src/lib/meeting/task-settlement-tuple.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
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
    authority: "runtime-adjudication",
    authoritySource: "runtime-adjudication",
    typeAuthoritySource: "runtime-adjudication",
    relationAuthoritySource: "runtime-adjudication",
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

function aiMlPlaybook(): SelectedInterviewPlaybook {
  return {
    ...playbook(),
    id: "aiml_system_design",
    label: "AI/ML System Design",
    phase: "requirement_clarification",
    questionType: "ai-ml-system-design",
    memoryPolicy: {
      id: "aiml-system-design",
      allowedFamilies: ["ai-ml-system-design"],
    },
    outputContract: "Return a system-design answer and whiteboard.",
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
  settlementOverrides?: Partial<CurrentQuestionSettlementDecision>;
  sourceQuestion?: string;
}) {
  const correctedSettlement = settlement(input.settlementOverrides);
  const correctedType = normalizeCanonicalQuestionType(
    input.after.parent.questionType
  );
  assert.ok(correctedType && correctedType !== "unknown");
  return buildSettledAdvisorExecutionPlan({
    settlement: correctedSettlement,
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
    sourceQuestion: input.sourceQuestion ?? "Implement Merge Sort",
    explicitTaskMutationCommand: {
      kind: "replace-parent",
      type: correctedType,
      topic: input.after.parent.topic,
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

test("composes a related Human Type correction through settlement, lifecycle, and evaluation", () => {
  const parentQuestion = "How would you design the indexing and serving path?";
  const followupQuestion =
    "A future team may use a separate analytics store.";
  const beforeParent = parent("general-system-design", {
    id: "parent-indexing",
    topic: parentQuestion,
    startTurnId: "turn-parent-origin",
    canonicalQuestionSourceTurnIds: ["turn-parent-origin"],
    sourceQuestionUnitId: "question-parent-origin",
    sourceQuestionRevision: 1,
    settlementId: "settlement-parent-origin",
  });
  const before = meetingTask(beforeParent);
  const logicalQuestionUnit: LogicalQuestionUnit = {
    id: "question-analytics-followup",
    revision: 1,
    sessionId: "session-a",
    runtimeEpoch: 4,
    currentTurnId: "turn-analytics-followup",
    sourceTurnIds: ["turn-analytics-followup"],
    sources: [
      {
        turnId: "turn-analytics-followup",
        text: followupQuestion,
        startedAt: 30,
        endedAt: 31,
      },
    ],
    normalizedText: followupQuestion,
    startedAt: 30,
    updatedAt: 31,
    compositionReasons: ["fresh-substantive-turn"],
    boundaryReason: "fresh-substantive-turn",
    truncated: false,
  };
  const provisionalQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit,
    sourceKind: "voice",
  });
  const lineage = {
    questionInstanceId: "lqu:question-analytics-followup",
    questionOriginTraceId: "trace-analytics-followup",
    sourceSuggestionId: "suggestion-analytics-followup",
    triggerTurnId: "turn-analytics-followup",
    sessionId: "session-a",
    runtimeEpoch: 4,
    identityState: "canonical" as const,
  };
  const correctionDecision = decideManualQuestionTypeCorrection(
    before,
    "ai-ml-system-design"
  );
  const settlementResult = settleManualQuestionTypeCorrection({
    operationId: "correction-related-transaction",
    currentQuestion: provisionalQuestion,
    correctedType: "ai-ml-system-design",
    activeParentId: beforeParent.id,
    activeParentRevision: beforeParent.revisions,
    manualCorrectionRevision: 2,
    relationCandidate: {
      schemaVersion: 3,
      relation: "followup-parent",
      confidence: 0.98,
      currentQuestionEvidenceSpans: ["analytics store"],
      parentEvidenceSpans: ["indexing and serving"],
    },
    relationOperationLeaseAuthorized: true,
  });
  const scope = decideManualCorrectionScope({
    task: before,
    decision: correctionDecision,
    lineage,
    latestQuestionText: followupQuestion,
    parentQuestionText: parentQuestion,
    currentQuestionRelation: settlementResult.settlement.relation,
    currentQuestionSource: "voice",
  });
  const authorizedSettlement = authorizeManualCorrectionLifecycle({
    settlement: settlementResult.settlement,
    scope: scope.scope,
    activeParentId: beforeParent.id,
    activeParentType: beforeParent.stableKind,
  });
  const correctedPlaybook = aiMlPlaybook();
  const transition = buildManualCorrectionParentTransition({
    parent: beforeParent,
    decision: correctionDecision,
    scopeDecision: scope,
    correctedPlaybook,
    latestQuestionText: followupQuestion,
    lineage,
    transcriptTurns: [],
    newParentId: "unused-parent-id",
    now: 40,
  });
  const afterParent: ActiveInterviewParent = {
    ...transition.parent,
    settlementId: authorizedSettlement.settlementId,
  };
  const after = meetingTask(afterParent, undefined, 4);
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: authorizedSettlement,
    activeMeetingTask: after,
    expectedActiveMeetingTask: before,
    preBoundaryQuestionType: before.parent.questionType,
    taskBoundaryCommitted: true,
    childOwnsResponse: false,
    providerSnapshot: providers,
    playbook: correctedPlaybook,
    memoryUseCase: "aiml_system_design_interview",
    askFrame: "hypothetical-design",
    topicDomain: "ai-ml-infra",
    sourceQuestion: followupQuestion,
    contextReadScopeOverride: "active-parent-read",
    explicitTaskMutationCommand: {
      kind: "replace-parent",
      type: afterParent.stableKind,
      topic: afterParent.topic,
    },
    taskMutationCommittedBeforeAdvisor: true,
    createdAt: 50,
  });
  const reduction = reduceTaskLifecycleTransaction({
    transaction: createTaskLifecycleTransaction({
      plan,
      manualCorrectionRevision: 2,
      proposedActiveInterviewTask: afterParent,
    }),
    currentSessionId: "session-a",
    currentRuntimeEpoch: 4,
    currentLogicalQuestionUnitId: logicalQuestionUnit.id,
    currentLogicalQuestionRevision: logicalQuestionUnit.revision,
    currentManualCorrectionRevision: 2,
    currentTaskRuntimeRevision: before.runtimeRevision,
    currentActiveInterviewTask: beforeParent,
  });
  assert.equal(authorizedSettlement.relation, "followup-parent");
  const observedParentAction = projectObservedParentAction({
    relation: "followup-parent",
    mutationAuthorized: authorizedSettlement.parentMutationAuthorized,
    lifecycleCommand: plan.taskMutationPolicy.kind,
    currentOnly: false,
    parentBeforeId: reduction.parentBeforeId,
    parentAfterId: reduction.parentAfterId,
    parentBeforeType: reduction.parentBeforeType,
    parentAfterType: reduction.parentAfterType,
  });

  assert.equal(scope.scope, "same-question-retype");
  assert.equal(authorizedSettlement.parentMutationAuthorized, true);
  assert.equal(transition.startedNewParent, false);
  assert.equal(afterParent.id, beforeParent.id);
  assert.equal(afterParent.topic, beforeParent.topic);
  assert.equal(afterParent.stableKind, "ai-ml-system-design");
  assert.equal(reduction.authorized, true);
  assert.equal(reduction.mutationApplied, true);
  assert.equal(reduction.reason, "committed");
  assert.equal(observedParentAction, "retype");
  assert.equal(
    evaluateTaskSettlementTupleCompatibilityV2({
      relation: "followup-parent",
      parentAction: observedParentAction,
    }).compatible,
    true
  );
});

test("consumes a settled follow-up as one same-parent context update", () => {
  const beforeParent = parent("coding", {
    topic: "Implement an LRU cache",
  });
  const afterParent = parent("coding", {
    topic: "Implement an LRU cache",
    phaseProgress: { eviction_helper: true },
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
  assert.deepEqual(reduction.parent?.phaseProgress, { eviction_helper: true });
  assert.equal("latestUsefulAnswer" in reduction.parent!, false);
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
