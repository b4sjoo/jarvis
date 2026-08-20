import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import type { CurrentQuestionSettlementDecision } from "../src/lib/meeting/current-question-settlement.js";
import type { MeetingModelProviderSnapshot } from "../src/lib/meeting/meeting-model-route.js";
import { adaptQuestionTypePrior } from "../src/lib/meeting/question-type-consumer-observation.js";
import {
  authorizeSettledAdvisorExecutionPlan,
  buildSettledAdvisorExecutionPlan,
  formatSettledAdvisorExecutionPlanForTrace,
  rebaseSettledAdvisorExecutionPlanAfterOwnedParentMutation,
} from "../src/lib/meeting/settled-advisor-execution-plan.js";
import {
  primaryAskAnswerFocusText,
  primaryAskClassifierText,
  projectPrimaryAsk,
} from "../src/lib/meeting/primary-ask-projection.js";
import { createResponseOnlyTaskScope } from "../src/lib/meeting/response-only-task-scope.js";
import { decideCrossTypeTaskRelationAuthority } from "../src/lib/meeting/task-relation-authority.js";
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
  assert.equal(plan.artifactPolicy.allowCode, true);
  assert.deepEqual(plan.requiredArtifacts, [
    "answer",
    "code",
    "complexity",
  ]);
  assert.equal(plan.artifactPolicy.allowWhiteboard, false);
  assert.equal(plan.factAnchorPolicy.policyId, "not-required");
  assert.equal(plan.responseIntent, "advise");
  assert.equal(plan.contextReadScope, "active-parent-read");
  assert.equal(plan.artifactIntent, "revise-code");
  assert.deepEqual(plan.taskMutationPolicy, {
    kind: "create-parent",
    type: "coding",
    topic: "Implement a queue.",
  });

  task.parent.questionType = "behavioral";
  assert.equal(plan.taskSnapshot?.parent.questionType, "coding");
  assert.equal(Object.isFrozen(plan.taskSnapshot?.parent), true);
});

test("response-only plan routes from the current question without exposing parent state", () => {
  const preservedTask = activeTask("ai-ml-system-design");
  const responseOnlySettlement = settlement({
    questionType: "coding",
    relation: "unknown",
    relationAuthoritySource: "provisional",
    relationMutationAuthorized: false,
    parentMutationAuthorized: false,
  });
  const responseOnlyTaskScope = createResponseOnlyTaskScope({
    logicalQuestionUnitId:
      responseOnlySettlement.logicalQuestionUnitId,
    revision: responseOnlySettlement.revision,
    sourceQuestion: "Implement a standalone stack.",
    sourceTurnIds: ["turn-a"],
    inferredType: "coding",
    relationDisposition: "ambiguous",
    preservedParent: preservedTask,
    now: 100,
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
    responseOnlyTaskScope,
    createdAt: 100,
  });

  assert.equal(plan.questionType, "coding");
  assert.equal(plan.responseOwner.source, "current-question");
  assert.equal(plan.modelRoute.route, "coding-override");
  assert.equal(plan.taskSnapshot, undefined);
  assert.equal(plan.expectedParentId, preservedTask.parent.id);
  assert.equal(
    plan.expectedParentRevision,
    preservedTask.parent.revisions
  );
  assert.equal(
    plan.responseOnlyTaskScope?.scopeId,
    responseOnlyTaskScope.scopeId
  );
  assert.equal(plan.artifactPolicy.allowCode, false);
  assert.equal(plan.artifactPolicy.allowWhiteboard, false);
  assert.equal(plan.artifactPolicy.allowParentContextMutation, false);
  assert.equal(
    plan.artifactPolicy.disposition,
    "display-only-parent-continuity"
  );
  assert.equal(plan.responseIntent, "advise");
  assert.equal(plan.contextReadScope, "current-only");
  assert.equal(plan.artifactIntent, "preserve");
  assert.deepEqual(plan.taskMutationPolicy, { kind: "preserve" });
});

test("same-domain current-only repair keeps parent phase read-only without lending it to the response Playbook", () => {
  const preservedTask = activeTask("general-system-design", {
    playbookPhase: "design_framing",
  });
  const repairedSettlement = settlement({
    questionType: "ai-ml-system-design",
    relation: "unknown",
    typeAuthoritySource: "llm-type-repair",
    relationAuthoritySource: "provisional",
    relationMutationAuthorized: false,
    parentMutationAuthorized: false,
  });
  const responseOnlyTaskScope = createResponseOnlyTaskScope({
    logicalQuestionUnitId: repairedSettlement.logicalQuestionUnitId,
    revision: repairedSettlement.revision,
    sourceQuestion: "How does the retrieval tier scale?",
    sourceTurnIds: ["turn-a"],
    inferredType: "ai-ml-system-design",
    relationDisposition: "ambiguous",
    preservedParent: preservedTask,
    now: 100,
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
    responseOnlyTaskScope,
    createdAt: 100,
  });

  assert.equal(plan.taskSnapshot, undefined);
  assert.equal(plan.playbookPhase, "requirement_clarification");
  assert.equal(plan.responsePlaybook?.questionType, "ai-ml-system-design");
  assert.equal(plan.responsePlaybook?.phase, "requirement_clarification");
  assert.equal(plan.parentTrajectoryPlaybook, undefined);
  assert.equal(
    plan.responseOnlyTaskScope?.readOnlyParentContinuity?.playbookPhase,
    "design_framing"
  );
  assert.equal(plan.artifactIntent, "preserve");
  assert.equal(plan.artifactPolicy.allowWhiteboard, false);
  assert.equal(
    plan.responseOnlyTaskScope?.readOnlyParentContinuity
      ?.artifactOwnerParentId,
    preservedTask.parent.id
  );
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
});

test("a precommitted runtime boundary remains the creating-parent lifecycle fact when settlement is answer-only", () => {
  const repairedSettlement = settlement({
    questionType: "coding",
    relation: "unknown",
    typeAuthoritySource: "llm-type-repair",
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
  const designSettlement = settlement({
    questionType: "general-system-design",
  });
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: designSettlement,
    activeMeetingTask: activeTask("general-system-design"),
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
  const relation = decideCrossTypeTaskRelationAuthority({
    activeQuestionType: "general-system-design",
    candidateQuestionType: "field-knowledge",
    currentText: semanticEvidenceText,
  });

  assert.equal(
    answerFocusText,
    "explain which components need to change."
  );
  assert.match(semanticEvidenceText, /add a surge pricing/i);
  assert.equal(relation?.relation, "followup-parent");
  assert.equal(relation?.relationEvidenceAuthorized, true);

  const plan = buildSettledAdvisorExecutionPlan({
    settlement: settlement({
      questionType: "general-system-design",
      relation: relation?.relation ?? "unknown",
      typeMutationAuthorized: false,
      relationMutationAuthorized: false,
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
    "active-parent-read"
  );
  assert.equal(trace.settledExecutionPlanArtifactIntent, "revise-code");
  assert.deepEqual(trace.settledExecutionPlanRequiredArtifacts, [
    "answer",
    "code",
    "complexity",
  ]);
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
