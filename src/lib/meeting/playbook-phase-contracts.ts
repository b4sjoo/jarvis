import type {
  InterviewPlaybookId,
  InterviewPlaybookPhase,
  InterviewSubtaskIntent,
  InterviewTaskRelation,
  ScreenQuestionType,
  TaskAskFrame,
} from "./types.js";
import type { AnswerArtifactSection } from "./meeting-task-runtime-transition.js";
import type { CanonicalQuestionType } from "./task-taxonomy.js";

export type PlaybookPhaseFlag =
  | "requirements"
  | "scale_qps"
  | "api_data_model"
  | "architecture"
  | "deep_dive_subsystem"
  | "consistency_reliability"
  | "objective_metrics"
  | "data_retrieval_model_path"
  | "serving_architecture"
  | "evaluation_metrics"
  | "latency_cost_safety"
  | "project_context"
  | "impact_lesson"
  | "whiteboard"
  | "tradeoffs_wrapup"
  | "baseline_solution"
  | "optimized_algorithm"
  | "pseudocode_dry_run"
  | "implementation"
  | "edge_case_validation";

export type PlaybookPhaseDecisionAction =
  | "stay"
  | "advance"
  | "resume-parent"
  | "child-probe";

export type PlaybookPhaseDecisionSource = "automatic" | "manual-next";

export type PlaybookPhaseTargetArtifact =
  | "answer"
  | "whiteboard"
  | "code"
  | "none";

export type PlaybookPhaseGuardStatus =
  | "automatic"
  | "advanced"
  | "blocked-no-parent"
  | "blocked-no-next-phase";

export type PlaybookRequirementEvidenceCategory =
  | "functional_scope"
  | "scale_qps"
  | "consistency_invariant"
  | "latency_sla"
  | "region_availability"
  | "data_lifecycle"
  | "explicit_non_goals"
  | "objective_use_case"
  | "success_evaluation"
  | "data_grounding"
  | "serving_economics"
  | "feedback_operations"
  | "risk_authority";

export type PlaybookPhaseCompletionSource =
  | "none"
  | "observed-evidence"
  | "explicit-assumptions"
  | "manual-next";

export type PlaybookPhaseControlSignal = "assumption-authorized";

export interface PlaybookPhaseControlEvidence {
  signal: PlaybookPhaseControlSignal;
  source: "interviewer" | "runtime-llm";
  sourceTurnId?: string;
  evidence: string[];
}

export type InterviewerAssumptionAuthorizationState =
  | "not-detected"
  | "context-only"
  | "authorized";

export interface InterviewerAssumptionAuthorizationDecision {
  state: InterviewerAssumptionAuthorizationState;
  reason:
    | "signal-not-detected"
    | "source-not-interviewer"
    | "active-parent-not-system-design"
    | "active-phase-not-requirement-clarification"
    | "active-child-present"
    | "authorized";
  phaseControl?: PlaybookPhaseControlEvidence;
  phaseBefore?: InterviewPlaybookPhase;
  phaseAfter?: InterviewPlaybookPhase;
  whiteboardRevisionRequested: boolean;
}

export interface PlaybookPhaseDecision {
  phase: InterviewPlaybookPhase;
  flags: PlaybookPhaseFlag[];
  requiredArtifacts: AnswerArtifactSection[];
  completedFlags?: PlaybookPhaseFlag[];
  action: PlaybookPhaseDecisionAction;
  reason: string;
  source?: PlaybookPhaseDecisionSource;
  targetArtifact?: PlaybookPhaseTargetArtifact;
  guardStatus?: PlaybookPhaseGuardStatus;
  phaseFrom?: InterviewPlaybookPhase;
  manualPhaseFrom?: InterviewPlaybookPhase;
  manualPhaseTo?: InterviewPlaybookPhase;
  requirementTrack?: "general-system-design" | "ai-ml-system-design";
  observedRequirementCategories?: PlaybookRequirementEvidenceCategory[];
  missingRequirementCategories?: PlaybookRequirementEvidenceCategory[];
  requirementsReady?: boolean;
  phaseCompletionSource?: PlaybookPhaseCompletionSource;
  phaseAdvanceBlockedReason?: string;
  whiteboardProvisional?: boolean;
  whiteboardOpenConstraintCategories?: PlaybookRequirementEvidenceCategory[];
  whiteboardRevisionReason?: string;
  phaseControl?: PlaybookPhaseControlEvidence;
  freshParentCreated?: boolean;
  phaseStateCompatible?: boolean;
}

/** Source-admission facts, never inferred from question text or parent origin.
 * The caller owns operation consumption and must revalidate authorization at
 * commit against LQU/session/source, final owner, task/phase and manual-action
 * bases. Replays, stale results and already consumed operations are unauthorized.
 */
export interface ProjectMainlinePhaseAdmission {
  logicalQuestionUnitId: string;
  previousLogicalQuestionUnitId?: string;
  newQuestionAdmitted: boolean;
  parentId: string;
  responseOwner: {
    kind: "parent" | "child" | "current-only";
    parentId?: string;
  };
  authorized: boolean;
  initializesSummary: boolean;
}

export interface PlaybookPhaseDecisionInput {
  questionType?: CanonicalQuestionType | ScreenQuestionType;
  playbookId?: InterviewPlaybookId;
  currentPhase?: InterviewPlaybookPhase;
  phaseProgress?: Record<string, boolean>;
  latestTurnText?: string;
  currentQuestion?: string;
  currentAnswer?: string;
  relation?: InterviewTaskRelation;
  subtaskIntent?: InterviewSubtaskIntent;
  askFrame?: TaskAskFrame;
  phaseControl?: PlaybookPhaseControlEvidence;
  phaseControlSettled?: boolean;
  freshParentCreated?: boolean;
  projectMainlineAdmission?: ProjectMainlinePhaseAdmission;
}

export interface ResolvedPlaybookState {
  phase: InterviewPlaybookPhase;
  initializedFromStart: boolean;
  phaseCompatible: boolean;
}
