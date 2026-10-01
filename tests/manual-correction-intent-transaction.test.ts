import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { buildActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import { createProvisionalCurrentQuestion, settleCurrentQuestion } from "../src/lib/meeting/current-question-settlement.js";
import { consumeRevisionStableTopologyBinding, createEffectiveQuestionSourceRecord, EffectiveQuestionSourceLedger, resolveRevisionStableTopologyBinding, selectOwnerScopedRelationEvidence } from "../src/lib/meeting/effective-question-source-ledger.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import { selectInterviewPlaybook } from "../src/lib/meeting/interview-playbook.js";
import { getManualCorrectionCapabilities, type ManualCorrectionCapabilityContext, type ManualCorrectionIntent } from "../src/lib/meeting/manual-correction-intent.js";
import { prepareManualCorrectionIntentTransition } from "../src/lib/meeting/manual-correction-transition.js";
import { settleManualQuestionTypeCorrection } from "../src/lib/meeting/manual-correction-settlement.js";
import { decideManualCorrectionTerminalState } from "../src/lib/meeting/manual-question-type-correction.js";
import { buildEffectiveAdvisorSettlementView, buildSettledAdvisorExecutionPlan } from "../src/lib/meeting/settled-advisor-execution-plan.js";
import { createTestPlannedTransition, commitTestPlannedTransition } from "./helpers/planned-task-runtime-commit.js";
import type { CanonicalQuestionType } from "../src/lib/meeting/task-taxonomy.js";
import type { ActiveInterviewParent, ScreenObservation } from "../src/lib/meeting/types.js";

const sessionId = "manual-intent-session";
const epoch = 2;
const providers = { providers: [], selectedProvider: { provider: "unused", variables: {} }, codingProvider: { provider: "unused", variables: {} } };

function question(id: string, at = 10): LogicalQuestionUnit {
  const text = `Explain the architecture and tradeoffs for ${id}.`;
  return { id, revision: 1, sessionId, runtimeEpoch: epoch, currentTurnId: `turn:${id}`,
    sourceTurnIds: [`turn:${id}`], sources: [{ turnId: `turn:${id}`, text, startedAt: at, endedAt: at + 1 }],
    normalizedText: text, startedAt: at, updatedAt: at + 1,
    compositionReasons: ["fresh-substantive-turn"], boundaryReason: "fresh-substantive-turn", truncated: false };
}

function parent(id: string, unit: LogicalQuestionUnit, type: ActiveInterviewParent["stableKind"] = "ai-ml-system-design"): ActiveInterviewParent {
  return { id, source: "voice", stableKind: type, topic: unit.normalizedText,
    originQuestionId: `lqu:${unit.id}`, sourceQuestionUnitId: unit.id, sourceQuestionRevision: unit.revision,
    startTurnId: unit.currentTurnId, promptTranscriptStartTurnId: unit.currentTurnId,
    canonicalQuestionSourceTurnIds: [...unit.sourceTurnIds], playbookPhase: "design_framing",
    phaseProgress: { design_framing: true }, supportedFactAnchors: ["a-source-anchor"],
    createdAt: 10, updatedAt: 10, revisions: 1 };
}

function fixture(maxEntries = 96) {
  const manager = new MeetingContextManager();
  manager.reset({ sessionId });
  const ledger = new EffectiveQuestionSourceLedger(maxEntries);
  manager.setEffectiveQuestionSourceLedger(ledger);
  const origin = question("A-origin");
  const a = parent("A", origin);
  const installed = manager.commitTaskRuntimeTransition({ id: "create-A", transition: "create-parent", parent: a, reason: "fixture" });
  assert.equal(installed.mutationApplied, true);
  admit(manager, ledger, origin, "new-parent");
  return { manager, ledger, origin, a };
}

function admit(manager: MeetingContextManager, ledger: EffectiveQuestionSourceLedger, unit: LogicalQuestionUnit,
  relation: "new-parent" | "followup-parent" | "child-probe" = "followup-parent",
  sourceInput: { sourceKind: "voice" | "screen" | "mixed"; sourceObservationIds?: string[] } = { sourceKind: "voice" }) {
  const runtime = manager.getTaskRuntimeState();
  const task = buildActiveMeetingTask({ parent: runtime.parent, runtimeRevision: runtime.revision })!;
  const currentQuestion = createProvisionalCurrentQuestion({ logicalQuestionUnit: unit, ...sourceInput });
  const type = task.child?.questionType ?? task.parent.questionType;
  const settlement = settleCurrentQuestion({ operationId: `settle-${unit.id}`, currentQuestion,
    activeParentId: task.parent.id, activeParentRevision: task.parent.revisions, manualCorrectionRevision: 0,
    deterministicProposal: { source: "deterministic-fast-path", sessionId, runtimeEpoch: epoch,
      logicalQuestionUnitId: unit.id, revision: unit.revision, sourceHash: currentQuestion.sourceHash,
      questionType: type, relation, action: "answer", confidence: 1,
      typeEvidenceAuthorized: true, relationEvidenceAuthorized: true, actionEvidenceAuthorized: true,
      expectedParentId: task.parent.id, expectedParentRevision: task.parent.revisions },
    policy: { runtimeMutationAuthorized: true, questionComplete: true, commitParent: true } });
  const effectiveSettlement = buildEffectiveAdvisorSettlementView({ settlement, activeMeetingTask: task,
    taskRuntimeRevision: runtime.revision, fallback: { questionType: type, relation } }).effectiveSettlement!;
  const record = createEffectiveQuestionSourceRecord({ logicalQuestionUnit: unit, settlement: effectiveSettlement, activeMeetingTask: task, settledAt: unit.updatedAt })!;
  ledger.upsert(record);
  assert.equal(manager.recordTaskQuestionAdmission({ sessionId, parentId: task.parent.id,
    childId: relation === "child-probe" ? task.child?.id : undefined, logicalQuestionUnitId: unit.id }), true);
  return record;
}

function context(manager: MeetingContextManager, ledger: EffectiveQuestionSourceLedger, unit: LogicalQuestionUnit,
  currentEpoch = epoch): ManualCorrectionCapabilityContext {
  const runtime = manager.getTaskRuntimeState();
  const source = ledger.findLogicalQuestion({ sessionId, runtimeEpoch: currentEpoch, logicalQuestionUnitId: unit.id, logicalQuestionRevision: unit.revision });
  const currentQuestion = createProvisionalCurrentQuestion({ logicalQuestionUnit: unit,
    sourceKind: source?.sourceKind ?? "voice", sourceObservationIds: source?.sourceObservationIds });
  return { currentSessionId: sessionId, currentRuntimeEpoch: currentEpoch, currentQuestion, runtime, source, manualCorrectionRevision: 1,
    target: { sessionId, runtimeEpoch: currentEpoch, logicalQuestionUnitId: unit.id, logicalQuestionRevision: unit.revision,
      sourceHash: currentQuestion.sourceHash, manualCorrectionRevision: 1, taskRuntimeRevision: runtime.revision, owner: source?.owner },
    admission: manager.getManualCorrectionAdmission(), recentParent: manager.getRecentManualCorrectionParent(),
    recentParentSources: manager.getRecentManualCorrectionSources(currentEpoch) };
}

function option(ctx: ManualCorrectionCapabilityContext, type: CanonicalQuestionType, kind: ManualCorrectionIntent["kind"]) {
  const selected = getManualCorrectionCapabilities(ctx, type).options.find(item => item.id === kind);
  assert.ok(selected, `missing ${kind}`);
  return selected;
}

function prepare(manager: MeetingContextManager, ledger: EffectiveQuestionSourceLedger, unit: LogicalQuestionUnit,
  type: CanonicalQuestionType, kind: ManualCorrectionIntent["kind"], operationId = `manual-${kind}`) {
  const ctx = context(manager, ledger, unit);
  const selected = option(ctx, type, kind);
  const correctedPlaybook = type === "coding" ? selectInterviewPlaybook({ questionType: type, query: unit.normalizedText }) : undefined;
  const proposal = prepareManualCorrectionIntentTransition({ operationId, context: ctx, correctedType: type,
    intent: selected.intent, correctedPlaybook, newParentId: `${operationId}-parent`, now: 100 });
  if (!proposal.authorized) throw new Error(proposal.reason);
  const before = buildActiveMeetingTask({ parent: ctx.runtime.parent, screenAttachment: ctx.runtime.screenAttachment, runtimeRevision: ctx.runtime.revision });
  const plan = buildSettledAdvisorExecutionPlan({ settlement: proposal.settlement,
    activeMeetingTask: proposal.activeMeetingTask, expectedActiveMeetingTask: before,
    preBoundaryQuestionType: ctx.runtime.parent?.stableKind, taskBoundaryCommitted: false,
    childOwnsResponse: proposal.receipt.relation === "child-probe", providerSnapshot: providers,
    sourceQuestion: unit.normalizedText, explicitTaskMutationCommand: proposal.command,
    memoryUseCase: "aiml_system_design_interview", askFrame: "hypothetical-design", topicDomain: "ai-ml-infra" });
  const reduction = commitTestPlannedTransition({ transaction: createTestPlannedTransition({ plan,
    manualCorrectionRevision: 1, proposedActiveInterviewTask: proposal.parent, proposedActiveScreenTask: null }),
    currentSessionId: sessionId, currentRuntimeEpoch: epoch, currentLogicalQuestionUnitId: unit.id,
    currentLogicalQuestionRevision: unit.revision, currentManualCorrectionRevision: 1,
    currentTaskRuntimeRevision: ctx.runtime.revision, currentActiveInterviewTask: ctx.runtime.parent,
    currentActiveScreenTask: ctx.runtime.screenAttachment });
  assert.equal(reduction.authorized, true, reduction.reason);
  const sourceOwnerCorrection = ctx.source ? ledger.prepareOwnerCorrection({ operationId, sessionId, runtimeEpoch: epoch,
    logicalQuestionUnitId: unit.id, logicalQuestionRevision: unit.revision, sourceHash: ctx.source.sourceHash,
    expectedOwner: ctx.source.owner,
    nextOwner: proposal.receipt.relation === "child-probe"
      ? { kind: "active-child", parentId: proposal.parent.id, childId: proposal.parent.child!.id }
      : { kind: "parent-mainline", parentId: proposal.parent.id },
    relation: proposal.receipt.relation as "new-parent" | "followup-parent" | "resume-parent" | "child-probe",
    restoredParentId: kind === "merge-recent-parent" ? proposal.parent.id : undefined,
    availableObservationIds: manager.getState().screenObservations.filter(item => !!item.imageBase64).map(item => item.id), now: 100 }) : undefined;
  if (ctx.source) assert.ok(sourceOwnerCorrection);
  const transaction = manager.prepareTaskRuntimeTransition({ id: operationId, transition: proposal.transition,
    parent: proposal.parent, screenAttachment: null, expectedRevision: ctx.runtime.revision, reason: `manual:${kind}`,
    sourceOwnerCorrection, recentParentToRestore: kind === "merge-recent-parent" ? proposal.parent.id : undefined });
  return { transaction, proposal, plan, ctx };
}

function commit(manager: MeetingContextManager, ledger: EffectiveQuestionSourceLedger, unit: LogicalQuestionUnit,
  type: CanonicalQuestionType, kind: ManualCorrectionIntent["kind"], operationId?: string) {
  const prepared = prepare(manager, ledger, unit, type, kind, operationId);
  const result = manager.commitPreparedTaskRuntimeTransition(prepared.transaction);
  assert.equal(result.authorized, true, result.reason);
  assert.equal(result.mutationApplied, true);
  const next = result.state.parent!;
  manager.recordTaskQuestionAdmission({ sessionId, parentId: next.id,
    childId: prepared.proposal.receipt.relation === "child-probe" ? next.child?.id : undefined, logicalQuestionUnitId: unit.id });
  return { ...prepared, result };
}

test("MC1: a real ledger followup binding cannot override an admitted child or explicit intent", () => {
  const { manager, ledger } = fixture();
  const q = question("HNSW", 20);
  admit(manager, ledger, q);
  const ctx = context(manager, ledger, q);
  const binding = resolveRevisionStableTopologyBinding({ records: ledger.listHistory(), logicalQuestionUnit: q,
    activeMeetingTask: manager.getState().activeMeetingTask })!;
  assert.equal(binding.relation, "followup-parent");
  const correction = settleManualQuestionTypeCorrection({ operationId: "legacy-C2", currentQuestion: ctx.currentQuestion,
    correctedType: "field-knowledge", activeParentId: "A", activeParentRevision: 1, manualCorrectionRevision: 1,
    relationOperationLeaseAuthorized: true, revisionStableRelation: binding.relation,
    relationCandidate: { schemaVersion: 2, relation: "child-probe", confidence: 1, currentQuestionEvidenceSpans: [q.normalizedText], parentEvidenceSpans: [] } });
  assert.equal(correction.settlement.relation, "child-probe");
  const result = commit(manager, ledger, q, "field-knowledge", "new-child");
  assert.equal(result.plan.taskMutationPolicy.kind, "attach-child");
  assert.equal(result.proposal.receipt.relation, "child-probe");
  assert.equal(consumeRevisionStableTopologyBinding({ settlement: result.proposal.settlement, binding, logicalQuestionUnit: q }).consumed, false);
  assert.equal(ledger.findLogicalQuestion({ sessionId, runtimeEpoch: epoch, logicalQuestionUnitId: q.id, logicalQuestionRevision: 1 })!.owner.kind, "active-child");
});

test("MC2/MC7: same Type keeps independent choices and Field parent hard constraints", () => {
  const { manager, ledger, origin } = fixture();
  const ctx = context(manager, ledger, origin);
  assert.ok(option(ctx, "ai-ml-system-design", "independent").targetOwner);
  assert.ok(!getManualCorrectionCapabilities(ctx, "field-knowledge").options.some(item => item.family === "independent" || item.family === "retype"));
  const q = question("another-system", 20);
  const first = commit(manager, ledger, q, "ai-ml-system-design", "independent", "same-type-new-question");
  assert.notEqual(first.result.state.parent!.id, "A");
  assert.equal(first.proposal.receipt.action, "create");
  assert.equal(first.proposal.parent.originQuestionId, `lqu:${q.id}`);
});

test("MC2/MC3/SB2: continue preserves child ID; explicit new child gets a new ID", () => {
  const { manager, ledger } = fixture();
  const q = question("child", 20);
  admit(manager, ledger, q);
  const attached = commit(manager, ledger, q, "field-knowledge", "new-child");
  const firstId = attached.result.state.parent!.child!.id;
  const continued = commit(manager, ledger, q, "coding", "continue-child");
  assert.equal(continued.result.state.parent!.child!.id, firstId);
  assert.equal(continued.proposal.receipt.action, "preserve");
  assert.equal(continued.result.state.parent!.stableKind, "ai-ml-system-design");
  assert.equal(continued.result.state.parent!.child!.phaseState?.phase, "implementation_validation");
  const replaced = commit(manager, ledger, q, "field-knowledge", "new-child", "replace-current-child");
  assert.notEqual(replaced.result.state.parent!.child!.id, firstId);
  assert.equal(replaced.proposal.receipt.action, "attach-child");
});

test("MC3/SB1: same-ID parent retype keeps origin, topic and revision-stable relation", () => {
  const { manager, ledger, origin, a } = fixture();
  const q = question("followup", 20);
  admit(manager, ledger, q);
  const result = commit(manager, ledger, q, "general-system-design", "retype-parent");
  assert.equal(result.result.state.parent!.id, a.id);
  assert.equal(result.result.state.parent!.sourceQuestionUnitId, origin.id);
  assert.equal(result.result.state.parent!.topic, a.topic);
  assert.equal(result.proposal.receipt.relation, "followup-parent");
  assert.equal(result.proposal.receipt.action, "retype");
  assert.equal(manager.getRecentManualCorrectionParent(), undefined);
  assert.equal(context(manager, ledger, origin).runtime.parent!.stableKind, "general-system-design");
});

test("MC3: only the first child merges; a later admitted child question permits ordinary resume", () => {
  const first = fixture();
  const q = question("first-child", 20);
  admit(first.manager, first.ledger, q);
  commit(first.manager, first.ledger, q, "field-knowledge", "new-child");
  const merged = commit(first.manager, first.ledger, q, "ai-ml-system-design", "merge-first-child");
  assert.equal(merged.proposal.receipt.relation, "followup-parent");
  assert.equal(merged.proposal.receipt.action, "preserve");
  const second = fixture();
  admit(second.manager, second.ledger, q);
  commit(second.manager, second.ledger, q, "field-knowledge", "new-child");
  const later = question("child-unfinished", 30);
  admit(second.manager, second.ledger, later, "child-probe");
  assert.ok(!getManualCorrectionCapabilities(context(second.manager, second.ledger, q), "ai-ml-system-design").options.some(item => item.id === "merge-first-child"));
  const resumed = commit(second.manager, second.ledger, later, "ai-ml-system-design", "resume-parent");
  assert.equal(resumed.proposal.receipt.relation, "resume-parent");
  assert.equal(resumed.proposal.receipt.action, "resume");
});

function historyFixture(maxEntries = 96) {
  const f = fixture(maxEntries);
  const a = f.manager.getTaskRuntimeState().parent!;
  a.whiteboardArtifact = { id: "artifact-A", parentTaskId: "A", domainTrack: "ml_sd", archetypeIds: [], selectedOverlayIds: [],
    currentPhase: "design_framing", title: "A diagram", content: "A source diagram", summary: "A architecture", revision: 1,
    updateSource: "model-output", createdAt: 10, updatedAt: 10 };
  assert.ok(f.manager.commitTaskRuntimeTransition({ id: "a-artifact", transition: "update-parent-context", parent: a,
    authorizedArtifacts: ["whiteboard"], reason: "fixture" }).authorized);
  const q = question("B-origin", 20);
  const b = parent("B", q, "behavioral");
  assert.ok(f.manager.commitTaskRuntimeTransition({ id: "create-B", transition: "replace-parent", parent: b, reason: "fixture" }).authorized);
  admit(f.manager, f.ledger, q, "new-parent");
  return { ...f, q, b };
}

test("MC4: A -> unique B -> A restores identity/artifact and atomically reassigns Q source", () => {
  const { manager, ledger, origin, q } = historyFixture();
  const initial = ledger.listHistory().find(record => record.logicalQuestionUnitId === q.id)!;
  const merged = commit(manager, ledger, q, "ai-ml-system-design", "merge-recent-parent");
  assert.equal(merged.result.state.parent!.id, "A");
  assert.equal(merged.result.state.parent!.whiteboardArtifact!.id, "artifact-A");
  assert.equal(merged.result.state.parent!.playbookPhase, "design_framing");
  assert.equal(merged.proposal.receipt.action, "resume");
  assert.equal(merged.proposal.receipt.relation, "followup-parent");
  assert.equal(manager.getRecentManualCorrectionParent(), undefined);
  const record = ledger.findLogicalQuestion({ sessionId, runtimeEpoch: epoch, logicalQuestionUnitId: q.id, logicalQuestionRevision: 1 })!;
  assert.equal(record.owner.parentId, "A");
  assert.equal(record.sourceHash, initial.sourceHash);
  assert.equal(record.logicalQuestionRevision, initial.logicalQuestionRevision);
  assert.equal(ledger.listHistory().find(record => record.recordId === initial.recordId)!.owner.parentId, "B");
  const next = question("A-next", 30);
  const evidence = selectOwnerScopedRelationEvidence({ records: ledger.listHistory(), currentLogicalQuestionUnit: next,
    activeMeetingTask: manager.getState().activeMeetingTask!, transcriptTurns: [] });
  assert.ok(evidence.recentParentEvidence.some(item => item.text.includes(origin.id)));
  assert.ok(evidence.recentParentEvidence.some(item => item.text.includes(q.id)));
  const terminal = decideManualCorrectionTerminalState({ mutationApplied: true, stableAnswerCommitted: false, regenerationTraceStatus: "error" });
  assert.equal(terminal.status, "applied");
  assert.equal(manager.getTaskRuntimeState().parent!.id, "A");
});

test("MC4 Screen: merged Q becomes A's latest source image without B generated attachment", () => {
  const { manager, ledger, q, origin } = historyFixture();
  manager.addScreenObservation({ id: "screen-Q", imageBase64: "synthetic-source-image", imageMediaType: "image/png" } as ScreenObservation);
  const screenQ = { ...q, revision: 2 };
  const screenSource = admit(manager, ledger, screenQ, "new-parent", { sourceKind: "screen", sourceObservationIds: ["screen-Q"] });
  assert.equal(manager.commitTaskRuntimeTransition({ id: "B-screen-answer", transition: "update-source-attachment", reason: "fixture",
    screenAttachment: { id: "B-generated-screen", observationId: "screen-Q", basedOnObservationId: "screen-Q",
      kind: "behavioral", content: "B generated answer that must not become A's answer", basedOnTurnIds: screenQ.sourceTurnIds,
      createdAt: 30, updatedAt: 30 } }).authorized, true);
  const result = commit(manager, ledger, screenQ, "ai-ml-system-design", "merge-recent-parent");
  const restored = result.result.state.parent!;
  assert.equal(restored.id, "A");
  assert.equal(restored.topic, origin.normalizedText);
  assert.equal(restored.latestScreenObservationId, "screen-Q");
  assert.equal(restored.whiteboardArtifact!.id, "artifact-A");
  assert.equal(restored.whiteboardArtifact!.content, "A source diagram");
  assert.equal(result.result.state.screenAttachment, undefined);
  assert.equal(manager.getState().activeMeetingTask!.screen!.observationId, "screen-Q");
  assert.equal(manager.getState().activeMeetingTask!.screen!.latestScreenAnswer, undefined);
  const source = ledger.findLogicalQuestion({ sessionId, runtimeEpoch: epoch, logicalQuestionUnitId: q.id, logicalQuestionRevision: 2 })!;
  assert.equal(source.owner.parentId, "A");
  assert.equal(source.sourceHash, screenSource.sourceHash);
  assert.deepEqual(source.sourceObservationIds, ["screen-Q"]);
  assert.equal(source.text.includes("B generated answer"), false);
});

test("MC6 Screen: Q image removal after preparation rejects before task or owner installation", () => {
  const { manager, ledger, q } = historyFixture();
  manager.addScreenObservation({ id: "screen-Q", imageBase64: "synthetic-source-image" } as ScreenObservation);
  const screenQ = { ...q, revision: 2 };
  admit(manager, ledger, screenQ, "new-parent", { sourceKind: "screen", sourceObservationIds: ["screen-Q"] });
  const prepared = prepare(manager, ledger, screenQ, "ai-ml-system-design", "merge-recent-parent");
  manager.updateScreenObservation("screen-Q", { imageBase64: undefined });
  assert.equal(manager.commitPreparedTaskRuntimeTransition(prepared.transaction).authorized, false);
  assert.equal(manager.getTaskRuntimeState().parent!.id, "B");
  assert.equal(manager.getRecentManualCorrectionParent()!.parent.id, "A");
  assert.equal(ledger.findLogicalQuestion({ sessionId, runtimeEpoch: epoch, logicalQuestionUnitId: q.id, logicalQuestionRevision: 2 })!.owner.parentId, "B");
});

test("MC5: second admitted LQU survives retention, failure and locking back to Q", () => {
  const { manager, ledger, q } = historyFixture(4);
  const later = question("B-failed-question", 30);
  admit(manager, ledger, later);
  for (let i = 0; i < 8; i++) ledger.upsert({ ...ledger.list()[0], recordId: `unrelated-${i}`, logicalQuestionUnitId: `noise-${i}`, owner: { kind: "parent-mainline", parentId: "elsewhere" } });
  // Restore only Q's read record. This cannot erase the admission fact.
  admit(manager, ledger, q, "new-parent");
  assert.equal(manager.getManualCorrectionAdmission()!.hasAdditionalLogicalQuestionUnit, true);
  assert.ok(!getManualCorrectionCapabilities(context(manager, ledger, q), "ai-ml-system-design").options.some(item => item.id === "merge-recent-parent"));
  assert.ok(manager.getRecentManualCorrectionSources(epoch)?.records.some(record => record.logicalQuestionUnitId === "A-origin"));
  assert.ok(ledger.listHistory().length <= 4);
});

test("MC5/MC6: missing source, wrong type, stale slot and admitted child history refuse history merge", () => {
  const { manager, ledger, q } = historyFixture();
  assert.ok(!getManualCorrectionCapabilities(context(manager, ledger, q), "coding").options.some(item => item.id === "merge-recent-parent"));
  const staleContext = context(manager, ledger, q);
  const selected = option(staleContext, "ai-ml-system-design", "merge-recent-parent");
  const c = parent("C", question("C-origin"), "coding");
  manager.commitTaskRuntimeTransition({ id: "create-C", transition: "replace-parent", parent: c, reason: "fixture" });
  assert.equal(manager.getRecentManualCorrectionParent()!.parent.id, "B");
  const stale = prepareManualCorrectionIntentTransition({ operationId: "stale", context: { ...staleContext, runtime: manager.getTaskRuntimeState() },
    correctedType: "ai-ml-system-design", intent: selected.intent, newParentId: "unused" });
  assert.equal(stale.authorized, false);
  const missing = historyFixture();
  missing.ledger.clear();
  assert.equal(missing.manager.getRecentManualCorrectionSources(epoch), undefined);
  assert.ok(!getManualCorrectionCapabilities(context(missing.manager, missing.ledger, missing.q), "ai-ml-system-design").options.some(item => item.id === "merge-recent-parent"));
});

test("MC6: source update races reject without partial state, and rollback restores source and slot", () => {
  const { manager, ledger, q } = historyFixture();
  const prepared = prepare(manager, ledger, q, "ai-ml-system-design", "merge-recent-parent");
  const before = manager.getTaskRuntimeState();
  const source = ledger.findLogicalQuestion({ sessionId, runtimeEpoch: epoch, logicalQuestionUnitId: q.id, logicalQuestionRevision: 1 })!;
  ledger.upsert({ ...source, logicalQuestionRevision: 2, recordId: "new-revision", sourceHash: "changed" });
  assert.equal(manager.commitPreparedTaskRuntimeTransition(prepared.transaction).authorized, false);
  assert.deepEqual(manager.getTaskRuntimeState(), before);
  assert.equal(manager.getRecentManualCorrectionParent()!.parent.id, "A");
  const rollback = historyFixture();
  const reversible = prepare(rollback.manager, rollback.ledger, rollback.q, "ai-ml-system-design", "merge-recent-parent");
  assert.equal(rollback.manager.commitPreparedTaskRuntimeTransition(reversible.transaction).authorized, true);
  assert.equal(rollback.manager.commitPreparedTaskRuntimeTransition(reversible.transaction).authorized, false);
  assert.equal(rollback.manager.rollbackPreparedTaskRuntimeTransition(reversible.transaction), true);
  assert.equal(rollback.manager.getTaskRuntimeState().parent!.id, "B");
  assert.equal(rollback.manager.getRecentManualCorrectionSources(epoch)!.parentId, "A");
  assert.equal(rollback.ledger.findLogicalQuestion({ sessionId, runtimeEpoch: epoch, logicalQuestionUnitId: q.id, logicalQuestionRevision: 1 })!.owner.parentId, "B");
});

test("MC6: second admission during prepare rejects even without a runtime revision change", () => {
  const { manager, ledger, q } = historyFixture();
  const prepared = prepare(manager, ledger, q, "ai-ml-system-design", "merge-recent-parent");
  manager.recordTaskQuestionAdmission({ sessionId, parentId: "B", logicalQuestionUnitId: "admitted-but-not-generated" });
  assert.equal(manager.commitPreparedTaskRuntimeTransition(prepared.transaction).authorized, false);
  assert.equal(manager.getTaskRuntimeState().parent!.id, "B");
});

test("MC5/MC6: a second child admission invalidates a prepared first-child merge", () => {
  const { manager, ledger } = fixture();
  const q = question("first-child", 20);
  admit(manager, ledger, q);
  commit(manager, ledger, q, "field-knowledge", "new-child");
  const prepared = prepare(manager, ledger, q, "ai-ml-system-design", "merge-first-child");
  const childId = manager.getTaskRuntimeState().parent!.child!.id;
  manager.recordTaskQuestionAdmission({ sessionId, parentId: "A", childId, logicalQuestionUnitId: "child-in-flight" });
  assert.equal(manager.commitPreparedTaskRuntimeTransition(prepared.transaction).authorized, false);
  assert.equal(manager.getTaskRuntimeState().parent!.child!.id, childId);
});

test("MC5: same origin revisions and generation retries do not count as a second LQU", () => {
  const { manager, ledger, q } = historyFixture();
  for (let revision = 2; revision <= 4; revision++) admit(manager, ledger, { ...q, revision }, "new-parent");
  assert.equal(manager.getManualCorrectionAdmission()!.hasAdditionalLogicalQuestionUnit, false);
  const latest = { ...q, revision: 4 };
  assert.ok(option(context(manager, ledger, latest), "ai-ml-system-design", "merge-recent-parent"));
  assert.equal(getManualCorrectionCapabilities(context(manager, ledger, q), "ai-ml-system-design").options.some(item => item.id === "merge-recent-parent"), false);
});

test("MC5: a completed child excursion permanently disqualifies a historical first-parent merge", () => {
  const { manager, ledger, q } = historyFixture();
  commit(manager, ledger, q, "general-system-design", "retype-parent");
  commit(manager, ledger, q, "coding", "new-child");
  commit(manager, ledger, q, "general-system-design", "merge-first-child");
  assert.equal(manager.getManualCorrectionAdmission()!.hasChildHistory, true);
  assert.equal(manager.getTaskRuntimeState().parent!.child, undefined);
  assert.ok(!getManualCorrectionCapabilities(context(manager, ledger, q), "ai-ml-system-design").options.some(item => item.id === "merge-recent-parent"));
});

test("MC4: restoring A cannot install B's phase, binding, or unpublished artifact", () => {
  const { manager, ledger, q } = historyFixture();
  const prepared = prepare(manager, ledger, q, "ai-ml-system-design", "merge-recent-parent");
  const corrupt = { ...prepared.proposal.parent, playbookPhase: "follow_up" as const, supportedFactAnchors: ["B-generated-fact"] };
  const attempt = manager.prepareTaskRuntimeTransition({ id: "corrupt-restore", transition: "replace-parent", parent: corrupt,
    screenAttachment: null, reason: "merge", recentParentToRestore: "A", sourceOwnerCorrection: prepared.transaction.sourceOwnerCorrection });
  assert.equal(manager.commitPreparedTaskRuntimeTransition(attempt).authorized, false);
  assert.equal(manager.getTaskRuntimeState().parent!.id, "B");
  assert.equal(ledger.findLogicalQuestion({ sessionId, runtimeEpoch: epoch, logicalQuestionUnitId: q.id, logicalQuestionRevision: 1 })!.owner.parentId, "B");
});

test("MC2: an independent operation cannot reuse a live or retained parent ID", () => {
  const { manager, ledger, q } = historyFixture();
  const ctx = context(manager, ledger, q);
  for (const id of ["A", "B"]) {
    const result = prepareManualCorrectionIntentTransition({ operationId: "reuse-id", context: ctx, correctedType: "coding",
      intent: { kind: "independent" }, newParentId: id });
    assert.equal(result.authorized, false);
  }
});

test("MC6/SB3: real session/epoch/manual revision and inactive branch checks cannot be bypassed by matching old inputs", () => {
  const { manager, ledger, origin } = fixture();
  const ctx = context(manager, ledger, origin);
  for (const patch of [{ currentSessionId: "another-session" }, { currentRuntimeEpoch: epoch + 1 },
    { manualCorrectionRevision: 2 }, { currentQuestion: { ...ctx.currentQuestion, revision: 2 } }]) {
    assert.equal(getManualCorrectionCapabilities({ ...ctx, ...patch }, "coding").options.length, 0);
  }
  const resumedContext = context(manager, ledger, origin, epoch + 1);
  assert.ok(getManualCorrectionCapabilities(resumedContext, "coding").options.length > 0);
  assert.equal(resumedContext.currentQuestion.runtimeEpoch, epoch);
  const child = question("child", 20);
  admit(manager, ledger, child);
  commit(manager, ledger, child, "coding", "new-child");
  assert.equal(getManualCorrectionCapabilities(context(manager, ledger, origin), "general-system-design").rejectionReason, "inactive-branch");
});

test("MC4/MC5: image references retain the actual image within the existing screen budget", () => {
  const { manager, ledger, origin } = fixture();
  const original = ledger.list()[0];
  ledger.upsert({ ...original, sourceObservationIds: ["image-A"] });
  manager.addScreenObservation({ id: "image-A", imageBase64: "actual-image-bytes", imageMediaType: "image/png" } as ScreenObservation);
  const q = question("B-origin");
  manager.commitTaskRuntimeTransition({ id: "create-B", transition: "replace-parent", parent: parent("B", q, "behavioral"), reason: "fixture" });
  admit(manager, ledger, q, "new-parent");
  for (let i = 0; i < 9; i++) manager.addScreenObservation({ id: `image-${i}`, imageBase64: "new-image" } as ScreenObservation);
  assert.equal(manager.getState().screenObservations.find(item => item.id === "image-A")!.imageBase64, "actual-image-bytes");
  assert.ok(manager.getState().screenObservations.length <= 5);
  assert.equal(manager.getRecentManualCorrectionSources(epoch)!.missingObservationIds.length, 0);
  const prepared = prepare(manager, ledger, q, "ai-ml-system-design", "merge-recent-parent");
  manager.updateScreenObservation("image-A", { imageBase64: undefined });
  assert.ok(!getManualCorrectionCapabilities(context(manager, ledger, q), "ai-ml-system-design").options.some(item => item.id === "merge-recent-parent"));
  assert.equal(manager.commitPreparedTaskRuntimeTransition(prepared.transaction).authorized, false);
  assert.equal(ledger.list().find(item => item.logicalQuestionUnitId === origin.id)!.owner.parentId, "A");
});

test("MC6: clear/reset release history retention, while epoch-only pause retains source permission", () => {
  const { manager, ledger } = historyFixture();
  assert.ok(manager.getRecentManualCorrectionSources(epoch + 1));
  manager.clearTaskRuntime({ id: "stop", scope: "all", reason: "stop" });
  assert.equal(manager.getRecentManualCorrectionParent(), undefined);
  assert.equal(ledger.getRetainedParentSourceReferences(), undefined);
  const reset = historyFixture();
  reset.manager.reset({ sessionId: "new-session" });
  assert.equal(reset.manager.getRecentManualCorrectionParent(), undefined);
  assert.equal(reset.ledger.getRetainedParentSourceReferences(), undefined);
});

test("MC9: bounded pure capability + settlement/transition preparation stays below 10ms P95", () => {
  const { manager, ledger, origin } = fixture();
  for (let i = 0; i < 80; i++) admit(manager, ledger, question(`performance-${i}`, i + 30));
  const ctx = context(manager, ledger, origin);
  const intent = option(ctx, "general-system-design", "retype-parent").intent;
  const samples: number[] = [];
  for (let i = 0; i < 600; i++) {
    const start = performance.now();
    const prepared = prepareManualCorrectionIntentTransition({ operationId: `timing-${i}`, context: context(manager, ledger, origin),
      correctedType: "general-system-design", intent, newParentId: "unused", now: 100 });
    assert.equal(prepared.authorized, true);
    if (i >= 100) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  console.log(`MC9 local snapshot/capability/settlement/transition: n=${samples.length}, ledger=81, p95=${p95.toFixed(3)}ms; no model calls`);
  assert.ok(p95 <= 10, `P95 ${p95}ms`);
});
