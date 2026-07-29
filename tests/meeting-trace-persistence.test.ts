import assert from "node:assert/strict";
import test from "node:test";
import {
  MeetingTraceStore,
  PERSISTED_TRACE_METRICS_BYTE_BUDGET,
  parseMeetingTraceMetrics,
  serializeMeetingTraceMetrics,
  summarizeMeetingTraces,
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

test("merges deferred hydration without dropping or freezing a live trace", async () => {
  const store = new MeetingTraceStore();
  let resolvePersistedRead: ((traces: MeetingTrace[]) => void) | undefined;
  const persistedRead = new Promise<MeetingTrace[]>((resolve) => {
    resolvePersistedRead = resolve;
  });
  const hydration = persistedRead.then((traces) => store.hydrate(traces));

  const live = store.startTrace("voice", { source: "live" }, 5_000);
  store.updateMetadata(live.id, { beforeHydration: true });
  resolvePersistedRead?.([buildTrace(1, "persisted")]);
  await hydration;
  store.updateMetadata(live.id, { afterHydration: true });
  store.finishTrace(live.id, "success");

  const hydratedLive = store
    .getTraces()
    .find((trace) => trace.id === live.id);
  assert.equal(hydratedLive?.status, "success");
  assert.equal(hydratedLive?.metadata?.beforeHydration, true);
  assert.equal(hydratedLive?.metadata?.afterHydration, true);
  assert.ok(store.getTraces().some((trace) => trace.id === "trace_1"));
});

test("keeps the current-process trace when persisted history has the same id", () => {
  const store = new MeetingTraceStore();
  const live = store.startTrace("screen", { owner: "current" }, 5_000);
  const collision = {
    ...buildTrace(2, "persisted"),
    id: live.id,
    metadata: { owner: "persisted" },
  };

  store.hydrate([collision]);

  const retained = store.getTraces().find((trace) => trace.id === live.id);
  assert.equal(retained?.status, "running");
  assert.equal(retained?.metadata?.owner, "current");
});

test("keeps current-process traces within deterministic newest-first bounds", () => {
  const store = new MeetingTraceStore();
  const live = store.startTrace("voice", { owner: "current" }, 500);
  const history = Array.from({ length: 505 }, (_, index) =>
    buildTrace(index, `history-${index}`)
  );

  store.hydrate(history);

  const traces = store.getTraces();
  assert.equal(traces.length, 500);
  assert.ok(traces.some((trace) => trace.id === live.id));
  assert.deepEqual(
    traces.map((trace) => trace.id),
    [...traces]
      .sort(
        (left, right) =>
          right.startedAt - left.startedAt || left.id.localeCompare(right.id)
      )
      .map((trace) => trace.id)
  );
  assert.equal(traces[0]?.id, "trace_504");
  assert.ok(!traces.some((trace) => trace.id === "trace_0"));
});

test("excludes synthetic validation traces from production reliability summaries", () => {
  const production = buildTrace(1, "production");
  const synthetic = {
    ...buildTrace(2, "fault-injection"),
    metadata: {
      syntheticValidation: true,
      faultInjectionId: "native_audio_fault_1",
    },
  };

  const summary = summarizeMeetingTraces([synthetic, production]);

  assert.equal(summary.traceCount, 1);
  assert.equal(summary.syntheticValidationTraceCount, 1);
  assert.equal(summary.voice.total, 1);
  assert.equal(summary.screen.total, 0);
});

test("counts prompt-echo retry latency in the STT duration summary", () => {
  const trace = buildTrace(3, "stt-retry");
  trace.kind = "voice";
  trace.metadata = {
    ...trace.metadata,
    sttTotalRequestDurationMs: 1_580,
  };
  trace.steps = [
    {
      id: "stt_initial",
      name: "STT request",
      status: "success",
      startedAt: 1_310,
      endedAt: 2_130,
      durationMs: 820,
    },
    {
      id: "stt_retry",
      name: "STT retry request",
      status: "success",
      startedAt: 2_130,
      endedAt: 2_890,
      durationMs: 760,
    },
  ];

  const summary = summarizeMeetingTraces([trace]);

  assert.equal(summary.voice.sttDurationMs?.count, 1);
  assert.equal(summary.voice.sttDurationMs?.p50, 1_580);
  assert.equal(summary.voice.sttDurationMs?.p90, 1_580);
});

test("aggregates answer stability and delivery protection metrics", () => {
  const pending = buildTrace(4, "delivery-lock");
  pending.metadata = {
    ...pending.metadata,
    stableAnswerCommitDisposition: "pending",
    answerDeliveryLockState: "update-ready",
    pendingAnswerDisposition: "committed",
    answerDwellMs: 4_200,
  };
  const stale = buildTrace(5, "stale-generation");
  stale.metadata = {
    ...stale.metadata,
    leaseAuthorizedAtCommit: false,
    staleCommitRejected: true,
    pendingAnswerDisposition: "stale",
    codeMutationWithoutCodeIntent: true,
    visibleAnswerChanged: true,
    primaryAskSpanCount: 0,
  };

  const summary = summarizeMeetingTraces([pending, stale]);

  assert.equal(summary.answerStability.deliveryLockCount, 1);
  assert.equal(summary.answerStability.pendingCommitCount, 1);
  assert.equal(summary.answerStability.pendingDropCount, 1);
  assert.equal(
    summary.answerStability.staleGenerationCommitRejectedCount,
    1
  );
  assert.equal(
    summary.answerStability.codeMutationWithoutCodeIntentCount,
    1
  );
  assert.equal(
    summary.answerStability.visibleRefreshWithoutPrimaryAskCount,
    1
  );
  assert.equal(summary.answerStability.answerDwellMs.p50, 4_200);
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
