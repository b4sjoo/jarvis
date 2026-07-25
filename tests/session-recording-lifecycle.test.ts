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
      logicalQuestionLeaseAuthorized: true,
      logicalQuestionLeaseAuthorizationReason: "logical-question-current",
      logicalQuestionLeaseAuthorizationStage: "final-commit",
      forceAdviseTargetStatus: "already-advised",
      forceAdviseEligible: false,
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
  assert.equal(summary.version, 25);
  assert.equal(summary.taskRelation, "new-parent");
  assert.equal(summary.logicalQuestionUnitRevision, 3);
  assert.deepEqual(summary.logicalQuestionSourceTurnIds, ["turn_1", "turn_2"]);
  assert.deepEqual(summary.logicalQuestionCompositionReasons, [
    "new-question",
    "referential-completion",
  ]);
  assert.equal(summary.advisorPromptIncludedLogicalQuestion, true);
  assert.equal(summary.advisorOutputCommittedToUi, true);
  assert.equal(summary.visibleAnswerChanged, true);
  assert.equal(summary.logicalQuestionLeaseAuthorized, true);
  assert.equal(summary.primaryAskSpeechAct, "question");
  assert.equal(summary.primaryAskDisposition, "answer-primary-ask");
  assert.equal(summary.primaryAskNormalizedText, undefined);
  assert.deepEqual(summary.primaryAskSourceTurnIds, ["turn_1", "turn_2"]);
  assert.equal(summary.primaryAskQuotedOrFutureSpanCount, 1);
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
  assert.equal(summary.version, 25);
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
  assert.equal(summary.version, 25);
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
  assert.equal(summary.version, 25);
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
      settledExecutionPlanResponseOwnerSource: "committed-parent",
      settledExecutionPlanModelRoute: "main",
      settledExecutionPlanProviderId: "main-provider",
      settledExecutionPlanPlaybookId: "general_system_design",
      settledExecutionPlanPlaybookPhase: "requirement_clarification",
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
  assert.equal(summary.version, 25);
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
  assert.equal(
    (summary.settledExecutionPlan as Record<string, unknown>)
      .transientPersonalStatusDomain,
    "relocation"
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
  assert.equal(summary.version, 25);
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
