import type { ActiveMeetingTask } from "./meeting-task-contracts.js";

import {
  decideOrderedTaskRelationResolution,
  ORDERED_RELATION_STAGE_BUDGET_MS,
  type OrderedTaskRelationResolutionDecision,
  type TaskRelationAffinityAdjudication,
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

export interface OrderedSettlementDeadline {
  startedAt: number;
  deadlineAt: number;
  budgetMs: number;
}

export interface OrderedRelationPhaseBudget {
  affinityCutoffAt: number;
  canonicalBudgetMs: number;
}

export type OrderedSettlementReleaseSource = "settled" | "deadline";

export type OrderedRelationOperationTerminalDisposition =
  | "resolved"
  | "cancelled"
  | "client-error";

export function resolveOrderedRelationOperationTerminal(input: {
  operationAuthorized: boolean;
  clientError: boolean;
}): OrderedRelationOperationTerminalDisposition {
  if (!input.operationAuthorized) return "cancelled";
  return input.clientError ? "client-error" : "resolved";
}

export interface OrderedSettlementReleaseDecision {
  accepted: boolean;
  source: OrderedSettlementReleaseSource;
  at: number;
  reason:
    | "released"
    | "already-released"
    | "settled-after-deadline";
}

export interface OrderedSettlementReleaseGate {
  tryRelease(input: {
    source: OrderedSettlementReleaseSource;
    at?: number;
  }): OrderedSettlementReleaseDecision;
  isReleased(): boolean;
  readReceipt(): OrderedSettlementReleaseDecision | undefined;
}

export function createOrderedSettlementDeadline(input: {
  startedAt: number;
  budgetMs: number;
}): OrderedSettlementDeadline {
  const budgetMs = Math.max(0, input.budgetMs);
  return {
    startedAt: input.startedAt,
    deadlineAt: input.startedAt + budgetMs,
    budgetMs,
  };
}

export function readOrderedSettlementRemainingMs(
  deadline: Pick<OrderedSettlementDeadline, "deadlineAt">,
  now = Date.now()
) {
  return Math.max(0, deadline.deadlineAt - now);
}

export function createOrderedRelationPhaseBudget(
  deadline: OrderedSettlementDeadline
): OrderedRelationPhaseBudget {
  return {
    affinityCutoffAt: Math.min(deadline.deadlineAt, deadline.startedAt + ORDERED_RELATION_STAGE_BUDGET_MS),
    canonicalBudgetMs: ORDERED_RELATION_STAGE_BUDGET_MS,
  };
}

export function createOrderedRelationCanonicalDeadline(
  deadline: OrderedSettlementDeadline,
  startedAt = Date.now()
): OrderedSettlementDeadline {
  return createOrderedSettlementDeadline({
    startedAt,
    budgetMs: deadline.budgetMs > 0 ? ORDERED_RELATION_STAGE_BUDGET_MS : 0,
  });
}

export function createOrderedSettlementReleaseGate(
  deadline: OrderedSettlementDeadline
): OrderedSettlementReleaseGate {
  let receipt: OrderedSettlementReleaseDecision | undefined;
  return {
    tryRelease(input) {
      const at = input.at ?? Date.now();
      if (receipt) {
        return {
          accepted: false,
          source: input.source,
          at,
          reason: "already-released",
        };
      }
      if (
        input.source === "settled" &&
        deadline.budgetMs > 0 &&
        at > deadline.deadlineAt
      ) {
        return {
          accepted: false,
          source: input.source,
          at,
          reason: "settled-after-deadline",
        };
      }
      receipt = {
        accepted: true,
        source: input.source,
        at,
        reason: "released",
      };
      return { ...receipt };
    },
    isReleased() {
      return Boolean(receipt);
    },
    readReceipt() {
      return receipt ? { ...receipt } : undefined;
    },
  };
}

export function formatOrderedSettlementReleaseForTrace(
  decision: OrderedSettlementReleaseDecision | undefined
) {
  return decision
    ? {
        orderedSettlementReleaseAccepted: decision.accepted,
        orderedSettlementReleaseSource: decision.source,
        orderedSettlementReleaseAt: decision.at,
        orderedSettlementReleaseReason: decision.reason,
      }
    : {};
}

export function coordinateOrderedSettlement(input: {
  sourceKind: "voice" | "screen" | "mixed";
  currentQuestionType: unknown;
  currentQuestionTypeInherited?: boolean;
  allowParentRetype?: boolean;
  childAffinity?: TaskRelationAffinityAdjudication;
  parentAffinity?: TaskRelationAffinityAdjudication;
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
    currentQuestionTypeInherited: input.currentQuestionTypeInherited,
    allowParentRetype: input.allowParentRetype,
    childAffinity: input.childAffinity,
    parentAffinity: input.parentAffinity,
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
