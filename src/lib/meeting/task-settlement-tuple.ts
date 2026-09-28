import {
  normalizeMeetingTaskRuntimeTransitionKind,
  type MeetingTaskRuntimeTransitionKind,
} from "./meeting-task-runtime-transition.js";
import {
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import type { ManualCorrectionIntent } from "./manual-correction-intent.js";

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

export interface CommittedManualCorrectionEvidence {
  authority: "manual-correction-durable-receipt";
  executionPlanId: string;
  command: MeetingTaskRuntimeTransitionKind;
  intent: ManualCorrectionIntent;
  relation: TaskSettlementRelationValue;
  action: ParentActionValue;
  sourceLogicalQuestionUnitId: string;
  parentBeforeId?: string;
  parentAfterId: string;
  childBeforeId?: string;
  childAfterId?: string;
  parentBeforeType?: CanonicalQuestionType;
  parentAfterType?: CanonicalQuestionType;
}

export function evaluateTaskSettlementTupleCompatibilityV2(input: {
  relation: TaskSettlementRelationValue;
  parentAction: ParentActionValue;
  manualCorrectionEvidence?: CommittedManualCorrectionEvidence;
  // Expected editors may validate a human request before/without a commit.
  // This input never grants Observed projection or runtime authority.
  manualCorrectionExpectedIntent?: ManualCorrectionIntent;
}): TaskSettlementTupleCompatibilityV2 {
  const allowed = allowedParentActionsForRelation(input.relation);
  const manual = readCommittedManualCorrectionEvidence(input.manualCorrectionEvidence);
  const committedManualTuple = manual?.authority === "manual-correction-durable-receipt" &&
    manual.relation === input.relation && manual.action === input.parentAction &&
    isValidManualCorrectionOutcome(manual);
  const expectedIntent = readManualCorrectionIntent(input.manualCorrectionExpectedIntent);
  const expectedRecentMerge = expectedIntent?.kind === "merge-recent-parent" &&
    expectedIntent.parentId !== expectedIntent.previousParentId && input.relation === "followup-parent";
  const requestedManualTuple = (expectedRecentMerge && input.parentAction === "resume") ||
    (expectedIntent?.kind === "retype-parent" && input.relation === "resume-parent" && input.parentAction === "preserve");
  const compatible = allowed.includes(input.parentAction) || !!committedManualTuple || requestedManualTuple;
  const recommendedParentAction =
    expectedRecentMerge ? "resume" : requestedManualTuple ? input.parentAction
      : manual?.relation === input.relation ? manual.action : input.relation === "none" && input.parentAction === "preserve"
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
  manualCorrectionEvidence?: CommittedManualCorrectionEvidence;
  lifecycleCommand?: string;
  currentOnly: boolean;
  // null denotes an explicitly absent parent in an authorized Plan snapshot.
  parentBeforeId?: string | null;
  parentAfterId?: string | null;
  parentBeforeType?: unknown;
  parentAfterType?: unknown;
}): ParentActionValue | undefined {
  const manual = readCommittedManualCorrectionEvidence(input.manualCorrectionEvidence);
  if (manual) return manual.action;
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

// The receipt is a proposed outcome until the existing atomic writer confirms
// installation. Never authorize this read projection from a menu/request label.
export function resolveCommittedManualCorrectionEvidence(
  metadata: Record<string, unknown>
): CommittedManualCorrectionEvidence | undefined {
  const receipt = recordValue(metadata.manualCorrectionIntentReceipt);
  const intent = recordValue(receipt?.intent);
  const planId = normalizeOptionalString(metadata.taskLifecycleExecutionPlanId);
  const committedPlanId = normalizeOptionalString(metadata.manualCorrectionCommittedPlanId ?? metadata.settledExecutionPlanId);
  const command = normalizeMeetingTaskRuntimeTransitionKind(metadata.manualCorrectionCommittedCommand ?? metadata.settledExecutionPlanTaskMutationCommand);
  if (!receipt || !intent || !planId || committedPlanId !== planId || !command ||
    metadata.correctionAtomicCommitAuthorized !== true || metadata.taskLifecycleAuthorized !== true ||
    metadata.taskLifecycleMutationApplied !== true) return undefined;
  const parentBeforeId = normalizeOptionalString(receipt.parentBeforeId);
  const parentAfterId = normalizeOptionalString(receipt.parentAfterId);
  const sourceLogicalQuestionUnitId = normalizeOptionalString(receipt.sourceLogicalQuestionUnitId);
  const sourceId = normalizeOptionalString(metadata.settledExecutionPlanLogicalQuestionUnitId ??
    metadata.effectiveCurrentQuestionSettlementUnitId ?? metadata.currentQuestionSettlementUnitId ?? metadata.logicalQuestionUnitId);
  if (!parentAfterId || !sourceLogicalQuestionUnitId || sourceId !== sourceLogicalQuestionUnitId ||
    parentBeforeId !== normalizeOptionalString(metadata.taskLifecycleParentBeforeId) ||
    parentAfterId !== normalizeOptionalString(metadata.taskLifecycleParentAfterId)) return undefined;
  const parsedIntent = readManualCorrectionIntent(intent);
  if (!parsedIntent || !isRelation(receipt.relation) || !isParentAction(receipt.action)) return undefined;
  const evidence: CommittedManualCorrectionEvidence = {
    authority: "manual-correction-durable-receipt", executionPlanId: planId, command,
    intent: parsedIntent, relation: receipt.relation, action: receipt.action,
    sourceLogicalQuestionUnitId, parentBeforeId, parentAfterId,
    childBeforeId: normalizeOptionalString(receipt.childBeforeId),
    childAfterId: normalizeOptionalString(receipt.childAfterId),
    parentBeforeType: normalizeCanonicalQuestionType(metadata.taskLifecycleParentBeforeType),
    parentAfterType: normalizeCanonicalQuestionType(metadata.taskLifecycleParentAfterType),
  };
  if ((metadata.taskLifecycleChildBeforeId !== undefined && normalizeOptionalString(metadata.taskLifecycleChildBeforeId) !== evidence.childBeforeId) ||
    (metadata.taskLifecycleChildAfterId !== undefined && normalizeOptionalString(metadata.taskLifecycleChildAfterId) !== evidence.childAfterId)) return undefined;
  return isValidManualCorrectionOutcome(evidence) ? evidence : undefined;
}

export function readManualCorrectionIntent(value: unknown): ManualCorrectionIntent | undefined {
  const intent = recordValue(value);
  if (!intent) return undefined;
  if (intent.kind === "independent") return { kind: "independent" };
  const parentId = normalizeOptionalString(intent.parentId);
  if (!parentId) return undefined;
  if (intent.kind === "new-child" || intent.kind === "retype-parent") return { kind: intent.kind, parentId };
  const childId = normalizeOptionalString(intent.childId);
  if (childId && (intent.kind === "continue-child" || intent.kind === "merge-first-child" || intent.kind === "resume-parent")) {
    return { kind: intent.kind, parentId, childId };
  }
  const previousParentId = normalizeOptionalString(intent.previousParentId);
  return intent.kind === "merge-recent-parent" && previousParentId
    ? { kind: intent.kind, parentId, previousParentId } : undefined;
}

export function readCommittedManualCorrectionEvidence(value: unknown): CommittedManualCorrectionEvidence | undefined {
  const raw = recordValue(value);
  const intent = readManualCorrectionIntent(raw?.intent);
  const command = normalizeMeetingTaskRuntimeTransitionKind(raw?.command);
  const executionPlanId = normalizeOptionalString(raw?.executionPlanId);
  const sourceLogicalQuestionUnitId = normalizeOptionalString(raw?.sourceLogicalQuestionUnitId);
  const parentAfterId = normalizeOptionalString(raw?.parentAfterId);
  if (!raw || raw.authority !== "manual-correction-durable-receipt" || !intent || !command || !executionPlanId ||
    !sourceLogicalQuestionUnitId || !parentAfterId || !isRelation(raw.relation) || !isParentAction(raw.action)) return undefined;
  const result: CommittedManualCorrectionEvidence = {
    authority: "manual-correction-durable-receipt", intent, command, executionPlanId,
    sourceLogicalQuestionUnitId, parentAfterId, action: raw.action, relation: raw.relation,
    parentBeforeId: normalizeOptionalString(raw.parentBeforeId),
    childBeforeId: normalizeOptionalString(raw.childBeforeId), childAfterId: normalizeOptionalString(raw.childAfterId),
    parentBeforeType: normalizeCanonicalQuestionType(raw.parentBeforeType), parentAfterType: normalizeCanonicalQuestionType(raw.parentAfterType),
  };
  return isValidManualCorrectionOutcome(result) ? result : undefined;
}

function isValidManualCorrectionOutcome(evidence: CommittedManualCorrectionEvidence) {
  const { intent, command, action, relation, parentBeforeId, parentAfterId, childBeforeId, childAfterId } = evidence;
  const sameParent = !!parentBeforeId && parentBeforeId === parentAfterId;
  if (intent.kind !== "independent" && intent.parentId !== parentAfterId) return false;
  switch (intent.kind) {
    case "independent":
      return (command === "create-parent" || command === "replace-parent") &&
        parentBeforeId !== parentAfterId && !childAfterId && action === "create" && relation === "new-parent";
    case "new-child":
      return command === "attach-child" && sameParent && !!childAfterId && childAfterId !== childBeforeId &&
        action === "attach-child" && relation === "child-probe";
    case "continue-child":
      return (command === "attach-child" || command === "update-parent-context") && sameParent &&
        childBeforeId === intent.childId && childAfterId === intent.childId && action === "preserve" && relation === "child-probe";
    case "retype-parent":
      if (!sameParent || childBeforeId || childAfterId || !evidence.parentBeforeType || !evidence.parentAfterType ||
        !["new-parent", "followup-parent", "resume-parent"].includes(relation)) return false;
      return evidence.parentBeforeType !== evidence.parentAfterType
        ? command === "replace-parent" && action === "retype"
        : command === "update-parent-context" && action === "preserve";
    case "merge-first-child":
      return command === "resume-parent" && sameParent && childBeforeId === intent.childId && !childAfterId &&
        action === "preserve" && relation === "followup-parent";
    case "resume-parent":
      return command === "resume-parent" && sameParent && childBeforeId === intent.childId && !childAfterId &&
        action === "resume" && relation === "resume-parent";
    case "merge-recent-parent":
      return command === "replace-parent" && parentBeforeId === intent.previousParentId && !sameParent &&
        !childBeforeId && !childAfterId && action === "resume" && relation === "followup-parent";
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isRelation(value: unknown): value is TaskSettlementRelationValue {
  return typeof value === "string" && ["new-parent", "followup-parent", "child-probe", "resume-parent", "logistics", "correction", "unknown", "none"].includes(value);
}

function isParentAction(value: unknown): value is ParentActionValue {
  return typeof value === "string" && ["create", "preserve", "retype", "resume", "attach-child", "none"].includes(value);
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
  if (relation === "resume-parent") {
    return ["resume", "retype"];
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
