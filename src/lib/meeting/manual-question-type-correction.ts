import type { ActiveMeetingTask } from "./meeting-task-contracts.js";

import { preserveOrCreateCodingChildPhaseState } from "./coding-child-phase.js";
import type {
  CurrentQuestionSettlementDisposition,
} from "./current-question-settlement.js";
import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import type {
  ActiveInterviewParent,
  AdvisorSuggestion,
  ManualCorrectionScope,
  ParentContextHandoff,
  ManualQuestionTypeCorrection,
  ManualQuestionTypeCorrectionTarget,
  QuestionInstanceLineage,
  SelectedInterviewPlaybook,
  TranscriptTurn,
} from "./types";
import { isCurrentQuestionLineage } from "./question-lineage.js";
import {
  isParentCanonicalQuestionType,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import { isWhiteboardParentType } from "./whiteboard-artifact.js";

export interface ManualCorrectionOperationClaim {
  operationId: string;
  accepted: boolean;
  supersedesOperationId?: string;
  duplicateOfOperationId?: string;
}

export class ManualCorrectionOperationCoordinator {
  private activeOperationId: string | null = null;
  private activeRequestKey: string | null = null;

  claim(
    operationId: string,
    requestKey?: string
  ): ManualCorrectionOperationClaim {
    if (
      requestKey &&
      this.activeOperationId &&
      this.activeRequestKey === requestKey
    ) {
      return {
        operationId,
        accepted: false,
        duplicateOfOperationId: this.activeOperationId,
      };
    }
    const supersedesOperationId = this.activeOperationId ?? undefined;
    this.activeOperationId = operationId;
    this.activeRequestKey = requestKey ?? null;
    return {
      operationId,
      accepted: true,
      supersedesOperationId,
    };
  }

  getActiveOperationId() {
    return this.activeOperationId;
  }

  owns(operationId: string) {
    return this.activeOperationId === operationId;
  }

  release(operationId: string) {
    if (!this.owns(operationId)) return false;
    this.activeOperationId = null;
    this.activeRequestKey = null;
    return true;
  }

  reset() {
    this.activeOperationId = null;
    this.activeRequestKey = null;
  }
}

export type ManualCorrectionTargetKind =
  | "substantive"
  | "non-substantive";

export interface ManualCorrectionTargetHistoryEntry {
  logicalQuestionUnit: LogicalQuestionUnit;
  updatedAt: number;
  targetKind: ManualCorrectionTargetKind;
  settlementDisposition?: CurrentQuestionSettlementDisposition;
  resolvedAt?: number;
}

export interface ManualCorrectionTargetSelection<T> {
  target?: T;
  reason:
    | "latest-unresolved-substantive"
    | "preferred-visible-question"
    | "latest-substantive"
    | "latest-canonical-fallback"
    | "no-target";
}

const MANUAL_CORRECTION_TARGET_HISTORY_LIMIT = 8;

export function classifyManualCorrectionTarget(input: {
  sourceKind: "voice" | "screen" | "mixed";
  text: string;
  intent?: "confirmation" | "logistics" | "incomplete" | string;
  followupScopeSource?: "active-task" | "provisional-question" | "none";
  phaseControl?: boolean;
}): ManualCorrectionTargetKind {
  if (input.sourceKind !== "voice") return "substantive";

  const normalized = input.text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  const isCommunicationMetaTurn =
    /^(?:(?:did|do|can|could) you (?:get|hear|understand|follow) (?:my|the|that) (?:question|point)|(?:did|do) (?:that|this) make sense|are you (?:there|with me)|should i (?:repeat|say) (?:that|it) again|do you (?:want|need) me to repeat)/i.test(
      normalized
    );
  if (
    isCommunicationMetaTurn ||
    input.phaseControl ||
    (input.intent === "constraint-or-follow-up" &&
      input.followupScopeSource === "provisional-question") ||
    input.intent === "confirmation" ||
    input.intent === "logistics" ||
    input.intent === "incomplete"
  ) {
    return "non-substantive";
  }

  return "substantive";
}

export function upsertManualCorrectionTargetHistory<
  T extends ManualCorrectionTargetHistoryEntry,
>(history: readonly T[], target: T): T[] {
  const withoutCurrentUnit = history.filter(
    (candidate) =>
      candidate.logicalQuestionUnit.id !== target.logicalQuestionUnit.id
  );
  return [...withoutCurrentUnit, target]
    .sort((left, right) => left.updatedAt - right.updatedAt)
    .slice(-MANUAL_CORRECTION_TARGET_HISTORY_LIMIT);
}

export function markManualCorrectionTargetResolved<
  T extends ManualCorrectionTargetHistoryEntry,
>(
  history: readonly T[],
  input: {
    logicalQuestionUnitId: string | null | undefined;
    logicalQuestionRevision: number | null | undefined;
    resolvedAt?: number;
  }
): T[] {
  if (
    !input.logicalQuestionUnitId ||
    input.logicalQuestionRevision === null ||
    input.logicalQuestionRevision === undefined
  ) {
    return [...history];
  }
  return history.map((candidate) =>
    candidate.logicalQuestionUnit.id === input.logicalQuestionUnitId &&
    candidate.logicalQuestionUnit.revision === input.logicalQuestionRevision
      ? {
          ...candidate,
          resolvedAt: input.resolvedAt ?? Date.now(),
        }
      : candidate
  );
}

export function selectManualCorrectionTargetFromHistory<
  T extends ManualCorrectionTargetHistoryEntry,
>(input: {
  history: readonly T[];
  latestCanonical?: T;
  preferredLogicalQuestionUnitId?: string | null;
  preferredLogicalQuestionRevision?: number | null;
}): ManualCorrectionTargetSelection<T> {
  const ordered = [...input.history].sort(
    (left, right) => right.updatedAt - left.updatedAt
  );
  const preferred =
    ordered.find(
      (candidate) =>
        candidate.targetKind === "substantive" &&
        candidate.logicalQuestionUnit.id ===
          input.preferredLogicalQuestionUnitId &&
        candidate.logicalQuestionUnit.revision ===
          input.preferredLogicalQuestionRevision
    ) ??
    (input.latestCanonical?.targetKind === "substantive" &&
    input.latestCanonical.logicalQuestionUnit.id ===
      input.preferredLogicalQuestionUnitId &&
    input.latestCanonical.logicalQuestionUnit.revision ===
      input.preferredLogicalQuestionRevision
      ? input.latestCanonical
      : undefined);
  if (preferred) {
    return { target: preferred, reason: "preferred-visible-question" };
  }

  const unresolved = ordered.find(
    (candidate) =>
      candidate.targetKind === "substantive" && !candidate.resolvedAt
  );
  if (unresolved) {
    return {
      target: unresolved,
      reason: "latest-unresolved-substantive",
    };
  }

  const latestSubstantive = ordered.find(
    (candidate) => candidate.targetKind === "substantive"
  );
  if (latestSubstantive) {
    return { target: latestSubstantive, reason: "latest-substantive" };
  }

  const fallback = input.latestCanonical ?? ordered[0];
  return fallback
    ? { target: fallback, reason: "latest-canonical-fallback" }
    : { reason: "no-target" };
}

export interface ManualCorrectionTerminalDecision {
  status: ManualQuestionTypeCorrection["status"];
  regenerationStatus: ManualQuestionTypeCorrection["regenerationStatus"];
  regenerationRetryable: boolean;
  error?: string;
}

export function decideManualCorrectionTerminalState(input: {
  mutationApplied: boolean;
  stableAnswerCommitted: boolean;
  regenerationTraceStatus?: "running" | "success" | "error" | "cancelled";
  authorizationFailureReason?: string;
  failureMessage?: string;
}): ManualCorrectionTerminalDecision {
  if (input.stableAnswerCommitted) {
    return {
      status: input.mutationApplied ? "applied" : "failed",
      regenerationStatus: input.mutationApplied ? "succeeded" : "idle",
      regenerationRetryable: false,
    };
  }
  if (!input.mutationApplied) {
    return {
      status: "failed",
      regenerationStatus: "idle",
      regenerationRetryable: false,
      error:
        input.failureMessage ??
        input.authorizationFailureReason ??
        "The question type correction could not be applied.",
    };
  }

  const cancelled =
    input.regenerationTraceStatus === "cancelled" ||
    Boolean(input.authorizationFailureReason);
  return {
    status: "applied",
    regenerationStatus: cancelled ? "cancelled" : "failed",
    regenerationRetryable: true,
    error:
      input.failureMessage ??
      (input.authorizationFailureReason
        ? `Answer regeneration was cancelled because the correction lost runtime authority: ${input.authorizationFailureReason}. The corrected task type was kept and regeneration can be retried.`
        : "The corrected question produced no valid answer. The previous reliable answer was preserved and regeneration can be retried."),
  };
}

export interface ManualQuestionTypeCorrectionDecision {
  noOp: boolean;
  reason: string;
  target?: ManualQuestionTypeCorrectionTarget;
  detectedType: CanonicalQuestionType;
  correctedType: CanonicalQuestionType;
  parentType: CanonicalQuestionType;
  childType?: CanonicalQuestionType;
}

export type ManualCorrectionTargetResolution =
  | {
      source: "active-task";
      task: ActiveMeetingTask;
      lineage?: QuestionInstanceLineage;
      targetSource: "active-task" | "current-question";
      logicalQuestionUnit?: LogicalQuestionUnit;
    }
  | {
      source: "provisional-question";
      lineage: QuestionInstanceLineage;
      logicalQuestionUnit?: LogicalQuestionUnit;
    }
  | { source: "none"; reason: string };

export function hasManualQuestionTypeCorrectionPresentationTarget(input: {
  hasActiveTask: boolean;
  currentQuestionLineage?: QuestionInstanceLineage;
  latestSuggestion?: Pick<AdvisorSuggestion, "id" | "questionLineage"> | null;
}) {
  if (input.hasActiveTask) return true;
  const suggestion = input.latestSuggestion;
  if (!suggestion) return false;
  const lineage =
    suggestion.questionLineage ?? input.currentQuestionLineage;
  if (!lineage?.sourceSuggestionId) return false;
  return (
    lineage.sourceSuggestionId === suggestion.id &&
    (!suggestion.questionLineage ||
      suggestion.questionLineage.questionInstanceId ===
        lineage.questionInstanceId)
  );
}

export function resolveManualCorrectionTarget(input: {
  activeTask?: ActiveMeetingTask;
  currentQuestionLineage?: QuestionInstanceLineage;
  canonicalLogicalQuestion?: {
    logicalQuestionUnit: LogicalQuestionUnit;
    lineage: QuestionInstanceLineage;
  };
  latestSuggestion: AdvisorSuggestion | null | undefined;
  sessionId: string;
  runtimeEpoch: number;
}): ManualCorrectionTargetResolution {
  const canonicalLogicalQuestion =
    input.canonicalLogicalQuestion?.logicalQuestionUnit.sessionId ===
      input.sessionId &&
    input.canonicalLogicalQuestion.logicalQuestionUnit.runtimeEpoch <=
      input.runtimeEpoch &&
    input.canonicalLogicalQuestion.lineage.questionInstanceId ===
      `lqu:${input.canonicalLogicalQuestion.logicalQuestionUnit.id}` &&
    input.canonicalLogicalQuestion.lineage.triggerTurnId ===
      input.canonicalLogicalQuestion.logicalQuestionUnit.currentTurnId
      ? input.canonicalLogicalQuestion
      : undefined;
  const currentLineage =
    canonicalLogicalQuestion?.lineage ??
    (isCurrentQuestionLineage({
      lineage: input.currentQuestionLineage,
      suggestion: input.latestSuggestion,
      sessionId: input.sessionId,
      runtimeEpoch: input.runtimeEpoch,
    })
      ? input.currentQuestionLineage
      : undefined);

  if (input.activeTask) {
    return {
      source: "active-task",
      task: input.activeTask,
      lineage: currentLineage,
      targetSource: currentLineage ? "current-question" : "active-task",
      ...(canonicalLogicalQuestion
        ? {
            logicalQuestionUnit:
              canonicalLogicalQuestion.logicalQuestionUnit,
          }
        : {}),
    };
  }

  if (currentLineage) {
    return {
      source: "provisional-question",
      lineage: currentLineage,
      ...(canonicalLogicalQuestion
        ? {
            logicalQuestionUnit:
              canonicalLogicalQuestion.logicalQuestionUnit,
          }
        : {}),
    };
  }

  return { source: "none", reason: "no-current-correction-target" };
}

export interface ManualCorrectionScopeDecision {
  // Historical evaluation projection only; explicit intent owns the mutation.
  scope: ManualCorrectionScope;
  reason: string;
  standaloneTaskScore: number;
  standaloneTaskEvidence: string[];
  continuityScore: number;
  continuityEvidence: string[];
  currentQuestionIsParentOrigin: boolean;
  currentQuestionIsChild: boolean;
}







function normalizeDecisionText(text: string) {
  return text.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
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
        noOp: false,
        reason: "manual-correction-targets-current-non-parent-question",
        target: "current-question",
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

export function decideProvisionalQuestionTypeCorrection(
  correctedType: CanonicalQuestionType
): ManualQuestionTypeCorrectionDecision {
  const base = {
    detectedType: "unknown" as const,
    correctedType,
    parentType: "unknown" as const,
    childType: undefined,
  };

  if (correctedType === "unknown") {
    return {
      ...base,
      noOp: true,
      reason: "unknown-is-not-a-manual-correction-target",
    };
  }

  if (!isParentCanonicalQuestionType(correctedType)) {
    return {
      ...base,
      noOp: false,
      reason: "manual-correction-keeps-provisional-question-current-only",
      target: "current-question",
    };
  }

  return {
    ...base,
    noOp: false,
    reason: "manual-correction-promotes-provisional-question",
    target: "provisional-question",
  };
}

export function applyManualQuestionTypeCorrectionToParent({
  parent,
  decision,
  correctedPlaybook,
  now = Date.now(),
}: {
  parent: ActiveInterviewParent;
  decision: ManualQuestionTypeCorrectionDecision;
  correctedPlaybook?: SelectedInterviewPlaybook;
  now?: number;
}): ActiveInterviewParent {
  if (decision.noOp || !decision.target) return parent;

  if (decision.target === "resume-parent") {
    return {
      ...parent,
      child: undefined,
      updatedAt: now,
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
        artifactId: parent.child.questionType === decision.correctedType
          ? parent.child.artifactId : undefined,
        phaseState: preserveOrCreateCodingChildPhaseState({
          questionType: decision.correctedType,
          existing: parent.child.phaseState,
          playbook: correctedPlaybook,
        }),
        updatedAt: now,
      },
      updatedAt: now,
      revisions: parent.revisions + 1,
    };
  }

  if (decision.target === "provisional-question") {
    return parent;
  }

  if (decision.target === "current-question") return parent;

  if (!isParentCanonicalQuestionType(decision.correctedType)) return parent;

  const nextPhase = correctedPlaybook?.phase ?? "follow_up";
  const preserveWhiteboard =
    isWhiteboardParentType(parent.stableKind) &&
    parent.stableKind === decision.correctedType;

  return {
    ...parent,
    stableKind: decision.correctedType,
    playbook: correctedPlaybook,
    playbookPhase: nextPhase,
    phaseProgress: { [nextPhase]: true },
    child: undefined,
    projectBinding: undefined,
    supportedFactAnchors: [],
    whiteboardArtifact: preserveWhiteboard
      ? parent.whiteboardArtifact
      : undefined,
    updatedAt: now,
    revisions: parent.revisions + 1,
  };
}


export function buildBoundedParentContextHandoff({
  parent,
  parentSourceQuestion,
  sourceQuestionId,
  latestQuestionText,
  transcriptTurns,
  boundaryTurnId,
}: {
  parent: ActiveInterviewParent;
  parentSourceQuestion?: string;
  sourceQuestionId: string;
  latestQuestionText: string;
  transcriptTurns: TranscriptTurn[];
  boundaryTurnId?: string;
}): ParentContextHandoff {
  const parentStartIndex = parent.startTurnId
    ? transcriptTurns.findIndex((turn) => turn.id === parent.startTurnId)
    : 0;
  const boundaryIndex = boundaryTurnId
    ? transcriptTurns.findIndex((turn) => turn.id === boundaryTurnId)
    : transcriptTurns.length;
  const safeStart = Math.max(0, parentStartIndex);
  const safeEnd = boundaryIndex >= 0 ? boundaryIndex : transcriptTurns.length;
  const sourceTurns = transcriptTurns.slice(safeStart, safeEnd);
  const sourceText = [parentSourceQuestion ?? "", ...sourceTurns.map((turn) => turn.text)].join(
    "\n"
  );
  const combinedText = `${sourceText}\n${latestQuestionText}`.toLowerCase();
  const productIdentity = inferSharedProductIdentity(sourceText);
  const domainEntities = SHARED_DOMAIN_ENTITIES.filter((entity) =>
    new RegExp(`\\b${entity.replace(/s$/, "s?")}\\b`, "i").test(combinedText)
  );
  const applicableScaleAssumptions = sourceTurns
    .filter(
      (turn) =>
        turn.speaker === "them" &&
        /\b\d[\d,.]*\s*(?:[kmb]|million|billion)?\s*(?:dau|daily active users?|users?|regions?|countries?)\b/i.test(
          turn.text
        ) &&
        !/\b(qps|tps|payment|gps|dispatch|storage|orders? per second)\b/i.test(
          turn.text
        )
    )
    .slice(-4)
    .map((turn) => ({
      value: turn.text.trim().slice(0, 220),
      sourceTurnId: turn.id,
    }));
  const sharedRequirements = sourceTurns
    .filter(
      (turn) =>
        turn.speaker === "them" &&
        /\b(privacy|global availability|multi-region|latency requirement|data residency)\b/i.test(
          turn.text
        ) &&
        !/\b(payment|gps|dispatch|qps|tps)\b/i.test(turn.text)
    )
    .slice(-4)
    .map((turn) => `${turn.text.trim().slice(0, 180)} [source=${turn.id}]`);

  return {
    sourceParentId: parent.id,
    transitionKind: "domain-extension",
    sourceQuestionId,
    sharedScenarioContext: {
      productIdentity,
      domainEntities: domainEntities.length ? domainEntities : undefined,
      applicableScaleAssumptions: applicableScaleAssumptions.length
        ? applicableScaleAssumptions
        : undefined,
      sharedRequirements: sharedRequirements.length
        ? sharedRequirements
        : undefined,
    },
    excludedContextKinds: [
      "generated-answers",
      "phase-progress",
      "subsystem-qps",
      "prior-artifacts",
      "project-binding",
      "fact-anchors",
    ],
  };
}

const SHARED_PRODUCT_IDENTITIES = [
  "food delivery",
  "ride sharing",
  "ride-sharing",
  "travel planning",
  "trip planning",
  "ticket selling",
  "social network",
  "e-commerce",
];

const SHARED_DOMAIN_ENTITIES = [
  "users",
  "restaurants",
  "menus",
  "orders",
  "drivers",
  "riders",
  "trips",
  "items",
  "catalog",
  "merchants",
  "travelers",
];

function inferSharedProductIdentity(text: string) {
  const normalized = normalizeDecisionText(text);
  return SHARED_PRODUCT_IDENTITIES.find((identity) =>
    normalized.includes(identity)
  );
}
