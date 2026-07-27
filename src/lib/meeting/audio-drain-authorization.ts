export type AudioDrainAuthorizationKind =
  | "pause"
  | "stop"
  | "termination";

export interface AudioDrainAuthorization {
  operationId: string;
  kind: AudioDrainAuthorizationKind;
  audioSessionId: string;
  captureSessionId: string;
  captureGeneration: number;
  issuedAt: number;
  expiresAt: number;
  maximumSegmentSequence?: number;
}

export interface AudioSegmentCommitCandidate {
  source: string;
  audioSessionId: string;
  segmentSequence: number;
  nativeCaptureSessionId?: string;
  nativeCaptureGeneration?: number;
}

export type AudioSegmentCommitAuthorization =
  | {
      authorized: true;
      authority: "active-capture" | "drain";
      reason: "active-capture-lease" | "matching-drain-lease";
      drainOperationId?: string;
      drainKind?: AudioDrainAuthorizationKind;
    }
  | {
      authorized: false;
      authority: "none";
      reason:
        | "inactive-runtime"
        | "audio-session-mismatch"
        | "native-capture-session-mismatch"
        | "native-capture-generation-mismatch"
        | "drain-lease-expired"
        | "drain-sequence-exceeded"
        | "no-matching-authorization";
      drainOperationId?: string;
      drainKind?: AudioDrainAuthorizationKind;
    };

export function createAudioDrainAuthorization(input: {
  operationId: string;
  kind: AudioDrainAuthorizationKind;
  audioSessionId: string;
  captureSessionId: string;
  captureGeneration: number;
  issuedAt: number;
  expiresAt: number;
}): AudioDrainAuthorization {
  return {
    operationId: input.operationId,
    kind: input.kind,
    audioSessionId: input.audioSessionId,
    captureSessionId: input.captureSessionId,
    captureGeneration: input.captureGeneration,
    issuedAt: input.issuedAt,
    expiresAt: Math.max(input.issuedAt, input.expiresAt),
  };
}

export function sealAudioDrainAuthorization(
  authorization: AudioDrainAuthorization,
  input: {
    maximumSegmentSequence: number;
    expiresAt: number;
  }
): AudioDrainAuthorization {
  return {
    ...authorization,
    expiresAt: Math.max(authorization.issuedAt, input.expiresAt),
    maximumSegmentSequence: Math.max(
      0,
      Math.floor(input.maximumSegmentSequence)
    ),
  };
}

export function authorizeAudioSegmentCommit(input: {
  candidate: AudioSegmentCommitCandidate;
  runtimeActive: boolean;
  currentAudioSessionId: string;
  activeCaptureSessionId: string | null;
  activeCaptureGeneration: number | null;
  drainAuthorization: AudioDrainAuthorization | null;
  now: number;
}): AudioSegmentCommitAuthorization {
  const {
    candidate,
    runtimeActive,
    currentAudioSessionId,
    activeCaptureSessionId,
    activeCaptureGeneration,
    drainAuthorization,
    now,
  } = input;

  if (
    runtimeActive &&
    candidate.audioSessionId === currentAudioSessionId
  ) {
    if (candidate.source !== "system-audio") {
      return {
        authorized: true,
        authority: "active-capture",
        reason: "active-capture-lease",
      };
    }
    if (
      candidate.nativeCaptureSessionId === activeCaptureSessionId &&
      candidate.nativeCaptureGeneration === activeCaptureGeneration &&
      activeCaptureSessionId != null &&
      activeCaptureGeneration != null
    ) {
      return {
        authorized: true,
        authority: "active-capture",
        reason: "active-capture-lease",
      };
    }
  }

  if (!drainAuthorization || candidate.source !== "system-audio") {
    return {
      authorized: false,
      authority: "none",
      reason: runtimeActive
        ? candidate.audioSessionId === currentAudioSessionId
          ? "no-matching-authorization"
          : "audio-session-mismatch"
        : "inactive-runtime",
    };
  }

  const drainMetadata = {
    drainOperationId: drainAuthorization.operationId,
    drainKind: drainAuthorization.kind,
  };
  if (now > drainAuthorization.expiresAt) {
    return {
      authorized: false,
      authority: "none",
      reason: "drain-lease-expired",
      ...drainMetadata,
    };
  }
  if (candidate.audioSessionId !== drainAuthorization.audioSessionId) {
    return {
      authorized: false,
      authority: "none",
      reason: "audio-session-mismatch",
      ...drainMetadata,
    };
  }
  if (
    candidate.nativeCaptureSessionId !==
    drainAuthorization.captureSessionId
  ) {
    return {
      authorized: false,
      authority: "none",
      reason: "native-capture-session-mismatch",
      ...drainMetadata,
    };
  }
  if (
    candidate.nativeCaptureGeneration !==
    drainAuthorization.captureGeneration
  ) {
    return {
      authorized: false,
      authority: "none",
      reason: "native-capture-generation-mismatch",
      ...drainMetadata,
    };
  }
  if (
    drainAuthorization.maximumSegmentSequence != null &&
    candidate.segmentSequence >
      drainAuthorization.maximumSegmentSequence
  ) {
    return {
      authorized: false,
      authority: "none",
      reason: "drain-sequence-exceeded",
      ...drainMetadata,
    };
  }

  return {
    authorized: true,
    authority: "drain",
    reason: "matching-drain-lease",
    ...drainMetadata,
  };
}

export function isOpenAudioDrainAuthorizationForNativeEvent(input: {
  authorization: AudioDrainAuthorization | null;
  captureSessionId: string;
  captureGeneration: number;
  now: number;
}) {
  const { authorization, captureSessionId, captureGeneration, now } =
    input;
  return Boolean(
    authorization &&
      authorization.maximumSegmentSequence == null &&
      now <= authorization.expiresAt &&
      authorization.captureSessionId === captureSessionId &&
      authorization.captureGeneration === captureGeneration
  );
}

export function formatAudioSegmentCommitAuthorizationForTrace(
  decision: AudioSegmentCommitAuthorization
): Record<string, unknown> {
  return {
    audioSegmentCommitAuthorized: decision.authorized,
    audioSegmentCommitAuthority: decision.authority,
    audioSegmentCommitReason: decision.reason,
    audioDrainOperationId: decision.drainOperationId,
    audioDrainKind: decision.drainKind,
  };
}
