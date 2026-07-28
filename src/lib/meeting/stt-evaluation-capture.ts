import { invoke } from "@tauri-apps/api/core";
import type { TranscriptValidationDecision } from "./transcript-validation";
import type {
  SttEvaluationCaptureLifecycle,
  SttEvaluationCaptureState,
  TranscriptTurn,
} from "./types";

export interface SttEvaluationSubmittedAudio {
  evaluationSessionId?: string;
  utteranceId: string;
  traceId: string;
  audioSessionId: string;
  audioSegmentSequence: number;
  nativeCaptureSessionId?: string;
  nativeCaptureGeneration?: number;
  nativeSegmentSequence?: number;
  nativeCapturedAtMs?: number;
  nativeSampleRate?: number;
  nativeSpeechStartedAtMs?: number;
  nativeSpeechEndedAtMs?: number;
  nativeSegmentEmittedAtMs?: number;
  nativeSampleStart?: number;
  nativeSampleEnd?: number;
  nativeDurationMs?: number;
  nativeSegmentEndReason?: string;
  nativeRolloverFamilyId?: string;
  nativeOverlapSampleCount?: number;
  nativeOverlapDurationMs?: number;
  queuedAt: number;
  submittedAt: number;
  mediaType: string;
  audioBytes: number;
  base64Payload: string;
  source: TranscriptTurn["source"];
}

export interface SttEvaluationProviderTranscript {
  evaluationSessionId?: string;
  utteranceId: string;
  traceId: string;
  audioSessionId: string;
  audioSegmentSequence: number;
  nativeCaptureSessionId?: string;
  nativeCaptureGeneration?: number;
  nativeSegmentSequence?: number;
  nativeCapturedAtMs?: number;
  nativeSampleRate?: number;
  providerId?: string;
  attemptId?: string;
  attemptNumber?: number;
  promptMode?: "configured" | "unbiased";
  promptKind?: string;
  rawText: string;
  validation: TranscriptValidationDecision;
  turnId?: string;
  receivedAt: number;
}

export interface SttEvaluationCanonicalTranscript {
  evaluationSessionId?: string;
  utteranceId: string;
  traceId: string;
  audioSessionId: string;
  audioSegmentSequence: number;
  rawText: string;
  canonicalText: string;
  turn: TranscriptTurn;
  normalizationApplied: boolean;
  recordedAt: number;
}

export interface SttEvaluationHumanReference {
  utteranceId: string;
  referenceText: string;
  confirmedBy: "human";
  confirmedAt: number;
  notes?: string;
}

export type SttEvaluationCaptureInvoke = <T>(
  command: string,
  args?: Record<string, unknown>
) => Promise<T>;

const EMPTY_STT_EVALUATION_CAPTURE_STATE: SttEvaluationCaptureState = {
  active: false,
  lifecycle: "idle",
  rawChunkCount: 0,
  submittedAudioCount: 0,
  providerEventCount: 0,
  canonicalEventCount: 0,
  humanReferenceCount: 0,
  bytesWritten: 0,
  droppedRawChunkCount: 0,
};

export class SttEvaluationCaptureManager {
  private state: SttEvaluationCaptureState = {
    ...EMPTY_STT_EVALUATION_CAPTURE_STATE,
  };
  private transition: Promise<void> = Promise.resolve();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly onChange?: (state: SttEvaluationCaptureState) => void,
    private readonly invokeCommand: SttEvaluationCaptureInvoke = (command, args) =>
      invoke(command, args)
  ) {}

  getState() {
    return { ...this.state };
  }

  async refresh() {
    const native = await this.invokeCommand<NativeSttEvaluationCaptureStatus>(
      "get_stt_evaluation_capture_status"
    );
    this.applyNativeState(native);
    return this.getState();
  }

  async cleanupExpired() {
    return this.invokeCommand<number>("cleanup_stt_evaluation_captures");
  }

  async start(ttlHours = 72) {
    return this.serializeTransition(async () => {
      if (this.state.active) return;
      this.update({
        ...this.state,
        active: false,
        lifecycle: "starting",
        lastError: undefined,
      });
      try {
        const native = await this.invokeCommand<NativeSttEvaluationCaptureStatus>(
          "start_stt_evaluation_capture",
          { ttlHours }
        );
        this.applyNativeState(native);
      } catch (error) {
        this.update({
          ...this.state,
          active: false,
          lifecycle: "error",
          lastError: toErrorMessage(error),
        });
        throw error;
      }
    });
  }

  async stop(reason = "manual") {
    return this.serializeTransition(async () => {
      if (!this.state.sessionId || !this.state.active) return;
      this.update({ ...this.state, lifecycle: "stopping" });
      try {
        await this.writeQueue;
        const native = await this.invokeCommand<NativeSttEvaluationCaptureStatus>(
          "stop_stt_evaluation_capture",
          { reason }
        );
        this.applyNativeState(native);
      } catch (error) {
        this.update({
          ...this.state,
          lifecycle: "error",
          lastError: toErrorMessage(error),
        });
        throw error;
      }
    });
  }

  async deleteCurrent() {
    return this.serializeTransition(async () => {
      if (this.state.active) {
        throw new Error("Stop STT Evaluation Capture before deleting it.");
      }
      await this.writeQueue;
      this.update({ ...this.state, lifecycle: "deleting" });
      try {
        const native = await this.invokeCommand<NativeSttEvaluationCaptureStatus>(
          "delete_stt_evaluation_capture"
        );
        this.applyNativeState(native);
      } catch (error) {
        this.update({
          ...this.state,
          lifecycle: "error",
          lastError: toErrorMessage(error),
        });
        throw error;
      }
    });
  }

  recordSubmittedAudio(input: SttEvaluationSubmittedAudio) {
    if (input.source !== "system-audio") return false;
    if (!input.evaluationSessionId) return false;
    const sessionId = this.resolveWriteSessionId(input.evaluationSessionId);
    if (!sessionId) return false;
    this.enqueueWrite(async () => {
      await this.invokeCommand("record_stt_evaluation_submitted_audio", {
        sessionId,
        base64Payload: input.base64Payload,
        metadata: {
          utteranceId: input.utteranceId,
          traceId: input.traceId,
          audioSessionId: input.audioSessionId,
          audioSegmentSequence: input.audioSegmentSequence,
          nativeCaptureSessionId: input.nativeCaptureSessionId,
          nativeCaptureGeneration: input.nativeCaptureGeneration,
          nativeSegmentSequence: input.nativeSegmentSequence,
          nativeCapturedAtMs: input.nativeCapturedAtMs,
          nativeSampleRate: input.nativeSampleRate,
          nativeSpeechStartedAtMs: input.nativeSpeechStartedAtMs,
          nativeSpeechEndedAtMs: input.nativeSpeechEndedAtMs,
          nativeSegmentEmittedAtMs: input.nativeSegmentEmittedAtMs,
          nativeSampleStart: input.nativeSampleStart,
          nativeSampleEnd: input.nativeSampleEnd,
          nativeDurationMs: input.nativeDurationMs,
          nativeSegmentEndReason: input.nativeSegmentEndReason,
          nativeRolloverFamilyId: input.nativeRolloverFamilyId,
          nativeOverlapSampleCount: input.nativeOverlapSampleCount,
          nativeOverlapDurationMs: input.nativeOverlapDurationMs,
          queuedAt: input.queuedAt,
          submittedAt: input.submittedAt,
          mediaType: input.mediaType,
          audioBytes: input.audioBytes,
        },
      });
    });
    return true;
  }

  recordProviderTranscript(input: SttEvaluationProviderTranscript) {
    if (!input.evaluationSessionId) return false;
    return this.recordTranscriptEvent(
      "provider",
      input,
      input.evaluationSessionId
    );
  }

  recordCanonicalTranscript(input: SttEvaluationCanonicalTranscript) {
    if (!input.evaluationSessionId) return false;
    return this.recordTranscriptEvent(
      "canonical",
      input,
      input.evaluationSessionId
    );
  }

  recordHumanReference(input: SttEvaluationHumanReference) {
    const sessionId = this.state.sessionId;
    if (!sessionId) return false;
    return this.recordTranscriptEvent("human-reference", input, sessionId);
  }

  async drain() {
    await this.writeQueue;
  }

  private recordTranscriptEvent(
    stream: TranscriptStream,
    payload: unknown,
    evaluationSessionId: string
  ) {
    const sessionId = this.resolveWriteSessionId(evaluationSessionId);
    if (!sessionId) return false;
    this.enqueueWrite(async () => {
      await this.invokeCommand("record_stt_evaluation_transcript_event", {
        sessionId,
        stream,
        payload: JSON.stringify(payload),
      });
    });
    return true;
  }

  private resolveWriteSessionId(expectedSessionId: string) {
    const sessionId = this.state.sessionId;
    if (!sessionId) return undefined;
    if (expectedSessionId !== sessionId) return undefined;
    return sessionId;
  }

  private enqueueWrite(write: () => Promise<void>) {
    this.writeQueue = this.writeQueue
      .then(write)
      .catch((error) => {
        this.update({
          ...this.state,
          lastError: toErrorMessage(error),
        });
      });
  }

  private serializeTransition(operation: () => Promise<void>) {
    const run = this.transition.then(operation, operation);
    this.transition = run.catch(() => undefined);
    return run.then(() => this.getState());
  }

  private applyNativeState(native: NativeSttEvaluationCaptureStatus) {
    this.update({
      active: native.active,
      lifecycle: readLifecycle(native.lifecycle, native.active),
      sessionId: native.sessionId,
      folderName: native.folderName,
      folderPath: native.folderPath,
      startedAt: native.startedAt,
      expiresAt: native.expiresAt,
      rawChunkCount: native.rawChunkCount,
      submittedAudioCount: native.submittedAudioCount,
      providerEventCount: native.providerEventCount,
      canonicalEventCount: native.canonicalEventCount,
      humanReferenceCount: native.humanReferenceCount,
      bytesWritten: native.bytesWritten,
      droppedRawChunkCount: native.droppedRawChunkCount,
      openRawWriterCount: native.openRawWriterCount,
      manifestRevision: native.manifestRevision,
      manifestFinalized: native.manifestFinalized,
      endedAt: native.endedAt,
      lastError: native.lastError,
    });
  }

  private update(state: SttEvaluationCaptureState) {
    this.state = state;
    this.onChange?.(this.getState());
  }
}

type TranscriptStream = "provider" | "canonical" | "human-reference";

interface NativeSttEvaluationCaptureStatus {
  active: boolean;
  lifecycle: string;
  sessionId?: string;
  folderName?: string;
  folderPath?: string;
  startedAt?: number;
  expiresAt?: number;
  rawChunkCount: number;
  submittedAudioCount: number;
  providerEventCount: number;
  canonicalEventCount: number;
  humanReferenceCount: number;
  bytesWritten: number;
  droppedRawChunkCount: number;
  openRawWriterCount?: number;
  manifestRevision?: number;
  manifestFinalized?: boolean;
  endedAt?: number;
  lastError?: string;
}

function readLifecycle(
  lifecycle: string,
  active: boolean
): SttEvaluationCaptureLifecycle {
  if (active) return "active";
  if (lifecycle === "stopping") return "stopping";
  if (lifecycle === "stopped") return "stopped";
  return "idle";
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
