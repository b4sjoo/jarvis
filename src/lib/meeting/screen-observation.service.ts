import { invoke } from "@tauri-apps/api/core";
import { fetchAIResponse } from "@/lib/functions";
import { TYPE_PROVIDER } from "@/types";
import { ScreenObservation, SelectedProviderState } from "./types";
import { createMeetingId } from "./context-manager";

export interface CaptureScreenObservationOptions {
  source?: ScreenObservation["source"];
  previousHash?: string;
}

export interface SummarizeScreenObservationOptions {
  observation: ScreenObservation;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  signal?: AbortSignal;
}

const SCREEN_CONTEXT_SYSTEM_PROMPT = [
  "You are reading a screen shared during a software engineering meeting.",
  "Extract only context that helps a non-native English speaker respond in the meeting.",
  "Focus on visible questions, requirements, errors, code, docs, tickets, diagrams, and technical terms.",
  "Be concise and do not invent details that are not visible.",
].join(" ");

const SCREEN_CONTEXT_USER_MESSAGE = [
  "Summarize the visible screen in 1-3 short bullets.",
  "Keep file names, page titles, error messages, function names, and requirements when visible.",
  "If there is no useful meeting context, return a single dash.",
].join(" ");

export async function captureScreenObservation({
  source = "hotkey",
  previousHash,
}: CaptureScreenObservationOptions = {}): Promise<ScreenObservation> {
  const imageBase64 = await invoke<string>("capture_to_base64");
  const hash = hashBase64(imageBase64);

  return {
    id: createMeetingId("screen"),
    capturedAt: Date.now(),
    source,
    imageBase64,
    hash,
    changed: hash !== previousHash,
  };
}

export async function summarizeScreenObservation({
  observation,
  provider,
  selectedProvider,
  signal,
}: SummarizeScreenObservationOptions) {
  if (!observation.imageBase64) return "";

  if (!provider) {
    throw new Error("Choose an AI provider to analyze screen context.");
  }

  if (!provider.curl.includes("{{IMAGE}}")) {
    throw new Error(
      "Selected AI provider does not support image input for screen context."
    );
  }

  let content = "";

  for await (const chunk of fetchAIResponse({
    provider,
    selectedProvider,
    systemPrompt: SCREEN_CONTEXT_SYSTEM_PROMPT,
    userMessage: SCREEN_CONTEXT_USER_MESSAGE,
    imagesBase64: [observation.imageBase64],
    signal,
  })) {
    content += chunk;
  }

  const trimmed = content.trim();

  return trimmed === "-" ? "" : trimmed;
}

export function hashBase64(value: string) {
  let hash = 0;
  const stride = Math.max(1, Math.floor(value.length / 2048));

  for (let index = 0; index < value.length; index += stride) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return `${value.length}_${Math.abs(hash)}`;
}
