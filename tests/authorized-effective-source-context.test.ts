import assert from "node:assert/strict";
import test from "node:test";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import { composeLogicalQuestionUnit, type LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import { applyActiveQuestionTermCorrection } from "../src/lib/meeting/active-question-term-correction.js";
import { createProvisionalCurrentQuestion } from "../src/lib/meeting/current-question-settlement.js";
import { EffectiveQuestionSourceLedger, selectOwnerScopedRelationEvidence, type EffectiveQuestionSourceRecord } from "../src/lib/meeting/effective-question-source-ledger.js";
import { projectEffectiveLogicalQuestionSources } from "../src/lib/meeting/logical-question-effective-projection.js";
import { compileSettledAdvisorPromptContext } from "../src/lib/meeting/settled-advisor-context.js";
import { buildAdvisorUserMessage } from "../src/lib/meeting/advisor-prompt.js";
import { setTestTaskRuntime } from "./helpers/meeting-task-runtime.js";
import type { ActiveInterviewParent, TranscriptTurn } from "../src/lib/meeting/types.js";
import { indexAuthorizedEffectiveSourceRecords, readAuthorizedEffectiveSourceText, resolveAuthorizedEffectiveSourceContext } from "../src/lib/meeting/authorized-effective-source-context.js";
import { buildBoundedParentContextHandoff } from "../src/lib/meeting/manual-question-type-correction.js";

function turn(id: string, text: string, at: number): TranscriptTurn {
  return { id, text, speaker: "them", source: "system-audio", startedAt: at, endedAt: at + 100, isFinal: true };
}

function fixture(rootText = "Design a multi-tenant RAC service with document ingestion, retrieval, and per-tenant access control.") {
  const manager = new MeetingContextManager();
  const ledger = new EffectiveQuestionSourceLedger();
  const unit = (source: TranscriptTurn) => composeLogicalQuestionUnit({ currentTurn: source, sessionId: manager.getState().sessionId, runtimeEpoch: 1, now: source.endedAt });
  const root = turn("root", rootText, 1_000);
  manager.addTranscriptTurn(root);
  const original = unit(root);
  const corrected = applyActiveQuestionTermCorrection({ logicalQuestionUnit: original,
    correction: { id: "RAC-RAG", input: "RAG not RAC", term: "RAG", from: "RAC", to: "RAG", createdAt: 150_000, appliedCount: 0 },
    correctionTraceId: "correction", manualCorrectionRevision: 1, now: 150_000 }).logicalQuestionUnit;
  const parent: ActiveInterviewParent = { id: "parent", source: "voice", stableKind: "ai-ml-system-design", topic: root.text,
    sourceQuestionUnitId: original.id, sourceQuestionRevision: 1, canonicalQuestionSourceTurnIds: [root.id],
    playbookPhase: "design_framing", phaseProgress: {}, supportedFactAnchors: [], createdAt: root.startedAt, updatedAt: root.endedAt, revisions: 1 };
  setTestTaskRuntime(manager, { parent });
  function remember(lqu: LogicalQuestionUnit, patch: Partial<EffectiveQuestionSourceRecord> = {}) {
    const source = createProvisionalCurrentQuestion({ logicalQuestionUnit: lqu, sourceKind: "voice" });
    const effective = projectEffectiveLogicalQuestionSources(lqu);
    const record: EffectiveQuestionSourceRecord = {
      recordId: `${lqu.id}:${lqu.revision}`, sessionId: lqu.sessionId, runtimeEpoch: lqu.runtimeEpoch,
      logicalQuestionUnitId: lqu.id, logicalQuestionRevision: lqu.revision, sourceHash: source.sourceHash,
      sourceKind: "voice", currentTurnId: lqu.currentTurnId, sourceTurnIds: [...lqu.sourceTurnIds],
      text: effective.effectiveText, answerFocusText: effective.answerFocusText, correctionIds: effective.correctionIds,
      effectiveSourceTexts: effective.effectiveSourceTexts, startedAt: lqu.startedAt, updatedAt: lqu.updatedAt, settledAt: lqu.updatedAt,
      speechAct: "question", disposition: "answer-primary-ask", relation: "new-parent", owner: { kind: "parent-mainline", parentId: parent.id }, ...patch,
    };
    ledger.upsert(record);
    return record;
  }
  remember(original);
  remember(corrected);
  const compile = (lqu: LogicalQuestionUnit, scope: "active-parent-read" | "active-child-read" | "current-only" = "active-parent-read") => compileSettledAdvisorPromptContext({
    baseContext: manager.buildAdvisorPromptContext(), contextReadScope: scope, logicalQuestionUnit: lqu,
    transcriptTurns: manager.getState().transcriptTurns, effectiveRecords: ledger.listHistory(), sessionId: lqu.sessionId, runtimeEpoch: 1,
  });
  return { manager, ledger, unit, root, original, corrected, parent, remember, compile };
}

test("EC1 real 120s Manager pruning retains corrected parent evidence through final Prompt", () => {
  const f = fixture();
  const child = turn("child", "Implement a Python allowed-ID filter.", 20_000);
  f.manager.addTranscriptTurn(child);
  setTestTaskRuntime(f.manager, { parent: { ...f.parent, revisions: 2, child: {
    id: "child", questionType: "coding", relation: "child-probe", intent: "implementation-probe", question: child.text,
    basedOnTurnIds: [child.id], basedOnObservationIds: [], createdAt: child.startedAt, updatedAt: child.endedAt,
  } } });
  const resume = turn("resume", "Back to the architecture. How would you enforce tenant isolation?", 160_000);
  f.manager.addTranscriptTurn(resume);
  setTestTaskRuntime(f.manager, { parent: { ...f.parent, revisions: 3 } });
  assert.deepEqual(f.manager.getState().transcriptTurns.map((source) => source.id), [resume.id]);
  assert.equal(f.ledger.list()[0].logicalQuestionRevision, f.corrected.revision);
  const before = f.manager.getState();
  const compiled = f.compile(f.unit(resume));
  const prompt = buildAdvisorUserMessage(compiled.context);
  assert.match(compiled.context.transcript, /multi-tenant RAG service with document ingestion/);
  assert.match(prompt, /multi-tenant RAG service with document ingestion/);
  assert.doesNotMatch(compiled.context.transcript, /RAC|allowed-ID filter/);
  assert.deepEqual(compiled.selectedSourceTurnIds, [f.root.id, resume.id]);
  assert.equal(compiled.context.latestTurn?.id, resume.id);
  assert.deepEqual(f.manager.getState(), before);
  assert.match(f.original.sources[0].text, /RAC/);
});

function read(f: ReturnType<typeof fixture>, selectedSourceTurnIds: string[], logicalQuestionUnit?: LogicalQuestionUnit) {
  return resolveAuthorizedEffectiveSourceContext({ selectedSourceTurnIds, logicalQuestionUnit,
    transcriptTurns: f.manager.getState().transcriptTurns, effectiveRecords: f.ledger.listHistory(),
    sessionId: f.original.sessionId, runtimeEpoch: 1, activeMeetingTask: f.manager.getState().activeMeetingTask,
    meTurnLabel: "Me (clarification)",
  });
}

for (const owner of [
  { kind: "parent-mainline" as const, parentId: "exited-parent" },
  { kind: "active-child" as const, parentId: "parent", childId: "exited-child" },
]) {
  test(`EC2 latest ${owner.kind} owner rejection blocks old revision and raw fallback`, () => {
    const f = fixture();
    f.remember({ ...f.corrected, revision: f.corrected.revision + 1 }, { owner });
    const result = read(f, [f.root.id]);
    assert.equal(result.transcriptProjection.transcript, "");
    assert.deepEqual(result.rejectedSourceTurnIds, [f.root.id]);
    assert.deepEqual(result.selectedSourceTurnIds, []);
    assert.deepEqual(result.effectiveSourceTexts, []);
    assert.equal(read(f, [f.root.id], f.original).transcriptProjection.transcript, "");
  });
}

test("EC2 wrong session/epoch and Clear do not restore known raw sources", () => {
  for (const patch of [{ sessionId: "other-session" }, { runtimeEpoch: 2 }]) {
    const f = fixture();
    f.ledger.clear();
    f.remember(f.corrected, patch);
    assert.deepEqual(read(f, [f.root.id]).rejectedSourceTurnIds, [f.root.id]);
  }
  const f = fixture();
  setTestTaskRuntime(f.manager, { parent: null });
  assert.equal(read(f, [f.root.id]).transcriptProjection.transcript, "");
  assert.deepEqual(read(f, [f.root.id]).rejectedSourceTurnIds, [f.root.id]);
});

test("PC2 a new execution epoch reads the same corrected task origin through the final prompt", () => {
  const f = fixture();
  const followup = turn("after-pause", "How would you enforce tenant isolation?", 160_000);
  f.manager.addTranscriptTurn(followup);
  const current = { ...f.unit(followup), runtimeEpoch: 2 };
  const history = f.ledger.listHistory();
  const taskBefore = f.manager.getState().taskRuntime;
  const compiled = compileSettledAdvisorPromptContext({
    baseContext: f.manager.buildAdvisorPromptContext(), contextReadScope: "active-parent-read",
    logicalQuestionUnit: current, transcriptTurns: f.manager.getState().transcriptTurns,
    effectiveRecords: history, sessionId: current.sessionId, runtimeEpoch: 2,
  });
  assert.match(buildAdvisorUserMessage(compiled.context), /multi-tenant RAG service with document ingestion/);
  assert.doesNotMatch(compiled.context.transcript, /RAC/);
  assert.deepEqual(compiled.selectedSourceTurnIds, [f.root.id, followup.id]);
  assert.deepEqual(f.ledger.listHistory(), history);
  assert.deepEqual(f.manager.getState().taskRuntime, taskBefore);
});

test("PC1 retained current LQU and correction stay readable without source rebasing", () => {
  const f = fixture();
  const history = f.ledger.listHistory();
  const state = f.manager.getState();
  const before = read(f, [f.root.id], f.corrected);
  for (const runtimeEpoch of [2, 3, 4]) {
    const result = resolveAuthorizedEffectiveSourceContext({
      selectedSourceTurnIds: [f.root.id], logicalQuestionUnit: f.corrected,
      transcriptTurns: f.manager.getState().transcriptTurns, effectiveRecords: f.ledger.listHistory(),
      sessionId: f.corrected.sessionId, runtimeEpoch, activeMeetingTask: f.manager.getState().activeMeetingTask,
    });
    assert.match(result.transcriptProjection.transcript, /multi-tenant RAG/);
    assert.deepEqual(result.selectedSourceTurnIds, [f.root.id]);
    assert.deepEqual(result, before);
  }
  assert.deepEqual(f.ledger.listHistory(), history);
  assert.deepEqual(f.manager.getState(), state);
  assert.equal(f.corrected.runtimeEpoch, 1);
  assert.equal(f.corrected.revision, 2);
});

test("PC2 process/thread origin reaches Relation and Advisor after an execution advance", () => {
  const f = fixture("What is the difference between a process and a thread?");
  f.ledger.clear();
  const root = f.root;
  f.remember(f.original);
  const followup = turn("memory-isolation", "How does memory isolation work?", 160_000);
  f.manager.addTranscriptTurn(followup);
  const current = { ...f.unit(followup), runtimeEpoch: 2 };
  const compiled = compileSettledAdvisorPromptContext({
    baseContext: f.manager.buildAdvisorPromptContext(), contextReadScope: "active-parent-read",
    logicalQuestionUnit: current, transcriptTurns: f.manager.getState().transcriptTurns,
    effectiveRecords: f.ledger.listHistory(), sessionId: current.sessionId, runtimeEpoch: 2,
  });
  assert.match(buildAdvisorUserMessage(compiled.context), /difference between a process and a thread/);
  assert.doesNotMatch(buildAdvisorUserMessage(compiled.context), /tenant|RAC|RAG/);
  assert.deepEqual(compiled.selectedSourceTurnIds, [root.id, followup.id]);
  assert.equal(projectEffectiveLogicalQuestionSources(current).effectiveText, followup.text);
  const relation = selectOwnerScopedRelationEvidence({ records: f.ledger.listHistory(), currentLogicalQuestionUnit: current,
    activeMeetingTask: f.manager.getState().activeMeetingTask!, transcriptTurns: f.manager.getState().transcriptTurns });
  assert.deepEqual(relation.recentParentEvidence.map((source) => source.text), [root.text]);
  assert.equal(relation.diagnostics.rawSupplementCount, 0);
});

test("PC3 parent and corrected child retain their separate scopes across execution epochs", () => {
  const f = fixture();
  const child = turn("child", "Implement a RAC index filter.", 20_000);
  f.manager.addTranscriptTurn(child);
  const childOriginal = f.unit(child);
  const childCorrected = applyActiveQuestionTermCorrection({ logicalQuestionUnit: childOriginal,
    correction: { id: "child-RAC-RAG", input: "RAG not RAC", term: "RAG", from: "RAC", to: "RAG", createdAt: 21_000, appliedCount: 0 },
    correctionTraceId: "child-correction", manualCorrectionRevision: 1, now: 21_000 }).logicalQuestionUnit;
  const owner = { kind: "active-child" as const, parentId: f.parent.id, childId: child.id };
  f.remember(childOriginal, { owner, relation: "child-probe" });
  f.remember(childCorrected, { owner, relation: "child-probe" });
  setTestTaskRuntime(f.manager, { parent: { ...f.parent, revisions: 2, child: { id: child.id, questionType: "coding", relation: "child-probe",
    intent: "implementation-probe", question: child.text, basedOnTurnIds: [child.id], basedOnObservationIds: [], createdAt: child.startedAt, updatedAt: child.endedAt } } });
  const followup = turn("after-pause", "How would you test it?", 160_000);
  f.manager.addTranscriptTurn(followup);
  const current = { ...f.unit(followup), runtimeEpoch: 3 };
  const history = f.ledger.listHistory();
  const compile = (contextReadScope: "active-parent-read" | "active-child-read" | "current-only") => compileSettledAdvisorPromptContext({
    baseContext: f.manager.buildAdvisorPromptContext(), contextReadScope, logicalQuestionUnit: current,
    transcriptTurns: f.manager.getState().transcriptTurns, effectiveRecords: history, sessionId: current.sessionId, runtimeEpoch: 3,
  });
  const childContext = compile("active-child-read");
  assert.match(childContext.context.transcript, /multi-tenant RAG[\s\S]*Implement a RAG index filter/);
  assert.doesNotMatch(childContext.context.transcript, /RAC/);
  assert.deepEqual(childContext.selectedSourceTurnIds, [f.root.id, child.id, followup.id]);
  assert.doesNotMatch(compile("active-parent-read").context.transcript, /index filter/);
  assert.equal(compile("current-only").context.transcript, `Them: ${followup.text}`);
  setTestTaskRuntime(f.manager, { parent: { ...f.parent, revisions: 3 } });
  assert.match(compile("active-parent-read").context.transcript, /multi-tenant RAG/);
  const retiredChild = resolveAuthorizedEffectiveSourceContext({ selectedSourceTurnIds: [child.id],
    transcriptTurns: [child], effectiveRecords: history, sessionId: current.sessionId, runtimeEpoch: 3,
    activeMeetingTask: f.manager.getState().activeMeetingTask });
  assert.equal(retiredChild.transcriptProjection.transcript, "");
  assert.deepEqual(retiredChild.rejectedSourceTurnIds, [child.id]);
  assert.deepEqual(f.ledger.listHistory(), history);
});

test("PC5 historical sources reject exited owners, replaced revisions and changed sessions", () => {
  for (const invalidation of ["owner", "claim", "session", "future", "clear", "revision"] as const) {
    const f = fixture();
    let sessionId = f.corrected.sessionId;
    const runtimeEpoch = invalidation === "future" ? 0 : 3;
    if (invalidation === "session") sessionId = "new-session";
    if (invalidation === "clear") setTestTaskRuntime(f.manager, { parent: null });
    if (invalidation === "owner" || invalidation === "claim") f.remember({ ...f.corrected,
      id: invalidation === "claim" ? "new-owner-lqu" : f.corrected.id, updatedAt: 200_000 },
      { owner: { kind: "parent-mainline", parentId: "retired" }, settledAt: 200_000 });
    if (invalidation === "revision") f.remember({ ...f.corrected, revision: 3 },
      { sourceTurnIds: ["replacement"], effectiveSourceTexts: [{ turnId: "replacement", text: "Replacement." }] });
    const result = resolveAuthorizedEffectiveSourceContext({ selectedSourceTurnIds: [f.root.id],
      logicalQuestionUnit: ["session", "future", "revision"].includes(invalidation) ? f.corrected : undefined,
      transcriptTurns: [f.root], effectiveRecords: f.ledger.listHistory(), sessionId, runtimeEpoch,
      activeMeetingTask: f.manager.getState().activeMeetingTask });
    assert.equal(result.transcriptProjection.transcript, "", invalidation);
    assert.deepEqual(result.rejectedSourceTurnIds, [f.root.id], invalidation);
  }
});

test("EC2 explicit origin cannot bypass a newer rejected competing source claim", () => {
  const f = fixture();
  f.remember({ ...f.corrected, id: "different-lqu", updatedAt: 200_000 }, {
    owner: { kind: "parent-mainline", parentId: "exited" },
  });
  const recordIndex = indexAuthorizedEffectiveSourceRecords({ effectiveRecords: f.ledger.listHistory(),
    sessionId: f.original.sessionId, runtimeEpoch: 1, activeMeetingTask: f.manager.getState().activeMeetingTask });
  const result = readAuthorizedEffectiveSourceText({ recordIndex, logicalQuestionUnitId: f.original.id,
    sourceTurnIds: [f.root.id], owner: { kind: "parent-mainline", parentId: f.parent.id },
    sessionId: f.original.sessionId, runtimeEpoch: 1 });
  assert.equal(result.text, undefined);
  assert.deepEqual(result.rejectedSourceTurnIds, [f.root.id]);
});

test("EC2 source IDs removed by the latest revision do not resurrect superseded raw text", () => {
  const f = fixture();
  f.remember({ ...f.corrected, revision: 3 }, { sourceTurnIds: ["replacement"], effectiveSourceTexts: [{ turnId: "replacement", text: "Only the replacement is current." }] });
  assert.equal(read(f, [f.root.id]).transcriptProjection.transcript, "");
  assert.deepEqual(read(f, [f.root.id]).rejectedSourceTurnIds, [f.root.id]);
});

test("EC3 partial retained spans never expand into an unselected multi-source LQU", () => {
  const f = fixture();
  f.remember({ ...f.corrected, revision: 3 }, { sourceTurnIds: [f.root.id, "second"],
    text: "RAG private corpus. RAG public index.",
    effectiveSourceTexts: [{ turnId: f.root.id, text: "RAG private corpus." }, { turnId: "second", text: "RAG public index." }],
  });
  const result = read(f, ["second"]);
  assert.match(result.transcriptProjection.transcript, /RAG public index/);
  assert.doesNotMatch(result.transcriptProjection.transcript, /private|multi-tenant|RAC/);
  assert.deepEqual(result.selectedSourceTurnIds, ["second"]);
  assert.deepEqual(result.effectiveSourceTexts, [{ turnId: "second", text: "RAG public index." }]);
  const recordIndex = indexAuthorizedEffectiveSourceRecords({ effectiveRecords: f.ledger.listHistory(), sessionId: f.original.sessionId,
    runtimeEpoch: 1, activeMeetingTask: f.manager.getState().activeMeetingTask });
  assert.equal(readAuthorizedEffectiveSourceText({ recordIndex, logicalQuestionUnitId: f.original.id, sourceTurnIds: ["second"],
    owner: { kind: "parent-mainline", parentId: f.parent.id }, sessionId: f.original.sessionId, runtimeEpoch: 1 }).text, "RAG public index.");
});

test("EC3 missing partial span is reported missing even when old raw text exists", () => {
  const f = fixture();
  f.remember({ ...f.corrected, revision: 3 }, { sourceTurnIds: [f.root.id, "second"], text: "Entire private and public corpus.", effectiveSourceTexts: [] });
  const result = read(f, [f.root.id]);
  assert.equal(result.transcriptProjection.transcript, "");
  assert.deepEqual(result.missingSourceTurnIds, [f.root.id]);
  assert.deepEqual(result.effectiveSourceTexts, []);
});

test("EC3 selected Me and informative raw inputs retain their labels without ledger records", () => {
  const f = fixture();
  const setup = turn("setup", "The corpus contains PDFs.", 2_000);
  const me: TranscriptTurn = { ...turn("me", "Do you mean per-tenant access?", 3_000), speaker: "me", source: "microphone" };
  f.manager.addTranscriptTurn(setup);
  f.manager.addTranscriptTurn(me);
  const result = read(f, ["me", "setup", "setup"]);
  assert.equal(result.transcriptProjection.transcript, "Them: The corpus contains PDFs.\nMe (clarification): Do you mean per-tenant access?");
  assert.deepEqual(result.selectedSourceTurnIds, ["setup", "me"]);
});

test("EC3 current provisional source needs neither parent nor a ledger receipt", () => {
  const f = fixture();
  f.ledger.clear();
  setTestTaskRuntime(f.manager, { parent: null });
  const result = read(f, [f.root.id], f.corrected);
  assert.match(result.transcriptProjection.transcript, /multi-tenant RAG/);
  assert.equal(result.transcriptProjection.latestTurn?.id, f.root.id);
  assert.deepEqual(result.rejectedSourceTurnIds, []);
});

test("EC3 compiler Narrow/current-only and active-child scopes preserve selected source authority after pruning", () => {
  const f = fixture();
  const child = turn("child", "Implement an allowed-ID filter.", 20_000);
  f.manager.addTranscriptTurn(child);
  const childUnit = f.unit(child);
  f.remember(childUnit, { owner: { kind: "active-child", parentId: f.parent.id, childId: "child" }, relation: "child-probe" });
  setTestTaskRuntime(f.manager, { parent: { ...f.parent, revisions: 2, child: { id: "child", questionType: "coding", relation: "child-probe",
    intent: "implementation-probe", question: child.text, basedOnTurnIds: [child.id], basedOnObservationIds: [], createdAt: 20_000, updatedAt: 20_100 } } });
  const followup = turn("followup", "How would you test it?", 160_000);
  f.manager.addTranscriptTurn(followup);
  const unit = f.unit(followup);
  assert.match(f.compile(unit, "active-child-read").context.transcript, /RAG[\s\S]*allowed-ID filter[\s\S]*How would/);
  assert.doesNotMatch(f.compile(unit, "active-parent-read").context.transcript, /allowed-ID filter/);
  assert.doesNotMatch(f.compile(unit, "current-only").context.transcript, /RAG|allowed-ID/);
  const narrowed = compileSettledAdvisorPromptContext({ baseContext: { ...f.manager.buildAdvisorPromptContext(), responseActionContextScope: {
    operationId: "narrow", action: "narrow-context", mode: "current-only", logicalQuestionUnitId: unit.id, logicalQuestionUnitRevision: unit.revision,
    selectedContextSourceKinds: ["current-lqu"], selectedContextTurnIds: [followup.id], selectedContextChars: followup.text.length,
    selectionReason: "current-only", expansionBudget: 1_600,
  } }, contextReadScope: "active-child-read", logicalQuestionUnit: unit, transcriptTurns: f.manager.getState().transcriptTurns,
    effectiveRecords: f.ledger.listHistory(), sessionId: unit.sessionId, runtimeEpoch: 1 });
  assert.equal(narrowed.context.transcript, `Them: ${followup.text}`);
});

test("EC5 revision tie follows ledger winner rule; cancellation replaces corrected text", () => {
  const f = fixture();
  const cancellation = { ...f.original, revision: 3, updatedAt: 200_000 };
  f.remember(cancellation);
  assert.match(read(f, [f.root.id]).transcriptProjection.transcript, /RAC/);
  assert.equal(read(f, [f.root.id]).transcriptProjection.replaced, false);
  f.remember(cancellation, { recordId: "zz-winning-record", settledAt: 210_000, text: "Winner text.", effectiveSourceTexts: [{ turnId: f.root.id, text: "Winner text." }] });
  const index = indexAuthorizedEffectiveSourceRecords({ effectiveRecords: f.ledger.listHistory(), sessionId: f.original.sessionId,
    runtimeEpoch: 1, activeMeetingTask: f.manager.getState().activeMeetingTask });
  assert.equal(index.byLogicalQuestionUnitId.get(f.original.id)?.recordId, f.ledger.list()[0].recordId);
  assert.equal(read(f, [f.root.id]).transcriptProjection.transcript, "Them: Winner text.");
});

test("EC5 late correction preserves input order, interleaved Me and current question identity", () => {
  const f = fixture();
  const me = { ...turn("me", "Please keep tenant access explicit.", 2_000), speaker: "me" as const, source: "microphone" as const };
  const second = turn("second", "Explain the RAC index.", 3_000);
  const current = turn("current", "What is the latency tradeoff?", 4_000);
  [me, second, current].forEach((source) => f.manager.addTranscriptTurn(source));
  f.remember({ ...f.corrected, revision: 3 }, { sourceTurnIds: [f.root.id, second.id], text: "RAG corpus. RAG index.",
    effectiveSourceTexts: [{ turnId: f.root.id, text: "RAG corpus." }, { turnId: second.id, text: "RAG index." }] });
  const result = read(f, [current.id, second.id, f.root.id, me.id, f.root.id], f.unit(current));
  assert.match(result.transcriptProjection.transcript, /RAG corpus[\s\S]*Me \(clarification\)[\s\S]*RAG index[\s\S]*latency tradeoff/);
  assert.deepEqual(result.selectedSourceTurnIds, [f.root.id, me.id, second.id, current.id]);
  assert.equal(result.transcriptProjection.latestTurn?.text, current.text);
  assert.equal(f.manager.getState().transcriptTurns[0].text, f.root.text);
});

test("EC5 Screen source text restoration never manufactures STT or image authority", () => {
  const f = fixture();
  const screenId = "screen:observation";
  f.remember({ ...f.original, id: "screen-origin" }, { sourceKind: "screen", currentTurnId: screenId,
    sourceTurnIds: [], sourceObservationIds: ["observation"], correctionIds: [], text: "Implement the visible cache method.",
    effectiveSourceTexts: [{ turnId: screenId, text: "Implement the visible cache method." }] });
  const before = f.manager.getState();
  const result = read(f, [screenId]);
  assert.equal(result.transcriptProjection.transcript, "Screen: Implement the visible cache method.");
  assert.equal(result.transcriptProjection.latestTurn, undefined);
  assert.deepEqual(result.selectedSourceTurnIds, [screenId]);
  assert.deepEqual(f.manager.getState(), before);
  assert.deepEqual(f.manager.getState().screenObservations, []);
  assert.equal("image" in result, false);
});

test("EC7 unchanged 96-entry ledger eviction reports missing and keeps the current question usable", () => {
  const f = fixture();
  for (let i = 0; i < 95; i++) {
    f.remember({ ...f.original, id: `other-${i}`, sourceTurnIds: [`other-turn-${i}`] }, { correctionIds: [] });
  }
  assert.equal(f.ledger.listHistory().length, 96);
  const resume = turn("resume", "How should isolation work?", 160_000);
  f.manager.addTranscriptTurn(resume);
  assert.match(f.compile(f.unit(resume)).context.transcript, /multi-tenant RAG/);
  f.remember({ ...f.original, id: "last", sourceTurnIds: ["last-turn"] });
  assert.equal(f.ledger.listHistory().length, 96);
  const result = f.compile(f.unit(resume));
  assert.deepEqual(result.missingSourceTurnIds, [f.root.id]);
  assert.equal(result.context.transcript, `Them: ${resume.text}`);
  assert.equal(result.context.activeMeetingTask?.parent.topic, "");
  assert.match(buildAdvisorUserMessage(result.context), /How should isolation work/);
});

test("EC2/EC3 final semantic evidence packet cannot reintroduce rejected or superseded setup text", () => {
  const f = fixture();
  const followup = turn("followup", "How would you index it?", 2_000);
  f.manager.addTranscriptTurn(followup);
  const unit = { ...f.unit(followup), contextSourceTurnIds: [f.root.id] };
  const compile = () => compileSettledAdvisorPromptContext({ baseContext: {
    ...f.manager.buildAdvisorPromptContext(), advisorEvidencePacket: {
      version: "advisor-evidence-v2", preparation: { interviewTypes: [], guidanceHints: [], activatedFactIds: [], rawGuidanceRejectedAsFactCount: 0 }, retrievalHints: [],
    },
  }, contextReadScope: "active-parent-read", logicalQuestionUnit: unit, transcriptTurns: f.manager.getState().transcriptTurns,
    effectiveRecords: f.ledger.listHistory(), sessionId: unit.sessionId, runtimeEpoch: 1,
    recentSourceContext: { sourceTurnIds: [f.root.id], text: f.root.text, retentionReason: "same-parent-adjacent-setup", parentId: f.parent.id, parentRevision: 1 },
  });
  assert.match(compile().context.advisorEvidencePacket?.sourceOwnedSemanticContext?.text ?? "", /multi-tenant RAG/);
  f.remember({ ...f.corrected, revision: 3 }, { owner: { kind: "parent-mainline", parentId: "exited" } });
  assert.equal(compile().context.advisorEvidencePacket?.sourceOwnedSemanticContext, undefined);
  assert.doesNotMatch(buildAdvisorUserMessage(compile().context), /multi-tenant RAC|multi-tenant RAG/);
});

test("one construction reuses its current effective projection for transcript and origin text", () => {
  const f = fixture();
  let normalizedTextReads = 0;
  const unit = { ...f.corrected, get normalizedText() { normalizedTextReads++; return f.corrected.normalizedText; } };
  const input = { effectiveRecords: f.ledger.listHistory(), sessionId: unit.sessionId, runtimeEpoch: 1,
    logicalQuestionUnit: unit, activeMeetingTask: f.manager.getState().activeMeetingTask };
  const recordIndex = indexAuthorizedEffectiveSourceRecords(input);
  const readsAfterIndex = normalizedTextReads;
  assert.ok(readsAfterIndex > 0);
  resolveAuthorizedEffectiveSourceContext({ ...input, recordIndex, transcriptTurns: f.manager.getState().transcriptTurns, selectedSourceTurnIds: [f.root.id] });
  readAuthorizedEffectiveSourceText({ ...input, recordIndex, logicalQuestionUnitId: unit.id, sourceTurnIds: [f.root.id], owner: { kind: "parent-mainline", parentId: f.parent.id } });
  assert.equal(normalizedTextReads, readsAfterIndex);
});

test("EC5 mixed source groups retain separate Screen and voice labels", () => {
  const f = fixture();
  const screenId = "screen:mixed-observation";
  const voiceId = "mixed-voice";
  f.remember({ ...f.original, id: "mixed-origin" }, { sourceKind: "mixed", currentTurnId: voiceId,
    sourceTurnIds: [screenId, voiceId], correctionIds: ["mixed-correction"], text: "Visible cache task. Explain the RAG path.",
    effectiveSourceTexts: [{ turnId: screenId, text: "Visible cache task." }, { turnId: voiceId, text: "Explain the RAG path." }] });
  const result = read(f, [screenId, voiceId]);
  assert.match(result.transcriptProjection.transcript, /^Screen: .*Visible cache task\.\nThem: .*Explain the RAG path\.$/);
  assert.equal(result.transcriptProjection.latestTurn, undefined);
  assert.deepEqual(result.selectedSourceTurnIds, [screenId, voiceId]);
});

test("EC5 mixed compatibility record with only screen-prefixed current ID remains Screen text", () => {
  const f = fixture();
  const screenId = "screen:mixed-current";
  f.remember({ ...f.original, id: "mixed-screen-origin" }, {
    sourceKind: "mixed", currentTurnId: screenId, sourceTurnIds: [],
    text: "Implement the visible cache method.", correctionIds: [],
    effectiveSourceTexts: [{ turnId: screenId, text: "Implement the visible cache method." }],
  });
  const result = read(f, [screenId]);
  assert.equal(result.transcriptProjection.transcript, "Screen: Implement the visible cache method.");
  assert.deepEqual(result.effectiveSourceTexts, [{ turnId: screenId, text: "Implement the visible cache method." }]);
  assert.equal(result.transcriptProjection.latestTurn, undefined);
});

test("EC7 known task origin never falls back to surviving raw after high-churn ledger eviction", () => {
  const f = fixture();
  for (let i = 0; i < 96; i++) {
    f.remember({ ...f.original, id: `churn-${i}`, sourceTurnIds: [`churn-turn-${i}`] });
  }
  assert.equal(f.ledger.listHistory().length, 96);
  assert.equal(f.manager.getState().transcriptTurns[0].id, f.root.id);
  const setup = turn("ordinary-setup", "Documents have access control lists.", 2_000);
  f.manager.addTranscriptTurn(setup);
  const result = read(f, [f.root.id, setup.id]);
  assert.deepEqual(result.missingSourceTurnIds, [f.root.id]);
  assert.equal(result.transcriptProjection.transcript, `Them: ${setup.text}`);
  assert.deepEqual(result.effectiveSourceTexts, [{ turnId: setup.id, text: setup.text }]);
  assert.match(read(f, [f.root.id], f.corrected).transcriptProjection.transcript, /multi-tenant RAG/);
});

test("EC2 current source authority cannot infer old parent ownership after a known owner transfer", () => {
  const f = fixture();
  f.remember(f.corrected, { owner: { kind: "parent-mainline", parentId: "exited" } });
  for (const runtimeEpoch of [1, 3]) {
    const input = { effectiveRecords: f.ledger.listHistory(), sessionId: f.original.sessionId, runtimeEpoch,
      activeMeetingTask: f.manager.getState().activeMeetingTask, logicalQuestionUnit: f.corrected };
    const recordIndex = indexAuthorizedEffectiveSourceRecords(input);
    const result = readAuthorizedEffectiveSourceText({ ...input, recordIndex, logicalQuestionUnitId: f.original.id,
      sourceTurnIds: [f.root.id], owner: { kind: "parent-mainline", parentId: f.parent.id } });
    assert.equal(result.text, undefined);
    assert.deepEqual(result.rejectedSourceTurnIds, [f.root.id]);
    const currentOnly = resolveAuthorizedEffectiveSourceContext({ ...input, recordIndex,
      selectedSourceTurnIds: [f.root.id], transcriptTurns: [f.root] });
    assert.match(currentOnly.transcriptProjection.transcript, /multi-tenant RAG/);
  }
});

test("shared span output feeds handoff scale/requirements with existing turn metadata only", () => {
  const f = fixture();
  const scale = turn("scale", "We have 5 million users across 3 regions.", 2_000);
  const requirement = turn("requirement", "We need payment privacy.", 3_000);
  const blocked = turn("blocked", "We have 99 million users.", 4_000);
  [scale, requirement, blocked].forEach((source) => f.manager.addTranscriptTurn(source));
  const correctedScale = "We have 7 million users across 3 regions.";
  const correctedRequirement = "We need data residency and privacy.";
  f.remember(f.unit(scale), { text: correctedScale, effectiveSourceTexts: [{ turnId: scale.id, text: correctedScale }] });
  f.remember(f.unit(requirement), { text: correctedRequirement, effectiveSourceTexts: [{ turnId: requirement.id, text: correctedRequirement }] });
  f.remember(f.unit(blocked), { owner: { kind: "parent-mainline", parentId: "exited" } });
  const before = f.manager.getState();
  const context = read(f, [scale.id, requirement.id, blocked.id, "missing"]);
  assert.deepEqual(context.effectiveSourceTexts, [
    { turnId: scale.id, text: correctedScale },
    { turnId: requirement.id, text: correctedRequirement },
  ]);
  assert.deepEqual(context.rejectedSourceTurnIds, [blocked.id]);
  assert.deepEqual(context.missingSourceTurnIds, ["missing"]);
  const spanById = new Map(context.effectiveSourceTexts.map((span) => [span.turnId, span.text]));
  const effectiveTurns = before.transcriptTurns.flatMap((source) => {
    const text = spanById.get(source.id);
    return text === undefined ? [] : [{ ...source, text }];
  });
  const parent = { ...f.parent, startTurnId: scale.id, topic: "A ride sharing service for drivers." };
  const parentBefore = structuredClone(parent);
  const handoff = buildBoundedParentContextHandoff({
    parent, parentSourceQuestion: "A food delivery service for restaurants.",
    sourceQuestionId: "handoff-question", latestQuestionText: "Extend the same service.", transcriptTurns: effectiveTurns,
  });
  assert.equal(handoff.sourceParentId, parent.id);
  assert.equal(handoff.sharedScenarioContext.productIdentity, "food delivery");
  assert.deepEqual(handoff.sharedScenarioContext.domainEntities, ["users", "restaurants"]);
  assert.deepEqual(handoff.sharedScenarioContext.applicableScaleAssumptions, [{ value: correctedScale, sourceTurnId: scale.id }]);
  assert.deepEqual(handoff.sharedScenarioContext.sharedRequirements, [`${correctedRequirement} [source=${requirement.id}]`]);
  assert.deepEqual(effectiveTurns[0], { ...scale, text: correctedScale });
  assert.deepEqual(f.manager.getState(), before);
  assert.deepEqual(parent, parentBefore);
});

test("handoff missing effective parent text cannot revive canonical topic semantics", () => {
  const f = fixture();
  const parent = { ...f.parent, topic: "A ride sharing service for drivers." };
  for (const parentSourceQuestion of [undefined, ""]) {
    const result = buildBoundedParentContextHandoff({ parent, parentSourceQuestion,
      sourceQuestionId: "handoff-question", latestQuestionText: "Extend the same service.", transcriptTurns: [] });
    assert.equal(result.sourceParentId, parent.id);
    assert.equal(result.sharedScenarioContext.productIdentity, undefined);
    assert.equal(result.sharedScenarioContext.domainEntities, undefined);
  }
  assert.equal(parent.topic, "A ride sharing service for drivers.");
});

test("EC3 explicit empty origin selection returns no text for ledger or current LQU", () => {
  const f = fixture();
  for (const logicalQuestionUnit of [undefined, f.corrected]) {
    const input = {
      effectiveRecords: f.ledger.listHistory(), logicalQuestionUnit,
      activeMeetingTask: f.manager.getState().activeMeetingTask,
      sessionId: f.original.sessionId, runtimeEpoch: 1,
    };
    const origin = {
      ...input, recordIndex: indexAuthorizedEffectiveSourceRecords(input),
      logicalQuestionUnitId: f.original.id, sourceTurnIds: [f.root.id],
      owner: { kind: "parent-mainline" as const, parentId: f.parent.id },
    };
    assert.match(readAuthorizedEffectiveSourceText(origin).text ?? "", /multi-tenant RAG/);
    assert.deepEqual(readAuthorizedEffectiveSourceText({ ...origin, selectedSourceTurnIds: [] }), {
      text: undefined, sourceTurnIds: [], missingSourceTurnIds: [], rejectedSourceTurnIds: [],
    });
  }
});

test("EC3 child origin keeps full lookup identity but returns only its selected effective span", () => {
  const f = fixture();
  const first = turn("child-private", "RAC private implementation details.", 2_000);
  const second = turn("child-public", "RAC public API surface.", 3_000);
  [first, second].forEach((source) => f.manager.addTranscriptTurn(source));
  const sourceTurnIds = [first.id, second.id];
  const grouped = {
    ...f.unit(first), currentTurnId: second.id, sourceTurnIds,
    sources: [first, second].map((source) => ({
      turnId: source.id, text: source.text, startedAt: source.startedAt, endedAt: source.endedAt,
    })),
    normalizedText: `${first.text} ${second.text}`, updatedAt: second.endedAt,
  };
  const corrected = applyActiveQuestionTermCorrection({
    logicalQuestionUnit: grouped,
    correction: { id: "child-RAC-RAG", input: "RAG not RAC", term: "RAG", from: "RAC", to: "RAG", createdAt: 4_000, appliedCount: 0 },
    correctionTraceId: "child-correction", manualCorrectionRevision: 1, now: 4_000,
  }).logicalQuestionUnit;
  const owner = { kind: "active-child" as const, parentId: f.parent.id, childId: "child-partial" };
  setTestTaskRuntime(f.manager, { parent: { ...f.parent, revisions: 2, child: {
    id: owner.childId, questionType: "coding", relation: "child-probe", intent: "implementation-probe",
    question: grouped.normalizedText, basedOnTurnIds: sourceTurnIds, basedOnObservationIds: [],
    createdAt: first.startedAt, updatedAt: second.endedAt,
  } } });
  f.remember(corrected, { owner, relation: "child-probe" });
  const input = {
    effectiveRecords: f.ledger.listHistory(), activeMeetingTask: f.manager.getState().activeMeetingTask,
    sessionId: grouped.sessionId, runtimeEpoch: 1,
  };
  const origin = { ...input, recordIndex: indexAuthorizedEffectiveSourceRecords(input), sourceTurnIds, owner };
  assert.match(readAuthorizedEffectiveSourceText(origin).text ?? "", /RAG private implementation details.*RAG public API surface/s);
  const selected = readAuthorizedEffectiveSourceText({ ...origin, selectedSourceTurnIds: [second.id] });
  assert.deepEqual(selected, {
    text: "RAG public API surface.", sourceTurnIds: [second.id], missingSourceTurnIds: [], rejectedSourceTurnIds: [],
  });
  assert.deepEqual(sourceTurnIds, [first.id, second.id]);
  assert.equal(f.manager.getState().transcriptTurns.find((source) => source.id === first.id)?.text, first.text);
});

test("EC5 Screen parent with empty canonical turn IDs retains its authorized origin on Voice follow-up", () => {
  const manager = new MeetingContextManager();
  const ledger = new EffectiveQuestionSourceLedger();
  const observationId = "screen_so2_origin";
  const screenText = "Implement an LRU cache with get and put operations.";
  const sessionId = manager.getState().sessionId;
  const screenUnit: LogicalQuestionUnit = {
    id: `screen-answer-sufficiency:${observationId}`, revision: 1, sessionId, runtimeEpoch: 1,
    currentTurnId: `screen:${observationId}`, sourceTurnIds: [],
    sources: [{ turnId: `screen:${observationId}`, text: screenText, startedAt: 1_000, endedAt: 1_100 }],
    normalizedText: screenText, startedAt: 1_000, updatedAt: 1_100,
    compositionReasons: ["no-previous-logical-question"], boundaryReason: "no-previous-logical-question", truncated: false,
  };
  manager.addScreenObservation({
    id: observationId, capturedAt: 1_000, visualSummary: screenText,
    imageBase64: "screen-image-fixture", source: "hotkey", changed: true,
  });
  const parent: ActiveInterviewParent = {
    id: "screen-parent", source: "screen", stableKind: "coding", topic: screenText,
    canonicalQuestionSourceTurnIds: [], sourceQuestionUnitId: screenUnit.id, sourceQuestionRevision: 1,
    startObservationId: observationId, latestScreenObservationId: observationId,
    playbookPhase: "implementation_validation", phaseProgress: {}, supportedFactAnchors: [],
    createdAt: 1_000, updatedAt: 1_100, revisions: 1,
  };
  setTestTaskRuntime(manager, { parent, screenAttachment: {
    id: "screen-task", observationId, basedOnObservationId: observationId, basedOnTurnIds: [],
    createdAt: 1_000, updatedAt: 1_100, kind: "coding", question: screenText, content: "Visible get/put signatures.",
  } });
  const source = createProvisionalCurrentQuestion({ logicalQuestionUnit: screenUnit, sourceKind: "screen" });
  const projection = projectEffectiveLogicalQuestionSources(screenUnit);
  ledger.upsert({
    recordId: "screen-origin-record", sessionId, runtimeEpoch: 1,
    logicalQuestionUnitId: screenUnit.id, logicalQuestionRevision: 1, sourceHash: source.sourceHash,
    sourceKind: "screen", currentTurnId: screenUnit.currentTurnId, sourceTurnIds: [], sourceObservationIds: [observationId],
    text: projection.effectiveText, answerFocusText: projection.answerFocusText, effectiveSourceTexts: projection.effectiveSourceTexts,
    startedAt: screenUnit.startedAt, updatedAt: screenUnit.updatedAt, settledAt: 1_200,
    speechAct: "question", disposition: "answer-primary-ask", relation: "new-parent",
    owner: { kind: "parent-mainline", parentId: parent.id },
  });
  const voice = turn("voice-followup", "How should get update recency?", 2_000);
  manager.addTranscriptTurn(voice);
  const voiceUnit = composeLogicalQuestionUnit({ currentTurn: voice, sessionId, runtimeEpoch: 1, now: voice.endedAt });
  const before = manager.getState();
  const recordIndex = indexAuthorizedEffectiveSourceRecords({
    effectiveRecords: ledger.listHistory(), sessionId, runtimeEpoch: 1, activeMeetingTask: before.activeMeetingTask,
  });
  assert.equal(readAuthorizedEffectiveSourceText({
    recordIndex, sessionId, runtimeEpoch: 1, logicalQuestionUnitId: screenUnit.id,
    sourceTurnIds: [], sourceObservationIds: [observationId], owner: { kind: "parent-mainline", parentId: parent.id },
  }).text, screenText);
  assert.deepEqual(before.transcriptTurns.map((source) => source.id), [voice.id]);
  const compiled = compileSettledAdvisorPromptContext({
    baseContext: manager.buildAdvisorPromptContext(), contextReadScope: "active-parent-read",
    logicalQuestionUnit: voiceUnit, transcriptTurns: before.transcriptTurns,
    effectiveRecords: ledger.listHistory(), sessionId, runtimeEpoch: 1,
    screenScopeDecision: { action: "keep", reason: "existing-task-continuity" },
  });
  assert.deepEqual(compiled.selectedSourceTurnIds, [screenUnit.currentTurnId, voice.id]);
  assert.equal(compiled.context.activeMeetingTask?.parent.topic, screenText);
  assert.deepEqual(compiled.context.activeMeetingTask?.parent.canonicalQuestionSourceTurnIds, []);
  assert.match(compiled.context.transcript, /^Screen: Implement an LRU cache.*\nThem: How should get update recency\?$/);
  assert.ok(compiled.context.screenContext.includes(screenText));
  assert.equal(compiled.screenContextReason, "settled-screen-scope-keep");
  assert.equal(compiled.context.latestTurn?.id, voice.id);
  assert.match(buildAdvisorUserMessage(compiled.context), /Implement an LRU cache with get and put operations/);
  assert.deepEqual(manager.getState(), before);
});
