import {
  normalizeMeetingTaskRuntimeTransitionKind,
  type MeetingTaskRuntimeTransitionKind,
} from "./meeting-task-runtime-transition.js";
import {
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";

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

export interface CommittedLifecycleEvidence {
  command: MeetingTaskRuntimeTransitionKind;
  parentBeforeId?: string;
  parentAfterId?: string;
  parentBeforeType?: CanonicalQuestionType;
  parentAfterType?: CanonicalQuestionType;
  childBeforeId?: string;
  childAfterId?: string;
  authority: "source-transition-durable-receipt";
}

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
  const allowed = allowedParentActionsForRelation(input.relation);
  const compatible = allowed.includes(input.parentAction);
  const recommendedParentAction =
    input.relation === "none" && input.parentAction === "preserve"
      ? "preserve"
      : recommendedParentActionForRelation(input.relation);
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
  committedLifecycleEvidence?: CommittedLifecycleEvidence;
  lifecycleCommand?: string;
  currentOnly: boolean;
  // null denotes an explicitly absent parent in an authorized Plan snapshot.
  parentBeforeId?: string | null;
  parentAfterId?: string | null;
  parentBeforeType?: unknown;
  parentAfterType?: unknown;
}): ParentActionValue | undefined {
  if (input.committedLifecycleEvidence) {
    return projectCommittedLifecycleParentAction(
      input.committedLifecycleEvidence
    );
  }
  const lifecycleCommand = input.lifecycleCommand;
  if (lifecycleCommand === "create-parent") return "create";
  if (lifecycleCommand === "replace-parent") {
    if (
      !input.parentBeforeId ||
      !input.parentAfterId ||
      !normalizeComparableType(input.parentBeforeType) ||
      !normalizeComparableType(input.parentAfterType)
    ) {
      return undefined;
    }
    return isSameParentRetype(input) ? "retype" : "create";
  }
  if (lifecycleCommand === "attach-child") return "attach-child";
  if (lifecycleCommand === "resume-parent") return "resume";
  if (
    lifecycleCommand === "preserve" ||
    lifecycleCommand === "update-parent-context" ||
    lifecycleCommand === "set-phase"
  ) {
    if (input.parentBeforeId && input.parentBeforeId === input.parentAfterId) {
      return "preserve";
    }
    return input.parentBeforeId === null && input.parentAfterId === null
      ? "none"
      : undefined;
  }
  // A relation proposal cannot stand in for a lifecycle receipt or final Plan.
  return undefined;
}

export function resolveCommittedSourceTransitionLifecycleEvidence(input: {
  runtimeKind?: unknown;
  durableAuthorized?: unknown;
  durableMutationApplied?: unknown;
  parentBeforeId?: unknown;
  parentAfterId?: unknown;
  parentBeforeType?: unknown;
  parentAfterType?: unknown;
  childBeforeId?: unknown;
  childAfterId?: unknown;
}): CommittedLifecycleEvidence | undefined {
  const command = normalizeMeetingTaskRuntimeTransitionKind(input.runtimeKind);
  if (
    input.durableAuthorized !== true ||
    input.durableMutationApplied !== true ||
    !command
  ) {
    return undefined;
  }
  return {
    command,
    parentBeforeId: normalizeOptionalString(input.parentBeforeId),
    parentAfterId: normalizeOptionalString(input.parentAfterId),
    parentBeforeType: normalizeCanonicalQuestionType(input.parentBeforeType),
    parentAfterType: normalizeCanonicalQuestionType(input.parentAfterType),
    childBeforeId: normalizeOptionalString(input.childBeforeId),
    childAfterId: normalizeOptionalString(input.childAfterId),
    authority: "source-transition-durable-receipt",
  };
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
      return "none";
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
  if (relation === "followup-parent") {
    return ["preserve", "retype"];
  }
  if (relation === "none") {
    return ["none", "preserve"];
  }
  return [recommendedParentActionForRelation(relation)];
}

function isSameParentRetype(input: {
  parentBeforeId?: string | null;
  parentAfterId?: string | null;
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

function projectCommittedLifecycleParentAction(
  evidence: CommittedLifecycleEvidence
): ParentActionValue | undefined {
  if (evidence.command === "create-parent") return "create";
  if (evidence.command === "replace-parent") {
    if (
      !evidence.parentBeforeId ||
      !evidence.parentAfterId ||
      !evidence.parentBeforeType ||
      !evidence.parentAfterType
    ) {
      return undefined;
    }
    return isSameParentRetype(evidence) ? "retype" : "create";
  }
  if (evidence.command === "attach-child") {
    return evidence.childBeforeId &&
      evidence.childAfterId &&
      evidence.childBeforeId === evidence.childAfterId
      ? "preserve"
      : "attach-child";
  }
  if (evidence.command === "resume-parent") return "resume";
  return "preserve";
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function normalizeComparableType(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : undefined;
}
