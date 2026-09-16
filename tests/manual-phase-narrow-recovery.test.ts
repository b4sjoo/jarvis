import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {
  applyActiveBranchPhase,
  detectCommittedBranchPhaseTransition,
  resolveEffectiveBranchPhase,
} from "../src/lib/meeting/active-branch-phase.js";
import {
  buildActiveMeetingTask,
  equalTaskRuntimeValues,
  reduceMeetingTaskRuntimeMutation,
} from "../src/lib/meeting/active-meeting-task.js";
import {
  createAdvisorTriggerJob,
  type AdvisorTriggerJob,
} from "../src/lib/meeting/advisor-trigger-job.js";
import {
  authorizeAnswerGenerationLease,
  createAnswerGenerationLease,
  decideRefreshAuthority,
  type AnswerGenerationLease,
} from "../src/lib/meeting/answer-generation-lease.js";
import { clearBoundedGeneratedContinuity } from "../src/lib/meeting/bounded-recent-history.js";
import { composeContextScopeAdvisorPromptContext } from "../src/lib/meeting/context-scope-response-action.js";
import {
  createProvisionalCurrentQuestion,
  settleCurrentQuestion,
} from "../src/lib/meeting/current-question-settlement.js";
import {
  consumeRevisionStableTopologyBinding,
  createEffectiveQuestionSourceRecord,
  EffectiveQuestionSourceLedger,
  resolveRevisionStableTopologyBinding,
} from "../src/lib/meeting/effective-question-source-ledger.js";
import {
  GenerationDerivedCommitCoordinator,
  GenerationResultLedger,
} from "../src/lib/meeting/generation-result-ledger.js";
import { selectInterviewPlaybook, withInterviewPlaybookPhase } from "../src/lib/meeting/interview-playbook.js";
import { decideInterviewTaskContinuityBranch } from "../src/lib/meeting/interview-task-continuity.js";
import { buildManualScreenLogicalQuestionUnit } from "../src/lib/meeting/manual-screen-question-source.js";
import { buildMeetingAnswerSummary, parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import type { AdvisorPromptContext, MeetingContextState } from "../src/lib/meeting/meeting-context-contracts.js";
import {
  applyPlaybookPhaseDecisionToProgress,
  decideManualNextPhaseTransitionForBranch,
} from "../src/lib/meeting/playbook-phase.js";
import {
  appendCommittedManualNextPhaseTransition,
  createPlaybookPhaseHistoryState,
  toPlaybookPhaseOwnerKey,
} from "../src/lib/meeting/playbook-phase-history.js";
import { resolvePostModelContinuityAuthority } from "../src/lib/meeting/post-model-continuity-authority.js";
import { projectResponseArtifactAuthorizationForGeneration } from "../src/lib/meeting/response-artifact-authorization.js";
import { resolveVisibleAnswerResponseActionTarget } from "../src/lib/meeting/response-action-target.js";
import { resolveResponseOpportunityRefreshAuthority } from "../src/lib/meeting/response-opportunity-generation-gate.js";
import { buildRuntimeCommitSnapshot } from "../src/lib/meeting/runtime-commit-authorization.js";
import { resolveManualScreenSourcePacket } from "../src/lib/meeting/screen-task-scope.js";
import {
  authorizeSettledAdvisorExecutionPlan,
  buildEffectiveAdvisorSettlementView,
  buildSettledAdvisorExecutionPlan,
  type SettledAdvisorExecutionPlan,
} from "../src/lib/meeting/settled-advisor-execution-plan.js";
import {
  createSourceOwnedTransitionCandidate,
  prepareSourceOwnedTransition,
  resolveLatestScreenObservationId,
} from "../src/lib/meeting/source-owned-transition-transaction.js";
import {
  collectStableAnswerMutationDelta,
  commitStableAnswerRevision,
  type StableAnswerRevision,
} from "../src/lib/meeting/stable-answer.js";
import type { ActiveInterviewParent, AdvisorSuggestion } from "../src/lib/meeting/types.js";
import { isWhiteboardRevisionAuthorized } from "../src/lib/meeting/whiteboard-artifact.js";
import { createDeferredOperation } from "./helpers/deferred-operation.js";

const hook = ts.createSourceFile(
  "hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"),
  ts.ScriptTarget.Latest, true
);

function declaration(name: string) {
  let found: ts.FunctionDeclaration | ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
        node.name?.getText(hook) === name) found = node;
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

function initializer(name: string, environment: Record<string, unknown>) {
  const node = declaration(name);
  assert.ok(ts.isVariableDeclaration(node) && node.initializer);
  return evaluate(`(${node.initializer.getText(hook)})`, environment);
}

function callback(name: string, environment: Record<string, unknown>) {
  const node = declaration(name);
  assert.ok(ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer));
  return evaluate(`(${node.initializer.arguments[0].getText(hook)})`, environment);
}

function syncCommittedPhaseView<T>(context: MeetingContextState, previous: T): T {
  const node = declaration("phaseUpdatedContext");
  assert.ok(ts.isVariableDeclaration(node));
  const statement = node.parent.parent;
  const block = statement.parent;
  assert.ok(ts.isVariableStatement(statement) && ts.isBlock(block));
  const sync = block.statements[block.statements.indexOf(statement) + 1];
  assert.ok(ts.isExpressionStatement(sync) && ts.isCallExpression(sync.expression));
  assert.equal(sync.expression.expression.getText(hook), "setState");
  let view = previous;
  evaluate(`${statement.getText(hook)}\n${sync.getText(hook)}`, {
    contextManagerRef: { current: { getState: () => context } },
    setState: (update: (value: T) => T) => { view = update(view); },
  });
  return view;
}

function suggestion(id: string, answer: string, code: string): AdvisorSuggestion {
  const content = `Answer: ${answer}\nApproach: Use a map and recency list.\nCode:\n\`\`\`python\n${code}\n\`\`\`\nComplexity: O(1) per operation.`;
  return {
    id, kind: "answer", content, meetingAnswer: parseMeetingAnswer(content),
    createdAt: 100, basedOnTurnIds: [], basedOnObservationIds: ["mr3-screen"], confidence: "high",
  };
}

// Real factory, phase/Plan/lease and post-model consumers are composed here.
// Deferred output controls completion order; no cancellation rule is implemented
// by this harness. Publication installs into a local cell, not mounted React UI.
function recoveryHarness() {
  const unit = buildManualScreenLogicalQuestionUnit({
    packet: resolveManualScreenSourcePacket({
      screenObservationId: "mr3-screen", screenPreflightQuestion: "Implement an LRU cache.",
    }),
    sessionId: "mr3-session", runtimeEpoch: 3, createdAt: 100,
  })!;
  const provisional = createProvisionalCurrentQuestion({
    logicalQuestionUnit: unit, sourceKind: "screen", sourceObservationIds: ["mr3-screen"],
  });
  const settlement = settleCurrentQuestion({
    currentQuestion: provisional,
    deterministicProposal: {
      ...provisional, source: "deterministic-fast-path", questionType: "coding",
      relation: "new-parent", action: "answer", confidence: 1,
      typeEvidenceAuthorized: true, relationEvidenceAuthorized: true,
      actionEvidenceAuthorized: true, reasons: ["screen-preflight"],
    },
    manualCorrectionRevision: 0,
    policy: {
      allowRuntimeTypeAdjudication: false, allowLlmActionRepair: false,
      runtimeMutationAuthorized: true, questionComplete: true, commitParent: true,
    },
  });
  const playbook = selectInterviewPlaybook({ questionType: "coding", query: unit.normalizedText });
  assert.ok(playbook);
  const candidate = createSourceOwnedTransitionCandidate({
    sessionId: unit.sessionId, runtimeEpoch: unit.runtimeEpoch, source: "screen",
    sourceObservationIds: ["mr3-screen"], logicalQuestionUnitId: unit.id,
    logicalQuestionRevision: unit.revision, questionType: "coding",
    question: unit.normalizedText, relation: "new-parent", authoritySource: "screen-preflight",
    mutationAuthorized: true, playbook, now: 100,
  });
  assert.ok(candidate);
  const prepared = prepareSourceOwnedTransition({
    candidate, currentSessionId: unit.sessionId, currentRuntimeEpoch: unit.runtimeEpoch, now: 100,
  });
  assert.ok(prepared.task);
  const context: MeetingContextState = {
    sessionId: unit.sessionId, startedAt: 0, transcriptTurns: [],
    screenObservations: [{ id: "mr3-screen", capturedAt: 100, source: "full-screen", changed: true }],
    rollingSummary: "", userProfileContext: "", glossary: [], taskRuntime: { revision: 0 },
  };
  let phaseHistory = createPlaybookPhaseHistoryState();
  let sequence = 0;
  const runtimeCommands: string[] = [];
  function commit(parent: ActiveInterviewParent, transition: "create-parent" | "set-phase") {
    const result = reduceMeetingTaskRuntimeMutation({
      state: context.taskRuntime,
      mutation: {
        id: `mr3-transition-${++sequence}`, kind: "commit-transition", transition,
        reason: "mr3-source-phase-commit", expectedRevision: context.taskRuntime.revision, parent,
      },
    });
    assert.equal(result.authorized, true);
    assert.equal(result.mutationApplied, true);
    context.taskRuntime = result.state;
    context.activeMeetingTask = buildActiveMeetingTask({ parent: result.state.parent, runtimeRevision: result.state.revision });
    runtimeCommands.push(transition);
  }
  commit(prepared.task, "create-parent");
  function advancePhase() {
    const before = context.taskRuntime.parent!;
    const resolved = resolveEffectiveBranchPhase(before);
    assert.equal(resolved.status, "resolved");
    if (resolved.status !== "resolved") assert.fail("expected phase owner");
    const owner = resolved.view;
    const decision = decideManualNextPhaseTransitionForBranch({
      ownerKind: owner.ownerKind, questionType: owner.questionType, currentPhase: owner.phase,
      phaseProgress: owner.phaseProgress, playbookId: owner.playbook.id,
    });
    assert.equal(decision.guardStatus, "advanced");
    const after = applyActiveBranchPhase({
      parent: before, owner, targetPhase: decision.phase,
      phaseProgress: applyPlaybookPhaseDecisionToProgress(owner.phaseProgress, decision, owner.phase),
      now: 100 + sequence,
    });
    assert.ok(after);
    commit(after, "set-phase");
    const change = detectCommittedBranchPhaseTransition({ before, after });
    assert.ok(change);
    const historyOwner = { kind: change.ownerKind, id: change.ownerId, parentId: change.parentId };
    const key = toPlaybookPhaseOwnerKey(historyOwner);
    const recorded = appendCommittedManualNextPhaseTransition(phaseHistory, {
      operationId: `mr3-phase-${sequence}`, owner: historyOwner,
      fromPhase: change.fromPhase, toPhase: change.toPhase, taskRevision: change.taskRevision,
      expectedPhaseRevision: phaseHistory.branches[key]?.phaseRevision ?? 0, committedAt: 100 + sequence,
    });
    assert.equal(recorded.status, "appended");
    phaseHistory = recorded.state;
    return change;
  }
  advancePhase();
  assert.equal(context.taskRuntime.parent?.playbookPhase, "optimized_pseudocode");
  const effective = buildEffectiveAdvisorSettlementView({
    settlement, activeMeetingTask: context.activeMeetingTask, taskRuntimeRevision: context.taskRuntime.revision,
    fallback: { questionType: "coding", relation: "new-parent" },
  }).effectiveSettlement!;
  const sourceLedger = new EffectiveQuestionSourceLedger();
  const record = createEffectiveQuestionSourceRecord({
    logicalQuestionUnit: unit, settlement: effective, activeMeetingTask: context.activeMeetingTask, settledAt: 110,
  });
  assert.ok(record);
  sourceLedger.upsert(record);
  // Existing Code may be retained when returning to an earlier phase.
  let stable = commitStableAnswerRevision({
    candidate: suggestion("previous", "Explain the optimized approach.", "def retained_code(): return 1"),
    authorizedArtifacts: ["answer", "code", "complexity"], taskId: context.taskRuntime.parent!.id,
    sectionOwner: { kind: "parent-mainline", parentId: context.taskRuntime.parent!.id },
    logicalQuestionUnitId: unit.id, logicalQuestionRevision: unit.revision,
    sessionId: unit.sessionId, runtimeEpoch: unit.runtimeEpoch,
    questionSourceHash: effective.sourceHash, settlementId: effective.settlementId, settlementSnapshot: effective,
  })!;
  assert.ok(stable);
  const environment: any = {
    createAdvisorTriggerJob, buildRuntimeCommitSnapshot, decideRefreshAuthority,
    resolveResponseOpportunityRefreshAuthority, clearBoundedGeneratedContinuity,
    contextManagerRef: { current: { getState: () => context } },
    runtimeEpochRef: { current: unit.runtimeEpoch },
    preparationRuntimeContextRef: { current: { preparationContextRevision: 0 } },
    manualCorrectionRevisionRef: { current: 0 }, responseActionRevisionRef: { current: 0 },
    recentAdvisorContinuityRef: { current: { recentCapsules: [] } },
    responseOpportunityGenerationGateRef: { current: { findOperationId: () => undefined, read: () => undefined } },
    logicalQuestionUnitRef: { current: unit }, visibleAnswerRevisionRef: { current: stable.revision },
  };
  const buildJob = callback("buildAdvisorJob", environment);
  const readLeaseSnapshot = callback("readGenerationLeaseSnapshot", environment);
  function basePrompt(): AdvisorPromptContext {
    return {
      transcript: unit.normalizedText, screenContext: unit.normalizedText,
      taskRuntime: context.taskRuntime, activeMeetingTask: context.activeMeetingTask,
      interviewPlaybook: context.taskRuntime.parent?.playbook,
      rollingSummary: "", userProfileContext: "", glossaryText: "",
    };
  }
  function job(action: "next-phase" | "narrow-context", promptContext: AdvisorPromptContext): AdvisorTriggerJob {
    return buildJob({
      responseAction: action, mode: "response-action", advisorJobSource: "response-action",
      traceId: `mr3-${action}`, logicalQuestionUnit: unit, promptContextOverride: promptContext,
      taskMutationAuthority: "preserve-parent",
    });
  }
  function plan(manualPhaseCommitted: boolean, contextReadScopeOverride?: "current-only") {
    const binding = resolveRevisionStableTopologyBinding({
      records: sourceLedger.list(), logicalQuestionUnit: unit, activeMeetingTask: context.activeMeetingTask,
    });
    assert.ok(binding);
    const consumed = consumeRevisionStableTopologyBinding({ settlement: effective, logicalQuestionUnit: unit, binding });
    assert.equal(consumed.consumed, true);
    const current = context.taskRuntime.parent!;
    return buildSettledAdvisorExecutionPlan({
      settlement: consumed.settlement, activeMeetingTask: context.activeMeetingTask,
      taskBoundaryCommitted: false, childOwnsResponse: false, executionRuntimeEpoch: unit.runtimeEpoch,
      providerSnapshot: { providers: [], selectedProvider: { provider: "main", variables: {} }, codingProvider: { provider: "main", variables: {} } },
      playbook: current.playbook, memoryUseCase: "coding_interview", askFrame: "direct-answer",
      topicDomain: "backend", sourceQuestion: unit.normalizedText, contextReadScopeOverride,
      explicitTaskMutationCommand: manualPhaseCommitted
        ? { kind: "set-phase", owner: { kind: "parent", id: current.id }, phase: current.playbookPhase }
        : undefined,
      taskMutationCommittedBeforeAdvisor: manualPhaseCommitted,
      artifactRequest: { manualPhaseCommitted },
    });
  }
  function authorizeLease(lease: AnswerGenerationLease, executionPlan: SettledAdvisorExecutionPlan, mutated?: ReturnType<typeof collectStableAnswerMutationDelta>["candidateMutatedArtifacts"]) {
    return authorizeAnswerGenerationLease(lease, readLeaseSnapshot({
      lease, authorizedArtifacts: executionPlan.requestedArtifacts, candidateMutatedArtifacts: mutated,
      logicalQuestionUnitId: unit.id, logicalQuestionRevision: unit.revision,
    }));
  }
  const resultLedger = new GenerationResultLedger();
  const coordinator = new GenerationDerivedCommitCoordinator(resultLedger);
  const installed: string[] = [];
  const consumerEnvironment: Record<string, unknown> = {
    decideInterviewTaskContinuityBranch, resolveLatestScreenObservationId,
    withInterviewPlaybookPhase, isWhiteboardRevisionAuthorized,
    applyPlaybookPhaseDecisionToProgress, equalTaskRuntimeValues, buildMeetingAnswerSummary,
  };
  consumerEnvironment.mergeSupportedFactAnchors = evaluate(
    `(${declaration("mergeSupportedFactAnchors").getText(hook)})`, consumerEnvironment
  );
  const consumeOwner = evaluate(`(${declaration("updateInterviewTaskContinuityForAnswer").getText(hook)})`, consumerEnvironment);
  const prepareTransition = evaluate(`(${declaration("prepareGenerationDerivedTaskRuntimeTransition").getText(hook)})`, consumerEnvironment);
  function startGeneration(advisorJob: AdvisorTriggerJob, executionPlan: SettledAdvisorExecutionPlan) {
    const currentParent = context.activeMeetingTask!.parent;
    const lease = createAnswerGenerationLease({
      sessionId: unit.sessionId, runtimeEpoch: unit.runtimeEpoch, preparationContextRevision: 0,
      taskId: currentParent.id, taskRevision: currentParent.revisions ?? null,
      logicalQuestionUnitId: unit.id, logicalQuestionRevision: unit.revision,
      baseVisibleAnswerRevision: stable.revision, sourceTurnIds: unit.sourceTurnIds,
      manualCorrectionRevision: advisorJob.manualCorrectionRevision,
      responseActionRevision: advisorJob.responseActionRevision,
      modelRoute: "mr3-controlled-output", artifactOwnerId: currentParent.id,
      requestedArtifacts: executionPlan.requestedArtifacts,
    });
    assert.equal(authorizeLease(lease, executionPlan).authorized, true);
    resultLedger.begin({ lease, traceId: advisorJob.traceId });
    const output = createDeferredOperation<AdvisorSuggestion>();
    const completed = output.promise.then((nextSuggestion) => {
      const authorization = authorizeSettledAdvisorExecutionPlan({
        plan: executionPlan, currentSettlement: effective,
        currentSessionId: unit.sessionId, currentRuntimeEpoch: unit.runtimeEpoch,
        currentLogicalQuestionUnitId: unit.id, currentLogicalQuestionRevision: unit.revision,
        currentSourceHash: effective.sourceHash, currentActiveMeetingTask: context.activeMeetingTask,
      });
      assert.equal(authorization.authorized, true, authorization.reason);
      const ownerScope = {
        resolvePostModelContinuityAuthority, contextState: context, settledExecutionPlan: executionPlan,
        precommittedLifecycleCommand: executionPlan.taskMutationCommittedBeforeAdvisor ? "set-phase" : undefined,
        precommittedPhaseOwnerKind: "parent", advisorContinuityRelation: executionPlan.taskRelation,
      };
      const authority = initializer("postModelContinuityAuthority", ownerScope);
      assert.equal(authority.owner, "active-parent");
      const scope = { ...ownerScope, postModelContinuityAuthority: authority };
      const relation = initializer("continuityRelation", scope);
      assert.equal(relation, "followup-parent");
      const artifactAuthorization = projectResponseArtifactAuthorizationForGeneration({
        authorization: executionPlan.artifactPolicy, authority: executionPlan.artifactGenerationAuthority,
      });
      const continuity = consumeOwner({
        existingTask: context.taskRuntime.parent, source: "screen", responseOwner: executionPlan.responseOwner,
        finalContent: nextSuggestion.content, parsedAnswer: nextSuggestion.meetingAnswer,
        // Legacy caller fields cannot reset the committed Implementation phase.
        playbook: { ...context.taskRuntime.parent!.playbook, phase: "baseline_reasoning" },
        phaseDecision: { phase: "baseline_reasoning" },
        observationId: "mr3-screen", artifactAuthorization, artifactIntent: executionPlan.artifactIntent,
      });
      assert.equal(continuity.startedNewParent, false);
      assert.strictEqual(continuity.task, context.taskRuntime.parent);
      const nextStable: StableAnswerRevision = initializer("candidateStableAnswer", {
        artifactOnlyCommitDecision: undefined, stableAnswerCommitDecision: { disposition: "committed" },
        commitStableAnswerRevision, previousStableAnswer: stable, nextSuggestion,
        generationAuthorizedArtifacts: executionPlan.requestedArtifacts, continuity,
        contextState: context, publicationSectionOwner: { kind: "parent-mainline", parentId: currentParent.id },
        advisorJob, runtimeEpochRef: environment.runtimeEpochRef,
        currentQuestionSettlement: effective, resetVisibleSections: false, visibleAnswerRevisionBefore: stable.revision,
      });
      assert.ok(nextStable);
      const delta = collectStableAnswerMutationDelta(stable, nextStable);
      const transition = prepareTransition({
        currentRevision: context.taskRuntime.revision, currentParent: context.taskRuntime.parent,
        stable: nextStable, commitLatestUsefulAnswer: artifactAuthorization.allowLatestUsefulAnswer,
      });
      assert.equal(transition.transition, undefined);
      resultLedger.recordCandidateValidation({ lease, disposition: "accepted", reason: "mr3-candidate-accepted" });
      return coordinator.commitStaged({
        lease, leaseAuthorization: authorizeLease(lease, executionPlan, delta.candidateMutatedArtifacts),
        expectedTaskRuntimeRevision: context.taskRuntime.revision, currentTaskRuntimeRevision: context.taskRuntime.revision,
        candidateAccepted: true, visibleAnswerRevision: nextStable.revision,
        publication: {
          prepare: () => ({ previous: stable, next: nextStable }),
          install: (publication) => {
            stable = publication.next;
            environment.visibleAnswerRevisionRef.current = stable.revision;
            installed.push(advisorJob.traceId!);
            return stable;
          },
          rollback: (publication) => {
            stable = publication.previous;
            environment.visibleAnswerRevisionRef.current = stable.revision;
            return true;
          },
        },
      });
    });
    return { lease, output, completed, plan: executionPlan };
  }
  return {
    context, unit, effective, sourceLedger, environment, runtimeCommands, installed, resultLedger,
    advancePhase, job, basePrompt, plan, startGeneration, authorizeLease,
    get stable() { return stable; },
    get phaseHistory() { return phaseHistory; },
  };
}

for (const completionOrder of ["old-next-first", "narrow-first"] as const) {
  test(`MR3 Implementation survives Next/Narrow supersession with ${completionOrder}`, async () => {
    const h = recoveryHarness();
    const previous = h.stable;
    const previousView = {
      taskRuntime: h.context.taskRuntime, activeMeetingTask: h.context.activeMeetingTask,
      latestSuggestion: previous.suggestion, latestReliableSuggestion: previous.suggestion,
      partialSuggestion: "", status: "thinking", error: null,
    };
    const nextJob = h.job("next-phase", h.basePrompt());
    assert.equal(nextJob.responseActionRevision, 1);
    const phaseChange = h.advancePhase();
    assert.equal(phaseChange.fromPhase, "optimized_pseudocode");
    assert.equal(phaseChange.toPhase, "implementation_validation");
    const committedView = syncCommittedPhaseView(h.context, previousView);
    assert.deepEqual({ ...committedView }, {
      ...previousView, taskRuntime: h.context.taskRuntime, activeMeetingTask: h.context.activeMeetingTask,
    });
    assert.equal(previousView.activeMeetingTask?.parent.playbookPhase, "optimized_pseudocode");
    assert.equal(committedView.activeMeetingTask?.parent.playbookPhase, "implementation_validation");
    assert.strictEqual(committedView.latestSuggestion, previous.suggestion);
    assert.strictEqual(committedView.latestReliableSuggestion, previous.suggestion);
    const nextPlan = h.plan(true);
    assert.deepEqual(nextPlan.requestedArtifacts, ["answer", "code", "complexity"]);
    const next = h.startGeneration(nextJob, nextPlan);
    assert.equal(next.output.isSettled(), false);
    assert.strictEqual(h.stable, previous);
    assert.equal(committedView.status, "thinking");
    assert.equal(committedView.latestSuggestion.meetingAnswer?.sections.code, previous.suggestion.meetingAnswer?.sections.code);
    const committedRuntime = JSON.stringify(h.context.taskRuntime);
    const committedHistory = JSON.stringify(h.phaseHistory);
    const committedCommands = [...h.runtimeCommands];

    const target = resolveVisibleAnswerResponseActionTarget({
      stableAnswer: h.stable, currentLogicalQuestionUnit: h.unit,
      effectiveQuestionSources: h.sourceLedger.list(), meetingContext: h.context, runtimeEpoch: h.unit.runtimeEpoch,
    });
    assert.equal(target.authorized, true);
    assert.equal(target.logicalQuestionUnit?.id, h.unit.id);
    const narrowContext = composeContextScopeAdvisorPromptContext({
      action: "narrow-context", baseContext: h.basePrompt(), logicalQuestionUnit: target.logicalQuestionUnit!,
      meetingContext: h.context, activeMeetingTask: h.context.activeMeetingTask,
    });
    assert.ok(narrowContext.contextScopeMode === "current-only");
    const narrowJob = h.job("narrow-context", narrowContext.promptContext);
    assert.equal(narrowJob.responseActionRevision, 2);
    assert.equal(narrowJob.refreshAuthority.maySupersedeGeneration, true);
    assert.equal(h.environment.responseActionRevisionRef.current, 2);
    const narrowPlan = h.plan(false, narrowContext.contextScopeMode);
    assert.equal(narrowPlan.contextReadScope, "current-only");
    assert.equal(narrowPlan.taskRelation, "new-parent");
    assert.equal(narrowPlan.taskMutationPolicy.kind, "update-parent-context");
    assert.equal(narrowPlan.taskMutationCommittedBeforeAdvisor, false);
    assert.equal(narrowPlan.logicalQuestionUnitId, nextPlan.logicalQuestionUnitId);
    assert.equal(narrowPlan.logicalQuestionRevision, nextPlan.logicalQuestionRevision);
    assert.equal(narrowPlan.sourceHash, nextPlan.sourceHash);
    assert.deepEqual(narrowPlan.requestedArtifacts, ["answer"]);
    const narrow = h.startGeneration(narrowJob, narrowPlan);
    assert.equal(h.authorizeLease(next.lease, nextPlan).reason, "response-action-revision-mismatch");
    assert.equal(h.authorizeLease(narrow.lease, narrowPlan).authorized, true);

    const oldOutput = suggestion("late-next", "Late implementation answer.", "def late_next_code(): return 2");
    const narrowOutput = suggestion("narrow", "Narrow answer for the same LRU question.", "def unauthorized_narrow_code(): return 3");
    if (completionOrder === "old-next-first") {
      next.output.resolve(oldOutput);
      const rejected = await next.completed;
      assert.equal(rejected.committed, false);
      assert.equal(rejected.reason, "response-action-revision-mismatch");
      assert.strictEqual(h.stable, previous);
      assert.deepEqual(h.installed, []);
      narrow.output.resolve(narrowOutput);
      assert.equal((await narrow.completed).committed, true);
    } else {
      narrow.output.resolve(narrowOutput);
      assert.equal((await narrow.completed).committed, true);
      const published = h.stable;
      next.output.resolve(oldOutput);
      const rejected = await next.completed;
      assert.equal(rejected.committed, false);
      assert.equal(rejected.reason, "visible-answer-revision-mismatch");
      assert.strictEqual(h.stable, published);
    }
    assert.equal(h.resultLedger.getEntry(next.lease.id)?.commitDisposition, "rejected");
    assert.equal(h.resultLedger.getEntry(narrow.lease.id)?.commitDisposition, "committed");
    assert.deepEqual(h.installed, ["mr3-narrow-context"]);
    assert.match(h.stable.suggestion.meetingAnswer!.sections.answer!, /Narrow answer/);
    assert.doesNotMatch(h.stable.suggestion.content, /late_next_code|unauthorized_narrow_code/);
    assert.deepEqual(h.stable.sections.code, previous.sections.code);
    assert.deepEqual(h.stable.sections.complexity, previous.sections.complexity);
    assert.equal(h.stable.sections.answer.revision, previous.sections.answer.revision + 1);
    assert.equal(h.stable.suggestion.meetingAnswer!.sections.code, previous.suggestion.meetingAnswer!.sections.code);
    assert.equal(JSON.stringify(h.context.taskRuntime), committedRuntime);
    assert.equal(JSON.stringify(h.phaseHistory), committedHistory);
    assert.deepEqual(h.runtimeCommands, committedCommands);
    assert.equal(h.context.taskRuntime.parent!.playbookPhase, "implementation_validation");
    assert.equal(h.context.taskRuntime.parent!.phaseProgress.implementation, true);
  });
}
