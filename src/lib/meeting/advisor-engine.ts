import type { MeetingAdvisorRequest } from "./meeting-context-contracts.js";
import { AdvisorSuggestion, ParsedMeetingAnswer } from "./types";
import { buildAdvisorSystemPrompt, buildAdvisorUserMessage } from "./advisor-prompt";
import { parseMeetingAnswer } from "./meeting-answer.js";
import { streamPreparedMeetingGeneration, type MeetingGenerationEvent } from "./meeting-generation-stream.js";

export type AdvisorEngineEvent = MeetingGenerationEvent;

export class AdvisorEngine {
  private currentAbortController: AbortController | null = null;

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
    const sourceImages = request.sourceImages ?? [];

    request.trace?.onRequest?.({
      systemPrompt,
      userMessage,
      imageCount: sourceImages.length,
      imageMediaType: sourceImages[0]?.mediaType,
      providerId: request.provider?.id,
      mode: request.mode,
      responseAction: request.responseAction,
      responseConfig: request.responseConfig,
      requestOptions: request.requestOptions,
    });

    try {
      for await (const event of streamPreparedMeetingGeneration(request.requestId, {
        provider: request.provider,
        selectedProvider: request.selectedProvider,
        systemPrompt,
        history: request.history ?? [],
        userMessage,
        imagesBase64: sourceImages,
        signal: abortController.signal,
        applyResponseSettings: false,
        requestOptions: request.requestOptions,
        executionIdentity: buildAdvisorExecutionIdentity(request),
      }, request.trace)) {
        if (event.type === "candidate") request.trace?.onComplete?.(event.candidate.content);
        yield event;
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
