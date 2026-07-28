import type {
  ActiveInterviewChild,
  ActiveInterviewParent,
  InterviewTaskRelation,
} from "./types.js";
import {
  areCompatibleQuestionTypes,
  isParentCanonicalQuestionType,
  normalizeCanonicalQuestionType,
} from "./task-taxonomy.js";

export type InterviewTaskContinuityBranch =
  | "child-probe"
  | "new-parent"
  | "continue-parent"
  | "preserve";

export interface InterviewTaskContinuityDecision {
  branch: InterviewTaskContinuityBranch;
  reason: string;
}

export function decideInterviewTaskContinuityBranch(input: {
  hasExistingParent: boolean;
  existingParentQuestionType?: unknown;
  candidateQuestionType?: unknown;
  relation: InterviewTaskRelation;
}): InterviewTaskContinuityDecision {
  if (input.hasExistingParent && input.relation === "child-probe") {
    return {
      branch: "child-probe",
      reason: "authoritative-child-relation-precedes-parent-eligibility",
    };
  }

  if (input.hasExistingParent && input.relation === "resume-parent") {
    return {
      branch: "continue-parent",
      reason: "authoritative-resume-relation-preserves-parent",
    };
  }

  const candidateQuestionType = normalizeCanonicalQuestionType(
    input.candidateQuestionType
  );
  if (
    !candidateQuestionType ||
    !isParentCanonicalQuestionType(candidateQuestionType)
  ) {
    return {
      branch: "preserve",
      reason: "candidate-is-not-parent-eligible",
    };
  }

  if (!input.hasExistingParent) {
    return {
      branch: "new-parent",
      reason: "no-existing-parent",
    };
  }

  if (input.relation === "new-parent") {
    return {
      branch: "new-parent",
      reason: "relation-new-parent",
    };
  }

  if (input.relation === "unknown" || input.relation === "logistics") {
    return {
      branch: "preserve",
      reason: `unresolved-relation-${input.relation}`,
    };
  }

  const compatible = areCompatibleQuestionTypes(
    input.existingParentQuestionType,
    candidateQuestionType
  );
  if (!compatible) {
    return {
      branch: "preserve",
      reason: "incompatible-type-without-new-parent-authority",
    };
  }

  if (
    input.relation !== "followup-parent" &&
    input.relation !== "correction"
  ) {
    return {
      branch: "preserve",
      reason: `relation-${input.relation}-does-not-authorize-continuity`,
    };
  }

  return {
    branch: "continue-parent",
    reason: `compatible-parent-${input.relation}`,
  };
}

export function applyInterviewChildProbeTransition(input: {
  parent: ActiveInterviewParent;
  child?: ActiveInterviewChild;
  projectBinding?: ActiveInterviewParent["projectBinding"];
  supportedFactAnchors: string[];
  whiteboardArtifact?: ActiveInterviewParent["whiteboardArtifact"];
  now: number;
  expiresAt?: number;
}): ActiveInterviewParent {
  return {
    ...input.parent,
    updatedAt: input.now,
    expiresAt: input.expiresAt,
    child: input.child ?? input.parent.child,
    projectBinding: input.projectBinding ?? input.parent.projectBinding,
    supportedFactAnchors: input.supportedFactAnchors,
    whiteboardArtifact: input.whiteboardArtifact,
    revisions: input.parent.revisions + 1,
  };
}
