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
