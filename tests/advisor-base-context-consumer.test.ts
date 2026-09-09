import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import { createAdvisorTriggerJob, type AdvisorTriggerJob } from "../src/lib/meeting/advisor-trigger-job.js";
import { decideRefreshAuthority } from "../src/lib/meeting/answer-generation-lease.js";
import { buildRuntimeCommitSnapshot } from "../src/lib/meeting/runtime-commit-authorization.js";
import { ResponseOpportunityGenerationGateCoordinator, resolveResponseOpportunityRefreshAuthority } from "../src/lib/meeting/response-opportunity-generation-gate.js";
import { MeetingTraceStore } from "../src/lib/meeting/trace.js";
import { composePhaseNavigationPromptContext } from "../src/lib/meeting/phase-navigation-prompt-context.js";
import { selectInterviewPlaybookForCommittedType } from "../src/lib/meeting/interview-playbook.js";
import { setTestTaskRuntime } from "./helpers/meeting-task-runtime.js";
import type { ActiveInterviewParent, AdvisorPromptContext, TranscriptTurn } from "../src/lib/meeting/types.js";

const hook = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
function declaration(name: string) {
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(hook) === name) {
      assert.equal(found, undefined, `ambiguous Hook declaration: ${name}`);
      found = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(hook);
  assert.ok(found, `missing Hook declaration: ${name}`);
  return found;
}
function evaluate(source: string, globals: Record<string, unknown>) {
  const environment = vm.createContext(globals);
  new vm.Script(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText).runInContext(environment);
  return environment;
}
function sourceTurn(): TranscriptTurn {
  return { id: "source", text: "Design a retrieval service.", speaker: "them", source: "system-audio", isFinal: true, startedAt: 1_000, endedAt: 1_100 };
}
function managerWithParent() {
  const manager = new MeetingContextManager();
  manager.addTranscriptTurn(sourceTurn());
  const now = Date.now();
  const playbook = selectInterviewPlaybookForCommittedType({
    questionType: "general-system-design", query: sourceTurn().text,
  }).playbook;
  assert.ok(playbook);
  const parent: ActiveInterviewParent = {
    id: "parent", source: "voice", stableKind: "general-system-design",
    topic: sourceTurn().text, playbook, playbookPhase: playbook.phase,
    phaseProgress: {}, supportedFactAnchors: [], createdAt: now, updatedAt: now, revisions: 1,
  };
  setTestTaskRuntime(manager, { parent });
  return manager;
}
function countBuilds(manager: MeetingContextManager) {
  const build = manager.buildAdvisorPromptContext.bind(manager);
  let calls = 0;
  manager.buildAdvisorPromptContext = () => { calls += 1; return build(); };
  return () => calls;
}

for (const name of ["currentPromptContext", "phaseUpdatedContext", "transitionContextAfter", "projectBindingContextAfter"]) {
  test(`C5 actual Hook ${name} refresh reads task metadata without formatting evidence`, () => {
    const manager = managerWithParent();
    const previous = manager.buildAdvisorPromptContext();
    const task = manager.getTaskRuntimeState().parent!;
    setTestTaskRuntime(manager, {
      parent: { ...task, revisions: task.revisions + 1, updatedAt: Date.now(), supportedFactAnchors: ["Tenant isolation requirement"] },
    });
    const expected = manager.buildAdvisorPromptContext();
    const originalTranscript = previous.transcript;
    const originalSourceIds = [...previous.advisorPromptSourceTurnIds!];
    const count = countBuilds(manager);
    const statement = declaration(name).parent.parent as ts.VariableStatement;
    const block = statement.parent;
    assert.ok(ts.isBlock(block));
    const index = block.statements.indexOf(statement);
    const next = block.statements[index + 1];
    assert.ok(next);
    const result = evaluate([
      statement.getText(hook), next.getText(hook),
      name === "currentPromptContext" ? "promptContext = rebasePromptContext(promptContext);" : "",
      "globalThis.result = promptContext;",
    ].join("\n"), { contextManagerRef: { current: manager }, promptContext: previous }).result as AdvisorPromptContext;
    assert.equal(count(), 0);
    assert.deepEqual(result.taskRuntime, expected.taskRuntime);
    assert.deepEqual(result.activeMeetingTask, expected.activeMeetingTask);
    assert.deepEqual(result.interviewPlaybook, expected.interviewPlaybook);
    assert.equal(result.transcript, originalTranscript);
    assert.deepEqual(result.advisorPromptSourceTurnIds, originalSourceIds);
    assert.equal(result.screenContext, previous.screenContext);
  });
}

function buildJob(manager: MeetingContextManager, options: Record<string, unknown> = {}) {
  const node = declaration("buildAdvisorJob").initializer;
  assert.ok(node && ts.isCallExpression(node));
  const callback = node.arguments[0];
  const result = evaluate(`globalThis.build = (${callback.getText(hook)});`, {
    contextManagerRef: { current: manager },
    recentAdvisorContinuityRef: { current: [] },
    responseOpportunityGenerationGateRef: { current: new ResponseOpportunityGenerationGateCoordinator() },
    responseActionRevisionRef: { current: 0 }, manualCorrectionRevisionRef: { current: 0 },
    runtimeEpochRef: { current: 1 }, traceStoreRef: { current: new MeetingTraceStore() },
    decideRefreshAuthority, resolveResponseOpportunityRefreshAuthority,
    createAdvisorTriggerJob, buildRuntimeCommitSnapshot,
  });
  return result.build(options) as AdvisorTriggerJob;
}
function hasContext(job: AdvisorTriggerJob) {
  const statement = declaration("hasContext").parent.parent;
  return evaluate(`${statement.getText(hook)}\nglobalThis.result = hasContext;`, {
    promptContext: job.promptContextSnapshot, advisorJob: job,
  }).result as boolean;
}

test("C5 initial Hook job retains real raw transcript and no-LQU hasContext behavior", () => {
  const manager = new MeetingContextManager();
  manager.addTranscriptTurn(sourceTurn());
  const count = countBuilds(manager);
  const job = buildJob(manager);
  assert.equal(count(), 1);
  assert.equal(job.logicalQuestionUnit, undefined);
  assert.equal(job.promptContextSnapshot.transcript, `Them: ${sourceTurn().text}`);
  assert.equal(hasContext(job), true);
  assert.equal(hasContext(buildJob(new MeetingContextManager())), false);
});

test("C5 actual Hook promptTurnOverride appends without dropping initial evidence", () => {
  const manager = new MeetingContextManager();
  manager.addTranscriptTurn(sourceTurn());
  const override = { ...sourceTurn(), id: "manual", text: "Keep retrieval tenant-scoped." };
  const count = countBuilds(manager);
  const job = buildJob(manager, { promptTurnOverride: override });
  assert.equal(count(), 1);
  assert.equal(job.promptContextSnapshot.transcript, `Them: ${sourceTurn().text}\nThem: ${override.text}`);
  assert.deepEqual(job.promptContextSnapshot.advisorPromptSourceTurnIds, ["source", "manual"]);
  assert.equal(job.promptContextSnapshot.latestTurn?.id, "manual");
  assert.equal(manager.getState().transcriptTurns.length, 1);
});

test("C5 actual Hook reuses a supplied phase context without another base build", () => {
  const manager = managerWithParent();
  const phaseContext = composePhaseNavigationPromptContext({
    action: "next-phase", promptContext: manager.buildAdvisorPromptContext(),
  }).promptContext;
  const count = countBuilds(manager);
  const job = buildJob(manager, { promptContextOverride: phaseContext, responseAction: "next-phase" });
  assert.equal(count(), 0);
  assert.equal(job.promptContextSnapshot.transcript, phaseContext.transcript);
  assert.deepEqual(job.promptContextSnapshot.interviewPlaybook, phaseContext.interviewPlaybook);
  assert.equal(hasContext(job), true);
});
