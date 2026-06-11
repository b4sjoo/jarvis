import { invoke } from "@tauri-apps/api/core";
import { fetchAIResponse } from "@/lib/functions";
import { TYPE_PROVIDER } from "@/types";
import {
  ScreenCaptureTarget,
  InterviewSessionContext,
  InterviewSessionBrief,
  MeetingModelTraceCallbacks,
  MeetingModelRequestOptions,
  MeetingResponseConfig,
  ScreenObservation,
  ScreenQuestionType,
  SelectedInterviewPlaybook,
  SelectedProviderState,
  TaskAskFrame,
  TaskClassifierMetadata,
  TaskTopicDomain,
} from "./types";
import { createMeetingId } from "./context-manager";
import {
  formatInterviewSessionBriefForPrompt,
  formatInterviewSessionContextForPrompt,
} from "./interview-session-context";
import { formatInterviewPlaybookForPrompt } from "./interview-playbook";
import { parseScreenTaskAnswer } from "./screen-task-answer";
import {
  normalizeCanonicalQuestionType,
  normalizeQuestionTypeAlias,
  type CanonicalQuestionType,
} from "./task-taxonomy";

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

export interface PreflightScreenObservationOptions {
  observation: ScreenObservation;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  recentTranscript?: string;
  signal?: AbortSignal;
  trace?: MeetingModelTraceCallbacks;
}

export interface SolveScreenAnchoredTaskOptions {
  observation: ScreenObservation;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  recentTranscript?: string;
  autoPrompt?: string;
  responseConfig?: MeetingResponseConfig;
  memoryContext?: string;
  interviewSessionBrief?: InterviewSessionBrief;
  interviewSessionContext?: InterviewSessionContext;
  screenPreflight?: ScreenPreflightResult;
  interviewPlaybook?: SelectedInterviewPlaybook;
  signal?: AbortSignal;
  requestOptions?: MeetingModelRequestOptions;
  trace?: MeetingModelTraceCallbacks;
  onPartialContent?: (content: string) => void;
}

export interface ScreenPreflightResult extends TaskClassifierMetadata {
  question?: string;
  rawQuestionType?: string;
  canonicalQuestionType?: CanonicalQuestionType;
  targetCompany?: string;
  isBehavioralInterview?: boolean;
  amazonLeadershipPrinciple?: string;
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

const SCREEN_PREFLIGHT_SYSTEM_PROMPT = [
  "You are a fast metadata extractor for Jarvis.",
  "Read the screenshot and return only compact JSON.",
  "Extract visible interview metadata; do not answer the question.",
  "If a cursor-centered focus band is provided, use it to choose the active question.",
  "Do not infer hidden meeting context that is not visible.",
].join(" ");

const SCREEN_TASK_SYSTEM_PROMPT = [
  "You are Jarvis, a private live meeting assistant for a non-native English speaker working as a software engineer.",
  "The screenshot is the primary source of truth. Recent transcript is only supplemental clarification, modification, or follow-up.",
  "Focus on the visible technical question near the user's active work area. If there are multiple questions or distracting text, choose the question most likely being worked on.",
  "If a cursor-centered horizontal focus band is provided, treat it as the primary visual input for selecting the user's current work area while keeping the full screenshot only as surrounding context.",
  "If the screen shows an open field-knowledge question, give a concise and professional answer the user can say in a meeting.",
  "If the screen shows a behavioral interview question, give a concise first-person STAR-style story using relevant memory context when available.",
  "If the screen shows a coding or algorithm question, default to Python unless the screenshot shows another selected or requested language. Give the algorithm idea, implementation, and exact time and space complexity.",
  "For coding or algorithm questions, prioritize a complete runnable implementation over lengthy explanation. Keep 中文思路 and Approach compact enough that the Code section can finish.",
  "Answer directly. Do not describe that you identified, selected, focused on, or can see a question; only put the restated problem in the Question section.",
  "If the transcript changes constraints or asks a follow-up, incorporate it, but never let transcript speculation override visible screen content.",
  "Treat memory context as background only. The screenshot, focus band, visible language selection, and latest transcript have higher priority than memory.",
  "Do not invent colleagues, speakers, meeting dialogue, hidden requirements, or screen content.",
  "Keep the answer useful during a live meeting: compact, direct, and technically precise.",
  "Output the 中文思路 section first so the user can quickly understand the answer plan before speaking.",
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
    applyResponseSettings: false,
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

export async function preflightScreenObservation({
  observation,
  provider,
  selectedProvider,
  recentTranscript,
  signal,
  trace,
}: PreflightScreenObservationOptions): Promise<ScreenPreflightResult> {
  if (!observation.imageBase64) return {};

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
  const userMessage = buildScreenPreflightUserMessage({
    observation,
    recentTranscript,
  });
  const imageInputs = buildScreenPreflightImageInputs(observation);

  trace?.onRequest?.({
    systemPrompt: SCREEN_PREFLIGHT_SYSTEM_PROMPT,
    userMessage,
    imageCount: imageInputs.length,
    imageMediaType:
      imageInputs[0]?.mediaType || observation.imageMediaType || "image/png",
    providerId: provider.id,
    mode: "screen-preflight",
  });

  for await (const chunk of fetchAIResponse({
    provider,
    selectedProvider,
    systemPrompt: SCREEN_PREFLIGHT_SYSTEM_PROMPT,
    userMessage,
    imagesBase64: imageInputs,
    signal,
    applyResponseSettings: false,
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

  const parsed = parseScreenPreflightOutput(content.trim());
  trace?.onComplete?.(content.trim());

  return parsed;
}

export async function solveScreenAnchoredTask({
  observation,
  provider,
  selectedProvider,
  recentTranscript,
  autoPrompt,
  responseConfig,
  memoryContext,
  interviewSessionBrief,
  interviewSessionContext,
  screenPreflight,
  interviewPlaybook,
  signal,
  requestOptions,
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
    responseConfig,
    memoryContext,
    interviewSessionBrief,
    interviewSessionContext,
    screenPreflight,
    interviewPlaybook,
  });
  const imageInputs = buildScreenTaskImageInputs(observation);

  trace?.onRequest?.({
    systemPrompt: SCREEN_TASK_SYSTEM_PROMPT,
    userMessage,
    imageCount: imageInputs.length,
    imageMediaType:
      imageInputs[0]?.mediaType || observation.imageMediaType || "image/png",
    providerId: provider.id,
    mode: "screen-task",
    responseConfig,
    requestOptions,
  });

  for await (const chunk of fetchAIResponse({
    provider,
    selectedProvider,
    systemPrompt: SCREEN_TASK_SYSTEM_PROMPT,
    userMessage,
    imagesBase64: imageInputs,
    signal,
    applyResponseSettings: false,
    requestOptions,
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

function buildScreenPreflightUserMessage({
  observation,
  recentTranscript,
}: {
  observation: ScreenObservation;
  recentTranscript?: string;
}) {
  const target = observation.captureTarget
    ? formatCaptureTargetForPrompt(observation.captureTarget)
    : "Unknown capture target";

  return [
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
    recentTranscript?.trim()
      ? "Transcript content is intentionally omitted for speed and to avoid confusing visible company detection."
      : "No transcript context yet.",
    "</recent_transcript>",
    "<task>",
    "Return JSON only, with no Markdown fences.",
    "Schema:",
    '{"question": string|null, "questionType": "behavioral"|"coding"|"general-system-design"|"ai-ml-system-design"|"project-deep-dive"|"field-knowledge"|"unknown", "askFrame": "hypothetical-design"|"past-project"|"ambiguous"|"direct-answer"|"unknown", "topicDomain": "ai-ml-infra"|"agentic-ai"|"search"|"backend"|"unknown", "projectAnchor": string|null, "confidence": number, "targetCompany": string|null, "isBehavioralInterview": boolean, "amazonLeadershipPrinciple": string|null}',
    "question: the active visible interview/software-engineering question near the cursor, or null.",
    "questionType: classify the question. Use ai-ml-system-design for hypothetical AI/ML infra design such as RAG, model serving, agent memory, evaluation, retrieval, vector search, model routing, or AI platform architecture. Use general-system-design for non-AI backend/system design such as ticket selling, rate limiter, chat, booking, feeds, or storage systems. Use field-knowledge for direct conceptual questions such as 'what is X', 'explain X', 'compare X and Y', or 'what are the tradeoffs of X' when they do not ask to design a system. Use project-deep-dive when the question asks about a project the candidate built, their role, tradeoffs, architecture, impact, or lessons.",
    "askFrame: hypothetical-design for future/imagined design questions; past-project for questions about the candidate's actual past work; ambiguous when it asks both about an existing project and a future improvement; direct-answer for field knowledge, coding, or behavioral questions.",
    "topicDomain: choose agentic-ai for agents, memory, tool use, planning, or agent frameworks; ai-ml-infra for model serving, RAG, vector DB, embeddings, evaluation, data/model pipelines, or ML platforms; search for search/retrieval/ranking systems; backend for general backend systems.",
    "projectAnchor: if the question visibly names or clearly points to a project, return that project name, such as Agentic Memory, Model Interface, NeuralSearch, BeagleStone, AOS Release, or null.",
    "confidence: number from 0 to 1 for the classifier fields.",
    "targetCompany: a visible company name such as Amazon, Google, Microsoft, Meta, Anthropic, OpenAI, Stripe, Airbnb, or null. Use visible text like 'from Amazon' if present.",
    "Do not classify as behavioral only because the target company is visible, because the interview type includes behavioral, or because a previous question was behavioral.",
    "isBehavioralInterview: true only for personal story questions asking about the candidate's past behavior, decisions, conflict, failure, leadership, or examples from experience. It must be false for coding, field-knowledge, AI/ML system design, general system design, and project deep-dive questions.",
    "amazonLeadershipPrinciple: if targetCompany is Amazon and the question clearly maps to one Amazon Leadership Principle, return its name; otherwise null.",
    "For Amazon, prefer Bias for Action when the question asks about moving forward, acting quickly, reversible decisions, or deciding whether to gather more information before acting.",
    "</task>",
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

function buildScreenPreflightImageInputs(observation: ScreenObservation) {
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
  responseConfig,
  memoryContext,
  interviewSessionBrief,
  interviewSessionContext,
  screenPreflight,
  interviewPlaybook,
}: {
  observation: ScreenObservation;
  recentTranscript?: string;
  autoPrompt?: string;
  responseConfig?: MeetingResponseConfig;
  memoryContext?: string;
  interviewSessionBrief?: InterviewSessionBrief;
  interviewSessionContext?: InterviewSessionContext;
  screenPreflight?: ScreenPreflightResult;
  interviewPlaybook?: SelectedInterviewPlaybook;
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
    "<interview_session_brief>",
    formatInterviewSessionBriefForPrompt(interviewSessionBrief),
    "</interview_session_brief>",
    "<interview_session_context>",
    formatInterviewSessionContextForPrompt(interviewSessionContext),
    "</interview_session_context>",
    "<screen_preflight>",
    formatScreenPreflightForPrompt(screenPreflight),
    "</screen_preflight>",
    "<interview_playbook>",
    formatInterviewPlaybookForPrompt(interviewPlaybook),
    "</interview_playbook>",
    "<response_preferences>",
    formatScreenTaskResponsePreferences(responseConfig),
    "</response_preferences>",
    "<memory_context>",
    memoryContext?.trim() || "No memory context was injected.",
    "</memory_context>",
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
    "Use 中文思路 as the first section. It must give the concise Chinese reasoning path the user can glance at first.",
    "The Answer section must directly answer the selected target in meeting-ready wording; do not say which question you identified, selected, or focused on.",
    "Put supporting details after Answer. Do not put code blocks in Approach; code belongs only in Code.",
    "Follow the natural language response preferences when choosing answer length and explanation language. Do not let those preferences override the selected programming language for code.",
    "Use memory only for stable background knowledge. Do not let memory override visible problem constraints, visible language selection, or spoken follow-up constraints.",
    "Use <screen_preflight> only as a lightweight metadata hint. If the screenshot contradicts it, trust the screenshot.",
    "If <screen_preflight> includes questionType, askFrame, topicDomain, or projectAnchor, use those fields to choose the output contract and memory usage policy.",
    "Use <interview_playbook> as the runtime strategy for the selected question type: follow its first move, clarifying strategy, output contract, and follow-up policy unless the screenshot or transcript contradicts it.",
    "If askFrame is ambiguous between an existing project deep dive and a future system design improvement, do not guess. Ask a clarifying question such as whether to discuss the existing implementation first or propose a future design improvement.",
    "For behavioral interview questions, prefer a concrete first-person story from memory context. Do not invent facts, employers, project names, teammates, metrics, timelines, or outcomes not supported by memory or visible text.",
    "Use <interview_session_context> to personalize behavioral interview answers across screen tasks. If the target company is Amazon and injected memory includes Leadership Principle guidance, internally classify the visible question to the closest principle, demonstrate Strength signals, and avoid Concern signals. Do not explicitly name the principle unless asked or useful.",
    "If memory supports only a qualitative outcome, state the outcome qualitatively instead of adding unsupported numbers, dates, durations, or speed claims.",
    "If it is a coding/algorithm question, output:",
    "中文思路: 用中文简洁说明解题步骤、关键不变量、以及为什么是最优。",
    "Answer: directly state the optimal approach in the selected/requested language.",
    "Approach: explain the reasoning in a few direct bullets or short sentences, without code blocks.",
    "Code: provide code in the selected/requested language, or Python if no language is visible.",
    "Complexity: include time and space complexity.",
    "Question: restate the exact visible problem or the best focused version.",
    "Clarifying question: one click-answerable question if a constraint is missing, otherwise '-'.",
    "Clarifying options: two short option labels if the clarifying question has two plausible directions, otherwise '-'.",
    "If it is a behavioral interview question, output:",
    "中文思路: 用中文概括选用哪个故事、主线动作、风险/取舍、以及要避免的表达坑。",
    "Answer: give a compact first-person story that directly answers what happened, what decision path you took, and whether it turned out correct.",
    "Approach: briefly name why this example fits the question and the key decision/tradeoff.",
    "Code: -",
    "Complexity: -",
    "Question: restate the visible behavioral question.",
    "Clarifying question: one click-answerable question if useful, otherwise '-'.",
    "Clarifying options: two short option labels if useful, otherwise '-'.",
    "If it is an AI/ML system design question, output:",
    "中文思路: 用中文先给 AI/ML infra 设计抓手：目标/指标、数据来源、retrieval/model layer、serving path、evaluation/feedback loop、latency/cost/safety，以及建议先问的问题。",
    "Answer: give a short opening answer or framing statement, then include 2-3 requirement clarification questions that would materially change the design, such as target metric, traffic scale, latency budget, data freshness, evaluation standard, or safety constraint. If important requirements are missing, do not fake a full design; propose the first AI/ML design direction and ask for the highest-value clarification.",
    "Approach: outline objective and success metrics, data and indexing/retrieval path, model/serving architecture, evaluation and feedback loop, scaling, latency/cost, reliability, and safety tradeoffs. If the visible question asks about metrics, logs, evaluation, quality, observability, or whether the agent/system improved, include concrete north-star, online, offline eval, agent trajectory, latency/cost, and guardrail metrics plus a log schema with trace/correlation id and event fields.",
    "Code: -",
    "Complexity: include throughput, storage, latency budget, model/retrieval cost, or algorithmic complexity only when applicable; otherwise '-'.",
    "Question: restate the visible AI/ML system design question.",
    "Clarifying question: one concrete question that would most improve the design, such as target metric, traffic scale, latency budget, data freshness, evaluation standard, or safety constraint; otherwise '-'.",
    "Clarifying options: two short option labels if the clarification is a choice, otherwise '-'.",
    "If it is a general backend/system design question, output:",
    "中文思路: 用中文先给通用系统设计抓手：核心需求、规模、API/data model、consistency、latency、可靠性、成本取舍，以及建议先问的问题。",
    "Answer: give a short opening answer or framing statement, include a rough QPS/capacity estimate if traffic numbers are visible, and include 2-3 requirement clarification questions that would materially change the design. If scale is not visible, explicitly say you would first ask for DAU/actions-per-user/peak factor before estimating QPS; use QPS = users * actions_per_user_per_day / 86400 * peak_factor as the default estimation frame. If important requirements are missing, do not fake a full design; propose the first backend design direction and ask for the highest-value clarification.",
    "Approach: outline requirements, APIs/data model, architecture, scaling, consistency, reliability, observability, and tradeoffs.",
    "Code: -",
    "Complexity: include throughput, storage, latency, or algorithmic complexity only when applicable; otherwise '-'.",
    "Question: restate the visible general system design question.",
    "Clarifying question: one concrete question that would most improve the design, such as scale, consistency, latency, or product constraint; otherwise '-'.",
    "Clarifying options: two short option labels if the clarification is a choice, otherwise '-'.",
    "If it is a project deep-dive question, output:",
    "中文思路: 用中文概括项目背景、你的角色、架构、难点、关键技术决策、tradeoff、validation、impact。",
    "Answer: give a compact first-person technical project narrative grounded in memory; do not invent unsupported facts, metrics, employers, teammates, timelines, or outcomes.",
    "Approach: structure the deep dive as context, my role, architecture, hard problem, decision/tradeoff, validation/debugging, impact, and lesson.",
    "Code: -",
    "Complexity: -",
    "Question: restate the visible project deep-dive question.",
    "Clarifying question: one click-answerable question if the interviewer direction is ambiguous, otherwise '-'.",
    "Clarifying options: two short option labels if useful, otherwise '-'.",
    "If it is a field-knowledge question, output:",
    "中文思路: 用中文列出回答结构和关键技术点。",
    "Answer: directly answer the selected visible question in concise professional meeting-ready wording.",
    "Approach: brief reasoning or key points.",
    "Code: -",
    "Complexity: -",
    "Question: restate the visible question.",
    "Clarifying question: one click-answerable question if useful, otherwise '-'.",
    "Clarifying options: two short option labels if useful, otherwise '-'.",
    "If no meaningful question is visible, output a single dash.",
    "Use these exact section labels.",
    "</task>"
  );

  return sections.join("\n");
}

function formatScreenPreflightForPrompt(
  screenPreflight: ScreenPreflightResult | undefined
) {
  if (!screenPreflight) {
    return "No screen preflight metadata was extracted.";
  }

  return JSON.stringify(screenPreflight);
}

function parseScreenPreflightOutput(output: string): ScreenPreflightResult {
  if (!output) return {};

  const jsonText = output.match(/\{[\s\S]*\}/)?.[0] ?? output;
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const question = readOptionalString(parsed.question);
    const fallbackClassifier = inferTaskClassifierFromText(question ?? output);
    const rawQuestionType = readOptionalString(parsed.questionType);
    const questionType =
      readScreenTaskKind(rawQuestionType) ?? fallbackClassifier.questionType;
    return {
      question,
      rawQuestionType,
      questionType,
      canonicalQuestionType: normalizeCanonicalQuestionType(questionType),
      askFrame:
        readTaskAskFrame(parsed.askFrame) ?? fallbackClassifier.askFrame,
      topicDomain:
        readTaskTopicDomain(parsed.topicDomain) ??
        fallbackClassifier.topicDomain,
      projectAnchor:
        readOptionalString(parsed.projectAnchor) ??
        fallbackClassifier.projectAnchor,
      confidence:
        typeof parsed.confidence === "number"
          ? clampConfidence(parsed.confidence)
          : fallbackClassifier.confidence,
      targetCompany: readOptionalString(parsed.targetCompany),
      isBehavioralInterview:
        typeof parsed.isBehavioralInterview === "boolean"
          ? parsed.isBehavioralInterview
          : undefined,
      amazonLeadershipPrinciple: readOptionalString(
        parsed.amazonLeadershipPrinciple
      ),
    };
  } catch {
    const fallbackClassifier = inferTaskClassifierFromText(output);
    return {
      question: output.slice(0, 500),
      ...fallbackClassifier,
      canonicalQuestionType: normalizeCanonicalQuestionType(
        fallbackClassifier.questionType
      ),
    };
  }
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readScreenTaskKind(value: unknown): ScreenQuestionType | undefined {
  return normalizeQuestionTypeAlias(value);
}

function readTaskAskFrame(value: unknown): TaskAskFrame | undefined {
  if (typeof value !== "string") return undefined;
  if (
    value === "hypothetical-design" ||
    value === "past-project" ||
    value === "ambiguous" ||
    value === "direct-answer" ||
    value === "unknown"
  ) {
    return value;
  }
  return undefined;
}

function readTaskTopicDomain(value: unknown): TaskTopicDomain | undefined {
  if (typeof value !== "string") return undefined;
  if (
    value === "ai-ml-infra" ||
    value === "agentic-ai" ||
    value === "search" ||
    value === "backend" ||
    value === "unknown"
  ) {
    return value;
  }
  return undefined;
}

function clampConfidence(value: number) {
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function inferTaskClassifierFromText(text: string): TaskClassifierMetadata {
  const normalized = text.toLowerCase();
  const questionType = inferScreenTaskKind(text);
  const askFrame = inferAskFrame(normalized, questionType);
  const topicDomain = inferTopicDomain(normalized);

  return {
    questionType,
    askFrame,
    topicDomain,
    projectAnchor: inferProjectAnchor(text),
    confidence: questionType === "unknown" ? 0.35 : 0.65,
  };
}

function inferAskFrame(
  normalized: string,
  questionType: ScreenQuestionType
): TaskAskFrame {
  const hasPastProjectSignal =
    /\b(your project|you built|you designed|you implemented|walk me through|tell me about|your role|tradeoff you made|impact|lesson)\b/.test(
      normalized
    );
  const hasHypotheticalSignal =
    /\b(how would you|design a|design an|build a|architect|propose|improve|what would you do)\b/.test(
      normalized
    );

  if (hasPastProjectSignal && hasHypotheticalSignal) return "ambiguous";
  if (hasPastProjectSignal || questionType === "project-deep-dive") {
    return "past-project";
  }
  if (
    hasHypotheticalSignal ||
    questionType === "general-system-design" ||
    questionType === "ai-ml-system-design"
  ) {
    return "hypothetical-design";
  }
  if (questionType === "unknown") return "unknown";
  return "direct-answer";
}

function inferTopicDomain(normalized: string): TaskTopicDomain {
  if (/\b(agent|agentic|memory|tool use|planner|planning)\b/.test(normalized)) {
    return "agentic-ai";
  }
  if (
    /\b(rag|retrieval augmented|embedding|vector|model serving|llm|ml|ai|model routing|evaluation|eval|inference|fine-tuning|feature store)\b/.test(
      normalized
    )
  ) {
    return "ai-ml-infra";
  }
  if (/\b(search|ranking|retrieval|query|indexing)\b/.test(normalized)) {
    return "search";
  }
  if (
    /\b(rate limiter|ticket|booking|chat|feed|database|cache|queue|backend|microservice)\b/.test(
      normalized
    )
  ) {
    return "backend";
  }
  return "unknown";
}

function inferProjectAnchor(text: string) {
  const projects = [
    "Agentic Memory",
    "Model Interface",
    "NeuralSearch",
    "Managed Semantic Search",
    "BeagleStone",
    "AOS Release",
    "Oasis",
    "Throttling",
  ];
  const normalized = text.toLowerCase();
  return projects.find((project) => normalized.includes(project.toLowerCase()));
}

function formatScreenTaskResponsePreferences(
  config: MeetingResponseConfig | undefined
) {
  if (!config) {
    return "Length: normal\nNatural language: auto";
  }

  const length =
    config.length === "short"
      ? "short; keep sections compact while preserving required labels"
      : config.length === "detailed"
        ? "detailed; include more reasoning or implementation detail when useful"
        : "normal; use the default compact Jarvis style";
  const language =
    config.language === "english"
      ? "English; use meeting-ready English for prose"
      : config.language === "chinese"
        ? "Chinese; explain prose in concise Chinese while preserving technical terms"
        : "auto; follow visible task and transcript context";

  return [
    `Length: ${length}`,
    `Natural language: ${language}`,
    "Programming language for code must still follow visible screen language, transcript constraints, then Python default.",
  ].join("\n");
}

function formatCaptureTargetForPrompt(target: ScreenCaptureTarget) {
  const parts = [
    target.targetType,
    target.appName ? `app=${target.appName}` : undefined,
    target.title ? `title=${target.title}` : undefined,
    target.captureMethod ? `method=${target.captureMethod}` : undefined,
    target.selectionReason ? `selection=${target.selectionReason}` : undefined,
    target.zOrderIndex !== undefined ? `zOrder=${target.zOrderIndex}` : undefined,
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

export function inferScreenTaskKind(content: string): ScreenQuestionType {
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

  if (
    /\b(project deep dive|project dive|technical deep dive|tell me about your project|walk me through your project|your most complex project|your role|tradeoff you made|system you built|architecture you built|implementation you built)\b/i.test(
      content
    )
  ) {
    return "project-deep-dive";
  }

  if (
    /\b(rag|retrieval augmented|llm|large language model|embedding|vector database|vector db|model serving|model routing|inference service|ml platform|ai platform|agent memory|agentic memory|agent framework|evaluation pipeline|eval pipeline|fine-tuning|feature store)\b/i.test(
      content
    ) &&
    /\b(system design|design a|design an|how would you|build a|architect|architecture|scalability|serving|pipeline|platform)\b/i.test(
      content
    )
  ) {
    return "ai-ml-system-design";
  }

  if (
    /\b(system design|design a|design an|architecture|distributed system|high concurrency|scalability|rate limiter|ticket selling|double-booking|consistency|sharding|booking system|chat system)\b/i.test(
      content
    )
  ) {
    return "general-system-design";
  }

  if (
    /\b(what is|what are|explain|compare|why|how does|tradeoff|trade-off|pros and cons|advantages|disadvantages)\b/i.test(
      content
    ) &&
    /\b(ai|ml|llm|rag|retrieval augmented generation|embedding|vector database|vector db|model serving|inference|fine tuning|finetuning|training|evaluation|evals|transformer|attention|tokenization|lora|qlora|rlhf|dpo|agent|agentic|mcp|kv cache|quantization|cap theorem|consistent hashing|sharding|replication|cache|queue|database|distributed)\b/i.test(
      content
    )
  ) {
    return "field-knowledge";
  }

  if (
    /\b(behavioral|behavioural|leadership principle|tell me about a time|give me an example of a time|describe a time|have you ever|commitment|conflict|disagree|ownership|customer obsession|bias for action)\b/i.test(
      content
    )
  ) {
    return "behavioral";
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
