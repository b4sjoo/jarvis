import type { ActiveMeetingTask } from "./active-meeting-task.js";
import type {
  AdvisorPromptContext,
  InterviewSessionBrief,
} from "./types.js";

export type ResponseOnlyRelationDisposition =
  | "pending"
  | "ambiguous"
  | "timeout"
  | "invalid";

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
  now?: number;
  ttlMs?: number;
}): ResponseOnlyTaskScope {
  const now = input.now ?? Date.now();
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
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? 15_000),
  };
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
    advisorPromptSourceTurnIds: [...scope.sourceTurnIds],
    screenContext: "",
    interviewSessionBrief: sanitizeInterviewBriefForResponseOnly(
      context.interviewSessionBrief
    ),
    activeScreenTask: undefined,
    activeInterviewTask: undefined,
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
    responseOnlyExpiresAt: scope.expiresAt,
    responseOnlyParentContextInjected: false,
    responseOnlyParentMutationAllowed: false,
    responseOnlyPlaybookMutationAllowed: false,
    responseOnlyArtifactMutationAllowed: false,
  };
}

export function sanitizeInterviewBriefForResponseOnly(
  brief: InterviewSessionBrief | undefined
): InterviewSessionBrief | undefined {
  if (!brief) return undefined;
  return {
    ...brief,
    focusAreas: "",
    notes: "",
  };
}
