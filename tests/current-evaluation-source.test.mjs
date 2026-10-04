import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import ts from "typescript";

// Bundle current sources in memory so this standalone test cannot use stale .tmp-tests output.
const bundle = await build({
  stdin: {
    contents: ["human-evaluation", "current-question-settlement", "source-owned-transition-runtime", "playbook-phase-history", "runtime-inference-runtime",
      "settled-advisor-execution-plan"]
      .map(name => `export * from "./src/lib/meeting/${name}.ts";`)
      // Task 178A: the shared helper that builds the real critical event stream.
      .concat(`export * from "./tests/helpers/runtime-critical-events.ts";`).join("\n"),
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, platform: "node", format: "cjs", logLevel: "silent",
});
const bundledModule = { exports: {} };
const production = vm.compileFunction(`${bundle.outputFiles[0].text}\nreturn module.exports;`,
  ["module", "exports", "require"])(bundledModule, bundledModule.exports, createRequire(import.meta.url));
const hook = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
const ui = ts.createSourceFile("meeting.tsx", readFileSync("src/pages/app/components/meeting/index.tsx", "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function find(root, predicate, label) {
  let found;
  const visit = node => {
    if (predicate(node)) found ??= node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(root);
  assert.ok(found, `production subtree: ${label}`);
  return found;
}

function declaration(name, root = hook, source = hook) {
  return find(root, node => (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
    node.name?.getText(source) === name, name);
}

function evaluate(text, context) {
  return vm.runInContext(ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, context);
}

function callback(name, context) {
  return evaluate(`(${declaration(name).initializer.arguments[0].getText(hook)})`, context);
}

// Task 178A: the Hook's own emit callbacks, extracted once.
const criticalEventCallbackSources = Object.fromEntries(production.RUNTIME_CRITICAL_EVENT_HOOK_CALLBACKS.map(name =>
  [name, `(${declaration(name).initializer.arguments[0].getText(hook)})`]));

function assignmentGuard(right, root = hook) {
  let node = find(root, candidate => ts.isBinaryExpression(candidate) &&
    candidate.left.getText(hook) === "currentQuestionSettlementRef.current" &&
    candidate.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    candidate.right.getText(hook) === right, `settlement publication: ${right}`);
  while (node && !ts.isIfStatement(node)) node = node.parent;
  assert.ok(node, `publication guard: ${right}`);
  return node;
}

function settlement(id, sourceKind = "voice", sessionId = "session-1") {
  return {
    settlementId: `settlement-${id}`, sessionId, runtimeEpoch: 3,
    logicalQuestionUnitId: id, revision: 1, sourceHash: `hash-${id}`, sourceKind,
    sourceTurnIds: sourceKind === "voice" ? [`turn-${id}`] : [],
    sourceObservationIds: sourceKind === "screen" ? [`observation-${id}`] : [],
    questionType: "field-knowledge", relation: "followup-parent", responseAuthorized: true,
    rejectedProposals: [], reasons: [],
  };
}

function unit(source) {
  return { id: source.logicalQuestionUnitId, revision: source.revision,
    sessionId: source.sessionId, runtimeEpoch: source.runtimeEpoch };
}

function trace(source, status = "success", id = `trace-${source.logicalQuestionUnitId}`) {
  return { id, kind: source.sourceKind, status, startedAt: 1, steps: [], inputs: [], outputs: [], metadata: {
    ...production.formatCurrentQuestionSettlementForTrace(source),
    effectiveCurrentQuestionSettlementMaterialized: true,
    effectiveCurrentQuestionSettlementSessionId: source.sessionId,
    effectiveCurrentQuestionSettlementId: source.settlementId,
    effectiveCurrentQuestionSettlementUnitId: source.logicalQuestionUnitId,
    effectiveCurrentQuestionSettlementRevision: 41,
    effectiveCurrentQuestionSettlementSourceHash: source.sourceHash,
  } };
}

function harness() {
  const a = settlement("A"), b = settlement("B", "screen");
  const suggestion = { id: "answer-A", sourceTraceId: "trace-A", content: "Answer: A", kind: "answer",
    createdAt: 1, basedOnTurnIds: ["turn-A"], basedOnObservationIds: [], confidence: "medium" };
  const stable = { logicalQuestionUnitId: "A", logicalQuestionRevision: 1, sessionId: a.sessionId, suggestion };
  const runtime = { sessionId: a.sessionId, taskRuntime: {} };
  const traces = [trace(a)];
  const env = {
    ...production, contextManagerRef: { current: { getState: () => runtime } },
    currentQuestionSettlementRef: { current: a }, logicalQuestionUnitRef: { current: unit(a) },
    latestManualCorrectionTargetRef: { current: { logicalQuestionUnit: unit(a) } },
    stableAnswerRevisionRef: { current: stable }, settledAdvisorExecutionPlanRef: { current: { id: "plan-A" } },
    manualAdviseDisplayRef: { current: { selectedTarget: undefined } }, runtimeEpochRef: { current: 3 },
    // The run's effective view, which the deferred adoption reads to name what
    // it assigns. A test of the deferred path sets it as runAdvisor does.
    effectiveAdvisorSettlementView: { effectiveSettlement: undefined },
    traceStoreRef: { current: { updateMetadata(id, patch) {
      const target = traces.find(item => item.id === id);
      assert.ok(target, `trace exists: ${id}`);
      Object.assign(target.metadata, patch);
    } } },
    state: { latestSuggestion: suggestion, partialSuggestion: "", status: "listening" },
  };
  const context = vm.createContext(env);
  const criticalEvents = production.createRuntimeCriticalEventHarness({ sessionId: runtime.sessionId });
  criticalEvents.install(env, name => evaluate(criticalEventCallbackSources[name], context));
  const projectionNames = ["presentationSessionId", "evaluationSettlement", "currentQuestionForEvaluation", "evaluationQuestionPending"];
  const projectionSource = projectionNames.map(name => {
    const node = declaration(name);
    assert.ok(ts.isVariableStatement(node.parent.parent));
    return node.parent.parent.getText(hook);
  }).join("\n");
  const selectionFactory = declaration("evaluationTarget", ui, ui).initializer.arguments[0].getText(ui);
  return {
    a, b, env, context, runtime, traces, stable, criticalEvents,
    project() {
      return evaluate(`(() => { ${projectionSource}\nreturn { presentationSessionId, currentQuestionForEvaluation, evaluationQuestionPending }; })()`, context);
    },
    select() {
      const projected = this.project();
      env.meeting = { ...env.state, ...projected, meetingSessionId: projected.presentationSessionId, traces };
      env.adviseDisplay = { locked: false };
      return evaluate(`(${selectionFactory})()`, context);
    },
  };
}

function publishScreen(h, { authorized = true } = {}) {
  const capture = declaration("captureScreenContext").initializer.arguments[0];
  const admission = declaration("screenLifecyclePublicationAuthorized", capture).parent.parent;
  const publication = assignmentGuard("screenCurrentQuestionSettlement", capture);
  const provider = find(capture, node => ts.isCallExpression(node) &&
    node.expression.getText(hook) === "solveScreenAnchoredTask", "Screen provider");
  assert.ok(publication.end < provider.pos, "source publication precedes the real provider call");
  Object.assign(h.env, {
    screenTransitionCandidate: { id: "screen-transition" },
    screenSourceOwnedTransitionReceipt: { runtimeResult: { authorized, mutationApplied: authorized } },
    screenCurrentQuestionSettlement: h.b, trace: h.traces.find(item => item.id === "trace-B"),
    observation: { id: "observation-B" }, schedulePendingLatePreflightRepair: () => false,
  });
  evaluate(`(() => { ${admission.getText(hook)}\n${publication.getText(hook)} })()`, h.context);
}

for (const status of ["error", "cancelled", "success"]) {
  test(`B2 current source: Screen pre-provider publication survives ${status} with no output and old Answer A`, () => {
    const h = harness();
    const screen = trace(h.b, "running");
    h.traces.unshift(screen);
    const manual = h.env.latestManualCorrectionTargetRef.current;
    const raw = h.env.logicalQuestionUnitRef.current;
    publishScreen(h);
    assert.equal(h.env.currentQuestionSettlementRef.current, h.b);
    assert.equal(h.project().currentQuestionForEvaluation.logicalQuestionUnitId, "B");
    assert.equal(h.project().evaluationQuestionPending, false);
    assert.equal(h.select().status, "pending");
    assert.equal(h.select().traceId, "trace-B");
    // Represent the provider terminal outcome without invoking a provider or any output commit.
    screen.status = status;
    assert.equal(h.select().status, "trace-only");
    assert.equal(h.select().traceId, "trace-B");
    assert.equal(h.env.latestManualCorrectionTargetRef.current, manual);
    assert.equal(h.env.logicalQuestionUnitRef.current, raw);
    assert.equal(h.env.stableAnswerRevisionRef.current, h.stable);
    assert.equal(h.env.state.latestSuggestion, h.stable.suggestion);
    assert.equal(h.env.currentQuestionSettlementRef.current, h.b, "projection is read-only");
  });
}

test("B2 current source: rejected Screen lifecycle cannot publish its settlement", () => {
  const h = harness();
  h.traces.unshift(trace(h.b, "error"));
  publishScreen(h, { authorized: false });
  assert.equal(h.env.currentQuestionSettlementRef.current, h.a);
  assert.equal(h.select().traceId, "trace-A");
});

test("B2 current source: real Voice publication advances to B while historical selected A cannot overwrite it", () => {
  const h = harness();
  h.b = settlement("B");
  h.traces.unshift(trace(h.b));
  h.env.logicalQuestionUnitRef.current = unit(h.b);
  h.env.latestManualCorrectionTargetRef.current = { logicalQuestionUnit: unit(h.b) };
  h.env.isSelectedHistoricalQuestion = callback("isSelectedHistoricalQuestion", h.context);
  const commit = evaluate(`(${declaration("commitDeferredResponseAuthorizedState").initializer.getText(hook)})`, h.context);
  Object.assign(h.env, {
    responseMutationSuppressed: false, options: {}, selectedQuestionOnly: false, traceId: "trace-B",
    advisorJob: { logicalQuestionUnit: unit(h.b) }, currentQuestionSettlement: h.b,
    settledExecutionPlan: { id: "plan-B" }, currentQuestionSourceKind: "voice", currentQuestionSourceObservationIds: [],
  });
  commit();
  assert.equal(h.env.currentQuestionSettlementRef.current, h.b);
  const planB = h.env.settledAdvisorExecutionPlanRef.current;
  const manualB = h.env.latestManualCorrectionTargetRef.current;
  h.env.manualAdviseDisplayRef.current.selectedTarget = { sessionId: h.runtime.sessionId, logicalQuestionUnitId: "A" };
  h.env.selectedQuestionOnly = h.env.isSelectedHistoricalQuestion("A");
  assert.equal(h.env.selectedQuestionOnly, true);
  Object.assign(h.env, { advisorJob: { logicalQuestionUnit: unit(h.a) }, currentQuestionSettlement: h.a,
    settledExecutionPlan: { id: "historical-plan-A" }, effectiveAdvisorSettlementView: { effectiveSettlement: h.a } });
  commit();
  evaluate(assignmentGuard("effectiveAdvisorSettlementView.effectiveSettlement").getText(hook), h.context);
  Object.assign(h.env, { correctionLogicalQuestionUnit: unit(h.a), correctionCurrentQuestionSettlement: h.a,
    correctionExecutionPlan: { id: "historical-correction-plan-A" },
    parentBefore: { id: "parent-B", stableKind: "ai-ml-system-design" },
    parentAfter: { id: "parent-A", stableKind: "ai-ml-system-design" } });
  evaluate(assignmentGuard("correctionCurrentQuestionSettlement").getText(hook), h.context);
  h.traces.unshift(trace(h.a, "success", "newer-historical-A"));
  assert.equal(h.env.currentQuestionSettlementRef.current, h.b);
  assert.equal(h.env.settledAdvisorExecutionPlanRef.current, planB);
  assert.equal(h.env.latestManualCorrectionTargetRef.current, manualB);
  assert.equal(h.project().currentQuestionForEvaluation.logicalQuestionUnitId, "B");
  assert.equal(h.select().traceId, "trace-B");
});

function bindRuntimeReset(h) {
  const noop = () => {};
  h.env.factRiskReviewRuntimeRef = { current: null };
  for (const name of ["pendingAnswerResolutionCommitByTraceRef", "semanticTaxonomyEvidenceByTurnRef",
    "questionTypeAdjudicationCandidateCacheRef", "whiteboardSyntaxRepairAttemptKeysRef",
    "answerRevisionByQuestionRef", "cancelledAdvisorTurnIdsRef", "effectiveQuestionSourceLedgerRef"]) {
    h.env[name] = { current: new Map() };
  }
  for (const name of ["responseOpportunityRuntimeRef", "responseOpportunityGenerationGateRef", "meetingMetadataInferenceRuntimeRef",
    "questionTypeAdjudicationRuntimeRef", "taskRelationChildAffinityRuntimeRef", "taskRelationParentAffinityRuntimeRef",
    "taskRelationCanonicalShadowRuntimeRef", "taskRelationChildAffinityObservationRuntimeRef",
    "taskRelationParentAffinityObservationRuntimeRef", "taskRelationCanonicalShadowObservationRuntimeRef",
    "answerResolutionRuntimeRef", "evidenceRequirementRuntimeRef",
    "sourceLinkageAdjudicationRuntimeRef", "whiteboardSyntaxRepairRuntimeRef"]) h.env[name] = { current: { cancelAll: noop } };
  h.env.projectSelectionInferenceRuntimeRef = {
    current: new production.RuntimeInferenceOperationRuntime("project-selection-inference"),
  };
  for (const name of ["screenOperationCoordinatorRef", "manualCorrectionOperationCoordinatorRef"]) h.env[name] = { current: { reset: noop } };
  for (const name of ["taskBoundaryCandidateRef", "manualCorrectionRevisionRef", "adjacentQuestionScopeRef",
    "manualCorrectionTargetHistoryRef", "playbookPhaseHistoryRef", "pendingInterviewSectionHintRef",
    "pendingInterviewTaskBoundaryRef", "latestSourceOwnedSetupRef"]) h.env[name] = { current: undefined };
  h.env.settleAwaitingVisualEvidenceRecovery = noop;
  h.env.invalidateRuntimeWork = callback("invalidateRuntimeWork", h.context);
  h.env.advanceRuntimeEpoch = callback("advanceRuntimeEpoch", h.context);
}

test("B2 current source: real Clear epoch boundary cannot resurrect retained same-session traces", t => {
  const h = harness();
  bindRuntimeReset(h);
  const projectRuntime = h.env.projectSelectionInferenceRuntimeRef.current;
  const projectSettlements = [];
  t.after(() => projectRuntime.cancelAll("disposed"));
  projectRuntime.schedule({ job: { operationId: "project-selection-before-clear", operationKind: "project-selection-inference",
    sessionId: h.runtime.sessionId, budgetKey: h.runtime.sessionId, budgetSlot: "me-turn", budgetReason: "test-clear-boundary" },
    execute: async () => assert.fail("Clear must cancel the queued project inference before provider execution"),
    onSettled: result => projectSettlements.push(result),
  }, 60_000);
  assert.equal(projectRuntime.getCurrentOperationId(), "project-selection-before-clear");
  const clear = declaration("clearActiveTask").initializer.arguments[0];
  const resetCall = find(clear, node => ts.isCallExpression(node) &&
    node.expression.getText(hook) === "advanceRuntimeEpoch", "Clear epoch boundary");
  evaluate(resetCall.getText(hook), h.context);
  const clearState = evaluate(`(${declaration("clearActiveTaskState").getText(hook)})`, h.context);
  h.env.state = clearState(h.env.state, h.runtime);
  assert.equal(h.env.runtimeEpochRef.current, 4);
  assert.equal(projectRuntime.getCurrentOperationId(), undefined);
  assert.deepEqual(projectSettlements.map(result => result.disposition), ["superseded"]);
  assert.equal(h.env.currentQuestionSettlementRef.current, undefined);
  assert.equal(h.env.logicalQuestionUnitRef.current, undefined);
  assert.equal(h.env.latestManualCorrectionTargetRef.current, undefined);
  assert.equal(h.env.settledAdvisorExecutionPlanRef.current, undefined);
  assert.equal(h.project().currentQuestionForEvaluation, undefined);
  assert.equal(h.project().evaluationQuestionPending, false);
  assert.equal(h.traces.length, 1, "history intentionally retained");
  assert.equal(h.select().status, "none");
  assert.equal(h.select().traceId, undefined);
});

test("B2 current source: prior-session settlement and raw LQU are rejected, even with a retained Answer", () => {
  const h = harness();
  h.runtime.sessionId = "session-2";
  assert.equal(h.project().currentQuestionForEvaluation, undefined);
  assert.equal(h.project().evaluationQuestionPending, false);
  assert.equal(h.select().status, "unavailable");
  assert.equal(h.select().traceId, undefined);
  h.env.state.latestSuggestion = null;
  assert.equal(h.select().status, "none");
  h.env.logicalQuestionUnitRef.current = { ...unit(h.a), sessionId: "session-2" };
  assert.equal(h.project().currentQuestionForEvaluation, undefined);
  assert.equal(h.project().evaluationQuestionPending, true);
  assert.equal(h.select().status, "pending");
  assert.equal(h.select().traceId, undefined, "same LQU/revision in a prior session cannot supply an attempt");
});

test("B2 current source: admitted same-session revision is pending only while settlement is absent", () => {
  const h = harness();
  h.env.currentQuestionSettlementRef.current = undefined;
  h.env.logicalQuestionUnitRef.current = { ...unit(h.a), revision: 2 };
  assert.equal(h.project().currentQuestionForEvaluation, undefined);
  assert.equal(h.project().evaluationQuestionPending, true);
  assert.equal(h.select().status, "pending");
  assert.equal(h.select().traceId, undefined, "no fallback to the old settled revision");
  h.env.currentQuestionSettlementRef.current = h.b;
  h.traces.unshift(trace(h.b, "error"));
  assert.equal(h.project().evaluationQuestionPending, false);
  assert.equal(h.select().traceId, "trace-B", "raw admitted Voice does not overrule settled Screen");
});

// ===========================================================================
// Task 178A (AE1, AE2): Type settled and Relation settled are the adoption of a
// current-question settlement, through the real Screen and Voice adoption code.
// The stream lives in the bundled vm realm; plain copies are compared.
// ===========================================================================
const aeSettlementEvents = h => JSON.parse(JSON.stringify(h.criticalEvents.events()));

test("AE1/AE2 Screen: a settlement is announced as one Type fact and one Relation fact only when it is adopted after its lifecycle receipt", () => {
  const rejected = harness();
  rejected.traces.unshift(trace(rejected.b, "error"));
  publishScreen(rejected, { authorized: false });
  assert.equal(rejected.env.currentQuestionSettlementRef.current, rejected.a, "a computed settlement that is not adopted");
  assert.deepEqual(aeSettlementEvents(rejected), [], "emits nothing");

  const h = harness();
  h.traces.unshift(trace(h.b, "running"));
  publishScreen(h);
  assert.equal(h.env.currentQuestionSettlementRef.current, h.b);
  const events = aeSettlementEvents(h);
  assert.deepEqual(events.map(event => [event.fact, event.stage, event.purpose, event.sequence]), [
    ["type-settled", "settlement-adopted", "formal", 1],
    ["relation-settled", "settlement-adopted", "formal", 2],
  ]);
  const [type, relation] = events;
  assert.equal(type.refs.settlementId, "settlement-B");
  assert.equal(relation.refs.settlementId, type.refs.settlementId, "one adoption, two facts sharing the settlement");
  assert.equal(type.refs.questionType, "field-knowledge");
  assert.equal(type.refs.relation, undefined);
  assert.equal(relation.refs.relation, "followup-parent");
  assert.equal(relation.refs.questionType, undefined);
  for (const event of events) {
    // Session and epoch come from the settlement itself.
    assert.equal(event.runtimeSessionId, h.b.sessionId);
    assert.equal(event.runtimeEpoch, h.b.runtimeEpoch);
    assert.equal(event.refs.logicalQuestionUnitId, "B");
    assert.equal(event.refs.logicalQuestionRevision, 1);
    assert.equal(event.refs.sourceKind, "screen");
    assert.deepEqual(event.refs.sourceObservationIds, ["observation-B"]);
    assert.equal(event.refs.traceId, "trace-B");
  }
  // Publishing the same settlement again is not a second adoption.
  publishScreen(h);
  assert.equal(aeSettlementEvents(h).length, 2);
  assert.equal(h.criticalEvents.stream.getStats().duplicateSuppressed, 2);
});

test("AE1/AE2 Voice: the deferred adoption announces its settlement once; a pinned historical run that may not adopt announces nothing", () => {
  const h = harness();
  h.b = settlement("B");
  h.traces.unshift(trace(h.b));
  h.env.logicalQuestionUnitRef.current = unit(h.b);
  h.env.latestManualCorrectionTargetRef.current = { logicalQuestionUnit: unit(h.b) };
  h.env.isSelectedHistoricalQuestion = callback("isSelectedHistoricalQuestion", h.context);
  const commit = evaluate(`(${declaration("commitDeferredResponseAuthorizedState").initializer.getText(hook)})`, h.context);
  Object.assign(h.env, {
    // Response opportunity still suppresses the mutation: nothing is adopted.
    responseMutationSuppressed: true, options: {}, selectedQuestionOnly: false, traceId: "trace-B",
    advisorJob: { logicalQuestionUnit: unit(h.b) }, currentQuestionSettlement: h.b,
    settledExecutionPlan: { id: "plan-B" }, currentQuestionSourceKind: "voice", currentQuestionSourceObservationIds: [],
  });
  commit();
  assert.equal(h.env.currentQuestionSettlementRef.current, h.a);
  assert.deepEqual(aeSettlementEvents(h), []);
  // The gate authorizes: the real deferred adoption runs, more than once.
  h.env.responseMutationSuppressed = false;
  commit();
  commit();
  assert.equal(h.env.currentQuestionSettlementRef.current, h.b);
  const events = aeSettlementEvents(h);
  assert.deepEqual(events.map(event => [event.fact, event.refs.settlementId, event.refs.sourceKind]), [
    ["type-settled", "settlement-B", "voice"],
    ["relation-settled", "settlement-B", "voice"],
  ]);
  assert.deepEqual(events[0].refs.sourceTurnIds, ["turn-B"]);
  // A historical selected question never becomes the session's settlement.
  h.env.manualAdviseDisplayRef.current.selectedTarget = { sessionId: h.runtime.sessionId, logicalQuestionUnitId: "A" };
  Object.assign(h.env, { selectedQuestionOnly: h.env.isSelectedHistoricalQuestion("A"),
    advisorJob: { logicalQuestionUnit: unit(h.a) }, currentQuestionSettlement: h.a });
  commit();
  assert.equal(h.env.currentQuestionSettlementRef.current, h.b);
  assert.equal(aeSettlementEvents(h).length, 2);
  // A settlement of another runtime session is refused by the event layer.
  const foreign = harness();
  foreign.b = settlement("B", "voice", "session-other");
  Object.assign(foreign.env, {
    responseMutationSuppressed: false, options: {}, selectedQuestionOnly: false, traceId: "trace-B",
    advisorJob: { logicalQuestionUnit: unit(foreign.b) }, currentQuestionSettlement: foreign.b,
    settledExecutionPlan: undefined, currentQuestionSourceKind: "voice", currentQuestionSourceObservationIds: [],
  });
  evaluate(`(${declaration("commitDeferredResponseAuthorizedState").initializer.getText(hook)})`, foreign.context)();
  assert.deepEqual(aeSettlementEvents(foreign), []);
  assert.equal(foreign.criticalEvents.stream.getStats().staleSessionRejected, 2);
});

test("AE1/AE2 Voice, deferred (Response Opportunity gated) adoption: the run adopts once, after its effective view replaced its own settlement, and that one announcement carries the effective stage and the effective values", () => {
  const run = declaration("runAdvisor").initializer.arguments[0];
  const parent = { id: "parent-a", questionType: "coding", topic: "Implement a cache.", playbookPhase: "implementation_validation",
    revisions: 1, createdAt: 1, updatedAt: 1, supportedFactAnchors: [], phaseProgress: {} };
  const h = harness();
  // The model abstained on both; the null hypothesis keeps the active parent.
  const raw = { ...settlement("B"), questionType: "unknown", relation: "unknown" };
  h.traces.unshift(trace(raw));
  h.env.logicalQuestionUnitRef.current = unit(raw);
  h.env.latestManualCorrectionTargetRef.current = undefined;
  const view = production.buildEffectiveAdvisorSettlementView({
    settlement: raw, activeMeetingTask: { id: "parent-a", parent }, taskRuntimeRevision: 1,
    fallback: { questionType: "unknown", relation: "unknown" }, preserveCurrentBranchOnAbstention: true });
  const effective = view.effectiveSettlement;
  assert.deepEqual([effective.settlementId, effective.questionType, effective.relation, effective.rawQuestionType, effective.rawRelation],
    ["settlement-B", "coding", "followup-parent", "unknown", "unknown"]);
  // As in runAdvisor while the gate is pending: the effective view has replaced
  // the run's local settlement, and the mutation is still suppressed.
  Object.assign(h.env, { responseMutationSuppressed: true, options: {}, selectedQuestionOnly: false, traceId: "trace-B",
    advisorJob: { logicalQuestionUnit: unit(raw) }, currentQuestionSettlement: effective, effectiveAdvisorSettlementView: view,
    settledExecutionPlan: { id: "plan-B" }, currentQuestionSourceKind: "voice", currentQuestionSourceObservationIds: [] });
  const immediate = assignmentGuard("currentQuestionSettlement", run);
  const effectiveAssignment = assignmentGuard("effectiveAdvisorSettlementView.effectiveSettlement", run);
  evaluate(`(() => { ${immediate.getText(hook)} })()`, h.context);
  evaluate(`(() => { ${effectiveAssignment.getText(hook)} })()`, h.context);
  const commit = evaluate(`(${declaration("commitDeferredResponseAuthorizedState").initializer.getText(hook)})`, h.context);
  commit();
  assert.equal(h.env.currentQuestionSettlementRef.current, h.a, "nothing is adopted while the response is not authorized");
  assert.deepEqual(aeSettlementEvents(h), [], "and nothing is announced");
  // The gate authorizes: the real deferred adoption runs (the Hook calls it
  // before the model and again after it).
  h.env.responseMutationSuppressed = false;
  commit();
  commit();
  assert.equal(h.env.currentQuestionSettlementRef.current, effective);
  const events = aeSettlementEvents(h);
  assert.deepEqual(events.map(event => [event.fact, event.stage, event.refs.questionType ?? event.refs.relation, event.refs.settlementId]), [
    ["type-settled", "effective-settlement-adopted", "coding", "settlement-B"],
    ["relation-settled", "effective-settlement-adopted", "followup-parent", "settlement-B"],
  ], "one announcement, of the effective settlement, under the stage that names it");
  assert.equal(events.some(event => event.stage === "settlement-adopted" ||
    event.refs.questionType === "unknown" || event.refs.relation === "unknown"), false,
  "the run's own settlement was never the session's settlement on this path, so it is not announced");
  assert.equal(h.criticalEvents.stream.getStats().duplicateSuppressed, 2, "the second call adopts the same settlement");
});

test("AE1/AE2 the session's current settlement returns to an earlier one: the real adoption of B, then A, then B again announces B again, so the last settlement facts name the settlement the session holds", () => {
  const h = harness();
  h.b = settlement("B");
  h.env.latestManualCorrectionTargetRef.current = undefined;
  const commit = evaluate(`(${declaration("commitDeferredResponseAuthorizedState").initializer.getText(hook)})`, h.context);
  const adopt = (source, traceId) => {
    Object.assign(h.env, { responseMutationSuppressed: false, options: {}, selectedQuestionOnly: false, traceId,
      advisorJob: { logicalQuestionUnit: unit(source) }, currentQuestionSettlement: source,
      settledExecutionPlan: undefined, currentQuestionSourceKind: "voice", currentQuestionSourceObservationIds: [] });
    commit();
    assert.equal(h.env.currentQuestionSettlementRef.current, source);
  };
  const facts = () => aeSettlementEvents(h).map(event => [event.fact, event.refs.settlementId, event.refs.traceId]);
  adopt(h.b, "trace-B");
  adopt(h.a, "trace-A");
  assert.deepEqual(facts(), [
    ["type-settled", "settlement-B", "trace-B"], ["relation-settled", "settlement-B", "trace-B"],
    ["type-settled", "settlement-A", "trace-A"], ["relation-settled", "settlement-A", "trace-A"],
  ]);
  // A regenerate of the answer to B adopts the stored settlement B again. Its
  // Type and Relation are the ones announced before.
  adopt(h.b, "trace-B-regenerate");
  assert.deepEqual(facts().slice(4), [
    ["type-settled", "settlement-B", "trace-B-regenerate"], ["relation-settled", "settlement-B", "trace-B-regenerate"],
  ], "the return to B is announced");
  for (const fact of ["type-settled", "relation-settled"]) {
    assert.equal(aeSettlementEvents(h).filter(event => event.fact === fact).at(-1).refs.settlementId,
      h.env.currentQuestionSettlementRef.current.settlementId, `the last ${fact} fact names the current settlement`);
  }
  // Adopting the current settlement once more says nothing.
  adopt(h.b, "trace-B-again");
  assert.equal(facts().length, 6);
});

test("AE1/AE2 Voice: the immediate adoption announces the settled values, and the effective settlement that replaces it is announced under its own stage, only for the Type or Relation it changed; a re-run that adopts the raw settlement again is announced again", () => {
  const run = declaration("runAdvisor").initializer.arguments[0];
  // The two real assignments of one Voice run, in source order.
  const immediate = assignmentGuard("currentQuestionSettlement", run);
  const effective = assignmentGuard("effectiveAdvisorSettlementView.effectiveSettlement", run);
  assert.ok(immediate.end < effective.pos, "the settled values are adopted before the effective view replaces them");
  const parent = { id: "parent-a", questionType: "coding", topic: "Implement a cache.", playbookPhase: "implementation_validation",
    revisions: 1, createdAt: 1, updatedAt: 1, supportedFactAnchors: [], phaseProgress: {} };
  const adopt = (h, raw) => {
    h.env.logicalQuestionUnitRef.current = unit(raw);
    h.env.latestManualCorrectionTargetRef.current = undefined;
    Object.assign(h.env, { responseMutationSuppressed: false, options: {}, selectedQuestionOnly: false, traceId: "trace-B",
      advisorJob: { logicalQuestionUnit: unit(raw) }, currentQuestionSettlement: raw,
      currentQuestionSourceKind: "voice", currentQuestionSourceObservationIds: [] });
    evaluate(`(() => { ${immediate.getText(hook)} })()`, h.context);
    assert.equal(h.env.currentQuestionSettlementRef.current, raw);
    // The production null hypothesis over the adopted settlement.
    h.env.effectiveAdvisorSettlementView = production.buildEffectiveAdvisorSettlementView({
      settlement: raw, activeMeetingTask: { id: "parent-a", parent }, taskRuntimeRevision: 1,
      fallback: { questionType: "unknown", relation: "unknown" }, preserveCurrentBranchOnAbstention: true });
    const adopted = h.env.effectiveAdvisorSettlementView.effectiveSettlement;
    assert.ok(adopted, "the effective settlement exists");
    evaluate(`(() => { ${effective.getText(hook)} })()`, h.context);
    evaluate(`(() => { ${effective.getText(hook)} })()`, h.context);
    assert.equal(h.env.currentQuestionSettlementRef.current, adopted, "the effective settlement is the session's settlement");
    return adopted;
  };
  const row = event => [event.fact, event.stage, event.refs.questionType ?? event.refs.relation, event.refs.settlementId];

  // The model abstained on both: the null hypothesis keeps the active parent.
  const abstained = harness();
  const raw = { ...settlement("B"), questionType: "unknown", relation: "unknown" };
  const adopted = adopt(abstained, raw);
  assert.deepEqual([adopted.settlementId, adopted.questionType, adopted.relation, adopted.nullHypothesisApplied],
    ["settlement-B", "coding", "followup-parent", true]);
  assert.deepEqual(aeSettlementEvents(abstained).map(row), [
    ["type-settled", "settlement-adopted", "unknown", "settlement-B"],
    ["relation-settled", "settlement-adopted", "unknown", "settlement-B"],
    ["type-settled", "effective-settlement-adopted", "coding", "settlement-B"],
    ["relation-settled", "effective-settlement-adopted", "followup-parent", "settlement-B"],
  ], "the last fact per kind carries what the run adopted");
  // A re-run of the same settlement: the real immediate assignment makes the
  // raw values the session's settlement again, then the effective view
  // replaces them again. Both returns are changes and both are announced.
  const before = abstained.criticalEvents.stream.getStats().duplicateSuppressed;
  adopt(abstained, raw);
  assert.deepEqual(aeSettlementEvents(abstained).slice(4).map(row), [
    ["type-settled", "settlement-adopted", "unknown", "settlement-B"],
    ["relation-settled", "settlement-adopted", "unknown", "settlement-B"],
    ["type-settled", "effective-settlement-adopted", "coding", "settlement-B"],
    ["relation-settled", "effective-settlement-adopted", "followup-parent", "settlement-B"],
  ], "a Type and a Relation that return to an earlier value are facts again");
  // Only the second, identical effective assignment of each run was a repeat.
  assert.equal(abstained.criticalEvents.stream.getStats().duplicateSuppressed, before + 2);
  for (const fact of ["type-settled", "relation-settled"]) {
    const last = aeSettlementEvents(abstained).filter(event => event.fact === fact).at(-1);
    const current = abstained.env.currentQuestionSettlementRef.current;
    assert.equal(last.refs.questionType ?? last.refs.relation, fact === "type-settled" ? current.questionType : current.relation,
      "the last fact of the settlement names the value the session holds now");
  }

  // Only the Relation changes: no second Type fact.
  const relationOnly = harness();
  const typed = adopt(relationOnly, { ...settlement("B"), questionType: "field-knowledge", relation: "unknown" });
  assert.deepEqual([typed.questionType, typed.relation], ["field-knowledge", "followup-parent"]);
  assert.deepEqual(aeSettlementEvents(relationOnly).map(row), [
    ["type-settled", "settlement-adopted", "field-knowledge", "settlement-B"],
    ["relation-settled", "settlement-adopted", "unknown", "settlement-B"],
    ["relation-settled", "effective-settlement-adopted", "followup-parent", "settlement-B"],
  ]);

  // The effective view changes nothing: one pair, as for Screen.
  const unchanged = harness();
  const same = adopt(unchanged, { ...settlement("B"), questionType: "coding", relation: "followup-parent" });
  assert.deepEqual([same.questionType, same.relation, same.nullHypothesisApplied], ["coding", "followup-parent", false]);
  assert.deepEqual(aeSettlementEvents(unchanged).map(row), [
    ["type-settled", "settlement-adopted", "coding", "settlement-B"],
    ["relation-settled", "settlement-adopted", "followup-parent", "settlement-B"],
  ]);
  assert.equal(unchanged.criticalEvents.stream.getStats().duplicateSuppressed, 4);
});

test("AE1/AE2 manual retype of the owner a question shares: each live projection that changes the current settlement's Type is one Type fact under its own stage, there and back, and its unchanged Relation is not repeated", () => {
  const h = harness();
  h.b = settlement("B");
  h.traces.unshift(trace(h.b));
  h.env.logicalQuestionUnitRef.current = unit(h.b);
  h.env.latestManualCorrectionTargetRef.current = { logicalQuestionUnit: unit(h.b) };
  h.env.isSelectedHistoricalQuestion = callback("isSelectedHistoricalQuestion", h.context);
  // B is adopted by the real deferred Voice adoption.
  Object.assign(h.env, { responseMutationSuppressed: false, options: {}, selectedQuestionOnly: false, traceId: "trace-B",
    advisorJob: { logicalQuestionUnit: unit(h.b) }, currentQuestionSettlement: h.b,
    settledExecutionPlan: { id: "plan-B" }, currentQuestionSourceKind: "voice", currentQuestionSourceObservationIds: [] });
  evaluate(`(${declaration("commitDeferredResponseAuthorizedState").initializer.getText(hook)})`, h.context)();
  assert.equal(aeSettlementEvents(h).length, 2);
  // The real projection branch of the Type correction: a historical question is
  // selected and its owner, which B shares, was retyped.
  const correction = declaration("correctActiveQuestionType").initializer.arguments[0];
  const projection = assignmentGuard("projected", correction);
  assert.match(projection.expression.getText(hook), /beforeType !== afterType/);
  Object.assign(h.env, { current: h.b, source: { owner: { kind: "parent-mainline" } }, beforeType: "field-knowledge",
    afterType: "coding", parentAfter: { id: "parent-a", revisions: 2 }, correctionTrace: { id: "trace-correction" },
    correctionCurrentQuestionSettlement: { manualCorrectionRevision: 1 } });
  evaluate(`(() => { ${projection.getText(hook)} })()`, h.context);
  const projected = h.env.currentQuestionSettlementRef.current;
  assert.deepEqual([projected.settlementId, projected.questionType, projected.typeAuthoritySource, projected.relation],
    ["settlement-B", "coding", "manual-correction", "followup-parent"]);
  const events = aeSettlementEvents(h);
  assert.deepEqual(events.map(event => [event.fact, event.stage, event.refs.questionType ?? event.refs.relation]), [
    ["type-settled", "settlement-adopted", "field-knowledge"],
    ["relation-settled", "settlement-adopted", "followup-parent"],
    ["type-settled", "manual-retype-projection", "coding"],
  ]);
  assert.deepEqual([events[2].refs.settlementId, events[2].refs.authoritySource, events[2].refs.traceId],
    ["settlement-B", "manual-correction", "trace-correction"]);
  // The same owner type again is not a projection and announces nothing.
  Object.assign(h.env, { current: projected, beforeType: "coding", afterType: "coding" });
  evaluate(`(() => { ${projection.getText(hook)} })()`, h.context);
  assert.equal(aeSettlementEvents(h).length, 3);
  // There and back: the owner is retyped to its first type, to coding and back
  // again, through the same real branch. Every change of the adopted Type is a
  // fact, so the last Type fact always names the Type the session holds.
  let revisions = 2;
  for (const [beforeType, afterType] of [["coding", "field-knowledge"], ["field-knowledge", "coding"], ["coding", "field-knowledge"]]) {
    Object.assign(h.env, { current: h.env.currentQuestionSettlementRef.current, beforeType, afterType,
      parentAfter: { id: "parent-a", revisions: ++revisions } });
    evaluate(`(() => { ${projection.getText(hook)} })()`, h.context);
    const adopted = h.env.currentQuestionSettlementRef.current;
    assert.deepEqual([adopted.settlementId, adopted.questionType, adopted.activeParentRevision], ["settlement-B", afterType, revisions]);
    const last = aeSettlementEvents(h).filter(event => event.fact === "type-settled").at(-1);
    assert.deepEqual([last.stage, last.refs.settlementId, last.refs.questionType], ["manual-retype-projection", "settlement-B", afterType],
      `the retype to ${afterType} is announced`);
  }
  assert.deepEqual(aeSettlementEvents(h).map(event => [event.fact, event.refs.questionType ?? event.refs.relation]), [
    ["type-settled", "field-knowledge"], ["relation-settled", "followup-parent"],
    ["type-settled", "coding"], ["type-settled", "field-knowledge"], ["type-settled", "coding"], ["type-settled", "field-knowledge"],
  ], "four changes of the Type, and the Relation said once");
  assert.deepEqual(aeSettlementEvents(h).map(event => event.sequence), [1, 2, 3, 4, 5, 6]);
});
