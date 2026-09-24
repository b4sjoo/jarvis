export interface AnswerDeliveryPresentation {
  state: "idle" | "delivery-active" | "update-ready";
  visibleAnswerRevision: number;
  meSpokenWordEquivalent: number;
  meAnswerTokenOverlap: number;
  pendingOperationId?: string;
}

export interface GenerationResultProjection {
  disposition: GenerationResultProjectionDisposition;
  key?: GenerationResultLedgerKey;
  generationLeaseId?: string;
  taskId?: string | null;
  commitDisposition?: GenerationCommitDisposition;
  visibleAnswerRevision?: number;
  updatedAt?: number;
}

export type GenerationResultProjectionDisposition =
  | "none"
  | "current-visible"
  | "pending"
  | "historical";

export interface GenerationResultLedgerKey {
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionRevision: number;
}

export type GenerationCommitDisposition =
  | "started"
  | "pending"
  | "committed"
  | "rejected"
  | "failed"
  | "timed-out"
  | "aborted"
  | "cancelled"
  | "superseded";

export interface AudioInputLivenessPresentation {
  state: AudioInputLivenessState;
  severity: "normal" | "warning";
  label: string;
  detail: string;
  observedAtMs: number;
  heartbeatAgeMs?: number;
  captureSessionId?: string;
  snapshotSequence?: number;
  candidateSegmentSequence?: number;
  candidateDurationMs?: number;
  latestEvent?: NativeAudioLivenessEvent;
}

export type AudioInputLivenessState =
  | "idle"
  | "signal-observed"
  | "speech-candidate"
  | "segment-open"
  | "awaiting-silence"
  | "segment-emitted"
  | "stalled"
  | "unavailable";

export interface NativeAudioLivenessEvent {
  schemaVersion: 1 | 2;
  snapshotSequence: number;
  diagnosticRunId?: string;
  captureSessionId: string;
  captureGeneration: number;
  owner: "meeting" | "system";
  source: "system-audio";
  occurredAtMs: number;
  sampleRate: number;
  state: Exclude<AudioInputLivenessState, "unavailable">;
  trigger: NativeAudioLivenessTrigger;
  candidateSegmentSequence?: number;
  candidateStartedAtMs?: number;
  candidateDurationMs: number;
  silenceDurationMs: number;
  intervalDurationMs: number;
  intervalChunkCount: number;
  intervalSignalChunkCount: number;
  intervalSpeechChunkCount: number;
  intervalMaxRms: number;
  intervalMaxPeak: number;
  processedChunkCount: number;
  signalChunkCount: number;
  rawSignalChunkCount?: number;
  rawZeroDurationMs?: number;
  lastRawSignalObservedAtMs?: number;
  speechChunkCount: number;
  speechCandidateCount: number;
  segmentEmittedCount: number;
  candidateDiscardedCount: number;
  lastSignalObservedAtMs?: number;
  lastSpeechCandidateAtMs?: number;
  lastSegmentEmittedAtMs?: number;
  discardReason?: string;
  vadConfigRevision: number;
  hopSize: number;
  sensitivityRms: number;
  peakThreshold: number;
  noiseGateThreshold: number;
  silenceTargetMs: number;
  minimumSpeechMs: number;
  maximumSegmentMs: number;
}

export type NativeAudioLivenessTrigger =
  | "periodic"
  | "speech-start"
  | "silence-boundary"
  | "forced-rollover"
  | "candidate-discarded"
  | "stop-drain"
  | "termination-drain"
  | "tail-discarded";

export interface RuntimeRegressionRunnerPresentation {
  active: boolean;
  status: RuntimeRegressionRunnerStatus;
  scenarioRunId?: string;
  stepOrdinal: number;
  currentStep?: RuntimeRegressionRunnerStepPresentation;
  error?: string;
}

export type RuntimeRegressionRunnerStatus =
  | "idle"
  | "starting"
  | "ready"
  | "running-step"
  | "stopping"
  | "error";

export interface RuntimeRegressionRunnerStepPresentation {
  scenarioStepId: string;
  ordinal: number;
  inputKind: RuntimeRegressionInputKind;
  status: "pending" | "visible" | "suppressed" | "error" | "cancelled";
  traceId?: string;
  reason?: string;
}

export type RuntimeRegressionInputKind = "them-text" | "screen";
