import type { CurrentQuestionRelation, ProvisionalCurrentQuestion } from "./current-question-settlement.js";
import type { EffectiveQuestionSourceOwner, EffectiveQuestionSourceRecord, RetainedParentSourceEvidence } from "./effective-question-source-ledger.js";
import type { MeetingTaskRuntimeState } from "./meeting-task-contracts.js";
import { canParentQuestionTypeOwnChild, canQuestionTypeCreateParent, normalizeCanonicalQuestionType, type CanonicalQuestionType } from "./task-taxonomy.js";
import type { ActiveInterviewParent, ManualCorrectionScope } from "./types.js";

export type ManualCorrectionIntent =
  | { kind: "independent" }
  | { kind: "new-child"; parentId: string }
  | { kind: "continue-child"; parentId: string; childId: string }
  | { kind: "retype-parent"; parentId: string }
  | { kind: "merge-first-child"; parentId: string; childId: string }
  | { kind: "resume-parent"; parentId: string; childId: string }
  | { kind: "merge-recent-parent"; parentId: string; previousParentId: string };

// Saturating admission facts survive source-window retention and failed generation.
// No list of historical questions or second task tree is needed.
export interface ManualCorrectionAdmission {
  parentId: string;
  originLogicalQuestionUnitId?: string;
  hasAdditionalLogicalQuestionUnit: boolean;
  hasChildHistory: boolean;
  child?: {
    childId: string;
    originLogicalQuestionUnitId?: string;
    hasAdditionalLogicalQuestionUnit: boolean;
  };
}

export interface RecentManualCorrectionParent {
  sessionId: string;
  parent: ActiveInterviewParent;
  replacedByParentId: string;
  admission: ManualCorrectionAdmission;
}

export interface ManualCorrectionTargetSnapshot {
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionRevision: number;
  sourceHash: string;
  manualCorrectionRevision: number;
  taskRuntimeRevision: number;
  owner?: EffectiveQuestionSourceOwner;
}

export interface ManualCorrectionCapabilityContext {
  target: ManualCorrectionTargetSnapshot;
  currentQuestion: ProvisionalCurrentQuestion;
  currentSessionId: string;
  currentRuntimeEpoch: number;
  manualCorrectionRevision: number;
  runtime: MeetingTaskRuntimeState;
  source?: EffectiveQuestionSourceRecord;
  admission?: ManualCorrectionAdmission;
  recentParent?: RecentManualCorrectionParent;
  recentParentSources?: RetainedParentSourceEvidence;
}

interface ManualCorrectionCapabilityDecision {
  intent: ManualCorrectionIntent;
  relation: Extract<CurrentQuestionRelation, "new-parent" | "followup-parent" | "child-probe" | "resume-parent">;
  action: "create" | "attach-child" | "preserve" | "retype" | "resume";
  scope: ManualCorrectionScope;
}

export interface ManualCorrectionCapability extends ManualCorrectionCapabilityDecision {
  id: ManualCorrectionIntent["kind"];
  label: string;
  family: "independent" | "child" | "retype" | "merge";
  targetOwner: EffectiveQuestionSourceOwner | { kind: "new-parent" } | { kind: "new-child"; parentId: string };
}

export function getManualCorrectionCapabilities(
  context: ManualCorrectionCapabilityContext,
  correctedType: CanonicalQuestionType
): { options: ManualCorrectionCapability[]; rejectionReason?: string } {
  const rejectionReason = validateManualCorrectionTarget(context);
  if (rejectionReason) return { options: [], rejectionReason };
  if (correctedType === "unknown") return { options: [], rejectionReason: "unknown-type" };
  const { runtime, source, admission, recentParent } = context;
  const parent = runtime.parent;
  const parentType = normalizeCanonicalQuestionType(parent?.stableKind);
  const canCreateParent = canQuestionTypeCreateParent(correctedType) &&
    !(correctedType === "field-knowledge" && parentType && canParentQuestionTypeOwnChild(parentType, correctedType));
  const options: ManualCorrectionCapabilityDecision[] = [];
  if (canCreateParent) {
    options.push({ intent: { kind: "independent" }, relation: "new-parent", action: "create", scope: "independent-new-parent" });
  }
  if (!parent) return { options: options.map(option => describeCapability(option, context)) };
  if (parentType && canParentQuestionTypeOwnChild(parentType, correctedType)) {
    options.push({ intent: { kind: "new-child", parentId: parent.id }, relation: "child-probe", action: "attach-child", scope: "child-retype" });
    if (parent.child) options.push({
      intent: { kind: "continue-child", parentId: parent.id, childId: parent.child.id },
      relation: "child-probe", action: "preserve", scope: "child-retype",
    });
  }
  if (!parent.child && source?.owner.kind === "parent-mainline" && canCreateParent) {
    const relation = source.relation === "new-parent" || source.relation === "resume-parent"
      ? source.relation : "followup-parent";
    options.push({ intent: { kind: "retype-parent", parentId: parent.id }, relation,
      action: correctedType === parentType ? "preserve" : "retype", scope: "same-question-retype" });
  }
  if (parent.child && correctedType === parentType) {
    const firstChildQuestion = admission?.parentId === parent.id &&
      source?.owner.kind === "active-child" && source.owner.childId === parent.child.id &&
      admission.child?.childId === parent.child.id &&
      admission.child.originLogicalQuestionUnitId === context.target.logicalQuestionUnitId &&
      !admission.child.hasAdditionalLogicalQuestionUnit;
    options.push(firstChildQuestion ? {
      intent: { kind: "merge-first-child", parentId: parent.id, childId: parent.child.id },
      relation: "followup-parent", action: "preserve", scope: "resume-parent",
    } : {
      intent: { kind: "resume-parent", parentId: parent.id, childId: parent.child.id },
      relation: "resume-parent", action: "resume", scope: "resume-parent",
    });
  }
  if (!parent.child && admission?.parentId === parent.id &&
    source?.owner.kind === "parent-mainline" && source.owner.parentId === parent.id &&
    admission.originLogicalQuestionUnitId === context.target.logicalQuestionUnitId &&
    !admission.hasAdditionalLogicalQuestionUnit && !admission.hasChildHistory &&
    recentParent?.sessionId === context.target.sessionId &&
    recentParent.replacedByParentId === parent.id &&
    recentParent.parent.id !== parent.id &&
    normalizeCanonicalQuestionType(recentParent.parent.stableKind) === correctedType &&
    context.recentParentSources?.parentId === recentParent.parent.id &&
    context.recentParentSources.sessionId === context.currentSessionId &&
    context.recentParentSources.records.length > 0 &&
    context.recentParentSources.missingObservationIds.length === 0) {
    options.push({
      intent: { kind: "merge-recent-parent", parentId: recentParent.parent.id, previousParentId: parent.id },
      relation: "followup-parent", action: "resume", scope: "resume-parent",
    });
  }
  return { options: options.map(option => describeCapability(option, context)) };
}

function describeCapability(option: ManualCorrectionCapabilityDecision, context: ManualCorrectionCapabilityContext): ManualCorrectionCapability {
  const intent = option.intent;
  const labels: Record<ManualCorrectionIntent["kind"], string> = {
    independent: "Create an independent question",
    "new-child": context.runtime.parent?.child ? "Create a new child, replacing the current child" : "Create a new child question",
    "continue-child": context.source?.owner.kind === "active-child"
      ? "Continue or change the current child question type" : "Add this question to the current child",
    "retype-parent": option.action === "preserve" ? "Keep the current parent" : "Change the current parent type",
    "merge-first-child": "Merge this first child question into its parent",
    "resume-parent": "Return to the parent question",
    "merge-recent-parent": "Merge this first question into the previous parent",
  };
  const family = intent.kind === "independent" ? "independent"
    : intent.kind === "new-child" || intent.kind === "continue-child" ? "child"
      : intent.kind === "retype-parent" ? "retype" : "merge";
  const targetOwner: ManualCorrectionCapability["targetOwner"] = intent.kind === "independent" ? { kind: "new-parent" }
    : intent.kind === "new-child" ? { kind: "new-child", parentId: intent.parentId }
      : intent.kind === "continue-child" ? { kind: "active-child", parentId: intent.parentId, childId: intent.childId }
        : { kind: "parent-mainline", parentId: intent.parentId };
  return { ...option, id: intent.kind, label: labels[intent.kind], family, targetOwner };
}

export function authorizeManualCorrectionIntent(
  context: ManualCorrectionCapabilityContext,
  correctedType: CanonicalQuestionType,
  intent: ManualCorrectionIntent
): { authorized: true; capability: ManualCorrectionCapability } | { authorized: false; reason: string } {
  const capabilities = getManualCorrectionCapabilities(context, correctedType);
  const capability = capabilities.options.find(option => sameManualCorrectionIntent(option.intent, intent));
  return capability ? { authorized: true, capability }
    : { authorized: false, reason: capabilities.rejectionReason ?? "manual-correction-intent-unavailable" };
}

export function sameManualCorrectionIntent(left: ManualCorrectionIntent, right: ManualCorrectionIntent) {
  if (left.kind !== right.kind) return false;
  if (left.kind === "independent" || right.kind === "independent") return true;
  if (left.parentId !== right.parentId) return false;
  if ("childId" in left || "childId" in right) return "childId" in left && "childId" in right && left.childId === right.childId;
  return !("previousParentId" in left || "previousParentId" in right) ||
    ("previousParentId" in left && "previousParentId" in right && left.previousParentId === right.previousParentId);
}

export function sameManualCorrectionOwner(left: EffectiveQuestionSourceOwner | undefined, right: EffectiveQuestionSourceOwner | undefined) {
  return left?.kind === right?.kind && left?.parentId === right?.parentId &&
    (left?.kind !== "active-child" || right?.kind === "active-child" && left.childId === right.childId);
}

function validateManualCorrectionTarget(context: ManualCorrectionCapabilityContext): string | undefined {
  const { target, currentQuestion: question, runtime, source } = context;
  if (target.sessionId !== context.currentSessionId || question.sessionId !== context.currentSessionId) return "session-mismatch";
  if (target.runtimeEpoch !== context.currentRuntimeEpoch || question.runtimeEpoch > context.currentRuntimeEpoch) return "runtime-epoch-mismatch";
  if (target.logicalQuestionUnitId !== question.logicalQuestionUnitId ||
    target.logicalQuestionRevision !== question.revision || target.sourceHash !== question.sourceHash) return "source-revision-mismatch";
  if (target.manualCorrectionRevision !== context.manualCorrectionRevision) return "manual-correction-revision-mismatch";
  if (target.taskRuntimeRevision !== runtime.revision) return "task-runtime-revision-mismatch";
  if (!question.sourceTurnIds.length && !question.sourceObservationIds.length) return "source-missing";
  if (target.owner && !source) return "source-missing";
  if (source && (source.sessionId !== target.sessionId || source.runtimeEpoch !== question.runtimeEpoch ||
    source.runtimeEpoch > target.runtimeEpoch ||
    source.logicalQuestionUnitId !== target.logicalQuestionUnitId || source.logicalQuestionRevision !== target.logicalQuestionRevision ||
    source.sourceHash !== target.sourceHash || !sameManualCorrectionOwner(source.owner, target.owner))) return "source-owner-mismatch";
  if (target.owner) {
    if (target.owner.parentId !== runtime.parent?.id) return "inactive-owner";
    if (target.owner.kind === "active-child" ? target.owner.childId !== runtime.parent.child?.id : !!runtime.parent.child) return "inactive-branch";
  }
  return undefined;
}
