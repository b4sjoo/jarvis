import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { buildActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import { createProvisionalCurrentQuestion, formatCurrentQuestionSettlementForTrace, settleCurrentQuestion } from "../src/lib/meeting/current-question-settlement.js";
import { EffectiveQuestionSourceLedger, createEffectiveQuestionSourceRecord } from "../src/lib/meeting/effective-question-source-ledger.js";
import { buildHumanEvaluationObservedSnapshotV2, buildManualCorrectionExpectedTaskSettlementFactV2, createHumanGroundTruthEventV2, deriveHumanEvaluationProjectionV2, type HumanGroundTruthFactV2 } from "../src/lib/meeting/human-ground-truth-v2.js";
import { buildHumanEvaluationAttemptEvidenceV2 } from "../src/lib/meeting/human-evaluation-attempt-projection.js";
import { getManualCorrectionCapabilities, type ManualCorrectionIntent } from "../src/lib/meeting/manual-correction-intent.js";
import { prepareManualCorrectionIntentTransition } from "../src/lib/meeting/manual-correction-transition.js";
import { createManualRuntimeActionEvent } from "../src/lib/meeting/manual-runtime-action.js";
import { buildCompactTraceSummary } from "../src/lib/meeting/session-recording.js";
import { buildSessionProcedureV1 } from "../src/lib/meeting/session-procedure.js";
import { buildEffectiveAdvisorSettlementView, buildSettledAdvisorExecutionPlan, formatSettledAdvisorExecutionPlanForTrace } from "../src/lib/meeting/settled-advisor-execution-plan.js";
import { createTaskLifecycleTransaction, formatTaskLifecycleReductionForTrace, reduceTaskLifecycleTransaction } from "../src/lib/meeting/task-lifecycle-reducer.js";
import { evaluateTaskSettlementTupleCompatibilityV2, resolveCommittedManualCorrectionEvidence } from "../src/lib/meeting/task-settlement-tuple.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import type { CanonicalQuestionType } from "../src/lib/meeting/task-taxonomy.js";
import type { ActiveInterviewParent, MeetingTrace } from "../src/lib/meeting/types.js";

const sessionId = "mc8-session";
const providers = { providers: [], selectedProvider: { provider: "unused", variables: {} }, codingProvider: { provider: "unused", variables: {} } };

function productionCorrectionTruthCallback() {
  const hook = ts.createSourceFile("useMeetingAssistant.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const matches: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "recordCorrectionHumanTypeTruth") matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(hook);
  assert.equal(matches.length, 1);
  assert.ok(matches[0].initializer && ts.isArrowFunction(matches[0].initializer));
  return new vm.Script(ts.transpileModule(`(${matches[0].initializer.getText(hook)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText);
}

const correctionTruthScript = productionCorrectionTruthCallback();

function invokeProductionCorrectionTruth(input: {
  prepared: ReturnType<typeof committed>;
  sourceTraceId?: string;
  taskId?: string;
  repairTraceId?: string;
}) {
  const calls: Array<{ traceId: string; fact: HumanGroundTruthFactV2; provenance: Record<string, unknown> }> = [];
  const capturedQuestion = unit("selected-Q");
  const environment: Record<string, unknown> = {
    correctionQuestion: { sourceTraceId: input.sourceTraceId }, correctionTrace: { id: "correction-trace" },
    correctionIntentPreparation: { capability: input.prepared.capability },
    decision: input.prepared.proposal.decision, correctionScopeDecision: input.prepared.proposal.scopeDecision,
    correctionLogicalQuestionUnit: capturedQuestion, questionId: "lqu:selected-Q", requestedAt: 100,
    correctionEvaluationCollection: "organic", eventId: "captured-manual-action", source: "focus-mode",
    buildManualCorrectionExpectedTaskSettlementFactV2,
    recordHumanGroundTruthV2: (traceId: string, fact: HumanGroundTruthFactV2, provenance: Record<string, unknown>) => calls.push({ traceId, fact, provenance }),
  };
  // Post-commit B refresh and the later mutation proposal cannot replace the
  // captured human request. Execute the real callback with those reads forbidden.
  for (const key of ["currentQuestionSettlementRef", "latestManualCorrectionTargetRef", "correctionIntentTransition"]) {
    Object.defineProperty(environment, key, { get: () => { throw new Error(`Expected read mutable/post-commit ${key}`); } });
  }
  const callback = correctionTruthScript.runInNewContext(environment, { timeout: 1_000 }) as
    (input: { taskId?: string; repairTraceId?: string }) => void;
  callback({ taskId: input.taskId, repairTraceId: input.repairTraceId });
  return calls;
}

function unit(id: string): LogicalQuestionUnit {
  return { id, revision: 1, sessionId, runtimeEpoch: 1, currentTurnId: `turn:${id}`, sourceTurnIds: [`turn:${id}`],
    sources: [{ turnId: `turn:${id}`, text: `Explain ${id} architecture.`, startedAt: 1, endedAt: 2 }],
    normalizedText: `Explain ${id} architecture.`, startedAt: 1, updatedAt: 2,
    compositionReasons: ["fresh-substantive-turn"], boundaryReason: "fresh-substantive-turn", truncated: false };
}

function root(id: string, q: LogicalQuestionUnit, stableKind: ActiveInterviewParent["stableKind"] = "ai-ml-system-design"): ActiveInterviewParent {
  return { id, source: "voice", stableKind, topic: q.normalizedText, sourceQuestionUnitId: q.id, sourceQuestionRevision: 1,
    originQuestionId: `lqu:${q.id}`, startTurnId: q.currentTurnId, canonicalQuestionSourceTurnIds: q.sourceTurnIds,
    playbookPhase: "follow_up", phaseProgress: { follow_up: true }, supportedFactAnchors: [], createdAt: 1, updatedAt: 1, revisions: 1 };
}

function committed(kind: ManualCorrectionIntent["kind"], sameType = false) {
  const manager = new MeetingContextManager();
  manager.reset({ sessionId });
  const ledger = new EffectiveQuestionSourceLedger();
  manager.setEffectiveQuestionSourceLedger(ledger);
  const origin = unit("origin-A");
  const q = unit("selected-Q");
  const a = root("A", origin);
  manager.commitTaskRuntimeTransition({ id: "create-A", transition: "create-parent", parent: a, reason: "fixture" });
  function record(question: LogicalQuestionUnit, relation: "new-parent" | "followup-parent" | "child-probe") {
    const runtime = manager.getTaskRuntimeState();
    const activeMeetingTask = manager.getState().activeMeetingTask!;
    const currentQuestion = createProvisionalCurrentQuestion({ logicalQuestionUnit: question, sourceKind: "voice" });
    const settlement = settleCurrentQuestion({ operationId: `original:${question.id}`, currentQuestion, manualCorrectionRevision: 0,
      activeParentId: runtime.parent!.id, activeParentRevision: runtime.parent!.revisions,
      deterministicProposal: { source: "deterministic-fast-path", sessionId, runtimeEpoch: 1,
        logicalQuestionUnitId: question.id, revision: 1, sourceHash: currentQuestion.sourceHash,
        relation, questionType: activeMeetingTask.child?.questionType ?? activeMeetingTask.parent.questionType,
        action: "answer", confidence: 1, typeEvidenceAuthorized: true, relationEvidenceAuthorized: true, actionEvidenceAuthorized: true },
      policy: { runtimeMutationAuthorized: true, questionComplete: true, commitParent: true } });
    const effectiveSettlement = buildEffectiveAdvisorSettlementView({ settlement, activeMeetingTask,
      taskRuntimeRevision: runtime.revision, fallback: { questionType: "ai-ml-system-design", relation } }).effectiveSettlement!;
    ledger.upsert(createEffectiveQuestionSourceRecord({ logicalQuestionUnit: question, settlement: effectiveSettlement, activeMeetingTask })!);
    manager.recordTaskQuestionAdmission({ sessionId, parentId: runtime.parent!.id, childId: runtime.parent!.child?.id, logicalQuestionUnitId: question.id });
  }
  record(origin, "new-parent");
  if (kind === "merge-recent-parent") {
    manager.commitTaskRuntimeTransition({ id: "create-B", transition: "replace-parent", parent: root("B", q, "behavioral"), reason: "fixture" });
  } else if (["continue-child", "merge-first-child", "resume-parent"].includes(kind)) {
    manager.commitTaskRuntimeTransition({ id: "attach-C", transition: "attach-child", parent: { ...a, revisions: 2,
      child: { id: "C", questionType: "field-knowledge", relation: "child-probe", intent: "concept-probe", question: q.normalizedText,
        basedOnTurnIds: q.sourceTurnIds, basedOnObservationIds: [], createdAt: 2, updatedAt: 2 } }, reason: "fixture" });
  }
  record(q, manager.getTaskRuntimeState().parent?.child ? "child-probe" : kind === "merge-recent-parent" ? "new-parent" : "followup-parent");
  if (kind === "resume-parent") manager.recordTaskQuestionAdmission({ sessionId, parentId: "A", childId: "C", logicalQuestionUnitId: "later-child-Q" });
  const runtime = manager.getTaskRuntimeState();
  const source = ledger.findLogicalQuestion({ sessionId, runtimeEpoch: 1, logicalQuestionUnitId: q.id, logicalQuestionRevision: 1 })!;
  const currentQuestion = createProvisionalCurrentQuestion({ logicalQuestionUnit: q, sourceKind: "voice" });
  const context = { currentSessionId: sessionId, currentRuntimeEpoch: 1, currentQuestion, runtime, source,
    target: { sessionId, runtimeEpoch: 1, logicalQuestionUnitId: q.id, logicalQuestionRevision: 1,
      sourceHash: source.sourceHash, manualCorrectionRevision: 1, taskRuntimeRevision: runtime.revision, owner: source.owner },
    manualCorrectionRevision: 1, admission: manager.getManualCorrectionAdmission(), recentParent: manager.getRecentManualCorrectionParent(),
    recentParentSources: manager.getRecentManualCorrectionSources(1) };
  const correctedType: CanonicalQuestionType = kind === "new-child" || kind === "continue-child" ? "field-knowledge"
    : kind === "retype-parent" && !sameType ? "general-system-design" : "ai-ml-system-design";
  const capability = getManualCorrectionCapabilities(context, correctedType).options.find(option => option.id === kind)!;
  assert.ok(capability, kind);
  const proposal = prepareManualCorrectionIntentTransition({ operationId: `mc8:${kind}`, context, intent: capability.intent, correctedType, newParentId: "new-parent" });
  assert.ok(proposal.authorized);
  const plan = buildSettledAdvisorExecutionPlan({ settlement: proposal.settlement, activeMeetingTask: proposal.activeMeetingTask,
    expectedActiveMeetingTask: buildActiveMeetingTask({ parent: runtime.parent, runtimeRevision: runtime.revision }),
    preBoundaryQuestionType: runtime.parent?.stableKind, taskBoundaryCommitted: false, childOwnsResponse: capability.relation === "child-probe",
    providerSnapshot: providers, memoryUseCase: "aiml_system_design_interview", askFrame: "hypothetical-design", topicDomain: "ai-ml-infra",
    sourceQuestion: q.normalizedText, explicitTaskMutationCommand: proposal.command });
  const reduction = reduceTaskLifecycleTransaction({ transaction: createTaskLifecycleTransaction({ plan, manualCorrectionRevision: 1,
    proposedActiveInterviewTask: proposal.parent, proposedActiveScreenTask: null }),
    currentSessionId: sessionId, currentRuntimeEpoch: 1, currentLogicalQuestionUnitId: q.id, currentLogicalQuestionRevision: 1,
    currentManualCorrectionRevision: 1, currentTaskRuntimeRevision: runtime.revision, currentActiveInterviewTask: runtime.parent });
  assert.equal(reduction.authorized, true);
  const sourceOwnerCorrection = ledger.prepareOwnerCorrection({ operationId: `mc8:${kind}`, sessionId, runtimeEpoch: 1,
    logicalQuestionUnitId: q.id, logicalQuestionRevision: 1, sourceHash: source.sourceHash, expectedOwner: source.owner,
    nextOwner: capability.relation === "child-probe" ? { kind: "active-child", parentId: proposal.parent.id, childId: proposal.parent.child!.id }
      : { kind: "parent-mainline", parentId: proposal.parent.id }, relation: capability.relation,
    restoredParentId: kind === "merge-recent-parent" ? "A" : undefined });
  assert.ok(sourceOwnerCorrection);
  const installed = manager.commitTaskRuntimeTransition({ id: "commit", transition: proposal.transition, parent: proposal.parent, screenAttachment: null,
    reason: "manual", sourceOwnerCorrection, recentParentToRestore: kind === "merge-recent-parent" ? "A" : undefined });
  assert.equal(installed.authorized, true);
  const trace: MeetingTrace = { id: `trace:${kind}`, kind: "voice", status: "success", startedAt: 1, endedAt: 5, steps: [], inputs: [], outputs: [], metadata: {
    ...formatCurrentQuestionSettlementForTrace(proposal.settlement), ...formatSettledAdvisorExecutionPlanForTrace(plan),
    ...formatTaskLifecycleReductionForTrace(reduction), correctionAtomicCommitAuthorized: installed.authorized,
    manualCorrectionIntentReceipt: proposal.receipt, manualCorrectionIntent: capability.intent,
    manualCorrectionCommittedPlanId: plan.id, manualCorrectionCommittedCommand: proposal.command.kind,
    correctedQuestionType: correctedType, activeMeetingParentPhase: "project_summary",
  } };
  return { trace, proposal, capability, plan };
}

function summary(trace: MeetingTrace) {
  return buildCompactTraceSummary({ sessionId, trace, trigger: "manual", traceExportPath: "trace.json", summaryPath: "summary.json" });
}

for (const [kind, relation, action] of [
  ["independent", "new-parent", "create"], ["new-child", "child-probe", "attach-child"],
  ["continue-child", "child-probe", "preserve"], ["retype-parent", "followup-parent", "retype"],
  ["merge-first-child", "followup-parent", "preserve"], ["resume-parent", "resume-parent", "resume"],
  ["merge-recent-parent", "followup-parent", "resume"],
] as const) {
  test(`MC8 ${kind}: actual writer -> receipt -> Observed -> compact save/read`, () => {
    const { trace, proposal } = committed(kind);
    const original = JSON.stringify(trace);
    const observed = buildHumanEvaluationObservedSnapshotV2(trace);
    assert.equal(observed.relation, relation);
    assert.equal(observed.parentAction, action);
    assert.equal(observed.settledParentId, proposal.parent.id);
    assert.equal(observed.settledChildId, proposal.parent.child?.id);
    assert.equal(observed.playbookPhase, "project_summary");
    assert.equal(evaluateTaskSettlementTupleCompatibilityV2({ relation: observed.relation!, parentAction: observed.parentAction!,
      manualCorrectionEvidence: observed.manualCorrectionEvidence }).compatible, true);
    const saved = JSON.parse(JSON.stringify(summary(trace)));
    assert.equal(saved.manualCorrectionEvidence.action, action);
    assert.equal(saved.manualCorrectionEvidence.parentAfterId, proposal.parent.id);
    assert.deepEqual(JSON.parse(JSON.stringify(observed)).manualCorrectionEvidence, saved.manualCorrectionEvidence);
    assert.equal(JSON.stringify(trace), original);
  });
}

test("MC8 same-Type parent selection projects preserve, not a fictitious retype/create", () => {
  const { trace } = committed("retype-parent", true);
  assert.equal(buildHumanEvaluationObservedSnapshotV2(trace).parentAction, "preserve");
});

test("MC8 merge tuple remains closed without a valid named committed receipt", () => {
  assert.equal(evaluateTaskSettlementTupleCompatibilityV2({ relation: "followup-parent", parentAction: "resume" }).compatible, false);
  const { trace } = committed("merge-recent-parent");
  const evidence = resolveCommittedManualCorrectionEvidence(trace.metadata!)!;
  assert.equal(evaluateTaskSettlementTupleCompatibilityV2({ relation: "followup-parent", parentAction: "none",
    manualCorrectionEvidence: evidence }).recommendedParentAction, "resume");
  assert.equal(evaluateTaskSettlementTupleCompatibilityV2({ relation: "followup-parent", parentAction: "resume", manualCorrectionEvidence: {
    ...evidence, parentAfterId: evidence.parentBeforeId!,
  } }).compatible, false);
  const plain = { ...trace, metadata: { ...trace.metadata, manualCorrectionIntentReceipt: undefined,
    manualCorrectionIntent: { kind: "merge-recent-parent", parentId: "A", previousParentId: "B" } } };
  assert.equal(buildHumanEvaluationObservedSnapshotV2(plain).parentAction, "create");
});

test("MC8 rejected/stale or inconsistent evidence cannot publish the requested Observed tuple", () => {
  const { trace } = committed("merge-recent-parent");
  const patches: Record<string, unknown>[] = [
    { correctionAtomicCommitAuthorized: false }, { correctionAtomicCommitAuthorized: undefined },
    { taskLifecycleAuthorized: false }, { taskLifecycleMutationApplied: false },
    { taskLifecycleExecutionPlanId: "other-plan" }, { taskLifecycleParentAfterId: "other-owner" },
    { settledExecutionPlanLogicalQuestionUnitId: "other-question" },
  ];
  for (const patch of patches) {
    const rejected = { ...trace, status: "cancelled" as const, metadata: { ...trace.metadata, ...patch } };
    assert.equal(resolveCommittedManualCorrectionEvidence(rejected.metadata), undefined);
    const observed = buildHumanEvaluationObservedSnapshotV2(rejected);
    assert.equal(observed.parentAction, undefined);
    assert.equal(observed.relation, undefined);
    assert.equal(observed.questionType, undefined);
    assert.equal(summary(rejected).manualCorrectionEvidence, undefined);
  }
});

test("MC8 committed Type/owner survives generation failure and a later regeneration Plan", () => {
  const { trace } = committed("merge-recent-parent");
  const regenerated = { ...trace, id: "regenerated", status: "error" as const, metadata: { ...trace.metadata,
    parentCorrectionTraceId: trace.id, settledExecutionPlanId: "new-generation-plan", settledExecutionPlanTaskMutationCommand: "preserve" } };
  const observed = buildHumanEvaluationAttemptEvidenceV2({ trace: regenerated, traces: [trace, regenerated] }).observed;
  assert.equal(observed.parentAction, "resume");
  assert.equal(observed.relation, "followup-parent");
  assert.equal(observed.attemptStatus, "error");
  assert.equal(observed.settledParentId, "A");
});

test("MC8 Expected and older attempt observations stay immutable after correction", () => {
  const { trace } = committed("merge-recent-parent");
  const subject = { attemptId: trace.id, traceIds: [trace.id], sourceTurnIds: ["turn:selected-Q"] };
  const expected = createHumanGroundTruthEventV2({ sessionId, subject, source: "explicit-ui", eventId: "old-human-label", now: 1,
    fact: { kind: "expected-task-settlement", expectedQuestionType: "coding", expectedRelation: "new-parent", expectedParentAction: "create" } });
  const oldObserved = buildHumanEvaluationObservedSnapshotV2({ ...trace, metadata: { ...trace.metadata,
    manualCorrectionIntentReceipt: undefined, settledExecutionPlanTaskMutationCommand: "replace-parent" } });
  const immutableBefore = JSON.stringify({ expected, oldObserved });
  const projection = deriveHumanEvaluationProjectionV2({ sessionId, subject, events: [expected], observed: buildHumanEvaluationObservedSnapshotV2(trace) });
  assert.equal(projection.activeFacts["expected-task-settlement"]!.fact.kind, "expected-task-settlement");
  assert.equal(projection.verdicts.parentActionCorrect, false);
  assert.equal(JSON.stringify({ expected, oldObserved }), immutableBefore);
  assert.equal(JSON.parse(JSON.stringify(projection)).observed.parentAction, "resume");
});

test("MC8 procedure preserves requested intent separately from actual receipt, without expected target injection", () => {
  const { trace, capability } = committed("merge-recent-parent");
  const common = { actionId: "manual-action", action: "type-correction" as const, runtimeSessionId: sessionId, runtimeEpoch: 1,
    correctedType: "ai-ml-system-design", correctionIntent: capability.intent };
  const manualActions = [
    createManualRuntimeActionEvent({ ...common, stage: "requested", occurredAt: 1 }),
    createManualRuntimeActionEvent({ ...common, stage: "accepted", traceId: trace.id, occurredAt: 2 }),
    createManualRuntimeActionEvent({ ...common, stage: "terminal", traceId: trace.id, terminalDisposition: "completed", occurredAt: 5,
      observedLogicalQuestionUnitId: "selected-Q", observedTaskId: "A" }),
  ];
  for (const timelineEvents of [[], [{ id: "requested-event", kind: "manual-runtime-action", createdAt: 1,
    metadata: { actionId: "manual-action", stage: "requested" } }]]) {
    const procedure = buildSessionProcedureV1({ recordingSessionId: sessionId, folderName: "synthetic", sourceDigest: "fixture",
      scriptedValidation: true, forcedScripted: false, timelineEvents, transcriptTurns: [], humanEvaluationProjections: [],
      manualActions: manualActions.map(event => JSON.parse(JSON.stringify(event))),
      traceSummaries: [JSON.parse(JSON.stringify(summary(trace)))] });
    const step = procedure.steps[0];
    assert.equal(procedure.steps.length, 1);
    assert.deepEqual(step.input, { correctedType: "ai-ml-system-design", correctionIntent: capability.intent });
    assert.equal(step.observed!.relation, "followup-parent");
    assert.equal(step.observed!.parentAction, "resume");
    assert.equal(step.observed!.taskId, "A");
    assert.equal(step.expected, undefined);
    assert.equal(JSON.stringify(step.input).includes("expectedTargetStepId"), false);
    assert.equal(JSON.parse(JSON.stringify(procedure)).steps[0].observed.manualCorrectionEvidence.executionPlanId,
      trace.metadata!.taskLifecycleExecutionPlanId);
  }
});

test("MC8 rejected procedure input keeps its intent without manufacturing a successful observation", () => {
  const { trace, capability } = committed("merge-recent-parent");
  const rejected: MeetingTrace = { ...trace, status: "cancelled", metadata: { ...trace.metadata, correctionAtomicCommitAuthorized: false } };
  const manualActions = [
    createManualRuntimeActionEvent({ actionId: "rejected", action: "type-correction", stage: "requested", runtimeSessionId: sessionId,
      runtimeEpoch: 1, correctedType: "ai-ml-system-design", correctionIntent: capability.intent, occurredAt: 1 }),
    createManualRuntimeActionEvent({ actionId: "rejected", action: "type-correction", stage: "terminal", runtimeSessionId: sessionId,
      runtimeEpoch: 1, traceId: rejected.id, terminalDisposition: "stale", observedTaskId: "B", occurredAt: 5 }),
  ];
  const procedure = buildSessionProcedureV1({ recordingSessionId: sessionId, folderName: "synthetic", sourceDigest: "fixture",
    scriptedValidation: true, forcedScripted: false, timelineEvents: [], transcriptTurns: [], humanEvaluationProjections: [],
    manualActions, traceSummaries: [JSON.parse(JSON.stringify(summary(rejected)))] });
  const step = procedure.steps[0];
  assert.deepEqual(step.input.correctionIntent, capability.intent);
  assert.equal(step.observed!.terminalDisposition, "stale");
  assert.equal(step.observed!.taskId, "B");
  assert.equal(step.observed!.relation, undefined);
  assert.equal(step.observed!.parentAction, undefined);
  assert.equal(step.expected, undefined);
});

test("MC8 procedure refuses conflicting commit joins instead of choosing the latest desired result", () => {
  const first = committed("merge-recent-parent");
  const second = committed("independent");
  const manualActions = [
    createManualRuntimeActionEvent({ actionId: "ambiguous", action: "type-correction", stage: "requested", runtimeSessionId: sessionId,
      runtimeEpoch: 1, correctedType: "ai-ml-system-design", correctionIntent: first.capability.intent, occurredAt: 1 }),
    createManualRuntimeActionEvent({ actionId: "ambiguous", action: "type-correction", stage: "accepted", runtimeSessionId: sessionId,
      runtimeEpoch: 1, traceId: first.trace.id, occurredAt: 2 }),
    createManualRuntimeActionEvent({ actionId: "ambiguous", action: "type-correction", stage: "terminal", runtimeSessionId: sessionId,
      runtimeEpoch: 1, traceId: second.trace.id, terminalDisposition: "completed", occurredAt: 5 }),
  ];
  const procedure = buildSessionProcedureV1({ recordingSessionId: sessionId, folderName: "synthetic", sourceDigest: "fixture",
    scriptedValidation: true, forcedScripted: false, timelineEvents: [], transcriptTurns: [], humanEvaluationProjections: [],
    manualActions, traceSummaries: [first, second].map(item => JSON.parse(JSON.stringify(summary(item.trace)))) });
  assert.equal(procedure.steps[0].reviewStatus, "needs-review");
  assert.ok(procedure.steps[0].evidenceGaps.includes("ambiguous-manual-correction-commit-evidence"));
  assert.equal(procedure.steps[0].observed!.parentAction, undefined);
});

test("MC8 Expected comes from the frozen menu choice and never fills generated owner IDs", () => {
  for (const kind of ["independent", "new-child", "continue-child", "retype-parent", "merge-first-child", "resume-parent", "merge-recent-parent"] as const) {
    const { capability, proposal } = committed(kind);
    const snapshot = JSON.stringify(capability);
    const expected = buildManualCorrectionExpectedTaskSettlementFactV2({ correctedType: proposal.decision.correctedType, option: capability })!;
    assert.equal(expected.expectedRelation, capability.relation);
    assert.equal(expected.expectedParentAction, capability.action);
    assert.deepEqual(expected.correctionIntent, capability.intent);
    assert.equal(expected.expectedContextOwnerId, undefined);
    if (capability.intent.kind === "independent") {
      assert.equal(expected.expectedParentId, undefined);
      assert.equal(expected.expectedBranchId, undefined);
    } else {
      assert.equal(expected.expectedParentId, capability.intent.parentId);
      assert.equal(expected.expectedBranchId, capability.intent.kind === "new-child" ? undefined
        : capability.intent.kind === "continue-child" ? capability.intent.childId : capability.intent.parentId);
    }
    assert.equal(JSON.stringify(capability), snapshot);
  }
});

test("MC8 failed/stale correction keeps Expected intent while Observed remains uncommitted", () => {
  const { trace, capability } = committed("merge-recent-parent");
  const fact = buildManualCorrectionExpectedTaskSettlementFactV2({ correctedType: "ai-ml-system-design", option: capability })!;
  const failed = { ...trace, status: "cancelled" as const, metadata: { ...trace.metadata, correctionAtomicCommitAuthorized: false } };
  const observed = buildHumanEvaluationObservedSnapshotV2(failed);
  const subject = { attemptId: failed.id, traceIds: [failed.id], sourceTurnIds: ["turn:selected-Q"] };
  const event = createHumanGroundTruthEventV2({ sessionId, subject, fact, source: "manual-type-correction", actionId: "failed-manual-request" });
  const projection = deriveHumanEvaluationProjectionV2({ sessionId, subject, events: [event], observed });
  const savedFact = JSON.parse(JSON.stringify(projection)).activeFacts["expected-task-settlement"].fact;
  assert.equal(savedFact.expectedRelation, "followup-parent");
  assert.equal(savedFact.expectedParentAction, "resume");
  assert.equal(savedFact.expectedParentId, "A");
  assert.deepEqual(savedFact.correctionIntent, capability.intent);
  assert.equal(observed.parentAction, undefined);
  assert.equal(observed.manualCorrectionEvidence, undefined);
  assert.equal(projection.verdicts.parentActionCorrect, undefined);
  assert.equal(evaluateTaskSettlementTupleCompatibilityV2({ relation: fact.expectedRelation, parentAction: fact.expectedParentAction,
    manualCorrectionExpectedIntent: fact.correctionIntent }).compatible, true);
  assert.equal(evaluateTaskSettlementTupleCompatibilityV2({ relation: fact.expectedRelation, parentAction: "none",
    manualCorrectionExpectedIntent: fact.correctionIntent }).recommendedParentAction, "resume");
  assert.equal(evaluateTaskSettlementTupleCompatibilityV2({ relation: "followup-parent", parentAction: "resume" }).compatible, false);
});

test("MC8 Expected same-Type parent choice records preserve and retains source topology", () => {
  const { capability } = committed("retype-parent", true);
  const expected = buildManualCorrectionExpectedTaskSettlementFactV2({ correctedType: "ai-ml-system-design",
    option: { ...capability, relation: "resume-parent" } })!;
  assert.equal(expected.expectedRelation, "resume-parent");
  assert.equal(expected.expectedParentAction, "preserve");
  assert.equal(evaluateTaskSettlementTupleCompatibilityV2({ relation: expected.expectedRelation, parentAction: expected.expectedParentAction,
    manualCorrectionExpectedIntent: expected.correctionIntent }).compatible, true);
  assert.equal(buildManualCorrectionExpectedTaskSettlementFactV2({ correctedType: "unknown", option: capability }), undefined);
});

test("MC8 actual Hook callback records Type and requested tuple with identical captured provenance", () => {
  for (const kind of ["independent", "new-child", "continue-child", "retype-parent", "merge-first-child", "resume-parent", "merge-recent-parent"] as const) {
    const prepared = committed(kind);
    const calls = invokeProductionCorrectionTruth({ prepared, sourceTraceId: "selected-A-attempt",
      taskId: prepared.proposal.parent.id, repairTraceId: "selected-A-regeneration" });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].fact.kind, "expected-question-type");
    assert.equal(calls[1].fact.kind, "expected-task-settlement");
    assert.equal(calls[0].traceId, "selected-A-attempt");
    assert.equal(calls[1].traceId, calls[0].traceId);
    assert.equal(calls[1].provenance, calls[0].provenance);
    const expected = calls[1].fact;
    assert.ok(expected.kind === "expected-task-settlement");
    assert.equal(expected.expectedRelation, prepared.capability.relation);
    assert.equal(expected.expectedParentAction, prepared.capability.action);
    assert.deepEqual(expected.correctionIntent, prepared.capability.intent);
    const provenance = JSON.parse(JSON.stringify(calls[1].provenance));
    assert.equal(provenance.actionId, "captured-manual-action");
    assert.equal(provenance.collection, "organic");
    assert.equal(provenance.source, "manual-type-correction");
    assert.equal(provenance.evaluationTarget.logicalQuestionUnitId, "selected-Q");
    assert.equal(provenance.evaluationTarget.attemptId, "selected-A-attempt");
    assert.equal(provenance.evaluationTarget.sourceTraceId, "selected-A-attempt");
    assert.equal(provenance.evaluationTarget.repairTraceId, "selected-A-regeneration");
    assert.equal(provenance.evaluationTarget.frozenAt, 100);
    if (kind === "independent") {
      assert.equal(expected.expectedParentId, undefined);
      assert.equal(expected.expectedBranchId, undefined);
    }
  }
});

test("MC8 actual Hook callback retains rejected-source intent without repair or generated owner identity", () => {
  const prepared = committed("merge-recent-parent");
  const calls = invokeProductionCorrectionTruth({ prepared, sourceTraceId: "selected-A-attempt" });
  assert.equal(calls.length, 2);
  const fact = calls[1].fact;
  assert.ok(fact.kind === "expected-task-settlement");
  assert.equal(fact.expectedRelation, "followup-parent");
  assert.equal(fact.expectedParentAction, "resume");
  assert.equal(fact.expectedParentId, "A");
  assert.equal(calls[1].provenance.repairTraceId, undefined);
  const failedTrace = { ...prepared.trace, status: "cancelled" as const,
    metadata: { ...prepared.trace.metadata, correctionAtomicCommitAuthorized: false } };
  assert.equal(buildHumanEvaluationObservedSnapshotV2(failedTrace).parentAction, undefined);
});

test("MC8 actual Hook callback uses correction trace only when the captured source attempt is absent", () => {
  const calls = invokeProductionCorrectionTruth({ prepared: committed("independent") });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.traceId, "correction-trace");
    const provenance = JSON.parse(JSON.stringify(call.provenance));
    assert.equal(provenance.evaluationTarget.attemptId, "correction-trace");
    assert.equal(provenance.evaluationTarget.sourceTraceId, "correction-trace");
    assert.equal(provenance.evaluationTarget.logicalQuestionUnitId, "selected-Q");
  }
});
