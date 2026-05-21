import { invoke } from "@tauri-apps/api/core";
import { fetchAIResponse } from "@/lib/functions";
import { TYPE_PROVIDER } from "@/types";
import {
  ScreenCaptureTarget,
  MeetingModelTraceCallbacks,
  ScreenObservation,
  ScreenTaskKind,
  SelectedProviderState,
} from "./types";
import { createMeetingId } from "./context-manager";
import { parseScreenTaskAnswer } from "./screen-task-answer";

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
  autoPrompt?: string;
  signal?: AbortSignal;
  trace?: MeetingModelTraceCallbacks;
}

export interface SolveScreenAnchoredTaskOptions {
  observation: ScreenObservation;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  recentTranscript?: string;
  autoPrompt?: string;
  signal?: AbortSignal;
  trace?: MeetingModelTraceCallbacks;
  onPartialContent?: (content: string) => void;
}

interface CaptureScreenContextResponse {
  imageBase64: string;
  imageMediaType?: string;
  focusImageBase64?: string;
  focusImageMediaType?: string;
  target: ScreenCaptureTarget;
}

const SCREEN_CONTEXT_SYSTEM_PROMPT = [
  "You are reading visible screen content that may be used during a software engineering meeting.",
  "Extract only context that helps a non-native English speaker respond in the meeting.",
  "Focus on visible questions, requirements, errors, code, docs, tickets, diagrams, and technical terms.",
  "Do not invent colleagues, speakers, meeting dialogue, or questions that are not visible.",
  "Be concise and do not invent details that are not visible.",
].join(" ");

const SCREEN_CONTEXT_USER_MESSAGE = [
  "Summarize the visible screen in 1-3 short bullets.",
  "Keep file names, page titles, error messages, function names, and requirements when visible.",
  "If there is no useful meeting context, return a single dash.",
].join(" ");

const SCREEN_TASK_SYSTEM_PROMPT = [
  "You are Jarvis, a private live meeting assistant for a non-native English speaker working as a software engineer.",
  "The screenshot is the primary source of truth. Recent transcript is only supplemental clarification, modification, or follow-up.",
  "Focus on the visible technical question near the user's active work area. If there are multiple questions or distracting text, choose the question most likely being worked on.",
  "If a cursor-centered horizontal focus band is provided, treat it as the primary visual input for selecting the user's current work area while keeping the full screenshot only as surrounding context.",
  "If the screen shows an open field-knowledge question, give a concise and professional answer the user can say in a meeting.",
  "If the screen shows a coding or algorithm question, default to Python unless the screenshot shows another selected or requested language. Give the algorithm idea, implementation, and exact time and space complexity.",
  "Answer directly. Do not describe that you identified, selected, focused on, or can see a question; only put the restated problem in the Question section.",
  "If the transcript changes constraints or asks a follow-up, incorporate it, but never let transcript speculation override visible screen content.",
  "Do not invent colleagues, speakers, meeting dialogue, hidden requirements, or screen content.",
  "Keep the answer useful during a live meeting: compact, direct, and technically precise.",
  "Output the Answer section first so the user can start speaking before reading supporting details.",
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
  const imageMediaType = capture.imageMediaType || "image/png";
  const hash = hashBase64(imageBase64);

  return {
    id: createMeetingId("screen"),
    capturedAt: Date.now(),
    source,
    imageBase64,
    imageMediaType,
    focusImageBase64: capture.focusImageBase64,
    focusImageMediaType: capture.focusImageMediaType,
    hash,
    changed: hash !== previousHash,
    captureTarget: capture.target,
  };
}

export async function summarizeScreenObservation({
  observation,
  provider,
  selectedProvider,
  autoPrompt,
  signal,
  trace,
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
  let firstTokenSeen = false;
  const userMessage = buildScreenContextUserMessage(autoPrompt);

  trace?.onRequest?.({
    systemPrompt: SCREEN_CONTEXT_SYSTEM_PROMPT,
    userMessage,
    imageCount: observation.imageBase64 ? 1 : 0,
    imageMediaType: observation.imageMediaType || "image/png",
    providerId: provider.id,
    mode: "screen-task",
  });

  const imageInput = {
    base64: observation.imageBase64,
    mediaType: observation.imageMediaType || "image/png",
  };

  for await (const chunk of fetchAIResponse({
    provider,
    selectedProvider,
    systemPrompt: SCREEN_CONTEXT_SYSTEM_PROMPT,
    userMessage,
    imagesBase64: [imageInput],
    signal,
  })) {
    if (!firstTokenSeen) {
      firstTokenSeen = true;
      trace?.onFirstToken?.();
    }
    content += chunk;
  }

  if (signal?.aborted) {
    throw createAbortError();
  }

  const trimmed = content.trim();

  const output = trimmed === "-" ? "" : trimmed;
  trace?.onComplete?.(output);

  return output;
}

export async function solveScreenAnchoredTask({
  observation,
  provider,
  selectedProvider,
  recentTranscript,
  autoPrompt,
  signal,
  trace,
  onPartialContent,
}: SolveScreenAnchoredTaskOptions) {
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
  let firstTokenSeen = false;
  const userMessage = buildScreenTaskUserMessage({
    observation,
    recentTranscript,
    autoPrompt,
  });
  const imageInputs = buildScreenTaskImageInputs(observation);

  trace?.onRequest?.({
    systemPrompt: SCREEN_TASK_SYSTEM_PROMPT,
    userMessage,
    imageCount: imageInputs.length,
    imageMediaType: imageInputs[0]?.mediaType || observation.imageMediaType || "image/png",
    providerId: provider.id,
    mode: "screen-task",
  });

  for await (const chunk of fetchAIResponse({
    provider,
    selectedProvider,
    systemPrompt: SCREEN_TASK_SYSTEM_PROMPT,
    userMessage,
    imagesBase64: imageInputs,
    signal,
  })) {
    if (!firstTokenSeen) {
      firstTokenSeen = true;
      trace?.onFirstToken?.();
    }
    content += chunk;
    onPartialContent?.(content);
  }

  if (signal?.aborted) {
    throw createAbortError();
  }

  const trimmed = content.trim();

  const output = trimmed === "-" ? "" : trimmed;
  trace?.onComplete?.(output);

  return output;
}

function buildScreenContextUserMessage(autoPrompt: string | undefined) {
  const trimmedPrompt = autoPrompt?.trim();
  if (!trimmedPrompt) return SCREEN_CONTEXT_USER_MESSAGE;

  return [
    "<configured_screenshot_auto_prompt>",
    trimmedPrompt,
    "</configured_screenshot_auto_prompt>",
    "Follow the configured screenshot auto prompt as the primary task.",
    "Keep the result compact enough to use during a live software engineering meeting.",
    "Describe only the visible screen. Do not say a colleague asked or means something unless that is visible in the screenshot.",
    "If there is no useful visible context, return a single dash.",
  ].join("\n");
}

function buildScreenTaskImageInputs(observation: ScreenObservation) {
  const fullImage = {
    base64: observation.imageBase64 || "",
    mediaType: observation.imageMediaType || "image/png",
  };

  if (observation.focusImageBase64) {
    return [
      {
        base64: observation.focusImageBase64,
        mediaType: observation.focusImageMediaType || "image/jpeg",
      },
      fullImage,
    ].filter((image) => image.base64.trim().length > 0);
  }

  return [fullImage].filter((image) => image.base64.trim().length > 0);
}

function createAbortError() {
  const error = new Error("Screen analysis cancelled.");
  error.name = "AbortError";
  return error;
}

function buildScreenTaskUserMessage({
  observation,
  recentTranscript,
  autoPrompt,
}: {
  observation: ScreenObservation;
  recentTranscript?: string;
  autoPrompt?: string;
}) {
  const target = observation.captureTarget
    ? formatCaptureTargetForPrompt(observation.captureTarget)
    : "Unknown capture target";
  const sections = [
    "<capture_target>",
    target,
    "</capture_target>",
    "<focus_hint>",
    formatCursorFocusForPrompt(observation.captureTarget),
    "</focus_hint>",
    "<image_order>",
    formatImageOrderForPrompt(observation),
    "</image_order>",
    "<recent_transcript>",
    recentTranscript?.trim() || "No transcript context yet.",
    "</recent_transcript>",
  ];

  if (autoPrompt?.trim()) {
    sections.push(
      "<configured_screenshot_auto_prompt>",
      autoPrompt.trim(),
      "</configured_screenshot_auto_prompt>",
      "Use the configured screenshot auto prompt as user preference, but keep the screen-anchored technical answer contract below."
    );
  }

  sections.push(
    "<task>",
    "Read the screenshot and answer the main visible software-engineering question.",
    "If a focus band is present, Image 1 is the cursor-centered horizontal focus band and Image 2 is the full active-window context.",
    "If no focus band is present, Image 1 is the full active-window screenshot.",
    "When the focus band is present, first identify the active question, active code region, visible language setting, or UI option from Image 1. Use Image 2 only to recover surrounding context for that selected target.",
    "Do not answer an earlier, higher, or larger question from the full screenshot when the focus band indicates a different target.",
    "If the focus band shows a selected programming language, language dropdown, or language tab, treat that as an explicit language requirement even if the problem statement is only fully readable in the full screenshot.",
    "Language priority is: selected language in the focus band, explicit language in the full screenshot, transcript clarification, then Python default. Treat TypeScript as TypeScript, not JavaScript. Treat Go or Golang as Go.",
    "If the focus band contains multiple nearby questions, prefer the text block closest to the cursor position inside the focus band.",
    "If the visible UI or focus band indicates a non-Python language, use that language instead of the Python default.",
    "Use Answer as the first section. The Answer section must directly answer the selected target; do not say which question you identified, selected, or focused on.",
    "Put supporting details after Answer. Do not put code blocks in Approach; code belongs only in Code.",
    "If it is a coding/algorithm question, output:",
    "Answer: directly state the optimal approach in the selected/requested language.",
    "Approach: explain the reasoning in a few direct bullets or short sentences, without code blocks.",
    "Code: provide code in the selected/requested language, or Python if no language is visible.",
    "Complexity: include time and space complexity.",
    "Question: restate the exact visible problem or the best focused version.",
    "Clarifying question: one click-answerable question if a constraint is missing, otherwise '-'.",
    "If it is a field-knowledge question, output:",
    "Answer: directly answer the selected visible question in concise professional meeting-ready wording.",
    "Approach: brief reasoning or key points.",
    "Code: -",
    "Complexity: -",
    "Question: restate the visible question.",
    "Clarifying question: one click-answerable question if useful, otherwise '-'.",
    "If no meaningful question is visible, output a single dash.",
    "Use these exact section labels.",
    "</task>"
  );

  return sections.join("\n");
}

function formatCaptureTargetForPrompt(target: ScreenCaptureTarget) {
  const parts = [
    target.targetType,
    target.appName ? `app=${target.appName}` : undefined,
    target.title ? `title=${target.title}` : undefined,
    target.captureMethod ? `method=${target.captureMethod}` : undefined,
    `bounds=${target.width}x${target.height}@${target.x},${target.y}`,
  ].filter(Boolean);

  return parts.join(", ");
}

function formatCursorFocusForPrompt(target: ScreenCaptureTarget | undefined) {
  const cursor = target?.cursor;
  if (!cursor) {
    return "No cursor focus hint was available for this capture.";
  }

  const global = `global=${cursor.globalX},${cursor.globalY}`;
  const relative = `target=${cursor.targetX},${cursor.targetY}`;
  const normalized =
    cursor.normalizedX !== undefined && cursor.normalizedY !== undefined
      ? `normalized=${Math.round(cursor.normalizedX * 100)}%,${Math.round(
          cursor.normalizedY * 100
        )}%`
      : "normalized=unavailable";

  if (!cursor.insideTarget) {
    return [
      `Cursor focus hint: outside captured target (${global}; ${relative}).`,
      "Do not use this cursor position to choose a question.",
    ].join(" ");
  }

  return [
    `Cursor focus hint: inside captured target (${global}; ${relative}; ${normalized}).`,
    target.focusRegion
      ? `A cursor-centered horizontal focus band is included as the first image (${target.focusRegion.imageWidth}x${target.focusRegion.imageHeight}); use it to identify the active question or UI selection before reading the full screenshot.`
      : "No focus band is included, so use the cursor coordinates only as metadata.",
    "When multiple plausible questions or distracting text are visible, prioritize the question, code region, language selector, or UI option closest to this cursor position.",
    "Do not choose an earlier or higher page question when the focus band clearly shows a different active question or visible language option.",
  ].join(" ");
}

function formatImageOrderForPrompt(observation: ScreenObservation) {
  if (!observation.focusImageBase64 || !observation.captureTarget?.focusRegion) {
    return "Image 1: full active-window screenshot. No cursor-centered horizontal focus band was included.";
  }

  const region = observation.captureTarget.focusRegion;
  return [
    `Image 1: cursor-centered horizontal focus band (${region.imageWidth}x${region.imageHeight}) from source region ${region.width}x${region.height}@${region.x},${region.y}; cursor at ${region.cursorX},${region.cursorY} in the band.`,
    "Image 2: full active-window screenshot.",
    "Use Image 1 to choose the current row, nearby text block, language selector, or UI option the user is pointing at. Use Image 2 only as context after that choice.",
  ].join(" ");
}

export function extractScreenTaskQuestion(content: string) {
  return parseScreenTaskAnswer(content).question ?? "";
}

export function inferScreenTaskKind(content: string): ScreenTaskKind {
  const normalized = content.toLowerCase();
  const screenTaskAnswer = parseScreenTaskAnswer(content);

  if (!normalized.trim() || normalized.trim() === "-") return "non-question";

  if (
    /\b(o\(|time complexity|space complexity|algorithm|leetcode|python|java|typescript|javascript|array|tree|graph|dp|dynamic programming)\b/i.test(
      content
    ) ||
    (screenTaskAnswer.code ?? "").trim().length > 5
  ) {
    return "coding";
  }

  if (screenTaskAnswer.question || screenTaskAnswer.answer) {
    return "field-knowledge";
  }

  return "unknown";
}

export function inferScreenTaskLanguage(content: string) {
  const codeSection = (parseScreenTaskAnswer(content).code ?? "").toLowerCase();
  const normalized = `${content}\n${codeSection}`.toLowerCase();

  if (normalized.includes("```typescript") || normalized.includes("typescript")) {
    return "TypeScript";
  }
  if (normalized.includes("```javascript") || normalized.includes("javascript")) {
    return "JavaScript";
  }
  if (/\b(```go|golang|go)\b/i.test(normalized)) {
    return "Go";
  }
  if (normalized.includes("```java") || normalized.includes("java")) {
    return "Java";
  }
  if (normalized.includes("```cpp") || normalized.includes("c++")) {
    return "C++";
  }
  if (normalized.includes("```python") || normalized.includes("python")) {
    return "Python";
  }

  return undefined;
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
