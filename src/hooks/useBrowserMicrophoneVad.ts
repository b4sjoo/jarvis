import { useCallback, useEffect, useRef, useState } from "react";
import {
  createBrowserMicrophoneVad,
  type BrowserMicrophoneVadOptions,
  type BrowserMicrophoneVadState,
} from "@/lib/browser-microphone-vad";

export type UseBrowserMicrophoneVadOptions = Omit<BrowserMicrophoneVadOptions, "onStateChange"> & {
  enabled: boolean;
  // Reuse the consumer's existing audio-session identity across enabled=true renders.
  sessionKey?: string;
};

export function useBrowserMicrophoneVad(options: UseBrowserMicrophoneVadOptions) {
  const callbacks = useRef(options);
  callbacks.current = options;
  const instance = useRef<ReturnType<typeof createBrowserMicrophoneVad> | null>(null);
  const [state, setState] = useState<BrowserMicrophoneVadState>({
    loading: false, listening: false, userSpeaking: false, errored: false,
  });

  useEffect(() => {
    if (!options.enabled) {
      setState((previous) => ({ ...previous, loading: false, listening: false, userSpeaking: false }));
      return;
    }
    const vad = createBrowserMicrophoneVad({
      deviceId: options.deviceId,
      userSpeakingThreshold: options.userSpeakingThreshold,
      onSpeechStart: () => callbacks.current.onSpeechStart?.(),
      onSpeechRealStart: () => callbacks.current.onSpeechRealStart?.(),
      onVADMisfire: () => callbacks.current.onVADMisfire?.(),
      onSpeechEnd: (audio) => callbacks.current.onSpeechEnd?.(audio),
      onObservation: (event) => callbacks.current.onObservation?.(event),
      onStateChange: (next) => { if (instance.current === vad) setState(next); },
    });
    instance.current = vad;
    void vad.start();
    return () => {
      instance.current = null;
      void vad.dispose();
    };
  }, [options.enabled, options.deviceId, options.userSpeakingThreshold, options.sessionKey]);

  const start = useCallback(() => instance.current?.start() ?? Promise.resolve(), []);
  const pause = useCallback(() => instance.current?.pause(), []);
  const dispose = useCallback(() => instance.current?.dispose() ?? Promise.resolve(), []);
  return { ...state, start, pause, dispose };
}
