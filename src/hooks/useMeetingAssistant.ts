import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useApp } from "@/contexts";
import {
  AdvisorEngine,
  MeetingAssistantState,
  MeetingAudioConfig,
  MeetingContextManager,
  base64WavToBlob,
  captureScreenObservation,
  transcribeMeetingAudio,
} from "@/lib/meeting";

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

  const stop = useCallback(async () => {
    activeRef.current = false;
    advisorEngineRef.current.cancelCurrentRequest();

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
  }, []);

  const runAdvisor = useCallback(async () => {
    const promptContext = contextManagerRef.current.buildAdvisorPromptContext();
    const latestTurn = promptContext.latestTurn;

    if (!advisorEngineRef.current.shouldRequestSuggestion(latestTurn)) {
      return;
    }

    const provider = allAiProviders.find(
      (candidate) => candidate.id === selectedAIProvider.provider
    );

    if (!provider) {
      setState((previous) => ({
        ...previous,
        status: "error",
        error: "No AI provider selected for meeting assistant.",
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
        provider,
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
        status: "error",
        error:
          error instanceof Error
            ? error.message
            : "Failed to generate meeting suggestion.",
      }));
    }
  }, [allAiProviders, selectedAIProvider]);

  const handleSpeechDetected = useCallback(
    async (base64Audio: string) => {
      if (!activeRef.current) return;

      const provider = allSttProviders.find(
        (candidate) => candidate.id === selectedSttProvider.provider
      );

      if (!provider) {
        setState((previous) => ({
          ...previous,
          status: "error",
          error: "No speech-to-text provider selected for meeting assistant.",
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
        const turn = await transcribeMeetingAudio({
          audio,
          provider,
          selectedProvider: selectedSttProvider,
        });

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

        await runAdvisor();
      } catch (error) {
        if (!activeRef.current) return;

        setState((previous) => ({
          ...previous,
          status: "error",
          error:
            error instanceof Error
              ? error.message
              : "Failed to transcribe meeting audio.",
        }));
      }
    },
    [allSttProviders, runAdvisor, selectedSttProvider]
  );

  const start = useCallback(async () => {
    setState((previous) => ({
      ...previous,
      status: "starting",
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

      contextManagerRef.current.reset();
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

      setState({
        ...INITIAL_STATE,
        status: "listening",
      });
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
  }, [selectedAudioDevices.output.id]);

  const captureScreenContext = useCallback(async () => {
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
      }));
    } catch (error) {
      setState((previous) => ({
        ...previous,
        error:
          error instanceof Error
            ? error.message
            : "Failed to capture screen context.",
      }));
    }
  }, []);

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
      if (activeRef.current) {
        void stop();
      }
    };
  }, [stop]);

  return {
    ...state,
    start,
    stop,
    captureScreenContext,
    isActive: activeRef.current,
  };
}

