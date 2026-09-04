import type {
  AIResponseEvent,
  AIResponseTerminalOutcome,
} from "../functions/ai-response-events.js";
import {
  collectMeetingAIResponseCandidate,
  type MeetingAIResponseProviderDisposition,
} from "./meeting-ai-response.js";

export interface RuntimeInferenceProviderResponse {
  rawOutput: string;
  providerDisposition: MeetingAIResponseProviderDisposition;
  providerOutcome: Readonly<AIResponseTerminalOutcome>;
  firstTokenAt?: number;
  completedAt: number;
}

export async function consumeRuntimeInferenceResponse(input: {
  responseEvents: AsyncIterable<AIResponseEvent>;
  signal: AbortSignal;
  operationLabel: string;
  onFirstToken?: (at: number) => void;
  maxOutputChars?: number;
}): Promise<RuntimeInferenceProviderResponse> {
  let firstTokenAt: number | undefined;
  const result = await collectMeetingAIResponseCandidate({
    events: input.responseEvents,
    maxOutputChars: input.maxOutputChars,
    onFirstContent: (at) => {
      firstTokenAt ??= at;
      input.onFirstToken?.(at);
    },
  });
  const outcome = result.accepted
    ? result.candidate.outcome
    : result.outcome;
  if (input.signal.aborted || outcome.status === "aborted") {
    throw new DOMException(`${input.operationLabel} aborted`, "AbortError");
  }
  return {
    rawOutput: result.accepted ? result.candidate.content : "",
    providerDisposition: result.providerDisposition,
    providerOutcome: outcome,
    firstTokenAt,
    completedAt: Date.now(),
  };
}

export function formatRuntimeInferenceProviderOutcomeForTrace(
  outcome: Readonly<AIResponseTerminalOutcome> | undefined,
  prefix: string
): Record<string, unknown> {
  return {
    [`${prefix}ProviderOutcomeStatus`]: outcome?.status,
    [`${prefix}ProviderFailureClass`]: outcome?.failureClass,
    [`${prefix}ProviderAttemptId`]: outcome?.attemptId,
    [`${prefix}ProviderAttemptNumber`]: outcome?.attemptNumber,
    [`${prefix}ProviderMaxAttempts`]: outcome?.maxAttempts,
    [`${prefix}ProviderRetryable`]: outcome?.retryable,
    [`${prefix}ProviderOutcomeFinal`]: outcome?.final,
    [`${prefix}ProviderAttemptDisposition`]: outcome?.disposition,
    [`${prefix}ProviderRequestId`]: outcome?.requestId,
    [`${prefix}ProviderLastContentAt`]: outcome?.lastContentAt,
    [`${prefix}ProviderObservedContentChars`]:
      outcome?.observedContentChars,
    [`${prefix}ProviderObservedContentHash`]:
      outcome?.observedContentHash,
    [`${prefix}ProviderCompletionSignal`]: outcome?.completionSignal,
  };
}

export function didRuntimeInferenceProviderTimeOut(input: {
  outcome?: Pick<AIResponseTerminalOutcome, "status">;
  error?: unknown;
}) {
  return (
    input.outcome?.status === "timed-out" ||
    (input.error instanceof Error && /timeout/i.test(input.error.message))
  );
}
