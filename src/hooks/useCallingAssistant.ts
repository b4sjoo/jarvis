import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ActiveCallRuntime,
  ADVISOR_SYSTEM_PROMPT,
  AudioSegmentDispositionLedger,
  RUNTIME_SYSTEM_PROMPT,
  authorizeNativeSpeechSegment,
  buildBoundedCallingContext,
  createCancellableOperation,
  createOperationLease,
  loadModelRouteSettings,
  loadProviderSecret,
  parseGuidanceFrame,
  parseRuntimeSettlement,
  requestChatCompletion,
  requestTranscription,
  saveModelRouteSettings,
  saveProviderSecret,
  sha256,
  type ActiveCallRuntimeState,
  type CallTurnSettlement,
  type ModelRouteSettings,
  type NativeSpeechSegment,
} from "@/lib/calling";

interface NativeCallAudioStatus {
  active: boolean;
  captureSessionId?: string;
  captureGeneration?: number;
}

interface ProviderSecrets {
  runtime: string;
  advisor: string;
  complex: string;
  stt: string;
}

const blankSecrets = (): ProviderSecrets => ({ runtime: "", advisor: "", complex: "", stt: "" });

const makeRuntime = () =>
  new ActiveCallRuntime({ callSessionId: `call_${crypto.randomUUID()}` });

const audioBlob = (base64: string, mediaType: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mediaType });
};

const fallbackSettlement = (input: {
  text: string;
  callSessionId: string;
  momentUnitId: string;
  evidenceRevision: number;
}) => {
  const normalized = input.text.trim().toLowerCase();
  const directQuestion = /\?$/.test(normalized) || /^(?:can|could|would|will|do|does|did|is|are|what|when|where|why|how|which|who)\b/.test(normalized);
  const directRequest = /^(?:please\s+)?(?:tell|explain|confirm|check|send|share|walk|help|give|provide|show)\b/.test(normalized);
  return {
    callSessionId: input.callSessionId,
    momentUnitId: input.momentUnitId,
    evidenceRevision: input.evidenceRevision,
    disposition: directQuestion || directRequest ? "actionable" as const : "context-only" as const,
    counterpartyMove: directQuestion ? "question" as const : directRequest ? "request" as const : "informational" as const,
    phaseSignal: "none" as const,
    candidateUpdates: [],
    responseAuthorized: directQuestion || directRequest,
    settledAt: Date.now(),
  };
};

export function useCallingAssistant() {
  const runtimeRef = useRef(makeRuntime());
  const [runtime, setRuntime] = useState<ActiveCallRuntimeState>(() => runtimeRef.current.snapshot());
  const [settings, setSettings] = useState<ModelRouteSettings>(() => loadModelRouteSettings());
  const settingsRef = useRef(settings);
  const secretsRef = useRef<ProviderSecrets>(blankSecrets());
  const [configured, setConfigured] = useState<Record<keyof ProviderSecrets, boolean>>({ runtime: false, advisor: false, complex: false, stt: false });
  const captureSessionIdRef = useRef<string | null>(null);
  const captureGenerationRef = useRef<number | null>(null);
  const lastSegmentSequenceRef = useRef(0);
  const segmentLedgerRef = useRef(new AudioSegmentDispositionLedger());
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const activeOperationsRef = useRef(new Set<{ cancel: (reason: string) => boolean }>());

  const publish = useCallback(() => setRuntime(runtimeRef.current.snapshot()), []);

  const abortOperations = useCallback((reason: string) => {
    for (const operation of activeOperationsRef.current) operation.cancel(reason);
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
    setConfigured({ runtime: Boolean(runtimeKey), advisor: Boolean(advisor), complex: Boolean(complex), stt: Boolean(stt) });
  }, []);

  useEffect(() => {
    void refreshSecrets();
  }, [refreshSecrets]);

  const executeAdvisor = useCallback(async (owner: ActiveCallRuntime, force = false) => {
    const snapshot = owner.snapshot();
    if (!force && !snapshot.latestSettlement?.responseAuthorized) return;
    const secret = secretsRef.current.advisor;
    if (!secret) throw new Error("Configure the Advisor model before requesting guidance.");
    const context = buildBoundedCallingContext({ turns: snapshot.transcript, maxChars: 6_000 });
    const operationId = `advisor_${crypto.randomUUID()}`;
    const contextJson = JSON.stringify(context);
    const envelope = owner.selectOperation({
      operationId,
      operationKind: "guidance",
      route: "advisor",
      contextSnapshotHash: await sha256(contextJson),
      timeoutMs: settingsRef.current.chat.advisor.timeoutMs,
      input: context,
    });
    owner.dispatch({ type: "RecordReceipt", receipt: { requestId: operationId, status: "selected", occurredAt: Date.now() } });
    publish();
    const operation = createCancellableOperation({
      operationId,
      timeoutMs: envelope.timeoutMs,
      execute: (signal) => requestChatCompletion({
        route: settingsRef.current.chat.advisor,
        apiKey: secret,
        messages: [
          { role: "system", content: ADVISOR_SYSTEM_PROMPT },
          { role: "user", content: `Bounded call context:\n${contextJson}` },
        ],
        signal,
      }),
    });
    activeOperationsRef.current.add(operation);
    owner.dispatch({ type: "RecordReceipt", receipt: { requestId: operationId, status: "dispatched", occurredAt: Date.now() } });
    publish();
    try {
      const raw = await operation.promise;
      if (runtimeRef.current !== owner) return;
      owner.dispatch({ type: "RecordReceipt", receipt: { requestId: operationId, status: "provider-returned", occurredAt: Date.now() } });
      const frame = parseGuidanceFrame(raw);
      const authorization = owner.authorize(createOperationLease({ envelope }), "advisor");
      owner.dispatch({ type: "RecordReceipt", receipt: { requestId: operationId, status: authorization.authorized ? "commit-authorized" : "stale", occurredAt: Date.now(), reason: authorization.authorized ? undefined : authorization.reason } });
      owner.commitGuidance({ envelope, frame });
      publish();
    } catch (error) {
      if (runtimeRef.current === owner) {
        owner.dispatch({ type: "RecordReceipt", receipt: { requestId: operationId, status: "failed", occurredAt: Date.now(), reason: error instanceof Error ? error.message : String(error) } });
        publish();
      }
    } finally {
      activeOperationsRef.current.delete(operation);
    }
  }, [publish]);

  const settleTurn = useCallback(async (owner: ActiveCallRuntime, text: string, momentUnitId: string) => {
    const snapshot = owner.snapshot();
    const secret = secretsRef.current.runtime;
    let settlement: CallTurnSettlement = fallbackSettlement({
      text,
      callSessionId: snapshot.callSessionId,
      momentUnitId,
      evidenceRevision: snapshot.evidenceRevision,
    });
    if (secret) {
      const context = buildBoundedCallingContext({ turns: snapshot.transcript, maxChars: 3_200 });
      const contextJson = JSON.stringify(context);
      const operationId = `runtime_${crypto.randomUUID()}`;
      const envelope = owner.selectOperation({
        operationId,
        operationKind: "turn-settlement",
        route: "runtime",
        contextSnapshotHash: await sha256(contextJson),
        timeoutMs: settingsRef.current.chat.runtime.timeoutMs,
        input: context,
      });
      const operation = createCancellableOperation({
        operationId,
        timeoutMs: envelope.timeoutMs,
        execute: (signal) => requestChatCompletion({
          route: settingsRef.current.chat.runtime,
          apiKey: secret,
          messages: [
            { role: "system", content: RUNTIME_SYSTEM_PROMPT },
            { role: "user", content: `Bounded call evidence:\n${contextJson}` },
          ],
          signal,
        }),
      });
      activeOperationsRef.current.add(operation);
      try {
        const raw = await operation.promise;
        if (runtimeRef.current !== owner || !owner.authorize(createOperationLease({ envelope }), "runtime").authorized) return;
        settlement = parseRuntimeSettlement({
          raw,
          callSessionId: snapshot.callSessionId,
          momentUnitId,
          evidenceRevision: snapshot.evidenceRevision,
          settledAt: Date.now(),
        });
      } catch {
        // A fast model failure must not erase a clear deterministic observation.
      } finally {
        activeOperationsRef.current.delete(operation);
      }
    }
    if (runtimeRef.current !== owner) return;
    owner.dispatch({ type: "ApplyRuntimeSettlement", settlement });
    publish();
    if (settlement.responseAuthorized) await executeAdvisor(owner);
  }, [executeAdvisor, publish]);

  const processSegment = useCallback(async (segment: NativeSpeechSegment) => {
    const owner = runtimeRef.current;
    const identity = {
      captureSessionId: segment.captureSessionId,
      captureGeneration: segment.captureGeneration,
      segmentSequence: segment.segmentSequence,
    };
    segmentLedgerRef.current.observe({ identity, observedAt: Date.now() });
    const sttSecret = secretsRef.current.stt;
    if (!sttSecret) {
      segmentLedgerRef.current.settle({ identity, disposition: "failed", settledAt: Date.now() });
      return;
    }
    const operationId = `stt_${segment.captureSessionId}_${segment.segmentSequence}`;
    const operation = createCancellableOperation({
      operationId,
      timeoutMs: 30_000,
      execute: (signal) => requestTranscription({
        route: settingsRef.current.stt,
        apiKey: sttSecret,
        audio: audioBlob(segment.audioBase64, segment.mediaType),
        signal,
      }),
    });
    activeOperationsRef.current.add(operation);
    try {
      const text = await operation.promise;
      if (runtimeRef.current !== owner || owner.snapshot().state !== "live") {
        segmentLedgerRef.current.settle({ identity, disposition: "stale", settledAt: Date.now() });
        return;
      }
      segmentLedgerRef.current.settle({ identity, disposition: "accepted", settledAt: Date.now() });
      const momentUnitId = `moment_${crypto.randomUUID()}`;
      owner.dispatch({
        type: "SubmitTranscriptTurn",
        momentUnitId,
        turn: { id: `turn_${crypto.randomUUID()}`, speaker: "them", text, occurredAt: Date.now() },
      });
      publish();
      await settleTurn(owner, text, momentUnitId);
    } catch {
      segmentLedgerRef.current.settle({ identity, disposition: "failed", settledAt: Date.now() });
    } finally {
      activeOperationsRef.current.delete(operation);
    }
  }, [publish, settleTurn]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<unknown>("speech-detected", (event) => {
      const authorization = authorizeNativeSpeechSegment({
        payload: event.payload,
        activeCaptureSessionId: captureSessionIdRef.current ?? "",
        activeCaptureGeneration: captureGenerationRef.current ?? -1,
        lastAcceptedSequence: lastSegmentSequenceRef.current,
        expectedOwner: "call",
      });
      if (!authorization.authorized) return;
      lastSegmentSequenceRef.current = authorization.event.segmentSequence;
      queueRef.current = queueRef.current.then(() => processSegment(authorization.event));
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [processSegment]);

  const startCapture = useCallback(async (owner: ActiveCallRuntime) => {
    const hasAccess = await invoke<boolean>("check_system_audio_access");
    if (!hasAccess) throw new Error("System audio permission is required.");
    const status = await invoke<NativeCallAudioStatus>("start_call_audio_session", { vadConfig: null, deviceId: null });
    if (!status.captureSessionId || status.captureGeneration == null) throw new Error("Native capture started without a lease.");
    captureSessionIdRef.current = status.captureSessionId;
    captureGenerationRef.current = status.captureGeneration;
    lastSegmentSequenceRef.current = 0;
    owner.dispatch({ type: "CaptureStarted", occurredAt: Date.now() });
    publish();
  }, [publish]);

  const start = useCallback(async () => {
    if (!secretsRef.current.stt) throw new Error("Configure Speech-to-Text before starting a call.");
    abortOperations("new-call");
    const owner = makeRuntime();
    runtimeRef.current = owner;
    segmentLedgerRef.current = new AudioSegmentDispositionLedger();
    queueRef.current = Promise.resolve();
    owner.dispatch({ type: "StartCall", occurredAt: Date.now() });
    publish();
    try {
      await startCapture(owner);
    } catch (error) {
      owner.dispatch({ type: "StartFailed", error: error instanceof Error ? error.message : String(error), occurredAt: Date.now() });
      publish();
    }
  }, [abortOperations, publish, startCapture]);

  const stopNativeCapture = useCallback(async () => {
    if (!captureSessionIdRef.current || captureGenerationRef.current == null) return;
    const captureSessionId = captureSessionIdRef.current;
    const captureGeneration = captureGenerationRef.current;
    const lease = { expectedCaptureSessionId: captureSessionId, expectedCaptureGeneration: captureGeneration };
    await invoke("stop_call_audio_session", lease);
    if (
      captureSessionIdRef.current === captureSessionId &&
      captureGenerationRef.current === captureGeneration
    ) {
      captureSessionIdRef.current = null;
      captureGenerationRef.current = null;
    }
  }, []);

  const pause = useCallback(async () => {
    abortOperations("call-paused");
    await stopNativeCapture();
    runtimeRef.current.dispatch({ type: "PauseCall", occurredAt: Date.now() });
    publish();
  }, [abortOperations, publish, stopNativeCapture]);

  const resume = useCallback(async () => {
    const owner = runtimeRef.current;
    owner.dispatch({ type: "ResumeCall", occurredAt: Date.now() });
    publish();
    try {
      await startCapture(owner);
    } catch (error) {
      owner.dispatch({ type: "RequireRecovery", error: error instanceof Error ? error.message : String(error), occurredAt: Date.now() });
      publish();
    }
  }, [publish, startCapture]);

  const end = useCallback(async () => {
    const owner = runtimeRef.current;
    abortOperations("call-closing");
    owner.dispatch({ type: "CloseCall", occurredAt: Date.now() });
    publish();
    try {
      await stopNativeCapture();
      owner.dispatch({ type: "CloseSucceeded", occurredAt: Date.now() });
    } catch (error) {
      owner.dispatch({ type: "CloseFailed", error: error instanceof Error ? error.message : String(error), occurredAt: Date.now() });
    }
    publish();
  }, [abortOperations, publish, stopNativeCapture]);

  const requestGuidance = useCallback(async () => {
    const owner = runtimeRef.current;
    owner.dispatch({ type: "RecordHumanOverride", reason: "manual-guidance-request", occurredAt: Date.now() });
    publish();
    await executeAdvisor(owner, true);
  }, [executeAdvisor, publish]);

  const saveConfiguration = useCallback(async (next: ModelRouteSettings, secrets: ProviderSecrets) => {
    saveModelRouteSettings(next);
    const mergedSecrets = { ...secretsRef.current };
    await Promise.all((Object.keys(secrets) as Array<keyof ProviderSecrets>).map(async (route) => {
      if (!secrets[route].trim()) return;
      mergedSecrets[route] = secrets[route].trim();
      await saveProviderSecret(route, mergedSecrets[route]);
    }));
    settingsRef.current = next;
    setSettings(next);
    secretsRef.current = mergedSecrets;
    setConfigured({ runtime: Boolean(mergedSecrets.runtime), advisor: Boolean(mergedSecrets.advisor), complex: Boolean(mergedSecrets.complex), stt: Boolean(mergedSecrets.stt) });
  }, []);

  return {
    runtime,
    settings,
    configured,
    start,
    pause,
    resume,
    end,
    requestGuidance,
    saveConfiguration,
  };
}

export type CallingAssistantController = ReturnType<typeof useCallingAssistant>;
export type CallingProviderSecrets = ProviderSecrets;
