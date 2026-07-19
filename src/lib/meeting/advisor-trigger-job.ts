import type { AdvisorTurnIntentDecision } from "./advisor-turn-intent.js";
import { createMeetingId } from "./context-manager.js";
import type { PlaybookPhaseDecision } from "./playbook-phase.js";
import type {
  AdvisorPromptContext,
  AdvisorRequestMode,
  InterviewPlaybookPhase,
  InterviewTaskRelation,
} from "./types.js";

export type AdvisorJobSource =
  | "live-turn"
  | "regenerate"
  | "response-action"
  | "clarifying-answer"
  | "manual-correction";

export type AdvisorTaskMutationAuthority =
  | "input-evidence"
  | "preserve-parent"
  | "manual-correction";

export type AdvisorJobOutcome =
  | "scheduled"
  | "executing"
  | "committed"
  | "suppressed"
  | "replaced-before-execution"
  | "cancelled-by-new-job"
  | "cancelled-by-runtime-boundary"
  | "stale-commit-rejected"
  | "error";

export interface AdvisorTriggerJob {
  id: string;
  source: AdvisorJobSource;
  mode: AdvisorRequestMode;
  traceId?: string;
  triggerTurnId?: string;
  promptContextSnapshot: AdvisorPromptContext;
  turnIntentDecision?: AdvisorTurnIntentDecision;
  expectedSessionId: string;
  expectedParentId?: string;
  expectedParentRevision?: number;
  taskMutationAuthority: AdvisorTaskMutationAuthority;
  snapshotTurnCount: number;
  scheduledAt: number;
}

export interface CreateAdvisorTriggerJobInput {
  source: AdvisorJobSource;
  mode: AdvisorRequestMode;
  traceId?: string;
  triggerTurnId?: string;
  promptContext: AdvisorPromptContext;
  turnIntentDecision?: AdvisorTurnIntentDecision;
  sessionId: string;
  snapshotTurnCount: number;
  taskMutationAuthority: AdvisorTaskMutationAuthority;
  scheduledAt?: number;
}

export interface AdvisorJobCommitDecision {
  authorized: boolean;
  reason:
    | "active-job-and-session-match"
    | "active-job-mismatch"
    | "session-mismatch";
}

export interface AdvisorTaskMutationDecision {
  relation: InterviewTaskRelation;
  commitParent: boolean;
  preserveParentType: boolean;
  allowExplicitRetype: boolean;
  reason:
    | "input-evidence-authority"
    | "manual-correction-authority"
    | "explicit-action-preserve-parent"
    | "explicit-action-without-parent";
}

export function createAdvisorTriggerJob(
  input: CreateAdvisorTriggerJobInput
): AdvisorTriggerJob {
  const snapshot = cloneAdvisorPromptContext(input.promptContext);
  return {
    id: createMeetingId("advisor_job"),
    source: input.source,
    mode: input.mode,
    traceId: input.traceId,
    triggerTurnId: input.triggerTurnId,
    promptContextSnapshot: snapshot,
    turnIntentDecision: input.turnIntentDecision
      ? { ...input.turnIntentDecision }
      : undefined,
    expectedSessionId: input.sessionId,
    expectedParentId:
      snapshot.activeMeetingTask?.parent.id ??
      snapshot.activeInterviewTask?.id,
    expectedParentRevision:
      snapshot.activeMeetingTask?.parent.revisions ??
      snapshot.activeInterviewTask?.revisions,
    taskMutationAuthority: input.taskMutationAuthority,
    snapshotTurnCount: input.snapshotTurnCount,
    scheduledAt: input.scheduledAt ?? Date.now(),
  };
}

export function decideAdvisorJobCommit(input: {
  job: AdvisorTriggerJob;
  activeJobId?: string;
  currentSessionId: string;
}): AdvisorJobCommitDecision {
  if (input.activeJobId !== input.job.id) {
    return {
      authorized: false,
      reason: "active-job-mismatch",
    };
  }

  if (input.currentSessionId !== input.job.expectedSessionId) {
    return {
      authorized: false,
      reason: "session-mismatch",
    };
  }

  return {
    authorized: true,
    reason: "active-job-and-session-match",
  };
}

export function decideAdvisorTaskMutation(input: {
  authority: AdvisorTaskMutationAuthority;
  resolvedRelation: InterviewTaskRelation;
  hasActiveParent: boolean;
  hasActiveChild: boolean;
}): AdvisorTaskMutationDecision {
  if (input.authority === "manual-correction") {
    return {
      relation: input.resolvedRelation,
      commitParent: true,
      preserveParentType: false,
      allowExplicitRetype: true,
      reason: "manual-correction-authority",
    };
  }

  if (input.authority === "input-evidence") {
    return {
      relation: input.resolvedRelation,
      commitParent: true,
      preserveParentType: false,
      allowExplicitRetype: false,
      reason: "input-evidence-authority",
    };
  }

  if (!input.hasActiveParent) {
    return {
      relation: input.resolvedRelation,
      commitParent: false,
      preserveParentType: true,
      allowExplicitRetype: false,
      reason: "explicit-action-without-parent",
    };
  }

  return {
    relation: input.hasActiveChild ? "resume-parent" : "followup-parent",
    commitParent: true,
    preserveParentType: true,
    allowExplicitRetype: false,
    reason: "explicit-action-preserve-parent",
  };
}

export function decideAdvisorPhaseMutation(input: {
  authority: AdvisorTaskMutationAuthority;
  manualPhaseAdvance: boolean;
  currentPhase: InterviewPlaybookPhase;
  hasActiveChild: boolean;
  automaticDecision: PlaybookPhaseDecision;
  manualDecision: PlaybookPhaseDecision;
}): PlaybookPhaseDecision {
  if (input.manualPhaseAdvance) return input.manualDecision;
  if (input.authority !== "preserve-parent") {
    return input.automaticDecision;
  }

  return {
    phase: input.currentPhase,
    flags: [],
    action: input.hasActiveChild ? "resume-parent" : "stay",
    reason: "explicit-action-preserve-parent-phase",
    source: "automatic",
    targetArtifact: "answer",
    guardStatus: "automatic",
    phaseFrom: input.currentPhase,
  };
}

export function formatAdvisorTriggerJobForTrace(
  job: AdvisorTriggerJob,
  outcome: AdvisorJobOutcome,
  extra: {
    cancellationReason?: string;
    commitAuthorized?: boolean;
    commitAuthorizationReason?: string;
  } = {}
) {
  return {
    advisorJobId: job.id,
    advisorJobSource: job.source,
    advisorJobTriggerTurnId: job.triggerTurnId,
    advisorJobExpectedSessionId: job.expectedSessionId,
    advisorJobExpectedParentId: job.expectedParentId,
    advisorJobExpectedParentRevision: job.expectedParentRevision,
    advisorJobMutationAuthority: job.taskMutationAuthority,
    advisorJobSnapshotTurnCount: job.snapshotTurnCount,
    advisorJobSnapshotLatestTurnId: job.promptContextSnapshot.latestTurn?.id,
    advisorJobOutcome: outcome,
    advisorJobCancellationReason: extra.cancellationReason,
    advisorJobCommitAuthorized: extra.commitAuthorized,
    advisorJobCommitAuthorizationReason: extra.commitAuthorizationReason,
  };
}

function cloneAdvisorPromptContext(
  context: AdvisorPromptContext
): AdvisorPromptContext {
  if (typeof structuredClone === "function") {
    return structuredClone(context);
  }

  return JSON.parse(JSON.stringify(context)) as AdvisorPromptContext;
}
