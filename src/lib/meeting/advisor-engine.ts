import { fetchAIResponse } from "@/lib/functions";
import { Message } from "@/types";
import {
  AdvisorSuggestion,
  MeetingAdvisorRequest,
  ParsedMeetingAnswer,
  TranscriptTurn,
} from "./types";
import { buildAdvisorSystemPrompt, buildAdvisorUserMessage } from "./advisor-prompt";
import {
  hasScreenTaskAnswerContent,
  parseScreenTaskAnswer,
  screenTaskAnswerFromParsedMeetingAnswer,
} from "./screen-task-answer";
import { parseMeetingAnswer } from "./meeting-answer.js";

export interface AdvisorEngineChunk {
  requestId: string;
  chunk: string;
  accumulated: string;
}

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
  ): AsyncIterable<AdvisorEngineChunk> {
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

    for await (const chunk of fetchAIResponse({
      provider: request.provider,
      selectedProvider: request.selectedProvider,
      systemPrompt,
      history: request.history ?? [],
      userMessage,
      imagesBase64: [],
      signal: abortController.signal,
      applyResponseSettings: false,
      requestOptions: request.requestOptions,
    })) {
      if (!firstTokenSeen) {
        firstTokenSeen = true;
        request.trace?.onFirstToken?.();
      }

      accumulated += chunk;
      yield {
        requestId: request.requestId,
        chunk,
        accumulated,
      };
    }

    if (abortController.signal.aborted) {
      throw createAbortError();
    }

    request.trace?.onComplete?.(accumulated);

    if (this.currentAbortController === abortController) {
      this.currentAbortController = null;
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
    const hasScreenSource =
      taskMetadata.taskSource === "screen" ||
      taskMetadata.taskSource === "mixed";
    const screenTaskAnswer =
      hasScreenSource
        ? screenTaskAnswerFromParsedMeetingAnswer(meetingAnswer)
        : undefined;

    return {
      id: requestId,
      kind,
      content: content.trim(),
      meetingAnswer,
      answerProfile: meetingAnswer.profile,
      screenTaskAnswer:
        screenTaskAnswer && hasScreenTaskAnswerContent(screenTaskAnswer)
          ? screenTaskAnswer
          : undefined,
      createdAt: Date.now(),
      ...taskMetadata,
      basedOnTurnIds,
      basedOnObservationIds,
      confidence: content.trim().startsWith("?") ? "low" : "medium",
    };
  }
}

function createAbortError() {
  const error = new Error("Advisor request cancelled.");
  error.name = "AbortError";
  return error;
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
  const screenTaskAnswer = parsedAnswer
    ? screenTaskAnswerFromParsedMeetingAnswer(parsedAnswer)
    : parseScreenTaskAnswer(content);

  if (!normalized || normalized === "-") return "silent";
  if (screenTaskAnswer.answer) return "answer";
  if (screenTaskAnswer.clarifyingQuestion) {
    return "clarifying-question";
  }
  if (normalized.includes("means") || normalized.includes("意思")) {
    return "context";
  }
  return "answer";
}
