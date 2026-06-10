import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useMicVAD } from "@ricky0123/vad-react";
import { STORAGE_KEYS } from "@/config";
import { useApp } from "@/contexts";
import { safeLocalStorage } from "@/lib";
import { floatArrayToWav } from "@/lib/utils";
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
  AdvisorRequestMode,
  ClarifyingQuestionAnswer,
  ClarifyingQuestionFeedback,
  MeetingAssistantState,
  MeetingAudioConfig,
  MeetingAudioStatus,
  MeetingAssistantSettings,
  MeetingAudioProfile,
  InterviewBriefType,
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
  PENDING_CONFIRMATION_TTL_MS,
  ScreenObservation,
  ScreenPreflightResult,
  SpeechCorrection,
  SpeechCorrectionRule,
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
  formatInterviewPlaybookForTrace,
  readTraceHumanEvaluations,
  buildSpeechBiasContext,
  formatSpeechBiasPromptForTrace,
  normalizeTranscriptWithSpeechBias,
  parseEmergencySpeechCorrection,
  serializeMeetingTraceExport,
  serializeMeetingTraceMetrics,
  solveScreenAnchoredTask,
  shouldIncludeTurnInAdvisorPrompt,
  shouldSuppressDuplicateSystemAudioTurn,
  transcribeMeetingAudio,
  upsertTraceHumanEvaluation,
  persistTraceHumanEvaluations,
} from "@/lib/meeting";

const ADVISOR_DEBOUNCE_MS = 750;
const STT_TIMEOUT_MS = 30_000;
const SCREEN_PREFLIGHT_TIMEOUT_MS = 10_000;
const SCREEN_ANALYSIS_TIMEOUT_MS = 45_000;
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

const DEFAULT_INTERVIEW_SESSION_BRIEF: InterviewSessionBrief = {
  targetCompany: "",
  targetCompanyNormalized: undefined,
  companyLocked: true,
  interviewTypes: [],
  focusAreas: "",
  notes: "",
};

const CONCRETE_INTERVIEW_TYPES: Exclude<InterviewBriefType, "mixed">[] = [
  "behavioral",
  "coding",
  "system-design",
  "ai-ml-system-design",
  "project-deep-dive",
];

const INITIAL_STATE: MeetingAssistantState = {
  status: "idle",
  transcriptTurns: [],
  screenObservations: [],
  interviewSessionBrief: undefined,
  interviewSessionContext: undefined,
  latestSuggestion: null,
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
    audio: {
      profile: "balanced",
      config: DEFAULT_MEETING_AUDIO_CONFIG,
    },
  },
  humanEvaluations: [],
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
    ? parsed.interviewTypes.filter(isInterviewBriefType)
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
  const uniqueTypes = Array.from(new Set(interviewTypes));
  const hasMixed = uniqueTypes.includes("mixed");
  const concreteTypes = CONCRETE_INTERVIEW_TYPES.filter((type) =>
    uniqueTypes.includes(type)
  );

  if (hasMixed || concreteTypes.length === CONCRETE_INTERVIEW_TYPES.length) {
    return [...CONCRETE_INTERVIEW_TYPES, "mixed"];
  }

  return concreteTypes;
}

function isInterviewBriefType(value: unknown): value is InterviewBriefType {
  return (
    value === "behavioral" ||
    value === "coding" ||
    value === "system-design" ||
    value === "ai-ml-system-design" ||
    value === "project-deep-dive" ||
    value === "mixed"
  );
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
    partialSuggestion: "",
    latestSuggestion:
      previous.latestSuggestion?.kind === "screen-task"
        ? null
        : previous.latestSuggestion,
    status:
      previous.status === "thinking"
        ? previous.audioStatus?.active
          ? "listening"
          : "idle"
        : previous.status,
    error: null,
  };
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

  return [
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
  ].join("\n\n");
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
  }));
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
  const speechCorrectionsRef = useRef<SpeechCorrection[]>([]);
  const microphoneContextEnabledRef = useRef(
    INITIAL_STATE.settings.microphoneContextEnabled
  );
  const speechDetectedHandlerRef = useRef<
    ((base64Audio: string) => void) | undefined
  >(undefined);

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

  const updateTraceHumanEvaluation = useCallback(
    (traceId: string, patch: Partial<TraceHumanEvaluation>) => {
      const trace = traceStoreRef.current
        .getTraces()
        .find((candidate) => candidate.id === traceId);
      if (!trace) return;

      setState((previous) => {
        const humanEvaluations = upsertTraceHumanEvaluation(
          previous.humanEvaluations,
          trace.id,
          trace.kind,
          patch
        );
        persistTraceHumanEvaluations(humanEvaluations);
        return {
          ...previous,
          humanEvaluations,
        };
      });
    },
    []
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

      setState((previous) => ({
        ...previous,
        lastTraceExport: record,
      }));

      return record;
    },
    []
  );

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
      persistInterviewSessionBrief(normalizedBrief);
      contextManagerRef.current.setInterviewSessionBrief(normalizedBrief);
      const contextState = contextManagerRef.current.getState();

      setState((previous) => ({
        ...previous,
        interviewSessionBrief: contextState.interviewSessionBrief,
        interviewSessionContext: contextState.interviewSessionContext,
      }));
    },
    []
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
        contextManagerRef.current.setActiveScreenTask({
          ...activeScreenTask,
          updatedAt: now,
          expiresAt: now + normalizedTimeoutMinutes * 60_000,
        });
        const contextState = contextManagerRef.current.getState();
        setState((previous) => ({
          ...previous,
          activeScreenTask: contextState.activeScreenTask,
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
    }: {
      traceId?: string;
      query: string;
      source: "advisor" | "screen";
      useCase?: MemoryUseCase;
      questionType?: MemoryQuestionType;
      askFrame?: MemoryAskFrame;
      topicDomain?: MemoryTopicDomain;
      projectAnchor?: string;
      memoryPolicy?: MemoryRetrievalPolicy;
    }): Promise<MemoryRetrievalResult | undefined> => {
      if (!state.settings.useMemory) return undefined;
      const resolvedQuestionType =
        questionType ?? inferMemoryQuestionTypeFromQuery(query);
      const resolvedUseCase = normalizeMemoryUseCaseForQuestionType(
        useCase ?? inferMemoryUseCaseFromQuery(query),
        resolvedQuestionType
      );
      const interviewTypes =
        contextManagerRef.current.getState().interviewSessionBrief
          ?.interviewTypes;

      let memoryStepId: string | undefined;
      try {
        if (traceId) {
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
              memoryPolicyId: memoryPolicy?.id,
              allowedFamilies: memoryPolicy?.allowedFamilies,
              blockedFamilies: memoryPolicy?.blockedFamilies,
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
          memoryPolicy,
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
              memoryPolicyId: memoryPolicy?.id,
              allowedFamilies: memoryPolicy?.allowedFamilies,
              blockedFamilies: memoryPolicy?.blockedFamilies,
              candidateCount: memoryContext.candidateCount,
              rejectedCount: memoryContext.rejectedCount,
              totalChars: memoryContext.totalChars,
            }
          );
          traceStoreRef.current.finishStep(traceId, memoryStepId, "success", {
            selectedEntries: memoryContext.entries.length,
            useCase: resolvedUseCase,
            questionType: resolvedQuestionType,
            askFrame,
            topicDomain,
            projectAnchor,
            interviewTypes,
            memoryPolicyId: memoryPolicy?.id,
            allowedFamilies: memoryPolicy?.allowedFamilies,
            blockedFamilies: memoryPolicy?.blockedFamilies,
            candidateCount: memoryContext.candidateCount,
            rejectedCount: memoryContext.rejectedCount,
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
    contextManagerRef.current.clearActiveScreenTask();
    setState(clearActiveScreenTaskState);
  }, [clearAdvisorDebounce]);

  const stop = useCallback(async () => {
    activeRef.current = false;
    invalidateAudioProcessingSession();
    clearAdvisorDebounce();
    advisorEngineRef.current.cancelCurrentRequest();
    screenAnalysisAbortRef.current?.abort();
    screenAnalysisAbortRef.current = null;
    contextManagerRef.current.clearActiveScreenTask();
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

    setState((previous) => ({
      ...previous,
      status: "idle",
      activeScreenTask: undefined,
      interviewSessionBrief: contextState.interviewSessionBrief,
      interviewSessionContext: contextState.interviewSessionContext,
      latestSuggestion:
        previous.latestSuggestion?.kind === "screen-task"
          ? null
          : previous.latestSuggestion,
      partialSuggestion: "",
      error: null,
      audioStatus,
    }));
  }, [clearAdvisorDebounce, invalidateAudioProcessingSession]);

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
    const advisorQuestionType = promptContext.activeScreenTask
      ? readMemoryQuestionType(promptContext.activeScreenTask.kind)
      : inferMemoryQuestionTypeFromQuery(advisorMemoryQuery);
    const advisorAskFrame = promptContext.activeScreenTask?.classifier?.askFrame
      ? readMemoryAskFrame(promptContext.activeScreenTask.classifier.askFrame)
      : inferMemoryAskFrameFromQuery(advisorMemoryQuery);
    const advisorTopicDomain = promptContext.activeScreenTask?.classifier
      ?.topicDomain
      ? readMemoryTopicDomain(
          promptContext.activeScreenTask.classifier.topicDomain
        )
      : inferMemoryTopicDomainFromQuery(advisorMemoryQuery);
    const advisorPlaybook =
      promptContext.activeScreenTask?.playbook ??
      selectInterviewPlaybook({
        query: advisorMemoryQuery,
        questionType: promptContext.activeScreenTask?.kind ?? advisorQuestionType,
        askFrame: advisorAskFrame,
        topicDomain: advisorTopicDomain,
        projectAnchor: promptContext.activeScreenTask?.classifier?.projectAnchor,
        classifierConfidence:
          promptContext.activeScreenTask?.classifier?.confidence,
        interviewSessionBrief: promptContext.interviewSessionBrief,
        interviewSessionContext: promptContext.interviewSessionContext,
      });

    if (traceId) {
      const playbookMetadata = formatInterviewPlaybookForTrace(advisorPlaybook);
      traceStoreRef.current.updateMetadata(traceId, playbookMetadata);
      if (advisorPlaybook) {
        const playbookStepId = traceStoreRef.current.startStep(
          traceId,
          "Interview playbook selected",
          playbookMetadata
        );
        traceStoreRef.current.finishStep(traceId, playbookStepId, "success");
      }
    }

    const memoryContext = await loadMemoryForPrompt({
      traceId,
      source: "advisor",
      query: advisorMemoryQuery,
      useCase: inferMemoryUseCaseFromQuery(advisorMemoryQuery),
      questionType: advisorQuestionType,
      askFrame: advisorAskFrame,
      topicDomain: advisorTopicDomain,
      projectAnchor: promptContext.activeScreenTask?.classifier?.projectAnchor,
      memoryPolicy: advisorPlaybook?.memoryPolicy,
    });
    promptContext = {
      ...promptContext,
      memoryContext: memoryContext?.contextText,
      interviewPlaybook: advisorPlaybook,
    };

    let finalContent = "";

    try {
      for await (const event of advisorEngineRef.current.streamSuggestion({
        requestId,
        mode,
        promptContext,
        provider: aiProvider,
        selectedProvider: selectedAIProvider,
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
                    imageCount: input.imageCount,
                  }
                );
                advisorStepId = traceStoreRef.current.startStep(
                  traceId,
                  "Advisor model response",
                  {
                    providerId: input.providerId,
                    mode: input.mode,
                    responseAction: input.responseAction,
                    responseLength: input.responseConfig?.length,
                    responseLanguage: input.responseConfig?.language,
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

      if (
        mode === "screen-anchored" &&
        contextState.activeScreenTask &&
        shouldUpdateActiveScreenTaskFromAdvisorOutput(finalContent)
      ) {
        const updatedAt = Date.now();
        const basedOnTurnIds =
          latestTurn &&
          !contextState.activeScreenTask.basedOnTurnIds.includes(latestTurn.id)
            ? [...contextState.activeScreenTask.basedOnTurnIds, latestTurn.id]
            : contextState.activeScreenTask.basedOnTurnIds;

        contextManagerRef.current.setActiveScreenTask({
          ...contextState.activeScreenTask,
          updatedAt,
          expiresAt: getActiveScreenTaskExpiresAt(state.settings, updatedAt),
          question:
            extractScreenTaskQuestion(finalContent) ||
            contextState.activeScreenTask.question,
          kind: inferScreenTaskKind(finalContent),
          language:
            inferScreenTaskLanguage(finalContent) ||
            contextState.activeScreenTask.language,
          content: finalContent.trim(),
          basedOnTurnIds,
        });
        contextState = contextManagerRef.current.getState();
      }

      const latestObservationIds = contextState.screenObservations.map(
        (observation) => observation.id
      );

      setState((previous) => ({
        ...previous,
        status: activeRef.current
          ? "listening"
          : returnStatus === "paused"
            ? "paused"
            : "idle",
        latestSuggestion: advisorEngineRef.current.toSuggestion(
          requestId,
          finalContent,
          latestTurn ? [latestTurn.id] : [],
          latestObservationIds
        ),
        interviewSessionContext: contextState.interviewSessionContext,
        activeScreenTask: contextState.activeScreenTask,
      }));
      if (traceId) {
        traceStoreRef.current.finishStep(traceId, advisorStepId, "success", {
          outputChars: finalContent.length,
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
        contextState.activeScreenTask ? "screen-anchored" : "live",
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

        const activeScreenTask = contextManagerRef.current.getState()
          .activeScreenTask;

        if (turn.speaker === "me") {
          const classification = classifyMeTurn(turn, Boolean(activeScreenTask));
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

        if (activeScreenTask && isTaskSwitchTranscript(turn.text)) {
          const switchStepId = traceStoreRef.current.startStep(
            traceId,
            "Task switch confirmation requested",
            {
              turnId: turn.id,
              activeScreenTaskId: activeScreenTask.id,
              transcriptChars: turn.text.trim().length,
            }
          );
          traceStoreRef.current.finishStep(traceId, switchStepId, "success");
          traceStoreRef.current.finishTrace(traceId, "success");
          setState((previous) => ({
            ...previous,
            status: activeRef.current ? "listening" : "idle",
            partialSuggestion: "",
            latestSuggestion: {
              id: createMeetingId("task_switch"),
              kind: "clarifying-question",
              content: [
                "中文思路: 这听起来像是在切换到新题或新任务。",
                "Reply: -",
                "Question: Should I treat this as a new task?",
              ].join("\n"),
              createdAt: Date.now(),
              basedOnTurnIds: [turn.id],
              basedOnObservationIds: [activeScreenTask.observationId],
              confidence: "medium",
            },
          }));
          return;
        }

        if (shouldIgnoreLowSignalTranscript(turn.text, Boolean(activeScreenTask))) {
          const clarificationMatch = findRecentMeClarificationForTurn(
            turn,
            contextManagerRef.current.getState().transcriptTurns
          );
          if (clarificationMatch) {
            promoteMeTurnForFusion(clarificationMatch.meTurn, turn.id);
            turn.contextFusionStatus = "paired";
            turn.relatedTurnIds = [clarificationMatch.meTurn.id];
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
              }
            );
            const debounceStepId = traceStoreRef.current.startStep(
              traceId,
              "Advisor debounce scheduled",
              { debounceMs: ADVISOR_DEBOUNCE_MS, reason: "clarification-pair" }
            );
            traceStoreRef.current.finishStep(
              traceId,
              debounceStepId,
              "success"
            );
            scheduleAdvisor(
              contextState.activeScreenTask ? "screen-anchored" : "live",
              traceId
            );
            return;
          }

          if (isShortConfirmationLike(turn.text)) {
            holdPendingConfirmation(turn, segment);
            return;
          }

          const ignoredStepId = traceStoreRef.current.startStep(
            traceId,
            "Transcript ignored",
            {
              reason: "low-signal",
              transcriptChars: turn.text.trim().length,
              activeScreenTask: Boolean(activeScreenTask),
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

        const { contextState } = appendTranscriptTurnForTrace(
          turn,
          traceId,
          segment
        );

        const debounceStepId = traceStoreRef.current.startStep(
          traceId,
          "Advisor debounce scheduled",
          { debounceMs: ADVISOR_DEBOUNCE_MS }
        );
        traceStoreRef.current.finishStep(traceId, debounceStepId, "success");
        scheduleAdvisor(
          contextState.activeScreenTask ? "screen-anchored" : "live",
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

      if (resetContext) {
        contextManagerRef.current.reset();
        speechCorrectionsRef.current = [];
        latestScreenHashRef.current = undefined;
        screenAnalysisAbortRef.current?.abort();
        screenAnalysisAbortRef.current = null;
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
        ...(resetContext
          ? {
              ...INITIAL_STATE,
              settings: previous.settings,
              interviewSessionBrief: contextState.interviewSessionBrief,
              speechCorrections: [],
            }
          : previous),
        status: "listening",
        transcriptTurns: contextState.transcriptTurns,
        screenObservations: contextState.screenObservations,
        interviewSessionBrief: contextState.interviewSessionBrief,
        interviewSessionContext: contextState.interviewSessionContext,
        activeScreenTask: contextState.activeScreenTask,
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
        const shouldRunScreenPreflight = state.settings.useMemory;

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
                questionType: screenPreflight.questionType,
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
              questionType: screenPreflight.questionType,
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
                questionType: screenPreflight.questionType,
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
        const screenPlaybookMetadata =
          formatInterviewPlaybookForTrace(screenPlaybook);
        traceStoreRef.current.updateMetadata(trace.id, screenPlaybookMetadata);
        if (screenPlaybook) {
          const playbookStepId = traceStoreRef.current.startStep(
            trace.id,
            "Interview playbook selected",
            screenPlaybookMetadata
          );
          traceStoreRef.current.finishStep(trace.id, playbookStepId, "success");
        }

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
        const screenTaskContent = await withTimeout(
          solveScreenAnchoredTask({
            observation,
            provider: aiProvider,
            selectedProvider: selectedAIProvider,
            recentTranscript,
            autoPrompt,
            responseConfig: state.settings.response,
            memoryContext: memoryContext?.contextText,
            interviewSessionBrief: preflightContextState.interviewSessionBrief,
            interviewSessionContext:
              preflightContextState.interviewSessionContext,
            screenPreflight,
            interviewPlaybook: screenPlaybook,
            signal: analysisController.signal,
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
                    imageBase64Stored: false,
                  }
                );
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
          SCREEN_ANALYSIS_TIMEOUT_MS,
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
        const taskKind =
          screenPreflight?.questionType &&
          screenPreflight.questionType !== "unknown"
            ? screenPreflight.questionType
            : inferScreenTaskKind(screenTaskContent);
        const now = Date.now();

        if (screenTaskContent.trim() && taskKind !== "non-question") {
          contextManagerRef.current.setActiveScreenTask({
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
          });
        } else {
          contextManagerRef.current.clearActiveScreenTask();
        }

        updatedContextState = contextManagerRef.current.getState();
        const uiStepId = traceStoreRef.current.startStep(
          trace.id,
          "Meeting Assistant state updated",
          {
            activeScreenTaskId: updatedContextState.activeScreenTask?.id,
            suggestionKind: screenTaskContent.trim() ? "screen-task" : "silent",
          }
        );

        setState((previous) => ({
          ...previous,
          status: activeRef.current ? "listening" : idleReturnStatus,
          partialSuggestion: "",
          screenObservations: updatedContextState.screenObservations,
          activeScreenTask: updatedContextState.activeScreenTask,
          interviewSessionContext: updatedContextState.interviewSessionContext,
          latestSuggestion: screenTaskContent.trim()
            ? {
                id: requestId,
                kind: "screen-task",
                content: screenTaskContent.trim(),
                screenTaskAnswer: parseScreenTaskAnswer(
                  screenTaskContent.trim()
                ),
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
              },
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
      selectedAIProvider,
      screenshotConfiguration,
      state.settings,
      state.status,
    ]
  );

  const currentSuggestionText =
    state.partialSuggestion || state.latestSuggestion?.content || "";

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
        contextManagerRef.current.getState().activeScreenTask
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

      setState((previous) => ({
        ...previous,
        error: null,
        speechCorrections: updatedCorrections,
        transcriptTurns: nextContextState.transcriptTurns,
        interviewSessionContext: nextContextState.interviewSessionContext,
        activeScreenTask: nextContextState.activeScreenTask,
      }));

      traceStoreRef.current.finishTrace(trace.id, "success");

      if (didUpdateTranscript) {
        await runAdvisor({
          force: true,
          mode: nextContextState.activeScreenTask ? "screen-anchored" : "live",
          currentSuggestion: currentSuggestionText,
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
      maybeAutoExportTraces(traces);
    });
  }, [maybeAutoExportTraces, scheduleTraceMetricsPersistence]);

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
      if (contextManagerRef.current.clearExpiredActiveScreenTask()) {
        setState(clearActiveScreenTaskState);
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
    setResponseConfig,
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
    regenerateSuggestion,
    applyResponseAction,
    answerClarifyingQuestion,
    submitSpeechCorrection,
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
      context.activeScreenTask?.question,
      context.activeScreenTask?.content,
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
    context.activeScreenTask
      ? [
          `active task: ${context.activeScreenTask.question || ""}`,
          `active task type: ${context.activeScreenTask.kind}`,
          context.activeScreenTask.classifier?.askFrame
            ? `active task ask frame: ${context.activeScreenTask.classifier.askFrame}`
            : undefined,
          context.activeScreenTask.classifier?.topicDomain
            ? `active task topic domain: ${context.activeScreenTask.classifier.topicDomain}`
            : undefined,
          context.activeScreenTask.classifier?.projectAnchor
            ? `active task project anchor: ${context.activeScreenTask.classifier.projectAnchor}`
            : undefined,
          context.activeScreenTask.content,
        ]
          .filter(Boolean)
          .join("\n")
      : undefined,
    context.transcript ? `transcript:\n${context.transcript}` : undefined,
    context.screenContext ? `screen:\n${context.screenContext}` : undefined,
    currentSuggestion ? `current suggestion:\n${currentSuggestion}` : undefined,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(-8000);
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
  if (questionType === "behavioral") return "behavioral_interview";
  if (questionType === "coding") return "coding_interview";
  if (
    questionType === "general-system-design" ||
    questionType === "system-design" ||
    questionType === "ai-ml-system-design" ||
    questionType === "project-deep-dive" ||
    questionType === "field-knowledge"
  ) {
    return useCase === "behavioral_interview" ? "meeting_assistant" : useCase;
  }
  return useCase;
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
  const normalized = query.toLowerCase();

  if (
    /\b(leetcode|algorithm|coding|complexity|typescript|javascript|python|java|rust|go|golang|dp|graph|tree|heap|stack|queue)\b/.test(
      normalized
    )
  ) {
    return "coding";
  }

  if (
    /\b(project deep dive|project dive|deep dive|tell me about your project|walk me through your project|technical deep dive|your most complex project|previous project|past project|your work on)\b/.test(
      normalized
    )
  ) {
    return "project-deep-dive";
  }

  if (
    hasAiMlDesignSignal(normalized)
  ) {
    return "ai-ml-system-design";
  }

  if (
    /\b(system design|design a|design an|architecture|distributed system|high concurrency|scalability|ticket selling|rate limiter|consistent|consistency|database sharding)\b/.test(
      normalized
    )
  ) {
    return "general-system-design";
  }

  if (
    /\b(what is|what are|explain|compare|why|how does|tradeoff|trade-off|pros and cons|advantages|disadvantages)\b/.test(
      normalized
    ) &&
    /\b(ai|ml|llm|rag|retrieval augmented generation|embedding|vector database|vector db|model serving|inference|fine tuning|finetuning|training|evaluation|evals|transformer|attention|tokenization|lora|qlora|rlhf|dpo|agent|agentic|mcp|kv cache|quantization|cap theorem|consistent hashing|sharding|replication|cache|queue|database|distributed)\b/.test(
      normalized
    )
  ) {
    return "field-knowledge";
  }

  if (
    /\b(behavior|behaviour|leadership principle|star|tell me about a time|give me an example of a time|describe a time|have you ever|conflict|disagree|failed|commitment|ownership|bias for action|customer obsession)\b/.test(
      normalized
    )
  ) {
    return "behavioral";
  }

  return "unknown";
}

function readMemoryQuestionType(
  value: string | undefined
): MemoryQuestionType | undefined {
  if (
    value === "behavioral" ||
    value === "coding" ||
    value === "system-design" ||
    value === "general-system-design" ||
    value === "ai-ml-system-design" ||
    value === "project-deep-dive" ||
    value === "field-knowledge" ||
    value === "unknown"
  ) {
    return value;
  }
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

function hasAiMlDesignSignal(normalized: string) {
  return (
    /\b(ai|ml|llm|rag|retrieval augmented generation|embedding|model serving|inference|vector database|agentic|model routing|evals|fine tuning|training pipeline)\b/.test(
      normalized
    ) &&
    /\b(system design|design a|design an|architecture|pipeline|platform|service|build|scalability|latency|throughput)\b/.test(
      normalized
    )
  );
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
    /\b(o\s*\(?\s*1|o\s*\(?\s*n|api|async|binary|cache|client|complexity|database|design|dp|embedding|graph|grpc|hash|heap|http|java|javascript|latency|leetcode|memory|python|queue|rag|rate limiter|recursion|rust|scale|search|server|space|sql|stack|thread|time|tree|typescript|vector)\b/i.test(
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
