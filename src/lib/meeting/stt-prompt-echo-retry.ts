import type { MeetingTranscriptionResult } from "./transcription.service";
import type { SttRequestPromptKind } from "./stt-request-evidence";

export type SttAttemptPromptMode = "configured" | "unbiased";

export interface SttAttemptIdentity {
  id: string;
  traceId: string;
  audioSessionId: string;
  segmentSequence: number;
  attemptNumber: 1 | 2;
  promptMode: SttAttemptPromptMode;
  promptKind: SttRequestPromptKind;
}

export type SttPromptEchoRetryDisposition =
  | "not-needed"
  | "not-eligible"
  | "retry-suppressed-stale"
  | "recovered"
  | "retry-exhausted";

export interface SttPromptEchoRecoveryResult {
  attempts: Array<{
    identity: SttAttemptIdentity;
    result: MeetingTranscriptionResult;
  }>;
  finalResult: MeetingTranscriptionResult;
  finalAttempt: SttAttemptIdentity;
  retryTriggered: boolean;
  retryDisposition: SttPromptEchoRetryDisposition;
  retryReason: string;
}

export async function runSttPromptEchoRecovery({
  traceId,
  audioSessionId,
  segmentSequence,
  initialPromptKind,
  runAttempt,
  authorizeRetry,
}: {
  traceId: string;
  audioSessionId: string;
  segmentSequence: number;
  initialPromptKind: SttRequestPromptKind;
  runAttempt: (
    identity: SttAttemptIdentity
  ) => Promise<MeetingTranscriptionResult>;
  authorizeRetry: () => boolean;
}): Promise<SttPromptEchoRecoveryResult> {
  const firstIdentity = createSttAttemptIdentity({
    traceId,
    audioSessionId,
    segmentSequence,
    attemptNumber: 1,
    promptMode: "configured",
    promptKind: initialPromptKind,
  });
  const firstResult = await runAttempt(firstIdentity);
  const attempts = [{ identity: firstIdentity, result: firstResult }];

  if (!isPromptEcho(firstResult)) {
    return {
      attempts,
      finalResult: firstResult,
      finalAttempt: firstIdentity,
      retryTriggered: false,
      retryDisposition:
        firstResult.validation.disposition === "accepted"
          ? "not-needed"
          : "not-eligible",
      retryReason: firstResult.validation.reason,
    };
  }

  if (!authorizeRetry()) {
    return {
      attempts,
      finalResult: firstResult,
      finalAttempt: firstIdentity,
      retryTriggered: false,
      retryDisposition: "retry-suppressed-stale",
      retryReason: "segment-no-longer-current",
    };
  }

  const retryIdentity = createSttAttemptIdentity({
    traceId,
    audioSessionId,
    segmentSequence,
    attemptNumber: 2,
    promptMode: "unbiased",
    promptKind: "none",
  });
  const retryResult = await runAttempt(retryIdentity);
  attempts.push({ identity: retryIdentity, result: retryResult });

  return {
    attempts,
    finalResult: retryResult,
    finalAttempt: retryIdentity,
    retryTriggered: true,
    retryDisposition:
      retryResult.validation.disposition === "accepted"
        ? "recovered"
        : "retry-exhausted",
    retryReason: firstResult.validation.reason,
  };
}

export function createSttAttemptIdentity({
  traceId,
  audioSessionId,
  segmentSequence,
  attemptNumber,
  promptMode,
  promptKind,
}: Omit<SttAttemptIdentity, "id">): SttAttemptIdentity {
  return {
    id: [
      "stt_attempt",
      traceId,
      audioSessionId,
      segmentSequence,
      attemptNumber,
    ].join("_"),
    traceId,
    audioSessionId,
    segmentSequence,
    attemptNumber,
    promptMode,
    promptKind,
  };
}

export function formatSttPromptEchoRecoveryForTrace(
  result: SttPromptEchoRecoveryResult
): Record<string, string | number | boolean | undefined> {
  const initial = result.attempts[0];
  const retry = result.attempts[1];
  return {
    sttAttemptCount: result.attempts.length,
    sttInitialAttemptId: initial?.identity.id,
    sttInitialValidationDisposition:
      initial?.result.validation.disposition,
    sttInitialValidationReason: initial?.result.validation.reason,
    sttRetryTriggered: result.retryTriggered,
    sttRetryDisposition: result.retryDisposition,
    sttRetryReason: result.retryReason,
    sttRetryAttemptId: retry?.identity.id,
    sttRetryValidationDisposition:
      retry?.result.validation.disposition,
    sttRetryValidationReason: retry?.result.validation.reason,
    sttFinalAttemptId: result.finalAttempt.id,
    sttFinalAttemptNumber: result.finalAttempt.attemptNumber,
    sttFinalPromptMode: result.finalAttempt.promptMode,
  };
}

function isPromptEcho(result: MeetingTranscriptionResult) {
  return (
    result.validation.disposition === "rejected" &&
    (result.validation.reason === "prompt-echo-exact" ||
      result.validation.reason === "prompt-echo-similar")
  );
}
