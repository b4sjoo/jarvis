import type { AudioInputLivenessPresentation, NativeAudioLivenessEvent } from "./meeting-presentation-contracts.js";

export type NativeAudioLivenessRejectionReason =
  | "invalid-envelope"
  | "no-active-native-session"
  | "capture-session-mismatch"
  | "capture-owner-mismatch"
  | "capture-generation-mismatch"
  | "capture-source-mismatch"
  | "non-monotonic-snapshot";

export type NativeAudioLivenessAuthorization =
  | {
      authorized: true;
      event: NativeAudioLivenessEvent;
    }
  | {
      authorized: false;
      reason: NativeAudioLivenessRejectionReason;
      event?: NativeAudioLivenessEvent;
    };

const DEFAULT_HEARTBEAT_STALE_MS = 6_000;
const DEFAULT_CANDIDATE_STALL_GRACE_MS = 2_000;
export const RAW_ZERO_PROBE_WAIT_MS = 90_000;

// The episode belongs to user capture intent, not a native generation. Restarting
// capture must not turn persistent silence into an automatic restart loop.
export class RawZeroInputEpisode {
  private seenSignal = false;
  private lastSignalAt?: number;
  private zeroSince?: number;
  private screenWaitUntil = 0;
  private probeUsed = false;

  reset() {
    this.seenSignal = false;
    this.lastSignalAt = undefined;
    this.zeroSince = undefined;
    this.screenWaitUntil = 0;
    this.probeUsed = false;
  }

  observe(event: NativeAudioLivenessEvent): boolean {
    if (event.rawZeroDurationMs == null || event.rawSignalChunkCount == null) return false;
    const signalAt = event.lastRawSignalObservedAtMs;
    let signalReturned = false;
    if (signalAt != null && (this.lastSignalAt == null || signalAt > this.lastSignalAt)) {
      signalReturned = this.zeroSince != null &&
        (this.probeUsed || event.occurredAtMs - this.zeroSince >= RAW_ZERO_PROBE_WAIT_MS);
      this.seenSignal = true;
      this.lastSignalAt = signalAt;
      this.zeroSince = undefined;
      this.probeUsed = false;
    }
    if (this.seenSignal && event.rawZeroDurationMs > 0 && this.zeroSince == null) {
      this.zeroSince = event.occurredAtMs - event.rawZeroDurationMs;
    }
    return signalReturned;
  }

  screenAdmitted(nowMs: number) {
    this.screenWaitUntil = nowMs + RAW_ZERO_PROBE_WAIT_MS;
  }

  read(nowMs: number, screenActive: boolean) {
    const warning = this.zeroSince != null && nowMs - this.zeroSince >= RAW_ZERO_PROBE_WAIT_MS;
    const waitUntil = this.zeroSince == null ? undefined
      : Math.max(this.zeroSince + RAW_ZERO_PROBE_WAIT_MS, this.screenWaitUntil);
    const disposition = !warning ? "waiting"
      : this.probeUsed ? "probe-used"
      : waitUntil! > nowMs ? "screen-wait"
      : screenActive ? "screen-deferred" : "probe-ready";
    return { warning, disposition, zeroSince: this.zeroSince, waitUntil, probeUsed: this.probeUsed };
  }

  markProbeStarted() { this.probeUsed = true; }
}

export function projectRawZeroInputWarning(
  presentation: AudioInputLivenessPresentation | null,
  episode: ReturnType<RawZeroInputEpisode["read"]>,
  reconnecting = false
): AudioInputLivenessPresentation | null {
  if (!presentation || !episode.warning) return presentation;
  return {
    ...presentation,
    state: "unavailable",
    severity: "warning",
    label: reconnecting ? "Checking audio input" : "Audio input may be silent",
    detail: reconnecting
      ? "Reconnecting capture once. Actual nonzero input is required to confirm recovery."
      : "Raw audio has remained zero for at least 90 seconds. Check the meeting audio; silence alone does not prove a device failure.",
  };
}

export function parseNativeAudioLivenessEvent(
  payload: unknown
): NativeAudioLivenessEvent | null {
  if (!isRecord(payload)) return null;

  const state = readStringUnion(payload.state, [
    "idle",
    "signal-observed",
    "speech-candidate",
    "segment-open",
    "awaiting-silence",
    "segment-emitted",
    "stalled",
  ] as const);
  const trigger = readStringUnion(payload.trigger, [
    "periodic",
    "speech-start",
    "silence-boundary",
    "forced-rollover",
    "candidate-discarded",
    "stop-drain",
    "termination-drain",
    "tail-discarded",
  ] as const);
  const owner = readStringUnion(payload.owner, ["meeting", "system"] as const);
  const captureSessionId = readNonEmptyString(payload.captureSessionId);
  const diagnosticRunId = payload.diagnosticRunId === undefined
    ? undefined
    : readNonEmptyString(payload.diagnosticRunId);
  const source =
    payload.source === "system-audio" ? "system-audio" : undefined;

  if (
    (payload.schemaVersion !== 1 && payload.schemaVersion !== 2) ||
    !state ||
    !trigger ||
    !owner ||
    !source ||
    !captureSessionId
    || (payload.diagnosticRunId !== undefined && !diagnosticRunId)
  ) {
    return null;
  }

  const integerFields = [
    "snapshotSequence",
    "captureGeneration",
    "occurredAtMs",
    "sampleRate",
    "candidateDurationMs",
    "silenceDurationMs",
    "intervalDurationMs",
    "intervalChunkCount",
    "intervalSignalChunkCount",
    "intervalSpeechChunkCount",
    "processedChunkCount",
    "signalChunkCount",
    "speechChunkCount",
    "speechCandidateCount",
    "segmentEmittedCount",
    "candidateDiscardedCount",
    "vadConfigRevision",
    "hopSize",
    "silenceTargetMs",
    "minimumSpeechMs",
    "maximumSegmentMs",
  ] as const;
  const integers = Object.fromEntries(
    integerFields.map((field) => [field, readNonNegativeInteger(payload[field])])
  ) as Record<(typeof integerFields)[number], number | undefined>;
  if (
    integerFields.some((field) => integers[field] === undefined) ||
    integers.snapshotSequence! < 1 ||
    integers.captureGeneration! < 1 ||
    integers.sampleRate! < 8_000 ||
    integers.sampleRate! > 96_000 ||
    integers.hopSize! < 1
  ) {
    return null;
  }

  const intervalMaxRms = readNonNegativeNumber(payload.intervalMaxRms);
  const intervalMaxPeak = readNonNegativeNumber(payload.intervalMaxPeak);
  const sensitivityRms = readNonNegativeNumber(payload.sensitivityRms);
  const peakThreshold = readNonNegativeNumber(payload.peakThreshold);
  const noiseGateThreshold = readNonNegativeNumber(payload.noiseGateThreshold);
  if (
    intervalMaxRms === undefined ||
    intervalMaxPeak === undefined ||
    sensitivityRms === undefined ||
    peakThreshold === undefined ||
    noiseGateThreshold === undefined
  ) {
    return null;
  }

  const candidateSegmentSequence = readOptionalPositiveInteger(
    payload.candidateSegmentSequence
  );
  const candidateStartedAtMs = readOptionalNonNegativeInteger(
    payload.candidateStartedAtMs
  );
  const lastSignalObservedAtMs = readOptionalNonNegativeInteger(
    payload.lastSignalObservedAtMs
  );
  const lastSpeechCandidateAtMs = readOptionalNonNegativeInteger(
    payload.lastSpeechCandidateAtMs
  );
  const lastSegmentEmittedAtMs = readOptionalNonNegativeInteger(
    payload.lastSegmentEmittedAtMs
  );
  if (
    candidateSegmentSequence === null ||
    candidateStartedAtMs === null ||
    lastSignalObservedAtMs === null ||
    lastSpeechCandidateAtMs === null ||
    lastSegmentEmittedAtMs === null
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    snapshotSequence: integers.snapshotSequence!,
    diagnosticRunId,
    captureSessionId,
    captureGeneration: integers.captureGeneration!,
    owner,
    source,
    occurredAtMs: integers.occurredAtMs!,
    sampleRate: integers.sampleRate!,
    state,
    trigger,
    candidateSegmentSequence,
    candidateStartedAtMs,
    candidateDurationMs: integers.candidateDurationMs!,
    silenceDurationMs: integers.silenceDurationMs!,
    intervalDurationMs: integers.intervalDurationMs!,
    intervalChunkCount: integers.intervalChunkCount!,
    intervalSignalChunkCount: integers.intervalSignalChunkCount!,
    intervalSpeechChunkCount: integers.intervalSpeechChunkCount!,
    intervalMaxRms,
    intervalMaxPeak,
    processedChunkCount: integers.processedChunkCount!,
    signalChunkCount: integers.signalChunkCount!,
    rawSignalChunkCount: readNonNegativeInteger(payload.rawSignalChunkCount),
    rawZeroDurationMs: readNonNegativeInteger(payload.rawZeroDurationMs),
    lastRawSignalObservedAtMs: readNonNegativeInteger(payload.lastRawSignalObservedAtMs),
    speechChunkCount: integers.speechChunkCount!,
    speechCandidateCount: integers.speechCandidateCount!,
    segmentEmittedCount: integers.segmentEmittedCount!,
    candidateDiscardedCount: integers.candidateDiscardedCount!,
    lastSignalObservedAtMs,
    lastSpeechCandidateAtMs,
    lastSegmentEmittedAtMs,
    discardReason: readOptionalString(payload.discardReason),
    vadConfigRevision: integers.vadConfigRevision!,
    hopSize: integers.hopSize!,
    sensitivityRms,
    peakThreshold,
    noiseGateThreshold,
    silenceTargetMs: integers.silenceTargetMs!,
    minimumSpeechMs: integers.minimumSpeechMs!,
    maximumSegmentMs: integers.maximumSegmentMs!,
  };
}

export function authorizeNativeAudioLivenessEvent({
  payload,
  activeCaptureSessionId,
  activeCaptureGeneration,
  expectedOwner,
  expectedSource,
  lastSnapshotSequence,
}: {
  payload: unknown;
  activeCaptureSessionId: string | null;
  activeCaptureGeneration?: number | null;
  expectedOwner?: NativeAudioLivenessEvent["owner"];
  expectedSource?: NativeAudioLivenessEvent["source"];
  lastSnapshotSequence: number;
}): NativeAudioLivenessAuthorization {
  const event = parseNativeAudioLivenessEvent(payload);
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
  if (event.snapshotSequence <= lastSnapshotSequence) {
    return {
      authorized: false,
      reason: "non-monotonic-snapshot",
      event,
    };
  }
  return { authorized: true, event };
}

export function resolveAudioInputLivenessPresentation({
  captureActive,
  vadEnabled,
  captureStartedAtMs,
  latestEvent,
  latestObservedAtMs,
  nowMs,
  heartbeatStaleMs = DEFAULT_HEARTBEAT_STALE_MS,
  candidateStallGraceMs = DEFAULT_CANDIDATE_STALL_GRACE_MS,
}: {
  captureActive: boolean;
  vadEnabled: boolean;
  captureStartedAtMs?: number;
  latestEvent?: NativeAudioLivenessEvent;
  latestObservedAtMs?: number;
  nowMs: number;
  heartbeatStaleMs?: number;
  candidateStallGraceMs?: number;
}): AudioInputLivenessPresentation | null {
  if (!captureActive || !vadEnabled) return null;

  if (!latestEvent || latestObservedAtMs == null) {
    const heartbeatAgeMs = Math.max(
      0,
      nowMs - (captureStartedAtMs ?? nowMs)
    );
    if (heartbeatAgeMs <= heartbeatStaleMs) {
      return {
        state: "idle",
        severity: "normal",
        label: "Audio telemetry starting",
        detail: "Waiting for the first native input snapshot.",
        observedAtMs: nowMs,
        heartbeatAgeMs,
      };
    }
    return {
      state: "unavailable",
      severity: "warning",
      label: "Audio input unavailable",
      detail: "Native capture is active, but no input heartbeat has arrived.",
      observedAtMs: nowMs,
      heartbeatAgeMs,
    };
  }

  const heartbeatAgeMs = Math.max(0, nowMs - latestObservedAtMs);
  if (heartbeatAgeMs > heartbeatStaleMs) {
    return {
      state: "unavailable",
      severity: "warning",
      label: "Audio input unavailable",
      detail: `Native input heartbeat is ${heartbeatAgeMs}ms old.`,
      observedAtMs: latestObservedAtMs,
      heartbeatAgeMs,
      captureSessionId: latestEvent.captureSessionId,
      snapshotSequence: latestEvent.snapshotSequence,
      candidateSegmentSequence: latestEvent.candidateSegmentSequence,
      candidateDurationMs: latestEvent.candidateDurationMs,
      latestEvent,
    };
  }

  const candidateAgeMs = latestEvent.candidateStartedAtMs
    ? Math.max(0, nowMs - latestEvent.candidateStartedAtMs)
    : latestEvent.candidateDurationMs;
  const candidateStalled =
    Boolean(latestEvent.candidateStartedAtMs) &&
    candidateAgeMs >
      latestEvent.maximumSegmentMs + candidateStallGraceMs;
  if (latestEvent.state === "stalled" || candidateStalled) {
    return {
      state: "stalled",
      severity: "warning",
      label: "Speech not segmented",
      detail:
        latestEvent.discardReason ??
        `Speech candidate has remained open for ${candidateAgeMs}ms.`,
      observedAtMs: latestObservedAtMs,
      heartbeatAgeMs,
      captureSessionId: latestEvent.captureSessionId,
      snapshotSequence: latestEvent.snapshotSequence,
      candidateSegmentSequence: latestEvent.candidateSegmentSequence,
      candidateDurationMs: candidateAgeMs,
      latestEvent,
    };
  }

  const copy = {
    severity: "normal" as const,
    observedAtMs: latestObservedAtMs,
    heartbeatAgeMs,
    captureSessionId: latestEvent.captureSessionId,
    snapshotSequence: latestEvent.snapshotSequence,
    candidateSegmentSequence: latestEvent.candidateSegmentSequence,
    candidateDurationMs: candidateAgeMs,
    latestEvent,
  };
  switch (latestEvent.state) {
    case "signal-observed":
      return {
        ...copy,
        state: latestEvent.state,
        label: "Input below speech threshold",
        detail: "Audio is arriving, but the current interval did not open speech.",
      };
    case "speech-candidate":
      return {
        ...copy,
        state: latestEvent.state,
        label: "Speech detected",
        detail: "A new VAD candidate has opened.",
      };
    case "segment-open":
      return {
        ...copy,
        state: latestEvent.state,
        label: "Listening to speech",
        detail: "The current speech segment is still open.",
      };
    case "awaiting-silence":
      return {
        ...copy,
        state: latestEvent.state,
        label: "Waiting for sentence end",
        detail: "Speech ended recently; VAD is waiting for the silence boundary.",
      };
    case "segment-emitted":
      return {
        ...copy,
        state: latestEvent.state,
        label: "Audio segment emitted",
        detail: `Segment ${latestEvent.candidateSegmentSequence ?? "?"} was emitted.`,
      };
    case "idle":
    default:
      return {
        ...copy,
        state: "idle",
        label: "Listening",
        detail: "Native audio is arriving; no speech candidate is open.",
      };
  }
}

export function buildAudioInputLivenessTraceMetadata(
  event: NativeAudioLivenessEvent,
  observedAtMs: number
) {
  return {
    audioInputLivenessSchemaVersion: event.schemaVersion,
    audioInputLivenessSnapshotSequence: event.snapshotSequence,
    audioInputLivenessState: event.state,
    audioInputLivenessTrigger: event.trigger,
    audioInputLivenessObservedAtMs: observedAtMs,
    audioInputLivenessEventAtMs: event.occurredAtMs,
    audioInputLivenessObservationDelayMs: Math.max(
      0,
      observedAtMs - event.occurredAtMs
    ),
    nativeCaptureSessionId: event.captureSessionId,
    nativeCaptureGeneration: event.captureGeneration,
    nativeCaptureOwner: event.owner,
    nativeSpeechSource: event.source,
    nativeCandidateSegmentSequence: event.candidateSegmentSequence,
    nativeSampleRate: event.sampleRate,
    vadCandidateDurationMs: event.candidateDurationMs,
    vadSilenceDurationMs: event.silenceDurationMs,
    vadIntervalDurationMs: event.intervalDurationMs,
    vadIntervalChunkCount: event.intervalChunkCount,
    vadIntervalSignalChunkCount: event.intervalSignalChunkCount,
    vadIntervalSpeechChunkCount: event.intervalSpeechChunkCount,
    vadIntervalMaxRms: event.intervalMaxRms,
    vadIntervalMaxPeak: event.intervalMaxPeak,
    vadProcessedChunkCount: event.processedChunkCount,
    vadSignalChunkCount: event.signalChunkCount,
    rawSignalChunkCount: event.rawSignalChunkCount,
    rawZeroDurationMs: event.rawZeroDurationMs,
    lastRawSignalObservedAtMs: event.lastRawSignalObservedAtMs,
    vadSpeechChunkCount: event.speechChunkCount,
    vadSpeechCandidateCount: event.speechCandidateCount,
    vadSegmentEmittedCount: event.segmentEmittedCount,
    vadCandidateDiscardedCount: event.candidateDiscardedCount,
    vadDiscardReason: event.discardReason,
    vadConfigRevision: event.vadConfigRevision,
    vadHopSize: event.hopSize,
    vadSensitivityRms: event.sensitivityRms,
    vadPeakThreshold: event.peakThreshold,
    vadNoiseGateThreshold: event.noiseGateThreshold,
    vadSilenceTargetMs: event.silenceTargetMs,
    vadMinimumSpeechMs: event.minimumSpeechMs,
    vadMaximumSegmentMs: event.maximumSegmentMs,
  };
}

function readStringUnion<const T extends readonly string[]>(
  value: unknown,
  allowed: T
): T[number] | undefined {
  return typeof value === "string" && allowed.includes(value)
    ? (value as T[number])
    : undefined;
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNonNegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

function readOptionalNonNegativeInteger(value: unknown) {
  if (value == null) return undefined;
  return readNonNegativeInteger(value) ?? null;
}

function readOptionalPositiveInteger(value: unknown) {
  if (value == null) return undefined;
  const parsed = readNonNegativeInteger(value);
  return parsed && parsed > 0 ? parsed : null;
}

function readNonNegativeNumber(value: unknown) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
