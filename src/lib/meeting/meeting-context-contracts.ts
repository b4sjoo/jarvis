import type {
  AdvisorContextScopeSnapshot,
  AdvisorCurrentQuestionProjection,
  AdvisorEvidencePacket,
  AdvisorRequestMode,
  AdvisorSuggestion,
  ClarifyingQuestionFeedback,
  DisplayTranscriptArtifact,
  DisplayTranscriptWindow,
  FactAnchorDecision,
  ForceAdviseTargetPresentation,
  InterviewSessionBrief,
  InterviewSessionContext,
  ManualQuestionTypeCorrection,
  MeetingAnswerProfile,
  MeetingAssistantSettings,
  MeetingAssistantStatus,
  MeetingAudioStatus,
  MeetingModelRequestOptions,
  MeetingModelTraceCallbacks,
  MeetingResponseActionMode,
  MeetingResponseConfig,
  MeetingSessionRecordingState,
  MeetingTrace,
  MeetingTraceExportRecord,
  NativeAudioManualRecoveryState,
  OpeningRouteContext,
  ProjectBindingDecision,
  QuestionHumanEvaluation,
  QuestionInstanceLineage,
  ScreenObservation,
  SelectedInterviewPlaybook,
  SelectedProviderState,
  SpeechCorrection,
  SttEvaluationCaptureState,
  TraceHumanEvaluation,
  TranscriptTurn,
  TransientPersonalStatusDecision,
} from "./types.js";
import type { ActiveMeetingTask, MeetingTaskRuntimeState } from "./meeting-task-contracts.js";
import type { PlaybookPhaseDecision } from "./playbook-phase-contracts.js";
import type { Message } from "../../types/completion.js";
import type { TYPE_PROVIDER } from "../../types/provider.type.js";
import type { AIResponseExecutionIdentityInput } from "../functions/ai-response-events.js";
import type { AudioInputLivenessPresentation } from "./meeting-presentation-contracts.js";
import type { MemoryRetrievalResult } from "../memory/types.js";

export interface MeetingContextState {
  sessionId: string;
  startedAt: number;
  transcriptTurns: TranscriptTurn[];
  screenObservations: ScreenObservation[];
  interviewSessionBrief?: InterviewSessionBrief;
  interviewSessionContext?: InterviewSessionContext;
  taskRuntime: MeetingTaskRuntimeState;
  activeMeetingTask?: ActiveMeetingTask;



  lastAdvisorRequestId?: string;
}

export interface AdvisorPromptContext {
  transcript: string;
  advisorPromptSourceTurnIds?: string[];
  screenContext: string;
  currentQuestionProjection?: AdvisorCurrentQuestionProjection;

  interviewSessionBrief?: InterviewSessionBrief;
  interviewSessionContext?: InterviewSessionContext;
  taskRuntime: MeetingTaskRuntimeState;
  activeMeetingTask?: ActiveMeetingTask;



  memoryContext?: string;
  interviewPlaybook?: SelectedInterviewPlaybook;
  playbookPhaseDecision?: PlaybookPhaseDecision;
  factAnchorDecision?: FactAnchorDecision;
  transientPersonalStatusDecision?: TransientPersonalStatusDecision;
  projectBindingDecision?: ProjectBindingDecision;
  openingRoute?: OpeningRouteContext;
  confirmedMeFacts?: Array<{
    id: string;
    text: string;
  }>;
  latestTurn?: TranscriptTurn;
  responseActionContextScope?: AdvisorContextScopeSnapshot;
  advisorEvidencePacket?: AdvisorEvidencePacket;
  whiteboardFormatPreference?: import("./types.js").WhiteboardFormatPreference;
  codingSolutionManifestContext?: string;
}

export interface MeetingAdvisorRequest {
  requestId: string;
  mode?: AdvisorRequestMode;
  responseAction?: MeetingResponseActionMode;
  responseConfig?: MeetingResponseConfig;
  answerProfile?: MeetingAnswerProfile;
  promptContext: AdvisorPromptContext;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  currentSuggestion?: string;
  clarifyingFeedback?: ClarifyingQuestionFeedback;
  history?: Message[];
  sourceImages?: Array<{
    base64: string;
    mediaType: string;
  }>;
  signal?: AbortSignal;
  requestOptions?: MeetingModelRequestOptions;
  executionIdentity?: AIResponseExecutionIdentityInput;
  trace?: MeetingModelTraceCallbacks;
}

export interface MeetingAssistantState {
  status: MeetingAssistantStatus;
  transcriptTurns: TranscriptTurn[];
  latestDisplayTranscript?: DisplayTranscriptArtifact;
  displayTranscriptWindow?: DisplayTranscriptWindow;
  screenObservations: ScreenObservation[];
  interviewSessionBrief?: InterviewSessionBrief;
  interviewSessionContext?: InterviewSessionContext;
  preparationRuntime: import("./preparation-runtime-contracts.js").PreparationRuntimePresentation;
  taskRuntime: MeetingTaskRuntimeState;
  activeMeetingTask?: ActiveMeetingTask;
  manualQuestionTypeCorrection?: ManualQuestionTypeCorrection;
  currentQuestionLineage?: QuestionInstanceLineage;
  latestInterviewerTurnCandidate?: ForceAdviseTargetPresentation;
  traces: MeetingTrace[];
  latestSuggestion: AdvisorSuggestion | null;
  latestReliableSuggestion: AdvisorSuggestion | null;
  partialSuggestion: string;
  answerDelivery: import("./meeting-presentation-contracts.js").AnswerDeliveryPresentation;
  generationResult: import("./meeting-presentation-contracts.js").GenerationResultProjection;
  error: string | null;
  audioStatus: MeetingAudioStatus | null;
  audioInputLiveness: AudioInputLivenessPresentation | null;
  nativeAudioManualRecovery?: NativeAudioManualRecoveryState;
  settings: MeetingAssistantSettings;
  lastMemoryContext?: MemoryRetrievalResult;
  lastTraceExport?: MeetingTraceExportRecord;
  sessionRecording: MeetingSessionRecordingState;
  runtimeRegression: import("./meeting-presentation-contracts.js").RuntimeRegressionRunnerPresentation;
  sttEvaluationCapture: SttEvaluationCaptureState;
  humanEvaluations: TraceHumanEvaluation[];
  questionEvaluations: QuestionHumanEvaluation[];
  speechCorrections: SpeechCorrection[];
  presentationArtifactResetRevision: number;
}
