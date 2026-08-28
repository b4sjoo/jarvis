import type { ActiveMeetingTask } from "./active-meeting-task.js";
import {
  decideOrderedTaskRelationResolution,
  type OrderedTaskRelationResolutionDecision,
} from "./task-relation-split-shadow.js";

export type OrderedSettlementCoordinatorStage =
  | "ordered-relation-result"
  | "no-parent-matrix"
  | "topology-null-hypothesis";

export interface OrderedSettlementCoordinatorDecision {
  stage: OrderedSettlementCoordinatorStage;
  relation: OrderedTaskRelationResolutionDecision;
  relationHandleRequired: boolean;
  reason: string;
}

export function coordinateOrderedSettlement(input: {
  sourceKind: "voice" | "screen" | "mixed";
  currentQuestionType: unknown;
  activeMeetingTask?: ActiveMeetingTask;
  orderedRelation?: OrderedTaskRelationResolutionDecision;
  screenBoundaryPrior?: boolean;
  screenTypeEvidenceAuthorized?: boolean;
}): OrderedSettlementCoordinatorDecision {
  if (input.orderedRelation?.status === "resolved") {
    return {
      stage: "ordered-relation-result",
      relation: cloneOrderedRelation(input.orderedRelation),
      relationHandleRequired: Boolean(input.activeMeetingTask?.parent),
      reason: `ordered-relation:${input.orderedRelation.stage ?? "resolved"}`,
    };
  }

  const parent = input.activeMeetingTask?.parent;
  const child = input.activeMeetingTask?.child;
  const relation = decideOrderedTaskRelationResolution({
    sourceKind: input.sourceKind,
    currentQuestionType: input.currentQuestionType,
    activeParentQuestionType: parent?.questionType,
    activeChildQuestionType: child?.questionType,
    hasActiveChild: Boolean(child),
    screenBoundaryPrior: input.screenBoundaryPrior,
    screenTypeEvidenceAuthorized: input.screenTypeEvidenceAuthorized,
    finalizeWithNullHypothesis: true,
  });

  return {
    stage: parent ? "topology-null-hypothesis" : "no-parent-matrix",
    relation,
    relationHandleRequired: Boolean(parent),
    reason: parent
      ? `topology-finalized:${relation.reason}`
      : `no-parent-matrix:${relation.reason}`,
  };
}

export function formatOrderedSettlementCoordinatorForTrace(
  decision: OrderedSettlementCoordinatorDecision | undefined
) {
  if (!decision) return {};
  return {
    orderedSettlementCoordinatorStage: decision.stage,
    orderedSettlementCoordinatorReason: decision.reason,
    orderedSettlementCoordinatorRelationHandleRequired:
      decision.relationHandleRequired,
    orderedSettlementCoordinatorRelationStatus: decision.relation.status,
    orderedSettlementCoordinatorRelation: decision.relation.relation,
    orderedSettlementCoordinatorRelationStage: decision.relation.stage,
    orderedSettlementCoordinatorRelationReason: decision.relation.reason,
    orderedSettlementCoordinatorResponseOnly:
      decision.relation.responseOnly,
  };
}

function cloneOrderedRelation(
  relation: OrderedTaskRelationResolutionDecision
): OrderedTaskRelationResolutionDecision {
  return {
    ...relation,
    currentEvidenceSpans: [...relation.currentEvidenceSpans],
    parentEvidenceSpans: [...relation.parentEvidenceSpans],
    matrix: {
      ...relation.matrix,
      currentEvidenceSpans: [...relation.matrix.currentEvidenceSpans],
      parentEvidenceSpans: [...relation.matrix.parentEvidenceSpans],
    },
  };
}
