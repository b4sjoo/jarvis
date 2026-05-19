import { invoke } from "@tauri-apps/api/core";
import { fetchAIResponse } from "@/lib/functions";
import { TYPE_PROVIDER } from "@/types";
import {
  ScreenCaptureTarget,
  ScreenObservation,
  SelectedProviderState,
} from "./types";
import { createMeetingId } from "./context-manager";

export type ScreenCaptureTargetType = "active-window" | "current-monitor";

export interface CaptureScreenObservationOptions {
  source?: ScreenObservation["source"];
  previousHash?: string;
  target?: ScreenCaptureTargetType;
}

export interface SummarizeScreenObservationOptions {
  observation: ScreenObservation;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  signal?: AbortSignal;
}

interface CaptureScreenContextResponse {
  imageBase64: string;
  target: ScreenCaptureTarget;
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
  target = "active-window",
}: CaptureScreenObservationOptions = {}): Promise<ScreenObservation> {
  const capture = await invoke<CaptureScreenContextResponse>(
    "capture_screen_context_to_base64",
    { target }
  );
  const imageBase64 = capture.imageBase64;
  const hash = hashBase64(imageBase64);

  return {
    id: createMeetingId("screen"),
    capturedAt: Date.now(),
    source,
    imageBase64,
    hash,
    changed: hash !== previousHash,
    captureTarget: capture.target,
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
