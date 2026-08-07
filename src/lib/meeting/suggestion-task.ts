import type { ActiveMeetingTask } from "./active-meeting-task";
import type { AdvisorSuggestion, MeetingAssistantState } from "./types";
import { normalizeCanonicalQuestionType } from "./task-taxonomy.js";

export type AdvisorSuggestionTaskMetadata = Pick<
  AdvisorSuggestion,
  "taskId" | "parentTaskId" | "childTaskId" | "taskSource" | "questionType"
>;

export function buildSuggestionTaskMetadata(
  task: ActiveMeetingTask | undefined
): AdvisorSuggestionTaskMetadata {
  if (!task) return {};

  return {
    taskId: task.id,
    parentTaskId: task.parent.id,
    childTaskId: task.child?.id,
    taskSource: task.source,
    questionType: task.parent.questionType,
  };
}

export function areSuggestionsForSameParentTask(
  left: AdvisorSuggestion | null | undefined,
  right: AdvisorSuggestion | null | undefined
) {
  if (!left || !right) return false;

  const leftTaskId = getSuggestionParentTaskId(left);
  const rightTaskId = getSuggestionParentTaskId(right);
  if (leftTaskId || rightTaskId) {
    if (!leftTaskId || !rightTaskId || leftTaskId !== rightTaskId) {
      return false;
    }

    const leftQuestionType = normalizeCanonicalQuestionType(left.questionType);
    const rightQuestionType = normalizeCanonicalQuestionType(right.questionType);
    return Boolean(
      leftQuestionType &&
        rightQuestionType &&
        leftQuestionType === rightQuestionType
    );
  }

  return true;
}

export function getSuggestionParentTaskId(suggestion: AdvisorSuggestion) {
  return suggestion.parentTaskId ?? suggestion.taskId;
}

export function stageSuggestionProjectionForManualCorrection(
  previous: MeetingAssistantState
): Pick<
  MeetingAssistantState,
  "partialSuggestion" | "latestSuggestion" | "latestReliableSuggestion"
> {
  const latestReliableSuggestion =
    previous.latestSuggestion && isReliableSuggestion(previous.latestSuggestion)
      ? previous.latestSuggestion
      : previous.latestReliableSuggestion;

  return {
    partialSuggestion: "",
    latestSuggestion: null,
    latestReliableSuggestion,
  };
}

export function restoreSuggestionProjectionAfterFailedManualCorrection(
  previous: MeetingAssistantState,
  reliableSuggestion: AdvisorSuggestion | null | undefined
): Pick<
  MeetingAssistantState,
  "partialSuggestion" | "latestSuggestion" | "latestReliableSuggestion"
> {
  if (!reliableSuggestion || !isReliableSuggestion(reliableSuggestion)) {
    return {
      partialSuggestion: "",
      latestSuggestion: previous.latestSuggestion,
      latestReliableSuggestion: previous.latestReliableSuggestion,
    };
  }

  return {
    partialSuggestion: "",
    latestSuggestion: reliableSuggestion,
    latestReliableSuggestion:
      previous.latestReliableSuggestion?.id === reliableSuggestion.id
        ? null
        : previous.latestReliableSuggestion,
  };
}

function isReliableSuggestion(suggestion: AdvisorSuggestion) {
  const content = suggestion.content.trim();
  return Boolean(
    content &&
      content !== "-" &&
      suggestion.kind !== "silent" &&
      suggestion.kind !== "clarifying-question"
  );
}
