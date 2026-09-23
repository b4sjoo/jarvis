import assert from "node:assert/strict";
import test from "node:test";
import { buildActiveMeetingTask, getActiveMeetingTaskTraceMetadata } from "../src/lib/meeting/active-meeting-task.js";
import { buildAdvisorUserMessage } from "../src/lib/meeting/advisor-prompt.js";
import {
  authorizeSettlementOwnedQuestionContext,
  createProvisionalCurrentQuestion,
  formatCurrentQuestionSettlementForTrace,
  settleCurrentQuestion,
} from "../src/lib/meeting/current-question-settlement.js";
import {
  createEffectiveQuestionSourceRecord,
  EffectiveQuestionSourceLedger,
  resolveRevisionStableTopologyBinding,
} from "../src/lib/meeting/effective-question-source-ledger.js";
import { buildHumanEvaluationObservedSnapshotV2 } from "../src/lib/meeting/human-ground-truth-v2.js";
import { materializeHumanEvaluationAttemptProjectionV2 } from "../src/lib/meeting/human-evaluation-attempt-projection.js";
import { selectInterviewPlaybook } from "../src/lib/meeting/interview-playbook.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import type { MeetingAssistantState } from "../src/lib/meeting/meeting-context-contracts.js";
import {
  authorizeManualCorrectionLifecycle,
  settleManualQuestionTypeCorrection,
} from "../src/lib/meeting/manual-correction-settlement.js";
import {
  buildManualCorrectionParentTransition,
  decideManualCorrectionScope,
  decideManualCorrectionTerminalState,
  decideManualQuestionTypeCorrection,
} from "../src/lib/meeting/manual-question-type-correction.js";
import { compileSettledAdvisorPromptContext } from "../src/lib/meeting/settled-advisor-context.js";
import {
  authorizeSettledAdvisorExecutionPlan,
  buildEffectiveAdvisorSettlementView,
  buildSettledAdvisorExecutionPlan,
  formatEffectiveAdvisorSettlementViewForTrace,
  formatSettledAdvisorExecutionPlanForTrace,
  type TaskLifecycleCommand,
} from "../src/lib/meeting/settled-advisor-execution-plan.js";
import {
  createTaskLifecycleTransaction,
  formatTaskLifecycleReductionForTrace,
  reduceTaskLifecycleTransaction,
} from "../src/lib/meeting/task-lifecycle-reducer.js";
import { evaluateTaskSettlementTupleCompatibilityV2 } from "../src/lib/meeting/task-settlement-tuple.js";
import {
  restoreSuggestionProjectionAfterFailedManualCorrection,
  stageSuggestionProjectionForManualCorrection,
} from "../src/lib/meeting/suggestion-task.js";
import type { ActiveInterviewParent, AdvisorSuggestion, MeetingTrace, TranscriptTurn } from "../src/lib/meeting/types.js";

const sessionId = "session-a2-synthetic";
const runtimeEpoch = 4;
const providers = { providers: [], selectedProvider: { provider: "unused", variables: {} }, codingProvider: { provider: "unused", variables: {} } };
const rootText = "Design a production RAG system with tenant isolation and access control.";
const resumeText = "Back to the RAG architecture: explain the indexing and serving path.";

function unit(id: string, text: string, at: number): LogicalQuestionUnit {
  return {
    id, revision: 1, sessionId, runtimeEpoch,
    currentTurnId: `turn-${id}`, sourceTurnIds: [`turn-${id}`],
    sources: [{ turnId: `turn-${id}`, text, startedAt: at, endedAt: at + 1 }],
    normalizedText: text, startedAt: at, updatedAt: at + 1,
    compositionReasons: ["fresh-substantive-turn"], boundaryReason: "fresh-substantive-turn", truncated: false,
  };
}

function task(parent: ActiveInterviewParent, runtimeRevision = parent.revisions) {
  return buildActiveMeetingTask({ parent, runtimeRevision })!;
}

function recordQuestion(
  ledger: EffectiveQuestionSourceLedger,
  question: LogicalQuestionUnit,
  settlement: Parameters<typeof buildEffectiveAdvisorSettlementView>[0]["settlement"],
  parent: ActiveInterviewParent,
) {
  const effective = buildEffectiveAdvisorSettlementView({
    settlement, activeMeetingTask: task(parent), taskRuntimeRevision: parent.revisions,
    fallback: { questionType: parent.stableKind, relation: "unknown" },
  }).effectiveSettlement;
  assert.ok(effective);
  const record = createEffectiveQuestionSourceRecord({
    logicalQuestionUnit: question, settlement: effective, activeMeetingTask: task(parent), settledAt: question.updatedAt,
  });
  assert.ok(record);
  ledger.upsert(record);
}

function automaticSettlement(
  question: LogicalQuestionUnit,
  parent: ActiveInterviewParent,
  relation: "new-parent" | "child-probe" | "resume-parent",
  questionType: "ai-ml-system-design" | "coding",
  sourceKind: "voice" | "screen" = "voice",
) {
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: question, sourceKind,
    sourceObservationIds: sourceKind === "screen" ? ["exact-resume-observation"] : [],
  });
  return settleCurrentQuestion({
    operationId: question.id, currentQuestion, activeParentId: parent.id, activeParentRevision: parent.revisions,
    manualCorrectionRevision: 0,
    deterministicProposal: {
      source: "deterministic-fast-path", sessionId, runtimeEpoch, logicalQuestionUnitId: question.id,
      revision: question.revision, sourceHash: currentQuestion.sourceHash, questionType, relation, action: "answer",
      confidence: 1, typeEvidenceAuthorized: true, relationEvidenceAuthorized: true, actionEvidenceAuthorized: true,
      expectedParentId: parent.id, expectedParentRevision: parent.revisions, reasons: ["synthetic-source-transition"],
    },
    policy: { runtimeMutationAuthorized: true, questionComplete: true, commitParent: true },
  });
}

// Establish the historical resume through the real lifecycle reducer, then bind it
// from the same production ledger reader used by Type Correction.
function resumedFixture(sourceKind: "voice" | "screen" = "voice") {
  const root = unit("rag-origin", rootText, 10);
  const coding = unit("coding-child", "Implement the RAG cache eviction helper.", 20);
  const resumed = unit("rag-resume", resumeText, 30);
  const rootPlaybook = selectInterviewPlaybook({ questionType: "ai-ml-system-design", query: rootText })!;
  const rootParent: ActiveInterviewParent = {
    id: "parent-rag", source: "voice", stableKind: "ai-ml-system-design", topic: rootText,
    startTurnId: root.currentTurnId, promptTranscriptStartTurnId: root.currentTurnId,
    originQuestionId: `lqu:${root.id}`, canonicalQuestionSourceTurnIds: root.sourceTurnIds,
    sourceQuestionUnitId: root.id, sourceQuestionRevision: root.revision,
    settlementId: "settlement-rag-origin", playbook: rootPlaybook, playbookPhase: rootPlaybook.phase,
    phaseProgress: { architecture_decision: true }, supportedFactAnchors: [],
    createdAt: 10, updatedAt: 10, revisions: 2,
    whiteboardArtifact: {
      id: "rag-whiteboard", parentTaskId: "parent-rag", domainTrack: "ml_sd",
      archetypeIds: [], selectedOverlayIds: [], currentPhase: "design_framing", title: "RAG architecture",
      content: "Client -> Retrieval -> Model", summary: "Original RAG diagram", revision: 1,
      updateSource: "model-output", createdAt: 10, updatedAt: 10,
    },
  };
  const ledger = new EffectiveQuestionSourceLedger();
  recordQuestion(ledger, root, automaticSettlement(root, rootParent, "new-parent", "ai-ml-system-design"), rootParent);
  function transition(before: ActiveInterviewParent, after: ActiveInterviewParent, question: LogicalQuestionUnit,
    relation: "child-probe" | "resume-parent", command: TaskLifecycleCommand) {
    const settlement = automaticSettlement(question, before, relation, relation === "child-probe" ? "coding" : "ai-ml-system-design",
      relation === "resume-parent" ? sourceKind : "voice");
    const plan = buildSettledAdvisorExecutionPlan({
      settlement, activeMeetingTask: task(after), expectedActiveMeetingTask: task(before),
      preBoundaryQuestionType: before.stableKind, taskBoundaryCommitted: false,
      childOwnsResponse: relation === "child-probe", providerSnapshot: providers,
      memoryUseCase: "aiml_system_design_interview", askFrame: "hypothetical-design", topicDomain: "ai-ml-infra",
      sourceQuestion: question.normalizedText, explicitTaskMutationCommand: command,
    });
    const reduction = reduceTaskLifecycleTransaction({
      transaction: createTaskLifecycleTransaction({ plan, manualCorrectionRevision: 0, proposedActiveInterviewTask: after }),
      currentSessionId: sessionId, currentRuntimeEpoch: runtimeEpoch, currentLogicalQuestionUnitId: question.id,
      currentLogicalQuestionRevision: question.revision, currentManualCorrectionRevision: 0,
      currentTaskRuntimeRevision: before.revisions, currentActiveInterviewTask: before,
    });
    assert.equal(reduction.reason, "committed");
    assert.ok(reduction.parent);
    recordQuestion(ledger, question, settlement, reduction.parent);
    return reduction.parent;
  }
  const withChild = transition(rootParent, {
    ...rootParent, revisions: 3, updatedAt: 20,
    child: { id: "child-code", questionType: "coding", relation: "child-probe", intent: "implementation-probe",
      question: coding.normalizedText, basedOnTurnIds: coding.sourceTurnIds, basedOnObservationIds: [], createdAt: 20, updatedAt: 20 },
  }, coding, "child-probe", { kind: "attach-child", type: "coding", question: coding.normalizedText });
  const parent = transition(withChild, { ...withChild, child: undefined, revisions: 4, updatedAt: 30 }, resumed,
    "resume-parent", { kind: "resume-parent" });
  assert.equal(parent.child, undefined);
  return { root, coding, resumed, rootParent, withChild, parent, ledger };
}

function correctionFixture(sourceKind: "voice" | "screen" = "voice") {
  const fixture = resumedFixture(sourceKind);
  const { parent, ledger, resumed } = fixture;
  const binding = resolveRevisionStableTopologyBinding({
    records: ledger.listHistory(), logicalQuestionUnit: resumed, activeMeetingTask: task(parent),
  });
  assert.equal(binding?.relation, "resume-parent");
  assert.deepEqual(binding?.owner, { kind: "parent-mainline", parentId: parent.id });
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: resumed, sourceKind, sourceObservationIds: sourceKind === "screen" ? ["exact-resume-observation"] : [],
  });
  const relationCandidate = { schemaVersion: 3 as const, relation: "followup-parent" as const, confidence: 0.95,
    currentQuestionEvidenceSpans: ["RAG architecture"], parentEvidenceSpans: ["RAG system"] };
  const { settlement: initialSettlement } = settleManualQuestionTypeCorrection({
    operationId: "manual-resume-retype", currentQuestion, correctedType: "general-system-design",
    activeParentId: parent.id, activeParentRevision: parent.revisions, manualCorrectionRevision: 1,
    relationCandidate, relationOperationLeaseAuthorized: true,
    revisionStableRelation: binding?.relation, revisionStableRelationReason: binding?.source,
  });
  const decision = decideManualQuestionTypeCorrection(task(parent), "general-system-design");
  const lineage = { questionInstanceId: `lqu:${resumed.id}`, triggerTurnId: resumed.currentTurnId,
    sessionId, runtimeEpoch, questionOriginTraceId: "resume-trace", identityState: "canonical" as const };
  const scope = decideManualCorrectionScope({
    task: task(parent), decision, lineage, latestQuestionText: resumeText,
    currentQuestionRelation: initialSettlement.relation, currentQuestionSource: sourceKind,
  });
  assert.equal(scope.scope, "same-question-retype");
  const settlement = authorizeManualCorrectionLifecycle({
    settlement: initialSettlement, scope: scope.scope, activeParentId: parent.id, activeParentType: parent.stableKind,
  });
  assert.equal(settlement.parentMutationAuthorized, true);
  const correctedPlaybook = selectInterviewPlaybook({
    questionType: decision.correctedType, query: `${parent.topic}\n${resumeText}`, askFrame: "hypothetical-design",
  })!;
  const transition = buildManualCorrectionParentTransition({
    parent, decision, scopeDecision: scope, correctedPlaybook, latestQuestionText: resumeText,
    lineage, transcriptTurns: [], newParentId: "must-not-create", now: 40,
  });
  const after = { ...transition.parent, settlementId: settlement.settlementId };
  const plan = buildSettledAdvisorExecutionPlan({
    settlement, activeMeetingTask: task(after), expectedActiveMeetingTask: task(parent),
    preBoundaryQuestionType: parent.stableKind, taskBoundaryCommitted: true, childOwnsResponse: false,
    providerSnapshot: providers, playbook: correctedPlaybook, memoryUseCase: "system_design_interview",
    askFrame: "hypothetical-design", topicDomain: "backend", sourceQuestion: resumeText, parentSourceQuestion: parent.topic,
    contextReadScopeOverride: "active-parent-read", explicitTaskMutationCommand: { kind: "replace-parent", type: after.stableKind, topic: after.topic },
    taskMutationCommittedBeforeAdvisor: true, artifactRequest: { manualCorrection: true },
  });
  const input = {
    transaction: createTaskLifecycleTransaction({ plan, manualCorrectionRevision: 1, proposedActiveInterviewTask: after }),
    currentSessionId: sessionId, currentRuntimeEpoch: runtimeEpoch, currentLogicalQuestionUnitId: resumed.id,
    currentLogicalQuestionRevision: resumed.revision, currentManualCorrectionRevision: 1,
    currentTaskRuntimeRevision: parent.revisions, currentActiveInterviewTask: parent,
  };
  return { ...fixture, binding, initialSettlement, settlement, scope, transition, after, plan, input, relationCandidate };
}

for (const sourceKind of ["voice", "screen"] as const) {
  test(`A2 ${sourceKind}: stable resume binding composes to one same-ID retype and evaluation receipt`, () => {
    const f = correctionFixture(sourceKind);
    const source = authorizeSettlementOwnedQuestionContext({
      sourceKind: f.settlement.sourceKind, sourceObservationIds: f.settlement.sourceObservationIds,
      logicalQuestionText: f.resumed.normalizedText,
      screenObservations: [{ id: "exact-resume-observation", imageBase64: "synthetic-image" }],
    });
    assert.equal(source.authorized, true);
    const reduction = reduceTaskLifecycleTransaction(f.input);
    assert.equal(reduction.reason, "committed");
    assert.equal(reduction.mutationApplied, true);
    assert.equal(reduction.parent?.id, f.parent.id);
    assert.equal(reduction.parent?.stableKind, "general-system-design");
    assert.equal(reduction.parent?.revisions, 5);
    assert.equal(f.plan.questionType, "general-system-design");
    assert.equal(f.plan.relation, "resume-parent");
    assert.equal(f.plan.taskMutationPolicy.kind, "replace-parent");
    assert.equal(f.plan.taskMutationCommittedBeforeAdvisor, true);
    assert.equal(f.transition.startedNewParent, false);
    const authorization = authorizeSettledAdvisorExecutionPlan({
      plan: f.plan, currentSettlement: f.settlement, currentSessionId: sessionId, currentRuntimeEpoch: runtimeEpoch,
      currentLogicalQuestionUnitId: f.resumed.id, currentLogicalQuestionRevision: f.resumed.revision,
      currentSourceHash: f.settlement.sourceHash, currentActiveMeetingTask: reduction.activeMeetingTask,
    });
    assert.equal(authorization.authorized, true);
    const effectiveView = buildEffectiveAdvisorSettlementView({
      settlement: f.settlement, activeMeetingTask: reduction.activeMeetingTask, taskRuntimeRevision: 5,
      fallback: { questionType: "unknown", relation: "unknown" },
    });
    const trace: MeetingTrace = {
      id: "a2-correction-trace", kind: sourceKind, status: "success", startedAt: 40, inputs: [], outputs: [], steps: [],
      metadata: { ...formatCurrentQuestionSettlementForTrace(f.settlement),
        ...formatEffectiveAdvisorSettlementViewForTrace(effectiveView),
        ...formatSettledAdvisorExecutionPlanForTrace(f.plan, authorization), ...formatTaskLifecycleReductionForTrace(reduction),
        ...getActiveMeetingTaskTraceMetadata(reduction.activeMeetingTask!),
        manualCorrectionRelationCandidate: f.relationCandidate.relation,
        manualCorrectionRelationCandidateConfidence: f.relationCandidate.confidence },
    };
    const observed = buildHumanEvaluationObservedSnapshotV2(trace);
    assert.equal(observed.questionType, "general-system-design");
    assert.equal(observed.observedParentType, "general-system-design");
    assert.equal(observed.observedParentId, f.parent.id);
    assert.equal(observed.relation, "resume-parent");
    assert.equal(observed.parentAction, "retype");
    assert.equal(evaluateTaskSettlementTupleCompatibilityV2({ relation: observed.relation!, parentAction: observed.parentAction! }).compatible, true);
    assert.deepEqual(buildHumanEvaluationObservedSnapshotV2(JSON.parse(JSON.stringify(trace))), observed);
    const materialized = materializeHumanEvaluationAttemptProjectionV2({
      trace, currentSessionId: sessionId, events: [], projections: [], now: 50,
    });
    assert.equal(materialized.reason, "created");
    assert.equal(materialized.projection?.observed?.parentAction, "retype");
    assert.deepEqual(materialized.projection?.observed, observed);
    const reread = materializeHumanEvaluationAttemptProjectionV2({
      trace: JSON.parse(JSON.stringify(trace)), currentSessionId: sessionId, events: [],
      projections: JSON.parse(JSON.stringify(materialized.projections)), now: 60,
    });
    assert.deepEqual(reread.projection?.observed, materialized.projection?.observed);
    assert.equal(reread.projection?.subject.attemptId, materialized.projection?.subject.attemptId);
    assert.equal(trace.metadata?.manualCorrectionRelationCandidate, "followup-parent");
    const duplicate = reduceTaskLifecycleTransaction({ ...f.input, currentActiveInterviewTask: reduction.parent!, currentTaskRuntimeRevision: 5 });
    assert.equal(duplicate.mutationApplied, false);
    assert.equal(duplicate.reason, "parent-revision-mismatch");
  });
}

test("A2 preserves parent origin/history and compiles General SD prompt with only authorized parent context", () => {
  const f = correctionFixture();
  const history = f.ledger.listHistory();
  const reduction = reduceTaskLifecycleTransaction(f.input);
  assert.equal(reduction.reason, "committed");
  const after = reduction.parent!;
  for (const key of ["id", "topic", "source", "originQuestionId", "startTurnId", "promptTranscriptStartTurnId",
    "sourceQuestionUnitId", "sourceQuestionRevision", "canonicalQuestionSourceTurnIds", "createdAt"] as const) {
    assert.deepEqual(after[key], f.parent[key], key);
  }
  assert.equal(after.whiteboardArtifact, undefined);
  assert.deepEqual(after.phaseProgress, { [after.playbookPhase]: true });
  assert.equal(after.playbook?.questionType, "general-system-design");
  assert.equal(f.plan.playbook?.questionType, "general-system-design");
  assert.equal(f.plan.contextReadScope, "active-parent-read");
  assert.equal(f.plan.artifactPolicy.allowCode, false);
  assert.equal(f.plan.memoryPolicy.useCase, "system_design_interview");
  assert.equal(f.plan.memoryPolicy.questionType, "general-system-design");
  assert.equal(f.plan.memoryPolicy.retrievalPolicyId, f.plan.playbook?.memoryPolicy.id);
  recordQuestion(f.ledger, f.resumed, f.settlement, after);
  assert.deepEqual(f.ledger.listHistory().filter((r) => r.logicalQuestionUnitId !== f.resumed.id),
    history.filter((r) => r.logicalQuestionUnitId !== f.resumed.id));
  assert.equal(f.ledger.findLogicalQuestion({ sessionId, runtimeEpoch, logicalQuestionUnitId: f.resumed.id,
    logicalQuestionRevision: f.resumed.revision })?.relation, "resume-parent");
  const turns: TranscriptTurn[] = [f.root, f.coding, f.resumed, unit("unrelated", "Unrelated private salary discussion.", 35)].map((q) => ({
    id: q.currentTurnId, text: q.normalizedText, startedAt: q.startedAt, endedAt: q.updatedAt,
    speaker: "them", isFinal: true, source: "system-audio",
  }));
  const compilation = compileSettledAdvisorPromptContext({
    baseContext: { transcript: turns.map((t) => t.text).join("\n"), screenContext: "", rollingSummary: "",
      userProfileContext: "", glossaryText: "", taskRuntime: { revision: 5 }, activeMeetingTask: reduction.activeMeetingTask,
      interviewPlaybook: f.plan.playbook, latestTurn: turns[2] },
    contextReadScope: f.plan.contextReadScope, logicalQuestionUnit: f.resumed, transcriptTurns: turns,
    effectiveRecords: f.ledger.list(), sessionId, runtimeEpoch,
  });
  const prompt = buildAdvisorUserMessage(compilation.context);
  assert.match(prompt, /questionType: general-system-design/);
  assert.ok(prompt.includes(rootText));
  assert.ok(prompt.includes(resumeText));
  assert.doesNotMatch(prompt, /Unrelated private salary|Implement the RAG cache/);
  assert.deepEqual(new Set(compilation.selectedSourceTurnIds), new Set([f.root.currentTurnId, f.resumed.currentTurnId]));
});

test("A2 rejects parent, session, source and correction revision races before lifecycle mutation", () => {
  const f = correctionFixture();
  const cases = [
    [{ currentActiveInterviewTask: { ...f.parent, id: "new-owner" } }, "parent-id-mismatch"],
    [{ currentActiveInterviewTask: { ...f.parent, revisions: 5 } }, "parent-revision-mismatch"],
    [{ currentActiveInterviewTask: undefined }, "parent-id-mismatch"],
    [{ currentRuntimeEpoch: runtimeEpoch + 1 }, "runtime-epoch-mismatch"],
    [{ currentSessionId: "cleared-session" }, "session-mismatch"],
    [{ currentLogicalQuestionUnitId: "new-question" }, "logical-question-unit-mismatch"],
    [{ currentLogicalQuestionRevision: 2 }, "logical-question-revision-mismatch"],
    [{ currentManualCorrectionRevision: 2 }, "manual-correction-revision-mismatch"],
  ] as const;
  for (const [change, reason] of cases) {
    const input = { ...f.input, ...change };
    const result = reduceTaskLifecycleTransaction(input);
    assert.equal(result.reason, reason);
    assert.equal(result.mutationApplied, false);
    assert.deepEqual(result.parent, input.currentActiveInterviewTask);
  }
  assert.equal(authorizeSettledAdvisorExecutionPlan({
    plan: f.plan, currentSettlement: f.settlement, currentSessionId: sessionId, currentRuntimeEpoch: runtimeEpoch,
    currentLogicalQuestionUnitId: f.resumed.id, currentLogicalQuestionRevision: 1,
    currentSourceHash: "replaced-source", currentActiveMeetingTask: task(f.parent), stage: "pre-task-mutation",
  }).authorized, false);
});

test("A2 retains the committed Type on regeneration failure and permits the existing retry path", () => {
  const f = correctionFixture();
  const reliable: AdvisorSuggestion = {
    id: "reliable-rag-answer", kind: "answer", content: "Preserve tenant isolation at retrieval and serving.",
    questionType: "ai-ml-system-design", parentTaskId: f.parent.id, createdAt: 30,
    basedOnTurnIds: f.resumed.sourceTurnIds, basedOnObservationIds: [], confidence: "high",
  };
  const before = { latestSuggestion: reliable, latestReliableSuggestion: null } as MeetingAssistantState;
  const staged = stageSuggestionProjectionForManualCorrection(before);
  assert.equal(staged.latestReliableSuggestion, reliable);
  const reduction = reduceTaskLifecycleTransaction(f.input);
  assert.equal(reduction.mutationApplied, true);
  const terminal = decideManualCorrectionTerminalState({
    mutationApplied: reduction.mutationApplied, stableAnswerCommitted: false, regenerationTraceStatus: "error",
  });
  assert.equal(terminal.status, "applied");
  assert.equal(terminal.regenerationStatus, "failed");
  assert.equal(terminal.regenerationRetryable, true);
  assert.match(terminal.error!, /previous reliable answer was preserved/);
  const restored = restoreSuggestionProjectionAfterFailedManualCorrection(
    { ...before, ...staged, partialSuggestion: "incomplete regeneration" }, staged.latestReliableSuggestion,
  );
  assert.equal(restored.latestSuggestion, reliable);
  assert.equal(restored.partialSuggestion, "");
  assert.equal(reduction.parent?.stableKind, "general-system-design");
  assert.equal(decideManualCorrectionTerminalState({ mutationApplied: true, stableAnswerCommitted: true }).regenerationStatus, "succeeded");
});

test("A2 keeps real child resume, child retype, independent and current-only correction scopes", () => {
  const f = resumedFixture();
  const cases = [
    { parent: f.withChild, corrected: "ai-ml-system-design", relation: "resume-parent", expected: "resume-parent" },
    { parent: f.withChild, corrected: "general-system-design", relation: "resume-parent", expected: "resume-parent" },
    { parent: f.withChild, corrected: "field-knowledge", relation: "child-probe", expected: "child-retype" },
    { parent: f.parent, corrected: "coding", relation: "resume-parent", expected: "resume-parent" },
    { parent: f.parent, corrected: "behavioral", relation: "new-parent", expected: "independent-new-parent" },
    { parent: f.parent, corrected: "general-system-design", relation: "unknown", expected: "current-only" },
    { parent: f.parent, corrected: "field-knowledge", relation: "followup-parent", expected: "current-only" },
  ] as const;
  for (const source of ["voice", "screen"] as const) {
    for (const scenario of cases) {
      const active = task(scenario.parent);
      const decision = decideManualQuestionTypeCorrection(active, scenario.corrected);
      const scope = decideManualCorrectionScope({
        task: active, decision, latestQuestionText: "Tell me about a conflict at work.",
        currentQuestionRelation: scenario.relation, currentQuestionSource: source,
      });
      assert.equal(scope.scope, scenario.expected, `${source}: ${scenario.corrected}/${scenario.relation}`);
      if (scenario.corrected === "ai-ml-system-design") {
        const transition = buildManualCorrectionParentTransition({
          parent: scenario.parent, decision, scopeDecision: scope, latestQuestionText: resumeText,
          transcriptTurns: [], newParentId: "unused", now: 40,
        });
        assert.equal(transition.parent.id, f.parent.id);
        assert.equal(transition.parent.stableKind, "ai-ml-system-design");
        assert.equal(transition.parent.child, undefined);
        assert.deepEqual(transition.parent.whiteboardArtifact, { ...f.withChild.whiteboardArtifact, questionInstanceId: undefined });
      }
    }
  }
});

test("A2 cannot recover a stable resume binding from an exited owner, stale revision or other session", () => {
  const f = resumedFixture();
  for (const change of [
    { activeMeetingTask: undefined },
    { activeMeetingTask: task({ ...f.parent, id: "unrelated-owner" }) },
    { logicalQuestionUnit: { ...f.resumed, sessionId: "other-session" } },
    { logicalQuestionUnit: { ...f.resumed, runtimeEpoch: runtimeEpoch + 1 } },
    { logicalQuestionUnit: { ...f.resumed, revision: 0 } },
  ]) {
    const binding = resolveRevisionStableTopologyBinding({
      records: f.ledger.listHistory(), activeMeetingTask: task(f.parent), logicalQuestionUnit: f.resumed, ...change,
    });
    assert.equal(binding, undefined);
  }
  const { settlement } = settleManualQuestionTypeCorrection({
    operationId: "unrelated-manual-correction", currentQuestion: createProvisionalCurrentQuestion({
      logicalQuestionUnit: f.resumed, sourceKind: "voice",
    }), correctedType: "general-system-design", activeParentId: "unrelated-owner", activeParentRevision: 1,
    manualCorrectionRevision: 1, relationOperationLeaseAuthorized: false,
    relationCandidate: { schemaVersion: 3, relation: "followup-parent", confidence: 0.95,
      currentQuestionEvidenceSpans: ["RAG architecture"], parentEvidenceSpans: ["RAG system"] },
  });
  assert.equal(settlement.relation, "unknown");
  const scope = decideManualCorrectionScope({
    task: task({ ...f.parent, id: "unrelated-owner" }), decision: decideManualQuestionTypeCorrection(task(f.parent), "general-system-design"),
    latestQuestionText: resumeText, currentQuestionRelation: settlement.relation,
  });
  assert.equal(scope.scope, "current-only");
  assert.equal(authorizeManualCorrectionLifecycle({
    settlement, scope: scope.scope, activeParentId: "unrelated-owner", activeParentType: f.parent.stableKind,
  }).parentMutationAuthorized, false);
});

test("A2 Screen source admission still requires the exact available observation before the writer", () => {
  const f = correctionFixture("screen");
  for (const [screenObservations, reason] of [
    [[], "source-observation-not-found"],
    [[{ id: "different-observation", imageBase64: "synthetic-image" }], "source-observation-not-found"],
    [[{ id: "exact-resume-observation", imageBase64: "" }], "source-observation-image-unavailable"],
  ] as const) {
    const admission = authorizeSettlementOwnedQuestionContext({
      sourceKind: f.settlement.sourceKind, sourceObservationIds: f.settlement.sourceObservationIds,
      logicalQuestionText: f.resumed.normalizedText, screenObservations,
    });
    assert.equal(admission.authorized, false);
    assert.equal(admission.reason, reason);
    assert.equal(f.parent.stableKind, "ai-ml-system-design");
    assert.equal(f.parent.revisions, 4);
  }
});
