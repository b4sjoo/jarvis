export type NativeAudioCaptureOwner = "meeting" | "system";
export type NativeAudioLifecycleEventType = "started" | "stopped" | "error";

export interface NativeAudioLifecycleEvent {
  eventType: NativeAudioLifecycleEventType;
  captureSessionId: string;
  captureGeneration: number;
  owner: NativeAudioCaptureOwner;
  occurredAtMs: number;
  reason: string | null;
  message: string | null;
  sampleRate: number | null;
}

export type NativeAudioLifecycleRejectionReason =
  | "invalid-envelope"
  | "capture-owner-mismatch"
  | "no-active-native-session"
  | "capture-session-mismatch"
  | "capture-generation-mismatch";

export type NativeAudioLifecycleAuthorization =
  | { authorized: true; event: NativeAudioLifecycleEvent }
  | {
      authorized: false;
      reason: NativeAudioLifecycleRejectionReason;
      event?: NativeAudioLifecycleEvent;
    };

export function parseNativeAudioLifecycleEvent(
  payload: unknown
): NativeAudioLifecycleEvent | null {
  if (!isRecord(payload)) return null;
  const eventType = payload.eventType;
  const owner = payload.owner;
  const captureSessionId = payload.captureSessionId;
  const captureGeneration = payload.captureGeneration;
  const occurredAtMs = payload.occurredAtMs;
  const sampleRate = payload.sampleRate;
  const reason = payload.reason;
  const message = payload.message;

  if (
    (eventType !== "started" &&
      eventType !== "stopped" &&
      eventType !== "error") ||
    (owner !== "meeting" && owner !== "system") ||
    typeof captureSessionId !== "string" ||
    !captureSessionId.trim() ||
    !Number.isSafeInteger(captureGeneration) ||
    (captureGeneration as number) < 1 ||
    !Number.isSafeInteger(occurredAtMs) ||
    (occurredAtMs as number) < 0 ||
    (sampleRate !== null &&
      (!Number.isSafeInteger(sampleRate) ||
        (sampleRate as number) < 8_000 ||
        (sampleRate as number) > 96_000)) ||
    (reason !== null && typeof reason !== "string") ||
    (message !== null && typeof message !== "string")
  ) {
    return null;
  }

  return {
    eventType,
    captureSessionId,
    captureGeneration: captureGeneration as number,
    owner,
    occurredAtMs: occurredAtMs as number,
    reason,
    message,
    sampleRate: sampleRate as number | null,
  };
}

export function authorizeNativeAudioLifecycleEvent({
  payload,
  expectedOwner,
  activeCaptureSessionId,
  activeCaptureGeneration,
}: {
  payload: unknown;
  expectedOwner: NativeAudioCaptureOwner;
  activeCaptureSessionId: string | null;
  activeCaptureGeneration: number | null;
}): NativeAudioLifecycleAuthorization {
  const event = parseNativeAudioLifecycleEvent(payload);
  if (!event) return { authorized: false, reason: "invalid-envelope" };
  if (event.owner !== expectedOwner) {
    return {
      authorized: false,
      reason: "capture-owner-mismatch",
      event,
    };
  }
  if (!activeCaptureSessionId || activeCaptureGeneration == null) {
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
  if (event.captureGeneration !== activeCaptureGeneration) {
    return {
      authorized: false,
      reason: "capture-generation-mismatch",
      event,
    };
  }
  return { authorized: true, event };
}

export function buildNativeAudioLifecycleTraceMetadata(
  event: NativeAudioLifecycleEvent
) {
  return {
    nativeAudioEventType: event.eventType,
    nativeCaptureOwner: event.owner,
    nativeCaptureSessionId: event.captureSessionId,
    nativeCaptureGeneration: event.captureGeneration,
    nativeAudioOccurredAtMs: event.occurredAtMs,
    nativeAudioReason: event.reason,
    nativeAudioMessage: event.message,
    nativeSampleRate: event.sampleRate,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
