import assert from "node:assert/strict";
import test from "node:test";
import {
  PERSISTED_TRACE_METRICS_BYTE_BUDGET,
  parseMeetingTraceMetrics,
  serializeMeetingTraceMetrics,
  type PersistedMeetingTraceMetrics,
} from "../src/lib/meeting/trace.js";
import type { MeetingTrace } from "../src/lib/meeting/types.js";

test("persists a deterministic newest-first trace window within the byte budget", () => {
  const traces = Array.from({ length: 40 }, (_, index) =>
    buildTrace(index, "x".repeat(100_000))
  );

  const payload = serializeMeetingTraceMetrics(traces);
  const repeatedPayload = serializeMeetingTraceMetrics(traces);
  const persisted = JSON.parse(payload) as PersistedMeetingTraceMetrics;

  assert.equal(payload, repeatedPayload);
  assert.ok(Buffer.byteLength(payload, "utf8") <= PERSISTED_TRACE_METRICS_BYTE_BUDGET);
  assert.equal(persisted.version, 2);
  assert.equal(persisted.traces[0]?.id, "trace_39");
  assert.ok((persisted.retention?.droppedTraceCount ?? 0) > 0);
  assert.equal(
    persisted.retention?.retainedBytes,
    Buffer.byteLength(payload, "utf8")
  );
  assert.equal(
    persisted.retention?.retainedTraceCount,
    persisted.traces.length
  );
});

test("uses UTF-8 bytes and compacts one oversized newest trace", () => {
  const payload = serializeMeetingTraceMetrics([
    buildTrace(1, "界".repeat(800_000)),
  ]);
  const persisted = JSON.parse(payload) as PersistedMeetingTraceMetrics;

  assert.ok(Buffer.byteLength(payload, "utf8") <= PERSISTED_TRACE_METRICS_BYTE_BUDGET);
  assert.equal(persisted.traces.length, 1);
  assert.equal(persisted.traces[0]?.id, "trace_1");
  assert.equal(persisted.retention?.compactedTraceCount, 1);
  assert.equal(persisted.retention?.droppedTraceCount, 0);
  assert.ok(String(persisted.traces[0]?.metadata?.note).length < 400);
});

test("parses legacy v1 trace metrics for backward-compatible hydration", () => {
  const legacyTrace = buildTrace(7, "legacy");
  const payload = JSON.stringify({
    version: 1,
    savedAt: legacyTrace.startedAt,
    traces: [legacyTrace],
  });

  const parsed = parseMeetingTraceMetrics(payload);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.id, "trace_7");
  assert.deepEqual(parsed[0]?.inputs, []);
  assert.deepEqual(parsed[0]?.outputs, []);
});

function buildTrace(index: number, note: string): MeetingTrace {
  const startedAt = 1_000 + index * 100;
  return {
    id: `trace_${index}`,
    kind: index % 2 === 0 ? "screen" : "voice",
    status: "success",
    startedAt,
    endedAt: startedAt + 75,
    durationMs: 75,
    steps: [
      {
        id: `step_${index}`,
        name: "Model response",
        status: "success",
        startedAt: startedAt + 10,
        endedAt: startedAt + 70,
        durationMs: 60,
        metadata: { outputChars: 500, note },
      },
    ],
    inputs: [
      { label: "input", value: "private", recordedAt: startedAt + 5 },
    ],
    outputs: [
      { label: "output", value: "private", recordedAt: startedAt + 70 },
    ],
    metadata: { note, activeMeetingTaskId: `task_${index}` },
  };
}
