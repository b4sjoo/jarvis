import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hookSource = readFileSync(
  `${process.cwd()}/src/hooks/useMeetingAssistant.ts`,
  "utf8"
);
const uiSource = readFileSync(
  `${process.cwd()}/src/pages/app/components/meeting/index.tsx`,
  "utf8"
);

test("starts manual replay with a forced recording and no native capture", () => {
  const start = sourceSlice(
    hookSource,
    "  const startRuntimeRegressionRun = useCallback(",
    "  const stopRuntimeRegressionRun = useCallback"
  );

  assert.match(start, /scriptedValidationLock/);
  assert.match(start, /source: "scenario-runner"/);
  assert.match(start, /runtimeActiveRef\.current = true/);
  assert.doesNotMatch(start, /activeRef\.current = true/);
  assert.match(start, /recordRuntimeRegressionRun/);
});

test("routes manual text through canonical ingress and waits for terminal", () => {
  const submit = sourceSlice(
    hookSource,
    "  const submitRuntimeRegressionText = useCallback(",
    "  const enqueueSpeechDetected = useCallback"
  );

  assert.match(submit, /startTrace\("voice"/);
  assert.match(submit, /syntheticValidation: true/);
  assert.match(submit, /processCanonicalTurnIngress\(\{/);
  assert.match(submit, /transport: "manual-text"/);
  assert.match(submit, /waitForRuntimeRegressionTraceTerminal/);
  assert.match(submit, /recordRuntimeRegressionStep/);
  assert.doesNotMatch(submit, /submitTaskRuntimeTransition/);
  assert.doesNotMatch(submit, /settleCurrentQuestion\(/);
});

test("delegates every ordinary stop to the active Replay Lab finalizer", () => {
  const stop = sourceSlice(
    hookSource,
    "  const stop = useCallback(async () => {",
    "  const buildAdvisorJob = useCallback"
  );
  assert.match(stop, /runtimeRegressionRunRef\.current/);
  assert.match(stop, /stopRuntimeRegressionRunRef\.current/);
  assert.match(
    hookSource,
    /stopRuntimeRegressionRunRef\.current = stopRuntimeRegressionRun/
  );
});

test("keeps Replay Lab behind development and Debug gates", () => {
  assert.match(
    uiSource,
    /import\.meta\.env\.DEV && debugMode \? \(/
  );
  assert.match(uiSource, /Replay Lab/);
  assert.match(uiSource, /Start Fresh Run/);
  assert.match(uiSource, /onSubmitRuntimeRegressionText/);
  assert.match(uiSource, /sessionRecording\.scriptedValidationForced/);
});

function sourceSlice(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
