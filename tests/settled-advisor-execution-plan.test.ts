import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import type { CurrentQuestionSettlementDecision } from "../src/lib/meeting/current-question-settlement.js";
import type { MeetingModelProviderSnapshot } from "../src/lib/meeting/meeting-model-route.js";
import { adaptQuestionTypePrior } from "../src/lib/meeting/question-type-consumer-observation.js";
import {
  authorizeSettledAdvisorExecutionPlan,
  buildEffectiveAdvisorSettlementView,
  buildSettledAdvisorExecutionPlan,
  effectiveSettlementAuthorizesSourceTransition,
  formatEffectiveAdvisorSettlementViewForTrace,
  formatSettledAdvisorExecutionPlanForTrace,
  rebaseSettledAdvisorExecutionPlanAfterOwnedParentMutation,
  settledExecutionPlanAuthorizesTaskContinuity,
} from "../src/lib/meeting/settled-advisor-execution-plan.js";
import {
  primaryAskAnswerFocusText,
  primaryAskClassifierText,
  projectPrimaryAsk,
} from "../src/lib/meeting/primary-ask-projection.js";
import { projectCrossTypeTaskRelationHint } from "../src/lib/meeting/task-relation-authority.js";
import type { SelectedInterviewPlaybook } from "../src/lib/meeting/types.js";
import type { TransientPersonalStatusDecision } from "../src/lib/meeting/types.js";

const providers: MeetingModelProviderSnapshot = {
  providers: [
    { id: "main", curl: "https://main.test" },
    { id: "coding", curl: "https://coding.test" },
  ],
  selectedProvider: { provider: "main", variables: {} },
  codingProvider: { provider: "coding", variables: {} },
};

function settlement(
  overrides: Partial<CurrentQuestionSettlementDecision> = {}
): CurrentQuestionSettlementDecision {
  return {
    settlementId: "question_settlement_a",
    logicalQuestionUnitId: "question-a",
    revision: 2,
    sessionId: "session-a",
    runtimeEpoch: 4,
    sourceKind: "voice",
    sourceTurnIds: ["turn-a"],
    sourceObservationIds: [],
    sourceHash: "source-a",
    questionType: "coding",
    relation: "new-parent",
    action: "answer",
    evidenceMode: "hypothetical-design",
    authority: "deterministic-fast-path",
    authoritySource: "accepted-transcript",
    typeAuthoritySource: "deterministic-fast-path",
    relationAuthoritySource: "deterministic-fast-path",
    actionAuthoritySource: "deterministic-fast-path",
    typeMutationAuthorized: true,
    relationMutationAuthorized: true,
    parentMutationAuthorized: true,
    responseAuthorized: true,
    confidence: 0.95,
    manualCorrectionRevision: 0,
    rejectedProposals: [],
    reasons: ["parent-mutation-authorized", "response-authorized"],
    ...overrides,
  };
}

function activeTask(
  questionType: ActiveMeetingTask["parent"]["questionType"] = "coding",
  overrides: Partial<ActiveMeetingTask["parent"]> = {}
): ActiveMeetingTask {
  return {
    id: "parent-a",
    runtimeRevision: 1,
    source: "voice",
    parent: {
      id: "parent-a",
      questionType,
      topic: "Implement a queue",
      playbookPhase:
        questionType === "coding"
          ? "baseline_reasoning"
          : "requirement_clarification",
      phaseProgress: {},
      supportedFactAnchors: [],
      createdAt: 10,
      updatedAt: 20,
      revisions: 3,
      sourceQuestionUnitId: "question-a",
      sourceQuestionRevision: 2,
      settlementId: "question_settlement_a",
      ...overrides,
    },
  };
}

function playbook(
  questionType: "coding" | "general-system-design" = "coding"
): SelectedInterviewPlaybook {
  return {
    id:
      questionType === "coding"
        ? "coding_algorithm"
        : "general_system_design",
    label: questionType,
    phase:
      questionType === "coding"
        ? "baseline_reasoning"
        : "requirement_clarification",
    questionType,
    confidence: 0.95,
    reason: "test",
    memoryPolicy: {
      id: questionType,
    },
    firstMove: "start",
    clarifyingStrategy: "clarify",
    outputContract: "answer",
    followUpPolicy: "continue",
  };
}

test("hides an old project parent behind a committed new-parent settlement", () => {
  const oldProject = activeTask("project-deep-dive", {
    id: "parent-oasis",
    sourceQuestionUnitId: "question-oasis",
    sourceQuestionRevision: 1,
    settlementId: "settlement-oasis",
    projectBinding: {
      projectId: "oasis",
      projectName: "Oasis",
      primaryEntryId: "mem_oasis_ndjson",
      evidenceEntryIds: ["mem_oasis_ndjson"],
      source: "memory",
      confidence: 0.95,
      lockedAt: 10,
      revision: 1,
      reason: "memory candidate",
      sourceTurnIds: ["turn-oasis"],
    },
    playbookPhase: "project_narrative",
    supportedFactAnchors: ["mem_oasis_ndjson"],
  });
  const codingSettlement = settlement({
    settlementId: "settlement-lru",
    logicalQuestionUnitId: "question-lru",
    revision: 1,
    questionType: "coding",
    relation: "new-parent",
    activeParentId: "parent-oasis",
    activeParentRevision: 3,
  });

  const view = buildEffectiveAdvisorSettlementView({
    settlement: codingSettlement,
    activeMeetingTask: oldProject,
    taskRuntimeRevision: 8,
    fallback: {
      questionType: "project-deep-dive",
      relation: "unknown",
      projectAnchor: "Oasis",
      playbookPhase: "project_narrative",
    },
  });

  assert.equal(view.questionType, "coding");
  assert.equal(view.relation, "new-parent");
  assert.equal(view.startsNewParent, true);
  assert.equal(view.parent, undefined);
  assert.equal(view.projectAnchor, undefined);
  assert.equal(view.playbookPhase, undefined);
  assert.deepEqual(view.supportedFactAnchors, []);
  assert.equal(
    formatEffectiveAdvisorSettlementViewForTrace(view, {
      proposedRelation: "unknown",
      proposedProjectAnchor: "Oasis",
    }).effectiveAdvisorProjectAnchorConflict,
    true
  );
});

test("reads an existing parent for a revision-stable origin without recreating it", () => {
  const current = activeTask("ai-ml-system-design", {
    sourceQuestionUnitId: "question-a",
    sourceQuestionRevision: 2,
    revisions: 5,
  });
  const revisedSettlement = settlement({
    revision: 3,
    questionType: "ai-ml-system-design",
    relation: "new-parent",
    parentMutationAuthorized: false,
    activeParentId: current.parent.id,
    activeParentRevision: current.parent.revisions,
  });
  const view = buildEffectiveAdvisorSettlementView({
    settlement: revisedSettlement,
    activeMeetingTask: current,
    taskRuntimeRevision: 6,
    fallback: {
      questionType: "ai-ml-system-design",
      relation: "followup-parent",
    },
  });

  assert.equal(view.relation, "new-parent");
  assert.equal(view.startsNewParent, false);
  assert.equal(view.parent?.id, current.parent.id);
  assert.equal(view.contextReadScope, "active-parent-read");

  const plan = buildSettledAdvisorExecutionPlan({
    settlement: revisedSettlement,
    activeMeetingTask: current,
    preBoundaryQuestionType: "ai-ml-system-design",
    taskBoundaryCommitted: false,
    childOwnsResponse: false,
    providerSnapshot: providers,
    memoryUseCase: "system_design_interview",
    askFrame: "direct-answer",
    topicDomain: "ai-ml-infra",
    sourceQuestion: "Design a RAG system for trip planning",
  });

  assert.equal(plan.taskRelation, "new-parent");
  assert.deepEqual(plan.taskMutationPolicy, {
    kind: "update-parent-context",
  });
  assert.equal(plan.taskMutationCommittedBeforeAdvisor, false);
  assert.equal(plan.contextReadScope, "active-parent-read");
});

test("authorizes an owned child attachment against its post-mutation parent revision", () => {
  const before = activeTask("ai-ml-system-design", {
    topic: "Design a RAG system for trip planning",
    revisions: 6,
  });
  const afterParent = activeTask("ai-ml-system-design", {
    topic: "Design a RAG system for trip planning",
    revisions: 7,
  });
  const after: ActiveMeetingTask = {
    ...afterParent,
    child: {
      id: "child-monitoring",
      createdAt: 30,
      updatedAt: 30,
      questionType: "field-knowledge",
      relation: "child-probe",
      intent: "concept-probe",
      question: "What would you monitor in production?",
      basedOnTurnIds: ["turn-monitoring"],
      basedOnObservationIds: [],
    },
  };
  const childSettlement = settlement({
    settlementId: "question-settlement-monitoring",
    logicalQuestionUnitId: "question-monitoring",
    revision: 1,
    sourceHash: "source-monitoring",
    sourceTurnIds: ["turn-monitoring"],
    questionType: "field-knowledge",
    relation: "child-probe",
    evidenceMode: "factual-explanation",
    parentMutationAuthorized: false,
    activeParentId: before.parent.id,
    activeParentRevision: before.parent.revisions,
  });
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: childSettlement,
    expectedActiveMeetingTask: before,
    activeMeetingTask: after,
    preBoundaryQuestionType: "ai-ml-system-design",
    taskBoundaryCommitted: false,
    childOwnsResponse: true,
    providerSnapshot: providers,
    memoryUseCase: "meeting_assistant",
    askFrame: "direct-answer",
    topicDomain: "ai-ml-infra",
    sourceQuestion: "What would you monitor in production?",
    explicitTaskMutationCommand: {
      kind: "attach-child",
      type: "field-knowledge",
      question: "What would you monitor in production?",
    },
  });

  assert.equal(plan.expectedParentRevision, 6);
  assert.equal(plan.postMutationParentRevision, 7);
  assert.equal(plan.taskMutationPolicy.kind, "attach-child");
  assert.equal(
    authorizeSettledAdvisorExecutionPlan({
      plan,
      currentSettlement: childSettlement,
      currentSessionId: "session-a",
      currentRuntimeEpoch: 4,
      currentLogicalQuestionUnitId: "question-monitoring",
      currentLogicalQuestionRevision: 1,
      currentSourceHash: "source-monitoring",
      currentActiveMeetingTask: before,
      stage: "pre-task-mutation",
    }).authorized,
    true
  );
  assert.equal(
    authorizeSettledAdvisorExecutionPlan({
      plan,
      currentSettlement: childSettlement,
      currentSessionId: "session-a",
      currentRuntimeEpoch: 4,
      currentLogicalQuestionUnitId: "question-monitoring",
      currentLogicalQuestionRevision: 1,
      currentSourceHash: "source-monitoring",
      currentActiveMeetingTask: after,
      stage: "model-commit",
    }).authorized,
    true
  );
  const unrelatedLaterParent = activeTask("ai-ml-system-design", {
    topic: "Design a RAG system for trip planning",
    revisions: 8,
  });
  const unrelatedLaterMutation: ActiveMeetingTask = {
    ...unrelatedLaterParent,
    child: after.child,
  };
  const stale = authorizeSettledAdvisorExecutionPlan({
    plan,
    currentSettlement: childSettlement,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 4,
    currentLogicalQuestionUnitId: "question-monitoring",
    currentLogicalQuestionRevision: 1,
    currentSourceHash: "source-monitoring",
    currentActiveMeetingTask: unrelatedLaterMutation,
    stage: "model-commit",
  });
  assert.equal(stale.authorized, false);
  assert.deepEqual(stale.rejectionReasons, [
    "post-mutation-parent-revision-mismatch",
  ]);
});

test("keeps a revision-stable parent relation separate from a committed retype", () => {
  const before = activeTask("general-system-design", {
    topic: "Design a ride-sharing system for trip planning",
    revisions: 4,
  });
  const after = activeTask("ai-ml-system-design", {
    topic: "Design a RAG system for trip planning",
    revisions: 5,
  });
  const correctedSettlement = settlement({
    questionType: "ai-ml-system-design",
    relation: "new-parent",
    activeParentId: before.parent.id,
    activeParentRevision: before.parent.revisions,
  });
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: correctedSettlement,
    expectedActiveMeetingTask: before,
    activeMeetingTask: after,
    preBoundaryQuestionType: "general-system-design",
    taskBoundaryCommitted: true,
    childOwnsResponse: false,
    providerSnapshot: providers,
    memoryUseCase: "system_design_interview",
    askFrame: "direct-answer",
    topicDomain: "ai-ml-infra",
    sourceQuestion: "Design a RAG system for trip planning",
    contextReadScopeOverride: "active-parent-read",
    explicitTaskMutationCommand: {
      kind: "replace-parent",
      type: "ai-ml-system-design",
      topic: "Design a RAG system for trip planning",
    },
    taskMutationCommittedBeforeAdvisor: true,
  });

  assert.equal(plan.taskRelation, "new-parent");
  assert.equal(plan.taskMutationPolicy.kind, "replace-parent");
  assert.equal(plan.taskMutationCommittedBeforeAdvisor, true);
  assert.equal(plan.expectedParentId, before.parent.id);
  assert.equal(plan.expectedParentRevision, 4);
  assert.equal(plan.postMutationParentId, after.parent.id);
  assert.equal(plan.postMutationParentRevision, 5);
  assert.equal(plan.contextReadScope, "active-parent-read");
});

test("keeps the committed project parent visible for a project follow-up", () => {
  const project = activeTask("project-deep-dive", {
    id: "parent-oasis",
    projectBinding: {
      projectId: "oasis",
      projectName: "Oasis",
      primaryEntryId: "mem_oasis_ndjson",
      evidenceEntryIds: ["mem_oasis_ndjson"],
      source: "memory",
      confidence: 0.95,
      lockedAt: 10,
      revision: 1,
      reason: "memory candidate",
      sourceTurnIds: ["turn-oasis"],
    },
    playbookPhase: "architecture_decision",
    supportedFactAnchors: ["mem_oasis_ndjson"],
  });
  const view = buildEffectiveAdvisorSettlementView({
    settlement: settlement({
      questionType: "project-deep-dive",
      relation: "followup-parent",
      activeParentId: "parent-oasis",
      activeParentRevision: 3,
    }),
    activeMeetingTask: project,
    taskRuntimeRevision: 9,
    fallback: {
      questionType: "unknown",
      relation: "unknown",
    },
  });

  assert.equal(view.parentId, "parent-oasis");
  assert.equal(view.projectAnchor, "Oasis");
  assert.equal(view.playbookPhase, "architecture_decision");
  assert.deepEqual(view.supportedFactAnchors, ["mem_oasis_ndjson"]);
});

test("normalizes a legacy linked extension to parent continuity, not a new parent", () => {
  const task = activeTask("general-system-design");
  const view = buildEffectiveAdvisorSettlementView({
    settlement: settlement({
      questionType: "ai-ml-system-design",
      relation: "linked-parent-extension",
      parentMutationAuthorized: false,
    }),
    activeMeetingTask: task,
    taskRuntimeRevision: 10,
    fallback: {
      questionType: "ai-ml-system-design",
      relation: "unknown",
    },
  });

  assert.equal(view.relation, "followup-parent");
  assert.equal(view.startsNewParent, false);
  assert.equal(view.parentId, task.parent.id);
});

test("keeps active-parent abstention current-only without inventing compatibility", () => {
  const task = activeTask("general-system-design");
  const view = buildEffectiveAdvisorSettlementView({
    settlement: settlement({
      questionType: "unknown",
      relation: "unknown",
      typeMutationAuthorized: false,
      relationMutationAuthorized: false,
      parentMutationAuthorized: false,
      activeParentId: task.parent.id,
      activeParentRevision: task.parent.revisions,
    }),
    activeMeetingTask: task,
    taskRuntimeRevision: 4,
    fallback: {
      questionType: "unknown",
      relation: "unknown",
    },
  });

  assert.equal(view.rawQuestionType, "unknown");
  assert.equal(view.rawRelation, "unknown");
  assert.equal(view.questionType, "unknown");
  assert.equal(view.relation, "none");
  assert.equal(view.relationApplicable, false);
  assert.equal(view.currentOnly, true);
  assert.equal(view.nullHypothesisApplied, true);
  assert.equal(view.nullHypothesisReason, "active-parent-preserved");
  assert.equal(view.effectiveSettlement?.questionType, "unknown");
  assert.equal(view.effectiveSettlement?.relation, "none");
  assert.equal(view.effectiveSettlement?.relationMutationAuthorized, false);
  assert.equal(view.effectiveSettlement?.effective, true);
  assert.equal(view.effectiveSettlement?.effectiveRevision, 4);
  assert.equal(view.effectiveSettlement?.rawRelation, "unknown");
  assert.equal(view.effectiveSettlement?.effectiveParentId, undefined);
  assert.equal(view.contextReadScope, "current-only");
});

test("keeps active-child abstention current-only without borrowing its type", () => {
  const task: ActiveMeetingTask = {
    ...activeTask("general-system-design"),
    child: {
      id: "child-a",
      createdAt: 30,
      updatedAt: 30,
      questionType: "field-knowledge",
      relation: "child-probe",
      intent: "concept-probe",
      question: "Explain consistent hashing.",
      basedOnTurnIds: ["turn-child"],
      basedOnObservationIds: [],
    },
  };
  const view = buildEffectiveAdvisorSettlementView({
    settlement: settlement({
      questionType: "unknown",
      relation: "unknown",
      typeMutationAuthorized: false,
      relationMutationAuthorized: false,
      parentMutationAuthorized: false,
      activeParentId: task.parent.id,
      activeParentRevision: task.parent.revisions,
    }),
    activeMeetingTask: task,
    taskRuntimeRevision: 5,
    fallback: {
      questionType: "unknown",
      relation: "unknown",
    },
  });

  assert.equal(view.questionType, "unknown");
  assert.equal(view.relation, "none");
  assert.equal(view.relationApplicable, false);
  assert.equal(view.currentOnly, true);
  assert.equal(view.nullHypothesisReason, "active-parent-preserved");
  assert.equal(view.effectiveSettlement?.relationMutationAuthorized, false);
  assert.equal(view.effectiveSettlement?.effectiveChildId, undefined);
  assert.equal(view.contextReadScope, "current-only");
});

test("keeps an unresolved Screen relation current-only instead of inventing a parent", () => {
  const task = activeTask("coding");
  const raw = settlement({
    questionType: "behavioral",
    relation: "unknown",
    sourceKind: "screen",
    relationMutationAuthorized: false,
    parentMutationAuthorized: false,
  });
  const view = buildEffectiveAdvisorSettlementView({
    settlement: raw,
    activeMeetingTask: task,
    taskRuntimeRevision: 7,
    fallback: {
      questionType: "behavioral",
      relation: "unknown",
    },
  });

  assert.equal(view.rawRelation, "unknown");
  assert.equal(view.relation, "none");
  assert.equal(view.relationApplicable, false);
  assert.equal(view.currentOnly, true);
  assert.equal(view.startsNewParent, false);
  assert.equal(view.contextReadScope, "current-only");
  assert.equal(view.nullHypothesisReason, "active-parent-preserved");
});

test("uses compatible concrete type as a non-mutating parent continuity fallback", () => {
  const task = activeTask("general-system-design");
  const view = buildEffectiveAdvisorSettlementView({
    settlement: settlement({
      questionType: "general-system-design",
      relation: "unknown",
      relationMutationAuthorized: false,
      parentMutationAuthorized: false,
      activeParentId: task.parent.id,
      activeParentRevision: task.parent.revisions,
    }),
    activeMeetingTask: task,
    taskRuntimeRevision: 8,
    fallback: {
      questionType: "general-system-design",
      relation: "unknown",
    },
  });

  assert.equal(view.relation, "followup-parent");
  assert.equal(view.currentOnly, false);
  assert.equal(view.nullHypothesisReason, "active-parent-preserved");
  assert.equal(view.effectiveSettlement?.relationMutationAuthorized, false);
  assert.equal(view.contextReadScope, "active-parent-read");
  assert.equal(effectiveSettlementAuthorizesSourceTransition(view), false);
});

test("uses a matching concrete child type without replacing child identity", () => {
  const task: ActiveMeetingTask = {
    ...activeTask("general-system-design"),
    child: {
      id: "child-a",
      createdAt: 30,
      updatedAt: 30,
      questionType: "field-knowledge",
      relation: "child-probe",
      intent: "concept-probe",
      question: "Explain consistent hashing.",
      basedOnTurnIds: ["turn-child"],
      basedOnObservationIds: [],
    },
  };
  const view = buildEffectiveAdvisorSettlementView({
    settlement: settlement({
      questionType: "field-knowledge",
      relation: "unknown",
      relationMutationAuthorized: false,
      parentMutationAuthorized: false,
    }),
    activeMeetingTask: task,
    taskRuntimeRevision: 9,
    fallback: { questionType: "field-knowledge", relation: "unknown" },
  });

  assert.equal(view.relation, "child-probe");
  assert.equal(view.currentOnly, false);
  assert.equal(view.effectiveSettlement?.effectiveChildId, "child-a");
  assert.equal(view.effectiveSettlement?.relationMutationAuthorized, false);
  assert.equal(view.contextReadScope, "active-child-read");
  assert.equal(effectiveSettlementAuthorizesSourceTransition(view), false);
});

test("does not reinterpret one effective settlement after the active branch changes", () => {
  const originalTask = activeTask("general-system-design");
  const first = buildEffectiveAdvisorSettlementView({
    settlement: settlement({
      questionType: "general-system-design",
      relation: "unknown",
      relationMutationAuthorized: false,
      parentMutationAuthorized: false,
      activeParentId: originalTask.parent.id,
      activeParentRevision: originalTask.parent.revisions,
    }),
    activeMeetingTask: originalTask,
    taskRuntimeRevision: 10,
    fallback: {
      questionType: "general-system-design",
      relation: "unknown",
    },
  });
  assert.equal(first.relation, "followup-parent");
  assert.ok(first.effectiveSettlement);

  const differentTask = activeTask("behavioral", { id: "parent-b" });
  const replay = buildEffectiveAdvisorSettlementView({
    settlement: first.effectiveSettlement,
    activeMeetingTask: differentTask,
    taskRuntimeRevision: 11,
    fallback: { questionType: "behavioral", relation: "unknown" },
  });

  assert.equal(replay.questionType, "general-system-design");
  assert.equal(replay.relation, "followup-parent");
  assert.equal(replay.effectiveSettlement, first.effectiveSettlement);
  assert.equal(replay.parent, undefined);
  assert.equal(replay.contextReadScope, "current-only");
  assert.equal(replay.currentOnly, true);
});

test("keeps an explicit active-parent read inside the immutable plan", () => {
  const preservedTask = activeTask("ai-ml-system-design");
  const responseOnlySettlement = settlement({
    questionType: "coding",
    relation: "followup-parent",
    relationAuthoritySource: "provisional",
    relationMutationAuthorized: false,
    parentMutationAuthorized: false,
  });
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: responseOnlySettlement,
    activeMeetingTask: preservedTask,
    preBoundaryQuestionType: "ai-ml-system-design",
    taskBoundaryCommitted: false,
    childOwnsResponse: false,
    providerSnapshot: providers,
    playbook: playbook(),
    memoryUseCase: "coding_interview",
    askFrame: "direct-answer",
    topicDomain: "backend",
    contextReadScopeOverride: "active-parent-read",
    createdAt: 100,
  });

  assert.equal(plan.taskSnapshot?.parent.id, preservedTask.parent.id);
  assert.equal(plan.contextReadScope, "active-parent-read");
  assert.deepEqual(plan.taskMutationPolicy, { kind: "preserve" });
  assert.equal(plan.artifactIntent, "none");
  assert.equal(settledExecutionPlanAuthorizesTaskContinuity(plan, true), false);
});

test("lets the settled task command exclusively authorize output continuity", () => {
  const task = activeTask("general-system-design");
  const updatePlan = buildSettledAdvisorExecutionPlan({
    settlement: settlement({
      questionType: "general-system-design",
      relation: "followup-parent",
      parentMutationAuthorized: false,
      relationMutationAuthorized: true,
      activeParentId: task.parent.id,
      activeParentRevision: task.parent.revisions,
    }),
    activeMeetingTask: task,
    preBoundaryQuestionType: "general-system-design",
    taskBoundaryCommitted: false,
    childOwnsResponse: false,
    providerSnapshot: providers,
    playbook: playbook("general-system-design"),
    memoryUseCase: "system_design_interview",
    askFrame: "direct-answer",
    topicDomain: "backend",
    sourceQuestion: "How would multi-region failover change this design?",
    createdAt: 100,
  });

  assert.deepEqual(updatePlan.taskMutationPolicy, {
    kind: "update-parent-context",
  });
  assert.equal(settledExecutionPlanAuthorizesTaskContinuity(updatePlan), true);
  assert.equal(settledExecutionPlanAuthorizesTaskContinuity(undefined, true), true);
  assert.equal(settledExecutionPlanAuthorizesTaskContinuity(undefined), false);
});

test("keeps generated Advisor output outside the Screen source object", () => {
  const hookSource = readFileSync(
    `${process.cwd()}/src/hooks/useMeetingAssistant.ts`,
    "utf8"
  );

  assert.equal(
    hookSource.includes("shouldUpdateActiveScreenTaskFromAdvisorOutput"),
    false
  );
  assert.equal(
    /nextActiveScreenTask\s*=\s*\{[\s\S]*?content:\s*finalContent\.trim\(\)/.test(
      hookSource
    ),
    false
  );
});

test("routes the local visual-evidence response into the shared publication path", () => {
  const hookSource = readFileSync(
    `${process.cwd()}/src/hooks/useMeetingAssistant.ts`,
    "utf8"
  );
  const branchStart = hookSource.indexOf(
    "visualEvidenceCheckOutcome?.leaseAuthorized"
  );
  const sharedPublicationStart = hookSource.indexOf("    try {", branchStart);
  assert.ok(branchStart >= 0);
  assert.ok(sharedPublicationStart > branchStart);
  const localBranch = hookSource.slice(branchStart, sharedPublicationStart);

  assert.equal(localBranch.includes("localAdvisorOutput ="), true);
  assert.equal(localBranch.includes("withLatestReliableSuggestion"), false);
  assert.equal(localBranch.includes("releaseAdvisorJob"), false);
  assert.equal(localBranch.includes("finishTrace"), false);
});

test("keeps raw task relation and project anchor behind the consumer barrier", () => {
  const hookSource = readFileSync(
    `${process.cwd()}/src/hooks/useMeetingAssistant.ts`,
    "utf8"
  );
  const marker = "// COMMITTED_SETTLEMENT_CONSUMER_BARRIER";
  const barrierIndex = hookSource.indexOf(marker);
  assert.ok(barrierIndex >= 0);
  const downstream = hookSource.slice(barrierIndex + marker.length);

  assert.equal(downstream.includes("advisorTaskSignals.taskRelation"), false);
  assert.equal(downstream.includes("advisorTaskSignals.projectAnchor"), false);
});

test("builds one immutable coding plan for route, prompt, memory, and artifacts", () => {
  const task = activeTask();
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: settlement(),
    activeMeetingTask: task,
    preBoundaryQuestionType: "general-system-design",
    taskBoundaryCommitted: true,
    childOwnsResponse: false,
    providerSnapshot: providers,
    questionTypePrior: adaptQuestionTypePrior({
      source: "preparation-snapshot",
      sourceId: "snapshot-1:question-type-prior",
      types: ["behavioral"],
      expectedTypePolicy: "restricted",
    }),
    playbook: playbook(),
    memoryUseCase: "coding_interview",
    askFrame: "direct-answer",
    topicDomain: "backend",
    sourceQuestion: "Implement a queue.",
    subtaskIntent: "implementation-probe",
    createdAt: 100,
  });

  assert.equal(plan.responseOwner.questionType, "coding");
  assert.equal(plan.responseOwner.source, "committed-parent");
  assert.equal(plan.sourceKind, "voice");
  assert.deepEqual(plan.sourceTurnIds, ["turn-a"]);
  assert.deepEqual(plan.sourceObservationIds, []);
  assert.equal(plan.promptCurrentQuestionSourceHash, "source-a");
  assert.equal(plan.questionTypeConsumerObservation.sourceCoherent, true);
  assert.equal(plan.modelRoute.route, "coding-override");
  assert.equal(plan.promptContract.profile, "coding");
  assert.equal(plan.memoryPolicy.questionType, "coding");
  assert.equal(plan.memoryPolicy.retrievalPolicyId, "coding");
  assert.equal(plan.artifactPolicy.allowCode, false);
  assert.equal(plan.artifactPolicy.allowComplexity, false);
  assert.deepEqual(plan.requiredArtifacts, ["answer"]);
  assert.equal(plan.artifactPolicy.allowWhiteboard, false);
  assert.equal(plan.factAnchorPolicy.policyId, "not-required");
  assert.equal(plan.responseIntent, "advise");
  assert.equal(plan.contextReadScope, "current-only");
  assert.equal(plan.artifactIntent, "preserve");
  assert.deepEqual(plan.taskMutationPolicy, {
    kind: "create-parent",
    type: "coding",
    topic: "Implement a queue.",
  });

  task.parent.questionType = "behavioral";
  assert.equal(plan.taskSnapshot?.parent.questionType, "coding");
  assert.equal(Object.isFrozen(plan.taskSnapshot?.parent), true);
});

test("current-only plan routes from the current question without borrowing parent authority", () => {
  const preservedTask = activeTask("ai-ml-system-design");
  const responseOnlySettlement = settlement({
    questionType: "coding",
    relation: "unknown",
    relationAuthoritySource: "provisional",
    relationMutationAuthorized: false,
    parentMutationAuthorized: false,
  });
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: responseOnlySettlement,
    activeMeetingTask: preservedTask,
    preBoundaryQuestionType: "ai-ml-system-design",
    taskBoundaryCommitted: false,
    childOwnsResponse: false,
    providerSnapshot: providers,
    playbook: playbook(),
    memoryUseCase: "coding_interview",
    askFrame: "direct-answer",
    topicDomain: "backend",
    createdAt: 100,
  });

  assert.equal(plan.questionType, "coding");
  assert.equal(plan.responseOwner.source, "current-question");
  assert.equal(plan.modelRoute.route, "coding-override");
  assert.equal(plan.taskSnapshot?.parent.id, preservedTask.parent.id);
  assert.equal(plan.expectedParentId, preservedTask.parent.id);
  assert.equal(
    plan.expectedParentRevision,
    preservedTask.parent.revisions
  );
  assert.equal(plan.artifactPolicy.allowCode, false);
  assert.equal(plan.artifactPolicy.allowWhiteboard, false);
  assert.equal(plan.artifactPolicy.allowParentContextMutation, false);
  assert.equal(
    plan.artifactPolicy.disposition,
    "rejected-incompatible-owner"
  );
  assert.equal(plan.responseIntent, "advise");
  assert.equal(plan.contextReadScope, "current-only");
  assert.equal(plan.relation, "none");
  assert.equal(plan.taskRelation, "none");
  assert.equal(plan.relationApplicable, false);
  const currentOnlyTrace =
    formatSettledAdvisorExecutionPlanForTrace(plan);
  assert.equal(
    currentOnlyTrace.settledExecutionPlanRelation,
    "none"
  );
  assert.equal(
    currentOnlyTrace.settledExecutionPlanRelationApplicable,
    false
  );
  assert.equal(plan.artifactIntent, "none");
  assert.deepEqual(plan.taskMutationPolicy, { kind: "preserve" });
});

test("same-domain current-only repair keeps the response Playbook independent", () => {
  const preservedTask = activeTask("general-system-design", {
    playbookPhase: "design_framing",
  });
  const repairedSettlement = settlement({
    questionType: "ai-ml-system-design",
    relation: "unknown",
    typeAuthoritySource: "runtime-adjudication",
    relationAuthoritySource: "provisional",
    relationMutationAuthorized: false,
    parentMutationAuthorized: false,
  });
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: repairedSettlement,
    activeMeetingTask: preservedTask,
    preBoundaryQuestionType: "general-system-design",
    taskBoundaryCommitted: false,
    childOwnsResponse: false,
    providerSnapshot: providers,
    playbook: playbook("general-system-design"),
    memoryUseCase: "system_design_interview",
    askFrame: "hypothetical-design",
    topicDomain: "backend",
    createdAt: 100,
  });

  assert.equal(plan.taskSnapshot?.parent.id, preservedTask.parent.id);
  assert.equal(plan.playbookPhase, "requirement_clarification");
  assert.equal(plan.responsePlaybook?.questionType, "ai-ml-system-design");
  assert.equal(plan.responsePlaybook?.phase, "requirement_clarification");
  assert.equal(plan.parentTrajectoryPlaybook, undefined);
  assert.equal(plan.artifactIntent, "none");
  assert.equal(plan.artifactPolicy.allowWhiteboard, false);
});

test("an authorized child owns its response Playbook while the parent Playbook remains read-only", () => {
  const task: ActiveMeetingTask = {
    ...activeTask("general-system-design", {
      playbook: playbook("general-system-design"),
      playbookPhase: "design_framing",
    }),
    child: {
      id: "child-a",
      createdAt: 30,
      updatedAt: 30,
      questionType: "field-knowledge",
      relation: "child-probe",
      intent: "concept-probe",
      question: "How does consistent hashing work?",
      basedOnTurnIds: ["turn-child"],
      basedOnObservationIds: [],
    },
  };
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: settlement({
      questionType: "field-knowledge",
      relation: "child-probe",
      parentMutationAuthorized: false,
    }),
    activeMeetingTask: task,
    preBoundaryQuestionType: "general-system-design",
    taskBoundaryCommitted: false,
    childOwnsResponse: true,
    providerSnapshot: providers,
    playbook: playbook("general-system-design"),
    memoryUseCase: "system_design_interview",
    askFrame: "direct-answer",
    topicDomain: "backend",
    sourceQuestion: "How does consistent hashing work?",
    subtaskIntent: "concept-probe",
  });

  assert.equal(plan.responseOwner.source, "authorized-child");
  assert.equal(plan.responsePlaybook?.questionType, "field-knowledge");
  assert.equal(plan.responsePlaybook?.id, "aiml_field_knowledge");
  assert.equal(plan.parentTrajectoryPlaybook?.questionType, "general-system-design");
  assert.equal(plan.parentTrajectoryPlaybook?.phase, "design_framing");
  assert.equal(plan.memoryPolicy.retrievalPolicyId, "aiml_field_knowledge");
  assert.equal(plan.modelRoute.route, "main");
  assert.equal(plan.artifactPolicy.allowWhiteboard, false);
  assert.equal(plan.contextReadScope, "active-child-read");
  assert.deepEqual(plan.taskMutationPolicy, { kind: "preserve" });
});

test("relation abstention preserves task state without borrowing child response authority", () => {
  const task: ActiveMeetingTask = {
    ...activeTask("general-system-design", {
      playbook: playbook("general-system-design"),
      playbookPhase: "design_framing",
    }),
    child: {
      id: "child-hnsw",
      createdAt: 30,
      updatedAt: 30,
      questionType: "field-knowledge",
      relation: "child-probe",
      intent: "concept-probe",
      question: "How does HNSW work?",
      basedOnTurnIds: ["turn-child"],
      basedOnObservationIds: [],
    },
  };
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: settlement({
      questionType: "unknown",
      relation: "unknown",
      typeMutationAuthorized: false,
      relationMutationAuthorized: false,
      parentMutationAuthorized: false,
    }),
    activeMeetingTask: task,
    preBoundaryQuestionType: "field-knowledge",
    taskBoundaryCommitted: false,
    childOwnsResponse: false,
    providerSnapshot: providers,
    memoryUseCase: "meeting_assistant",
    askFrame: "direct-answer",
    topicDomain: "search",
    sourceQuestion: "Why does it need multiple layers?",
  });

  assert.equal(plan.responseOwner.source, "current-question");
  assert.equal(plan.responseOwner.questionType, "unknown");
  assert.equal(plan.contextReadScope, "current-only");
  assert.equal(plan.relation, "none");
  assert.equal(plan.taskRelation, "none");
  assert.equal(plan.relationApplicable, false);
  assert.deepEqual(plan.taskMutationPolicy, { kind: "preserve" });
  assert.equal(plan.taskSnapshot?.child?.id, "child-hnsw");
});

test("a precommitted runtime boundary remains the creating-parent lifecycle fact when settlement is answer-only", () => {
  const repairedSettlement = settlement({
    questionType: "coding",
    relation: "unknown",
    typeAuthoritySource: "runtime-adjudication",
    relationAuthoritySource: "provisional",
    relationMutationAuthorized: false,
    parentMutationAuthorized: false,
  });
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: repairedSettlement,
    activeMeetingTask: activeTask("coding"),
    taskBoundaryCommitted: true,
    childOwnsResponse: false,
    providerSnapshot: providers,
    playbook: playbook(),
    memoryUseCase: "coding_interview",
    askFrame: "direct-answer",
    topicDomain: "backend",
    sourceQuestion: "Implement a queue.",
    createdAt: 100,
  });

  assert.equal(
    plan.artifactPolicy.disposition,
    "parent-owner-authorized"
  );
  assert.equal(plan.taskMutationPolicy.kind, "create-parent");
});

test("a committed general-system-design settlement atomically leaves the coding route", () => {
  const designSettlement = settlement({
    questionType: "general-system-design",
  });
  const task = activeTask("general-system-design", {
    settlementId: designSettlement.settlementId,
  });
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: designSettlement,
    activeMeetingTask: task,
    preBoundaryQuestionType: "coding",
    taskBoundaryCommitted: true,
    childOwnsResponse: false,
    providerSnapshot: providers,
    playbook: playbook("general-system-design"),
    memoryUseCase: "meeting_assistant",
    askFrame: "hypothetical-design",
    topicDomain: "backend",
    createdAt: 100,
  });

  assert.equal(plan.responseOwner.questionType, "general-system-design");
  assert.equal(plan.modelRoute.route, "main");
  assert.equal(plan.promptContract.profile, "system-design");
  assert.equal(plan.playbookId, "general_system_design");
  assert.equal(plan.artifactPolicy.allowWhiteboard, true);
  assert.equal(plan.artifactPolicy.allowCode, false);
  assert.equal(plan.artifactIntent, "revise-whiteboard");
  assert.equal(plan.whiteboardFormatPreference, "mermaid");
});

test("settled design plans honor an explicit ASCII request", () => {
  const task = activeTask("general-system-design");
  const designSettlement = settlement({
    questionType: "general-system-design",
    relation: "followup-parent",
    parentMutationAuthorized: false,
    activeParentId: task.parent.id,
    activeParentRevision: task.parent.revisions,
  });
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: designSettlement,
    activeMeetingTask: task,
    taskBoundaryCommitted: false,
    childOwnsResponse: false,
    providerSnapshot: providers,
    playbook: playbook("general-system-design"),
    memoryUseCase: "system_design_interview",
    askFrame: "hypothetical-design",
    topicDomain: "backend",
    sourceQuestion: "Please show the architecture in ASCII.",
  });

  assert.equal(plan.artifactIntent, "revise-whiteboard");
  assert.equal(plan.whiteboardFormatPreference, "plain-text");
  assert.equal(
    formatSettledAdvisorExecutionPlanForTrace(plan)
      .settledExecutionPlanWhiteboardFormatPreference,
    "plain-text"
  );
});

test("semantic setup preserves a design parent and revises its whiteboard", () => {
  const text =
    "Now try to add a surge pricing and explain which components need to change.";
  const projection = projectPrimaryAsk({
    turnId: "turn-surge",
    text,
  });
  const answerFocusText = primaryAskAnswerFocusText(projection, text);
  const semanticEvidenceText = primaryAskClassifierText(projection, text);
  const relation = projectCrossTypeTaskRelationHint({
    activeQuestionType: "general-system-design",
    candidateQuestionType: "field-knowledge",
    currentText: semanticEvidenceText,
  });

  assert.equal(
    answerFocusText,
    "explain which components need to change."
  );
  assert.match(semanticEvidenceText, /add a surge pricing/i);
  assert.equal(relation?.relation, "unknown");
  assert.equal(relation?.proposedRelation, "followup-parent");
  assert.equal(relation?.relationEvidenceAuthorized, false);

  const plan = buildSettledAdvisorExecutionPlan({
    settlement: settlement({
      questionType: "general-system-design",
      relation: relation?.proposedRelation ?? "unknown",
      typeMutationAuthorized: false,
      relationMutationAuthorized: true,
      parentMutationAuthorized: false,
    }),
    activeMeetingTask: activeTask("general-system-design"),
    taskBoundaryCommitted: false,
    childOwnsResponse: false,
    providerSnapshot: providers,
    playbook: playbook("general-system-design"),
    memoryUseCase: "system_design_interview",
    askFrame: "hypothetical-design",
    topicDomain: "backend",
  });

  assert.equal(plan.responseIntent, "advise");
  assert.equal(plan.contextReadScope, "active-parent-read");
  assert.equal(plan.artifactIntent, "revise-whiteboard");
});

test("a personal-status response owns the current answer without mutating its coding parent", () => {
  const task = activeTask();
  const transientDecision: TransientPersonalStatusDecision = {
    id: "personal_status_a",
    domain: "relocation",
    sourceQuestionUnitId: "question-a",
    sourceQuestionRevision: 2,
    responseOwner: "personal-status",
    evidencePolicy: "profile-only",
    disposition: "domain-resolved-unknown",
    confidence: 0.98,
    preserveParentTask: true,
    preserveArtifacts: true,
    preservedParentTaskId: task.parent.id,
    preservedParentQuestionType: task.parent.questionType,
    preservedPlaybookPhase: task.parent.playbookPhase,
    createdAt: 100,
  };
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: settlement({
      questionType: "unknown",
      relation: "logistics",
      typeMutationAuthorized: false,
      relationMutationAuthorized: true,
      parentMutationAuthorized: false,
    }),
    activeMeetingTask: task,
    preBoundaryQuestionType: "coding",
    taskBoundaryCommitted: false,
    childOwnsResponse: false,
    providerSnapshot: providers,
    playbook: playbook(),
    memoryUseCase: "coding_interview",
    askFrame: "direct-answer",
    topicDomain: "backend",
    projectAnchor: "Technical project",
    transientPersonalStatusDecision: transientDecision,
    createdAt: 100,
  });

  assert.equal(plan.responseOwner.questionType, "unknown");
  assert.equal(plan.responseOwner.source, "transient-personal-status");
  assert.equal(plan.modelRoute.route, "main");
  assert.equal(plan.modelRoute.resolvedProviderId, "main");
  assert.equal(plan.promptContract.profile, "compact-spoken");
  assert.equal(plan.playbook, undefined);
  assert.equal(plan.playbookId, undefined);
  assert.equal(plan.playbookPhase, "baseline_reasoning");
  assert.equal(plan.memoryPolicy.useCase, "meeting_assistant");
  assert.equal(plan.memoryPolicy.questionType, "unknown");
  assert.equal(
    plan.memoryPolicy.retrievalPolicyId,
    "personal-status-profile-only"
  );
  assert.equal(plan.memoryPolicy.projectAnchor, undefined);
  assert.equal(plan.factAnchorPolicy.policyId, "personal-logistics");
  assert.equal(plan.artifactPolicy.disposition, "display-only-transient");
  assert.equal(plan.artifactPolicy.allowLatestUsefulAnswer, false);
  assert.equal(plan.artifactPolicy.allowCode, false);
  assert.equal(plan.artifactPolicy.allowWhiteboard, false);
  assert.equal(plan.responseIntent, "advise");
  assert.equal(plan.contextReadScope, "current-only");
  assert.equal(plan.relation, "none");
  assert.equal(plan.taskRelation, "none");
  assert.equal(plan.relationApplicable, false);
  assert.equal(plan.artifactIntent, "none");
  assert.deepEqual(plan.taskMutationPolicy, { kind: "preserve" });
  assert.equal(
    plan.transientPersonalStatusDecision?.domain,
    "relocation"
  );
});

test("plan authorization rejects stale question, settlement, and parent revisions", () => {
  const currentSettlement = settlement({
    settlementId: "question_settlement_new",
    revision: 3,
  });
  const task = activeTask();
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: settlement(),
    activeMeetingTask: task,
    taskBoundaryCommitted: true,
    childOwnsResponse: false,
    providerSnapshot: providers,
    playbook: playbook(),
    memoryUseCase: "coding_interview",
    askFrame: "direct-answer",
    topicDomain: "backend",
  });
  const authorization = authorizeSettledAdvisorExecutionPlan({
    plan,
    currentSettlement,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 4,
    currentLogicalQuestionUnitId: "question-a",
    currentLogicalQuestionRevision: 3,
    currentSourceHash: "source-new",
    currentActiveMeetingTask: activeTask("coding", {
      revisions: 4,
    }),
  });

  assert.equal(authorization.authorized, false);
  assert.ok(
    authorization.rejectionReasons.includes(
      "logical-question-revision-mismatch"
    )
  );
  assert.ok(
    authorization.rejectionReasons.includes("source-hash-mismatch")
  );
  assert.ok(
    authorization.rejectionReasons.includes("settlement-mismatch")
  );
  assert.ok(
    authorization.rejectionReasons.includes(
      "expected-parent-revision-mismatch"
    )
  );
});

test("plan authorization rejects a prompt built from a different question source", () => {
  const currentSettlement = settlement();
  const task = activeTask();
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: currentSettlement,
    activeMeetingTask: task,
    taskBoundaryCommitted: true,
    childOwnsResponse: false,
    providerSnapshot: providers,
    playbook: playbook(),
    memoryUseCase: "coding_interview",
    askFrame: "direct-answer",
    topicDomain: "backend",
    promptCurrentQuestionSourceHash: "source-b",
  });
  const authorization = authorizeSettledAdvisorExecutionPlan({
    plan,
    currentSettlement,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 4,
    currentLogicalQuestionUnitId: "question-a",
    currentLogicalQuestionRevision: 2,
    currentSourceHash: "source-a",
    currentActiveMeetingTask: task,
  });

  assert.equal(authorization.authorized, false);
  assert.ok(
    authorization.rejectionReasons.includes(
      "prompt-current-question-source-hash-mismatch"
    )
  );
  assert.equal(plan.questionTypeConsumerObservation.sourceCoherent, false);
});

test("plan authorization fails closed when the current settlement lease is missing", () => {
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: settlement(),
    activeMeetingTask: activeTask(),
    taskBoundaryCommitted: true,
    childOwnsResponse: false,
    providerSnapshot: providers,
    playbook: playbook(),
    memoryUseCase: "coding_interview",
    askFrame: "direct-answer",
    topicDomain: "backend",
  });
  const authorization = authorizeSettledAdvisorExecutionPlan({
    plan,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 4,
    currentActiveMeetingTask: activeTask(),
  });

  assert.equal(authorization.authorized, false);
  assert.ok(
    authorization.rejectionReasons.includes(
      "logical-question-unit-mismatch"
    )
  );
  assert.ok(
    authorization.rejectionReasons.includes(
      "logical-question-revision-mismatch"
    )
  );
  assert.ok(
    authorization.rejectionReasons.includes("source-hash-mismatch")
  );
  assert.ok(
    authorization.rejectionReasons.includes("settlement-mismatch")
  );
});

test("equivalent settlement inputs produce a stable plan id and compact trace", () => {
  const input = {
    settlement: settlement(),
    activeMeetingTask: activeTask(),
    taskBoundaryCommitted: true,
    childOwnsResponse: false,
    providerSnapshot: providers,
    questionTypePrior: adaptQuestionTypePrior({
      source: "preparation-snapshot" as const,
      sourceId: "snapshot-1:question-type-prior",
      types: ["behavioral"],
      expectedTypePolicy: "restricted" as const,
    }),
    playbook: playbook(),
    memoryUseCase: "coding_interview" as const,
    askFrame: "direct-answer" as const,
    topicDomain: "backend" as const,
    subtaskIntent: "implementation-probe" as const,
  };
  const first = buildSettledAdvisorExecutionPlan(input);
  const duplicate = buildSettledAdvisorExecutionPlan(input);
  const authorization = authorizeSettledAdvisorExecutionPlan({
    plan: first,
    currentSettlement: settlement(),
    currentSessionId: "session-a",
    currentRuntimeEpoch: 4,
    currentLogicalQuestionUnitId: "question-a",
    currentLogicalQuestionRevision: 2,
    currentSourceHash: "source-a",
    currentActiveMeetingTask: activeTask(),
  });
  const trace = formatSettledAdvisorExecutionPlanForTrace(
    first,
    authorization
  );

  assert.equal(first.id, duplicate.id);
  assert.equal(authorization.authorized, true);
  assert.equal(trace.settledExecutionPlanId, first.id);
  assert.equal(trace.settledExecutionPlanAuthorized, true);
  assert.equal(
    trace.settledExecutionPlanPromptContract,
    "meeting-answer:coding"
  );
  assert.equal(
    trace.settledExecutionPlanDownstreamQuestionTypeAuthority,
    "committed-settlement"
  );
  assert.deepEqual(trace.questionTypePriorTypes, ["behavioral"]);
  assert.equal(trace.priorCompatibility, "conflict");
  assert.equal(trace.priorUsedAsExecutionGate, false);
  assert.equal(trace.responseOwnerQuestionType, "coding");
  assert.equal(trace.responsePlaybookQuestionType, "coding");
  assert.equal(trace.kmbPolicyQuestionType, "coding");
  assert.deepEqual(trace.questionTypeConsumerConflicts, [
    "prior-vs-committed",
  ]);
  assert.equal(trace.settledExecutionPlanResponseIntent, "advise");
  assert.equal(
    trace.settledExecutionPlanContextReadScope,
    "current-only"
  );
  assert.equal(trace.settledExecutionPlanArtifactIntent, "preserve");
  assert.deepEqual(trace.settledExecutionPlanRequiredArtifacts, ["answer"]);
  assert.equal(
    trace.settledExecutionPlanTaskMutationCommand,
    "create-parent"
  );
});

test("freezes an explicit phase advance independently from response and artifact intent", () => {
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: settlement({
      questionType: "general-system-design",
      relation: "followup-parent",
      parentMutationAuthorized: false,
    }),
    activeMeetingTask: activeTask("general-system-design"),
    taskBoundaryCommitted: false,
    childOwnsResponse: false,
    providerSnapshot: providers,
    playbook: playbook("general-system-design"),
    memoryUseCase: "system_design_interview",
    askFrame: "hypothetical-design",
    topicDomain: "backend",
    explicitTaskMutationCommand: {
      kind: "advance-phase",
      phase: "design_framing",
    },
  });

  assert.equal(plan.responseIntent, "advise");
  assert.equal(plan.contextReadScope, "active-parent-read");
  assert.equal(plan.artifactIntent, "revise-whiteboard");
  assert.deepEqual(plan.taskMutationPolicy, {
    kind: "advance-phase",
    phase: "design_framing",
  });
});

test("freezes phase-owned Coding artifact authority across Manual Next", () => {
  const phases = [
    {
      phase: "baseline_reasoning" as const,
      required: ["answer"],
      allowCode: false,
      allowComplexity: false,
    },
    {
      phase: "optimized_pseudocode" as const,
      required: ["answer", "complexity"],
      allowCode: false,
      allowComplexity: true,
    },
    {
      phase: "implementation_validation" as const,
      required: ["answer", "code", "complexity"],
      allowCode: true,
      allowComplexity: true,
    },
  ];

  for (const current of phases) {
    const codingPlaybook = {
      ...playbook("coding"),
      phase: current.phase,
    };
    const plan = buildSettledAdvisorExecutionPlan({
      settlement: settlement({
        questionType: "coding",
        relation: "followup-parent",
        relationMutationAuthorized: false,
        parentMutationAuthorized: false,
      }),
      activeMeetingTask: activeTask("coding", {
        playbook: codingPlaybook,
        playbookPhase: current.phase,
      }),
      taskBoundaryCommitted: false,
      childOwnsResponse: false,
      providerSnapshot: providers,
      playbook: codingPlaybook,
      memoryUseCase: "coding_interview",
      askFrame: "direct-answer",
      topicDomain: "backend",
      explicitTaskMutationCommand: {
        kind: "advance-phase",
        phase: current.phase,
      },
    });

    assert.equal(plan.playbookPhase, current.phase);
    assert.deepEqual(plan.requiredArtifacts, current.required);
    assert.equal(plan.artifactPolicy.allowCode, current.allowCode);
    assert.equal(
      plan.artifactPolicy.allowComplexity,
      current.allowComplexity
    );
    assert.deepEqual(plan.taskMutationPolicy, {
      kind: "advance-phase",
      phase: current.phase,
    });
  }
});

test("freezes an authorized bounded recent history read without changing mutation policy", () => {
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: settlement({
      questionType: "general-system-design",
      relation: "followup-parent",
      parentMutationAuthorized: false,
    }),
    activeMeetingTask: activeTask("general-system-design"),
    taskBoundaryCommitted: false,
    childOwnsResponse: false,
    providerSnapshot: providers,
    playbook: playbook("general-system-design"),
    memoryUseCase: "system_design_interview",
    askFrame: "hypothetical-design",
    topicDomain: "backend",
    contextReadScopeOverride: "bounded-recent-history",
  });

  assert.equal(plan.contextReadScope, "bounded-recent-history");
  assert.equal(plan.responseIntent, "advise");
  assert.equal(plan.artifactIntent, "revise-whiteboard");
  assert.equal(plan.taskMutationPolicy.kind, "update-parent-context");
});

test("settles non-answer actions without borrowing task or artifact authority", () => {
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: settlement({
      action: "ignore",
      responseAuthorized: false,
      typeMutationAuthorized: false,
      relationMutationAuthorized: false,
      parentMutationAuthorized: false,
    }),
    activeMeetingTask: activeTask(),
    taskBoundaryCommitted: false,
    childOwnsResponse: false,
    providerSnapshot: providers,
    memoryUseCase: "coding_interview",
    askFrame: "direct-answer",
    topicDomain: "backend",
  });

  assert.equal(plan.responseIntent, "suppress");
  assert.equal(plan.artifactIntent, "none");
  assert.deepEqual(plan.taskMutationPolicy, { kind: "preserve" });
});

test("rebases a settled plan after its own project binding parent mutation", () => {
  const currentSettlement = settlement({
    relation: "followup-parent",
    relationMutationAuthorized: false,
    parentMutationAuthorized: false,
  });
  const beforeBinding = activeTask("project-deep-dive", {
    revisions: 3,
  });
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: currentSettlement,
    activeMeetingTask: beforeBinding,
    taskBoundaryCommitted: false,
    childOwnsResponse: false,
    providerSnapshot: providers,
    memoryUseCase: "project_deep_dive",
    askFrame: "past-project",
    topicDomain: "ai-ml-infra",
  });
  const afterBinding = activeTask("project-deep-dive", {
    revisions: 4,
    projectBinding: {
      projectId: "agentic-memory",
      projectName: "Agentic Memory",
      primaryEntryId: "memory-agentic",
      confidence: 1,
      source: "memory",
      evidenceEntryIds: ["memory-agentic"],
      revision: 1,
      lockedAt: 50,
      reason: "test-owned-project-binding",
    },
  });

  assert.equal(
    authorizeSettledAdvisorExecutionPlan({
      plan,
      currentSettlement,
      currentSessionId: "session-a",
      currentRuntimeEpoch: 4,
      currentLogicalQuestionUnitId: "question-a",
      currentLogicalQuestionRevision: 2,
      currentSourceHash: "source-a",
      currentActiveMeetingTask: afterBinding,
    }).reason,
    "expected-parent-revision-mismatch"
  );
  const rebased =
    rebaseSettledAdvisorExecutionPlanAfterOwnedParentMutation({
      plan,
      activeMeetingTask: afterBinding,
    });
  assert.ok(rebased);
  assert.equal(rebased.expectedParentRevision, 4);
  assert.equal(rebased.taskSnapshot?.parent.projectBinding?.projectId, "agentic-memory");
  assert.equal(
    authorizeSettledAdvisorExecutionPlan({
      plan: rebased,
      currentSettlement,
      currentSessionId: "session-a",
      currentRuntimeEpoch: 4,
      currentLogicalQuestionUnitId: "question-a",
      currentLogicalQuestionRevision: 2,
      currentSourceHash: "source-a",
      currentActiveMeetingTask: afterBinding,
    }).authorized,
    true
  );
});

test("replays the July 24 coding to general and AI/ML design route sequence without parent leakage", () => {
  const codingSettlement = settlement();
  const codingTask = activeTask();
  const codingPlan = buildSettledAdvisorExecutionPlan({
    settlement: codingSettlement,
    activeMeetingTask: codingTask,
    taskBoundaryCommitted: true,
    childOwnsResponse: false,
    providerSnapshot: providers,
    playbook: playbook(),
    memoryUseCase: "coding_interview",
    askFrame: "direct-answer",
    topicDomain: "backend",
  });

  const generalSettlement = settlement({
    settlementId: "question_settlement_general",
    logicalQuestionUnitId: "question-general",
    revision: 1,
    sourceHash: "source-general",
    questionType: "general-system-design",
  });
  const generalTask = activeTask("general-system-design", {
    id: "parent-general",
    sourceQuestionUnitId: "question-general",
    sourceQuestionRevision: 1,
    settlementId: generalSettlement.settlementId,
    revisions: 1,
  });
  const generalPlan = buildSettledAdvisorExecutionPlan({
    settlement: generalSettlement,
    activeMeetingTask: generalTask,
    preBoundaryQuestionType: "coding",
    taskBoundaryCommitted: true,
    childOwnsResponse: false,
    providerSnapshot: providers,
    playbook: playbook("general-system-design"),
    memoryUseCase: "system_design_interview",
    askFrame: "hypothetical-design",
    topicDomain: "backend",
  });

  const aiMlSettlement = settlement({
    settlementId: "question_settlement_aiml",
    logicalQuestionUnitId: "question-aiml",
    revision: 1,
    sourceHash: "source-aiml",
    questionType: "ai-ml-system-design",
  });
  const aiMlTask = activeTask("ai-ml-system-design", {
    id: "parent-aiml",
    sourceQuestionUnitId: "question-aiml",
    sourceQuestionRevision: 1,
    settlementId: aiMlSettlement.settlementId,
    revisions: 1,
  });
  const aiMlPlan = buildSettledAdvisorExecutionPlan({
    settlement: aiMlSettlement,
    activeMeetingTask: aiMlTask,
    preBoundaryQuestionType: "general-system-design",
    taskBoundaryCommitted: true,
    childOwnsResponse: false,
    providerSnapshot: providers,
    memoryUseCase: "aiml_system_design_interview",
    askFrame: "hypothetical-design",
    topicDomain: "ai-ml-infra",
  });

  assert.equal(codingPlan.modelRoute.route, "coding-override");
  assert.equal(generalPlan.modelRoute.route, "main");
  assert.equal(generalPlan.responseOwner.questionType, "general-system-design");
  assert.equal(generalPlan.memoryPolicy.useCase, "system_design_interview");
  assert.equal(aiMlPlan.modelRoute.route, "main");
  assert.equal(aiMlPlan.responseOwner.questionType, "ai-ml-system-design");
  assert.equal(
    aiMlPlan.memoryPolicy.useCase,
    "aiml_system_design_interview"
  );

  const staleCodingAuthorization =
    authorizeSettledAdvisorExecutionPlan({
      plan: codingPlan,
      currentSettlement: generalSettlement,
      currentSessionId: "session-a",
      currentRuntimeEpoch: 4,
      currentLogicalQuestionUnitId: "question-general",
      currentLogicalQuestionRevision: 1,
      currentSourceHash: "source-general",
      currentActiveMeetingTask: generalTask,
    });
  assert.equal(staleCodingAuthorization.authorized, false);
  assert.ok(
    staleCodingAuthorization.rejectionReasons.includes(
      "settlement-mismatch"
    )
  );
  assert.ok(
    staleCodingAuthorization.rejectionReasons.includes(
      "logical-question-unit-mismatch"
    )
  );
});
