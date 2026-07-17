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

export interface PlaybookPhaseDecision {
  phase: InterviewPlaybookPhase;
  flags: PlaybookPhaseFlag[];
  action: PlaybookPhaseDecisionAction;
  reason: string;
  source?: PlaybookPhaseDecisionSource;
  targetArtifact?: PlaybookPhaseTargetArtifact;
  guardStatus?: PlaybookPhaseGuardStatus;
  phaseFrom?: InterviewPlaybookPhase;
  manualPhaseFrom?: InterviewPlaybookPhase;
  manualPhaseTo?: InterviewPlaybookPhase;
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
  const text = normalizePhaseText([
    input.latestTurnText,
    input.currentQuestion,
    input.currentAnswer,
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
  const phase = choosePhase({
    questionType,
    currentPhase,
    phaseProgress: input.phaseProgress,
    flags,
  });
  const action = decideAction({
    relation: input.relation,
    currentPhase,
    phase,
    flags,
    phaseProgress: input.phaseProgress,
  });

  return {
    phase,
    flags,
    action,
    reason: buildReason(questionType, currentPhase, phase, flags, input.relation),
    source: "automatic",
    guardStatus: "automatic",
    phaseFrom: currentPhase,
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

  return {
    phase,
    flags,
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
  };
}

export function applyPlaybookPhaseDecisionToProgress(
  progress: Record<string, boolean> | undefined,
  decision: PlaybookPhaseDecision | undefined,
  playbookPhase?: InterviewPlaybookPhase
) {
  const next = { ...(progress ?? {}) };
  if (playbookPhase) next[playbookPhase] = true;
  if (!decision || decision.action === "child-probe") return next;
  if (decision.phaseFrom) next[decision.phaseFrom] = true;
  next[decision.phase] = true;
  for (const flag of decision.flags) {
    next[flag] = true;
  }
  return next;
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
    playbookPhaseDecisionReason: decision.reason,
    playbookPhaseDecisionFrom: decision.phaseFrom,
    manualPhaseFrom: decision.manualPhaseFrom,
    manualPhaseTo: decision.manualPhaseTo,
    manualPhaseTargetArtifact: decision.targetArtifact,
    manualPhaseGuardStatus: decision.guardStatus,
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
  flags,
}: {
  questionType: CanonicalQuestionType | undefined;
  currentPhase: InterviewPlaybookPhase;
  phaseProgress?: Record<string, boolean>;
  flags: PlaybookPhaseFlag[];
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
      flags.includes("whiteboard") ||
      flags.includes("architecture") ||
      flags.includes("api_data_model") ||
      flags.includes("deep_dive_subsystem") ||
      flags.includes("evaluation_metrics") ||
      flags.includes("serving_architecture") ||
      flags.includes("data_retrieval_model_path")
    ) {
      return "design_framing";
    }

    if (hasProgress(phaseProgress, "requirements")) {
      return currentPhase === "requirement_clarification"
        ? "design_framing"
        : currentPhase;
    }

    return "requirement_clarification";
  }

  return currentPhase;
}

function decideAction({
  relation,
  currentPhase,
  phase,
  flags,
  phaseProgress,
}: {
  relation?: InterviewTaskRelation;
  currentPhase: InterviewPlaybookPhase;
  phase: InterviewPlaybookPhase;
  flags: PlaybookPhaseFlag[];
  phaseProgress?: Record<string, boolean>;
}): PlaybookPhaseDecisionAction {
  if (relation === "resume-parent") return "resume-parent";
  if (phase !== currentPhase) return "advance";
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
  relation: InterviewTaskRelation | undefined
) {
  const parts = [
    questionType ? `type=${questionType}` : "type=unknown",
    relation ? `relation=${relation}` : undefined,
    currentPhase !== phase ? `${currentPhase}->${phase}` : `phase=${phase}`,
    flags.length ? `flags=${flags.join(",")}` : "flags=none",
  ];
  return parts.filter(Boolean).join("; ");
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
