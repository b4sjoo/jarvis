import type { AdvisorPromptContext, MeetingAssistantState } from "../src/lib/meeting/meeting-context-contracts.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import { createAdvisorTriggerJob, type AdvisorTriggerJob } from "../src/lib/meeting/advisor-trigger-job.js";
import { decideRefreshAuthority } from "../src/lib/meeting/answer-generation-lease.js";
import { buildRuntimeCommitSnapshot } from "../src/lib/meeting/runtime-commit-authorization.js";
import {
  ResponseOpportunityGenerationGateCoordinator,
  resolveResponseOpportunityRefreshAuthority,
} from "../src/lib/meeting/response-opportunity-generation-gate.js";
import { MeetingTraceStore } from "../src/lib/meeting/trace.js";
import { composePhaseNavigationPromptContext } from "../src/lib/meeting/phase-navigation-prompt-context.js";
import { selectInterviewPlaybookForCommittedType, withInterviewPlaybookPhase } from "../src/lib/meeting/interview-playbook.js";
import { setTestTaskRuntime } from "./helpers/meeting-task-runtime.js";
import { createEffectiveAdvisorBaseBuilder } from "./helpers/advisor-base-context-hook.js";
import { EffectiveQuestionSourceLedger } from "../src/lib/meeting/effective-question-source-ledger.js";
import { composeLogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import { applyActiveQuestionTermCorrection } from "../src/lib/meeting/active-question-term-correction.js";
import {
  resolveAuthorizedEffectiveSourceContext,
} from "../src/lib/meeting/authorized-effective-source-context.js";
import {
  clearBoundedGeneratedContinuity,
  projectBoundedGeneratedContinuityForTask,
  type BoundedGeneratedContinuityState,
} from "../src/lib/meeting/bounded-recent-history.js";
import type { ActiveInterviewParent, TranscriptTurn } from "../src/lib/meeting/types.js";

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
  manager.buildAdvisorPromptContext = (...args) => { calls += 1; return build(...args); };
  return () => calls;
}

function continuityFor(manager: MeetingContextManager): BoundedGeneratedContinuityState {
  return {
    owner: { sessionId: manager.getState().sessionId, runtimeEpoch: 1, parentTaskId: "parent" },
    latestUsefulAnswer: "Generated latest output: prefer replicated indexes.",
    previousUsefulAnswer: "Generated previous output: compare consistency options.",
    recentCapsules: [],
  };
}

for (const name of ["phaseUpdatedContext", "transitionContextAfter", "projectBindingContextAfter"]) {
  test(`C3/C5 actual Hook ${name} retains generated read projection without formatting evidence`, () => {
    const manager = managerWithParent();
    const continuity = { current: continuityFor(manager) };
    const buildBase = createEffectiveAdvisorBaseBuilder(manager, new EffectiveQuestionSourceLedger(), { current: 1 }, undefined, continuity);
    const previous = buildBase();
    previous.screenContext = "Existing screen evidence: tenant_id index.";
    previous.advisorEvidencePacket = {
      version: "advisor-evidence-v2",
      currentQuestion: { text: sourceTurn().text, source: "voice-lqu", sourceTurnIds: ["source"] },
      preparation: { interviewTypes: [], guidanceHints: [], activatedFactIds: [], rawGuidanceRejectedAsFactCount: 0 },
      retrievalHints: [],
    };
    const previousPromptSnapshot = structuredClone(previous);
    type UiState = Pick<MeetingAssistantState,
      "taskRuntime" | "activeMeetingTask" | "latestSuggestion" | "latestReliableSuggestion" |
      "partialSuggestion" | "transcriptTurns" | "screenObservations">;
    const before = manager.getState();
    const oldSuggestion: NonNullable<UiState["latestSuggestion"]> = {
      id: "old-answer", kind: "answer", content: "Keep the existing tenant index answer.",
      generationPhase: before.activeMeetingTask?.parent.playbookPhase,
      createdAt: 1_200, basedOnTurnIds: ["source"], basedOnObservationIds: ["old-screen"], confidence: "high",
    };
    let uiState: UiState = {
      taskRuntime: before.taskRuntime, activeMeetingTask: before.activeMeetingTask,
      latestSuggestion: oldSuggestion, latestReliableSuggestion: oldSuggestion,
      partialSuggestion: "Existing partial output",
      transcriptTurns: before.transcriptTurns,
      screenObservations: [{ id: "old-screen", capturedAt: 1_000, source: "hotkey", changed: true, ocrText: previous.screenContext }],
    };
    const previousUiState = uiState;
    const previousUiSnapshot = structuredClone(uiState);
    let stateUpdates = 0;
    const task = manager.getTaskRuntimeState().parent!;
    setTestTaskRuntime(manager, {
      parent: {
        ...task, revisions: task.revisions + 1, updatedAt: Date.now(),
        supportedFactAnchors: name === "projectBindingContextAfter" ? ["Tenant isolation requirement"] : task.supportedFactAnchors,
        ...(name === "phaseUpdatedContext" ? {
          playbookPhase: "design_framing" as const,
          playbook: withInterviewPlaybookPhase(task.playbook, "design_framing"),
        } : {}),
        ...(name === "transitionContextAfter" ? { child: {
          id: "attached-child", createdAt: Date.now(), updatedAt: Date.now(), questionType: "coding" as const,
          relation: "child-probe" as const, intent: "implementation-probe" as const, question: "Implement the tenant filter.",
          basedOnTurnIds: ["source"], basedOnObservationIds: [],
        } } : {}),
      },
    });
    const canonical = manager.getState();
    const expected = buildBase();
    const originalTranscript = previous.transcript;
    const originalSourceIds = [...previous.advisorPromptSourceTurnIds!];
    const count = countBuilds(manager);
    const statement = declaration(name).parent.parent as ts.VariableStatement;
    const block = statement.parent;
    assert.ok(ts.isBlock(block));
    const index = block.statements.indexOf(statement);
    const following = block.statements.slice(index + 1);
    const promptAssignmentIndex = following.findIndex((node) =>
      ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) &&
      node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.expression.left) && node.expression.left.text === "promptContext"
    );
    assert.ok(promptAssignmentIndex >= 0, `missing promptContext assignment after ${name}`);
    const result = evaluate([
      // Include intervening UI synchronization as well as the real prompt refresh.
      statement.getText(hook), ...following.slice(0, promptAssignmentIndex + 1).map((node) => node.getText(hook)),
      "globalThis.result = promptContext;",
    ].join("\n"), {
      contextManagerRef: { current: manager }, promptContext: previous,
      setState: (update: (state: UiState) => UiState) => {
        stateUpdates += 1;
        uiState = update(uiState);
      },
      projectBoundedGeneratedContinuityForTask, recentAdvisorContinuityRef: continuity, runtimeEpochRef: { current: 1 },
    }).result as AdvisorPromptContext;
    assert.equal(count(), 0);
    assert.deepEqual(result.taskRuntime, expected.taskRuntime);
    assert.deepEqual(result.activeMeetingTask, expected.activeMeetingTask);
    assert.deepEqual(result.interviewPlaybook, expected.interviewPlaybook);
    assert.equal(result.transcript, originalTranscript);
    assert.deepEqual(result.advisorPromptSourceTurnIds, originalSourceIds);
    assert.equal(result.screenContext, previous.screenContext);
    assert.equal(result.latestTurn, previous.latestTurn);
    assert.equal(result.advisorEvidencePacket, previous.advisorEvidencePacket);
    assert.deepEqual(result.advisorEvidencePacket, previousPromptSnapshot.advisorEvidencePacket);
    assert.deepEqual(structuredClone(previous), previousPromptSnapshot);
    assert.equal(result.activeMeetingTask?.parent.latestUsefulAnswer, continuity.current.latestUsefulAnswer);
    assert.equal(result.activeMeetingTask?.parent.previousUsefulAnswer, continuity.current.previousUsefulAnswer);
    if (name === "transitionContextAfter") assert.equal(result.activeMeetingTask?.child?.id, "attached-child");
    if (name === "phaseUpdatedContext") {
      assert.equal(stateUpdates, 1);
      assert.notEqual(previousUiState.activeMeetingTask?.parent.playbookPhase, "design_framing");
      assert.deepEqual(uiState.taskRuntime, canonical.taskRuntime);
      assert.deepEqual(uiState.activeMeetingTask, canonical.activeMeetingTask);
      assert.equal(uiState.taskRuntime.parent?.playbookPhase, "design_framing");
      assert.equal(uiState.activeMeetingTask?.parent.playbook?.phase, "design_framing");
      assert.equal(result.interviewPlaybook?.phase, "design_framing");
      assert.equal(uiState.latestSuggestion?.generationPhase, before.activeMeetingTask?.parent.playbookPhase);
      assert.deepEqual({ ...uiState }, { ...previousUiState, taskRuntime: canonical.taskRuntime, activeMeetingTask: canonical.activeMeetingTask });
    } else {
      assert.equal(stateUpdates, 0);
      assert.equal(uiState, previousUiState);
    }
    assert.equal(uiState.latestSuggestion, previousUiState.latestSuggestion);
    assert.equal(uiState.latestReliableSuggestion, previousUiState.latestReliableSuggestion);
    assert.equal(uiState.partialSuggestion, previousUiState.partialSuggestion);
    assert.equal(uiState.transcriptTurns, previousUiState.transcriptTurns);
    assert.equal(uiState.screenObservations, previousUiState.screenObservations);
    assert.deepEqual(previousUiState, previousUiSnapshot);
    assert.equal(canonical.activeMeetingTask?.parent.latestUsefulAnswer, undefined);
    assert.equal(canonical.activeMeetingTask?.parent.previousUsefulAnswer, undefined);
    assert.deepEqual(manager.getState(), canonical);
  });
}

function buildJob(manager: MeetingContextManager, options: Record<string, unknown> = {}) {
  const node = declaration("buildAdvisorJob").initializer;
  assert.ok(node && ts.isCallExpression(node));
  const callback = node.arguments[0];
  const recentAdvisorContinuityRef = { current: { recentCapsules: [] } as BoundedGeneratedContinuityState };
  const result = evaluate(`globalThis.build = (${callback.getText(hook)});`, {
    contextManagerRef: { current: manager },
    buildEffectiveAdvisorBasePromptContext: createEffectiveAdvisorBaseBuilder(manager, new EffectiveQuestionSourceLedger(), undefined, undefined, recentAdvisorContinuityRef),
    recentAdvisorContinuityRef, clearBoundedGeneratedContinuity,
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

test("C1/C5 initial Hook job resolves correction before formatting and preserves raw latestTurn", () => {
  const manager = new MeetingContextManager();
  const raw = { ...sourceTurn(), text: "Design a car-sharing system." };
  manager.addTranscriptTurn(raw);
  const original = composeLogicalQuestionUnit({ currentTurn: raw, sessionId: manager.getState().sessionId, runtimeEpoch: 1, now: raw.endedAt });
  const corrected = applyActiveQuestionTermCorrection({
    logicalQuestionUnit: original,
    correction: { id: "correction", input: "RAG not car-sharing", term: "RAG", from: "car-sharing", to: "RAG", createdAt: 1_200, appliedCount: 0 },
    correctionTraceId: "correction-trace", manualCorrectionRevision: 1, now: 1_200,
  }).logicalQuestionUnit;
  const stateBefore = manager.getState();
  const job = buildJob(manager, { logicalQuestionUnit: corrected });
  assert.match(job.promptContextSnapshot.transcript, /Design a RAG system/);
  assert.doesNotMatch(job.promptContextSnapshot.transcript, /car-sharing/);
  assert.deepEqual(job.promptContextSnapshot.advisorPromptSourceTurnIds, [raw.id]);
  assert.deepEqual(job.promptContextSnapshot.latestTurn, raw);
  assert.deepEqual(manager.getState(), stateBefore);
  assert.equal(original.sources[0].text, raw.text);
});

test("C2/C5 LQU base formatter receives eligible parent turns without raw formatting or another state read", () => {
  const manager = new MeetingContextManager();
  manager.addTranscriptTurn(sourceTurn());
  const boundary = { ...sourceTurn(), id: "boundary", text: "Use per-tenant indexes.", startedAt: 2_000, endedAt: 2_100 };
  const clarification: TranscriptTurn = { ...boundary, id: "clarification", text: "One index per tenant?", speaker: "me", source: "microphone", contextPromptEligible: true, contextTier: "me_clarification_short", startedAt: 3_000, endedAt: 3_100 };
  manager.addTranscriptTurn(boundary);
  manager.addTranscriptTurn(clarification);
  const parent = managerWithParent().getTaskRuntimeState().parent!;
  setTestTaskRuntime(manager, { parent: { ...parent, promptTranscriptStartTurnId: boundary.id } });
  const before = manager.buildAdvisorPromptContext();
  const sessionId = manager.getState().sessionId;
  const unit = composeLogicalQuestionUnit({ currentTurn: boundary, sessionId, runtimeEpoch: 1, now: boundary.endedAt });
  const rawFormatter = manager as unknown as { formatTranscriptTurns: () => string };
  rawFormatter.formatTranscriptTurns = () => { throw new Error("raw formatter must not run"); };
  manager.getState = () => { throw new Error("base projection must not clone a second state snapshot"); };
  let calls = 0;
  const build = createEffectiveAdvisorBaseBuilder(manager, new EffectiveQuestionSourceLedger(), { current: 1 }, (input) => {
    calls += 1;
    assert.equal(input.sessionId, sessionId);
    assert.deepEqual(input.transcriptTurns.map((turn) => turn.id), before.advisorPromptSourceTurnIds);
    return resolveAuthorizedEffectiveSourceContext(input);
  });
  const after = build(unit);
  assert.equal(calls, 1);
  assert.deepEqual({ ...after }, {
    ...before,
    activeMeetingTask: projectBoundedGeneratedContinuityForTask({ state: { recentCapsules: [] }, task: before.activeMeetingTask, sessionId, runtimeEpoch: 1 }),
  });
  assert.match(after.transcript, /Me \(clarification\): One index per tenant/);
  assert.doesNotMatch(after.transcript, /Design a retrieval service/);
});

test("C2 base latestTurn remains the latest raw turn even when excluded from the prompt", () => {
  const manager = new MeetingContextManager();
  manager.addTranscriptTurn(sourceTurn());
  const excluded: TranscriptTurn = { ...sourceTurn(), id: "excluded", text: "Background speech.", speaker: "me", source: "microphone", startedAt: 2_000, endedAt: 2_100 };
  manager.addTranscriptTurn(excluded);
  const before = manager.buildAdvisorPromptContext();
  assert.doesNotMatch(before.transcript, /Background speech/);
  const after = createEffectiveAdvisorBaseBuilder(manager, new EffectiveQuestionSourceLedger())();
  assert.deepEqual({ ...after }, before);
  assert.deepEqual(after.latestTurn, excluded);
});

test("C5 all production base calls use the sole effective Hook builder", () => {
  assert.doesNotMatch(hook.getFullText(), /const currentPromptContext\b/);
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "buildAdvisorPromptContext") calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(hook);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].arguments.length, 1);
  assert.ok(calls[0].arguments.every(ts.isArrowFunction));
  const builder = declaration("buildEffectiveAdvisorBasePromptContext");
  assert.ok(calls[0].pos > builder.pos && calls[0].end < builder.end);
  for (const name of ["basePromptContext", "boundaryContext", "baseContext"]) {
    assert.match(declaration(name).getText(hook), /buildEffectiveAdvisorBasePromptContext/);
  }
  assert.match(hook.getFullText(), /basePromptContext:\s*buildEffectiveAdvisorBasePromptContext\(\s*screenLogicalQuestionUnit\s*\)/);
});

test("C3/C5 boundary, action and Screen sufficiency snippets pass their own LQU to the effective builder", () => {
  const manager = new MeetingContextManager();
  const turn = sourceTurn();
  manager.addTranscriptTurn(turn);
  const unit = composeLogicalQuestionUnit({ currentTurn: turn, sessionId: manager.getState().sessionId, runtimeEpoch: 1, now: turn.endedAt });
  const build = createEffectiveAdvisorBaseBuilder(manager, new EffectiveQuestionSourceLedger());
  let calls = 0;
  const buildEffectiveAdvisorBasePromptContext = (selected: typeof unit) => {
    calls += 1;
    assert.equal(selected, unit);
    return build(selected);
  };
  const expressions = [declaration("boundaryContext").initializer!, declaration("baseContext").initializer!];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(hook) === "basePromptContext" &&
      node.initializer.getText(hook).includes("buildEffectiveAdvisorBasePromptContext")) expressions.push(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(hook);
  assert.equal(expressions.length, 3);
  for (const expression of expressions) {
    const result = evaluate(`globalThis.result = ${expression.getText(hook)};`, {
      buildEffectiveAdvisorBasePromptContext, advisorJob: { logicalQuestionUnit: unit }, logicalQuestionUnit: unit, screenLogicalQuestionUnit: unit,
    }).result as AdvisorPromptContext;
    assert.equal(result.transcript, `Them: ${turn.text}`);
    assert.deepEqual(result.advisorPromptSourceTurnIds, [turn.id]);
    assert.deepEqual(result.latestTurn, turn);
  }
  assert.equal(calls, 3);
});

test("C3/C4 no-LQU base scopes generated output with the Manager session without mutating canonical state", () => {
  const manager = managerWithParent();
  const canonical = manager.getState();
  const published = continuityFor(manager);
  const continuity = { current: published };
  const getState = manager.getState.bind(manager);
  let reads = 0;
  manager.getState = () => { reads += 1; return getState(); };
  const build = createEffectiveAdvisorBaseBuilder(manager, new EffectiveQuestionSourceLedger(), { current: 1 }, undefined, continuity);
  const context = build();
  assert.equal(reads, 1);
  assert.equal(context.activeMeetingTask?.parent.latestUsefulAnswer, published.latestUsefulAnswer);
  assert.equal(context.activeMeetingTask?.parent.previousUsefulAnswer, published.previousUsefulAnswer);
  assert.doesNotMatch(context.transcript, /Generated latest|Generated previous/);
  for (const owner of [
    { ...published.owner!, sessionId: "another-session" },
    { ...published.owner!, runtimeEpoch: 2 },
    { ...published.owner!, parentTaskId: "another-parent" },
  ]) {
    continuity.current = { ...published, owner };
    assert.equal(build().activeMeetingTask?.parent.latestUsefulAnswer, undefined);
    assert.equal(build().activeMeetingTask?.parent.previousUsefulAnswer, undefined);
  }
  assert.deepEqual(getState(), canonical);
});
