import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();
const require = createRequire(path.join(root, "package.json"));
const ts = require("typescript");
const esbuild = require("esbuild");
const source = readFileSync(path.join(root, "src/hooks/useMeetingAssistant.ts"), "utf8");
const file = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);

function find(node, predicate) {
  if (predicate(node)) return node;
  return ts.forEachChild(node, (child) => find(child, predicate));
}

function callback(name) {
  const declaration = find(file, (node) =>
    ts.isVariableDeclaration(node) && node.name.getText(file) === name
  );
  assert.ok(declaration, `missing production callback ${name}`);
  return declaration.initializer.arguments[0].getText(file);
}

const callbackNames = [
  "publishResponseRecoveryTarget",
  "publishCanonicalLogicalQuestionTarget",
  "scheduleResponseOpportunityInference",
  "scheduleAdvisorAfterQuestionTypeWindow",
  "appendTranscriptTurnForTrace",
  "buildLogicalQuestionForTurn",
  "readAudioSegmentCommitAuthorization",
  "isCurrentAudioSegment",
  "isCurrentTurnSource",
  "clearPendingSentenceCompletionForRuntimeReset",
  "clearPendingConfirmation",
  "flushPendingSentenceCompletion",
  "holdPendingSentenceCompletion",
  "consumePendingSentenceCompletion",
  "activateSentenceContinuationFromSpeechStart",
  "processPostBufferThemTurn",
  "holdPendingConfirmation",
  "resolvePendingConfirmationForMeTurn",
  "processCanonicalTurnIngress",
  "submitRuntimeRegressionText",
  "waitForRuntimeRegressionTraceTerminal",
];
const callbackSources = callbackNames.map(callback);
const helperSource = find(file, (node) =>
  ts.isFunctionDeclaration(node) && node.name?.text === "toObservedAdvisorAction"
).getText(file) + "\n" + find(file, (node) =>
  ts.isFunctionDeclaration(node) && node.name?.text === "evaluateThemTurnForAdvisor"
).getText(file);
const outputCallback = find(file, (node) =>
  ts.isPropertyAssignment(node) && node.name.getText(file) === "onOutputAuthorized"
);
assert.ok(outputCallback, "missing production RO-to-ordered-handoff callback");
const outputSource = outputCallback.initializer.getText(file);
const identifiers = new Set();
const collect = (node) => {
  if (ts.isIdentifier(node)) identifiers.add(node.text);
  ts.forEachChild(node, collect);
};
for (const text of [...callbackSources, outputSource, helperSource]) {
  collect(ts.createSourceFile("callback.ts", text, ts.ScriptTarget.Latest, true));
}

// Bundle only real production imports in memory, independent of shared .tmp-tests.
const exports = [];
for (const node of file.statements) {
  if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) continue;
  const moduleName = node.moduleSpecifier.text;
  if (!moduleName.startsWith("@/")) continue;
  const names = node.importClause?.namedBindings?.elements?.filter(
    (binding) => !binding.isTypeOnly && identifiers.has(binding.name.text)
  ).map((binding) => binding.getText(file)) ?? [];
  if (names.length) exports.push(`export { ${names.join(", ")} } from ${JSON.stringify(moduleName)};`);
}
for (const name of [
  "runtime-inference-runtime", "response-opportunity-generation-gate",
  "short-intent-gate", "logical-question-unit", "runtime-inference-health",
  "settled-advisor-execution-plan", "advisor-trigger-job", "stable-answer", "meeting-answer",
  "audio-drain-authorization",
]) {
  exports.push(`export * from "@/lib/meeting/${name}";`);
}
const bundle = await esbuild.build({
  stdin: { contents: exports.join("\n"), loader: "ts", resolveDir: root },
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  logLevel: "silent",
  alias: { "@": path.join(root, "src") },
});
const transpile = (text) => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

class Clock {
  now = 10_000;
  sequence = 0;
  timers = new Map();
  setTimeout = (callback, delay = 0) => {
    const id = ++this.sequence;
    this.timers.set(id, { callback, at: this.now + delay });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  async flush() {
    for (let index = 0; index < 40; index += 1) await Promise.resolve();
  }
  async advance(ms) {
    const end = this.now + ms;
    await this.flush();
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.now = next[1].at;
      next[1].callback();
      await this.flush();
    }
    this.now = end;
    await this.flush();
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function createHarness() {
  const clock = new Clock();
  class TestDate extends Date { static now() { return clock.now; } }
  const module = { exports: {} };
  const environment = {
    module, exports: module.exports, require, console, AbortController, structuredClone,
    Date: TestDate, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    window: clock,
  };
  const context = vm.createContext(environment);
  vm.runInContext(bundle.outputFiles[0].text, context);
  const pure = module.exports;
  Object.assign(environment, pure);
  const state = { sessionId: "session-a", transcriptTurns: [], taskRuntime: {} };
  let ui = { latestInterviewerTurnCandidate: null, latestSuggestion: "stable answer" };
  let stateWrites = 0;
  const metadata = new Map();
  const finished = [];
  const advisorCalls = [];
  const providerCalls = [];
  const settlements = [];
  const scheduled = [];
  const traces = new Map();
  const replaySteps = [];
  const runtime = new pure.RuntimeInferenceOperationRuntime("response-opportunity-inference");
  const schedule = runtime.schedule.bind(runtime);
  runtime.schedule = (input, delay) => {
    scheduled.push(input);
    schedule({ ...input, onSettled: (settlement) => {
      settlements.push({ settlement, currentOperationId: runtime.getCurrentOperationId() });
      input.onSettled(settlement);
    } }, delay);
  };
  Object.assign(environment, {
    VOICE_ORDERED_RELATION_FOREGROUND_BUDGET_MS: 4_000,
    ADVISOR_DEBOUNCE_MS: 200,
    contextManagerRef: { current: { getState: () => state, clearExpiredActiveMeetingTask: () => false,
      addTranscriptTurn: (turn) => state.transcriptTurns.push(turn),
    } },
    runtimeEpochRef: { current: 2 },
    manualCorrectionRevisionRef: { current: 0 },
    runtimeActiveRef: { current: true },
    logicalQuestionUnitRef: { current: null },
    adjacentQuestionScopeRef: { current: null },
    latestForceAdviseTargetRef: { current: undefined },
    latestManualCorrectionTargetRef: { current: undefined },
    manualCorrectionTargetHistoryRef: { current: [] },
    effectiveQuestionSourceLedgerRef: { current: { list: () => [] } },
    stableAnswerRevisionRef: { current: undefined },
    visibleAnswerRevisionRef: { current: 0 },
    activeRef: { current: true }, shutdownRequestedRef: { current: false },
    currentQuestionLineageRef: { current: undefined }, activeAdvisorJobRef: { current: undefined },
    cancelledAdvisorTurnIdsRef: { current: new Set() }, taskBoundaryCandidateRef: { current: undefined },
    latestSourceOwnedSetupRef: { current: undefined }, latestNativeSpeechStartRef: { current: null },
    pendingSentenceCompletionRef: { current: null }, pendingConfirmationRef: { current: null },
    pendingInterviewSectionHintRef: { current: undefined }, pendingInterviewTaskBoundaryRef: { current: undefined },
    processPostBufferThemTurnRef: { current: null },
    sttEvaluationCaptureManagerRef: { current: undefined },
    SENTENCE_COMPLETION_BUFFER_MS: 3250, SENTENCE_COMPLETION_ABSOLUTE_MAX_MS: 4000,
    audioSessionIdRef: { current: 1 },
    nativeCaptureSessionIdRef: { current: "capture-a" },
    nativeCaptureGenerationRef: { current: 1 },
    audioDrainAuthorizationRef: { current: null },
    runtimeRegressionRunRef: { current: undefined },
    runtimeRegressionStepIdRef: { current: undefined },
    PENDING_CONFIRMATION_TTL_MS: 10_000,
    scheduleMeetingMetadataInference() {}, promoteMeTurnForFusion() {},
    scheduleSemanticTaxonomyShadow: () => ({ taskRelation: {
      operationId: "relation", releaseWindowRequested: false, sourceKind: "voice",
      authorizeOperation: () => ({ authorized: true, reason: "source-operation-current" }),
    } }),
    responseOpportunityGenerationGateRef: { current: new pure.ResponseOpportunityGenerationGateCoordinator() },
    responseOpportunityRuntimeRef: { current: runtime },
    responseOpportunityCircuitRef: { current: new pure.RuntimeInferenceSessionCircuitBreaker() },
    responseOpportunitySessionBudgetRef: { current: { authorize: () => ({ authorized: true, startsBefore: 0, startsAfter: 1, limit: 100 }) } },
    taxonomyAdjudicationSettingsRef: { current: { enabled: true } },
    meetingModelProviderSnapshotRef: { current: {} },
    resolveRuntimeInferenceModelRouteFromSnapshot: () => ({ provider: {}, selectedProvider: {}, missingRequiredVariables: [] }),
    readSelectedProviderModelId: () => "test-provider",
    sessionRecordingManagerRef: { current: {
      getState: () => ({ active: false }),
      recordRuntimeRegressionStep: (step) => replaySteps.push(step),
      recordCaptureLifecycle() {}, recordTranscriptTurn() {},
      recordModelInput() {}, recordModelOutput() {},
      recordTaskRelationAdjudicationDecision() {},
    } },
    debugModeRef: { current: false },
    traceStoreRef: { current: {
      updateMetadata: (id, update) => metadata.set(id, { ...metadata.get(id), ...update }),
      startTrace: (kind, initialMetadata) => {
        const trace = { id: `replay-trace-${traces.size + 1}`, kind, status: "running" };
        traces.set(trace.id, trace);
        metadata.set(trace.id, initialMetadata);
        return trace;
      },
      recordInput() {}, recordOutput() {}, finishStep() {}, startStep: () => "step",
      finishTrace: (...args) => {
        finished.push(args);
        traces.set(args[0], { id: args[0], status: args[1], error: args[2] });
      },
      getTraces: () => [...metadata].map(([id, value]) => ({ id, ...traces.get(id), metadata: value })),
    } },
    setState: (update) => { stateWrites += 1; ui = update(ui); },
    refreshRecordedCompletedTrace() {},
    recordQuestionTypeAdjudicationOutcome() {},
    scheduleAdvisor: (...args) => advisorCalls.push(args),
    requestResponseOpportunity: (input) => {
      const result = deferred();
      providerCalls.push({ ...input, ...result });
      return result.promise;
    },
  });
  callbackNames.forEach((name, index) => {
    environment[name] = vm.runInContext(transpile(`(${callbackSources[index]})`), context);
  });
  environment.processPostBufferThemTurnRef.current = environment.processPostBufferThemTurn;
  vm.runInContext(transpile(helperSource), context);

  function candidate(id, text = `How would you design ${id}?`, birthEpoch = 2) {
    const turn = { id: `turn-${id}`, text, speaker: "them", source: "system-audio", startedAt: clock.now, endedAt: clock.now + 1, isFinal: true };
    const unit = pure.composeCanonicalTurnCandidate({ currentTurn: turn, sessionId: state.sessionId, runtimeEpoch: birthEpoch, now: clock.now });
    return { turn, unit, traceId: `trace-${id}` };
  }

  function start(candidate, mode = "speculative-authoritative") {
    const original = {
      intent: "direct-question", action: "answer-refresh", executionAuthorized: true,
      contextPromptEligible: true, evidence: [], reason: "existing-local-output-authority",
    };
    if (mode === "authoritative") {
      Object.assign(original, { action: "append-context", executionAuthorized: false, reason: "runtime-required" });
    }
    state.transcriptTurns.push(candidate.turn);
    environment.publishResponseRecoveryTarget({
      logicalQuestionUnit: candidate.unit, turn: candidate.turn, traceId: candidate.traceId, intentDecision: original,
    });
    const handoffContext = vm.createContext({
      ...environment,
      traceId: candidate.traceId,
      turn: candidate.turn,
      advisorQuestionLineage: undefined,
      runtimeAdjudication: { taskRelation: {
        operationId: `relation-${candidate.traceId}`,
        releaseWindowRequested: false,
        sourceKind: "voice",
        authorizeOperation: () => ({ authorized: true, reason: "source-operation-current" }),
      } },
    });
    const onOutputAuthorized = vm.runInContext(transpile(`(${outputSource})`), handoffContext);
    environment.scheduleResponseOpportunityInference({
      logicalQuestionUnit: candidate.unit, turn: candidate.turn, traceId: candidate.traceId,
      originalDecision: original, executionMode: mode, onOutputAuthorized,
    });
    return scheduled.at(-1);
  }

  function modelResult(job, decision = "output-request") {
    const rawOutput = JSON.stringify({
      v: 4,
      d: decision === "output-request" ? "o" : decision === "no-output-request" ? "n" : "u",
      c: 0.99,
      t: decision === "unclear" ? [] : [0],
      r: decision === "output-request" ? "ask" : decision === "no-output-request" ? "acknowledgement" : "bounded-source-insufficient",
    });
    const parsed = pure.parseResponseOpportunityOutput(rawOutput, job.request);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    return { parsed, rawOutput, providerDisposition: "completed", parseDisposition: "valid" };
  }

  function settle(input, result, disposition = "completed") {
    input.onSettled({ job: input.job, result, disposition, scheduledAt: clock.now, completedAt: clock.now, budget: {} });
  }

  function products() {
    return {
      unit: environment.logicalQuestionUnitRef.current,
      forceTarget: environment.latestForceAdviseTargetRef.current,
      manualTarget: environment.latestManualCorrectionTargetRef.current,
      history: environment.manualCorrectionTargetHistoryRef.current,
      ui, stateWrites, advisorCalls: advisorCalls.length,
    };
  }

  return { environment, pure, state, clock, runtime, start, candidate, settle, modelResult, products, metadata, finished, advisorCalls, providerCalls, settlements, scheduled, replaySteps };
}

function bufferedTurn(h, id, text) {
  const value = h.candidate(id, text);
  const segment = { traceId: value.traceId, sessionId: 1, sequence: Number(id) || 1,
    nativeCaptureSessionId: "capture-a", nativeCaptureGeneration: 1,
    source: "system-audio", speaker: "them" };
  return { ...value, segment };
}

const replayBufferedText = "But then how, were you using AI to extract this? Did you write like a program to, so were you sending this to another AI to extract or are you...";

async function injectReplay(h, text = replayBufferedText) {
  h.environment.activeRef.current = false;
  h.environment.nativeCaptureSessionIdRef.current = null;
  h.environment.nativeCaptureGenerationRef.current = null;
  h.environment.runtimeRegressionRunRef.current = {
    scenarioRunId: "run-a", runtimeSessionId: h.state.sessionId,
    startedAt: h.clock.now, stepOrdinal: 0,
  };
  const result = h.environment.submitRuntimeRegressionText(text);
  await h.clock.flush();
  assert.equal(h.replaySteps[0].event, "injected");
  return { result, traceId: h.replaySteps[0].traceId };
}

test("RB1 real Replay submission retains provenance through timeout, RO and recorded terminal", async () => {
  const h = createHarness();
  const { result, traceId } = await injectReplay(h);
  const pending = h.environment.pendingSentenceCompletionRef.current;
  assert.equal(pending.turn.text, replayBufferedText);
  assert.deepEqual({ ...pending.segment.replaySource }, {
    scenarioRunId: "run-a", runtimeSessionId: "session-a", runtimeEpoch: 2,
  });
  assert.equal(h.environment.isCurrentAudioSegment(pending.segment), false);
  assert.equal(h.environment.isCurrentTurnSource(pending.segment), true);
  assert.equal(h.scheduled.length, 0);
  await h.clock.advance(3249);
  assert.equal(h.scheduled.length, 0);
  await h.clock.advance(1);
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.state.transcriptTurns[0].text, replayBufferedText);
  assert.equal(h.scheduled[0].job.request.decisionSpans.map((s) => s.text).join(" "), replayBufferedText);
  assert.equal(h.metadata.get(traceId).sentenceBufferOutcome, "timeout");
  h.environment.flushPendingSentenceCompletion("timeout");
  assert.equal(h.scheduled.length, 1);
  h.settle(h.scheduled[0], h.modelResult(h.scheduled[0].job, "no-output-request"));
  await h.clock.advance(100);
  assert.equal(await result, true);
  assert.equal(h.replaySteps.at(-1).event, "terminal");
  assert.equal(h.replaySteps.at(-1).terminalDisposition, "suppressed");
  assert.equal(h.products().ui.error, null);
  h.runtime.cancelAll();
});

test("RB1 complete Replay input still bypasses the buffer and uses the same RO", async () => {
  const h = createHarness();
  const { result } = await injectReplay(h, "Design a service for customer reviews and rewards.");
  assert.equal(h.environment.pendingSentenceCompletionRef.current, null);
  assert.equal(h.scheduled.length, 1);
  h.settle(h.scheduled[0], h.modelResult(h.scheduled[0].job, "no-output-request"));
  await h.clock.advance(100);
  assert.equal(await result, true);
  h.runtime.cancelAll();
});

test("RB1 buffered Replay output authorization reaches the shared Advisor plan and stable commit", async () => {
  const h = createHarness();
  const { result, traceId } = await injectReplay(h);
  await h.clock.advance(3250);
  h.settle(h.scheduled[0], h.modelResult(h.scheduled[0].job));
  await h.clock.flush();
  assert.equal(h.advisorCalls.length, 1);
  const call = h.advisorCalls[0];
  const plan = h.pure.buildSettledAdvisorExecutionPlan({ settlement: call[7],
    taskBoundaryCommitted: false, childOwnsResponse: false,
    providerSnapshot: { providers: [{ id: "main", curl: "https://main.test" }],
      selectedProvider: { provider: "main", variables: {} },
      codingProvider: { provider: "main", variables: {} } },
    memoryUseCase: "meeting_assistant", askFrame: "unknown", topicDomain: "unknown" });
  assert.equal(plan.responseAuthorized, true);
  const content = "Answer: I would send the input to an extraction model and validate the returned fields.";
  const stable = h.pure.commitStableAnswerRevision({ candidate: {
    id: "replay-answer", kind: "answer", confidence: "high", content,
    meetingAnswer: h.pure.parseMeetingAnswer(content), createdAt: h.clock.now,
    basedOnTurnIds: call[5].sourceTurnIds, basedOnObservationIds: [],
  }, authorizedArtifacts: plan.requestedArtifacts, taskId: null,
    logicalQuestionUnitId: call[5].id, logicalQuestionRevision: call[5].revision });
  assert.equal(stable.suggestion.content.replace(/\s+/g, " "), content);
  h.environment.traceStoreRef.current.updateMetadata(traceId, {
    advisorOutputCommittedToUi: true, visibleAnswerRevisionAfter: stable.revision,
  });
  h.environment.traceStoreRef.current.finishTrace(traceId, "success");
  await h.clock.advance(100);
  assert.equal(await result, true);
  assert.equal(h.replaySteps.at(-1).terminalDisposition, "visible");
  h.runtime.cancelAll();
});

for (const [name, invalidate] of [
  ["run replaced", (h) => { h.environment.runtimeRegressionRunRef.current.scenarioRunId = "run-b"; }],
  ["run stopped", (h) => { h.environment.runtimeRegressionRunRef.current = undefined; }],
  ["meeting replaced", (h) => { h.state.sessionId = "session-b"; }],
  ["run meeting replaced", (h) => { h.environment.runtimeRegressionRunRef.current.runtimeSessionId = "session-b"; }],
  ["Clear epoch", (h) => { h.environment.runtimeEpochRef.current += 1; }],
  ["inactive runtime", (h) => { h.environment.runtimeActiveRef.current = false; }],
  ["shutdown", (h) => { h.environment.shutdownRequestedRef.current = true; }],
]) {
  test(`RB2 Replay deferred source rejects ${name} without publishing`, async () => {
    const h = createHarness();
    const { result } = await injectReplay(h);
    invalidate(h);
    await h.clock.advance(3400);
    await result;
    assert.equal(h.state.transcriptTurns.length, 0);
    assert.equal(h.scheduled.length, 0);
    assert.equal(h.advisorCalls.length, 0);
    assert.equal(h.environment.pendingSentenceCompletionRef.current, null);
    h.runtime.cancelAll();
  });
}

test("RB2 explicit buffer reset consumes the old timer before another lifetime", async () => {
  const h = createHarness();
  const { result } = await injectReplay(h);
  const pending = h.environment.pendingSentenceCompletionRef.current;
  const lateTimer = h.clock.timers.get(pending.timeoutId).callback;
  h.environment.runtimeEpochRef.current += 1;
  h.environment.clearPendingSentenceCompletionForRuntimeReset("active-task-cleared");
  lateTimer();
  await h.clock.advance(4000);
  await result;
  assert.equal(h.state.transcriptTurns.length, 0);
  assert.equal(h.scheduled.length, 0);
});

test("RB3 native drain still preserves source while a fabricated scenario ID has no authority", async () => {
  const h = createHarness();
  const item = bufferedTurn(h, "1", "Can you explain...");
  assert.equal(h.environment.isCurrentTurnSource(item.segment), true);
  assert.equal(h.environment.isCurrentTurnSource({ ...item.segment, sessionId: "scenario:run-a" }), false);
  h.environment.holdPendingSentenceCompletion(item.turn, item.segment, h.pure.decideSentenceCompletion(item.turn.text));
  h.environment.runtimeActiveRef.current = false;
  h.environment.nativeCaptureSessionIdRef.current = null;
  h.environment.audioDrainAuthorizationRef.current = h.pure.createAudioDrainAuthorization({
    operationId: "drain-a", kind: "stop", audioSessionId: 1,
    captureSessionId: "capture-a", captureGeneration: 1,
    issuedAt: h.clock.now, expiresAt: h.clock.now + 5000,
  });
  await h.clock.advance(3250);
  assert.equal(h.state.transcriptTurns[0].text, item.turn.text);
  assert.equal(h.scheduled.length, 0);
  h.clock.now += 2000;
  assert.equal(h.environment.isCurrentTurnSource(item.segment), false);
});

test("RB3 Replay manual and Screen flushes preserve text without a competing automatic RO", async () => {
  for (const reason of ["force-advise", "manual-question-type-correction", "screen-task", "next-phase"]) {
    const h = createHarness();
    const { result } = await injectReplay(h);
    h.environment.flushPendingSentenceCompletion(reason);
    await h.clock.advance(4000);
    await result;
    assert.equal(h.state.transcriptTurns[0].text, replayBufferedText, reason);
    assert.equal(h.scheduled.length, 0, reason);
  }
});

test("RB3 Replay confirmation expiry uses source lifetime rather than a native capture", async () => {
  const h = createHarness();
  const { result, traceId } = await injectReplay(h, "The first option");
  assert.ok(h.environment.pendingConfirmationRef.current);
  await h.clock.advance(10_100);
  assert.equal(h.environment.pendingConfirmationRef.current, null);
  assert.equal(h.state.transcriptTurns[0].text, "The first option");
  assert.equal(h.scheduled.length, 1);
  h.settle(h.scheduled[0], h.modelResult(h.scheduled[0].job, "no-output-request"));
  await h.clock.advance(100);
  assert.equal(await result, true);
  assert.notEqual(h.metadata.get(traceId).transcriptAppendDisposition, "deferred");
  h.runtime.cancelAll();
});

test("RB3 Replay confirmation pairing consumes its original timer once", async () => {
  const h = createHarness();
  const { result } = await injectReplay(h, "The first option");
  const pending = h.environment.pendingConfirmationRef.current;
  assert.ok(pending);
  const lateTimer = h.clock.timers.get(pending.timeoutId).callback;
  const me = { id: "me-clarification", text: "Do you mean the first option?", speaker: "me",
    source: "microphone", contextTier: "me_clarification_short", isFinal: true,
    startedAt: h.clock.now, endedAt: h.clock.now };
  assert.equal(h.environment.resolvePendingConfirmationForMeTurn(me), true);
  lateTimer();
  assert.equal(h.state.transcriptTurns.length, 1);
  assert.equal(h.scheduled.length, 1);
  h.settle(h.scheduled[0], h.modelResult(h.scheduled[0].job, "no-output-request"));
  await h.clock.advance(10_100);
  assert.equal(await result, true);
  h.runtime.cancelAll();
});

for (const viaPairing of [false, true]) {
  test(`RB3 stale Replay confirmation cannot publish through ${viaPairing ? "pairing" : "expiry"}`, async () => {
    const h = createHarness();
    const { result } = await injectReplay(h, "The first option");
    h.environment.runtimeEpochRef.current += 1;
    if (viaPairing) {
      assert.equal(h.environment.resolvePendingConfirmationForMeTurn({
        id: "me", text: "Do you mean the first option?", speaker: "me",
        startedAt: h.clock.now, endedAt: h.clock.now,
      }), false);
    }
    await h.clock.advance(10_100);
    await result;
    assert.equal(h.state.transcriptTurns.length, 0);
    assert.equal(h.scheduled.length, 0);
  });
}

test("RB3 shared merge accepts live Replay provenance and rejects a stale epoch", async () => {
  for (const stale of [false, true]) {
    const h = createHarness();
    const { result } = await injectReplay(h);
    const pending = h.environment.pendingSentenceCompletionRef.current;
    const next = h.candidate("next", "using a local parser?");
    const segment = { ...pending.segment, traceId: next.traceId, sequence: 2 };
    if (stale) h.environment.runtimeEpochRef.current += 1;
    // Exercise the shared consumer only; the serial Runner UI remains unchanged.
    const merged = h.environment.consumePendingSentenceCompletion(next.turn, segment);
    assert.equal(Boolean(merged), !stale);
    if (!stale) assert.ok(next.turn.text.startsWith(replayBufferedText.replace(/\.\.\.$/, "")));
    await h.clock.advance(4000);
    await result;
    assert.equal(h.scheduled.length, 0);
  }
});

for (const decision of ["o", "n"]) {
  for (const stale of [false, true]) {
    test(`RO source-bounded target: seven spans ${decision}, stale=${stale}, use the existing publication boundary`, async () => {
      const h = createHarness();
      const text = Array.from({ length: 7 }, (_, i) => decision === "o"
        ? `Please explain requirement ${i}.` : `Our team handles component ${i}.`).join(" ");
      const item = bufferedTurn(h, "1", text);
      h.environment.processPostBufferThemTurn(item.turn, item.segment);
      assert.equal(h.scheduled.length, 1);
      const operation = h.scheduled[0];
      assert.equal(operation.job.request.decisionSpans.length, 7);
      const rawOutput = JSON.stringify({ v: 4, d: decision, c: 0.9,
        t: [6, 5, 4, 3, 2, 1, 0], r: decision === "o" ? "ask" : "answer-to-candidate" });
      const parsed = h.pure.parseResponseOpportunityOutput(rawOutput, operation.job.request);
      assert.equal(parsed.ok, true);
      const before = h.products();
      if (stale) h.environment.runtimeEpochRef.current += 1;
      h.settle(operation, { rawOutput, parsed, providerDisposition: "completed-with-content", parseDisposition: "valid-json" });
      await h.clock.flush();
      if (stale) {
        assert.deepEqual(h.products(), before);
        assert.equal(h.metadata.get(item.traceId).responseOpportunityLeaseAuthorized, false);
      } else if (decision === "o") {
        assert.equal(h.advisorCalls.length, 1);
        assert.equal(h.pure.getLogicalQuestionAnswerFocusText(h.advisorCalls[0][5]), text);
        assert.equal(h.advisorCalls[0][7].responseAuthorized, true);
      } else {
        assert.equal(h.advisorCalls.length, 0);
        const target = h.environment.latestForceAdviseTargetRef.current;
        assert.equal(target.logicalQuestionUnit.responseOpportunityTarget.decision, "no-output-request");
        assert.equal(target.presentation.text, text);
        assert.equal(h.metadata.get(item.traceId).responseOpportunityGenerationGateDisposition, "output-suppressed");
      }
      h.runtime.cancelAll();
    });
  }
}

test("A1 original CRUD source reaches RO, settled output permission and stable Answer without Force", async () => {
  const h = createHarness();
  const item = bufferedTurn(h, "1", "Maybe to help kind of structure, we can start with like defining APIs for just the first part, which is the review CRUD, and then we can move on to the, after we finish that part with like the data models, then we can come back and then add the reward parts later, just to help you kind of think about it.");
  h.environment.processPostBufferThemTurn(item.turn, item.segment);
  assert.equal(h.scheduled.length, 1);
  h.settle(h.scheduled[0], h.modelResult(h.scheduled[0].job));
  await h.clock.flush();
  assert.equal(h.advisorCalls.length, 1);
  const call = h.advisorCalls[0];
  const settlement = call[7];
  assert.equal(settlement.responseAuthorized, true);
  assert.equal(call[6], "input-evidence");
  const plan = h.pure.buildSettledAdvisorExecutionPlan({ settlement,
    taskBoundaryCommitted: false, childOwnsResponse: false,
    providerSnapshot: { providers: [{ id: "main", curl: "https://main.test" }],
      selectedProvider: { provider: "main", variables: {} },
      codingProvider: { provider: "main", variables: {} } },
    memoryUseCase: "meeting_assistant", askFrame: "unknown", topicDomain: "unknown" });
  assert.equal(h.pure.authorizeAdvisorOutputCommit({ executionAuthorized: plan.responseAuthorized }).authorized, true);
  const content = "Answer: Start with create, read, update, and delete review APIs, then define their data models.";
  const stable = h.pure.commitStableAnswerRevision({ candidate: {
    id: "crud-answer", kind: "answer", confidence: "high", content,
    meetingAnswer: h.pure.parseMeetingAnswer(content), createdAt: h.clock.now,
    basedOnTurnIds: call[5].sourceTurnIds, basedOnObservationIds: [],
  }, authorizedArtifacts: plan.requestedArtifacts, taskId: null,
    logicalQuestionUnitId: call[5].id, logicalQuestionRevision: call[5].revision });
  assert.match(stable.suggestion.content, /create, read, update, and delete/);
  assert.equal(stable.logicalQuestionUnitId, call[5].id);
  h.runtime.cancelAll();
});

test("CX1 original E complete ask with incomplete tail reaches the real RO once after timeout", async () => {
  const h = createHarness();
  const text = "But then how, were you using AI to extract this? Did you write like a program to, so were you sending this to another AI to extract or are you...";
  const item = bufferedTurn(h, "1", text);
  const decision = h.pure.decideSentenceCompletion(text);
  assert.equal(decision.disposition, "buffer");
  h.environment.holdPendingSentenceCompletion(item.turn, item.segment, decision);
  assert.equal(h.scheduled.length, 0);
  await h.clock.advance(3250);
  assert.equal(h.environment.pendingSentenceCompletionRef.current, null);
  assert.equal(h.state.transcriptTurns.length, 1);
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.scheduled[0].job.request.decisionSpans.map((s) => s.text).join(" "), text);
  h.settle(h.scheduled[0], h.modelResult(h.scheduled[0].job));
  await h.clock.flush();
  assert.equal(h.advisorCalls.length, 1);
  assert.equal(h.metadata.get(item.traceId).responseOpportunityGenerationGateDisposition, "output-authorized");
  h.runtime.cancelAll();
});

test("CX1 rebuffer retains original four-second deadline and one terminal handoff", async () => {
  const h = createHarness();
  const first = bufferedTurn(h, "1", "The important tradeoff is between consistency and");
  h.environment.holdPendingSentenceCompletion(first.turn, first.segment, h.pure.decideSentenceCompletion(first.turn.text));
  const original = h.environment.pendingSentenceCompletionRef.current.firstHeldAt;
  await h.clock.advance(3000);
  const second = bufferedTurn(h, "2", "availability, but");
  const merge = h.environment.consumePendingSentenceCompletion(second.turn, second.segment);
  h.environment.holdPendingSentenceCompletion(second.turn, second.segment, h.pure.decideSentenceCompletion(second.turn.text), merge);
  assert.equal(h.environment.pendingSentenceCompletionRef.current.firstHeldAt, original);
  await h.clock.advance(999);
  assert.equal(h.scheduled.length, 0);
  await h.clock.advance(1);
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.state.transcriptTurns.length, 1);
  h.environment.flushPendingSentenceCompletion("timeout");
  assert.equal(h.scheduled.length, 1);
  h.runtime.cancelAll();
});

test("CX2 manual and stopped flushes retain source without launching a competing automatic RO", async () => {
  for (const reason of ["force-advise", "manual-question-type-correction", "screen-task", "next-phase", "stop"]) {
    const h = createHarness();
    const item = bufferedTurn(h, "1", "Can you explain...");
    const old = h.products();
    h.environment.holdPendingSentenceCompletion(item.turn, item.segment, h.pure.decideSentenceCompletion(item.turn.text));
    h.environment.flushPendingSentenceCompletion(reason);
    await h.clock.advance(5000);
    assert.equal(h.scheduled.length, 0, reason);
    assert.equal(h.state.transcriptTurns[0].text, item.turn.text, reason);
    assert.equal(h.products().manualTarget, old.manualTarget, reason);
    assert.equal(h.products().unit, old.unit, reason);
  }
});

test("CX1 continuation deadline and late callbacks hand off once and expose actual lateness", async () => {
  const h = createHarness();
  const item = bufferedTurn(h, "1", "Can you explain...");
  h.environment.holdPendingSentenceCompletion(item.turn, item.segment, h.pure.decideSentenceCompletion(item.turn.text));
  h.environment.pendingSentenceCompletionRef.current.continuationDeadlineAt = h.clock.now + 4000;
  h.environment.pendingSentenceCompletionRef.current.continuationExtensionUsed = true;
  h.clock.now += 6000;
  h.environment.flushPendingSentenceCompletion("continuation-absolute-timeout");
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.metadata.get(item.traceId).sentenceBufferDeadlineOverrunMs, 2000);
  h.environment.flushPendingSentenceCompletion("timeout");
  assert.equal(h.scheduled.length, 1);
  h.runtime.cancelAll();
});

test("CX2 stale buffered capture cannot append or regain RO authority", () => {
  const h = createHarness();
  const item = bufferedTurn(h, "1", "Can you explain...");
  item.segment.sessionId = 99;
  h.environment.holdPendingSentenceCompletion(item.turn, item.segment, h.pure.decideSentenceCompletion(item.turn.text));
  h.environment.flushPendingSentenceCompletion("timeout");
  assert.equal(h.state.transcriptTurns.length, 0);
  assert.equal(h.scheduled.length, 0);
  assert.equal(h.metadata.get(item.traceId).sentenceBufferOutcome, "cancelled");
});

test("RO-F1: B publishes through real ordered handoff; inverse A completion cannot restore captured state", async () => {
  const h = createHarness();
  const a = h.start(h.candidate("A"));
  const b = h.start(h.candidate("B"));
  assert.equal(h.environment.logicalQuestionUnitRef.current, null);
  assert.equal(h.advisorCalls.length, 0);
  // Fault-inject callback order; the shared runtime normally serializes providers.
  h.settle(b, h.modelResult(b.job));
  await h.clock.flush();
  assert.equal(h.advisorCalls.length, 1);
  assert.equal(h.advisorCalls[0][5].id, b.job.lease.logicalQuestionUnitId);
  assert.equal(h.advisorCalls[0][7].action, "answer");
  assert.equal(h.metadata.get("trace-B").runtimeSettlementAppliedToRuntime, true);
  const before = h.products();
  h.settle(a, h.modelResult(a.job));
  await h.clock.flush();
  assert.deepEqual(h.products(), before);
  assert.equal(h.metadata.get("trace-A").responseOpportunityDecisionApplied, false);
  assert.equal(h.metadata.get("trace-A").responseOpportunityLeaseAuthorized, false);
  assert.equal(h.environment.responseOpportunityGenerationGateRef.current.read(a.job.operationId).disposition, "stale");
  h.runtime.cancelAll();
});

for (const mode of ["speculative-authoritative", "authoritative"]) {
  for (const invalidation of ["revision", "source", "manual-correction", "epoch", "session", "inactive"]) {
    test(`RO-F2: ${mode} ${invalidation} invalidation has no publication, target, gate or handoff effect`, async () => {
      const h = createHarness();
      const candidate = h.candidate("A");
      candidate.unit.responseOpportunityTarget = {
        text: "captured target", source: "runtime-llm", decision: "output-request",
        sourceHash: "captured", sourceTurnIds: [candidate.turn.id],
      };
      const operation = h.start(candidate, mode);
      h.environment.logicalQuestionUnitRef.current = candidate.unit;
      if (invalidation === "revision") h.environment.logicalQuestionUnitRef.current = { ...candidate.unit, revision: candidate.unit.revision + 1 };
      if (invalidation === "source") h.environment.logicalQuestionUnitRef.current = {
        ...candidate.unit,
        sources: candidate.unit.sources.map((span) => ({ ...span, text: "Corrected source question?" })),
        normalizedText: "Corrected source question?",
      };
      if (invalidation === "manual-correction") h.environment.manualCorrectionRevisionRef.current += 1;
      if (invalidation === "epoch") h.environment.runtimeEpochRef.current += 1;
      if (invalidation === "session") h.state.sessionId = "next-session";
      if (invalidation === "inactive") h.environment.runtimeActiveRef.current = false;
      const before = h.products();
      h.settle(operation, h.modelResult(operation.job));
      await h.clock.flush();
      assert.deepEqual(h.products(), before);
      assert.equal(h.metadata.get(candidate.traceId).responseOpportunityDecisionApplied, false);
      assert.equal(h.metadata.get(candidate.traceId).responseOpportunityLeaseAuthorized, false);
      assert.equal(h.metadata.get(candidate.traceId).logicalQuestionPublicationStage, "release-cancelled");
      if (mode === "speculative-authoritative") assert.equal(h.environment.responseOpportunityGenerationGateRef.current.read(operation.job.operationId).disposition, "stale");
      h.runtime.cancelAll();
    });
  }
}

for (const transition of ["Pause", "Clear", "new session"]) {
  for (const phase of ["pending", "active-success", "active-error"]) {
    test(`RO-F3: ${transition} revokes ${phase} before cancelled callback can restart work`, async () => {
      const h = createHarness();
      const operation = h.start(h.candidate("A"));
      if (phase !== "pending") {
        await h.clock.advance(500);
        assert.equal(h.providerCalls.length, 1);
      }
      const before = h.products();
      h.runtime.cancelAll("superseded");
      if (phase === "pending") assert.equal(h.settlements[0].currentOperationId, undefined);
      h.environment.runtimeEpochRef.current += 1;
      if (transition === "new session") h.state.sessionId = "session-b";
      if (phase === "active-success") h.providerCalls[0].resolve(h.modelResult(operation.job));
      if (phase === "active-error") h.providerCalls[0].reject(new Error("aborted provider"));
      await h.clock.flush();
      assert.deepEqual(h.products(), before);
      assert.equal(h.metadata.get("trace-A").responseOpportunityDecisionApplied, false);
      assert.equal(h.environment.responseOpportunityGenerationGateRef.current.read(operation.job.operationId).disposition, "stale");
      const next = h.start(h.candidate("B"));
      await h.clock.advance(500);
      h.providerCalls.at(-1).resolve(h.modelResult(next.job));
      await h.clock.flush();
      assert.equal(h.advisorCalls.length, 1);
      assert.equal(h.environment.logicalQuestionUnitRef.current.id, next.job.lease.logicalQuestionUnitId);
      h.runtime.cancelAll();
    });
  }
}

for (const disposition of ["superseded", "disposed", "operation-mismatch"]) {
  test(`RO-F3: ${disposition} is cancellation, even when the source lease otherwise matches`, () => {
    const h = createHarness();
    const operation = h.start(h.candidate("A"));
    const before = h.products();
    h.settle(operation, h.modelResult(operation.job), disposition);
    assert.deepEqual(h.products(), before);
    assert.equal(h.metadata.get("trace-A").responseOpportunityDecisionApplied, false);
    assert.equal(h.environment.responseOpportunityGenerationGateRef.current.read(operation.job.operationId).disposition, "stale");
    h.runtime.cancelAll();
  });
}

test("RO-F3: disposed active provider completion cannot publish after the meeting becomes active again", async () => {
  const h = createHarness();
  const operation = h.start(h.candidate("A"));
  await h.clock.advance(500);
  assert.equal(h.providerCalls.length, 1);
  const before = h.products();
  h.runtime.cancelAll("disposed");
  assert.equal(h.providerCalls[0].signal.aborted, true);
  h.environment.runtimeActiveRef.current = true;
  h.providerCalls[0].resolve(h.modelResult(operation.job));
  await h.clock.flush();
  assert.deepEqual(h.products(), before);
  assert.equal(h.settlements.at(-1).currentOperationId, undefined);
  assert.equal(h.metadata.get("trace-A").responseOpportunityDecisionApplied, false);
  assert.equal(h.metadata.get("trace-A").logicalQuestionPublicationStage, "release-cancelled");
});

for (const mode of ["speculative-authoritative", "authoritative", "shadow-observation"]) {
  for (const outcome of ["output-request", "no-output-request", "unclear", "timeout", "parse-failure", "error", "budget-exhausted"]) {
    test(`RO-F4: current provisional ${mode} preserves ${outcome} behavior through ordered handoff`, async () => {
      const h = createHarness();
      // Retained sources can predate the resumed execution epoch.
      h.environment.logicalQuestionUnitRef.current = h.candidate("prior", "Prior question?", 1).unit;
      const candidate = h.candidate("new", "How would you design a queue?", 1);
      const operation = h.start(candidate, mode);
      assert.equal(operation.job.lease.runtimeEpoch, 2);
      assert.equal(candidate.unit.runtimeEpoch, 1);
      const before = h.products();
      const modelOutcome = ["output-request", "no-output-request", "unclear"].includes(outcome);
      const result = modelOutcome ? h.modelResult(operation.job, outcome)
        : outcome === "timeout"
          ? {
              parsed: h.pure.parseResponseOpportunityOutput("", operation.job.request),
              rawOutput: "", parseDisposition: "invalid-json",
              providerDisposition: "request-timeout",
              providerOutcome: { status: "timed-out" },
            }
          : outcome === "parse-failure"
            ? { parsed: h.pure.parseResponseOpportunityOutput("{", operation.job.request), rawOutput: "{", parseDisposition: "invalid-json" }
            : undefined;
      h.settle(operation, result, outcome === "budget-exhausted" ? "budget-exhausted" : outcome === "error" ? "error" : "completed");
      await h.clock.flush();
      const publishes = mode !== "shadow-observation" && outcome !== "no-output-request" && outcome !== "error";
      assert.equal(h.advisorCalls.length, publishes ? 1 : 0);
      assert.equal(h.environment.logicalQuestionUnitRef.current.id, publishes ? candidate.unit.id : before.unit.id);
      assert.equal(h.metadata.get(candidate.traceId).responseOpportunityLeaseAuthorized, true);
      assert.equal(h.metadata.get(candidate.traceId).responseOpportunityTimedOut, outcome === "timeout");
      assert.equal(h.metadata.get(candidate.traceId).responseOpportunityDecisionApplied, publishes);
      if (publishes) {
        assert.equal(h.environment.latestManualCorrectionTargetRef.current.logicalQuestionUnit.id, candidate.unit.id);
        assert.equal(h.metadata.get(candidate.traceId).runtimeSettlementAppliedToRuntime, true);
        assert.equal(h.metadata.get(candidate.traceId).logicalQuestionPublicationStage, "canonical-published");
        assert.equal(h.advisorCalls[0][5], h.environment.logicalQuestionUnitRef.current);
        assert.equal(h.advisorCalls[0][7].action, "answer");
      }
      if (mode === "shadow-observation") assert.deepEqual(h.products(), before);
      if (mode !== "shadow-observation" && outcome === "no-output-request") {
        const target = h.environment.latestForceAdviseTargetRef.current;
        assert.equal(target.logicalQuestionUnit.responseOpportunityTarget.decision, "no-output-request");
        assert.equal(target.presentation.text, operation.job.request.decisionSpans[0].text);
        assert.equal(h.products().manualTarget, before.manualTarget);
        assert.equal(h.products().history, before.history);
      }
      if (mode !== "shadow-observation") assert.equal(h.environment.responseOpportunityGenerationGateRef.current.read(operation.job.operationId).disposition, outcome === "no-output-request" ? "output-suppressed" : outcome === "error" ? "unresolved" : "output-authorized");
      h.runtime.cancelAll();
    });
  }
}

for (const skip of ["disabled", "circuit", "missing-provider", "session-budget"]) {
  for (const mode of ["speculative-authoritative", "authoritative"]) {
    test(`RO-F4: synchronous ${skip} preserves existing ${mode} local fallback`, () => {
      const h = createHarness();
      if (skip === "disabled") h.environment.taxonomyAdjudicationSettingsRef.current.enabled = false;
      if (skip === "circuit") h.environment.responseOpportunityCircuitRef.current.open({ operationKind: "response-opportunity-inference", sessionId: h.state.sessionId, reason: "provider-auth-error" });
      if (skip === "missing-provider") h.environment.resolveRuntimeInferenceModelRouteFromSnapshot = () => ({ selectedProvider: {}, missingRequiredVariables: ["API_KEY"] });
      if (skip === "session-budget") h.environment.responseOpportunitySessionBudgetRef.current.authorize = () => ({ authorized: false, reason: "session-budget-exhausted" });
      const candidate = h.candidate("A");
      h.start(candidate, mode);
      assert.equal(h.providerCalls.length, 0);
      assert.equal(h.runtime.getCurrentOperationId(), undefined);
      const publishes = skip === "disabled" || skip === "session-budget";
      assert.equal(h.advisorCalls.length, publishes ? 1 : 0);
      assert.equal(h.environment.logicalQuestionUnitRef.current?.id, publishes ? candidate.unit.id : undefined);
      h.runtime.cancelAll();
    });
  }
}

for (const kind of ["response-opportunity-inference", "question-type-adjudication", "task-relation-parent-affinity", "meeting-metadata-inference", "source-linkage-adjudication"]) {
  for (const reason of ["superseded", "disposed"]) {
    test(`Task183: ${kind} ${reason} revokes authority before synchronous pending notification`, async () => {
      const h = createHarness();
      const runtime = new h.pure.RuntimeInferenceOperationRuntime(kind);
      const observed = [];
      const job = (id) => ({ operationId: id, operationKind: kind, sessionId: "session", budgetKey: id, budgetSlot: "test", budgetReason: "test" });
      runtime.schedule({
        job: job("pending"),
        execute: async () => assert.fail("pending operation executed"),
        onSettled: (value) => observed.push([value.disposition, runtime.getCurrentOperationId()]),
      }, 100);
      runtime.cancelAll(reason);
      assert.deepEqual(observed, [[reason, undefined]]);
      assert.equal(runtime.getCurrentOperationId(), undefined);
      let starts = 0;
      runtime.schedule({ job: job("next"), execute: async () => { starts += 1; }, onSettled() {} }, 0);
      await h.clock.advance(1);
      assert.equal(starts, reason === "disposed" ? 0 : 1);
      runtime.cancelAll();
    });
  }
  test(`Task183: ${kind} revokes active authority before synchronous abort observers`, async () => {
    const h = createHarness();
    const runtime = new h.pure.RuntimeInferenceOperationRuntime(kind);
    const execution = deferred();
    const abortAuthority = [];
    const settledAuthority = [];
    runtime.schedule({
      job: { operationId: "active", operationKind: kind, sessionId: "session", budgetKey: "active", budgetSlot: "test", budgetReason: "test" },
      execute: (_job, signal) => {
        signal.addEventListener("abort", () => abortAuthority.push(runtime.getCurrentOperationId()));
        return execution.promise;
      },
      onSettled: () => settledAuthority.push(runtime.getCurrentOperationId()),
    }, 0);
    await h.clock.advance(1);
    runtime.cancelAll("superseded");
    assert.deepEqual(abortAuthority, [undefined]);
    execution.resolve("late success");
    await h.clock.flush();
    assert.deepEqual(settledAuthority, [undefined]);
  });
}
