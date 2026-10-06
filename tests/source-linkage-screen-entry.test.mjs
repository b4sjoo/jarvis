import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const output = process.env.JARVIS_SOURCE_LINKAGE_TEST_OUT_DIR ?? ".tmp-tests";
// Task 178A: the shared helper that builds the real critical event stream.
const { createRuntimeCriticalEventHarness, RUNTIME_CRITICAL_EVENT_HOOK_CALLBACKS } = await import(pathToFileURL(path.resolve(output, "tests/helpers/runtime-critical-events.js")));
const source = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
function find(node, predicate) {
  let found;
  const visit = (child) => {
    if (!found && predicate(child)) found = child;
    if (!found) ts.forEachChild(child, visit);
  };
  visit(node);
  assert.ok(found, "expected production AST node");
  return found;
}
const declaration = (name, root = source) => find(root, (node) =>
  (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(source) === name);
const callback = (name) => declaration(name).initializer.arguments[0];
const capture = callback("captureScreenContext");
// Task 178A: the Hook's own emit callbacks, extracted once.
const criticalEventCallbackSources = Object.fromEntries(RUNTIME_CRITICAL_EVENT_HOOK_CALLBACKS.map((name) =>
  [name, `(${callback(name).getText(source)})`]));
const evaluate = (text, env) => vm.runInNewContext(ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText, env);
const load = (name) => import(pathToFileURL(path.resolve(output, `src/lib/meeting/${name}.js`)));
const { recordedLinkageOutputs } = await import(pathToFileURL(path.resolve(output, "tests/helpers/source-linkage-recorded-outputs.js")));
const modules = {};
for (const name of [
  "screen-task-scope", "visual-evidence-recovery", "manual-screen-question-source",
  "source-linkage-adjudication", "runtime-inference", "runtime-inference-runtime",
  "runtime-inference-health", "runtime-commit-authorization", "screen-operation-coordinator",
  "current-question-settlement", "interview-section-transition", "answer-generation-lease",
  "screen-preflight-deadline", "advisor-generation-supersession",
  "source-owned-transition-transaction", "source-owned-transition-runtime",
  "meeting-model-route", "task-taxonomy", "task-relation-authority", "meeting-ai-response",
  "advisor-evidence-packet",
]) Object.assign(modules, await load(name));
const evidenceBuilder = declaration("buildScreenEvidencePacket", capture).initializer;
const advisorPacketCall = find(evidenceBuilder, (node) => ts.isCallExpression(node) && node.expression.getText(source) === "buildAdvisorEvidencePacket");
const currentAskProperty = advisorPacketCall.arguments[0].properties.find((node) => node.name?.getText(source) === "currentQuestion");
const solveCall = find(capture, (node) => ts.isCallExpression(node) && node.expression.getText(source) === "solveScreenAnchoredTask");
const solveProperty = (name) => solveCall.arguments[0].properties.find((node) => node.name?.getText(source) === name).initializer.getText(source);
const requestSource = ts.createSourceFile("request.ts", readFileSync("src/lib/meeting/source-linkage-adjudication-request.ts", "utf8"), ts.ScriptTarget.Latest, true);
const requestAdapter = find(requestSource, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "requestSourceLinkageAdjudication");
const visibleConsumer = find(capture, (node) => ts.isIfStatement(node) &&
  node.expression.getText(source) === "screenVisibleAnswerCommitted" &&
  node.thenStatement.getText(source).includes("settleAwaitingVisualEvidenceRecovery"));
const visibleRecoveryCommit = find(visibleConsumer.thenStatement, (node) =>
  ts.isIfStatement(node) && node.expression.getText(source).includes("screenExactVisualEvidenceRecovery"));

// Run the actual ingress, including its await/guards. Stop only after the final
// packet consumer has received the primary ask, before unrelated Type/Advisor IO.
const consumerStart = declaration("screenSourceFallbackQuestionTypeDecision", capture).parent.parent;
const transformed = ts.transform(capture, [(context) => {
  const visit = (node) => node === consumerStart
    ? ts.factory.createReturnStatement(ts.factory.createCallExpression(ts.factory.createIdentifier("consumePacket"), undefined, [
        ts.factory.createObjectLiteralExpression([
          "screenSourcePacket", "screenRelationLogicalQuestionUnit", "screenEvidenceText",
          "screenPrimaryAskEvidenceText", "screenTranscriptContext", "screenQuestionOwnedByVoice",
          "screenExactVisualEvidenceRecovery", "boundVisualRecoveryRelation", "selectedVisualRecovery",
        ].map((name) => ts.factory.createShorthandPropertyAssignment(name)).concat([
          ts.factory.createPropertyAssignment("checkAfterModel", ts.factory.createArrowFunction(undefined, undefined, [], undefined, undefined,
            ts.factory.createCallExpression(ts.factory.createIdentifier("rejectStaleScreenOperation"), undefined, [ts.factory.createStringLiteral("post-model")]))),
          ts.factory.createPropertyAssignment("commitVisible", ts.factory.createArrowFunction(undefined, undefined,
            [ts.factory.createParameterDeclaration(undefined, undefined, "screenVisibleAnswerCommitted")], undefined, undefined,
            ts.factory.createBlock([ts.factory.createIfStatement(visibleConsumer.expression, visibleRecoveryCommit)], true))),
        ])),
      ]))
    : ts.visitEachChild(node, visit, context);
  return (node) => ts.visitNode(node, visit);
}]);
const captureText = ts.createPrinter().printNode(ts.EmitHint.Expression, transformed.transformed[0], source);
transformed.dispose();

function harness(options = {}) {
  const now = Date.now();
  const unit = {
    id: "voice-original", revision: 3, sessionId: "session", runtimeEpoch: 4,
    normalizedText: options.voiceQuestion ?? "Explain lines 35 through 38.", sourceTurnIds: ["turn-original"],
  };
  const context = {
    sessionId: "session", screenObservations: [], transcriptTurns: [],
    taskRuntime: { revision: 2 },
    activeMeetingTask: { id: "task", parent: { id: "parent", questionType: "coding", stableKind: "coding", topic: "API Coding", revisions: 2 } },
  };
  const fact = modules.createAwaitingVisualEvidenceRecoveryFact({
    resolution: { state: "awaiting-evidence", awaitingVisualEvidence: true, evidence: [unit.normalizedText] },
    sessionId: "session", runtimeEpoch: 4, logicalQuestionUnitId: unit.id,
    logicalQuestionRevision: unit.revision, answerRevision: 1, visibleAnswerRevision: 1,
    parentTaskId: "parent", parentRevision: 2, questionType: "coding", questionText: unit.normalizedText,
    sourceHash: "original-source-hash", sourceSettlementId: "voice-settlement", sourceTurnIds: unit.sourceTurnIds,
    manualCorrectionRevision: 0, createdAt: now,
    ...options.fact,
  });
  if (options.child) context.activeMeetingTask.child = { id: "child", questionType: options.child, question: "Child question" };
  if (options.parentless) {
    context.activeMeetingTask = undefined;
    fact.parentTaskId = undefined;
    fact.ownerKind = "current-question";
    fact.ownerBranchId = unit.id;
  }
  const facts = new Map(options.noOpportunity ? [] : [[fact.ownerBranchId, fact]]);
  const traces = [];
  const recordedOutputs = [];
  const calls = [];
  const packets = [];
  const settlements = [];
  let serial = 0;
  const observation = { id: "screen-1", source: "full-screen", capturedAt: now, changed: true, imageBase64: "image", captureTarget: { title: "Editor" } };
  const preflight = { question: options.question ?? "Explain this API implementation.", focusedEvidenceSummary: options.focusedEvidenceSummary ?? "API code, lines 35 through 38.", questionType: options.screenType ?? "coding", confidence: 0.99 };
  const admissions = [];
  const runtime = new modules.RuntimeInferenceOperationRuntime("source-linkage-adjudication", {
    run: async (input) => { admissions.push(input); return input.execute(); },
  });
  const provider = { id: "fast", curl: "{{TEXT}}", variables: [] };
  const providerCalls = [];
  const env = {
    ...modules, console, Date, Error, Promise, AbortController, setTimeout, clearTimeout,
    shutdownRequestedRef: { current: false }, runtimeActiveRef: { current: true }, runtimeEpochRef: { current: 4 },
    manualCorrectionRevisionRef: { current: 0 }, visibleAnswerRevisionRef: { current: 1 }, responseActionRevisionRef: { current: 0 },
    logicalQuestionUnitRef: { current: unit }, awaitingVisualEvidenceRecoveryRef: { current: facts },
    activeAdvisorJobRef: { current: undefined }, activeAdvisorGenerationLeaseRef: { current: undefined },
    pendingAnswerRevisionRef: { current: undefined }, stableAnswerRevisionRef: { current: { logicalQuestionUnitId: unit.id, logicalQuestionRevision: unit.revision } },
    screenOperationCoordinatorRef: { current: new modules.ScreenOperationCoordinator() },
    rawZeroInputEpisodeRef: { current: { screenAdmitted() {} } },
    reportRawZeroProbe() {},
    screenAnalysisAbortRef: { current: null }, whiteboardSyntaxRepairRuntimeRef: { current: undefined },
    sourceLinkageAdjudicationRuntimeRef: { current: runtime },
    sourceLinkageAdjudicationCircuitRef: { current: new modules.RuntimeInferenceSessionCircuitBreaker() },
    meetingModelProviderSnapshotRef: { current: {
      providers: options.missingProvider ? [] : [provider], selectedProvider: { provider: "main", variables: {} },
      taxonomyAdjudicationProvider: { provider: "fast", variables: {} },
    } }, debugModeRef: { current: false },
    sessionRecordingManagerRef: { current: undefined }, currentQuestionSettlementRef: { current: undefined },
    preparationRuntimeContextRef: { current: {} }, effectiveQuestionSourceLedgerRef: { current: { findLogicalQuestion: () => undefined } },
    latestScreenHashRef: { current: undefined }, pendingInterviewTaskBoundaryRef: { current: undefined },
    generationResultLedgerRef: { current: { getEntry: () => undefined } },
    state: { status: "listening", settings: { useMemory: false } },
    aiProvider: { curl: "{{IMAGE}}" }, selectedAIProvider: {}, screenshotConfiguration: {}, SCREEN_PREFLIGHT_TIMEOUT_MS: 2000,
    contextManagerRef: { current: {
      getState: () => context, clearExpiredActiveMeetingTask: () => false,
      addScreenObservation: (value) => context.screenObservations.push(value),
    } },
    traceStoreRef: { current: {
      startTrace: (_kind, metadata) => { const trace = { id: `trace-${++serial}`, metadata, status: "running", steps: [] }; traces.push(trace); return trace; },
      updateMetadata: (id, metadata) => Object.assign(traces.find((trace) => trace.id === id).metadata, metadata),
      startStep: () => `step-${++serial}`, finishStep: () => {}, recordInput: () => {},
      recordOutput: (...args) => recordedOutputs.push(args),
      getTraces: () => traces,
      finishTrace: (id, status, error) => Object.assign(traces.find((trace) => trace.id === id), { status, error }),
    } },
    createMeetingId: (prefix) => `${prefix}-${++serial}`,
    setState: (update) => { env.state = update(env.state); },
    flushPendingSentenceCompletion: () => {},
    readRuntimeCommitSnapshot: () => ({ sessionId: context.sessionId, runtimeEpoch: env.runtimeEpochRef.current, manualCorrectionRevision: env.manualCorrectionRevisionRef.current }),
    settleAwaitingVisualEvidenceRecovery: (stage, reason, traceId, id) => {
      settlements.push({ stage, reason, id });
      for (const [owner, current] of facts) if (!id || current.id === id) facts.delete(owner);
    },
    captureScreenObservation: async () => ({ ...observation }),
    getMeetingScreenAutoPrompt: () => "",
    formatRecentTranscript: () => "",
    formatTraceMetadata: (value) => JSON.stringify(value),
    formatQuestionTypeTraceMetadata: () => ({}),
    resolvePreparationRuntimeReinforcement: () => ({}),
    preflightScreenObservation: async ({ onParsedResult }) => {
      options.afterPreflight?.(h);
      onParsedResult({ result: preflight, providerCompletedAt: Date.now(), parseCompletedAt: Date.now() });
      return preflight;
    },
    formatRuntimeInferenceModelRouteForTrace: () => ({}), formatRuntimeInferenceCircuitForTrace: () => ({}),
    formatRuntimeInferenceSharedAdmissionForTrace: () => ({}), formatRuntimeInferenceProviderOutcomeForTrace: () => ({}),
    readSelectedProviderModelId: () => "fast-model", readEffectiveSemanticTask: (task) => task,
    OPERATION: modules.getRuntimeInferenceOperationDefinition("source-linkage-adjudication"),
    requestRuntimeInferenceResponse: async (request) => {
      providerCalls.push(request);
      await options.duringModel?.(h);
      if (options.internalError) throw options.internalError;
      return {
        providerDisposition: options.providerDisposition ?? "completed-with-content",
        providerOutcome: options.providerOutcome,
        rawOutput: options.rawOutput ?? (options.invalid ? "invalid" : JSON.stringify({
          schemaVersion: 1, decision: options.decision ?? "bind-voice",
          voiceEvidenceSpans: [unit.normalizedText], screenEvidenceSpans: options.screenEvidenceSpans ?? [preflight.question],
        })),
        completedAt: Date.now(),
      };
    },
    visibleAnswerRevisionAfter: 2,
    consumePacket: (packet) => { packets.push(packet); options.onPacket?.(h, packet); return packet; },
  };
  if (options.explicit === "active") env.activeAdvisorJobRef.current = { id: "advisor", source: "live-turn", expectedSessionId: "session", runtimeCommitToken: { runtimeEpoch: 4 }, logicalQuestionUnit: unit };
  if (options.explicit === "pending") env.pendingAnswerRevisionRef.current = { operationId: "pending", advisorJobId: "advisor", advisorJobSource: "live-turn", lease: { id: "lease", sessionId: "session", runtimeEpoch: 4 }, logicalQuestionUnitId: unit.id, logicalQuestionRevision: unit.revision, suggestion: {} };
  env.cancelActiveAdvisorJob = () => { env.activeAdvisorJobRef.current = undefined; };
  env.terminalizeGenerationLease = () => {};
  env.clearPendingAnswerCommitTimer = () => {};
  env.answerDeliveryProgressRef = { current: undefined };
  env.toAnswerDeliveryPresentation = () => ({});
  // Task 178A: the real stream and the real Hook emit callbacks.
  const criticalEvents = createRuntimeCriticalEventHarness({ sessionId: context.sessionId });
  criticalEvents.install(env, (name) => evaluate(criticalEventCallbackSources[name], env));
  const adapter = evaluate(`(${requestAdapter.getText(requestSource).replace(/^export /, "")})`, env);
  env.requestSourceLinkageAdjudication = (input) => { calls.push(input); return adapter(input); };
  env.scheduleSourceLinkageAdjudication = evaluate(`(${callback("scheduleSourceLinkageAdjudication").getText(source)})`, env);
  const run = evaluate(`(${captureText})`, env);
  const h = { env, context, fact, facts, traces, calls, packets, settlements, unit, observation, run, runtime, providerCalls, admissions, recordedOutputs, criticalEvents };
  for (const name of ["normalizeParentQuestionType", "normalizeInterviewParentKind", "readMemoryQuestionType", "isTaskSwitchTranscript", "decideScreenTaskRelation"]) {
    env[name] = evaluate(`(${declaration(name).getText(source)})`, env);
  }
  h.boundRelation = (packet = packets[0]) => {
    const relationEnv = { ...env, ...packet, preflightContextState: context,
      taskKind: preflight.questionType, screenPreflight: preflight, screenRelationQuestion: packet.screenPrimaryAskEvidenceText,
      screenRelationSourceTask: context.activeMeetingTask, speechCorrectionsRef: { current: [] } };
    if (packet.boundVisualRecoveryRelation) context.taskRuntime.parent = context.activeMeetingTask.parent;
    return evaluate(`(${declaration("screenTaskRelationDecision", capture).initializer.getText(source)})`, relationEnv);
  };
  h.advisorInput = (packet = packets[0]) => {
    const currentQuestion = evaluate(`(${currentAskProperty.initializer.getText(source)})`, packet);
    const screenEvidencePacket = modules.buildAdvisorEvidencePacket({ currentQuestion });
    const env = { ...packet, screenEvidencePacket };
    const advisorEvidencePacket = evaluate(`(${solveProperty("advisorEvidencePacket")})`, env);
    return [modules.formatAdvisorEvidencePacketForPrompt(advisorEvidencePacket),
      evaluate(`(${solveProperty("recentTranscript")})`, env)].join("\n");
  };
  return h;
}

// Frozen dca83w sparse input. These tests inject outputs to check composition;
// revised-prompt model quality, real Preflight, and final answer quality remain pending.
const sparseRecovery = {
  voiceQuestion: "Explain lines 31-37",
  question: "Implement LRU cache",
  focusedEvidenceSummary: "Line 31: def get(self, key: int) -> int: in class LRUCache",
};

test("SL-E5 historical wrong use-screen remains parser-valid and overrides same-type fallback", async () => {
  const historicalDecision = {
    schemaVersion: 1,
    decision: "use-screen",
    voiceEvidenceSpans: [],
    screenEvidenceSpans: ["Implement LRU cache"],
    ambiguityReason: "The screen presents an independent instruction to implement an LRU cache, while the voice question asks to explain lines 31-37, which do not match.",
  };
  const h = harness({ ...sparseRecovery, rawOutput: JSON.stringify(historicalDecision) });
  await h.run();
  assert.deepEqual(JSON.parse(h.providerCalls[0].userMessage), {
    voiceQuestion: "Explain lines 31-37",
    screenQuestion: "Implement LRU cache",
    screenEvidenceSummary: "Line 31: def get(self, key: int) -> int: in class LRUCache Implement LRU cache",
  });
  const parsed = modules.parseSourceLinkageAdjudicationOutput(JSON.stringify(historicalDecision), h.calls[0].request);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.decision, "use-screen");
  assert.equal(modules.resolveSourceLinkageFallback({ voiceQuestionType: "coding", screenQuestionType: "coding" }), "bind-voice");
  assert.equal(h.traces[0].metadata.sourceLinkageDecision, "use-screen");
  assert.equal(h.traces[0].metadata.sourceLinkageEffectiveDecision, "use-screen");
  assert.equal(h.traces[0].metadata.sourceLinkageDecisionSource, "model");
  assert.equal(h.packets[0].screenPrimaryAskEvidenceText, "Implement LRU cache");
  assert.doesNotMatch(h.advisorInput(), /Explain lines 31-37/);
  assert.equal(h.settlements[0].reason, "source-linkage-use-screen");
});

for (const fixture of recordedLinkageOutputs) test(`SL-P4/P5/P6 recorded ${fixture.name} reaches the Advisor through the model decision`, async () => {
  const h = harness({
    voiceQuestion: fixture.voiceQuestion, question: fixture.screenQuestion,
    focusedEvidenceSummary: fixture.screenEvidenceSummary.slice(0, -fixture.screenQuestion.length).trim(),
    rawOutput: fixture.rawOutput,
  });
  await h.run();
  assert.deepEqual(JSON.parse(h.providerCalls[0].userMessage), {
    voiceQuestion: fixture.voiceQuestion, screenQuestion: fixture.screenQuestion,
    screenEvidenceSummary: fixture.screenEvidenceSummary,
  });
  const metadata = h.traces[0].metadata;
  assert.equal(metadata.sourceLinkageDecision, fixture.expectedDecision);
  assert.equal(metadata.sourceLinkageEffectiveDecision, fixture.expectedDecision);
  assert.equal(metadata.sourceLinkageDecisionSource, "model");
  assert.equal(metadata.sourceLinkageAppliedToRuntime, true);
  assert.equal(metadata.sourceLinkageParseValid, true);
  assert.equal(h.recordedOutputs.find((entry) => entry[1] === "source linkage adjudication raw output")?.[2], fixture.rawOutput);
  assert.equal(h.providerCalls.length, 1);
  assert.deepEqual({ ...h.providerCalls[0].requestOptions }, { timeoutMs: 2000, maxOutputTokens: 256 });
  const expectedAsk = fixture.expectedDecision === "bind-voice" ? fixture.voiceQuestion : fixture.screenQuestion;
  assert.equal(h.packets[0].screenPrimaryAskEvidenceText, expectedAsk);
  assert.ok(h.advisorInput().includes(expectedAsk));
  assert.equal(h.advisorInput().includes("screenEvidenceSummary"), false);
  if (fixture.expectedDecision === "use-screen") {
    assert.equal(h.advisorInput().includes(fixture.voiceQuestion), false);
    assert.equal(h.packets[0].screenSourcePacket.primaryAsk.source, "screen-preflight");
  } else {
    assert.equal(h.packets[0].screenRelationLogicalQuestionUnit.id, h.unit.id);
    assert.equal(h.packets[0].screenRelationLogicalQuestionUnit.revision, h.unit.revision);
  }
});

for (const revoke of [
  (h) => { h.env.runtimeEpochRef.current += 1; },
  (h) => h.runtime.cancelAll("superseded"),
]) test(`SL-P4 valid extra-field output cannot restore revoked operation: ${revoke}`, async () => {
  const fixture = recordedLinkageOutputs[0];
  const h = harness({ voiceQuestion: fixture.voiceQuestion, question: fixture.screenQuestion,
    focusedEvidenceSummary: fixture.screenEvidenceSummary, rawOutput: fixture.rawOutput,
    duringModel: revoke });
  await h.run();
  assert.equal(h.packets.length, 0);
  assert.equal(h.settlements.length, 0);
  assert.equal(h.traces[0].metadata.sourceLinkageAppliedToRuntime, false);
});

for (const [name, focusedEvidenceSummary] of [
  ["raw sparse signature", sparseRecovery.focusedEvidenceSummary],
  ["partial relevant focus", "Cursor/current-line highlight at line 31: def get(self, key: int) -> int: in LRUCache. The remaining body is cropped and unknown."],
]) test(`SL-E1/E2 supplied bind for ${name} preserves the exact ask without fulfilling recovery`, async () => {
  const h = harness({ ...sparseRecovery, focusedEvidenceSummary, screenEvidenceSpans: [focusedEvidenceSummary] });
  await h.run();
  assert.equal(h.providerCalls.length, 1);
  assert.deepEqual({ ...h.providerCalls[0].requestOptions }, { timeoutMs: 2000, maxOutputTokens: 256 });
  assert.equal(h.traces[0].metadata.sourceLinkageDecision, "bind-voice");
  assert.equal(h.traces[0].metadata.sourceLinkageEffectiveDecision, "bind-voice");
  assert.equal(h.traces[0].metadata.sourceLinkageDecisionSource, "model");
  assert.equal(h.packets[0].screenRelationLogicalQuestionUnit.id, h.unit.id);
  assert.equal(h.packets[0].screenRelationLogicalQuestionUnit.revision, h.unit.revision);
  assert.equal(h.packets[0].screenPrimaryAskEvidenceText, "Explain lines 31-37");
  assert.equal(h.boundRelation().relation, "followup-parent");
  assert.match(h.advisorInput(), /Explain lines 31-37/);
  assert.equal(h.settlements.length, 0);
  assert.equal(h.facts.size, 1);
});

for (const [name, screenType, question, focusedEvidenceSummary] of [
  ["same-type new task", "coding", "Solve Two Sum", "New task: return indices of two numbers that sum to the target."],
  ["different-type new task", "behavioral", "Tell me about a time you disagreed with a teammate.", "A behavioral interview question; no code is visible."],
  ["coincident line numbers on an explicitly different object", "coding", "Explain lines 31-37 in mergeSort, not LRUCache", "Cursor at line 31: def mergeSort(nums). New request explicitly names mergeSort instead of LRUCache."],
]) test(`SL-E3 supplied use-screen for ${name} excludes the old Voice request`, async () => {
  const h = harness({ ...sparseRecovery, voiceQuestion: "Explain lines 31-37 in LRUCache", screenType, question, focusedEvidenceSummary, decision: "use-screen", screenEvidenceSpans: [focusedEvidenceSummary] });
  await h.run();
  assert.equal(h.traces[0].metadata.sourceLinkageDecision, "use-screen");
  assert.equal(h.traces[0].metadata.sourceLinkageEffectiveDecision, "use-screen");
  assert.equal(h.traces[0].metadata.sourceLinkageDecisionSource, "model");
  assert.equal(h.packets[0].screenSourcePacket.primaryAsk.source, "screen-preflight");
  assert.equal(h.packets[0].screenPrimaryAskEvidenceText, question);
  assert.doesNotMatch(h.advisorInput(), /Explain lines 31-37 in LRUCache|turn-original/);
});

for (const [screenType, effectiveDecision] of [["coding", "bind-voice"], ["unknown", "bind-voice"], ["behavioral", "use-screen"]]) {
  test(`SL-E3 partial unidentified evidence keeps raw unclear separate from ${screenType} fallback`, async () => {
    const h = harness({
      ...sparseRecovery, screenType, question: "Unidentified content",
      focusedEvidenceSummary: "A cropped fragment is visible; object identifiers and focus location are unreadable.",
      decision: "unclear",
    });
    await h.run();
    assert.equal(h.traces[0].metadata.sourceLinkageDecision, "unclear");
    assert.equal(h.traces[0].metadata.sourceLinkageEffectiveDecision, effectiveDecision);
    assert.equal(h.traces[0].metadata.sourceLinkageDecisionSource, "type-fallback");
    assert.equal(h.packets[0].screenSourcePacket.primaryAsk.source, effectiveDecision === "bind-voice" ? "voice-lqu" : "screen-preflight");
  });
}

test("SL-C1/C6 actual Screen ingress compares once with debug and recording off before Voice packet binding", async () => {
  const h = harness();
  await h.run();
  assert.equal(h.calls.length, 1, JSON.stringify(h.traces));
  assert.equal(h.calls[0].request.voiceQuestion, h.unit.normalizedText);
  assert.equal(h.calls[0].request.screenObservationId, "screen-1");
  assert.equal(h.calls[0].provider.id, "fast");
  assert.equal(h.packets[0].screenSourcePacket.primaryAsk.text, h.unit.normalizedText);
  assert.equal(h.packets[0].screenRelationLogicalQuestionUnit.id, h.unit.id);
  assert.equal(h.packets[0].screenRelationLogicalQuestionUnit.revision, h.unit.revision);
  assert.equal(h.packets[0].boundVisualRecoveryRelation, "followup-parent");
  assert.equal(h.settlements.length, 0);
  assert.equal(h.boundRelation().relation, "followup-parent");
  assert.match(h.advisorInput(), /Explain lines 35 through 38\./);
  assert.equal(h.admissions[0].lane, "critical");
  assert.equal(h.admissions[0].providerTier, "fast");
  assert.deepEqual({ ...h.providerCalls[0].requestOptions }, { timeoutMs: 2000, maxOutputTokens: 256 });
  assert.equal(typeof h.traces[0].metadata.sourceLinkageQueueWaitMs, "number");
  assert.equal(typeof h.traces[0].metadata.sourceLinkageDurationMs, "number");
});

for (const screenType of ["coding", "behavioral"]) {
  test(`SL-C2 valid model use-screen wins for independent ${screenType} screenshot`, async () => {
    const h = harness({ screenType, decision: "use-screen", question: "Solve this independent task." });
    await h.run();
    assert.equal(h.calls.length, 1);
    assert.equal(h.packets[0].screenSourcePacket.primaryAsk.source, "screen-preflight");
    assert.equal(h.packets[0].screenPrimaryAskEvidenceText, "Solve this independent task.");
    assert.doesNotMatch(JSON.stringify(h.packets[0].screenTranscriptContext), /lines 35|turn-original/);
    assert.equal(h.packets[0].boundVisualRecoveryRelation, undefined);
    assert.equal(h.traces[0].metadata.sourceLinkageDecisionSource, "model");
    assert.match(h.advisorInput(), /Solve this independent task\./);
    assert.doesNotMatch(h.advisorInput(), /lines 35|turn-original/);
  });
}
for (const failure of [{ decision: "unclear" }, { invalid: true }, { providerDisposition: "provider-error-content", providerOutcome: { status: "timed-out" } }]) {
  for (const [voiceType, screenType, owner] of [
    ["coding", "coding", "voice-lqu"], ["coding", "behavioral", "screen-preflight"],
    ["unknown", "coding", "voice-lqu"], ["coding", "unknown", "voice-lqu"],
  ]) test(`SL-C2 fallback ${JSON.stringify(failure)} ${voiceType}/${screenType}`, async () => {
    const h = harness({ ...failure, fact: { questionType: voiceType }, screenType });
    await h.run();
    assert.equal(h.calls.length, 1);
    assert.equal(h.packets[0].screenSourcePacket.primaryAsk.source, owner);
    assert.equal(h.traces[0].metadata.sourceLinkageDecisionSource, "type-fallback");
  });
}
test("SL-C2 valid model bind wins over distinct-type fallback", async () => {
  const h = harness({ screenType: "behavioral" });
  await h.run();
  assert.equal(h.packets[0].screenSourcePacket.primaryAsk.source, "voice-lqu");
  assert.equal(h.traces[0].metadata.sourceLinkageDecisionSource, "model");
});

for (const revoke of [
  (h) => h.facts.clear(),
  (h) => { h.context.activeMeetingTask = undefined; },
  (h) => { h.fact.expiresAt = 0; },
]) test(`SL-C3 preflight removes request-time capsule: ${revoke}`, async () => {
  const h = harness({ afterPreflight: revoke });
  await h.run();
  assert.equal(h.calls.length, 0);
  assert.equal(h.packets[0].screenSourcePacket.primaryAsk.source, "screen-preflight");
  assert.equal(h.packets[0].screenExactVisualEvidenceRecovery, false);
});
for (const decision of ["bind-voice", "unclear"]) {
  test(`SL-C3 source revoked during ${decision} comparison continues Screen without fallback`, async () => {
    const h = harness({ decision, duringModel: (h) => h.facts.clear() });
    await h.run();
    assert.equal(h.packets[0].screenSourcePacket.primaryAsk.source, "screen-preflight");
    assert.equal(h.traces[0].metadata.sourceLinkageAppliedToRuntime, false);
    assert.equal(h.traces[0].metadata.sourceLinkageDecisionSource, "source-revoked");
    assert.equal(h.settlements.length, 0);
  });
  for (const revoke of [
    (h) => { h.env.runtimeEpochRef.current += 1; },
    (h) => { h.env.manualCorrectionRevisionRef.current += 1; },
    (h) => { h.context.sessionId = "cleared-session"; h.facts.clear(); },
    (h) => h.env.screenOperationCoordinatorRef.current.claim("new-screen"),
    (h) => h.runtime.cancelAll("superseded"),
  ]) test(`SL-C3 revoked operation never applies ${decision}: ${revoke}`, async () => {
    const h = harness({ decision, duringModel: revoke });
    await h.run();
    assert.equal(h.packets.length, 0, JSON.stringify(h.traces));
    assert.equal(h.settlements.length, 0);
    assert.equal(h.traces[0].metadata.sourceLinkageAppliedToRuntime, false);
  });
}
for (const [child, fact, relation] of [
  ["coding", { ownerKind: "child", ownerBranchId: "child" }, "child-probe"],
  ["field-knowledge", {}, "resume-parent"],
]) test(`SL-C4 bound source deterministically consumes ${relation}`, async () => {
  const h = harness({ child, fact });
  await h.run();
  assert.equal(h.boundRelation().relation, relation);
  assert.equal(h.context.activeMeetingTask.parent.id, "parent");
  assert.equal(h.context.activeMeetingTask.child.id, "child");
  assert.equal(h.packets[0].screenRelationLogicalQuestionUnit.id, h.unit.id);
});
test("SL-C4 parentless recovery does not invent a durable bound relation", async () => {
  const h = harness({ parentless: true });
  await h.run();
  assert.equal(h.packets[0].screenSourcePacket.primaryAsk.source, "voice-lqu");
  assert.equal(h.packets[0].boundVisualRecoveryRelation, undefined);
});
for (const explicit of [undefined, "active", "pending"]) test(`SL-C4 no redundant comparison: ${explicit ?? "no opportunity"}`, async () => {
  const h = harness({ explicit, noOpportunity: !explicit });
  await h.run();
  assert.equal(h.calls.length, 0, JSON.stringify(h.traces));
  assert.equal(h.packets[0].screenSourcePacket.primaryAsk.source, explicit ? "voice-lqu" : "screen-preflight");
});

test("SL-C5 production visible commit consumes the bound fact only on success", async () => {
  const h = harness({ onPacket: (h, packet) => {
    packet.commitVisible(false);
    assert.equal(h.settlements.length, 0);
    assert.equal(packet.checkAfterModel(), false);
    packet.commitVisible(true);
    assert.deepEqual(h.settlements, [{ stage: "consumed", reason: "bound-screen-answer-visible-committed", id: h.fact.id }]);
    packet.commitVisible(true);
    assert.equal(h.settlements.length, 1);
  } });
  await h.run();
  assert.equal(h.settlements.length, 1, JSON.stringify(h.traces));
});
for (const revoke of [
  (h) => h.facts.clear(),
  (h) => { h.context.activeMeetingTask = undefined; },
  (h) => h.facts.set(h.fact.ownerBranchId, { ...h.fact, id: "replacement-fact" }),
  (h) => h.facts.set(h.fact.ownerBranchId, { ...h.fact, sourceHash: "corrected" }),
]) test(`SL-C5 late answer cannot retroactively claim recovery: ${revoke}`, async () => {
  const h = harness();
  await h.run();
  revoke(h);
  assert.equal(h.packets[0].checkAfterModel(), true);
  h.packets[0].commitVisible(true);
  assert.equal(h.settlements.length, 0);
});
for (const failure of [
  { missingProvider: true }, { providerDisposition: "provider-auth-error" }, { internalError: new Error("internal contract failure") },
]) test(`SL-C5 client/internal error is explicit and never semantic fallback: ${JSON.stringify(failure)}`, async () => {
  const h = harness(failure);
  await h.run();
  assert.equal(h.packets.length, 0);
  assert.equal(h.traces[0].status, "error");
  assert.match(h.env.state.error, /provider|contract failure/);
  assert.equal(h.traces[0].metadata.sourceLinkageDecisionSource, undefined);
  assert.equal(h.settlements.length, 0);
});
test("SL-C6 retained birth epoch 7 binds through current work epoch 8 with exact Voice identity", async () => {
  const h = harness({ fact: { runtimeEpoch: 7 } });
  h.env.runtimeEpochRef.current = 8;
  h.unit.runtimeEpoch = 7;
  await h.run();
  assert.equal(h.calls.length, 1, JSON.stringify(h.traces));
  assert.equal(h.calls[0].request.voiceSourceHash, h.fact.sourceHash);
  assert.equal(h.calls[0].executionIdentity.runtimeEpoch, 8);
  assert.equal(h.packets[0].screenRelationLogicalQuestionUnit.id, h.fact.logicalQuestionUnitId);
  assert.equal(h.packets[0].screenRelationLogicalQuestionUnit.revision, h.fact.logicalQuestionRevision);
  assert.equal(h.packets[0].screenRelationLogicalQuestionUnit.runtimeEpoch, 7);
  assert.equal(h.fact.runtimeEpoch, 7);
  assert.equal(h.fact.sourceHash, "original-source-hash");
  assert.equal(h.admissions[0].operationId.includes(":session:8:"), true);
  assert.equal(h.calls[0].request.sourceSettlementId, "voice-settlement");
  assert.equal(h.packets[0].screenSourcePacket.visualEvidence.screenObservationId, "screen-1");
});
test("SL-C6 future-born recovery never starts a model call", async () => {
  const h = harness({ fact: { runtimeEpoch: 9 } });
  h.env.runtimeEpochRef.current = 8;
  await h.run();
  assert.equal(h.calls.length, 0);
  assert.equal(h.packets[0].screenSourcePacket.primaryAsk.source, "screen-preflight");
});

test("SL-C6 the same Screen/LQU slot cannot start a second model request", async () => {
  const h = harness();
  await h.run();
  await h.run();
  assert.equal(h.calls.length, 1);
  assert.equal(h.traces[1].metadata.sourceLinkageDisposition, "budget-exhausted");
});
test("SL-C3 a newer real Screen entry owns the only packet after the old model resolves late", async () => {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const h = harness({ duringModel: async (h) => {
    if (h.calls.length === 1) { started(); await blocked; }
  } });
  const old = h.run();
  await startedPromise;
  h.observation.id = "screen-newer";
  const newer = h.run();
  release();
  await Promise.all([old, newer]);
  assert.equal(h.calls.length, 2);
  assert.equal(h.packets.length, 1, JSON.stringify(h.traces));
  assert.equal(h.packets[0].screenSourcePacket.visualEvidence.screenObservationId, "screen-newer");
  assert.equal(h.traces[0].metadata.sourceLinkageAppliedToRuntime, false);
  assert.equal(h.settlements.length, 0);
});
for (const revoke of [
  (h) => { h.unit.revision += 1; },
  (h) => h.facts.set(h.fact.ownerBranchId, { ...h.fact, sourceHash: "new-source-hash" }),
  (h) => h.facts.set(h.fact.ownerBranchId, { ...h.fact, expiresAt: h.fact.expiresAt + 1000 }),
  (h) => h.facts.set(h.fact.ownerBranchId, { ...h.fact, sourceTurnIds: ["replacement-turn"] }),
]) test(`SL-C3 exact source cannot be replaced during comparison: ${revoke}`, async () => {
  const h = harness({ duringModel: revoke });
  await h.run();
  assert.equal(h.calls.length, 1);
  assert.equal(h.packets[0].screenSourcePacket.primaryAsk.source, "screen-preflight");
  assert.equal(h.traces[0].metadata.sourceLinkageDecisionSource, "source-revoked");
});
test("SL-C5 an original candidate must remain current at final visible consume", async () => {
  const h = harness({ onPacket: (h, packet) => {
    assert.equal(packet.checkAfterModel(), false);
    h.facts.clear();
    assert.equal(packet.checkAfterModel(), true);
    packet.commitVisible(true);
  } });
  await h.run();
  assert.equal(h.settlements.length, 0);
  assert.equal(h.traces[0].metadata.sourceLinkageBoundSourceStillCurrent, false);
});

// ===========================================================================
// Task 178A (AE1, AE2): the Screen entry through the real captureScreenContext.
// The event stream lives in the harness's vm realm; plain copies are compared.
// ===========================================================================
const aePlain = (value) => JSON.parse(JSON.stringify(value));
const aeFacts = (h) => aePlain(h.criticalEvents.facts());
const aeEvents = (h) => aePlain(h.criticalEvents.events());

test("Screen authorization checks preserve actual model outcome until a real rejection", () => {
  const receipt = { sourceResult: { candidate: { id: "transition", state: "committed" } },
    runtimeResult: { authorized: true, mutationApplied: true } };
  const trace = { id: "screen", status: "running", steps: [], metadata: {} };
  const current = { sessionId: "session", runtimeEpoch: 1 };
  const token = modules.createRuntimeCommitToken({ operationId: "screen-op", pipeline: "screen", snapshot: current });
  let authorized = true;
  const env = { ...modules,
    readScreenAuthorization: () => modules.authorizeRuntimeCommit({ token, current, currentOperationId: authorized ? "screen-op" : "new-screen" }),
    boundVisualRecoveryFact: undefined, screenGenerationLease: undefined,
    contextManagerRef: { current: { getState: () => ({ sessionId: "session" }) } },
    screenSourceOwnedTransitionReceipt: receipt,
    screenOperationCoordinatorRef: { current: { getActiveOperationId: () => "new-screen", getActiveOperation: () => undefined } },
    trace, traceStoreRef: { current: {
      updateMetadata: (_id, metadata) => Object.assign(trace.metadata, metadata),
      getTraces: () => [trace], finishTrace: (_id, status) => { trace.status = status; },
    } },
    screenRuntimeToken: { expectedSessionId: "session", runtimeEpoch: 1 },
    screenOperationId: "screen-op", screenTerminalError: undefined, screenModelCompletedAt: 1,
    emitRuntimeCriticalEvent() {}, recordScreenQuestionTypeOutcome() {},
  };
  const check = evaluate(`(${declaration("rejectStaleScreenOperation", capture).initializer.getText(source)})`, env);
  for (const outcome of [undefined, "success", "empty-output", "error", "cancelled"]) {
    trace.metadata = outcome ? modules.formatSourceOwnedDurableTransitionForTrace(receipt, {
      modelOutcome: outcome, survivedModelOutcome: outcome !== "success",
    }) : {};
    for (const stage of ["post-capture", "post-model", "pre-visible-commit"]) {
      const before = [trace.metadata.sourceTransitionModelOutcome, trace.metadata.sourceTransitionSurvivedModelOutcome];
      assert.equal(check(stage), false);
      assert.deepEqual([trace.metadata.sourceTransitionModelOutcome, trace.metadata.sourceTransitionSurvivedModelOutcome], before);
    }
  }
  authorized = false;
  assert.equal(check("post-model"), true);
  assert.equal(trace.metadata.sourceTransitionModelOutcome, "stale-result");
  assert.equal(trace.metadata.sourceTransitionSurvivedModelOutcome, true);
  assert.equal(trace.status, "cancelled");
});

test("AE1 Screen entry: accepted where the real source operation is claimed, with the operation's own identity and no Voice turn or LQU fact", async () => {
  const h = harness();
  await h.run();
  const events = aeEvents(h);
  const accepted = events.filter((event) => event.fact === "input-accepted");
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].stage, "screen-operation-claimed");
  assert.equal(accepted[0].sequence, 1, "the acceptance is the first fact of the operation");
  assert.equal(accepted[0].runtimeSessionId, "session");
  assert.equal(accepted[0].runtimeEpoch, 4, "stamped from the operation's own commit token");
  assert.deepEqual(accepted[0].refs, {
    traceId: h.traces[0].id, operationId: h.traces[0].metadata.screenOperationId,
    operationKind: "screen-operation", sourceKind: "screen", transport: "capture",
  });
  // The bound Voice question is a candidate of this operation, not a commit of it.
  assert.equal(events.some((event) => event.fact === "lqu-committed"), false, "Screen never commits a session LQU");
  assert.equal(events.some((event) => event.refs.turnId !== undefined), false, "no Voice turn is forged");
  assert.equal(JSON.stringify(events).includes("lines 35"), false, "no question text travels in an event");
  // The operation ended as the owner of its slot: its own explicit terminal.
  const terminal = events.filter((event) => event.fact === "terminal");
  assert.deepEqual(terminal.map((event) => [event.terminal.object, event.terminal.disposition, event.refs.operationId]),
    [["screen-operation", "released", accepted[0].refs.operationId]]);
  // This harness returns from the flow at its packet consumer, before the
  // flow's last statement. Only a flow that ran to its end ends with no reason.
  assert.deepEqual(terminal[0].terminal, { object: "screen-operation", disposition: "released", reason: "cancelled" },
    "a flow that left after its capture without an error and without reaching its end");
});

test("AE2 Screen entry: a capture that fails, a capture that is aborted, an error after the capture and a cancellation after the capture each end the operation with its own reason; none of them is the terminal of a completed operation", async () => {
  const ended = async (arrange) => {
    const h = harness();
    arrange(h);
    let thrown;
    await h.run().catch((error) => { thrown = error; });
    assert.equal(thrown, undefined, "the Screen entry handles its own failure");
    const events = aeEvents(h);
    const terminals = events.filter((event) => event.fact === "terminal");
    assert.equal(terminals.length, 1, JSON.stringify(aeFacts(h)));
    assert.equal(terminals[0].refs.operationId, events.find((event) => event.fact === "input-accepted").refs.operationId);
    return { h, facts: aeFacts(h), terminal: terminals[0].terminal, trace: h.traces[0] };
  };
  // The capture command fails: accepted, then released with the failure named. No other fact.
  const failed = await ended((h) => { h.env.captureScreenObservation = async () => { throw new Error("capture command failed"); }; });
  assert.deepEqual(failed.terminal, { object: "screen-operation", disposition: "released", reason: "capture-failed" });
  assert.equal(failed.facts.length, 2, JSON.stringify(failed.facts));
  assert.deepEqual([failed.trace.status, failed.trace.error?.message], ["error", "capture command failed"],
    "the owner's own error exit is unchanged");
  assert.equal(failed.h.packets.length, 0);
  assert.equal(JSON.stringify(aeEvents(failed.h)).includes("capture command failed"), false, "the message stays out of the event");
  // The capture is aborted before it returns: no observation, and no error to show.
  const aborted = await ended((h) => { h.env.captureScreenObservation = async () => {
    throw Object.assign(new Error("aborted"), { name: "AbortError" }); }; });
  assert.deepEqual(aborted.terminal, { object: "screen-operation", disposition: "released", reason: "capture-not-completed" });
  assert.equal(aborted.facts.length, 2);
  assert.equal(aborted.trace.status, "cancelled");
  // The capture succeeded and the operation then failed in its own flow.
  const later = await ended((h) => { h.env.contextManagerRef.current.addScreenObservation = () => { throw new Error("observation store failed"); }; });
  assert.deepEqual(later.terminal, { object: "screen-operation", disposition: "released", reason: "operation-error" });
  assert.deepEqual([later.trace.status, later.trace.error?.message], ["error", "observation store failed"]);
  // The capture succeeded and the flow was then cancelled (an abort, as Pause
  // delivers it to a request in flight): no error to show, and not a completed flow.
  const cancelled = await ended((h) => { h.env.contextManagerRef.current.addScreenObservation = () => {
    throw Object.assign(new Error("aborted"), { name: "AbortError" }); }; });
  assert.deepEqual(cancelled.terminal, { object: "screen-operation", disposition: "released", reason: "cancelled" });
  assert.equal(cancelled.trace.status, "cancelled");
  assert.equal(cancelled.h.env.state?.error ?? null, null, "a cancellation shows no error");
});

test("AE2 Screen entry: a shutdown return reaches no claim and emits nothing; a superseded operation ends with its own superseded terminal and never a release", async () => {
  const stopped = harness();
  stopped.env.shutdownRequestedRef.current = true;
  await stopped.run();
  assert.equal(stopped.traces.length, 0);
  assert.deepEqual(aeFacts(stopped), []);

  // The first operation is inside its source-linkage model call when a newer
  // real entry claims the slot (the SL-C3 arrangement).
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const h = harness({ duringModel: async (running) => {
    if (running.calls.length === 1) { started(); await blocked; }
  } });
  const old = h.run();
  await startedPromise;
  h.observation.id = "screen-newer";
  const newerRun = h.run();
  release();
  await Promise.all([old, newerRun]);
  const events = aeEvents(h);
  const accepted = events.filter((event) => event.fact === "input-accepted");
  assert.equal(accepted.length, 2, "each real entry is accepted once");
  const [older, newer] = accepted.map((event) => event.refs.operationId);
  assert.notEqual(older, newer);
  const terminals = events.filter((event) => event.fact === "terminal" && event.terminal.object === "screen-operation");
  assert.deepEqual(terminals.map((event) => [event.refs.operationId, event.terminal.disposition]).sort(),
    [[newer, "released"], [older, "superseded"]].sort());
  assert.equal(h.packets.length, 1, "only the newer operation reached its consumer");
});
