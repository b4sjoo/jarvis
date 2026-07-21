import type {
  MeetingAssistantStatus,
  NativeAudioDebugFaultKind,
  NativeAudioManualRecoveryState,
} from "./types.js";

export type NativeAudioCaptureOwner = "meeting" | "system";
export type NativeAudioLifecycleEventType = "started" | "stopped" | "error";
export type NativeAudioRecoverability =
  | "not-applicable"
  | "retry-once"
  | "manual";

export interface NativeAudioTerminationDiagnostics {
  droppedSamples: number;
  consecutiveDrops: number;
  bufferCapacity: number | null;
  faultInjected: boolean;
  faultInjectionId: string | null;
  faultKind: NativeAudioDebugFaultKind | null;
}

export interface NativeAudioLifecycleEvent {
  eventType: NativeAudioLifecycleEventType;
  captureSessionId: string;
  captureGeneration: number;
  owner: NativeAudioCaptureOwner;
  occurredAtMs: number;
  reason: string | null;
  message: string | null;
  sampleRate: number | null;
  expected: boolean;
  recoverability: NativeAudioRecoverability;
  diagnostics: NativeAudioTerminationDiagnostics;
}

export interface NativeAudioSegmentDroppedEvent {
  captureSessionId: string;
  captureGeneration: number;
  attemptedSegmentSequence: number;
  owner: NativeAudioCaptureOwner;
  occurredAtMs: number;
  reason: string;
  message: string;
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

export type NativeAudioTerminalDisposition =
  | "expected-stop"
  | "recovering"
  | "fatal";

export type NativeAudioCaptureStartMode =
  | "fresh-start"
  | "resume"
  | "automatic-recovery"
  | "manual-recovery";

export interface NativeAudioCaptureStartPolicy {
  lifecycleAction: "start" | "resume";
  resetContext: boolean;
  resetRecoveryBudget: boolean;
  pendingStatus: "starting" | "reconnecting";
}

export type NativeAudioPrimaryControlAction =
  | "start"
  | "stop"
  | "resume"
  | "manual-recovery";

export function getNativeAudioCaptureStartPolicy(
  mode: NativeAudioCaptureStartMode
): NativeAudioCaptureStartPolicy {
  switch (mode) {
    case "fresh-start":
      return {
        lifecycleAction: "start",
        resetContext: true,
        resetRecoveryBudget: true,
        pendingStatus: "starting",
      };
    case "automatic-recovery":
      return {
        lifecycleAction: "resume",
        resetContext: false,
        resetRecoveryBudget: false,
        pendingStatus: "reconnecting",
      };
    case "manual-recovery":
      return {
        lifecycleAction: "resume",
        resetContext: false,
        resetRecoveryBudget: true,
        pendingStatus: "reconnecting",
      };
    case "resume":
      return {
        lifecycleAction: "resume",
        resetContext: false,
        resetRecoveryBudget: false,
        pendingStatus: "starting",
      };
  }
}

export function resolveNativeAudioPrimaryControlAction({
  status,
  manualRecoveryRequired,
}: {
  status: MeetingAssistantStatus;
  manualRecoveryRequired: boolean;
}): NativeAudioPrimaryControlAction {
  if (status === "error" && manualRecoveryRequired) return "manual-recovery";
  if (status === "paused") return "resume";
  if (
    status === "starting" ||
    status === "reconnecting" ||
    status === "listening" ||
    status === "transcribing" ||
    status === "thinking"
  ) {
    return "stop";
  }
  return "start";
}

export function createNativeAudioManualRecoveryState({
  event,
  circuitBreakerOpen,
  requiredAt,
}: {
  event: NativeAudioLifecycleEvent;
  circuitBreakerOpen: boolean;
  requiredAt: number;
}): NativeAudioManualRecoveryState {
  return {
    requiredAt,
    reason: event.reason,
    message: event.message,
    interruptedCaptureSessionId: event.captureSessionId,
    interruptedCaptureGeneration: event.captureGeneration,
    circuitBreakerOpen,
  };
}

export function decideNativeAudioTerminalDisposition(
  event: NativeAudioLifecycleEvent,
  automaticRecoveryAvailable: boolean
): NativeAudioTerminalDisposition {
  if (event.expected || event.recoverability === "not-applicable") {
    return "expected-stop";
  }
  if (
    event.recoverability === "retry-once" &&
    automaticRecoveryAvailable
  ) {
    return "recovering";
  }
  return "fatal";
}

export function pruneNativeAudioRecoveryAttempts(
  attempts: number[],
  now: number,
  windowMs: number
) {
  return attempts.filter(
    (attemptedAt) =>
      Number.isFinite(attemptedAt) &&
      attemptedAt <= now &&
      now - attemptedAt < windowMs
  );
}

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
  const expected = payload.expected;
  const recoverability = payload.recoverability;
  const diagnostics = payload.diagnostics;
  const faultInjected = isRecord(diagnostics)
    ? diagnostics.faultInjected ?? false
    : false;
  const faultInjectionId = isRecord(diagnostics)
    ? diagnostics.faultInjectionId ?? null
    : null;
  const faultKind = isRecord(diagnostics)
    ? diagnostics.faultKind ?? null
    : null;

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
    (message !== null && typeof message !== "string") ||
    typeof expected !== "boolean" ||
    (recoverability !== "not-applicable" &&
      recoverability !== "retry-once" &&
      recoverability !== "manual") ||
    !isRecord(diagnostics) ||
    !Number.isSafeInteger(diagnostics.droppedSamples) ||
    (diagnostics.droppedSamples as number) < 0 ||
    !Number.isSafeInteger(diagnostics.consecutiveDrops) ||
    (diagnostics.consecutiveDrops as number) < 0 ||
    (diagnostics.bufferCapacity !== null &&
      (!Number.isSafeInteger(diagnostics.bufferCapacity) ||
        (diagnostics.bufferCapacity as number) < 1)) ||
    typeof faultInjected !== "boolean" ||
    (faultInjectionId !== null &&
      (typeof faultInjectionId !== "string" || !faultInjectionId.trim())) ||
    (faultKind !== null &&
      faultKind !== "recoverable-stream-end" &&
      faultKind !== "fatal-capture-failure") ||
    (!faultInjected && (faultInjectionId !== null || faultKind !== null)) ||
    (faultInjected && (faultInjectionId === null || faultKind === null))
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
    expected,
    recoverability,
    diagnostics: {
      droppedSamples: diagnostics.droppedSamples as number,
      consecutiveDrops: diagnostics.consecutiveDrops as number,
      bufferCapacity: diagnostics.bufferCapacity as number | null,
      faultInjected,
      faultInjectionId: faultInjectionId as string | null,
      faultKind: faultKind as NativeAudioDebugFaultKind | null,
    },
  };
}

export function parseNativeAudioSegmentDroppedEvent(
  payload: unknown
): NativeAudioSegmentDroppedEvent | null {
  if (!isRecord(payload)) return null;
  const {
    captureSessionId,
    captureGeneration,
    attemptedSegmentSequence,
    owner,
    occurredAtMs,
    reason,
    message,
  } = payload;
  if (
    typeof captureSessionId !== "string" ||
    !captureSessionId.trim() ||
    !Number.isSafeInteger(captureGeneration) ||
    (captureGeneration as number) < 1 ||
    !Number.isSafeInteger(attemptedSegmentSequence) ||
    (attemptedSegmentSequence as number) < 1 ||
    (owner !== "meeting" && owner !== "system") ||
    !Number.isSafeInteger(occurredAtMs) ||
    (occurredAtMs as number) < 0 ||
    typeof reason !== "string" ||
    !reason.trim() ||
    typeof message !== "string"
  ) {
    return null;
  }
  return {
    captureSessionId,
    captureGeneration: captureGeneration as number,
    attemptedSegmentSequence: attemptedSegmentSequence as number,
    owner,
    occurredAtMs: occurredAtMs as number,
    reason,
    message,
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
    nativeAudioExpected: event.expected,
    nativeAudioRecoverability: event.recoverability,
    nativeAudioDroppedSamples: event.diagnostics.droppedSamples,
    nativeAudioConsecutiveDrops: event.diagnostics.consecutiveDrops,
    nativeAudioBufferCapacity: event.diagnostics.bufferCapacity,
    nativeAudioFaultInjected: event.diagnostics.faultInjected,
    nativeAudioFaultInjectionId: event.diagnostics.faultInjectionId,
    nativeAudioFaultKind: event.diagnostics.faultKind,
    productionReliabilityEligible: !event.diagnostics.faultInjected,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
