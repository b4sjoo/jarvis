import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

test("Task 12 keeps call audio user-controlled, visible, and disabled by default", () => {
  const hook = source("src/hooks/useCallingAssistant.ts");
  const callPage = source("src/pages/calling/index.tsx");

  assert.match(hook, /audioRecordingDesiredRef = useRef\(false\)/);
  assert.match(hook, /startAudioRecording/);
  assert.match(hook, /stopAudioRecording/);
  assert.match(callPage, /Record both sides of this call\?/);
  assert.match(callPage, /72 hours after the call closes/);
  assert.match(callPage, /audio-recording-status-live/);
});

test("Task 12 exposes retention, playback, and explicit audio export boundaries", () => {
  const sessions = source("src/pages/sessions/index.tsx");
  const recording = source("src/lib/calling/call-recording.ts");
  const privacy = source("src/lib/preparation/privacy-service.ts");
  const casePanel = source("src/pages/cases/EvaluationPanel.tsx");

  assert.match(sessions, /preserveCallAudioRecording/);
  assert.match(sessions, /restoreTemporaryCallAudioRetention/);
  assert.match(sessions, /deleteCallAudioRecording/);
  assert.match(sessions, /<audio controls preload="metadata"/);
  assert.match(sessions, /exportCallRecording\(status\.callSessionId, false\)/);
  assert.match(sessions, /exportCallRecording\(status\.callSessionId, true\)/);
  assert.match(recording, /includeAudio = false/);
  assert.match(privacy, /exportCase\(caseId: string, includeAudio = false\)/);
  assert.match(privacy, /rawAudioIncluded: includeAudio/);
  assert.match(casePanel, /Export with audio/);
});
