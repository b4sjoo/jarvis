import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import type { CurrentQuestionSettlementDecision } from "../src/lib/meeting/current-question-settlement.js";
import type { MeetingModelProviderSnapshot } from "../src/lib/meeting/meeting-model-route.js";
import {
  authorizeSettledAdvisorExecutionPlan,
  buildSettledAdvisorExecutionPlan,
  formatSettledAdvisorExecutionPlanForTrace,
} from "../src/lib/meeting/settled-advisor-execution-plan.js";
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
    source: "voice",
    parent: {
      id: "parent-a",
      questionType,
      topic: "Implement a queue",
      playbookPhase:
        questionType === "coding"
          ? "solution_planning"
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
        ? "solution_planning"
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
    playbook: playbook(),
    memoryUseCase: "coding_interview",
    askFrame: "direct-answer",
    topicDomain: "backend",
    createdAt: 100,
  });

  assert.equal(plan.responseOwner.questionType, "coding");
  assert.equal(plan.responseOwner.source, "committed-parent");
  assert.equal(plan.modelRoute.route, "coding-override");
  assert.equal(plan.promptContract.profile, "coding");
  assert.equal(plan.memoryPolicy.questionType, "coding");
  assert.equal(plan.memoryPolicy.retrievalPolicyId, "coding");
  assert.equal(plan.artifactPolicy.allowCode, true);
  assert.equal(plan.artifactPolicy.allowWhiteboard, false);
  assert.equal(plan.factAnchorPolicy.policyId, "not-required");

  task.parent.questionType = "behavioral";
  assert.equal(plan.taskSnapshot?.parent.questionType, "coding");
  assert.equal(Object.isFrozen(plan.taskSnapshot?.parent), true);
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
  assert.equal(plan.playbookPhase, "solution_planning");
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
    playbook: playbook(),
    memoryUseCase: "coding_interview" as const,
    askFrame: "direct-answer" as const,
    topicDomain: "backend" as const,
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
