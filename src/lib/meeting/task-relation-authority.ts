import {
  canParentQuestionTypeOwnChild,
  isParentCanonicalQuestionType,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import type { InterviewTaskRelation } from "./types.js";

export interface TaskRelationLexicalHintDecision {
  relation: InterviewTaskRelation;
  proposedRelation?: InterviewTaskRelation;
  relationEvidenceAuthorized: boolean;
  reason: string;
  evidenceSpans: string[];
}

export function projectCrossTypeTaskRelationHint(input: {
  activeQuestionType?: unknown;
  candidateQuestionType?: unknown;
  currentText: string;
  explicitTaskSwitch?: boolean;
}): TaskRelationLexicalHintDecision | undefined {
  const activeQuestionType = normalizeCanonicalQuestionType(
    input.activeQuestionType
  );
  const candidateQuestionType = normalizeCanonicalQuestionType(
    input.candidateQuestionType
  );
  if (
    !activeQuestionType ||
    !candidateQuestionType ||
    candidateQuestionType === "unknown"
  ) {
    return undefined;
  }

  const projectSwitchEvidence = findEvidenceSpans(
    input.currentText,
    EXPLICIT_PROJECT_SWITCH_PATTERNS
  );
  if (
    activeQuestionType === "project-deep-dive" &&
    candidateQuestionType === "project-deep-dive" &&
    projectSwitchEvidence.length > 0
  ) {
    return {
      relation: "unknown",
      proposedRelation: "new-parent",
      relationEvidenceAuthorized: false,
      reason: "explicit-project-switch-evidence-only",
      evidenceSpans: projectSwitchEvidence,
    };
  }

  if (input.explicitTaskSwitch) {
    return {
      relation: "unknown",
      proposedRelation: "new-parent",
      relationEvidenceAuthorized: false,
      reason: isParentCanonicalQuestionType(candidateQuestionType)
        ? "explicit-task-switch-evidence-only"
        : "explicit-task-switch-nonparent-hint",
      evidenceSpans: findEvidenceSpans(
        input.currentText,
        EXPLICIT_TASK_SWITCH_PATTERNS
      ),
    };
  }

  const designRevisionEvidence = findEvidenceSpans(
    input.currentText,
    DESIGN_PARENT_REVISION_PATTERNS
  );
  if (
    isDesignParentType(activeQuestionType) &&
    designRevisionEvidence.length > 0 &&
    !(
      activeQuestionType === "general-system-design" &&
      candidateQuestionType === "ai-ml-system-design"
    ) &&
    candidateQuestionType !== "coding" &&
    candidateQuestionType !== "behavioral" &&
    candidateQuestionType !== "project-deep-dive"
  ) {
    return {
      relation: "unknown",
      proposedRelation: "followup-parent",
      relationEvidenceAuthorized: false,
      reason: "explicit-design-parent-revision-hint",
      evidenceSpans: designRevisionEvidence,
    };
  }

  if (activeQuestionType === candidateQuestionType) {
    return undefined;
  }

  const bindingEvidence = findEvidenceSpans(
    input.currentText,
    EXPLICIT_PARENT_BINDING_PATTERNS
  );
  if (
    bindingEvidence.length > 0 &&
    canParentQuestionTypeOwnChild(activeQuestionType, candidateQuestionType)
  ) {
    return {
      relation: "unknown",
      proposedRelation: "child-probe",
      relationEvidenceAuthorized: false,
      reason: "explicit-parent-binding-hint",
      evidenceSpans: bindingEvidence,
    };
  }

  if (
    canParentQuestionTypeOwnChild(activeQuestionType, candidateQuestionType)
  ) {
    return {
      relation: "unknown",
      proposedRelation: "child-probe",
      relationEvidenceAuthorized: false,
      reason: "cross-type-parent-binding-missing",
      evidenceSpans: [],
    };
  }

  return {
    relation: "unknown",
    proposedRelation: isParentCanonicalQuestionType(candidateQuestionType)
      ? "new-parent"
      : undefined,
    relationEvidenceAuthorized: false,
    reason: "cross-type-task-relation-unresolved",
    evidenceSpans: [],
  };
}

export function projectActiveParentTaskRelationHint(input: {
  hasLatestUsefulText: boolean;
  hasActiveChild: boolean;
  explicitResume: boolean;
  broadResumeProposal: boolean;
}): TaskRelationLexicalHintDecision | undefined {
  if (!input.hasLatestUsefulText) return undefined;

  if (input.hasActiveChild && input.explicitResume) {
    return {
      relation: "unknown",
      proposedRelation: "resume-parent",
      relationEvidenceAuthorized: false,
      reason: "explicit-resume-parent-hint",
      evidenceSpans: [],
    };
  }

  return {
    relation: "unknown",
    proposedRelation:
      input.hasActiveChild && input.broadResumeProposal
        ? "resume-parent"
        : "followup-parent",
    relationEvidenceAuthorized: false,
    reason:
      input.hasActiveChild && input.broadResumeProposal
        ? "broad-resume-proposal-nonauthoritative"
        : "ordinary-active-parent-text-relation-unresolved",
    evidenceSpans: [],
  };
}

export function isExplicitResumeParentTranscript(text: string) {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;

  return (
    /\b(?:back|return|go back)\s+to\s+(?:the\s+)?(?:original|previous|main|parent)\s+(?:question|task|design|architecture|system|project|topic)\b/i.test(
      normalized
    ) ||
    /\b(?:back|return|go back)\s+to\s+(?:the\s+)?(?:original|previous|main|parent)(?:\s+[\p{L}\p{N}-]+){1,4}\s+(?:question|task|design|architecture|system|project|topic)\b/iu.test(
      normalized
    ) ||
    /\bresume\s+(?:the\s+)?(?:original|previous|main|parent)\s+(?:question|task|design|architecture|system|project|topic)\b/i.test(
      normalized
    ) ||
    /回到(?:原来|之前|刚才|主线|父任务).{0,8}(?:问题|任务|设计|架构|系统|项目|话题)|恢复(?:原来|之前|刚才|主线).{0,8}(?:问题|任务|设计|架构|系统|项目|话题)?/.test(
      text
    )
  );
}

export function formatTaskRelationLexicalHintForTrace(
  decision: TaskRelationLexicalHintDecision | undefined
): Record<string, unknown> {
  if (!decision) return {};
  return {
    taskRelationEvidenceAuthorized:
      decision.relationEvidenceAuthorized,
    taskRelationAuthorityReason: decision.reason,
    taskRelationEvidenceSpans: decision.evidenceSpans,
    taskRelationNonAuthoritativeProposal:
      decision.proposedRelation,
  };
}

function isDesignParentType(type: CanonicalQuestionType) {
  return (
    type === "general-system-design" ||
    type === "ai-ml-system-design"
  );
}

function findEvidenceSpans(text: string, patterns: RegExp[]) {
  const spans: string[] = [];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[0]) spans.push(match[0].trim());
  }
  return Array.from(new Set(spans));
}

const EXPLICIT_TASK_SWITCH_PATTERNS = [
  /\b(?:now|next|then)\s+(?:let'?s\s+)?(?:move|switch|turn|go)\s+(?:on\s+)?(?:to|into)\b/i,
  /\b(?:a|the)\s+(?:new|separate|unrelated)\s+(?:question|problem|task)\b/i,
];

const EXPLICIT_PROJECT_SWITCH_PATTERNS = [
  /\b(?:another|different|separate)\b.{0,90}\b(?:project|system|service|feature|platform|example)\b.{0,140}\b(?:you(?:['’]ve| have)?\s+(?:owned|built|designed|implemented|developed|led|worked on)|from your (?:work|experience|background))\b/i,
  /\b(?:tell me about|describe|walk me through|give me an example of)\b.{0,90}\b(?:another|different|separate)\b.{0,90}\b(?:project|system|service|feature|platform|example)\b/i,
  /(?:另一个|另外一个|不同的|其他的).{0,50}(?:项目|系统|服务|功能|经历).{0,70}(?:你负责|你做过|你设计|你实现|你拥有|你参与)/u,
];

const EXPLICIT_PARENT_BINDING_PATTERNS = [
  /\b(?:for|in|within|inside|using|from)\s+(?:this|that|the|our|your)(?:\s+[\w-]+){0,3}\s+(?:system|design|architecture|pipeline|component|service|project|application|app|feature|model|solution)\b/i,
  /\b(?:used by|part of|inside)\s+(?:the|this|that|our|your)(?:\s+[\w-]+){0,3}\s+(?:system|design|architecture|pipeline|component|service|project|application|app|feature|model|solution)\b/i,
  /\b(?:the|this|that)\s+(?:system|design|architecture|pipeline|component|service|project|application|app|feature|model|solution)\s+(?:we|you)\s+(?:just|previously)?\s*(?:discussed|designed|proposed|mentioned|described)\b/i,
  /\b(?:we|you)\s+(?:just|previously)\s+(?:discussed|designed|proposed|mentioned|described)\b/i,
];

const DESIGN_PARENT_REVISION_PATTERNS = [
  /\b(?:add|change|update|modify|replace|remove|keep|preserve|revise|redraw|scale)\b.{0,100}\b(?:components?|services?|architecture|design|write path|read path|data flow|pipeline)\b/i,
  /\b(?:which|what)\s+(?:components?|services?|parts?|paths?)\s+(?:need|would|should|have)\s+(?:to\s+)?(?:change|update|move|scale|be modified)\b/i,
  /(?:增加|修改|更新|替换|删除|保留|重画|扩展).{0,60}(?:组件|服务|架构|设计|写路径|读路径|数据流|流水线)/u,
];
