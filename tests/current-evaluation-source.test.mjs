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
    contents: ["human-evaluation", "current-question-settlement", "source-owned-transition-runtime", "playbook-phase-history", "runtime-inference-runtime"]
      .map(name => `export * from "./src/lib/meeting/${name}.ts";`).join("\n"),
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
    traceStoreRef: { current: { updateMetadata(id, patch) {
      const target = traces.find(item => item.id === id);
      assert.ok(target, `trace exists: ${id}`);
      Object.assign(target.metadata, patch);
    } } },
    state: { latestSuggestion: suggestion, partialSuggestion: "", status: "listening" },
  };
  const context = vm.createContext(env);
  const projectionNames = ["presentationSessionId", "evaluationSettlement", "currentQuestionForEvaluation", "evaluationQuestionPending"];
  const projectionSource = projectionNames.map(name => {
    const node = declaration(name);
    assert.ok(ts.isVariableStatement(node.parent.parent));
    return node.parent.parent.getText(hook);
  }).join("\n");
  const selectionFactory = declaration("evaluationTarget", ui, ui).initializer.arguments[0].getText(ui);
  return {
    a, b, env, context, runtime, traces, stable,
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
    responseMutationSuppressed: false, options: {}, selectedQuestionOnly: false,
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
    "taskRelationCanonicalShadowRuntimeRef", "answerResolutionRuntimeRef", "evidenceRequirementRuntimeRef",
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
