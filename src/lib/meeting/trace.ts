import {
  MeetingTrace,
  MeetingTraceExportTrigger,
  MeetingTraceIO,
  MeetingTraceKind,
  MeetingTraceStatus,
  MeetingTraceStep,
} from "./types";
import { createMeetingId } from "./context-manager";
import { invoke } from "@tauri-apps/api/core";

const MAX_TRACE_ITEMS = 500;
const DEFAULT_SUMMARY_WINDOW_SIZE = 20;
const PERSISTED_TRACE_METRICS_VERSION = 1;
const MEETING_TRACE_EXPORT_VERSION = 1;

export class MeetingTraceStore {
  private traces: MeetingTrace[] = [];
  private onChange?: (traces: MeetingTrace[]) => void;
  private debugEnabled = false;

  constructor(debugEnabled = false) {
    this.debugEnabled = debugEnabled;
  }

  subscribe(onChange: (traces: MeetingTrace[]) => void) {
    this.onChange = onChange;
    onChange(this.getTraces());
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

  hydrate(traces: MeetingTrace[]) {
    this.traces = traces
      .map(sanitizeTraceForPersistence)
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, MAX_TRACE_ITEMS);
    this.emit();
  }

  getPersistableTraces() {
    return this.traces.map(sanitizeTraceForPersistence);
  }

  clear() {
    this.traces = [];
    this.log("traces-cleared");
    this.emit();
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

    this.traces = [trace, ...this.traces].slice(0, MAX_TRACE_ITEMS);
    this.log("trace-started", {
      id: trace.id,
      kind: trace.kind,
      metadata: trace.metadata,
    });
    this.emit();
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
    this.traces = this.traces.map((trace) => {
      if (trace.id !== traceId) return trace;

      const nextTrace = cloneTrace(trace);
      update(nextTrace);
      return nextTrace;
    });

    this.emit();
  }

  private emit() {
    this.onChange?.(this.getTraces());
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

export interface MeetingTraceSummary {
  windowSize: number;
  traceCount: number;
  screen: MeetingTraceKindSummary;
  voice: MeetingTraceKindSummary;
}

export interface PersistedMeetingTraceMetrics {
  version: number;
  savedAt: number;
  traces: MeetingTrace[];
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
  const payload: PersistedMeetingTraceMetrics = {
    version: PERSISTED_TRACE_METRICS_VERSION,
    savedAt: Date.now(),
    traces: traces.map(sanitizeTraceForPersistence),
  };

  return JSON.stringify(payload, null, 2);
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

export function summarizeMeetingTraces(
  traces: MeetingTrace[],
  windowSize = DEFAULT_SUMMARY_WINDOW_SIZE
): MeetingTraceSummary {
  const recentTraces = traces.slice(0, windowSize);

  return {
    windowSize,
    traceCount: recentTraces.length,
    screen: summarizeTraceKind(
      recentTraces.filter((trace) => trace.kind === "screen"),
      "screen"
    ),
    voice: summarizeTraceKind(
      recentTraces.filter((trace) => trace.kind === "voice"),
      "voice"
    ),
  };
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
    summary.sttDurationMs = summarizeValues(stepDurations(traces, "STT request"));
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
