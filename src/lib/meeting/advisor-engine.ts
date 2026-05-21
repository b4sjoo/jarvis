import { fetchAIResponse } from "@/lib/functions";
import { Message } from "@/types";
import {
  AdvisorSuggestion,
  MeetingAdvisorRequest,
  TranscriptTurn,
} from "./types";
import { buildAdvisorSystemPrompt, buildAdvisorUserMessage } from "./advisor-prompt";

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
    });
    let accumulated = "";
    let firstTokenSeen = false;

    request.trace?.onRequest?.({
      systemPrompt,
      userMessage,
      imageCount: 0,
      providerId: request.provider?.id,
      mode: request.mode,
    });

    for await (const chunk of fetchAIResponse({
      provider: request.provider,
      selectedProvider: request.selectedProvider,
      systemPrompt,
      history: request.history ?? [],
      userMessage,
      imagesBase64: [],
      signal: abortController.signal,
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
    basedOnObservationIds: string[]
  ): AdvisorSuggestion {
    return {
      id: requestId,
      kind: inferSuggestionKind(content),
      content: content.trim(),
      createdAt: Date.now(),
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

function inferSuggestionKind(content: string): AdvisorSuggestion["kind"] {
  const normalized = content.trim().toLowerCase();
  if (!normalized || normalized === "-") return "silent";
  if (
    normalized.includes("question:") &&
    normalized.includes("answer:") &&
    (normalized.includes("approach:") || normalized.includes("complexity:"))
  ) {
    return "screen-task";
  }
  if (normalized.includes("clarifying") || normalized.includes("澄清")) {
    return "clarifying-question";
  }
  if (normalized.includes("means") || normalized.includes("意思")) {
    return "context";
  }
  return "answer";
}
