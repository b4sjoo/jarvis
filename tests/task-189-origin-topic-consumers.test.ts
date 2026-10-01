import type { AdvisorPromptContext } from "../src/lib/meeting/meeting-context-contracts.js";
import assert from "node:assert/strict";
import test from "node:test";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import {
  composeLogicalQuestionUnit,
  type LogicalQuestionUnit,
} from "../src/lib/meeting/logical-question-unit.js";
import { applyActiveQuestionTermCorrection } from "../src/lib/meeting/active-question-term-correction.js";
import { createProvisionalCurrentQuestion } from "../src/lib/meeting/current-question-settlement.js";
import {
  EffectiveQuestionSourceLedger,
  type EffectiveQuestionSourceRecord,
} from "../src/lib/meeting/effective-question-source-ledger.js";
import {
  projectEffectiveLogicalQuestionSources,
} from "../src/lib/meeting/logical-question-effective-projection.js";
import {
  buildQuestionTypeAdjudicationRequest,
  buildQuestionTypeAdjudicationPrompts,
} from "../src/lib/meeting/question-type-adjudication.js";
import {
  buildTaskRelationAffinityRequests,
  buildTaskRelationCanonicalShadowRequest,
} from "../src/lib/meeting/task-relation-split-shadow.js";
import { buildAdvisorEvidencePacket } from "../src/lib/meeting/advisor-evidence-packet.js";
import { compileSettledAdvisorPromptContext } from "../src/lib/meeting/settled-advisor-context.js";
import { buildAdvisorUserMessage } from "../src/lib/meeting/advisor-prompt.js";
import { composePhaseNavigationPromptContext } from "../src/lib/meeting/phase-navigation-prompt-context.js";
import { decideAdvisorScreenScope } from "../src/lib/meeting/screen-task-scope.js";
import { selectInterviewPlaybookForCommittedType } from "../src/lib/meeting/interview-playbook.js";
import { projectEffectiveTaskSourceView } from "../src/lib/meeting/effective-task-source-view.js";
import { setTestTaskRuntime } from "./helpers/meeting-task-runtime.js";
import {
  buildTopicIntentInput,
  buildTopicRelationRequest,
  buildTopicSemanticContext,
  createTopicBaseBuilder,
  topicHookFunction,
} from "./helpers/task-189-topic-hook.js";
import type { ActiveInterviewParent, TranscriptTurn } from "../src/lib/meeting/types.js";

function turn(id: string, text: string, at: number): TranscriptTurn {
  return { id, text, speaker: "them", source: "system-audio", startedAt: at, endedAt: at + 100, isFinal: true };
}

function fixture() {
  const manager = new MeetingContextManager();
  const ledger = new EffectiveQuestionSourceLedger();
  const root = turn("parent-origin", "Design a RAC retrieval system with tenant isolation.", 1_000);
  const child = turn("child-origin", "Implement a KAC cache invalidation function.", 2_000);
  const followup = turn("followup", "Explain failure handling for this component.", 3_000);
  [root, child, followup].forEach((source) => manager.addTranscriptTurn(source));
  const unit = (source: TranscriptTurn) => composeLogicalQuestionUnit({ currentTurn: source, sessionId: manager.getState().sessionId, runtimeEpoch: 1, now: source.endedAt });
  const correct = (original: LogicalQuestionUnit, from: string, to: string) => applyActiveQuestionTermCorrection({
    logicalQuestionUnit: original,
    correction: { id: `${from}-${to}`, input: `${to} not ${from}`, term: to, from, to, createdAt: 4_000, appliedCount: 0 },
    correctionTraceId: `trace-${from}`, manualCorrectionRevision: 1, now: 4_000,
  }).logicalQuestionUnit;
  const original = unit(root);
  const corrected = correct(original, "RAC", "RAG");
  const childOriginal = unit(child);
  const childCorrected = correct(childOriginal, "KAC", "LRU");
  const playbook = selectInterviewPlaybookForCommittedType({ questionType: "ai-ml-system-design", query: root.text }).playbook;
  assert.ok(playbook);
  const now = Date.now();
  const parent: ActiveInterviewParent = {
    id: "parent", source: "voice", stableKind: "ai-ml-system-design", topic: root.text,
    sourceQuestionUnitId: original.id, sourceQuestionRevision: original.revision,
    canonicalQuestionSourceTurnIds: [root.id], startTurnId: root.id,
    playbook, playbookPhase: playbook.phase, phaseProgress: {}, supportedFactAnchors: [],
    createdAt: now, updatedAt: now, revisions: 1,
    child: {
      id: "child", questionType: "coding", relation: "child-probe", intent: "implementation-probe", question: child.text,
      basedOnTurnIds: [child.id], basedOnObservationIds: [], createdAt: now, updatedAt: now,
    },
  };
  setTestTaskRuntime(manager, { parent });
  function remember(lqu: LogicalQuestionUnit, childOwner = false) {
    const source = createProvisionalCurrentQuestion({ logicalQuestionUnit: lqu, sourceKind: "voice" });
    const projected = projectEffectiveLogicalQuestionSources(lqu);
    const record: EffectiveQuestionSourceRecord = {
      recordId: `${lqu.id}:${lqu.revision}`, sessionId: lqu.sessionId, runtimeEpoch: lqu.runtimeEpoch,
      logicalQuestionUnitId: lqu.id, logicalQuestionRevision: lqu.revision, sourceHash: source.sourceHash,
      sourceKind: "voice", currentTurnId: lqu.currentTurnId, sourceTurnIds: [...lqu.sourceTurnIds],
      text: projected.effectiveText, answerFocusText: projected.answerFocusText,
      effectiveSourceTexts: projected.effectiveSourceTexts, correctionIds: projected.correctionIds,
      startedAt: lqu.startedAt, updatedAt: lqu.updatedAt, settledAt: lqu.updatedAt,
      speechAct: "question", disposition: "answer-primary-ask", relation: childOwner ? "child-probe" : "followup-parent",
      owner: childOwner ? { kind: "active-child", parentId: parent.id, childId: "child" } : { kind: "parent-mainline", parentId: parent.id },
    };
    ledger.upsert(record);
    return record;
  }
  remember(original);
  remember(corrected);
  remember(childOriginal, true);
  remember(childCorrected, true);
  remember(unit(followup));
  return { manager, ledger, root, child, followup, original, corrected, childCorrected, unit, remember };
}

test("EC4 Type production factory keeps corrected source and never invents parent-topic authority", () => {
  const f = fixture();
  const before = f.manager.getState();
  for (const unit of [f.corrected, f.childCorrected]) {
    const request = buildQuestionTypeAdjudicationRequest({ logicalQuestionUnit: unit });
    const prompts = buildQuestionTypeAdjudicationPrompts(request);
    assert.match(JSON.stringify(prompts), unit === f.corrected ? /RAG retrieval/ : /LRU cache/);
    assert.doesNotMatch(JSON.stringify(prompts), /RAC|KAC/);
    assert.equal(request.logicalQuestionUnitRevision, unit.revision);
  }
  assert.deepEqual(f.manager.getState(), before);
});

test("EC4 Relation production factory and split payloads use each corrected origin, not latest follow-up", () => {
  const f = fixture();
  const before = f.manager.getState();
  const current = f.unit(f.followup);
  const request = buildTopicRelationRequest(f.manager, f.ledger, current);
  assert.ok(request.recentParentEvidence.some((source) => source.text.includes("RAG")), "latest owner evidence must already be correct before topic assertion");
  assert.match(request.activeParent.topic, /Design a RAG retrieval system with tenant isolation/);
  assert.match(request.activeChild?.question ?? "", /Implement a LRU cache invalidation function/);
  assert.doesNotMatch(request.activeParent.topic, /failure handling|LRU cache|RAC/);
  const splitInput = { request, sessionId: before.sessionId, runtimeEpoch: 1, manualCorrectionRevision: 1 };
  for (const payload of [buildTaskRelationAffinityRequests(splitInput), buildTaskRelationCanonicalShadowRequest(splitInput)]) {
    assert.doesNotMatch(JSON.stringify(payload), /RAC|KAC/);
    assert.match(JSON.stringify(payload), /RAG retrieval/);
  }
  assert.deepEqual(f.manager.getState(), before);
});

function advisor(f: ReturnType<typeof fixture>) {
  const current = f.unit(f.followup);
  const base = createTopicBaseBuilder(f.manager, f.ledger)(current);
  const semantic = buildTopicSemanticContext(f.manager, f.ledger, base, current);
  base.advisorEvidencePacket = buildAdvisorEvidencePacket({ activeMeetingTask: semantic.activeMeetingTask });
  const compiled = compileSettledAdvisorPromptContext({ baseContext: base, contextReadScope: "active-child-read", logicalQuestionUnit: current,
    transcriptTurns: f.manager.getState().transcriptTurns, effectiveRecords: f.ledger.list(), sessionId: current.sessionId, runtimeEpoch: 1,
    screenScopeDecision: decideAdvisorScreenScope({ triggerSource: "live-turn", relation: "child-probe", hasActiveScreenTask: Boolean(base.activeMeetingTask?.screen) }) });
  return { base, semantic, compiled, prompt: buildAdvisorUserMessage(compiled.context) };
}

test("EC4 Advisor actual Hook semantic view and final formatter share corrected origins while base stays canonical", () => {
  const f = fixture();
  const before = f.manager.getState();
  const { base, semantic, compiled, prompt } = advisor(f);
  assert.match(compiled.context.transcript, /RAG retrieval/);
  assert.match(compiled.context.transcript, /LRU cache/);
  assert.doesNotMatch(prompt, /RAC|KAC/, "correct transcript must not coexist with stale active-task or continuity topics");
  assert.match(semantic.activeMeetingTask?.parent.topic ?? "", /Design a RAG retrieval system with tenant isolation/);
  assert.match(semantic.activeMeetingTask?.child?.question ?? "", /Implement a LRU cache invalidation function/);
  assert.doesNotMatch(semantic.activeMeetingTask?.parent.topic ?? "", /failure handling|LRU cache/);
  assert.equal(base.activeMeetingTask?.parent.topic, before.activeMeetingTask?.parent.topic);
  assert.equal(base.taskRuntime.parent?.topic, before.taskRuntime.parent?.topic);
  assert.deepEqual(f.manager.getState(), before);
});

test("EC4 phase and actual Hook query/intent formatters consume the same origin projection", () => {
  const f = fixture();
  const { semantic, compiled } = advisor(f);
  const query = topicHookFunction<(context: AdvisorPromptContext) => string>("formatAdvisorActiveTaskForQuery")(semantic);
  const intent = buildTopicIntentInput(f.manager, f.ledger, f.unit(f.followup));
  const phase = composePhaseNavigationPromptContext({ action: "next-phase", promptContext: compiled.context });
  for (const text of [query, intent, buildAdvisorUserMessage(phase.promptContext)]) {
    assert.doesNotMatch(text, /RAC|KAC/);
    assert.match(text, /RAG retrieval/);
  }
});

test("EC4/EC6 reads preserve canonical topic, source IDs, revisions, deadlines and immutable raw turns", () => {
  const f = fixture();
  const before = f.manager.getState();
  const history = f.ledger.listHistory();
  advisor(f);
  assert.deepEqual(f.manager.getState(), before);
  assert.deepEqual(f.ledger.listHistory(), history);
  assert.equal(before.taskRuntime.parent?.topic, f.root.text);
  assert.equal(before.taskRuntime.parent?.child?.question, f.child.text);
  assert.match(f.original.sources[0].text, /RAC/);
});

test("EC4 evidence packet continuity uses projected origin without mutating the parent", () => {
  const f = fixture();
  const before = f.manager.getState();
  const { semantic } = advisor(f);
  const current = f.unit(f.followup);
  const packet = buildAdvisorEvidencePacket({ activeMeetingTask: semantic.activeMeetingTask,
    currentQuestion: { source: "voice-lqu", text: current.normalizedText, sourceTurnIds: current.sourceTurnIds } });
  const text = packet.continuity?.capsule ?? "";
  assert.match(text, /RAG retrieval/);
  assert.doesNotMatch(text, /RAC|KAC|failure handling/);
  assert.equal(packet.continuity?.parentTaskId, semantic.activeMeetingTask?.parent.id);
  assert.deepEqual(f.manager.getState(), before);
});

function screenFixture(literalQuestion?: string) {
  const f = fixture();
  const now = Date.now();
  f.manager.addScreenObservation({ id: "screen-origin", capturedAt: now, imageBase64: "private-image", visualSummary: "The retrieval architecture", source: "hotkey", changed: true });
  setTestTaskRuntime(f.manager, { screenAttachment: {
    id: "screen-task", observationId: "screen-origin", basedOnObservationId: "screen-origin", basedOnTurnIds: [f.root.id],
    createdAt: now, updatedAt: now, kind: "ai-ml-system-design", question: literalQuestion ?? f.root.text, content: "",
  } });
  for (const record of f.ledger.listHistory().filter((record) => record.logicalQuestionUnitId === f.original.id)) {
    f.ledger.upsert({ ...record, sourceKind: "mixed", sourceObservationIds: ["screen-origin"] });
  }
  return f;
}

test("EC4 Screen owner alias is projected only for semantic reads while canonical base stays raw", () => {
  const f = screenFixture();
  const before = f.manager.getState();
  const { base, compiled, prompt } = advisor(f);
  assert.equal(base.taskRuntime.parent?.topic, f.root.text);
  assert.equal(base.activeMeetingTask?.parent.topic, f.root.text);
  assert.equal(base.activeMeetingTask?.screen?.question, f.root.text);
  assert.doesNotMatch(base.screenContext, /^(?:Topic|Screen question):/m);
  assert.doesNotMatch(base.screenContext, /RAC|RAG/);
  assert.doesNotMatch(compiled.context.screenContext, /^(?:Topic|Screen question):/m);
  assert.match(compiled.context.screenContext, /The retrieval architecture/);
  assert.match(compiled.context.activeMeetingTask?.parent.topic ?? "", /RAG retrieval/);
  assert.match(prompt, /- Topic: Design a RAG retrieval/);
  assert.doesNotMatch(prompt, /^(?:- Topic: |Current parent topic: |parent task: |Source-owned objective: ).*\bRAC\b/m);
  assert.doesNotMatch(prompt, /KAC/);
  assert.equal(base.activeMeetingTask?.screen?.observationId, "screen-origin");
  assert.match(compiled.context.activeMeetingTask?.screen?.question ?? "", /RAG retrieval/);
  assert.deepEqual(f.manager.getState().screenObservations, before.screenObservations);
  assert.deepEqual(f.manager.getState(), before);
});

test("EC4 independently captured Screen question remains literal instead of following parent correction", () => {
  const literal = "Captured chart: explain the RAC indexing labels and their arrows.";
  const f = screenFixture(literal);
  const before = f.manager.getState();
  const { base, compiled, prompt } = advisor(f);
  assert.equal(base.activeMeetingTask?.parent.topic, f.root.text);
  assert.equal(base.taskRuntime.parent?.topic, f.root.text);
  assert.equal(base.activeMeetingTask?.screen?.question, literal);
  assert.equal(compiled.context.activeMeetingTask?.screen?.question, literal);
  assert.doesNotMatch(base.screenContext, /^(?:Topic|Screen question):/m);
  assert.doesNotMatch(base.screenContext, /RAC|RAG/);
  assert.doesNotMatch(compiled.context.screenContext, /^(?:Topic|Screen question):/m);
  assert.match(compiled.context.screenContext, /The retrieval architecture/);
  assert.match(compiled.context.activeMeetingTask?.parent.topic ?? "", /RAG retrieval/);
  assert.match(prompt, /- Topic: Design a RAG retrieval/);
  assert.deepEqual(f.manager.getState().screenObservations, before.screenObservations);
  assert.deepEqual(f.manager.getState(), before);
});

for (const origin of ["parent", "child"] as const) {
  test(`EC2/EC4 latest ${origin} origin transferred to another owner cannot revive old topic`, () => {
    const f = fixture();
    const unit = origin === "parent" ? f.corrected : f.childCorrected;
    const record = f.remember({ ...unit, revision: unit.revision + 1 }, origin === "child");
    f.ledger.upsert({ ...record, owner: { kind: "parent-mainline", parentId: "exited-owner" } });
    const before = f.manager.getState();
    const request = buildTopicRelationRequest(f.manager, f.ledger, f.unit(f.followup));
    assert.equal(origin === "parent" ? request.activeParent.topic : request.activeChild?.question, "");
    assert.match(origin === "parent" ? request.activeChild!.question : request.activeParent.topic, origin === "parent" ? /LRU cache/ : /RAG retrieval/);
    assert.doesNotMatch(JSON.stringify(request), /RAC|KAC/);
    assert.deepEqual(f.manager.getState(), before);
  });
}

test("EC4/EC7 missing origin is explicit and cannot fall back to canonical topic or a newer follow-up", () => {
  const f = fixture();
  f.ledger.clear();
  f.remember(f.unit(f.followup));
  const before = f.manager.getState();
  const projected = projectEffectiveTaskSourceView({ task: before.activeMeetingTask, records: f.ledger.list(),
    sessionId: before.sessionId, runtimeEpoch: 1, logicalQuestionUnit: f.unit(f.followup) });
  assert.equal(projected.task?.parent.topic, "");
  assert.equal(projected.task?.child?.question, "");
  assert.deepEqual(new Set(projected.missingSourceTurnIds), new Set([f.root.id, f.child.id]));
  assert.deepEqual(f.manager.getState(), before);
});

test("EC3/EC4 provisional current origin correction can project before any ledger admission", () => {
  const f = fixture();
  f.ledger.clear();
  const before = f.manager.getState();
  const request = buildTopicRelationRequest(f.manager, f.ledger, f.corrected);
  assert.match(request.activeParent.topic, /RAG retrieval/);
  assert.doesNotMatch(request.activeParent.topic, /RAC|failure handling/);
  assert.equal(f.ledger.listHistory().length, 0);
  assert.deepEqual(f.manager.getState(), before);
});
