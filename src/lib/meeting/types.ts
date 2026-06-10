import { Message, TYPE_PROVIDER } from "@/types";
import type {
  MemoryRetrievalPolicy,
  MemoryRetrievalResult,
} from "@/lib/memory/types";

export type TranscriptSpeaker = "them" | "me" | "unknown";

export type MeetingAssistantStatus =
  | "idle"
  | "starting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "paused"
  | "error";

export interface TranscriptTurn {
  id: string;
  speaker: TranscriptSpeaker;
  text: string;
  startedAt: number;
  endedAt: number;
  isFinal: boolean;
  source: "system-audio" | "microphone";
  confidence?: number;
  audioSegmentSeq?: number;
  audioSessionId?: string;
  contextTier?:
    | "me_clarification_short"
    | "me_clarification_medium"
    | "me_attempted_answer_long";
  contextPromptEligible?: boolean;
  contextFusionStatus?:
    | "none"
    | "pending"
    | "paired"
    | "duplicate-suppressed"
    | "debug-only";
  relatedTurnIds?: string[];
}

export type SpeechBiasTermSource =
  | "brief"
  | "active-task"
  | "glossary"
  | "transcript"
  | "correction"
  | "domain";

export interface SpeechBiasTerm {
  term: string;
  source: SpeechBiasTermSource;
  weight: "normal" | "high";
}

export interface SpeechCorrectionRule {
  from: string;
  to: string;
  source: "emergency" | "bias";
  reason: string;
}

export interface SpeechBiasContext {
  terms: SpeechBiasTerm[];
  correctionRules: SpeechCorrectionRule[];
  prompt: string;
}

export interface SpeechCorrection {
  id: string;
  input: string;
  term?: string;
  from?: string;
  to?: string;
  createdAt: number;
  appliedCount: number;
}

export interface SpeechNormalizationResult {
  text: string;
  changed: boolean;
  appliedRules: SpeechCorrectionRule[];
}

export interface ScreenObservation {
  id: string;
  capturedAt: number;
  source: "full-screen" | "selection" | "hotkey";
  imageBase64?: string;
  imageMediaType?: string;
  focusImageBase64?: string;
  focusImageMediaType?: string;
  ocrText?: string;
  visualSummary?: string;
  analysisPromptSource?: ScreenObservationPromptSource;
  hash?: string;
  changed: boolean;
  confidence?: number;
  captureTarget?: ScreenCaptureTarget;
}

export type ScreenObservationPromptSource =
  | "meeting-default"
  | "screenshot-auto-prompt";

export interface ScreenCaptureTarget {
  targetType: "active-window" | "current-monitor" | "selection";
  captureMethod?: string;
  windowId?: number;
  appName?: string;
  title?: string;
  monitorName?: string;
  zOrderIndex?: number;
  selectionReason?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  imageWidth?: number;
  imageHeight?: number;
  originalImageWidth?: number;
  originalImageHeight?: number;
  optimizedForScreenContext?: boolean;
  captureTimingsMs?: ScreenCaptureTimings;
  cursor?: ScreenCaptureCursorFocus;
  focusRegion?: ScreenCaptureFocusRegion;
  fallbackReason?: string;
  candidates?: ScreenCaptureCandidate[];
}

export interface ScreenCaptureTimings {
  totalMs?: number;
  windowLookupMs?: number;
  imageCaptureMs?: number;
  imageOptimizeMs?: number;
  imageEncodeMs?: number;
}

export interface ScreenCaptureCursorFocus {
  globalX: number;
  globalY: number;
  targetX: number;
  targetY: number;
  normalizedX?: number;
  normalizedY?: number;
  insideTarget: boolean;
  source?: string;
}

export interface ScreenCaptureFocusRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  imageWidth: number;
  imageHeight: number;
  originalImageWidth: number;
  originalImageHeight: number;
  cursorX: number;
  cursorY: number;
  source?: string;
}

export interface ScreenCaptureCandidate {
  windowId?: number;
  appName: string;
  title: string;
  zOrderIndex?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  containsCursor?: boolean;
  selected?: boolean;
  selectionScore?: number;
  selectionReason?: string;
  skippedReason?: string;
}

export interface GlossaryEntry {
  term: string;
  definition: string;
}

export interface MeetingContextState {
  sessionId: string;
  startedAt: number;
  transcriptTurns: TranscriptTurn[];
  screenObservations: ScreenObservation[];
  interviewSessionBrief?: InterviewSessionBrief;
  interviewSessionContext?: InterviewSessionContext;
  activeScreenTask?: ActiveScreenTask;
  rollingSummary: string;
  userProfileContext: string;
  glossary: GlossaryEntry[];
  lastAdvisorRequestId?: string;
}

export type ScreenTaskKind =
  | "behavioral"
  | "coding"
  | "system-design"
  | "general-system-design"
  | "ai-ml-system-design"
  | "project-deep-dive"
  | "field-knowledge"
  | "ambiguous"
  | "non-question"
  | "unknown";

export type TaskAskFrame =
  | "hypothetical-design"
  | "past-project"
  | "ambiguous"
  | "direct-answer"
  | "unknown";

export type TaskTopicDomain =
  | "ai-ml-infra"
  | "agentic-ai"
  | "search"
  | "backend"
  | "unknown";

export interface TaskClassifierMetadata {
  questionType?: ScreenTaskKind;
  askFrame?: TaskAskFrame;
  topicDomain?: TaskTopicDomain;
  projectAnchor?: string;
  confidence?: number;
  overrideSource?: "interview-type-selector";
  overrideAt?: number;
}

export type InterviewPlaybookId =
  | "behavioral_story"
  | "coding_algorithm"
  | "general_system_design"
  | "aiml_system_design"
  | "project_deep_dive"
  | "aiml_field_knowledge";

export type InterviewPlaybookPhase =
  | "story_selection"
  | "solution_planning"
  | "requirement_clarification"
  | "design_framing"
  | "project_narrative"
  | "concept_explanation"
  | "follow_up";

export interface SelectedInterviewPlaybook {
  id: InterviewPlaybookId;
  label: string;
  phase: InterviewPlaybookPhase;
  subtype?: string;
  questionType: ScreenTaskKind;
  confidence: number;
  reason: string;
  memoryPolicy: MemoryRetrievalPolicy;
  firstMove: string;
  clarifyingStrategy: string;
  outputContract: string;
  followUpPolicy: string;
}

export interface ActiveScreenTask {
  id: string;
  observationId: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  question?: string;
  kind: ScreenTaskKind;
  language?: string;
  classifier?: TaskClassifierMetadata;
  playbook?: SelectedInterviewPlaybook;
  content: string;
  basedOnTurnIds: string[];
  basedOnObservationId: string;
}

export type InterviewSessionContextSource =
  | "transcript"
  | "screen"
  | "manual"
  | "brief";

export interface InterviewTargetCompany {
  value: string;
  normalized: string;
  confidence: number;
  source: InterviewSessionContextSource;
  evidence: string;
  updatedAt: number;
}

export interface InterviewSessionContext {
  targetCompany?: InterviewTargetCompany;
}

export type InterviewBriefType =
  | "behavioral"
  | "coding"
  | "system-design"
  | "ai-ml-system-design"
  | "project-deep-dive"
  | "mixed";

export interface InterviewSessionBrief {
  targetCompany: string;
  targetCompanyNormalized?: string;
  companyLocked: boolean;
  interviewTypes: InterviewBriefType[];
  focusAreas: string;
  notes: string;
  updatedAt?: number;
}

export interface ScreenTaskAnswer {
  chineseThinking?: string;
  question?: string;
  answer?: string;
  approach?: string;
  code?: string;
  complexity?: string;
  clarifyingQuestion?: string;
  clarifyingOptions?: ClarifyingQuestionOption[];
  rawContent: string;
  parsedAt: number;
}

export type AdvisorSuggestionKind =
  | "answer"
  | "screen-task"
  | "clarifying-question"
  | "jargon"
  | "context"
  | "silent";

export type AdvisorRequestMode =
  | "live"
  | "regenerate"
  | "screen-only"
  | "screen-anchored"
  | "clarifying-answer"
  | "response-action";

export type MeetingResponseActionMode = "speakable" | "focus";

export type MeetingResponseLength = "short" | "normal" | "detailed";

export type MeetingResponseLanguage = "auto" | "english" | "chinese";

export interface MeetingResponseConfig {
  length: MeetingResponseLength;
  language: MeetingResponseLanguage;
}

export type ClarifyingQuestionAnswer =
  | "yes"
  | "no"
  | "not-sure"
  | "option";

export interface ClarifyingQuestionOption {
  id: string;
  label: string;
  value: string;
}

export interface ClarifyingQuestionFeedback {
  question: string;
  answer: ClarifyingQuestionAnswer;
  answerLabel?: string;
  answerValue?: string;
}

export interface AdvisorSuggestion {
  id: string;
  kind: AdvisorSuggestionKind;
  content: string;
  screenTaskAnswer?: ScreenTaskAnswer;
  createdAt: number;
  basedOnTurnIds: string[];
  basedOnObservationIds: string[];
  confidence: "low" | "medium" | "high";
}

export type MeetingSetupWarningCode =
  | "stt-provider-missing"
  | "ai-provider-missing"
  | "vision-provider-missing"
  | "local-only-unavailable";

export interface MeetingSetupWarning {
  code: MeetingSetupWarningCode;
  severity: "blocking" | "warning";
  message: string;
}

export interface AdvisorPromptContext {
  transcript: string;
  screenContext: string;
  interviewSessionBrief?: InterviewSessionBrief;
  interviewSessionContext?: InterviewSessionContext;
  activeScreenTask?: ActiveScreenTask;
  rollingSummary: string;
  userProfileContext: string;
  glossaryText: string;
  memoryContext?: string;
  interviewPlaybook?: SelectedInterviewPlaybook;
  latestTurn?: TranscriptTurn;
}

export interface SelectedProviderState {
  provider: string;
  variables: Record<string, string>;
}

export interface MeetingProviderConfig {
  aiProvider: TYPE_PROVIDER | undefined;
  selectedAIProvider: SelectedProviderState;
  sttProvider: TYPE_PROVIDER | undefined;
  selectedSttProvider: SelectedProviderState;
}

export interface MeetingAdvisorRequest {
  requestId: string;
  mode?: AdvisorRequestMode;
  responseAction?: MeetingResponseActionMode;
  responseConfig?: MeetingResponseConfig;
  promptContext: AdvisorPromptContext;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  currentSuggestion?: string;
  clarifyingFeedback?: ClarifyingQuestionFeedback;
  history?: Message[];
  signal?: AbortSignal;
  requestOptions?: MeetingModelRequestOptions;
  trace?: MeetingModelTraceCallbacks;
}

export interface MeetingModelRequestOptions {
  timeoutMs?: number;
  maxOutputTokens?: number;
}

export interface MeetingModelTraceCallbacks {
  onRequest?: (input: {
    systemPrompt: string;
    userMessage: string;
    imageCount: number;
    imageMediaType?: string;
    providerId?: string;
    mode?: AdvisorRequestMode | "screen-task" | "screen-preflight";
    responseAction?: MeetingResponseActionMode;
    responseConfig?: MeetingResponseConfig;
    requestOptions?: MeetingModelRequestOptions;
  }) => void;
  onFirstToken?: () => void;
  onComplete?: (output: string) => void;
}

export interface MeetingAudioConfig {
  enabled: boolean;
  hop_size: number;
  sensitivity_rms: number;
  peak_threshold: number;
  silence_chunks: number;
  min_speech_chunks: number;
  pre_speech_chunks: number;
  noise_gate_threshold: number;
  max_recording_duration_secs: number;
}

export type MeetingAudioProfile = "quiet" | "balanced" | "sensitive" | "custom";

export interface MeetingAudioSettings {
  profile: MeetingAudioProfile;
  config: MeetingAudioConfig;
}

export interface MeetingCodingModelSettings extends SelectedProviderState {}

export interface MeetingAudioStatus {
  active: boolean;
  systemCaptureActive: boolean;
  captureOwner: string | null;
  deviceId: string | null;
  sampleRate: number | null;
  vadEnabled: boolean;
  startedAtMs: number | null;
}

export type MeetingPrivacyMode =
  | "memory-only"
  | "text-and-screen-to-cloud";

export interface MeetingAssistantSettings {
  screenContextEnabled: boolean;
  privacyMode: MeetingPrivacyMode;
  activeScreenTaskTimeoutMinutes: number;
  useMemory: boolean;
  debugMode: boolean;
  microphoneContextEnabled: boolean;
  response: MeetingResponseConfig;
  codingModel: MeetingCodingModelSettings;
  audio: MeetingAudioSettings;
}

export type MeetingTraceKind = "screen" | "voice";

export type MeetingTraceStatus = "running" | "success" | "error" | "cancelled";

export interface MeetingTraceStep {
  id: string;
  name: string;
  status: MeetingTraceStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  metadata?: Record<string, unknown>;
  error?: string;
}

export interface MeetingTraceIO {
  label: string;
  value: string;
  metadata?: Record<string, unknown>;
  recordedAt: number;
}

export interface MeetingTrace {
  id: string;
  kind: MeetingTraceKind;
  status: MeetingTraceStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  steps: MeetingTraceStep[];
  inputs: MeetingTraceIO[];
  outputs: MeetingTraceIO[];
  metadata?: Record<string, unknown>;
  error?: string;
}

export type MeetingTraceExportTrigger = "manual" | "auto-error" | "auto-slow";

export interface MeetingTraceExportRecord {
  traceId: string;
  path: string;
  trigger: MeetingTraceExportTrigger;
  exportedAt: number;
}

export interface MeetingSessionRecordingState {
  active: boolean;
  sessionId?: string;
  folderName?: string;
  folderPath?: string;
  startedAt?: number;
  endedAt?: number;
  eventCount: number;
  artifactCount: number;
  lastError?: string;
}

export type HumanEvalQuestionType =
  | "behavioral"
  | "coding"
  | "system-design"
  | "general-system-design"
  | "ai-ml-system-design"
  | "project-deep-dive"
  | "field-knowledge"
  | "unknown";

export type HumanEvalTaskQuality = "success" | "partial" | "fail";

export type HumanEvalFailureReason =
  | "wrong-question-type"
  | "wrong-playbook"
  | "wrong-playbook-phase"
  | "wrong-company"
  | "wrong-memory"
  | "missing-memory"
  | "wrong-answer"
  | "too-short"
  | "too-slow"
  | "stt-error"
  | "capture-error"
  | "other";

export interface TraceHumanEvaluation {
  id: string;
  traceId: string;
  traceKind: MeetingTraceKind;
  createdAt: number;
  updatedAt: number;
  correctedQuestionType?: HumanEvalQuestionType;
  correctedCompany?: string;
  playbookCorrect?: boolean;
  playbookWrong?: boolean;
  playbookWrongPhase?: boolean;
  memoryRelevant?: boolean;
  memoryMissing?: boolean;
  memoryWrong?: boolean;
  taskQuality?: HumanEvalTaskQuality;
  failureReasons: HumanEvalFailureReason[];
  notes?: string;
}

export interface MeetingAssistantState {
  status: MeetingAssistantStatus;
  transcriptTurns: TranscriptTurn[];
  screenObservations: ScreenObservation[];
  interviewSessionBrief?: InterviewSessionBrief;
  interviewSessionContext?: InterviewSessionContext;
  activeScreenTask?: ActiveScreenTask;
  traces: MeetingTrace[];
  latestSuggestion: AdvisorSuggestion | null;
  partialSuggestion: string;
  error: string | null;
  audioStatus: MeetingAudioStatus | null;
  settings: MeetingAssistantSettings;
  lastMemoryContext?: MemoryRetrievalResult;
  lastTraceExport?: MeetingTraceExportRecord;
  sessionRecording: MeetingSessionRecordingState;
  humanEvaluations: TraceHumanEvaluation[];
  speechCorrections: SpeechCorrection[];
}
