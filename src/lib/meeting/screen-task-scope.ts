import type { AdvisorJobSource } from "./advisor-trigger-job";
import type {
  AdvisorPromptContext,
  AdvisorRequestMode,
  InterviewTaskRelation,
  ScreenObservation,
  ScreenQuestionType,
} from "./types";

interface ScreenSourceTaskView {
  parent: { id: string };
  screen?: { observationId?: string };
}

interface VoiceQuestionCapsuleCandidate {
  id: string;
  revision: number;
  sessionId: string;
  runtimeEpoch: number;
  normalizedText: string;
  sourceTurnIds: string[];
}

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

export type AdvisorScreenSourceReadDisposition =
  | "attached"
  | "not-screen-anchored"
  | "session-mismatch"
  | "runtime-epoch-mismatch"
  | "no-active-parent"
  | "parent-mismatch"
  | "no-screen-binding"
  | "observation-not-found"
  | "image-unavailable"
  | "provider-image-unsupported";

export interface AdvisorScreenSourceReadDecision {
  disposition: AdvisorScreenSourceReadDisposition;
  sourceScreenObservationId?: string;
  sourceScreenParentId?: string;
  sourceVoiceTurnIds: string[];
  image?: {
    base64: string;
    mediaType: string;
  };
}

export interface ManualScreenVoiceQuestionCapsule {
  logicalQuestionUnitId: string;
  logicalQuestionRevision: number;
  text: string;
  sourceTurnIds: string[];
}

export function selectManualScreenVoiceQuestionCapsule<
  T extends VoiceQuestionCapsuleCandidate,
>(input: {
  sessionId: string;
  runtimeEpoch: number;
  candidates: Array<T | undefined>;
}): ManualScreenVoiceQuestionCapsule | undefined {
  const unit = input.candidates.find(
    (candidate) =>
      candidate?.sessionId === input.sessionId &&
      candidate.runtimeEpoch === input.runtimeEpoch &&
      candidate.normalizedText.trim()
  );
  if (!unit) return undefined;
  return {
    logicalQuestionUnitId: unit.id,
    logicalQuestionRevision: unit.revision,
    text: unit.normalizedText.trim(),
    sourceTurnIds: [...unit.sourceTurnIds],
  };
}

export function resolveAdvisorScreenSourceRead<
  T extends ScreenSourceTaskView,
>(input: {
  mode: AdvisorRequestMode;
  expectedSessionId: string;
  currentSessionId: string;
  expectedRuntimeEpoch: number;
  currentRuntimeEpoch: number;
  expectedParentId?: string;
  activeMeetingTask?: T;
  screenObservations: ScreenObservation[];
  sourceVoiceTurnIds?: string[];
  providerSupportsImages: boolean;
}): AdvisorScreenSourceReadDecision {
  const sourceVoiceTurnIds = Array.from(
    new Set(input.sourceVoiceTurnIds ?? [])
  );
  const result = (
    disposition: AdvisorScreenSourceReadDisposition,
    extra: Partial<AdvisorScreenSourceReadDecision> = {}
  ): AdvisorScreenSourceReadDecision => ({
    disposition,
    sourceVoiceTurnIds,
    ...extra,
  });

  if (input.mode !== "screen-anchored") {
    return result("not-screen-anchored");
  }
  if (input.expectedSessionId !== input.currentSessionId) {
    return result("session-mismatch");
  }
  if (input.expectedRuntimeEpoch !== input.currentRuntimeEpoch) {
    return result("runtime-epoch-mismatch");
  }
  const task = input.activeMeetingTask;
  if (!task) return result("no-active-parent");
  if (input.expectedParentId && input.expectedParentId !== task.parent.id) {
    return result("parent-mismatch", {
      sourceScreenParentId: task.parent.id,
    });
  }
  if (!task.screen?.observationId) {
    return result("no-screen-binding", {
      sourceScreenParentId: task.parent.id,
    });
  }
  const observation = input.screenObservations.find(
    (candidate) => candidate.id === task.screen?.observationId
  );
  if (!observation) {
    return result("observation-not-found", {
      sourceScreenObservationId: task.screen.observationId,
      sourceScreenParentId: task.parent.id,
    });
  }
  if (!observation.imageBase64) {
    return result("image-unavailable", {
      sourceScreenObservationId: observation.id,
      sourceScreenParentId: task.parent.id,
    });
  }
  if (!input.providerSupportsImages) {
    return result("provider-image-unsupported", {
      sourceScreenObservationId: observation.id,
      sourceScreenParentId: task.parent.id,
    });
  }
  return result("attached", {
    sourceScreenObservationId: observation.id,
    sourceScreenParentId: task.parent.id,
    image: {
      base64: observation.imageBase64,
      mediaType: observation.imageMediaType ?? "image/jpeg",
    },
  });
}

export function formatAdvisorScreenSourceReadForTrace(
  decision: AdvisorScreenSourceReadDecision
): Record<string, unknown> {
  return {
    sourceScreenObservationId: decision.sourceScreenObservationId,
    sourceScreenParentId: decision.sourceScreenParentId,
    sourceVoiceTurnIds: decision.sourceVoiceTurnIds,
    sourceReadDisposition: decision.disposition,
    sourceScreenImageAttached: Boolean(decision.image),
  };
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
