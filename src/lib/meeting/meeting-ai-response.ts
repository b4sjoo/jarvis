import type {
  AIResponseEvent,
  AIResponseTerminalOutcome,
} from "../functions/ai-response-events.js";

export type MeetingAIResponseProviderDisposition =
  | "completed-with-content"
  | "completed-empty"
  | "provider-error-content"
  | "provider-auth-error";

export interface MeetingAIResponseCandidate {
  readonly content: string;
  readonly outcome: Readonly<AIResponseTerminalOutcome>;
  readonly attempts: readonly Readonly<AIResponseTerminalOutcome>[];
}

export type MeetingAIResponseCollectionResult =
  | {
      readonly accepted: true;
      readonly candidate: Readonly<MeetingAIResponseCandidate>;
      readonly providerDisposition: "completed-with-content";
    }
  | {
      readonly accepted: false;
      readonly outcome: Readonly<AIResponseTerminalOutcome>;
      readonly attempts: readonly Readonly<AIResponseTerminalOutcome>[];
      readonly providerDisposition: Exclude<
        MeetingAIResponseProviderDisposition,
        "completed-with-content"
      >;
    };

export async function collectMeetingAIResponseCandidate(input: {
  events: AsyncIterable<AIResponseEvent>;
  onFirstContent?: (at: number) => void;
  onPartialContent?: (content: string, event: AIResponseEvent) => void;
  onPartialReset?: (outcome: Readonly<AIResponseTerminalOutcome>) => void;
  onTerminal?: (outcome: Readonly<AIResponseTerminalOutcome>) => void;
  maxOutputChars?: number;
}): Promise<MeetingAIResponseCollectionResult> {
  const attemptContent = new Map<string, string>();
  let firstContentSeen = false;
  let finalOutcome: Readonly<AIResponseTerminalOutcome> | undefined;
  const terminalOutcomes: Readonly<AIResponseTerminalOutcome>[] = [];

  for await (const event of input.events) {
    if (finalOutcome) {
      throw new Error("AI response emitted content after its final outcome");
    }
    if (event.type === "content-delta") {
      const accumulated =
        (attemptContent.get(event.attemptId) ?? "") + event.content;
      if (
        input.maxOutputChars !== undefined &&
        accumulated.length > input.maxOutputChars
      ) {
        throw new Error("AI response output exceeded its configured limit");
      }
      attemptContent.set(event.attemptId, accumulated);
      if (!firstContentSeen) {
        firstContentSeen = true;
        input.onFirstContent?.(event.emittedAt);
      }
      input.onPartialContent?.(accumulated, event);
      continue;
    }

    const outcome = Object.freeze({ ...event.outcome });
    terminalOutcomes.push(outcome);
    input.onTerminal?.(outcome);
    if (!outcome.final) {
      attemptContent.delete(outcome.attemptId);
      input.onPartialReset?.(outcome);
      continue;
    }
    finalOutcome = outcome;
  }

  if (!finalOutcome) {
    throw new Error("AI response ended without a final outcome");
  }

  const result = acceptMeetingAIResponseOutcome(
    finalOutcome,
    terminalOutcomes
  );
  if (!result.accepted) input.onPartialReset?.(finalOutcome);
  return result;
}

export function acceptMeetingAIResponseOutcome(
  outcome: Readonly<AIResponseTerminalOutcome>,
  attempts: readonly Readonly<AIResponseTerminalOutcome>[] = [outcome]
): MeetingAIResponseCollectionResult {
  const immutableOutcome = Object.isFrozen(outcome)
    ? outcome
    : Object.freeze({ ...outcome });
  if (
    immutableOutcome.status === "success" &&
    immutableOutcome.disposition === "accepted" &&
    immutableOutcome.final &&
    immutableOutcome.text?.trim()
  ) {
    const candidate = Object.freeze({
      content: immutableOutcome.text,
      outcome: immutableOutcome,
      attempts: Object.freeze(
        attempts.map((attempt) =>
          Object.isFrozen(attempt)
            ? attempt
            : Object.freeze({ ...attempt })
        )
      ),
    });
    return Object.freeze({
      accepted: true,
      candidate,
      providerDisposition: "completed-with-content" as const,
    });
  }
  return Object.freeze({
    accepted: false,
    outcome: immutableOutcome,
    attempts: Object.freeze(
      attempts.map((attempt) =>
        Object.isFrozen(attempt)
          ? attempt
          : Object.freeze({ ...attempt })
      )
    ),
    providerDisposition: classifyMeetingAIResponseOutcome(immutableOutcome),
  });
}

export function classifyMeetingAIResponseOutcome(
  outcome: Readonly<AIResponseTerminalOutcome>
): Exclude<
  MeetingAIResponseProviderDisposition,
  "completed-with-content"
> {
  if (outcome.status === "empty") return "completed-empty";
  if (outcome.failureClass === "authentication") {
    return "provider-auth-error";
  }
  return "provider-error-content";
}

export function requireMeetingAIResponseCandidate(
  result: MeetingAIResponseCollectionResult
): Readonly<MeetingAIResponseCandidate> {
  if (result.accepted) return result.candidate;
  throw new MeetingAIResponseOutcomeError(
    result.outcome,
    result.attempts
  );
}

export class MeetingAIResponseOutcomeError extends Error {
  readonly outcome: Readonly<AIResponseTerminalOutcome>;
  readonly attempts: readonly Readonly<AIResponseTerminalOutcome>[];

  constructor(
    outcome: Readonly<AIResponseTerminalOutcome>,
    attempts: readonly Readonly<AIResponseTerminalOutcome>[] = [outcome]
  ) {
    super(
      outcome.safeErrorSummary ??
        describeMeetingAIResponseOutcome(outcome)
    );
    this.name = outcome.status === "aborted" ? "AbortError" : "AIResponseError";
    this.outcome = outcome;
    this.attempts = Object.freeze([...attempts]);
  }
}

function describeMeetingAIResponseOutcome(
  outcome: Readonly<AIResponseTerminalOutcome>
) {
  switch (outcome.status) {
    case "empty":
      return "AI provider returned an empty response.";
    case "timed-out":
      return "AI provider request timed out.";
    case "aborted":
      return "AI provider request was cancelled.";
    case "failed":
      return "AI provider request failed.";
    case "success":
      return outcome.disposition === "stale"
        ? "AI provider response became stale before acceptance."
        : "AI provider response was not accepted.";
  }
}
