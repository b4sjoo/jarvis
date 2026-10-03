import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { inspect } from "node:util";
import vm from "node:vm";

const root = process.cwd();
const repoRequire = createRequire(path.join(root, "package.json"));
const ts = repoRequire("typescript");
const hookSource = readFileSync(
  path.join(root, "src/hooks/useMeetingAssistant.ts"),
  "utf8"
);

const parse = (source) =>
  ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);
const sourceFile = parse(hookSource);

function findNamedDeclaration(file, name) {
  let found;
  const visit = (node) => {
    if (
      (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name?.getText(file) === name
    ) {
      found = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(found, `missing ${name}`);
  return found;
}

function findDescendant(node, predicate) {
  let found;
  const visit = (candidate) => {
    if (!found && predicate(candidate)) found = candidate;
    if (!found) ts.forEachChild(candidate, visit);
  };
  visit(node);
  assert.ok(found, "missing expected production branch");
  return found;
}

const callbackNames = [
  "scheduleTaskRelationSplitRuntime",
  "scheduleTaskRelationAdjudication",
  "scheduleAdvisorAfterQuestionTypeWindow",
];
const callbackSources = callbackNames.map((name) => {
  const declaration = findNamedDeclaration(sourceFile, name);
  assert.ok(declaration.initializer && ts.isCallExpression(declaration.initializer));
  return declaration.initializer.arguments[0].getText(sourceFile);
});
// The Hook's own binding of the shared Ordered operation, so the harness runs
// with exactly the dependencies production injects.
const orderedOperationBindingSource = findNamedDeclaration(
  sourceFile,
  "resolveOrderedTaskRelationWithinWindow"
).initializer.arguments[0].getText(sourceFile);
const finalizeOwnedScreenOperationSource = findNamedDeclaration(
  sourceFile,
  "finalizeOwnedScreenOperation"
).initializer.getText(sourceFile);
const typeCorrectionDeclaration = findNamedDeclaration(
  sourceFile,
  "correctActiveQuestionType"
);
const finalizeCorrectionSource = findNamedDeclaration(
  sourceFile,
  "finalizeCorrection"
).initializer.getText(sourceFile);
const typeCorrectionIntentTerminalSource = findDescendant(
  typeCorrectionDeclaration,
  (node) =>
    ts.isIfStatement(node) &&
    node.expression
      .getText(sourceFile)
      .includes('!correctionIntentTransition.authorized')
).getText(sourceFile);
const termCorrectionDeclaration = findNamedDeclaration(
  sourceFile,
  "submitSpeechCorrection"
);
const termCorrectionRelationTerminalSource = findDescendant(
  termCorrectionDeclaration,
  (node) =>
    ts.isIfStatement(node) &&
    node.expression
      .getText(sourceFile)
      .includes('relationResolution.terminalDisposition !== "resolved"')
).getText(sourceFile);
const termCorrectionAdvisorGateSource = findDescendant(
  termCorrectionDeclaration,
  (node) =>
    ts.isIfStatement(node) &&
    node.expression.getText(sourceFile) === "correctionRelationTerminal" &&
    node.getText(sourceFile).includes("await runAdvisor")
).getText(sourceFile);
const captureScreenDeclaration = findNamedDeclaration(
  sourceFile,
  "captureScreenContext"
);
const readScreenAuthorizationSource = findNamedDeclaration(
  sourceFile,
  "readScreenAuthorization"
).initializer.getText(sourceFile);
const rejectStaleScreenOperationSource = findNamedDeclaration(
  sourceFile,
  "rejectStaleScreenOperation"
).initializer.getText(sourceFile);
const clearScreenStagedPartialSource = findNamedDeclaration(
  sourceFile,
  "clearScreenStagedPartial"
).initializer.getText(sourceFile);
const postModelScreenStaleGuardSource = findDescendant(
  captureScreenDeclaration,
  (node) =>
    ts.isIfStatement(node) &&
    node.expression.getText(sourceFile) ===
      'rejectStaleScreenOperation("post-model")'
).getText(sourceFile);
const captureScreenFinallySource = findDescendant(
  captureScreenDeclaration,
  (node) =>
    ts.isTryStatement(node) &&
    Boolean(node.finallyBlock) &&
    node.finallyBlock
      .getText(sourceFile)
      .includes("screenOperationCoordinatorRef.current.release(screenOperationId)")
).finallyBlock.getText(sourceFile);
const runAdvisorDeclaration = findNamedDeclaration(sourceFile, "runAdvisor");
const advisorScreenSourceReadDeclaration = findDescendant(
  runAdvisorDeclaration,
  (node) =>
    ts.isVariableDeclaration(node) &&
    node.name.getText(sourceFile) === "advisorScreenSourceRead"
);
const advisorScreenSourceReadSource =
  advisorScreenSourceReadDeclaration.initializer.getText(sourceFile);
const advisorStreamSuggestionCall = findDescendant(
  runAdvisorDeclaration,
  (node) =>
    ts.isCallExpression(node) &&
    node.expression
      .getText(sourceFile)
      .includes("advisorEngineRef.current.streamSuggestion")
);
const advisorStreamRequest = advisorStreamSuggestionCall.arguments[0];
assert.ok(ts.isObjectLiteralExpression(advisorStreamRequest));
const advisorStreamRequestProperty = (name) => {
  const property = advisorStreamRequest.properties.find(
    (candidate) =>
      ts.isPropertyAssignment(candidate) &&
      candidate.name.getText(sourceFile) === name
  );
  assert.ok(property, `missing Advisor stream request property ${name}`);
  return property.initializer.getText(sourceFile);
};
const advisorStreamModeSource = advisorStreamRequestProperty("mode");
const advisorStreamResponseActionSource =
  advisorStreamRequestProperty("responseAction");
const advisorStreamSourceImagesSource =
  advisorStreamRequestProperty("sourceImages");

const identifiers = new Set();
for (const source of [
  ...callbackSources,
  orderedOperationBindingSource,
  readScreenAuthorizationSource,
  rejectStaleScreenOperationSource,
  clearScreenStagedPartialSource,
  finalizeCorrectionSource,
]) {
  const file = parse(source);
  const visit = (node) => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
}
for (const name of [
  "buildRuntimeCommitSnapshot",
  "createRuntimeCommitToken",
  "createAnswerGenerationLease",
]) {
  identifiers.add(name);
}

const imports = {};
const { resolveOrderedTaskRelationWithinWindow } = await import(pathToFileURL(
  path.join(root, '.tmp-tests/src/lib/meeting/ordered-relation-operation.js')));
for (const node of sourceFile.statements) {
  if (!ts.isImportDeclaration(node)) continue;
  const moduleName = node.moduleSpecifier.text;
  const bindings =
    node.importClause?.namedBindings?.elements?.filter(
      (element) => identifiers.has(element.name.text) && !element.isTypeOnly
    ) ?? [];
  if (!bindings.length || !moduleName.startsWith("@/")) continue;
  const file = path.join(
    root,
    ".tmp-tests",
    "src",
    `${moduleName.slice(2)}.js`
  );
  try {
    const loaded = await import(pathToFileURL(file));
    for (const binding of bindings) {
      const exported = loaded[binding.propertyName?.text ?? binding.name.text];
      if (exported) imports[binding.name.text] = exported;
    }
  } catch {
    // The meeting barrel is resolved below into its concrete compiled modules.
  }
}
for (const moduleName of [
  "logical-question-ownership",
  "question-type-adjudication",
  "task-relation-adjudication",
  "task-relation-split-shadow",
  "task-taxonomy",
  "runtime-inference-runtime",
  "answer-generation-lease",
  "current-question-settlement",
  "relation-decision-provenance",
  "ordered-settlement-coordinator",
  "meeting-model-route",
  "runtime-inference",
  "runtime-inference-response",
  "runtime-inference-provider-admission",
  "response-opportunity-generation-gate",
  "runtime-commit-authorization",
  "source-owned-transition-runtime",
  "stable-answer",
  "manual-question-type-correction",
  "suggestion-task",
]) {
  const loaded = await import(
    pathToFileURL(
      path.join(root, ".tmp-tests", "src", "lib", "meeting", `${moduleName}.js`)
    )
  );
  for (const [key, value] of Object.entries(loaded)) {
    if (identifiers.has(key)) imports[key] = value;
  }
}

const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;

const relationModule = await import(
  pathToFileURL(
    path.join(
      root,
      ".tmp-tests",
      "src",
      "lib",
      "meeting",
      "task-relation-adjudication.js"
    )
  )
);
const splitModule = await import(
  pathToFileURL(
    path.join(
      root,
      ".tmp-tests",
      "src",
      "lib",
      "meeting",
      "task-relation-split-shadow.js"
    )
  )
);
const runtimeModule = await import(
  pathToFileURL(
    path.join(
      root,
      ".tmp-tests",
      "src",
      "lib",
      "meeting",
      "runtime-inference-runtime.js"
    )
  )
);
const admissionModule = await import(pathToFileURL(path.join(root, ".tmp-tests", "src", "lib", "meeting", "runtime-inference-provider-admission.js")));
const { ScreenOperationCoordinator } = await import(
  pathToFileURL(
    path.join(
      root,
      ".tmp-tests",
      "src",
      "lib",
      "meeting",
      "screen-operation-coordinator.js"
    )
  )
);
const screenScopeModule = await import(
  pathToFileURL(
    path.join(
      root,
      ".tmp-tests",
      "src",
      "lib",
      "meeting",
      "screen-task-scope.js"
    )
  )
);
const advisorPromptModule = await import(
  pathToFileURL(
    path.join(
      root,
      ".tmp-tests",
      "src",
      "lib",
      "meeting",
      "advisor-prompt.js"
    )
  )
);

class Clock {
  now = 10_000;
  sequence = 0;
  timers = new Map();

  setTimeout = (callback, delay) => {
    const id = ++this.sequence;
    this.timers.set(id, {
      callback,
      at: this.now + Math.max(0, delay),
    });
    return id;
  };

  clearTimeout = (id) => this.timers.delete(id);

  async flush() {
    for (let index = 0; index < 40; index += 1) await Promise.resolve();
  }

  async advanceTo(offset) {
    const end = 10_000 + offset;
    await this.flush();
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort(([leftId, left], [rightId, right]) =>
          left.at === right.at ? leftId - rightId : left.at - right.at
        )[0];
      if (!next) break;
      const [id, timer] = next;
      this.now = Math.max(this.now, timer.at);
      this.timers.delete(id);
      timer.callback();
      await this.flush();
    }
    this.now = end;
    await this.flush();
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

// Observes a Promise without deciding anything; it also marks it handled.
const watch = (h, promise) => {
  const seen = { state: "pending" };
  promise.then(
    (value) => Object.assign(seen, { state: "resolved", value, at: h.clock.now - 10_000 }),
    (error) => Object.assign(seen, { state: "rejected", error, at: h.clock.now - 10_000 }));
  return seen;
};
// A stage terminal, or the result of a consumer that waits for one, is read only
// once it has settled. A terminal that was wrongly left open then fails the test
// that reads it, by name, instead of leaving an await pending, which would
// cancel every test after it in this file.
async function settledValue(h, promise, what) {
  const seen = watch(h, promise);
  await h.clock.flush();
  assert.notEqual(seen.state, "pending", `${what} is still pending`);
  if (seen.state === "rejected") throw seen.error;
  return seen.value;
}

const logicalQuestionUnit = {
  id: "lqu-current",
  revision: 1,
  sessionId: "session-a",
  runtimeEpoch: 1,
  currentTurnId: "turn-current",
  sourceTurnIds: ["turn-current"],
  sources: [
    {
      turnId: "turn-current",
      text: "Implement a queue.",
      startedAt: 1,
      endedAt: 2,
    },
  ],
  normalizedText: "Implement a queue.",
  startedAt: 1,
  updatedAt: 2,
  compositionReasons: ["independent-current-turn"],
  boundaryReason: "independent-current-turn",
  truncated: false,
};

function activeTask() {
  return {
    id: "parent-a",
    runtimeRevision: 1,
    source: "voice",
    parent: {
      id: "parent-a",
      questionType: "coding",
      topic: "Implement a cache.",
      compactObjective: "Implement a cache.",
      playbookPhase: "implementation_validation",
      revisions: 1,
      createdAt: 1,
      updatedAt: 1,
      supportedFactAnchors: [],
      canonicalQuestionSourceTurnIds: ["turn-parent"],
      startTurnId: "turn-parent",
      promptTranscriptStartTurnId: "turn-parent",
      phaseProgress: {},
    },
  };
}

function createHarness() {
  const clock = new Clock();
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  Date.now = () => clock.now;
  globalThis.setTimeout = clock.setTimeout;
  globalThis.clearTimeout = clock.clearTimeout;
  const metadata = {};
  const events = [];
  const advisorCalls = [];
  const state = {
    sessionId: "session-a",
    activeMeetingTask: activeTask(),
  };
  const environment = {
    ...imports,
    Date,
    Promise,
    Error,
    TypeError,
    console,
    window: clock,
    VOICE_ORDERED_RELATION_FOREGROUND_BUDGET_MS: 8_000,
    contextManagerRef: { current: { getState: () => state, clearExpiredActiveMeetingTask: () => false } },
    runtimeEpochRef: { current: 1 },
    manualCorrectionRevisionRef: { current: 0 },
    manualCorrectionOperationCoordinatorRef: {
      current: { getActiveOperationId: () => null },
    },
    taxonomyAdjudicationSettingsRef: {
      current: { taskRelationMode: "enforcement" },
    },
    runtimeActiveRef: { current: true },
    debugModeRef: { current: false },
    revokeIncompleteAdvisePin: () => {},
    logicalQuestionUnitRef: { current: logicalQuestionUnit },
    responseOpportunityGenerationGateRef: {
      current: { findOperationId: () => undefined, read: () => undefined },
    },
    traceStoreRef: {
      current: {
        updateMetadata: (_id, update) => {
          Object.assign(metadata, update);
          events.push({ at: clock.now - 10_000, metadata: { ...update } });
        },
        recordInput: () => {},
        getTraces: () => [{ id: "trace", metadata }],
        startStep: () => "step",
        finishStep: () => {},
        finishTrace: (...finish) => events.push({ finish }),
      },
    },
    sessionRecordingManagerRef: { current: undefined },
    scheduleAdvisor: (...args) =>
      advisorCalls.push({ at: clock.now - 10_000, args }),
    recordQuestionTypeAdjudicationOutcome: () => {},
    refreshRecordedCompletedTrace: () => {},
    RUNTIME_RELATION_CONFIGURATION_ERROR:
      "Runtime relation model configuration failed. Jarvis preserved the current task; check the Runtime or Main Advisor provider settings.",
    setState: (updater) => events.push({ ui: updater({}) }),
  };
  const context = vm.createContext(environment);
  environment.resolveOrderedTaskRelationOperation = resolveOrderedTaskRelationWithinWindow;
  environment.resolveOrderedTaskRelationWithinWindow = vm.runInContext(
    transpile(`(${orderedOperationBindingSource})`),
    context
  );
  for (let index = 0; index < callbackNames.length; index += 1) {
    environment[callbackNames[index]] = vm.runInContext(
      transpile(`(${callbackSources[index]})`),
      context
    );
  }
  return {
    clock,
    metadata,
    events,
    advisorCalls,
    environment,
    restore() {
      Date.now = realNow;
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

function relationHandle(harness, operationAuthorization) {
  const affinity = deferred();
  const canonical = deferred();
  let snapshot = {
    child: { unavailableReason: "no-active-child" },
    parent: { unavailableReason: "affinity-pending" },
  };
  const cancelledAt = [];
  harness.clock.setTimeout(() => {
    snapshot = {
      ...snapshot,
      parent: {
        operationId: "parent-affinity",
        outputHash: "affinity-output",
        settledAt: harness.clock.now,
        adjudication: {
          schemaVersion: 1,
          affinityKind: "parent",
          decision: "independent",
          confidence: 0.99,
          currentEvidenceSpans: ["Implement a queue."],
          branchEvidenceSpans: ["Implement a cache."],
        },
      },
    };
    affinity.resolve(snapshot);
  }, 100);
  harness.clock.setTimeout(
    () => canonical.resolve({ unavailableReason: "invalid-output" }),
    200
  );
  return {
    releaseWindowRequested: true,
    sourceKind: "voice",
    operationId: "ordered-relation",
    outcome: Promise.resolve({ operationId: "ordered-relation" }),
    affinityOutcome: affinity.promise,
    readAffinityOutcome: () => structuredClone(snapshot),
    canonicalOutcome: canonical.promise,
    startCanonical: () => canonical.promise,
    cancelForegroundWork: () => cancelledAt.push(harness.clock.now - 10_000),
    authorizeOperation: () => operationAuthorization,
    cancelledAt,
  };
}

// Real admission coordinator and operation runtimes; only the physical provider
// request is substituted. Each physical candidate is one deferred execution.
function installProductionRelationRuntime(
  harness,
  { circuitOpen = false, missingProviderTier } = {}
) {
  const executions = [];
  harness.environment.meetingModelProviderSnapshotRef = { current: {} };
  harness.environment.resolveRuntimeInferenceModelRouteFromSnapshot = ({ providerTier = "intelligent" }) => ({
    provider: providerTier === missingProviderTier ? undefined : {},
    selectedProvider: { variables: { model: providerTier } },
    providerTier,
    configFingerprint: providerTier,
    missingRequiredVariables: [],
    fallbackReason: providerTier === missingProviderTier ? "provider-missing" : undefined,
  });
  const admission = new admissionModule.RuntimeInferenceProviderAdmissionCoordinator(3, 0);
  admission.configureProviderGroups({ fastFingerprint: "fast", intelligentFingerprint: "intelligent" });
  harness.environment.runtimeInferenceProviderAdmissionRef = { current: admission };
  harness.environment.readSelectedProviderModelId = () => "test-provider";
  harness.environment.taskRelationSplitShadowCircuitRef = {
    current: { read: () => ({ open: circuitOpen }), open: () => {} },
  };
  for (const [key, kind] of [
    ["taskRelationChildAffinityRuntimeRef", "task-relation-child-affinity"],
    ["taskRelationParentAffinityRuntimeRef", "task-relation-parent-affinity"],
    ["taskRelationCanonicalShadowRuntimeRef", "task-relation-canonical-shadow"],
  ]) {
    harness.environment[key] = {
      current: new runtimeModule.RuntimeInferenceOperationRuntime(kind),
    };
  }
  harness.environment.requestTaskRelationSplitShadow = ({ request, signal, selectedProvider, timeoutMs, executionIdentity }) => {
    const result = deferred();
    const execution = { request, signal, selectedProvider, timeoutMs, executionIdentity, dispatchedAt: Date.now(), ...result };
    executions.push(execution);
    signal.addEventListener(
      "abort",
      () => result.reject(new Error("aborted")),
      { once: true }
    );
    return result.promise;
  };
  return executions;
}

function productionRelationHandle(
  harness,
  {
    sourceKind = "voice",
    runtimeReleaseRequested = true,
    currentQuestion: suppliedCurrentQuestion,
    authorizeSourceOperation = () => ({
      authorized: true,
      reason: "source-operation-current",
    }),
  } = {}
) {
  const executions = installProductionRelationRuntime(harness);
  const currentQuestion =
    suppliedCurrentQuestion ??
    imports.createProvisionalCurrentQuestion({
      logicalQuestionUnit,
      sourceKind,
    });
  const request = relationModule.buildTaskRelationAdjudicationRequest({
    logicalQuestionUnit,
    activeMeetingTask: harness.environment.contextManagerRef.current.getState()
      .activeMeetingTask,
    currentQuestion,
  });
  const handle = harness.environment.scheduleTaskRelationSplitRuntime({
    traceId: "trace",
    request,
    runtimeReleaseRequested,
    authorizeSourceOperation,
  });
  if (handle) Object.assign(handle, {
    releaseWindowRequested: runtimeReleaseRequested,
    sourceKind,
    outcome: Promise.resolve({ operationId: handle.operationId }),
  });
  return { handle, executions };
}

for (const debug of [false, true]) for (const recording of [false, true]) for (const product of [false, true]) {
  test(`D178 Split admission debug=${debug} recording=${recording} product=${product}`, { concurrency: false }, async () => {
    const h = createHarness();
    try {
      h.environment.debugModeRef.current = debug;
      const sink = { getState: () => ({ active: recording, sessionId: "recording-a" }),
        recordModelInput() {}, recordModelOutput() {}, recordCaptureLifecycle() {}, recordTaskRelationSplitDecision() {},
        recordTaskRelationDecision() {}, recordTaskRelationAdjudicationDecision() {}, recordTrace() {} };
      h.environment.sessionRecordingManagerRef.current = sink;
      h.environment.traceStoreRef.current.recordOutput = () => {};
      const { handle, executions } = productionRelationHandle(h, { runtimeReleaseRequested: product });
      await h.clock.advanceTo(500);
      if (!debug && !product) {
        assert.equal(handle, undefined);
        assert.equal(executions.length, 0);
        return;
      }
      assert.equal(executions.length, 2, "one Affinity operation, two physical candidates");
      resolveRelationProvider(executions[0], JSON.stringify({ v: 1, d: "r", c: .99, q: "Implement a queue.", b: "Implement a cache." }));
      await h.clock.advanceTo(600);
      if (!product) {
        assert.equal(executions.length, 4, "Debug observation still automatically starts Canonical");
        resolveRelationProvider(executions[2], JSON.stringify({ schemaVersion: 3, relation: "followup-parent", confidence: .8,
          currentQuestionEvidenceSpans: ["Implement a queue."], parentEvidenceSpans: ["Implement a cache."] }));
        await h.clock.flush();
        assert.equal(h.metadata.taskRelationParentAffinityObservationTrigger, "legacy-debug-preview-trigger");
        assert.equal(h.metadata.taskRelationSplitCanonicalObservationTrigger, "legacy-debug-preview-trigger");
        assert.equal(h.metadata.taskRelationParentAffinityAdmissionLane, "evaluation");
        assert.equal(h.advisorCalls.length, 0);
      } else {
        assert.equal(h.metadata.taskRelationParentAffinityObservationTrigger, undefined);
        assert.equal(h.metadata.taskRelationParentAffinityAdmissionLane, "critical");
      }
      handle.cancelForegroundWork();
      await h.clock.flush();
    } finally { h.restore(); }
  });
}

function resolveRelationProvider(execution, rawOutput) {
  const parsed =
    execution.request.operationKind === "task-relation-canonical-shadow"
      ? splitModule.parseTaskRelationCanonicalShadowOutput(
          rawOutput,
          execution.request
        )
      : splitModule.parseTaskRelationAffinityOutput(rawOutput, execution.request);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  execution.resolve({
    parsed,
    rawOutput,
    outputHash: splitModule.hashTaskRelationSplitOutput(rawOutput),
    parseDisposition: "valid",
    providerDisposition: "completed",
  });
}

function startVoiceResolution(harness, handle, typeHandleFields = {}) {
  const typeOutcome = deferred();
  harness.clock.setTimeout(
    () => typeOutcome.resolve({ enforcement: { authorized: false } }),
    50
  );
  harness.environment.scheduleAdvisorAfterQuestionTypeWindow({
    handle: {
      questionType: {
        enforcementWindowRequested: true,
        waitBudgetMs: 4_000,
        outcome: typeOutcome.promise,
        ...typeHandleFields,
      },
      taskRelation: handle,
    },
    logicalQuestionUnit,
    traceId: "trace",
    mode: "voice",
    triggerTurnId: "turn-current",
  });
}

for (const sourceKind of ["voice", "screen"]) for (const eventLoopDelay of [0, 200]) for (const canonicalWinner of ["intelligent", "fast"]) {
  test(`PA4 production ${sourceKind} gives Canonical4s after Affinity, event-loop delay=${eventLoopDelay}, Canonical ${canonicalWinner} consumed`, { concurrency: false }, async () => {
    const h = createHarness();
    try {
      const { handle, executions } = productionRelationHandle(h, { sourceKind });
      let resolution;
      if (sourceKind === "voice") startVoiceResolution(h, handle);
      else resolution = h.environment.resolveOrderedTaskRelationWithinWindow({
        handle, traceId: "trace", currentQuestionType: "coding", sourceKind,
        activeMeetingTask: h.environment.contextManagerRef.current.getState().activeMeetingTask,
        screenBoundaryPrior: true, screenTypeEvidenceAuthorized: true, waitBudgetMs: 8000,
      });
      await h.clock.advanceTo(500);
      assert.equal(executions.length, 2);
      assert.equal(executions[1].selectedProvider.variables.model, "fast");
      const fastAffinity = JSON.stringify({ v: 1, d: "r", c: 0.8, q: "Implement a queue.", b: "Implement a cache." });
      resolveRelationProvider(executions[1], fastAffinity);
      await h.clock.advanceTo(3999);
      assert.equal(executions.length, 2, "Fast cache does not start Canonical");
      assert.equal(h.advisorCalls.length, 0);
      h.clock.now = 14000 + eventLoopDelay;
      await h.clock.advanceTo(4100 + eventLoopDelay);
      assert.equal(executions.length, 4);
      assert.equal(executions[0].signal.aborted, true);
      assert.equal(executions[2].timeoutMs, 4000);
      assert.equal(executions[3].timeoutMs, 4000);
      // ST183-7: selection is not consumption. Canonical must have read the selected Fast Affinity.
      assert.equal(executions[3].request, executions[2].request);
      assert.deepEqual(executions[2].request.semanticPayload.affinity.parent, { status: "available", decision: "related",
        confidence: 0.8, currentEvidenceSpans: ["Implement a queue."], parentEvidenceSpans: ["Implement a cache."] });
      assert.equal(executions[2].request.parentPredecessorOperationId, h.metadata.taskRelationParentAffinityOperationId);
      assert.equal(executions[2].request.parentPredecessorOutputHash, splitModule.hashTaskRelationSplitOutput(fastAffinity));
      resolveRelationProvider(executions[3], JSON.stringify({ schemaVersion: 3, relation: "followup-parent", confidence: 0.8,
        currentQuestionEvidenceSpans: ["Implement a queue."], parentEvidenceSpans: ["Implement a cache."] }));
      await h.clock.advanceTo(7999 + eventLoopDelay);
      assert.equal(h.advisorCalls.length, 0, "no old4s/7s foreground release");
      if (canonicalWinner === "intelligent") {
        resolveRelationProvider(executions[2], JSON.stringify({ schemaVersion: 3, relation: "new-parent", confidence: 0.8,
          currentQuestionEvidenceSpans: ["Implement a queue."], parentEvidenceSpans: [] }));
        await h.clock.flush();
      } else {
        // ST183-3: Intelligent stays silent; the cached Fast is consumed at the Canonical deadline.
        await h.clock.advanceTo(8000 + eventLoopDelay);
        assert.equal(executions[2].signal.aborted, true);
      }
      const relation = canonicalWinner === "intelligent" ? "new-parent" : "followup-parent";
      if (resolution) {
        const resolved = await settledValue(h, resolution, "Screen consumer result");
        assert.equal(resolved.decision.stage, "canonical-relation");
        assert.equal(resolved.decision.relation, relation);
        assert.equal(resolved.affinityOutcome.parent.adjudication.decision, "related");
        assert.equal(resolved.canonicalOutcome.adjudication.relation, relation);
      } else {
        assert.equal(h.advisorCalls.length, 1);
        assert.equal(h.advisorCalls[0].args[7].relation, relation);
      }
      assert.equal(h.metadata.taskRelationOrderedResolutionStage, "canonical-relation");
      assert.equal(h.metadata.taskRelationOrderedResolutionRelation, relation);
      assert.equal(h.metadata.taskRelationOrderedResolutionAffinityParentDisposition, "available");
      assert.equal(h.metadata.taskRelationParentAffinitySelectedProviderTier, "fast");
      assert.equal(h.metadata.taskRelationSplitCanonicalSelectedProviderTier, canonicalWinner);
      assert.equal(new Set(executions.map(e => e.executionIdentity.requestId)).size, 4);
      assert.equal(executions[0].executionIdentity.executionPlanId, executions[1].executionIdentity.executionPlanId);
      await h.clock.advanceTo(9000 + eventLoopDelay);
      assert.equal(h.advisorCalls.length, sourceKind === "voice" ? 1 : 0);
    } finally { h.restore(); }
  });
}

test("carries an exact Screen source through the production Advisor request fields", { concurrency: false }, () => {
  const task = {
    id: "screen-parent",
    runtimeRevision: 3,
    source: "screen",
    parent: {
      id: "screen-parent",
      questionType: "coding",
      topic: "Implement an LRU cache.",
      playbookPhase: "optimized_pseudocode",
      phaseProgress: { baseline_reasoning: true },
      supportedFactAnchors: [],
      revisions: 3,
      createdAt: 1,
      updatedAt: 3,
    },
    screen: {
      activeScreenTaskId: "canonical-screen:screen-original",
      observationId: "screen-newer",
      basedOnObservationId: "screen-newer",
    },
  };
  const observations = [
    {
      id: "screen-original",
      capturedAt: 1,
      source: "hotkey",
      imageBase64: "original-image",
      imageMediaType: "image/jpeg",
      changed: true,
    },
    {
      id: "screen-newer",
      capturedAt: 2,
      source: "hotkey",
      imageBase64: "newer-image",
      imageMediaType: "image/jpeg",
      changed: true,
    },
  ];

  for (const current of [
    {
      advisorPromptMode: "response-action",
      source: "response-action",
      responseAction: "next-phase",
    },
    {
      advisorPromptMode: "regenerate",
      source: "regenerate",
      responseAction: undefined,
    },
  ]) {
    const environment = {
      resolveAdvisorScreenSourceRead:
        screenScopeModule.resolveAdvisorScreenSourceRead,
      advisorPromptMode: current.advisorPromptMode,
      advisorJob: {
        source: current.source,
        expectedSessionId: "session-a",
        expectedParentId: "screen-parent",
        runtimeCommitToken: { runtimeEpoch: 4 },
        logicalQuestionUnit: { sourceTurnIds: [] },
      },
      advisorSourceReadContext: {
        sessionId: "session-a",
        screenObservations: observations,
      },
      runtimeEpochRef: { current: 4 },
      advisorSourceReadTask: task,
      preferredScreenObservationIds: ["screen-original"],
      explicitVisibleSourceAction: true,
      promptContext: { advisorPromptSourceTurnIds: [] },
      advisorModelRoute: { provider: { curl: "{{IMAGE}}" } },
      options: { responseAction: current.responseAction },
    };
    const context = vm.createContext(environment);
    const screenRead = vm.runInContext(
      transpile(`(() => ${advisorScreenSourceReadSource})()`),
      context
    );
    environment.advisorScreenSourceRead = screenRead;
    const request = vm.runInContext(
      transpile(`({
        mode: ${advisorStreamModeSource},
        responseAction: ${advisorStreamResponseActionSource},
        sourceImages: ${advisorStreamSourceImagesSource}
      })`),
      context
    );

    assert.equal(screenRead.disposition, "attached");
    assert.equal(screenRead.sourceScreenObservationId, "screen-original");
    assert.equal(request.mode, current.advisorPromptMode);
    assert.equal(request.responseAction, current.responseAction);
    assert.equal(request.sourceImages.length, 1);
    assert.equal(request.sourceImages[0].base64, "original-image");
    assert.equal(request.sourceImages[0].mediaType, "image/jpeg");

    const prompt = advisorPromptModule.buildAdvisorUserMessage(
      {
        transcript: "",
        screenContext: "Implement an LRU cache.",
        taskRuntime: { revision: 3 },
        activeMeetingTask: task,
        rollingSummary: "",
        userProfileContext: "",
        glossaryText: "",
      },
      {
        mode: request.mode,
        responseAction: request.responseAction,
        answerProfile: "coding",
        currentSuggestion: "Answer: Explain the current phase.",
      }
    );
    assert.match(prompt, new RegExp(`<mode>\\n${current.advisorPromptMode}\\n</mode>`));
    if (current.responseAction) {
      assert.match(
        prompt,
        new RegExp(`<response_action>\\n${current.responseAction}\\n</response_action>`)
      );
    }
  }
});

test("cancels a stale Relation operation before its final Advisor handoff", { concurrency: false }, async () => {
  const harness = createHarness();
  try {
    const handle = relationHandle(harness, {
      authorized: false,
      reason: "identity-mismatch",
      mismatchedKey: "manualCorrectionRevision",
    });
    startVoiceResolution(harness, handle);
    await harness.clock.advanceTo(400);

    assert.equal(harness.advisorCalls.length, 0);
    assert.deepEqual(handle.cancelledAt, [200]);
    assert.equal(
      harness.metadata.taskRelationOrderedResolutionOperationCancelled,
      true
    );
    assert.equal(
      harness.metadata.taskRelationOrderedResolutionOperationMismatchedKey,
      "manualCorrectionRevision"
    );
    assert.deepEqual(
      harness.events.filter((event) => event.finish),
      [
        {
          finish: [
            "trace",
            "cancelled",
            "task-relation-operation-manualCorrectionRevision-stale",
          ],
        },
      ]
    );
  } finally {
    harness.restore();
  }
});

test("retains a provisional Voice affinity result before RO publishes the LQU", { concurrency: false }, async () => {
  const harness = createHarness();
  try {
    harness.environment.logicalQuestionUnitRef.current = {
      ...logicalQuestionUnit,
      id: "lqu-previous",
      currentTurnId: "turn-previous",
      sourceTurnIds: ["turn-previous"],
    };
    const { handle, executions } = productionRelationHandle(harness, {
      authorizeSourceOperation: () => {
        const current = harness.environment.logicalQuestionUnitRef.current;
        const authorized =
          current?.id === logicalQuestionUnit.id &&
          current?.revision === logicalQuestionUnit.revision;
        return {
          authorized,
          reason: authorized
            ? "logical-question-current"
            : "logical-question-id-mismatch",
          mismatchedKey: authorized ? undefined : "source",
        };
      },
    });
    await harness.clock.advanceTo(1);
    assert.equal(executions.length, 2);
    resolveRelationProvider(
      executions[0],
      JSON.stringify({ v: 1, d: "i", c: 0.99, q: "Implement a queue." })
    );
    const outcome = await settledValue(harness, handle.affinityOutcome, "Affinity stage terminal");

    assert.equal(outcome.parent.adjudication?.decision, "independent");
    assert.equal(outcome.parent.unavailableReason, undefined);
    harness.environment.logicalQuestionUnitRef.current = logicalQuestionUnit;
    const resolutionPromise =
      harness.environment.resolveOrderedTaskRelationWithinWindow({
        handle,
        traceId: "trace",
        currentQuestionType: "coding",
        sourceKind: "voice",
        activeMeetingTask:
          harness.environment.contextManagerRef.current.getState()
            .activeMeetingTask,
        waitBudgetMs: 8_000,
      });
    await harness.clock.advanceTo(2);
    assert.equal(executions.length, 4);
    resolveRelationProvider(
      executions[2],
      JSON.stringify({
        schemaVersion: 3,
        relation: "new-parent",
        confidence: 0.99,
        currentQuestionEvidenceSpans: ["Implement a queue."],
        parentEvidenceSpans: [],
      })
    );
    const resolution = await settledValue(harness, resolutionPromise, "Voice consumer result");
    assert.equal(resolution.terminalDisposition, "resolved");
    assert.equal(resolution.decision.relation, "new-parent");
  } finally {
    harness.restore();
  }
});

test("uses a Screen operation's own source when no Voice LQU is current", { concurrency: false }, async () => {
  const harness = createHarness();
  try {
    harness.environment.logicalQuestionUnitRef.current = undefined;
    const screenQuestion = imports.createProvisionalCurrentQuestion({
      logicalQuestionUnit,
      sourceKind: "screen",
      sourceObservationIds: ["screen-observation"],
    });
    const { handle, executions } = productionRelationHandle(harness, {
      sourceKind: "screen",
      currentQuestion: screenQuestion,
    });
    const resolutionPromise =
      harness.environment.resolveOrderedTaskRelationWithinWindow({
        handle,
        traceId: "trace",
        currentQuestionType: "coding",
        sourceKind: "screen",
        activeMeetingTask:
          harness.environment.contextManagerRef.current.getState()
            .activeMeetingTask,
        screenBoundaryPrior: true,
        screenTypeEvidenceAuthorized: true,
        waitBudgetMs: 8_000,
      });
    await harness.clock.advanceTo(1);
    assert.equal(executions.length, 2);
    resolveRelationProvider(
      executions[0],
      JSON.stringify({
        v: 1,
        d: "r",
        c: 0.99,
        q: "Implement a queue.",
        b: "Implement a cache.",
      })
    );
    await harness.clock.flush();
    const resolution = await settledValue(harness, resolutionPromise, "Screen consumer result");

    assert.equal(resolution.operationAuthorization.authorized, true);
    assert.equal(resolution.decision.relation, "followup-parent");
  } finally {
    harness.restore();
  }
});

test("lets the Voice operation owner present a Relation client error without handoff", { concurrency: false }, async () => {
  const harness = createHarness();
  try {
    const affinityOutcome = {
      child: { unavailableReason: "no-active-child" },
      parent: {
        unavailableReason: "provider-configuration-error",
        clientError: true,
      },
    };
    const handle = {
      releaseWindowRequested: true,
      sourceKind: "voice",
      operationId: "voice-client-error",
      outcome: Promise.resolve({ operationId: "voice-client-error" }),
      affinityOutcome: Promise.resolve(affinityOutcome),
      readAffinityOutcome: () => structuredClone(affinityOutcome),
      cancelForegroundWork: () => undefined,
      authorizeOperation: () => ({
        authorized: true,
        reason: "source-operation-current",
      }),
    };

    startVoiceResolution(harness, handle);
    await harness.clock.advanceTo(300);

    assert.equal(harness.advisorCalls.length, 0);
    assert.equal(
      harness.events.some(
        (event) =>
          event.ui?.error ===
          "Runtime relation model configuration failed. Jarvis preserved the current task; check the Runtime or Main Advisor provider settings."
      ),
      true
    );
    assert.equal(
      harness.events.some(
        (event) =>
          event.finish?.[1] === "error" &&
          event.finish?.[2] === "task-relation-client-error"
      ),
      true
    );
  } finally {
    harness.restore();
  }
});

test("lets the owning Screen consumer present a Relation client error and leave thinking", { concurrency: false }, async () => {
  const harness = createHarness();
  try {
    let ui = {
      status: "thinking",
      partialSuggestion: "partial",
      error: null,
    };
    let stateWrites = 0;
    let abortCount = 0;
    const analysisController = {
      abort: () => {
        abortCount += 1;
      },
    };
    const coordinator = new ScreenOperationCoordinator();
    coordinator.claim("screen-operation");
    Object.assign(harness.environment, {
      screenOperationCoordinatorRef: { current: coordinator },
      screenOperationId: "screen-operation",
      analysisController,
      screenAnalysisAbortRef: { current: analysisController },
      runtimeActiveRef: { current: true },
      idleReturnStatus: "idle",
      screenTerminalError: "Runtime relation model configuration failed.",
      trace: { id: "screen-client-error-trace" },
      setState: (update) => {
        stateWrites += 1;
        ui = update(ui);
      },
    });
    const scope = vm.createContext(harness.environment);
    const finalizeOperation = vm.runInContext(
      transpile(`(${finalizeOwnedScreenOperationSource})`),
      scope
    );
    const relationHandle = {
      releaseWindowRequested: true,
      authorizeOperation: () => ({
        authorized: true,
        reason: "source-operation-current",
      }),
      readAffinityOutcome: () => ({
        child: { unavailableReason: "no-active-child" },
        parent: {
          unavailableReason: "provider-configuration-error",
          clientError: true,
        },
      }),
      cancelForegroundWork: () => undefined,
    };

    const resolution =
      await harness.environment.resolveOrderedTaskRelationWithinWindow({
        handle: relationHandle,
        traceId: "trace",
        currentQuestionType: "coding",
        sourceKind: "screen",
        activeMeetingTask: activeTask(),
        waitBudgetMs: 8_000,
      });

    assert.equal(resolution.terminalDisposition, "client-error");
    assert.equal(stateWrites, 0, "the shared resolver must not mutate UI state");
    assert.equal(finalizeOperation(), true);
    assert.equal(ui.status, "listening");
    assert.equal(ui.partialSuggestion, "");
    assert.equal(ui.error, "Runtime relation model configuration failed.");
    assert.equal(abortCount, 1);
    assert.equal(harness.environment.screenAnalysisAbortRef.current, null);
    assert.equal(coordinator.release("screen-operation"), true);
  } finally {
    harness.restore();
  }
});

test("does not let an old Screen terminal clear a newer operation", { concurrency: false }, () => {
  const harness = createHarness();
  try {
    let ui = {
      status: "thinking",
      partialSuggestion: "new partial",
      error: null,
    };
    let stateWrites = 0;
    let oldAbortCount = 0;
    const oldController = {
      abort: () => {
        oldAbortCount += 1;
      },
    };
    const newController = { abort: () => undefined };
    const coordinator = new ScreenOperationCoordinator();
    coordinator.claim("old-screen-operation");
    const screenAnalysisAbortRef = { current: oldController };
    Object.assign(harness.environment, {
      screenOperationCoordinatorRef: { current: coordinator },
      screenOperationId: "old-screen-operation",
      analysisController: oldController,
      screenAnalysisAbortRef,
      runtimeActiveRef: { current: true },
      idleReturnStatus: "idle",
      screenTerminalError: null,
      trace: { id: "old-screen-terminal-trace" },
      pendingLatePreflightRepair: undefined,
      setState: (update) => {
        stateWrites += 1;
        ui = update(ui);
      },
    });
    const context = vm.createContext(harness.environment);
    harness.environment.finalizeOwnedScreenOperation = vm.runInContext(
      transpile(`(${finalizeOwnedScreenOperationSource})`),
      context
    );
    const runOldFinally = vm.runInContext(
      transpile(`(() => ${captureScreenFinallySource})`),
      context
    );
    coordinator.claim("new-screen-operation");
    screenAnalysisAbortRef.current = newController;

    runOldFinally();
    assert.equal(stateWrites, 0);
    assert.equal(oldAbortCount, 0);
    assert.deepEqual(ui, {
      status: "thinking",
      partialSuggestion: "new partial",
      error: null,
    });
    assert.equal(coordinator.getActiveOperationId(), "new-screen-operation");
  } finally {
    harness.restore();
  }
});

test("ends an owned Screen after post-model Preparation staleness", { concurrency: false }, () => {
  const coordinator = new ScreenOperationCoordinator();
  coordinator.claim("screen-operation");
  const controller = new AbortController();
  const contextState = {
    sessionId: "screen-session",
    activeMeetingTask: {
      parent: { id: "screen-parent", revisions: 1 },
    },
  };
  const runtimeSnapshot = imports.buildRuntimeCommitSnapshot({
    runtimeEpoch: 1,
    contextState,
  });
  const runtimeToken = imports.createRuntimeCommitToken({
    operationId: "screen-operation",
    pipeline: "screen",
    snapshot: runtimeSnapshot,
  });
  const generationLease = imports.createAnswerGenerationLease({
    sessionId: contextState.sessionId,
    runtimeEpoch: 1,
    preparationContextRevision: 0,
    taskId: "screen-parent",
    taskRevision: 1,
    logicalQuestionUnitId: "screen-question",
    logicalQuestionRevision: 1,
    baseVisibleAnswerRevision: 1,
    sourceTurnIds: [],
    manualCorrectionRevision: 0,
    responseActionRevision: 0,
    modelRoute: "main",
    artifactOwnerId: "screen-parent",
    requestedArtifacts: ["answer"],
  });
  let ui = {
    status: "thinking",
    partialSuggestion: "current partial",
    error: null,
  };
  const terminalReasons = [];
  const environment = {
    ...imports,
    screenOperationCoordinatorRef: { current: coordinator },
    screenOperationId: "screen-operation",
    screenRuntimeToken: runtimeToken,
    readRuntimeCommitSnapshot: () => runtimeSnapshot,
    contextManagerRef: {
      current: {
        getState: () => contextState,
        clearExpiredActiveMeetingTask: () => false,
      },
    },
    screenGenerationLease: generationLease,
    boundVisualRecoveryFact: undefined,
    runtimeEpochRef: { current: 1 },
    visibleAnswerRevisionRef: { current: 1 },
    manualCorrectionRevisionRef: { current: 0 },
    responseActionRevisionRef: { current: 0 },
    preparationRuntimeContextRef: {
      current: { preparationContextRevision: 1 },
    },
    screenGenerationRequestedArtifacts: ["answer"],
    screenSourceOwnedTransitionReceipt: undefined,
    screenModelCompletedAt: 2_000,
    screenResponseCandidate: undefined,
    analysisController: controller,
    screenAnalysisAbortRef: { current: controller },
    screenStagedVisible: false,
    screenStagedChunkCount: 0,
    screenStagedFirstChunkAt: undefined,
    screenStagedFirstVisiblePartialAt: undefined,
    revokeIncompleteAdvisePin: () => {},
    displayedStreamRef: { current: null },
    trace: { id: "screen-trace" },
    traceStoreRef: {
      current: {
        updateMetadata: () => undefined,
        getTraces: () => [
          { id: "screen-trace", status: "running", steps: [] },
        ],
        finishTrace: (_traceId, _status, reason) =>
          terminalReasons.push(reason),
      },
    },
    recordScreenQuestionTypeOutcome: () => undefined,
    terminalizeGenerationLease: (input) =>
      terminalReasons.push(input.reason),
    setState: (update) => {
      ui = update(ui);
    },
    runtimeActiveRef: { current: true },
    idleReturnStatus: "idle",
    screenTerminalError: undefined,
    pendingLatePreflightRepair: undefined,
  };
  const context = vm.createContext(environment);
  environment.finalizeOwnedScreenOperation = vm.runInContext(
    transpile(`(${finalizeOwnedScreenOperationSource})`),
    context
  );
  environment.readScreenAuthorization = vm.runInContext(
    transpile(`(${readScreenAuthorizationSource})`),
    context
  );
  environment.clearScreenStagedPartial = vm.runInContext(
    transpile(`(${clearScreenStagedPartialSource})`),
    context
  );
  environment.rejectStaleScreenOperation = vm.runInContext(
    transpile(`(${rejectStaleScreenOperationSource})`),
    context
  );
  const runPostModelGuard = vm.runInContext(
    transpile(
      `(() => { try { ${postModelScreenStaleGuardSource}; return "continued"; } finally ${captureScreenFinallySource} })`
    ),
    context
  );

  assert.equal(runPostModelGuard(), undefined);
  assert.equal(coordinator.getActiveOperationId(), null);
  assert.equal(controller.signal.aborted, true);
  assert.equal(environment.screenAnalysisAbortRef.current, null);
  assert.equal(ui.status, "listening");
  assert.equal(ui.partialSuggestion, "");
  assert.ok(terminalReasons.includes("preparation-context-revision-mismatch"));
});

test("terminalizes a stale explicit Type Correction intent before mutation", { concurrency: false }, async () => {
  const metadata = {};
  const finished = [];
  const recorded = [];
  let ui = {
    manualQuestionTypeCorrection: {
      eventId: "type-correction-event",
      status: "pending",
    },
    partialSuggestion: "pending correction",
    latestSuggestion: null,
    latestReliableSuggestion: null,
  };
  const environment = {
    ...imports,
    relationAdjudicationWaitDisposition: "pending",
    correctionTrace: { id: "type-correction-trace" },
    actionEvidence: { actionId: "request-1", action: "type-correction", correctedType: "coding" },
    correctionLogicalQuestionUnit: { id: "question-1", revision: 1 },
    recordManualRuntimeAction() {},
    correctionTerminalized: false,
    mutationApplied: false,
    correction: {
      eventId: "type-correction-event",
      status: "pending",
    },
    eventId: "type-correction-event",
    correctionReliableAnswerFallback: undefined,
    sessionRecordingManagerRef: {
      current: {
        recordManualQuestionTypeCorrection: (value) =>
          recorded.push(value),
      },
    },
    traceStoreRef: {
      current: {
        updateMetadata: (_traceId, next) => Object.assign(metadata, next),
        getTraces: () => [
          { id: "type-correction-trace", status: "running" },
        ],
        finishTrace: (...args) => finished.push(args),
      },
    },
    setState: (update) => {
      ui = update(ui);
    },
  };
  const context = vm.createContext(environment);
  environment.finalizeCorrection = vm.runInContext(
    transpile(`(${finalizeCorrectionSource})`),
    context
  );
  const consume = vm.runInContext(
    transpile(
      `(async (correctionIntentTransition) => { ${typeCorrectionIntentTerminalSource}; return "continued"; })`
    ),
    context
  );
  const result = await consume({
    authorized: false,
    reason: "task-runtime-revision-mismatch",
  });

  assert.equal(result, undefined);
  assert.equal(ui.manualQuestionTypeCorrection.status, "failed");
  assert.equal(ui.manualQuestionTypeCorrection.regenerationStatus, "idle");
  assert.equal(ui.manualQuestionTypeCorrection.regenerationRetryable, false);
  assert.match(ui.error, /task-runtime-revision-mismatch/);
  assert.equal(ui.partialSuggestion, "");
  assert.equal(recorded.length, 1);
  assert.equal(finished.length, 1);
  assert.equal(finished[0][0], "type-correction-trace");
  assert.equal(finished[0][1], "cancelled");
  const body = typeCorrectionDeclaration.initializer.arguments[0].getText(sourceFile);
  assert.doesNotMatch(body, /scheduleTaskRelationAdjudication\(/);
  assert.match(body, /prepareManualCorrectionIntentTransition\(/);
});

test("terminalizes Term Correction client errors without starting Advisor", { concurrency: false }, async () => {
  const guardContext = vm.createContext({});
  const consumeGuard = vm.runInContext(
    transpile(
      `(async (relationResolution) => { let correctionRelationTerminal; try { ${termCorrectionRelationTerminalSource}; return { continued: true, correctionRelationTerminal }; } catch (error) { return { continued: false, correctionRelationTerminal, error }; } })`
    ),
    guardContext
  );
  const guarded = await consumeGuard({
    terminalDisposition: "client-error",
    operationAuthorization: {
      authorized: true,
      reason: "source-operation-current",
    },
    decision: { relation: "new-parent" },
  });
  assert.equal(guarded.continued, false);
  assert.equal(guarded.correctionRelationTerminal.disposition, "client-error");
  assert.equal(
    guarded.correctionRelationTerminal.reason,
    "task-relation-client-error"
  );

  let advisorCalls = 0;
  const finished = [];
  const gateContext = vm.createContext({
    correctionRelationTerminal: guarded.correctionRelationTerminal,
    repairTrace: { id: "term-correction-trace" },
    traceStoreRef: {
      current: {
        finishTrace: (...args) => finished.push(args),
      },
    },
    runAdvisor: async () => {
      advisorCalls += 1;
    },
  });
  const consumeAdvisorGate = vm.runInContext(
    transpile(`(async () => { ${termCorrectionAdvisorGateSource} })`),
    gateContext
  );
  await consumeAdvisorGate();

  assert.equal(advisorCalls, 0);
  assert.deepEqual(finished, [
    ["term-correction-trace", "error", "task-relation-client-error"],
  ]);
});

test("validates a model-free first-parent operation before Advisor handoff", { concurrency: false }, async () => {
  const harness = createHarness();
  try {
    harness.environment.contextManagerRef.current.getState().activeMeetingTask =
      undefined;
    const gate = deferred();
    harness.environment.responseOpportunityGenerationGateRef.current = {
      findOperationId: () => "response-gate",
      read: () => ({ disposition: "pending" }),
      wait: () => gate.promise,
    };
    const currentQuestion = imports.createProvisionalCurrentQuestion({
      logicalQuestionUnit,
      sourceKind: "voice",
    });
    const handle = harness.environment.scheduleTaskRelationAdjudication({
      turn: { speaker: "them", text: "Implement a queue." },
      traceId: "trace",
      turnGateAction: "answer-refresh",
      logicalQuestionUnit,
      lexical: { type: "coding" },
      sourceKind: "voice",
      currentQuestion,
      authorizeSourceOperation: () => ({
        authorized: true,
        reason: "source-operation-current",
      }),
    });
    assert.ok(handle);
    assert.equal(handle.releaseWindowRequested, false);
    startVoiceResolution(harness, handle);
    await harness.clock.advanceTo(100);
    harness.environment.contextManagerRef.current.getState().activeMeetingTask =
      activeTask();
    harness.environment.manualCorrectionRevisionRef.current = 1;
    gate.resolve({ disposition: "output-authorized" });
    await harness.clock.advanceTo(300);

    assert.equal(harness.advisorCalls.length, 0);
    assert.equal(
      harness.metadata.taskRelationOrderedResolutionOperationCancelled,
      true
    );
  } finally {
    harness.restore();
  }
});

test("keeps the existing null-hypothesis fallback for a valid Relation operation", { concurrency: false }, async () => {
  const harness = createHarness();
  try {
    const handle = relationHandle(harness, {
      authorized: true,
      reason: "identity-current",
    });
    startVoiceResolution(harness, handle);
    await harness.clock.advanceTo(400);

    assert.equal(harness.advisorCalls.length, 1);
    assert.equal(handle.cancelledAt.length, 0);
    assert.equal(
      harness.metadata.taskRelationOrderedResolutionOperationAuthorized,
      true
    );
  } finally {
    harness.restore();
  }
});

test("production Voice publication closes Type retry permission at the same foreground handoff", { concurrency: false }, async () => {
  const harness = createHarness();
  try {
    const restrictions = [];
    const handle = relationHandle(harness, { authorized: true, reason: "identity-current" });
    startVoiceResolution(harness, handle, {
      restrictRetryDeadlineAt: at => restrictions.push(at),
    });
    assert.deepEqual(restrictions, [14_000]);
    await harness.clock.advanceTo(400);
    assert.equal(harness.advisorCalls.length, 1);
    assert.equal(restrictions.length, 2);
    assert.ok(restrictions[1] < 14_000);
    assert.ok(restrictions[1] <= harness.clock.now);
  } finally {
    harness.restore();
  }
});

test("cancels a live Split Relation operation after manual correction invalidates its lease", { concurrency: false }, async () => {
  const harness = createHarness();
  try {
    const { handle, executions } = productionRelationHandle(harness);
    startVoiceResolution(harness, handle);
    await harness.clock.advanceTo(100);
    assert.equal(executions.length, 2);
    resolveRelationProvider(
      executions[0],
      JSON.stringify({ v: 1, d: "i", c: 0.99, q: "Implement a queue." })
    );
    await harness.clock.advanceTo(200);
    assert.equal(executions.length, 4);
    harness.environment.manualCorrectionRevisionRef.current += 1;
    resolveRelationProvider(
      executions[2],
      JSON.stringify({
        schemaVersion: 3,
        relation: "followup-parent",
        confidence: 0.99,
        currentQuestionEvidenceSpans: ["Implement a queue."],
        parentEvidenceSpans: ["Implement a cache."],
      })
    );
    await harness.clock.advanceTo(400);

    assert.equal(harness.advisorCalls.length, 0);
    assert.equal(
      harness.metadata.taskRelationSplitCanonicalLeaseAuthorized,
      false
    );
    assert.equal(
      harness.metadata.taskRelationOrderedResolutionOperationCancelled,
      true
    );
    assert.equal(
      harness.metadata.taskRelationOrderedResolutionOperationMismatchedKey,
      "manualCorrectionRevision"
    );
  } finally {
    harness.restore();
  }
});

// ---------------------------------------------------------------------------
// ST183: one deadline arbiter per Relation stage.
//
// Each stage ends once: provider candidate selector -> existing operation
// runtime -> lease validation -> stage terminal. The shared Ordered consumer
// uses that terminal value; it neither times the stage itself nor reads a
// still-pending published snapshot as the end of the stage.
//
// Composition under test is production code: the Hook's scheduling callbacks
// and its own Ordered-operation binding, the selector, admission coordinator,
// operation runtimes, lease/predecessor validation, the shared Ordered
// operation and the Canonical request builder. The Screen and Correction
// entries run their real call-site code. Only the physical provider request,
// the clock and I/O sinks are substituted.
// ---------------------------------------------------------------------------

const compiledMeetingModule = (name) =>
  import(pathToFileURL(path.join(root, ".tmp-tests", "src", "lib", "meeting", `${name}.js`)));
const { calculateWordEquivalent } = await compiledMeetingModule("transcript-fusion");
const { selectOwnerScopedRelationEvidence, EffectiveQuestionSourceLedger, createEffectiveQuestionSourceRecord } =
  await compiledMeetingModule("effective-question-source-ledger");
const { selectSourceOwnedSemanticContext, formatSourceOwnedSemanticContextSelectionForTrace } =
  await compiledMeetingModule("source-owned-semantic-context");
const { projectEffectiveTaskSourceView } = await compiledMeetingModule("effective-task-source-view");
const { CORRECTION_OWNED_ADJUDICATION_BUDGET_MS } = await compiledMeetingModule("correction-owned-resettlement");
const readEffectiveSemanticTaskSource = findNamedDeclaration(sourceFile, "readEffectiveSemanticTask")
  .initializer.arguments[0].getText(sourceFile);
const orderedOperationCall = (declaration) => findDescendant(declaration, (node) =>
  ts.isCallExpression(node) &&
  node.expression.getText(sourceFile) === "resolveOrderedTaskRelationWithinWindow");
const screenOrderedCallSource = orderedOperationCall(captureScreenDeclaration).getText(sourceFile);
const correctionOrderedRelationSource = findDescendant(termCorrectionDeclaration, (node) =>
  ts.isIfStatement(node) &&
  node.expression.getText(sourceFile).includes("correctionRelationHandle?.releaseWindowRequested")
).getText(sourceFile);

const STAGE_MS = splitModule.ORDERED_RELATION_STAGE_BUDGET_MS;
const QUESTION = "Implement a queue.";
const PARENT = "Implement a cache.";
const FAST_PARENT_INDEPENDENT = JSON.stringify({ v: 1, d: "i", c: 0.95, q: QUESTION, b: null });
const FAST_CHILD_UNRELATED = JSON.stringify({ v: 1, d: "n", c: 0.95, q: QUESTION, b: null });
const PARENT_RELATED = JSON.stringify({ v: 1, d: "r", c: 0.99, q: QUESTION, b: PARENT });
const canonicalOutput = (relation) => JSON.stringify({ schemaVersion: 3, relation, confidence: 0.7,
  currentQuestionEvidenceSpans: [QUESTION],
  parentEvidenceSpans: relation === "new-parent" || relation === "unknown" ? [] : [PARENT] });
const activeChild = () => ({ id: "child-a", createdAt: 1, updatedAt: 1, questionType: "field-knowledge",
  relation: "child-probe", intent: "concept-probe", question: "Explain cache eviction.",
  basedOnTurnIds: ["turn-child"], basedOnObservationIds: [] });
const sourceCurrent = () => ({ authorized: true, reason: "source-operation-current" });

// Debug and Recording are separate switches, as in production. `recordingSinkCostMs`
// makes the recorder's synchronous write take time, as a real sink can.
function st183Harness({ child = false, debug = false, recording = false, recordingSinkCostMs, runtime } = {}) {
  const h = createHarness();
  const state = h.environment.contextManagerRef.current.getState();
  state.transcriptTurns = [];
  if (child) state.activeMeetingTask = { ...activeTask(), child: activeChild() };
  // The semantic task view reads the owning questions from the real source ledger.
  const ledger = new EffectiveQuestionSourceLedger();
  const publish = (id, turnId, text, relation) => ledger.upsert(createEffectiveQuestionSourceRecord({
    logicalQuestionUnit: { ...logicalQuestionUnit, id, currentTurnId: turnId, sourceTurnIds: [turnId],
      sources: [{ turnId, text, startedAt: 1, endedAt: 2 }], normalizedText: text },
    settlement: { relation, sourceHash: `${id}-hash`, sourceKind: "voice", sourceObservationIds: [] },
    activeMeetingTask: state.activeMeetingTask, settledAt: 1,
  }));
  publish("lqu-parent", "turn-parent", PARENT, "new-parent");
  if (child) publish("lqu-child", "turn-child", activeChild().question, "child-probe");
  Object.assign(h.environment, {
    calculateWordEquivalent, selectOwnerScopedRelationEvidence, selectSourceOwnedSemanticContext,
    formatSourceOwnedSemanticContextSelectionForTrace, projectEffectiveTaskSourceView,
    effectiveQuestionSourceLedgerRef: { current: ledger },
    latestSourceOwnedSetupRef: { current: undefined },
  });
  h.environment.readEffectiveSemanticTask = vm.runInContext(
    transpile(`(${readEffectiveSemanticTaskSource})`), vm.createContext(h.environment));
  h.recorded = [];
  h.debugOutputs = [];
  // The Debug sink is observed whatever the switch says, so "nothing written
  // with Debug off" is an observation and not the absence of a spy.
  h.environment.traceStoreRef.current.recordOutput = (_traceId, label) => { h.debugOutputs.push(label); };
  if (debug) h.environment.debugModeRef.current = true;
  if (recording) {
    const record = (kind) => (entry) => {
      h.clock.now += recordingSinkCostMs?.(kind, entry) ?? 0;
      h.recorded.push({ kind, ...entry });
    };
    h.environment.sessionRecordingManagerRef.current = {
      getState: () => ({ active: true, sessionId: "recording-a" }),
      recordModelInput: record("model-input"), recordModelOutput: record("model-output"),
      recordCaptureLifecycle: record("lifecycle"),
      recordTaskRelationAdjudicationDecision: record("relation-decision"),
    };
  }
  h.executions = installProductionRelationRuntime(h, runtime);
  return h;
}

// The handle Voice, Screen and Correction really consume: assembled by the Hook.
function scheduleRelation(h, { sourceKind = "voice", manualCorrectionOwned = false,
  unit = logicalQuestionUnit, authorizeSourceOperation = sourceCurrent } = {}) {
  return h.environment.scheduleTaskRelationAdjudication({
    turn: { speaker: "them", text: QUESTION }, traceId: "trace", turnGateAction: "answer-refresh",
    logicalQuestionUnit: unit, lexical: { type: "coding" }, sourceKind, manualCorrectionOwned,
    currentQuestion: sourceKind === "voice" ? undefined : imports.createProvisionalCurrentQuestion({
      logicalQuestionUnit: unit, sourceKind, sourceObservationIds: ["screen-observation"] }),
    authorizeSourceOperation,
  });
}

function startScreenConsumer(h, handle) {
  return vm.runInContext(transpile(`(${screenOrderedCallSource})`), vm.createContext({
    resolveOrderedTaskRelationWithinWindow: h.environment.resolveOrderedTaskRelationWithinWindow,
    taskRelationAdjudicationHandle: handle,
    trace: { id: "trace" },
    screenMemoryQuestionType: "coding",
    preflightContextState: h.environment.contextManagerRef.current.getState(),
    screenTypeEvidenceAuthorized: true,
    SCREEN_ORDERED_RELATION_FOREGROUND_BUDGET_MS: splitModule.SCREEN_ORDERED_RELATION_FOREGROUND_BUDGET_MS,
  }));
}

// Speech Correction's own relation block. It passes the shared two-stage window
// as a constant; a block that computed a budget of its own again would find no
// clock, no Type budget and no adjudication start time in this context.
function startCorrectionConsumer(h, handle) {
  return vm.runInContext(transpile(`(async () => {
    let orderedCorrectionRelation;
    let correctionRelationTerminal;
    try { ${correctionOrderedRelationSource} } catch (error) { return { error, correctionRelationTerminal }; }
    return { orderedCorrectionRelation, correctionRelationTerminal };
  })()`), vm.createContext({
    Error,
    resolveOrderedTaskRelationWithinWindow: h.environment.resolveOrderedTaskRelationWithinWindow,
    traceStoreRef: h.environment.traceStoreRef,
    CORRECTION_ORDERED_RELATION_FOREGROUND_BUDGET_MS: splitModule.CORRECTION_ORDERED_RELATION_FOREGROUND_BUDGET_MS,
    revisionStableTopologyBinding: false,
    correctionRelationHandle: handle,
    repairTrace: { id: "trace" },
    settledCorrectionType: "coding",
    correctionTypeResolution: { stage: "runtime-llm" },
    correctionSourceKind: "voice",
    latestContext: h.environment.contextManagerRef.current.getState(),
  }));
}

const scheduleEntry = (h, entry) => scheduleRelation(h, { sourceKind: entry === "screen" ? "screen" : "voice",
  manualCorrectionOwned: entry === "correction" });
const voiceWaitEnded = (h) => h.advisorCalls.length > 0 || h.events.some((event) => event.finish);
const entryWaitEnded = (h, entry, started) =>
  (entry === "voice" ? voiceWaitEnded(h) : Boolean(started.wait) && started.wait.state !== "pending");

// A consumer's result is read only once its wait is over, so a wait that was
// wrongly left open fails here by name instead of hanging the file.
async function settledOutcome(h, entry, started) {
  expectEqual(entryWaitEnded(h, entry, started), true, "consumer wait over");
  return started.resolution;
}

// Starts the entry's real consumer in a chosen order relative to the selectors'
// deadline timers. "consumer-first": the consumer starts before the selectors
// have registered those timers, so whatever it registers for the deadline runs
// first there. "selector-first": the reverse. Voice with consumer
// "starts-at-deadline" has a Type that never settles, so its relation consumer
// only starts from the Voice window timer at the deadline. Correction starts
// when its Type adjudication ends.
async function startConsumerInOrder(h, handle, { entry, order = "consumer-first", consumer = "waiting", typeElapsedMs = 600 }) {
  const started = {};
  const start = () => {
    if (entry === "voice") {
      startVoiceResolution(h, handle, consumer === "starts-at-deadline" ? { outcome: new Promise(() => {}) } : {});
    } else {
      started.resolution = entry === "screen" ? startScreenConsumer(h, handle) : startCorrectionConsumer(h, handle);
      started.wait = watch(h, started.resolution);
    }
  };
  if (entry === "correction") h.clock.setTimeout(start, typeElapsedMs);
  else if (order === "consumer-first") start();
  else {
    // The selectors' deadline timers exist before the consumer side registers anything.
    await h.clock.advanceTo(consumer === "starts-after-fast" ? 967 : entry === "screen" ? 500 : 0);
    start();
  }
  return started;
}

const tierOf = (execution) => execution.selectedProvider.variables.model;
const candidates = (h, stage, tier) => h.executions.filter((execution) =>
  execution.request.operationKind.includes(stage) && (!tier || tierOf(execution) === tier));
const candidate = (h, stage, tier) => {
  const found = candidates(h, stage, tier);
  assert.equal(found.length, 1, `exactly one ${tier} ${stage} candidate`);
  return found[0];
};

// Mirrors requestTaskRelationSplitShadow's result mapping with the real parsers.
function completeCandidate(execution, { rawOutput = "", providerOutcome,
  providerDisposition = rawOutput ? "completed-with-content" : "completed-empty" } = {}) {
  const parsed = providerDisposition !== "completed-with-content"
    ? { ok: false, reason: providerDisposition, errorKind: "provider", evidenceSpansValid: false }
    : execution.request.operationKind === "task-relation-canonical-shadow"
      ? splitModule.parseTaskRelationCanonicalShadowOutput(rawOutput, execution.request)
      : splitModule.parseTaskRelationAffinityOutput(rawOutput, execution.request);
  execution.resolve({
    rawOutput, parsed, providerDisposition, providerOutcome,
    outputHash: rawOutput ? splitModule.hashTaskRelationSplitOutput(rawOutput) : undefined,
    parseDisposition: providerDisposition === "completed-with-content"
      ? parsed.ok ? "valid-json" : parsed.reason
      : `not-run-${providerDisposition}`,
    completedAt: Date.now(),
  });
}
const completeFastAffinity = (h) => {
  for (const execution of candidates(h, "affinity", "fast")) {
    completeCandidate(execution, { rawOutput: execution.request.affinityKind === "child"
      ? FAST_CHILD_UNRELATED : FAST_PARENT_INDEPENDENT });
  }
};

// Controlled synchronous cost around the selector's deadline-timer registration.
// "before": between the selector's first clock read and the registration.
// "during": inside the registration, after the requested delay was computed, so
// the timer is late whatever delay the selector asked for.
function injectSelectorSetupCost(h, { costMs = 0, point = "before", stage = "affinity" } = {}) {
  if (!costMs) return;
  const selector = h.environment.requestTaskRelationProviderCandidates;
  h.environment.requestTaskRelationProviderCandidates = (input, dependencies) => {
    if (!input.request.operationKind.includes(stage)) return selector(input, dependencies);
    let firstRead = true;
    return selector(input, { ...dependencies, clock: {
      now: () => {
        const now = h.clock.now;
        if (point === "before" && firstRead) h.clock.now += costMs;
        firstRead = false;
        return now;
      },
      schedule: (callback, delay) => {
        if (point === "during") h.clock.now += costMs;
        return h.clock.setTimeout(callback, delay);
      },
      cancel: (id) => h.clock.clearTimeout(id),
    } });
  };
}

// Event-loop delay: the loop is blocked across the instant, so every timer due
// there is delivered late and in registration order.
async function advancePast(h, offset, eventLoopDelayMs = 0) {
  if (eventLoopDelayMs) {
    await h.clock.advanceTo(offset - 1);
    h.clock.now = 10_000 + offset + eventLoopDelayMs;
  }
  await h.clock.advanceTo(offset + eventLoopDelayMs + 100);
}

const SETUPS = [
  { name: "setup=0ms", costMs: 0 },
  { name: "setup=2ms-before-registration", costMs: 2, point: "before" },
  { name: "setup=2ms-during-registration", costMs: 2, point: "during" },
];
const EVENT_LOOP_DELAYS = [0, 200];

// One-line failures that carry the observed value, for the combination reports.
// Values are compared as plain data: the Hook callbacks run in their own realm.
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const expectEqual = (actual, expected, what) => assert.deepEqual(plain(actual), plain(expected),
  `${what}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

// What the Canonical stage actually received from the Affinity stage: the
// selected, lease-authorized result and its predecessor identity.
function assertCanonicalConsumedSelectedAffinity(h, { child }) {
  const dispatched = candidates(h, "canonical");
  expectEqual(dispatched.length, 2, "Canonical physical candidates");
  const request = dispatched[0].request;
  assert.equal(dispatched[1].request, request, "both Canonical candidates read the same request");
  const sides = [{ side: "parent", prefix: "taskRelationParentAffinity", raw: FAST_PARENT_INDEPENDENT,
    input: { status: "available", decision: "independent", confidence: 0.95,
      currentEvidenceSpans: [QUESTION], parentEvidenceSpans: [] } }];
  if (child) sides.push({ side: "child", prefix: "taskRelationChildAffinity", raw: FAST_CHILD_UNRELATED,
    input: { status: "available", decision: "unrelated", confidence: 0.95,
      currentEvidenceSpans: [QUESTION], childEvidenceSpans: [] } });
  for (const { side, prefix, raw, input } of sides) {
    expectEqual(h.metadata[`${prefix}SelectedProviderTier`], "fast", `${side} Affinity selected tier`);
    expectEqual(h.metadata[`${prefix}LeaseAuthorized`], true, `${side} Affinity lease`);
    expectEqual(request.semanticPayload.affinity[side], input, `Canonical input ${side} Affinity`);
    expectEqual(request[`${side}PredecessorOperationId`], h.metadata[`${prefix}OperationId`],
      `Canonical ${side} predecessor operation`);
    expectEqual(request[`${side}PredecessorOutputHash`], splitModule.hashTaskRelationSplitOutput(raw),
      `Canonical ${side} predecessor output hash`);
    expectEqual(h.metadata[`${prefix}OutputHash`], request[`${side}PredecessorOutputHash`],
      `${side} Affinity recorded output hash`);
  }
  expectEqual(h.metadata.taskRelationSplitParentPredecessorOperationId, request.parentPredecessorOperationId,
    "recorded Canonical parent predecessor");
  if (!child) {
    expectEqual(request.semanticPayload.affinity.child, undefined, "Canonical input child Affinity");
    expectEqual(request.childPredecessorOperationId, undefined, "Canonical child predecessor operation");
  }
  return request;
}

// A timely Fast Affinity (valid at 879 ms, Intelligent silent) is selected at the
// stage deadline. It must be what Canonical reads and what the final resolver adopts.
async function runAffinityDeadlineHandoff({ entry, order = "selector-first", consumer = "waiting",
  setup = SETUPS[0], eventLoopDelayMs = 0, child = false, typeElapsedMs = 600 }) {
  const h = st183Harness({ child });
  try {
    injectSelectorSetupCost(h, setup);
    const handle = scheduleRelation(h, { sourceKind: entry === "screen" ? "screen" : "voice",
      manualCorrectionOwned: entry === "correction" });
    assert.equal(handle.releaseWindowRequested, true);
    h.clock.setTimeout(() => completeFastAffinity(h), 879);
    const started = await startConsumerInOrder(h, handle, { entry, order, consumer, typeElapsedMs });
    await advancePast(h, STAGE_MS, eventLoopDelayMs);
    const request = assertCanonicalConsumedSelectedAffinity(h, { child });
    const canonicalDispatchedAt = candidate(h, "canonical", "intelligent").dispatchedAt - 10_000;
    completeCandidate(candidate(h, "canonical", "intelligent"), { rawOutput: canonicalOutput("unknown") });
    await h.clock.advanceTo(h.clock.now - 10_000 + 100);
    const outcome = await settledOutcome(h, entry, started);
    const decision = entry === "screen" ? outcome.decision
      : entry === "correction" ? outcome.orderedCorrectionRelation : undefined;
    return { h, handle, request, outcome, decision, canonicalDispatchedAt };
  } catch (error) {
    h.restore();
    throw error;
  }
}

function assertFinalResolverAdoptedAffinity({ h, decision }, { entry, child }) {
  // A valid Canonical "unknown" leaves the decision to the matrix, whose inputs
  // are the Affinity results the consumer adopted. Both reasons below exist only
  // for an adopted parent "independent". Voice inherits the active child's type.
  const reason = entry === "voice" && child
    ? "different-parent-type-independent" : "same-type-independent-new-parent";
  const recorded = (key) => h.metadata[`taskRelationOrderedResolution${key}`];
  expectEqual(recorded("AffinityParentDisposition"), "available", "final parent Affinity");
  expectEqual(recorded("AffinityChildDisposition"), child ? "available" : "no-active-child", "final child Affinity");
  expectEqual(recorded("CanonicalDisposition"), "available", "final Canonical");
  expectEqual([recorded("Stage"), recorded("Reason"), recorded("Relation")],
    ["runtime-matrix", reason, "new-parent"], "final Relation source");
  // Screen and Correction return the decision; a consumer that returns none fails here.
  if (entry !== "voice") {
    expectEqual([decision?.matrix?.parentAffinityDecision, decision?.matrix?.childAffinityDecision],
      ["independent", child ? "unrelated" : undefined], "Affinity adopted by the final resolver");
    expectEqual([decision?.stage, decision?.relation], ["runtime-matrix", "new-parent"], "returned decision");
  }
  if (entry === "voice") {
    expectEqual(h.advisorCalls.length, 1, "Advisor handoffs");
    expectEqual(h.advisorCalls[0].args[7]?.relation, "new-parent", "released settlement relation");
  }
}

async function collectFailures(combinations, run) {
  const failures = [];
  for (const combination of combinations) {
    try {
      await run(combination);
    } catch (error) {
      failures.push(`${combination.label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  return failures;
}
const setupAndDelayCombinations = () => SETUPS.flatMap((setup) => EVENT_LOOP_DELAYS.map((eventLoopDelayMs) =>
  ({ label: `${setup.name} event-loop-delay=${eventLoopDelayMs}ms`, setup, eventLoopDelayMs })));

for (const variant of [
  { entry: "voice", order: "consumer-first", consumer: "waiting" },
  { entry: "voice", order: "consumer-first", consumer: "starts-at-deadline" },
  { entry: "voice", order: "selector-first", consumer: "waiting" },
  { entry: "voice", order: "selector-first", consumer: "starts-at-deadline" },
  { entry: "voice", order: "selector-first", consumer: "starts-after-fast" },
  { entry: "screen", order: "consumer-first", consumer: "waiting" },
  { entry: "screen", order: "selector-first", consumer: "waiting" },
  { entry: "screen", order: "selector-first", consumer: "starts-after-fast" },
]) for (const child of [false, true]) {
  test(`ST183-1 ST183-2 ${variant.entry} ${child ? "child+parent" : "parent-only"} deadline-order=${variant.order} consumer=${variant.consumer}: timely selected Affinity reaches Canonical and the final resolver`, { concurrency: false }, async () => {
    const failures = await collectFailures(setupAndDelayCombinations(), async ({ setup, eventLoopDelayMs }) => {
      const run = await runAffinityDeadlineHandoff({ ...variant, child, setup, eventLoopDelayMs });
      try {
        assertFinalResolverAdoptedAffinity(run, { entry: variant.entry, child });
      } finally { run.h.restore(); }
    });
    assert.deepEqual(failures, [], "missed timely selected Affinity");
  });
}

// Speech Correction schedules Relation before its Type adjudication and enters
// the shared chain when that adjudication ends. Its 3500 ms budget bounds the
// Type adjudication only: it neither ends the Affinity stage nor filters what
// the stage selected. Correction consumes the same stage terminal as Voice and
// Screen, cut off at the stage deadline.
for (const child of [false, true]) for (const typeElapsedMs of [600, 2_000, 2_700, 3_400]) {
  test(`ST183-1 ST183-2 correction ${child ? "child+parent" : "parent-only"} Type=${typeElapsedMs}ms: timely selected Affinity reaches Canonical and the final resolver`, { concurrency: false }, async () => {
    const failures = await collectFailures(setupAndDelayCombinations(), async ({ setup, eventLoopDelayMs }) => {
      const run = await runAffinityDeadlineHandoff({ entry: "correction", typeElapsedMs, child, setup, eventLoopDelayMs });
      try {
        expectEqual(run.outcome.error, undefined, "Correction relation error");
        expectEqual(run.outcome.correctionRelationTerminal, undefined, "Correction relation terminal");
        assertFinalResolverAdoptedAffinity(run, { entry: "correction", child });
      } finally { run.h.restore(); }
    });
    assert.deepEqual(failures, [], "missed timely selected Affinity");
  });
}

// The cost of sharing the stage deadline. With a silent Intelligent Affinity,
// Correction waits to the 4 s stage deadline. Before ST183 it passed what was
// left of its 3500 ms Type budget as its relation budget, so it stopped at an
// earlier cutoff (stage start + 3500 ms - Type time), or did not wait at all,
// and went on without the cached Fast result. The added wait is measured here;
// the result it waits for is always used.
for (const typeElapsedMs of [600, 1_750, 2_000, 2_700, 3_400]) {
  test(`ST183-6 correction Type=${typeElapsedMs}ms: the Affinity wait ends at the stage deadline with the selected result consumed, and at once when the stage already ended`, { concurrency: false }, async (t) => {
    const cutoffAt = CORRECTION_OWNED_ADJUDICATION_BUDGET_MS - typeElapsedMs;
    const deadlinePath = st183Harness();
    try {
      const h = deadlinePath;
      const handle = scheduleRelation(h, { manualCorrectionOwned: true });
      h.clock.setTimeout(() => completeFastAffinity(h), 879);
      h.clock.setTimeout(() => { startCorrectionConsumer(h, handle); }, typeElapsedMs);
      await h.clock.advanceTo(STAGE_MS - 1);
      expectEqual(candidates(h, "canonical").length, 0, "Canonical before the Affinity stage ended");
      await h.clock.advanceTo(STAGE_MS + 50);
      const consumed = candidate(h, "canonical", "intelligent");
      expectEqual(consumed.dispatchedAt - 10_000, STAGE_MS, "Affinity stage consumed at");
      expectEqual(consumed.request.semanticPayload.affinity.parent.status, "available", "Canonical input parent Affinity");
      expectEqual(candidates(h, "canonical").map((execution) => execution.timeoutMs), [STAGE_MS, STAGE_MS],
        "Canonical request budgets");
      const previousWaitEnd = Math.max(typeElapsedMs, cutoffAt);
      t.diagnostic(JSON.stringify({ path: "correction-deadline", typeElapsedMs, previousCorrectionCutoffAt: cutoffAt,
        fastCompletedAt: 879, fastConsumed: true, affinityConsumedAt: STAGE_MS,
        previousAffinityWaitEndedAt: previousWaitEnd, addedWaitMs: STAGE_MS - previousWaitEnd }));
      handle.cancelForegroundWork();
      await h.clock.flush();
    } finally { deadlinePath.restore(); }

    // No fixed wait: a stage that ended before the consumer starts is consumed immediately.
    const h = st183Harness();
    try {
      const handle = scheduleRelation(h, { manualCorrectionOwned: true });
      h.clock.setTimeout(() => completeCandidate(candidate(h, "affinity", "intelligent"),
        { rawOutput: FAST_PARENT_INDEPENDENT }), 50);
      h.clock.setTimeout(() => { startCorrectionConsumer(h, handle); }, typeElapsedMs);
      await h.clock.advanceTo(typeElapsedMs + 50);
      const consumed = candidate(h, "canonical", "intelligent");
      expectEqual(consumed.dispatchedAt - 10_000, typeElapsedMs, "Affinity consumed at");
      expectEqual(consumed.request.semanticPayload.affinity.parent.status, "available", "Canonical input parent Affinity");
      handle.cancelForegroundWork();
      await h.clock.flush();
    } finally { h.restore(); }
  });
}

// Once a stage has ended its terminal says why. "affinity-pending" is only the
// published snapshot's placeholder and must not reach Canonical or the record.
// Voice and Screen run in both callback orders at the deadline, and Voice also
// with a relation consumer that only starts there.
for (const variant of [
  { entry: "voice", order: "consumer-first", consumer: "waiting" },
  { entry: "voice", order: "consumer-first", consumer: "starts-at-deadline" },
  { entry: "voice", order: "selector-first", consumer: "waiting" },
  { entry: "voice", order: "selector-first", consumer: "starts-at-deadline" },
  { entry: "screen", order: "consumer-first", consumer: "waiting" },
  { entry: "screen", order: "selector-first", consumer: "waiting" },
  { entry: "correction" },
]) {
  const { entry } = variant;
  const name = entry === "correction" ? entry : `${entry} deadline-order=${variant.order} consumer=${variant.consumer}`;
  test(`ST183-2 ${name}: an ended Affinity stage is never consumed as affinity-pending`, { concurrency: false }, async () => {
    const h = st183Harness();
    try {
      const handle = scheduleEntry(h, entry);
      const started = await startConsumerInOrder(h, handle, variant);
      // No candidate ever returns: the selector ends the stage at the deadline.
      await h.clock.advanceTo(STAGE_MS + 100);
      const request = candidate(h, "canonical", "intelligent").request;
      expectEqual(request.semanticPayload.affinity.parent, { status: "unknown" }, "Canonical input parent Affinity");
      expectEqual(request.parentPredecessorOperationId, h.metadata.taskRelationParentAffinityOperationId,
        "Canonical parent predecessor operation");
      expectEqual(request.parentPredecessorOutputHash, undefined, "Canonical parent predecessor output hash");
      expectEqual(h.metadata.taskRelationParentAffinityDisposition, "candidate-deadline-expired", "Affinity stage terminal");
      await h.clock.advanceTo(2 * STAGE_MS + 100);
      expectEqual(entryWaitEnded(h, entry, started), true, "wait over");
      await started.resolution;
      expectEqual(h.metadata.taskRelationOrderedResolutionAffinityParentDisposition, "candidate-deadline-expired",
        "final parent Affinity");
      expectEqual(h.metadata.taskRelationOrderedResolutionCanonicalDisposition, "candidate-deadline-expired",
        "final Canonical");
      expectEqual(h.metadata.taskRelationOrderedResolutionStage, "source-topology-null-hypothesis", "final Relation source");
      expectEqual(Object.values(h.metadata).includes("affinity-pending"), false, "recorded affinity-pending");
    } finally { h.restore(); }
  });
}

// A scripted parent-only Affinity stage through one entry's real consumer.
// `script` lists [tier, completes at, raw output]; the last entry is the
// candidate the stage selects. Runs until Canonical has been dispatched.
async function runEntryAffinity({ entry, order, consumer, typeElapsedMs, script, setup = SETUPS[0], eventLoopDelayMs = 0,
  until, harness }) {
  const h = st183Harness(harness);
  try {
    injectSelectorSetupCost(h, setup);
    const handle = scheduleEntry(h, entry);
    for (const [tier, completesAt, rawOutput = FAST_PARENT_INDEPENDENT] of script) {
      h.clock.setTimeout(() => completeCandidate(candidate(h, "affinity", tier), { rawOutput }), completesAt);
    }
    const started = await startConsumerInOrder(h, handle, { entry, order, consumer, typeElapsedMs });
    if (until === STAGE_MS) await advancePast(h, STAGE_MS, eventLoopDelayMs);
    else await h.clock.advanceTo(until);
    const dispatched = candidate(h, "canonical", "intelligent");
    const finish = async () => {
      completeCandidate(dispatched, { rawOutput: canonicalOutput("unknown") });
      await h.clock.advanceTo(h.clock.now - 10_000 + 100);
      return settledOutcome(h, entry, started);
    };
    return { h, handle, started, request: dispatched.request, dispatchedAt: dispatched.dispatchedAt - 10_000, finish };
  } catch (error) {
    h.restore();
    throw error;
  }
}
// In each of the Correction runs below the result completes after the cutoff
// Correction applied before ST183 (stage start + 3500 ms - Type time) and before
// the stage deadline: what the stage selects is what Canonical reads.
const runCorrectionAffinity = (options) => runEntryAffinity({ entry: "correction", ...options });
const INDEPENDENT_INPUT = { status: "available", decision: "independent", confidence: 0.95,
  currentEvidenceSpans: [QUESTION], parentEvidenceSpans: [] };
// The Canonical request read the candidate the stage selected: its decision and
// its predecessor identity, by the hash of that candidate's own raw output.
function assertSelectedAffinityConsumed({ h, request }, selectedTier,
  { rawOutput = FAST_PARENT_INDEPENDENT, input = INDEPENDENT_INPUT } = {}) {
  const m = h.metadata;
  expectEqual([m.taskRelationParentAffinitySelectedProviderTier, m.taskRelationParentAffinityLeaseAuthorized],
    [selectedTier, true], "selected and authorized Affinity");
  expectEqual(request.semanticPayload.affinity.parent, input, "Canonical input parent Affinity");
  expectEqual([request.parentPredecessorOperationId, request.parentPredecessorOutputHash],
    [m.taskRelationParentAffinityOperationId, splitModule.hashTaskRelationSplitOutput(rawOutput)],
    "Canonical parent predecessor");
}
const assertCorrectionConsumed = assertSelectedAffinityConsumed;

for (const [name, typeElapsedMs, script, selectedTier] of [
  // Type 600 ms: the former Correction cutoff was 2900 ms after the stage start.
  ["an Intelligent result valid at 3200 ms with Type=600 ms", 600, [["intelligent", 3_200]], "intelligent"],
  // Type 1500 ms: 2000 ms. The selector prefers the later Intelligent over the cached Fast.
  ["a Fast result at 879 ms superseded by an Intelligent result at 2500 ms with Type=1500 ms", 1_500,
    [["fast", 879], ["intelligent", 2_500]], "intelligent"],
  // Type 100 ms: 3400 ms.
  ["an Intelligent result valid at 3450 ms with Type=100 ms", 100, [["intelligent", 3_450]], "intelligent"],
]) {
  test(`ST183-1 ST183-2 correction: ${name} is consumed although it completed after the former Correction cutoff`, { concurrency: false }, async () => {
    const consumedAt = script.at(-1)[1];
    const run = await runCorrectionAffinity({ typeElapsedMs, script, until: consumedAt + 50 });
    const { h } = run;
    try {
      expectEqual(run.dispatchedAt, consumedAt, "Affinity consumed when the stage selected it");
      assertCorrectionConsumed(run, selectedTier);
      const outcome = await run.finish();
      expectEqual([outcome.error, outcome.correctionRelationTerminal], [undefined, undefined], "Correction relation terminal");
      const recorded = (key) => h.metadata[`taskRelationOrderedResolution${key}`];
      // The completion-time cutoff of a stage terminal is the stage deadline.
      expectEqual(recorded("AffinityCutoffAt"), 10_000 + STAGE_MS, "Affinity cutoff");
      expectEqual([recorded("AffinityParentDisposition"), recorded("Stage"), recorded("Relation")],
        ["available", "runtime-matrix", "new-parent"], "final Relation source");
      expectEqual(outcome.orderedCorrectionRelation.matrix.parentAffinityDecision, "independent",
        "Affinity adopted by the final resolver");
      expectEqual(Object.values(h.metadata).includes("affinity-settled-after-cutoff"), false,
        "a selected candidate recorded as settled after the cutoff");
    } finally { h.restore(); }
  });
}

for (const tier of ["fast", "intelligent"]) for (const variant of [
  { entry: "voice", order: "consumer-first" }, { entry: "voice", order: "selector-first" },
  { entry: "screen", order: "consumer-first" }, { entry: "screen", order: "selector-first" },
  { entry: "correction", typeElapsedMs: 100 },
]) {
  const name = variant.entry === "correction" ? variant.entry : `${variant.entry} deadline-order=${variant.order}`;
  test(`ST183-1 ${name}: ${tier === "intelligent" ? "an Intelligent" : "a Fast"} candidate valid 1 ms before the stage deadline is consumed`, { concurrency: false }, async () => {
    const failures = await collectFailures(setupAndDelayCombinations(), async ({ setup, eventLoopDelayMs }) => {
      const run = await runEntryAffinity({ ...variant, script: [[tier, STAGE_MS - 1]], setup, eventLoopDelayMs,
        until: STAGE_MS });
      try {
        assertSelectedAffinityConsumed(run, tier);
        expectEqual((await settledValue(run.h, run.handle.affinityOutcome, "Affinity stage terminal")).parent.settledAt,
          10_000 + STAGE_MS - 1, "selected candidate completed at");
        await run.finish();
        // A valid Canonical "unknown" hands the decision to the matrix: it adopted the same Affinity.
        const recorded = (key) => run.h.metadata[`taskRelationOrderedResolution${key}`];
        expectEqual([recorded("AffinityParentDisposition"), recorded("Stage"), recorded("Reason"), recorded("Relation")],
          ["available", "runtime-matrix", "same-type-independent-new-parent", "new-parent"], "final Relation source");
        if (variant.entry === "voice") expectEqual(run.h.advisorCalls.map((call) => call.args[7]?.relation), ["new-parent"],
          "released settlement relation");
      } finally { run.h.restore(); }
    });
    assert.deepEqual(failures, [], "missed timely selected Affinity");
  });
}

// Characterization case 4: a Fast "independent" is cached at 879 ms and a timely
// Intelligent result, valid at 3500 ms, replaces it. The stage ends there; what
// Canonical reads and what the final resolver adopts is the Intelligent result.
const INTELLIGENT_PARENT_RELATED = JSON.stringify({ v: 1, d: "r", c: 0.8, q: QUESTION, b: PARENT });
for (const entry of ["voice", "screen"]) for (const order of ["consumer-first", "selector-first"]) {
  test(`ST183-1 ST183-2 ${entry} deadline-order=${order}: an Intelligent Affinity valid at 3500 ms over a cached Fast is what Canonical and the final resolver consume`, { concurrency: false }, async () => {
    const failures = await collectFailures(SETUPS.map((setup) => ({ label: setup.name, setup })), async ({ setup }) => {
      const run = await runEntryAffinity({ entry, order, setup, until: 3_600,
        script: [["fast", 879], ["intelligent", 3_500, INTELLIGENT_PARENT_RELATED]] });
      const { h } = run;
      try {
        expectEqual(run.dispatchedAt, 3_500, "Affinity consumed when the stage selected it");
        expectEqual(h.metadata.taskRelationParentAffinitySelectedAt, 13_500, "Affinity selected at");
        // The request carries a confidence of 0.8, below the early-release threshold, so Canonical is needed.
        assertSelectedAffinityConsumed(run, "intelligent", { rawOutput: INTELLIGENT_PARENT_RELATED,
          input: { status: "available", decision: "related", confidence: 0.8,
            currentEvidenceSpans: [QUESTION], parentEvidenceSpans: [PARENT] } });
        expectEqual(h.metadata.taskRelationParentAffinityOutputHash,
          splitModule.hashTaskRelationSplitOutput(INTELLIGENT_PARENT_RELATED), "recorded Affinity output hash");
        expectEqual(candidate(h, "affinity", "fast").signal.aborted, true, "nothing is left running in the ended stage");
        const outcome = await run.finish();
        const recorded = (key) => h.metadata[`taskRelationOrderedResolution${key}`];
        // The cached Fast "independent" would have given new-parent.
        expectEqual([recorded("AffinityParentDisposition"), recorded("Stage"), recorded("Reason"), recorded("Relation")],
          ["available", "runtime-matrix", "same-type-parent-related", "followup-parent"], "final Relation source");
        if (entry === "screen") expectEqual(outcome.decision.matrix.parentAffinityDecision, "related",
          "Affinity adopted by the final resolver");
        else expectEqual(h.advisorCalls.map((call) => call.args[7]?.relation), ["followup-parent"], "released settlement relation");
        expectEqual(h.executions.length, 4, "physical model requests");
      } finally { h.restore(); }
    });
    assert.deepEqual(failures, [], "missed timely Intelligent Affinity");
  });
}

// ---- ST183-1 / ST183-7, P1: the cost of the observation sink does not decide the handoff ----
//
// The Hook's observation sink runs synchronously inside the selector's
// completion callback. With Recording on its cost is real time. A candidate whose
// callback began before the deadline is accepted at that time whatever the sink
// then costs, so the handoff is the same with a free and with a costly recorder.
for (const entry of ["voice", "screen", "correction"]) for (const tier of ["fast", "intelligent"]) {
  test(`ST183-1 ST183-7 ${entry}: ${tier === "intelligent" ? "an Intelligent" : "a Fast"} candidate valid 1 ms before the stage deadline is consumed whatever the Recording sink costs`, { concurrency: false }, async () => {
    const handoffs = [];
    for (const sinkCostMs of [0, 1, 5]) {
      const run = await runEntryAffinity({ entry, typeElapsedMs: 100, script: [[tier, STAGE_MS - 1]], until: STAGE_MS,
        harness: { recording: true, recordingSinkCostMs: (kind, row) =>
          (kind === "lifecycle" && row.taskRelationCandidateEvent === "completed" ? sinkCostMs : 0) } });
      const { h, request } = run;
      try {
        assertSelectedAffinityConsumed(run, tier);
        const completed = h.recorded.filter((row) => row.kind === "lifecycle" && row.taskRelationCandidateEvent === "completed" &&
          row.taskRelationCandidateRequestId === `${h.metadata.taskRelationParentAffinityOperationId}:${tier}`);
        expectEqual(completed.map((row) => row.at), [10_000 + STAGE_MS - 1], `sink=${sinkCostMs}ms: observed completion time`);
        const terminal = await settledValue(h, run.handle.affinityOutcome, "Affinity stage terminal");
        expectEqual(terminal.parent.settledAt, 10_000 + STAGE_MS - 1, `sink=${sinkCostMs}ms: recorded completion time`);
        await run.finish();
        const recorded = (key) => h.metadata[`taskRelationOrderedResolution${key}`];
        handoffs.push(plain({ affinity: request.semanticPayload.affinity, settledAt: terminal.parent.settledAt,
          predecessor: [request.parentPredecessorOperationId, request.parentPredecessorOutputHash],
          selected: [h.metadata.taskRelationParentAffinitySelectedProviderTier, h.metadata.taskRelationParentAffinityDisposition],
          final: [recorded("AffinityParentDisposition"), recorded("Stage"), recorded("Reason"), recorded("Relation")] }));
      } finally { h.restore(); }
    }
    assert.deepEqual(handoffs[1], handoffs[0], "a recorder that costs 1 ms changes nothing in the handoff");
    assert.deepEqual(handoffs[2], handoffs[0], "a recorder that costs 5 ms changes nothing in the handoff");
    expectEqual(handoffs[0].final, ["available", "runtime-matrix", "same-type-independent-new-parent", "new-parent"],
      "final Relation source");
  });
}

// The stage deadline is still a deadline: nothing that completes after it is used.
test("ST183-2 ST183-6 correction: a candidate completing after the stage deadline is not consumed", { concurrency: false }, async () => {
  const run = await runCorrectionAffinity({ typeElapsedMs: 600, script: [["fast", 4_050]], until: 4_100 });
  const { h, request } = run;
  try {
    expectEqual(run.dispatchedAt, STAGE_MS, "Affinity stage consumed at its deadline");
    expectEqual(request.semanticPayload.affinity.parent, { status: "unknown" }, "Canonical input parent Affinity");
    expectEqual(request.parentPredecessorOutputHash, undefined, "Canonical parent predecessor output hash");
    expectEqual([h.metadata.taskRelationParentAffinitySelectedProviderTier, h.metadata.taskRelationParentAffinityDisposition],
      [undefined, "candidate-deadline-expired"], "Affinity stage terminal");
    await run.finish();
    expectEqual(h.metadata.taskRelationOrderedResolutionAffinityParentDisposition, "candidate-deadline-expired",
      "final parent Affinity");
  } finally { h.restore(); }
});

// ---- ST183-6: the three entries grant the same two-stage foreground window ----
//
// A confident parent "related" resolves the relation from the Affinity terminal:
// no Canonical is needed. Voice, Screen and Correction each pass the shared
// window of two stages (2 x 4 s from the Affinity stage start) and the consumer
// keeps the window its caller gave. So the recorded budget, deadline, cutoff,
// remaining time and late-work flag describe the same window for the same event
// in all three entries, and the foreground work of a relation resolved in time
// is not cancelled, also when the stage's own deadline timer resolved it.
// Correction's 3500 ms budget bounds its Type adjudication only.
async function runAffinityResolvedRelation({ entry, typeElapsedMs = 600, script }) {
  const h = st183Harness();
  try {
    const handle = scheduleEntry(h, entry);
    const cancelForegroundWork = handle.cancelForegroundWork;
    const cancelledAt = [];
    handle.cancelForegroundWork = () => { cancelledAt.push(h.clock.now - 10_000); return cancelForegroundWork(); };
    for (const [tier, completesAt] of script) {
      h.clock.setTimeout(() => completeCandidate(candidate(h, "affinity", tier), { rawOutput: PARENT_RELATED }), completesAt);
    }
    const started = await startConsumerInOrder(h, handle, { entry, typeElapsedMs });
    await h.clock.advanceTo(STAGE_MS + 100);
    const outcome = await settledOutcome(h, entry, started);
    const m = h.metadata;
    const record = { waitBudgetMs: m.taskRelationOrderedResolutionWaitBudgetMs,
      deadlineAt: m.taskRelationOrderedResolutionDeadlineAt - 10_000,
      affinityCutoffAt: m.taskRelationOrderedResolutionAffinityCutoffAt - 10_000,
      canonicalDeadlineAt: m.taskRelationOrderedResolutionCanonicalDeadlineAt,
      foregroundDeadlineAt: m.orderedSettlementForegroundDeadlineAt - 10_000,
      foregroundBudgetMs: m.orderedSettlementForegroundBudgetMs,
      remainingMs: m.taskRelationOrderedResolutionRemainingMs, waitMs: m.taskRelationOrderedResolutionWaitMs,
      waitDisposition: m.taskRelationOrderedResolutionWaitDisposition,
      lateWorkCancelled: m.taskRelationOrderedResolutionLateWorkCancelled };
    const relation = entry === "voice" ? h.advisorCalls[0]?.args[7]?.relation
      : entry === "screen" ? outcome.decision.relation : outcome.orderedCorrectionRelation?.relation;
    // When the consumer recorded its resolution, in ms from the Affinity stage start.
    const resolvedAt = h.events.find((event) => event.metadata &&
      "taskRelationOrderedResolutionRemainingMs" in event.metadata)?.at;
    const stageOperationCurrent =
      relationRuntime(h, "parent").getCurrentOperationId() === m.taskRelationParentAffinityOperationId;
    return { h, handle, outcome, cancelledAt, record, relation, resolvedAt, stageOperationCurrent };
  } catch (error) {
    h.restore();
    throw error;
  }
}
function expectResolvedFromAffinityTerminal({ h, relation }) {
  const recorded = (key) => h.metadata[`taskRelationOrderedResolution${key}`];
  expectEqual([recorded("AffinityParentDisposition"), recorded("CanonicalDisposition"), recorded("Stage"), recorded("Reason"),
    recorded("Relation")], ["available", undefined, "runtime-matrix", "same-type-parent-related", "followup-parent"],
  "final Relation source");
  expectEqual(relation, "followup-parent", "released relation");
  expectEqual(candidates(h, "canonical").length, 0, "Canonical requests");
}
// What an entry recorded about its foreground window, independent of when its
// own consumer started: the window's end is the resolution time plus what was
// then left of it.
const foregroundWindow = ({ record, resolvedAt, cancelledAt, stageOperationCurrent }) => ({ ...record,
  remainingMs: undefined, waitMs: undefined, windowEndsAt: resolvedAt + record.remainingMs, cancelledAt, stageOperationCurrent });

// Correction's consumer starts when its Type adjudication ends: 600 ms here.
const CORRECTION_TYPE_MS = 600;
for (const [name, script, resolvedAt] of [
  ["before the stage deadline, by an Intelligent result valid at 3200 ms", [["intelligent", 3_200]], 3_200],
  ["before its consumer starts, by an Intelligent result valid at 300 ms", [["intelligent", 300]], CORRECTION_TYPE_MS],
  // The stage's own deadline timer selects the cached Fast: a timely result, consumed at the deadline.
  ["exactly at the stage deadline, by a Fast result cached at 879 ms", [["fast", 879]], STAGE_MS],
]) {
  test(`ST183-6 correction, a relation resolved from the Affinity terminal ${name}: the recorded foreground window is the one Voice and Screen record, and nothing is cancelled`, { concurrency: false }, async () => {
    const correction = await runAffinityResolvedRelation({ entry: "correction", typeElapsedMs: CORRECTION_TYPE_MS, script });
    try {
      expectEqual([correction.outcome.error, correction.outcome.correctionRelationTerminal], [undefined, undefined],
        "Correction relation terminal");
      expectResolvedFromAffinityTerminal(correction);
      expectEqual(correction.resolvedAt, resolvedAt, "resolved at");
      // Budget 8 s, deadline = stage start + 8 s, cutoff = stage deadline, remaining = 8 s - elapsed.
      expectEqual(correction.record, { waitBudgetMs: 2 * STAGE_MS, deadlineAt: 2 * STAGE_MS, affinityCutoffAt: STAGE_MS,
        canonicalDeadlineAt: undefined, foregroundDeadlineAt: 2 * STAGE_MS, foregroundBudgetMs: 2 * STAGE_MS,
        remainingMs: 2 * STAGE_MS - resolvedAt, waitMs: resolvedAt - CORRECTION_TYPE_MS, waitDisposition: "affinity-settled",
        lateWorkCancelled: false }, "recorded foreground window");
      expectEqual(correction.cancelledAt, [], "cancelForegroundWork calls");
      expectEqual(correction.stageOperationCurrent, true, "the consumed Affinity operation is still the runtime's current one");
    } finally { correction.h.restore(); }
    // The same event through the Voice and Screen entries.
    for (const entry of ["voice", "screen"]) {
      const other = await runAffinityResolvedRelation({ entry, script });
      try {
        expectResolvedFromAffinityTerminal(other);
        expectEqual(foregroundWindow(correction), foregroundWindow(other), `Correction's recorded window against ${entry}'s`);
      } finally { other.h.restore(); }
    }
  });
}

for (const entry of ["voice", "screen"]) {
  test(`ST183-6 ${entry}: a relation resolved from the Affinity terminal keeps the two-stage foreground window and cancels nothing`, { concurrency: false }, async () => {
    // Voice starts consuming when Type settles (50 ms); Screen at once.
    const startsAt = entry === "voice" ? 50 : 0;
    for (const [script, resolvedAt] of [[[["intelligent", 3_200]], 3_200], [[["fast", 879]], STAGE_MS]]) {
      const run = await runAffinityResolvedRelation({ entry, script });
      try {
        expectResolvedFromAffinityTerminal(run);
        expectEqual(run.record, { waitBudgetMs: 2 * STAGE_MS, deadlineAt: 2 * STAGE_MS, affinityCutoffAt: STAGE_MS,
          canonicalDeadlineAt: undefined, foregroundDeadlineAt: 2 * STAGE_MS, foregroundBudgetMs: 2 * STAGE_MS,
          remainingMs: 2 * STAGE_MS - resolvedAt, waitMs: resolvedAt - startsAt, waitDisposition: "affinity-settled",
          lateWorkCancelled: false }, `resolved at ${resolvedAt} ms: recorded foreground window`);
        expectEqual(run.cancelledAt, [], `resolved at ${resolvedAt} ms: cancelForegroundWork calls`);
        if (entry === "voice") expectEqual(run.h.advisorCalls.map((call) => call.at), [resolvedAt], "Advisor handoff at");
      } finally { run.h.restore(); }
    }
  });
}

// A needed Canonical keeps its own stage budget inside that window: 4 s from its
// enqueue, whenever the Affinity stage ended. With a silent Canonical the wait
// ends exactly there. `enqueuedAt` is in ms from the Affinity stage start.
for (const [name, typeElapsedMs, script, enqueuedAt] of [
  ["Type=600 ms and an Intelligent Affinity valid at 300 ms", 600, [["intelligent", 300]], 600],
  ["Type=3400 ms and an Intelligent Affinity valid at 300 ms", 3_400, [["intelligent", 300]], 3_400],
  ["Type=600 ms and a Fast Affinity cached at 879 ms, selected at the stage deadline", 600, [["fast", 879]], STAGE_MS],
]) {
  test(`ST183-6 correction, ${name}: a needed Canonical gets at most 4 s from its enqueue`, { concurrency: false }, async () => {
    const run = await runCorrectionAffinity({ typeElapsedMs, script, until: enqueuedAt + 50 });
    const { h, started } = run;
    try {
      const deadline = enqueuedAt + STAGE_MS;
      expectEqual(run.dispatchedAt, enqueuedAt, "Canonical enqueued at");
      expectEqual(run.request.semanticPayload.affinity.parent, INDEPENDENT_INPUT, "Canonical input parent Affinity");
      expectEqual(candidates(h, "canonical").map((execution) => [execution.timeoutMs, execution.dispatchedAt - 10_000 + execution.timeoutMs]),
        [[STAGE_MS, deadline], [STAGE_MS, deadline]], "Canonical request budgets and deadlines");
      // Canonical never answers: its own selector ends the stage, and the wait, at that deadline.
      await h.clock.advanceTo(deadline - 1);
      expectEqual(entryWaitEnded(h, "correction", started), false, "wait still open 1 ms before the Canonical deadline");
      await h.clock.advanceTo(deadline);
      const outcome = await settledOutcome(h, "correction", started);
      expectEqual([outcome.error, outcome.correctionRelationTerminal], [undefined, undefined], "Correction relation terminal");
      const recorded = (key) => h.metadata[`taskRelationOrderedResolution${key}`];
      expectEqual([recorded("CanonicalDeadlineAt") - 10_000, recorded("CanonicalBudgetMs"), recorded("AffinityCutoffAt") - 10_000,
        recorded("DeadlineAt") - 10_000, recorded("WaitMs")], [deadline, STAGE_MS, STAGE_MS, deadline, deadline - typeElapsedMs],
      "recorded Canonical deadline, Canonical budget, Affinity cutoff, foreground deadline and wait");
      expectEqual(deadline <= 2 * STAGE_MS, true, "the relation phase ends inside the two-stage window");
      expectEqual([recorded("AffinityParentDisposition"), recorded("CanonicalDisposition"), recorded("Stage"), recorded("Relation")],
        ["available", "candidate-deadline-expired", "runtime-matrix", "new-parent"], "final Relation source");
      expectEqual(outcome.orderedCorrectionRelation?.relation, "new-parent", "returned decision");
    } finally { h.restore(); }
  });
}

// ---- ST183-3: the Canonical stage hands its terminal to the final resolver ----

// Intelligent Affinity "independent" at 300 ms needs Canonical at once. Voice and
// Screen are already waiting, so their Canonical stage runs 300..4300 ms. The
// Correction consumer starts when its Type adjudication ends, and its Canonical
// stage runs for 4 s from there. `script` drives the two Canonical candidates at
// [tier, ms after the Affinity stage start, raw output].
async function runCanonicalStage({ entry, typeElapsedMs = 600, setup = SETUPS[0], eventLoopDelayMs = 0, script, endsAtDeadline }) {
  const h = st183Harness();
  try {
    injectSelectorSetupCost(h, { ...setup, stage: "canonical" });
    const handle = scheduleEntry(h, entry);
    const started = await startConsumerInOrder(h, handle, { entry, typeElapsedMs });
    h.clock.setTimeout(() => completeCandidate(candidate(h, "affinity", "intelligent"),
      { rawOutput: FAST_PARENT_INDEPENDENT }), 300);
    const canonicalEnqueuedAt = entry === "correction" ? typeElapsedMs : 300;
    const deadline = canonicalEnqueuedAt + STAGE_MS;
    await h.clock.advanceTo(canonicalEnqueuedAt + 100);
    expectEqual(candidates(h, "canonical").length, 2, "Canonical physical candidates");
    expectEqual(candidates(h, "canonical").map((execution) => execution.dispatchedAt - 10_000 + execution.timeoutMs),
      [deadline, deadline], "Canonical stage deadline: 4 s from its enqueue");
    for (const [tier, at, rawOutput] of script) {
      h.clock.setTimeout(() => completeCandidate(candidate(h, "canonical", tier), { rawOutput }), at - canonicalEnqueuedAt - 100);
    }
    await h.clock.advanceTo(deadline - 1);
    const openBeforeDeadline = !entryWaitEnded(h, entry, started);
    if (endsAtDeadline) await advancePast(h, deadline, eventLoopDelayMs);
    const outcome = await settledOutcome(h, entry, started);
    return { h, handle, outcome, openBeforeDeadline, canonicalEnqueuedAt,
      decision: entry === "correction" ? outcome.orderedCorrectionRelation : outcome?.decision };
  } catch (error) {
    h.restore();
    throw error;
  }
}

// `selectedRawOutput` is the raw output of the candidate the stage selected. The
// recorded Canonical is identified by that output's hash and by the physical
// request that produced it, not by two fields written from one result.
function assertFinalRelation({ h, decision, outcome }, { entry, selectedTier, selectedRawOutput, source, canonicalRelation }) {
  const m = h.metadata;
  const recorded = (key) => m[`taskRelationOrderedResolution${key}`];
  const expectedHash = splitModule.hashTaskRelationSplitOutput(selectedRawOutput);
  expectEqual(m.taskRelationSplitCanonicalSelectedProviderTier, selectedTier, "Canonical selected tier");
  expectEqual(typeof m.taskRelationSplitCanonicalOperationId, "string", "Canonical operation id recorded");
  expectEqual(m.taskRelationSplitCanonicalSelectedRequestId, `${m.taskRelationSplitCanonicalOperationId}:${selectedTier}`,
    "Canonical selected request id");
  expectEqual(candidate(h, "canonical", selectedTier).executionIdentity.requestId, m.taskRelationSplitCanonicalSelectedRequestId,
    "the selected request is that tier's physical request");
  expectEqual(m.taskRelationSplitCanonicalOutputHash, expectedHash, "recorded Canonical output hash");
  expectEqual([m.taskRelationSplitCanonicalLeaseAuthorized,
    m.taskRelationSplitCanonicalPredecessorsAuthorized], [true, true], "Canonical lease and predecessors");
  expectEqual(m.taskRelationSplitCanonicalRelation, canonicalRelation, "recorded Canonical relation");
  expectEqual(recorded("CanonicalDisposition"), "available", "final Canonical");
  expectEqual([recorded("Stage"), recorded("Reason"), recorded("Relation")], source, "final Relation source");
  // Screen and Correction return the decision; a consumer that returns none fails here.
  if (entry !== "voice") expectEqual([decision?.stage, decision?.reason, decision?.relation], source, "returned decision");
  if (entry === "screen") {
    expectEqual(outcome.canonicalOutcome?.adjudication?.relation, canonicalRelation, "Canonical adopted by the final resolver");
    expectEqual(outcome.canonicalOutcome?.operationId, m.taskRelationSplitCanonicalOperationId,
      "adopted Canonical operation");
    expectEqual(outcome.canonicalOutcome?.outputHash, expectedHash, "adopted Canonical output hash");
  }
  if (entry === "voice") {
    expectEqual(h.advisorCalls.length, 1, "Advisor handoffs");
    expectEqual(h.advisorCalls[0].args[7]?.relation, source[2], "released settlement relation");
  }
  if (entry === "correction") {
    expectEqual([outcome.error, outcome.correctionRelationTerminal], [undefined, undefined], "Correction relation terminal");
  }
  expectEqual(h.executions.length, 4, "physical model requests");
}

const CANONICAL_FROM_FAST = ["canonical-relation", "canonical-authorized", "followup-parent"];
// Voice and Screen wait from the start; Correction enters after its Type adjudication.
for (const variant of [{ entry: "voice" }, { entry: "screen" },
  { entry: "correction", typeElapsedMs: 600 }, { entry: "correction", typeElapsedMs: 2_000 }]) {
  const { entry } = variant;
  const name = entry === "correction" ? `correction Type=${variant.typeElapsedMs}ms` : entry;
  const canonicalEnqueuedAt = variant.typeElapsedMs ?? 300;
  test(`ST183-3 ${name}: a valid Fast Canonical cached before the cutoff is consumed by the final resolver`, { concurrency: false }, async () => {
    const failures = await collectFailures(setupAndDelayCombinations(), async ({ setup, eventLoopDelayMs }) => {
      const run = await runCanonicalStage({ ...variant, setup, eventLoopDelayMs, endsAtDeadline: true,
        script: [["fast", canonicalEnqueuedAt + 600, canonicalOutput("followup-parent")]] });
      try {
        expectEqual(run.openBeforeDeadline, true, "wait still open 1 ms before the Canonical deadline");
        assertFinalRelation(run, { entry, selectedTier: "fast", selectedRawOutput: canonicalOutput("followup-parent"),
          source: CANONICAL_FROM_FAST, canonicalRelation: "followup-parent" });
        expectEqual(candidate(run.h, "canonical", "intelligent").signal.aborted, true,
          "remaining Canonical request cancelled at stage end");
      } finally { run.h.restore(); }
    });
    assert.deepEqual(failures, [], "missed cached Fast Canonical");
  });
}
for (const entry of ["voice", "screen"]) {
  test(`ST183-3 ${entry}: a timely valid Intelligent Canonical wins over the cached Fast`, { concurrency: false }, async () => {
    const run = await runCanonicalStage({ entry, script: [
      ["fast", 900, canonicalOutput("followup-parent")], ["intelligent", 3_300, canonicalOutput("new-parent")]] });
    try {
      assertFinalRelation(run, { entry, selectedTier: "intelligent", selectedRawOutput: canonicalOutput("new-parent"),
        source: ["canonical-relation", "canonical-authorized", "new-parent"], canonicalRelation: "new-parent" });
    } finally { run.h.restore(); }
  });

  test(`ST183-3 ${entry}: a valid Intelligent unknown is final for the stage and triggers no cross-model vote`, { concurrency: false }, async () => {
    const run = await runCanonicalStage({ entry, script: [
      ["fast", 900, canonicalOutput("followup-parent")], ["intelligent", 1_300, canonicalOutput("unknown")]] });
    try {
      // The cached Fast "followup-parent" is not consulted: the matrix decides.
      assertFinalRelation(run, { entry, selectedTier: "intelligent", selectedRawOutput: canonicalOutput("unknown"),
        source: ["runtime-matrix", "same-type-independent-new-parent", "new-parent"], canonicalRelation: "unknown" });
      expectEqual(candidate(run.h, "canonical", "fast").signal.aborted, true, "Fast Canonical cancelled");
    } finally { run.h.restore(); }
  });

  test(`ST183-3 ${entry}: an invalid Intelligent Canonical falls to the cached Fast without waiting for the deadline`, { concurrency: false }, async () => {
    const run = await runCanonicalStage({ entry, script: [
      ["fast", 900, canonicalOutput("followup-parent")], ["intelligent", 1_300, "not json"]] });
    try {
      assertFinalRelation(run, { entry, selectedTier: "fast", selectedRawOutput: canonicalOutput("followup-parent"),
        source: CANONICAL_FROM_FAST, canonicalRelation: "followup-parent" });
      expectEqual(run.h.metadata.taskRelationSplitCanonicalSelectedAt, 11_300, "Canonical selected at");
    } finally { run.h.restore(); }
  });
}

// ---- ST183-4: every stage exit settles the stage terminal by itself ----
//
// These observe the stage terminals directly: handle.affinityOutcome and the
// Promise returned by handle.startCanonical. No Ordered consumer runs, so no
// outer wait can turn a missing settlement green.

const failedOutcome = (failureClass) => ({ status: "failed", failureClass, safeErrorSummary: `summary-${failureClass}` });
const saturateAdmission = (h) => {
  for (const providerTier of ["fast", "intelligent"]) for (let slot = 0; slot < 3; slot += 1) {
    void h.environment.runtimeInferenceProviderAdmissionRef.current.run({ operationId: `occupied-${providerTier}-${slot}`,
      lane: "critical", providerTier, signal: new AbortController().signal, execute: () => new Promise(() => {}) });
  }
};
const relationRuntime = (h, stage) => h.environment[{ parent: "taskRelationParentAffinityRuntimeRef",
  child: "taskRelationChildAffinityRuntimeRef", canonical: "taskRelationCanonicalShadowRuntimeRef" }[stage]].current;
// Stop is the Hook's own invalidateRuntimeWork, extracted from the source and run
// against this harness's runtime epoch and its three real Relation runtimes.
// Every other ref it touches belongs to work the harness does not run; those
// are inert here.
const invalidateRuntimeWorkSource = findNamedDeclaration(sourceFile, "invalidateRuntimeWork")
  .initializer.arguments[0].getText(sourceFile);
const RELATION_RUNTIME_REFS = ["taskRelationChildAffinityRuntimeRef", "taskRelationParentAffinityRuntimeRef",
  "taskRelationCanonicalShadowRuntimeRef"];
const invalidateRuntimeWorkRefs = (() => {
  const refs = new Set();
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text.endsWith("Ref")) refs.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(parse(invalidateRuntimeWorkSource));
  return [...refs];
})();
const stop = (h) => {
  const inert = new Proxy({}, { get: () => () => undefined });
  const context = vm.createContext({
    ...Object.fromEntries(invalidateRuntimeWorkRefs.map((name) => [name, { current: inert }])),
    runtimeEpochRef: h.environment.runtimeEpochRef,
    ...Object.fromEntries(RELATION_RUNTIME_REFS.map((name) => [name, h.environment[name]])),
  });
  return vm.runInContext(transpile(`(${invalidateRuntimeWorkSource})`), context)("st183-stop");
};
const nextUnit = (revision = 2) => ({ ...logicalQuestionUnit, revision });
// Make one observation event of the selector's sink throw.
function throwOnObservation(h, event, stage = "affinity") {
  const selector = h.environment.requestTaskRelationProviderCandidates;
  h.environment.requestTaskRelationProviderCandidates = (input, dependencies) => selector(
    input.request.operationKind.includes(stage) ? { ...input, onObservation(observation) {
      if (observation.event === event) throw new Error(`observation sink failed at ${event}`);
      input.onObservation?.(observation);
    } } : input, dependencies);
}
function throwOnMetadataKey(h, key, message) {
  const update = h.environment.traceStoreRef.current.updateMetadata;
  h.environment.traceStoreRef.current.updateMetadata = (id, metadata) => {
    if (key in metadata) throw new Error(message);
    return update(id, metadata);
  };
  return () => { h.environment.traceStoreRef.current.updateMetadata = update; };
}

async function affinityTerminal({ runtime, child, before, drive, until = 3 * STAGE_MS } = {}) {
  const h = st183Harness({ runtime, child });
  try {
    await before?.(h);
    const handle = scheduleRelation(h);
    const terminal = watch(h, handle.affinityOutcome);
    await h.clock.flush();
    const settledBeforeAnyTimer = terminal.state !== "pending";
    await drive?.(h, handle, terminal);
    await h.clock.advanceTo(until);
    return { h, handle, terminal, settledBeforeAnyTimer };
  } catch (error) {
    h.restore();
    throw error;
  }
}
const at = (offset, action) => async (h, handle) => {
  await h.clock.advanceTo(offset);
  await action(h, handle);
};
const settleBothAffinity = (result) => (h) => {
  for (const execution of candidates(h, "affinity")) completeCandidate(execution, result);
};
function expectAffinityTerminal({ h, terminal }, expected) {
  expectEqual(terminal.state, expected.state ?? "resolved", "stage terminal");
  if (expected.at !== undefined) expectEqual(terminal.at, expected.at, "stage terminal settled at");
  if (terminal.state === "resolved") {
    const parent = terminal.value.parent;
    expectEqual(parent.adjudication?.decision, expected.decision, "parent adjudication");
    expectEqual(parent.unavailableReason, expected.reason, "parent unavailable reason");
    expectEqual(Boolean(parent.clientError), Boolean(expected.clientError), "parent client error");
    if (expected.settledAt !== undefined) expectEqual(parent.settledAt, expected.settledAt, "parent settledAt");
    expectEqual(terminal.value.child, { unavailableReason: "no-active-child", settledAt: 10_000 }, "child side");
  } else if (terminal.state === "rejected") {
    assert.match(String(terminal.error?.message), expected.error, "explicit failure");
  }
  if (expected.requests !== undefined) expectEqual(h.executions.length, expected.requests, "physical model requests");
}

for (const [name, spec, expected] of [
  ["both candidates return invalid output", { drive: at(500, settleBothAffinity({ rawOutput: "not json" })) },
    { at: 500, reason: "malformed-json", requests: 2 }],
  ["both candidates return empty output", { drive: at(500, settleBothAffinity({ rawOutput: "" })) },
    { at: 500, reason: "not-run-completed-empty", requests: 2 }],
  ["no candidate returns", {}, { at: STAGE_MS, reason: "candidate-deadline-expired", requests: 2 }],
  ["a genuinely late Fast (4050 ms) is not accepted", { drive: async (h) => {
    await h.clock.advanceTo(4_050);
    expectEqual(candidate(h, "affinity", "fast").signal.aborted, true, "late Fast request cancelled at stage end");
    completeCandidate(candidate(h, "affinity", "fast"), { rawOutput: FAST_PARENT_INDEPENDENT });
  } }, { at: STAGE_MS, reason: "candidate-deadline-expired", requests: 2 }],
  ["a cached valid Fast is selected at the deadline with its own completion time",
    { drive: at(879, completeFastAffinity) },
    { at: STAGE_MS, decision: "independent", settledAt: 10_879, requests: 2 }],
  ["a timely valid Intelligent ends the stage at once", { drive: at(1_500, (h) => completeCandidate(
    candidate(h, "affinity", "intelligent"), { rawOutput: FAST_PARENT_INDEPENDENT })) },
    { at: 1_500, decision: "independent", settledAt: 11_500, requests: 2 }],
  ["an exhausted admission queue dispatches nothing", { before: saturateAdmission },
    { at: STAGE_MS, reason: "candidate-deadline-expired", requests: 0 }],
  ["foreground cancellation", { drive: at(1_000, (_h, handle) => handle.cancelForegroundWork()) },
    { at: 1_000, reason: "operation-id-mismatch", requests: 2 }],
  ["Stop (runtime work invalidated)", { drive: at(1_000, stop) },
    { at: 1_000, reason: "operation-id-mismatch", requests: 2 }],
  ["disposed runtime (shutdown)", { drive: at(1_000, (h) => relationRuntime(h, "parent").cancelAll("disposed")) },
    { at: 1_000, reason: "operation-id-mismatch", requests: 2 }],
  ["superseded by a newer question", { drive: at(1_000, (h) => { scheduleRelation(h, { unit: nextUnit() }); }) },
    { at: 1_000, reason: "operation-id-mismatch" }],
  ["cancelled before dispatch", { drive: (_h, handle) => handle.cancelForegroundWork() },
    { at: 0, reason: "operation-id-mismatch", requests: 0 }],
  ["runtime already disposed at schedule", { before: (h) => relationRuntime(h, "parent").cancelAll("disposed") },
    { at: 0, reason: "operation-id-mismatch", requests: 0, beforeAnyTimer: true }],
  ["provider circuit open", { runtime: { circuitOpen: true } },
    { at: 0, reason: "provider-circuit-open", clientError: true, requests: 0, beforeAnyTimer: true }],
  ["provider configuration missing", { runtime: { missingProviderTier: "fast" } },
    { at: 0, reason: "provider-configuration-error", clientError: true, requests: 0, beforeAnyTimer: true }],
  ["authentication failure", { drive: at(300, (h) => completeCandidate(candidate(h, "affinity", "fast"),
    { providerDisposition: "provider-auth-error", providerOutcome: failedOutcome("authentication") })) },
    { at: 300, reason: "not-run-provider-auth-error", clientError: true, requests: 2 }],
  ["configuration failure", { drive: at(300, (h) => completeCandidate(candidate(h, "affinity", "intelligent"),
    { providerDisposition: "provider-error-content", providerOutcome: failedOutcome("configuration") })) },
    { at: 300, reason: "not-run-provider-error-content", clientError: true, requests: 2 }],
  ["internal candidate failure fails explicitly", { drive: at(300, (h) => completeCandidate(
    candidate(h, "affinity", "fast"),
    { providerDisposition: "provider-error-content", providerOutcome: failedOutcome("unexpected") })) },
    { state: "rejected", at: 300, error: /summary-unexpected/, requests: 2 }],
  ["a rejected candidate request fails explicitly", { drive: at(300, (h) =>
    candidate(h, "affinity", "intelligent").reject(new Error("transport exploded"))) },
    { state: "rejected", at: 300, error: /transport exploded/, requests: 2 }],
  ["dispatch delayed past the deadline does not regain a stage budget", { drive: (h) => { h.clock.now += 4_200; } },
    { at: 4_200, reason: "candidate-deadline-expired", requests: 0 }],
]) {
  test(`ST183-4 Affinity stage terminal: ${name}`, { concurrency: false }, async () => {
    const run = await affinityTerminal(spec);
    try {
      expectAffinityTerminal(run, expected);
      if (expected.beforeAnyTimer) expectEqual(run.settledBeforeAnyTimer, true, "settled before any timer");
    } finally { run.h.restore(); }
  });
}

// With an active Child the stage terminal aggregates two operations, one per
// side, each with its own runtime and selector. The consumer awaits that one
// terminal, so it must settle for every combination of the two sides.
const sideCandidate = (h, side, tier) => {
  const found = candidates(h, "affinity", tier).filter((execution) => execution.request.affinityKind === side);
  assert.equal(found.length, 1, `exactly one ${tier} ${side} Affinity candidate`);
  return found[0];
};
const otherSide = (side) => (side === "child" ? "parent" : "child");
const authenticationFailure = { providerDisposition: "provider-auth-error", providerOutcome: failedOutcome("authentication") };
function expectTwoSidedAffinityTerminal({ h, terminal }, expected) {
  expectEqual(terminal.state, expected.state ?? "resolved", "stage terminal");
  expectEqual(terminal.at, expected.at, "stage terminal settled at");
  if (terminal.state === "resolved") {
    for (const side of ["child", "parent"]) {
      expectEqual([terminal.value[side].unavailableReason, Boolean(terminal.value[side].clientError),
        terminal.value[side].adjudication?.decision], [expected[side].reason, Boolean(expected[side].clientError), undefined],
      `${side} side`);
    }
  } else assert.match(String(terminal.error?.message), expected.error, "explicit failure");
  expectEqual(h.executions.length, expected.requests, "physical model requests");
}
const silentSide = { reason: "candidate-deadline-expired" };
for (const [name, spec, expected] of [
  ...["child", "parent"].flatMap((side) => [
    [`the ${side} side rejects while the ${otherSide(side)} side is silent`,
      { drive: at(300, (h) => sideCandidate(h, side, "intelligent").reject(new Error(`${side} transport exploded`))) },
      { state: "rejected", at: 300, error: new RegExp(`${side} transport exploded`), requests: 4 }],
    // The client error is known at 300 ms; the terminal still waits for the silent side to end at the stage deadline.
    [`the ${side} side ends in a client error while the ${otherSide(side)} side is silent`,
      { drive: at(300, (h) => completeCandidate(sideCandidate(h, side, "fast"), authenticationFailure)) },
      { at: STAGE_MS, [side]: { reason: "not-run-provider-auth-error", clientError: true }, [otherSide(side)]: silentSide,
        requests: 4 }],
  ]),
  ["both sides find the admission queue exhausted", { before: saturateAdmission },
    { at: STAGE_MS, child: silentSide, parent: silentSide, requests: 0 }],
]) {
  test(`ST183-4 Affinity stage terminal with an active Child: ${name}`, { concurrency: false }, async () => {
    const run = await affinityTerminal({ ...spec, child: true });
    try {
      expectTwoSidedAffinityTerminal(run, expected);
    } finally { run.h.restore(); }
  });
}

test("ST183-4 Affinity stage terminal: an exhausted logical budget ends both the superseded and the refused operation", { concurrency: false }, async () => {
  const h = st183Harness();
  try {
    const first = watch(h, scheduleRelation(h).affinityOutcome);
    await h.clock.advanceTo(100);
    const second = watch(h, scheduleRelation(h).affinityOutcome);
    await h.clock.advanceTo(200);
    expectEqual([first.state, first.at, first.value?.parent.unavailableReason], ["resolved", 100, "superseded"], "first operation");
    expectEqual([second.state, second.at, second.value?.parent.unavailableReason], ["resolved", 100, "budget-exhausted"], "second operation");
    expectEqual(h.executions.length, 2, "physical model requests");
  } finally { h.restore(); }
});

// Exceptions inside the stage owner must become the operation's own terminal:
// the runtime invokes these callbacks with no promise chain to carry a throw.
async function expectRuntimeStillUsable(h) {
  const before = candidates(h, "affinity").length;
  const next = watch(h, scheduleRelation(h, { unit: nextUnit(3) }).affinityOutcome);
  await h.clock.advanceTo(h.clock.now - 10_000 + 10);
  const dispatched = candidates(h, "affinity").slice(before);
  expectEqual(dispatched.length, 2, "the next operation on the same runtime dispatches");
  completeCandidate(dispatched.find((execution) => tierOf(execution) === "intelligent"),
    { rawOutput: FAST_PARENT_INDEPENDENT });
  await h.clock.flush();
  expectEqual([next.state, next.value?.parent.adjudication?.decision], ["resolved", "independent"],
    "the next operation on the same runtime settles");
}

test("ST183-4 Affinity stage terminal: a throw while the operation starts fails explicitly and leaves the runtime usable", { concurrency: false }, async () => {
  const h = st183Harness();
  try {
    const startStep = h.environment.traceStoreRef.current.startStep;
    h.environment.traceStoreRef.current.startStep = () => { throw new Error("start bookkeeping failed"); };
    const terminal = watch(h, scheduleRelation(h).affinityOutcome);
    await h.clock.advanceTo(10);
    expectEqual([terminal.state, terminal.at], ["rejected", 0], "stage terminal");
    assert.match(terminal.error.message, /start bookkeeping failed/);
    expectEqual(h.executions.length, 0, "physical model requests");
    h.environment.traceStoreRef.current.startStep = startStep;
    await expectRuntimeStillUsable(h);
  } finally { h.restore(); }
});

test("ST183-4 Affinity stage terminal: a synchronous dispatch failure fails explicitly and leaves the runtime usable", { concurrency: false }, async () => {
  const h = st183Harness();
  try {
    const selector = h.environment.requestTaskRelationProviderCandidates;
    h.environment.requestTaskRelationProviderCandidates = () => { throw new Error("dispatch failed"); };
    const terminal = watch(h, scheduleRelation(h).affinityOutcome);
    await h.clock.advanceTo(10);
    expectEqual([terminal.state, terminal.at], ["rejected", 0], "stage terminal");
    assert.match(terminal.error.message, /dispatch failed/);
    h.environment.requestTaskRelationProviderCandidates = selector;
    await expectRuntimeStillUsable(h);
  } finally { h.restore(); }
});

test("ST183-4 Affinity stage terminal: a throw during settlement fails explicitly", { concurrency: false }, async () => {
  const h = st183Harness();
  try {
    const restore = throwOnMetadataKey(h, "taskRelationParentAffinityLeaseAuthorized", "settlement bookkeeping failed");
    const terminal = watch(h, scheduleRelation(h).affinityOutcome);
    await h.clock.advanceTo(500);
    completeCandidate(candidate(h, "affinity", "intelligent"), { rawOutput: FAST_PARENT_INDEPENDENT });
    await h.clock.advanceTo(600);
    expectEqual([terminal.state, terminal.at], ["rejected", 500], "stage terminal");
    assert.match(terminal.error.message, /settlement bookkeeping failed/);
    restore();
    await expectRuntimeStillUsable(h);
  } finally { h.restore(); }
});

test("ST183-4 Affinity stage terminal: a superseded operation's settlement failure stays its own and never reaches the new owner", { concurrency: false }, async () => {
  const h = st183Harness();
  try {
    const restore = throwOnMetadataKey(h, "taskRelationParentAffinityLeaseAuthorized", "old settlement failed");
    const old = watch(h, scheduleRelation(h).affinityOutcome);
    // Still pending in the runtime: the newer schedule settles it synchronously.
    const newerHandle = scheduleRelation(h, { unit: nextUnit() });
    restore();
    const newer = watch(h, newerHandle.affinityOutcome);
    await h.clock.advanceTo(10);
    expectEqual(old.state, "rejected", "superseded operation");
    assert.match(old.error.message, /old settlement failed/);
    expectEqual(newer.state, "pending", "new owner after dispatch");
    expectEqual(h.executions.length, 2, "new owner's physical model requests");
    completeCandidate(candidate(h, "affinity", "intelligent"), { rawOutput: FAST_PARENT_INDEPENDENT });
    await h.clock.flush();
    expectEqual([newer.state, newer.value?.parent.adjudication?.decision], ["resolved", "independent"], "new owner");
  } finally { h.restore(); }
});

for (const event of ["queued", "admitted", "completed", "selected", "cancelled"]) {
  test(`ST183-4 ST183-7 Affinity stage terminal: a failing observation sink at "${event}" cannot leave the stage unsettled or decide it, and is reported`, { concurrency: false }, async () => {
    const h = st183Harness();
    const warn = console.warn;
    const warnings = [];
    console.warn = (...args) => { warnings.push(args); };
    try {
      throwOnObservation(h, event);
      const terminal = watch(h, scheduleRelation(h).affinityOutcome);
      await h.clock.advanceTo(879);
      completeFastAffinity(h);
      await h.clock.advanceTo(STAGE_MS + 100);
      expectEqual([terminal.state, terminal.at], ["resolved", STAGE_MS], "stage terminal");
      expectEqual([terminal.value.parent.adjudication?.decision, terminal.value.parent.settledAt],
        ["independent", 10_879], "selected Affinity");
      expectEqual(candidate(h, "affinity", "intelligent").signal.aborted, true, "remaining request cancelled");
      const admission = h.environment.runtimeInferenceProviderAdmissionRef.current;
      expectEqual([admission.readSnapshot("fast").activeCount, admission.readSnapshot("intelligent").activeCount],
        [0, 0], "admission slots released");
      // Isolated, not hidden: each failed observation is reported with its error.
      expectEqual(warnings.length >= 1, true, "reported sink failures");
      expectEqual([...new Set(warnings.map(([message, error]) => `${message}: ${error.message}`))],
        [`Relation candidate observation callback failed: observation sink failed at ${event}`], "sink failure report");
      await expectRuntimeStillUsable(h);
    } finally {
      console.warn = warn;
      h.restore();
    }
  });
}

// The Canonical terminal is the Promise startCanonical returns.
async function canonicalTerminal({ runtime, beforeStart, drive, until = 3 * STAGE_MS } = {}) {
  const h = st183Harness();
  try {
    const handle = scheduleRelation(h);
    await h.clock.advanceTo(100);
    settleBothAffinity({ rawOutput: "not json" })(h);
    await h.clock.advanceTo(200);
    const affinityOutcome = await settledValue(h, handle.affinityOutcome, "Affinity stage terminal");
    if (runtime) {
      const { circuitOpen, missingProviderTier } = runtime;
      h.environment.taskRelationSplitShadowCircuitRef.current.read = () => ({ open: Boolean(circuitOpen) });
      const resolveRoute = h.environment.resolveRuntimeInferenceModelRouteFromSnapshot;
      h.environment.resolveRuntimeInferenceModelRouteFromSnapshot = (input) => {
        const route = resolveRoute(input);
        return route.providerTier === missingProviderTier ? { ...route, provider: undefined } : route;
      };
    }
    await beforeStart?.(h, handle);
    const terminal = watch(h, handle.startCanonical({ foreground: true, affinityOutcome,
      deadlineAt: h.clock.now + STAGE_MS }));
    await h.clock.flush();
    const settledBeforeAnyTimer = terminal.state !== "pending";
    await drive?.(h, handle, terminal);
    await h.clock.advanceTo(until);
    return { h, handle, terminal, settledBeforeAnyTimer };
  } catch (error) {
    h.restore();
    throw error;
  }
}
const CANONICAL_STARTS_AT = 200;
const canonicalAt = (offset, action) => at(CANONICAL_STARTS_AT + offset, action);
function expectCanonicalTerminal({ h, terminal }, expected) {
  expectEqual(terminal.state, expected.state ?? "resolved", "stage terminal");
  if (expected.at !== undefined) expectEqual(terminal.at, CANONICAL_STARTS_AT + expected.at, "stage terminal settled at");
  if (terminal.state === "resolved") {
    expectEqual(terminal.value.adjudication?.relation, expected.relation, "Canonical adjudication");
    expectEqual(terminal.value.unavailableReason, expected.reason, "Canonical unavailable reason");
    expectEqual(Boolean(terminal.value.clientError), Boolean(expected.clientError), "Canonical client error");
  } else if (terminal.state === "rejected") {
    assert.match(String(terminal.error?.message), expected.error, "explicit failure");
  }
  if (expected.requests !== undefined) expectEqual(candidates(h, "canonical").length, expected.requests, "physical Canonical requests");
}

for (const [name, spec, expected] of [
  ["a cached valid Fast is selected at the deadline", { drive: canonicalAt(900, (h) => completeCandidate(
    candidate(h, "canonical", "fast"), { rawOutput: canonicalOutput("followup-parent") })) },
    { at: STAGE_MS, relation: "followup-parent", requests: 2 }],
  ["a timely valid Intelligent ends the stage at once", { drive: canonicalAt(1_500, (h) => completeCandidate(
    candidate(h, "canonical", "intelligent"), { rawOutput: canonicalOutput("new-parent") })) },
    { at: 1_500, relation: "new-parent", requests: 2 }],
  ["both candidates return invalid output", { drive: canonicalAt(500, (h) => {
    for (const execution of candidates(h, "canonical")) completeCandidate(execution, { rawOutput: "not json" });
  }) }, { at: 500, reason: "malformed-json", requests: 2 }],
  ["no candidate returns", {}, { at: STAGE_MS, reason: "candidate-deadline-expired", requests: 2 }],
  ["an exhausted admission queue dispatches nothing", { beforeStart: saturateAdmission },
    { at: STAGE_MS, reason: "candidate-deadline-expired", requests: 0 }],
  ["foreground cancellation", { drive: canonicalAt(1_000, (_h, handle) => handle.cancelForegroundWork()) },
    { at: 1_000, reason: "operation-id-mismatch", requests: 2 }],
  ["Stop (runtime work invalidated)", { drive: canonicalAt(1_000, stop) },
    { at: 1_000, reason: "operation-id-mismatch", requests: 2 }],
  ["runtime already disposed at start", { beforeStart: (h) => relationRuntime(h, "canonical").cancelAll("disposed") },
    { at: 0, reason: "operation-id-mismatch", requests: 0, beforeAnyTimer: true }],
  ["provider circuit open", { runtime: { circuitOpen: true } },
    { at: 0, reason: "provider-circuit-open", clientError: true, requests: 0, beforeAnyTimer: true }],
  ["provider configuration missing", { runtime: { missingProviderTier: "fast" } },
    { at: 0, reason: "provider-configuration-error", clientError: true, requests: 0, beforeAnyTimer: true }],
  ["foreground window already closed", { beforeStart: (_h, handle) => handle.cancelForegroundWork() },
    { at: 0, reason: "foreground-window-closed", requests: 0, beforeAnyTimer: true }],
  ["authentication failure", { drive: canonicalAt(300, (h) => completeCandidate(candidate(h, "canonical", "intelligent"),
    { providerDisposition: "provider-auth-error", providerOutcome: failedOutcome("authentication") })) },
    { at: 300, reason: "not-run-provider-auth-error", clientError: true, requests: 2 }],
  ["internal candidate failure fails explicitly", { drive: canonicalAt(300, (h) => completeCandidate(
    candidate(h, "canonical", "fast"),
    { providerDisposition: "provider-error-content", providerOutcome: failedOutcome("unexpected") })) },
    { state: "rejected", at: 300, error: /summary-unexpected/, requests: 2 }],
  ["a failure while building the request fails explicitly", { beforeStart: (h) => {
    h.environment.buildTaskRelationCanonicalShadowRequest = () => { throw new Error("request builder failed"); };
  } }, { state: "rejected", at: 0, error: /request builder failed/, requests: 0, beforeAnyTimer: true }],
  ["dispatch delayed past the deadline does not regain a stage budget", { drive: (h) => { h.clock.now += 4_200; } },
    { at: 4_200, reason: "candidate-deadline-expired", requests: 0 }],
]) {
  test(`ST183-4 Canonical stage terminal: ${name}`, { concurrency: false }, async () => {
    const run = await canonicalTerminal(spec);
    try {
      expectCanonicalTerminal(run, expected);
      if (expected.beforeAnyTimer) expectEqual(run.settledBeforeAnyTimer, true, "settled before any timer");
    } finally { run.h.restore(); }
  });
}

test("ST183-4 ST183-5 Canonical stage terminal: one start per operation, and an exhausted logical budget ends the refused one", { concurrency: false }, async () => {
  const run = await canonicalTerminal({ until: CANONICAL_STARTS_AT + 100 });
  const { h, handle } = run;
  try {
    expectEqual(candidates(h, "canonical").length, 2, "physical Canonical requests");
    const again = handle.startCanonical({ foreground: true, deadlineAt: h.clock.now + STAGE_MS });
    expectEqual(again === handle.canonicalOutcome, true, "second start returns the same terminal");
    await h.clock.advanceTo(CANONICAL_STARTS_AT + 200);
    expectEqual(candidates(h, "canonical").length, 2, "physical Canonical requests after a second start");
    // The second start schedules nothing: the Canonical in flight keeps running.
    expectEqual([run.terminal.state, candidates(h, "canonical").map((execution) => execution.signal.aborted)],
      ["pending", [false, false]], "in-flight Canonical after a second start");
    // A second handle for the same question revision: its budget slot is spent.
    const second = scheduleRelation(h);
    const affinityOutcome = await settledValue(h, handle.affinityOutcome, "Affinity stage terminal");
    const refused = watch(h, second.startCanonical({ foreground: true, affinityOutcome, deadlineAt: h.clock.now + STAGE_MS }));
    await h.clock.advanceTo(CANONICAL_STARTS_AT + 300);
    expectEqual([run.terminal.state, run.terminal.value?.unavailableReason], ["resolved", "superseded"], "first Canonical");
    expectEqual([refused.state, refused.value?.unavailableReason], ["resolved", "budget-exhausted"], "second Canonical");
    expectEqual(candidates(h, "canonical").length, 2, "no further physical Canonical request");
  } finally { h.restore(); }
});

test("ST183-4 Canonical stage terminal: a throw while the operation starts fails explicitly and leaves the runtime usable", { concurrency: false }, async () => {
  let restoreStartStep;
  const run = await canonicalTerminal({ until: CANONICAL_STARTS_AT + 10, beforeStart: (h) => {
    const startStep = h.environment.traceStoreRef.current.startStep;
    h.environment.traceStoreRef.current.startStep = () => { throw new Error("start bookkeeping failed"); };
    restoreStartStep = () => { h.environment.traceStoreRef.current.startStep = startStep; };
  } });
  const { h } = run;
  try {
    expectCanonicalTerminal(run, { state: "rejected", at: 0, error: /start bookkeeping failed/, requests: 0 });
    restoreStartStep();
    const next = scheduleRelation(h, { unit: nextUnit(3) });
    const terminal = watch(h, next.startCanonical({ foreground: true, deadlineAt: h.clock.now + STAGE_MS,
      affinityOutcome: { child: { unavailableReason: "no-active-child" }, parent: { unavailableReason: "affinity-unavailable" } } }));
    await h.clock.advanceTo(CANONICAL_STARTS_AT + 20);
    expectEqual(candidates(h, "canonical").length, 2, "the next Canonical on the same runtime dispatches");
    completeCandidate(candidate(h, "canonical", "intelligent"), { rawOutput: canonicalOutput("new-parent") });
    await h.clock.flush();
    expectEqual([terminal.state, terminal.value?.adjudication?.relation], ["resolved", "new-parent"], "next Canonical");
  } finally { h.restore(); }
});

test("ST183-4 Canonical stage terminal: a throw during settlement fails explicitly", { concurrency: false }, async () => {
  const run = await canonicalTerminal({ until: CANONICAL_STARTS_AT + 600,
    beforeStart: (h) => { throwOnMetadataKey(h, "taskRelationSplitCanonicalLeaseAuthorized", "settlement bookkeeping failed"); },
    drive: canonicalAt(500, (h) => completeCandidate(candidate(h, "canonical", "intelligent"),
      { rawOutput: canonicalOutput("new-parent") })) });
  try {
    expectCanonicalTerminal(run, { state: "rejected", at: 500, error: /settlement bookkeeping failed/, requests: 2 });
  } finally { run.h.restore(); }
});

test("ST183-4 the Relation runtimes have no runtime-level admission queue in front of the selector", () => {
  // Boundedness before dispatch relies on this: the only queue is per candidate,
  // inside the selector, where the selector's deadline timer bounds it.
  for (const kind of ["task-relation-child-affinity", "task-relation-parent-affinity", "task-relation-canonical-shadow"]) {
    const construction = findDescendant(sourceFile, (node) => ts.isNewExpression(node) &&
      node.expression.getText(sourceFile) === "RuntimeInferenceOperationRuntime" &&
      node.arguments?.[0]?.getText(sourceFile) === JSON.stringify(kind));
    expectEqual(construction.arguments.length, 1, `${kind} runtime constructor arguments`);
  }
});

// ---- ST183-4 through the real consumers: every exit ends the wait ----

// Runs a scripted scenario and requires the consumer's wait to be open one
// millisecond before `endsAt` and over at `endsAt`.
// The harness clock only moves when the test moves it and the consumers hold no
// timer of their own, so nothing but the composition under test can end a wait.
async function runConsumerWait({ entry, runtime, child, typeElapsedMs = 600, before, script = [], endsAt }) {
  const h = st183Harness({ runtime, child });
  try {
    await before?.(h);
    const handle = scheduleEntry(h, entry);
    const startedAt = h.clock.now - 10_000;
    const started = await startConsumerInOrder(h, handle, { entry, typeElapsedMs });
    const ended = () => entryWaitEnded(h, entry, started);
    for (const [offset, action] of script) h.clock.setTimeout(() => action(h, handle), offset - startedAt);
    if (endsAt > startedAt) {
      await h.clock.advanceTo(endsAt - 1);
      expectEqual(ended(), false, `wait still open at ${endsAt - 1} ms`);
    }
    await h.clock.advanceTo(endsAt);
    expectEqual(ended(), true, `wait over at ${endsAt} ms`);
    return { h, handle, wait: started.wait };
  } catch (error) {
    h.restore();
    throw error;
  }
}
const settleBothCanonical = (result) => (h) => {
  for (const execution of candidates(h, "canonical")) completeCandidate(execution, result);
};
// How each entry presents the end of its wait.
function expectWaitOutcome({ h, wait }, entry, expected) {
  const recorded = (key) => h.metadata[`taskRelationOrderedResolution${key}`];
  if (expected.error) {
    if (entry === "screen") {
      expectEqual(wait.state, "rejected", "Screen consumer");
      assert.match(wait.error.message, expected.error);
    } else if (entry === "correction") {
      // Correction ends as an explicit internal error and carries no relation.
      expectEqual(wait.state, "resolved", "Correction relation block");
      assert.match(String(wait.value.error?.message), expected.error);
      expectEqual([wait.value.correctionRelationTerminal?.disposition, wait.value.orderedCorrectionRelation,
        h.metadata.correctionOrderedRelationTerminalDisposition], ["internal-error", undefined, "internal-error"],
      "Correction relation terminal");
      assert.match(String(h.metadata.correctionOrderedRelationError), expected.error);
    } else {
      expectEqual(h.advisorCalls.length, 0, "Advisor handoffs");
      assert.match(String(h.metadata.taskRelationOrderedResolutionInternalError), expected.error);
      expectEqual(h.metadata.taskRelationOrderedResolutionFailureDisposition, "fail-fast", "Voice failure disposition");
      expectEqual(h.events.some((event) => event.finish?.[1] === "error"), true, "Voice trace failed");
    }
    return;
  }
  if (entry === "screen") {
    expectEqual(wait.state, "resolved", "Screen consumer");
    expectEqual(wait.value.terminalDisposition, expected.terminal, "terminal disposition");
  } else if (entry === "correction") {
    expectEqual([wait.state, wait.value.error, wait.value.correctionRelationTerminal?.disposition],
      ["resolved", undefined, expected.terminal === "resolved" ? undefined : expected.terminal], "Correction relation terminal");
    if (expected.terminal === "resolved") {
      expectEqual(wait.value.orderedCorrectionRelation?.stage, expected.stage, "Correction relation source");
    }
  } else if (expected.terminal === "resolved") {
    expectEqual(h.advisorCalls.length, 1, "Advisor handoffs");
  } else {
    expectEqual(h.advisorCalls.length, 0, "Advisor handoffs");
    expectEqual(h.events.filter((event) => event.finish).map((event) => event.finish[1]),
      [expected.terminal === "client-error" ? "error" : "cancelled"], "Voice trace terminal");
  }
  if (expected.stage) expectEqual(recorded("Stage"), expected.stage, "final Relation source");
  if (expected.source) expectEqual([recorded("Stage"), recorded("Reason"), recorded("Relation")], expected.source[entry],
    "final Relation source");
  if (expected.parent) expectEqual(recorded("AffinityParentDisposition"), expected.parent, "final parent Affinity");
  if (expected.child) expectEqual(recorded("AffinityChildDisposition"), expected.child, "final child Affinity");
  if ("canonical" in expected) expectEqual(recorded("CanonicalDisposition"), expected.canonical, "final Canonical");
  if (expected.requests !== undefined) expectEqual(h.executions.length, expected.requests, "physical model requests");
}

const NULL_HYPOTHESIS = "source-topology-null-hypothesis";
for (const entry of ["voice", "screen"]) {
  // Voice starts consuming once Type has settled (50 ms); Screen starts at once.
  const startsAt = entry === "voice" ? 50 : 0;
  for (const [name, spec, expected] of [
    ["both candidates fail with invalid output in both stages", { endsAt: 700, script: [
      [500, settleBothAffinity({ rawOutput: "not json" })], [700, settleBothCanonical({ rawOutput: "not json" })]] },
      { terminal: "resolved", stage: NULL_HYPOTHESIS, parent: "malformed-json", canonical: "malformed-json", requests: 4 }],
    ["both candidates return empty output in both stages", { endsAt: 700, script: [
      [500, settleBothAffinity({ rawOutput: "" })], [700, settleBothCanonical({ rawOutput: "" })]] },
      { terminal: "resolved", stage: NULL_HYPOTHESIS, parent: "not-run-completed-empty",
        canonical: "not-run-completed-empty", requests: 4 }],
    ["a genuinely late Fast (4050 ms) and a silent Canonical", { endsAt: 2 * STAGE_MS, script: [
      [4_050, (h) => completeCandidate(candidate(h, "affinity", "fast"), { rawOutput: FAST_PARENT_INDEPENDENT })]] },
      { terminal: "resolved", stage: NULL_HYPOTHESIS, parent: "candidate-deadline-expired",
        canonical: "candidate-deadline-expired", requests: 4 }],
    ["an exhausted admission queue in both stages dispatches nothing (ST183-6)", { endsAt: 2 * STAGE_MS, before: saturateAdmission },
      { terminal: "resolved", stage: NULL_HYPOTHESIS, parent: "candidate-deadline-expired",
        canonical: "candidate-deadline-expired", requests: 0 }],
    ["an open provider circuit", { endsAt: startsAt, runtime: { circuitOpen: true } },
      { terminal: "client-error", parent: "provider-circuit-open", canonical: undefined, requests: 0 }],
    ["missing provider configuration", { endsAt: startsAt, runtime: { missingProviderTier: "intelligent" } },
      { terminal: "client-error", parent: "provider-configuration-error", canonical: undefined, requests: 0 }],
    ["an authentication failure in the Affinity stage", { endsAt: 300, script: [
      [300, (h) => completeCandidate(candidate(h, "affinity", "fast"),
        { providerDisposition: "provider-auth-error", providerOutcome: failedOutcome("authentication") })]] },
      { terminal: "client-error", parent: "not-run-provider-auth-error", canonical: undefined, requests: 2 }],
    ["a configuration failure in the Canonical stage", { endsAt: 700, script: [
      [500, settleBothAffinity({ rawOutput: "not json" })],
      [700, (h) => completeCandidate(candidate(h, "canonical", "intelligent"),
        { providerDisposition: "provider-error-content", providerOutcome: failedOutcome("configuration") })]] },
      { terminal: "client-error", parent: "malformed-json", canonical: "not-run-provider-error-content", requests: 4 }],
    ["an internal candidate failure in the Affinity stage", { endsAt: 300, script: [
      [300, (h) => completeCandidate(candidate(h, "affinity", "intelligent"),
        { providerDisposition: "provider-error-content", providerOutcome: failedOutcome("unexpected") })]] },
      { error: /summary-unexpected/ }],
    ["an internal candidate failure in the Canonical stage", { endsAt: 700, script: [
      [500, settleBothAffinity({ rawOutput: "not json" })],
      [700, (h) => candidate(h, "canonical", "fast").reject(new Error("transport exploded"))]] },
      { error: /transport exploded/ }],
    ["an internal exception while the Affinity operation starts", { endsAt: startsAt, before: (h) => {
      h.environment.traceStoreRef.current.startStep = (_id, name) => {
        if (String(name).includes("affinity")) throw new Error("start bookkeeping failed");
        return "step";
      };
    } }, { error: /start bookkeeping failed/ }],
    ["an internal exception while the Canonical stage settles", { endsAt: 700, script: [
      [500, settleBothAffinity({ rawOutput: "not json" })],
      [600, (h) => { throwOnMetadataKey(h, "taskRelationSplitCanonicalLeaseAuthorized", "settlement bookkeeping failed"); }],
      [700, settleBothCanonical({ rawOutput: "not json" })]] },
      { error: /settlement bookkeeping failed/ }],
  ]) {
    test(`ST183-4 ${entry} wait ends: ${name}`, { concurrency: false }, async () => {
      const run = await runConsumerWait({ entry, ...spec });
      try {
        expectWaitOutcome(run, entry, expected);
      } finally { run.h.restore(); }
    });
  }

  test(`ST183-4 ${entry} wait ends: an exhausted logical budget for a rescheduled question`, { concurrency: false }, async () => {
    // The same question revision is scheduled again at 100 ms: its Affinity
    // budget slot is spent, so the consumer goes straight to Canonical.
    const run = await runConsumerWait({ entry, endsAt: 100 + startsAt + STAGE_MS, before: async (h) => {
      scheduleRelation(h);
      await h.clock.advanceTo(100);
    } });
    try {
      expectWaitOutcome(run, entry, { terminal: "resolved", stage: NULL_HYPOTHESIS, parent: "budget-exhausted",
        canonical: "candidate-deadline-expired", requests: 4 });
    } finally { run.h.restore(); }
  });
}

// The same exits with an active Child: the consumer awaits the two-sided terminal.
for (const entry of ["voice", "screen"]) for (const [name, spec, expected] of [
  ...["child", "parent"].flatMap((side) => [
    [`the ${side} side rejects while the ${otherSide(side)} side is silent`, { endsAt: 300, script: [
      [300, (h) => sideCandidate(h, side, "intelligent").reject(new Error(`${side} transport exploded`))]] },
      { error: new RegExp(`${side} transport exploded`) }],
    // Reported when the two-sided terminal settles, at the stage deadline, with no Canonical.
    [`the ${side} side ends in a client error while the ${otherSide(side)} side is silent`, { endsAt: STAGE_MS, script: [
      [300, (h) => completeCandidate(sideCandidate(h, side, "fast"), authenticationFailure)]] },
      { terminal: "client-error", [side]: "not-run-provider-auth-error", [otherSide(side)]: "candidate-deadline-expired",
        canonical: undefined, requests: 4 }],
  ]),
  // With no Affinity and no Canonical the matrix decides from the question types
  // alone: Voice inherits the active child's type, Screen answers the current question only.
  ["both sides and the Canonical stage find the admission queue exhausted", { endsAt: 2 * STAGE_MS, before: saturateAdmission },
    { terminal: "resolved", child: "candidate-deadline-expired", parent: "candidate-deadline-expired",
      canonical: "candidate-deadline-expired", requests: 0,
      source: { voice: ["runtime-matrix", "active-child-preserve-child", "child-probe"],
        screen: ["runtime-matrix", "type-location-unresolved", undefined] } }],
]) {
  test(`ST183-4 ${entry} wait ends with an active Child: ${name}`, { concurrency: false }, async () => {
    const run = await runConsumerWait({ entry, child: true, ...spec });
    try {
      expectWaitOutcome(run, entry, expected);
    } finally { run.h.restore(); }
  });
}

// Correction enters the shared chain when its Type adjudication ends (600 ms here).
for (const [name, spec, expected] of [
  ["an exhausted admission queue in both stages dispatches nothing", { endsAt: 2 * STAGE_MS, before: saturateAdmission },
    { terminal: "resolved", stage: NULL_HYPOTHESIS, parent: "candidate-deadline-expired",
      canonical: "candidate-deadline-expired", requests: 0 }],
  ["an internal candidate failure in the Affinity stage", { endsAt: 1_000, script: [
    [1_000, (h) => candidate(h, "affinity", "intelligent").reject(new Error("transport exploded"))]] },
    { error: /transport exploded/ }],
  ["an internal candidate failure in the Canonical stage", { endsAt: 1_000, script: [
    [500, settleBothAffinity({ rawOutput: "not json" })],
    [1_000, (h) => candidate(h, "canonical", "fast").reject(new Error("transport exploded"))]] },
    { error: /transport exploded/ }],
]) {
  test(`ST183-4 correction wait ends: ${name}`, { concurrency: false }, async () => {
    const run = await runConsumerWait({ entry: "correction", ...spec });
    try {
      expectWaitOutcome(run, "correction", expected);
    } finally { run.h.restore(); }
  });
}

test("ST183-4 the Ordered consumer registers no timer of its own in either stage", { concurrency: false }, async () => {
  assert.doesNotMatch(orderedOperationBindingSource, /withTimeout|setTimeout/,
    "the Hook injects no timeout arbiter into the Ordered operation");
  const h = st183Harness();
  try {
    const handle = scheduleRelation(h, { sourceKind: "screen" });
    const timersBefore = h.clock.timers.size;
    const wait = watch(h, startScreenConsumer(h, handle));
    await h.clock.flush();
    expectEqual(h.clock.timers.size, timersBefore, "timers after the consumer starts waiting for Affinity");
    await h.clock.advanceTo(300);
    completeCandidate(candidate(h, "affinity", "intelligent"), { rawOutput: FAST_PARENT_INDEPENDENT });
    await h.clock.advanceTo(400);
    expectEqual(candidates(h, "canonical").length, 2, "Canonical dispatched");
    // Affinity is over, Canonical is being awaited: only its selector's deadline timer exists.
    expectEqual([...h.clock.timers.values()].map((timer) => timer.at), [10_300 + STAGE_MS],
      "timers while the consumer waits for Canonical");
    await h.clock.advanceTo(300 + STAGE_MS);
    expectEqual([wait.state, h.clock.timers.size], ["resolved", 0], "wait over and no timer left");
  } finally { h.restore(); }
});

// ---- ST183-5: stale owners commit nothing; one settlement and one Canonical start ----

const settlementCount = (h, key) => h.events.filter((event) => event.metadata && key in event.metadata).length;

test("ST183-5 Stop in these tests is the Hook's invalidateRuntimeWork: a new runtime epoch and all three Relation runtimes cancelled as superseded", { concurrency: false }, async () => {
  for (const name of ["runtimeEpochRef", ...RELATION_RUNTIME_REFS]) {
    expectEqual(invalidateRuntimeWorkRefs.includes(name), true, `invalidateRuntimeWork reads ${name}`);
  }
  const h = st183Harness({ child: true });
  try {
    const cancelled = [];
    for (const name of RELATION_RUNTIME_REFS) {
      const runtime = h.environment[name].current;
      const cancelAll = runtime.cancelAll.bind(runtime);
      runtime.cancelAll = (reason) => { cancelled.push([name, reason]); return cancelAll(reason); };
    }
    const handle = scheduleRelation(h);
    const terminal = watch(h, handle.affinityOutcome);
    await h.clock.advanceTo(1_000);
    expectEqual(candidates(h, "affinity").map((execution) => execution.signal.aborted), [false, false, false, false],
      "Affinity requests in flight before Stop");
    const epoch = h.environment.runtimeEpochRef.current;
    const invalidation = stop(h);
    expectEqual(invalidation, { runtimeInvalidationReason: "st183-stop", previousRuntimeEpoch: epoch, runtimeEpoch: epoch + 1 },
      "invalidation receipt");
    expectEqual(h.environment.runtimeEpochRef.current, epoch + 1, "runtime epoch");
    expectEqual(cancelled, RELATION_RUNTIME_REFS.map((name) => [name, "superseded"]), "Relation runtimes cancelled");
    await h.clock.flush();
    // Both sides end at once, not at the stage deadline, and nothing is left running.
    expectEqual([terminal.state, terminal.at, terminal.value?.child.unavailableReason, terminal.value?.parent.unavailableReason],
      ["resolved", 1_000, "operation-id-mismatch", "operation-id-mismatch"], "stage terminal after Stop");
    expectEqual(candidates(h, "affinity").map((execution) => execution.signal.aborted), [true, true, true, true],
      "Affinity requests after Stop");
    expectEqual(RELATION_RUNTIME_REFS.map((name) => h.environment[name].current.getCurrentOperationId()),
      [null, null, null], "current Relation operations after Stop");
  } finally { h.restore(); }
});

for (const entry of ["voice", "screen"]) {
  test(`ST183-5 ${entry}: Stop during the Affinity stage commits nothing`, { concurrency: false }, async () => {
    const h = st183Harness();
    try {
      const handle = scheduleRelation(h, { sourceKind: entry === "screen" ? "screen" : "voice" });
      let wait;
      if (entry === "voice") startVoiceResolution(h, handle);
      else wait = watch(h, startScreenConsumer(h, handle));
      await h.clock.advanceTo(879);
      completeFastAffinity(h);
      await h.clock.advanceTo(1_000);
      stop(h);
      await h.clock.advanceTo(1_000 + STAGE_MS + 100);
      expectEqual(h.advisorCalls.length, 0, "stale Advisor handoffs");
      expectEqual(h.metadata.taskRelationParentAffinitySelectedProviderTier, undefined, "selection after Stop");
      expectEqual(h.metadata.taskRelationOrderedResolutionOperationAuthorized, false, "operation authorization");
      expectEqual(h.metadata.taskRelationOrderedResolutionOperationMismatchedKey, "runtimeEpoch", "stale key");
      if (wait) expectEqual([wait.state, wait.value?.terminalDisposition], ["resolved", "cancelled"], "Screen consumer");
      else expectEqual(h.events.filter((event) => event.finish).map((event) => event.finish[1]), ["cancelled"], "Voice trace");
      expectEqual(candidates(h, "canonical").length <= 2, true, "at most one Canonical start");
      expectEqual(candidates(h, "canonical").every((execution) =>
        execution.request.semanticPayload.affinity.parent.status === "unknown"), true, "no cancelled Affinity reaches Canonical");
    } finally { h.restore(); }
  });

  for (const [key, change] of [
    ["manualCorrectionRevision", (h) => { h.environment.manualCorrectionRevisionRef.current += 1; }],
    ["runtimeEpoch", (h) => { h.environment.runtimeEpochRef.current += 1; }],
    ["sessionId", (h) => { h.environment.contextManagerRef.current.getState().sessionId = "session-b"; }],
    ["parentRevision", (h) => { h.environment.contextManagerRef.current.getState().activeMeetingTask.parent.revisions += 1; }],
    ["childId", (h) => { h.environment.contextManagerRef.current.getState().activeMeetingTask.child = activeChild(); }],
  ]) {
    test(`ST183-5 ${entry}: a ${key} change after the Fast result was cached makes it unusable and commits nothing`, { concurrency: false }, async () => {
      const h = st183Harness();
      try {
        const handle = scheduleRelation(h, { sourceKind: entry === "screen" ? "screen" : "voice" });
        let wait;
        if (entry === "voice") startVoiceResolution(h, handle);
        else wait = watch(h, startScreenConsumer(h, handle));
        await h.clock.advanceTo(879);
        completeFastAffinity(h);
        await h.clock.advanceTo(2_000);
        change(h);
        await h.clock.advanceTo(STAGE_MS + 100);
        // The selector still picks the cached candidate; the lease refuses it.
        expectEqual(h.metadata.taskRelationParentAffinitySelectedProviderTier, "fast", "selected tier");
        expectEqual([h.metadata.taskRelationParentAffinityLeaseAuthorized, h.metadata.taskRelationParentAffinityDisposition],
          [false, `${key}-mismatch`], "Affinity lease");
        for (const execution of candidates(h, "canonical")) {
          expectEqual(execution.request.semanticPayload.affinity.parent, { status: "unknown" }, "Canonical input parent Affinity");
        }
        settleBothCanonical({ rawOutput: canonicalOutput("followup-parent") })(h);
        await h.clock.advanceTo(2 * STAGE_MS + 200);
        expectEqual(h.advisorCalls.length, 0, "stale Advisor handoffs");
        expectEqual(h.metadata.taskRelationOrderedResolutionOperationAuthorized, false, "operation authorization");
        expectEqual(h.metadata.taskRelationOrderedResolutionOperationMismatchedKey, key, "stale key");
        if (wait) expectEqual([wait.state, wait.value?.terminalDisposition], ["resolved", "cancelled"], "Screen consumer");
        else expectEqual(h.events.filter((event) => event.finish).map((event) => event.finish[1]), ["cancelled"], "Voice trace");
      } finally { h.restore(); }
    });
  }

  test(`ST183-5 ${entry}: a source invalidated during the stage commits nothing even with a consumed Affinity`, { concurrency: false }, async () => {
    const h = st183Harness();
    try {
      let sourceCurrentNow = true;
      const handle = scheduleRelation(h, { sourceKind: entry === "screen" ? "screen" : "voice",
        authorizeSourceOperation: () => (sourceCurrentNow ? sourceCurrent()
          : { authorized: false, reason: "logical-question-id-mismatch", mismatchedKey: "source" }) });
      let wait;
      if (entry === "voice") startVoiceResolution(h, handle);
      else wait = watch(h, startScreenConsumer(h, handle));
      await h.clock.advanceTo(879);
      completeFastAffinity(h);
      await h.clock.advanceTo(2_000);
      sourceCurrentNow = false;
      await h.clock.advanceTo(STAGE_MS + 100);
      settleBothCanonical({ rawOutput: canonicalOutput("followup-parent") })(h);
      await h.clock.advanceTo(STAGE_MS + 200);
      expectEqual(h.advisorCalls.length, 0, "stale Advisor handoffs");
      expectEqual(h.metadata.taskRelationOrderedResolutionOperationMismatchedKey, "source", "stale key");
      if (wait) expectEqual([wait.state, wait.value?.terminalDisposition], ["resolved", "cancelled"], "Screen consumer");
      else expectEqual(h.events.filter((event) => event.finish).map((event) => event.finish[1]), ["cancelled"], "Voice trace");
    } finally { h.restore(); }
  });
}

test("ST183-5 a new owner consumes only its own candidates; the superseded owner commits nothing", { concurrency: false }, async () => {
  const h = st183Harness();
  try {
    const current = { unit: logicalQuestionUnit };
    const ownerOf = (unit) => () => (current.unit === unit ? sourceCurrent()
      : { authorized: false, reason: "logical-question-revision-mismatch", mismatchedKey: "source" });
    const oldHandle = scheduleRelation(h, { sourceKind: "screen", authorizeSourceOperation: ownerOf(logicalQuestionUnit) });
    const oldWait = watch(h, startScreenConsumer(h, oldHandle));
    await h.clock.advanceTo(500);
    const oldCandidates = [...h.executions];
    completeFastAffinity(h);
    const oldOperationId = h.metadata.taskRelationParentAffinityOperationId;
    await h.clock.advanceTo(1_000);
    // A newer revision of the question takes the same runtimes.
    const newUnit = nextUnit();
    current.unit = newUnit;
    const newHandle = scheduleRelation(h, { sourceKind: "screen", unit: newUnit, authorizeSourceOperation: ownerOf(newUnit) });
    const newWait = watch(h, startScreenConsumer(h, newHandle));
    await h.clock.advanceTo(1_500);
    expectEqual(oldCandidates.every((execution) => execution.signal.aborted), true, "old candidates cancelled");
    const newAffinity = candidates(h, "affinity").filter((execution) => !oldCandidates.includes(execution));
    expectEqual(newAffinity.length, 2, "new owner's Affinity candidates");
    completeCandidate(newAffinity.find((execution) => tierOf(execution) === "fast"), { rawOutput: FAST_PARENT_INDEPENDENT });
    await h.clock.advanceTo(1_000 + STAGE_MS + 100);
    const newOperationId = h.metadata.taskRelationParentAffinityOperationId;
    expectEqual(newOperationId === oldOperationId, false, "distinct operations");
    const canonicalRequests = [...new Set(candidates(h, "canonical").map((execution) => execution.request))];
    const consumed = canonicalRequests.filter((request) => request.semanticPayload.affinity.parent.status === "available");
    expectEqual(consumed.map((request) => request.parentPredecessorOperationId), [newOperationId],
      "only the new owner's Affinity reaches a Canonical request");
    expectEqual(canonicalRequests.some((request) => request.parentPredecessorOperationId === oldOperationId &&
      request.semanticPayload.affinity.parent.status === "available"), false, "old candidate consumed");
    for (const execution of candidates(h, "canonical").filter((item) => item.request === consumed[0])) {
      if (tierOf(execution) === "intelligent") completeCandidate(execution, { rawOutput: canonicalOutput("unknown") });
    }
    await h.clock.advanceTo(1_000 + STAGE_MS + 200);
    expectEqual([oldWait.state, oldWait.value?.terminalDisposition], ["resolved", "cancelled"], "superseded owner");
    expectEqual([newWait.state, newWait.value?.terminalDisposition, newWait.value?.decision.matrix.parentAffinityDecision],
      ["resolved", "resolved", "independent"], "new owner");
  } finally { h.restore(); }
});

// ---- ST183-5 at consumption: the consumed terminal value is revalidated ----
//
// The stage settled with a valid lease; ownership changes afterwards, before the
// consumer reads the terminal or while it waits for Canonical. The lease check at
// settlement has already passed, so only the revalidation at consumption can
// refuse the value.

const settlesAt = (h, offset, value) => {
  const outcome = deferred();
  h.clock.setTimeout(() => outcome.resolve(value), offset);
  return outcome.promise;
};
// Starts the entry's real consumer `startsAt` ms into the Affinity stage.
function startConsumerLater(h, entry, handle, startsAt) {
  const started = {};
  if (entry === "voice") {
    // Voice starts its relation consumer when Type settles.
    startVoiceResolution(h, handle, { outcome: settlesAt(h, startsAt, { enforcement: { authorized: false } }) });
  } else {
    h.clock.setTimeout(() => {
      started.wait = watch(h, entry === "screen"
        ? startScreenConsumer(h, handle) : startCorrectionConsumer(h, handle));
    }, startsAt);
  }
  return started;
}
const settleIntelligentAffinity = (h) => {
  for (const execution of candidates(h, "affinity", "intelligent")) {
    completeCandidate(execution, { rawOutput: execution.request.affinityKind === "child"
      ? FAST_CHILD_UNRELATED : FAST_PARENT_INDEPENDENT });
  }
};
// Another question takes the shared Affinity runtimes; the first question's own
// source and identity stay current, so only its Affinity operations go stale.
const otherQuestionTakesAffinityRuntimes = (h) =>
  scheduleRelation(h, { sourceKind: "screen", unit: { ...logicalQuestionUnit, id: "lqu-other" } });
const ownCanonical = (h) => candidates(h, "canonical").filter((execution) =>
  execution.request.identity.logicalQuestionUnitId === logicalQuestionUnit.id);
const finalRelation = (h, entry, started) => (entry === "voice" ? h.advisorCalls[0]?.args[7]?.relation
  : entry === "screen" ? started.wait.value?.decision.relation
    : started.wait.value?.orderedCorrectionRelation?.relation);

for (const entry of ["voice", "screen", "correction"]) for (const child of [false, true]) {
  test(`ST183-5 ${entry} ${child ? "child+parent" : "parent-only"}: a settled, authorized Affinity whose operation was superseded before consumption is not handed to Canonical`, { concurrency: false }, async () => {
    const h = st183Harness({ child });
    try {
      const handle = scheduleEntry(h, entry);
      const started = startConsumerLater(h, entry, handle, 2_000);
      await h.clock.advanceTo(300);
      settleIntelligentAffinity(h);
      await h.clock.advanceTo(400);
      const settled = await settledValue(h, handle.affinityOutcome, "Affinity stage terminal");
      expectEqual([settled.parent.adjudication?.decision, settled.child.adjudication?.decision,
        h.metadata.taskRelationParentAffinityLeaseAuthorized], ["independent", child ? "unrelated" : undefined, true],
      "Affinity stage settled with a valid lease");
      expectEqual(candidates(h, "canonical").length, 0, "Canonical before the consumer starts");
      await h.clock.advanceTo(1_000);
      otherQuestionTakesAffinityRuntimes(h);
      await h.clock.advanceTo(2_100);
      const dispatched = ownCanonical(h);
      expectEqual(dispatched.length, 2, "Canonical physical candidates");
      expectEqual(dispatched[0].dispatchedAt - 10_000, 2_000, "Canonical dispatched when the consumer started");
      expectEqual(dispatched[0].request.semanticPayload.affinity.parent, { status: "unknown" }, "Canonical input parent Affinity");
      expectEqual(dispatched[0].request.semanticPayload.affinity.child, child ? { status: "unknown" } : undefined,
        "Canonical input child Affinity");
      // The refused result is still named as Canonical's predecessor, which is how
      // Canonical's own predecessor check refuses the answer built on it below. So
      // consumption is read from the payload and the recorded disposition; the
      // predecessor fields alone do not prove it.
      expectEqual(dispatched[0].request.parentPredecessorOperationId, settled.parent.operationId,
        "Canonical parent predecessor operation");
      for (const execution of dispatched) completeCandidate(execution, { rawOutput: canonicalOutput("new-parent") });
      await h.clock.advanceTo(2_200);
      const recorded = (key) => h.metadata[`taskRelationOrderedResolution${key}`];
      expectEqual([recorded("AffinityParentDisposition"), recorded("AffinityChildDisposition")],
        ["affinity-operation-stale", child ? "affinity-operation-stale" : "no-active-child"], "consumed terminal revalidated");
      expectEqual(recorded("CanonicalDisposition"), `${child ? "child" : "parent"}-predecessor-operation-mismatch`,
        "Canonical built on a superseded predecessor");
      // Neither the stale Affinity nor a Canonical built on it decides the relation.
      // With an active child the matrix still decides from the question types alone.
      if (!child) expectEqual([recorded("Stage"), recorded("Relation")], [NULL_HYPOTHESIS, "followup-parent"], "final Relation source");
      expectEqual([String(recorded("Reason")).includes("independent"), recorded("Relation") === "new-parent"], [false, false],
        "stale Affinity decided the relation");
      expectEqual(recorded("OperationAuthorized"), true, "operation authorization");
      expectEqual(finalRelation(h, entry, started), recorded("Relation"), "released relation");
    } finally { h.restore(); }
  });
}

for (const entry of ["voice", "screen", "correction"]) {
  test(`ST183-5 ${entry}: an identity change between Affinity settlement and consumption drops the settled Affinity and commits nothing`, { concurrency: false }, async () => {
    const h = st183Harness();
    try {
      const handle = scheduleEntry(h, entry);
      const started = startConsumerLater(h, entry, handle, 2_000);
      await h.clock.advanceTo(300);
      settleIntelligentAffinity(h);
      await h.clock.advanceTo(1_000);
      expectEqual([h.metadata.taskRelationParentAffinityLeaseAuthorized, h.metadata.taskRelationParentAffinityDecision],
        [true, "independent"], "Affinity stage settled with a valid lease");
      h.environment.manualCorrectionRevisionRef.current += 1;
      await h.clock.advanceTo(2_100);
      const dispatched = candidates(h, "canonical");
      expectEqual(dispatched.length, 2, "Canonical physical candidates");
      for (const execution of dispatched) {
        expectEqual(execution.request.semanticPayload.affinity.parent, { status: "unknown" }, "Canonical input parent Affinity");
      }
      settleBothCanonical({ rawOutput: canonicalOutput("followup-parent") })(h);
      await h.clock.advanceTo(2_200);
      expectEqual(h.metadata.taskRelationOrderedResolutionAffinityParentDisposition, "affinity-manualCorrectionRevision-stale",
        "consumed terminal revalidated");
      expectEqual([h.metadata.taskRelationOrderedResolutionOperationAuthorized,
        h.metadata.taskRelationOrderedResolutionOperationMismatchedKey], [false, "manualCorrectionRevision"], "operation authorization");
      expectEqual(h.advisorCalls.length, 0, "stale Advisor handoffs");
      if (entry === "voice") {
        expectEqual(h.events.filter((event) => event.finish).map((event) => event.finish[1]), ["cancelled"], "Voice trace");
      } else if (entry === "screen") {
        expectEqual([started.wait.state, started.wait.value?.terminalDisposition], ["resolved", "cancelled"], "Screen consumer");
      } else {
        expectEqual([started.wait.state, started.wait.value?.correctionRelationTerminal?.disposition,
          started.wait.value?.orderedCorrectionRelation], ["resolved", "cancelled", undefined], "Correction relation terminal");
      }
    } finally { h.restore(); }
  });
}

for (const entry of ["voice", "screen"]) {
  test(`ST183-5 ${entry}: an Affinity whose operation is superseded during the Canonical stage is not adopted by the final resolver`, { concurrency: false }, async () => {
    const h = st183Harness();
    try {
      const handle = scheduleEntry(h, entry);
      const started = {};
      if (entry === "voice") startVoiceResolution(h, handle);
      else started.wait = watch(h, startScreenConsumer(h, handle));
      await h.clock.advanceTo(300);
      settleIntelligentAffinity(h);
      await h.clock.advanceTo(400);
      const dispatched = candidates(h, "canonical");
      expectEqual(dispatched.length, 2, "Canonical physical candidates");
      expectEqual(dispatched[0].request.semanticPayload.affinity.parent.status, "available", "Affinity consumed while current");
      await h.clock.advanceTo(1_000);
      otherQuestionTakesAffinityRuntimes(h);
      await h.clock.advanceTo(1_500);
      // A valid Canonical "unknown" hands the decision back to the Affinity matrix.
      completeCandidate(dispatched.find((execution) => tierOf(execution) === "intelligent"),
        { rawOutput: canonicalOutput("unknown") });
      await h.clock.advanceTo(1_600);
      const recorded = (key) => h.metadata[`taskRelationOrderedResolution${key}`];
      expectEqual(recorded("AffinityParentDisposition"), "affinity-operation-stale", "adopted Affinity revalidated");
      expectEqual([recorded("Stage"), recorded("OperationAuthorized")], [NULL_HYPOTHESIS, true], "final Relation source");
      expectEqual(finalRelation(h, entry, started) === "new-parent", false, "stale Affinity decided the relation");
      expectEqual(finalRelation(h, entry, started), recorded("Relation"), "released relation");
      if (entry === "screen") expectEqual(started.wait.value.decision.matrix?.parentAffinityDecision, undefined,
        "Affinity adopted by the final resolver");
    } finally { h.restore(); }
  });
}

// ---- ST183-4 / P5: a stage that fails before its consumer attaches ----
//
// Voice attaches to the stage terminal when Type settles, Correction when its
// Type adjudication ends, Screen when it starts consuming. A stage that fails in
// that window is a handled failure of the stage owner, and the consumer still
// receives it from the same Promise when it attaches. The fake clock never
// yields to the event loop, so the window is opened here with real macrotasks:
// that is where Node reports a rejection nobody handles.
const realMacrotask = () => new Promise((resolve) => setImmediate(resolve));
for (const entry of ["voice", "screen", "correction"]) {
  test(`ST183-4 ${entry}: an Affinity stage that fails before its consumer attaches raises no unhandled rejection, and the consumer still fails explicitly`, { concurrency: false }, async () => {
    const h = st183Harness();
    const unhandled = [];
    const onUnhandledRejection = (reason) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const handle = scheduleEntry(h, entry);
      const started = startConsumerLater(h, entry, handle, 2_000);
      await h.clock.advanceTo(300);
      const failure = new Error("transport exploded");
      candidate(h, "affinity", "intelligent").reject(failure);
      await h.clock.advanceTo(1_000);
      // Read without attaching a handler: the test itself must not handle the rejection.
      assert.match(inspect(handle.affinityOutcome), /<rejected>/, "the stage terminal is rejected");
      expectEqual(entryWaitEnded(h, entry, started), false, "no consumer has attached yet");
      await realMacrotask();
      await realMacrotask();
      expectEqual(unhandled.map(String), [], "unhandled rejections before the consumer attaches");
      await h.clock.advanceTo(2_100);
      expectEqual(entryWaitEnded(h, entry, started), true, "wait over when the consumer attached");
      if (entry === "voice") {
        expectEqual([h.metadata.taskRelationOrderedResolutionInternalError,
          h.metadata.taskRelationOrderedResolutionFailureDisposition, h.advisorCalls.length],
        ["transport exploded", "fail-fast", 0], "Voice fails explicitly");
        expectEqual(h.events.filter((event) => event.finish).map((event) => event.finish[1]), ["error"], "Voice trace");
      } else if (entry === "screen") {
        expectEqual(started.wait.state, "rejected", "Screen consumer");
        assert.equal(started.wait.error, failure, "the consumer receives the stage's own rejection");
      } else {
        assert.equal(started.wait.value.error, failure, "the consumer receives the stage's own rejection");
        expectEqual([started.wait.value.correctionRelationTerminal?.disposition, started.wait.value.orderedCorrectionRelation],
          ["internal-error", undefined], "Correction relation terminal");
      }
      expectEqual(candidates(h, "canonical").length, 0, "no Canonical is started on a failed stage");
      await realMacrotask();
      expectEqual(unhandled.map(String), [], "unhandled rejections after the consumer attached");
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      h.restore();
    }
  });
}

// ---- ST183-5 / D6: a late candidate processed before the late deadline timer ----
//
// A blocked event loop can deliver a provider completion before the deadline
// timer that was due earlier. The stage ended at its deadline all the same: the
// selector refuses the completion where it arrives and ends the stage with what
// was valid before the deadline. Nothing behind the selector filters a Canonical
// selection, so this is what keeps a late Canonical answer out of the relation.

const LATE_BY_MS = 200;
// Each entry's real consumer, started where that entry starts it.
const startEntryConsumer = (h, entry, handle) =>
  startConsumerLater(h, entry, handle, { voice: 50, screen: 0, correction: 600 }[entry]);
// Blocks the event loop from 1 ms before `deadline` until LATE_BY_MS after it,
// then delivers the provider completion before any timer that became due.
// Returns how many timers due at the deadline that completion cancelled: the
// stage's own deadline timer, still undelivered when the late answer arrived.
// (Voice keeps its Type-window timer at the first-phase deadline as well.)
async function completeAfterBlockedDeadline(h, deadline, execution, rawOutput) {
  const dueAtDeadline = () => [...h.clock.timers.values()].filter((timer) => timer.at === 10_000 + deadline).length;
  await h.clock.advanceTo(deadline - 1);
  const undelivered = dueAtDeadline();
  h.clock.now = 10_000 + deadline + LATE_BY_MS;
  completeCandidate(execution, { rawOutput });
  await h.clock.flush();
  return undelivered - dueAtDeadline();
}

for (const entry of ["voice", "screen", "correction"]) for (const cachedFast of [false, true]) {
  test(`ST183-5 ${entry}: an Intelligent Affinity that completes after the stage deadline and is processed before the late deadline timer is not consumed${cachedFast ? "; the cached Fast is" : ""}`, { concurrency: false }, async () => {
    const h = st183Harness();
    try {
      const handle = scheduleEntry(h, entry);
      const started = startEntryConsumer(h, entry, handle);
      if (cachedFast) {
        await h.clock.advanceTo(879);
        completeFastAffinity(h);
      }
      await h.clock.advanceTo(cachedFast ? 900 : 10);
      const late = candidate(h, "affinity", "intelligent");
      expectEqual(await completeAfterBlockedDeadline(h, STAGE_MS, late, PARENT_RELATED), 1,
        "stage deadline timers still undelivered when the late answer arrived, and cancelled by it");
      await h.clock.advanceTo(STAGE_MS + LATE_BY_MS + 10);
      const dispatched = candidates(h, "canonical");
      expectEqual(dispatched.length, 2, "Canonical physical candidates");
      const request = dispatched[0].request;
      expectEqual(request.semanticPayload.affinity.parent, cachedFast
        ? { status: "available", decision: "independent", confidence: 0.95, currentEvidenceSpans: [QUESTION], parentEvidenceSpans: [] }
        : { status: "unknown" }, "Canonical input parent Affinity");
      expectEqual(request.parentPredecessorOutputHash,
        cachedFast ? splitModule.hashTaskRelationSplitOutput(FAST_PARENT_INDEPENDENT) : undefined,
        "Canonical parent predecessor output hash");
      expectEqual([h.metadata.taskRelationParentAffinitySelectedProviderTier, h.metadata.taskRelationParentAffinityDisposition,
        h.metadata.taskRelationParentAffinityDecision],
      cachedFast ? ["fast", "shadow-observed", "independent"] : [undefined, "candidate-deadline-expired", undefined],
      "Affinity stage terminal");
      completeCandidate(dispatched.find((execution) => tierOf(execution) === "intelligent"),
        { rawOutput: canonicalOutput("unknown") });
      await h.clock.advanceTo(STAGE_MS + LATE_BY_MS + 100);
      const recorded = (key) => h.metadata[`taskRelationOrderedResolution${key}`];
      expectEqual(recorded("AffinityParentDisposition"), cachedFast ? "available" : "candidate-deadline-expired",
        "final parent Affinity");
      expectEqual([recorded("Stage"), recorded("Relation")],
        cachedFast ? ["runtime-matrix", "new-parent"] : [NULL_HYPOTHESIS, "followup-parent"], "final Relation source");
      expectEqual(String(recorded("Reason")).includes("related"), false, "the late Affinity decided the relation");
      expectEqual(finalRelation(h, entry, started), recorded("Relation"), "released relation");
      expectEqual(h.executions.length, 4, "physical model requests");
    } finally { h.restore(); }
  });

  test(`ST183-5 ${entry}: an Intelligent Canonical that completes after its deadline and is processed before the late deadline timer never decides the relation${cachedFast ? "; the cached Fast does" : ""}`, { concurrency: false }, async () => {
    const h = st183Harness();
    try {
      const handle = scheduleEntry(h, entry);
      const started = startEntryConsumer(h, entry, handle);
      await h.clock.advanceTo(300);
      settleIntelligentAffinity(h);
      await h.clock.advanceTo(700);
      const dispatched = candidates(h, "canonical");
      expectEqual(dispatched.length, 2, "Canonical physical candidates");
      // The Canonical stage has 4 s from its enqueue; both requests carry what is left of it.
      const enqueuedAt = entry === "correction" ? 600 : 300;
      const deadline = enqueuedAt + STAGE_MS;
      expectEqual(dispatched.map((execution) => execution.dispatchedAt - 10_000 + execution.timeoutMs),
        [deadline, deadline], "Canonical stage deadline");
      if (cachedFast) {
        await h.clock.advanceTo(900);
        completeCandidate(candidate(h, "canonical", "fast"), { rawOutput: canonicalOutput("followup-parent") });
      }
      await h.clock.advanceTo(deadline - 1);
      expectEqual(entryWaitEnded(h, entry, started), false, "wait still open 1 ms before the Canonical deadline");
      // The late answer differs from everything valid before the deadline.
      const lateRelation = cachedFast ? "new-parent" : "followup-parent";
      expectEqual(await completeAfterBlockedDeadline(h, deadline, candidate(h, "canonical", "intelligent"),
        canonicalOutput(lateRelation)), 1,
      "Canonical deadline timers still undelivered when the late answer arrived, and cancelled by it");
      await h.clock.advanceTo(deadline + LATE_BY_MS + 100);
      expectEqual(entryWaitEnded(h, entry, started), true, "wait over");
      const recorded = (key) => h.metadata[`taskRelationOrderedResolution${key}`];
      expectEqual([h.metadata.taskRelationSplitCanonicalSelectedProviderTier, recorded("CanonicalDisposition"),
        h.metadata.taskRelationSplitCanonicalRelation],
      cachedFast ? ["fast", "available", "followup-parent"] : [undefined, "candidate-deadline-expired", undefined],
      "Canonical stage terminal");
      expectEqual([recorded("Stage"), recorded("Reason"), recorded("Relation")],
        cachedFast ? CANONICAL_FROM_FAST : ["runtime-matrix", "same-type-independent-new-parent", "new-parent"],
        "final Relation source");
      expectEqual(recorded("Relation") === lateRelation, false, "the late Canonical decided the relation");
      expectEqual(finalRelation(h, entry, started), recorded("Relation"), "released relation");
      if (entry === "screen") {
        expectEqual(started.wait.value.canonicalOutcome?.outputHash,
          cachedFast ? splitModule.hashTaskRelationSplitOutput(canonicalOutput("followup-parent")) : undefined,
          "Canonical adopted by the final resolver");
      }
      expectEqual(h.executions.length, 4, "physical model requests");
    } finally { h.restore(); }
  });
}

// ---- ST183-6 / ST183-7: budgets, call counts and the recorded handoff chain ----

// Deadline path in both stages: Fast-only candidates, both selected at their
// stage deadline. `at` values are milliseconds from the Affinity stage start.
async function runDeadlinePath({ entry, child = false, setup = SETUPS[0], eventLoopDelayMs = 0, debug = false, recording = false }) {
  const h = st183Harness({ child, debug, recording });
  try {
    injectSelectorSetupCost(h, setup);
    const handoff = {};
    const selector = h.environment.requestTaskRelationProviderCandidates;
    h.environment.requestTaskRelationProviderCandidates = (input, dependencies) => selector({ ...input,
      onObservation(event) {
        if (event.event === "selected" && input.request.operationKind === "task-relation-parent-affinity") {
          handoff.selectedAt = event.at - 10_000;
          handoff.selectedWallNs = process.hrtime.bigint();
        }
        input.onObservation?.(event);
      } }, dependencies);
    const handle = scheduleRelation(h, { sourceKind: entry === "screen" ? "screen" : "voice" });
    const startCanonical = handle.startCanonical;
    handle.startCanonical = (input) => {
      handoff.consumedAt = h.clock.now - 10_000;
      handoff.consumedWallNs = process.hrtime.bigint();
      handoff.canonicalDeadlineAt = input.deadlineAt - 10_000;
      return startCanonical(input);
    };
    const started = await startConsumerInOrder(h, handle, { entry });
    h.clock.setTimeout(() => completeFastAffinity(h), 879);
    await advancePast(h, STAGE_MS, eventLoopDelayMs);
    const request = assertCanonicalConsumedSelectedAffinity(h, { child });
    // A relation the active topology can execute: Voice inherits the active child's type.
    const relation = !child ? "followup-parent" : entry === "voice" ? "child-probe" : "resume-parent";
    completeCandidate(candidate(h, "canonical", "fast"), { rawOutput: canonicalOutput(relation) });
    const canonicalCompletedAt = h.clock.now - 10_000;
    await h.clock.advanceTo(handoff.canonicalDeadlineAt - 1);
    const openBeforeDeadline = entry === "voice" ? !voiceWaitEnded(h) : h.metadata.taskRelationOrderedResolutionStage === undefined;
    await h.clock.advanceTo(handoff.canonicalDeadlineAt);
    const outcome = await settledOutcome(h, entry, started);
    return { h, handle, request, outcome, decision: outcome?.decision, handoff, canonicalCompletedAt, openBeforeDeadline, relation };
  } catch (error) {
    h.restore();
    throw error;
  }
}

for (const entry of ["voice", "screen"]) for (const child of [false, true]) {
  test(`ST183-6 ${entry} ${child ? "child+parent" : "parent-only"} deadline path: call caps, routes and the 4s + 4s budgets are unchanged`, { concurrency: false }, async (t) => {
    for (const { label, setup, eventLoopDelayMs } of setupAndDelayCombinations()) {
      const run = await runDeadlinePath({ entry, child, setup, eventLoopDelayMs });
      const { h, handoff } = run;
      try {
        const sides = child ? 2 : 1;
        expectEqual(candidates(h, "affinity").length, 2 * sides, `${label}: physical Affinity requests`);
        expectEqual(candidates(h, "canonical").length, 2, `${label}: physical Canonical requests`);
        expectEqual(h.executions.map(tierOf).sort(), [...Array(sides + 1).fill("fast"), ...Array(sides + 1).fill("intelligent")],
          `${label}: one Intelligent and one Fast route per operation`);
        expectEqual(new Set(h.executions.map((execution) => execution.executionIdentity.requestId)).size,
          h.executions.length, `${label}: distinct physical request ids`);
        // Each dispatched candidate gets exactly what is left of its stage, never more than 4 s:
        // setup before dispatch spends the Affinity budget, and Canonical starts a fresh 4 s at enqueue.
        expectEqual(candidates(h, "affinity").map((execution) => execution.timeoutMs),
          candidates(h, "affinity").map((execution) => 10_000 + STAGE_MS - execution.dispatchedAt),
          `${label}: Affinity request budgets`);
        expectEqual(candidates(h, "affinity").every((execution) => execution.timeoutMs <= STAGE_MS &&
          execution.timeoutMs >= STAGE_MS - 2 * sides * setup.costMs), true, `${label}: Affinity request budget bounds`);
        expectEqual(candidates(h, "canonical").map((execution) => execution.timeoutMs), [STAGE_MS, STAGE_MS],
          `${label}: Canonical request budgets`);
        // Canonical gets at most 4 s from its enqueue; no grace is added anywhere.
        expectEqual(handoff.canonicalDeadlineAt - handoff.consumedAt, STAGE_MS, `${label}: Canonical stage budget`);
        expectEqual(handoff.consumedAt, handoff.selectedAt, `${label}: consumed when selected`);
        const lateBy = Math.max(eventLoopDelayMs, setup.point === "during" ? setup.costMs : 0);
        expectEqual(handoff.selectedAt, STAGE_MS + lateBy, `${label}: Affinity selected at`);
        expectEqual(run.openBeforeDeadline, true, `${label}: wait open before the Canonical deadline`);
        expectEqual(h.metadata.taskRelationOrderedResolutionWaitMs,
          handoff.canonicalDeadlineAt - (entry === "voice" ? 50 : 0), `${label}: consumer wait`);
        expectEqual([h.metadata.taskRelationOrderedResolutionStage, h.metadata.taskRelationOrderedResolutionRelation],
          ["canonical-relation", run.relation], `${label}: final Relation source`);
        t.diagnostic(JSON.stringify({ path: "deadline", entry, child, setup: setup.name, eventLoopDelayMs,
          affinity: { completedAt: 879, selectedAt: handoff.selectedAt, consumedAt: handoff.consumedAt,
            selectionToConsumptionWallMicros: Number((handoff.consumedWallNs - handoff.selectedWallNs) / 1_000n) },
          canonical: { enqueuedAt: handoff.consumedAt, completedAt: run.canonicalCompletedAt,
            deadlineAt: handoff.canonicalDeadlineAt,
            selectedAt: h.metadata.taskRelationSplitCanonicalSelectedAt - 10_000 },
          finalAt: h.metadata.taskRelationOrderedResolutionDeadlineAt - 10_000 -
            h.metadata.taskRelationOrderedResolutionRemainingMs,
          physicalRequests: h.executions.length }));
      } finally { h.restore(); }
    }
  });
}

for (const entry of ["voice", "screen"]) {
  test(`ST183-6 ${entry} normal path: timely Intelligent results are consumed with no added wait`, { concurrency: false }, async (t) => {
    const run = await runCanonicalStage({ entry, script: [["intelligent", 1_300, canonicalOutput("new-parent")]] });
    const { h } = run;
    try {
      expectEqual(h.executions.length, 4, "physical model requests");
      expectEqual([h.metadata.taskRelationParentAffinitySelectedAt, h.metadata.taskRelationSplitCanonicalSelectedAt],
        [10_300, 11_300], "selected at completion");
      expectEqual(h.metadata.taskRelationOrderedResolutionCanonicalDeadlineAt, 10_300 + STAGE_MS, "Canonical deadline");
      expectEqual(h.metadata.taskRelationOrderedResolutionRemainingMs, STAGE_MS - 1_000, "final decision at Canonical completion");
      expectEqual(h.metadata.taskRelationOrderedResolutionLateWorkCancelled, false, "late work");
      expectEqual(h.clock.timers.size, 0, "no timer left behind");
      if (entry === "voice") expectEqual(h.advisorCalls[0].at, 1_300, "Advisor handoff at");
      t.diagnostic(JSON.stringify({ path: "normal", entry,
        affinity: { completedAt: 300, selectedAt: 300, consumedAt: 300 },
        canonical: { enqueuedAt: 300, completedAt: 1_300, selectedAt: 1_300 }, finalAt: 1_300,
        physicalRequests: h.executions.length }));
    } finally { h.restore(); }
  });
}

for (const entry of ["voice", "screen"]) {
  test(`ST183-7 ${entry}: selected, authorized, consumed and final source correlate from existing trace fields; Debug and Recording do not decide the handoff`, { concurrency: false }, async () => {
    const observed = [];
    // Debug and Recording are independent switches: all four combinations.
    const switches = [false, true].flatMap((debug) => [false, true].map((recording) => ({ debug, recording })));
    for (const { debug, recording } of switches) {
      const run = await runDeadlinePath({ entry, debug, recording });
      const { h, request } = run;
      try {
        const m = h.metadata;
        // completed -> selected: the physical candidate and its stage deadline.
        expectEqual(m.taskRelationParentAffinityCompletedAt, 10_879, "candidate completed at");
        expectEqual(m.taskRelationParentAffinitySelectedRequestId, `${m.taskRelationParentAffinityOperationId}:fast`,
          "selected physical request");
        expectEqual([m.taskRelationParentAffinitySelectedAt, m.taskRelationParentAffinityStageDeadlineAt],
          [10_000 + STAGE_MS, 10_000 + STAGE_MS], "selected at the stage deadline");
        // selected -> authorized: the same operation passed its lease.
        expectEqual([m.taskRelationParentAffinityLeaseAuthorized, m.taskRelationParentAffinityDisposition,
          m.taskRelationParentAffinityDecision], [true, "shadow-observed", "independent"], "authorized Affinity");
        // authorized -> consumed: Canonical's recorded predecessor is that operation and output.
        expectEqual([m.taskRelationSplitParentPredecessorOperationId, m.taskRelationSplitParentPredecessorOutputHash],
          [m.taskRelationParentAffinityOperationId, m.taskRelationParentAffinityOutputHash], "recorded Canonical predecessor");
        expectEqual([request.parentPredecessorOperationId, request.parentPredecessorOutputHash],
          [m.taskRelationParentAffinityOperationId, m.taskRelationParentAffinityOutputHash], "actual Canonical predecessor");
        expectEqual(m.taskRelationSplitCanonicalSemanticPayloadDigest, request.semanticPayloadDigest, "recorded Canonical input digest");
        expectEqual([m.taskRelationSplitCanonicalSelectedProviderTier, m.taskRelationSplitCanonicalLeaseAuthorized,
          m.taskRelationSplitCanonicalPredecessorsAuthorized, m.taskRelationSplitCanonicalRelation],
          ["fast", true, true, "followup-parent"], "authorized Canonical");
        // consumed -> final source.
        expectEqual([m.taskRelationOrderedResolutionAffinityParentDisposition, m.taskRelationOrderedResolutionCanonicalDisposition,
          m.taskRelationOrderedResolutionStage, m.taskRelationOrderedResolutionReason, m.taskRelationOrderedResolutionRelation],
          ["available", "available", "canonical-relation", "canonical-authorized", "followup-parent"], "final source");
        // Each switch feeds its own sink and only that one.
        expectEqual(h.debugOutputs, debug ? ["taskRelationParentAffinity fast candidate output",
          "taskRelationSplitCanonical fast candidate output"] : [], `debug=${debug}: candidate outputs written to the trace`);
        if (recording) {
          const lifecycle = h.recorded.filter((row) => row.stage === "task-relation-provider-candidate");
          expectEqual(lifecycle.filter((row) => row.taskRelationCandidateEvent === "selected")
            .map((row) => [row.taskRelationCandidateRequestId, row.at, row.taskRelationCandidateDeadlineAt]),
            [[m.taskRelationParentAffinitySelectedRequestId, 10_000 + STAGE_MS, 10_000 + STAGE_MS],
              [m.taskRelationSplitCanonicalSelectedRequestId, 10_000 + 2 * STAGE_MS, 10_000 + 2 * STAGE_MS]],
            "recorded selections");
          expectEqual(h.recorded.filter((row) => row.kind === "relation-decision" &&
            row.metadata?.taskRelationSplitCanonicalLeaseAuthorized !== undefined).length >= 1, true,
            "recorded Canonical decision");
        } else {
          expectEqual(h.recorded.length, 0, "nothing recorded with Recording off");
        }
        observed.push(plain({ request, final: Object.fromEntries(Object.entries(m).filter(([key]) =>
          key.startsWith("taskRelationOrderedResolution"))), advisor: h.advisorCalls.map((call) => [call.at, call.args[7]?.relation]),
          decision: run.decision && [run.decision.stage, run.decision.reason, run.decision.relation],
          // The chain the correlation above was read from: selected, authorized, consumed.
          correlation: Object.fromEntries(Object.entries(m).filter(([key]) =>
            /^taskRelation(ParentAffinity|SplitCanonical|SplitParentPredecessor)(Selected|LeaseAuthorized|PredecessorsAuthorized|OperationId|OutputHash|Disposition|Decision|Relation|StageDeadlineAt|CompletedAt)/.test(key))) }));
        expectEqual([settlementCount(h, "taskRelationParentAffinityLeaseAuthorized"),
          settlementCount(h, "taskRelationSplitCanonicalLeaseAuthorized"),
          settlementCount(h, "taskRelationParentAffinitySelectedAt"),
          settlementCount(h, "taskRelationSplitCanonicalSelectedAt")], [1, 1, 1, 1], "one settlement and one selection per stage");
      } finally { h.restore(); }
    }
    expectEqual(Object.keys(observed[0].correlation).length >= 14, true, "correlation fields compared");
    switches.forEach(({ debug, recording }, index) => assert.deepEqual(observed[index], observed[0],
      `handoff and correlation with debug=${debug} recording=${recording} equal those with both off`));
  });
}
