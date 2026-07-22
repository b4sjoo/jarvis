import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionRecordingManager,
  type SessionRecordingInvoke,
} from "../src/lib/meeting/session-recording.js";
import type {
  MeetingAssistantSettings,
  MeetingTrace,
} from "../src/lib/meeting/types.js";

interface InvokeCall {
  command: string;
  args: Record<string, unknown>;
}

test("serializes concurrent starts into one recording generation", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);

  const [first, second] = await Promise.all([
    manager.start(START_OPTIONS),
    manager.start(START_OPTIONS),
  ]);

  assert.equal(native.startCalls().length, 1);
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(manager.getState().lifecycle, "active");

  await manager.stop("test-complete");
  assert.equal(manager.getState().lifecycle, "idle");
});

test("drains late writes into their original folder before allowing stop-start", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  const firstState = await manager.start(START_OPTIONS);
  const firstFolder = required(firstState.folderName);
  await settle();

  const blockedOutput = native.blockNext(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath").includes("/outputs/")
  );
  manager.recordModelOutput({
    traceId: "trace_session_a",
    label: "advisor output",
    value: "session A answer",
  });
  await blockedOutput.started;

  const stopPromise = manager.stop("rapid-toggle");
  await waitFor(() => manager.getState().lifecycle === "closing");
  const secondStartPromise = manager.start(START_OPTIONS);
  await settle();
  assert.equal(native.startCalls().length, 1);

  manager.recordModelInput({
    traceId: "trace_session_a",
    label: "late advisor input",
    value: "late but still owned by session A",
  });
  blockedOutput.release();

  await stopPromise;
  const secondState = await secondStartPromise;
  const secondFolder = required(secondState.folderName);
  assert.notEqual(secondFolder, firstFolder);
  assert.equal(native.startCalls().length, 2);

  const oldTraceWrites = native.calls.filter(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      (stringArg(call, "relativePath").includes("/outputs/") ||
        stringArg(call, "relativePath").includes("/prompts/"))
  );
  assert.ok(oldTraceWrites.length >= 2);
  assert.ok(
    oldTraceWrites.every(
      (call) => stringArg(call, "folderName") === firstFolder
    )
  );

  const stoppedManifest = native.stoppedManifest(firstFolder);
  assert.ok(stoppedManifest);
  assert.ok(stoppedManifest.recordingLifecycle.drainPasses >= 2);
  assert.ok(stoppedManifest.recordingLifecycle.acceptedWrites >= 4);

  const stoppedManifestIndex = native.calls.findIndex(
    (call) => call === stoppedManifest.call
  );
  const secondStartIndex = native.calls.findIndex(
    (call, index) =>
      index > stoppedManifestIndex &&
      call.command === "start_meeting_session_recording"
  );
  assert.ok(stoppedManifestIndex >= 0);
  assert.ok(secondStartIndex > stoppedManifestIndex);

  const oldTraceWriteCount = native.calls.filter(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath").includes("trace_session_a")
  ).length;
  manager.recordModelOutput({
    traceId: "trace_session_a",
    label: "stale completion after restart",
    value: "must not enter session B",
  });
  await settle();
  assert.equal(
    native.calls.filter(
      (call) =>
        call.command === "write_meeting_session_recording_text" &&
        stringArg(call, "relativePath").includes("trace_session_a")
    ).length,
    oldTraceWriteCount
  );
  const evaluationWriteCount = native.calls.filter(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath").startsWith("human-evaluation/")
  ).length;
  manager.recordHumanEvaluations([
    {
      id: "evaluation_session_a",
      traceId: "trace_session_a",
      traceKind: "voice",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      failureReasons: [],
    },
  ]);
  await settle();
  assert.equal(
    native.calls.filter(
      (call) =>
        call.command === "write_meeting_session_recording_text" &&
        stringArg(call, "relativePath").startsWith("human-evaluation/")
    ).length,
    evaluationWriteCount
  );

  await manager.stop("test-complete");
});

test("rejects writes that arrive after a generation is sealed", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  await manager.start(START_OPTIONS);
  await settle();

  const blockedManifest = native.blockNext((call) => {
    if (
      call.command !== "write_meeting_session_recording_text" ||
      stringArg(call, "relativePath") !== "manifest.json"
    ) {
      return false;
    }
    return parsePayload(call).status === "stopped";
  });
  const stopPromise = manager.stop("seal-test");
  await blockedManifest.started;

  manager.recordModelOutput({
    traceId: "trace_after_seal",
    label: "too late",
    value: "must not be written",
  });
  blockedManifest.release();
  await stopPromise;

  assert.equal(
    native.calls.some(
      (call) =>
        call.command === "write_meeting_session_recording_text" &&
        stringArg(call, "relativePath").includes("trace_after_seal")
    ),
    false
  );
  assert.equal(manager.getState().lifecycle, "idle");
});

test("native speech telemetry never persists audio payloads", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  await manager.start(START_OPTIONS);
  await settle();

  manager.recordNativeSpeechEvent({
    authorized: false,
    reason: "capture-session-mismatch",
    nativeCaptureSessionId: "capture-old",
    nativeSegmentSequence: 4,
    audioBase64Chars: 8,
    audioBase64: "UklGRg==",
    base64Audio: "UklGRg==",
  });
  await settle();

  const timelineWrites = native.calls.filter(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") === "timeline.jsonl"
  );
  const payload = timelineWrites.map((call) => stringArg(call, "payload")).join("");
  assert.match(payload, /capture-session-mismatch/);
  assert.match(payload, /audioBase64Chars/);
  assert.equal(payload.includes("UklGRg=="), false);

  await manager.stop("test-complete");
});

test("session aggregates retain synthetic evidence without counting it as production", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  await manager.start(START_OPTIONS);
  await settle();

  const startedAt = Date.now();
  manager.recordTrace(buildCompletedTrace("production", startedAt), "manual");
  manager.recordTrace(
    buildCompletedTrace("synthetic", startedAt + 1, {
      syntheticValidation: true,
      faultInjected: true,
      faultInjectionId: "native_audio_fault_1",
      faultKind: "fatal-capture-failure",
    }),
    "manual"
  );

  await waitFor(
    () =>
      native.calls.filter(
        (call) =>
          call.command === "write_meeting_session_recording_text" &&
          stringArg(call, "relativePath") === "metrics/session-summary.json"
      ).length >= 2
  );
  const summaryCalls = native.calls.filter(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") === "metrics/session-summary.json"
  );
  const summaryCall = summaryCalls[summaryCalls.length - 1];
  assert.ok(summaryCall);
  const summary = parsePayload(summaryCall);
  assert.equal(summary.traceCount, 1);
  assert.equal(summary.syntheticValidationTraceCount, 1);
  assert.equal((summary.voice as { total: number }).total, 1);
  assert.equal(summary.errors, 0);

  const compactSynthetic = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") === "traces/synthetic/summary.json"
  );
  assert.ok(compactSynthetic);
  assert.equal(parsePayload(compactSynthetic).syntheticValidation, true);

  await manager.stop("test-complete");
});

test("late semantic shadow evidence stays joinable after trace export", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  await manager.start(START_OPTIONS);
  await settle();

  const startedAt = Date.now();
  manager.recordTrace(buildCompletedTrace("semantic_trace", startedAt), "manual");
  await settle();
  manager.recordSemanticTaxonomyDecision({
    traceId: "semantic_trace",
    taskId: "task_1",
    metadata: {
      semanticTaxonomyMode: "shadow",
      semanticTaxonomyTurnId: "turn_1",
      taxonomyKeywordType: "unknown",
      taxonomySemanticCandidateType: "field-knowledge",
      taxonomyHybridOutcome: "semantic-would-rescue",
      taxonomyHybridWouldRescue: true,
      taxonomySemanticRescueApplied: false,
      taxonomySemanticEmbeddingStatus: "success",
      taxonomySemanticDurationMs: 24,
      taxonomySemanticCacheHit: false,
      taxonomySemanticModelVersion: "model-v1",
    },
  });
  await settle();

  const eventWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") === "taxonomy/semantic-decisions.jsonl"
  );
  assert.ok(eventWrite);
  assert.match(stringArg(eventWrite, "payload"), /semantic-would-rescue/);

  const summaryWrites = native.calls.filter(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") === "traces/semantic_trace/summary.json"
  );
  const latestSummary = summaryWrites[summaryWrites.length - 1];
  assert.ok(latestSummary);
  const summary = parsePayload(latestSummary);
  assert.equal(
    (summary.semanticTaxonomy as Record<string, unknown>).hybridOutcome,
    "semantic-would-rescue"
  );

  await manager.stop("test-complete");
});

const START_OPTIONS = {
  settings: {
    codingModel: {
      enabled: false,
      provider: "",
      variables: {},
    },
  } as unknown as MeetingAssistantSettings,
  providerSummary: {
    hasMainProvider: false,
    hasCodingProvider: false,
    hasSttProvider: false,
    mainSupportsImages: false,
    codingSupportsImages: false,
  },
};

function buildCompletedTrace(
  id: string,
  startedAt: number,
  metadata: Record<string, unknown> = {}
): MeetingTrace {
  return {
    id,
    kind: "voice",
    status: "success",
    startedAt,
    endedAt: startedAt + 100,
    durationMs: 100,
    steps: [],
    inputs: [],
    outputs: [],
    metadata,
  };
}

class ControlledRecordingInvoke {
  readonly calls: InvokeCall[] = [];
  private blockers: Array<{
    predicate: (call: InvokeCall) => boolean;
    gate: ReturnType<typeof createGate>;
  }> = [];

  readonly invoke: SessionRecordingInvoke = async <T>(
    command: string,
    args: Record<string, unknown> = {}
  ) => {
    const call = { command, args };
    this.calls.push(call);
    const blockerIndex = this.blockers.findIndex(({ predicate }) =>
      predicate(call)
    );
    if (blockerIndex >= 0) {
      const [blocker] = this.blockers.splice(blockerIndex, 1);
      blocker?.gate.markStarted();
      await blocker?.gate.promise;
    }

    if (command === "start_meeting_session_recording") {
      return `/recordings/${stringArg(call, "folderName")}` as T;
    }
    return `/recordings/${stringArg(call, "folderName")}/${stringArg(
      call,
      "relativePath"
    )}` as T;
  };

  blockNext(predicate: (call: InvokeCall) => boolean) {
    const gate = createGate();
    this.blockers.push({ predicate, gate });
    return {
      started: gate.started,
      release: gate.release,
    };
  }

  startCalls() {
    return this.calls.filter(
      (call) => call.command === "start_meeting_session_recording"
    );
  }

  stoppedManifest(folderName: string) {
    for (const call of this.calls) {
      if (
        call.command !== "write_meeting_session_recording_text" ||
        stringArg(call, "folderName") !== folderName ||
        stringArg(call, "relativePath") !== "manifest.json"
      ) {
        continue;
      }
      const payload = parsePayload(call);
      if (payload.status === "stopped") {
        return {
          call,
          recordingLifecycle: payload.recordingLifecycle as {
            drainPasses: number;
            acceptedWrites: number;
          },
        };
      }
    }
    return undefined;
  }
}

function createGate() {
  let release = () => {};
  let markStarted = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  return { promise, started, release, markStarted };
}

function stringArg(call: InvokeCall, key: string) {
  const value = call.args[key];
  return typeof value === "string" ? value : "";
}

function parsePayload(call: InvokeCall) {
  return JSON.parse(stringArg(call, "payload") || "{}") as Record<
    string,
    unknown
  >;
}

function required(value: string | undefined) {
  assert.ok(value);
  return value;
}

async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  assert.fail("Timed out waiting for condition");
}
