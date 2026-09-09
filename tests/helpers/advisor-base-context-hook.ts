import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import type { MeetingContextManager } from "../../src/lib/meeting/context-manager.js";
import type { EffectiveQuestionSourceLedger } from "../../src/lib/meeting/effective-question-source-ledger.js";
import type { LogicalQuestionUnit } from "../../src/lib/meeting/logical-question-unit.js";
import { projectAdvisorTranscriptForLogicalQuestion } from "../../src/lib/meeting/logical-question-effective-projection.js";
import { projectBoundedGeneratedContinuityForTask, type BoundedGeneratedContinuityState } from "../../src/lib/meeting/bounded-recent-history.js";
import type { AdvisorPromptContext } from "../../src/lib/meeting/types.js";

const hook = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
let callback: ts.Expression | undefined;
const visit = (node: ts.Node) => {
  if (ts.isVariableDeclaration(node) && node.name.getText(hook) === "buildEffectiveAdvisorBasePromptContext") {
    assert.ok(node.initializer && ts.isCallExpression(node.initializer));
    assert.equal(callback, undefined);
    callback = node.initializer.arguments[0];
  }
  ts.forEachChild(node, visit);
};
visit(hook);
assert.ok(callback);
const script = new vm.Script(ts.transpileModule(`globalThis.build = (${callback.getText(hook)});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText);

export function createEffectiveAdvisorBaseBuilder(
  manager: MeetingContextManager,
  ledger: EffectiveQuestionSourceLedger,
  runtimeEpochRef = { current: 1 },
  projector = projectAdvisorTranscriptForLogicalQuestion,
  recentAdvisorContinuityRef: { current: BoundedGeneratedContinuityState } = { current: { recentCapsules: [] } }
): (unit?: LogicalQuestionUnit) => AdvisorPromptContext {
  const environment = vm.createContext({
    contextManagerRef: { current: manager },
    effectiveQuestionSourceLedgerRef: { current: ledger },
    runtimeEpochRef,
    projectAdvisorTranscriptForLogicalQuestion: projector,
    projectBoundedGeneratedContinuityForTask,
    recentAdvisorContinuityRef,
  });
  script.runInContext(environment);
  return environment.build;
}
