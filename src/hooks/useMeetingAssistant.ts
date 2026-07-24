import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useMicVAD } from "@ricky0123/vad-react";
import { STORAGE_KEYS } from "@/config";
import { useApp } from "@/contexts";
import { safeLocalStorage } from "@/lib";
import { floatArrayToWav } from "@/lib/utils";
import {
  buildRuntimeMemoryRoleTelemetry,
  extractRuntimeFactAnchorLabels,
  flushMemoryContextUsage,
  formatMemoryRetrievalPerformanceForTrace,
  formatMemorySelectionForTrace,
  prewarmMemoryContextSnapshot,
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
  buildAdvisorEvidencePacket,
  buildAdvisorEvidenceRetrievalQuery,
  AdvisorPromptContext,
  AdvisorSuggestion,
  AdvisorRequestMode,
  AdvisorTriggerJob,
  AdvisorJobSource,
  AdvisorTaskMutationAuthority,
  RuntimeCommitToken,
  AdvisorTurnIntentDecision,
  extractInterviewerIntentKeywordEvidence,
  formatInterviewerIntentKeywordEvidenceForTrace,
  formatSemanticInterviewerIntentForTrace,
  ActiveMeetingTask,
  clearActiveMeetingTaskProjection,
  AnswerSufficiencyDecision,
  ActiveInterviewParent,
  ActiveScreenTask,
  AdjacentQuestionScope,
  CanonicalQuestionType,
  ClarifyingQuestionAnswer,
  ClarifyingQuestionFeedback,
  DiagramDomainQueryContext,
  ForceAdviseTargetPresentation,
  MeetingAssistantState,
  MeetingAssistantStatus,
  MeetingAudioConfig,
  MeetingAudioStatus,
  NativeAudioDebugFaultKind,
  NativeAudioDebugFaultResult,
  NativeAudioCaptureStartMode,
  NativeAudioManualRecoveryState,
  NativeAudioStopResult,
  MeetingAssistantSettings,
  MeetingAudioProfile,
  MeetingCodingModelSettings,
  MeetingTaxonomyAdjudicationSettings,
  MeetingContextState,
  InterviewBriefType,
  InterviewPlaybookPhase,
  InterviewSubtaskIntent,
  InterviewTaskRelation,
  InterviewSessionBrief,
  MeetingPrivacyMode,
  PersonalEvidenceDecision,
  PersonalEvidenceGuardrailMode,
  SemanticTaxonomyMode,
  SelectedProviderState,
  MeetingResponseActionMode,
  MeetingResponseConfig,
  ManualQuestionTypeCorrection,
  ManualQuestionTypeCorrectionSource,
  LogicalQuestionUnit,
  LogicalQuestionUnitLease,
  PrimaryAskProjection,
  NativeSpeechDetectedEvent,
  WhiteboardUpdateSource,
  MeetingContextManager,
  MeetingSetupWarning,
  MeetingTraceStore,
  MeetingTrace,
  MeetingTraceExportRecord,
  MeetingTraceExportTrigger,
  MeetingModelRequestOptions,
  MeetingModelProviderSnapshot,
  PENDING_CONFIRMATION_TTL_MS,
  detectOpeningTaskRoute,
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
  SpeechCorrection,
  SpeechCorrectionRule,
  TaskAskFrame,
  TaskBoundaryCandidate,
  TaskTopicDomain,
  TraceHumanEvaluation,
  TranscriptTurn,
  base64WavToBlob,
  buildAmazonLeadershipPrincipleMemoryHint,
  buildAnswerSufficiencySemanticText,
  buildDiagramOverlayEvalTraceMetadata,
  buildCurrentTaskDiagramDomainContext,
  buildInterviewSessionBriefMemoryHint,
  buildInterviewSessionMemoryHint,
  buildWhiteboardEvalTraceMetadata,
  captureScreenObservation,
  createInterviewSessionContextFromBrief,
  createMeetingId,
  detectAnswerSufficiencyShadow,
  detectInterviewCompany,
  calculateWordEquivalent,
  classifyMeTurn,
  collectConfirmedMeFacts,
  findDuplicateSystemAudioTurnForMeTurn,
  findRecentMeClarificationForTurn,
  isInterviewSessionBriefEmpty,
  normalizeInterviewBriefCompany,
  extractScreenTaskQuestion,
  isShortConfirmationLike,
  buildMeetingAnswerSummary,
  CaptureLifecycleCoordinator,
  authorizeNativeAudioLifecycleEvent,
  buildUnresolvedNativeAudioManualRecoveryMetadata,
  createNativeAudioManualRecoveryState,
  decideNativeAudioTerminalDisposition,
  getNativeAudioCaptureStartPolicy,
  resolveNativeAudioCaptureStartFailure,
  pruneNativeAudioRecoveryAttempts,
  authorizeNativeSpeechDetectedEvent,
  buildNativeAudioLifecycleTraceMetadata,
  buildNativeSpeechEventTraceMetadata,
  parseNativeAudioSegmentDroppedEvent,
  buildMemoryEvaluationTraceMetadata,
  formatMeetingAnswerTraceMetadata,
  formatAnswerSufficiencyDecisionForTrace,
  parseMeetingAnswer,
  parseMeetingTraceMetrics,
  resolveMeetingAnswerProfile,
  preflightScreenObservation,
  selectInterviewPlaybook,
  applyPlaybookPhaseDecisionToProgress,
  createInitialPlaybookPhaseProgress,
  decideManualNextPhaseTransition,
  decidePlaybookPhaseProgression,
  formatPlaybookPhaseDecisionForTrace,
  formatInterviewPlaybookForTrace,
  withInterviewPlaybookPhase,
  readTraceHumanEvaluations,
  readQuestionHumanEvaluations,
  readCriticalMomentCandidates,
  readCriticalMomentEvaluations,
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
  authorizeAdvisorOutputCommit,
  createAdvisorTriggerJob,
  authorizeRuntimeCommit,
  authorizeAdvisorTaskMutation,
  buildRuntimeCommitSnapshot,
  buildBoundedParentContextHandoff,
  buildCommittedTaskBoundaryParent,
  commitTaskBoundaryCandidate,
  commitSourceOwnedTransition,
  createTaskBoundaryCandidate,
  createSourceOwnedTransitionCandidate,
  createRuntimeCommitToken,
  decideAdvisorPhaseMutation,
  decideAdvisorTaskMutation,
  decideCrossDomainParentTransition,
  formatAdvisorEvidencePacketForTrace,
  formatAdvisorTriggerJobForTrace,
  formatCrossDomainParentTransitionForTrace,
  formatRuntimeCommitAuthorizationForTrace,
  formatSourceOwnedTransitionForTrace,
  formatTaskBoundaryCandidateForTrace,
  rebaseRuntimeCommitToken,
  rebaseRuntimeCommitTokenAfterOwnedParentMutation,
  expireTaskBoundaryCandidate,
  canQuestionTypeDecisionOverrideParent,
  decideAdvisorTurnIntent,
  decideSentenceCompletion,
  composeLogicalQuestionUnit,
  authorizeLogicalQuestionUnitLease,
  createCanonicalLogicalQuestionLineage,
  createLogicalQuestionUnitLease,
  decideLogicalQuestionMaterialization,
  formatLogicalQuestionLeaseForTrace,
  formatPrimaryAskProjectionForTrace,
  primaryAskClassifierText,
  projectPrimaryAsk,
  reconcilePrimaryAskTurnDecision,
  composeContextScopeAdvisorPromptContext,
  evaluateAnswerContextResolvabilityShadow,
  scoreAnswerSufficiencySemanticEmbedding,
  createPlaybookPhaseHistoryState,
  appendCommittedAutomaticPhaseTransition,
  appendCommittedManualBackPhaseTransition,
  appendCommittedManualNextPhaseTransition,
  decideManualPlaybookPhaseBack,
  decideManualPlaybookPhaseNextRoundTrip,
  formatPlaybookPhaseNavigationDecisionForTrace,
  decideLatestTurnTaxonomyBoundary,
  formatAdvisorTurnIntentForTrace,
  formatLogicalQuestionUnitForTrace,
  inferCanonicalQuestionTypeFromText,
  inferQuestionTypeDecisionFromText,
  isParentCanonicalQuestionType,
  normalizeCanonicalQuestionType,
  mergeSentenceFragments,
  normalizeInterviewBriefTypes as normalizeTaxonomyInterviewBriefTypes,
  normalizeQuestionTypeAlias,
  readInterviewBriefType,
  resolveTaskTaxonomyAuthority,
  supersedeTaskBoundaryCandidate,
  sourceOwnedTransitionSurvivesModelOutcome,
  taskBoundarySurvivesAdvisorOutcome,
  toHumanEvalQuestionType,
  toMemoryUseCaseForQuestionType,
  type QuestionTypeInferenceDecision,
  type SemanticEmbeddingRuntimeTelemetry,
  type SemanticTaxonomyDecision,
  type HybridQuestionTypeDecision,
  type LatestTurnTaxonomyBoundaryReason,
  type TaskTaxonomyAuthorityDecision,
  type SourceOwnedTransitionCommitResult,
  TaxonomyAdjudicationRuntime,
  type TaxonomyAdjudicationRequestResult,
  TAXONOMY_ADJUDICATION_MAX_OUTPUT_CHARS,
  TaxonomyAdjudicationSessionCircuitBreaker,
  authorizeTaxonomyAdjudicationLease,
  buildLocalInterviewerIntentBaseline,
  buildTaxonomyAdjudicationPrompts,
  buildTaxonomyAdjudicationRequest,
  compareTaxonomyAdjudicationToLocalBaseline,
  createTaxonomyAdjudicationLease,
  decideTaxonomyAdjudicationEligibility,
  formatTaxonomyAdjudicationModelRouteForTrace,
  formatTaxonomyAdjudicationCircuitForTrace,
  hashTaxonomySourceTurnIds,
  hashTaxonomyTaskBoundary,
  projectLogicalQuestionForAdjudication,
  requestTaxonomyAdjudication,
  resolveTaxonomyAdjudicationModelRouteFromSnapshot,
  shouldOpenTaxonomyAdjudicationCircuit,
  solveScreenAnchoredTask,
  shouldIncludeTurnInAdvisorPrompt,
  shouldSuppressDuplicateSystemAudioTurn,
  transcribeMeetingAudio,
  upsertTraceHumanEvaluation,
  upsertQuestionHumanEvaluation,
  upsertCriticalMomentEvaluation,
  buildCriticalMomentCandidates,
  mergeCriticalMomentCandidates,
  persistCriticalMomentCandidates,
  persistCriticalMomentEvaluations,
  projectCriticalMomentTraceEvidence,
  type CriticalMomentEvaluation,
  buildQuestionEvaluationPatchFromTrace,
  decideManualQuestionTypeCorrection,
  decideManualCorrectionScope,
  buildManualCorrectionParentTransition,
  decideProvisionalQuestionTypeCorrection,
  resolveManualCorrectionTarget,
  ManualCorrectionOperationCoordinator,
  decideInterviewTaskContinuityBranch,
  classifyInterviewTransitionTurn,
  consumeInterviewSectionHint,
  createPendingInterviewSectionHint,
  detectInterviewSectionTransition,
  formatInterviewSectionHintForTrace,
  type PendingInterviewSectionHint,
  applyInterviewChildProbeTransition,
  persistTraceHumanEvaluations,
  persistQuestionHumanEvaluations,
  buildSessionRecordingProviderSummary,
  buildFactAnchorDecision,
  detectPersonalEvidenceRequirement,
  enforceFactAnchorOutput,
  formatFactAnchorOutputDecisionForTrace,
  formatFactAnchorDecisionForTrace,
  restrictMemoryContextForPersonalEvidence,
  formatProjectBindingDecisionForTrace,
  projectBindingMatchesProjectHint,
  resolveProjectBinding,
  getActiveMeetingTaskTraceMetadata,
  areSuggestionsForSameParentTask,
  buildSuggestionTaskMetadata,
  stageSuggestionProjectionForManualCorrection,
  authorizeResponseArtifactMutation,
  formatResponseArtifactAuthorizationForTrace,
  formatMeetingResponseOwnerForTrace,
  formatMeetingModelRouteForTrace,
  resolveMeetingResponseOwner,
  resolveMeetingModelRouteFromSnapshot,
  resolveManualCorrectionRegenerationRoute,
  applyAdvisorScreenScopeToPromptContext,
  decideAdvisorScreenScope,
  decideScreenResultScope,
  decideSemanticTaxonomyShadowEligibility,
  decideSemanticTaxonomyUnknownRescue,
  formatScreenScopeDecisionForTrace,
  formatSemanticEmbeddingRuntimeTelemetryForTrace,
  formatSemanticTaxonomyShadowMetadata,
  resolveAdvisorRequestModeForScreenScope,
  resolveAdvisorTaskEvidenceSource,
  resolveHybridQuestionType,
  scoreSemanticInterviewerIntentEmbeddings,
  scoreSemanticTaxonomyEmbedding,
  SemanticTaxonomyRuntime,
  PlaybookPhaseDecision,
  SENTENCE_COMPLETION_BUFFER_MS,
  attachQuestionLineageToSuggestion,
  createAdjacentQuestionScope,
  createAuthorizedQuestionLineage,
  formatAdjacentConstraintDecisionForTrace,
  formatAdjacentQuestionScopeForTrace,
  formatQuestionLineageForTrace,
  promoteQuestionLineage,
  resolveAdjacentConstraintInheritance,
  resolveInheritedQuestionLineageForTurnIntent,
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
const NATIVE_AUDIO_RECOVERY_WINDOW_MS = 60_000;
const NATIVE_AUDIO_MAX_RECOVERY_ATTEMPTS_PER_WINDOW = 2;
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

const DEFAULT_TAXONOMY_ADJUDICATION_SETTINGS: MeetingTaxonomyAdjudicationSettings = {
  enabled: true,
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
    semanticTaxonomyMode: "shadow",
    debugMode: false,
    microphoneContextEnabled: true,
    response: DEFAULT_MEETING_RESPONSE_CONFIG,
    codingModel: DEFAULT_MEETING_CODING_MODEL_SETTINGS,
    taxonomyAdjudication: DEFAULT_TAXONOMY_ADJUDICATION_SETTINGS,
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
      semanticTaxonomyMode: isSemanticTaxonomyMode(parsed.semanticTaxonomyMode)
        ? parsed.semanticTaxonomyMode
        : DEFAULT_MEETING_ASSISTANT_SETTINGS.semanticTaxonomyMode,
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
      taxonomyAdjudication: normalizeTaxonomyAdjudicationSettings(
        parsed.taxonomyAdjudication
      ),
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

function normalizeTaxonomyAdjudicationSettings(
  value: unknown
): MeetingTaxonomyAdjudicationSettings {
  const selectedProvider = normalizeMeetingCodingModelSettings(value);
  const parsed = isRecord(value) ? value : {};
  return {
    enabled:
      typeof parsed.enabled === "boolean"
        ? parsed.enabled
        : DEFAULT_TAXONOMY_ADJUDICATION_SETTINGS.enabled,
    ...selectedProvider,
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
  const clearedTaskState =
    clearActiveMeetingTaskProjection(previous);
  return {
    ...clearedTaskState,
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
    manualQuestionTypeCorrection: undefined,
    currentQuestionLineage: undefined,
    latestInterviewerTurnCandidate: undefined,
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
    | "manual-question-type-correction"
    | "semantic-unknown-rescue"
    | "section-hint";
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

function resolveResponseActionLogicalQuestionUnit(input: {
  currentLogicalQuestionUnit: LogicalQuestionUnit | undefined;
  meetingContext: MeetingContextState;
  runtimeEpoch: number;
  preferScreen: boolean;
}): LogicalQuestionUnit | undefined {
  const current = input.currentLogicalQuestionUnit;
  const currentIsValid =
    current?.sessionId === input.meetingContext.sessionId &&
    current.runtimeEpoch === input.runtimeEpoch;
  if (!input.preferScreen && currentIsValid) return current;

  const task = input.meetingContext.activeMeetingTask;
  const screenTask = input.meetingContext.activeScreenTask;
  const screenQuestion =
    task?.screen?.question?.trim() ??
    screenTask?.question?.trim();
  if (task?.screen && screenQuestion) {
    const screenTaskId =
      task.screen.activeScreenTaskId ??
      screenTask?.id ??
      task.id;
    const updatedAt =
      screenTask?.updatedAt ?? task.parent.updatedAt;
    return {
      id: `screen-scope-${screenTaskId}`,
      revision: Math.max(1, task.parent.revisions ?? 1),
      sessionId: input.meetingContext.sessionId,
      runtimeEpoch: input.runtimeEpoch,
      currentTurnId: `screen:${screenTaskId}`,
      sourceTurnIds: [],
      sources: [
        {
          turnId: `screen:${screenTaskId}`,
          text: screenQuestion,
          startedAt: updatedAt,
          endedAt: updatedAt,
        },
      ],
      normalizedText: screenQuestion,
      startedAt: updatedAt,
      updatedAt,
      compositionReasons: ["visible-screen-question"],
      boundaryReason: "visible-screen-question",
      truncated: false,
    };
  }

  return currentIsValid ? current : undefined;
}

function evaluateRuntimeAnswerSufficiencyShadow(input: {
  traceId: string;
  questionId: string;
  logicalQuestionUnit: LogicalQuestionUnit;
  answerRevision: number;
  questionType: CanonicalQuestionType;
  answerProfile?: ReturnType<typeof resolveMeetingAnswerProfile>;
  parsedAnswer: ParsedMeetingAnswer;
  factAnchorRequired: boolean;
  factAnchorAvailable: boolean;
  currentTurnAction?: "answer" | "append-context" | "buffer" | "ignore";
  relation?: InterviewTaskRelation;
  meetingContext: MeetingContextState;
  basePromptContext: AdvisorPromptContext;
  originalModelPromptText: string;
}) {
  const initialDecision = detectAnswerSufficiencyShadow({
    operationId: `answer-sufficiency:${input.traceId}`,
    traceId: input.traceId,
    questionId: input.questionId,
    logicalQuestionUnitId: input.logicalQuestionUnit.id,
    logicalQuestionUnitRevision: input.logicalQuestionUnit.revision,
    answerRevision: input.answerRevision,
    questionText: input.logicalQuestionUnit.normalizedText,
    questionType: input.questionType,
    answerProfile: input.answerProfile,
    parsedAnswer: input.parsedAnswer,
    executionStatus: "success",
    factAnchorRequired: input.factAnchorRequired,
    factAnchorAvailable: input.factAnchorAvailable,
    currentTurnAction: input.currentTurnAction,
  });
  if (initialDecision.answerStatus !== "context-insufficient") {
    return initialDecision;
  }

  const selection = composeContextScopeAdvisorPromptContext({
    action: "enhance-context",
    baseContext: input.basePromptContext,
    logicalQuestionUnit: input.logicalQuestionUnit,
    meetingContext: input.meetingContext,
    activeMeetingTask: input.meetingContext.activeMeetingTask,
    questionRelation:
      input.relation === "new-parent"
        ? "independent-new-question"
        : input.relation === "child-probe" ||
            input.relation === "resume-parent"
          ? "referential-follow-up"
          : input.relation === "followup-parent"
            ? "continuation"
            : "unknown",
  });
  const sourceTextByTurnId = Object.fromEntries(
    input.meetingContext.transcriptTurns.map((turn) => [turn.id, turn.text])
  );
  return evaluateAnswerContextResolvabilityShadow({
    decision: initialDecision,
    selection,
    questionType: input.questionType,
    activeParentQuestionType: normalizeCanonicalQuestionType(
      input.meetingContext.activeMeetingTask?.parent.questionType
    ),
    originalSourceTurnIds:
      input.basePromptContext.advisorPromptSourceTurnIds,
    originalContextText: input.originalModelPromptText,
    sourceTextByTurnId,
  });
}

function mapAdvisorTurnActionToSufficiencyAction(
  action: AdvisorTurnIntentDecision["action"] | undefined
) {
  if (action === "answer-refresh") return "answer" as const;
  if (action === "append-only" || action === "state-update") {
    return "append-context" as const;
  }
  if (action === "ignore") return "ignore" as const;
  return undefined;
}

function buildScreenAnswerSufficiencyLogicalQuestionUnit(input: {
  observationId: string;
  question: string;
  sessionId: string;
  runtimeEpoch: number;
  createdAt: number;
}): LogicalQuestionUnit {
  const sourceId = `screen:${input.observationId}`;
  return {
    id: `screen-answer-sufficiency:${input.observationId}`,
    revision: 1,
    sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    currentTurnId: sourceId,
    sourceTurnIds: [],
    sources: [
      {
        turnId: sourceId,
        text: input.question,
        startedAt: input.createdAt,
        endedAt: input.createdAt,
      },
    ],
    normalizedText: input.question,
    startedAt: input.createdAt,
    updatedAt: input.createdAt,
    compositionReasons: ["visible-screen-question"],
    boundaryReason: "visible-screen-question",
    truncated: false,
  };
}

function buildSemanticInterviewerIntentRelationText(input: {
  currentText: string;
  parent?: {
    questionType: string;
    playbookPhase: string;
    topic: string;
  };
}) {
  const current = input.currentText.trim().slice(0, 1_200);
  if (!input.parent) {
    return `Current: ${current}\nParent: none`;
  }
  return [
    `Current: ${current}`,
    `Parent type: ${input.parent.questionType}`,
    `Parent phase: ${input.parent.playbookPhase}`,
    `Parent question: ${input.parent.topic.trim().slice(0, 300)}`,
  ].join("\n");
}

function isPersonalEvidenceGuardrailMode(
  value: unknown
): value is PersonalEvidenceGuardrailMode {
  return value === "enforcement" || value === "shadow";
}

function isSemanticTaxonomyMode(
  value: unknown
): value is SemanticTaxonomyMode {
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
  logicalQuestionUnit?: LogicalQuestionUnit;
  promptTurnOverride?: TranscriptTurn;
  promptContextOverride?: AdvisorPromptContext;
  manualPhaseTargetOverride?: InterviewPlaybookPhase;
  manualPhaseOperationId?: string;
}

interface ForceAdviseRuntimeTarget {
  presentation: ForceAdviseTargetPresentation;
  turn: TranscriptTurn;
  intentDecision: AdvisorTurnIntentDecision;
  logicalQuestionUnit: LogicalQuestionUnit;
  logicalQuestionLease: LogicalQuestionUnitLease;
  questionLineage: QuestionInstanceLineage;
}

interface CaptureScreenContextOptions {
  onCaptured?: () => void;
  requestedAt?: number;
}

interface NativeAudioRecoveryAttemptContext {
  id: string;
  startedAt: number;
  previousCaptureSessionId: string;
  previousCaptureGeneration: number;
  reason: string | null;
  faultInjectionId?: string;
}

interface NativeAudioManualRecoveryAttemptContext {
  id: string;
  startedAt: number;
  pending: NativeAudioManualRecoveryState;
}

interface NativeAudioFaultTraceContext {
  traceId: string;
  faultKind: NativeAudioDebugFaultKind;
  commandStepId: string;
  commandSettled: boolean;
  terminalDisposition?: "expected-stop" | "recovering" | "fatal";
  recoveryOutcome?: "success" | "error";
  recoveryError?: string;
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

interface SemanticTaxonomyTurnEvidence {
  turnId: string;
  sessionId: string;
  runtimeEpoch: number;
  lexical: QuestionTypeInferenceDecision;
  hybrid?: ReturnType<typeof resolveHybridQuestionType>;
  metadata: Record<string, unknown>;
}

interface SentenceCompletionMergeContext {
  operationId: string;
  firstHeldAt: number;
  fragmentTurnIds: string[];
  fragmentTraceIds: string[];
  fragmentSequences: number[];
}

function getMeetingModelRequestOptions(
  route: ReturnType<typeof resolveMeetingModelRouteFromSnapshot>
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
  const [criticalMomentCandidates, setCriticalMomentCandidates] = useState(
    () => readCriticalMomentCandidates()
  );
  const [criticalMomentEvaluations, setCriticalMomentEvaluations] = useState(
    () => readCriticalMomentEvaluations()
  );
  const criticalMomentCandidatesRef = useRef(criticalMomentCandidates);
  criticalMomentCandidatesRef.current = criticalMomentCandidates;
  const criticalMomentCandidateFingerprintBySessionRef = useRef(
    new Map<string, string>()
  );
  const criticalMomentEvaluationsRef = useRef(criticalMomentEvaluations);
  criticalMomentEvaluationsRef.current = criticalMomentEvaluations;
  const currentQuestionLineageRef = useRef<QuestionInstanceLineage | undefined>(
    state.currentQuestionLineage
  );
  currentQuestionLineageRef.current = state.currentQuestionLineage;
  const adjacentQuestionScopeRef = useRef<AdjacentQuestionScope | null>(null);
  const logicalQuestionUnitRef = useRef<LogicalQuestionUnit | undefined>(
    undefined
  );
  const answerRevisionByQuestionRef = useRef(new Map<string, number>());
  const playbookPhaseHistoryRef = useRef(
    createPlaybookPhaseHistoryState()
  );
  const latestForceAdviseTargetRef = useRef<
    ForceAdviseRuntimeTarget | undefined
  >(undefined);
  const pendingInterviewSectionHintRef = useRef<
    PendingInterviewSectionHint | undefined
  >(undefined);
  const cancelledAdvisorTurnIdsRef = useRef(new Set<string>());
  const taskBoundaryCandidateRef = useRef<TaskBoundaryCandidate | undefined>(
    undefined
  );
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
  const refreshCriticalMomentCandidates = useCallback(
    (contextState: MeetingContextState, traces: MeetingTrace[]) => {
      const sessionId =
        sessionRecordingManagerRef.current?.getState().sessionId ??
        contextState.sessionId;
      const currentWindow = buildCriticalMomentCandidates({
        sessionId,
        transcriptTurns: contextState.transcriptTurns,
        traces: traces.map(projectCriticalMomentTraceEvidence),
      });
      const currentWindowFingerprint = JSON.stringify(
        currentWindow.map((candidate) => ({
          momentId: candidate.momentId,
          sourceText: candidate.sourceText,
          proposedTraceIds: candidate.proposedTraceIds,
          proposedQuestionType: candidate.proposedQuestionType,
          traceJoinStatus: candidate.traceJoinStatus,
          candidateReasons: candidate.candidateReasons,
        }))
      );
      if (
        criticalMomentCandidateFingerprintBySessionRef.current.get(
          sessionId
        ) === currentWindowFingerprint
      ) {
        return;
      }
      criticalMomentCandidateFingerprintBySessionRef.current.set(
        sessionId,
        currentWindowFingerprint
      );
      const merged = mergeCriticalMomentCandidates(
        criticalMomentCandidatesRef.current,
        currentWindow,
        sessionId
      );
      criticalMomentCandidatesRef.current = merged;
      persistCriticalMomentCandidates(merged);
      setCriticalMomentCandidates(merged);
      sessionRecordingManagerRef.current?.recordCriticalMomentCandidates(
        merged
      );
    },
    []
  );
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
  const semanticTaxonomyModeRef = useRef<SemanticTaxonomyMode>(
    INITIAL_STATE.settings.semanticTaxonomyMode
  );
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
  const semanticTaxonomyRuntimeRef = useRef<SemanticTaxonomyRuntime | null>(
    null
  );
  if (semanticTaxonomyRuntimeRef.current === null) {
    semanticTaxonomyRuntimeRef.current = new SemanticTaxonomyRuntime();
  }
  const semanticEmbeddingRevisionRef = useRef(0);
  const semanticTaxonomyEvidenceByTurnRef = useRef(
    new Map<string, SemanticTaxonomyTurnEvidence>()
  );
  const taxonomyAdjudicationRuntimeRef = useRef<
    TaxonomyAdjudicationRuntime<TaxonomyAdjudicationRequestResult> | null
  >(null);
  if (taxonomyAdjudicationRuntimeRef.current === null) {
    taxonomyAdjudicationRuntimeRef.current =
      new TaxonomyAdjudicationRuntime<TaxonomyAdjudicationRequestResult>();
  }
  const taxonomyAdjudicationSettingsRef = useRef(
    INITIAL_STATE.settings.taxonomyAdjudication
  );
  const taxonomyAdjudicationCircuitBreakerRef = useRef(
    new TaxonomyAdjudicationSessionCircuitBreaker()
  );
  const manualCorrectionRevisionRef = useRef(0);
  const activeScreenOperationIdRef = useRef<string | null>(null);
  const manualCorrectionOperationCoordinatorRef = useRef(
    new ManualCorrectionOperationCoordinator()
  );
  const audioSessionIdRef = useRef(createMeetingId("audio_session"));
  const audioSegmentSeqRef = useRef(0);
  const nativeCaptureSessionIdRef = useRef<string | null>(null);
  const nativeCaptureGenerationRef = useRef<number | null>(null);
  const lastNativeSegmentSequenceRef = useRef(0);
  const nativeRecoveryAttemptTimestampsRef = useRef<number[]>([]);
  const nativeAudioManualRecoveryRef =
    useRef<NativeAudioManualRecoveryState | null>(null);
  const handledNativeTerminalKeysRef = useRef(new Set<string>());
  const nativeAudioFaultTracesRef = useRef(
    new Map<string, NativeAudioFaultTraceContext>()
  );
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

  const maybeFinishNativeAudioFaultTrace = useCallback(
    (faultInjectionId: string) => {
      const context = nativeAudioFaultTracesRef.current.get(faultInjectionId);
      if (!context || !context.commandSettled) return;

      let status: "success" | "error" | undefined;
      let error: string | undefined;
      let outcome: string | undefined;
      if (context.terminalDisposition === "fatal") {
        status = "success";
        outcome =
          context.faultKind === "recoverable-stream-end"
            ? "recovery-circuit-breaker-open"
            : "fatal-fault-observed";
      } else if (context.recoveryOutcome) {
        status = context.recoveryOutcome;
        error = context.recoveryError;
        outcome =
          context.recoveryOutcome === "success"
            ? "automatic-recovery-succeeded"
            : "automatic-recovery-failed";
      }
      if (!status) return;

      traceStoreRef.current.updateMetadata(context.traceId, {
        faultValidationOutcome: outcome,
      });
      traceStoreRef.current.finishTrace(context.traceId, status, error);
      nativeAudioFaultTracesRef.current.delete(faultInjectionId);
    },
    []
  );

  const cancelNativeAudioFaultTraces = useCallback((reason: string) => {
    for (const context of nativeAudioFaultTracesRef.current.values()) {
      traceStoreRef.current.updateMetadata(context.traceId, {
        faultValidationOutcome: "cancelled-by-runtime-boundary",
        faultValidationCancelReason: reason,
      });
      traceStoreRef.current.finishStep(
        context.traceId,
        context.commandStepId,
        "cancelled",
        { reason }
      );
      traceStoreRef.current.finishTrace(context.traceId, "cancelled", reason);
    }
    nativeAudioFaultTracesRef.current.clear();
  }, []);

  const readNativeCaptureLease = useCallback(
    () => ({
      captureSessionId: nativeCaptureSessionIdRef.current,
      captureGeneration: nativeCaptureGenerationRef.current,
    }),
    []
  );

  const stopNativeMeetingCapture = useCallback(
    async (
      expectedLease: {
        captureSessionId: string | null;
        captureGeneration: number | null;
      } = readNativeCaptureLease()
    ) => {
      const result = await invoke<NativeAudioStopResult>(
        "stop_meeting_audio_session",
        {
          expectedCaptureSessionId: expectedLease.captureSessionId,
          expectedCaptureGeneration: expectedLease.captureGeneration,
        }
      );
      sessionRecordingManagerRef.current?.recordCaptureLifecycle({
        stage: "native-stop-result",
        expectedCaptureSessionId: expectedLease.captureSessionId,
        expectedCaptureGeneration: expectedLease.captureGeneration,
        stopDisposition: result.disposition,
        activeCaptureSessionId: result.status.captureSessionId,
        activeCaptureGeneration: result.status.captureGeneration,
        activeCaptureOwner: result.status.captureOwner,
      });
      return result;
    },
    [readNativeCaptureLease]
  );

  const injectNativeAudioFault = useCallback(
    async (faultKind: NativeAudioDebugFaultKind) => {
      if (!import.meta.env.DEV || !debugModeRef.current) {
        throw new Error(
          "Native audio fault injection is available only in a debug development build."
        );
      }

      const expectedCaptureSessionId = nativeCaptureSessionIdRef.current;
      const expectedCaptureGeneration = nativeCaptureGenerationRef.current;
      if (
        !activeRef.current ||
        !expectedCaptureSessionId ||
        expectedCaptureGeneration == null
      ) {
        throw new Error("Start Jarvis audio capture before injecting a fault.");
      }

      const faultInjectionId = createMeetingId("native_audio_fault");
      const trace = traceStoreRef.current.startTrace("voice", {
        source: "debug-native-audio-fault",
        workflow: "native-audio-fault-injection",
        syntheticValidation: true,
        productionReliabilityEligible: false,
        faultInjected: true,
        faultInjectionId,
        faultKind,
        expectedCaptureOwner: "meeting",
        expectedCaptureSessionId,
        expectedCaptureGeneration,
      });
      const commandStepId = traceStoreRef.current.startStep(
        trace.id,
        "Native audio fault injection command",
        {
          faultInjectionId,
          faultKind,
          expectedCaptureSessionId,
          expectedCaptureGeneration,
        }
      );
      const context: NativeAudioFaultTraceContext = {
        traceId: trace.id,
        faultKind,
        commandStepId,
        commandSettled: false,
      };
      nativeAudioFaultTracesRef.current.set(faultInjectionId, context);
      sessionRecordingManagerRef.current?.recordCaptureLifecycle({
        stage: "debug-native-audio-fault-requested",
        traceId: trace.id,
        syntheticValidation: true,
        faultInjectionId,
        faultKind,
        expectedCaptureOwner: "meeting",
        expectedCaptureSessionId,
        expectedCaptureGeneration,
      });

      try {
        const result = await invoke<NativeAudioDebugFaultResult>(
          "debug_inject_native_audio_fault",
          {
            expectedOwner: "meeting",
            expectedCaptureSessionId,
            expectedCaptureGeneration,
            faultKind,
            faultInjectionId,
          }
        );
        context.commandSettled = true;
        traceStoreRef.current.finishStep(
          trace.id,
          commandStepId,
          result.disposition === "injected" ? "success" : "cancelled",
          {
            faultInjectionId,
            faultKind,
            faultDisposition: result.disposition,
            previousCaptureSessionId:
              result.previousStatus.captureSessionId,
            previousCaptureGeneration:
              result.previousStatus.captureGeneration,
            currentCaptureSessionId: result.currentStatus.captureSessionId,
            currentCaptureGeneration: result.currentStatus.captureGeneration,
          }
        );
        traceStoreRef.current.recordOutput(
          trace.id,
          "native audio fault injection result",
          JSON.stringify(result, null, 2),
          {
            faultInjectionId,
            faultKind,
            disposition: result.disposition,
          }
        );
        traceStoreRef.current.updateMetadata(trace.id, {
          faultDisposition: result.disposition,
        });
        sessionRecordingManagerRef.current?.recordCaptureLifecycle({
          stage: "debug-native-audio-fault-command-finished",
          traceId: trace.id,
          syntheticValidation: true,
          faultInjectionId,
          faultKind,
          faultDisposition: result.disposition,
        });

        if (result.disposition !== "injected") {
          traceStoreRef.current.finishTrace(
            trace.id,
            "cancelled",
            result.disposition
          );
          nativeAudioFaultTracesRef.current.delete(faultInjectionId);
        } else {
          maybeFinishNativeAudioFaultTrace(faultInjectionId);
        }
        return result;
      } catch (error) {
        context.commandSettled = true;
        traceStoreRef.current.finishStep(
          trace.id,
          commandStepId,
          "error",
          { faultInjectionId, faultKind },
          error
        );
        traceStoreRef.current.finishTrace(trace.id, "error", error);
        nativeAudioFaultTracesRef.current.delete(faultInjectionId);
        sessionRecordingManagerRef.current?.recordCaptureLifecycle({
          stage: "debug-native-audio-fault-command-failed",
          traceId: trace.id,
          syntheticValidation: true,
          faultInjectionId,
          faultKind,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    [maybeFinishNativeAudioFaultTrace]
  );

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
    semanticTaxonomyEvidenceByTurnRef.current.clear();
    taxonomyAdjudicationRuntimeRef.current?.cancelAll("superseded");
    manualCorrectionRevisionRef.current = 0;
    adjacentQuestionScopeRef.current = null;
    logicalQuestionUnitRef.current = undefined;
    answerRevisionByQuestionRef.current.clear();
    playbookPhaseHistoryRef.current = createPlaybookPhaseHistoryState();
    pendingInterviewSectionHintRef.current = undefined;
    cancelledAdvisorTurnIdsRef.current.clear();
    taskBoundaryCandidateRef.current = undefined;
    manualCorrectionOperationCoordinatorRef.current.reset();
    return {
      runtimeInvalidationReason: reason,
      previousRuntimeEpoch: previousEpoch,
      runtimeEpoch: runtimeEpochRef.current,
    };
  }, []);

  const recordCommittedPlaybookPhaseTransition = useCallback(
    (input: {
      operationId: string;
      source: "automatic" | "manual-next" | "manual-back";
      before: ActiveInterviewParent | undefined;
      after: ActiveInterviewParent | undefined;
      traceId?: string;
    }) => {
      if (
        !input.before ||
        !input.after ||
        input.before.id !== input.after.id ||
        input.before.playbookPhase === input.after.playbookPhase
      ) {
        return undefined;
      }

      const parentHistory =
        playbookPhaseHistoryRef.current.parents[input.after.id];
      const appendInput = {
        operationId: input.operationId,
        parentTaskId: input.after.id,
        fromPhase: input.before.playbookPhase,
        toPhase: input.after.playbookPhase,
        taskRevision: input.after.revisions,
        expectedPhaseRevision: parentHistory?.phaseRevision ?? 0,
        committedAt: Date.now(),
      };
      const result =
        input.source === "manual-next"
          ? appendCommittedManualNextPhaseTransition(
              playbookPhaseHistoryRef.current,
              appendInput
            )
          : input.source === "manual-back"
            ? appendCommittedManualBackPhaseTransition(
                playbookPhaseHistoryRef.current,
                appendInput
              )
            : appendCommittedAutomaticPhaseTransition(
                playbookPhaseHistoryRef.current,
                appendInput
              );

      if (result.status === "appended") {
        playbookPhaseHistoryRef.current = result.state;
      }
      if (input.traceId) {
        traceStoreRef.current.updateMetadata(input.traceId, {
          playbookPhaseHistoryOperationId: input.operationId,
          playbookPhaseHistorySource: input.source,
          playbookPhaseHistoryStatus: result.status,
          playbookPhaseHistoryFrom: input.before.playbookPhase,
          playbookPhaseHistoryTo: input.after.playbookPhase,
          playbookPhaseHistoryRevision:
            result.status === "appended"
              ? result.entry.phaseRevision
              : parentHistory?.phaseRevision ?? 0,
          playbookPhaseHistoryReason:
            result.status === "appended" ? undefined : result.reason,
        });
      }
      return result;
    },
    []
  );

  const recordSemanticEmbeddingRuntimeEvent = useCallback(
    ({
      traceId,
      taskId,
      telemetry,
    }: {
      traceId: string;
      taskId?: string;
      telemetry: SemanticEmbeddingRuntimeTelemetry;
    }) => {
      const metadata =
        formatSemanticEmbeddingRuntimeTelemetryForTrace(telemetry);
      traceStoreRef.current.updateMetadata(traceId, metadata);
      sessionRecordingManagerRef.current?.recordSemanticEmbeddingRuntimeEvent({
        traceId,
        taskId,
        metadata,
      });
    },
    []
  );

  const prewarmSemanticTaxonomyRuntime = useCallback((reason: string) => {
    const contextState = contextManagerRef.current.getState();
    const runtime = semanticTaxonomyRuntimeRef.current!;
    runtime.pinSession(
      {
        sessionId: contextState.sessionId,
        runtimeEpoch: runtimeEpochRef.current,
      },
      reason
    );
    void runtime.prewarm().then((snapshot) => {
      sessionRecordingManagerRef.current?.recordCaptureLifecycle({
        stage: "semantic-taxonomy-runtime-prewarm",
        reason,
        readiness: snapshot.readiness,
        modelVersion: snapshot.modelVersion,
        warmupDurationMs: snapshot.warmupDurationMs,
        reusedAfterAudioRecovery: snapshot.reusedAfterAudioRecovery,
        semanticRuntimePinnedReason: snapshot.pinnedReason,
        semanticRuntimeQueueDepth: snapshot.queueDepth,
        semanticRuntimeMaxQueueDepth: snapshot.maxQueueDepth,
        semanticRuntimeCoalescedCount: snapshot.coalescedCount,
        semanticRuntimeStaleCount: snapshot.staleCount,
        semanticRuntimeTimeoutCount: snapshot.timeoutCount,
        semanticRuntimeAbandonedCount: snapshot.abandonedCount,
        error: snapshot.error,
      });
    });
  }, []);

  const scheduleAnswerSufficiencySemanticShadow = useCallback(
    ({
      traceId,
      taskId,
      questionText,
      parsedAnswer,
      decision,
    }: {
      traceId: string;
      taskId?: string;
      questionText: string;
      parsedAnswer: ParsedMeetingAnswer;
      decision: AnswerSufficiencyDecision;
    }) => {
      if (
        decision.answerStatus === "execution-failure" ||
        decision.answerStatus === "fact-anchor-missing"
      ) {
        return;
      }

      const contextState = contextManagerRef.current.getState();
      const sessionId = contextState.sessionId;
      const runtimeEpoch = runtimeEpochRef.current;
      const runtime = semanticTaxonomyRuntimeRef.current!;
      const semanticTurnId =
        `${decision.logicalQuestionUnitId}:answer:${decision.answerRevision}`;
      const semanticText = buildAnswerSufficiencySemanticText({
        questionText,
        parsedAnswer,
      });
      runtime.pinSession(
        { sessionId, runtimeEpoch },
        "answer-sufficiency-semantic-shadow"
      );
      const stepId = traceStoreRef.current.startStep(
        traceId,
        "Answer sufficiency semantic shadow",
        {
          answerSufficiencyOperationId: decision.operationId,
          answerSufficiencyLogicalQuestionUnitId:
            decision.logicalQuestionUnitId,
          answerSufficiencyLogicalQuestionUnitRevision:
            decision.logicalQuestionUnitRevision,
          answerSufficiencyAnswerRevision: decision.answerRevision,
          inputChars: semanticText.length,
          mode: "shadow",
        }
      );
      semanticEmbeddingRevisionRef.current += 1;
      const semanticRequestRevision =
        semanticEmbeddingRevisionRef.current;
      void runtime
        .embed(
          {
            sessionId,
            runtimeEpoch,
            turnId: semanticTurnId,
            texts: [semanticText],
            kind: "query",
          },
          {
            consumer: "answer-sufficiency",
            coalescingKey: `${sessionId}:latest-answer`,
            revision: semanticRequestRevision,
            onTelemetry: (telemetry) => {
              recordSemanticEmbeddingRuntimeEvent({
                traceId,
                taskId,
                telemetry,
              });
            },
          }
        )
        .then((embedding) => {
          const latestContext = contextManagerRef.current.getState();
          const stale =
            latestContext.sessionId !== sessionId ||
            runtimeEpochRef.current !== runtimeEpoch ||
            answerRevisionByQuestionRef.current.get(decision.questionId) !==
              decision.answerRevision ||
            embedding.status === "stale";
          if (stale) {
            traceStoreRef.current.finishStep(
              traceId,
              stepId,
              "cancelled",
              {
                answerSufficiencySemanticDisposition: "stale",
                answerSufficiencySemanticStaleResultDropped: true,
                answerSufficiencyOperationId: decision.operationId,
              }
            );
            return;
          }

          const semantic =
            embedding.status === "success" && embedding.embeddings[0]
              ? scoreAnswerSufficiencySemanticEmbedding(
                  embedding.embeddings[0]
                )
              : undefined;
          const disposition =
            embedding.status !== "success"
              ? embedding.status
              : !semantic?.accepted
                ? "rejected"
                : semantic.candidateStatus === "context-insufficient" &&
                    decision.answerStatus === "context-insufficient"
                  ? "agree-insufficient"
                  : semantic.candidateStatus ===
                        "not-context-insufficient" &&
                      decision.answerStatus !== "context-insufficient"
                    ? "agree-not-insufficient"
                    : "lexical-semantic-conflict";
          const updatedDecision: AnswerSufficiencyDecision = {
            ...decision,
            semanticPrototypeIds: semantic?.prototypeIds ?? [],
            semanticStatus: semantic?.candidateStatus,
            semanticConfidence: semantic?.confidence,
            semanticMargin: semantic?.margin,
            semanticDurationMs: embedding.durationMs,
            semanticDisposition: disposition,
            semanticRejectionReasons:
              semantic?.rejectionReasons ??
              ("reason" in embedding ? [embedding.reason] : []),
          };
          const metadata = {
            ...formatAnswerSufficiencyDecisionForTrace(updatedDecision),
            ...formatSemanticEmbeddingRuntimeTelemetryForTrace(
              embedding.telemetry
            ),
            answerSufficiencySemanticEmbeddingStatus: embedding.status,
            answerSufficiencySemanticModelVersion: embedding.modelVersion,
            answerSufficiencySemanticCacheHit: embedding.cacheHit,
            answerSufficiencySemanticPrototypeVersion:
              semantic?.prototypeVersion,
            answerSufficiencySemanticCalibrationVersion:
              semantic?.calibrationVersion,
          };
          traceStoreRef.current.updateMetadata(traceId, metadata);
          traceStoreRef.current.finishStep(
            traceId,
            stepId,
            embedding.status === "error" ? "error" : "success",
            metadata,
            embedding.status === "error" ? embedding.reason : undefined
          );
          sessionRecordingManagerRef.current?.recordAnswerSufficiencyDecision({
            traceId,
            taskId,
            decision: updatedDecision,
          });
        })
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          traceStoreRef.current.finishStep(
            traceId,
            stepId,
            "error",
            {
              answerSufficiencySemanticDisposition:
                "orchestration-error",
            },
            message
          );
        });
    },
    [recordSemanticEmbeddingRuntimeEvent]
  );

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
      if (
        job.triggerTurnId &&
        (resolvedOutcome === "replaced-before-execution" ||
          resolvedOutcome === "cancelled-by-new-job")
      ) {
        cancelledAdvisorTurnIdsRef.current.add(job.triggerTurnId);
      }
      const boundaryCandidate = taskBoundaryCandidateRef.current;
      const boundaryMetadata =
        boundaryCandidate?.logicalQuestionUnitId ===
        job.logicalQuestionUnit?.id
          ? formatTaskBoundaryCandidateForTrace(boundaryCandidate, {
              survivedAdvisorCancellation:
                taskBoundarySurvivesAdvisorOutcome(
                  boundaryCandidate,
                  "cancelled"
                ),
            })
          : {};
      finishRunningAdvisorJobTrace(
        job,
        "cancelled",
        {
          ...formatAdvisorTriggerJobForTrace(job, resolvedOutcome, {
            cancellationReason: reason,
            commitAuthorized: false,
            commitAuthorizationReason: reason,
          }),
          ...boundaryMetadata,
        },
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
      latestForceAdviseTargetRef.current = undefined;

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
        currentQuestionLineage: undefined,
        latestInterviewerTurnCandidate: undefined,
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

  const meetingModelProviderSnapshotRef = useRef<MeetingModelProviderSnapshot>({
    providers: allAiProviders,
    selectedProvider: selectedAIProvider,
    codingProvider: state.settings.codingModel,
    taxonomyAdjudicationProvider: state.settings.taxonomyAdjudication,
  });
  meetingModelProviderSnapshotRef.current = {
    providers: allAiProviders,
    selectedProvider: selectedAIProvider,
    codingProvider: state.settings.codingModel,
    taxonomyAdjudicationProvider: state.settings.taxonomyAdjudication,
  };

  const resolveMeetingModelRoute = useCallback(
    ({
      useCodingModel,
      requiresVision = false,
      reason,
    }: {
      useCodingModel: boolean;
      requiresVision?: boolean;
      reason: string;
    }) => {
      return resolveMeetingModelRouteFromSnapshot({
        snapshot: meetingModelProviderSnapshotRef.current,
        useCodingModel,
        requiresVision,
        reason,
      });
    },
    []
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
      const taxonomyAdjudicationRoute =
        resolveTaxonomyAdjudicationModelRouteFromSnapshot({
          snapshot: meetingModelProviderSnapshotRef.current,
          reason: "session-recording-provider-summary",
        });
      const sessionRecording = await sessionRecordingManagerRef.current?.start({
        settings: state.settings,
        interviewSessionBrief: contextState.interviewSessionBrief,
        interviewSessionContext: contextState.interviewSessionContext,
        providerSummary: buildSessionRecordingProviderSummary({
          mainProvider: aiProvider,
          codingProvider: codingAiProvider,
          taxonomyAdjudicationProvider: taxonomyAdjudicationRoute.provider,
          sttProvider,
          mainProviderId: selectedAIProvider.provider,
          codingProviderId: state.settings.codingModel.provider,
          taxonomyAdjudicationProviderId:
            taxonomyAdjudicationRoute.resolvedProviderId,
          sttProviderId: selectedSttProvider.provider,
          taxonomyAdjudicationConfigurationStatus:
            taxonomyAdjudicationRoute.configurationStatus,
          taxonomyAdjudicationInheritedVariableKeys:
            taxonomyAdjudicationRoute.inheritedVariableKeys,
          taxonomyAdjudicationMissingRequiredVariables:
            taxonomyAdjudicationRoute.missingRequiredVariables,
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

  const updateCriticalMomentEvaluation = useCallback(
    (momentId: string, patch: Partial<CriticalMomentEvaluation>) => {
      const candidate = criticalMomentCandidatesRef.current.find(
        (item) => item.momentId === momentId
      );
      if (!candidate) return;

      const evaluations = upsertCriticalMomentEvaluation(
        criticalMomentEvaluationsRef.current,
        candidate,
        patch
      );
      criticalMomentEvaluationsRef.current = evaluations;
      persistCriticalMomentEvaluations(evaluations);
      setCriticalMomentEvaluations(evaluations);
      sessionRecordingManagerRef.current?.recordCriticalMomentEvaluations(
        evaluations
      );
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

  const setSemanticTaxonomyMode = useCallback(
    (semanticTaxonomyMode: SemanticTaxonomyMode) => {
      updateSettings((previous) => ({
        ...previous,
        semanticTaxonomyMode,
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

  const setTaxonomyAdjudicationConfig = useCallback(
    (taxonomyAdjudication: MeetingTaxonomyAdjudicationSettings) => {
      updateSettings((previous) => ({
        ...previous,
        taxonomyAdjudication: normalizeTaxonomyAdjudicationSettings(
          taxonomyAdjudication
        ),
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
      currentQuestionEvidenceText,
      diagramDomainContext,
      diagramTopicDomain,
      source,
      useCase,
      questionType,
      askFrame,
      topicDomain,
      projectAnchor,
      memoryPolicy,
      forceStrictProjectAnchor,
      personalEvidenceDecision,
      taskId,
      runtimeToken,
      currentOperationId,
    }: {
      traceId?: string;
      taskId?: string;
      query: string;
      currentQuestionEvidenceText?: string;
      diagramDomainContext?: DiagramDomainQueryContext;
      diagramTopicDomain?: MemoryTopicDomain;
      source: "advisor" | "screen";
      useCase?: MemoryUseCase;
      questionType?: MemoryQuestionType;
      askFrame?: MemoryAskFrame;
      topicDomain?: MemoryTopicDomain;
      projectAnchor?: string;
      memoryPolicy?: MemoryRetrievalPolicy;
      forceStrictProjectAnchor?: boolean;
      personalEvidenceDecision?: PersonalEvidenceDecision;
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
              diagramDomainQueryChars:
                diagramDomainContext?.query.length ?? 0,
              diagramDomainEvidenceSources:
                diagramDomainContext?.evidenceSources ?? [],
              diagramDomainParentTopicIncluded:
                diagramDomainContext?.parentTopicIncluded ?? false,
              diagramTopicDomain: diagramTopicDomain ?? "unknown",
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
              diagramDomainQueryChars:
                diagramDomainContext?.query.length ?? 0,
              diagramDomainEvidenceSources:
                diagramDomainContext?.evidenceSources ?? [],
              diagramDomainParentTopicIncluded:
                diagramDomainContext?.parentTopicIncluded ?? false,
              diagramTopicDomain: diagramTopicDomain ?? "unknown",
            }
          );
        }

        const memoryRuntimeSessionId =
          contextManagerRef.current.getState().sessionId;
        let memoryUsageFlushStepId: string | undefined;
        const retrievedMemoryContext = await retrieveMemoryContext(
          {
            sessionId: memoryRuntimeSessionId,
            query,
            diagramDomainQuery: diagramDomainContext?.query,
            diagramTopicDomain,
            useCase: resolvedUseCase,
            questionType: resolvedQuestionType,
            askFrame,
            topicDomain,
            projectAnchor,
            interviewTypes,
            memoryPolicy: effectiveMemoryPolicy,
          },
          {
            onUsageFlush: (flushResult) => {
              if (!traceId) return;
              const flushMetadata = {
                memoryUsageBatchId: flushResult.batchId,
                memoryUsageFlushMs: flushResult.durationMs,
                memoryUsageFlushEntryCount: flushResult.entryCount,
                memoryUsageFlushSuccess: flushResult.success,
                memoryUsageFlushError: flushResult.error,
                memoryUsageQueueDepthAfter:
                  flushResult.queueDepthAfter,
              };
              traceStoreRef.current.updateMetadata(traceId, flushMetadata);
              if (memoryUsageFlushStepId) {
                traceStoreRef.current.finishStep(
                  traceId,
                  memoryUsageFlushStepId,
                  flushResult.success ? "success" : "error",
                  flushMetadata,
                  flushResult.error
                );
              }
              sessionRecordingManagerRef.current?.recordCaptureLifecycle({
                stage: "memory-usage-flush",
                traceId,
                ...flushMetadata,
              });
            },
          }
        );
        const memoryPerformanceTraceMetadata =
          formatMemoryRetrievalPerformanceForTrace(
            retrievedMemoryContext.performance
          );
        if (
          traceId &&
          retrievedMemoryContext.performance?.usageBatchId
        ) {
          memoryUsageFlushStepId = traceStoreRef.current.startStep(
            traceId,
            "Memory usage flush",
            {
              memoryUsageBatchId:
                retrievedMemoryContext.performance.usageBatchId,
              memoryUsageQueueDepth:
                retrievedMemoryContext.performance.usageQueueDepth,
            }
          );
        }
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
        const memoryContext =
          restrictMemoryContextForPersonalEvidence(
            retrievedMemoryContext,
            personalEvidenceDecision ??
              detectPersonalEvidenceRequirement({
                questionText: currentQuestionEvidenceText ?? query,
                questionType: resolvedQuestionType,
                mode: state.settings.personalEvidenceGuardrailMode,
              }),
            currentQuestionEvidenceText ?? query
          ) ?? retrievedMemoryContext;
        const personalEvidenceFilteredEntries =
          retrievedMemoryContext.entries.length - memoryContext.entries.length;
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
              ...memoryPerformanceTraceMetadata,
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
              diagramDomainQueryChars:
                diagramDomainContext?.query.length ?? 0,
              diagramDomainEvidenceSources:
                diagramDomainContext?.evidenceSources ?? [],
              diagramDomainParentTopicIncluded:
                diagramDomainContext?.parentTopicIncluded ?? false,
              diagramTopicDomain: diagramTopicDomain ?? "unknown",
              candidateCount: memoryContext.candidateCount,
              eligibleCount: memoryContext.eligibleCount,
              rejectedCount: memoryContext.rejectedCount,
              rejectSummary: memoryContext.rejectSummary,
              ...diagramOverlayTraceMetadata,
              ...memoryRoleTraceMetadata,
              memoryPolicySnapshot: memoryContext.policySnapshot,
              totalChars: memoryContext.totalChars,
              personalEvidenceFilteredEntries,
            }
          );
          sessionRecordingManagerRef.current?.recordMemoryRetrieval({
            traceId,
            taskId,
            query,
            diagramDomainQuery: diagramDomainContext?.query,
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
              diagramDomainQueryChars:
                diagramDomainContext?.query.length ?? 0,
              diagramDomainEvidenceSources:
                diagramDomainContext?.evidenceSources ?? [],
              diagramDomainParentTopicIncluded:
                diagramDomainContext?.parentTopicIncluded ?? false,
              diagramTopicDomain: diagramTopicDomain ?? "unknown",
              ...diagramOverlayTraceMetadata,
              ...memoryRoleTraceMetadata,
              ...memoryPerformanceTraceMetadata,
              personalEvidenceFilteredEntries,
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
            diagramDomainQueryChars:
              diagramDomainContext?.query.length ?? 0,
            diagramDomainEvidenceSources:
              diagramDomainContext?.evidenceSources ?? [],
            diagramDomainParentTopicIncluded:
              diagramDomainContext?.parentTopicIncluded ?? false,
            diagramTopicDomain: diagramTopicDomain ?? "unknown",
            personalEvidenceFilteredEntries,
            candidateCount: memoryContext.candidateCount,
            eligibleCount: memoryContext.eligibleCount,
            rejectedCount: memoryContext.rejectedCount,
            rejectSummary: memoryContext.rejectSummary,
            ...diagramOverlayTraceMetadata,
            ...memoryRoleTraceMetadata,
            ...memoryPerformanceTraceMetadata,
            memoryPolicySnapshot: memoryContext.policySnapshot,
            totalChars: memoryContext.totalChars,
          });
          traceStoreRef.current.updateMetadata(
            traceId,
            {
              diagramDomainQueryChars:
                diagramDomainContext?.query.length ?? 0,
              diagramDomainEvidenceSources:
                diagramDomainContext?.evidenceSources ?? [],
              diagramDomainParentTopicIncluded:
                diagramDomainContext?.parentTopicIncluded ?? false,
              diagramTopicDomain: diagramTopicDomain ?? "unknown",
              ...diagramOverlayTraceMetadata,
              ...memoryRoleTraceMetadata,
              ...memoryPerformanceTraceMetadata,
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
    latestForceAdviseTargetRef.current = undefined;
    setState(clearActiveScreenTaskState);
  }, [
    advanceRuntimeEpoch,
    cancelActiveAdvisorJob,
    clearPendingSentenceCompletionForRuntimeReset,
  ]);

  const stop = useCallback(async () => {
    const coordinator = captureLifecycleCoordinatorRef.current!;
    const lifecycleOperation = coordinator.claim("stop");
    const nativeLeaseToStop = readNativeCaptureLease();
    const unresolvedManualRecovery = nativeAudioManualRecoveryRef.current;
    if (unresolvedManualRecovery) {
      const stoppedAt = Date.now();
      const contextState = contextManagerRef.current.getState();
      sessionRecordingManagerRef.current?.recordCaptureLifecycle({
        ...buildUnresolvedNativeAudioManualRecoveryMetadata({
          recovery: unresolvedManualRecovery,
          stoppedAt,
        }),
        activeMeetingTaskId: contextState.activeMeetingTask?.id,
        transcriptTurns: contextState.transcriptTurns.length,
      });
    }
    cancelNativeAudioFaultTraces("meeting-assistant-stopped");
    advanceRuntimeEpoch("meeting-assistant-stopped");
    semanticTaxonomyRuntimeRef.current?.releaseSession({
      recoveryTokenActive: false,
      reason: "meeting-assistant-stopped",
    });
    activeRef.current = false;
    invalidateAudioProcessingSession();
    cancelActiveAdvisorJob("meeting-assistant-stopped");
    nativeAudioManualRecoveryRef.current = null;
    screenAnalysisAbortRef.current?.abort();
    screenAnalysisAbortRef.current = null;
    contextManagerRef.current.clearActiveMeetingTask();
    contextManagerRef.current.clearInterviewSessionContext();
    const contextState = contextManagerRef.current.getState();

    await coordinator.run(lifecycleOperation, async () => {
      let audioStatus: MeetingAudioStatus | null = null;

      try {
        audioStatus = (await stopNativeMeetingCapture(nativeLeaseToStop)).status;
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

      const terminalMemoryUsageFlush = await flushMemoryContextUsage();
      if (terminalMemoryUsageFlush) {
        sessionRecordingManagerRef.current?.recordCaptureLifecycle({
          stage: "memory-usage-terminal-flush",
          memoryUsageBatchId: terminalMemoryUsageFlush.batchId,
          memoryUsageFlushMs: terminalMemoryUsageFlush.durationMs,
          memoryUsageFlushEntryCount: terminalMemoryUsageFlush.entryCount,
          memoryUsageFlushSuccess: terminalMemoryUsageFlush.success,
          memoryUsageFlushError: terminalMemoryUsageFlush.error,
        });
      }
      await stopSessionRecording("meeting-assistant-stopped");
      if (!coordinator.authorize(lifecycleOperation, "commit-stop-state")) {
        return;
      }

      setState((previous) => ({
        ...clearActiveMeetingTaskProjection(previous),
        status: "idle",
        interviewSessionBrief: contextState.interviewSessionBrief,
        interviewSessionContext: contextState.interviewSessionContext,
        latestSuggestion:
          isScreenAnchoredSuggestion(previous.latestSuggestion)
            ? null
            : previous.latestSuggestion,
        latestReliableSuggestion: null,
        manualQuestionTypeCorrection: undefined,
        currentQuestionLineage: undefined,
        latestInterviewerTurnCandidate: undefined,
        partialSuggestion: "",
        error: null,
        audioStatus,
        nativeAudioManualRecovery: undefined,
      }));
    });
  }, [
    advanceRuntimeEpoch,
    cancelNativeAudioFaultTraces,
    cancelActiveAdvisorJob,
    invalidateAudioProcessingSession,
    readNativeCaptureLease,
    stopNativeMeetingCapture,
    stopSessionRecording,
  ]);

  const buildAdvisorJob = useCallback((options: RunAdvisorOptions) => {
    const contextState = contextManagerRef.current.getState();
    const basePromptContext =
      options.promptContextOverride ??
      contextManagerRef.current.buildAdvisorPromptContext();
    const promptContext = options.promptTurnOverride
      ? {
          ...basePromptContext,
          transcript: [
            basePromptContext.transcript.trim(),
            `Them: ${options.promptTurnOverride.text.trim()}`,
          ]
            .filter(Boolean)
            .join("\n"),
          advisorPromptSourceTurnIds: [
            ...(basePromptContext.advisorPromptSourceTurnIds ?? []),
            options.promptTurnOverride.id,
          ],
          latestTurn: options.promptTurnOverride,
        }
      : basePromptContext;
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
    const responseActionScope =
      promptContext.responseActionContextScope;
    if (traceId && responseActionScope) {
      traceStoreRef.current.updateMetadata(traceId, {
        responseActionContextOperationId:
          responseActionScope.operationId,
        responseActionContextAction: responseActionScope.action,
        responseActionContextMode: responseActionScope.mode,
        responseActionLogicalQuestionUnitId:
          responseActionScope.logicalQuestionUnitId,
        responseActionLogicalQuestionUnitRevision:
          responseActionScope.logicalQuestionUnitRevision,
        responseActionSelectedContextSourceKinds:
          responseActionScope.selectedContextSourceKinds,
        responseActionSelectedContextTurnIds:
          responseActionScope.selectedContextTurnIds,
        responseActionSelectedContextChars:
          responseActionScope.selectedContextChars,
        responseActionSelectionReason:
          responseActionScope.selectionReason,
        responseActionExpansionBudget:
          responseActionScope.expansionBudget,
      });
    }

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
      logicalQuestionUnit: options.logicalQuestionUnit,
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
    const logicalQuestionLease = advisorJob.logicalQuestionUnit
      ? createLogicalQuestionUnitLease(advisorJob.logicalQuestionUnit)
      : undefined;
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
      if (!decision.authorized) {
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
      }

      if (!logicalQuestionLease) return false;
      const logicalQuestionAuthorization =
        authorizeLogicalQuestionUnitLease(
          logicalQuestionLease,
          logicalQuestionUnitRef.current
        );
      if (traceId) {
        traceStoreRef.current.updateMetadata(
          traceId,
          formatLogicalQuestionLeaseForTrace(
            logicalQuestionLease,
            logicalQuestionAuthorization,
            stage
          )
        );
      }
      if (logicalQuestionAuthorization.authorized) return false;

      finishRunningAdvisorJobTrace(
        advisorJob,
        "cancelled",
        {
          ...formatAdvisorTriggerJobForTrace(
            advisorJob,
            "stale-commit-rejected",
            {
              cancellationReason: logicalQuestionAuthorization.reason,
              commitAuthorized: false,
              commitAuthorizationReason:
                logicalQuestionAuthorization.reason,
            }
          ),
          ...formatLogicalQuestionLeaseForTrace(
            logicalQuestionLease,
            logicalQuestionAuthorization,
            stage
          ),
        },
        logicalQuestionAuthorization.reason
      );
      releaseAdvisorJob(advisorJob, "suppressed", {
        commitAuthorized: false,
        commitAuthorizationReason:
          logicalQuestionAuthorization.reason,
      });
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
    const advisorTaskFallbackQuery =
      advisorJob.logicalQuestionUnit?.normalizedText.trim() ||
      (promptContext.latestTurn?.speaker === "them"
        ? promptContext.latestTurn.text.trim()
        : "") ||
      formatAdvisorActiveTaskForQuery(promptContext);
    const resolvedAdvisorTaskSignals = resolveAdvisorTaskSignals(
      promptContext,
      advisorTaskFallbackQuery,
      advisorJob.logicalQuestionUnit
    );
    const logicalQuestionSectionHint = advisorJob.logicalQuestionUnit?.sectionHint;
    const sectionHintAdvisorTaskSignals = logicalQuestionSectionHint
      ? {
          ...resolvedAdvisorTaskSignals,
          questionType: logicalQuestionSectionHint.questionType,
          questionTypeDecision: undefined,
          taskRelation: "new-parent" as InterviewTaskRelation,
          source: "interview-section-hint",
          reuseActivePlaybook: false,
          openingRoute: undefined,
          latestTurnTaxonomyBoundaryReason: "section-hint" as const,
          taxonomyFallbackSuppressed: false,
          unknownTaskMutationBlocked: false,
        }
      : resolvedAdvisorTaskSignals;
    const correctedAdvisorTaskSignals = options.manualQuestionTypeCorrection
      ? applyManualQuestionTypeCorrectionToAdvisorSignals(
          sectionHintAdvisorTaskSignals,
          options.manualQuestionTypeCorrection
        )
      : sectionHintAdvisorTaskSignals;
    const semanticEvidenceTurnId = advisorJob.triggerTurnId ?? latestTurn?.id;
    const semanticEvidence = semanticEvidenceTurnId
      ? semanticTaxonomyEvidenceByTurnRef.current.get(semanticEvidenceTurnId)
      : undefined;
    const semanticEvidenceIsCurrent = Boolean(
      semanticEvidence &&
        advisorJob.source === "live-turn" &&
        semanticEvidence.sessionId === advisorJob.expectedSessionId &&
        semanticEvidence.runtimeEpoch ===
          advisorJob.runtimeCommitToken.runtimeEpoch
    );
    const semanticUnknownRescueDecision =
      decideSemanticTaxonomyUnknownRescue({
        mode: state.settings.semanticTaxonomyMode,
        lexicalType:
          semanticEvidenceIsCurrent && semanticEvidence
            ? semanticEvidence.lexical.type ?? "unknown"
            : "unknown",
        deterministicType:
          normalizeCanonicalQuestionType(
            correctedAdvisorTaskSignals.questionType
          ) ?? "unknown",
        recommendedType:
          semanticEvidenceIsCurrent && semanticEvidence
            ? semanticEvidence.hybrid?.recommendedType
            : undefined,
        wouldRescue: Boolean(
          semanticEvidenceIsCurrent && semanticEvidence?.hybrid?.wouldRescue
        ),
        activeParentType:
          normalizeCanonicalQuestionType(
            getAdvisorActiveQuestionType(promptContext)
          ) ?? undefined,
        hasManualCorrection: Boolean(options.manualQuestionTypeCorrection),
      });
    const semanticAdvisorTaskSignals = semanticUnknownRescueDecision.applied
      ? {
          ...correctedAdvisorTaskSignals,
          questionType: semanticUnknownRescueDecision.effectiveType,
          source: "semantic-unknown-rescue",
          latestTurnTaxonomyBoundaryReason:
            "semantic-unknown-rescue" as const,
          taxonomyFallbackSuppressed: false,
          unknownTaskMutationBlocked: false,
        }
      : correctedAdvisorTaskSignals;
    const inferredTurnIntentDecision =
      advisorJob.turnIntentDecision ??
      (latestTurn?.speaker === "them"
        ? evaluateThemTurnForAdvisor(latestTurn, {
            hasActiveTask: hasAdvisorActiveTask(promptContext),
            hasRecentQuestionContext: Boolean(
              advisorJob.questionLineage ?? currentQuestionLineageRef.current
            ),
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
    const taskMutationAuthorization = authorizeAdvisorTaskMutation({
      authority: advisorJob.taskMutationAuthority,
      turnIntentDecision: inferredTurnIntentDecision,
    });
    const outputCommitAuthorization = authorizeAdvisorOutputCommit({
      authority: advisorJob.taskMutationAuthority,
      executionAuthorized: executionAuthorization.authorized,
      turnIntentDecision: inferredTurnIntentDecision,
    });
    const advisorTaskMutationDecision = decideAdvisorTaskMutation({
      authority: advisorJob.taskMutationAuthority,
      resolvedRelation: semanticAdvisorTaskSignals.taskRelation,
      hasActiveParent: hasAdvisorActiveTask(promptContext),
      hasActiveChild: hasAdvisorActiveChild(promptContext),
      mutationAuthorized: taskMutationAuthorization.authorized,
    });
    const preservedParentQuestionType = getAdvisorActiveQuestionType(promptContext);
    let advisorTaskSignals =
      advisorTaskMutationDecision.preserveParentType &&
      preservedParentQuestionType
        ? {
            ...semanticAdvisorTaskSignals,
            questionType: preservedParentQuestionType,
            questionTypeDecision: undefined,
            askFrame:
              getAdvisorActiveAskFrame(promptContext) ??
              semanticAdvisorTaskSignals.askFrame,
            topicDomain:
              getAdvisorActiveTopicDomain(promptContext) ??
              semanticAdvisorTaskSignals.topicDomain,
            projectAnchor:
              getAdvisorActiveProjectAnchor(promptContext) ??
              semanticAdvisorTaskSignals.projectAnchor,
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
        : semanticAdvisorTaskSignals;
    const advisorScreenScopeDecision = decideAdvisorScreenScope({
      triggerSource: advisorJob.source,
      relation: advisorTaskSignals.taskRelation,
      hasActiveScreenTask: Boolean(promptContext.activeScreenTask),
      taskMutationAuthorized: taskMutationAuthorization.authorized,
    });
    promptContext = applyAdvisorScreenScopeToPromptContext(
      promptContext,
      advisorScreenScopeDecision
    );
    const advisorPromptMode = resolveAdvisorRequestModeForScreenScope(
      mode,
      advisorScreenScopeDecision
    );
    let advisorEvidencePacket = buildAdvisorEvidencePacket({});
    let advisorRetrievalQuery = "";
    const refreshAdvisorEvidencePacket = () => {
      const currentQuestionText =
        advisorJob.logicalQuestionUnit?.normalizedText.trim() ?? "";
      const amazonLeadershipPrincipleHint =
        buildAmazonLeadershipPrincipleMemoryHint(
          promptContext.interviewSessionContext,
          currentQuestionText
        );
      advisorEvidencePacket = buildAdvisorEvidencePacket({
        currentQuestion: advisorJob.logicalQuestionUnit
          ? {
              text: advisorJob.logicalQuestionUnit.normalizedText,
              source: "voice-lqu",
              sourceTurnIds:
                advisorJob.logicalQuestionUnit.sourceTurnIds,
              logicalQuestionUnitId:
                advisorJob.logicalQuestionUnit.id,
              revision: advisorJob.logicalQuestionUnit.revision,
            }
          : undefined,
        activeMeetingTask: promptContext.activeMeetingTask,
        interviewSessionBrief:
          promptContext.interviewSessionBrief,
        interviewSessionContext:
          promptContext.interviewSessionContext,
        activatedFactIds:
          promptContext.activeMeetingTask?.parent.supportedFactAnchors ??
          promptContext.activeInterviewTask?.supportedFactAnchors,
        generatedGuidance:
          options.currentSuggestion?.trim() &&
          state.latestSuggestion?.sourceTraceId
            ? {
                text: options.currentSuggestion,
                sourceTraceId:
                  state.latestSuggestion.sourceTraceId,
              }
            : undefined,
        additionalRetrievalHints: [
          advisorTaskSignals.askFrame !== "unknown"
            ? {
                role: "source-metadata" as const,
                text: `ask frame: ${advisorTaskSignals.askFrame}`,
              }
            : undefined,
          advisorTaskSignals.topicDomain !== "unknown"
            ? {
                role: "source-metadata" as const,
                text: `topic domain: ${advisorTaskSignals.topicDomain}`,
              }
            : undefined,
          advisorTaskSignals.projectAnchor
            ? {
                role: "source-metadata" as const,
                text: `project anchor: ${advisorTaskSignals.projectAnchor}`,
              }
            : undefined,
          amazonLeadershipPrincipleHint
            ? {
                role: "source-metadata" as const,
                text: amazonLeadershipPrincipleHint,
              }
            : undefined,
        ].filter(
          (
            hint
          ): hint is {
            role: "source-metadata";
            text: string;
          } => Boolean(hint)
        ),
      });
      advisorRetrievalQuery =
        buildAdvisorEvidenceRetrievalQuery(
          advisorEvidencePacket,
          mode
        );
      advisorTaskSignals = {
        ...advisorTaskSignals,
        query: advisorRetrievalQuery,
      };
      promptContext = {
        ...promptContext,
        advisorEvidencePacket,
      };
      if (traceId) {
        traceStoreRef.current.updateMetadata(
          traceId,
          formatAdvisorEvidencePacketForTrace(
            advisorEvidencePacket,
            advisorRetrievalQuery
          )
        );
      }
    };
    refreshAdvisorEvidencePacket();
    let activeMeetingTaskId = getAdvisorActiveTaskId(promptContext);
    const questionLineage = createAuthorizedQuestionLineage({
      traceId,
      triggerTurnId: advisorJob.triggerTurnId ?? latestTurn?.id,
      sessionId: advisorJob.expectedSessionId,
      runtimeEpoch: advisorJob.runtimeCommitToken.runtimeEpoch,
      action:
        inferredTurnIntentDecision?.action ??
        (hasExplicitAction ? "answer-refresh" : undefined),
      executionAuthorized: executionAuthorization.authorized,
      inherited: advisorJob.questionLineage,
    });
    const taskBoundaryAuthoritySource = options.manualQuestionTypeCorrection
      ? "manual-correction"
      : advisorTaskSignals.openingRoute
        ? "opening-route"
        : advisorTaskSignals.source === "semantic-unknown-rescue"
          ? "semantic-unknown-rescue"
          : "accepted-transcript";
    let taskBoundaryCandidate = createTaskBoundaryCandidate({
      logicalQuestionUnit: advisorJob.logicalQuestionUnit,
      proposedQuestionType: advisorTaskSignals.questionType,
      proposedRelation: advisorTaskSignals.taskRelation,
      authoritySource: taskBoundaryAuthoritySource,
      confidence: advisorTaskSignals.openingRoute
        ? 1
        : advisorTaskSignals.questionTypeDecision?.confidence,
      questionComplete:
        Boolean(options.manualQuestionTypeCorrection) ||
        Boolean(advisorTaskSignals.openingRoute) ||
        Boolean(
          inferredTurnIntentDecision?.executionAuthorized &&
            inferredTurnIntentDecision.intent !== "incomplete" &&
            inferredTurnIntentDecision.intent !== "unknown"
        ),
      mutationAuthorized: taskMutationAuthorization.authorized,
      commitParent:
        advisorTaskMutationDecision.commitParent &&
        advisorTaskSignals.openingRoute?.commitParent !== false,
    });
    if (
      taskBoundaryCandidate &&
      (taskBoundaryCandidate.mutationDisposition ===
        "commit-before-advisor" ||
        taskBoundaryCandidate.mutationDisposition ===
          "pending-incomplete-question" ||
        taskBoundaryCandidate.mutationDisposition === "pending-low-authority")
    ) {
      const previousCandidate = expireTaskBoundaryCandidate(
        taskBoundaryCandidateRef.current
      );
      if (
        previousCandidate?.state === "pending" &&
        previousCandidate.id !== taskBoundaryCandidate.id
      ) {
        const supersededCandidate = supersedeTaskBoundaryCandidate(
          previousCandidate
        );
        if (traceId) {
          traceStoreRef.current.updateMetadata(traceId, {
            supersededTaskBoundaryCandidateId: supersededCandidate.id,
            supersededTaskBoundaryCandidateState: supersededCandidate.state,
          });
        }
      }
      taskBoundaryCandidateRef.current = taskBoundaryCandidate;
    }
    const questionTypeTraceMetadata =
      formatAdvisorQuestionTypeDecisionForTrace(advisorTaskSignals);
    const semanticEnforcementMetadata = {
      semanticTaxonomyMode: state.settings.semanticTaxonomyMode,
      semanticTaxonomyEvidenceCurrent: semanticEvidenceIsCurrent,
      taxonomySemanticEnforcementReason:
        semanticUnknownRescueDecision.reason,
      taxonomySemanticParentMutationBlocked:
        semanticUnknownRescueDecision.parentMutationBlocked,
      taxonomySemanticRescueApplied: semanticUnknownRescueDecision.applied,
      taxonomyHybridEffectiveType:
        semanticUnknownRescueDecision.effectiveType,
    };
    if (traceId) {
      const intentMetadata = inferredTurnIntentDecision
        ? formatAdvisorTurnIntentForTrace(inferredTurnIntentDecision)
        : {};
      const executionMetadata = {
        ...intentMetadata,
        ...questionTypeTraceMetadata,
        ...semanticEnforcementMetadata,
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
        taskMutationAuthorized: taskMutationAuthorization.authorized,
        taskMutationAuthorizationReason: taskMutationAuthorization.reason,
        advisorOutputCommitAuthorized: outputCommitAuthorization.authorized,
        advisorOutputCommitReason: outputCommitAuthorization.reason,
        advisorExecutionAuthorized: executionAuthorization.authorized,
        advisorExecutionAuthorizationReason: executionAuthorization.reason,
        advisorExecutionBypassed: executionAuthorization.bypassed,
        ...formatQuestionLineageForTrace(questionLineage),
        ...formatLogicalQuestionUnitForTrace(advisorJob.logicalQuestionUnit),
        ...formatTaskBoundaryCandidateForTrace(taskBoundaryCandidate, {
          parentBeforeId:
            originalPromptContext.activeMeetingTask?.parent.id ??
            originalPromptContext.activeInterviewTask?.id,
          parentBeforeType:
            originalPromptContext.activeMeetingTask?.parent.questionType ??
            originalPromptContext.activeInterviewTask?.stableKind,
        }),
        provisionalQuestionEligible:
          questionLineage?.identityState === "provisional",
        provisionalQuestionEligibilityReason: questionLineage
          ? advisorJob.questionLineage
            ? "inherited-question-lineage"
            : "authorized-answer-refresh"
          : executionAuthorization.authorized
            ? "non-answer-refresh"
            : executionAuthorization.reason,
        advisorTriggerTurnId: advisorJob.triggerTurnId,
        memoryRetrievalSuppressedReason: executionAuthorization.authorized
          ? undefined
          : executionAuthorization.reason,
        modelExecutionSuppressedReason: executionAuthorization.authorized
          ? undefined
          : executionAuthorization.reason,
      };
      traceStoreRef.current.updateMetadata(traceId, executionMetadata);
      if (semanticEvidenceIsCurrent && semanticEvidence) {
        sessionRecordingManagerRef.current?.recordSemanticTaxonomyDecision({
          traceId,
          taskId: promptContext.activeMeetingTask?.id,
          metadata: {
            ...semanticEvidence.metadata,
            ...semanticEnforcementMetadata,
          },
        });
      }
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

    const preBoundaryResponseOwnerType =
      getAdvisorActiveQuestionType(promptContext);

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
      (advisorTaskSignals.taskRelation === "new-parent"
        ? undefined
        : getAdvisorActiveProjectAnchor(promptContext));
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
    const startsNewParentForPhase =
      advisorTaskSignals.taskRelation === "new-parent" &&
      advisorTaskMutationDecision.commitParent &&
      taskMutationAuthorization.authorized;
    const preservedPlaybookPhase = startsNewParentForPhase
      ? advisorPlaybook?.phase ?? "follow_up"
      : promptContext.activeMeetingTask?.parent.playbookPhase ??
        promptContext.activeInterviewTask?.playbookPhase ??
        advisorPlaybook?.phase ??
        "follow_up";
    const automaticPlaybookPhaseDecision = decidePlaybookPhaseProgression({
      questionType: advisorPhaseQuestionType,
      playbookId: advisorPlaybook?.id,
      currentPhase: startsNewParentForPhase
        ? advisorPlaybook?.phase
        : promptContext.activeMeetingTask?.parent.playbookPhase ??
          promptContext.activeInterviewTask?.playbookPhase ??
          advisorPlaybook?.phase,
      phaseProgress: startsNewParentForPhase
        ? undefined
        : promptContext.activeMeetingTask?.parent.phaseProgress ??
          promptContext.activeInterviewTask?.phaseProgress,
      latestTurnText: latestTurn?.text,
      currentQuestion:
        advisorEvidencePacket.currentQuestion?.text ?? "",
      relation: advisorTaskSignals.taskRelation,
      subtaskIntent: advisorTaskSignals.subtaskIntent,
      askFrame: advisorAskFrame ?? getAdvisorActiveAskFrame(promptContext),
    });
    const defaultManualPhaseDecision =
      decideManualNextPhaseTransition(
        promptContext.activeMeetingTask
      );
    const manualPhaseDecision = options.manualPhaseTargetOverride
      ? {
          ...defaultManualPhaseDecision,
          phase: options.manualPhaseTargetOverride,
          phaseTo: options.manualPhaseTargetOverride,
          manualPhaseTo: options.manualPhaseTargetOverride,
          reason:
            "restore the forward phase recorded by deterministic playbook history",
        }
      : defaultManualPhaseDecision;
    const playbookPhaseDecision = decideAdvisorPhaseMutation({
      authority: advisorJob.taskMutationAuthority,
      taskMutationAuthorized: taskMutationAuthorization.authorized,
      manualPhaseAdvance,
      currentPhase: preservedPlaybookPhase,
      hasActiveChild: hasAdvisorActiveChild(promptContext),
      automaticDecision: automaticPlaybookPhaseDecision,
      manualDecision: manualPhaseDecision,
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
        const phaseHistoryCommit =
          recordCommittedPlaybookPhaseTransition({
            operationId:
              options.manualPhaseOperationId ??
              `phase-next-${advisorJob.id}`,
            source: "manual-next",
            before: existingInterviewTask,
            after: updatedInterviewTask,
            traceId,
          });
        if (traceId) {
          traceStoreRef.current.updateMetadata(traceId, {
            manualPhaseCommitApplied:
              phaseHistoryCommit?.status === "appended",
          });
        }
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
    let taskBoundaryCommittedBeforeAdvisor = false;
    if (
      taskBoundaryCandidate?.commitPolicy === "immediate" &&
      advisorJob.logicalQuestionUnit
    ) {
      const preBoundaryDecision = readCommitDecision();
      if (preBoundaryDecision.authorized) {
        const contextStateBeforeBoundary = contextManagerRef.current.getState();
        const parentBeforeId = contextStateBeforeBoundary.activeMeetingTask?.parent.id;
        const parentBeforeType =
          contextStateBeforeBoundary.activeMeetingTask?.parent.questionType;
        const previousInterviewParent =
          contextStateBeforeBoundary.activeInterviewTask;
        const crossDomainTransitionDecision =
          decideCrossDomainParentTransition({
            previousParent: previousInterviewParent,
            nextQuestionType: taskBoundaryCandidate.proposedQuestionType,
            nextQuestionText:
              advisorJob.logicalQuestionUnit.normalizedText,
          });
        const parentContextHandoff =
          previousInterviewParent &&
          crossDomainTransitionDecision.kind === "linked-parent-extension"
            ? buildBoundedParentContextHandoff({
                parent: previousInterviewParent,
                sourceQuestionId:
                  questionLineage?.questionInstanceId ??
                  advisorJob.logicalQuestionUnit.id,
                latestQuestionText:
                  advisorJob.logicalQuestionUnit.normalizedText,
                transcriptTurns: contextStateBeforeBoundary.transcriptTurns,
                boundaryTurnId:
                  advisorJob.logicalQuestionUnit.sourceTurnIds[0],
              })
            : undefined;
        const boundaryParent = buildCommittedTaskBoundaryParent({
          candidate: taskBoundaryCandidate,
          logicalQuestionUnit: advisorJob.logicalQuestionUnit,
          source: resolveAdvisorTaskEvidenceSource({
            triggerSource: advisorJob.source,
            hasActiveScreenTask: Boolean(promptContext.activeScreenTask),
          }),
          questionInstanceId: questionLineage?.questionInstanceId,
          playbook: advisorRuntimePlaybook,
          phaseDecision: playbookPhaseDecision,
          expiresAt: getActiveScreenTaskExpiresAt(state.settings),
          parentContextHandoff,
        });

        if (boundaryParent) {
          contextManagerRef.current.setActiveMeetingTaskState({
            activeScreenTask:
              advisorScreenScopeDecision.action === "clear"
                ? null
                : contextStateBeforeBoundary.activeScreenTask,
            activeInterviewTask: boundaryParent,
          });
          const boundaryContext =
            contextManagerRef.current.buildAdvisorPromptContext();
          promptContext = { ...promptContext, ...boundaryContext };
          activeMeetingTaskId = getAdvisorActiveTaskId(promptContext);
          effectiveRuntimeCommitToken = rebaseRuntimeCommitToken({
            token: effectiveRuntimeCommitToken,
            snapshot: readRuntimeCommitSnapshot(),
          });
          taskBoundaryCandidate = commitTaskBoundaryCandidate(
            taskBoundaryCandidate,
            boundaryParent.id
          );
          taskBoundaryCandidateRef.current = taskBoundaryCandidate;
          taskBoundaryCommittedBeforeAdvisor = true;
          const committedContext = contextManagerRef.current.getState();
          setState((previous) => ({
            ...previous,
            activeScreenTask: committedContext.activeScreenTask,
            activeInterviewTask: committedContext.activeInterviewTask,
            activeMeetingTask: committedContext.activeMeetingTask,
          }));
          if (traceId) {
            traceStoreRef.current.updateMetadata(traceId, {
              ...formatTaskBoundaryCandidateForTrace(taskBoundaryCandidate, {
                committedBeforeAdvisor: true,
                parentBeforeId,
                parentBeforeType,
                parentAfterId: boundaryParent.id,
                parentAfterType: boundaryParent.stableKind,
              }),
              ...formatCrossDomainParentTransitionForTrace(
                crossDomainTransitionDecision
              ),
              parentContextHandoffSourceId:
                parentContextHandoff?.sourceParentId,
              parentContextHandoffSourceQuestionId:
                parentContextHandoff?.sourceQuestionId,
              runtimeCommitTokenRebased: true,
              runtimeCommitTokenRebaseReason:
                "task-boundary-committed-before-advisor",
            });
            if (committedContext.activeMeetingTask) {
              sessionRecordingManagerRef.current?.recordActiveMeetingTaskSnapshot(
                committedContext.activeMeetingTask,
                traceId
              );
            }
          }
        }
      }
    }

    let sourceOwnedTransitionResult:
      | SourceOwnedTransitionCommitResult
      | undefined;
    if (
      !manualPhaseAdvance &&
      advisorTaskSignals.taskRelation !== "new-parent" &&
      advisorJob.logicalQuestionUnit
    ) {
      const transitionContextBefore =
        contextManagerRef.current.getState();
      const transitionParentBefore =
        transitionContextBefore.activeInterviewTask ??
        (transitionContextBefore.activeScreenTask
          ? buildInterviewParentFromScreenTask(
              transitionContextBefore.activeScreenTask
            )
          : undefined);
      const sourceOwnedTransitionCandidate =
        createSourceOwnedTransitionCandidate({
          sessionId: transitionContextBefore.sessionId,
          runtimeEpoch: runtimeEpochRef.current,
          source: resolveAdvisorTaskEvidenceSource({
            triggerSource: advisorJob.source,
            hasActiveScreenTask: Boolean(
              transitionContextBefore.activeScreenTask
            ),
          }),
          sourceTurnIds:
            advisorJob.logicalQuestionUnit.sourceTurnIds,
          logicalQuestionUnitId:
            advisorJob.logicalQuestionUnit.id,
          logicalQuestionRevision:
            advisorJob.logicalQuestionUnit.revision,
          existingTask: transitionParentBefore,
          relation: advisorTaskSignals.taskRelation,
          authoritySource: taskBoundaryAuthoritySource,
          mutationAuthorized:
            taskMutationAuthorization.authorized,
          questionType: advisorQuestionType,
          question:
            advisorJob.logicalQuestionUnit.normalizedText,
          subtaskIntent: advisorTaskSignals.subtaskIntent,
          questionInstanceId:
            questionLineage?.questionInstanceId,
          playbook: advisorRuntimePlaybook,
          phaseDecision: playbookPhaseDecision,
          expiresAt: getActiveScreenTaskExpiresAt(
            state.settings
          ),
        });

      if (sourceOwnedTransitionCandidate) {
        sourceOwnedTransitionResult =
          commitSourceOwnedTransition({
            candidate: sourceOwnedTransitionCandidate,
            currentTask: transitionParentBefore,
            currentSessionId:
              transitionContextBefore.sessionId,
            currentRuntimeEpoch: runtimeEpochRef.current,
          });
        if (traceId) {
          traceStoreRef.current.updateMetadata(
            traceId,
            formatSourceOwnedTransitionForTrace(
              sourceOwnedTransitionResult,
              {
                committedBeforeModel:
                  sourceOwnedTransitionResult.candidate
                    .state === "committed",
              }
            )
          );
          const transitionStepId =
            traceStoreRef.current.startStep(
              traceId,
              "Source-owned task transition",
              formatSourceOwnedTransitionForTrace(
                sourceOwnedTransitionResult,
                {
                  committedBeforeModel:
                    sourceOwnedTransitionResult.candidate
                      .state === "committed",
                }
              )
            );
          traceStoreRef.current.finishStep(
            traceId,
            transitionStepId,
            sourceOwnedTransitionResult.candidate.state ===
              "committed"
              ? "success"
              : "error",
            undefined,
            sourceOwnedTransitionResult.candidate
              .rejectionReason
          );
        }

        if (
          sourceOwnedTransitionResult.candidate.state ===
          "committed"
        ) {
          contextManagerRef.current.setActiveMeetingTaskState({
            activeScreenTask:
              transitionContextBefore.activeScreenTask,
            activeInterviewTask:
              sourceOwnedTransitionResult.task ?? null,
          });
          recordCommittedPlaybookPhaseTransition({
            operationId:
              sourceOwnedTransitionResult.candidate.id,
            source: "automatic",
            before: transitionParentBefore,
            after: sourceOwnedTransitionResult.task,
            traceId,
          });
          const transitionContextAfter =
            contextManagerRef.current.buildAdvisorPromptContext();
          promptContext = {
            ...promptContext,
            activeScreenTask:
              transitionContextAfter.activeScreenTask,
            activeInterviewTask:
              transitionContextAfter.activeInterviewTask,
            activeMeetingTask:
              transitionContextAfter.activeMeetingTask,
            interviewPlaybook:
              transitionContextAfter.interviewPlaybook,
          };
          activeMeetingTaskId =
            getAdvisorActiveTaskId(promptContext);
          effectiveRuntimeCommitToken =
            rebaseRuntimeCommitToken({
              token: effectiveRuntimeCommitToken,
              snapshot: readRuntimeCommitSnapshot(),
            });
          const committedContext =
            contextManagerRef.current.getState();
          setState((previous) => ({
            ...previous,
            activeScreenTask:
              committedContext.activeScreenTask,
            activeInterviewTask:
              committedContext.activeInterviewTask,
            activeMeetingTask:
              committedContext.activeMeetingTask,
          }));
          if (traceId && committedContext.activeMeetingTask) {
            traceStoreRef.current.updateMetadata(traceId, {
              runtimeCommitTokenRebased: true,
              runtimeCommitTokenRebaseReason:
                "source-owned-transition-committed-before-advisor",
              ...getActiveMeetingTaskTraceMetadata(
                committedContext.activeMeetingTask
              ),
            });
            sessionRecordingManagerRef.current?.recordActiveMeetingTaskSnapshot(
              committedContext.activeMeetingTask,
              traceId
            );
          }
        }
      }
    }
    const sourceOwnedTransitionCommittedBeforeAdvisor =
      sourceOwnedTransitionResult?.candidate.state ===
      "committed";
    refreshAdvisorEvidencePacket();
    if (traceId) {
      const evidencePacketMetadata =
        formatAdvisorEvidencePacketForTrace(
          advisorEvidencePacket,
          advisorRetrievalQuery
        );
      const evidencePacketStepId =
        traceStoreRef.current.startStep(
          traceId,
          "Advisor evidence packet built",
          evidencePacketMetadata
        );
      traceStoreRef.current.finishStep(
        traceId,
        evidencePacketStepId,
        "success"
      );
    }

    const responseOwner = resolveMeetingResponseOwner({
      preBoundaryType: preBoundaryResponseOwnerType,
      postBoundaryParentType: getAdvisorActiveQuestionType(promptContext),
      proposedQuestionType: advisorQuestionType,
      relation: advisorTaskSignals.taskRelation,
      taskBoundaryCommitted: taskBoundaryCommittedBeforeAdvisor,
      childOwnsResponse:
        advisorTaskSignals.taskRelation === "child-probe" &&
        taskMutationAuthorization.authorized &&
        sourceOwnedTransitionCommittedBeforeAdvisor,
    });
    const advisorUsesCodingModel =
      responseOwner.questionType === "coding";
    const advisorModelRoute = resolveMeetingModelRoute({
      useCodingModel: advisorUsesCodingModel,
      reason: advisorUsesCodingModel
        ? `response-owner-${responseOwner.source}-coding`
        : `response-owner-${responseOwner.source}-main`,
    });
    const responseOwnerMetadata =
      formatMeetingResponseOwnerForTrace(responseOwner);
    const advisorModelRouteMetadata =
      formatMeetingModelRouteForTrace(advisorModelRoute);
    const advisorModelRequestOptions =
      getMeetingModelRequestOptions(advisorModelRoute);
    if (traceId) {
      traceStoreRef.current.updateMetadata(traceId, {
        ...responseOwnerMetadata,
        ...advisorModelRouteMetadata,
        modelRequestOptions: advisorModelRequestOptions,
      });
    }

    if (!advisorModelRoute.provider) {
      const boundaryErrorMetadata = formatTaskBoundaryCandidateForTrace(
        taskBoundaryCandidate,
        {
          committedBeforeAdvisor: taskBoundaryCommittedBeforeAdvisor,
          survivedAdvisorCancellation: taskBoundarySurvivesAdvisorOutcome(
            taskBoundaryCandidate,
            "error"
          ),
        }
      );
      releaseAdvisorJob(advisorJob, "error", {
        commitAuthorized: false,
        commitAuthorizationReason: "missing-ai-provider",
      });
      if (traceId) {
        traceStoreRef.current.updateMetadata(traceId, {
          ...boundaryErrorMetadata,
          ...formatSourceOwnedTransitionForTrace(
            sourceOwnedTransitionResult,
            {
              committedBeforeModel:
                sourceOwnedTransitionCommittedBeforeAdvisor,
              modelOutcome: "error",
              survivedModelOutcome:
                sourceOwnedTransitionSurvivesModelOutcome(
                  sourceOwnedTransitionResult,
                  "error"
                ),
            }
          ),
        });
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

    const advisorCurrentQuestionEvidenceText =
      advisorEvidencePacket.currentQuestion?.text ?? "";
    const advisorDiagramDomainContext = buildCurrentTaskDiagramDomainContext({
      currentQuestion: advisorCurrentQuestionEvidenceText || undefined,
      parentTopic:
        promptContext.activeMeetingTask?.parent.topic ??
        promptContext.activeInterviewTask?.topic,
      relation: advisorTaskSignals.taskRelation,
    });
    const advisorPersonalEvidenceDecision = detectPersonalEvidenceRequirement({
      questionText: advisorCurrentQuestionEvidenceText,
      questionType: advisorQuestionType,
      mode: state.settings.personalEvidenceGuardrailMode,
    });
    const memoryContext = await loadMemoryForPrompt({
      traceId,
      taskId: activeMeetingTaskId,
      source: "advisor",
      query: advisorRetrievalQuery,
      currentQuestionEvidenceText:
        advisorCurrentQuestionEvidenceText,
      diagramDomainContext: advisorDiagramDomainContext,
      diagramTopicDomain: advisorTopicDomain,
      useCase: inferMemoryUseCaseFromQuery(
        advisorCurrentQuestionEvidenceText
      ),
      questionType: advisorQuestionType,
      askFrame: advisorAskFrame,
      topicDomain: advisorTopicDomain,
      projectAnchor: advisorProjectAnchor,
      memoryPolicy: advisorRuntimePlaybook?.memoryPolicy,
      personalEvidenceDecision: advisorPersonalEvidenceDecision,
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
      questionText: advisorCurrentQuestionEvidenceText,
      personalEvidenceGuardrailMode:
        state.settings.personalEvidenceGuardrailMode,
      memoryContext,
      confirmedMeFacts: promptContext.confirmedMeFacts,
      activeFactAnchors:
        promptContext.activeMeetingTask?.parent.supportedFactAnchors ??
        promptContext.activeInterviewTask?.supportedFactAnchors,
      projectAnchor: advisorProjectAnchor,
      personalEvidenceDecision: advisorPersonalEvidenceDecision,
      projectBindingDecision,
    });
    const holdAdvisorPartialForFactAnchor =
      factAnchorDecision.requiredFor !== "none";
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
        factAnchorPartialOutputHeld: holdAdvisorPartialForFactAnchor,
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

    let finalContent = "";
    let advisorModelPromptText = "";

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
                const modelRequestStartedAt = Date.now();
                advisorModelPromptText = formatTraceModelInput(
                  input.systemPrompt,
                  input.userMessage
                );
                const advisorPromptIncludedLogicalQuestion =
                  doesAdvisorPromptContainLogicalQuestion(
                    input.userMessage,
                    advisorJob.logicalQuestionUnit
                  );
                traceStoreRef.current.updateMetadata(traceId, {
                  advisorPromptIncludedLogicalQuestion,
                  advisorPromptLogicalQuestionSourceCount:
                    advisorJob.logicalQuestionUnit?.sources.length,
                  ...formatSourceOwnedTransitionForTrace(
                    sourceOwnedTransitionResult,
                    {
                      committedBeforeModel:
                        sourceOwnedTransitionCommittedBeforeAdvisor,
                      modelRequestStartedAt,
                    }
                  ),
                });
                traceStoreRef.current.recordInput(
                  traceId,
                  "advisor model input",
                  advisorModelPromptText,
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
                  value: advisorModelPromptText,
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
        if (
          outputCommitAuthorization.authorized &&
          !holdAdvisorPartialForFactAnchor
        ) {
          setState((previous) => ({
            ...previous,
            partialSuggestion: event.accumulated,
          }));
        }
      }

      if (mode === "response-action") {
        finalContent = preserveCodingResponseActionSections(
          finalContent,
          options.currentSuggestion
        );
      }

      const finalCommitDecision = readCommitDecision();
      if (rejectStaleCommit("final-commit", finalCommitDecision)) return;

      let parsedMeetingAnswer = parseMeetingAnswer(finalContent, {
        expectedProfile: advisorAnswerProfile,
      });
      const factAnchorOutputDecision = enforceFactAnchorOutput({
        decision: factAnchorDecision,
        parsedAnswer: parsedMeetingAnswer,
        expectedProfile: advisorAnswerProfile,
      });
      finalContent = factAnchorOutputDecision.effectiveContent;
      parsedMeetingAnswer = factAnchorOutputDecision.effectiveAnswer;
      const factAnchorOutputMetadata =
        formatFactAnchorOutputDecisionForTrace(factAnchorOutputDecision, {
          partialOutputHeld: holdAdvisorPartialForFactAnchor,
        });
      if (traceId) {
        traceStoreRef.current.updateMetadata(
          traceId,
          factAnchorOutputMetadata
        );
        const factAnchorOutputStepId = traceStoreRef.current.startStep(
          traceId,
          "Fact anchor output authorization",
          factAnchorOutputMetadata
        );
        traceStoreRef.current.finishStep(
          traceId,
          factAnchorOutputStepId,
          "success"
        );
        sessionRecordingManagerRef.current?.recordFactAnchorDecision(
          traceId,
          {
            source: "advisor-output",
            questionType: advisorQuestionType,
            ...factAnchorOutputMetadata,
          },
          activeMeetingTaskId
        );
      }
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

      if (!outputCommitAuthorization.authorized) {
        const outputSuppressedMetadata = {
          advisorOutputDisposition: "output-commit-not-authorized",
          advisorOutputCommittedToUi: false,
          advisorOutputCommitAuthorized: false,
          advisorOutputCommitReason: outputCommitAuthorization.reason,
          taskMutationAuthorized: taskMutationAuthorization.authorized,
          taskMutationAuthorizationReason:
            taskMutationAuthorization.reason,
        };
        if (traceId) {
          traceStoreRef.current.updateMetadata(
            traceId,
            outputSuppressedMetadata
          );
        }
        setState((previous) => ({
          ...previous,
          status: activeRef.current
            ? "listening"
            : returnStatus === "paused"
              ? "paused"
              : "idle",
          partialSuggestion: "",
        }));
        releaseAdvisorJob(advisorJob, "suppressed", {
          commitAuthorized: false,
          commitAuthorizationReason: outputCommitAuthorization.reason,
        });
        if (traceId) {
          traceStoreRef.current.finishStep(traceId, advisorStepId, "success", {
            outputChars: finalContent.length,
            ...advisorModelRouteMetadata,
            ...meetingAnswerMetadata,
            ...outputSuppressedMetadata,
          });
          traceStoreRef.current.finishTrace(traceId, "success");
        }
        return;
      }

      if (traceId && advisorJob.logicalQuestionUnit) {
        const sufficiencyMeetingContext =
          contextManagerRef.current.getState();
        const canonicalAdvisorQuestionType =
          normalizeCanonicalQuestionType(advisorQuestionType) ?? "unknown";
        const answerQuestionId =
          questionLineage?.questionInstanceId ??
          advisorJob.logicalQuestionUnit.id;
        const answerRevision =
          (answerRevisionByQuestionRef.current.get(answerQuestionId) ?? 0) + 1;
        answerRevisionByQuestionRef.current.set(
          answerQuestionId,
          answerRevision
        );
        const answerSufficiencyDecision =
          evaluateRuntimeAnswerSufficiencyShadow({
            traceId,
            questionId: answerQuestionId,
            logicalQuestionUnit: advisorJob.logicalQuestionUnit,
            answerRevision,
            questionType: canonicalAdvisorQuestionType,
            answerProfile: advisorAnswerProfile,
            parsedAnswer: parsedMeetingAnswer,
            factAnchorRequired: factAnchorDecision.requiredFor !== "none",
            factAnchorAvailable: factAnchorDecision.state !== "no-anchor",
            currentTurnAction: mapAdvisorTurnActionToSufficiencyAction(
              inferredTurnIntentDecision?.action
            ),
            relation: advisorTaskSignals.taskRelation,
            meetingContext: sufficiencyMeetingContext,
            basePromptContext: promptContext,
            originalModelPromptText: advisorModelPromptText,
          });
        traceStoreRef.current.updateMetadata(
          traceId,
          formatAnswerSufficiencyDecisionForTrace(
            answerSufficiencyDecision
          )
        );
        sessionRecordingManagerRef.current?.recordAnswerSufficiencyDecision({
          traceId,
          taskId: activeMeetingTaskId,
          decision: answerSufficiencyDecision,
        });
        scheduleAnswerSufficiencySemanticShadow({
          traceId,
          taskId: activeMeetingTaskId,
          questionText: advisorJob.logicalQuestionUnit.normalizedText,
          parsedAnswer: parsedMeetingAnswer,
          decision: answerSufficiencyDecision,
        });
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
        advisorTaskSignals.openingRoute?.commitParent !== false &&
        (advisorTaskSignals.taskRelation !== "new-parent" ||
          taskBoundaryCommittedBeforeAdvisor) &&
        (!sourceOwnedTransitionResult ||
          sourceOwnedTransitionCommittedBeforeAdvisor);
      const continuityRelation: InterviewTaskRelation =
        taskBoundaryCommittedBeforeAdvisor
          ? "followup-parent"
          : advisorTaskSignals.taskRelation;
      const outputPhaseDecision =
        taskBoundaryCommittedBeforeAdvisor ||
        sourceOwnedTransitionCommittedBeforeAdvisor ||
        manualPhaseAdvanceCommitted
          ? undefined
          : playbookPhaseDecision;
      const artifactAuthorization = authorizeResponseArtifactMutation({
        parentTaskId: existingInterviewTask?.id,
        parentQuestionType:
          existingInterviewTask?.stableKind ??
          (continuityRelation === "new-parent"
            ? responseOwner.questionType
            : undefined),
        responseOwnerQuestionType: responseOwner.questionType,
        responseOwnerSource: responseOwner.source,
        relation: continuityRelation,
        creatingParent:
          !existingInterviewTask &&
          shouldCommitAdvisorParent &&
          continuityRelation === "new-parent",
      });
      const continuity = shouldCommitAdvisorParent
        ? updateInterviewTaskContinuityForAnswer({
            existingTask: existingInterviewTask,
            source: advisorEvidenceSource,
            questionType:
              continuityRelation === "followup-parent" &&
              existingInterviewTask
                ? existingInterviewTask.stableKind
                : advisorQuestionType,
            relation: continuityRelation,
            subtaskIntent: advisorTaskSignals.subtaskIntent,
            question:
              advisorEvidenceSource === "screen"
                ? promptContext.activeScreenTask?.question ?? latestTurn?.text
                : advisorJob.logicalQuestionUnit?.normalizedText ?? latestTurn?.text,
            questionInstanceId: questionLineage?.questionInstanceId,
            canonicalQuestionSourceTurnIds:
              advisorJob.logicalQuestionUnit?.sourceTurnIds,
            finalContent,
            parsedAnswer: parsedMeetingAnswer,
            playbook: advisorRuntimePlaybook,
            phaseDecision: outputPhaseDecision,
            sourceTransitionPrecommitted:
              sourceOwnedTransitionCommittedBeforeAdvisor,
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
            artifactAuthorization,
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
        ...formatResponseArtifactAuthorizationForTrace(artifactAuthorization),
        answerCodeArtifactDecision: parsedMeetingAnswer.sections.code
          ? artifactAuthorization.allowCode
            ? "produced"
            : "ignored"
          : "none",
        answerWhiteboardArtifactDecision: whiteboardArtifactDecision,
      };
      if (traceId) {
        traceStoreRef.current.updateMetadata(traceId, answerArtifactMetadata);
      }
      let nextActiveScreenTask = promptContext.activeScreenTask;

      if (
        taskMutationAuthorization.authorized &&
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

      if (taskMutationAuthorization.authorized) {
        if (
          !taskBoundaryCommittedBeforeAdvisor &&
          !sourceOwnedTransitionCommittedBeforeAdvisor &&
          !manualPhaseAdvanceCommitted
        ) {
          recordCommittedPlaybookPhaseTransition({
            operationId: `phase-auto-${advisorJob.id}`,
            source: "automatic",
            before: existingInterviewTask,
            after: continuity.task,
            traceId,
          });
        }
        contextManagerRef.current.setActiveMeetingTaskState({
          activeScreenTask: nextActiveScreenTask,
          activeInterviewTask: continuity.task ?? null,
        });
      }
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
          ...formatTaskBoundaryCandidateForTrace(taskBoundaryCandidate, {
            committedBeforeAdvisor: taskBoundaryCommittedBeforeAdvisor,
            parentBeforeId:
              originalPromptContext.activeMeetingTask?.parent.id ??
              originalPromptContext.activeInterviewTask?.id,
            parentBeforeType:
              originalPromptContext.activeMeetingTask?.parent.questionType ??
              originalPromptContext.activeInterviewTask?.stableKind,
            parentAfterId: contextState.activeMeetingTask?.parent.id,
            parentAfterType:
              contextState.activeMeetingTask?.parent.questionType,
            survivedAdvisorCancellation:
              !finalContent.trim() &&
              taskBoundarySurvivesAdvisorOutcome(
                taskBoundaryCandidate,
                "empty-output"
              ),
          }),
          ...formatSourceOwnedTransitionForTrace(
            sourceOwnedTransitionResult,
            {
              committedBeforeModel:
                sourceOwnedTransitionCommittedBeforeAdvisor,
              modelOutcome: finalContent.trim()
                ? "success"
                : "empty-output",
              survivedModelOutcome:
                !finalContent.trim() &&
                sourceOwnedTransitionSurvivesModelOutcome(
                  sourceOwnedTransitionResult,
                  "empty-output"
                ),
            }
          ),
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
          startedNewInterviewParent:
            continuity.startedNewParent || taskBoundaryCommittedBeforeAdvisor,
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
        codeArtifactMutationAuthorized: artifactAuthorization.allowCode,
        whiteboardArtifactMutationAuthorized:
          artifactAuthorization.allowWhiteboard,
        sourceTraceId: traceId,
      };
      const committedQuestionLineage =
        nextSuggestion.kind === "silent"
          ? undefined
          : attachQuestionLineageToSuggestion(
              contextState.activeMeetingTask
                ? promoteQuestionLineage(questionLineage)
                : questionLineage,
              nextSuggestion
            );
      nextSuggestion.questionLineage = committedQuestionLineage;
      if (
        committedQuestionLineage &&
        adjacentQuestionScopeRef.current?.lineage.questionInstanceId ===
          committedQuestionLineage.questionInstanceId
      ) {
        adjacentQuestionScopeRef.current = null;
      }
      currentQuestionLineageRef.current = committedQuestionLineage;
      if (traceId) {
        traceStoreRef.current.updateMetadata(
          traceId,
          formatQuestionLineageForTrace(committedQuestionLineage)
        );
      }

      setState((previous) => ({
        ...previous,
        ...withLatestReliableSuggestion(previous, nextSuggestion, {
          clearPrevious:
            continuity.startedNewParent || taskBoundaryCommittedBeforeAdvisor,
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
        currentQuestionLineage: committedQuestionLineage,
      }));
      const outputCommitMetadata = {
        advisorOutputDisposition:
          inferredTurnIntentDecision?.enforcement === "shadow"
            ? "shadow-visible"
            : "committed",
        advisorOutputCommittedToUi: true,
        visibleAnswerChanged:
          nextSuggestion.kind !== "silent" &&
          nextSuggestion.content.trim() !==
            (state.latestSuggestion?.content.trim() ?? ""),
        advisorOutputCommitAuthorized: true,
        advisorOutputCommitReason: outputCommitAuthorization.reason,
        taskMutationAuthorized: taskMutationAuthorization.authorized,
        taskMutationAuthorizationReason: taskMutationAuthorization.reason,
      };
      if (traceId) {
        traceStoreRef.current.updateMetadata(traceId, outputCommitMetadata);
      }
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
          ...outputCommitMetadata,
        });
        traceStoreRef.current.finishTrace(traceId, "success");
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        const commitDecision = readCommitDecision();
        const boundaryErrorMetadata = formatTaskBoundaryCandidateForTrace(
          taskBoundaryCandidate,
          {
            committedBeforeAdvisor: taskBoundaryCommittedBeforeAdvisor,
            survivedAdvisorCancellation: taskBoundarySurvivesAdvisorOutcome(
              taskBoundaryCandidate,
              "cancelled"
            ),
          }
        );
        finishRunningAdvisorJobTrace(
          advisorJob,
          "cancelled",
          {
            ...formatAdvisorTriggerJobForTrace(advisorJob, "error", {
              cancellationReason: "provider-request-aborted",
              commitAuthorized: false,
              commitAuthorizationReason: commitDecision.reason,
            }),
            ...boundaryErrorMetadata,
            ...formatSourceOwnedTransitionForTrace(
              sourceOwnedTransitionResult,
              {
                committedBeforeModel:
                  sourceOwnedTransitionCommittedBeforeAdvisor,
                modelOutcome: "cancelled",
                survivedModelOutcome:
                  sourceOwnedTransitionSurvivesModelOutcome(
                    sourceOwnedTransitionResult,
                    "cancelled"
                  ),
              }
            ),
          },
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
      const boundaryErrorMetadata = formatTaskBoundaryCandidateForTrace(
        taskBoundaryCandidate,
        {
          committedBeforeAdvisor: taskBoundaryCommittedBeforeAdvisor,
          survivedAdvisorCancellation: taskBoundarySurvivesAdvisorOutcome(
            taskBoundaryCandidate,
            "error"
          ),
        }
      );
      finishRunningAdvisorJobTrace(
        advisorJob,
        "error",
        {
          ...formatAdvisorTriggerJobForTrace(advisorJob, "error", {
            commitAuthorized: false,
            commitAuthorizationReason: commitDecision.reason,
          }),
          ...boundaryErrorMetadata,
          ...formatSourceOwnedTransitionForTrace(
            sourceOwnedTransitionResult,
            {
              committedBeforeModel:
                sourceOwnedTransitionCommittedBeforeAdvisor,
              modelOutcome: "error",
              survivedModelOutcome:
                sourceOwnedTransitionSurvivesModelOutcome(
                  sourceOwnedTransitionResult,
                  "error"
                ),
            }
          ),
        },
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
    recordCommittedPlaybookPhaseTransition,
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
    triggerTurnId?: string,
    questionLineage?: QuestionInstanceLineage,
    logicalQuestionUnit?: LogicalQuestionUnit
  ) => {
    if (!activeRef.current) return;

    const advisorJob = buildAdvisorJob({
      mode,
      traceId,
      turnIntentDecision,
      triggerTurnId,
      advisorJobSource: "live-turn",
      taskMutationAuthority: "input-evidence",
      questionLineage:
        questionLineage ??
        resolveInheritedQuestionLineageForTurnIntent(
          turnIntentDecision,
          currentQuestionLineageRef.current
        ),
      logicalQuestionUnit,
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
        logicalQuestionUnit,
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
      traceStoreRef.current.updateMetadata(traceId, {
        acceptedSpeechDisposition: "transcript-appended",
        transcriptAppendDisposition: "transcript-appended",
        transcriptAppendReason:
          typeof metadata.transcriptAppendReason === "string"
            ? metadata.transcriptAppendReason
            : "accepted-source-turn",
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
        hasRecentQuestionContext: Boolean(currentQuestionLineageRef.current),
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
        hasRecentQuestionContext: Boolean(currentQuestionLineageRef.current),
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

  const scheduleTaxonomyAdjudicationShadow = useCallback(
    ({
      turn,
      traceId,
      turnGateAction,
      logicalQuestionUnit,
      lexical,
      semantic,
      hybrid,
    }: {
      turn: TranscriptTurn;
      traceId: string;
      turnGateAction: string;
      logicalQuestionUnit?: LogicalQuestionUnit;
      lexical: QuestionTypeInferenceDecision;
      semantic?: SemanticTaxonomyDecision;
      hybrid?: HybridQuestionTypeDecision;
    }) => {
      if (!logicalQuestionUnit) return;
      const contextState = contextManagerRef.current.getState();
      const settings = taxonomyAdjudicationSettingsRef.current;
      const evaluationActive =
        debugModeRef.current ||
        Boolean(sessionRecordingManagerRef.current?.getState().active);
      const projection = projectLogicalQuestionForAdjudication(
        logicalQuestionUnit
      );
      const activeParentQuestionType = normalizeCanonicalQuestionType(
        contextState.activeMeetingTask?.parent.questionType
      );
      const scheduledTaskId = contextState.activeMeetingTask?.id;
      const eligibility = decideTaxonomyAdjudicationEligibility({
        enabled: settings.enabled,
        evaluationActive,
        speaker: turn.speaker,
        turnGateAction,
        projection,
        lexical,
        semantic,
        hybrid,
        activeParentType: activeParentQuestionType,
        manualCorrectionActive: Boolean(
          manualCorrectionOperationCoordinatorRef.current.getActiveOperationId()
        ),
      });
      const circuitState =
        taxonomyAdjudicationCircuitBreakerRef.current.read(
          contextState.sessionId
        );
      const baseMetadata: Record<string, unknown> = {
        taxonomyAdjudicationMode: "shadow",
        interviewerIntentLlmMode: "shadow",
        taxonomyAdjudicationEligible: eligibility.eligible,
        interviewerIntentLlmEligible: eligibility.eligible,
        taxonomyAdjudicationSkipReason: eligibility.eligible
          ? undefined
          : eligibility.reason,
        interviewerIntentLlmSkipReason: eligibility.eligible
          ? undefined
          : eligibility.reason,
        taxonomyAdjudicationTriggerReasons: eligibility.triggerReasons,
        interviewerIntentLlmTriggerReasons: eligibility.triggerReasons,
        interviewerIntentLlmDisposition: eligibility.eligible
          ? "eligible"
          : "not-eligible",
        taxonomyAdjudicationUnitId: logicalQuestionUnit.id,
        interviewerIntentLlmUnitId: logicalQuestionUnit.id,
        taxonomyAdjudicationUnitRevision: logicalQuestionUnit.revision,
        interviewerIntentLlmUnitRevision: logicalQuestionUnit.revision,
        taxonomyAdjudicationInputChars: projection.projectedChars,
        interviewerIntentLlmInputChars: projection.projectedChars,
        taxonomyAdjudicationOriginalChars: projection.originalChars,
        taxonomyAdjudicationProjectionReason: projection.projectionReason,
        taxonomyAdjudicationProjectionSafe: projection.safe,
        taxonomyAdjudicationOmittedSourceTurnIds:
          projection.omittedSourceTurnIds,
        taxonomyAdjudicationBehaviorMutationBlocked: true,
        interviewerIntentLlmBehaviorMutationBlocked: true,
        taxonomyAdjudicationRepairApplied: false,
        interviewerIntentLlmRepairApplied: false,
        ...formatTaxonomyAdjudicationCircuitForTrace(circuitState),
      };
      traceStoreRef.current.updateMetadata(traceId, baseMetadata);
      if (!eligibility.eligible) {
        sessionRecordingManagerRef.current?.recordTaxonomyAdjudicationDecision({
          traceId,
          taskId: contextState.activeMeetingTask?.id,
          metadata: baseMetadata,
        });
        return;
      }
      if (circuitState.open) {
        const metadata = {
          ...baseMetadata,
          taxonomyAdjudicationSkipReason: "provider-circuit-open",
          taxonomyAdjudicationDisposition: "provider-circuit-open",
          interviewerIntentLlmSkipReason: "provider-circuit-open",
          interviewerIntentLlmDisposition: "provider-circuit-open",
        };
        traceStoreRef.current.updateMetadata(traceId, metadata);
        sessionRecordingManagerRef.current?.recordTaxonomyAdjudicationDecision({
          traceId,
          taskId: contextState.activeMeetingTask?.id,
          metadata,
        });
        return;
      }

      const modelRoute = resolveTaxonomyAdjudicationModelRouteFromSnapshot({
        snapshot: meetingModelProviderSnapshotRef.current,
      });
      const routeMetadata =
        formatTaxonomyAdjudicationModelRouteForTrace(modelRoute);
      const taxonomyAdjudicationModelId =
        readSelectedProviderModelId(modelRoute.selectedProvider);
      if (!modelRoute.provider) {
        const circuit = taxonomyAdjudicationCircuitBreakerRef.current.open({
          sessionId: contextState.sessionId,
          reason: "provider-configuration-error",
          detail:
            modelRoute.missingRequiredVariables.length > 0
              ? `missing:${modelRoute.missingRequiredVariables.join(",")}`
              : modelRoute.fallbackReason,
        });
        const metadata = {
          ...baseMetadata,
          ...routeMetadata,
          ...formatTaxonomyAdjudicationCircuitForTrace(
            circuit.state,
            circuit.newlyOpened
          ),
          taxonomyAdjudicationSkipReason: "provider-configuration-error",
          taxonomyAdjudicationDisposition: "provider-configuration-error",
          interviewerIntentLlmSkipReason: "provider-configuration-error",
          interviewerIntentLlmDisposition: "provider-configuration-error",
        };
        traceStoreRef.current.updateMetadata(traceId, metadata);
        sessionRecordingManagerRef.current?.recordTaxonomyAdjudicationDecision({
          traceId,
          taskId: contextState.activeMeetingTask?.id,
          metadata,
        });
        return;
      }

      const activeParent = contextState.activeMeetingTask?.parent;
      const activeRelation = contextState.activeMeetingTask?.child
        ? "child-probe"
        : activeParent
          ? "followup-parent"
          : "unknown";
      const localRelation = contextState.activeMeetingTask?.child
        ? ("child-probe" as const)
        : activeParent
          ? ("followup-parent" as const)
          : turnGateAction === "answer-refresh"
            ? ("new-parent" as const)
            : ("none" as const);
      const baselineType =
        hybrid?.effectiveType ?? lexical.type ?? "unknown";
      const localIntentBaseline = buildLocalInterviewerIntentBaseline({
        questionType: baselineType,
        relation: localRelation,
        turnGateAction,
        primaryAskProjection: logicalQuestionUnit.primaryAskProjection,
      });
      const taskBoundaryEpoch = hashTaxonomyTaskBoundary({
        parentId: activeParent?.id,
        questionType: activeParentQuestionType,
        relation: activeRelation,
      });
      const lease = createTaxonomyAdjudicationLease({
        sessionId: contextState.sessionId,
        runtimeEpoch: runtimeEpochRef.current,
        logicalQuestionUnit,
        taskBoundaryEpoch,
        manualCorrectionRevision: manualCorrectionRevisionRef.current,
        expectedParentId: activeParent?.id,
        expectedParentRevision: activeParent?.revisions,
      });
      const request = buildTaxonomyAdjudicationRequest({
        logicalQuestionUnit,
        activeParent: activeParent
          ? {
              idHash: hashTaxonomySourceTurnIds([activeParent.id]),
              revision: activeParent.revisions,
              questionType: activeParentQuestionType,
              topic: activeParent.topic,
              playbookPhase: activeParent.playbookPhase,
              sharedScenarioEntities:
                activeParent.parentContextHandoff?.sharedScenarioContext
                  .domainEntities,
            }
          : undefined,
        latestMeCorrection: selectLatestMeAdjudicationContext(
          contextState.transcriptTurns,
          turn.startedAt
        ),
        sectionHint: logicalQuestionUnit.sectionHint
          ? `${logicalQuestionUnit.sectionHint.questionType}:${logicalQuestionUnit.sectionHint.source}`
          : undefined,
        preparationPrior: buildTaxonomyPreparationPrior(
          contextState.interviewSessionBrief
        ),
        taskSwitchEvidence: [
          logicalQuestionUnit.boundaryReason,
          ...logicalQuestionUnit.compositionReasons,
          ...(logicalQuestionUnit.sectionHint
            ? [
                `section-hint:${logicalQuestionUnit.sectionHint.questionType}`,
                `section-hint-source:${logicalQuestionUnit.sectionHint.source}`,
              ]
            : []),
        ],
      });
      const adjudicationPrompts = buildTaxonomyAdjudicationPrompts(request);
      const adjudicationPromptText = [
        adjudicationPrompts.systemPrompt,
        adjudicationPrompts.userMessage,
      ].join("\n\n");
      const adjudicationRequestHash = hashTaxonomySourceTurnIds([
        adjudicationPrompts.systemPrompt,
        adjudicationPrompts.userMessage,
      ]);
      const scheduledMetadata = {
        ...baseMetadata,
        ...routeMetadata,
        taxonomyAdjudicationPromptVersion: request.promptVersion,
        interviewerIntentLlmPromptVersion: request.promptVersion,
        taxonomyAdjudicationSchemaVersion: request.schemaVersion,
        interviewerIntentLlmSchemaVersion: request.schemaVersion,
        taxonomyAdjudicationRequestHash: adjudicationRequestHash,
        interviewerIntentLlmRequestHash: adjudicationRequestHash,
        taxonomyAdjudicationInputChars: adjudicationPromptText.length,
        interviewerIntentLlmInputChars: adjudicationPromptText.length,
        taxonomyAdjudicationScheduledTaskId: scheduledTaskId,
        interviewerIntentLlmScheduledTaskId: scheduledTaskId,
        interviewerIntentLlmProviderId: modelRoute.resolvedProviderId,
        interviewerIntentLlmLocalSpeechAct: localIntentBaseline.speechAct,
        interviewerIntentLlmLocalQuestionType:
          localIntentBaseline.questionType,
        interviewerIntentLlmLocalRelation: localIntentBaseline.relation,
        interviewerIntentLlmLocalEvidenceMode:
          localIntentBaseline.evidenceMode,
        interviewerIntentLlmLocalAction: localIntentBaseline.action,
        interviewerIntentLlmLocalPrimaryAsk:
          localIntentBaseline.normalizedPrimaryAsk,
        taxonomyAdjudicationOperationId: lease.operationId,
        taxonomyAdjudicationSourceTurnIdsHash: lease.sourceTurnIdsHash,
        taxonomyAdjudicationTaskBoundaryEpoch: lease.taskBoundaryEpoch,
        taxonomyAdjudicationManualCorrectionRevision:
          lease.manualCorrectionRevision,
        taxonomyAdjudicationExpectedParentId: lease.expectedParentId,
        taxonomyAdjudicationExpectedParentRevision:
          lease.expectedParentRevision,
        interviewerIntentLlmOperationId: lease.operationId,
        interviewerIntentLlmExpectedParentId: lease.expectedParentId,
        interviewerIntentLlmExpectedParentRevision:
          lease.expectedParentRevision,
        taxonomyAdjudicationModelId,
        interviewerIntentLlmModelId: taxonomyAdjudicationModelId,
        taxonomyAdjudicationDisposition: "scheduled",
        interviewerIntentLlmDisposition: "scheduled",
      };
      traceStoreRef.current.updateMetadata(traceId, scheduledMetadata);
      traceStoreRef.current.recordInput(
        traceId,
        "taxonomy adjudication model input",
        adjudicationPromptText,
        {
          promptVersion: request.promptVersion,
          schemaVersion: request.schemaVersion,
          requestHash: adjudicationRequestHash,
          inputChars: adjudicationPromptText.length,
          candidateEvidenceExcluded: true,
        }
      );
      sessionRecordingManagerRef.current?.recordModelInput({
        traceId,
        taskId: scheduledTaskId,
        label: "taxonomy adjudication model input",
        value: adjudicationPromptText,
        metadata: {
          promptVersion: request.promptVersion,
          schemaVersion: request.schemaVersion,
          requestHash: adjudicationRequestHash,
          inputChars: adjudicationPromptText.length,
          candidateEvidenceExcluded: true,
        },
      });

      let stepId: string | undefined;
      taxonomyAdjudicationRuntimeRef.current!.schedule({
        job: {
          traceId,
          lease,
          request,
          triggerReasons: eligibility.triggerReasons,
        },
        execute: async (job, signal) =>
          requestTaxonomyAdjudication({
            request: job.request,
            provider: modelRoute.provider,
            selectedProvider: modelRoute.selectedProvider,
            signal,
            onFirstToken: (at) => {
              traceStoreRef.current.updateMetadata(traceId, {
                taxonomyAdjudicationFirstTokenAt: at,
                interviewerIntentLlmFirstTokenAt: at,
              });
            },
          }),
        onStarted: (_job, startedAt) => {
          stepId = traceStoreRef.current.startStep(
            traceId,
            "LLM interviewer intent adjudication shadow",
            {
              ...scheduledMetadata,
              taxonomyAdjudicationRequestStartedAt: startedAt,
              interviewerIntentLlmRequestStartedAt: startedAt,
              taxonomyAdjudicationRequestProfile:
                "json-only-256-tokens-4s",
            }
          );
        },
        onSettled: (settlement) => {
          const latestContext = contextManagerRef.current.getState();
          const latestParent = latestContext.activeMeetingTask?.parent;
          const latestParentQuestionType = normalizeCanonicalQuestionType(
            latestParent?.questionType
          );
          const latestRelation = latestContext.activeMeetingTask?.child
            ? "child-probe"
            : latestParent
              ? "followup-parent"
              : "unknown";
          const authorization = authorizeTaxonomyAdjudicationLease(
            settlement.job.lease,
            {
              currentOperationId:
                taxonomyAdjudicationRuntimeRef.current?.getCurrentOperationId(),
              sessionId: latestContext.sessionId,
              runtimeEpoch: runtimeEpochRef.current,
              logicalQuestionUnit: logicalQuestionUnitRef.current,
              taskBoundaryEpoch: hashTaxonomyTaskBoundary({
                parentId: latestParent?.id,
                questionType: latestParentQuestionType,
                relation: latestRelation,
              }),
              manualCorrectionRevision: manualCorrectionRevisionRef.current,
              activeParentId: latestParent?.id,
              activeParentRevision: latestParent?.revisions,
              logicalUnitClosed: false,
              selfHealingBudgetConsumed: false,
            }
          );
          const parsed = settlement.result?.parsed;
          const parsedValue = parsed?.ok ? parsed.value : undefined;
          const trace = traceStoreRef.current
            .getTraces()
            .find((candidate) => candidate.id === traceId);
          const firstVisibleTokenAt =
            readNumberFromTraceMetadata(
              trace?.metadata,
              "advisorFirstTokenAt"
            ) ??
            readNumberFromTraceMetadata(
              trace?.metadata,
              "screenFirstTokenAt"
            );
          const arrivalStage = firstVisibleTokenAt
            ? "post-visible-answer"
            : activeAdvisorJobRef.current
              ? "advisor-in-flight-before-visible"
              : "before-advisor-execution";
          const repairComparison =
            compareTaxonomyAdjudicationToLocalBaseline({
              adjudication: parsedValue,
              baseline: localIntentBaseline,
            });
          const rawOutput = settlement.result?.rawOutput ?? "";
          const providerDisposition =
            settlement.result?.providerDisposition ??
            (settlement.disposition === "error"
              ? "request-error"
              : settlement.disposition);
          const providerCircuit =
            shouldOpenTaxonomyAdjudicationCircuit({
              leaseAuthorized: authorization.authorized,
              providerDisposition,
            })
              ? taxonomyAdjudicationCircuitBreakerRef.current.open({
                  sessionId: settlement.job.lease.sessionId,
                  reason: "provider-auth-error",
                  detail: rawOutput.slice(0, 240),
                })
              : undefined;
          const parseDisposition =
            settlement.result?.parseDisposition ??
            (settlement.disposition === "error"
              ? "not-run-request-error"
              : "not-run");
          const recordingActive =
            sessionRecordingManagerRef.current?.getState().active ?? false;
          const rawOutputStored = Boolean(
            rawOutput && (debugModeRef.current || recordingActive)
          );
          const boundedRawOutput = rawOutput.slice(
            0,
            TAXONOMY_ADJUDICATION_MAX_OUTPUT_CHARS
          );
          let finalDisposition:
            | typeof settlement.disposition
            | "stale"
            | "provider-auth-error"
            | "provider-error-output"
            | "invalid-output" = settlement.disposition;
          if (
            settlement.disposition === "completed" &&
            !authorization.authorized
          ) {
            finalDisposition = "stale";
          } else if (
            settlement.disposition === "completed" &&
            providerDisposition === "provider-auth-error"
          ) {
            finalDisposition = "provider-auth-error";
          } else if (
            settlement.disposition === "completed" &&
            providerDisposition === "provider-error-content"
          ) {
            finalDisposition = "provider-error-output";
          } else if (
            settlement.disposition === "completed" &&
            !parsed?.ok
          ) {
            finalDisposition = "invalid-output";
          }
          const metadata = {
            ...scheduledMetadata,
            taxonomyAdjudicationDisposition: finalDisposition,
            interviewerIntentLlmDisposition: finalDisposition,
            taxonomyAdjudicationStaleReason: authorization.authorized
              ? undefined
              : authorization.reason,
            interviewerIntentLlmStaleReason: authorization.authorized
              ? undefined
              : authorization.reason,
            taxonomyAdjudicationCompletedAt: settlement.completedAt,
            interviewerIntentLlmCompletedAt: settlement.completedAt,
            taxonomyAdjudicationDurationMs: settlement.durationMs,
            interviewerIntentLlmDurationMs: settlement.durationMs,
            taxonomyAdjudicationOutputChars: rawOutput.length,
            interviewerIntentLlmOutputChars: rawOutput.length,
            taxonomyAdjudicationProviderDisposition: providerDisposition,
            interviewerIntentLlmProviderDisposition: providerDisposition,
            taxonomyAdjudicationParseDisposition: parseDisposition,
            interviewerIntentLlmParseDisposition: parseDisposition,
            taxonomyAdjudicationParseErrorKind:
              parsed && !parsed.ok ? parsed.errorKind : undefined,
            interviewerIntentLlmParseErrorKind:
              parsed && !parsed.ok ? parsed.errorKind : undefined,
            taxonomyAdjudicationOutputEnvelope:
              parsed?.ok ? parsed.envelope : undefined,
            interviewerIntentLlmOutputEnvelope:
              parsed?.ok ? parsed.envelope : undefined,
            taxonomyAdjudicationRawOutputHash: rawOutput
              ? hashTaxonomySourceTurnIds([rawOutput])
              : undefined,
            taxonomyAdjudicationRawOutputStored: rawOutputStored,
            taxonomyAdjudicationRawOutputTruncated:
              rawOutput.length > boundedRawOutput.length,
            taxonomyAdjudicationRawOutputPreview:
              debugModeRef.current && rawOutput
                ? boundedRawOutput.slice(0, 320)
                : undefined,
            taxonomyAdjudicationParseValid: parsed?.ok ?? false,
            interviewerIntentLlmParseValid: parsed?.ok ?? false,
            taxonomyAdjudicationParseError:
              parsed && !parsed.ok ? parsed.reason : undefined,
            interviewerIntentLlmParseError:
              parsed && !parsed.ok ? parsed.reason : undefined,
            taxonomyAdjudicationEvidenceSpansValid:
              parsed?.evidenceSpansValid ?? false,
            interviewerIntentLlmEvidenceSpansValid:
              parsed?.evidenceSpansValid ?? false,
            interviewerIntentLlmSpeechAct: parsedValue?.speechAct,
            taxonomyAdjudicationCandidateType: parsedValue?.questionType,
            interviewerIntentLlmQuestionType: parsedValue?.questionType,
            taxonomyAdjudicationRelation: parsedValue?.relation,
            interviewerIntentLlmRelation: parsedValue?.relation,
            interviewerIntentLlmEvidenceMode: parsedValue?.evidenceMode,
            interviewerIntentLlmAction: parsedValue?.action,
            interviewerIntentLlmNormalizedQuestion:
              parsedValue?.normalizedQuestion,
            interviewerIntentLlmPrimaryAskSpans:
              parsedValue?.primaryAskSpans,
            interviewerIntentLlmPrimaryAskSpanCount:
              parsedValue?.primaryAskSpans.length,
            interviewerIntentLlmPrimaryAskSpanTexts:
              parsedValue?.primaryAskSpans.map((span) => span.text),
            interviewerIntentLlmPrimaryAskSourceTurnIds:
              parsedValue?.primaryAskSpans.map((span) => span.turnId),
            taxonomyAdjudicationStandalone: parsedValue?.standalone,
            taxonomyAdjudicationConfidence: parsedValue?.confidence,
            interviewerIntentLlmConfidence: parsedValue?.confidence,
            taxonomyAdjudicationArrivalStage: arrivalStage,
            interviewerIntentLlmArrivalStage: arrivalStage,
            taxonomyAdjudicationWouldRepair:
              repairComparison.wouldRepair,
            interviewerIntentLlmWouldRepair:
              repairComparison.wouldRepair,
            taxonomyAdjudicationRepairFactors:
              repairComparison.factors,
            interviewerIntentLlmRepairFactors:
              repairComparison.factors,
            taxonomyAdjudicationRepairApplied: false,
            interviewerIntentLlmRepairApplied: false,
            taxonomyAdjudicationBehaviorMutationBlocked: true,
            interviewerIntentLlmBehaviorMutationBlocked: true,
            taxonomyAdjudicationLeaseAuthorized:
              authorization.authorized,
            interviewerIntentLlmLeaseAuthorized:
              authorization.authorized,
            taxonomyAdjudicationSettlementTaskId:
              latestContext.activeMeetingTask?.id,
            interviewerIntentLlmSettlementTaskId:
              latestContext.activeMeetingTask?.id,
            taxonomyAdjudicationError:
              settlement.error instanceof Error
                ? settlement.error.message
                : settlement.error
                  ? String(settlement.error)
                  : undefined,
            ...(providerCircuit
              ? formatTaxonomyAdjudicationCircuitForTrace(
                  providerCircuit.state,
                  providerCircuit.newlyOpened
                )
              : {}),
          };
          if (rawOutputStored) {
            if (debugModeRef.current) {
              traceStoreRef.current.recordOutput(
                traceId,
                "taxonomy adjudication raw output",
                boundedRawOutput,
                {
                  providerDisposition,
                  parseDisposition,
                  truncated: rawOutput.length > boundedRawOutput.length,
                }
              );
            }
            if (recordingActive) {
              sessionRecordingManagerRef.current?.recordModelOutput({
                traceId,
                taskId: scheduledTaskId,
                label: "taxonomy adjudication raw output",
                value: boundedRawOutput,
                metadata: {
                  providerDisposition,
                  parseDisposition,
                  originalChars: rawOutput.length,
                  truncated: rawOutput.length > boundedRawOutput.length,
                },
              });
            }
          }
          traceStoreRef.current.updateMetadata(traceId, metadata);
          if (stepId) {
            traceStoreRef.current.finishStep(
              traceId,
              stepId,
              finalDisposition === "error" ||
                finalDisposition === "provider-auth-error" ||
                finalDisposition === "provider-error-output" ||
                finalDisposition === "invalid-output"
                ? "error"
                : "success",
              metadata,
              settlement.error ??
                (finalDisposition === "provider-auth-error"
                  ? "Taxonomy adjudication provider authentication failed"
                  : finalDisposition === "provider-error-output"
                  ? "Provider returned error content"
                  : finalDisposition === "invalid-output"
                    ? `Invalid taxonomy adjudication output: ${parseDisposition}`
                  : undefined)
            );
          }
          sessionRecordingManagerRef.current?.recordTaxonomyAdjudicationDecision({
            traceId,
            taskId: scheduledTaskId,
            metadata,
          });
        },
      });
    },
    []
  );

  const scheduleSemanticTaxonomyShadow = useCallback(
    ({
      turn,
      traceId,
      turnGateAction,
      logicalQuestionUnit,
    }: {
      turn: TranscriptTurn;
      traceId: string;
      turnGateAction: string;
      logicalQuestionUnit?: LogicalQuestionUnit;
    }) => {
      const contextState = contextManagerRef.current.getState();
      const sessionId = contextState.sessionId;
      const runtimeEpoch = runtimeEpochRef.current;
      const semanticTaxonomyMode = semanticTaxonomyModeRef.current;
      const runtime = semanticTaxonomyRuntimeRef.current!;
      const classifierText =
        logicalQuestionUnit?.normalizedText || turn.text;
      const activeParent = contextState.activeMeetingTask?.parent;
      const activeParentId = activeParent?.id;
      const activeParentRevision = activeParent?.revisions;
      const relationText = buildSemanticInterviewerIntentRelationText({
        currentText: classifierText,
        parent: activeParent,
      });
      const lexical = inferQuestionTypeDecisionFromText(classifierText, {
        interviewSessionBrief: contextState.interviewSessionBrief,
      });
      const eligibility = decideSemanticTaxonomyShadowEligibility({
        speaker: turn.speaker,
        turnGateAction,
        wordEquivalent: calculateWordEquivalent(turn.text),
      });
      runtime.pinSession(
        { sessionId, runtimeEpoch },
        "accepted-latest-interviewer-turn"
      );
      const initialMetadata = {
        ...formatSemanticTaxonomyShadowMetadata({
          turnId: turn.id,
          sessionId,
          runtimeEpoch,
          lexical,
          eligibility,
          runtime: runtime.getSnapshot(),
          mode: semanticTaxonomyMode,
        }),
        ...formatSemanticInterviewerIntentForTrace(undefined, {
          embeddingStatus: "not-requested",
          parentId: activeParentId,
          parentRevision: activeParentRevision,
          logicalQuestionUnitId: logicalQuestionUnit?.id,
          logicalQuestionUnitRevision: logicalQuestionUnit?.revision,
        }),
        ...formatLogicalQuestionUnitForTrace(logicalQuestionUnit),
      };
      traceStoreRef.current.updateMetadata(traceId, initialMetadata);
      semanticTaxonomyEvidenceByTurnRef.current.set(turn.id, {
        turnId: turn.id,
        sessionId,
        runtimeEpoch,
        lexical,
        metadata: initialMetadata,
      });

      if (!eligibility.eligible) {
        sessionRecordingManagerRef.current?.recordSemanticTaxonomyDecision({
          traceId,
          taskId: contextState.activeMeetingTask?.id,
          metadata: initialMetadata,
        });
        sessionRecordingManagerRef.current?.recordInterviewerIntentSemanticDecision({
          traceId,
          taskId: contextState.activeMeetingTask?.id,
          metadata: initialMetadata,
        });
        scheduleTaxonomyAdjudicationShadow({
          turn,
          traceId,
          turnGateAction,
          logicalQuestionUnit,
          lexical,
        });
        return;
      }

      const stepId = traceStoreRef.current.startStep(
        traceId,
        "Semantic taxonomy shadow",
        {
          turnId: turn.id,
          sessionId,
          runtimeEpoch,
          lexicalType: lexical.type ?? "unknown",
          mode: "shadow",
        }
      );
      semanticEmbeddingRevisionRef.current += 1;
      const semanticRequestRevision =
        semanticEmbeddingRevisionRef.current;
      void runtime
        .embed(
          {
            sessionId,
            runtimeEpoch,
            turnId: turn.id,
            texts: activeParent
              ? [classifierText, relationText]
              : [classifierText],
            kind: "query",
          },
          {
            consumer: "interviewer-intent",
            coalescingKey: `${sessionId}:current-question`,
            revision: semanticRequestRevision,
            onTelemetry: (telemetry) => {
              recordSemanticEmbeddingRuntimeEvent({
                traceId,
                taskId: contextState.activeMeetingTask?.id,
                telemetry,
              });
            },
          }
        )
        .then((embedding) => {
          const currentContext = contextManagerRef.current.getState();
          const stale =
            currentContext.sessionId !== sessionId ||
            runtimeEpochRef.current !== runtimeEpoch ||
            (logicalQuestionUnit
              ? logicalQuestionUnitRef.current?.id !==
                  logicalQuestionUnit.id ||
                logicalQuestionUnitRef.current?.revision !==
                  logicalQuestionUnit.revision
              : false) ||
            currentContext.activeMeetingTask?.parent.id !== activeParentId ||
            currentContext.activeMeetingTask?.parent.revisions !==
              activeParentRevision ||
            embedding.status === "stale";
          if (stale) {
            traceStoreRef.current.finishStep(
              traceId,
              stepId,
              "cancelled",
              {
                semanticTaxonomyStaleResultDropped: true,
                semanticTaxonomyTurnId: turn.id,
                semanticTaxonomySessionId: sessionId,
                semanticTaxonomyRuntimeEpoch: runtimeEpoch,
                semanticTaxonomyCurrentSessionId: currentContext.sessionId,
                semanticTaxonomyCurrentRuntimeEpoch: runtimeEpochRef.current,
                ...formatSemanticInterviewerIntentForTrace(undefined, {
                  embeddingStatus: embedding.status,
                  parentId: activeParentId,
                  parentRevision: activeParentRevision,
                  logicalQuestionUnitId: logicalQuestionUnit?.id,
                  logicalQuestionUnitRevision:
                    logicalQuestionUnit?.revision,
                  staleResultDropped: true,
                }),
              }
            );
            return;
          }

          const semantic =
            embedding.status === "success" && embedding.embeddings[0]
              ? scoreSemanticTaxonomyEmbedding(embedding.embeddings[0])
              : undefined;
          const hybrid = resolveHybridQuestionType({ lexical, semantic });
          const semanticIntent =
            embedding.status === "success" && embedding.embeddings[0]
              ? scoreSemanticInterviewerIntentEmbeddings({
                  unitEmbedding: embedding.embeddings[0],
                  relationEmbedding: embedding.embeddings[1],
                  activeParentAvailable: Boolean(activeParent),
                })
              : undefined;
          const metadata = {
            ...formatSemanticTaxonomyShadowMetadata({
              turnId: turn.id,
              sessionId,
              runtimeEpoch,
              lexical,
              eligibility,
              runtime: runtime.getSnapshot(),
              embedding,
              semantic,
              hybrid,
              mode: semanticTaxonomyMode,
            }),
            ...formatSemanticEmbeddingRuntimeTelemetryForTrace(
              embedding.telemetry
            ),
            ...formatSemanticInterviewerIntentForTrace(semanticIntent, {
              embeddingStatus: embedding.status,
              durationMs: embedding.durationMs,
              cacheHit:
                embedding.status === "success"
                  ? embedding.cacheHit
                  : false,
              parentId: activeParentId,
              parentRevision: activeParentRevision,
              logicalQuestionUnitId: logicalQuestionUnit?.id,
              logicalQuestionUnitRevision:
                logicalQuestionUnit?.revision,
            }),
            ...formatLogicalQuestionUnitForTrace(logicalQuestionUnit),
          };
          traceStoreRef.current.updateMetadata(traceId, metadata);
          semanticTaxonomyEvidenceByTurnRef.current.set(turn.id, {
            turnId: turn.id,
            sessionId,
            runtimeEpoch,
            lexical,
            hybrid,
            metadata,
          });
          while (semanticTaxonomyEvidenceByTurnRef.current.size > 32) {
            const oldestTurnId =
              semanticTaxonomyEvidenceByTurnRef.current.keys().next().value;
            if (!oldestTurnId) break;
            semanticTaxonomyEvidenceByTurnRef.current.delete(oldestTurnId);
          }
          traceStoreRef.current.finishStep(
            traceId,
            stepId,
            embedding.status === "error" ? "error" : "success",
            metadata,
            embedding.status === "error" ? embedding.reason : undefined
          );
          sessionRecordingManagerRef.current?.recordSemanticTaxonomyDecision({
            traceId,
            taskId: contextState.activeMeetingTask?.id,
            metadata,
          });
          sessionRecordingManagerRef.current?.recordInterviewerIntentSemanticDecision({
            traceId,
            taskId: contextState.activeMeetingTask?.id,
            metadata,
          });
          scheduleTaxonomyAdjudicationShadow({
            turn,
            traceId,
            turnGateAction,
            logicalQuestionUnit,
            lexical,
            semantic,
            hybrid,
          });
        })
        .catch((error) => {
          const metadata = {
            ...initialMetadata,
            taxonomySemanticEmbeddingStatus: "error",
            taxonomySemanticEmbeddingReason:
              error instanceof Error ? error.message : String(error),
            taxonomyHybridOutcome: "semantic-unavailable",
            taxonomyHybridReason: "semantic-shadow-orchestration-error",
            ...formatSemanticInterviewerIntentForTrace(undefined, {
              embeddingStatus: "error",
              parentId: activeParentId,
              parentRevision: activeParentRevision,
              logicalQuestionUnitId: logicalQuestionUnit?.id,
              logicalQuestionUnitRevision:
                logicalQuestionUnit?.revision,
            }),
          };
          traceStoreRef.current.updateMetadata(traceId, metadata);
          traceStoreRef.current.finishStep(
            traceId,
            stepId,
            "error",
            metadata,
            error
          );
          sessionRecordingManagerRef.current?.recordSemanticTaxonomyDecision({
            traceId,
            taskId: contextState.activeMeetingTask?.id,
            metadata,
          });
          sessionRecordingManagerRef.current?.recordInterviewerIntentSemanticDecision({
            traceId,
            taskId: contextState.activeMeetingTask?.id,
            metadata,
          });
          scheduleTaxonomyAdjudicationShadow({
            turn,
            traceId,
            turnGateAction,
            logicalQuestionUnit,
            lexical,
          });
        });
    },
    [
      recordSemanticEmbeddingRuntimeEvent,
      scheduleTaxonomyAdjudicationShadow,
    ]
  );

  const buildLogicalQuestionForTurn = useCallback(
    ({
      turn,
      traceId,
      intentDecision,
      explicitTaskSwitch = false,
      sectionHint,
      primaryAskProjection,
    }: {
      turn: TranscriptTurn;
      traceId: string;
      intentDecision: AdvisorTurnIntentDecision;
      explicitTaskSwitch?: boolean;
      sectionHint?: PendingInterviewSectionHint;
      primaryAskProjection?: PrimaryAskProjection;
    }) => {
      const contextState = contextManagerRef.current.getState();
      const previous = logicalQuestionUnitRef.current;
      const previousEndedAt =
        previous?.sources[previous.sources.length - 1]?.endedAt;
      const interveningTurns =
        previousEndedAt === undefined
          ? []
          : contextState.transcriptTurns.filter(
              (candidate) =>
                candidate.id !== turn.id &&
                candidate.startedAt >= previousEndedAt &&
                candidate.endedAt <= turn.startedAt
            );
      const cancelledAdvisorTurnIds = new Set(
        cancelledAdvisorTurnIdsRef.current
      );
      const pendingBoundary = expireTaskBoundaryCandidate(
        taskBoundaryCandidateRef.current
      );
      taskBoundaryCandidateRef.current = pendingBoundary;
      const activeTriggerTurnId = activeAdvisorJobRef.current?.triggerTurnId;
      if (activeTriggerTurnId && activeTriggerTurnId !== turn.id) {
        cancelledAdvisorTurnIds.add(activeTriggerTurnId);
      }
      const logicalQuestionUnit = composeLogicalQuestionUnit({
        currentTurn: turn,
        sessionId: contextState.sessionId,
        runtimeEpoch: runtimeEpochRef.current,
        intentDecision,
        previousUnit: previous,
        cancelledAdvisorTurnIds,
        pendingBoundarySourceTurnIds:
          pendingBoundary?.state === "pending"
            ? pendingBoundary.sourceTurnIds
            : undefined,
        relatedSourceTurnIds: turn.relatedTurnIds,
        interveningTurns,
        recentThemTurns: contextState.transcriptTurns.filter(
          (candidate) =>
            candidate.speaker === "them" &&
            candidate.id !== turn.id &&
            candidate.endedAt <= turn.startedAt
        ),
        explicitTaskSwitch,
        sectionHint,
        primaryAskProjection:
          primaryAskProjection ??
          projectPrimaryAsk({ turnId: turn.id, text: turn.text }),
      });
      logicalQuestionUnitRef.current = logicalQuestionUnit;
      traceStoreRef.current.updateMetadata(
        traceId,
        formatLogicalQuestionUnitForTrace(logicalQuestionUnit)
      );
      return logicalQuestionUnit;
    },
    []
  );

  const publishCanonicalLogicalQuestionTarget = useCallback(
    ({
      logicalQuestionUnit,
      traceId,
      turn,
      intentDecision,
    }: {
      logicalQuestionUnit: LogicalQuestionUnit;
      traceId: string;
      turn: TranscriptTurn;
      intentDecision: AdvisorTurnIntentDecision;
    }) => {
      const logicalQuestionLease =
        createLogicalQuestionUnitLease(logicalQuestionUnit);
      const questionLineage = createCanonicalLogicalQuestionLineage({
        unit: logicalQuestionUnit,
        traceId,
      });
      const presentation: ForceAdviseTargetPresentation = {
        originalTraceId: traceId,
        turnId: turn.id,
        text: logicalQuestionUnit.normalizedText || turn.text,
        observedAction: toObservedAdvisorAction(intentDecision),
        executionAuthorized: intentDecision.executionAuthorized,
        logicalQuestionUnitId: logicalQuestionUnit.id,
        logicalQuestionUnitRevision: logicalQuestionUnit.revision,
        sourceTurnIds: [...logicalQuestionUnit.sourceTurnIds],
        status: intentDecision.executionAuthorized
          ? "already-advised"
          : "ready",
        updatedAt: Date.now(),
      };
      const target: ForceAdviseRuntimeTarget = {
        presentation,
        turn: { ...turn },
        intentDecision,
        logicalQuestionUnit,
        logicalQuestionLease,
        questionLineage,
      };
      latestForceAdviseTargetRef.current = target;
      setState((previous) => ({
        ...previous,
        latestInterviewerTurnCandidate: presentation,
      }));
      traceStoreRef.current.updateMetadata(traceId, {
        ...formatLogicalQuestionUnitForTrace(logicalQuestionUnit),
        ...formatLogicalQuestionLeaseForTrace(logicalQuestionLease),
        ...formatQuestionLineageForTrace(questionLineage),
        canonicalLogicalQuestionTargetPublished: true,
        forceAdviseTargetStatus: presentation.status,
        forceAdviseEligible: !intentDecision.executionAuthorized,
      });
      return target;
    },
    []
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
              const audioStatus = (await stopNativeMeetingCapture()).status;
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
          traceStoreRef.current.updateMetadata(traceId, {
            acceptedSpeechDisposition: "stale-session-dropped",
            transcriptAppendDisposition: "suppressed",
            transcriptAppendReason: "stale-after-stt",
          });
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
            traceStoreRef.current.updateMetadata(traceId, {
              acceptedSpeechDisposition: "duplicate-suppressed",
              transcriptAppendDisposition: "suppressed",
              transcriptAppendReason: duplicateDecision.reason,
            });
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
          traceStoreRef.current.updateMetadata(traceId, {
            acceptedSpeechDisposition: "duplicate-suppressed",
            transcriptAppendDisposition: "suppressed",
            transcriptAppendReason: duplicateDecision.reason,
          });
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
          traceStoreRef.current.updateMetadata(traceId, {
            acceptedSpeechDisposition: "sentence-fragment-buffered",
            transcriptAppendDisposition: "deferred",
            transcriptAppendReason: sentenceCompletionDecision.reason,
          });
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
        const transitionTurnDecision = classifyInterviewTransitionTurn(
          turn.text
        );
        const sectionTransitionDetection = detectInterviewSectionTransition(
          turn.text
        );
        if (sectionTransitionDetection.detected) {
          pendingInterviewSectionHintRef.current =
            createPendingInterviewSectionHint({
              detection: sectionTransitionDetection,
              sourceTurnId: turn.id,
              sourceText: turn.text,
              sessionId: activeContextState.sessionId,
              runtimeEpoch: runtimeEpochRef.current,
              observedAt: turn.endedAt,
            });
        } else if (transitionTurnDecision.detected) {
          pendingInterviewSectionHintRef.current = undefined;
        }
        traceStoreRef.current.updateMetadata(traceId, {
          taskSwitchEvidenceDetected: transitionTurnDecision.detected,
          taskSwitchDisposition: transitionTurnDecision.disposition,
          taskSwitchDispositionReason: transitionTurnDecision.reason,
          sectionHintDetected: sectionTransitionDetection.detected,
          sectionHintId: pendingInterviewSectionHintRef.current?.id,
          sectionHintType: pendingInterviewSectionHintRef.current?.questionType,
          sectionHintSourceTurnId:
            pendingInterviewSectionHintRef.current?.sourceTurnId,
          sectionHintObservedAt:
            pendingInterviewSectionHintRef.current?.observedAt,
          sectionHintExpiresAt:
            pendingInterviewSectionHintRef.current?.expiresAt,
          sectionHintDisposition:
            pendingInterviewSectionHintRef.current?.disposition,
        });

        if (transitionTurnDecision.disposition === "hint-only") {
          latestForceAdviseTargetRef.current = undefined;
          const switchStepId = traceStoreRef.current.startStep(
            traceId,
            "Interview section transition recorded",
            {
              turnId: turn.id,
              ...getActiveMeetingTaskTraceMetadata(
                activeContextState.activeMeetingTask
              ),
              activeScreenTaskId: activeScreenTask?.id,
              activeInterviewTaskId: activeInterviewTask?.id,
              transcriptChars: turn.text.trim().length,
              taskSwitchDisposition: transitionTurnDecision.disposition,
              taskSwitchDispositionReason: transitionTurnDecision.reason,
            }
          );
          appendTranscriptTurnForTrace(turn, traceId, segment, {
            turnGateAction: "append-only",
            turnGateReason: "task-switch-announcement",
            transcriptAppendReason: "task-switch-announcement",
          });
          traceStoreRef.current.finishStep(traceId, switchStepId, "success");
          traceStoreRef.current.finishTrace(traceId, "success");
          setState((previous) => ({
            ...previous,
            status: activeRef.current ? "listening" : "idle",
            partialSuggestion: "",
            latestInterviewerTurnCandidate: undefined,
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
            hasRecentQuestionContext: Boolean(
              currentQuestionLineageRef.current
            ),
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
          const logicalQuestionUnit = buildLogicalQuestionForTurn({
            turn,
            traceId,
            intentDecision: turnIntentDecision,
          });
          publishCanonicalLogicalQuestionTarget({
            logicalQuestionUnit,
            traceId,
            turn,
            intentDecision: turnIntentDecision,
          });
          scheduleSemanticTaxonomyShadow({
            turn,
            traceId,
            turnGateAction: "answer-refresh",
            logicalQuestionUnit,
          });
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
            turn.id,
            undefined,
            logicalQuestionUnit
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

        const pendingAdjacentQuestionScope = hasActiveInterviewTask
          ? null
          : adjacentQuestionScopeRef.current;
        const adjacentConstraintDecision =
          resolveAdjacentConstraintInheritance({
            scope: pendingAdjacentQuestionScope,
            text: turn.text,
            sessionId: activeContextState.sessionId,
            runtimeEpoch: runtimeEpochRef.current,
          });
        if (adjacentConstraintDecision.shouldClearScope) {
          adjacentQuestionScopeRef.current = null;
        }
        if (pendingAdjacentQuestionScope) {
          traceStoreRef.current.updateMetadata(
            traceId,
            formatAdjacentConstraintDecisionForTrace(
              adjacentConstraintDecision
            )
          );
        }

        const primaryAskProjection = projectPrimaryAsk({
          turnId: turn.id,
          text: turn.text,
        });
        const projectedClassifierText = primaryAskClassifierText(
          primaryAskProjection,
          turn.text
        );
        const turnGate = reconcilePrimaryAskTurnDecision(
          primaryAskProjection,
          evaluateThemTurnForAdvisor(
            { ...turn, text: projectedClassifierText },
            {
              hasActiveTask: hasActiveInterviewTask,
              hasRecentQuestionContext: Boolean(
                currentQuestionLineageRef.current ||
                  adjacentConstraintDecision.inherited
              ),
            }
          )
        );
        traceStoreRef.current.updateMetadata(
          traceId,
          formatPrimaryAskProjectionForTrace(primaryAskProjection)
        );
        const keywordIntentEvidence =
          formatInterviewerIntentKeywordEvidenceForTrace(
            extractInterviewerIntentKeywordEvidence({
              text: projectedClassifierText,
              turnDecision: turnGate,
              currentTurnId: turn.id,
            })
          );
        traceStoreRef.current.updateMetadata(traceId, {
          ...formatAdvisorTurnIntentForTrace(turnGate),
          ...keywordIntentEvidence,
          turnGateAction: turnGate.action,
          turnGateReason: turnGate.reason,
          memoryRetrievalSuppressedReason: turnGate.executionAuthorized
            ? undefined
            : `turn-intent:${turnGate.reason}`,
          modelExecutionSuppressedReason: turnGate.executionAuthorized
            ? undefined
            : `turn-intent:${turnGate.reason}`,
        });
        const wordEquivalent = calculateWordEquivalent(turn.text);
        const logicalQuestionMaterialization =
          decideLogicalQuestionMaterialization({
            action: turnGate.action,
            wordEquivalent,
          });
        traceStoreRef.current.updateMetadata(traceId, {
          canonicalLogicalQuestionMaterialized:
            logicalQuestionMaterialization.materialize,
          canonicalLogicalQuestionMaterializationReason:
            logicalQuestionMaterialization.reason,
        });
        const gateStepId = traceStoreRef.current.startStep(
          traceId,
          "Advisor turn gate",
          {
            action: turnGate.action,
            reason: turnGate.reason,
            ...formatAdvisorTurnIntentForTrace(turnGate),
            ...keywordIntentEvidence,
            turnId: turn.id,
            transcriptChars: turn.text.trim().length,
            wordEquivalent,
            activeScreenTask: Boolean(activeScreenTask),
            activeInterviewTask: Boolean(activeInterviewTask),
            contextPromptEligible: turnGate.contextPromptEligible,
            audioSegmentSeq: segment.sequence,
            audioSessionId: segment.sessionId,
          }
        );
        traceStoreRef.current.finishStep(traceId, gateStepId, "success");

        const currentQuestionType =
          normalizeCanonicalQuestionType(
            inferCanonicalQuestionTypeFromText(projectedClassifierText)
          ) ?? "unknown";
        const sectionHintConsumption = consumeInterviewSectionHint({
          hint: pendingInterviewSectionHintRef.current,
          questionId: turn.id,
          currentQuestionType,
          substantive: turnGate.action === "answer-refresh",
          sessionId: activeContextState.sessionId,
          runtimeEpoch: runtimeEpochRef.current,
          now: turn.endedAt,
        });
        pendingInterviewSectionHintRef.current =
          sectionHintConsumption.nextHint;
        if (sectionHintConsumption.disposition !== "no-hint") {
          const sectionHintMetadata = {
            ...formatInterviewSectionHintForTrace(sectionHintConsumption),
            sectionHintClassificationBefore: currentQuestionType,
          };
          traceStoreRef.current.updateMetadata(traceId, sectionHintMetadata);
          sessionRecordingManagerRef.current?.recordCaptureLifecycle({
            stage: "interview-section-hint-consumed",
            traceId,
            ...sectionHintMetadata,
          });
        }

        const logicalQuestionUnit =
          logicalQuestionMaterialization.materialize
            ? buildLogicalQuestionForTurn({
                turn,
                traceId,
                intentDecision: turnGate,
                explicitTaskSwitch:
                  transitionTurnDecision.detected ||
                  sectionHintConsumption.disposition === "applied",
                sectionHint:
                  sectionHintConsumption.disposition === "applied"
                    ? sectionHintConsumption.hint
                    : undefined,
                primaryAskProjection,
              })
            : undefined;
        if (logicalQuestionUnit) {
          publishCanonicalLogicalQuestionTarget({
            logicalQuestionUnit,
            traceId,
            turn,
            intentDecision: turnGate,
          });
        }

        if (turnGate.action === "ignore") {
          if (logicalQuestionUnit) {
            scheduleSemanticTaxonomyShadow({
              turn,
              traceId,
              turnGateAction: turnGate.action,
              logicalQuestionUnit,
            });
          }
          traceStoreRef.current.updateMetadata(traceId, {
            acceptedSpeechDisposition: "low-value-ignored",
            transcriptAppendDisposition: "suppressed",
            transcriptAppendReason: turnGate.reason,
          });
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
        if (logicalQuestionUnit) {
          scheduleSemanticTaxonomyShadow({
            turn,
            traceId,
            turnGateAction: turnGate.action,
            logicalQuestionUnit,
          });
        }

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

        let advisorQuestionLineage = adjacentConstraintDecision.lineage;
        if (
          !hasActiveInterviewTask &&
          turnGate.intent === "direct-question" &&
          turnGate.action === "answer-refresh" &&
          turnGate.executionAuthorized
        ) {
          const provisionalQuestionLineage = createAuthorizedQuestionLineage({
            traceId,
            triggerTurnId: turn.id,
            sessionId: contextState.sessionId,
            runtimeEpoch: runtimeEpochRef.current,
            action: turnGate.action,
            executionAuthorized: turnGate.executionAuthorized,
          });
          if (provisionalQuestionLineage) {
            const adjacentQuestionScope = createAdjacentQuestionScope({
              lineage: provisionalQuestionLineage,
              questionTurnId: turn.id,
              questionTraceId: traceId,
              questionText:
                logicalQuestionUnit?.normalizedText || projectedClassifierText,
              sessionId: contextState.sessionId,
              runtimeEpoch: runtimeEpochRef.current,
            });
            adjacentQuestionScopeRef.current = adjacentQuestionScope;
            advisorQuestionLineage = provisionalQuestionLineage;
            traceStoreRef.current.updateMetadata(
              traceId,
              formatAdjacentQuestionScopeForTrace(adjacentQuestionScope)
            );
          }
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
          turn.id,
          advisorQuestionLineage,
          logicalQuestionUnit
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
      buildLogicalQuestionForTurn,
      cancelActiveAdvisorJob,
      consumePendingSentenceCompletion,
      flushPendingSentenceCompletion,
      holdPendingConfirmation,
      holdPendingSentenceCompletion,
      incrementAppliedSpeechCorrections,
      invalidateAudioProcessingSession,
      isCurrentAudioSegment,
      publishCanonicalLogicalQuestionTarget,
      promoteMeTurnForFusion,
      resolvePendingConfirmationForMeTurn,
      scheduleSemanticTaxonomyShadow,
      scheduleAdvisor,
      selectedSttProvider,
      stopNativeMeetingCapture,
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

  const startCapture = useCallback(
    async (
      mode: NativeAudioCaptureStartMode,
      recoveryAttempt?: NativeAudioRecoveryAttemptContext
    ) => {
      const policy = getNativeAudioCaptureStartPolicy(mode);
      const pendingManualRecovery =
        mode === "manual-recovery"
          ? nativeAudioManualRecoveryRef.current
          : null;
      if (mode === "manual-recovery" && !pendingManualRecovery) {
        setState((previous) => ({
          ...previous,
          error: "No native audio failure is waiting for manual recovery.",
        }));
        return;
      }
      const manualRecoveryAttempt:
        | NativeAudioManualRecoveryAttemptContext
        | undefined = pendingManualRecovery
        ? {
            id: createMeetingId("native_audio_manual_recovery"),
            startedAt: Date.now(),
            pending: pendingManualRecovery,
          }
        : undefined;
      const reconcileCaptureStartFailure = (errorMessage: string) => {
        const disposition = resolveNativeAudioCaptureStartFailure({
          mode,
          pendingManualRecovery,
          automaticRecovery: recoveryAttempt
            ? {
                startedAt: recoveryAttempt.startedAt,
                previousCaptureSessionId:
                  recoveryAttempt.previousCaptureSessionId,
                previousCaptureGeneration:
                  recoveryAttempt.previousCaptureGeneration,
                reason: recoveryAttempt.reason,
              }
            : undefined,
          errorMessage,
        });

        nativeAudioManualRecoveryRef.current = disposition.manualRecovery;
        if (
          disposition.recoveryAuthority === "created" &&
          disposition.manualRecovery
        ) {
          sessionRecordingManagerRef.current?.recordCaptureLifecycle({
            stage: "manual-recovery-required",
            source: "automatic-recovery-failed",
            requiredAt: disposition.manualRecovery.requiredAt,
            reason: disposition.manualRecovery.reason,
            message: disposition.manualRecovery.message,
            previousCaptureSessionId:
              disposition.manualRecovery.interruptedCaptureSessionId,
            previousCaptureGeneration:
              disposition.manualRecovery.interruptedCaptureGeneration,
            circuitBreakerOpen:
              disposition.manualRecovery.circuitBreakerOpen,
          });
        }
        sessionRecordingManagerRef.current?.recordCaptureLifecycle({
          stage: "capture-start-failure-reconciled",
          startMode: mode,
          status: disposition.status,
          retryAction: disposition.retryAction,
          recoveryAuthority: disposition.recoveryAuthority,
          resetContext: policy.resetContext,
          error: errorMessage,
        });
        setState((previous) => ({
          ...previous,
          status: disposition.status,
          partialSuggestion: "",
          error: errorMessage,
          nativeAudioManualRecovery:
            disposition.manualRecovery ?? undefined,
        }));
      };
      const coordinator = captureLifecycleCoordinatorRef.current!;
      const lifecycleOperation = coordinator.claim(policy.lifecycleAction);
      const previousNativeLease = readNativeCaptureLease();
      nativeCaptureSessionIdRef.current = null;
      nativeCaptureGenerationRef.current = null;
      lastNativeSegmentSequenceRef.current = 0;
      if (policy.resetRecoveryBudget) {
        nativeRecoveryAttemptTimestampsRef.current = [];
      }
      if (policy.resetContext) {
        handledNativeTerminalKeysRef.current.clear();
        nativeAudioManualRecoveryRef.current = null;
      }
      if (manualRecoveryAttempt) {
        const contextState = contextManagerRef.current.getState();
        sessionRecordingManagerRef.current?.recordCaptureLifecycle({
          stage: "manual-recovery-started",
          manualRecoveryAttemptId: manualRecoveryAttempt.id,
          recoveryStartedAt: manualRecoveryAttempt.startedAt,
          reason: manualRecoveryAttempt.pending.reason,
          circuitBreakerOpen:
            manualRecoveryAttempt.pending.circuitBreakerOpen,
          previousCaptureSessionId:
            manualRecoveryAttempt.pending.interruptedCaptureSessionId,
          previousCaptureGeneration:
            manualRecoveryAttempt.pending.interruptedCaptureGeneration,
          resetContext: policy.resetContext,
          resetRecoveryBudget: policy.resetRecoveryBudget,
          activeMeetingTaskId: contextState.activeMeetingTask?.id,
          transcriptTurns: contextState.transcriptTurns.length,
        });
      }

      if (state.settings.privacyMode === "memory-only") {
        activeRef.current = false;
        invalidateAudioProcessingSession();
        cancelActiveAdvisorJob("local-only-mode-unavailable");
        screenAnalysisAbortRef.current?.abort();
        screenAnalysisAbortRef.current = null;
        reconcileCaptureStartFailure(LOCAL_ONLY_UNAVAILABLE_MESSAGE);
        coordinator.authorize(lifecycleOperation, "blocked-local-only-mode");
        if (manualRecoveryAttempt) {
          sessionRecordingManagerRef.current?.recordCaptureLifecycle({
            stage: "manual-recovery-failed",
            manualRecoveryAttemptId: manualRecoveryAttempt.id,
            recoveryDurationMs: Date.now() - manualRecoveryAttempt.startedAt,
            reason: "blocked-local-only-mode",
          });
        }
        return;
      }

      if (!sttProvider) {
        activeRef.current = false;
        invalidateAudioProcessingSession();
        cancelActiveAdvisorJob("stt-provider-missing");
        screenAnalysisAbortRef.current?.abort();
        screenAnalysisAbortRef.current = null;
        reconcileCaptureStartFailure(MISSING_STT_MESSAGE);
        coordinator.authorize(lifecycleOperation, "blocked-stt-provider-missing");
        if (manualRecoveryAttempt) {
          sessionRecordingManagerRef.current?.recordCaptureLifecycle({
            stage: "manual-recovery-failed",
            manualRecoveryAttemptId: manualRecoveryAttempt.id,
            recoveryDurationMs: Date.now() - manualRecoveryAttempt.startedAt,
            reason: "blocked-stt-provider-missing",
          });
        }
        return;
      }

      setState((previous) => ({
        ...previous,
        status: policy.pendingStatus,
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
            throw new Error(
              "System audio permission is required for meeting assistant."
            );
          }

          const resetBoundary = policy.resetContext
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

          await stopNativeMeetingCapture(previousNativeLease);
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
              () =>
                stopNativeMeetingCapture({
                  captureSessionId: audioStatus.captureSessionId,
                  captureGeneration: audioStatus.captureGeneration,
                })
            );
            return;
          }

          const nativeCaptureSessionId = audioStatus.captureSessionId?.trim();
          const nativeCaptureGeneration = audioStatus.captureGeneration;
          if (!nativeCaptureSessionId || nativeCaptureGeneration == null) {
            await stopNativeMeetingCapture({
              captureSessionId: audioStatus.captureSessionId,
              captureGeneration: audioStatus.captureGeneration,
            });
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
          if (state.settings.useMemory) {
            void prewarmMemoryContextSnapshot(contextState.sessionId);
          }
          prewarmSemanticTaxonomyRuntime(
            mode === "fresh-start"
              ? "meeting-session-started"
              : `meeting-session-${mode}`
          );
          if (manualRecoveryAttempt) {
            const resumedAt = Date.now();
            const requiredToResumedMs = Math.max(
              0,
              resumedAt - manualRecoveryAttempt.pending.requiredAt
            );
            nativeAudioManualRecoveryRef.current = null;
            sessionRecordingManagerRef.current?.recordCaptureLifecycle({
              stage: "manual-recovery-succeeded",
              manualRecoveryAttemptId: manualRecoveryAttempt.id,
              recoveryStartedAt: manualRecoveryAttempt.startedAt,
              resumedAt,
              recoveryDurationMs:
                resumedAt - manualRecoveryAttempt.startedAt,
              requiredToResumedMs,
              estimatedAudioBlackoutMs: requiredToResumedMs,
              previousCaptureSessionId:
                manualRecoveryAttempt.pending.interruptedCaptureSessionId,
              previousCaptureGeneration:
                manualRecoveryAttempt.pending.interruptedCaptureGeneration,
              nextCaptureSessionId: nativeCaptureSessionId,
              nextCaptureGeneration: nativeCaptureGeneration,
              reason: manualRecoveryAttempt.pending.reason,
              circuitBreakerOpen:
                manualRecoveryAttempt.pending.circuitBreakerOpen,
              resetContext: policy.resetContext,
              resetRecoveryBudget: policy.resetRecoveryBudget,
              activeMeetingTaskId: contextState.activeMeetingTask?.id,
              transcriptTurns: contextState.transcriptTurns.length,
            });
          }

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
            latestSuggestion: policy.resetContext
              ? null
              : previous.latestSuggestion,
            latestReliableSuggestion: policy.resetContext
              ? null
              : previous.latestReliableSuggestion,
            lastMemoryContext: policy.resetContext
              ? undefined
              : previous.lastMemoryContext,
            speechCorrections: policy.resetContext
              ? []
              : previous.speechCorrections,
            partialSuggestion: "",
            error: null,
            audioStatus,
            nativeAudioManualRecovery:
              policy.resetContext || manualRecoveryAttempt
                ? undefined
                : previous.nativeAudioManualRecovery,
          }));
          if (recoveryAttempt) {
            sessionRecordingManagerRef.current?.recordCaptureLifecycle({
              stage: "automatic-recovery-succeeded",
              recoveryAttemptId: recoveryAttempt.id,
              recoveryStartedAt: recoveryAttempt.startedAt,
              recoveryDurationMs: Date.now() - recoveryAttempt.startedAt,
              estimatedAudioBlackoutMs: Date.now() - recoveryAttempt.startedAt,
              previousCaptureSessionId:
                recoveryAttempt.previousCaptureSessionId,
              previousCaptureGeneration:
                recoveryAttempt.previousCaptureGeneration,
              nextCaptureSessionId: nativeCaptureSessionId,
              nextCaptureGeneration: nativeCaptureGeneration,
              reason: recoveryAttempt.reason,
              faultInjectionId: recoveryAttempt.faultInjectionId,
            });
            if (recoveryAttempt.faultInjectionId) {
              const faultContext = nativeAudioFaultTracesRef.current.get(
                recoveryAttempt.faultInjectionId
              );
              if (faultContext) {
                faultContext.recoveryOutcome = "success";
                traceStoreRef.current.updateMetadata(faultContext.traceId, {
                  recoveryAttemptId: recoveryAttempt.id,
                  recoveryDurationMs: Date.now() - recoveryAttempt.startedAt,
                  recoveredCaptureSessionId: nativeCaptureSessionId,
                  recoveredCaptureGeneration: nativeCaptureGeneration,
                });
              }
              maybeFinishNativeAudioFaultTrace(
                recoveryAttempt.faultInjectionId
              );
            }
          }
        } catch (error) {
          const authorized = coordinator.authorize(
            lifecycleOperation,
            "commit-start-error"
          );
          if (!authorized && nativeStartAttempted) {
            sessionRecordingManagerRef.current?.recordCaptureLifecycle({
              stage: "stale-native-start-error",
              operationId: lifecycleOperation.id,
              action: lifecycleOperation.action,
              authorized: false,
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          if (!authorized) return;

          activeRef.current = false;
          invalidateAudioProcessingSession();
          if (recoveryAttempt) {
            nativeRecoveryAttemptTimestampsRef.current =
              pruneNativeAudioRecoveryAttempts(
                nativeRecoveryAttemptTimestampsRef.current,
                Date.now(),
                NATIVE_AUDIO_RECOVERY_WINDOW_MS
              );
            sessionRecordingManagerRef.current?.recordCaptureLifecycle({
              stage: "automatic-recovery-failed",
              recoveryAttemptId: recoveryAttempt.id,
              recoveryStartedAt: recoveryAttempt.startedAt,
              recoveryDurationMs: Date.now() - recoveryAttempt.startedAt,
              previousCaptureSessionId:
                recoveryAttempt.previousCaptureSessionId,
              previousCaptureGeneration:
                recoveryAttempt.previousCaptureGeneration,
              reason: recoveryAttempt.reason,
              faultInjectionId: recoveryAttempt.faultInjectionId,
              error: error instanceof Error ? error.message : String(error),
            });
            if (recoveryAttempt.faultInjectionId) {
              const faultContext = nativeAudioFaultTracesRef.current.get(
                recoveryAttempt.faultInjectionId
              );
              if (faultContext) {
                faultContext.recoveryOutcome = "error";
                faultContext.recoveryError =
                  error instanceof Error ? error.message : String(error);
                traceStoreRef.current.updateMetadata(faultContext.traceId, {
                  recoveryAttemptId: recoveryAttempt.id,
                  recoveryDurationMs: Date.now() - recoveryAttempt.startedAt,
                });
              }
              maybeFinishNativeAudioFaultTrace(
                recoveryAttempt.faultInjectionId
              );
            }
          }
          if (manualRecoveryAttempt) {
            sessionRecordingManagerRef.current?.recordCaptureLifecycle({
              stage: "manual-recovery-failed",
              manualRecoveryAttemptId: manualRecoveryAttempt.id,
              recoveryStartedAt: manualRecoveryAttempt.startedAt,
              recoveryDurationMs: Date.now() - manualRecoveryAttempt.startedAt,
              previousCaptureSessionId:
                manualRecoveryAttempt.pending.interruptedCaptureSessionId,
              previousCaptureGeneration:
                manualRecoveryAttempt.pending.interruptedCaptureGeneration,
              reason: manualRecoveryAttempt.pending.reason,
              circuitBreakerOpen:
                manualRecoveryAttempt.pending.circuitBreakerOpen,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          reconcileCaptureStartFailure(
            error instanceof Error
              ? error.message
              : "Failed to start meeting assistant."
          );
        }
      });
    }, [
      cancelActiveAdvisorJob,
      invalidateAudioProcessingSession,
      maybeFinishNativeAudioFaultTrace,
      readNativeCaptureLease,
      prewarmSemanticTaxonomyRuntime,
      selectedAudioDevices.output.id,
      startAudioProcessingSession,
      resetMeetingRuntimeForNewSession,
      state.settings.audio.config,
      state.settings.privacyMode,
      state.settings.useMemory,
      stopNativeMeetingCapture,
      sttProvider,
    ]);

  const start = useCallback(async () => {
    await startCapture("fresh-start");
  }, [startCapture]);

  const resume = useCallback(async () => {
    await startCapture("resume");
  }, [startCapture]);

  const resumeAfterNativeFailure = useCallback(async () => {
    await startCapture("manual-recovery");
  }, [startCapture]);

  const pause = useCallback(async () => {
    const coordinator = captureLifecycleCoordinatorRef.current!;
    const lifecycleOperation = coordinator.claim("pause");
    const nativeLeaseToStop = readNativeCaptureLease();
    cancelNativeAudioFaultTraces("meeting-assistant-paused");
    advanceRuntimeEpoch("meeting-assistant-paused");
    activeRef.current = false;
    invalidateAudioProcessingSession();
    cancelActiveAdvisorJob("meeting-assistant-paused");
    screenAnalysisAbortRef.current?.abort();
    screenAnalysisAbortRef.current = null;

    await coordinator.run(lifecycleOperation, async () => {
      let audioStatus: MeetingAudioStatus | null = null;

      try {
        audioStatus = (await stopNativeMeetingCapture(nativeLeaseToStop)).status;
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
        currentQuestionLineage: previous.currentQuestionLineage
          ? {
              ...previous.currentQuestionLineage,
              runtimeEpoch: runtimeEpochRef.current,
            }
          : undefined,
      }));
    });
  }, [
    advanceRuntimeEpoch,
    cancelNativeAudioFaultTraces,
    cancelActiveAdvisorJob,
    invalidateAudioProcessingSession,
    readNativeCaptureLease,
    stopNativeMeetingCapture,
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
      let screenRuntimeToken = createRuntimeCommitToken({
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
      let screenModelPromptText = "";
      let screenSourceOwnedTransitionResult:
        | SourceOwnedTransitionCommitResult
        | undefined;
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
          {
            ...formatRuntimeCommitAuthorizationForTrace(
              decision,
              stage
            ),
            ...formatSourceOwnedTransitionForTrace(
              screenSourceOwnedTransitionResult,
              {
                committedBeforeModel:
                  screenSourceOwnedTransitionResult?.candidate
                    .state === "committed",
                modelOutcome: "stale-result",
                survivedModelOutcome:
                  sourceOwnedTransitionSurvivesModelOutcome(
                    screenSourceOwnedTransitionResult,
                    "stale-result"
                  ),
              }
            ),
          }
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
        const screenCurrentQuestionEvidenceText =
          screenPreflight?.question?.trim() ?? "";
        const screenEvidenceText = [
          screenCurrentQuestionEvidenceText,
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
        const screenQuestionText = screenPreflight?.question?.trim() ?? "";
        const screenSectionHintConsumption = consumeInterviewSectionHint({
          hint: pendingInterviewSectionHintRef.current,
          questionId: observation.id,
          currentQuestionType: screenTaxonomyDecision.effectiveQuestionType,
          substantive:
            Boolean(screenQuestionText) &&
            calculateWordEquivalent(screenQuestionText) >= 3,
          sessionId: preflightContextState.sessionId,
          runtimeEpoch: runtimeEpochRef.current,
        });
        pendingInterviewSectionHintRef.current =
          screenSectionHintConsumption.nextHint;
        if (screenSectionHintConsumption.disposition !== "no-hint") {
          const sectionHintMetadata = {
            ...formatInterviewSectionHintForTrace(
              screenSectionHintConsumption
            ),
            sectionHintClassificationBefore:
              screenTaxonomyDecision.effectiveQuestionType,
            sectionHintQuestionSource: "screen",
          };
          traceStoreRef.current.updateMetadata(trace.id, sectionHintMetadata);
          sessionRecordingManagerRef.current?.recordCaptureLifecycle({
            stage: "interview-section-hint-consumed",
            traceId: trace.id,
            ...sectionHintMetadata,
          });
        }
        const screenMemoryQuestionType =
          screenSectionHintConsumption.disposition === "applied"
            ? screenSectionHintConsumption.effectiveQuestionType
            : screenTaxonomyDecision.effectiveQuestionType;
        const taskKind =
          normalizeScreenQuestionType(screenMemoryQuestionType) ?? "unknown";
        traceStoreRef.current.updateMetadata(trace.id, {
          ...formatTaskTaxonomyAuthorityForTrace(screenTaxonomyDecision),
          screenSourceEvidenceChars: screenEvidenceText.length,
        });
        const screenMemoryAskFrame = inferMemoryAskFrameFromScreenPreflight(
          screenCurrentQuestionEvidenceText,
          screenPreflight
        );
        const screenMemoryTopicDomain =
          inferMemoryTopicDomainFromScreenPreflight(
            screenCurrentQuestionEvidenceText,
            screenPreflight
          );
        const buildScreenEvidencePacket = (
          contextState: MeetingContextState
        ) => {
          const amazonLeadershipPrincipleHint =
            buildAmazonLeadershipPrincipleMemoryHint(
              contextState.interviewSessionContext,
              screenCurrentQuestionEvidenceText
            );
          return buildAdvisorEvidencePacket({
            currentQuestion: screenCurrentQuestionEvidenceText
              ? {
                  text: screenCurrentQuestionEvidenceText,
                  source: "screen-preflight",
                  sourceTurnIds: [],
                  screenObservationId: observation.id,
                }
              : undefined,
            activeMeetingTask: contextState.activeMeetingTask,
            interviewSessionBrief:
              contextState.interviewSessionBrief,
            interviewSessionContext:
              contextState.interviewSessionContext,
            activatedFactIds:
              contextState.activeMeetingTask?.parent
                .supportedFactAnchors ??
              contextState.activeInterviewTask
                ?.supportedFactAnchors,
            additionalRetrievalHints: [
              screenMemoryAskFrame !== "unknown"
                ? {
                    role: "source-metadata" as const,
                    text: `ask frame: ${screenMemoryAskFrame}`,
                  }
                : undefined,
              screenMemoryTopicDomain !== "unknown"
                ? {
                    role: "source-metadata" as const,
                    text: `topic domain: ${screenMemoryTopicDomain}`,
                  }
                : undefined,
              screenPreflight?.projectAnchor
                ? {
                    role: "source-metadata" as const,
                    text: `project anchor: ${screenPreflight.projectAnchor}`,
                  }
                : undefined,
              screenPreflight?.isBehavioralInterview
                ? {
                    role: "source-metadata" as const,
                    text: "use case: behavioral interview",
                  }
                : undefined,
              observation.captureTarget?.appName
                ? {
                    role: "source-metadata" as const,
                    text: `app: ${observation.captureTarget.appName}`,
                  }
                : undefined,
              observation.captureTarget?.title
                ? {
                    role: "source-metadata" as const,
                    text: `title: ${observation.captureTarget.title}`,
                  }
                : undefined,
              autoPrompt?.trim()
                ? {
                    role: "preparation-guidance" as const,
                    text: autoPrompt,
                  }
                : undefined,
              amazonLeadershipPrincipleHint
                ? {
                    role: "source-metadata" as const,
                    text: amazonLeadershipPrincipleHint,
                  }
                : undefined,
            ].filter(
              (
                hint
              ): hint is {
                role:
                  | "source-metadata"
                  | "preparation-guidance";
                text: string;
              } => Boolean(hint)
            ),
          });
        };
        let screenEvidencePacket =
          buildScreenEvidencePacket(preflightContextState);
        let screenMemoryQuery =
          buildAdvisorEvidenceRetrievalQuery(
            screenEvidencePacket,
            "screen-task"
          );
        const screenTaskRelationDecision = decideScreenTaskRelation({
          existingTask:
            preflightContextState.activeInterviewTask ??
            (preflightContextState.activeMeetingTask?.screen &&
            preflightContextState.activeScreenTask
              ? buildInterviewParentFromScreenTask(
                  preflightContextState.activeScreenTask
                )
              : undefined),
          taskKind,
          question:
            screenCurrentQuestionEvidenceText ||
            observation.captureTarget?.title ||
            "",
          screenEvidenceText,
          screenPreflight,
          corrections: speechCorrectionsRef.current,
        });
        const provisionalScreenTaskRelation =
          screenSectionHintConsumption.disposition === "applied"
            ? "new-parent"
            : screenTaskRelationDecision.relation;
        traceStoreRef.current.updateMetadata(trace.id, {
          screenTaskRelation: provisionalScreenTaskRelation,
          screenTaskRelationReason:
            screenSectionHintConsumption.disposition === "applied"
              ? "explicit-section-hint"
              : screenTaskRelationDecision.reason,
          screenTaskRelationConfidence:
            screenSectionHintConsumption.disposition === "applied"
              ? 1
              : screenTaskRelationDecision.confidence,
          screenTaskRelationCommittedBeforeModel: false,
        });
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
            provisionalScreenTaskRelation === "new-parent"
              ? screenPlaybook?.phase
              : preflightContextState.activeMeetingTask?.parent.playbookPhase ??
                preflightContextState.activeInterviewTask?.playbookPhase ??
                screenPlaybook?.phase,
          phaseProgress:
            provisionalScreenTaskRelation === "new-parent"
              ? undefined
              : preflightContextState.activeMeetingTask?.parent.phaseProgress ??
                preflightContextState.activeInterviewTask?.phaseProgress,
          latestTurnText: recentTranscript,
          currentQuestion: screenCurrentQuestionEvidenceText,
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

        const screenTransitionParentBefore =
          preflightContextState.activeInterviewTask ??
          (preflightContextState.activeMeetingTask?.screen &&
          preflightContextState.activeScreenTask
            ? buildInterviewParentFromScreenTask(
                preflightContextState.activeScreenTask
              )
            : undefined);
        const screenTransitionCandidate =
          createSourceOwnedTransitionCandidate({
            sessionId: preflightContextState.sessionId,
            runtimeEpoch: runtimeEpochRef.current,
            source: "screen",
            sourceObservationIds: [observation.id],
            existingTask: screenTransitionParentBefore,
            relation: provisionalScreenTaskRelation,
            authoritySource:
              screenSectionHintConsumption.disposition === "applied"
                ? "explicit-section-hint"
                : "screen-preflight",
            mutationAuthorized: readScreenAuthorization().authorized,
            questionType: screenMemoryQuestionType,
            question:
              screenCurrentQuestionEvidenceText ||
              observation.captureTarget?.title?.trim() ||
              "",
            subtaskIntent: inferAdvisorSubtaskIntent(
              screenEvidenceText,
              readMemoryQuestionType(taskKind) ?? "unknown"
            ),
            questionInstanceId: observation.id,
            playbook: screenRuntimePlaybook,
            phaseDecision: screenPhaseDecision,
            expiresAt: getActiveScreenTaskExpiresAt(state.settings),
          });
        if (screenTransitionCandidate) {
          screenSourceOwnedTransitionResult =
            commitSourceOwnedTransition({
              candidate: screenTransitionCandidate,
              currentTask: screenTransitionParentBefore,
              currentSessionId: preflightContextState.sessionId,
              currentRuntimeEpoch: runtimeEpochRef.current,
            });
          const screenTransitionCommitted =
            screenSourceOwnedTransitionResult.candidate.state ===
            "committed";
          const screenTransitionMetadata =
            formatSourceOwnedTransitionForTrace(
              screenSourceOwnedTransitionResult,
              {
                committedBeforeModel: screenTransitionCommitted,
              }
            );
          traceStoreRef.current.updateMetadata(trace.id, {
            ...screenTransitionMetadata,
            screenTaskRelationCommittedBeforeModel:
              screenTransitionCommitted,
          });
          const screenTransitionStepId =
            traceStoreRef.current.startStep(
              trace.id,
              "Source-owned task transition",
              screenTransitionMetadata
            );
          traceStoreRef.current.finishStep(
            trace.id,
            screenTransitionStepId,
            screenTransitionCommitted ? "success" : "error",
            undefined,
            screenSourceOwnedTransitionResult.candidate
              .rejectionReason
          );

          if (screenTransitionCommitted) {
            contextManagerRef.current.setActiveMeetingTaskState({
              activeScreenTask:
                screenTransitionCandidate.kind === "new-parent"
                  ? null
                  : preflightContextState.activeScreenTask,
              activeInterviewTask:
                screenSourceOwnedTransitionResult.task ?? null,
            });
            recordCommittedPlaybookPhaseTransition({
              operationId:
                screenSourceOwnedTransitionResult.candidate.id,
              source: "automatic",
              before: screenTransitionParentBefore,
              after: screenSourceOwnedTransitionResult.task,
              traceId: trace.id,
            });
            screenRuntimeToken = rebaseRuntimeCommitToken({
              token: screenRuntimeToken,
              snapshot: readRuntimeCommitSnapshot(),
            });
            const committedScreenContext =
              contextManagerRef.current.getState();
            setState((previous) => ({
              ...previous,
              activeInterviewTask:
                committedScreenContext.activeInterviewTask,
              activeMeetingTask:
                committedScreenContext.activeMeetingTask,
            }));
            traceStoreRef.current.updateMetadata(trace.id, {
              runtimeCommitTokenRebased: true,
              runtimeCommitTokenRebaseReason:
                "source-owned-screen-transition-committed-before-model",
              ...getActiveMeetingTaskTraceMetadata(
                committedScreenContext.activeMeetingTask
              ),
            });
            if (committedScreenContext.activeMeetingTask) {
              sessionRecordingManagerRef.current?.recordActiveMeetingTaskSnapshot(
                committedScreenContext.activeMeetingTask,
                trace.id
              );
            }
          }
        }
        const screenSourceTransitionCommittedBeforeModel =
          screenSourceOwnedTransitionResult?.candidate.state ===
          "committed";
        const screenSourceTransitionAllowsTaskMutation =
          !screenSourceOwnedTransitionResult ||
          screenSourceTransitionCommittedBeforeModel;
        const screenExecutionContextState =
          contextManagerRef.current.getState();
        screenEvidencePacket = buildScreenEvidencePacket(
          screenExecutionContextState
        );
        screenMemoryQuery =
          buildAdvisorEvidenceRetrievalQuery(
            screenEvidencePacket,
            "screen-task"
          );
        const screenEvidencePacketMetadata =
          formatAdvisorEvidencePacketForTrace(
            screenEvidencePacket,
            screenMemoryQuery
          );
        traceStoreRef.current.updateMetadata(
          trace.id,
          screenEvidencePacketMetadata
        );
        const screenEvidencePacketStepId =
          traceStoreRef.current.startStep(
            trace.id,
            "Advisor evidence packet built",
            screenEvidencePacketMetadata
          );
        traceStoreRef.current.finishStep(
          trace.id,
          screenEvidencePacketStepId,
          "success"
        );
        const existingScreenProjectBinding =
          screenExecutionContextState.activeMeetingTask?.parent
            .projectBinding ??
          screenExecutionContextState.activeInterviewTask?.projectBinding;
        const screenRetrievalProjectAnchor =
          provisionalScreenTaskRelation === "new-parent"
            ? screenPreflight?.projectAnchor
            : existingScreenProjectBinding?.projectName ??
              existingScreenProjectBinding?.projectId ??
              screenPreflight?.projectAnchor;
        const screenDiagramDomainContext =
          buildCurrentTaskDiagramDomainContext({
            currentQuestion: screenPreflight?.question,
            parentTopic:
              screenExecutionContextState.activeMeetingTask?.parent.topic ??
              screenExecutionContextState.activeInterviewTask?.topic,
            relation: provisionalScreenTaskRelation,
            captureTitleFallback: observation.captureTarget?.title,
          });
        const screenPersonalEvidenceDecision =
          detectPersonalEvidenceRequirement({
            questionText: screenCurrentQuestionEvidenceText,
            questionType: screenMemoryQuestionType,
            mode: state.settings.personalEvidenceGuardrailMode,
          });
        const memoryContext = await loadMemoryForPrompt({
          traceId: trace.id,
          source: "screen",
          query: screenMemoryQuery,
          currentQuestionEvidenceText:
            screenCurrentQuestionEvidenceText,
          diagramDomainContext: screenDiagramDomainContext,
          diagramTopicDomain:
            screenPreflight?.topicDomain ??
            inferMemoryTopicDomainFromQuery(screenDiagramDomainContext.query),
          useCase: inferMemoryUseCaseFromQuery(
            screenCurrentQuestionEvidenceText
          ),
          questionType: screenMemoryQuestionType,
          askFrame: screenMemoryAskFrame,
          topicDomain: screenMemoryTopicDomain,
          projectAnchor: screenRetrievalProjectAnchor,
          memoryPolicy: screenRuntimePlaybook?.memoryPolicy,
          personalEvidenceDecision: screenPersonalEvidenceDecision,
          forceStrictProjectAnchor: Boolean(
            existingScreenProjectBinding &&
              provisionalScreenTaskRelation !== "new-parent"
          ),
          runtimeToken: screenRuntimeToken,
          currentOperationId: () => activeScreenOperationIdRef.current,
        });
        if (rejectStaleScreenOperation("post-memory")) return;
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
          questionText: screenCurrentQuestionEvidenceText,
          personalEvidenceGuardrailMode:
            state.settings.personalEvidenceGuardrailMode,
          memoryContext,
          confirmedMeFacts: collectConfirmedMeFacts(
            screenExecutionContextState.transcriptTurns
          ),
          activeFactAnchors:
            screenExecutionContextState.activeMeetingTask?.parent
              .supportedFactAnchors ??
            screenExecutionContextState.activeInterviewTask
              ?.supportedFactAnchors ??
            [],
          projectAnchor: screenPreflight?.projectAnchor,
          personalEvidenceDecision: screenPersonalEvidenceDecision,
          projectBindingDecision: screenProjectBindingDecision,
        });
        const holdScreenPartialForFactAnchor =
          screenFactAnchorDecision.requiredFor !== "none";
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
          factAnchorPartialOutputHeld: holdScreenPartialForFactAnchor,
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
            advisorEvidencePacket: screenEvidencePacket,
            interviewSessionBrief:
              screenExecutionContextState.interviewSessionBrief,
            interviewSessionContext:
              screenExecutionContextState.interviewSessionContext,
            screenPreflight,
            interviewPlaybook: screenRuntimePlaybook,
            playbookPhaseDecision: screenPhaseDecision,
            activeMeetingTask:
              screenExecutionContextState.activeMeetingTask,
            factAnchorDecision: screenFactAnchorDecision,
            projectBindingDecision: screenProjectBindingDecision,
            signal: analysisController.signal,
            requestOptions: screenModelRequestOptions,
            trace: {
              onRequest: (input) => {
                const modelRequestStartedAt = Date.now();
                screenModelPromptText = formatTraceModelInput(
                  input.systemPrompt,
                  input.userMessage
                );
                traceStoreRef.current.recordInput(
                  trace.id,
                  "screen model input",
                  screenModelPromptText,
                  {
                    providerId: input.providerId,
                    mode: input.mode,
                    imageCount: input.imageCount,
                    imageMediaType: input.imageMediaType,
                    responseConfig: input.responseConfig,
                    requestOptions: input.requestOptions,
                    ...screenModelRouteMetadata,
                    ...formatSourceOwnedTransitionForTrace(
                      screenSourceOwnedTransitionResult,
                      {
                        committedBeforeModel:
                          screenSourceTransitionCommittedBeforeModel,
                        modelRequestStartedAt,
                      }
                    ),
                    imageBase64Stored: false,
                  }
                );
                sessionRecordingManagerRef.current?.recordModelInput({
                  traceId: trace.id,
                  label: "screen model input",
                  value: screenModelPromptText,
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

              if (!holdScreenPartialForFactAnchor) {
                setState((previous) => ({
                  ...previous,
                  status: "thinking",
                  partialSuggestion: partialContent,
                }));
              }
            },
          }),
          screenModelRequestOptions?.timeoutMs ?? SCREEN_ANALYSIS_TIMEOUT_MS,
          "Screen context analysis timed out."
        );

        if (screenAnalysisAbortRef.current !== analysisController) {
          traceStoreRef.current.updateMetadata(
            trace.id,
            formatSourceOwnedTransitionForTrace(
              screenSourceOwnedTransitionResult,
              {
                committedBeforeModel:
                  screenSourceTransitionCommittedBeforeModel,
                modelOutcome: "cancelled",
                survivedModelOutcome:
                  sourceOwnedTransitionSurvivesModelOutcome(
                    screenSourceOwnedTransitionResult,
                    "cancelled"
                  ),
              }
            )
          );
          traceStoreRef.current.finishStep(
            trace.id,
            modelStepId,
            "cancelled"
          );
          traceStoreRef.current.finishTrace(trace.id, "cancelled");
          return;
        }
        if (rejectStaleScreenOperation("post-model")) return;

        const screenAnswerProfile = resolveMeetingAnswerProfile(taskKind);
        let parsedScreenMeetingAnswer = parseMeetingAnswer(screenTaskContent, {
          expectedProfile: screenAnswerProfile,
        });
        const screenFactAnchorOutputDecision = enforceFactAnchorOutput({
          decision: screenFactAnchorDecision,
          parsedAnswer: parsedScreenMeetingAnswer,
          expectedProfile: screenAnswerProfile,
        });
        const committedScreenTaskContent =
          screenFactAnchorOutputDecision.effectiveContent;
        parsedScreenMeetingAnswer =
          screenFactAnchorOutputDecision.effectiveAnswer;
        const screenFactAnchorOutputMetadata =
          formatFactAnchorOutputDecisionForTrace(
            screenFactAnchorOutputDecision,
            {
              partialOutputHeld: holdScreenPartialForFactAnchor,
            }
          );
        traceStoreRef.current.updateMetadata(
          trace.id,
          screenFactAnchorOutputMetadata
        );
        const screenFactAnchorOutputStepId =
          traceStoreRef.current.startStep(
            trace.id,
            "Fact anchor output authorization",
            screenFactAnchorOutputMetadata
          );
        traceStoreRef.current.finishStep(
          trace.id,
          screenFactAnchorOutputStepId,
          "success"
        );
        sessionRecordingManagerRef.current?.recordFactAnchorDecision(
          trace.id,
          {
            source: "screen-output",
            questionType: screenMemoryQuestionType,
            ...screenFactAnchorOutputMetadata,
          }
        );
        const screenMeetingAnswerSummary = buildMeetingAnswerSummary(
          parsedScreenMeetingAnswer
        );
        const screenMeetingAnswerMetadata = formatMeetingAnswerTraceMetadata(
          parsedScreenMeetingAnswer,
          screenMeetingAnswerSummary
        );
        const screenModelOutcome =
          committedScreenTaskContent.trim() &&
          committedScreenTaskContent.trim() !== "-"
            ? "success"
            : "empty-output";
        traceStoreRef.current.updateMetadata(
          trace.id,
          {
            ...screenMeetingAnswerMetadata,
            ...formatSourceOwnedTransitionForTrace(
              screenSourceOwnedTransitionResult,
              {
                committedBeforeModel:
                  screenSourceTransitionCommittedBeforeModel,
                modelOutcome: screenModelOutcome,
                survivedModelOutcome:
                  screenModelOutcome === "empty-output" &&
                  sourceOwnedTransitionSurvivesModelOutcome(
                    screenSourceOwnedTransitionResult,
                    "empty-output"
                  ),
              }
            ),
          }
        );
        const screenQuestionForSufficiency =
          screenPreflight?.question?.trim() ??
          observation.captureTarget?.title?.trim() ??
          "";
        if (screenQuestionForSufficiency) {
          const sufficiencyMeetingContext =
            contextManagerRef.current.getState();
          const canonicalScreenQuestionType =
            normalizeCanonicalQuestionType(taskKind) ?? "unknown";
          const screenLogicalQuestionUnit =
            buildScreenAnswerSufficiencyLogicalQuestionUnit({
              observationId: observation.id,
              question: screenQuestionForSufficiency,
              sessionId: sufficiencyMeetingContext.sessionId,
              runtimeEpoch: runtimeEpochRef.current,
              createdAt: observation.capturedAt,
            });
          const answerRevision =
            (answerRevisionByQuestionRef.current.get(
              screenLogicalQuestionUnit.id
            ) ?? 0) + 1;
          answerRevisionByQuestionRef.current.set(
            screenLogicalQuestionUnit.id,
            answerRevision
          );
          const answerSufficiencyDecision =
            evaluateRuntimeAnswerSufficiencyShadow({
              traceId: trace.id,
              questionId: screenLogicalQuestionUnit.id,
              logicalQuestionUnit: screenLogicalQuestionUnit,
              answerRevision,
              questionType: canonicalScreenQuestionType,
              answerProfile: resolveMeetingAnswerProfile(taskKind),
              parsedAnswer: parsedScreenMeetingAnswer,
              factAnchorRequired:
                screenFactAnchorDecision.requiredFor !== "none",
              factAnchorAvailable:
                screenFactAnchorDecision.state !== "no-anchor",
              currentTurnAction: "answer",
              relation: provisionalScreenTaskRelation,
              meetingContext: sufficiencyMeetingContext,
              basePromptContext:
                contextManagerRef.current.buildAdvisorPromptContext(),
              originalModelPromptText: screenModelPromptText,
            });
          traceStoreRef.current.updateMetadata(
            trace.id,
            formatAnswerSufficiencyDecisionForTrace(
              answerSufficiencyDecision
            )
          );
          sessionRecordingManagerRef.current?.recordAnswerSufficiencyDecision({
            traceId: trace.id,
            taskId: sufficiencyMeetingContext.activeMeetingTask?.id,
            decision: answerSufficiencyDecision,
          });
          scheduleAnswerSufficiencySemanticShadow({
            traceId: trace.id,
            taskId: sufficiencyMeetingContext.activeMeetingTask?.id,
            questionText: screenLogicalQuestionUnit.normalizedText,
            parsedAnswer: parsedScreenMeetingAnswer,
            decision: answerSufficiencyDecision,
          });
        }

        traceStoreRef.current.finishStep(trace.id, modelStepId, "success", {
          outputChars: committedScreenTaskContent.length,
          ...screenModelRouteMetadata,
          ...screenMeetingAnswerMetadata,
        });
        screenAnalysisAbortRef.current = null;

        contextManagerRef.current.updateScreenObservation(observation.id, {
          visualSummary: committedScreenTaskContent,
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
        let screenStartedNewInterviewParent = Boolean(
          screenSourceTransitionCommittedBeforeModel &&
            screenSourceOwnedTransitionResult?.candidate.kind ===
              "new-parent" &&
            screenSourceOwnedTransitionResult.mutationApplied
        );
        let screenTaskResultCommitted = false;
        const screenResultScopeDecision = decideScreenResultScope({
          questionType: taskKind,
          hasAnswer: Boolean(
            committedScreenTaskContent.trim() &&
              committedScreenTaskContent.trim() !== "-"
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

        if (
          screenResultScopeDecision.action === "replace" &&
          screenSourceTransitionAllowsTaskMutation
        ) {
          const existingInterviewTask = updatedContextState.activeInterviewTask;
          const screenLanguage = inferTrustedProgrammingLanguage({
            screenPreflightLanguage: screenPreflight?.programmingLanguage,
            textHints: [screenPreflight?.question, recentTranscript],
            codeFenceContent: committedScreenTaskContent,
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
            content: committedScreenTaskContent,
            basedOnTurnIds,
            basedOnObservationId: observation.id,
          };

          const screenRelationDecision = {
            relation: provisionalScreenTaskRelation,
            reason:
              screenSectionHintConsumption.disposition === "applied"
                ? "explicit-section-hint"
                : screenTaskRelationDecision.reason,
            confidence:
              screenSectionHintConsumption.disposition === "applied"
                ? 1
                : screenTaskRelationDecision.confidence,
          };
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

          const screenResponseOwner = resolveMeetingResponseOwner({
            preBoundaryType: existingInterviewTask?.stableKind,
            postBoundaryParentType: existingInterviewTask?.stableKind,
            proposedQuestionType: screenMemoryQuestionType,
            relation: screenRelationDecision.relation,
            taskBoundaryCommitted:
              screenSourceTransitionCommittedBeforeModel &&
              screenSourceOwnedTransitionResult?.candidate.kind ===
                "new-parent",
            childOwnsResponse:
              screenRelationDecision.relation === "child-probe" &&
              (!screenSourceOwnedTransitionResult ||
                screenSourceTransitionCommittedBeforeModel),
          });
          const screenArtifactAuthorization =
            authorizeResponseArtifactMutation({
              parentTaskId: existingInterviewTask?.id,
              parentQuestionType:
                existingInterviewTask?.stableKind ??
                (screenRelationDecision.relation === "new-parent"
                  ? screenMemoryQuestionType
                  : undefined),
              responseOwnerQuestionType: screenResponseOwner.questionType,
              responseOwnerSource: screenResponseOwner.source,
              relation: screenRelationDecision.relation,
              creatingParent:
                !existingInterviewTask &&
                screenRelationDecision.relation === "new-parent",
            });
          const screenContinuityRelation: InterviewTaskRelation =
            screenSourceTransitionCommittedBeforeModel &&
            screenSourceOwnedTransitionResult?.candidate.kind ===
              "new-parent"
              ? "followup-parent"
              : screenRelationDecision.relation;
          const screenContinuity = updateInterviewTaskContinuityForAnswer({
            existingTask: existingInterviewTask,
            source: "screen",
            questionType: taskKind,
            relation: screenContinuityRelation,
            subtaskIntent: inferAdvisorSubtaskIntent(
              screenEvidenceText,
              readMemoryQuestionType(taskKind) ?? "unknown"
            ),
            question: screenTaskTopic,
            finalContent: committedScreenTaskContent,
            parsedAnswer: parsedScreenMeetingAnswer,
            playbook: screenRuntimePlaybook,
            phaseDecision: screenSourceTransitionCommittedBeforeModel
              ? undefined
              : screenPhaseDecision,
            sourceTransitionPrecommitted:
              screenSourceTransitionCommittedBeforeModel,
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
            artifactAuthorization: screenArtifactAuthorization,
          });
          const previousWhiteboard =
            existingInterviewTask?.whiteboardArtifact;
          const nextWhiteboard = screenContinuity.task?.whiteboardArtifact;
          traceStoreRef.current.updateMetadata(trace.id, {
            ...formatMeetingResponseOwnerForTrace(screenResponseOwner),
            ...formatResponseArtifactAuthorizationForTrace(
              screenArtifactAuthorization
            ),
            answerCodeArtifactDecision: parsedScreenMeetingAnswer.sections.code
              ? screenArtifactAuthorization.allowCode
                ? "produced"
                : "ignored"
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
          if (!screenSourceTransitionCommittedBeforeModel) {
            recordCommittedPlaybookPhaseTransition({
              operationId: `phase-screen-${trace.id}`,
              source: "automatic",
              before: existingInterviewTask,
              after: screenContinuity.task,
              traceId: trace.id,
            });
          }
          contextManagerRef.current.setActiveMeetingTaskState({
            activeScreenTask,
            activeInterviewTask: screenContinuity.task ?? null,
          });
          screenStartedNewInterviewParent =
            screenStartedNewInterviewParent ||
            screenContinuity.startedNewParent;
          screenTaskResultCommitted = true;
          traceStoreRef.current.updateMetadata(trace.id, {
            activeInterviewParentId: screenContinuity.task?.id,
            activeInterviewParentKind: screenContinuity.task?.stableKind,
            activeInterviewParentPhase: screenContinuity.task?.playbookPhase,
            startedNewInterviewParent: screenContinuity.startedNewParent,
          });
        }

        updatedContextState = contextManagerRef.current.getState();
        const screenTaskContextCommitted =
          screenTaskResultCommitted ||
          screenSourceTransitionCommittedBeforeModel;
        traceStoreRef.current.updateMetadata(trace.id, {
          ...formatScreenScopeDecisionForTrace(screenResultScopeDecision, {
            stage: "commit",
            mutationApplied:
              screenTaskResultCommitted &&
              screenScopePreviousState.activeScreenTask?.id !==
                updatedContextState.activeScreenTask?.id,
            previousScreenTaskId:
              screenScopePreviousState.activeScreenTask?.id,
            nextScreenTaskId:
              screenTaskResultCommitted
                ? updatedContextState.activeScreenTask?.id
                : undefined,
            previousParentId:
              screenScopePreviousState.activeMeetingTask?.parent.id ??
              screenScopePreviousState.activeInterviewTask?.id,
            nextParentId:
              screenTaskContextCommitted
                ? updatedContextState.activeMeetingTask?.parent.id ??
                  updatedContextState.activeInterviewTask?.id
                : undefined,
          }),
          ...(screenTaskContextCommitted
            ? getActiveMeetingTaskTraceMetadata(
                updatedContextState.activeMeetingTask
              )
            : {}),
        });
        if (
          screenTaskResultCommitted &&
          updatedContextState.activeScreenTask
        ) {
          sessionRecordingManagerRef.current?.recordTaskSnapshot(
            updatedContextState.activeScreenTask,
            trace.id
          );
        }
        if (
          screenTaskContextCommitted &&
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
            ...(screenTaskContextCommitted
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
            suggestionKind: committedScreenTaskContent.trim()
              ? "answer"
              : "silent",
          }
        );

        const nextSuggestion: AdvisorSuggestion =
          committedScreenTaskContent.trim()
          ? {
              id: requestId,
              sourceTraceId: trace.id,
              kind: "answer",
              content: committedScreenTaskContent.trim(),
              meetingAnswer: parsedScreenMeetingAnswer,
              answerProfile: parsedScreenMeetingAnswer.profile,
              createdAt: Date.now(),
              ...(screenTaskContextCommitted
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
              ...(screenTaskContextCommitted
                ? buildSuggestionTaskMetadata(
                    updatedContextState.activeMeetingTask
                  )
                : {}),
              basedOnTurnIds,
              basedOnObservationIds: [observation.id],
              confidence: "low",
            };
        const screenQuestionLineage = attachQuestionLineageToSuggestion(
          updatedContextState.activeMeetingTask
            ? promoteQuestionLineage(
                createAuthorizedQuestionLineage({
                  traceId: trace.id,
                  triggerTurnId: basedOnTurnIds[basedOnTurnIds.length - 1],
                  sessionId: updatedContextState.sessionId,
                  runtimeEpoch: screenRuntimeToken.runtimeEpoch,
                  action: "answer-refresh",
                  executionAuthorized: nextSuggestion.kind !== "silent",
                })
              )
            : createAuthorizedQuestionLineage({
                traceId: trace.id,
                triggerTurnId: basedOnTurnIds[basedOnTurnIds.length - 1],
                sessionId: updatedContextState.sessionId,
                runtimeEpoch: screenRuntimeToken.runtimeEpoch,
                action: "answer-refresh",
                executionAuthorized: nextSuggestion.kind !== "silent",
              }),
          nextSuggestion
        );
        nextSuggestion.questionLineage = screenQuestionLineage;
        traceStoreRef.current.updateMetadata(
          trace.id,
          formatQuestionLineageForTrace(screenQuestionLineage)
        );

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
          currentQuestionLineage: screenQuestionLineage,
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
          traceStoreRef.current.updateMetadata(
            trace.id,
            formatSourceOwnedTransitionForTrace(
              screenSourceOwnedTransitionResult,
              {
                committedBeforeModel:
                  screenSourceOwnedTransitionResult?.candidate
                    .state === "committed",
                modelOutcome: "cancelled",
                survivedModelOutcome:
                  sourceOwnedTransitionSurvivesModelOutcome(
                    screenSourceOwnedTransitionResult,
                    "cancelled"
                  ),
              }
            )
          );
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
        traceStoreRef.current.updateMetadata(
          trace.id,
          formatSourceOwnedTransitionForTrace(
            screenSourceOwnedTransitionResult,
            {
              committedBeforeModel:
                screenSourceOwnedTransitionResult?.candidate
                  .state === "committed",
              modelOutcome: "error",
              survivedModelOutcome:
                sourceOwnedTransitionSurvivesModelOutcome(
                  screenSourceOwnedTransitionResult,
                  "error"
                ),
            }
          )
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
      recordCommittedPlaybookPhaseTransition,
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
      const latestCanonicalTarget = latestForceAdviseTargetRef.current;
      const canonicalTargetIsLatest = Boolean(
        latestCanonicalTarget &&
          (latestCanonicalTarget.presentation.originalTraceId ===
            state.latestSuggestion?.sourceTraceId ||
            latestCanonicalTarget.presentation.updatedAt >=
              (state.latestSuggestion?.createdAt ?? 0))
      );
      const canonicalTargetAuthorization =
        latestCanonicalTarget && canonicalTargetIsLatest
          ? authorizeLogicalQuestionUnitLease(
              latestCanonicalTarget.logicalQuestionLease,
              logicalQuestionUnitRef.current
            )
          : undefined;
      if (
        latestCanonicalTarget &&
        canonicalTargetIsLatest &&
        canonicalTargetAuthorization &&
        !canonicalTargetAuthorization.authorized
      ) {
        traceStoreRef.current.updateMetadata(
          latestCanonicalTarget.presentation.originalTraceId,
          {
            ...formatLogicalQuestionLeaseForTrace(
              latestCanonicalTarget.logicalQuestionLease,
              canonicalTargetAuthorization,
              "manual-correction-click"
            ),
            manualCorrectionOwnershipAuthorized: false,
            manualCorrectionOwnershipReason:
              canonicalTargetAuthorization.reason,
          }
        );
        setState((previous) => ({
          ...previous,
          error:
            "The interviewer moved to a newer question. Correct the latest question instead.",
        }));
        return;
      }
      const canonicalCorrectionTarget =
        latestCanonicalTarget &&
        canonicalTargetIsLatest &&
        canonicalTargetAuthorization?.authorized
          ? latestCanonicalTarget
          : undefined;
      const targetResolution = resolveManualCorrectionTarget({
        activeTask,
        currentQuestionLineage: state.currentQuestionLineage,
        canonicalLogicalQuestion: canonicalCorrectionTarget
          ? {
              logicalQuestionUnit:
                canonicalCorrectionTarget.logicalQuestionUnit,
              lineage: canonicalCorrectionTarget.questionLineage,
            }
          : undefined,
        latestSuggestion: state.latestSuggestion,
        sessionId: contextState.sessionId,
        runtimeEpoch: runtimeEpochRef.current,
      });
      if (targetResolution.source === "none") {
        setState((previous) => ({
          ...previous,
          error: "There is no active question to correct.",
        }));
        return;
      }

      const questionOnlyLineage =
        targetResolution.source === "provisional-question"
          ? targetResolution.lineage
          : undefined;
      const provisionalLineage =
        questionOnlyLineage?.identityState === "provisional"
          ? questionOnlyLineage
          : undefined;
      const correctionLineage = targetResolution.lineage;
      const correctionLogicalQuestionUnit =
        targetResolution.logicalQuestionUnit;
      const correctionLogicalQuestionLease =
        correctionLogicalQuestionUnit
          ? createLogicalQuestionUnitLease(
              correctionLogicalQuestionUnit
            )
          : undefined;
      const initialDecision = activeTask
        ? decideManualQuestionTypeCorrection(activeTask, correctedType)
        : decideProvisionalQuestionTypeCorrection(correctedType);
      const boundaryReassertionCandidate = Boolean(
        activeTask &&
          correctionLineage &&
          initialDecision.noOp &&
          initialDecision.reason === "already-effective-question-type"
      );
      const decision = boundaryReassertionCandidate
        ? {
            ...initialDecision,
            noOp: false,
            target: "parent" as const,
            reason: "manual-correction-reasserts-current-question-boundary",
          }
        : initialDecision;
      if (decision.noOp || !decision.target) return;

      const correctionOriginTurn = correctionLineage?.triggerTurnId
        ? contextState.transcriptTurns.find(
            (turn) => turn.id === correctionLineage.triggerTurnId
          )
        : undefined;
      const parentOriginTurn = activeTask?.parent.startTurnId
        ? contextState.transcriptTurns.find(
            (turn) => turn.id === activeTask.parent.startTurnId
          )
        : undefined;
      const correctionQuestionText =
        correctionLogicalQuestionUnit?.normalizedText ??
        correctionOriginTurn?.text ??
        state.latestSuggestion?.meetingAnswer?.sections.question ??
        activeTask?.child?.question ??
        activeTask?.screen?.question ??
        activeTask?.parent.topic ??
        "";
      const correctionScopeDecision = decideManualCorrectionScope({
        task: activeTask,
        decision,
        lineage: correctionLineage,
        latestQuestionText: correctionQuestionText,
        parentQuestionText:
          parentOriginTurn?.text ?? activeTask?.parent.topic,
        classifierConfidence: activeTask?.screen?.classifierConfidence,
        currentQuestionMatchesParentOrigin: Boolean(
          correctionLineage?.sourceSuggestionId &&
            correctionLineage.sourceSuggestionId === state.latestSuggestion?.id &&
            activeTask?.parent.startObservationId &&
            state.latestSuggestion?.basedOnObservationIds.includes(
              activeTask.parent.startObservationId
            )
        ),
      });
      if (
        boundaryReassertionCandidate &&
        correctionScopeDecision.scope !== "linked-parent-extension" &&
        correctionScopeDecision.scope !== "independent-new-parent"
      ) {
        return;
      }

      const existingParent =
        contextState.activeInterviewTask ??
        (contextState.activeScreenTask
          ? buildInterviewParentFromScreenTask(contextState.activeScreenTask)
          : undefined) ??
        (activeTask
          ? buildCorrectionParentFromActiveMeetingTask(
              activeTask,
              correctedType
            )
          : buildCorrectionParentFromProvisionalQuestion({
              lineage: questionOnlyLineage,
              correctedType,
              contextState,
              suggestion: state.latestSuggestion,
              questionText: correctionQuestionText,
              logicalQuestionUnit: correctionLogicalQuestionUnit,
              expiresAt: getActiveScreenTaskExpiresAt(state.settings),
            }));
      if (!existingParent) {
        setState((previous) => ({
          ...previous,
          error: "The active question has no repairable parent task.",
        }));
        return;
      }
      const correctionTargetSource =
        targetResolution.source === "active-task"
          ? targetResolution.targetSource
          : "provisional-question";

      const eventId = createMeetingId("question_type_correction");
      const operationClaim =
        manualCorrectionOperationCoordinatorRef.current.claim(eventId);
      manualCorrectionRevisionRef.current += 1;
      pendingInterviewSectionHintRef.current = undefined;
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
      const correctionModelRoute = resolveManualCorrectionRegenerationRoute({
        snapshot: meetingModelProviderSnapshotRef.current,
        correctedType,
      });
      const correctionModelRouteMetadata =
        formatMeetingModelRouteForTrace(correctionModelRoute);
      const correctionTrace = traceStoreRef.current.startTrace(
        activeTask?.screen || state.latestSuggestion?.taskSource === "screen"
          ? "screen"
          : "voice",
        {
          source: "manual-question-type-correction",
          manualQuestionTypeCorrectionSource: source,
          manualQuestionTypeCorrectionTarget: decision.target,
          manualCorrectionTargetSource: correctionTargetSource,
          detectedQuestionType: decision.detectedType,
          correctedQuestionType: decision.correctedType,
          correctionDecisionReason: decision.reason,
          manualCorrectionScope: correctionScopeDecision.scope,
          correctionScopeReason: correctionScopeDecision.reason,
          boundaryDecisionReason: correctionScopeDecision.reason,
          correctionQuestionInstanceId:
            correctionLineage?.questionInstanceId,
          correctionQuestionOriginTraceId:
            correctionLineage?.questionOriginTraceId,
          standaloneTaskScore:
            correctionScopeDecision.standaloneTaskScore,
          standaloneTaskEvidence:
            correctionScopeDecision.standaloneTaskEvidence,
          continuityScore: correctionScopeDecision.continuityScore,
          continuityEvidence: correctionScopeDecision.continuityEvidence,
          correctionProviderAvailable: Boolean(correctionModelRoute.provider),
          ...correctionModelRouteMetadata,
          supersedesCorrectionId: operationClaim.supersedesOperationId,
          ...formatQuestionLineageForTrace(
            correctionLineage ?? state.currentQuestionLineage
          ),
          ...formatLogicalQuestionUnitForTrace(
            correctionLogicalQuestionUnit
          ),
          ...formatLogicalQuestionLeaseForTrace(
            correctionLogicalQuestionLease,
            canonicalTargetAuthorization,
            "manual-correction-created"
          ),
          manualCorrectionOwnership:
            correctionLogicalQuestionUnit
              ? "canonical-logical-question"
              : "legacy-question-lineage",
          ...(activeTask ? getActiveMeetingTaskTraceMetadata(activeTask) : {}),
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
      const correctionQuestion = correctionLineage
        ? {
            questionId: correctionLineage.questionInstanceId,
            sourceTraceId: correctionLineage.questionOriginTraceId,
          }
        : resolveCorrectionQuestionInstance(
            state.questionEvaluations,
            state.latestSuggestion,
            activeTask!,
            correctionTrace.id
          );
      const questionId = correctionQuestion.questionId;
      let correction: ManualQuestionTypeCorrection = {
        eventId,
        taskId: activeTask?.id ?? existingParent.id,
        parentTaskId: activeTask?.parent.id ?? existingParent.id,
        childTaskId: activeTask?.child?.id,
        questionId,
        source,
        targetSource: correctionTargetSource,
        target: decision.target,
        scope: correctionScopeDecision.scope,
        scopeReason: correctionScopeDecision.reason,
        standaloneTaskScore: correctionScopeDecision.standaloneTaskScore,
        standaloneTaskEvidence: correctionScopeDecision.standaloneTaskEvidence,
        continuityScore: correctionScopeDecision.continuityScore,
        continuityEvidence: correctionScopeDecision.continuityEvidence,
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
        provisionalQuestionPromotionReason: provisionalLineage
          ? "authoritative-manual-question-type-correction"
          : undefined,
      });
      setState((previous) => ({
        ...previous,
        manualQuestionTypeCorrection: correction,
        error: null,
      }));
      if (activeTask) {
        sessionRecordingManagerRef.current?.recordActiveMeetingTaskSnapshot(
          activeTask,
          correctionTrace.id
        );
      }
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
        if (correctionLogicalQuestionLease) {
          const correctionOwnershipAuthorization =
            authorizeLogicalQuestionUnitLease(
              correctionLogicalQuestionLease,
              logicalQuestionUnitRef.current
            );
          traceStoreRef.current.updateMetadata(
            correctionTrace.id,
            formatLogicalQuestionLeaseForTrace(
              correctionLogicalQuestionLease,
              correctionOwnershipAuthorization,
              "pre-correction-mutation"
            )
          );
          if (!correctionOwnershipAuthorization.authorized) {
            traceStoreRef.current.finishStep(
              correctionTrace.id,
              mutationStepId,
              "cancelled",
              {
                manualCorrectionOwnershipAuthorized: false,
                manualCorrectionOwnershipReason:
                  correctionOwnershipAuthorization.reason,
              }
            );
            traceStoreRef.current.finishTrace(
              correctionTrace.id,
              "cancelled",
              correctionOwnershipAuthorization.reason
            );
            setState((previous) => ({
              ...previous,
              error:
                "The interviewer moved to a newer question before the correction could be applied.",
            }));
            return;
          }
        }
        const activeScreenTask = contextState.activeScreenTask;
        const askFrame = getManualOverrideAskFrame(correctedType);
        const startsNewParentBoundary =
          correctionScopeDecision.scope === "linked-parent-extension" ||
          correctionScopeDecision.scope === "independent-new-parent";
        const topicDomain = getManualOverrideTopicDomain(
          correctedType,
          startsNewParentBoundary
            ? undefined
            : activeScreenTask?.classifier?.topicDomain
        );
        const provisionalOriginTurn = correctionOriginTurn;
        const correctionQuery = startsNewParentBoundary
          ? correctionQuestionText
          : [
              activeTask?.child?.question,
              activeTask?.screen?.question,
              activeTask?.parent.topic,
              provisionalOriginTurn?.text,
              questionOnlyLineage
                ? state.latestSuggestion?.meetingAnswer?.sections.question
                : contextState.transcriptTurns
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
                projectAnchor: startsNewParentBoundary
                  ? undefined
                  : activeTask?.screen?.projectAnchor,
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
        const parentTransition = questionOnlyLineage
          ? {
              parent: {
                ...existingParent,
                playbook: correctedPlaybook,
                playbookPhase: correctedPlaybook?.phase ?? "follow_up",
                phaseProgress: {
                  [correctedPlaybook?.phase ?? "follow_up"]: true,
                },
                originQuestionId: questionOnlyLineage.questionInstanceId,
                startTurnId:
                  questionOnlyLineage.triggerTurnId ??
                  existingParent.startTurnId,
                promptTranscriptStartTurnId:
                  questionOnlyLineage.triggerTurnId ??
                  existingParent.promptTranscriptStartTurnId,
                updatedAt: requestedAt,
                expiresAt,
                revisions: existingParent.revisions + 1,
              },
              previousParentId: existingParent.id,
              nextParentId: existingParent.id,
              preservedContextFields: [
                questionOnlyLineage.identityState === "canonical"
                  ? "canonical-logical-question-origin"
                  : "provisional-question-origin",
              ],
              clearedContextFields: [],
              promptTranscriptStartTurnId: questionOnlyLineage.triggerTurnId,
              startedNewParent: false,
            }
          : buildManualCorrectionParentTransition({
              parent: existingParent,
              decision,
              scopeDecision: correctionScopeDecision,
              correctedPlaybook,
              latestQuestionText: correctionQuestionText,
              lineage: correctionLineage,
              transcriptTurns: contextState.transcriptTurns,
              newParentId: createMeetingId("interview_parent"),
              source: correctionOriginTurn
                ? "voice"
                : state.latestSuggestion?.taskSource === "screen" ||
                    state.latestSuggestion?.taskSource === "mixed"
                  ? "screen"
                  : existingParent.source,
              now: requestedAt,
              expiresAt,
            });
        const correctedParent = parentTransition.parent;
        const correctionQuestionUsesScreen = Boolean(
          !correctionOriginTurn &&
            (state.latestSuggestion?.taskSource === "screen" ||
              state.latestSuggestion?.taskSource === "mixed")
        );
        const shouldKeepScreenTask =
          !parentTransition.startedNewParent || correctionQuestionUsesScreen;
        const correctedScreenTask = activeScreenTask && shouldKeepScreenTask
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
        const isolatedCorrectedScreenTask =
          correctedScreenTask && parentTransition.startedNewParent
            ? {
                ...correctedScreenTask,
                question:
                  correctionQuestionText.trim() || correctedScreenTask.question,
                content: "",
                basedOnTurnIds: correctionLineage?.triggerTurnId
                  ? [correctionLineage.triggerTurnId]
                  : [],
              }
            : correctedScreenTask;

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
          activeScreenTask: isolatedCorrectedScreenTask ?? null,
          activeInterviewTask: correctedParent,
        });
        if (isolatedCorrectedScreenTask?.content) {
          contextManagerRef.current.updateScreenObservation(
            isolatedCorrectedScreenTask.observationId,
            {
              visualSummary: isolatedCorrectedScreenTask.content,
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
          taskId: correctedActiveTask.id,
          parentTaskId: correctedActiveTask.parent.id,
          childTaskId: correctedActiveTask.child?.id,
          previousParentId: parentTransition.previousParentId,
          nextParentId: parentTransition.nextParentId,
          parentHandoffSourceId:
            parentTransition.parentHandoff?.sourceParentId,
          preservedContextFields: parentTransition.preservedContextFields,
          clearedContextFields: parentTransition.clearedContextFields,
          promptTranscriptStartTurnId:
            parentTransition.promptTranscriptStartTurnId,
          status: "applied",
          appliedAt: Date.now(),
        };
        traceStoreRef.current.updateMetadata(correctionTrace.id, {
          ...formatInterviewPlaybookForTrace(correctedPlaybook),
          ...getActiveMeetingTaskTraceMetadata(correctedActiveTask),
          correctionStatus: correction.status,
          correctionVisibleAnswerCleared: true,
          correctionReliableAnswerCleared: false,
          correctionPreviousReliableAnswerPreserved: true,
          correctionVisibleStateDisposition:
            "previous-reliable-answer-preserved-until-regeneration",
          manualCorrectionTargetSource: correctionTargetSource,
          provisionalQuestionPromoted: Boolean(provisionalLineage),
          canonicalLogicalQuestionPromoted: Boolean(
            questionOnlyLineage?.identityState === "canonical"
          ),
          previousParentId: parentTransition.previousParentId,
          nextParentId: parentTransition.nextParentId,
          parentBoundaryReRooted: parentTransition.startedNewParent,
          parentHandoffSourceId:
            parentTransition.parentHandoff?.sourceParentId,
          preservedContextFields: parentTransition.preservedContextFields,
          clearedContextFields: parentTransition.clearedContextFields,
          promptTranscriptStartTurnId:
            parentTransition.promptTranscriptStartTurnId,
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
        if (isolatedCorrectedScreenTask) {
          sessionRecordingManagerRef.current?.recordTaskSnapshot(
            isolatedCorrectedScreenTask,
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
            manualCorrectionTargetSource: correctionTargetSource,
            correctionRegenerationTriggered: true,
            manualCorrectionScope: correctionScopeDecision.scope,
            correctionScopeReason: correctionScopeDecision.reason,
            correctionProviderAvailable: Boolean(correctionModelRoute.provider),
            correctionProviderSnapshotAt: requestedAt,
            ...correctionModelRouteMetadata,
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
            childTaskId: activeTask?.child?.id,
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
            manualQuestionTypeCorrectionScope:
              correctionScopeDecision.scope,
            manualQuestionTypeCorrectionBoundaryReason:
              correctionScopeDecision.reason,
            manualQuestionTypeCorrectionPreviousParentId:
              parentTransition.previousParentId,
            manualQuestionTypeCorrectionNextParentId:
              parentTransition.nextParentId,
            classification: {
              verdict: boundaryReassertionCandidate ? "ok" : "wrong",
              reasons: [
                boundaryReassertionCandidate
                  ? "manual-runtime-boundary-correction"
                  : "manual-runtime-correction",
              ],
            },
            correctedRelation: correctionScopeDecision.scope,
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
          ...stageSuggestionProjectionForManualCorrection(previous),
          activeScreenTask: correctedContextState.activeScreenTask,
          activeInterviewTask: correctedContextState.activeInterviewTask,
          activeMeetingTask: correctedActiveTask,
          screenObservations: correctedContextState.screenObservations,
          questionEvaluations,
          manualQuestionTypeCorrection: correction,
          currentQuestionLineage: promoteQuestionLineage(
            correctionLineage ?? previous.currentQuestionLineage
          ),
          error: null,
        }));

        await runAdvisor({
          force: true,
          mode: correctedActiveTask.screen ? "screen-anchored" : "live",
          traceId: regenerationTrace.id,
          manualQuestionTypeCorrection: correction,
          advisorJobSource: "manual-correction",
          taskMutationAuthority: "manual-correction",
          questionLineage: promoteQuestionLineage(
            correctionLineage ?? state.currentQuestionLineage
          ),
          logicalQuestionUnit: correctionLogicalQuestionUnit,
          promptTurnOverride:
            canonicalCorrectionTarget &&
            !contextState.transcriptTurns.some(
              (turn) => turn.id === canonicalCorrectionTarget.turn.id
            )
              ? canonicalCorrectionTarget.turn
              : undefined,
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
      resolveMeetingModelRoute,
      runAdvisor,
      state.currentQuestionLineage,
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

  const forceAdviseLatestTurn = useCallback(async () => {
    flushPendingSentenceCompletion("force-advise");
    const target = latestForceAdviseTargetRef.current;
    if (!target) {
      setState((previous) => ({
        ...previous,
        error: "There is no recent interviewer turn to advise on.",
      }));
      return;
    }
    const ownershipAuthorization = authorizeLogicalQuestionUnitLease(
      target.logicalQuestionLease,
      logicalQuestionUnitRef.current
    );
    traceStoreRef.current.updateMetadata(
      target.presentation.originalTraceId,
      {
        ...formatLogicalQuestionLeaseForTrace(
          target.logicalQuestionLease,
          ownershipAuthorization,
          "force-advise-click"
        ),
        forceAdviseOwnershipAuthorized:
          ownershipAuthorization.authorized,
        forceAdviseOwnershipReason: ownershipAuthorization.reason,
      }
    );
    if (!ownershipAuthorization.authorized) {
      const failedPresentation: ForceAdviseTargetPresentation = {
        ...target.presentation,
        status: "failed",
        updatedAt: Date.now(),
      };
      latestForceAdviseTargetRef.current = {
        ...target,
        presentation: failedPresentation,
      };
      setState((previous) => ({
        ...previous,
        latestInterviewerTurnCandidate: failedPresentation,
        error:
          "The interviewer moved to a newer question. Use Advise on the latest turn.",
      }));
      return;
    }
    if (
      target.presentation.executionAuthorized ||
      target.presentation.status === "already-advised" ||
      target.presentation.status === "repairing" ||
      target.presentation.status === "repaired"
    ) {
      return;
    }

    const repairTrace = traceStoreRef.current.startTrace("voice", {
      source: "manual-force-advise",
      originalTraceId: target.presentation.originalTraceId,
      triggerTurnId: target.presentation.turnId,
      logicalQuestionUnitId: target.logicalQuestionUnit.id,
      logicalQuestionUnitRevision: target.logicalQuestionUnit.revision,
      logicalQuestionSourceTurnIds: target.logicalQuestionUnit.sourceTurnIds,
      manualAuthority: "force-advise",
      ...formatLogicalQuestionLeaseForTrace(
        target.logicalQuestionLease,
        ownershipAuthorization,
        "force-advise-accepted"
      ),
    });
    const requestedAt = Date.now();
    const repairingPresentation: ForceAdviseTargetPresentation = {
      ...target.presentation,
      status: "repairing",
      repairTraceId: repairTrace.id,
      updatedAt: requestedAt,
    };
    latestForceAdviseTargetRef.current = {
      ...target,
      presentation: repairingPresentation,
    };
    setState((previous) => ({
      ...previous,
      latestInterviewerTurnCandidate: repairingPresentation,
      error: null,
    }));
    traceStoreRef.current.updateMetadata(
      target.presentation.originalTraceId,
      {
        forceAdviseAccepted: true,
        forceAdviseRepairTraceId: repairTrace.id,
        forceAdviseAcceptedAt: requestedAt,
      }
    );
    traceStoreRef.current.updateMetadata(repairTrace.id, {
      ...formatLogicalQuestionUnitForTrace(target.logicalQuestionUnit),
      ...formatQuestionLineageForTrace(target.questionLineage),
      ...formatAdvisorTurnIntentForTrace(target.intentDecision),
      forceAdviseOriginalObservedAction: target.presentation.observedAction,
      forceAdviseOriginalExecutionAuthorized:
        target.presentation.executionAuthorized,
    });
    updateTraceHumanEvaluation(target.presentation.originalTraceId, {
      advisorGateCorrectlySkipped: false,
      advisorGateShouldAdvise: true,
    });
    updateQuestionHumanEvaluation(target.presentation.originalTraceId, {
      questionId: target.questionLineage.questionInstanceId,
      traceIds: [
        target.presentation.originalTraceId,
        repairTrace.id,
      ],
      advisorIntent: {
        schemaVersion: 1,
        verdict: "false-negative",
        expectedAction: "advise",
        observedAction: target.presentation.observedAction,
        failureReason: "advisor-false-negative",
        source: "manual-force-advise",
        originalTraceId: target.presentation.originalTraceId,
        logicalQuestionUnitId: target.logicalQuestionUnit.id,
        logicalQuestionUnitRevision: target.logicalQuestionUnit.revision,
        sourceTurnIds: [...target.logicalQuestionUnit.sourceTurnIds],
        preDecision: {
          intent: target.intentDecision.intent,
          action: target.intentDecision.action,
          enforcement: target.intentDecision.enforcement,
          wouldSuppress: target.intentDecision.wouldSuppress,
          executionAuthorized: target.intentDecision.executionAuthorized,
        },
        repairTraceId: repairTrace.id,
        createdAt: requestedAt,
        updatedAt: requestedAt,
      },
    });

    await runAdvisor({
      force: true,
      mode: contextManagerRef.current.getState().activeMeetingTask?.screen
        ? "screen-anchored"
        : "live",
      traceId: repairTrace.id,
      advisorJobSource: "force-advise",
      taskMutationAuthority: "preserve-parent",
      triggerTurnId: target.presentation.turnId,
      questionLineage: target.questionLineage,
      logicalQuestionUnit: target.logicalQuestionUnit,
      promptTurnOverride: target.turn,
    });

    const completedTrace = traceStoreRef.current
      .getTraces()
      .find((trace) => trace.id === repairTrace.id);
    const repaired =
      completedTrace?.status === "success" &&
      completedTrace.metadata?.advisorOutputCommittedToUi === true;
    const completedAt = Date.now();
    const latestTarget = latestForceAdviseTargetRef.current;
    if (
      latestTarget?.presentation.originalTraceId ===
        target.presentation.originalTraceId &&
      latestTarget.presentation.repairTraceId === repairTrace.id
    ) {
      const completedPresentation: ForceAdviseTargetPresentation = {
        ...latestTarget.presentation,
        status: repaired ? "repaired" : "failed",
        updatedAt: completedAt,
      };
      latestForceAdviseTargetRef.current = {
        ...latestTarget,
        presentation: completedPresentation,
      };
      setState((previous) => ({
        ...previous,
        latestInterviewerTurnCandidate: completedPresentation,
      }));
    }
    traceStoreRef.current.updateMetadata(
      target.presentation.originalTraceId,
      {
        forceAdviseRepairStatus: repaired ? "repaired" : "failed",
        forceAdviseRepairCompletedAt: completedAt,
      }
    );
  }, [
    flushPendingSentenceCompletion,
    runAdvisor,
    updateQuestionHumanEvaluation,
    updateTraceHumanEvaluation,
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

      if (
        responseAction === "previous-phase" ||
        responseAction === "next-phase"
      ) {
        const meetingContext = contextManagerRef.current.getState();
        const existingInterviewTask =
          meetingContext.activeInterviewTask ??
          (meetingContext.activeScreenTask
            ? buildInterviewParentFromScreenTask(
                meetingContext.activeScreenTask
              )
            : undefined);
        if (!existingInterviewTask) {
          setState((previous) => ({
            ...previous,
            error: NO_ACTIVE_TASK_MESSAGE,
          }));
          return;
        }
        const parentHistory =
          playbookPhaseHistoryRef.current.parents[
            existingInterviewTask.id
          ];
        const operationId = createMeetingId(
          responseAction === "previous-phase"
            ? "phase_back"
            : "phase_forward"
        );
        const runtimeSnapshot = {
          parentTaskId: existingInterviewTask.id,
          currentPhase: existingInterviewTask.playbookPhase,
          taskRevision: existingInterviewTask.revisions,
          phaseRevision: parentHistory?.phaseRevision ?? 0,
          visibleChild: existingInterviewTask.child
            ? {
                childTaskId: existingInterviewTask.child.id,
                parentTaskId: existingInterviewTask.id,
              }
            : undefined,
        };

        if (responseAction === "previous-phase") {
          const decision = decideManualPlaybookPhaseBack({
            history: playbookPhaseHistoryRef.current,
            request: {
              operationId,
              parentTaskId: existingInterviewTask.id,
              expectedTaskRevision:
                existingInterviewTask.revisions,
              expectedPhaseRevision:
                parentHistory?.phaseRevision ?? 0,
              requestedAt: Date.now(),
            },
            current: runtimeSnapshot,
          });
          const trace = traceStoreRef.current.startTrace(
            meetingContext.activeScreenTask ? "screen" : "voice",
            {
              source: "advisor-response-action",
              responseAction,
              ...formatPlaybookPhaseNavigationDecisionForTrace(
                decision
              ),
            }
          );
          if (decision.status !== "ready") {
            traceStoreRef.current.finishTrace(
              trace.id,
              "cancelled",
              decision.reason
            );
            setState((previous) => ({
              ...previous,
              error:
                decision.status === "no-history"
                  ? "There is no previous committed playbook phase."
                  : `Back was not applied: ${decision.reason}`,
            }));
            return;
          }

          const updatedInterviewTask: ActiveInterviewParent = {
            ...existingInterviewTask,
            playbook: withInterviewPlaybookPhase(
              existingInterviewTask.playbook,
              decision.targetPhase
            ),
            playbookPhase: decision.targetPhase,
            child: undefined,
            updatedAt: Date.now(),
            revisions: existingInterviewTask.revisions + 1,
          };
          const childOwnedScreen =
            Boolean(existingInterviewTask.child) &&
            Boolean(
              meetingContext.activeScreenTask &&
                existingInterviewTask.child?.basedOnObservationIds.includes(
                  meetingContext.activeScreenTask.observationId
                )
            );
          contextManagerRef.current.setActiveMeetingTaskState({
            activeScreenTask: childOwnedScreen
              ? null
              : meetingContext.activeScreenTask,
            activeInterviewTask: updatedInterviewTask,
          });
          const phaseCommit =
            recordCommittedPlaybookPhaseTransition({
              operationId,
              source: "manual-back",
              before: existingInterviewTask,
              after: updatedInterviewTask,
              traceId: trace.id,
            });
          traceStoreRef.current.updateMetadata(trace.id, {
            manualPhaseCommitApplied:
              phaseCommit?.status === "appended",
          });
          const updatedContext =
            contextManagerRef.current.getState();
          setState((previous) => ({
            ...previous,
            activeScreenTask: updatedContext.activeScreenTask,
            activeInterviewTask:
              updatedContext.activeInterviewTask,
            activeMeetingTask: updatedContext.activeMeetingTask,
            error: null,
          }));

          await runAdvisor({
            force: true,
            mode: "response-action",
            responseAction,
            traceId: trace.id,
            advisorJobSource: "response-action",
            taskMutationAuthority: "preserve-parent",
            questionLineage:
              resolveCurrentSuggestionQuestionLineage(),
          });
          return;
        }

        const forwardDecision =
          decideManualPlaybookPhaseNextRoundTrip({
            history: playbookPhaseHistoryRef.current,
            request: {
              operationId,
              parentTaskId: existingInterviewTask.id,
              expectedTaskRevision:
                existingInterviewTask.revisions,
              expectedPhaseRevision:
                parentHistory?.phaseRevision ?? 0,
              requestedAt: Date.now(),
            },
            current: runtimeSnapshot,
          });
        if (forwardDecision.status === "ready") {
          const trace = traceStoreRef.current.startTrace(
            meetingContext.activeScreenTask ? "screen" : "voice",
            {
              source: "advisor-response-action",
              responseAction,
              ...formatPlaybookPhaseNavigationDecisionForTrace(
                forwardDecision
              ),
            }
          );
          await runAdvisor({
            force: true,
            mode: "response-action",
            responseAction,
            currentSuggestion: currentSuggestionText,
            traceId: trace.id,
            advisorJobSource: "response-action",
            taskMutationAuthority: "preserve-parent",
            questionLineage:
              resolveCurrentSuggestionQuestionLineage(),
            manualPhaseTargetOverride:
              forwardDecision.targetPhase,
            manualPhaseOperationId: operationId,
          });
          return;
        }
      }

      if (
        responseAction === "narrow-context" ||
        responseAction === "enhance-context"
      ) {
        const meetingContext = contextManagerRef.current.getState();
        const logicalQuestionUnit =
          resolveResponseActionLogicalQuestionUnit({
            currentLogicalQuestionUnit:
              logicalQuestionUnitRef.current,
            meetingContext,
            runtimeEpoch: runtimeEpochRef.current,
            preferScreen: isScreenAnchoredSuggestion(
              state.latestSuggestion
            ),
          });
        if (!logicalQuestionUnit) {
          setState((previous) => ({
            ...previous,
            error:
              "There is no source-owned current question to regenerate.",
          }));
          return;
        }

        const baseContext =
          contextManagerRef.current.buildAdvisorPromptContext();
        const selection = composeContextScopeAdvisorPromptContext({
          action: responseAction,
          baseContext,
          logicalQuestionUnit,
          meetingContext,
          activeMeetingTask: meetingContext.activeMeetingTask,
        });
        const operationId = createMeetingId("response_scope");
        const promptContextOverride: AdvisorPromptContext = {
          ...selection.promptContext,
          responseActionContextScope: {
            operationId,
            action: responseAction,
            mode: selection.contextScopeMode,
            logicalQuestionUnitId:
              selection.logicalQuestionUnitId,
            logicalQuestionUnitRevision:
              selection.logicalQuestionUnitRevision,
            selectedContextSourceKinds:
              selection.selectedKinds,
            selectedContextTurnIds:
              selection.selectedTurnIds,
            selectedContextChars: selection.selectedChars,
            selectionReason: selection.selectionReason,
            expansionBudget:
              selection.budgets.maxExpansionChars,
          },
        };

        await runAdvisor({
          force: true,
          mode: "response-action",
          responseAction,
          advisorJobSource: "response-action",
          taskMutationAuthority: "preserve-parent",
          questionLineage:
            resolveCurrentSuggestionQuestionLineage(),
          logicalQuestionUnit,
          promptContextOverride,
        });
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
      state.latestSuggestion,
      recordCommittedPlaybookPhaseTransition,
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
      refreshCriticalMomentCandidates(
        contextManagerRef.current.getState(),
        traces
      );
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
    refreshCriticalMomentCandidates,
    scheduleTraceMetricsPersistence,
  ]);

  useEffect(() => {
    debugModeRef.current = state.settings.debugMode;
    traceStoreRef.current.setDebugEnabled(state.settings.debugMode);
  }, [state.settings.debugMode]);

  useEffect(() => {
    semanticTaxonomyModeRef.current = state.settings.semanticTaxonomyMode;
  }, [state.settings.semanticTaxonomyMode]);

  useEffect(() => {
    taxonomyAdjudicationSettingsRef.current =
      state.settings.taxonomyAdjudication;
  }, [state.settings.taxonomyAdjudication]);

  useEffect(() => {
    let disposed = false;
    let unlistenSpeech: (() => void) | undefined;
    let unlistenSegmentDrop: (() => void) | undefined;
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

      const segmentDropUnlisten = await listen<unknown>(
        "native-audio-segment-dropped",
        (event) => {
          const dropped = parseNativeAudioSegmentDroppedEvent(event.payload);
          const authorized = Boolean(
            dropped &&
              dropped.owner === "meeting" &&
              dropped.captureSessionId ===
                nativeCaptureSessionIdRef.current &&
              dropped.captureGeneration ===
                nativeCaptureGenerationRef.current
          );
          const metadata = {
            stage: "native-audio-segment-dropped",
            authorized,
            ...(dropped ?? { rejectionReason: "invalid-envelope" }),
          };
          console.warn(
            `[${new Date().toISOString()}] [native-audio-segment-dropped]`,
            JSON.stringify(metadata)
          );
          sessionRecordingManagerRef.current?.recordCaptureLifecycle(metadata);
        }
      );

      if (disposed) {
        segmentDropUnlisten();
        return;
      }
      unlistenSegmentDrop = segmentDropUnlisten;

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
          const terminalKey = [
            terminalEvent.owner,
            terminalEvent.captureSessionId,
            terminalEvent.captureGeneration,
            terminalEvent.eventType,
            terminalEvent.reason ?? "unknown",
          ].join(":");
          if (handledNativeTerminalKeysRef.current.has(terminalKey)) {
            sessionRecordingManagerRef.current?.recordCaptureLifecycle({
              stage: "duplicate-native-terminal-ignored",
              terminalKey,
              ...buildNativeAudioLifecycleTraceMetadata(terminalEvent),
            });
            return;
          }
          handledNativeTerminalKeysRef.current.add(terminalKey);
          if (handledNativeTerminalKeysRef.current.size > 200) {
            const oldestKey = handledNativeTerminalKeysRef.current
              .values()
              .next().value;
            if (oldestKey) {
              handledNativeTerminalKeysRef.current.delete(oldestKey);
            }
          }

          const now = Date.now();
          const recentRecoveryAttempts = pruneNativeAudioRecoveryAttempts(
            nativeRecoveryAttemptTimestampsRef.current,
            now,
            NATIVE_AUDIO_RECOVERY_WINDOW_MS
          );
          nativeRecoveryAttemptTimestampsRef.current = recentRecoveryAttempts;
          const automaticRecoveryAvailable =
            recentRecoveryAttempts.length <
            NATIVE_AUDIO_MAX_RECOVERY_ATTEMPTS_PER_WINDOW;
          const disposition = decideNativeAudioTerminalDisposition(
            terminalEvent,
            automaticRecoveryAvailable
          );
          const faultInjectionId =
            terminalEvent.diagnostics.faultInjectionId ?? undefined;
          const faultTraceContext = faultInjectionId
            ? nativeAudioFaultTracesRef.current.get(faultInjectionId)
            : undefined;
          if (faultTraceContext) {
            faultTraceContext.terminalDisposition = disposition;
            traceStoreRef.current.updateMetadata(faultTraceContext.traceId, {
              ...buildNativeAudioLifecycleTraceMetadata(terminalEvent),
              nativeTerminalDisposition: disposition,
              nativeRecoveryAvailable: automaticRecoveryAvailable,
              recoveryAttemptsInWindow: recentRecoveryAttempts.length,
            });
          }

          sessionRecordingManagerRef.current?.recordCaptureLifecycle({
            stage: "native-terminal-reconciled",
            terminalKey,
            disposition,
            automaticRecoveryAvailable,
            recoveryAttemptsInWindow: recentRecoveryAttempts.length,
            ...buildNativeAudioLifecycleTraceMetadata(terminalEvent),
          });

          nativeCaptureSessionIdRef.current = null;
          nativeCaptureGenerationRef.current = null;
          lastNativeSegmentSequenceRef.current = 0;

          if (disposition === "expected-stop") {
            return;
          }

          activeRef.current = false;
          invalidateAudioProcessingSession();
          cancelActiveAdvisorJob(`native-audio-${terminalEvent.eventType}`);

          if (disposition === "recovering") {
            nativeAudioManualRecoveryRef.current = null;
            nativeRecoveryAttemptTimestampsRef.current = [
              ...recentRecoveryAttempts,
              now,
            ];
            const recoveryAttempt: NativeAudioRecoveryAttemptContext = {
              id: createMeetingId("native_audio_recovery"),
              startedAt: now,
              previousCaptureSessionId: terminalEvent.captureSessionId,
              previousCaptureGeneration: terminalEvent.captureGeneration,
              reason: terminalEvent.reason,
              faultInjectionId,
            };
            sessionRecordingManagerRef.current?.recordCaptureLifecycle({
              stage: "automatic-recovery-started",
              recoveryAttemptId: recoveryAttempt.id,
              recoveryAttemptNumber: recentRecoveryAttempts.length + 1,
              recoveryWindowMs: NATIVE_AUDIO_RECOVERY_WINDOW_MS,
              previousCaptureSessionId:
                recoveryAttempt.previousCaptureSessionId,
              previousCaptureGeneration:
                recoveryAttempt.previousCaptureGeneration,
              reason: recoveryAttempt.reason,
              faultInjectionId,
            });
            setState((previous) => ({
              ...previous,
              status: "reconnecting",
              partialSuggestion: "",
              audioStatus: null,
              error: null,
              nativeAudioManualRecovery: undefined,
            }));
            void startCapture("automatic-recovery", recoveryAttempt);
            return;
          }

          const circuitBreakerOpen =
            terminalEvent.recoverability === "retry-once" &&
            !automaticRecoveryAvailable;
          const manualRecovery = createNativeAudioManualRecoveryState({
            event: terminalEvent,
            circuitBreakerOpen,
            requiredAt: now,
          });
          nativeAudioManualRecoveryRef.current = manualRecovery;
          sessionRecordingManagerRef.current?.recordCaptureLifecycle({
            stage: "manual-recovery-required",
            requiredAt: manualRecovery.requiredAt,
            reason: manualRecovery.reason,
            message: manualRecovery.message,
            previousCaptureSessionId:
              manualRecovery.interruptedCaptureSessionId,
            previousCaptureGeneration:
              manualRecovery.interruptedCaptureGeneration,
            circuitBreakerOpen: manualRecovery.circuitBreakerOpen,
          });
          setState((previous) => ({
            ...previous,
            status: "error",
            partialSuggestion: "",
            audioStatus: null,
            error:
              terminalEvent.message ||
              (circuitBreakerOpen
                ? "System audio stopped repeatedly. Resume Jarvis manually."
                : terminalEvent.eventType === "error"
                  ? "System audio capture failed. Resume Jarvis after checking audio access."
                  : "System audio capture stopped unexpectedly. Resume Jarvis manually."),
            nativeAudioManualRecovery: manualRecovery,
          }));
          if (faultInjectionId) {
            maybeFinishNativeAudioFaultTrace(faultInjectionId);
          }
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
      unlistenSegmentDrop?.();
      unlistenLifecycle?.();
    };
  }, [
    cancelActiveAdvisorJob,
    invalidateAudioProcessingSession,
    maybeFinishNativeAudioFaultTrace,
    startCapture,
  ]);

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

  const stopOnUnmountRef = useRef(stop);
  stopOnUnmountRef.current = stop;

  useEffect(() => {
    return () => {
      void stopOnUnmountRef.current();
      taxonomyAdjudicationRuntimeRef.current?.cancelAll("disposed");
      void semanticTaxonomyRuntimeRef.current?.dispose("meeting-hook-unmounted");
    };
  }, []);

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
    setSemanticTaxonomyMode,
    setDebugMode,
    setMicrophoneContextEnabled,
    toggleMicrophoneContext,
    setSessionRecordingEnabled,
    setResponseConfig,
    setCodingModelConfig,
    setTaxonomyAdjudicationConfig,
    setMeetingAudioProfile,
    setMeetingAudioConfig,
    start,
    pause,
    resume,
    resumeAfterNativeFailure,
    stop,
    clearActiveScreenTask,
    clearTraces,
    injectNativeAudioFault,
    captureScreenContext,
    exportTrace,
    updateTraceHumanEvaluation,
    updateQuestionHumanEvaluation,
    updateCriticalMomentEvaluation,
    correctActiveQuestionType,
    regenerateSuggestion,
    forceAdviseLatestTurn,
    applyResponseAction,
    answerClarifyingQuestion,
    submitSpeechCorrection,
    aiProviders: allAiProviders,
    criticalMomentCandidates,
    criticalMomentEvaluations,
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

function toObservedAdvisorAction(
  decision: AdvisorTurnIntentDecision
): ForceAdviseTargetPresentation["observedAction"] {
  if (decision.executionAuthorized) return "advised";
  if (decision.intent === "incomplete") return "buffered";
  if (
    decision.action === "append-only" ||
    decision.action === "state-update"
  ) {
    return "append-only";
  }
  return "suppressed";
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

function readNumberFromTraceMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string
) {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readSelectedProviderModelId(provider: SelectedProviderState) {
  for (const key of ["MODEL", "MODEL_NAME", "model", "modelName", "model_name"]) {
    const value = provider.variables[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
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
  fallbackQuery: string,
  logicalQuestionUnit?: LogicalQuestionUnit
): AdvisorTaskSignals {
  const latestThemText =
    context.latestTurn?.speaker === "them" ? context.latestTurn.text.trim() : "";
  const classifierText = logicalQuestionUnit?.normalizedText ?? latestThemText;
  const latestUsefulText =
    classifierText && calculateWordEquivalent(classifierText) >= 3
      ? classifierText
      : "";
  const openingRoute = latestUsefulText
    ? detectOpeningTaskRoute(latestUsefulText)
    : undefined;
  const latestQuestionTypeDecision = latestUsefulText
    ? inferQuestionTypeDecisionFromText(latestUsefulText, {
        interviewSessionBrief: context.interviewSessionBrief,
      })
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
      briefPriorType: signals.questionTypeDecision?.briefPriorType,
      briefCompatibilityDecision:
        signals.questionTypeDecision?.briefCompatibilityDecision ??
        "not-applicable",
      questionTypeDecisionSource: signals.openingRoute.source,
      pastProjectSignals:
        signals.questionType === "project-deep-dive"
          ? [`opening-route:${signals.openingRoute.kind}`]
          : [],
    };
  }

  if (signals.source === "interview-section-hint") {
    return {
      ...boundaryMetadata,
      questionTypeInferenceType: signals.questionType,
      questionTypeConfidence: 0.98,
      questionTypeMargin: 1,
      questionTypeEvidence: ["interviewer-explicit-section-hint"],
      ambiguousCodingTerms: [],
      questionTypeScores: { [signals.questionType]: 0.98 },
      briefPriorType: undefined,
      briefCompatibilityDecision: "not-applicable",
      questionTypeDecisionSource: signals.source,
      pastProjectSignals: [],
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
      briefPriorType: undefined,
      briefCompatibilityDecision: "not-applicable",
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
    briefPriorType: decision.briefPriorType,
    briefCompatibilityDecision: decision.briefCompatibilityDecision,
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
    manualQuestionTypeCorrectionTargetSource: correction.targetSource,
    manualQuestionTypeCorrectionTarget: correction.target,
    manualCorrectionScope: correction.scope,
    correctionScopeReason: correction.scopeReason,
    boundaryDecisionReason: correction.scopeReason,
    correctionQuestionInstanceId: correction.questionId,
    previousParentId: correction.previousParentId,
    nextParentId: correction.nextParentId,
    parentHandoffSourceId: correction.parentHandoffSourceId,
    preservedContextFields: correction.preservedContextFields,
    clearedContextFields: correction.clearedContextFields,
    promptTranscriptStartTurnId: correction.promptTranscriptStartTurnId,
    detectedQuestionType: correction.detectedType,
    correctedQuestionType: correction.correctedType,
    correctionTraceId: correction.correctionTraceId,
    regenerationTraceId: correction.regenerationTraceId,
  };
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
  questionInstanceId,
  canonicalQuestionSourceTurnIds,
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
  artifactAuthorization,
  sourceTransitionPrecommitted = false,
}: {
  existingTask?: ActiveInterviewParent;
  source: "screen" | "voice";
  questionType: MemoryQuestionType | ScreenTaskKind;
  relation: InterviewTaskRelation;
  subtaskIntent: InterviewSubtaskIntent;
  question?: string;
  questionInstanceId?: string;
  canonicalQuestionSourceTurnIds?: string[];
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
  artifactAuthorization: ReturnType<
    typeof authorizeResponseArtifactMutation
  >;
  sourceTransitionPrecommitted?: boolean;
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
    const generatedChild = isUsefulAnswer
      ? buildActiveInterviewChild({
          questionType: childQuestionType,
          subtaskIntent,
          question: topic,
          parsedAnswer: parsed,
          latestTurn,
          observationId,
        })
      : undefined;
    const child =
      sourceTransitionPrecommitted &&
      existingTask.child &&
      generatedChild
        ? {
            ...generatedChild,
            id: existingTask.child.id,
            createdAt: existingTask.child.createdAt,
            basedOnTurnIds: Array.from(
              new Set([
                ...existingTask.child.basedOnTurnIds,
                ...generatedChild.basedOnTurnIds,
              ])
            ),
            basedOnObservationIds: Array.from(
              new Set([
                ...existingTask.child.basedOnObservationIds,
                ...generatedChild.basedOnObservationIds,
              ])
            ),
          }
        : generatedChild;
    const whiteboardArtifact = artifactAuthorization.allowWhiteboard
      ? updateWhiteboardArtifactFromAnswer({
          existing: existingTask.whiteboardArtifact,
          parentTaskId: existingTask.id,
          questionInstanceId: existingTask.originQuestionId,
          parentQuestionType: existingTask.stableKind,
          parentTopic: existingTask.topic,
          finalContent: trimmedContent,
          parsedAnswer: parsed,
          phase: phaseDecision?.phase ?? existingTask.playbookPhase,
          traceId,
          selectedOverlayIds,
          updateSource: whiteboardUpdateSource ?? "model-output",
          provisional: phaseDecision?.whiteboardProvisional,
          openConstraintCategories:
            phaseDecision?.whiteboardOpenConstraintCategories,
          revisionReason: phaseDecision?.whiteboardRevisionReason,
          now,
        })
      : existingTask.whiteboardArtifact;

    return {
      task: applyInterviewChildProbeTransition({
        parent: existingTask,
        child,
        projectBinding: artifactAuthorization.allowParentContextMutation
          ? projectBinding
          : existingTask.projectBinding,
        supportedFactAnchors: artifactAuthorization.allowParentContextMutation
          ? continuingTaskAnchors
          : existingTask.supportedFactAnchors,
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
    const whiteboardArtifact = artifactAuthorization.allowWhiteboard
      ? updateWhiteboardArtifactFromAnswer({
          parentTaskId: parentId,
          parentQuestionType: kind,
          parentTopic: topic,
          finalContent: trimmedContent,
          parsedAnswer: parsed,
          phase: nextPhase,
          traceId,
          selectedOverlayIds,
          updateSource: whiteboardUpdateSource ?? "new-parent",
          provisional: phaseDecision?.whiteboardProvisional,
          openConstraintCategories:
            phaseDecision?.whiteboardOpenConstraintCategories,
          revisionReason: phaseDecision?.whiteboardRevisionReason,
          now,
        })
      : undefined;

    return {
      task: {
        id: parentId,
        source,
        stableKind: kind,
        topic,
        playbook: storedPlaybook,
        playbookPhase: nextPhase,
        phaseProgress: applyPlaybookPhaseDecisionToProgress(
          createInitialPlaybookPhaseProgress(kind, storedPlaybook?.phase),
          phaseDecision,
          storedPlaybook?.phase
        ),
        projectBinding: artifactAuthorization.allowParentContextMutation
          ? projectBinding
          : undefined,
        supportedFactAnchors: artifactAuthorization.allowParentContextMutation
          ? newParentAnchors
          : [],
        latestUsefulAnswer:
          artifactAuthorization.allowLatestUsefulAnswer && isUsefulAnswer
            ? summaryDecision.text
            : undefined,
        previousUsefulAnswer: undefined,
        whiteboardArtifact,
        createdAt: now,
        updatedAt: now,
        expiresAt,
        originQuestionId: questionInstanceId,
        startTurnId:
          canonicalQuestionSourceTurnIds?.[0] ?? latestTurn?.id,
        startObservationId: observationId,
        promptTranscriptStartTurnId:
          canonicalQuestionSourceTurnIds?.[0] ?? latestTurn?.id,
        canonicalQuestionSourceTurnIds:
          canonicalQuestionSourceTurnIds?.length
            ? [...canonicalQuestionSourceTurnIds]
            : latestTurn?.id
              ? [latestTurn.id]
              : [],
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
      projectBinding: artifactAuthorization.allowParentContextMutation
        ? projectBinding ?? existingTask.projectBinding
        : existingTask.projectBinding,
      supportedFactAnchors: artifactAuthorization.allowParentContextMutation
        ? continuingTaskAnchors
        : existingTask.supportedFactAnchors,
      whiteboardArtifact: artifactAuthorization.allowWhiteboard
        ? updateWhiteboardArtifactFromAnswer({
            existing: existingTask.whiteboardArtifact,
            parentTaskId: existingTask.id,
            questionInstanceId: existingTask.originQuestionId,
            parentQuestionType: existingTask.stableKind,
            parentTopic: existingTask.topic,
            finalContent: trimmedContent,
            parsedAnswer: parsed,
            phase: nextPhase,
            traceId,
            selectedOverlayIds,
            updateSource: whiteboardUpdateSource ?? "model-output",
            provisional: phaseDecision?.whiteboardProvisional,
            openConstraintCategories:
              phaseDecision?.whiteboardOpenConstraintCategories,
            revisionReason: phaseDecision?.whiteboardRevisionReason,
            now,
          })
        : existingTask.whiteboardArtifact,
      previousUsefulAnswer:
        artifactAuthorization.allowLatestUsefulAnswer &&
        isUsefulAnswer &&
        existingTask.latestUsefulAnswer
          ? existingTask.latestUsefulAnswer
          : existingTask.previousUsefulAnswer,
      latestUsefulAnswer:
        artifactAuthorization.allowLatestUsefulAnswer && isUsefulAnswer
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
    phaseProgress: createInitialPlaybookPhaseProgress(
      kind,
      task.playbook?.phase
    ),
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
    originQuestionId: task.parent.originQuestionId,
    startTurnId: task.parent.startTurnId,
    startObservationId: task.parent.startObservationId,
    promptTranscriptStartTurnId: task.parent.promptTranscriptStartTurnId,
    canonicalQuestionSourceTurnIds:
      task.parent.canonicalQuestionSourceTurnIds
        ? [...task.parent.canonicalQuestionSourceTurnIds]
        : undefined,
    parentContextHandoff: task.parent.parentContextHandoff,
    revisions: task.parent.revisions ?? 0,
  };
}

function buildCorrectionParentFromProvisionalQuestion({
  lineage,
  correctedType,
  contextState,
  suggestion,
  questionText,
  logicalQuestionUnit,
  expiresAt,
}: {
  lineage: QuestionInstanceLineage | undefined;
  correctedType: CanonicalQuestionType;
  contextState: MeetingContextState;
  suggestion: AdvisorSuggestion | null;
  questionText?: string;
  logicalQuestionUnit?: LogicalQuestionUnit;
  expiresAt?: number;
}): ActiveInterviewParent | undefined {
  if (!lineage || !isParentCanonicalQuestionType(correctedType)) {
    return undefined;
  }

  const originTurn = lineage.triggerTurnId
    ? contextState.transcriptTurns.find(
        (turn) => turn.id === lineage.triggerTurnId
      )
    : undefined;
  const topic =
    questionText?.trim() ||
    originTurn?.text.trim() ||
    suggestion?.meetingAnswer?.sections.question?.trim() ||
    "Current interview question";
  const now = Date.now();

  return {
    id: createMeetingId("interview_parent"),
    source:
      suggestion?.taskSource === "screen" || suggestion?.taskSource === "mixed"
        ? "screen"
        : "voice",
    stableKind: correctedType,
    topic,
    playbookPhase: "follow_up",
    phaseProgress: { follow_up: true },
    supportedFactAnchors: [],
    createdAt: now,
    updatedAt: now,
    expiresAt,
    startTurnId:
      logicalQuestionUnit?.sourceTurnIds[0] ??
      originTurn?.id ??
      lineage.triggerTurnId,
    promptTranscriptStartTurnId:
      logicalQuestionUnit?.sourceTurnIds[0] ??
      originTurn?.id ??
      lineage.triggerTurnId,
    canonicalQuestionSourceTurnIds:
      logicalQuestionUnit?.sourceTurnIds.length
        ? [...logicalQuestionUnit.sourceTurnIds]
        : undefined,
    startObservationId: suggestion?.basedOnObservationIds[
      suggestion.basedOnObservationIds.length - 1
    ],
    revisions: 0,
  };
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

function doesAdvisorPromptContainLogicalQuestion(
  prompt: string,
  unit: LogicalQuestionUnit | undefined
) {
  if (!unit) return undefined;
  const normalizedPrompt = normalizeTranscriptForGate(prompt);
  const sourceTexts = unit.sources
    .map((source) => normalizeTranscriptForGate(source.text))
    .filter(Boolean);
  if (sourceTexts.length) {
    return sourceTexts.every((sourceText) =>
      normalizedPrompt.includes(sourceText)
    );
  }
  const normalizedQuestion = normalizeTranscriptForGate(unit.normalizedText);
  return normalizedQuestion
    ? normalizedPrompt.includes(normalizedQuestion)
    : undefined;
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

function selectLatestMeAdjudicationContext(
  turns: TranscriptTurn[],
  currentTurnStartedAt: number
) {
  const candidate = [...turns].reverse().find((turn) => {
    if (turn.speaker !== "me" || !turn.text.trim()) return false;
    const deltaMs = currentTurnStartedAt - turn.endedAt;
    if (deltaMs < 0 || deltaMs > 90_000) return false;
    return (
      turn.contextPromptEligible ||
      turn.contextTier === "me_clarification_short" ||
      turn.contextTier === "me_clarification_medium" ||
      /(?:\?|？|\b(?:not|instead|mean|clarif|correct|you mean|did you say)\b|(?:不是|是指|意思是|确认|更正))/iu.test(
        turn.text
      )
    );
  });
  return candidate?.text;
}

function buildTaxonomyPreparationPrior(
  brief: InterviewSessionBrief | undefined
) {
  if (!brief) return undefined;
  const fields = [
    brief.targetCompany
      ? `target-company:${brief.targetCompany}`
      : undefined,
    brief.interviewTypes.length
      ? `planned-interview-types:${brief.interviewTypes.join(",")}`
      : undefined,
  ].filter(Boolean);
  return fields.length ? fields.join("; ") : undefined;
}

function evaluateThemTurnForAdvisor(
  turn: TranscriptTurn,
  options: {
    hasActiveTask: boolean;
    hasRecentQuestionContext?: boolean;
  }
) {
  const trimmed = turn.text.trim();
  const hasQuestion = hasQuestionOrTaskSignal(trimmed);
  return decideAdvisorTurnIntent(trimmed, {
    hasActiveTask: options.hasActiveTask,
    hasRecentQuestionContext: options.hasRecentQuestionContext,
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
