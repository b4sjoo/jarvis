import type { MeetingFocusActiveTaskSnapshot, MeetingFocusSnapshot } from "./focus-window.js";
import type { ActiveMeetingTask } from "./meeting-task-contracts.js";
import type { StableAnswerRevision } from "./stable-answer.js";
import type { InterviewPlaybookPhase, InterviewSubtaskIntent, MeetingTrace } from "./types.js";
import { getActiveMeetingTaskFocusSummary } from "./active-meeting-task.js";
import { projectQuestionTypeObservation } from "./question-type-observation.js";
import { normalizeCanonicalQuestionType } from "./task-taxonomy.js";

/** Read-only display DTO. Owner identity can select committed fields, never authorize a command. */
export function projectSelectedFocusTask(input: {
  stable: StableAnswerRevision | null;
  trace?: MeetingTrace;
  activeTask?: ActiveMeetingTask;
}) {
  const owner = input.stable?.sections.answer.owner;
  if (!owner) return { task: undefined, currentOwnerQuestionType: undefined, affiliated: undefined };
  const metadata = input.trace?.metadata ?? {};
  const readText = (key: string) => typeof metadata[key] === "string" ? metadata[key] as string : undefined;
  const settlement = input.stable?.settlementSnapshot as { relation?: unknown } | undefined;
  const relation = metadata.settledExecutionPlanRelation ?? metadata.effectiveCurrentQuestionSettlementRelation ??
    settlement?.relation ?? metadata.currentQuestionSettlementRelation;
  const affiliated = metadata.settledExecutionPlanRelationApplicable !== false &&
    metadata.effectiveAdvisorRelationApplicable !== false &&
    (owner.kind === "active-child" ? relation === "child-probe" :
      relation === "new-parent" || relation === "followup-parent" || relation === "resume-parent" || relation === "linked-parent-extension");
  if (!affiliated) return { task: undefined, currentOwnerQuestionType: undefined, affiliated: false };
  const parent = input.activeTask?.parent.id === owner.parentId ? input.activeTask : undefined;
  const currentSummary = getActiveMeetingTaskFocusSummary(parent);
  const observation = projectQuestionTypeObservation({ metadata });
  const phase = input.stable?.sections.answer.phase ?? input.stable?.suggestion.generationPhase;
  const historicalParent: NonNullable<MeetingFocusActiveTaskSnapshot> = {
    id: owner.parentId,
    source: input.stable?.suggestion.taskSource ?? (input.trace?.kind === "screen" ? "screen" : "voice"),
    questionType: observation.observedParentType ?? "unknown",
    topic: readText("activeMeetingParentTopic") ?? readText("currentQuestionPreview") ?? "",
    playbookPhase: (owner.kind === "parent-mainline" ? phase : undefined) ??
      readText("activeMeetingParentPhase") as InterviewPlaybookPhase | undefined,
    hasScreenContext: input.trace?.kind === "screen",
    child: undefined,
  };
  const currentChild = owner.kind === "active-child" && currentSummary?.child?.id === owner.childId
    ? currentSummary.child : undefined;
  const historicalChildMatches = owner.kind === "active-child" && metadata.activeMeetingChildId === owner.childId;
  const child = owner.kind === "active-child" ? currentChild ?? {
    id: owner.childId,
    questionType: normalizeCanonicalQuestionType(input.stable?.suggestion.questionType) ?? "unknown",
    intent: (historicalChildMatches ? readText("activeMeetingChildIntent") : undefined) as InterviewSubtaskIntent | undefined ?? "unknown",
    question: readText("currentQuestionPreview") ?? "",
    playbookPhase: phase ?? (historicalChildMatches ? readText("activeMeetingChildPhase") : undefined) as InterviewPlaybookPhase | undefined,
  } : undefined;
  return {
    affiliated: true,
    task: { ...(currentSummary ?? historicalParent), child },
    currentOwnerQuestionType: normalizeCanonicalQuestionType(
      owner.kind === "parent-mainline" ? parent?.parent.questionType : currentChild?.questionType
    ),
  };
}

type Reader = (value: unknown) => unknown;
const string: Reader = (value) => {
  if (typeof value !== "string") throw new Error("Invalid Focus text field");
  return value;
};
const boolean: Reader = (value) => {
  if (typeof value !== "boolean") throw new Error("Invalid Focus boolean field");
  return value;
};
const number: Reader = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid Focus number field");
  return value;
};
const optional = (read: Reader): Reader => (value) => value === undefined ? undefined : read(value);
const array = (read: Reader): Reader => (value) => {
  if (!Array.isArray(value)) throw new Error("Invalid Focus list field");
  return Object.freeze(value.map(read));
};
const object = (fields: Record<string, Reader>): Reader => (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Focus object field");
  const source = value as Record<string, unknown>;
  return Object.freeze(Object.fromEntries(Object.entries(fields).flatMap(([key, read]) => {
    const result = read(source[key]);
    return result === undefined ? [] : [[key, result]];
  })));
};
const text = optional(string);
const flag = optional(boolean);
const displayTarget = object({ sessionId: string, suggestionId: text, traceId: text,
  generationId: text, stableRevision: optional(number),
  logicalQuestionUnitId: text, logicalQuestionRevision: optional(number) });

// Display-only whitelist. Never spread a runtime object across the window boundary.
const readDisplay = object({
  advisePin: optional(object({ locked: boolean, backgroundUpdated: boolean, target: displayTarget })),
  active: boolean,
  sections: object({
    chineseThinking: string, primaryAnswer: string, focusedQuestion: string,
    approach: string, whiteboard: string, whiteboardViewKey: text,
    code: string, complexity: string, clarifyingQuestion: string,
    clarifyingOptions: array(object({ id: string, label: string, value: string })),
    profile: text, hasTechnicalDetails: boolean,
  }),
  latestReliableAnswer: string, latestTurnText: string,
  forceAdviseAvailable: boolean, forceAdvisePending: boolean, forceAdviseCompleted: boolean,
  answerDelivery: object({
    state: string, visibleAnswerRevision: number, meSpokenWordEquivalent: number,
    meAnswerTokenOverlap: number, pendingOperationId: text,
  }),
  statusLabel: string,
  error: (value) => value === null ? null : string(value),
  factGuardrailNotice: optional(object({ kind: string, message: string })),
  factRiskReview: optional(object({ answerKey: string, status: string, reason: text,
    flags: array(object({ section: string, quote: string, reason: string, sourceIds: array(string) })) })),
  phaseOutputNotice: text,
  artifactReuseNotice: text,
  isBusy: boolean,
  audioControl: object({
    action: string, label: string, title: string, disabled: boolean, urgent: boolean, busy: boolean,
  }),
  audioInputWarning: optional(object({ label: string, detail: string })),
  showClarifyingQuestion: boolean, clarifyingQuestion: string,
  projectChoice: optional(object({
    key: string, displayTarget,
    currentProject: optional(object({ id: string, name: string })),
    options: array(object({ id: string, label: string, value: string })),
    canSelect: boolean, canReselect: boolean,
  })),
  showClarifyingBooleanFallback: boolean, selectedClarifyingAnswerLabel: text,
  clarifyingSelectionState: text, clarifyingSelectionMessage: text,
  isTaskSwitchClarifyingQuestion: boolean, interviewTypes: array(string),
  effectiveQuestionType: text, currentQuestionTypeAuthority: text,
  parentQuestionType: text, parentTaskId: text,
  typeAppliedToResponse: flag, typeAppliedToSettlement: flag, typeAppliedToParent: flag,
  durableOwnerMissing: boolean, durableOwnerMissingReason: text,
  transientPersonalStatusLabel: text, currentQuestionId: text, questionTypeCorrected: boolean,
  manualQuestionTypeCorrection: optional(object({
    taskId: string, questionId: string, correctedType: string, status: string,
    regenerationStatus: string, error: text,
  })),
  activeTask: optional(object({
    id: string, source: string, questionType: string, topic: string,
    playbookPhase: text, hasScreenContext: boolean,
    child: optional(object({
      id: string, questionType: string, intent: string, question: string, playbookPhase: text,
    })),
  })),
  hasActiveMeetingTask: boolean, hasCorrectableQuestion: boolean, hasActiveScreenTask: boolean,
  speechCorrections: array(object({
    id: string, input: string, from: text, to: text, term: text,
    appliedCount: number, deactivatedAt: optional(number),
    activeQuestion: optional(object({ disposition: string, regenerationStatus: string, error: text })),
  })),
});

/** Projects existing owner-selected display facts; performs no answer/artifact selection. */
export function createMeetingFocusDisplayModel(input: MeetingFocusSnapshot): MeetingFocusSnapshot {
  return readMeetingFocusDisplay(input);
}

/** Validate and detach the wire payload, discarding non-display fields at every level. */
export function readMeetingFocusDisplay(input: unknown): MeetingFocusSnapshot {
  return readDisplay(input) as MeetingFocusSnapshot;
}
