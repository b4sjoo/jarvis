import { fetchAIResponseEvents, type AIResponseParams } from "../functions/ai-response.function.js";
import type { AIResponseTerminalOutcome } from "../functions/ai-response-events.js";
import type { MeetingModelTraceCallbacks } from "./types.js";
import { acceptMeetingAIResponseOutcome, MeetingAIResponseOutcomeError, type MeetingAIResponseCandidate } from "./meeting-ai-response.js";

export type MeetingGenerationEvent =
  | { type: "content-delta"; requestId: string; chunk: string; accumulated: string }
  | { type: "partial-reset"; requestId: string }
  | { type: "candidate"; requestId: string; candidate: Readonly<MeetingAIResponseCandidate> };

/** One typed stream consumer. Cancellation remains owned by the request's source. */
export async function* streamPreparedMeetingGeneration(
  requestId: string,
  request: AIResponseParams,
  trace?: Pick<MeetingModelTraceCallbacks, "onFirstToken" | "onTerminal">
): AsyncIterable<MeetingGenerationEvent> {
  let accumulated = "";
  let firstTokenSeen = false;
  let acceptedCandidate = false;
  const attempts: Readonly<AIResponseTerminalOutcome>[] = [];
  for await (const event of fetchAIResponseEvents(request)) {
    if (event.type === "content-delta") {
      if (!firstTokenSeen) {
        firstTokenSeen = true;
        trace?.onFirstToken?.();
      }
      accumulated += event.content;
      yield { type: "content-delta", requestId, chunk: event.content, accumulated };
      continue;
    }
    trace?.onTerminal?.(event.outcome);
    attempts.push(Object.freeze({ ...event.outcome }));
    if (!event.outcome.final) {
      accumulated = "";
      yield { type: "partial-reset", requestId };
      continue;
    }
    const result = acceptMeetingAIResponseOutcome(event.outcome, attempts);
    if (!result.accepted) {
      throw new MeetingAIResponseOutcomeError(result.outcome, result.attempts);
    }
    acceptedCandidate = true;
    yield { type: "candidate", requestId, candidate: result.candidate };
  }
  if (!acceptedCandidate) {
    throw new Error("Advisor response ended without an accepted candidate");
  }
}
