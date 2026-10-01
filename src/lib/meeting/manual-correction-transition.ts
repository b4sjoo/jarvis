import { buildActiveMeetingTask } from "./active-meeting-task.js";
import type { MeetingTaskRuntimeTransitionKind } from "./meeting-task-runtime-transition.js";
import { settleManualCorrectionIntent } from "./manual-correction-settlement.js";
import { applyManualQuestionTypeCorrectionToParent, type ManualCorrectionScopeDecision, type ManualQuestionTypeCorrectionDecision } from "./manual-question-type-correction.js";
import type { ManualCorrectionCapabilityContext, ManualCorrectionIntent } from "./manual-correction-intent.js";
import { createSourceOwnedTransitionCandidate } from "./source-owned-transition-transaction.js";
import { prepareSourceOwnedRuntimeTransition } from "./source-owned-transition-runtime.js";
import type { TaskLifecycleCommand } from "./settled-advisor-execution-plan.js";
import { normalizeCanonicalQuestionType, type CanonicalQuestionType } from "./task-taxonomy.js";
import type { ActiveInterviewParent, SelectedInterviewPlaybook } from "./types.js";

// Produces the existing writer's payload and Plan command. This function never
// installs state or calls a model; the caller still commits one lifecycle transaction.
export function prepareManualCorrectionIntentTransition(input: {
  operationId: string;
  context: ManualCorrectionCapabilityContext;
  correctedType: CanonicalQuestionType;
  intent: ManualCorrectionIntent;
  correctedPlaybook?: SelectedInterviewPlaybook;
  newParentId: string;
  now?: number;
}) {
  const settled = settleManualCorrectionIntent(input);
  if (!settled.authorized) return settled;
  const before = input.context.runtime.parent;
  const question = input.context.currentQuestion;
  const now = input.now ?? Date.now();
  const kind = input.intent.kind;
  const decision: ManualQuestionTypeCorrectionDecision = {
    noOp: false, reason: `explicit-manual-intent:${kind}`,
    detectedType: normalizeCanonicalQuestionType(before?.child?.questionType ?? before?.stableKind) ?? "unknown",
    correctedType: input.correctedType,
    parentType: normalizeCanonicalQuestionType(before?.stableKind) ?? "unknown",
    childType: normalizeCanonicalQuestionType(before?.child?.questionType),
    target: kind === "continue-child" || kind === "new-child" ? "child"
      : kind === "merge-first-child" || kind === "resume-parent" || kind === "merge-recent-parent" ? "resume-parent" : "parent",
  };
  const scopeDecision: ManualCorrectionScopeDecision = {
    scope: settled.capability.scope, reason: decision.reason,
    standaloneTaskScore: 0, standaloneTaskEvidence: [], continuityScore: 0, continuityEvidence: [],
    currentQuestionIsParentOrigin: before?.sourceQuestionUnitId === question.logicalQuestionUnitId,
    currentQuestionIsChild: input.context.source?.owner.kind === "active-child",
  };
  let parent: ActiveInterviewParent;
  let transition: MeetingTaskRuntimeTransitionKind;
  let command: Exclude<TaskLifecycleCommand, { kind: "preserve" }>;
  if (kind === "independent") {
    if (!input.newParentId || input.newParentId === before?.id || input.newParentId === input.context.recentParent?.parent.id) {
      return { authorized: false as const, reason: "new-parent-id-reused" };
    }
    if (before) {
      const phase = input.correctedPlaybook?.phase ?? "follow_up";
      parent = {
        id: input.newParentId, source: question.sourceKind === "screen" ? "screen" : "voice",
        // The admitted independent capability already requires a parent-eligible Type.
        stableKind: input.correctedType as ActiveInterviewParent["stableKind"],
        topic: question.normalizedText.trim() || "Current interview question",
        playbook: input.correctedPlaybook, playbookPhase: phase, phaseProgress: { [phase]: true },
        supportedFactAnchors: [], createdAt: now, updatedAt: now, revisions: 1,
        originQuestionId: `lqu:${question.logicalQuestionUnitId}`,
        startTurnId: question.sourceTurnIds[0], promptTranscriptStartTurnId: question.sourceTurnIds[0],
      };
    } else {
      const candidate = createSourceOwnedTransitionCandidate({
        sessionId: question.sessionId, runtimeEpoch: question.runtimeEpoch,
        source: question.sourceKind === "screen" ? "screen" : "voice",
        sourceTurnIds: question.sourceTurnIds, sourceObservationIds: question.sourceObservationIds,
        logicalQuestionUnitId: question.logicalQuestionUnitId, logicalQuestionRevision: question.revision,
        relation: "new-parent", authoritySource: "manual-correction", mutationAuthorized: true,
        questionType: input.correctedType, question: question.normalizedText,
        questionInstanceId: `lqu:${question.logicalQuestionUnitId}`, playbook: input.correctedPlaybook, now,
      });
      if (!candidate) return { authorized: false as const, reason: "source-missing" };
      const prepared = prepareSourceOwnedRuntimeTransition({ candidate, runtimeBefore: input.context.runtime,
        expectedTaskRuntimeRevision: input.context.runtime.revision,
        currentSessionId: question.sessionId, currentRuntimeEpoch: question.runtimeEpoch, now });
      if (!prepared.readyToCommit || !prepared.sourceResult.task) return { authorized: false as const, reason: prepared.reason };
      parent = { ...prepared.sourceResult.task, id: input.newParentId };
    }
    parent = { ...parent, canonicalQuestionSourceTurnIds: [...question.sourceTurnIds],
      sourceQuestionUnitId: question.logicalQuestionUnitId, sourceQuestionRevision: question.revision,
      startObservationId: question.sourceObservationIds[0], latestScreenObservationId: question.sourceObservationIds.at(-1),
      settlementId: settled.settlement.settlementId };
    transition = before ? "replace-parent" : "create-parent";
    command = { kind: transition, type: input.correctedType, topic: parent.topic };
  } else if (kind === "retype-parent") {
    if (!before) return { authorized: false as const, reason: "parent-missing" };
    parent = input.correctedType === before.stableKind
      ? { ...before, revisions: before.revisions + 1, updatedAt: now }
      : applyManualQuestionTypeCorrectionToParent({ parent: before, decision, correctedPlaybook: input.correctedPlaybook, now });
    transition = input.correctedType === before.stableKind ? "update-parent-context" : "replace-parent";
    command = transition === "replace-parent" ? { kind: transition, type: input.correctedType, topic: parent.topic } : { kind: transition };
  } else if (kind === "continue-child") {
    if (!before?.child) return { authorized: false as const, reason: "child-missing" };
    parent = applyManualQuestionTypeCorrectionToParent({ parent: before, decision, correctedPlaybook: input.correctedPlaybook, now });
    if (input.correctedType === "coding" && !parent.child?.phaseState) return { authorized: false as const, reason: "coding-child-playbook-required" };
    if (input.correctedType === "coding" && before.child.questionType !== "coding") {
      parent = { ...parent, child: { ...parent.child!, intent: "implementation-probe" } };
    }
    transition = "attach-child";
    command = { kind: transition, type: input.correctedType, question: parent.child!.question };
  } else if (kind === "merge-recent-parent") {
    const previous = input.context.recentParent?.parent;
    if (!before || !previous) return { authorized: false as const, reason: "recent-parent-missing" };
    parent = { ...previous, child: undefined, revisions: previous.revisions + 1, updatedAt: now,
      latestScreenObservationId: question.sourceObservationIds.at(-1) ?? previous.latestScreenObservationId };
    transition = "replace-parent";
    command = { kind: transition, type: input.correctedType, topic: parent.topic };
  } else {
    if (!before) return { authorized: false as const, reason: "parent-missing" };
    const candidate = createSourceOwnedTransitionCandidate({
      sessionId: question.sessionId, runtimeEpoch: question.runtimeEpoch,
      source: question.sourceKind === "screen" ? "screen" : "voice",
      sourceTurnIds: question.sourceTurnIds, sourceObservationIds: question.sourceObservationIds,
      logicalQuestionUnitId: question.logicalQuestionUnitId, logicalQuestionRevision: question.revision,
      existingTask: before, relation: kind === "new-child" ? "child-probe" : "resume-parent",
      subtaskIntent: kind === "new-child" && input.correctedType === "coding" ? "implementation-probe" : undefined,
      authoritySource: "manual-correction", mutationAuthorized: true, questionType: input.correctedType,
      question: question.normalizedText, questionInstanceId: `lqu:${question.logicalQuestionUnitId}`,
      playbook: input.correctedPlaybook, now,
    });
    if (!candidate) return { authorized: false as const, reason: "source-missing" };
    const prepared = prepareSourceOwnedRuntimeTransition({ candidate,
      runtimeBefore: { ...input.context.runtime, parent: kind === "new-child" ? { ...before, child: undefined } : before },
      expectedTaskRuntimeRevision: input.context.runtime.revision,
      currentSessionId: question.sessionId, currentRuntimeEpoch: question.runtimeEpoch, now });
    if (!prepared.readyToCommit || !prepared.sourceResult.task) return { authorized: false as const, reason: prepared.reason };
    parent = prepared.sourceResult.task;
    transition = kind === "new-child" ? "attach-child" : "resume-parent";
    command = transition === "attach-child"
      ? { kind: transition, type: input.correctedType, question: parent.child!.question }
      : { kind: transition };
  }
  return { ...settled, decision, scopeDecision, parent, transition, command,
    activeMeetingTask: buildActiveMeetingTask({ parent, runtimeRevision: input.context.runtime.revision + 1 }),
    // The receipt distinguishes merges/continuations from their underlying writer command.
    receipt: { intent: input.intent, action: settled.capability.action, relation: settled.capability.relation,
      sourceLogicalQuestionUnitId: question.logicalQuestionUnitId,
      parentBeforeId: before?.id, parentAfterId: parent.id, childBeforeId: before?.child?.id, childAfterId: parent.child?.id },
  };
}
