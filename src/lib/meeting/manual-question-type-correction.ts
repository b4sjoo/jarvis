import type { ActiveMeetingTask } from "./active-meeting-task";
import type {
  CurrentQuestionRelation,
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
  areCompatibleParentContinuityTypes,
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
    input.canonicalLogicalQuestion.logicalQuestionUnit.runtimeEpoch ===
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
  scope: ManualCorrectionScope;
  reason: string;
  standaloneTaskScore: number;
  standaloneTaskEvidence: string[];
  continuityScore: number;
  continuityEvidence: string[];
  currentQuestionIsParentOrigin: boolean;
  currentQuestionIsChild: boolean;
}

export interface ManualCorrectionParentTransition {
  parent: ActiveInterviewParent;
  previousParentId: string;
  nextParentId: string;
  parentHandoff?: ParentContextHandoff;
  preservedContextFields: string[];
  clearedContextFields: string[];
  promptTranscriptStartTurnId?: string;
  startedNewParent: boolean;
}

export function decideManualCorrectionScope({
  task,
  decision,
  lineage,
  latestQuestionText,
  parentQuestionText,
  classifierConfidence,
  explicitTaskSwitch = false,
  currentQuestionMatchesParentOrigin = false,
  currentQuestionRelation,
  currentQuestionSource,
}: {
  task?: ActiveMeetingTask;
  decision: ManualQuestionTypeCorrectionDecision;
  lineage?: QuestionInstanceLineage;
  latestQuestionText: string;
  parentQuestionText?: string;
  classifierConfidence?: number;
  explicitTaskSwitch?: boolean;
  currentQuestionMatchesParentOrigin?: boolean;
  currentQuestionRelation?: CurrentQuestionRelation;
  currentQuestionSource?: "voice" | "screen" | "mixed";
}): ManualCorrectionScopeDecision {
  const currentQuestionIsChild = Boolean(
    task?.child &&
      (task.child.basedOnTurnIds.includes(lineage?.triggerTurnId ?? "") ||
        task.child.question.trim() === latestQuestionText.trim())
  );
  const currentQuestionIsParentOrigin = Boolean(
    currentQuestionMatchesParentOrigin ||
      (task &&
        lineage?.triggerTurnId &&
        task.parent.startTurnId === lineage.triggerTurnId)
  );
  const standalone = scoreStandaloneTask(
    latestQuestionText,
    classifierConfidence
  );
  const continuity = scoreParentContinuity({
    latestQuestionText,
    parentQuestionText: parentQuestionText ?? task?.parent.topic ?? "",
    explicitTaskSwitch,
  });
  const base = {
    standaloneTaskScore: standalone.score,
    standaloneTaskEvidence: standalone.evidence,
    continuityScore: continuity.score,
    continuityEvidence: continuity.evidence,
    currentQuestionIsParentOrigin,
    currentQuestionIsChild,
  };

  if (currentQuestionRelation === "resume-parent") {
    return {
      ...base,
      scope: "resume-parent",
      reason: "committed-relation-resumes-parent-from-current-child",
    };
  }

  if (
    currentQuestionRelation === "child-probe" ||
    currentQuestionIsChild
  ) {
    return {
      ...base,
      scope: "child-retype",
      reason: "manual-correction-targets-current-child-question",
    };
  }

  if (decision.target === "current-question") {
    return {
      ...base,
      scope: "current-only",
      reason: "manual-correction-targets-current-non-parent-question",
    };
  }

  if (!task) {
    return {
      ...base,
      scope: "independent-new-parent",
      reason: "manual-correction-promotes-question-without-active-parent",
    };
  }

  if (currentQuestionIsParentOrigin) {
    return {
      ...base,
      scope: "same-question-retype",
      reason: "current-question-is-active-parent-origin",
    };
  }

  if (currentQuestionRelation === "new-parent") {
    return {
      ...base,
      scope:
        continuity.score >= 4
          ? "linked-parent-extension"
          : "independent-new-parent",
      reason:
        continuity.score >= 4
          ? "authorized-new-parent-keeps-bounded-domain-link"
          : "authorized-new-parent-re-roots-current-question",
    };
  }

  return {
    ...base,
    scope: "current-only",
    reason:
      currentQuestionRelation === "unknown"
        ? `${currentQuestionSource ?? "unknown"}-question-relation-unsettled`
        : "type-correction-parent-mutation-not-authorized",
  };
}

function scoreStandaloneTask(text: string, classifierConfidence?: number) {
  const normalized = normalizeDecisionText(text);
  const evidence: string[] = [];
  let score = 0;
  const taskVerbPattern =
    /\b(design|build|implement|explain|compare|estimate|evaluate|architect|develop|create|write|solve)\b/i;
  const taskVerbMatch = normalized.match(taskVerbPattern);
  if (taskVerbMatch) {
    score += 2;
    evidence.push(`explicit-task-verb:${taskVerbMatch[1].toLowerCase()}`);
  }

  const objectTokens = extractDomainTokens(
    taskVerbMatch
      ? normalized.slice((taskVerbMatch.index ?? 0) + taskVerbMatch[0].length)
      : normalized
  );
  if (objectTokens.length >= 2) {
    score += 2;
    evidence.push(`complete-target-object:${objectTokens.slice(0, 4).join(",")}`);
  }

  if (/\?$/.test(text.trim()) || Boolean(taskVerbMatch)) {
    score += 1;
    evidence.push("complete-interrogative-or-imperative");
  }

  if ((classifierConfidence ?? 0) >= 0.65) {
    score += 1;
    evidence.push("parent-classifier-confidence>=0.65");
  }

  if (
    /\b(it|that|this|this part|that part|the previous one)\b[?.!]*$/i.test(
      normalized
    ) && objectTokens.length < 2
  ) {
    score -= 2;
    evidence.push("unresolved-pronoun-only");
  }

  if (
    /^(?:in\s+\w+|at\s+[\d.]+\s*[kmb]?|what about|how about|and\s+(?:failures|latency|scale|qps)|(?:estimate\s+)?qps)\b/i.test(
      normalized
    )
  ) {
    score -= 2;
    evidence.push("constraint-or-local-followup");
  }

  return { score, evidence };
}

function scoreParentContinuity({
  latestQuestionText,
  parentQuestionText,
  explicitTaskSwitch,
}: {
  latestQuestionText: string;
  parentQuestionText: string;
  explicitTaskSwitch: boolean;
}) {
  const latest = normalizeDecisionText(latestQuestionText);
  const parent = normalizeDecisionText(parentQuestionText);
  const evidence: string[] = [];
  let score = 0;

  if (
    /\b(for this (?:app|system|platform|product)|add (?:it|this) to (?:the )?(?:existing|current) (?:app|system|platform)|within this (?:app|system|platform)|on top of this system)\b/i.test(
      latest
    )
  ) {
    score += 3;
    evidence.push("explicit-same-system-marker");
  }

  const sharedTokens = extractDomainTokens(latest).filter((token) =>
    extractDomainTokens(parent).includes(token)
  );
  if (sharedTokens.length) {
    score += 2;
    evidence.push(`shared-domain-entities:${sharedTokens.slice(0, 4).join(",")}`);
  }

  if (
    /\b(using|consume|based on|from)\b.{0,40}\b(data|events|orders|users|catalog|service|api)\b/i.test(
      latest
    )
  ) {
    score += 2;
    evidence.push("consumes-parent-data-or-service");
  }

  if (/\b(same scale|same traffic|same users|same dau|existing constraints)\b/i.test(latest)) {
    score += 1;
    evidence.push("explicitly-reuses-parent-scale-or-constraint");
  }

  if (
    explicitTaskSwitch ||
    /\b(next question|move on|another (?:question|system|problem)|separately|unrelated)\b/i.test(
      latest
    )
  ) {
    score -= 3;
    evidence.push("explicit-task-switch");
  }

  if (!sharedTokens.length && !evidence.some((item) =>
    item === "explicit-same-system-marker" ||
    item === "consumes-parent-data-or-service"
  )) {
    score -= 2;
    evidence.push("no-shared-product-entity-or-data");
  }

  return { score, evidence };
}

const DECISION_STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "this",
  "that",
  "it",
  "for",
  "to",
  "of",
  "and",
  "or",
  "how",
  "would",
  "you",
  "we",
  "please",
  "design",
  "build",
  "implement",
  "explain",
  "compare",
  "estimate",
  "evaluate",
  "architect",
  "develop",
  "create",
  "write",
  "solve",
  "system",
  "app",
  "application",
  "service",
  "platform",
  "agent",
  "new",
  "self",
  "evolving",
]);

function extractDomainTokens(text: string) {
  return Array.from(
    new Set(
      normalizeDecisionText(text)
        .split(/[^a-z0-9]+/)
        .filter(
          (token) =>
            token.length >= 4 &&
            !DECISION_STOP_WORDS.has(token) &&
            !/^\d+$/.test(token)
        )
    )
  );
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
  expiresAt,
}: {
  parent: ActiveInterviewParent;
  decision: ManualQuestionTypeCorrectionDecision;
  correctedPlaybook?: SelectedInterviewPlaybook;
  now?: number;
  expiresAt?: number;
}): ActiveInterviewParent {
  if (decision.noOp || !decision.target) return parent;

  if (decision.target === "resume-parent") {
    return {
      ...parent,
      child: undefined,
      updatedAt: now,
      expiresAt,
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
        compactSummary: undefined,
        updatedAt: now,
      },
      updatedAt: now,
      expiresAt,
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
  const preserveAnswerContinuity = areCompatibleParentContinuityTypes(
    parent.stableKind,
    decision.correctedType
  );

  return {
    ...parent,
    stableKind: decision.correctedType,
    playbook: correctedPlaybook,
    playbookPhase: nextPhase,
    phaseProgress: { [nextPhase]: true },
    child: undefined,
    projectBinding: undefined,
    supportedFactAnchors: [],
    previousUsefulAnswer: preserveAnswerContinuity
      ? parent.previousUsefulAnswer
      : undefined,
    latestUsefulAnswer: preserveAnswerContinuity
      ? parent.latestUsefulAnswer
      : undefined,
    whiteboardArtifact: preserveWhiteboard
      ? parent.whiteboardArtifact
      : undefined,
    updatedAt: now,
    expiresAt,
    revisions: parent.revisions + 1,
  };
}

export function buildManualCorrectionParentTransition({
  parent,
  decision,
  scopeDecision,
  correctedPlaybook,
  latestQuestionText,
  lineage,
  transcriptTurns,
  newParentId,
  source = parent.source,
  now = Date.now(),
  expiresAt,
}: {
  parent: ActiveInterviewParent;
  decision: ManualQuestionTypeCorrectionDecision;
  scopeDecision: ManualCorrectionScopeDecision;
  correctedPlaybook?: SelectedInterviewPlaybook;
  latestQuestionText: string;
  lineage?: QuestionInstanceLineage;
  transcriptTurns: TranscriptTurn[];
  newParentId: string;
  source?: "screen" | "voice";
  now?: number;
  expiresAt?: number;
}): ManualCorrectionParentTransition {
  if (scopeDecision.scope === "current-only") {
    return {
      parent,
      previousParentId: parent.id,
      nextParentId: parent.id,
      preservedContextFields: [
        "active-parent-read-only",
        "current-question-type-authority",
      ],
      clearedContextFields: [],
      promptTranscriptStartTurnId: parent.promptTranscriptStartTurnId,
      startedNewParent: false,
    };
  }

  const shouldStartNewParent =
    decision.target !== "provisional-question" &&
    (scopeDecision.scope === "linked-parent-extension" ||
      scopeDecision.scope === "independent-new-parent");

  if (!shouldStartNewParent) {
    const correctedParent = applyManualQuestionTypeCorrectionToParent({
      parent,
      decision,
      correctedPlaybook,
      now,
      expiresAt,
    });
    const isolatedCorrectedParent =
      scopeDecision.scope === "same-question-retype"
        ? {
            ...correctedParent,
            latestUsefulAnswer: undefined,
            previousUsefulAnswer: undefined,
          }
        : correctedParent;
    const questionInstanceId = lineage?.questionInstanceId;
    const whiteboardArtifact = isolatedCorrectedParent.whiteboardArtifact
      ? {
          ...isolatedCorrectedParent.whiteboardArtifact,
          questionInstanceId:
            isolatedCorrectedParent.whiteboardArtifact.questionInstanceId ??
            questionInstanceId,
        }
      : undefined;
    return {
      parent: {
        ...isolatedCorrectedParent,
        originQuestionId:
          isolatedCorrectedParent.originQuestionId ?? questionInstanceId,
        whiteboardArtifact,
      },
      previousParentId: parent.id,
      nextParentId: isolatedCorrectedParent.id,
      preservedContextFields: [
        "parent-id",
        "question-origin",
        ...(whiteboardArtifact ? ["compatible-whiteboard-draft"] : []),
      ],
      clearedContextFields:
        scopeDecision.scope === "child-retype" ||
        scopeDecision.scope === "resume-parent"
          ? []
          : [
              "generated-answers",
              "unsupported-fact-anchors",
              "incompatible-project-binding",
            ],
      promptTranscriptStartTurnId:
        isolatedCorrectedParent.promptTranscriptStartTurnId,
      startedNewParent: false,
    };
  }

  if (!isParentCanonicalQuestionType(decision.correctedType)) {
    return {
      parent,
      previousParentId: parent.id,
      nextParentId: parent.id,
      preservedContextFields: [],
      clearedContextFields: [],
      promptTranscriptStartTurnId: parent.promptTranscriptStartTurnId,
      startedNewParent: false,
    };
  }

  const startTurnId = lineage?.triggerTurnId;
  const parentHandoff =
    scopeDecision.scope === "linked-parent-extension"
      ? buildBoundedParentContextHandoff({
          parent,
          sourceQuestionId:
            lineage?.questionInstanceId ?? `question:${newParentId}`,
          latestQuestionText,
          transcriptTurns,
          boundaryTurnId: startTurnId,
        })
      : undefined;
  const nextPhase = correctedPlaybook?.phase ?? "follow_up";
  const nextParent: ActiveInterviewParent = {
    id: newParentId,
    source,
    stableKind: decision.correctedType,
    topic: latestQuestionText.trim() || "Current interview question",
    playbook: correctedPlaybook,
    playbookPhase: nextPhase,
    phaseProgress: { [nextPhase]: true },
    supportedFactAnchors: [],
    createdAt: now,
    updatedAt: now,
    expiresAt,
    originQuestionId: lineage?.questionInstanceId,
    startTurnId,
    promptTranscriptStartTurnId: startTurnId,
    parentContextHandoff: parentHandoff,
    revisions: 1,
  };

  return {
    parent: nextParent,
    previousParentId: parent.id,
    nextParentId: nextParent.id,
    parentHandoff,
    preservedContextFields: parentHandoff
      ? [
          "shared-product-identity",
          "shared-domain-entities",
          "applicable-source-backed-assumptions",
        ]
      : [],
    clearedContextFields: [
      "generated-answers",
      "phase-progress",
      "project-binding",
      "fact-anchors",
      "subsystem-qps",
      "prior-artifacts",
      "prior-transcript-window",
    ],
    promptTranscriptStartTurnId: startTurnId,
    startedNewParent: true,
  };
}

export function buildBoundedParentContextHandoff({
  parent,
  sourceQuestionId,
  latestQuestionText,
  transcriptTurns,
  boundaryTurnId,
}: {
  parent: ActiveInterviewParent;
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
  const sourceText = [parent.topic, ...sourceTurns.map((turn) => turn.text)].join(
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
