import type { ActiveMeetingTask } from "./active-meeting-task";
import type {
  ActiveInterviewParent,
  AdvisorSuggestion,
  ManualCorrectionScope,
  ManualQuestionTypeCorrectionTarget,
  QuestionInstanceLineage,
  SelectedInterviewPlaybook,
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
  supersedesOperationId?: string;
}

export class ManualCorrectionOperationCoordinator {
  private activeOperationId: string | null = null;

  claim(operationId: string): ManualCorrectionOperationClaim {
    const supersedesOperationId = this.activeOperationId ?? undefined;
    this.activeOperationId = operationId;
    return {
      operationId,
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
    return true;
  }

  reset() {
    this.activeOperationId = null;
  }
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
    }
  | {
      source: "provisional-question";
      lineage: QuestionInstanceLineage;
    }
  | { source: "none"; reason: string };

export function resolveManualCorrectionTarget(input: {
  activeTask?: ActiveMeetingTask;
  currentQuestionLineage?: QuestionInstanceLineage;
  latestSuggestion: AdvisorSuggestion | null | undefined;
  sessionId: string;
  runtimeEpoch: number;
}): ManualCorrectionTargetResolution {
  const currentLineage = isCurrentQuestionLineage({
    lineage: input.currentQuestionLineage,
    suggestion: input.latestSuggestion,
    sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch,
  })
    ? input.currentQuestionLineage
    : undefined;

  if (input.activeTask) {
    return {
      source: "active-task",
      task: input.activeTask,
      lineage: currentLineage,
      targetSource: currentLineage ? "current-question" : "active-task",
    };
  }

  if (currentLineage) {
    return {
      source: "provisional-question",
      lineage: currentLineage,
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

export function decideManualCorrectionScope({
  task,
  decision,
  lineage,
  latestQuestionText,
  parentQuestionText,
  classifierConfidence,
  explicitTaskSwitch = false,
}: {
  task?: ActiveMeetingTask;
  decision: ManualQuestionTypeCorrectionDecision;
  lineage?: QuestionInstanceLineage;
  latestQuestionText: string;
  parentQuestionText?: string;
  classifierConfidence?: number;
  explicitTaskSwitch?: boolean;
}): ManualCorrectionScopeDecision {
  const currentQuestionIsChild = Boolean(
    task?.child &&
      (task.child.basedOnTurnIds.includes(lineage?.triggerTurnId ?? "") ||
        task.child.question.trim() === latestQuestionText.trim())
  );
  const currentQuestionIsParentOrigin = Boolean(
    task &&
      lineage?.triggerTurnId &&
      task.parent.startTurnId === lineage.triggerTurnId
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

  if (decision.target === "resume-parent") {
    return {
      ...base,
      scope: "resume-parent",
      reason: "manual-correction-resumes-parent-from-current-child",
    };
  }

  if (decision.target === "child" || currentQuestionIsChild) {
    return {
      ...base,
      scope: "child-retype",
      reason: "manual-correction-targets-current-child-question",
    };
  }

  if (!task || decision.target === "provisional-question") {
    return {
      ...base,
      scope: "independent-new-parent",
      reason: "manual-correction-promotes-question-without-active-parent",
    };
  }

  if (currentQuestionIsParentOrigin || standalone.score < 3) {
    return {
      ...base,
      scope: "same-question-retype",
      reason: currentQuestionIsParentOrigin
        ? "current-question-is-active-parent-origin"
        : "current-question-is-not-standalone-parent-eligible",
    };
  }

  if (continuity.score <= 0) {
    return {
      ...base,
      scope: "independent-new-parent",
      reason: "standalone-question-has-no-parent-domain-continuity",
    };
  }

  return {
    ...base,
    scope: "linked-parent-extension",
    reason:
      continuity.score >= 4
        ? "standalone-question-explicitly-extends-parent-domain"
        : "standalone-question-keeps-minimal-conservative-parent-link",
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
        noOp: true,
        reason: "non-parent-correction-requires-active-child",
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
      noOp: true,
      reason: "provisional-correction-requires-parent-type",
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

  if (!isParentCanonicalQuestionType(decision.correctedType)) return parent;

  const nextPhase = correctedPlaybook?.phase ?? "follow_up";
  const preserveWhiteboard =
    isWhiteboardParentType(parent.stableKind) &&
    isWhiteboardParentType(decision.correctedType);
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
