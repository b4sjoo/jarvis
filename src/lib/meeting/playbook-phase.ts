import type {
  InterviewPlaybookId,
  InterviewPlaybookPhase,
  InterviewSubtaskIntent,
  InterviewTaskRelation,
  ScreenQuestionType,
  TaskAskFrame,
} from "./types.js";
import type { AnswerArtifactSection } from "./answer-generation-lease.js";
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
}

export interface ResolvedPlaybookState {
  phase: InterviewPlaybookPhase;
  initializedFromStart: boolean;
  phaseCompatible: boolean;
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

const PROJECT_ARCHITECTURE_PHASE_EVIDENCE_PATTERNS = [
  "architecture",
  "technical design",
  "system design",
  "design alternative",
  "why did you choose",
  "tradeoff",
  "trade off",
  "pros and cons",
];

const PROJECT_HARD_PROBLEM_PHASE_EVIDENCE_PATTERNS = [
  "hardest technical",
  "technical challenge",
  "most difficult",
  "root cause",
  "what failed",
  "failure mode",
];

const PROJECT_VALIDATION_PHASE_EVIDENCE_PATTERNS = [
  "how did you validate",
  "how did you debug",
  "how did you test",
  "during rollout",
  "verify the fix",
  "monitor in production",
];

const PROJECT_IMPACT_PHASE_EVIDENCE_PATTERNS = [
  "what was the impact",
  "what was the result",
  "what did you learn",
  "what would you improve",
  "measured outcome",
  "customer impact",
];

const CODING_OPTIMIZATION_PATTERNS = [
  "optimize",
  "optimise",
  "optimal",
  "more efficient",
  "faster",
  "improve the complexity",
  "better complexity",
  "time complexity",
  "space complexity",
  "big o",
];

const CODING_IMPLEMENTATION_PATTERNS = [
  "write code",
  "write the code",
  "implement",
  "implementation",
  "code it",
  "code this",
  "complete the function",
  "fill in the function",
  "class solution",
  "def ",
  "function ",
];

const CODING_VALIDATION_PATTERNS = [
  "debug",
  "failing",
  "failed",
  "bug",
  "error",
  "edge case",
  "test case",
  "dry run",
  "trace through",
];

export function resolvePlaybookRequiredArtifacts(input: {
  questionType?: CanonicalQuestionType | ScreenQuestionType;
  playbookId?: InterviewPlaybookId;
  phase?: InterviewPlaybookPhase;
  subtaskIntent?: InterviewSubtaskIntent;
}): AnswerArtifactSection[] {
  const questionType = normalizeCanonicalQuestionType(input.questionType);
  if (
    questionType === "general-system-design" ||
    questionType === "ai-ml-system-design" ||
    input.playbookId === "general_system_design" ||
    input.playbookId === "aiml_system_design"
  ) {
    return ["answer", "whiteboard"];
  }

  if (questionType === "coding" || input.playbookId === "coding_algorithm") {
    const phase = normalizeCodingPhase(input.phase);
    if (input.subtaskIntent === "complexity-probe") {
      return ["answer", "complexity"];
    }
    if (phase === "baseline_reasoning") {
      return ["answer"];
    }
    if (phase === "optimized_pseudocode") {
      return ["answer", "complexity"];
    }
    if (input.subtaskIntent === "implementation-probe") {
      return ["answer", "code", "complexity"];
    }
    return ["answer", "code", "complexity"];
  }

  return ["answer"];
}

export function formatCodingPlaybookPhaseContract(
  phase: InterviewPlaybookPhase
) {
  const normalizedPhase = normalizeCodingPhase(phase);
  if (normalizedPhase === "optimized_pseudocode") {
    return [
      "codingPhaseContract:",
      "- Explain the baseline bottleneck, then the optimized data structure, state, or invariant.",
      "- Give clear pseudocode, boundary conditions, one spoken dry run, and exact target Complexity.",
      "- Do not emit Code in this phase. Preserve any existing Code artifact until implementation_validation replaces it.",
      formatCodingSolutionManifestContract("optimized"),
    ].join("\n");
  }
  if (normalizedPhase === "implementation_validation") {
    return [
      "codingPhaseContract:",
      "- Emit a complete runnable implementation in the selected programming language.",
      "- Keep Answer concise and spoken; put implementation only in Code.",
      "- Include exact Complexity, key edge cases, and validation or debugging guidance.",
      formatCodingSolutionManifestContract("optimized"),
    ].join("\n");
  }
  return [
    "codingPhaseContract:",
    "- Ask up to three high-yield clarification questions when the callable contract is ambiguous; otherwise state concise, revisable assumptions.",
    "- Establish input/output shape, signature or interface, units, ordering, mutation, duplicate or missing-input behavior, and relevant error semantics.",
    "- For endpoint or API-shaped tasks, clarify request, response, status/error behavior, state, and dependency failures without treating them as a separate question type.",
    "- Explain the simplest correct baseline, including brute force when useful.",
    "- Assume the listener has no programming or algorithm background. Explain the mechanics in plain spoken English.",
    "- Walk through one small example and state the baseline complexity inside Approach.",
    "- Do not emit Code or Complexity in this phase. The goal is shared understanding, not implementation.",
    formatCodingSolutionManifestContract("baseline"),
  ].join("\n");
}

function formatCodingSolutionManifestContract(
  visibleCandidate: "baseline" | "optimized"
) {
  return [
    "- Before writing the visible solution, distinguish the simplest correct baseline from an optimized candidate. They may be identical only when the constraints make the simplest solution optimal.",
    `- Append one hidden <CODING_SOLUTION_MANIFEST> JSON object at the very end with version=1, baseline {approach,dataStructures,time,space}, optimized {approach,dataStructures,time,space}, sameSolution, a short reason, and visibleCandidate='${visibleCandidate}'.`,
    "- Do not expose or discuss the manifest in the visible Answer, Approach, Code, or Complexity sections.",
  ].join("\n");
}

export function formatProjectDeepDivePhaseContract(
  phase: InterviewPlaybookPhase
) {
  if (phase === "architecture_decision") {
    return [
      "projectDeepDivePhaseContract:",
      "- Explain the architecture or decision currently being probed, my ownership, the viable alternatives, and the decisive tradeoff.",
      "- Keep the explanation logically layered and meeting-ready. Do not restart the project overview.",
      "- Use only project-compatible evidence; distinguish implemented behavior from a future improvement.",
    ].join("\n");
  }
  if (phase === "validation_reliability") {
    return [
      "projectDeepDivePhaseContract:",
      "- Explain the concrete failure or risk, how I debugged or validated it, the evidence used, and the recovery or reliability mechanism.",
      "- Prefer tests, traces, rollout checks, and observed behavior over generic best practices.",
      "- Do not invent validation, metrics, incidents, or mechanisms that are absent from supported project evidence.",
    ].join("\n");
  }
  if (phase === "impact_lessons") {
    return [
      "projectDeepDivePhaseContract:",
      "- State supported impact, known limitations, what I learned, and the highest-value next improvement.",
      "- Separate measured outcomes from qualitative outcomes and future proposals.",
      "- Do not introduce unsupported numbers or restart the project narrative.",
    ].join("\n");
  }
  return [
    "projectDeepDivePhaseContract:",
    "- Give a 30-45 second spoken introduction: problem, previous limitation, my role and contribution, and supported outcome.",
    "- Stay at the project level unless the interviewer asks for an internal mechanism or decision.",
    "- Establish one clear project anchor and do not borrow facts from another project.",
  ].join("\n");
}

export function decidePlaybookPhaseProgression(
  input: PlaybookPhaseDecisionInput
): PlaybookPhaseDecision {
  const questionType = normalizeCanonicalQuestionType(input.questionType);
  const playbookState = resolvePlaybookState({
    questionType,
    playbookId: input.playbookId,
    phase: input.currentPhase,
  });
  const currentPhase = playbookState.phase;
  if (!playbookState.phaseCompatible) {
    return {
      phase: currentPhase,
      flags: [],
      requiredArtifacts: resolvePlaybookRequiredArtifacts({
        questionType,
        playbookId: input.playbookId,
        phase: currentPhase,
        subtaskIntent: input.subtaskIntent,
      }),
      action: "stay",
      reason: `committed phase ${currentPhase} is incompatible with question type ${questionType ?? "unknown"}`,
      source: "automatic",
      guardStatus: "automatic",
      phaseFrom: currentPhase,
      phaseAdvanceBlockedReason: "incompatible-committed-phase",
      freshParentCreated: input.freshParentCreated,
      phaseStateCompatible: false,
    };
  }
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
      requiredArtifacts: resolvePlaybookRequiredArtifacts({
        questionType,
        playbookId: input.playbookId,
        phase: currentPhase,
        subtaskIntent: input.subtaskIntent,
      }),
      action: "child-probe",
      reason: "latest turn is classified as a child probe; preserve parent phase",
      freshParentCreated: input.freshParentCreated,
      phaseStateCompatible: true,
    };
  }

  const detectedFlags = uniqueFlags([
    ...detectCommonFlags(text, questionType),
    ...detectQuestionTypeFlags(
      questionType,
      text,
      input.askFrame,
      input.subtaskIntent
    ),
  ]);
  const initialCodingParent =
    questionType === "coding" &&
    (input.freshParentCreated === true ||
      (!input.currentPhase && !input.phaseProgress));
  // A title such as "Implement X" identifies a Coding task, but cannot prove
  // that baseline reasoning and contract clarification have already happened.
  const flags = initialCodingParent
    ? uniqueFlags([
        ...detectedFlags.filter(
          (flag) =>
            flag !== "implementation" &&
            flag !== "optimized_algorithm" &&
            flag !== "pseudocode_dry_run" &&
            flag !== "edge_case_validation"
        ),
        "baseline_solution",
      ])
    : detectedFlags;
  const phaseAuthorizedSubtaskIntent = initialCodingParent
    ? undefined
    : input.subtaskIntent;
  const requirementState = isSystemDesignQuestionType(questionType)
    ? resolveRequirementState({
        questionType,
        text,
        askFrame: input.askFrame,
        phaseProgress: input.phaseProgress,
        phaseControl: input.phaseControl,
        phaseControlSettled: input.phaseControlSettled,
      })
    : undefined;
  const phase = choosePhase({
    questionType,
    currentPhase,
    phaseProgress: input.phaseProgress,
    requirementsReady: requirementState?.requirementsReady,
    flags,
    subtaskIntent: phaseAuthorizedSubtaskIntent,
    relation: input.relation,
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
    requiredArtifacts: resolvePlaybookRequiredArtifacts({
      questionType,
      playbookId: input.playbookId,
      phase,
      subtaskIntent: phaseAuthorizedSubtaskIntent,
    }),
    completedFlags: requirementState
      ? requirementState.requirementsReady
        ? ["requirements"]
        : []
      : flags,
    action,
    reason: [
      buildReason(
        questionType,
        currentPhase,
        phase,
        flags,
        input.relation,
        requirementState
      ),
      initialCodingParent ? "initial-coding-parent-baseline-authority" : undefined,
    ]
      .filter(Boolean)
      .join("; "),
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
    phaseControl: input.phaseControl
      ? clonePhaseControlEvidence(input.phaseControl)
      : undefined,
    freshParentCreated: input.freshParentCreated,
    phaseStateCompatible: true,
  };
}

export function resolvePlaybookState(input: {
  questionType?: CanonicalQuestionType;
  playbookId?: InterviewPlaybookId;
  phase?: InterviewPlaybookPhase;
}): ResolvedPlaybookState {
  const phase =
    input.phase ?? initialPhaseFor(input.questionType, input.playbookId);
  return {
    phase,
    initializedFromStart: input.phase === undefined,
    phaseCompatible:
      input.phase === undefined ||
      isPlaybookPhaseCompatible(input.questionType, phase),
  };
}

export function composeScreenPlaybookPhaseInput(input: {
  catalogPhase?: InterviewPlaybookPhase;
  committedPhase?: InterviewPlaybookPhase;
  committedProgress?: Record<string, boolean>;
  freshParentCreated: boolean;
  currentOnly: boolean;
}) {
  const isolatedResponse = input.currentOnly || input.freshParentCreated;
  return {
    currentPhase: isolatedResponse
      ? input.catalogPhase
      : input.committedPhase ?? input.catalogPhase,
    phaseProgress: isolatedResponse
      ? undefined
      : input.committedProgress,
    freshParentCreated: input.freshParentCreated,
  };
}

export function decideInterviewerAssumptionAuthorization(input: {
  text: string;
  speaker: "me" | "them" | "unknown";
  activeQuestionType?: unknown;
  currentPhase?: InterviewPlaybookPhase;
  hasActiveChild?: boolean;
  sourceTurnId?: string;
}): InterviewerAssumptionAuthorizationDecision {
  const evidence = detectAssumptionAuthorizationEvidence(input.text);
  if (evidence.length === 0) {
    return {
      state: "not-detected",
      reason: "signal-not-detected",
      whiteboardRevisionRequested: false,
    };
  }

  const contextOnly = (
    reason: Exclude<
      InterviewerAssumptionAuthorizationDecision["reason"],
      "signal-not-detected" | "authorized"
    >
  ): InterviewerAssumptionAuthorizationDecision => ({
    state: "context-only",
    reason,
    phaseBefore: input.currentPhase,
    whiteboardRevisionRequested: false,
  });

  if (input.speaker !== "them") {
    return contextOnly("source-not-interviewer");
  }
  const questionType = normalizeCanonicalQuestionType(
    input.activeQuestionType
  );
  if (!isSystemDesignQuestionType(questionType)) {
    return contextOnly("active-parent-not-system-design");
  }
  if (input.currentPhase !== "requirement_clarification") {
    return contextOnly(
      "active-phase-not-requirement-clarification"
    );
  }
  if (input.hasActiveChild) {
    return contextOnly("active-child-present");
  }

  return {
    state: "authorized",
    reason: "authorized",
    phaseControl: {
      signal: "assumption-authorized",
      source: "interviewer",
      sourceTurnId: input.sourceTurnId,
      evidence,
    },
    phaseBefore: input.currentPhase,
    phaseAfter: "design_framing",
    whiteboardRevisionRequested: true,
  };
}

export function formatInterviewerAssumptionAuthorizationForTrace(
  decision: InterviewerAssumptionAuthorizationDecision
) {
  return {
    phaseSignal: decision.phaseControl?.signal,
    phaseSignalSource: decision.phaseControl?.source,
    phaseSignalSourceTurnId: decision.phaseControl?.sourceTurnId,
    assumptionAuthorizationState: decision.state,
    assumptionAuthorizationReason: decision.reason,
    assumptionAuthorizationEvidence:
      decision.phaseControl?.evidence,
    phaseBefore: decision.phaseBefore,
    phaseAfter: decision.phaseAfter,
    whiteboardRevisionRequested:
      decision.whiteboardRevisionRequested,
  };
}

export function decideManualNextPhaseTransition(
  task: ActiveMeetingTask | undefined
): PlaybookPhaseDecision {
  if (!task) {
    return {
      phase: "follow_up",
      flags: [],
      requiredArtifacts: ["answer"],
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
  const targetArtifact = chooseManualNextTargetArtifact(
    questionType,
    phase,
    flags
  );
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
    requiredArtifacts: resolvePlaybookRequiredArtifacts({
      questionType,
      playbookId: task.parent.playbook?.id,
      phase,
    }),
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
    decision?.requiredArtifacts.length
      ? `Required artifacts this phase: ${decision.requiredArtifacts.join(", ")}`
      : "Required artifacts this phase: answer",
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
    "- For Coding baseline_reasoning, explain the simplest correct solution for a listener with no programming background and give a small dry run. Do not emit Code or Complexity.",
    "- For Coding optimized_pseudocode, explain the bottleneck, optimized structure, pseudocode, edge cases, dry run, and target Complexity. Do not emit Code; preserve any existing Code artifact until implementation_validation replaces it.",
    "- For Coding implementation_validation, emit complete runnable Code in the selected language plus exact Complexity and validation cases.",
    task?.parent.questionType === "project-deep-dive" ||
    normalizeCanonicalQuestionType(task?.parent.questionType) ===
      "project-deep-dive" ||
    decision?.phase === "project_narrative" ||
    decision?.phase === "architecture_decision" ||
    decision?.phase === "validation_reliability" ||
    decision?.phase === "impact_lessons"
      ? formatProjectDeepDivePhaseContract(
          decision?.phase ?? task?.parent.playbookPhase ?? "project_narrative"
        )
      : undefined,
    "- Required artifacts are authoritative. Do not add a forbidden Code or Whiteboard section merely because the answer profile supports it.",
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
    playbookRequiredArtifacts: decision.requiredArtifacts,
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
    phaseSignal: decision.phaseControl?.signal,
    phaseSignalSource: decision.phaseControl?.source,
    phaseSignalSourceTurnId: decision.phaseControl?.sourceTurnId,
    playbookFreshParentCreated: decision.freshParentCreated,
    playbookPhaseStateCompatible: decision.phaseStateCompatible,
  };
}

function isPlaybookPhaseCompatible(
  questionType: CanonicalQuestionType | undefined,
  phase: InterviewPlaybookPhase
) {
  if (!questionType || questionType === "unknown") return true;
  if (phase === "follow_up") return true;
  if (questionType === "behavioral") return phase === "story_selection";
  if (questionType === "coding") {
    return (
      phase === "baseline_reasoning" ||
      phase === "optimized_pseudocode" ||
      phase === "implementation_validation" ||
      phase === "solution_planning"
    );
  }
  if (
    questionType === "general-system-design" ||
    questionType === "ai-ml-system-design"
  ) {
    return (
      phase === "requirement_clarification" ||
      phase === "design_framing"
    );
  }
  if (questionType === "project-deep-dive") {
    return (
      phase === "project_narrative" ||
      phase === "architecture_decision" ||
      phase === "validation_reliability" ||
      phase === "impact_lessons"
    );
  }
  return (
    questionType === "field-knowledge" && phase === "concept_explanation"
  );
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
  if (questionType === "project-deep-dive") {
    if (currentPhase === "project_narrative") return "architecture_decision";
    if (currentPhase === "architecture_decision") {
      return "validation_reliability";
    }
    if (currentPhase === "validation_reliability") return "impact_lessons";
    return "impact_lessons";
  }
  if (questionType === "field-knowledge") return "follow_up";
  if (questionType === "coding") {
    const codingPhase = normalizeCodingPhase(currentPhase);
    if (codingPhase === "baseline_reasoning") {
      return "optimized_pseudocode";
    }
    return "implementation_validation";
  }
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
    if (currentPhase === "project_narrative") {
      return ["architecture", "hard_problem", "tradeoff_decision"];
    }
    if (currentPhase === "architecture_decision") {
      return ["validation_debugging"];
    }
    return ["impact_lesson", "tradeoffs_wrapup"];
  }

  if (questionType === "behavioral") {
    return ["impact_lesson", "tradeoffs_wrapup"];
  }

  if (questionType === "coding") {
    const codingPhase = normalizeCodingPhase(currentPhase);
    if (codingPhase === "baseline_reasoning") {
      return ["optimized_algorithm", "pseudocode_dry_run"];
    }
    return ["implementation", "edge_case_validation"];
  }

  if (questionType === "field-knowledge") {
    return ["tradeoffs_wrapup"];
  }

  return [];
}

function chooseManualNextTargetArtifact(
  questionType: CanonicalQuestionType | undefined,
  phase: InterviewPlaybookPhase,
  flags: PlaybookPhaseFlag[]
): PlaybookPhaseTargetArtifact {
  if (flags.includes("whiteboard")) return "whiteboard";
  if (questionType === "coding") {
    return phase === "implementation_validation" ? "code" : "answer";
  }
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
  askFrame: TaskAskFrame | undefined,
  subtaskIntent: InterviewSubtaskIntent | undefined
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
    return detectCodingFlags(text, subtaskIntent);
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
    matchesAny(text, PROJECT_ARCHITECTURE_PHASE_EVIDENCE_PATTERNS)
      ? "architecture"
      : undefined,
    matchesAny(text, PROJECT_HARD_PROBLEM_PHASE_EVIDENCE_PATTERNS)
      ? "hard_problem"
      : undefined,
    matchesAny(text, PROJECT_ARCHITECTURE_PHASE_EVIDENCE_PATTERNS) &&
    matchesAny(text, ["why did you choose", "tradeoff", "trade off", "pros and cons"])
      ? "tradeoff_decision"
      : undefined,
    matchesAny(text, PROJECT_VALIDATION_PHASE_EVIDENCE_PATTERNS)
      ? "validation_debugging"
      : undefined,
    matchesAny(text, PROJECT_IMPACT_PHASE_EVIDENCE_PATTERNS)
      ? "impact_lesson"
      : undefined,
  ]);
}

function detectCodingFlags(
  text: string,
  subtaskIntent: InterviewSubtaskIntent | undefined
): PlaybookPhaseFlag[] {
  const implementationRequested =
    subtaskIntent === "implementation-probe" ||
    matchesAny(text, CODING_IMPLEMENTATION_PATTERNS);
  const optimizationRequested =
    subtaskIntent === "complexity-probe" ||
    matchesAny(text, CODING_OPTIMIZATION_PATTERNS);
  const validationRequested =
    implementationRequested &&
    matchesAny(text, CODING_VALIDATION_PATTERNS);

  return uniqueFlags([
    implementationRequested ? "implementation" : undefined,
    optimizationRequested ? "optimized_algorithm" : undefined,
    optimizationRequested ? "pseudocode_dry_run" : undefined,
    validationRequested ? "edge_case_validation" : undefined,
    !implementationRequested && !optimizationRequested
      ? "baseline_solution"
      : undefined,
  ]);
}

function detectCommonFlags(
  text: string,
  questionType?: CanonicalQuestionType
): PlaybookPhaseFlag[] {
  return uniqueFlags([
    matchesAny(text, WHITEBOARD_PATTERNS) ? "whiteboard" : undefined,
    questionType !== "project-deep-dive" &&
    matchesAny(text, TRADEOFF_PATTERNS)
      ? "tradeoffs_wrapup"
      : undefined,
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

function chooseCodingPhase({
  currentPhase,
  flags,
  subtaskIntent,
}: {
  currentPhase: InterviewPlaybookPhase;
  flags: PlaybookPhaseFlag[];
  subtaskIntent?: InterviewSubtaskIntent;
}): InterviewPlaybookPhase {
  const normalizedCurrent = normalizeCodingPhase(currentPhase);
  if (normalizedCurrent === "implementation_validation") {
    return normalizedCurrent;
  }
  if (
    subtaskIntent === "implementation-probe" ||
    flags.includes("implementation")
  ) {
    return "implementation_validation";
  }
  if (
    normalizedCurrent === "optimized_pseudocode" ||
    subtaskIntent === "complexity-probe" ||
    flags.includes("optimized_algorithm")
  ) {
    return "optimized_pseudocode";
  }
  return "baseline_reasoning";
}

function normalizeCodingPhase(
  phase: InterviewPlaybookPhase | undefined
):
  | "baseline_reasoning"
  | "optimized_pseudocode"
  | "implementation_validation" {
  if (phase === "optimized_pseudocode") return phase;
  if (phase === "implementation_validation") return phase;
  return "baseline_reasoning";
}

function choosePhase({
  questionType,
  currentPhase,
  phaseProgress,
  requirementsReady,
  flags,
  subtaskIntent,
  relation,
}: {
  questionType: CanonicalQuestionType | undefined;
  currentPhase: InterviewPlaybookPhase;
  phaseProgress?: Record<string, boolean>;
  requirementsReady?: boolean;
  flags: PlaybookPhaseFlag[];
  subtaskIntent?: InterviewSubtaskIntent;
  relation?: InterviewTaskRelation;
}): InterviewPlaybookPhase {
  if (questionType === "behavioral") return "story_selection";
  if (questionType === "coding") {
    return chooseCodingPhase({
      currentPhase,
      flags,
      subtaskIntent,
    });
  }
  if (questionType === "field-knowledge") return "concept_explanation";
  if (questionType === "project-deep-dive") {
    return chooseProjectDeepDivePhase({
      currentPhase,
      flags,
      relation,
    });
  }

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

const PROJECT_DEEP_DIVE_PHASES: InterviewPlaybookPhase[] = [
  "project_narrative",
  "architecture_decision",
  "validation_reliability",
  "impact_lessons",
];

function chooseProjectDeepDivePhase({
  currentPhase,
  flags,
  relation,
}: {
  currentPhase: InterviewPlaybookPhase;
  flags: PlaybookPhaseFlag[];
  relation?: InterviewTaskRelation;
}): InterviewPlaybookPhase {
  const normalizedCurrent = PROJECT_DEEP_DIVE_PHASES.includes(currentPhase)
    ? currentPhase
    : "project_narrative";
  if (relation === "resume-parent") return normalizedCurrent;

  const requestedPhase = flags.includes("impact_lesson")
    ? "impact_lessons"
    : flags.includes("validation_debugging")
      ? "validation_reliability"
      : flags.includes("architecture") ||
          flags.includes("hard_problem") ||
          flags.includes("tradeoff_decision")
        ? "architecture_decision"
        : "project_narrative";
  const currentIndex = PROJECT_DEEP_DIVE_PHASES.indexOf(normalizedCurrent);
  const requestedIndex = PROJECT_DEEP_DIVE_PHASES.indexOf(requestedPhase);
  return PROJECT_DEEP_DIVE_PHASES[Math.max(currentIndex, requestedIndex)];
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
    return "baseline_reasoning";
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
  phaseControl,
  phaseControlSettled,
}: {
  questionType: "general-system-design" | "ai-ml-system-design";
  text: string;
  askFrame?: TaskAskFrame;
  phaseProgress?: Record<string, boolean>;
  phaseControl?: PlaybookPhaseControlEvidence;
  phaseControlSettled?: boolean;
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
  const explicitAssumptions =
    phaseControl?.signal === "assumption-authorized" ||
    (!phaseControlSettled && asksToProceedWithAssumptions(text));
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
  return detectAssumptionAuthorizationEvidence(text).length > 0;
}

function detectAssumptionAuthorizationEvidence(text: string) {
  const normalized = normalizePhaseText([text]);
  if (
    /\b(?:do not|don't|cannot|can't|should not|shouldn't)\s+(?:make|use|take)?\s*(?:any\s+)?assumptions?\b/.test(
      normalized
    )
  ) {
    return [];
  }

  const patterns: Array<[string, RegExp]> = [
    [
      "permission-to-make-assumptions",
      /\b(?:you\s+(?:can|may|should)|please|feel free to)\s+(?:just\s+)?(?:make|use|take)\s+(?:(?:your own|reasonable|some|the necessary)\s+)?assumptions?\b/,
    ],
    [
      "permission-to-assume-needed-values",
      /\b(?:you\s+(?:can|may)|please)\s+assume\s+(?:whatever|anything|what)\s+(?:you\s+)?(?:need|want)\b/,
    ],
    [
      "proceed-with-assumptions",
      /\b(?:proceed|continue|move forward)\s+with\s+(?:(?:your|reasonable|the necessary)\s+)?assumptions?\b/,
    ],
    [
      "make-assumptions-and-proceed",
      /\b(?:make|use|take)\s+(?:(?:your own|reasonable|some|the necessary)\s+)?assumptions?\s+(?:and\s+)?(?:proceed|continue|move forward)\b/,
    ],
    [
      "permission-to-form-hypothesis",
      /\b(?:you\s+(?:can|may|should)|please)\s+(?:make|choose|use|form)\s+(?:(?:the|a|your own|reasonable)\s+)?hypothes(?:is|es)\s+(?:(?:by\s+)?yourself|on your own)\b/,
    ],
  ];
  return patterns
    .filter(([, pattern]) => pattern.test(normalized))
    .map(([label]) => label);
}

function clonePhaseControlEvidence(
  evidence: PlaybookPhaseControlEvidence
): PlaybookPhaseControlEvidence {
  return {
    ...evidence,
    evidence: [...evidence.evidence],
  };
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
