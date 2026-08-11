import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ActiveCallRuntime,
  AudioSegmentDispositionLedger,
  CallRecordingProjection,
  OperationAbortError,
  abandonRecoveredCallRecording,
  loadAudioSettings,
  authorizeNativeSpeechSegment,
  createCancellableOperation,
  listCallRecordings,
  listRecoverableCallRecordings,
  loadModelRouteSettings,
  loadProviderSecret,
  requestTranscription,
  retryRecoveredCallRecording,
  runAdvisorModelOperation,
  runRuntimeModelOperation,
  persistAudioSettings,
  saveModelRouteSettings,
  saveProviderSecret,
  updateNativeVadConfig,
  type ActiveCallRuntimeState,
  type ActiveCallTransition,
  type AudioSettings,
  type CallRecordingEventKind,
  type CallRecordingStatus,
  type CallRecordingSummary,
  type CallTurnSettlement,
  type GuidanceEvaluationLabel,
  type ModelRouteSettings,
  type NativeSpeechSegment,
} from "@/lib/calling";

interface NativeCallAudioStatus {
  active: boolean;
  captureSessionId?: string;
  captureGeneration?: number;
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

const blankSecrets = (): ProviderSecrets => ({
  runtime: "",
  advisor: "",
  complex: "",
  stt: "",
});

const makeRuntime = () =>
  new ActiveCallRuntime({ callSessionId: `call_${crypto.randomUUID()}` });

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
  quietCycles = 3
) {
  let observed = currentQueue();
  let stableCycles = 0;
  while (stableCycles < quietCycles) {
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
  const captureSessionIdRef = useRef<string | null>(null);
  const captureGenerationRef = useRef<number | null>(null);
  const lastSegmentSequenceRef = useRef(0);
  const segmentLedgerRef = useRef(new AudioSegmentDispositionLedger());
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const activeOperationsRef = useRef(
    new Set<{ cancel: (reason: string) => boolean }>()
  );
  const recordingRef = useRef<CallRecordingProjection | null>(null);
  const [recordingStatus, setRecordingStatus] =
    useState<CallRecordingStatus | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [recoverableRecordings, setRecoverableRecordings] = useState<
    CallRecordingStatus[]
  >([]);
  const [callRecordings, setCallRecordings] = useState<
    CallRecordingSummary[]
  >([]);

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
      const recording = recordingRef.current;
      if (!recording) return null;
      try {
        const status = await recording.append(kind, payload, occurredAt);
        if (recordingRef.current === recording && status) {
          setRecordingStatus(status);
        }
        return status;
      } catch (error) {
        setRecordingError(errorMessage(error));
        throw error;
      }
    },
    []
  );

  const queueRecordingEvent = useCallback(
    (kind: CallRecordingEventKind, payload: unknown, occurredAt = Date.now()) => {
      void recordEvent(kind, payload, occurredAt).catch(() => undefined);
    },
    [recordEvent]
  );

  const bindRuntimeRecording = useCallback(
    (owner: ActiveCallRuntime) => {
      owner.setTransitionObserver((transition) => {
        if (
          runtimeRef.current !== owner ||
          recordingRef.current?.callSessionId !==
            transition.after.callSessionId
        ) {
          return;
        }
        queueRecordingEvent(
          "runtime-command",
          transitionPayload(transition),
          transition.after.updatedAt
        );
      });
    },
    [queueRecordingEvent]
  );

  const refreshRecoverableRecordings = useCallback(async () => {
    try {
      setRecoverableRecordings(await listRecoverableCallRecordings());
    } catch (error) {
      setRecordingError(errorMessage(error));
    }
  }, []);

  const refreshCallRecordings = useCallback(async () => {
    try {
      setCallRecordings(await listCallRecordings());
    } catch (error) {
      setRecordingError(errorMessage(error));
    }
  }, []);

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
    const [runtimeKey, advisor, complex, stt] = await Promise.all([
      loadProviderSecret("runtime"),
      loadProviderSecret("advisor"),
      loadProviderSecret("complex"),
      loadProviderSecret("stt"),
    ]);
    secretsRef.current = { runtime: runtimeKey, advisor, complex, stt };
    setConfigured({
      runtime: Boolean(runtimeKey),
      advisor: Boolean(advisor),
      complex: Boolean(complex),
      stt: Boolean(stt),
    });
  }, []);

  useEffect(() => {
    void refreshSecrets();
    void refreshRecoverableRecordings();
    void refreshCallRecordings();
  }, [refreshCallRecordings, refreshRecoverableRecordings, refreshSecrets]);

  const executeAdvisor = useCallback(
    async (owner: ActiveCallRuntime, force = false) => {
      const snapshot = owner.snapshot();
      if (!force && !snapshot.latestSettlement?.responseAuthorized) return;
      const apiKey = secretsRef.current.advisor;
      if (!apiKey) return;
      await runAdvisorModelOperation({
        owner,
        apiKey,
        route: settingsRef.current.chat.advisor,
        isCurrentOwner: () => runtimeRef.current === owner,
        publish,
        register: (operation) => activeOperationsRef.current.add(operation),
        unregister: (operation) => activeOperationsRef.current.delete(operation),
        record: queueRecordingEvent,
      });
    },
    [publish, queueRecordingEvent]
  );

  const settleTurn = useCallback(
    async (
      owner: ActiveCallRuntime,
      text: string,
      momentUnitId: string
    ) => {
      const snapshot = owner.snapshot();
      let settlement = fallbackSettlement({
        text,
        callSessionId: snapshot.callSessionId,
        momentUnitId,
        evidenceRevision: snapshot.evidenceRevision,
      });
      const apiKey = secretsRef.current.runtime;
      if (apiKey) {
        const outcome = await runRuntimeModelOperation({
          owner,
          apiKey,
          route: settingsRef.current.chat.runtime,
          momentUnitId,
          isCurrentOwner: () => runtimeRef.current === owner,
          publish,
          register: (operation) => activeOperationsRef.current.add(operation),
          unregister: (operation) => activeOperationsRef.current.delete(operation),
          record: queueRecordingEvent,
        });
        if (outcome.status === "settled") settlement = outcome.settlement;
        if (outcome.status === "cancelled" || outcome.status === "stale") return;
      }
      if (runtimeRef.current !== owner) return;
      owner.dispatch({ type: "ApplyRuntimeSettlement", settlement });
      publish();
      if (settlement.responseAuthorized) void executeAdvisor(owner);
    },
    [executeAdvisor, publish, queueRecordingEvent]
  );

  const processSegment = useCallback(
    async (owner: ActiveCallRuntime, segment: NativeSpeechSegment) => {
      const identity = {
        captureSessionId: segment.captureSessionId,
        captureGeneration: segment.captureGeneration,
        segmentSequence: segment.segmentSequence,
      };
      const observedAt = Date.now();
      segmentLedgerRef.current.observe({ identity, observedAt });
      queueRecordingEvent(
        "audio-segment-observed",
        segmentMetadata(segment),
        observedAt
      );
      const sttSecret = secretsRef.current.stt;
      if (!sttSecret) {
        const result = segmentLedgerRef.current.settle({
          identity,
          disposition: "failed",
          settledAt: Date.now(),
        });
        queueRecordingEvent("audio-segment-settled", {
          ...identity,
          ...result,
          reason: "stt-provider-not-configured",
        });
        return;
      }

      const operationId = `stt_${segment.captureSessionId}_${segment.segmentSequence}`;
      const dispatchedAt = Date.now();
      queueRecordingEvent(
        "stt-operation-dispatched",
        {
          operationId,
          ...identity,
          endpoint: settingsRef.current.stt.endpoint,
          model: settingsRef.current.stt.model,
          language: settingsRef.current.stt.language,
          modelConfigRevision: settingsRef.current.revision,
          durationMs: segment.durationMs,
          endReason: segment.endReason,
        },
        dispatchedAt
      );
      const operation = createCancellableOperation({
        operationId,
        timeoutMs: 30_000,
        execute: (signal) =>
          requestTranscription({
            route: settingsRef.current.stt,
            apiKey: sttSecret,
            audio: audioBlob(segment.audioBase64, segment.mediaType),
            signal,
          }),
      });
      activeOperationsRef.current.add(operation);
      try {
        const text = await operation.promise;
        const returnedAt = Date.now();
        queueRecordingEvent(
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
        if (
          runtimeRef.current !== owner ||
          owner.snapshot().state !== "live"
        ) {
          const result = segmentLedgerRef.current.settle({
            identity,
            disposition: "stale",
            settledAt: returnedAt,
          });
          queueRecordingEvent("audio-segment-settled", {
            ...identity,
            ...result,
            reason: "runtime-owner-or-state-changed",
          });
          return;
        }
        const result = segmentLedgerRef.current.settle({
          identity,
          disposition: "accepted",
          settledAt: returnedAt,
        });
        queueRecordingEvent("audio-segment-settled", {
          ...identity,
          ...result,
        });
        const momentUnitId = `moment_${crypto.randomUUID()}`;
        owner.dispatch({
          type: "SubmitTranscriptTurn",
          momentUnitId,
          turn: {
            id: `turn_${crypto.randomUUID()}`,
            speaker: "them",
            text,
            occurredAt: returnedAt,
          },
        });
        publish();
        await settleTurn(owner, text, momentUnitId);
      } catch (error) {
        const failedAt = Date.now();
        queueRecordingEvent(
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
        queueRecordingEvent("audio-segment-settled", {
          ...identity,
          ...result,
          reason: errorMessage(error),
        });
      } finally {
        activeOperationsRef.current.delete(operation);
      }
    },
    [publish, queueRecordingEvent, settleTurn]
  );

  const releaseCaptureLease = useCallback((lease: CaptureLease | null) => {
    if (
      lease &&
      captureSessionIdRef.current === lease.captureSessionId &&
      captureGenerationRef.current === lease.captureGeneration
    ) {
      captureSessionIdRef.current = null;
      captureGenerationRef.current = null;
    }
  }, []);

  const drainCurrentAudioQueue = useCallback(async () => {
    await drainQueueUntilStable(() => queueRef.current);
  }, []);

  useEffect(() => {
    let disposed = false;
    let stopSpeech: (() => void) | undefined;
    let stopLifecycle: (() => void) | undefined;

    void listen<unknown>("speech-detected", (event) => {
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
      queueRef.current = queueRef.current
        .catch(() => undefined)
        .then(() => processSegment(owner, authorization.event));
    }).then((stop) => {
      if (disposed) stop();
      else stopSpeech = stop;
    });

    void listen<NativeAudioLifecycleEvent>(
      "capture-lifecycle",
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
        void drainCurrentAudioQueue().then(() => {
          if (disposed || runtimeRef.current !== owner) return;
          const state = owner.snapshot().state;
          if (!["live", "starting", "recovering"].includes(state)) return;
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
      stopLifecycle?.();
    };
  }, [
    abortOperations,
    drainCurrentAudioQueue,
    processSegment,
    publish,
    queueRecordingEvent,
    releaseCaptureLease,
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
      captureSessionIdRef.current = status.captureSessionId;
      captureGenerationRef.current = status.captureGeneration;
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
        outputDeviceId: audioSettingsRef.current.outputDeviceId,
        vadConfig: audioSettingsRef.current.vadConfig,
      });
      owner.dispatch({ type: "CaptureStarted", occurredAt: Date.now() });
      publish();
    },
    [publish, queueRecordingEvent]
  );

  const start = useCallback(async () => {
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
      owner.setTransitionObserver(undefined);
      owner = makeRuntime();
      runtimeRef.current = owner;
      const recording = new CallRecordingProjection({
        callSessionId: owner.snapshot().callSessionId,
      });
      recordingRef.current = recording;
      const status = await recording.start(Date.now());
      setRecordingStatus(status);
      bindRuntimeRecording(owner);
      void refreshCallRecordings();
    }

    segmentLedgerRef.current = new AudioSegmentDispositionLedger();
    queueRef.current = Promise.resolve();
    owner.dispatch({ type: "StartCall", occurredAt: Date.now() });
    publish();
    try {
      await startCapture(owner);
    } catch (error) {
      owner.dispatch({
        type: "StartFailed",
        error: errorMessage(error),
        occurredAt: Date.now(),
      });
      publish();
    }
  }, [abortOperations, bindRuntimeRecording, publish, refreshCallRecordings, startCapture]);

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
    releaseCaptureLease(lease);
  }, [drainCurrentAudioQueue, releaseCaptureLease, stopNativeCapture]);

  const pause = useCallback(async () => {
    await stopAndDrainCapture();
    abortOperations("call-paused");
    runtimeRef.current.dispatch({
      type: "PauseCall",
      occurredAt: Date.now(),
    });
    publish();
  }, [abortOperations, publish, stopAndDrainCapture]);

  const resume = useCallback(async () => {
    const owner = runtimeRef.current;
    owner.dispatch({ type: "ResumeCall", occurredAt: Date.now() });
    publish();
    try {
      await startCapture(owner);
    } catch (error) {
      owner.dispatch({
        type: "RequireRecovery",
        error: errorMessage(error),
        occurredAt: Date.now(),
      });
      publish();
    }
  }, [publish, startCapture]);

  const closeActiveRecording = useCallback(
    async (owner: ActiveCallRuntime, retry: boolean) => {
      const recording = recordingRef.current;
      if (!recording || recording.callSessionId !== owner.snapshot().callSessionId) {
        throw new Error("The active call recording is unavailable.");
      }
      const attemptedAt = Date.now();
      await recordEvent(
        "call-close-attempt",
        {
          retry,
          attempt: (recording.status?.attempt ?? 0) + 1,
          pendingEventCount: recording.status?.eventCount ?? 0,
        },
        attemptedAt
      );
      try {
        const status = retry
          ? await recording.retryClose(Date.now())
          : await recording.close(Date.now());
        setRecordingStatus(status);
        owner.setTransitionObserver(undefined);
        owner.dispatch({ type: "CloseSucceeded", occurredAt: Date.now() });
        setRecordingError(null);
        void refreshCallRecordings();
      } catch (error) {
        owner.dispatch({
          type: "CloseFailed",
          error: errorMessage(error),
          occurredAt: Date.now(),
        });
        setRecordingError(errorMessage(error));
        await refreshRecoverableRecordings();
        await refreshCallRecordings();
        publish();
        throw error;
      }
      publish();
    },
    [publish, recordEvent, refreshCallRecordings, refreshRecoverableRecordings]
  );

  const end = useCallback(async () => {
    const owner = runtimeRef.current;
    await stopAndDrainCapture();
    abortOperations("call-closing");
    owner.dispatch({ type: "CloseCall", occurredAt: Date.now() });
    publish();
    await closeActiveRecording(owner, false);
  }, [abortOperations, closeActiveRecording, publish, stopAndDrainCapture]);

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
    const status = await recording.abandon(Date.now());
    setRecordingStatus(status);
    owner.setTransitionObserver(undefined);
    setRecordingError(null);
    void refreshCallRecordings();
    publish();
  }, [publish, refreshCallRecordings]);

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
    owner.dispatch({
      type: "RecordHumanOverride",
      reason: "manual-guidance-request",
      occurredAt: Date.now(),
    });
    publish();
    await executeAdvisor(owner, true);
  }, [executeAdvisor, publish]);

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
      const saved = {
        ...structuredClone(next),
        revision: settingsRef.current.revision + 1,
      };
      saveModelRouteSettings(saved);
      const mergedSecrets = { ...secretsRef.current };
      await Promise.all(
        (Object.keys(secrets) as Array<keyof ProviderSecrets>).map(
          async (route) => {
            if (!secrets[route].trim()) return;
            mergedSecrets[route] = secrets[route].trim();
            await saveProviderSecret(route, mergedSecrets[route]);
          }
        )
      );
      settingsRef.current = saved;
      setSettings(saved);
      secretsRef.current = mergedSecrets;
      setConfigured({
        runtime: Boolean(mergedSecrets.runtime),
        advisor: Boolean(mergedSecrets.advisor),
        complex: Boolean(mergedSecrets.complex),
        stt: Boolean(mergedSecrets.stt),
      });
      queueRecordingEvent("model-settings-updated", {
        revision: saved.revision,
        routes: {
          runtime: {
            endpoint: saved.chat.runtime.endpoint,
            model: saved.chat.runtime.model,
          },
          advisor: {
            endpoint: saved.chat.advisor.endpoint,
            model: saved.chat.advisor.model,
          },
          complex: {
            endpoint: saved.chat.complex.endpoint,
            model: saved.chat.complex.model,
          },
          stt: {
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
      action: "switch-mode" | "hide" | "quit";
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

  useEffect(
    () => () => {
      abortOperations("calling-ui-unmounted");
      runtimeRef.current.setTransitionObserver(undefined);
    },
    [abortOperations]
  );

  return {
    runtime,
    settings,
    audioSettings,
    configured,
    recordingStatus,
    recordingError,
    recoverableRecordings,
    callRecordings,
    start,
    pause,
    resume,
    end,
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
