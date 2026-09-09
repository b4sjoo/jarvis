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
import { projectEffectiveLogicalQuestionSources, projectAdvisorTranscriptForLogicalQuestion } from "../src/lib/meeting/logical-question-effective-projection.js";
import { compileSettledAdvisorPromptContext, formatSettledAdvisorContextCompilationForTrace, type SettledAdvisorContextCompilation } from "../src/lib/meeting/settled-advisor-context.js";
import { buildAdvisorUserMessage } from "../src/lib/meeting/advisor-prompt.js";
import { buildAdvisorEvidencePacket, buildAdvisorEvidenceRetrievalQuery } from "../src/lib/meeting/advisor-evidence-packet.js";
import { appendSourceOwnedSetupCandidate, createSourceOwnedSetupCandidate, selectSourceOwnedSemanticContext } from "../src/lib/meeting/source-owned-semantic-context.js";
import { composePhaseNavigationPromptContext, formatPhaseNavigationPromptMetricsForTrace, isPhaseNavigationAction } from "../src/lib/meeting/phase-navigation-prompt-context.js";
import { resolveAdvisorScreenSourceRead } from "../src/lib/meeting/screen-task-scope.js";
import { resolveResponseActionLogicalQuestionUnit } from "../src/lib/meeting/response-action-target.js";
import { setTestTaskRuntime } from "./helpers/meeting-task-runtime.js";
import type { ActiveInterviewParent, AdvisorPromptContext, AdvisorContextScopeSnapshot, AdvisorSourceOwnedSemanticContext, TranscriptTurn } from "../src/lib/meeting/types.js";
import type { AdvisorContextReadScope } from "../src/lib/meeting/advisor-context-read-scope.js";

// Execute the production construction block, then its actual prompt/query consumers.
// Inputs come from the real manager, LQU composer/correction and effective ledger.
const hookText = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
const start = hookText.indexOf("    const settledAdvisorContextCompilation =");
const end = hookText.indexOf('    let finalContent = "";', start);
assert.ok(start >= 0 && end > start);
const construction = new vm.Script(ts.transpileModule(
  `${hookText.slice(start, end)}\nglobalThis.result = { compilation: settledAdvisorContextCompilation, context: advisorModelPromptContext };`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText);

function turn(id: string, text: string, at: number, speaker: "them" | "me" = "them"): TranscriptTurn {
  return { id, text, speaker, source: speaker === "me" ? "microphone" : "system-audio", startedAt: at, endedAt: at + 100, isFinal: true };
}

function fixture(turns: TranscriptTurn[]) {
  const manager = new MeetingContextManager({ transcriptWindowMs: 600_000 });
  turns.forEach((source) => manager.addTranscriptTurn(source));
  const sessionId = manager.getState().sessionId;
  const unit = (source: TranscriptTurn) => composeLogicalQuestionUnit({ currentTurn: source, sessionId, runtimeEpoch: 1, now: source.endedAt });
  return { manager, unit, ledger: new EffectiveQuestionSourceLedger() };
}

function correct(unit: LogicalQuestionUnit, to = "RAG") {
  return applyActiveQuestionTermCorrection({
    logicalQuestionUnit: unit,
    correction: { id: `correction-${to}`, input: `${to} not car-sharing`, term: to, from: "car-sharing", to, createdAt: unit.updatedAt + 1, appliedCount: 0 },
    correctionTraceId: "correction-trace", manualCorrectionRevision: 1, now: unit.updatedAt + 1,
  }).logicalQuestionUnit;
}

function remember(ledger: EffectiveQuestionSourceLedger, unit: LogicalQuestionUnit, parentId = "parent-a") {
  const source = createProvisionalCurrentQuestion({ logicalQuestionUnit: unit, sourceKind: "voice" });
  const effective = projectEffectiveLogicalQuestionSources(unit);
  const record: EffectiveQuestionSourceRecord = {
    recordId: `${unit.id}:${unit.revision}:${source.sourceHash}`, sessionId: unit.sessionId, runtimeEpoch: unit.runtimeEpoch,
    logicalQuestionUnitId: unit.id, logicalQuestionRevision: unit.revision, sourceHash: source.sourceHash,
    sourceKind: "voice", currentTurnId: unit.currentTurnId, contextSourceTurnIds: unit.contextSourceTurnIds ?? [], recentLogicalQuestionSourceTurnIds: unit.recentLogicalQuestionSourceTurnIds ?? [],
    sourceTurnIds: unit.sourceTurnIds, text: effective.effectiveText, answerFocusText: effective.answerFocusText,
    correctionIds: effective.correctionIds, effectiveSourceTexts: effective.effectiveSourceTexts,
    startedAt: unit.startedAt, updatedAt: unit.updatedAt, settledAt: unit.updatedAt,
    speechAct: "question", disposition: "answer-primary-ask", relation: "followup-parent",
    owner: { kind: "parent-mainline", parentId },
  };
  ledger.upsert(record);
  return record;
}

function consume(f: ReturnType<typeof fixture>, unit: LogicalQuestionUnit | undefined, input: {
  scope?: AdvisorContextReadScope;
  recent?: AdvisorSourceOwnedSemanticContext;
  receipt?: AdvisorContextScopeSnapshot;
} = {}) {
  const base = f.manager.buildAdvisorPromptContext();
  const source = unit && createProvisionalCurrentQuestion({ logicalQuestionUnit: unit, sourceKind: "voice" });
  const effective = unit && projectEffectiveLogicalQuestionSources(unit);
  base.currentQuestionProjection = effective && { answerFocusText: effective.answerFocusText, semanticEvidenceText: effective.effectiveText, sourceTurnIds: unit!.sourceTurnIds };
  base.advisorEvidencePacket = buildAdvisorEvidencePacket({ currentQuestion: source && {
    text: effective!.effectiveText, source: "voice-lqu", sourceTurnIds: source.sourceTurnIds,
    logicalQuestionUnitId: source.logicalQuestionUnitId, revision: source.revision, sourceHash: source.sourceHash,
  } });
  base.responseActionContextScope = input.receipt;
  const metadata: Record<string, unknown> = {};
  const environment = vm.createContext({
    transientPersonalStatusDecision: undefined, promptContext: base,
    settledExecutionPlan: { contextReadScope: input.scope ?? "current-only" },
    advisorJob: { logicalQuestionUnit: unit, expectedSessionId: f.manager.getState().sessionId, runtimeCommitToken: { runtimeEpoch: 1 } },
    contextManagerRef: { current: f.manager }, effectiveQuestionSourceRecords: f.ledger.list(),
    advisorSourceOwnedSemanticContext: input.recent, advisorScreenScopeDecision: { action: "keep", reason: "existing-task-continuity" },
    responseActionContextSelection: undefined, traceId: "context-trace",
    traceStoreRef: { current: { updateMetadata: (_id: string, fields: Record<string, unknown>) => Object.assign(metadata, fields) } },
    options: {}, responseOwner: { questionType: "general-system-design" },
    compileSettledAdvisorPromptContext, formatSettledAdvisorContextCompilationForTrace,
    isPhaseNavigationAction, composePhaseNavigationPromptContext, formatPhaseNavigationPromptMetricsForTrace,
  });
  construction.runInContext(environment);
  const result = environment.result as { compilation: SettledAdvisorContextCompilation; context: AdvisorPromptContext };
  return { ...result, metadata, prompt: buildAdvisorUserMessage(result.context), query: buildAdvisorEvidenceRetrievalQuery(result.context.advisorEvidencePacket!, "live") };
}

test("C1/C3 production construction consumes corrected ledger history once and preserves raw evidence/hash", () => {
  const parent = turn("parent", "Design a car-sharing system.", 1_000);
  const ask = turn("ask", "How would you index it?", 2_000);
  const f = fixture([parent, ask]);
  const original = f.unit(parent);
  const first = remember(f.ledger, original);
  const corrected = correct(original);
  const latest = remember(f.ledger, corrected);
  const result = consume(f, { ...f.unit(ask), contextSourceTurnIds: [parent.id] });
  assert.match(result.prompt, /Design a RAG system/);
  assert.doesNotMatch(result.prompt, /car-sharing/);
  assert.deepEqual(result.compilation.selectedSourceTurnIds, [parent.id, ask.id]);
  assert.equal(result.metadata.advisorModelTranscriptProjectionApplied, true);
  assert.deepEqual(result.metadata.advisorModelTranscriptCorrectionIds, ["correction-RAG"]);
  assert.notEqual(first.sourceHash, latest.sourceHash);
  assert.equal(f.ledger.list()[0].sourceHash, latest.sourceHash);
  assert.equal(f.manager.getState().transcriptTurns[0].text, parent.text);
  assert.equal(original.sources[0].text, parent.text);
  assert.match(result.query, /How would you index it/);
  assert.doesNotMatch(result.query, /Design a RAG system/);
});

test("C1/C4 correction cancellation rebuilds without reusing the previous operation", () => {
  const raw = turn("ask", "Design a car-sharing system.", 1_000);
  const f = fixture([raw]);
  const original = f.unit(raw);
  const corrected = correct(original);
  remember(f.ledger, corrected);
  const before = consume(f, corrected);
  const cancelled = { ...original, revision: corrected.revision + 1, updatedAt: corrected.updatedAt + 1 };
  remember(f.ledger, cancelled);
  const after = consume(f, cancelled);
  assert.match(before.prompt, /Design a RAG system/);
  assert.doesNotMatch(before.prompt, /car-sharing/);
  assert.match(after.prompt, /Design a car-sharing system/);
  assert.equal(after.metadata.advisorModelTranscriptProjectionApplied, false);
  assert.match(before.context.transcript, /Design a RAG system/);
  assert.notEqual(before.context, after.context);
});

for (const gap of [45_000, 45_001]) {
  test(`C2 source selector to Hook preserves orphan boundary at ${gap}ms`, () => {
    const setup = turn("setup", "The corpus contains PDFs and wiki pages.", 1_000);
    const ask = turn("ask", "How would you index them?", setup.endedAt + gap);
    const f = fixture([setup, ask]);
    const unit = f.unit(ask);
    const candidate = createSourceOwnedSetupCandidate({ turn: setup, sessionId: unit.sessionId, runtimeEpoch: 1 });
    assert.ok(candidate);
    const selection = selectSourceOwnedSemanticContext({ candidate, sessionId: unit.sessionId, runtimeEpoch: 1, logicalQuestionUnit: unit, transcriptTurns: f.manager.getState().transcriptTurns });
    const result = consume(f, unit, { scope: "bounded-recent-history", recent: selection.context });
    assert.equal(result.prompt.includes(setup.text), gap === 45_000);
    assert.match(result.prompt, /How would you index them/);
    assert.equal(f.ledger.list().length, 0);
  });
}

test("C2 long informative group and Me clarification survive without setup LQUs", () => {
  const sources = [turn("setup-1", "The corpus contains PDFs and wiki pages.", 0), turn("setup-2", "Documents have per-user access control lists.", 40_000), turn("setup-3", "Freshness matters because documents change frequently.", 80_000)];
  const me = turn("me", "Do you mean per-tenant access?", 85_000, "me");
  const ask = turn("ask", "How would you chunk and index them?", 110_000);
  const f = fixture([...sources, me, ask]);
  const unit = { ...f.unit(ask), contextSourceTurnIds: [me.id] };
  let candidate: ReturnType<typeof createSourceOwnedSetupCandidate>;
  for (const source of sources) {
    const next = createSourceOwnedSetupCandidate({ turn: source, sessionId: unit.sessionId, runtimeEpoch: 1 });
    assert.ok(next);
    candidate = appendSourceOwnedSetupCandidate(candidate, next);
  }
  const selection = selectSourceOwnedSemanticContext({ candidate, sessionId: unit.sessionId, runtimeEpoch: 1, logicalQuestionUnit: unit, transcriptTurns: f.manager.getState().transcriptTurns });
  const result = consume(f, unit, { scope: "bounded-recent-history", recent: selection.context });
  for (const source of sources) assert.ok(result.prompt.includes(source.text));
  assert.match(result.context.transcript, /Me \(clarification\): Do you mean per-tenant access/);
  assert.equal(f.ledger.list().length, 0);
});

test("C2/C4 Narrow and Enhance receipts restrict corrected multi-turn source content", () => {
  const first = turn("first", "The car-sharing corpus is private.", 1_000);
  const second = turn("second", "The car-sharing index is public.", 2_000);
  const ask = turn("ask", "How would you evaluate it?", 3_000);
  const f = fixture([first, second, ask]);
  const grouped = { ...f.unit(first), sourceTurnIds: [first.id, second.id], currentTurnId: second.id,
    sources: [first, second].map((source) => ({ turnId: source.id, text: source.text, startedAt: source.startedAt, endedAt: source.endedAt })), normalizedText: `${first.text} ${second.text}` };
  remember(f.ledger, correct(grouped));
  const unit = { ...f.unit(ask), contextSourceTurnIds: [first.id, second.id] };
  const receipt = (action: "narrow-context" | "enhance-context"): AdvisorContextScopeSnapshot => ({
    operationId: action, action, mode: action === "narrow-context" ? "current-only" : "expanded",
    logicalQuestionUnitId: unit.id, logicalQuestionUnitRevision: unit.revision,
    selectedContextSourceKinds: ["current-lqu"], selectedContextTurnIds: action === "narrow-context" ? [ask.id] : [second.id, ask.id],
    selectedContextChars: 100, selectionReason: "current-only", expansionBudget: 1_600,
  });
  const narrow = consume(f, unit, { receipt: receipt("narrow-context") });
  const enhance = consume(f, unit, { receipt: receipt("enhance-context") });
  assert.doesNotMatch(narrow.prompt, /corpus is private|index is public/);
  assert.match(enhance.prompt, /RAG index is public/);
  assert.doesNotMatch(enhance.prompt, /corpus is private|car-sharing/);
  assert.deepEqual(enhance.compilation.selectedSourceTurnIds, [second.id, ask.id]);
  const stale = consume(f, { ...unit, revision: unit.revision + 1 }, { receipt: receipt("enhance-context") });
  assert.equal(stale.compilation.responseActionContextSelectionReason, "logical-question-revision-mismatch");
});

test("C4 explicit empty scope and unavailable turns cannot revive raw corrected history", () => {
  const raw = turn("unrelated", "Design a car-sharing system.", 1_000);
  const f = fixture([raw]);
  remember(f.ledger, correct(f.unit(raw)));
  const projection = projectAdvisorTranscriptForLogicalQuestion({ turns: [raw], includedTurnIds: [], effectiveRecords: f.ledger.list() });
  assert.equal(projection.transcript, "");
  const result = consume(f, undefined);
  assert.equal(result.context.transcript, "");
  assert.equal(result.context.latestTurn, undefined);
  assert.doesNotMatch(result.prompt, /car-sharing|Design a RAG system/);
  assert.deepEqual(result.compilation.selectedSourceTurnIds, []);
});

test("C4 Screen identity stays exact after a newer observation arrives and bind-voice stays scoped", () => {
  const voice = turn("voice", "How should get update recency?", 1_000);
  const f = fixture([voice]);
  const now = Date.now();
  for (const id of ["screen-a", "screen-b"]) f.manager.addScreenObservation({ id, capturedAt: now, imageBase64: `image-${id}`, visualSummary: id, source: "hotkey", changed: true });
  setTestTaskRuntime(f.manager, { parent: { id: "parent-a", source: "screen", stableKind: "coding", topic: "Implement an LRU cache", playbookPhase: "implementation_validation", phaseProgress: {}, supportedFactAnchors: [], createdAt: now, updatedAt: now, revisions: 1 },
    screenAttachment: { id: "screen-task", observationId: "screen-a", basedOnObservationId: "screen-a", basedOnTurnIds: [voice.id], createdAt: now, updatedAt: now, kind: "coding", question: "Implement an LRU cache", content: "" } });
  const state = f.manager.getState();
  const read = (ids: string[]) => resolveAdvisorScreenSourceRead({ mode: "screen-anchored", expectedSessionId: state.sessionId, currentSessionId: state.sessionId, expectedRuntimeEpoch: 1, currentRuntimeEpoch: 1, expectedParentId: "parent-a", activeMeetingTask: state.activeMeetingTask, screenObservations: state.screenObservations, preferredObservationIds: ids, requirePreferredObservation: true, sourceVoiceTurnIds: [voice.id], providerSupportsImages: true });
  const source = read(["screen-a"]);
  const result = consume(f, f.unit(voice), { scope: "active-parent-read" });
  assert.equal(source.sourceScreenObservationId, "screen-a");
  assert.equal(source.image?.base64, "image-screen-a");
  assert.deepEqual(source.sourceVoiceTurnIds, [voice.id]);
  assert.equal(result.compilation.screenContextIncluded, true);
  assert.match(result.prompt, /How should get update recency/);
  assert.equal(read(["screen-missing"]).image, undefined);
});

test("C5 production construction has one compiler read and no post-format rewrite", () => {
  const block = hookText.slice(start, end);
  assert.equal((block.match(/compileSettledAdvisorPromptContext\(/g) ?? []).length, 1);
  assert.equal((block.match(/getState\(\)\.transcriptTurns/g) ?? []).length, 1);
  assert.doesNotMatch(block, /projectAdvisorTranscriptForLogicalQuestion\(/);
  assert.doesNotMatch(block, /advisorTranscriptProjection\?\.replaced\s*\?/);
  assert.doesNotMatch(block, /\bawait\b/);
});

function parent(sourceTurnId: string): ActiveInterviewParent {
  const now = Date.now();
  return { id: "parent-a", source: "voice", stableKind: "general-system-design", topic: "Design a retrieval system", canonicalQuestionSourceTurnIds: [sourceTurnId], playbookPhase: "requirement_clarification", phaseProgress: {}, supportedFactAnchors: [], createdAt: now, updatedAt: now, revisions: 1 };
}

test("C1 winner-first manual source selection cannot revive a revision after its latest owner exits", () => {
  const source = turn("parent-source", "Design a car-sharing system.", 1_000);
  const f = fixture([source]);
  setTestTaskRuntime(f.manager, { parent: parent(source.id) });
  const original = f.unit(source);
  remember(f.ledger, original);
  const corrected = correct(original);
  remember(f.ledger, corrected);
  const select = () => resolveResponseActionLogicalQuestionUnit({ currentLogicalQuestionUnit: undefined, effectiveQuestionSources: f.ledger.listHistory(), meetingContext: f.manager.getState(), runtimeEpoch: 1, preferScreen: false, phaseOwner: { kind: "parent", id: "parent-a" } });
  const selected = select();
  assert.ok(selected);
  assert.equal(selected.revision, corrected.revision);
  assert.match(consume(f, selected).prompt, /Design a RAG system/);
  remember(f.ledger, { ...corrected, revision: corrected.revision + 1 }, "parent-exited");
  assert.equal(f.ledger.list().length, 1);
  assert.equal(select(), undefined);
});

test("C2 parent history is not a 45s TTL; active-child/resume keep their own scope", () => {
  const root = turn("root", "Design a car-sharing system.", 1_000);
  const child = turn("child", "Implement the tenant ID filter.", 80_000);
  const ask = turn("ask", "How should failures be handled?", 100_000);
  const outside = turn("outside", "Unrelated notification task.", 500);
  const f = fixture([outside, root, child, ask]);
  const rootParent = parent(root.id);
  setTestTaskRuntime(f.manager, { parent: rootParent });
  remember(f.ledger, correct(f.unit(root)));
  setTestTaskRuntime(f.manager, { parent: { ...rootParent, revisions: 2, child: { id: "child-a", createdAt: Date.now(), updatedAt: Date.now(), questionType: "coding", relation: "child-probe", intent: "implementation-probe", question: child.text, basedOnTurnIds: [child.id], basedOnObservationIds: [] } } });
  const childRead = consume(f, f.unit(ask), { scope: "active-child-read" });
  assert.match(childRead.prompt, /Design a RAG system/);
  assert.match(childRead.context.transcript, /Implement the tenant ID filter/);
  assert.doesNotMatch(childRead.prompt, /Unrelated notification|car-sharing/);
  setTestTaskRuntime(f.manager, { parent: { ...rootParent, revisions: 3 } });
  const resumed = consume(f, f.unit(ask), { scope: "active-parent-read" });
  assert.match(resumed.prompt, /Design a RAG system/);
  assert.doesNotMatch(resumed.context.transcript, /tenant ID filter/);
  const newParent = consume(f, f.unit(ask), { scope: "current-only" });
  assert.doesNotMatch(newParent.prompt, /Design a RAG system|tenant ID filter/);
});

test("C2 a non-LQU candidate from another parent cannot enter the compiler", () => {
  const setup = turn("setup", "The corpus contains confidential documents.", 1_000);
  const ask = turn("ask", "How would you index it?", 2_000);
  const f = fixture([setup, ask]);
  setTestTaskRuntime(f.manager, { parent: parent("absent") });
  const state = f.manager.getState();
  const candidate = createSourceOwnedSetupCandidate({ turn: setup, sessionId: state.sessionId, runtimeEpoch: 1, activeMeetingTask: state.activeMeetingTask });
  setTestTaskRuntime(f.manager, { parent: { ...parent("absent"), id: "parent-b" } });
  const unit = f.unit(ask);
  const selected = selectSourceOwnedSemanticContext({ candidate, sessionId: state.sessionId, runtimeEpoch: 1, logicalQuestionUnit: unit, activeMeetingTask: f.manager.getState().activeMeetingTask, transcriptTurns: f.manager.getState().transcriptTurns });
  assert.equal(selected.reason, "active-parent-mismatch");
  assert.doesNotMatch(consume(f, unit, { scope: "active-parent-read", recent: selected.context }).prompt, /confidential documents/);
});
