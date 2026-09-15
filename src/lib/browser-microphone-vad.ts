import { AudioNodeVAD } from "@ricky0123/vad-web";

export interface BrowserMicrophoneVadState {
  loading: boolean;
  listening: boolean;
  userSpeaking: boolean;
  errored: string | false;
}

export interface BrowserMicrophoneVadObservation {
  stage: "initializing" | "ready" | "started" | "paused" | "first-frame"
    | "speech-start" | "speech-real-start" | "speech-end" | "vad-misfire"
    | "error" | "disposed";
  requestedDeviceId?: string;
  actualDeviceId?: string;
  trackReadyState?: MediaStreamTrackState;
  trackMuted?: boolean;
  contextState?: AudioContextState;
  elapsedMs: number;
  framesProcessed: number;
  speechSegments: number;
  observationCount: number;
  error?: string;
}

export interface BrowserMicrophoneVadOptions {
  deviceId?: string;
  userSpeakingThreshold?: number;
  onSpeechStart?: () => void | Promise<void>;
  onSpeechRealStart?: () => void | Promise<void>;
  onVADMisfire?: () => void | Promise<void>;
  onSpeechEnd?: (audio: Float32Array) => void | Promise<void>;
  onObservation?: (event: BrowserMicrophoneVadObservation) => void | Promise<void>;
  onStateChange?: (state: BrowserMicrophoneVadState) => void;
}

interface Capture {
  stream?: MediaStream;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  vad?: AudioNodeVAD;
  ready: boolean;
  cancelled: boolean;
  released?: Promise<void>;
  removeEndedListener?: () => void;
}

const idleState = (): BrowserMicrophoneVadState => ({
  loading: false, listening: false, userSpeaking: false, errored: false,
});

// Each consumer owns this instance. Construction does not request microphone access.
export function createBrowserMicrophoneVad(options: BrowserMicrophoneVadOptions) {
  let state = idleState();
  let capture: Capture | undefined;
  let starting: Promise<void> | undefined;
  let startGeneration = 0;
  let desired = false;
  let disposed = false;
  let disposing: Promise<void> | undefined;
  let startedAt: number | undefined;
  let framesProcessed = 0;
  let speechSegments = 0;
  let observationCount = 0;

  const update = (patch: Partial<BrowserMicrophoneVadState>) => {
    const next = { ...state, ...patch };
    if ((Object.keys(next) as Array<keyof typeof next>).some((key) => next[key] !== state[key])) {
      state = next;
      options.onStateChange?.({ ...state });
    }
  };
  const observe = (stage: BrowserMicrophoneVadObservation["stage"], error?: string) => {
    const track = capture?.stream?.getAudioTracks()[0];
    const event: BrowserMicrophoneVadObservation = {
      stage, error, requestedDeviceId: options.deviceId,
      actualDeviceId: track?.getSettings().deviceId,
      trackReadyState: track?.readyState, trackMuted: track?.muted,
      contextState: capture?.context?.state,
      elapsedMs: startedAt === undefined ? 0 : Math.max(0, performance.now() - startedAt),
      framesProcessed, speechSegments, observationCount: ++observationCount,
    };
    // Recording/diagnostic failures must not alter the audio route.
    try {
      const result = options.onObservation?.(event);
      if (result) void result.catch(() => undefined);
    } catch { /* Observer is optional. */ }
  };
  const release = (resource?: Capture): Promise<void> => {
    if (!resource || resource.cancelled) return resource?.released ?? Promise.resolve();
    resource.cancelled = true;
    resource.removeEndedListener?.();
    resource.stream?.getTracks().forEach((track) => track.stop());
    try { resource.source?.disconnect(); } catch { /* Already disconnected. */ }
    try { resource.vad?.pause(); } catch { /* Continue releasing owned resources. */ }
    try { resource.vad?.destroy(); } catch { /* Continue closing the context. */ }
    resource.released = resource.context && resource.context.state !== "closed"
      ? resource.context.close().catch(() => undefined)
      : Promise.resolve();
    return resource.released;
  };
  const fail = (error: unknown) => {
    if (disposed || state.errored) return;
    desired = false;
    const message = error instanceof Error ? error.message : String(error);
    update({ loading: false, listening: false, userSpeaking: false, errored: message });
    observe("error", message);
    void release(capture);
  };
  const current = (resource: Capture) => !disposed && !resource.cancelled && capture === resource;
  const accepting = (resource: Capture) => current(resource) && desired && state.listening;
  const callback = (resource: Capture, fn?: () => void | Promise<void>) => {
    if (!accepting(resource)) return;
    const generation = startGeneration;
    try {
      const result = fn?.();
      if (result) void result.catch((error) => {
        if (accepting(resource) && generation === startGeneration) fail(error);
      });
    } catch (error) { fail(error); }
  };

  const initialize = async (resource: Capture) => {
    if (!options.deviceId) {
      throw new Error("Select a microphone in settings, including Default to use the system default.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(options.deviceId === "default" ? {} : { deviceId: { exact: options.deviceId } }),
        channelCount: 1,
        echoCancellation: true, autoGainControl: true, noiseSuppression: true,
      },
    });
    if (!current(resource)) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    resource.stream = stream;
    const track = stream.getAudioTracks()[0];
    if (!track || track.readyState === "ended") throw new Error("Selected microphone is unavailable.");
    const actualDeviceId = track.getSettings().deviceId;
    if (options.deviceId !== "default" && actualDeviceId && actualDeviceId !== options.deviceId) {
      throw new Error("The browser opened a different microphone than the selected device.");
    }
    const onEnded = () => { if (current(resource)) fail(new Error("Selected microphone was disconnected.")); };
    track.addEventListener("ended", onEnded);
    resource.removeEndedListener = () => track.removeEventListener("ended", onEnded);
    resource.context = new AudioContext();
    resource.source = resource.context.createMediaStreamSource(stream);
    const vad = await AudioNodeVAD.new(resource.context, {
      onFrameProcessed: (probabilities) => {
        if (!accepting(resource)) return;
        if (++framesProcessed === 1) observe("first-frame");
        update({ userSpeaking: probabilities.isSpeech > (options.userSpeakingThreshold ?? 0.6) });
      },
      onSpeechStart: () => callback(resource, () => {
        observe("speech-start"); return options.onSpeechStart?.();
      }),
      onSpeechRealStart: () => callback(resource, () => {
        observe("speech-real-start"); return options.onSpeechRealStart?.();
      }),
      onVADMisfire: () => callback(resource, () => {
        observe("vad-misfire"); return options.onVADMisfire?.();
      }),
      onSpeechEnd: (audio) => callback(resource, () => {
        speechSegments++; observe("speech-end"); return options.onSpeechEnd?.(audio);
      }),
    });
    if (!current(resource)) {
      vad.destroy();
      return;
    }
    resource.vad = vad;
    vad.receive(resource.source);
    resource.ready = true;
    observe("ready");
  };

  const start = (): Promise<void> => {
    if (disposed || state.errored) return Promise.resolve();
    desired = true;
    if (starting) return starting;
    if (state.listening) return Promise.resolve();
    const generation = ++startGeneration;
    const resource = capture ?? { ready: false, cancelled: false };
    capture = resource;
    if (!resource.ready) {
      startedAt = performance.now();
      update({ loading: true });
      observe("initializing");
    }
    const operation = (async () => {
      try {
        if (!resource.ready) await initialize(resource);
        if (!current(resource) || !desired || generation !== startGeneration) return;
        if (resource.context!.state === "suspended") await resource.context!.resume();
        if (!current(resource) || !desired || generation !== startGeneration) return;
        if (resource.context!.state !== "running") throw new Error("Microphone audio context is not running.");
        resource.vad!.start();
        update({ loading: false, listening: true });
        observe("started");
      } catch (error) {
        if (current(resource) && generation === startGeneration) fail(error);
      }
    })();
    starting = operation;
    void operation.finally(() => { if (starting === operation) starting = undefined; });
    return operation;
  };
  const pause = () => {
    desired = false;
    startGeneration++;
    starting = undefined;
    const wasActive = state.listening || state.loading;
    update({ listening: false, loading: false, userSpeaking: false });
    if (!capture?.ready) {
      void release(capture);
      capture = undefined;
    } else {
      try { capture.vad?.pause(); } catch (error) { fail(error); }
    }
    if (wasActive) observe("paused");
  };
  const dispose = () => {
    if (disposed) return disposing ?? Promise.resolve();
    disposed = true;
    desired = false;
    update({ listening: false, loading: false, userSpeaking: false });
    disposing = release(capture);
    if (startedAt !== undefined) observe("disposed");
    return disposing;
  };
  return { start, pause, dispose, getState: () => ({ ...state }) };
}
