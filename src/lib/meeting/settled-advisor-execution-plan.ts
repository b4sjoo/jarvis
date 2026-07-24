import type { MemoryUseCase } from "@/lib/memory/types";
import type { ActiveMeetingTask } from "./active-meeting-task.js";
import type {
  CurrentQuestionRelation,
  CurrentQuestionSettlementDecision,
} from "./current-question-settlement.js";
import {
  resolveMeetingAnswerProfile,
} from "./meeting-answer.js";
import {
  resolveMeetingModelRouteFromSnapshot,
  resolveMeetingResponseOwner,
  type MeetingModelProviderSnapshot,
  type MeetingModelRouteResolution,
  type MeetingResponseOwnerResolution,
} from "./meeting-model-route.js";
import {
  authorizeResponseArtifactMutation,
  type ResponseArtifactMutationAuthorization,
} from "./response-artifact-authorization.js";
import { normalizeCanonicalQuestionType } from "./task-taxonomy.js";
import type {
  InterviewPlaybookPhase,
  InterviewTaskRelation,
  MeetingAnswerProfile,
  PersonalEvidenceRequirement,
  SelectedInterviewPlaybook,
  TaskAskFrame,
  TaskTopicDomain,
  TransientPersonalStatusDecision,
} from "./types.js";

export interface SettledAdvisorMemoryPolicy {
  questionType: CurrentQuestionSettlementDecision["questionType"];
  useCase: MemoryUseCase;
  askFrame: TaskAskFrame;
  topicDomain: TaskTopicDomain;
  projectAnchor?: string;
  retrievalPolicyId?: string;
}

export interface SettledAdvisorFactAnchorPolicy {
  requirement: PersonalEvidenceRequirement;
  policyId:
    | "autobiographical-behavioral"
    | "autobiographical-project"
    | "personal-logistics"
    | "not-required";
}

export interface SettledAdvisorPromptContract {
  profile: MeetingAnswerProfile;
  contractId: `meeting-answer:${MeetingAnswerProfile}`;
}

export interface SettledAdvisorExecutionPlan {
  id: string;
  settlementId: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionRevision: number;
  sourceHash: string;
  questionType: CurrentQuestionSettlementDecision["questionType"];
  relation: CurrentQuestionRelation;
  taskRelation: InterviewTaskRelation;
  responseAuthorized: boolean;
  taskSnapshot?: ActiveMeetingTask;
  expectedParentId?: string;
  expectedParentRevision?: number;
  responseOwner: MeetingResponseOwnerResolution;
  modelRoute: MeetingModelRouteResolution;
  playbook?: SelectedInterviewPlaybook;
  playbookId?: SelectedInterviewPlaybook["id"];
  playbookPhase?: InterviewPlaybookPhase;
  memoryPolicy: SettledAdvisorMemoryPolicy;
  factAnchorPolicy: SettledAdvisorFactAnchorPolicy;
  promptContract: SettledAdvisorPromptContract;
  artifactPolicy: ResponseArtifactMutationAuthorization;
  transientPersonalStatusDecision?: TransientPersonalStatusDecision;
  createdAt: number;
}

export type SettledAdvisorExecutionPlanRejectionReason =
  | "session-mismatch"
  | "runtime-epoch-mismatch"
  | "logical-question-unit-mismatch"
  | "logical-question-revision-mismatch"
  | "source-hash-mismatch"
  | "settlement-mismatch"
  | "expected-parent-mismatch"
  | "expected-parent-revision-mismatch";

export interface SettledAdvisorExecutionPlanAuthorization {
  authorized: boolean;
  reason: "authorized" | SettledAdvisorExecutionPlanRejectionReason;
  rejectionReasons: SettledAdvisorExecutionPlanRejectionReason[];
}

export function buildSettledAdvisorExecutionPlan(input: {
  settlement: CurrentQuestionSettlementDecision;
  activeMeetingTask?: ActiveMeetingTask;
  preBoundaryQuestionType?: unknown;
  taskBoundaryCommitted: boolean;
  childOwnsResponse: boolean;
  providerSnapshot: MeetingModelProviderSnapshot;
  playbook?: SelectedInterviewPlaybook;
  memoryUseCase: MemoryUseCase;
  askFrame: TaskAskFrame;
  topicDomain: TaskTopicDomain;
  projectAnchor?: string;
  transientPersonalStatusDecision?: TransientPersonalStatusDecision;
  createdAt?: number;
}): SettledAdvisorExecutionPlan {
  const relation = toInterviewTaskRelation(input.settlement.relation);
  const taskSnapshot = input.activeMeetingTask
    ? cloneActiveMeetingTask(input.activeMeetingTask)
    : undefined;
  const transientPersonalStatusDecision =
    input.transientPersonalStatusDecision
      ? cloneTransientPersonalStatusDecision(
          input.transientPersonalStatusDecision
        )
      : undefined;
  const responseOwner: MeetingResponseOwnerResolution =
    transientPersonalStatusDecision
      ? {
          questionType: "unknown",
          source: "transient-personal-status",
          preBoundaryType:
            normalizeResponseOwnerType(input.preBoundaryQuestionType),
          committedType: normalizeResponseOwnerType(
            taskSnapshot?.parent.questionType
          ),
          relation: "logistics",
        }
      : resolveMeetingResponseOwner({
          preBoundaryType: input.preBoundaryQuestionType,
          postBoundaryParentType: taskSnapshot?.parent.questionType,
          proposedQuestionType: input.settlement.questionType,
          relation,
          taskBoundaryCommitted: input.taskBoundaryCommitted,
          childOwnsResponse: input.childOwnsResponse,
        });
  const useCodingModel = responseOwner.questionType === "coding";
  const modelRoute = resolveMeetingModelRouteFromSnapshot({
    snapshot: input.providerSnapshot,
    useCodingModel,
    reason: useCodingModel
      ? `settlement-${input.settlement.settlementId}-coding`
      : `settlement-${input.settlement.settlementId}-main`,
  });
  const promptProfile = transientPersonalStatusDecision
    ? "compact-spoken"
    : resolveMeetingAnswerProfile(responseOwner.questionType);
  const artifactPolicy = authorizeResponseArtifactMutation({
    parentTaskId: taskSnapshot?.parent.id,
    parentQuestionType: taskSnapshot?.parent.questionType,
    responseOwnerQuestionType: responseOwner.questionType,
    responseOwnerSource: responseOwner.source,
    relation,
    creatingParent:
      input.taskBoundaryCommitted &&
      input.settlement.parentMutationAuthorized,
  });
  const factAnchorPolicy = transientPersonalStatusDecision
    ? {
        requirement: "personal-logistics" as const,
        policyId: "personal-logistics" as const,
      }
    : resolveFactAnchorPolicy(responseOwner.questionType);
  const expectedParentId = taskSnapshot?.parent.id;
  const expectedParentRevision = taskSnapshot?.parent.revisions;
  const playbook = input.playbook
    ? cloneSelectedPlaybook(input.playbook)
    : undefined;
  const planId = createExecutionPlanId({
    settlementId: input.settlement.settlementId,
    responseOwner,
    modelRoute,
    playbook,
    expectedParentId,
    expectedParentRevision,
    memoryUseCase: input.memoryUseCase,
    askFrame: input.askFrame,
    topicDomain: input.topicDomain,
    projectAnchor: input.projectAnchor,
    artifactDisposition: artifactPolicy.disposition,
    transientPersonalStatusDecisionId:
      transientPersonalStatusDecision?.id,
  });

  return {
    id: planId,
    settlementId: input.settlement.settlementId,
    sessionId: input.settlement.sessionId,
    runtimeEpoch: input.settlement.runtimeEpoch,
    logicalQuestionUnitId:
      input.settlement.logicalQuestionUnitId,
    logicalQuestionRevision: input.settlement.revision,
    sourceHash: input.settlement.sourceHash,
    questionType: responseOwner.questionType,
    relation: input.settlement.relation,
    taskRelation: relation,
    responseAuthorized: input.settlement.responseAuthorized,
    taskSnapshot,
    expectedParentId,
    expectedParentRevision,
    responseOwner,
    modelRoute,
    playbook: transientPersonalStatusDecision
      ? undefined
      : playbook,
    playbookId: transientPersonalStatusDecision
      ? undefined
      : playbook?.id,
    playbookPhase: transientPersonalStatusDecision
      ? taskSnapshot?.parent.playbookPhase
      : playbook?.phase ?? taskSnapshot?.parent.playbookPhase,
    memoryPolicy: {
      questionType: responseOwner.questionType,
      useCase: transientPersonalStatusDecision
        ? "meeting_assistant"
        : input.memoryUseCase,
      askFrame: transientPersonalStatusDecision
        ? "unknown"
        : input.askFrame,
      topicDomain: transientPersonalStatusDecision
        ? "unknown"
        : input.topicDomain,
      projectAnchor: transientPersonalStatusDecision
        ? undefined
        : input.projectAnchor,
      retrievalPolicyId: transientPersonalStatusDecision
        ? "personal-status-profile-only"
        : playbook?.memoryPolicy.id,
    },
    factAnchorPolicy,
    promptContract: {
      profile: promptProfile,
      contractId: `meeting-answer:${promptProfile}`,
    },
    artifactPolicy,
    transientPersonalStatusDecision,
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function authorizeSettledAdvisorExecutionPlan(input: {
  plan: SettledAdvisorExecutionPlan;
  currentSettlement?: CurrentQuestionSettlementDecision;
  currentSessionId: string;
  currentRuntimeEpoch: number;
  currentLogicalQuestionUnitId?: string;
  currentLogicalQuestionRevision?: number;
  currentSourceHash?: string;
  currentActiveMeetingTask?: ActiveMeetingTask;
}): SettledAdvisorExecutionPlanAuthorization {
  const rejectionReasons: SettledAdvisorExecutionPlanRejectionReason[] = [];
  if (input.plan.sessionId !== input.currentSessionId) {
    rejectionReasons.push("session-mismatch");
  }
  if (input.plan.runtimeEpoch !== input.currentRuntimeEpoch) {
    rejectionReasons.push("runtime-epoch-mismatch");
  }
  if (
    input.plan.logicalQuestionUnitId !==
    input.currentLogicalQuestionUnitId
  ) {
    rejectionReasons.push("logical-question-unit-mismatch");
  }
  if (
    input.plan.logicalQuestionRevision !==
    input.currentLogicalQuestionRevision
  ) {
    rejectionReasons.push("logical-question-revision-mismatch");
  }
  if (
    input.plan.sourceHash !== input.currentSourceHash
  ) {
    rejectionReasons.push("source-hash-mismatch");
  }
  if (
    !input.currentSettlement ||
    input.plan.settlementId !==
      input.currentSettlement.settlementId
  ) {
    rejectionReasons.push("settlement-mismatch");
  }
  if (
    input.plan.expectedParentId !== undefined &&
    input.plan.expectedParentId !==
      input.currentActiveMeetingTask?.parent.id
  ) {
    rejectionReasons.push("expected-parent-mismatch");
  }
  if (
    input.plan.expectedParentRevision !== undefined &&
    input.plan.expectedParentRevision !==
      input.currentActiveMeetingTask?.parent.revisions
  ) {
    rejectionReasons.push("expected-parent-revision-mismatch");
  }

  return {
    authorized: rejectionReasons.length === 0,
    reason: rejectionReasons[0] ?? "authorized",
    rejectionReasons: Array.from(new Set(rejectionReasons)),
  };
}

export function formatSettledAdvisorExecutionPlanForTrace(
  plan: SettledAdvisorExecutionPlan | undefined,
  authorization?: SettledAdvisorExecutionPlanAuthorization
): Record<string, unknown> {
  if (!plan) return {};
  return {
    settledExecutionPlanId: plan.id,
    settledExecutionPlanSettlementId: plan.settlementId,
    settledExecutionPlanSessionId: plan.sessionId,
    settledExecutionPlanRuntimeEpoch: plan.runtimeEpoch,
    settledExecutionPlanLogicalQuestionUnitId:
      plan.logicalQuestionUnitId,
    settledExecutionPlanLogicalQuestionRevision:
      plan.logicalQuestionRevision,
    settledExecutionPlanSourceHash: plan.sourceHash,
    settledExecutionPlanQuestionType: plan.questionType,
    settledExecutionPlanRelation: plan.relation,
    settledExecutionPlanTaskRelation: plan.taskRelation,
    settledExecutionPlanResponseAuthorized:
      plan.responseAuthorized,
    settledExecutionPlanExpectedParentId: plan.expectedParentId,
    settledExecutionPlanExpectedParentRevision:
      plan.expectedParentRevision,
    settledExecutionPlanResponseOwnerSource:
      plan.responseOwner.source,
    settledExecutionPlanModelRoute: plan.modelRoute.route,
    settledExecutionPlanProviderId:
      plan.modelRoute.resolvedProviderId,
    settledExecutionPlanPlaybookId: plan.playbookId,
    settledExecutionPlanPlaybookPhase: plan.playbookPhase,
    settledExecutionPlanMemoryUseCase: plan.memoryPolicy.useCase,
    settledExecutionPlanMemoryQuestionType:
      plan.memoryPolicy.questionType,
    settledExecutionPlanMemoryPolicyId:
      plan.memoryPolicy.retrievalPolicyId,
    settledExecutionPlanFactAnchorPolicy:
      plan.factAnchorPolicy.policyId,
    settledExecutionPlanPromptContract:
      plan.promptContract.contractId,
    settledExecutionPlanArtifactDisposition:
      plan.artifactPolicy.disposition,
    settledExecutionPlanTransientPersonalStatusDecisionId:
      plan.transientPersonalStatusDecision?.id,
    settledExecutionPlanTransientPersonalStatusDomain:
      plan.transientPersonalStatusDecision?.domain,
    settledExecutionPlanTransientPersonalStatusDisposition:
      plan.transientPersonalStatusDecision?.disposition,
    settledExecutionPlanTransientPersonalStatusEvidencePolicy:
      plan.transientPersonalStatusDecision?.evidencePolicy,
    settledExecutionPlanAuthorized: authorization?.authorized,
    settledExecutionPlanAuthorizationReason:
      authorization?.reason,
    settledExecutionPlanRejectionReasons:
      authorization?.rejectionReasons,
  };
}

function resolveFactAnchorPolicy(
  questionType: CurrentQuestionSettlementDecision["questionType"]
): SettledAdvisorFactAnchorPolicy {
  if (questionType === "behavioral") {
    return {
      requirement: "autobiographical-behavioral",
      policyId: "autobiographical-behavioral",
    };
  }
  if (questionType === "project-deep-dive") {
    return {
      requirement: "autobiographical-project",
      policyId: "autobiographical-project",
    };
  }
  return {
    requirement: "not-required",
    policyId: "not-required",
  };
}

function toInterviewTaskRelation(
  relation: CurrentQuestionRelation
): InterviewTaskRelation {
  if (relation === "linked-parent-extension") return "new-parent";
  if (relation === "none") return "unknown";
  return relation;
}

function cloneActiveMeetingTask(task: ActiveMeetingTask) {
  return deepFreeze(
    JSON.parse(JSON.stringify(task)) as ActiveMeetingTask
  );
}

function cloneSelectedPlaybook(playbook: SelectedInterviewPlaybook) {
  return deepFreeze(
    JSON.parse(JSON.stringify(playbook)) as SelectedInterviewPlaybook
  );
}

function cloneTransientPersonalStatusDecision(
  decision: TransientPersonalStatusDecision
) {
  return deepFreeze(
    JSON.parse(
      JSON.stringify(decision)
    ) as TransientPersonalStatusDecision
  );
}

function normalizeResponseOwnerType(value: unknown) {
  return normalizeCanonicalQuestionType(value) ?? undefined;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

function createExecutionPlanId(input: {
  settlementId: string;
  responseOwner: MeetingResponseOwnerResolution;
  modelRoute: MeetingModelRouteResolution;
  playbook?: SelectedInterviewPlaybook;
  expectedParentId?: string;
  expectedParentRevision?: number;
  memoryUseCase: MemoryUseCase;
  askFrame: TaskAskFrame;
  topicDomain: TaskTopicDomain;
  projectAnchor?: string;
  artifactDisposition: string;
  transientPersonalStatusDecisionId?: string;
}) {
  return `advisor_plan_${hashStableText(
    [
      input.settlementId,
      input.responseOwner.questionType,
      input.responseOwner.source,
      input.modelRoute.route,
      input.modelRoute.resolvedProviderId ?? "",
      input.playbook?.id ?? "",
      input.playbook?.phase ?? "",
      input.expectedParentId ?? "",
      input.expectedParentRevision ?? "",
      input.memoryUseCase,
      input.askFrame,
      input.topicDomain,
      input.projectAnchor ?? "",
      input.artifactDisposition,
      input.transientPersonalStatusDecisionId ?? "",
    ].join("|")
  )}`;
}

function hashStableText(raw: string) {
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
