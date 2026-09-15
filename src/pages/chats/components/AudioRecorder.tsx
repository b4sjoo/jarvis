import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components";
import { AudioVisualizer } from "@/pages/app/components/speech/audio-visualizer";
import { shouldUseManagedAPI, fetchSTT } from "@/lib";
import { useApp } from "@/contexts";
import { StopCircle, Send } from "lucide-react";

interface AudioRecorderProps {
  onTranscriptionComplete: (text: string) => void;
  onCancel: () => void;
  onError?: (message: string) => void;
}

const MAX_DURATION = 3 * 60 * 1000;

export const AudioRecorder = ({
  onTranscriptionComplete,
  onCancel,
  onError,
}: AudioRecorderProps) => {
  const { selectedSttProvider, allSttProviders, selectedAudioDevices } =
    useApp();
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [duration, setDuration] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const durationIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const maxDurationTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(false);
  const cancelledRef = useRef(false);
  const sendingRef = useRef(false);
  const transcriptionAbortRef = useRef<AbortController | undefined>(undefined);
  const captureAttemptRef = useRef<object | undefined>(undefined);
  const removeTrackListenersRef = useRef<(() => void) | undefined>(undefined);

  // Cleanup function - stops all tracks and clears refs
  const cleanup = useCallback(() => {
    captureAttemptRef.current = undefined;
    removeTrackListenersRef.current?.();
    removeTrackListenersRef.current = undefined;
    // Clear timers
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
    if (maxDurationTimeoutRef.current) {
      clearTimeout(maxDurationTimeoutRef.current);
      maxDurationTimeoutRef.current = null;
    }

    // Stop media recorder
    if (mediaRecorderRef.current?.state === "recording") {
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {
        // Ignore errors when stopping
      }
    }
    mediaRecorderRef.current = null;

    // Stop all audio tracks - this is critical for releasing the microphone
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => {
        track.stop();
        track.enabled = false;
      });
      streamRef.current = null;
    }

    // Also stop from state
    if (audioStream) {
      audioStream.getTracks().forEach((track) => {
        track.stop();
        track.enabled = false;
      });
    }
    setAudioStream(null);
  }, [audioStream]);

  useEffect(() => {
    mountedRef.current = true;
    cancelledRef.current = false;
    startRecording();

    // Cleanup on unmount
    return () => {
      mountedRef.current = false;
      cancelledRef.current = true;
      transcriptionAbortRef.current?.abort();
      cleanup();
    };
  }, []);

  const startRecording = async () => {
    const attempt = {};
    captureAttemptRef.current = attempt;
    try {
      const deviceId = selectedAudioDevices?.input?.id;
      if (!deviceId) {
        throw new Error("Select a microphone in settings, including Default to use the system default.");
      }

      const audioConstraints: MediaTrackConstraints = deviceId === "default"
        ? {}
        : { deviceId: { exact: deviceId } };

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      });
      if (!mountedRef.current || cancelledRef.current || captureAttemptRef.current !== attempt) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      // Store in both ref and state
      streamRef.current = stream;
      setAudioStream(stream);

      const mimeType = [
        "audio/webm",
        "audio/webm;codecs=opus",
        "audio/ogg;codecs=opus",
        "audio/ogg",
        "audio/mp4",
      ].find((candidate) => MediaRecorder.isTypeSupported(candidate));
      if (!mimeType) {
        throw new Error("This browser does not support an available audio recording format.");
      }

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      startTimeRef.current = Date.now();

      const failCapture = (message: string) => {
        if (!mountedRef.current || cancelledRef.current || captureAttemptRef.current !== attempt) return;
        cancelledRef.current = true;
        transcriptionAbortRef.current?.abort();
        cleanup();
        onError?.(message);
        onCancel();
      };
      const tracks = stream.getTracks();
      tracks.forEach((track) => { track.onended = () => failCapture("Selected microphone was disconnected."); });
      removeTrackListenersRef.current = () => { tracks.forEach((track) => { track.onended = null; }); };
      recorder.onerror = () => failCapture("Audio recording failed.");

      recorder.ondataavailable = (e) => {
        if (mediaRecorderRef.current !== recorder || cancelledRef.current) return;
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.start(100);

      durationIntervalRef.current = setInterval(() => {
        setDuration(Date.now() - startTimeRef.current);
      }, 100);

      maxDurationTimeoutRef.current = setTimeout(() => {
        if (mediaRecorderRef.current?.state === "recording") {
          handleSend();
        }
      }, MAX_DURATION);
    } catch (error) {
      if (captureAttemptRef.current !== attempt) return;
      console.error("Failed to start recording:", error);
      cleanup();
      if (!mountedRef.current || cancelledRef.current) return;
      onError?.(error instanceof Error ? error.message : "Microphone capture failed. Check permission and device selection.");
      onCancel();
    }
  };

  const handleStop = () => {
    cancelledRef.current = true;
    transcriptionAbortRef.current?.abort();
    cleanup();
    onCancel();
  };

  const handleSend = async () => {
    if (!mediaRecorderRef.current || sendingRef.current || cancelledRef.current) return;
    sendingRef.current = true;

    setIsTranscribing(true);

    try {
      const recorder = mediaRecorderRef.current;
      const mimeType = recorder.mimeType;
      if (recorder.state !== "inactive") {
        await new Promise<void>((resolve, reject) => {
          recorder.onstop = () => resolve();
          recorder.onerror = () => reject(new Error("Audio recorder failed while stopping."));
          recorder.stop();
        });
      }
      const chunks = [...audioChunksRef.current];
      cleanup();
      if (!mountedRef.current || cancelledRef.current) return;
      const audioBlob = new Blob(chunks, { type: mimeType });
      const controller = new AbortController();
      transcriptionAbortRef.current = controller;

      const useManagedApi = await shouldUseManagedAPI();
      const provider = allSttProviders.find(
        (p) => p.id === selectedSttProvider.provider
      );

      const text = await fetchSTT({
        provider: useManagedApi ? undefined : provider,
        selectedProvider: selectedSttProvider,
        audio: audioBlob,
        signal: controller.signal,
      });
      if (!mountedRef.current || cancelledRef.current || controller.signal.aborted) return;
      onTranscriptionComplete(text);
    } catch (error) {
      console.error("Transcription failed:", error);
      cleanup();
      if (!mountedRef.current || cancelledRef.current) return;
      onError?.(error instanceof Error ? error.message : "Transcription failed.");
      onCancel();
    }
  };

  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="border bg-background rounded-lg overflow-hidden">
      <div className="h-12 relative bg-muted/20">
        {audioStream ? (
          <div className="h-full w-full pt-3">
            <AudioVisualizer stream={audioStream} isRecording={true} />
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            Initializing...
          </div>
        )}
      </div>
      <div className="flex items-center justify-between px-4 py-2.5 border-t bg-muted/5">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 bg-red-500 rounded-full animate-pulse" />
          <span className="text-sm font-mono tabular-nums font-medium">
            {formatTime(duration)}
          </span>
          <span className="text-xs text-muted-foreground">/ 3:00</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="icon"
            variant="outline"
            onClick={handleStop}
            disabled={isTranscribing}
            className="h-8 w-8"
            title="Stop recording"
          >
            <StopCircle className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            onClick={handleSend}
            disabled={isTranscribing}
            className="h-8 w-8"
            title={isTranscribing ? "Sending..." : "Send to AI"}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
};
