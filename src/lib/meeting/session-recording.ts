import { invoke } from "@tauri-apps/api/core";
import { TYPE_PROVIDER } from "@/types";
import { MemoryRetrievalResult } from "@/lib/memory";
import {
  ActiveScreenTask,
  InterviewSessionBrief,
  InterviewSessionContext,
  MeetingAssistantSettings,
  MeetingSessionRecordingState,
  MeetingTrace,
  MeetingTraceExportTrigger,
  ScreenObservation,
  TraceHumanEvaluation,
  TranscriptTurn,
} from "./types";
import { createMeetingId } from "./context-manager";
import { serializeMeetingTraceExport } from "./trace";

const SESSION_RECORDING_SCHEMA_VERSION = 1;
const SESSION_TRACE_SUMMARY_SCHEMA_VERSION = 1;
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
  sttProviderId?: string;
  hasMainProvider: boolean;
  hasCodingProvider: boolean;
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
    | "playbook-selected"
    | "trace-export"
    | "trace-metrics"
    | "human-evaluation"
    | "task-snapshot"
    | "runtime-reset"
    | "runtime-continued"
    | "error";
  createdAt: number;
  source: "meeting-assistant";
  metadata?: Record<string, unknown>;
  artifactRefs?: string[];
}

interface ActiveSessionRecording {
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
}

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

interface SessionCompactTraceSummary {
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
  taskIds: string[];
  primaryTaskId?: string;
  activeScreenTaskId?: string;
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
  providerId?: string;
  mode?: string;
  responseLength?: string;
  responseLanguage?: string;
  modelRoute?: string;
  modelRouteReason?: string;
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
    rejectedCount?: number;
    totalChars?: number;
    useCase?: string;
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
}

interface SessionNumberAggregate {
  count: number;
  p50?: number;
  p90?: number;
  max?: number;
}

export class SessionRecordingManager {
  private activeSession?: ActiveSessionRecording;
  private writeQueue: Promise<void> = Promise.resolve();
  private onChange?: (state: MeetingSessionRecordingState) => void;

  constructor(onChange?: (state: MeetingSessionRecordingState) => void) {
    this.onChange = onChange;
  }

  getState(): MeetingSessionRecordingState {
    if (!this.activeSession) {
      return {
        active: false,
        eventCount: 0,
        artifactCount: 0,
      };
    }

    return {
      active: true,
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
    if (this.activeSession) return this.getState();

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

    const folderPath = await invoke<string>("start_meeting_session_recording", {
      folderName,
      manifestPayload: JSON.stringify(initialManifest, null, 2),
      readmePayload: buildSessionRecordingReadme(sessionId),
    });
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

    this.activeSession = {
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
    };
    this.emit();

    await this.writeJson("manifest.json", manifestBase);
    await this.writeJson("settings/meeting-assistant-settings.json", {
      savedAt: Date.now(),
      settings: sanitizeMeetingAssistantSettings(options.settings),
    });
    await this.writeJson("settings/interview-brief.json", {
      savedAt: Date.now(),
      interviewSessionBrief: options.interviewSessionBrief,
      interviewSessionContext: options.interviewSessionContext,
    });
    await this.writeJson("settings/provider-summary.json", {
      savedAt: Date.now(),
      providerSummary: options.providerSummary,
    });
    this.recordEvent("session-started", {
      folderPath,
      privacy: "raw audio omitted",
    });

    return this.getState();
  }

  async stop(reason = "manual") {
    const session = this.activeSession;
    if (!session) return this.getState();

    const endedAt = Date.now();
    this.recordEvent("session-stopped", { reason, endedAt });
    await this.writeQueue.catch(() => {});
    await this.writeJson("manifest.json", {
      ...session.manifestBase,
      status: "stopped",
      endedAt,
      durationMs: endedAt - session.startedAt,
      stopReason: reason,
      eventCount: session.eventCount,
      artifactCount: session.artifactCount,
      lastError: session.lastError,
    });

    this.activeSession = undefined;
    this.emit();
    return this.getState();
  }

  canRecordTrace(trace: Pick<MeetingTrace, "startedAt">) {
    return Boolean(
      this.activeSession && trace.startedAt >= this.activeSession.startedAt
    );
  }

  hasRecordedTrace(traceId: string) {
    return Boolean(this.activeSession?.recordedTraceIds.has(traceId));
  }

  recordTranscriptTurn(turn: TranscriptTurn) {
    const session = this.activeSession;
    if (!session) return;

    const payload = `${JSON.stringify(turn)}\n`;
    session.recordedTurnIds.add(turn.id);
    this.enqueue(async () => {
      await this.writeText("transcripts/turns.jsonl", payload, true);
      await this.writeText(
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
    const session = this.activeSession;
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
      this.enqueue(() =>
        this.writeBase64(imagePath, observation.imageBase64 ?? "")
      );
    }
    if (observation.focusImageBase64) {
      const focusPath = `${basePath}.focus.${focusExtension}`;
      artifactRefs.push(focusPath);
      this.enqueue(() =>
        this.writeBase64(focusPath, observation.focusImageBase64 ?? "")
      );
    }

    artifactRefs.push(metadataPath);
    this.enqueue(() =>
      this.writeJson(metadataPath, {
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
    const session = this.activeSession;
    if (!session) return;

    const path = buildTraceArtifactPath(traceId, "prompts", label, "txt");
    session.recordedTraceIds.add(traceId);
    if (taskId) session.recordedTaskIds.add(taskId);
    this.enqueue(() => this.writeText(path, value));
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
    const session = this.activeSession;
    if (!session) return;

    const path = buildTraceArtifactPath(traceId, "outputs", label, "md");
    session.recordedTraceIds.add(traceId);
    if (taskId) session.recordedTaskIds.add(taskId);
    this.enqueue(() => this.writeText(path, value));
    this.recordEvent("model-output", { label, valueChars: value.length, metadata }, [
      path,
    ], traceId, taskId);
  }

  recordMemoryRetrieval({
    traceId,
    taskId,
    query,
    source,
    memoryContext,
    metadata,
  }: {
    traceId?: string;
    taskId?: string;
    query: string;
    source: "advisor" | "screen";
    memoryContext: MemoryRetrievalResult;
    metadata?: Record<string, unknown>;
  }) {
    const session = this.activeSession;
    if (!session) return;

    const baseName = `${traceId ?? createMeetingId("memory")}-${Date.now()}`;
    if (traceId) session.recordedTraceIds.add(traceId);
    if (taskId) session.recordedTaskIds.add(taskId);
    const jsonPath = `memory/${sanitizeFilePart(baseName)}.json`;
    const contextPath = `memory/${sanitizeFilePart(baseName)}.context.md`;
    this.enqueue(async () => {
      await this.writeJson(jsonPath, {
        query,
        source,
        metadata,
        memoryContext,
      });
      await this.writeText(contextPath, memoryContext.contextText);
    });
    this.recordEvent(
      "memory-retrieval",
      {
        source,
        queryChars: query.length,
        selectedEntries: memoryContext.entries.length,
        candidateCount: memoryContext.candidateCount,
        rejectedCount: memoryContext.rejectedCount,
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
    const session = this.activeSession;
    if (!session) return;
    if (traceId) session.recordedTraceIds.add(traceId);
    if (taskId) session.recordedTaskIds.add(taskId);
    this.recordEvent("playbook-selected", metadata, undefined, traceId, taskId);
  }

  recordTaskSnapshot(task: ActiveScreenTask, traceId?: string) {
    const session = this.activeSession;
    if (!session) return;

    const path = `tasks/${sanitizeFilePart(task.id)}/task.json`;
    session.recordedTaskIds.add(task.id);
    if (traceId) session.recordedTraceIds.add(traceId);
    this.enqueue(() => this.writeJson(path, task));
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

  recordTrace(trace: MeetingTrace, trigger: MeetingTraceExportTrigger) {
    const session = this.activeSession;
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
    this.enqueue(() => this.writeText(path, payload));
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
    const session = this.activeSession;
    if (!session) return;

    const filteredPayload = filterTraceMetricsPayload(
      payload,
      session.recordedTraceIds
    );
    this.enqueue(async () => {
      await this.writeText("metrics/trace-metrics.json", filteredPayload);
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
    const session = this.activeSession;
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
    this.enqueue(async () => {
      await this.writeText("human-evaluation/evaluations.json", payload);
      await this.writeText(
        "human-evaluation/evaluations.jsonl",
        `${compactPayload}\n`,
        true
      );
    });
    this.recordEvent("human-evaluation", {
      evaluationCount: sessionEvaluations.length,
    }, ["human-evaluation/evaluations.json"]);
  }

  recordRuntimeBoundary(
    kind: "runtime-reset" | "runtime-continued",
    metadata?: Record<string, unknown>
  ) {
    if (!this.activeSession) return;
    this.recordEvent(kind, metadata);
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
    const session = this.activeSession;
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
    this.enqueue(() =>
      this.writeText("timeline.jsonl", `${JSON.stringify(event)}\n`, true)
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
    const session = this.activeSession;
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

    this.enqueue(async () => {
      await this.writeText(
        "metrics/trace-session-index.jsonl",
        `${JSON.stringify(nextEntry)}\n`,
        true
      );
      await this.writeJson("metrics/trace-session-index.latest.json", {
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
    const session = this.activeSession;
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

    this.enqueue(async () => {
      if (!existing) {
        await this.writeText(
          "metrics/trace-summaries.jsonl",
          `${JSON.stringify(summary)}\n`,
          true
        );
      }
      await this.writeJson("metrics/trace-summaries.latest.json", {
        version: SESSION_TRACE_SUMMARY_SCHEMA_VERSION,
        savedAt: Date.now(),
        sessionId: session.sessionId,
        traces: summaries,
      });
      await this.writeJson(summaryPath, summary);
      await this.writeJson("metrics/session-summary.json", sessionSummary);
    });
  }

  private async writeJson(relativePath: string, value: unknown) {
    await this.writeText(relativePath, JSON.stringify(value, null, 2));
  }

  private async writeText(relativePath: string, payload: string, append = false) {
    const session = this.activeSession;
    if (!session) return;

    await invoke<string>("write_meeting_session_recording_text", {
      folderName: session.folderName,
      relativePath,
      payload,
      append,
    });
  }

  private async writeBase64(relativePath: string, base64Payload: string) {
    const session = this.activeSession;
    if (!session) return;

    await invoke<string>("write_meeting_session_recording_base64", {
      folderName: session.folderName,
      relativePath,
      base64Payload,
    });
  }

  private enqueue(write: () => Promise<void>) {
    this.writeQueue = this.writeQueue
      .then(write)
      .catch((error) => {
        this.setError(error instanceof Error ? error.message : String(error));
      });
  }

  private setError(message: string) {
    if (this.activeSession) {
      this.activeSession.lastError = message;
    }
    this.emit();
  }

  private emit() {
    this.onChange?.(this.getState());
  }
}

export function buildSessionRecordingProviderSummary({
  mainProvider,
  codingProvider,
  sttProvider,
  mainProviderId,
  codingProviderId,
  sttProviderId,
}: {
  mainProvider?: TYPE_PROVIDER;
  codingProvider?: TYPE_PROVIDER;
  sttProvider?: TYPE_PROVIDER;
  mainProviderId?: string;
  codingProviderId?: string;
  sttProviderId?: string;
}): SessionRecordingProviderSummary {
  return {
    mainProviderId,
    codingProviderId,
    sttProviderId,
    hasMainProvider: Boolean(mainProvider),
    hasCodingProvider: Boolean(codingProvider),
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
    taskIds,
    primaryTaskId: taskIds[0],
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
    playbookPhase: readFirstString(metadataSources, "playbookPhase"),
    playbookSubtype: readFirstString(metadataSources, "playbookSubtype"),
    turnGateAction: readFirstString(metadataSources, "turnGateAction"),
    turnGateReason: readFirstString(metadataSources, "turnGateReason"),
    providerId: readString(modelStep?.metadata?.providerId),
    mode: readString(modelStep?.metadata?.mode),
    responseLength: readString(modelStep?.metadata?.responseLength),
    responseLanguage: readString(modelStep?.metadata?.responseLanguage),
    modelRoute: readFirstString(metadataSources, "modelRoute"),
    modelRouteReason: readFirstString(metadataSources, "modelRouteReason"),
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
          rejectedCount: readNumber(memoryStep.metadata?.rejectedCount),
          totalChars: readNumber(memoryStep.metadata?.totalChars),
          useCase: readString(memoryStep.metadata?.useCase),
        }
      : undefined,
    artifacts: {
      traceExportPath,
      summaryPath,
    },
    recordedAt: Date.now(),
  };
}

function buildSessionMetricsSummary(
  sessionId: string,
  summaries: SessionCompactTraceSummary[]
): SessionMetricsSummary {
  return {
    version: SESSION_TRACE_SUMMARY_SCHEMA_VERSION,
    sessionId,
    savedAt: Date.now(),
    traceCount: summaries.length,
    screen: aggregateTraceKind(
      summaries.filter((summary) => summary.traceKind === "screen")
    ),
    voice: aggregateTraceKind(
      summaries.filter((summary) => summary.traceKind === "voice")
    ),
    errors: summaries.filter((summary) => summary.status === "error").length,
    cancelled: summaries.filter((summary) => summary.status === "cancelled").length,
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
  const taskIds = [
    explicitTaskId,
    readString(metadata?.taskId),
    readString(metadata?.activeScreenTaskId),
    readString(metadata?.activeInterviewParentId),
    readString(metadata?.activeInterviewChildId),
  ];

  return uniqueStrings(taskIds);
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

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
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
