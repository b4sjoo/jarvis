import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

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
    "  const microphoneVadEnabled ="
  );

  assert.match(scheduleAdvisor, /if \(!runtimeActiveRef\.current\) return;/);
  assert.doesNotMatch(scheduleAdvisor, /if \(!activeRef\.current\) return;/);
  assert.match(
    enqueueMicrophone,
    /if \(!activeRef\.current \|\| !microphoneContextEnabledRef\.current\) return;/
  );
  assert.doesNotMatch(enqueueMicrophone, /runtimeActiveRef/);
});

test("actual Hook VAD options use capture liveness and the existing audio-session identity", () => {
  const parsed = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = new Map<string, ts.VariableDeclaration>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ["microphoneVadEnabled", "microphoneVad"].includes(node.name.getText(parsed))) {
      assert.equal(declarations.has(node.name.getText(parsed)), false);
      declarations.set(node.name.getText(parsed), node);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  const enabled = declarations.get("microphoneVadEnabled")?.initializer;
  const vad = declarations.get("microphoneVad")?.initializer;
  assert.ok(enabled);
  assert.ok(vad && ts.isCallExpression(vad));
  assert.equal(vad.expression.getText(parsed), "useBrowserMicrophoneVad");
  const script = new vm.Script(ts.transpileModule(
    `const microphoneVadEnabled = (${enabled.getText(parsed)}); globalThis.options = (${vad.arguments[0].getText(parsed)});`,
    { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }
  ).outputText);
  const events: Record<string, unknown>[] = [];
  const audioSessionIdRef = { current: "audio-session-A" };
  const environment = vm.createContext({
    shutdownRequestedRef: { current: false }, activeRef: { current: true }, runtimeActiveRef: { current: false },
    selectedAudioDevices: { input: { id: "selected-mic" } }, audioSessionIdRef,
    state: { settings: { microphoneContextEnabled: true }, status: "listening" },
    sessionRecordingManagerRef: { current: { recordCaptureLifecycle: (event: Record<string, unknown>) => events.push(event) } },
    captureLifecycleCoordinatorRef: { current: { getTraceMetadata: () => ({ captureGeneration: 9 }) } },
  });
  const evaluate = () => {
    // Each invocation represents the next actual Hook render, not a second owner.
    const next = vm.createContext({ ...environment });
    script.runInContext(next);
    return next.options;
  };
  for (const status of ["listening", "transcribing", "thinking", "paused", "idle", "starting", "error"]) {
    environment.state.status = status;
    const options = evaluate();
    assert.equal(options.enabled, ["listening", "transcribing", "thinking"].includes(status), status);
    assert.equal(options.deviceId, "selected-mic");
    assert.equal(options.sessionKey, audioSessionIdRef.current);
    assert.equal(options.userSpeakingThreshold, 0.6);
  }
  environment.state.status = "listening";
  for (const field of [environment.shutdownRequestedRef, environment.activeRef, environment.state.settings]) {
    const original = { ...field };
    if (field === environment.state.settings) field.microphoneContextEnabled = false;
    else field.current = field === environment.shutdownRequestedRef;
    assert.equal(evaluate().enabled, false);
    Object.assign(field, original);
  }
  audioSessionIdRef.current = "audio-session-B";
  const options = evaluate();
  assert.equal(options.enabled, true);
  assert.equal(options.sessionKey, "audio-session-B");
  options.onObservation({ stage: "ready", elapsedMs: 12, framesProcessed: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [{
    stage: "browser-microphone-vad", vadStage: "ready", source: "microphone", speaker: "me",
    elapsedMs: 12, framesProcessed: 0, captureGeneration: 9,
  }]);
  assert.doesNotMatch(source, /useMicVAD|microphoneVad\.(?:start|pause)\(/);
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
