export type TaskSettlementRelationValue =
  | "new-parent"
  | "followup-parent"
  | "child-probe"
  | "resume-parent"
  | "logistics"
  | "correction"
  | "unknown"
  | "none";

export type ParentActionValue =
  | "create"
  | "preserve"
  | "retype"
  | "resume"
  | "attach-child"
  | "none";

export interface TaskSettlementTupleCompatibilityV2 {
  compatible: boolean;
  relation: TaskSettlementRelationValue;
  parentAction: ParentActionValue;
  recommendedParentAction: ParentActionValue;
  reason?: string;
}

export function evaluateTaskSettlementTupleCompatibilityV2(input: {
  relation: TaskSettlementRelationValue;
  parentAction: ParentActionValue;
}): TaskSettlementTupleCompatibilityV2 {
  const recommendedParentAction =
    recommendedParentActionForRelation(input.relation);
  const allowed = allowedParentActionsForRelation(input.relation);
  const compatible = allowed.includes(input.parentAction);
  return {
    compatible,
    relation: input.relation,
    parentAction: input.parentAction,
    recommendedParentAction,
    reason: compatible
      ? undefined
      : `${input.relation} allows ${allowed.join(", ")}, not ${input.parentAction}.`,
  };
}

export function projectObservedParentAction(input: {
  relation?: TaskSettlementRelationValue;
  mutationAuthorized?: boolean;
  lifecycleCommand?: string;
  currentOnly: boolean;
  parentBeforeId?: string;
  parentAfterId?: string;
  parentBeforeType?: unknown;
  parentAfterType?: unknown;
}): ParentActionValue | undefined {
  if (input.lifecycleCommand === "create-parent") return "create";
  if (input.lifecycleCommand === "replace-parent") {
    return isSameParentRetype(input) ? "retype" : "create";
  }
  if (input.lifecycleCommand === "attach-child") return "attach-child";
  if (input.lifecycleCommand === "resume-parent") return "resume";
  if (
    input.lifecycleCommand === "preserve" ||
    input.lifecycleCommand === "update-parent-context" ||
    input.lifecycleCommand === "advance-phase" ||
    input.currentOnly
  ) {
    return "preserve";
  }
  if (!input.relation) return undefined;
  if (input.relation === "new-parent") {
    return input.mutationAuthorized === false ? "none" : "create";
  }
  if (input.relation === "child-probe") {
    return input.mutationAuthorized === false
      ? "preserve"
      : "attach-child";
  }
  if (input.relation === "resume-parent") {
    return input.mutationAuthorized === false ? "preserve" : "resume";
  }
  if (
    input.relation === "none" ||
    input.relation === "followup-parent" ||
    input.relation === "correction" ||
    input.relation === "logistics"
  ) {
    return "preserve";
  }
  return input.mutationAuthorized === false ? "none" : undefined;
}

export function recommendedParentActionForRelation(
  relation: TaskSettlementRelationValue
): ParentActionValue {
  switch (relation) {
    case "new-parent":
      return "create";
    case "child-probe":
      return "attach-child";
    case "resume-parent":
      return "resume";
    case "followup-parent":
    case "logistics":
    case "correction":
      return "preserve";
    case "unknown":
      return "none";
    case "none":
      return "preserve";
  }
}

function allowedParentActionsForRelation(
  relation: TaskSettlementRelationValue
): ParentActionValue[] {
  if (relation === "new-parent") {
    return ["create", "preserve", "retype"];
  }
  if (relation === "child-probe") {
    return ["attach-child", "preserve"];
  }
  return [recommendedParentActionForRelation(relation)];
}

function isSameParentRetype(input: {
  parentBeforeId?: string;
  parentAfterId?: string;
  parentBeforeType?: unknown;
  parentAfterType?: unknown;
}) {
  const beforeType = normalizeComparableType(input.parentBeforeType);
  const afterType = normalizeComparableType(input.parentAfterType);
  return Boolean(
    input.parentBeforeId &&
      input.parentAfterId &&
      input.parentBeforeId === input.parentAfterId &&
      beforeType &&
      afterType &&
      beforeType !== afterType
  );
}

function normalizeComparableType(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : undefined;
}
