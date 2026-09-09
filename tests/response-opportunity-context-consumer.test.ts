import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import { composeLogicalQuestionUnit, type LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import { applyActiveQuestionTermCorrection } from "../src/lib/meeting/active-question-term-correction.js";
import { createProvisionalCurrentQuestion } from "../src/lib/meeting/current-question-settlement.js";
import { EffectiveQuestionSourceLedger, type EffectiveQuestionSourceRecord } from "../src/lib/meeting/effective-question-source-ledger.js";
import { projectEffectiveLogicalQuestionSources, projectEffectiveSourceTurnGroup } from "../src/lib/meeting/logical-question-effective-projection.js";
import { buildResponseOpportunityRequest, selectResponseOpportunityContextSources } from "../src/lib/meeting/response-opportunity-contract.js";
import { authorizeResponseOpportunityLease, createResponseOpportunityLease } from "../src/lib/meeting/short-intent-gate.js";
import type { TranscriptTurn } from "../src/lib/meeting/types.js";

const hook = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
let reader: ts.Expression | undefined;
let settlement: ts.ArrowFunction | undefined;
let scheduler: ts.ArrowFunction | undefined;
const visit = (node: ts.Node) => {
  if (ts.isVariableDeclaration(node) && node.name.getText(hook) === "scheduleResponseOpportunityInference") {
    assert.ok(node.initializer && ts.isCallExpression(node.initializer));
    scheduler = node.initializer.arguments[0] as ts.ArrowFunction;
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(hook) === "readResponseOpportunitySources") reader = node.initializer;
  ts.forEachChild(node, visit);
};
visit(hook);
assert.ok(reader && scheduler);
const findSettlement = (node: ts.Node) => {
  if (ts.isPropertyAssignment(node) && node.name.getText(hook) === "onSettled" && ts.isArrowFunction(node.initializer)) settlement = node.initializer;
  ts.forEachChild(node, findSettlement);
};
findSettlement(scheduler);
assert.ok(settlement && ts.isBlock(settlement.body));
const authorizationIndex = settlement.body.statements.findIndex((statement) =>
  ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => declaration.name.getText(hook) === "authorization")
);
assert.ok(authorizationIndex >= 0);
const compile = (source: string) => new vm.Script(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText);
const readerScript = compile(`globalThis.read = (${reader.getText(hook)});`);
const settlementScript = compile(`${settlement.body.statements.slice(0, authorizationIndex + 1).map((statement) => statement.getText(hook)).join("\n")}\nglobalThis.result = { authorization, latestRequest };`);

function fixture() {
  const manager = new MeetingContextManager();
  const source = (id: string, text: string, at: number): TranscriptTurn => ({ id, text, speaker: "them", source: "system-audio", isFinal: true, startedAt: at, endedAt: at + 100 });
  const setup = source("setup", "The car-sharing corpus contains private PDFs.", 1_000);
  const other = source("other", "Each document has an access-control list.", 2_000);
  const current = source("current", "How should we index the car-sharing corpus?", 3_000);
  const excluded = source("excluded", "Unselected private context.", 4_000);
  [setup, other, current, excluded].forEach((turn) => manager.addTranscriptTurn(turn));
  const sessionId = manager.getState().sessionId;
  const compose = (turn: TranscriptTurn) => composeLogicalQuestionUnit({ currentTurn: turn, sessionId, runtimeEpoch: 1, now: turn.endedAt });
  const correction = (unit: LogicalQuestionUnit) => applyActiveQuestionTermCorrection({
    logicalQuestionUnit: unit,
    correction: { id: "correction", input: "RAG not car-sharing", term: "RAG", from: "car-sharing", to: "RAG", createdAt: 4_200, appliedCount: 0 },
    correctionTraceId: "correction-trace", manualCorrectionRevision: 1, now: 4_200,
  }).logicalQuestionUnit;
  const setupUnit = compose(setup);
  const ledger = new EffectiveQuestionSourceLedger();
  const remember = (unit: LogicalQuestionUnit) => {
    const question = createProvisionalCurrentQuestion({ logicalQuestionUnit: unit, sourceKind: "voice" });
    const projection = projectEffectiveLogicalQuestionSources(unit);
    const record: EffectiveQuestionSourceRecord = {
      recordId: `${unit.id}:${unit.revision}`, sessionId, runtimeEpoch: 1,
      logicalQuestionUnitId: unit.id, logicalQuestionRevision: unit.revision,
      sourceHash: question.sourceHash, sourceKind: "voice", currentTurnId: unit.currentTurnId,
      sourceTurnIds: unit.sourceTurnIds, contextSourceTurnIds: [], recentLogicalQuestionSourceTurnIds: [],
      text: projection.effectiveText, answerFocusText: projection.answerFocusText,
      correctionIds: projection.correctionIds, effectiveSourceTexts: projection.effectiveSourceTexts,
      startedAt: unit.startedAt, updatedAt: unit.updatedAt, settledAt: unit.updatedAt,
      speechAct: "question", disposition: "answer-primary-ask", relation: "followup-parent",
      owner: { kind: "parent-mainline", parentId: "parent" },
    };
    ledger.upsert(record);
  };
  remember(correction(setupUnit));
  const unit = { ...correction(compose(current)), contextSourceTurnIds: [other.id, setup.id], recentLogicalQuestionSourceTurnIds: [setup.id] };
  const epoch = { current: 1 };
  let currentProjections = 0;
  let groups = 0;
  let ledgerSelections = 0;
  const environment = vm.createContext({
    contextManagerRef: { current: manager }, effectiveQuestionSourceLedgerRef: { current: ledger }, runtimeEpochRef: epoch,
    selectResponseOpportunityContextSources,
    projectEffectiveLogicalQuestionSources: (value: LogicalQuestionUnit) => { currentProjections += 1; return projectEffectiveLogicalQuestionSources(value); },
    projectEffectiveSourceTurnGroup: (input: Parameters<typeof projectEffectiveSourceTurnGroup>[0]) => {
      groups += 1;
      return projectEffectiveSourceTurnGroup({ ...input, effectiveRecords: new Proxy(input.effectiveRecords!, {
        get(target, key, receiver) { if (key === "filter") ledgerSelections += 1; return Reflect.get(target, key, receiver); },
      }) });
    },
  });
  readerScript.runInContext(environment);
  const read = environment.read as (unit: LogicalQuestionUnit) => {
    effectiveSources: ReturnType<typeof projectEffectiveLogicalQuestionSources>["sources"];
    contextSources: Array<{ turnId: string; text: string }>;
    contextProjection: ReturnType<typeof projectEffectiveSourceTurnGroup>;
  };
  return { manager, ledger, epoch, unit, setupUnit, remember, read, counts: () => ({ currentProjections, groups, ledgerSelections }) };
}

test("C1/C3/C5 actual RO source reader projects current LQU once and keeps decision/context scopes separate", () => {
  const f = fixture();
  const original = f.manager.getState();
  const sources = f.read(f.unit);
  assert.deepEqual(f.counts(), { currentProjections: 1, groups: 1, ledgerSelections: 1 });
  assert.deepEqual(Array.from(sources.contextSources, (source) => source.turnId), ["setup", "other"]);
  assert.deepEqual(sources.contextProjection.replacedTurnIds, ["setup"]);
  const request = buildResponseOpportunityRequest({ logicalQuestionUnit: f.unit, ...sources });
  assert.match(request.boundedContext, /RAG corpus contains private PDFs/);
  assert.doesNotMatch(request.boundedContext, /car-sharing|Unselected private/);
  assert.match(request.decisionSpans.map((span) => span.text).join(" "), /index the RAG corpus/);
  assert.doesNotMatch(request.decisionSpans.map((span) => span.text).join(" "), /private PDFs|access-control/);
  assert.deepEqual(f.manager.getState(), original);
});

for (const change of ["context-revision", "context-scope", "lqu-revision", "epoch", "unchanged"] as const) {
  test(`C4/C6 actual RO settlement re-reads ${change} and preserves lease authorization`, () => {
    const f = fixture();
    const sources = f.read(f.unit);
    const request = buildResponseOpportunityRequest({ logicalQuestionUnit: f.unit, ...sources });
    const lease = createResponseOpportunityLease({ sessionId: f.unit.sessionId, runtimeEpoch: 1, logicalQuestionUnit: f.unit, request, manualCorrectionRevision: 0 });
    let latest = f.unit;
    if (change === "context-revision") f.remember({ ...f.setupUnit, revision: 3, updatedAt: 5_000 });
    if (change === "context-scope") latest = { ...latest, contextSourceTurnIds: ["other"], recentLogicalQuestionSourceTurnIds: [] };
    if (change === "lqu-revision") latest = { ...latest, revision: latest.revision + 1 };
    if (change === "epoch") f.epoch.current += 1;
    const environment = vm.createContext({
      settlement: { job: { lease } }, contextManagerRef: { current: f.manager },
      logicalQuestionUnitRef: { current: latest }, logicalQuestionUnit: f.unit,
      readResponseOpportunitySources: f.read, buildResponseOpportunityRequest,
      readResponseOpportunityContextCapsule: () => undefined,
      authorizeResponseOpportunityLease, runtimeEpochRef: f.epoch,
      responseOpportunityRuntimeRef: { current: { getCurrentOperationId: () => lease.operationId } },
      manualCorrectionRevisionRef: { current: 0 },
    });
    settlementScript.runInContext(environment);
    const result = environment.result as { authorization: ReturnType<typeof authorizeResponseOpportunityLease> };
    assert.equal(result.authorization.authorized, change === "unchanged");
    if (change !== "unchanged") {
      assert.equal(!result.authorization.authorized && result.authorization.reason, change === "epoch" ? "runtime-epoch-mismatch" : change === "lqu-revision" ? "logical-question-revision-mismatch" : "source-hash-mismatch");
    }
    assert.deepEqual(f.counts(), { currentProjections: 2, groups: 2, ledgerSelections: 2 });
  });
}
