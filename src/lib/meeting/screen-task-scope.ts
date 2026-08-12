import type { AdvisorJobSource } from "./advisor-trigger-job";
import type {
  AdvisorPromptContext,
  AdvisorRequestMode,
  InterviewTaskRelation,
  ScreenQuestionType,
} from "./types";

export type ScreenScopeAction =
  | "keep"
  | "clear"
  | "replace"
  | "provisional";

export type ScreenScopeDurability = "durable" | "provisional" | "none";

export type ScreenScopeReason =
  | "no-active-screen"
  | "voice-new-parent"
  | "turn-intent-mutation-suppressed"
  | "existing-task-continuity"
  | "explicit-action-preserve"
  | "screen-result-classified"
  | "screen-result-unknown"
  | "screen-result-ambiguous"
  | "screen-result-non-question"
  | "screen-result-empty";

export interface ScreenScopeDecision {
  action: ScreenScopeAction;
  durability: ScreenScopeDurability;
  mutationAuthorized: boolean;
  reason: ScreenScopeReason;
}

export function decideAdvisorScreenScope(input: {
  triggerSource: AdvisorJobSource;
  relation: InterviewTaskRelation;
  hasActiveScreenTask: boolean;
  taskMutationAuthorized?: boolean;
}): ScreenScopeDecision {
  if (!input.hasActiveScreenTask) {
    return {
      action: "keep",
      durability: "none",
      mutationAuthorized: false,
      reason: "no-active-screen",
    };
  }

  if (input.taskMutationAuthorized === false) {
    return {
      action: "keep",
      durability: "durable",
      mutationAuthorized: false,
      reason: "turn-intent-mutation-suppressed",
    };
  }

  if (input.triggerSource !== "live-turn") {
    return {
      action: "keep",
      durability: "durable",
      mutationAuthorized: false,
      reason: "explicit-action-preserve",
    };
  }

  if (input.relation === "new-parent") {
    return {
      action: "clear",
      durability: "none",
      mutationAuthorized: true,
      reason: "voice-new-parent",
    };
  }

  return {
    action: "keep",
    durability: "durable",
    mutationAuthorized: false,
    reason: "existing-task-continuity",
  };
}

export function decideScreenResultScope(input: {
  questionType: ScreenQuestionType | undefined;
  hasAnswer: boolean;
}): ScreenScopeDecision {
  if (!input.hasAnswer) {
    return {
      action: "keep",
      durability: "none",
      mutationAuthorized: false,
      reason: "screen-result-empty",
    };
  }

  if (input.questionType === "non-question") {
    return {
      action: "keep",
      durability: "none",
      mutationAuthorized: false,
      reason: "screen-result-non-question",
    };
  }

  if (input.questionType === "ambiguous") {
    return {
      action: "provisional",
      durability: "provisional",
      mutationAuthorized: false,
      reason: "screen-result-ambiguous",
    };
  }

  if (!input.questionType || input.questionType === "unknown") {
    return {
      action: "provisional",
      durability: "provisional",
      mutationAuthorized: false,
      reason: "screen-result-unknown",
    };
  }

  return {
    action: "replace",
    durability: "durable",
    mutationAuthorized: true,
    reason: "screen-result-classified",
  };
}

export function applyAdvisorScreenScopeToPromptContext(
  context: AdvisorPromptContext,
  decision: ScreenScopeDecision
): AdvisorPromptContext {
  if (decision.action !== "clear") return context;

  return {
    ...context,
    screenContext: "",
    taskRuntime: {
      revision: context.taskRuntime.revision,
      lastMutation: context.taskRuntime.lastMutation,
    },
    activeMeetingTask: undefined,
    interviewPlaybook: undefined,
    playbookPhaseDecision: undefined,
    factAnchorDecision: undefined,
    projectBindingDecision: undefined,
    openingRoute: undefined,
  };
}

export function resolveAdvisorTaskEvidenceSource(input: {
  triggerSource: AdvisorJobSource;
  hasActiveScreenTask: boolean;
}): "screen" | "voice" {
  if (input.triggerSource === "live-turn") return "voice";
  return input.hasActiveScreenTask ? "screen" : "voice";
}

export function resolveAdvisorRequestModeForScreenScope(
  mode: AdvisorRequestMode,
  decision: ScreenScopeDecision
): AdvisorRequestMode {
  return decision.action === "clear" && mode === "screen-anchored"
    ? "live"
    : mode;
}

export function formatScreenScopeDecisionForTrace(
  decision: ScreenScopeDecision,
  context: {
    stage: "request" | "commit";
    mutationApplied: boolean;
    previousScreenTaskId?: string;
    nextScreenTaskId?: string;
    previousParentId?: string;
    nextParentId?: string;
  }
): Record<string, unknown> {
  return {
    screenScopeStage: context.stage,
    screenScopeAction: decision.action,
    screenScopeDurability: decision.durability,
    screenScopeReason: decision.reason,
    screenScopeMutationAuthorized: decision.mutationAuthorized,
    screenScopeMutationApplied: context.mutationApplied,
    screenScopePreviousScreenTaskId: context.previousScreenTaskId,
    screenScopeNextScreenTaskId: context.nextScreenTaskId,
    screenScopePreviousParentId: context.previousParentId,
    screenScopeNextParentId: context.nextParentId,
  };
}
