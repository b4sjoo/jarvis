import assert from "node:assert/strict";
import test from "node:test";
import {
  applyActiveBranchPhase,
  detectCommittedBranchPhaseTransition,
  resolveEffectiveBranchPhase,
} from "../src/lib/meeting/active-branch-phase.js";
import { buildActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import type { CurrentQuestionSettlementDecision } from "../src/lib/meeting/current-question-settlement.js";
import { selectInterviewPlaybook } from "../src/lib/meeting/interview-playbook.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import type { MeetingModelProviderSnapshot } from "../src/lib/meeting/meeting-model-route.js";
import { decidePlaybookPhaseProgression } from "../src/lib/meeting/playbook-phase.js";
import { resolvePostModelContinuityAuthority } from "../src/lib/meeting/post-model-continuity-authority.js";
import {
  buildEffectiveAdvisorSettlementView,
  buildSettledAdvisorExecutionPlan,
} from "../src/lib/meeting/settled-advisor-execution-plan.js";
import {
  createSourceOwnedTransitionCandidate,
  prepareSourceOwnedTransition,
} from "../src/lib/meeting/source-owned-transition-transaction.js";
import {
  commitSourceOwnedTransitionToRuntime,
  resolveSourceOwnedRuntimeTransition,
  sourceOwnedTransitionCommittedFreshCodingChildImplementation,
  sourceOwnedTransitionCommittedFreshParent,
  sourceOwnedTransitionCommittedPhaseIdentityChange,
  type SourceOwnedDurableTransitionReceipt,
} from "../src/lib/meeting/source-owned-transition-runtime.js";
import { commitStableAnswerRevision } from "../src/lib/meeting/stable-answer.js";
import {
  createTaskLifecycleTransaction,
  reduceTaskLifecycleTransaction,
} from "../src/lib/meeting/task-lifecycle-reducer.js";
import type {
  ActiveInterviewParent,
  InterviewPlaybookId,
  InterviewPlaybookPhase,
  SelectedInterviewPlaybook,
} from "../src/lib/meeting/types.js";
import { setTestTaskRuntime } from "./helpers/meeting-task-runtime.js";

const providers: MeetingModelProviderSnapshot = {
  providers: [
    { id: "main", curl: "https://main.test" },
    { id: "coding", curl: "https://coding.test" },
  ],
  selectedProvider: { provider: "main", variables: {} },
  codingProvider: { provider: "coding", variables: {} },
};

test("commits a Coding child with implementation phase and coherent consumers", () => {
  const manager = new MeetingContextManager();
  const parent = makeParent();
  setTestTaskRuntime(manager, { parent });
  const before = manager.getState();
  const currentSettlement = settlement({
    sessionId: before.sessionId,
    questionType: "coding",
    relation: "child-probe",
    relationMutationAuthorized: true,
  });
  const preCommitView = buildEffectiveAdvisorSettlementView({
    settlement: currentSettlement,
    activeMeetingTask: before.activeMeetingTask,
    taskRuntimeRevision: before.taskRuntime.revision,
    fallback: { questionType: "coding", relation: "child-probe" },
  });
  assert.equal(preCommitView.playbook, undefined);
  assert.equal(preCommitView.playbookPhase, undefined);
  assert.equal(preCommitView.phaseOwnerKind, undefined);
  const codingPlaybook = selectInterviewPlaybook({
    query: "Implement the reranker.",
    questionType: preCommitView.questionType,
    activeTaskPlaybook: preCommitView.playbook,
  });
  assert.equal(codingPlaybook?.questionType, "coding");
  const preCommitPhaseDecision = decidePlaybookPhaseProgression({
    questionType: preCommitView.questionType,
    playbookId: codingPlaybook?.id,
    currentPhase: codingPlaybook?.phase,
    currentQuestion: "Implement the reranker.",
    relation: "child-probe",
    subtaskIntent: "implementation-probe",
  });
  assert.equal(preCommitPhaseDecision.action, "child-probe");
  assert.equal(preCommitPhaseDecision.phase, "baseline_reasoning");
  assert.equal(preCommitPhaseDecision.requirementTrack, undefined);
  const candidate = createSourceOwnedTransitionCandidate({
    sessionId: before.sessionId,
    runtimeEpoch: 1,
    source: "voice",
    sourceTurnIds: ["turn-code"],
    logicalQuestionUnitId: "lqu-code",
    logicalQuestionRevision: 1,
    existingTask: parent,
    relation: "child-probe",
    authoritySource: "runtime-relation",
    mutationAuthorized: true,
    questionType: "coding",
    question: "Implement the reranker.",
    subtaskIntent: "implementation-probe",
    playbook: codingPlaybook,
    phaseDecision: preCommitPhaseDecision,
    now: 20,
  });
  assert.ok(candidate);
  const prepared = prepareSourceOwnedTransition({
    candidate,
    currentTask: parent,
    currentSessionId: before.sessionId,
    currentRuntimeEpoch: 1,
    now: 21,
  });
  assert.ok(prepared.task);
  const committed = manager.commitTaskRuntimeTransition({
    id: "attach-code-child",
    transition: "attach-child",
    reason: "test-child-attach",
    expectedRevision: before.taskRuntime.revision,
    parent: prepared.task,
  });
  assert.equal(committed.authorized, true);
  assert.equal(committed.mutationApplied, true);

  const activeTaskAfter = manager.getState().activeMeetingTask;
  assert.ok(activeTaskAfter);
  assert.equal(activeTaskAfter.parent.playbookPhase, "design_framing");
  assert.equal(
    activeTaskAfter.child?.phaseState?.phase,
    "implementation_validation"
  );
  const effective = buildEffectiveAdvisorSettlementView({
    settlement: currentSettlement,
    activeMeetingTask: activeTaskAfter,
    taskRuntimeRevision: manager.getState().taskRuntime.revision,
    fallback: { questionType: "coding", relation: "child-probe" },
  });
  assert.equal(effective.phaseOwnerKind, "child");
  assert.equal(effective.playbookPhase, "implementation_validation");

  const plan = buildSettledAdvisorExecutionPlan({
    settlement: currentSettlement,
    activeMeetingTask: activeTaskAfter,
    expectedActiveMeetingTask: before.activeMeetingTask,
    taskBoundaryCommitted: false,
    childOwnsResponse: true,
    providerSnapshot: providers,
    playbook: effective.playbook,
    memoryUseCase: "coding_interview",
    askFrame: "direct-answer",
    topicDomain: "backend",
    sourceQuestion: "Implement the reranker.",
    subtaskIntent: "implementation-probe",
    explicitTaskMutationCommand: {
      kind: "attach-child",
      type: "coding",
      question: "Implement the reranker.",
    },
    taskMutationCommittedBeforeAdvisor: true,
    artifactRequest: {
      freshCodingChildImplementationCommitted: true,
    },
  });
  assert.equal(plan.responseOwner.source, "authorized-child");
  assert.equal(plan.playbookPhase, "implementation_validation");
  assert.deepEqual(plan.requiredArtifacts, ["answer", "code", "complexity"]);
  assert.equal(plan.artifactPolicy.allowCode, true);
  assert.equal(plan.artifactPolicy.allowComplexity, true);
  assert.equal(
    resolvePostModelContinuityAuthority({
      command: "attach-child",
      lifecycleCommittedBeforeAdvisor: true,
      activeChild: true,
    }).owner,
    "active-child"
  );
});

test("keeps a preserved Coding child follow-up Answer-only through receipt, Plan, and publication", () => {
  const manager = new MeetingContextManager();
  const parent = makeParent({
    whiteboardArtifact: {
      id: "whiteboard-rag",
      parentTaskId: "parent-1",
      domainTrack: "ml_sd",
      archetypeIds: [],
      selectedOverlayIds: [],
      currentPhase: "design_framing",
      title: "RAG architecture",
      content: "Query -> Retriever -> Generator",
      summary: "RAG architecture",
      revision: 1,
      updateSource: "model-output",
      updatedAt: 10,
      createdAt: 10,
    },
  });
  setTestTaskRuntime(manager, { parent });
  const codingPlaybook = selectInterviewPlaybook({
    query: "Implement the reranker.",
    questionType: "coding",
  });
  assert.ok(codingPlaybook);

  const first = commitCodingChildQuestion({
    manager,
    codingPlaybook,
    question: "Implement the reranker.",
    turnId: "turn-code",
    logicalQuestionUnitId: "lqu-code",
  });
  assert.equal(
    sourceOwnedTransitionCommittedFreshCodingChildImplementation(first.receipt),
    true
  );
  const firstTask = manager.getState().activeMeetingTask;
  assert.ok(firstTask?.child);
  const childId = firstTask.child.id;
  const firstSettlement = settlement({
    sessionId: manager.getState().sessionId,
    logicalQuestionUnitId: "lqu-code",
    sourceTurnIds: ["turn-code"],
    sourceHash: "source-code",
    activeParentRevision: first.beforeParentRevision,
  });
  const firstPlan = buildSettledAdvisorExecutionPlan({
    settlement: firstSettlement,
    activeMeetingTask: firstTask,
    taskBoundaryCommitted: false,
    childOwnsResponse: true,
    providerSnapshot: providers,
    playbook: firstTask.child.phaseState?.playbook,
    memoryUseCase: "coding_interview",
    askFrame: "direct-answer",
    topicDomain: "backend",
    sourceQuestion: "Implement the reranker.",
    subtaskIntent: "implementation-probe",
    explicitTaskMutationCommand: {
      kind: "attach-child",
      type: "coding",
      question: "Implement the reranker.",
    },
    taskMutationCommittedBeforeAdvisor: true,
    artifactRequest: {
      freshCodingChildImplementationCommitted:
        sourceOwnedTransitionCommittedFreshCodingChildImplementation(
          first.receipt
        ),
    },
  });
  assert.deepEqual(firstPlan.requestedArtifacts, [
    "answer",
    "code",
    "complexity",
  ]);
  const firstSuggestion = makeCodingSuggestion(
    "first-code",
    "Use an implementation-owned heap.",
    "def rerank(items): return sorted(items)"
  );
  const firstStable = commitStableAnswerRevision({
    candidate: firstSuggestion,
    authorizedArtifacts: firstPlan.requestedArtifacts,
    taskId: parent.id,
    sectionOwner: {
      kind: "active-child",
      parentId: parent.id,
      childId,
    },
    logicalQuestionUnitId: firstSettlement.logicalQuestionUnitId,
    logicalQuestionRevision: firstSettlement.revision,
    sessionId: firstSettlement.sessionId,
    runtimeEpoch: firstSettlement.runtimeEpoch,
    questionSourceHash: firstSettlement.sourceHash,
    settlementId: firstSettlement.settlementId,
    committedAt: 30,
  });
  assert.ok(firstStable);

  const followup = commitCodingChildQuestion({
    manager,
    codingPlaybook,
    question: "Write two tests for the empty input case.",
    turnId: "turn-tests",
    logicalQuestionUnitId: "lqu-tests",
    preserveChildId: childId,
  });
  assert.equal(followup.receipt.sourceResult.reason, "child-probe-preserved");
  assert.equal(
    followup.receipt.sourceResult.childBeforeId,
    followup.receipt.sourceResult.childAfterId
  );
  assert.equal(
    sourceOwnedTransitionCommittedFreshCodingChildImplementation(followup.receipt),
    false
  );
  const followupTask = manager.getState().activeMeetingTask;
  assert.ok(followupTask?.child);
  const followupSettlement = settlement({
    settlementId: "settlement-tests",
    sessionId: manager.getState().sessionId,
    logicalQuestionUnitId: "lqu-tests",
    sourceTurnIds: ["turn-tests"],
    sourceHash: "source-tests",
    activeParentRevision: followup.beforeParentRevision,
  });
  const followupPlan = buildSettledAdvisorExecutionPlan({
    settlement: followupSettlement,
    activeMeetingTask: followupTask,
    taskBoundaryCommitted: false,
    childOwnsResponse: true,
    providerSnapshot: providers,
    playbook: followupTask.child.phaseState?.playbook,
    memoryUseCase: "coding_interview",
    askFrame: "direct-answer",
    topicDomain: "backend",
    sourceQuestion: "Write two tests for the empty input case.",
    subtaskIntent: "implementation-probe",
    explicitTaskMutationCommand: {
      kind: "attach-child",
      type: "coding",
      question: "Write two tests for the empty input case.",
    },
    taskMutationCommittedBeforeAdvisor: true,
    artifactRequest: {
      freshCodingChildImplementationCommitted:
        sourceOwnedTransitionCommittedFreshCodingChildImplementation(
          followup.receipt
        ),
    },
  });
  assert.deepEqual(followupPlan.requestedArtifacts, ["answer"]);
  const followupSuggestion = makeCodingSuggestion(
    "followup-code",
    "Test the empty input without changing the implementation.",
    "def rerank(items): return unintended_replacement(items)"
  );
  const followupStable = commitStableAnswerRevision({
    current: firstStable,
    candidate: followupSuggestion,
    authorizedArtifacts: followupPlan.requestedArtifacts,
    taskId: parent.id,
    sectionOwner: {
      kind: "active-child",
      parentId: parent.id,
      childId,
    },
    logicalQuestionUnitId: followupSettlement.logicalQuestionUnitId,
    logicalQuestionRevision: followupSettlement.revision,
    sessionId: followupSettlement.sessionId,
    runtimeEpoch: followupSettlement.runtimeEpoch,
    questionSourceHash: followupSettlement.sourceHash,
    settlementId: followupSettlement.settlementId,
    committedAt: 40,
  });
  assert.ok(followupStable);
  assert.match(
    followupStable.suggestion.meetingAnswer!.sections.code!,
    /sorted\(items\)/
  );
  assert.doesNotMatch(
    followupStable.suggestion.meetingAnswer!.sections.code!,
    /unintended_replacement/
  );
  assert.equal(
    followupStable.sections.code.revision,
    firstStable.sections.code.revision
  );
  assert.equal(
    manager.getState().taskRuntime.parent?.whiteboardArtifact?.content,
    "Query -> Retriever -> Generator"
  );
});

test("reduces and commits a child-owned phase mutation without changing parent phase", () => {
  const manager = new MeetingContextManager();
  const codingPlaybook = makePlaybook(
    "coding_algorithm",
    "coding",
    "optimized_pseudocode"
  );
  const parent = makeParent({
    child: {
      id: "child-code",
      createdAt: 20,
      updatedAt: 20,
      questionType: "coding",
      relation: "child-probe",
      intent: "implementation-probe",
      question: "Implement the reranker.",
      basedOnTurnIds: ["turn-code"],
      basedOnObservationIds: [],
      phaseState: {
        playbook: codingPlaybook,
        phase: "optimized_pseudocode",
        phaseProgress: { optimized_pseudocode: true },
        revision: 1,
      },
    },
  });
  setTestTaskRuntime(manager, { parent });
  const beforeRuntime = manager.getState();
  const phaseResolution = resolveEffectiveBranchPhase(parent);
  assert.equal(phaseResolution.status, "resolved");
  if (phaseResolution.status !== "resolved") return;
  const afterParent = applyActiveBranchPhase({
    parent,
    owner: phaseResolution.view,
    targetPhase: "implementation_validation",
    phaseProgress: {
      optimized_pseudocode: true,
      implementation_validation: true,
    },
  });
  assert.ok(afterParent);
  const transition = detectCommittedBranchPhaseTransition({
    before: parent,
    after: afterParent,
  });
  assert.equal(transition?.ownerKind, "child");

  const currentSettlement = settlement({
    sessionId: beforeRuntime.sessionId,
    questionType: "coding",
    relation: "child-probe",
  });
  const afterActiveTask = buildActiveMeetingTask({
    parent: afterParent,
    runtimeRevision: beforeRuntime.taskRuntime.revision + 1,
  });
  assert.ok(afterActiveTask);
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: currentSettlement,
    activeMeetingTask: afterActiveTask,
    expectedActiveMeetingTask: beforeRuntime.activeMeetingTask,
    taskBoundaryCommitted: false,
    childOwnsResponse: true,
    providerSnapshot: providers,
    playbook: afterParent.child?.phaseState?.playbook,
    memoryUseCase: "coding_interview",
    askFrame: "direct-answer",
    topicDomain: "backend",
    explicitTaskMutationCommand: {
      kind: "set-phase",
      owner: { kind: "child", id: "child-code" },
      phase: "implementation_validation",
    },
    taskMutationCommittedBeforeAdvisor: true,
  });
  const transaction = createTaskLifecycleTransaction({
    plan,
    manualCorrectionRevision: 0,
    proposedActiveInterviewTask: afterParent,
  });
  const reduction = reduceTaskLifecycleTransaction({
    transaction,
    currentSessionId: beforeRuntime.sessionId,
    currentRuntimeEpoch: currentSettlement.runtimeEpoch,
    currentLogicalQuestionUnitId: currentSettlement.logicalQuestionUnitId,
    currentLogicalQuestionRevision: currentSettlement.revision,
    currentManualCorrectionRevision: 0,
    currentTaskRuntimeRevision: beforeRuntime.taskRuntime.revision,
    currentActiveInterviewTask: parent,
  });
  assert.equal(reduction.authorized, true);
  assert.equal(reduction.mutationApplied, true);
  assert.equal(reduction.parent?.playbookPhase, "design_framing");
  assert.equal(
    reduction.parent?.child?.phaseState?.phase,
    "implementation_validation"
  );

  const runtimeCommit = manager.commitTaskRuntimeTransition({
    id: "set-child-phase",
    transition: "set-phase",
    reason: "test-child-phase",
    expectedRevision: beforeRuntime.taskRuntime.revision,
    parent: reduction.parent,
  });
  assert.equal(runtimeCommit.authorized, true);
  assert.equal(
    manager.getState().taskRuntime.parent?.child?.phaseState?.phase,
    "implementation_validation"
  );
  assert.equal(
    resolvePostModelContinuityAuthority({
      command: "set-phase",
      lifecycleCommittedBeforeAdvisor: true,
      activeChild: true,
      phaseOwnerKind: "child",
    }).owner,
    "active-child"
  );
});

function settlement(
  patch: Partial<CurrentQuestionSettlementDecision> = {}
): CurrentQuestionSettlementDecision {
  return {
    settlementId: "settlement-code",
    logicalQuestionUnitId: "lqu-code",
    revision: 1,
    sessionId: "meeting-session",
    runtimeEpoch: 1,
    sourceKind: "voice",
    sourceTurnIds: ["turn-code"],
    sourceObservationIds: [],
    sourceHash: "source-code",
    questionType: "coding",
    relation: "child-probe",
    action: "answer",
    evidenceMode: "unknown",
    authority: "runtime-adjudication",
    authoritySource: "runtime-adjudication",
    typeAuthoritySource: "runtime-adjudication",
    relationAuthoritySource: "runtime-adjudication",
    actionAuthoritySource: "runtime-adjudication",
    typeMutationAuthorized: true,
    relationMutationAuthorized: true,
    parentMutationAuthorized: false,
    responseAuthorized: true,
    confidence: 0.99,
    activeParentId: "parent-1",
    activeParentRevision: 2,
    manualCorrectionRevision: 0,
    rejectedProposals: [],
    reasons: ["test"],
    ...patch,
  };
}

function makeParent(
  patch: Partial<ActiveInterviewParent> = {}
): ActiveInterviewParent {
  return {
    id: "parent-1",
    source: "voice",
    stableKind: "ai-ml-system-design",
    topic: "Design a RAG system",
    playbook: makePlaybook(
      "aiml_system_design",
      "ai-ml-system-design",
      "design_framing"
    ),
    playbookPhase: "design_framing",
    phaseProgress: { design_framing: true },
    supportedFactAnchors: [],
    createdAt: 10,
    updatedAt: 10,
    revisions: 2,
    ...patch,
  };
}

function makePlaybook(
  id: InterviewPlaybookId,
  questionType: SelectedInterviewPlaybook["questionType"],
  phase: InterviewPlaybookPhase
): SelectedInterviewPlaybook {
  return {
    id,
    label: "Test playbook",
    phase,
    questionType,
    confidence: 1,
    reason: "test",
    memoryPolicy: { id: "test" },
    firstMove: "test",
    clarifyingStrategy: "test",
    outputContract: "test",
    followUpPolicy: "test",
  };
}

function commitCodingChildQuestion(input: {
  manager: MeetingContextManager;
  codingPlaybook: SelectedInterviewPlaybook;
  question: string;
  turnId: string;
  logicalQuestionUnitId: string;
  preserveChildId?: string;
}) {
  const before = input.manager.getState();
  const beforeParent = before.taskRuntime.parent;
  assert.ok(beforeParent);
  const candidate = createSourceOwnedTransitionCandidate({
    sessionId: before.sessionId,
    runtimeEpoch: 1,
    source: "voice",
    sourceTurnIds: [input.turnId],
    logicalQuestionUnitId: input.logicalQuestionUnitId,
    logicalQuestionRevision: 1,
    existingTask: beforeParent,
    preserveChildId: input.preserveChildId,
    relation: "child-probe",
    authoritySource: "runtime-relation",
    mutationAuthorized: true,
    questionType: "coding",
    question: input.question,
    subtaskIntent: "implementation-probe",
    playbook: input.codingPlaybook,
  });
  assert.ok(candidate);
  const receipt = commitSourceOwnedTransitionToRuntime({
    candidate,
    runtimeBefore: before.taskRuntime,
    expectedTaskRuntimeRevision: before.taskRuntime.revision,
    currentSessionId: before.sessionId,
    currentRuntimeEpoch: 1,
    commitRuntime: ({
      sourceResult,
      runtimeBefore,
      expectedTaskRuntimeRevision,
    }) => {
      const runtimeTransition = resolveSourceOwnedRuntimeTransition({
        sourceResult,
        runtimeBefore,
      });
      const runtimeResult = input.manager.commitTaskRuntimeTransition({
        id: `commit-${input.logicalQuestionUnitId}`,
        transition: runtimeTransition,
        reason: "test-source-owned-child",
        expectedRevision: expectedTaskRuntimeRevision,
        parent: sourceResult.task,
        screenAttachment: runtimeBefore.screenAttachment,
      });
      return { runtimeResult, runtimeTransition };
    },
  });
  assert.equal(receipt.runtimeResult?.authorized, true);
  return {
    receipt,
    beforeParentRevision: beforeParent.revisions,
  } satisfies {
    receipt: SourceOwnedDurableTransitionReceipt;
    beforeParentRevision: number;
  };
}

function makeCodingSuggestion(id: string, answer: string, code: string) {
  const content = [
    `Answer: ${answer}`,
    "Approach: Keep the current implementation contract.",
    "Code:",
    "```python",
    code,
    "```",
    "Complexity: O(n log n) time and O(n) space.",
    "Whiteboard: -",
  ].join("\n");
  return {
    id,
    kind: "answer" as const,
    content,
    meetingAnswer: parseMeetingAnswer(content, { expectedProfile: "coding" }),
    createdAt: 20,
    basedOnTurnIds: [],
    basedOnObservationIds: [],
    confidence: "high" as const,
  };
}
