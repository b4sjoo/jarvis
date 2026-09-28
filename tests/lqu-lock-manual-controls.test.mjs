import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const output = path.resolve(process.env.JARVIS_TEST_OUTPUT_DIR ?? ".tmp-tests");
const production = {};
for (const name of [
  "manual-advise-display", "stable-answer", "meeting-answer", "meeting-answer-display",
  "response-action-target", "manual-runtime-action", "manual-question-type-correction",
  "logical-question-ownership", "logical-question-unit", "current-question-settlement",
  "context-manager", "active-meeting-task", "active-branch-phase", "coding-child-phase",
  "interview-playbook", "playbook-phase", "playbook-phase-history", "human-evaluation", "force-advise",
  "effective-question-source-ledger", "manual-correction-intent", "manual-correction-transition",
  "settled-advisor-execution-plan", "effective-task-source-view", "runtime-commit-authorization",
  "bounded-recent-history",
]) {
  Object.assign(production, await import(pathToFileURL(path.join(output, `src/lib/meeting/${name}.js`))));
}
const hook = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);

function find(node, predicate, label) {
  let found;
  const visit = candidate => {
    if (predicate(candidate)) found ??= candidate;
    if (!found) ts.forEachChild(candidate, visit);
  };
  visit(node);
  assert.ok(found, `production subtree: ${label}`);
  return found;
}

function declaration(name, node = hook) {
  return find(node, n => (ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n)) &&
    n.name?.getText(hook) === name, name);
}

function evaluate(text, context) {
  return vm.runInContext(ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, context);
}

function callbackNode(name) {
  return declaration(name).initializer.arguments[0];
}

function callback(name, context) {
  return evaluate(`(${callbackNode(name).getText(hook)})`, context);
}

// Reuse the existing source-owner fixture, including its complete evidence record.
// These declarations provide data; all selection and authority checks remain production code.
function sourceFixture() {
  const ast = ts.createSourceFile("fixture.ts", readFileSync("tests/response-action-target.test.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const names = new Set(["voiceLogicalQuestion", "voiceSourceHash", "frozenSettlement", "stable", "context", "effectiveVoiceRecord"]);
  const nodes = ast.statements.filter(n => ts.isFunctionDeclaration(n) ? names.has(n.name.text) :
    ts.isVariableStatement(n) && names.has(n.declarationList.declarations[0].name.getText(ast)));
  assert.equal(nodes.length, names.size);
  return evaluate(`${nodes.map(n => n.getText(ast)).join("\n")}\n({stable, unit:voiceLogicalQuestion, record:effectiveVoiceRecord(), context:context()})`,
    vm.createContext({ ...production }));
}

function displaySnapshot(stable) {
  return {
    stable, streaming: false,
    target: {
      sessionId: stable.sessionId, logicalQuestionUnitId: stable.logicalQuestionUnitId,
      logicalQuestionRevision: stable.logicalQuestionRevision, suggestionId: stable.suggestion.id,
      generationId: stable.suggestion.id, traceId: stable.suggestion.sourceTraceId, stableRevision: stable.revision,
    },
    sections: production.buildMeetingAnswerDisplayModel({
      content: stable.suggestion.content, parsedAnswer: stable.suggestion.meetingAnswer,
    }),
  };
}

function harness({ activeChild = false, selectedChild = false, phase = "design_framing" } = {}) {
  const f = sourceFixture();
  const manager = new production.MeetingContextManager();
  manager.reset({ sessionId: f.unit.sessionId });
  const ledger = new production.EffectiveQuestionSourceLedger();
  manager.setEffectiveQuestionSourceLedger(ledger);
  const playbook = production.selectInterviewPlaybook({ questionType: "general-system-design" });
  const parent = {
    ...f.context.activeMeetingTask.parent, stableKind: "general-system-design", source: "voice",
    playbook: { ...playbook, phase }, playbookPhase: phase, phaseProgress: { [phase]: true },
    sourceQuestionUnitId: f.unit.id, sourceQuestionRevision: f.unit.revision,
    startTurnId: f.unit.currentTurnId, canonicalQuestionSourceTurnIds: f.unit.sourceTurnIds,
  };
  delete parent.questionType;
  assert.equal(manager.commitTaskRuntimeTransition({
    id: "seed-parent", transition: "create-parent", reason: "fixture", parent,
  }).authorized, true);
  if (activeChild || selectedChild) {
    const codingPlaybook = production.selectInterviewPlaybook({ questionType: "coding" });
    const before = manager.getState().taskRuntime.parent;
    assert.equal(manager.commitTaskRuntimeTransition({
      id: "seed-child", transition: "attach-child", reason: "fixture",
      parent: { ...before, revisions: before.revisions + 1, child: {
        id: "child-code", questionType: "coding", relation: "child-probe", intent: "implementation-probe",
        question: f.unit.normalizedText, basedOnTurnIds: selectedChild ? f.unit.sourceTurnIds : ["turn-active-child"],
        basedOnObservationIds: [], createdAt: 20, updatedAt: 20,
        phaseState: production.createCodingChildPhaseState({ questionType: "coding", playbook: codingPlaybook }),
      } },
    }).authorized, true);
  }
  const sourceOwner = selectedChild
    ? { kind: "active-child", parentId: parent.id, childId: "child-code" }
    : { kind: "parent-mainline", parentId: parent.id };
  f.record.owner = sourceOwner;
  f.record.relation = selectedChild ? "child-probe" : "followup-parent";
  const lineage = {
    questionInstanceId: `lqu:${f.unit.id}`, triggerTurnId: f.unit.currentTurnId,
    sourceSuggestionId: f.stable.suggestion.id, questionOriginTraceId: "trace-A",
    sessionId: f.unit.sessionId, runtimeEpoch: f.unit.runtimeEpoch, identityState: "canonical",
  };
  const selected = production.commitStableAnswerRevision({
    ...f.stable,
    settlementSnapshot: { ...f.stable.settlementSnapshot,
      questionType: selectedChild ? "coding" : "general-system-design", relation: f.record.relation },
    candidate: { ...f.stable.suggestion, sourceTraceId: "trace-A", questionLineage: lineage,
      content: "Answer: Selected A owns this control.", generationPhase: selectedChild ? "implementation_validation" : phase,
      meetingAnswer: production.parseMeetingAnswer("Answer: Selected A owns this control.") },
    authorizedArtifacts: ["answer"], sectionOwner: sourceOwner,
  });
  assert.ok(selected);
  const backgroundUnit = {
    ...structuredClone(f.unit), id: "background-B", currentTurnId: "turn-B", sourceTurnIds: ["turn-B"],
    normalizedText: "Background B must never become the selected control source.",
    restoredAnswerFocusText: "Background B must never become the selected control source.",
    sources: [{ turnId: "turn-B", text: "Background B must never become the selected control source.", startedAt: 30, endedAt: 35 }],
    startedAt: 30, updatedAt: 35,
  };
  const backgroundSource = production.createProvisionalCurrentQuestion({ logicalQuestionUnit: backgroundUnit, sourceKind: "voice" });
  const backgroundRecord = {
    ...structuredClone(f.record), recordId: "source-record-B", logicalQuestionUnitId: backgroundUnit.id,
    currentTurnId: "turn-B", sourceTurnIds: ["turn-B"], text: backgroundUnit.normalizedText,
    answerFocusText: backgroundUnit.normalizedText, effectiveSourceTexts: [{ turnId: "turn-B", text: backgroundUnit.normalizedText }],
    sourceHash: backgroundSource.sourceHash, startedAt: 30, updatedAt: 35, settledAt: 36,
  };
  const background = production.commitStableAnswerRevision({
    ...selected, revision: 6, logicalQuestionUnitId: backgroundUnit.id,
    candidate: { ...selected.suggestion, id: "suggestion-B", sourceTraceId: "trace-B", content: "Answer: Background B.",
      questionLineage: { ...lineage, questionInstanceId: `lqu:${backgroundUnit.id}`, triggerTurnId: "turn-B", sourceSuggestionId: "suggestion-B" },
      meetingAnswer: production.parseMeetingAnswer("Answer: Background B.") },
    questionSourceHash: backgroundSource.sourceHash,
    settlementSnapshot: { ...selected.settlementSnapshot, logicalQuestionUnitId: backgroundUnit.id,
      sourceHash: backgroundSource.sourceHash, sourceTurnIds: ["turn-B"] },
    authorizedArtifacts: ["answer"], sectionOwner: sourceOwner,
  });
  for (const unit of [f.unit, backgroundUnit]) {
    manager.addTranscriptTurn({ id: unit.currentTurnId, text: unit.normalizedText, speaker: "them",
      startedAt: unit.startedAt, endedAt: unit.updatedAt, isFinal: true, source: "system-audio" });
  }
  const display = new production.ManualAdviseDisplay();
  const snapshot = displaySnapshot(selected);
  display.select(snapshot, snapshot);
  display.toggle();
  display.select(displaySnapshot(background), displaySnapshot(background));
  const target = (unit, answer) => ({
    logicalQuestionUnit: unit, logicalQuestionLease: production.createLogicalQuestionUnitLease(unit),
    questionLineage: answer.suggestion.questionLineage, sourceKind: "voice", sourceObservationIds: [],
    settlement: answer.settlementSnapshot, updatedAt: unit.updatedAt, targetKind: "substantive", originTraceId: answer.suggestion.sourceTraceId,
  });
  const selectedTarget = target(f.unit, selected);
  const backgroundTarget = target(backgroundUnit, background);
  const calls = [], events = [], writes = [], traces = [], finalizations = [], recordingEvents = [];
  const forcePresentation = {
    targetId: "force-B", targetKind: "canonical-question", originalTraceId: "trace-B", turnId: "turn-B",
    text: backgroundUnit.normalizedText, logicalQuestionUnitId: backgroundUnit.id,
    logicalQuestionUnitRevision: backgroundUnit.revision, sourceTurnIds: backgroundUnit.sourceTurnIds,
    observedAction: "answer", executionAuthorized: true,
    status: production.deriveForceAdviseTargetStatus({ automaticExecutionState: "visible-committed", manualExecutionState: "idle" }),
    automaticExecutionState: "visible-committed", manualExecutionState: "idle", updatedAt: 40,
  };
  let state = { ...manager.getState(), status: "listening", latestSuggestion: background.suggestion,
    latestReliableSuggestion: background.suggestion, latestInterviewerTurnCandidate: forcePresentation,
    currentQuestionLineage: background.suggestion.questionLineage, error: null };
  let sequence = 0;
  const realCommit = manager.commitTaskRuntimeTransition.bind(manager);
  manager.commitTaskRuntimeTransition = input => {
    const result = realCommit(input);
    writes.push({ input, result });
    return result;
  };
  const environment = {
    ...production, structuredClone, Date, console,
    manualAdviseDisplayRef: { current: display }, stableAnswerRevisionRef: { current: background },
    latestManualCorrectionTargetRef: { current: backgroundTarget },
    manualCorrectionTargetHistoryRef: { current: [selectedTarget, backgroundTarget] },
    logicalQuestionUnitRef: { current: backgroundUnit }, runtimeEpochRef: { current: 3 },
    latestForceAdviseTargetRef: { current: { presentation: forcePresentation, logicalQuestionUnit: backgroundUnit,
      logicalQuestionLease: production.createLogicalQuestionUnitLease(backgroundUnit) } },
    effectiveQuestionSourceLedgerRef: { current: ledger },
    manualCorrectionRevisionRef: { current: 0 },
    currentQuestionSettlementRef: { current: structuredClone(background.settlementSnapshot) },
    settledAdvisorExecutionPlanRef: { current: undefined },
    recentAdvisorContinuityRef: { current: { recentCapsules: [] } },
    contextManagerRef: { current: manager }, playbookPhaseHistoryRef: { current: production.createPlaybookPhaseHistoryState() },
    sessionRecordingManagerRef: { current: { recordCaptureLifecycle: event => recordingEvents.push(event) } },
    state, currentSuggestionText: background.suggestion.content,
    createMeetingId: kind => `${kind}-${++sequence}`,
    recordManualRuntimeAction: event => events.push(event),
    setState: update => { state = update(state); environment.state = state; },
    flushPendingSentenceCompletion() {},
    runAdvisor: async options => calls.push(options),
    resolveCurrentSuggestionQuestionLineage: () => { throw new Error("selected control must not read background lineage"); },
    NO_ACTIVE_TASK_MESSAGE: "No active task", NO_SUGGESTION_MESSAGE: "No suggestion",
    traceStoreRef: { current: {
      startTrace: (kind, metadata) => { const trace = { id: `trace-${++sequence}`, kind, metadata, status: "running" }; traces.push(trace); return trace; },
      updateMetadata: (id, metadata) => { const trace = traces.find(t => t.id === id); if (trace) Object.assign(trace.metadata, metadata); },
      finishTrace: (id, status, error) => { const trace = traces.find(t => t.id === id); if (trace) Object.assign(trace, { status, error }); },
      finishStep() {}, getTraces: () => traces,
    } },
    finalizeCorrection: input => finalizations.push(input), correctionTrace: { id: "correction-trace" }, mutationStepId: "correction-step",
  };
  f.records = [f.record, backgroundRecord];
  for (const record of f.records) ledger.upsert(record);
  for (const unit of [f.unit, backgroundUnit]) manager.recordTaskQuestionAdmission({
    sessionId: f.unit.sessionId, parentId: parent.id, childId: selectedChild ? "child-code" : undefined,
    logicalQuestionUnitId: unit.id,
  });
  const context = vm.createContext(environment);
  environment.isManualRuntimeActionBusy = evaluate(`(${declaration("isManualRuntimeActionBusy").getText(hook)})`, context);
  environment.shortcutRejectionMessage = evaluate(`(${declaration("shortcutRejectionMessage").getText(hook)})`, context);
  environment.submitTaskRuntimeTransition = evaluate(`(${declaration("submitTaskRuntimeTransition").getText(hook)})`, context);
  environment.transitionForceAdviseTarget = callback("transitionForceAdviseTarget", context);
  environment.invalidateBackgroundAfterSelectedTaskMutation = callback("invalidateBackgroundAfterSelectedTaskMutation", context);
  environment.recordCommittedPlaybookPhaseTransition = callback("recordCommittedPlaybookPhaseTransition", context);
  for (const name of ["readManualCorrectionContext", "readManualCorrectionMenu", "readEffectiveSemanticTask", "isSelectedHistoricalQuestion"]) {
    environment[name] = callback(name, context);
  }
  const correctionContext = environment.readManualCorrectionContext(snapshot.target);
  const correctionInvocation = { correctionIntent: { kind: "independent" }, correctionTarget: correctionContext?.target };
  return { f, manager, ledger, selected, background, snapshot, selectedTarget, backgroundTarget, environment, context, correctionInvocation,
    display, calls, events, writes, traces, finalizations, recordingEvents, get state() { return state; } };
}

// Execute the contiguous production Correction entry through target and lease
// capture. Generation, relation IO and mutation are outside this subtree's claim.
function correctionIngress(h, invocation = {}) {
  const node = callbackNode("correctActiveQuestionType");
  const end = declaration("correctionLogicalQuestionLease", node).parent.parent;
  const statements = node.body.statements;
  const index = statements.indexOf(end);
  assert.ok(index >= 0);
  const body = statements.slice(0, index + 1).map(n => n.getText(hook)).join("\n");
  return evaluate(`(async (correctedType, source = "normal-mode", invocation = {}) => {
    ${body}
    return { correctionLogicalQuestionUnit, correctionLogicalQuestionLease, correctionLineage,
      targetResolution, canonicalCorrectionTarget, displayScopedCorrection };
  })`, h.context)("coding", "normal-mode", { ...h.correctionInvocation, ...invocation });
}

function correctionLeaseRecheck(h, captured) {
  Object.assign(h.environment, captured, { invocation: { ...h.correctionInvocation, displayTarget: h.snapshot.target } });
  const node = callbackNode("correctActiveQuestionType");
  const guard = find(node, n => ts.isIfStatement(n) && n.expression.getText(hook) === "correctionLogicalQuestionLease", "correction lease recheck");
  return evaluate(`(() => { ${guard.getText(hook)}; return "authorized"; })()`, h.context);
}

function history(h, { from = "requirement_clarification", to = "design_framing", source = "automatic" } = {}) {
  const active = h.manager.getState().taskRuntime.parent;
  const branch = production.resolveEffectiveBranchPhase(active).view;
  const result = production.appendCommittedPlaybookPhaseTransition(h.environment.playbookPhaseHistoryRef.current, {
    operationId: "history-transition", owner: { kind: branch.ownerKind, id: branch.ownerId, parentId: branch.parentId },
    fromPhase: from, toPhase: to, taskRevision: active.revisions,
    expectedPhaseRevision: 0, committedAt: 20,
  }, source);
  assert.equal(result.status, "appended");
  h.environment.playbookPhaseHistoryRef.current = result.state;
}

test("B controls: production Correction ingress selects pinned A and preserves latest target B", async () => {
  const h = harness();
  const captured = await correctionIngress(h, { displayTarget: h.snapshot.target, actionId: "focus-A" });
  assert.equal(captured.correctionLogicalQuestionUnit.id, h.selected.logicalQuestionUnitId);
  assert.equal(captured.correctionLineage.questionInstanceId, `lqu:${h.f.unit.id}`);
  assert.equal(captured.targetResolution.task.parent.id, h.manager.getState().taskRuntime.parent.id);
  assert.equal(h.environment.latestManualCorrectionTargetRef.current, h.backgroundTarget);
  assert.equal(h.environment.logicalQuestionUnitRef.current.id, "background-B");
  assert.equal(h.environment.stableAnswerRevisionRef.current, h.background);
  assert.equal(correctionLeaseRecheck(h, captured), "authorized");
  h.environment.manualCorrectionTargetHistoryRef.current = [h.backgroundTarget];
  assert.equal(correctionLeaseRecheck(h, captured), "authorized", "retained ledger recovers A after history eviction");
  h.ledger.clear();
  h.ledger.upsert(h.f.records[1]);
  assert.equal(correctionLeaseRecheck(h, captured), undefined);
  assert.equal(h.finalizations.length, 1);
  assert.equal(h.writes.length, 0);
  assert.equal(h.calls.length, 0);
});

test("B controls: an evicted correction history entry is recovered from the real ledger", async () => {
  const h = harness();
  h.environment.manualCorrectionTargetHistoryRef.current = [h.backgroundTarget];
  const captured = await correctionIngress(h, { displayTarget: h.snapshot.target });
  assert.equal(captured.correctionLogicalQuestionUnit.id, h.f.unit.id);
  assert.equal(captured.correctionLogicalQuestionUnit.normalizedText, h.f.unit.normalizedText);
  assert.equal(correctionLeaseRecheck(h, captured), "authorized");
  assert.equal(h.environment.latestManualCorrectionTargetRef.current, h.backgroundTarget);
  assert.equal(h.writes.length, 0);
  assert.equal(h.calls.length, 0);
});

for (const invalid of ["stale-focus", "missing-source", "source-hash", "exited-parent", "clear"]) {
  test(`B controls: Correction rejects ${invalid} without selecting B`, async () => {
    const h = harness();
    const invocation = { displayTarget: h.snapshot.target };
    if (invalid === "stale-focus") invocation.displayTarget = { ...h.snapshot.target, suggestionId: "old-A" };
    if (invalid === "missing-source") {
      h.environment.manualCorrectionTargetHistoryRef.current = [h.backgroundTarget];
      h.ledger.clear(); h.ledger.upsert(h.f.records[1]);
    }
    if (invalid === "source-hash") h.ledger.upsert({ ...h.f.records[0], sourceHash: "changed" });
    if (invalid === "clear") h.manager.reset({ sessionId: "cleared-session" });
    if (invalid === "exited-parent") {
      h.manager.commitTaskRuntimeTransition({ id: "replace-owner", transition: "replace-parent", reason: "fixture-owner-exit",
        parent: { ...h.manager.getState().taskRuntime.parent, id: "new-parent" } });
      h.writes.length = 0;
    }
    assert.equal(await correctionIngress(h, invocation), undefined);
    assert.equal(h.events.at(-1).terminalDisposition, "stale");
    assert.equal(h.environment.latestManualCorrectionTargetRef.current, h.backgroundTarget);
    assert.equal(h.writes.length, 0);
    assert.equal(h.calls.length, 0);
  });
}

test("B controls: pinned parent Correction is rejected while a Coding child is active", async () => {
  const h = harness({ activeChild: true });
  assert.equal(Boolean(await correctionIngress(h)), false, "inactive parent branch must not reach Correction target capture");
  assert.equal(h.events.at(-1).terminalDisposition, "stale");
  assert.equal(h.events.at(-1).reason, "displayed-question-branch-inactive");
  assert.deepEqual(h.events.map(event => event.stage), ["requested", "terminal"]);
  assert.equal(h.manager.getState().taskRuntime.parent.child.id, "child-code");
  assert.equal(h.manager.getState().taskRuntime.parent.playbookPhase, "design_framing");
  assert.equal(h.writes.length, 0);
});

test("B controls: Correction can still capture the selected active child without replacing latest B", async () => {
  const h = harness({ selectedChild: true });
  const captured = await correctionIngress(h, { displayTarget: h.snapshot.target });
  assert.equal(captured.correctionLogicalQuestionUnit.id, h.f.unit.id);
  assert.equal(captured.targetResolution.task.child.id, "child-code");
  assert.equal(correctionLeaseRecheck(h, captured), "authorized");
  assert.equal(h.environment.latestManualCorrectionTargetRef.current, h.backgroundTarget);
  assert.equal(h.writes.length, 0);
});

test("B controls: replacing the selected child rejects its old click even under the same parent and Type", async () => {
  const h = harness({ selectedChild: true });
  const before = h.manager.getTaskRuntimeState().parent;
  assert.equal(h.manager.commitTaskRuntimeTransition({ id: "replace-child", transition: "attach-child", reason: "fixture",
    parent: { ...before, child: { ...before.child, id: "replacement-child" }, revisions: before.revisions + 1 } }).authorized, true);
  h.writes.length = 0;
  assert.equal(await correctionIngress(h, { displayTarget: h.snapshot.target }), undefined);
  assert.deepEqual(h.events.map(event => event.stage), ["requested", "terminal"]);
  assert.equal(h.events.at(-1).terminalDisposition, "stale");
  assert.equal(h.writes.length, 0);
  assert.equal(h.calls.length, 0);
});

for (const action of ["previous-phase", "next-phase"]) {
  test(`B controls: delayed Focus ${action} for A rejects after unlock displays B`, async () => {
    const h = harness();
    history(h);
    h.display.toggle();
    h.display.select(displaySnapshot(h.background), displaySnapshot(h.background));
    h.environment.resolveCurrentSuggestionQuestionLineage = callback("resolveCurrentSuggestionQuestionLineage", h.context);
    await callback("applyResponseAction", h.context)(action, { displayTarget: h.snapshot.target, uiSurface: "focus-mode" });
    assert.deepEqual({
      requestedQuestions: h.calls.map(call => call.logicalQuestionUnit?.id),
      committedCommands: h.writes.filter(write => write.result.mutationApplied).map(write => write.input.transition),
    }, { requestedQuestions: [], committedCommands: [] }, "an old Focus control must not dispatch or mutate background B");
    assert.equal(h.events.at(-1).terminalDisposition, "stale");
    assert.equal(h.events.at(-1).reason, "display-target-changed");
    assert.deepEqual(h.events.map(event => event.stage), ["requested", "terminal"]);
    assert.equal(h.display.current.target.logicalQuestionUnitId, "background-B");
    assert.equal(h.environment.stableAnswerRevisionRef.current, h.background);
  });

  test(`B controls: unpinned ${action} without display target keeps current-branch B semantics`, async () => {
    const h = harness();
    history(h);
    h.display.toggle();
    h.display.select(displaySnapshot(h.background), displaySnapshot(h.background));
    h.environment.resolveCurrentSuggestionQuestionLineage = callback("resolveCurrentSuggestionQuestionLineage", h.context);
    await callback("applyResponseAction", h.context)(action, { uiSurface: "focus-mode" });
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].logicalQuestionUnit.id, "background-B");
    assert.equal(h.calls[0].questionLineage.questionInstanceId, "lqu:background-B");
    assert.equal(h.calls[0].taskMutationAuthority, "preserve-parent");
    assert.equal(h.writes.length, action === "previous-phase" ? 1 : 0);
    if (action === "previous-phase") {
      assert.equal(h.writes[0].result.mutationApplied, true);
      assert.equal(h.writes[0].input.transition, "set-phase");
    }
    assert.equal(h.events.at(-1).terminalDisposition, "completed");
    assert.equal(h.environment.stableAnswerRevisionRef.current, h.background);
  });

  test(`B controls: actual ${action} rejects pinned parent while active child owns phase`, async () => {
    const h = harness({ activeChild: true });
    await callback("applyResponseAction", h.context)(action, { displayTarget: h.snapshot.target });
    assert.equal(h.events.at(-1).reason, "displayed-phase-owner-changed");
    assert.equal(h.calls.length, 0);
    assert.equal(h.writes.length, 0);
    assert.equal(h.manager.getState().taskRuntime.parent.playbookPhase, "design_framing");
  });

  for (const invalid of ["stale-focus", "source-hash", "exited-parent", "phase-changed"]) {
    test(`B controls: actual ${action} rejects ${invalid} without a B request or writer call`, async () => {
      const h = harness();
      const invocation = { displayTarget: h.snapshot.target };
      if (invalid === "stale-focus") invocation.displayTarget = { ...h.snapshot.target, suggestionId: "old-A" };
      if (invalid === "source-hash") h.ledger.upsert({ ...h.f.records[0], sourceHash: "changed" });
      if (invalid === "exited-parent" || invalid === "phase-changed") {
        const before = h.manager.getState().taskRuntime.parent;
        const after = invalid === "exited-parent" ? { ...before, id: "new-parent" } : {
          ...before, playbookPhase: "follow_up", playbook: { ...before.playbook, phase: "follow_up" }, revisions: before.revisions + 1,
        };
        assert.equal(h.manager.commitTaskRuntimeTransition({
          id: "runtime-change", transition: invalid === "exited-parent" ? "replace-parent" : "set-phase", reason: "fixture", parent: after,
        }).authorized, true);
        h.writes.length = 0;
      }
      await callback("applyResponseAction", h.context)(action, invocation);
      assert.equal(h.events.at(-1).terminalDisposition, "stale");
      assert.equal(h.calls.length, 0);
      assert.equal(h.writes.length, 0);
    });
  }
}

test("B controls: actual Back uses A, commits once through the real shared-parent writer and invalidates B's old phase", async () => {
  const h = harness();
  history(h);
  const before = h.manager.getState().taskRuntime;
  await callback("applyResponseAction", h.context)("previous-phase", { displayTarget: h.snapshot.target });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].logicalQuestionUnit.id, h.f.unit.id);
  assert.equal(h.calls[0].questionLineage.questionInstanceId, `lqu:${h.f.unit.id}`);
  assert.equal(h.calls[0].taskMutationAuthority, "preserve-parent");
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].input.transition, "set-phase");
  assert.equal(h.writes[0].result.authorized, true);
  assert.equal(h.writes[0].result.mutationApplied, true);
  const after = h.manager.getState().taskRuntime;
  assert.equal(after.parent.id, before.parent.id);
  assert.equal(after.parent.playbookPhase, "requirement_clarification");
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.parent.revisions, before.parent.revisions + 1);
  assert.equal(h.environment.latestManualCorrectionTargetRef.current, h.backgroundTarget);
  assert.equal(h.environment.stableAnswerRevisionRef.current, null);
  assert.equal(h.state.latestSuggestion, null);
  assert.equal(h.state.latestReliableSuggestion, null);
  assert.equal(h.environment.latestForceAdviseTargetRef.current.presentation.automaticExecutionState, "stale");
  assert.equal(h.state.latestInterviewerTurnCandidate.automaticExecutionState, "stale");
  assert.equal(h.recordingEvents.at(-1).stage, "background-answer-invalidated");
  assert.equal(h.recordingEvents.at(-1).logicalQuestionUnitId, "background-B");
  assert.equal(h.display.selectedStable.suggestion.id, h.selected.suggestion.id);
  assert.equal(h.display.current.sections.primaryAnswer, "Selected A owns this control.");
  assert.equal(h.background.sections.answer.phase, "design_framing");
  // An old B result cannot operate the now-changed shared phase even if selected.
  h.display.clear();
  const b = displaySnapshot(h.background);
  h.display.select(b, b); h.display.toggle();
  h.calls.length = 0; h.writes.length = 0;
  await callback("applyResponseAction", h.context)("next-phase", { displayTarget: b.target });
  assert.equal(h.events.at(-1).reason, "displayed-phase-owner-changed");
  assert.equal(h.calls.length, 0);
  assert.equal(h.writes.length, 0);
});

test("B controls: actual Next sends selected A source and answer, never latest B", async () => {
  const h = harness();
  await callback("applyResponseAction", h.context)("next-phase", { displayTarget: h.snapshot.target });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].logicalQuestionUnit.id, h.f.unit.id);
  assert.equal(h.calls[0].questionLineage.questionInstanceId, `lqu:${h.f.unit.id}`);
  assert.equal(h.calls[0].currentSuggestion, h.selected.suggestion.content);
  assert.equal(h.calls[0].taskMutationAuthority, "preserve-parent");
  assert.equal(h.writes.length, 0, "Next's generation/phase transaction belongs to runAdvisor, outside this ingress proof");
  assert.equal(h.environment.latestManualCorrectionTargetRef.current, h.backgroundTarget);
});

test("B controls: actual Next round-trip restores A's branch history target without selecting B", async () => {
  const h = harness();
  history(h, { from: "design_framing", to: "follow_up" });
  const before = h.manager.getState().taskRuntime.parent;
  const owner = { kind: "parent", id: before.id, parentId: before.id };
  const back = production.appendCommittedManualBackPhaseTransition(h.environment.playbookPhaseHistoryRef.current, {
    operationId: "prior-back", owner, fromPhase: "follow_up", toPhase: "design_framing",
    taskRevision: before.revisions, expectedPhaseRevision: 1, committedAt: 30,
  });
  assert.equal(back.status, "appended");
  h.environment.playbookPhaseHistoryRef.current = back.state;
  await callback("applyResponseAction", h.context)("next-phase", { displayTarget: h.snapshot.target });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].manualPhaseTargetOverride, "follow_up");
  assert.equal(h.calls[0].logicalQuestionUnit.id, h.f.unit.id);
  assert.equal(h.calls[0].questionLineage.questionInstanceId, `lqu:${h.f.unit.id}`);
  assert.equal(h.calls[0].currentSuggestion, h.selected.suggestion.content);
  assert.equal(h.writes.length, 0);
});

test("B controls: Coding child implementation Next cannot mutate parent phase", async () => {
  const h = harness({ selectedChild: true });
  const before = h.manager.getState().taskRuntime;
  await callback("applyResponseAction", h.context)("next-phase", { displayTarget: h.snapshot.target });
  assert.equal(h.events.at(-1).reason, "no-next-phase");
  assert.equal(h.calls.length, 0);
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.manager.getState().taskRuntime, before);
});

test("B controls: Next history mismatch stops before fallback progression and generation", async () => {
  const h = harness();
  history(h, { to: "follow_up" });
  const before = h.manager.getState().taskRuntime;
  await callback("applyResponseAction", h.context)("next-phase", { displayTarget: h.snapshot.target });
  assert.equal(h.events.at(-1).terminalDisposition, "rejected");
  assert.match(h.events.at(-1).reason, /history resolves to follow_up, runtime is design_framing/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.manager.getState().taskRuntime, before);
});

for (const change of ["type", "phase"]) {
  test(`B controls: real invalidation callback clears dependent B after shared-parent ${change}, preserving selected A`, () => {
    const h = harness();
    const selectedBefore = JSON.stringify(h.display.current);
    const before = h.manager.getState().taskRuntime.parent;
    const after = change === "type" ? { ...before, stableKind: "ai-ml-system-design" }
      : { ...before, playbookPhase: "follow_up" };
    h.environment.invalidateBackgroundAfterSelectedTaskMutation({ before, after, traceId: "selected-mutation" });
    assert.equal(h.environment.stableAnswerRevisionRef.current, null);
    assert.equal(h.state.latestSuggestion, null);
    assert.equal(h.state.latestReliableSuggestion, null);
    assert.equal(JSON.stringify(h.display.current), selectedBefore);
    assert.equal(h.display.locked, true);
    assert.equal(h.environment.latestManualCorrectionTargetRef.current, h.backgroundTarget);
    assert.equal(h.environment.latestForceAdviseTargetRef.current.presentation.automaticExecutionState, "stale");
    assert.equal(production.decideForceAdviseEligibility(h.state.latestInterviewerTurnCandidate).reason, "stale-recovery-target");
    assert.equal(h.recordingEvents.length, 1);
    assert.equal(h.recordingEvents[0].stage, "background-answer-invalidated");
    assert.equal(h.recordingEvents[0].selectedLogicalQuestionUnitId, h.f.unit.id);
    assert.equal(h.recordingEvents[0].logicalQuestionUnitId, "background-B");
    assert.equal(h.writes.length, 0, "invalidation must never create a second task writer");
    h.environment.invalidateBackgroundAfterSelectedTaskMutation({ before, after });
    assert.equal(h.recordingEvents.length, 1, "cleared background cannot be invalidated twice");
  });
}

for (const unchanged of ["no-op", "revision-only", "relation-none", "relation-unknown", "different-parent", "same-lqu", "unlocked"]) {
  test(`B controls: invalidation preserves B for ${unchanged}`, () => {
    const h = harness();
    const before = h.manager.getState().taskRuntime.parent;
    let after = { ...before, stableKind: "ai-ml-system-design" };
    if (unchanged === "no-op") after = before;
    if (unchanged === "revision-only") after = { ...before, revisions: before.revisions + 1 };
    if (unchanged === "relation-none") h.background.settlementSnapshot.relation = "none";
    if (unchanged === "relation-unknown") h.background.settlementSnapshot.relation = "unknown";
    if (unchanged === "different-parent") h.background.taskId = "unrelated-parent";
    if (unchanged === "same-lqu") h.background.logicalQuestionUnitId = h.f.unit.id;
    if (unchanged === "unlocked") h.display.toggle();
    const selectedBefore = JSON.stringify(h.display.current);
    const stateBefore = JSON.stringify(h.state);
    h.environment.invalidateBackgroundAfterSelectedTaskMutation({ before, after });
    assert.equal(h.environment.stableAnswerRevisionRef.current, h.background);
    assert.equal(JSON.stringify(h.display.current), selectedBefore);
    assert.equal(JSON.stringify(h.state), stateBefore);
    assert.equal(h.recordingEvents.length, 0);
    assert.equal(h.writes.length, 0);
  });
}

for (const childChanged of [true, false]) {
  test(`B controls: background child owner ${childChanged ? "changed" : "unchanged"} ${childChanged ? "invalidates" : "preserves"} B`, () => {
    const h = harness({ selectedChild: true });
    const before = h.manager.getState().taskRuntime.parent;
    const after = childChanged ? { ...before, child: {
      ...before.child, phaseState: { ...before.child.phaseState, phase: "optimized_pseudocode" },
    } } : { ...before, playbookPhase: "follow_up", revisions: before.revisions + 1 };
    const selectedBefore = JSON.stringify(h.display.current);
    h.environment.invalidateBackgroundAfterSelectedTaskMutation({ before, after });
    assert.equal(h.environment.stableAnswerRevisionRef.current, childChanged ? null : h.background);
    assert.equal(h.recordingEvents.length, childChanged ? 1 : 0);
    assert.equal(JSON.stringify(h.display.current), selectedBefore);
    assert.equal(h.writes.length, 0);
  });
}

test("B controls: phase history same-phase and duplicate rejection preserve background B", () => {
  const h = harness();
  const after = h.manager.getState().taskRuntime.parent;
  assert.equal(h.environment.recordCommittedPlaybookPhaseTransition({
    operationId: "no-op", source: "manual-next", before: after, after: { ...after, revisions: after.revisions + 1 },
  }), undefined);
  history(h);
  const duplicate = h.environment.recordCommittedPlaybookPhaseTransition({
    operationId: "history-transition", source: "manual-next",
    before: { ...after, playbookPhase: "requirement_clarification" }, after,
  });
  assert.equal(duplicate.status, "duplicate-operation");
  assert.equal(h.environment.stableAnswerRevisionRef.current, h.background);
  assert.equal(h.recordingEvents.length, 0);
  assert.equal(h.writes.length, 0);
});

// This is the actual Correction post-writer gate through invalidation, driven by
// the real manager's result. It does not replace the earlier Correction admission proof.
function correctionPostWriter(h, lifecycleCommit, before, after, preparedSource) {
  Object.assign(h.environment, { lifecycleCommit, parentBefore: before, parentAfter: after, parentLifecycleMutationApplied: false,
    contextState: h.manager.getState(), decision: preparedSource?.transition.decision ?? { target: after.child ? "child" : "parent" },
    sourceOwnerCorrection: preparedSource?.ownerCorrection, effectiveSourceAfterCorrection: preparedSource?.record ?? h.f.record,
    correctionLogicalQuestionUnit: h.f.unit, correctionCurrentQuestionSettlement: preparedSource?.transition.settlement ?? h.selected.settlementSnapshot,
    correctionExecutionPlan: undefined });
  const guard = find(callbackNode("correctActiveQuestionType"),
    n => ts.isIfStatement(n) && n.expression.getText(hook) === "!lifecycleCommit.authorized", "Correction post-writer guard");
  const statements = guard.parent.statements;
  const index = statements.indexOf(guard);
  const end = statements.findIndex((statement, i) => i > index && ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(item => item.name.getText(hook) === "correctedContextState"));
  assert.ok(end > index, "keep contiguous production source/admission/invalidation/settlement writes");
  return evaluate(`(() => { ${statements.slice(index, end).map(n => n.getText(hook)).join("\n")}
    return parentLifecycleMutationApplied;
  })()`, h.context);
}

function retypeSelectedOwner(h, selectedChild) {
  const before = h.manager.getTaskRuntimeState().parent;
  const correctedType = selectedChild ? "field-knowledge" : "ai-ml-system-design";
  const ctx = h.environment.readManualCorrectionContext(h.snapshot.target);
  assert.ok(ctx);
  const kind = selectedChild ? "continue-child" : "retype-parent";
  const capability = production.getManualCorrectionCapabilities(ctx, correctedType).options.find(option => option.id === kind);
  assert.ok(capability);
  const prepared = production.prepareManualCorrectionIntentTransition({
    operationId: "SB-correction", context: ctx, correctedType, intent: capability.intent,
    correctedPlaybook: production.selectInterviewPlaybook({ questionType: correctedType }), newParentId: "unused", now: 100,
  });
  assert.equal(prepared.authorized, true, prepared.reason);
  const nextSource = production.createEffectiveQuestionSourceRecord({ logicalQuestionUnit: h.f.unit,
    settlement: production.buildEffectiveAdvisorSettlementView({ settlement: prepared.settlement,
      activeMeetingTask: prepared.activeMeetingTask, taskRuntimeRevision: ctx.runtime.revision + 1,
      fallback: { questionType: correctedType, relation: prepared.capability.relation } }).effectiveSettlement,
    activeMeetingTask: prepared.activeMeetingTask });
  assert.ok(nextSource);
  const ownerCorrection = h.ledger.prepareOwnerCorrection({ operationId: "SB-writer", sessionId: ctx.currentSessionId,
    runtimeEpoch: ctx.currentRuntimeEpoch, logicalQuestionUnitId: h.f.unit.id, logicalQuestionRevision: h.f.unit.revision,
    sourceHash: ctx.source.sourceHash, expectedOwner: ctx.source.owner, nextOwner: nextSource.owner,
    relation: prepared.capability.relation, availableObservationIds: [] });
  assert.ok(ownerCorrection);
  const result = h.manager.commitTaskRuntimeTransition({ id: "SB-writer", transition: prepared.transition,
    parent: prepared.parent, sourceOwnerCorrection: ownerCorrection, expectedRevision: ctx.runtime.revision, reason: "SB-real-writer" });
  assert.equal(result.authorized, true, result.reason);
  assert.equal(correctionPostWriter(h, result, before, prepared.parent, { transition: prepared, ownerCorrection, record: nextSource }), true);
  return { correctedType, kind, before, after: h.manager.getTaskRuntimeState().parent };
}

for (const selectedChild of [false, true]) {
  test(`SB current ${selectedChild ? "child" : "parent"} A retype refreshes B effective settlement without rewriting historical output`, async () => {
    const h = harness({ selectedChild });
    const before = h.manager.getTaskRuntimeState().parent;
    const oldType = selectedChild ? before.child.questionType : before.stableKind;
    const rawB = JSON.stringify(h.background);
    const rawPlan = production.buildSettledAdvisorExecutionPlan({
      settlement: h.background.settlementSnapshot, activeMeetingTask: h.manager.getState().activeMeetingTask,
      providerSnapshot: { providers: [], selectedProvider: { provider: "fixture", variables: {} }, codingProvider: { provider: "fixture", variables: {} } },
      memoryUseCase: selectedChild ? "coding_interview" : "system_design_interview",
      askFrame: "hypothetical-design", topicDomain: "backend", sourceQuestion: h.backgroundTarget.logicalQuestionUnit.normalizedText,
    });
    h.environment.settledAdvisorExecutionPlanRef.current = rawPlan;
    const planBefore = JSON.stringify(rawPlan);
    const historical = { rawSettlement: structuredClone(h.background.settlementSnapshot), humanExpectedType: oldType };
    h.traces.push({ id: "trace-B", status: "success", metadata: historical });
    const { correctedType, kind } = retypeSelectedOwner(h, selectedChild);
    assert.equal(h.environment.stableAnswerRevisionRef.current, null);
    assert.equal(h.state.latestSuggestion, null);
    assert.equal(h.writes.filter(write => write.result.mutationApplied).length, 1);
    assert.equal(JSON.stringify(h.background), rawB, "historical attempt must keep its original Type");
    assert.equal(h.background.settlementSnapshot.questionType, oldType);
    assert.equal(historical.rawSettlement.questionType, oldType);
    assert.equal(historical.humanExpectedType, oldType);
    assert.equal(JSON.stringify(rawPlan), planBefore, "old execution plan must stay immutable");
    const effective = h.environment.currentQuestionSettlementRef.current;
    const view = production.buildEffectiveAdvisorSettlementView({ settlement: effective,
      activeMeetingTask: h.manager.getState().activeMeetingTask, taskRuntimeRevision: h.manager.getTaskRuntimeState().revision,
      fallback: { questionType: correctedType, relation: selectedChild ? "child-probe" : "followup-parent" } });
    console.log(`SB ${kind}: owner=${selectedChild ? h.manager.getState().activeMeetingTask.child.questionType : h.manager.getState().activeMeetingTask.parent.questionType}, currentB=${effective.questionType}, targetB=${h.environment.latestManualCorrectionTargetRef.current.settlement.questionType}, consumer=${view.questionType}/${view.contextReadScope}`);
    assert.equal(effective.questionType, correctedType, "current B settlement must follow its retyped active owner");
    assert.equal(effective.logicalQuestionUnitId, "background-B");
    assert.equal(h.environment.latestManualCorrectionTargetRef.current.settlement.questionType, correctedType);
    assert.equal(view.questionType, correctedType);
    assert.equal(view.contextReadScope, selectedChild ? "active-child-read" : "active-parent-read");
  });

  test(`SB ${selectedChild ? "child" : "parent"} retype rejects old B commit and unlock cannot regenerate its invalidated answer`, async () => {
    const h = harness({ selectedChild });
    const oldToken = production.createRuntimeCommitToken({ operationId: "B-in-flight", pipeline: "advisor",
      snapshot: production.buildRuntimeCommitSnapshot({ runtimeEpoch: 3, contextState: h.manager.getState() }) });
    assert.equal(production.authorizeRuntimeCommit({ token: oldToken, currentOperationId: "B-in-flight",
      current: production.buildRuntimeCommitSnapshot({ runtimeEpoch: 3, contextState: h.manager.getState() }) }).authorized, true);
    const rawB = JSON.stringify(h.background);
    const { before, after, correctedType } = retypeSelectedOwner(h, selectedChild);
    assert.equal(after.id, before.id);
    assert.equal(after.sourceQuestionUnitId, before.sourceQuestionUnitId);
    assert.equal(after.topic, before.topic);
    if (selectedChild) {
      assert.equal(after.child.id, before.child.id);
      assert.equal(after.stableKind, before.stableKind);
      assert.equal(after.child.questionType, correctedType);
    } else assert.equal(after.stableKind, correctedType);
    const authorization = production.authorizeRuntimeCommit({ token: oldToken, currentOperationId: "B-in-flight",
      current: production.buildRuntimeCommitSnapshot({ runtimeEpoch: 3, contextState: h.manager.getState() }) });
    assert.equal(authorization.authorized, false, "late B cannot authorize publication after the real writer changed its owner");
    assert.equal(h.display.current.target.logicalQuestionUnitId, h.f.unit.id);
    assert.equal(h.display.toggle(h.snapshot.target).accepted, true);
    assert.equal(h.display.locked, false);
    assert.equal(h.display.current, null, "unlock cannot restore invalidated B");
    h.environment.currentSuggestionText = "";
    await callback("forceAdviseLatestTurn", h.context)();
    assert.equal(h.events.at(-1).reason, "stale-recovery-target");
    await callback("regenerateSuggestion", h.context)();
    assert.equal(h.events.at(-1).terminalDisposition, "stale");
    assert.equal(h.events.at(-1).reason, "visible-answer-missing");
    assert.equal(h.calls.length, 0, "neither automatic nor manual invocation may reuse old B");
    assert.equal(h.writes.length, 1);
    assert.equal(JSON.stringify(h.background), rawB);
  });
}

for (const authorized of [true, false]) {
  test(`B controls: Correction ${authorized ? "committed" : "rejected"} real writer ${authorized ? "invalidates" : "preserves"} B`, () => {
    const h = harness();
    const runtime = h.manager.getState().taskRuntime;
    const before = runtime.parent;
    const after = { ...before, stableKind: "ai-ml-system-design", revisions: before.revisions + 1 };
    const result = h.manager.commitTaskRuntimeTransition({
      id: "selected-correction", transition: "replace-parent", reason: "test-post-writer-boundary",
      expectedRevision: runtime.revision + (authorized ? 0 : 1), parent: after,
    });
    assert.equal(result.authorized, authorized);
    assert.equal(result.mutationApplied, authorized);
    const selectedBefore = JSON.stringify(h.display.current);
    assert.equal(correctionPostWriter(h, result, before, after), authorized ? true : undefined);
    assert.equal(h.environment.stableAnswerRevisionRef.current, authorized ? null : h.background);
    assert.equal(h.recordingEvents.length, authorized ? 1 : 0);
    assert.equal(h.finalizations.length, authorized ? 0 : 1);
    assert.equal(JSON.stringify(h.display.current), selectedBefore);
    assert.equal(h.writes.length, 1, "post-writer control must not invoke another task mutation");
  });
}
