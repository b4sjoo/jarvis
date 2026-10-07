export interface NativeSpeechStartEvent {
  captureSessionId: string;
  captureGeneration: number;
  candidateSegmentSequence: number;
  owner: "meeting" | "system";
  source: "system-audio";
  occurredAtMs: number;
  sampleRate: number;
}

export interface NativeAudioDeliveryTiming {
  rawReadyAtMs: number;
  encodeStartedAtMs: number;
  encodedAtMs: number;
  encodeDurationMicros: number;
  emitStartedAtMs: number;
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
    | "format-boundary"
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
  deliveryTiming?: NativeAudioDeliveryTiming;
  // Stamped at the JS event callback, never read from the native payload.
  jsReceivedAtMs?: number;
}

export function parseNativeAudioDeliveryTiming(value: unknown): NativeAudioDeliveryTiming | undefined {
  if (!isRecord(value)) return undefined;
  const fields = ["rawReadyAtMs", "encodeStartedAtMs", "encodedAtMs", "encodeDurationMicros", "emitStartedAtMs"] as const;
  if (fields.some((key) => !Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) return undefined;
  return Object.fromEntries(fields.map((key) => [key, value[key]])) as unknown as NativeAudioDeliveryTiming;
}

export function parseNativeAudioObservation(payload: unknown) {
  if (!isRecord(payload) || typeof payload.captureSessionId !== "string" || !payload.captureSessionId ||
      !Number.isSafeInteger(payload.captureGeneration) || (payload.captureGeneration as number) < 1 ||
      payload.owner !== "meeting") return null;
  const identity = { nativeCaptureSessionId: payload.captureSessionId,
    nativeCaptureGeneration: payload.captureGeneration as number, nativeCaptureOwner: payload.owner };
  if (payload.stage === "segment-delivery") {
    const timing = parseNativeAudioDeliveryTiming(payload.deliveryTiming);
    if (!timing || !Number.isSafeInteger(payload.segmentSequence) || (payload.segmentSequence as number) < 1 ||
        !Number.isSafeInteger(payload.emitFinishedAtMs) || (payload.emitFinishedAtMs as number) < 0 ||
        !Number.isSafeInteger(payload.emitDurationMicros) || (payload.emitDurationMicros as number) < 0 ||
        typeof payload.emitSucceeded !== "boolean") return null;
    return { ...identity, stage: "native-segment-delivery", nativeSegmentSequence: payload.segmentSequence,
      nativeDeliveryTiming: timing, nativeEmitFinishedAtMs: payload.emitFinishedAtMs,
      nativeEmitDurationMicros: payload.emitDurationMicros, nativeEmitSucceeded: payload.emitSucceeded,
      nativeEmitError: typeof payload.emitError === "string" ? payload.emitError.slice(0, 512) : undefined };
  }
  if (payload.stage === "capture-format") {
    const route = isRecord(payload.actualRoute) ? payload.actualRoute : {};
    const text = (value: unknown) => typeof value === "string" ? value.slice(0, 512) : undefined;
    return { ...identity, stage: "native-capture-format", occurredAtMs: payload.occurredAtMs,
      requestedDeviceId: text(payload.requestedDeviceId),
      actualRoute: { outputUid: text(route.outputUid), aggregateUid: text(route.aggregateUid),
        tapUid: text(route.tapUid), audioFormat: text(route.audioFormat) } };
  }
  if (payload.stage === "audio-timebase-span") {
    if (!Number.isSafeInteger(payload.sampleRate) || (payload.sampleRate as number) < 8000 ||
        (payload.sampleRate as number) > 96000 || !Number.isSafeInteger(payload.sampleStart) ||
        (payload.sampleStart as number) < 0 || !Number.isSafeInteger(payload.sourceStartedAtMs) ||
        (payload.sourceStartedAtMs as number) < 0 || !Number.isSafeInteger(payload.occurredAtMs) ||
        (payload.occurredAtMs as number) < 0 || typeof payload.reason !== "string" ||
        !payload.reason || (payload.timeBasis !== "native-input-clock" && payload.timeBasis !== "capture-start-proxy") ||
        (payload.sourceGapMs !== null && (typeof payload.sourceGapMs !== "number" || !Number.isFinite(payload.sourceGapMs)))) return null;
    return { ...identity, stage: "native-audio-timebase-span", occurredAtMs: payload.occurredAtMs,
      sampleRate: payload.sampleRate, sampleStart: payload.sampleStart, sourceStartedAtMs: payload.sourceStartedAtMs,
      timeBasis: payload.timeBasis, reason: payload.reason.slice(0, 128), sourceGapMs: payload.sourceGapMs };
  }
  return null;
}

// Wall-clock deltas are same-host observations, not monotonic durations. Missing
// or reversed clocks remain unknown rather than being reported as zero latency.
export function measureNativeAudioDelivery(input: {
  timing?: NativeAudioDeliveryTiming;
  emitDurationMicros?: number;
  jsReceivedAtMs?: number;
  queuedAtMs?: number;
  dequeuedAtMs?: number;
}) {
  const delta = (end?: number, start?: number) => end != null && start != null && end >= start ? end - start : undefined;
  return {
    rawReadyToEncodeMs: delta(input.timing?.encodeStartedAtMs, input.timing?.rawReadyAtMs),
    encodeDurationMs: input.timing == null ? undefined : input.timing.encodeDurationMicros / 1000,
    nativeEmitDurationMs: input.emitDurationMicros == null ? undefined : input.emitDurationMicros / 1000,
    emitStartToJsMs: delta(input.jsReceivedAtMs, input.timing?.emitStartedAtMs),
    jsToEnqueueMs: delta(input.queuedAtMs, input.jsReceivedAtMs),
    queueWaitMs: delta(input.dequeuedAtMs, input.queuedAtMs),
  };
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

  const deliveryTiming = parseNativeAudioDeliveryTiming(payload.deliveryTiming);
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
    ...(deliveryTiming ? { deliveryTiming } : {}),
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
    nativeDeliveryTiming: event.deliveryTiming,
    nativeJsReceivedAtMs: event.jsReceivedAtMs,
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
    value === "format-boundary" ||
    value === "continuous-stop"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
