import { invoke } from "@tauri-apps/api/core";
import { TYPE_PROVIDER } from "@/types";
import type { MemoryRejectSummary, MemoryRetrievalResult } from "@/lib/memory";
import {
  ActiveQuestionTermCorrection,
  ActiveScreenTask,
  InterviewSessionBrief,
  InterviewSessionContext,
  MeetingAssistantSettings,
  MeetingSessionRecordingState,
  MeetingTrace,
  MeetingTraceExportTrigger,
  ManualQuestionTypeCorrection,
  QuestionHumanEvaluation,
  ScreenObservation,
  TraceHumanEvaluation,
  TranscriptTurn,
} from "./types";
import type { ActiveMeetingTask } from "./active-meeting-task";
import type { AnswerSufficiencyDecision } from "./answer-sufficiency.js";
import {
  formatAdvisorHypothesisChallengeForTrace,
  formatAdvisorResponseConsistencyForTrace,
  formatAdvisorResponseFingerprintForTrace,
  type AdvisorHypothesisChallenge,
  type AdvisorResponseConsistencyObservation,
  type AdvisorResponseFingerprint,
} from "./advisor-response-consistency.js";
import {
  formatCurrentQuestionSettlementForTrace,
  type CurrentQuestionSettlementDecision,
  type CurrentQuestionSettlementDisposition,
  type ProvisionalCurrentQuestion,
} from "./current-question-settlement.js";
import type {
  CriticalMomentCandidate,
  CriticalMomentEvaluation,
} from "./critical-moment-evaluation.js";
import type {
  HumanEvaluationProjectionV2,
  HumanGroundTruthEventV2,
} from "./human-ground-truth-v2.js";
import {
  formatQuestionTypeAdjudicationOutcomeForTrace,
  type QuestionTypeAdjudicationOutcomeEvent,
} from "./question-type-adjudication.js";
import { projectHumanEvaluationsForLegacyConsumers } from "./human-evaluation-v2-consumers.js";
import {
  collectActiveMeetingTaskIdentityIds,
  formatActiveMeetingTaskForRecording,
} from "./active-meeting-task.js";
import { createMeetingId } from "./context-manager.js";
import { readMeetingEvalTraceMetadata } from "./eval-trace-metadata.js";
import {
  buildSessionTaskReviewIndex,
  type SessionTaskReviewIndex,
} from "./session-task-review-index.js";
import {
  formatSettledAdvisorExecutionPlanForTrace,
  type SettledAdvisorExecutionPlan,
  type SettledAdvisorExecutionPlanAuthorization,
} from "./settled-advisor-execution-plan.js";
import {
  formatResponseOnlyTaskScopeForTrace,
  type ResponseOnlyTaskScope,
} from "./response-only-task-scope.js";
import { serializeMeetingTraceExport } from "./trace.js";
import {
  buildPreparationAnswerAttributionIndex,
  type PreparationArtifactEvaluation,
  type PreparationArtifactUseReceipt,
  type PreparationRuntimeProvenanceSnapshot,
} from "./preparation-runtime-provenance.js";

const SESSION_RECORDING_SCHEMA_VERSION = 1;
const SESSION_RECORDING_INTEGRITY_SCHEMA_VERSION = 1;
const SESSION_TRACE_SUMMARY_SCHEMA_VERSION = 36;
const SESSION_TRACE_INDEX_SCHEMA_VERSION = 1;
const MAX_RECORDED_WRITE_FAILURES = 20;

interface SessionRecordingStartOptions {
  settings: MeetingAssistantSettings;
  interviewSessionBrief?: InterviewSessionBrief;
  interviewSessionContext?: InterviewSessionContext;
  providerSummary: SessionRecordingProviderSummary;
}

export interface SessionRecordingProviderSummary {
  mainProviderId?: string;
  codingProviderId?: string;
  taxonomyAdjudicationProviderId?: string;
  sttProviderId?: string;
  hasMainProvider: boolean;
  hasCodingProvider: boolean;
  hasTaxonomyAdjudicationProvider: boolean;
  hasSttProvider: boolean;
  mainSupportsImages: boolean;
  codingSupportsImages: boolean;
  taxonomyAdjudicationConfigurationStatus?: string;
  taxonomyAdjudicationInheritedVariableKeys?: string[];
  taxonomyAdjudicationMissingRequiredVariables?: string[];
}

interface SessionRecordingEvent {
  id: string;
  sessionId: string;
  traceId?: string;
  taskId?: string;
  kind:
    | "session-started"
    | "session-stopped"
    | "transcript-turn"
    | "screen-capture"
    | "model-input"
    | "model-output"
    | "memory-retrieval"
    | "fact-anchor-decision"
    | "project-binding-decision"
    | "playbook-selected"
    | "trace-export"
    | "trace-metrics"
    | "human-evaluation"
    | "question-human-evaluation"
    | "human-ground-truth-v2"
    | "human-evaluation-projection-v2"
    | "critical-moment-candidates"
    | "critical-moment-evaluation"
    | "task-snapshot"
    | "active-meeting-task-snapshot"
    | "manual-question-type-correction"
    | "active-question-term-correction"
    | "semantic-taxonomy-decision"
    | "semantic-embedding-runtime"
    | "interviewer-intent-semantic-decision"
    | "interviewer-intent-llm-decision"
    | "taxonomy-adjudication-decision"
    | "question-type-adjudication-decision"
    | "question-type-adjudication-outcome"
    | "task-relation-adjudication-decision"
    | "answer-sufficiency-decision"
    | "advisor-response-fingerprint"
    | "advisor-response-consistency-shadow"
    | "advisor-hypothesis-challenge"
    | "current-question-settlement"
    | "settled-advisor-execution-plan"
    | "response-only-task-scope"
    | "whiteboard-render-validation"
    | "whiteboard-render-recovery"
    | "capture-lifecycle"
    | "native-speech-event"
    | "native-audio-liveness"
    | "audio-segment-disposition"
    | "preparation-runtime-context"
    | "preparation-artifact-use"
    | "preparation-artifact-evaluation"
    | "runtime-reset"
    | "runtime-continued"
    | "error";
  createdAt: number;
  source: "meeting-assistant";
  metadata?: Record<string, unknown>;
  artifactRefs?: string[];
}

interface ActiveSessionRecording {
  generationId: string;
  phase: "active" | "closing" | "sealed";
  sessionId: string;
  folderName: string;
  folderPath: string;
  startedAt: number;
  eventCount: number;
  artifactCount: number;
  lastError?: string;
  manifestBase: ReturnType<typeof buildSessionRecordingManifest>;
  recordedTraceIds: Set<string>;
  recordedTaskIds: Set<string>;
  recordedTurnIds: Set<string>;
  recordedObservationIds: Set<string>;
  traceSessionIndex: Map<string, SessionTraceIndexEntry>;
  traceSummaries: Map<string, SessionCompactTraceSummary>;
  traceHumanEvaluations: Map<string, TraceHumanEvaluation>;
  questionHumanEvaluations: Map<string, QuestionHumanEvaluation>;
  humanGroundTruthEventsV2: Map<string, HumanGroundTruthEventV2>;
  humanEvaluationProjectionsV2: Map<string, HumanEvaluationProjectionV2>;
  criticalMomentCandidates: Map<string, CriticalMomentCandidate>;
  criticalMomentEvaluations: Map<string, CriticalMomentEvaluation>;
  preparationRuntimeContexts: Map<
    string,
    PreparationRuntimeProvenanceSnapshot
  >;
  preparationArtifactUseReceipts: Map<
    string,
    PreparationArtifactUseReceipt
  >;
  preparationArtifactEvaluations: Map<
    string,
    PreparationArtifactEvaluation
  >;
  untraceablePreparationArtifactUseCount: number;
  writeQueue: Promise<void>;
  enqueueVersion: number;
  pendingWrites: number;
  acceptedWrites: number;
  rejectedLateWrites: number;
  drainPasses: number;
  failedWriteCount: number;
  failedWrites: SessionRecordingWriteFailure[];
  closingAt?: number;
}

interface SessionRecordingWriteFailure {
  sequence: number;
  occurredAt: number;
  phase: ActiveSessionRecording["phase"];
  operation: "text" | "base64" | "unknown";
  relativePath?: string;
  message: string;
}

class SessionRecordingWriteError extends Error {
  constructor(
    readonly operation: SessionRecordingWriteFailure["operation"],
    readonly relativePath: string,
    cause: unknown
  ) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to write ${relativePath}: ${causeMessage}`);
    this.name = "SessionRecordingWriteError";
  }
}

export type SessionRecordingInvoke = <T>(
  command: string,
  args?: Record<string, unknown>
) => Promise<T>;

interface SessionTraceIndexEntry {
  version: number;
  sessionId: string;
  traceId: string;
  taskIds: string[];
  sources: string[];
  firstSeenAt: number;
  updatedAt: number;
  traceKind?: MeetingTrace["kind"];
  traceStatus?: MeetingTrace["status"];
  traceStartedAt?: number;
  traceEndedAt?: number;
  traceDurationMs?: number;
}

export interface SessionCompactTraceSummary {
  version: number;
  sessionId: string;
  traceId: string;
  traceKind: MeetingTrace["kind"];
  status: MeetingTrace["status"];
  trigger: MeetingTraceExportTrigger;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  error?: string;
  syntheticValidation?: boolean;
  faultInjectionId?: string;
  faultKind?: string;
  taskIds: string[];
  primaryTaskId?: string;
  activeScreenTaskId?: string;
  activeMeetingTaskId?: string;
  activeMeetingTaskSource?: string;
  activeMeetingParentId?: string;
  activeMeetingChildId?: string;
  activeInterviewParentId?: string;
  activeInterviewChildId?: string;
  questionType?: string;
  rawQuestionType?: string;
  canonicalQuestionType?: string;
  askFrame?: string;
  topicDomain?: string;
  projectAnchor?: string;
  playbookId?: string;
  playbookPhase?: string;
  playbookSubtype?: string;
  phaseSignal?: string;
  phaseSignalSource?: string;
  phaseSignalSourceTurnId?: string;
  assumptionAuthorizationState?: string;
  assumptionAuthorizationReason?: string;
  phaseBefore?: string;
  phaseAfter?: string;
  whiteboardRevisionRequested?: boolean;
  turnGateAction?: string;
  turnGateReason?: string;
  advisorTurnIntent?: string;
  advisorTurnConfidence?: number;
  advisorTurnEnforcement?: string;
  advisorIntentAuthoritySource?: string;
  advisorWouldSuppress?: boolean;
  advisorExecutionAuthorized?: boolean;
  shortIntentLocalDisposition?: string;
  shortIntentLocalReason?: string;
  shortIntentWordEquivalent?: number;
  canonicalFillerSuppressed?: boolean;
  shortHighInformationAllowed?: boolean;
  residualShortIntentAdjudicationRequired?: boolean;
  shortIntentGateDisposition?: string;
  shortIntentGateAction?: string;
  shortIntentGateConfidence?: number;
  shortIntentGateDecisionApplied?: boolean;
  shortIntentGateAppliedAction?: string;
  shortIntentGateBudgetExhausted?: boolean;
  shortIntentGateTimedOut?: boolean;
  shortIntentGateDurationMs?: number;
  shortIntentGateQueueWaitMs?: number;
  runtimeIntentReleasedAction?: string;
  advisorExecutionSuppressedReason?: string;
  taskMutationAuthorized?: boolean;
  taskMutationAuthorizationReason?: string;
  taskRelation?: string;
  logicalQuestionUnitId?: string;
  logicalQuestionUnitRevision?: number;
  logicalQuestionCurrentTurnId?: string;
  logicalQuestionSourceTurnIds: string[];
  logicalQuestionCompositionReasons: string[];
  logicalQuestionBoundaryReason?: string;
  logicalQuestionTruncated?: boolean;
  canonicalLogicalQuestionMaterialized?: boolean;
  canonicalLogicalQuestionMaterializationReason?: string;
  primaryAskSpeechAct?: string;
  primaryAskDisposition?: string;
  primaryAskReason?: string;
  primaryAskConfidence?: number;
  primaryAskSourceTurnIds: string[];
  primaryAskSourceChars?: number;
  primaryAskSpanCount?: number;
  primaryAskSetupSpanCount?: number;
  primaryAskQuotedOrFutureSpanCount?: number;
  primaryAskAnswerFocusChars?: number;
  primaryAskSemanticEvidenceChars?: number;
  primaryAskAnswerFocusSpanCount?: number;
  primaryAskObjectSpanCount?: number;
  primaryAskScenarioSpanCount?: number;
  primaryAskSemanticEvidenceRetentionReasons: string[];
  primaryAskSemanticEvidenceDroppedReasons: string[];
  primaryAskTurnGateView?: string;
  primaryAskTaxonomyView?: string;
  primaryAskTaskSettlementView?: string;
  primaryAskAdvisorView?: string;
  primaryAskAnswerFocusQuestionTypeProposal?: string;
  primaryAskSemanticEvidenceQuestionTypeProposal?: string;
  primaryAskQuestionTypeProposalChanged?: boolean;
  logicalQuestionLeaseAuthorized?: boolean;
  logicalQuestionLeaseAuthorizationReason?: string;
  logicalQuestionLeaseAuthorizationStage?: string;
  forceAdviseTargetStatus?: string;
  forceAdviseAutomaticExecutionState?: string;
  forceAdviseManualExecutionState?: string;
  forceAdviseVisibleCommitRevision?: number;
  forceAdviseEligible?: boolean;
  forceAdviseRetryable?: boolean;
  forceAdviseEligibilityReason?: string;
  forceAdviseRepairCause?: string;
  forceAdviseAdvisorOutcome?: string;
  forceAdviseOwnershipAuthorized?: boolean;
  forceAdviseOwnershipReason?: string;
  forceAdviseRecoveredPendingCandidate?: boolean;
  manualCorrectionOwnership?: string;
  advisorPromptIncludedLogicalQuestion?: boolean;
  advisorPromptLogicalQuestionSourceCount?: number;
  advisorOutputCommittedToUi?: boolean;
  advisorOutputCommitAuthorized?: boolean;
  visibleAnswerChanged?: boolean;
  refreshAuthority?: string;
  refreshAuthorityAuthorized?: boolean;
  refreshAuthorityReason?: string;
  refreshAuthorityHardOverride?: boolean;
  answerGenerationLeaseId?: string;
  preparationContextRevision?: number;
  preparationArtifactUseReceiptIds: string[];
  preparationArtifactIds: string[];
  preparationArtifactConsumers: string[];
  leaseAuthorizedAtStart?: boolean;
  leaseAuthorizedAtCommit?: boolean;
  staleCommitRejected?: boolean;
  staleReason?: string;
  visibleAnswerRevisionBefore?: number;
  visibleAnswerRevisionAfter?: number;
  baseVisibleAnswerRevision?: number;
  stableAnswerCommitDisposition?: string;
  stableAnswerCommitReason?: string;
  answerDeliveryLockState?: string;
  meSpokenWordEquivalent?: number;
  meAnswerTokenOverlap?: number;
  pendingAnswerDisposition?: string;
  pendingAnswerOperationId?: string;
  requestedArtifacts: string[];
  authorizedArtifacts: string[];
  generationRequestedArtifacts: string[];
  parsedArtifacts: string[];
  parentAuthorizedArtifacts: string[];
  screenAuthorizedArtifacts: string[];
  committedArtifacts: string[];
  screenArtifactAuthoritySource?: string;
  screenArtifactAuthorityAuthorized?: boolean;
  screenArtifactAuthorityReason?: string;
  playbookArtifactContractMismatch?: boolean;
  playbookArtifactContractMismatchReasons: string[];
  artifactCacheDisposition?: string;
  artifactMutationRejectedReasons: string[];
  answerSectionRevision?: number;
  codeSectionRevision?: number;
  complexitySectionRevision?: number;
  whiteboardSectionRevision?: number;
  previousCodeRevision?: number;
  nextCodeRevision?: number;
  previousComplexityRevision?: number;
  nextComplexityRevision?: number;
  renderedCodeArtifactRevision?: number;
  renderedComplexityArtifactRevision?: number;
  codeMutationWithoutCodeIntent?: boolean;
  answerDwellMs?: number;
  manualQuestionTypeCorrectionId?: string;
  manualTermCorrectionId?: string;
  manualTermCorrectionDisposition?: string;
  manualTermCorrectionRegenerationStatus?: string;
  manualTermCorrectionLogicalQuestionUnitId?: string;
  manualTermCorrectionLogicalQuestionUnitRevision?: number;
  manualTermCorrectionCorrectedLogicalQuestionUnitRevision?: number;
  manualTermCorrectionRevision?: number;
  manualTermCorrectionRegenerationTraceId?: string;
  manualTermCorrectionSettlementId?: string;
  manualTermCorrectionLatencyMs?: number;
  taskBoundary?: {
    logicalQuestionUnitId?: string;
    candidateId?: string;
    candidateState?: string;
    commitPolicy?: string;
    mutationDisposition?: string;
    authoritySource?: string;
    sourceTurnIds: string[];
    committedBeforeAdvisor?: boolean;
    committedParentId?: string;
    survivedAdvisorCancellation?: boolean;
    parentBeforeId?: string;
    parentBeforeType?: string;
    parentAfterId?: string;
    parentAfterType?: string;
  };
  currentQuestionSettlement?: {
    settlementId?: string;
    logicalQuestionUnitId?: string;
    logicalQuestionUnitRevision?: number;
    sourceTurnIds: string[];
    sourceObservationIds: string[];
    sourceHash?: string;
    questionType?: string;
    relation?: string;
    action?: string;
    evidenceMode?: string;
    authority?: string;
    authoritySource?: string;
    typeAuthoritySource?: string;
    relationAuthoritySource?: string;
    actionAuthoritySource?: string;
    typeMutationAuthorized?: boolean;
    relationMutationAuthorized?: boolean;
    parentMutationAuthorized?: boolean;
    responseAuthorized?: boolean;
    disposition?: string;
    parentBeforeId?: string;
    parentBeforeType?: string;
    parentAfterId?: string;
    parentAfterType?: string;
    manualCorrectionRevision?: number;
    rejectedProposalCount?: number;
    reasons: string[];
    durationMs?: number;
    llmWaitMs?: number;
    llmWaitDisposition?: string;
  };
  currentQuestionTerminalNoAnswer?: {
    disposition?: string;
    authorized?: boolean;
    applied?: boolean;
    applyReason?: string;
    logicalQuestionUnitId?: string;
    logicalQuestionUnitRevision?: number;
    sourceTurnCount?: number;
    operationId?: string;
    operationKind?: string;
    displayDisposition?: string;
    contextDisposition?: string;
    speechAct?: string;
    action?: string;
    confidence?: number;
    reasons: string[];
    advisorMatched?: boolean;
    advisorCancelled?: boolean;
    memoryStarted?: boolean;
    modelStarted?: boolean;
    avoidedMemoryOpportunity?: boolean;
    avoidedModelOpportunity?: boolean;
  };
  settledExecutionPlan?: {
    planId?: string;
    settlementId?: string;
    questionType?: string;
    relation?: string;
    responseAuthorized?: boolean;
    responseIntent?: string;
    contextReadScope?: string;
    artifactIntent?: string;
    responseOwnerSource?: string;
    modelRoute?: string;
    providerId?: string;
    playbookId?: string;
    playbookPhase?: string;
    requiredArtifacts: string[];
    memoryUseCase?: string;
    memoryQuestionType?: string;
    memoryPolicyId?: string;
    factAnchorPolicy?: string;
    promptContract?: string;
    artifactDisposition?: string;
    transientPersonalStatusDecisionId?: string;
    transientPersonalStatusDomain?: string;
    transientPersonalStatusDisposition?: string;
    transientPersonalStatusEvidencePolicy?: string;
    authorized?: boolean;
    authorizationReason?: string;
    authorizationStage?: string;
    rejectionReasons: string[];
  };
  boundedRecentHistory?: {
    decision?: string;
    reason?: string;
    contextReadScope?: string;
    parentTaskId?: string;
    deicticEvidence: string[];
    candidateCount?: number;
    selectedCount?: number;
    selectedChars?: number;
    sourceTraceCount?: number;
    explicitEnhance?: boolean;
    authority?: string;
    factAuthority?: boolean;
    taskMutationAuthority?: boolean;
    artifactMutationAuthority?: boolean;
  };
  crossDomainTransition?: {
    kind?: string;
    reason?: string;
    previousQuestionType?: string;
    nextQuestionType?: string;
    sharedDomainTokens: string[];
    evidence: string[];
    parentContextHandoffKind?: string;
    parentContextHandoffSourceId?: string;
    parentContextHandoffSourceQuestionId?: string;
  };
  advisorOutputDisposition?: string;
  adjacentConstraintInherited?: boolean;
  adjacentConstraintDecisionReason?: string;
  adjacentConstraintKinds?: string;
  adjacentConstraintDeltaMs?: number;
  adjacentQuestionOriginTraceId?: string;
  sentenceBufferOperationId?: string;
  sentenceBufferOperationRole?: string;
  sentenceBufferOutcome?: string;
  sentenceBufferDisposition?: string;
  sentenceBufferReason?: string;
  sentenceBufferFlushReason?: string;
  sentenceBufferFragmentCount?: number;
  sentenceBufferAddedLatencyMs?: number;
  sentenceBufferMergedTranscriptChars?: number;
  sentenceBufferContinuationAuthorized?: boolean;
  sentenceBufferContinuationReason?: string;
  sentenceBufferContinuationHandoffSource?: string;
  sentenceBufferContinuationCandidateSequence?: number;
  sentenceBufferContinuationExtensionUsed?: boolean;
  sentenceBufferInitialWaitMs?: number;
  sentenceBufferContinuationWaitMs?: number;
  sentenceBufferContinuationDeadlineAt?: number;
  sentenceBufferAbsoluteDeadlineAt?: number;
  semanticTaxonomy?: {
    mode?: string;
    turnId?: string;
    keywordType?: string;
    semanticCandidateType?: string;
    semanticTopCandidateType?: string;
    hybridOutcome?: string;
    hybridEffectiveType?: string;
    wouldRescue?: boolean;
    rescueApplied?: boolean;
    embeddingStatus?: string;
    durationMs?: number;
    cacheHit?: boolean;
    modelVersion?: string;
    prototypeVersion?: string;
    calibrationVersion?: string;
  };
  semanticEmbeddingRuntime?: {
    requestId?: string;
    event?: string;
    consumer?: string;
    coalescingKey?: string;
    revision?: number;
    outcome?: string;
    queueWaitMs?: number;
    computeMs?: number;
    totalMs?: number;
    deadlineProfile?: string;
    deadlinePhase?: string;
    deadlineMs?: number;
    coalesced?: boolean;
    stale?: boolean;
    abandoned?: boolean;
    cacheHit?: boolean;
    queueDepth?: number;
    maxQueueDepth?: number;
    reason?: string;
  };
  interviewerIntentSemantic?: {
    embeddingStatus?: string;
    durationMs?: number;
    cacheHit?: boolean;
    logicalQuestionUnitId?: string;
    logicalQuestionUnitRevision?: number;
    parentId?: string;
    parentRevision?: number;
    speechAct?: string;
    speechActConfidence?: number;
    relation?: string;
    relationConfidence?: number;
    evidenceMode?: string;
    evidenceModeConfidence?: number;
    staleResultDropped?: boolean;
    prototypeVersion?: string;
    calibrationVersion?: string;
  };
  interviewerIntentLlm?: {
    mode?: string;
    eligible?: boolean;
    skipReason?: string;
    promptVersion?: string;
    schemaVersion?: number;
    outputContractVersion?: number;
    parsedOutputContractVersion?: number;
    requestHash?: string;
    operationId?: string;
    unitId?: string;
    unitRevision?: number;
    scheduledTaskId?: string;
    settlementTaskId?: string;
    providerId?: string;
    modelId?: string;
    disposition?: string;
    providerDisposition?: string;
    parseDisposition?: string;
    parseErrorKind?: string;
    parseError?: string;
    outputEnvelope?: string;
    staleReason?: string;
    leaseAuthorized?: boolean;
    speechAct?: string;
    questionType?: string;
    relation?: string;
    evidenceMode?: string;
    action?: string;
    primaryAskSpanCount?: number;
    primaryAskSourceTurnIds: string[];
    localSpeechAct?: string;
    localQuestionType?: string;
    localRelation?: string;
    localEvidenceMode?: string;
    localAction?: string;
    repairFactors: string[];
    confidence?: number;
    parseValid?: boolean;
    evidenceSpansValid?: boolean;
    arrivalStage?: string;
    wouldRepair?: boolean;
    repairApplied?: boolean;
    durationMs?: number;
    inputChars?: number;
    outputChars?: number;
    budgetSlot?: string;
    budgetReason?: string;
    sourceOwnedSubstantive?: boolean;
    budgetStartsBefore?: number;
    budgetStartsAfter?: number;
    budgetLimit?: number;
    budgetRemaining?: number;
    ambientStarts?: number;
    substantiveStarts?: number;
    reservedSubstantiveAvailable?: boolean;
  };
  taxonomyAdjudication?: {
    mode?: string;
    eligible?: boolean;
    skipReason?: string;
    promptVersion?: string;
    schemaVersion?: number;
    outputContractVersion?: number;
    parsedOutputContractVersion?: number;
    requestHash?: string;
    operationId?: string;
    unitId?: string;
    unitRevision?: number;
    scheduledTaskId?: string;
    settlementTaskId?: string;
    providerId?: string;
    modelId?: string;
    disposition?: string;
    providerDisposition?: string;
    parseDisposition?: string;
    parseErrorKind?: string;
    parseError?: string;
    outputEnvelope?: string;
    staleReason?: string;
    leaseAuthorized?: boolean;
    candidateType?: string;
    relation?: string;
    standalone?: boolean;
    confidence?: number;
    parseValid?: boolean;
    evidenceSpansValid?: boolean;
    arrivalStage?: string;
    wouldRepair?: boolean;
    repairFactors: string[];
    repairApplied?: boolean;
    durationMs?: number;
    inputChars?: number;
    outputChars?: number;
    rawOutputHash?: string;
    rawOutputStored?: boolean;
    rawOutputTruncated?: boolean;
    providerConfigurationStatus?: string;
    circuitOpen?: boolean;
    circuitReason?: string;
    circuitNewlyOpened?: boolean;
    budgetSlot?: string;
    budgetReason?: string;
    sourceOwnedSubstantive?: boolean;
    budgetStartsBefore?: number;
    budgetStartsAfter?: number;
    budgetLimit?: number;
    budgetRemaining?: number;
    ambientStarts?: number;
    substantiveStarts?: number;
    reservedSubstantiveAvailable?: boolean;
  };
  questionTypeAdjudicationOutcome?: {
    operationId?: string;
    stage?: string;
    disposition?: string;
    settlementId?: string;
    outputAuthorityId?: string;
    enforcementAuthorized?: boolean;
    settlementApplied?: boolean;
    advisorStarted?: boolean;
    modelCompleted?: boolean;
    deliveryPending?: boolean;
    visibleCommitted?: boolean;
    reason?: string;
    recordedAt?: number;
  };
  answerSufficiency?: {
    operationId?: string;
    detectorVersion?: string;
    status?: string;
    contextDefect?: string;
    recommendedRepair?: string;
    confidence?: number;
    lexicalEvidence: string[];
    semanticPrototypeIds: string[];
    semanticStatus?: string;
    semanticConfidence?: number;
    semanticMargin?: number;
    semanticDurationMs?: number;
    semanticDisposition?: string;
    semanticRejectionReasons: string[];
    expectedArtifacts: string[];
    missingArtifacts: string[];
    logicalQuestionUnitId?: string;
    logicalQuestionUnitRevision?: number;
    answerRevision?: number;
    contextResolvable?: boolean;
    contextCandidateKinds: string[];
    contextCandidateSourceTurnIds: string[];
    contextDeltaChars?: number;
  };
  personalEvidence?: {
    requirement?: string;
    confidence?: number;
    confidenceTier?: string;
    statusDomain?: string;
    allowedSources?: string[];
    selectedSources?: string[];
    mode?: string;
    enforced?: boolean;
    unsupportedClaimRisk?: string;
  };
  projectBinding?: {
    action?: string;
    reason?: string;
    changed?: boolean;
    projectId?: string;
    projectName?: string;
    primaryEntryId?: string;
    source?: string;
    confidence?: number;
    revision?: number;
    candidateCount?: number;
    explicitAliases?: string[];
  };
  projectTrajectory?: {
    joinKey: string;
    parentId?: string;
    parentRevision?: number;
    projectId?: string;
    projectName?: string;
    projectBindingRevision?: number;
    phase?: string;
    factAnchorState?: string;
    factRequirementSource?: string;
    unsupportedClaimRisk?: string;
    factOutputCommitSource?: string;
    sanitizedClaimCount?: number;
    preservedClaimCount?: number;
    claimSupportAllowCount: number;
    claimSupportRejectCount: number;
    claimSupportClarificationCount: number;
    transitionKind?: string;
    childId?: string;
    childIntent?: string;
    returnParentId?: string;
    returnPhase?: string;
    returnProjectBindingRevision?: number;
  };
  clarifyingInteraction?: {
    requestId?: string;
    questionKey?: string;
    optionSource?: string;
    optionCount?: number;
    booleanFallbackUsed?: boolean;
    misleadingBooleanFallbackPrevented?: boolean;
    selectedLabel?: string;
    state?: string;
    terminalReason?: string;
    startedAt?: number;
    completedAt?: number;
  };
  sttValidation?: {
    disposition: string;
    reason?: string;
    promptSimilarity?: number;
    audioDurationMs?: number;
    transcriptCharsPerSecond?: number;
    densitySuspicious?: boolean;
  };
  audioSegment?: {
    disposition?: string;
    reason?: string;
    observationCount?: number;
    duplicateObservationCount?: number;
    canonicalCommitted?: boolean;
  };
  nativeAudioBoundary?: {
    sampleRate?: number;
    sampleStart?: number;
    sampleEnd?: number;
    durationMs?: number;
    endReason?: string;
    rolloverFamilyId?: string;
    overlapSampleCount?: number;
    overlapDurationMs?: number;
    silenceTargetSamples?: number;
    minimumSpeechSamples?: number;
    preSpeechSamples?: number;
    maximumSegmentSamples?: number;
  };
  sttRequest?: {
    providerId?: string;
    configuredProviderId?: string;
    providerIdentityStatus?: string;
    modelId?: string;
    modelSource?: string;
    language?: string;
    languageMode?: string;
    languageSource?: string;
    promptKind?: string;
    promptChars?: number;
    promptHash?: string;
    speechBiasChars?: number;
    continuationChars?: number;
    promptTruncated?: boolean;
    termCount?: number;
    confidenceCapability?: string;
    evidenceDurationMs?: number;
    continuationDisposition?: string;
    continuationReason?: string;
    continuationLeaseId?: string;
    continuationOperationId?: string;
    continuationSourceTurnId?: string;
    continuationSourceTraceId?: string;
    continuationCandidateSequence?: number;
    continuationLeaseExpiresAt?: number;
    continuationLeaseConsumedAt?: number;
    attemptCount?: number;
    initialAttemptId?: string;
    initialValidationDisposition?: string;
    initialValidationReason?: string;
    retryTriggered?: boolean;
    retryDisposition?: string;
    retryReason?: string;
    retryAttemptId?: string;
    retryValidationDisposition?: string;
    retryValidationReason?: string;
    finalAttemptId?: string;
    finalAttemptNumber?: number;
    finalPromptMode?: string;
    initialRequestDurationMs?: number;
    retryRequestDurationMs?: number;
    totalRequestDurationMs?: number;
    queueEnqueuedAt?: number;
    queueDequeuedAt?: number;
    queueAgeMs?: number;
    queueDepthAtEnqueue?: number;
    queueDepthAtDequeue?: number;
    queueDequeueAuthorized?: boolean;
    lifecycleEvent?: string;
    lifecycleAttemptId?: string;
    startedAt?: number;
    endedAt?: number;
    durationMs?: number;
    timeoutMs?: number;
    failureName?: string;
    abortRequested?: boolean;
    abortRequestedAt?: number;
    abortObserved?: boolean;
    abortObservedAt?: number;
    abortReason?: string;
    providerTimeout?: boolean;
    providerSettledAfterAbortMs?: number;
    orphanCompletion?: boolean;
    orphanCompletedAt?: number;
    orphanProviderOutcome?: string;
  };
  providerId?: string;
  mode?: string;
  responseLength?: string;
  responseLanguage?: string;
  modelRoute?: string;
  modelRouteReason?: string;
  answer?: {
    contractVersion?: string;
    profile?: string;
    parseStatus?: string;
    primarySource?: string;
    recognizedSections: string[];
    missingExpectedSections: string[];
    latestUsefulAnswerChars?: number;
    latestUsefulAnswerSource?: string;
    continuitySummaryIncludedSections: string[];
    continuitySummaryExcludedCode?: boolean;
    codeArtifactDecision?: string;
    whiteboardArtifactDecision?: string;
  };
  captureTarget?: {
    targetType?: string;
    captureMethod?: string;
    appName?: string;
    title?: string;
    monitorName?: string;
    fallbackReason?: string;
    imageWidth?: number;
    imageHeight?: number;
    originalImageWidth?: number;
    originalImageHeight?: number;
  };
  timingsMs: {
    total?: number;
    capture?: number;
    preflight?: number;
    memoryRetrieval?: number;
    stt?: number;
    advisor?: number;
    model?: number;
    stateUpdate?: number;
    firstTokenFromTraceStart?: number;
    firstTokenFromModelStart?: number;
  };
  payload: {
    audioBytes?: number;
    imageChars?: number;
    focusImageChars?: number;
    promptChars?: number;
    outputChars?: number;
    transcriptChars?: number;
    memoryChars?: number;
  };
  memory?: {
    selectedEntries?: number;
    candidateCount?: number;
    eligibleCount?: number;
    rejectedCount?: number;
    factEvidenceCount?: number;
    guidanceCount?: number;
    templateCount?: number;
    overlayCount?: number;
    anchorEligibleCount?: number;
    anchorIneligibleCount?: number;
    rejectSummary?: MemoryRejectSummary[];
    totalChars?: number;
    useCase?: string;
    cacheState?: string;
    cacheHit?: boolean;
    cacheLookupMs?: number;
    snapshotVersion?: number;
    snapshotGeneration?: number;
    snapshotAgeMs?: number;
    authorityRevision?: number;
    invalidationKind?: string;
    invalidationReason?: string;
    invalidationPreviousSnapshotVersion?: number;
    invalidationNewSnapshotVersion?: number;
    invalidationToFirstReadMs?: number;
    invalidationFirstRead?: boolean;
    hardInvalidationDisposition?: string;
    hardInvalidationAffectedEntryIds?: string[];
    hardInvalidationTargetsExcluded?: boolean;
    hardInvalidationStaleSnapshotServed?: boolean;
    databaseAcquireMs?: number;
    databaseReadMs?: number;
    rowMappingMs?: number;
    policyScoringMs?: number;
    budgetFormattingMs?: number;
    usageEnqueueMs?: number;
    usageQueueDepth?: number;
    usageFlushMs?: number;
    usageFlushEntryCount?: number;
    usageFlushSuccess?: boolean;
    degradedReason?: string;
  };
  whiteboard?: {
    artifactId?: string;
    revision?: number;
    domainTrack?: string;
    validationOperationId?: string;
    candidateKind?: string;
    candidateRevision?: number;
    validationDisposition?: string;
    validationDurationMs?: number;
    parserErrorClass?: string;
    sanitationDisposition?: string;
    sanitationChanges?: string[];
    originalParserErrorClass?: string;
    visibleRevisionBefore?: number;
    visibleRevisionAfter?: number;
    preservedLastValid?: boolean;
    renderStatus?: string;
    fallbackKind?: string;
    fallbackReason?: string;
    repairOperationId?: string;
    repairDisposition?: string;
    repairProviderDisposition?: string;
    repairParseDisposition?: string;
    repairQueueWaitMs?: number;
    repairDurationMs?: number;
    repairRevalidationDisposition?: string;
    repairBehaviorMutationBlocked?: boolean;
    formatPreference?: string;
    mermaidEligible?: boolean;
    mermaidRequested?: boolean;
    mermaidCommitted?: boolean;
    formatPolicyMiss?: boolean;
    formatConversionAttempted?: boolean;
    formatConversionDisposition?: string;
    asciiFallback?: boolean;
    asciiFallbackReason?: string;
  };
  manualPhase?: {
    from?: string;
    to?: string;
    targetArtifact?: string;
    guardStatus?: string;
    committed?: boolean;
  };
  diagramOverlay?: {
    selectedEntryIds: string[];
    rejectedCount?: number;
    rejectSummary?: MemoryRejectSummary[];
  };
  artifacts: {
    traceExportPath: string;
    summaryPath: string;
  };
  recordedAt: number;
}

interface SessionMetricsSummary {
  version: number;
  sessionId: string;
  savedAt: number;
  traceCount: number;
  syntheticValidationTraceCount: number;
  screen: SessionTraceKindAggregate;
  voice: SessionTraceKindAggregate;
  shortIntent: SessionShortIntentAggregate;
  answerStability: SessionAnswerStabilityAggregate;
  errors: number;
  cancelled: number;
}

interface SessionAnswerStabilityAggregate {
  unauthorizedVisibleRefreshCount: number;
  visibleRefreshWithoutPrimaryAskCount: number;
  visibleRefreshWithoutPrimaryAskByAuthority: Record<string, number>;
  suppressionRecommendedVisibleRefreshCount: number;
  primaryAskProjectionDisagreementCount: number;
  runtimeIntentContradictedVisibleRefreshCount: number;
  manualHardOverrideRefreshCount: number;
  staleGenerationCommitAttemptCount: number;
  staleGenerationCommitRejectedCount: number;
  codeMutationWithoutCodeIntentCount: number;
  deliveryLockCount: number;
  pendingCommitCount: number;
  pendingDropCount: number;
  pendingWithoutVisibleAnswerCount: number;
  deliveryLockBlockedFirstVisibleCommitCount: number;
  forceAdviseRecoveredPendingCandidateCount: number;
  forceAdviseEligibleWithoutVisibleCommitCount: number;
  manualOverrideCount: number;
  incorrectVisibleRefreshLabelCount: number;
  midReadInterruptionLabelCount: number;
  answerDwellMs: SessionNumberAggregate;
}

interface SessionShortIntentAggregate {
  canonicalFillerSuppressedCount: number;
  shortHighInformationAllowedCount: number;
  residualShortIntentAdjudicationCount: number;
  residualShortIntentIgnoreCount: number;
  residualShortIntentAnswerCount: number;
  intentGateBudgetExhaustedCount: number;
  intentGateTimeoutCount: number;
  intentGateDecisionAppliedCount: number;
  intentGateDurationMs: SessionNumberAggregate;
}

interface SessionTraceKindAggregate {
  total: number;
  success: number;
  error: number;
  cancelled: number;
  durationMs: SessionNumberAggregate;
  firstTokenFromTraceStartMs: SessionNumberAggregate;
  modelDurationMs: SessionNumberAggregate;
  captureDurationMs: SessionNumberAggregate;
  sttDurationMs: SessionNumberAggregate;
  sttQueueAgeMs: SessionNumberAggregate;
  advisorDurationMs: SessionNumberAggregate;
  sttValidation: {
    accepted: number;
    empty: number;
    rejected: number;
  };
  audioSegmentDisposition: {
    accepted: number;
    promptEchoRetryAccepted: number;
    promptEchoRetryRejected: number;
    sttError: number;
    stale: number;
    duplicate: number;
    invalidSequence: number;
  };
  nativeAudioBoundary: {
    silence: number;
    forcedRollover: number;
    stopDrain: number;
    terminationDrain: number;
    continuousStop: number;
    overlap: number;
  };
  sttRequestLifecycle: {
    abortRequested: number;
    abortObserved: number;
    providerTimeout: number;
    orphanCompletion: number;
  };
}

interface SessionNumberAggregate {
  count: number;
  p50?: number;
  p90?: number;
  max?: number;
}

export class SessionRecordingManager {
  private activeSession?: ActiveSessionRecording;
  private lifecycle: MeetingSessionRecordingState["lifecycle"] = "idle";
  private transitionQueue: Promise<void> = Promise.resolve();
  private lastError?: string;
  private traceGenerationOwners = new Map<string, string>();
  private onChange?: (state: MeetingSessionRecordingState) => void;
  private invokeCommand: SessionRecordingInvoke;

  constructor(
    onChange?: (state: MeetingSessionRecordingState) => void,
    invokeCommand: SessionRecordingInvoke = (command, args) =>
      invoke(command, args)
  ) {
    this.onChange = onChange;
    this.invokeCommand = invokeCommand;
  }

  getState(): MeetingSessionRecordingState {
    if (!this.activeSession) {
      return {
        active: false,
        lifecycle: this.lifecycle,
        eventCount: 0,
        artifactCount: 0,
        lastError: this.lastError,
      };
    }

    return {
      active: true,
      lifecycle: this.lifecycle,
      sessionId: this.activeSession.sessionId,
      folderName: this.activeSession.folderName,
      folderPath: this.activeSession.folderPath,
      startedAt: this.activeSession.startedAt,
      eventCount: this.activeSession.eventCount,
      artifactCount: this.activeSession.artifactCount,
      lastError: this.activeSession.lastError,
    };
  }

  async start(options: SessionRecordingStartOptions) {
    return this.serializeTransition(async () => {
      if (this.activeSession) return this.getState();

      this.lifecycle = "starting";
      this.lastError = undefined;
      this.emit();

      try {
        const startedAt = Date.now();
        const sessionId = createMeetingId("session_recording");
        const folderName = buildSessionRecordingFolderName(sessionId, startedAt);
        const initialManifest = buildSessionRecordingManifest({
          status: "running",
          sessionId,
          folderName,
          folderPath: undefined,
          startedAt,
          settings: options.settings,
          interviewSessionBrief: options.interviewSessionBrief,
          interviewSessionContext: options.interviewSessionContext,
          providerSummary: options.providerSummary,
        });

        const folderPath = await this.invokeCommand<string>(
          "start_meeting_session_recording",
          {
            folderName,
            manifestPayload: JSON.stringify(initialManifest, null, 2),
            readmePayload: buildSessionRecordingReadme(sessionId),
          }
        );
        const manifestBase = buildSessionRecordingManifest({
          status: "running",
          sessionId,
          folderName,
          folderPath,
          startedAt,
          settings: options.settings,
          interviewSessionBrief: options.interviewSessionBrief,
          interviewSessionContext: options.interviewSessionContext,
          providerSummary: options.providerSummary,
        });
        const session: ActiveSessionRecording = {
          generationId: createMeetingId("recording_generation"),
          phase: "active",
          sessionId,
          folderName,
          folderPath,
          startedAt,
          eventCount: 0,
          artifactCount: 0,
          manifestBase,
          recordedTraceIds: new Set(),
          recordedTaskIds: new Set(),
          recordedTurnIds: new Set(),
          recordedObservationIds: new Set(),
          traceSessionIndex: new Map(),
          traceSummaries: new Map(),
          traceHumanEvaluations: new Map(),
          questionHumanEvaluations: new Map(),
          humanGroundTruthEventsV2: new Map(),
          humanEvaluationProjectionsV2: new Map(),
          criticalMomentCandidates: new Map(),
          criticalMomentEvaluations: new Map(),
          preparationRuntimeContexts: new Map(),
          preparationArtifactUseReceipts: new Map(),
          preparationArtifactEvaluations: new Map(),
          untraceablePreparationArtifactUseCount: 0,
          writeQueue: Promise.resolve(),
          enqueueVersion: 0,
          pendingWrites: 0,
          acceptedWrites: 0,
          rejectedLateWrites: 0,
          drainPasses: 0,
          failedWriteCount: 0,
          failedWrites: [],
        };

        await this.writeJson(session, "manifest.json", manifestBase);
        await this.writeJson(
          session,
          "settings/meeting-assistant-settings.json",
          {
            savedAt: Date.now(),
            settings: sanitizeMeetingAssistantSettings(options.settings),
          }
        );
        await this.writeJson(session, "settings/interview-brief.json", {
          savedAt: Date.now(),
          interviewSessionBrief: options.interviewSessionBrief,
          interviewSessionContext: options.interviewSessionContext,
        });
        await this.writeJson(session, "settings/provider-summary.json", {
          savedAt: Date.now(),
          providerSummary: options.providerSummary,
        });

        this.activeSession = session;
        this.lifecycle = "active";
        this.emit();
        this.recordEvent("session-started", {
          folderPath,
          privacy: "raw audio omitted",
        });
        return this.getState();
      } catch (error) {
        this.lifecycle = "idle";
        this.lastError = error instanceof Error ? error.message : String(error);
        this.emit();
        throw error;
      }
    });
  }

  async stop(reason = "manual") {
    return this.serializeTransition(async () => {
      const session = this.activeSession;
      if (!session) return this.getState();

      const endedAt = Date.now();
      session.phase = "closing";
      session.closingAt = endedAt;
      this.lifecycle = "closing";
      this.emit();
      this.recordEvent("session-stopped", { reason, endedAt });

      try {
        await this.drainStable(session);
        const evaluationView =
          projectHumanEvaluationsForLegacyConsumers({
            evaluations: Array.from(
              session.questionHumanEvaluations.values()
            ),
            projections: Array.from(
              session.humanEvaluationProjectionsV2.values()
            ),
          });
        const finalReviewIndex = buildSessionTaskReviewIndex(
          session.sessionId,
          Array.from(session.traceSummaries.values()),
          evaluationView.evaluations
        );
        await this.tryFinalizationWrite(
          session,
          () =>
            this.writeJson(
              session,
              "human-evaluation/compatibility-v2.json",
              evaluationView.report
            )
        );
        await this.tryFinalizationWrite(session, () =>
          this.writeTaskReviewIndex(session, finalReviewIndex)
        );
        await this.drainStable(session);
        session.phase = "sealed";
        await Promise.resolve();
        const queueDrained = session.pendingWrites === 0;
        const enqueueCounterConsistent =
          session.enqueueVersion === session.acceptedWrites;
        const recordingIntegrity = {
          version: SESSION_RECORDING_INTEGRITY_SCHEMA_VERSION,
          status:
            queueDrained &&
            enqueueCounterConsistent &&
            session.failedWriteCount === 0
              ? "complete"
              : "incomplete",
          queueDrained,
          enqueueCounterConsistent,
          failedWriteCount: session.failedWriteCount,
          failedWriteDetailsTruncated:
            session.failedWriteCount > session.failedWrites.length,
          failedWrites: session.failedWrites,
        };
        const evaluationIntegrity = {
          v1EvaluationCount: session.questionHumanEvaluations.size,
          v2GroundTruthEventCount:
            session.humanGroundTruthEventsV2.size,
          v2ProjectionCount:
            session.humanEvaluationProjectionsV2.size,
          v2ConflictProjectionCount: Array.from(
            session.humanEvaluationProjectionsV2.values()
          ).filter((projection) => projection.conflicts.length > 0)
            .length,
          v2ProjectionTraceHashCount: Array.from(
            session.humanEvaluationProjectionsV2.values()
          ).filter(
            (projection) => projection.inputTraceHashes.length > 0
          ).length,
          consumerEvaluationCount: evaluationView.evaluations.length,
          matchedProjectionCount:
            evaluationView.report.matchedProjectionCount,
          v1OnlyEvaluationCount:
            evaluationView.report.v1OnlyEvaluationCount,
          v2OnlyProjectionCount:
            evaluationView.report.v2OnlyProjectionCount,
          compatibilityWarningCount:
            evaluationView.report.warnings.length,
          compatibilityReportPath:
            "human-evaluation/compatibility-v2.json",
          taskReviewIndexPath: "tasks/review-index.latest.json",
          derivationVersions:
            evaluationView.report.derivationVersions,
        };
        await this.writeJson(session, "manifest.json", {
          ...session.manifestBase,
          status: "stopped",
          endedAt,
          closedAt: Date.now(),
          durationMs: endedAt - session.startedAt,
          stopReason: reason,
          eventCount: session.eventCount,
          artifactCount: session.artifactCount,
          lastError: session.lastError,
          recordingLifecycle: {
            generationId: session.generationId,
            closingAt: session.closingAt,
            acceptedWrites: session.acceptedWrites,
            rejectedLateWrites: session.rejectedLateWrites,
            drainPasses: session.drainPasses,
            pendingWritesAtSeal: session.pendingWrites,
            enqueueCounterConsistent,
            queueDrained,
          },
          recordingIntegrity,
          evaluationIntegrity,
          preparationRuntimeIntegrity: {
            contextSnapshotCount: session.preparationRuntimeContexts.size,
            artifactUseReceiptCount:
              session.preparationArtifactUseReceipts.size,
            artifactEvaluationCount:
              session.preparationArtifactEvaluations.size,
            answerAttributionCount:
              buildPreparationAnswerAttributionIndex(
                Array.from(
                  session.preparationArtifactUseReceipts.values()
                )
              ).length,
            untraceableArtifactUseCount:
              session.untraceablePreparationArtifactUseCount,
          },
        });
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        if (this.activeSession === session) {
          this.activeSession = undefined;
        }
        this.lifecycle = "idle";
        this.lastError = session.lastError ?? this.lastError;
        this.emit();
      }

      return this.getState();
    });
  }

  canRecordTrace(trace: Pick<MeetingTrace, "id" | "startedAt">) {
    const session = this.activeSession;
    const traceOwner = this.traceGenerationOwners.get(trace.id);
    if (
      !session ||
      session.phase === "sealed" ||
      trace.startedAt < session.startedAt ||
      (traceOwner !== undefined && traceOwner !== session.generationId)
    ) {
      return false;
    }
    return true;
  }

  hasRecordedTrace(traceId: string) {
    return Boolean(
      this.activeSession?.phase !== "sealed" &&
        this.activeSession?.recordedTraceIds.has(traceId)
    );
  }

  recordTranscriptTurn(turn: TranscriptTurn) {
    const session = this.getWritableSession({ startedAt: turn.startedAt });
    if (!session) return;

    const payload = `${JSON.stringify(turn)}\n`;
    session.recordedTurnIds.add(turn.id);
    this.enqueue(session, async () => {
      await this.writeText(session, "transcripts/turns.jsonl", payload, true);
      await this.writeText(
        session,
        "transcripts/transcript.md",
        `${formatTimestamp(turn.startedAt)} **${turn.speaker}** (${turn.source}): ${turn.text}\n\n`,
        true
      );
    });
    this.recordEvent("transcript-turn", {
      turnId: turn.id,
      speaker: turn.speaker,
      source: turn.source,
      textChars: turn.text.length,
      audioSegmentSeq: turn.audioSegmentSeq,
      contextTier: turn.contextTier,
      contextFusionStatus: turn.contextFusionStatus,
    });
  }

  recordScreenCapture(observation: ScreenObservation, traceId?: string) {
    const session = this.getWritableSession({
      traceId,
      startedAt: observation.capturedAt,
    });
    if (!session) return;

    const artifactRefs: string[] = [];
    session.recordedObservationIds.add(observation.id);
    if (traceId) session.recordedTraceIds.add(traceId);
    const extension = imageExtension(observation.imageMediaType);
    const focusExtension = imageExtension(observation.focusImageMediaType);
    const basePath = `screenshots/${observation.id}`;
    const metadataPath = `${basePath}.metadata.json`;

    if (observation.imageBase64) {
      const imagePath = `${basePath}.${extension}`;
      artifactRefs.push(imagePath);
      this.enqueue(session, () =>
        this.writeBase64(session, imagePath, observation.imageBase64 ?? "")
      );
    }
    if (observation.focusImageBase64) {
      const focusPath = `${basePath}.focus.${focusExtension}`;
      artifactRefs.push(focusPath);
      this.enqueue(session, () =>
        this.writeBase64(
          session,
          focusPath,
          observation.focusImageBase64 ?? ""
        )
      );
    }

    artifactRefs.push(metadataPath);
    this.enqueue(session, () =>
      this.writeJson(session, metadataPath, {
        ...observation,
        imageBase64: observation.imageBase64
          ? `[stored separately; chars=${observation.imageBase64.length}]`
          : undefined,
        focusImageBase64: observation.focusImageBase64
          ? `[stored separately; chars=${observation.focusImageBase64.length}]`
          : undefined,
      })
    );
    this.recordEvent(
      "screen-capture",
      {
        observationId: observation.id,
        changed: observation.changed,
        hash: observation.hash,
        imageMediaType: observation.imageMediaType,
        focusImageMediaType: observation.focusImageMediaType,
        captureTarget: observation.captureTarget,
      },
      artifactRefs,
      traceId
    );
  }

  recordModelInput({
    traceId,
    taskId,
    label,
    value,
    metadata,
  }: {
    traceId: string;
    taskId?: string;
    label: string;
    value: string;
    metadata?: Record<string, unknown>;
  }) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;

    const path = buildTraceArtifactPath(traceId, "prompts", label, "txt");
    session.recordedTraceIds.add(traceId);
    if (taskId) session.recordedTaskIds.add(taskId);
    this.enqueue(session, () => this.writeText(session, path, value));
    this.recordEvent("model-input", { label, valueChars: value.length, metadata }, [
      path,
    ], traceId, taskId);
  }

  recordModelOutput({
    traceId,
    taskId,
    label,
    value,
    metadata,
  }: {
    traceId: string;
    taskId?: string;
    label: string;
    value: string;
    metadata?: Record<string, unknown>;
  }) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;

    const path = buildTraceArtifactPath(traceId, "outputs", label, "md");
    session.recordedTraceIds.add(traceId);
    if (taskId) session.recordedTaskIds.add(taskId);
    this.enqueue(session, () => this.writeText(session, path, value));
    this.recordEvent("model-output", { label, valueChars: value.length, metadata }, [
      path,
    ], traceId, taskId);
  }

  recordMemoryRetrieval({
    traceId,
    taskId,
    query,
    diagramDomainQuery,
    source,
    memoryContext,
    metadata,
  }: {
    traceId?: string;
    taskId?: string;
    query: string;
    diagramDomainQuery?: string;
    source: "advisor" | "screen";
    memoryContext: MemoryRetrievalResult;
    metadata?: Record<string, unknown>;
  }) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;

    const baseName = `${traceId ?? createMeetingId("memory")}-${Date.now()}`;
    if (traceId) session.recordedTraceIds.add(traceId);
    if (taskId) session.recordedTaskIds.add(taskId);
    const jsonPath = `memory/${sanitizeFilePart(baseName)}.json`;
    const contextPath = `memory/${sanitizeFilePart(baseName)}.context.md`;
    this.enqueue(session, async () => {
      await this.writeJson(session, jsonPath, {
        query,
        diagramDomainQuery,
        source,
        metadata,
        memoryContext,
      });
      await this.writeText(session, contextPath, memoryContext.contextText);
    });
    this.recordEvent(
      "memory-retrieval",
      {
        source,
        queryChars: query.length,
        diagramDomainQueryChars: diagramDomainQuery?.length ?? 0,
        selectedEntries: memoryContext.entries.length,
        candidateCount: memoryContext.candidateCount,
        eligibleCount: memoryContext.eligibleCount,
        rejectedCount: memoryContext.rejectedCount,
        rejectSummary: memoryContext.rejectSummary,
        totalChars: memoryContext.totalChars,
        performance: memoryContext.performance,
        metadata,
      },
      [jsonPath, contextPath],
      traceId,
      taskId
    );
  }

  recordPlaybookSelection(
    traceId: string | undefined,
    metadata: Record<string, unknown>,
    taskId?: string
  ) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;
    if (traceId) session.recordedTraceIds.add(traceId);
    if (taskId) session.recordedTaskIds.add(taskId);
    this.recordEvent("playbook-selected", metadata, undefined, traceId, taskId);
  }

  recordFactAnchorDecision(
    traceId: string | undefined,
    metadata: Record<string, unknown>,
    taskId?: string
  ) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;
    if (traceId) session.recordedTraceIds.add(traceId);
    if (taskId) session.recordedTaskIds.add(taskId);
    this.recordEvent("fact-anchor-decision", metadata, undefined, traceId, taskId);
  }

  recordProjectBindingDecision(
    traceId: string | undefined,
    metadata: Record<string, unknown>,
    taskId?: string
  ) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;
    if (traceId) session.recordedTraceIds.add(traceId);
    if (taskId) session.recordedTaskIds.add(taskId);
    this.recordEvent(
      "project-binding-decision",
      metadata,
      undefined,
      traceId,
      taskId
    );
  }

  recordTaskSnapshot(task: ActiveScreenTask, traceId?: string) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;

    const path = `tasks/${sanitizeFilePart(task.id)}/task.json`;
    session.recordedTaskIds.add(task.id);
    if (traceId) session.recordedTraceIds.add(traceId);
    this.enqueue(session, () => this.writeJson(session, path, task));
    this.recordEvent(
      "task-snapshot",
      {
        activeScreenTaskId: task.id,
        kind: task.kind,
        question: task.question,
        observationId: task.observationId,
      },
      [path],
      traceId,
      task.id
    );
  }

  recordActiveMeetingTaskSnapshot(task: ActiveMeetingTask, traceId?: string) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;

    const path = `tasks/${sanitizeFilePart(task.id)}/active-meeting-task.json`;
    const snapshotsPath = `tasks/${sanitizeFilePart(task.id)}/snapshots.jsonl`;
    const payload = {
      recordedAt: new Date().toISOString(),
      traceId,
      task: formatActiveMeetingTaskForRecording(task),
    };
    session.recordedTaskIds.add(task.id);
    session.recordedTaskIds.add(task.parent.id);
    if (task.screen?.activeScreenTaskId) {
      session.recordedTaskIds.add(task.screen.activeScreenTaskId);
    }
    if (traceId) session.recordedTraceIds.add(traceId);
    this.enqueue(session, () => this.writeJson(session, path, payload));
    this.enqueue(session, () => this.appendJsonl(session, snapshotsPath, payload));
    this.recordEvent(
      "active-meeting-task-snapshot",
      {
        activeMeetingTaskId: task.id,
        activeMeetingTaskSource: task.source,
        activeMeetingParentId: task.parent.id,
        activeMeetingParentRevision: task.parent.revisions,
        activeMeetingParentQuestionType: task.parent.questionType,
        activeMeetingParentPhase: task.parent.playbookPhase,
        activeMeetingProjectBindingId: task.parent.projectBinding?.projectId,
        activeMeetingProjectBindingName:
          task.parent.projectBinding?.projectName,
        activeMeetingProjectBindingEntryId:
          task.parent.projectBinding?.primaryEntryId,
        activeMeetingProjectBindingSource:
          task.parent.projectBinding?.source,
        activeMeetingProjectBindingConfidence:
          task.parent.projectBinding?.confidence,
        activeMeetingProjectBindingRevision:
          task.parent.projectBinding?.revision,
        activeMeetingChildId: task.child?.id,
        activeMeetingChildQuestionType: task.child?.questionType,
        activeMeetingChildIntent: task.child?.intent,
        activeMeetingChildReturnParentId:
          task.child?.returnCapsule?.parentId,
        activeMeetingChildReturnPhase:
          task.child?.returnCapsule?.parentPhase,
        activeMeetingChildReturnProjectBindingRevision:
          task.child?.returnCapsule?.projectBindingRevision,
        activeMeetingChildReturnFactAnchorCount:
          task.child?.returnCapsule?.allowedFactAnchorIds.length,
        projectTrajectoryJoinKey: buildProjectTrajectoryJoinKey({
          parentId: task.parent.id,
          projectBindingRevision:
            task.parent.projectBinding?.revision,
        }),
        activeScreenTaskId: task.screen?.activeScreenTaskId,
        hasScreenContext: Boolean(task.screen),
        divergence: task.divergence?.reason,
      },
      [path, snapshotsPath],
      traceId,
      task.id
    );
  }

  recordManualQuestionTypeCorrection(
    correction: ManualQuestionTypeCorrection
  ) {
    const session = this.getWritableSession({
      traceId: correction.correctionTraceId,
    });
    if (!session) return;

    const path = `tasks/${sanitizeFilePart(
      correction.taskId
    )}/manual-question-type-corrections.jsonl`;
    session.recordedTaskIds.add(correction.taskId);
    session.recordedTaskIds.add(correction.parentTaskId);
    session.recordedTraceIds.add(correction.correctionTraceId);
    if (correction.regenerationTraceId) {
      session.recordedTraceIds.add(correction.regenerationTraceId);
    }
    this.enqueue(session, () => this.appendJsonl(session, path, correction));
    this.recordEvent(
      "manual-question-type-correction",
      {
        manualQuestionTypeCorrectionId: correction.eventId,
        questionId: correction.questionId,
        parentTaskId: correction.parentTaskId,
        childTaskId: correction.childTaskId,
        detectedQuestionType: correction.detectedType,
        correctedQuestionType: correction.correctedType,
        correctionSource: correction.source,
        correctionTarget: correction.target,
        correctionScope: correction.scope,
        correctionScopeReason: correction.scopeReason,
        standaloneTaskScore: correction.standaloneTaskScore,
        standaloneTaskEvidence: correction.standaloneTaskEvidence,
        continuityScore: correction.continuityScore,
        continuityEvidence: correction.continuityEvidence,
        correctionStatus: correction.status,
        regenerationStatus: correction.regenerationStatus,
        supersedesCorrectionId: correction.supersedesCorrectionId,
        supersededByCorrectionId: correction.supersededByCorrectionId,
        correctionTraceId: correction.correctionTraceId,
        regenerationTraceId: correction.regenerationTraceId,
        evaluationId: correction.evaluationId,
        error: correction.error,
      },
      [path],
      correction.correctionTraceId,
      correction.taskId
    );
  }

  recordActiveQuestionTermCorrection(input: {
    correction: ActiveQuestionTermCorrection;
    taskId?: string;
  }) {
    const session = this.getWritableSession({
      traceId: input.correction.correctionTraceId,
    });
    if (!session) return;

    const path = input.taskId
      ? `tasks/${sanitizeFilePart(
          input.taskId
        )}/active-question-term-corrections.jsonl`
      : "runtime/active-question-term-corrections.jsonl";
    if (input.taskId) {
      session.recordedTaskIds.add(input.taskId);
    }
    session.recordedTraceIds.add(input.correction.correctionTraceId);
    if (input.correction.regenerationTraceId) {
      session.recordedTraceIds.add(input.correction.regenerationTraceId);
    }
    this.enqueue(session, () =>
      this.appendJsonl(session, path, input.correction)
    );
    this.recordEvent(
      "active-question-term-correction",
      {
        manualTermCorrectionId: input.correction.correctionId,
        manualTermCorrectionDisposition: input.correction.disposition,
        manualTermCorrectionNormalizedTerm:
          input.correction.normalizedTerm,
        manualTermCorrectionReplacedText:
          input.correction.replacedText,
        logicalQuestionUnitId:
          input.correction.logicalQuestionUnitId,
        logicalQuestionUnitRevision:
          input.correction.logicalQuestionUnitRevision,
        correctedLogicalQuestionUnitRevision:
          input.correction.correctedLogicalQuestionUnitRevision,
        sourceTurnIds: input.correction.sourceTurnIds,
        manualCorrectionRevision:
          input.correction.manualCorrectionRevision,
        correctionTraceId: input.correction.correctionTraceId,
        regenerationTraceId:
          input.correction.regenerationTraceId,
        settlementId: input.correction.settlementId,
        semanticAdjudicationOperationId:
          input.correction.semanticAdjudicationOperationId,
        semanticAdjudicationStatus:
          input.correction.semanticAdjudicationStatus,
        semanticAdjudicationTriggerReason:
          input.correction.semanticAdjudicationTriggerReason,
        semanticAdjudicationCandidateType:
          input.correction.semanticAdjudicationCandidateType,
        semanticAdjudicationRelation:
          input.correction.semanticAdjudicationRelation,
        semanticAdjudicationConfidence:
          input.correction.semanticAdjudicationConfidence,
        semanticAdjudicationDurationMs:
          input.correction.semanticAdjudicationDurationMs,
        semanticResettlementDisposition:
          input.correction.semanticResettlementDisposition,
        previousParentType: input.correction.previousParentType,
        resettledParentType:
          input.correction.resettledParentType,
        regenerationStatus:
          input.correction.regenerationStatus,
        correctionToAnswerLatencyMs:
          input.correction.correctionToAnswerLatencyMs,
        error: input.correction.error,
      },
      [path],
      input.correction.correctionTraceId,
      input.taskId
    );
  }

  recordTrace(trace: MeetingTrace, trigger: MeetingTraceExportTrigger) {
    const session = this.getWritableSession({
      traceId: trace.id,
      startedAt: trace.startedAt,
    });
    if (!session || trace.status === "running") return;
    if (!this.canRecordTrace(trace)) return;

    const path = `traces/${sanitizeFilePart(trace.id)}.json`;
    const payload = serializeMeetingTraceExport(trace, { trigger });
    session.recordedTraceIds.add(trace.id);
    this.recordTraceSessionIndex({
      traceId: trace.id,
      source: "trace-export",
      trace,
    });
    this.recordCompactTraceSummary(trace, trigger, path);
    this.enqueue(session, () => this.writeText(session, path, payload));
    this.recordEvent(
      "trace-export",
      {
        traceId: trace.id,
        traceKind: trace.kind,
        traceStatus: trace.status,
        trigger,
        durationMs: trace.durationMs,
      },
      [path],
      trace.id
    );
  }

  refreshRecordedTrace(
    trace: MeetingTrace,
    trigger: MeetingTraceExportTrigger
  ) {
    const session = this.getWritableSession({
      traceId: trace.id,
      startedAt: trace.startedAt,
    });
    if (
      !session ||
      trace.status === "running" ||
      !session.recordedTraceIds.has(trace.id) ||
      !this.canRecordTrace(trace)
    ) {
      return;
    }

    const path = `traces/${sanitizeFilePart(trace.id)}.json`;
    const payload = serializeMeetingTraceExport(trace, { trigger });
    this.recordTraceSessionIndex({
      traceId: trace.id,
      source: "trace-lifecycle-refresh",
      trace,
    });
    this.recordCompactTraceSummary(trace, trigger, path);
    this.enqueue(session, () => this.writeText(session, path, payload));
  }

  recordTraceMetrics(payload: string) {
    const session = this.getWritableSession();
    if (!session) return;

    const filteredPayload = filterTraceMetricsPayload(
      payload,
      session.recordedTraceIds
    );
    this.enqueue(session, async () => {
      await this.writeText(
        session,
        "metrics/trace-metrics.json",
        filteredPayload
      );
    });
    this.recordEvent(
      "trace-metrics",
      {
        payloadChars: filteredPayload.length,
        recordedTraceCount: session.recordedTraceIds.size,
        note: "Full trace metrics snapshots are kept in trace-metrics.json; compact evaluation rows are written to trace-summaries.jsonl.",
      },
      ["metrics/trace-metrics.json"]
    );
  }

  recordHumanEvaluations(evaluations: TraceHumanEvaluation[]) {
    const session = this.getWritableSession();
    if (!session) return;
    const sessionEvaluations = evaluations.filter((evaluation) =>
      session.recordedTraceIds.has(evaluation.traceId)
    );
    if (!sessionEvaluations.length) return;
    for (const evaluation of sessionEvaluations) {
      session.traceHumanEvaluations.set(evaluation.traceId, evaluation);
    }

    const payload = JSON.stringify(
      {
        savedAt: Date.now(),
        sessionId: session.sessionId,
        evaluations: sessionEvaluations,
      },
      null,
      2
    );
    const compactPayload = JSON.stringify({
      savedAt: Date.now(),
      sessionId: session.sessionId,
      evaluations: sessionEvaluations,
    });
    const sessionSummary = buildSessionMetricsSummary(
      session.sessionId,
      Array.from(session.traceSummaries.values()),
      Array.from(session.traceHumanEvaluations.values())
    );
    this.enqueue(session, async () => {
      await this.writeText(
        session,
        "human-evaluation/evaluations.json",
        payload
      );
      await this.writeText(
        session,
        "human-evaluation/evaluations.jsonl",
        `${compactPayload}\n`,
        true
      );
      await this.writeJson(
        session,
        "metrics/session-summary.json",
        sessionSummary
      );
    });
    this.recordEvent("human-evaluation", {
      evaluationCount: sessionEvaluations.length,
    }, ["human-evaluation/evaluations.json"]);
  }

  recordQuestionHumanEvaluations(evaluations: QuestionHumanEvaluation[]) {
    const session = this.getWritableSession();
    if (!session) return;
    const sessionEvaluations = evaluations.filter((evaluation) => {
      if (
        evaluation.traceIds.some((traceId) => session.recordedTraceIds.has(traceId))
      ) {
        return true;
      }
      return [
        evaluation.taskId,
        evaluation.parentTaskId,
        evaluation.childTaskId,
      ].some((taskId) => taskId && session.recordedTaskIds.has(taskId));
    });
    if (!sessionEvaluations.length) return;

    const payload = JSON.stringify(
      {
        savedAt: Date.now(),
        sessionId: session.sessionId,
        evaluations: sessionEvaluations,
      },
      null,
      2
    );
    const compactPayload = JSON.stringify({
      savedAt: Date.now(),
      sessionId: session.sessionId,
      evaluations: sessionEvaluations,
    });
    for (const evaluation of sessionEvaluations) {
      session.questionHumanEvaluations.set(evaluation.questionId, evaluation);
    }
    const evaluationView = projectHumanEvaluationsForLegacyConsumers({
      evaluations: Array.from(session.questionHumanEvaluations.values()),
      projections: Array.from(
        session.humanEvaluationProjectionsV2.values()
      ),
    });
    const reviewIndex = buildSessionTaskReviewIndex(
      session.sessionId,
      Array.from(session.traceSummaries.values()),
      evaluationView.evaluations
    );
    this.enqueue(session, async () => {
      await this.writeText(
        session,
        "human-evaluation/question-evaluations.json",
        payload
      );
      await this.writeText(
        session,
        "human-evaluation/question-evaluations.jsonl",
        `${compactPayload}\n`,
        true
      );
      await this.writeJson(
        session,
        "human-evaluation/compatibility-v2.json",
        evaluationView.report
      );
      await this.writeTaskReviewIndex(session, reviewIndex);
    });
    this.recordEvent(
      "question-human-evaluation",
      {
        evaluationCount: sessionEvaluations.length,
      },
      ["human-evaluation/question-evaluations.json"]
    );
  }

  recordHumanGroundTruthEventV2(event: HumanGroundTruthEventV2) {
    const session = this.getWritableSession();
    if (!session || event.sessionId !== session.sessionId) return;
    if (session.humanGroundTruthEventsV2.has(event.eventId)) return;

    session.humanGroundTruthEventsV2.set(event.eventId, event);
    const eventPath = "human-evaluation/ground-truth-v2.jsonl";
    this.enqueue(session, () =>
      this.writeText(session, eventPath, `${JSON.stringify(event)}\n`, true)
    );
    this.recordEvent(
      "human-ground-truth-v2",
      {
        eventId: event.eventId,
        factKind: event.fact.kind,
        source: event.provenance.source,
        confirmation: event.confirmation,
        questionId: event.subject.questionId,
        momentId: event.subject.momentId,
        actionId: event.provenance.actionId,
        supersedesEventId: event.supersedesEventId,
      },
      [eventPath],
      event.provenance.sourceTraceId
    );
  }

  recordHumanEvaluationProjectionV2(
    projection: HumanEvaluationProjectionV2
  ) {
    const session = this.getWritableSession();
    if (!session || projection.sessionId !== session.sessionId) return;

    session.humanEvaluationProjectionsV2.set(
      projection.projectionId,
      projection
    );
    const snapshotPath = "human-evaluation/projections-v2.json";
    const historyPath = "human-evaluation/projections-v2.jsonl";
    const snapshot = JSON.stringify(
      {
        savedAt: Date.now(),
        sessionId: session.sessionId,
        derivationVersion: projection.derivationVersion,
        projections: Array.from(
          session.humanEvaluationProjectionsV2.values()
        ),
      },
      null,
      2
    );
    const evaluationView = projectHumanEvaluationsForLegacyConsumers({
      evaluations: Array.from(session.questionHumanEvaluations.values()),
      projections: Array.from(
        session.humanEvaluationProjectionsV2.values()
      ),
    });
    const reviewIndex = buildSessionTaskReviewIndex(
      session.sessionId,
      Array.from(session.traceSummaries.values()),
      evaluationView.evaluations
    );
    this.enqueue(session, async () => {
      await this.writeText(session, snapshotPath, snapshot);
      await this.writeText(
        session,
        historyPath,
        `${JSON.stringify(projection)}\n`,
        true
      );
      await this.writeJson(
        session,
        "human-evaluation/compatibility-v2.json",
        evaluationView.report
      );
      await this.writeTaskReviewIndex(session, reviewIndex);
    });
    this.recordEvent(
      "human-evaluation-projection-v2",
      {
        projectionId: projection.projectionId,
        questionId: projection.subject.questionId,
        derivationVersion: projection.derivationVersion,
        inputEventCount: projection.inputEventIds.length,
        inputTraceHashCount: projection.inputTraceHashes.length,
        conflictCount: projection.conflicts.length,
      },
      [snapshotPath, historyPath],
      projection.subject.traceIds[0]
    );
  }

  recordCriticalMomentCandidates(candidates: CriticalMomentCandidate[]) {
    const session = this.getWritableSession();
    if (!session) return;
    const sessionCandidates = candidates.filter(
      (candidate) =>
        candidate.sessionId === session.sessionId ||
        candidate.sourceTurnIds.some((turnId) =>
          session.recordedTurnIds.has(turnId)
        )
    );
    if (!sessionCandidates.length) return;

    for (const candidate of sessionCandidates) {
      session.criticalMomentCandidates.set(candidate.momentId, candidate);
    }
    const completeCandidates = Array.from(
      session.criticalMomentCandidates.values()
    );
    const payload = JSON.stringify(
      {
        savedAt: Date.now(),
        sessionId: session.sessionId,
        candidates: completeCandidates,
      },
      null,
      2
    );
    const compactPayload = JSON.stringify({
      savedAt: Date.now(),
      sessionId: session.sessionId,
      candidates: sessionCandidates,
    });
    this.enqueue(session, async () => {
      await this.writeText(
        session,
        "human-evaluation/critical-moment-candidates.json",
        payload
      );
      await this.writeText(
        session,
        "human-evaluation/critical-moment-candidates.jsonl",
        `${compactPayload}\n`,
        true
      );
    });
    this.recordEvent(
      "critical-moment-candidates",
      {
        candidateCount: completeCandidates.length,
        zeroTraceCandidateCount: completeCandidates.filter(
          (candidate) => candidate.proposedTraceIds.length === 0
        ).length,
      },
      ["human-evaluation/critical-moment-candidates.json"]
    );
  }

  recordCriticalMomentEvaluations(evaluations: CriticalMomentEvaluation[]) {
    const session = this.getWritableSession();
    if (!session) return;
    const sessionEvaluations = evaluations.filter(
      (evaluation) =>
        evaluation.sessionId === session.sessionId ||
        evaluation.sourceTurnIds.some((turnId) =>
          session.recordedTurnIds.has(turnId)
        ) ||
        evaluation.traceIds.some((traceId) =>
          session.recordedTraceIds.has(traceId)
        )
    );
    if (!sessionEvaluations.length) return;

    for (const evaluation of sessionEvaluations) {
      session.criticalMomentEvaluations.set(
        evaluation.momentId,
        evaluation
      );
    }
    const completeEvaluations = Array.from(
      session.criticalMomentEvaluations.values()
    );
    const payload = JSON.stringify(
      {
        savedAt: Date.now(),
        sessionId: session.sessionId,
        evaluations: completeEvaluations,
      },
      null,
      2
    );
    const compactPayload = JSON.stringify({
      savedAt: Date.now(),
      sessionId: session.sessionId,
      evaluations: sessionEvaluations,
    });
    this.enqueue(session, async () => {
      await this.writeText(
        session,
        "human-evaluation/critical-moment-evaluations.json",
        payload
      );
      await this.writeText(
        session,
        "human-evaluation/critical-moment-evaluations.jsonl",
        `${compactPayload}\n`,
        true
      );
    });
    this.recordEvent(
      "critical-moment-evaluation",
      {
        evaluationCount: completeEvaluations.length,
        criticalCount: completeEvaluations.filter(
          (evaluation) => evaluation.eligibility === "critical"
        ).length,
      },
      ["human-evaluation/critical-moment-evaluations.json"]
    );
  }

  recordRuntimeBoundary(
    kind: "runtime-reset" | "runtime-continued",
    metadata?: Record<string, unknown>
  ) {
    if (!this.getWritableSession()) return;
    this.recordEvent(kind, metadata);
  }

  recordPreparationRuntimeContext(
    context: PreparationRuntimeProvenanceSnapshot
  ) {
    const session = this.getWritableSession();
    if (!session) return;
    const key = `${context.meetingSessionId}:${context.preparationContextRevision}`;
    if (session.preparationRuntimeContexts.has(key)) return;
    const snapshot = structuredClone(context);
    session.preparationRuntimeContexts.set(key, snapshot);
    const contextPath = `preparation/runtime-contexts/${encodeURIComponent(
      context.meetingSessionId
    )}-r${context.preparationContextRevision}.json`;
    const latestPath = "preparation/runtime-context.latest.json";
    const manifestPath = context.pinnedSnapshot
      ? `preparation/snapshot-manifests/${encodeURIComponent(
          context.pinnedSnapshot.snapshotId
        )}-v${context.pinnedSnapshot.version}.json`
      : undefined;
    this.enqueue(session, async () => {
      await this.writeJson(session, contextPath, snapshot);
      await this.writeJson(session, latestPath, snapshot);
      if (manifestPath && context.pinnedSnapshot) {
        await this.writeJson(session, manifestPath, {
          recordedAt: Date.now(),
          meetingSessionId: context.meetingSessionId,
          preparationContextRevision:
            context.preparationContextRevision,
          selectionRevision: context.selectionRevision,
          snapshotId: context.pinnedSnapshot.snapshotId,
          snapshotVersion: context.pinnedSnapshot.version,
          snapshotContentHash: context.pinnedSnapshot.contentHash,
          artifactManifest:
            context.pinnedSnapshot.artifactManifest,
        });
      }
    });
    this.recordEvent(
      "preparation-runtime-context",
      {
        meetingSessionId: context.meetingSessionId,
        preparationContextRevision:
          context.preparationContextRevision,
        selectionRevision: context.selectionRevision,
        mode: context.mode,
        loadState: context.loadState,
        snapshotId: context.pinnedSnapshot?.snapshotId,
        snapshotVersion: context.pinnedSnapshot?.version,
        snapshotContentHash:
          context.pinnedSnapshot?.contentHash,
        artifactCount:
          context.pinnedSnapshot?.artifactManifest.artifacts.length ?? 0,
        projectionCount: context.projectionCatalog.length,
        runtimeReinforcementEnabled:
          context.capabilities.runtimeReinforcement.enabled,
        personalizedGuidanceEnabled:
          context.capabilities.personalizedGuidance.enabled,
      },
      [contextPath, latestPath, ...(manifestPath ? [manifestPath] : [])]
    );
  }

  recordPreparationArtifactUse(
    receipts: PreparationArtifactUseReceipt[]
  ) {
    const session = this.getWritableSession({
      traceId: receipts[0]?.traceId,
    });
    if (!session || receipts.length === 0) return;
    const untraceableReceipts = receipts.filter(
      (receipt) => !isTraceablePreparationArtifactUse(session, receipt)
    );
    if (untraceableReceipts.length > 0) {
      session.untraceablePreparationArtifactUseCount +=
        untraceableReceipts.length;
      this.recordEvent(
        "error",
        {
          scope: "preparation-artifact-use",
          reason: "untraceable-artifact-use",
          rejectedReceiptIds: untraceableReceipts.map(
            (receipt) => receipt.receiptId
          ),
        },
        [],
        receipts[0]?.traceId
      );
      throw new Error(
        "Preparation artifact use is not authorized by the recorded snapshot manifest."
      );
    }
    for (const receipt of receipts) {
      session.preparationArtifactUseReceipts.set(
        receipt.receiptId,
        structuredClone(receipt)
      );
    }
    const artifactPath = "preparation/artifact-use-receipts.jsonl";
    const indexPath = "preparation/answer-attribution-index.json";
    this.enqueue(session, async () => {
      await this.writeText(
        session,
        artifactPath,
        receipts.map((receipt) => JSON.stringify(receipt)).join("\n") + "\n",
        true
      );
      await this.writeJson(
        session,
        indexPath,
        buildPreparationAnswerAttributionIndex(
          Array.from(session.preparationArtifactUseReceipts.values())
        )
      );
    });
    for (const receipt of receipts) {
      this.recordEvent(
        "preparation-artifact-use",
        {
          receiptId: receipt.receiptId,
          meetingSessionId: receipt.meetingSessionId,
          preparationContextRevision:
            receipt.preparationContextRevision,
          snapshotId: receipt.snapshotId,
          snapshotVersion: receipt.snapshotVersion,
          artifactId: receipt.artifactId,
          lineageKey: receipt.lineageKey,
          consumer: receipt.consumer,
          targetKind: receipt.targetKind,
          targetId: receipt.targetId,
          questionId: receipt.questionId,
          answerRevision: receipt.answerRevision,
          generationLeaseId: receipt.generationLeaseId,
        },
        [artifactPath, indexPath],
        receipt.traceId
      );
    }
  }

  recordPreparationArtifactEvaluation(
    evaluation: PreparationArtifactEvaluation
  ) {
    const session = this.getWritableSession({
      traceId: evaluation.traceId,
    });
    if (!session) return;
    const receipt = session.preparationArtifactUseReceipts.get(
      evaluation.receiptId
    );
    if (
      !receipt ||
      receipt.snapshotId !== evaluation.snapshotId ||
      receipt.artifactId !== evaluation.artifactId ||
      receipt.lineageKey !== evaluation.lineageKey ||
      receipt.traceId !== evaluation.traceId ||
      receipt.questionId !== evaluation.questionId ||
      receipt.answerRevision !== evaluation.answerRevision ||
      receipt.consumer !== evaluation.consumer
    ) {
      throw new Error(
        "Preparation artifact feedback requires a matching recorded use receipt."
      );
    }
    session.preparationArtifactEvaluations.set(
      evaluation.receiptId,
      structuredClone(evaluation)
    );
    const artifactPath =
      "human-evaluation/preparation-artifact-evaluations.json";
    this.enqueue(session, () =>
      this.writeJson(
        session,
        artifactPath,
        Array.from(session.preparationArtifactEvaluations.values())
      )
    );
    this.recordEvent(
      "preparation-artifact-evaluation",
      {
        evaluationId: evaluation.evaluationId,
        receiptId: evaluation.receiptId,
        snapshotId: evaluation.snapshotId,
        artifactId: evaluation.artifactId,
        lineageKey: evaluation.lineageKey,
        consumer: evaluation.consumer,
        label: evaluation.label,
        questionId: evaluation.questionId,
        answerRevision: evaluation.answerRevision,
      },
      [artifactPath],
      evaluation.traceId
    );
  }

  recordSemanticTaxonomyDecision({
    traceId,
    taskId,
    metadata,
  }: {
    traceId: string;
    taskId?: string;
    metadata: Record<string, unknown>;
  }) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;
    const artifactPath = "taxonomy/semantic-decisions.jsonl";
    const payload = {
      recordedAt: Date.now(),
      sessionId: session.sessionId,
      traceId,
      taskId,
      metadata,
    };
    this.enqueue(session, () =>
      this.writeText(
        session,
        artifactPath,
        `${JSON.stringify(payload)}\n`,
        true
      )
    );
    this.recordEvent(
      "semantic-taxonomy-decision",
      metadata,
      [artifactPath],
      traceId,
      taskId
    );

    const existing = session.traceSummaries.get(traceId);
    if (!existing) return;
    const updated: SessionCompactTraceSummary = {
      ...existing,
      semanticTaxonomy: buildSemanticTaxonomyTraceSummary([metadata]),
    };
    session.traceSummaries.set(traceId, updated);
    this.enqueue(session, async () => {
      await this.writeJson(
        session,
        `traces/${sanitizeFilePart(traceId)}/summary.json`,
        updated
      );
      await this.writeJson(session, "metrics/trace-summaries.latest.json", {
        version: SESSION_TRACE_SUMMARY_SCHEMA_VERSION,
        savedAt: Date.now(),
        sessionId: session.sessionId,
        traces: Array.from(session.traceSummaries.values()).sort(
          (left, right) => left.startedAt - right.startedAt
        ),
      });
    });
  }

  recordSemanticEmbeddingRuntimeEvent({
    traceId,
    taskId,
    metadata,
  }: {
    traceId: string;
    taskId?: string;
    metadata: Record<string, unknown>;
  }) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;
    const artifactPath = "semantic/runtime-events.jsonl";
    const payload = {
      recordedAt: Date.now(),
      sessionId: session.sessionId,
      traceId,
      taskId,
      metadata,
    };
    this.enqueue(session, () =>
      this.writeText(
        session,
        artifactPath,
        `${JSON.stringify(payload)}\n`,
        true
      )
    );
    this.recordEvent(
      "semantic-embedding-runtime",
      metadata,
      [artifactPath],
      traceId,
      taskId
    );

    const existing = session.traceSummaries.get(traceId);
    if (!existing) return;
    const updated: SessionCompactTraceSummary = {
      ...existing,
      semanticEmbeddingRuntime:
        buildSemanticEmbeddingRuntimeTraceSummary([metadata]),
    };
    session.traceSummaries.set(traceId, updated);
    this.enqueue(session, async () => {
      await this.writeJson(
        session,
        `traces/${sanitizeFilePart(traceId)}/summary.json`,
        updated
      );
      await this.writeJson(session, "metrics/trace-summaries.latest.json", {
        version: SESSION_TRACE_SUMMARY_SCHEMA_VERSION,
        savedAt: Date.now(),
        sessionId: session.sessionId,
        traces: Array.from(session.traceSummaries.values()).sort(
          (left, right) => left.startedAt - right.startedAt
        ),
      });
    });
  }

  recordInterviewerIntentSemanticDecision({
    traceId,
    taskId,
    metadata,
  }: {
    traceId: string;
    taskId?: string;
    metadata: Record<string, unknown>;
  }) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;
    const artifactPath = "intent/semantic-shadow.jsonl";
    const payload = {
      recordedAt: Date.now(),
      sessionId: session.sessionId,
      traceId,
      taskId,
      metadata,
    };
    this.enqueue(session, () =>
      this.writeText(
        session,
        artifactPath,
        `${JSON.stringify(payload)}\n`,
        true
      )
    );
    this.recordEvent(
      "interviewer-intent-semantic-decision",
      metadata,
      [artifactPath],
      traceId,
      taskId
    );

    const existing = session.traceSummaries.get(traceId);
    if (!existing) return;
    const updated: SessionCompactTraceSummary = {
      ...existing,
      interviewerIntentSemantic:
        buildInterviewerIntentSemanticTraceSummary([metadata]),
    };
    session.traceSummaries.set(traceId, updated);
    this.enqueue(session, async () => {
      await this.writeJson(
        session,
        `traces/${sanitizeFilePart(traceId)}/summary.json`,
        updated
      );
      await this.writeJson(session, "metrics/trace-summaries.latest.json", {
        version: SESSION_TRACE_SUMMARY_SCHEMA_VERSION,
        savedAt: Date.now(),
        sessionId: session.sessionId,
        traces: Array.from(session.traceSummaries.values()).sort(
          (left, right) => left.startedAt - right.startedAt
        ),
      });
    });
  }

  recordTaxonomyAdjudicationDecision({
    traceId,
    taskId,
    metadata,
  }: {
    traceId: string;
    taskId?: string;
    metadata: Record<string, unknown>;
  }) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;
    const artifactPaths = [
      "taxonomy/llm-adjudications.jsonl",
      "intent/llm-adjudications.jsonl",
    ];
    const payload = {
      recordedAt: Date.now(),
      sessionId: session.sessionId,
      traceId,
      taskId,
      metadata,
    };
    for (const artifactPath of artifactPaths) {
      this.enqueue(session, () =>
        this.writeText(
          session,
          artifactPath,
          `${JSON.stringify(payload)}\n`,
          true
        )
      );
    }
    this.recordEvent(
      "taxonomy-adjudication-decision",
      metadata,
      artifactPaths,
      traceId,
      taskId
    );
    this.recordEvent(
      "interviewer-intent-llm-decision",
      metadata,
      artifactPaths,
      traceId,
      taskId
    );

    const existing = session.traceSummaries.get(traceId);
    if (!existing) return;
    const updated: SessionCompactTraceSummary = {
      ...existing,
      taxonomyAdjudication: buildTaxonomyAdjudicationTraceSummary([metadata]),
      interviewerIntentLlm:
        buildInterviewerIntentLlmTraceSummary([metadata]),
      currentQuestionTerminalNoAnswer:
        buildCurrentQuestionTerminalNoAnswerTraceSummary([metadata]),
    };
    session.traceSummaries.set(traceId, updated);
    this.enqueue(session, async () => {
      await this.writeJson(
        session,
        `traces/${sanitizeFilePart(traceId)}/summary.json`,
        updated
      );
      await this.writeJson(session, "metrics/trace-summaries.latest.json", {
        version: SESSION_TRACE_SUMMARY_SCHEMA_VERSION,
        savedAt: Date.now(),
        sessionId: session.sessionId,
        traces: Array.from(session.traceSummaries.values()).sort(
          (left, right) => left.startedAt - right.startedAt
        ),
      });
    });
  }

  recordQuestionTypeAdjudicationDecision({
    traceId,
    taskId,
    metadata,
  }: {
    traceId: string;
    taskId?: string;
    metadata: Record<string, unknown>;
  }) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;
    const artifactPath =
      "taxonomy/question-type-adjudications.jsonl";
    const payload = {
      recordedAt: Date.now(),
      sessionId: session.sessionId,
      traceId,
      taskId,
      metadata,
    };
    this.enqueue(session, () =>
      this.writeText(
        session,
        artifactPath,
        `${JSON.stringify(payload)}\n`,
        true
      )
    );
    this.recordEvent(
      "question-type-adjudication-decision",
      metadata,
      [artifactPath],
      traceId,
      taskId
    );
  }

  recordQuestionTypeAdjudicationOutcome(
    outcome: QuestionTypeAdjudicationOutcomeEvent
  ) {
    const session = this.getWritableSession({ traceId: outcome.traceId });
    if (!session) return;
    const artifactPath =
      "taxonomy/question-type-adjudication-outcomes.jsonl";
    this.enqueue(session, () =>
      this.writeText(
        session,
        artifactPath,
        `${JSON.stringify(outcome)}\n`,
        true
      )
    );
    this.recordEvent(
      "question-type-adjudication-outcome",
      formatQuestionTypeAdjudicationOutcomeForTrace(outcome),
      [artifactPath],
      outcome.traceId,
      outcome.taskId
    );
  }

  recordTaskRelationAdjudicationDecision({
    traceId,
    taskId,
    metadata,
  }: {
    traceId: string;
    taskId?: string;
    metadata: Record<string, unknown>;
  }) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;
    const artifactPath =
      "runtime-inference/task-relation-decisions.jsonl";
    const payload = {
      recordedAt: Date.now(),
      sessionId: session.sessionId,
      traceId,
      taskId,
      metadata,
    };
    this.enqueue(session, () =>
      this.writeText(
        session,
        artifactPath,
        `${JSON.stringify(payload)}\n`,
        true
      )
    );
    this.recordEvent(
      "task-relation-adjudication-decision",
      metadata,
      [artifactPath],
      traceId,
      taskId
    );
  }

  recordAnswerSufficiencyDecision({
    traceId,
    taskId,
    decision,
  }: {
    traceId: string;
    taskId?: string;
    decision: AnswerSufficiencyDecision;
  }) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;
    const artifactPath = "answer-sufficiency/decisions.jsonl";
    const metadata = {
      answerSufficiencyOperationId: decision.operationId,
      answerSufficiencyDetectorVersion: decision.detectorVersion,
      answerSufficiencyStatus: decision.answerStatus,
      answerContextDefect: decision.contextDefect,
      answerRepairRecommendation: decision.recommendedRepair,
      answerSufficiencyConfidence: decision.confidence,
      answerSufficiencyLexicalEvidence: decision.lexicalEvidence,
      answerSufficiencySemanticPrototypeIds:
        decision.semanticPrototypeIds,
      answerSufficiencySemanticStatus: decision.semanticStatus,
      answerSufficiencySemanticConfidence:
        decision.semanticConfidence,
      answerSufficiencySemanticMargin: decision.semanticMargin,
      answerSufficiencySemanticDurationMs:
        decision.semanticDurationMs,
      answerSufficiencySemanticDisposition:
        decision.semanticDisposition,
      answerSufficiencySemanticRejectionReasons:
        decision.semanticRejectionReasons,
      answerExpectedArtifacts: decision.expectedArtifactKinds,
      answerMissingArtifacts: decision.missingArtifactKinds,
      answerSufficiencyLogicalQuestionUnitId:
        decision.logicalQuestionUnitId,
      answerSufficiencyLogicalQuestionUnitRevision:
        decision.logicalQuestionUnitRevision,
      answerSufficiencyAnswerRevision: decision.answerRevision,
      contextResolvable: decision.resolvableByNearbyContext,
      contextCandidateKinds: decision.candidateContextKinds,
      contextCandidateSourceTurnIds:
        decision.candidateSourceTurnIds,
      contextDeltaChars: decision.contextDeltaChars,
    };
    const payload = {
      recordedAt: Date.now(),
      sessionId: session.sessionId,
      traceId,
      taskId,
      decision,
    };
    this.enqueue(session, () =>
      this.writeText(
        session,
        artifactPath,
        `${JSON.stringify(payload)}\n`,
        true
      )
    );
    this.recordEvent(
      "answer-sufficiency-decision",
      metadata,
      [artifactPath],
      traceId,
      taskId
    );

    const existing = session.traceSummaries.get(traceId);
    if (!existing) return;
    const updated: SessionCompactTraceSummary = {
      ...existing,
      answerSufficiency: buildAnswerSufficiencyTraceSummary([
        metadata,
      ]),
    };
    session.traceSummaries.set(traceId, updated);
    this.enqueue(session, async () => {
      await this.writeJson(
        session,
        `traces/${sanitizeFilePart(traceId)}/summary.json`,
        updated
      );
      await this.writeJson(session, "metrics/trace-summaries.latest.json", {
        version: SESSION_TRACE_SUMMARY_SCHEMA_VERSION,
        savedAt: Date.now(),
        sessionId: session.sessionId,
        traces: Array.from(session.traceSummaries.values()).sort(
          (left, right) => left.startedAt - right.startedAt
        ),
      });
    });
  }

  recordAdvisorResponseFingerprint({
    traceId,
    taskId,
    fingerprint,
  }: {
    traceId?: string;
    taskId?: string;
    fingerprint: AdvisorResponseFingerprint;
  }) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;
    const artifactPath = "advisor-response/fingerprints.jsonl";
    const metadata = formatAdvisorResponseFingerprintForTrace(fingerprint);
    const payload = {
      recordedAt: Date.now(),
      sessionId: session.sessionId,
      traceId,
      taskId,
      fingerprint,
    };
    this.enqueue(session, () =>
      this.writeText(
        session,
        artifactPath,
        `${JSON.stringify(payload)}\n`,
        true
      )
    );
    this.recordEvent(
      "advisor-response-fingerprint",
      metadata,
      [artifactPath],
      traceId,
      taskId
    );
  }

  recordAdvisorResponseConsistency({
    traceId,
    taskId,
    observation,
  }: {
    traceId?: string;
    taskId?: string;
    observation: AdvisorResponseConsistencyObservation;
  }) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;
    const artifactPath = "advisor-response/consistency-shadow.jsonl";
    const metadata = formatAdvisorResponseConsistencyForTrace(observation);
    const payload = {
      recordedAt: Date.now(),
      sessionId: session.sessionId,
      traceId,
      taskId,
      observation,
    };
    this.enqueue(session, () =>
      this.writeText(
        session,
        artifactPath,
        `${JSON.stringify(payload)}\n`,
        true
      )
    );
    this.recordEvent(
      "advisor-response-consistency-shadow",
      metadata,
      [artifactPath],
      traceId,
      taskId
    );
  }

  recordAdvisorHypothesisChallenge({
    traceId,
    taskId,
    challenge,
  }: {
    traceId?: string;
    taskId?: string;
    challenge: AdvisorHypothesisChallenge;
  }) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;
    const artifactPath = "advisor-response/hypothesis-challenges.jsonl";
    const metadata = formatAdvisorHypothesisChallengeForTrace(challenge);
    const payload = {
      recordedAt: Date.now(),
      sessionId: session.sessionId,
      traceId,
      taskId,
      challenge,
    };
    this.enqueue(session, () =>
      this.writeText(
        session,
        artifactPath,
        `${JSON.stringify(payload)}\n`,
        true
      )
    );
    this.recordEvent(
      "advisor-hypothesis-challenge",
      metadata,
      [artifactPath],
      traceId,
      taskId
    );
  }

  recordCurrentQuestionSettlement({
    traceId,
    taskId,
    currentQuestion,
    settlement,
    disposition,
    durationMs,
    llmWaitMs = 0,
    llmWaitDisposition = "not-awaited",
    parentBeforeId,
    parentBeforeType,
    parentAfterId,
    parentAfterType,
  }: {
    traceId: string;
    taskId?: string;
    currentQuestion: ProvisionalCurrentQuestion;
    settlement: CurrentQuestionSettlementDecision;
    disposition: CurrentQuestionSettlementDisposition;
    durationMs?: number;
    llmWaitMs?: number;
    llmWaitDisposition?: string;
    parentBeforeId?: string;
    parentBeforeType?: string;
    parentAfterId?: string;
    parentAfterType?: string;
  }) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;
    const artifactPath = `traces/${sanitizeFilePart(
      traceId
    )}/current-question-settlement.json`;
    const metadata = {
      ...formatCurrentQuestionSettlementForTrace(settlement),
      currentQuestionSettlementDisposition: disposition,
      currentQuestionSettlementSourceTurnIds:
        currentQuestion.sourceTurnIds,
      currentQuestionSettlementSourceObservationIds:
        currentQuestion.sourceObservationIds,
      currentQuestionSettlementDurationMs: durationMs,
      currentQuestionSettlementLlmWaitMs: llmWaitMs,
      currentQuestionSettlementLlmWaitDisposition:
        llmWaitDisposition,
      currentQuestionSettlementParentBeforeId: parentBeforeId,
      currentQuestionSettlementParentBeforeType: parentBeforeType,
      currentQuestionSettlementParentAfterId: parentAfterId,
      currentQuestionSettlementParentAfterType: parentAfterType,
    };
    const payload = {
      version: 1,
      recordedAt: Date.now(),
      sessionId: session.sessionId,
      traceId,
      taskId,
      currentQuestion: {
        logicalQuestionUnitId:
          currentQuestion.logicalQuestionUnitId,
        revision: currentQuestion.revision,
        sessionId: currentQuestion.sessionId,
        runtimeEpoch: currentQuestion.runtimeEpoch,
        normalizedText: currentQuestion.normalizedText,
        sourceTurnIds: currentQuestion.sourceTurnIds,
        sourceObservationIds:
          currentQuestion.sourceObservationIds,
        sourceKind: currentQuestion.sourceKind,
        sourceHash: currentQuestion.sourceHash,
      },
      settlement,
      disposition,
      durationMs,
      llmWaitMs,
      llmWaitDisposition,
      parentBefore: {
        id: parentBeforeId,
        questionType: parentBeforeType,
      },
      parentAfter: {
        id: parentAfterId,
        questionType: parentAfterType,
      },
    };
    this.enqueue(session, () =>
      this.writeJson(session, artifactPath, payload)
    );
    this.recordEvent(
      "current-question-settlement",
      metadata,
      [artifactPath],
      traceId,
      taskId
    );
  }

  recordSettledAdvisorExecutionPlan({
    traceId,
    taskId,
    plan,
    authorization,
    authorizationStage = "plan-created",
  }: {
    traceId: string;
    taskId?: string;
    plan: SettledAdvisorExecutionPlan;
    authorization?: SettledAdvisorExecutionPlanAuthorization;
    authorizationStage?: string;
  }) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;
    const artifactPath = `traces/${sanitizeFilePart(
      traceId
    )}/settled-advisor-execution-plan.json`;
    const metadata = {
      ...formatSettledAdvisorExecutionPlanForTrace(
        plan,
        authorization
      ),
      settledExecutionPlanAuthorizationStage:
        authorizationStage,
    };
    const payload = {
      version: 1,
      recordedAt: Date.now(),
      sessionId: session.sessionId,
      traceId,
      taskId,
      plan: metadata,
    };
    this.enqueue(session, () =>
      this.writeJson(session, artifactPath, payload)
    );
    this.recordEvent(
      "settled-advisor-execution-plan",
      metadata,
      [artifactPath],
      traceId,
      taskId
    );
  }

  recordResponseOnlyTaskScope({
    traceId,
    scope,
  }: {
    traceId: string;
    scope: ResponseOnlyTaskScope;
  }) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;
    const artifactPath = "tasks/response-only-scopes.jsonl";
    const metadata = formatResponseOnlyTaskScopeForTrace(scope);
    const payload = {
      version: 1,
      recordedAt: Date.now(),
      sessionId: session.sessionId,
      traceId,
      scope,
    };
    this.enqueue(session, () =>
      this.appendJsonl(session, artifactPath, payload)
    );
    this.recordEvent(
      "response-only-task-scope",
      metadata,
      [artifactPath],
      traceId,
      scope.preservedParentId
    );
  }

  recordWhiteboardRenderValidation({
    traceId,
    taskId,
    metadata,
    candidateContent,
  }: {
    traceId: string;
    taskId?: string;
    metadata: Record<string, unknown>;
    candidateContent?: string;
  }) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;
    const artifactPath = "whiteboard/render-validations.jsonl";
    const sourceQuestionId = readString(
      metadata.questionInstanceId ??
        metadata.logicalQuestionUnitId ??
        metadata.currentQuestionSettlementId
    );
    const recordedMetadata = {
      ...metadata,
      whiteboardSourceQuestionId: sourceQuestionId,
    };
    const payload = {
      version: 1,
      recordedAt: Date.now(),
      sessionId: session.sessionId,
      traceId,
      taskId,
      sourceQuestionId,
      metadata: recordedMetadata,
      candidateContent,
    };
    this.enqueue(session, () =>
      this.appendJsonl(session, artifactPath, payload)
    );
    this.recordEvent(
      "whiteboard-render-validation",
      recordedMetadata,
      [artifactPath],
      traceId,
      taskId
    );
  }

  recordWhiteboardRenderRecovery({
    traceId,
    taskId,
    metadata,
    candidateContent,
    repairedMermaid,
    asciiFallback,
  }: {
    traceId: string;
    taskId?: string;
    metadata: Record<string, unknown>;
    candidateContent?: string;
    repairedMermaid?: string;
    asciiFallback?: string;
  }) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;
    const artifactPath = "whiteboard/render-recoveries.jsonl";
    const sourceQuestionId = readString(
      metadata.questionInstanceId ??
        metadata.logicalQuestionUnitId ??
        metadata.currentQuestionSettlementId
    );
    const recordedMetadata = {
      ...metadata,
      whiteboardSourceQuestionId: sourceQuestionId,
    };
    const payload = {
      version: 1,
      recordedAt: Date.now(),
      sessionId: session.sessionId,
      traceId,
      taskId,
      sourceQuestionId,
      metadata: recordedMetadata,
      candidateContent,
      repairedMermaid,
      asciiFallback,
    };
    this.enqueue(session, () =>
      this.appendJsonl(session, artifactPath, payload)
    );
    this.recordEvent(
      "whiteboard-render-recovery",
      recordedMetadata,
      [artifactPath],
      traceId,
      taskId
    );
  }

  recordCaptureLifecycle(metadata: Record<string, unknown>) {
    if (!this.getWritableSession()) return;
    this.recordEvent("capture-lifecycle", metadata);
  }

  recordNativeSpeechEvent(metadata: Record<string, unknown>) {
    if (!this.getWritableSession()) return;
    const { audioBase64: _audioBase64, base64Audio: _base64Audio, ...safe } =
      metadata;
    this.recordEvent("native-speech-event", safe);
  }

  recordAudioSegmentDisposition({
    traceId,
    metadata,
  }: {
    traceId?: string;
    metadata: Record<string, unknown>;
  }) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;
    const { audioBase64: _audioBase64, base64Audio: _base64Audio, ...safe } =
      metadata;
    const artifactPath = "audio/segment-dispositions.jsonl";
    const payload = {
      version: 1,
      recordedAt: Date.now(),
      sessionId: session.sessionId,
      traceId,
      ...safe,
    };
    this.enqueue(session, () =>
      this.writeText(
        session,
        artifactPath,
        `${JSON.stringify(payload)}\n`,
        true
      )
    );
    this.recordEvent(
      "audio-segment-disposition",
      safe,
      [artifactPath],
      traceId
    );
  }

  recordAudioInputLiveness(metadata: Record<string, unknown>) {
    const session = this.getWritableSession();
    if (!session) return;
    const { audioBase64: _audioBase64, base64Audio: _base64Audio, ...safe } =
      metadata;
    this.recordEvent("native-audio-liveness", {
      ...safe,
      artifactPath: "audio/input-liveness.jsonl",
    });
    this.enqueue(session, () =>
      this.writeText(
        session,
        "audio/input-liveness.jsonl",
        `${JSON.stringify({
          version: 1,
          recordedAt: Date.now(),
          sessionId: session.sessionId,
          ...safe,
        })}\n`,
        true
      )
    );
  }

  recordError(error: unknown, metadata?: Record<string, unknown>) {
    const message = error instanceof Error ? error.message : String(error);
    this.setError(message);
    this.recordEvent("error", { message, metadata });
  }

  private recordEvent(
    kind: SessionRecordingEvent["kind"],
    metadata?: Record<string, unknown>,
    artifactRefs?: string[],
    traceId?: string,
    taskId?: string
  ) {
    const session = this.getWritableSession({ traceId });
    if (!session) return;
    if (traceId) {
      this.recordTraceSessionIndex({
        traceId,
        taskIds: collectTaskIdsFromMetadata(metadata, taskId),
        source: kind,
      });
    }

    const event: SessionRecordingEvent = {
      id: createMeetingId("session_event"),
      sessionId: session.sessionId,
      traceId,
      taskId,
      kind,
      createdAt: Date.now(),
      source: "meeting-assistant",
      metadata,
      artifactRefs,
    };

    session.eventCount += 1;
    if (artifactRefs?.length) session.artifactCount += artifactRefs.length;
    this.emit();
    this.enqueue(session, () =>
      this.writeText(
        session,
        "timeline.jsonl",
        `${JSON.stringify(event)}\n`,
        true
      )
    );
  }

  private recordTraceSessionIndex({
    traceId,
    taskIds = [],
    source,
    trace,
  }: {
    traceId: string;
    taskIds?: string[];
    source: string;
    trace?: MeetingTrace;
  }) {
    const session = this.getWritableSession({
      traceId,
      startedAt: trace?.startedAt,
    });
    if (!session) return;

    const now = Date.now();
    const existing = session.traceSessionIndex.get(traceId);
    const nextTaskIds = uniqueStrings([
      ...(existing?.taskIds ?? []),
      ...taskIds,
      ...collectTaskIdsFromTrace(trace),
    ]);
    const nextSources = uniqueStrings([...(existing?.sources ?? []), source]);
    const changed =
      !existing ||
      !sameStringList(existing.taskIds, nextTaskIds) ||
      !sameStringList(existing.sources, nextSources) ||
      existing.traceKind !== (trace?.kind ?? existing.traceKind) ||
      existing.traceStatus !== (trace?.status ?? existing.traceStatus) ||
      existing.traceStartedAt !== (trace?.startedAt ?? existing.traceStartedAt) ||
      existing.traceEndedAt !== (trace?.endedAt ?? existing.traceEndedAt) ||
      existing.traceDurationMs !== (trace?.durationMs ?? existing.traceDurationMs);
    if (!changed) return;

    const nextEntry: SessionTraceIndexEntry = {
      version: SESSION_TRACE_INDEX_SCHEMA_VERSION,
      sessionId: session.sessionId,
      traceId,
      taskIds: nextTaskIds,
      sources: nextSources,
      firstSeenAt: existing?.firstSeenAt ?? now,
      updatedAt: now,
      traceKind: trace?.kind ?? existing?.traceKind,
      traceStatus: trace?.status ?? existing?.traceStatus,
      traceStartedAt: trace?.startedAt ?? existing?.traceStartedAt,
      traceEndedAt: trace?.endedAt ?? existing?.traceEndedAt,
      traceDurationMs: trace?.durationMs ?? existing?.traceDurationMs,
    };

    session.traceSessionIndex.set(traceId, nextEntry);
    for (const taskId of nextTaskIds) {
      session.recordedTaskIds.add(taskId);
    }

    this.enqueue(session, async () => {
      await this.writeText(
        session,
        "metrics/trace-session-index.jsonl",
        `${JSON.stringify(nextEntry)}\n`,
        true
      );
      await this.writeJson(session, "metrics/trace-session-index.latest.json", {
        version: SESSION_TRACE_INDEX_SCHEMA_VERSION,
        savedAt: Date.now(),
        sessionId: session.sessionId,
        traces: Array.from(session.traceSessionIndex.values()),
      });
    });
  }

  private recordCompactTraceSummary(
    trace: MeetingTrace,
    trigger: MeetingTraceExportTrigger,
    traceExportPath: string
  ) {
    const session = this.getWritableSession({
      traceId: trace.id,
      startedAt: trace.startedAt,
    });
    if (!session) return;

    const summaryPath = `traces/${sanitizeFilePart(trace.id)}/summary.json`;
    const existing = session.traceSummaries.get(trace.id);
    const summary = buildCompactTraceSummary({
      sessionId: session.sessionId,
      trace,
      trigger,
      traceExportPath,
      summaryPath,
      indexEntry: session.traceSessionIndex.get(trace.id),
    });
    session.traceSummaries.set(trace.id, summary);

    const summaries = Array.from(session.traceSummaries.values()).sort(
      (left, right) => left.startedAt - right.startedAt
    );
    const sessionSummary = buildSessionMetricsSummary(
      session.sessionId,
      summaries,
      Array.from(session.traceHumanEvaluations.values())
    );
    const evaluationView = projectHumanEvaluationsForLegacyConsumers({
      evaluations: Array.from(session.questionHumanEvaluations.values()),
      projections: Array.from(
        session.humanEvaluationProjectionsV2.values()
      ),
    });
    const reviewIndex = buildSessionTaskReviewIndex(
      session.sessionId,
      summaries,
      evaluationView.evaluations
    );

    this.enqueue(session, async () => {
      if (!existing) {
        await this.writeText(
          session,
          "metrics/trace-summaries.jsonl",
          `${JSON.stringify(summary)}\n`,
          true
        );
      }
      await this.writeJson(session, "metrics/trace-summaries.latest.json", {
        version: SESSION_TRACE_SUMMARY_SCHEMA_VERSION,
        savedAt: Date.now(),
        sessionId: session.sessionId,
        traces: summaries,
      });
      await this.writeJson(session, summaryPath, summary);
      await this.writeJson(
        session,
        "metrics/session-summary.json",
        sessionSummary
      );
      await this.writeJson(
        session,
        "human-evaluation/compatibility-v2.json",
        evaluationView.report
      );
      await this.writeTaskReviewIndex(session, reviewIndex);
    });
  }

  private async writeJson(
    session: ActiveSessionRecording,
    relativePath: string,
    value: unknown
  ) {
    await this.writeText(
      session,
      relativePath,
      JSON.stringify(value, null, 2)
    );
  }

  private async writeTaskReviewIndex(
    session: ActiveSessionRecording,
    index: SessionTaskReviewIndex
  ) {
    await this.writeJson(session, "tasks/review-index.latest.json", index);
    for (const task of index.tasks) {
      await this.writeJson(session, task.artifacts.reviewSummaryPath, task);
    }
  }

  private async appendJsonl(
    session: ActiveSessionRecording,
    relativePath: string,
    value: unknown
  ) {
    await this.writeText(
      session,
      relativePath,
      `${JSON.stringify(value)}\n`,
      true
    );
  }

  private async writeText(
    session: ActiveSessionRecording,
    relativePath: string,
    payload: string,
    append = false
  ) {
    try {
      await this.invokeCommand<string>("write_meeting_session_recording_text", {
        folderName: session.folderName,
        relativePath,
        payload,
        append,
      });
    } catch (error) {
      throw new SessionRecordingWriteError("text", relativePath, error);
    }
  }

  private async writeBase64(
    session: ActiveSessionRecording,
    relativePath: string,
    base64Payload: string
  ) {
    try {
      await this.invokeCommand<string>("write_meeting_session_recording_base64", {
        folderName: session.folderName,
        relativePath,
        base64Payload,
      });
    } catch (error) {
      throw new SessionRecordingWriteError("base64", relativePath, error);
    }
  }

  private enqueue(
    session: ActiveSessionRecording,
    write: () => Promise<void>
  ) {
    if (session.phase === "sealed") {
      session.rejectedLateWrites += 1;
      return false;
    }

    session.enqueueVersion += 1;
    session.pendingWrites += 1;
    session.acceptedWrites += 1;
    session.writeQueue = session.writeQueue
      .then(write)
      .catch((error) => {
        this.recordWriteFailure(session, error);
      })
      .finally(() => {
        session.pendingWrites -= 1;
      });
    return true;
  }

  private async tryFinalizationWrite(
    session: ActiveSessionRecording,
    write: () => Promise<void>
  ) {
    try {
      await write();
      return true;
    } catch (error) {
      this.recordWriteFailure(session, error);
      return false;
    }
  }

  private recordWriteFailure(
    session: ActiveSessionRecording,
    error: unknown
  ) {
    const message = error instanceof Error ? error.message : String(error);
    session.failedWriteCount += 1;
    if (session.failedWrites.length < MAX_RECORDED_WRITE_FAILURES) {
      session.failedWrites.push({
        sequence: session.failedWriteCount,
        occurredAt: Date.now(),
        phase: session.phase,
        operation:
          error instanceof SessionRecordingWriteError
            ? error.operation
            : "unknown",
        relativePath:
          error instanceof SessionRecordingWriteError
            ? error.relativePath
            : undefined,
        message,
      });
    }
    this.setSessionError(session, message);
  }

  private setError(message: string) {
    if (this.activeSession) {
      this.setSessionError(this.activeSession, message);
      return;
    }
    this.lastError = message;
    this.emit();
  }

  private setSessionError(session: ActiveSessionRecording, message: string) {
    session.lastError = message;
    this.lastError = message;
    this.emit();
  }

  private getWritableSession({
    traceId,
    startedAt,
  }: {
    traceId?: string;
    startedAt?: number;
  } = {}) {
    const session = this.activeSession;
    if (!session) return undefined;
    const traceOwner = traceId
      ? this.traceGenerationOwners.get(traceId)
      : undefined;
    if (
      session.phase === "sealed" ||
      (typeof startedAt === "number" && startedAt < session.startedAt) ||
      (traceOwner !== undefined && traceOwner !== session.generationId)
    ) {
      session.rejectedLateWrites += 1;
      return undefined;
    }
    if (traceId && !traceOwner) {
      this.traceGenerationOwners.set(traceId, session.generationId);
    }
    return session;
  }

  private async drainStable(session: ActiveSessionRecording) {
    while (true) {
      session.drainPasses += 1;
      const observedVersion = session.enqueueVersion;
      const observedQueue = session.writeQueue;
      await observedQueue.catch(() => undefined);
      await Promise.resolve();
      if (
        session.pendingWrites === 0 &&
        observedVersion === session.enqueueVersion
      ) {
        return;
      }
    }
  }

  private serializeTransition<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transitionQueue.then(operation, operation);
    this.transitionQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private emit() {
    this.onChange?.(this.getState());
  }
}

export function buildSessionRecordingProviderSummary({
  mainProvider,
  codingProvider,
  taxonomyAdjudicationProvider,
  sttProvider,
  mainProviderId,
  codingProviderId,
  taxonomyAdjudicationProviderId,
  sttProviderId,
  taxonomyAdjudicationConfigurationStatus,
  taxonomyAdjudicationInheritedVariableKeys,
  taxonomyAdjudicationMissingRequiredVariables,
}: {
  mainProvider?: TYPE_PROVIDER;
  codingProvider?: TYPE_PROVIDER;
  taxonomyAdjudicationProvider?: TYPE_PROVIDER;
  sttProvider?: TYPE_PROVIDER;
  mainProviderId?: string;
  codingProviderId?: string;
  taxonomyAdjudicationProviderId?: string;
  sttProviderId?: string;
  taxonomyAdjudicationConfigurationStatus?: string;
  taxonomyAdjudicationInheritedVariableKeys?: string[];
  taxonomyAdjudicationMissingRequiredVariables?: string[];
}): SessionRecordingProviderSummary {
  return {
    mainProviderId,
    codingProviderId,
    taxonomyAdjudicationProviderId,
    sttProviderId,
    hasMainProvider: Boolean(mainProvider),
    hasCodingProvider: Boolean(codingProvider),
    hasTaxonomyAdjudicationProvider: Boolean(taxonomyAdjudicationProvider),
    hasSttProvider: Boolean(sttProvider),
    mainSupportsImages: Boolean(mainProvider?.curl.includes("{{IMAGE}}")),
    codingSupportsImages: Boolean(codingProvider?.curl.includes("{{IMAGE}}")),
    taxonomyAdjudicationConfigurationStatus,
    taxonomyAdjudicationInheritedVariableKeys,
    taxonomyAdjudicationMissingRequiredVariables,
  };
}

function buildSessionRecordingManifest({
  status,
  sessionId,
  folderName,
  folderPath,
  startedAt,
  settings,
  interviewSessionBrief,
  interviewSessionContext,
  providerSummary,
}: {
  status: "running";
  sessionId: string;
  folderName: string;
  folderPath?: string;
  startedAt: number;
  settings: MeetingAssistantSettings;
  interviewSessionBrief?: InterviewSessionBrief;
  interviewSessionContext?: InterviewSessionContext;
  providerSummary: SessionRecordingProviderSummary;
}) {
  return {
    version: SESSION_RECORDING_SCHEMA_VERSION,
    status,
    privacy: {
      rawAudioIncluded: false,
      note: "Session recordings include text, screenshots, prompts, outputs, memory retrieval, metrics, and human labels. Raw audio is not recorded.",
    },
    sessionId,
    folderName,
    folderPath,
    startedAt,
    build: readBuildProvenance(),
    recordingRoot: "app-data/meeting-session-recordings",
    settings: sanitizeMeetingAssistantSettings(settings),
    interviewSessionBrief,
    interviewSessionContext,
    providerSummary,
  };
}

function readBuildProvenance() {
  return {
    appVersion:
      typeof __JARVIS_APP_VERSION__ === "string"
        ? __JARVIS_APP_VERSION__
        : "unknown",
    gitCommit:
      typeof __JARVIS_GIT_COMMIT__ === "string"
        ? __JARVIS_GIT_COMMIT__
        : "unknown",
    gitDirty:
      typeof __JARVIS_GIT_DIRTY__ === "boolean"
        ? __JARVIS_GIT_DIRTY__
        : undefined,
    buildTimestamp:
      typeof __JARVIS_BUILD_TIMESTAMP__ === "string"
        ? __JARVIS_BUILD_TIMESTAMP__
        : undefined,
  };
}

function buildSessionRecordingReadme(sessionId: string) {
  return [
    "# Jarvis Meeting Session Recording",
    "",
    `Session: ${sessionId}`,
    "",
    "This folder is a local-only evaluation artifact for Jarvis interview testing.",
    "",
    "- Raw audio is not recorded.",
    "- Provider secrets are not intentionally written.",
    "- Screenshots, prompts, memory context, transcripts, outputs, metrics, and human labels may contain sensitive interview content.",
    "- Keep this folder private.",
    "",
  ].join("\n");
}

function sanitizeMeetingAssistantSettings(settings: MeetingAssistantSettings) {
  return {
    ...settings,
    codingModel: {
      provider: settings.codingModel.provider,
      variableKeys: Object.keys(settings.codingModel.variables),
      variables: "[redacted]",
    },
    taxonomyAdjudication: {
      enabled: settings.taxonomyAdjudication.enabled,
      questionTypeMode:
        settings.taxonomyAdjudication.questionTypeMode,
      taskRelationMode:
        settings.taxonomyAdjudication.taskRelationMode,
      provider: settings.taxonomyAdjudication.provider,
      variableKeys: Object.keys(settings.taxonomyAdjudication.variables),
      variables: "[redacted]",
    },
  };
}

function buildSessionRecordingFolderName(sessionId: string, startedAt: number) {
  const timestamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  const shortId = sessionId.split("_").slice(-1)[0] || sessionId.slice(-6);
  return `session-${timestamp}_${shortId}`;
}

function buildTraceArtifactPath(
  traceId: string,
  folder: string,
  label: string,
  extension: string
) {
  const fileName = `${Date.now()}-${sanitizeFilePart(label)}.${extension}`;
  return `traces/${sanitizeFilePart(traceId)}/${folder}/${fileName}`;
}

function imageExtension(mediaType?: string) {
  if (mediaType?.includes("jpeg") || mediaType?.includes("jpg")) return "jpeg";
  if (mediaType?.includes("webp")) return "webp";
  return "png";
}

function sanitizeFilePart(value: string) {
  const sanitized = value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "artifact";
}

function formatTimestamp(timestamp: number) {
  return new Date(timestamp).toISOString();
}

function filterTraceMetricsPayload(payload: string, recordedTraceIds: Set<string>) {
  try {
    const parsed = JSON.parse(payload) as { traces?: MeetingTrace[] };
    if (!Array.isArray(parsed.traces)) return payload;

    return JSON.stringify(
      {
        ...parsed,
        currentSessionOnly: true,
        traces: parsed.traces.filter((trace) =>
          recordedTraceIds.has(trace.id)
        ),
      },
      null,
      2
    );
  } catch {
    return payload;
  }
}

function isTraceablePreparationArtifactUse(
  session: ActiveSessionRecording,
  receipt: PreparationArtifactUseReceipt
) {
  const context = session.preparationRuntimeContexts.get(
    `${receipt.meetingSessionId}:${receipt.preparationContextRevision}`
  );
  const snapshot = context?.pinnedSnapshot;
  if (
    context?.mode !== "prepared" ||
    context.loadState !== "ready" ||
    !snapshot ||
    context.selectionRevision !== receipt.selectionRevision ||
    snapshot.snapshotId !== receipt.snapshotId ||
    snapshot.version !== receipt.snapshotVersion ||
    snapshot.contentHash !== receipt.snapshotContentHash
  ) {
    return false;
  }
  const projection = context.projectionCatalog.find(
    (candidate) =>
      candidate.projectionId === receipt.projectionId &&
      candidate.consumer === receipt.consumer &&
      candidate.snapshotId === receipt.snapshotId &&
      candidate.preparationContextRevision ===
        receipt.preparationContextRevision &&
      candidate.artifactIds.includes(receipt.artifactId) &&
      candidate.artifactLineageKeys.includes(receipt.lineageKey) &&
      candidate.artifactPaths.includes(receipt.artifactPath)
  );
  const artifact = snapshot.artifactManifest.artifacts.find(
    (candidate) => candidate.artifactId === receipt.artifactId
  );
  return Boolean(
    projection &&
      artifact &&
      artifact.lineageKey === receipt.lineageKey &&
      artifact.artifactPath === receipt.artifactPath &&
      artifact.section === receipt.section &&
      artifact.contentHash === receipt.artifactContentHash
  );
}

export function buildCompactTraceSummary({
  sessionId,
  trace,
  trigger,
  traceExportPath,
  summaryPath,
  indexEntry,
}: {
  sessionId: string;
  trace: MeetingTrace;
  trigger: MeetingTraceExportTrigger;
  traceExportPath: string;
  summaryPath: string;
  indexEntry?: SessionTraceIndexEntry;
}): SessionCompactTraceSummary {
  const captureStep = findStep(trace, "Screen capture command");
  const preflightStep = findStep(trace, "Screen preflight");
  const memoryStep = findStep(trace, "Memory retrieval");
  const sttStep = findStep(trace, "STT request");
  const advisorStep = findStep(trace, "Advisor model response");
  const screenModelStep = findStep(trace, "Screen model response");
  const stateUpdateStep = findStep(trace, "Meeting Assistant state updated");
  const modelStep = screenModelStep ?? advisorStep;
  const metadataSources = collectMetadataSources(trace);
  const taskIds = uniqueStrings([
    ...(indexEntry?.taskIds ?? []),
    ...collectTaskIdsFromTrace(trace),
  ]);
  const firstTokenAt =
    readNumber(trace.metadata?.screenFirstTokenAt) ??
    readNumber(trace.metadata?.advisorFirstTokenAt);

  return {
    version: SESSION_TRACE_SUMMARY_SCHEMA_VERSION,
    sessionId,
    traceId: trace.id,
    traceKind: trace.kind,
    status: trace.status,
    trigger,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    durationMs: trace.durationMs,
    error: trace.error,
    syntheticValidation:
      readFirstBoolean(metadataSources, "syntheticValidation") ?? false,
    faultInjectionId: readFirstString(
      metadataSources,
      "faultInjectionId"
    ),
    faultKind: readFirstString(metadataSources, "faultKind"),
    taskIds,
    primaryTaskId: taskIds[0],
    activeMeetingTaskId: readFirstString(metadataSources, "activeMeetingTaskId"),
    activeMeetingTaskSource: readFirstString(
      metadataSources,
      "activeMeetingTaskSource"
    ),
    activeMeetingParentId: readFirstString(
      metadataSources,
      "activeMeetingParentId"
    ),
    activeMeetingChildId: readFirstString(
      metadataSources,
      "activeMeetingChildId"
    ),
    activeScreenTaskId: readFirstString(metadataSources, "activeScreenTaskId"),
    activeInterviewParentId: readFirstString(
      metadataSources,
      "activeInterviewParentId"
    ),
    activeInterviewChildId: readFirstString(
      metadataSources,
      "activeInterviewChildId"
    ),
    questionType:
      readFirstString(metadataSources, "canonicalQuestionType") ??
      readFirstString(metadataSources, "questionType"),
    rawQuestionType: readFirstString(metadataSources, "rawQuestionType"),
    canonicalQuestionType: readFirstString(
      metadataSources,
      "canonicalQuestionType"
    ),
    askFrame: readFirstString(metadataSources, "askFrame"),
    topicDomain: readFirstString(metadataSources, "topicDomain"),
    projectAnchor: readFirstString(metadataSources, "projectAnchor"),
    playbookId: readFirstString(metadataSources, "playbookId"),
    playbookPhase:
      readFirstString(metadataSources, "activeMeetingParentPhase") ??
      readFirstString(metadataSources, "playbookPhaseDecisionPhase") ??
      readFirstString(metadataSources, "playbookPhase"),
    playbookSubtype: readFirstString(metadataSources, "playbookSubtype"),
    phaseSignal: readFirstString(metadataSources, "phaseSignal"),
    phaseSignalSource: readFirstString(
      metadataSources,
      "phaseSignalSource"
    ),
    phaseSignalSourceTurnId: readFirstString(
      metadataSources,
      "phaseSignalSourceTurnId"
    ),
    assumptionAuthorizationState: readFirstString(
      metadataSources,
      "assumptionAuthorizationState"
    ),
    assumptionAuthorizationReason: readFirstString(
      metadataSources,
      "assumptionAuthorizationReason"
    ),
    phaseBefore: readFirstString(metadataSources, "phaseBefore"),
    phaseAfter: readFirstString(metadataSources, "phaseAfter"),
    whiteboardRevisionRequested: readFirstBoolean(
      metadataSources,
      "whiteboardRevisionRequested"
    ),
    turnGateAction: readFirstString(metadataSources, "turnGateAction"),
    turnGateReason: readFirstString(metadataSources, "turnGateReason"),
    advisorTurnIntent: readFirstString(metadataSources, "advisorTurnIntent"),
    advisorTurnConfidence: readFirstNumberFromMetadata(
      metadataSources,
      "advisorTurnConfidence"
    ),
    advisorTurnEnforcement: readFirstString(
      metadataSources,
      "advisorTurnEnforcement"
    ),
    advisorIntentAuthoritySource: readFirstString(
      metadataSources,
      "advisorIntentAuthoritySource"
    ),
    advisorWouldSuppress: readFirstBoolean(
      metadataSources,
      "advisorWouldSuppress"
    ),
    advisorExecutionAuthorized: readFirstBoolean(
      metadataSources,
      "advisorExecutionAuthorized"
    ),
    shortIntentLocalDisposition: readFirstString(
      metadataSources,
      "shortIntentLocalDisposition"
    ),
    shortIntentLocalReason: readFirstString(
      metadataSources,
      "shortIntentLocalReason"
    ),
    shortIntentWordEquivalent: readFirstNumberFromMetadata(
      metadataSources,
      "shortIntentWordEquivalent"
    ),
    canonicalFillerSuppressed: readFirstBoolean(
      metadataSources,
      "canonicalFillerSuppressed"
    ),
    shortHighInformationAllowed: readFirstBoolean(
      metadataSources,
      "shortHighInformationAllowed"
    ),
    residualShortIntentAdjudicationRequired: readFirstBoolean(
      metadataSources,
      "residualShortIntentAdjudicationRequired"
    ),
    shortIntentGateDisposition: readFirstString(
      metadataSources,
      "shortIntentGateDisposition"
    ),
    shortIntentGateAction: readFirstString(
      metadataSources,
      "shortIntentGateAction"
    ),
    shortIntentGateConfidence: readFirstNumberFromMetadata(
      metadataSources,
      "shortIntentGateConfidence"
    ),
    shortIntentGateDecisionApplied: readFirstBoolean(
      metadataSources,
      "shortIntentGateDecisionApplied"
    ),
    shortIntentGateAppliedAction: readFirstString(
      metadataSources,
      "shortIntentGateAppliedAction"
    ),
    shortIntentGateBudgetExhausted: readFirstBoolean(
      metadataSources,
      "shortIntentGateBudgetExhausted"
    ),
    shortIntentGateTimedOut: readFirstBoolean(
      metadataSources,
      "shortIntentGateTimedOut"
    ),
    shortIntentGateDurationMs: readFirstNumberFromMetadata(
      metadataSources,
      "shortIntentGateDurationMs"
    ),
    shortIntentGateQueueWaitMs: readFirstNumberFromMetadata(
      metadataSources,
      "shortIntentGateQueueWaitMs"
    ),
    runtimeIntentReleasedAction: readFirstString(
      metadataSources,
      "runtimeIntentReleasedAction"
    ),
    advisorExecutionSuppressedReason:
      readFirstString(metadataSources, "memoryRetrievalSuppressedReason") ??
      readFirstString(metadataSources, "modelExecutionSuppressedReason"),
    taskMutationAuthorized: readFirstBoolean(
      metadataSources,
      "taskMutationAuthorized"
    ),
    taskMutationAuthorizationReason: readFirstString(
      metadataSources,
      "taskMutationAuthorizationReason"
    ),
    taskRelation: readFirstString(metadataSources, "taskRelation"),
    logicalQuestionUnitId: readFirstString(
      metadataSources,
      "logicalQuestionUnitId"
    ),
    logicalQuestionUnitRevision: readFirstNumberFromMetadata(
      metadataSources,
      "logicalQuestionUnitRevision"
    ),
    logicalQuestionCurrentTurnId: readFirstString(
      metadataSources,
      "logicalQuestionCurrentTurnId"
    ),
    logicalQuestionSourceTurnIds: readFirstStringList(
      metadataSources,
      "logicalQuestionSourceTurnIds"
    ),
    logicalQuestionCompositionReasons: readFirstStringList(
      metadataSources,
      "logicalQuestionCompositionReasons"
    ),
    logicalQuestionBoundaryReason: readFirstString(
      metadataSources,
      "logicalQuestionBoundaryReason"
    ),
    logicalQuestionTruncated: readFirstBoolean(
      metadataSources,
      "logicalQuestionTruncated"
    ),
    canonicalLogicalQuestionMaterialized: readFirstBoolean(
      metadataSources,
      "canonicalLogicalQuestionMaterialized"
    ),
    canonicalLogicalQuestionMaterializationReason: readFirstString(
      metadataSources,
      "canonicalLogicalQuestionMaterializationReason"
    ),
    primaryAskSpeechAct: readFirstString(
      metadataSources,
      "primaryAskSpeechAct"
    ),
    primaryAskDisposition: readFirstString(
      metadataSources,
      "primaryAskDisposition"
    ),
    primaryAskReason: readFirstString(metadataSources, "primaryAskReason"),
    primaryAskConfidence: readFirstNumberFromMetadata(
      metadataSources,
      "primaryAskConfidence"
    ),
    primaryAskSourceTurnIds: readFirstStringList(
      metadataSources,
      "primaryAskSourceTurnIds"
    ),
    primaryAskSourceChars: readFirstNumberFromMetadata(
      metadataSources,
      "primaryAskSourceChars"
    ),
    primaryAskSpanCount: readFirstNumberFromMetadata(
      metadataSources,
      "primaryAskSpanCount"
    ),
    primaryAskSetupSpanCount: readFirstNumberFromMetadata(
      metadataSources,
      "primaryAskSetupSpanCount"
    ),
    primaryAskQuotedOrFutureSpanCount: readFirstNumberFromMetadata(
      metadataSources,
      "primaryAskQuotedOrFutureSpanCount"
    ),
    primaryAskAnswerFocusChars: readFirstNumberFromMetadata(
      metadataSources,
      "primaryAskAnswerFocusChars"
    ),
    primaryAskSemanticEvidenceChars: readFirstNumberFromMetadata(
      metadataSources,
      "primaryAskSemanticEvidenceChars"
    ),
    primaryAskAnswerFocusSpanCount: readFirstNumberFromMetadata(
      metadataSources,
      "primaryAskAnswerFocusSpanCount"
    ),
    primaryAskObjectSpanCount: readFirstNumberFromMetadata(
      metadataSources,
      "primaryAskObjectSpanCount"
    ),
    primaryAskScenarioSpanCount: readFirstNumberFromMetadata(
      metadataSources,
      "primaryAskScenarioSpanCount"
    ),
    primaryAskSemanticEvidenceRetentionReasons: readFirstStringList(
      metadataSources,
      "primaryAskSemanticEvidenceRetentionReasons"
    ),
    primaryAskSemanticEvidenceDroppedReasons: readFirstStringList(
      metadataSources,
      "primaryAskSemanticEvidenceDroppedReasons"
    ),
    primaryAskTurnGateView: readFirstString(
      metadataSources,
      "primaryAskTurnGateView"
    ),
    primaryAskTaxonomyView: readFirstString(
      metadataSources,
      "primaryAskTaxonomyView"
    ),
    primaryAskTaskSettlementView: readFirstString(
      metadataSources,
      "primaryAskTaskSettlementView"
    ),
    primaryAskAdvisorView: readFirstString(
      metadataSources,
      "primaryAskAdvisorView"
    ),
    primaryAskAnswerFocusQuestionTypeProposal: readFirstString(
      metadataSources,
      "primaryAskAnswerFocusQuestionTypeProposal"
    ),
    primaryAskSemanticEvidenceQuestionTypeProposal: readFirstString(
      metadataSources,
      "primaryAskSemanticEvidenceQuestionTypeProposal"
    ),
    primaryAskQuestionTypeProposalChanged: readFirstBoolean(
      metadataSources,
      "primaryAskQuestionTypeProposalChanged"
    ),
    logicalQuestionLeaseAuthorized: readFirstBoolean(
      metadataSources,
      "logicalQuestionLeaseAuthorized"
    ),
    logicalQuestionLeaseAuthorizationReason: readFirstString(
      metadataSources,
      "logicalQuestionLeaseAuthorizationReason"
    ),
    logicalQuestionLeaseAuthorizationStage: readFirstString(
      metadataSources,
      "logicalQuestionLeaseAuthorizationStage"
    ),
    forceAdviseTargetStatus: readFirstString(
      metadataSources,
      "forceAdviseTargetStatus"
    ),
    forceAdviseAutomaticExecutionState: readFirstString(
      metadataSources,
      "forceAdviseAutomaticExecutionState"
    ),
    forceAdviseManualExecutionState: readFirstString(
      metadataSources,
      "forceAdviseManualExecutionState"
    ),
    forceAdviseVisibleCommitRevision: readFirstNumberFromMetadata(
      metadataSources,
      "forceAdviseVisibleCommitRevision"
    ),
    forceAdviseEligible: readFirstBoolean(
      metadataSources,
      "forceAdviseEligible"
    ),
    forceAdviseRetryable: readFirstBoolean(
      metadataSources,
      "forceAdviseRetryable"
    ),
    forceAdviseEligibilityReason: readFirstString(
      metadataSources,
      "forceAdviseEligibilityReason"
    ),
    forceAdviseRepairCause: readFirstString(
      metadataSources,
      "forceAdviseRepairCause"
    ),
    forceAdviseAdvisorOutcome: readFirstString(
      metadataSources,
      "forceAdviseAdvisorOutcome"
    ),
    forceAdviseOwnershipAuthorized: readFirstBoolean(
      metadataSources,
      "forceAdviseOwnershipAuthorized"
    ),
    forceAdviseOwnershipReason: readFirstString(
      metadataSources,
      "forceAdviseOwnershipReason"
    ),
    forceAdviseRecoveredPendingCandidate: readFirstBoolean(
      metadataSources,
      "forceAdviseRecoveredPendingCandidate"
    ),
    manualCorrectionOwnership: readFirstString(
      metadataSources,
      "manualCorrectionOwnership"
    ),
    advisorPromptIncludedLogicalQuestion: readFirstBoolean(
      metadataSources,
      "advisorPromptIncludedLogicalQuestion"
    ),
    advisorPromptLogicalQuestionSourceCount:
      readFirstNumberFromMetadata(
        metadataSources,
        "advisorPromptLogicalQuestionSourceCount"
      ),
    advisorOutputCommittedToUi: readFirstBoolean(
      metadataSources,
      "advisorOutputCommittedToUi"
    ),
    advisorOutputCommitAuthorized: readFirstBoolean(
      metadataSources,
      "advisorOutputCommitAuthorized"
    ),
    visibleAnswerChanged: readFirstBoolean(
      metadataSources,
      "visibleAnswerChanged"
    ),
    refreshAuthority: readFirstString(
      metadataSources,
      "refreshAuthority"
    ),
    refreshAuthorityAuthorized: readFirstBoolean(
      metadataSources,
      "refreshAuthorityAuthorized"
    ),
    refreshAuthorityReason: readFirstString(
      metadataSources,
      "refreshAuthorityReason"
    ),
    refreshAuthorityHardOverride: readFirstBoolean(
      metadataSources,
      "refreshAuthorityHardOverride"
    ),
    answerGenerationLeaseId: readFirstString(
      metadataSources,
      "answerGenerationLeaseId"
    ),
    preparationContextRevision: readFirstNumberFromMetadata(
      metadataSources,
      "answerGenerationLeasePreparationContextRevision"
    ) ?? readFirstNumberFromMetadata(
      metadataSources,
      "preparationContextRevision"
    ),
    preparationArtifactUseReceiptIds: readFirstStringList(
      metadataSources,
      "preparationArtifactUseReceiptIds"
    ),
    preparationArtifactIds: readFirstStringList(
      metadataSources,
      "preparationArtifactIds"
    ),
    preparationArtifactConsumers: readFirstStringList(
      metadataSources,
      "preparationArtifactConsumers"
    ),
    leaseAuthorizedAtStart: readFirstBoolean(
      metadataSources,
      "leaseAuthorizedAtStart"
    ),
    leaseAuthorizedAtCommit: readFirstBoolean(
      metadataSources,
      "leaseAuthorizedAtCommit"
    ),
    staleCommitRejected: readFirstBoolean(
      metadataSources,
      "staleCommitRejected"
    ),
    staleReason: readFirstString(metadataSources, "staleReason"),
    visibleAnswerRevisionBefore: readFirstNumberFromMetadata(
      metadataSources,
      "visibleAnswerRevisionBefore"
    ),
    visibleAnswerRevisionAfter: readFirstNumberFromMetadata(
      metadataSources,
      "visibleAnswerRevisionAfter"
    ),
    baseVisibleAnswerRevision: readFirstNumberFromMetadata(
      metadataSources,
      "baseVisibleAnswerRevision"
    ),
    stableAnswerCommitDisposition: readFirstString(
      metadataSources,
      "stableAnswerCommitDisposition"
    ),
    stableAnswerCommitReason: readFirstString(
      metadataSources,
      "stableAnswerCommitReason"
    ),
    answerDeliveryLockState: readFirstString(
      metadataSources,
      "answerDeliveryLockState"
    ),
    meSpokenWordEquivalent: readFirstNumberFromMetadata(
      metadataSources,
      "meSpokenWordEquivalent"
    ),
    meAnswerTokenOverlap: readFirstNumberFromMetadata(
      metadataSources,
      "meAnswerTokenOverlap"
    ),
    pendingAnswerDisposition: readFirstString(
      metadataSources,
      "pendingAnswerDisposition"
    ),
    pendingAnswerOperationId: readFirstString(
      metadataSources,
      "pendingAnswerOperationId"
    ),
    requestedArtifacts: readFirstStringList(
      metadataSources,
      "requestedArtifacts"
    ),
    authorizedArtifacts: readFirstStringList(
      metadataSources,
      "authorizedArtifacts"
    ),
    generationRequestedArtifacts: readFirstStringList(
      metadataSources,
      "generationRequestedArtifacts"
    ),
    parsedArtifacts: readFirstStringList(
      metadataSources,
      "parsedArtifacts"
    ),
    parentAuthorizedArtifacts: readFirstStringList(
      metadataSources,
      "parentAuthorizedArtifacts"
    ),
    screenAuthorizedArtifacts: readFirstStringList(
      metadataSources,
      "screenAuthorizedArtifacts"
    ),
    committedArtifacts: readFirstStringList(
      metadataSources,
      "committedArtifacts"
    ),
    screenArtifactAuthoritySource: readFirstString(
      metadataSources,
      "screenArtifactAuthoritySource"
    ),
    screenArtifactAuthorityAuthorized: readFirstBoolean(
      metadataSources,
      "screenArtifactAuthorityAuthorized"
    ),
    screenArtifactAuthorityReason: readFirstString(
      metadataSources,
      "screenArtifactAuthorityReason"
    ),
    playbookArtifactContractMismatch: readFirstBoolean(
      metadataSources,
      "playbookArtifactContractMismatch"
    ),
    playbookArtifactContractMismatchReasons: readFirstStringList(
      metadataSources,
      "playbookArtifactContractMismatchReasons"
    ),
    artifactCacheDisposition: readFirstString(
      metadataSources,
      "artifactCacheDisposition"
    ),
    artifactMutationRejectedReasons: readFirstStringList(
      metadataSources,
      "artifactMutationRejectedReasons"
    ),
    answerSectionRevision: readFirstNumberFromMetadata(
      metadataSources,
      "answerSectionRevision"
    ),
    codeSectionRevision: readFirstNumberFromMetadata(
      metadataSources,
      "codeSectionRevision"
    ),
    complexitySectionRevision: readFirstNumberFromMetadata(
      metadataSources,
      "complexitySectionRevision"
    ),
    whiteboardSectionRevision: readFirstNumberFromMetadata(
      metadataSources,
      "whiteboardSectionRevision"
    ),
    previousCodeRevision: readFirstNumberFromMetadata(
      metadataSources,
      "previousCodeRevision"
    ),
    nextCodeRevision: readFirstNumberFromMetadata(
      metadataSources,
      "nextCodeRevision"
    ),
    previousComplexityRevision: readFirstNumberFromMetadata(
      metadataSources,
      "previousComplexityRevision"
    ),
    nextComplexityRevision: readFirstNumberFromMetadata(
      metadataSources,
      "nextComplexityRevision"
    ),
    renderedCodeArtifactRevision: readFirstNumberFromMetadata(
      metadataSources,
      "renderedCodeArtifactRevision"
    ),
    renderedComplexityArtifactRevision: readFirstNumberFromMetadata(
      metadataSources,
      "renderedComplexityArtifactRevision"
    ),
    codeMutationWithoutCodeIntent: readFirstBoolean(
      metadataSources,
      "codeMutationWithoutCodeIntent"
    ),
    answerDwellMs: readFirstNumberFromMetadata(
      metadataSources,
      "answerDwellMs"
    ),
    manualQuestionTypeCorrectionId: readFirstString(
      metadataSources,
      "manualQuestionTypeCorrectionId"
    ),
    manualTermCorrectionId: readFirstString(
      metadataSources,
      "manualTermCorrectionId"
    ),
    manualTermCorrectionDisposition: readFirstString(
      metadataSources,
      "manualTermCorrectionDisposition"
    ),
    manualTermCorrectionRegenerationStatus: readFirstString(
      metadataSources,
      "manualTermCorrectionRegenerationStatus"
    ),
    manualTermCorrectionLogicalQuestionUnitId: readFirstString(
      metadataSources,
      "manualTermCorrectionLogicalQuestionUnitId"
    ),
    manualTermCorrectionLogicalQuestionUnitRevision:
      readFirstNumberFromMetadata(
        metadataSources,
        "manualTermCorrectionLogicalQuestionUnitRevision"
      ),
    manualTermCorrectionCorrectedLogicalQuestionUnitRevision:
      readFirstNumberFromMetadata(
        metadataSources,
        "manualTermCorrectionCorrectedLogicalQuestionUnitRevision"
      ),
    manualTermCorrectionRevision: readFirstNumberFromMetadata(
      metadataSources,
      "manualTermCorrectionRevision"
    ),
    manualTermCorrectionRegenerationTraceId: readFirstString(
      metadataSources,
      "manualTermCorrectionRegenerationTraceId"
    ),
    manualTermCorrectionSettlementId: readFirstString(
      metadataSources,
      "manualTermCorrectionSettlementId"
    ),
    manualTermCorrectionLatencyMs: readFirstNumberFromMetadata(
      metadataSources,
      "manualTermCorrectionLatencyMs"
    ),
    taskBoundary: {
      logicalQuestionUnitId: readFirstString(
        metadataSources,
        "taskBoundaryLogicalQuestionUnitId"
      ),
      candidateId: readFirstString(
        metadataSources,
        "taskBoundaryCandidateId"
      ),
      candidateState: readFirstString(
        metadataSources,
        "taskBoundaryCandidateState"
      ),
      commitPolicy: readFirstString(
        metadataSources,
        "taskBoundaryCommitPolicy"
      ),
      mutationDisposition: readFirstString(
        metadataSources,
        "taskBoundaryMutationDisposition"
      ),
      authoritySource: readFirstString(
        metadataSources,
        "taskBoundaryAuthoritySource"
      ),
      sourceTurnIds: readFirstStringList(
        metadataSources,
        "taskBoundarySourceTurnIds"
      ),
      committedBeforeAdvisor: readFirstBoolean(
        metadataSources,
        "taskBoundaryCommittedBeforeAdvisor"
      ),
      committedParentId: readFirstString(
        metadataSources,
        "taskBoundaryCommittedParentId"
      ),
      survivedAdvisorCancellation: readFirstBoolean(
        metadataSources,
        "taskBoundarySurvivedAdvisorCancellation"
      ),
      parentBeforeId: readFirstString(metadataSources, "parentBeforeId"),
      parentBeforeType: readFirstString(metadataSources, "parentBeforeType"),
      parentAfterId: readFirstString(metadataSources, "parentAfterId"),
      parentAfterType: readFirstString(metadataSources, "parentAfterType"),
    },
    currentQuestionSettlement: {
      settlementId: readFirstString(
        metadataSources,
        "currentQuestionSettlementId"
      ),
      logicalQuestionUnitId: readFirstString(
        metadataSources,
        "currentQuestionSettlementUnitId"
      ),
      logicalQuestionUnitRevision:
        readFirstNumberFromMetadata(
          metadataSources,
          "currentQuestionSettlementRevision"
        ),
      sourceTurnIds: readFirstStringList(
        metadataSources,
        "currentQuestionSettlementSourceTurnIds"
      ),
      sourceObservationIds: readFirstStringList(
        metadataSources,
        "currentQuestionSettlementSourceObservationIds"
      ),
      sourceHash: readFirstString(
        metadataSources,
        "currentQuestionSettlementSourceHash"
      ),
      questionType: readFirstString(
        metadataSources,
        "currentQuestionSettlementType"
      ),
      relation: readFirstString(
        metadataSources,
        "currentQuestionSettlementRelation"
      ),
      action: readFirstString(
        metadataSources,
        "currentQuestionSettlementAction"
      ),
      evidenceMode: readFirstString(
        metadataSources,
        "currentQuestionSettlementEvidenceMode"
      ),
      authority: readFirstString(
        metadataSources,
        "currentQuestionSettlementAuthority"
      ),
      authoritySource: readFirstString(
        metadataSources,
        "currentQuestionSettlementAuthoritySource"
      ),
      typeAuthoritySource: readFirstString(
        metadataSources,
        "currentQuestionSettlementTypeAuthoritySource"
      ),
      relationAuthoritySource: readFirstString(
        metadataSources,
        "currentQuestionSettlementRelationAuthoritySource"
      ),
      actionAuthoritySource: readFirstString(
        metadataSources,
        "currentQuestionSettlementActionAuthoritySource"
      ),
      typeMutationAuthorized: readFirstBoolean(
        metadataSources,
        "currentQuestionSettlementTypeMutationAuthorized"
      ),
      relationMutationAuthorized: readFirstBoolean(
        metadataSources,
        "currentQuestionSettlementRelationMutationAuthorized"
      ),
      parentMutationAuthorized: readFirstBoolean(
        metadataSources,
        "currentQuestionSettlementParentMutationAuthorized"
      ),
      responseAuthorized: readFirstBoolean(
        metadataSources,
        "currentQuestionSettlementResponseAuthorized"
      ),
      disposition: readFirstString(
        metadataSources,
        "currentQuestionSettlementDisposition"
      ),
      parentBeforeId: readFirstString(
        metadataSources,
        "currentQuestionSettlementParentBeforeId"
      ),
      parentBeforeType: readFirstString(
        metadataSources,
        "currentQuestionSettlementParentBeforeType"
      ),
      parentAfterId: readFirstString(
        metadataSources,
        "currentQuestionSettlementParentAfterId"
      ),
      parentAfterType: readFirstString(
        metadataSources,
        "currentQuestionSettlementParentAfterType"
      ),
      manualCorrectionRevision:
        readFirstNumberFromMetadata(
          metadataSources,
          "currentQuestionSettlementManualCorrectionRevision"
        ),
      rejectedProposalCount:
        readFirstObjectListLength(
          metadataSources,
          "currentQuestionSettlementRejectedProposals"
        ),
      reasons: readFirstStringList(
        metadataSources,
        "currentQuestionSettlementReasons"
      ),
      durationMs: readFirstNumberFromMetadata(
        metadataSources,
        "currentQuestionSettlementDurationMs"
      ),
      llmWaitMs: readFirstNumberFromMetadata(
        metadataSources,
        "currentQuestionSettlementLlmWaitMs"
      ),
      llmWaitDisposition: readFirstString(
        metadataSources,
        "currentQuestionSettlementLlmWaitDisposition"
      ),
    },
    currentQuestionTerminalNoAnswer:
      buildCurrentQuestionTerminalNoAnswerTraceSummary(metadataSources),
    settledExecutionPlan: {
      planId: readFirstString(
        metadataSources,
        "settledExecutionPlanId"
      ),
      settlementId: readFirstString(
        metadataSources,
        "settledExecutionPlanSettlementId"
      ),
      questionType: readFirstString(
        metadataSources,
        "settledExecutionPlanQuestionType"
      ),
      relation: readFirstString(
        metadataSources,
        "settledExecutionPlanRelation"
      ),
      responseAuthorized: readFirstBoolean(
        metadataSources,
        "settledExecutionPlanResponseAuthorized"
      ),
      responseIntent: readFirstString(
        metadataSources,
        "settledExecutionPlanResponseIntent"
      ),
      contextReadScope: readFirstString(
        metadataSources,
        "settledExecutionPlanContextReadScope"
      ),
      artifactIntent: readFirstString(
        metadataSources,
        "settledExecutionPlanArtifactIntent"
      ),
      responseOwnerSource: readFirstString(
        metadataSources,
        "settledExecutionPlanResponseOwnerSource"
      ),
      modelRoute: readFirstString(
        metadataSources,
        "settledExecutionPlanModelRoute"
      ),
      providerId: readFirstString(
        metadataSources,
        "settledExecutionPlanProviderId"
      ),
      playbookId: readFirstString(
        metadataSources,
        "settledExecutionPlanPlaybookId"
      ),
      playbookPhase: readFirstString(
        metadataSources,
        "settledExecutionPlanPlaybookPhase"
      ),
      requiredArtifacts: readFirstStringList(
        metadataSources,
        "settledExecutionPlanRequiredArtifacts"
      ),
      memoryUseCase: readFirstString(
        metadataSources,
        "settledExecutionPlanMemoryUseCase"
      ),
      memoryQuestionType: readFirstString(
        metadataSources,
        "settledExecutionPlanMemoryQuestionType"
      ),
      memoryPolicyId: readFirstString(
        metadataSources,
        "settledExecutionPlanMemoryPolicyId"
      ),
      factAnchorPolicy: readFirstString(
        metadataSources,
        "settledExecutionPlanFactAnchorPolicy"
      ),
      promptContract: readFirstString(
        metadataSources,
        "settledExecutionPlanPromptContract"
      ),
      artifactDisposition: readFirstString(
        metadataSources,
        "settledExecutionPlanArtifactDisposition"
      ),
      transientPersonalStatusDecisionId: readFirstString(
        metadataSources,
        "settledExecutionPlanTransientPersonalStatusDecisionId"
      ),
      transientPersonalStatusDomain: readFirstString(
        metadataSources,
        "settledExecutionPlanTransientPersonalStatusDomain"
      ),
      transientPersonalStatusDisposition: readFirstString(
        metadataSources,
        "settledExecutionPlanTransientPersonalStatusDisposition"
      ),
      transientPersonalStatusEvidencePolicy: readFirstString(
        metadataSources,
        "settledExecutionPlanTransientPersonalStatusEvidencePolicy"
      ),
      authorized: readFirstBoolean(
        metadataSources,
        "settledExecutionPlanAuthorized"
      ),
      authorizationReason: readFirstString(
        metadataSources,
        "settledExecutionPlanAuthorizationReason"
      ),
      authorizationStage: readFirstString(
        metadataSources,
        "settledExecutionPlanAuthorizationStage"
      ),
      rejectionReasons: readFirstStringList(
        metadataSources,
        "settledExecutionPlanRejectionReasons"
      ),
    },
    boundedRecentHistory: {
      decision: readFirstString(
        metadataSources,
        "boundedRecentHistoryDecision"
      ),
      reason: readFirstString(
        metadataSources,
        "boundedRecentHistoryReason"
      ),
      contextReadScope: readFirstString(
        metadataSources,
        "boundedRecentHistoryContextReadScope"
      ),
      parentTaskId: readFirstString(
        metadataSources,
        "boundedRecentHistoryParentTaskId"
      ),
      deicticEvidence: readFirstStringList(
        metadataSources,
        "boundedRecentHistoryDeicticEvidence"
      ),
      candidateCount: readFirstNumberFromMetadata(
        metadataSources,
        "boundedRecentHistoryCandidateCount"
      ),
      selectedCount: readFirstNumberFromMetadata(
        metadataSources,
        "boundedRecentHistorySelectedCount"
      ),
      selectedChars: readFirstNumberFromMetadata(
        metadataSources,
        "boundedRecentHistorySelectedChars"
      ),
      sourceTraceCount: readFirstNumberFromMetadata(
        metadataSources,
        "boundedRecentHistorySourceTraceCount"
      ),
      explicitEnhance: readFirstBoolean(
        metadataSources,
        "boundedRecentHistoryExplicitEnhance"
      ),
      authority: readFirstString(
        metadataSources,
        "boundedRecentHistoryAuthority"
      ),
      factAuthority: readFirstBoolean(
        metadataSources,
        "boundedRecentHistoryFactAuthority"
      ),
      taskMutationAuthority: readFirstBoolean(
        metadataSources,
        "boundedRecentHistoryTaskMutationAuthority"
      ),
      artifactMutationAuthority: readFirstBoolean(
        metadataSources,
        "boundedRecentHistoryArtifactMutationAuthority"
      ),
    },
    crossDomainTransition: {
      kind: readFirstString(metadataSources, "crossDomainTransitionKind"),
      reason: readFirstString(
        metadataSources,
        "crossDomainTransitionReason"
      ),
      previousQuestionType: readFirstString(
        metadataSources,
        "crossDomainPreviousQuestionType"
      ),
      nextQuestionType: readFirstString(
        metadataSources,
        "crossDomainNextQuestionType"
      ),
      sharedDomainTokens: readFirstStringList(
        metadataSources,
        "crossDomainSharedDomainTokens"
      ),
      evidence: readFirstStringList(
        metadataSources,
        "crossDomainTransitionEvidence"
      ),
      parentContextHandoffKind: readFirstString(
        metadataSources,
        "parentContextHandoffKind"
      ),
      parentContextHandoffSourceId: readFirstString(
        metadataSources,
        "parentContextHandoffSourceId"
      ),
      parentContextHandoffSourceQuestionId: readFirstString(
        metadataSources,
        "parentContextHandoffSourceQuestionId"
      ),
    },
    advisorOutputDisposition: readFirstString(
      metadataSources,
      "advisorOutputDisposition"
    ),
    adjacentConstraintInherited: readFirstBoolean(
      metadataSources,
      "adjacentConstraintInherited"
    ),
    adjacentConstraintDecisionReason: readFirstString(
      metadataSources,
      "adjacentConstraintDecisionReason"
    ),
    adjacentConstraintKinds: readFirstString(
      metadataSources,
      "adjacentConstraintKinds"
    ),
    adjacentConstraintDeltaMs: readFirstNumberFromMetadata(
      metadataSources,
      "adjacentConstraintDeltaMs"
    ),
    adjacentQuestionOriginTraceId: readFirstString(
      metadataSources,
      "adjacentQuestionOriginTraceId"
    ),
    sentenceBufferDisposition: readFirstString(
      metadataSources,
      "sentenceBufferDisposition"
    ),
    sentenceBufferOperationId: readFirstString(
      metadataSources,
      "sentenceBufferOperationId"
    ),
    sentenceBufferOperationRole: readFirstString(
      metadataSources,
      "sentenceBufferOperationRole"
    ),
    sentenceBufferOutcome: readFirstString(
      metadataSources,
      "sentenceBufferOutcome"
    ),
    sentenceBufferReason: readFirstString(
      metadataSources,
      "sentenceBufferReason"
    ),
    sentenceBufferFlushReason: readFirstString(
      metadataSources,
      "sentenceBufferFlushReason"
    ),
    sentenceBufferFragmentCount: readFirstNumberFromMetadata(
      metadataSources,
      "sentenceBufferFragmentCount"
    ),
    sentenceBufferAddedLatencyMs: readFirstNumberFromMetadata(
      metadataSources,
      "sentenceBufferAddedLatencyMs"
    ),
    sentenceBufferMergedTranscriptChars: readFirstNumberFromMetadata(
      metadataSources,
      "sentenceBufferMergedTranscriptChars"
    ),
    sentenceBufferContinuationAuthorized: readFirstBoolean(
      metadataSources,
      "sentenceBufferContinuationAuthorized"
    ),
    sentenceBufferContinuationReason: readFirstString(
      metadataSources,
      "sentenceBufferContinuationReason"
    ),
    sentenceBufferContinuationHandoffSource: readFirstString(
      metadataSources,
      "sentenceBufferContinuationHandoffSource"
    ),
    sentenceBufferContinuationCandidateSequence:
      readFirstNumberFromMetadata(
        metadataSources,
        "sentenceBufferContinuationCandidateSequence"
      ),
    sentenceBufferContinuationExtensionUsed: readFirstBoolean(
      metadataSources,
      "sentenceBufferContinuationExtensionUsed"
    ),
    sentenceBufferInitialWaitMs: readFirstNumberFromMetadata(
      metadataSources,
      "sentenceBufferInitialWaitMs"
    ),
    sentenceBufferContinuationWaitMs: readFirstNumberFromMetadata(
      metadataSources,
      "sentenceBufferContinuationWaitMs"
    ),
    sentenceBufferContinuationDeadlineAt: readFirstNumberFromMetadata(
      metadataSources,
      "sentenceBufferContinuationDeadlineAt"
    ),
    sentenceBufferAbsoluteDeadlineAt: readFirstNumberFromMetadata(
      metadataSources,
      "sentenceBufferAbsoluteDeadlineAt"
    ),
    semanticTaxonomy: buildSemanticTaxonomyTraceSummary(metadataSources),
    semanticEmbeddingRuntime:
      buildSemanticEmbeddingRuntimeTraceSummary(metadataSources),
    interviewerIntentSemantic:
      buildInterviewerIntentSemanticTraceSummary(metadataSources),
    interviewerIntentLlm:
      buildInterviewerIntentLlmTraceSummary(metadataSources),
    taxonomyAdjudication:
      buildTaxonomyAdjudicationTraceSummary(metadataSources),
    questionTypeAdjudicationOutcome:
      buildQuestionTypeAdjudicationOutcomeTraceSummary(metadataSources),
    answerSufficiency:
      buildAnswerSufficiencyTraceSummary(metadataSources),
    personalEvidence: {
      requirement: readFirstString(
        metadataSources,
        "personalEvidenceRequirement"
      ),
      confidence: readFirstNumberFromMetadata(
        metadataSources,
        "personalEvidenceConfidence"
      ),
      confidenceTier: readFirstString(
        metadataSources,
        "personalEvidenceConfidenceTier"
      ),
      statusDomain: readFirstString(
        metadataSources,
        "personalEvidenceStatusDomain"
      ),
      allowedSources: readFirstStringList(
        metadataSources,
        "personalEvidenceAllowedSources"
      ),
      selectedSources: readFirstStringList(
        metadataSources,
        "personalEvidenceSelectedSources"
      ),
      mode: readFirstString(
        metadataSources,
        "personalEvidenceGuardrailMode"
      ),
      enforced: readFirstBoolean(
        metadataSources,
        "personalEvidenceEnforced"
      ),
      unsupportedClaimRisk: readFirstString(
        metadataSources,
        "unsupportedClaimRisk"
      ),
    },
    projectBinding: {
      action: readFirstString(metadataSources, "projectBindingAction"),
      reason: readFirstString(metadataSources, "projectBindingReason"),
      changed: readFirstBoolean(metadataSources, "projectBindingChanged"),
      projectId:
        readFirstString(metadataSources, "projectBindingProjectId") ??
        readFirstString(metadataSources, "activeMeetingProjectBindingId"),
      projectName:
        readFirstString(metadataSources, "projectBindingProjectName") ??
        readFirstString(metadataSources, "activeMeetingProjectBindingName"),
      primaryEntryId:
        readFirstString(metadataSources, "projectBindingPrimaryEntryId") ??
        readFirstString(metadataSources, "activeMeetingProjectBindingEntryId"),
      source:
        readFirstString(metadataSources, "projectBindingSource") ??
        readFirstString(metadataSources, "activeMeetingProjectBindingSource"),
      confidence:
        readFirstNumberFromMetadata(
          metadataSources,
          "projectBindingConfidence"
        ) ??
        readFirstNumberFromMetadata(
          metadataSources,
          "activeMeetingProjectBindingConfidence"
        ),
      revision:
        readFirstNumberFromMetadata(metadataSources, "projectBindingRevision") ??
        readFirstNumberFromMetadata(
          metadataSources,
          "activeMeetingProjectBindingRevision"
        ),
      candidateCount: readFirstNumberFromMetadata(
        metadataSources,
        "projectBindingCandidateCount"
      ),
      explicitAliases: readFirstStringList(
        metadataSources,
        "projectBindingExplicitAliases"
      ),
    },
    projectTrajectory: buildProjectTrajectoryTraceSummary(
      trace,
      metadataSources
    ),
    clarifyingInteraction: {
      requestId: readFirstString(metadataSources, "clarifyingRequestId"),
      questionKey: readFirstString(
        metadataSources,
        "clarifyingQuestionKey"
      ),
      optionSource: readFirstString(
        metadataSources,
        "clarifyingOptionSource"
      ),
      optionCount: readFirstNumberFromMetadata(
        metadataSources,
        "clarifyingOptionCount"
      ),
      booleanFallbackUsed: readFirstBoolean(
        metadataSources,
        "clarifyingBooleanFallbackUsed"
      ),
      misleadingBooleanFallbackPrevented: readFirstBoolean(
        metadataSources,
        "clarifyingMisleadingBooleanFallbackPrevented"
      ),
      selectedLabel: readFirstString(
        metadataSources,
        "clarifyingSelectedLabel"
      ),
      state: readFirstString(
        metadataSources,
        "clarifyingSelectionState"
      ),
      terminalReason: readFirstString(
        metadataSources,
        "clarifyingSelectionTerminalReason"
      ),
      startedAt: readFirstNumberFromMetadata(
        metadataSources,
        "clarifyingSelectionStartedAt"
      ),
      completedAt: readFirstNumberFromMetadata(
        metadataSources,
        "clarifyingSelectionCompletedAt"
      ),
    },
    sttValidation: buildSttValidationTraceSummary(metadataSources),
    audioSegment: buildAudioSegmentDispositionTraceSummary(metadataSources),
    nativeAudioBoundary:
      buildNativeAudioBoundaryTraceSummary(metadataSources),
    sttRequest: buildSttRequestTraceSummary(metadataSources),
    providerId: readString(modelStep?.metadata?.providerId),
    mode: readString(modelStep?.metadata?.mode),
    responseLength: readString(modelStep?.metadata?.responseLength),
    responseLanguage: readString(modelStep?.metadata?.responseLanguage),
    modelRoute: readFirstString(metadataSources, "modelRoute"),
    modelRouteReason: readFirstString(metadataSources, "modelRouteReason"),
    answer: {
      contractVersion: readFirstString(
        metadataSources,
        "answerContractVersion"
      ),
      profile: readFirstString(metadataSources, "answerProfile"),
      parseStatus: readFirstString(metadataSources, "answerParseStatus"),
      primarySource: readFirstString(
        metadataSources,
        "answerPrimarySource"
      ),
      recognizedSections: readFirstStringList(
        metadataSources,
        "answerRecognizedSections"
      ),
      missingExpectedSections: readFirstStringList(
        metadataSources,
        "answerMissingExpectedSections"
      ),
      latestUsefulAnswerChars: readFirstNumberFromMetadata(
        metadataSources,
        "latestUsefulAnswerChars"
      ),
      latestUsefulAnswerSource: readFirstString(
        metadataSources,
        "latestUsefulAnswerSource"
      ),
      continuitySummaryIncludedSections: readFirstStringList(
        metadataSources,
        "continuitySummaryIncludedSections"
      ),
      continuitySummaryExcludedCode: readFirstBoolean(
        metadataSources,
        "continuitySummaryExcludedCode"
      ),
      codeArtifactDecision: readFirstString(
        metadataSources,
        "answerCodeArtifactDecision"
      ),
      whiteboardArtifactDecision: readFirstString(
        metadataSources,
        "answerWhiteboardArtifactDecision"
      ),
    },
    captureTarget: summarizeCaptureTarget(captureStep?.metadata?.captureTarget),
    timingsMs: {
      total: trace.durationMs,
      capture: captureStep?.durationMs,
      preflight: preflightStep?.durationMs,
      memoryRetrieval: memoryStep?.durationMs,
      stt:
        readFirstNumberFromMetadata(
          metadataSources,
          "sttTotalRequestDurationMs"
        ) ?? sttStep?.durationMs,
      advisor: advisorStep?.durationMs,
      model: modelStep?.durationMs,
      stateUpdate: stateUpdateStep?.durationMs,
      firstTokenFromTraceStart:
        firstTokenAt && trace.startedAt ? firstTokenAt - trace.startedAt : undefined,
      firstTokenFromModelStart:
        firstTokenAt && modelStep?.startedAt
          ? firstTokenAt - modelStep.startedAt
          : undefined,
    },
    payload: {
      audioBytes: readNumber(findStep(trace, "Audio blob created")?.metadata?.audioBytes),
      imageChars: readNumber(captureStep?.metadata?.imageChars),
      focusImageChars: readNumber(captureStep?.metadata?.focusImageChars),
      promptChars: readNumber(modelStep?.metadata?.promptChars),
      outputChars: readNumber(modelStep?.metadata?.outputChars),
      transcriptChars:
        readFirstNumberFromMetadata(
          metadataSources,
          "sttFinalTranscriptChars"
        ) ?? readNumber(sttStep?.metadata?.transcriptChars),
      memoryChars: readNumber(memoryStep?.metadata?.totalChars),
    },
    memory: memoryStep
      ? {
          selectedEntries: readNumber(memoryStep.metadata?.selectedEntries),
          candidateCount: readNumber(memoryStep.metadata?.candidateCount),
          eligibleCount: readNumber(memoryStep.metadata?.eligibleCount),
          rejectedCount: readNumber(memoryStep.metadata?.rejectedCount),
          factEvidenceCount: readNumber(
            memoryStep.metadata?.runtimeMemoryFactEvidenceCount
          ),
          guidanceCount: readNumber(
            memoryStep.metadata?.runtimeMemoryGuidanceCount
          ),
          templateCount: readNumber(
            memoryStep.metadata?.runtimeMemoryTemplateCount
          ),
          overlayCount: readNumber(
            memoryStep.metadata?.runtimeMemoryOverlayCount
          ),
          anchorEligibleCount: readNumber(
            memoryStep.metadata?.runtimeMemoryAnchorEligibleCount
          ),
          anchorIneligibleCount: readNumber(
            memoryStep.metadata?.runtimeMemoryAnchorIneligibleCount
          ),
          rejectSummary: readMemoryRejectSummary(
            memoryStep.metadata?.rejectSummary
          ),
          totalChars: readNumber(memoryStep.metadata?.totalChars),
          useCase: readString(memoryStep.metadata?.useCase),
          cacheState: readString(memoryStep.metadata?.memoryCacheState),
          cacheHit: readFirstBoolean(metadataSources, "memoryCacheHit"),
          cacheLookupMs: readNumber(
            memoryStep.metadata?.memoryCacheLookupMs
          ),
          snapshotVersion: readNumber(
            memoryStep.metadata?.memorySnapshotVersion
          ),
          snapshotGeneration: readNumber(
            memoryStep.metadata?.memorySnapshotGeneration
          ),
          snapshotAgeMs: readNumber(
            memoryStep.metadata?.memorySnapshotAgeMs
          ),
          authorityRevision: readNumber(
            memoryStep.metadata?.memoryAuthorityRevision
          ),
          invalidationKind: readString(
            memoryStep.metadata?.memoryInvalidationKind
          ),
          invalidationReason: readString(
            memoryStep.metadata?.memoryInvalidationReason
          ),
          invalidationPreviousSnapshotVersion: readNumber(
            memoryStep.metadata?.memoryInvalidationPreviousSnapshotVersion
          ),
          invalidationNewSnapshotVersion: readNumber(
            memoryStep.metadata?.memoryInvalidationNewSnapshotVersion
          ),
          invalidationToFirstReadMs: readNumber(
            memoryStep.metadata?.memoryInvalidationToFirstReadMs
          ),
          invalidationFirstRead: readFirstBoolean(
            metadataSources,
            "memoryInvalidationFirstRead"
          ),
          hardInvalidationDisposition: readString(
            memoryStep.metadata?.memoryHardInvalidationDisposition
          ),
          hardInvalidationAffectedEntryIds: readStringList(
            memoryStep.metadata?.memoryHardInvalidationAffectedEntryIds
          ),
          hardInvalidationTargetsExcluded: readFirstBoolean(
            metadataSources,
            "memoryHardInvalidationTargetsExcluded"
          ),
          hardInvalidationStaleSnapshotServed: readFirstBoolean(
            metadataSources,
            "memoryHardInvalidationStaleSnapshotServed"
          ),
          databaseAcquireMs: readNumber(
            memoryStep.metadata?.memoryDatabaseAcquireMs
          ),
          databaseReadMs: readNumber(
            memoryStep.metadata?.memoryDatabaseReadMs
          ),
          rowMappingMs: readNumber(
            memoryStep.metadata?.memoryRowMappingMs
          ),
          policyScoringMs: readNumber(
            memoryStep.metadata?.memoryPolicyScoringMs
          ),
          budgetFormattingMs: readNumber(
            memoryStep.metadata?.memoryBudgetFormattingMs
          ),
          usageEnqueueMs: readNumber(
            memoryStep.metadata?.memoryUsageEnqueueMs
          ),
          usageQueueDepth: readNumber(
            memoryStep.metadata?.memoryUsageQueueDepth
          ),
          usageFlushMs: readFirstNumberFromMetadata(
            metadataSources,
            "memoryUsageFlushMs"
          ),
          usageFlushEntryCount: readFirstNumberFromMetadata(
            metadataSources,
            "memoryUsageFlushEntryCount"
          ),
          usageFlushSuccess: readFirstBoolean(
            metadataSources,
            "memoryUsageFlushSuccess"
          ),
          degradedReason: readString(
            memoryStep.metadata?.memoryRetrievalDegradedReason
          ),
        }
      : undefined,
    whiteboard: buildWhiteboardTraceSummary(metadataSources),
    manualPhase: buildManualPhaseTraceSummary(metadataSources),
    diagramOverlay: buildDiagramOverlayTraceSummary(metadataSources),
    artifacts: {
      traceExportPath,
      summaryPath,
    },
    recordedAt: Date.now(),
  };
}

function buildSemanticTaxonomyTraceSummary(
  metadataSources: Array<Record<string, unknown>>
): SessionCompactTraceSummary["semanticTaxonomy"] {
  const mode = readFirstString(metadataSources, "semanticTaxonomyMode");
  const embeddingStatus = readFirstString(
    metadataSources,
    "taxonomySemanticEmbeddingStatus"
  );
  const hybridOutcome = readFirstString(
    metadataSources,
    "taxonomyHybridOutcome"
  );
  if (!mode && !embeddingStatus && !hybridOutcome) return undefined;

  return {
    mode,
    turnId: readFirstString(metadataSources, "semanticTaxonomyTurnId"),
    keywordType: readFirstString(metadataSources, "taxonomyKeywordType"),
    semanticCandidateType: readFirstString(
      metadataSources,
      "taxonomySemanticCandidateType"
    ),
    semanticTopCandidateType: readSemanticTopCandidateType(metadataSources),
    hybridOutcome,
    hybridEffectiveType: readFirstString(
      metadataSources,
      "taxonomyHybridEffectiveType"
    ),
    wouldRescue: readFirstBoolean(
      metadataSources,
      "taxonomyHybridWouldRescue"
    ),
    rescueApplied: readFirstBoolean(
      metadataSources,
      "taxonomySemanticRescueApplied"
    ),
    embeddingStatus,
    durationMs: readFirstNumberFromMetadata(
      metadataSources,
      "taxonomySemanticDurationMs"
    ),
    cacheHit: readFirstBoolean(
      metadataSources,
      "taxonomySemanticCacheHit"
    ),
    modelVersion: readFirstString(
      metadataSources,
      "taxonomySemanticModelVersion"
    ),
    prototypeVersion: readFirstString(
      metadataSources,
      "taxonomySemanticPrototypeVersion"
    ),
    calibrationVersion: readFirstString(
      metadataSources,
      "taxonomySemanticCalibrationVersion"
    ),
  };
}

function buildSemanticEmbeddingRuntimeTraceSummary(
  metadataSources: Array<Record<string, unknown>>
): SessionCompactTraceSummary["semanticEmbeddingRuntime"] {
  const consumer = readFirstString(
    metadataSources,
    "semanticEmbeddingConsumer"
  );
  const outcome = readFirstString(
    metadataSources,
    "semanticEmbeddingOutcome"
  );
  if (!consumer && !outcome) return undefined;

  return {
    requestId: readFirstString(
      metadataSources,
      "semanticEmbeddingRequestId"
    ),
    event: readFirstString(metadataSources, "semanticEmbeddingEvent"),
    consumer,
    coalescingKey: readFirstString(
      metadataSources,
      "semanticEmbeddingCoalescingKey"
    ),
    revision: readFirstNumberFromMetadata(
      metadataSources,
      "semanticEmbeddingRevision"
    ),
    outcome,
    queueWaitMs: readFirstNumberFromMetadata(
      metadataSources,
      "semanticEmbeddingQueueWaitMs"
    ),
    computeMs: readFirstNumberFromMetadata(
      metadataSources,
      "semanticEmbeddingComputeMs"
    ),
    totalMs: readFirstNumberFromMetadata(
      metadataSources,
      "semanticEmbeddingTotalMs"
    ),
    deadlineProfile: readFirstString(
      metadataSources,
      "semanticEmbeddingDeadlineProfile"
    ),
    deadlinePhase: readFirstString(
      metadataSources,
      "semanticEmbeddingDeadlinePhase"
    ),
    deadlineMs: readFirstNumberFromMetadata(
      metadataSources,
      "semanticEmbeddingDeadlineMs"
    ),
    coalesced: readFirstBoolean(
      metadataSources,
      "semanticEmbeddingCoalesced"
    ),
    stale: readFirstBoolean(metadataSources, "semanticEmbeddingStale"),
    abandoned: readFirstBoolean(
      metadataSources,
      "semanticEmbeddingAbandoned"
    ),
    cacheHit: readFirstBoolean(
      metadataSources,
      "semanticEmbeddingCacheHit"
    ),
    queueDepth: readFirstNumberFromMetadata(
      metadataSources,
      "semanticEmbeddingQueueDepth"
    ),
    maxQueueDepth: readFirstNumberFromMetadata(
      metadataSources,
      "semanticEmbeddingMaxQueueDepth"
    ),
    reason: readFirstString(metadataSources, "semanticEmbeddingReason"),
  };
}

function buildInterviewerIntentSemanticTraceSummary(
  metadataSources: Array<Record<string, unknown>>
): SessionCompactTraceSummary["interviewerIntentSemantic"] {
  const embeddingStatus = readFirstString(
    metadataSources,
    "interviewerIntentSemanticEmbeddingStatus"
  );
  const logicalQuestionUnitId = readFirstString(
    metadataSources,
    "interviewerIntentSemanticLogicalQuestionUnitId"
  );
  if (!embeddingStatus && !logicalQuestionUnitId) return undefined;
  return {
    embeddingStatus,
    durationMs: readFirstNumberFromMetadata(
      metadataSources,
      "interviewerIntentSemanticDurationMs"
    ),
    cacheHit: readFirstBoolean(
      metadataSources,
      "interviewerIntentSemanticCacheHit"
    ),
    logicalQuestionUnitId,
    logicalQuestionUnitRevision: readFirstNumberFromMetadata(
      metadataSources,
      "interviewerIntentSemanticLogicalQuestionUnitRevision"
    ),
    parentId: readFirstString(
      metadataSources,
      "interviewerIntentSemanticParentId"
    ),
    parentRevision: readFirstNumberFromMetadata(
      metadataSources,
      "interviewerIntentSemanticParentRevision"
    ),
    speechAct: readFirstString(
      metadataSources,
      "interviewerIntentSemanticSpeechAct"
    ),
    speechActConfidence: readFirstNumberFromMetadata(
      metadataSources,
      "interviewerIntentSemanticSpeechActConfidence"
    ),
    relation: readFirstString(
      metadataSources,
      "interviewerIntentSemanticRelation"
    ),
    relationConfidence: readFirstNumberFromMetadata(
      metadataSources,
      "interviewerIntentSemanticRelationConfidence"
    ),
    evidenceMode: readFirstString(
      metadataSources,
      "interviewerIntentSemanticEvidenceMode"
    ),
    evidenceModeConfidence: readFirstNumberFromMetadata(
      metadataSources,
      "interviewerIntentSemanticEvidenceModeConfidence"
    ),
    staleResultDropped: readFirstBoolean(
      metadataSources,
      "interviewerIntentSemanticStaleResultDropped"
    ),
    prototypeVersion: readFirstString(
      metadataSources,
      "interviewerIntentSemanticPrototypeVersion"
    ),
    calibrationVersion: readFirstString(
      metadataSources,
      "interviewerIntentSemanticCalibrationVersion"
    ),
  };
}

function buildInterviewerIntentLlmTraceSummary(
  metadataSources: Array<Record<string, unknown>>
): SessionCompactTraceSummary["interviewerIntentLlm"] {
  const operationId = readFirstString(
    metadataSources,
    "interviewerIntentLlmOperationId"
  );
  const disposition = readFirstString(
    metadataSources,
    "interviewerIntentLlmDisposition"
  );
  if (!operationId && !disposition) return undefined;
  return {
    mode: readFirstString(metadataSources, "interviewerIntentLlmMode"),
    eligible: readFirstBoolean(
      metadataSources,
      "interviewerIntentLlmEligible"
    ),
    skipReason: readFirstString(
      metadataSources,
      "interviewerIntentLlmSkipReason"
    ),
    promptVersion: readFirstString(
      metadataSources,
      "interviewerIntentLlmPromptVersion"
    ),
    schemaVersion: readFirstNumberFromMetadata(
      metadataSources,
      "interviewerIntentLlmSchemaVersion"
    ),
    outputContractVersion: readFirstNumberFromMetadata(
      metadataSources,
      "interviewerIntentLlmOutputContractVersion"
    ),
    parsedOutputContractVersion: readFirstNumberFromMetadata(
      metadataSources,
      "interviewerIntentLlmParsedOutputContractVersion"
    ),
    requestHash: readFirstString(
      metadataSources,
      "interviewerIntentLlmRequestHash"
    ),
    operationId,
    unitId: readFirstString(metadataSources, "interviewerIntentLlmUnitId"),
    unitRevision: readFirstNumberFromMetadata(
      metadataSources,
      "interviewerIntentLlmUnitRevision"
    ),
    scheduledTaskId: readFirstString(
      metadataSources,
      "interviewerIntentLlmScheduledTaskId"
    ),
    settlementTaskId: readFirstString(
      metadataSources,
      "interviewerIntentLlmSettlementTaskId"
    ),
    providerId: readFirstString(
      metadataSources,
      "interviewerIntentLlmProviderId"
    ),
    modelId: readFirstString(metadataSources, "interviewerIntentLlmModelId"),
    disposition,
    providerDisposition: readFirstString(
      metadataSources,
      "interviewerIntentLlmProviderDisposition"
    ),
    parseDisposition: readFirstString(
      metadataSources,
      "interviewerIntentLlmParseDisposition"
    ),
    parseErrorKind: readFirstString(
      metadataSources,
      "interviewerIntentLlmParseErrorKind"
    ),
    parseError: readFirstString(
      metadataSources,
      "interviewerIntentLlmParseError"
    ),
    outputEnvelope: readFirstString(
      metadataSources,
      "interviewerIntentLlmOutputEnvelope"
    ),
    staleReason: readFirstString(
      metadataSources,
      "interviewerIntentLlmStaleReason"
    ),
    leaseAuthorized: readFirstBoolean(
      metadataSources,
      "interviewerIntentLlmLeaseAuthorized"
    ),
    speechAct: readFirstString(
      metadataSources,
      "interviewerIntentLlmSpeechAct"
    ),
    questionType: readFirstString(
      metadataSources,
      "interviewerIntentLlmQuestionType"
    ),
    relation: readFirstString(
      metadataSources,
      "interviewerIntentLlmRelation"
    ),
    evidenceMode: readFirstString(
      metadataSources,
      "interviewerIntentLlmEvidenceMode"
    ),
    action: readFirstString(metadataSources, "interviewerIntentLlmAction"),
    primaryAskSpanCount: readFirstNumberFromMetadata(
      metadataSources,
      "interviewerIntentLlmPrimaryAskSpanCount"
    ),
    primaryAskSourceTurnIds: readFirstStringList(
      metadataSources,
      "interviewerIntentLlmPrimaryAskSourceTurnIds"
    ),
    localSpeechAct: readFirstString(
      metadataSources,
      "interviewerIntentLlmLocalSpeechAct"
    ),
    localQuestionType: readFirstString(
      metadataSources,
      "interviewerIntentLlmLocalQuestionType"
    ),
    localRelation: readFirstString(
      metadataSources,
      "interviewerIntentLlmLocalRelation"
    ),
    localEvidenceMode: readFirstString(
      metadataSources,
      "interviewerIntentLlmLocalEvidenceMode"
    ),
    localAction: readFirstString(
      metadataSources,
      "interviewerIntentLlmLocalAction"
    ),
    repairFactors: readFirstStringList(
      metadataSources,
      "interviewerIntentLlmRepairFactors"
    ),
    confidence: readFirstNumberFromMetadata(
      metadataSources,
      "interviewerIntentLlmConfidence"
    ),
    parseValid: readFirstBoolean(
      metadataSources,
      "interviewerIntentLlmParseValid"
    ),
    evidenceSpansValid: readFirstBoolean(
      metadataSources,
      "interviewerIntentLlmEvidenceSpansValid"
    ),
    arrivalStage: readFirstString(
      metadataSources,
      "interviewerIntentLlmArrivalStage"
    ),
    wouldRepair: readFirstBoolean(
      metadataSources,
      "interviewerIntentLlmWouldRepair"
    ),
    repairApplied: readFirstBoolean(
      metadataSources,
      "interviewerIntentLlmRepairApplied"
    ),
    durationMs: readFirstNumberFromMetadata(
      metadataSources,
      "interviewerIntentLlmDurationMs"
    ),
    inputChars: readFirstNumberFromMetadata(
      metadataSources,
      "interviewerIntentLlmInputChars"
    ),
    outputChars: readFirstNumberFromMetadata(
      metadataSources,
      "interviewerIntentLlmOutputChars"
    ),
    budgetSlot: readFirstString(
      metadataSources,
      "interviewerIntentLlmBudgetSlot"
    ),
    budgetReason: readFirstString(
      metadataSources,
      "interviewerIntentLlmBudgetReason"
    ),
    sourceOwnedSubstantive: readFirstBoolean(
      metadataSources,
      "interviewerIntentLlmSourceOwnedSubstantive"
    ),
    budgetStartsBefore: readFirstNumberFromMetadata(
      metadataSources,
      "interviewerIntentLlmBudgetStartsBefore"
    ),
    budgetStartsAfter: readFirstNumberFromMetadata(
      metadataSources,
      "interviewerIntentLlmBudgetStartsAfter"
    ),
    budgetLimit: readFirstNumberFromMetadata(
      metadataSources,
      "taxonomyAdjudicationBudgetLimit"
    ),
    budgetRemaining: readFirstNumberFromMetadata(
      metadataSources,
      "interviewerIntentLlmBudgetRemaining"
    ),
    ambientStarts: readFirstNumberFromMetadata(
      metadataSources,
      "taxonomyAdjudicationAmbientStarts"
    ),
    substantiveStarts: readFirstNumberFromMetadata(
      metadataSources,
      "taxonomyAdjudicationSubstantiveStarts"
    ),
    reservedSubstantiveAvailable: readFirstBoolean(
      metadataSources,
      "interviewerIntentLlmReservedSubstantiveAvailable"
    ),
  };
}

function buildCurrentQuestionTerminalNoAnswerTraceSummary(
  metadataSources: Array<Record<string, unknown>>
): SessionCompactTraceSummary["currentQuestionTerminalNoAnswer"] {
  const disposition = readFirstString(
    metadataSources,
    "currentQuestionTerminalNoAnswerDisposition"
  );
  const authorized = readFirstBoolean(
    metadataSources,
    "currentQuestionTerminalNoAnswerAuthorized"
  );
  const applied = readFirstBoolean(
    metadataSources,
    "interviewerIntentLlmTerminalNoAnswerApplied"
  );
  if (!disposition && authorized === undefined && applied === undefined) {
    return undefined;
  }

  return {
    disposition,
    authorized,
    applied,
    applyReason: readFirstString(
      metadataSources,
      "interviewerIntentLlmTerminalNoAnswerApplyReason"
    ),
    logicalQuestionUnitId: readFirstString(
      metadataSources,
      "currentQuestionTerminalNoAnswerUnitId"
    ),
    logicalQuestionUnitRevision: readFirstNumberFromMetadata(
      metadataSources,
      "currentQuestionTerminalNoAnswerRevision"
    ),
    sourceTurnCount: readFirstStringList(
      metadataSources,
      "currentQuestionTerminalNoAnswerSourceTurnIds"
    ).length,
    operationId: readFirstString(
      metadataSources,
      "currentQuestionTerminalNoAnswerOperationId"
    ),
    operationKind: readFirstString(
      metadataSources,
      "currentQuestionTerminalNoAnswerOperationKind"
    ),
    displayDisposition: readFirstString(
      metadataSources,
      "currentQuestionTerminalNoAnswerDisplayDisposition"
    ),
    contextDisposition: readFirstString(
      metadataSources,
      "currentQuestionTerminalNoAnswerContextDisposition"
    ),
    speechAct: readFirstString(
      metadataSources,
      "currentQuestionTerminalNoAnswerSpeechAct"
    ),
    action: readFirstString(
      metadataSources,
      "currentQuestionTerminalNoAnswerAction"
    ),
    confidence: readFirstNumberFromMetadata(
      metadataSources,
      "currentQuestionTerminalNoAnswerConfidence"
    ),
    reasons: readFirstStringList(
      metadataSources,
      "currentQuestionTerminalNoAnswerReasons"
    ),
    advisorMatched: readFirstBoolean(
      metadataSources,
      "taxonomyAdjudicationTerminalNoAnswerAdvisorMatched"
    ),
    advisorCancelled: readFirstBoolean(
      metadataSources,
      "interviewerIntentLlmTerminalNoAnswerAdvisorCancelled"
    ),
    memoryStarted: readFirstBoolean(
      metadataSources,
      "taxonomyAdjudicationTerminalNoAnswerMemoryStarted"
    ),
    modelStarted: readFirstBoolean(
      metadataSources,
      "taxonomyAdjudicationTerminalNoAnswerModelStarted"
    ),
    avoidedMemoryOpportunity: readFirstBoolean(
      metadataSources,
      "taxonomyAdjudicationTerminalNoAnswerAvoidedMemoryOpportunity"
    ),
    avoidedModelOpportunity: readFirstBoolean(
      metadataSources,
      "taxonomyAdjudicationTerminalNoAnswerAvoidedModelOpportunity"
    ),
  };
}

function buildAnswerSufficiencyTraceSummary(
  metadataSources: Array<Record<string, unknown>>
): SessionCompactTraceSummary["answerSufficiency"] {
  const status = readFirstString(
    metadataSources,
    "answerSufficiencyStatus"
  );
  const operationId = readFirstString(
    metadataSources,
    "answerSufficiencyOperationId"
  );
  if (!status && !operationId) return undefined;

  return {
    operationId,
    detectorVersion: readFirstString(
      metadataSources,
      "answerSufficiencyDetectorVersion"
    ),
    status,
    contextDefect: readFirstString(
      metadataSources,
      "answerContextDefect"
    ),
    recommendedRepair: readFirstString(
      metadataSources,
      "answerRepairRecommendation"
    ),
    confidence: readFirstNumberFromMetadata(
      metadataSources,
      "answerSufficiencyConfidence"
    ),
    lexicalEvidence: readFirstStringList(
      metadataSources,
      "answerSufficiencyLexicalEvidence"
    ),
    semanticPrototypeIds: readFirstStringList(
      metadataSources,
      "answerSufficiencySemanticPrototypeIds"
    ),
    semanticStatus: readFirstString(
      metadataSources,
      "answerSufficiencySemanticStatus"
    ),
    semanticConfidence: readFirstNumberFromMetadata(
      metadataSources,
      "answerSufficiencySemanticConfidence"
    ),
    semanticMargin: readFirstNumberFromMetadata(
      metadataSources,
      "answerSufficiencySemanticMargin"
    ),
    semanticDurationMs: readFirstNumberFromMetadata(
      metadataSources,
      "answerSufficiencySemanticDurationMs"
    ),
    semanticDisposition: readFirstString(
      metadataSources,
      "answerSufficiencySemanticDisposition"
    ),
    semanticRejectionReasons: readFirstStringList(
      metadataSources,
      "answerSufficiencySemanticRejectionReasons"
    ),
    expectedArtifacts: readFirstStringList(
      metadataSources,
      "answerExpectedArtifacts"
    ),
    missingArtifacts: readFirstStringList(
      metadataSources,
      "answerMissingArtifacts"
    ),
    logicalQuestionUnitId: readFirstString(
      metadataSources,
      "answerSufficiencyLogicalQuestionUnitId"
    ),
    logicalQuestionUnitRevision: readFirstNumberFromMetadata(
      metadataSources,
      "answerSufficiencyLogicalQuestionUnitRevision"
    ),
    answerRevision: readFirstNumberFromMetadata(
      metadataSources,
      "answerSufficiencyAnswerRevision"
    ),
    contextResolvable: readFirstBoolean(
      metadataSources,
      "contextResolvable"
    ),
    contextCandidateKinds: readFirstStringList(
      metadataSources,
      "contextCandidateKinds"
    ),
    contextCandidateSourceTurnIds: readFirstStringList(
      metadataSources,
      "contextCandidateSourceTurnIds"
    ),
    contextDeltaChars: readFirstNumberFromMetadata(
      metadataSources,
      "contextDeltaChars"
    ),
  };
}

function readSemanticTopCandidateType(
  metadataSources: Array<Record<string, unknown>>
) {
  for (const source of metadataSources) {
    const scores = source.taxonomySemanticPerTypeScores;
    if (!scores || typeof scores !== "object" || Array.isArray(scores)) {
      continue;
    }
    let bestType: string | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const [type, rawScore] of Object.entries(scores)) {
      if (!rawScore || typeof rawScore !== "object" || Array.isArray(rawScore)) {
        continue;
      }
      const candidate = rawScore as Record<string, unknown>;
      const score = readNumber(candidate.positiveScore);
      if (score === undefined || score <= bestScore) continue;
      bestScore = score;
      bestType = readString(candidate.questionType) ?? type;
    }
    if (bestType) return bestType;
  }
  return undefined;
}

function buildQuestionTypeAdjudicationOutcomeTraceSummary(
  metadataSources: Array<Record<string, unknown>>
): NonNullable<SessionCompactTraceSummary["questionTypeAdjudicationOutcome"]> {
  return {
    operationId: readFirstString(
      metadataSources,
      "questionTypeAdjudicationOutcomeOperationId"
    ),
    stage: readFirstString(
      metadataSources,
      "questionTypeAdjudicationOutcomeStage"
    ),
    disposition: readFirstString(
      metadataSources,
      "questionTypeAdjudicationOutcomeDisposition"
    ),
    settlementId: readFirstString(
      metadataSources,
      "questionTypeAdjudicationOutcomeSettlementId"
    ),
    outputAuthorityId: readFirstString(
      metadataSources,
      "questionTypeAdjudicationOutcomeAuthorityId"
    ),
    enforcementAuthorized: readFirstBoolean(
      metadataSources,
      "questionTypeAdjudicationOutcomeEnforcementAuthorized"
    ),
    settlementApplied: readFirstBoolean(
      metadataSources,
      "questionTypeAdjudicationOutcomeSettlementApplied"
    ),
    advisorStarted: readFirstBoolean(
      metadataSources,
      "questionTypeAdjudicationOutcomeAdvisorStarted"
    ),
    modelCompleted: readFirstBoolean(
      metadataSources,
      "questionTypeAdjudicationOutcomeModelCompleted"
    ),
    deliveryPending: readFirstBoolean(
      metadataSources,
      "questionTypeAdjudicationOutcomeDeliveryPending"
    ),
    visibleCommitted: readFirstBoolean(
      metadataSources,
      "questionTypeAdjudicationOutcomeVisibleCommitted"
    ),
    reason: readFirstString(
      metadataSources,
      "questionTypeAdjudicationOutcomeReason"
    ),
    recordedAt: readFirstNumberFromMetadata(
      metadataSources,
      "questionTypeAdjudicationOutcomeRecordedAt"
    ),
  };
}

function buildTaxonomyAdjudicationTraceSummary(
  metadataSources: Array<Record<string, unknown>>
): SessionCompactTraceSummary["taxonomyAdjudication"] {
  const mode = readFirstString(
    metadataSources,
    "taxonomyAdjudicationMode"
  );
  const eligible = readFirstBoolean(
    metadataSources,
    "taxonomyAdjudicationEligible"
  );
  const disposition = readFirstString(
    metadataSources,
    "taxonomyAdjudicationDisposition"
  );
  if (!mode && eligible === undefined && !disposition) return undefined;

  return {
    mode,
    eligible,
    skipReason: readFirstString(
      metadataSources,
      "taxonomyAdjudicationSkipReason"
    ),
    promptVersion: readFirstString(
      metadataSources,
      "taxonomyAdjudicationPromptVersion"
    ),
    schemaVersion: readFirstNumberFromMetadata(
      metadataSources,
      "taxonomyAdjudicationSchemaVersion"
    ),
    outputContractVersion: readFirstNumberFromMetadata(
      metadataSources,
      "taxonomyAdjudicationOutputContractVersion"
    ),
    parsedOutputContractVersion: readFirstNumberFromMetadata(
      metadataSources,
      "taxonomyAdjudicationParsedOutputContractVersion"
    ),
    requestHash: readFirstString(
      metadataSources,
      "taxonomyAdjudicationRequestHash"
    ),
    operationId: readFirstString(
      metadataSources,
      "taxonomyAdjudicationOperationId"
    ),
    unitId: readFirstString(metadataSources, "taxonomyAdjudicationUnitId"),
    unitRevision: readFirstNumberFromMetadata(
      metadataSources,
      "taxonomyAdjudicationUnitRevision"
    ),
    scheduledTaskId: readFirstString(
      metadataSources,
      "taxonomyAdjudicationScheduledTaskId"
    ),
    settlementTaskId: readFirstString(
      metadataSources,
      "taxonomyAdjudicationSettlementTaskId"
    ),
    providerId: readFirstString(
      metadataSources,
      "taxonomyAdjudicationProviderId"
    ),
    modelId: readFirstString(
      metadataSources,
      "taxonomyAdjudicationModelId"
    ),
    disposition,
    providerDisposition: readFirstString(
      metadataSources,
      "taxonomyAdjudicationProviderDisposition"
    ),
    parseDisposition: readFirstString(
      metadataSources,
      "taxonomyAdjudicationParseDisposition"
    ),
    parseErrorKind: readFirstString(
      metadataSources,
      "taxonomyAdjudicationParseErrorKind"
    ),
    parseError: readFirstString(
      metadataSources,
      "taxonomyAdjudicationParseError"
    ),
    outputEnvelope: readFirstString(
      metadataSources,
      "taxonomyAdjudicationOutputEnvelope"
    ),
    staleReason: readFirstString(
      metadataSources,
      "taxonomyAdjudicationStaleReason"
    ),
    leaseAuthorized: readFirstBoolean(
      metadataSources,
      "taxonomyAdjudicationLeaseAuthorized"
    ),
    candidateType: readFirstString(
      metadataSources,
      "taxonomyAdjudicationCandidateType"
    ),
    relation: readFirstString(
      metadataSources,
      "taxonomyAdjudicationRelation"
    ),
    standalone: readFirstBoolean(
      metadataSources,
      "taxonomyAdjudicationStandalone"
    ),
    confidence: readFirstNumberFromMetadata(
      metadataSources,
      "taxonomyAdjudicationConfidence"
    ),
    parseValid: readFirstBoolean(
      metadataSources,
      "taxonomyAdjudicationParseValid"
    ),
    evidenceSpansValid: readFirstBoolean(
      metadataSources,
      "taxonomyAdjudicationEvidenceSpansValid"
    ),
    arrivalStage: readFirstString(
      metadataSources,
      "taxonomyAdjudicationArrivalStage"
    ),
    wouldRepair: readFirstBoolean(
      metadataSources,
      "taxonomyAdjudicationWouldRepair"
    ),
    repairFactors: readFirstStringList(
      metadataSources,
      "taxonomyAdjudicationRepairFactors"
    ),
    repairApplied: readFirstBoolean(
      metadataSources,
      "taxonomyAdjudicationRepairApplied"
    ),
    durationMs: readFirstNumberFromMetadata(
      metadataSources,
      "taxonomyAdjudicationDurationMs"
    ),
    inputChars: readFirstNumberFromMetadata(
      metadataSources,
      "taxonomyAdjudicationInputChars"
    ),
    outputChars: readFirstNumberFromMetadata(
      metadataSources,
      "taxonomyAdjudicationOutputChars"
    ),
    rawOutputHash: readFirstString(
      metadataSources,
      "taxonomyAdjudicationRawOutputHash"
    ),
    rawOutputStored: readFirstBoolean(
      metadataSources,
      "taxonomyAdjudicationRawOutputStored"
    ),
    rawOutputTruncated: readFirstBoolean(
      metadataSources,
      "taxonomyAdjudicationRawOutputTruncated"
    ),
    providerConfigurationStatus: readFirstString(
      metadataSources,
      "taxonomyAdjudicationProviderConfigurationStatus"
    ),
    circuitOpen: readFirstBoolean(
      metadataSources,
      "taxonomyAdjudicationCircuitOpen"
    ),
    circuitReason: readFirstString(
      metadataSources,
      "taxonomyAdjudicationCircuitReason"
    ),
    circuitNewlyOpened: readFirstBoolean(
      metadataSources,
      "taxonomyAdjudicationCircuitNewlyOpened"
    ),
    budgetSlot: readFirstString(
      metadataSources,
      "taxonomyAdjudicationBudgetSlot"
    ),
    budgetReason: readFirstString(
      metadataSources,
      "taxonomyAdjudicationBudgetReason"
    ),
    sourceOwnedSubstantive: readFirstBoolean(
      metadataSources,
      "taxonomyAdjudicationSourceOwnedSubstantive"
    ),
    budgetStartsBefore: readFirstNumberFromMetadata(
      metadataSources,
      "taxonomyAdjudicationBudgetStartsBefore"
    ),
    budgetStartsAfter: readFirstNumberFromMetadata(
      metadataSources,
      "taxonomyAdjudicationBudgetStartsAfter"
    ),
    budgetLimit: readFirstNumberFromMetadata(
      metadataSources,
      "taxonomyAdjudicationBudgetLimit"
    ),
    budgetRemaining: readFirstNumberFromMetadata(
      metadataSources,
      "taxonomyAdjudicationBudgetRemaining"
    ),
    ambientStarts: readFirstNumberFromMetadata(
      metadataSources,
      "taxonomyAdjudicationAmbientStarts"
    ),
    substantiveStarts: readFirstNumberFromMetadata(
      metadataSources,
      "taxonomyAdjudicationSubstantiveStarts"
    ),
    reservedSubstantiveAvailable: readFirstBoolean(
      metadataSources,
      "taxonomyAdjudicationReservedSubstantiveAvailable"
    ),
  };
}

function buildSessionMetricsSummary(
  sessionId: string,
  summaries: SessionCompactTraceSummary[],
  humanEvaluations: TraceHumanEvaluation[] = []
): SessionMetricsSummary {
  const productionSummaries = summaries.filter(
    (summary) => !summary.syntheticValidation
  );
  return {
    version: SESSION_TRACE_SUMMARY_SCHEMA_VERSION,
    sessionId,
    savedAt: Date.now(),
    traceCount: productionSummaries.length,
    syntheticValidationTraceCount:
      summaries.length - productionSummaries.length,
    screen: aggregateTraceKind(
      productionSummaries.filter((summary) => summary.traceKind === "screen")
    ),
    voice: aggregateTraceKind(
      productionSummaries.filter((summary) => summary.traceKind === "voice")
    ),
    shortIntent: aggregateShortIntent(productionSummaries),
    answerStability: aggregateAnswerStability(
      productionSummaries,
      humanEvaluations
    ),
    errors: productionSummaries.filter((summary) => summary.status === "error")
      .length,
    cancelled: productionSummaries.filter(
      (summary) => summary.status === "cancelled"
    ).length,
  };
}

function aggregateAnswerStability(
  summaries: SessionCompactTraceSummary[],
  humanEvaluations: TraceHumanEvaluation[]
): SessionAnswerStabilityAggregate {
  const visibleRefreshWithoutPrimaryAsk = (
    summary: SessionCompactTraceSummary
  ) =>
    summary.visibleAnswerChanged === true &&
    summary.primaryAskSpanCount === 0 &&
    summary.refreshAuthorityHardOverride !== true;
  return {
    unauthorizedVisibleRefreshCount: summaries.filter(
      (summary) =>
        summary.advisorOutputCommittedToUi === true &&
        summary.refreshAuthorityAuthorized === false
    ).length,
    visibleRefreshWithoutPrimaryAskCount: summaries.filter(
      visibleRefreshWithoutPrimaryAsk
    ).length,
    visibleRefreshWithoutPrimaryAskByAuthority:
      countSessionVisibleRefreshesByAuthority(
        summaries.filter(visibleRefreshWithoutPrimaryAsk)
      ),
    suppressionRecommendedVisibleRefreshCount: summaries.filter(
      (summary) =>
        summary.visibleAnswerChanged === true &&
        summary.advisorWouldSuppress === true &&
        summary.refreshAuthorityHardOverride !== true
    ).length,
    primaryAskProjectionDisagreementCount: summaries.filter(
      (summary) =>
        summary.visibleAnswerChanged === true &&
        summary.primaryAskSpanCount === 0 &&
        summary.refreshAuthorityHardOverride !== true &&
        (summary.turnGateAction === "answer-refresh" ||
          summary.advisorTurnIntent === "direct-question" ||
          summary.advisorTurnIntent === "correction" ||
          summary.advisorTurnIntent === "constraint-or-follow-up" ||
          summary.runtimeIntentReleasedAction === "answer")
    ).length,
    runtimeIntentContradictedVisibleRefreshCount: summaries.filter(
      (summary) =>
        summary.visibleAnswerChanged === true &&
        (summary.runtimeIntentReleasedAction === "ignore" ||
          summary.runtimeIntentReleasedAction === "append-context")
    ).length,
    manualHardOverrideRefreshCount: summaries.filter(
      (summary) =>
        summary.refreshAuthorityHardOverride === true &&
        summary.visibleAnswerChanged === true
    ).length,
    staleGenerationCommitAttemptCount: summaries.filter(
      (summary) => summary.leaseAuthorizedAtCommit === false
    ).length,
    staleGenerationCommitRejectedCount: summaries.filter(
      (summary) => summary.staleCommitRejected === true
    ).length,
    codeMutationWithoutCodeIntentCount: summaries.filter(
      (summary) => summary.codeMutationWithoutCodeIntent === true
    ).length,
    deliveryLockCount: summaries.filter(
      (summary) =>
        summary.stableAnswerCommitDisposition === "pending" ||
        summary.answerDeliveryLockState === "update-ready"
    ).length,
    pendingCommitCount: summaries.filter(
      (summary) => summary.pendingAnswerDisposition === "committed"
    ).length,
    pendingDropCount: summaries.filter(
      (summary) =>
        summary.pendingAnswerDisposition === "stale" ||
        summary.pendingAnswerDisposition === "dropped"
    ).length,
    pendingWithoutVisibleAnswerCount: summaries.filter(
      (summary) =>
        summary.forceAdviseAutomaticExecutionState ===
          "delivery-pending" &&
        summary.advisorOutputCommittedToUi !== true
    ).length,
    deliveryLockBlockedFirstVisibleCommitCount: summaries.filter(
      (summary) =>
        summary.stableAnswerCommitDisposition === "pending" &&
        (summary.visibleAnswerRevisionBefore ?? 0) === 0
    ).length,
    forceAdviseRecoveredPendingCandidateCount: summaries.filter(
      (summary) =>
        summary.forceAdviseRecoveredPendingCandidate === true
    ).length,
    forceAdviseEligibleWithoutVisibleCommitCount: summaries.filter(
      (summary) =>
        summary.forceAdviseEligible === true &&
        summary.forceAdviseAutomaticExecutionState !==
          "visible-committed" &&
        summary.forceAdviseManualExecutionState !==
          "visible-committed"
    ).length,
    manualOverrideCount: summaries.filter(
      (summary) =>
        summary.refreshAuthorityHardOverride === true &&
        summary.visibleAnswerChanged === true
    ).length,
    incorrectVisibleRefreshLabelCount: humanEvaluations.filter((evaluation) =>
      evaluation.failureReasons.includes("incorrect-visible-refresh")
    ).length,
    midReadInterruptionLabelCount: humanEvaluations.filter((evaluation) =>
      evaluation.failureReasons.includes("mid-read-interruption")
    ).length,
    answerDwellMs: aggregateNumbers(
      summaries.map((summary) => summary.answerDwellMs)
    ),
  };
}

function aggregateShortIntent(
  summaries: SessionCompactTraceSummary[]
): SessionShortIntentAggregate {
  return {
    canonicalFillerSuppressedCount: summaries.filter(
      (summary) => summary.canonicalFillerSuppressed === true
    ).length,
    shortHighInformationAllowedCount: summaries.filter(
      (summary) => summary.shortHighInformationAllowed === true
    ).length,
    residualShortIntentAdjudicationCount: summaries.filter(
      (summary) =>
        summary.residualShortIntentAdjudicationRequired === true
    ).length,
    residualShortIntentIgnoreCount: summaries.filter(
      (summary) =>
        summary.shortIntentGateDecisionApplied === true &&
        summary.shortIntentGateAppliedAction === "ignore"
    ).length,
    residualShortIntentAnswerCount: summaries.filter(
      (summary) =>
        summary.shortIntentGateDecisionApplied === true &&
        summary.shortIntentGateAppliedAction === "answer"
    ).length,
    intentGateBudgetExhaustedCount: summaries.filter(
      (summary) => summary.shortIntentGateBudgetExhausted === true
    ).length,
    intentGateTimeoutCount: summaries.filter(
      (summary) => summary.shortIntentGateTimedOut === true
    ).length,
    intentGateDecisionAppliedCount: summaries.filter(
      (summary) => summary.shortIntentGateDecisionApplied === true
    ).length,
    intentGateDurationMs: aggregateNumbers(
      summaries.map((summary) => summary.shortIntentGateDurationMs)
    ),
  };
}

function countSessionVisibleRefreshesByAuthority(
  summaries: SessionCompactTraceSummary[]
) {
  return summaries.reduce<Record<string, number>>((counts, summary) => {
    const authority = summary.refreshAuthority ?? "unknown";
    counts[authority] = (counts[authority] ?? 0) + 1;
    return counts;
  }, {});
}

function aggregateTraceKind(
  summaries: SessionCompactTraceSummary[]
): SessionTraceKindAggregate {
  return {
    total: summaries.length,
    success: summaries.filter((summary) => summary.status === "success").length,
    error: summaries.filter((summary) => summary.status === "error").length,
    cancelled: summaries.filter((summary) => summary.status === "cancelled").length,
    durationMs: aggregateNumbers(
      summaries.map((summary) => summary.timingsMs.total)
    ),
    firstTokenFromTraceStartMs: aggregateNumbers(
      summaries.map((summary) => summary.timingsMs.firstTokenFromTraceStart)
    ),
    modelDurationMs: aggregateNumbers(
      summaries.map((summary) => summary.timingsMs.model)
    ),
    captureDurationMs: aggregateNumbers(
      summaries.map((summary) => summary.timingsMs.capture)
    ),
    sttDurationMs: aggregateNumbers(
      summaries.map((summary) => summary.timingsMs.stt)
    ),
    sttQueueAgeMs: aggregateNumbers(
      summaries.map((summary) => summary.sttRequest?.queueAgeMs)
    ),
    advisorDurationMs: aggregateNumbers(
      summaries.map((summary) => summary.timingsMs.advisor)
    ),
    sttValidation: {
      accepted: summaries.filter(
        (summary) => summary.sttValidation?.disposition === "accepted"
      ).length,
      empty: summaries.filter(
        (summary) => summary.sttValidation?.disposition === "empty"
      ).length,
      rejected: summaries.filter(
        (summary) => summary.sttValidation?.disposition === "rejected"
      ).length,
    },
    audioSegmentDisposition: {
      accepted: summaries.filter(
        (summary) =>
          summary.audioSegment?.disposition === "accepted"
      ).length,
      promptEchoRetryAccepted: summaries.filter(
        (summary) =>
          summary.audioSegment?.disposition ===
          "prompt-echo-retry-accepted"
      ).length,
      promptEchoRetryRejected: summaries.filter(
        (summary) =>
          summary.audioSegment?.disposition ===
          "prompt-echo-retry-rejected"
      ).length,
      sttError: summaries.filter(
        (summary) =>
          summary.audioSegment?.disposition === "stt-error"
      ).length,
      stale: summaries.filter(
        (summary) => summary.audioSegment?.disposition === "stale"
      ).length,
      duplicate: summaries.filter(
        (summary) =>
          summary.audioSegment?.disposition === "duplicate"
      ).length,
      invalidSequence: summaries.filter(
        (summary) =>
          summary.audioSegment?.disposition === "invalid-sequence"
      ).length,
    },
    nativeAudioBoundary: {
      silence: summaries.filter(
        (summary) =>
          summary.nativeAudioBoundary?.endReason === "silence"
      ).length,
      forcedRollover: summaries.filter(
        (summary) =>
          summary.nativeAudioBoundary?.endReason === "forced-rollover"
      ).length,
      stopDrain: summaries.filter(
        (summary) =>
          summary.nativeAudioBoundary?.endReason === "stop-drain"
      ).length,
      terminationDrain: summaries.filter(
        (summary) =>
          summary.nativeAudioBoundary?.endReason === "termination-drain"
      ).length,
      continuousStop: summaries.filter(
        (summary) =>
          summary.nativeAudioBoundary?.endReason === "continuous-stop"
      ).length,
      overlap: summaries.filter(
        (summary) =>
          (summary.nativeAudioBoundary?.overlapSampleCount ?? 0) > 0
      ).length,
    },
    sttRequestLifecycle: {
      abortRequested: summaries.filter(
        (summary) => summary.sttRequest?.abortRequested === true
      ).length,
      abortObserved: summaries.filter(
        (summary) => summary.sttRequest?.abortObserved === true
      ).length,
      providerTimeout: summaries.filter(
        (summary) => summary.sttRequest?.providerTimeout === true
      ).length,
      orphanCompletion: summaries.filter(
        (summary) => summary.sttRequest?.orphanCompletion === true
      ).length,
    },
  };
}

function buildNativeAudioBoundaryTraceSummary(
  metadataSources: Record<string, unknown>[]
): SessionCompactTraceSummary["nativeAudioBoundary"] {
  const sampleRate = readFirstNumberFromMetadata(
    metadataSources,
    "nativeSampleRate"
  );
  const endReason = readFirstString(
    metadataSources,
    "nativeSegmentEndReason"
  );
  if (sampleRate === undefined && !endReason) return undefined;

  return {
    sampleRate,
    sampleStart: readFirstNumberFromMetadata(
      metadataSources,
      "nativeSampleStart"
    ),
    sampleEnd: readFirstNumberFromMetadata(
      metadataSources,
      "nativeSampleEnd"
    ),
    durationMs: readFirstNumberFromMetadata(
      metadataSources,
      "nativeDurationMs"
    ),
    endReason,
    rolloverFamilyId: readFirstString(
      metadataSources,
      "nativeRolloverFamilyId"
    ),
    overlapSampleCount: readFirstNumberFromMetadata(
      metadataSources,
      "nativeOverlapSampleCount"
    ),
    overlapDurationMs: readFirstNumberFromMetadata(
      metadataSources,
      "nativeOverlapDurationMs"
    ),
    silenceTargetSamples: readFirstNumberFromMetadata(
      metadataSources,
      "nativeVadSilenceTargetSamples"
    ),
    minimumSpeechSamples: readFirstNumberFromMetadata(
      metadataSources,
      "nativeVadMinimumSpeechSamples"
    ),
    preSpeechSamples: readFirstNumberFromMetadata(
      metadataSources,
      "nativeVadPreSpeechSamples"
    ),
    maximumSegmentSamples: readFirstNumberFromMetadata(
      metadataSources,
      "nativeVadMaximumSegmentSamples"
    ),
  };
}

function buildAudioSegmentDispositionTraceSummary(
  metadataSources: Record<string, unknown>[]
): SessionCompactTraceSummary["audioSegment"] {
  const disposition = readFirstString(
    metadataSources,
    "audioSegmentCanonicalDisposition"
  );
  if (!disposition) return undefined;

  return {
    disposition,
    reason: readFirstString(
      metadataSources,
      "audioSegmentDispositionReason"
    ),
    observationCount: readFirstNumberFromMetadata(
      metadataSources,
      "audioSegmentObservationCount"
    ),
    duplicateObservationCount: readFirstNumberFromMetadata(
      metadataSources,
      "audioSegmentDuplicateObservationCount"
    ),
    canonicalCommitted: readFirstBoolean(
      metadataSources,
      "audioSegmentCanonicalDispositionCommitted"
    ),
  };
}

function buildSttValidationTraceSummary(
  metadataSources: Record<string, unknown>[]
): SessionCompactTraceSummary["sttValidation"] {
  const disposition = readFirstString(
    metadataSources,
    "sttValidationDisposition"
  );
  if (!disposition) return undefined;

  return {
    disposition,
    reason: readFirstString(metadataSources, "sttValidationReason"),
    promptSimilarity: readFirstNumberFromMetadata(
      metadataSources,
      "sttPromptSimilarity"
    ),
    audioDurationMs: readFirstNumberFromMetadata(
      metadataSources,
      "sttAudioDurationMs"
    ),
    transcriptCharsPerSecond: readFirstNumberFromMetadata(
      metadataSources,
      "sttTranscriptCharsPerSecond"
    ),
    densitySuspicious: readFirstBoolean(
      metadataSources,
      "sttDensitySuspicious"
    ),
  };
}

function buildSttRequestTraceSummary(
  metadataSources: Record<string, unknown>[]
): SessionCompactTraceSummary["sttRequest"] {
  const providerId = readFirstString(
    metadataSources,
    "sttRequestProviderId"
  );
  const configuredProviderId = readFirstString(
    metadataSources,
    "sttRequestConfiguredProviderId"
  );
  const modelId = readFirstString(metadataSources, "sttRequestModelId");
  const language = readFirstString(metadataSources, "sttRequestLanguage");
  const promptKind = readFirstString(
    metadataSources,
    "sttRequestPromptKind"
  );
  const queueAgeMs = readFirstNumberFromMetadata(
    metadataSources,
    "sttQueueAgeMs"
  );
  const lifecycleEvent = readFirstString(
    metadataSources,
    "sttRequestLifecycleEvent"
  );

  if (
    !providerId &&
    !configuredProviderId &&
    !modelId &&
    !language &&
    !promptKind &&
    queueAgeMs === undefined &&
    !lifecycleEvent
  ) {
    return undefined;
  }

  return {
    providerId,
    configuredProviderId,
    providerIdentityStatus: readFirstString(
      metadataSources,
      "sttRequestProviderIdentityStatus"
    ),
    modelId,
    modelSource: readFirstString(
      metadataSources,
      "sttRequestModelSource"
    ),
    language,
    languageMode: readFirstString(
      metadataSources,
      "sttRequestLanguageMode"
    ),
    languageSource: readFirstString(
      metadataSources,
      "sttRequestLanguageSource"
    ),
    promptKind,
    promptChars: readFirstNumberFromMetadata(
      metadataSources,
      "sttRequestPromptChars"
    ),
    promptHash: readFirstString(
      metadataSources,
      "sttRequestPromptHash"
    ),
    speechBiasChars: readFirstNumberFromMetadata(
      metadataSources,
      "sttRequestSpeechBiasChars"
    ),
    continuationChars: readFirstNumberFromMetadata(
      metadataSources,
      "sttRequestContinuationChars"
    ),
    promptTruncated: readFirstBoolean(
      metadataSources,
      "sttRequestPromptTruncated"
    ),
    termCount: readFirstNumberFromMetadata(
      metadataSources,
      "sttRequestTermCount"
    ),
    confidenceCapability: readFirstString(
      metadataSources,
      "sttRequestConfidenceCapability"
    ),
    evidenceDurationMs: readFirstNumberFromMetadata(
      metadataSources,
      "sttRequestEvidenceDurationMs"
    ),
    continuationDisposition: readFirstString(
      metadataSources,
      "sttContinuationDisposition"
    ),
    continuationReason: readFirstString(
      metadataSources,
      "sttContinuationReason"
    ),
    continuationLeaseId: readFirstString(
      metadataSources,
      "sttContinuationLeaseId"
    ),
    continuationOperationId: readFirstString(
      metadataSources,
      "sttContinuationOperationId"
    ),
    continuationSourceTurnId: readFirstString(
      metadataSources,
      "sttContinuationSourceTurnId"
    ),
    continuationSourceTraceId: readFirstString(
      metadataSources,
      "sttContinuationSourceTraceId"
    ),
    continuationCandidateSequence: readFirstNumberFromMetadata(
      metadataSources,
      "sttContinuationCandidateSequence"
    ),
    continuationLeaseExpiresAt: readFirstNumberFromMetadata(
      metadataSources,
      "sttContinuationLeaseExpiresAt"
    ),
    continuationLeaseConsumedAt: readFirstNumberFromMetadata(
      metadataSources,
      "sttContinuationLeaseConsumedAt"
    ),
    attemptCount: readFirstNumberFromMetadata(
      metadataSources,
      "sttAttemptCount"
    ),
    initialAttemptId: readFirstString(
      metadataSources,
      "sttInitialAttemptId"
    ),
    initialValidationDisposition: readFirstString(
      metadataSources,
      "sttInitialValidationDisposition"
    ),
    initialValidationReason: readFirstString(
      metadataSources,
      "sttInitialValidationReason"
    ),
    retryTriggered: readFirstBoolean(
      metadataSources,
      "sttRetryTriggered"
    ),
    retryDisposition: readFirstString(
      metadataSources,
      "sttRetryDisposition"
    ),
    retryReason: readFirstString(metadataSources, "sttRetryReason"),
    retryAttemptId: readFirstString(
      metadataSources,
      "sttRetryAttemptId"
    ),
    retryValidationDisposition: readFirstString(
      metadataSources,
      "sttRetryValidationDisposition"
    ),
    retryValidationReason: readFirstString(
      metadataSources,
      "sttRetryValidationReason"
    ),
    finalAttemptId: readFirstString(
      metadataSources,
      "sttFinalAttemptId"
    ),
    finalAttemptNumber: readFirstNumberFromMetadata(
      metadataSources,
      "sttFinalAttemptNumber"
    ),
    finalPromptMode: readFirstString(
      metadataSources,
      "sttFinalPromptMode"
    ),
    initialRequestDurationMs: readFirstNumberFromMetadata(
      metadataSources,
      "sttInitialRequestDurationMs"
    ),
    retryRequestDurationMs: readFirstNumberFromMetadata(
      metadataSources,
      "sttRetryRequestDurationMs"
    ),
    totalRequestDurationMs: readFirstNumberFromMetadata(
      metadataSources,
      "sttTotalRequestDurationMs"
    ),
    queueEnqueuedAt: readFirstNumberFromMetadata(
      metadataSources,
      "sttQueueEnqueuedAt"
    ),
    queueDequeuedAt: readFirstNumberFromMetadata(
      metadataSources,
      "sttQueueDequeuedAt"
    ),
    queueAgeMs,
    queueDepthAtEnqueue: readFirstNumberFromMetadata(
      metadataSources,
      "sttQueueDepthAtEnqueue"
    ),
    queueDepthAtDequeue: readFirstNumberFromMetadata(
      metadataSources,
      "sttQueueDepthAtDequeue"
    ),
    queueDequeueAuthorized: readFirstBoolean(
      metadataSources,
      "sttQueueDequeueAuthorized"
    ),
    lifecycleEvent,
    lifecycleAttemptId: readFirstString(
      metadataSources,
      "sttRequestLifecycleAttemptId"
    ),
    startedAt: readFirstNumberFromMetadata(
      metadataSources,
      "sttRequestStartedAt"
    ),
    endedAt: readFirstNumberFromMetadata(
      metadataSources,
      "sttRequestEndedAt"
    ),
    durationMs: readFirstNumberFromMetadata(
      metadataSources,
      "sttRequestDurationMs"
    ),
    timeoutMs: readFirstNumberFromMetadata(
      metadataSources,
      "sttRequestTimeoutMs"
    ),
    failureName: readFirstString(
      metadataSources,
      "sttRequestFailureName"
    ),
    abortRequested: readFirstBoolean(
      metadataSources,
      "sttRequestAbortRequested"
    ),
    abortRequestedAt: readFirstNumberFromMetadata(
      metadataSources,
      "sttRequestAbortRequestedAt"
    ),
    abortObserved: readFirstBoolean(
      metadataSources,
      "sttRequestAbortObserved"
    ),
    abortObservedAt: readFirstNumberFromMetadata(
      metadataSources,
      "sttRequestAbortObservedAt"
    ),
    abortReason: readFirstString(
      metadataSources,
      "sttRequestAbortReason"
    ),
    providerTimeout: readFirstBoolean(
      metadataSources,
      "sttProviderTimeout"
    ),
    providerSettledAfterAbortMs: readFirstNumberFromMetadata(
      metadataSources,
      "sttProviderSettledAfterAbortMs"
    ),
    orphanCompletion: readFirstBoolean(
      metadataSources,
      "sttRequestOrphanCompletion"
    ),
    orphanCompletedAt: readFirstNumberFromMetadata(
      metadataSources,
      "sttRequestOrphanCompletedAt"
    ),
    orphanProviderOutcome: readFirstString(
      metadataSources,
      "sttRequestOrphanProviderOutcome"
    ),
  };
}

function aggregateNumbers(values: Array<number | undefined>): SessionNumberAggregate {
  const sortedValues = values
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((left, right) => left - right);

  return {
    count: sortedValues.length,
    p50: percentile(sortedValues, 0.5),
    p90: percentile(sortedValues, 0.9),
    max: sortedValues[sortedValues.length - 1],
  };
}

function percentile(sortedValues: number[], percentileValue: number) {
  if (!sortedValues.length) return undefined;

  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * percentileValue) - 1)
  );
  return sortedValues[index];
}

function findStep(trace: MeetingTrace, stepName: string) {
  return trace.steps.find((step) => step.name === stepName);
}

function collectMetadataSources(trace: MeetingTrace) {
  return [trace.metadata, ...trace.steps.map((step) => step.metadata)].filter(
    (metadata): metadata is Record<string, unknown> => Boolean(metadata)
  );
}

function collectTaskIdsFromTrace(trace?: MeetingTrace) {
  if (!trace) return [];

  return uniqueStrings(
    collectMetadataSources(trace).flatMap((metadata) =>
      collectTaskIdsFromMetadata(metadata)
    )
  );
}

function collectTaskIdsFromMetadata(
  metadata?: Record<string, unknown>,
  explicitTaskId?: string
) {
  const taskIds = collectActiveMeetingTaskIdentityIds({
    metadata,
    explicitTaskId,
  });
  return uniqueStrings([
    ...taskIds,
    explicitTaskId,
    readString(metadata?.taskId),
    readString(metadata?.activeScreenTaskId),
    readString(metadata?.activeInterviewParentId),
    readString(metadata?.activeInterviewChildId),
  ]);
}

function summarizeCaptureTarget(value: unknown): SessionCompactTraceSummary["captureTarget"] {
  if (!isRecord(value)) return undefined;

  return {
    targetType: readString(value.targetType),
    captureMethod: readString(value.captureMethod),
    appName: readString(value.appName),
    title: readString(value.title),
    monitorName: readString(value.monitorName),
    fallbackReason: readString(value.fallbackReason),
    imageWidth: readNumber(value.imageWidth),
    imageHeight: readNumber(value.imageHeight),
    originalImageWidth: readNumber(value.originalImageWidth),
    originalImageHeight: readNumber(value.originalImageHeight),
  };
}

function buildProjectTrajectoryTraceSummary(
  trace: MeetingTrace,
  metadataSources: Record<string, unknown>[]
): SessionCompactTraceSummary["projectTrajectory"] {
  const parentId =
    readFirstString(metadataSources, "activeMeetingParentId") ??
    readFirstString(metadataSources, "sourceTransitionParentAfterId");
  const parentRevision =
    readFirstNumberFromMetadata(
      metadataSources,
      "activeMeetingParentRevision"
    ) ??
    readFirstNumberFromMetadata(
      metadataSources,
      "sourceTransitionParentAfterRevision"
    );
  const projectId =
    readFirstString(metadataSources, "activeMeetingProjectBindingId") ??
    readFirstString(metadataSources, "projectBindingProjectId");
  const projectName =
    readFirstString(metadataSources, "activeMeetingProjectBindingName") ??
    readFirstString(metadataSources, "projectBindingProjectName");
  const projectBindingRevision =
    readFirstNumberFromMetadata(
      metadataSources,
      "activeMeetingProjectBindingRevision"
    ) ??
    readFirstNumberFromMetadata(
      metadataSources,
      "projectBindingRevision"
    );
  const phase =
    readFirstString(metadataSources, "activeMeetingParentPhase") ??
    readFirstString(metadataSources, "playbookPhaseDecisionPhase") ??
    readFirstString(metadataSources, "playbookPhase");
  const factAnchorState = readFirstString(
    metadataSources,
    "factAnchorState"
  );
  const transitionKind = readFirstString(
    metadataSources,
    "sourceTransitionKind"
  );
  const childId =
    readFirstString(metadataSources, "activeMeetingChildId") ??
    readFirstString(metadataSources, "sourceTransitionChildAfterId");
  const returnParentId =
    readFirstString(
      metadataSources,
      "activeMeetingChildReturnParentId"
    ) ??
    readFirstString(
      metadataSources,
      "sourceTransitionReturnCapsuleParentId"
    );
  const claimSupport = readFirstClaimSupportCounts(metadataSources);
  if (
    !parentId &&
    !projectId &&
    !projectName &&
    !phase &&
    !factAnchorState &&
    !transitionKind
  ) {
    return undefined;
  }

  return {
    joinKey: buildProjectTrajectoryJoinKey({
      traceId: trace.id,
      parentId,
      projectBindingRevision,
    }),
    parentId,
    parentRevision,
    projectId,
    projectName,
    projectBindingRevision,
    phase,
    factAnchorState,
    factRequirementSource: readFirstString(
      metadataSources,
      "factAnchorRequirementSource"
    ),
    unsupportedClaimRisk: readFirstString(
      metadataSources,
      "unsupportedClaimRisk"
    ),
    factOutputCommitSource: readFirstString(
      metadataSources,
      "factAnchorOutputCommitSource"
    ),
    sanitizedClaimCount: readFirstNumberFromMetadata(
      metadataSources,
      "factAnchorSanitizedClaimCount"
    ),
    preservedClaimCount: readFirstNumberFromMetadata(
      metadataSources,
      "factAnchorPreservedClaimCount"
    ),
    claimSupportAllowCount: claimSupport.allow,
    claimSupportRejectCount: claimSupport.reject,
    claimSupportClarificationCount: claimSupport.needsClarification,
    transitionKind,
    childId,
    childIntent: readFirstString(
      metadataSources,
      "activeMeetingChildIntent"
    ),
    returnParentId,
    returnPhase:
      readFirstString(
        metadataSources,
        "activeMeetingChildReturnPhase"
      ) ??
      readFirstString(
        metadataSources,
        "sourceTransitionReturnCapsulePhase"
      ),
    returnProjectBindingRevision:
      readFirstNumberFromMetadata(
        metadataSources,
        "activeMeetingChildReturnProjectBindingRevision"
      ) ??
      readFirstNumberFromMetadata(
        metadataSources,
        "sourceTransitionReturnCapsuleProjectBindingRevision"
      ),
  };
}

function buildProjectTrajectoryJoinKey(input: {
  traceId?: string;
  parentId?: string;
  projectBindingRevision?: number;
}) {
  return [
    "project-trajectory",
    input.traceId ?? "snapshot",
    input.parentId ?? "unbound",
    input.projectBindingRevision ?? "no-binding-revision",
  ].join(":");
}

function readFirstClaimSupportCounts(
  metadataSources: Record<string, unknown>[]
) {
  for (const metadata of metadataSources) {
    const decisions = metadata.factAnchorClaimSupportDecisions;
    if (!Array.isArray(decisions)) continue;
    return decisions.reduce(
      (counts, value) => {
        if (!isRecord(value)) return counts;
        if (value.decision === "allow") counts.allow += 1;
        if (value.decision === "reject") counts.reject += 1;
        if (value.decision === "needs-clarification") {
          counts.needsClarification += 1;
        }
        return counts;
      },
      { allow: 0, reject: 0, needsClarification: 0 }
    );
  }
  return { allow: 0, reject: 0, needsClarification: 0 };
}

function readFirstString(
  metadataSources: Record<string, unknown>[],
  key: string
) {
  for (const metadata of metadataSources) {
    const value = readString(metadata[key]);
    if (value) return value;
  }

  return undefined;
}

function readFirstStringList(
  metadataSources: Record<string, unknown>[],
  key: string
) {
  for (const metadata of metadataSources) {
    const value = readStringList(metadata[key]);
    if (value.length) return value;
  }

  return [];
}

function readFirstObjectListLength(
  metadataSources: Record<string, unknown>[],
  key: string
) {
  for (const metadata of metadataSources) {
    const value = metadata[key];
    if (Array.isArray(value)) return value.length;
  }

  return undefined;
}

function readFirstNumberFromMetadata(
  metadataSources: Record<string, unknown>[],
  key: string
) {
  for (const metadata of metadataSources) {
    const value = readNumber(metadata[key]);
    if (value !== undefined) return value;
  }

  return undefined;
}

function readFirstBoolean(
  metadataSources: Record<string, unknown>[],
  key: string
) {
  for (const metadata of metadataSources) {
    const value = metadata[key];
    if (typeof value === "boolean") return value;
  }

  return undefined;
}

function buildWhiteboardTraceSummary(
  metadataSources: Record<string, unknown>[]
): SessionCompactTraceSummary["whiteboard"] {
  const metadata = readMeetingEvalTraceMetadata(metadataSources);
  const artifactId = metadata.whiteboardArtifactId;
  const revision = metadata.whiteboardArtifactRevision;
  const domainTrack = metadata.whiteboardArtifactDomainTrack;
  const validationOperationId = readFirstString(
    metadataSources,
    "whiteboardRenderValidationOperationId"
  );
  const repairOperationId = readFirstString(
    metadataSources,
    "whiteboardRepairOperationId"
  );
  const formatPreference = readFirstString(
    metadataSources,
    "whiteboardFormatPreference"
  );
  if (
    !artifactId &&
    revision === undefined &&
    !domainTrack &&
    !validationOperationId &&
    !repairOperationId &&
    !formatPreference
  ) {
    return undefined;
  }
  return {
    artifactId,
    revision,
    domainTrack,
    validationOperationId,
    candidateKind: readFirstString(
      metadataSources,
      "whiteboardRenderCandidateKind"
    ),
    candidateRevision: readFirstNumberFromMetadata(
      metadataSources,
      "whiteboardRenderCandidateRevision"
    ),
    validationDisposition: readFirstString(
      metadataSources,
      "whiteboardRenderValidationDisposition"
    ),
    validationDurationMs: readFirstNumberFromMetadata(
      metadataSources,
      "whiteboardRenderValidationDurationMs"
    ),
    parserErrorClass: readFirstString(
      metadataSources,
      "whiteboardRenderParserErrorClass"
    ),
    sanitationDisposition: readFirstString(
      metadataSources,
      "whiteboardRenderSanitationDisposition"
    ),
    sanitationChanges: readFirstStringList(
      metadataSources,
      "whiteboardRenderSanitationChanges"
    ),
    originalParserErrorClass: readFirstString(
      metadataSources,
      "whiteboardRenderOriginalParserErrorClass"
    ),
    visibleRevisionBefore: readFirstNumberFromMetadata(
      metadataSources,
      "whiteboardRenderVisibleRevisionBefore"
    ),
    visibleRevisionAfter: readFirstNumberFromMetadata(
      metadataSources,
      "whiteboardRenderVisibleRevisionAfter"
    ),
    preservedLastValid: readFirstBoolean(
      metadataSources,
      "whiteboardRenderPreservedLastValid"
    ),
    renderStatus: readFirstString(
      metadataSources,
      "whiteboardRenderStatus"
    ),
    fallbackKind: readFirstString(
      metadataSources,
      "whiteboardRenderFallbackKind"
    ),
    fallbackReason: readFirstString(
      metadataSources,
      "whiteboardRenderFallbackReason"
    ),
    repairOperationId,
    repairDisposition: readFirstString(
      metadataSources,
      "whiteboardRepairDisposition"
    ),
    repairProviderDisposition: readFirstString(
      metadataSources,
      "whiteboardRepairProviderDisposition"
    ),
    repairParseDisposition: readFirstString(
      metadataSources,
      "whiteboardRepairParseDisposition"
    ),
    repairQueueWaitMs: readFirstNumberFromMetadata(
      metadataSources,
      "whiteboardRepairQueueWaitMs"
    ),
    repairDurationMs: readFirstNumberFromMetadata(
      metadataSources,
      "whiteboardRepairDurationMs"
    ),
    repairRevalidationDisposition: readFirstString(
      metadataSources,
      "whiteboardRepairRevalidationDisposition"
    ),
    repairBehaviorMutationBlocked: readFirstBoolean(
      metadataSources,
      "whiteboardRepairBehaviorMutationBlocked"
    ),
    formatPreference,
    mermaidEligible: readFirstBoolean(
      metadataSources,
      "whiteboardMermaidEligible"
    ),
    mermaidRequested: readFirstBoolean(
      metadataSources,
      "whiteboardMermaidRequested"
    ),
    mermaidCommitted: readFirstBoolean(
      metadataSources,
      "whiteboardMermaidCommitted"
    ),
    formatPolicyMiss: readFirstBoolean(
      metadataSources,
      "whiteboardFormatPolicyMiss"
    ),
    formatConversionAttempted: readFirstBoolean(
      metadataSources,
      "whiteboardFormatConversionAttempted"
    ),
    formatConversionDisposition: readFirstString(
      metadataSources,
      "whiteboardFormatConversionDisposition"
    ),
    asciiFallback: readFirstBoolean(
      metadataSources,
      "whiteboardAsciiFallback"
    ),
    asciiFallbackReason: readFirstString(
      metadataSources,
      "whiteboardAsciiFallbackReason"
    ),
  };
}

function buildManualPhaseTraceSummary(
  metadataSources: Record<string, unknown>[]
): SessionCompactTraceSummary["manualPhase"] {
  const metadata = readMeetingEvalTraceMetadata(metadataSources);
  const from = metadata.manualPhaseFrom;
  const to = metadata.manualPhaseTo;
  const targetArtifact = metadata.manualPhaseTargetArtifact;
  const guardStatus = metadata.manualPhaseGuardStatus;
  const committed = metadata.manualPhaseAdvanceCommitted;
  if (
    !from &&
    !to &&
    !targetArtifact &&
    !guardStatus &&
    committed === undefined
  ) {
    return undefined;
  }
  return {
    from,
    to,
    targetArtifact,
    guardStatus,
    committed,
  };
}

function buildDiagramOverlayTraceSummary(
  metadataSources: Record<string, unknown>[]
): SessionCompactTraceSummary["diagramOverlay"] {
  const metadata = readMeetingEvalTraceMetadata(metadataSources);
  const selectedEntryIds = metadata.selectedDiagramOverlayIds ?? [];
  const rejectedCount = metadata.rejectedDiagramOverlayCount;
  const rejectSummary = metadata.diagramOverlayRejectSummary;
  if (!selectedEntryIds.length && rejectedCount === undefined && !rejectSummary) {
    return undefined;
  }
  return {
    selectedEntryIds,
    rejectedCount,
    rejectSummary,
  };
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readMemoryRejectSummary(value: unknown): MemoryRejectSummary[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const summary = value.flatMap((item): MemoryRejectSummary[] => {
    if (!isRecord(item)) return [];
    const reason = readString(item.reason);
    const count = readNumber(item.count);
    if (!reason || count === undefined) return [];

    return [
      {
        reason: reason as MemoryRejectSummary["reason"],
        count,
        sampleEntryIds: readStringList(item.sampleEntryIds),
        sampleTitles: readStringList(item.sampleTitles),
      },
    ];
  });

  return summary.length ? summary : undefined;
}

function readStringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value)))
  );
}

function sameStringList(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
