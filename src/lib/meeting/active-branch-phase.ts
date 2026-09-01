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

export interface CommittedBranchPhaseTransition {
  ownerKind: ActiveBranchPhaseOwnerKind;
  ownerId: string;
  parentId: string;
  fromPhase: InterviewPlaybookPhase;
  toPhase: InterviewPlaybookPhase;
  taskRevision: number;
  branchRevision: number;
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

export function applyActiveBranchPhase(input: {
  parent: ActiveInterviewParent;
  owner: EffectiveBranchPhaseView;
  targetPhase: InterviewPlaybookPhase;
  phaseProgress: Record<string, boolean>;
  playbook?: SelectedInterviewPlaybook;
  now?: number;
}): ActiveInterviewParent | undefined {
  const now = input.now ?? Date.now();
  if (
    input.owner.parentId !== input.parent.id
  ) {
    return undefined;
  }
  const phaseProgressChanged = !samePhaseProgress(
    input.owner.phaseProgress,
    input.phaseProgress
  );
  if (input.owner.phase === input.targetPhase && !phaseProgressChanged) {
    return undefined;
  }
  if (input.owner.ownerKind === "child") {
    const child = input.parent.child;
    if (
      !child?.phaseState ||
      child.id !== input.owner.ownerId ||
      child.phaseState.revision !== input.owner.branchRevision
    ) {
      return undefined;
    }
    const sourcePlaybook = input.playbook ?? child.phaseState.playbook;
    const playbook = sourcePlaybook
      ? { ...sourcePlaybook, phase: input.targetPhase }
      : undefined;
    if (!playbook) return undefined;
    return {
      ...input.parent,
      child: {
        ...child,
        phaseState: {
          playbook,
          phase: input.targetPhase,
          phaseProgress: { ...input.phaseProgress },
          revision: child.phaseState.revision + 1,
        },
        updatedAt: now,
      },
      updatedAt: now,
      revisions: input.parent.revisions + 1,
    };
  }
  if (
    input.parent.child ||
    input.parent.id !== input.owner.ownerId ||
    input.parent.revisions !== input.owner.branchRevision
  ) {
    return undefined;
  }
  const sourcePlaybook = input.playbook ?? input.parent.playbook;
  const playbook = sourcePlaybook
    ? { ...sourcePlaybook, phase: input.targetPhase }
    : undefined;
  if (!playbook) return undefined;
  return {
    ...input.parent,
    playbook,
    playbookPhase: input.targetPhase,
    phaseProgress: { ...input.phaseProgress },
    updatedAt: now,
    revisions: input.parent.revisions + 1,
  };
}

export function detectCommittedBranchPhaseTransition(input: {
  before?: ActiveInterviewParent;
  after?: ActiveInterviewParent;
}): CommittedBranchPhaseTransition | undefined {
  const { before, after } = input;
  if (!before || !after || before.id !== after.id) return undefined;
  if (
    before.child?.id === after.child?.id &&
    before.child?.phaseState &&
    after.child?.phaseState &&
    (before.child.phaseState.phase !== after.child.phaseState.phase ||
      !samePhaseProgress(
        before.child.phaseState.phaseProgress,
        after.child.phaseState.phaseProgress
      ))
  ) {
    return {
      ownerKind: "child",
      ownerId: after.child.id,
      parentId: after.id,
      fromPhase: before.child.phaseState.phase,
      toPhase: after.child.phaseState.phase,
      taskRevision: after.revisions,
      branchRevision: after.child.phaseState.revision,
    };
  }
  if (
    !before.child &&
    !after.child &&
    (before.playbookPhase !== after.playbookPhase ||
      !samePhaseProgress(before.phaseProgress, after.phaseProgress))
  ) {
    return {
      ownerKind: "parent",
      ownerId: after.id,
      parentId: after.id,
      fromPhase: before.playbookPhase,
      toPhase: after.playbookPhase,
      taskRevision: after.revisions,
      branchRevision: after.revisions,
    };
  }
  return undefined;
}

function samePhaseProgress(
  left: Record<string, boolean>,
  right: Record<string, boolean>
) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (Boolean(left[key]) !== Boolean(right[key])) return false;
  }
  return true;
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
