import {
  MeetingTrace,
  MeetingTraceIO,
  MeetingTraceKind,
  MeetingTraceStatus,
  MeetingTraceStep,
} from "./types";
import { createMeetingId } from "./context-manager";
import { invoke } from "@tauri-apps/api/core";

const MAX_TRACE_ITEMS = 20;

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
