import type { TranscriptTurn } from "./types";

export const STT_CONTINUATION_MAX_SOURCE_CHARS = 240;
export const STT_COMBINED_PROMPT_MAX_CHARS = 1_200;

export interface SttContinuationPromptLease {
  id: string;
  operationId: string;
  audioSessionId: string;
  speaker: TranscriptTurn["speaker"];
  source: TranscriptTurn["source"];
  sourceTurnId: string;
  sourceTraceId: string;
  sourceSegmentSequence: number;
  nativeCaptureSessionId: string;
  nativeCaptureGeneration: number;
  candidateSegmentSequence: number;
  sourceTail: string;
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
}

export type SttContinuationLeaseRejectionReason =
  | "lease-already-consumed"
  | "lease-expired"
  | "audio-session-mismatch"
  | "speaker-mismatch"
  | "source-mismatch"
  | "capture-session-mismatch"
  | "capture-generation-mismatch"
  | "candidate-sequence-mismatch";

export type SttContinuationLeaseAuthorization =
  | {
      authorized: true;
      reason: "matching-continuation-lease";
      lease: SttContinuationPromptLease;
    }
  | {
      authorized: false;
      reason: SttContinuationLeaseRejectionReason;
      lease: SttContinuationPromptLease;
    };

export type ComposedSttPromptKind =
  | "none"
  | "speech-bias"
  | "continuation"
  | "speech-bias+continuation";

export interface ComposedSttPrompt {
  prompt: string;
  kind: ComposedSttPromptKind;
  promptChars: number;
  promptHash?: string;
  speechBiasChars: number;
  continuationChars: number;
  truncated: boolean;
}

export function createSttContinuationPromptLease({
  operationId,
  audioSessionId,
  speaker,
  source,
  sourceTurnId,
  sourceTraceId,
  sourceSegmentSequence,
  sourceText,
  nativeCaptureSessionId,
  nativeCaptureGeneration,
  candidateSegmentSequence,
  createdAt,
  expiresAt,
}: {
  operationId: string;
  audioSessionId: string;
  speaker: TranscriptTurn["speaker"];
  source: TranscriptTurn["source"];
  sourceTurnId: string;
  sourceTraceId: string;
  sourceSegmentSequence: number;
  sourceText: string;
  nativeCaptureSessionId: string;
  nativeCaptureGeneration: number;
  candidateSegmentSequence: number;
  createdAt: number;
  expiresAt: number;
}): SttContinuationPromptLease | null {
  const sourceTail = takeSourceTail(sourceText);
  if (!sourceTail || expiresAt <= createdAt) return null;

  return {
    id: [
      "stt_continuation",
      operationId,
      nativeCaptureGeneration,
      candidateSegmentSequence,
    ].join("_"),
    operationId,
    audioSessionId,
    speaker,
    source,
    sourceTurnId,
    sourceTraceId,
    sourceSegmentSequence,
    nativeCaptureSessionId,
    nativeCaptureGeneration,
    candidateSegmentSequence,
    sourceTail,
    createdAt,
    expiresAt,
  };
}

export function authorizeSttContinuationPromptLease({
  lease,
  segment,
  now,
}: {
  lease: SttContinuationPromptLease;
  segment: {
    sessionId: string;
    speaker: TranscriptTurn["speaker"];
    source: TranscriptTurn["source"];
    nativeCaptureSessionId?: string;
    nativeCaptureGeneration?: number;
    nativeSegmentSequence?: number;
  };
  now: number;
}): SttContinuationLeaseAuthorization {
  if (lease.consumedAt != null) {
    return { authorized: false, reason: "lease-already-consumed", lease };
  }
  if (now >= lease.expiresAt) {
    return { authorized: false, reason: "lease-expired", lease };
  }
  if (segment.sessionId !== lease.audioSessionId) {
    return { authorized: false, reason: "audio-session-mismatch", lease };
  }
  if (segment.speaker !== lease.speaker) {
    return { authorized: false, reason: "speaker-mismatch", lease };
  }
  if (segment.source !== lease.source) {
    return { authorized: false, reason: "source-mismatch", lease };
  }
  if (segment.nativeCaptureSessionId !== lease.nativeCaptureSessionId) {
    return { authorized: false, reason: "capture-session-mismatch", lease };
  }
  if (segment.nativeCaptureGeneration !== lease.nativeCaptureGeneration) {
    return {
      authorized: false,
      reason: "capture-generation-mismatch",
      lease,
    };
  }
  if (segment.nativeSegmentSequence !== lease.candidateSegmentSequence) {
    return {
      authorized: false,
      reason: "candidate-sequence-mismatch",
      lease,
    };
  }
  return {
    authorized: true,
    reason: "matching-continuation-lease",
    lease,
  };
}

export function consumeSttContinuationPromptLease(
  lease: SttContinuationPromptLease,
  consumedAt: number
): SttContinuationPromptLease {
  return {
    ...lease,
    consumedAt,
  };
}

export function composeSttPrompt({
  speechBiasPrompt,
  continuationLease,
}: {
  speechBiasPrompt?: string;
  continuationLease?: SttContinuationPromptLease;
}): ComposedSttPrompt {
  const speechBias = speechBiasPrompt?.trim() ?? "";
  const continuation = continuationLease
    ? [
        "Continuation context from the immediately preceding incomplete transcript:",
        `"${continuationLease.sourceTail}"`,
        "Transcribe only the new audio. Use this source context only to resolve how the sentence continues.",
      ].join(" ")
    : "";
  const kind = resolvePromptKind(Boolean(speechBias), Boolean(continuation));
  if (kind === "none") {
    return {
      prompt: "",
      kind,
      promptChars: 0,
      speechBiasChars: 0,
      continuationChars: 0,
      truncated: false,
    };
  }

  const sections = continuation
    ? [
        continuation,
        ...(speechBias ? [`Speech-bias glossary: ${speechBias}`] : []),
      ]
    : [speechBias];
  const unbounded = sections.join("\n\n");
  const prompt = truncateCombinedPrompt(unbounded);

  return {
    prompt,
    kind,
    promptChars: prompt.length,
    promptHash: stableHash(prompt),
    speechBiasChars: speechBias.length,
    continuationChars: continuationLease?.sourceTail.length ?? 0,
    truncated: prompt.length < unbounded.length,
  };
}

function resolvePromptKind(
  hasSpeechBias: boolean,
  hasContinuation: boolean
): ComposedSttPromptKind {
  if (hasSpeechBias && hasContinuation) return "speech-bias+continuation";
  if (hasContinuation) return "continuation";
  if (hasSpeechBias) return "speech-bias";
  return "none";
}

function takeSourceTail(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= STT_CONTINUATION_MAX_SOURCE_CHARS) {
    return normalized;
  }

  const rawTail = normalized.slice(-STT_CONTINUATION_MAX_SOURCE_CHARS);
  const firstBoundary = rawTail.search(/\s/);
  return (firstBoundary >= 0
    ? rawTail.slice(firstBoundary + 1)
    : rawTail
  ).trim();
}

function truncateCombinedPrompt(prompt: string): string {
  if (prompt.length <= STT_COMBINED_PROMPT_MAX_CHARS) return prompt;
  return prompt.slice(0, STT_COMBINED_PROMPT_MAX_CHARS).trimEnd();
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
