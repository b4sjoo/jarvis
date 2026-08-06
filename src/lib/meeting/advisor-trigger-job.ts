import type { AdvisorTurnIntentDecision } from "./advisor-turn-intent.js";
import type {
  RefreshAuthorityDecision,
  RuntimeTypeRepairOutputAuthority,
} from "./answer-generation-lease.js";
import { createMeetingId } from "./context-manager.js";
import {
  formatLogicalQuestionUnitForTrace,
  type LogicalQuestionUnit,
} from "./logical-question-unit.js";
import type { PlaybookPhaseDecision } from "./playbook-phase.js";
import {
  authorizeRuntimeCommit,
  createRuntimeCommitToken,
  type RuntimeCommitAuthorizationReason,
  type RuntimeCommitSnapshot,
  type RuntimeCommitToken,
} from "./runtime-commit-authorization.js";
import type {
  AdvisorGeneratedContinuityCapsule,
  AdvisorPromptContext,
  AdvisorRequestMode,
  InterviewPlaybookPhase,
  InterviewTaskRelation,
  QuestionInstanceLineage,
} from "./types.js";

export type AdvisorJobSource =
  | "live-turn"
  | "regenerate"
  | "response-action"
  | "clarifying-answer"
  | "manual-correction"
  | "force-advise";

export type AdvisorTaskMutationAuthority =
  | "input-evidence"
  | "preserve-parent"
  | "runtime-intent-answer"
  | "runtime-type-repair"
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
  generatedContinuitySnapshot: AdvisorGeneratedContinuityCapsule[];
  turnIntentDecision?: AdvisorTurnIntentDecision;
  expectedSessionId: string;
  expectedParentId?: string;
  expectedParentRevision?: number;
  runtimeCommitToken: RuntimeCommitToken;
  questionLineage?: QuestionInstanceLineage;
  logicalQuestionUnit?: LogicalQuestionUnit;
  taskMutationAuthority: AdvisorTaskMutationAuthority;
  refreshAuthority: RefreshAuthorityDecision;
  runtimeTypeRepairOutputAuthority?: RuntimeTypeRepairOutputAuthority;
  manualCorrectionRevision: number;
  responseActionRevision: number;
  snapshotTurnCount: number;
  scheduledAt: number;
}

export interface CreateAdvisorTriggerJobInput {
  source: AdvisorJobSource;
  mode: AdvisorRequestMode;
  traceId?: string;
  triggerTurnId?: string;
  promptContext: AdvisorPromptContext;
  generatedContinuity?: AdvisorGeneratedContinuityCapsule[];
  turnIntentDecision?: AdvisorTurnIntentDecision;
  sessionId: string;
  runtimeEpoch: number;
  snapshotTurnCount: number;
  questionLineage?: QuestionInstanceLineage;
  logicalQuestionUnit?: LogicalQuestionUnit;
  taskMutationAuthority: AdvisorTaskMutationAuthority;
  refreshAuthority?: RefreshAuthorityDecision;
  runtimeTypeRepairOutputAuthority?: RuntimeTypeRepairOutputAuthority;
  manualCorrectionRevision?: number;
  responseActionRevision?: number;
  scheduledAt?: number;
}

export interface AdvisorJobCommitDecision {
  authorized: boolean;
  reason: RuntimeCommitAuthorizationReason;
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
    | "explicit-action-without-parent"
    | "turn-intent-mutation-suppressed";
}

export interface AdvisorTaskMutationAuthorization {
  authorized: boolean;
  reason:
    | "substantive-input-authority"
    | "manual-correction-authority"
    | "explicit-action-authority"
    | "runtime-intent-action-only"
    | "runtime-type-repair-output-only"
    | "missing-turn-intent-decision"
    | "turn-intent-would-suppress"
    | "turn-intent-not-answer-refresh";
}

export interface AdvisorOutputCommitAuthorization {
  authorized: boolean;
  reason:
    | "substantive-output-authority"
    | "runtime-intent-answer-output-authority"
    | "runtime-type-repair-output-authority"
    | "manual-action-output-authority"
    | "execution-not-authorized"
    | "turn-intent-not-answer-refresh";
}

export function createAdvisorTriggerJob(
  input: CreateAdvisorTriggerJobInput
): AdvisorTriggerJob {
  const snapshot = cloneAdvisorPromptContext(input.promptContext);
  const id = createMeetingId("advisor_job");
  const expectedParentId =
    snapshot.activeMeetingTask?.parent.id ?? snapshot.activeInterviewTask?.id;
  const expectedParentRevision =
    snapshot.activeMeetingTask?.parent.revisions ??
    snapshot.activeInterviewTask?.revisions;
  return {
    id,
    source: input.source,
    mode: input.mode,
    traceId: input.traceId,
    triggerTurnId: input.triggerTurnId,
    promptContextSnapshot: snapshot,
    generatedContinuitySnapshot: (input.generatedContinuity ?? []).map(
      (capsule) => ({ ...capsule })
    ),
    turnIntentDecision: input.turnIntentDecision
      ? { ...input.turnIntentDecision }
      : undefined,
    expectedSessionId: input.sessionId,
    expectedParentId,
    expectedParentRevision,
    runtimeCommitToken: createRuntimeCommitToken({
      operationId: id,
      pipeline: "advisor",
      snapshot: {
        runtimeEpoch: input.runtimeEpoch,
        sessionId: input.sessionId,
        parentId: expectedParentId,
        parentRevision: expectedParentRevision,
      },
    }),
    questionLineage: input.questionLineage
      ? { ...input.questionLineage }
      : undefined,
    logicalQuestionUnit: input.logicalQuestionUnit
      ? cloneLogicalQuestionUnit(input.logicalQuestionUnit)
      : undefined,
    taskMutationAuthority: input.taskMutationAuthority,
    refreshAuthority: input.refreshAuthority
      ? { ...input.refreshAuthority }
      : {
          authorized: true,
          kind:
            input.source === "live-turn"
              ? "automatic-substantive"
              : "manual-hard-override",
          reason:
            input.source === "live-turn"
              ? "substantive-turn"
              : input.source === "manual-correction"
                ? "manual-correction"
                : input.source === "force-advise"
                  ? "force-advise"
                : "explicit-response-action",
          hardOverride: input.source !== "live-turn",
          maySupersedeGeneration: true,
        },
    runtimeTypeRepairOutputAuthority:
      input.runtimeTypeRepairOutputAuthority
        ? {
            ...input.runtimeTypeRepairOutputAuthority,
            authorizedArtifacts: ["answer"],
          }
        : undefined,
    manualCorrectionRevision: input.manualCorrectionRevision ?? 0,
    responseActionRevision: input.responseActionRevision ?? 0,
    snapshotTurnCount: input.snapshotTurnCount,
    scheduledAt: input.scheduledAt ?? Date.now(),
  };
}

export function decideAdvisorJobCommit(input: {
  job: AdvisorTriggerJob;
  activeJobId?: string;
  currentRuntime: RuntimeCommitSnapshot;
}): AdvisorJobCommitDecision {
  const decision = authorizeRuntimeCommit({
    token: input.job.runtimeCommitToken,
    current: input.currentRuntime,
    currentOperationId: input.activeJobId,
  });
  return { authorized: decision.authorized, reason: decision.reason };
}

export function decideAdvisorTaskMutation(input: {
  authority: AdvisorTaskMutationAuthority;
  resolvedRelation: InterviewTaskRelation;
  hasActiveParent: boolean;
  hasActiveChild: boolean;
  mutationAuthorized?: boolean;
}): AdvisorTaskMutationDecision {
  if (input.mutationAuthorized === false) {
    return {
      relation: "unknown",
      commitParent: false,
      preserveParentType: true,
      allowExplicitRetype: false,
      reason: "turn-intent-mutation-suppressed",
    };
  }

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

export function authorizeAdvisorTaskMutation(input: {
  authority: AdvisorTaskMutationAuthority;
  turnIntentDecision?: AdvisorTurnIntentDecision;
}): AdvisorTaskMutationAuthorization {
  if (input.authority === "manual-correction") {
    return { authorized: true, reason: "manual-correction-authority" };
  }
  if (input.authority === "preserve-parent") {
    return { authorized: true, reason: "explicit-action-authority" };
  }
  if (input.authority === "runtime-intent-answer") {
    return { authorized: false, reason: "runtime-intent-action-only" };
  }
  if (input.authority === "runtime-type-repair") {
    return {
      authorized: false,
      reason: "runtime-type-repair-output-only",
    };
  }

  const decision = input.turnIntentDecision;
  if (!decision) {
    return { authorized: false, reason: "missing-turn-intent-decision" };
  }
  if (decision.wouldSuppress) {
    return { authorized: false, reason: "turn-intent-would-suppress" };
  }
  if (
    !decision.executionAuthorized ||
    decision.action !== "answer-refresh"
  ) {
    return { authorized: false, reason: "turn-intent-not-answer-refresh" };
  }

  return { authorized: true, reason: "substantive-input-authority" };
}

export function authorizeAdvisorOutputCommit(input: {
  authority: AdvisorTaskMutationAuthority;
  executionAuthorized: boolean;
  turnIntentDecision?: AdvisorTurnIntentDecision;
}): AdvisorOutputCommitAuthorization {
  if (!input.executionAuthorized) {
    return { authorized: false, reason: "execution-not-authorized" };
  }
  if (
    input.authority === "manual-correction" ||
    input.authority === "preserve-parent"
  ) {
    return { authorized: true, reason: "manual-action-output-authority" };
  }
  if (input.authority === "runtime-intent-answer") {
    return input.turnIntentDecision?.authoritySource ===
        "runtime-intent-gate" &&
      input.turnIntentDecision.action === "answer-refresh"
      ? {
          authorized: true,
          reason: "runtime-intent-answer-output-authority",
        }
      : {
          authorized: false,
          reason: "turn-intent-not-answer-refresh",
        };
  }
  if (input.authority === "runtime-type-repair") {
    return {
      authorized: true,
      reason: "runtime-type-repair-output-authority",
    };
  }

  const decision = input.turnIntentDecision;
  if (decision?.action !== "answer-refresh") {
    return { authorized: false, reason: "turn-intent-not-answer-refresh" };
  }
  if (decision.enforcement === "shadow") {
    return {
      authorized: false,
      reason: "execution-not-authorized",
    };
  }

  return { authorized: true, reason: "substantive-output-authority" };
}

export function decideAdvisorPhaseMutation(input: {
  authority: AdvisorTaskMutationAuthority;
  taskMutationAuthorized?: boolean;
  manualPhaseAdvance: boolean;
  currentPhase: InterviewPlaybookPhase;
  hasActiveChild: boolean;
  automaticDecision: PlaybookPhaseDecision;
  manualDecision: PlaybookPhaseDecision;
}): PlaybookPhaseDecision {
  if (input.manualPhaseAdvance) return input.manualDecision;
  if (input.taskMutationAuthorized === false) {
    return {
      phase: input.currentPhase,
      flags: [],
      requiredArtifacts: [...input.automaticDecision.requiredArtifacts],
      action: input.hasActiveChild ? "resume-parent" : "stay",
      reason: "turn-intent-mutation-suppressed",
      source: "automatic",
      targetArtifact: "answer",
      guardStatus: "automatic",
      phaseFrom: input.currentPhase,
    };
  }
  if (input.authority !== "preserve-parent") {
    return input.automaticDecision;
  }

  return {
    phase: input.currentPhase,
    flags: [],
    requiredArtifacts: [...input.automaticDecision.requiredArtifacts],
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
    advisorJobExpectedRuntimeEpoch: job.runtimeCommitToken.runtimeEpoch,
    advisorJobExpectedParentId: job.expectedParentId,
    advisorJobExpectedParentRevision: job.expectedParentRevision,
    ...(job.questionLineage
      ? {
          questionInstanceId: job.questionLineage.questionInstanceId,
          questionOriginTraceId: job.questionLineage.questionOriginTraceId,
          sourceSuggestionId: job.questionLineage.sourceSuggestionId,
        }
      : {}),
    ...formatLogicalQuestionUnitForTrace(job.logicalQuestionUnit),
    advisorJobMutationAuthority: job.taskMutationAuthority,
    refreshAuthority: job.refreshAuthority.kind,
    refreshAuthorityAuthorized: job.refreshAuthority.authorized,
    refreshAuthorityReason: job.refreshAuthority.reason,
    refreshAuthorityHardOverride: job.refreshAuthority.hardOverride,
    ...(job.refreshAuthority.authorityId
      ? { refreshAuthorityId: job.refreshAuthority.authorityId }
      : {}),
    advisorJobManualCorrectionRevision: job.manualCorrectionRevision,
    advisorJobResponseActionRevision: job.responseActionRevision,
    advisorJobSnapshotTurnCount: job.snapshotTurnCount,
    advisorJobSnapshotLatestTurnId: job.promptContextSnapshot.latestTurn?.id,
    advisorJobGeneratedContinuityCandidateCount:
      job.generatedContinuitySnapshot.length,
    advisorJobGeneratedContinuityCandidateChars:
      job.generatedContinuitySnapshot.reduce(
        (total, capsule) => total + capsule.text.length,
        0
      ),
    advisorJobOutcome: outcome,
    advisorJobCancellationReason: extra.cancellationReason,
    advisorJobCommitAuthorized: extra.commitAuthorized,
    advisorJobCommitAuthorizationReason: extra.commitAuthorizationReason,
  };
}

function cloneLogicalQuestionUnit(unit: LogicalQuestionUnit) {
  return {
    ...unit,
    sourceTurnIds: [...unit.sourceTurnIds],
    sources: unit.sources.map((source) => ({ ...source })),
    compositionReasons: [...unit.compositionReasons],
    primaryAskProjection: unit.primaryAskProjection
      ? {
          ...unit.primaryAskProjection,
          sourceTurnIds: [...unit.primaryAskProjection.sourceTurnIds],
          primaryAskSpans: unit.primaryAskProjection.primaryAskSpans.map(
            (span) => ({ ...span })
          ),
          answerFocusSpans:
            unit.primaryAskProjection.answerFocusSpans.map((span) => ({
              ...span,
            })),
          objectSpans: unit.primaryAskProjection.objectSpans.map((span) => ({
            ...span,
          })),
          scenarioSpans:
            unit.primaryAskProjection.scenarioSpans.map((span) => ({
              ...span,
            })),
          semanticEvidenceRetentionReasons: [
            ...unit.primaryAskProjection
              .semanticEvidenceRetentionReasons,
          ],
          semanticEvidenceDroppedReasons: [
            ...unit.primaryAskProjection
              .semanticEvidenceDroppedReasons,
          ],
          setupSpans: unit.primaryAskProjection.setupSpans.map((span) => ({
            ...span,
          })),
          quotedOrFutureExampleSpans:
            unit.primaryAskProjection.quotedOrFutureExampleSpans.map(
              (span) => ({ ...span })
            ),
        }
      : undefined,
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
