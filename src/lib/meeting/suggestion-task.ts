import type { ActiveMeetingTask } from "./active-meeting-task";
import type { AdvisorSuggestion } from "./types";

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
    return Boolean(leftTaskId && rightTaskId && leftTaskId === rightTaskId);
  }

  return true;
}

export function getSuggestionParentTaskId(suggestion: AdvisorSuggestion) {
  return suggestion.parentTaskId ?? suggestion.taskId;
}
