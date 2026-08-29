import type { MeetingResponseOwnerSource } from "./meeting-model-route.js";
import type { AnswerArtifactSection } from "./answer-generation-lease.js";
import {
  areCompatibleParentContinuityTypes,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import type {
  EffectiveInterviewTaskRelation,
  InterviewPlaybookPhase,
  InterviewSubtaskIntent,
} from "./types.js";

export type ResponseArtifactMutationDisposition =
  | "parent-owner-authorized"
  | "coding-child-authorized"
  | "design-child-authorized"
  | "display-only-child"
  | "display-only-parent-continuity"
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

export function isExplicitCodingComplexityIntent(input: {
  text: string;
  questionType?: unknown;
}) {
  if (normalizeCanonicalQuestionType(input.questionType) !== "coding") {
    return false;
  }
  return /\b(?:time|space)\s+complexity\b|\btime\s+and\s+space\s+complexit(?:y|ies)\b|\bbig[- ]?o\b|\bo\s*\([^)]{1,12}\)|\boptimi[sz](?:e|ed|ing|ation)\b/i.test(
    input.text
  );
}

export function resolveAdvisorGenerationRequestedArtifacts(input: {
  forceAnswerOnly?: boolean;
  runtimeTypeAdjudicationAnswerOnly?: boolean;
  settledPlanArtifacts?: readonly AnswerArtifactSection[];
  committedManualPhaseArtifacts?: readonly AnswerArtifactSection[];
}): AnswerArtifactSection[] {
  if (input.forceAnswerOnly || input.runtimeTypeAdjudicationAnswerOnly) {
    return ["answer"];
  }

  const requestedArtifacts =
    input.settledPlanArtifacts ?? input.committedManualPhaseArtifacts;
  if (!requestedArtifacts?.length) return ["answer"];

  return [...new Set(requestedArtifacts)];
}

export function formatManualPhaseArtifactContractForTrace(input: {
  committed: boolean;
  targetArtifact?: AnswerArtifactSection | "none";
  requestedArtifacts: readonly AnswerArtifactSection[];
}) {
  const targetArtifact = input.targetArtifact;
  const targetRequested =
    !input.committed || !targetArtifact || targetArtifact === "none"
      ? true
      : input.requestedArtifacts.includes(targetArtifact);
  const mismatchReasons = targetRequested
    ? []
    : [`manual-phase-target-not-requested:${targetArtifact}`];

  return {
    manualPhaseTargetArtifactRequested: targetRequested,
    playbookArtifactContractMismatch: mismatchReasons.length > 0,
    playbookArtifactContractMismatchReasons: mismatchReasons,
  };
}

export function authorizeResponseArtifactMutation(input: {
  parentTaskId?: string;
  parentQuestionType?: unknown;
  responseOwnerQuestionType?: unknown;
  responseOwnerSource: MeetingResponseOwnerSource;
  relation: EffectiveInterviewTaskRelation;
  subtaskIntent?: InterviewSubtaskIntent;
  codingPhase?: InterviewPlaybookPhase;
  requiredArtifacts?: AnswerArtifactSection[];
  creatingParent?: boolean;
  readOnlyParentContinuity?: boolean;
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
  const artifactGate = resolveRequiredArtifactGate(input.requiredArtifacts);

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

  if (input.readOnlyParentContinuity) {
    return {
      ...base,
      disposition: "display-only-parent-continuity",
      reason: "response-only-scope-preserves-read-only-artifact-owner",
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
          : input.subtaskIntent === "implementation-probe"
            ? { allowCode: true, allowComplexity: true }
            : { allowCode: false, allowComplexity: false };
      return {
        ...base,
        disposition: "coding-child-authorized",
        reason: "coding-child-may-update-authorized-coding-artifacts",
        allowLatestUsefulAnswer: false,
        allowWhiteboard: false,
        allowCode:
          codingArtifactAuthority.allowCode && artifactGate.allowCode,
        allowComplexity:
          codingArtifactAuthority.allowComplexity &&
          artifactGate.allowComplexity,
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
        allowWhiteboard: artifactGate.allowWhiteboard,
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
            codingPhase: input.codingPhase,
          })
        : { allowCode: false, allowComplexity: false };
    return {
      ...base,
      disposition: "parent-owner-authorized",
      reason: "compatible-response-owner-matches-canonical-parent",
      allowLatestUsefulAnswer: true,
      allowWhiteboard:
        isDesignQuestionType(parentQuestionType) &&
        artifactGate.allowWhiteboard,
      allowCode:
        codingArtifactAuthority.allowCode && artifactGate.allowCode,
      allowComplexity:
        codingArtifactAuthority.allowComplexity &&
        artifactGate.allowComplexity,
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
  codingPhase?: InterviewPlaybookPhase;
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

  if (input.codingPhase === "optimized_pseudocode") {
    return { allowCode: false, allowComplexity: true };
  }
  if (
    input.codingPhase === "baseline_reasoning" ||
    input.codingPhase === "implementation_validation"
  ) {
    return { allowCode: true, allowComplexity: true };
  }

  return { allowCode: false, allowComplexity: false };
}

function resolveRequiredArtifactGate(
  requiredArtifacts: AnswerArtifactSection[] | undefined
) {
  if (!requiredArtifacts) {
    return {
      allowCode: true,
      allowComplexity: true,
      allowWhiteboard: true,
    };
  }
  const required = new Set(requiredArtifacts);
  return {
    allowCode: required.has("code"),
    allowComplexity: required.has("complexity"),
    allowWhiteboard: required.has("whiteboard"),
  };
}

function isDesignQuestionType(questionType: CanonicalQuestionType) {
  return (
    questionType === "general-system-design" ||
    questionType === "ai-ml-system-design"
  );
}
