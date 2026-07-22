import { invoke } from "@tauri-apps/api/core";
import { TYPE_PROVIDER } from "@/types";
import type { MemoryRejectSummary, MemoryRetrievalResult } from "@/lib/memory";
import {
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
import { serializeMeetingTraceExport } from "./trace.js";

const SESSION_RECORDING_SCHEMA_VERSION = 1;
const SESSION_TRACE_SUMMARY_SCHEMA_VERSION = 5;
const SESSION_TRACE_INDEX_SCHEMA_VERSION = 1;

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
    | "task-snapshot"
    | "active-meeting-task-snapshot"
    | "manual-question-type-correction"
    | "semantic-taxonomy-decision"
    | "taxonomy-adjudication-decision"
    | "capture-lifecycle"
    | "native-speech-event"
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
  questionHumanEvaluations: Map<string, QuestionHumanEvaluation>;
  writeQueue: Promise<void>;
  enqueueVersion: number;
  pendingWrites: number;
  acceptedWrites: number;
  rejectedLateWrites: number;
  drainPasses: number;
  closingAt?: number;
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
  turnGateAction?: string;
  turnGateReason?: string;
  advisorTurnIntent?: string;
  advisorTurnConfidence?: number;
  advisorTurnEnforcement?: string;
  advisorWouldSuppress?: boolean;
  advisorExecutionAuthorized?: boolean;
  advisorExecutionSuppressedReason?: string;
  taskMutationAuthorized?: boolean;
  taskMutationAuthorizationReason?: string;
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
  semanticTaxonomy?: {
    mode?: string;
    turnId?: string;
    keywordType?: string;
    semanticCandidateType?: string;
    hybridOutcome?: string;
    wouldRescue?: boolean;
    rescueApplied?: boolean;
    embeddingStatus?: string;
    durationMs?: number;
    cacheHit?: boolean;
    modelVersion?: string;
    prototypeVersion?: string;
    calibrationVersion?: string;
  };
  taxonomyAdjudication?: {
    mode?: string;
    eligible?: boolean;
    skipReason?: string;
    operationId?: string;
    unitId?: string;
    unitRevision?: number;
    providerId?: string;
    disposition?: string;
    staleReason?: string;
    candidateType?: string;
    relation?: string;
    standalone?: boolean;
    confidence?: number;
    parseValid?: boolean;
    evidenceSpansValid?: boolean;
    arrivalStage?: string;
    wouldRepair?: boolean;
    repairApplied?: boolean;
    durationMs?: number;
    inputChars?: number;
    outputChars?: number;
  };
  personalEvidence?: {
    requirement?: string;
    confidence?: number;
    confidenceTier?: string;
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
  };
  sttValidation?: {
    disposition: string;
    reason?: string;
    promptSimilarity?: number;
    audioDurationMs?: number;
    transcriptCharsPerSecond?: number;
    densitySuspicious?: boolean;
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
  };
  whiteboard?: {
    artifactId?: string;
    revision?: number;
    domainTrack?: string;
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
  errors: number;
  cancelled: number;
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
  advisorDurationMs: SessionNumberAggregate;
  sttValidation: {
    accepted: number;
    empty: number;
    rejected: number;
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
          questionHumanEvaluations: new Map(),
          writeQueue: Promise.resolve(),
          enqueueVersion: 0,
          pendingWrites: 0,
          acceptedWrites: 0,
          rejectedLateWrites: 0,
          drainPasses: 0,
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
        session.phase = "sealed";
        await Promise.resolve();
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
    const reviewIndex = buildSessionTaskReviewIndex(
      session.sessionId,
      Array.from(session.traceSummaries.values()),
      Array.from(session.questionHumanEvaluations.values())
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

  recordRuntimeBoundary(
    kind: "runtime-reset" | "runtime-continued",
    metadata?: Record<string, unknown>
  ) {
    if (!this.getWritableSession()) return;
    this.recordEvent(kind, metadata);
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
    const artifactPath = "taxonomy/llm-adjudications.jsonl";
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
      "taxonomy-adjudication-decision",
      metadata,
      [artifactPath],
      traceId,
      taskId
    );

    const existing = session.traceSummaries.get(traceId);
    if (!existing) return;
    const updated: SessionCompactTraceSummary = {
      ...existing,
      taxonomyAdjudication: buildTaxonomyAdjudicationTraceSummary([metadata]),
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
      summaries
    );
    const reviewIndex = buildSessionTaskReviewIndex(
      session.sessionId,
      summaries,
      Array.from(session.questionHumanEvaluations.values())
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
    await this.invokeCommand<string>("write_meeting_session_recording_text", {
      folderName: session.folderName,
      relativePath,
      payload,
      append,
    });
  }

  private async writeBase64(
    session: ActiveSessionRecording,
    relativePath: string,
    base64Payload: string
  ) {
    await this.invokeCommand<string>("write_meeting_session_recording_base64", {
      folderName: session.folderName,
      relativePath,
      base64Payload,
    });
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
        this.setSessionError(
          session,
          error instanceof Error ? error.message : String(error)
        );
      })
      .finally(() => {
        session.pendingWrites -= 1;
      });
    return true;
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
}: {
  mainProvider?: TYPE_PROVIDER;
  codingProvider?: TYPE_PROVIDER;
  taxonomyAdjudicationProvider?: TYPE_PROVIDER;
  sttProvider?: TYPE_PROVIDER;
  mainProviderId?: string;
  codingProviderId?: string;
  taxonomyAdjudicationProviderId?: string;
  sttProviderId?: string;
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
    recordingRoot: "app-data/meeting-session-recordings",
    settings: sanitizeMeetingAssistantSettings(settings),
    interviewSessionBrief,
    interviewSessionContext,
    providerSummary,
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

function buildCompactTraceSummary({
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
    advisorWouldSuppress: readFirstBoolean(
      metadataSources,
      "advisorWouldSuppress"
    ),
    advisorExecutionAuthorized: readFirstBoolean(
      metadataSources,
      "advisorExecutionAuthorized"
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
    semanticTaxonomy: buildSemanticTaxonomyTraceSummary(metadataSources),
    taxonomyAdjudication:
      buildTaxonomyAdjudicationTraceSummary(metadataSources),
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
    },
    sttValidation: buildSttValidationTraceSummary(metadataSources),
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
      stt: sttStep?.durationMs,
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
      transcriptChars: readNumber(sttStep?.metadata?.transcriptChars),
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
    hybridOutcome,
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
    operationId: readFirstString(
      metadataSources,
      "taxonomyAdjudicationOperationId"
    ),
    unitId: readFirstString(metadataSources, "taxonomyAdjudicationUnitId"),
    unitRevision: readFirstNumberFromMetadata(
      metadataSources,
      "taxonomyAdjudicationUnitRevision"
    ),
    providerId: readFirstString(
      metadataSources,
      "taxonomyAdjudicationProviderId"
    ),
    disposition,
    staleReason: readFirstString(
      metadataSources,
      "taxonomyAdjudicationStaleReason"
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
  };
}

function buildSessionMetricsSummary(
  sessionId: string,
  summaries: SessionCompactTraceSummary[]
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
    errors: productionSummaries.filter((summary) => summary.status === "error")
      .length,
    cancelled: productionSummaries.filter(
      (summary) => summary.status === "cancelled"
    ).length,
  };
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
  if (!artifactId && revision === undefined && !domainTrack) return undefined;
  return {
    artifactId,
    revision,
    domainTrack,
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
