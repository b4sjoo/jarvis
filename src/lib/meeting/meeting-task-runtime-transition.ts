import type { CanonicalQuestionType } from "./task-taxonomy.js";
import type { InterviewPlaybookPhase } from "./types.js";

export type TaskLifecycleCommand =
  | { kind: "preserve" }
  | { kind: "create-parent"; type: CanonicalQuestionType; topic: string }
  | { kind: "replace-parent"; type: CanonicalQuestionType; topic: string }
  | { kind: "attach-child"; type: CanonicalQuestionType; question: string }
  | { kind: "resume-parent" }
  | { kind: "set-phase"; owner: MeetingPhaseOwner; phase: InterviewPlaybookPhase }
  | { kind: "update-parent-context" };

export interface MeetingPhaseOwner {
  kind: "parent" | "child";
  id: string;
}

export type AnswerArtifactSection =
  | "answer"
  | "code"
  | "complexity"
  | "whiteboard";

export type MeetingTaskRuntimeTransitionKind =
  | "create-parent"
  | "replace-parent"
  | "attach-child"
  | "resume-parent"
  | "set-phase"
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
    value === "set-phase" ||
    value === "update-parent-context" ||
    value === "update-source-attachment"
  ) {
    return value;
  }
  if (value === "advance-phase") return "set-phase";
  return undefined;
}
