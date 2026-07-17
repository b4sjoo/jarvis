import { fetchSTT } from "@/lib/functions";
import { TYPE_PROVIDER } from "@/types";
import { SelectedProviderState, TranscriptTurn } from "./types";
import { createMeetingId } from "./context-manager";
import {
  TranscriptValidationDecision,
  validateTranscriptCandidate,
} from "./transcript-validation";

export interface TranscribeMeetingAudioParams {
  audio: Blob;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  prompt?: string;
  terms?: string[];
  speaker?: TranscriptTurn["speaker"];
  source?: TranscriptTurn["source"];
  startedAt?: number;
  endedAt?: number;
}

export interface MeetingTranscriptionResult {
  rawText: string;
  turn: TranscriptTurn | null;
  validation: TranscriptValidationDecision;
}

export async function transcribeMeetingAudio({
  audio,
  provider,
  selectedProvider,
  prompt,
  terms,
  speaker = "them",
  source = "system-audio",
  startedAt,
  endedAt,
}: TranscribeMeetingAudioParams): Promise<MeetingTranscriptionResult> {
  const timestamp = Date.now();
  const text = await fetchSTT({
    provider,
    selectedProvider,
    audio,
    prompt,
    terms,
  });
  const trimmedText = text.trim();
  const validation = validateTranscriptCandidate({
    text: trimmedText,
    speechBiasPrompt: prompt,
    startedAt,
    endedAt,
  });

  if (validation.disposition !== "accepted") {
    return {
      rawText: trimmedText,
      turn: null,
      validation,
    };
  }

  return {
    rawText: trimmedText,
    validation,
    turn: {
      id: createMeetingId("turn"),
      speaker,
      text: trimmedText,
      startedAt: startedAt ?? timestamp,
      endedAt: endedAt ?? Date.now(),
      isFinal: true,
      source,
    },
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
