import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useMicVAD } from "@ricky0123/vad-react";
import { STORAGE_KEYS } from "@/config";
import { useApp } from "@/contexts";
import { safeLocalStorage } from "@/lib";
import { floatArrayToWav } from "@/lib/utils";
import type { TYPE_PROVIDER } from "@/types";
import {
  formatMemorySelectionForTrace,
  retrieveMemoryContext,
  type MemoryAskFrame,
  type MemoryQuestionType,
  type MemoryRetrievalPolicy,
  type MemoryRetrievalResult,
  type MemoryTopicDomain,
  type MemoryUseCase,
} from "@/lib/memory";
import {
  AdvisorEngine,
  AdvisorPromptContext,
  AdvisorSuggestion,
  AdvisorRequestMode,
  ActiveInterviewParent,
  ActiveScreenTask,
  CanonicalQuestionType,
  ClarifyingQuestionAnswer,
  ClarifyingQuestionFeedback,
  MeetingAssistantState,
  MeetingAssistantStatus,
  MeetingAudioConfig,
  MeetingAudioStatus,
  MeetingAssistantSettings,
  MeetingAudioProfile,
  MeetingCodingModelSettings,
  MeetingContextState,
  InterviewBriefType,
  InterviewSubtaskIntent,
  InterviewTaskRelation,
  InterviewSessionBrief,
  MeetingPrivacyMode,
  MeetingResponseActionMode,
  MeetingResponseConfig,
  MeetingContextManager,
  MeetingSetupWarning,
  MeetingTraceStore,
  MeetingTrace,
  MeetingTraceExportRecord,
  MeetingTraceExportTrigger,
  MeetingModelRequestOptions,
  PENDING_CONFIRMATION_TTL_MS,
  OpeningRouteContext,
  ParentQuestionType,
  QuestionEvaluationIdentity,
  QuestionHumanEvaluation,
  ScreenObservation,
  ScreenPreflightResult,
  ScreenQuestionType,
  ScreenTaskKind,
  SelectedProviderState,
  SpeechCorrection,
  SpeechCorrectionRule,
  TaskAskFrame,
  TaskTopicDomain,
  TraceHumanEvaluation,
  TranscriptTurn,
  base64WavToBlob,
  buildAmazonLeadershipPrincipleMemoryHint,
  buildInterviewSessionBriefMemoryHint,
  buildInterviewSessionMemoryHint,
  captureScreenObservation,
  createInterviewSessionContextFromBrief,
  createMeetingId,
  detectInterviewCompany,
  calculateWordEquivalent,
  classifyMeTurn,
  findDuplicateSystemAudioTurnForMeTurn,
  findRecentMeClarificationForTurn,
  isInterviewSessionBriefEmpty,
  normalizeInterviewBriefCompany,
  extractScreenTaskQuestion,
  inferScreenTaskKind,
  inferScreenTaskLanguage,
  isShortConfirmationLike,
  parseMeetingTraceMetrics,
  parseScreenTaskAnswer,
  preflightScreenObservation,
  selectInterviewPlaybook,
  applyPlaybookPhaseDecisionToProgress,
  decidePlaybookPhaseProgression,
  formatPlaybookPhaseDecisionForTrace,
  formatInterviewPlaybookForTrace,
  readTraceHumanEvaluations,
  readQuestionHumanEvaluations,
  buildSpeechBiasContext,
  formatSpeechBiasPromptForTrace,
  normalizeTranscriptWithSpeechBias,
  parseEmergencySpeechCorrection,
  serializeMeetingTraceExport,
  serializeMeetingTraceMetrics,
  SessionRecordingManager,
  areCompatibleQuestionTypes,
  inferCanonicalQuestionTypeFromText,
  isParentCanonicalQuestionType,
  normalizeCanonicalQuestionType,
  normalizeInterviewBriefTypes as normalizeTaxonomyInterviewBriefTypes,
  normalizeQuestionTypeAlias,
  readInterviewBriefType,
  readSingleConcreteInterviewTypeOverride as readTaxonomySingleConcreteInterviewTypeOverride,
  toHumanEvalQuestionType,
  toMemoryUseCaseForQuestionType,
  solveScreenAnchoredTask,
  shouldIncludeTurnInAdvisorPrompt,
  shouldSuppressDuplicateSystemAudioTurn,
  transcribeMeetingAudio,
  upsertTraceHumanEvaluation,
  upsertQuestionHumanEvaluation,
  buildQuestionEvaluationPatchFromTrace,
  persistTraceHumanEvaluations,
  persistQuestionHumanEvaluations,
  buildSessionRecordingProviderSummary,
  buildFactAnchorDecision,
  formatFactAnchorDecisionForTrace,
  getActiveMeetingTaskTraceMetadata,
  PlaybookPhaseDecision,
} from "@/lib/meeting";

const ADVISOR_DEBOUNCE_MS = 750;
const STT_TIMEOUT_MS = 30_000;
const SCREEN_PREFLIGHT_TIMEOUT_MS = 10_000;
const SCREEN_ANALYSIS_TIMEOUT_MS = 45_000;
const CODING_MODEL_REQUEST_TIMEOUT_MS = 120_000;
const CODING_MODEL_MAX_OUTPUT_TOKENS = 16_384;
const DEFAULT_ACTIVE_SCREEN_TASK_TIMEOUT_MINUTES = 30;
const MIN_ACTIVE_SCREEN_TASK_TIMEOUT_MINUTES = 5;
const MAX_ACTIVE_SCREEN_TASK_TIMEOUT_MINUTES = 240;
const TRACE_METRICS_PERSIST_DEBOUNCE_MS = 750;
const TRACE_AUTO_EXPORT_SLOW_THRESHOLDS_MS: Record<
  MeetingTrace["kind"],
  number
> = {
  screen: 15_000,
  voice: 20_000,
};

const MISSING_STT_MESSAGE =
  "Choose a speech-to-text provider in Dev Space before starting Jarvis.";
const MISSING_AI_MESSAGE =
  "Choose an AI provider in Dev Space to receive live suggestions.";
const MISSING_VISION_MESSAGE =
  "Choose an image-capable AI provider to analyze screen context.";
const LOCAL_ONLY_UNAVAILABLE_MESSAGE =
  "Local-only meeting mode needs local STT before it can start.";
const SCREEN_CONTEXT_DISABLED_MESSAGE =
  "Enable Cloud API mode before capturing screen context.";
const NO_MEETING_CONTEXT_MESSAGE =
  "Jarvis needs transcript or screen context before it can suggest.";
const NO_SUGGESTION_MESSAGE = "There is no suggestion to update yet.";

const DEFAULT_MEETING_AUDIO_CONFIG: MeetingAudioConfig = {
  enabled: true,
  hop_size: 1024,
  sensitivity_rms: 0.012,
  peak_threshold: 0.035,
  silence_chunks: 45,
  min_speech_chunks: 7,
  pre_speech_chunks: 12,
  noise_gate_threshold: 0.003,
  max_recording_duration_secs: 180,
};

const MEETING_AUDIO_PROFILE_CONFIGS: Record<
  Exclude<MeetingAudioProfile, "custom">,
  Pick<MeetingAudioConfig, "sensitivity_rms" | "noise_gate_threshold" | "silence_chunks">
> = {
  quiet: {
    sensitivity_rms: 0.015,
    noise_gate_threshold: 0.005,
    silence_chunks: 55,
  },
  balanced: {
    sensitivity_rms: 0.012,
    noise_gate_threshold: 0.003,
    silence_chunks: 45,
  },
  sensitive: {
    sensitivity_rms: 0.008,
    noise_gate_threshold: 0.002,
    silence_chunks: 35,
  },
};

const DEFAULT_MEETING_RESPONSE_CONFIG: MeetingResponseConfig = {
  length: "normal",
  language: "auto",
};

const DEFAULT_MEETING_CODING_MODEL_SETTINGS: MeetingCodingModelSettings = {
  provider: "",
  variables: {},
};

const DEFAULT_INTERVIEW_SESSION_BRIEF: InterviewSessionBrief = {
  targetCompany: "",
  targetCompanyNormalized: undefined,
  companyLocked: true,
  interviewTypes: [],
  focusAreas: "",
  notes: "",
};

const INITIAL_STATE: MeetingAssistantState = {
  status: "idle",
  transcriptTurns: [],
  screenObservations: [],
  interviewSessionBrief: undefined,
  interviewSessionContext: undefined,
  latestSuggestion: null,
  latestReliableSuggestion: null,
  partialSuggestion: "",
  traces: [],
  error: null,
  audioStatus: null,
  settings: {
    screenContextEnabled: true,
    privacyMode: "text-and-screen-to-cloud",
    activeScreenTaskTimeoutMinutes: DEFAULT_ACTIVE_SCREEN_TASK_TIMEOUT_MINUTES,
    useMemory: true,
    debugMode: false,
    microphoneContextEnabled: true,
    response: DEFAULT_MEETING_RESPONSE_CONFIG,
    codingModel: DEFAULT_MEETING_CODING_MODEL_SETTINGS,
    audio: {
      profile: "balanced",
      config: DEFAULT_MEETING_AUDIO_CONFIG,
    },
  },
  sessionRecording: {
    active: false,
    eventCount: 0,
    artifactCount: 0,
  },
  humanEvaluations: [],
  questionEvaluations: [],
  speechCorrections: [],
};

const DEFAULT_MEETING_ASSISTANT_SETTINGS = INITIAL_STATE.settings;

function readMeetingAssistantSettings(): MeetingAssistantSettings {
  const stored = safeLocalStorage.getItem(
    STORAGE_KEYS.MEETING_ASSISTANT_SETTINGS
  );

  if (!stored) return DEFAULT_MEETING_ASSISTANT_SETTINGS;

  try {
    const parsed = JSON.parse(stored) as Partial<MeetingAssistantSettings>;
    const privacyMode = isMeetingPrivacyMode(parsed.privacyMode)
      ? parsed.privacyMode
      : DEFAULT_MEETING_ASSISTANT_SETTINGS.privacyMode;

    return {
      screenContextEnabled: privacyMode === "text-and-screen-to-cloud",
      privacyMode,
      activeScreenTaskTimeoutMinutes:
        normalizeActiveScreenTaskTimeoutMinutes(
          parsed.activeScreenTaskTimeoutMinutes
        ),
      useMemory:
        typeof parsed.useMemory === "boolean"
          ? parsed.useMemory
          : DEFAULT_MEETING_ASSISTANT_SETTINGS.useMemory,
      debugMode:
        typeof parsed.debugMode === "boolean"
          ? parsed.debugMode
          : DEFAULT_MEETING_ASSISTANT_SETTINGS.debugMode,
      microphoneContextEnabled:
        typeof parsed.microphoneContextEnabled === "boolean"
          ? parsed.microphoneContextEnabled
          : DEFAULT_MEETING_ASSISTANT_SETTINGS.microphoneContextEnabled,
      response: normalizeMeetingResponseConfig(parsed.response),
      codingModel: normalizeMeetingCodingModelSettings(parsed.codingModel),
      audio: normalizeMeetingAudioSettings(parsed.audio),
    };
  } catch {
    return DEFAULT_MEETING_ASSISTANT_SETTINGS;
  }
}

function readInterviewSessionBrief(): InterviewSessionBrief | undefined {
  const stored = safeLocalStorage.getItem(STORAGE_KEYS.MEETING_INTERVIEW_BRIEF);
  if (!stored) return undefined;

  try {
    return normalizeInterviewSessionBrief(JSON.parse(stored));
  } catch {
    return undefined;
  }
}

function persistInterviewSessionBrief(
  brief: InterviewSessionBrief | undefined
) {
  if (!brief || isInterviewSessionBriefEmpty(brief)) {
    safeLocalStorage.removeItem(STORAGE_KEYS.MEETING_INTERVIEW_BRIEF);
    return;
  }

  safeLocalStorage.setItem(
    STORAGE_KEYS.MEETING_INTERVIEW_BRIEF,
    JSON.stringify(brief)
  );
}

function normalizeInterviewSessionBrief(
  value: unknown
): InterviewSessionBrief | undefined {
  const parsed = isRecord(value) ? value : {};
  const targetCompany =
    typeof parsed.targetCompany === "string" ? parsed.targetCompany : "";
  const company = normalizeInterviewBriefCompany(targetCompany);
  const interviewTypes = Array.isArray(parsed.interviewTypes)
    ? parsed.interviewTypes
        .map(readInterviewBriefType)
        .filter((type): type is InterviewBriefType => Boolean(type))
    : [];
  const normalizedInterviewTypes =
    normalizeInterviewBriefTypes(interviewTypes);

  const brief: InterviewSessionBrief = {
    ...DEFAULT_INTERVIEW_SESSION_BRIEF,
    targetCompany,
    targetCompanyNormalized: company?.normalized,
    companyLocked:
      typeof parsed.companyLocked === "boolean"
        ? parsed.companyLocked
        : DEFAULT_INTERVIEW_SESSION_BRIEF.companyLocked,
    interviewTypes: normalizedInterviewTypes,
    focusAreas: typeof parsed.focusAreas === "string" ? parsed.focusAreas : "",
    notes: typeof parsed.notes === "string" ? parsed.notes : "",
    updatedAt:
      typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
  };

  return isInterviewSessionBriefEmpty(brief) ? undefined : brief;
}

function normalizeInterviewBriefTypes(
  interviewTypes: InterviewBriefType[]
): InterviewBriefType[] {
  return normalizeTaxonomyInterviewBriefTypes(interviewTypes);
}

function readSingleConcreteInterviewTypeOverride(
  brief: InterviewSessionBrief | undefined
): CanonicalQuestionType | undefined {
  return readTaxonomySingleConcreteInterviewTypeOverride(brief);
}

function normalizeScreenTaskKindForOverrideComparison(
  kind: ScreenTaskKind | undefined
) {
  return normalizeQuestionTypeAlias(kind);
}

function formatQuestionTypeTraceMetadata(
  questionType: ScreenTaskKind | MemoryQuestionType | undefined,
  rawQuestionType?: string
) {
  const normalizedQuestionType = normalizeQuestionTypeAlias(questionType);
  const canonicalQuestionType = normalizeCanonicalQuestionType(
    normalizedQuestionType
  );

  return {
    questionType: normalizedQuestionType,
    rawQuestionType: rawQuestionType ?? questionType,
    canonicalQuestionType,
  };
}

function normalizeScreenQuestionType(
  questionType: ScreenTaskKind | MemoryQuestionType | undefined
): ScreenQuestionType | undefined {
  return normalizeQuestionTypeAlias(questionType);
}

function normalizeParentQuestionType(
  questionType: ScreenTaskKind | MemoryQuestionType | undefined
): ParentQuestionType | undefined {
  const canonical = normalizeCanonicalQuestionType(questionType);
  return canonical && isParentCanonicalQuestionType(canonical)
    ? canonical
    : undefined;
}

function isInterviewTypeOverrideMismatch(
  activeKind: ScreenTaskKind,
  overrideKind: ScreenTaskKind
) {
  return (
    normalizeScreenTaskKindForOverrideComparison(activeKind) !==
    normalizeScreenTaskKindForOverrideComparison(overrideKind)
  );
}

function getManualOverrideAskFrame(kind: ScreenTaskKind): TaskAskFrame {
  if (kind === "project-deep-dive") return "past-project";
  if (kind === "general-system-design" || kind === "system-design") {
    return "hypothetical-design";
  }
  if (kind === "ai-ml-system-design") return "hypothetical-design";
  return "direct-answer";
}

function getManualOverrideTopicDomain(
  kind: ScreenTaskKind,
  existingTopicDomain: TaskTopicDomain | undefined
): TaskTopicDomain | undefined {
  if (kind === "ai-ml-system-design") return "ai-ml-infra";
  if (kind === "general-system-design" || kind === "system-design") {
    return existingTopicDomain && existingTopicDomain !== "unknown"
      ? existingTopicDomain
      : "backend";
  }
  return existingTopicDomain;
}

function formatScreenTaskKindLabel(kind: ScreenTaskKind) {
  if (kind === "ai-ml-system-design") return "AI/ML system design";
  if (kind === "general-system-design" || kind === "system-design") {
    return "system design";
  }
  if (kind === "project-deep-dive") return "project deep dive";
  if (kind === "field-knowledge") return "field knowledge";
  return kind;
}

function buildManualInterviewTypeOverrideContent(
  task: ActiveScreenTask,
  correctedKind: ScreenTaskKind
) {
  const question = task.question || extractScreenTaskQuestion(task.content);
  return [
    question ? `Question: ${question}` : undefined,
    `Manual interview type correction: treat this active task as ${formatScreenTaskKindLabel(
      correctedKind
    )}.`,
    "Regenerate the answer from the corrected type. Treat any prior generated answer as stale.",
    task.language ? `Language: ${task.language}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeMeetingResponseConfig(
  value: unknown
): MeetingResponseConfig {
  const parsed = isRecord(value) ? value : {};
  return {
    length:
      parsed.length === "short" ||
      parsed.length === "normal" ||
      parsed.length === "detailed"
        ? parsed.length
        : DEFAULT_MEETING_RESPONSE_CONFIG.length,
    language:
      parsed.language === "auto" ||
      parsed.language === "english" ||
      parsed.language === "chinese"
        ? parsed.language
        : DEFAULT_MEETING_RESPONSE_CONFIG.language,
  };
}

function normalizeMeetingCodingModelSettings(
  value: unknown
): MeetingCodingModelSettings {
  const parsed = isRecord(value) ? value : {};
  const rawVariables = isRecord(parsed.variables) ? parsed.variables : {};
  const variables = Object.fromEntries(
    Object.entries(rawVariables).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === "string" && typeof entry[1] === "string"
    )
  );

  return {
    provider: typeof parsed.provider === "string" ? parsed.provider : "",
    variables,
  };
}

function normalizeMeetingAudioSettings(value: unknown) {
  const parsed = isRecord(value) ? value : {};
  const profile = normalizeMeetingAudioProfile(parsed.profile);
  return {
    profile,
    config: normalizeMeetingAudioConfig(parsed.config, profile),
  };
}

function normalizeMeetingAudioProfile(value: unknown): MeetingAudioProfile {
  return value === "quiet" ||
    value === "balanced" ||
    value === "sensitive" ||
    value === "custom"
    ? value
    : "balanced";
}

function normalizeMeetingAudioConfig(
  value: unknown,
  profile: MeetingAudioProfile = "balanced"
): MeetingAudioConfig {
  const parsed = isRecord(value) ? value : {};
  const profileDefaults =
    profile === "custom"
      ? DEFAULT_MEETING_AUDIO_CONFIG
      : {
          ...DEFAULT_MEETING_AUDIO_CONFIG,
          ...MEETING_AUDIO_PROFILE_CONFIGS[profile],
        };

  return {
    enabled:
      typeof parsed.enabled === "boolean"
        ? parsed.enabled
        : profileDefaults.enabled,
    hop_size: normalizeNumber(parsed.hop_size, profileDefaults.hop_size),
    sensitivity_rms: normalizeNumber(
      parsed.sensitivity_rms,
      profileDefaults.sensitivity_rms
    ),
    peak_threshold: normalizeNumber(
      parsed.peak_threshold,
      profileDefaults.peak_threshold
    ),
    silence_chunks: normalizeNumber(
      parsed.silence_chunks,
      profileDefaults.silence_chunks
    ),
    min_speech_chunks: normalizeNumber(
      parsed.min_speech_chunks,
      profileDefaults.min_speech_chunks
    ),
    pre_speech_chunks: normalizeNumber(
      parsed.pre_speech_chunks,
      profileDefaults.pre_speech_chunks
    ),
    noise_gate_threshold: normalizeNumber(
      parsed.noise_gate_threshold,
      profileDefaults.noise_gate_threshold
    ),
    max_recording_duration_secs: normalizeNumber(
      parsed.max_recording_duration_secs,
      profileDefaults.max_recording_duration_secs
    ),
  };
}

function normalizeNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeActiveScreenTaskTimeoutMinutes(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_ACTIVE_SCREEN_TASK_TIMEOUT_MINUTES;
  }

  return Math.min(
    MAX_ACTIVE_SCREEN_TASK_TIMEOUT_MINUTES,
    Math.max(MIN_ACTIVE_SCREEN_TASK_TIMEOUT_MINUTES, Math.round(value))
  );
}

function getActiveScreenTaskExpiresAt(
  settings: MeetingAssistantSettings,
  now = Date.now()
) {
  return now + settings.activeScreenTaskTimeoutMinutes * 60_000;
}

function clearActiveScreenTaskState(
  previous: MeetingAssistantState
): MeetingAssistantState {
  return {
    ...previous,
    activeScreenTask: undefined,
    activeInterviewTask: undefined,
    partialSuggestion: "",
    latestSuggestion:
      previous.latestSuggestion?.kind === "screen-task"
        ? null
        : previous.latestSuggestion,
    latestReliableSuggestion: null,
    status:
      previous.status === "thinking"
        ? previous.audioStatus?.active
          ? "listening"
          : "idle"
        : previous.status,
    error: null,
    activeMeetingTask: undefined,
  };
}

function withLatestReliableSuggestion(
  previous: MeetingAssistantState,
  nextSuggestion: AdvisorSuggestion,
  options: { clearPrevious?: boolean } = {}
): Pick<MeetingAssistantState, "latestSuggestion" | "latestReliableSuggestion"> {
  const previousSuggestion = previous.latestSuggestion;
  const latestReliableSuggestion =
    options.clearPrevious
      ? null
      : previousSuggestion &&
          isCacheableReliableSuggestion(previousSuggestion) &&
          previousSuggestion.content.trim() !== nextSuggestion.content.trim()
        ? previousSuggestion
        : previous.latestReliableSuggestion;

  return {
    latestSuggestion: nextSuggestion,
    latestReliableSuggestion,
  };
}

function isCacheableReliableSuggestion(suggestion: AdvisorSuggestion) {
  const content = suggestion.content.trim();
  if (!content || content === "-") return false;
  if (suggestion.kind === "silent" || suggestion.kind === "clarifying-question") {
    return false;
  }

  return (
    suggestion.kind === "screen-task" ||
    suggestion.kind === "answer" ||
    content.length >= 80
  );
}

interface InterviewTaskContinuityResult {
  task?: ActiveInterviewParent;
  startedNewParent: boolean;
  clearedParent: boolean;
}

type AdvisorTurnGateAction =
  | "ignore"
  | "append-only"
  | "state-update"
  | "answer-refresh";

interface AdvisorTurnGateDecision {
  action: AdvisorTurnGateAction;
  reason: string;
  contextPromptEligible: boolean;
}

interface AdvisorTaskSignals {
  questionType: MemoryQuestionType;
  askFrame: MemoryAskFrame;
  topicDomain: MemoryTopicDomain;
  projectAnchor?: string;
  query: string;
  taskRelation: InterviewTaskRelation;
  subtaskIntent: InterviewSubtaskIntent;
  source: string;
  reuseActivePlaybook: boolean;
  openingRoute?: OpeningRouteContext;
}

function preserveCodingResponseActionSections(
  generatedContent: string,
  sourceSuggestion: string | undefined
) {
  const source = sourceSuggestion?.trim();
  if (!source) return generatedContent;

  const sourceAnswer = parseScreenTaskAnswer(source);
  const sourceCode = sourceAnswer.code?.trim();
  if (!sourceCode) return generatedContent;

  const generatedAnswer = parseScreenTaskAnswer(generatedContent);
  if (generatedAnswer.code?.trim()) return generatedContent;

  const compactAnswer = readCompactActionAnswer(generatedContent);
  const clarifyingOptions =
    formatClarifyingOptionsForSection(generatedAnswer.clarifyingOptions) ||
    formatClarifyingOptionsForSection(sourceAnswer.clarifyingOptions);

  return [
    `中文思路: ${
      generatedAnswer.chineseThinking || sourceAnswer.chineseThinking || "-"
    }`,
    `Question: ${generatedAnswer.question || sourceAnswer.question || "-"}`,
    `Answer: ${generatedAnswer.answer || compactAnswer || sourceAnswer.answer || "-"}`,
    `Approach: ${generatedAnswer.approach || sourceAnswer.approach || "-"}`,
    ["Code:", "```", sourceCode, "```"].join("\n"),
    `Complexity: ${generatedAnswer.complexity || sourceAnswer.complexity || "-"}`,
    `Clarifying question: ${
      generatedAnswer.clarifyingQuestion ||
      sourceAnswer.clarifyingQuestion ||
      "-"
    }`,
    `Clarifying options: ${clarifyingOptions || "-"}`,
  ].join("\n\n");
}

function formatClarifyingOptionsForSection(
  options: ReturnType<typeof parseScreenTaskAnswer>["clarifyingOptions"]
) {
  return options?.map((option) => option.label).filter(Boolean).join(" | ");
}

function readCompactActionAnswer(content: string) {
  const chineseThinking =
    readCompactSection(content, "中文思路") ||
    readCompactSection(content, "Meaning");
  const reply = readCompactSection(content, "Reply");
  const question = readCompactSection(content, "Question");
  const parts = [reply, chineseThinking].filter(Boolean);

  if (parts.length > 0) return parts.join("\n\n");
  if (question) return question;

  const trimmed = content.trim();
  return trimmed === "-" ? "" : trimmed;
}

function readCompactSection(content: string, label: string) {
  const labels = ["中文思路", "Meaning", "Reply", "Question"];
  const boundary = labels.join("|");
  const pattern = new RegExp(
    `(?:^|\\n)\\s*${label}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:${boundary})\\s*:|$)`,
    "i"
  );
  const value = pattern.exec(content)?.[1]?.trim() ?? "";
  return value === "-" ? "" : value;
}

function shouldAutoExportTrace(trace: MeetingTrace) {
  if (trace.status === "running") return false;
  if (trace.status === "error") return true;
  return (trace.durationMs ?? 0) >= getTraceAutoExportSlowThresholdMs(trace);
}

function getAutoExportTrigger(
  trace: MeetingTrace
): MeetingTraceExportTrigger {
  return trace.status === "error" ? "auto-error" : "auto-slow";
}

function getTraceAutoExportSlowThresholdMs(trace: Pick<MeetingTrace, "kind">) {
  return TRACE_AUTO_EXPORT_SLOW_THRESHOLDS_MS[trace.kind];
}

function createTraceExportFileName(
  trace: MeetingTrace,
  trigger: MeetingTraceExportTrigger
) {
  const timestamp = new Date(trace.startedAt)
    .toISOString()
    .replace(/[:.]/g, "-");
  return `jarvis-trace-${trace.kind}-${trigger}-${timestamp}-${trace.id}.json`;
}

function isMeetingPrivacyMode(
  value: unknown
): value is MeetingPrivacyMode {
  return (
    value === "memory-only" ||
    value === "text-and-screen-to-cloud"
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
) {
  let timeoutId: number | undefined;

  return new Promise<T>((resolve, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);

    promise.then(resolve, reject).finally(() => {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    });
  });
}

interface RunAdvisorOptions {
  force?: boolean;
  mode?: AdvisorRequestMode;
  responseAction?: MeetingResponseActionMode;
  currentSuggestion?: string;
  clarifyingFeedback?: ClarifyingQuestionFeedback;
  traceId?: string;
}

interface CaptureScreenContextOptions {
  onCaptured?: () => void;
  requestedAt?: number;
}

interface QueuedSpeechSegment {
  base64Audio?: string;
  audioBlob?: Blob;
  audioBase64Chars: number;
  audioBytes?: number;
  audioType?: string;
  sessionId: string;
  sequence: number;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  speaker: TranscriptTurn["speaker"];
  source: TranscriptTurn["source"];
  traceId: string;
  queueStepId: string;
}

interface PendingConfirmation {
  turn: TranscriptTurn;
  segment: QueuedSpeechSegment;
  heldAt: number;
  timeoutId: number;
}

interface PendingInterviewTypeOverride {
  taskId: string;
  traceId: string;
  correctedKind: ScreenTaskKind;
}

interface MeetingModelRouteResolution {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  route: "main" | "coding-override";
  reason: string;
  fallbackReason?: string;
  mainProviderId?: string;
  codingProviderId?: string;
}

function formatMeetingModelRouteForTrace(route: MeetingModelRouteResolution) {
  return {
    modelRoute: route.route,
    modelRouteReason: route.reason,
    modelRouteFallbackReason: route.fallbackReason,
    mainProviderId: route.mainProviderId,
    codingProviderId: route.codingProviderId,
  };
}

function getMeetingModelRequestOptions(
  route: MeetingModelRouteResolution
): MeetingModelRequestOptions | undefined {
  if (route.route !== "coding-override") return undefined;

  return {
    timeoutMs: CODING_MODEL_REQUEST_TIMEOUT_MS,
    maxOutputTokens: CODING_MODEL_MAX_OUTPUT_TOKENS,
  };
}

export function useMeetingAssistant() {
  const {
    screenshotConfiguration,
    selectedSttProvider,
    allSttProviders,
    selectedAIProvider,
    allAiProviders,
    selectedAudioDevices,
  } = useApp();

  const initialInterviewSessionBriefRef = useRef<
    InterviewSessionBrief | null | undefined
  >(undefined);
  if (initialInterviewSessionBriefRef.current === undefined) {
    initialInterviewSessionBriefRef.current =
      readInterviewSessionBrief() ?? null;
  }
  const initialInterviewSessionBrief =
    initialInterviewSessionBriefRef.current ?? undefined;
  const [state, setState] = useState<MeetingAssistantState>(() => ({
    ...INITIAL_STATE,
    settings: readMeetingAssistantSettings(),
    interviewSessionBrief: initialInterviewSessionBrief,
    interviewSessionContext: createInterviewSessionContextFromBrief(
      initialInterviewSessionBrief
    ),
    humanEvaluations: readTraceHumanEvaluations(),
    questionEvaluations: readQuestionHumanEvaluations(),
  }));
  const sessionRecordingManagerRef = useRef<SessionRecordingManager | null>(
    null
  );
  if (sessionRecordingManagerRef.current === null) {
    sessionRecordingManagerRef.current = new SessionRecordingManager(
      (sessionRecording) => {
        setState((previous) => ({
          ...previous,
          sessionRecording,
        }));
      }
    );
  }
  const contextManagerRef = useRef(
    new MeetingContextManager({
      interviewSessionBrief: initialInterviewSessionBrief,
    })
  );
  const advisorEngineRef = useRef(new AdvisorEngine());
  const traceStoreRef = useRef(new MeetingTraceStore());
  const traceMetricsPersistTimerRef = useRef<number | null>(null);
  const traceMetricsPersistenceReadyRef = useRef(false);
  const lastTraceMetricsPayloadRef = useRef<string | null>(null);
  const autoExportProcessedTraceIdsRef = useRef(new Set<string>());
  const sessionRecordedTraceIdsRef = useRef(new Set<string>());
  const debugModeRef = useRef(INITIAL_STATE.settings.debugMode);
  const activeRef = useRef(false);
  const latestScreenHashRef = useRef<string | undefined>(undefined);
  const advisorDebounceTimerRef = useRef<number | null>(null);
  const screenAnalysisAbortRef = useRef<AbortController | null>(null);
  const screenCaptureInFlightRef = useRef(false);
  const audioSessionIdRef = useRef(createMeetingId("audio_session"));
  const audioSegmentSeqRef = useRef(0);
  const systemAudioQueueTailRef = useRef<Promise<void>>(Promise.resolve());
  const microphoneAudioQueueTailRef = useRef<Promise<void>>(Promise.resolve());
  const pendingConfirmationRef = useRef<PendingConfirmation | null>(null);
  const pendingInterviewTypeOverrideRef =
    useRef<PendingInterviewTypeOverride | null>(null);
  const speechCorrectionsRef = useRef<SpeechCorrection[]>([]);
  const microphoneContextEnabledRef = useRef(
    INITIAL_STATE.settings.microphoneContextEnabled
  );
  const speechDetectedHandlerRef = useRef<
    ((base64Audio: string) => void) | undefined
  >(undefined);

  const clearPendingConfirmationForRuntimeReset = useCallback((reason: string) => {
    const pending = pendingConfirmationRef.current;
    if (!pending) return;

    window.clearTimeout(pending.timeoutId);
    pendingConfirmationRef.current = null;

    const resetStepId = traceStoreRef.current.startStep(
      pending.segment.traceId,
      "Pending confirmation cleared by runtime reset",
      {
        reason,
        turnId: pending.turn.id,
        heldMs: Date.now() - pending.heldAt,
        audioSegmentSeq: pending.segment.sequence,
        audioSessionId: pending.segment.sessionId,
      }
    );
    traceStoreRef.current.finishStep(
      pending.segment.traceId,
      resetStepId,
      "cancelled"
    );
    traceStoreRef.current.finishTrace(
      pending.segment.traceId,
      "cancelled",
      `Pending confirmation cleared by runtime reset: ${reason}`
    );
  }, []);

  const resetMeetingRuntimeForNewSession = useCallback(
    (reason: string) => {
      const previousContext = contextManagerRef.current.getState();
      const previousTraceCount = traceStoreRef.current
        .getTraces()
        .filter((trace) => trace.status !== "running").length;
      const previousSpeechCorrectionCount = speechCorrectionsRef.current.length;
      const hadExistingRuntimeState = Boolean(
        previousContext.transcriptTurns.length ||
          previousContext.screenObservations.length ||
          previousContext.activeScreenTask ||
          previousContext.activeInterviewTask ||
          previousContext.activeMeetingTask ||
          previousTraceCount ||
          previousSpeechCorrectionCount ||
          latestScreenHashRef.current ||
          pendingConfirmationRef.current ||
          pendingInterviewTypeOverrideRef.current
      );

      if (advisorDebounceTimerRef.current !== null) {
        window.clearTimeout(advisorDebounceTimerRef.current);
        advisorDebounceTimerRef.current = null;
      }
      advisorEngineRef.current.cancelCurrentRequest();
      screenAnalysisAbortRef.current?.abort();
      screenAnalysisAbortRef.current = null;
      screenCaptureInFlightRef.current = false;
      pendingInterviewTypeOverrideRef.current = null;
      speechCorrectionsRef.current = [];
      latestScreenHashRef.current = undefined;

      audioSessionIdRef.current = createMeetingId(
        activeRef.current ? "audio_session" : "audio_session_inactive"
      );
      audioSegmentSeqRef.current = 0;
      systemAudioQueueTailRef.current = Promise.resolve();
      microphoneAudioQueueTailRef.current = Promise.resolve();
      clearPendingConfirmationForRuntimeReset(reason);

      contextManagerRef.current.reset({
        interviewSessionBrief: previousContext.interviewSessionBrief,
        userProfileContext: previousContext.userProfileContext,
        glossary: previousContext.glossary,
      });
      const contextState = contextManagerRef.current.getState();
      const nextStatus: MeetingAssistantStatus =
        activeRef.current ? "listening" : "idle";

      setState((previous) => ({
        ...previous,
        status:
          previous.status === "paused" && !activeRef.current
            ? "paused"
            : nextStatus,
        transcriptTurns: contextState.transcriptTurns,
        screenObservations: contextState.screenObservations,
        interviewSessionBrief: contextState.interviewSessionBrief,
        interviewSessionContext: contextState.interviewSessionContext,
        activeScreenTask: undefined,
        activeInterviewTask: undefined,
        activeMeetingTask: undefined,
        latestSuggestion: null,
        latestReliableSuggestion: null,
        partialSuggestion: "",
        lastMemoryContext: undefined,
        error: null,
        speechCorrections: [],
      }));

      return {
        reason,
        hadExistingRuntimeState,
        previousTranscriptTurns: previousContext.transcriptTurns.length,
        previousScreenObservations: previousContext.screenObservations.length,
        previousCompletedTraces: previousTraceCount,
        previousSpeechCorrections: previousSpeechCorrectionCount,
        hadActiveMeetingTask: Boolean(previousContext.activeMeetingTask),
        hadActiveScreenTask: Boolean(previousContext.activeScreenTask),
        hadActiveInterviewTask: Boolean(previousContext.activeInterviewTask),
        cleared: [
          "transcriptTurns",
          "screenObservations",
          "activeScreenTask",
          "activeInterviewTask",
          "activeMeetingTask",
          "latestSuggestion",
          "latestReliableSuggestion",
          "partialSuggestion",
          "lastMemoryContext",
          "speechCorrections",
          "pendingConfirmation",
          "pendingInterviewTypeOverride",
          "advisorDebounce",
          "screenAnalysis",
          "latestScreenHash",
          "audioQueues",
        ],
        currentSessionOnly: true,
        backfill: false,
      };
    },
    [clearPendingConfirmationForRuntimeReset]
  );

  const sttProvider = useMemo(
    () =>
      allSttProviders.find(
        (candidate) => candidate.id === selectedSttProvider.provider
      ),
    [allSttProviders, selectedSttProvider.provider]
  );

  const aiProvider = useMemo(
    () =>
      allAiProviders.find(
        (candidate) => candidate.id === selectedAIProvider.provider
      ),
    [allAiProviders, selectedAIProvider.provider]
  );

  const codingAiProvider = useMemo(
    () =>
      allAiProviders.find(
        (candidate) => candidate.id === state.settings.codingModel.provider
      ),
    [allAiProviders, state.settings.codingModel.provider]
  );

  const resolveMeetingModelRoute = useCallback(
    ({
      useCodingModel,
      requiresVision = false,
      reason,
    }: {
      useCodingModel: boolean;
      requiresVision?: boolean;
      reason: string;
    }): MeetingModelRouteResolution => {
      const mainRoute: MeetingModelRouteResolution = {
        provider: aiProvider,
        selectedProvider: selectedAIProvider,
        route: "main",
        reason,
        mainProviderId: aiProvider?.id,
        codingProviderId: state.settings.codingModel.provider || undefined,
      };

      if (!useCodingModel) return mainRoute;

      if (!state.settings.codingModel.provider) {
        return {
          ...mainRoute,
          fallbackReason: "coding-provider-not-configured",
        };
      }

      if (!codingAiProvider) {
        return {
          ...mainRoute,
          fallbackReason: "coding-provider-not-found",
        };
      }

      if (requiresVision && !codingAiProvider.curl.includes("{{IMAGE}}")) {
        return {
          ...mainRoute,
          fallbackReason: "coding-provider-no-vision",
          codingProviderId: codingAiProvider.id,
        };
      }

      return {
        provider: codingAiProvider,
        selectedProvider: state.settings.codingModel,
        route: "coding-override",
        reason,
        mainProviderId: aiProvider?.id,
        codingProviderId: codingAiProvider.id,
      };
    },
    [
      aiProvider,
      codingAiProvider,
      selectedAIProvider,
      state.settings.codingModel,
    ]
  );

  const setupWarnings = useMemo<MeetingSetupWarning[]>(() => {
    const warnings: MeetingSetupWarning[] = [];

    if (!sttProvider) {
      warnings.push({
        code: "stt-provider-missing",
        severity: "blocking",
        message: MISSING_STT_MESSAGE,
      });
    }

    if (state.settings.privacyMode === "memory-only") {
      warnings.push({
        code: "local-only-unavailable",
        severity: "blocking",
        message: LOCAL_ONLY_UNAVAILABLE_MESSAGE,
      });
    }

    if (!aiProvider) {
      warnings.push({
        code: "ai-provider-missing",
        severity: "warning",
        message: MISSING_AI_MESSAGE,
      });
    } else if (!aiProvider.curl.includes("{{IMAGE}}")) {
      warnings.push({
        code: "vision-provider-missing",
        severity: "warning",
        message: MISSING_VISION_MESSAGE,
      });
    }

    return warnings;
  }, [aiProvider, state.settings.privacyMode, sttProvider]);

  const startSessionRecording = useCallback(async () => {
    try {
      const resetBoundary = resetMeetingRuntimeForNewSession(
        "session-recording-started"
      );
      const contextState = contextManagerRef.current.getState();
      sessionRecordedTraceIdsRef.current.clear();
      const sessionRecording = await sessionRecordingManagerRef.current?.start({
        settings: state.settings,
        interviewSessionBrief: contextState.interviewSessionBrief,
        interviewSessionContext: contextState.interviewSessionContext,
        providerSummary: buildSessionRecordingProviderSummary({
          mainProvider: aiProvider,
          codingProvider: codingAiProvider,
          sttProvider,
          mainProviderId: selectedAIProvider.provider,
          codingProviderId: state.settings.codingModel.provider,
          sttProviderId: selectedSttProvider.provider,
        }),
      });
      sessionRecordingManagerRef.current?.recordRuntimeBoundary(
        "runtime-reset",
        {
          ...resetBoundary,
          transcriptTurns: contextState.transcriptTurns.length,
          screenObservations: contextState.screenObservations.length,
          hasActiveMeetingTask: Boolean(contextState.activeMeetingTask),
          ...getActiveMeetingTaskTraceMetadata(contextState.activeMeetingTask),
          hasActiveScreenTask: Boolean(contextState.activeScreenTask),
          hasActiveInterviewTask: Boolean(contextState.activeInterviewTask),
          completedTraces: 0,
        }
      );

      if (sessionRecording) {
        setState((previous) => ({
          ...previous,
          sessionRecording,
          error: null,
        }));
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to start session recording.";
      sessionRecordingManagerRef.current?.recordError(error);
      setState((previous) => ({
        ...previous,
        error: message,
        sessionRecording:
          sessionRecordingManagerRef.current?.getState() ??
          previous.sessionRecording,
      }));
    }
  }, [
    aiProvider,
    codingAiProvider,
    selectedAIProvider.provider,
    selectedSttProvider.provider,
    state.settings,
    sttProvider,
    resetMeetingRuntimeForNewSession,
  ]);

  const stopSessionRecording = useCallback(async (reason = "manual") => {
    try {
      const sessionRecording =
        await sessionRecordingManagerRef.current?.stop(reason);
      if (sessionRecording) {
        setState((previous) => ({
          ...previous,
          sessionRecording,
        }));
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to stop session recording.";
      sessionRecordingManagerRef.current?.recordError(error);
      setState((previous) => ({
        ...previous,
        error: message,
        sessionRecording:
          sessionRecordingManagerRef.current?.getState() ??
          previous.sessionRecording,
      }));
    }
  }, []);

  const setSessionRecordingEnabled = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        void startSessionRecording();
      } else {
        void stopSessionRecording("manual");
      }
    },
    [startSessionRecording, stopSessionRecording]
  );

  const clearAdvisorDebounce = useCallback(() => {
    if (advisorDebounceTimerRef.current !== null) {
      window.clearTimeout(advisorDebounceTimerRef.current);
      advisorDebounceTimerRef.current = null;
    }
  }, []);

  const clearPendingConfirmation = useCallback((reason: string) => {
    const pending = pendingConfirmationRef.current;
    if (!pending) return;

    window.clearTimeout(pending.timeoutId);
    pendingConfirmationRef.current = null;

    const expiredStepId = traceStoreRef.current.startStep(
      pending.segment.traceId,
      "Pending confirmation expired",
      {
        reason,
        turnId: pending.turn.id,
        heldMs: Date.now() - pending.heldAt,
        audioSegmentSeq: pending.segment.sequence,
        audioSessionId: pending.segment.sessionId,
      }
    );
    traceStoreRef.current.finishStep(
      pending.segment.traceId,
      expiredStepId,
      "success"
    );
    traceStoreRef.current.finishTrace(pending.segment.traceId, "success");
  }, []);

  const startAudioProcessingSession = useCallback(() => {
    const sessionId = createMeetingId("audio_session");
    audioSessionIdRef.current = sessionId;
    audioSegmentSeqRef.current = 0;
    systemAudioQueueTailRef.current = Promise.resolve();
    microphoneAudioQueueTailRef.current = Promise.resolve();
    clearPendingConfirmation("session-restarted");
    return sessionId;
  }, [clearPendingConfirmation]);

  const invalidateAudioProcessingSession = useCallback(() => {
    audioSessionIdRef.current = createMeetingId("audio_session_inactive");
    audioSegmentSeqRef.current = 0;
    systemAudioQueueTailRef.current = Promise.resolve();
    microphoneAudioQueueTailRef.current = Promise.resolve();
    clearPendingConfirmation("session-invalidated");
  }, [clearPendingConfirmation]);

  const isCurrentAudioSegment = useCallback((segment: QueuedSpeechSegment) => {
    return activeRef.current && audioSessionIdRef.current === segment.sessionId;
  }, []);

  const clearTraces = useCallback(() => {
    traceStoreRef.current.clear();
  }, []);

  const buildQuestionEvaluationIdentity = useCallback(
    (
      trace: MeetingTrace,
      evaluationPatch: Partial<TraceHumanEvaluation>,
      sessionId?: string
    ): QuestionEvaluationIdentity => {
      const contextState = contextManagerRef.current.getState();
      const activeMeetingTask = contextState.activeMeetingTask;
      const canonicalQuestionType = normalizeCanonicalQuestionType(
        normalizeQuestionTypeAlias(
          evaluationPatch.questionType ??
            readStringFromTraceMetadata(
              trace.metadata,
              "activeMeetingParentQuestionType"
            ) ??
            readStringFromTraceMetadata(trace.metadata, "canonicalQuestionType") ??
            readStringFromTraceMetadata(trace.metadata, "questionType") ??
            activeMeetingTask?.parent.questionType
        )
      );
      const questionType = canonicalQuestionType
        ? toHumanEvalQuestionType(canonicalQuestionType)
        : undefined;

      return {
        sessionId,
        traceId: trace.id,
        traceKind: trace.kind,
        taskId:
          evaluationPatch.taskId ??
          readStringFromTraceMetadata(trace.metadata, "activeMeetingTaskId") ??
          readStringFromTraceMetadata(trace.metadata, "activeInterviewParentId") ??
          readStringFromTraceMetadata(trace.metadata, "activeScreenTaskId") ??
          activeMeetingTask?.id,
        parentTaskId:
          evaluationPatch.parentTaskId ??
          readStringFromTraceMetadata(trace.metadata, "activeMeetingParentId") ??
          readStringFromTraceMetadata(trace.metadata, "activeInterviewParentId") ??
          activeMeetingTask?.parent.id,
        childTaskId:
          evaluationPatch.childTaskId ??
          readStringFromTraceMetadata(trace.metadata, "activeMeetingChildId") ??
          readStringFromTraceMetadata(trace.metadata, "activeInterviewChildId") ??
          activeMeetingTask?.child?.id,
        taskSource:
          evaluationPatch.taskSource ??
          readTaskSourceFromTraceMetadata(trace.metadata) ??
          activeMeetingTask?.source,
        questionType,
        company:
          readStringFromTraceMetadata(trace.metadata, "targetCompany") ??
          readStringFromTraceMetadata(trace.metadata, "screenTargetCompany") ??
          contextState.interviewSessionContext?.targetCompany?.value ??
          contextState.interviewSessionBrief?.targetCompany,
        relation:
          readStringFromTraceMetadata(trace.metadata, "taskRelation") ??
          readStringFromTraceMetadata(trace.metadata, "relationToActiveTask") ??
          readStringFromTraceMetadata(trace.metadata, "turnGateReason"),
        playbookId:
          readStringFromTraceMetadata(trace.metadata, "playbookId") ??
          activeMeetingTask?.parent.playbook?.id,
        playbookPhase:
          readStringFromTraceMetadata(trace.metadata, "playbookPhase") ??
          readStringFromTraceMetadata(trace.metadata, "activeMeetingParentPhase") ??
          activeMeetingTask?.parent.playbookPhase,
      };
    },
    []
  );

  const updateTraceHumanEvaluation = useCallback(
    (traceId: string, patch: Partial<TraceHumanEvaluation>) => {
      const trace = traceStoreRef.current
        .getTraces()
        .find((candidate) => candidate.id === traceId);
      if (!trace) return;
      const activeMeetingTask =
        contextManagerRef.current.getState().activeMeetingTask;
      const evaluationPatch: Partial<TraceHumanEvaluation> = {
        taskId:
          readStringFromTraceMetadata(trace.metadata, "activeMeetingTaskId") ??
          readStringFromTraceMetadata(trace.metadata, "activeInterviewParentId") ??
          readStringFromTraceMetadata(trace.metadata, "activeScreenTaskId") ??
          activeMeetingTask?.id,
        parentTaskId:
          readStringFromTraceMetadata(trace.metadata, "activeMeetingParentId") ??
          readStringFromTraceMetadata(trace.metadata, "activeInterviewParentId") ??
          activeMeetingTask?.parent.id,
        childTaskId:
          readStringFromTraceMetadata(trace.metadata, "activeMeetingChildId") ??
          readStringFromTraceMetadata(trace.metadata, "activeInterviewChildId") ??
          activeMeetingTask?.child?.id,
        taskSource:
          readTaskSourceFromTraceMetadata(trace.metadata) ??
          activeMeetingTask?.source,
        questionType:
          normalizeQuestionTypeAlias(
            readStringFromTraceMetadata(
              trace.metadata,
              "activeMeetingParentQuestionType"
            ) ??
              readStringFromTraceMetadata(
                trace.metadata,
                "canonicalQuestionType"
              )
          ) ?? activeMeetingTask?.parent.questionType,
        ...patch,
      };

      setState((previous) => {
        const humanEvaluations = upsertTraceHumanEvaluation(
          previous.humanEvaluations,
          trace.id,
          trace.kind,
          evaluationPatch
        );
        const traceEvaluation = humanEvaluations.find(
          (evaluation) => evaluation.traceId === trace.id
        );
        const questionEvaluations = traceEvaluation
          ? upsertQuestionHumanEvaluation(
              previous.questionEvaluations,
              buildQuestionEvaluationIdentity(
                trace,
                traceEvaluation,
                previous.sessionRecording.sessionId
              ),
              buildQuestionEvaluationPatchFromTrace(traceEvaluation)
            )
          : previous.questionEvaluations;
        persistTraceHumanEvaluations(humanEvaluations);
        persistQuestionHumanEvaluations(questionEvaluations);
        sessionRecordingManagerRef.current?.recordHumanEvaluations(
          humanEvaluations
        );
        sessionRecordingManagerRef.current?.recordQuestionHumanEvaluations(
          questionEvaluations
        );
        return {
          ...previous,
          humanEvaluations,
          questionEvaluations,
        };
      });
    },
    [buildQuestionEvaluationIdentity]
  );

  const updateQuestionHumanEvaluation = useCallback(
    (traceId: string, patch: Partial<QuestionHumanEvaluation>) => {
      const trace = traceStoreRef.current
        .getTraces()
        .find((candidate) => candidate.id === traceId);
      if (!trace) return;

      setState((previous) => {
        const traceEvaluation = previous.humanEvaluations.find(
          (evaluation) => evaluation.traceId === trace.id
        );
        const identity = buildQuestionEvaluationIdentity(
          trace,
          traceEvaluation ?? {},
          previous.sessionRecording.sessionId
        );
        const questionEvaluations = upsertQuestionHumanEvaluation(
          previous.questionEvaluations,
          identity,
          patch
        );
        persistQuestionHumanEvaluations(questionEvaluations);
        sessionRecordingManagerRef.current?.recordQuestionHumanEvaluations(
          questionEvaluations
        );
        return {
          ...previous,
          questionEvaluations,
        };
      });
    },
    [buildQuestionEvaluationIdentity]
  );

  const incrementAppliedSpeechCorrections = useCallback(
    (rules: SpeechCorrectionRule[]) => {
      if (!rules.length) return;

      setState((previous) => {
        const speechCorrections = applySpeechCorrectionRuleCounts(
          previous.speechCorrections,
          rules
        );
        speechCorrectionsRef.current = speechCorrections;
        return {
          ...previous,
          speechCorrections,
        };
      });
    },
    []
  );

  const scheduleTraceMetricsPersistence = useCallback(() => {
    if (!traceMetricsPersistenceReadyRef.current) return;

    if (traceMetricsPersistTimerRef.current !== null) {
      window.clearTimeout(traceMetricsPersistTimerRef.current);
    }

    traceMetricsPersistTimerRef.current = window.setTimeout(() => {
      traceMetricsPersistTimerRef.current = null;
      const payload = serializeMeetingTraceMetrics(
        traceStoreRef.current.getPersistableTraces()
      );

      if (payload === lastTraceMetricsPayloadRef.current) return;
      lastTraceMetricsPayloadRef.current = payload;

      void invoke("write_meeting_trace_metrics", { payload }).catch((error) => {
        console.warn("Failed to persist meeting trace metrics", error);
      });
      sessionRecordingManagerRef.current?.recordTraceMetrics(payload);
    }, TRACE_METRICS_PERSIST_DEBOUNCE_MS);
  }, []);

  const exportTraceObject = useCallback(
    async (
      trace: MeetingTrace,
      trigger: MeetingTraceExportTrigger = "manual"
    ) => {
      const payload = serializeMeetingTraceExport(trace, {
        trigger,
        slowThresholdMs: getTraceAutoExportSlowThresholdMs(trace),
      });
      const fileName = createTraceExportFileName(trace, trigger);
      const path = await invoke<string>("export_meeting_trace", {
        fileName,
        payload,
      });
      const record: MeetingTraceExportRecord = {
        traceId: trace.id,
        path,
        trigger,
        exportedAt: Date.now(),
      };
      sessionRecordingManagerRef.current?.recordTrace(trace, trigger);

      setState((previous) => ({
        ...previous,
        lastTraceExport: record,
      }));

      return record;
    },
    []
  );

  const recordCompletedTracesForSession = useCallback((traces: MeetingTrace[]) => {
    for (const trace of traces) {
      if (trace.status === "running") continue;
      if (!sessionRecordingManagerRef.current?.canRecordTrace(trace)) continue;
      if (sessionRecordedTraceIdsRef.current.has(trace.id)) continue;
      sessionRecordedTraceIdsRef.current.add(trace.id);
      sessionRecordingManagerRef.current?.recordTrace(
        trace,
        getAutoExportTrigger(trace)
      );
    }
  }, []);

  const maybeAutoExportTraces = useCallback(
    (traces: MeetingTrace[]) => {
      for (const trace of traces) {
        if (trace.status === "running") continue;
        if (autoExportProcessedTraceIdsRef.current.has(trace.id)) continue;

        autoExportProcessedTraceIdsRef.current.add(trace.id);

        if (
          !traceMetricsPersistenceReadyRef.current ||
          !debugModeRef.current ||
          !shouldAutoExportTrace(trace)
        ) {
          continue;
        }

        void exportTraceObject(trace, getAutoExportTrigger(trace)).catch(
          (error) => {
            console.warn("Failed to auto-export meeting trace", error);
          }
        );
      }
    },
    [exportTraceObject]
  );

  const exportTrace = useCallback(
    async (traceId?: string) => {
      const traces = traceStoreRef.current.getTraces();
      const trace = traceId
        ? traces.find((candidate) => candidate.id === traceId)
        : traces.find((candidate) => candidate.status !== "running") ??
          traces[0];

      if (!trace) {
        setState((previous) => ({
          ...previous,
          error: "There is no trace to export yet.",
        }));
        return;
      }

      try {
        await exportTraceObject(trace, "manual");
      } catch (error) {
        setState((previous) => ({
          ...previous,
          error:
            error instanceof Error
              ? error.message
              : "Failed to export meeting trace.",
        }));
      }
    },
    [exportTraceObject]
  );

  const updateSettings = useCallback(
    (resolveSettings: (previous: MeetingAssistantSettings) => MeetingAssistantSettings) => {
      setState((previous) => {
        const settings = resolveSettings(previous.settings);
        safeLocalStorage.setItem(
          STORAGE_KEYS.MEETING_ASSISTANT_SETTINGS,
          JSON.stringify(settings)
        );

        return {
          ...previous,
          settings,
        };
      });
    },
    []
  );

  const setInterviewSessionBrief = useCallback(
    (brief: InterviewSessionBrief | undefined) => {
      const normalizedBrief = normalizeInterviewSessionBrief(brief);
      const previousContextState = contextManagerRef.current.getState();
      const previousOverrideKind = readSingleConcreteInterviewTypeOverride(
        previousContextState.interviewSessionBrief
      );
      persistInterviewSessionBrief(normalizedBrief);
      contextManagerRef.current.setInterviewSessionBrief(normalizedBrief);
      let contextState = contextManagerRef.current.getState();
      const correctedKind =
        readSingleConcreteInterviewTypeOverride(normalizedBrief);
      const interviewTypeOverrideChanged =
        normalizeScreenTaskKindForOverrideComparison(previousOverrideKind) !==
        normalizeScreenTaskKindForOverrideComparison(correctedKind);
      const activeScreenTask = contextState.activeScreenTask;

      if (
        activeScreenTask &&
        correctedKind &&
        interviewTypeOverrideChanged &&
        isInterviewTypeOverrideMismatch(activeScreenTask.kind, correctedKind)
      ) {
        const now = Date.now();
        const correctedScreenKind: ScreenQuestionType = correctedKind;
        const askFrame = getManualOverrideAskFrame(correctedKind);
        const topicDomain = getManualOverrideTopicDomain(
          correctedKind,
          activeScreenTask.classifier?.topicDomain
        );
        const correctedContent = buildManualInterviewTypeOverrideContent(
          activeScreenTask,
          correctedKind
        );
        const correctedQuery = [
          activeScreenTask.question,
          correctedContent,
          contextState.transcriptTurns
            .slice(-4)
            .map((turn) => turn.text)
            .join("\n"),
        ]
          .filter(Boolean)
          .join("\n");
        const correctedPlaybook = selectInterviewPlaybook({
          query: correctedQuery,
          questionType: correctedKind,
          askFrame,
          topicDomain,
          projectAnchor: activeScreenTask.classifier?.projectAnchor,
          classifierConfidence: 1,
          interviewSessionBrief: normalizedBrief,
          interviewSessionContext: contextState.interviewSessionContext,
        });
        const correctedTask: ActiveScreenTask = {
          ...activeScreenTask,
          updatedAt: now,
          expiresAt: getActiveScreenTaskExpiresAt(state.settings, now),
          question:
            activeScreenTask.question ||
            extractScreenTaskQuestion(activeScreenTask.content),
          kind: correctedScreenKind,
          classifier: {
            ...activeScreenTask.classifier,
            questionType: correctedScreenKind,
            askFrame,
            topicDomain,
            confidence: 1,
            overrideSource: "interview-type-selector",
            overrideAt: now,
          },
          playbook: correctedPlaybook
            ? {
                ...correctedPlaybook,
                confidence: 1,
                reason: `${correctedPlaybook.reason}; manual interview type override`,
              }
            : undefined,
          content: correctedContent,
        };
        const trace = traceStoreRef.current.startTrace("screen", {
          source: "interview-type-override",
          activeScreenTaskId: activeScreenTask.id,
          previousQuestionType: activeScreenTask.kind,
          correctedQuestionType: correctedKind,
          previousCanonicalQuestionType: normalizeCanonicalQuestionType(
            activeScreenTask.kind
          ),
          correctedCanonicalQuestionType:
            normalizeCanonicalQuestionType(correctedKind),
          ...formatInterviewPlaybookForTrace(correctedTask.playbook),
        });
        const overrideStepId = traceStoreRef.current.startStep(
          trace.id,
          "Interview type override applied",
          {
            activeScreenTaskId: activeScreenTask.id,
            previousQuestionType: activeScreenTask.kind,
            correctedQuestionType: correctedKind,
            previousCanonicalQuestionType: normalizeCanonicalQuestionType(
              activeScreenTask.kind
            ),
            correctedCanonicalQuestionType:
              normalizeCanonicalQuestionType(correctedKind),
            interviewTypes: normalizedBrief?.interviewTypes,
          }
        );

        const correctedParent = buildInterviewParentFromScreenTask(correctedTask);
        contextManagerRef.current.setActiveMeetingTaskState({
          activeScreenTask: correctedTask,
          activeInterviewTask: correctedParent ?? null,
        });
        sessionRecordingManagerRef.current?.recordTaskSnapshot(
          correctedTask,
          trace.id
        );
        const correctedContextState = contextManagerRef.current.getState();
        traceStoreRef.current.updateMetadata(trace.id, {
          ...getActiveMeetingTaskTraceMetadata(
            correctedContextState.activeMeetingTask
          ),
        });
        if (correctedContextState.activeMeetingTask) {
          sessionRecordingManagerRef.current?.recordActiveMeetingTaskSnapshot(
            correctedContextState.activeMeetingTask,
            trace.id
          );
        }
        contextManagerRef.current.updateScreenObservation(
          activeScreenTask.observationId,
          {
            visualSummary: correctedContent,
            analysisPromptSource: "meeting-default",
          }
        );
        traceStoreRef.current.finishStep(
          trace.id,
          overrideStepId,
          "success"
        );
        pendingInterviewTypeOverrideRef.current = {
          taskId: correctedTask.id,
          traceId: trace.id,
          correctedKind: correctedScreenKind,
        };
        contextState = contextManagerRef.current.getState();
      }

      setState((previous) => ({
        ...previous,
        interviewSessionBrief: contextState.interviewSessionBrief,
        interviewSessionContext: contextState.interviewSessionContext,
        screenObservations: contextState.screenObservations,
        activeScreenTask: contextState.activeScreenTask,
        activeInterviewTask: contextState.activeInterviewTask,
        activeMeetingTask: contextState.activeMeetingTask,
      }));
    },
    [state.settings]
  );

  const clearInterviewSessionBrief = useCallback(() => {
    persistInterviewSessionBrief(undefined);
    contextManagerRef.current.setInterviewSessionBrief(undefined);
    const contextState = contextManagerRef.current.getState();

    setState((previous) => ({
      ...previous,
      interviewSessionBrief: undefined,
      interviewSessionContext: contextState.interviewSessionContext,
    }));
  }, []);

  const setScreenContextEnabled = useCallback(
    (screenContextEnabled: boolean) => {
      updateSettings((previous) => ({
        ...previous,
        screenContextEnabled,
        privacyMode: screenContextEnabled
          ? "text-and-screen-to-cloud"
          : "memory-only",
      }));
    },
    [updateSettings]
  );

  const setPrivacyMode = useCallback(
    (privacyMode: MeetingPrivacyMode) => {
      updateSettings((previous) => ({
        ...previous,
        privacyMode,
        screenContextEnabled: privacyMode === "text-and-screen-to-cloud",
      }));
    },
    [updateSettings]
  );

  const setActiveScreenTaskTimeoutMinutes = useCallback(
    (activeScreenTaskTimeoutMinutes: number) => {
      const normalizedTimeoutMinutes =
        normalizeActiveScreenTaskTimeoutMinutes(
          activeScreenTaskTimeoutMinutes
        );

      updateSettings((previous) => ({
        ...previous,
        activeScreenTaskTimeoutMinutes: normalizedTimeoutMinutes,
      }));

      const activeScreenTask =
        contextManagerRef.current.getState().activeScreenTask;

      if (activeScreenTask) {
        const now = Date.now();
        const updatedScreenTask = {
          ...activeScreenTask,
          updatedAt: now,
          expiresAt: now + normalizedTimeoutMinutes * 60_000,
        };
        const activeInterviewTask =
          contextManagerRef.current.getState().activeInterviewTask;
        const updatedInterviewTask =
          activeInterviewTask?.source === "screen"
            ? {
                ...activeInterviewTask,
                updatedAt: now,
                expiresAt: now + normalizedTimeoutMinutes * 60_000,
              }
            : activeInterviewTask;
        contextManagerRef.current.setActiveMeetingTaskState({
          activeScreenTask: updatedScreenTask,
          activeInterviewTask: updatedInterviewTask,
        });
        const contextState = contextManagerRef.current.getState();
        setState((previous) => ({
          ...previous,
          activeScreenTask: contextState.activeScreenTask,
          activeInterviewTask: contextState.activeInterviewTask,
          activeMeetingTask: contextState.activeMeetingTask,
        }));
      }
    },
    [updateSettings]
  );

  const setDebugMode = useCallback(
    (debugMode: boolean) => {
      traceStoreRef.current.setDebugEnabled(debugMode);
      updateSettings((previous) => ({
        ...previous,
        debugMode,
      }));
    },
    [updateSettings]
  );

  const setMicrophoneContextEnabled = useCallback(
    (microphoneContextEnabled: boolean) => {
      microphoneContextEnabledRef.current = microphoneContextEnabled;
      updateSettings((previous) => ({
        ...previous,
        microphoneContextEnabled,
      }));
    },
    [updateSettings]
  );

  const toggleMicrophoneContext = useCallback(() => {
    setMicrophoneContextEnabled(!microphoneContextEnabledRef.current);
  }, [setMicrophoneContextEnabled]);

  const setUseMemory = useCallback(
    (useMemory: boolean) => {
      updateSettings((previous) => ({
        ...previous,
        useMemory,
      }));
    },
    [updateSettings]
  );

  const setResponseConfig = useCallback(
    (response: MeetingResponseConfig) => {
      updateSettings((previous) => ({
        ...previous,
        response,
      }));
    },
    [updateSettings]
  );

  const setCodingModelConfig = useCallback(
    (codingModel: MeetingCodingModelSettings) => {
      updateSettings((previous) => ({
        ...previous,
        codingModel: normalizeMeetingCodingModelSettings(codingModel),
      }));
    },
    [updateSettings]
  );

  const setMeetingAudioProfile = useCallback(
    (profile: MeetingAudioProfile) => {
      const profileConfig =
        profile === "custom"
          ? DEFAULT_MEETING_AUDIO_CONFIG
          : {
              ...DEFAULT_MEETING_AUDIO_CONFIG,
              ...MEETING_AUDIO_PROFILE_CONFIGS[profile],
            };

      updateSettings((previous) => ({
        ...previous,
        audio: {
          profile,
          config: profileConfig,
        },
      }));
    },
    [updateSettings]
  );

  const setMeetingAudioConfig = useCallback(
    (config: MeetingAudioConfig) => {
      updateSettings((previous) => ({
        ...previous,
        audio: {
          profile: "custom",
          config: normalizeMeetingAudioConfig(config, "custom"),
        },
      }));
    },
    [updateSettings]
  );

  const loadMemoryForPrompt = useCallback(
    async ({
      traceId,
      query,
      source,
      useCase,
      questionType,
      askFrame,
      topicDomain,
      projectAnchor,
      memoryPolicy,
      taskId,
    }: {
      traceId?: string;
      taskId?: string;
      query: string;
      source: "advisor" | "screen";
      useCase?: MemoryUseCase;
      questionType?: MemoryQuestionType;
      askFrame?: MemoryAskFrame;
      topicDomain?: MemoryTopicDomain;
      projectAnchor?: string;
      memoryPolicy?: MemoryRetrievalPolicy;
    }): Promise<MemoryRetrievalResult | undefined> => {
      const resolvedQuestionType =
        questionType ?? inferMemoryQuestionTypeFromQuery(query);
      const resolvedUseCase = normalizeMemoryUseCaseForQuestionType(
        useCase ?? inferMemoryUseCaseFromQuery(query),
        resolvedQuestionType
      );
      const interviewTypes =
        contextManagerRef.current.getState().interviewSessionBrief
          ?.interviewTypes;
      const effectiveMemoryPolicy = applyStrictProjectAnchorPolicy({
        memoryPolicy,
        questionType: resolvedQuestionType,
        projectAnchor,
        query,
      });

      let memoryStepId: string | undefined;
      if (!state.settings.useMemory) {
        if (traceId) {
          memoryStepId = traceStoreRef.current.startStep(
            traceId,
            "Memory retrieval",
            {
              source,
              skippedReason: "use-memory-disabled",
              useCase: resolvedUseCase,
              questionType: resolvedQuestionType,
              askFrame,
              topicDomain,
              projectAnchor,
              interviewTypes,
              memoryPolicyId: effectiveMemoryPolicy?.id,
              allowedFamilies: effectiveMemoryPolicy?.allowedFamilies,
              blockedFamilies: effectiveMemoryPolicy?.blockedFamilies,
              strictProjectAnchor: effectiveMemoryPolicy?.strictProjectAnchor,
              queryChars: query.length,
            }
          );
          traceStoreRef.current.finishStep(traceId, memoryStepId, "cancelled", {
            skippedReason: "use-memory-disabled",
            memoryRetrievalEnabled: false,
          });
          traceStoreRef.current.updateMetadata(traceId, {
            memoryRetrievalEnabled: false,
            memoryRetrievalSkippedReason: "use-memory-disabled",
          });
        }
        return undefined;
      }

      try {
        if (traceId) {
          traceStoreRef.current.updateMetadata(traceId, {
            memoryRetrievalEnabled: true,
          });
          memoryStepId = traceStoreRef.current.startStep(
            traceId,
            "Memory retrieval",
            {
              source,
              useCase: resolvedUseCase,
              questionType: resolvedQuestionType,
              askFrame,
              topicDomain,
              projectAnchor,
              interviewTypes,
              memoryPolicyId: effectiveMemoryPolicy?.id,
              allowedFamilies: effectiveMemoryPolicy?.allowedFamilies,
              blockedFamilies: effectiveMemoryPolicy?.blockedFamilies,
              strictProjectAnchor: effectiveMemoryPolicy?.strictProjectAnchor,
              queryChars: query.length,
            }
          );
        }

        const memoryContext = await retrieveMemoryContext({
          query,
          useCase: resolvedUseCase,
          questionType: resolvedQuestionType,
          askFrame,
          topicDomain,
          projectAnchor,
          interviewTypes,
          memoryPolicy: effectiveMemoryPolicy,
        });

        if (traceId) {
          traceStoreRef.current.recordOutput(
            traceId,
            "injected memory context",
            formatMemorySelectionForTrace(memoryContext),
            {
              selectedEntries: memoryContext.entries.length,
              useCase: resolvedUseCase,
              questionType: resolvedQuestionType,
              askFrame,
              topicDomain,
              projectAnchor,
              interviewTypes,
              memoryPolicyId: effectiveMemoryPolicy?.id,
              allowedFamilies: effectiveMemoryPolicy?.allowedFamilies,
              blockedFamilies: effectiveMemoryPolicy?.blockedFamilies,
              strictProjectAnchor: effectiveMemoryPolicy?.strictProjectAnchor,
              candidateCount: memoryContext.candidateCount,
              eligibleCount: memoryContext.eligibleCount,
              rejectedCount: memoryContext.rejectedCount,
              rejectSummary: memoryContext.rejectSummary,
              memoryPolicySnapshot: memoryContext.policySnapshot,
              totalChars: memoryContext.totalChars,
            }
          );
          sessionRecordingManagerRef.current?.recordMemoryRetrieval({
            traceId,
            taskId,
            query,
            source,
            memoryContext,
            metadata: {
              useCase: resolvedUseCase,
              questionType: resolvedQuestionType,
              askFrame,
              topicDomain,
              projectAnchor,
              interviewTypes,
              memoryPolicyId: effectiveMemoryPolicy?.id,
              allowedFamilies: effectiveMemoryPolicy?.allowedFamilies,
              blockedFamilies: effectiveMemoryPolicy?.blockedFamilies,
              strictProjectAnchor: effectiveMemoryPolicy?.strictProjectAnchor,
            },
          });
          traceStoreRef.current.finishStep(traceId, memoryStepId, "success", {
            selectedEntries: memoryContext.entries.length,
            useCase: resolvedUseCase,
            questionType: resolvedQuestionType,
            askFrame,
            topicDomain,
            projectAnchor,
            interviewTypes,
            memoryPolicyId: effectiveMemoryPolicy?.id,
            allowedFamilies: effectiveMemoryPolicy?.allowedFamilies,
            blockedFamilies: effectiveMemoryPolicy?.blockedFamilies,
            strictProjectAnchor: effectiveMemoryPolicy?.strictProjectAnchor,
            candidateCount: memoryContext.candidateCount,
            eligibleCount: memoryContext.eligibleCount,
            rejectedCount: memoryContext.rejectedCount,
            rejectSummary: memoryContext.rejectSummary,
            memoryPolicySnapshot: memoryContext.policySnapshot,
            totalChars: memoryContext.totalChars,
          });
        }

        setState((previous) => ({
          ...previous,
          lastMemoryContext: memoryContext,
        }));

        return memoryContext;
      } catch (error) {
        if (traceId) {
          traceStoreRef.current.finishStep(
            traceId,
            memoryStepId,
            "error",
            undefined,
            error
          );
        }
        console.warn("Failed to retrieve meeting memory context", error);
        return undefined;
      }
    },
    [state.settings.useMemory]
  );

  const clearActiveScreenTask = useCallback(() => {
    clearAdvisorDebounce();
    advisorEngineRef.current.cancelCurrentRequest();
    screenAnalysisAbortRef.current?.abort();
    screenAnalysisAbortRef.current = null;
    contextManagerRef.current.clearActiveMeetingTask();
    setState(clearActiveScreenTaskState);
  }, [clearAdvisorDebounce]);

  const stop = useCallback(async () => {
    activeRef.current = false;
    invalidateAudioProcessingSession();
    clearAdvisorDebounce();
    advisorEngineRef.current.cancelCurrentRequest();
    screenAnalysisAbortRef.current?.abort();
    screenAnalysisAbortRef.current = null;
    contextManagerRef.current.clearActiveMeetingTask();
    contextManagerRef.current.clearInterviewSessionContext();
    const contextState = contextManagerRef.current.getState();

    let audioStatus: MeetingAudioStatus | null = null;

    try {
      audioStatus = await invoke<MeetingAudioStatus>(
        "stop_meeting_audio_session"
      );
    } catch (error) {
      console.warn("Failed to stop meeting audio capture", error);
    }

    await stopSessionRecording("meeting-assistant-stopped");

    setState((previous) => ({
      ...previous,
      status: "idle",
      activeScreenTask: undefined,
      activeInterviewTask: undefined,
      interviewSessionBrief: contextState.interviewSessionBrief,
      interviewSessionContext: contextState.interviewSessionContext,
      latestSuggestion:
        previous.latestSuggestion?.kind === "screen-task"
          ? null
          : previous.latestSuggestion,
      latestReliableSuggestion: null,
      partialSuggestion: "",
      error: null,
      audioStatus,
    }));
  }, [
    clearAdvisorDebounce,
    invalidateAudioProcessingSession,
    stopSessionRecording,
  ]);

  const runAdvisor = useCallback(async (options: RunAdvisorOptions = {}) => {
    const mode = options.mode ?? "live";
    const force = options.force ?? false;
    const traceId = options.traceId;
    let advisorStepId: string | undefined;

    if (!activeRef.current && !force) {
      if (traceId) {
        traceStoreRef.current.finishTrace(traceId, "cancelled");
      }
      return;
    }

    let promptContext = contextManagerRef.current.buildAdvisorPromptContext();
    const latestTurn = promptContext.latestTurn;
    const activeMeetingTaskId = getAdvisorActiveTaskId(promptContext);
    const hasContext = Boolean(
      promptContext.latestTurn ||
        promptContext.transcript.trim() ||
        promptContext.screenContext.trim()
    );

    if (
      !force &&
      !advisorEngineRef.current.shouldRequestSuggestion(latestTurn)
    ) {
      if (traceId) {
        const skippedStepId = traceStoreRef.current.startStep(
          traceId,
          "Advisor skipped",
          { reason: "turn did not require suggestion" }
        );
        traceStoreRef.current.finishStep(traceId, skippedStepId, "success");
        traceStoreRef.current.finishTrace(traceId, "success");
      }
      return;
    }

    if (force && !hasContext && !options.currentSuggestion?.trim()) {
      if (traceId) {
        traceStoreRef.current.finishTrace(traceId, "error", NO_MEETING_CONTEXT_MESSAGE);
      }
      setState((previous) => ({
        ...previous,
        error: NO_MEETING_CONTEXT_MESSAGE,
      }));
      return;
    }

    if (!aiProvider) {
      if (traceId) {
        traceStoreRef.current.finishTrace(traceId, "error", MISSING_AI_MESSAGE);
      }
      setState((previous) => ({
        ...previous,
        status: activeRef.current ? "listening" : previous.status,
        partialSuggestion: "",
        error: MISSING_AI_MESSAGE,
      }));
      return;
    }

    const returnStatus = state.status;
    const requestId = `advisor_${mode}_${Date.now()}`;
    const responseConfig = state.settings.response;
    contextManagerRef.current.setLastAdvisorRequestId(requestId);

    setState((previous) => ({
      ...previous,
      status: "thinking",
      partialSuggestion: "",
      error: null,
    }));

    const advisorMemoryQuery = buildAdvisorMemoryQuery(
      promptContext,
      mode,
      options.currentSuggestion
    );
    const advisorTaskSignals = resolveAdvisorTaskSignals(
      promptContext,
      advisorMemoryQuery
    );
    const advisorQuestionType = advisorTaskSignals.questionType;
    const advisorAskFrame = advisorTaskSignals.askFrame;
    const advisorTopicDomain = advisorTaskSignals.topicDomain;
    const advisorProjectAnchor =
      advisorTaskSignals.projectAnchor ??
      getAdvisorActiveProjectAnchor(promptContext);
    const advisorPlaybook =
      advisorTaskSignals.openingRoute?.commitParent === false
        ? undefined
        : advisorTaskSignals.reuseActivePlaybook
        ? getAdvisorActivePlaybook(promptContext) ??
          selectInterviewPlaybook({
            query: advisorTaskSignals.query,
            questionType:
              getAdvisorActiveQuestionType(promptContext) ??
              advisorQuestionType,
            askFrame: advisorAskFrame,
            topicDomain: advisorTopicDomain,
            projectAnchor: advisorProjectAnchor,
            classifierConfidence: getAdvisorActiveClassifierConfidence(promptContext),
            interviewSessionBrief: promptContext.interviewSessionBrief,
            interviewSessionContext: promptContext.interviewSessionContext,
          })
        : selectInterviewPlaybook({
            query: advisorTaskSignals.query,
            questionType: advisorQuestionType,
            askFrame: advisorAskFrame,
            topicDomain: advisorTopicDomain,
            projectAnchor: advisorProjectAnchor,
            classifierConfidence: getAdvisorActiveClassifierConfidence(promptContext),
            interviewSessionBrief: promptContext.interviewSessionBrief,
            interviewSessionContext: promptContext.interviewSessionContext,
          });
    const playbookPhaseDecision = decidePlaybookPhaseProgression({
      questionType:
        (advisorTaskSignals.taskRelation === "followup-parent" ||
          advisorTaskSignals.taskRelation === "resume-parent" ||
          advisorTaskSignals.taskRelation === "child-probe") &&
        getAdvisorActiveQuestionType(promptContext)
          ? getAdvisorActiveQuestionType(promptContext)
          : advisorQuestionType,
      playbookId: advisorPlaybook?.id,
      currentPhase:
        promptContext.activeMeetingTask?.parent.playbookPhase ??
        promptContext.activeInterviewTask?.playbookPhase ??
        advisorPlaybook?.phase,
      phaseProgress:
        promptContext.activeMeetingTask?.parent.phaseProgress ??
        promptContext.activeInterviewTask?.phaseProgress,
      latestTurnText: latestTurn?.text,
      currentQuestion: advisorTaskSignals.query,
      currentAnswer: options.currentSuggestion,
      relation: advisorTaskSignals.taskRelation,
      subtaskIntent: advisorTaskSignals.subtaskIntent,
      askFrame: advisorAskFrame ?? getAdvisorActiveAskFrame(promptContext),
    });

    if (traceId) {
      const playbookMetadata = formatInterviewPlaybookForTrace(advisorPlaybook);
      traceStoreRef.current.updateMetadata(traceId, {
        ...playbookMetadata,
        ...formatPlaybookPhaseDecisionForTrace(playbookPhaseDecision),
        questionType: advisorQuestionType,
        askFrame: advisorAskFrame,
        topicDomain: advisorTopicDomain,
        projectAnchor: advisorProjectAnchor,
        taskRelation: advisorTaskSignals.taskRelation,
        subtaskIntent: advisorTaskSignals.subtaskIntent,
        taskSignalSource: advisorTaskSignals.source,
        openingRouteKind: advisorTaskSignals.openingRoute?.kind,
        openingRouteCommitParent:
          advisorTaskSignals.openingRoute?.commitParent,
        parentTaskId: activeMeetingTaskId,
        parentTaskKind:
          promptContext.activeMeetingTask?.parent.questionType ??
          getAdvisorActiveQuestionType(promptContext),
        ...getActiveMeetingTaskTraceMetadata(promptContext.activeMeetingTask),
      });
      if (advisorPlaybook) {
        const playbookStepId = traceStoreRef.current.startStep(
          traceId,
          "Interview playbook selected",
          {
            ...playbookMetadata,
            ...formatPlaybookPhaseDecisionForTrace(playbookPhaseDecision),
            questionType: advisorQuestionType,
            askFrame: advisorAskFrame,
            topicDomain: advisorTopicDomain,
            projectAnchor: advisorProjectAnchor,
            taskRelation: advisorTaskSignals.taskRelation,
            subtaskIntent: advisorTaskSignals.subtaskIntent,
            taskSignalSource: advisorTaskSignals.source,
            openingRouteKind: advisorTaskSignals.openingRoute?.kind,
            openingRouteCommitParent:
              advisorTaskSignals.openingRoute?.commitParent,
            parentTaskId: activeMeetingTaskId,
            ...getActiveMeetingTaskTraceMetadata(promptContext.activeMeetingTask),
          }
        );
        traceStoreRef.current.finishStep(traceId, playbookStepId, "success");
      }
      sessionRecordingManagerRef.current?.recordPlaybookSelection(
        traceId,
        {
          ...playbookMetadata,
          ...formatPlaybookPhaseDecisionForTrace(playbookPhaseDecision),
        },
        activeMeetingTaskId
      );
    }

    const memoryContext = await loadMemoryForPrompt({
      traceId,
      taskId: activeMeetingTaskId,
      source: "advisor",
      query: advisorTaskSignals.query,
      useCase: inferMemoryUseCaseFromQuery(advisorTaskSignals.query),
      questionType: advisorQuestionType,
      askFrame: advisorAskFrame,
      topicDomain: advisorTopicDomain,
      projectAnchor: advisorProjectAnchor,
      memoryPolicy: advisorPlaybook?.memoryPolicy,
    });
    const factAnchorDecision = buildFactAnchorDecision({
      questionType:
        advisorTaskSignals.openingRoute?.commitParent === false
          ? undefined
          : advisorQuestionType,
      memoryContext,
      activeFactAnchors:
        promptContext.activeMeetingTask?.parent.supportedFactAnchors ??
        promptContext.activeInterviewTask?.supportedFactAnchors,
      projectAnchor: advisorProjectAnchor,
    });
    if (traceId) {
      const factAnchorMetadata = {
        source: "advisor",
        questionType: advisorQuestionType,
        ...formatFactAnchorDecisionForTrace(factAnchorDecision),
      };
      traceStoreRef.current.updateMetadata(traceId, factAnchorMetadata);
      const factAnchorStepId = traceStoreRef.current.startStep(
        traceId,
        "Fact anchor guardrail",
        factAnchorMetadata
      );
      traceStoreRef.current.finishStep(traceId, factAnchorStepId, "success");
      sessionRecordingManagerRef.current?.recordFactAnchorDecision(
        traceId,
        factAnchorMetadata,
        activeMeetingTaskId
      );
    }
    promptContext = {
      ...promptContext,
      memoryContext: memoryContext?.contextText,
      interviewPlaybook: advisorPlaybook,
      playbookPhaseDecision,
      factAnchorDecision,
      openingRoute: advisorTaskSignals.openingRoute,
    };

    const advisorUsesCodingModel =
      getAdvisorActiveQuestionType(promptContext) === "coding" ||
      getAdvisorActiveChildQuestionType(promptContext) === "coding" ||
      advisorPlaybook?.id === "coding_algorithm";
    const advisorModelRoute = resolveMeetingModelRoute({
      useCodingModel: advisorUsesCodingModel,
      reason: advisorUsesCodingModel
        ? "active-coding-task"
        : "advisor-main",
    });
    const advisorModelRouteMetadata =
      formatMeetingModelRouteForTrace(advisorModelRoute);
    const advisorModelRequestOptions =
      getMeetingModelRequestOptions(advisorModelRoute);
    if (traceId) {
      traceStoreRef.current.updateMetadata(traceId, {
        ...advisorModelRouteMetadata,
        modelRequestOptions: advisorModelRequestOptions,
      });
    }

    let finalContent = "";

    try {
      for await (const event of advisorEngineRef.current.streamSuggestion({
        requestId,
        mode,
        promptContext,
        provider: advisorModelRoute.provider,
        selectedProvider: advisorModelRoute.selectedProvider,
        requestOptions: advisorModelRequestOptions,
        responseAction: options.responseAction,
        responseConfig,
        currentSuggestion: options.currentSuggestion,
        clarifyingFeedback: options.clarifyingFeedback,
        trace: traceId
          ? {
              onRequest: (input) => {
                traceStoreRef.current.recordInput(
                  traceId,
                  "advisor model input",
                  formatTraceModelInput(input.systemPrompt, input.userMessage),
                  {
                    providerId: input.providerId,
                    mode: input.mode,
                    responseAction: input.responseAction,
                    responseConfig: input.responseConfig,
                    requestOptions: input.requestOptions,
                    ...advisorModelRouteMetadata,
                    imageCount: input.imageCount,
                  }
                );
                sessionRecordingManagerRef.current?.recordModelInput({
                  traceId,
                  taskId: activeMeetingTaskId,
                  label: "advisor model input",
                  value: formatTraceModelInput(
                    input.systemPrompt,
                    input.userMessage
                  ),
                  metadata: {
                    providerId: input.providerId,
                    mode: input.mode,
                    responseAction: input.responseAction,
                    responseConfig: input.responseConfig,
                    requestOptions: input.requestOptions,
                    ...advisorModelRouteMetadata,
                    imageCount: input.imageCount,
                  },
                });
                advisorStepId = traceStoreRef.current.startStep(
                  traceId,
                  "Advisor model response",
                  {
                    providerId: input.providerId,
                    mode: input.mode,
                    responseAction: input.responseAction,
                    responseLength: input.responseConfig?.length,
                    responseLanguage: input.responseConfig?.language,
                    requestOptions: input.requestOptions,
                    ...advisorModelRouteMetadata,
                    promptChars:
                      input.systemPrompt.length + input.userMessage.length,
                  }
                );
              },
              onFirstToken: () => {
                traceStoreRef.current.updateMetadata(traceId, {
                  advisorFirstTokenAt: Date.now(),
                });
              },
              onComplete: (output) => {
                traceStoreRef.current.recordOutput(
                  traceId,
                  "advisor raw output",
                  output
                );
                sessionRecordingManagerRef.current?.recordModelOutput({
                  traceId,
                  taskId: activeMeetingTaskId,
                  label: "advisor raw output",
                  value: output,
                  metadata: {
                    ...advisorModelRouteMetadata,
                    requestOptions: advisorModelRequestOptions,
                  },
                });
              },
            }
          : undefined,
      })) {
        finalContent = event.accumulated;
        setState((previous) => ({
          ...previous,
          partialSuggestion: event.accumulated,
        }));
      }

      if (mode === "response-action") {
        finalContent = preserveCodingResponseActionSections(
          finalContent,
          options.currentSuggestion
        );
      }

      let contextState = contextManagerRef.current.getState();
      const existingInterviewTask =
        contextState.activeInterviewTask ??
        (contextState.activeMeetingTask?.screen && contextState.activeScreenTask
          ? buildInterviewParentFromScreenTask(contextState.activeScreenTask)
          : undefined);
      const advisorEvidenceSource = contextState.activeMeetingTask?.screen
        ? "screen"
        : "voice";
      const shouldCommitAdvisorParent =
        advisorTaskSignals.openingRoute?.commitParent !== false;
      const continuity = shouldCommitAdvisorParent
        ? updateInterviewTaskContinuityForAnswer({
            existingTask: existingInterviewTask,
            source: advisorEvidenceSource,
            questionType:
              advisorTaskSignals.taskRelation === "followup-parent" &&
              existingInterviewTask
                ? existingInterviewTask.stableKind
                : advisorQuestionType,
            relation: advisorTaskSignals.taskRelation,
            subtaskIntent: advisorTaskSignals.subtaskIntent,
            question:
              contextState.activeScreenTask?.question ??
              latestTurn?.text ??
              extractScreenTaskQuestion(finalContent),
            finalContent,
            playbook: advisorPlaybook,
            phaseDecision: playbookPhaseDecision,
            latestTurn,
            observationId: contextState.activeScreenTask?.basedOnObservationId,
            expiresAt: getActiveScreenTaskExpiresAt(state.settings),
            supportedFactAnchors: mergeSupportedFactAnchors(
              advisorProjectAnchor ? [advisorProjectAnchor] : undefined,
              extractSupportedFactAnchorsFromMemory(memoryContext)
            ),
          })
        : {
            task: existingInterviewTask,
            startedNewParent: false,
            clearedParent: false,
          };
      let nextActiveScreenTask = contextState.activeScreenTask;

      if (
        mode === "screen-anchored" &&
        nextActiveScreenTask &&
        shouldUpdateActiveScreenTaskFromAdvisorOutput(finalContent)
      ) {
        const updatedAt = Date.now();
        const basedOnTurnIds =
          latestTurn &&
          !nextActiveScreenTask.basedOnTurnIds.includes(latestTurn.id)
            ? [...nextActiveScreenTask.basedOnTurnIds, latestTurn.id]
            : nextActiveScreenTask.basedOnTurnIds;

        nextActiveScreenTask = {
          ...nextActiveScreenTask,
          updatedAt,
          expiresAt: getActiveScreenTaskExpiresAt(state.settings, updatedAt),
          question:
            extractScreenTaskQuestion(finalContent) ||
            nextActiveScreenTask.question,
          kind:
            nextActiveScreenTask.classifier?.overrideSource ===
            "interview-type-selector"
              ? nextActiveScreenTask.kind
              : normalizeScreenQuestionType(inferScreenTaskKind(finalContent)) ??
                nextActiveScreenTask.kind,
          language:
            inferScreenTaskLanguage(finalContent) ||
            nextActiveScreenTask.language,
          content: finalContent.trim(),
          basedOnTurnIds,
        };
      }

      contextManagerRef.current.setActiveMeetingTaskState({
        activeScreenTask: nextActiveScreenTask,
        activeInterviewTask: continuity.task ?? null,
      });
      contextState = contextManagerRef.current.getState();

      if (traceId) {
        traceStoreRef.current.updateMetadata(traceId, {
          ...formatPlaybookPhaseDecisionForTrace(playbookPhaseDecision),
          ...getActiveMeetingTaskTraceMetadata(contextState.activeMeetingTask),
          activeInterviewParentId: contextState.activeInterviewTask?.id,
          activeInterviewParentKind: contextState.activeInterviewTask?.stableKind,
          activeInterviewParentPhase:
            contextState.activeInterviewTask?.playbookPhase,
          activeInterviewChildId: contextState.activeInterviewTask?.child?.id,
          activeInterviewChildKind:
            contextState.activeInterviewTask?.child?.questionType,
          activeInterviewChildIntent:
            contextState.activeInterviewTask?.child?.intent,
          startedNewInterviewParent: continuity.startedNewParent,
        });
      }

      if (traceId && contextState.activeScreenTask) {
        sessionRecordingManagerRef.current?.recordTaskSnapshot(
          contextState.activeScreenTask,
          traceId
        );
      }

      if (traceId && contextState.activeMeetingTask) {
        sessionRecordingManagerRef.current?.recordActiveMeetingTaskSnapshot(
          contextState.activeMeetingTask,
          traceId
        );
      }

      const latestObservationIds = contextState.screenObservations.map(
        (observation) => observation.id
      );

      const nextSuggestion = advisorEngineRef.current.toSuggestion(
        requestId,
        finalContent,
        latestTurn ? [latestTurn.id] : [],
        latestObservationIds
      );

      setState((previous) => ({
        ...previous,
        ...withLatestReliableSuggestion(previous, nextSuggestion, {
          clearPrevious: continuity.startedNewParent,
        }),
        status: activeRef.current
          ? "listening"
          : returnStatus === "paused"
            ? "paused"
            : "idle",
        interviewSessionContext: contextState.interviewSessionContext,
        activeScreenTask: contextState.activeScreenTask,
        activeInterviewTask: contextState.activeInterviewTask,
        activeMeetingTask: contextState.activeMeetingTask,
      }));
      if (traceId) {
        traceStoreRef.current.finishStep(traceId, advisorStepId, "success", {
          outputChars: finalContent.length,
          ...advisorModelRouteMetadata,
        });
        traceStoreRef.current.finishTrace(traceId, "success");
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (traceId) {
          traceStoreRef.current.finishStep(
            traceId,
            advisorStepId,
            "cancelled",
            undefined,
            error
          );
          traceStoreRef.current.finishTrace(traceId, "cancelled", error);
        }

        if (activeRef.current) {
          setState((previous) => ({
            ...previous,
            status: "listening",
            partialSuggestion: "",
          }));
        }
        return;
      }

      if (traceId) {
        traceStoreRef.current.finishStep(
          traceId,
          advisorStepId,
          "error",
          undefined,
          error
        );
        traceStoreRef.current.finishTrace(traceId, "error", error);
      }
      if (!activeRef.current && !force) return;

      setState((previous) => ({
        ...previous,
        status: activeRef.current
          ? "listening"
          : returnStatus === "paused"
            ? "paused"
            : "idle",
        partialSuggestion: "",
        error:
          error instanceof Error
            ? error.message
            : "Failed to generate meeting suggestion.",
      }));
    }
  }, [
    aiProvider,
    loadMemoryForPrompt,
    resolveMeetingModelRoute,
    selectedAIProvider,
    state.settings,
    state.status,
  ]);

  const scheduleAdvisor = useCallback((
    mode: AdvisorRequestMode = "live",
    traceId?: string
  ) => {
    if (!activeRef.current) return;

    clearAdvisorDebounce();
    advisorDebounceTimerRef.current = window.setTimeout(() => {
      advisorDebounceTimerRef.current = null;
      void runAdvisor({ mode, traceId });
    }, ADVISOR_DEBOUNCE_MS);
  }, [clearAdvisorDebounce, runAdvisor]);

  const appendTranscriptTurnForTrace = useCallback(
    (
      turn: TranscriptTurn,
      traceId: string,
      segment: QueuedSpeechSegment,
      metadata: Record<string, unknown> = {}
    ) => {
      const interviewContextUpdate =
        contextManagerRef.current.addTranscriptTurn(turn);
      sessionRecordingManagerRef.current?.recordTranscriptTurn(turn);
      const contextState = contextManagerRef.current.getState();
      const appendStepId = traceStoreRef.current.startStep(
        traceId,
        "Transcript appended",
        {
          turnId: turn.id,
          speaker: turn.speaker,
          source: turn.source,
          audioSegmentSeq: segment.sequence,
          audioSessionId: segment.sessionId,
          contextTier: turn.contextTier,
          contextPromptEligible: turn.contextPromptEligible,
          contextFusionStatus: turn.contextFusionStatus,
          ...metadata,
        }
      );
      traceStoreRef.current.finishStep(traceId, appendStepId, "success", {
        transcriptTurns: contextState.transcriptTurns.length,
      });

      if (interviewContextUpdate?.changed) {
        const targetCompany =
          interviewContextUpdate.targetCompany ??
          contextState.interviewSessionContext?.targetCompany;
        const interviewStepId = traceStoreRef.current.startStep(
          traceId,
          "Interview session context updated",
          {
            targetCompany: targetCompany?.value,
            confidence: targetCompany?.confidence,
            source: targetCompany?.source,
          }
        );
        traceStoreRef.current.finishStep(
          traceId,
          interviewStepId,
          "success",
          {
            evidenceChars: targetCompany?.evidence.length ?? 0,
          }
        );
        traceStoreRef.current.updateMetadata(traceId, {
          targetCompany: targetCompany?.value,
          targetCompanyConfidence: targetCompany?.confidence,
        });
      }

      setState((previous) => ({
        ...previous,
        status: activeRef.current ? "listening" : "idle",
        transcriptTurns: contextState.transcriptTurns,
        interviewSessionContext: contextState.interviewSessionContext,
        activeScreenTask: contextState.activeScreenTask,
        activeInterviewTask: contextState.activeInterviewTask,
        activeMeetingTask: contextState.activeMeetingTask,
      }));

      return { contextState, interviewContextUpdate };
    },
    []
  );

  const promoteMeTurnForFusion = useCallback(
    (meTurn: TranscriptTurn, relatedTurnId: string) => {
      contextManagerRef.current.updateTranscriptTurnContext(meTurn.id, {
        contextPromptEligible: true,
        contextFusionStatus: "paired",
        relatedTurnIds: Array.from(
          new Set([...(meTurn.relatedTurnIds ?? []), relatedTurnId])
        ),
      });
    },
    []
  );

  const resolvePendingConfirmationForMeTurn = useCallback(
    (meTurn: TranscriptTurn) => {
      const pending = pendingConfirmationRef.current;
      if (!pending) return false;

      if (!isCurrentAudioSegment(pending.segment)) {
        clearPendingConfirmation("stale-pending-confirmation");
        return false;
      }

      const match = findRecentMeClarificationForTurn(pending.turn, [meTurn]);
      if (!match) return false;

      window.clearTimeout(pending.timeoutId);
      pendingConfirmationRef.current = null;
      promoteMeTurnForFusion(meTurn, pending.turn.id);

      const pairStepId = traceStoreRef.current.startStep(
        pending.segment.traceId,
        "Clarification pair detected",
        {
          reason: match.reason,
          meTurnId: meTurn.id,
          themTurnId: pending.turn.id,
          heldMs: Date.now() - pending.heldAt,
          audioSegmentSeq: pending.segment.sequence,
          audioSessionId: pending.segment.sessionId,
        }
      );
      traceStoreRef.current.finishStep(
        pending.segment.traceId,
        pairStepId,
        "success"
      );

      pending.turn.contextFusionStatus = "paired";
      pending.turn.relatedTurnIds = [meTurn.id];
      const { contextState } = appendTranscriptTurnForTrace(
        pending.turn,
        pending.segment.traceId,
        pending.segment,
        {
          fusedWithTurnId: meTurn.id,
        }
      );
      const debounceStepId = traceStoreRef.current.startStep(
        pending.segment.traceId,
        "Advisor debounce scheduled",
        { debounceMs: ADVISOR_DEBOUNCE_MS, reason: "clarification-pair" }
      );
      traceStoreRef.current.finishStep(
        pending.segment.traceId,
        debounceStepId,
        "success"
      );
      scheduleAdvisor(
        contextState.activeMeetingTask?.screen ? "screen-anchored" : "live",
        pending.segment.traceId
      );

      return true;
    },
    [
      appendTranscriptTurnForTrace,
      clearPendingConfirmation,
      isCurrentAudioSegment,
      promoteMeTurnForFusion,
      scheduleAdvisor,
    ]
  );

  const holdPendingConfirmation = useCallback(
    (turn: TranscriptTurn, segment: QueuedSpeechSegment) => {
      clearPendingConfirmation("replaced-by-new-pending-confirmation");

      const heldAt = Date.now();
      const heldStepId = traceStoreRef.current.startStep(
        segment.traceId,
        "Pending confirmation held",
        {
          turnId: turn.id,
          ttlMs: PENDING_CONFIRMATION_TTL_MS,
          audioSegmentSeq: segment.sequence,
          audioSessionId: segment.sessionId,
          transcriptChars: turn.text.trim().length,
        }
      );
      traceStoreRef.current.finishStep(segment.traceId, heldStepId, "success");

      const timeoutId = window.setTimeout(() => {
        const pending = pendingConfirmationRef.current;
        if (!pending || pending.turn.id !== turn.id) return;

        pendingConfirmationRef.current = null;
        const expiredStepId = traceStoreRef.current.startStep(
          segment.traceId,
          "Pending confirmation expired",
          {
            turnId: turn.id,
            heldMs: Date.now() - heldAt,
            audioSegmentSeq: segment.sequence,
            audioSessionId: segment.sessionId,
          }
        );
        traceStoreRef.current.finishStep(
          segment.traceId,
          expiredStepId,
          "success"
        );
        traceStoreRef.current.finishTrace(segment.traceId, "success");
      }, PENDING_CONFIRMATION_TTL_MS);

      pendingConfirmationRef.current = {
        turn,
        segment,
        heldAt,
        timeoutId,
      };

      setState((previous) => ({
        ...previous,
        status: activeRef.current ? "listening" : "idle",
      }));
    },
    [clearPendingConfirmation]
  );

  const processQueuedSpeechSegment = useCallback(
    async (segment: QueuedSpeechSegment) => {
      const traceId = segment.traceId;
      let audioBlobStepId: string | undefined;
      let sttStepId: string | undefined;
      const staleReason = "Audio segment belongs to a stale meeting session.";

      if (!isCurrentAudioSegment(segment)) {
        traceStoreRef.current.finishStep(
          traceId,
          segment.queueStepId,
          "cancelled",
          {
            reason: "stale-before-processing",
            audioSegmentSeq: segment.sequence,
            audioSessionId: segment.sessionId,
            speaker: segment.speaker,
            source: segment.source,
            currentAudioSessionId: audioSessionIdRef.current,
            queueWaitMs: Date.now() - segment.queuedAt,
          }
        );
        traceStoreRef.current.finishTrace(traceId, "cancelled", staleReason);
        return;
      }

      traceStoreRef.current.finishStep(
        traceId,
        segment.queueStepId,
        "success",
        {
          audioSegmentSeq: segment.sequence,
          audioSessionId: segment.sessionId,
          speaker: segment.speaker,
          source: segment.source,
          queueWaitMs: Date.now() - segment.queuedAt,
        }
      );

      if (!sttProvider) {
        activeRef.current = false;
        invalidateAudioProcessingSession();
        clearAdvisorDebounce();
        advisorEngineRef.current.cancelCurrentRequest();
        screenAnalysisAbortRef.current?.abort();
        screenAnalysisAbortRef.current = null;

        let audioStatus: MeetingAudioStatus | null = null;

        try {
          audioStatus = await invoke<MeetingAudioStatus>(
            "stop_meeting_audio_session"
          );
        } catch (error) {
          console.warn("Failed to stop meeting audio capture", error);
        }

        traceStoreRef.current.finishTrace(traceId, "error", MISSING_STT_MESSAGE);
        setState((previous) => ({
          ...previous,
          status: "error",
          partialSuggestion: "",
          error: MISSING_STT_MESSAGE,
          audioStatus,
        }));
        return;
      }

      setState((previous) => ({
        ...previous,
        status: "transcribing",
        error: null,
      }));

      try {
        audioBlobStepId = traceStoreRef.current.startStep(
          traceId,
          "Audio blob created",
          {
            audioSegmentSeq: segment.sequence,
            audioSessionId: segment.sessionId,
          }
        );
        const audio = segment.audioBlob ?? (
          segment.base64Audio ? base64WavToBlob(segment.base64Audio) : null
        );
        if (!audio) {
          throw new Error("Audio segment did not include audio payload.");
        }
        traceStoreRef.current.finishStep(traceId, audioBlobStepId, "success", {
          audioBytes: audio.size,
          audioType: audio.type,
          speaker: segment.speaker,
          source: segment.source,
        });

        const speechBias = buildSpeechBiasContext(
          contextManagerRef.current.getState(),
          speechCorrectionsRef.current
        );
        traceStoreRef.current.recordInput(
          traceId,
          "speech bias context",
          formatSpeechBiasPromptForTrace(speechBias),
          {
            termCount: speechBias.terms.length,
            ruleCount: speechBias.correctionRules.length,
            promptChars: speechBias.prompt.length,
            terms: speechBias.terms.map((term) => term.term),
          }
        );

        traceStoreRef.current.recordInput(
          traceId,
          "stt input metadata",
          "Raw audio bytes are not stored in traces.",
          {
            providerId: sttProvider.id,
            audioBytes: audio.size,
            audioType: audio.type,
            audioSegmentSeq: segment.sequence,
            audioSessionId: segment.sessionId,
            speaker: segment.speaker,
            source: segment.source,
            speechBiasTermCount: speechBias.terms.length,
            speechBiasRuleCount: speechBias.correctionRules.length,
            speechBiasPromptChars: speechBias.prompt.length,
          }
        );
        sttStepId = traceStoreRef.current.startStep(
          traceId,
          "STT request",
          {
            providerId: sttProvider.id,
            audioBytes: audio.size,
            audioSegmentSeq: segment.sequence,
            audioSessionId: segment.sessionId,
            speaker: segment.speaker,
            source: segment.source,
            speechBiasTermCount: speechBias.terms.length,
            speechBiasRuleCount: speechBias.correctionRules.length,
          }
        );
        const turn = await withTimeout(
          transcribeMeetingAudio({
            audio,
            provider: sttProvider,
            selectedProvider: selectedSttProvider,
            prompt: speechBias.prompt,
            terms: speechBias.terms.map((term) => term.term),
            speaker: segment.speaker,
            source: segment.source,
            startedAt: segment.startedAt,
            endedAt: segment.endedAt,
          }),
          STT_TIMEOUT_MS,
          "Speech-to-text timed out. Jarvis is still listening."
        );
        traceStoreRef.current.finishStep(traceId, sttStepId, "success", {
          transcriptChars: turn?.text.length ?? 0,
        });

        if (turn) {
          traceStoreRef.current.recordOutput(
            traceId,
            "stt raw output",
            turn.text,
            {
              turnId: turn.id,
              audioSegmentSeq: segment.sequence,
              audioSessionId: segment.sessionId,
              speaker: segment.speaker,
              source: segment.source,
            }
          );
          const normalized = normalizeTranscriptWithSpeechBias(
            turn.text,
            speechBias
          );
          if (normalized.changed) {
            turn.text = normalized.text;
            incrementAppliedSpeechCorrections(normalized.appliedRules);
            traceStoreRef.current.recordOutput(
              traceId,
              "stt normalized output",
              normalized.text,
              {
                turnId: turn.id,
                appliedRules: normalized.appliedRules.map(
                  (rule) => `${rule.from}->${rule.to}`
                ),
                audioSegmentSeq: segment.sequence,
                audioSessionId: segment.sessionId,
              }
            );
          }
        }

        if (!isCurrentAudioSegment(segment)) {
          const droppedStepId = traceStoreRef.current.startStep(
            traceId,
            "Transcript dropped",
            {
              reason: "stale-after-stt",
              turnId: turn?.id,
              transcriptChars: turn?.text.trim().length ?? 0,
              audioSegmentSeq: segment.sequence,
              audioSessionId: segment.sessionId,
              currentAudioSessionId: audioSessionIdRef.current,
            }
          );
          traceStoreRef.current.finishStep(traceId, droppedStepId, "success");
          traceStoreRef.current.finishTrace(traceId, "cancelled", staleReason);
          return;
        }

        if (!turn) {
          traceStoreRef.current.finishTrace(traceId, "success");
          setState((previous) => ({
            ...previous,
            status: activeRef.current ? "listening" : "idle",
          }));
          return;
        }

        turn.audioSegmentSeq = segment.sequence;
        turn.audioSessionId = segment.sessionId;

        const activeContextState = contextManagerRef.current.getState();
        const activeScreenTask = activeContextState.activeScreenTask;
        const activeInterviewTask = activeContextState.activeInterviewTask;
        const hasActiveInterviewTask = Boolean(
          activeScreenTask || activeInterviewTask
        );

        if (turn.speaker === "me") {
          const classification = classifyMeTurn(turn, hasActiveInterviewTask);
          turn.contextTier = classification.tier;
          turn.contextPromptEligible = classification.promptEligible;
          turn.contextFusionStatus = classification.promptEligible
            ? "pending"
            : "debug-only";

          const classificationStepId = traceStoreRef.current.startStep(
            traceId,
            "Microphone transcript classified",
            {
              turnId: turn.id,
              contextTier: classification.tier,
              contextPromptEligible: classification.promptEligible,
              wordEquivalent: classification.wordEquivalent,
              durationMs: classification.durationMs,
              hasClarificationSignal: classification.hasClarificationSignal,
              audioSegmentSeq: segment.sequence,
              audioSessionId: segment.sessionId,
            }
          );
          traceStoreRef.current.finishStep(
            traceId,
            classificationStepId,
            "success"
          );

          const duplicateDecision = findDuplicateSystemAudioTurnForMeTurn(
            turn,
            contextManagerRef.current.getState().transcriptTurns
          );
          if (duplicateDecision.confidence !== "low") {
            turn.contextPromptEligible = false;
            turn.contextFusionStatus = "duplicate-suppressed";
            turn.relatedTurnIds = duplicateDecision.matchedTurn?.id
              ? [duplicateDecision.matchedTurn.id]
              : [];
            const duplicateStepId = traceStoreRef.current.startStep(
              traceId,
              "Duplicate transcript suppressed",
              {
                direction: "microphone-arrived-after-system-audio",
                matchedTurnId: duplicateDecision.matchedTurn?.id,
                tokenJaccard: duplicateDecision.tokenJaccard,
                trigramDice: duplicateDecision.trigramDice,
                timeDeltaMs: duplicateDecision.timeDeltaMs,
                overlapRatio: duplicateDecision.overlapRatio,
                confidence: duplicateDecision.confidence,
                reason: duplicateDecision.reason,
              }
            );
            traceStoreRef.current.finishStep(
              traceId,
              duplicateStepId,
              "success"
            );
            traceStoreRef.current.finishTrace(traceId, "success");
            setState((previous) => ({
              ...previous,
              status: activeRef.current ? "listening" : "idle",
            }));
            return;
          }

          appendTranscriptTurnForTrace(turn, traceId, segment);
          resolvePendingConfirmationForMeTurn(turn);
          traceStoreRef.current.finishTrace(traceId, "success");
          return;
        }

        const duplicateDecision = shouldSuppressDuplicateSystemAudioTurn(
          turn,
          contextManagerRef.current.getState().transcriptTurns
        );
        if (duplicateDecision.suppress) {
          turn.contextFusionStatus = "duplicate-suppressed";
          const duplicateStepId = traceStoreRef.current.startStep(
            traceId,
            "Duplicate transcript suppressed",
            {
              direction: "system-audio-echo-of-microphone",
              matchedTurnId: duplicateDecision.matchedTurn?.id,
              tokenJaccard: duplicateDecision.tokenJaccard,
              trigramDice: duplicateDecision.trigramDice,
              timeDeltaMs: duplicateDecision.timeDeltaMs,
              overlapRatio: duplicateDecision.overlapRatio,
              reason: duplicateDecision.reason,
            }
          );
          traceStoreRef.current.finishStep(
            traceId,
            duplicateStepId,
            "success"
          );
          traceStoreRef.current.finishTrace(traceId, "success");
          setState((previous) => ({
            ...previous,
            status: activeRef.current ? "listening" : "idle",
          }));
          return;
        }

        if (hasActiveInterviewTask && isTaskSwitchTranscript(turn.text)) {
          const switchStepId = traceStoreRef.current.startStep(
            traceId,
            "Task switch confirmation requested",
            {
              turnId: turn.id,
              ...getActiveMeetingTaskTraceMetadata(
                activeContextState.activeMeetingTask
              ),
              activeScreenTaskId: activeScreenTask?.id,
              activeInterviewTaskId: activeInterviewTask?.id,
              transcriptChars: turn.text.trim().length,
            }
          );
          traceStoreRef.current.finishStep(traceId, switchStepId, "success");
          traceStoreRef.current.finishTrace(traceId, "success");
          const taskSwitchSuggestion: AdvisorSuggestion = {
            id: createMeetingId("task_switch"),
            kind: "clarifying-question",
            content: [
              "中文思路: 这听起来像是在切换到新题或新任务。",
              "Reply: -",
              "Question: Should I treat this as a new task?",
            ].join("\n"),
            createdAt: Date.now(),
            basedOnTurnIds: [turn.id],
            basedOnObservationIds: activeScreenTask
              ? [activeScreenTask.observationId]
              : [],
            confidence: "medium",
          };
          setState((previous) => ({
            ...previous,
            ...withLatestReliableSuggestion(previous, taskSwitchSuggestion),
            status: activeRef.current ? "listening" : "idle",
            partialSuggestion: "",
          }));
          return;
        }

        const previousTurns = contextManagerRef.current.getState()
          .transcriptTurns;
        const clarificationMatch = findRecentMeClarificationForTurn(
          turn,
          previousTurns
        );
        if (clarificationMatch) {
          promoteMeTurnForFusion(clarificationMatch.meTurn, turn.id);
          turn.contextPromptEligible = true;
          turn.contextFusionStatus = "paired";
          turn.relatedTurnIds = [clarificationMatch.meTurn.id];
          traceStoreRef.current.updateMetadata(traceId, {
            turnGateAction: "answer-refresh",
            turnGateReason: "clarification-pair",
          });
          const gateStepId = traceStoreRef.current.startStep(
            traceId,
            "Advisor turn gate",
            {
              action: "answer-refresh",
              reason: "clarification-pair",
              turnId: turn.id,
              transcriptChars: turn.text.trim().length,
              activeScreenTask: Boolean(activeScreenTask),
              audioSegmentSeq: segment.sequence,
              audioSessionId: segment.sessionId,
            }
          );
          traceStoreRef.current.finishStep(traceId, gateStepId, "success");
          const pairStepId = traceStoreRef.current.startStep(
            traceId,
            "Clarification pair detected",
            {
              reason: clarificationMatch.reason,
              meTurnId: clarificationMatch.meTurn.id,
              themTurnId: turn.id,
              audioSegmentSeq: segment.sequence,
              audioSessionId: segment.sessionId,
            }
          );
          traceStoreRef.current.finishStep(traceId, pairStepId, "success");
          const { contextState } = appendTranscriptTurnForTrace(
            turn,
            traceId,
            segment,
            {
              fusedWithTurnId: clarificationMatch.meTurn.id,
              turnGateAction: "answer-refresh",
              turnGateReason: "clarification-pair",
            }
          );
          const debounceStepId = traceStoreRef.current.startStep(
            traceId,
            "Advisor debounce scheduled",
            { debounceMs: ADVISOR_DEBOUNCE_MS, reason: "clarification-pair" }
          );
          traceStoreRef.current.finishStep(traceId, debounceStepId, "success");
          scheduleAdvisor(
            contextState.activeMeetingTask?.screen ? "screen-anchored" : "live",
            traceId
          );
          return;
        }

        if (
          isShortConfirmationLike(turn.text) &&
          !hasConstraintOrCorrectionSignal(turn.text)
        ) {
          traceStoreRef.current.updateMetadata(traceId, {
            turnGateAction: "ignore",
            turnGateReason: "pending-short-confirmation",
          });
          const gateStepId = traceStoreRef.current.startStep(
            traceId,
            "Advisor turn gate",
            {
              action: "ignore",
              reason: "pending-short-confirmation",
              turnId: turn.id,
              transcriptChars: turn.text.trim().length,
              activeScreenTask: Boolean(activeScreenTask),
              audioSegmentSeq: segment.sequence,
              audioSessionId: segment.sessionId,
            }
          );
          traceStoreRef.current.finishStep(traceId, gateStepId, "success");
          holdPendingConfirmation(turn, segment);
          return;
        }

        const turnGate = evaluateThemTurnForAdvisor(turn, {
          hasActiveTask: hasActiveInterviewTask,
        });
        traceStoreRef.current.updateMetadata(traceId, {
          turnGateAction: turnGate.action,
          turnGateReason: turnGate.reason,
        });
        const gateStepId = traceStoreRef.current.startStep(
          traceId,
          "Advisor turn gate",
          {
            action: turnGate.action,
            reason: turnGate.reason,
            turnId: turn.id,
            transcriptChars: turn.text.trim().length,
            wordEquivalent: calculateWordEquivalent(turn.text),
            activeScreenTask: Boolean(activeScreenTask),
            activeInterviewTask: Boolean(activeInterviewTask),
            contextPromptEligible: turnGate.contextPromptEligible,
            audioSegmentSeq: segment.sequence,
            audioSessionId: segment.sessionId,
          }
        );
        traceStoreRef.current.finishStep(traceId, gateStepId, "success");

        if (turnGate.action === "ignore") {
          const ignoredStepId = traceStoreRef.current.startStep(
            traceId,
            "Transcript ignored",
            {
              reason: turnGate.reason,
              transcriptChars: turn.text.trim().length,
              activeScreenTask: Boolean(activeScreenTask),
              activeInterviewTask: Boolean(activeInterviewTask),
            }
          );
          traceStoreRef.current.finishStep(traceId, ignoredStepId, "success");
          traceStoreRef.current.finishTrace(traceId, "success");
          setState((previous) => ({
            ...previous,
            status: activeRef.current ? "listening" : "idle",
          }));
          return;
        }

        turn.contextPromptEligible = turnGate.contextPromptEligible;
        turn.contextFusionStatus = turnGate.contextPromptEligible
          ? "none"
          : "debug-only";

        const { contextState } = appendTranscriptTurnForTrace(
          turn,
          traceId,
          segment,
          {
            turnGateAction: turnGate.action,
            turnGateReason: turnGate.reason,
          }
        );

        if (turnGate.action === "state-update") {
          const stateUpdatedTask = buildStateUpdatedInterviewTask(
            contextState.activeInterviewTask,
            turn
          );
          if (stateUpdatedTask) {
            contextManagerRef.current.setActiveInterviewTask(stateUpdatedTask);
          }
          const nextContextState = contextManagerRef.current.getState();
          traceStoreRef.current.updateMetadata(traceId, {
            turnGateAction: "state-update",
            turnGateReason: turnGate.reason,
            ...getActiveMeetingTaskTraceMetadata(
              nextContextState.activeMeetingTask
            ),
            activeInterviewParentId: nextContextState.activeInterviewTask?.id,
            activeInterviewParentKind:
              nextContextState.activeInterviewTask?.stableKind,
            activeInterviewParentPhase:
              nextContextState.activeInterviewTask?.playbookPhase,
          });
          const stateUpdateStepId = traceStoreRef.current.startStep(
            traceId,
            "Interview task state updated",
            {
              reason: turnGate.reason,
              turnId: turn.id,
              ...getActiveMeetingTaskTraceMetadata(
                nextContextState.activeMeetingTask
              ),
              activeInterviewTaskId: nextContextState.activeInterviewTask?.id,
              activeInterviewTaskKind:
                nextContextState.activeInterviewTask?.stableKind,
              transcriptChars: turn.text.trim().length,
            }
          );
          traceStoreRef.current.finishStep(
            traceId,
            stateUpdateStepId,
            "success"
          );
          traceStoreRef.current.finishTrace(traceId, "success");
          setState((previous) => ({
            ...previous,
            status: activeRef.current ? "listening" : "idle",
            transcriptTurns: nextContextState.transcriptTurns,
            interviewSessionContext: nextContextState.interviewSessionContext,
            activeScreenTask: nextContextState.activeScreenTask,
            activeInterviewTask: nextContextState.activeInterviewTask,
            activeMeetingTask: nextContextState.activeMeetingTask,
          }));
          return;
        }

        if (turnGate.action !== "answer-refresh") {
          traceStoreRef.current.finishTrace(traceId, "success");
          return;
        }

        const debounceStepId = traceStoreRef.current.startStep(
          traceId,
          "Advisor debounce scheduled",
          { debounceMs: ADVISOR_DEBOUNCE_MS, reason: turnGate.reason }
        );
        traceStoreRef.current.finishStep(traceId, debounceStepId, "success");
        scheduleAdvisor(
          contextState.activeMeetingTask?.screen ? "screen-anchored" : "live",
          traceId
        );
      } catch (error) {
        const stillCurrent = isCurrentAudioSegment(segment);
        const traceStatus = stillCurrent ? "error" : "cancelled";
        traceStoreRef.current.finishStep(
          traceId,
          audioBlobStepId,
          traceStatus,
          undefined,
          error
        );
        traceStoreRef.current.finishStep(
          traceId,
          sttStepId,
          traceStatus,
          undefined,
          error
        );
        traceStoreRef.current.finishTrace(
          traceId,
          traceStatus,
          stillCurrent ? error : staleReason
        );

        if (!stillCurrent) return;

        setState((previous) => ({
          ...previous,
          status: "listening",
          partialSuggestion: "",
          error:
            error instanceof Error
              ? error.message
              : "Failed to transcribe meeting audio.",
        }));
      }
    },
    [
      appendTranscriptTurnForTrace,
      clearAdvisorDebounce,
      holdPendingConfirmation,
      incrementAppliedSpeechCorrections,
      invalidateAudioProcessingSession,
      isCurrentAudioSegment,
      promoteMeTurnForFusion,
      resolvePendingConfirmationForMeTurn,
      scheduleAdvisor,
      selectedSttProvider,
      sttProvider,
    ]
  );

  const enqueueSpeechDetected = useCallback(
    (base64Audio: string) => {
      if (!activeRef.current) return;

      const sessionId = audioSessionIdRef.current;
      const sequence = audioSegmentSeqRef.current + 1;
      audioSegmentSeqRef.current = sequence;
      const queuedAt = Date.now();

      const trace = traceStoreRef.current.startTrace("voice", {
        audioBase64Chars: base64Audio.length,
        audioSegmentSeq: sequence,
        audioSessionId: sessionId,
        speaker: "them",
        source: "system-audio",
      });
      const queueStepId = traceStoreRef.current.startStep(
        trace.id,
        "System audio speech queued",
        {
          audioSegmentSeq: sequence,
          audioSessionId: sessionId,
          speaker: "them",
          source: "system-audio",
        }
      );
      const segment: QueuedSpeechSegment = {
        base64Audio,
        audioBase64Chars: base64Audio.length,
        sessionId,
        sequence,
        queuedAt,
        speaker: "them",
        source: "system-audio",
        traceId: trace.id,
        queueStepId,
      };

      systemAudioQueueTailRef.current = systemAudioQueueTailRef.current
        .catch(() => undefined)
        .then(() => processQueuedSpeechSegment(segment))
        .catch((error) => {
          console.warn("Failed to process queued system audio segment", error);
        });
    },
    [processQueuedSpeechSegment]
  );

  const enqueueMicrophoneSpeech = useCallback(
    (audioBlob: Blob, startedAt: number, endedAt: number) => {
      if (!activeRef.current || !microphoneContextEnabledRef.current) return;

      const sessionId = audioSessionIdRef.current;
      const sequence = audioSegmentSeqRef.current + 1;
      audioSegmentSeqRef.current = sequence;
      const queuedAt = Date.now();

      const trace = traceStoreRef.current.startTrace("voice", {
        audioBytes: audioBlob.size,
        audioType: audioBlob.type,
        audioSegmentSeq: sequence,
        audioSessionId: sessionId,
        speaker: "me",
        source: "microphone",
      });
      const queueStepId = traceStoreRef.current.startStep(
        trace.id,
        "Microphone speech queued",
        {
          audioSegmentSeq: sequence,
          audioSessionId: sessionId,
          speaker: "me",
          source: "microphone",
          startedAt,
          endedAt,
        }
      );
      const segment: QueuedSpeechSegment = {
        audioBlob,
        audioBase64Chars: 0,
        audioBytes: audioBlob.size,
        audioType: audioBlob.type,
        sessionId,
        sequence,
        queuedAt,
        startedAt,
        endedAt,
        speaker: "me",
        source: "microphone",
        traceId: trace.id,
        queueStepId,
      };

      microphoneAudioQueueTailRef.current = microphoneAudioQueueTailRef.current
        .catch(() => undefined)
        .then(() => processQueuedSpeechSegment(segment))
        .catch((error) => {
          console.warn("Failed to process queued microphone segment", error);
        });
    },
    [processQueuedSpeechSegment]
  );

  const microphoneAudioConstraints = useMemo<MediaTrackConstraints>(() => {
    const inputDeviceId = selectedAudioDevices.input.id;
    return inputDeviceId && inputDeviceId !== "default"
      ? { deviceId: { exact: inputDeviceId } }
      : {};
  }, [selectedAudioDevices.input.id]);

  const microphoneVad = useMicVAD({
    userSpeakingThreshold: 0.6,
    startOnLoad: false,
    additionalAudioConstraints: microphoneAudioConstraints,
    onSpeechEnd: (audio) => {
      if (!activeRef.current || !microphoneContextEnabledRef.current) return;

      const endedAt = Date.now();
      const durationMs = Math.round((audio.length / 16_000) * 1000);
      const startedAt = endedAt - durationMs;
      const audioBlob = floatArrayToWav(audio, 16_000, "wav");
      enqueueMicrophoneSpeech(audioBlob, startedAt, endedAt);
    },
  });

  useEffect(() => {
    speechDetectedHandlerRef.current = (base64Audio: string) => {
      enqueueSpeechDetected(base64Audio);
    };
  }, [enqueueSpeechDetected]);

  useEffect(() => {
    microphoneContextEnabledRef.current =
      state.settings.microphoneContextEnabled;
  }, [state.settings.microphoneContextEnabled]);

  useEffect(() => {
    const shouldListen =
      activeRef.current &&
      state.settings.microphoneContextEnabled &&
      (state.status === "listening" ||
        state.status === "transcribing" ||
        state.status === "thinking");

    if (shouldListen) {
      if (!microphoneVad.listening) {
        microphoneVad.start();
      }
      return;
    }

    if (microphoneVad.listening) {
      microphoneVad.pause();
    }
  }, [
    microphoneVad.listening,
    microphoneVad.pause,
    microphoneVad.start,
    state.settings.microphoneContextEnabled,
    state.status,
  ]);

  const startCapture = useCallback(async (resetContext: boolean) => {
    if (state.settings.privacyMode === "memory-only") {
      activeRef.current = false;
      invalidateAudioProcessingSession();
      clearAdvisorDebounce();
      advisorEngineRef.current.cancelCurrentRequest();
      screenAnalysisAbortRef.current?.abort();
      screenAnalysisAbortRef.current = null;
      setState((previous) => ({
        ...previous,
        status: "error",
        partialSuggestion: "",
        error: LOCAL_ONLY_UNAVAILABLE_MESSAGE,
      }));
      return;
    }

    if (!sttProvider) {
      activeRef.current = false;
      invalidateAudioProcessingSession();
      clearAdvisorDebounce();
      advisorEngineRef.current.cancelCurrentRequest();
      screenAnalysisAbortRef.current?.abort();
      screenAnalysisAbortRef.current = null;
      setState((previous) => ({
        ...previous,
        status: "error",
        partialSuggestion: "",
        error: MISSING_STT_MESSAGE,
      }));
      return;
    }

    setState((previous) => ({
      ...previous,
      status: "starting",
      partialSuggestion: "",
      error: null,
    }));

    try {
      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (!hasAccess) {
        setState((previous) => ({
          ...previous,
          status: "error",
          error: "System audio permission is required for meeting assistant.",
        }));
        return;
      }

      const resetBoundary = resetContext
        ? resetMeetingRuntimeForNewSession("meeting-assistant-started")
        : undefined;
      if (resetBoundary) {
        sessionRecordingManagerRef.current?.recordRuntimeBoundary(
          "runtime-reset",
          resetBoundary
        );
      }

      clearAdvisorDebounce();
      advisorEngineRef.current.cancelCurrentRequest();
      activeRef.current = false;
      invalidateAudioProcessingSession();

      await invoke<MeetingAudioStatus>("stop_meeting_audio_session");

      const deviceId =
        selectedAudioDevices.output.id &&
        selectedAudioDevices.output.id !== "default"
          ? selectedAudioDevices.output.id
          : null;

      startAudioProcessingSession();
      activeRef.current = true;

      const audioStatus = await invoke<MeetingAudioStatus>(
        "start_meeting_audio_session",
        {
          vadConfig: state.settings.audio.config,
          deviceId,
        }
      );

      const contextState = contextManagerRef.current.getState();

      setState((previous) => ({
        ...previous,
        status: "listening",
        transcriptTurns: contextState.transcriptTurns,
        screenObservations: contextState.screenObservations,
        interviewSessionBrief: contextState.interviewSessionBrief,
        interviewSessionContext: contextState.interviewSessionContext,
        activeScreenTask: contextState.activeScreenTask,
        activeInterviewTask: contextState.activeInterviewTask,
        activeMeetingTask: contextState.activeMeetingTask,
        latestSuggestion: resetContext ? null : previous.latestSuggestion,
        latestReliableSuggestion: resetContext
          ? null
          : previous.latestReliableSuggestion,
        lastMemoryContext: resetContext ? undefined : previous.lastMemoryContext,
        speechCorrections: resetContext ? [] : previous.speechCorrections,
        partialSuggestion: "",
        error: null,
        audioStatus,
      }));
    } catch (error) {
      activeRef.current = false;
      invalidateAudioProcessingSession();
      setState((previous) => ({
        ...previous,
        status: "error",
        error:
          error instanceof Error
            ? error.message
            : "Failed to start meeting assistant.",
      }));
    }
  }, [
    clearAdvisorDebounce,
    invalidateAudioProcessingSession,
    selectedAudioDevices.output.id,
    startAudioProcessingSession,
    resetMeetingRuntimeForNewSession,
    state.settings.audio.config,
    state.settings.privacyMode,
    sttProvider,
  ]);

  const start = useCallback(async () => {
    await startCapture(true);
  }, [startCapture]);

  const resume = useCallback(async () => {
    await startCapture(false);
  }, [startCapture]);

  const pause = useCallback(async () => {
    activeRef.current = false;
    invalidateAudioProcessingSession();
    clearAdvisorDebounce();
    advisorEngineRef.current.cancelCurrentRequest();
    screenAnalysisAbortRef.current?.abort();
    screenAnalysisAbortRef.current = null;

    let audioStatus: MeetingAudioStatus | null = null;

    try {
      audioStatus = await invoke<MeetingAudioStatus>(
        "stop_meeting_audio_session"
      );
    } catch (error) {
      console.warn("Failed to pause meeting audio capture", error);
    }

    setState((previous) => ({
      ...previous,
      status: "paused",
      partialSuggestion: "",
      error: null,
      audioStatus,
    }));
  }, [clearAdvisorDebounce, invalidateAudioProcessingSession]);

  const captureScreenContext = useCallback(
    async (
      source: ScreenObservation["source"] = "full-screen",
      options: CaptureScreenContextOptions = {}
    ) => {
      if (screenCaptureInFlightRef.current) {
        return;
      }

      screenCaptureInFlightRef.current = true;
      const trace = traceStoreRef.current.startTrace(
        "screen",
        {
          source,
          privacyMode: state.settings.privacyMode,
          screenContextEnabled: state.settings.screenContextEnabled,
        },
        options.requestedAt
      );
      let analysisController: AbortController | null = null;
      const returnStatus = state.status;
      const idleReturnStatus = returnStatus === "paused" ? "paused" : "idle";
      let captureStepId: string | undefined;
      let preflightStepId: string | undefined;
      let modelStepId: string | undefined;

      try {
        if (
          !state.settings.screenContextEnabled ||
          state.settings.privacyMode !== "text-and-screen-to-cloud"
        ) {
          setState((previous) => ({
            ...previous,
            error: SCREEN_CONTEXT_DISABLED_MESSAGE,
          }));
          traceStoreRef.current.finishTrace(
            trace.id,
            "error",
            SCREEN_CONTEXT_DISABLED_MESSAGE
          );
          return;
        }

        captureStepId = traceStoreRef.current.startStep(
          trace.id,
          "Screen capture command",
          { target: "active-window" }
        );
        const observation = await captureScreenObservation({
          source,
          previousHash: latestScreenHashRef.current,
        });
        traceStoreRef.current.finishStep(trace.id, captureStepId, "success", {
          changed: observation.changed,
          hash: observation.hash,
          imageChars: observation.imageBase64?.length ?? 0,
          imageMediaType: observation.imageMediaType,
          focusImageChars: observation.focusImageBase64?.length ?? 0,
          focusImageMediaType: observation.focusImageMediaType,
          captureTarget: observation.captureTarget,
        });
        sessionRecordingManagerRef.current?.recordScreenCapture(
          observation,
          trace.id
        );
        options.onCaptured?.();

        latestScreenHashRef.current = observation.hash;
        traceStoreRef.current.recordOutput(
          trace.id,
          "capture metadata",
          formatTraceMetadata({
            observationId: observation.id,
            changed: observation.changed,
            hash: observation.hash,
            captureTarget: observation.captureTarget,
            imageBase64Chars: observation.imageBase64?.length ?? 0,
            imageMediaType: observation.imageMediaType,
            focusImageBase64Chars: observation.focusImageBase64?.length ?? 0,
            focusImageMediaType: observation.focusImageMediaType,
          })
        );

        contextManagerRef.current.addScreenObservation(observation);
        const contextState = contextManagerRef.current.getState();

        setState((previous) => ({
          ...previous,
          status: "thinking",
          screenObservations: contextState.screenObservations,
          partialSuggestion: "",
          error: null,
        }));

        if (!aiProvider) {
          traceStoreRef.current.finishTrace(trace.id, "error", MISSING_AI_MESSAGE);
          setState((previous) => ({
            ...previous,
            status: activeRef.current ? "listening" : idleReturnStatus,
            error: MISSING_AI_MESSAGE,
          }));
          return;
        }

        if (!aiProvider.curl.includes("{{IMAGE}}")) {
          traceStoreRef.current.finishTrace(
            trace.id,
            "error",
            MISSING_VISION_MESSAGE
          );
          setState((previous) => ({
            ...previous,
            status: activeRef.current ? "listening" : idleReturnStatus,
            error: MISSING_VISION_MESSAGE,
          }));
          return;
        }

        screenAnalysisAbortRef.current?.abort();
        analysisController = new AbortController();
        screenAnalysisAbortRef.current = analysisController;

        const autoPrompt = getMeetingScreenAutoPrompt(screenshotConfiguration);
        const analysisContextState = contextManagerRef.current.getState();
        const recentTranscript = formatRecentTranscript(
          analysisContextState.transcriptTurns
        );
        let screenPreflight: ScreenPreflightResult | undefined;
        const shouldRunScreenPreflight = state.settings.screenContextEnabled;
        traceStoreRef.current.updateMetadata(trace.id, {
          screenPreflightEnabled: shouldRunScreenPreflight,
          memoryRetrievalEnabled: state.settings.useMemory,
          memoryRetrievalSkippedReason: state.settings.useMemory
            ? undefined
            : "use-memory-disabled",
        });

        if (shouldRunScreenPreflight) {
          try {
            screenPreflight = await withTimeout(
              preflightScreenObservation({
                observation,
                provider: aiProvider,
                selectedProvider: selectedAIProvider,
                recentTranscript,
                signal: analysisController.signal,
                trace: {
                  onRequest: (input) => {
                    traceStoreRef.current.recordInput(
                      trace.id,
                      "screen preflight input",
                      formatTraceModelInput(
                        input.systemPrompt,
                        input.userMessage
                      ),
                      {
                        providerId: input.providerId,
                        mode: input.mode,
                        imageCount: input.imageCount,
                        imageMediaType: input.imageMediaType,
                        imageBase64Stored: false,
                      }
                    );
                    sessionRecordingManagerRef.current?.recordModelInput({
                      traceId: trace.id,
                      label: "screen preflight input",
                      value: formatTraceModelInput(
                        input.systemPrompt,
                        input.userMessage
                      ),
                      metadata: {
                        providerId: input.providerId,
                        mode: input.mode,
                        imageCount: input.imageCount,
                        imageMediaType: input.imageMediaType,
                        imageBase64Stored: false,
                      },
                    });
                    preflightStepId = traceStoreRef.current.startStep(
                      trace.id,
                      "Screen preflight",
                      {
                        providerId: input.providerId,
                        imageCount: input.imageCount,
                        imageMediaType: input.imageMediaType,
                      }
                    );
                  },
                  onFirstToken: () => {
                    traceStoreRef.current.updateMetadata(trace.id, {
                      screenPreflightFirstTokenAt: Date.now(),
                    });
                  },
                  onComplete: (output) => {
                    traceStoreRef.current.recordOutput(
                      trace.id,
                      "screen preflight raw output",
                      output
                    );
                    sessionRecordingManagerRef.current?.recordModelOutput({
                      traceId: trace.id,
                      label: "screen preflight raw output",
                      value: output,
                    });
                  },
                },
              }),
              SCREEN_PREFLIGHT_TIMEOUT_MS,
              "Screen preflight timed out."
            );
            const preflightContextUpdate =
              contextManagerRef.current.updateInterviewSessionContextFromScreenText(
                [
                  screenPreflight.targetCompany
                    ? `${screenPreflight.targetCompany} interview`
                    : undefined,
                  screenPreflight.question,
                ]
                  .filter(Boolean)
                  .join("\n"),
                [
                  screenPreflight.targetCompany,
                  screenPreflight.question,
                ]
                  .filter(Boolean)
                  .join(" - ")
              );
            const targetCompany =
              preflightContextUpdate?.targetCompany ??
              contextManagerRef.current.getState().interviewSessionContext
                ?.targetCompany;

            traceStoreRef.current.finishStep(
              trace.id,
              preflightStepId,
              "success",
              {
                questionChars: screenPreflight.question?.length ?? 0,
                targetCompany: screenPreflight.targetCompany,
                ...formatQuestionTypeTraceMetadata(
                  screenPreflight.questionType,
                  screenPreflight.rawQuestionType
                ),
                askFrame: screenPreflight.askFrame,
                topicDomain: screenPreflight.topicDomain,
                projectAnchor: screenPreflight.projectAnchor,
                classifierConfidence: screenPreflight.confidence,
                behavioral: screenPreflight.isBehavioralInterview,
                amazonLeadershipPrinciple:
                  screenPreflight.amazonLeadershipPrinciple,
                contextUpdated: Boolean(preflightContextUpdate?.changed),
              }
            );
            traceStoreRef.current.updateMetadata(trace.id, {
              ...formatQuestionTypeTraceMetadata(
                screenPreflight.questionType,
                screenPreflight.rawQuestionType
              ),
              askFrame: screenPreflight.askFrame,
              topicDomain: screenPreflight.topicDomain,
              projectAnchor: screenPreflight.projectAnchor,
              classifierConfidence: screenPreflight.confidence,
            });

            if (preflightContextUpdate?.changed) {
              const interviewStepId = traceStoreRef.current.startStep(
                trace.id,
                "Interview session context updated",
                {
                  targetCompany: targetCompany?.value,
                  confidence: targetCompany?.confidence,
                  source: targetCompany?.source,
                }
              );
              traceStoreRef.current.finishStep(
                trace.id,
                interviewStepId,
                "success",
                {
                  evidenceChars: targetCompany?.evidence.length ?? 0,
                }
              );
              traceStoreRef.current.updateMetadata(trace.id, {
                targetCompany: targetCompany?.value,
                targetCompanyConfidence: targetCompany?.confidence,
                ...formatQuestionTypeTraceMetadata(
                  screenPreflight.questionType,
                  screenPreflight.rawQuestionType
                ),
                askFrame: screenPreflight.askFrame,
                topicDomain: screenPreflight.topicDomain,
                projectAnchor: screenPreflight.projectAnchor,
                classifierConfidence: screenPreflight.confidence,
              });
              setState((previous) => ({
                ...previous,
                interviewSessionContext:
                  contextManagerRef.current.getState().interviewSessionContext,
              }));
            }
          } catch (error) {
            traceStoreRef.current.finishStep(
              trace.id,
              preflightStepId,
              "error",
              undefined,
              error
            );
            console.warn("Screen preflight failed; continuing without it", error);
          }
        }

        const preflightContextState = contextManagerRef.current.getState();
        const screenMemoryQuery = buildScreenMemoryQuery({
          observation,
          autoPrompt,
          interviewSessionBrief: preflightContextState.interviewSessionBrief,
          interviewSessionContext: preflightContextState.interviewSessionContext,
          screenPreflight,
        });
        const screenMemoryQuestionType =
          inferMemoryQuestionTypeFromScreenPreflight(
            screenMemoryQuery,
            screenPreflight
          );
        const screenMemoryAskFrame = inferMemoryAskFrameFromScreenPreflight(
          screenMemoryQuery,
          screenPreflight
        );
        const screenMemoryTopicDomain =
          inferMemoryTopicDomainFromScreenPreflight(
            screenMemoryQuery,
            screenPreflight
          );
        const screenPlaybook = selectInterviewPlaybook({
          query: screenMemoryQuery,
          questionType: screenPreflight?.questionType ?? screenMemoryQuestionType,
          askFrame: screenPreflight?.askFrame ?? screenMemoryAskFrame,
          topicDomain: screenPreflight?.topicDomain ?? screenMemoryTopicDomain,
          projectAnchor: screenPreflight?.projectAnchor,
          classifierConfidence: screenPreflight?.confidence,
          interviewSessionBrief: preflightContextState.interviewSessionBrief,
          interviewSessionContext: preflightContextState.interviewSessionContext,
        });
        const screenPhaseDecision = decidePlaybookPhaseProgression({
          questionType: screenPreflight?.questionType ?? screenMemoryQuestionType,
          playbookId: screenPlaybook?.id,
          currentPhase:
            preflightContextState.activeMeetingTask?.parent.playbookPhase ??
            preflightContextState.activeInterviewTask?.playbookPhase ??
            screenPlaybook?.phase,
          phaseProgress:
            preflightContextState.activeMeetingTask?.parent.phaseProgress ??
            preflightContextState.activeInterviewTask?.phaseProgress,
          latestTurnText: recentTranscript,
          currentQuestion: screenPreflight?.question ?? screenMemoryQuery,
          relation:
            preflightContextState.activeMeetingTask &&
            areCompatibleQuestionTypes(
              preflightContextState.activeMeetingTask.parent.questionType,
              screenPreflight?.questionType ?? screenMemoryQuestionType
            )
              ? "resume-parent"
              : "new-parent",
          askFrame: screenPreflight?.askFrame ?? screenMemoryAskFrame,
        });
        const screenPlaybookMetadata =
          formatInterviewPlaybookForTrace(screenPlaybook);
        traceStoreRef.current.updateMetadata(trace.id, {
          ...screenPlaybookMetadata,
          ...formatPlaybookPhaseDecisionForTrace(screenPhaseDecision),
        });
        if (screenPlaybook) {
          const playbookStepId = traceStoreRef.current.startStep(
            trace.id,
            "Interview playbook selected",
            {
              ...screenPlaybookMetadata,
              ...formatPlaybookPhaseDecisionForTrace(screenPhaseDecision),
            }
          );
          traceStoreRef.current.finishStep(trace.id, playbookStepId, "success");
        }
        sessionRecordingManagerRef.current?.recordPlaybookSelection(
          trace.id,
          {
            ...screenPlaybookMetadata,
            ...formatPlaybookPhaseDecisionForTrace(screenPhaseDecision),
          }
        );

        const memoryContext = await loadMemoryForPrompt({
          traceId: trace.id,
          source: "screen",
          query: screenMemoryQuery,
          useCase: inferMemoryUseCaseFromQuery(screenMemoryQuery),
          questionType: screenMemoryQuestionType,
          askFrame: screenMemoryAskFrame,
          topicDomain: screenMemoryTopicDomain,
          projectAnchor: screenPreflight?.projectAnchor,
          memoryPolicy: screenPlaybook?.memoryPolicy,
        });
        const screenFactAnchorDecision = buildFactAnchorDecision({
          questionType: screenMemoryQuestionType,
          memoryContext,
          activeFactAnchors: [],
          projectAnchor: screenPreflight?.projectAnchor,
        });
        const factAnchorMetadata = {
          source: "screen",
          questionType: screenMemoryQuestionType,
          ...formatFactAnchorDecisionForTrace(screenFactAnchorDecision),
        };
        traceStoreRef.current.updateMetadata(trace.id, factAnchorMetadata);
        const factAnchorStepId = traceStoreRef.current.startStep(
          trace.id,
          "Fact anchor guardrail",
          factAnchorMetadata
        );
        traceStoreRef.current.finishStep(
          trace.id,
          factAnchorStepId,
          "success"
        );
        sessionRecordingManagerRef.current?.recordFactAnchorDecision(
          trace.id,
          factAnchorMetadata
        );
        const screenUsesCodingModel =
          (screenPreflight?.questionType ?? screenMemoryQuestionType) ===
            "coding" || screenPlaybook?.id === "coding_algorithm";
        const screenModelRoute = resolveMeetingModelRoute({
          useCodingModel: screenUsesCodingModel,
          requiresVision: true,
          reason: screenUsesCodingModel ? "screen-coding-task" : "screen-main",
        });
        const screenModelRouteMetadata =
          formatMeetingModelRouteForTrace(screenModelRoute);
        const screenModelRequestOptions =
          getMeetingModelRequestOptions(screenModelRoute);
        traceStoreRef.current.updateMetadata(
          trace.id,
          {
            ...screenModelRouteMetadata,
            modelRequestOptions: screenModelRequestOptions,
          }
        );
        const screenTaskContent = await withTimeout(
          solveScreenAnchoredTask({
            observation,
            provider: screenModelRoute.provider,
            selectedProvider: screenModelRoute.selectedProvider,
            recentTranscript,
            autoPrompt,
            responseConfig: state.settings.response,
            memoryContext: memoryContext?.contextText,
            interviewSessionBrief: preflightContextState.interviewSessionBrief,
            interviewSessionContext:
              preflightContextState.interviewSessionContext,
            screenPreflight,
            interviewPlaybook: screenPlaybook,
            playbookPhaseDecision: screenPhaseDecision,
            factAnchorDecision: screenFactAnchorDecision,
            signal: analysisController.signal,
            requestOptions: screenModelRequestOptions,
            trace: {
              onRequest: (input) => {
                traceStoreRef.current.recordInput(
                  trace.id,
                  "screen model input",
                  formatTraceModelInput(input.systemPrompt, input.userMessage),
                  {
                    providerId: input.providerId,
                    mode: input.mode,
                    imageCount: input.imageCount,
                    imageMediaType: input.imageMediaType,
                    responseConfig: input.responseConfig,
                    requestOptions: input.requestOptions,
                    ...screenModelRouteMetadata,
                    imageBase64Stored: false,
                  }
                );
                sessionRecordingManagerRef.current?.recordModelInput({
                  traceId: trace.id,
                  label: "screen model input",
                  value: formatTraceModelInput(
                    input.systemPrompt,
                    input.userMessage
                  ),
                  metadata: {
                    providerId: input.providerId,
                    mode: input.mode,
                    imageCount: input.imageCount,
                    imageMediaType: input.imageMediaType,
                    responseConfig: input.responseConfig,
                    requestOptions: input.requestOptions,
                    ...screenModelRouteMetadata,
                    imageBase64Stored: false,
                  },
                });
                modelStepId = traceStoreRef.current.startStep(
                  trace.id,
                  "Screen model response",
                  {
                    providerId: input.providerId,
                    promptChars:
                      input.systemPrompt.length + input.userMessage.length,
                    imageCount: input.imageCount,
                    imageMediaType: input.imageMediaType,
                    responseLength: input.responseConfig?.length,
                    responseLanguage: input.responseConfig?.language,
                    requestOptions: input.requestOptions,
                    ...screenModelRouteMetadata,
                  }
                );
              },
              onFirstToken: () => {
                traceStoreRef.current.updateMetadata(trace.id, {
                  screenFirstTokenAt: Date.now(),
                });
              },
              onComplete: (output) => {
                traceStoreRef.current.recordOutput(
                  trace.id,
                  "screen model raw output",
                  output
                );
                sessionRecordingManagerRef.current?.recordModelOutput({
                  traceId: trace.id,
                  label: "screen model raw output",
                  value: output,
                  metadata: {
                    ...screenModelRouteMetadata,
                    requestOptions: screenModelRequestOptions,
                  },
                });
              },
            },
            onPartialContent: (partialContent) => {
              if (screenAnalysisAbortRef.current !== analysisController) {
                return;
              }

              setState((previous) => ({
                ...previous,
                status: "thinking",
                partialSuggestion: partialContent,
              }));
            },
          }),
          screenModelRequestOptions?.timeoutMs ?? SCREEN_ANALYSIS_TIMEOUT_MS,
          "Screen context analysis timed out."
        );

        if (screenAnalysisAbortRef.current !== analysisController) {
          traceStoreRef.current.finishStep(
            trace.id,
            modelStepId,
            "cancelled"
          );
          traceStoreRef.current.finishTrace(trace.id, "cancelled");
          return;
        }

        traceStoreRef.current.finishStep(trace.id, modelStepId, "success", {
          outputChars: screenTaskContent.length,
          ...screenModelRouteMetadata,
        });
        screenAnalysisAbortRef.current = null;

        contextManagerRef.current.updateScreenObservation(observation.id, {
          visualSummary: screenTaskContent,
          analysisPromptSource: autoPrompt
            ? "screenshot-auto-prompt"
            : "meeting-default",
        });

        let updatedContextState = contextManagerRef.current.getState();
        const basedOnTurnIds = updatedContextState.transcriptTurns
          .slice(-6)
          .map((turn) => turn.id);
        const requestId = createMeetingId("screen_task");
        const question = extractScreenTaskQuestion(screenTaskContent);
        const rawTaskKind =
          screenPreflight?.questionType &&
          screenPreflight.questionType !== "unknown"
            ? screenPreflight.questionType
            : inferScreenTaskKind(screenTaskContent);
        const taskKind = normalizeScreenQuestionType(rawTaskKind) ?? "unknown";
        traceStoreRef.current.updateMetadata(
          trace.id,
          formatQuestionTypeTraceMetadata(
            taskKind,
            screenPreflight?.rawQuestionType
          )
        );
        const now = Date.now();
        let screenStartedNewInterviewParent = false;

        if (screenTaskContent.trim() && taskKind !== "non-question") {
          const existingInterviewTask = updatedContextState.activeInterviewTask;
          const activeScreenTask: ActiveScreenTask = {
            id: requestId,
            observationId: observation.id,
            createdAt: now,
            updatedAt: now,
            expiresAt: getActiveScreenTaskExpiresAt(state.settings, now),
            question: question || undefined,
            kind: taskKind,
            language: inferScreenTaskLanguage(screenTaskContent),
            classifier: {
              questionType: taskKind,
              askFrame: screenPreflight?.askFrame,
              topicDomain: screenPreflight?.topicDomain,
              projectAnchor: screenPreflight?.projectAnchor,
              confidence: screenPreflight?.confidence,
            },
            playbook: screenPlaybook,
            content: screenTaskContent,
            basedOnTurnIds,
            basedOnObservationId: observation.id,
          };

          const screenRelationDecision = decideScreenTaskRelation({
            existingTask: existingInterviewTask,
            taskKind,
            question: question || undefined,
            screenContent: screenTaskContent,
            screenPreflight,
            corrections: speechCorrectionsRef.current,
          });
          traceStoreRef.current.updateMetadata(trace.id, {
            screenTaskRelation: screenRelationDecision.relation,
            screenTaskRelationReason: screenRelationDecision.reason,
            screenTaskRelationConfidence: screenRelationDecision.confidence,
          });
          const screenRelationStepId = traceStoreRef.current.startStep(
            trace.id,
            "Screen task relation decided",
            screenRelationDecision
          );
          traceStoreRef.current.finishStep(
            trace.id,
            screenRelationStepId,
            "success"
          );

          const screenContinuity = updateInterviewTaskContinuityForAnswer({
            existingTask: existingInterviewTask,
            source: "screen",
            questionType: taskKind,
            relation: screenRelationDecision.relation,
            subtaskIntent: inferAdvisorSubtaskIntent(
              question || screenTaskContent,
              readMemoryQuestionType(taskKind) ?? "unknown"
            ),
            question: question || undefined,
            finalContent: screenTaskContent,
            playbook: screenPlaybook,
            phaseDecision: screenPhaseDecision,
            observationId: observation.id,
            expiresAt: getActiveScreenTaskExpiresAt(state.settings, now),
            supportedFactAnchors:
              mergeSupportedFactAnchors(
                screenPreflight?.projectAnchor
                  ? [screenPreflight.projectAnchor]
                  : undefined,
                extractSupportedFactAnchorsFromMemory(memoryContext)
              ),
          });
          contextManagerRef.current.setActiveMeetingTaskState({
            activeScreenTask,
            activeInterviewTask: screenContinuity.task ?? null,
          });
          screenStartedNewInterviewParent = screenContinuity.startedNewParent;
          traceStoreRef.current.updateMetadata(trace.id, {
            activeInterviewParentId: screenContinuity.task?.id,
            activeInterviewParentKind: screenContinuity.task?.stableKind,
            activeInterviewParentPhase: screenContinuity.task?.playbookPhase,
            startedNewInterviewParent: screenContinuity.startedNewParent,
          });
        } else {
          contextManagerRef.current.clearActiveMeetingTask();
        }

        updatedContextState = contextManagerRef.current.getState();
        traceStoreRef.current.updateMetadata(trace.id, {
          ...getActiveMeetingTaskTraceMetadata(
            updatedContextState.activeMeetingTask
          ),
        });
        if (updatedContextState.activeScreenTask) {
          sessionRecordingManagerRef.current?.recordTaskSnapshot(
            updatedContextState.activeScreenTask,
            trace.id
          );
        }
        if (updatedContextState.activeMeetingTask) {
          sessionRecordingManagerRef.current?.recordActiveMeetingTaskSnapshot(
            updatedContextState.activeMeetingTask,
            trace.id
          );
        }
        const uiStepId = traceStoreRef.current.startStep(
          trace.id,
          "Meeting Assistant state updated",
          {
            activeMeetingTaskId: updatedContextState.activeMeetingTask?.id,
            activeMeetingTaskSource: updatedContextState.activeMeetingTask?.source,
            activeScreenTaskId: updatedContextState.activeScreenTask?.id,
            suggestionKind: screenTaskContent.trim() ? "screen-task" : "silent",
          }
        );

        const nextSuggestion: AdvisorSuggestion = screenTaskContent.trim()
          ? {
              id: requestId,
              kind: "screen-task",
              content: screenTaskContent.trim(),
              screenTaskAnswer: parseScreenTaskAnswer(screenTaskContent.trim()),
              createdAt: Date.now(),
              basedOnTurnIds,
              basedOnObservationIds: [observation.id],
              confidence: "medium",
            }
          : {
              id: requestId,
              kind: "silent",
              content: "",
              createdAt: Date.now(),
              basedOnTurnIds,
              basedOnObservationIds: [observation.id],
              confidence: "low",
            };

        setState((previous) => ({
          ...previous,
          ...withLatestReliableSuggestion(previous, nextSuggestion, {
            clearPrevious: screenStartedNewInterviewParent,
          }),
          status: activeRef.current ? "listening" : idleReturnStatus,
          partialSuggestion: "",
          screenObservations: updatedContextState.screenObservations,
          activeScreenTask: updatedContextState.activeScreenTask,
          activeInterviewTask: updatedContextState.activeInterviewTask,
          activeMeetingTask: updatedContextState.activeMeetingTask,
          interviewSessionContext: updatedContextState.interviewSessionContext,
          error: null,
        }));
        traceStoreRef.current.finishStep(trace.id, uiStepId, "success");
        traceStoreRef.current.finishTrace(trace.id, "success");
      } catch (error) {
        analysisController?.abort();
        if (screenAnalysisAbortRef.current === analysisController) {
          screenAnalysisAbortRef.current = null;
        }

        if (error instanceof Error && error.name === "AbortError") {
          traceStoreRef.current.finishStep(
            trace.id,
            modelStepId,
            "cancelled",
            undefined,
            error
          );
          traceStoreRef.current.finishTrace(trace.id, "cancelled", error);
          return;
        }

        traceStoreRef.current.finishStep(
          trace.id,
          captureStepId,
          "error",
          undefined,
          error
        );
        traceStoreRef.current.finishStep(
          trace.id,
          modelStepId,
          "error",
          undefined,
          error
        );
        traceStoreRef.current.finishTrace(trace.id, "error", error);

        setState((previous) => ({
          ...previous,
          status: activeRef.current ? "listening" : "error",
          error:
            error instanceof Error
              ? error.message
              : "Failed to capture screen context.",
        }));
      } finally {
        screenCaptureInFlightRef.current = false;
      }
    },
    [
      aiProvider,
      loadMemoryForPrompt,
      resolveMeetingModelRoute,
      selectedAIProvider,
      screenshotConfiguration,
      state.settings,
      state.status,
    ]
  );

  const currentSuggestionText =
    state.partialSuggestion || state.latestSuggestion?.content || "";

  useEffect(() => {
    const pending = pendingInterviewTypeOverrideRef.current;
    if (!pending) return;

    const activeMeetingTask = state.activeMeetingTask;
    const pendingScreenTaskId =
      activeMeetingTask?.screen?.activeScreenTaskId ?? state.activeScreenTask?.id;
    const pendingQuestionType =
      activeMeetingTask?.parent.questionType ?? state.activeScreenTask?.kind;

    if (!activeMeetingTask && !state.activeScreenTask) {
      pendingInterviewTypeOverrideRef.current = null;
      traceStoreRef.current.finishTrace(
        pending.traceId,
        "cancelled",
        "Active task was cleared before regeneration."
      );
      return;
    }

    if (
      pendingScreenTaskId !== pending.taskId ||
      normalizeScreenTaskKindForOverrideComparison(pendingQuestionType) !==
        normalizeScreenTaskKindForOverrideComparison(pending.correctedKind)
    ) {
      return;
    }

    pendingInterviewTypeOverrideRef.current = null;
    void runAdvisor({
      force: true,
      mode: "screen-anchored",
      traceId: pending.traceId,
    });
  }, [runAdvisor, state.activeMeetingTask, state.activeScreenTask]);

  const regenerateSuggestion = useCallback(async () => {
    await runAdvisor({
      force: true,
      mode: "regenerate",
      currentSuggestion: currentSuggestionText,
    });
  }, [currentSuggestionText, runAdvisor]);

  const applyResponseAction = useCallback(
    async (responseAction: MeetingResponseActionMode) => {
      if (!currentSuggestionText.trim()) {
        setState((previous) => ({
          ...previous,
          error: NO_SUGGESTION_MESSAGE,
        }));
        return;
      }

      await runAdvisor({
        force: true,
        mode: "response-action",
        responseAction,
        currentSuggestion: currentSuggestionText,
      });
    },
    [currentSuggestionText, runAdvisor]
  );

  const answerClarifyingQuestion = useCallback(
    async (
      question: string,
      answer: ClarifyingQuestionAnswer,
      option?: { label?: string; value?: string }
    ) => {
      const trimmedQuestion = question.trim();
      if (!trimmedQuestion) return;

      const hasActiveScreenTask = Boolean(
        contextManagerRef.current.getState().activeMeetingTask?.screen
      );

      await runAdvisor({
        force: true,
        mode: hasActiveScreenTask ? "screen-anchored" : "clarifying-answer",
        currentSuggestion: currentSuggestionText,
        clarifyingFeedback: {
          question: trimmedQuestion,
          answer,
          answerLabel: option?.label,
          answerValue: option?.value,
        },
      });
    },
    [currentSuggestionText, runAdvisor]
  );

  const submitSpeechCorrection = useCallback(
    async (input: string) => {
      const correction = parseEmergencySpeechCorrection(input);
      if (!correction) {
        setState((previous) => ({
          ...previous,
          error: "Enter a short correction, for example: RAG not rec.",
        }));
        return;
      }

      const trace = traceStoreRef.current.startTrace("voice", {
        source: "emergency-correction",
        correctionInputChars: input.trim().length,
      });
      traceStoreRef.current.recordInput(
        trace.id,
        "emergency speech correction",
        correction.input,
        {
          from: correction.from,
          to: correction.to,
          term: correction.term,
        }
      );

      const nextCorrections = [
        ...speechCorrectionsRef.current.filter(
          (candidate) => candidate.input !== correction.input
        ),
        correction,
      ].slice(-12);

      const contextState = contextManagerRef.current.getState();
      const latestTurn =
        contextState.transcriptTurns[contextState.transcriptTurns.length - 1];
      const speechBias = buildSpeechBiasContext(contextState, nextCorrections);
      traceStoreRef.current.recordInput(
        trace.id,
        "speech bias context",
        formatSpeechBiasPromptForTrace(speechBias),
        {
          termCount: speechBias.terms.length,
          ruleCount: speechBias.correctionRules.length,
          promptChars: speechBias.prompt.length,
          terms: speechBias.terms.map((term) => term.term),
        }
      );

      let updatedCorrections = nextCorrections;
      let didUpdateTranscript = false;
      let nextContextState = contextState;

      if (latestTurn) {
        const normalized = normalizeTranscriptWithSpeechBias(
          latestTurn.text,
          speechBias
        );
        if (normalized.changed) {
          contextManagerRef.current.updateTranscriptTurnText(
            latestTurn.id,
            normalized.text
          );
          didUpdateTranscript = true;
          updatedCorrections = applySpeechCorrectionRuleCounts(
            nextCorrections,
            normalized.appliedRules
          );
          speechCorrectionsRef.current = updatedCorrections;
          nextContextState = contextManagerRef.current.getState();
          traceStoreRef.current.recordOutput(
            trace.id,
            "corrected latest transcript",
            normalized.text,
            {
              turnId: latestTurn.id,
              previousText: latestTurn.text,
              appliedRules: normalized.appliedRules.map(
                (rule) => `${rule.from}->${rule.to}`
              ),
            }
          );
        }
      }

      if (!didUpdateTranscript) {
        speechCorrectionsRef.current = updatedCorrections;
        traceStoreRef.current.recordOutput(
          trace.id,
          "correction stored",
          "Stored as speech bias for future audio segments.",
          {
            latestTurnId: latestTurn?.id,
          }
        );
      }

      const semanticRepairDecision = decideEmergencyCorrectionRepair({
        correction,
        contextState: nextContextState,
        latestTurnText: latestTurn?.text,
        currentSuggestion: currentSuggestionText,
      });
      traceStoreRef.current.updateMetadata(trace.id, {
        correctionRegenerationReason: semanticRepairDecision.reason,
        semanticCorrectionApplied: semanticRepairDecision.shouldRegenerate,
      });
      traceStoreRef.current.recordOutput(
        trace.id,
        "semantic correction decision",
        semanticRepairDecision.reason,
        {
          shouldRegenerate: semanticRepairDecision.shouldRegenerate,
          correctionTarget: correction.to ?? correction.term,
          activeMeetingTaskId: nextContextState.activeMeetingTask?.id,
          activeMeetingParentQuestionType:
            nextContextState.activeMeetingTask?.parent.questionType,
        }
      );

      let repairTraceId: string | undefined;
      if (didUpdateTranscript || semanticRepairDecision.shouldRegenerate) {
        const repairTrace = traceStoreRef.current.startTrace("voice", {
          source: "emergency-correction-repair",
          parentCorrectionTraceId: trace.id,
          correctionRegenerationReason: semanticRepairDecision.reason,
          semanticCorrectionApplied: semanticRepairDecision.shouldRegenerate,
          correctedLatestTranscript: didUpdateTranscript,
          activeMeetingTaskId: nextContextState.activeMeetingTask?.id,
          activeMeetingParentQuestionType:
            nextContextState.activeMeetingTask?.parent.questionType,
        });
        repairTraceId = repairTrace.id;
        traceStoreRef.current.recordInput(
          repairTrace.id,
          "emergency correction repair context",
          [
            `Correction: ${correction.input}`,
            `Target: ${correction.to ?? correction.term ?? "-"}`,
            `From: ${correction.from ?? "-"}`,
            `Reason: ${semanticRepairDecision.reason}`,
          ].join("\n"),
          {
            parentCorrectionTraceId: trace.id,
            correctionTarget: correction.to ?? correction.term,
            correctionSource: correction.from,
            correctedLatestTranscript: didUpdateTranscript,
          }
        );
        traceStoreRef.current.updateMetadata(trace.id, {
          repairTraceId,
        });
      }

      setState((previous) => ({
        ...previous,
        error: null,
        speechCorrections: updatedCorrections,
        transcriptTurns: nextContextState.transcriptTurns,
        interviewSessionContext: nextContextState.interviewSessionContext,
        activeScreenTask: nextContextState.activeScreenTask,
        activeInterviewTask: nextContextState.activeInterviewTask,
        activeMeetingTask: nextContextState.activeMeetingTask,
      }));

      traceStoreRef.current.finishTrace(trace.id, "success");

      if (didUpdateTranscript || semanticRepairDecision.shouldRegenerate) {
        await runAdvisor({
          force: true,
          mode: nextContextState.activeMeetingTask?.screen
            ? "screen-anchored"
            : "live",
          currentSuggestion: currentSuggestionText,
          traceId: repairTraceId,
        });
      }
    },
    [currentSuggestionText, runAdvisor]
  );

  useEffect(() => {
    let cancelled = false;

    const loadPersistedTraceMetrics = async () => {
      try {
        const payload = await invoke<string>("read_meeting_trace_metrics");
        if (cancelled) return;

        const traces = parseMeetingTraceMetrics(payload);
        lastTraceMetricsPayloadRef.current = traces.length
          ? serializeMeetingTraceMetrics(traces)
          : null;
        if (traces.length) {
          traceStoreRef.current.hydrate(traces);
        }
      } catch (error) {
        console.warn("Failed to load meeting trace metrics", error);
      } finally {
        if (!cancelled) {
          traceMetricsPersistenceReadyRef.current = true;
        }
      }
    };

    void loadPersistedTraceMetrics();

    return () => {
      cancelled = true;
      if (traceMetricsPersistTimerRef.current !== null) {
        window.clearTimeout(traceMetricsPersistTimerRef.current);
        traceMetricsPersistTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    traceStoreRef.current.subscribe((traces) => {
      setState((previous) => ({
        ...previous,
        traces,
      }));
      scheduleTraceMetricsPersistence();
      recordCompletedTracesForSession(traces);
      maybeAutoExportTraces(traces);
    });
  }, [
    maybeAutoExportTraces,
    recordCompletedTracesForSession,
    scheduleTraceMetricsPersistence,
  ]);

  useEffect(() => {
    debugModeRef.current = state.settings.debugMode;
    traceStoreRef.current.setDebugEnabled(state.settings.debugMode);
  }, [state.settings.debugMode]);

  useEffect(() => {
    let disposed = false;
    let unlistenSpeech: (() => void) | undefined;

    const setupListeners = async () => {
      const unlisten = await listen<string>("speech-detected", (event) => {
        speechDetectedHandlerRef.current?.(event.payload);
      });

      if (disposed) {
        unlisten();
        return;
      }

      unlistenSpeech = unlisten;
    };

    void setupListeners().catch((error) => {
      console.warn("Failed to setup meeting speech listener", error);
    });

    return () => {
      disposed = true;
      unlistenSpeech?.();
    };
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (contextManagerRef.current.clearExpiredActiveMeetingTask()) {
        const contextState = contextManagerRef.current.getState();
        setState((previous) => ({
          ...previous,
          activeScreenTask: contextState.activeScreenTask,
          activeInterviewTask: contextState.activeInterviewTask,
          activeMeetingTask: contextState.activeMeetingTask,
          latestSuggestion: contextState.activeMeetingTask
            ? previous.latestSuggestion
            : previous.latestSuggestion?.kind === "screen-task"
              ? null
              : previous.latestSuggestion,
          latestReliableSuggestion: contextState.activeMeetingTask
            ? previous.latestReliableSuggestion
            : null,
        }));
      }
    }, 60_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    return () => {
      clearAdvisorDebounce();
      if (activeRef.current) {
        void stop();
      } else {
        void sessionRecordingManagerRef.current?.stop("component-unmounted");
      }
    };
  }, [clearAdvisorDebounce, stop]);

  return {
    ...state,
    setupWarnings,
    setPrivacyMode,
    setScreenContextEnabled,
    setActiveScreenTaskTimeoutMinutes,
    setInterviewSessionBrief,
    clearInterviewSessionBrief,
    setUseMemory,
    setDebugMode,
    setMicrophoneContextEnabled,
    toggleMicrophoneContext,
    setSessionRecordingEnabled,
    setResponseConfig,
    setCodingModelConfig,
    setMeetingAudioProfile,
    setMeetingAudioConfig,
    start,
    pause,
    resume,
    stop,
    clearActiveScreenTask,
    clearTraces,
    captureScreenContext,
    exportTrace,
    updateTraceHumanEvaluation,
    updateQuestionHumanEvaluation,
    regenerateSuggestion,
    applyResponseAction,
    answerClarifyingQuestion,
    submitSpeechCorrection,
    aiProviders: allAiProviders,
    isActive: activeRef.current,
  };
}

function applySpeechCorrectionRuleCounts(
  corrections: SpeechCorrection[],
  rules: SpeechCorrectionRule[]
) {
  if (!rules.length) return corrections;

  return corrections.map((correction) => {
    const matched = rules.some((rule) => {
      if (rule.source !== "emergency" && correction.from) return false;
      if (correction.from && correction.to) {
        return (
          correction.from.toLowerCase() === rule.from.toLowerCase() &&
          correction.to.toLowerCase() === rule.to.toLowerCase()
        );
      }
      return (
        correction.to?.toLowerCase() === rule.to.toLowerCase() ||
        correction.term?.toLowerCase() === rule.to.toLowerCase()
      );
    });

    return matched
      ? { ...correction, appliedCount: correction.appliedCount + 1 }
      : correction;
  });
}

function applyStrictProjectAnchorPolicy({
  memoryPolicy,
  questionType,
  projectAnchor,
  query,
}: {
  memoryPolicy: MemoryRetrievalPolicy | undefined;
  questionType: MemoryQuestionType | undefined;
  projectAnchor: string | undefined;
  query: string;
}): MemoryRetrievalPolicy | undefined {
  const anchor = projectAnchor?.trim();
  if (
    questionType !== "project-deep-dive" ||
    !anchor ||
    isCrossProjectComparisonQuery(query)
  ) {
    return memoryPolicy;
  }

  return {
    id: memoryPolicy?.id ?? "project-anchor-strict",
    ...memoryPolicy,
    strictProjectAnchor: anchor,
  };
}

function isCrossProjectComparisonQuery(query: string) {
  return /\b(compare|comparison|another|other project|different project|similar project|transfer|analogy|alternative|else)\b/i.test(
    query
  );
}

function decideEmergencyCorrectionRepair({
  correction,
  contextState,
  latestTurnText,
  currentSuggestion,
}: {
  correction: SpeechCorrection;
  contextState: MeetingContextState;
  latestTurnText?: string;
  currentSuggestion?: string;
}) {
  const correctionTarget = (correction.to ?? correction.term ?? "").trim();
  const correctionSource = correction.from?.trim();
  const activeTask = contextState.activeMeetingTask;
  const hasActiveSurface = Boolean(
    activeTask || currentSuggestion?.trim() || latestTurnText?.trim()
  );

  if (!hasActiveSurface || !correctionTarget) {
    return {
      shouldRegenerate: false,
      reason: "no-active-task-or-correction-target",
    };
  }

  const activeText = [
    activeTask?.parent.questionType,
    activeTask?.parent.topic,
    activeTask?.parent.supportedFactAnchors.join(" "),
    activeTask?.child?.question,
    activeTask?.screen?.question,
    activeTask?.screen?.content,
    latestTurnText,
    currentSuggestion,
  ]
    .filter(Boolean)
    .join("\n");
  const normalizedActiveText = normalizeTranscriptForGate(activeText);
  const normalizedTarget = normalizeTranscriptForGate(correctionTarget);
  const normalizedSource = correctionSource
    ? normalizeTranscriptForGate(correctionSource)
    : "";

  if (
    normalizedSource &&
    normalizedActiveText.includes(normalizedSource) &&
    normalizedTarget
  ) {
    return {
      shouldRegenerate: true,
      reason: "source-term-present-in-active-context",
    };
  }

  if (isHighImpactCorrectionTerm(correctionTarget)) {
    return {
      shouldRegenerate: true,
      reason: "high-impact-correction-term",
    };
  }

  if (
    activeTask &&
    hasTechnicalSignal(correctionTarget) &&
    (activeTask.parent.questionType === "ai-ml-system-design" ||
      activeTask.parent.questionType === "general-system-design" ||
      activeTask.parent.questionType === "project-deep-dive" ||
      activeTask.parent.questionType === "coding" ||
      activeTask.child?.questionType === "field-knowledge")
  ) {
    return {
      shouldRegenerate: true,
      reason: "technical-correction-with-active-task",
    };
  }

  if (normalizedTarget && normalizedActiveText.includes(normalizedTarget)) {
    return {
      shouldRegenerate: true,
      reason: "target-term-present-in-active-context",
    };
  }

  return {
    shouldRegenerate: false,
    reason: "stored-for-future-speech-bias",
  };
}

function isHighImpactCorrectionTerm(term: string) {
  return /\b(rag|retrieval augmented generation|glean|mcp|agentic memory|vector search|embedding|llm|openai|anthropic|aws|amazon|google|microsoft|redis|kafka|postgres|java|python|typescript|javascript|go|golang|rust|c\+\+)\b/i.test(
    term
  );
}

function getMeetingScreenAutoPrompt(
  screenshotConfiguration: { mode: string; autoPrompt?: string }
) {
  if (screenshotConfiguration.mode !== "auto") return undefined;

  const trimmedPrompt = screenshotConfiguration.autoPrompt?.trim();
  return trimmedPrompt || undefined;
}

function formatRecentTranscript(
  turns: MeetingAssistantState["transcriptTurns"]
) {
  return turns
    .filter(shouldIncludeTurnInAdvisorPrompt)
    .slice(-8)
    .map((turn) => {
      const speaker = turn.speaker === "me" ? "Me" : "Them";
      return `${speaker}: ${turn.text}`;
    })
    .join("\n");
}

function formatTraceModelInput(systemPrompt: string, userMessage: string) {
  return [
    "<system_prompt>",
    systemPrompt,
    "</system_prompt>",
    "<user_message>",
    userMessage,
    "</user_message>",
  ].join("\n");
}

function formatTraceMetadata(metadata: Record<string, unknown>) {
  return JSON.stringify(metadata, null, 2);
}

function readStringFromTraceMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string
) {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readTaskSourceFromTraceMetadata(
  metadata: Record<string, unknown> | undefined
) {
  const value = readStringFromTraceMetadata(metadata, "activeMeetingTaskSource");
  return value === "screen" || value === "voice" || value === "mixed"
    ? value
    : undefined;
}

function getAdvisorActiveTaskId(context: AdvisorPromptContext) {
  return (
    context.activeMeetingTask?.id ??
    context.activeInterviewTask?.id ??
    context.activeScreenTask?.id
  );
}

function hasAdvisorActiveTask(context: AdvisorPromptContext) {
  return Boolean(
    context.activeMeetingTask ?? context.activeScreenTask ?? context.activeInterviewTask
  );
}

function getAdvisorActiveQuestionType(context: AdvisorPromptContext) {
  const questionType = readMemoryQuestionType(
    context.activeMeetingTask?.parent.questionType ??
      context.activeScreenTask?.kind ??
      context.activeInterviewTask?.stableKind
  );
  return questionType === "unknown" ? undefined : questionType;
}

function getAdvisorActiveChildQuestionType(context: AdvisorPromptContext) {
  return readMemoryQuestionType(
    context.activeMeetingTask?.child?.questionType ??
      context.activeInterviewTask?.child?.questionType
  );
}

function getAdvisorActivePlaybook(context: AdvisorPromptContext) {
  return (
    context.activeMeetingTask?.parent.playbook ??
    context.activeScreenTask?.playbook ??
    context.activeInterviewTask?.playbook
  );
}

function getAdvisorActiveProjectAnchor(context: AdvisorPromptContext) {
  return (
    context.activeMeetingTask?.parent.supportedFactAnchors[0] ??
    context.activeMeetingTask?.screen?.projectAnchor ??
    context.activeScreenTask?.classifier?.projectAnchor ??
    context.activeInterviewTask?.supportedFactAnchors[0]
  );
}

function getAdvisorActiveClassifierConfidence(context: AdvisorPromptContext) {
  return (
    context.activeMeetingTask?.screen?.classifierConfidence ??
    context.activeScreenTask?.classifier?.confidence
  );
}

function getAdvisorActiveAskFrame(context: AdvisorPromptContext) {
  return readMemoryAskFrame(
    context.activeMeetingTask?.screen?.askFrame ??
      context.activeScreenTask?.classifier?.askFrame
  );
}

function getAdvisorActiveTopicDomain(context: AdvisorPromptContext) {
  return readMemoryTopicDomain(
    context.activeMeetingTask?.screen?.topicDomain ??
      context.activeScreenTask?.classifier?.topicDomain
  );
}

function hasAdvisorActiveChild(context: AdvisorPromptContext) {
  return Boolean(context.activeMeetingTask?.child ?? context.activeInterviewTask?.child);
}

function formatAdvisorActiveTaskForQuery(
  context: AdvisorPromptContext,
  label = "active task"
) {
  if (context.activeMeetingTask) {
    return [
      `${label}: ${context.activeMeetingTask.parent.topic || ""}`,
      `${label} id: ${context.activeMeetingTask.id}`,
      `${label} source: ${context.activeMeetingTask.source}`,
      `${label} type: ${context.activeMeetingTask.parent.questionType}`,
      `${label} phase: ${context.activeMeetingTask.parent.playbookPhase}`,
      context.activeMeetingTask.parent.supportedFactAnchors.length
        ? `${label} fact anchors: ${context.activeMeetingTask.parent.supportedFactAnchors.join(", ")}`
        : undefined,
      context.activeMeetingTask.child
        ? [
            `${label} child type: ${context.activeMeetingTask.child.questionType}`,
            `${label} child intent: ${context.activeMeetingTask.child.intent}`,
            `${label} child question: ${context.activeMeetingTask.child.question}`,
          ].join("\n")
        : undefined,
      context.activeMeetingTask.screen?.question
        ? `${label} screen question: ${context.activeMeetingTask.screen.question}`
        : undefined,
      context.activeMeetingTask.screen?.askFrame
        ? `${label} ask frame: ${context.activeMeetingTask.screen.askFrame}`
        : undefined,
      context.activeMeetingTask.screen?.topicDomain
        ? `${label} topic domain: ${context.activeMeetingTask.screen.topicDomain}`
        : undefined,
      context.activeMeetingTask.screen?.projectAnchor
        ? `${label} project anchor: ${context.activeMeetingTask.screen.projectAnchor}`
        : undefined,
      context.activeMeetingTask.screen?.latestScreenAnswer
        ? `${label} screen answer:\n${context.activeMeetingTask.screen.latestScreenAnswer}`
        : undefined,
      context.activeMeetingTask.parent.latestUsefulAnswer
        ? `${label} latest useful answer:\n${context.activeMeetingTask.parent.latestUsefulAnswer}`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (context.activeScreenTask) {
    return [
      `${label}: ${context.activeScreenTask.question || ""}`,
      `${label} type: ${context.activeScreenTask.kind}`,
      context.activeScreenTask.classifier?.askFrame
        ? `${label} ask frame: ${context.activeScreenTask.classifier.askFrame}`
        : undefined,
      context.activeScreenTask.classifier?.topicDomain
        ? `${label} topic domain: ${context.activeScreenTask.classifier.topicDomain}`
        : undefined,
      context.activeScreenTask.classifier?.projectAnchor
        ? `${label} project anchor: ${context.activeScreenTask.classifier.projectAnchor}`
        : undefined,
      context.activeScreenTask.content,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (context.activeInterviewTask) {
    return [
      `${label}: ${context.activeInterviewTask.topic}`,
      `${label} type: ${context.activeInterviewTask.stableKind}`,
      `${label} phase: ${context.activeInterviewTask.playbookPhase}`,
      context.activeInterviewTask.supportedFactAnchors.length
        ? `${label} fact anchors: ${context.activeInterviewTask.supportedFactAnchors.join(", ")}`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function buildAdvisorMemoryQuery(
  context: AdvisorPromptContext,
  mode: AdvisorRequestMode,
  currentSuggestion?: string
) {
  const interviewBriefHint = buildInterviewSessionBriefMemoryHint(
    context.interviewSessionBrief
  );
  const interviewHint = buildInterviewSessionMemoryHint(
    context.interviewSessionContext
  );
  const amazonLpHint = buildAmazonLeadershipPrincipleMemoryHint(
    context.interviewSessionContext,
    [
      interviewBriefHint,
      context.latestTurn?.text,
      formatAdvisorActiveTaskForQuery(context),
      context.transcript,
      currentSuggestion,
    ]
      .filter(Boolean)
      .join("\n")
  );

  return [
    `mode: ${mode}`,
    interviewBriefHint || undefined,
    interviewHint || undefined,
    amazonLpHint || undefined,
    context.latestTurn ? `latest: ${context.latestTurn.text}` : undefined,
    formatAdvisorActiveTaskForQuery(context) || undefined,
    context.transcript ? `transcript:\n${context.transcript}` : undefined,
    context.screenContext ? `screen:\n${context.screenContext}` : undefined,
    currentSuggestion ? `current suggestion:\n${currentSuggestion}` : undefined,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(-8000);
}

function resolveAdvisorTaskSignals(
  context: AdvisorPromptContext,
  fallbackQuery: string
): AdvisorTaskSignals {
  const latestThemText =
    context.latestTurn?.speaker === "them" ? context.latestTurn.text.trim() : "";
  const latestUsefulText =
    latestThemText && calculateWordEquivalent(latestThemText) >= 3
      ? latestThemText
      : "";
  const openingRoute = latestUsefulText
    ? detectOpeningTaskRoute(latestUsefulText)
    : undefined;
  const latestQuestionType = openingRoute?.questionType ??
    (latestUsefulText ? inferMemoryQuestionTypeFromQuery(latestUsefulText) : "unknown");
  const latestAskFrame =
    openingRoute?.askFrame ??
    (latestUsefulText ? inferMemoryAskFrameFromQuery(latestUsefulText) : "unknown");
  const latestTopicDomain =
    openingRoute?.topicDomain ??
    (latestUsefulText
      ? inferMemoryTopicDomainFromQuery(latestUsefulText)
      : "unknown");
  const latestProjectAnchor = openingRoute?.projectAnchor;
  const activeQuestionType = getAdvisorActiveQuestionType(context);

  if (hasAdvisorActiveTask(context) && activeQuestionType) {
    const activeParentKind = normalizeInterviewParentKind(activeQuestionType);
    const latestParentKind = normalizeInterviewParentKind(latestQuestionType);
    const latestIsParentKind = Boolean(
      latestParentKind && isParentInterviewKind(latestParentKind)
    );
    const latestLooksLikeTask =
      latestUsefulText &&
      (hasQuestionOrTaskSignal(latestUsefulText) ||
        isTaskSwitchTranscript(latestUsefulText));
    const shouldStartNewParent =
      Boolean(latestLooksLikeTask) &&
      activeParentKind !== undefined &&
      latestIsParentKind &&
      latestParentKind !== undefined &&
      !isCompatibleParentKind(activeParentKind, latestParentKind);

    if (shouldStartNewParent) {
      return {
        questionType: latestQuestionType,
        askFrame: latestAskFrame,
        topicDomain: latestTopicDomain,
        query: buildFocusedAdvisorTaskQuery(context, latestUsefulText),
        taskRelation: "new-parent",
        subtaskIntent: inferAdvisorSubtaskIntent(
          latestUsefulText,
          latestQuestionType
        ),
        projectAnchor: latestProjectAnchor,
        source: openingRoute?.source ?? "latest-turn-new-parent",
        reuseActivePlaybook: false,
        openingRoute,
      };
    }

    const useLatestAsChild = shouldUseLatestTurnAsChildProbe({
      activeQuestionType,
      latestQuestionType,
      latestText: latestUsefulText,
    });

    if (useLatestAsChild) {
      return {
        questionType: latestQuestionType,
        askFrame: latestAskFrame,
        topicDomain: latestTopicDomain,
        query: buildFocusedAdvisorTaskQuery(context, latestUsefulText),
        taskRelation: "child-probe",
        subtaskIntent: inferAdvisorSubtaskIntent(
          latestUsefulText,
          latestQuestionType
        ),
        projectAnchor: latestProjectAnchor,
        source: "latest-turn-child-probe",
        reuseActivePlaybook: false,
        openingRoute,
      };
    }

    const hasActiveChild = hasAdvisorActiveChild(context);
    const shouldResumeParent =
      hasActiveChild &&
      latestUsefulText &&
      (latestQuestionType === activeQuestionType ||
        isResumeParentTranscript(latestUsefulText) ||
        inferAdvisorSubtaskIntent(latestUsefulText, activeQuestionType) ===
          "metric-probe" ||
        inferAdvisorSubtaskIntent(latestUsefulText, activeQuestionType) ===
          "qps-estimation");
    const taskRelation: InterviewTaskRelation = shouldResumeParent
      ? "resume-parent"
      : latestUsefulText && hasConstraintOrCorrectionSignal(latestUsefulText)
        ? "correction"
        : latestUsefulText && isMeetingLogisticsTranscript(
            normalizeTranscriptForGate(latestUsefulText)
          )
          ? "logistics"
          : latestUsefulText
            ? "followup-parent"
            : "unknown";

    return {
      questionType: activeQuestionType,
      askFrame:
        getAdvisorActiveAskFrame(context) ??
        latestAskFrame ??
        inferMemoryAskFrameFromQuery(fallbackQuery),
      topicDomain:
        getAdvisorActiveTopicDomain(context) ??
        latestTopicDomain ??
        inferMemoryTopicDomainFromQuery(fallbackQuery),
      projectAnchor: latestProjectAnchor,
      query: buildFocusedAdvisorTaskQuery(context, latestUsefulText),
      taskRelation,
      subtaskIntent: inferAdvisorSubtaskIntent(
        latestUsefulText,
        activeQuestionType
      ),
      source: "active-parent",
      reuseActivePlaybook: true,
      openingRoute,
    };
  }

  const questionType =
    latestQuestionType !== "unknown"
      ? latestQuestionType
      : inferMemoryQuestionTypeFromQuery(fallbackQuery);

  return {
    questionType,
    askFrame:
      latestAskFrame !== "unknown"
        ? latestAskFrame
        : inferMemoryAskFrameFromQuery(fallbackQuery),
    topicDomain:
      latestTopicDomain !== "unknown"
        ? latestTopicDomain
        : inferMemoryTopicDomainFromQuery(fallbackQuery),
    query: latestUsefulText
      ? buildFocusedAdvisorTaskQuery(context, latestUsefulText)
      : fallbackQuery,
    taskRelation: "new-parent",
    subtaskIntent: inferAdvisorSubtaskIntent(latestUsefulText, questionType),
    projectAnchor: latestProjectAnchor,
    source: openingRoute?.source ?? (latestUsefulText ? "latest-turn" : "fallback-query"),
    reuseActivePlaybook: false,
    openingRoute,
  };
}

function detectOpeningTaskRoute(text: string):
  | (OpeningRouteContext & {
      questionType: MemoryQuestionType;
      askFrame: MemoryAskFrame;
      topicDomain: MemoryTopicDomain;
    })
  | undefined {
  const normalized = normalizeTranscriptForGate(text);
  if (!normalized) return undefined;

  const projectAnchor = inferOpeningProjectAnchor(text);
  const asksResumeWalkthrough =
    /\b(walk me through|tell me about|briefly summarize|summarize)\b/i.test(
      text
    ) && /\b(your resume|your background|your experience|your career)\b/i.test(text);
  const asksSelfIntro =
    /\b(introduce yourself|tell me about yourself|about yourself|start with your background|briefly introduce)\b/i.test(
      text
    ) || asksResumeWalkthrough;
  const asksProjectIntro =
    /\b(tell me about|walk me through|describe|explain)\b/i.test(text) &&
    (projectAnchor ||
      /\b(project|work you did|system you built|technical difficulty|hardest part|tradeoff|proud of)\b/i.test(
        normalized
      ));
  const asksProjectProudOrHard =
    /\b(project.*proud|proud.*project|hardest part|technical difficult|technical challenge|why did you choose|how did you build|how did you design|how did you implement)\b/i.test(
      normalized
    );

  if (!asksSelfIntro && !asksProjectIntro && !asksProjectProudOrHard) {
    return undefined;
  }

  const openingKind = asksSelfIntro
    ? asksResumeWalkthrough
      ? "resume-walkthrough"
      : "self-intro"
    : "project-intro";

  return {
    questionType: "project-deep-dive",
    askFrame: "past-project",
    topicDomain: inferOpeningTopicDomain(projectAnchor, text),
    projectAnchor,
    kind: openingKind,
    source: asksSelfIntro
      ? "opening-route-self-intro"
      : "opening-route-project-intro",
    commitParent: !asksSelfIntro,
  };
}

function inferOpeningProjectAnchor(text: string) {
  const normalized = normalizeTranscriptForGate(text);
  const anchors: Array<[RegExp, string]> = [
    [/\bagentic memory\b/i, "Agentic Memory"],
    [/\bmodel interface\b/i, "Model Interface"],
    [/\bmanaged semantic search\b/i, "Managed Semantic Search"],
    [/\bsemantic search\b/i, "Managed Semantic Search"],
    [/\bthrottling\b|\bquota\b|\brate limit/i, "Throttling"],
    [/\boasis\b/i, "Oasis"],
    [/\bneural search\b|\bneuralsearch\b/i, "NeuralSearch"],
    [/\bbeaglestone\b/i, "BeagleStone Migration"],
    [/\baos release\b|\bopensearch release\b/i, "AOS Release"],
    [/\bml commons\b/i, "ML Commons"],
  ];

  for (const [pattern, anchor] of anchors) {
    if (pattern.test(normalized) || pattern.test(text)) return anchor;
  }

  return undefined;
}

function inferOpeningTopicDomain(
  projectAnchor: string | undefined,
  text: string
): MemoryTopicDomain {
  const normalized = normalizeTranscriptForGate(`${projectAnchor ?? ""} ${text}`);
  if (/\b(agentic|memory|llm|model|ml|ai|rag|semantic|neural)\b/i.test(normalized)) {
    return "ai-ml-infra";
  }
  if (/\b(search|opensearch|aos)\b/i.test(normalized)) return "search";
  if (/\b(throttling|quota|rate limit|backend|service)\b/i.test(normalized)) {
    return "backend";
  }
  return "unknown";
}

function buildFocusedAdvisorTaskQuery(
  context: AdvisorPromptContext,
  latestText: string
) {
  const interviewBriefHint = buildInterviewSessionBriefMemoryHint(
    context.interviewSessionBrief
  );
  const interviewHint = buildInterviewSessionMemoryHint(
    context.interviewSessionContext
  );

  return [
    interviewBriefHint || undefined,
    interviewHint || undefined,
    latestText ? `latest: ${latestText}` : undefined,
    formatAdvisorActiveTaskForQuery(context, "active parent") || undefined,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(-4000);
}

function shouldUseLatestTurnAsChildProbe({
  activeQuestionType,
  latestQuestionType,
  latestText,
}: {
  activeQuestionType: MemoryQuestionType;
  latestQuestionType: MemoryQuestionType;
  latestText: string;
}) {
  if (!latestText || latestQuestionType === "unknown") return false;
  if (latestQuestionType === activeQuestionType) return false;

  const parentAllowsChild =
    activeQuestionType === "ai-ml-system-design" ||
    activeQuestionType === "general-system-design" ||
    activeQuestionType === "project-deep-dive";
  if (!parentAllowsChild) return false;

  if (latestQuestionType === "field-knowledge") return true;
  if (latestQuestionType === "coding") return true;

  return false;
}

function isResumeParentTranscript(text: string) {
  const normalized = normalizeTranscriptForGate(text);
  if (!normalized) return false;

  return (
    /\b(back to|return to|go back to|continue|resume|for this system|for this design|for the original question|for the previous question|for the system we discussed|how would you evaluate|how do you measure|what metrics|what logs|observability)\b/i.test(
      normalized
    ) ||
    /回到|继续刚才|刚才那个系统|刚才的问题|这个系统|这个设计|怎么评估|什么指标|哪些日志|可观测/.test(
      text
    )
  );
}

function inferAdvisorSubtaskIntent(
  text: string,
  questionType: MemoryQuestionType
): InterviewSubtaskIntent {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) return "unknown";
  if (/\b(qps|throughput|traffic|dau|mau|peak|capacity|scale)\b/.test(normalized)) {
    return "qps-estimation";
  }
  if (questionType === "coding" || /\b(code|implement|write|function)\b/.test(normalized)) {
    return "implementation-probe";
  }
  if (/\b(complexity|time|space|big o|optimi[sz]e)\b/.test(normalized)) {
    return "complexity-probe";
  }
  if (/\b(metric|metrics|evaluate|evaluation|success|quality|accuracy|precision|recall|latency|p99|throughput|qps)\b/.test(normalized)) {
    return "metric-probe";
  }
  if (/\b(what is|explain|compare|why|how does|principle|tradeoff|trade-off)\b/.test(normalized)) {
    return "concept-probe";
  }
  if (/\b(project|implementation|architecture|debug|incident|root cause|role|impact)\b/.test(normalized)) {
    return questionType === "behavioral" ? "story-detail" : "project-detail";
  }
  if (/\b(clarify|constraint|assume|requirement|instead|not)\b/.test(normalized)) {
    return "clarification";
  }
  return "unknown";
}

function buildStateUpdatedInterviewTask(
  task: ActiveInterviewParent | undefined,
  turn: TranscriptTurn
): ActiveInterviewParent | undefined {
  if (!task) return undefined;

  const now = Date.now();
  return {
    ...task,
    updatedAt: now,
    expiresAt: task.expiresAt
      ? Math.max(task.expiresAt, now + 5 * 60_000)
      : undefined,
    revisions: task.revisions + 1,
    child:
      task.child && isResumeParentTranscript(turn.text)
        ? undefined
        : task.child,
  };
}

function updateInterviewTaskContinuityForAnswer({
  existingTask,
  source,
  questionType,
  relation,
  subtaskIntent,
  question,
  finalContent,
  playbook,
  phaseDecision,
  latestTurn,
  observationId,
  expiresAt,
  supportedFactAnchors,
}: {
  existingTask?: ActiveInterviewParent;
  source: "screen" | "voice";
  questionType: MemoryQuestionType | ScreenTaskKind;
  relation: InterviewTaskRelation;
  subtaskIntent: InterviewSubtaskIntent;
  question?: string;
  finalContent: string;
  playbook?: ActiveInterviewParent["playbook"];
  phaseDecision?: PlaybookPhaseDecision;
  latestTurn?: TranscriptTurn;
  observationId?: string;
  expiresAt?: number;
  supportedFactAnchors?: string[];
}): InterviewTaskContinuityResult {
  const kind = normalizeInterviewParentKind(questionType);
  const childQuestionType =
    normalizeCanonicalQuestionType(questionType) ?? "unknown";
  const now = Date.now();
  const trimmedContent = finalContent.trim();
  const isUsefulAnswer = Boolean(trimmedContent && trimmedContent !== "-");
  const topic =
    question?.trim() ||
    extractScreenTaskQuestion(trimmedContent) ||
    latestTurn?.text.trim() ||
    existingTask?.topic ||
    "Unknown interview task";
  const anchors = mergeSupportedFactAnchors(
    existingTask?.supportedFactAnchors,
    supportedFactAnchors
  );

  if (!kind || !isParentInterviewKind(kind)) {
    if (relation === "child-probe" && existingTask && isUsefulAnswer) {
      const child = buildActiveInterviewChild({
        questionType: childQuestionType,
        subtaskIntent,
        question: topic,
        finalContent: trimmedContent,
        latestTurn,
        observationId,
      });

      return {
        task: {
          ...existingTask,
          updatedAt: now,
          expiresAt,
          child,
          revisions: existingTask.revisions + 1,
        },
        startedNewParent: false,
        clearedParent: false,
      };
    }

    return {
      task: existingTask,
      startedNewParent: false,
      clearedParent: false,
    };
  }

  const shouldStartNewParent =
    !existingTask ||
    relation === "new-parent" ||
    relation === "unknown" ||
    !isCompatibleParentKind(existingTask.stableKind, kind);

  if (shouldStartNewParent) {
    return {
      task: {
        id: createMeetingId("interview_parent"),
        source,
        stableKind: kind,
        topic,
        playbook,
        playbookPhase: phaseDecision?.phase ?? playbook?.phase ?? "follow_up",
        phaseProgress: applyPlaybookPhaseDecisionToProgress(
          playbook?.phase ? { [playbook.phase]: true } : {},
          phaseDecision,
          playbook?.phase
        ),
        supportedFactAnchors: anchors,
        latestUsefulAnswer: isUsefulAnswer
          ? buildCompactAnswerSummary(trimmedContent)
          : undefined,
        previousUsefulAnswer: undefined,
        createdAt: now,
        updatedAt: now,
        expiresAt,
        startTurnId: latestTurn?.id,
        startObservationId: observationId,
        revisions: 1,
      },
      startedNewParent: true,
      clearedParent: false,
    };
  }

  if (relation === "child-probe") {
    return {
      task: {
        ...existingTask,
        updatedAt: now,
        expiresAt,
        child: isUsefulAnswer
          ? buildActiveInterviewChild({
              questionType: childQuestionType,
              subtaskIntent,
              question: topic,
              finalContent: trimmedContent,
              latestTurn,
              observationId,
            })
          : existingTask.child,
        supportedFactAnchors: anchors,
        revisions: existingTask.revisions + 1,
      },
      startedNewParent: false,
      clearedParent: false,
    };
  }

  return {
    task: {
      ...existingTask,
      updatedAt: now,
      expiresAt,
      playbook: playbook ?? existingTask.playbook,
      playbookPhase:
        phaseDecision?.phase ?? playbook?.phase ?? existingTask.playbookPhase,
      phaseProgress: applyPlaybookPhaseDecisionToProgress(
        existingTask.phaseProgress,
        phaseDecision,
        playbook?.phase
      ),
      supportedFactAnchors: anchors,
      previousUsefulAnswer:
        isUsefulAnswer && existingTask.latestUsefulAnswer
          ? existingTask.latestUsefulAnswer
          : existingTask.previousUsefulAnswer,
      latestUsefulAnswer: isUsefulAnswer
        ? buildCompactAnswerSummary(trimmedContent)
        : existingTask.latestUsefulAnswer,
      child: relation === "resume-parent" ? undefined : existingTask.child,
      revisions: existingTask.revisions + 1,
    },
    startedNewParent: false,
    clearedParent: false,
  };
}

function buildInterviewParentFromScreenTask(
  task: ActiveScreenTask
): ActiveInterviewParent | undefined {
  const kind = normalizeInterviewParentKind(task.kind);
  if (!kind) return undefined;

  return {
    id: task.id,
    source: "screen",
    stableKind: kind,
    topic: task.question || extractScreenTaskQuestion(task.content) || "Screen task",
    playbook: task.playbook,
    playbookPhase: task.playbook?.phase ?? "follow_up",
    phaseProgress: task.playbook?.phase ? { [task.playbook.phase]: true } : {},
    supportedFactAnchors: [
      task.classifier?.projectAnchor,
      task.playbook?.label,
    ].filter(Boolean) as string[],
    latestUsefulAnswer: buildCompactAnswerSummary(task.content),
    previousUsefulAnswer: undefined,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    expiresAt: task.expiresAt,
    startObservationId: task.basedOnObservationId,
    revisions: 1,
  };
}

function decideScreenTaskRelation({
  existingTask,
  taskKind,
  question,
  screenContent,
  screenPreflight,
  corrections,
}: {
  existingTask?: ActiveInterviewParent;
  taskKind: ScreenTaskKind;
  question?: string;
  screenContent: string;
  screenPreflight?: ScreenPreflightResult;
  corrections: SpeechCorrection[];
}): {
  relation: InterviewTaskRelation;
  reason: string;
  confidence: number;
} {
  const nextKind = normalizeInterviewParentKind(taskKind);
  const nextQuestionType = readMemoryQuestionType(taskKind) ?? "unknown";

  if (!existingTask) {
    return {
      relation: "new-parent",
      reason: "no-existing-parent",
      confidence: 0.95,
    };
  }

  if (!nextKind || !isParentInterviewKind(nextKind)) {
    if (
      shouldUseLatestTurnAsChildProbe({
        activeQuestionType: existingTask.stableKind,
        latestQuestionType: nextQuestionType,
        latestText: question || screenContent,
      })
    ) {
      return {
        relation: "child-probe",
        reason: "screen-nonparent-child-probe",
        confidence: 0.82,
      };
    }

    return {
      relation: "followup-parent",
      reason: "screen-nonparent-followup",
      confidence: 0.58,
    };
  }

  if (!isCompatibleParentKind(existingTask.stableKind, nextKind)) {
    if (
      shouldUseLatestTurnAsChildProbe({
        activeQuestionType: existingTask.stableKind,
        latestQuestionType: nextQuestionType,
        latestText: question || screenContent,
      })
    ) {
      return {
        relation: "child-probe",
        reason: "screen-compatible-child-probe",
        confidence: 0.78,
      };
    }

    return {
      relation: "new-parent",
      reason: "screen-parent-kind-mismatch",
      confidence: 0.9,
    };
  }

  const screenText = [
    question,
    screenPreflight?.question,
    screenPreflight?.projectAnchor,
    screenContent.slice(0, 1200),
  ]
    .filter(Boolean)
    .join("\n");
  const parentText = [
    existingTask.topic,
    existingTask.supportedFactAnchors.join(" "),
    existingTask.latestUsefulAnswer,
    existingTask.child?.question,
    existingTask.child?.compactSummary,
  ]
    .filter(Boolean)
    .join("\n");
  const overlap = countSignificantTokenOverlap(screenText, parentText);
  const semanticSimilarity = calculateTaskTextSimilarity(screenText, parentText);
  const correctionOverlap = countCorrectionTermOverlap(corrections, screenText);
  const screenProjectAnchor = screenPreflight?.projectAnchor;
  const projectAnchorMatches = screenProjectAnchor
    ? existingTask.supportedFactAnchors.some((anchor) =>
        areLoosePhrasesSimilar(anchor, screenProjectAnchor)
      )
    : false;

  if (projectAnchorMatches) {
    return {
      relation: "resume-parent",
      reason: "screen-project-anchor-matches-parent",
      confidence: 0.9,
    };
  }

  if (correctionOverlap > 0) {
    return {
      relation: "resume-parent",
      reason: "screen-contains-recent-correction-term",
      confidence: 0.86,
    };
  }

  if (semanticSimilarity >= 0.34) {
    return {
      relation: "resume-parent",
      reason: `screen-parent-semantic-similarity:${semanticSimilarity.toFixed(2)}`,
      confidence: Math.min(0.88, 0.58 + semanticSimilarity),
    };
  }

  if (overlap >= 2) {
    return {
      relation: "resume-parent",
      reason: `screen-parent-token-overlap:${overlap}`,
      confidence: Math.min(0.84, 0.55 + overlap * 0.08),
    };
  }

  if (semanticSimilarity >= 0.22 && hasSharedDomainSignal(screenText, parentText)) {
    return {
      relation: "followup-parent",
      reason: `screen-parent-domain-similarity:${semanticSimilarity.toFixed(2)}`,
      confidence: Math.min(0.78, 0.52 + semanticSimilarity),
    };
  }

  if (
    existingTask.stableKind === "ai-ml-system-design" &&
    nextKind === "ai-ml-system-design" &&
    hasAimlDesignOverlap(screenText, parentText)
  ) {
    return {
      relation: "followup-parent",
      reason: "screen-aiml-design-overlap",
      confidence: 0.76,
    };
  }

  if (nextKind === "coding") {
    return {
      relation: "new-parent",
      reason: "screen-coding-without-parent-overlap",
      confidence: 0.8,
    };
  }

  return {
    relation: "new-parent",
    reason: "screen-compatible-kind-low-overlap",
    confidence: 0.62,
  };
}

function countCorrectionTermOverlap(
  corrections: SpeechCorrection[],
  text: string
) {
  const normalized = normalizeTranscriptForGate(text);
  return corrections
    .slice(-5)
    .map((correction) => correction.to ?? correction.term)
    .filter((term): term is string => Boolean(term?.trim()))
    .filter((term) => normalized.includes(normalizeTranscriptForGate(term)))
    .length;
}

function countSignificantTokenOverlap(left: string, right: string) {
  const leftTokens = extractSignificantTokens(left);
  const rightTokens = extractSignificantTokens(right);
  let count = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) count += 1;
  }
  return count;
}

function calculateTaskTextSimilarity(left: string, right: string) {
  const leftTokens = extractSignificantTokens(left);
  const rightTokens = extractSignificantTokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }

  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
}

function hasSharedDomainSignal(left: string, right: string) {
  const domains = [
    ["rag", "retrieval", "embedding", "vector", "llm", "agent"],
    ["trip", "planning", "travel", "recommendation", "recommender"],
    ["uber", "ride", "driver", "location", "matching", "dispatch"],
    ["instagram", "feed", "photo", "social", "follow", "post"],
    ["ticket", "booking", "seat", "inventory", "payment"],
    ["agentic", "memory", "consolidation", "context"],
  ];
  const leftNormalized = normalizeTranscriptForGate(left);
  const rightNormalized = normalizeTranscriptForGate(right);

  return domains.some((signals) => {
    const leftHits = signals.filter((signal) => leftNormalized.includes(signal));
    const rightHits = signals.filter((signal) => rightNormalized.includes(signal));
    return leftHits.length > 0 && rightHits.length > 0;
  });
}

function extractSignificantTokens(text: string) {
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "this",
    "that",
    "you",
    "your",
    "can",
    "how",
    "what",
    "why",
    "tell",
    "about",
    "design",
    "system",
    "question",
    "answer",
    "approach",
  ]);
  return new Set(
    normalizeTranscriptForGate(text)
      .split(" ")
      .filter((token) => token.length >= 3 && !stopWords.has(token))
      .slice(0, 80)
  );
}

function areLoosePhrasesSimilar(left: string, right: string) {
  const normalizedLeft = normalizeTranscriptForGate(left);
  const normalizedRight = normalizeTranscriptForGate(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return (
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft) ||
    countSignificantTokenOverlap(left, right) >= 2
  );
}

function hasAimlDesignOverlap(left: string, right: string) {
  const combined = `${left}\n${right}`.toLowerCase();
  const hasRagOrRetrieval =
    /\b(rag|retrieval|recommendation|recommender|trip|planning|destination|activity|agent|llm|embedding|vector)\b/i.test(
      combined
    );
  return hasRagOrRetrieval && countSignificantTokenOverlap(left, right) >= 1;
}

function buildActiveInterviewChild({
  questionType,
  subtaskIntent,
  question,
  finalContent,
  latestTurn,
  observationId,
}: {
  questionType: CanonicalQuestionType;
  subtaskIntent: InterviewSubtaskIntent;
  question: string;
  finalContent: string;
  latestTurn?: TranscriptTurn;
  observationId?: string;
}) {
  const now = Date.now();
  return {
    id: createMeetingId("interview_child"),
    createdAt: now,
    updatedAt: now,
    questionType,
    relation: "child-probe" as const,
    intent: subtaskIntent,
    question,
    compactSummary: buildCompactChildSummary({
      questionType,
      subtaskIntent,
      question,
      finalContent,
    }),
    basedOnTurnIds: latestTurn ? [latestTurn.id] : [],
    basedOnObservationIds: observationId ? [observationId] : [],
  };
}

function buildCompactChildSummary({
  questionType,
  subtaskIntent,
  question,
  finalContent,
}: {
  questionType: CanonicalQuestionType;
  subtaskIntent: InterviewSubtaskIntent;
  question: string;
  finalContent: string;
}) {
  const parsedSummary = buildCompactAnswerSummary(finalContent);
  const fallbackSummary = finalContent
    .replace(/```[\s\S]*?```/g, "[code omitted]")
    .replace(/\s+/g, " ")
    .trim();
  const summary = parsedSummary || fallbackSummary;

  return [
    `Child kind: ${questionType}`,
    `Intent: ${subtaskIntent}`,
    `Question: ${question}`,
    summary ? `Summary: ${summary.slice(0, 500)}` : undefined,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 800);
}

function normalizeInterviewParentKind(
  questionType: MemoryQuestionType | ScreenTaskKind
): ParentQuestionType | undefined {
  return normalizeParentQuestionType(questionType);
}

function isParentInterviewKind(kind: CanonicalQuestionType | undefined) {
  return Boolean(kind && isParentCanonicalQuestionType(kind));
}

function isCompatibleParentKind(
  left: ParentQuestionType,
  right: ParentQuestionType
) {
  return areCompatibleQuestionTypes(left, right);
}

function buildCompactAnswerSummary(content: string) {
  const parsed = parseScreenTaskAnswer(content);
  return [
    parsed.question ? `Question: ${parsed.question}` : undefined,
    parsed.answer ? `Answer: ${parsed.answer}` : undefined,
    parsed.approach ? `Approach: ${parsed.approach}` : undefined,
    parsed.whiteboard ? `Whiteboard: ${parsed.whiteboard}` : undefined,
    parsed.complexity ? `Complexity: ${parsed.complexity}` : undefined,
  ]
    .filter(Boolean)
    .join("\n")
    .replace(/\s+\n/g, "\n")
    .slice(0, 1000);
}

function mergeSupportedFactAnchors(
  previous: string[] | undefined,
  next: string[] | undefined
) {
  return Array.from(new Set([...(previous ?? []), ...(next ?? [])]))
    .filter(Boolean)
    .slice(0, 12);
}

function extractSupportedFactAnchorsFromMemory(
  memoryContext: MemoryRetrievalResult | null | undefined
) {
  if (!memoryContext?.entries.length) return [];
  return memoryContext.entries
    .map((item) => {
      const entry = item.entry;
      return entry.projectName || entry.projectId || entry.title || entry.id;
    })
    .filter(Boolean)
    .slice(0, 8);
}

function buildScreenMemoryQuery({
  observation,
  autoPrompt,
  interviewSessionBrief,
  interviewSessionContext,
  screenPreflight,
}: {
  observation: ScreenObservation;
  autoPrompt?: string;
  interviewSessionBrief?: AdvisorPromptContext["interviewSessionBrief"];
  interviewSessionContext?: AdvisorPromptContext["interviewSessionContext"];
  screenPreflight?: ScreenPreflightResult;
}) {
  const captureTarget = observation.captureTarget;
  const interviewBriefHint =
    buildInterviewSessionBriefMemoryHint(interviewSessionBrief);
  const interviewHint = buildInterviewSessionMemoryHint(interviewSessionContext);
  const amazonLpHint = buildAmazonLeadershipPrincipleMemoryHint(
    interviewSessionContext,
    [
      interviewBriefHint,
      screenPreflight?.question,
      screenPreflight?.amazonLeadershipPrinciple,
    ]
      .filter(Boolean)
      .join("\n")
  );

  return [
    "mode: screen-task",
    interviewBriefHint || undefined,
    interviewHint || undefined,
    amazonLpHint || undefined,
    screenPreflight?.question
      ? `screen preflight question:\n${screenPreflight.question}`
      : undefined,
    screenPreflight?.questionType
      ? `question type: ${screenPreflight.questionType}`
      : undefined,
    screenPreflight?.askFrame
      ? `ask frame: ${screenPreflight.askFrame}`
      : undefined,
    screenPreflight?.topicDomain
      ? `topic domain: ${screenPreflight.topicDomain}`
      : undefined,
    screenPreflight?.projectAnchor
      ? `project anchor: ${screenPreflight.projectAnchor}`
      : undefined,
    screenPreflight?.isBehavioralInterview
      ? "screen preflight use case: behavioral interview"
      : undefined,
    captureTarget?.appName ? `app: ${captureTarget.appName}` : undefined,
    captureTarget?.title ? `title: ${captureTarget.title}` : undefined,
    autoPrompt ? `screen prompt preference:\n${autoPrompt}` : undefined,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(-8000);
}

function inferMemoryUseCaseFromQuery(query: string): MemoryUseCase {
  const normalized = query.toLowerCase();

  const behavioralMarkers = [
    "behavior",
    "behaviour",
    "leadership principle",
    "star",
    "interview story",
    "tell me about a time",
    "disagree",
    "conflict",
    "ownership",
    "bias for action",
    "customer obsession",
  ];

  if (behavioralMarkers.some((marker) => normalized.includes(marker))) {
    return "behavioral_interview";
  }

  if (
    /\b(leetcode|algorithm|coding|complexity|typescript|javascript|python|java|rust|go|golang|dp|graph|tree|heap|stack|queue)\b/.test(
      normalized
    )
  ) {
    return "coding_interview";
  }

  return "meeting_assistant";
}

function normalizeMemoryUseCaseForQuestionType(
  useCase: MemoryUseCase,
  questionType: MemoryQuestionType
): MemoryUseCase {
  const canonical = normalizeCanonicalQuestionType(questionType);
  return canonical
    ? toMemoryUseCaseForQuestionType(useCase, canonical)
    : useCase;
}

function inferMemoryQuestionTypeFromScreenPreflight(
  query: string,
  screenPreflight: ScreenPreflightResult | undefined
): MemoryQuestionType {
  const classifierQuestionType = readMemoryQuestionType(
    screenPreflight?.questionType
  );
  if (classifierQuestionType && classifierQuestionType !== "unknown") {
    return classifierQuestionType;
  }
  if (screenPreflight?.isBehavioralInterview) return "behavioral";
  if (classifierQuestionType) return classifierQuestionType;
  return inferMemoryQuestionTypeFromQuery(
    [screenPreflight?.question, query].filter(Boolean).join("\n")
  );
}

function inferMemoryAskFrameFromScreenPreflight(
  query: string,
  screenPreflight: ScreenPreflightResult | undefined
): MemoryAskFrame {
  const classifierAskFrame = readMemoryAskFrame(screenPreflight?.askFrame);
  if (classifierAskFrame) return classifierAskFrame;
  return inferMemoryAskFrameFromQuery(
    [screenPreflight?.question, query].filter(Boolean).join("\n")
  );
}

function inferMemoryTopicDomainFromScreenPreflight(
  query: string,
  screenPreflight: ScreenPreflightResult | undefined
): MemoryTopicDomain {
  const classifierTopicDomain = readMemoryTopicDomain(
    screenPreflight?.topicDomain
  );
  if (classifierTopicDomain) return classifierTopicDomain;
  return inferMemoryTopicDomainFromQuery(
    [screenPreflight?.question, query].filter(Boolean).join("\n")
  );
}

function inferMemoryQuestionTypeFromQuery(query: string): MemoryQuestionType {
  return inferCanonicalQuestionTypeFromText(query) ?? "unknown";
}

function readMemoryQuestionType(
  value: string | undefined
): MemoryQuestionType | undefined {
  const canonical = normalizeCanonicalQuestionType(value);
  if (canonical) return canonical;
  if (value === "non-question") return "unknown";
  return undefined;
}

function readMemoryAskFrame(
  value: string | undefined
): MemoryAskFrame | undefined {
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

function readMemoryTopicDomain(
  value: string | undefined
): MemoryTopicDomain | undefined {
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

function inferMemoryAskFrameFromQuery(query: string): MemoryAskFrame {
  const normalized = query.toLowerCase();
  if (
    /\b(tell me about your|walk me through your|your project|previous project|past project|what did you build|how did you implement|deep dive)\b/.test(
      normalized
    )
  ) {
    return "past-project";
  }
  if (
    /\b(design a|design an|design the|how would you design|build a|architect a|propose an architecture)\b/.test(
      normalized
    )
  ) {
    return "hypothetical-design";
  }
  if (/\b(explain|what is|compare|why|tradeoff|trade-off)\b/.test(normalized)) {
    return "direct-answer";
  }
  return "unknown";
}

function inferMemoryTopicDomainFromQuery(query: string): MemoryTopicDomain {
  const normalized = query.toLowerCase();
  if (/\b(agent|agentic|tool use|planner|memory base|kmb)\b/.test(normalized)) {
    return "agentic-ai";
  }
  if (
    /\b(search|semantic search|ranking|retrieval|opensearch|vector search|neural search)\b/.test(
      normalized
    )
  ) {
    return "search";
  }
  if (
    /\b(ai|ml|llm|rag|retrieval augmented generation|embedding|model serving|inference|fine tuning|training|evaluation|evals)\b/.test(
      normalized
    )
  ) {
    return "ai-ml-infra";
  }
  if (
    /\b(backend|api|database|distributed|scalability|consistency|sharding|cache|queue|microservice)\b/.test(
      normalized
    )
  ) {
    return "backend";
  }
  return "unknown";
}

function shouldUpdateActiveScreenTaskFromAdvisorOutput(content: string) {
  const normalized = content.trim().toLowerCase();

  if (!normalized || normalized === "-") return false;

  if (!normalized.includes("clarifying question:")) return true;

  return !(
    normalized.includes("new task") ||
    normalized.includes("new question") ||
    normalized.includes("next question") ||
    normalized.includes("recapture") ||
    normalized.includes("capture or state")
  );
}

function evaluateThemTurnForAdvisor(
  turn: TranscriptTurn,
  options: { hasActiveTask: boolean }
): AdvisorTurnGateDecision {
  const trimmed = turn.text.trim();
  if (!trimmed) {
    return {
      action: "ignore",
      reason: "empty-transcript",
      contextPromptEligible: false,
    };
  }

  const normalized = normalizeTranscriptForGate(trimmed);
  const wordEquivalent = calculateWordEquivalent(trimmed);
  const hasQuestion = hasQuestionOrTaskSignal(trimmed);
  const hasConstraintOrCorrection = hasConstraintOrCorrectionSignal(trimmed);

  if (hasConstraintOrCorrection) {
    return {
      action: "answer-refresh",
      reason: "constraint-or-correction",
      contextPromptEligible: true,
    };
  }

  if (isLowValueAcknowledgement(normalized)) {
    return {
      action: "ignore",
      reason: "low-value-acknowledgement",
      contextPromptEligible: false,
    };
  }

  if (isMeetingLogisticsTranscript(normalized)) {
    return {
      action: "append-only",
      reason: "meeting-logistics",
      contextPromptEligible: false,
    };
  }

  if (detectInterviewCompany(trimmed) && !hasQuestion && wordEquivalent <= 18) {
    return {
      action: "state-update",
      reason: "company-context-only",
      contextPromptEligible: false,
    };
  }

  if (hasQuestion) {
    return {
      action: "answer-refresh",
      reason: "question-or-task-prompt",
      contextPromptEligible: true,
    };
  }

  if (
    options.hasActiveTask &&
    wordEquivalent <= 10 &&
    !hasTechnicalSignal(trimmed)
  ) {
    return {
      action: "ignore",
      reason: "short-nontechnical-followup",
      contextPromptEligible: false,
    };
  }

  if (shouldIgnoreLowSignalTranscript(trimmed, options.hasActiveTask)) {
    return {
      action: "ignore",
      reason: "low-signal",
      contextPromptEligible: false,
    };
  }

  if (options.hasActiveTask && hasFollowUpSignal(trimmed)) {
    return {
      action: "answer-refresh",
      reason: "active-task-followup",
      contextPromptEligible: true,
    };
  }

  if (hasTechnicalSignal(trimmed) && wordEquivalent >= 4) {
    return {
      action: "answer-refresh",
      reason: "technical-content",
      contextPromptEligible: true,
    };
  }

  if (wordEquivalent < 8) {
    return {
      action: "ignore",
      reason: "short-low-information",
      contextPromptEligible: false,
    };
  }

  return {
    action: "answer-refresh",
    reason: "substantive-transcript",
    contextPromptEligible: true,
  };
}

function normalizeTranscriptForGate(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.()]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasQuestionOrTaskSignal(text: string) {
  const normalized = normalizeTranscriptForGate(text);
  return (
    /[?？]/.test(text) ||
    /\b(can you|could you|would you|how would|how do|what is|what are|why|explain|describe|tell me|walk me through|design|build|implement|code|solve|compare|estimate|evaluate)\b/i.test(
      text
    ) ||
    /请|怎么|如何|为什么|解释|设计|实现|写一个|比较|估算/.test(text) ||
    /\b(system design|design a|design an|leetcode|algorithm|coding question|behavioral question)\b/i.test(
      normalized
    )
  );
}

function hasConstraintOrCorrectionSignal(text: string) {
  const normalized = normalizeTranscriptForGate(text);
  const hasCorrectionVerb =
    /\b(not|instead|rather than|use|using|assume|constraint|requirement|actually|i mean|correction|clarify|with|without)\b/i.test(
      normalized
    );
  const hasTechnicalObject =
    /\b(rag|retrieval augmented generation|rec|recommendation|python|java|javascript|typescript|go|golang|rust|c\+\+|sql|redis|postgres|mysql|qps|tps|latency|throughput|p99|memory|space|time|complexity|scale|users|requests|million|billion|k|m)\b/i.test(
      normalized
    );
  const hasNumericConstraint =
    /\b\d+\s*(qps|tps|rps|users|requests|ms|s|seconds|minutes|kb|mb|gb|tb|k|m|million|billion)\b/i.test(
      normalized
    );
  const hasDirectCorrection =
    /\b(rag\s+(not|instead of)|not\s+rec|not\s+recommendation|use\s+(go|golang|python|java|javascript|typescript|rust|c\+\+)|in\s+(go|golang|python|java|javascript|typescript|rust|c\+\+))\b/i.test(
      normalized
    );

  return (
    (hasCorrectionVerb && hasTechnicalObject) ||
    hasNumericConstraint ||
    hasDirectCorrection
  );
}

function isLowValueAcknowledgement(normalized: string) {
  if (!normalized) return true;

  const phrases = new Set([
    "ah",
    "eh",
    "er",
    "hmm",
    "mm",
    "mhm",
    "uh",
    "um",
    "yeah",
    "yep",
    "yes",
    "no",
    "ok",
    "okay",
    "right",
    "sure",
    "cool",
    "great",
    "nice",
    "that s nice",
    "that is nice",
    "sounds good",
    "that sounds good",
    "i see",
    "got it",
    "makes sense",
    "make sense",
    "so that s it",
    "so that is it",
    "that s it",
    "that is it",
  ]);

  if (phrases.has(normalized)) return true;

  return /^(yeah|ok|okay|right|sure|cool|great|nice|thanks|thank you)[\s,.!]*(that s|that is)?[\s\w,.!]*$/i.test(
    normalized
  ) && calculateWordEquivalent(normalized) <= 6;
}

function isMeetingLogisticsTranscript(normalized: string) {
  if (!normalized) return false;

  return (
    /\b(let me|i ll|i will|give me|one second|just a second|hold on|wait a second|give me a second|give me some time|take a look|share my screen|sharing my screen|open the screen|start our interview|start the interview|time to start|let s start|let us start|let me search|let me think|let me check)\b/i.test(
      normalized
    ) ||
    /等一下|稍等|我看一下|我想一下|我分享屏幕|开始面试|开始吧/.test(
      normalized
    )
  );
}

function shouldIgnoreLowSignalTranscript(
  transcript: string,
  hasActiveScreenTask: boolean
) {
  const trimmed = transcript.trim();
  if (!trimmed) return true;

  const normalized = trimmed
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.()]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return true;
  if (detectInterviewCompany(trimmed)) return false;
  if (hasTechnicalSignal(trimmed) || hasFollowUpSignal(trimmed)) return false;

  const fillerPhrases = new Set([
    "ah",
    "eh",
    "er",
    "hmm",
    "mm",
    "mhm",
    "uh",
    "um",
    "yeah",
    "yep",
    "yes",
    "no",
    "ok",
    "okay",
    "got it",
    "thanks",
    "thank you",
    "cool",
    "right",
    "sure",
    "sounds good",
    "that sounds good",
    "make sense",
    "makes sense",
    "i see",
    "let me see",
    "one second",
    "just a second",
    "give me a second",
    "hold on",
    "wait a second",
    "no problem",
    "all good",
    "great",
    "perfect",
    "嗯",
    "嗯嗯",
    "呃",
    "啊",
    "哦",
    "好",
    "好的",
    "对",
    "是",
    "是的",
    "可以",
    "谢谢",
    "没问题",
    "明白",
    "懂了",
    "了解",
    "等一下",
    "稍等",
  ]);

  if (fillerPhrases.has(normalized)) return true;

  if (hasActiveScreenTask) {
    return normalized.length < 40;
  }

  return normalized.length < 12 && !trimmed.includes("?");
}

function hasTechnicalSignal(text: string) {
  return (
    /\b(o\s*\(?\s*1|o\s*\(?\s*n|api|async|binary|cache|client|complexity|database|design|dp|embedding|graph|grpc|hash|heap|http|java|javascript|latency|leetcode|memory|python|queue|rag|rate limiter|recursion|rust|scale|search|server|space|sql|stack|thread|tree|typescript|vector)\b/i.test(
      text
    ) ||
    /算法|复杂度|缓存|数据库|队列|栈|堆|树|图|递归|并发|异步|接口|系统设计|限流|负载均衡|向量|嵌入/.test(
      text
    )
  );
}

function hasFollowUpSignal(text: string) {
  return /\b(can|could|would|should|how|why|what|when|where|which|explain|optimi[sz]e|improve|change|update|revise|shorter|follow up|edge case|tradeoff|constraint|requirement|same|different|another|instead)\b/i.test(
    text
  );
}

function isTaskSwitchTranscript(text: string) {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return false;

  return (
    /\b(next question|next task|new question|new task|move on|moving on|let s move on|let us move on|switch topic|different question|another question|start over)\b/i.test(
      normalized
    ) ||
    /下一题|下一个问题|下个问题|换一题|换个题|换个问题|新问题|新任务|进入下一|继续下一|换话题/.test(
      text
    )
  );
}
