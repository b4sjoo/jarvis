import { createMeetingId } from "./meeting-id.js";
import {
  MeetingTrace,
  MeetingTraceExportTrigger,
  MeetingTraceIO,
  MeetingTraceKind,
  MeetingTraceStatus,
  MeetingTraceStep,
} from "./types.js";

import { invoke } from "@tauri-apps/api/core";

const MAX_TRACE_ITEMS = 500;
const DEFAULT_SUMMARY_WINDOW_SIZE = 20;
const PERSISTED_TRACE_METRICS_VERSION = 2;
const MEETING_TRACE_EXPORT_VERSION = 1;
export const PERSISTED_TRACE_METRICS_BYTE_BUDGET = Math.floor(
  1.75 * 1024 * 1024
);

export interface MeetingTraceChange {
  changed: MeetingTrace[];
  removedTraceIds: string[];
  reset: boolean;
}

export class MeetingTraceStore {
  private traces: MeetingTrace[] = [];
  private currentProcessTraceIds = new Set<string>();
  private onChange?: (traces: MeetingTrace[], change: MeetingTraceChange) => void;
  private snapshots = new WeakMap<MeetingTrace, MeetingTrace>();
  private debugEnabled = false;

  constructor(debugEnabled = false) {
    this.debugEnabled = debugEnabled;
  }

  subscribe(onChange: (traces: MeetingTrace[], change: MeetingTraceChange) => void) {
    this.onChange = onChange;
    this.emit(this.traces, [], true);
    return () => { if (this.onChange === onChange) this.onChange = undefined; };
  }

  setDebugEnabled(debugEnabled: boolean) {
    if (this.debugEnabled === debugEnabled) return;

    const wasDebugEnabled = this.debugEnabled;
    this.debugEnabled = debugEnabled;
    this.log("debug-mode", { enabled: debugEnabled }, wasDebugEnabled);
  }

  getTraces() {
    return this.traces.map(cloneTrace);
  }

  getTrace(traceId: string) {
    const trace = this.traces.find((item) => item.id === traceId);
    return trace ? cloneTrace(trace) : undefined;
  }

  getObserverSnapshot() {
    return this.traces.map((trace) => this.snapshot(trace));
  }

  hydrate(traces: MeetingTrace[]) {
    const previousIds = this.traces.map((trace) => trace.id);
    const mergedById = new Map<string, MeetingTrace>();
    for (const trace of traces.map(sanitizeTraceForPersistence)) {
      mergedById.set(trace.id, trace);
    }
    for (const trace of this.traces) {
      mergedById.set(trace.id, cloneTrace(trace));
    }

    const merged = Array.from(mergedById.values()).sort(compareTracesNewestFirst);
    const currentProcessTraces = merged.filter((trace) =>
      this.currentProcessTraceIds.has(trace.id)
    );
    const persistedHistory = merged.filter(
      (trace) => !this.currentProcessTraceIds.has(trace.id)
    );
    this.traces = [
      ...currentProcessTraces,
      ...persistedHistory.slice(
        0,
        Math.max(0, MAX_TRACE_ITEMS - currentProcessTraces.length)
      ),
    ]
      .sort(compareTracesNewestFirst)
      .slice(0, MAX_TRACE_ITEMS);
    const retainedIds = new Set(this.traces.map((trace) => trace.id));
    this.emit(this.traces, previousIds.filter((id) => !retainedIds.has(id)), true);
  }

  getPersistableTraces() {
    return this.traces.map(sanitizeTraceForPersistence);
  }

  clear() {
    const removedIds = this.traces.map((trace) => trace.id);
    this.traces = [];
    this.currentProcessTraceIds.clear();
    this.log("traces-cleared");
    this.emit([], removedIds, true);
  }

  startTrace(
    kind: MeetingTraceKind,
    metadata?: Record<string, unknown>,
    startedAt = Date.now()
  ): MeetingTrace {
    const trace: MeetingTrace = {
      id: createMeetingId(`${kind}_trace`),
      kind,
      status: "running",
      startedAt,
      steps: [],
      inputs: [],
      outputs: [],
      metadata,
    };

    this.currentProcessTraceIds.add(trace.id);
    const removed = this.traces.slice(MAX_TRACE_ITEMS - 1);
    this.traces = [trace, ...this.traces].slice(0, MAX_TRACE_ITEMS);
    this.log("trace-started", {
      id: trace.id,
      kind: trace.kind,
      metadata: trace.metadata,
    });
    this.emit([trace], removed.map((item) => item.id));
    return cloneTrace(trace);
  }

  startStep(
    traceId: string,
    name: string,
    metadata?: Record<string, unknown>
  ) {
    const step: MeetingTraceStep = {
      id: createMeetingId("trace_step"),
      name,
      status: "running",
      startedAt: Date.now(),
      metadata,
    };

    this.updateTrace(traceId, (trace) => {
      trace.steps.push(step);
    });
    this.log("step-started", {
      traceId,
      stepId: step.id,
      name,
      metadata,
    });

    return step.id;
  }

  finishStep(
    traceId: string,
    stepId: string | undefined,
    status: MeetingTraceStatus = "success",
    metadata?: Record<string, unknown>,
    error?: unknown
  ) {
    if (!stepId) return;

    this.updateTrace(traceId, (trace) => {
      const step = trace.steps.find((candidate) => candidate.id === stepId);
      if (!step) return;
      if (step.status !== "running") return;

      const endedAt = Date.now();
      step.status = status;
      step.endedAt = endedAt;
      step.durationMs = endedAt - step.startedAt;
      step.metadata = { ...step.metadata, ...metadata };
      step.error = stringifyError(error);
      this.log("step-finished", {
        traceId,
        stepId,
        name: step.name,
        status,
        durationMs: step.durationMs,
        metadata: step.metadata,
        error: step.error,
      });
    });
  }

  recordInput(
    traceId: string,
    label: string,
    value: string,
    metadata?: Record<string, unknown>
  ) {
    this.recordIO(traceId, "inputs", {
      label,
      value,
      metadata,
      recordedAt: Date.now(),
    });
    this.log("input-recorded", {
      traceId,
      label,
      valueChars: value.length,
      metadata,
    });
  }

  recordOutput(
    traceId: string,
    label: string,
    value: string,
    metadata?: Record<string, unknown>
  ) {
    this.recordIO(traceId, "outputs", {
      label,
      value,
      metadata,
      recordedAt: Date.now(),
    });
    this.log("output-recorded", {
      traceId,
      label,
      valueChars: value.length,
      metadata,
    });
  }

  updateMetadata(traceId: string, metadata: Record<string, unknown>) {
    this.updateTrace(traceId, (trace) => {
      trace.metadata = { ...trace.metadata, ...metadata };
    });
    this.log("trace-metadata-updated", { traceId, metadata });
  }

  finishTrace(
    traceId: string,
    status: MeetingTraceStatus = "success",
    error?: unknown
  ) {
    this.updateTrace(traceId, (trace) => {
      const endedAt = Date.now();
      trace.status = status;
      trace.endedAt = endedAt;
      trace.durationMs = endedAt - trace.startedAt;
      trace.error = stringifyError(error);
      this.log("trace-finished", {
        traceId,
        kind: trace.kind,
        status,
        durationMs: trace.durationMs,
        error: trace.error,
      });
    });
  }

  private recordIO(
    traceId: string,
    key: "inputs" | "outputs",
    value: MeetingTraceIO
  ) {
    this.updateTrace(traceId, (trace) => {
      trace[key].push(value);
    });
  }

  private updateTrace(traceId: string, update: (trace: MeetingTrace) => void) {
    let changed: MeetingTrace | undefined;
    this.traces = this.traces.map((trace) => {
      if (trace.id !== traceId) return trace;

      const nextTrace = cloneTrace(trace);
      update(nextTrace);
      changed = nextTrace;
      return nextTrace;
    });

    if (changed) this.emit([changed]);
  }

  private snapshot(trace: MeetingTrace) {
    let snapshot = this.snapshots.get(trace);
    if (!snapshot) {
      snapshot = cloneTrace(trace);
      this.snapshots.set(trace, snapshot);
    }
    return snapshot;
  }

  private emit(changed: MeetingTrace[], removedTraceIds: string[] = [], reset = false) {
    if (!this.onChange) return;
    // Stable observer snapshots reuse unchanged records; public reads remain isolated copies.
    this.onChange(this.getObserverSnapshot(), {
      changed: changed.map((trace) => this.snapshot(trace)), removedTraceIds, reset,
    });
  }

  private log(
    event: string,
    details?: Record<string, unknown>,
    force = false
  ) {
    if (!force && !this.debugEnabled) return;

    const message = formatTraceLogLine(event, details);
    console.info(message);
    void invoke("write_meeting_trace_log", { message }).catch(() => {});
  }
}

export interface MeetingTraceValueSummary {
  count: number;
  p50?: number;
  p90?: number;
}

export interface MeetingTraceKindSummary {
  total: number;
  success: number;
  error: number;
  cancelled: number;
  running: number;
  totalDurationMs: MeetingTraceValueSummary;
  captureDurationMs?: MeetingTraceValueSummary;
  preflightDurationMs?: MeetingTraceValueSummary;
  firstTokenLatencyMs?: MeetingTraceValueSummary;
  modelDurationMs?: MeetingTraceValueSummary;
  sttDurationMs?: MeetingTraceValueSummary;
  advisorFirstTokenLatencyMs?: MeetingTraceValueSummary;
  advisorDurationMs?: MeetingTraceValueSummary;
  imagePayloadChars?: MeetingTraceValueSummary;
  audioBytes?: MeetingTraceValueSummary;
  outputChars?: MeetingTraceValueSummary;
}

export interface MeetingAnswerStabilitySummary {
  unauthorizedVisibleRefreshCount: number;
  visibleRefreshWithoutPrimaryAskCount: number;
  visibleRefreshWithoutPrimaryAskByAuthority: Record<string, number>;
  primaryAskProjectionDisagreementCount: number;
  runtimeIntentContradictedVisibleRefreshCount: number;
  manualHardOverrideRefreshCount: number;
  staleGenerationCommitAttemptCount: number;
  staleGenerationCommitRejectedCount: number;
  codeMutationWithoutCodeIntentCount: number;
  deliveryLockCount: number;
  pendingCommitCount: number;
  pendingDropCount: number;
  manualOverrideCount: number;
  answerDwellMs: MeetingTraceValueSummary;
}

export interface MeetingShortIntentSummary {
  canonicalFillerSuppressedCount: number;
  shortHighInformationAllowedCount: number;
  residualShortIntentAdjudicationCount: number;
  residualShortIntentIgnoreCount: number;
  residualShortIntentAnswerCount: number;
  intentGateBudgetExhaustedCount: number;
  intentGateTimeoutCount: number;
  intentGateDecisionAppliedCount: number;
  intentGateDurationMs: MeetingTraceValueSummary;
}

export interface MeetingTraceSummary {
  windowSize: number;
  traceCount: number;
  syntheticValidationTraceCount: number;
  screen: MeetingTraceKindSummary;
  voice: MeetingTraceKindSummary;
  shortIntent: MeetingShortIntentSummary;
  answerStability: MeetingAnswerStabilitySummary;
}

export interface PersistedMeetingTraceMetrics {
  version: number;
  savedAt: number;
  traces: MeetingTrace[];
  retention?: PersistedMeetingTraceRetention;
}

export interface PersistedMeetingTraceRetention {
  byteBudget: number;
  retainedBytes: number;
  sourceTraceCount: number;
  retainedTraceCount: number;
  droppedTraceCount: number;
  compactedTraceCount: number;
  order: "newest-first";
}

export interface MeetingTraceExportOptions {
  trigger: MeetingTraceExportTrigger;
  slowThresholdMs?: number;
}

export interface ExportedMeetingTrace {
  version: number;
  exportedAt: number;
  trigger: MeetingTraceExportTrigger;
  slowThresholdMs?: number;
  privacy: {
    rawScreenshotsIncluded: false;
    rawAudioIncluded: false;
    note: string;
  };
  trace: MeetingTrace;
}

export function serializeMeetingTraceMetrics(traces: MeetingTrace[]) {
  const sanitizedTraces = traces
    .map(sanitizeTraceForPersistence)
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, MAX_TRACE_ITEMS);
  const sourceTraceCount = sanitizedTraces.length;
  const savedAt = resolvePersistedTraceSavedAt(sanitizedTraces);

  const serializePrefix = (retainedTraceCount: number) =>
    stringifyPersistedTraceMetrics({
      traces: sanitizedTraces.slice(0, retainedTraceCount),
      savedAt,
      sourceTraceCount,
      compactedTraceCount: 0,
    });

  let low = 0;
  let high = sourceTraceCount;
  let bestPayload = serializePrefix(0);
  let bestTraceCount = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = serializePrefix(middle);
    if (utf8ByteLength(candidate) <= PERSISTED_TRACE_METRICS_BYTE_BUDGET) {
      bestPayload = candidate;
      bestTraceCount = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (bestTraceCount > 0 || sourceTraceCount === 0) return bestPayload;

  const compactedNewestTrace = compactTraceForPersistenceBudget(
    sanitizedTraces[0]
  );
  const compactedPayload = stringifyPersistedTraceMetrics({
    traces: [compactedNewestTrace],
    savedAt,
    sourceTraceCount,
    compactedTraceCount: 1,
  });
  if (
    utf8ByteLength(compactedPayload) <=
    PERSISTED_TRACE_METRICS_BYTE_BUDGET
  ) {
    return compactedPayload;
  }

  return stringifyPersistedTraceMetrics({
    traces: [],
    savedAt,
    sourceTraceCount,
    compactedTraceCount: 0,
  });
}

export function serializeMeetingTraceExport(
  trace: MeetingTrace,
  options: MeetingTraceExportOptions
) {
  const payload: ExportedMeetingTrace = {
    version: MEETING_TRACE_EXPORT_VERSION,
    exportedAt: Date.now(),
    trigger: options.trigger,
    slowThresholdMs: options.slowThresholdMs,
    privacy: {
      rawScreenshotsIncluded: false,
      rawAudioIncluded: false,
      note:
        "This export keeps text prompts, model/STT outputs, timing, status, and metadata. Raw screenshots, screenshot base64, raw audio, and audio base64 are not included by default.",
    },
    trace: sanitizeTraceForExport(trace),
  };

  return JSON.stringify(payload, null, 2);
}

export function parseMeetingTraceMetrics(payload: string): MeetingTrace[] {
  if (!payload.trim()) return [];

  try {
    const parsed = JSON.parse(payload) as Partial<PersistedMeetingTraceMetrics>;
    if (!Array.isArray(parsed.traces)) return [];

    return parsed.traces
      .filter(isMeetingTraceLike)
      .map(sanitizeTraceForPersistence)
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, MAX_TRACE_ITEMS);
  } catch {
    return [];
  }
}

function stringifyPersistedTraceMetrics({
  traces,
  savedAt,
  sourceTraceCount,
  compactedTraceCount,
}: {
  traces: MeetingTrace[];
  savedAt: number;
  sourceTraceCount: number;
  compactedTraceCount: number;
}) {
  const retention: PersistedMeetingTraceRetention = {
    byteBudget: PERSISTED_TRACE_METRICS_BYTE_BUDGET,
    retainedBytes: 0,
    sourceTraceCount,
    retainedTraceCount: traces.length,
    droppedTraceCount: Math.max(0, sourceTraceCount - traces.length),
    compactedTraceCount,
    order: "newest-first",
  };
  const persisted: PersistedMeetingTraceMetrics = {
    version: PERSISTED_TRACE_METRICS_VERSION,
    savedAt,
    traces,
    retention,
  };

  let payload = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    payload = JSON.stringify(persisted);
    const retainedBytes = utf8ByteLength(payload);
    if (retention.retainedBytes === retainedBytes) return payload;
    retention.retainedBytes = retainedBytes;
  }

  return JSON.stringify(persisted);
}

function resolvePersistedTraceSavedAt(traces: MeetingTrace[]) {
  let savedAt = 0;
  for (const trace of traces) {
    savedAt = Math.max(savedAt, trace.startedAt, trace.endedAt ?? 0);
    for (const step of trace.steps) {
      savedAt = Math.max(savedAt, step.startedAt, step.endedAt ?? 0);
    }
  }
  return savedAt;
}

function compactTraceForPersistenceBudget(trace: MeetingTrace): MeetingTrace {
  return {
    id: trace.id,
    kind: trace.kind,
    status: trace.status,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    durationMs: trace.durationMs,
    steps: trace.steps.slice(0, 80).map((step) => ({
      id: step.id,
      name: truncatePersistedText(step.name, 160) ?? "",
      status: step.status,
      startedAt: step.startedAt,
      endedAt: step.endedAt,
      durationMs: step.durationMs,
      error: truncatePersistedText(step.error, 320),
    })),
    inputs: [],
    outputs: [],
    metadata: compactPersistenceMetadata(trace.metadata),
    error: truncatePersistedText(trace.error, 500),
  };
}

function compactPersistenceMetadata(
  metadata: Record<string, unknown> | undefined
) {
  if (!metadata) return undefined;

  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata).slice(0, 80)) {
    if (typeof value === "string") {
      compacted[key] = truncatePersistedText(value, 320);
    } else if (
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      compacted[key] = value;
    }
  }
  return Object.keys(compacted).length ? compacted : undefined;
}

function truncatePersistedText(value: string | undefined, maxChars: number) {
  if (!value || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function summarizeMeetingTraces(
  traces: MeetingTrace[],
  windowSize = DEFAULT_SUMMARY_WINDOW_SIZE
): MeetingTraceSummary {
  const syntheticValidationTraceCount = traces.filter(
    isSyntheticValidationTrace
  ).length;
  const recentTraces = traces
    .filter((trace) => !isSyntheticValidationTrace(trace))
    .slice(0, windowSize);

  return {
    windowSize,
    traceCount: recentTraces.length,
    syntheticValidationTraceCount,
    screen: summarizeTraceKind(
      recentTraces.filter((trace) => trace.kind === "screen"),
      "screen"
    ),
    voice: summarizeTraceKind(
      recentTraces.filter((trace) => trace.kind === "voice"),
      "voice"
    ),
    shortIntent: summarizeShortIntent(recentTraces),
    answerStability: summarizeAnswerStability(recentTraces),
  };
}

export function isSyntheticValidationTrace(trace: MeetingTrace) {
  return trace.metadata?.syntheticValidation === true;
}

function sanitizeTraceForExport(trace: MeetingTrace): MeetingTrace {
  return {
    ...cloneTrace(trace),
    steps: trace.steps.map((step) => ({
      ...step,
      metadata: sanitizeExportMetadata(step.metadata),
    })),
    inputs: trace.inputs.map((input) => ({
      ...input,
      value: sanitizeExportText(input.value),
      metadata: sanitizeExportMetadata(input.metadata),
    })),
    outputs: trace.outputs.map((output) => ({
      ...output,
      value: sanitizeExportText(output.value),
      metadata: sanitizeExportMetadata(output.metadata),
    })),
    metadata: sanitizeExportMetadata(trace.metadata),
  };
}

function summarizeTraceKind(
  traces: MeetingTrace[],
  kind: MeetingTraceKind
): MeetingTraceKindSummary {
  const summary: MeetingTraceKindSummary = {
    total: traces.length,
    success: traces.filter((trace) => trace.status === "success").length,
    error: traces.filter((trace) => trace.status === "error").length,
    cancelled: traces.filter((trace) => trace.status === "cancelled").length,
    running: traces.filter((trace) => trace.status === "running").length,
    totalDurationMs: summarizeValues(
      traces.map((trace) => trace.durationMs).filter(isNumber)
    ),
  };

  if (kind === "screen") {
    summary.captureDurationMs = summarizeValues(
      stepDurations(traces, "Screen capture command")
    );
    summary.preflightDurationMs = summarizeValues(
      stepDurations(traces, "Screen preflight")
    );
    summary.firstTokenLatencyMs = summarizeValues(
      traceMetadataLatencies(traces, "screenFirstTokenAt", "startedAt")
    );
    summary.modelDurationMs = summarizeValues(
      stepDurations(traces, "Screen model response")
    );
    summary.imagePayloadChars = summarizeValues(
      traces
        .map((trace) => {
          const captureStep = findStep(trace, "Screen capture command");
          const imageChars = readNumber(captureStep?.metadata?.imageChars) ?? 0;
          const focusImageChars =
            readNumber(captureStep?.metadata?.focusImageChars) ?? 0;
          const totalChars = imageChars + focusImageChars;
          return totalChars > 0 ? totalChars : undefined;
        })
        .filter(isNumber)
    );
    summary.outputChars = summarizeValues(
      stepMetadataValues(traces, "Screen model response", "outputChars")
    );
  } else {
    summary.sttDurationMs = summarizeValues(sttRequestDurations(traces));
    summary.advisorFirstTokenLatencyMs = summarizeValues(
      traceMetadataLatencies(traces, "advisorFirstTokenAt", "startedAt")
    );
    summary.advisorDurationMs = summarizeValues(
      stepDurations(traces, "Advisor model response")
    );
    summary.audioBytes = summarizeValues(
      stepMetadataValues(traces, "Audio blob created", "audioBytes")
    );
    summary.outputChars = summarizeValues(
      stepMetadataValues(traces, "Advisor model response", "outputChars")
    );
  }

  return summary;
}

function summarizeAnswerStability(
  traces: MeetingTrace[]
): MeetingAnswerStabilitySummary {
  const metadata = traces.map((trace) => trace.metadata ?? {});
  const count = (predicate: (value: Record<string, unknown>) => boolean) =>
    metadata.filter(predicate).length;
  const visibleRefreshWithoutPrimaryAsk = (
    value: Record<string, unknown>
  ) =>
    value.visibleAnswerChanged === true &&
    value.primaryAskSpanCount === 0 &&
    value.refreshAuthorityHardOverride !== true;

  return {
    unauthorizedVisibleRefreshCount: count(
      (value) =>
        value.advisorOutputCommittedToUi === true &&
        value.refreshAuthorityAuthorized === false
    ),
    visibleRefreshWithoutPrimaryAskCount: count(
      visibleRefreshWithoutPrimaryAsk
    ),
    visibleRefreshWithoutPrimaryAskByAuthority:
      countVisibleRefreshesByAuthority(
        metadata.filter(visibleRefreshWithoutPrimaryAsk)
      ),
    primaryAskProjectionDisagreementCount: count(
      (value) =>
        value.visibleAnswerChanged === true &&
        value.primaryAskSpanCount === 0 &&
        value.refreshAuthorityHardOverride !== true &&
        (value.turnGateAction === "answer-refresh" ||
          value.advisorTurnIntent === "direct-question" ||
          value.advisorTurnIntent === "correction" ||
          value.advisorTurnIntent === "constraint-or-follow-up" ||
          value.runtimeIntentReleasedAction === "answer")
    ),
    runtimeIntentContradictedVisibleRefreshCount: count(
      (value) =>
        value.visibleAnswerChanged === true &&
        (value.runtimeIntentReleasedAction === "ignore" ||
          value.runtimeIntentReleasedAction === "append-context")
    ),
    manualHardOverrideRefreshCount: count(
      (value) =>
        value.refreshAuthorityHardOverride === true &&
        value.visibleAnswerChanged === true
    ),
    staleGenerationCommitAttemptCount: count(
      (value) => value.leaseAuthorizedAtCommit === false
    ),
    staleGenerationCommitRejectedCount: count(
      (value) => value.staleCommitRejected === true
    ),
    codeMutationWithoutCodeIntentCount: count(
      (value) => value.codeMutationWithoutCodeIntent === true
    ),
    deliveryLockCount: count(
      (value) =>
        value.stableAnswerCommitDisposition === "pending" ||
        value.answerDeliveryLockState === "update-ready"
    ),
    pendingCommitCount: count(
      (value) => value.pendingAnswerDisposition === "committed"
    ),
    pendingDropCount: count(
      (value) =>
        value.pendingAnswerDisposition === "stale" ||
        value.pendingAnswerDisposition === "dropped"
    ),
    manualOverrideCount: count(
      (value) =>
        value.refreshAuthorityHardOverride === true &&
        value.visibleAnswerChanged === true
    ),
    answerDwellMs: summarizeValues(
      metadata
        .map((value) => readNumber(value.answerDwellMs))
        .filter(isNumber)
    ),
  };
}

function summarizeShortIntent(
  traces: MeetingTrace[]
): MeetingShortIntentSummary {
  const metadata = traces.map((trace) => trace.metadata ?? {});
  const count = (predicate: (value: Record<string, unknown>) => boolean) =>
    metadata.filter(predicate).length;
  return {
    canonicalFillerSuppressedCount: count(
      (value) => value.canonicalFillerSuppressed === true
    ),
    shortHighInformationAllowedCount: count(
      (value) => value.shortHighInformationAllowed === true
    ),
    residualShortIntentAdjudicationCount: count(
      (value) =>
        value.residualResponseOpportunityInferenceRequired === true ||
        value.residualShortIntentAdjudicationRequired === true
    ),
    residualShortIntentIgnoreCount: count(
      (value) =>
        value.responseOpportunityDecision === "no-output-request" ||
        (value.shortIntentGateDecisionApplied === true &&
          value.shortIntentGateAppliedAction === "ignore")
    ),
    residualShortIntentAnswerCount: count(
      (value) =>
        value.responseOpportunityReleased === true ||
        (value.shortIntentGateDecisionApplied === true &&
          value.shortIntentGateAppliedAction === "answer")
    ),
    intentGateBudgetExhaustedCount: count(
      (value) =>
        value.responseOpportunityBudgetExhausted === true ||
        value.shortIntentGateBudgetExhausted === true
    ),
    intentGateTimeoutCount: count(
      (value) =>
        value.responseOpportunityTimedOut === true ||
        value.shortIntentGateTimedOut === true
    ),
    intentGateDecisionAppliedCount: count(
      (value) =>
        value.responseOpportunityDecisionApplied === true ||
        value.shortIntentGateDecisionApplied === true
    ),
    intentGateDurationMs: summarizeValues(
      metadata
        .map((value) =>
          readNumber(value.responseOpportunityDurationMs) ??
          readNumber(value.shortIntentGateDurationMs)
        )
        .filter(isNumber)
    ),
  };
}

function countVisibleRefreshesByAuthority(
  metadata: Record<string, unknown>[]
) {
  return metadata.reduce<Record<string, number>>((counts, value) => {
    const authority =
      typeof value.refreshAuthority === "string"
        ? value.refreshAuthority
        : "unknown";
    counts[authority] = (counts[authority] ?? 0) + 1;
    return counts;
  }, {});
}

function sanitizeExportMetadata(metadata: Record<string, unknown> | undefined) {
  if (!metadata) return undefined;
  return sanitizeExportValue(metadata) as Record<string, unknown>;
}

function sanitizeExportValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeExportValue);
  }

  if (isRecord(value)) {
    const sanitized: Record<string, unknown> = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      if (
        typeof nestedValue === "string" &&
        (normalizedKey.includes("base64") ||
          normalizedKey.includes("rawaudio") ||
          normalizedKey.includes("raw_audio"))
      ) {
        sanitized[key] = `[redacted ${key}; chars=${nestedValue.length}]`;
        continue;
      }

      sanitized[key] = sanitizeExportValue(nestedValue);
    }

    return sanitized;
  }

  if (typeof value === "string") {
    return sanitizeExportText(value);
  }

  return value;
}

function sanitizeExportText(value: string) {
  return value.replace(
    /data:(?:image|audio)\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g,
    (match) => `[redacted media data url; chars=${match.length}]`
  );
}

function summarizeValues(values: number[]): MeetingTraceValueSummary {
  const sortedValues = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);

  return {
    count: sortedValues.length,
    p50: percentile(sortedValues, 0.5),
    p90: percentile(sortedValues, 0.9),
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

function stepDurations(traces: MeetingTrace[], stepName: string) {
  return traces
    .map((trace) => findStep(trace, stepName)?.durationMs)
    .filter(isNumber);
}

function sttRequestDurations(traces: MeetingTrace[]) {
  return traces
    .map((trace) => {
      const recordedTotal = readNumber(
        trace.metadata?.sttTotalRequestDurationMs
      );
      if (recordedTotal !== undefined) return recordedTotal;

      const attemptDurations = trace.steps
        .filter(
          (step) =>
            step.name === "STT request" ||
            step.name === "STT retry request"
        )
        .map((step) => step.durationMs)
        .filter(isNumber);
      if (attemptDurations.length === 0) return undefined;
      return attemptDurations.reduce(
        (total, duration) => total + duration,
        0
      );
    })
    .filter(isNumber);
}

function stepMetadataValues(
  traces: MeetingTrace[],
  stepName: string,
  metadataKey: string
) {
  return traces
    .map((trace) => readNumber(findStep(trace, stepName)?.metadata?.[metadataKey]))
    .filter(isNumber);
}

function traceMetadataLatencies(
  traces: MeetingTrace[],
  metadataKey: string,
  baseKey: "startedAt"
) {
  return traces
    .map((trace) => {
      const timestamp = readNumber(trace.metadata?.[metadataKey]);
      const baseTimestamp = trace[baseKey];

      if (!timestamp || !baseTimestamp) return undefined;
      return timestamp - baseTimestamp;
    })
    .filter(isNumber);
}

function findStep(trace: MeetingTrace, stepName: string) {
  return trace.steps.find((step) => step.name === stepName);
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sanitizeTraceForPersistence(trace: MeetingTrace): MeetingTrace {
  return {
    id: trace.id,
    kind: trace.kind,
    status: trace.status,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    durationMs: trace.durationMs,
    steps: trace.steps.map((step) => ({
      id: step.id,
      name: step.name,
      status: step.status,
      startedAt: step.startedAt,
      endedAt: step.endedAt,
      durationMs: step.durationMs,
      metadata: sanitizeMetadata(step.metadata),
      error: step.error,
    })),
    inputs: [],
    outputs: [],
    metadata: sanitizeMetadata(trace.metadata),
    error: trace.error,
  };
}

function sanitizeMetadata(metadata: Record<string, unknown> | undefined) {
  if (!metadata) return undefined;

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (key === "captureTarget" && isRecord(value)) {
      sanitized.captureTarget = sanitizeCaptureTargetMetadata(value);
      continue;
    }

    if (isPersistableMetadataValue(value)) {
      sanitized[key] = value;
    }
  }

  return Object.keys(sanitized).length ? sanitized : undefined;
}

function sanitizeCaptureTargetMetadata(target: Record<string, unknown>) {
  const sanitized: Record<string, unknown> = {};
  const directKeys = [
    "targetType",
    "captureMethod",
    "windowId",
    "appName",
    "title",
    "monitorName",
    "zOrderIndex",
    "selectionReason",
    "x",
    "y",
    "width",
    "height",
    "imageWidth",
    "imageHeight",
    "originalImageWidth",
    "originalImageHeight",
    "optimizedForScreenContext",
    "fallbackReason",
  ];

  for (const key of directKeys) {
    const value = target[key];
    if (isPersistableMetadataValue(value)) {
      sanitized[key] = value;
    }
  }

  if (isRecord(target.captureTimingsMs)) {
    sanitized.captureTimingsMs = sanitizeNumericRecord(target.captureTimingsMs);
  }

  if (isRecord(target.cursor)) {
    sanitized.cursor = sanitizeNumericRecord(target.cursor, [
      "insideTarget",
      "source",
    ]);
  }

  if (isRecord(target.focusRegion)) {
    sanitized.focusRegion = sanitizeNumericRecord(target.focusRegion, [
      "source",
    ]);
  }

  return sanitized;
}

function sanitizeNumericRecord(
  record: Record<string, unknown>,
  extraKeys: string[] = []
) {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      sanitized[key] = value;
    }
  }

  for (const key of extraKeys) {
    const value = record[key];
    if (isPersistableMetadataValue(value)) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

function isPersistableMetadataValue(value: unknown) {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isMeetingTraceLike(value: unknown): value is MeetingTrace {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    (value.kind === "screen" || value.kind === "voice") &&
    typeof value.startedAt === "number" &&
    Array.isArray(value.steps)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneTrace(trace: MeetingTrace): MeetingTrace {
  return {
    ...trace,
    steps: trace.steps.map((step) => ({
      ...step,
      metadata: cloneMetadata(step.metadata),
    })),
    inputs: trace.inputs.map((input) => ({
      ...input,
      metadata: cloneMetadata(input.metadata),
    })),
    outputs: trace.outputs.map((output) => ({
      ...output,
      metadata: cloneMetadata(output.metadata),
    })),
    metadata: cloneMetadata(trace.metadata),
  };
}

function cloneMetadata(metadata: Record<string, unknown> | undefined) {
  return metadata ? { ...metadata } : undefined;
}

function compareTracesNewestFirst(left: MeetingTrace, right: MeetingTrace) {
  return right.startedAt - left.startedAt || left.id.localeCompare(right.id);
}

function stringifyError(error: unknown) {
  if (!error) return undefined;
  return error instanceof Error ? error.message : String(error);
}

function formatTraceLogLine(
  event: string,
  details: Record<string, unknown> | undefined
) {
  const timestamp = new Date().toISOString();
  const suffix = details ? ` ${safeStringify(details)}` : "";
  return `[${timestamp}] [meeting-trace] ${event}${suffix}`;
}

function safeStringify(value: Record<string, unknown>) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
