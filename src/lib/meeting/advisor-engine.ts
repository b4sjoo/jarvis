import { fetchAIResponseEvents } from "@/lib/functions";
import { Message } from "@/types";
import {
  AdvisorSuggestion,
  MeetingAdvisorRequest,
  ParsedMeetingAnswer,
  TranscriptTurn,
} from "./types";
import { buildAdvisorSystemPrompt, buildAdvisorUserMessage } from "./advisor-prompt";
import { parseMeetingAnswer } from "./meeting-answer.js";
import {
  acceptMeetingAIResponseOutcome,
  MeetingAIResponseOutcomeError,
  type MeetingAIResponseCandidate,
} from "./meeting-ai-response.js";

export type AdvisorEngineEvent =
  | {
      type: "content-delta";
      requestId: string;
      chunk: string;
      accumulated: string;
    }
  | {
      type: "partial-reset";
      requestId: string;
    }
  | {
      type: "candidate";
      requestId: string;
      candidate: Readonly<MeetingAIResponseCandidate>;
    };

export class AdvisorEngine {
  private currentAbortController: AbortController | null = null;

  shouldRequestSuggestion(turn: TranscriptTurn | undefined) {
    if (!turn) return false;
    if (!turn.isFinal) return false;
    if (turn.speaker === "me") return false;
    return turn.text.trim().length > 0;
  }

  cancelCurrentRequest() {
    this.currentAbortController?.abort();
    this.currentAbortController = null;
  }

  async *streamSuggestion(
    request: Omit<MeetingAdvisorRequest, "signal">
  ): AsyncIterable<AdvisorEngineEvent> {
    this.cancelCurrentRequest();
    const abortController = new AbortController();
    this.currentAbortController = abortController;

    const systemPrompt = buildAdvisorSystemPrompt();
    const userMessage = buildAdvisorUserMessage(request.promptContext, {
      currentSuggestion: request.currentSuggestion,
      clarifyingFeedback: request.clarifyingFeedback,
      mode: request.mode ?? "live",
      responseAction: request.responseAction,
      responseConfig: request.responseConfig,
      answerProfile: request.answerProfile,
    });
    let accumulated = "";
    let firstTokenSeen = false;

    request.trace?.onRequest?.({
      systemPrompt,
      userMessage,
      imageCount: 0,
      providerId: request.provider?.id,
      mode: request.mode,
      responseAction: request.responseAction,
      responseConfig: request.responseConfig,
      requestOptions: request.requestOptions,
    });

    let acceptedCandidate = false;
    try {
      for await (const event of fetchAIResponseEvents({
        provider: request.provider,
        selectedProvider: request.selectedProvider,
        systemPrompt,
        history: request.history ?? [],
        userMessage,
        imagesBase64: [],
        signal: abortController.signal,
        applyResponseSettings: false,
        requestOptions: request.requestOptions,
        executionIdentity: buildAdvisorExecutionIdentity(request),
      })) {
        if (event.type === "content-delta") {
          if (!firstTokenSeen) {
            firstTokenSeen = true;
            request.trace?.onFirstToken?.();
          }
          accumulated += event.content;
          yield {
            type: "content-delta",
            requestId: request.requestId,
            chunk: event.content,
            accumulated,
          };
          continue;
        }

        request.trace?.onTerminal?.(event.outcome);
        if (!event.outcome.final) {
          accumulated = "";
          yield { type: "partial-reset", requestId: request.requestId };
          continue;
        }

        const result = acceptMeetingAIResponseOutcome(event.outcome);
        if (!result.accepted) {
          throw new MeetingAIResponseOutcomeError(result.outcome);
        }
        acceptedCandidate = true;
        accumulated = result.candidate.content;
        request.trace?.onComplete?.(accumulated);
        yield {
          type: "candidate",
          requestId: request.requestId,
          candidate: result.candidate,
        };
      }
      if (!acceptedCandidate) {
        throw new Error("Advisor response ended without an accepted candidate");
      }
    } finally {
      if (this.currentAbortController === abortController) {
        this.currentAbortController = null;
      }
    }
  }

  toSuggestion(
    requestId: string,
    content: string,
    basedOnTurnIds: string[],
    basedOnObservationIds: string[],
    taskMetadata: Pick<
      AdvisorSuggestion,
      "taskId" | "parentTaskId" | "childTaskId" | "taskSource" | "questionType"
    > = {},
    parsedAnswer?: ParsedMeetingAnswer
  ): AdvisorSuggestion {
    const meetingAnswer = parsedAnswer ?? parseMeetingAnswer(content);
    const kind = inferSuggestionKind(content, meetingAnswer);

    return {
      id: requestId,
      kind,
      content: content.trim(),
      meetingAnswer,
      answerProfile: meetingAnswer.profile,
      createdAt: Date.now(),
      ...taskMetadata,
      basedOnTurnIds,
      basedOnObservationIds,
      confidence: content.trim().startsWith("?") ? "low" : "medium",
    };
  }
}

function buildAdvisorExecutionIdentity(
  request: Omit<MeetingAdvisorRequest, "signal">
) {
  const task = request.promptContext.activeMeetingTask;
  return {
    ...request.executionIdentity,
    requestId: request.requestId,
    executionPlanId:
      request.executionIdentity?.executionPlanId ??
      (task
        ? `${task.id}:revision:${task.runtimeRevision}`
        : request.requestId),
    logicalQuestionUnitId:
      request.executionIdentity?.logicalQuestionUnitId ??
      task?.parent.sourceQuestionUnitId ??
      task?.parent.id ??
      "unscoped",
    logicalQuestionRevision:
      request.executionIdentity?.logicalQuestionRevision ??
      task?.parent.sourceQuestionRevision ??
      task?.runtimeRevision ??
      0,
  };
}

export function transcriptTurnsToMessages(turns: TranscriptTurn[]): Message[] {
  return turns.map((turn) => ({
    role: turn.speaker === "me" ? "user" : "assistant",
    content: turn.text,
  }));
}

function inferSuggestionKind(
  content: string,
  parsedAnswer?: ParsedMeetingAnswer
): AdvisorSuggestion["kind"] {
  const normalized = content.trim().toLowerCase();
  const meetingAnswer = parsedAnswer ?? parseMeetingAnswer(content);

  if (!normalized || normalized === "-") return "silent";
  if (meetingAnswer.sections.answer) return "answer";
  if (meetingAnswer.sections.clarifyingQuestion) {
    return "clarifying-question";
  }
  if (normalized.includes("means") || normalized.includes("意思")) {
    return "context";
  }
  return "answer";
}
