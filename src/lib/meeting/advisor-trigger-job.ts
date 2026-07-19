import type { AdvisorTurnIntentDecision } from "./advisor-turn-intent.js";
import { createMeetingId } from "./context-manager.js";
import type {
  AdvisorPromptContext,
  AdvisorRequestMode,
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
