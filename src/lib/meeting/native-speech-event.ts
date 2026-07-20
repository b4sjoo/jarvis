export interface NativeSpeechDetectedEvent {
  captureSessionId: string;
  segmentSequence: number;
  owner: "system";
  capturedAtMs: number;
  sampleRate: number;
  mediaType: "audio/wav";
  audioBase64: string;
}

export type NativeSpeechEventRejectionReason =
  | "invalid-envelope"
  | "no-active-native-session"
  | "capture-session-mismatch"
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
  const capturedAtMs = payload.capturedAtMs;
  const sampleRate = payload.sampleRate;
  const audioBase64 = payload.audioBase64;

  if (
    typeof captureSessionId !== "string" ||
    !captureSessionId.trim() ||
    !Number.isSafeInteger(segmentSequence) ||
    (segmentSequence as number) < 1 ||
    payload.owner !== "system" ||
    !Number.isSafeInteger(capturedAtMs) ||
    (capturedAtMs as number) < 0 ||
    !Number.isSafeInteger(sampleRate) ||
    (sampleRate as number) < 8_000 ||
    (sampleRate as number) > 96_000 ||
    payload.mediaType !== "audio/wav" ||
    typeof audioBase64 !== "string" ||
    !audioBase64
  ) {
    return null;
  }

  return {
    captureSessionId,
    segmentSequence: segmentSequence as number,
    owner: "system",
    capturedAtMs: capturedAtMs as number,
    sampleRate: sampleRate as number,
    mediaType: "audio/wav",
    audioBase64,
  };
}

export function authorizeNativeSpeechDetectedEvent({
  payload,
  activeCaptureSessionId,
  lastAcceptedSequence,
}: {
  payload: unknown;
  activeCaptureSessionId: string | null;
  lastAcceptedSequence: number;
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
  if (event.segmentSequence <= lastAcceptedSequence) {
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
    nativeSegmentSequence: event.segmentSequence,
    nativeCapturedAtMs: event.capturedAtMs,
    nativeSampleRate: event.sampleRate,
    nativeMediaType: event.mediaType,
    audioBase64Chars: event.audioBase64.length,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
