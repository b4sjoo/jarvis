import type {
  InterviewPlaybookId,
  InterviewPlaybookPhase,
  InterviewSubtaskIntent,
  InterviewTaskRelation,
  ScreenQuestionType,
  TaskAskFrame,
} from "./types.js";
import {
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import type { ActiveMeetingTask } from "./active-meeting-task.js";

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
  | "hard_problem"
  | "tradeoff_decision"
  | "validation_debugging"
  | "impact_lesson"
  | "whiteboard"
  | "tradeoffs_wrapup";

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
  | "blocked-no-parent";

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

export interface PlaybookPhaseDecision {
  phase: InterviewPlaybookPhase;
  flags: PlaybookPhaseFlag[];
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
}

const REQUIREMENT_PATTERNS = [
  "requirement",
  "constraint",
  "scope",
  "assumption",
  "clarify",
  "clarification",
  "what should",
  "which part",
  "expected",
  "need to support",
];

const SCALE_PATTERNS = [
  "qps",
  "dau",
  "traffic",
  "scale",
  "capacity",
  "throughput",
  "peak",
  "users",
  "requests per second",
  "concurrent",
  "load",
];

const API_DATA_PATTERNS = [
  "api",
  "endpoint",
  "schema",
  "data model",
  "database",
  "table",
  "storage",
  "db",
  "entities",
  "object model",
];

const ARCHITECTURE_PATTERNS = [
  "architecture",
  "component",
  "service",
  "pipeline",
  "flow",
  "layer",
  "high level design",
  "system design",
  "design",
];

const DEEP_DIVE_PATTERNS = [
  "deep dive",
  "bottleneck",
  "load balancer",
  "cache",
  "partition",
  "shard",
  "queue",
  "hotspot",
  "location tracking",
  "matching",
  "ranking",
];

const CONSISTENCY_RELIABILITY_PATTERNS = [
  "consistency",
  "reliability",
  "failure",
  "monitoring",
  "observability",
  "retry",
  "rate limit",
  "availability",
  "fault",
  "idempotent",
];

const WHITEBOARD_PATTERNS = [
  "write it down",
  "write down",
  "whiteboard",
  "draw",
  "diagram",
  "architecture diagram",
  "explain the layers",
  "explain layers",
  "put it on the board",
  "on the board",
  "show me the design",
];

const OBJECTIVE_METRIC_PATTERNS = [
  "objective",
  "north star",
  "success metric",
  "metric",
  "goal",
  "optimize",
  "measure",
  "quality",
];

const DATA_MODEL_PATTERNS = [
  "data",
  "label",
  "embedding",
  "retrieval",
  "rag",
  "vector",
  "index",
  "feature",
  "training",
  "model",
  "ranking",
];

const SERVING_PATTERNS = [
  "serving",
  "inference",
  "online",
  "orchestration",
  "real time",
  "runtime",
  "deploy",
  "endpoint",
];

const EVALUATION_PATTERNS = [
  "evaluate",
  "evaluation",
  "offline",
  "online metric",
  "a/b",
  "ab test",
  "logging",
  "logs",
  "observability",
  "trace",
  "feedback loop",
  "guardrail metric",
];

const LATENCY_COST_SAFETY_PATTERNS = [
  "latency",
  "cost",
  "safety",
  "privacy",
  "guardrail",
  "cheap",
  "faster",
  "sla",
  "budget",
];

const PROJECT_CONTEXT_PATTERNS = [
  "overview",
  "introduce",
  "background",
  "context",
  "tell me about",
  "walk me through",
  "what is",
];

const HARD_PROBLEM_PATTERNS = [
  "hard",
  "challenge",
  "difficult",
  "problem",
  "root cause",
  "issue",
  "blocked",
  "failure",
  "complex",
];

const TRADEOFF_PATTERNS = [
  "tradeoff",
  "trade off",
  "decision",
  "alternative",
  "why",
  "choose",
  "pros and cons",
  "compromise",
];

const VALIDATION_PATTERNS = [
  "validate",
  "debug",
  "test",
  "experiment",
  "verify",
  "metric",
  "rollout",
  "monitor",
];

const IMPACT_PATTERNS = [
  "impact",
  "result",
  "learn",
  "lesson",
  "outcome",
  "customer",
  "saved",
  "improve",
];

export function decidePlaybookPhaseProgression(
  input: PlaybookPhaseDecisionInput
): PlaybookPhaseDecision {
  const questionType = normalizeCanonicalQuestionType(input.questionType);
  const currentPhase =
    input.currentPhase ?? initialPhaseFor(questionType, input.playbookId);
  // Generated answers are deliberately excluded: model output cannot establish
  // interviewer-supplied requirements or complete a playbook phase.
  const text = normalizePhaseText([
    input.latestTurnText,
    input.currentQuestion,
  ]);

  if (input.relation === "child-probe") {
    return {
      phase: currentPhase,
      flags: detectChildProbeFlags(input.subtaskIntent, text),
      action: "child-probe",
      reason: "latest turn is classified as a child probe; preserve parent phase",
    };
  }

  const flags = uniqueFlags([
    ...detectCommonFlags(text),
    ...detectQuestionTypeFlags(questionType, text, input.askFrame),
  ]);
  const requirementState = isSystemDesignQuestionType(questionType)
    ? resolveRequirementState({
        questionType,
        text,
        askFrame: input.askFrame,
        phaseProgress: input.phaseProgress,
      })
    : undefined;
  const phase = choosePhase({
    questionType,
    currentPhase,
    phaseProgress: input.phaseProgress,
    requirementsReady: requirementState?.requirementsReady,
  });
  const action = decideAction({
    questionType,
    relation: input.relation,
    currentPhase,
    phase,
    flags,
    phaseProgress: input.phaseProgress,
  });

  return {
    phase,
    flags,
    completedFlags: requirementState
      ? requirementState.requirementsReady
        ? ["requirements"]
        : []
      : flags,
    action,
    reason: buildReason(
      questionType,
      currentPhase,
      phase,
      flags,
      input.relation,
      requirementState
    ),
    source: "automatic",
    guardStatus: "automatic",
    phaseFrom: currentPhase,
    requirementTrack: requirementState?.requirementTrack,
    observedRequirementCategories:
      requirementState?.observedRequirementCategories,
    missingRequirementCategories:
      requirementState?.missingRequirementCategories,
    requirementsReady: requirementState?.requirementsReady,
    phaseCompletionSource: requirementState?.phaseCompletionSource,
    phaseAdvanceBlockedReason:
      requirementState && !requirementState.requirementsReady
        ? `requirement-readiness:${requirementState.missingRequirementCategories.join(",")}`
        : undefined,
    whiteboardProvisional:
      Boolean(requirementState) && phase === "requirement_clarification",
    whiteboardOpenConstraintCategories:
      phase === "requirement_clarification"
        ? requirementState?.missingRequirementCategories
        : [],
    whiteboardRevisionReason:
      phase === "requirement_clarification"
        ? "provisional-requirement-framing"
        : currentPhase !== phase
          ? "requirement-readiness-satisfied"
          : "phase-follow-up",
  };
}

export function decideManualNextPhaseTransition(
  task: ActiveMeetingTask | undefined
): PlaybookPhaseDecision {
  if (!task) {
    return {
      phase: "follow_up",
      flags: [],
      action: "stay",
      reason: "manual-next blocked because no active parent task exists",
      source: "manual-next",
      targetArtifact: "none",
      guardStatus: "blocked-no-parent",
    };
  }

  const questionType = normalizeCanonicalQuestionType(task.parent.questionType);
  const currentPhase = task.parent.playbookPhase;
  const phaseProgress = task.parent.phaseProgress;
  const flags = chooseManualNextFlags(questionType, currentPhase, phaseProgress);
  const phase = chooseManualNextPhase(questionType, currentPhase);
  const targetArtifact = chooseManualNextTargetArtifact(questionType, flags);
  const requirementTrack = isSystemDesignQuestionType(questionType)
    ? questionType
    : undefined;
  const observedRequirementCategories = requirementTrack
    ? readObservedRequirementCategories(phaseProgress)
    : undefined;
  const missingRequirementCategories = requirementTrack
    ? getRequiredRequirementCategories(requirementTrack).filter(
        (category) => !observedRequirementCategories?.includes(category)
      )
    : undefined;

  return {
    phase,
    flags,
    completedFlags: requirementTrack
      ? uniqueFlags([
          currentPhase === "requirement_clarification"
            ? "requirements"
            : undefined,
          ...flags.filter((flag) => flag !== "whiteboard"),
        ])
      : flags,
    action: "advance",
    reason: buildManualNextReason({
      questionType,
      currentPhase,
      phase,
      flags,
      targetArtifact,
    }),
    source: "manual-next",
    targetArtifact,
    guardStatus: "advanced",
    phaseFrom: currentPhase,
    manualPhaseFrom: currentPhase,
    manualPhaseTo: phase,
    requirementTrack,
    observedRequirementCategories,
    missingRequirementCategories,
    requirementsReady: requirementTrack ? true : undefined,
    phaseCompletionSource: requirementTrack ? "manual-next" : undefined,
    whiteboardProvisional: false,
    whiteboardOpenConstraintCategories: missingRequirementCategories,
    whiteboardRevisionReason: requirementTrack
      ? "manual-next-with-explicit-assumptions"
      : "manual-next",
  };
}

export function applyPlaybookPhaseDecisionToProgress(
  progress: Record<string, boolean> | undefined,
  decision: PlaybookPhaseDecision | undefined,
  playbookPhase?: InterviewPlaybookPhase
) {
  const next = { ...(progress ?? {}) };
  if (!decision || decision.action === "child-probe") return next;

  if (decision.requirementTrack) {
    for (const category of decision.observedRequirementCategories ?? []) {
      next[requirementProgressKey(category)] = true;
    }
    if (decision.phaseFrom && decision.phase !== decision.phaseFrom) {
      next[decision.phaseFrom] = true;
    }
    for (const flag of decision.completedFlags ?? []) {
      next[flag] = true;
    }
    return next;
  }

  if (playbookPhase) next[playbookPhase] = true;
  if (decision.phaseFrom) next[decision.phaseFrom] = true;
  next[decision.phase] = true;
  for (const flag of decision.completedFlags ?? decision.flags) {
    next[flag] = true;
  }
  return next;
}

export function createInitialPlaybookPhaseProgress(
  questionType: CanonicalQuestionType | ScreenQuestionType | undefined,
  playbookPhase: InterviewPlaybookPhase | undefined
) {
  const normalized = normalizeCanonicalQuestionType(questionType);
  if (isSystemDesignQuestionType(normalized)) return {};
  return playbookPhase ? { [playbookPhase]: true } : {};
}

export function formatPlaybookPhaseDecisionForPrompt(
  decision: PlaybookPhaseDecision | undefined,
  task: ActiveMeetingTask | undefined
) {
  if (!decision && !task) {
    return "No playbook phase state.";
  }

  const progress = task?.parent.phaseProgress ?? {};
  const completed = Object.keys(progress).filter((key) => progress[key]);
  const lines = [
    task ? `Current parent type: ${task.parent.questionType}` : undefined,
    task ? `Current parent topic: ${task.parent.topic || "unknown"}` : undefined,
    task ? `Current stored phase: ${task.parent.playbookPhase}` : undefined,
    completed.length
      ? `Completed phase/progress flags: ${completed.join(", ")}`
      : "Completed phase/progress flags: none",
    decision ? `Decision action: ${decision.action}` : undefined,
    decision?.source ? `Decision source: ${decision.source}` : undefined,
    decision ? `Recommended phase: ${decision.phase}` : undefined,
    decision?.manualPhaseFrom && decision.manualPhaseTo
      ? `Manual phase transition: ${decision.manualPhaseFrom} -> ${decision.manualPhaseTo}`
      : undefined,
    decision?.targetArtifact
      ? `Target artifact this turn: ${decision.targetArtifact}`
      : undefined,
    decision?.flags.length
      ? `Requested phase flags this turn: ${decision.flags.join(", ")}`
      : decision
        ? "Requested phase flags this turn: none"
        : undefined,
    decision?.observedRequirementCategories
      ? `Observed requirement categories: ${
          decision.observedRequirementCategories.join(", ") || "none"
        }`
      : undefined,
    decision?.missingRequirementCategories
      ? `Missing requirement categories: ${
          decision.missingRequirementCategories.join(", ") || "none"
        }`
      : undefined,
    decision?.requirementsReady !== undefined
      ? `Requirement readiness: ${decision.requirementsReady ? "ready" : "not-ready"}`
      : undefined,
    decision?.phaseCompletionSource
      ? `Phase completion source: ${decision.phaseCompletionSource}`
      : undefined,
    decision?.phaseAdvanceBlockedReason
      ? `Phase advance blocked: ${decision.phaseAdvanceBlockedReason}`
      : undefined,
    decision?.whiteboardProvisional
      ? "Whiteboard contract: produce a PROVISIONAL revision using only known facts and clearly marked open constraints."
      : undefined,
    decision ? `Decision reason: ${decision.reason}` : undefined,
    "",
    "Behavioral rules:",
    "- Do not repeat completed requirement clarification unless the latest turn adds a new requirement or constraint.",
    "- If Decision source is manual-next, treat the phase transition as already chosen by the user: do not ask whether to advance and do not restart an earlier phase.",
    "- If Decision action is child-probe, answer the local child probe while preserving the parent trajectory and make it easy to resume the parent.",
    "- If Decision action is resume-parent, continue from the stored phase/progress instead of restarting the playbook first move.",
    "- If Target artifact is whiteboard, update or produce the Whiteboard artifact as the main output.",
    "- If requested flags include whiteboard, produce the Whiteboard artifact directly; do not ask whether to use plain text or ASCII.",
    "- If requested flags include evaluation_metrics, be concrete about metrics, logs, evaluation, and feedback-loop signals.",
    "- Requested flags describe what is being discussed; they are not proof that a phase or milestone is complete.",
    "- During requirement_clarification for General or AI/ML System Design, produce a shallow provisional Whiteboard immediately. Do not choose detailed technologies or silently fill open constraints.",
  ];

  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

export function formatPlaybookPhaseDecisionForTrace(
  decision: PlaybookPhaseDecision | undefined
) {
  if (!decision) return {};
  return {
    playbookPhaseDecisionAction: decision.action,
    playbookPhaseDecisionSource: decision.source,
    playbookPhaseDecisionPhase: decision.phase,
    playbookPhaseDecisionFlags: decision.flags,
    playbookRequestedFlags: decision.flags,
    playbookCompletedFlags: decision.completedFlags,
    playbookPhaseDecisionReason: decision.reason,
    playbookPhaseDecisionFrom: decision.phaseFrom,
    manualPhaseFrom: decision.manualPhaseFrom,
    manualPhaseTo: decision.manualPhaseTo,
    manualPhaseTargetArtifact: decision.targetArtifact,
    manualPhaseGuardStatus: decision.guardStatus,
    playbookRequirementTrack: decision.requirementTrack,
    playbookObservedRequirementCategories:
      decision.observedRequirementCategories,
    playbookRequirementsReady: decision.requirementsReady,
    playbookMissingRequirementCategories:
      decision.missingRequirementCategories,
    playbookPhaseCompletionSource: decision.phaseCompletionSource,
    playbookPhaseAdvanceBlockedReason: decision.phaseAdvanceBlockedReason,
    whiteboardProvisional: decision.whiteboardProvisional,
    whiteboardOpenConstraintCategories:
      decision.whiteboardOpenConstraintCategories,
    whiteboardRevisionReason: decision.whiteboardRevisionReason,
  };
}

function chooseManualNextPhase(
  questionType: CanonicalQuestionType | undefined,
  currentPhase: InterviewPlaybookPhase
): InterviewPlaybookPhase {
  if (
    questionType === "general-system-design" ||
    questionType === "ai-ml-system-design"
  ) {
    return "design_framing";
  }
  if (questionType === "behavioral") return "follow_up";
  if (questionType === "project-deep-dive") return "follow_up";
  if (questionType === "field-knowledge") return "follow_up";
  if (questionType === "coding") return "solution_planning";
  return currentPhase === "follow_up" ? "follow_up" : currentPhase;
}

function chooseManualNextFlags(
  questionType: CanonicalQuestionType | undefined,
  currentPhase: InterviewPlaybookPhase,
  phaseProgress: Record<string, boolean> | undefined
): PlaybookPhaseFlag[] {
  if (questionType === "general-system-design") {
    if (currentPhase === "requirement_clarification") {
      return ["scale_qps", "api_data_model", "architecture", "whiteboard"];
    }
    if (!hasProgress(phaseProgress, "deep_dive_subsystem")) {
      return ["deep_dive_subsystem", "consistency_reliability", "whiteboard"];
    }
    return ["consistency_reliability", "tradeoffs_wrapup", "whiteboard"];
  }

  if (questionType === "ai-ml-system-design") {
    if (currentPhase === "requirement_clarification") {
      return [
        "objective_metrics",
        "data_retrieval_model_path",
        "serving_architecture",
        "whiteboard",
      ];
    }
    if (!hasProgress(phaseProgress, "evaluation_metrics")) {
      return ["evaluation_metrics", "latency_cost_safety", "whiteboard"];
    }
    return ["evaluation_metrics", "tradeoffs_wrapup", "whiteboard"];
  }

  if (questionType === "project-deep-dive") {
    if (!hasProgress(phaseProgress, "hard_problem")) {
      return ["hard_problem", "architecture"];
    }
    if (!hasProgress(phaseProgress, "tradeoff_decision")) {
      return ["tradeoff_decision", "validation_debugging"];
    }
    return ["impact_lesson", "tradeoffs_wrapup"];
  }

  if (questionType === "behavioral") {
    return ["impact_lesson", "tradeoffs_wrapup"];
  }

  if (questionType === "coding") {
    return ["architecture", "latency_cost_safety"];
  }

  if (questionType === "field-knowledge") {
    return ["tradeoffs_wrapup"];
  }

  return [];
}

function chooseManualNextTargetArtifact(
  questionType: CanonicalQuestionType | undefined,
  flags: PlaybookPhaseFlag[]
): PlaybookPhaseTargetArtifact {
  if (flags.includes("whiteboard")) return "whiteboard";
  if (questionType === "coding") return "code";
  if (!questionType) return "none";
  return "answer";
}

function buildManualNextReason({
  questionType,
  currentPhase,
  phase,
  flags,
  targetArtifact,
}: {
  questionType: CanonicalQuestionType | undefined;
  currentPhase: InterviewPlaybookPhase;
  phase: InterviewPlaybookPhase;
  flags: PlaybookPhaseFlag[];
  targetArtifact: PlaybookPhaseTargetArtifact;
}) {
  return [
    "manual-next",
    questionType ? `type=${questionType}` : "type=unknown",
    `${currentPhase}->${phase}`,
    `target=${targetArtifact}`,
    flags.length ? `flags=${flags.join(",")}` : "flags=none",
  ].join("; ");
}

function detectQuestionTypeFlags(
  questionType: CanonicalQuestionType | undefined,
  text: string,
  askFrame: TaskAskFrame | undefined
): PlaybookPhaseFlag[] {
  if (questionType === "general-system-design") {
    return detectGeneralSystemDesignFlags(text, askFrame);
  }
  if (questionType === "ai-ml-system-design") {
    return detectAiMlSystemDesignFlags(text, askFrame);
  }
  if (questionType === "project-deep-dive") {
    return detectProjectDeepDiveFlags(text, askFrame);
  }
  if (questionType === "behavioral") {
    return ["project_context"];
  }
  if (questionType === "coding") {
    return ["architecture"];
  }
  if (questionType === "field-knowledge") {
    return ["project_context"];
  }
  return [];
}

function detectGeneralSystemDesignFlags(
  text: string,
  askFrame: TaskAskFrame | undefined
): PlaybookPhaseFlag[] {
  return uniqueFlags([
    askFrame === "hypothetical-design" ? "requirements" : undefined,
    matchesAny(text, REQUIREMENT_PATTERNS) ? "requirements" : undefined,
    matchesAny(text, SCALE_PATTERNS) ? "scale_qps" : undefined,
    matchesAny(text, API_DATA_PATTERNS) ? "api_data_model" : undefined,
    matchesAny(text, ARCHITECTURE_PATTERNS) ? "architecture" : undefined,
    matchesAny(text, DEEP_DIVE_PATTERNS) ? "deep_dive_subsystem" : undefined,
    matchesAny(text, CONSISTENCY_RELIABILITY_PATTERNS)
      ? "consistency_reliability"
      : undefined,
  ]);
}

function detectAiMlSystemDesignFlags(
  text: string,
  askFrame: TaskAskFrame | undefined
): PlaybookPhaseFlag[] {
  return uniqueFlags([
    askFrame === "hypothetical-design" ? "requirements" : undefined,
    matchesAny(text, REQUIREMENT_PATTERNS) ? "requirements" : undefined,
    matchesAny(text, OBJECTIVE_METRIC_PATTERNS)
      ? "objective_metrics"
      : undefined,
    matchesAny(text, DATA_MODEL_PATTERNS)
      ? "data_retrieval_model_path"
      : undefined,
    matchesAny(text, SERVING_PATTERNS) ? "serving_architecture" : undefined,
    matchesAny(text, EVALUATION_PATTERNS) ? "evaluation_metrics" : undefined,
    matchesAny(text, LATENCY_COST_SAFETY_PATTERNS)
      ? "latency_cost_safety"
      : undefined,
  ]);
}

function detectProjectDeepDiveFlags(
  text: string,
  askFrame: TaskAskFrame | undefined
): PlaybookPhaseFlag[] {
  return uniqueFlags([
    askFrame === "past-project" ? "project_context" : undefined,
    matchesAny(text, PROJECT_CONTEXT_PATTERNS) ? "project_context" : undefined,
    matchesAny(text, ARCHITECTURE_PATTERNS) ? "architecture" : undefined,
    matchesAny(text, HARD_PROBLEM_PATTERNS) ? "hard_problem" : undefined,
    matchesAny(text, TRADEOFF_PATTERNS) ? "tradeoff_decision" : undefined,
    matchesAny(text, VALIDATION_PATTERNS) ? "validation_debugging" : undefined,
    matchesAny(text, IMPACT_PATTERNS) ? "impact_lesson" : undefined,
  ]);
}

function detectCommonFlags(text: string): PlaybookPhaseFlag[] {
  return uniqueFlags([
    matchesAny(text, WHITEBOARD_PATTERNS) ? "whiteboard" : undefined,
    matchesAny(text, TRADEOFF_PATTERNS) ? "tradeoffs_wrapup" : undefined,
  ]);
}

function detectChildProbeFlags(
  subtaskIntent: InterviewSubtaskIntent | undefined,
  text: string
): PlaybookPhaseFlag[] {
  return uniqueFlags([
    subtaskIntent === "metric-probe" ? "evaluation_metrics" : undefined,
    subtaskIntent === "qps-estimation" ? "scale_qps" : undefined,
    subtaskIntent === "implementation-probe" ? "architecture" : undefined,
    subtaskIntent === "complexity-probe" ? "latency_cost_safety" : undefined,
    ...detectCommonFlags(text),
  ]);
}

function choosePhase({
  questionType,
  currentPhase,
  phaseProgress,
  requirementsReady,
}: {
  questionType: CanonicalQuestionType | undefined;
  currentPhase: InterviewPlaybookPhase;
  phaseProgress?: Record<string, boolean>;
  requirementsReady?: boolean;
}): InterviewPlaybookPhase {
  if (questionType === "behavioral") return "story_selection";
  if (questionType === "coding") return "solution_planning";
  if (questionType === "field-knowledge") return "concept_explanation";
  if (questionType === "project-deep-dive") return "project_narrative";

  if (
    questionType === "general-system-design" ||
    questionType === "ai-ml-system-design"
  ) {
    if (
      currentPhase !== "requirement_clarification" ||
      hasProgress(phaseProgress, "requirements") ||
      requirementsReady
    ) {
      return currentPhase === "requirement_clarification"
        ? "design_framing"
        : currentPhase;
    }

    return "requirement_clarification";
  }

  return currentPhase;
}

function decideAction({
  questionType,
  relation,
  currentPhase,
  phase,
  flags,
  phaseProgress,
}: {
  questionType?: CanonicalQuestionType;
  relation?: InterviewTaskRelation;
  currentPhase: InterviewPlaybookPhase;
  phase: InterviewPlaybookPhase;
  flags: PlaybookPhaseFlag[];
  phaseProgress?: Record<string, boolean>;
}): PlaybookPhaseDecisionAction {
  if (relation === "resume-parent") return "resume-parent";
  if (phase !== currentPhase) return "advance";
  if (isSystemDesignQuestionType(questionType)) {
    if (currentPhase === "requirement_clarification") return "stay";
    return flags.some((flag) => !hasProgress(phaseProgress, flag))
      ? "advance"
      : "stay";
  }
  if (flags.some((flag) => !hasProgress(phaseProgress, flag))) return "advance";
  return "stay";
}

function initialPhaseFor(
  questionType: CanonicalQuestionType | undefined,
  playbookId: InterviewPlaybookId | undefined
): InterviewPlaybookPhase {
  if (playbookId === "behavioral_story" || questionType === "behavioral") {
    return "story_selection";
  }
  if (playbookId === "coding_algorithm" || questionType === "coding") {
    return "solution_planning";
  }
  if (playbookId === "general_system_design") {
    return "requirement_clarification";
  }
  if (playbookId === "aiml_system_design") {
    return "requirement_clarification";
  }
  if (playbookId === "project_deep_dive" || questionType === "project-deep-dive") {
    return "project_narrative";
  }
  if (playbookId === "aiml_field_knowledge" || questionType === "field-knowledge") {
    return "concept_explanation";
  }
  return "follow_up";
}

function buildReason(
  questionType: CanonicalQuestionType | undefined,
  currentPhase: InterviewPlaybookPhase,
  phase: InterviewPlaybookPhase,
  flags: PlaybookPhaseFlag[],
  relation: InterviewTaskRelation | undefined,
  requirementState?: RequirementState
) {
  const parts = [
    questionType ? `type=${questionType}` : "type=unknown",
    relation ? `relation=${relation}` : undefined,
    currentPhase !== phase ? `${currentPhase}->${phase}` : `phase=${phase}`,
    flags.length ? `flags=${flags.join(",")}` : "flags=none",
    requirementState
      ? `requirementsReady=${requirementState.requirementsReady}`
      : undefined,
    requirementState
      ? `observed=${requirementState.observedRequirementCategories.join(",") || "none"}`
      : undefined,
  ];
  return parts.filter(Boolean).join("; ");
}

interface RequirementState {
  requirementTrack: "general-system-design" | "ai-ml-system-design";
  observedRequirementCategories: PlaybookRequirementEvidenceCategory[];
  missingRequirementCategories: PlaybookRequirementEvidenceCategory[];
  requirementsReady: boolean;
  phaseCompletionSource: PlaybookPhaseCompletionSource;
}

function resolveRequirementState({
  questionType,
  text,
  askFrame,
  phaseProgress,
}: {
  questionType: "general-system-design" | "ai-ml-system-design";
  text: string;
  askFrame?: TaskAskFrame;
  phaseProgress?: Record<string, boolean>;
}): RequirementState {
  const previous = readObservedRequirementCategories(phaseProgress);
  const current =
    questionType === "general-system-design"
      ? detectGeneralRequirementEvidence(text, askFrame)
      : detectAiMlRequirementEvidence(text, askFrame);
  const observedRequirementCategories = uniqueRequirementCategories([
    ...previous,
    ...current,
  ]);
  const required = getRequiredRequirementCategories(questionType);
  const explicitAssumptions = asksToProceedWithAssumptions(text);
  const requirementsReady =
    Boolean(phaseProgress?.requirements) ||
    explicitAssumptions ||
    hasRequirementReadiness(questionType, observedRequirementCategories);

  return {
    requirementTrack: questionType,
    observedRequirementCategories,
    missingRequirementCategories: required.filter(
      (category) => !observedRequirementCategories.includes(category)
    ),
    requirementsReady,
    phaseCompletionSource: explicitAssumptions
      ? "explicit-assumptions"
      : requirementsReady
        ? "observed-evidence"
        : "none",
  };
}

function detectGeneralRequirementEvidence(
  text: string,
  askFrame: TaskAskFrame | undefined
) {
  return uniqueRequirementCategories([
    askFrame === "hypothetical-design" &&
    /\b(design|build|architect|system|service|app|platform)\b/.test(text)
      ? "functional_scope"
      : undefined,
    hasScaleEvidence(text) ? "scale_qps" : undefined,
    /\b(strong consistency|eventual consistency|linearizable|exactly once|at most once|no double|never be double|no duplicate|invariant|must remain consistent|cannot oversell)\b/.test(
      text
    )
      ? "consistency_invariant"
      : undefined,
    /\b(p9[059]|latency (?:under|below|within)|under \d+\s*(?:ms|milliseconds?|seconds?)|real[- ]time|low[- ]latency)\b/.test(
      text
    )
      ? "latency_sla"
      : undefined,
    /\b(multi[- ]region|single[- ]region|global|worldwide|cross[- ]region|active[- ]active|active[- ]passive|99\.\d+% availability|highly available)\b/.test(
      text
    )
      ? "region_availability"
      : undefined,
    /\b(retain|retention|ttl|expire|freshness|stale|history for|delete after|update every)\b/.test(
      text
    )
      ? "data_lifecycle"
      : undefined,
    /\b(out of scope|non[- ]goal|do not need|doesn't need|ignore|only support|exclude)\b/.test(
      text
    )
      ? "explicit_non_goals"
      : undefined,
  ]);
}

function detectAiMlRequirementEvidence(
  text: string,
  askFrame: TaskAskFrame | undefined
) {
  return uniqueRequirementCategories([
    askFrame === "hypothetical-design" &&
    /\b(design|build|architect|model|agent|rag|recommend|predict|rank|classif|detect|generate)\b/.test(
      text
    )
      ? "objective_use_case"
      : undefined,
    /\b(precision|recall|f1|auc|ndcg|mrr|ctr|conversion|task success|goal completion|hallucination rate|accuracy target|baseline|ground truth|success metric)\b/.test(
      text
    )
      ? "success_evaluation"
      : undefined,
    /\b(corpus|documents? from|training data|labeled data|labels? from|click logs?|user history|knowledge base|data source|feedback data|fresh data|data freshness)\b/.test(
      text
    )
      ? "data_grounding"
      : undefined,
    hasScaleEvidence(text) ||
    /\b(batch|asynchronous|online serving|real[- ]time|p9[059]|latency budget|cost budget|gpu budget|tokens? per|requests? per second|fallback)\b/.test(
      text
    )
      ? "serving_economics"
      : undefined,
    /\b(feedback loop|retrain|retraining|refresh the index|index refresh|drift|label delay|online feedback|rollout|rollback)\b/.test(
      text
    )
      ? "feedback_operations"
      : undefined,
    /\b(human approval|human in the loop|suggestion only|takes action|action authority|permission|privacy|pii|compliance|safety boundary|least privilege)\b/.test(
      text
    )
      ? "risk_authority"
      : undefined,
  ]);
}

function hasScaleEvidence(text: string) {
  return (
    /\b\d+(?:\.\d+)?\s*(?:k|m|b|million|billion)?\s*(?:(?:daily|monthly|active|concurrent)\s+)?(?:users?|dau|mau|qps|rps|requests?|events?|writes?|reads?|concurrent|per second|per day)\b/.test(
      text
    ) ||
    /\b(peak traffic|read[- ]heavy|write[- ]heavy|high traffic|millions? of users|billions? of events)\b/.test(
      text
    )
  );
}

function asksToProceedWithAssumptions(text: string) {
  return /\b(make|use|take)\s+(?:some\s+|reasonable\s+)?assumptions?\b|\bassume (?:what you need|reasonable defaults?)\b|\bproceed with (?:your |reasonable )?assumptions?\b/.test(
    text
  );
}

function hasRequirementReadiness(
  questionType: "general-system-design" | "ai-ml-system-design",
  observed: PlaybookRequirementEvidenceCategory[]
) {
  const anchor =
    questionType === "general-system-design"
      ? "functional_scope"
      : "objective_use_case";
  if (!observed.includes(anchor)) return false;
  return observed.filter((category) => category !== anchor).length >= 2;
}

function getRequiredRequirementCategories(
  questionType: "general-system-design" | "ai-ml-system-design"
): PlaybookRequirementEvidenceCategory[] {
  return questionType === "general-system-design"
    ? [
        "functional_scope",
        "scale_qps",
        "consistency_invariant",
        "latency_sla",
        "region_availability",
        "data_lifecycle",
        "explicit_non_goals",
      ]
    : [
        "objective_use_case",
        "success_evaluation",
        "data_grounding",
        "serving_economics",
        "feedback_operations",
        "risk_authority",
      ];
}

function readObservedRequirementCategories(
  phaseProgress: Record<string, boolean> | undefined
) {
  return ALL_REQUIREMENT_CATEGORIES.filter(
    (category) => phaseProgress?.[requirementProgressKey(category)]
  );
}

function requirementProgressKey(
  category: PlaybookRequirementEvidenceCategory
) {
  return `requirement_evidence:${category}`;
}

const ALL_REQUIREMENT_CATEGORIES: PlaybookRequirementEvidenceCategory[] = [
  "functional_scope",
  "scale_qps",
  "consistency_invariant",
  "latency_sla",
  "region_availability",
  "data_lifecycle",
  "explicit_non_goals",
  "objective_use_case",
  "success_evaluation",
  "data_grounding",
  "serving_economics",
  "feedback_operations",
  "risk_authority",
];

function uniqueRequirementCategories(
  values: Array<PlaybookRequirementEvidenceCategory | undefined>
) {
  return Array.from(
    new Set(
      values.filter(Boolean) as PlaybookRequirementEvidenceCategory[]
    )
  );
}

function isSystemDesignQuestionType(
  questionType: CanonicalQuestionType | undefined
): questionType is "general-system-design" | "ai-ml-system-design" {
  return (
    questionType === "general-system-design" ||
    questionType === "ai-ml-system-design"
  );
}

function uniqueFlags(
  values: Array<PlaybookPhaseFlag | undefined>
): PlaybookPhaseFlag[] {
  return Array.from(new Set(values.filter(Boolean) as PlaybookPhaseFlag[]));
}

function hasProgress(
  phaseProgress: Record<string, boolean> | undefined,
  key: string
) {
  return Boolean(phaseProgress?.[key]);
}

function matchesAny(text: string, patterns: string[]) {
  return patterns.some((pattern) => text.includes(pattern));
}

function normalizePhaseText(values: Array<string | undefined>) {
  return values
    .filter(Boolean)
    .join("\n")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
