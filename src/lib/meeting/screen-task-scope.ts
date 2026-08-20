import type { AdvisorJobSource } from "./advisor-trigger-job";
import type {
  AdvisorCurrentQuestionEvidence,
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

export interface ManualScreenVoiceQuestionTarget {
  logicalQuestionUnitId?: string | null;
  logicalQuestionRevision?: number | null;
}

export type ManualScreenVoiceQuestionBindingReason =
  | "no-voice-candidate"
  | "active-voice-attempt"
  | "pending-voice-delivery"
  | "explicit-recovery-target"
  | "context-insufficient-visible-answer"
  | "visible-answer-already-committed"
  | "voice-recovery-not-authorized";

export interface ManualScreenVoiceQuestionBindingDecision {
  disposition: "bind-voice" | "use-screen";
  reason: ManualScreenVoiceQuestionBindingReason;
  candidate?: ManualScreenVoiceQuestionCapsule;
}

export interface ManualScreenSourcePacket {
  primaryAsk?: AdvisorCurrentQuestionEvidence;
  visualEvidence: {
    screenObservationId: string;
    preflightQuestion?: string;
  };
  sourceOperationAuthority: {
    source: "manual-screen";
    explicitCapture: true;
    boundVoicePrimaryAsk: boolean;
  };
}

export interface CommittedManualScreenQuestionPacket
  extends ManualScreenSourcePacket {
  primaryAsk: AdvisorCurrentQuestionEvidence & { sourceHash: string };
  questionIdentity: {
    sessionId: string;
    runtimeEpoch: number;
    logicalQuestionUnitId: string;
    revision: number;
    sourceHash: string;
  };
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

/**
 * Manual Screen capture is a new question milestone by default. Voice keeps
 * ownership only while the exact attempt is unresolved or a committed answer
 * explicitly reports that nearby evidence is missing.
 */
export function decideManualScreenVoiceQuestionBinding(input: {
  candidate?: ManualScreenVoiceQuestionCapsule;
  activeVoiceAttempt?: ManualScreenVoiceQuestionTarget;
  pendingVoiceDelivery?: ManualScreenVoiceQuestionTarget;
  explicitRecoveryTarget?: ManualScreenVoiceQuestionTarget;
  visibleAnswer?: ManualScreenVoiceQuestionTarget;
  visibleAnswerContextInsufficient?: boolean;
}): ManualScreenVoiceQuestionBindingDecision {
  const candidate = input.candidate;
  if (!candidate) {
    return {
      disposition: "use-screen",
      reason: "no-voice-candidate",
    };
  }

  if (sameVoiceQuestionTarget(candidate, input.activeVoiceAttempt)) {
    return {
      disposition: "bind-voice",
      reason: "active-voice-attempt",
      candidate,
    };
  }
  if (sameVoiceQuestionTarget(candidate, input.pendingVoiceDelivery)) {
    return {
      disposition: "bind-voice",
      reason: "pending-voice-delivery",
      candidate,
    };
  }
  if (sameVoiceQuestionTarget(candidate, input.explicitRecoveryTarget)) {
    return {
      disposition: "bind-voice",
      reason: "explicit-recovery-target",
      candidate,
    };
  }

  const visibleAnswerMatches = sameVoiceQuestionTarget(
    candidate,
    input.visibleAnswer
  );
  if (visibleAnswerMatches && input.visibleAnswerContextInsufficient) {
    return {
      disposition: "bind-voice",
      reason: "context-insufficient-visible-answer",
      candidate,
    };
  }
  if (visibleAnswerMatches) {
    return {
      disposition: "use-screen",
      reason: "visible-answer-already-committed",
      candidate,
    };
  }

  return {
    disposition: "use-screen",
    reason: "voice-recovery-not-authorized",
    candidate,
  };
}

export function formatManualScreenVoiceQuestionBindingForTrace(
  decision: ManualScreenVoiceQuestionBindingDecision
): Record<string, unknown> {
  return {
    manualScreenVoiceCandidateLogicalQuestionUnitId:
      decision.candidate?.logicalQuestionUnitId,
    manualScreenVoiceCandidateLogicalQuestionRevision:
      decision.candidate?.logicalQuestionRevision,
    manualScreenVoiceCandidateSourceTurnIds:
      decision.candidate?.sourceTurnIds ?? [],
    manualScreenVoiceCandidateChars:
      decision.candidate?.text.length ?? 0,
    manualScreenVoiceBindingDisposition: decision.disposition,
    manualScreenVoiceBindingReason: decision.reason,
    manualScreenFinalQuestionOwner:
      decision.disposition === "bind-voice" ? "voice-lqu" : "screen-preflight",
  };
}

export function resolveManualScreenSourcePacket(input: {
  voiceQuestion?: ManualScreenVoiceQuestionCapsule;
  screenObservationId: string;
  screenPreflightQuestion?: string;
}): ManualScreenSourcePacket {
  const screenPreflightQuestion =
    input.screenPreflightQuestion?.trim() || undefined;
  const primaryAsk: AdvisorCurrentQuestionEvidence | undefined =
    input.voiceQuestion
      ? {
          text: input.voiceQuestion.text,
          source: "voice-lqu",
          sourceTurnIds: [...input.voiceQuestion.sourceTurnIds],
          logicalQuestionUnitId:
            input.voiceQuestion.logicalQuestionUnitId,
          revision: input.voiceQuestion.logicalQuestionRevision,
          screenObservationId: input.screenObservationId,
        }
      : screenPreflightQuestion
        ? {
            text: screenPreflightQuestion,
            source: "screen-preflight",
            sourceTurnIds: [],
            screenObservationId: input.screenObservationId,
          }
        : undefined;

  return {
    primaryAsk,
    visualEvidence: {
      screenObservationId: input.screenObservationId,
      preflightQuestion: screenPreflightQuestion,
    },
    sourceOperationAuthority: {
      source: "manual-screen",
      explicitCapture: true,
      boundVoicePrimaryAsk: Boolean(input.voiceQuestion),
    },
  };
}

export function commitManualScreenQuestionPacket(input: {
  packet: ManualScreenSourcePacket;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  revision: number;
  sourceHash: string;
}): CommittedManualScreenQuestionPacket {
  const primaryAsk = input.packet.primaryAsk;
  if (!primaryAsk?.text.trim() || !input.sourceHash.trim()) {
    throw new Error("Manual Screen question source is incomplete.");
  }
  if (
    primaryAsk.source === "voice-lqu" &&
    (primaryAsk.logicalQuestionUnitId !== input.logicalQuestionUnitId ||
      primaryAsk.revision !== input.revision)
  ) {
    throw new Error("Manual Screen Voice question identity changed before commit.");
  }

  return {
    ...input.packet,
    primaryAsk: {
      ...primaryAsk,
      sourceHash: input.sourceHash,
    },
    questionIdentity: {
      sessionId: input.sessionId,
      runtimeEpoch: input.runtimeEpoch,
      logicalQuestionUnitId: input.logicalQuestionUnitId,
      revision: input.revision,
      sourceHash: input.sourceHash,
    },
  };
}

export function isCommittedManualScreenQuestionPacket(
  packet: ManualScreenSourcePacket | CommittedManualScreenQuestionPacket
): packet is CommittedManualScreenQuestionPacket {
  return "questionIdentity" in packet;
}

export function formatManualScreenSourcePacketForTrace(
  packet: ManualScreenSourcePacket | CommittedManualScreenQuestionPacket
): Record<string, unknown> {
  const identity = isCommittedManualScreenQuestionPacket(packet)
    ? packet.questionIdentity
    : undefined;
  return {
    manualScreenPrimaryAskSource: packet.primaryAsk?.source,
    manualScreenPrimaryAskChars: packet.primaryAsk?.text.length ?? 0,
    manualScreenPrimaryAskSourceTurnIds:
      packet.primaryAsk?.sourceTurnIds ?? [],
    manualScreenPrimaryAskLogicalQuestionUnitId:
      packet.primaryAsk?.logicalQuestionUnitId,
    manualScreenPrimaryAskLogicalQuestionRevision:
      packet.primaryAsk?.revision,
    manualScreenPrimaryAskSourceHash:
      packet.primaryAsk?.sourceHash,
    manualScreenVisualEvidenceObservationId:
      packet.visualEvidence.screenObservationId,
    manualScreenVisualEvidenceQuestionChars:
      packet.visualEvidence.preflightQuestion?.length ?? 0,
    manualScreenSourceOperationAuthority:
      packet.sourceOperationAuthority.source,
    manualScreenExplicitCapture:
      packet.sourceOperationAuthority.explicitCapture,
    manualScreenBoundVoicePrimaryAsk:
      packet.sourceOperationAuthority.boundVoicePrimaryAsk,
    manualScreenQuestionPacketCommitted: Boolean(identity),
    manualScreenQuestionPacketSessionId: identity?.sessionId,
    manualScreenQuestionPacketRuntimeEpoch: identity?.runtimeEpoch,
    manualScreenQuestionPacketLogicalQuestionUnitId:
      identity?.logicalQuestionUnitId,
    manualScreenQuestionPacketLogicalQuestionRevision:
      identity?.revision,
    manualScreenQuestionPacketSourceHash: identity?.sourceHash,
  };
}

function sameVoiceQuestionTarget(
  candidate: ManualScreenVoiceQuestionCapsule,
  target: ManualScreenVoiceQuestionTarget | undefined
) {
  return Boolean(
    target &&
      target.logicalQuestionUnitId === candidate.logicalQuestionUnitId &&
      target.logicalQuestionRevision === candidate.logicalQuestionRevision
  );
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
