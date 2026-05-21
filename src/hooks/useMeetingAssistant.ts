import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { STORAGE_KEYS } from "@/config";
import { useApp } from "@/contexts";
import { safeLocalStorage } from "@/lib";
import {
  AdvisorEngine,
  AdvisorRequestMode,
  ClarifyingQuestionAnswer,
  ClarifyingQuestionFeedback,
  MeetingAssistantState,
  MeetingAudioConfig,
  MeetingAudioStatus,
  MeetingAssistantSettings,
  MeetingAudioProfile,
  MeetingPrivacyMode,
  MeetingResponseActionMode,
  MeetingResponseConfig,
  MeetingResponseLength,
  MeetingContextManager,
  MeetingSetupWarning,
  MeetingTraceStore,
  ScreenObservation,
  base64WavToBlob,
  captureScreenObservation,
  createMeetingId,
  extractScreenTaskQuestion,
  inferScreenTaskKind,
  inferScreenTaskLanguage,
  parseMeetingTraceMetrics,
  parseScreenTaskAnswer,
  serializeMeetingTraceMetrics,
  solveScreenAnchoredTask,
  transcribeMeetingAudio,
} from "@/lib/meeting";

const ADVISOR_DEBOUNCE_MS = 750;
const STT_TIMEOUT_MS = 30_000;
const SCREEN_ANALYSIS_TIMEOUT_MS = 45_000;
const DEFAULT_ACTIVE_SCREEN_TASK_TIMEOUT_MINUTES = 30;
const MIN_ACTIVE_SCREEN_TASK_TIMEOUT_MINUTES = 5;
const MAX_ACTIVE_SCREEN_TASK_TIMEOUT_MINUTES = 240;
const TRACE_METRICS_PERSIST_DEBOUNCE_MS = 750;

const MISSING_STT_MESSAGE =
  "Choose a speech-to-text provider in Dev Space before starting Jarvis.";
const MISSING_AI_MESSAGE =
  "Choose an AI provider in Dev Space to receive live suggestions.";
const MISSING_VISION_MESSAGE =
  "Choose an image-capable AI provider to analyze screen context.";
const LOCAL_ONLY_UNAVAILABLE_MESSAGE =
  "Local-only meeting mode needs local STT before it can start.";
const SCREEN_CONTEXT_DISABLED_MESSAGE =
  "Enable Text+Screen privacy mode before capturing screen context.";
const NO_MEETING_CONTEXT_MESSAGE =
  "Jarvis needs transcript or screen context before it can suggest.";
const NO_SUGGESTION_MESSAGE = "There is no suggestion to update yet.";

const DEFAULT_MEETING_AUDIO_CONFIG: MeetingAudioConfig = {
  enabled: true,
  hop_size: 1024,
  sensitivity_rms: 0.012,
  peak_threshold: 0.035,
  silence_chunks: 45,
  min_speech_chunks: 7,
  pre_speech_chunks: 12,
  noise_gate_threshold: 0.003,
  max_recording_duration_secs: 180,
};

const MEETING_AUDIO_PROFILE_CONFIGS: Record<
  Exclude<MeetingAudioProfile, "custom">,
  Pick<MeetingAudioConfig, "sensitivity_rms" | "noise_gate_threshold" | "silence_chunks">
> = {
  quiet: {
    sensitivity_rms: 0.015,
    noise_gate_threshold: 0.005,
    silence_chunks: 55,
  },
  balanced: {
    sensitivity_rms: 0.012,
    noise_gate_threshold: 0.003,
    silence_chunks: 45,
  },
  sensitive: {
    sensitivity_rms: 0.008,
    noise_gate_threshold: 0.002,
    silence_chunks: 35,
  },
};

const DEFAULT_MEETING_RESPONSE_CONFIG: MeetingResponseConfig = {
  length: "normal",
  language: "auto",
};

const INITIAL_STATE: MeetingAssistantState = {
  status: "idle",
  transcriptTurns: [],
  screenObservations: [],
  latestSuggestion: null,
  partialSuggestion: "",
  traces: [],
  error: null,
  audioStatus: null,
  settings: {
    screenContextEnabled: false,
    privacyMode: "text-to-cloud",
    activeScreenTaskTimeoutMinutes: DEFAULT_ACTIVE_SCREEN_TASK_TIMEOUT_MINUTES,
    debugMode: false,
    response: DEFAULT_MEETING_RESPONSE_CONFIG,
    audio: {
      profile: "balanced",
      config: DEFAULT_MEETING_AUDIO_CONFIG,
    },
  },
};

const DEFAULT_MEETING_ASSISTANT_SETTINGS = INITIAL_STATE.settings;

function readMeetingAssistantSettings(): MeetingAssistantSettings {
  const stored = safeLocalStorage.getItem(
    STORAGE_KEYS.MEETING_ASSISTANT_SETTINGS
  );

  if (!stored) return DEFAULT_MEETING_ASSISTANT_SETTINGS;

  try {
    const parsed = JSON.parse(stored) as Partial<MeetingAssistantSettings>;
    const privacyMode = isMeetingPrivacyMode(parsed.privacyMode)
      ? parsed.privacyMode
      : DEFAULT_MEETING_ASSISTANT_SETTINGS.privacyMode;

    return {
      screenContextEnabled:
        typeof parsed.screenContextEnabled === "boolean"
          ? parsed.screenContextEnabled
          : DEFAULT_MEETING_ASSISTANT_SETTINGS.screenContextEnabled,
      privacyMode,
      activeScreenTaskTimeoutMinutes:
        normalizeActiveScreenTaskTimeoutMinutes(
          parsed.activeScreenTaskTimeoutMinutes
        ),
      debugMode:
        typeof parsed.debugMode === "boolean"
          ? parsed.debugMode
          : DEFAULT_MEETING_ASSISTANT_SETTINGS.debugMode,
      response: normalizeMeetingResponseConfig(parsed.response),
      audio: normalizeMeetingAudioSettings(parsed.audio),
    };
  } catch {
    return DEFAULT_MEETING_ASSISTANT_SETTINGS;
  }
}

function normalizeMeetingResponseConfig(
  value: unknown
): MeetingResponseConfig {
  const parsed = isRecord(value) ? value : {};
  return {
    length:
      parsed.length === "short" ||
      parsed.length === "normal" ||
      parsed.length === "detailed"
        ? parsed.length
        : DEFAULT_MEETING_RESPONSE_CONFIG.length,
    language:
      parsed.language === "auto" ||
      parsed.language === "english" ||
      parsed.language === "chinese"
        ? parsed.language
        : DEFAULT_MEETING_RESPONSE_CONFIG.language,
  };
}

function getNextShorterResponseLength(
  length: MeetingResponseLength
): MeetingResponseLength {
  return length === "detailed" ? "normal" : "short";
}

function normalizeMeetingAudioSettings(value: unknown) {
  const parsed = isRecord(value) ? value : {};
  const profile = normalizeMeetingAudioProfile(parsed.profile);
  return {
    profile,
    config: normalizeMeetingAudioConfig(parsed.config, profile),
  };
}

function normalizeMeetingAudioProfile(value: unknown): MeetingAudioProfile {
  return value === "quiet" ||
    value === "balanced" ||
    value === "sensitive" ||
    value === "custom"
    ? value
    : "balanced";
}

function normalizeMeetingAudioConfig(
  value: unknown,
  profile: MeetingAudioProfile = "balanced"
): MeetingAudioConfig {
  const parsed = isRecord(value) ? value : {};
  const profileDefaults =
    profile === "custom"
      ? DEFAULT_MEETING_AUDIO_CONFIG
      : {
          ...DEFAULT_MEETING_AUDIO_CONFIG,
          ...MEETING_AUDIO_PROFILE_CONFIGS[profile],
        };

  return {
    enabled:
      typeof parsed.enabled === "boolean"
        ? parsed.enabled
        : profileDefaults.enabled,
    hop_size: normalizeNumber(parsed.hop_size, profileDefaults.hop_size),
    sensitivity_rms: normalizeNumber(
      parsed.sensitivity_rms,
      profileDefaults.sensitivity_rms
    ),
    peak_threshold: normalizeNumber(
      parsed.peak_threshold,
      profileDefaults.peak_threshold
    ),
    silence_chunks: normalizeNumber(
      parsed.silence_chunks,
      profileDefaults.silence_chunks
    ),
    min_speech_chunks: normalizeNumber(
      parsed.min_speech_chunks,
      profileDefaults.min_speech_chunks
    ),
    pre_speech_chunks: normalizeNumber(
      parsed.pre_speech_chunks,
      profileDefaults.pre_speech_chunks
    ),
    noise_gate_threshold: normalizeNumber(
      parsed.noise_gate_threshold,
      profileDefaults.noise_gate_threshold
    ),
    max_recording_duration_secs: normalizeNumber(
      parsed.max_recording_duration_secs,
      profileDefaults.max_recording_duration_secs
    ),
  };
}

function normalizeNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeActiveScreenTaskTimeoutMinutes(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_ACTIVE_SCREEN_TASK_TIMEOUT_MINUTES;
  }

  return Math.min(
    MAX_ACTIVE_SCREEN_TASK_TIMEOUT_MINUTES,
    Math.max(MIN_ACTIVE_SCREEN_TASK_TIMEOUT_MINUTES, Math.round(value))
  );
}

function getActiveScreenTaskExpiresAt(
  settings: MeetingAssistantSettings,
  now = Date.now()
) {
  return now + settings.activeScreenTaskTimeoutMinutes * 60_000;
}

function clearActiveScreenTaskState(
  previous: MeetingAssistantState
): MeetingAssistantState {
  return {
    ...previous,
    activeScreenTask: undefined,
    partialSuggestion: "",
    latestSuggestion:
      previous.latestSuggestion?.kind === "screen-task"
        ? null
        : previous.latestSuggestion,
    status:
      previous.status === "thinking"
        ? previous.audioStatus?.active
          ? "listening"
          : "idle"
        : previous.status,
    error: null,
  };
}

function isMeetingPrivacyMode(
  value: unknown
): value is MeetingPrivacyMode {
  return (
    value === "memory-only" ||
    value === "text-to-cloud" ||
    value === "text-and-screen-to-cloud"
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
) {
  let timeoutId: number | undefined;

  return new Promise<T>((resolve, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);

    promise.then(resolve, reject).finally(() => {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    });
  });
}

interface RunAdvisorOptions {
  force?: boolean;
  mode?: AdvisorRequestMode;
  responseAction?: MeetingResponseActionMode;
  responseConfigOverride?: MeetingResponseConfig;
  currentSuggestion?: string;
  clarifyingFeedback?: ClarifyingQuestionFeedback;
  traceId?: string;
}

interface CaptureScreenContextOptions {
  onCaptured?: () => void;
  requestedAt?: number;
}

export function useMeetingAssistant() {
  const {
    screenshotConfiguration,
    selectedSttProvider,
    allSttProviders,
    selectedAIProvider,
    allAiProviders,
    selectedAudioDevices,
  } = useApp();

  const [state, setState] = useState<MeetingAssistantState>(() => ({
    ...INITIAL_STATE,
    settings: readMeetingAssistantSettings(),
  }));
  const contextManagerRef = useRef(new MeetingContextManager());
  const advisorEngineRef = useRef(new AdvisorEngine());
  const traceStoreRef = useRef(new MeetingTraceStore());
  const traceMetricsPersistTimerRef = useRef<number | null>(null);
  const traceMetricsPersistenceReadyRef = useRef(false);
  const lastTraceMetricsPayloadRef = useRef<string | null>(null);
  const activeRef = useRef(false);
  const latestScreenHashRef = useRef<string | undefined>(undefined);
  const advisorDebounceTimerRef = useRef<number | null>(null);
  const screenAnalysisAbortRef = useRef<AbortController | null>(null);
  const screenCaptureInFlightRef = useRef(false);
  const speechDetectedHandlerRef = useRef<
    ((base64Audio: string) => void) | undefined
  >(undefined);

  const sttProvider = useMemo(
    () =>
      allSttProviders.find(
        (candidate) => candidate.id === selectedSttProvider.provider
      ),
    [allSttProviders, selectedSttProvider.provider]
  );

  const aiProvider = useMemo(
    () =>
      allAiProviders.find(
        (candidate) => candidate.id === selectedAIProvider.provider
      ),
    [allAiProviders, selectedAIProvider.provider]
  );

  const setupWarnings = useMemo<MeetingSetupWarning[]>(() => {
    const warnings: MeetingSetupWarning[] = [];

    if (!sttProvider) {
      warnings.push({
        code: "stt-provider-missing",
        severity: "blocking",
        message: MISSING_STT_MESSAGE,
      });
    }

    if (state.settings.privacyMode === "memory-only") {
      warnings.push({
        code: "local-only-unavailable",
        severity: "blocking",
        message: LOCAL_ONLY_UNAVAILABLE_MESSAGE,
      });
    }

    if (!aiProvider) {
      warnings.push({
        code: "ai-provider-missing",
        severity: "warning",
        message: MISSING_AI_MESSAGE,
      });
    } else if (!aiProvider.curl.includes("{{IMAGE}}")) {
      warnings.push({
        code: "vision-provider-missing",
        severity: "warning",
        message: MISSING_VISION_MESSAGE,
      });
    }

    return warnings;
  }, [aiProvider, state.settings.privacyMode, sttProvider]);

  const clearAdvisorDebounce = useCallback(() => {
    if (advisorDebounceTimerRef.current !== null) {
      window.clearTimeout(advisorDebounceTimerRef.current);
      advisorDebounceTimerRef.current = null;
    }
  }, []);

  const clearTraces = useCallback(() => {
    traceStoreRef.current.clear();
  }, []);

  const scheduleTraceMetricsPersistence = useCallback(() => {
    if (!traceMetricsPersistenceReadyRef.current) return;

    if (traceMetricsPersistTimerRef.current !== null) {
      window.clearTimeout(traceMetricsPersistTimerRef.current);
    }

    traceMetricsPersistTimerRef.current = window.setTimeout(() => {
      traceMetricsPersistTimerRef.current = null;
      const payload = serializeMeetingTraceMetrics(
        traceStoreRef.current.getPersistableTraces()
      );

      if (payload === lastTraceMetricsPayloadRef.current) return;
      lastTraceMetricsPayloadRef.current = payload;

      void invoke("write_meeting_trace_metrics", { payload }).catch((error) => {
        console.warn("Failed to persist meeting trace metrics", error);
      });
    }, TRACE_METRICS_PERSIST_DEBOUNCE_MS);
  }, []);

  const updateSettings = useCallback(
    (resolveSettings: (previous: MeetingAssistantSettings) => MeetingAssistantSettings) => {
      setState((previous) => {
        const settings = resolveSettings(previous.settings);
        safeLocalStorage.setItem(
          STORAGE_KEYS.MEETING_ASSISTANT_SETTINGS,
          JSON.stringify(settings)
        );

        return {
          ...previous,
          settings,
        };
      });
    },
    []
  );

  const setScreenContextEnabled = useCallback(
    (screenContextEnabled: boolean) => {
      updateSettings((previous) => ({
        ...previous,
        screenContextEnabled,
        privacyMode: screenContextEnabled
          ? "text-and-screen-to-cloud"
          : "text-to-cloud",
      }));
    },
    [updateSettings]
  );

  const setPrivacyMode = useCallback(
    (privacyMode: MeetingPrivacyMode) => {
      updateSettings((previous) => ({
        ...previous,
        privacyMode,
        screenContextEnabled: privacyMode === "text-and-screen-to-cloud",
      }));
    },
    [updateSettings]
  );

  const setActiveScreenTaskTimeoutMinutes = useCallback(
    (activeScreenTaskTimeoutMinutes: number) => {
      const normalizedTimeoutMinutes =
        normalizeActiveScreenTaskTimeoutMinutes(
          activeScreenTaskTimeoutMinutes
        );

      updateSettings((previous) => ({
        ...previous,
        activeScreenTaskTimeoutMinutes: normalizedTimeoutMinutes,
      }));

      const activeScreenTask =
        contextManagerRef.current.getState().activeScreenTask;

      if (activeScreenTask) {
        const now = Date.now();
        contextManagerRef.current.setActiveScreenTask({
          ...activeScreenTask,
          updatedAt: now,
          expiresAt: now + normalizedTimeoutMinutes * 60_000,
        });
        const contextState = contextManagerRef.current.getState();
        setState((previous) => ({
          ...previous,
          activeScreenTask: contextState.activeScreenTask,
        }));
      }
    },
    [updateSettings]
  );

  const setDebugMode = useCallback(
    (debugMode: boolean) => {
      traceStoreRef.current.setDebugEnabled(debugMode);
      updateSettings((previous) => ({
        ...previous,
        debugMode,
      }));
    },
    [updateSettings]
  );

  const setResponseConfig = useCallback(
    (response: MeetingResponseConfig) => {
      updateSettings((previous) => ({
        ...previous,
        response,
      }));
    },
    [updateSettings]
  );

  const setMeetingAudioProfile = useCallback(
    (profile: MeetingAudioProfile) => {
      const profileConfig =
        profile === "custom"
          ? DEFAULT_MEETING_AUDIO_CONFIG
          : {
              ...DEFAULT_MEETING_AUDIO_CONFIG,
              ...MEETING_AUDIO_PROFILE_CONFIGS[profile],
            };

      updateSettings((previous) => ({
        ...previous,
        audio: {
          profile,
          config: profileConfig,
        },
      }));
    },
    [updateSettings]
  );

  const setMeetingAudioConfig = useCallback(
    (config: MeetingAudioConfig) => {
      updateSettings((previous) => ({
        ...previous,
        audio: {
          profile: "custom",
          config: normalizeMeetingAudioConfig(config, "custom"),
        },
      }));
    },
    [updateSettings]
  );

  const clearActiveScreenTask = useCallback(() => {
    clearAdvisorDebounce();
    advisorEngineRef.current.cancelCurrentRequest();
    screenAnalysisAbortRef.current?.abort();
    screenAnalysisAbortRef.current = null;
    contextManagerRef.current.clearActiveScreenTask();
    setState(clearActiveScreenTaskState);
  }, [clearAdvisorDebounce]);

  const stop = useCallback(async () => {
    activeRef.current = false;
    clearAdvisorDebounce();
    advisorEngineRef.current.cancelCurrentRequest();
    screenAnalysisAbortRef.current?.abort();
    screenAnalysisAbortRef.current = null;
    contextManagerRef.current.clearActiveScreenTask();

    let audioStatus: MeetingAudioStatus | null = null;

    try {
      audioStatus = await invoke<MeetingAudioStatus>(
        "stop_meeting_audio_session"
      );
    } catch (error) {
      console.warn("Failed to stop meeting audio capture", error);
    }

    setState((previous) => ({
      ...previous,
      status: "idle",
      activeScreenTask: undefined,
      latestSuggestion:
        previous.latestSuggestion?.kind === "screen-task"
          ? null
          : previous.latestSuggestion,
      partialSuggestion: "",
      error: null,
      audioStatus,
    }));
  }, [clearAdvisorDebounce]);

  const runAdvisor = useCallback(async (options: RunAdvisorOptions = {}) => {
    const mode = options.mode ?? "live";
    const force = options.force ?? false;
    const traceId = options.traceId;
    let advisorStepId: string | undefined;

    if (!activeRef.current && !force) {
      if (traceId) {
        traceStoreRef.current.finishTrace(traceId, "cancelled");
      }
      return;
    }

    const promptContext = contextManagerRef.current.buildAdvisorPromptContext();
    const latestTurn = promptContext.latestTurn;
    const hasContext = Boolean(
      promptContext.latestTurn ||
        promptContext.transcript.trim() ||
        promptContext.screenContext.trim()
    );

    if (
      !force &&
      !advisorEngineRef.current.shouldRequestSuggestion(latestTurn)
    ) {
      if (traceId) {
        const skippedStepId = traceStoreRef.current.startStep(
          traceId,
          "Advisor skipped",
          { reason: "turn did not require suggestion" }
        );
        traceStoreRef.current.finishStep(traceId, skippedStepId, "success");
        traceStoreRef.current.finishTrace(traceId, "success");
      }
      return;
    }

    if (force && !hasContext && !options.currentSuggestion?.trim()) {
      if (traceId) {
        traceStoreRef.current.finishTrace(traceId, "error", NO_MEETING_CONTEXT_MESSAGE);
      }
      setState((previous) => ({
        ...previous,
        error: NO_MEETING_CONTEXT_MESSAGE,
      }));
      return;
    }

    if (!aiProvider) {
      if (traceId) {
        traceStoreRef.current.finishTrace(traceId, "error", MISSING_AI_MESSAGE);
      }
      setState((previous) => ({
        ...previous,
        status: activeRef.current ? "listening" : previous.status,
        partialSuggestion: "",
        error: MISSING_AI_MESSAGE,
      }));
      return;
    }

    const returnStatus = state.status;
    const requestId = `advisor_${mode}_${Date.now()}`;
    const responseConfig =
      options.responseConfigOverride ?? state.settings.response;
    contextManagerRef.current.setLastAdvisorRequestId(requestId);

    setState((previous) => ({
      ...previous,
      status: "thinking",
      partialSuggestion: "",
      error: null,
    }));

    let finalContent = "";

    try {
      for await (const event of advisorEngineRef.current.streamSuggestion({
        requestId,
        mode,
        promptContext,
        provider: aiProvider,
        selectedProvider: selectedAIProvider,
        responseAction: options.responseAction,
        responseConfig,
        currentSuggestion: options.currentSuggestion,
        clarifyingFeedback: options.clarifyingFeedback,
        trace: traceId
          ? {
              onRequest: (input) => {
                traceStoreRef.current.recordInput(
                  traceId,
                  "advisor model input",
                  formatTraceModelInput(input.systemPrompt, input.userMessage),
                  {
                    providerId: input.providerId,
                    mode: input.mode,
                    responseAction: input.responseAction,
                    responseConfig: input.responseConfig,
                    imageCount: input.imageCount,
                  }
                );
                advisorStepId = traceStoreRef.current.startStep(
                  traceId,
                  "Advisor model response",
                  {
                    providerId: input.providerId,
                    mode: input.mode,
                    responseAction: input.responseAction,
                    responseLength: input.responseConfig?.length,
                    responseLanguage: input.responseConfig?.language,
                    promptChars:
                      input.systemPrompt.length + input.userMessage.length,
                  }
                );
              },
              onFirstToken: () => {
                traceStoreRef.current.updateMetadata(traceId, {
                  advisorFirstTokenAt: Date.now(),
                });
              },
              onComplete: (output) => {
                traceStoreRef.current.recordOutput(
                  traceId,
                  "advisor raw output",
                  output
                );
              },
            }
          : undefined,
      })) {
        finalContent = event.accumulated;
        setState((previous) => ({
          ...previous,
          partialSuggestion: event.accumulated,
        }));
      }

      let contextState = contextManagerRef.current.getState();

      if (
        mode === "screen-anchored" &&
        contextState.activeScreenTask &&
        shouldUpdateActiveScreenTaskFromAdvisorOutput(finalContent)
      ) {
        const updatedAt = Date.now();
        const basedOnTurnIds =
          latestTurn &&
          !contextState.activeScreenTask.basedOnTurnIds.includes(latestTurn.id)
            ? [...contextState.activeScreenTask.basedOnTurnIds, latestTurn.id]
            : contextState.activeScreenTask.basedOnTurnIds;

        contextManagerRef.current.setActiveScreenTask({
          ...contextState.activeScreenTask,
          updatedAt,
          expiresAt: getActiveScreenTaskExpiresAt(state.settings, updatedAt),
          question:
            extractScreenTaskQuestion(finalContent) ||
            contextState.activeScreenTask.question,
          kind: inferScreenTaskKind(finalContent),
          language:
            inferScreenTaskLanguage(finalContent) ||
            contextState.activeScreenTask.language,
          content: finalContent.trim(),
          basedOnTurnIds,
        });
        contextState = contextManagerRef.current.getState();
      }

      const latestObservationIds = contextState.screenObservations.map(
        (observation) => observation.id
      );

      setState((previous) => ({
        ...previous,
        status: activeRef.current
          ? "listening"
          : returnStatus === "paused"
            ? "paused"
            : "idle",
        latestSuggestion: advisorEngineRef.current.toSuggestion(
          requestId,
          finalContent,
          latestTurn ? [latestTurn.id] : [],
          latestObservationIds
        ),
        activeScreenTask: contextState.activeScreenTask,
      }));
      if (traceId) {
        traceStoreRef.current.finishStep(traceId, advisorStepId, "success", {
          outputChars: finalContent.length,
        });
        traceStoreRef.current.finishTrace(traceId, "success");
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (traceId) {
          traceStoreRef.current.finishStep(
            traceId,
            advisorStepId,
            "cancelled",
            undefined,
            error
          );
          traceStoreRef.current.finishTrace(traceId, "cancelled", error);
        }

        if (activeRef.current) {
          setState((previous) => ({
            ...previous,
            status: "listening",
            partialSuggestion: "",
          }));
        }
        return;
      }

      if (traceId) {
        traceStoreRef.current.finishStep(
          traceId,
          advisorStepId,
          "error",
          undefined,
          error
        );
        traceStoreRef.current.finishTrace(traceId, "error", error);
      }
      if (!activeRef.current && !force) return;

      setState((previous) => ({
        ...previous,
        status: activeRef.current
          ? "listening"
          : returnStatus === "paused"
            ? "paused"
            : "idle",
        partialSuggestion: "",
        error:
          error instanceof Error
            ? error.message
            : "Failed to generate meeting suggestion.",
      }));
    }
  }, [aiProvider, selectedAIProvider, state.settings, state.status]);

  const scheduleAdvisor = useCallback((
    mode: AdvisorRequestMode = "live",
    traceId?: string
  ) => {
    if (!activeRef.current) return;

    clearAdvisorDebounce();
    advisorDebounceTimerRef.current = window.setTimeout(() => {
      advisorDebounceTimerRef.current = null;
      void runAdvisor({ mode, traceId });
    }, ADVISOR_DEBOUNCE_MS);
  }, [clearAdvisorDebounce, runAdvisor]);

  const handleSpeechDetected = useCallback(
    async (base64Audio: string) => {
      if (!activeRef.current) return;

      const trace = traceStoreRef.current.startTrace("voice", {
        audioBase64Chars: base64Audio.length,
      });
      let audioBlobStepId: string | undefined;
      let sttStepId: string | undefined;

      if (!sttProvider) {
        activeRef.current = false;
        clearAdvisorDebounce();
        advisorEngineRef.current.cancelCurrentRequest();
        screenAnalysisAbortRef.current?.abort();
        screenAnalysisAbortRef.current = null;

        let audioStatus: MeetingAudioStatus | null = null;

        try {
          audioStatus = await invoke<MeetingAudioStatus>(
            "stop_meeting_audio_session"
          );
        } catch (error) {
          console.warn("Failed to stop meeting audio capture", error);
        }

        traceStoreRef.current.finishTrace(trace.id, "error", MISSING_STT_MESSAGE);
        setState((previous) => ({
          ...previous,
          status: "error",
          partialSuggestion: "",
          error: MISSING_STT_MESSAGE,
          audioStatus,
        }));
        return;
      }

      setState((previous) => ({
        ...previous,
        status: "transcribing",
        error: null,
      }));

      try {
        audioBlobStepId = traceStoreRef.current.startStep(
          trace.id,
          "Audio blob created"
        );
        const audio = base64WavToBlob(base64Audio);
        traceStoreRef.current.finishStep(trace.id, audioBlobStepId, "success", {
          audioBytes: audio.size,
          audioType: audio.type,
        });

        traceStoreRef.current.recordInput(
          trace.id,
          "stt input metadata",
          "Raw audio bytes are not stored in traces.",
          {
            providerId: sttProvider.id,
            audioBytes: audio.size,
            audioType: audio.type,
          }
        );
        sttStepId = traceStoreRef.current.startStep(
          trace.id,
          "STT request",
          {
            providerId: sttProvider.id,
            audioBytes: audio.size,
          }
        );
        const turn = await withTimeout(
          transcribeMeetingAudio({
            audio,
            provider: sttProvider,
            selectedProvider: selectedSttProvider,
          }),
          STT_TIMEOUT_MS,
          "Speech-to-text timed out. Jarvis is still listening."
        );
        traceStoreRef.current.finishStep(trace.id, sttStepId, "success", {
          transcriptChars: turn?.text.length ?? 0,
        });

        if (!turn) {
          traceStoreRef.current.finishTrace(trace.id, "success");
          setState((previous) => ({
            ...previous,
            status: activeRef.current ? "listening" : "idle",
          }));
          return;
        }

        traceStoreRef.current.recordOutput(
          trace.id,
          "stt raw output",
          turn.text,
          { turnId: turn.id }
        );

        const activeScreenTask = contextManagerRef.current.getState()
          .activeScreenTask;

        if (activeScreenTask && isTaskSwitchTranscript(turn.text)) {
          const switchStepId = traceStoreRef.current.startStep(
            trace.id,
            "Task switch confirmation requested",
            {
              turnId: turn.id,
              activeScreenTaskId: activeScreenTask.id,
              transcriptChars: turn.text.trim().length,
            }
          );
          traceStoreRef.current.finishStep(trace.id, switchStepId, "success");
          traceStoreRef.current.finishTrace(trace.id, "success");
          setState((previous) => ({
            ...previous,
            status: activeRef.current ? "listening" : "idle",
            partialSuggestion: "",
            latestSuggestion: {
              id: createMeetingId("task_switch"),
              kind: "clarifying-question",
              content: [
                "Meaning: 这听起来像是在切换到新题或新任务。",
                "Reply: -",
                "Question: Should I treat this as a new task?",
              ].join("\n"),
              createdAt: Date.now(),
              basedOnTurnIds: [turn.id],
              basedOnObservationIds: [activeScreenTask.observationId],
              confidence: "medium",
            },
          }));
          return;
        }

        if (shouldIgnoreLowSignalTranscript(turn.text, Boolean(activeScreenTask))) {
          const ignoredStepId = traceStoreRef.current.startStep(
            trace.id,
            "Transcript ignored",
            {
              reason: "low-signal",
              transcriptChars: turn.text.trim().length,
              activeScreenTask: Boolean(activeScreenTask),
            }
          );
          traceStoreRef.current.finishStep(trace.id, ignoredStepId, "success");
          traceStoreRef.current.finishTrace(trace.id, "success");
          setState((previous) => ({
            ...previous,
            status: activeRef.current ? "listening" : "idle",
          }));
          return;
        }

        contextManagerRef.current.addTranscriptTurn(turn);
        const contextState = contextManagerRef.current.getState();
        const appendStepId = traceStoreRef.current.startStep(
          trace.id,
          "Transcript appended",
          { turnId: turn.id }
        );
        traceStoreRef.current.finishStep(trace.id, appendStepId, "success", {
          transcriptTurns: contextState.transcriptTurns.length,
        });

        setState((previous) => ({
          ...previous,
          status: activeRef.current ? "listening" : "idle",
          transcriptTurns: contextState.transcriptTurns,
          activeScreenTask: contextState.activeScreenTask,
        }));

        const debounceStepId = traceStoreRef.current.startStep(
          trace.id,
          "Advisor debounce scheduled",
          { debounceMs: ADVISOR_DEBOUNCE_MS }
        );
        traceStoreRef.current.finishStep(trace.id, debounceStepId, "success");
        scheduleAdvisor(
          contextState.activeScreenTask ? "screen-anchored" : "live",
          trace.id
        );
      } catch (error) {
        traceStoreRef.current.finishStep(
          trace.id,
          audioBlobStepId,
          "error",
          undefined,
          error
        );
        traceStoreRef.current.finishStep(
          trace.id,
          sttStepId,
          "error",
          undefined,
          error
        );
        traceStoreRef.current.finishTrace(trace.id, "error", error);

        if (!activeRef.current) return;

        setState((previous) => ({
          ...previous,
          status: "listening",
          partialSuggestion: "",
          error:
            error instanceof Error
              ? error.message
              : "Failed to transcribe meeting audio.",
        }));
      }
    },
    [
      clearAdvisorDebounce,
      scheduleAdvisor,
      selectedSttProvider,
      sttProvider,
    ]
  );

  useEffect(() => {
    speechDetectedHandlerRef.current = (base64Audio: string) => {
      void handleSpeechDetected(base64Audio);
    };
  }, [handleSpeechDetected]);

  const startCapture = useCallback(async (resetContext: boolean) => {
    if (state.settings.privacyMode === "memory-only") {
      activeRef.current = false;
      clearAdvisorDebounce();
      advisorEngineRef.current.cancelCurrentRequest();
      screenAnalysisAbortRef.current?.abort();
      screenAnalysisAbortRef.current = null;
      setState((previous) => ({
        ...previous,
        status: "error",
        partialSuggestion: "",
        error: LOCAL_ONLY_UNAVAILABLE_MESSAGE,
      }));
      return;
    }

    if (!sttProvider) {
      activeRef.current = false;
      clearAdvisorDebounce();
      advisorEngineRef.current.cancelCurrentRequest();
      screenAnalysisAbortRef.current?.abort();
      screenAnalysisAbortRef.current = null;
      setState((previous) => ({
        ...previous,
        status: "error",
        partialSuggestion: "",
        error: MISSING_STT_MESSAGE,
      }));
      return;
    }

    setState((previous) => ({
      ...previous,
      status: "starting",
      partialSuggestion: "",
      error: null,
    }));

    try {
      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (!hasAccess) {
        setState((previous) => ({
          ...previous,
          status: "error",
          error: "System audio permission is required for meeting assistant.",
        }));
        return;
      }

      if (resetContext) {
        contextManagerRef.current.reset();
        latestScreenHashRef.current = undefined;
        screenAnalysisAbortRef.current?.abort();
        screenAnalysisAbortRef.current = null;
      }

      clearAdvisorDebounce();
      advisorEngineRef.current.cancelCurrentRequest();
      activeRef.current = true;

      await invoke<MeetingAudioStatus>("stop_meeting_audio_session");

      const deviceId =
        selectedAudioDevices.output.id &&
        selectedAudioDevices.output.id !== "default"
          ? selectedAudioDevices.output.id
          : null;

      const audioStatus = await invoke<MeetingAudioStatus>(
        "start_meeting_audio_session",
        {
          vadConfig: state.settings.audio.config,
          deviceId,
        }
      );

      const contextState = contextManagerRef.current.getState();

      setState((previous) => ({
        ...(resetContext
          ? { ...INITIAL_STATE, settings: previous.settings }
          : previous),
        status: "listening",
        transcriptTurns: contextState.transcriptTurns,
        screenObservations: contextState.screenObservations,
        activeScreenTask: contextState.activeScreenTask,
        partialSuggestion: "",
        error: null,
        audioStatus,
      }));
    } catch (error) {
      activeRef.current = false;
      setState((previous) => ({
        ...previous,
        status: "error",
        error:
          error instanceof Error
            ? error.message
            : "Failed to start meeting assistant.",
      }));
    }
  }, [
    clearAdvisorDebounce,
    selectedAudioDevices.output.id,
    state.settings.privacyMode,
    sttProvider,
  ]);

  const start = useCallback(async () => {
    await startCapture(true);
  }, [startCapture]);

  const resume = useCallback(async () => {
    await startCapture(false);
  }, [startCapture]);

  const pause = useCallback(async () => {
    activeRef.current = false;
    clearAdvisorDebounce();
    advisorEngineRef.current.cancelCurrentRequest();
    screenAnalysisAbortRef.current?.abort();
    screenAnalysisAbortRef.current = null;

    let audioStatus: MeetingAudioStatus | null = null;

    try {
      audioStatus = await invoke<MeetingAudioStatus>(
        "stop_meeting_audio_session"
      );
    } catch (error) {
      console.warn("Failed to pause meeting audio capture", error);
    }

    setState((previous) => ({
      ...previous,
      status: "paused",
      partialSuggestion: "",
      error: null,
      audioStatus,
    }));
  }, [clearAdvisorDebounce]);

  const captureScreenContext = useCallback(
    async (
      source: ScreenObservation["source"] = "full-screen",
      options: CaptureScreenContextOptions = {}
    ) => {
      if (screenCaptureInFlightRef.current) {
        return;
      }

      screenCaptureInFlightRef.current = true;
      const trace = traceStoreRef.current.startTrace(
        "screen",
        {
          source,
          privacyMode: state.settings.privacyMode,
          screenContextEnabled: state.settings.screenContextEnabled,
        },
        options.requestedAt
      );
      let analysisController: AbortController | null = null;
      const returnStatus = state.status;
      const idleReturnStatus = returnStatus === "paused" ? "paused" : "idle";
      let captureStepId: string | undefined;
      let modelStepId: string | undefined;

      try {
        if (
          !state.settings.screenContextEnabled ||
          state.settings.privacyMode !== "text-and-screen-to-cloud"
        ) {
          setState((previous) => ({
            ...previous,
            error: SCREEN_CONTEXT_DISABLED_MESSAGE,
          }));
          traceStoreRef.current.finishTrace(
            trace.id,
            "error",
            SCREEN_CONTEXT_DISABLED_MESSAGE
          );
          return;
        }

        captureStepId = traceStoreRef.current.startStep(
          trace.id,
          "Screen capture command",
          { target: "active-window" }
        );
        const observation = await captureScreenObservation({
          source,
          previousHash: latestScreenHashRef.current,
        });
        traceStoreRef.current.finishStep(trace.id, captureStepId, "success", {
          changed: observation.changed,
          hash: observation.hash,
          imageChars: observation.imageBase64?.length ?? 0,
          imageMediaType: observation.imageMediaType,
          focusImageChars: observation.focusImageBase64?.length ?? 0,
          focusImageMediaType: observation.focusImageMediaType,
          captureTarget: observation.captureTarget,
        });
        options.onCaptured?.();

        latestScreenHashRef.current = observation.hash;
        traceStoreRef.current.recordOutput(
          trace.id,
          "capture metadata",
          formatTraceMetadata({
            observationId: observation.id,
            changed: observation.changed,
            hash: observation.hash,
            captureTarget: observation.captureTarget,
            imageBase64Chars: observation.imageBase64?.length ?? 0,
            imageMediaType: observation.imageMediaType,
            focusImageBase64Chars: observation.focusImageBase64?.length ?? 0,
            focusImageMediaType: observation.focusImageMediaType,
          })
        );

        contextManagerRef.current.addScreenObservation(observation);
        const contextState = contextManagerRef.current.getState();

        setState((previous) => ({
          ...previous,
          status: "thinking",
          screenObservations: contextState.screenObservations,
          partialSuggestion: "",
          error: null,
        }));

        if (!aiProvider) {
          traceStoreRef.current.finishTrace(trace.id, "error", MISSING_AI_MESSAGE);
          setState((previous) => ({
            ...previous,
            status: activeRef.current ? "listening" : idleReturnStatus,
            error: MISSING_AI_MESSAGE,
          }));
          return;
        }

        if (!aiProvider.curl.includes("{{IMAGE}}")) {
          traceStoreRef.current.finishTrace(
            trace.id,
            "error",
            MISSING_VISION_MESSAGE
          );
          setState((previous) => ({
            ...previous,
            status: activeRef.current ? "listening" : idleReturnStatus,
            error: MISSING_VISION_MESSAGE,
          }));
          return;
        }

        screenAnalysisAbortRef.current?.abort();
        analysisController = new AbortController();
        screenAnalysisAbortRef.current = analysisController;

        const autoPrompt = getMeetingScreenAutoPrompt(screenshotConfiguration);
        const analysisContextState = contextManagerRef.current.getState();
        const screenTaskContent = await withTimeout(
          solveScreenAnchoredTask({
            observation,
            provider: aiProvider,
            selectedProvider: selectedAIProvider,
            recentTranscript: formatRecentTranscript(
              analysisContextState.transcriptTurns
            ),
            autoPrompt,
            responseConfig: state.settings.response,
            signal: analysisController.signal,
            trace: {
              onRequest: (input) => {
                traceStoreRef.current.recordInput(
                  trace.id,
                  "screen model input",
                  formatTraceModelInput(input.systemPrompt, input.userMessage),
                  {
                    providerId: input.providerId,
                    mode: input.mode,
                    imageCount: input.imageCount,
                    imageMediaType: input.imageMediaType,
                    responseConfig: input.responseConfig,
                    imageBase64Stored: false,
                  }
                );
                modelStepId = traceStoreRef.current.startStep(
                  trace.id,
                  "Screen model response",
                  {
                    providerId: input.providerId,
                    promptChars:
                      input.systemPrompt.length + input.userMessage.length,
                    imageCount: input.imageCount,
                    imageMediaType: input.imageMediaType,
                    responseLength: input.responseConfig?.length,
                    responseLanguage: input.responseConfig?.language,
                  }
                );
              },
              onFirstToken: () => {
                traceStoreRef.current.updateMetadata(trace.id, {
                  screenFirstTokenAt: Date.now(),
                });
              },
              onComplete: (output) => {
                traceStoreRef.current.recordOutput(
                  trace.id,
                  "screen model raw output",
                  output
                );
              },
            },
            onPartialContent: (partialContent) => {
              if (screenAnalysisAbortRef.current !== analysisController) {
                return;
              }

              setState((previous) => ({
                ...previous,
                status: "thinking",
                partialSuggestion: partialContent,
              }));
            },
          }),
          SCREEN_ANALYSIS_TIMEOUT_MS,
          "Screen context analysis timed out."
        );

        if (screenAnalysisAbortRef.current !== analysisController) {
          traceStoreRef.current.finishStep(
            trace.id,
            modelStepId,
            "cancelled"
          );
          traceStoreRef.current.finishTrace(trace.id, "cancelled");
          return;
        }

        traceStoreRef.current.finishStep(trace.id, modelStepId, "success", {
          outputChars: screenTaskContent.length,
        });
        screenAnalysisAbortRef.current = null;

        contextManagerRef.current.updateScreenObservation(observation.id, {
          visualSummary: screenTaskContent,
          analysisPromptSource: autoPrompt
            ? "screenshot-auto-prompt"
            : "meeting-default",
        });

        let updatedContextState = contextManagerRef.current.getState();
        const basedOnTurnIds = updatedContextState.transcriptTurns
          .slice(-6)
          .map((turn) => turn.id);
        const requestId = createMeetingId("screen_task");
        const question = extractScreenTaskQuestion(screenTaskContent);
        const taskKind = inferScreenTaskKind(screenTaskContent);
        const now = Date.now();

        if (screenTaskContent.trim() && taskKind !== "non-question") {
          contextManagerRef.current.setActiveScreenTask({
            id: requestId,
            observationId: observation.id,
            createdAt: now,
            updatedAt: now,
            expiresAt: getActiveScreenTaskExpiresAt(state.settings, now),
            question: question || undefined,
            kind: taskKind,
            language: inferScreenTaskLanguage(screenTaskContent),
            content: screenTaskContent,
            basedOnTurnIds,
            basedOnObservationId: observation.id,
          });
        } else {
          contextManagerRef.current.clearActiveScreenTask();
        }

        updatedContextState = contextManagerRef.current.getState();
        const uiStepId = traceStoreRef.current.startStep(
          trace.id,
          "Meeting Assistant state updated",
          {
            activeScreenTaskId: updatedContextState.activeScreenTask?.id,
            suggestionKind: screenTaskContent.trim() ? "screen-task" : "silent",
          }
        );

        setState((previous) => ({
          ...previous,
          status: activeRef.current ? "listening" : idleReturnStatus,
          partialSuggestion: "",
          screenObservations: updatedContextState.screenObservations,
          activeScreenTask: updatedContextState.activeScreenTask,
          latestSuggestion: screenTaskContent.trim()
            ? {
                id: requestId,
                kind: "screen-task",
                content: screenTaskContent.trim(),
                screenTaskAnswer: parseScreenTaskAnswer(
                  screenTaskContent.trim()
                ),
                createdAt: Date.now(),
                basedOnTurnIds,
                basedOnObservationIds: [observation.id],
                confidence: "medium",
              }
            : {
                id: requestId,
                kind: "silent",
                content: "",
                createdAt: Date.now(),
                basedOnTurnIds,
                basedOnObservationIds: [observation.id],
                confidence: "low",
              },
          error: null,
        }));
        traceStoreRef.current.finishStep(trace.id, uiStepId, "success");
        traceStoreRef.current.finishTrace(trace.id, "success");
      } catch (error) {
        analysisController?.abort();
        if (screenAnalysisAbortRef.current === analysisController) {
          screenAnalysisAbortRef.current = null;
        }

        if (error instanceof Error && error.name === "AbortError") {
          traceStoreRef.current.finishStep(
            trace.id,
            modelStepId,
            "cancelled",
            undefined,
            error
          );
          traceStoreRef.current.finishTrace(trace.id, "cancelled", error);
          return;
        }

        traceStoreRef.current.finishStep(
          trace.id,
          captureStepId,
          "error",
          undefined,
          error
        );
        traceStoreRef.current.finishStep(
          trace.id,
          modelStepId,
          "error",
          undefined,
          error
        );
        traceStoreRef.current.finishTrace(trace.id, "error", error);

        setState((previous) => ({
          ...previous,
          status: activeRef.current ? "listening" : "error",
          error:
            error instanceof Error
              ? error.message
              : "Failed to capture screen context.",
        }));
      } finally {
        screenCaptureInFlightRef.current = false;
      }
    },
    [
      aiProvider,
      selectedAIProvider,
      screenshotConfiguration,
      state.settings,
      state.status,
    ]
  );

  const currentSuggestionText =
    state.partialSuggestion || state.latestSuggestion?.content || "";

  const regenerateSuggestion = useCallback(async () => {
    await runAdvisor({
      force: true,
      mode: "regenerate",
      currentSuggestion: currentSuggestionText,
    });
  }, [currentSuggestionText, runAdvisor]);

  const makeSuggestionShorter = useCallback(async () => {
    if (!currentSuggestionText.trim()) {
      setState((previous) => ({
        ...previous,
        error: NO_SUGGESTION_MESSAGE,
      }));
      return;
    }

    await runAdvisor({
      force: true,
      mode: "regenerate",
      responseConfigOverride: {
        ...state.settings.response,
        length: getNextShorterResponseLength(state.settings.response.length),
      },
      currentSuggestion: currentSuggestionText,
    });
  }, [currentSuggestionText, runAdvisor, state.settings.response]);

  const applyResponseAction = useCallback(
    async (responseAction: MeetingResponseActionMode) => {
      if (!currentSuggestionText.trim()) {
        setState((previous) => ({
          ...previous,
          error: NO_SUGGESTION_MESSAGE,
        }));
        return;
      }

      await runAdvisor({
        force: true,
        mode: "response-action",
        responseAction,
        currentSuggestion: currentSuggestionText,
      });
    },
    [currentSuggestionText, runAdvisor]
  );

  const answerClarifyingQuestion = useCallback(
    async (question: string, answer: ClarifyingQuestionAnswer) => {
      const trimmedQuestion = question.trim();
      if (!trimmedQuestion) return;

      const hasActiveScreenTask = Boolean(
        contextManagerRef.current.getState().activeScreenTask
      );

      await runAdvisor({
        force: true,
        mode: hasActiveScreenTask ? "screen-anchored" : "clarifying-answer",
        currentSuggestion: currentSuggestionText,
        clarifyingFeedback: {
          question: trimmedQuestion,
          answer,
        },
      });
    },
    [currentSuggestionText, runAdvisor]
  );

  useEffect(() => {
    let cancelled = false;

    const loadPersistedTraceMetrics = async () => {
      try {
        const payload = await invoke<string>("read_meeting_trace_metrics");
        if (cancelled) return;

        const traces = parseMeetingTraceMetrics(payload);
        lastTraceMetricsPayloadRef.current = traces.length
          ? serializeMeetingTraceMetrics(traces)
          : null;
        if (traces.length) {
          traceStoreRef.current.hydrate(traces);
        }
      } catch (error) {
        console.warn("Failed to load meeting trace metrics", error);
      } finally {
        if (!cancelled) {
          traceMetricsPersistenceReadyRef.current = true;
        }
      }
    };

    void loadPersistedTraceMetrics();

    return () => {
      cancelled = true;
      if (traceMetricsPersistTimerRef.current !== null) {
        window.clearTimeout(traceMetricsPersistTimerRef.current);
        traceMetricsPersistTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    traceStoreRef.current.subscribe((traces) => {
      setState((previous) => ({
        ...previous,
        traces,
      }));
      scheduleTraceMetricsPersistence();
    });
  }, [scheduleTraceMetricsPersistence]);

  useEffect(() => {
    traceStoreRef.current.setDebugEnabled(state.settings.debugMode);
  }, [state.settings.debugMode]);

  useEffect(() => {
    let disposed = false;
    let unlistenSpeech: (() => void) | undefined;

    const setupListeners = async () => {
      const unlisten = await listen<string>("speech-detected", (event) => {
        speechDetectedHandlerRef.current?.(event.payload);
      });

      if (disposed) {
        unlisten();
        return;
      }

      unlistenSpeech = unlisten;
    };

    void setupListeners().catch((error) => {
      console.warn("Failed to setup meeting speech listener", error);
    });

    return () => {
      disposed = true;
      unlistenSpeech?.();
    };
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (contextManagerRef.current.clearExpiredActiveScreenTask()) {
        setState(clearActiveScreenTaskState);
      }
    }, 60_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    return () => {
      clearAdvisorDebounce();
      if (activeRef.current) {
        void stop();
      }
    };
  }, [clearAdvisorDebounce, stop]);

  return {
    ...state,
    setupWarnings,
    setPrivacyMode,
    setScreenContextEnabled,
    setActiveScreenTaskTimeoutMinutes,
    setDebugMode,
    setResponseConfig,
    setMeetingAudioProfile,
    setMeetingAudioConfig,
    start,
    pause,
    resume,
    stop,
    clearActiveScreenTask,
    clearTraces,
    captureScreenContext,
    regenerateSuggestion,
    makeSuggestionShorter,
    applyResponseAction,
    answerClarifyingQuestion,
    isActive: activeRef.current,
  };
}

function getMeetingScreenAutoPrompt(
  screenshotConfiguration: { mode: string; autoPrompt?: string }
) {
  if (screenshotConfiguration.mode !== "auto") return undefined;

  const trimmedPrompt = screenshotConfiguration.autoPrompt?.trim();
  return trimmedPrompt || undefined;
}

function formatRecentTranscript(
  turns: MeetingAssistantState["transcriptTurns"]
) {
  return turns
    .slice(-8)
    .map((turn) => {
      const speaker = turn.speaker === "me" ? "Me" : "Them";
      return `${speaker}: ${turn.text}`;
    })
    .join("\n");
}

function formatTraceModelInput(systemPrompt: string, userMessage: string) {
  return [
    "<system_prompt>",
    systemPrompt,
    "</system_prompt>",
    "<user_message>",
    userMessage,
    "</user_message>",
  ].join("\n");
}

function formatTraceMetadata(metadata: Record<string, unknown>) {
  return JSON.stringify(metadata, null, 2);
}

function shouldUpdateActiveScreenTaskFromAdvisorOutput(content: string) {
  const normalized = content.trim().toLowerCase();

  if (!normalized || normalized === "-") return false;

  if (!normalized.includes("clarifying question:")) return true;

  return !(
    normalized.includes("new task") ||
    normalized.includes("new question") ||
    normalized.includes("next question") ||
    normalized.includes("recapture") ||
    normalized.includes("capture or state")
  );
}

function shouldIgnoreLowSignalTranscript(
  transcript: string,
  hasActiveScreenTask: boolean
) {
  const trimmed = transcript.trim();
  if (!trimmed) return true;

  const normalized = trimmed
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.()]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return true;
  if (hasTechnicalSignal(trimmed) || hasFollowUpSignal(trimmed)) return false;

  const fillerPhrases = new Set([
    "ah",
    "eh",
    "er",
    "hmm",
    "mm",
    "mhm",
    "uh",
    "um",
    "yeah",
    "yep",
    "yes",
    "no",
    "ok",
    "okay",
    "got it",
    "thanks",
    "thank you",
    "cool",
    "right",
    "sure",
    "sounds good",
    "that sounds good",
    "make sense",
    "makes sense",
    "i see",
    "let me see",
    "one second",
    "just a second",
    "give me a second",
    "hold on",
    "wait a second",
    "no problem",
    "all good",
    "great",
    "perfect",
    "嗯",
    "嗯嗯",
    "呃",
    "啊",
    "哦",
    "好",
    "好的",
    "对",
    "是",
    "是的",
    "可以",
    "谢谢",
    "没问题",
    "明白",
    "懂了",
    "了解",
    "等一下",
    "稍等",
  ]);

  if (fillerPhrases.has(normalized)) return true;

  if (hasActiveScreenTask) {
    return normalized.length < 40;
  }

  return normalized.length < 12 && !trimmed.includes("?");
}

function hasTechnicalSignal(text: string) {
  return (
    /\b(o\s*\(?\s*1|o\s*\(?\s*n|api|async|binary|cache|client|complexity|database|design|dp|embedding|graph|grpc|hash|heap|http|java|javascript|latency|leetcode|memory|python|queue|rag|rate limiter|recursion|rust|scale|search|server|space|sql|stack|thread|time|tree|typescript|vector)\b/i.test(
      text
    ) ||
    /算法|复杂度|缓存|数据库|队列|栈|堆|树|图|递归|并发|异步|接口|系统设计|限流|负载均衡|向量|嵌入/.test(
      text
    )
  );
}

function hasFollowUpSignal(text: string) {
  return /\b(can|could|would|should|how|why|what|when|where|which|explain|optimi[sz]e|improve|change|update|revise|shorter|follow up|edge case|tradeoff|constraint|requirement|same|different|another|instead)\b/i.test(
    text
  );
}

function isTaskSwitchTranscript(text: string) {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return false;

  return (
    /\b(next question|next task|new question|new task|move on|moving on|let s move on|let us move on|switch topic|different question|another question|start over)\b/i.test(
      normalized
    ) ||
    /下一题|下一个问题|下个问题|换一题|换个题|换个问题|新问题|新任务|进入下一|继续下一|换话题/.test(
      text
    )
  );
}
