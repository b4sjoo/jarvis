import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  `${process.cwd()}/src/hooks/useMeetingAssistant.ts`,
  "utf8"
);

test("separates advisor runtime liveness from native capture liveness", () => {
  const scheduleAdvisor = sourceSlice(
    "  const scheduleAdvisor = useCallback(",
    "  const publishResponseRecoveryTarget = useCallback"
  );
  const enqueueMicrophone = sourceSlice(
    "  const enqueueMicrophoneSpeech = useCallback(",
    "  const microphoneAudioConstraints = useMemo"
  );

  assert.match(scheduleAdvisor, /if \(!runtimeActiveRef\.current\) return;/);
  assert.doesNotMatch(scheduleAdvisor, /if \(!activeRef\.current\) return;/);
  assert.match(
    enqueueMicrophone,
    /if \(!activeRef\.current \|\| !microphoneContextEnabledRef\.current\) return;/
  );
  assert.doesNotMatch(enqueueMicrophone, /runtimeActiveRef/);
});

test("organic capture transitions update both liveness facts", () => {
  const startCapture = sourceSlice(
    "  const startCapture = useCallback(",
    "  const start = useCallback"
  );
  const pause = sourceSlice(
    "  const pause = useCallback(",
    "  const captureScreenContext = useCallback"
  );

  assert.match(
    startCapture,
    /activeRef\.current = true;\s+runtimeActiveRef\.current = true;/
  );
  assert.match(
    startCapture,
    /activeRef\.current = false;\s+runtimeActiveRef\.current = false;/
  );
  assert.match(
    pause,
    /activeRef\.current = false;\s+runtimeActiveRef\.current = false;/
  );
  assert.match(source, /isActive: activeRef\.current,/);
  assert.match(source, /isRuntimeActive: runtimeActiveRef\.current,/);
});

test("canonical response authority is not revoked by an ambient Me turn", () => {
  const runAdvisor = sourceSlice(
    "  const runAdvisor = useCallback(",
    "  const scheduleAdvisor = useCallback("
  );

  assert.match(
    runAdvisor,
    /!advisorJob\.logicalQuestionUnit\s*&&\s*!advisorEngineRef\.current\.shouldRequestSuggestion\(latestTurn\)/
  );
  assert.match(runAdvisor, /isAnswerDeliveryLockActive\(/);
  assert.match(runAdvisor, /compileSettledAdvisorPromptContext\(/);
});

function sourceSlice(startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
