import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useApp } from "@/contexts";
import {
  AdvisorEngine,
  MeetingAssistantState,
  MeetingAudioConfig,
  MeetingContextManager,
  MeetingSetupWarning,
  base64WavToBlob,
  captureScreenObservation,
  summarizeScreenObservation,
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
};

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

export function useMeetingAssistant() {
  const {
    selectedSttProvider,
    allSttProviders,
    selectedAIProvider,
    allAiProviders,
    selectedAudioDevices,
  } = useApp();

  const [state, setState] = useState<MeetingAssistantState>(INITIAL_STATE);
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
  }, [aiProvider, sttProvider]);

  const clearAdvisorDebounce = useCallback(() => {
    if (advisorDebounceTimerRef.current !== null) {
      window.clearTimeout(advisorDebounceTimerRef.current);
      advisorDebounceTimerRef.current = null;
    }
  }, []);

  const stop = useCallback(async () => {
    activeRef.current = false;
    clearAdvisorDebounce();
    advisorEngineRef.current.cancelCurrentRequest();
    screenAnalysisAbortRef.current?.abort();
    screenAnalysisAbortRef.current = null;

    try {
      await invoke("stop_system_audio_capture");
    } catch (error) {
      console.warn("Failed to stop meeting audio capture", error);
    }

    setState((previous) => ({
      ...previous,
      status: "idle",
      partialSuggestion: "",
      error: null,
    }));
  }, [clearAdvisorDebounce]);

  const runAdvisor = useCallback(async () => {
    if (!activeRef.current) return;

    const promptContext = contextManagerRef.current.buildAdvisorPromptContext();
    const latestTurn = promptContext.latestTurn;

    if (!advisorEngineRef.current.shouldRequestSuggestion(latestTurn)) {
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

    const requestId = `advisor_${Date.now()}`;
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
        promptContext,
        provider: aiProvider,
        selectedProvider: selectedAIProvider,
      })) {
        finalContent = event.accumulated;
        setState((previous) => ({
          ...previous,
          partialSuggestion: event.accumulated,
        }));
      }

      const contextState = contextManagerRef.current.getState();
      const latestObservationIds = contextState.screenObservations.map(
        (observation) => observation.id
      );

      setState((previous) => ({
        ...previous,
        status: activeRef.current ? "listening" : "idle",
        latestSuggestion: advisorEngineRef.current.toSuggestion(
          requestId,
          finalContent,
          latestTurn ? [latestTurn.id] : [],
          latestObservationIds
        ),
      }));
    } catch (error) {
      if (!activeRef.current) return;

      setState((previous) => ({
        ...previous,
        status: activeRef.current ? "listening" : "idle",
        partialSuggestion: "",
        error:
          error instanceof Error
            ? error.message
            : "Failed to generate meeting suggestion.",
      }));
    }
  }, [aiProvider, selectedAIProvider]);

  const scheduleAdvisor = useCallback(() => {
    if (!activeRef.current) return;

    clearAdvisorDebounce();
    advisorDebounceTimerRef.current = window.setTimeout(() => {
      advisorDebounceTimerRef.current = null;
      void runAdvisor();
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

        try {
          await invoke("stop_system_audio_capture");
        } catch (error) {
          console.warn("Failed to stop meeting audio capture", error);
        }

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
        }));

        scheduleAdvisor();
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

      await invoke("stop_system_audio_capture");

      const deviceId =
        selectedAudioDevices.output.id &&
        selectedAudioDevices.output.id !== "default"
          ? selectedAudioDevices.output.id
          : null;

      await invoke("start_system_audio_capture", {
        vadConfig: DEFAULT_MEETING_AUDIO_CONFIG,
        deviceId,
      });

      const contextState = contextManagerRef.current.getState();

      setState((previous) => ({
        ...(resetContext ? INITIAL_STATE : previous),
        status: "listening",
        transcriptTurns: contextState.transcriptTurns,
        screenObservations: contextState.screenObservations,
        partialSuggestion: "",
        error: null,
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

    try {
      await invoke("stop_system_audio_capture");
    } catch (error) {
      console.warn("Failed to pause meeting audio capture", error);
    }

    setState((previous) => ({
      ...previous,
      status: "paused",
      partialSuggestion: "",
      error: null,
    }));
  }, [clearAdvisorDebounce]);

  const captureScreenContext = useCallback(async () => {
    let analysisController: AbortController | null = null;

    try {
      const observation = await captureScreenObservation({
        previousHash: latestScreenHashRef.current,
      });

      latestScreenHashRef.current = observation.hash;

      if (!observation.changed) return;

      contextManagerRef.current.addScreenObservation(observation);
      const contextState = contextManagerRef.current.getState();

      setState((previous) => ({
        ...previous,
        screenObservations: contextState.screenObservations,
        error: null,
      }));

      if (!aiProvider) {
        setState((previous) => ({
          ...previous,
          error: MISSING_AI_MESSAGE,
        }));
        return;
      }

      if (!aiProvider.curl.includes("{{IMAGE}}")) {
        setState((previous) => ({
          ...previous,
          error: MISSING_VISION_MESSAGE,
        }));
        return;
      }

      screenAnalysisAbortRef.current?.abort();
      analysisController = new AbortController();
      screenAnalysisAbortRef.current = analysisController;

      const visualSummary = await withTimeout(
        summarizeScreenObservation({
          observation,
          provider: aiProvider,
          selectedProvider: selectedAIProvider,
          signal: analysisController.signal,
        }),
        SCREEN_ANALYSIS_TIMEOUT_MS,
        "Screen context analysis timed out."
      );

      if (screenAnalysisAbortRef.current !== analysisController) return;
      screenAnalysisAbortRef.current = null;

      contextManagerRef.current.updateScreenObservation(observation.id, {
        visualSummary,
      });
      const updatedContextState = contextManagerRef.current.getState();

      setState((previous) => ({
        ...previous,
        screenObservations: updatedContextState.screenObservations,
        error: null,
      }));

      scheduleAdvisor();
    } catch (error) {
      analysisController?.abort();
      if (screenAnalysisAbortRef.current === analysisController) {
        screenAnalysisAbortRef.current = null;
      }

      if (error instanceof Error && error.name === "AbortError") return;

      setState((previous) => ({
        ...previous,
        error:
          error instanceof Error
            ? error.message
            : "Failed to capture screen context.",
        }));
    }
  }, [aiProvider, scheduleAdvisor, selectedAIProvider]);

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
    start,
    pause,
    resume,
    stop,
    captureScreenContext,
    isActive: activeRef.current,
  };
}
