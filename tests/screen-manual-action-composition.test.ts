import type { MeetingContextState } from "../src/lib/meeting/meeting-context-contracts.js";
import type { MeetingTaskRuntimeState } from "../src/lib/meeting/meeting-task-contracts.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { buildManualScreenLogicalQuestionUnit } from "../src/lib/meeting/manual-screen-question-source.js";
import { resolveManualScreenSourcePacket } from "../src/lib/meeting/screen-task-scope.js";
import {
  createSourceOwnedTransitionCandidate,
  prepareSourceOwnedTransition,
} from "../src/lib/meeting/source-owned-transition-transaction.js";
import {
  buildActiveMeetingTask,
  reduceMeetingTaskRuntimeMutation,
} from "../src/lib/meeting/active-meeting-task.js";
import {
  createProvisionalCurrentQuestion,
  settleCurrentQuestion,
} from "../src/lib/meeting/current-question-settlement.js";
import {
  createEffectiveQuestionSourceRecord,
  EffectiveQuestionSourceLedger,
  resolveRevisionStableTopologyBinding,
  consumeRevisionStableTopologyBinding,
} from "../src/lib/meeting/effective-question-source-ledger.js";
import {
  buildEffectiveAdvisorSettlementView,
  buildSettledAdvisorExecutionPlan,
  formatSettledAdvisorExecutionPlanForTrace,
  authorizeSettledAdvisorExecutionPlan,
} from "../src/lib/meeting/settled-advisor-execution-plan.js";
import * as responseTargets from "../src/lib/meeting/response-action-target.js";
import { selectInterviewPlaybook } from "../src/lib/meeting/interview-playbook.js";
import type { TranscriptTurn } from "../src/lib/meeting/types.js";
import type { StableAnswerRevision } from "../src/lib/meeting/stable-answer.js";
import {
  commitStableAnswerRevision,
  commitStableArtifactOnlyRevision,
} from "../src/lib/meeting/stable-answer.js";
import { parseMeetingAnswer, buildMeetingAnswerSummary } from "../src/lib/meeting/meeting-answer.js";
import {
  prepareBoundedGeneratedContinuity,
  type BoundedGeneratedContinuityState,
} from "../src/lib/meeting/bounded-recent-history.js";
import { createEffectiveAdvisorBaseBuilder } from "./helpers/advisor-base-context-hook.js";
import * as phase from "../src/lib/meeting/active-branch-phase.js";
import * as history from "../src/lib/meeting/playbook-phase-history.js";
import * as manual from "../src/lib/meeting/manual-runtime-action.js";
import * as phaseDecisions from "../src/lib/meeting/playbook-phase.js";
import * as artifacts from "../src/lib/meeting/artifact-regeneration.js";
import { projectObservedAdvisorAttempt } from "../src/lib/meeting/observed-advisor-outcome.js";
import { buildHumanEvaluationObservedSnapshotV2 } from "../src/lib/meeting/human-ground-truth-v2.js";
import {
  commitSourceOwnedTransitionToRuntime,
  resolveSourceOwnedRuntimeTransition,
} from "../src/lib/meeting/source-owned-transition-runtime.js";

import * as advisorJobs from "../src/lib/meeting/advisor-trigger-job.js";
import * as advisorIntent from "../src/lib/meeting/advisor-turn-intent.js";
import * as runtimeCommit from "../src/lib/meeting/runtime-commit-authorization.js";
import * as logicalOwnership from "../src/lib/meeting/logical-question-ownership.js";
import { decideRefreshAuthority } from "../src/lib/meeting/answer-generation-lease.js";
import {
  resolveResponseOpportunityRefreshAuthority,
} from "../src/lib/meeting/response-opportunity-generation-gate.js";

const hook = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
function declaration(name: string): ts.FunctionDeclaration | ts.VariableDeclaration {
  let found: ts.FunctionDeclaration | ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText(hook) === name) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(hook);
  assert.ok(found, `production declaration ${name}`);
  return found;
}
function evaluate(source: string, environment: Record<string, unknown>) {
  return vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, environment);
}
function selectSource(input: Record<string, unknown>) {
  const exported = (responseTargets as Record<string, unknown>).resolveResponseActionLogicalQuestionUnit;
  if (typeof exported === "function") return exported(input);
  return evaluate(`(${declaration("resolveResponseActionLogicalQuestionUnit").getText(hook)})`, {})(input);
}

function screenFixture() {
  const packet = resolveManualScreenSourcePacket({ screenObservationId: "screen-origin", screenPreflightQuestion: "Solve Longest Substring Without Repeating Characters." });
  const unit = buildManualScreenLogicalQuestionUnit({ packet, sessionId: "session", runtimeEpoch: 3, createdAt: 100 })!;
  const provisional = createProvisionalCurrentQuestion({ logicalQuestionUnit: unit, sourceKind: "screen", sourceObservationIds: ["screen-origin"] });
  const settlement = settleCurrentQuestion({
    currentQuestion: provisional,
    deterministicProposal: {
      ...provisional, source: "deterministic-fast-path", questionType: "coding", relation: "new-parent", action: "answer", confidence: 1,
      typeEvidenceAuthorized: true, relationEvidenceAuthorized: true, actionEvidenceAuthorized: true, reasons: ["screen-preflight"],
    },
    manualCorrectionRevision: 0,
    policy: { allowRuntimeTypeAdjudication: false, allowLlmActionRepair: false, runtimeMutationAuthorized: true, questionComplete: true, commitParent: true },
  });
  const playbook = selectInterviewPlaybook({ query: unit.normalizedText, questionType: "coding" });
  const candidateNode = declaration("screenTransitionCandidate") as ts.VariableDeclaration;
  const candidate = evaluate(`(${candidateNode.initializer!.getText(hook)})`, {
    screenCurrentOnly: false, screenTransitionMutationAuthorized: true,
    createSourceOwnedTransitionCandidate, preflightContextState: { sessionId: "session" }, runtimeEpochRef: { current: 3 },
    observation: { id: "screen-origin" }, screenRelationLogicalQuestionUnit: unit, committedScreenQuestionSettlement: settlement,
    screenTransitionParentBefore: undefined, effectiveScreenSettlementView: {}, provisionalScreenTaskRelation: "new-parent",
    screenSectionHintConsumption: {}, readScreenAuthorization: () => ({ authorized: true }), settledScreenQuestionType: "coding",
    screenPrimaryAskEvidenceText: unit.normalizedText, screenSubtaskIntent: "unknown", screenTransitionSeedPlaybook: playbook,
    screenTransitionSeedPhaseDecision: undefined, getActiveScreenTaskExpiresAt: () => undefined, state: { settings: {} },
  });
  let runtime: MeetingTaskRuntimeState = { revision: 0 };
  let creates = 0;
  const manager = {
    getTaskRuntimeState: () => runtime,
    commitTaskRuntimeTransition: (input: any) => {
      const result = reduceMeetingTaskRuntimeMutation({ state: runtime, mutation: { ...input, kind: "commit-transition" } });
      if (result.authorized) runtime = result.state;
      if (result.mutationApplied && input.transition === "create-parent") creates += 1;
      return result;
    },
  };
  const runtimeEnvironment: Record<string, unknown> = { commitSourceOwnedTransitionToRuntime, resolveSourceOwnedRuntimeTransition, createMeetingId: () => "initial-transition" };
  runtimeEnvironment.submitTaskRuntimeTransition = evaluate(`(${declaration("submitTaskRuntimeTransition").getText(hook)})`, runtimeEnvironment);
  const commit = evaluate(`(${declaration("commitSourceOwnedTransitionWithManager").getText(hook)})`, runtimeEnvironment);
  const receipt = commit({ manager, candidate, expectedTaskRuntimeRevision: 0, currentSessionId: "session", currentRuntimeEpoch: 3, reason: "screen-source-transition-committed" });
  assert.equal(receipt.runtimeResult.authorized, true);
  assert.equal(creates, 1);
  const parent = manager.getTaskRuntimeState().parent!;
  assert.ok(parent);
  const task = buildActiveMeetingTask({ parent, runtimeRevision: 1 })!;
  // The attachment is only a UI projection, not a replacement source.
  const context = {
    sessionId: "session", startedAt: 0, transcriptTurns: [], screenObservations: [{ id: "screen-origin", capturedAt: 100 }], rollingSummary: "", userProfileContext: "", glossary: [],
    taskRuntime: runtime, activeMeetingTask: { ...task, screen: { question: unit.normalizedText, activeScreenTaskId: "canonical-screen", observationId: "screen-origin" } },
  } as unknown as MeetingContextState;
  const effective = buildEffectiveAdvisorSettlementView({ settlement, activeMeetingTask: task, taskRuntimeRevision: 1, fallback: { questionType: "coding", relation: "new-parent" } }).effectiveSettlement!;
  const ledger = new EffectiveQuestionSourceLedger();
  ledger.upsert(createEffectiveQuestionSourceRecord({ logicalQuestionUnit: unit, settlement: effective, activeMeetingTask: task, settledAt: 100 })!);
  return { unit, settlement, effective, parent, task, context, ledger, playbook };
}

test("Screen production candidate writes canonical parent origin", () => {
  const f = screenFixture();
  assert.equal(f.parent.sourceQuestionUnitId, f.unit.id);
  assert.equal(f.parent.sourceQuestionRevision, 1);
});

test("Screen phase source selection preserves the real LQU through parent revisions", () => {
  const f = screenFixture();
  for (const revision of [2, 4, 6]) {
    f.context.activeMeetingTask!.parent.revisions = revision;
    const selected = selectSource({ currentLogicalQuestionUnit: undefined, meetingContext: f.context, runtimeEpoch: 3, preferScreen: true, phaseOwner: { kind: "parent", id: f.parent.id }, effectiveQuestionSources: f.ledger.list() });
    assert.equal(selected?.id, f.unit.id);
    assert.equal(selected?.revision, 1);
    assert.equal(createProvisionalCurrentQuestion({ logicalQuestionUnit: selected, sourceKind: "screen", sourceObservationIds: ["screen-origin"] }).sourceHash, f.settlement.sourceHash);
  }
});

test("consumed Screen origin binding survives an incomplete parent projection in shared Plan", () => {
  const f = screenFixture();
  const binding = resolveRevisionStableTopologyBinding({ records: f.ledger.list(), logicalQuestionUnit: f.unit, activeMeetingTask: f.task })!;
  const consumed = consumeRevisionStableTopologyBinding({ settlement: f.effective, logicalQuestionUnit: f.unit, binding });
  assert.equal(consumed.consumed, true);
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: consumed.settlement, activeMeetingTask: { ...f.task, parent: { ...f.task.parent, sourceQuestionUnitId: undefined, sourceQuestionRevision: undefined } },
    taskBoundaryCommitted: false, childOwnsResponse: false, providerSnapshot: { providers: [], selectedProvider: { provider: "main", variables: {} }, codingProvider: { provider: "main", variables: {} } },
    playbook: f.playbook, memoryUseCase: "meeting_assistant", askFrame: "hypothetical-design", topicDomain: "unknown", sourceQuestion: f.unit.normalizedText,
  });
  assert.equal(plan.taskRelation, "new-parent");
  assert.equal(plan.contextReadScope, "active-parent-read");
  assert.equal(plan.artifactPolicy.allowLatestUsefulAnswer, true);
  assert.equal(plan.taskMutationPolicy.kind, "update-parent-context");
  assert.deepEqual(plan.requestedArtifacts, ["answer"]);
  const continuity = declaration("revisionStableParentContinuation") as ts.VariableDeclaration;
  assert.equal(evaluate(`(${continuity.initializer!.getText(hook)})`, { settledExecutionPlan: plan }), true);
});

function visible(f: ReturnType<typeof screenFixture>): StableAnswerRevision {
  return {
    revision: 1, sessionId: "session", runtimeEpoch: 3, taskId: f.parent.id,
    logicalQuestionUnitId: f.unit.id, logicalQuestionRevision: f.unit.revision,
    questionSourceHash: f.settlement.sourceHash, settlementId: f.effective.settlementId, settlementSnapshot: f.effective,
    suggestion: { id: "answer", kind: "answer", content: "Use a sliding window.", createdAt: 100, basedOnTurnIds: [], basedOnObservationIds: ["screen-origin"], confidence: "high" },
    sections: {} as StableAnswerRevision["sections"], committedAt: 100,
  };
}

test("visible Screen owner rejects missing source even when the ambient LQU still matches", () => {
  const f = screenFixture();
  const target = responseTargets.resolveVisibleAnswerResponseActionTarget({ stableAnswer: visible(f), currentLogicalQuestionUnit: f.unit, effectiveQuestionSources: [], meetingContext: f.context, runtimeEpoch: 3 });
  assert.equal(target.authorized, false);
});

test("visible Screen owner rejects a retired parent and a superseded revision", () => {
  const f = screenFixture();
  const input = { stableAnswer: visible(f), currentLogicalQuestionUnit: f.unit, effectiveQuestionSources: f.ledger.list(), meetingContext: f.context, runtimeEpoch: 3 };
  assert.equal(responseTargets.resolveVisibleAnswerResponseActionTarget({ ...input, meetingContext: { ...f.context, activeMeetingTask: undefined } }).authorized, false);
  const record = f.ledger.list()[0];
  assert.equal(responseTargets.resolveVisibleAnswerResponseActionTarget({ ...input, effectiveQuestionSources: [record, { ...record, recordId: "corrected", logicalQuestionRevision: 2 }] }).authorized, false);
  assert.equal(responseTargets.resolveVisibleAnswerResponseActionTarget({ ...input, currentLogicalQuestionUnit: { ...f.unit, revision: 2 } }).authorized, false);
});

// Execute the actual Hook ingress callbacks. The Advisor seam composes production
// phase, settlement, Plan, stable-section and durable-continuity consumers with a
// deterministic model answer; this is not a mounted-Hook / Provider test.
function actionHarness(f = screenFixture()) {
  let sequence = 0;
  const events: any[] = [];
  const plans: ReturnType<typeof buildSettledAdvisorExecutionPlan>[] = [];
  const observations: ReturnType<typeof buildHumanEvaluationObservedSnapshotV2>[] = [];
  const traces: any[] = [];
  const runtimeCommands: string[] = [];
  const historyRef = { current: history.createPlaybookPhaseHistoryState() };
  const stableRef = { current: visible(f) };
  const continuityRef = { current: { recentCapsules: [] } as BoundedGeneratedContinuityState };
  const currentRef = { current: undefined as typeof f.unit | undefined };
  const context = f.context;
  const environment: any = {
    ...responseTargets, ...phase, ...history, ...manual, ...phaseDecisions, ...artifacts,
    projectObservedAdvisorAttempt,
    state: { status: "listening", activeMeetingTask: context.activeMeetingTask },
    currentSuggestionText: "Answer: Use a sliding window.",
    logicalQuestionUnitRef: currentRef, stableAnswerRevisionRef: stableRef,
    recentAdvisorContinuityRef: continuityRef,
    runtimeEpochRef: { current: 3 }, effectiveQuestionSourceLedgerRef: { current: f.ledger },
    contextManagerRef: { current: {
      getState: () => context,
      clearExpiredActiveMeetingTask: () => {
        const result = reduceMeetingTaskRuntimeMutation({ state: context.taskRuntime, mutation: {
          id: "fixture-expire", kind: "expire", reason: "active-task-expiration", now: Date.now(),
          deadlineControl: {},
        } });
        if (result.mutationApplied) {
          context.taskRuntime = result.state;
          context.activeMeetingTask = buildActiveMeetingTask({ parent: result.state.parent, runtimeRevision: result.state.revision });
        }
        return result.mutationApplied;
      },
      getTaskRuntimeState: () => context.taskRuntime,
      commitTaskRuntimeTransition: (input: any) => {
        const result = reduceMeetingTaskRuntimeMutation({ state: context.taskRuntime, mutation: { ...input, kind: "commit-transition" } });
        if (result.authorized) {
          context.taskRuntime = result.state;
          context.activeMeetingTask = buildActiveMeetingTask({ parent: result.state.parent, runtimeRevision: result.state.revision });
          environment.state.activeMeetingTask = context.activeMeetingTask;
          runtimeCommands.push(input.transition);
        }
        return result;
      },
    } },
    playbookPhaseHistoryRef: historyRef,
    createMeetingId: (prefix: string) => `${prefix}-${++sequence}`,
    recordManualRuntimeAction: (event: any) => events.push(event),
    flushPendingSentenceCompletion: () => undefined,
    resolveCurrentSuggestionQuestionLineage: () => undefined,
    setState: (update: any) => { environment.state = update(environment.state); },
    traceStoreRef: { current: {
      startTrace: (kind: string, metadata: any) => {
        const trace = { id: `trace-${++sequence}`, kind, metadata, status: "running", startedAt: 100, steps: [], inputs: [], outputs: [] };
        traces.push(trace);
        return trace;
      },
      getTraces: () => traces,
      updateMetadata: (id: string, metadata: any) => Object.assign(traces.find((t) => t.id === id).metadata, metadata),
      finishTrace: (id: string, status: string, reason?: string) => Object.assign(traces.find((t) => t.id === id), { status, error: reason }),
    } },
    recordCommittedPlaybookPhaseTransition: (input: any) => {
      const change = phase.detectCommittedBranchPhaseTransition(input)!;
      const owner = { kind: change.ownerKind, id: change.ownerId, parentId: change.parentId };
      const key = history.toPlaybookPhaseOwnerKey(owner);
      const result = history.appendCommittedPlaybookPhaseTransition(historyRef.current, {
        operationId: input.operationId, owner, fromPhase: change.fromPhase, toPhase: change.toPhase,
        taskRevision: change.taskRevision, expectedPhaseRevision: historyRef.current.branches[key]?.phaseRevision ?? 0, committedAt: 100 + sequence,
      }, input.source);
      historyRef.current = result.state;
      return result;
    },
    buildAdvisorJob: (options: any) => ({ ...options, traceId: environment.traceStoreRef.current.startTrace("screen", {}).id }),
    activateAdvisorJob: () => true,
  };
  for (const name of ["isManualRuntimeActionBusy", "submitTaskRuntimeTransition"]) {
    environment[name] = evaluate(`(${declaration(name).getText(hook)})`, environment);
  }
  environment.runAdvisor = async (options: any) => {
    const job = options.advisorJob ?? options;
    const unit = job.logicalQuestionUnit;
    assert.ok(unit);
    const record = f.ledger.findLogicalQuestion({ sessionId: unit.sessionId, runtimeEpoch: unit.runtimeEpoch, logicalQuestionUnitId: unit.id, logicalQuestionRevision: unit.revision })!;
    assert.ok(record);
    let change = options.precommittedPhaseTransition;
    if (job.responseAction === "next-phase") {
      const before = context.taskRuntime.parent!;
      const owner = phase.resolveEffectiveBranchPhase(before);
      assert.equal(owner.status, "resolved");
      if (owner.status !== "resolved") return;
      const decision = phaseDecisions.decideManualNextPhaseTransitionForBranch({ ownerKind: owner.view.ownerKind, questionType: owner.view.questionType, currentPhase: owner.view.phase, phaseProgress: owner.view.phaseProgress, playbookId: owner.view.playbook.id });
      const after = phase.applyActiveBranchPhase({ parent: before, owner: owner.view, targetPhase: options.manualPhaseTargetOverride ?? decision.phase, phaseProgress: phaseDecisions.applyPlaybookPhaseDecisionToProgress(owner.view.phaseProgress, decision, owner.view.phase) })!;
      environment.submitTaskRuntimeTransition(environment.contextManagerRef.current, { transition: "set-phase", reason: "manual-next-phase-committed", expectedRevision: context.taskRuntime.revision, parent: after });
      change = phase.detectCommittedBranchPhaseTransition({ before, after });
      environment.recordCommittedPlaybookPhaseTransition({ before, after, operationId: options.manualPhaseOperationId ?? `phase-${++sequence}`, source: "manual-next" });
    }
    const binding = resolveRevisionStableTopologyBinding({ records: f.ledger.listHistory(), logicalQuestionUnit: unit, activeMeetingTask: context.activeMeetingTask })!;
    assert.ok(binding);
    const provisional = createProvisionalCurrentQuestion({ logicalQuestionUnit: unit, sourceKind: record.sourceKind!, sourceObservationIds: record.sourceObservationIds });
    const original = options.currentQuestionSettlementOverride ?? settleCurrentQuestion({
      currentQuestion: provisional,
      deterministicProposal: { ...provisional, source: "deterministic-fast-path", questionType: context.activeMeetingTask!.child?.questionType ?? context.activeMeetingTask!.parent.questionType, relation: binding.relation, action: "answer", confidence: 1, typeEvidenceAuthorized: true, relationEvidenceAuthorized: true, actionEvidenceAuthorized: true, reasons: [] },
      activeParentId: f.parent.id, activeParentRevision: context.activeMeetingTask!.parent.revisions, manualCorrectionRevision: 0,
      policy: { allowRuntimeTypeAdjudication: false, allowLlmActionRepair: false, runtimeMutationAuthorized: true, questionComplete: true, commitParent: false },
    });
    const consumed = consumeRevisionStableTopologyBinding({ settlement: original, binding, logicalQuestionUnit: unit });
    assert.equal(consumed.consumed, true);
    const view = buildEffectiveAdvisorSettlementView({ settlement: consumed.settlement, activeMeetingTask: context.activeMeetingTask, taskRuntimeRevision: context.taskRuntime.revision, fallback: { questionType: "coding", relation: "unknown" } });
    const settled = view.effectiveSettlement!;
    f.ledger.upsert(createEffectiveQuestionSourceRecord({ logicalQuestionUnit: unit, settlement: settled, activeMeetingTask: context.activeMeetingTask, settledAt: 200 + sequence })!);
    const owner = phase.resolveEffectiveBranchPhase(context.taskRuntime.parent);
    assert.equal(owner.status, "resolved");
    if (owner.status !== "resolved") return;
    const plan = buildSettledAdvisorExecutionPlan({
      executionRuntimeEpoch: environment.runtimeEpochRef.current,
      settlement: settled, activeMeetingTask: context.activeMeetingTask, taskBoundaryCommitted: false, childOwnsResponse: binding.owner.kind === "active-child",
      providerSnapshot: { providers: [], selectedProvider: { provider: "main", variables: {} }, codingProvider: { provider: "main", variables: {} } },
      playbook: owner.view.playbook, memoryUseCase: "meeting_assistant", askFrame: "hypothetical-design", topicDomain: "unknown", sourceQuestion: unit.normalizedText,
      explicitTaskMutationCommand: change ? { kind: "set-phase", owner: { kind: change.ownerKind, id: change.ownerId }, phase: change.toPhase } : undefined,
      taskMutationCommittedBeforeAdvisor: Boolean(change), artifactRequest: { manualPhaseCommitted: Boolean(change), artifactRegenerationArtifacts: options.artifactRegenerationTarget?.artifactFamilies },
    });
    const authorization = authorizeSettledAdvisorExecutionPlan({ plan, currentSettlement: settled, currentSessionId: "session", currentRuntimeEpoch: environment.runtimeEpochRef.current, currentLogicalQuestionUnitId: unit.id, currentLogicalQuestionRevision: unit.revision, currentSourceHash: provisional.sourceHash, currentActiveMeetingTask: context.activeMeetingTask });
    assert.equal(authorization.authorized, true);
    plans.push(plan);
    const content = `Answer: Sliding window answer ${++sequence}.\nCode:\n\`\`\`python\ndef solve():\n    return ${sequence}\n\`\`\`\nComplexity: O(n).`;
    const candidate = { ...stableRef.current.suggestion, id: `answer-${sequence}`, content, meetingAnswer: parseMeetingAnswer(content) };
    const previous = stableRef.current;
    if (options.artifactRegenerationTarget) {
      const result = commitStableArtifactOnlyRevision({ current: previous, candidate, authorizedArtifacts: options.artifactRegenerationTarget.artifactFamilies, expectedVisibleAnswerRevision: previous.revision, expectedTaskId: previous.taskId, expectedLogicalQuestionUnitId: unit.id, expectedLogicalQuestionRevision: unit.revision, expectedSettlementId: previous.settlementId });
      assert.equal(result.disposition, "committed");
      assert.ok(result.stable);
      stableRef.current = result.stable;
    } else {
      stableRef.current = commitStableAnswerRevision({ current: previous, candidate, authorizedArtifacts: plan.requestedArtifacts, taskId: f.parent.id, sectionOwner: binding.owner, logicalQuestionUnitId: unit.id, logicalQuestionRevision: unit.revision, sessionId: "session", runtimeEpoch: 3, questionSourceHash: provisional.sourceHash, settlementId: settled.settlementId, settlementSnapshot: settled })!;
      assert.ok(stableRef.current);
      const prepare = evaluate(`(${declaration("prepareGenerationDerivedTaskRuntimeTransition").getText(hook)})`, { buildMeetingAnswerSummary });
      const publication = prepare({ currentRevision: context.taskRuntime.revision, currentParent: context.taskRuntime.parent, stable: stableRef.current, commitLatestUsefulAnswer: plan.artifactPolicy.allowLatestUsefulAnswer && binding.owner.kind === "parent-mainline" });
      assert.equal(publication.transition, undefined);
      continuityRef.current = prepareBoundedGeneratedContinuity({
        state: continuityRef.current,
        stable: stableRef.current,
        currentOwner: { sessionId: "session", runtimeEpoch: 3, parentTaskId: f.parent.id, childTaskId: context.activeMeetingTask?.child?.id },
        parentRevision: context.taskRuntime.parent?.revisions ?? 0,
        parentSummaryAllowed: publication.latestUsefulAnswerCommitted,
      });
    }
    const trace = traces.find((t) => t.id === job.traceId)!;
    Object.assign(trace.metadata, formatSettledAdvisorExecutionPlanForTrace(plan, authorization), { advisorOutputCommittedToUi: true, currentQuestionSettlementRelation: settled.relation });
    trace.status = "success";
    observations.push(buildHumanEvaluationObservedSnapshotV2(trace));
  };
  const callback = (name: string) => {
    const node = declaration(name) as ts.VariableDeclaration;
    return evaluate(`(${(node.initializer as ts.CallExpression).arguments[0].getText(hook)})`, environment);
  };
  return { f, context, events, plans, observations, traces, runtimeCommands, stableRef, continuityRef, currentRef, apply: callback("applyResponseAction"), regenerate: callback("regenerateSuggestion"), environment };
}

// Keep the real callback/factory and executor admission in one test path. Only
// host state and Provider output are controlled; the existing Plan/output fixture follows.
function withRegenerateExecution(h: ReturnType<typeof actionHarness>) {
  const env = h.environment;
  const outputs = env.runAdvisor;
  const admissions: any[] = [];
  let generated = 0;
  const control = {
    beforeExecution: (_job: any) => {},
    provider: async () => {},
    runtimeActive: true,
  };
  Object.assign(env, advisorJobs, advisorIntent, runtimeCommit, logicalOwnership, {
    decideRefreshAuthority, resolveResponseOpportunityRefreshAuthority,
    recentAdvisorContinuityRef: h.continuityRef,
    responseActionRevisionRef: { current: 0 }, manualCorrectionRevisionRef: { current: 0 },
    currentQuestionLineageRef: { current: undefined },
    activeAdvisorJobRef: { current: undefined },
    runtimeActiveRef: { get current() { return control.runtimeActive; } },
    responseOpportunityGenerationGateRef: { current: { findOperationId: () => undefined, read: () => undefined } },
  });
  env.contextManagerRef.current.buildAdvisorPromptContext = (projectTranscript?: (turns: TranscriptTurn[], sessionId: string) => string) => ({
    transcript: projectTranscript
      ? projectTranscript(h.context.transcriptTurns, h.context.sessionId)
      : h.context.transcriptTurns.map(t => `${t.speaker}: ${t.text}`).join("\n"),
    latestTurn: h.context.transcriptTurns.at(-1),
    screenContext: h.f.unit.normalizedText, taskRuntime: h.context.taskRuntime,
    activeMeetingTask: h.context.activeMeetingTask, rollingSummary: "", userProfileContext: "", glossaryText: "",
  });
  env.buildEffectiveAdvisorBasePromptContext = createEffectiveAdvisorBaseBuilder(
    env.contextManagerRef.current, h.f.ledger, env.runtimeEpochRef, undefined, h.continuityRef
  );
  const callbackNode = declaration("buildAdvisorJob") as ts.VariableDeclaration;
  env.buildAdvisorJob = evaluate(`(${(callbackNode.initializer as ts.CallExpression).arguments[0].getText(hook)})`, env);
  env.activateAdvisorJob = (job: any) => { env.activeAdvisorJobRef.current = job; return true; };
  const initializer = (name: string, scope: any) => {
    const node = declaration(name) as ts.VariableDeclaration;
    return evaluate(`(${node.initializer!.getText(hook)})`, scope);
  };
  for (const name of ["hasAdvisorActiveTask", "evaluateThemTurnForAdvisor"]) {
    env[name] = evaluate(`(${declaration(name).getText(hook)})`, env);
  }
  env.runAdvisor = async (options: any) => {
    if (!options.advisorJob) return outputs(options);
    const advisorJob = options.advisorJob;
    assert.equal(advisorJob.source, "regenerate");
    assert.equal("force" in advisorJob, false);
    control.beforeExecution(advisorJob);
    const scope: any = {
      ...env, options, advisorJob,
      latestTurn: advisorJob.promptContextSnapshot.latestTurn,
      promptContext: advisorJob.promptContextSnapshot,
      traceId: advisorJob.traceId,
      effectiveRuntimeCommitToken: advisorJob.runtimeCommitToken,
      latestManualCorrectionTargetRef: { current: undefined },
      latestForceAdviseTargetRef: { current: undefined },
      pendingAdvisorGenerationSupersessionRef: { current: undefined },
      settledExecutionPlan: undefined, answerGenerationLease: undefined,
      readRuntimeCommitSnapshot: () => runtimeCommit.buildRuntimeCommitSnapshot({ runtimeEpoch: env.runtimeEpochRef.current, contextState: h.context }),
      terminalizeAuthorizationRejection: () => {}, updateForceAdviseTargetForAdvisorOutcome: () => {},
      finishRunningAdvisorJobTrace: (job: any, status: string, metadata: any, reason: string) => {
        env.traceStoreRef.current.updateMetadata(job.traceId, metadata);
        env.traceStoreRef.current.finishTrace(job.traceId, status, reason);
      },
      releaseAdvisorJob: (job: any, outcome: string) => {
        env.traceStoreRef.current.updateMetadata(job.traceId, { advisorJobOutcome: outcome });
      },
    };
    for (const name of ["force", "logicalQuestionLease", "readLogicalQuestionAuthorizationTarget", "readCommitDecision", "rejectStaleCommit"]) {
      scope[name] = initializer(name, scope);
    }
    if (scope.rejectStaleCommit("pre-execution")) return;
    let inactiveGuard: ts.IfStatement | undefined;
    const findInactiveGuard = (node: ts.Node) => {
      if (ts.isIfStatement(node) && node.expression.getText(hook) === "!runtimeActiveRef.current && !force") inactiveGuard ??= node;
      ts.forEachChild(node, findInactiveGuard);
    };
    findInactiveGuard(hook);
    assert.ok(inactiveGuard, "production inactive-audio gate");
    if (evaluate(`(() => { ${inactiveGuard.getText(hook)}; return false; })()`, scope) !== false) return;
    for (const name of ["inferredTurnIntentDecision", "hasExplicitAction", "executionAuthorization"]) {
      scope[name] = initializer(name, scope);
    }
    admissions.push(scope.executionAuthorization);
    env.traceStoreRef.current.updateMetadata(advisorJob.traceId, {
      advisorExecutionAuthorized: scope.executionAuthorization.authorized,
      advisorExecutionAuthorizationReason: scope.executionAuthorization.reason,
    });
    if (!scope.executionAuthorization.authorized) {
      scope.releaseAdvisorJob(advisorJob, "suppressed");
      env.traceStoreRef.current.finishTrace(advisorJob.traceId, "success");
      return;
    }
    generated += 1;
    await control.provider();
    if (scope.rejectStaleCommit("post-model")) return;
    return outputs(options);
  };
  return { control, admissions, generated: () => generated };
}

test("G1 pure Screen Regenerate passes the real factory and executor gate", async () => {
  const h = actionHarness();
  await h.apply("next-phase");
  await h.apply("next-phase");
  const before = h.stableRef.current;
  const execution = withRegenerateExecution(h);
  await h.regenerate();
  assert.equal(execution.generated(), 1, JSON.stringify(h.events));
  assert.equal(execution.admissions[0].reason, "force-bypass");
  assert.equal(h.events.at(-1).terminalDisposition, "completed");
  assert.equal(h.stableRef.current.logicalQuestionUnitId, before.logicalQuestionUnitId);
  assert.equal(h.stableRef.current.logicalQuestionRevision, before.logicalQuestionRevision);
  assert.equal(h.stableRef.current.taskId, before.taskId);
  assert.equal(h.stableRef.current.suggestion.meetingAnswer?.sections.code, before.suggestion.meetingAnswer?.sections.code);
  assert.equal(h.stableRef.current.suggestion.meetingAnswer?.sections.complexity, before.suggestion.meetingAnswer?.sections.complexity);
  assert.equal(h.plans.at(-1)?.taskRelation, "new-parent");
  assert.equal(h.plans.at(-1)?.questionType, "coding");
  assert.deepEqual(h.plans.at(-1)?.requestedArtifacts, ["answer"]);
  assert.equal(h.context.taskRuntime.parent?.playbookPhase, "implementation_validation");
});

test("G1 historical question or acknowledgement does not decide manual Regenerate admission", async () => {
  for (const text of ["What is HNSW?", "Okay, thanks."]) {
    const h = actionHarness();
    h.context.transcriptTurns.push({ id: "old-them", speaker: "them", text, startedAt: 1, endedAt: 2, isFinal: true, source: "system-audio" });
    const execution = withRegenerateExecution(h);
    await h.regenerate();
    assert.equal(execution.generated(), 1, text);
    assert.equal(execution.admissions[0].reason, "force-bypass");
  }
});

test("G2 force does not admit missing, superseded or retired Screen sources", async () => {
  for (const invalidation of ["missing", "revision", "parent", "epoch", "session"] as const) {
    const h = actionHarness();
    const execution = withRegenerateExecution(h);
    const stable = h.stableRef.current;
    if (invalidation === "missing") h.f.ledger.clear();
    if (invalidation === "revision") h.currentRef.current = { ...h.f.unit, revision: 2 };
    if (invalidation === "parent") h.context.activeMeetingTask!.parent.id = "replacement-parent";
    if (invalidation === "epoch") h.environment.runtimeEpochRef.current = 2;
    if (invalidation === "session") h.context.sessionId = "replacement-session";
    await h.regenerate();
    assert.equal(execution.generated(), 0, invalidation);
    assert.equal(h.stableRef.current, stable, invalidation);
    assert.equal(h.events.at(-1).terminalDisposition, "stale", invalidation);
  }
});

test("PC4 Regenerate uses a retained Screen source with a new execution epoch", async () => {
  const h = actionHarness();
  h.environment.runtimeEpochRef.current = 4;
  const before = h.stableRef.current;
  const execution = withRegenerateExecution(h);
  execution.control.beforeExecution = (job: any) => {
    assert.equal(job.runtimeCommitToken.runtimeEpoch, 4);
    assert.equal(job.logicalQuestionUnit.runtimeEpoch, 3);
    assert.equal(job.logicalQuestionUnit.id, before.logicalQuestionUnitId);
  };
  await h.regenerate();
  assert.equal(execution.generated(), 1);
  assert.equal(h.events.at(-1).terminalDisposition, "completed");
  assert.equal(h.stableRef.current.logicalQuestionUnitId, before.logicalQuestionUnitId);
  assert.equal(h.stableRef.current.logicalQuestionRevision, before.logicalQuestionRevision);
});

test("PC4 resumed phase controls retain the Screen source through shared settlement and Plan", async () => {
  const h = actionHarness();
  h.environment.runtimeEpochRef.current = 4;
  for (const action of ["next-phase", "next-phase", "previous-phase"] as const) {
    await h.apply(action);
    const plan = h.plans.at(-1)!;
    assert.ok(plan);
    assert.equal(plan.runtimeEpoch, 4);
    assert.equal(plan.logicalQuestionUnitId, h.f.unit.id);
    assert.equal(plan.logicalQuestionRevision, h.f.unit.revision);
    assert.equal(plan.sourceHash, h.f.settlement.sourceHash);
    assert.equal(plan.taskRelation, "new-parent");
  }
  assert.equal(h.plans.length, 3);
  assert.equal(h.f.ledger.list()[0].runtimeEpoch, 3);
});

test("G2 real executor rejects an epoch or job-owner change after factory handoff", async () => {
  for (const change of ["epoch", "job"] as const) {
    const h = actionHarness();
    const execution = withRegenerateExecution(h);
    execution.control.beforeExecution = () => {
      if (change === "epoch") h.environment.runtimeEpochRef.current = 4;
      else h.environment.activeAdvisorJobRef.current = { id: "newer-job" };
    };
    const before = h.stableRef.current;
    await h.regenerate();
    assert.equal(execution.generated(), 0);
    assert.equal(h.stableRef.current, before);
    assert.equal(h.plans.length, 0);
    assert.notEqual(h.events.at(-1).terminalDisposition, "completed");
  }
});

test("G4 explicit Regenerate can execute with inactive audio and a valid current source", async () => {
  const h = actionHarness();
  const execution = withRegenerateExecution(h);
  execution.control.runtimeActive = false;
  await h.regenerate();
  assert.equal(execution.generated(), 1);
  assert.equal(h.events.at(-1).terminalDisposition, "completed");
  assert.equal(execution.control.runtimeActive, false);
});

test("G4 provider failure and cancellation preserve the previous stable answer", async () => {
  const failed = actionHarness();
  const failureExecution = withRegenerateExecution(failed);
  const previous = failed.stableRef.current;
  failureExecution.control.provider = async () => { throw new Error("controlled-provider-failure"); };
  await assert.rejects(failed.regenerate(), /controlled-provider-failure/);
  assert.equal(failureExecution.generated(), 1);
  assert.equal(failed.stableRef.current, previous);
  assert.equal(failed.events.at(-1).terminalDisposition, "failed");

  const cancelled = actionHarness();
  const cancellationExecution = withRegenerateExecution(cancelled);
  const stable = cancelled.stableRef.current;
  cancellationExecution.control.provider = async () => { cancelled.environment.runtimeEpochRef.current = 4; };
  await cancelled.regenerate();
  assert.equal(cancellationExecution.generated(), 1);
  assert.equal(cancelled.stableRef.current, stable);
  assert.equal(cancelled.plans.length, 0);
  assert.notEqual(cancelled.events.at(-1).terminalDisposition, "completed");
});

test("G5 an identical Code candidate can commit changed Complexity without a cosmetic Code revision", async () => {
  const h = actionHarness();
  await h.apply("next-phase");
  await h.apply("next-phase");
  const before = h.stableRef.current;
  const code = before.suggestion.meetingAnswer!.sections.code;
  const content = `Answer: This text must not replace the answer.\nCode:\n${code}\nComplexity: O(n) time and O(k) auxiliary space for distinct characters.`;
  const candidate = { ...before.suggestion, id: "same-code-new-complexity", content, meetingAnswer: parseMeetingAnswer(content) };
  assert.equal(candidate.meetingAnswer.sections.code, code);
  const result = commitStableArtifactOnlyRevision({ current: before, candidate, authorizedArtifacts: ["code", "complexity"], expectedVisibleAnswerRevision: before.revision, expectedTaskId: before.taskId, expectedLogicalQuestionUnitId: before.logicalQuestionUnitId, expectedLogicalQuestionRevision: before.logicalQuestionRevision, expectedSettlementId: before.settlementId });
  assert.equal(result.disposition, "committed");
  assert.ok(result.stable);
  assert.equal(result.stable.sections.code.revision, before.sections.code.revision);
  assert.equal(result.stable.sections.complexity.revision, before.sections.complexity.revision + 1);
  assert.equal(result.stable.sections.answer.revision, before.sections.answer.revision);
  assert.equal(result.stable.suggestion.meetingAnswer?.sections.answer, before.suggestion.meetingAnswer?.sections.answer);
});

test("real manual ingress composes Next Next Back Regenerate and Artifacts without replacing Screen identity", async () => {
  const h = actionHarness();
  await h.apply("next-phase");
  await h.apply("next-phase");
  assert.equal(h.context.taskRuntime.parent?.playbookPhase, "implementation_validation");
  const code = h.stableRef.current.suggestion.meetingAnswer?.sections.code;
  const oldAnswer = h.continuityRef.current.latestUsefulAnswer;
  h.currentRef.current = { ...h.f.unit, id: "ambient-new-question", revision: 9 };
  await h.regenerate();
  assert.equal(h.plans.length, 3, JSON.stringify(h.events));
  assert.notEqual(h.continuityRef.current.latestUsefulAnswer, oldAnswer);
  assert.deepEqual(h.stableRef.current.suggestion.meetingAnswer?.sections.code, code);
  const answerBeforeArtifacts = h.stableRef.current.suggestion.meetingAnswer?.sections.answer;
  const continuityBeforeArtifacts = h.continuityRef.current.latestUsefulAnswer;
  await h.apply("regenerate-artifacts");
  assert.deepEqual(h.stableRef.current.suggestion.meetingAnswer?.sections.answer, answerBeforeArtifacts);
  assert.equal(h.continuityRef.current.latestUsefulAnswer, continuityBeforeArtifacts);
  assert.notDeepEqual(h.stableRef.current.suggestion.meetingAnswer?.sections.code, code);
  await h.apply("previous-phase");
  assert.equal(h.plans.length, 5);
  assert.deepEqual(h.plans.map((p) => p.taskRelation), Array(5).fill("new-parent"));
  assert.deepEqual(h.plans.map((p) => p.taskMutationPolicy.kind), ["set-phase", "set-phase", "update-parent-context", "update-parent-context", "set-phase"]);
  assert.equal(h.context.taskRuntime.parent?.playbookPhase, "optimized_pseudocode");
  for (const plan of h.plans) {
    assert.equal(plan.logicalQuestionUnitId, h.f.unit.id);
    assert.equal(plan.logicalQuestionRevision, 1);
    assert.equal(plan.sourceHash, h.f.settlement.sourceHash);
    assert.deepEqual(plan.sourceObservationIds, ["screen-origin"]);
    assert.equal(plan.postMutationParentId, h.f.parent.id);
  }
  assert.ok(h.observations.every((o) => o.relation === "new-parent"));
  assert.ok(!h.runtimeCommands.includes("create-parent") && !h.runtimeCommands.includes("replace-parent"));
  assert.equal(h.f.ledger.list().length, 1);
  assert.equal(h.events.filter((e) => e.stage === "accepted").length, 5);
});

test("phase source keeps a later follow-up while visible Regenerate keeps the earlier owner", async () => {
  const h = actionHarness();
  const unit = buildManualScreenLogicalQuestionUnit({ packet: resolveManualScreenSourcePacket({ screenObservationId: "follow-up", screenPreflightQuestion: "How does the sliding window handle duplicates?" }), sessionId: "session", runtimeEpoch: 3, createdAt: 200 })!;
  const provisional = createProvisionalCurrentQuestion({ logicalQuestionUnit: unit, sourceKind: "screen", sourceObservationIds: ["follow-up"] });
  const settled = settleCurrentQuestion({ currentQuestion: provisional, deterministicProposal: { ...provisional, source: "deterministic-fast-path", questionType: "coding", relation: "followup-parent", action: "answer", confidence: 1, typeEvidenceAuthorized: true, relationEvidenceAuthorized: true, actionEvidenceAuthorized: true, reasons: [] }, activeParentId: h.f.parent.id, activeParentRevision: h.f.parent.revisions, manualCorrectionRevision: 0, policy: { allowRuntimeTypeAdjudication: false, allowLlmActionRepair: false, runtimeMutationAuthorized: true, questionComplete: true, commitParent: false } });
  const effective = buildEffectiveAdvisorSettlementView({ settlement: settled, activeMeetingTask: h.context.activeMeetingTask, taskRuntimeRevision: 1, fallback: { questionType: "coding", relation: "unknown" } }).effectiveSettlement!;
  h.f.ledger.upsert(createEffectiveQuestionSourceRecord({ logicalQuestionUnit: unit, settlement: effective, activeMeetingTask: h.context.activeMeetingTask, settledAt: 200 })!);
  h.currentRef.current = unit;
  await h.regenerate();
  assert.equal(h.plans[0].logicalQuestionUnitId, h.f.unit.id);
  await h.apply("next-phase");
  assert.equal(h.plans[1].logicalQuestionUnitId, unit.id);
  assert.equal(h.plans[1].taskRelation, "followup-parent");
  assert.equal(h.plans[1].taskMutationPolicy.kind, "set-phase");
});

test("manual phase rejects absent, superseded, stale-session and retired sources before mutation", async () => {
  for (const invalidation of ["missing", "superseded", "session", "retired"] as const) {
    const h = actionHarness();
    if (invalidation === "missing") h.f.ledger.clear();
    if (invalidation === "superseded") h.currentRef.current = { ...h.f.unit, revision: 2 };
    if (invalidation === "session") h.context.sessionId = "another-session";
    if (invalidation === "retired") h.context.activeMeetingTask!.parent.id = "replacement-parent";
    const before = JSON.stringify(h.context.taskRuntime);
    await h.apply("next-phase");
    assert.equal(h.plans.length, 0, invalidation);
    assert.equal(JSON.stringify(h.context.taskRuntime), before, invalidation);
    assert.equal(h.events.at(-1).terminalDisposition, "stale", invalidation);
  }
});

test("stable binding cannot revive an old LQU after a correction settles", () => {
  const f = screenFixture();
  const record = f.ledger.list()[0];
  f.ledger.upsert({ ...record, recordId: "correction", logicalQuestionRevision: 2, settledAt: 200 });
  assert.equal(resolveRevisionStableTopologyBinding({ records: f.ledger.listHistory(), logicalQuestionUnit: f.unit, activeMeetingTask: f.task }), undefined);
  const corrected = { ...f.unit, revision: 2 };
  const binding = resolveRevisionStableTopologyBinding({ records: f.ledger.listHistory(), logicalQuestionUnit: corrected, activeMeetingTask: f.task })!;
  assert.equal(binding.relation, "new-parent");
  assert.equal(consumeRevisionStableTopologyBinding({ settlement: f.effective, logicalQuestionUnit: f.unit, binding }).consumed, false);
  assert.equal(selectSource({ currentLogicalQuestionUnit: corrected, meetingContext: f.context, runtimeEpoch: 3, preferScreen: true, effectiveQuestionSources: f.ledger.list() }), corrected);
});

test("raw new-parent on a stranger LQU does not grant origin continuity or artifacts", () => {
  const f = screenFixture();
  const plan = buildSettledAdvisorExecutionPlan({ settlement: { ...f.settlement, logicalQuestionUnitId: "stranger", parentMutationAuthorized: false }, activeMeetingTask: f.task, taskBoundaryCommitted: false, childOwnsResponse: false, providerSnapshot: { providers: [], selectedProvider: { provider: "main", variables: {} }, codingProvider: { provider: "main", variables: {} } }, memoryUseCase: "meeting_assistant", askFrame: "hypothetical-design", topicDomain: "unknown" });
  assert.equal(plan.taskRelation, "none");
  assert.equal(plan.taskMutationPolicy.kind, "preserve");
  assert.equal(plan.artifactPolicy.allowLatestUsefulAnswer, false);
  assert.equal(plan.artifactPolicy.allowCode, false);
  assert.deepEqual(plan.requestedArtifacts, ["answer"]);
});

test("active Coding child owns manual phase and retains its identity independently of parent", async () => {
  const f = screenFixture();
  const childUnit = buildManualScreenLogicalQuestionUnit({ packet: resolveManualScreenSourcePacket({ screenObservationId: "screen-child", screenPreflightQuestion: "Implement the duplicate index update." }), sessionId: "session", runtimeEpoch: 3, createdAt: 200 })!;
  const candidate = createSourceOwnedTransitionCandidate({ sessionId: "session", runtimeEpoch: 3, source: "screen", sourceObservationIds: ["screen-child"], logicalQuestionUnitId: childUnit.id, logicalQuestionRevision: 1, existingTask: f.parent, relation: "child-probe", authoritySource: "screen-preflight", mutationAuthorized: true, questionType: "coding", question: childUnit.normalizedText, playbook: f.playbook, now: 200 })!;
  const attached = prepareSourceOwnedTransition({ candidate, currentTask: f.parent, currentSessionId: "session", currentRuntimeEpoch: 3, now: 200 }).task!;
  assert.ok(attached.child?.phaseState);
  const childId = attached.child.id;
  const parentPhase = attached.playbookPhase;
  // Start at a prior child phase to exercise Next, then exhaust that child's phase.
  attached.child.phaseState.phase = "optimized_pseudocode";
  attached.child.phaseState.playbook.phase = "optimized_pseudocode";
  f.context.taskRuntime.parent = attached;
  f.context.activeMeetingTask = buildActiveMeetingTask({ parent: attached, runtimeRevision: 2 });
  const provisional = createProvisionalCurrentQuestion({ logicalQuestionUnit: childUnit, sourceKind: "screen", sourceObservationIds: ["screen-child"] });
  const settled = settleCurrentQuestion({ currentQuestion: provisional, deterministicProposal: { ...provisional, source: "deterministic-fast-path", questionType: "coding", relation: "child-probe", action: "answer", confidence: 1, typeEvidenceAuthorized: true, relationEvidenceAuthorized: true, actionEvidenceAuthorized: true, reasons: [] }, activeParentId: f.parent.id, activeParentRevision: attached.revisions, manualCorrectionRevision: 0, policy: { allowRuntimeTypeAdjudication: false, allowLlmActionRepair: false, runtimeMutationAuthorized: true, questionComplete: true, commitParent: false } });
  const effective = buildEffectiveAdvisorSettlementView({ settlement: settled, activeMeetingTask: f.context.activeMeetingTask, taskRuntimeRevision: 2, fallback: { questionType: "coding", relation: "child-probe" } }).effectiveSettlement!;
  f.ledger.upsert(createEffectiveQuestionSourceRecord({ logicalQuestionUnit: childUnit, settlement: effective, activeMeetingTask: f.context.activeMeetingTask, settledAt: 200 })!);
  const h = actionHarness(f);
  await h.apply("next-phase");
  assert.equal(h.plans.length, 1);
  assert.equal(h.plans[0].logicalQuestionUnitId, childUnit.id);
  assert.equal(h.plans[0].taskRelation, "child-probe");
  assert.deepEqual(h.plans[0].taskMutationPolicy, { kind: "set-phase", owner: { kind: "child", id: childId }, phase: "implementation_validation" });
  assert.equal(h.context.taskRuntime.parent?.playbookPhase, parentPhase);
  assert.equal(h.context.taskRuntime.parent?.child?.id, childId);
  assert.equal(h.continuityRef.current.latestUsefulAnswer, undefined);
  assert.equal(selectSource({ currentLogicalQuestionUnit: f.unit, effectiveQuestionSources: f.ledger.list(), meetingContext: h.context, runtimeEpoch: 3, preferScreen: true, phaseOwner: { kind: "parent", id: f.parent.id } }), undefined);
  await h.apply("next-phase");
  assert.equal(h.plans.length, 1);
  assert.equal(h.events.at(-1).reason, "no-next-phase");
  const before = visible(f);
  const childVisible = { ...before, logicalQuestionUnitId: childUnit.id, questionSourceHash: provisional.sourceHash };
  assert.equal(responseTargets.resolveVisibleAnswerResponseActionTarget({ stableAnswer: childVisible, effectiveQuestionSources: f.ledger.list(), meetingContext: { ...h.context, activeMeetingTask: f.task }, runtimeEpoch: 3 }).authorized, false);
});

test("Focus Regenerate adapter reaches the same visible-source callback as normal ingress", async () => {
  const h = actionHarness();
  const source = ts.createSourceFile("meeting.tsx", readFileSync("src/pages/app/components/meeting/index.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let adapter: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && node.left.getText(source) === "focusActionHandlerRef.current") adapter = node.right;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(adapter);
  let pending: Promise<void> | undefined;
  const dispatch = evaluate(`(${adapter.getText(source)})`, { meeting: { regenerateSuggestion: () => { pending = h.regenerate(); } } });
  h.currentRef.current = { ...h.f.unit, id: "ambient-question" };
  dispatch({ type: "regenerate" });
  await pending;
  assert.equal(h.plans.length, 1);
  assert.equal(h.plans[0].logicalQuestionUnitId, h.f.unit.id);
  assert.equal(h.plans[0].taskRelation, "new-parent");
});

test("Advisor manual source adapter carries ledger Observation and kind rather than ambient Screen", () => {
  const f = screenFixture();
  const environment: Record<string, unknown> = {
    advisorJob: { source: "response-action", logicalQuestionUnit: f.unit },
    effectiveQuestionSourceLedgerRef: { current: f.ledger },
    currentQuestionSettlement: undefined,
    promptContext: { activeMeetingTask: { screen: { observationId: "ambient-other-screen" } } },
  };
  for (const name of ["responseActionSourceRecord", "currentQuestionSourceKind", "currentQuestionSourceObservationIds"]) {
    const node = declaration(name) as ts.VariableDeclaration;
    environment[name] = evaluate(`(${node.initializer!.getText(hook)})`, environment);
  }
  assert.equal(environment.currentQuestionSourceKind, "screen");
  assert.deepEqual(environment.currentQuestionSourceObservationIds, ["screen-origin"]);
  assert.equal(createProvisionalCurrentQuestion({ logicalQuestionUnit: f.unit, sourceKind: environment.currentQuestionSourceKind as "screen", sourceObservationIds: environment.currentQuestionSourceObservationIds as string[] }).sourceHash, f.settlement.sourceHash);
});

test("manual Plan authorization rejects identity and owner changes before commit", async () => {
  const h = actionHarness();
  await h.apply("next-phase");
  const plan = h.plans[0];
  const input = { plan, currentSessionId: "session", currentRuntimeEpoch: 3, currentLogicalQuestionUnitId: plan.logicalQuestionUnitId, currentLogicalQuestionRevision: plan.logicalQuestionRevision, currentSourceHash: plan.sourceHash, currentActiveMeetingTask: h.context.activeMeetingTask };
  for (const mismatch of [
    { currentSessionId: "other" }, { currentRuntimeEpoch: 4 },
    { currentLogicalQuestionUnitId: "other" }, { currentLogicalQuestionRevision: 2 },
    { currentSourceHash: "other" },
    { currentActiveMeetingTask: { ...h.context.activeMeetingTask!, parent: { ...h.context.activeMeetingTask!.parent, id: "retired" } } },
  ]) {
    assert.equal(authorizeSettledAdvisorExecutionPlan({ ...input, ...mismatch }).authorized, false);
  }
});

function currentOnlyAnswerFixture(sourceKind: "voice" | "screen") {
  const unit = buildManualScreenLogicalQuestionUnit({
    packet: resolveManualScreenSourcePacket({
      screenObservationId: "current-only-screen",
      screenPreflightQuestion: "Design a RAG system.",
    }),
    sessionId: "session", runtimeEpoch: 3, createdAt: 100,
  })!;
  if (sourceKind === "voice") {
    unit.id = "current-only-voice";
    unit.currentTurnId = "voice-turn";
    unit.sourceTurnIds = ["voice-turn"];
    unit.sources = [{ turnId: "voice-turn", text: unit.normalizedText, startedAt: 100, endedAt: 100 }];
  }
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: unit, sourceKind,
    sourceObservationIds: sourceKind === "screen" ? ["current-only-screen"] : [],
  });
  const settlement = settleCurrentQuestion({
    currentQuestion,
    deterministicProposal: {
      ...currentQuestion, source: "deterministic-fast-path",
      questionType: "unknown", relation: "unknown", action: "answer",
      confidence: 0, typeEvidenceAuthorized: false,
      relationEvidenceAuthorized: false, actionEvidenceAuthorized: true,
      reasons: ["type-unresolved"],
    },
    manualCorrectionRevision: 0,
    policy: { allowRuntimeTypeAdjudication: false, allowLlmActionRepair: false, runtimeMutationAuthorized: true, questionComplete: true, commitParent: false },
  });
  const view = buildEffectiveAdvisorSettlementView({
    settlement, taskRuntimeRevision: 0,
    fallback: { questionType: "unknown", relation: "unknown" },
  });
  assert.equal(view.currentOnly, true);
  assert.equal(settlement.responseAuthorized, true);
  assert.equal(createEffectiveQuestionSourceRecord({
    logicalQuestionUnit: unit, settlement: view.effectiveSettlement!,
  }), undefined);
  const content = "Answer: Start with retrieval and reranking.";
  const stable = commitStableAnswerRevision({
    candidate: {
      id: "current-only-answer", kind: "answer", content,
      meetingAnswer: parseMeetingAnswer(content), createdAt: 110,
      basedOnTurnIds: unit.sourceTurnIds,
      basedOnObservationIds: currentQuestion.sourceObservationIds,
      confidence: "medium",
    },
    authorizedArtifacts: ["answer"], taskId: null,
    logicalQuestionUnitId: unit.id, logicalQuestionRevision: unit.revision,
    sessionId: "session", runtimeEpoch: 3,
    questionSourceHash: settlement.sourceHash,
    settlementId: settlement.settlementId,
    settlementSnapshot: view.effectiveSettlement,
  })!;
  assert.ok(stable);
  const context: MeetingContextState = {
    sessionId: "session", startedAt: 0,
    transcriptTurns: sourceKind === "voice" ? [{
      id: "voice-turn", text: unit.normalizedText, speaker: "them",
      startedAt: 100, endedAt: 100, isFinal: true, source: "system-audio",
    }] : [],
    screenObservations: sourceKind === "screen" ? [{
      id: "current-only-screen", capturedAt: 100,
      source: "full-screen", changed: true,
    }] : [],
    taskRuntime: { revision: 0 },
    rollingSummary: "", userProfileContext: "", glossary: [],
  };
  return { unit, stable, context, settlement };
}

for (const sourceKind of ["voice", "screen"] as const) {
test(`real Regenerate callback ${sourceKind === "voice" ? "accepts exact current-only Voice" : "rejects current-only Screen"} without a parent ledger`, async () => {
  const f = currentOnlyAnswerFixture(sourceKind);
  const calls: any[] = [];
  const events: any[] = [];
  const environment: any = {
    ...responseTargets, ...manual, projectObservedAdvisorAttempt,
    contextManagerRef: { current: { getState: () => f.context, clearExpiredActiveMeetingTask: () => false } },
    logicalQuestionUnitRef: { current: f.unit },
    stableAnswerRevisionRef: { current: f.stable },
    effectiveQuestionSourceLedgerRef: { current: new EffectiveQuestionSourceLedger() },
    runtimeEpochRef: { current: 3 }, state: { status: "listening" },
    currentSuggestionText: f.stable.suggestion.content,
    createMeetingId: () => "manual-regenerate",
    recordManualRuntimeAction: (event: any) => events.push(event),
    flushPendingSentenceCompletion: () => undefined,
    resolveCurrentSuggestionQuestionLineage: () => undefined,
    setState: () => undefined,
    buildAdvisorJob: (options: any) => ({ ...options, traceId: "regenerate" }),
    activateAdvisorJob: () => true,
    runAdvisor: async (options: any) => { calls.push(options); },
    traceStoreRef: { current: { getTraces: () => [{
      id: "regenerate", status: "success", metadata: { advisorOutputCommittedToUi: true },
    }] } },
  };
  environment.isManualRuntimeActionBusy = evaluate(
    `(${declaration("isManualRuntimeActionBusy").getText(hook)})`, {}
  );
  const node = declaration("regenerateSuggestion") as ts.VariableDeclaration;
  const regenerate = evaluate(
    `(${(node.initializer as ts.CallExpression).arguments[0].getText(hook)})`, environment
  );
  await regenerate();
  if (sourceKind === "screen") {
    assert.equal(calls.length, 0);
    assert.equal(events.at(-1).terminalDisposition, "stale");
    assert.equal(events.at(-1).reason, "visible-answer-effective-source-missing");
    return;
  }
  assert.equal(calls.length, 1, JSON.stringify(events));
  assert.equal(calls[0].force, true);
  assert.equal(calls[0].advisorJob.logicalQuestionUnit, f.unit);
  assert.equal(calls[0].currentQuestionSettlementOverride, f.stable.settlementSnapshot);
  assert.equal(events.filter((event) => event.stage === "accepted").length, 1);
  assert.equal(events.at(-1).terminalDisposition, "completed");
});
}

test("current-only exception cannot admit Screen, mismatched Voice or a retired owner", () => {
  for (const source of ["voice", "screen"] as const) {
    const f = currentOnlyAnswerFixture(source);
    const input = {
      stableAnswer: f.stable, currentLogicalQuestionUnit: f.unit,
      effectiveQuestionSources: [], meetingContext: f.context, runtimeEpoch: 3,
    };
    if (source === "screen") {
      assert.equal(responseTargets.resolveVisibleAnswerResponseActionTarget(input).authorized, false);
    }
    for (const current of [
      { ...f.unit, revision: 2 }, { ...f.unit, id: "another-question" },
      { ...f.unit, sessionId: "another-session" }, { ...f.unit, runtimeEpoch: 4 },
    ]) {
      assert.equal(responseTargets.resolveVisibleAnswerResponseActionTarget({ ...input, currentLogicalQuestionUnit: current }).authorized, false);
    }
    assert.equal(responseTargets.resolveVisibleAnswerResponseActionTarget({
      ...input, stableAnswer: { ...f.stable, taskId: "retired-parent" },
    }).authorized, false);
    const previousOwnedSource = screenFixture().ledger.list()[0];
    assert.equal(responseTargets.resolveVisibleAnswerResponseActionTarget({
      ...input, effectiveQuestionSources: [{
        ...previousOwnedSource, logicalQuestionUnitId: f.unit.id,
        logicalQuestionRevision: 2,
      }],
    }).authorized, false);
    assert.equal(responseTargets.resolveVisibleAnswerResponseActionTarget({
      ...input, currentLogicalQuestionUnit: { ...f.unit, normalizedText: "A different source." },
    }).authorized, false);
  }
});

test("fresh uncommitted new-parent projection never proves owned origin", () => {
  const f = screenFixture();
  const task = { ...f.task, parent: { ...f.task.parent, sourceQuestionUnitId: "another-origin" } };
  for (const activeMeetingTask of [task, undefined]) {
  for (const parentMutationAuthorized of [true, false]) {
    const view = buildEffectiveAdvisorSettlementView({
      settlement: { ...f.settlement, parentMutationAuthorized },
      activeMeetingTask, taskRuntimeRevision: 1,
      fallback: { questionType: "coding", relation: "new-parent" },
    });
    assert.equal(view.effectiveSettlement?.effectiveParentId, undefined);
    const plan = buildSettledAdvisorExecutionPlan({
      settlement: view.effectiveSettlement!, activeMeetingTask,
      taskBoundaryCommitted: false, childOwnsResponse: false,
      providerSnapshot: { providers: [], selectedProvider: { provider: "main", variables: {} }, codingProvider: { provider: "main", variables: {} } },
      memoryUseCase: "meeting_assistant", askFrame: "hypothetical-design", topicDomain: "unknown",
    });
    assert.equal(plan.contextReadScope, "current-only");
    assert.equal(plan.taskRelation, "none");
    assert.equal(plan.taskMutationPolicy.kind, "preserve");
    assert.equal(plan.artifactPolicy.allowLatestUsefulAnswer, false);
    assert.equal(plan.artifactPolicy.allowCode, false);
  }
  }
});
