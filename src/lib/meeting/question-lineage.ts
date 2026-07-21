import type {
  AdvisorSuggestion,
  QuestionInstanceLineage,
} from "./types.js";
import type { AdvisorTurnGateAction } from "./advisor-turn-intent.js";

export interface CreateQuestionLineageInput {
  traceId?: string;
  triggerTurnId?: string;
  sessionId: string;
  runtimeEpoch: number;
  action?: AdvisorTurnGateAction;
  executionAuthorized: boolean;
  inherited?: QuestionInstanceLineage;
}

export function createAuthorizedQuestionLineage(
  input: CreateQuestionLineageInput
): QuestionInstanceLineage | undefined {
  if (input.inherited) return { ...input.inherited };
  if (
    !input.executionAuthorized ||
    input.action !== "answer-refresh" ||
    !input.traceId
  ) {
    return undefined;
  }

  return {
    questionInstanceId: `trace:${input.traceId}`,
    questionOriginTraceId: input.traceId,
    triggerTurnId: input.triggerTurnId,
    sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    identityState: "provisional",
  };
}

export function attachQuestionLineageToSuggestion(
  lineage: QuestionInstanceLineage | undefined,
  suggestion: Pick<AdvisorSuggestion, "id">
): QuestionInstanceLineage | undefined {
  if (!lineage) return undefined;
  return {
    ...lineage,
    sourceSuggestionId: suggestion.id,
  };
}

export function promoteQuestionLineage(
  lineage: QuestionInstanceLineage | undefined
): QuestionInstanceLineage | undefined {
  return lineage
    ? {
        ...lineage,
        identityState: "canonical",
      }
    : undefined;
}

export function isCurrentQuestionLineage(input: {
  lineage: QuestionInstanceLineage | undefined;
  suggestion: AdvisorSuggestion | null | undefined;
  sessionId: string;
  runtimeEpoch: number;
}) {
  const { lineage, suggestion } = input;
  if (!lineage || !suggestion) return false;
  if (lineage.sessionId && lineage.sessionId !== input.sessionId) return false;
  if (
    lineage.runtimeEpoch !== undefined &&
    lineage.runtimeEpoch !== input.runtimeEpoch
  ) {
    return false;
  }
  return Boolean(
    lineage.sourceSuggestionId &&
      lineage.sourceSuggestionId === suggestion.id &&
      (!suggestion.questionLineage ||
        suggestion.questionLineage.questionInstanceId ===
          lineage.questionInstanceId)
  );
}

export function formatQuestionLineageForTrace(
  lineage: QuestionInstanceLineage | undefined
) {
  return lineage
    ? {
        questionInstanceId: lineage.questionInstanceId,
        questionOriginTraceId: lineage.questionOriginTraceId,
        questionTriggerTurnId: lineage.triggerTurnId,
        sourceSuggestionId: lineage.sourceSuggestionId,
        questionIdentityState: lineage.identityState ?? "provisional",
        questionLineageSessionId: lineage.sessionId,
        questionLineageRuntimeEpoch: lineage.runtimeEpoch,
      }
    : {
        questionIdentityState: "none",
      };
}
