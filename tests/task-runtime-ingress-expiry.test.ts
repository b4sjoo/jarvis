import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { MeetingContextManager, createMeetingId } from "../src/lib/meeting/context-manager.js";
import { createAdvisorTriggerJob } from "../src/lib/meeting/advisor-trigger-job.js";
import { decideRefreshAuthority } from "../src/lib/meeting/answer-generation-lease.js";
import { resolveResponseOpportunityRefreshAuthority } from "../src/lib/meeting/response-opportunity-generation-gate.js";
import { authorizeRuntimeCommit, buildRuntimeCommitSnapshot } from "../src/lib/meeting/runtime-commit-authorization.js";
import { MeetingTraceStore } from "../src/lib/meeting/trace.js";
import { EffectiveQuestionSourceLedger } from "../src/lib/meeting/effective-question-source-ledger.js";
import { projectAdvisorTranscriptForLogicalQuestion } from "../src/lib/meeting/logical-question-effective-projection.js";
import {
  clearBoundedGeneratedContinuity,
  projectBoundedGeneratedContinuityForTask,
} from "../src/lib/meeting/bounded-recent-history.js";
import { setTestActiveParent } from "./helpers/meeting-task-runtime.js";

const source = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
const file = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);
function callback(name: string) {
  let found: ts.ArrowFunction | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) {
      assert.ok(node.initializer && ts.isCallExpression(node.initializer));
      const first = node.initializer.arguments[0];
      assert.ok(first && ts.isArrowFunction(first));
      found = first;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(found, name);
  return found;
}
function compile(name: string, context: vm.Context, stopAfter?: string) {
  const node = callback(name);
  assert.ok(ts.isBlock(node.body));
  let code = node.getText(file);
  if (stopAfter) {
    const index = node.body.statements.findIndex((statement) => ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some((declaration) => declaration.name.getText(file) === stopAfter)
    );
    assert.ok(index >= 0, `${name}/${stopAfter}`);
    // Keep the production ingress and its actual snapshot/lease producer intact;
    // stop only before downstream model/UI work outside this boundary's scope.
    const prefix = node.body.statements.slice(0, index + 1).map((statement) => statement.getText(file)).join("\n");
    code = `${code.slice(0, node.body.getStart(file) - node.getStart(file))}{${prefix}\nreturn ${stopAfter};}`;
  }
  vm.runInContext(ts.transpileModule(`globalThis.${name} = ${code};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  }).outputText, context);
}

function harness() {
  const manager = new MeetingContextManager();
  setTestActiveParent(manager, {
    id: "expiring-owner", source: "voice", stableKind: "general-system-design", topic: "Design a cache",
    playbookPhase: "requirement_clarification", phaseProgress: {}, supportedFactAnchors: [],
    createdAt: 1, updatedAt: 1, revisions: 1,
  }, {
    parent: { ownerId: "expiring-owner", deadline: 100 },
  });
  const context = vm.createContext({
    Date, Promise, createMeetingId, createAdvisorTriggerJob, decideRefreshAuthority,
    resolveResponseOpportunityRefreshAuthority, buildRuntimeCommitSnapshot,
    projectAdvisorTranscriptForLogicalQuestion, projectBoundedGeneratedContinuityForTask,
    clearBoundedGeneratedContinuity,
    effectiveQuestionSourceLedgerRef: { current: new EffectiveQuestionSourceLedger() },
    contextManagerRef: { current: manager }, runtimeEpochRef: { current: 7 },
    runtimeActiveRef: { current: true }, activeRef: { current: true },
    shutdownRequestedRef: { current: false },
    whiteboardSyntaxRepairRuntimeRef: { current: { cancelAll() {} } },
    responseOpportunityGenerationGateRef: { current: { read: () => undefined, findOperationId: () => undefined } },
    recentAdvisorContinuityRef: { current: { recentCapsules: [] } }, responseActionRevisionRef: { current: 0 },
    manualCorrectionRevisionRef: { current: 0 },
    traceStoreRef: { current: new MeetingTraceStore() },
    flushPendingSentenceCompletion: () => {},
  });
  compile("buildEffectiveAdvisorBasePromptContext", context);
  compile("buildAdvisorJob", context);
  return { manager, context };
}

for (const expired of [false, true]) {
  test(`J1 ingress: actual runAdvisor -> buildAdvisorJob -> commit token, delayed timer, expired=${expired}`, async (t) => {
    let now = 50;
    t.mock.method(Date, "now", () => now);
    const h = harness();
    const original = h.manager.getTaskRuntimeState();
    assert.equal("expiresAt" in original.parent!, false);
    assert.equal(h.manager.getTaskDeadlineControl().parent?.deadline, 100);
    now = expired ? 101 : 99;
    compile("runAdvisor", h.context, "advisorJob");
    const job = await h.context.runAdvisor({});
    assert.equal(job.expectedParentId, expired ? undefined : "expiring-owner");
    assert.equal(job.promptContextSnapshot.activeMeetingTask?.id, job.expectedParentId);
    assert.equal(h.manager.getTaskRuntimeState().revision, original.revision + (expired ? 1 : 0));
    assert.equal(h.manager.getTaskDeadlineControl().parent?.deadline, expired ? undefined : 100);
    if (!expired) assert.deepEqual(h.manager.getTaskRuntimeState(), original);
    assert.equal(authorizeRuntimeCommit({
      token: job.runtimeCommitToken,
      current: buildRuntimeCommitSnapshot({ runtimeEpoch: 7, contextState: h.manager.getState() }),
      currentOperationId: job.id,
    }).authorized, true);
  });
}

test("J1 ingress: expiry before delayed Advisor execution invalidates the already captured old-owner token", async (t) => {
  let now = 50;
  t.mock.method(Date, "now", () => now);
  const h = harness();
  const job = h.context.buildAdvisorJob({});
  now = 101;
  compile("runAdvisor", h.context, "advisorJob");
  assert.equal(await h.context.runAdvisor({ advisorJob: job }), job);
  assert.equal(h.manager.getState().activeMeetingTask, undefined);
  assert.equal(authorizeRuntimeCommit({
    token: job.runtimeCommitToken,
    current: buildRuntimeCommitSnapshot({ runtimeEpoch: 7, contextState: h.manager.getState() }),
    currentOperationId: job.id,
  }).authorized, false);
});

for (const [name, snapshotName, args] of [
  ["captureScreenContext", "screenRequestContextState", []],
  ["correctActiveQuestionType", "contextState", ["coding"]],
  ["regenerateSuggestion", "currentRuntime", []],
  ["applyResponseAction", "requestedRuntime", ["next-phase"]],
  ["applyResponseAction", "requestedRuntime", ["previous-phase"]],
  ["forceAdviseLatestTurn", "requestedRuntime", []],
] as const) {
  test(`J1 ingress: ${name}/${args[0] ?? "default"} expires before its production context snapshot`, async (t) => {
    let now = 50;
    t.mock.method(Date, "now", () => now);
    const h = harness();
    const before = h.manager.getTaskRuntimeState();
    now = 101;
    compile(name, h.context, snapshotName);
    const snapshot = await h.context[name](...args);
    assert.equal(snapshot.activeMeetingTask, undefined);
    assert.equal(snapshot.taskRuntime.revision, before.revision + 1);
    assert.equal(snapshot.taskRuntime.lastMutation.kind, "expire");
    assert.equal(h.manager.getTaskDeadlineControl().parent, undefined);
  });
}

test("J1 ingress: canonical STT/manual-text admission expires before reading its session context", async (t) => {
  let now = 50;
  t.mock.method(Date, "now", () => now);
  const h = harness();
  now = 101;
  compile("processCanonicalTurnIngress", h.context, "ingressMetadata");
  for (const transport of ["accepted-stt", "manual-text"]) {
    await h.context.processCanonicalTurnIngress({
      turn: { id: "turn", speaker: "them", source: "system-audio", text: "New question" },
      segment: { traceId: "trace" }, transport,
    });
    assert.equal(h.manager.getState().activeMeetingTask, undefined);
    assert.equal(h.manager.getTaskRuntimeState().revision, 2);
  }
});
