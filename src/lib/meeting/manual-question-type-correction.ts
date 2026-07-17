import type { ActiveMeetingTask } from "./active-meeting-task";
import type {
  ActiveInterviewParent,
  ManualQuestionTypeCorrectionTarget,
  SelectedInterviewPlaybook,
} from "./types";
import {
  isParentCanonicalQuestionType,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import { isWhiteboardParentType } from "./whiteboard-artifact.js";

export interface ManualQuestionTypeCorrectionDecision {
  noOp: boolean;
  reason: string;
  target?: ManualQuestionTypeCorrectionTarget;
  detectedType: CanonicalQuestionType;
  correctedType: CanonicalQuestionType;
  parentType: CanonicalQuestionType;
  childType?: CanonicalQuestionType;
}

export function decideManualQuestionTypeCorrection(
  task: ActiveMeetingTask,
  correctedType: CanonicalQuestionType
): ManualQuestionTypeCorrectionDecision {
  const parentType =
    normalizeCanonicalQuestionType(task.parent.questionType) ?? "unknown";
  const childType = normalizeCanonicalQuestionType(task.child?.questionType);
  const detectedType = childType ?? parentType;
  const base = {
    detectedType,
    correctedType,
    parentType,
    childType,
  };

  if (correctedType === "unknown") {
    return {
      ...base,
      noOp: true,
      reason: "unknown-is-not-a-manual-correction-target",
    };
  }

  if (correctedType === detectedType) {
    return {
      ...base,
      noOp: true,
      reason: "already-effective-question-type",
    };
  }

  if (childType && correctedType === parentType) {
    return {
      ...base,
      noOp: false,
      reason: "manual-correction-resumes-existing-parent",
      target: "resume-parent",
    };
  }

  if (!isParentCanonicalQuestionType(correctedType)) {
    if (!task.child) {
      return {
        ...base,
        noOp: true,
        reason: "non-parent-correction-requires-active-child",
      };
    }

    return {
      ...base,
      noOp: false,
      reason: "manual-correction-retypes-active-child",
      target: "child",
    };
  }

  return {
    ...base,
    noOp: false,
    reason: "manual-correction-retypes-active-parent",
    target: "parent",
  };
}

export function applyManualQuestionTypeCorrectionToParent({
  parent,
  decision,
  correctedPlaybook,
  now = Date.now(),
  expiresAt,
}: {
  parent: ActiveInterviewParent;
  decision: ManualQuestionTypeCorrectionDecision;
  correctedPlaybook?: SelectedInterviewPlaybook;
  now?: number;
  expiresAt?: number;
}): ActiveInterviewParent {
  if (decision.noOp || !decision.target) return parent;

  if (decision.target === "resume-parent") {
    return {
      ...parent,
      child: undefined,
      updatedAt: now,
      expiresAt,
      revisions: parent.revisions + 1,
    };
  }

  if (decision.target === "child") {
    if (!parent.child) return parent;
    return {
      ...parent,
      child: {
        ...parent.child,
        questionType: decision.correctedType,
        compactSummary: undefined,
        updatedAt: now,
      },
      updatedAt: now,
      expiresAt,
      revisions: parent.revisions + 1,
    };
  }

  if (!isParentCanonicalQuestionType(decision.correctedType)) return parent;

  const nextPhase = correctedPlaybook?.phase ?? "follow_up";
  const preserveWhiteboard =
    isWhiteboardParentType(parent.stableKind) &&
    isWhiteboardParentType(decision.correctedType);

  return {
    ...parent,
    stableKind: decision.correctedType,
    playbook: correctedPlaybook,
    playbookPhase: nextPhase,
    phaseProgress: { [nextPhase]: true },
    child: undefined,
    projectBinding: undefined,
    supportedFactAnchors: [],
    previousUsefulAnswer:
      parent.latestUsefulAnswer ?? parent.previousUsefulAnswer,
    latestUsefulAnswer: undefined,
    whiteboardArtifact: preserveWhiteboard
      ? parent.whiteboardArtifact
      : undefined,
    updatedAt: now,
    expiresAt,
    revisions: parent.revisions + 1,
  };
}
