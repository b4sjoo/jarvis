import { fetchSTT } from "@/lib/functions";
import { TYPE_PROVIDER } from "@/types";
import { SelectedProviderState, TranscriptTurn } from "./types";
import { createMeetingId } from "./context-manager";

export interface TranscribeMeetingAudioParams {
  audio: Blob;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  speaker?: TranscriptTurn["speaker"];
  source?: TranscriptTurn["source"];
  startedAt?: number;
  endedAt?: number;
}

export async function transcribeMeetingAudio({
  audio,
  provider,
  selectedProvider,
  speaker = "them",
  source = "system-audio",
  startedAt,
  endedAt,
}: TranscribeMeetingAudioParams): Promise<TranscriptTurn | null> {
  const timestamp = Date.now();
  const text = await fetchSTT({
    provider,
    selectedProvider,
    audio,
  });
  const trimmedText = text.trim();

  if (!trimmedText) return null;

  return {
    id: createMeetingId("turn"),
    speaker,
    text: trimmedText,
    startedAt: startedAt ?? timestamp,
    endedAt: endedAt ?? Date.now(),
    isFinal: true,
    source,
  };
}

export function base64WavToBlob(base64Audio: string) {
  const binaryString = atob(base64Audio);
  const bytes = new Uint8Array(binaryString.length);

  for (let index = 0; index < binaryString.length; index += 1) {
    bytes[index] = binaryString.charCodeAt(index);
  }

  return new Blob([bytes], { type: "audio/wav" });
}

