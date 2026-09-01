export type MeetingTaskRuntimeTransitionKind =
  | "create-parent"
  | "replace-parent"
  | "attach-child"
  | "resume-parent"
  | "advance-phase"
  | "update-parent-context"
  | "update-source-attachment";

export function normalizeMeetingTaskRuntimeTransitionKind(
  value: unknown
): MeetingTaskRuntimeTransitionKind | undefined {
  if (
    value === "create-parent" ||
    value === "replace-parent" ||
    value === "attach-child" ||
    value === "resume-parent" ||
    value === "advance-phase" ||
    value === "update-parent-context" ||
    value === "update-source-attachment"
  ) {
    return value;
  }
  return undefined;
}
