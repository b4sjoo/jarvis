import { Message, TYPE_PROVIDER } from "@/types";
import type { MemoryRetrievalResult } from "@/lib/memory/types";

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
  appName?: string;
  title?: string;
  monitorName?: string;
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
  appName: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
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
  | "coding"
  | "field-knowledge"
  | "ambiguous"
  | "non-question"
  | "unknown";

export interface ActiveScreenTask {
  id: string;
  observationId: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  question?: string;
  kind: ScreenTaskKind;
  language?: string;
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
  question?: string;
  answer?: string;
  approach?: string;
  code?: string;
  complexity?: string;
  clarifyingQuestion?: string;
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

export type MeetingResponseActionMode = "speakable" | "bilingual" | "focus";

export type MeetingResponseLength = "short" | "normal" | "detailed";

export type MeetingResponseLanguage = "auto" | "english" | "chinese";

export interface MeetingResponseConfig {
  length: MeetingResponseLength;
  language: MeetingResponseLanguage;
}

export type ClarifyingQuestionAnswer = "yes" | "no" | "not-sure";

export interface ClarifyingQuestionFeedback {
  question: string;
  answer: ClarifyingQuestionAnswer;
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
  trace?: MeetingModelTraceCallbacks;
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
  | "text-to-cloud"
  | "text-and-screen-to-cloud";

export interface MeetingAssistantSettings {
  screenContextEnabled: boolean;
  privacyMode: MeetingPrivacyMode;
  activeScreenTaskTimeoutMinutes: number;
  useMemory: boolean;
  debugMode: boolean;
  response: MeetingResponseConfig;
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
}
