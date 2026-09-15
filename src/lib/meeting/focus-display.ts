import type { MeetingFocusSnapshot } from "./focus-window.js";

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

// Display-only whitelist. Never spread a runtime object across the window boundary.
const readDisplay = object({
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
  phaseOutputNotice: text,
  isBusy: boolean,
  audioControl: object({
    action: string, label: string, title: string, disabled: boolean, urgent: boolean, busy: boolean,
  }),
  showClarifyingQuestion: boolean, clarifyingQuestion: string,
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
