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
  buildRuntimeMemoryRoleTelemetry,
  extractRuntimeFactAnchorLabels,
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
  AdvisorTriggerJob,
  AdvisorJobSource,
  AdvisorTaskMutationAuthority,
  RuntimeCommitToken,
  AdvisorTurnIntentDecision,
  ActiveMeetingTask,
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
  PersonalEvidenceGuardrailMode,
  MeetingResponseActionMode,
  MeetingResponseConfig,
  ManualQuestionTypeCorrection,
  ManualQuestionTypeCorrectionSource,
  NativeSpeechDetectedEvent,
  WhiteboardUpdateSource,
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
  ParsedMeetingAnswer,
  QuestionEvaluationIdentity,
  QuestionHumanEvaluation,
  QuestionInstanceLineage,
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
  buildDiagramOverlayEvalTraceMetadata,
  buildInterviewSessionBriefMemoryHint,
  buildInterviewSessionMemoryHint,
  buildWhiteboardEvalTraceMetadata,
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
  isShortConfirmationLike,
  buildMeetingAnswerSummary,
  CaptureLifecycleCoordinator,
  authorizeNativeAudioLifecycleEvent,
  authorizeNativeSpeechDetectedEvent,
  buildNativeAudioLifecycleTraceMetadata,
  buildNativeSpeechEventTraceMetadata,
  buildMemoryEvaluationTraceMetadata,
  formatMeetingAnswerTraceMetadata,
  parseMeetingAnswer,
  parseMeetingTraceMetrics,
  resolveMeetingAnswerProfile,
  preflightScreenObservation,
  selectInterviewPlaybook,
  applyPlaybookPhaseDecisionToProgress,
  decideManualNextPhaseTransition,
  decidePlaybookPhaseProgression,
  formatPlaybookPhaseDecisionForTrace,
  formatInterviewPlaybookForTrace,
  withInterviewPlaybookPhase,
  readTraceHumanEvaluations,
  readQuestionHumanEvaluations,
  readMeetingEvalTraceMetadata,
  resolveTraceMemoryEvaluationSnapshot,
  resolveSuggestionQuestionLineage,
  resolveActiveMeetingTaskIdentity,
  buildSpeechBiasContext,
  formatSpeechBiasPromptForTrace,
  normalizeTranscriptWithSpeechBias,
  parseEmergencySpeechCorrection,
  serializeMeetingTraceExport,
  serializeMeetingTraceMetrics,
  inferTrustedProgrammingLanguage,
  updateWhiteboardArtifactFromAnswer,
  SessionRecordingManager,
  areCompatibleQuestionTypes,
  authorizeAdvisorExecution,
  createAdvisorTriggerJob,
  authorizeRuntimeCommit,
  buildRuntimeCommitSnapshot,
  createRuntimeCommitToken,
  decideAdvisorPhaseMutation,
  decideAdvisorTaskMutation,
  formatAdvisorTriggerJobForTrace,
  formatRuntimeCommitAuthorizationForTrace,
  rebaseRuntimeCommitToken,
  rebaseRuntimeCommitTokenAfterOwnedParentMutation,
  canQuestionTypeDecisionOverrideParent,
  decideAdvisorTurnIntent,
  decideSentenceCompletion,
  decideLatestTurnTaxonomyBoundary,
  formatAdvisorTurnIntentForTrace,
  inferCanonicalQuestionTypeFromText,
  inferQuestionTypeDecisionFromText,
  isParentCanonicalQuestionType,
  normalizeCanonicalQuestionType,
  mergeSentenceFragments,
  normalizeInterviewBriefTypes as normalizeTaxonomyInterviewBriefTypes,
  normalizeQuestionTypeAlias,
  readInterviewBriefType,
  resolveTaskTaxonomyAuthority,
  toHumanEvalQuestionType,
  toMemoryUseCaseForQuestionType,
  type QuestionTypeInferenceDecision,
  type LatestTurnTaxonomyBoundaryReason,
  type TaskTaxonomyAuthorityDecision,
  solveScreenAnchoredTask,
  shouldIncludeTurnInAdvisorPrompt,
  shouldSuppressDuplicateSystemAudioTurn,
  transcribeMeetingAudio,
  upsertTraceHumanEvaluation,
  upsertQuestionHumanEvaluation,
  buildQuestionEvaluationPatchFromTrace,
  decideManualQuestionTypeCorrection,
  applyManualQuestionTypeCorrectionToParent,
  ManualCorrectionOperationCoordinator,
  decideInterviewTaskContinuityBranch,
  applyInterviewChildProbeTransition,
  persistTraceHumanEvaluations,
  persistQuestionHumanEvaluations,
  buildSessionRecordingProviderSummary,
  buildFactAnchorDecision,
  detectPersonalEvidenceRequirement,
  formatFactAnchorDecisionForTrace,
  formatProjectBindingDecisionForTrace,
  projectBindingMatchesProjectHint,
  resolveProjectBinding,
  getActiveMeetingTaskTraceMetadata,
  areSuggestionsForSameParentTask,
  buildSuggestionTaskMetadata,
  clearSuggestionProjectionForManualCorrection,
  applyAdvisorScreenScopeToPromptContext,
  decideAdvisorScreenScope,
  decideScreenResultScope,
  formatScreenScopeDecisionForTrace,
  resolveAdvisorRequestModeForScreenScope,
  resolveAdvisorTaskEvidenceSource,
  PlaybookPhaseDecision,
  SENTENCE_COMPLETION_BUFFER_MS,
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
const NO_ACTIVE_TASK_MESSAGE = "There is no active task to advance yet.";

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
    personalEvidenceGuardrailMode: "enforcement",
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
    lifecycle: "idle",
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
      personalEvidenceGuardrailMode:
        isPersonalEvidenceGuardrailMode(parsed.personalEvidenceGuardrailMode)
          ? parsed.personalEvidenceGuardrailMode
          : DEFAULT_MEETING_ASSISTANT_SETTINGS.personalEvidenceGuardrailMode,
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

function formatTaskTaxonomyAuthorityForTrace(
  decision: TaskTaxonomyAuthorityDecision
) {
  return {
    taxonomyAuthoritySource: decision.authoritySource,
    taxonomyCandidateType: decision.candidateType,
    taxonomyEffectiveType: decision.effectiveQuestionType,
    taxonomyMutationAuthorized: decision.mutationAuthorized,
    taxonomyMutationApplied: decision.mutationApplied,
    taxonomyAuthorityReason: decision.reason,
    taxonomyGeneratedAnswerExcluded: decision.generatedAnswerExcluded,
    taxonomyBlockedGeneratedAnswerType:
      decision.blockedGeneratedAnswerType,
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

function applyManualQuestionTypeCorrectionToScreenTask({
  task,
  correctedType,
  correctedPlaybook,
  askFrame,
  topicDomain,
  now,
  expiresAt,
}: {
  task: ActiveScreenTask;
  correctedType: CanonicalQuestionType;
  correctedPlaybook?: ActiveScreenTask["playbook"];
  askFrame: TaskAskFrame;
  topicDomain?: TaskTopicDomain;
  now: number;
  expiresAt?: number;
}): ActiveScreenTask {
  return {
    ...task,
    updatedAt: now,
    expiresAt,
    question: task.question || extractScreenTaskQuestion(task.content),
    kind: correctedType,
    classifier: {
      ...task.classifier,
      questionType: correctedType,
      askFrame,
      topicDomain,
      confidence: 1,
      overrideSource: "interview-type-selector",
      overrideAt: now,
    },
    playbook: correctedPlaybook,
    content: buildManualInterviewTypeOverrideContent(task, correctedType),
  };
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
      isScreenAnchoredSuggestion(previous.latestSuggestion)
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
    manualQuestionTypeCorrection: undefined,
  };
}

function isScreenAnchoredSuggestion(
  suggestion: AdvisorSuggestion | null | undefined
) {
  return (
    suggestion?.taskSource === "screen" ||
    suggestion?.taskSource === "mixed"
  );
}

function resolveCorrectionQuestionInstance(
  evaluations: QuestionHumanEvaluation[],
  suggestion: AdvisorSuggestion | null,
  activeTask: ActiveMeetingTask,
  fallbackTraceId: string
) {
  const suggestionMatchesTask = Boolean(
    suggestion &&
      suggestion.parentTaskId === activeTask.parent.id &&
      (!activeTask.child?.id || suggestion.childTaskId === activeTask.child.id)
  );
  const sourceTraceId = suggestionMatchesTask && suggestion
    ? suggestion?.sourceTraceId
    : undefined;
  const sourceEvaluation = sourceTraceId
    ? evaluations.find((evaluation) =>
        evaluation.traceIds.includes(sourceTraceId)
      )
    : undefined;
  const latestTaskEvaluation = [...evaluations]
    .reverse()
    .find(
      (evaluation) =>
        evaluation.parentTaskId === activeTask.parent.id &&
        (!activeTask.child?.id ||
          evaluation.childTaskId === activeTask.child.id)
    );

  return {
    questionId:
      sourceEvaluation?.questionId ??
      (sourceTraceId ? `trace:${sourceTraceId}` : undefined) ??
      latestTaskEvaluation?.questionId ??
      `trace:${fallbackTraceId}`,
    sourceTraceId,
  };
}

function withLatestReliableSuggestion(
  previous: MeetingAssistantState,
  nextSuggestion: AdvisorSuggestion,
  options: { clearPrevious?: boolean } = {}
): Pick<MeetingAssistantState, "latestSuggestion" | "latestReliableSuggestion"> {
  const previousSuggestion = previous.latestSuggestion;
  const previousSuggestionMatchesTask = areSuggestionsForSameParentTask(
    previousSuggestion,
    nextSuggestion
  );
  const existingReliableMatchesTask = areSuggestionsForSameParentTask(
    previous.latestReliableSuggestion,
    nextSuggestion
  );
  const latestReliableSuggestion =
    options.clearPrevious
      ? null
      : previousSuggestion &&
          previousSuggestionMatchesTask &&
          isCacheableReliableSuggestion(previousSuggestion) &&
          previousSuggestion.content.trim() !== nextSuggestion.content.trim()
        ? previousSuggestion
        : existingReliableMatchesTask
          ? previous.latestReliableSuggestion
          : null;

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
    suggestion.kind === "answer" ||
    content.length >= 80
  );
}

interface InterviewTaskContinuityResult {
  task?: ActiveInterviewParent;
  startedNewParent: boolean;
  clearedParent: boolean;
}

interface AdvisorTaskSignals {
  questionType: MemoryQuestionType;
  questionTypeDecision?: QuestionTypeInferenceDecision;
  askFrame: MemoryAskFrame;
  topicDomain: MemoryTopicDomain;
  projectAnchor?: string;
  query: string;
  taskRelation: InterviewTaskRelation;
  subtaskIntent: InterviewSubtaskIntent;
  source: string;
  reuseActivePlaybook: boolean;
  openingRoute?: OpeningRouteContext;
  latestTurnAskFrame?: MemoryAskFrame;
  latestTurnTaxonomyBoundaryReason?:
    | LatestTurnTaxonomyBoundaryReason
    | "active-parent-continuity"
    | "manual-question-type-correction";
  taxonomyFallbackSuppressed?: boolean;
  unknownTaskMutationBlocked?: boolean;
}

function preserveCodingResponseActionSections(
  generatedContent: string,
  sourceSuggestion: string | undefined
) {
  const source = sourceSuggestion?.trim();
  if (!source) return generatedContent;

  const sourceAnswer = parseMeetingAnswer(source).sections;
  const sourceCode = sourceAnswer.code?.trim();
  if (!sourceCode) return generatedContent;

  const generatedAnswer = parseMeetingAnswer(generatedContent).sections;
  if (generatedAnswer.code?.trim()) return generatedContent;

  const clarifyingOptions =
    formatClarifyingOptionsForSection(generatedAnswer.clarifyingOptions) ||
    formatClarifyingOptionsForSection(sourceAnswer.clarifyingOptions);

  return [
    `中文思路: ${
      generatedAnswer.chineseThinking || sourceAnswer.chineseThinking || "-"
    }`,
    `Question: ${generatedAnswer.question || sourceAnswer.question || "-"}`,
    `Answer: ${generatedAnswer.answer || sourceAnswer.answer || "-"}`,
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
  options: ReturnType<typeof parseMeetingAnswer>["sections"]["clarifyingOptions"]
) {
  return options.map((option) => option.label).filter(Boolean).join(" | ");
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

function isPersonalEvidenceGuardrailMode(
  value: unknown
): value is PersonalEvidenceGuardrailMode {
  return value === "enforcement" || value === "shadow";
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
  manualQuestionTypeCorrection?: ManualQuestionTypeCorrection;
  turnIntentDecision?: AdvisorTurnIntentDecision;
  triggerTurnId?: string;
  advisorJob?: AdvisorTriggerJob;
  advisorJobSource?: AdvisorJobSource;
  taskMutationAuthority?: AdvisorTaskMutationAuthority;
  questionLineage?: QuestionInstanceLineage;
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
  nativeCaptureSessionId?: string;
  nativeSegmentSequence?: number;
  nativeCapturedAtMs?: number;
  traceId: string;
  queueStepId: string;
}

interface PendingConfirmation {
  turn: TranscriptTurn;
  segment: QueuedSpeechSegment;
  heldAt: number;
  timeoutId: number;
}

interface PendingSentenceCompletion {
  operationId: string;
  turn: TranscriptTurn;
  segment: QueuedSpeechSegment;
  heldAt: number;
  firstHeldAt: number;
  timeoutId: number;
  continuationSequence?: number;
  fragmentTurnIds: string[];
  fragmentTraceIds: string[];
  fragmentSequences: number[];
}

interface SentenceCompletionMergeContext {
  operationId: string;
  firstHeldAt: number;
  fragmentTurnIds: string[];
  fragmentTraceIds: string[];
  fragmentSequences: number[];
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
  const traceMetricsPersistRetryTimerRef = useRef<number | null>(null);
  const traceMetricsPersistQueueRef = useRef<Promise<void>>(Promise.resolve());
  const queuedTraceMetricsPayloadsRef = useRef(new Set<string>());
  const traceMetricsPersistenceReadyRef = useRef(false);
  const lastTraceMetricsPayloadRef = useRef<string | null>(null);
  const autoExportProcessedTraceIdsRef = useRef(new Set<string>());
  const sessionRecordedTraceIdsRef = useRef(new Set<string>());
  const debugModeRef = useRef(INITIAL_STATE.settings.debugMode);
  const captureLifecycleCoordinatorRef = useRef<CaptureLifecycleCoordinator | null>(
    null
  );
  if (captureLifecycleCoordinatorRef.current === null) {
    captureLifecycleCoordinatorRef.current = new CaptureLifecycleCoordinator(
      (event) => {
        const metadata = {
          operationId: event.operationId,
          action: event.action,
          stage: event.stage,
          occurredAt: event.occurredAt,
          authorized: event.authorized,
          detail: event.detail,
          error: event.error,
        };
        console.info(
          `[${new Date(event.occurredAt).toISOString()}] [capture-lifecycle] ${event.stage}`,
          JSON.stringify(metadata)
        );
        sessionRecordingManagerRef.current?.recordCaptureLifecycle(metadata);
      }
    );
  }
  const activeRef = useRef(false);
  const latestScreenHashRef = useRef<string | undefined>(undefined);
  const advisorDebounceTimerRef = useRef<number | null>(null);
  const activeAdvisorJobRef = useRef<AdvisorTriggerJob | null>(null);
  const screenAnalysisAbortRef = useRef<AbortController | null>(null);
  const runtimeEpochRef = useRef(1);
  const activeScreenOperationIdRef = useRef<string | null>(null);
  const manualCorrectionOperationCoordinatorRef = useRef(
    new ManualCorrectionOperationCoordinator()
  );
  const audioSessionIdRef = useRef(createMeetingId("audio_session"));
  const audioSegmentSeqRef = useRef(0);
  const nativeCaptureSessionIdRef = useRef<string | null>(null);
  const nativeCaptureGenerationRef = useRef<number | null>(null);
  const lastNativeSegmentSequenceRef = useRef(0);
  const systemAudioQueueTailRef = useRef<Promise<void>>(Promise.resolve());
  const microphoneAudioQueueTailRef = useRef<Promise<void>>(Promise.resolve());
  const pendingConfirmationRef = useRef<PendingConfirmation | null>(null);
  const pendingSentenceCompletionRef =
    useRef<PendingSentenceCompletion | null>(null);
  const speechCorrectionsRef = useRef<SpeechCorrection[]>([]);
  const microphoneContextEnabledRef = useRef(
    INITIAL_STATE.settings.microphoneContextEnabled
  );
  const speechDetectedHandlerRef = useRef<
    ((event: NativeSpeechDetectedEvent) => void) | undefined
  >(undefined);

  const readRuntimeCommitSnapshot = useCallback(
    () =>
      buildRuntimeCommitSnapshot({
        runtimeEpoch: runtimeEpochRef.current,
        contextState: contextManagerRef.current.getState(),
      }),
    []
  );

  const advanceRuntimeEpoch = useCallback((reason: string) => {
    const previousEpoch = runtimeEpochRef.current;
    runtimeEpochRef.current += 1;
    activeScreenOperationIdRef.current = null;
    manualCorrectionOperationCoordinatorRef.current.reset();
    return {
      runtimeInvalidationReason: reason,
      previousRuntimeEpoch: previousEpoch,
      runtimeEpoch: runtimeEpochRef.current,
    };
  }, []);

  const finishRunningAdvisorJobTrace = useCallback(
    (
      job: AdvisorTriggerJob,
      status: "success" | "error" | "cancelled",
      metadata: Record<string, unknown>,
      error?: unknown
    ) => {
      if (!job.traceId) return;

      const trace = traceStoreRef.current
        .getTraces()
        .find((candidate) => candidate.id === job.traceId);
      if (!trace || trace.status !== "running") return;

      traceStoreRef.current.updateMetadata(job.traceId, metadata);
      for (const step of trace.steps) {
        if (step.status === "running") {
          traceStoreRef.current.finishStep(
            job.traceId,
            step.id,
            status,
            metadata,
            error
          );
        }
      }
      traceStoreRef.current.finishTrace(job.traceId, status, error);
    },
    []
  );

  const cancelActiveAdvisorJob = useCallback(
    (
      reason: string,
      outcome:
        | "replaced-before-execution"
        | "cancelled-by-new-job"
        | "cancelled-by-runtime-boundary" =
        "cancelled-by-runtime-boundary"
    ) => {
      const hadPendingTimer = advisorDebounceTimerRef.current !== null;
      if (advisorDebounceTimerRef.current !== null) {
        window.clearTimeout(advisorDebounceTimerRef.current);
        advisorDebounceTimerRef.current = null;
      }

      const job = activeAdvisorJobRef.current;
      activeAdvisorJobRef.current = null;
      advisorEngineRef.current.cancelCurrentRequest();
      if (!job) return;

      const resolvedOutcome = hadPendingTimer
        ? "replaced-before-execution"
        : outcome;
      finishRunningAdvisorJobTrace(
        job,
        "cancelled",
        formatAdvisorTriggerJobForTrace(job, resolvedOutcome, {
          cancellationReason: reason,
          commitAuthorized: false,
          commitAuthorizationReason: reason,
        }),
        reason
      );
    },
    [finishRunningAdvisorJobTrace]
  );

  const activateAdvisorJob = useCallback(
    (job: AdvisorTriggerJob) => {
      if (activeAdvisorJobRef.current?.id !== job.id) {
        cancelActiveAdvisorJob(
          `replaced-by-${job.id}`,
          "cancelled-by-new-job"
        );
      }
      activeAdvisorJobRef.current = job;
      if (job.traceId) {
        traceStoreRef.current.updateMetadata(
          job.traceId,
          formatAdvisorTriggerJobForTrace(job, "scheduled")
        );
      }
    },
    [cancelActiveAdvisorJob]
  );

  const releaseAdvisorJob = useCallback(
    (
      job: AdvisorTriggerJob,
      outcome: "committed" | "suppressed" | "error",
      extra: {
        commitAuthorized?: boolean;
        commitAuthorizationReason?: string;
      } = {}
    ) => {
      if (job.traceId) {
        traceStoreRef.current.updateMetadata(
          job.traceId,
          formatAdvisorTriggerJobForTrace(job, outcome, extra)
        );
      }
      if (activeAdvisorJobRef.current?.id === job.id) {
        activeAdvisorJobRef.current = null;
      }
    },
    []
  );

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

  const clearPendingSentenceCompletionForRuntimeReset = useCallback(
    (reason: string) => {
      const pending = pendingSentenceCompletionRef.current;
      if (!pending) return;

      window.clearTimeout(pending.timeoutId);
      pendingSentenceCompletionRef.current = null;
      traceStoreRef.current.updateMetadata(pending.segment.traceId, {
        sentenceBufferOperationId: pending.operationId,
        sentenceBufferOperationRole: "terminal",
        sentenceBufferOutcome: "cancelled",
        sentenceBufferDisposition: "cancelled",
        sentenceBufferFlushReason: reason,
        sentenceBufferFragmentCount: pending.fragmentTurnIds.length,
        sentenceBufferAddedLatencyMs: Date.now() - pending.firstHeldAt,
        sentenceBufferTurnIds: pending.fragmentTurnIds,
        sentenceBufferTraceIds: pending.fragmentTraceIds,
        sentenceBufferSegmentSequences: pending.fragmentSequences,
      });
      const resetStepId = traceStoreRef.current.startStep(
        pending.segment.traceId,
        "Sentence completion buffer cleared by runtime reset",
        {
          reason,
          turnId: pending.turn.id,
          heldMs: Date.now() - pending.firstHeldAt,
          fragmentCount: pending.fragmentTurnIds.length,
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
        `Sentence completion buffer cleared: ${reason}`
      );
    },
    []
  );

  const resetMeetingRuntimeForNewSession = useCallback(
    (reason: string) => {
      const runtimeBoundary = advanceRuntimeEpoch(reason);
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
          pendingSentenceCompletionRef.current
      );

      cancelActiveAdvisorJob(reason);
      screenAnalysisAbortRef.current?.abort();
      screenAnalysisAbortRef.current = null;
      speechCorrectionsRef.current = [];
      latestScreenHashRef.current = undefined;

      audioSessionIdRef.current = createMeetingId(
        activeRef.current ? "audio_session" : "audio_session_inactive"
      );
      audioSegmentSeqRef.current = 0;
      systemAudioQueueTailRef.current = Promise.resolve();
      microphoneAudioQueueTailRef.current = Promise.resolve();
      clearPendingConfirmationForRuntimeReset(reason);
      clearPendingSentenceCompletionForRuntimeReset(reason);

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
        manualQuestionTypeCorrection: undefined,
      }));

      return {
        ...runtimeBoundary,
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
          "pendingSentenceCompletion",
          "advisorDebounce",
          "screenAnalysis",
          "latestScreenHash",
          "audioQueues",
        ],
        currentSessionOnly: true,
        backfill: false,
      };
    },
    [
      advanceRuntimeEpoch,
      cancelActiveAdvisorJob,
      clearPendingConfirmationForRuntimeReset,
      clearPendingSentenceCompletionForRuntimeReset,
    ]
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
    clearPendingSentenceCompletionForRuntimeReset("session-restarted");
    return sessionId;
  }, [
    clearPendingConfirmation,
    clearPendingSentenceCompletionForRuntimeReset,
  ]);

  const invalidateAudioProcessingSession = useCallback(() => {
    audioSessionIdRef.current = createMeetingId("audio_session_inactive");
    audioSegmentSeqRef.current = 0;
    nativeCaptureSessionIdRef.current = null;
    nativeCaptureGenerationRef.current = null;
    lastNativeSegmentSequenceRef.current = 0;
    systemAudioQueueTailRef.current = Promise.resolve();
    microphoneAudioQueueTailRef.current = Promise.resolve();
    clearPendingConfirmation("session-invalidated");
    clearPendingSentenceCompletionForRuntimeReset("session-invalidated");
  }, [
    clearPendingConfirmation,
    clearPendingSentenceCompletionForRuntimeReset,
  ]);

  const isCurrentAudioSegment = useCallback((segment: QueuedSpeechSegment) => {
    const ownsNativeCapture =
      segment.source !== "system-audio" ||
      (Boolean(segment.nativeCaptureSessionId) &&
        nativeCaptureSessionIdRef.current === segment.nativeCaptureSessionId);
    return (
      activeRef.current &&
      audioSessionIdRef.current === segment.sessionId &&
      ownsNativeCapture
    );
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
      const traceEvalMetadata = readMeetingEvalTraceMetadata([trace.metadata]);
      const memoryEvaluationSnapshot =
        resolveTraceMemoryEvaluationSnapshot(trace).snapshot;
      const activeWhiteboardEvalMetadata =
        buildWhiteboardEvalTraceMetadata(activeMeetingTask);
      const activeTaskIdentity = resolveActiveMeetingTaskIdentity({
        metadata: trace.metadata,
        activeMeetingTask,
      });

      return {
        sessionId,
        questionId: readStringFromTraceMetadata(
          trace.metadata,
          "questionInstanceId"
        ),
        traceId: trace.id,
        traceKind: trace.kind,
        taskId: evaluationPatch.taskId ?? activeTaskIdentity.taskId,
        parentTaskId:
          evaluationPatch.parentTaskId ?? activeTaskIdentity.parentTaskId,
        childTaskId:
          evaluationPatch.childTaskId ?? activeTaskIdentity.childTaskId,
        taskSource: evaluationPatch.taskSource ?? activeTaskIdentity.taskSource,
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
          readStringFromTraceMetadata(trace.metadata, "activeMeetingParentPhase") ??
          readStringFromTraceMetadata(trace.metadata, "playbookPhaseDecisionPhase") ??
          readStringFromTraceMetadata(trace.metadata, "playbookPhase") ??
          activeMeetingTask?.parent.playbookPhase,
        whiteboardArtifactId:
          traceEvalMetadata.whiteboardArtifactId ??
          activeWhiteboardEvalMetadata.whiteboardArtifactId,
        whiteboardArtifactRevision:
          traceEvalMetadata.whiteboardArtifactRevision ??
          activeWhiteboardEvalMetadata.whiteboardArtifactRevision,
        whiteboardArtifactDomainTrack:
          traceEvalMetadata.whiteboardArtifactDomainTrack ??
          activeWhiteboardEvalMetadata.whiteboardArtifactDomainTrack,
        manualPhaseFrom: traceEvalMetadata.manualPhaseFrom,
        manualPhaseTo: traceEvalMetadata.manualPhaseTo,
        manualPhaseTargetArtifact: traceEvalMetadata.manualPhaseTargetArtifact,
        manualPhaseGuardStatus: traceEvalMetadata.manualPhaseGuardStatus,
        selectedDiagramOverlayIds:
          traceEvalMetadata.selectedDiagramOverlayIds ?? [],
        rejectedDiagramOverlayCount:
          traceEvalMetadata.rejectedDiagramOverlayCount,
        memoryRetrievalSnapshot: memoryEvaluationSnapshot,
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
      const activeTaskIdentity = resolveActiveMeetingTaskIdentity({
        metadata: trace.metadata,
        activeMeetingTask,
      });
      const evaluationPatch: Partial<TraceHumanEvaluation> = {
        taskId: activeTaskIdentity.taskId,
        parentTaskId: activeTaskIdentity.parentTaskId,
        childTaskId: activeTaskIdentity.childTaskId,
        taskSource: activeTaskIdentity.taskSource,
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
      if (
        payload === lastTraceMetricsPayloadRef.current ||
        queuedTraceMetricsPayloadsRef.current.has(payload)
      ) {
        return;
      }

      const enqueuePersistence = (candidatePayload: string, attempt: number) => {
        if (
          candidatePayload === lastTraceMetricsPayloadRef.current ||
          queuedTraceMetricsPayloadsRef.current.has(candidatePayload)
        ) {
          return;
        }

        queuedTraceMetricsPayloadsRef.current.add(candidatePayload);
        traceMetricsPersistQueueRef.current = traceMetricsPersistQueueRef.current
          .catch(() => undefined)
          .then(async () => {
            try {
              if (candidatePayload === lastTraceMetricsPayloadRef.current) {
                return;
              }
              await invoke("write_meeting_trace_metrics", {
                payload: candidatePayload,
              });
              lastTraceMetricsPayloadRef.current = candidatePayload;
            } catch (error) {
              const errorMessage = String(error).slice(0, 320);
              console.warn("Failed to persist meeting trace metrics", error);
              const message = `[${new Date().toISOString()}] [meeting-trace] trace-metrics-persist-failed ${JSON.stringify(
                { attempt: attempt + 1, error: errorMessage }
              )}`;
              void invoke("write_meeting_trace_log", { message }).catch(
                () => {}
              );

              if (attempt < 1) {
                if (traceMetricsPersistRetryTimerRef.current !== null) {
                  window.clearTimeout(
                    traceMetricsPersistRetryTimerRef.current
                  );
                }
                traceMetricsPersistRetryTimerRef.current = window.setTimeout(
                  () => {
                    traceMetricsPersistRetryTimerRef.current = null;
                    const latestPayload = serializeMeetingTraceMetrics(
                      traceStoreRef.current.getPersistableTraces()
                    );
                    if (latestPayload === candidatePayload) {
                      enqueuePersistence(candidatePayload, attempt + 1);
                    }
                  },
                  750
                );
              }
            } finally {
              queuedTraceMetricsPayloadsRef.current.delete(candidatePayload);
            }
          });
      };

      enqueuePersistence(payload, 0);
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
      persistInterviewSessionBrief(normalizedBrief);
      contextManagerRef.current.setInterviewSessionBrief(normalizedBrief);
      const contextState = contextManagerRef.current.getState();

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

  const setPersonalEvidenceGuardrailMode = useCallback(
    (personalEvidenceGuardrailMode: PersonalEvidenceGuardrailMode) => {
      updateSettings((previous) => ({
        ...previous,
        personalEvidenceGuardrailMode,
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
      forceStrictProjectAnchor,
      taskId,
      runtimeToken,
      currentOperationId,
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
      forceStrictProjectAnchor?: boolean;
      runtimeToken?: RuntimeCommitToken;
      currentOperationId?: () => string | null | undefined;
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
        force: forceStrictProjectAnchor,
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
        if (runtimeToken) {
          const memoryRuntimeToken: RuntimeCommitToken = {
            ...runtimeToken,
            pipeline: "memory",
          };
          const runtimeDecision = authorizeRuntimeCommit({
            token: memoryRuntimeToken,
            current: readRuntimeCommitSnapshot(),
            currentOperationId: currentOperationId?.(),
          });
          if (traceId) {
            traceStoreRef.current.updateMetadata(
              traceId,
              formatRuntimeCommitAuthorizationForTrace(
                runtimeDecision,
                "post-memory"
              )
            );
          }
          if (!runtimeDecision.authorized) {
            if (traceId) {
              traceStoreRef.current.finishStep(
                traceId,
                memoryStepId,
                "cancelled",
                formatRuntimeCommitAuthorizationForTrace(
                  runtimeDecision,
                  "post-memory"
                )
              );
            }
            return undefined;
          }
        }
        const diagramOverlayTraceMetadata =
          buildDiagramOverlayEvalTraceMetadata(memoryContext.overlaySelection);
        const memoryRoleTelemetry = buildRuntimeMemoryRoleTelemetry(
          memoryContext.entries
        );
        const memoryRoleTraceMetadata = {
          runtimeMemoryRoleCounts: memoryRoleTelemetry.counts,
          runtimeMemoryFactEvidenceCount:
            memoryRoleTelemetry.counts["fact-evidence"],
          runtimeMemoryGuidanceCount: memoryRoleTelemetry.counts.guidance,
          runtimeMemoryTemplateCount: memoryRoleTelemetry.counts.template,
          runtimeMemoryOverlayCount: memoryRoleTelemetry.counts.overlay,
          runtimeMemoryAnchorEligibleCount:
            memoryRoleTelemetry.anchorEligibleCount,
          runtimeMemoryAnchorIneligibleCount:
            memoryRoleTelemetry.anchorIneligibleCount,
          runtimeMemoryRoles: memoryRoleTelemetry.entries,
        };

        if (traceId) {
          traceStoreRef.current.recordOutput(
            traceId,
            "injected memory context",
            formatMemorySelectionForTrace(memoryContext),
            {
              ...buildMemoryEvaluationTraceMetadata(memoryContext),
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
              ...diagramOverlayTraceMetadata,
              ...memoryRoleTraceMetadata,
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
              ...diagramOverlayTraceMetadata,
              ...memoryRoleTraceMetadata,
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
            ...diagramOverlayTraceMetadata,
            ...memoryRoleTraceMetadata,
            memoryPolicySnapshot: memoryContext.policySnapshot,
            totalChars: memoryContext.totalChars,
          });
          traceStoreRef.current.updateMetadata(
            traceId,
            {
              ...diagramOverlayTraceMetadata,
              ...memoryRoleTraceMetadata,
            }
          );
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
    [readRuntimeCommitSnapshot, state.settings.useMemory]
  );

  const clearActiveScreenTask = useCallback(() => {
    advanceRuntimeEpoch("active-task-cleared");
    clearPendingSentenceCompletionForRuntimeReset("active-task-cleared");
    cancelActiveAdvisorJob("active-task-cleared");
    screenAnalysisAbortRef.current?.abort();
    screenAnalysisAbortRef.current = null;
    contextManagerRef.current.clearActiveMeetingTask();
    setState(clearActiveScreenTaskState);
  }, [
    advanceRuntimeEpoch,
    cancelActiveAdvisorJob,
    clearPendingSentenceCompletionForRuntimeReset,
  ]);

  const stop = useCallback(async () => {
    const coordinator = captureLifecycleCoordinatorRef.current!;
    const lifecycleOperation = coordinator.claim("stop");
    advanceRuntimeEpoch("meeting-assistant-stopped");
    activeRef.current = false;
    invalidateAudioProcessingSession();
    cancelActiveAdvisorJob("meeting-assistant-stopped");
    screenAnalysisAbortRef.current?.abort();
    screenAnalysisAbortRef.current = null;
    contextManagerRef.current.clearActiveMeetingTask();
    contextManagerRef.current.clearInterviewSessionContext();
    const contextState = contextManagerRef.current.getState();

    await coordinator.run(lifecycleOperation, async () => {
      let audioStatus: MeetingAudioStatus | null = null;

      try {
        audioStatus = await invoke<MeetingAudioStatus>(
          "stop_meeting_audio_session"
        );
        if (
          !coordinator.recordNativeCompletion(
            lifecycleOperation,
            "stop_meeting_audio_session"
          )
        ) {
          return;
        }
      } catch (error) {
        console.warn("Failed to stop meeting audio capture", error);
        if (!coordinator.authorize(lifecycleOperation, "native-stop-error")) {
          return;
        }
      }

      await stopSessionRecording("meeting-assistant-stopped");
      if (!coordinator.authorize(lifecycleOperation, "commit-stop-state")) {
        return;
      }

      setState((previous) => ({
        ...previous,
        status: "idle",
        activeScreenTask: undefined,
        activeInterviewTask: undefined,
        interviewSessionBrief: contextState.interviewSessionBrief,
        interviewSessionContext: contextState.interviewSessionContext,
        latestSuggestion:
          isScreenAnchoredSuggestion(previous.latestSuggestion)
            ? null
            : previous.latestSuggestion,
        latestReliableSuggestion: null,
        manualQuestionTypeCorrection: undefined,
        partialSuggestion: "",
        error: null,
        audioStatus,
      }));
    });
  }, [
    advanceRuntimeEpoch,
    cancelActiveAdvisorJob,
    invalidateAudioProcessingSession,
    stopSessionRecording,
  ]);

  const buildAdvisorJob = useCallback((options: RunAdvisorOptions) => {
    const contextState = contextManagerRef.current.getState();
    const promptContext = contextManagerRef.current.buildAdvisorPromptContext();
    const mode = options.mode ?? "live";
    const source: AdvisorJobSource =
      options.advisorJobSource ??
      (options.manualQuestionTypeCorrection
        ? "manual-correction"
        : options.clarifyingFeedback
          ? "clarifying-answer"
          : options.responseAction
            ? "response-action"
            : mode === "regenerate"
              ? "regenerate"
              : "live-turn");
    const taskMutationAuthority: AdvisorTaskMutationAuthority =
      options.taskMutationAuthority ??
      (source === "manual-correction"
        ? "manual-correction"
        : source === "live-turn"
          ? "input-evidence"
          : "preserve-parent");
    const traceId =
      options.traceId ??
      (source === "live-turn"
        ? undefined
        : traceStoreRef.current.startTrace(
            promptContext.activeMeetingTask?.screen ? "screen" : "voice",
            { source: `advisor-${source}` }
          ).id);

    return createAdvisorTriggerJob({
      source,
      mode,
      traceId,
      triggerTurnId: options.triggerTurnId,
      promptContext,
      turnIntentDecision: options.turnIntentDecision,
      sessionId: contextState.sessionId,
      runtimeEpoch: runtimeEpochRef.current,
      snapshotTurnCount: contextState.transcriptTurns.length,
      questionLineage: options.questionLineage,
      taskMutationAuthority,
    });
  }, []);

  const runAdvisor = useCallback(async (options: RunAdvisorOptions = {}) => {
    const advisorJob = options.advisorJob ?? buildAdvisorJob(options);
    if (!options.advisorJob) {
      activateAdvisorJob(advisorJob);
    }
    if (activeAdvisorJobRef.current?.id !== advisorJob.id) return;

    const mode = advisorJob.mode;
    const force = options.force ?? false;
    const traceId = advisorJob.traceId;
    let advisorStepId: string | undefined;
    let effectiveRuntimeCommitToken = advisorJob.runtimeCommitToken;
    const readCommitDecision = () =>
      authorizeRuntimeCommit({
        token: effectiveRuntimeCommitToken,
        current: readRuntimeCommitSnapshot(),
        currentOperationId: activeAdvisorJobRef.current?.id,
      });
    const rejectStaleCommit = (
      stage: string,
      decision = readCommitDecision()
    ) => {
      if (traceId) {
        traceStoreRef.current.updateMetadata(
          traceId,
          formatRuntimeCommitAuthorizationForTrace(decision, stage)
        );
      }
      if (decision.authorized) return false;

      finishRunningAdvisorJobTrace(
        advisorJob,
        "cancelled",
        formatAdvisorTriggerJobForTrace(
          advisorJob,
          "stale-commit-rejected",
          {
            cancellationReason: decision.reason,
            commitAuthorized: false,
            commitAuthorizationReason: decision.reason,
          }
        ),
        decision.reason
      );
      return true;
    };

    if (traceId) {
      traceStoreRef.current.updateMetadata(
        traceId,
        formatAdvisorTriggerJobForTrace(advisorJob, "executing")
      );
    }

    if (rejectStaleCommit("pre-execution")) return;

    if (!activeRef.current && !force) {
      releaseAdvisorJob(advisorJob, "suppressed", {
        commitAuthorized: false,
        commitAuthorizationReason: "meeting-assistant-inactive",
      });
      if (traceId) {
        traceStoreRef.current.finishTrace(traceId, "cancelled");
      }
      return;
    }

    let promptContext = advisorJob.promptContextSnapshot;
    const originalPromptContext = promptContext;
    const latestTurn = promptContext.latestTurn;
    const hasContext = Boolean(
      promptContext.latestTurn ||
        promptContext.transcript.trim() ||
        promptContext.screenContext.trim()
    );

    if (force && !hasContext && !options.currentSuggestion?.trim()) {
      releaseAdvisorJob(advisorJob, "error", {
        commitAuthorized: false,
        commitAuthorizationReason: "missing-meeting-context",
      });
      if (traceId) {
        traceStoreRef.current.finishTrace(traceId, "error", NO_MEETING_CONTEXT_MESSAGE);
      }
      setState((previous) => ({
        ...previous,
        error: NO_MEETING_CONTEXT_MESSAGE,
      }));
      return;
    }

    const manualPhaseAdvance = options.responseAction === "next-phase";
    const manualPhaseAdvanceFromPhase =
      promptContext.activeMeetingTask?.parent.playbookPhase ??
      promptContext.activeInterviewTask?.playbookPhase;
    const advisorMemoryQuery = buildAdvisorMemoryQuery(
      promptContext,
      mode,
      options.currentSuggestion
    );
    const resolvedAdvisorTaskSignals = resolveAdvisorTaskSignals(
      promptContext,
      advisorMemoryQuery
    );
    const correctedAdvisorTaskSignals = options.manualQuestionTypeCorrection
      ? applyManualQuestionTypeCorrectionToAdvisorSignals(
          resolvedAdvisorTaskSignals,
          options.manualQuestionTypeCorrection
        )
      : resolvedAdvisorTaskSignals;
    const advisorTaskMutationDecision = decideAdvisorTaskMutation({
      authority: advisorJob.taskMutationAuthority,
      resolvedRelation: correctedAdvisorTaskSignals.taskRelation,
      hasActiveParent: hasAdvisorActiveTask(promptContext),
      hasActiveChild: hasAdvisorActiveChild(promptContext),
    });
    const preservedParentQuestionType = getAdvisorActiveQuestionType(promptContext);
    let advisorTaskSignals =
      advisorTaskMutationDecision.preserveParentType &&
      preservedParentQuestionType
        ? {
            ...correctedAdvisorTaskSignals,
            questionType: preservedParentQuestionType,
            questionTypeDecision: undefined,
            askFrame:
              getAdvisorActiveAskFrame(promptContext) ??
              correctedAdvisorTaskSignals.askFrame,
            topicDomain:
              getAdvisorActiveTopicDomain(promptContext) ??
              correctedAdvisorTaskSignals.topicDomain,
            projectAnchor:
              getAdvisorActiveProjectAnchor(promptContext) ??
              correctedAdvisorTaskSignals.projectAnchor,
            query: buildExplicitActionAdvisorTaskQuery(
              promptContext,
              options.currentSuggestion,
              options.clarifyingFeedback
            ),
            taskRelation: advisorTaskMutationDecision.relation,
            subtaskIntent: "unknown" as InterviewSubtaskIntent,
            source: "explicit-action-preserve-parent",
            reuseActivePlaybook: true,
            openingRoute: undefined,
            latestTurnTaxonomyBoundaryReason:
              "active-parent-continuity" as const,
            taxonomyFallbackSuppressed: true,
            unknownTaskMutationBlocked: true,
          }
        : correctedAdvisorTaskSignals;
    const advisorScreenScopeDecision = decideAdvisorScreenScope({
      triggerSource: advisorJob.source,
      relation: advisorTaskSignals.taskRelation,
      hasActiveScreenTask: Boolean(promptContext.activeScreenTask),
    });
    promptContext = applyAdvisorScreenScopeToPromptContext(
      promptContext,
      advisorScreenScopeDecision
    );
    const advisorPromptMode = resolveAdvisorRequestModeForScreenScope(
      mode,
      advisorScreenScopeDecision
    );
    if (advisorScreenScopeDecision.action === "clear" && latestTurn?.text) {
      advisorTaskSignals = {
        ...advisorTaskSignals,
        query: buildFocusedAdvisorTaskQuery(promptContext, latestTurn.text),
      };
    }
    const activeMeetingTaskId = getAdvisorActiveTaskId(promptContext);
    const inferredTurnIntentDecision =
      advisorJob.turnIntentDecision ??
      (latestTurn?.speaker === "them"
        ? evaluateThemTurnForAdvisor(latestTurn, {
            hasActiveTask: hasAdvisorActiveTask(promptContext),
          })
        : undefined);
    const hasExplicitAction = Boolean(
      options.responseAction ||
        options.clarifyingFeedback ||
        options.manualQuestionTypeCorrection
    );
    const executionAuthorization = authorizeAdvisorExecution({
      force,
      hasExplicitAction,
      decision: inferredTurnIntentDecision,
    });
    const questionTypeTraceMetadata =
      formatAdvisorQuestionTypeDecisionForTrace(advisorTaskSignals);
    if (traceId) {
      const intentMetadata = inferredTurnIntentDecision
        ? formatAdvisorTurnIntentForTrace(inferredTurnIntentDecision)
        : {};
      const executionMetadata = {
        ...intentMetadata,
        ...questionTypeTraceMetadata,
        ...formatScreenScopeDecisionForTrace(
          advisorScreenScopeDecision,
          {
            stage: "request",
            mutationApplied: advisorScreenScopeDecision.action === "clear",
            previousScreenTaskId:
              originalPromptContext.activeScreenTask?.id,
            nextScreenTaskId: promptContext.activeScreenTask?.id,
            previousParentId:
              originalPromptContext.activeMeetingTask?.parent.id ??
              originalPromptContext.activeInterviewTask?.id,
            nextParentId:
              promptContext.activeMeetingTask?.parent.id ??
              promptContext.activeInterviewTask?.id,
          }
        ),
        advisorOriginalMode: mode,
        advisorEffectiveMode: advisorPromptMode,
        advisorTaskMutationDecision: advisorTaskMutationDecision.reason,
        advisorTaskMutationCommitParent:
          advisorTaskMutationDecision.commitParent,
        advisorTaskMutationPreserveParentType:
          advisorTaskMutationDecision.preserveParentType,
        advisorTaskMutationAllowExplicitRetype:
          advisorTaskMutationDecision.allowExplicitRetype,
        advisorExecutionAuthorized: executionAuthorization.authorized,
        advisorExecutionAuthorizationReason: executionAuthorization.reason,
        advisorExecutionBypassed: executionAuthorization.bypassed,
        advisorTriggerTurnId: advisorJob.triggerTurnId,
        memoryRetrievalSuppressedReason: executionAuthorization.authorized
          ? undefined
          : executionAuthorization.reason,
        modelExecutionSuppressedReason: executionAuthorization.authorized
          ? undefined
          : executionAuthorization.reason,
      };
      traceStoreRef.current.updateMetadata(traceId, executionMetadata);
      const intentStepId = traceStoreRef.current.startStep(
        traceId,
        "Advisor response-intent gate",
        executionMetadata
      );
      traceStoreRef.current.finishStep(traceId, intentStepId, "success");
    }

    if (!executionAuthorization.authorized) {
      releaseAdvisorJob(advisorJob, "suppressed", {
        commitAuthorized: false,
        commitAuthorizationReason: executionAuthorization.reason,
      });
      if (traceId) {
        traceStoreRef.current.finishTrace(traceId, "success");
      }
      setState((previous) => ({
        ...previous,
        status: activeRef.current ? "listening" : previous.status,
        partialSuggestion: "",
      }));
      return;
    }

    if (
      !force &&
      !advisorEngineRef.current.shouldRequestSuggestion(latestTurn)
    ) {
      releaseAdvisorJob(advisorJob, "suppressed", {
        commitAuthorized: false,
        commitAuthorizationReason: "turn-did-not-require-suggestion",
      });
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

    if (!aiProvider) {
      releaseAdvisorJob(advisorJob, "error", {
        commitAuthorized: false,
        commitAuthorizationReason: "missing-ai-provider",
      });
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

    const advisorQuestionType = advisorTaskSignals.questionType;
    const advisorAnswerProfile = resolveMeetingAnswerProfile(
      advisorQuestionType
    );
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
    const advisorPhaseQuestionType = normalizeQuestionTypeAlias(
      (advisorTaskSignals.taskRelation === "followup-parent" ||
        advisorTaskSignals.taskRelation === "resume-parent" ||
        advisorTaskSignals.taskRelation === "child-probe") &&
        getAdvisorActiveQuestionType(promptContext)
        ? getAdvisorActiveQuestionType(promptContext)
        : advisorQuestionType
    );
    const preservedPlaybookPhase =
      promptContext.activeMeetingTask?.parent.playbookPhase ??
      promptContext.activeInterviewTask?.playbookPhase ??
      advisorPlaybook?.phase ??
      "follow_up";
    const automaticPlaybookPhaseDecision = decidePlaybookPhaseProgression({
      questionType: advisorPhaseQuestionType,
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
    const playbookPhaseDecision = decideAdvisorPhaseMutation({
      authority: advisorJob.taskMutationAuthority,
      manualPhaseAdvance,
      currentPhase: preservedPlaybookPhase,
      hasActiveChild: hasAdvisorActiveChild(promptContext),
      automaticDecision: automaticPlaybookPhaseDecision,
      manualDecision: decideManualNextPhaseTransition(
        promptContext.activeMeetingTask
      ),
    });
    let manualPhaseAdvanceCommitted = false;

    if (
      manualPhaseAdvance &&
      playbookPhaseDecision.guardStatus === "advanced"
    ) {
      const contextState = contextManagerRef.current.getState();
      const existingInterviewTask =
        contextState.activeInterviewTask ??
        (contextState.activeScreenTask
          ? buildInterviewParentFromScreenTask(contextState.activeScreenTask)
          : undefined);

      if (existingInterviewTask) {
        const now = Date.now();
        const updatedPlaybook = withInterviewPlaybookPhase(
          advisorPlaybook ?? existingInterviewTask.playbook,
          playbookPhaseDecision.phase
        );
        const updatedInterviewTask: ActiveInterviewParent = {
          ...existingInterviewTask,
          playbook: updatedPlaybook,
          playbookPhase: playbookPhaseDecision.phase,
          phaseProgress: applyPlaybookPhaseDecisionToProgress(
            existingInterviewTask.phaseProgress,
            playbookPhaseDecision,
            existingInterviewTask.playbookPhase
          ),
          child: undefined,
          updatedAt: now,
          revisions: existingInterviewTask.revisions + 1,
        };

        contextManagerRef.current.setActiveMeetingTaskState({
          activeScreenTask: contextState.activeScreenTask,
          activeInterviewTask: updatedInterviewTask,
        });
        const phaseUpdatedContext =
          contextManagerRef.current.buildAdvisorPromptContext();
        promptContext = {
          ...promptContext,
          activeScreenTask: phaseUpdatedContext.activeScreenTask,
          activeInterviewTask: phaseUpdatedContext.activeInterviewTask,
          activeMeetingTask: phaseUpdatedContext.activeMeetingTask,
          interviewPlaybook: phaseUpdatedContext.interviewPlaybook,
        };
        manualPhaseAdvanceCommitted = true;
        effectiveRuntimeCommitToken = rebaseRuntimeCommitToken({
          token: effectiveRuntimeCommitToken,
          snapshot: readRuntimeCommitSnapshot(),
        });
        if (traceId) {
          traceStoreRef.current.updateMetadata(traceId, {
            runtimeCommitTokenRebased: true,
            runtimeCommitTokenRebaseReason: "manual-phase-advance",
            runtimeRebasedParentId:
              effectiveRuntimeCommitToken.parentExpectation.kind === "exact"
                ? effectiveRuntimeCommitToken.parentExpectation.parentId
                : undefined,
            runtimeRebasedParentRevision:
              effectiveRuntimeCommitToken.parentExpectation.kind === "exact"
                ? effectiveRuntimeCommitToken.parentExpectation.parentRevision
                : undefined,
          });
        }
      }
    }

    const advisorRuntimePlaybook = withInterviewPlaybookPhase(
      advisorPlaybook ?? promptContext.activeMeetingTask?.parent.playbook,
      playbookPhaseDecision.phase
    );
    if (traceId) {
      const playbookMetadata =
        formatInterviewPlaybookForTrace(advisorRuntimePlaybook);
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
        ...questionTypeTraceMetadata,
        ...formatManualQuestionTypeCorrectionForTrace(
          options.manualQuestionTypeCorrection
        ),
        openingRouteKind: advisorTaskSignals.openingRoute?.kind,
        openingRouteCommitParent:
          advisorTaskSignals.openingRoute?.commitParent,
        manualPhaseAdvance,
        manualPhaseAdvanceFromPhase,
        manualPhaseAdvanceCommitted,
        parentTaskId: activeMeetingTaskId,
        parentTaskKind:
          promptContext.activeMeetingTask?.parent.questionType ??
          getAdvisorActiveQuestionType(promptContext),
        ...getActiveMeetingTaskTraceMetadata(promptContext.activeMeetingTask),
      });
      if (advisorRuntimePlaybook) {
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
            ...questionTypeTraceMetadata,
            openingRouteKind: advisorTaskSignals.openingRoute?.kind,
            openingRouteCommitParent:
              advisorTaskSignals.openingRoute?.commitParent,
            manualPhaseAdvance,
            manualPhaseAdvanceFromPhase,
            manualPhaseAdvanceCommitted,
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
          ...questionTypeTraceMetadata,
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
      memoryPolicy: advisorRuntimePlaybook?.memoryPolicy,
      forceStrictProjectAnchor: Boolean(
        (promptContext.activeMeetingTask?.parent.projectBinding ??
          promptContext.activeInterviewTask?.projectBinding) &&
          advisorTaskSignals.taskRelation !== "new-parent" &&
          advisorTaskSignals.taskRelation !== "unknown"
      ),
      runtimeToken: effectiveRuntimeCommitToken,
      currentOperationId: () => activeAdvisorJobRef.current?.id,
    });
    if (rejectStaleCommit("post-memory")) return;
    const advisorPersonalEvidenceDecision = detectPersonalEvidenceRequirement({
      questionText: advisorTaskSignals.query,
      questionType: advisorQuestionType,
      mode: state.settings.personalEvidenceGuardrailMode,
    });
    const projectBindingDecision = resolveProjectBinding({
      existingBinding:
        promptContext.activeMeetingTask?.parent.projectBinding ??
        promptContext.activeInterviewTask?.projectBinding,
      questionType: advisorQuestionType,
      relation: advisorTaskSignals.taskRelation,
      requiresProjectBinding:
        advisorTaskSignals.openingRoute?.commitParent !== false &&
        (advisorQuestionType === "project-deep-dive" ||
          (advisorPersonalEvidenceDecision.enforced &&
            advisorPersonalEvidenceDecision.requirement ===
              "autobiographical-project")),
      projectAnchor: advisorProjectAnchor,
      explicitProjectSelection:
        options.clarifyingFeedback?.answer === "option"
          ? options.clarifyingFeedback.answerValue ??
            options.clarifyingFeedback.answerLabel
          : undefined,
      explicitSelectionSource: "user-selection",
      memoryContext,
    });
    const factAnchorDecision = buildFactAnchorDecision({
      questionType:
        advisorTaskSignals.openingRoute?.commitParent === false
          ? undefined
          : advisorQuestionType,
      questionText: advisorTaskSignals.query,
      personalEvidenceGuardrailMode:
        state.settings.personalEvidenceGuardrailMode,
      memoryContext,
      activeFactAnchors:
        promptContext.activeMeetingTask?.parent.supportedFactAnchors ??
        promptContext.activeInterviewTask?.supportedFactAnchors,
      projectAnchor: advisorProjectAnchor,
      personalEvidenceDecision: advisorPersonalEvidenceDecision,
      projectBindingDecision,
    });
    if (traceId) {
      const projectBindingMetadata = {
        source: "advisor",
        questionType: advisorQuestionType,
        ...formatProjectBindingDecisionForTrace(projectBindingDecision),
      };
      traceStoreRef.current.updateMetadata(traceId, projectBindingMetadata);
      const projectBindingStepId = traceStoreRef.current.startStep(
        traceId,
        "Project binding decision",
        projectBindingMetadata
      );
      traceStoreRef.current.finishStep(
        traceId,
        projectBindingStepId,
        "success"
      );
      sessionRecordingManagerRef.current?.recordProjectBindingDecision(
        traceId,
        projectBindingMetadata,
        activeMeetingTaskId
      );
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
      interviewPlaybook: advisorRuntimePlaybook,
      playbookPhaseDecision,
      factAnchorDecision,
      projectBindingDecision,
      openingRoute: advisorTaskSignals.openingRoute,
    };

    const advisorUsesCodingModel =
      getAdvisorActiveQuestionType(promptContext) === "coding" ||
      getAdvisorActiveChildQuestionType(promptContext) === "coding" ||
      advisorRuntimePlaybook?.id === "coding_algorithm";
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
        mode: advisorPromptMode,
        promptContext,
        provider: advisorModelRoute.provider,
        selectedProvider: advisorModelRoute.selectedProvider,
        requestOptions: advisorModelRequestOptions,
        responseAction: options.responseAction,
        responseConfig,
        answerProfile: advisorAnswerProfile,
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
                    manualPhaseAdvance,
                    manualPhaseAdvanceFromPhase,
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
                    manualPhaseAdvance,
                    manualPhaseAdvanceFromPhase,
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
                    manualPhaseAdvance,
                    manualPhaseAdvanceFromPhase,
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
                if (readCommitDecision().authorized) {
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
                }
              },
            }
          : undefined,
      })) {
        if (rejectStaleCommit("partial-output")) return;
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

      const finalCommitDecision = readCommitDecision();
      if (rejectStaleCommit("final-commit", finalCommitDecision)) return;

      const parsedMeetingAnswer = parseMeetingAnswer(finalContent, {
        expectedProfile: advisorAnswerProfile,
      });
      const meetingAnswerSummary = buildMeetingAnswerSummary(
        parsedMeetingAnswer
      );
      const meetingAnswerMetadata = formatMeetingAnswerTraceMetadata(
        parsedMeetingAnswer,
        meetingAnswerSummary
      );
      if (traceId) {
        traceStoreRef.current.updateMetadata(traceId, meetingAnswerMetadata);
      }

      let contextState = contextManagerRef.current.getState();
      const existingInterviewTask =
        promptContext.activeInterviewTask ??
        (promptContext.activeMeetingTask?.screen && promptContext.activeScreenTask
          ? buildInterviewParentFromScreenTask(promptContext.activeScreenTask)
          : undefined);
      const advisorEvidenceSource = resolveAdvisorTaskEvidenceSource({
        triggerSource: advisorJob.source,
        hasActiveScreenTask: Boolean(promptContext.activeScreenTask),
      });
      const shouldCommitAdvisorParent =
        advisorTaskMutationDecision.commitParent &&
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
              advisorEvidenceSource === "screen"
                ? promptContext.activeScreenTask?.question ?? latestTurn?.text
                : latestTurn?.text,
            finalContent,
            parsedAnswer: parsedMeetingAnswer,
            playbook: advisorRuntimePlaybook,
            phaseDecision: playbookPhaseDecision,
            latestTurn,
            observationId:
              advisorEvidenceSource === "screen"
                ? promptContext.activeScreenTask?.basedOnObservationId
                : undefined,
            traceId,
            selectedOverlayIds: extractSelectedOverlayIdsFromMemory(memoryContext),
            whiteboardUpdateSource: manualPhaseAdvance
              ? "manual-next"
              : "model-output",
            expiresAt: getActiveScreenTaskExpiresAt(state.settings),
            supportedFactAnchors:
              projectBindingDecision.binding
                ? [projectBindingDecision.binding.projectName]
                : extractSupportedFactAnchorsFromMemory(memoryContext),
            projectBinding: projectBindingDecision.binding,
          })
        : {
            task: existingInterviewTask,
            startedNewParent: false,
            clearedParent: false,
          };
      const previousWhiteboard = existingInterviewTask?.whiteboardArtifact;
      const nextWhiteboard = continuity.task?.whiteboardArtifact;
      const whiteboardArtifactDecision = parsedMeetingAnswer.sections.whiteboard
        ? nextWhiteboard
          ? !previousWhiteboard
            ? "produced"
            : previousWhiteboard.revision !== nextWhiteboard.revision
              ? "updated"
              : "preserved"
          : "ignored"
        : previousWhiteboard
          ? "preserved"
          : "none";
      const answerArtifactMetadata = {
        answerCodeArtifactDecision: parsedMeetingAnswer.sections.code
          ? "produced"
          : "none",
        answerWhiteboardArtifactDecision: whiteboardArtifactDecision,
      };
      if (traceId) {
        traceStoreRef.current.updateMetadata(traceId, answerArtifactMetadata);
      }
      let nextActiveScreenTask = promptContext.activeScreenTask;

      if (
        mode === "screen-anchored" &&
        nextActiveScreenTask &&
        shouldUpdateActiveScreenTaskFromAdvisorOutput(finalContent)
      ) {
        const taxonomyAuthorityDecision = resolveTaskTaxonomyAuthority({
          candidates: [{ source: "generated-answer" }],
          existingQuestionType: nextActiveScreenTask.kind,
        });
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
          language:
            inferTrustedProgrammingLanguage({
              textHints: [latestTurn?.text],
              activeTaskLanguage: nextActiveScreenTask.language,
            }).language ?? nextActiveScreenTask.language,
          content: finalContent.trim(),
          basedOnTurnIds,
        };
        if (traceId) {
          traceStoreRef.current.updateMetadata(traceId, {
            ...formatTaskTaxonomyAuthorityForTrace(
              taxonomyAuthorityDecision
            ),
            taxonomyMutationTarget: "active-screen-task",
          });
        }
      }

      contextManagerRef.current.setActiveMeetingTaskState({
        activeScreenTask: nextActiveScreenTask,
        activeInterviewTask: continuity.task ?? null,
      });
      contextState = contextManagerRef.current.getState();

      if (traceId) {
        traceStoreRef.current.updateMetadata(traceId, {
          ...formatScreenScopeDecisionForTrace(
            advisorScreenScopeDecision,
            {
              stage: "commit",
              mutationApplied:
                Boolean(originalPromptContext.activeScreenTask) &&
                !contextState.activeScreenTask,
              previousScreenTaskId:
                originalPromptContext.activeScreenTask?.id,
              nextScreenTaskId: contextState.activeScreenTask?.id,
              previousParentId:
                originalPromptContext.activeMeetingTask?.parent.id ??
                originalPromptContext.activeInterviewTask?.id,
              nextParentId:
                contextState.activeMeetingTask?.parent.id ??
                contextState.activeInterviewTask?.id,
            }
          ),
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

      const nextSuggestion = {
        ...advisorEngineRef.current.toSuggestion(
          requestId,
          finalContent,
          latestTurn ? [latestTurn.id] : [],
          latestObservationIds,
          buildSuggestionTaskMetadata(contextState.activeMeetingTask),
          parsedMeetingAnswer
        ),
        sourceTraceId: traceId,
      };

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
      releaseAdvisorJob(advisorJob, "committed", {
        commitAuthorized: finalCommitDecision.authorized,
        commitAuthorizationReason: finalCommitDecision.reason,
      });
      if (traceId) {
        traceStoreRef.current.finishStep(traceId, advisorStepId, "success", {
          outputChars: finalContent.length,
          ...advisorModelRouteMetadata,
          ...meetingAnswerMetadata,
          ...answerArtifactMetadata,
        });
        traceStoreRef.current.finishTrace(traceId, "success");
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        const commitDecision = readCommitDecision();
        finishRunningAdvisorJobTrace(
          advisorJob,
          "cancelled",
          formatAdvisorTriggerJobForTrace(advisorJob, "error", {
            cancellationReason: "provider-request-aborted",
            commitAuthorized: false,
            commitAuthorizationReason: commitDecision.reason,
          }),
          error
        );
        releaseAdvisorJob(advisorJob, "error", {
          commitAuthorized: false,
          commitAuthorizationReason: commitDecision.reason,
        });

        if (activeRef.current && commitDecision.authorized) {
          setState((previous) => ({
            ...previous,
            status: "listening",
            partialSuggestion: "",
          }));
        }
        return;
      }

      const commitDecision = readCommitDecision();
      finishRunningAdvisorJobTrace(
        advisorJob,
        "error",
        formatAdvisorTriggerJobForTrace(advisorJob, "error", {
          commitAuthorized: false,
          commitAuthorizationReason: commitDecision.reason,
        }),
        error
      );
      releaseAdvisorJob(advisorJob, "error", {
        commitAuthorized: false,
        commitAuthorizationReason: commitDecision.reason,
      });
      if ((!activeRef.current && !force) || !commitDecision.authorized) return;

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
    activateAdvisorJob,
    aiProvider,
    buildAdvisorJob,
    finishRunningAdvisorJobTrace,
    loadMemoryForPrompt,
    releaseAdvisorJob,
    resolveMeetingModelRoute,
    selectedAIProvider,
    state.settings,
    state.status,
  ]);

  const scheduleAdvisor = useCallback((
    mode: AdvisorRequestMode = "live",
    traceId?: string,
    turnIntentDecision?: AdvisorTurnIntentDecision,
    triggerTurnId?: string
  ) => {
    if (!activeRef.current) return;

    const advisorJob = buildAdvisorJob({
      mode,
      traceId,
      turnIntentDecision,
      triggerTurnId,
      advisorJobSource: "live-turn",
      taskMutationAuthority: "input-evidence",
    });
    activateAdvisorJob(advisorJob);
    advisorDebounceTimerRef.current = window.setTimeout(() => {
      advisorDebounceTimerRef.current = null;
      void runAdvisor({
        mode,
        traceId,
        turnIntentDecision,
        triggerTurnId,
        advisorJob,
      });
    }, ADVISOR_DEBOUNCE_MS);
  }, [activateAdvisorJob, buildAdvisorJob, runAdvisor]);

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

  const flushPendingSentenceCompletion = useCallback(
    (reason: string) => {
      const pending = pendingSentenceCompletionRef.current;
      if (!pending) return false;

      window.clearTimeout(pending.timeoutId);
      pendingSentenceCompletionRef.current = null;

      if (!isCurrentAudioSegment(pending.segment)) {
        traceStoreRef.current.updateMetadata(pending.segment.traceId, {
          sentenceBufferOperationId: pending.operationId,
          sentenceBufferOperationRole: "terminal",
          sentenceBufferOutcome: "cancelled",
          sentenceBufferDisposition: "cancelled",
          sentenceBufferFlushReason: "stale-session",
          sentenceBufferFragmentCount: pending.fragmentTurnIds.length,
          sentenceBufferTurnIds: pending.fragmentTurnIds,
          sentenceBufferTraceIds: pending.fragmentTraceIds,
          sentenceBufferSegmentSequences: pending.fragmentSequences,
        });
        traceStoreRef.current.finishTrace(
          pending.segment.traceId,
          "cancelled",
          "Buffered sentence belongs to a stale audio session."
        );
        return false;
      }

      const addedLatencyMs = Date.now() - pending.firstHeldAt;
      const intentDecision = decideAdvisorTurnIntent(pending.turn.text, {
        hasActiveTask: Boolean(
          contextManagerRef.current.getState().activeMeetingTask
        ),
        enforceBufferedIncomplete: true,
      });
      pending.turn.contextPromptEligible = intentDecision.contextPromptEligible;
      pending.turn.contextFusionStatus = intentDecision.contextPromptEligible
        ? "none"
        : "debug-only";

      const sentenceMetadata = {
        sentenceBufferOperationId: pending.operationId,
        sentenceBufferOperationRole: "terminal",
        sentenceBufferOutcome: reason === "timeout" ? "timeout" : "flushed",
        sentenceBufferDisposition: "flushed-incomplete",
        sentenceBufferFlushReason: reason,
        sentenceBufferFragmentCount: pending.fragmentTurnIds.length,
        sentenceBufferAddedLatencyMs: addedLatencyMs,
        sentenceBufferTurnIds: pending.fragmentTurnIds,
        sentenceBufferTraceIds: pending.fragmentTraceIds,
        sentenceBufferSegmentSequences: pending.fragmentSequences,
        sentenceBufferMergedTranscriptChars: pending.turn.text.length,
      };
      traceStoreRef.current.updateMetadata(pending.segment.traceId, {
        ...sentenceMetadata,
        ...formatAdvisorTurnIntentForTrace(intentDecision),
        turnGateAction: intentDecision.action,
        turnGateReason: intentDecision.reason,
        memoryRetrievalSuppressedReason: `sentence-buffer:${reason}`,
        modelExecutionSuppressedReason: `sentence-buffer:${reason}`,
      });
      const flushStepId = traceStoreRef.current.startStep(
        pending.segment.traceId,
        "Sentence completion buffer flushed",
        {
          ...sentenceMetadata,
          turnId: pending.turn.id,
          audioSegmentSeq: pending.segment.sequence,
          audioSessionId: pending.segment.sessionId,
        }
      );
      traceStoreRef.current.finishStep(
        pending.segment.traceId,
        flushStepId,
        "success"
      );
      appendTranscriptTurnForTrace(
        pending.turn,
        pending.segment.traceId,
        pending.segment,
        {
          ...sentenceMetadata,
          turnGateAction: intentDecision.action,
          turnGateReason: intentDecision.reason,
        }
      );
      traceStoreRef.current.finishTrace(pending.segment.traceId, "success");
      return true;
    },
    [appendTranscriptTurnForTrace, isCurrentAudioSegment]
  );

  const holdPendingSentenceCompletion = useCallback(
    (
      turn: TranscriptTurn,
      segment: QueuedSpeechSegment,
      decision: ReturnType<typeof decideSentenceCompletion>,
      mergeContext?: SentenceCompletionMergeContext
    ) => {
      const heldAt = Date.now();
      const operationId =
        mergeContext?.operationId ?? createMeetingId("sentence_buffer");
      const fragmentTurnIds = [
        ...(mergeContext?.fragmentTurnIds ?? []),
        turn.id,
      ];
      const fragmentTraceIds = [
        ...(mergeContext?.fragmentTraceIds ?? []),
        segment.traceId,
      ];
      const fragmentSequences = [
        ...(mergeContext?.fragmentSequences ?? []),
        segment.sequence,
      ];
      const firstHeldAt = mergeContext?.firstHeldAt ?? heldAt;
      const sentenceMetadata = {
        sentenceBufferOperationId: operationId,
        sentenceBufferOperationRole: "source-fragment",
        sentenceBufferDisposition: "buffered",
        sentenceBufferReason: decision.reason,
        sentenceBufferConfidence: decision.confidence,
        sentenceBufferEvidence: decision.evidence,
        sentenceBufferFragmentCount: fragmentTurnIds.length,
        sentenceBufferTurnIds: fragmentTurnIds,
        sentenceBufferTraceIds: fragmentTraceIds,
        sentenceBufferSegmentSequences: fragmentSequences,
        sentenceBufferTimeoutMs: SENTENCE_COMPLETION_BUFFER_MS,
      };
      traceStoreRef.current.updateMetadata(segment.traceId, sentenceMetadata);
      const heldStepId = traceStoreRef.current.startStep(
        segment.traceId,
        "Sentence completion fragment buffered",
        {
          ...sentenceMetadata,
          turnId: turn.id,
          transcriptChars: turn.text.length,
          audioSegmentSeq: segment.sequence,
          audioSessionId: segment.sessionId,
        }
      );
      traceStoreRef.current.finishStep(segment.traceId, heldStepId, "success");

      const timeoutId = window.setTimeout(() => {
        const pending = pendingSentenceCompletionRef.current;
        if (!pending || pending.turn.id !== turn.id) return;
        flushPendingSentenceCompletion("timeout");
      }, SENTENCE_COMPLETION_BUFFER_MS);

      pendingSentenceCompletionRef.current = {
        operationId,
        turn,
        segment,
        heldAt,
        firstHeldAt,
        timeoutId,
        fragmentTurnIds,
        fragmentTraceIds,
        fragmentSequences,
      };
      setState((previous) => ({
        ...previous,
        status: activeRef.current ? "listening" : "idle",
      }));
    },
    [flushPendingSentenceCompletion]
  );

  const consumePendingSentenceCompletion = useCallback(
    (turn: TranscriptTurn, segment: QueuedSpeechSegment) => {
      const pending = pendingSentenceCompletionRef.current;
      if (!pending) return undefined;

      if (!isCurrentAudioSegment(pending.segment)) {
        clearPendingSentenceCompletionForRuntimeReset("stale-before-merge");
        return undefined;
      }

      window.clearTimeout(pending.timeoutId);
      pendingSentenceCompletionRef.current = null;
      const addedLatencyMs = Date.now() - pending.firstHeldAt;
      const mergeContext: SentenceCompletionMergeContext = {
        operationId: pending.operationId,
        firstHeldAt: pending.firstHeldAt,
        fragmentTurnIds: [...pending.fragmentTurnIds],
        fragmentTraceIds: [...pending.fragmentTraceIds],
        fragmentSequences: [...pending.fragmentSequences],
      };

      turn.text = mergeSentenceFragments([pending.turn.text, turn.text]);
      turn.startedAt = Math.min(pending.turn.startedAt, turn.startedAt);
      turn.relatedTurnIds = Array.from(
        new Set([...(turn.relatedTurnIds ?? []), ...pending.fragmentTurnIds])
      );

      traceStoreRef.current.updateMetadata(pending.segment.traceId, {
        sentenceBufferOperationId: pending.operationId,
        sentenceBufferOperationRole: "source-fragment",
        sentenceBufferOutcome: "merged",
        sentenceBufferDisposition: "merged-into-next",
        sentenceBufferFlushReason: "next-them-fragment",
        sentenceBufferFragmentCount: pending.fragmentTurnIds.length + 1,
        sentenceBufferAddedLatencyMs: addedLatencyMs,
        sentenceBufferMergedIntoTraceId: segment.traceId,
        sentenceBufferMergedIntoTurnId: turn.id,
      });
      const mergedStepId = traceStoreRef.current.startStep(
        pending.segment.traceId,
        "Sentence completion fragment merged",
        {
          nextTraceId: segment.traceId,
          nextTurnId: turn.id,
          fragmentCount: pending.fragmentTurnIds.length + 1,
          addedLatencyMs,
        }
      );
      traceStoreRef.current.finishStep(
        pending.segment.traceId,
        mergedStepId,
        "success"
      );
      traceStoreRef.current.finishTrace(pending.segment.traceId, "success");

      traceStoreRef.current.updateMetadata(segment.traceId, {
        sentenceBufferOperationId: pending.operationId,
        sentenceBufferOperationRole: "terminal",
        sentenceBufferOutcome: "merged",
        sentenceBufferDisposition: "merged",
        sentenceBufferFlushReason: "next-them-fragment",
        sentenceBufferFragmentCount: pending.fragmentTurnIds.length + 1,
        sentenceBufferAddedLatencyMs: addedLatencyMs,
        sentenceBufferTurnIds: [...pending.fragmentTurnIds, turn.id],
        sentenceBufferTraceIds: [...pending.fragmentTraceIds, segment.traceId],
        sentenceBufferSegmentSequences: [
          ...pending.fragmentSequences,
          segment.sequence,
        ],
        sentenceBufferMergedTranscriptChars: turn.text.length,
      });
      return mergeContext;
    },
    [
      clearPendingSentenceCompletionForRuntimeReset,
      isCurrentAudioSegment,
    ]
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
      const turnIntentDecision = decideAdvisorTurnIntent(pending.turn.text, {
        hasActiveTask: Boolean(contextState.activeMeetingTask),
        hasPendingConfirmation: true,
      });
      traceStoreRef.current.updateMetadata(pending.segment.traceId, {
        ...formatAdvisorTurnIntentForTrace(turnIntentDecision),
        turnGateAction: turnIntentDecision.action,
        turnGateReason: turnIntentDecision.reason,
      });
      scheduleAdvisor(
        contextState.activeMeetingTask?.screen ? "screen-anchored" : "live",
        pending.segment.traceId,
        turnIntentDecision,
        pending.turn.id
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
        const coordinator = captureLifecycleCoordinatorRef.current!;
        const lifecycleOperation = coordinator.claim("stop");
        activeRef.current = false;
        invalidateAudioProcessingSession();
        cancelActiveAdvisorJob("stt-provider-missing");
        screenAnalysisAbortRef.current?.abort();
        screenAnalysisAbortRef.current = null;

        const lifecycleResult = await coordinator.run(
          lifecycleOperation,
          async () => {
            try {
              const audioStatus = await invoke<MeetingAudioStatus>(
                "stop_meeting_audio_session"
              );
              coordinator.recordNativeCompletion(
                lifecycleOperation,
                "stop_for_missing_stt_provider"
              );
              return audioStatus;
            } catch (error) {
              console.warn("Failed to stop meeting audio capture", error);
              coordinator.authorize(
                lifecycleOperation,
                "missing-provider-native-stop-error"
              );
              return null;
            }
          }
        );

        traceStoreRef.current.finishTrace(traceId, "error", MISSING_STT_MESSAGE);
        if (!coordinator.authorize(lifecycleOperation, "commit-provider-error")) {
          return;
        }
        setState((previous) => ({
          ...previous,
          status: "error",
          partialSuggestion: "",
          error: MISSING_STT_MESSAGE,
          audioStatus: lifecycleResult.value ?? null,
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
        const transcription = await withTimeout(
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
        const { rawText, turn, validation } = transcription;
        const sttValidationMetadata = {
          sttValidationDisposition: validation.disposition,
          sttValidationReason: validation.reason,
          sttPromptSimilarity: validation.promptSimilarity,
          sttNormalizedTranscriptChars:
            validation.normalizedTranscriptChars,
          sttNormalizedPromptChars: validation.normalizedPromptChars,
          sttAudioDurationMs: validation.audioDurationMs,
          sttTranscriptCharsPerSecond:
            validation.transcriptCharsPerSecond,
          sttDensitySuspicious: validation.densitySuspicious,
        };
        traceStoreRef.current.finishStep(traceId, sttStepId, "success", {
          transcriptChars: rawText.length,
          ...sttValidationMetadata,
        });
        traceStoreRef.current.updateMetadata(
          traceId,
          sttValidationMetadata
        );
        const validationStepId = traceStoreRef.current.startStep(
          traceId,
          "STT output validation",
          sttValidationMetadata
        );
        traceStoreRef.current.finishStep(
          traceId,
          validationStepId,
          "success"
        );

        if (rawText) {
          const rejected = validation.disposition === "rejected";
          const recordedText = rejected ? rawText.slice(0, 2_000) : rawText;
          traceStoreRef.current.recordOutput(
            traceId,
            rejected ? "stt rejected output" : "stt raw output",
            recordedText,
            {
              turnId: turn?.id,
              audioSegmentSeq: segment.sequence,
              audioSessionId: segment.sessionId,
              speaker: segment.speaker,
              source: segment.source,
              ...sttValidationMetadata,
              rawOutputTruncated: recordedText.length < rawText.length,
            }
          );
        }

        if (turn) {
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

          if (classification.promptEligible) {
            flushPendingSentenceCompletion("meaningful-speaker-switch-me");
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

        if (
          pendingSentenceCompletionRef.current &&
          isTaskSwitchTranscript(turn.text)
        ) {
          flushPendingSentenceCompletion("explicit-task-switch");
        }

        const sentenceMergeContext = consumePendingSentenceCompletion(
          turn,
          segment
        );
        const sentenceCompletionDecision = decideSentenceCompletion(turn.text);
        if (sentenceCompletionDecision.disposition === "buffer") {
          holdPendingSentenceCompletion(
            turn,
            segment,
            sentenceCompletionDecision,
            sentenceMergeContext
          );
          return;
        }

        traceStoreRef.current.updateMetadata(traceId, {
          sentenceBufferOperationId: sentenceMergeContext?.operationId,
          sentenceBufferOperationRole: sentenceMergeContext
            ? "terminal"
            : undefined,
          sentenceBufferOutcome: sentenceMergeContext ? "merged" : undefined,
          sentenceBufferDisposition: sentenceMergeContext
            ? "merged-and-bypassed"
            : "bypassed",
          sentenceBufferReason: sentenceCompletionDecision.reason,
          sentenceBufferConfidence: sentenceCompletionDecision.confidence,
          sentenceBufferEvidence: sentenceCompletionDecision.evidence,
          sentenceBufferFragmentCount:
            (sentenceMergeContext?.fragmentTurnIds.length ?? 0) + 1,
          sentenceBufferAddedLatencyMs: sentenceMergeContext
            ? Date.now() - sentenceMergeContext.firstHeldAt
            : 0,
          sentenceBufferMergedTranscriptChars: turn.text.length,
        });

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
          const taskSwitchContent = [
            "中文思路: 这听起来像是在切换到新题或新任务。",
            "Answer: -",
            "Clarifying question: Should I treat this as a new task?",
            "Clarifying options: -",
          ].join("\n");
          const taskSwitchAnswer = parseMeetingAnswer(taskSwitchContent, {
            expectedProfile: "compact-spoken",
          });
          const taskSwitchSuggestion: AdvisorSuggestion = {
            id: createMeetingId("task_switch"),
            sourceTraceId: traceId,
            kind: "clarifying-question",
            content: taskSwitchContent,
            meetingAnswer: taskSwitchAnswer,
            answerProfile: taskSwitchAnswer.profile,
            createdAt: Date.now(),
            ...buildSuggestionTaskMetadata(activeContextState.activeMeetingTask),
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
          const turnIntentDecision = decideAdvisorTurnIntent(turn.text, {
            hasActiveTask: hasActiveInterviewTask,
            hasPendingConfirmation: true,
          });
          promoteMeTurnForFusion(clarificationMatch.meTurn, turn.id);
          turn.contextPromptEligible = true;
          turn.contextFusionStatus = "paired";
          turn.relatedTurnIds = [clarificationMatch.meTurn.id];
          traceStoreRef.current.updateMetadata(traceId, {
            ...formatAdvisorTurnIntentForTrace(turnIntentDecision),
            turnGateAction: turnIntentDecision.action,
            turnGateReason: "clarification-pair",
          });
          const gateStepId = traceStoreRef.current.startStep(
            traceId,
            "Advisor turn gate",
            {
              action: "answer-refresh",
              reason: "clarification-pair",
              ...formatAdvisorTurnIntentForTrace(turnIntentDecision),
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
            traceId,
            turnIntentDecision,
            turn.id
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
          ...formatAdvisorTurnIntentForTrace(turnGate),
          turnGateAction: turnGate.action,
          turnGateReason: turnGate.reason,
          memoryRetrievalSuppressedReason: turnGate.executionAuthorized
            ? undefined
            : `turn-intent:${turnGate.reason}`,
          modelExecutionSuppressedReason: turnGate.executionAuthorized
            ? undefined
            : `turn-intent:${turnGate.reason}`,
        });
        const gateStepId = traceStoreRef.current.startStep(
          traceId,
          "Advisor turn gate",
          {
            action: turnGate.action,
            reason: turnGate.reason,
            ...formatAdvisorTurnIntentForTrace(turnGate),
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
          traceId,
          turnGate,
          turn.id
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
      cancelActiveAdvisorJob,
      consumePendingSentenceCompletion,
      flushPendingSentenceCompletion,
      holdPendingConfirmation,
      holdPendingSentenceCompletion,
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
    (nativeEvent: NativeSpeechDetectedEvent) => {
      if (
        !activeRef.current ||
        nativeCaptureSessionIdRef.current !== nativeEvent.captureSessionId
      ) {
        return;
      }

      const sessionId = audioSessionIdRef.current;
      const sequence = audioSegmentSeqRef.current + 1;
      audioSegmentSeqRef.current = sequence;
      const pendingSentence = pendingSentenceCompletionRef.current;
      if (pendingSentence?.segment.sessionId === sessionId) {
        window.clearTimeout(pendingSentence.timeoutId);
        pendingSentence.continuationSequence = sequence;
        traceStoreRef.current.updateMetadata(pendingSentence.segment.traceId, {
          sentenceBufferDisposition: "continuation-audio-queued",
          sentenceBufferContinuationQueuedAt: Date.now(),
          sentenceBufferContinuationSequence: sequence,
        });
      }
      const queuedAt = Date.now();
      const nativeMetadata = buildNativeSpeechEventTraceMetadata(nativeEvent);

      const trace = traceStoreRef.current.startTrace("voice", {
        ...nativeMetadata,
        audioSegmentSeq: sequence,
        audioSessionId: sessionId,
        speaker: "them",
        source: "system-audio",
        ...captureLifecycleCoordinatorRef.current?.getTraceMetadata(),
      });
      const queueStepId = traceStoreRef.current.startStep(
        trace.id,
        "System audio speech queued",
        {
          audioSegmentSeq: sequence,
          audioSessionId: sessionId,
          speaker: "them",
          source: "system-audio",
          nativeCaptureSessionId: nativeEvent.captureSessionId,
          nativeSegmentSequence: nativeEvent.segmentSequence,
          nativeCapturedAtMs: nativeEvent.capturedAtMs,
        }
      );
      const segment: QueuedSpeechSegment = {
        base64Audio: nativeEvent.audioBase64,
        audioBase64Chars: nativeEvent.audioBase64.length,
        sessionId,
        sequence,
        queuedAt,
        speaker: "them",
        source: "system-audio",
        nativeCaptureSessionId: nativeEvent.captureSessionId,
        nativeSegmentSequence: nativeEvent.segmentSequence,
        nativeCapturedAtMs: nativeEvent.capturedAtMs,
        traceId: trace.id,
        queueStepId,
      };

      systemAudioQueueTailRef.current = systemAudioQueueTailRef.current
        .catch(() => undefined)
        .then(() => processQueuedSpeechSegment(segment))
        .catch((error) => {
          console.warn("Failed to process queued system audio segment", error);
        })
        .finally(() => {
          const pending = pendingSentenceCompletionRef.current;
          if (
            !pending ||
            pending.segment.sessionId !== sessionId ||
            pending.continuationSequence !== sequence
          ) {
            return;
          }

          pending.timeoutId = window.setTimeout(() => {
            flushPendingSentenceCompletion("continuation-stt-settled-timeout");
          }, SENTENCE_COMPLETION_BUFFER_MS);
          traceStoreRef.current.updateMetadata(pending.segment.traceId, {
            sentenceBufferDisposition: "continuation-stt-settled",
            sentenceBufferContinuationSettledAt: Date.now(),
            sentenceBufferContinuationSequence: sequence,
          });
        });
    },
    [flushPendingSentenceCompletion, processQueuedSpeechSegment]
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
        ...captureLifecycleCoordinatorRef.current?.getTraceMetadata(),
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
    speechDetectedHandlerRef.current = (event: NativeSpeechDetectedEvent) => {
      enqueueSpeechDetected(event);
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
    const coordinator = captureLifecycleCoordinatorRef.current!;
    const lifecycleOperation = coordinator.claim(
      resetContext ? "start" : "resume"
    );
    nativeCaptureSessionIdRef.current = null;
    nativeCaptureGenerationRef.current = null;
    lastNativeSegmentSequenceRef.current = 0;

    if (state.settings.privacyMode === "memory-only") {
      activeRef.current = false;
      invalidateAudioProcessingSession();
      cancelActiveAdvisorJob("local-only-mode-unavailable");
      screenAnalysisAbortRef.current?.abort();
      screenAnalysisAbortRef.current = null;
      setState((previous) => ({
        ...previous,
        status: "error",
        partialSuggestion: "",
        error: LOCAL_ONLY_UNAVAILABLE_MESSAGE,
      }));
      coordinator.authorize(lifecycleOperation, "blocked-local-only-mode");
      return;
    }

    if (!sttProvider) {
      activeRef.current = false;
      invalidateAudioProcessingSession();
      cancelActiveAdvisorJob("stt-provider-missing");
      screenAnalysisAbortRef.current?.abort();
      screenAnalysisAbortRef.current = null;
      setState((previous) => ({
        ...previous,
        status: "error",
        partialSuggestion: "",
        error: MISSING_STT_MESSAGE,
      }));
      coordinator.authorize(lifecycleOperation, "blocked-stt-provider-missing");
      return;
    }

    setState((previous) => ({
      ...previous,
      status: "starting",
      partialSuggestion: "",
      error: null,
    }));

    await coordinator.run(lifecycleOperation, async () => {
      let nativeStartAttempted = false;
      try {
        const hasAccess = await invoke<boolean>("check_system_audio_access");
        if (
          !coordinator.recordNativeCompletion(
            lifecycleOperation,
            "check_system_audio_access"
          )
        ) {
          return;
        }
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

        cancelActiveAdvisorJob("meeting-audio-capture-restarting");
        activeRef.current = false;
        invalidateAudioProcessingSession();

        await invoke<MeetingAudioStatus>("stop_meeting_audio_session");
        if (
          !coordinator.recordNativeCompletion(
            lifecycleOperation,
            "stop_before_start"
          )
        ) {
          return;
        }

        const deviceId =
          selectedAudioDevices.output.id &&
          selectedAudioDevices.output.id !== "default"
            ? selectedAudioDevices.output.id
            : null;

        nativeStartAttempted = true;
        const audioStatus = await invoke<MeetingAudioStatus>(
          "start_meeting_audio_session",
          {
            vadConfig: state.settings.audio.config,
            deviceId,
          }
        );

        if (
          !coordinator.recordNativeCompletion(
            lifecycleOperation,
            "start_meeting_audio_session"
          )
        ) {
          await coordinator.cleanupStale(
            lifecycleOperation,
            "late-native-start-completion",
            () => invoke<MeetingAudioStatus>("stop_meeting_audio_session")
          );
          return;
        }

        const nativeCaptureSessionId = audioStatus.captureSessionId?.trim();
        const nativeCaptureGeneration = audioStatus.captureGeneration;
        if (!nativeCaptureSessionId || nativeCaptureGeneration == null) {
          await invoke<MeetingAudioStatus>("stop_meeting_audio_session");
          throw new Error(
            "Native audio capture started without a capture session id."
          );
        }

        startAudioProcessingSession();
        nativeCaptureSessionIdRef.current = nativeCaptureSessionId;
        nativeCaptureGenerationRef.current = nativeCaptureGeneration;
        lastNativeSegmentSequenceRef.current = 0;
        activeRef.current = true;
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
          lastMemoryContext: resetContext
            ? undefined
            : previous.lastMemoryContext,
          speechCorrections: resetContext ? [] : previous.speechCorrections,
          partialSuggestion: "",
          error: null,
          audioStatus,
        }));
      } catch (error) {
        const authorized = coordinator.authorize(
          lifecycleOperation,
          "commit-start-error"
        );
        if (!authorized && nativeStartAttempted) {
          await coordinator.cleanupStale(
            lifecycleOperation,
            "stale-native-start-error",
            () => invoke<MeetingAudioStatus>("stop_meeting_audio_session")
          );
          return;
        }
        if (!authorized) return;

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
    });
  }, [
    cancelActiveAdvisorJob,
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
    const coordinator = captureLifecycleCoordinatorRef.current!;
    const lifecycleOperation = coordinator.claim("pause");
    advanceRuntimeEpoch("meeting-assistant-paused");
    activeRef.current = false;
    invalidateAudioProcessingSession();
    cancelActiveAdvisorJob("meeting-assistant-paused");
    screenAnalysisAbortRef.current?.abort();
    screenAnalysisAbortRef.current = null;

    await coordinator.run(lifecycleOperation, async () => {
      let audioStatus: MeetingAudioStatus | null = null;

      try {
        audioStatus = await invoke<MeetingAudioStatus>(
          "stop_meeting_audio_session"
        );
        if (
          !coordinator.recordNativeCompletion(
            lifecycleOperation,
            "stop_meeting_audio_session"
          )
        ) {
          return;
        }
      } catch (error) {
        console.warn("Failed to pause meeting audio capture", error);
        if (!coordinator.authorize(lifecycleOperation, "native-pause-error")) {
          return;
        }
      }

      if (!coordinator.authorize(lifecycleOperation, "commit-pause-state")) {
        return;
      }
      setState((previous) => ({
        ...previous,
        status: "paused",
        partialSuggestion: "",
        error: null,
        audioStatus,
      }));
    });
  }, [
    advanceRuntimeEpoch,
    cancelActiveAdvisorJob,
    invalidateAudioProcessingSession,
  ]);

  const captureScreenContext = useCallback(
    async (
      source: ScreenObservation["source"] = "full-screen",
      options: CaptureScreenContextOptions = {}
    ) => {
      if (activeScreenOperationIdRef.current) {
        return;
      }

      flushPendingSentenceCompletion("screen-capture");
      const screenOperationId = createMeetingId("screen_operation");
      const screenRuntimeToken = createRuntimeCommitToken({
        operationId: screenOperationId,
        pipeline: "screen",
        snapshot: readRuntimeCommitSnapshot(),
      });
      activeScreenOperationIdRef.current = screenOperationId;
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
      const readScreenAuthorization = () =>
        authorizeRuntimeCommit({
          token: screenRuntimeToken,
          current: readRuntimeCommitSnapshot(),
          currentOperationId: activeScreenOperationIdRef.current,
        });
      const rejectStaleScreenOperation = (stage: string) => {
        const decision = readScreenAuthorization();
        traceStoreRef.current.updateMetadata(
          trace.id,
          formatRuntimeCommitAuthorizationForTrace(decision, stage)
        );
        if (decision.authorized) return false;

        analysisController?.abort();
        const runningTrace = traceStoreRef.current
          .getTraces()
          .find((candidate) => candidate.id === trace.id);
        if (runningTrace?.status === "running") {
          for (const step of runningTrace.steps) {
            if (step.status === "running") {
              traceStoreRef.current.finishStep(
                trace.id,
                step.id,
                "cancelled",
                formatRuntimeCommitAuthorizationForTrace(decision, stage)
              );
            }
          }
          traceStoreRef.current.finishTrace(
            trace.id,
            "cancelled",
            decision.reason
          );
        }
        return true;
      };

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
        if (rejectStaleScreenOperation("post-capture")) return;
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
                    if (readScreenAuthorization().authorized) {
                      sessionRecordingManagerRef.current?.recordModelOutput({
                        traceId: trace.id,
                        label: "screen preflight raw output",
                        value: output,
                      });
                    }
                  },
                },
              }),
              SCREEN_PREFLIGHT_TIMEOUT_MS,
              "Screen preflight timed out."
            );
            if (rejectStaleScreenOperation("post-preflight")) return;
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
            if (rejectStaleScreenOperation("post-preflight")) return;
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
        const screenEvidenceText = [
          screenPreflight?.question,
          observation.captureTarget?.title,
        ]
          .filter(Boolean)
          .join("\n");
        const screenSourceFallbackQuestionType =
          inferCanonicalQuestionTypeFromText(screenEvidenceText);
        const screenTaxonomyDecision = resolveTaskTaxonomyAuthority({
          candidates: [
            {
              source: "screen-preflight",
              questionType: screenPreflight?.questionType,
            },
            {
              source: "screen-source-fallback",
              questionType: screenSourceFallbackQuestionType,
            },
            { source: "generated-answer" },
          ],
        });
        const screenMemoryQuestionType =
          screenTaxonomyDecision.effectiveQuestionType;
        const taskKind =
          normalizeScreenQuestionType(screenMemoryQuestionType) ?? "unknown";
        traceStoreRef.current.updateMetadata(trace.id, {
          ...formatTaskTaxonomyAuthorityForTrace(screenTaxonomyDecision),
          screenSourceEvidenceChars: screenEvidenceText.length,
        });
        const screenMemoryAskFrame = inferMemoryAskFrameFromScreenPreflight(
          screenMemoryQuery,
          screenPreflight
        );
        const screenMemoryTopicDomain =
          inferMemoryTopicDomainFromScreenPreflight(
            screenMemoryQuery,
            screenPreflight
          );
        const provisionalScreenTaskRelation =
          resolveProvisionalScreenTaskRelation({
            existingTask:
              preflightContextState.activeInterviewTask ??
              (preflightContextState.activeMeetingTask?.screen &&
              preflightContextState.activeScreenTask
                ? buildInterviewParentFromScreenTask(
                    preflightContextState.activeScreenTask
                  )
                : undefined),
            questionType: screenMemoryQuestionType,
            projectAnchor: screenPreflight?.projectAnchor,
            questionText: screenPreflight?.question ?? screenMemoryQuery,
          });
        const existingScreenProjectBinding =
          preflightContextState.activeMeetingTask?.parent.projectBinding ??
          preflightContextState.activeInterviewTask?.projectBinding;
        const screenRetrievalProjectAnchor =
          provisionalScreenTaskRelation === "new-parent"
            ? screenPreflight?.projectAnchor
            : existingScreenProjectBinding?.projectName ??
              existingScreenProjectBinding?.projectId ??
              screenPreflight?.projectAnchor;
        const screenPlaybook = selectInterviewPlaybook({
          query: screenMemoryQuery,
          questionType: screenMemoryQuestionType,
          askFrame: screenPreflight?.askFrame ?? screenMemoryAskFrame,
          topicDomain: screenPreflight?.topicDomain ?? screenMemoryTopicDomain,
          projectAnchor: screenPreflight?.projectAnchor,
          classifierConfidence: screenPreflight?.confidence,
          interviewSessionBrief: preflightContextState.interviewSessionBrief,
          interviewSessionContext: preflightContextState.interviewSessionContext,
        });
        const screenPhaseDecision = decidePlaybookPhaseProgression({
          questionType: normalizeQuestionTypeAlias(screenMemoryQuestionType),
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
          relation: provisionalScreenTaskRelation,
          askFrame: screenPreflight?.askFrame ?? screenMemoryAskFrame,
        });
        const screenRuntimePlaybook = withInterviewPlaybookPhase(
          screenPlaybook,
          screenPhaseDecision.phase
        );
        const screenPlaybookMetadata =
          formatInterviewPlaybookForTrace(screenRuntimePlaybook);
        traceStoreRef.current.updateMetadata(trace.id, {
          ...screenPlaybookMetadata,
          ...formatPlaybookPhaseDecisionForTrace(screenPhaseDecision),
        });
        if (screenRuntimePlaybook) {
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
          projectAnchor: screenRetrievalProjectAnchor,
          memoryPolicy: screenRuntimePlaybook?.memoryPolicy,
          forceStrictProjectAnchor: Boolean(
            existingScreenProjectBinding &&
              provisionalScreenTaskRelation !== "new-parent"
          ),
          runtimeToken: screenRuntimeToken,
          currentOperationId: () => activeScreenOperationIdRef.current,
        });
        if (rejectStaleScreenOperation("post-memory")) return;
        const screenPersonalEvidenceDecision =
          detectPersonalEvidenceRequirement({
            questionText: screenPreflight?.question ?? screenMemoryQuery,
            questionType: screenMemoryQuestionType,
            mode: state.settings.personalEvidenceGuardrailMode,
          });
        const screenProjectBindingDecision = resolveProjectBinding({
          existingBinding:
            existingScreenProjectBinding,
          questionType: screenMemoryQuestionType,
          relation: provisionalScreenTaskRelation,
          requiresProjectBinding:
            screenMemoryQuestionType === "project-deep-dive" ||
            (screenPersonalEvidenceDecision.enforced &&
              screenPersonalEvidenceDecision.requirement ===
                "autobiographical-project"),
          projectAnchor: screenPreflight?.projectAnchor,
          memoryContext,
        });
        const screenFactAnchorDecision = buildFactAnchorDecision({
          questionType: screenMemoryQuestionType,
          questionText: screenPreflight?.question ?? screenMemoryQuery,
          personalEvidenceGuardrailMode:
            state.settings.personalEvidenceGuardrailMode,
          memoryContext,
          activeFactAnchors:
            preflightContextState.activeMeetingTask?.parent
              .supportedFactAnchors ??
            preflightContextState.activeInterviewTask?.supportedFactAnchors ??
            [],
          projectAnchor: screenPreflight?.projectAnchor,
          personalEvidenceDecision: screenPersonalEvidenceDecision,
          projectBindingDecision: screenProjectBindingDecision,
        });
        const projectBindingMetadata = {
          source: "screen",
          stage: "pre-model",
          questionType: screenMemoryQuestionType,
          provisionalTaskRelation: provisionalScreenTaskRelation,
          retrievalProjectAnchor: screenRetrievalProjectAnchor,
          ...formatProjectBindingDecisionForTrace(
            screenProjectBindingDecision
          ),
        };
        traceStoreRef.current.updateMetadata(
          trace.id,
          projectBindingMetadata
        );
        const projectBindingStepId = traceStoreRef.current.startStep(
          trace.id,
          "Project binding decision",
          projectBindingMetadata
        );
        traceStoreRef.current.finishStep(
          trace.id,
          projectBindingStepId,
          "success"
        );
        sessionRecordingManagerRef.current?.recordProjectBindingDecision(
          trace.id,
          projectBindingMetadata
        );
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
          screenMemoryQuestionType === "coding" ||
          screenRuntimePlaybook?.id === "coding_algorithm";
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
            interviewPlaybook: screenRuntimePlaybook,
            playbookPhaseDecision: screenPhaseDecision,
            factAnchorDecision: screenFactAnchorDecision,
            projectBindingDecision: screenProjectBindingDecision,
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
                if (readScreenAuthorization().authorized) {
                  sessionRecordingManagerRef.current?.recordModelOutput({
                    traceId: trace.id,
                    label: "screen model raw output",
                    value: output,
                    metadata: {
                      ...screenModelRouteMetadata,
                      requestOptions: screenModelRequestOptions,
                    },
                  });
                }
              },
            },
            onPartialContent: (partialContent) => {
              if (screenAnalysisAbortRef.current !== analysisController) {
                return;
              }
              const runtimeDecision = readScreenAuthorization();
              if (!runtimeDecision.authorized) {
                traceStoreRef.current.updateMetadata(
                  trace.id,
                  formatRuntimeCommitAuthorizationForTrace(
                    runtimeDecision,
                    "partial-output"
                  )
                );
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
        if (rejectStaleScreenOperation("post-model")) return;

        const parsedScreenMeetingAnswer = parseMeetingAnswer(screenTaskContent, {
          expectedProfile: resolveMeetingAnswerProfile(taskKind),
        });
        const screenMeetingAnswerSummary = buildMeetingAnswerSummary(
          parsedScreenMeetingAnswer
        );
        const screenMeetingAnswerMetadata = formatMeetingAnswerTraceMetadata(
          parsedScreenMeetingAnswer,
          screenMeetingAnswerSummary
        );
        traceStoreRef.current.updateMetadata(
          trace.id,
          screenMeetingAnswerMetadata
        );

        traceStoreRef.current.finishStep(trace.id, modelStepId, "success", {
          outputChars: screenTaskContent.length,
          ...screenModelRouteMetadata,
          ...screenMeetingAnswerMetadata,
        });
        screenAnalysisAbortRef.current = null;

        contextManagerRef.current.updateScreenObservation(observation.id, {
          visualSummary: screenTaskContent,
          analysisPromptSource: autoPrompt
            ? "screenshot-auto-prompt"
            : "meeting-default",
        });

        let updatedContextState = contextManagerRef.current.getState();
        const screenScopePreviousState = updatedContextState;
        const basedOnTurnIds = updatedContextState.transcriptTurns
          .slice(-6)
          .map((turn) => turn.id);
        const requestId = createMeetingId("screen_task");
        const question = screenPreflight?.question?.trim() ?? "";
        const screenTaskTopic =
          question || observation.captureTarget?.title?.trim() || undefined;
        traceStoreRef.current.updateMetadata(
          trace.id,
          {
            ...formatQuestionTypeTraceMetadata(
              taskKind,
              screenPreflight?.rawQuestionType
            ),
            ...formatTaskTaxonomyAuthorityForTrace(screenTaxonomyDecision),
          }
        );
        const now = Date.now();
        let screenStartedNewInterviewParent = false;
        const screenResultScopeDecision = decideScreenResultScope({
          questionType: taskKind,
          hasAnswer: Boolean(
            screenTaskContent.trim() && screenTaskContent.trim() !== "-"
          ),
        });
        traceStoreRef.current.updateMetadata(
          trace.id,
          formatScreenScopeDecisionForTrace(screenResultScopeDecision, {
            stage: "request",
            mutationApplied: false,
            previousScreenTaskId:
              screenScopePreviousState.activeScreenTask?.id,
            nextScreenTaskId: screenScopePreviousState.activeScreenTask?.id,
            previousParentId:
              screenScopePreviousState.activeMeetingTask?.parent.id ??
              screenScopePreviousState.activeInterviewTask?.id,
            nextParentId:
              screenScopePreviousState.activeMeetingTask?.parent.id ??
              screenScopePreviousState.activeInterviewTask?.id,
          })
        );

        if (screenResultScopeDecision.action === "replace") {
          const existingInterviewTask = updatedContextState.activeInterviewTask;
          const screenLanguage = inferTrustedProgrammingLanguage({
            screenPreflightLanguage: screenPreflight?.programmingLanguage,
            textHints: [screenPreflight?.question, recentTranscript],
            codeFenceContent: screenTaskContent,
          });
          traceStoreRef.current.updateMetadata(trace.id, {
            programmingLanguage: screenLanguage.language,
            programmingLanguageSource: screenLanguage.source,
          });
          const activeScreenTask: ActiveScreenTask = {
            id: requestId,
            observationId: observation.id,
            createdAt: now,
            updatedAt: now,
            expiresAt: getActiveScreenTaskExpiresAt(state.settings, now),
            question: screenTaskTopic,
            kind: taskKind,
            language: screenLanguage.language,
            classifier: {
              questionType: taskKind,
              askFrame: screenPreflight?.askFrame,
              topicDomain: screenPreflight?.topicDomain,
              projectAnchor: screenPreflight?.projectAnchor,
              confidence: screenPreflight?.confidence,
            },
            playbook: screenRuntimePlaybook,
            content: screenTaskContent,
            basedOnTurnIds,
            basedOnObservationId: observation.id,
          };

          const screenRelationDecision = decideScreenTaskRelation({
            existingTask: existingInterviewTask,
            taskKind,
            question: screenTaskTopic,
            screenEvidenceText,
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

          const reconciledScreenProjectBindingDecision =
            resolveProjectBinding({
              existingBinding: existingInterviewTask?.projectBinding,
              questionType: screenMemoryQuestionType,
              relation: screenRelationDecision.relation,
              requiresProjectBinding:
                screenMemoryQuestionType === "project-deep-dive" ||
                (screenPersonalEvidenceDecision.enforced &&
                  screenPersonalEvidenceDecision.requirement ===
                    "autobiographical-project"),
              projectAnchor: screenPreflight?.projectAnchor,
              memoryContext,
            });
          const reconciledProjectBindingMetadata = {
            source: "screen",
            stage: "continuity-reconciliation",
            questionType: screenMemoryQuestionType,
            finalTaskRelation: screenRelationDecision.relation,
            ...formatProjectBindingDecisionForTrace(
              reconciledScreenProjectBindingDecision
            ),
          };
          traceStoreRef.current.updateMetadata(
            trace.id,
            reconciledProjectBindingMetadata
          );
          const projectBindingReconciliationStepId =
            traceStoreRef.current.startStep(
              trace.id,
              "Project binding continuity reconciliation",
              reconciledProjectBindingMetadata
            );
          traceStoreRef.current.finishStep(
            trace.id,
            projectBindingReconciliationStepId,
            "success"
          );
          sessionRecordingManagerRef.current?.recordProjectBindingDecision(
            trace.id,
            reconciledProjectBindingMetadata
          );

          const screenContinuity = updateInterviewTaskContinuityForAnswer({
            existingTask: existingInterviewTask,
            source: "screen",
            questionType: taskKind,
            relation: screenRelationDecision.relation,
            subtaskIntent: inferAdvisorSubtaskIntent(
              screenEvidenceText,
              readMemoryQuestionType(taskKind) ?? "unknown"
            ),
            question: screenTaskTopic,
            finalContent: screenTaskContent,
            parsedAnswer: parsedScreenMeetingAnswer,
            playbook: screenRuntimePlaybook,
            phaseDecision: screenPhaseDecision,
            observationId: observation.id,
            traceId: trace.id,
            selectedOverlayIds: extractSelectedOverlayIdsFromMemory(memoryContext),
            whiteboardUpdateSource:
              screenRelationDecision.relation === "resume-parent"
                ? "screen-merge"
                : "model-output",
            expiresAt: getActiveScreenTaskExpiresAt(state.settings, now),
            supportedFactAnchors:
              reconciledScreenProjectBindingDecision.binding
                ? [reconciledScreenProjectBindingDecision.binding.projectName]
                : extractSupportedFactAnchorsFromMemory(memoryContext),
            projectBinding:
              reconciledScreenProjectBindingDecision.binding,
          });
          const previousWhiteboard =
            existingInterviewTask?.whiteboardArtifact;
          const nextWhiteboard = screenContinuity.task?.whiteboardArtifact;
          traceStoreRef.current.updateMetadata(trace.id, {
            answerCodeArtifactDecision: parsedScreenMeetingAnswer.sections.code
              ? "produced"
              : "none",
            answerWhiteboardArtifactDecision:
              parsedScreenMeetingAnswer.sections.whiteboard && nextWhiteboard
                ? !previousWhiteboard
                  ? "produced"
                  : previousWhiteboard.revision !== nextWhiteboard.revision
                    ? "updated"
                    : "preserved"
                : previousWhiteboard
                  ? "preserved"
                  : "none",
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
        }

        updatedContextState = contextManagerRef.current.getState();
        traceStoreRef.current.updateMetadata(trace.id, {
          ...formatScreenScopeDecisionForTrace(screenResultScopeDecision, {
            stage: "commit",
            mutationApplied:
              screenResultScopeDecision.action === "replace" &&
              screenScopePreviousState.activeScreenTask?.id !==
                updatedContextState.activeScreenTask?.id,
            previousScreenTaskId:
              screenScopePreviousState.activeScreenTask?.id,
            nextScreenTaskId:
              screenResultScopeDecision.action === "replace"
                ? updatedContextState.activeScreenTask?.id
                : undefined,
            previousParentId:
              screenScopePreviousState.activeMeetingTask?.parent.id ??
              screenScopePreviousState.activeInterviewTask?.id,
            nextParentId:
              screenResultScopeDecision.action === "replace"
                ? updatedContextState.activeMeetingTask?.parent.id ??
                  updatedContextState.activeInterviewTask?.id
                : undefined,
          }),
          ...(screenResultScopeDecision.action === "replace"
            ? getActiveMeetingTaskTraceMetadata(
                updatedContextState.activeMeetingTask
              )
            : {}),
        });
        if (
          screenResultScopeDecision.action === "replace" &&
          updatedContextState.activeScreenTask
        ) {
          sessionRecordingManagerRef.current?.recordTaskSnapshot(
            updatedContextState.activeScreenTask,
            trace.id
          );
        }
        if (
          screenResultScopeDecision.action === "replace" &&
          updatedContextState.activeMeetingTask
        ) {
          sessionRecordingManagerRef.current?.recordActiveMeetingTaskSnapshot(
            updatedContextState.activeMeetingTask,
            trace.id
          );
        }
        const uiStepId = traceStoreRef.current.startStep(
          trace.id,
          "Meeting Assistant state updated",
          {
            ...(screenResultScopeDecision.action === "replace"
              ? {
                  activeMeetingTaskId:
                    updatedContextState.activeMeetingTask?.id,
                  activeMeetingTaskSource:
                    updatedContextState.activeMeetingTask?.source,
                  activeScreenTaskId:
                    updatedContextState.activeScreenTask?.id,
                }
              : {}),
            screenScopeAction: screenResultScopeDecision.action,
            screenScopeDurability: screenResultScopeDecision.durability,
            suggestionKind: screenTaskContent.trim() ? "answer" : "silent",
          }
        );

        const nextSuggestion: AdvisorSuggestion = screenTaskContent.trim()
          ? {
              id: requestId,
              sourceTraceId: trace.id,
              kind: "answer",
              content: screenTaskContent.trim(),
              meetingAnswer: parsedScreenMeetingAnswer,
              answerProfile: parsedScreenMeetingAnswer.profile,
              createdAt: Date.now(),
              ...(screenResultScopeDecision.action === "replace"
                ? buildSuggestionTaskMetadata(
                    updatedContextState.activeMeetingTask
                  )
                : {}),
              basedOnTurnIds,
              basedOnObservationIds: [observation.id],
              confidence: "medium",
            }
          : {
              id: requestId,
              sourceTraceId: trace.id,
              kind: "silent",
              content: "",
              createdAt: Date.now(),
              ...(screenResultScopeDecision.action === "replace"
                ? buildSuggestionTaskMetadata(
                    updatedContextState.activeMeetingTask
                  )
                : {}),
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

        const runtimeDecision = readScreenAuthorization();
        if (!runtimeDecision.authorized) {
          rejectStaleScreenOperation("error-boundary");
          return;
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
        if (activeScreenOperationIdRef.current === screenOperationId) {
          activeScreenOperationIdRef.current = null;
        }
      }
    },
    [
      aiProvider,
      flushPendingSentenceCompletion,
      loadMemoryForPrompt,
      readRuntimeCommitSnapshot,
      resolveMeetingModelRoute,
      selectedAIProvider,
      screenshotConfiguration,
      state.settings,
      state.status,
    ]
  );

  const currentSuggestionText =
    state.partialSuggestion || state.latestSuggestion?.content || "";

  const correctActiveQuestionType = useCallback(
    async (
      correctedType: CanonicalQuestionType,
      source: ManualQuestionTypeCorrectionSource = "normal-mode"
    ) => {
      flushPendingSentenceCompletion("manual-question-type-correction");

      const contextState = contextManagerRef.current.getState();
      const activeTask = contextState.activeMeetingTask;
      if (!activeTask) {
        setState((previous) => ({
          ...previous,
          error: "There is no active question to correct.",
        }));
        return;
      }

      const decision = decideManualQuestionTypeCorrection(
        activeTask,
        correctedType
      );
      if (decision.noOp || !decision.target) return;

      const existingParent =
        contextState.activeInterviewTask ??
        (contextState.activeScreenTask
          ? buildInterviewParentFromScreenTask(contextState.activeScreenTask)
          : undefined) ??
        buildCorrectionParentFromActiveMeetingTask(activeTask, correctedType);
      if (!existingParent) {
        setState((previous) => ({
          ...previous,
          error: "The active question has no repairable parent task.",
        }));
        return;
      }

      const eventId = createMeetingId("question_type_correction");
      const operationClaim =
        manualCorrectionOperationCoordinatorRef.current.claim(eventId);
      const correctionRuntimeToken = createRuntimeCommitToken({
        operationId: eventId,
        pipeline: "correction",
        snapshot: readRuntimeCommitSnapshot(),
      });
      const supersededCorrection =
        operationClaim.supersedesOperationId &&
        state.manualQuestionTypeCorrection?.eventId ===
          operationClaim.supersedesOperationId
          ? {
              ...state.manualQuestionTypeCorrection,
              status:
                state.manualQuestionTypeCorrection.status === "pending"
                  ? ("superseded" as const)
                  : state.manualQuestionTypeCorrection.status,
              regenerationStatus:
                state.manualQuestionTypeCorrection.regenerationStatus ===
                "running"
                  ? ("cancelled" as const)
                  : state.manualQuestionTypeCorrection.regenerationStatus,
              supersededByCorrectionId: eventId,
              completedAt: Date.now(),
            }
          : undefined;
      if (supersededCorrection) {
        traceStoreRef.current.updateMetadata(
          supersededCorrection.correctionTraceId,
          {
            supersededByCorrectionId: eventId,
            correctionOperationSuperseded: true,
          }
        );
        sessionRecordingManagerRef.current?.recordManualQuestionTypeCorrection(
          supersededCorrection
        );
      }
      cancelActiveAdvisorJob("manual-question-type-correction");

      const requestedAt = Date.now();
      const correctionTrace = traceStoreRef.current.startTrace(
        activeTask.screen ? "screen" : "voice",
        {
          source: "manual-question-type-correction",
          manualQuestionTypeCorrectionSource: source,
          manualQuestionTypeCorrectionTarget: decision.target,
          detectedQuestionType: decision.detectedType,
          correctedQuestionType: decision.correctedType,
          correctionDecisionReason: decision.reason,
          supersedesCorrectionId: operationClaim.supersedesOperationId,
          ...getActiveMeetingTaskTraceMetadata(activeTask),
        }
      );
      const readCorrectionAuthorization = (token: RuntimeCommitToken) =>
        authorizeRuntimeCommit({
          token,
          current: readRuntimeCommitSnapshot(),
          currentOperationId:
            manualCorrectionOperationCoordinatorRef.current.getActiveOperationId(),
        });
      const recordCorrectionAuthorization = (
        token: RuntimeCommitToken,
        stage: string
      ) => {
        const runtimeDecision = readCorrectionAuthorization(token);
        traceStoreRef.current.updateMetadata(
          correctionTrace.id,
          formatRuntimeCommitAuthorizationForTrace(runtimeDecision, stage)
        );
        return runtimeDecision;
      };
      const correctionQuestion = resolveCorrectionQuestionInstance(
        state.questionEvaluations,
        state.latestSuggestion,
        activeTask,
        correctionTrace.id
      );
      const questionId = correctionQuestion.questionId;
      let correction: ManualQuestionTypeCorrection = {
        eventId,
        taskId: activeTask.id,
        parentTaskId: activeTask.parent.id,
        childTaskId: activeTask.child?.id,
        questionId,
        source,
        target: decision.target,
        detectedType: decision.detectedType,
        correctedType: decision.correctedType,
        correctionTraceId: correctionTrace.id,
        supersedesCorrectionId: operationClaim.supersedesOperationId,
        status: "pending",
        regenerationStatus: "idle",
        requestedAt,
      };
      traceStoreRef.current.updateMetadata(correctionTrace.id, {
        manualQuestionTypeCorrectionId: eventId,
        supersedesCorrectionId: operationClaim.supersedesOperationId,
        questionInstanceId: questionId,
        questionOriginTraceId: correctionQuestion.sourceTraceId,
      });
      setState((previous) => ({
        ...previous,
        manualQuestionTypeCorrection: correction,
        error: null,
      }));
      sessionRecordingManagerRef.current?.recordActiveMeetingTaskSnapshot(
        activeTask,
        correctionTrace.id
      );
      sessionRecordingManagerRef.current?.recordManualQuestionTypeCorrection(
        correction
      );

      const mutationStepId = traceStoreRef.current.startStep(
        correctionTrace.id,
        "Active meeting task type corrected",
        {
          manualQuestionTypeCorrectionId: eventId,
          target: decision.target,
          detectedQuestionType: decision.detectedType,
          correctedQuestionType: decision.correctedType,
        }
      );
      let mutationApplied = false;
      let correctionLifecycleToken: RuntimeCommitToken | undefined;

      try {
        const activeScreenTask = contextState.activeScreenTask;
        const askFrame = getManualOverrideAskFrame(correctedType);
        const topicDomain = getManualOverrideTopicDomain(
          correctedType,
          activeScreenTask?.classifier?.topicDomain
        );
        const correctionQuery = [
          activeTask.child?.question,
          activeTask.screen?.question,
          activeTask.parent.topic,
          contextState.transcriptTurns
            .slice(-4)
            .map((turn) => turn.text)
            .join("\n"),
        ]
          .filter(Boolean)
          .join("\n");
        const selectedPlaybook =
          decision.target === "resume-parent"
            ? existingParent.playbook
            : selectInterviewPlaybook({
                query: correctionQuery,
                questionType: correctedType,
                askFrame,
                topicDomain,
                projectAnchor: activeTask.screen?.projectAnchor,
                classifierConfidence: 1,
                interviewSessionBrief: contextState.interviewSessionBrief,
                interviewSessionContext: contextState.interviewSessionContext,
              });
        const correctedPlaybook = selectedPlaybook
          ? {
              ...selectedPlaybook,
              confidence: 1,
              reason: `${selectedPlaybook.reason}; authoritative manual runtime correction`,
            }
          : undefined;
        const expiresAt = getActiveScreenTaskExpiresAt(
          state.settings,
          requestedAt
        );
        const correctedParent = applyManualQuestionTypeCorrectionToParent({
          parent: existingParent,
          decision,
          correctedPlaybook,
          now: requestedAt,
          expiresAt,
        });
        const correctedScreenTask = activeScreenTask
          ? applyManualQuestionTypeCorrectionToScreenTask({
              task: activeScreenTask,
              correctedType,
              correctedPlaybook,
              askFrame,
              topicDomain,
              now: requestedAt,
              expiresAt,
            })
          : undefined;

        const mutationAuthorization = recordCorrectionAuthorization(
          correctionRuntimeToken,
          "pre-correction-mutation"
        );
        if (!mutationAuthorization.authorized) {
          traceStoreRef.current.finishStep(
            correctionTrace.id,
            mutationStepId,
            "cancelled",
            formatRuntimeCommitAuthorizationForTrace(
              mutationAuthorization,
              "pre-correction-mutation"
            )
          );
          traceStoreRef.current.finishTrace(
            correctionTrace.id,
            "cancelled",
            mutationAuthorization.reason
          );
          return;
        }

        contextManagerRef.current.setActiveMeetingTaskState({
          activeScreenTask: correctedScreenTask ?? null,
          activeInterviewTask: correctedParent,
        });
        if (correctedScreenTask) {
          contextManagerRef.current.updateScreenObservation(
            correctedScreenTask.observationId,
            {
              visualSummary: correctedScreenTask.content,
              analysisPromptSource: "meeting-default",
            }
          );
        }
        const correctedContextState = contextManagerRef.current.getState();
        const correctedActiveTask = correctedContextState.activeMeetingTask;
        if (!correctedActiveTask) {
          throw new Error("The corrected active meeting task could not be built.");
        }
        mutationApplied = true;
        correctionLifecycleToken = createRuntimeCommitToken({
          operationId: eventId,
          pipeline: "correction",
          snapshot: readRuntimeCommitSnapshot(),
        });

        const correctedParentAuthorization = recordCorrectionAuthorization(
          correctionLifecycleToken,
          "post-correction-mutation"
        );
        if (!correctedParentAuthorization.authorized) return;

        correction = {
          ...correction,
          status: "applied",
          appliedAt: Date.now(),
        };
        traceStoreRef.current.updateMetadata(correctionTrace.id, {
          ...formatInterviewPlaybookForTrace(correctedPlaybook),
          ...getActiveMeetingTaskTraceMetadata(correctedActiveTask),
          correctionStatus: correction.status,
          correctionVisibleAnswerCleared: true,
          correctionReliableAnswerCleared: true,
        });
        traceStoreRef.current.finishStep(
          correctionTrace.id,
          mutationStepId,
          "success"
        );
        traceStoreRef.current.finishTrace(correctionTrace.id, "success");
        sessionRecordingManagerRef.current?.recordActiveMeetingTaskSnapshot(
          correctedActiveTask,
          correctionTrace.id
        );
        if (correctedScreenTask) {
          sessionRecordingManagerRef.current?.recordTaskSnapshot(
            correctedScreenTask,
            correctionTrace.id
          );
        }

        const regenerationTrace = traceStoreRef.current.startTrace(
          correctedActiveTask.screen ? "screen" : "voice",
          {
            source: "manual-question-type-correction-regeneration",
            questionInstanceId: questionId,
            questionOriginTraceId: correctionQuestion.sourceTraceId,
            parentCorrectionTraceId: correctionTrace.id,
            manualQuestionTypeCorrectionId: eventId,
            detectedQuestionType: decision.detectedType,
            correctedQuestionType: decision.correctedType,
            manualQuestionTypeCorrectionTarget: decision.target,
            ...getActiveMeetingTaskTraceMetadata(correctedActiveTask),
          }
        );
        correction = {
          ...correction,
          regenerationTraceId: regenerationTrace.id,
          regenerationStatus: "running",
        };
        const correctionMemorySnapshot = correctionQuestion.sourceTraceId
          ? resolveTraceMemoryEvaluationSnapshot(
              traceStoreRef.current
                .getTraces()
                .find(
                  (candidate) =>
                    candidate.id === correctionQuestion.sourceTraceId
                )
            ).snapshot
          : undefined;

        const questionEvaluations = upsertQuestionHumanEvaluation(
          state.questionEvaluations,
          {
            sessionId:
              state.sessionRecording.sessionId ?? correctedContextState.sessionId,
            traceId: correctionTrace.id,
            traceKind: correctionTrace.kind,
            taskId: correctedActiveTask.id,
            parentTaskId: correctedActiveTask.parent.id,
            childTaskId: activeTask.child?.id,
            taskSource: correctedActiveTask.source,
            questionType: toHumanEvalQuestionType(decision.detectedType),
            playbookId: correctedPlaybook?.id,
            playbookPhase: correctedPlaybook?.phase,
            memoryRetrievalSnapshot: correctionMemorySnapshot,
          },
          {
            questionId,
            traceIds: [
              ...(correctionQuestion.sourceTraceId
                ? [correctionQuestion.sourceTraceId]
                : []),
              correctionTrace.id,
              regenerationTrace.id,
            ],
            questionType: toHumanEvalQuestionType(decision.detectedType),
            correctedQuestionType: toHumanEvalQuestionType(
              decision.correctedType
            ),
            manualQuestionTypeCorrectionId: eventId,
            manualQuestionTypeCorrectionTraceId: correctionTrace.id,
            manualQuestionTypeRegenerationTraceId: regenerationTrace.id,
            manualQuestionTypeCorrectionSource: source,
            classification: {
              verdict: "wrong",
              reasons: ["manual-runtime-correction"],
            },
          }
        );
        const evaluation = questionEvaluations.find(
          (candidate) => candidate.questionId === questionId
        );
        correction = {
          ...correction,
          evaluationId: evaluation?.id,
        };
        persistQuestionHumanEvaluations(questionEvaluations);
        sessionRecordingManagerRef.current?.recordQuestionHumanEvaluations(
          questionEvaluations
        );
        sessionRecordingManagerRef.current?.recordManualQuestionTypeCorrection(
          correction
        );
        setState((previous) => ({
          ...previous,
          ...clearSuggestionProjectionForManualCorrection(),
          activeScreenTask: correctedContextState.activeScreenTask,
          activeInterviewTask: correctedContextState.activeInterviewTask,
          activeMeetingTask: correctedActiveTask,
          screenObservations: correctedContextState.screenObservations,
          questionEvaluations,
          manualQuestionTypeCorrection: correction,
          error: null,
        }));

        await runAdvisor({
          force: true,
          mode: correctedActiveTask.screen ? "screen-anchored" : "live",
          traceId: regenerationTrace.id,
          manualQuestionTypeCorrection: correction,
          advisorJobSource: "manual-correction",
          taskMutationAuthority: "manual-correction",
        });
        const regenerationStatus = traceStoreRef.current
          .getTraces()
          .find((trace) => trace.id === regenerationTrace.id)?.status;
        const completionToken =
          regenerationStatus === "success"
            ? rebaseRuntimeCommitTokenAfterOwnedParentMutation({
                token: correctionLifecycleToken,
                snapshot: readRuntimeCommitSnapshot(),
                expectedRevisionDelta: 1,
              }) ?? correctionLifecycleToken
            : correctionLifecycleToken;
        if (completionToken !== correctionLifecycleToken) {
          traceStoreRef.current.updateMetadata(correctionTrace.id, {
            correctionRuntimeCommitTokenRebased: true,
            correctionRuntimeCommitTokenRebaseReason:
              "owned-regeneration-parent-mutation",
            correctionRuntimeCommitTokenParentId:
              completionToken.parentExpectation.kind === "exact"
                ? completionToken.parentExpectation.parentId
                : undefined,
            correctionRuntimeCommitTokenParentRevision:
              completionToken.parentExpectation.kind === "exact"
                ? completionToken.parentExpectation.parentRevision
                : undefined,
          });
        }
        const completionAuthorization = recordCorrectionAuthorization(
          completionToken,
          "post-correction-regeneration"
        );
        if (!completionAuthorization.authorized) return;
        correction = {
          ...correction,
          regenerationStatus:
            regenerationStatus === "success"
              ? "succeeded"
              : regenerationStatus === "cancelled"
                ? "cancelled"
                : "failed",
          completedAt: Date.now(),
          error:
            regenerationStatus === "error"
              ? "Answer regeneration failed. The corrected task type was kept."
              : undefined,
        };
        sessionRecordingManagerRef.current?.recordManualQuestionTypeCorrection(
          correction
        );
        setState((previous) => ({
          ...previous,
          manualQuestionTypeCorrection: correction,
        }));
      } catch (error) {
        const failureAuthorization = recordCorrectionAuthorization(
          correctionLifecycleToken ?? correctionRuntimeToken,
          "correction-error-boundary"
        );
        if (!failureAuthorization.authorized) return;
        correction = {
          ...correction,
          status: mutationApplied ? "applied" : "failed",
          regenerationStatus: mutationApplied ? "failed" : "idle",
          completedAt: Date.now(),
          error:
            mutationApplied
              ? `The task type was corrected, but answer regeneration failed: ${
                  error instanceof Error ? error.message : "unknown error"
                }`
              : error instanceof Error
                ? error.message
                : "Failed to correct the active question type.",
        };
        if (!mutationApplied) {
          traceStoreRef.current.finishStep(
            correctionTrace.id,
            mutationStepId,
            "error",
            undefined,
            error
          );
          traceStoreRef.current.finishTrace(correctionTrace.id, "error", error);
        } else if (correction.regenerationTraceId) {
          const regenerationTrace = traceStoreRef.current
            .getTraces()
            .find((trace) => trace.id === correction.regenerationTraceId);
          if (regenerationTrace?.status === "running") {
            traceStoreRef.current.finishTrace(
              correction.regenerationTraceId,
              "error",
              error
            );
          }
        }
        sessionRecordingManagerRef.current?.recordManualQuestionTypeCorrection(
          correction
        );
        setState((previous) => ({
          ...previous,
          manualQuestionTypeCorrection: correction,
          error: correction.error ?? null,
        }));
      } finally {
        manualCorrectionOperationCoordinatorRef.current.release(eventId);
      }
    },
    [
      cancelActiveAdvisorJob,
      flushPendingSentenceCompletion,
      readRuntimeCommitSnapshot,
      runAdvisor,
      state.latestSuggestion,
      state.manualQuestionTypeCorrection,
      state.questionEvaluations,
      state.sessionRecording.sessionId,
      state.settings,
    ]
  );

  const resolveCurrentSuggestionQuestionLineage = useCallback(
    () =>
      resolveSuggestionQuestionLineage({
        suggestion: state.latestSuggestion,
        traces: traceStoreRef.current.getTraces(),
      }),
    [state.latestSuggestion]
  );

  const regenerateSuggestion = useCallback(async () => {
    flushPendingSentenceCompletion("regenerate");
    await runAdvisor({
      force: true,
      mode: "regenerate",
      currentSuggestion: currentSuggestionText,
      advisorJobSource: "regenerate",
      taskMutationAuthority: "preserve-parent",
      questionLineage: resolveCurrentSuggestionQuestionLineage(),
    });
  }, [
    currentSuggestionText,
    flushPendingSentenceCompletion,
    resolveCurrentSuggestionQuestionLineage,
    runAdvisor,
  ]);

  const applyResponseAction = useCallback(
    async (responseAction: MeetingResponseActionMode) => {
      flushPendingSentenceCompletion(
        responseAction === "next-phase" ? "manual-next" : "response-action"
      );
      if (!currentSuggestionText.trim()) {
        setState((previous) => ({
          ...previous,
          error: NO_SUGGESTION_MESSAGE,
        }));
        return;
      }

      if (responseAction === "next-phase" && !state.activeMeetingTask) {
        setState((previous) => ({
          ...previous,
          error: NO_ACTIVE_TASK_MESSAGE,
        }));
        return;
      }

      await runAdvisor({
        force: true,
        mode: "response-action",
        responseAction,
        currentSuggestion: currentSuggestionText,
        advisorJobSource: "response-action",
        taskMutationAuthority: "preserve-parent",
        questionLineage: resolveCurrentSuggestionQuestionLineage(),
      });
    },
    [
      currentSuggestionText,
      flushPendingSentenceCompletion,
      resolveCurrentSuggestionQuestionLineage,
      runAdvisor,
      state.activeMeetingTask,
    ]
  );

  const answerClarifyingQuestion = useCallback(
    async (
      question: string,
      answer: ClarifyingQuestionAnswer,
      option?: { label?: string; value?: string }
    ) => {
      const trimmedQuestion = question.trim();
      if (!trimmedQuestion) return;

      flushPendingSentenceCompletion("clarifying-answer");

      const hasActiveScreenTask = Boolean(
        contextManagerRef.current.getState().activeMeetingTask?.screen
      );

      await runAdvisor({
        force: true,
        mode: hasActiveScreenTask ? "screen-anchored" : "clarifying-answer",
        currentSuggestion: currentSuggestionText,
        advisorJobSource: "clarifying-answer",
        taskMutationAuthority: "preserve-parent",
        questionLineage: resolveCurrentSuggestionQuestionLineage(),
        clarifyingFeedback: {
          question: trimmedQuestion,
          answer,
          answerLabel: option?.label,
          answerValue: option?.value,
        },
      });
    },
    [
      currentSuggestionText,
      flushPendingSentenceCompletion,
      resolveCurrentSuggestionQuestionLineage,
      runAdvisor,
    ]
  );

  const submitSpeechCorrection = useCallback(
    async (input: string) => {
      flushPendingSentenceCompletion("emergency-correction");
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
          advisorJobSource: "response-action",
          taskMutationAuthority: "preserve-parent",
          questionLineage: resolveCurrentSuggestionQuestionLineage(),
        });
      }
    },
    [
      currentSuggestionText,
      flushPendingSentenceCompletion,
      resolveCurrentSuggestionQuestionLineage,
      runAdvisor,
    ]
  );

  useEffect(() => {
    let cancelled = false;

    const loadPersistedTraceMetrics = async () => {
      try {
        const payload = await invoke<string>("read_meeting_trace_metrics");
        if (cancelled) return;

        const traces = parseMeetingTraceMetrics(payload);
        lastTraceMetricsPayloadRef.current = traces.length ? payload : null;
        if (traces.length) {
          traceStoreRef.current.hydrate(traces);
        }
      } catch (error) {
        console.warn("Failed to load meeting trace metrics", error);
      } finally {
        if (!cancelled) {
          traceMetricsPersistenceReadyRef.current = true;
          scheduleTraceMetricsPersistence();
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
      if (traceMetricsPersistRetryTimerRef.current !== null) {
        window.clearTimeout(traceMetricsPersistRetryTimerRef.current);
        traceMetricsPersistRetryTimerRef.current = null;
      }
    };
  }, [scheduleTraceMetricsPersistence]);

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
    let unlistenLifecycle: (() => void) | undefined;

    const setupListeners = async () => {
      const unlisten = await listen<unknown>("speech-detected", (event) => {
        const authorization = authorizeNativeSpeechDetectedEvent({
          payload: event.payload,
          activeCaptureSessionId: nativeCaptureSessionIdRef.current,
          lastAcceptedSequence: lastNativeSegmentSequenceRef.current,
          expectedOwner: "meeting",
          activeCaptureGeneration: nativeCaptureGenerationRef.current,
        });
        if (!authorization.authorized) {
          const metadata = {
            authorized: false,
            reason: authorization.reason,
            activeNativeCaptureSessionId: nativeCaptureSessionIdRef.current,
            ...(authorization.event
              ? buildNativeSpeechEventTraceMetadata(authorization.event)
              : {}),
          };
          console.info(
            `[${new Date().toISOString()}] [native-speech-event] rejected`,
            JSON.stringify(metadata)
          );
          sessionRecordingManagerRef.current?.recordNativeSpeechEvent(metadata);
          return;
        }

        lastNativeSegmentSequenceRef.current =
          authorization.event.segmentSequence;
        speechDetectedHandlerRef.current?.(authorization.event);
      });

      if (disposed) {
        unlisten();
        return;
      }

      unlistenSpeech = unlisten;

      const lifecycleUnlisten = await listen<unknown>(
        "native-audio-lifecycle",
        (event) => {
          const authorization = authorizeNativeAudioLifecycleEvent({
            payload: event.payload,
            expectedOwner: "meeting",
            activeCaptureSessionId: nativeCaptureSessionIdRef.current,
            activeCaptureGeneration: nativeCaptureGenerationRef.current,
          });
          const metadata = {
            authorized: authorization.authorized,
            ...(!authorization.authorized
              ? { rejectionReason: authorization.reason }
              : {}),
            ...(authorization.event
              ? buildNativeAudioLifecycleTraceMetadata(authorization.event)
              : {}),
          };
          sessionRecordingManagerRef.current?.recordCaptureLifecycle(metadata);
          console.info(
            `[${new Date().toISOString()}] [native-audio-lifecycle]`,
            JSON.stringify(metadata)
          );
          if (!authorization.authorized) return;
          if (authorization.event.eventType === "started") return;

          const terminalEvent = authorization.event;
          activeRef.current = false;
          invalidateAudioProcessingSession();
          cancelActiveAdvisorJob(`native-audio-${terminalEvent.eventType}`);
          setState((previous) => ({
            ...previous,
            status: "error",
            partialSuggestion: "",
            audioStatus: null,
            error:
              terminalEvent.message ||
              (terminalEvent.eventType === "error"
                ? "System audio capture failed."
                : "System audio capture stopped unexpectedly."),
          }));
        }
      );

      if (disposed) {
        lifecycleUnlisten();
        return;
      }
      unlistenLifecycle = lifecycleUnlisten;
    };

    void setupListeners().catch((error) => {
      console.warn("Failed to setup meeting speech listener", error);
    });

    return () => {
      disposed = true;
      unlistenSpeech?.();
      unlistenLifecycle?.();
    };
  }, [cancelActiveAdvisorJob, invalidateAudioProcessingSession]);

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
            : isScreenAnchoredSuggestion(previous.latestSuggestion)
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
      cancelActiveAdvisorJob("component-unmounted");
      if (activeRef.current) {
        void stop();
      } else {
        void sessionRecordingManagerRef.current?.stop("component-unmounted");
      }
    };
  }, [cancelActiveAdvisorJob, stop]);

  return {
    ...state,
    setupWarnings,
    setPrivacyMode,
    setScreenContextEnabled,
    setActiveScreenTaskTimeoutMinutes,
    setInterviewSessionBrief,
    clearInterviewSessionBrief,
    setUseMemory,
    setPersonalEvidenceGuardrailMode,
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
    correctActiveQuestionType,
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
  force = false,
}: {
  memoryPolicy: MemoryRetrievalPolicy | undefined;
  questionType: MemoryQuestionType | undefined;
  projectAnchor: string | undefined;
  query: string;
  force?: boolean;
}): MemoryRetrievalPolicy | undefined {
  const anchor = projectAnchor?.trim();
  if (
    (!force && questionType !== "project-deep-dive") ||
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
    context.activeMeetingTask?.parent.projectBinding?.projectName ??
    context.activeMeetingTask?.parent.projectBinding?.projectId ??
    context.activeInterviewTask?.projectBinding?.projectName ??
    context.activeInterviewTask?.projectBinding?.projectId ??
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

function buildExplicitActionAdvisorTaskQuery(
  context: AdvisorPromptContext,
  currentSuggestion?: string,
  clarifyingFeedback?: ClarifyingQuestionFeedback
) {
  const selectedClarifyingAnswer =
    clarifyingFeedback?.answer === "option"
      ? clarifyingFeedback.answerValue ?? clarifyingFeedback.answerLabel
      : clarifyingFeedback?.answer;

  return [
    formatAdvisorActiveTaskForQuery(context, "active parent") || undefined,
    currentSuggestion?.trim()
      ? `current answer:\n${currentSuggestion.trim()}`
      : undefined,
    clarifyingFeedback?.question
      ? `clarifying question: ${clarifyingFeedback.question}`
      : undefined,
    selectedClarifyingAnswer
      ? `selected clarification: ${selectedClarifyingAnswer}`
      : undefined,
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
  const latestQuestionTypeDecision = latestUsefulText
    ? inferQuestionTypeDecisionFromText(latestUsefulText)
    : undefined;
  const latestQuestionType = openingRoute?.questionType ??
    latestQuestionTypeDecision?.type ??
    "unknown";
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
    const latestHasParentOverrideAuthority = Boolean(
      openingRoute ||
        canQuestionTypeDecisionOverrideParent(latestQuestionTypeDecision)
    );
    const useLatestAsChild = shouldUseLatestTurnAsChildProbe({
      activeQuestionType,
      latestQuestionType,
      latestText: latestUsefulText,
    });
    const shouldStartNewParent =
      Boolean(latestLooksLikeTask) &&
      latestHasParentOverrideAuthority &&
      activeParentKind !== undefined &&
      latestIsParentKind &&
      latestParentKind !== undefined &&
      !isCompatibleParentKind(activeParentKind, latestParentKind) &&
      (!useLatestAsChild || isTaskSwitchTranscript(latestUsefulText));

    if (shouldStartNewParent) {
      return {
        questionType: latestQuestionType,
        questionTypeDecision: latestQuestionTypeDecision,
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
        latestTurnAskFrame: latestAskFrame,
        latestTurnTaxonomyBoundaryReason: openingRoute
          ? "opening-route"
          : "latest-turn-classified",
        taxonomyFallbackSuppressed: false,
        unknownTaskMutationBlocked: false,
      };
    }

    if (useLatestAsChild) {
      return {
        questionType: latestQuestionType,
        questionTypeDecision: latestQuestionTypeDecision,
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
        latestTurnAskFrame: latestAskFrame,
        latestTurnTaxonomyBoundaryReason: "active-parent-continuity",
        taxonomyFallbackSuppressed: false,
        unknownTaskMutationBlocked: false,
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
      questionTypeDecision: latestQuestionTypeDecision,
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
      latestTurnAskFrame: latestAskFrame,
      latestTurnTaxonomyBoundaryReason: "active-parent-continuity",
      taxonomyFallbackSuppressed: false,
      unknownTaskMutationBlocked: false,
    };
  }

  const latestTurnBoundary = decideLatestTurnTaxonomyBoundary({
    latestQuestionType:
      normalizeCanonicalQuestionType(latestQuestionType) ?? "unknown",
    hasLatestUsefulText: Boolean(latestUsefulText),
    hasOpeningRoute: Boolean(openingRoute),
  });
  const questionType = latestTurnBoundary.questionType;

  return {
    questionType,
    questionTypeDecision: latestQuestionTypeDecision,
    askFrame: latestAskFrame,
    topicDomain: latestTopicDomain,
    query: latestUsefulText
      ? buildFocusedAdvisorTaskQuery(context, latestUsefulText)
      : fallbackQuery,
    taskRelation: latestTurnBoundary.allowsNewTaskSignal
      ? "new-parent"
      : "unknown",
    subtaskIntent: inferAdvisorSubtaskIntent(latestUsefulText, questionType),
    projectAnchor: latestProjectAnchor,
    source:
      openingRoute?.source ??
      (latestTurnBoundary.allowsNewTaskSignal
        ? "latest-turn"
        : "latest-turn-taxonomy-boundary"),
    reuseActivePlaybook: false,
    openingRoute,
    latestTurnAskFrame: latestAskFrame,
    latestTurnTaxonomyBoundaryReason: latestTurnBoundary.reason,
    taxonomyFallbackSuppressed: latestTurnBoundary.fallbackSuppressed,
    unknownTaskMutationBlocked:
      latestTurnBoundary.unknownTaskMutationBlocked,
  };
}

function formatAdvisorQuestionTypeDecisionForTrace(
  signals: AdvisorTaskSignals
) {
  const boundaryMetadata = {
    latestTurnAskFrame: signals.latestTurnAskFrame ?? "unknown",
    latestTurnTaxonomyBoundaryReason:
      signals.latestTurnTaxonomyBoundaryReason ?? "active-parent-continuity",
    taxonomyFallbackSuppressed:
      signals.taxonomyFallbackSuppressed ?? false,
    unknownTaskMutationBlocked:
      signals.unknownTaskMutationBlocked ?? false,
  };

  if (signals.openingRoute) {
    return {
      ...boundaryMetadata,
      questionTypeInferenceType: signals.questionType,
      questionTypeConfidence: 1,
      questionTypeMargin: 1,
      questionTypeEvidence: [
        `opening-route:${signals.openingRoute.kind}`,
      ],
      ambiguousCodingTerms:
        signals.questionTypeDecision?.ambiguousTerms ?? [],
      questionTypeScores: signals.questionTypeDecision?.scores ?? {},
      questionTypeDecisionSource: signals.openingRoute.source,
      pastProjectSignals:
        signals.questionType === "project-deep-dive"
          ? [`opening-route:${signals.openingRoute.kind}`]
          : [],
    };
  }

  const decision = signals.questionTypeDecision;
  if (!decision) {
    return {
      ...boundaryMetadata,
      questionTypeInferenceType: "unknown",
      questionTypeConfidence: 0,
      questionTypeMargin: 0,
      questionTypeEvidence: [],
      ambiguousCodingTerms: [],
      questionTypeScores: {},
      questionTypeDecisionSource: signals.source,
      pastProjectSignals: [],
    };
  }

  return {
    ...boundaryMetadata,
    questionTypeInferenceType: decision.type ?? "unknown",
    questionTypeConfidence: decision.confidence,
    questionTypeMargin: decision.margin,
    questionTypeEvidence: decision.evidence,
    ambiguousCodingTerms: decision.ambiguousTerms,
    questionTypeScores: decision.scores,
    questionTypeDecisionSource: decision.source,
    pastProjectSignals: decision.evidence.filter((item) =>
      item.includes("project")
    ),
  };
}

function applyManualQuestionTypeCorrectionToAdvisorSignals(
  signals: AdvisorTaskSignals,
  correction: ManualQuestionTypeCorrection
): AdvisorTaskSignals {
  const taskRelation: InterviewTaskRelation =
    correction.target === "child"
      ? "child-probe"
      : correction.target === "resume-parent"
        ? "resume-parent"
        : "followup-parent";

  return {
    ...signals,
    questionType: correction.correctedType,
    query: [
      signals.query,
      `Authoritative manual correction: treat the current question as ${formatScreenTaskKindLabel(
        correction.correctedType
      )}.`,
      "Ignore the previous automatic type for routing, memory, playbook, and model selection.",
    ]
      .filter(Boolean)
      .join("\n"),
    taskRelation,
    source: "manual-question-type-correction",
    reuseActivePlaybook: correction.target !== "child",
    latestTurnTaxonomyBoundaryReason: "manual-question-type-correction",
    taxonomyFallbackSuppressed: false,
    unknownTaskMutationBlocked: false,
  };
}

function formatManualQuestionTypeCorrectionForTrace(
  correction: ManualQuestionTypeCorrection | undefined
) {
  if (!correction) return {};
  return {
    manualQuestionTypeCorrectionId: correction.eventId,
    manualQuestionTypeCorrectionSource: correction.source,
    manualQuestionTypeCorrectionTarget: correction.target,
    detectedQuestionType: correction.detectedType,
    correctedQuestionType: correction.correctedType,
    correctionTraceId: correction.correctionTraceId,
    regenerationTraceId: correction.regenerationTraceId,
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
  parsedAnswer,
  playbook,
  phaseDecision,
  latestTurn,
  observationId,
  traceId,
  whiteboardUpdateSource,
  selectedOverlayIds,
  expiresAt,
  supportedFactAnchors,
  projectBinding,
}: {
  existingTask?: ActiveInterviewParent;
  source: "screen" | "voice";
  questionType: MemoryQuestionType | ScreenTaskKind;
  relation: InterviewTaskRelation;
  subtaskIntent: InterviewSubtaskIntent;
  question?: string;
  finalContent: string;
  parsedAnswer?: ParsedMeetingAnswer;
  playbook?: ActiveInterviewParent["playbook"];
  phaseDecision?: PlaybookPhaseDecision;
  latestTurn?: TranscriptTurn;
  observationId?: string;
  traceId?: string;
  whiteboardUpdateSource?: WhiteboardUpdateSource;
  selectedOverlayIds?: string[];
  expiresAt?: number;
  supportedFactAnchors?: string[];
  projectBinding?: ActiveInterviewParent["projectBinding"];
}): InterviewTaskContinuityResult {
  const kind = normalizeInterviewParentKind(questionType);
  const childQuestionType =
    normalizeCanonicalQuestionType(questionType) ?? "unknown";
  const now = Date.now();
  const trimmedContent = finalContent.trim();
  const parsed = parsedAnswer ?? parseMeetingAnswer(trimmedContent);
  const summaryDecision = buildMeetingAnswerSummary(parsed);
  const isUsefulAnswer = Boolean(summaryDecision.text);
  const topic =
    question?.trim() ||
    latestTurn?.text.trim() ||
    existingTask?.topic ||
    "Unknown interview task";
  const continuingTaskAnchors = mergeSupportedFactAnchors(
    existingTask?.supportedFactAnchors,
    supportedFactAnchors
  );
  const newParentAnchors = mergeSupportedFactAnchors(
    undefined,
    supportedFactAnchors
  );
  const continuityDecision = decideInterviewTaskContinuityBranch({
    hasExistingParent: Boolean(existingTask),
    existingParentQuestionType: existingTask?.stableKind,
    candidateQuestionType: questionType,
    relation,
  });

  if (continuityDecision.branch === "child-probe" && existingTask) {
    const child = isUsefulAnswer
      ? buildActiveInterviewChild({
          questionType: childQuestionType,
          subtaskIntent,
          question: topic,
          parsedAnswer: parsed,
          latestTurn,
          observationId,
        })
      : undefined;
    const whiteboardArtifact = updateWhiteboardArtifactFromAnswer({
      existing: existingTask.whiteboardArtifact,
      parentTaskId: existingTask.id,
      parentQuestionType: existingTask.stableKind,
      parentTopic: existingTask.topic,
      finalContent: trimmedContent,
      parsedAnswer: parsed,
      phase: phaseDecision?.phase ?? existingTask.playbookPhase,
      traceId,
      selectedOverlayIds,
      updateSource: whiteboardUpdateSource ?? "model-output",
      now,
    });

    return {
      task: applyInterviewChildProbeTransition({
        parent: existingTask,
        child,
        projectBinding,
        supportedFactAnchors: continuingTaskAnchors,
        whiteboardArtifact,
        now,
        expiresAt,
      }),
      startedNewParent: false,
      clearedParent: false,
    };
  }

  if (continuityDecision.branch === "preserve") {
    return {
      task: existingTask,
      startedNewParent: false,
      clearedParent: false,
    };
  }

  if (continuityDecision.branch === "new-parent") {
    if (!kind || !isParentInterviewKind(kind)) {
      return {
        task: existingTask,
        startedNewParent: false,
        clearedParent: false,
      };
    }
    const parentId = createMeetingId("interview_parent");
    const nextPhase = phaseDecision?.phase ?? playbook?.phase ?? "follow_up";
    const storedPlaybook = withInterviewPlaybookPhase(playbook, nextPhase);
    const whiteboardArtifact = updateWhiteboardArtifactFromAnswer({
      parentTaskId: parentId,
      parentQuestionType: kind,
      parentTopic: topic,
      finalContent: trimmedContent,
      parsedAnswer: parsed,
      phase: nextPhase,
      traceId,
      selectedOverlayIds,
      updateSource: whiteboardUpdateSource ?? "new-parent",
      now,
    });

    return {
      task: {
        id: parentId,
        source,
        stableKind: kind,
        topic,
        playbook: storedPlaybook,
        playbookPhase: nextPhase,
        phaseProgress: applyPlaybookPhaseDecisionToProgress(
          storedPlaybook?.phase ? { [storedPlaybook.phase]: true } : {},
          phaseDecision,
          storedPlaybook?.phase
        ),
        projectBinding,
        supportedFactAnchors: newParentAnchors,
        latestUsefulAnswer: isUsefulAnswer
          ? summaryDecision.text
          : undefined,
        previousUsefulAnswer: undefined,
        whiteboardArtifact,
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

  if (!existingTask) {
    return {
      task: undefined,
      startedNewParent: false,
      clearedParent: false,
    };
  }

  const nextPhase =
    phaseDecision?.phase ?? playbook?.phase ?? existingTask.playbookPhase;
  const storedPlaybook = withInterviewPlaybookPhase(
    playbook ?? existingTask.playbook,
    nextPhase
  );

  return {
    task: {
      ...existingTask,
      updatedAt: now,
      expiresAt,
      playbook: storedPlaybook,
      playbookPhase: nextPhase,
      phaseProgress: applyPlaybookPhaseDecisionToProgress(
        existingTask.phaseProgress,
        phaseDecision,
        storedPlaybook?.phase
      ),
      projectBinding: projectBinding ?? existingTask.projectBinding,
      supportedFactAnchors: continuingTaskAnchors,
      whiteboardArtifact: updateWhiteboardArtifactFromAnswer({
        existing: existingTask.whiteboardArtifact,
        parentTaskId: existingTask.id,
        parentQuestionType: existingTask.stableKind,
        parentTopic: existingTask.topic,
        finalContent: trimmedContent,
        parsedAnswer: parsed,
        phase: nextPhase,
        traceId,
        selectedOverlayIds,
        updateSource: whiteboardUpdateSource ?? "model-output",
        now,
      }),
      previousUsefulAnswer:
        isUsefulAnswer && existingTask.latestUsefulAnswer
          ? existingTask.latestUsefulAnswer
          : existingTask.previousUsefulAnswer,
      latestUsefulAnswer: isUsefulAnswer
        ? summaryDecision.text
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
  const whiteboardArtifact = updateWhiteboardArtifactFromAnswer({
    parentTaskId: task.id,
    parentQuestionType: kind,
    parentTopic:
      task.question || extractScreenTaskQuestion(task.content) || "Screen task",
    finalContent: task.content,
    phase: task.playbook?.phase ?? "follow_up",
    selectedOverlayIds: [],
    updateSource: "model-output",
    now: task.updatedAt,
  });

  return {
    id: task.id,
    source: "screen",
    stableKind: kind,
    topic: task.question || extractScreenTaskQuestion(task.content) || "Screen task",
    playbook: task.playbook,
    playbookPhase: task.playbook?.phase ?? "follow_up",
    phaseProgress: task.playbook?.phase ? { [task.playbook.phase]: true } : {},
    supportedFactAnchors: [],
    latestUsefulAnswer: buildCompactAnswerSummary(task.content),
    previousUsefulAnswer: undefined,
    whiteboardArtifact,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    expiresAt: task.expiresAt,
    startObservationId: task.basedOnObservationId,
    revisions: 1,
  };
}

function buildCorrectionParentFromActiveMeetingTask(
  task: NonNullable<MeetingContextState["activeMeetingTask"]>,
  correctedType: CanonicalQuestionType
): ActiveInterviewParent | undefined {
  if (!isParentCanonicalQuestionType(correctedType)) return undefined;

  return {
    id: task.parent.id,
    source: task.screen ? "screen" : "voice",
    stableKind: correctedType,
    topic:
      task.child?.question ||
      task.screen?.question ||
      task.parent.topic ||
      "Current interview question",
    playbook: task.parent.playbook,
    playbookPhase: task.parent.playbookPhase,
    phaseProgress: task.parent.phaseProgress,
    projectBinding: task.parent.projectBinding
      ? {
          ...task.parent.projectBinding,
          evidenceEntryIds: [...task.parent.projectBinding.evidenceEntryIds],
        }
      : undefined,
    supportedFactAnchors: task.parent.supportedFactAnchors,
    latestUsefulAnswer: task.parent.latestUsefulAnswer,
    previousUsefulAnswer: task.parent.previousUsefulAnswer,
    whiteboardArtifact: task.parent.whiteboardArtifact,
    createdAt: task.parent.createdAt,
    updatedAt: task.parent.updatedAt,
    expiresAt: task.parent.expiresAt,
    startTurnId: task.parent.startTurnId,
    startObservationId: task.parent.startObservationId,
    revisions: task.parent.revisions ?? 0,
  };
}

function resolveProvisionalScreenTaskRelation({
  existingTask,
  questionType,
  projectAnchor,
  questionText,
}: {
  existingTask?: ActiveInterviewParent;
  questionType: MemoryQuestionType | ScreenTaskKind;
  projectAnchor?: string;
  questionText?: string;
}): InterviewTaskRelation {
  if (!existingTask) return "new-parent";

  if (
    existingTask.projectBinding &&
    projectAnchor?.trim() &&
    !projectBindingMatchesProjectHint(
      existingTask.projectBinding,
      projectAnchor
    )
  ) {
    return "new-parent";
  }

  const nextKind = normalizeInterviewParentKind(questionType);
  if (!nextKind) return "child-probe";
  if (isCompatibleParentKind(existingTask.stableKind, nextKind)) {
    return "resume-parent";
  }
  if (
    shouldUseLatestTurnAsChildProbe({
      activeQuestionType: existingTask.stableKind,
      latestQuestionType: readMemoryQuestionType(questionType) ?? "unknown",
      latestText: questionText ?? "",
    })
  ) {
    return "child-probe";
  }
  return "new-parent";
}

function decideScreenTaskRelation({
  existingTask,
  taskKind,
  question,
  screenEvidenceText,
  screenPreflight,
  corrections,
}: {
  existingTask?: ActiveInterviewParent;
  taskKind: ScreenTaskKind;
  question?: string;
  screenEvidenceText: string;
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
        latestText: question || screenEvidenceText,
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
        latestText: question || screenEvidenceText,
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
    screenEvidenceText,
  ]
    .filter(Boolean)
    .join("\n");
  const parentText = [
    existingTask.topic,
    existingTask.projectBinding?.projectName,
    existingTask.supportedFactAnchors.join(" "),
    existingTask.child?.question,
  ]
    .filter(Boolean)
    .join("\n");
  if (!screenText.trim()) {
    return {
      relation: "followup-parent",
      reason: "screen-source-evidence-missing",
      confidence: 0.5,
    };
  }
  const overlap = countSignificantTokenOverlap(screenText, parentText);
  const semanticSimilarity = calculateTaskTextSimilarity(screenText, parentText);
  const correctionOverlap = countCorrectionTermOverlap(corrections, screenText);
  const screenProjectAnchor = screenPreflight?.projectAnchor;
  const projectAnchorMatches = screenProjectAnchor
    ? (existingTask.projectBinding
        ? projectBindingMatchesProjectHint(
            existingTask.projectBinding,
            screenProjectAnchor
          )
        : false) ||
      existingTask.supportedFactAnchors.some((anchor) =>
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
  parsedAnswer,
  latestTurn,
  observationId,
}: {
  questionType: CanonicalQuestionType;
  subtaskIntent: InterviewSubtaskIntent;
  question: string;
  parsedAnswer: ParsedMeetingAnswer;
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
      parsedAnswer,
    }),
    basedOnTurnIds: latestTurn ? [latestTurn.id] : [],
    basedOnObservationIds: observationId ? [observationId] : [],
  };
}

function buildCompactChildSummary({
  questionType,
  subtaskIntent,
  question,
  parsedAnswer,
}: {
  questionType: CanonicalQuestionType;
  subtaskIntent: InterviewSubtaskIntent;
  question: string;
  parsedAnswer: ParsedMeetingAnswer;
}) {
  const summary = buildMeetingAnswerSummary(parsedAnswer).text;

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
  return buildMeetingAnswerSummary(parseMeetingAnswer(content)).text;
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
  return extractRuntimeFactAnchorLabels(memoryContext?.entries ?? []);
}

function extractSelectedOverlayIdsFromMemory(
  memoryContext: MemoryRetrievalResult | null | undefined
) {
  return memoryContext?.overlaySelection?.selectedEntryIds ?? [];
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
) {
  const trimmed = turn.text.trim();
  const hasQuestion = hasQuestionOrTaskSignal(trimmed);
  return decideAdvisorTurnIntent(trimmed, {
    hasActiveTask: options.hasActiveTask,
    hasCompanyContextOnly: Boolean(
      detectInterviewCompany(trimmed) &&
        !hasQuestion &&
        calculateWordEquivalent(trimmed) <= 18
    ),
  });
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
