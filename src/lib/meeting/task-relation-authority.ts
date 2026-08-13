import {
  isParentCanonicalQuestionType,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import type { InterviewTaskRelation } from "./types.js";

export type TaskRelationAuthorityDisposition =
  | "authorized"
  | "response-only";

export interface TaskRelationAuthorityDecision {
  relation: InterviewTaskRelation;
  proposedRelation?: InterviewTaskRelation;
  disposition: TaskRelationAuthorityDisposition;
  relationEvidenceAuthorized: boolean;
  reason: string;
  evidenceSpans: string[];
}

export function decideCrossTypeTaskRelationAuthority(input: {
  activeQuestionType?: unknown;
  candidateQuestionType?: unknown;
  currentText: string;
  explicitTaskSwitch?: boolean;
}): TaskRelationAuthorityDecision | undefined {
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
      relation: "new-parent",
      disposition: "authorized",
      relationEvidenceAuthorized: true,
      reason: "explicit-project-switch",
      evidenceSpans: projectSwitchEvidence,
    };
  }

  if (input.explicitTaskSwitch) {
    if (!isParentCanonicalQuestionType(candidateQuestionType)) {
      return {
        relation: "unknown",
        proposedRelation: "new-parent",
        disposition: "response-only",
        relationEvidenceAuthorized: true,
        reason: "explicit-task-switch-nonparent-response-only",
        evidenceSpans: findEvidenceSpans(
          input.currentText,
          EXPLICIT_TASK_SWITCH_PATTERNS
        ),
      };
    }

    return {
      relation: "new-parent",
      disposition: "authorized",
      relationEvidenceAuthorized: true,
      reason: "explicit-task-switch",
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
      relation: "followup-parent",
      disposition: "authorized",
      relationEvidenceAuthorized: true,
      reason: "explicit-design-parent-revision",
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
    parentCanOwnBoundedChild(activeQuestionType) &&
    isBoundedChildType(candidateQuestionType)
  ) {
    return {
      relation: "child-probe",
      disposition: "authorized",
      relationEvidenceAuthorized: true,
      reason: "explicit-parent-binding",
      evidenceSpans: bindingEvidence,
    };
  }

  if (
    parentCanOwnBoundedChild(activeQuestionType) &&
    isBoundedChildType(candidateQuestionType)
  ) {
    return {
      relation: "unknown",
      proposedRelation: "child-probe",
      disposition: "response-only",
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
    disposition: "response-only",
    relationEvidenceAuthorized: false,
    reason: "cross-type-task-relation-unresolved",
    evidenceSpans: [],
  };
}

export function decideActiveParentTaskRelationAuthority(input: {
  hasLatestUsefulText: boolean;
  hasActiveChild: boolean;
  explicitResume: boolean;
  correction: boolean;
  logistics: boolean;
  broadResumeProposal: boolean;
}): TaskRelationAuthorityDecision | undefined {
  if (!input.hasLatestUsefulText) return undefined;

  if (input.hasActiveChild && input.explicitResume) {
    return {
      relation: "resume-parent",
      disposition: "authorized",
      relationEvidenceAuthorized: true,
      reason: "explicit-resume-parent",
      evidenceSpans: [],
    };
  }

  if (input.correction) {
    return {
      relation: "correction",
      disposition: "authorized",
      relationEvidenceAuthorized: true,
      reason: "explicit-constraint-or-correction",
      evidenceSpans: [],
    };
  }

  if (input.logistics) {
    return {
      relation: "logistics",
      disposition: "authorized",
      relationEvidenceAuthorized: true,
      reason: "explicit-meeting-logistics",
      evidenceSpans: [],
    };
  }

  return {
    relation: "unknown",
    proposedRelation:
      input.hasActiveChild && input.broadResumeProposal
        ? "resume-parent"
        : "followup-parent",
    disposition: "response-only",
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
    /\b(back to|return to|go back to|continue|resume|for the original question|for the previous question|for the system we discussed)\b/i.test(
      normalized
    ) ||
    /回到|继续刚才|刚才那个系统|刚才的问题|恢复主线/.test(text)
  );
}

export function formatTaskRelationAuthorityForTrace(
  decision: TaskRelationAuthorityDecision | undefined
): Record<string, unknown> {
  if (!decision) return {};
  return {
    taskRelationAuthorityDisposition: decision.disposition,
    taskRelationEvidenceAuthorized:
      decision.relationEvidenceAuthorized,
    taskRelationAuthorityReason: decision.reason,
    taskRelationEvidenceSpans: decision.evidenceSpans,
    taskRelationNonAuthoritativeProposal:
      decision.proposedRelation,
  };
}

function parentCanOwnBoundedChild(type: CanonicalQuestionType) {
  return (
    type === "ai-ml-system-design" ||
    type === "general-system-design" ||
    type === "project-deep-dive"
  );
}

function isDesignParentType(type: CanonicalQuestionType) {
  return (
    type === "general-system-design" ||
    type === "ai-ml-system-design"
  );
}

function isBoundedChildType(type: CanonicalQuestionType) {
  return type === "field-knowledge" || type === "coding";
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
