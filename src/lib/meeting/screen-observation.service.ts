import { createMeetingId } from "./meeting-id.js";
import { streamPreparedMeetingGeneration } from "./meeting-generation-stream.js";
import { MeetingAIResponseOutcomeError } from "./meeting-ai-response.js";
import { formatMeetingResponseLanguage } from "./response-language.js";
import type { PlaybookPhaseDecision } from "./playbook-phase-contracts.js";
import type { ActiveMeetingTask } from "./meeting-task-contracts.js";
import type { WhiteboardFormatPreference } from "./types.js";
import { invoke } from "@tauri-apps/api/core";
import { fetchAIResponseEvents } from "@/lib/functions";
import type { AIResponseExecutionIdentityInput } from "../functions/ai-response-events.js";
import { TYPE_PROVIDER } from "@/types";
import {
  ScreenCaptureTarget,
  AdvisorEvidencePacket,
  InterviewSessionContext,
  InterviewSessionBrief,
  MeetingModelTraceCallbacks,
  MeetingModelRequestOptions,
  MeetingResponseConfig,
  FactAnchorDecision,
  ProjectBindingDecision,
  ScreenObservation,
  ScreenQuestionType,
  SelectedInterviewPlaybook,
  SelectedProviderState,
  TaskAskFrame,
  TaskClassifierMetadata,
  TaskTopicDomain,
} from "./types";
import { formatAdvisorEvidencePacketForPrompt } from "./advisor-evidence-packet";

import {
  formatInterviewSessionBriefForPrompt,
  formatInterviewSessionContextForPrompt,
} from "./interview-session-context";
import { formatInterviewPlaybookForPrompt, withInterviewPlaybookPhase } from "./interview-playbook";
import { formatFactAnchorDecisionForPrompt, PROJECT_FACT_RESPONSE_BOUNDARY } from "./fact-anchor-guardrail";
import { formatProjectBindingDecisionForPrompt } from "./project-binding";
import { formatPlaybookPhaseDecisionForPrompt } from "./playbook-phase";

import { parseMeetingAnswer } from "./meeting-answer";
import {
  resolveScreenPreflightQuestionTypeAuthority,
  type CanonicalQuestionType,
} from "./task-taxonomy";
import {
  inferProgrammingLanguageFromCodeFence,
  normalizeProgrammingLanguageName,
} from "./programming-language";

import {
  formatCapacityEstimationGuardrailForPrompt,
  resolveCapacityEstimationGuardrail,
} from "./capacity-estimation-guardrail";
import {
  collectMeetingAIResponseCandidate,
  requireMeetingAIResponseCandidate,
  type MeetingAIResponseCandidate,
} from "./meeting-ai-response.js";
import {
  SCREEN_FOCUSED_CODE_EXPLANATION_INSTRUCTION,
  SCREEN_TASK_SYSTEM_PROMPT,
} from "./screen-task-system-prompt.js";

export type ScreenCaptureTargetType = "active-window" | "current-monitor";

export interface CaptureScreenObservationOptions {
  source?: ScreenObservation["source"];
  previousHash?: string;
  target?: ScreenCaptureTargetType;
}


export interface PreflightScreenObservationOptions {
  observation: ScreenObservation;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  recentTranscript?: string;
  signal?: AbortSignal;
  executionIdentity?: AIResponseExecutionIdentityInput;
  trace?: MeetingModelTraceCallbacks;
  onParsedResult?: (completion: ScreenPreflightParsedCompletion) => void;
}

export interface ScreenPreflightParsedCompletion {
  result: ScreenPreflightResult;
  providerCompletedAt: number;
  parseCompletedAt: number;
}

export interface SolveScreenAnchoredTaskOptions {
  observation: ScreenObservation;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  recentTranscript?: string;
  autoPrompt?: string;
  responseConfig?: MeetingResponseConfig;
  memoryContext?: string;
  advisorEvidencePacket?: AdvisorEvidencePacket;
  interviewSessionBrief?: InterviewSessionBrief;
  interviewSessionContext?: InterviewSessionContext;
  screenPreflight?: ScreenPreflightResult;
  interviewPlaybook?: SelectedInterviewPlaybook;
  playbookPhaseDecision?: PlaybookPhaseDecision;
  activeMeetingTask?: ActiveMeetingTask;

  factAnchorDecision?: FactAnchorDecision;
  projectBindingDecision?: ProjectBindingDecision;
  whiteboardFormatPreference?: WhiteboardFormatPreference;
  codingSolutionManifestContext?: string;
  signal?: AbortSignal;
  requestOptions?: MeetingModelRequestOptions;
  executionIdentity?: AIResponseExecutionIdentityInput;
  trace?: MeetingModelTraceCallbacks;
  onPartialContent?: (content: string) => void;
  onPartialReset?: () => void;
  onCandidate?: (candidate: Readonly<MeetingAIResponseCandidate>) => void;
}

export interface ScreenPreflightResult extends TaskClassifierMetadata {
  question?: string;
  focusedEvidenceSummary?: string;
  programmingLanguage?: string;
  rawQuestionType?: string;
  fallbackQuestionType?: ScreenQuestionType;
  canonicalQuestionType?: CanonicalQuestionType;
  isBehavioralInterview?: boolean;
  amazonLeadershipPrinciple?: string;
}

export interface CaptureScreenContextResponse {
  imageBase64: string;
  imageMediaType?: string;
  focusImageBase64?: string;
  focusImageMediaType?: string;
  target?: ScreenCaptureTarget;
}


const SCREEN_PREFLIGHT_SYSTEM_PROMPT = [
  "You are a fast metadata extractor for Jarvis.",
  "Read the screenshot and return only compact JSON.",
  "Extract visible interview metadata; do not answer the question.",
  "If a cursor-centered focus band is provided, use it to choose the active question.",
  "Do not infer hidden meeting context that is not visible.",
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
  return createCapturedScreenObservation(capture, { source, previousHash });
}

export function createCapturedScreenObservation(
  capture: CaptureScreenContextResponse,
  { source = "full-screen", previousHash }: Pick<CaptureScreenObservationOptions, "source" | "previousHash"> = {}
): ScreenObservation {
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


export async function preflightScreenObservation({
  observation,
  provider,
  selectedProvider,
  recentTranscript,
  signal,
  executionIdentity,
  trace,
  onParsedResult,
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

  const result = await collectMeetingAIResponseCandidate({
    events: fetchAIResponseEvents({
      provider,
      selectedProvider,
      systemPrompt: SCREEN_PREFLIGHT_SYSTEM_PROMPT,
      userMessage,
      imagesBase64: imageInputs,
      signal,
      applyResponseSettings: false,
      executionIdentity: {
        ...executionIdentity,
        requestId:
          executionIdentity?.requestId ??
          `screen-preflight:${observation.id}`,
        executionPlanId:
          executionIdentity?.executionPlanId ?? observation.id,
        logicalQuestionUnitId:
          executionIdentity?.logicalQuestionUnitId ?? observation.id,
        logicalQuestionRevision:
          executionIdentity?.logicalQuestionRevision ?? 0,
      },
    }),
    onFirstContent: () => trace?.onFirstToken?.(),
    onTerminal: (outcome) => trace?.onTerminal?.(outcome),
  });
  const candidate = requireMeetingAIResponseCandidate(result);
  const content = candidate.content.trim();
  const parsed = parseScreenPreflightOutput(content);
  onParsedResult?.({
    result: parsed,
    providerCompletedAt: candidate.outcome.finishedAt,
    parseCompletedAt: Date.now(),
  });
  trace?.onComplete?.(content);

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
  advisorEvidencePacket,
  interviewSessionBrief,
  interviewSessionContext,
  screenPreflight,
  interviewPlaybook,
  playbookPhaseDecision,
  activeMeetingTask,

  factAnchorDecision,
  projectBindingDecision,
  whiteboardFormatPreference,
  codingSolutionManifestContext,
  signal,
  requestOptions,
  executionIdentity,
  trace,
  onPartialContent,
  onPartialReset,
  onCandidate,
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

  const userMessage = buildScreenTaskUserMessage({
    observation,
    recentTranscript,
    autoPrompt,
    responseConfig,
    memoryContext,
    advisorEvidencePacket,
    interviewSessionBrief,
    interviewSessionContext,
    screenPreflight,
    interviewPlaybook,
    playbookPhaseDecision,
    activeMeetingTask,

    factAnchorDecision,
    projectBindingDecision,
    whiteboardFormatPreference,
    codingSolutionManifestContext,
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

  let candidate: Readonly<MeetingAIResponseCandidate> | undefined;
  try {
    for await (const event of streamPreparedMeetingGeneration(executionIdentity?.requestId ?? `screen-solve:${observation.id}`, {
      provider,
      selectedProvider,
      systemPrompt: SCREEN_TASK_SYSTEM_PROMPT,
      userMessage,
      imagesBase64: imageInputs,
      signal,
      applyResponseSettings: false,
      requestOptions,
      executionIdentity: {
        ...executionIdentity,
        requestId:
          executionIdentity?.requestId ?? `screen-solve:${observation.id}`,
        executionPlanId:
          executionIdentity?.executionPlanId ??
          (activeMeetingTask
            ? `${activeMeetingTask.id}:revision:${activeMeetingTask.runtimeRevision}`
            : observation.id),
        logicalQuestionUnitId:
          executionIdentity?.logicalQuestionUnitId ??
          activeMeetingTask?.parent.sourceQuestionUnitId ??
          observation.id,
        logicalQuestionRevision:
          executionIdentity?.logicalQuestionRevision ??
          activeMeetingTask?.parent.sourceQuestionRevision ??
          activeMeetingTask?.runtimeRevision ??
          0,
      },
    }, trace)) {
      if (event.type === "content-delta") onPartialContent?.(event.accumulated);
      else if (event.type === "partial-reset") onPartialReset?.();
      else candidate = event.candidate;
    }
  } catch (error) {
    if (error instanceof MeetingAIResponseOutcomeError) onPartialReset?.();
    throw error;
  }
  if (!candidate) throw new Error("AI response ended without a final outcome");
  onCandidate?.(candidate);
  const trimmed = candidate.content.trim();

  const output = trimmed === "-" ? "" : trimmed;
  trace?.onComplete?.(output);

  return output;
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
    '{"question": string|null, "focusedEvidenceSummary": string|null, "questionType": "behavioral"|"coding"|"general-system-design"|"ai-ml-system-design"|"project-deep-dive"|"field-knowledge"|"unknown", "askFrame": "hypothetical-design"|"past-project"|"ambiguous"|"direct-answer"|"unknown", "topicDomain": "ai-ml-infra"|"agentic-ai"|"search"|"backend"|"unknown", "projectAnchor": string|null, "programmingLanguage": string|null, "confidence": number, "isBehavioralInterview": boolean, "amazonLeadershipPrinciple": string|null}',
    "question: the active visible interview/software-engineering question near the cursor, or null.",
    "focusedEvidenceSummary: one short literal summary, at most 800 characters. Identify the actual cursor/current-line location or visibly highlighted or selected range and the object it points to; distinguish a current-line highlight from a multi-line selection. Preserve visible identifiers, line numbers/ranges, and a few distinguishing statements or error/diagram/UI labels. Use the focus band for location and the supplied full screenshot for visible nearby context. Mark cropped or unreadable portions as unknown; do not infer unseen content. A single localized signature or partial block is useful; do not require full-code coverage or transcribe a complete method body or the whole screen. Return null when no such focused evidence is visible.",
    "questionType: classify the question. Use ai-ml-system-design for hypothetical AI/ML infra design such as RAG, model serving, agent memory, evaluation, retrieval, vector search, model routing, or AI platform architecture. Use general-system-design for non-AI backend/system design such as ticket selling, rate limiter, chat, booking, feeds, or storage systems. Use field-knowledge for direct conceptual questions such as 'what is X', 'explain X', 'compare X and Y', or 'what are the tradeoffs of X' when they do not ask to design a system. Use project-deep-dive when the question asks about a project the candidate built, their role, tradeoffs, architecture, impact, or lessons.",
    "askFrame: hypothetical-design for future/imagined design questions; past-project for questions about the candidate's actual past work; ambiguous when it asks both about an existing project and a future improvement; direct-answer for field knowledge, coding, or behavioral questions.",
    "topicDomain: choose agentic-ai for agents, memory, tool use, planning, or agent frameworks; ai-ml-infra for model serving, RAG, vector DB, embeddings, evaluation, data/model pipelines, or ML platforms; search for search/retrieval/ranking systems; backend for general backend systems.",
    "projectAnchor: if the question visibly names or clearly points to a project, return that project name, such as Agentic Memory, Model Interface, NeuralSearch, BeagleStone, AOS Release, or null.",
    "programmingLanguage: for coding questions, return the visible selected/requested programming language such as Python, Java, Go, TypeScript, JavaScript, C++, Rust, Kotlin, Swift, or null. Only use visible screen evidence, not general problem text.",
    "confidence: number from 0 to 1 for the classifier fields.",
    "Do not classify as behavioral only because the target company is visible, because the interview type includes behavioral, or because a previous question was behavioral.",
    "isBehavioralInterview: true only for personal story questions asking about the candidate's past behavior, decisions, conflict, failure, leadership, or examples from experience. It must be false for coding, field-knowledge, AI/ML system design, general system design, and project deep-dive questions.",
    "amazonLeadershipPrinciple: if the visible question itself clearly maps to one Amazon Leadership Principle, return its name; otherwise null.",
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

function buildScreenTaskUserMessage({
  observation,
  recentTranscript,
  autoPrompt,
  responseConfig,
  memoryContext,
  advisorEvidencePacket,
  interviewSessionBrief,
  interviewSessionContext,
  screenPreflight,
  interviewPlaybook,
  playbookPhaseDecision,
  activeMeetingTask,

  factAnchorDecision,
  projectBindingDecision,
  whiteboardFormatPreference,
  codingSolutionManifestContext,
}: {
  observation: ScreenObservation;
  recentTranscript?: string;
  autoPrompt?: string;
  responseConfig?: MeetingResponseConfig;
  memoryContext?: string;
  advisorEvidencePacket?: AdvisorEvidencePacket;
  interviewSessionBrief?: InterviewSessionBrief;
  interviewSessionContext?: InterviewSessionContext;
  screenPreflight?: ScreenPreflightResult;
  interviewPlaybook?: SelectedInterviewPlaybook;
  playbookPhaseDecision?: PlaybookPhaseDecision;
  activeMeetingTask?: ActiveMeetingTask;

  factAnchorDecision?: FactAnchorDecision;
  projectBindingDecision?: ProjectBindingDecision;
  whiteboardFormatPreference?: WhiteboardFormatPreference;
  codingSolutionManifestContext?: string;
}) {
  const runtimePlaybook = withInterviewPlaybookPhase(
    interviewPlaybook,
    playbookPhaseDecision?.phase
  );
  const capacityEstimationGuardrail =
    resolveCapacityEstimationGuardrail({
      questionType:
        runtimePlaybook?.questionType ??
        screenPreflight?.canonicalQuestionType ??
        screenPreflight?.questionType,
      sourceText: [screenPreflight?.question, recentTranscript]
        .filter(Boolean)
        .join("\n"),
    });
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
    "<advisor_evidence_packet>",
    formatAdvisorEvidencePacketForPrompt(advisorEvidencePacket),
    "</advisor_evidence_packet>",
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
    formatInterviewPlaybookForPrompt(runtimePlaybook),
    "</interview_playbook>",
    "<playbook_phase_state>",
    formatPlaybookPhaseDecisionForPrompt(
      playbookPhaseDecision,
      activeMeetingTask
    ),
    "</playbook_phase_state>",
    "<coding_solution_manifest_context>",
    codingSolutionManifestContext || "No cached Coding solution manifest.",
    "</coding_solution_manifest_context>",
    "<capacity_estimation_guardrail>",
    formatCapacityEstimationGuardrailForPrompt(
      capacityEstimationGuardrail
    ),
    "</capacity_estimation_guardrail>",
    "<whiteboard_format_policy>",
    whiteboardFormatPreference === "plain-text"
      ? "Preference: plain-text. The visible question explicitly requested ASCII or plain text."
      : whiteboardFormatPreference === "mermaid"
        ? "Preference: mermaid. Output exactly one compact valid Mermaid fenced flowchart without speculative nodes or edges."
        : "Preference: none.",
    "</whiteboard_format_policy>",
    "<response_preferences>",
    formatScreenTaskResponsePreferences(responseConfig),
    "</response_preferences>",
    "<memory_context>",
    memoryContext?.trim() || "No memory context was injected.",
    "</memory_context>",
    "<project_binding>",
    formatProjectBindingDecisionForPrompt(projectBindingDecision),
    "</project_binding>",
    "<fact_anchor_guardrail>",
    formatFactAnchorDecisionForPrompt(factAnchorDecision),
    "</fact_anchor_guardrail>",
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
    "Resolve the authoritative current question from <advisor_evidence_packet>. If its source is voice-lqu, answer that exact bounded ask using the screenshot as visual evidence. Otherwise answer the main visible software-engineering question.",
    "If a focus band is present, Image 1 is the cursor-centered horizontal focus band and Image 2 is the full active-window context.",
    "If no focus band is present, Image 1 is the full active-window screenshot.",
    "When the focus band is present, first identify the active question, active code region, visible language setting, or UI option from Image 1. Use Image 2 only to recover surrounding context for that selected target.",
    SCREEN_FOCUSED_CODE_EXPLANATION_INSTRUCTION,
    "Do not answer an earlier, higher, or larger question from the full screenshot when the focus band indicates a different target.",
    "If the focus band shows a selected programming language, language dropdown, or language tab, treat that as an explicit language requirement even if the problem statement is only fully readable in the full screenshot.",
    "Language priority is: selected language in the focus band, explicit language in the full screenshot, transcript clarification, then Python default. Treat TypeScript as TypeScript, not JavaScript. Treat Go or Golang as Go.",
    "If the focus band contains multiple nearby questions, prefer the text block closest to the cursor position inside the focus band.",
    "If the visible UI or focus band indicates a non-Python language, use that language instead of the Python default.",
    "Use 中文思路 as the first section. It must give the concise Chinese reasoning path the user can glance at first.",
    "The Answer section must directly answer the authoritative primary ask in meeting-ready wording; do not say which question you identified, selected, or focused on.",
    "Put supporting details after Answer. Do not put runnable implementation code in Approach; implementation belongs only in Code.",
    "Follow the natural language response preferences when choosing answer length and explanation language. Do not let those preferences override the selected programming language for code.",
    "Use memory only for stable background knowledge. Do not let memory override visible problem constraints, visible language selection, or spoken follow-up constraints.",
    "Treat manual Interview Brief company/type defaults as routing priors only. They cannot create a personal-fact requirement or prove a personal claim.",
    "Only memory entries labeled runtime_role=fact-evidence and anchor_eligible=true may substantiate first-person professional facts. Treat guidance, template, and overlay groups as non-evidentiary assistance.",
    "Use <screen_preflight> only as a lightweight metadata hint. If the screenshot contradicts it, trust the screenshot.",
    "If <screen_preflight> includes questionType, askFrame, topicDomain, or projectAnchor, use those fields to choose the output contract and memory usage policy.",
    "Use <interview_playbook> as the runtime strategy for the selected question type: follow its first move, clarifying strategy, output contract, and follow-up policy unless the screenshot or transcript contradicts it.",
    "Use <playbook_phase_state> to avoid repeating completed phases and to decide whether this turn is asking for requirements, scale, architecture, metrics, or a whiteboard artifact.",
    "Only populate Code, Complexity, or Whiteboard when <playbook_phase_state> lists that artifact as required. Output '-' for an artifact that is not required. A bound voice-lqu primary ask may intentionally narrow the artifact list even when the parent task has reached a later phase.",
    "When one reading of the current ask follows the Authorized Evidence, answer it directly. Ask whether to discuss the existing implementation or a future design improvement only when that choice materially changes the answer and the Authorized Evidence does not resolve it; a missing personal anchor alone is not enough.",
    "For general-system-design and AI/ML system-design tasks, always include a Whiteboard section. During requirement_clarification it must be a shallow PROVISIONAL skeleton based only on known facts with open constraints visible. After readiness, evolve the same artifact with supported APIs/data model/components/flows/reliability/observability. Default to exactly one compact valid Mermaid fenced flowchart. Use plain text only when the visible question explicitly requests ASCII or plain text; never ask which format to use.",
    "For behavioral interview questions, use a concrete first-person story only when eligible fact-evidence supports a relevant story. Otherwise answer the current judgment with a bounded framework or explicit hypothetical example. Do not invent facts, employers, project names, teammates, metrics, timelines, or outcomes from guidance, templates, overlays, or unsupported visible text.",
    "Obey <fact_anchor_guardrail> whenever it requires personal evidence, even if the screen preflight classified the question as coding, field knowledge, system design, or unknown. Missing personal evidence limits first-person claims; it does not by itself require an empty Answer, project selection, or clarification when a bounded analysis or explicit hypothetical example can answer the request.",
    "Obey <project_binding>. A bound project is the exclusive source identity for first-person project facts in this parent task. If Action is needs-selection, do not choose or blend projects silently for facts; still answer any non-factual analysis directly.",
    PROJECT_FACT_RESPONSE_BOUNDARY,
    "If <fact_anchor_guardrail> Action is answer-with-caveats, use only supported facts and avoid unsupported employers, project names, teammates, dates, metrics, ownership, or impact claims.",
    "For answer-with-caveats, preserve a useful general method, tradeoff analysis, or explicitly hypothetical recommendation. Omit unsupported first-person hard facts instead of refusing the entire answer.",
    "Use <interview_session_context> to personalize behavioral interview answers across screen tasks. If the target company is Amazon and injected memory includes Leadership Principle guidance, internally classify the visible question to the closest principle, demonstrate Strength signals, and avoid Concern signals. Do not explicitly name the principle unless asked or useful.",
    "If memory supports only a qualitative outcome, state the outcome qualitatively instead of adding unsupported numbers, dates, durations, or speed claims.",
    "Every non-dash answer must end with two authority metadata sections. Answer disposition: output exactly one of factual-with-anchor, bounded-with-caveat, clarification, supported-choices, or not-fact-dependent. Choose the disposition that describes the answer actually given. For answer-with-caveats, use bounded-with-caveat for direct bounded analysis. Use clarification or supported-choices only when missing information materially prevents a useful answer; a missing personal anchor alone does not do so. Use not-fact-dependent only when Required for is none.",
    "Supporting anchor IDs: for factual-with-anchor, list only the exact supported anchor IDs from <fact_anchor_guardrail> that the answer actually uses, separated by '|'. For every other disposition, output '-'. Never invent, shorten, or translate an anchor ID.",
    "If it is a coding/algorithm question, output:",
    "中文思路: 用中文简洁说明当前 Coding phase 拥有的解题步骤、关键不变量和边界条件；只有 optimized candidate 可见时才说明为什么最优。",
    "Answer: directly state the solution candidate required by <interview_playbook> and <playbook_phase_state> in the requested meeting language.",
    "Approach: explain the reasoning for that same visible candidate in a few direct bullets or short sentences in the requested meeting language, without runnable implementation code or a different algorithm.",
    "Whiteboard: -",
    "Code: when Code is required by <playbook_phase_state>, provide code in the selected/requested language, or Python if no language is visible; otherwise '-'.",
    "Complexity: when Complexity is required by <playbook_phase_state>, include time and space complexity for the same visible candidate in the requested meeting language; otherwise '-'.",
    "Question: restate the exact visible problem or the best focused version in the requested meeting language.",
    "Clarifying question: one click-answerable question in the requested meeting language if a constraint is missing, otherwise '-'.",
    "Clarifying options: 2-4 short option labels in the requested meeting language when the clarifying question has concrete choices; put each option on its own line or separate with '|'. Use '-' only for yes/no questions or when no concrete choices exist.",
    "If it is a behavioral interview question, output:",
    "中文思路: 若有贴题且受支持的故事，用中文概括故事、主线动作、风险/取舍和表达边界；否则概括当前判断的有界回答框架。",
    "Answer: when a relevant supported story exists, give a compact first-person story that directly answers what happened and the decision path. Otherwise give a compact bounded framework or explicit hypothetical example without claiming personal experience.",
    "Approach: briefly name why the supported example fits, or explain the key decision/tradeoff in the bounded framework.",
    "Whiteboard: -",
    "Code: -",
    "Complexity: -",
    "Question: restate the visible behavioral question.",
    "Clarifying question: one click-answerable question if useful, otherwise '-'.",
    "Clarifying options: 2-4 short option labels if useful, otherwise '-'.",
    "If it is an AI/ML system design question, output:",
    "中文思路: 用中文先给 AI/ML infra 设计抓手：目标/指标、数据来源、retrieval/model layer、serving path、evaluation/feedback loop、latency/cost/safety，以及建议先问的问题。",
    "Answer: give a short opening answer or framing statement, then include 2-3 requirement clarification questions that would materially change the design, such as target metric, traffic scale, latency budget, data freshness, evaluation standard, or safety constraint. If important requirements are missing, do not fake a full design; propose the first AI/ML design direction and ask for the highest-value clarification.",
    "Approach: outline objective and success metrics, data and indexing/retrieval path, model/serving architecture, evaluation and feedback loop, scaling, latency/cost, reliability, and safety tradeoffs. If the visible question asks about metrics, logs, evaluation, quality, observability, or whether the agent/system improved, include concrete north-star, online, offline eval, agent trajectory, latency/cost, and guardrail metrics plus a log schema with trace/correlation id and event fields.",
    "Whiteboard: provide exactly one compact valid Mermaid fenced flowchart by default. During requirement_clarification, mark the diagram PROVISIONAL and show only known objective/use case, a broad data/context --> preparation/retrieval/features --> model/agent/decision --> serving/action --> outcome --> evaluation/feedback path, and open constraints. After readiness, refine supported details. Use ASCII only when the visible question explicitly requests it.",
    "Code: -",
    "Complexity: include throughput, storage, latency budget, model/retrieval cost, or algorithmic complexity only when applicable; otherwise '-'.",
    "Question: restate the visible AI/ML system design question.",
    "Clarifying question: one concrete question that would most improve the design, such as target metric, traffic scale, latency budget, data freshness, evaluation standard, or safety constraint; otherwise '-'.",
    "Clarifying options: 2-4 short option labels if the clarification is a choice, otherwise '-'.",
    "If it is a general backend/system design question, output:",
    "中文思路: 用中文先给通用系统设计抓手：核心需求、规模、API/data model、consistency、latency、可靠性、成本取舍，以及建议先问的问题。",
    "Answer: give a short opening answer or framing statement and include 2-3 requirement clarification questions that would materially change the design. Obey <capacity_estimation_guardrail>: calculate rough QPS only when the visible/source evidence provides direct throughput or a request/action time basis. Inventory, user count, read/write ratio, or peak factor alone cannot authorize numeric QPS. Otherwise ask for DAU plus actions-per-user-per-day and peak factor, ask for requests per time window, or state explicit mutable time-basis assumptions before calculating. If important requirements are missing, do not fake a full design; propose the first backend design direction and ask for the highest-value clarification.",
    "Approach: outline requirements, APIs/data model, architecture, scaling, consistency, reliability, observability, and tradeoffs.",
    "Whiteboard: provide exactly one compact valid Mermaid fenced flowchart by default. During requirement_clarification, mark the diagram PROVISIONAL and show only known scope, a Client --> Interface/API --> Core capability --> State boundary --> Response path, and open scale/correctness/latency constraints. After readiness, refine supported details. Use ASCII only when the visible question explicitly requests it.",
    "Code: -",
    "Complexity: include throughput, storage, latency, or algorithmic complexity only when applicable; otherwise '-'.",
    "Question: restate the visible general system design question.",
    "Clarifying question: one concrete question that would most improve the design, such as scale, consistency, latency, or product constraint; otherwise '-'.",
    "Clarifying options: 2-4 short option labels if the clarification is a choice, otherwise '-'.",
    "If it is a project deep-dive question, output:",
    "中文思路: 对需要经历事实的问题概括项目背景、角色、架构、难点与证据边界；对产品判断、tradeoff或future improvement概括有界分析或假设方案。",
    (playbookPhaseDecision?.phase ?? interviewPlaybook?.phase) === "project_summary"
      ? "Answer: a grounded 3-5 minute project summary covering background and scale, personal responsibilities, architecture and tradeoffs, retrospective and refactoring. This phase contract overrides general short-answer preferences. An explicitly requested technical detail still takes priority over an introduction; do not invent facts to fill the duration."
      : "Answer: directly answer the current technical project question using supported facts. For independent product judgment, tradeoffs or hypothetical design, give bounded analysis without inventing personal facts, metrics, employers, teammates, timelines or outcomes.",
    "Approach: use project context, role, architecture, hard problem, decision/tradeoff, validation/debugging, impact, and lesson only when supported facts answer the ask. Otherwise organize the requested analysis around constraints, alternatives, decision, and tradeoff.",
    "Whiteboard: -",
    "Code: -",
    "Complexity: -",
    "Question: restate the visible project deep-dive question.",
    "Clarifying question: one click-answerable question if the interviewer direction is ambiguous, otherwise '-'.",
    "Clarifying options: 2-4 short option labels if useful, otherwise '-'.",
    "If it is a field-knowledge question, output:",
    "中文思路: 用中文列出回答结构和关键技术点。",
    "Answer: directly answer the selected visible question in concise professional meeting-ready wording.",
    "Approach: brief reasoning or key points.",
    "Whiteboard: -",
    "Code: -",
    "Complexity: -",
    "Question: restate the visible question.",
    "Clarifying question: one click-answerable question if useful, otherwise '-'.",
    "Clarifying options: 2-4 short option labels if useful, otherwise '-'.",
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
    const focusedEvidenceSummary = readOptionalString(
      parsed.focusedEvidenceSummary
    )?.slice(0, 800);
    const fallbackClassifier = inferTaskClassifierFromText(question ?? output);
    const rawQuestionType = readOptionalString(parsed.questionType);
    const typeAuthority = resolveScreenPreflightQuestionTypeAuthority({
      rawQuestionType,
      fallbackQuestionType: fallbackClassifier.questionType,
    });
    return {
      question,
      focusedEvidenceSummary,
      rawQuestionType,
      questionType: typeAuthority.questionType,
      fallbackQuestionType: typeAuthority.fallbackQuestionType,
      canonicalQuestionType: typeAuthority.questionType,
      askFrame:
        readTaskAskFrame(parsed.askFrame) ?? fallbackClassifier.askFrame,
      topicDomain:
        readTaskTopicDomain(parsed.topicDomain) ??
        fallbackClassifier.topicDomain,
      projectAnchor:
        readOptionalString(parsed.projectAnchor) ??
        fallbackClassifier.projectAnchor,
      programmingLanguage: normalizeProgrammingLanguageName(
        readOptionalString(parsed.programmingLanguage)
      ),
      confidence:
        typeof parsed.confidence === "number"
          ? clampConfidence(parsed.confidence)
          : fallbackClassifier.confidence,
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
    const typeAuthority = resolveScreenPreflightQuestionTypeAuthority({
      fallbackQuestionType: fallbackClassifier.questionType,
    });
    return {
      question: output.slice(0, 500),
      askFrame: fallbackClassifier.askFrame,
      topicDomain: fallbackClassifier.topicDomain,
      projectAnchor: fallbackClassifier.projectAnchor,
      confidence: fallbackClassifier.confidence,
      questionType: typeAuthority.questionType,
      fallbackQuestionType: typeAuthority.fallbackQuestionType,
      canonicalQuestionType: typeAuthority.questionType,
    };
  }
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
  const length =
    config?.length === "short"
      ? "short; keep sections compact while preserving required labels"
      : config?.length === "detailed"
        ? "detailed; include more reasoning or implementation detail when useful"
        : "normal; use the default compact Jarvis style";
  return [
    `Length: ${length}`,
    formatMeetingResponseLanguage(config?.language),
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
  return parseMeetingAnswer(content).sections.question ?? "";
}

export function inferScreenTaskKind(content: string): ScreenQuestionType {
  const normalized = content.toLowerCase();
  const meetingAnswer = parseMeetingAnswer(content).sections;

  if (!normalized.trim() || normalized.trim() === "-") return "non-question";

  if (
    /\b(o\(|time complexity|space complexity|algorithm|leetcode|python|java|typescript|javascript|array|tree|graph|dp|dynamic programming)\b/i.test(
      content
    ) ||
    (meetingAnswer.code ?? "").trim().length > 5
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

  if (meetingAnswer.question || meetingAnswer.answer) {
    return "field-knowledge";
  }

  return "unknown";
}

export function inferScreenTaskLanguage(content: string) {
  return inferProgrammingLanguageFromCodeFence(content);
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
