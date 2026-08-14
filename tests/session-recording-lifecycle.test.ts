import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionRecordingManager,
  type SessionRecordingInvoke,
} from "../src/lib/meeting/session-recording.js";
import type {
  ActiveQuestionTermCorrection,
  MeetingAssistantSettings,
  MeetingTrace,
} from "../src/lib/meeting/types.js";
import type {
  CurrentQuestionSettlementDecision,
  ProvisionalCurrentQuestion,
} from "../src/lib/meeting/current-question-settlement.js";
import type { SettledAdvisorExecutionPlan } from "../src/lib/meeting/settled-advisor-execution-plan.js";
import {
  createHumanGroundTruthEventV2,
  deriveHumanEvaluationProjectionV2,
} from "../src/lib/meeting/human-ground-truth-v2.js";
import { createQuestionTypeAdjudicationOutcomeEvent } from "../src/lib/meeting/question-type-adjudication.js";
import {
  createAdvisorHypothesisChallenge,
  createAdvisorResponseFingerprintRecord,
  observeAdvisorResponseConsistency,
} from "../src/lib/meeting/advisor-response-consistency.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import type {
  PreparationArtifactEvaluation,
  PreparationArtifactUseReceipt,
  PreparationRuntimeProvenanceSnapshot,
} from "../src/lib/meeting/preparation-runtime-provenance.js";

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
  const initialManifest = JSON.parse(
    stringArg(native.startCalls()[0]!, "manifestPayload")
  ) as Record<string, unknown>;
  assert.equal(
    (initialManifest.build as Record<string, unknown>).appVersion,
    "unknown"
  );
  assert.equal(
    (initialManifest.build as Record<string, unknown>).gitCommit,
    "unknown"
  );

  await manager.stop("test-complete");
  assert.equal(manager.getState().lifecycle, "idle");
});

test("records zero-trace critical moment candidates and reviewed outcomes", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  const recording = await manager.start(START_OPTIONS);
  const sessionId = required(recording.sessionId);
  const startedAt = Date.now();
  manager.recordTranscriptTurn({
    id: "turn_zero_trace",
    speaker: "them",
    text: "How would you design a ticket system?",
    startedAt,
    endedAt: startedAt + 100,
    isFinal: true,
    source: "system-audio",
  });
  manager.recordCriticalMomentCandidates([
    {
      momentId: "critical_moment_zero_trace",
      sessionId,
      sourceTurnIds: ["turn_zero_trace"],
      sourceText: "How would you design a ticket system?",
      opportunityStartAt: startedAt,
      opportunityEndAt: startedAt + 100,
      candidateSource: "transcript-rule",
      candidateReasons: ["zero-trace-opportunity"],
      proposedTraceIds: [],
      traceJoinStatus: "none",
      createdAt: startedAt,
      updatedAt: startedAt,
    },
  ]);
  manager.recordCriticalMomentEvaluations([
    {
      momentId: "critical_moment_zero_trace",
      sessionId,
      sourceTurnIds: ["turn_zero_trace"],
      traceIds: [],
      eligibility: "critical",
      expectedAdvisorAction: "advise",
      useful: false,
      trustworthy: false,
      failureReasons: ["no-advice"],
      createdAt: startedAt,
      updatedAt: startedAt,
    },
  ]);

  await manager.stop("test-complete");

  const candidateWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "human-evaluation/critical-moment-candidates.json"
  );
  const evaluationWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "human-evaluation/critical-moment-evaluations.json"
  );
  assert.ok(candidateWrite);
  assert.ok(evaluationWrite);
  assert.equal(
    (parsePayload(candidateWrite).candidates as unknown[]).length,
    1
  );
  assert.equal(
    (
      (parsePayload(evaluationWrite).evaluations as Array<{
        eligibility?: string;
      }>)[0]
    ).eligibility,
    "critical"
  );
});

test("records append-only V2 ground truth and derived projection artifacts", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  const recording = await manager.start(START_OPTIONS);
  const sessionId = required(recording.sessionId);
  const subject = {
    questionId: "question_v2",
    traceIds: ["trace_v2"],
    sourceTurnIds: ["turn_v2"],
  };
  const event = createHumanGroundTruthEventV2({
    eventId: "ground_truth_v2",
    sessionId,
    subject,
    source: "explicit-ui",
    sourceTraceId: "trace_v2",
    fact: {
      kind: "expected-runtime-action",
      expectedAction: "advise",
    },
  });
  const projection = deriveHumanEvaluationProjectionV2({
    sessionId,
    subject,
    events: [event],
    observed: {
      traceId: "trace_v2",
      traceHash: "trace-hash-v2",
      runtimeAction: "ignore",
    },
  });

  manager.recordHumanGroundTruthEventV2(event);
  manager.recordHumanGroundTruthEventV2(event);
  manager.recordHumanEvaluationProjectionV2(projection);
  await manager.stop("test-complete");

  const truthWrites = native.calls.filter(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "human-evaluation/ground-truth-v2.jsonl"
  );
  const projectionSnapshot = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "human-evaluation/projections-v2.json"
  );
  const projectionHistory = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "human-evaluation/projections-v2.jsonl"
  );
  assert.equal(truthWrites.length, 1);
  assert.ok(projectionSnapshot);
  assert.ok(projectionHistory);
  assert.equal(
    (
      parsePayload(projectionSnapshot).projections as Array<{
        inputTraceHashes: string[];
      }>
    )[0]?.inputTraceHashes[0],
    "trace-hash-v2"
  );
});

test("suppresses unchanged V2 projection materializations in long sessions", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  const recording = await manager.start(START_OPTIONS);
  const sessionId = required(recording.sessionId);
  const subject = {
    questionId: "question_projection_compaction",
    traceIds: ["trace_projection_compaction", "trace_related"],
    sourceTurnIds: ["turn_projection_compaction"],
  };
  const event = createHumanGroundTruthEventV2({
    eventId: "ground_truth_projection_compaction",
    sessionId,
    subject,
    source: "explicit-ui",
    sourceTraceId: "trace_projection_compaction",
    fact: {
      kind: "expected-runtime-action",
      expectedAction: "advise",
    },
    now: 1,
  });
  const initial = deriveHumanEvaluationProjectionV2({
    sessionId,
    subject,
    events: [event],
    observed: {
      traceId: "trace_projection_compaction",
      traceHash: "trace-hash-initial",
      runtimeAction: "ignore",
    },
    now: 2,
  });

  manager.recordHumanGroundTruthEventV2(event);
  for (let index = 0; index < 100; index += 1) {
    manager.recordHumanEvaluationProjectionV2({
      ...initial,
      computedAt: initial.computedAt + index,
      observed: {
        ...initial.observed!,
        traceHash: `trace-hash-initial-${index}`,
      },
      inputTraceHashes: [`trace-hash-initial-${index}`],
    });
  }

  const revised = deriveHumanEvaluationProjectionV2({
    sessionId,
    subject,
    events: [event],
    observed: {
      traceId: "trace_projection_compaction",
      traceHash: "trace-hash-revised",
      runtimeAction: "advise",
    },
    now: 200,
  });
  manager.recordHumanEvaluationProjectionV2(revised);
  for (let index = 0; index < 50; index += 1) {
    manager.recordHumanEvaluationProjectionV2({
      ...revised,
      computedAt: revised.computedAt + index + 1,
      observed: {
        ...revised.observed!,
        traceHash: `trace-hash-revised-${index}`,
      },
      inputTraceHashes: [`trace-hash-revised-${index}`],
    });
  }

  await manager.stop("test-complete");

  const projectionHistoryWrites = native.calls.filter(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "human-evaluation/projections-v2.jsonl"
  );
  assert.equal(projectionHistoryWrites.length, 2);
  assert.ok(
    projectionHistoryWrites.every((call) =>
      Boolean(parsePayload(call).materializationRevision)
    )
  );

  const projectionSnapshots = native.calls.filter(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "human-evaluation/projections-v2.json"
  );
  const finalSnapshot = parsePayload(projectionSnapshots.at(-1)!);
  const materialization = finalSnapshot.materialization as Record<
    string,
    number
  >;
  assert.equal(materialization.groundTruthEventCount, 1);
  assert.equal(materialization.projectionAttemptCount, 151);
  assert.equal(materialization.projectionDeltaCount, 2);
  assert.equal(materialization.duplicateSuppressionCount, 149);
  assert.equal(materialization.uniqueProjectionCount, 1);
  assert.equal(materialization.supersededProjectionCount, 1);
  assert.equal(
    (
      finalSnapshot.projections as Array<{
        observed?: { runtimeAction?: string };
      }>
    )[0]?.observed?.runtimeAction,
    "advise"
  );

  const stoppedManifest = native.stoppedManifest(
    required(recording.folderName)
  );
  assert.deepEqual(
    stoppedManifest?.evaluationIntegrity.v2ProjectionMaterialization,
    materialization
  );
});

test("records question-type post-release outcomes in a dedicated append-only ledger", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  const recording = await manager.start(START_OPTIONS);
  const recordingSessionId = required(recording.sessionId);
  const outcome = createQuestionTypeAdjudicationOutcomeEvent({
    operationId: "operation_outcome",
    sessionId: "meeting_outcome",
    runtimeEpoch: 4,
    logicalQuestionUnitId: "lqu_outcome",
    logicalQuestionUnitRevision: 2,
    traceId: "trace_outcome",
    stage: "delivery",
    disposition: "visible-committed",
    enforcementAuthorized: true,
    settlementApplied: true,
    advisorStarted: true,
    modelCompleted: true,
    advisorJobId: "advisor_outcome",
    visibleAnswerRevision: 9,
    appliedToResponse: true,
    appliedToSettlement: true,
    visibleCommitted: true,
  });

  manager.recordQuestionTypeAdjudicationOutcome(outcome);
  await manager.stop("test-complete");

  const writes = native.calls.filter(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "taxonomy/question-type-adjudication-outcomes.jsonl"
  );
  assert.equal(writes.length, 1);
  const payload = JSON.parse(stringArg(writes[0]!, "payload"));
  assert.equal(payload.operationId, "operation_outcome");
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.recordingSessionId, recordingSessionId);
  assert.equal(payload.runtimeSessionId, "meeting_outcome");
  assert.equal(payload.originTraceId, "trace_outcome");
  assert.equal(payload.advisorJobId, "advisor_outcome");
  assert.equal(payload.visibleAnswerRevision, 9);
  assert.equal(payload.visibleCommitted, true);
});

test("records question-type decisions with distinct recording and runtime sessions", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  const recording = await manager.start(START_OPTIONS);
  const recordingSessionId = required(recording.sessionId);

  manager.recordQuestionTypeAdjudicationDecision({
    traceId: "trace_decision",
    metadata: {
      questionTypeAdjudicationOperationId: "operation_decision",
      questionTypeAdjudicationRuntimeSessionId: "meeting_decision",
    },
  });
  await manager.stop("test-complete");

  const write = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "taxonomy/question-type-adjudications.jsonl"
  );
  assert.ok(write);
  const payload = JSON.parse(stringArg(write, "payload"));
  assert.equal(payload.sessionId, recordingSessionId);
  assert.equal(payload.recordingSessionId, recordingSessionId);
  assert.equal(payload.runtimeSessionId, "meeting_decision");
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
  assert.equal(stoppedManifest.recordingLifecycle.pendingWritesAtSeal, 0);
  assert.equal(stoppedManifest.recordingLifecycle.queueDrained, true);
  assert.equal(
    stoppedManifest.recordingLifecycle.enqueueCounterConsistent,
    true
  );
  assert.equal(stoppedManifest.recordingIntegrity.status, "complete");
  assert.equal(stoppedManifest.recordingIntegrity.failedWriteCount, 0);
  assert.equal(
    stoppedManifest.evaluationIntegrity.compatibilityReportPath,
    "human-evaluation/compatibility-v2.json"
  );

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

test("marks a drained recording incomplete when an artifact write fails", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  const state = await manager.start(START_OPTIONS);
  const folderName = required(state.folderName);
  await settle();

  native.failNext(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath").includes("/outputs/"),
    new Error("simulated disk failure")
  );
  manager.recordModelOutput({
    traceId: "trace_failed_artifact",
    label: "advisor output",
    value: "answer",
  });

  await manager.stop("test-write-integrity");

  const stoppedManifest = native.stoppedManifest(folderName);
  assert.ok(stoppedManifest);
  assert.equal(stoppedManifest.recordingLifecycle.queueDrained, true);
  assert.equal(stoppedManifest.recordingLifecycle.pendingWritesAtSeal, 0);
  assert.equal(stoppedManifest.recordingIntegrity.status, "incomplete");
  assert.equal(stoppedManifest.recordingIntegrity.failedWriteCount, 1);
  assert.equal(
    stoppedManifest.recordingIntegrity.failedWriteDetailsTruncated,
    false
  );
  assert.equal(stoppedManifest.recordingIntegrity.failedWrites.length, 1);
  assert.match(
    stoppedManifest.recordingIntegrity.failedWrites[0]?.relativePath ?? "",
    /trace_failed_artifact\/outputs/
  );
  assert.match(
    stoppedManifest.recordingIntegrity.failedWrites[0]?.message ?? "",
    /simulated disk failure/
  );
  assert.match(manager.getState().lastError ?? "", /simulated disk failure/);
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

test("records whiteboard validation and recovery artifacts", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  await manager.start(START_OPTIONS);
  await settle();

  manager.recordWhiteboardRenderValidation({
    traceId: "screen_trace_whiteboard",
    taskId: "parent_1",
    metadata: {
      whiteboardRenderValidationOperationId: "validation_1",
      whiteboardRenderValidationDisposition: "invalid-mermaid",
      whiteboardRenderSanitationDisposition: "failed",
      whiteboardRenderSanitationChanges: ["normalized-subgraph-label"],
      whiteboardRenderOriginalParserErrorClass: "mermaid-syntax-error",
      whiteboardRenderCandidateRevision: 2,
      whiteboardRenderVisibleRevisionAfter: 1,
      whiteboardRenderPreservedLastValid: true,
    },
    candidateContent: "```mermaid\nflowchart TD\n  broken[\n```",
  });
  manager.recordWhiteboardRenderRecovery({
    traceId: "screen_trace_whiteboard",
    taskId: "parent_1",
    metadata: {
      whiteboardRepairOperationId: "repair_1",
      whiteboardRepairDisposition: "shadow-valid",
      whiteboardRepairDurationMs: 420,
      whiteboardRepairBehaviorMutationBlocked: true,
      whiteboardFormatPreference: "mermaid",
      whiteboardMermaidEligible: true,
      whiteboardMermaidRequested: true,
      whiteboardMermaidCommitted: false,
      whiteboardFormatPolicyMiss: false,
      whiteboardFormatConversionAttempted: false,
      whiteboardFormatConversionDisposition: "not-needed",
      whiteboardAsciiFallback: false,
    },
    repairedMermaid: "flowchart TD\n  A[Client] --> B[API]",
    asciiFallback: "Client -> API",
  });
  manager.recordTrace(
    buildCompletedTrace("screen_trace_whiteboard", Date.now(), {
      whiteboardArtifactId: "whiteboard_1",
      whiteboardArtifactRevision: 1,
      whiteboardArtifactDomainTrack: "general_sd",
      whiteboardRenderValidationOperationId: "validation_1",
      whiteboardRenderValidationDisposition: "invalid-mermaid",
      whiteboardRenderSanitationDisposition: "failed",
      whiteboardRenderSanitationChanges: ["normalized-subgraph-label"],
      whiteboardRenderOriginalParserErrorClass: "mermaid-syntax-error",
      whiteboardRenderCandidateRevision: 2,
      whiteboardRenderVisibleRevisionBefore: 1,
      whiteboardRenderVisibleRevisionAfter: 1,
      whiteboardRenderPreservedLastValid: true,
      whiteboardRenderStatus: "preserved-last-valid",
      whiteboardRenderFallbackKind: "last-valid",
      whiteboardRepairOperationId: "repair_1",
      whiteboardRepairDisposition: "shadow-valid",
      whiteboardRepairDurationMs: 420,
      whiteboardRepairBehaviorMutationBlocked: true,
      whiteboardFormatPreference: "mermaid",
      whiteboardMermaidEligible: true,
      whiteboardMermaidRequested: true,
      whiteboardMermaidCommitted: false,
      whiteboardFormatPolicyMiss: false,
      whiteboardFormatConversionAttempted: false,
      whiteboardFormatConversionDisposition: "not-needed",
      whiteboardAsciiFallback: false,
    }),
    "manual"
  );
  await settle();

  const validationWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "whiteboard/render-validations.jsonl"
  );
  const recoveryWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "whiteboard/render-recoveries.jsonl"
  );
  assert.ok(validationWrite);
  assert.ok(recoveryWrite);
  assert.match(stringArg(validationWrite, "payload"), /invalid-mermaid/);
  assert.match(stringArg(validationWrite, "payload"), /broken/);
  assert.match(stringArg(recoveryWrite, "payload"), /shadow-valid/);
  assert.match(stringArg(recoveryWrite, "payload"), /Client -> API/);

  const timelinePayload = native.calls
    .filter(
      (call) =>
        call.command === "write_meeting_session_recording_text" &&
        stringArg(call, "relativePath") === "timeline.jsonl"
    )
    .map((call) => stringArg(call, "payload"))
    .join("");
  assert.match(timelinePayload, /whiteboard-render-validation/);
  assert.match(timelinePayload, /whiteboard-render-recovery/);

  const summaryWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "traces/screen_trace_whiteboard/summary.json"
  );
  assert.ok(summaryWrite);
  const summary = parsePayload(summaryWrite);
  assert.equal(summary.version, 36);
  assert.deepEqual(summary.whiteboard, {
    artifactId: "whiteboard_1",
    revision: 1,
    domainTrack: "general_sd",
    validationOperationId: "validation_1",
    candidateRevision: 2,
    validationDisposition: "invalid-mermaid",
    sanitationDisposition: "failed",
    sanitationChanges: ["normalized-subgraph-label"],
    originalParserErrorClass: "mermaid-syntax-error",
    visibleRevisionBefore: 1,
    visibleRevisionAfter: 1,
    preservedLastValid: true,
    renderStatus: "preserved-last-valid",
    fallbackKind: "last-valid",
    repairOperationId: "repair_1",
    repairDisposition: "shadow-valid",
    repairDurationMs: 420,
    repairBehaviorMutationBlocked: true,
    formatPreference: "mermaid",
    mermaidEligible: true,
    mermaidRequested: true,
    mermaidCommitted: false,
    formatPolicyMiss: false,
    formatConversionAttempted: false,
    formatConversionDisposition: "not-needed",
    asciiFallback: false,
  });

  await manager.stop("test-complete");
});

test("audio segment dispositions use a dedicated payload-free stream", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  await manager.start(START_OPTIONS);
  await settle();

  manager.recordAudioSegmentDisposition({
    traceId: "voice-trace",
    metadata: {
      stage: "native-segment-settled",
      audioSegmentDispositionKey: "capture-1:2:3",
      audioSegmentCanonicalDisposition: "accepted",
      audioSegmentCanonicalDispositionCommitted: true,
      audioSegmentSettlementCommitted: true,
      audioSegmentObservationCount: 2,
      audioSegmentDuplicateObservationCount: 1,
      audioBase64: "must-not-persist",
    },
  });
  await settle();

  const dispositionWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "audio/segment-dispositions.jsonl"
  );
  assert.ok(dispositionWrite);
  const payload = stringArg(dispositionWrite, "payload");
  assert.match(payload, /capture-1:2:3/);
  assert.match(payload, /\"accepted\"/);
  assert.equal(payload.includes("must-not-persist"), false);

  const timelinePayload = native.calls
    .filter(
      (call) =>
        call.command === "write_meeting_session_recording_text" &&
        stringArg(call, "relativePath") === "timeline.jsonl"
    )
    .map((call) => stringArg(call, "payload"))
    .join("");
  assert.match(timelinePayload, /audio-segment-disposition/);
  assert.equal(timelinePayload.includes("must-not-persist"), false);

  await manager.stop("test-complete");
});

test("audio input liveness is copied to a dedicated compact session stream", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  await manager.start(START_OPTIONS);
  await settle();

  manager.recordAudioInputLiveness({
    authorized: true,
    audioInputLivenessState: "signal-observed",
    audioInputLivenessSnapshotSequence: 4,
    nativeCaptureSessionId: "capture-1",
    vadIntervalChunkCount: 94,
    vadIntervalSignalChunkCount: 12,
    audioBase64: "must-not-persist",
  });
  await settle();

  const livenessWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") === "audio/input-liveness.jsonl"
  );
  assert.ok(livenessWrite);
  const livenessPayload = stringArg(livenessWrite, "payload");
  assert.match(livenessPayload, /signal-observed/);
  assert.match(livenessPayload, /capture-1/);
  assert.equal(livenessPayload.includes("must-not-persist"), false);

  const timelinePayload = native.calls
    .filter(
      (call) =>
        call.command === "write_meeting_session_recording_text" &&
        stringArg(call, "relativePath") === "timeline.jsonl"
    )
    .map((call) => stringArg(call, "payload"))
    .join("");
  assert.match(timelinePayload, /native-audio-liveness/);
  assert.match(timelinePayload, /audio\/input-liveness\.jsonl/);
  assert.equal(timelinePayload.includes("must-not-persist"), false);

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

test("session summaries retain answer delivery and artifact stability evidence", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  await manager.start(START_OPTIONS);
  await settle();

  const startedAt = Date.now();
  manager.recordTrace(
    buildCompletedTrace("answer_stability", startedAt, {
      primaryAskSpanCount: 1,
      advisorOutputCommittedToUi: false,
      refreshAuthority: "automatic-soft",
      refreshAuthorityAuthorized: true,
      answerGenerationLeaseId: "lease_1",
      leaseAuthorizedAtStart: true,
      leaseAuthorizedAtCommit: true,
      stableAnswerCommitDisposition: "pending",
      answerDeliveryLockState: "update-ready",
      meSpokenWordEquivalent: 24,
      meAnswerTokenOverlap: 10,
      pendingAnswerDisposition: "committed",
      pendingAnswerOperationId: "pending_1",
      requestedArtifacts: ["answer", "code"],
      authorizedArtifacts: ["answer"],
      generationRequestedArtifacts: ["answer", "complexity"],
      parsedArtifacts: ["answer", "code", "complexity"],
      parentAuthorizedArtifacts: ["answer"],
      screenAuthorizedArtifacts: ["answer", "code", "complexity"],
      committedArtifacts: ["answer", "code", "complexity"],
      screenArtifactAuthoritySource: "manual-screen",
      screenArtifactAuthorityAuthorized: true,
      screenArtifactAuthorityReason: "manual-screen-result; code-present",
      playbookArtifactContractMismatch: true,
      playbookArtifactContractMismatchReasons: [
        "code:not-requested-by-playbook",
      ],
      artifactCacheDisposition: "replaced",
      artifactMutationRejectedReasons: ["code:not-authorized"],
      answerSectionRevision: 2,
      codeSectionRevision: 1,
      previousCodeRevision: 0,
      nextCodeRevision: 1,
      renderedCodeArtifactRevision: 1,
      answerDwellMs: 5_400,
      advisorIntentAuthoritySource: "runtime-intent-gate",
      responseOpportunityLocalDisposition: "runtime-required",
      residualResponseOpportunityInferenceRequired: true,
      responseOpportunityDisposition: "completed",
      responseOpportunityDecision: "output-request",
      responseOpportunityConfidence: 0.96,
      responseOpportunityReleased: true,
      responseOpportunityReleaseReason:
        "high-confidence-output-request",
      responseOpportunityDecisionApplied: true,
      responseOpportunityDurationMs: 810,
      shortIntentLocalDisposition: "runtime-required",
      residualShortIntentAdjudicationRequired: true,
      shortIntentGateDisposition: "completed",
      shortIntentGateAction: "answer",
      shortIntentGateConfidence: 0.96,
      shortIntentGateDecisionApplied: true,
      shortIntentGateAppliedAction: "answer",
      shortIntentGateDurationMs: 810,
      runtimeIntentReleasedAction: "answer",
    }),
    "manual"
  );

  await waitFor(() =>
    native.calls.some(
      (call) =>
        call.command === "write_meeting_session_recording_text" &&
        stringArg(call, "relativePath") ===
          "traces/answer_stability/summary.json"
    )
  );
  const compactCall = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "traces/answer_stability/summary.json"
  );
  assert.ok(compactCall);
  const compact = parsePayload(compactCall);
  assert.equal(compact.answerDeliveryLockState, "update-ready");
  assert.deepEqual(compact.authorizedArtifacts, ["answer"]);
  assert.equal(compact.answerSectionRevision, 2);
  assert.equal(compact.screenArtifactAuthoritySource, "manual-screen");
  assert.deepEqual(compact.screenAuthorizedArtifacts, [
    "answer",
    "code",
    "complexity",
  ]);
  assert.equal(compact.playbookArtifactContractMismatch, true);
  assert.equal(compact.artifactCacheDisposition, "replaced");
  assert.equal(compact.renderedCodeArtifactRevision, 1);
  assert.equal(compact.advisorIntentAuthoritySource, "runtime-intent-gate");
  assert.equal(compact.responseOpportunityDecision, "output-request");
  assert.equal(compact.responseOpportunityReleased, true);
  assert.equal(
    compact.responseOpportunityReleaseReason,
    "high-confidence-output-request"
  );
  assert.equal(compact.shortIntentGateAppliedAction, "answer");

  const sessionSummaryCalls = native.calls.filter(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") === "metrics/session-summary.json"
  );
  const sessionSummary = parsePayload(
    sessionSummaryCalls[sessionSummaryCalls.length - 1]
  );
  const stability = sessionSummary.answerStability as {
    deliveryLockCount: number;
    pendingCommitCount: number;
    answerDwellMs: { p50?: number };
  };
  assert.equal(stability.deliveryLockCount, 1);
  assert.equal(stability.pendingCommitCount, 1);
  assert.equal(stability.answerDwellMs.p50, 5_400);
  const shortIntent = sessionSummary.shortIntent as {
    residualShortIntentAdjudicationCount: number;
    residualShortIntentAnswerCount: number;
    intentGateDecisionAppliedCount: number;
    intentGateDurationMs: { p50?: number };
  };
  assert.equal(shortIntent.residualShortIntentAdjudicationCount, 1);
  assert.equal(shortIntent.residualShortIntentAnswerCount, 1);
  assert.equal(shortIntent.intentGateDecisionAppliedCount, 1);
  assert.equal(shortIntent.intentGateDurationMs.p50, 810);

  manager.recordHumanEvaluations([
    {
      id: "answer_stability_eval",
      traceId: "answer_stability",
      traceKind: "voice",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      failureReasons: [
        "incorrect-visible-refresh",
        "mid-read-interruption",
      ],
    },
  ]);
  await waitFor(
    () =>
      native.calls.filter(
        (call) =>
          call.command === "write_meeting_session_recording_text" &&
          stringArg(call, "relativePath") === "metrics/session-summary.json"
      ).length > sessionSummaryCalls.length
  );
  const refreshedSummaryCalls = native.calls.filter(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") === "metrics/session-summary.json"
  );
  const refreshedStability = parsePayload(
    refreshedSummaryCalls[refreshedSummaryCalls.length - 1]
  ).answerStability as {
    incorrectVisibleRefreshLabelCount: number;
    midReadInterruptionLabelCount: number;
  };
  assert.equal(refreshedStability.incorrectVisibleRefreshLabelCount, 1);
  assert.equal(refreshedStability.midReadInterruptionLabelCount, 1);

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
  manager.recordSemanticEmbeddingRuntimeEvent({
    traceId: "semantic_trace",
    taskId: "task_1",
    metadata: {
      semanticEmbeddingRequestId: "semantic-request-1",
      semanticEmbeddingEvent: "late-result",
      semanticEmbeddingConsumer: "interviewer-intent",
      semanticEmbeddingCoalescingKey: "session:current-question",
      semanticEmbeddingRevision: 4,
      semanticEmbeddingOutcome: "abandoned",
      semanticEmbeddingQueueWaitMs: 18,
      semanticEmbeddingComputeMs: 164,
      semanticEmbeddingTotalMs: 182,
      semanticEmbeddingDeadlineProfile: "warm",
      semanticEmbeddingDeadlinePhase: "compute",
      semanticEmbeddingDeadlineMs: 350,
      semanticEmbeddingCoalesced: false,
      semanticEmbeddingStale: false,
      semanticEmbeddingAbandoned: true,
      semanticEmbeddingCacheHit: false,
      semanticEmbeddingQueueDepth: 1,
      semanticEmbeddingMaxQueueDepth: 2,
      semanticEmbeddingReason: "timed-out-compute-completed",
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
  assert.equal(
    (summary.semanticEmbeddingRuntime as Record<string, unknown>).outcome,
    "abandoned"
  );
  assert.equal(
    (summary.semanticEmbeddingRuntime as Record<string, unknown>).queueWaitMs,
    18
  );

  await manager.stop("test-complete");
});

test("answer sufficiency decisions remain joinable after trace export", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  await manager.start(START_OPTIONS);
  await settle();

  manager.recordTrace(
    buildCompletedTrace("answer_sufficiency_trace", Date.now()),
    "manual"
  );
  await settle();
  manager.recordAnswerSufficiencyDecision({
    traceId: "answer_sufficiency_trace",
    taskId: "task_1",
    decision: {
      schemaVersion: 1,
      detectorVersion: "answer-sufficiency-lexical-v1",
      operationId: "answer-sufficiency:trace",
      traceId: "answer_sufficiency_trace",
      questionId: "question_1",
      logicalQuestionUnitId: "lqu_1",
      logicalQuestionUnitRevision: 2,
      answerRevision: 3,
      answerStatus: "context-insufficient",
      contextDefect: "missing-antecedent",
      recommendedRepair: "enhance",
      confidence: 0.97,
      lexicalEvidence: ["missing-original-problem"],
      semanticPrototypeIds: [],
      expectedArtifactKinds: ["code"],
      missingArtifactKinds: ["code"],
      resolvableByNearbyContext: true,
      candidateContextKinds: ["recent-dialogue"],
      candidateSourceTurnIds: ["turn_1"],
      contextDeltaChars: 180,
      createdAt: Date.now(),
    },
  });
  await settle();

  const decisionWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "answer-sufficiency/decisions.jsonl"
  );
  assert.ok(decisionWrite);
  assert.match(
    stringArg(decisionWrite, "payload"),
    /context-insufficient/
  );

  const summaryWrites = native.calls.filter(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "traces/answer_sufficiency_trace/summary.json"
  );
  const latestSummary = summaryWrites[summaryWrites.length - 1];
  assert.ok(latestSummary);
  const summary = parsePayload(latestSummary);
  assert.equal(
    (summary.answerSufficiency as Record<string, unknown>).status,
    "context-insufficient"
  );
  assert.equal(
    (summary.answerSufficiency as Record<string, unknown>).contextResolvable,
    true
  );

  await manager.stop("test-complete");
});

test("advisor response Shadow records identity and verdict without raw answer text", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  await manager.start(START_OPTIONS);
  await settle();

  const previous = createAdvisorResponseFingerprintRecord({
    sessionId: "session-shadow",
    runtimeEpoch: 1,
    logicalQuestionUnitId: "lqu-shadow",
    logicalQuestionRevision: 1,
    answerRevision: 1,
    sourceTraceId: "advisor_shadow_trace",
    questionType: "general-system-design",
    parentTaskId: "task_1",
    manualCorrectionRevision: 0,
    questionText: "Design a private URL shortener.",
    parsedAnswer: parseMeetingAnswer(
      "Answer:\nUse a private implementation detail."
    ),
    createdAt: 10,
  });
  const current = createAdvisorResponseFingerprintRecord({
    sessionId: "session-shadow",
    runtimeEpoch: 1,
    logicalQuestionUnitId: "lqu-shadow",
    logicalQuestionRevision: 2,
    answerRevision: 2,
    sourceTraceId: "advisor_shadow_trace",
    questionType: "ai-ml-system-design",
    parentTaskId: "task_1",
    manualCorrectionRevision: 0,
    questionText: "Design a private ranking pipeline.",
    parsedAnswer: parseMeetingAnswer(
      "Answer:\nUse the same private implementation detail."
    ),
    createdAt: 20,
  });
  const observation = observeAdvisorResponseConsistency({
    previous: previous.fingerprint,
    current: current.fingerprint,
    questionSimilarity: 0.2,
    answerSimilarity: 0.95,
    createdAt: 21,
  });
  const challenge = createAdvisorHypothesisChallenge({
    observation,
    independentEvidence: ["llm-type-disagreement"],
    createdAt: 22,
  });

  manager.recordAdvisorResponseFingerprint({
    traceId: "advisor_shadow_trace",
    taskId: "task_1",
    fingerprint: current.fingerprint,
  });
  manager.recordAdvisorResponseConsistency({
    traceId: "advisor_shadow_trace",
    taskId: "task_1",
    observation,
  });
  manager.recordAdvisorHypothesisChallenge({
    traceId: "advisor_shadow_trace",
    taskId: "task_1",
    challenge,
  });
  await settle();

  const fingerprintWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "advisor-response/fingerprints.jsonl"
  );
  const consistencyWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "advisor-response/consistency-shadow.jsonl"
  );
  const challengeWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "advisor-response/hypothesis-challenges.jsonl"
  );
  assert.ok(fingerprintWrite);
  assert.ok(consistencyWrite);
  assert.ok(challengeWrite);
  assert.equal(
    stringArg(fingerprintWrite, "payload").includes(
      "private implementation detail"
    ),
    false
  );
  assert.match(
    stringArg(consistencyWrite, "payload"),
    /question-low-answer-high/
  );
  assert.match(
    stringArg(challengeWrite, "payload"),
    /llm-type-disagreement/
  );

  await manager.stop("test-complete");
});

test("late LLM taxonomy adjudication stays joinable after trace export", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  await manager.start(START_OPTIONS);
  await settle();

  manager.recordTrace(
    buildCompletedTrace("adjudication_trace", Date.now()),
    "manual"
  );
  await settle();
  manager.recordTaxonomyAdjudicationDecision({
    traceId: "adjudication_trace",
    taskId: "task_1",
    metadata: {
      taxonomyAdjudicationMode: "shadow",
      taxonomyAdjudicationEligible: true,
      taxonomyAdjudicationPromptVersion:
        "interviewer-intent-adjudication-prompt-v3",
      taxonomyAdjudicationSchemaVersion: 2,
      taxonomyAdjudicationOutputContractVersion: 3,
      taxonomyAdjudicationParsedOutputContractVersion: 3,
      taxonomyAdjudicationRequestHash: "request-hash-1",
      taxonomyAdjudicationDisposition: "completed",
      taxonomyAdjudicationOperationId: "intent-op-1",
      taxonomyAdjudicationUnitId: "logical_1",
      taxonomyAdjudicationUnitRevision: 2,
      taxonomyAdjudicationScheduledTaskId: "task_1",
      taxonomyAdjudicationSettlementTaskId: "task_2",
      taxonomyAdjudicationProviderId: "fast-classifier",
      taxonomyAdjudicationProviderDisposition: "completed-with-content",
      taxonomyAdjudicationParseDisposition: "valid-json",
      taxonomyAdjudicationOutputEnvelope: "direct",
      taxonomyAdjudicationLeaseAuthorized: true,
      taxonomyAdjudicationCandidateType: "coding",
      taxonomyAdjudicationRelation: "new-parent",
      taxonomyAdjudicationParseValid: true,
      taxonomyAdjudicationWouldRepair: true,
      taxonomyAdjudicationRepairFactors: ["question-type", "relation"],
      taxonomyAdjudicationRepairApplied: false,
      taxonomyAdjudicationDurationMs: 611,
      taxonomyAdjudicationBudgetSlot: "ambient",
      taxonomyAdjudicationBudgetReason: "ambient-discourse",
      taxonomyAdjudicationSourceOwnedSubstantive: false,
      taxonomyAdjudicationBudgetStartsBefore: 0,
      taxonomyAdjudicationBudgetStartsAfter: 1,
      taxonomyAdjudicationBudgetLimit: 1,
      taxonomyAdjudicationBudgetRemaining: 0,
      taxonomyAdjudicationAmbientStarts: 1,
      taxonomyAdjudicationSubstantiveStarts: 0,
      taxonomyAdjudicationReservedSubstantiveAvailable: true,
      taxonomyAdjudicationRawOutputHash: "hash-1",
      taxonomyAdjudicationRawOutputStored: true,
      taxonomyAdjudicationRawOutputTruncated: false,
      interviewerIntentLlmMode: "shadow",
      interviewerIntentLlmEligible: true,
      interviewerIntentLlmPromptVersion:
        "interviewer-intent-adjudication-prompt-v3",
      interviewerIntentLlmSchemaVersion: 2,
      interviewerIntentLlmOutputContractVersion: 3,
      interviewerIntentLlmParsedOutputContractVersion: 3,
      interviewerIntentLlmRequestHash: "request-hash-1",
      interviewerIntentLlmOperationId: "intent-op-1",
      interviewerIntentLlmUnitId: "logical_1",
      interviewerIntentLlmUnitRevision: 2,
      interviewerIntentLlmScheduledTaskId: "task_1",
      interviewerIntentLlmSettlementTaskId: "task_2",
      interviewerIntentLlmProviderId: "fast-classifier",
      interviewerIntentLlmDisposition: "completed",
      interviewerIntentLlmOutputEnvelope: "direct",
      interviewerIntentLlmLeaseAuthorized: true,
      interviewerIntentLlmSpeechAct: "directive",
      interviewerIntentLlmQuestionType: "coding",
      interviewerIntentLlmRelation: "new-parent",
      interviewerIntentLlmEvidenceMode: "hypothetical-design",
      interviewerIntentLlmAction: "answer",
      interviewerIntentLlmNormalizedQuestion: "Implement a queue.",
      interviewerIntentLlmPrimaryAskSpanCount: 1,
      interviewerIntentLlmPrimaryAskSpanTexts: ["Implement a queue."],
      interviewerIntentLlmPrimaryAskSourceTurnIds: ["turn_1"],
      interviewerIntentLlmLocalSpeechAct: "question",
      interviewerIntentLlmLocalQuestionType: "unknown",
      interviewerIntentLlmLocalRelation: "none",
      interviewerIntentLlmLocalEvidenceMode: "unknown",
      interviewerIntentLlmLocalAction: "ignore",
      interviewerIntentLlmLocalPrimaryAsk: "Can you implement that?",
      interviewerIntentLlmRepairFactors: [
        "speech-act",
        "question-type",
        "relation",
        "evidence-mode",
        "action",
        "primary-ask",
      ],
      interviewerIntentLlmParseValid: true,
      interviewerIntentLlmWouldRepair: true,
      interviewerIntentLlmRepairApplied: false,
      interviewerIntentLlmDurationMs: 611,
      interviewerIntentLlmBudgetSlot: "ambient",
      interviewerIntentLlmBudgetReason: "ambient-discourse",
      interviewerIntentLlmSourceOwnedSubstantive: false,
      interviewerIntentLlmBudgetStartsBefore: 0,
      interviewerIntentLlmBudgetStartsAfter: 1,
      interviewerIntentLlmBudgetRemaining: 0,
      interviewerIntentLlmReservedSubstantiveAvailable: true,
      currentQuestionTerminalNoAnswerDisposition: "terminal-no-answer",
      currentQuestionTerminalNoAnswerAuthorized: true,
      currentQuestionTerminalNoAnswerUnitId: "logical_1",
      currentQuestionTerminalNoAnswerRevision: 2,
      currentQuestionTerminalNoAnswerSourceTurnIds: ["turn_1"],
      currentQuestionTerminalNoAnswerOperationId: "intent-op-1",
      currentQuestionTerminalNoAnswerOperationKind:
        "informational-no-primary-ask",
      currentQuestionTerminalNoAnswerDisplayDisposition: "visible",
      currentQuestionTerminalNoAnswerContextDisposition:
        "append-bounded-context",
      currentQuestionTerminalNoAnswerSpeechAct: "acknowledgment",
      currentQuestionTerminalNoAnswerAction: "ignore",
      currentQuestionTerminalNoAnswerConfidence: 0.99,
      currentQuestionTerminalNoAnswerReasons: [
        "terminal-no-answer-contract-satisfied",
      ],
      interviewerIntentLlmTerminalNoAnswerApplied: true,
      interviewerIntentLlmTerminalNoAnswerApplyReason:
        "authorized-before-visible-answer",
      interviewerIntentLlmTerminalNoAnswerAdvisorCancelled: true,
      taxonomyAdjudicationTerminalNoAnswerAdvisorMatched: true,
      taxonomyAdjudicationTerminalNoAnswerMemoryStarted: false,
      taxonomyAdjudicationTerminalNoAnswerModelStarted: false,
      taxonomyAdjudicationTerminalNoAnswerAvoidedMemoryOpportunity: true,
      taxonomyAdjudicationTerminalNoAnswerAvoidedModelOpportunity: true,
    },
  });
  await settle();

  const eventWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") === "taxonomy/llm-adjudications.jsonl"
  );
  assert.ok(eventWrite);
  const intentWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") === "intent/llm-adjudications.jsonl"
  );
  assert.ok(intentWrite);

  const summaryWrites = native.calls.filter(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "traces/adjudication_trace/summary.json"
  );
  const latestSummary = summaryWrites[summaryWrites.length - 1];
  assert.ok(latestSummary);
  const summary = parsePayload(latestSummary);
  const adjudication = summary.taxonomyAdjudication as Record<string, unknown>;
  assert.equal(adjudication.mode, "shadow");
  assert.equal(adjudication.candidateType, "coding");
  const intent = summary.interviewerIntentLlm as Record<string, unknown>;
  assert.equal(intent.speechAct, "directive");
  assert.equal(intent.questionType, "coding");
  assert.equal(
    intent.promptVersion,
    "interviewer-intent-adjudication-prompt-v3"
  );
  assert.equal(intent.schemaVersion, 2);
  assert.equal(intent.requestHash, "request-hash-1");
  assert.equal(intent.scheduledTaskId, "task_1");
  assert.equal(intent.settlementTaskId, "task_2");
  assert.equal(intent.providerId, "fast-classifier");
  assert.equal(intent.outputEnvelope, "direct");
  assert.equal(intent.outputContractVersion, 3);
  assert.equal(intent.parsedOutputContractVersion, 3);
  assert.equal(intent.leaseAuthorized, true);
  assert.equal(intent.normalizedQuestion, undefined);
  assert.equal(intent.primaryAskSpanTexts, undefined);
  assert.equal(intent.localPrimaryAsk, undefined);
  assert.equal(intent.primaryAskSpanCount, 1);
  assert.deepEqual(intent.primaryAskSourceTurnIds, ["turn_1"]);
  assert.deepEqual(intent.repairFactors, [
    "speech-act",
    "question-type",
    "relation",
    "evidence-mode",
    "action",
    "primary-ask",
  ]);
  assert.equal(adjudication.relation, "new-parent");
  assert.equal(adjudication.outputContractVersion, 3);
  assert.equal(adjudication.parsedOutputContractVersion, 3);
  assert.equal(adjudication.scheduledTaskId, "task_1");
  assert.equal(adjudication.settlementTaskId, "task_2");
  assert.equal(adjudication.leaseAuthorized, true);
  assert.deepEqual(adjudication.repairFactors, [
    "question-type",
    "relation",
  ]);
  assert.equal(adjudication.wouldRepair, true);
  assert.equal(adjudication.repairApplied, false);
  assert.equal(adjudication.durationMs, 611);
  assert.equal(adjudication.providerDisposition, "completed-with-content");
  assert.equal(adjudication.parseDisposition, "valid-json");
  assert.equal(adjudication.rawOutputHash, "hash-1");
  assert.equal(adjudication.rawOutputStored, true);
  assert.equal(adjudication.rawOutputTruncated, false);
  assert.equal(adjudication.budgetSlot, "ambient");
  assert.equal(adjudication.ambientStarts, 1);
  assert.equal(adjudication.substantiveStarts, 0);
  assert.equal(adjudication.reservedSubstantiveAvailable, true);
  const terminal = summary.currentQuestionTerminalNoAnswer as Record<
    string,
    unknown
  >;
  assert.equal(terminal.disposition, "terminal-no-answer");
  assert.equal(
    terminal.operationKind,
    "informational-no-primary-ask"
  );
  assert.equal(terminal.displayDisposition, "visible");
  assert.equal(
    terminal.contextDisposition,
    "append-bounded-context"
  );
  assert.equal(terminal.authorized, true);
  assert.equal(terminal.applied, true);
  assert.equal(terminal.advisorCancelled, true);
  assert.equal(terminal.avoidedMemoryOpportunity, true);
  assert.equal(terminal.avoidedModelOpportunity, true);

  await manager.stop("test-complete");
});

test("compact trace summaries preserve task boundary and cross-domain evidence", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  await manager.start(START_OPTIONS);
  await settle();

  manager.recordTrace(
    buildCompletedTrace("boundary_trace", Date.now(), {
      taskBoundaryLogicalQuestionUnitId: "logical_1",
      logicalQuestionUnitId: "logical_1",
      logicalQuestionUnitRevision: 3,
      logicalQuestionCurrentTurnId: "turn_2",
      logicalQuestionSourceTurnIds: ["turn_1", "turn_2"],
      logicalQuestionCompositionReasons: [
        "new-question",
        "referential-completion",
      ],
      logicalQuestionBoundaryReason: "bounded-followup",
      logicalQuestionTruncated: false,
      phaseSignal: "assumption-authorized",
      phaseSignalSource: "interviewer",
      phaseSignalSourceTurnId: "turn_2",
      assumptionAuthorizationState: "authorized",
      assumptionAuthorizationReason: "authorized",
      phaseBefore: "requirement_clarification",
      phaseAfter: "design_framing",
      whiteboardRevisionRequested: true,
      canonicalLogicalQuestionMaterialized: true,
      canonicalLogicalQuestionMaterializationReason: "answer-refresh",
      primaryAskSpeechAct: "question",
      primaryAskDisposition: "answer-primary-ask",
      primaryAskReason: "terminal-ask-after-setup",
      primaryAskConfidence: 0.97,
      primaryAskNormalizedText: "How does this role sound to you?",
      primaryAskSourceTurnIds: ["turn_1", "turn_2"],
      primaryAskSourceChars: 320,
      primaryAskSpanCount: 1,
      primaryAskSetupSpanCount: 2,
      primaryAskQuotedOrFutureSpanCount: 1,
      primaryAskAnswerFocusChars: 36,
      primaryAskSemanticEvidenceChars: 114,
      primaryAskAnswerFocusSpanCount: 1,
      primaryAskObjectSpanCount: 2,
      primaryAskScenarioSpanCount: 1,
      primaryAskSemanticEvidenceRetentionReasons: [
        "answer-focus",
        "setup-object",
      ],
      primaryAskSemanticEvidenceDroppedReasons: [
        "quoted-or-future-example",
      ],
      primaryAskTurnGateView: "answer-focus",
      primaryAskTaxonomyView: "semantic-evidence",
      primaryAskTaskSettlementView: "semantic-evidence",
      primaryAskAdvisorView: "answer-focus-plus-semantic-context",
      primaryAskAnswerFocusQuestionTypeProposal: "field-knowledge",
      primaryAskSemanticEvidenceQuestionTypeProposal:
        "general-system-design",
      primaryAskQuestionTypeProposalChanged: true,
      logicalQuestionLeaseAuthorized: true,
      logicalQuestionLeaseAuthorizationReason: "logical-question-current",
      logicalQuestionLeaseAuthorizationStage: "final-commit",
      forceAdviseTargetStatus: "already-advised",
      forceAdviseAutomaticExecutionState: "visible-committed",
      forceAdviseManualExecutionState: "idle",
      forceAdviseVisibleCommitRevision: 7,
      forceAdviseEligible: false,
      forceAdviseRetryable: false,
      forceAdviseEligibilityReason: "advisor-committed",
      forceAdviseRepairCause: "intent-false-negative",
      forceAdviseAdvisorOutcome: "visible-answer-committed",
      forceAdviseRecoveredPendingCandidate: false,
      manualCorrectionOwnership: "canonical-logical-question",
      taskRelation: "new-parent",
      advisorPromptIncludedLogicalQuestion: true,
      advisorPromptLogicalQuestionSourceCount: 2,
      advisorOutputCommittedToUi: true,
      advisorOutputCommitAuthorized: true,
      visibleAnswerChanged: true,
      taskBoundaryCandidateId: "boundary_1",
      taskBoundaryCandidateState: "committed",
      taskBoundaryCommitPolicy: "immediate",
      taskBoundaryMutationDisposition: "commit-before-advisor",
      taskBoundaryAuthoritySource: "accepted-transcript",
      taskBoundarySourceTurnIds: ["turn_1", "turn_2"],
      taskBoundaryCommittedBeforeAdvisor: true,
      taskBoundaryCommittedParentId: "parent_new",
      taskBoundarySurvivedAdvisorCancellation: true,
      parentBeforeId: "parent_old",
      parentBeforeType: "general-system-design",
      parentAfterId: "parent_new",
      parentAfterType: "ai-ml-system-design",
      crossDomainTransitionKind: "linked-parent-extension",
      crossDomainTransitionReason: "explicit-same-product-ai-ml-extension",
      crossDomainPreviousQuestionType: "general-system-design",
      crossDomainNextQuestionType: "ai-ml-system-design",
      crossDomainSharedDomainTokens: ["food"],
      crossDomainTransitionEvidence: ["explicit-same-product-marker"],
      parentContextHandoffKind: "bounded-source-backed",
      parentContextHandoffSourceId: "parent_old",
      parentContextHandoffSourceQuestionId: "question_new",
      personalEvidenceRequirement: "personal-logistics",
      personalEvidenceStatusDomain: "health-status",
      personalEvidenceAllowedSources: [
        "profile-memory",
        "confirmed-me",
      ],
      personalEvidenceSelectedSources: ["profile-memory"],
      personalEvidenceGuardrailMode: "enforcement",
      personalEvidenceEnforced: true,
      unsupportedClaimRisk: "guarded",
    }),
    "manual"
  );
  await settle();

  const summaryWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") === "traces/boundary_trace/summary.json"
  );
  assert.ok(summaryWrite);
  const summary = parsePayload(summaryWrite);
  assert.equal(summary.version, 36);
  assert.equal(summary.taskRelation, "new-parent");
  assert.equal(summary.logicalQuestionUnitRevision, 3);
  assert.equal(summary.phaseSignal, "assumption-authorized");
  assert.equal(summary.phaseSignalSource, "interviewer");
  assert.equal(summary.phaseSignalSourceTurnId, "turn_2");
  assert.equal(summary.assumptionAuthorizationState, "authorized");
  assert.equal(summary.phaseBefore, "requirement_clarification");
  assert.equal(summary.phaseAfter, "design_framing");
  assert.equal(summary.whiteboardRevisionRequested, true);
  assert.deepEqual(summary.logicalQuestionSourceTurnIds, ["turn_1", "turn_2"]);
  assert.deepEqual(summary.logicalQuestionCompositionReasons, [
    "new-question",
    "referential-completion",
  ]);
  assert.equal(summary.advisorPromptIncludedLogicalQuestion, true);
  assert.equal(summary.advisorOutputCommittedToUi, true);
  assert.equal(summary.visibleAnswerChanged, true);
  assert.equal(summary.forceAdviseRetryable, false);
  assert.equal(
    summary.forceAdviseAutomaticExecutionState,
    "visible-committed"
  );
  assert.equal(summary.forceAdviseManualExecutionState, "idle");
  assert.equal(summary.forceAdviseVisibleCommitRevision, 7);
  assert.equal(summary.forceAdviseRecoveredPendingCandidate, false);
  assert.equal(summary.forceAdviseEligibilityReason, "advisor-committed");
  assert.equal(summary.forceAdviseRepairCause, "intent-false-negative");
  assert.equal(
    summary.forceAdviseAdvisorOutcome,
    "visible-answer-committed"
  );
  assert.equal(summary.logicalQuestionLeaseAuthorized, true);
  assert.equal(summary.primaryAskSpeechAct, "question");
  assert.equal(summary.primaryAskDisposition, "answer-primary-ask");
  assert.equal(summary.primaryAskNormalizedText, undefined);
  assert.deepEqual(summary.primaryAskSourceTurnIds, ["turn_1", "turn_2"]);
  assert.equal(summary.primaryAskQuotedOrFutureSpanCount, 1);
  assert.equal(summary.primaryAskAnswerFocusChars, 36);
  assert.equal(summary.primaryAskSemanticEvidenceChars, 114);
  assert.equal(summary.primaryAskAnswerFocusSpanCount, 1);
  assert.equal(summary.primaryAskObjectSpanCount, 2);
  assert.equal(summary.primaryAskScenarioSpanCount, 1);
  assert.deepEqual(summary.primaryAskSemanticEvidenceRetentionReasons, [
    "answer-focus",
    "setup-object",
  ]);
  assert.deepEqual(summary.primaryAskSemanticEvidenceDroppedReasons, [
    "quoted-or-future-example",
  ]);
  assert.equal(summary.primaryAskTurnGateView, "answer-focus");
  assert.equal(summary.primaryAskTaxonomyView, "semantic-evidence");
  assert.equal(
    summary.primaryAskTaskSettlementView,
    "semantic-evidence"
  );
  assert.equal(
    summary.primaryAskAdvisorView,
    "answer-focus-plus-semantic-context"
  );
  assert.equal(
    summary.primaryAskAnswerFocusQuestionTypeProposal,
    "field-knowledge"
  );
  assert.equal(
    summary.primaryAskSemanticEvidenceQuestionTypeProposal,
    "general-system-design"
  );
  assert.equal(summary.primaryAskQuestionTypeProposalChanged, true);
  assert.equal(
    summary.logicalQuestionLeaseAuthorizationReason,
    "logical-question-current"
  );
  assert.equal(
    summary.manualCorrectionOwnership,
    "canonical-logical-question"
  );
  assert.deepEqual(
    (summary.taskBoundary as Record<string, unknown>).sourceTurnIds,
    ["turn_1", "turn_2"]
  );
  assert.equal(
    (summary.taskBoundary as Record<string, unknown>).committedBeforeAdvisor,
    true
  );
  assert.equal(
    (summary.crossDomainTransition as Record<string, unknown>).kind,
    "linked-parent-extension"
  );
  assert.equal(
    (summary.crossDomainTransition as Record<string, unknown>)
      .parentContextHandoffKind,
    "bounded-source-backed"
  );
  assert.equal(
    (summary.personalEvidence as Record<string, unknown>).statusDomain,
    "health-status"
  );
  assert.deepEqual(
    (summary.personalEvidence as Record<string, unknown>).allowedSources,
    ["profile-memory", "confirmed-me"]
  );
  assert.deepEqual(
    (summary.personalEvidence as Record<string, unknown>).selectedSources,
    ["profile-memory"]
  );

  await manager.stop("test-complete");
});

test("compact trace summaries preserve bounded STT request evidence", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  await manager.start(START_OPTIONS);
  await settle();

  manager.recordTrace(
    buildCompletedTrace("stt_request_trace", Date.now(), {
      sttRequestProviderId: "openai-whisper",
      sttRequestConfiguredProviderId: "openai-whisper",
      sttRequestProviderIdentityStatus: "matched",
      sttRequestModelId: "gpt-4o-mini-transcribe",
      sttRequestModelSource: "selected-provider-variable",
      sttRequestLanguageMode: "automatic",
      sttRequestLanguageSource: "not-observed",
      sttRequestPromptKind: "speech-bias+continuation",
      sttRequestPromptChars: 142,
      sttRequestPromptHash: "a1b2c3d4",
      sttRequestSpeechBiasChars: 88,
      sttRequestContinuationChars: 54,
      sttRequestPromptTruncated: false,
      sttRequestTermCount: 7,
      sttRequestConfidenceCapability: "not-exposed-by-text-adapter",
      sttRequestEvidenceDurationMs: 0.37,
      sttQueueEnqueuedAt: 1_000,
      sttQueueDequeuedAt: 1_180,
      sttQueueAgeMs: 180,
      sttQueueDepthAtEnqueue: 3,
      sttQueueDepthAtDequeue: 2,
      sttQueueDequeueAuthorized: true,
      sttRequestLifecycleEvent: "abort-observed",
      sttRequestLifecycleAttemptId: "stt_attempt_2",
      sttRequestStartedAt: 1_200,
      sttRequestTimeoutMs: 30_000,
      sttRequestDurationMs: 30_025,
      sttRequestAbortRequested: true,
      sttRequestAbortRequestedAt: 31_200,
      sttRequestAbortObserved: true,
      sttRequestAbortObservedAt: 31_225,
      sttRequestAbortReason: "timeout",
      sttProviderTimeout: true,
      sttProviderSettledAfterAbortMs: 30_025,
      nativeSampleRate: 48_000,
      nativeSampleStart: 48_000,
      nativeSampleEnd: 1_488_000,
      nativeDurationMs: 30_000,
      nativeSegmentEndReason: "forced-rollover",
      nativeRolloverFamilyId: "rollover-family-1",
      nativeOverlapSampleCount: 19_200,
      nativeOverlapDurationMs: 400,
      nativeVadSilenceTargetSamples: 50_160,
      nativeVadMinimumSpeechSamples: 7_824,
      nativeVadPreSpeechSamples: 13_392,
      nativeVadMaximumSegmentSamples: 1_440_000,
      sttContinuationDisposition: "consumed",
      sttContinuationReason: "matching-continuation-lease",
      sttContinuationLeaseId: "stt_continuation_1",
      sttContinuationOperationId: "sentence_buffer_1",
      sttContinuationSourceTurnId: "turn_1",
      sttContinuationSourceTraceId: "trace_1",
      sttContinuationCandidateSequence: 8,
      sttContinuationLeaseExpiresAt: 4_000,
      sttContinuationLeaseConsumedAt: 2_400,
      sttAttemptCount: 2,
      sttInitialAttemptId: "stt_attempt_1",
      sttInitialValidationDisposition: "rejected",
      sttInitialValidationReason: "prompt-echo-exact",
      sttRetryTriggered: true,
      sttRetryDisposition: "recovered",
      sttRetryReason: "prompt-echo-exact",
      sttRetryAttemptId: "stt_attempt_2",
      sttRetryValidationDisposition: "accepted",
      sttRetryValidationReason: "valid",
      sttFinalAttemptId: "stt_attempt_2",
      sttFinalAttemptNumber: 2,
      sttFinalPromptMode: "unbiased",
      sttInitialRequestDurationMs: 820,
      sttRetryRequestDurationMs: 760,
      sttTotalRequestDurationMs: 1_580,
      sttValidationDisposition: "accepted",
      sttValidationReason: "accepted",
      audioSegmentCanonicalDisposition: "prompt-echo-retry-accepted",
      audioSegmentDispositionReason:
        "unbiased-retry-produced-accepted-transcript",
      audioSegmentObservationCount: 2,
      audioSegmentDuplicateObservationCount: 1,
      audioSegmentCanonicalDispositionCommitted: true,
      audioSegmentSettlementCommitted: true,
      sttFinalTranscriptChars: 72,
      sentenceBufferContinuationAuthorized: true,
      sentenceBufferContinuationReason: "matching-native-speech-start",
      sentenceBufferContinuationHandoffSource: "cached-event",
      sentenceBufferContinuationCandidateSequence: 8,
      sentenceBufferContinuationExtensionUsed: true,
      sentenceBufferInitialWaitMs: 220,
      sentenceBufferContinuationWaitMs: 910,
      sentenceBufferContinuationDeadlineAt: 4_000,
      sentenceBufferAbsoluteDeadlineAt: 6_000,
    }),
    "manual"
  );
  await settle();

  const summaryWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "traces/stt_request_trace/summary.json"
  );
  assert.ok(summaryWrite);
  const summary = parsePayload(summaryWrite);
  assert.equal(summary.version, 36);
  assert.equal(
    (summary.timingsMs as Record<string, unknown>).stt,
    1_580
  );
  assert.equal(
    (summary.payload as Record<string, unknown>).transcriptChars,
    72
  );
  assert.deepEqual(summary.nativeAudioBoundary, {
    sampleRate: 48_000,
    sampleStart: 48_000,
    sampleEnd: 1_488_000,
    durationMs: 30_000,
    endReason: "forced-rollover",
    rolloverFamilyId: "rollover-family-1",
    overlapSampleCount: 19_200,
    overlapDurationMs: 400,
    silenceTargetSamples: 50_160,
    minimumSpeechSamples: 7_824,
    preSpeechSamples: 13_392,
    maximumSegmentSamples: 1_440_000,
  });
  assert.deepEqual(summary.sttRequest, {
    providerId: "openai-whisper",
    configuredProviderId: "openai-whisper",
    providerIdentityStatus: "matched",
    modelId: "gpt-4o-mini-transcribe",
    modelSource: "selected-provider-variable",
    languageMode: "automatic",
    languageSource: "not-observed",
    promptKind: "speech-bias+continuation",
    promptChars: 142,
    promptHash: "a1b2c3d4",
    speechBiasChars: 88,
    continuationChars: 54,
    promptTruncated: false,
    termCount: 7,
    confidenceCapability: "not-exposed-by-text-adapter",
    evidenceDurationMs: 0.37,
    queueEnqueuedAt: 1_000,
    queueDequeuedAt: 1_180,
    queueAgeMs: 180,
    queueDepthAtEnqueue: 3,
    queueDepthAtDequeue: 2,
    queueDequeueAuthorized: true,
    lifecycleEvent: "abort-observed",
    lifecycleAttemptId: "stt_attempt_2",
    startedAt: 1_200,
    durationMs: 30_025,
    timeoutMs: 30_000,
    abortRequested: true,
    abortRequestedAt: 31_200,
    abortObserved: true,
    abortObservedAt: 31_225,
    abortReason: "timeout",
    providerTimeout: true,
    providerSettledAfterAbortMs: 30_025,
    continuationDisposition: "consumed",
    continuationReason: "matching-continuation-lease",
    continuationLeaseId: "stt_continuation_1",
    continuationOperationId: "sentence_buffer_1",
    continuationSourceTurnId: "turn_1",
    continuationSourceTraceId: "trace_1",
    continuationCandidateSequence: 8,
    continuationLeaseExpiresAt: 4_000,
    continuationLeaseConsumedAt: 2_400,
    attemptCount: 2,
    initialAttemptId: "stt_attempt_1",
    initialValidationDisposition: "rejected",
    initialValidationReason: "prompt-echo-exact",
    retryTriggered: true,
    retryDisposition: "recovered",
    retryReason: "prompt-echo-exact",
    retryAttemptId: "stt_attempt_2",
    retryValidationDisposition: "accepted",
    retryValidationReason: "valid",
    finalAttemptId: "stt_attempt_2",
    finalAttemptNumber: 2,
    finalPromptMode: "unbiased",
    initialRequestDurationMs: 820,
    retryRequestDurationMs: 760,
    totalRequestDurationMs: 1_580,
  });
  assert.deepEqual(summary.audioSegment, {
    disposition: "prompt-echo-retry-accepted",
    reason: "unbiased-retry-produced-accepted-transcript",
    observationCount: 2,
    duplicateObservationCount: 1,
    canonicalCommitted: true,
  });
  assert.equal(summary.sentenceBufferContinuationAuthorized, true);
  assert.equal(
    summary.sentenceBufferContinuationReason,
    "matching-native-speech-start"
  );
  assert.equal(summary.sentenceBufferContinuationHandoffSource, "cached-event");
  assert.equal(summary.sentenceBufferContinuationCandidateSequence, 8);
  assert.equal(summary.sentenceBufferContinuationExtensionUsed, true);
  assert.equal(summary.sentenceBufferInitialWaitMs, 220);
  assert.equal(summary.sentenceBufferContinuationWaitMs, 910);
  assert.equal(summary.sentenceBufferContinuationDeadlineAt, 4_000);
  assert.equal(summary.sentenceBufferAbsoluteDeadlineAt, 6_000);

  await manager.stop("test-complete");
});

test("refreshes compact STT lifecycle evidence after a late provider abort", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  await manager.start(START_OPTIONS);
  await settle();

  const trace = buildCompletedTrace("late_stt_abort_trace", Date.now(), {
    sttQueueAgeMs: 90,
    sttRequestLifecycleEvent: "abort-requested",
    sttRequestLifecycleAttemptId: "stt_attempt_late",
    sttRequestAbortRequested: true,
    sttRequestAbortReason: "timeout",
    sttProviderTimeout: true,
  });
  manager.recordTrace(trace, "manual");
  await settle();

  trace.metadata = {
    ...trace.metadata,
    sttRequestLifecycleEvent: "abort-observed",
    sttRequestAbortObserved: true,
    sttRequestAbortObservedAt: Date.now(),
    sttProviderSettledAfterAbortMs: 30_040,
  };
  manager.refreshRecordedTrace(trace, "manual");
  await settle();

  const summaryWrites = native.calls.filter(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "traces/late_stt_abort_trace/summary.json"
  );
  assert.ok(summaryWrites.length >= 2);
  const summary = parsePayload(summaryWrites[summaryWrites.length - 1]!);
  assert.equal(summary.version, 36);
  assert.equal(
    (summary.sttRequest as Record<string, unknown>).abortRequested,
    true
  );
  assert.equal(
    (summary.sttRequest as Record<string, unknown>).abortObserved,
    true
  );
  assert.equal(
    (summary.sttRequest as Record<string, unknown>).providerTimeout,
    true
  );

  await manager.stop("test-complete");
});

test("compact trace summaries preserve hard memory invalidation evidence", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  await manager.start(START_OPTIONS);
  await settle();

  const startedAt = Date.now();
  const trace = buildCompletedTrace("memory_authority_trace", startedAt);
  trace.steps = [
    {
      id: "memory_step",
      name: "Memory retrieval",
      status: "success",
      startedAt: startedAt + 10,
      endedAt: startedAt + 30,
      durationMs: 20,
      metadata: {
        selectedEntries: 0,
        memoryCacheState: "load-coalesced",
        memoryCacheHit: false,
        memorySnapshotVersion: 8,
        memorySnapshotGeneration: 4,
        memoryAuthorityRevision: 2,
        memoryInvalidationKind: "hard",
        memoryInvalidationReason: "memory-entry-disabled",
        memoryInvalidationPreviousSnapshotVersion: 7,
        memoryInvalidationNewSnapshotVersion: 8,
        memoryInvalidationToFirstReadMs: 18,
        memoryInvalidationFirstRead: true,
        memoryHardInvalidationDisposition:
          "fresh-snapshot-loaded-after-fail-closed",
        memoryHardInvalidationAffectedEntryIds: ["entry-a"],
        memoryHardInvalidationTargetsExcluded: true,
        memoryHardInvalidationStaleSnapshotServed: false,
      },
    },
  ];
  manager.recordTrace(trace, "manual");
  await settle();

  const summaryWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "traces/memory_authority_trace/summary.json"
  );
  assert.ok(summaryWrite);
  const summary = parsePayload(summaryWrite);
  assert.equal(summary.version, 36);
  const memory = summary.memory as Record<string, unknown>;
  assert.equal(memory.authorityRevision, 2);
  assert.equal(memory.invalidationKind, "hard");
  assert.equal(memory.invalidationReason, "memory-entry-disabled");
  assert.equal(memory.invalidationPreviousSnapshotVersion, 7);
  assert.equal(memory.invalidationNewSnapshotVersion, 8);
  assert.equal(memory.invalidationToFirstReadMs, 18);
  assert.equal(memory.invalidationFirstRead, true);
  assert.equal(
    memory.hardInvalidationDisposition,
    "fresh-snapshot-loaded-after-fail-closed"
  );
  assert.deepEqual(memory.hardInvalidationAffectedEntryIds, ["entry-a"]);
  assert.equal(memory.hardInvalidationTargetsExcluded, true);
  assert.equal(memory.hardInvalidationStaleSnapshotServed, false);

  await manager.stop("test-complete");
});

test("records compact current-question settlement and execution-plan evidence", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  await manager.start(START_OPTIONS);
  await settle();

  const currentQuestion: ProvisionalCurrentQuestion = {
    logicalQuestionUnitId: "question_settlement_unit",
    revision: 3,
    sessionId: "session-runtime",
    runtimeEpoch: 7,
    normalizedText: "Design a ride-sharing backend",
    sourceTurnIds: ["turn_a", "turn_b"],
    sourceObservationIds: ["screen_a"],
    sourceKind: "mixed",
    sourceHash: "source_hash_a",
    createdAt: 10,
    updatedAt: 20,
  };
  const settlementDecision: CurrentQuestionSettlementDecision = {
    settlementId: "settlement_a",
    logicalQuestionUnitId: currentQuestion.logicalQuestionUnitId,
    revision: currentQuestion.revision,
    sessionId: currentQuestion.sessionId,
    runtimeEpoch: currentQuestion.runtimeEpoch,
    sourceHash: currentQuestion.sourceHash,
    questionType: "general-system-design",
    relation: "new-parent",
    action: "answer",
    evidenceMode: "hypothetical-design",
    authority: "deterministic-fast-path",
    authoritySource: "accepted-transcript",
    typeAuthoritySource: "deterministic-fast-path",
    relationAuthoritySource: "deterministic-fast-path",
    actionAuthoritySource: "deterministic-fast-path",
    typeMutationAuthorized: true,
    relationMutationAuthorized: true,
    parentMutationAuthorized: true,
    responseAuthorized: true,
    confidence: 0.94,
    activeParentId: "parent_before",
    activeParentRevision: 2,
    manualCorrectionRevision: 0,
    rejectedProposals: [],
    reasons: ["parent-mutation-authorized", "response-authorized"],
  };
  const plan = {
    id: "plan_a",
    settlementId: settlementDecision.settlementId,
    sessionId: settlementDecision.sessionId,
    runtimeEpoch: settlementDecision.runtimeEpoch,
    logicalQuestionUnitId: settlementDecision.logicalQuestionUnitId,
    logicalQuestionRevision: settlementDecision.revision,
    sourceHash: settlementDecision.sourceHash,
    questionType: "general-system-design",
    relation: "new-parent",
    taskRelation: "new-parent",
    responseAuthorized: true,
    responseIntent: "advise",
    contextReadScope: "active-parent-read",
    artifactIntent: "revise-whiteboard",
    taskMutationPolicy: {
      kind: "create-parent",
      type: "general-system-design",
      topic: "Design a ride-sharing backend",
    },
    expectedParentId: "parent_after",
    expectedParentRevision: 1,
    responseOwner: {
      questionType: "general-system-design",
      source: "committed-parent",
    },
    modelRoute: {
      route: "main",
      reason: "settled-main",
      resolvedProviderId: "main-provider",
      provider: { provider: "main-provider", variables: {} },
    },
    playbookId: "general_system_design",
    playbookPhase: "requirement_clarification",
    memoryPolicy: {
      questionType: "general-system-design",
      useCase: "system_design_interview",
      askFrame: "hypothetical-design",
      topicDomain: "backend",
      retrievalPolicyId: "system-design",
    },
    factAnchorPolicy: {
      requirement: "not-required",
      policyId: "not-required",
    },
    promptContract: {
      profile: "system-design",
      contractId: "meeting-answer:system-design",
    },
    artifactPolicy: {
      disposition: "whiteboard-authorized",
      allowCode: false,
      allowComplexity: false,
      allowWhiteboard: true,
      reasons: ["system-design-owner"],
    },
    createdAt: 30,
  } as unknown as SettledAdvisorExecutionPlan;

  manager.recordCurrentQuestionSettlement({
    traceId: "trace_settlement",
    taskId: "parent_after",
    currentQuestion,
    settlement: settlementDecision,
    disposition: "committed-parent",
    durationMs: 1.25,
    llmWaitMs: 0,
    parentBeforeId: "parent_before",
    parentBeforeType: "coding",
    parentAfterId: "parent_after",
    parentAfterType: "general-system-design",
  });
  manager.recordSettledAdvisorExecutionPlan({
    traceId: "trace_settlement",
    taskId: "parent_after",
    plan,
    authorization: {
      authorized: true,
      reason: "authorized",
      rejectionReasons: [],
    },
  });
  manager.recordTrace(
    buildCompletedTrace("trace_settlement", Date.now(), {
      currentQuestionSettlementId: "settlement_a",
      currentQuestionSettlementUnitId: "question_settlement_unit",
      currentQuestionSettlementRevision: 3,
      currentQuestionSettlementSourceTurnIds: ["turn_a", "turn_b"],
      currentQuestionSettlementSourceObservationIds: ["screen_a"],
      currentQuestionSettlementSourceHash: "source_hash_a",
      currentQuestionSettlementType: "general-system-design",
      currentQuestionSettlementRelation: "new-parent",
      currentQuestionSettlementAction: "answer",
      currentQuestionSettlementEvidenceMode: "hypothetical-design",
      currentQuestionSettlementAuthority: "deterministic-fast-path",
      currentQuestionSettlementAuthoritySource: "accepted-transcript",
      currentQuestionSettlementTypeMutationAuthorized: true,
      currentQuestionSettlementRelationMutationAuthorized: true,
      currentQuestionSettlementParentMutationAuthorized: true,
      currentQuestionSettlementResponseAuthorized: true,
      currentQuestionSettlementDisposition: "committed-parent",
      currentQuestionSettlementParentBeforeId: "parent_before",
      currentQuestionSettlementParentBeforeType: "coding",
      currentQuestionSettlementParentAfterId: "parent_after",
      currentQuestionSettlementParentAfterType: "general-system-design",
      currentQuestionSettlementRejectedProposals: [],
      currentQuestionSettlementReasons: ["parent-mutation-authorized"],
      currentQuestionSettlementDurationMs: 1.25,
      currentQuestionSettlementLlmWaitMs: 0,
      currentQuestionSettlementLlmWaitDisposition: "not-awaited",
      settledExecutionPlanId: "plan_a",
      settledExecutionPlanSettlementId: "settlement_a",
      settledExecutionPlanQuestionType: "general-system-design",
      settledExecutionPlanRelation: "new-parent",
      settledExecutionPlanResponseAuthorized: true,
      settledExecutionPlanResponseIntent: "advise",
      settledExecutionPlanContextReadScope: "active-parent-read",
      settledExecutionPlanArtifactIntent: "revise-whiteboard",
      settledExecutionPlanTaskMutationCommand: "create-parent",
      settledExecutionPlanResponseOwnerSource: "committed-parent",
      settledExecutionPlanModelRoute: "main",
      settledExecutionPlanProviderId: "main-provider",
      settledExecutionPlanPlaybookId: "general_system_design",
      settledExecutionPlanPlaybookPhase: "requirement_clarification",
      settledExecutionPlanRequiredArtifacts: ["answer", "whiteboard"],
      settledExecutionPlanMemoryUseCase: "system_design_interview",
      settledExecutionPlanMemoryQuestionType: "general-system-design",
      settledExecutionPlanMemoryPolicyId: "system-design",
      settledExecutionPlanFactAnchorPolicy: "not-required",
      settledExecutionPlanPromptContract: "meeting-answer:system-design",
      settledExecutionPlanArtifactDisposition: "whiteboard-authorized",
      settledExecutionPlanTransientPersonalStatusDecisionId:
        "personal_status_a",
      settledExecutionPlanTransientPersonalStatusDomain: "relocation",
      settledExecutionPlanTransientPersonalStatusDisposition:
        "domain-resolved-unknown",
      settledExecutionPlanTransientPersonalStatusEvidencePolicy:
        "profile-only",
      settledExecutionPlanAuthorized: true,
      settledExecutionPlanAuthorizationReason: "authorized",
      settledExecutionPlanAuthorizationStage: "plan-created",
      settledExecutionPlanRejectionReasons: [],
      boundedRecentHistoryDecision: "authorized",
      boundedRecentHistoryReason: "authorized-deictic-followup",
      boundedRecentHistoryContextReadScope: "bounded-recent-history",
      boundedRecentHistoryParentTaskId: "parent_after",
      boundedRecentHistoryDeicticEvidence: [
        "named-deictic-reference",
      ],
      boundedRecentHistoryCandidateCount: 3,
      boundedRecentHistorySelectedCount: 2,
      boundedRecentHistorySelectedChars: 420,
      boundedRecentHistorySourceTraceCount: 2,
      boundedRecentHistoryExplicitEnhance: false,
      boundedRecentHistoryAuthority: "generated-continuity-only",
      boundedRecentHistoryFactAuthority: false,
      boundedRecentHistoryTaskMutationAuthority: false,
      boundedRecentHistoryArtifactMutationAuthority: false,
    }),
    "manual"
  );
  await settle();

  const settlementWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "traces/trace_settlement/current-question-settlement.json"
  );
  const planWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "traces/trace_settlement/settled-advisor-execution-plan.json"
  );
  const summaryWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "traces/trace_settlement/summary.json"
  );
  assert.ok(settlementWrite);
  assert.ok(planWrite);
  assert.ok(summaryWrite);
  const settlementPayload = parsePayload(settlementWrite);
  assert.equal(
    (
      settlementPayload.currentQuestion as Record<string, unknown>
    ).normalizedText,
    "Design a ride-sharing backend"
  );
  const serializedPlan = stringArg(planWrite, "payload");
  assert.equal(serializedPlan.includes("taskSnapshot"), false);
  assert.equal(serializedPlan.includes("variables"), false);
  const summary = parsePayload(summaryWrite);
  assert.equal(summary.version, 36);
  assert.equal(
    (
      summary.currentQuestionSettlement as Record<string, unknown>
    ).disposition,
    "committed-parent"
  );
  assert.equal(
    (summary.settledExecutionPlan as Record<string, unknown>).modelRoute,
    "main"
  );
  assert.deepEqual(
    (summary.settledExecutionPlan as Record<string, unknown>)
      .requiredArtifacts,
    ["answer", "whiteboard"]
  );
  assert.equal(
    (summary.settledExecutionPlan as Record<string, unknown>)
      .transientPersonalStatusDomain,
    "relocation"
  );
  assert.equal(
    (summary.settledExecutionPlan as Record<string, unknown>)
      .contextReadScope,
    "active-parent-read"
  );
  assert.equal(
    (summary.boundedRecentHistory as Record<string, unknown>)
      .contextReadScope,
    "bounded-recent-history"
  );
  assert.equal(
    (summary.boundedRecentHistory as Record<string, unknown>)
      .factAuthority,
    false
  );

  await manager.stop("test-complete");
});

test("records a current-question term correction without copying provider state", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  await manager.start(START_OPTIONS);
  await settle();

  const correction: ActiveQuestionTermCorrection = {
    correctionId: "term_correction_hnsw",
    rawText: "HNSW",
    normalizedTerm: "HNSW",
    replacedText: "H and SW",
    logicalQuestionUnitId: "logical_question_hnsw",
    logicalQuestionUnitRevision: 2,
    correctedLogicalQuestionUnitRevision: 3,
    sourceTurnIds: ["turn_hnsw"],
    manualCorrectionRevision: 4,
    disposition: "current-question-overlay",
    correctionTraceId: "trace_term_correction",
    regenerationTraceId: "trace_term_regeneration",
    settlementId: "settlement_term_correction",
    regenerationStatus: "succeeded",
    requestedAt: 100,
    completedAt: 350,
    correctionToAnswerLatencyMs: 250,
  };
  manager.recordActiveQuestionTermCorrection({
    correction,
    taskId: "task_hnsw",
  });
  manager.recordTrace(
    buildCompletedTrace("trace_term_correction", Date.now(), {
      manualTermCorrectionId: correction.correctionId,
      manualTermCorrectionDisposition: correction.disposition,
      manualTermCorrectionLogicalQuestionUnitId:
        correction.logicalQuestionUnitId,
      manualTermCorrectionLogicalQuestionUnitRevision:
        correction.logicalQuestionUnitRevision,
      manualTermCorrectionCorrectedLogicalQuestionUnitRevision:
        correction.correctedLogicalQuestionUnitRevision,
      manualTermCorrectionRevision:
        correction.manualCorrectionRevision,
      manualTermCorrectionRegenerationTraceId:
        correction.regenerationTraceId,
      manualTermCorrectionSettlementId: correction.settlementId,
      manualTermCorrectionRegenerationStatus:
        correction.regenerationStatus,
      manualTermCorrectionLatencyMs:
        correction.correctionToAnswerLatencyMs,
    }),
    "manual"
  );
  await settle();

  const correctionWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "tasks/task_hnsw/active-question-term-corrections.jsonl"
  );
  const summaryWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "traces/trace_term_correction/summary.json"
  );
  assert.ok(correctionWrite);
  assert.ok(summaryWrite);
  assert.equal(
    stringArg(correctionWrite, "payload").includes("H and SW"),
    true
  );
  assert.equal(
    stringArg(correctionWrite, "payload").includes("provider"),
    false
  );
  const summary = parsePayload(summaryWrite);
  assert.equal(summary.version, 36);
  assert.equal(
    summary.manualTermCorrectionId,
    "term_correction_hnsw"
  );
  assert.equal(
    summary.manualTermCorrectionDisposition,
    "current-question-overlay"
  );
  assert.equal(
    summary.manualTermCorrectionRegenerationStatus,
    "succeeded"
  );
  assert.equal(summary.manualTermCorrectionLatencyMs, 250);

  await manager.stop("test-complete");
});

test("records preparation provenance, use receipts, and answer-bound feedback", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  const recording = await manager.start(START_OPTIONS);
  const artifact = {
    artifactId: "artifact-1",
    lineageKey: "lineage-1",
    artifactPath: "runtime-brief/company",
    section: "runtime-brief" as const,
    contentHash: "artifact-hash",
    sourceRefs: [
      {
        kind: "process" as const,
        id: "process-1",
        contentHash: "process-hash",
      },
    ],
  };
  const context: PreparationRuntimeProvenanceSnapshot = {
    version: "meeting-preparation-provenance-v1",
    meetingSessionId: "meeting-1",
    preparationContextRevision: 2,
    selectionRevision: 7,
    mode: "prepared",
    loadState: "ready",
    capabilities: {
      runtimeReinforcement: {
        version: "meeting-preparation-10b-v1",
        available: true,
        enabled: false,
      },
      personalizedGuidance: {
        version: "meeting-preparation-10c-v1",
        available: true,
        enabled: false,
        requiresRuntimeReinforcement: true,
      },
    },
    pinnedSnapshot: {
      snapshotId: "snapshot-1",
      processId: "process-1",
      roundId: "round-1",
      version: 3,
      contentHash: "snapshot-hash",
      compilerVersion: "compiler-1",
      playbookRegistryVersion: "playbook-1",
      runtimeCapabilityVersion: "runtime-1",
      selectionRevision: 7,
      selectedAt: 50,
      artifactManifest: {
        version: "preparation-artifact-manifest-v1",
        artifacts: [artifact],
      },
    },
    projectionCatalog: [
      {
        projectionId: "snapshot-1:runtime-brief",
        group: "runtime-reinforcement",
        consumer: "runtime-brief",
        snapshotId: "snapshot-1",
        preparationContextRevision: 2,
        artifactIds: [artifact.artifactId],
        artifactLineageKeys: [artifact.lineageKey],
        artifactPaths: [artifact.artifactPath],
      },
    ],
    capturedAt: 100,
  };
  const receipt: PreparationArtifactUseReceipt = {
    version: "meeting-preparation-provenance-v1",
    receiptId: "receipt-1",
    meetingSessionId: "meeting-1",
    preparationContextRevision: 2,
    selectionRevision: 7,
    snapshotId: "snapshot-1",
    snapshotVersion: 3,
    snapshotContentHash: "snapshot-hash",
    projectionId: "snapshot-1:runtime-brief",
    artifactId: artifact.artifactId,
    lineageKey: artifact.lineageKey,
    artifactPath: artifact.artifactPath,
    section: artifact.section,
    artifactContentHash: artifact.contentHash,
    sourceRefs: artifact.sourceRefs,
    consumer: "runtime-brief",
    targetKind: "advisor-prompt",
    targetId: "prompt-1",
    traceId: "trace-preparation-1",
    questionId: "question-1",
    answerRevision: 4,
    generationLeaseId: "lease-1",
    createdAt: 120,
  };
  const evaluation: PreparationArtifactEvaluation = {
    version: "meeting-preparation-provenance-v1",
    evaluationId: "evaluation-1",
    receiptId: receipt.receiptId,
    meetingSessionId: receipt.meetingSessionId,
    traceId: receipt.traceId,
    questionId: receipt.questionId,
    answerRevision: receipt.answerRevision,
    snapshotId: receipt.snapshotId,
    artifactId: receipt.artifactId,
    lineageKey: receipt.lineageKey,
    consumer: receipt.consumer,
    label: "helpful",
    createdAt: 130,
    updatedAt: 130,
  };

  manager.recordPreparationRuntimeContext(context);
  manager.recordPreparationArtifactUse([receipt]);
  assert.throws(
    () =>
      manager.recordPreparationArtifactEvaluation({
        ...evaluation,
        artifactId: "artifact-not-used",
      }),
    /matching recorded use receipt/u
  );
  manager.recordPreparationArtifactEvaluation(evaluation);
  manager.recordTrace(
    buildCompletedTrace(receipt.traceId, Date.now(), {
      preparationContextRevision: receipt.preparationContextRevision,
      preparationArtifactUseReceiptIds: [receipt.receiptId],
      preparationArtifactIds: [receipt.artifactId],
      preparationArtifactConsumers: [receipt.consumer],
    }),
    "manual"
  );
  await settle();
  await manager.stop("test-complete");

  const paths = native.calls
    .filter((call) => call.command === "write_meeting_session_recording_text")
    .map((call) => stringArg(call, "relativePath"));
  assert.ok(paths.includes("preparation/runtime-context.latest.json"));
  assert.ok(
    paths.includes("preparation/snapshot-manifests/snapshot-1-v3.json")
  );
  assert.ok(paths.includes("preparation/artifact-use-receipts.jsonl"));
  assert.ok(paths.includes("preparation/answer-attribution-index.json"));
  assert.ok(
    paths.includes("human-evaluation/preparation-artifact-evaluations.json")
  );
  const summaryWrite = native.calls.find(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        `traces/${receipt.traceId}/summary.json`
  );
  assert.ok(summaryWrite);
  const summary = parsePayload(summaryWrite);
  assert.equal(summary.version, 36);
  assert.equal(
    summary.preparationContextRevision,
    receipt.preparationContextRevision
  );
  assert.deepEqual(summary.preparationArtifactUseReceiptIds, [
    receipt.receiptId,
  ]);
  assert.deepEqual(summary.preparationArtifactIds, [receipt.artifactId]);
  assert.deepEqual(summary.preparationArtifactConsumers, [receipt.consumer]);
  const finalManifest = native.stoppedManifest(
    required(recording.folderName)
  );
  assert.ok(finalManifest);
  const integrity = finalManifest.preparationRuntimeIntegrity;
  assert.equal(integrity.contextSnapshotCount, 1);
  assert.equal(integrity.artifactUseReceiptCount, 1);
  assert.equal(integrity.artifactEvaluationCount, 1);
  assert.equal(integrity.answerAttributionCount, 1);
  assert.equal(integrity.untraceableArtifactUseCount, 0);
});

test("rejects an artifact receipt that has no recorded snapshot lineage", async () => {
  const native = new ControlledRecordingInvoke();
  const manager = new SessionRecordingManager(undefined, native.invoke);
  const recording = await manager.start(START_OPTIONS);
  const receipt: PreparationArtifactUseReceipt = {
    version: "meeting-preparation-provenance-v1",
    receiptId: "receipt-untraceable",
    meetingSessionId: "meeting-missing",
    preparationContextRevision: 9,
    selectionRevision: 9,
    snapshotId: "snapshot-missing",
    snapshotVersion: 1,
    snapshotContentHash: "snapshot-hash",
    projectionId: "projection-missing",
    artifactId: "artifact-missing",
    lineageKey: "lineage-missing",
    artifactPath: "runtime-brief/missing",
    section: "runtime-brief",
    artifactContentHash: "artifact-hash",
    sourceRefs: [],
    consumer: "runtime-brief",
    targetKind: "advisor-prompt",
    targetId: "prompt-missing",
    traceId: "trace-missing",
    answerRevision: null,
    createdAt: 100,
  };

  assert.throws(
    () => manager.recordPreparationArtifactUse([receipt]),
    /not authorized by the recorded snapshot manifest/u
  );
  await manager.stop("test-complete");

  const finalManifest = native.stoppedManifest(
    required(recording.folderName)
  );
  assert.equal(
    finalManifest?.preparationRuntimeIntegrity
      .untraceableArtifactUseCount,
    1
  );
  const receiptWrites = native.calls.filter(
    (call) =>
      call.command === "write_meeting_session_recording_text" &&
      stringArg(call, "relativePath") ===
        "preparation/artifact-use-receipts.jsonl"
  );
  assert.equal(receiptWrites.length, 0);
});

const START_OPTIONS = {
  settings: {
    codingModel: {
      enabled: false,
      provider: "",
      variables: {},
    },
    taxonomyAdjudication: {
      enabled: true,
      provider: "",
      variables: {},
    },
  } as unknown as MeetingAssistantSettings,
  providerSummary: {
    hasMainProvider: false,
    hasCodingProvider: false,
    hasTaxonomyAdjudicationProvider: false,
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
  private failures: Array<{
    predicate: (call: InvokeCall) => boolean;
    error: Error;
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
    const failureIndex = this.failures.findIndex(({ predicate }) =>
      predicate(call)
    );
    if (failureIndex >= 0) {
      const [failure] = this.failures.splice(failureIndex, 1);
      throw failure?.error ?? new Error("Simulated recording write failure");
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

  failNext(predicate: (call: InvokeCall) => boolean, error: Error) {
    this.failures.push({ predicate, error });
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
            pendingWritesAtSeal: number;
            queueDrained: boolean;
            enqueueCounterConsistent: boolean;
          },
          recordingIntegrity: payload.recordingIntegrity as {
            status: "complete" | "incomplete";
            failedWriteCount: number;
            failedWriteDetailsTruncated: boolean;
            failedWrites: Array<{
              relativePath?: string;
              message: string;
            }>;
          },
          evaluationIntegrity: payload.evaluationIntegrity as {
            compatibilityReportPath: string;
            v2ProjectionMaterialization?: Record<string, number>;
          },
          preparationRuntimeIntegrity:
            payload.preparationRuntimeIntegrity as Record<string, unknown>,
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
