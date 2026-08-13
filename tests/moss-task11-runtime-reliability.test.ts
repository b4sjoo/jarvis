import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  NATIVE_CALL_AUDIO_EVENTS,
  authorizeNativeOwnedAudioEvent,
} from "../src/lib/calling/index.js";

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

test("Task 11 native diagnostics share one lease-qualified event contract", () => {
  assert.deepEqual(Object.values(NATIVE_CALL_AUDIO_EVENTS), [
    "speech-detected",
    "speech-start",
    "native-audio-liveness",
    "native-audio-segment-dropped",
    "native-audio-lifecycle",
  ]);
  const payload = {
    captureSessionId: "capture-current",
    captureGeneration: 4,
    owner: "call" as const,
    occurredAtMs: 10,
  };
  assert.equal(
    authorizeNativeOwnedAudioEvent({
      payload,
      activeCaptureSessionId: "capture-current",
      activeCaptureGeneration: 4,
      expectedOwner: "call",
    }).authorized,
    true
  );
  const stale = authorizeNativeOwnedAudioEvent({
    payload,
    activeCaptureSessionId: "capture-current",
    activeCaptureGeneration: 5,
    expectedOwner: "call",
  });
  assert.deepEqual(stale, {
    authorized: false,
    reason: "capture-generation-mismatch",
    event: payload,
  });
});

test("Task 11 production orchestration consumes every native event and records queue pressure", () => {
  const hook = source("src/hooks/useCallingAssistant.ts");
  for (const key of Object.keys(NATIVE_CALL_AUDIO_EVENTS)) {
    assert.match(hook, new RegExp(`NATIVE_CALL_AUDIO_EVENTS\\.${key}`));
  }
  assert.match(hook, /audio-queue-observation/);
  assert.match(hook, /audio-queue-drain-timeout/);
  assert.match(hook, /rollover-transcript-family/);
  assert.doesNotMatch(hook, /"capture-lifecycle"/);
});

test("Task 11 native shell gates window and application exit on frontend drain", () => {
  const nativeShell = source("src-tauri/src/lib.rs");
  const app = source("src/pages/app/index.tsx");
  assert.match(nativeShell, /graceful-exit-requested/);
  assert.match(nativeShell, /api\.prevent_close\(\)/);
  assert.match(nativeShell, /api\.prevent_exit\(\)/);
  assert.match(app, /activeController\.prepareForExit\(\)/);
  assert.match(app, /cancel_exit_app/);
});

test("Task 11 model return evidence records owner authorization", () => {
  const operations = source("src/lib/calling/model-operations.ts");
  assert.match(operations, /ownerAuthorized: input\.ownerAuthorized/);
  assert.match(operations, /const ownerAuthorized = input\.isCurrentOwner\(\)/);
});

test("Task 11 sessions expose incomplete evidence instead of presenting a healthy close", () => {
  const sessions = source("src/pages/sessions/index.tsx");
  assert.match(sessions, /recording\.status\.health !== "healthy"/);
  assert.match(sessions, /Evidence incomplete:/);
  assert.match(sessions, /status\.persistedEventCount/);
  assert.match(sessions, /status\.attemptedEventCount/);
  assert.match(sessions, /status\.droppedEventCount/);
});

test("Task 11 records UI projection detach instead of hiding a remount gap", () => {
  const hook = source("src/hooks/useCallingAssistant.ts");
  const runtime = source("src/lib/calling/active-call-runtime.ts");
  const recording = source("src-tauri/src/recording.rs");
  assert.match(runtime, /bindTransitionObserver/);
  assert.match(hook, /runtime-projection-lifecycle/);
  assert.match(hook, /runtime-projection-detached/);
  assert.match(hook, /persistIncomplete/);
  assert.match(recording, /mark_call_recording_incomplete/);
});
