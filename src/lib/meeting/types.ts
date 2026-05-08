import { Message, TYPE_PROVIDER } from "@/types";

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
  ocrText?: string;
  visualSummary?: string;
  hash?: string;
  changed: boolean;
  confidence?: number;
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
  rollingSummary: string;
  userProfileContext: string;
  glossary: GlossaryEntry[];
  lastAdvisorRequestId?: string;
}

export type AdvisorSuggestionKind =
  | "answer"
  | "clarifying-question"
  | "jargon"
  | "context"
  | "silent";

export type AdvisorRequestMode = "live" | "regenerate" | "shorter";

export interface AdvisorSuggestion {
  id: string;
  kind: AdvisorSuggestionKind;
  content: string;
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
  rollingSummary: string;
  userProfileContext: string;
  glossaryText: string;
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
  promptContext: AdvisorPromptContext;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  currentSuggestion?: string;
  history?: Message[];
  signal?: AbortSignal;
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
}

export interface MeetingAssistantState {
  status: MeetingAssistantStatus;
  transcriptTurns: TranscriptTurn[];
  screenObservations: ScreenObservation[];
  latestSuggestion: AdvisorSuggestion | null;
  partialSuggestion: string;
  error: string | null;
  audioStatus: MeetingAudioStatus | null;
  settings: MeetingAssistantSettings;
}
