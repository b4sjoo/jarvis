import type { MemoryUseCase } from "@/lib/memory/types";
import type { AnswerArtifactSection } from "./answer-generation-lease.js";
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
import type {
  AdvisorContextReadScope,
  ResponseOnlyTaskScope,
} from "./response-only-task-scope.js";
import {
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import { resolvePlaybookRequiredArtifacts } from "./playbook-phase.js";
import type {
  InterviewPlaybookPhase,
  InterviewSubtaskIntent,
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

export type SettledAdvisorResponseIntent =
  | "advise"
  | "suppress"
  | "hold"
  | "clarify";

export type SettledAdvisorArtifactIntent =
  | "none"
  | "preserve"
  | "revise-code"
  | "revise-complexity"
  | "revise-whiteboard";

export type TaskLifecycleCommand =
  | { kind: "preserve" }
  | {
      kind: "create-parent";
      type: CanonicalQuestionType;
      topic: string;
    }
  | {
      kind: "replace-parent";
      type: CanonicalQuestionType;
      topic: string;
    }
  | {
      kind: "attach-child";
      type: CanonicalQuestionType;
      question: string;
    }
  | { kind: "resume-parent" }
  | { kind: "advance-phase"; phase: InterviewPlaybookPhase }
  | { kind: "update-parent-context" };

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
  responseIntent: SettledAdvisorResponseIntent;
  contextReadScope: AdvisorContextReadScope;
  artifactIntent: SettledAdvisorArtifactIntent;
  taskMutationPolicy: TaskLifecycleCommand;
  taskSnapshot?: ActiveMeetingTask;
  expectedParentId?: string;
  expectedParentRevision?: number;
  postMutationParentId?: string;
  postMutationParentRevision?: number;
  responseOwner: MeetingResponseOwnerResolution;
  modelRoute: MeetingModelRouteResolution;
  playbook?: SelectedInterviewPlaybook;
  playbookId?: SelectedInterviewPlaybook["id"];
  playbookPhase?: InterviewPlaybookPhase;
  requiredArtifacts: AnswerArtifactSection[];
  memoryPolicy: SettledAdvisorMemoryPolicy;
  factAnchorPolicy: SettledAdvisorFactAnchorPolicy;
  promptContract: SettledAdvisorPromptContract;
  artifactPolicy: ResponseArtifactMutationAuthorization;
  responseOnlyTaskScope?: ResponseOnlyTaskScope;
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
  | "expected-parent-revision-mismatch"
  | "post-mutation-parent-mismatch"
  | "post-mutation-parent-revision-mismatch";

export type SettledAdvisorExecutionPlanAuthorizationStage =
  | "pre-task-mutation"
  | "model-commit";

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
  responseOnlyTaskScope?: ResponseOnlyTaskScope;
  transientPersonalStatusDecision?: TransientPersonalStatusDecision;
  sourceQuestion?: string;
  subtaskIntent?: InterviewSubtaskIntent;
  explicitTaskMutationCommand?: TaskLifecycleCommand;
  expectedActiveMeetingTask?: ActiveMeetingTask;
  createdAt?: number;
}): SettledAdvisorExecutionPlan {
  const relation = toInterviewTaskRelation(input.settlement.relation);
  const responseOnlyTaskScope = input.responseOnlyTaskScope
    ? cloneResponseOnlyTaskScope(input.responseOnlyTaskScope)
    : undefined;
  const taskSnapshot =
    !responseOnlyTaskScope && input.activeMeetingTask
    ? cloneActiveMeetingTask(input.activeMeetingTask)
    : undefined;
  const playbook = input.playbook
    ? cloneSelectedPlaybook(input.playbook)
    : undefined;
  const transientPersonalStatusDecision =
    input.transientPersonalStatusDecision
      ? cloneTransientPersonalStatusDecision(
          input.transientPersonalStatusDecision
        )
      : undefined;
  const playbookPhase = transientPersonalStatusDecision
    ? taskSnapshot?.parent.playbookPhase
    : playbook?.phase ?? taskSnapshot?.parent.playbookPhase;
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
          postBoundaryParentType: responseOnlyTaskScope
            ? undefined
            : taskSnapshot?.parent.questionType,
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
  const requiredArtifacts = resolvePlaybookRequiredArtifacts({
    questionType: responseOwner.questionType,
    playbookId: playbook?.id,
    phase: playbookPhase,
    subtaskIntent: input.subtaskIntent,
  });
  const artifactPolicy = authorizeResponseArtifactMutation({
    parentTaskId: responseOnlyTaskScope
      ? undefined
      : taskSnapshot?.parent.id,
    parentQuestionType: responseOnlyTaskScope
      ? undefined
      : taskSnapshot?.parent.questionType,
    responseOwnerQuestionType: responseOwner.questionType,
    responseOwnerSource: responseOwner.source,
    relation,
    subtaskIntent: input.subtaskIntent,
    requiredArtifacts,
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
  const responseIntent = resolveResponseIntent(input.settlement);
  const contextReadScope = resolveContextReadScope({
    responseOnlyTaskScope,
    transientPersonalStatusDecision,
    taskSnapshot,
    relation,
  });
  const artifactIntent = resolveArtifactIntent({
    responseAuthorized: input.settlement.responseAuthorized,
    responseOnlyTaskScope,
    transientPersonalStatusDecision,
    artifactPolicy,
  });
  const taskMutationPolicy = resolveTaskMutationPolicy({
    settlement: input.settlement,
    relation,
    taskBoundaryCommitted: input.taskBoundaryCommitted,
    responseOnlyTaskScope,
    transientPersonalStatusDecision,
    sourceQuestion: input.sourceQuestion,
    explicitCommand: input.explicitTaskMutationCommand,
  });
  const expectedParentId =
    input.expectedActiveMeetingTask?.parent.id ??
    input.activeMeetingTask?.parent.id ??
    responseOnlyTaskScope?.preservedParentId;
  const expectedParentRevision =
    input.expectedActiveMeetingTask?.parent.revisions ??
    input.activeMeetingTask?.parent.revisions ??
    responseOnlyTaskScope?.preservedParentRevision;
  const postMutationParentId = taskSnapshot?.parent.id;
  const postMutationParentRevision = taskSnapshot?.parent.revisions;
  const planId = createExecutionPlanId({
    settlementId: input.settlement.settlementId,
    responseOwner,
    modelRoute,
    playbook,
    expectedParentId,
    expectedParentRevision,
    postMutationParentId,
    postMutationParentRevision,
    memoryUseCase: input.memoryUseCase,
    askFrame: input.askFrame,
    topicDomain: input.topicDomain,
    projectAnchor: input.projectAnchor,
    artifactDisposition: artifactPolicy.disposition,
    requiredArtifacts,
    responseIntent,
    contextReadScope,
    artifactIntent,
    taskMutationKind: taskMutationPolicy.kind,
    responseOnlyTaskScopeId: responseOnlyTaskScope?.scopeId,
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
    responseIntent,
    contextReadScope,
    artifactIntent,
    taskMutationPolicy,
    taskSnapshot,
    expectedParentId,
    expectedParentRevision,
    postMutationParentId,
    postMutationParentRevision,
    responseOwner,
    modelRoute,
    playbook: transientPersonalStatusDecision
      ? undefined
      : playbook,
    playbookId: transientPersonalStatusDecision
      ? undefined
      : playbook?.id,
    playbookPhase,
    requiredArtifacts,
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
    responseOnlyTaskScope,
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
  stage?: SettledAdvisorExecutionPlanAuthorizationStage;
}): SettledAdvisorExecutionPlanAuthorization {
  const rejectionReasons: SettledAdvisorExecutionPlanRejectionReason[] = [];
  const stage = input.stage ?? "model-commit";
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
  const postMutationLeaseApplies =
    stage === "model-commit" &&
    input.plan.taskMutationPolicy.kind !== "preserve" &&
    input.plan.postMutationParentId !== undefined &&
    (input.plan.postMutationParentId !==
      input.plan.expectedParentId ||
      input.plan.postMutationParentRevision !==
        input.plan.expectedParentRevision);
  if (postMutationLeaseApplies) {
    if (
      input.plan.postMutationParentId !==
      input.currentActiveMeetingTask?.parent.id
    ) {
      rejectionReasons.push("post-mutation-parent-mismatch");
    }
    if (
      input.plan.postMutationParentRevision !== undefined &&
      input.plan.postMutationParentRevision !==
        input.currentActiveMeetingTask?.parent.revisions
    ) {
      rejectionReasons.push(
        "post-mutation-parent-revision-mismatch"
      );
    }
  } else {
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
    settledExecutionPlanResponseIntent:
      plan.responseIntent,
    settledExecutionPlanContextReadScope:
      plan.contextReadScope,
    settledExecutionPlanArtifactIntent:
      plan.artifactIntent,
    settledExecutionPlanTaskMutationCommand:
      plan.taskMutationPolicy.kind,
    settledExecutionPlanExpectedParentId: plan.expectedParentId,
    settledExecutionPlanExpectedParentRevision:
      plan.expectedParentRevision,
    settledExecutionPlanPostMutationParentId:
      plan.postMutationParentId,
    settledExecutionPlanPostMutationParentRevision:
      plan.postMutationParentRevision,
    settledExecutionPlanResponseOwnerSource:
      plan.responseOwner.source,
    settledExecutionPlanModelRoute: plan.modelRoute.route,
    settledExecutionPlanProviderId:
      plan.modelRoute.resolvedProviderId,
    settledExecutionPlanPlaybookId: plan.playbookId,
    settledExecutionPlanPlaybookPhase: plan.playbookPhase,
    settledExecutionPlanRequiredArtifacts: plan.requiredArtifacts,
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
    settledExecutionPlanResponseOnlyScopeId:
      plan.responseOnlyTaskScope?.scopeId,
    settledExecutionPlanResponseOnlyDisposition:
      plan.responseOnlyTaskScope?.relationDisposition,
    settledExecutionPlanResponseOnlyPreservedParentId:
      plan.responseOnlyTaskScope?.preservedParentId,
    settledExecutionPlanResponseOnlyParentContextInjected:
      plan.responseOnlyTaskScope
        ? plan.contextReadScope === "active-parent-read" ||
          plan.contextReadScope === "active-child-read"
        : undefined,
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

function resolveResponseIntent(
  settlement: CurrentQuestionSettlementDecision
): SettledAdvisorResponseIntent {
  if (settlement.responseAuthorized && settlement.action === "answer") {
    return "advise";
  }
  if (settlement.action === "buffer") return "hold";
  return "suppress";
}

function resolveContextReadScope(input: {
  responseOnlyTaskScope?: ResponseOnlyTaskScope;
  transientPersonalStatusDecision?: TransientPersonalStatusDecision;
  taskSnapshot?: ActiveMeetingTask;
  relation: InterviewTaskRelation;
}): AdvisorContextReadScope {
  if (input.transientPersonalStatusDecision) return "current-only";
  if (input.responseOnlyTaskScope) {
    return input.responseOnlyTaskScope.contextReadScope;
  }
  if (input.relation === "child-probe" && input.taskSnapshot?.child) {
    return "active-child-read";
  }
  if (input.taskSnapshot) return "active-parent-read";
  return "current-only";
}

function resolveArtifactIntent(input: {
  responseAuthorized: boolean;
  responseOnlyTaskScope?: ResponseOnlyTaskScope;
  transientPersonalStatusDecision?: TransientPersonalStatusDecision;
  artifactPolicy: ResponseArtifactMutationAuthorization;
}): SettledAdvisorArtifactIntent {
  if (!input.responseAuthorized) return "none";
  if (
    input.responseOnlyTaskScope ||
    input.transientPersonalStatusDecision
  ) {
    return input.responseOnlyTaskScope?.preservedParentId
      ? "preserve"
      : "none";
  }
  if (input.artifactPolicy.allowCode) return "revise-code";
  if (input.artifactPolicy.allowComplexity) return "revise-complexity";
  if (input.artifactPolicy.allowWhiteboard) return "revise-whiteboard";
  return input.artifactPolicy.allowLatestUsefulAnswer
    ? "preserve"
    : "none";
}

function resolveTaskMutationPolicy(input: {
  settlement: CurrentQuestionSettlementDecision;
  relation: InterviewTaskRelation;
  taskBoundaryCommitted: boolean;
  responseOnlyTaskScope?: ResponseOnlyTaskScope;
  transientPersonalStatusDecision?: TransientPersonalStatusDecision;
  sourceQuestion?: string;
  explicitCommand?: TaskLifecycleCommand;
}): TaskLifecycleCommand {
  if (
    input.responseOnlyTaskScope ||
    input.transientPersonalStatusDecision
  ) {
    return { kind: "preserve" };
  }
  if (input.explicitCommand) return input.explicitCommand;
  if (
    input.taskBoundaryCommitted &&
    input.settlement.parentMutationAuthorized
  ) {
    return {
      kind: "create-parent",
      type: input.settlement.questionType,
      topic: input.sourceQuestion?.trim() || "Unknown interview task",
    };
  }
  if (
    input.relation === "child-probe" &&
    input.settlement.relationMutationAuthorized
  ) {
    return {
      kind: "attach-child",
      type: input.settlement.questionType,
      question: input.sourceQuestion?.trim() || "Unknown child question",
    };
  }
  if (
    input.relation === "resume-parent" &&
    input.settlement.relationMutationAuthorized
  ) {
    return { kind: "resume-parent" };
  }
  if (
    (input.relation === "followup-parent" ||
      input.relation === "correction") &&
    input.settlement.relationMutationAuthorized
  ) {
    return { kind: "update-parent-context" };
  }
  return { kind: "preserve" };
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

function cloneResponseOnlyTaskScope(scope: ResponseOnlyTaskScope) {
  return deepFreeze(
    JSON.parse(JSON.stringify(scope)) as ResponseOnlyTaskScope
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
  postMutationParentId?: string;
  postMutationParentRevision?: number;
  memoryUseCase: MemoryUseCase;
  askFrame: TaskAskFrame;
  topicDomain: TaskTopicDomain;
  projectAnchor?: string;
  artifactDisposition: string;
  requiredArtifacts: AnswerArtifactSection[];
  responseIntent: SettledAdvisorResponseIntent;
  contextReadScope: AdvisorContextReadScope;
  artifactIntent: SettledAdvisorArtifactIntent;
  taskMutationKind: TaskLifecycleCommand["kind"];
  responseOnlyTaskScopeId?: string;
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
      input.postMutationParentId ?? "",
      input.postMutationParentRevision ?? "",
      input.memoryUseCase,
      input.askFrame,
      input.topicDomain,
      input.projectAnchor ?? "",
      input.artifactDisposition,
      input.requiredArtifacts.join(","),
      input.responseIntent,
      input.contextReadScope,
      input.artifactIntent,
      input.taskMutationKind,
      input.responseOnlyTaskScopeId ?? "",
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
