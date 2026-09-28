import { cloneProjectBinding } from "./project-binding.js";
import type {
  ActiveInterviewParent,
  ProjectBindingDecision,
} from "./types.js";

export interface ProjectBindingSettlementCommitResult {
  committed: boolean;
  task?: ActiveInterviewParent;
  previousProjectId?: string;
  nextProjectId?: string;
  previousBindingRevision: number;
  nextBindingRevision: number;
  parentRevisionBefore?: number;
  parentRevisionAfter?: number;
  invalidateProjectState: boolean;
  invalidatedState: string[];
  reason: string;
}

export function commitProjectBindingSettlement({
  currentTask,
  decision,
  expectedParentId,
  expectedParentRevision,
  now = Date.now(),
}: {
  currentTask?: ActiveInterviewParent;
  decision: ProjectBindingDecision;
  expectedParentId?: string;
  expectedParentRevision?: number;
  now?: number;
}): ProjectBindingSettlementCommitResult {
  if (!currentTask) {
    return createRejectedResult("no-active-parent", decision);
  }
  if (expectedParentId && currentTask.id !== expectedParentId) {
    return createRejectedResult(
      "stale-parent-id",
      decision,
      currentTask
    );
  }
  if (
    expectedParentRevision !== undefined &&
    currentTask.revisions !== expectedParentRevision
  ) {
    return createRejectedResult(
      "stale-parent-revision",
      decision,
      currentTask
    );
  }
  if (
    decision.action === "not-applicable" ||
    decision.action === "needs-selection"
  ) {
    return createRejectedResult(
      "binding-decision-does-not-mutate-parent",
      decision,
      currentTask
    );
  }

  const previousBinding = currentTask.projectBinding;
  const previousProjectId =
    previousBinding?.projectId ?? previousBinding?.projectName;
  const nextBinding =
    decision.action === "invalidate"
      ? undefined
      : cloneProjectBinding(decision.binding);
  const nextProjectId =
    nextBinding?.projectId ?? nextBinding?.projectName;
  const bindingChanged =
    decision.action === "invalidate" ||
    decision.action === "rebind" ||
    previousBinding?.revision !== nextBinding?.revision ||
    previousProjectId !== nextProjectId;

  if (!bindingChanged) {
    return {
      committed: false,
      task: cloneTask(currentTask),
      previousProjectId,
      nextProjectId,
      previousBindingRevision: previousBinding?.revision ?? 0,
      nextBindingRevision: nextBinding?.revision ?? 0,
      parentRevisionBefore: currentTask.revisions,
      parentRevisionAfter: currentTask.revisions,
      invalidateProjectState: false,
      invalidatedState: [],
      reason: "binding-already-settled",
    };
  }

  const invalidateProjectState =
    decision.action === "invalidate" ||
    decision.action === "rebind";
  const invalidatedState = invalidateProjectState
    ? [
        "supported-fact-anchors",
        "playbook-phase",
        "child",
        "whiteboard-artifact",
        "latest-answer",
        "previous-answer",
      ]
    : [];
  const task: ActiveInterviewParent = {
    ...currentTask,
    projectBinding: nextBinding,
    supportedFactAnchors: invalidateProjectState
      ? []
      : [...currentTask.supportedFactAnchors],
    playbookPhase: invalidateProjectState
      ? "project_summary"
      : currentTask.playbookPhase,
    phaseProgress: invalidateProjectState
      ? {}
      : { ...currentTask.phaseProgress },
    child: invalidateProjectState
      ? undefined
      : currentTask.child
        ? {
            ...currentTask.child,
            basedOnTurnIds: [...currentTask.child.basedOnTurnIds],
            basedOnObservationIds: [
              ...currentTask.child.basedOnObservationIds,
            ],
            returnCapsule: currentTask.child.returnCapsule
              ? {
                  ...currentTask.child.returnCapsule,
                  allowedFactAnchorIds: [
                    ...currentTask.child.returnCapsule.allowedFactAnchorIds,
                  ],
                  artifactCompatibility: {
                    ...currentTask.child.returnCapsule.artifactCompatibility,
                  },
                }
              : undefined,
          }
        : undefined,
    whiteboardArtifact: invalidateProjectState
      ? undefined
      : currentTask.whiteboardArtifact,
    updatedAt: now,
    revisions: currentTask.revisions + 1,
  };

  return {
    committed: true,
    task,
    previousProjectId,
    nextProjectId,
    previousBindingRevision: previousBinding?.revision ?? 0,
    nextBindingRevision: nextBinding?.revision ?? 0,
    parentRevisionBefore: currentTask.revisions,
    parentRevisionAfter: task.revisions,
    invalidateProjectState,
    invalidatedState,
    reason:
      decision.action === "invalidate"
        ? "conflicting-project-binding-invalidated-before-model"
        : decision.action === "rebind"
          ? "project-binding-rebound-before-model"
          : "project-binding-committed-before-model",
  };
}

export function formatProjectBindingSettlementCommitForTrace(
  result: ProjectBindingSettlementCommitResult
): Record<string, unknown> {
  return {
    projectBindingSettlementCommitted: result.committed,
    projectBindingSettlementReason: result.reason,
    projectBindingSettlementPreviousProjectId:
      result.previousProjectId,
    projectBindingSettlementNextProjectId: result.nextProjectId,
    projectBindingSettlementPreviousRevision:
      result.previousBindingRevision,
    projectBindingSettlementNextRevision: result.nextBindingRevision,
    projectBindingSettlementParentRevisionBefore:
      result.parentRevisionBefore,
    projectBindingSettlementParentRevisionAfter:
      result.parentRevisionAfter,
    projectBindingSettlementInvalidatedState:
      result.invalidatedState,
  };
}

function createRejectedResult(
  reason: string,
  decision: ProjectBindingDecision,
  currentTask?: ActiveInterviewParent
): ProjectBindingSettlementCommitResult {
  return {
    committed: false,
    task: currentTask ? cloneTask(currentTask) : undefined,
    previousProjectId:
      currentTask?.projectBinding?.projectId ??
      currentTask?.projectBinding?.projectName,
    nextProjectId:
      decision.binding?.projectId ?? decision.binding?.projectName,
    previousBindingRevision:
      currentTask?.projectBinding?.revision ?? 0,
    nextBindingRevision: decision.bindingRevision,
    parentRevisionBefore: currentTask?.revisions,
    parentRevisionAfter: currentTask?.revisions,
    invalidateProjectState: false,
    invalidatedState: [],
    reason,
  };
}

function cloneTask(task: ActiveInterviewParent): ActiveInterviewParent {
  return {
    ...task,
    canonicalQuestionSourceTurnIds: [
      ...(task.canonicalQuestionSourceTurnIds ?? []),
    ],
    supportedFactAnchors: [...task.supportedFactAnchors],
    projectBinding: cloneProjectBinding(task.projectBinding),
    child: task.child
      ? {
          ...task.child,
          basedOnTurnIds: [...task.child.basedOnTurnIds],
          basedOnObservationIds: [
            ...task.child.basedOnObservationIds,
          ],
          returnCapsule: task.child.returnCapsule
            ? {
                ...task.child.returnCapsule,
                allowedFactAnchorIds: [
                  ...task.child.returnCapsule.allowedFactAnchorIds,
                ],
                artifactCompatibility: {
                  ...task.child.returnCapsule.artifactCompatibility,
                },
              }
            : undefined,
          phaseState: task.child.phaseState
            ? {
                ...task.child.phaseState,
                playbook: { ...task.child.phaseState.playbook },
                phaseProgress: {
                  ...task.child.phaseState.phaseProgress,
                },
              }
            : undefined,
        }
      : undefined,
    phaseProgress: { ...task.phaseProgress },
  };
}
