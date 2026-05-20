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
  "If the screen shows an open field-knowledge question, give a concise and professional answer the user can say in a meeting.",
  "If the screen shows a coding or algorithm question, default to Python unless the screenshot asks for another language. Give the algorithm idea, implementation, and exact time and space complexity.",
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

  trace?.onRequest?.({
    systemPrompt: SCREEN_TASK_SYSTEM_PROMPT,
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
    systemPrompt: SCREEN_TASK_SYSTEM_PROMPT,
    userMessage,
    imagesBase64: [imageInput],
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
    "Use Answer as the first section. Put supporting details after it.",
    "If it is a coding/algorithm question, output:",
    "Answer: one concise summary of the optimal approach.",
    "Approach: explain the reasoning in a few direct bullets or short sentences.",
    "Code: provide Python code unless another language is visible in the screenshot.",
    "Complexity: include time and space complexity.",
    "Question: restate the exact visible problem or the best focused version.",
    "Clarifying question: one click-answerable question if a constraint is missing, otherwise '-'.",
    "If it is a field-knowledge question, output:",
    "Answer: concise professional meeting-ready answer.",
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

export function extractScreenTaskQuestion(content: string) {
  return readLabeledSection(content, ["Question"]);
}

export function inferScreenTaskKind(content: string): ScreenTaskKind {
  const normalized = content.toLowerCase();

  if (!normalized.trim() || normalized.trim() === "-") return "non-question";

  if (
    /\b(o\(|time complexity|space complexity|algorithm|leetcode|python|java|typescript|javascript|array|tree|graph|dp|dynamic programming)\b/i.test(
      content
    ) ||
    readLabeledSection(content, ["Code"]).trim().length > 5
  ) {
    return "coding";
  }

  if (readLabeledSection(content, ["Question", "Answer"]).trim()) {
    return "field-knowledge";
  }

  return "unknown";
}

export function inferScreenTaskLanguage(content: string) {
  const codeSection = readLabeledSection(content, ["Code"]).toLowerCase();
  const normalized = `${content}\n${codeSection}`.toLowerCase();

  if (normalized.includes("```python") || normalized.includes("python")) {
    return "Python";
  }
  if (normalized.includes("```typescript") || normalized.includes("typescript")) {
    return "TypeScript";
  }
  if (normalized.includes("```javascript") || normalized.includes("javascript")) {
    return "JavaScript";
  }
  if (normalized.includes("```java") || normalized.includes("java")) {
    return "Java";
  }
  if (normalized.includes("```cpp") || normalized.includes("c++")) {
    return "C++";
  }

  return undefined;
}

function readLabeledSection(content: string, labels: string[]) {
  const boundaryLabels = [
    "Question",
    "Answer",
    "Approach",
    "Code",
    "Complexity",
    "Clarifying question",
  ];
  const labelPattern = labels.map(escapeRegExp).join("|");
  const boundaryPattern = boundaryLabels.map(escapeRegExp).join("|");
  const pattern = new RegExp(
    `(?:^|\\n)\\s*(?:[-*]\\s*)?(?:${labelPattern})\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:[-*]\\s*)?(?:${boundaryPattern})\\s*:|$)`,
    "i"
  );
  const match = pattern.exec(content);

  return (match?.[1] ?? "")
    .trim()
    .replace(/^[-*]\s*/, "")
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
