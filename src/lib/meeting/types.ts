import { Message, TYPE_PROVIDER } from "@/types";
import type {
  MemoryRetrievalPolicy,
  MemoryRetrievalResult,
} from "@/lib/memory/types";
import type {
  CanonicalQuestionType,
  LegacyQuestionTypeAlias,
  TaxonomyHumanEvalQuestionType,
  TaxonomyInterviewBriefType,
  TransitionalQuestionType,
} from "./task-taxonomy";
import type {
  ActiveMeetingTask,
  MeetingTaskRuntimeState,
} from "./active-meeting-task";
import type { PlaybookPhaseDecision } from "./playbook-phase";
import type { AudioInputLivenessPresentation } from "./audio-input-liveness";
import type {
  PreparationNarrativeNodeKind,
  PreparationRuntimeBrief,
  PreparationStrategy,
} from "../preparation/index.js";
import type {
  AIResponseExecutionIdentityInput,
  AIResponseTerminalOutcome,
} from "../functions/ai-response-events.js";

export type TranscriptSpeaker = "them" | "me" | "unknown";

export type MeetingAssistantStatus =
  | "idle"
  | "starting"
  | "reconnecting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "paused"
  | "error";

export interface NativeAudioManualRecoveryState {
  requiredAt: number;
  reason: string | null;
  message: string | null;
  interruptedCaptureSessionId: string;
  interruptedCaptureGeneration: number;
  circuitBreakerOpen: boolean;
}

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

export type DisplayTranscriptFinalization =
  | "provisional"
  | "silence"
  | "provider-final"
  | "stop"
  | "termination"
  | "timeout";

export interface DisplayTranscriptArtifact {
  utteranceId: string;
  revision: number;
  speaker: TranscriptSpeaker;
  source: TranscriptTurn["source"];
  segmentIds: string[];
  sourceTurnIds: string[];
  providerChars: number;
  displayChars: number;
  overlapCharsRemoved: number;
  omittedChars: number;
  text: string;
  finalization: DisplayTranscriptFinalization;
  startedAt: number;
  endedAt: number;
}

export interface DisplayTranscriptHistoryEntry {
  utteranceId: string;
  sourceTurnIds: string[];
  text: string;
  startedAt: number;
  endedAt: number;
}

export interface DisplayTranscriptWindow {
  current?: DisplayTranscriptArtifact;
  history: DisplayTranscriptHistoryEntry[];
  historyChars: number;
}

export type SpeechBiasTermSource =
  | "brief"
  | "preparation"
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
  preparationStatementIds: string[];
}

export type ActiveQuestionTermCorrectionDisposition =
  | "current-question-overlay"
  | "future-speech-bias"
  | "stale-rejected";

export type ActiveQuestionTermCorrectionRegenerationStatus =
  | "idle"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ActiveQuestionTermCorrection {
  correctionId: string;
  rawText: string;
  normalizedTerm: string;
  replacedText?: string;
  logicalQuestionUnitId?: string;
  logicalQuestionUnitRevision?: number;
  correctedLogicalQuestionUnitRevision?: number;
  sourceTurnIds: string[];
  manualCorrectionRevision: number;
  disposition: ActiveQuestionTermCorrectionDisposition;
  correctionTraceId: string;
  regenerationTraceId?: string;
  settlementId?: string;
  semanticAdjudicationOperationId?: string;
  semanticAdjudicationStatus?:
    | "skipped"
    | "running"
    | "succeeded"
    | "timed-out"
    | "failed"
    | "stale";
  semanticAdjudicationTriggerReason?: string;
  semanticAdjudicationCandidateType?: CanonicalQuestionType;
  semanticAdjudicationRelation?: string;
  semanticAdjudicationConfidence?: number;
  semanticAdjudicationDurationMs?: number;
  semanticResettlementDisposition?: string;
  previousParentType?: CanonicalQuestionType;
  resettledParentType?: CanonicalQuestionType;
  regenerationStatus: ActiveQuestionTermCorrectionRegenerationStatus;
  requestedAt: number;
  completedAt?: number;
  correctionToAnswerLatencyMs?: number;
  error?: string;
}

export interface SpeechCorrection {
  id: string;
  input: string;
  term?: string;
  from?: string;
  to?: string;
  createdAt: number;
  appliedCount: number;
  activeQuestion?: ActiveQuestionTermCorrection;
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
  taskRuntime: MeetingTaskRuntimeState;
  activeMeetingTask?: ActiveMeetingTask;
  rollingSummary: string;
  userProfileContext: string;
  glossary: GlossaryEntry[];
  lastAdvisorRequestId?: string;
}

export type ScreenQuestionType =
  | CanonicalQuestionType
  | TransitionalQuestionType;

export type ScreenTaskKind = ScreenQuestionType | LegacyQuestionTypeAlias;

export type ParentQuestionType = Exclude<
  CanonicalQuestionType,
  "field-knowledge" | "unknown"
>;

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
  questionType?: ScreenQuestionType;
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
  | "baseline_reasoning"
  | "optimized_pseudocode"
  | "implementation_validation"
  // Legacy persisted Coding phase. New runtime decisions normalize this to
  // baseline_reasoning and never create it.
  | "solution_planning"
  | "requirement_clarification"
  | "design_framing"
  | "project_narrative"
  | "architecture_decision"
  | "validation_reliability"
  | "impact_lessons"
  | "concept_explanation"
  | "follow_up";

export interface SelectedInterviewPlaybook {
  id: InterviewPlaybookId;
  label: string;
  phase: InterviewPlaybookPhase;
  subtype?: string;
  questionType: CanonicalQuestionType;
  confidence: number;
  reason: string;
  memoryPolicy: MemoryRetrievalPolicy;
  firstMove: string;
  clarifyingStrategy: string;
  outputContract: string;
  followUpPolicy: string;
}

export type FactAnchorState =
  | "strong-anchor"
  | "weak-anchor"
  | "no-anchor"
  | "not-required";

export type FactAnchorRequiredFor =
  | "behavioral"
  | "project-deep-dive"
  | "personal-logistics"
  | "none";

export type FactAnchorAction =
  | "answer-with-anchor"
  | "answer-with-caveats"
  | "ask-clarification"
  | "offer-supported-choices";

export type PersonalEvidenceRequirement =
  | "not-required"
  | "autobiographical-project"
  | "autobiographical-behavioral"
  | "personal-logistics";

export type PersonalEvidenceConfidenceTier = "low" | "medium" | "high";

export type PersonalEvidenceGuardrailMode = "enforcement" | "shadow";
export type SemanticTaxonomyMode = "enforcement" | "shadow";

export type PersonalEvidenceStatusDomain =
  | "health-status"
  | "work-authorization"
  | "location-relocation"
  | "availability-start-date"
  | "compensation"
  | "employment-status";

export type PersonalStatusDomain =
  | "relocation"
  | "compensation"
  | "work-authorization"
  | "start-date";

export type PersonalEvidenceSource =
  | "profile-memory"
  | "confirmed-me";

export interface PersonalEvidenceDecision {
  requirement: PersonalEvidenceRequirement;
  confidence: number;
  confidenceTier: PersonalEvidenceConfidenceTier;
  signals: string[];
  counterSignals: string[];
  statusDomain?: PersonalEvidenceStatusDomain;
  allowedEvidenceSources: PersonalEvidenceSource[];
  mode: PersonalEvidenceGuardrailMode;
  enforced: boolean;
}

export interface TransientPersonalStatusDecision {
  id: string;
  domain: PersonalStatusDomain;
  sourceQuestionUnitId: string;
  sourceQuestionRevision: number;
  responseOwner: "personal-status";
  evidencePolicy: "profile-only";
  disposition: "domain-resolved-unknown";
  confidence: number;
  preserveParentTask: true;
  preserveArtifacts: true;
  preservedParentTaskId?: string;
  preservedParentQuestionType?: ScreenQuestionType;
  preservedPlaybookPhase?: InterviewPlaybookPhase;
  preservedWhiteboardArtifactId?: string;
  createdAt: number;
}

export type ProjectBindingSource =
  | "interview-brief"
  | "memory"
  | "user-selection"
  | "correction"
  | "interviewer-explicit"
  | "user-explicit"
  | "manual-correction";

export type ProjectBindingAuthority =
  | "interviewer-explicit"
  | "user-explicit"
  | "manual-correction"
  | "interview-brief"
  | "compatible-existing"
  | "memory-candidate";

export interface ExplicitProjectSelection {
  sessionId: string;
  runtimeEpoch: number;
  sourceTurnId: string;
  sourceObservationId?: string;
  projectId?: string;
  projectName: string;
  authority:
    | "interviewer-explicit"
    | "user-explicit"
    | "manual-correction";
  actionRevision: number;
  createdAt: number;
}

export interface ProjectTopicEvidence {
  sourceText: string;
  explicitProjectIds: string[];
  explicitProjectNames: string[];
  explicitProjectAliases?: string[];
  featureTerms: string[];
  actionTerms: string[];
  resultTerms: string[];
  conflictingProjectNames: string[];
}

export interface ProjectBinding {
  projectId?: string;
  projectName: string;
  primaryEntryId: string;
  evidenceEntryIds: string[];
  source: ProjectBindingSource;
  confidence: number;
  lockedAt: number;
  revision: number;
  reason: string;
  authority?: ProjectBindingAuthority;
  sourceTurnIds?: string[];
  sourceObservationIds?: string[];
}

export interface ProjectBindingCandidate {
  projectId?: string;
  projectName: string;
  primaryEntryId: string;
  evidenceEntryIds: string[];
  identityAliases?: string[];
  score: number;
}

export type ProjectBindingAction =
  | "not-applicable"
  | "preserve"
  | "bind"
  | "rebind"
  | "invalidate"
  | "needs-selection";

export interface ProjectBindingDecision {
  action: ProjectBindingAction;
  binding?: ProjectBinding;
  previousBinding?: ProjectBinding;
  candidates: ProjectBindingCandidate[];
  changed: boolean;
  sourceAuthority: ProjectBindingAuthority;
  sourceTurnIds: string[];
  sourceObservationIds: string[];
  topicCompatible: boolean;
  topicEvidence?: ProjectTopicEvidence;
  bindingRevision: number;
  reason: string;
}

export type ClaimPredicateFamily =
  | "project-overview"
  | "architecture-decision"
  | "validation-reliability"
  | "impact-lessons"
  | "role-contribution"
  | "collaboration-stakeholders"
  | "behavioral-story"
  | "personal-status";

export interface ClaimSupportDecision {
  claimId: string;
  predicateFamily: ClaimPredicateFamily;
  supportScope?: "question-predicate" | "anchor-evidence";
  anchorId?: string;
  projectCompatible: boolean;
  predicateCompatible: boolean;
  supportSpanPresent: boolean;
  supportSpan?: string;
  conflictFree: boolean;
  decision: "allow" | "reject" | "needs-clarification";
  reason: string;
}

export interface FactAnchorDecision {
  state: FactAnchorState;
  requiredFor: FactAnchorRequiredFor;
  supportedAnchorIds: string[];
  supportedAnchorTitles: string[];
  selectedAnchorId?: string;
  missingAnchorReason?: string;
  action: FactAnchorAction;
  personalEvidence: PersonalEvidenceDecision;
  selectedPersonalEvidenceSources: PersonalEvidenceSource[];
  unsupportedClaimRisk: "none" | "guarded" | "high" | "shadow-observed";
  claimPredicateFamily?: ClaimPredicateFamily;
  claimSupportDecisions: ClaimSupportDecision[];
  requirementSource?:
    | "current-question-personal-evidence"
    | "current-question-project-source"
    | "settled-question-type"
    | "none";
  requirementReason?: string;
  projectFactSensitive?: boolean;
  projectFactSensitiveTypeMismatch?: boolean;
}

export interface ActiveScreenTask {
  id: string;
  observationId: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  question?: string;
  kind: ScreenQuestionType;
  language?: string;
  classifier?: TaskClassifierMetadata;
  playbook?: SelectedInterviewPlaybook;
  content: string;
  basedOnTurnIds: string[];
  basedOnObservationId: string;
}

export type InterviewTaskRelation =
  | "new-parent"
  | "followup-parent"
  | "child-probe"
  | "resume-parent"
  | "logistics"
  | "correction"
  | "unknown";

export type HumanExpectedParentAction =
  | "create"
  | "preserve"
  | "resume"
  | "attach-child"
  | "none";

export type InterviewSubtaskIntent =
  | "concept-probe"
  | "implementation-probe"
  | "complexity-probe"
  | "metric-probe"
  | "qps-estimation"
  | "project-detail"
  | "story-detail"
  | "clarification"
  | "low-value"
  | "unknown";

export interface ParentReturnCapsule {
  parentId: string;
  parentRevisionAtAttach: number;
  projectBindingRevision?: number;
  parentPhase: InterviewPlaybookPhase;
  topicCapsule: string;
  allowedFactAnchorIds: string[];
  artifactCompatibility: {
    policy: "preserve-parent-artifacts";
    whiteboardArtifactId?: string;
  };
  createdAt: number;
}

export interface ActiveInterviewChild {
  id: string;
  createdAt: number;
  updatedAt: number;
  questionType: CanonicalQuestionType;
  relation: "child-probe";
  intent: InterviewSubtaskIntent;
  question: string;
  compactSummary?: string;
  artifactId?: string;
  basedOnTurnIds: string[];
  basedOnObservationIds: string[];
  returnCapsule?: ParentReturnCapsule;
}

export type ParentAdmissionDurability = "provisional" | "durable";

export type ParentAdmissionAction =
  | "append-only"
  | "provisional"
  | "create-parent"
  | "reseed-parent"
  | "preserve-parent";

export interface ParentAdmissionRecord {
  durability: ParentAdmissionDurability;
  action: Extract<
    ParentAdmissionAction,
    "create-parent" | "reseed-parent"
  >;
  authoritySource: string;
  sourceTurnIds: string[];
  sourceObservationIds: string[];
  reason: string;
  admittedAt: number;
}

export type WhiteboardDomainTrack =
  | "general_sd"
  | "ml_sd"
  | "genai_sd"
  | "hybrid";

export type WhiteboardUpdateSource =
  | "model-output"
  | "manual-next"
  | "screen-merge"
  | "correction-regenerate"
  | "task-reset"
  | "new-parent";

export type WhiteboardRenderStatus =
  | "pending-validation"
  | "valid-text"
  | "valid-mermaid"
  | "repairing"
  | "repaired-mermaid"
  | "ascii-fallback"
  | "preserved-last-valid"
  | "invalid";

export interface WhiteboardRenderState {
  artifactId: string;
  parentTaskId: string;
  candidateRevision: number;
  visibleRevision?: number;
  lastValidRevision?: number;
  status: WhiteboardRenderStatus;
  validationOperationId: string;
  candidateFingerprint?: string;
  validationDurationMs?: number;
  repairOperationId?: string;
  repairDurationMs?: number;
  repairDisposition?: string;
  parserErrorClass?: string;
  fallbackKind?:
    | "deterministic-ascii"
    | "deterministic-edge-list"
    | "sanitized-text"
    | "unavailable"
    | "model-ascii"
    | "last-valid"
    | "renderer-boundary";
  fallbackReason?: string;
  validatedAt?: number;
}

export interface WhiteboardArtifact {
  id: string;
  parentTaskId: string;
  questionInstanceId?: string;
  domainTrack: WhiteboardDomainTrack;
  archetypeIds: string[];
  selectedOverlayIds: string[];
  currentPhase: InterviewPlaybookPhase;
  title: string;
  content: string;
  summary: string;
  revision: number;
  provisional?: boolean;
  openConstraintCategories?: string[];
  revisionReason?: string;
  createdTraceId?: string;
  lastUpdatedTraceId?: string;
  renderState?: WhiteboardRenderState;
  updateSource: WhiteboardUpdateSource;
  updatedAt: number;
  createdAt: number;
}

export interface ParentContextHandoffScaleAssumption {
  value: string;
  sourceTurnId?: string;
}

export interface ParentContextHandoff {
  sourceParentId: string;
  transitionKind: "domain-extension";
  sourceQuestionId: string;
  sharedScenarioContext: {
    productIdentity?: string;
    domainEntities?: string[];
    applicableScaleAssumptions?: ParentContextHandoffScaleAssumption[];
    sharedRequirements?: string[];
  };
  excludedContextKinds: string[];
}

export interface ActiveInterviewParent {
  id: string;
  source: "screen" | "voice";
  stableKind: ParentQuestionType;
  topic: string;
  playbook?: SelectedInterviewPlaybook;
  playbookPhase: InterviewPlaybookPhase;
  phaseProgress: Record<string, boolean>;
  projectBinding?: ProjectBinding;
  supportedFactAnchors: string[];
  latestUsefulAnswer?: string;
  previousUsefulAnswer?: string;
  whiteboardArtifact?: WhiteboardArtifact;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  originQuestionId?: string;
  startTurnId?: string;
  startObservationId?: string;
  promptTranscriptStartTurnId?: string;
  canonicalQuestionSourceTurnIds?: string[];
  sourceQuestionUnitId?: string;
  sourceQuestionRevision?: number;
  settlementId?: string;
  parentContextHandoff?: ParentContextHandoff;
  admission?: ParentAdmissionRecord;
  child?: ActiveInterviewChild;
  revisions: number;
}

export type ManualQuestionTypeCorrectionSource =
  | "focus-mode"
  | "normal-mode";

export type ManualQuestionTypeCorrectionTarget =
  | "parent"
  | "child"
  | "resume-parent"
  | "provisional-question";

export type ManualQuestionTypeCorrectionTargetSource =
  | "active-task"
  | "current-question"
  | "provisional-question";

export type ManualCorrectionScope =
  | "same-question-retype"
  | "child-retype"
  | "resume-parent"
  | "linked-parent-extension"
  | "independent-new-parent"
  | "current-only";

export type ManualQuestionTypeCorrectionStatus =
  | "pending"
  | "applied"
  | "failed"
  | "superseded";

export type ManualQuestionTypeRegenerationStatus =
  | "idle"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ManualQuestionTypeCorrection {
  eventId: string;
  taskId: string;
  parentTaskId: string;
  childTaskId?: string;
  questionId: string;
  source: ManualQuestionTypeCorrectionSource;
  targetSource: ManualQuestionTypeCorrectionTargetSource;
  target: ManualQuestionTypeCorrectionTarget;
  scope?: ManualCorrectionScope;
  scopeReason?: string;
  standaloneTaskScore?: number;
  standaloneTaskEvidence?: string[];
  continuityScore?: number;
  continuityEvidence?: string[];
  previousParentId?: string;
  nextParentId?: string;
  parentHandoffSourceId?: string;
  preservedContextFields?: string[];
  clearedContextFields?: string[];
  promptTranscriptStartTurnId?: string;
  logicalQuestionUnitId?: string;
  logicalQuestionRevision?: number;
  sourceObservationIds?: string[];
  questionOriginTraceId?: string;
  settlementId?: string;
  settledRelation?: string;
  detectedType: CanonicalQuestionType;
  correctedType: CanonicalQuestionType;
  correctionTraceId: string;
  supersedesCorrectionId?: string;
  supersededByCorrectionId?: string;
  regenerationTraceId?: string;
  regenerationCommitDisposition?:
    | "committed"
    | "no-stable-answer-commit"
    | "cancelled"
    | "error";
  regenerationRetryable?: boolean;
  evaluationId?: string;
  status: ManualQuestionTypeCorrectionStatus;
  regenerationStatus: ManualQuestionTypeRegenerationStatus;
  requestedAt: number;
  appliedAt?: number;
  completedAt?: number;
  error?: string;
}

export type InterviewSessionContextSource =
  | "manual"
  | "brief"
  | "runtime-inference";

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

export type InterviewBriefType = TaxonomyInterviewBriefType;

export interface InterviewSessionBrief {
  targetCompany: string;
  targetCompanyNormalized?: string;
  companyLocked: boolean;
  interviewTypes: InterviewBriefType[];
  updatedAt?: number;
}

export interface ScreenTaskAnswer {
  chineseThinking?: string;
  question?: string;
  answer?: string;
  approach?: string;
  whiteboard?: string;
  code?: string;
  complexity?: string;
  clarifyingQuestion?: string;
  clarifyingOptions?: ClarifyingQuestionOption[];
  rawContent: string;
  parsedAt: number;
}

export type MeetingAnswerContractVersion =
  | "meeting-answer-v3"
  | "meeting-answer-v2"
  | "legacy-live-v1"
  | "legacy-screen-v1"
  | "unstructured";

export type MeetingAnswerProfile =
  | "compact-spoken"
  | "technical"
  | "coding"
  | "system-design";

export type MeetingAnswerParseStatus =
  | "parsed"
  | "partial"
  | "fallback"
  | "empty";

export type MeetingAnswerPrimarySource =
  | "answer"
  | "reply-alias"
  | "fallback"
  | "none";

export type AnswerDisposition =
  | "factual-with-anchor"
  | "bounded-with-caveat"
  | "clarification"
  | "supported-choices"
  | "not-fact-dependent";

export interface MeetingAnswerSections {
  chineseThinking?: string;
  question?: string;
  answer?: string;
  approach?: string;
  whiteboard?: string;
  code?: string;
  complexity?: string;
  clarifyingQuestion?: string;
  clarifyingOptions: ClarifyingQuestionOption[];
}

export interface ParsedMeetingAnswer {
  sections: MeetingAnswerSections;
  answerDisposition?: AnswerDisposition;
  supportingAnchorIds: string[];
  rawContent: string;
  contractVersion: MeetingAnswerContractVersion;
  profile?: MeetingAnswerProfile;
  parseStatus: MeetingAnswerParseStatus;
  primaryAnswerSource: MeetingAnswerPrimarySource;
  recognizedLabels: string[];
  missingExpectedSections: string[];
  parsedAt: number;
}

export type AdvisorSuggestionKind =
  | "answer"
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

export type MeetingResponseActionMode =
  | "speakable"
  | "narrow-context"
  | "enhance-context"
  | "previous-phase"
  | "next-phase";

export type AdvisorContextScopeMode =
  | "default"
  | "current-only"
  | "expanded";

export interface AdvisorContextScopeSnapshot {
  operationId: string;
  action: "narrow-context" | "enhance-context";
  mode: AdvisorContextScopeMode;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  selectedContextSourceKinds: string[];
  selectedContextTurnIds: string[];
  selectedContextChars: number;
  selectionReason: string;
  expansionBudget: number;
}

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
  requestId?: string;
  questionKey?: string;
  optionSource?: import("./clarifying-options.js").ClarifyingOptionSource;
  optionCount?: number;
  booleanFallbackUsed?: boolean;
}

export type ClarifyingSelectionLifecycleState =
  | "pending"
  | "succeeded"
  | "failed"
  | "stale";

export interface ClarifyingQuestionInteractionContext {
  questionKey: string;
  optionSource: import("./clarifying-options.js").ClarifyingOptionSource;
  optionCount: number;
  booleanFallbackUsed: boolean;
}

export interface ClarifyingQuestionInteractionOutcome {
  requestId: string;
  traceId?: string;
  state: ClarifyingSelectionLifecycleState;
  reason: string;
}

export interface FactGuardrailVisibleNotice {
  kind:
    | "rebuilt-from-supported-evidence"
    | "generic-hypothetical-fallback";
  message: string;
}

export interface AdvisorSuggestion {
  id: string;
  sourceTraceId?: string;
  kind: AdvisorSuggestionKind;
  content: string;
  meetingAnswer?: ParsedMeetingAnswer;
  answerProfile?: MeetingAnswerProfile;
  createdAt: number;
  taskId?: string;
  parentTaskId?: string;
  childTaskId?: string;
  taskSource?: "screen" | "voice" | "mixed";
  questionType?: ScreenQuestionType;
  codeArtifactMutationAuthorized?: boolean;
  complexityArtifactMutationAuthorized?: boolean;
  whiteboardArtifactMutationAuthorized?: boolean;
  codeArtifactRevision?: number;
  complexityArtifactRevision?: number;
  presentationArtifactAuthority?:
    import("./screen-artifact-authority.js").ScreenPresentationArtifactAuthoritySource;
  factGuardrailNotice?: FactGuardrailVisibleNotice;
  basedOnTurnIds: string[];
  basedOnObservationIds: string[];
  confidence: "low" | "medium" | "high";
  questionLineage?: QuestionInstanceLineage;
  transientPersonalStatus?: {
    domain: PersonalStatusDomain;
    label: string;
    decisionId: string;
  };
}

export interface QuestionInstanceLineage {
  questionInstanceId: string;
  questionOriginTraceId: string;
  triggerTurnId?: string;
  sourceSuggestionId?: string;
  sessionId?: string;
  runtimeEpoch?: number;
  identityState?: "provisional" | "canonical";
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

export interface AdvisorBoundedParentReadContext {
  parentId: string;
  parentRevision: number;
  questionType: ScreenQuestionType;
  objective: string;
  sourceTurnIds: string[];
  acceptedConstraints: string[];
  sharedScenarioEntities: string[];
  excludedContextKinds: string[];
}

export interface AdvisorCurrentQuestionProjection {
  answerFocusText: string;
  semanticEvidenceText: string;
  sourceTurnIds: string[];
}

export interface AdvisorPromptContext {
  transcript: string;
  advisorPromptSourceTurnIds?: string[];
  screenContext: string;
  currentQuestionProjection?: AdvisorCurrentQuestionProjection;
  responseOnlyParentReadContext?: AdvisorBoundedParentReadContext;
  interviewSessionBrief?: InterviewSessionBrief;
  interviewSessionContext?: InterviewSessionContext;
  taskRuntime: MeetingTaskRuntimeState;
  activeMeetingTask?: ActiveMeetingTask;
  rollingSummary: string;
  userProfileContext: string;
  glossaryText: string;
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
  whiteboardFormatPreference?: import("./whiteboard-format-policy.js").WhiteboardFormatPreference;
}

export type AdvisorCurrentQuestionEvidenceSource =
  | "voice-lqu"
  | "screen-preflight";

export type AdvisorRetrievalHintRole =
  | "company-prior"
  | "interview-type-prior"
  | "preparation-guidance"
  | "preparation-kmb-hint"
  | "continuity"
  | "source-metadata";

export interface AdvisorCurrentQuestionEvidence {
  text: string;
  source: AdvisorCurrentQuestionEvidenceSource;
  sourceTurnIds: string[];
  sourceHash?: string;
  logicalQuestionUnitId?: string;
  revision?: number;
  screenObservationId?: string;
}

export interface AdvisorContinuityEvidence {
  parentTaskId?: string;
  childTaskId?: string;
  capsule?: string;
  sourceTurnIds: string[];
}

export interface AdvisorPreparationEvidence {
  targetCompany?: string;
  interviewTypes: InterviewBriefType[];
  runtimeBrief?: PreparationRuntimeBrief;
  preferredProgrammingLanguage?: string;
  guidanceHints: string[];
  activatedFactIds: string[];
  rawGuidanceRejectedAsFactCount: number;
  personalizedGuidance?: AdvisorPersonalizedPreparationEvidence;
}

export interface AdvisorPreparedFactEvidence {
  statementId: string;
  content: string;
  ownership:
    | "candidate-owned"
    | "team-owned"
    | "upstream-existing"
    | "future-design";
  allowedWording?: string;
  prohibitedWording: string[];
  sourceIds: string[];
}

export interface AdvisorPreparedOpeningEvidence {
  graphId: string;
  nodeId: string;
  subjectKind: "self-introduction" | "project" | "role-fit";
  subjectId: string;
  nodeKind: "positioning" | "intro-30s" | "main-story-90s";
  title: string;
  renderedDraft: string;
  statementIds: string[];
}

export interface AdvisorPreparedNarrativeEvidence {
  graphId: string;
  subjectKind: "self-introduction" | "project" | "role-fit";
  subjectId: string;
  nodes: Array<{
    nodeId: string;
    kind: PreparationNarrativeNodeKind;
    title: string;
    content: string;
    targetSeconds?: number;
    statementIds: string[];
  }>;
}

export interface AdvisorPreparedPlaybookOverlayEvidence {
  canonicalPlaybookId: string;
  expectedInterviewType: string;
  evidenceStatementIds: string[];
  companyCriteria: string[];
  prohibitedOverclaims: string[];
}

export interface AdvisorPersonalizedPreparationEvidence {
  strategy?: Partial<PreparationStrategy>;
  factEvidence: AdvisorPreparedFactEvidence[];
  openingItems: AdvisorPreparedOpeningEvidence[];
  narratives: AdvisorPreparedNarrativeEvidence[];
  playbookOverlay?: AdvisorPreparedPlaybookOverlayEvidence;
}

export interface AdvisorGeneratedGuidanceEvidence {
  text: string;
  sourceTraceId: string;
}

export interface AdvisorGeneratedContinuityCapsule {
  id: string;
  parentTaskId: string;
  parentRevision: number;
  childTaskId?: string;
  logicalQuestionUnitId?: string;
  logicalQuestionRevision?: number;
  answerRevision: number;
  sourceSuggestionId: string;
  sourceTraceId?: string;
  text: string;
  source: "generated-continuity";
  createdAt: number;
}

export interface AdvisorGeneratedContinuityEvidence {
  contextReadScope: "bounded-recent-history";
  decisionReason: string;
  parentTaskId: string;
  deicticEvidence: string[];
  capsules: AdvisorGeneratedContinuityCapsule[];
}

export interface AdvisorRetrievalHint {
  role: AdvisorRetrievalHintRole;
  text: string;
}

export interface AdvisorEvidencePacket {
  version: "advisor-evidence-v2";
  currentQuestion?: AdvisorCurrentQuestionEvidence;
  continuity?: AdvisorContinuityEvidence;
  preparation: AdvisorPreparationEvidence;
  generatedGuidance?: AdvisorGeneratedGuidanceEvidence;
  generatedContinuity?: AdvisorGeneratedContinuityEvidence;
  retrievalHints: AdvisorRetrievalHint[];
}

export type OpeningRouteKind =
  | "self-intro"
  | "resume-walkthrough"
  | "project-portfolio"
  | "project-intro";

export interface OpeningRouteContext {
  kind: OpeningRouteKind;
  source: string;
  projectAnchor?: string;
  commitParent: boolean;
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
  onTerminal?: (outcome: Readonly<AIResponseTerminalOutcome>) => void;
  onComplete?: (output: string) => void;
}

export interface MeetingAudioConfig {
  enabled: boolean;
  hop_size: number;
  sensitivity_rms: number;
  peak_threshold: number;
  silence_duration_ms: number;
  minimum_speech_duration_ms: number;
  pre_speech_duration_ms: number;
  noise_gate_threshold: number;
  max_recording_duration_secs: number;
}

export type MeetingAudioProfile = "quiet" | "balanced" | "sensitive" | "custom";

export interface MeetingAudioSettings {
  profile: MeetingAudioProfile;
  config: MeetingAudioConfig;
}

export interface MeetingCodingModelSettings extends SelectedProviderState {}

export type MeetingQuestionTypeAdjudicationMode =
  | "off"
  | "shadow"
  | "enforcement";

export type MeetingTaskRelationAdjudicationMode =
  MeetingQuestionTypeAdjudicationMode;

export type MeetingMetadataInferenceMode =
  MeetingQuestionTypeAdjudicationMode;

export interface MeetingTaxonomyAdjudicationSettings
  extends SelectedProviderState {
  enabled: boolean;
  questionTypeMode: MeetingQuestionTypeAdjudicationMode;
  taskRelationMode: MeetingTaskRelationAdjudicationMode;
  meetingMetadataMode: MeetingMetadataInferenceMode;
}

export interface MeetingAudioStatus {
  active: boolean;
  systemCaptureActive: boolean;
  captureOwner: string | null;
  deviceId: string | null;
  sampleRate: number | null;
  vadEnabled: boolean;
  startedAtMs: number | null;
  captureSessionId: string | null;
  captureGeneration: number | null;
}

export type NativeAudioStopDisposition =
  | "stopped"
  | "already-idle"
  | "stale-request"
  | "owner-mismatch";

export interface NativeAudioStopResult {
  disposition: NativeAudioStopDisposition;
  status: MeetingAudioStatus;
}

export type NativeAudioDebugFaultKind =
  | "recoverable-stream-end"
  | "fatal-capture-failure";

export type NativeAudioDebugFaultDisposition =
  | "injected"
  | "already-idle"
  | "stale-request"
  | "owner-mismatch"
  | "not-active";

export interface NativeAudioDebugFaultResult {
  disposition: NativeAudioDebugFaultDisposition;
  faultInjectionId: string;
  previousStatus: MeetingAudioStatus;
  currentStatus: MeetingAudioStatus;
}

export type MeetingPrivacyMode =
  | "memory-only"
  | "text-and-screen-to-cloud";

export interface MeetingAssistantSettings {
  screenContextEnabled: boolean;
  privacyMode: MeetingPrivacyMode;
  activeScreenTaskTimeoutMinutes: number;
  useMemory: boolean;
  personalEvidenceGuardrailMode: PersonalEvidenceGuardrailMode;
  semanticTaxonomyMode: SemanticTaxonomyMode;
  debugMode: boolean;
  microphoneContextEnabled: boolean;
  response: MeetingResponseConfig;
  codingModel: MeetingCodingModelSettings;
  taxonomyAdjudication: MeetingTaxonomyAdjudicationSettings;
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
  lifecycle: "idle" | "starting" | "active" | "closing";
  scriptedValidation?: true;
  sessionId?: string;
  meetingSessionId?: string;
  folderName?: string;
  folderPath?: string;
  startedAt?: number;
  endedAt?: number;
  eventCount: number;
  artifactCount: number;
  lastError?: string;
}

export type HumanEvaluationCollectionProvenance =
  | "organic"
  | "scripted-validation"
  | "replay";

export type SttEvaluationCaptureLifecycle =
  | "idle"
  | "starting"
  | "active"
  | "stopping"
  | "stopped"
  | "deleting"
  | "error";

export interface SttEvaluationCaptureState {
  active: boolean;
  lifecycle: SttEvaluationCaptureLifecycle;
  sessionId?: string;
  folderName?: string;
  folderPath?: string;
  startedAt?: number;
  expiresAt?: number;
  rawChunkCount: number;
  submittedAudioCount: number;
  providerEventCount: number;
  canonicalEventCount: number;
  humanReferenceCount: number;
  bytesWritten: number;
  droppedRawChunkCount: number;
  openRawWriterCount?: number;
  manifestRevision?: number;
  manifestFinalized?: boolean;
  endedAt?: number;
  lastError?: string;
}

export type HumanEvalQuestionType = TaxonomyHumanEvalQuestionType;

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
  | "incorrect-visible-refresh"
  | "mid-read-interruption"
  | "stt-error"
  | "capture-error"
  | "other";

export interface TraceHumanEvaluation {
  id: string;
  traceId: string;
  traceKind: MeetingTraceKind;
  taskId?: string;
  parentTaskId?: string;
  childTaskId?: string;
  taskSource?: "screen" | "voice" | "mixed";
  questionType?: ScreenQuestionType;
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
  advisorGateCorrectlySkipped?: boolean;
  advisorGateShouldAdvise?: boolean;
  taskQuality?: HumanEvalTaskQuality;
  failureReasons: HumanEvalFailureReason[];
  notes?: string;
}

export type HumanEvaluationVerdict =
  | "ok"
  | "partial"
  | "wrong"
  | "missing"
  | "forbidden"
  | "not_applicable";

export interface HumanEvaluationVerdictBlock {
  verdict: HumanEvaluationVerdict;
  reasons: string[];
  note?: string;
}

export type MemoryEntryEvaluationLabelValue =
  | "relevant"
  | "irrelevant"
  | "forbidden";

export interface MemoryEntryEvaluationLabel {
  memoryId: string;
  title?: string;
  label: MemoryEntryEvaluationLabelValue;
  reason?: string;
}

export interface MissingExpectedMemoryLabel {
  id?: string;
  note?: string;
}

export interface MemoryEvaluationEntrySnapshot {
  id: string;
  title: string;
  score: number;
  matchReason: string[];
}

export interface MemoryRetrievalEvaluationSnapshot {
  traceId: string;
  status: "available" | "empty";
  entries: MemoryEvaluationEntrySnapshot[];
}

export interface MemoryRetrievalEvaluationSnapshotResolution {
  status: "available" | "empty" | "unavailable";
  snapshot?: MemoryRetrievalEvaluationSnapshot;
}

export type TaxonomyAdjudicationRepairDisposition =
  | "automatic-repair"
  | "suggest-only"
  | "abstain";

export interface TaxonomyAdjudicationHumanEvaluation {
  needed?: boolean;
  typeCorrect?: boolean;
  relationCorrect?: boolean;
  expectedRelation?: InterviewTaskRelation;
  parentDecisionCorrect?: boolean;
  responseOnlyCorrect?: boolean;
  contextOutcome?: "correct" | "contaminated" | "missing";
  repairDisposition?: TaxonomyAdjudicationRepairDisposition;
  contextPreserved?: boolean;
  timely?: boolean;
}

export type ExpectedAdvisorAction =
  | "advise"
  | "append-context"
  | "buffer"
  | "ignore";

export type ObservedAdvisorAction =
  | "advised"
  | "suppressed"
  | "append-only"
  | "buffered";

export type AdvisorIntentEvaluationFailureReason =
  | "advisor-false-positive"
  | "advisor-false-negative"
  | "advisor-execution-failure"
  | "wrong-output-authority"
  | "wrong-context-composition";

export type AdvisorIntentEvaluationSource =
  | "explicit-human-label"
  | "manual-force-advise"
  | "manual-suppress";

export interface AdvisorIntentEvaluationPreDecision {
  speechAct?: string;
  intent?: string;
  action?: string;
  enforcement?: string;
  wouldSuppress?: boolean;
  executionAuthorized?: boolean;
  outputCommitAuthorized?: boolean;
}

export interface AdvisorIntentHumanEvaluation {
  schemaVersion: 1;
  verdict: "ok" | "false-positive" | "false-negative";
  expectedAction: ExpectedAdvisorAction;
  observedAction: ObservedAdvisorAction;
  failureReason?: AdvisorIntentEvaluationFailureReason;
  source: AdvisorIntentEvaluationSource;
  originalTraceId: string;
  logicalQuestionUnitId?: string;
  logicalQuestionUnitRevision?: number;
  sourceTurnIds: string[];
  preDecision?: AdvisorIntentEvaluationPreDecision;
  repairTraceId?: string;
  createdAt: number;
  updatedAt: number;
}

export type ForceAdviseTargetStatus =
  | "ready"
  | "advising"
  | "delivery-pending"
  | "already-advised"
  | "repairing"
  | "repaired"
  | "failed"
  | "stale";

export type ForceAdviseAutomaticExecutionState =
  | "not-started"
  | "running"
  | "model-completed"
  | "delivery-pending"
  | "visible-committed"
  | "failed"
  | "stale";

export type ForceAdviseManualExecutionState =
  | "idle"
  | "running"
  | "visible-committed"
  | "failed"
  | "stale";

export interface ForceAdviseTargetPresentation {
  targetId: string;
  targetKind: "canonical-question" | "response-recovery";
  originalTraceId: string;
  turnId: string;
  text: string;
  observedAction: ObservedAdvisorAction;
  executionAuthorized: boolean;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  sourceTurnIds: string[];
  status: ForceAdviseTargetStatus;
  automaticExecutionState: ForceAdviseAutomaticExecutionState;
  manualExecutionState: ForceAdviseManualExecutionState;
  visibleCommitRevision?: number;
  repairTraceId?: string;
  updatedAt: number;
}

export type AnswerSufficiencyHumanLabel =
  | "sufficient"
  | "insufficient";

export type ExpectedContextRepair =
  | "none"
  | "narrow"
  | "enhance"
  | "buffer"
  | "ignore"
  | "wait"
  | "manual-clarification";

export interface AnswerSufficiencyHumanEvaluation {
  observedStatus?: AnswerSufficiencyHumanLabel;
  defect?: string;
  nearbyContextExisted?: boolean;
  expectedRepair?: ExpectedContextRepair;
  expectedContextKinds: string[];
  repairHelpful?: boolean;
  repairTimely?: boolean;
  staleContextIntroduced?: boolean;
  operationId?: string;
  answerRevision?: number;
}

export interface CurrentQuestionSettlementHumanEvaluation {
  questionTypeCorrect?: boolean;
  relationCorrect?: boolean;
  parentMutationCorrect?: boolean;
  responseAuthorizationCorrect?: boolean;
  expectedDisposition?:
    | "domain-resolved-provisional"
    | "domain-resolved-unknown"
    | "unresolved-provisional"
    | "response-only"
    | "committed-parent"
    | "stale-dropped"
    | "manual-authority";
  notes?: string;
}

export interface WhiteboardRenderHumanEvaluation {
  artifactId?: string;
  validationOperationId?: string;
  repairOperationId?: string;
  candidateRevision?: number;
  visibleRevision?: number;
  observedOutcome?:
    | "rendered"
    | "repaired"
    | "preserved-last-valid"
    | "ascii-fallback"
    | "error-visible"
    | "missing";
  repairVerdict?: "correct" | "semantic-drift" | "failed" | "not-observed";
  fallbackVerdict?: "useful" | "not-useful" | "not-observed";
  preservationVerdict?: "correct" | "overwritten" | "not-applicable";
}

export type ProjectTrajectoryChildContinuity =
  | "none"
  | "child-attached"
  | "parent-resumed";

export interface ProjectTrajectoryHumanEvaluation {
  detectedProjectId?: string;
  detectedProjectName?: string;
  detectedProjectBindingRevision?: number;
  expectedProjectId?: string;
  expectedProjectName?: string;
  detectedPhase?: InterviewPlaybookPhase;
  expectedPhase?: InterviewPlaybookPhase;
  detectedFactAnchorState?: FactAnchorState;
  expectedFactAnchorState?: FactAnchorState;
  detectedChildContinuity?: ProjectTrajectoryChildContinuity;
  expectedChildContinuity?: ProjectTrajectoryChildContinuity;
  projectCorrect?: boolean;
  phaseCorrect?: boolean;
  factSupportCorrect?: boolean;
  childContinuityCorrect?: boolean;
  unsupportedFirstPersonClaim?: boolean;
}

export interface QuestionHumanEvaluation {
  id: string;
  sessionId?: string;
  questionId: string;
  taskId?: string;
  parentTaskId?: string;
  childTaskId?: string;
  taskSource?: "screen" | "voice" | "mixed";
  traceIds: string[];
  questionType?: HumanEvalQuestionType;
  correctedQuestionType?: HumanEvalQuestionType;
  manualQuestionTypeCorrectionId?: string;
  manualQuestionTypeCorrectionTraceId?: string;
  manualQuestionTypeRegenerationTraceId?: string;
  manualQuestionTypeCorrectionSource?: ManualQuestionTypeCorrectionSource;
  manualQuestionTypeCorrectionScope?: ManualCorrectionScope;
  manualQuestionTypeCorrectionBoundaryReason?: string;
  manualQuestionTypeCorrectionPreviousParentId?: string;
  manualQuestionTypeCorrectionNextParentId?: string;
  manualTermCorrectionId?: string;
  manualTermCorrectionTraceId?: string;
  manualTermCorrectionRegenerationTraceId?: string;
  manualTermCorrectionDisposition?: ActiveQuestionTermCorrectionDisposition;
  manualTermCorrectionReason?: "manual-term-correction";
  transientPersonalStatus?: {
    detectedDomain?: PersonalStatusDomain;
    expectedDomain?: PersonalStatusDomain;
    policyApplicable?: boolean;
    profileOnlyEvidenceCorrect?: boolean;
    parentPreserved?: boolean;
    artifactsPreserved?: boolean;
  };
  company?: string;
  correctedCompany?: string;
  relation?: string;
  expectedRelation?: InterviewTaskRelation;
  expectedParentAction?: HumanExpectedParentAction;
  expectedContextTurnIds?: string[];
  correctedRelation?: string;
  primaryAskCorrect?: boolean;
  clarifyingOptionsVerdict?: "correct" | "misleading" | "missing";
  playbookId?: string;
  detectedPlaybookPhase?: string;
  correctedPlaybookPhase?: string;
  detectedWhiteboardArtifactId?: string;
  detectedWhiteboardArtifactRevision?: number;
  detectedWhiteboardArtifactDomainTrack?: string;
  detectedManualPhaseFrom?: string;
  detectedManualPhaseTo?: string;
  detectedManualPhaseTargetArtifact?: string;
  detectedManualPhaseGuardStatus?: string;
  selectedDiagramOverlayIds: string[];
  rejectedDiagramOverlayCount?: number;
  classification: HumanEvaluationVerdictBlock;
  playbook: HumanEvaluationVerdictBlock;
  playbookPhase: HumanEvaluationVerdictBlock;
  memory: HumanEvaluationVerdictBlock;
  whiteboard: HumanEvaluationVerdictBlock;
  manualPhaseTransition: HumanEvaluationVerdictBlock;
  diagramOverlay: HumanEvaluationVerdictBlock;
  guardrail: HumanEvaluationVerdictBlock;
  answer: HumanEvaluationVerdictBlock;
  taxonomyAdjudication?: TaxonomyAdjudicationHumanEvaluation;
  advisorIntent?: AdvisorIntentHumanEvaluation;
  answerSufficiency?: AnswerSufficiencyHumanEvaluation;
  currentQuestionSettlement?: CurrentQuestionSettlementHumanEvaluation;
  whiteboardRender?: WhiteboardRenderHumanEvaluation;
  projectTrajectory?: ProjectTrajectoryHumanEvaluation;
  memoryRetrievalSnapshot?: MemoryRetrievalEvaluationSnapshot;
  memoryEntryLabels: MemoryEntryEvaluationLabel[];
  missingExpectedMemory: MissingExpectedMemoryLabel[];
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MeetingAssistantState {
  status: MeetingAssistantStatus;
  transcriptTurns: TranscriptTurn[];
  latestDisplayTranscript?: DisplayTranscriptArtifact;
  displayTranscriptWindow?: DisplayTranscriptWindow;
  screenObservations: ScreenObservation[];
  interviewSessionBrief?: InterviewSessionBrief;
  interviewSessionContext?: InterviewSessionContext;
  preparationRuntime: import("./preparation-runtime-context").PreparationRuntimePresentation;
  taskRuntime: MeetingTaskRuntimeState;
  activeMeetingTask?: ActiveMeetingTask;
  manualQuestionTypeCorrection?: ManualQuestionTypeCorrection;
  currentQuestionLineage?: QuestionInstanceLineage;
  latestInterviewerTurnCandidate?: ForceAdviseTargetPresentation;
  traces: MeetingTrace[];
  latestSuggestion: AdvisorSuggestion | null;
  latestReliableSuggestion: AdvisorSuggestion | null;
  partialSuggestion: string;
  answerDelivery: import("./stable-answer").AnswerDeliveryPresentation;
  generationResult: import("./generation-result-ledger").GenerationResultProjection;
  error: string | null;
  audioStatus: MeetingAudioStatus | null;
  audioInputLiveness: AudioInputLivenessPresentation | null;
  nativeAudioManualRecovery?: NativeAudioManualRecoveryState;
  settings: MeetingAssistantSettings;
  lastMemoryContext?: MemoryRetrievalResult;
  lastTraceExport?: MeetingTraceExportRecord;
  sessionRecording: MeetingSessionRecordingState;
  sttEvaluationCapture: SttEvaluationCaptureState;
  humanEvaluations: TraceHumanEvaluation[];
  questionEvaluations: QuestionHumanEvaluation[];
  speechCorrections: SpeechCorrection[];
  presentationArtifactResetRevision: number;
}
