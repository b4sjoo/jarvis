import { invoke } from "@tauri-apps/api/core";
import type {
  CallAudioChannelStatus,
  CallAudioRecordingState,
  CallAudioRetentionMode,
} from "./call-recording.js";
import { isTauriRuntime, requireTauriRuntime } from "./runtime-environment.js";

export interface CallAudioChunk {
  audioChunkId: string;
  channel: "them" | "me";
  captureGeneration: number;
  part: number;
  startedAt: number;
  endedAt: number;
  sampleRate: number;
  channelCount: number;
  sampleFormat: string;
  durationMs: number;
  byteCount: number;
  sha256: string;
  relativePath: string;
  gapCount: number;
}

export interface CallAudioManifest {
  version: number;
  audioRecordingRevision: number;
  callSessionId: string;
  state: CallAudioRecordingState;
  requestedAt: number;
  startedAt: number | null;
  stoppedAt: number | null;
  retentionMode: CallAudioRetentionMode;
  expiresAt: number | null;
  preservedAt: number | null;
  deletedAt: number | null;
  channels: CallAudioChannelStatus[];
  chunks: CallAudioChunk[];
  failureStage: string | null;
  lastError: string | null;
  retryable: boolean;
}

export interface CallAudioCleanupResult {
  scannedCount: number;
  expiredCount: number;
  deletedCount: number;
  failedCount: number;
  failures: string[];
}

export interface ActiveCallAudioStatus {
  active: boolean;
  callSessionId: string | null;
  captureGeneration: number | null;
  themOverflowCount: number;
  meOverflowCount: number;
  microphoneFailure: string | null;
}

export function startCallAudioEvidence(input: {
  callSessionId: string;
  captureGeneration: number;
  systemSampleRate: number;
  inputDeviceId?: string;
  expectedRevision: number;
  requestedAt?: number;
}) {
  requireTauriRuntime("Call audio recording");
  return invoke<CallAudioManifest>("start_call_audio_evidence", {
    ...input,
    inputDeviceId: input.inputDeviceId || null,
    requestedAt: input.requestedAt ?? Date.now(),
  });
}

export function stopCallAudioEvidence(input: {
  callSessionId: string;
  expectedRevision: number;
  occurredAt?: number;
}) {
  requireTauriRuntime("Call audio recording");
  return invoke<CallAudioManifest>("stop_call_audio_evidence", {
    ...input,
    occurredAt: input.occurredAt ?? Date.now(),
  });
}

export async function getActiveCallAudioStatus() {
  if (!isTauriRuntime()) {
    return {
      active: false,
      callSessionId: null,
      captureGeneration: null,
      themOverflowCount: 0,
      meOverflowCount: 0,
      microphoneFailure: null,
    } satisfies ActiveCallAudioStatus;
  }
  return invoke<ActiveCallAudioStatus>("get_active_call_audio_status");
}

export async function getCallAudioRecording(callSessionId: string) {
  if (!isTauriRuntime()) return null;
  return invoke<CallAudioManifest | null>("get_call_audio_recording", {
    callSessionId,
  });
}

export function preserveCallAudioRecording(input: {
  callSessionId: string;
  expectedRevision: number;
  occurredAt?: number;
}) {
  requireTauriRuntime("Call audio retention");
  return invoke<CallAudioManifest>("preserve_call_audio_recording", {
    ...input,
    occurredAt: input.occurredAt ?? Date.now(),
  });
}

export function restoreTemporaryCallAudioRetention(input: {
  callSessionId: string;
  expectedRevision: number;
}) {
  requireTauriRuntime("Call audio retention");
  return invoke<CallAudioManifest>("restore_temporary_call_audio_retention", input);
}

export function deleteCallAudioRecording(input: {
  callSessionId: string;
  expectedRevision: number;
  occurredAt?: number;
}) {
  requireTauriRuntime("Call audio deletion");
  return invoke<CallAudioManifest>("delete_call_audio_recording", {
    ...input,
    occurredAt: input.occurredAt ?? Date.now(),
  });
}

export async function cleanupExpiredCallAudio(occurredAt = Date.now()) {
  if (!isTauriRuntime()) {
    return {
      scannedCount: 0,
      expiredCount: 0,
      deletedCount: 0,
      failedCount: 0,
      failures: [],
    } satisfies CallAudioCleanupResult;
  }
  return invoke<CallAudioCleanupResult>("cleanup_expired_call_audio", {
    occurredAt,
  });
}
