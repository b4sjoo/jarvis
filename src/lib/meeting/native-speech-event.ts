export interface NativeSpeechStartEvent {
  captureSessionId: string;
  captureGeneration: number;
  candidateSegmentSequence: number;
  owner: "meeting" | "system";
  source: "system-audio";
  occurredAtMs: number;
  sampleRate: number;
}

export interface NativeSpeechDetectedEvent {
  captureSessionId: string;
  captureGeneration: number;
  segmentSequence: number;
  owner: "meeting" | "system";
  capturedAtMs: number;
  speechStartedAtMs: number;
  speechEndedAtMs: number;
  segmentEmittedAtMs: number;
  sampleStart: number;
  sampleEnd: number;
  sampleRate: number;
  durationMs: number;
  endReason:
    | "silence"
    | "forced-rollover"
    | "stop-drain"
    | "termination-drain"
    | "continuous-stop";
  rolloverFamilyId?: string;
  overlapSampleCount: number;
  overlapDurationMs: number;
  vadSilenceTargetSamples: number;
  vadMinimumSpeechSamples: number;
  vadPreSpeechSamples: number;
  vadMaximumSegmentSamples: number;
  mediaType: "audio/wav";
  audioBase64: string;
}

export type NativeSpeechStartEventRejectionReason =
  | "invalid-envelope"
  | "no-active-native-session"
  | "capture-session-mismatch"
  | "capture-owner-mismatch"
  | "capture-generation-mismatch"
  | "capture-source-mismatch"
  | "non-monotonic-candidate";

export type NativeSpeechStartEventAuthorization =
  | {
      authorized: true;
      event: NativeSpeechStartEvent;
    }
  | {
      authorized: false;
      reason: NativeSpeechStartEventRejectionReason;
      event?: NativeSpeechStartEvent;
    };

export type NativeSpeechEventRejectionReason =
  | "invalid-envelope"
  | "no-active-native-session"
  | "capture-session-mismatch"
  | "capture-owner-mismatch"
  | "capture-generation-mismatch"
  | "duplicate-sequence"
  | "non-monotonic-sequence";

export type NativeSpeechEventAuthorization =
  | {
      authorized: true;
      event: NativeSpeechDetectedEvent;
    }
  | {
      authorized: false;
      reason: NativeSpeechEventRejectionReason;
      event?: NativeSpeechDetectedEvent;
    };

export function parseNativeSpeechDetectedEvent(
  payload: unknown
): NativeSpeechDetectedEvent | null {
  if (!isRecord(payload)) return null;

  const captureSessionId = payload.captureSessionId;
  const segmentSequence = payload.segmentSequence;
  const captureGeneration = payload.captureGeneration;
  const capturedAtMs = payload.capturedAtMs;
  const speechStartedAtMs = payload.speechStartedAtMs;
  const speechEndedAtMs = payload.speechEndedAtMs;
  const segmentEmittedAtMs = payload.segmentEmittedAtMs;
  const sampleStart = payload.sampleStart;
  const sampleEnd = payload.sampleEnd;
  const sampleRate = payload.sampleRate;
  const durationMs = payload.durationMs;
  const overlapSampleCount = payload.overlapSampleCount;
  const overlapDurationMs = payload.overlapDurationMs;
  const vadSilenceTargetSamples = payload.vadSilenceTargetSamples;
  const vadMinimumSpeechSamples = payload.vadMinimumSpeechSamples;
  const vadPreSpeechSamples = payload.vadPreSpeechSamples;
  const vadMaximumSegmentSamples = payload.vadMaximumSegmentSamples;
  const audioBase64 = payload.audioBase64;

  if (
    typeof captureSessionId !== "string" ||
    !captureSessionId.trim() ||
    !Number.isSafeInteger(captureGeneration) ||
    (captureGeneration as number) < 1 ||
    !Number.isSafeInteger(segmentSequence) ||
    (segmentSequence as number) < 1 ||
    (payload.owner !== "meeting" && payload.owner !== "system") ||
    !Number.isSafeInteger(capturedAtMs) ||
    (capturedAtMs as number) < 0 ||
    !Number.isSafeInteger(speechStartedAtMs) ||
    (speechStartedAtMs as number) < 0 ||
    !Number.isSafeInteger(speechEndedAtMs) ||
    (speechEndedAtMs as number) < (speechStartedAtMs as number) ||
    !Number.isSafeInteger(segmentEmittedAtMs) ||
    (segmentEmittedAtMs as number) < 0 ||
    !Number.isSafeInteger(sampleStart) ||
    (sampleStart as number) < 0 ||
    !Number.isSafeInteger(sampleEnd) ||
    (sampleEnd as number) <= (sampleStart as number) ||
    !Number.isSafeInteger(sampleRate) ||
    (sampleRate as number) < 8_000 ||
    (sampleRate as number) > 96_000 ||
    !Number.isSafeInteger(durationMs) ||
    (durationMs as number) < 1 ||
    !isNativeSegmentEndReason(payload.endReason) ||
    (payload.rolloverFamilyId !== undefined &&
      (typeof payload.rolloverFamilyId !== "string" ||
        !payload.rolloverFamilyId.trim())) ||
    !Number.isSafeInteger(overlapSampleCount) ||
    (overlapSampleCount as number) < 0 ||
    !Number.isSafeInteger(overlapDurationMs) ||
    (overlapDurationMs as number) < 0 ||
    !Number.isSafeInteger(vadSilenceTargetSamples) ||
    (vadSilenceTargetSamples as number) < 0 ||
    !Number.isSafeInteger(vadMinimumSpeechSamples) ||
    (vadMinimumSpeechSamples as number) < 0 ||
    !Number.isSafeInteger(vadPreSpeechSamples) ||
    (vadPreSpeechSamples as number) < 0 ||
    !Number.isSafeInteger(vadMaximumSegmentSamples) ||
    (vadMaximumSegmentSamples as number) < 1 ||
    payload.mediaType !== "audio/wav" ||
    typeof audioBase64 !== "string" ||
    !audioBase64
  ) {
    return null;
  }

  return {
    captureSessionId,
    captureGeneration: captureGeneration as number,
    segmentSequence: segmentSequence as number,
    owner: payload.owner,
    capturedAtMs: capturedAtMs as number,
    speechStartedAtMs: speechStartedAtMs as number,
    speechEndedAtMs: speechEndedAtMs as number,
    segmentEmittedAtMs: segmentEmittedAtMs as number,
    sampleStart: sampleStart as number,
    sampleEnd: sampleEnd as number,
    sampleRate: sampleRate as number,
    durationMs: durationMs as number,
    endReason: payload.endReason,
    rolloverFamilyId: payload.rolloverFamilyId as string | undefined,
    overlapSampleCount: overlapSampleCount as number,
    overlapDurationMs: overlapDurationMs as number,
    vadSilenceTargetSamples: vadSilenceTargetSamples as number,
    vadMinimumSpeechSamples: vadMinimumSpeechSamples as number,
    vadPreSpeechSamples: vadPreSpeechSamples as number,
    vadMaximumSegmentSamples: vadMaximumSegmentSamples as number,
    mediaType: "audio/wav",
    audioBase64,
  };
}

export function parseNativeSpeechStartEvent(
  payload: unknown
): NativeSpeechStartEvent | null {
  if (!isRecord(payload)) return null;

  const captureSessionId = payload.captureSessionId;
  const captureGeneration = payload.captureGeneration;
  const candidateSegmentSequence = payload.candidateSegmentSequence;
  const occurredAtMs = payload.occurredAtMs;
  const sampleRate = payload.sampleRate;

  if (
    typeof captureSessionId !== "string" ||
    !captureSessionId.trim() ||
    !Number.isSafeInteger(captureGeneration) ||
    (captureGeneration as number) < 1 ||
    !Number.isSafeInteger(candidateSegmentSequence) ||
    (candidateSegmentSequence as number) < 1 ||
    (payload.owner !== "meeting" && payload.owner !== "system") ||
    payload.source !== "system-audio" ||
    !Number.isSafeInteger(occurredAtMs) ||
    (occurredAtMs as number) < 0 ||
    !Number.isSafeInteger(sampleRate) ||
    (sampleRate as number) < 8_000 ||
    (sampleRate as number) > 96_000
  ) {
    return null;
  }

  return {
    captureSessionId,
    captureGeneration: captureGeneration as number,
    candidateSegmentSequence: candidateSegmentSequence as number,
    owner: payload.owner,
    source: "system-audio",
    occurredAtMs: occurredAtMs as number,
    sampleRate: sampleRate as number,
  };
}

export function authorizeNativeSpeechStartEvent({
  payload,
  activeCaptureSessionId,
  activeCaptureGeneration,
  lastObservedCandidateSequence,
  expectedOwner,
  expectedSource,
}: {
  payload: unknown;
  activeCaptureSessionId: string | null;
  activeCaptureGeneration?: number | null;
  lastObservedCandidateSequence: number;
  expectedOwner?: NativeSpeechStartEvent["owner"];
  expectedSource?: NativeSpeechStartEvent["source"];
}): NativeSpeechStartEventAuthorization {
  const event = parseNativeSpeechStartEvent(payload);
  if (!event) {
    return { authorized: false, reason: "invalid-envelope" };
  }
  if (!activeCaptureSessionId) {
    return {
      authorized: false,
      reason: "no-active-native-session",
      event,
    };
  }
  if (event.captureSessionId !== activeCaptureSessionId) {
    return {
      authorized: false,
      reason: "capture-session-mismatch",
      event,
    };
  }
  if (expectedOwner && event.owner !== expectedOwner) {
    return {
      authorized: false,
      reason: "capture-owner-mismatch",
      event,
    };
  }
  if (
    activeCaptureGeneration != null &&
    event.captureGeneration !== activeCaptureGeneration
  ) {
    return {
      authorized: false,
      reason: "capture-generation-mismatch",
      event,
    };
  }
  if (expectedSource && event.source !== expectedSource) {
    return {
      authorized: false,
      reason: "capture-source-mismatch",
      event,
    };
  }
  if (event.candidateSegmentSequence <= lastObservedCandidateSequence) {
    return {
      authorized: false,
      reason: "non-monotonic-candidate",
      event,
    };
  }
  return { authorized: true, event };
}

export function authorizeNativeSpeechDetectedEvent({
  payload,
  activeCaptureSessionId,
  lastAcceptedSequence,
  expectedOwner,
  activeCaptureGeneration,
}: {
  payload: unknown;
  activeCaptureSessionId: string | null;
  lastAcceptedSequence: number;
  expectedOwner?: NativeSpeechDetectedEvent["owner"];
  activeCaptureGeneration?: number | null;
}): NativeSpeechEventAuthorization {
  const event = parseNativeSpeechDetectedEvent(payload);
  if (!event) {
    return { authorized: false, reason: "invalid-envelope" };
  }
  if (!activeCaptureSessionId) {
    return {
      authorized: false,
      reason: "no-active-native-session",
      event,
    };
  }
  if (event.captureSessionId !== activeCaptureSessionId) {
    return {
      authorized: false,
      reason: "capture-session-mismatch",
      event,
    };
  }
  if (expectedOwner && event.owner !== expectedOwner) {
    return {
      authorized: false,
      reason: "capture-owner-mismatch",
      event,
    };
  }
  if (
    activeCaptureGeneration != null &&
    event.captureGeneration !== activeCaptureGeneration
  ) {
    return {
      authorized: false,
      reason: "capture-generation-mismatch",
      event,
    };
  }
  if (event.segmentSequence === lastAcceptedSequence) {
    return {
      authorized: false,
      reason: "duplicate-sequence",
      event,
    };
  }
  if (event.segmentSequence < lastAcceptedSequence) {
    return {
      authorized: false,
      reason: "non-monotonic-sequence",
      event,
    };
  }
  return { authorized: true, event };
}

export function buildNativeSpeechEventTraceMetadata(
  event: NativeSpeechDetectedEvent
) {
  return {
    nativeCaptureSessionId: event.captureSessionId,
    nativeCaptureGeneration: event.captureGeneration,
    nativeSegmentSequence: event.segmentSequence,
    nativeCapturedAtMs: event.capturedAtMs,
    nativeSpeechStartedAtMs: event.speechStartedAtMs,
    nativeSpeechEndedAtMs: event.speechEndedAtMs,
    nativeSegmentEmittedAtMs: event.segmentEmittedAtMs,
    nativeSampleStart: event.sampleStart,
    nativeSampleEnd: event.sampleEnd,
    nativeSampleRate: event.sampleRate,
    nativeDurationMs: event.durationMs,
    nativeSegmentEndReason: event.endReason,
    nativeRolloverFamilyId: event.rolloverFamilyId,
    nativeOverlapSampleCount: event.overlapSampleCount,
    nativeOverlapDurationMs: event.overlapDurationMs,
    nativeVadSilenceTargetSamples: event.vadSilenceTargetSamples,
    nativeVadMinimumSpeechSamples: event.vadMinimumSpeechSamples,
    nativeVadPreSpeechSamples: event.vadPreSpeechSamples,
    nativeVadMaximumSegmentSamples: event.vadMaximumSegmentSamples,
    nativeMediaType: event.mediaType,
    audioBase64Chars: event.audioBase64.length,
  };
}

export function buildNativeSpeechStartTraceMetadata(
  event: NativeSpeechStartEvent,
  observedAtMs?: number
) {
  return {
    nativeSpeechEventType: "speech-start",
    nativeCaptureSessionId: event.captureSessionId,
    nativeCaptureGeneration: event.captureGeneration,
    nativeCandidateSegmentSequence: event.candidateSegmentSequence,
    nativeCaptureOwner: event.owner,
    nativeSpeechSource: event.source,
    nativeSpeechStartedAtMs: event.occurredAtMs,
    nativeSpeechStartObservedAtMs: observedAtMs,
    nativeSampleRate: event.sampleRate,
  };
}

function isNativeSegmentEndReason(
  value: unknown
): value is NativeSpeechDetectedEvent["endReason"] {
  return (
    value === "silence" ||
    value === "forced-rollover" ||
    value === "stop-drain" ||
    value === "termination-drain" ||
    value === "continuous-stop"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
