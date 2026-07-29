import type { MeetingResponseOwnerSource } from "./meeting-model-route.js";
import {
  areCompatibleParentContinuityTypes,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import type {
  InterviewSubtaskIntent,
  InterviewTaskRelation,
} from "./types.js";

export type ResponseArtifactMutationDisposition =
  | "parent-owner-authorized"
  | "coding-child-authorized"
  | "design-child-authorized"
  | "display-only-child"
  | "display-only-transient"
  | "rejected-incompatible-owner"
  | "rejected-missing-parent";

export interface ResponseArtifactMutationAuthorization {
  disposition: ResponseArtifactMutationDisposition;
  reason: string;
  parentQuestionType?: CanonicalQuestionType;
  responseOwnerQuestionType: CanonicalQuestionType;
  responseOwnerSource: MeetingResponseOwnerSource;
  allowLatestUsefulAnswer: boolean;
  allowWhiteboard: boolean;
  allowCode: boolean;
  allowComplexity: boolean;
  allowParentContextMutation: boolean;
}

export function authorizeResponseArtifactMutation(input: {
  parentTaskId?: string;
  parentQuestionType?: unknown;
  responseOwnerQuestionType?: unknown;
  responseOwnerSource: MeetingResponseOwnerSource;
  relation: InterviewTaskRelation;
  subtaskIntent?: InterviewSubtaskIntent;
  creatingParent?: boolean;
}): ResponseArtifactMutationAuthorization {
  const parentQuestionType =
    normalizeCanonicalQuestionType(input.parentQuestionType) ?? undefined;
  const responseOwnerQuestionType =
    normalizeCanonicalQuestionType(input.responseOwnerQuestionType) ?? "unknown";
  const base = {
    parentQuestionType,
    responseOwnerQuestionType,
    responseOwnerSource: input.responseOwnerSource,
  };

  if (input.relation === "logistics") {
    return {
      ...base,
      disposition: "display-only-transient",
      reason: "transient-response-cannot-mutate-parent-artifacts",
      allowLatestUsefulAnswer: false,
      allowWhiteboard: false,
      allowCode: false,
      allowComplexity: false,
      allowParentContextMutation: false,
    };
  }

  if ((!input.parentTaskId && !input.creatingParent) || !parentQuestionType) {
    return {
      ...base,
      disposition: "rejected-missing-parent",
      reason: "persistent-artifacts-require-canonical-parent",
      allowLatestUsefulAnswer: false,
      allowWhiteboard: false,
      allowCode: false,
      allowComplexity: false,
      allowParentContextMutation: false,
    };
  }

  if (
    responseOwnerQuestionType === "field-knowledge" &&
    input.relation !== "child-probe"
  ) {
    return {
      ...base,
      disposition: "display-only-transient",
      reason: "transient-response-cannot-mutate-parent-artifacts",
      allowLatestUsefulAnswer: false,
      allowWhiteboard: false,
      allowCode: false,
      allowComplexity: false,
      allowParentContextMutation: false,
    };
  }

  if (input.relation === "child-probe") {
    if (responseOwnerQuestionType === "coding") {
      const codingArtifactAuthority =
        input.subtaskIntent === "complexity-probe"
          ? { allowCode: false, allowComplexity: true }
          : input.subtaskIntent === undefined ||
              input.subtaskIntent === "implementation-probe"
            ? { allowCode: true, allowComplexity: true }
            : { allowCode: false, allowComplexity: false };
      return {
        ...base,
        disposition: "coding-child-authorized",
        reason: "coding-child-may-update-authorized-coding-artifacts",
        allowLatestUsefulAnswer: false,
        allowWhiteboard: false,
        ...codingArtifactAuthority,
        allowParentContextMutation: false,
      };
    }

    if (
      isDesignQuestionType(parentQuestionType) &&
      isDesignQuestionType(responseOwnerQuestionType) &&
      areCompatibleParentContinuityTypes(
        parentQuestionType,
        responseOwnerQuestionType
      )
    ) {
      return {
        ...base,
        disposition: "design-child-authorized",
        reason: "compatible-design-child-may-revise-whiteboard",
        allowLatestUsefulAnswer: false,
        allowWhiteboard: true,
        allowCode: false,
        allowComplexity: false,
        allowParentContextMutation: false,
      };
    }

    return {
      ...base,
      disposition: "display-only-child",
      reason: "child-response-preserves-parent-artifacts",
      allowLatestUsefulAnswer: false,
      allowWhiteboard: false,
      allowCode: false,
      allowComplexity: false,
      allowParentContextMutation: false,
    };
  }

  if (
    responseOwnerQuestionType !== "unknown" &&
    areCompatibleParentContinuityTypes(
      parentQuestionType,
      responseOwnerQuestionType
    )
  ) {
    const codingArtifactAuthority =
      parentQuestionType === "coding"
        ? resolveCodingArtifactAuthority({
            creatingParent: input.creatingParent,
            subtaskIntent: input.subtaskIntent,
          })
        : { allowCode: false, allowComplexity: false };
    return {
      ...base,
      disposition: "parent-owner-authorized",
      reason: "compatible-response-owner-matches-canonical-parent",
      allowLatestUsefulAnswer: true,
      allowWhiteboard: isDesignQuestionType(parentQuestionType),
      ...codingArtifactAuthority,
      allowParentContextMutation: true,
    };
  }

  return {
    ...base,
    disposition: "rejected-incompatible-owner",
    reason: "response-owner-is-incompatible-with-canonical-parent",
    allowLatestUsefulAnswer: false,
    allowWhiteboard: false,
    allowCode: false,
    allowComplexity: false,
    allowParentContextMutation: false,
  };
}

export function formatResponseArtifactAuthorizationForTrace(
  authorization: ResponseArtifactMutationAuthorization
) {
  return {
    responseArtifactMutationDisposition: authorization.disposition,
    responseArtifactMutationReason: authorization.reason,
    responseArtifactParentQuestionType: authorization.parentQuestionType,
    responseArtifactOwnerQuestionType:
      authorization.responseOwnerQuestionType,
    responseArtifactOwnerSource: authorization.responseOwnerSource,
    responseArtifactLatestAnswerAuthorized:
      authorization.allowLatestUsefulAnswer,
    responseArtifactWhiteboardAuthorized: authorization.allowWhiteboard,
    responseArtifactCodeAuthorized: authorization.allowCode,
    responseArtifactComplexityAuthorized: authorization.allowComplexity,
    responseArtifactParentContextAuthorized:
      authorization.allowParentContextMutation,
  };
}

function resolveCodingArtifactAuthority(input: {
  creatingParent?: boolean;
  subtaskIntent?: InterviewSubtaskIntent;
}) {
  if (input.creatingParent) {
    return { allowCode: true, allowComplexity: true };
  }
  if (input.subtaskIntent === "implementation-probe") {
    return { allowCode: true, allowComplexity: true };
  }
  if (input.subtaskIntent === "complexity-probe") {
    return { allowCode: false, allowComplexity: true };
  }

  return { allowCode: false, allowComplexity: false };
}

function isDesignQuestionType(questionType: CanonicalQuestionType) {
  return (
    questionType === "general-system-design" ||
    questionType === "ai-ml-system-design"
  );
}
