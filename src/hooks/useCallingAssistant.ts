import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ActiveCallRuntime,
  AudioSegmentDispositionLedger,
  CallRecordingProjection,
  OperationAbortError,
  RolloverTranscriptAssembler,
  NATIVE_CALL_AUDIO_EVENTS,
  abandonRecoveredCallRecording,
  loadAudioSettings,
  authorizeNativeSpeechSegment,
  authorizeNativeOwnedAudioEvent,
  createCancellableOperation,
  commitProviderConfigurationTransaction,
  cleanupExpiredCallAudio,
  getActiveCallAudioStatus,
  createSessionBoundRecordingWriter,
  listCallRecordings,
  listRecoverableCallRecordings,
  isTauriRuntime,
  getChatProvider,
  getSttProvider,
  loadModelRouteSettings,
  loadProviderSecret,
  requestTranscription,
  retryRecoveredCallRecording,
  runAdvisorModelOperation,
  runRuntimeModelOperation,
  startCallAudioEvidence,
  stopCallAudioEvidence,
  persistAudioSettings,
  normalizeModelRouteSettings,
  saveModelRouteSettings,
  updateNativeVadConfig,
  type ActiveCallRuntimeState,
  type ActiveCallTransition,
  type ActiveCallTransitionObserverBinding,
  type AudioSettings,
  type CallRecordingEventKind,
  type CallRecordingStatus,
  type CallRecordingSummary,
  type CallAudioManifest,
  type CallTurnSettlement,
  type GuidanceEvaluationLabel,
  type ModelRouteSettings,
  type NativeSpeechSegment,
  type PreparedArtifactReceiptStatus,
  type PreparedArtifactTarget,
  type RolloverTranscriptOutcome,
  type RolloverTranscriptResult,
  type SessionBoundRecordingWriter,
} from "@/lib/calling";
import {
  RuntimeHandoffService,
  createNeutralRuntimePreparation,
  createPreparedRuntimePreparation,
  type CallPreparationSnapshotBundle,
} from "@/lib/preparation";

interface NativeCallAudioStatus {
  active: boolean;
  captureSessionId?: string;
  captureGeneration?: number;
  deviceId?: string;
  sampleRate?: number;
}

interface NativeAudioLifecycleEvent {
  eventType: "started" | "stopped" | "error";
  captureSessionId: string;
  captureGeneration: number;
  owner: "call" | "system";
  occurredAtMs: number;
  reason?: string;
  message?: string;
  expected: boolean;
  recoverability: string;
  diagnostics?: unknown;
}

interface NativeAudioSegmentDroppedEvent {
  captureSessionId: string;
  captureGeneration: number;
  owner: "call" | "system";
  occurredAtMs: number;
  attemptedSegmentSequence: number;
  reason: string;
  message: string;
}

interface CaptureLease {
  captureSessionId: string;
  captureGeneration: number;
}

interface ProviderSecrets {
  runtime: string;
  advisor: string;
  complex: string;
  stt: string;
}

interface StartCallOptions {
  snapshot?: CallPreparationSnapshotBundle;
}

interface RuntimeEvidenceBinding {
  recording: CallRecordingProjection;
  writer: SessionBoundRecordingWriter;
  handoff: RuntimeHandoffService;
}

const blankSecrets = (): ProviderSecrets => ({
  runtime: "",
  advisor: "",
  complex: "",
  stt: "",
});

const makeRuntime = (snapshot?: CallPreparationSnapshotBundle) => {
  const callSessionId = `call_${crypto.randomUUID()}`;
  const preparation = snapshot
    ? createPreparedRuntimePreparation({ callSessionId, snapshot })
    : createNeutralRuntimePreparation({ callSessionId });
  return new ActiveCallRuntime({ callSessionId, preparation });
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const audioBlob = (base64: string, mediaType: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mediaType });
};

const segmentMetadata = (segment: NativeSpeechSegment) => {
  const { audioBase64, ...metadata } = segment;
  return {
    ...metadata,
    audioBase64Chars: audioBase64.length,
    approximateAudioBytes: Math.floor((audioBase64.length * 3) / 4),
  };
};

const transitionPayload = (transition: ActiveCallTransition) => ({
  command: transition.command,
  before: {
    state: transition.before.state,
    runtimeEpoch: transition.before.runtimeEpoch,
    evidenceRevision: transition.before.evidenceRevision,
    logicalRevision: transition.before.logicalRevision,
    guidanceRevision: transition.before.guidanceRevision,
  },
  after: {
    state: transition.after.state,
    runtimeEpoch: transition.after.runtimeEpoch,
    evidenceRevision: transition.after.evidenceRevision,
    logicalRevision: transition.after.logicalRevision,
    guidanceRevision: transition.after.guidanceRevision,
  },
});

const fallbackSettlement = (input: {
  text: string;
  callSessionId: string;
  momentUnitId: string;
  evidenceRevision: number;
}): CallTurnSettlement => {
  const normalized = input.text.trim().toLowerCase();
  const directQuestion =
    /\?$/.test(normalized) ||
    /^(?:can|could|would|will|do|does|did|is|are|what|when|where|why|how|which|who)\b/.test(
      normalized
    );
  const directRequest =
    /^(?:please\s+)?(?:tell|explain|confirm|check|send|share|walk|help|give|provide|show)\b/.test(
      normalized
    );
  return {
    callSessionId: input.callSessionId,
    momentUnitId: input.momentUnitId,
    evidenceRevision: input.evidenceRevision,
    disposition:
      directQuestion || directRequest ? "actionable" : "context-only",
    counterpartyMove: directQuestion
      ? "question"
      : directRequest
        ? "request"
        : "informational",
    phaseSignal: "none",
    candidateUpdates: [],
    responseAuthorized: directQuestion || directRequest,
    settledAt: Date.now(),
  };
};

async function drainQueueUntilStable(
  currentQueue: () => Promise<void>,
  quietCycles = 3,
  timeoutMs = 3_000
) {
  const startedAt = Date.now();
  let observed = currentQueue();
  let stableCycles = 0;
  while (stableCycles < quietCycles) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Audio processing did not drain within 3 seconds.");
    }
    await observed.catch(() => undefined);
    await new Promise((resolve) => window.setTimeout(resolve, 40));
    const next = currentQueue();
    if (next === observed) {
      stableCycles += 1;
    } else {
      observed = next;
      stableCycles = 0;
    }
  }
}

export function useCallingAssistant() {
  const nativeRuntimeAvailable = isTauriRuntime();
  const runtimeRef = useRef(makeRuntime());
  const [runtime, setRuntime] = useState<ActiveCallRuntimeState>(() =>
    runtimeRef.current.snapshot()
  );
  const [settings, setSettings] = useState<ModelRouteSettings>(() =>
    loadModelRouteSettings()
  );
  const settingsRef = useRef(settings);
  const [audioSettings, setAudioSettings] = useState<AudioSettings>(() =>
    loadAudioSettings()
  );
  const audioSettingsRef = useRef(audioSettings);
  const secretsRef = useRef<ProviderSecrets>(blankSecrets());
  const [configured, setConfigured] = useState<
    Record<keyof ProviderSecrets, boolean>
  >({ runtime: false, advisor: false, complex: false, stt: false });
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const captureSessionIdRef = useRef<string | null>(null);
  const captureGenerationRef = useRef<number | null>(null);
  const captureSampleRateRef = useRef<number | null>(null);
  const lastSegmentSequenceRef = useRef(0);
  const segmentLedgerRef = useRef(new AudioSegmentDispositionLedger());
  const rolloverAssemblerRef = useRef(new RolloverTranscriptAssembler());
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const queueMetricsRef = useRef({ depth: 0, maxDepth: 0, maxWaitMs: 0 });
  const activeOperationsRef = useRef(
    new Set<{ cancel: (reason: string) => boolean }>()
  );
  const recordingRef = useRef<CallRecordingProjection | null>(null);
  const recordingWriterRef = useRef<SessionBoundRecordingWriter | null>(null);
  const handoffServiceRef = useRef<RuntimeHandoffService | null>(null);
  const runtimeObserverBindingRef = useRef<{
    owner: ActiveCallRuntime;
    binding: ActiveCallTransitionObserverBinding;
  } | null>(null);
  const [recordingStatus, setRecordingStatus] =
    useState<CallRecordingStatus | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [recoverableRecordings, setRecoverableRecordings] = useState<
    CallRecordingStatus[]
  >([]);
  const [callRecordings, setCallRecordings] = useState<
    CallRecordingSummary[]
  >([]);
  const audioRecordingManifestRef = useRef<CallAudioManifest | null>(null);
  const audioRecordingDesiredRef = useRef(false);
  const audioHealthObservationRef = useRef("");
  const [audioRecordingManifest, setAudioRecordingManifest] =
    useState<CallAudioManifest | null>(null);
  const [audioRecordingDesired, setAudioRecordingDesired] = useState(false);
  const [audioRecordingArmed, setAudioRecordingArmed] = useState(false);
  const [audioRecordingError, setAudioRecordingError] = useState<string | null>(
    null
  );

  const publish = useCallback(
    () => setRuntime(runtimeRef.current.snapshot()),
    []
  );

  const recordEvent = useCallback(
    async (
      kind: CallRecordingEventKind,
      payload: unknown,
      occurredAt = Date.now()
    ) => {
      return recordingWriterRef.current?.record(kind, payload, occurredAt) ?? null;
    },
    []
  );

  const captureEvidenceBinding = useCallback(
    (owner: ActiveCallRuntime): RuntimeEvidenceBinding | null => {
      const writer = recordingWriterRef.current;
      const recording = recordingRef.current;
      const handoff = handoffServiceRef.current;
      if (
        !recording ||
        !writer ||
        !handoff ||
        recording.callSessionId !== owner.snapshot().callSessionId ||
        writer.callSessionId !== owner.snapshot().callSessionId
      ) {
        return null;
      }
      return { recording, writer, handoff };
    },
    []
  );

  const queueRecordingEvent = useCallback(
    (kind: CallRecordingEventKind, payload: unknown, occurredAt = Date.now()) => {
      void recordEvent(kind, payload, occurredAt).catch(() => undefined);
    },
    [recordEvent]
  );

  const adoptAudioRecordingManifest = useCallback(
    (manifest: CallAudioManifest | null) => {
      audioRecordingManifestRef.current = manifest;
      setAudioRecordingManifest(manifest);
    },
    []
  );

  const startAudioEvidenceForCapture = useCallback(
    async (owner: ActiveCallRuntime, reason: string) => {
      const captureGeneration = captureGenerationRef.current;
      const systemSampleRate = captureSampleRateRef.current;
      if (captureGeneration == null || systemSampleRate == null) {
        throw new Error("System audio capture is not ready for evidence recording.");
      }
      const current = audioRecordingManifestRef.current;
      if (current && current.callSessionId !== owner.snapshot().callSessionId) {
        throw new Error("Audio evidence belongs to another CallSession.");
      }
      const requestedAt = Date.now();
      const manifest = await startCallAudioEvidence({
        callSessionId: owner.snapshot().callSessionId,
        captureGeneration,
        systemSampleRate,
        inputDeviceId: audioSettingsRef.current.inputDeviceId ?? undefined,
        expectedRevision: current?.audioRecordingRevision ?? 0,
        requestedAt,
      });
      adoptAudioRecordingManifest(manifest);
      setAudioRecordingArmed(false);
      setAudioRecordingError(null);
      queueRecordingEvent(
        "audio-evidence-lifecycle",
        {
          eventType: "started",
          reason,
          audioRecordingRevision: manifest.audioRecordingRevision,
          captureGeneration,
          channels: manifest.channels,
        },
        requestedAt
      );
      return manifest;
    },
    [adoptAudioRecordingManifest, queueRecordingEvent]
  );

  const stopAudioEvidenceForCapture = useCallback(
    async (owner: ActiveCallRuntime, reason: string) => {
      const status = await getActiveCallAudioStatus();
      if (!status.active) {
        setAudioRecordingArmed(audioRecordingDesiredRef.current);
        return audioRecordingManifestRef.current;
      }
      if (status.callSessionId !== owner.snapshot().callSessionId) {
        throw new Error("Active audio evidence belongs to another CallSession.");
      }
      const current = audioRecordingManifestRef.current;
      if (!current) {
        throw new Error("Active audio evidence has no local manifest projection.");
      }
      const stoppedAt = Date.now();
      const stopStartedAt = performance.now();
      const manifest = await stopCallAudioEvidence({
        callSessionId: current.callSessionId,
        expectedRevision: current.audioRecordingRevision,
        occurredAt: stoppedAt,
      });
      adoptAudioRecordingManifest(manifest);
      setAudioRecordingArmed(audioRecordingDesiredRef.current);
      if (manifest.state === "partial" || manifest.state === "error") {
        setAudioRecordingError(
          manifest.lastError || "Call audio evidence is incomplete."
        );
      }
      queueRecordingEvent(
        "audio-evidence-lifecycle",
        {
          eventType: "stopped",
          reason,
          audioRecordingRevision: manifest.audioRecordingRevision,
          captureGeneration: status.captureGeneration,
          channels: manifest.channels,
          chunkCount: manifest.chunks.length,
          stopDurationMs: Math.round(performance.now() - stopStartedAt),
        },
        stoppedAt
      );
      return manifest;
    },
    [adoptAudioRecordingManifest, queueRecordingEvent]
  );

  const recordPreparedArtifacts = useCallback(
    (
      owner: ActiveCallRuntime,
      input: {
        target: PreparedArtifactTarget;
        status: PreparedArtifactReceiptStatus;
        operationId: string;
        reason?: string;
        occurredAt?: number;
      },
      binding?: RuntimeEvidenceBinding | null
    ) => {
      const preparation = owner.snapshot().preparation;
      if (preparation.mode !== "prepared") return;
      const artifactIds = preparation.artifactIdsByTarget[input.target];
      if (!artifactIds.length) return;
      const occurredAt = input.occurredAt ?? Date.now();
      const artifacts = preparation.artifacts.filter((artifact) =>
        artifactIds.includes(artifact.artifactId)
      );
      const evidence = binding ?? captureEvidenceBinding(owner);
      evidence?.writer.queue(
        "snapshot-artifact-receipt",
        {
          snapshotId: preparation.snapshotId,
          snapshotContentHash: preparation.snapshotContentHash,
          operationId: input.operationId,
          target: input.target,
          status: input.status,
          reason: input.reason,
          artifacts,
        },
        occurredAt
      );
      evidence?.handoff.recordArtifactReceipt({
        preparation,
        ...input,
        occurredAt,
      });
    },
    [captureEvidenceBinding]
  );

  const bindRuntimeRecording = useCallback(
    (
      owner: ActiveCallRuntime,
      handoff: RuntimeHandoffService,
      reason = "recording-bound"
    ) => {
      const binding = captureEvidenceBinding(owner);
      if (!binding) {
        throw new Error("The runtime evidence binding is unavailable.");
      }
      runtimeObserverBindingRef.current?.binding.detach();
      const observerBinding = owner.bindTransitionObserver(
        `call-recording:${owner.snapshot().callSessionId}`,
        (transition) => {
        if (
          runtimeRef.current !== owner ||
          binding.writer.callSessionId !== transition.after.callSessionId
        ) {
          return;
        }
        binding.writer.queue(
          "runtime-command",
          transitionPayload(transition),
          transition.after.updatedAt
        );
        handoff.recordTransition(transition);
        }
      );
      runtimeObserverBindingRef.current = {
        owner,
        binding: observerBinding,
      };
      binding.writer.queue("runtime-projection-lifecycle", {
        eventType: "attached",
        ownerToken: observerBinding.ownerToken,
        reason,
        runtimeEpoch: owner.snapshot().runtimeEpoch,
        evidenceRevision: owner.snapshot().evidenceRevision,
      });
    },
    [captureEvidenceBinding]
  );

  const detachRuntimeRecording = useCallback((owner: ActiveCallRuntime) => {
    const current = runtimeObserverBindingRef.current;
    if (!current || current.owner !== owner) return false;
    const detached = current.binding.detach();
    if (runtimeObserverBindingRef.current === current) {
      runtimeObserverBindingRef.current = null;
    }
    return detached;
  }, []);

  const discloseRuntimeProjectionGap = useCallback(
    (owner: ActiveCallRuntime, reason: string) => {
      const evidence = captureEvidenceBinding(owner);
      if (!evidence) return;
      const normalizedReason = `runtime-projection-detached:${reason}`;
      evidence.recording.markIncomplete(normalizedReason);
      void evidence.writer
        .record("runtime-projection-lifecycle", {
          eventType: "detached",
          reason,
          runtimeEpoch: owner.snapshot().runtimeEpoch,
          evidenceRevision: owner.snapshot().evidenceRevision,
          recoverable: true,
        })
        .catch(() => undefined)
        .then(() => evidence.recording.persistIncomplete(normalizedReason))
        .then((status) => {
          if (recordingRef.current === evidence.recording && status) {
            setRecordingStatus(status);
          }
        })
        .catch((error) => {
          if (recordingRef.current === evidence.recording) {
            setRecordingError(errorMessage(error));
          }
        });
    },
    [captureEvidenceBinding]
  );

  const refreshRecoverableRecordings = useCallback(async () => {
    if (!nativeRuntimeAvailable) {
      setRecoverableRecordings([]);
      return;
    }
    try {
      setRecoverableRecordings(await listRecoverableCallRecordings());
    } catch (error) {
      setRecordingError(errorMessage(error));
    }
  }, [nativeRuntimeAvailable]);

  const refreshCallRecordings = useCallback(async () => {
    if (!nativeRuntimeAvailable) {
      setCallRecordings([]);
      return;
    }
    try {
      setCallRecordings(await listCallRecordings());
    } catch (error) {
      setRecordingError(errorMessage(error));
    }
  }, [nativeRuntimeAvailable]);

  const abortOperations = useCallback((reason: string) => {
    for (const operation of activeOperationsRef.current) {
      operation.cancel(reason);
    }
    activeOperationsRef.current.clear();
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const refreshSecrets = useCallback(async () => {
    const routes = ["runtime", "advisor", "complex", "stt"] as const;
    const results = await Promise.allSettled(
      routes.map((route) => loadProviderSecret(route))
    );
    const loaded = blankSecrets();
    const failedRoutes: string[] = [];
    results.forEach((result, index) => {
      const route = routes[index];
      if (result.status === "fulfilled") loaded[route] = result.value;
      else failedRoutes.push(route);
    });
    secretsRef.current = loaded;
    setCredentialError(
      failedRoutes.length
        ? `MOSS could not read ${failedRoutes.join(", ")} credentials from the macOS Keychain. Restart MOSS, then save those routes again.`
        : null
    );
    setConfigured({
      runtime:
        !getChatProvider(settingsRef.current.chat.runtime.provider)
          .requiresApiKey || Boolean(loaded.runtime),
      advisor:
        !getChatProvider(settingsRef.current.chat.advisor.provider)
          .requiresApiKey || Boolean(loaded.advisor),
      complex:
        !getChatProvider(settingsRef.current.chat.complex.provider)
          .requiresApiKey || Boolean(loaded.complex),
      stt:
        !getSttProvider(settingsRef.current.stt.provider).requiresApiKey ||
        Boolean(loaded.stt),
    });
  }, []);

  useEffect(() => {
    void refreshSecrets();
    void refreshRecoverableRecordings();
    void refreshCallRecordings();
  }, [refreshCallRecordings, refreshRecoverableRecordings, refreshSecrets]);

  useEffect(() => {
    if (!nativeRuntimeAvailable) return;
    const cleanup = () => {
      void cleanupExpiredCallAudio()
        .then((result) => {
          if (result.deletedCount || result.failedCount) {
            void refreshCallRecordings();
          }
          if (result.failedCount) {
            setRecordingError(
              `MOSS could not delete ${result.failedCount} expired audio recording${result.failedCount === 1 ? "" : "s"}.`
            );
          }
        })
        .catch((error) => setRecordingError(errorMessage(error)));
    };
    cleanup();
    const interval = window.setInterval(cleanup, 60 * 60 * 1_000);
    return () => window.clearInterval(interval);
  }, [nativeRuntimeAvailable, refreshCallRecordings]);

  useEffect(() => {
    if (!nativeRuntimeAvailable || !audioRecordingDesired) {
      audioHealthObservationRef.current = "";
      return;
    }
    let disposed = false;
    const observe = async () => {
      try {
        const status = await getActiveCallAudioStatus();
        if (disposed || !status.active) return;
        const signature = JSON.stringify({
          callSessionId: status.callSessionId,
          captureGeneration: status.captureGeneration,
          themOverflowCount: status.themOverflowCount,
          meOverflowCount: status.meOverflowCount,
          microphoneFailure: status.microphoneFailure,
        });
        if (signature === audioHealthObservationRef.current) return;
        audioHealthObservationRef.current = signature;
        queueRecordingEvent("audio-evidence-lifecycle", {
          eventType: "health-observed",
          ...status,
        });
        if (
          status.microphoneFailure ||
          status.themOverflowCount > 0 ||
          status.meOverflowCount > 0
        ) {
          setAudioRecordingError(
            status.microphoneFailure ||
              "Call audio evidence has a writer queue gap. Live assistance is continuing."
          );
        }
      } catch (error) {
        if (!disposed) setAudioRecordingError(errorMessage(error));
      }
    };
    void observe();
    const interval = window.setInterval(observe, 2_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [audioRecordingDesired, nativeRuntimeAvailable, queueRecordingEvent]);

  const executeAdvisor = useCallback(
    async (owner: ActiveCallRuntime, force = false) => {
      const snapshot = owner.snapshot();
      if (!force && !snapshot.latestSettlement?.responseAuthorized) return;
      const provider = getChatProvider(
        settingsRef.current.chat.advisor.provider
      );
      const apiKey = provider.requiresApiKey
        ? secretsRef.current.advisor
        : "";
      if (provider.requiresApiKey && !apiKey) return;
      const evidence = captureEvidenceBinding(owner);
      if (!evidence) return;
      await runAdvisorModelOperation({
        owner,
        apiKey,
        route: settingsRef.current.chat.advisor,
        isCurrentOwner: () => runtimeRef.current === owner,
        publish,
        register: (operation) => activeOperationsRef.current.add(operation),
        unregister: (operation) => activeOperationsRef.current.delete(operation),
        record: evidence.writer.queue,
        recordPreparedArtifacts: (receipt) =>
          recordPreparedArtifacts(owner, receipt, evidence),
      });
    },
    [captureEvidenceBinding, publish, recordPreparedArtifacts]
  );

  const settleTurn = useCallback(
    async (
      owner: ActiveCallRuntime,
      text: string,
      momentUnitId: string
    ) => {
      const snapshot = owner.snapshot();
      const evidence = captureEvidenceBinding(owner);
      if (!evidence) return;
      let settlement = fallbackSettlement({
        text,
        callSessionId: snapshot.callSessionId,
        momentUnitId,
        evidenceRevision: snapshot.evidenceRevision,
      });
      const provider = getChatProvider(
        settingsRef.current.chat.runtime.provider
      );
      const apiKey = provider.requiresApiKey
        ? secretsRef.current.runtime
        : "";
      if (!provider.requiresApiKey || apiKey) {
        const outcome = await runRuntimeModelOperation({
          owner,
          apiKey,
          route: settingsRef.current.chat.runtime,
          momentUnitId,
          isCurrentOwner: () => runtimeRef.current === owner,
          publish,
          register: (operation) => activeOperationsRef.current.add(operation),
          unregister: (operation) => activeOperationsRef.current.delete(operation),
          record: evidence.writer.queue,
          recordPreparedArtifacts: (receipt) =>
            recordPreparedArtifacts(owner, receipt, evidence),
        });
        if (outcome.status === "settled") settlement = outcome.settlement;
        if (outcome.status === "cancelled" || outcome.status === "stale") return;
      }
      if (runtimeRef.current !== owner) return;
      const after = owner.dispatch({ type: "ApplyRuntimeSettlement", settlement });
      const committed = after.latestSettlement;
      if (
        !committed ||
        committed.momentUnitId !== momentUnitId ||
        committed.evidenceRevision !== snapshot.evidenceRevision
      ) {
        return;
      }
      evidence.writer.queue(
        "runtime-advisor-authority",
        {
          momentUnitId,
          evidenceRevision: committed.evidenceRevision,
          disposition: committed.disposition,
          counterpartyMove: committed.counterpartyMove,
          phaseSignal: committed.phaseSignal,
          modelRequested: committed.modelResponseAuthorized,
          responseAuthorized: committed.responseAuthorized,
          normalized: committed.advisorAuthorityNormalized,
          reason: committed.advisorAuthorityReason,
        },
        committed.settledAt
      );
      publish();
      if (committed.responseAuthorized) void executeAdvisor(owner);
    },
    [
      captureEvidenceBinding,
      executeAdvisor,
      publish,
      recordPreparedArtifacts,
    ]
  );

  const processSegment = useCallback(
    async (owner: ActiveCallRuntime, segment: NativeSpeechSegment) => {
      const evidence = captureEvidenceBinding(owner);
      if (!evidence) return;
      const record = evidence.writer.queue;
      const identity = {
        captureSessionId: segment.captureSessionId,
        captureGeneration: segment.captureGeneration,
        segmentSequence: segment.segmentSequence,
      };
      const observedAt = Date.now();

      const commitRolloverResult = async (
        assembled: RolloverTranscriptResult,
        operationId: string,
        occurredAt: number
      ) => {
        record(
          "rollover-transcript-family",
          {
            ...identity,
            status: assembled.status,
            familyId: assembled.familyId,
            segmentCount: assembled.segmentCount,
            failedSegmentCount: assembled.failedSegmentCount,
            overlapRemovedChars: assembled.overlapRemovedChars,
            mergeUncertain: assembled.mergeUncertain,
            firstSpeechStartedAtMs: assembled.firstSpeechStartedAtMs,
            completedAtMs: assembled.completedAtMs,
            terminalOutcome: assembled.terminalOutcome,
            degradedReason: assembled.degradedReason,
          },
          occurredAt
        );
        if (assembled.degradedReason && assembled.familyId) {
          evidence.recording.markIncomplete(
            `${assembled.degradedReason}:${assembled.familyId}`
          );
        }
        if (assembled.status !== "ready") return;
        const logicalText = assembled.text?.trim() ?? "";
        if (!logicalText) return;
        if (
          runtimeRef.current !== owner ||
          owner.snapshot().state !== "live"
        ) {
          evidence.recording.markIncomplete(
            `rollover-ready-after-owner-change:${assembled.familyId ?? identity.segmentSequence}`
          );
          return;
        }
        const momentUnitId = `moment_${crypto.randomUUID()}`;
        owner.dispatch({
          type: "SubmitTranscriptTurn",
          momentUnitId,
          turn: {
            id: `turn_${crypto.randomUUID()}`,
            speaker: "them",
            text: logicalText,
            occurredAt,
          },
        });
        publish();
        recordPreparedArtifacts(owner, {
          target: "stt",
          status: "visible",
          operationId,
          occurredAt,
        }, evidence);
        await settleTurn(owner, logicalText, momentUnitId);
      };

      const settleFailedRollover = async (
        outcome: Exclude<RolloverTranscriptOutcome, "success">,
        operationId: string,
        occurredAt: number
      ) => {
        const assembled = rolloverAssemblerRef.current.settle({
          segment,
          outcome,
          completedAtMs: occurredAt,
        });
        await commitRolloverResult(assembled, operationId, occurredAt);
      };

      segmentLedgerRef.current.observe({ identity, observedAt });
      record(
        "audio-segment-observed",
        segmentMetadata(segment),
        observedAt
      );
      const sttSecret = secretsRef.current.stt;
      const sttProvider = getSttProvider(settingsRef.current.stt.provider);
      if (sttProvider.requiresApiKey && !sttSecret) {
        const result = segmentLedgerRef.current.settle({
          identity,
          disposition: "failed",
          settledAt: Date.now(),
        });
        record("audio-segment-settled", {
          ...identity,
          ...result,
          reason: "stt-provider-not-configured",
        });
        await settleFailedRollover(
          "failed",
          `stt_${segment.captureSessionId}_${segment.segmentSequence}`,
          Date.now()
        );
        return;
      }

      const operationId = `stt_${segment.captureSessionId}_${segment.segmentSequence}`;
      const dispatchedAt = Date.now();
      const preparation = owner.snapshot().preparation;
      const speechBiasPrompt = preparation.mode === "prepared"
        ? preparation.stt.speechBiasTerms.slice(0, 80).join(", ")
        : undefined;
      recordPreparedArtifacts(owner, {
        target: "stt",
        status: "selected",
        operationId,
        occurredAt: dispatchedAt,
      }, evidence);
      record(
        "stt-operation-dispatched",
        {
          operationId,
          ...identity,
          provider: settingsRef.current.stt.provider,
          endpoint: settingsRef.current.stt.endpoint,
          model: settingsRef.current.stt.model,
          language: settingsRef.current.stt.language,
          modelConfigRevision: settingsRef.current.revision,
          durationMs: segment.durationMs,
          endReason: segment.endReason,
          speechBiasTermCount:
            preparation.mode === "prepared"
              ? preparation.stt.speechBiasTerms.length
              : 0,
        },
        dispatchedAt
      );
      recordPreparedArtifacts(owner, {
        target: "stt",
        status: "dispatched",
        operationId,
        occurredAt: dispatchedAt,
      }, evidence);
      const operation = createCancellableOperation({
        operationId,
        timeoutMs: 30_000,
        execute: (signal) =>
          requestTranscription({
            route: settingsRef.current.stt,
            apiKey: sttSecret,
            audio: audioBlob(segment.audioBase64, segment.mediaType),
            prompt: speechBiasPrompt,
            signal,
          }),
      });
      activeOperationsRef.current.add(operation);
      try {
        const text = await operation.promise;
        const returnedAt = Date.now();
        record(
          "stt-operation-returned",
          {
            operationId,
            ...identity,
            status: "success",
            durationMs: returnedAt - dispatchedAt,
            transcript: text,
          },
          returnedAt
        );
        recordPreparedArtifacts(owner, {
          target: "stt",
          status: "provider-returned",
          operationId,
          occurredAt: returnedAt,
        }, evidence);
        if (
          runtimeRef.current !== owner ||
          owner.snapshot().state !== "live"
        ) {
          const result = segmentLedgerRef.current.settle({
            identity,
            disposition: "stale",
            settledAt: returnedAt,
          });
          record("audio-segment-settled", {
            ...identity,
            ...result,
            reason: "runtime-owner-or-state-changed",
          });
          recordPreparedArtifacts(owner, {
            target: "stt",
            status: "stale",
            operationId,
            reason: "runtime-owner-or-state-changed",
            occurredAt: returnedAt,
          }, evidence);
          return;
        }
        const result = segmentLedgerRef.current.settle({
          identity,
          disposition: "accepted",
          settledAt: returnedAt,
        });
        record("audio-segment-settled", {
          ...identity,
          ...result,
        });
        recordPreparedArtifacts(owner, {
          target: "stt",
          status: "commit-authorized",
          operationId,
          occurredAt: returnedAt,
        }, evidence);
        const assembled = rolloverAssemblerRef.current.settle({
          segment,
          outcome: text.trim() ? "success" : "empty",
          transcript: text,
          completedAtMs: returnedAt,
        });
        await commitRolloverResult(assembled, operationId, returnedAt);
      } catch (error) {
        const failedAt = Date.now();
        record(
          "stt-operation-returned",
          {
            operationId,
            ...identity,
            status:
              error instanceof OperationAbortError ? "cancelled" : "failed",
            durationMs: failedAt - dispatchedAt,
            error: errorMessage(error),
          },
          failedAt
        );
        const result = segmentLedgerRef.current.settle({
          identity,
          disposition:
            error instanceof OperationAbortError ? "stale" : "failed",
          settledAt: failedAt,
        });
        record("audio-segment-settled", {
          ...identity,
          ...result,
          reason: errorMessage(error),
        });
        recordPreparedArtifacts(owner, {
          target: "stt",
          status:
            error instanceof OperationAbortError ? "cancelled" : "failed",
          operationId,
          reason: errorMessage(error),
          occurredAt: failedAt,
        }, evidence);
        if (
          runtimeRef.current === owner &&
          owner.snapshot().state === "live"
        ) {
          await settleFailedRollover(
            error instanceof OperationAbortError
              ? "cancelled"
              : /no transcript/i.test(errorMessage(error))
                ? "empty"
                : "failed",
            operationId,
            failedAt
          );
        }
      } finally {
        activeOperationsRef.current.delete(operation);
      }
    },
    [captureEvidenceBinding, publish, recordPreparedArtifacts, settleTurn]
  );

  const releaseCaptureLease = useCallback((lease: CaptureLease | null) => {
    if (
      lease &&
      captureSessionIdRef.current === lease.captureSessionId &&
      captureGenerationRef.current === lease.captureGeneration
    ) {
      captureSessionIdRef.current = null;
      captureGenerationRef.current = null;
      captureSampleRateRef.current = null;
    }
  }, []);

  const drainCurrentAudioQueue = useCallback(async () => {
    try {
      await drainQueueUntilStable(() => queueRef.current);
    } catch (error) {
      recordingRef.current?.markIncomplete("audio-queue-drain-timeout");
      queueRecordingEvent("audio-queue-observation", {
        phase: "drain-timeout",
        depth: queueMetricsRef.current.depth,
        maxDepth: queueMetricsRef.current.maxDepth,
        maxWaitMs: queueMetricsRef.current.maxWaitMs,
        error: errorMessage(error),
      });
      throw error;
    }
  }, [queueRecordingEvent]);

  useEffect(() => {
    if (!nativeRuntimeAvailable) return;
    let disposed = false;
    let stopSpeech: (() => void) | undefined;
    let stopSpeechStart: (() => void) | undefined;
    let stopLiveness: (() => void) | undefined;
    let stopDropped: (() => void) | undefined;
    let stopLifecycle: (() => void) | undefined;

    const authorizeOwnedEvent = (payload: unknown, kind: CallRecordingEventKind) => {
      const authorization = authorizeNativeOwnedAudioEvent({
        payload,
        activeCaptureSessionId: captureSessionIdRef.current ?? "",
        activeCaptureGeneration: captureGenerationRef.current ?? -1,
        expectedOwner: "call",
      });
      if (!authorization.authorized) {
        queueRecordingEvent("native-audio-event-rejected", {
          sourceKind: kind,
          captureSessionId: authorization.event?.captureSessionId,
          captureGeneration: authorization.event?.captureGeneration,
          activeCaptureSessionId: captureSessionIdRef.current,
          activeCaptureGeneration: captureGenerationRef.current,
          reason: authorization.reason,
        });
      }
      return authorization;
    };

    void listen<unknown>(NATIVE_CALL_AUDIO_EVENTS.segment, (event) => {
      const authorization = authorizeNativeSpeechSegment({
        payload: event.payload,
        activeCaptureSessionId: captureSessionIdRef.current ?? "",
        activeCaptureGeneration: captureGenerationRef.current ?? -1,
        lastAcceptedSequence: lastSegmentSequenceRef.current,
        expectedOwner: "call",
      });
      if (!authorization.authorized) {
        const candidate = authorization.event;
        if (
          candidate &&
          candidate.captureSessionId === captureSessionIdRef.current &&
          candidate.captureGeneration === captureGenerationRef.current
        ) {
          queueRecordingEvent("audio-segment-settled", {
            ...segmentMetadata(candidate),
            canonicalCommitted: false,
            canonicalDisposition: "stale",
            reason: authorization.reason,
          });
        }
        return;
      }
      lastSegmentSequenceRef.current = authorization.event.segmentSequence;
      const owner = runtimeRef.current;
      const enqueuedAt = Date.now();
      queueMetricsRef.current.depth += 1;
      queueMetricsRef.current.maxDepth = Math.max(
        queueMetricsRef.current.maxDepth,
        queueMetricsRef.current.depth
      );
      queueRecordingEvent("audio-queue-observation", {
        phase: "enqueued",
        segmentSequence: authorization.event.segmentSequence,
        depth: queueMetricsRef.current.depth,
        maxDepth: queueMetricsRef.current.maxDepth,
      }, enqueuedAt);
      queueRef.current = queueRef.current
        .catch(() => undefined)
        .then(async () => {
          const dequeuedAt = Date.now();
          const waitMs = dequeuedAt - enqueuedAt;
          queueMetricsRef.current.maxWaitMs = Math.max(
            queueMetricsRef.current.maxWaitMs,
            waitMs
          );
          queueRecordingEvent("audio-queue-observation", {
            phase: "dequeued",
            segmentSequence: authorization.event.segmentSequence,
            depth: queueMetricsRef.current.depth,
            waitMs,
            maxDepth: queueMetricsRef.current.maxDepth,
            maxWaitMs: queueMetricsRef.current.maxWaitMs,
          }, dequeuedAt);
          try {
            await processSegment(owner, authorization.event);
          } finally {
            queueMetricsRef.current.depth = Math.max(
              0,
              queueMetricsRef.current.depth - 1
            );
            queueRecordingEvent("audio-queue-observation", {
              phase: "settled",
              segmentSequence: authorization.event.segmentSequence,
              depth: queueMetricsRef.current.depth,
              totalMs: Date.now() - enqueuedAt,
              maxDepth: queueMetricsRef.current.maxDepth,
              maxWaitMs: queueMetricsRef.current.maxWaitMs,
            });
          }
        });
    }).then((stop) => {
      if (disposed) stop();
      else stopSpeech = stop;
    });

    void listen<unknown>(NATIVE_CALL_AUDIO_EVENTS.speechStart, (event) => {
      const authorization = authorizeOwnedEvent(
        event.payload,
        "native-audio-speech-start"
      );
      if (!authorization.authorized) return;
      queueRecordingEvent(
        "native-audio-speech-start",
        authorization.event,
        authorization.event.occurredAtMs
      );
    }).then((stop) => {
      if (disposed) stop();
      else stopSpeechStart = stop;
    });

    void listen<unknown>(NATIVE_CALL_AUDIO_EVENTS.liveness, (event) => {
      const authorization = authorizeOwnedEvent(
        event.payload,
        "native-audio-liveness"
      );
      if (!authorization.authorized) return;
      queueRecordingEvent(
        "native-audio-liveness",
        authorization.event,
        authorization.event.occurredAtMs
      );
    }).then((stop) => {
      if (disposed) stop();
      else stopLiveness = stop;
    });

    void listen<NativeAudioSegmentDroppedEvent>(
      NATIVE_CALL_AUDIO_EVENTS.segmentDropped,
      (event) => {
        const authorization = authorizeOwnedEvent(
          event.payload,
          "native-audio-segment-dropped"
        );
        if (!authorization.authorized) return;
        queueRecordingEvent(
          "native-audio-segment-dropped",
          event.payload,
          event.payload.occurredAtMs
        );
        recordingRef.current?.markIncomplete(
          `native-segment-dropped:${event.payload.reason}`
        );
      }
    ).then((stop) => {
      if (disposed) stop();
      else stopDropped = stop;
    });

    void listen<NativeAudioLifecycleEvent>(
      NATIVE_CALL_AUDIO_EVENTS.lifecycle,
      (event) => {
        const lifecycle = event.payload;
        if (
          lifecycle.owner !== "call" ||
          lifecycle.captureSessionId !== captureSessionIdRef.current ||
          lifecycle.captureGeneration !== captureGenerationRef.current
        ) {
          return;
        }
        queueRecordingEvent(
          "native-audio-lifecycle",
          lifecycle,
          lifecycle.occurredAtMs
        );
        if (
          lifecycle.eventType !== "error" ||
          lifecycle.expected
        ) {
          return;
        }
        const owner = runtimeRef.current;
        const lease: CaptureLease = {
          captureSessionId: lifecycle.captureSessionId,
          captureGeneration: lifecycle.captureGeneration,
        };
        void drainCurrentAudioQueue().catch(() => undefined).then(async () => {
          if (disposed || runtimeRef.current !== owner) return;
          const state = owner.snapshot().state;
          if (!["live", "starting", "recovering"].includes(state)) return;
          if (audioRecordingDesiredRef.current) {
            await stopAudioEvidenceForCapture(
              owner,
              "native-capture-terminated"
            ).catch((error) => {
              setAudioRecordingError(errorMessage(error));
              recordingRef.current?.markIncomplete(
                `audio-evidence-native-termination:${errorMessage(error)}`
              );
            });
          }
          releaseCaptureLease(lease);
          abortOperations("native-capture-terminated");
          owner.dispatch({
            type: "RequireRecovery",
            error:
              lifecycle.message ||
              lifecycle.reason ||
              "Native audio capture terminated unexpectedly.",
            occurredAt: Date.now(),
          });
          publish();
        });
      }
    ).then((stop) => {
      if (disposed) stop();
      else stopLifecycle = stop;
    });

    return () => {
      disposed = true;
      stopSpeech?.();
      stopSpeechStart?.();
      stopLiveness?.();
      stopDropped?.();
      stopLifecycle?.();
    };
  }, [
    abortOperations,
    drainCurrentAudioQueue,
    processSegment,
    publish,
    queueRecordingEvent,
    releaseCaptureLease,
    nativeRuntimeAvailable,
    stopAudioEvidenceForCapture,
  ]);

  const startCapture = useCallback(
    async (owner: ActiveCallRuntime) => {
      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (!hasAccess) throw new Error("System audio permission is required.");
      const status = await invoke<NativeCallAudioStatus>(
        "start_call_audio_session",
        {
          vadConfig: audioSettingsRef.current.vadConfig,
          deviceId: audioSettingsRef.current.outputDeviceId,
        }
      );
      if (!status.captureSessionId || status.captureGeneration == null) {
        throw new Error("Native capture started without a lease.");
      }
      if (
        runtimeRef.current !== owner ||
        !["starting", "recovering"].includes(owner.snapshot().state)
      ) {
        await invoke("stop_call_audio_session", {
          expectedCaptureSessionId: status.captureSessionId,
          expectedCaptureGeneration: status.captureGeneration,
        }).catch(() => undefined);
        throw new OperationAbortError("Native capture owner changed during start.");
      }
      captureSessionIdRef.current = status.captureSessionId;
      captureGenerationRef.current = status.captureGeneration;
      captureSampleRateRef.current = status.sampleRate ?? null;
      lastSegmentSequenceRef.current = 0;
      queueRecordingEvent("native-audio-lifecycle", {
        eventType: "started",
        captureSessionId: status.captureSessionId,
        captureGeneration: status.captureGeneration,
        owner: "call",
        occurredAtMs: Date.now(),
        expected: true,
        reason: "start-completed",
        audioConfigRevision: audioSettingsRef.current.revision,
        modelConfigRevision: settingsRef.current.revision,
        inputDeviceId: audioSettingsRef.current.inputDeviceId,
        requestedOutputDeviceId: audioSettingsRef.current.outputDeviceId,
        resolvedOutputDeviceId: status.deviceId ?? null,
        resolvedSampleRate: status.sampleRate ?? null,
        vadConfig: audioSettingsRef.current.vadConfig,
      });
      owner.dispatch({ type: "CaptureStarted", occurredAt: Date.now() });
      publish();
    },
    [publish, queueRecordingEvent]
  );

  const start = useCallback(async (options?: StartCallOptions) => {
    if (!nativeRuntimeAvailable) {
      throw new Error("Start calls from the MOSS desktop app.");
    }
    if (!secretsRef.current.stt) {
      throw new Error("Configure Speech-to-Text before starting a call.");
    }
    let owner = runtimeRef.current;
    if (
      !["planned", "closed", "start-failed", "abandoned"].includes(
        owner.snapshot().state
      )
    ) {
      throw new Error("The current call cannot be started from this state.");
    }
    abortOperations("call-starting");
    setRecordingError(null);
    if (owner.snapshot().state !== "start-failed") {
      detachRuntimeRecording(owner);
      owner = makeRuntime(options?.snapshot);
      runtimeRef.current = owner;
      recordingRef.current = null;
      recordingWriterRef.current = null;
      handoffServiceRef.current = null;
      audioRecordingManifestRef.current = null;
      audioRecordingDesiredRef.current = false;
      setAudioRecordingManifest(null);
      setAudioRecordingDesired(false);
      setAudioRecordingArmed(false);
      setAudioRecordingError(null);
      const recording = new CallRecordingProjection({
        callSessionId: owner.snapshot().callSessionId,
      });
      let recordingStarted = false;
      try {
        const status = await recording.start(Date.now());
        recordingStarted = true;
        setRecordingStatus(status);
        const handoff = await RuntimeHandoffService.open();
        await handoff.bind(owner.snapshot().preparation);
        recordingRef.current = recording;
        recordingWriterRef.current = createSessionBoundRecordingWriter({
          recording,
          onStatus: (nextStatus) => {
            if (recordingRef.current === recording) {
              setRecordingStatus(nextStatus);
            }
          },
          onError: (error) => {
            if (recordingRef.current === recording) {
              setRecordingError(errorMessage(error));
            }
          },
        });
        handoffServiceRef.current = handoff;
        bindRuntimeRecording(owner, handoff);
      } catch (error) {
        const abandoned = recordingStarted
          ? await recording.abandon(Date.now()).catch(() => null)
          : null;
        if (abandoned) setRecordingStatus(abandoned);
        if (recordingRef.current === recording) {
          recordingRef.current = null;
          recordingWriterRef.current = null;
          handoffServiceRef.current = null;
        }
        throw error;
      }
      const preparation = owner.snapshot().preparation;
      queueRecordingEvent("preparation-binding", {
        ...preparation,
        ...(preparation.mode === "prepared"
          ? {
              stt: { speechBiasTermCount: preparation.stt.speechBiasTerms.length },
              runtime: { objective: preparation.runtime.objective },
              advisor: { artifactCount: preparation.artifactIdsByTarget.advisor.length },
              postCall: { artifactCount: preparation.artifactIdsByTarget["post-call"].length },
            }
          : {}),
      }, preparation.boundAt);
      void refreshCallRecordings();
    } else if (options?.snapshot) {
      const preparation = owner.snapshot().preparation;
      if (
        preparation.mode !== "prepared" ||
        preparation.snapshotId !== options.snapshot.id ||
        preparation.snapshotContentHash !== options.snapshot.contentHash
      ) {
        throw new Error("Retry start cannot replace the CallSession preparation binding.");
      }
    }

    segmentLedgerRef.current = new AudioSegmentDispositionLedger();
    rolloverAssemblerRef.current = new RolloverTranscriptAssembler();
    queueMetricsRef.current = { depth: 0, maxDepth: 0, maxWaitMs: 0 };
    queueRef.current = Promise.resolve();
    owner.dispatch({ type: "StartCall", occurredAt: Date.now() });
    publish();
    try {
      await startCapture(owner);
    } catch (error) {
      if (owner.snapshot().state === "starting") {
        owner.dispatch({
          type: "StartFailed",
          error: errorMessage(error),
          occurredAt: Date.now(),
        });
        publish();
      }
    }
  }, [
    abortOperations,
    bindRuntimeRecording,
    detachRuntimeRecording,
    nativeRuntimeAvailable,
    publish,
    queueRecordingEvent,
    refreshCallRecordings,
    startCapture,
  ]);

  const stopNativeCapture = useCallback(async (): Promise<CaptureLease | null> => {
    if (
      !captureSessionIdRef.current ||
      captureGenerationRef.current == null
    ) {
      return null;
    }
    const lease: CaptureLease = {
      captureSessionId: captureSessionIdRef.current,
      captureGeneration: captureGenerationRef.current,
    };
    await invoke("stop_call_audio_session", {
      expectedCaptureSessionId: lease.captureSessionId,
      expectedCaptureGeneration: lease.captureGeneration,
    });
    return lease;
  }, []);

  const stopAndDrainCapture = useCallback(async () => {
    const lease = await stopNativeCapture();
    await drainCurrentAudioQueue();
    for (const family of rolloverAssemblerRef.current.abandonAll()) {
      recordingRef.current?.markIncomplete(
        `rollover-family-abandoned:${family.familyId}`
      );
      queueRecordingEvent("rollover-transcript-family", {
        ...family,
        status: "abandoned",
        reason: "capture-ended-before-logical-family-completed",
      });
    }
    releaseCaptureLease(lease);
  }, [
    drainCurrentAudioQueue,
    queueRecordingEvent,
    releaseCaptureLease,
    stopNativeCapture,
  ]);

  const startAudioRecording = useCallback(async () => {
    const owner = runtimeRef.current;
    const state = owner.snapshot().state;
    if (!["live", "paused"].includes(state)) {
      throw new Error("Start the call before recording audio evidence.");
    }
    audioRecordingDesiredRef.current = true;
    setAudioRecordingDesired(true);
    setAudioRecordingError(null);
    if (state === "paused") {
      setAudioRecordingArmed(true);
      queueRecordingEvent("audio-evidence-lifecycle", {
        eventType: "armed",
        reason: "manual-start-while-paused",
      });
      return;
    }
    try {
      await startAudioEvidenceForCapture(owner, "manual-start");
    } catch (error) {
      audioRecordingDesiredRef.current = false;
      setAudioRecordingDesired(false);
      setAudioRecordingArmed(false);
      setAudioRecordingError(errorMessage(error));
      throw error;
    }
  }, [queueRecordingEvent, startAudioEvidenceForCapture]);

  const stopAudioRecording = useCallback(async () => {
    const owner = runtimeRef.current;
    audioRecordingDesiredRef.current = false;
    setAudioRecordingDesired(false);
    setAudioRecordingArmed(false);
    try {
      await stopAudioEvidenceForCapture(owner, "manual-stop");
      setAudioRecordingError(null);
    } catch (error) {
      setAudioRecordingError(errorMessage(error));
      throw error;
    }
  }, [stopAudioEvidenceForCapture]);

  const pause = useCallback(async () => {
    let captureStopError: unknown;
    try {
      await stopAndDrainCapture();
    } catch (error) {
      captureStopError = error;
    }
    if (audioRecordingDesiredRef.current) {
      await stopAudioEvidenceForCapture(runtimeRef.current, "call-paused").catch(
        (error) => {
          setAudioRecordingError(errorMessage(error));
          recordingRef.current?.markIncomplete(
            `audio-evidence-pause-stop:${errorMessage(error)}`
          );
        }
      );
    }
    if (captureStopError) {
      audioRecordingDesiredRef.current = false;
      setAudioRecordingDesired(false);
      setAudioRecordingArmed(false);
      throw captureStopError;
    }
    abortOperations("call-paused");
    runtimeRef.current.dispatch({
      type: "PauseCall",
      occurredAt: Date.now(),
    });
    publish();
  }, [abortOperations, publish, stopAndDrainCapture, stopAudioEvidenceForCapture]);

  const resume = useCallback(async () => {
    const owner = runtimeRef.current;
    owner.dispatch({ type: "ResumeCall", occurredAt: Date.now() });
    publish();
    try {
      await startCapture(owner);
      if (audioRecordingDesiredRef.current) {
        await startAudioEvidenceForCapture(owner, "call-resumed").catch((error) =>
          setAudioRecordingError(errorMessage(error))
        );
      }
    } catch (error) {
      owner.dispatch({
        type: "RequireRecovery",
        error: errorMessage(error),
        occurredAt: Date.now(),
      });
      publish();
    }
  }, [publish, startAudioEvidenceForCapture, startCapture]);

  const closeActiveRecording = useCallback(
    async (owner: ActiveCallRuntime, retry: boolean) => {
      const recording = recordingRef.current;
      const writer = recordingWriterRef.current;
      const handoff = handoffServiceRef.current;
      if (!recording || recording.callSessionId !== owner.snapshot().callSessionId) {
        throw new Error("The active call recording is unavailable.");
      }
      if (!writer || writer.callSessionId !== recording.callSessionId || !handoff) {
        throw new Error("The active call evidence binding is unavailable.");
      }
      let handoffObserver: ActiveCallTransitionObserverBinding | null = null;
      try {
        await handoff.drain();
        const attemptedAt = Date.now();
        await writer.record(
          "call-close-attempt",
          {
            retry,
            attempt: (recording.status?.attempt ?? 0) + 1,
            pendingEventCount: recording.status?.eventCount ?? 0,
            recordingHealth: recording.status?.health ?? "healthy",
          },
          attemptedAt
        );
        await recording.drain();
        detachRuntimeRecording(owner);
        handoffObserver = owner.bindTransitionObserver(
          `runtime-handoff:${owner.snapshot().callSessionId}`,
          (transition) => {
            handoff.recordTransition(transition);
          }
        );
        const status = retry
          ? await recording.retryClose(Date.now())
          : await recording.close(Date.now());
        setRecordingStatus(status);
        owner.dispatch({ type: "CloseSucceeded", occurredAt: Date.now() });
        publish();
        await handoff.drain();
        handoffObserver.detach();
        handoffObserver = null;
        setRecordingError(null);
        void refreshCallRecordings();
      } catch (error) {
        handoffObserver?.detach();
        handoffObserver = null;
        const runtimeState = owner.snapshot().state;
        if (runtimeState === "closing") {
          bindRuntimeRecording(owner, handoff);
          owner.dispatch({
            type: "CloseFailed",
            error: errorMessage(error),
            occurredAt: Date.now(),
          });
          await recording.drain();
          await handoff.drain().catch(() => undefined);
          setRecordingError(errorMessage(error));
        } else {
          setRecordingError(
            `Call closed, but its runtime projection could not finish: ${errorMessage(error)}`
          );
        }
        await refreshRecoverableRecordings();
        await refreshCallRecordings();
        publish();
        throw error;
      }
      publish();
    },
    [
      bindRuntimeRecording,
      detachRuntimeRecording,
      publish,
      refreshCallRecordings,
      refreshRecoverableRecordings,
    ]
  );

  const end = useCallback(async () => {
    const owner = runtimeRef.current;
    let captureStopError: unknown;
    try {
      await stopAndDrainCapture();
    } catch (error) {
      captureStopError = error;
      recordingRef.current?.markIncomplete(
        `native-capture-stop:${errorMessage(error)}`
      );
    }
    await stopAudioEvidenceForCapture(owner, "call-ended").catch((error) => {
      setAudioRecordingError(errorMessage(error));
      recordingRef.current?.markIncomplete(
        `audio-evidence-stop:${errorMessage(error)}`
      );
    });
    audioRecordingDesiredRef.current = false;
    setAudioRecordingDesired(false);
    setAudioRecordingArmed(false);
    if (captureStopError) throw captureStopError;
    abortOperations("call-closing");
    owner.dispatch({ type: "CloseCall", occurredAt: Date.now() });
    publish();
    await closeActiveRecording(owner, false);
  }, [
    abortOperations,
    closeActiveRecording,
    publish,
    stopAndDrainCapture,
    stopAudioEvidenceForCapture,
  ]);

  const prepareForExit = useCallback(async () => {
    const owner = runtimeRef.current;
    if (owner.snapshot().state === "starting") {
      owner.dispatch({
        type: "StartFailed",
        error: "Application exit requested while audio capture was starting.",
        occurredAt: Date.now(),
      });
      publish();
    }
    if (
      ["live", "paused", "recovering", "start-failed"].includes(
        owner.snapshot().state
      )
    ) {
      await end();
    }
    const finalState = runtimeRef.current.snapshot().state;
    const finalRecordingState = recordingRef.current?.status?.state;
    if (["closing", "close-failed"].includes(finalState)) {
      throw new Error("Close the active call recording before quitting MOSS.");
    }
    if (
      finalRecordingState &&
      !["closed", "abandoned"].includes(finalRecordingState)
    ) {
      throw new Error("The active call recording has not reached a terminal state.");
    }
  }, [end, publish]);

  const retryClose = useCallback(async () => {
    const owner = runtimeRef.current;
    owner.dispatch({ type: "RetryCloseCall", occurredAt: Date.now() });
    publish();
    await closeActiveRecording(owner, true);
  }, [closeActiveRecording, publish]);

  const abandonClose = useCallback(async () => {
    const owner = runtimeRef.current;
    const recording = recordingRef.current;
    if (!recording || recording.callSessionId !== owner.snapshot().callSessionId) {
      throw new Error("The active call recording is unavailable.");
    }
    owner.dispatch({ type: "AbandonCall", occurredAt: Date.now() });
    await recording.drain();
    await handoffServiceRef.current?.drain();
    const status = await recording.abandon(Date.now());
    setRecordingStatus(status);
    detachRuntimeRecording(owner);
    setRecordingError(null);
    void refreshCallRecordings();
    publish();
  }, [detachRuntimeRecording, publish, refreshCallRecordings]);

  const retryRecoveredRecording = useCallback(
    async (callSessionId: string) => {
      await retryRecoveredCallRecording(callSessionId);
      await refreshRecoverableRecordings();
      await refreshCallRecordings();
    },
    [refreshCallRecordings, refreshRecoverableRecordings]
  );

  const abandonRecoveredRecording = useCallback(
    async (callSessionId: string) => {
      await abandonRecoveredCallRecording(callSessionId);
      await refreshRecoverableRecordings();
      await refreshCallRecordings();
    },
    [refreshCallRecordings, refreshRecoverableRecordings]
  );

  const requestGuidance = useCallback(async () => {
    const owner = runtimeRef.current;
    abortOperations("manual-guidance-request");
    owner.dispatch({
      type: "RecordHumanOverride",
      reason: "manual-guidance-request",
      occurredAt: Date.now(),
    });
    publish();
    await executeAdvisor(owner, true);
  }, [abortOperations, executeAdvisor, publish]);

  const evaluateGuidance = useCallback(
    async (label: GuidanceEvaluationLabel) => {
      const owner = runtimeRef.current;
      const snapshot = owner.snapshot();
      if (!snapshot.visibleGuidance || snapshot.guidanceRevision < 1) {
        throw new Error("There is no visible guidance to evaluate.");
      }
      if (
        snapshot.humanEvaluations.some(
          (fact) => fact.guidanceRevision === snapshot.guidanceRevision
        )
      ) {
        return;
      }
      const fact = {
        id: `guidance-evaluation_${crypto.randomUUID()}`,
        callSessionId: snapshot.callSessionId,
        guidanceRevision: snapshot.guidanceRevision,
        label,
        occurredAt: Date.now(),
      };
      owner.dispatch({ type: "RecordHumanEvaluation", fact });
      queueRecordingEvent("human-evaluation", fact, fact.occurredAt);
      publish();
    },
    [publish, queueRecordingEvent]
  );

  const saveConfiguration = useCallback(
    async (next: ModelRouteSettings, secrets: ProviderSecrets) => {
      const saved = normalizeModelRouteSettings({
        ...next,
        revision: settingsRef.current.revision + 1,
      });
      const chatRoutes = ["runtime", "advisor", "complex"] as const;
      for (const route of chatRoutes) {
        const provider = getChatProvider(saved.chat[route].provider);
        const providerChanged =
          saved.chat[route].provider !==
          settingsRef.current.chat[route].provider;
        if (
          providerChanged &&
          provider.requiresApiKey &&
          !secrets[route].trim()
        ) {
          throw new Error(
            `Enter the ${provider.name} API key after changing the ${route} provider.`
          );
        }
      }
      const sttProvider = getSttProvider(saved.stt.provider);
      const sttProviderChanged =
        saved.stt.provider !== settingsRef.current.stt.provider;
      if (
        sttProviderChanged &&
        sttProvider.requiresApiKey &&
        !secrets.stt.trim()
      ) {
        throw new Error(
          `Enter the ${sttProvider.name} API key after changing the STT provider.`
        );
      }
      const previousSecrets = { ...secretsRef.current };
      const mergedSecrets = { ...previousSecrets };
      const changedRoutes = (Object.keys(secrets) as Array<keyof ProviderSecrets>)
        .filter((route) => Boolean(secrets[route].trim()));
      for (const route of changedRoutes) {
        mergedSecrets[route] = secrets[route].trim();
      }
      try {
        await commitProviderConfigurationTransaction({
          revision: saved.revision,
          previousSecrets,
          nextSecrets: mergedSecrets,
          changedRoutes,
          commitSettings: () => saveModelRouteSettings(saved),
          onEvent: (event) =>
            queueRecordingEvent("credential-transaction", event),
        });
      } catch (error) {
        setCredentialError(errorMessage(error));
        throw error;
      }
      settingsRef.current = saved;
      setSettings(saved);
      secretsRef.current = mergedSecrets;
      setCredentialError(null);
      setConfigured({
        runtime:
          !getChatProvider(saved.chat.runtime.provider).requiresApiKey ||
          Boolean(mergedSecrets.runtime),
        advisor:
          !getChatProvider(saved.chat.advisor.provider).requiresApiKey ||
          Boolean(mergedSecrets.advisor),
        complex:
          !getChatProvider(saved.chat.complex.provider).requiresApiKey ||
          Boolean(mergedSecrets.complex),
        stt:
          !getSttProvider(saved.stt.provider).requiresApiKey ||
          Boolean(mergedSecrets.stt),
      });
      queueRecordingEvent("model-settings-updated", {
        revision: saved.revision,
        routes: {
          runtime: {
            provider: saved.chat.runtime.provider,
            endpoint: saved.chat.runtime.endpoint,
            model: saved.chat.runtime.model,
          },
          advisor: {
            provider: saved.chat.advisor.provider,
            endpoint: saved.chat.advisor.endpoint,
            model: saved.chat.advisor.model,
          },
          complex: {
            provider: saved.chat.complex.provider,
            endpoint: saved.chat.complex.endpoint,
            model: saved.chat.complex.model,
          },
          stt: {
            provider: saved.stt.provider,
            endpoint: saved.stt.endpoint,
            model: saved.stt.model,
            language: saved.stt.language,
          },
        },
      });
      return saved;
    },
    [queueRecordingEvent]
  );

  const recordShortcutAction = useCallback(
    (payload: {
      action: string;
      accelerator: string;
      outcome: "triggered" | "completed" | "ignored" | "failed";
      detail?: string;
      shortcutSchemeVersion?: number;
    }) => {
      queueRecordingEvent("shortcut-action", payload);
    },
    [queueRecordingEvent]
  );

  const recordInterfaceAction = useCallback(
    (payload: {
      action: "switch-mode" | "quit" | "set-stealth-mode";
      source: "ui" | "shortcut" | "system";
      outcome: "requested" | "completed" | "failed";
      detail?: string;
    }) => {
      queueRecordingEvent("interface-action", payload);
    },
    [queueRecordingEvent]
  );

  const saveAudioConfiguration = useCallback(
    async (next: AudioSettings) => {
      const state = runtimeRef.current.snapshot().state;
      if (["starting", "live", "recovering", "closing"].includes(state)) {
        throw new Error("Pause the active call before applying audio settings.");
      }
      const saved = {
        ...structuredClone(next),
        revision: audioSettingsRef.current.revision + 1,
      };
      await updateNativeVadConfig(saved.vadConfig);
      persistAudioSettings(saved);
      audioSettingsRef.current = saved;
      setAudioSettings(saved);
      queueRecordingEvent("audio-settings-updated", {
        revision: saved.revision,
        inputDeviceId: saved.inputDeviceId,
        outputDeviceId: saved.outputDeviceId,
        profile: saved.profile,
        vadConfig: saved.vadConfig,
        appliesOnNextCaptureGeneration: state === "paused",
      });
      return saved;
    },
    [queueRecordingEvent]
  );

  useEffect(() => {
    const owner = runtimeRef.current;
    const handoff = handoffServiceRef.current;
    if (handoff && captureEvidenceBinding(owner)) {
      bindRuntimeRecording(owner, handoff, "calling-ui-mounted");
    }
    return () => {
      const activeOwner = runtimeRef.current;
      const state = activeOwner.snapshot().state;
      abortOperations("calling-ui-unmounted");
      if (
        ["starting", "live", "paused", "recovering", "closing", "close-failed"].includes(
          state
        )
      ) {
        discloseRuntimeProjectionGap(activeOwner, "calling-ui-unmounted");
      }
      detachRuntimeRecording(activeOwner);
    };
  }, [
    abortOperations,
    bindRuntimeRecording,
    captureEvidenceBinding,
    detachRuntimeRecording,
    discloseRuntimeProjectionGap,
  ]);

  return {
    nativeRuntimeAvailable,
    runtime,
    settings,
    audioSettings,
    configured,
    credentialError,
    recordingStatus,
    recordingError,
    recoverableRecordings,
    callRecordings,
    audioRecordingManifest,
    audioRecordingDesired,
    audioRecordingArmed,
    audioRecordingError,
    start,
    startAudioRecording,
    stopAudioRecording,
    pause,
    resume,
    end,
    prepareForExit,
    retryClose,
    abandonClose,
    retryRecoveredRecording,
    abandonRecoveredRecording,
    refreshCallRecordings,
    requestGuidance,
    evaluateGuidance,
    saveConfiguration,
    saveAudioConfiguration,
    recordShortcutAction,
    recordInterfaceAction,
  };
}

export type CallingAssistantController = ReturnType<typeof useCallingAssistant>;
export type CallingProviderSecrets = ProviderSecrets;
