import type { ActiveMeetingTask } from "./active-meeting-task.js";
import type {
  AdvisorBoundedParentReadContext,
  AdvisorPromptContext,
  InterviewPlaybookPhase,
  InterviewTaskRelation,
} from "./types.js";
import { areCompatibleParentContinuityTypes } from "./task-taxonomy.js";

export type ResponseOnlyRelationDisposition =
  | "pending"
  | "ambiguous"
  | "timeout"
  | "invalid";

export type AdvisorContextReadScope =
  | "current-only"
  | "active-parent-read"
  | "active-child-read"
  | "bounded-recent-history";

export interface ResponseOnlyParentContinuity {
  parentId: string;
  parentRevision: number;
  questionType: string;
  playbookPhase: InterviewPlaybookPhase;
  artifactOwnerParentId: string;
  whiteboardArtifactId?: string;
  whiteboardArtifactRevision?: number;
  compatibleWithInferredType: boolean;
}

export interface ResponseOnlyTaskScope {
  scopeId: string;
  logicalQuestionUnitId: string;
  revision: number;
  sourceQuestion: string;
  sourceTurnIds: string[];
  inferredType: string;
  relationDisposition: ResponseOnlyRelationDisposition;
  preservedParentId?: string;
  preservedParentRevision?: number;
  readOnlyParentContinuity?: ResponseOnlyParentContinuity;
  contextReadScope: AdvisorContextReadScope;
  parentReadContext?: AdvisorBoundedParentReadContext;
  artifactMutation: "none";
  taskMutation: "none";
  createdAt: number;
  expiresAt: number;
}

export function createResponseOnlyTaskScope(input: {
  logicalQuestionUnitId: string;
  revision: number;
  sourceQuestion: string;
  sourceTurnIds?: string[];
  inferredType: string;
  relationDisposition: ResponseOnlyRelationDisposition;
  preservedParent?: ActiveMeetingTask;
  contextReadScope?: AdvisorContextReadScope;
  now?: number;
  ttlMs?: number;
}): ResponseOnlyTaskScope {
  const now = input.now ?? Date.now();
  const contextReadScope =
    input.contextReadScope ?? "current-only";
  return {
    scopeId: [
      "response_only",
      input.logicalQuestionUnitId,
      input.revision,
      now,
    ].join("_"),
    logicalQuestionUnitId: input.logicalQuestionUnitId,
    revision: input.revision,
    sourceQuestion: input.sourceQuestion.trim(),
    sourceTurnIds: Array.from(new Set(input.sourceTurnIds ?? [])),
    inferredType: input.inferredType,
    relationDisposition: input.relationDisposition,
    preservedParentId: input.preservedParent?.parent.id,
    preservedParentRevision:
      input.preservedParent?.parent.revisions,
    readOnlyParentContinuity: buildReadOnlyParentContinuity({
      task: input.preservedParent,
      inferredType: input.inferredType,
    }),
    contextReadScope,
    parentReadContext: buildBoundedParentReadContext(
      input.preservedParent,
      contextReadScope
    ),
    artifactMutation: "none",
    taskMutation: "none",
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? 15_000),
  };
}

export function resolveResponseOnlyContextReadScope(input: {
  preservedParent?: ActiveMeetingTask;
  proposedRelation?: InterviewTaskRelation;
}): AdvisorContextReadScope {
  if (!input.preservedParent) return "current-only";
  if (
    input.preservedParent.child &&
    (input.proposedRelation === undefined ||
      input.proposedRelation === "unknown" ||
      input.proposedRelation === "child-probe")
  ) {
    return "active-child-read";
  }
  if (
    input.proposedRelation === undefined ||
    input.proposedRelation === "unknown" ||
    input.proposedRelation === "followup-parent" ||
    input.proposedRelation === "child-probe" ||
    input.proposedRelation === "resume-parent"
  ) {
    return "active-parent-read";
  }
  return "current-only";
}

export function applyResponseOnlyTaskScopeToPromptContext(
  context: AdvisorPromptContext,
  scope: ResponseOnlyTaskScope
): AdvisorPromptContext {
  return {
    ...context,
    transcript: scope.sourceQuestion
      ? `Them: ${scope.sourceQuestion}`
      : "",
    advisorPromptSourceTurnIds: uniqueStrings([
      ...(scope.parentReadContext?.sourceTurnIds ?? []),
      ...scope.sourceTurnIds,
    ]),
    screenContext: "",
    responseOnlyParentReadContext: scope.parentReadContext
      ? cloneParentReadContext(scope.parentReadContext)
      : undefined,
    interviewSessionBrief: context.interviewSessionBrief,
    taskRuntime: {
      revision: context.taskRuntime.revision,
      lastMutation: context.taskRuntime.lastMutation,
    },
    activeMeetingTask: undefined,
    rollingSummary: "",
    userProfileContext: "",
    memoryContext: undefined,
    interviewPlaybook: undefined,
    playbookPhaseDecision: undefined,
    factAnchorDecision: undefined,
    projectBindingDecision: undefined,
    openingRoute: undefined,
    confirmedMeFacts: undefined,
    responseActionContextScope: undefined,
    advisorEvidencePacket: undefined,
  };
}

export function formatResponseOnlyTaskScopeForTrace(
  scope: ResponseOnlyTaskScope | undefined
): Record<string, unknown> {
  if (!scope) return {};
  return {
    responseOnlyTaskScopeId: scope.scopeId,
    responseOnlyLogicalQuestionUnitId:
      scope.logicalQuestionUnitId,
    responseOnlyLogicalQuestionRevision: scope.revision,
    responseOnlySourceTurnIds: scope.sourceTurnIds,
    responseOnlyInferredType: scope.inferredType,
    responseOnlyRelationDisposition:
      scope.relationDisposition,
    responseOnlyPreservedParentId: scope.preservedParentId,
    responseOnlyPreservedParentRevision:
      scope.preservedParentRevision,
    responseOnlyReadOnlyParentType:
      scope.readOnlyParentContinuity?.questionType,
    responseOnlyReadOnlyParentPhase:
      scope.readOnlyParentContinuity?.playbookPhase,
    responseOnlyReadOnlyParentCompatible:
      scope.readOnlyParentContinuity?.compatibleWithInferredType,
    responseOnlyReadOnlyArtifactOwnerId:
      scope.readOnlyParentContinuity?.artifactOwnerParentId,
    responseOnlyReadOnlyWhiteboardArtifactId:
      scope.readOnlyParentContinuity?.whiteboardArtifactId,
    responseOnlyReadOnlyWhiteboardArtifactRevision:
      scope.readOnlyParentContinuity?.whiteboardArtifactRevision,
    responseOnlyContextReadScope: scope.contextReadScope,
    responseOnlyParentReadContextPresent:
      Boolean(scope.parentReadContext),
    responseOnlyParentReadSourceTurnIds:
      scope.parentReadContext?.sourceTurnIds,
    responseOnlyParentReadConstraintCount:
      scope.parentReadContext?.acceptedConstraints.length,
    responseOnlyParentReadEntityCount:
      scope.parentReadContext?.sharedScenarioEntities.length,
    responseOnlyGeneratedContextExcluded: true,
    responseOnlyArtifactMutation: scope.artifactMutation,
    responseOnlyTaskMutation: scope.taskMutation,
    responseOnlyExpiresAt: scope.expiresAt,
    responseOnlyParentContextInjected:
      scope.contextReadScope === "active-parent-read" ||
      scope.contextReadScope === "active-child-read" ||
      scope.contextReadScope === "bounded-recent-history",
    responseOnlyParentMutationAllowed: false,
    responseOnlyPlaybookMutationAllowed: false,
    responseOnlyArtifactMutationAllowed: false,
  };
}

export function formatBoundedParentReadContextForPrompt(
  context: AdvisorBoundedParentReadContext | undefined
) {
  if (!context) return "No parent context is authorized for this response.";
  return [
    `Parent id: ${context.parentId}`,
    `Parent revision: ${context.parentRevision}`,
    `Parent question type: ${context.questionType}`,
    `Source-owned objective: ${context.objective}`,
    context.acceptedConstraints.length
      ? `Accepted constraints: ${context.acceptedConstraints.join("; ")}`
      : undefined,
    context.sharedScenarioEntities.length
      ? `Shared scenario entities: ${context.sharedScenarioEntities.join(", ")}`
      : undefined,
    `Excluded context: ${context.excludedContextKinds.join(", ")}`,
    "Use this capsule only to interpret the current question. It does not establish a settled task relation and grants no task, phase, memory, or artifact mutation authority.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildBoundedParentReadContext(
  task: ActiveMeetingTask | undefined,
  contextReadScope: AdvisorContextReadScope
): AdvisorBoundedParentReadContext | undefined {
  if (
    !task ||
    (contextReadScope !== "active-parent-read" &&
      contextReadScope !== "active-child-read" &&
      contextReadScope !== "bounded-recent-history")
  ) {
    return undefined;
  }
  const handoff = task.parent.parentContextHandoff?.sharedScenarioContext;
  const acceptedConstraints = uniqueStrings([
    ...(handoff?.sharedRequirements ?? []),
    ...(handoff?.applicableScaleAssumptions?.map(
      (item) => item.value
    ) ?? []),
  ])
    .map((value) => boundText(value, 220))
    .filter(Boolean)
    .slice(0, 6);
  const sourceTurnIds = uniqueStrings([
    ...(task.parent.canonicalQuestionSourceTurnIds ?? []),
    task.parent.startTurnId,
    task.parent.promptTranscriptStartTurnId,
    ...(handoff?.applicableScaleAssumptions?.map(
      (item) => item.sourceTurnId
    ) ?? []),
  ]).slice(0, 12);

  return {
    parentId: task.parent.id,
    parentRevision: task.parent.revisions ?? 0,
    questionType: task.parent.questionType,
    objective: boundText(task.parent.topic, 320),
    sourceTurnIds,
    acceptedConstraints,
    sharedScenarioEntities: uniqueStrings(
      handoff?.domainEntities ?? []
    )
      .map((value) => boundText(value, 80))
      .filter(Boolean)
      .slice(0, 8),
    excludedContextKinds: [
      "generated-answers",
      "playbook-phase",
      "memory-retrieval",
      "fact-anchors",
      "project-binding",
      "code-artifact",
      "whiteboard-artifact",
    ],
  };
}

function buildReadOnlyParentContinuity(input: {
  task: ActiveMeetingTask | undefined;
  inferredType: string;
}): ResponseOnlyParentContinuity | undefined {
  const parent = input.task?.parent;
  if (!parent) return undefined;

  return {
    parentId: parent.id,
    parentRevision: parent.revisions ?? 0,
    questionType: parent.questionType,
    playbookPhase: parent.playbookPhase,
    artifactOwnerParentId:
      parent.whiteboardArtifact?.parentTaskId ?? parent.id,
    whiteboardArtifactId: parent.whiteboardArtifact?.id,
    whiteboardArtifactRevision:
      parent.whiteboardArtifact?.revision,
    compatibleWithInferredType:
      areCompatibleParentContinuityTypes(
        parent.questionType,
        input.inferredType
      ),
  };
}

function cloneParentReadContext(
  context: AdvisorBoundedParentReadContext
): AdvisorBoundedParentReadContext {
  return {
    ...context,
    sourceTurnIds: [...context.sourceTurnIds],
    acceptedConstraints: [...context.acceptedConstraints],
    sharedScenarioEntities: [...context.sharedScenarioEntities],
    excludedContextKinds: [...context.excludedContextKinds],
  };
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
    )
  );
}

function boundText(value: string, maxChars: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
