export type NativeCaptureOwner = "call" | "system";

export const NATIVE_CALL_AUDIO_EVENTS = {
  segment: "speech-detected",
  speechStart: "speech-start",
  liveness: "native-audio-liveness",
  segmentDropped: "native-audio-segment-dropped",
  lifecycle: "native-audio-lifecycle",
} as const;

export interface NativeOwnedAudioEvent {
  captureSessionId: string;
  captureGeneration: number;
  owner: NativeCaptureOwner;
  occurredAtMs: number;
}

export type NativeOwnedAudioAuthorization =
  | { authorized: true; event: NativeOwnedAudioEvent }
  | {
      authorized: false;
      reason:
        | "invalid-payload"
        | "capture-session-mismatch"
        | "capture-generation-mismatch"
        | "owner-mismatch";
      event?: NativeOwnedAudioEvent;
    };

export function authorizeNativeOwnedAudioEvent(input: {
  payload: unknown;
  activeCaptureSessionId: string;
  activeCaptureGeneration: number;
  expectedOwner: NativeCaptureOwner;
}): NativeOwnedAudioAuthorization {
  if (!input.payload || typeof input.payload !== "object") {
    return { authorized: false, reason: "invalid-payload" };
  }
  const candidate = input.payload as Partial<NativeOwnedAudioEvent>;
  if (
    typeof candidate.captureSessionId !== "string" ||
    !Number.isSafeInteger(candidate.captureGeneration) ||
    (candidate.owner !== "call" && candidate.owner !== "system") ||
    typeof candidate.occurredAtMs !== "number"
  ) {
    return { authorized: false, reason: "invalid-payload" };
  }
  const event = candidate as NativeOwnedAudioEvent;
  if (event.captureSessionId !== input.activeCaptureSessionId) {
    return { authorized: false, reason: "capture-session-mismatch", event };
  }
  if (event.captureGeneration !== input.activeCaptureGeneration) {
    return { authorized: false, reason: "capture-generation-mismatch", event };
  }
  if (event.owner !== input.expectedOwner) {
    return { authorized: false, reason: "owner-mismatch", event };
  }
  return { authorized: true, event };
}

export interface AudioSegmentIdentity {
  captureSessionId: string;
  captureGeneration: number;
  segmentSequence: number;
}

export interface NativeSpeechSegment extends AudioSegmentIdentity {
  owner: NativeCaptureOwner;
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
  mediaType: "audio/wav";
  audioBase64: string;
}

export type NativeSpeechAuthorization =
  | { authorized: true; event: NativeSpeechSegment }
  | {
      authorized: false;
      reason:
        | "invalid-payload"
        | "capture-session-mismatch"
        | "capture-generation-mismatch"
        | "owner-mismatch"
        | "stale-sequence";
      event?: NativeSpeechSegment;
    };

export function authorizeNativeSpeechSegment(input: {
  payload: unknown;
  activeCaptureSessionId: string;
  activeCaptureGeneration: number;
  lastAcceptedSequence: number;
  expectedOwner: NativeCaptureOwner;
}): NativeSpeechAuthorization {
  const event = parseNativeSpeechSegment(input.payload);
  if (!event) return { authorized: false, reason: "invalid-payload" };
  if (event.captureSessionId !== input.activeCaptureSessionId) {
    return { authorized: false, reason: "capture-session-mismatch", event };
  }
  if (event.captureGeneration !== input.activeCaptureGeneration) {
    return { authorized: false, reason: "capture-generation-mismatch", event };
  }
  if (event.owner !== input.expectedOwner) {
    return { authorized: false, reason: "owner-mismatch", event };
  }
  if (event.segmentSequence <= input.lastAcceptedSequence) {
    return { authorized: false, reason: "stale-sequence", event };
  }
  return { authorized: true, event };
}

function parseNativeSpeechSegment(payload: unknown): NativeSpeechSegment | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Partial<NativeSpeechSegment>;
  const validOwner = value.owner === "call" || value.owner === "system";
  const validEndReason = [
    "silence",
    "forced-rollover",
    "stop-drain",
    "termination-drain",
    "continuous-stop",
  ].includes(String(value.endReason));
  if (
    typeof value.captureSessionId !== "string" ||
    !Number.isSafeInteger(value.captureGeneration) ||
    !Number.isSafeInteger(value.segmentSequence) ||
    !validOwner ||
    !validEndReason ||
    value.mediaType !== "audio/wav" ||
    typeof value.audioBase64 !== "string"
  ) {
    return null;
  }
  return value as NativeSpeechSegment;
}

export type AudioSegmentDisposition = "accepted" | "stale" | "duplicate" | "failed";

interface AudioSegmentLedgerEntry {
  identity: AudioSegmentIdentity;
  observedAt: number;
  duplicateObservationCount: number;
  disposition?: AudioSegmentDisposition;
  settledAt?: number;
}

const segmentKey = (identity: AudioSegmentIdentity) =>
  `${identity.captureSessionId}:${identity.captureGeneration}:${identity.segmentSequence}`;

export class AudioSegmentDispositionLedger {
  readonly #entries = new Map<string, AudioSegmentLedgerEntry>();

  observe(input: { identity: AudioSegmentIdentity; observedAt: number }): void {
    const key = segmentKey(input.identity);
    const current = this.#entries.get(key);
    if (current) {
      current.duplicateObservationCount += 1;
      return;
    }
    this.#entries.set(key, {
      identity: { ...input.identity },
      observedAt: input.observedAt,
      duplicateObservationCount: 0,
    });
  }

  settle(input: {
    identity: AudioSegmentIdentity;
    disposition: AudioSegmentDisposition;
    settledAt: number;
  }): {
    canonicalCommitted: boolean;
    canonicalDisposition: AudioSegmentDisposition;
    duplicateObservationCount: number;
  } {
    const key = segmentKey(input.identity);
    const entry = this.#entries.get(key) ?? {
      identity: { ...input.identity },
      observedAt: input.settledAt,
      duplicateObservationCount: 0,
    };
    if (!this.#entries.has(key)) this.#entries.set(key, entry);
    if (entry.disposition) {
      return {
        canonicalCommitted: false,
        canonicalDisposition: entry.disposition,
        duplicateObservationCount: entry.duplicateObservationCount,
      };
    }
    entry.disposition = input.disposition;
    entry.settledAt = input.settledAt;
    return {
      canonicalCommitted: true,
      canonicalDisposition: input.disposition,
      duplicateObservationCount: entry.duplicateObservationCount,
    };
  }
}

export interface OrderedAudioSegment<T> {
  source: "me" | "them";
  sourceSequence: number;
  capturedAtMs: number;
  arrivalSequence: number;
  payload: T;
}

export function orderAudioSegments<T>(segments: readonly OrderedAudioSegment<T>[]) {
  return [...segments].sort(
    (left, right) =>
      left.capturedAtMs - right.capturedAtMs ||
      left.arrivalSequence - right.arrivalSequence ||
      left.sourceSequence - right.sourceSequence
  );
}
