import assert from "node:assert/strict";
import test from "node:test";
import {
  SttEvaluationCaptureManager,
  type SttEvaluationCaptureInvoke,
} from "../src/lib/meeting/stt-evaluation-capture.js";

interface InvokeCall {
  command: string;
  args: Record<string, unknown>;
}

test("captures system submitted audio and transcript stages in one session", async () => {
  const native = new SttEvaluationInvoke();
  const manager = new SttEvaluationCaptureManager(undefined, native.invoke);

  const started = await manager.start();
  assert.equal(started.active, true);
  assert.equal(started.sessionId, "stt_eval_test");

  assert.equal(
    manager.recordSubmittedAudio({
      evaluationSessionId: "stt_eval_test",
      utteranceId: "utterance_session_1",
      traceId: "trace_1",
      audioSessionId: "audio_session",
      audioSegmentSequence: 1,
      queuedAt: 10,
      submittedAt: 20,
      mediaType: "audio/wav",
      audioBytes: 4,
      base64Payload: "UklGRg==",
      source: "system-audio",
    }),
    true
  );
  manager.recordProviderTranscript({
    evaluationSessionId: "stt_eval_test",
    utteranceId: "utterance_session_1",
    traceId: "trace_1",
    audioSessionId: "audio_session",
    audioSegmentSequence: 1,
    providerId: "whisper",
    attemptId: "stt_attempt_1",
    attemptNumber: 1,
    promptMode: "configured",
    promptKind: "speech-bias",
    rawText: "raw transcript",
    validation: {
      disposition: "accepted",
      reason: "valid",
      promptSimilarity: 0,
      normalizedTranscriptChars: 14,
      normalizedPromptChars: 0,
      audioDurationMs: 500,
      transcriptCharsPerSecond: 28,
      densitySuspicious: false,
    },
    turnId: "turn_1",
    receivedAt: 30,
  });
  manager.recordCanonicalTranscript({
    evaluationSessionId: "stt_eval_test",
    utteranceId: "utterance_session_1",
    traceId: "trace_1",
    audioSessionId: "audio_session",
    audioSegmentSequence: 1,
    rawText: "raw transcript",
    canonicalText: "RAG transcript",
    normalizationApplied: true,
    recordedAt: 40,
    turn: {
      id: "turn_1",
      speaker: "them",
      text: "RAG transcript",
      startedAt: 10,
      endedAt: 30,
      isFinal: true,
      source: "system-audio",
    },
  });
  await manager.drain();

  assert.equal(
    native.calls.filter(
      (call) => call.command === "record_stt_evaluation_submitted_audio"
    ).length,
    1
  );
  assert.deepEqual(
    native.calls
      .filter(
        (call) =>
          call.command === "record_stt_evaluation_transcript_event"
      )
      .map((call) => call.args.stream),
    ["provider", "canonical"]
  );
  const providerCall = native.calls.find(
    (call) =>
      call.command === "record_stt_evaluation_transcript_event" &&
      call.args.stream === "provider"
  );
  assert.ok(providerCall);
  const providerPayload = JSON.parse(
    providerCall.args.payload as string
  ) as Record<string, unknown>;
  assert.equal(providerPayload.attemptId, "stt_attempt_1");
  assert.equal(providerPayload.attemptNumber, 1);
  assert.equal(providerPayload.promptMode, "configured");

  const stopped = await manager.stop("test-complete");
  assert.equal(stopped.active, false);
  assert.equal(stopped.lifecycle, "stopped");
});

test("never records microphone audio in the system-audio evaluation lane", async () => {
  const native = new SttEvaluationInvoke();
  const manager = new SttEvaluationCaptureManager(undefined, native.invoke);
  await manager.start();

  const accepted = manager.recordSubmittedAudio({
    utteranceId: "microphone_1",
    traceId: "trace_microphone",
    audioSessionId: "audio_session",
    audioSegmentSequence: 2,
    queuedAt: 10,
    submittedAt: 20,
    mediaType: "audio/wav",
    audioBytes: 4,
    base64Payload: "UklGRg==",
    source: "microphone",
  });
  await manager.drain();

  assert.equal(accepted, false);
  assert.equal(
    native.calls.some(
      (call) => call.command === "record_stt_evaluation_submitted_audio"
    ),
    false
  );
});

test("keeps a stopped capture available until explicit deletion", async () => {
  const native = new SttEvaluationInvoke();
  const manager = new SttEvaluationCaptureManager(undefined, native.invoke);
  await manager.start();
  await manager.stop("test-complete");

  assert.equal(manager.getState().sessionId, "stt_eval_test");
  assert.equal(manager.getState().lifecycle, "stopped");

  const deleted = await manager.deleteCurrent();
  assert.equal(deleted.sessionId, undefined);
  assert.equal(deleted.lifecycle, "idle");
});

test("drops transcript evidence owned by a different evaluation session", async () => {
  const native = new SttEvaluationInvoke();
  const manager = new SttEvaluationCaptureManager(undefined, native.invoke);
  await manager.start();

  const accepted = manager.recordProviderTranscript({
    evaluationSessionId: "stt_eval_stale",
    utteranceId: "utterance_stale",
    traceId: "trace_stale",
    audioSessionId: "audio_session",
    audioSegmentSequence: 3,
    rawText: "late provider result",
    validation: {
      disposition: "accepted",
      reason: "valid",
      promptSimilarity: 0,
      normalizedTranscriptChars: 20,
      normalizedPromptChars: 0,
      audioDurationMs: 500,
      transcriptCharsPerSecond: 40,
      densitySuspicious: false,
    },
    receivedAt: 50,
  });
  await manager.drain();

  assert.equal(accepted, false);
  assert.equal(
    native.calls.some(
      (call) => call.command === "record_stt_evaluation_transcript_event"
    ),
    false
  );
});

class SttEvaluationInvoke {
  calls: InvokeCall[] = [];
  private active = false;
  private deleted = false;

  invoke: SttEvaluationCaptureInvoke = async <T>(
    command: string,
    args: Record<string, unknown> = {}
  ) => {
    this.calls.push({ command, args });
    if (command === "start_stt_evaluation_capture") {
      this.active = true;
      this.deleted = false;
    } else if (command === "stop_stt_evaluation_capture") {
      this.active = false;
    } else if (command === "delete_stt_evaluation_capture") {
      this.deleted = true;
    }
    return this.status() as T;
  };

  private status() {
    if (this.deleted) {
      return {
        active: false,
        lifecycle: "idle",
        rawChunkCount: 0,
        submittedAudioCount: 0,
        providerEventCount: 0,
        canonicalEventCount: 0,
        humanReferenceCount: 0,
        bytesWritten: 0,
        droppedRawChunkCount: 0,
      };
    }
    return {
      active: this.active,
      lifecycle: this.active ? "active" : "stopped",
      sessionId: "stt_eval_test",
      folderName: "stt-eval-test",
      folderPath: "/tmp/stt-eval-test",
      startedAt: 1,
      expiresAt: 2,
      rawChunkCount: 0,
      submittedAudioCount: 0,
      providerEventCount: 0,
      canonicalEventCount: 0,
      humanReferenceCount: 0,
      bytesWritten: 0,
      droppedRawChunkCount: 0,
    };
  }
}
