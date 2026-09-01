import type {
  ActiveBranchPhaseState,
  ActiveInterviewParent,
  InterviewPlaybookPhase,
  SelectedInterviewPlaybook,
} from "./types.js";
import {
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";

export type ActiveBranchPhaseOwnerKind = "parent" | "child";

export interface EffectiveBranchPhaseView {
  ownerKind: ActiveBranchPhaseOwnerKind;
  ownerId: string;
  parentId: string;
  questionType: CanonicalQuestionType;
  playbook: SelectedInterviewPlaybook;
  phase: InterviewPlaybookPhase;
  phaseProgress: Record<string, boolean>;
  branchRevision: number;
}

export type ActiveBranchPhaseResolution =
  | {
      status: "resolved";
      view: EffectiveBranchPhaseView;
    }
  | {
      status: "unavailable";
      reason:
        | "no-active-branch"
        | "active-child-phase-unavailable"
        | "active-parent-phase-unavailable";
      ownerKind?: ActiveBranchPhaseOwnerKind;
      ownerId?: string;
      parentId?: string;
    };

export function createCodingChildPhaseState(input: {
  questionType: unknown;
  playbook?: SelectedInterviewPlaybook;
}): ActiveBranchPhaseState | undefined {
  const questionType = normalizeCanonicalQuestionType(input.questionType);
  const playbookType = normalizeCanonicalQuestionType(
    input.playbook?.questionType
  );
  if (
    questionType !== "coding" ||
    playbookType !== "coding" ||
    !input.playbook
  ) {
    return undefined;
  }
  const phase = "implementation_validation" as const;
  return {
    playbook: { ...input.playbook, phase },
    phase,
    phaseProgress: { [phase]: true },
    revision: 1,
  };
}

export function preserveOrCreateCodingChildPhaseState(input: {
  questionType: unknown;
  existing?: ActiveBranchPhaseState;
  playbook?: SelectedInterviewPlaybook;
}): ActiveBranchPhaseState | undefined {
  if (normalizeCanonicalQuestionType(input.questionType) !== "coding") {
    return undefined;
  }
  if (
    input.existing &&
    normalizeCanonicalQuestionType(input.existing.playbook.questionType) ===
      "coding"
  ) {
    return cloneBranchPhaseState(input.existing);
  }
  return createCodingChildPhaseState(input);
}

export function resolveEffectiveBranchPhase(
  parent: ActiveInterviewParent | undefined
): ActiveBranchPhaseResolution {
  if (!parent) {
    return { status: "unavailable", reason: "no-active-branch" };
  }
  if (parent.child) {
    if (!parent.child.phaseState) {
      return {
        status: "unavailable",
        reason: "active-child-phase-unavailable",
        ownerKind: "child",
        ownerId: parent.child.id,
        parentId: parent.id,
      };
    }
    return {
      status: "resolved",
      view: {
        ownerKind: "child",
        ownerId: parent.child.id,
        parentId: parent.id,
        questionType:
          normalizeCanonicalQuestionType(parent.child.questionType) ??
          "unknown",
        playbook: { ...parent.child.phaseState.playbook },
        phase: parent.child.phaseState.phase,
        phaseProgress: { ...parent.child.phaseState.phaseProgress },
        branchRevision: parent.child.phaseState.revision,
      },
    };
  }
  if (!parent.playbook) {
    return {
      status: "unavailable",
      reason: "active-parent-phase-unavailable",
      ownerKind: "parent",
      ownerId: parent.id,
      parentId: parent.id,
    };
  }
  return {
    status: "resolved",
    view: {
      ownerKind: "parent",
      ownerId: parent.id,
      parentId: parent.id,
      questionType:
        normalizeCanonicalQuestionType(parent.stableKind) ?? "unknown",
      playbook: { ...parent.playbook },
      phase: parent.playbookPhase,
      phaseProgress: { ...parent.phaseProgress },
      branchRevision: parent.revisions,
    },
  };
}

export function cloneBranchPhaseState(
  state: ActiveBranchPhaseState | undefined
): ActiveBranchPhaseState | undefined {
  if (!state) return undefined;
  return {
    ...state,
    playbook: { ...state.playbook },
    phaseProgress: { ...state.phaseProgress },
  };
}
