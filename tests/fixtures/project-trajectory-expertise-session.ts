import type {
  FactAnchorState,
  InterviewPlaybookPhase,
  ProjectTrajectoryChildContinuity,
} from "../../src/lib/meeting/types.js";

export interface ProjectTrajectoryReplayTurn {
  id: string;
  metadata: Record<string, unknown>;
  expected?: {
    projectId: string;
    projectName: string;
    phase: InterviewPlaybookPhase;
    factAnchorState: FactAnchorState;
    childContinuity: ProjectTrajectoryChildContinuity;
  };
}

const PROJECT = {
  id: "sanitized-agentic-memory",
  name: "Sanitized Agentic Memory",
} as const;

export const PROJECT_TRAJECTORY_EXPERTISE_REPLAY = {
  source: "sanitized-snowflake-expertise-pattern",
  parentId: "parent-sanitized-project",
  project: PROJECT,
  turns: [
    {
      id: "opening-logistics",
      metadata: {
        currentQuestionSettlementRelation: "logistics",
        currentQuestionSettlementParentMutationAuthorized: false,
        canonicalQuestionType: "unknown",
      },
    },
    {
      id: "project-narrative",
      metadata: {
        activeMeetingParentId: "parent-sanitized-project",
        activeMeetingParentRevision: 1,
        activeMeetingParentQuestionType: "project-deep-dive",
        activeMeetingProjectBindingId: PROJECT.id,
        activeMeetingProjectBindingName: PROJECT.name,
        activeMeetingProjectBindingRevision: 1,
        activeMeetingParentPhase: "project_narrative",
        factAnchorState: "strong-anchor",
        unsupportedClaimRisk: "none",
        factAnchorClaimSupportDecisions: [{ decision: "allow" }],
      },
      expected: {
        projectId: PROJECT.id,
        projectName: PROJECT.name,
        phase: "project_narrative",
        factAnchorState: "strong-anchor",
        childContinuity: "none",
      },
    },
    {
      id: "architecture-decision",
      metadata: {
        activeMeetingParentId: "parent-sanitized-project",
        activeMeetingParentRevision: 2,
        activeMeetingParentQuestionType: "project-deep-dive",
        activeMeetingProjectBindingId: PROJECT.id,
        activeMeetingProjectBindingName: PROJECT.name,
        activeMeetingProjectBindingRevision: 1,
        activeMeetingParentPhase: "architecture_decision",
        factAnchorState: "strong-anchor",
        unsupportedClaimRisk: "guarded",
        factAnchorClaimSupportDecisions: [
          { decision: "allow" },
          { decision: "needs-clarification" },
        ],
      },
      expected: {
        projectId: PROJECT.id,
        projectName: PROJECT.name,
        phase: "architecture_decision",
        factAnchorState: "strong-anchor",
        childContinuity: "none",
      },
    },
    {
      id: "field-knowledge-child",
      metadata: {
        activeMeetingParentId: "parent-sanitized-project",
        activeMeetingParentRevision: 3,
        activeMeetingParentQuestionType: "project-deep-dive",
        activeMeetingProjectBindingId: PROJECT.id,
        activeMeetingProjectBindingName: PROJECT.name,
        activeMeetingProjectBindingRevision: 1,
        activeMeetingParentPhase: "architecture_decision",
        activeMeetingChildId: "child-sanitized-concept",
        activeMeetingChildIntent: "concept-probe",
        activeMeetingChildReturnParentId: "parent-sanitized-project",
        activeMeetingChildReturnPhase: "architecture_decision",
        activeMeetingChildReturnProjectBindingRevision: 1,
        sourceTransitionKind: "child-probe",
        factAnchorState: "not-required",
      },
      expected: {
        projectId: PROJECT.id,
        projectName: PROJECT.name,
        phase: "architecture_decision",
        factAnchorState: "not-required",
        childContinuity: "child-attached",
      },
    },
    {
      id: "resume-project-parent",
      metadata: {
        activeMeetingParentId: "parent-sanitized-project",
        activeMeetingParentRevision: 4,
        activeMeetingParentQuestionType: "project-deep-dive",
        activeMeetingProjectBindingId: PROJECT.id,
        activeMeetingProjectBindingName: PROJECT.name,
        activeMeetingProjectBindingRevision: 1,
        activeMeetingParentPhase: "architecture_decision",
        sourceTransitionKind: "resume-parent",
        sourceTransitionReturnCapsuleParentId:
          "parent-sanitized-project",
        sourceTransitionReturnCapsulePhase: "architecture_decision",
        sourceTransitionReturnCapsuleProjectBindingRevision: 1,
        factAnchorState: "strong-anchor",
        factAnchorClaimSupportDecisions: [{ decision: "allow" }],
      },
      expected: {
        projectId: PROJECT.id,
        projectName: PROJECT.name,
        phase: "architecture_decision",
        factAnchorState: "strong-anchor",
        childContinuity: "parent-resumed",
      },
    },
    {
      id: "validation-reliability",
      metadata: {
        activeMeetingParentId: "parent-sanitized-project",
        activeMeetingParentRevision: 5,
        activeMeetingParentQuestionType: "project-deep-dive",
        activeMeetingProjectBindingId: PROJECT.id,
        activeMeetingProjectBindingName: PROJECT.name,
        activeMeetingProjectBindingRevision: 1,
        activeMeetingParentPhase: "validation_reliability",
        factAnchorState: "weak-anchor",
        unsupportedClaimRisk: "guarded",
        factAnchorClaimSupportDecisions: [
          { decision: "reject" },
          { decision: "needs-clarification" },
        ],
      },
      expected: {
        projectId: PROJECT.id,
        projectName: PROJECT.name,
        phase: "validation_reliability",
        factAnchorState: "weak-anchor",
        childContinuity: "none",
      },
    },
    {
      id: "impact-lessons",
      metadata: {
        activeMeetingParentId: "parent-sanitized-project",
        activeMeetingParentRevision: 6,
        activeMeetingParentQuestionType: "project-deep-dive",
        activeMeetingProjectBindingId: PROJECT.id,
        activeMeetingProjectBindingName: PROJECT.name,
        activeMeetingProjectBindingRevision: 1,
        activeMeetingParentPhase: "impact_lessons",
        factAnchorState: "strong-anchor",
        unsupportedClaimRisk: "none",
        factAnchorClaimSupportDecisions: [{ decision: "allow" }],
      },
      expected: {
        projectId: PROJECT.id,
        projectName: PROJECT.name,
        phase: "impact_lessons",
        factAnchorState: "strong-anchor",
        childContinuity: "none",
      },
    },
  ] satisfies ProjectTrajectoryReplayTurn[],
} as const;
