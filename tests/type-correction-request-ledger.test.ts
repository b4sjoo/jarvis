import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as correction from "../src/lib/meeting/manual-question-type-correction.js";
import * as ownership from "../src/lib/meeting/logical-question-ownership.js";
import { composeCanonicalTurnCandidate, getLogicalQuestionSemanticEvidenceText } from "../src/lib/meeting/logical-question-unit.js";
import { resolveCurrentQuestionSourceKind } from "../src/lib/meeting/current-question-settlement.js";
import { createManualRuntimeActionEvent } from "../src/lib/meeting/manual-runtime-action.js";

const source = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
let callback: ts.Node | undefined;
const visit = (node: ts.Node) => {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "correctActiveQuestionType") {
    callback = (node.initializer as ts.CallExpression).arguments[0];
  }
  ts.forEachChild(node, visit);
};
visit(source);
assert.ok(callback);
const code = ts.transpileModule(`(${callback.getText(source)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

for (const uiSurface of ["normal-mode", "focus-mode"] as const) {
  for (const stale of [false, true]) {
    test(`actual Correction request precedes ${stale ? "stale-source" : "no-target"} rejection on ${uiSurface}`, async () => {
      const actions: any[] = [], steps: string[] = [];
      const unit = composeCanonicalTurnCandidate({ sessionId: "session", runtimeEpoch: 1,
        currentTurn: { id: "turn", text: "Implement LRU cache.", speaker: "them", source: "system-audio",
          isFinal: true, startedAt: 10, endedAt: 20 } });
      const target = stale ? { logicalQuestionUnit: { ...unit, revision: unit.revision + 1 },
        logicalQuestionLease: ownership.createLogicalQuestionUnitLease(unit), updatedAt: 20,
        targetKind: "substantive", sourceKind: "voice", originTraceId: "original" } : undefined;
      let ui: any = {};
      const env = {
        ...correction, ...ownership,
        createMeetingId: () => "new-request",
        latestManualCorrectionTargetRef: { current: target },
        manualCorrectionTargetHistoryRef: { current: target ? [target] : [] },
        runtimeEpochRef: { current: 1 }, state: ui,
        contextManagerRef: { current: {
          getState: () => ({ sessionId: "session", taskRuntime: {}, transcriptTurns: [] }),
          clearExpiredActiveMeetingTask: () => { steps.push("target-check"); },
        } },
        recordManualRuntimeAction: (input: any) => {
          steps.push(input.stage);
          actions.push(createManualRuntimeActionEvent({ ...input, runtimeSessionId: "session", runtimeEpoch: 1 }));
        },
        flushPendingSentenceCompletion: () => { steps.push("flush"); },
        traceStoreRef: { current: { updateMetadata() {} } },
        setState: (update: any) => { ui = update(ui); },
      };
      await vm.runInNewContext(code, env)("coding", uiSurface, { actionId: "click-1", ingressReceivedAt: 100 });
      assert.equal(steps[0], "requested");
      assert.deepEqual(actions.map((event) => event.stage), ["requested", "terminal"]);
      assert.ok(actions.every((event) => event.actionId === "click-1" && event.correctedType === "coding" && event.uiSurface === uiSurface));
      assert.equal(actions[1].terminalDisposition, stale ? "stale" : "rejected");
      assert.match(ui.error, stale ? /newer question/ : /no active question/);
    });
  }
}

test("actual no-op and duplicate Correction requests receive terminals without another revision or model", async () => {
  for (const duplicate of [false, true]) {
    const actions: any[] = [];
    const unit = composeCanonicalTurnCandidate({ sessionId: "session", runtimeEpoch: 1,
      currentTurn: { id: "turn", text: "Implement an LRU cache.", speaker: "them", source: "system-audio",
        isFinal: true, startedAt: 10, endedAt: 20 } });
    const lineage = ownership.createCanonicalLogicalQuestionLineage({ unit, traceId: "source" });
    const target = { logicalQuestionUnit: unit, logicalQuestionLease: ownership.createLogicalQuestionUnitLease(unit),
      questionLineage: lineage, updatedAt: 20, targetKind: "substantive", sourceKind: "voice",
      originTraceId: "source", sourceObservationIds: [] };
    const parent = { id: "parent", stableKind: "coding", questionType: "coding", topic: unit.normalizedText,
      playbookPhase: "baseline_reasoning", phaseProgress: {}, supportedFactAnchors: [],
      sourceQuestionUnitId: unit.id, sourceQuestionRevision: unit.revision, originQuestionId: lineage.questionInstanceId,
      createdAt: 10, updatedAt: 20, revisions: 1 };
    const activeTask = duplicate ? { id: parent.id, parent, source: "voice", runtimeRevision: 1 } : undefined;
    const coordinator = new correction.ManualCorrectionOperationCoordinator();
    if (duplicate) coordinator.claim("existing-correction", `session:1:${unit.id}:${unit.revision}:behavioral`);
    const revision = { current: 7 };
    const env = { ...correction, ...ownership, getLogicalQuestionSemanticEvidenceText, resolveCurrentQuestionSourceKind,
      createMeetingId: () => "new-id", runtimeEpochRef: { current: 1 }, manualCorrectionRevisionRef: revision,
      latestManualCorrectionTargetRef: { current: target }, manualCorrectionTargetHistoryRef: { current: [target] },
      manualCorrectionOperationCoordinatorRef: { current: coordinator },
      state: { currentQuestionLineage: lineage },
      contextManagerRef: { current: { clearExpiredActiveMeetingTask() {}, getState: () => ({ sessionId: "session", activeMeetingTask: activeTask,
        taskRuntime: { parent: duplicate ? parent : undefined }, transcriptTurns: [] }) } },
      readEffectiveSemanticTask: () => activeTask,
      recordManualRuntimeAction: (input: any) => actions.push(input),
      traceStoreRef: { current: { updateMetadata() {} } }, setState() {}, flushPendingSentenceCompletion() {},
    };
    await vm.runInNewContext(code, env)(duplicate ? "behavioral" : "unknown", "normal-mode", { actionId: "click" });
    assert.deepEqual(actions.map((event) => event.stage), ["requested", "terminal"]);
    assert.equal(actions[1].terminalDisposition, "rejected");
    if (duplicate) {
      assert.equal(actions[1].reason, "duplicate-correction-request");
      assert.equal(actions[1].specializedEventId, "existing-correction");
    }
    assert.equal(revision.current, 7);
  }
});
