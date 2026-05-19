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
  MeetingPrivacyMode,
  MeetingContextManager,
  MeetingSetupWarning,
  ScreenObservation,
  base64WavToBlob,
  captureScreenObservation,
  createMeetingId,
  extractScreenTaskQuestion,
  inferScreenTaskKind,
  inferScreenTaskLanguage,
  solveScreenAnchoredTask,
  transcribeMeetingAudio,
} from "@/lib/meeting";

const ADVISOR_DEBOUNCE_MS = 750;
const STT_TIMEOUT_MS = 30_000;
const SCREEN_ANALYSIS_TIMEOUT_MS = 45_000;

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
const NO_SUGGESTION_MESSAGE = "There is no suggestion to shorten yet.";

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

const INITIAL_STATE: MeetingAssistantState = {
  status: "idle",
  transcriptTurns: [],
  screenObservations: [],
  latestSuggestion: null,
  partialSuggestion: "",
  error: null,
  audioStatus: null,
  settings: {
    screenContextEnabled: false,
    privacyMode: "text-to-cloud",
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
    };
  } catch {
    return DEFAULT_MEETING_ASSISTANT_SETTINGS;
  }
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
  currentSuggestion?: string;
  clarifyingFeedback?: ClarifyingQuestionFeedback;
}

interface CaptureScreenContextOptions {
  onCaptured?: () => void;
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
  const activeRef = useRef(false);
  const latestScreenHashRef = useRef<string | undefined>(undefined);
  const advisorDebounceTimerRef = useRef<number | null>(null);
  const screenAnalysisAbortRef = useRef<AbortController | null>(null);

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

  const stop = useCallback(async () => {
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

    setState((previous) => ({
      ...previous,
      status: "idle",
      partialSuggestion: "",
      error: null,
      audioStatus,
    }));
  }, [clearAdvisorDebounce]);

  const runAdvisor = useCallback(async (options: RunAdvisorOptions = {}) => {
    const mode = options.mode ?? "live";
    const force = options.force ?? false;

    if (!activeRef.current && !force) return;

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
      return;
    }

    if (force && !hasContext && !options.currentSuggestion?.trim()) {
      setState((previous) => ({
        ...previous,
        error: NO_MEETING_CONTEXT_MESSAGE,
      }));
      return;
    }

    if (!aiProvider) {
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
        currentSuggestion: options.currentSuggestion,
        clarifyingFeedback: options.clarifyingFeedback,
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
        finalContent.trim()
      ) {
        contextManagerRef.current.setActiveScreenTask({
          ...contextState.activeScreenTask,
          updatedAt: Date.now(),
          question:
            extractScreenTaskQuestion(finalContent) ||
            contextState.activeScreenTask.question,
          kind: inferScreenTaskKind(finalContent),
          language:
            inferScreenTaskLanguage(finalContent) ||
            contextState.activeScreenTask.language,
          content: finalContent.trim(),
          basedOnTurnIds: latestTurn
            ? [...contextState.activeScreenTask.basedOnTurnIds, latestTurn.id]
            : contextState.activeScreenTask.basedOnTurnIds,
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
    } catch (error) {
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
  }, [aiProvider, selectedAIProvider, state.status]);

  const scheduleAdvisor = useCallback((mode: AdvisorRequestMode = "live") => {
    if (!activeRef.current) return;

    clearAdvisorDebounce();
    advisorDebounceTimerRef.current = window.setTimeout(() => {
      advisorDebounceTimerRef.current = null;
      void runAdvisor({ mode });
    }, ADVISOR_DEBOUNCE_MS);
  }, [clearAdvisorDebounce, runAdvisor]);

  const handleSpeechDetected = useCallback(
    async (base64Audio: string) => {
      if (!activeRef.current) return;

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
        const audio = base64WavToBlob(base64Audio);
        const turn = await withTimeout(
          transcribeMeetingAudio({
            audio,
            provider: sttProvider,
            selectedProvider: selectedSttProvider,
          }),
          STT_TIMEOUT_MS,
          "Speech-to-text timed out. Jarvis is still listening."
        );

        if (!turn) {
          setState((previous) => ({
            ...previous,
            status: activeRef.current ? "listening" : "idle",
          }));
          return;
        }

        contextManagerRef.current.addTranscriptTurn(turn);
        const contextState = contextManagerRef.current.getState();

        setState((previous) => ({
          ...previous,
          status: activeRef.current ? "listening" : "idle",
          transcriptTurns: contextState.transcriptTurns,
          activeScreenTask: contextState.activeScreenTask,
        }));

        scheduleAdvisor(
          contextState.activeScreenTask ? "screen-anchored" : "live"
        );
      } catch (error) {
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
          vadConfig: DEFAULT_MEETING_AUDIO_CONFIG,
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
      let analysisController: AbortController | null = null;
      const returnStatus = state.status;
      const idleReturnStatus = returnStatus === "paused" ? "paused" : "idle";

      try {
        if (
          !state.settings.screenContextEnabled ||
          state.settings.privacyMode !== "text-and-screen-to-cloud"
        ) {
          setState((previous) => ({
            ...previous,
            error: SCREEN_CONTEXT_DISABLED_MESSAGE,
          }));
          return;
        }

        const observation = await captureScreenObservation({
          source,
          previousHash: latestScreenHashRef.current,
        });
        options.onCaptured?.();

        latestScreenHashRef.current = observation.hash;

        contextManagerRef.current.addScreenObservation(observation);
        const contextState = contextManagerRef.current.getState();

        setState((previous) => ({
          ...previous,
          status: "thinking",
          screenObservations: contextState.screenObservations,
          error: null,
        }));

        if (!aiProvider) {
          setState((previous) => ({
            ...previous,
            status: activeRef.current ? "listening" : idleReturnStatus,
            error: MISSING_AI_MESSAGE,
          }));
          return;
        }

        if (!aiProvider.curl.includes("{{IMAGE}}")) {
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
            signal: analysisController.signal,
          }),
          SCREEN_ANALYSIS_TIMEOUT_MS,
          "Screen context analysis timed out."
        );

        if (screenAnalysisAbortRef.current !== analysisController) return;
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

        if (screenTaskContent.trim()) {
          contextManagerRef.current.setActiveScreenTask({
            id: requestId,
            observationId: observation.id,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            question: question || undefined,
            kind: inferScreenTaskKind(screenTaskContent),
            language: inferScreenTaskLanguage(screenTaskContent),
            content: screenTaskContent,
            basedOnTurnIds,
            basedOnObservationId: observation.id,
          });
        } else {
          contextManagerRef.current.clearActiveScreenTask();
        }

        updatedContextState = contextManagerRef.current.getState();

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
      } catch (error) {
        analysisController?.abort();
        if (screenAnalysisAbortRef.current === analysisController) {
          screenAnalysisAbortRef.current = null;
        }

        if (error instanceof Error && error.name === "AbortError") return;

        setState((previous) => ({
          ...previous,
          status: activeRef.current ? "listening" : "error",
          error:
            error instanceof Error
              ? error.message
              : "Failed to capture screen context.",
        }));
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
      mode: "shorter",
      currentSuggestion: currentSuggestionText,
    });
  }, [currentSuggestionText, runAdvisor]);

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
    let unlistenSpeech: (() => void) | undefined;

    const setupListeners = async () => {
      unlistenSpeech = await listen<string>("speech-detected", (event) => {
        void handleSpeechDetected(event.payload);
      });
    };

    void setupListeners();

    return () => {
      unlistenSpeech?.();
    };
  }, [handleSpeechDetected]);

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
    start,
    pause,
    resume,
    stop,
    captureScreenContext,
    regenerateSuggestion,
    makeSuggestionShorter,
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
