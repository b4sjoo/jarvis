import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as effectiveProjection from "../../src/lib/meeting/logical-question-effective-projection.js";
import * as generatedContinuity from "../../src/lib/meeting/bounded-recent-history.js";
import * as authorizedSources from "../../src/lib/meeting/authorized-effective-source-context.js";
import * as effectiveTask from "../../src/lib/meeting/effective-task-source-view.js";
import { createProvisionalCurrentQuestion } from "../../src/lib/meeting/current-question-settlement.js";
import { selectOwnerScopedRelationEvidence } from "../../src/lib/meeting/effective-question-source-ledger.js";
import { selectSourceOwnedSemanticContext } from "../../src/lib/meeting/source-owned-semantic-context.js";
import { buildTaskRelationAdjudicationRequest, type TaskRelationAdjudicationRequest } from "../../src/lib/meeting/task-relation-adjudication.js";
import type { MeetingContextManager } from "../../src/lib/meeting/context-manager.js";
import type { EffectiveQuestionSourceLedger } from "../../src/lib/meeting/effective-question-source-ledger.js";
import type { LogicalQuestionUnit } from "../../src/lib/meeting/logical-question-unit.js";
import { getLogicalQuestionSemanticEvidenceText } from "../../src/lib/meeting/logical-question-unit.js";
import type { AdvisorPromptContext } from "../../src/lib/meeting/types.js";

const hook = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);

function evaluate(source: string, globals: Record<string, unknown>) {
  const environment = vm.createContext(globals);
  new vm.Script(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText).runInContext(environment);
  return environment;
}

export function topicHookFunction<T>(name: string, globals: Record<string, unknown> = {}): T {
  let expression: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      assert.equal(expression, undefined, `ambiguous Hook function: ${name}`);
      expression = node.getText(hook);
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(hook) === name) {
      assert.equal(expression, undefined, `ambiguous Hook callback: ${name}`);
      assert.ok(node.initializer && ts.isCallExpression(node.initializer));
      expression = node.initializer.arguments[0].getText(hook);
    }
    ts.forEachChild(node, visit);
  };
  visit(hook);
  assert.ok(expression, `missing Hook function: ${name}`);
  return evaluate(`globalThis.result = (${expression});`, globals).result as T;
}

function topicGlobals(manager: MeetingContextManager, ledger: EffectiveQuestionSourceLedger) {
  const globals: Record<string, unknown> = {
    ...effectiveProjection,
    ...generatedContinuity,
    ...authorizedSources,
    ...effectiveTask,
    contextManagerRef: { current: manager },
    effectiveQuestionSourceLedgerRef: { current: ledger },
    runtimeEpochRef: { current: 1 },
    recentAdvisorContinuityRef: { current: { recentCapsules: [] } },
  };
  globals.readEffectiveSemanticTask = topicHookFunction("readEffectiveSemanticTask", globals);
  return globals;
}

export function createTopicBaseBuilder(manager: MeetingContextManager, ledger: EffectiveQuestionSourceLedger) {
  return topicHookFunction<(unit?: LogicalQuestionUnit) => AdvisorPromptContext>("buildEffectiveAdvisorBasePromptContext", topicGlobals(manager, ledger));
}

export function buildTopicSemanticContext(manager: MeetingContextManager, ledger: EffectiveQuestionSourceLedger, promptContext: AdvisorPromptContext, logicalQuestionUnit: LogicalQuestionUnit) {
  let declaration: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(hook) === "semanticPromptContext") {
      assert.equal(declaration, undefined, "ambiguous semantic Prompt context");
      declaration = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(hook);
  assert.ok(declaration);
  return evaluate(`const ${declaration.getText(hook)};\nglobalThis.result = semanticPromptContext;`, {
    ...topicGlobals(manager, ledger), promptContext,
    advisorJob: { logicalQuestionUnit, expectedSessionId: manager.getState().sessionId, runtimeCommitToken: { runtimeEpoch: 1 } },
  }).result as AdvisorPromptContext;
}

function evaluateHookDeclarations(callbackName: string, declarationNames: string[], globals: Record<string, unknown>) {
  let callback: ts.Node | undefined;
  const findCallback = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(hook) === callbackName) {
      assert.ok(node.initializer && ts.isCallExpression(node.initializer));
      callback = node.initializer.arguments[0];
    }
    ts.forEachChild(node, findCallback);
  };
  findCallback(hook);
  assert.ok(callback);
  const names = new Set(declarationNames);
  const declarations: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && names.has(node.name.getText(hook))) declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(callback);
  assert.equal(declarations.length, names.size, "Hook request construction contract changed");
  // Reuse exact production read/factory expressions without scheduling inference.
  return evaluate(`${declarations.map((node) => `const ${node.getText(hook)};`).join("\n")}\nglobalThis.result = ${declarationNames[declarationNames.length - 1]};`, globals).result;
}

export function buildTopicRelationRequest(manager: MeetingContextManager, ledger: EffectiveQuestionSourceLedger, logicalQuestionUnit: LogicalQuestionUnit) {
  return evaluateHookDeclarations("scheduleTaskRelationAdjudication", ["contextState", "activeMeetingTask", "currentQuestion", "ownerEvidenceSelection", "recentSourceContextCandidate", "recentSourceContextSelection", "request"], {
    ...topicGlobals(manager, ledger),
    contextManagerRef: { current: manager }, effectiveQuestionSourceLedgerRef: { current: ledger },
    runtimeEpochRef: { current: 1 }, latestSourceOwnedSetupRef: { current: undefined },
    logicalQuestionUnit, suppliedCurrentQuestion: undefined, sourceKind: "voice", currentQuestionEvidenceTexts: undefined,
    createProvisionalCurrentQuestion, selectOwnerScopedRelationEvidence, selectSourceOwnedSemanticContext, buildTaskRelationAdjudicationRequest,
  }) as TaskRelationAdjudicationRequest;
}

export function buildTopicIntentInput(manager: MeetingContextManager, ledger: EffectiveQuestionSourceLedger, logicalQuestionUnit: LogicalQuestionUnit) {
  return evaluateHookDeclarations("scheduleSemanticTaxonomyShadow", ["contextState", "classifierText", "activeParent", "relationText"], {
    ...topicGlobals(manager, ledger), logicalQuestionUnit, turn: { text: logicalQuestionUnit.normalizedText },
    getLogicalQuestionSemanticEvidenceText,
    buildSemanticInterviewerIntentRelationText: topicHookFunction("buildSemanticInterviewerIntentRelationText"),
  }) as string;
}
