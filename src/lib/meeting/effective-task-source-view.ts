import type { ActiveMeetingTask } from "./meeting-task-contracts.js";
import type { AdvisorPromptContext } from "./meeting-context-contracts.js";

import type {
  EffectiveQuestionSourceOwner,
  EffectiveQuestionSourceRecord,
} from "./effective-question-source-ledger.js";
import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import {
  indexAuthorizedEffectiveSourceRecords,
  readAuthorizedEffectiveSourceText,
  type AuthorizedEffectiveSourceRecordIndex,
} from "./authorized-effective-source-context.js";
import { buildContinuityEvidence } from "./advisor-evidence-packet.js";


export interface EffectiveTaskSourceViewInput {
  task?: ActiveMeetingTask;
  records: EffectiveQuestionSourceRecord[];
  logicalQuestionUnit?: LogicalQuestionUnit;
  sessionId: string;
  runtimeEpoch: number;
  recordIndex?: AuthorizedEffectiveSourceRecordIndex;
  selectedSourceTurnIds?: readonly string[];
}

export interface TaskSourceOrigin {
  logicalQuestionUnitId?: string;
  sourceTurnIds: string[];
  sourceObservationIds: string[];
  owner: EffectiveQuestionSourceOwner;
}

export function getTaskSourceOrigins(task: ActiveMeetingTask) {
  const parent: TaskSourceOrigin = {
    logicalQuestionUnitId: task.parent.sourceQuestionUnitId,
    sourceTurnIds: [...new Set([
      ...(task.parent.canonicalQuestionSourceTurnIds ?? []),
      task.parent.startTurnId,
      task.parent.promptTranscriptStartTurnId,
    ].filter((id): id is string => Boolean(id)))],
    sourceObservationIds: task.parent.startObservationId
      ? [task.parent.startObservationId] : [],
    owner: { kind: "parent-mainline", parentId: task.parent.id },
  };
  const child: TaskSourceOrigin | undefined = task.child ? {
    sourceTurnIds: [...task.child.basedOnTurnIds],
    sourceObservationIds: [...task.child.basedOnObservationIds],
    owner: { kind: "active-child", parentId: task.parent.id, childId: task.child.id },
  } : undefined;
  return { parent, child };
}

// This view is for semantic readers only. Never feed it back into task commands.
export function applyEffectiveTaskSourceTexts(
  task: ActiveMeetingTask | undefined,
  texts: { parent?: string; child?: string }
): ActiveMeetingTask | undefined {
  if (!task) return undefined;
  const topic = texts.parent?.trim() ?? "";
  const question = texts.child?.trim() ?? "";
  // Structural adapters may copy the owning question into the screen read DTO.
  // Preserve independently captured text; only carry those exact aliases forward.
  const screenQuestion = task.screen?.question === task.child?.question && task.child
    ? question : task.screen?.question === task.parent.topic ? topic : task.screen?.question;
  if (task.parent.topic === topic && (!task.child || task.child.question === question) &&
      task.screen?.question === screenQuestion) {
    return task;
  }
  return {
    ...task,
    parent: { ...task.parent, topic },
    child: task.child ? { ...task.child, question } : undefined,
    screen: task.screen ? { ...task.screen, question: screenQuestion } : undefined,
  };
}

export function projectEffectiveTaskSourceView(input: EffectiveTaskSourceViewInput) {
  const task = input.task;
  if (!task) return { task, parentSourceTurnIds: [], childSourceTurnIds: [], missingSourceTurnIds: [], rejectedSourceTurnIds: [] };
  const recordIndex = input.recordIndex ?? indexAuthorizedEffectiveSourceRecords({
    effectiveRecords: input.records, sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch, activeMeetingTask: task,
  });
  const origins = getTaskSourceOrigins(task);
  const read = (origin: TaskSourceOrigin) => readAuthorizedEffectiveSourceText({
    ...origin, recordIndex, logicalQuestionUnit: input.logicalQuestionUnit,
    selectedSourceTurnIds: input.selectedSourceTurnIds,
    sessionId: input.sessionId, runtimeEpoch: input.runtimeEpoch,
  });
  const parent = read(origins.parent);
  const child = origins.child ? read(origins.child) : undefined;
  return {
    task: applyEffectiveTaskSourceTexts(task, { parent: parent.text, child: child?.text }),
    parentSourceTurnIds: parent.sourceTurnIds,
    childSourceTurnIds: child?.sourceTurnIds ?? [],
    missingSourceTurnIds: [...new Set([...parent.missingSourceTurnIds, ...(child?.missingSourceTurnIds ?? [])])],
    rejectedSourceTurnIds: [...new Set([...parent.rejectedSourceTurnIds, ...(child?.rejectedSourceTurnIds ?? [])])],
  };
}

export function projectEffectiveAdvisorTaskContext(
  context: AdvisorPromptContext,
  input: Omit<EffectiveTaskSourceViewInput, "task">
): AdvisorPromptContext {
  const { task } = projectEffectiveTaskSourceView({ ...input, task: context.activeMeetingTask });
  const continuity = context.advisorEvidencePacket?.continuity
    ? buildContinuityEvidence(task) : undefined;
  return {
    ...context,
    activeMeetingTask: task,
    advisorEvidencePacket: context.advisorEvidencePacket ? {
      ...context.advisorEvidencePacket,
      continuity,
      retrievalHints: context.advisorEvidencePacket.retrievalHints.flatMap((hint) =>
        hint.role === "continuity" ? continuity ? [{ ...hint, text: continuity.capsule }] : [] : [hint]),
    } : undefined,

  };
}
