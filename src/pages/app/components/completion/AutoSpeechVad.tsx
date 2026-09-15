import { fetchSTT } from "@/lib";
import { UseCompletionReturn } from "@/types";
import { useBrowserMicrophoneVad } from "@/hooks/useBrowserMicrophoneVad";
import { LoaderCircleIcon, MicIcon, MicOffIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components";
import { useApp } from "@/contexts";
import { floatArrayToWav } from "@/lib/utils";
import { shouldUseManagedAPI } from "@/lib/functions/managed-api";

interface AutoSpeechVADProps {
  submit: UseCompletionReturn["submit"];
  setState: UseCompletionReturn["setState"];
  setEnableVAD: UseCompletionReturn["setEnableVAD"];
  microphoneDeviceId?: string;
}

const AutoSpeechVADInternal = ({
  submit,
  setState,
  setEnableVAD,
  microphoneDeviceId,
}: AutoSpeechVADProps) => {
  const [isTranscribing, setIsTranscribing] = useState(false);
  const activeRef = useRef(true);
  const pendingRef = useRef(new Set<AbortController>());
  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; for (const controller of pendingRef.current) controller.abort(); pendingRef.current.clear(); };
  }, []);
  const { selectedSttProvider, allSttProviders } = useApp();

  const vad = useBrowserMicrophoneVad({
    deviceId: microphoneDeviceId,
    enabled: true,
    userSpeakingThreshold: 0.6,
    onSpeechEnd: async (audio) => {
      if (!activeRef.current) return;
      const controller = new AbortController();
      pendingRef.current.add(controller);
      try {
        // convert float32array to blob
        const audioBlob = floatArrayToWav(audio, 16000, "wav");

        let transcription: string;
        const useManagedApi = await shouldUseManagedAPI();
        if (!activeRef.current || controller.signal.aborted) return;

        // Check if we have a configured speech provider
        if (!selectedSttProvider.provider && !useManagedApi) {
          console.warn("No speech provider selected");
          setState((prev: any) => ({
            ...prev,
            error:
              "No speech provider selected. Please select one in settings.",
          }));
          return;
        }

        const providerConfig = allSttProviders.find(
          (p) => p.id === selectedSttProvider.provider
        );

        if (!providerConfig && !useManagedApi) {
          console.warn("Selected speech provider configuration not found");
          setState((prev: any) => ({
            ...prev,
            error:
              "Speech provider configuration not found. Please check your settings.",
          }));
          return;
        }

        setIsTranscribing(true);

        // Use the fetchSTT function for all providers
        transcription = await fetchSTT({
          provider: useManagedApi ? undefined : providerConfig,
          selectedProvider: selectedSttProvider,
          audio: audioBlob,
          signal: controller.signal,
        });

        if (transcription && activeRef.current && !controller.signal.aborted) {
          submit(transcription);
        }
      } catch (error) {
        if (!activeRef.current || controller.signal.aborted) return;
        console.error("Failed to transcribe audio:", error);
        setState((prev: any) => ({
          ...prev,
          error:
            error instanceof Error ? error.message : "Transcription failed",
        }));
      } finally {
        pendingRef.current.delete(controller);
        if (activeRef.current) setIsTranscribing(pendingRef.current.size > 0);
      }
    },
  });

  useEffect(() => {
    if (!vad.errored) return;
    activeRef.current = false;
    for (const controller of pendingRef.current) controller.abort();
    setState((previous: Record<string, unknown>) => ({ ...previous, error: `Microphone initialization failed: ${vad.errored}` }));
    setEnableVAD(false);
  }, [vad.errored, setState, setEnableVAD]);

  return (
    <>
      <Button
        size="icon"
        onClick={() => {
          if (vad.listening || vad.loading) {
            activeRef.current = false;
            for (const controller of pendingRef.current) controller.abort();
            void vad.dispose();
            setEnableVAD(false);
          } else {
            activeRef.current = true;
            vad.start();
            setEnableVAD(true);
          }
        }}
        className="cursor-pointer"
      >
        {isTranscribing ? (
          <LoaderCircleIcon className="h-4 w-4 animate-spin text-green-500" />
        ) : vad.userSpeaking ? (
          <LoaderCircleIcon className="h-4 w-4 animate-spin" />
        ) : vad.listening ? (
          <MicOffIcon className="h-4 w-4 animate-pulse" />
        ) : (
          <MicIcon className="h-4 w-4" />
        )}
      </Button>
    </>
  );
};

export const AutoSpeechVAD = (props: AutoSpeechVADProps) => {
  return <AutoSpeechVADInternal key={props.microphoneDeviceId} {...props} />;
};
