import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as correction from "../src/lib/meeting/manual-question-type-correction.js";
import * as ownership from "../src/lib/meeting/logical-question-ownership.js";
import * as settlement from "../src/lib/meeting/current-question-settlement.js";
import * as intent from "../src/lib/meeting/manual-correction-intent.js";
import { prepareManualCorrectionIntentTransition } from "../src/lib/meeting/manual-correction-transition.js";
import { composeCanonicalTurnCandidate, getLogicalQuestionSemanticEvidenceText } from "../src/lib/meeting/logical-question-unit.js";
import { createManualRuntimeActionEvent } from "../src/lib/meeting/manual-runtime-action.js";
import { ManualAdviseDisplay } from "../src/lib/meeting/manual-advise-display.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import { EffectiveQuestionSourceLedger } from "../src/lib/meeting/effective-question-source-ledger.js";
import { projectEffectiveTaskSourceView } from "../src/lib/meeting/effective-task-source-view.js";
import { resolveVisibleAnswerResponseActionTarget } from "../src/lib/meeting/response-action-target.js";
import { selectInterviewPlaybook } from "../src/lib/meeting/interview-playbook.js";
import type { CanonicalQuestionType } from "../src/lib/meeting/task-taxonomy.js";

const source = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
function productionFunction(name: string, context: vm.Context) {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      found = (node.initializer as ts.CallExpression).arguments[0];
    } else if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(found, name);
  return vm.runInContext(ts.transpileModule(`(${found.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, context);
}

function harness(withParent = false) {
  const actions: any[] = [], steps: string[] = [];
  const manager = new MeetingContextManager();
  manager.reset({ sessionId: "session" });
  const ledger = new EffectiveQuestionSourceLedger();
  manager.setEffectiveQuestionSourceLedger(ledger);
  const turn = { id: "turn", text: "Implement an LRU cache.", speaker: "them" as const,
    source: "system-audio" as const, isFinal: true, startedAt: 10, endedAt: 20 };
  manager.addTranscriptTurn(turn);
  const unit = composeCanonicalTurnCandidate({ sessionId: "session", runtimeEpoch: 1, currentTurn: turn });
  const lineage = ownership.createCanonicalLogicalQuestionLineage({ unit, traceId: "source" });
  const target = { logicalQuestionUnit: unit, logicalQuestionLease: ownership.createLogicalQuestionUnitLease(unit),
    questionLineage: lineage, updatedAt: 20, targetKind: "substantive", sourceKind: "voice",
    originTraceId: "source", sourceObservationIds: [] };
  if (withParent) {
    assert.equal(manager.commitTaskRuntimeTransition({ id: "seed-parent", transition: "create-parent", reason: "fixture",
      parent: { id: "parent", stableKind: "coding", source: "voice", topic: unit.normalizedText,
        playbookPhase: "baseline_reasoning", phaseProgress: {}, supportedFactAnchors: [],
        sourceQuestionUnitId: unit.id, sourceQuestionRevision: unit.revision, originQuestionId: lineage.questionInstanceId,
        createdAt: 10, updatedAt: 20, revisions: 1 },
    }).authorized, true);
    ledger.upsert({ recordId: "source-record", sessionId: "session", runtimeEpoch: 1,
      logicalQuestionUnitId: unit.id, logicalQuestionRevision: unit.revision,
      sourceHash: settlement.createProvisionalCurrentQuestion({ logicalQuestionUnit: unit, sourceKind: "voice" }).sourceHash,
      sourceKind: "voice", sourceTurnIds: unit.sourceTurnIds, sourceObservationIds: [], currentTurnId: turn.id,
      contextSourceTurnIds: [], recentLogicalQuestionSourceTurnIds: [], effectiveSourceTexts: [{ turnId: turn.id, text: turn.text }],
      text: turn.text, answerFocusText: turn.text, startedAt: 10, updatedAt: 20, settledAt: 20,
      speechAct: "question", disposition: "answer-primary-ask", relation: "new-parent",
      owner: { kind: "parent-mainline", parentId: "parent" } });
    manager.recordTaskQuestionAdmission({ sessionId: "session", parentId: "parent", logicalQuestionUnitId: unit.id });
  }
  const clearExpired = manager.clearExpiredActiveMeetingTask.bind(manager);
  manager.clearExpiredActiveMeetingTask = (...args) => { steps.push("target-check"); return clearExpired(...args); };
  const coordinator = new correction.ManualCorrectionOperationCoordinator();
  const revision = { current: 7 };
  let ui: any = { currentQuestionLineage: lineage };
  const env: any = {
    ...correction, ...ownership, ...settlement, ...intent, prepareManualCorrectionIntentTransition,
    getLogicalQuestionSemanticEvidenceText, projectEffectiveTaskSourceView, selectInterviewPlaybook,
    resolveVisibleAnswerResponseActionTarget, createMeetingId: () => "new-request",
    manualAdviseDisplayRef: { current: new ManualAdviseDisplay() },
    latestManualCorrectionTargetRef: { current: target }, manualCorrectionTargetHistoryRef: { current: [target] },
    logicalQuestionUnitRef: { current: unit }, runtimeEpochRef: { current: 1 }, manualCorrectionRevisionRef: revision,
    manualCorrectionOperationCoordinatorRef: { current: coordinator },
    effectiveQuestionSourceLedgerRef: { current: ledger }, contextManagerRef: { current: manager }, state: ui,
    recordManualRuntimeAction: (input: any) => {
      steps.push(input.stage);
      actions.push(createManualRuntimeActionEvent({ ...input, runtimeSessionId: "session", runtimeEpoch: 1 }));
    },
    flushPendingSentenceCompletion: () => { steps.push("flush"); },
    traceStoreRef: { current: { updateMetadata() {} } },
    setState: (update: any) => { ui = update(ui); env.state = ui; },
    runAdvisor: () => assert.fail("rejected correction must never start generation"),
  };
  const context = vm.createContext(env);
  for (const name of ["readManualCorrectionContext", "readManualCorrectionMenu", "readEffectiveSemanticTask",
    "getManualOverrideAskFrame", "getManualOverrideTopicDomain"]) env[name] = productionFunction(name, context);
  const run = productionFunction("correctActiveQuestionType", context);
  const invocation = (type: CanonicalQuestionType = "coding") => {
    const menu = env.readManualCorrectionMenu(type);
    const option = menu.options.find((candidate: intent.ManualCorrectionCapability) => candidate.id === "independent");
    assert.ok(option, "real menu must offer the explicit intent");
    return { actionId: "click-1", ingressReceivedAt: 100, correctionIntent: option.intent, correctionTarget: menu.target };
  };
  return { manager, ledger, unit, target, actions, steps, env, coordinator, revision, run, invocation, get ui() { return ui; } };
}

for (const uiSurface of ["normal-mode", "focus-mode"] as const) {
  for (const stale of [false, true]) {
    test(`actual Correction request precedes ${stale ? "stale-source" : "no-target"} rejection on ${uiSurface}`, async () => {
      const h = harness();
      const click = h.invocation();
      if (stale) {
        h.target.logicalQuestionUnit = { ...h.unit, revision: h.unit.revision + 1 };
      } else {
        h.env.latestManualCorrectionTargetRef.current = undefined;
        h.env.logicalQuestionUnitRef.current = undefined;
        h.env.manualCorrectionTargetHistoryRef.current = [];
        h.env.state = {};
      }
      const before = h.manager.getTaskRuntimeState();
      await h.run("coding", uiSurface, click);
      assert.equal(h.steps[0], "requested");
      assert.deepEqual(h.actions.map(event => event.stage), ["requested", "terminal"]);
      assert.ok(h.actions.every(event => event.actionId === "click-1" && event.correctedType === "coding" && event.uiSurface === uiSurface));
      assert.equal(h.actions[1].terminalDisposition, stale ? "stale" : "rejected");
      assert.match(h.ui.error, stale ? /newer question/ : /no active question/);
      assert.deepEqual(h.manager.getTaskRuntimeState(), before);
      assert.equal(h.revision.current, 7);
    });
  }
}

test("actual duplicate explicit Correction request gets a terminal without another revision or model", async () => {
  const h = harness(true);
  const click = h.invocation("behavioral");
  const requestKey = ["session", 1, h.unit.id, h.unit.revision, "behavioral", JSON.stringify(click.correctionIntent)].join(":");
  h.coordinator.claim("existing-correction", requestKey);
  const before = h.manager.getTaskRuntimeState();
  await h.run("behavioral", "normal-mode", click);
  assert.deepEqual(h.actions.map(event => event.stage), ["requested", "terminal"]);
  assert.equal(h.actions[1].terminalDisposition, "rejected");
  assert.equal(h.actions[1].reason, "duplicate-correction-request");
  assert.equal(h.actions[1].specializedEventId, "existing-correction");
  assert.equal(h.revision.current, 7);
  assert.deepEqual(h.manager.getTaskRuntimeState(), before);
});

test("unavailable unknown-Type intent remains a no-mutation rejection", async () => {
  const h = harness();
  const click = h.invocation();
  const before = h.manager.getTaskRuntimeState();
  await h.run("unknown", "normal-mode", click);
  assert.deepEqual(h.actions.map(event => event.stage), ["requested", "terminal"]);
  assert.equal(h.actions[1].reason, "unknown-type");
  assert.equal(h.revision.current, 7);
  assert.deepEqual(h.manager.getTaskRuntimeState(), before);
});

for (const missing of ["correctionIntent", "correctionTarget"] as const) {
  test(`actual request is recorded before rejecting missing ${missing}`, async () => {
    const h = harness();
    const click: any = h.invocation();
    delete click[missing];
    await h.run("coding", "normal-mode", click);
    assert.equal(h.steps[0], "requested");
    assert.deepEqual(h.actions.map(event => event.stage), ["requested", "terminal"]);
    assert.equal(h.actions[1].terminalDisposition, "rejected");
    assert.equal(h.actions[1].reason, "explicit-correction-intent-required");
    assert.equal(h.revision.current, 7);
  });
}
