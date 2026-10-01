import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { MeetingContextManager } from "../../src/lib/meeting/context-manager.js";
import * as tasks from "../../src/lib/meeting/active-meeting-task.js";
import * as plans from "../../src/lib/meeting/settled-advisor-execution-plan.js";
import type { LogicalQuestionUnit } from "../../src/lib/meeting/logical-question-unit.js";
import type { ActiveInterviewParent, ActiveScreenTask } from "../../src/lib/meeting/types.js";

const source = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
const fn = source.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === "commitPlannedTaskRuntimeTransition");
assert.ok(fn);
const script = new vm.Script(ts.transpileModule(`(${fn.getText(source)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText);

export function productionPlannedCommit(overrides: Record<string, unknown> = {}) {
  return script.runInNewContext({ ...tasks, ...plans, ...overrides }) as (input: any) => any;
}

// Frozen Plan fixtures exercise the actual Hook orchestration and sole manager
// writer. Only the already-tested Plan compiler is substituted in these cases.
export function createTestPlannedTransition(input: {
  plan: plans.SettledAdvisorExecutionPlan;
  manualCorrectionRevision: number;
  proposedActiveInterviewTask?: ActiveInterviewParent | null;
  proposedActiveScreenTask?: ActiveScreenTask | null;
}) { return input; }

export function commitTestPlannedTransition(input: {
  transaction: ReturnType<typeof createTestPlannedTransition>;
  currentSessionId: string;
  currentRuntimeEpoch: number;
  currentLogicalQuestionUnitId?: string;
  currentLogicalQuestionRevision?: number;
  currentManualCorrectionRevision: number;
  currentTaskRuntimeRevision: number;
  currentActiveInterviewTask?: ActiveInterviewParent;
  currentActiveScreenTask?: ActiveScreenTask;
}) {
  const manager = new MeetingContextManager();
  manager.reset({ sessionId: input.currentSessionId });
  if (input.currentActiveInterviewTask || input.currentActiveScreenTask) {
    assert.equal(manager.commitTaskRuntimeTransition({ id: "seed", reason: "fixture",
      transition: input.currentActiveInterviewTask ? "create-parent" : "update-source-attachment",
      parent: input.currentActiveInterviewTask, screenAttachment: input.currentActiveScreenTask }).authorized, true);
    while (manager.getTaskRuntimeState().revision < input.currentTaskRuntimeRevision) {
      assert.equal(manager.commitTaskRuntimeTransition({ id: "seed-revision", reason: "fixture",
        transition: "update-parent-context", parent: input.currentActiveInterviewTask,
        screenAttachment: input.currentActiveScreenTask }).authorized, true);
    }
  }
  const plan = input.transaction.plan;
  const settlement = { settlementId: plan.settlementId, sourceHash: plan.sourceHash };
  const result = productionPlannedCommit({ buildSettledAdvisorExecutionPlan: () => plan })({
    manager, currentContext: manager.getState(), currentRuntimeEpoch: input.currentRuntimeEpoch,
    currentLogicalQuestionUnit: { id: input.currentLogicalQuestionUnitId,
      revision: input.currentLogicalQuestionRevision, runtimeEpoch: input.currentRuntimeEpoch } as LogicalQuestionUnit,
    parentAfter: input.transaction.proposedActiveInterviewTask,
    screenAfter: input.transaction.proposedActiveScreenTask,
    operationId: "test-command", planInput: { settlement, explicitTaskMutationCommand: plan.taskMutationPolicy },
  });
  const final = manager.getTaskRuntimeState();
  const before = input.currentActiveInterviewTask;
  const after = final.parent;
  return {
    ...result, reason: result.authorized ? "committed" : result.reason,
    mutationApplied: result.runtimeResult?.mutationApplied ?? false,
    parent: after, screenAttachment: final.screenAttachment,
    activeMeetingTask: result.authorized ? tasks.projectActiveMeetingTask({ state: final }) : undefined,
    parentBeforeId: before?.id, parentBeforeRevision: before?.revisions, parentBeforeType: before?.stableKind,
    parentAfterId: after?.id, parentAfterRevision: after?.revisions, parentAfterType: after?.stableKind,
  };
}

export function readTestLifecycleTrace(result: ReturnType<typeof commitTestPlannedTransition>) {
  return result.lifecycleMetadata;
}
