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
// Task 178A: the shared helper builds the real critical event stream; the Hook's
// own emit callbacks are extracted once, like every other callback here.
const {
  createRuntimeCriticalEventHarness,
  normalizeRuntimeCriticalEvents,
  RUNTIME_CRITICAL_EVENT_HOOK_CALLBACKS,
} = await import(pathToFileURL(
  path.join(root, ".tmp-tests/tests/helpers/runtime-critical-events.js")));
const criticalEventCallbackSources = Object.fromEntries(
  RUNTIME_CRITICAL_EVENT_HOOK_CALLBACKS.map((name) => [
    name,
    findNamedDeclaration(sourceFile, name).initializer.arguments[0].getText(sourceFile),
  ])
);
// Task 178 LG: the real frontend logger with its delivery boundary replaced, and
// the field ledger of its call sites. The callbacks extracted here hold four of
// those call sites: the Ordered operation's metadata write, the observation
// stage settle and the two of the Voice foreground window.
const {
  createDiagnosticLogSpy,
  assertEntryInLedger,
  assertNothingPlanted,
  DIAGNOSTIC_LOG_SPY_LEVELS,
  DIAGNOSTIC_LOG_SPY_FAILING_DELIVERIES,
  PLANTED,
  PLANTED_VALUES,
  ledgerRowOf,
  notGraded,
} = await import(pathToFileURL(
  path.join(root, ".tmp-tests/tests/helpers/diagnostic-log-spy.js")));
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
const healthModule = await import(pathToFileURL(path.join(root, ".tmp-tests", "src", "lib", "meeting", "runtime-inference-health.js")));
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

// `logLevel` is the threshold of this harness's own logger instance. At
// "trace" every summary a call site makes is delivered and can be read.
// `logDelivery` is how that logger's delivery boundary answers (see the helper).
function createHarness({ logLevel = "trace", logDelivery = "ok" } = {}) {
  const clock = new Clock();
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  Date.now = () => clock.now;
  globalThis.setTimeout = clock.setTimeout;
  globalThis.clearTimeout = clock.clearTimeout;
  const metadata = {};
  // A second question observed alongside the first has its own trace, as in production.
  const otherTraces = {};
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
    runtimeCrossChecksEnabledRef: { current: false },
    revokeIncompleteAdvisePin: () => {},
    logicalQuestionUnitRef: { current: logicalQuestionUnit },
    responseOpportunityGenerationGateRef: {
      current: { findOperationId: () => undefined, read: () => undefined },
    },
    traceStoreRef: {
      current: {
        updateMetadata: (id, update) => {
          if (id !== "trace") {
            Object.assign((otherTraces[id] ??= {}), update);
            return;
          }
          Object.assign(metadata, update);
          events.push({ at: clock.now - 10_000, metadata: { ...update } });
        },
        recordInput: () => {},
        getTraces: () => [{ id: "trace", metadata },
          ...Object.entries(otherTraces).map(([id, traceMetadata]) => ({ id, metadata: traceMetadata }))],
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
  // Task 178 LG: the real logger, supplied by hand as the callbacks name it. Its
  // timers are its own, so the exact timer assertions of this harness never see
  // a flush timer; only its delivery boundary is replaced.
  const diagnosticLog = createDiagnosticLogSpy({ threshold: logLevel, now: () => clock.now, delivery: logDelivery });
  environment.logDiagnostic = diagnosticLog.logDiagnostic;
  // Task 178A: the real stream on its own manual clock, so the exact timer
  // assertions of this harness never see a delivery timer.
  const criticalEvents = createRuntimeCriticalEventHarness({
    sessionId: state.sessionId,
    now: () => clock.now,
  });
  criticalEvents.install(environment, (name) =>
    vm.runInContext(transpile(`(${criticalEventCallbackSources[name]})`), context));
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
    otherTraces,
    events,
    advisorCalls,
    environment,
    criticalEvents,
    diagnosticLog,
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

const RELATION_OPERATION_KINDS = ["task-relation-child-affinity", "task-relation-parent-affinity",
  "task-relation-canonical-shadow"];
// A circuit that is already open for the harness session, for every Relation stage.
function openRelationCircuit(harness) {
  const sessionId = harness.environment.contextManagerRef.current.getState().sessionId;
  for (const operationKind of RELATION_OPERATION_KINDS) {
    harness.environment.taskRelationSplitShadowCircuitRef.current.open({ operationKind, sessionId,
      reason: "provider-configuration-error" });
  }
}
const relationCircuitOpen = (harness) => RELATION_OPERATION_KINDS.map((operationKind) =>
  harness.environment.taskRelationSplitShadowCircuitRef.current.read(operationKind,
    harness.environment.contextManagerRef.current.getState().sessionId).open);

// Real admission coordinator, operation runtimes and session circuit breaker;
// only the physical provider request is substituted. Each physical candidate is
// one deferred execution.
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
  // The real session circuit breaker: an operation that opens it is seen by
  // every later read, as in production.
  harness.environment.taskRelationSplitShadowCircuitRef = {
    current: new healthModule.RuntimeInferenceSessionCircuitBreaker(),
  };
  if (circuitOpen) openRelationCircuit(harness);
  for (const [key, kind] of [
    ["taskRelationChildAffinityRuntimeRef", "task-relation-child-affinity"],
    ["taskRelationParentAffinityRuntimeRef", "task-relation-parent-affinity"],
    ["taskRelationCanonicalShadowRuntimeRef", "task-relation-canonical-shadow"],
    // Observation has its own three instances of the same runtime class.
    ["taskRelationChildAffinityObservationRuntimeRef", "task-relation-child-affinity"],
    ["taskRelationParentAffinityObservationRuntimeRef", "task-relation-parent-affinity"],
    ["taskRelationCanonicalShadowObservationRuntimeRef", "task-relation-canonical-shadow"],
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

// PC2, Relation family. The original eligibility is fixed (an active parent and a
// current question); Debug, Recording and Runtime Cross-checks are crossed, for an
// operation that asked for no release window (observation) and for one that did
// (formal). Only Cross-checks admits the observation; nothing but the release
// window admits the formal operation.
for (const debug of [false, true]) for (const recording of [false, true]) for (const crossChecks of [false, true]) for (const product of [false, true]) {
  test(`PC2 D178 Split admission debug=${debug} recording=${recording} crossChecks=${crossChecks} product=${product}`, { concurrency: false }, async () => {
    const h = createHarness();
    try {
      h.environment.debugModeRef.current = debug;
      h.environment.runtimeCrossChecksEnabledRef.current = crossChecks;
      const sink = { getState: () => ({ active: recording, sessionId: "recording-a" }),
        recordModelInput() {}, recordModelOutput() {}, recordCaptureLifecycle() {}, recordTaskRelationSplitDecision() {},
        recordTaskRelationDecision() {}, recordTaskRelationAdjudicationDecision() {}, recordTrace() {} };
      h.environment.sessionRecordingManagerRef.current = sink;
      h.environment.traceStoreRef.current.recordOutput = () => {};
      const { handle, executions } = productionRelationHandle(h, { runtimeReleaseRequested: product });
      await h.clock.advanceTo(500);
      if (!crossChecks && !product) {
        // Debug and Recording alone start no observation request.
        assert.equal(handle, undefined);
        assert.equal(executions.length, 0);
        assert.equal(h.metadata.taskRelationParentAffinityOperationId, undefined);
        return;
      }
      assert.equal(executions.length, 2, "one Affinity operation, two physical candidates");
      assert.deepEqual(executions.map((execution) => execution.selectedProvider.variables.model).sort(), ["fast", "intelligent"]);
      resolveRelationProvider(executions[0], JSON.stringify({ v: 1, d: "r", c: .99, q: "Implement a queue.", b: "Implement a cache." }));
      await h.clock.advanceTo(600);
      if (!product) {
        assert.equal(executions.length, 4, "the Cross-checks observation automatically starts Canonical");
        resolveRelationProvider(executions[2], JSON.stringify({ schemaVersion: 3, relation: "followup-parent", confidence: .8,
          currentQuestionEvidenceSpans: ["Implement a queue."], parentEvidenceSpans: ["Implement a cache."] }));
        await h.clock.flush();
        assert.equal(h.metadata.taskRelationParentAffinityObservationTrigger, "runtime-cross-checks");
        assert.equal(h.metadata.taskRelationSplitCanonicalObservationTrigger, "runtime-cross-checks");
        assert.equal(h.metadata.taskRelationParentAffinityExecutionStage, "evaluation");
        assert.equal(h.metadata.taskRelationParentAffinityAdmissionLane, "evaluation");
        assert.equal(h.metadata.taskRelationSplitCanonicalAdmissionLane, "evaluation");
        assert.equal(h.advisorCalls.length, 0);
      } else {
        // The formal operation is the same whatever the three switches say.
        assert.equal(executions.length, 2, "a formal operation starts no Canonical by itself");
        assert.equal(h.metadata.taskRelationParentAffinityObservationTrigger, undefined);
        assert.equal(h.metadata.taskRelationParentAffinityExecutionStage, "product");
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
      ...screenExitFixture(harness, "old-screen-operation"),
    });
    const context = vm.createContext(harness.environment);
    harness.environment.finalizeOwnedScreenOperation = vm.runInContext(
      transpile(`(${finalizeOwnedScreenOperationSource})`),
      context
    );
    harness.environment.readScreenAuthorization = vm.runInContext(
      transpile(`(${readScreenAuthorizationSource})`),
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
    // Task 178A: the old operation ended without owning its slot. It is not
    // released; its exit terminal carries its own authorization reading.
    assert.deepEqual(screenOperationTerminals(harness), [["screen-operation-exit", "superseded", "pipeline-owner-mismatch",
      "old-screen-operation", "old-screen-terminal-trace"]], "the superseded operation's own terminal");
  } finally {
    harness.restore();
  }
});

// Task 178A. What the Screen flow's finally block reads when the operation no
// longer owns its slot: its own commit token and the real authorization reader.
function screenExitFixture(harness, operationId) {
  const snapshot = () => imports.buildRuntimeCommitSnapshot({
    runtimeEpoch: harness.environment.runtimeEpochRef.current,
    contextState: harness.environment.contextManagerRef.current.getState(),
  });
  return {
    screenRuntimeToken: imports.createRuntimeCommitToken({ operationId, pipeline: "screen", snapshot: snapshot() }),
    readRuntimeCommitSnapshot: snapshot,
    screenGenerationLease: undefined,
    screenCaptureSucceeded: true,
    screenFlowEnd: undefined,
  };
}
// The events live in the harness's vm realm; plain copies are compared.
function screenOperationTerminals(harness) {
  return JSON.parse(JSON.stringify(harness.criticalEvents.events()))
    .filter((event) => event.fact === "terminal" && event.terminal.object === "screen-operation")
    .map((event) => [event.stage, event.terminal.disposition, event.terminal.reason, event.refs.operationId, event.refs.traceId]);
}

test("AE2 a Screen flow that ends after it lost its slot announces its own exit terminal: stale-rejected after Pause, Stop or Clear Task invalidated the runtime work, and a terminal that a boundary already announced is kept", { concurrency: false }, () => {
  const run = (arrange) => {
    const harness = createHarness();
    try {
      const coordinator = new ScreenOperationCoordinator();
      coordinator.claim("screen-operation");
      Object.assign(harness.environment, {
        screenOperationCoordinatorRef: { current: coordinator },
        screenOperationId: "screen-operation",
        analysisController: null,
        screenAnalysisAbortRef: { current: null },
        idleReturnStatus: "idle",
        // The Relation wait came back cancelled: the flow set no error and returned.
        screenTerminalError: null,
        trace: { id: "screen-trace" },
        pendingLatePreflightRepair: undefined,
        ...screenExitFixture(harness, "screen-operation"),
      });
      const context = vm.createContext(harness.environment);
      harness.environment.finalizeOwnedScreenOperation = vm.runInContext(
        transpile(`(${finalizeOwnedScreenOperationSource})`), context);
      harness.environment.readScreenAuthorization = vm.runInContext(
        transpile(`(${readScreenAuthorizationSource})`), context);
      const runFinally = vm.runInContext(transpile(`(() => ${captureScreenFinallySource})`), context);
      arrange(harness, coordinator);
      runFinally();
      runFinally();
      return { terminals: screenOperationTerminals(harness), stats: harness.criticalEvents.stream.getStats() };
    } finally {
      harness.restore();
    }
  };
  // What invalidateRuntimeWork does for Pause, Stop and Clear Task: the epoch
  // advances and the Screen slot is reset.
  const invalidated = run((harness, coordinator) => {
    harness.environment.runtimeEpochRef.current += 1;
    coordinator.reset();
  });
  assert.deepEqual(invalidated.terminals, [["screen-operation-exit", "stale-rejected", "runtime-epoch-mismatch",
    "screen-operation", "screen-trace"]], "invalidated during the wait");
  assert.equal(invalidated.stats.duplicateSuppressed, 1, "one terminal per operation, however often the exit is read");
  // The flow's own boundary rejected the operation first, with its own reason;
  // the exit that follows does not replace that terminal.
  const rejectedFirst = run((harness, coordinator) => {
    harness.environment.emitRuntimeCriticalEvent({
      fact: "terminal", stage: "screen-operation-authorization", purpose: "formal", runtimeSessionId: "session-a",
      runtimeEpoch: 1, terminal: { object: "screen-operation", disposition: "stale-rejected", reason: "parent-revision-mismatch" },
      refs: { operationId: "screen-operation", operationKind: "screen-operation", traceId: "screen-trace" },
    });
    coordinator.claim("newer-screen-operation");
  });
  assert.deepEqual(rejectedFirst.terminals, [["screen-operation-authorization", "stale-rejected", "parent-revision-mismatch",
    "screen-operation", "screen-trace"]], "the first terminal is kept");
  // The operation still owns its slot: the owner's release, cancelled after its capture.
  const owned = run(() => undefined);
  assert.deepEqual(owned.terminals, [["screen-operation-release", "released", "cancelled", "screen-operation", "screen-trace"]],
    "an owner that was cancelled after its capture");
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
    // The flow's own flags, read by the release terminal: the model had
    // completed, so the capture had succeeded, and the flow did not run to its end.
    screenCaptureSucceeded: true,
    screenFlowEnd: undefined,
    pendingLatePreflightRepair: undefined,
    sessionRecordingManagerRef: { current: undefined },
  };
  const context = vm.createContext(environment);
  // Task 178A: the real stream and the real Hook emit callbacks.
  const criticalEvents = createRuntimeCriticalEventHarness({ sessionId: contextState.sessionId });
  criticalEvents.install(environment, (name) =>
    vm.runInContext(transpile(`(${criticalEventCallbackSources[name]})`), context));
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
  // Task 178A: the boundary's terminal is the operation's terminal; the
  // owner's release that follows in the finally block adds none.
  assert.deepEqual(JSON.parse(JSON.stringify(criticalEvents.events())).filter((event) => event.fact === "terminal" &&
    event.terminal.object === "screen-operation").map((event) => [event.stage, event.terminal.disposition, event.terminal.reason]),
  [["screen-operation-authorization", "stale-rejected", "preparation-context-revision-mismatch"]], "one terminal");
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
function st183Harness({ child = false, debug = false, recording = false, crossChecks = false, recordingSinkCostMs,
  runtime, logLevel, logDelivery } = {}) {
  const h = createHarness({ logLevel, logDelivery });
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
  // Runtime Cross-checks is its own switch: it alone admits the observation families.
  h.environment.runtimeCrossChecksEnabledRef.current = crossChecks;
  if (recording) {
    // A recorder serializes what it is given when it is given it. The trace
    // store hands out one live metadata object, so the stub copies it: a row
    // then shows what was written by that call, not what the trace held later.
    const record = (kind) => (entry) => {
      h.clock.now += recordingSinkCostMs?.(kind, entry) ?? 0;
      h.recorded.push({ kind, ...entry, ...(entry.metadata ? { metadata: { ...entry.metadata } } : {}) });
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
  unit = logicalQuestionUnit, authorizeSourceOperation = sourceCurrent, traceId = "trace" } = {}) {
  return h.environment.scheduleTaskRelationAdjudication({
    turn: { speaker: "them", text: QUESTION }, traceId, turnGateAction: "answer-refresh",
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
// against this harness's runtime epoch and its real Relation runtimes, the three
// formal ones and their three observation instances.
// Every other ref it touches belongs to work the harness does not run; those
// are inert here.
const invalidateRuntimeWorkSource = findNamedDeclaration(sourceFile, "invalidateRuntimeWork")
  .initializer.arguments[0].getText(sourceFile);
const RELATION_RUNTIME_REFS = ["taskRelationChildAffinityRuntimeRef", "taskRelationParentAffinityRuntimeRef",
  "taskRelationCanonicalShadowRuntimeRef"];
// The observation instances of the same three runtimes (178/168 PC).
const OBSERVATION_RUNTIME_REFS = ["taskRelationChildAffinityObservationRuntimeRef",
  "taskRelationParentAffinityObservationRuntimeRef", "taskRelationCanonicalShadowObservationRuntimeRef"];
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
    ...Object.fromEntries([...RELATION_RUNTIME_REFS, ...OBSERVATION_RUNTIME_REFS].map((name) => [name, h.environment[name]])),
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
      if (circuitOpen) openRelationCircuit(h);
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

// ---------------------------------------------------------------------------
// 178/168 PC: Relation observation isolation (PC3) and its lifecycle (PC6).
//
// Runtime Cross-checks admits an extra Split Relation, and its automatic
// Canonical, for a question that asked for no release window. That work is
// observation. Only a result produced by an operation scheduled as formal may
// reach the formal resolver, so nothing the observation produces may change the
// released settlement, its operation ids, the Plan built from it, the Type wait,
// or another question's formal operation.
//
// Every run below is the real composition: the Hook's own scheduler, executor
// and Voice consumer, the real Screen and Correction call sites, the selector,
// admission coordinator, operation runtimes, lease and predecessor validation,
// the shared Ordered operation and the settlement coordinator. Only the
// physical provider request, the clock and the I/O sinks are substituted. Each
// comparison runs the same script twice, with the observation admitted and not.
// ---------------------------------------------------------------------------

const { buildSettledAdvisorExecutionPlan } = await compiledMeetingModule("settled-advisor-execution-plan");
const SHORT_QUESTION = "A queue.";
// The primary ask kept in normalizedText is under three word-equivalents, so no
// Relation release window is requested. The sources still carry the whole
// interviewer turn, which is what the Type window is decided from.
const shortUnit = (overrides = {}) => ({ ...logicalQuestionUnit, normalizedText: SHORT_QUESTION, ...overrides });
const OBSERVED_UNIT_ID = "lqu-observed";
const OBSERVED_TRACE = "trace-observed";
const PARENT_INDEPENDENT = FAST_PARENT_INDEPENDENT;
const OPPOSITE = { independent: { affinity: PARENT_RELATED, canonical: "followup-parent" },
  related: { affinity: PARENT_INDEPENDENT, canonical: "new-parent" } };
const AFFINITY_OUTPUT = { independent: PARENT_INDEPENDENT, related: PARENT_RELATED };
const ofQuestion = (h, unitId, stage, tier) => h.executions.filter((execution) =>
  execution.request.identity.logicalQuestionUnitId === unitId &&
  execution.request.operationKind.includes(stage) && (!tier || tierOf(execution) === tier));
// The physical requests one question made: route, budget, dispatch time, payload and whether it was aborted.
const requestsOf = (h, unitId) => h.executions
  .filter((execution) => execution.request.identity.logicalQuestionUnitId === unitId)
  .map((execution) => [execution.request.operationKind, tierOf(execution), execution.dispatchedAt - 10_000, execution.timeoutMs,
    execution.executionIdentity.requestId, execution.request.semanticPayloadDigest, execution.signal.aborted]);
const PLAN_PROVIDERS = { providers: [{ id: "main", curl: "https://main.test" }],
  selectedProvider: { provider: "main", variables: {} }, codingProvider: { provider: "main", variables: {} } };
// Trace fields an admitted observation of the same question writes. They are
// Trace-only data; every other recorded field belongs to the formal path.
const OBSERVATION_TRACE_KEY = /^(taskRelation(Parent|Child)Affinity|taskRelationSplit|taskRelationCandidate|runtimeInference)/;
const formalTrace = (metadata) => Object.fromEntries(Object.entries(metadata)
  .filter(([key]) => !OBSERVATION_TRACE_KEY.test(key)));

// The Voice consumer for a given question, with a production-shaped Type handle:
// 2 s Type wait with an active parent, Type keeps the current (Coding) type.
function startVoiceFor(h, handle, unit, { typeAt = 50, typeOutcome, waitBudgetMs = 2_000 } = {}) {
  h.environment.logicalQuestionUnitRef.current = unit;
  h.environment.scheduleAdvisorAfterQuestionTypeWindow({
    handle: { questionType: { enforcementWindowRequested: true, waitBudgetMs,
      outcome: typeOutcome ?? settlesAt(h, typeAt, { enforcement: { authorized: false } }) }, taskRelation: handle },
    logicalQuestionUnit: unit, traceId: "trace", mode: "voice", triggerTurnId: "turn-current",
  });
}

// Everything Voice hands to the Advisor, and the Plan the real Plan builder
// derives from the released settlement: Parent Action, owner, context, phase and
// requestedArtifacts are read from that Plan, never written by hand.
function voiceRelease(h) {
  const settlement = h.advisorCalls[0]?.args[7];
  const readAt = h.clock.now;
  if (settlement) h.clock.now = 10_000 + h.advisorCalls[0].at;
  const plan = settlement && buildSettledAdvisorExecutionPlan({ settlement,
    activeMeetingTask: h.environment.contextManagerRef.current.getState().activeMeetingTask,
    taskBoundaryCommitted: false, childOwnsResponse: false, providerSnapshot: PLAN_PROVIDERS,
    memoryUseCase: "meeting_assistant", askFrame: "unknown", topicDomain: "unknown" });
  h.clock.now = readAt;
  return plain({
    releasedAt: h.advisorCalls.map((call) => call.at),
    handoff: h.advisorCalls.map((call) => call.args),
    settlement: settlement && { relation: settlement.relation, questionType: settlement.questionType,
      operationId: settlement.operationId, provenance: settlement.orderedRelationProvenance },
    plan: plan && { parentAction: plan.taskMutationPolicy, owner: plan.responseOwner, context: plan.contextReadScope,
      phase: plan.playbookPhase, requestedArtifacts: plan.requestedArtifacts, whole: plan },
    traceFinished: h.events.filter((event) => event.finish).map((event) => event.finish.slice(1)),
    ui: h.events.filter((event) => event.ui),
    trace: formalTrace(h.metadata),
  });
}

// One short Voice question that asks for no Relation window. `observed` is
// [completes at, raw output] of its observation Affinity (Intelligent candidate),
// used only when the observation was admitted.
async function runNoWindowVoice({ debug = false, crossChecks = false, observed, parent = true, source = sourceCurrent,
  consumerStartsAt = 0, typeAt = 50, typeOutcome, until = 6_000, during } = {}) {
  const h = st183Harness({ debug, crossChecks });
  try {
    if (!parent) h.environment.contextManagerRef.current.getState().activeMeetingTask = undefined;
    const unit = shortUnit();
    h.environment.logicalQuestionUnitRef.current = unit;
    const handle = scheduleRelation(h, { unit, authorizeSourceOperation: source });
    if (observed) h.clock.setTimeout(() => {
      for (const execution of candidates(h, "affinity", "intelligent")) completeCandidate(execution, { rawOutput: observed[1] });
    }, observed[0]);
    const consume = () => startVoiceFor(h, handle, unit, { typeAt, typeOutcome: typeOutcome?.(h) });
    if (consumerStartsAt) h.clock.setTimeout(consume, consumerStartsAt);
    else consume();
    await during?.(h, handle);
    await h.clock.advanceTo(until);
    return { h, handle, unit, release: voiceRelease(h) };
  } catch (error) {
    h.restore();
    throw error;
  }
}
const NO_WINDOW_HANDLE_FIELDS = ["affinityDeadlineAt", "operationId", "affinityOutcome", "readAffinityOutcome",
  "revalidateAffinityOutcome", "canonicalOutcome", "startCanonical", "cancelForegroundWork", "stageSelections"];

// Leaf-level differences between two plain values, each with both sides, so a
// failing comparison names what moved instead of printing two whole objects.
function leafDifferences(actual, expected, path = "") {
  if (actual !== null && expected !== null && typeof actual === "object" && typeof expected === "object" &&
    Array.isArray(actual) === Array.isArray(expected)) {
    return [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort()
      .flatMap((key) => leafDifferences(actual[key], expected[key], path ? `${path}.${key}` : key));
  }
  return Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected) ? []
    : [`${path}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`];
}
// Collects every violated expectation of one run, so a red run reports all of them.
function expectations() {
  const failures = [];
  return {
    failures,
    equal(actual, expected, what) {
      try { expectEqual(actual, expected, what); } catch (error) { failures.push(error.message.split("\n")[0]); }
    },
    same(actual, expected, what) {
      failures.push(...leafDifferences(plain(actual), plain(expected)).map((difference) => `${what} ${difference}`));
    },
  };
}

// ---- PC3: the Voice no-window read ----

for (const debug of [false, true]) for (const decision of ["independent", "related"]) for (const arrival of ["before", "after"]) {
  test(`PC3 voice no-window debug=${debug}: an observation-only ${decision} Affinity arriving ${arrival} the release changes nothing the Advisor receives`, { concurrency: false }, async () => {
    const baseline = await runNoWindowVoice({ debug });
    baseline.h.restore();
    // "before": the observation settles at 20 ms, the Type window releases at 50 ms. "after": at 400 ms.
    const observedAt = arrival === "before" ? 20 : 400;
    const run = await runNoWindowVoice({ debug, crossChecks: true, observed: [observedAt, AFFINITY_OUTPUT[decision]] });
    const { h, handle } = run;
    try {
      const expected = expectations();
      // The observation really ran and really produced the evidence that must not count.
      expected.equal(baseline.h.executions.length, 0, "requests with the observation not admitted");
      expected.equal(candidates(h, "affinity").length, 2, "observation Affinity physical requests");
      expected.equal([h.metadata.taskRelationParentAffinityDecision, h.metadata.taskRelationParentAffinityLeaseAuthorized,
        h.metadata.taskRelationParentAffinityExecutionStage, h.metadata.taskRelationParentAffinitySelectedAt],
        [decision, true, "evaluation", 10_000 + observedAt], "observation Affinity recorded");
      // What the Advisor receives: the null-hypothesis follow-up, released when Type settled.
      expected.equal(run.release.releasedAt, [50], "released at");
      expected.equal([run.release.settlement?.relation, h.metadata.orderedSettlementCoordinatorRelationStage],
        ["followup-parent", NULL_HYPOTHESIS], "released relation and its source");
      expected.same(run.release, baseline.release, "released");
      // The handle the formal consumers hold carries nothing of the observation.
      expected.equal([handle.releaseWindowRequested, NO_WINDOW_HANDLE_FIELDS.filter((field) => handle[field] !== undefined)],
        [false, []], "observation fields lent to the product handle");
      assert.deepEqual(expected.failures, [], "observation reached the formal Voice release");
    } finally { h.restore(); }
  });
}

// The controlled counterexample: same Coding parent, no child, the new question's
// Type stays Coding and Canonical is unavailable. The Affinity model input is the
// same in all three legs; only how the operation was scheduled differs.
test("PC3 counterexample: no Affinity gives followup-parent, a formal independent gives new-parent, an observation-only independent still gives followup-parent", { concurrency: false }, async () => {
  const expected = expectations();
  // Leg 1: no window, no observation, so no Affinity at all.
  const none = await runNoWindowVoice();
  none.h.restore();
  expected.equal([none.h.executions.length, none.release.settlement?.relation, none.h.metadata.orderedSettlementCoordinatorRelationStage],
    [0, "followup-parent", NULL_HYPOTHESIS], "leg 1, no Affinity");

  // Leg 2: the operation is scheduled as formal. Its independent Affinity is
  // adopted, and stays adopted when Canonical never answers.
  const formal = st183Harness();
  let formalAffinityRequest;
  try {
    const handle = scheduleRelation(formal);
    startVoiceFor(formal, handle, logicalQuestionUnit);
    formal.clock.setTimeout(() => completeCandidate(candidate(formal, "affinity", "intelligent"),
      { rawOutput: PARENT_INDEPENDENT }), 20);
    await formal.clock.advanceTo(20 + STAGE_MS + 100);
    formalAffinityRequest = candidate(formal, "affinity", "intelligent").request;
    const release = voiceRelease(formal);
    expected.equal([handle.releaseWindowRequested, candidates(formal, "canonical").length,
      formal.metadata.taskRelationOrderedResolutionCanonicalDisposition], [true, 2, "candidate-deadline-expired"],
    "leg 2, formal operation with Canonical unavailable");
    expected.equal([release.settlement?.relation, formal.metadata.taskRelationOrderedResolutionStage,
      formal.metadata.taskRelationOrderedResolutionReason], ["new-parent", "runtime-matrix", "same-type-independent-new-parent"],
    "leg 2, formal independent");
  } finally { formal.restore(); }

  // Leg 3: the same independent, produced only by the observation. Its automatic
  // Canonical never answers either.
  const observed = await runNoWindowVoice({ crossChecks: true, observed: [20, PARENT_INDEPENDENT], until: 20 + 2 * STAGE_MS + 100 });
  const { h } = observed;
  try {
    const observedRequest = candidate(h, "affinity", "intelligent").request;
    expected.equal([observedRequest.semanticPayloadDigest, h.metadata.taskRelationParentAffinityDecision,
      h.metadata.taskRelationParentAffinityLeaseAuthorized], [formalAffinityRequest.semanticPayloadDigest, "independent", true],
    "leg 3, the observation saw the same Affinity input and produced the same independent");
    expected.equal([observed.release.settlement?.relation, h.metadata.orderedSettlementCoordinatorRelationStage],
      ["followup-parent", NULL_HYPOTHESIS], "leg 3, observation-only independent");
    expected.same(observed.release, none.release, "leg 3 against leg 1:");
    assert.deepEqual(expected.failures, [], "counterexample");
  } finally { h.restore(); }
});

// ---- PC3: a formal result fixed, an opposite observation scheduled around it ----
//
// The first question's Relation is formal: it asked for a release window. A
// second, short question is scheduled while that operation is open. With
// Cross-checks on, the second question gets an observation Affinity and an
// automatic Canonical, and they answer the opposite of the formal result. The
// formal question must end exactly as it does with Cross-checks off: the same
// physical requests, none aborted early, the same recorded stage terminals, the
// same decision and the same release. `formalAffinityAt` and `canonicalAt` fix
// the formal result and when it becomes available.

const FORMAL_AFFINITY_AT = 300;
const FORMAL_CANONICAL_AT = 1_300;
const FORMAL_SCRIPTS = [
  { name: "independent Affinity, Canonical times out", affinity: "independent",
    final: ["runtime-matrix", "same-type-independent-new-parent", "new-parent"], canonical: "candidate-deadline-expired" },
  { name: "independent Affinity, Canonical fails with unusable output", affinity: "independent",
    canonicalResult: { rawOutput: "not json" },
    final: ["runtime-matrix", "same-type-independent-new-parent", "new-parent"], canonical: "malformed-json" },
  { name: "independent Affinity, Canonical answers new-parent", affinity: "independent",
    canonicalResult: { rawOutput: canonicalOutput("new-parent") },
    final: ["canonical-relation", "canonical-authorized", "new-parent"], canonical: "available" },
  { name: "related Affinity", affinity: "related" },
  // The formal Affinity never answers: its stage ends at the deadline, Canonical
  // gets no answer either and the null hypothesis decides. The observation
  // answers independent and new-parent, which would overturn that.
  { name: "no formal Affinity answer", affinity: undefined, affinityDisposition: "candidate-deadline-expired",
    final: (entry) => [NULL_HYPOTHESIS, `${entry === "screen" ? "screen" : "voice"}-preserve-active-parent`, "followup-parent"],
    canonical: "candidate-deadline-expired", requests: 4 },
];
// What the observation answers: the opposite of the formal result, and
// independent / new-parent when the formal Affinity gives no result.
const oppositeOf = (script) => OPPOSITE[script.affinity ?? "related"];
// When the observation is scheduled and when its results arrive, against the
// formal Affinity (300 ms) and the formal Canonical (1300 ms, or its deadline).
// `formalAt` is when the formal question itself is scheduled (0 unless given);
// its script runs from that moment.
const OBSERVATION_TIMINGS = [
  { name: "arriving before the formal result", scheduleAt: 100, affinityAt: 200, canonicalAt: 250 },
  { name: "in flight across the formal result", scheduleAt: 100, affinityAt: 500, canonicalAt: 600 },
  { name: "scheduled and arriving after the formal Affinity", scheduleAt: 700, affinityAt: 800, canonicalAt: 850 },
  // Observation first: it is in flight when the formal question arrives 100 ms
  // later, so the formal schedule supersedes its Affinity. Its automatic
  // Canonical still starts and answers before the formal Affinity does.
  { name: "scheduled first and in flight when the formal question arrives", formalAt: 100, scheduleAt: 0, affinityAt: 300,
    canonicalAt: 350, superseded: true },
];
const observedUnit = () => shortUnit({ id: OBSERVED_UNIT_ID });
const formalRuntimeOperations = (h) => RELATION_RUNTIME_REFS.map((name) => h.environment[name].current.getCurrentOperationId());

async function runFormalBesideObservation({ entry, script, timing, crossChecks, debug = false, child = false }) {
  const h = st183Harness({ crossChecks, debug, child });
  try {
    const formalAt = timing.formalAt ?? 0;
    const own = (stage, tier) => ofQuestion(h, logicalQuestionUnit.id, stage, tier);
    const observed = (stage, tier) => ofQuestion(h, OBSERVED_UNIT_ID, stage, tier);
    const neighbour = { formalOperationsBefore: undefined, formalOperationsAfter: undefined, handle: undefined };
    // The neighbouring short question and its answers, at absolute times.
    const observeNeighbour = () => {
      h.clock.setTimeout(() => {
        neighbour.formalOperationsBefore = formalRuntimeOperations(h);
        neighbour.handle = scheduleRelation(h, { unit: observedUnit(), traceId: OBSERVED_TRACE,
          sourceKind: entry === "voice" ? "screen" : "voice" });
        neighbour.formalOperationsAfter = formalRuntimeOperations(h);
      }, timing.scheduleAt);
      h.clock.setTimeout(() => {
        for (const execution of observed("affinity", "intelligent")) {
          completeCandidate(execution, { rawOutput: oppositeOf(script).affinity });
        }
      }, timing.affinityAt);
      h.clock.setTimeout(() => {
        for (const execution of observed("canonical", "intelligent")) {
          completeCandidate(execution, { rawOutput: canonicalOutput(oppositeOf(script).canonical) });
        }
      }, timing.canonicalAt);
    };
    if (formalAt) {
      observeNeighbour();
      await h.clock.advanceTo(formalAt);
    }
    const handle = scheduleEntry(h, entry);
    const started = {};
    if (entry === "voice") startVoiceFor(h, handle, logicalQuestionUnit);
    else if (entry === "screen") started.wait = watch(h, startScreenConsumer(h, handle));
    else h.clock.setTimeout(() => { started.wait = watch(h, startCorrectionConsumer(h, handle)); }, 200);
    if (script.affinity) h.clock.setTimeout(() => {
      for (const execution of own("affinity", "intelligent")) {
        completeCandidate(execution, { rawOutput: execution.request.affinityKind === "child"
          ? FAST_CHILD_UNRELATED : AFFINITY_OUTPUT[script.affinity] });
      }
    }, FORMAL_AFFINITY_AT);
    if (script.canonicalResult) h.clock.setTimeout(() => {
      for (const execution of own("canonical")) if (!execution.signal.aborted) completeCandidate(execution, script.canonicalResult);
    }, FORMAL_CANONICAL_AT);
    if (!formalAt) observeNeighbour();
    await h.clock.advanceTo(formalAt + FORMAL_AFFINITY_AT + 2 * STAGE_MS + 200);
    const formal = plain({
      relation: finalRelation(h, entry, started),
      waitEndedAt: entry === "voice" ? h.advisorCalls.map((call) => call.at) : [started.wait?.state, started.wait?.at],
      consumer: entry === "voice" ? voiceRelease(h) : started.wait?.value,
      // The formal question's own trace, whole: every stage terminal and the final resolution.
      trace: h.metadata,
      requests: requestsOf(h, logicalQuestionUnit.id),
      handle: { operationId: handle.operationId, affinityDeadlineAt: handle.affinityDeadlineAt,
        releaseWindowRequested: handle.releaseWindowRequested },
    });
    return { h, handle, started, neighbour, formal };
  } catch (error) {
    h.restore();
    throw error;
  }
}

for (const entry of ["voice", "screen", "correction"]) for (const script of FORMAL_SCRIPTS) for (const timing of OBSERVATION_TIMINGS) {
  test(`PC3 ${entry} formal ${script.name}: an opposite observation ${timing.name} leaves the formal Relation, its requests and its release unchanged`, { concurrency: false }, async () => {
    const baseline = await runFormalBesideObservation({ entry, script, timing, crossChecks: false });
    baseline.h.restore();
    const run = await runFormalBesideObservation({ entry, script, timing, crossChecks: true });
    const { h, neighbour } = run;
    try {
      const expected = expectations();
      const recorded = (key) => h.metadata[`taskRelationOrderedResolution${key}`];
      // The observation really ran beside the formal operation, with the opposite answers.
      const observedTrace = h.otherTraces[OBSERVED_TRACE] ?? {};
      expected.equal(requestsOf(baseline.h, OBSERVED_UNIT_ID).length, 0, "observation requests with Cross-checks off");
      expected.equal([ofQuestion(h, OBSERVED_UNIT_ID, "affinity").length, ofQuestion(h, OBSERVED_UNIT_ID, "canonical").length],
        [2, 2], "observation physical requests");
      if (timing.superseded) {
        // In flight when the formal question arrived: its Affinity requests were aborted
        // and its terminal refused, and its automatic Canonical's answer was refused too.
        expected.equal([ofQuestion(h, OBSERVED_UNIT_ID, "affinity").map((execution) => execution.signal.aborted),
          observedTrace.taskRelationParentAffinityDisposition, observedTrace.taskRelationParentAffinityLeaseAuthorized,
          observedTrace.taskRelationParentAffinityDecision, observedTrace.taskRelationSplitCanonicalRelation],
        [[true, true], "operation-id-mismatch", false, undefined, undefined],
        "observation superseded by the formal schedule, on its own trace");
      } else {
        expected.equal([observedTrace.taskRelationParentAffinityDecision, observedTrace.taskRelationSplitCanonicalRelation],
          [script.affinity === "independent" ? "related" : "independent", oppositeOf(script).canonical],
        "opposite observation recorded on its own trace");
      }
      expected.equal(NO_WINDOW_HANDLE_FIELDS.filter((field) => neighbour.handle?.[field] !== undefined), [],
        "observation fields lent to the neighbour's product handle");
      // Scheduling it left the formal instances' current operations alone.
      expected.equal(neighbour.formalOperationsAfter, neighbour.formalOperationsBefore,
        "formal runtimes' current operations across the observation schedule");
      // The formal result is the fixed one.
      expected.equal(recorded("AffinityParentDisposition"), script.affinityDisposition ?? "available", "formal Affinity");
      if (script.final) expected.equal([recorded("Stage"), recorded("Reason"), recorded("Relation")],
        typeof script.final === "function" ? script.final(entry) : script.final, "formal Relation source");
      if (script.canonical) expected.equal(recorded("CanonicalDisposition"), script.canonical, "formal Canonical");
      expected.equal(run.formal.relation, recorded("Relation"), "released relation");
      // What is compared is the whole formal question: its physical requests and its own trace.
      expected.equal([run.formal.requests.length, Object.keys(run.formal.trace).length > 60],
        [script.requests ?? (script.affinity === "related" ? 2 : 4), true], "formal requests and recorded trace fields compared");
      expected.same(run.formal, baseline.formal, "formal");
      assert.deepEqual(expected.failures, [], "observation changed the formal operation");
    } finally { h.restore(); }
  });
}

// ---- PC3: supersession between formal and observation work is one-directional ----

const observationRuntimeOperations = (h) => OBSERVATION_RUNTIME_REFS.map((name) => h.environment[name].current.getCurrentOperationId());
const scheduleObservedNeighbour = (h, sourceKind = "voice") => scheduleRelation(h, { unit: observedUnit(), traceId: OBSERVED_TRACE,
  sourceKind });
const aborted = (executions) => executions.map((execution) => execution.signal.aborted);

test("PC3 supersession: an observation schedule and its automatic Canonical never abort or replace an in-flight formal Affinity or Canonical", { concurrency: false }, async () => {
  const h = st183Harness({ crossChecks: true });
  try {
    const expected = expectations();
    const own = (stage, tier) => ofQuestion(h, logicalQuestionUnit.id, stage, tier);
    const observed = (stage, tier) => ofQuestion(h, OBSERVED_UNIT_ID, stage, tier);
    const handle = scheduleEntry(h, "screen");
    const wait = watch(h, startScreenConsumer(h, handle));
    await h.clock.advanceTo(100);
    const formalAffinity = formalRuntimeOperations(h);
    expected.equal(aborted(own("affinity")), [false, false], "formal Affinity requests in flight");
    // The observation is scheduled while the formal Affinity is in flight.
    scheduleObservedNeighbour(h);
    await h.clock.advanceTo(200);
    expected.equal(observed("affinity").length, 2, "observation Affinity requests");
    expected.equal(aborted(own("affinity")), [false, false], "formal Affinity requests after the observation schedule");
    expected.equal(formalRuntimeOperations(h), formalAffinity, "formal runtimes' current operations after the observation schedule");
    expected.equal(observationRuntimeOperations(h)[1], observed("affinity")[0]?.executionIdentity.executionPlanId,
      "the observation runs on its own Affinity instance");
    // The formal Affinity is consumed and the formal Canonical starts.
    completeCandidate(own("affinity", "intelligent")[0], { rawOutput: PARENT_INDEPENDENT });
    await h.clock.advanceTo(300);
    expected.equal(own("canonical").length, 2, "formal Canonical requests");
    const formalCanonical = formalRuntimeOperations(h);
    // The observation's automatic Canonical starts while the formal Canonical is in flight.
    completeCandidate(observed("affinity", "intelligent")[0], { rawOutput: PARENT_RELATED });
    await h.clock.advanceTo(400);
    expected.equal(observed("canonical").length, 2, "observation Canonical requests");
    expected.equal(aborted(own("canonical")), [false, false], "formal Canonical requests after the observation Canonical started");
    expected.equal(formalRuntimeOperations(h), formalCanonical, "formal runtimes' current operations after the observation Canonical");
    completeCandidate(observed("canonical", "intelligent")[0], { rawOutput: canonicalOutput("followup-parent") });
    completeCandidate(own("canonical", "intelligent")[0], { rawOutput: canonicalOutput("new-parent") });
    await h.clock.advanceTo(500);
    const recorded = (key) => h.metadata[`taskRelationOrderedResolution${key}`];
    expected.equal([wait.state, wait.value?.decision.relation, recorded("AffinityParentDisposition"), recorded("CanonicalDisposition"),
      recorded("Stage")], ["resolved", "new-parent", "available", "available", "canonical-relation"], "formal result");
    expected.equal([h.metadata.taskRelationParentAffinityLeaseAuthorized, h.metadata.taskRelationSplitCanonicalLeaseAuthorized,
      h.metadata.taskRelationSplitCanonicalPredecessorsAuthorized], [true, true, true], "formal leases and predecessors");
    assert.deepEqual(expected.failures, [], "observation superseded formal work");
  } finally { h.restore(); }
});

test("PC3 supersession: a formal schedule cancels in-flight observation Affinity as superseded, and a formal Canonical cancels an in-flight observation Canonical", { concurrency: false }, async () => {
  const h = st183Harness({ crossChecks: true });
  try {
    const expected = expectations();
    const own = (stage, tier) => ofQuestion(h, logicalQuestionUnit.id, stage, tier);
    const observed = (stage, tier) => ofQuestion(h, OBSERVED_UNIT_ID, stage, tier);
    const observedTrace = () => h.otherTraces[OBSERVED_TRACE] ?? {};
    // An observation Affinity is in flight when a formal operation is scheduled.
    scheduleObservedNeighbour(h);
    await h.clock.advanceTo(100);
    expected.equal(aborted(observed("affinity")), [false, false], "observation Affinity requests in flight");
    const handle = scheduleEntry(h, "screen");
    const wait = watch(h, startScreenConsumer(h, handle));
    await h.clock.advanceTo(200);
    expected.equal(aborted(observed("affinity")), [true, true], "observation Affinity requests after the formal schedule");
    expected.equal([observedTrace().taskRelationParentAffinityDisposition, observedTrace().taskRelationParentAffinityLeaseAuthorized],
      ["operation-id-mismatch", false], "superseded observation Affinity terminal");
    expected.equal(aborted(own("affinity")), [false, false], "formal Affinity requests");
    // The superseded observation still starts its automatic Canonical, as before;
    // that Canonical is cancelled when the formal Canonical is scheduled.
    expected.equal(aborted(observed("canonical")), [false, false], "observation Canonical in flight");
    completeCandidate(own("affinity", "intelligent")[0], { rawOutput: PARENT_INDEPENDENT });
    await h.clock.advanceTo(300);
    expected.equal(own("canonical").length, 2, "formal Canonical requests");
    expected.equal(aborted(observed("canonical")), [true, true], "observation Canonical requests after the formal Canonical started");
    expected.equal(observedTrace().taskRelationSplitCanonicalLeaseAuthorized, false, "superseded observation Canonical terminal");
    completeCandidate(own("canonical", "intelligent")[0], { rawOutput: canonicalOutput("new-parent") });
    await h.clock.advanceTo(400);
    expected.equal([wait.state, wait.value?.decision.relation, h.metadata.taskRelationOrderedResolutionStage],
      ["resolved", "new-parent", "canonical-relation"], "formal result");
    expected.equal(h.clock.timers.size, 0, "no timer left behind");
    assert.deepEqual(expected.failures, [], "one-directional supersession");
  } finally { h.restore(); }
});

// ---- PC3: one question revision scheduled both ways (the one-start-per-slot budget) ----
//
// Each Relation runtime allows one start per question revision and slot. A
// formal and an observation operation of the same revision carry the same
// budget key and slot, and the same operation and request ids. On one shared
// runtime whichever started second would end as budget-exhausted. They run on
// separate instances, each with its own ledger, so the formal operation runs as
// it does with Cross-checks off. This is a controlled construction of the
// ledger case; that production schedules one revision both ways is not claimed.

// The admission lane is the only field that tells the two operations' physical
// requests apart: critical for the formal one, evaluation for the observation.
function tagRequestLanes(h) {
  const selector = h.environment.requestTaskRelationProviderCandidates;
  h.environment.requestTaskRelationProviderCandidates = (input, dependencies) => selector(input, { ...dependencies,
    request: (args) => {
      const dispatchedBefore = h.executions.length;
      const result = dependencies.request(args);
      for (const execution of h.executions.slice(dispatchedBefore)) execution.lane = input.lane;
      return result;
    } });
}
const SAME_REVISION_TRACE = "trace-same-revision-observation";
async function runSameRevisionBothWays({ crossChecks, order }) {
  const h = st183Harness({ crossChecks });
  try {
    tagRequestLanes(h);
    const lane = (name, stage, tier) => h.executions.filter((execution) => execution.lane === name &&
      (!stage || execution.request.operationKind.includes(stage)) && (!tier || tierOf(execution) === tier));
    // The same unit and revision on a turn that is not an answer-refresh asks for
    // no release window: with Cross-checks on it is an observation.
    const observe = () => h.environment.scheduleTaskRelationAdjudication({
      turn: { speaker: "them", text: QUESTION }, traceId: SAME_REVISION_TRACE, turnGateAction: "phase-control",
      logicalQuestionUnit, lexical: { type: "coding" }, sourceKind: "voice", authorizeSourceOperation: sourceCurrent });
    const formal = () => {
      const handle = scheduleEntry(h, "voice");
      startVoiceFor(h, handle, logicalQuestionUnit);
      return handle;
    };
    let handle;
    let observationHandle;
    if (order === "observation first") {
      observationHandle = observe();
      await h.clock.advanceTo(100);
      handle = formal();
    } else {
      handle = formal();
      await h.clock.advanceTo(100);
      observationHandle = observe();
    }
    const formalAt = order === "observation first" ? 100 : 0;
    // The clock is at 100 ms here; `fromNow` turns an absolute time into a delay.
    const fromNow = (absolute) => absolute - 100;
    // The observation answers related at 200 ms and follow-up at 250 ms, before
    // the formal Affinity answers independent; the formal Canonical never answers.
    h.clock.setTimeout(() => {
      for (const execution of lane("evaluation", "affinity", "intelligent")) completeCandidate(execution, { rawOutput: PARENT_RELATED });
    }, fromNow(200));
    h.clock.setTimeout(() => {
      for (const execution of lane("evaluation", "canonical", "intelligent")) {
        completeCandidate(execution, { rawOutput: canonicalOutput("followup-parent") });
      }
    }, fromNow(250));
    h.clock.setTimeout(() => {
      for (const execution of lane("critical", "affinity", "intelligent")) completeCandidate(execution, { rawOutput: PARENT_INDEPENDENT });
    }, fromNow(formalAt + FORMAL_AFFINITY_AT));
    await h.clock.advanceTo(formalAt + FORMAL_AFFINITY_AT + STAGE_MS + 200);
    const requests = (name) => lane(name).map((execution) => [execution.request.operationKind, tierOf(execution),
      execution.dispatchedAt - 10_000, execution.timeoutMs, execution.executionIdentity.requestId,
      execution.request.semanticPayloadDigest, execution.signal.aborted]);
    return plain({
      // The formal question, whole: what Voice released, its own trace, its physical requests and its handle.
      formal: { release: voiceRelease(h), trace: h.metadata, requests: requests("critical"),
        handle: { operationId: handle.operationId, affinityDeadlineAt: handle.affinityDeadlineAt,
          releaseWindowRequested: handle.releaseWindowRequested } },
      observation: { requests: requests("evaluation"), trace: h.otherTraces[SAME_REVISION_TRACE] ?? {},
        handleFields: NO_WINDOW_HANDLE_FIELDS.filter((field) => observationHandle?.[field] !== undefined),
        releaseWindowRequested: observationHandle?.releaseWindowRequested },
      unlabelledRequests: h.executions.filter((execution) => !execution.lane).length,
      timersLeft: h.clock.timers.size,
    });
  } finally { h.restore(); }
}

test("PC3 budget slot: the same question unit and revision scheduled as an observation and as a formal operation, in either order, leaves the formal run as it is with Cross-checks off", { concurrency: false }, async () => {
  const expected = expectations();
  for (const order of ["observation first", "formal first"]) {
    const baseline = await runSameRevisionBothWays({ crossChecks: false, order });
    const run = await runSameRevisionBothWays({ crossChecks: true, order });
    const trace = run.formal.trace;
    // Off: the second schedule starts nothing and the formal operation makes its four requests.
    expected.equal([baseline.formal.requests.length, baseline.observation.requests.length, baseline.unlabelledRequests,
      baseline.formal.release.settlement?.relation], [4, 0, 0, "new-parent"], `${order}, Cross-checks off`);
    // On: the observation really started, for the same revision, under the same
    // budget key, slot and operation id as the formal operation, on its own instance.
    expected.equal([run.observation.requests.length, run.unlabelledRequests, run.observation.releaseWindowRequested,
      run.observation.handleFields, run.observation.trace.taskRelationParentAffinityExecutionStage,
      run.observation.trace.taskRelationParentAffinityOperationId === trace.taskRelationParentAffinityOperationId,
      run.observation.trace.taskRelationParentAffinityBudgetRemaining],
    [4, 0, false, [], "evaluation", true, 0], `${order}, the observation of the same revision`);
    const affinityRequestIds = (requests) => requests.filter((request) => request[0].includes("affinity")).map((request) => request[4]).sort();
    expected.equal([affinityRequestIds(run.observation.requests).length, affinityRequestIds(run.observation.requests)],
      [2, affinityRequestIds(run.formal.requests)], `${order}, observation and formal Affinity request ids`);
    // Scheduled first, the observation is superseded by the formal schedule and its
    // Canonical answer refused; scheduled second, it runs to the end beside the formal operation.
    expected.equal([run.observation.trace.taskRelationParentAffinityDisposition, run.observation.trace.taskRelationParentAffinityDecision,
      run.observation.trace.taskRelationSplitCanonicalRelation],
    order === "observation first" ? ["operation-id-mismatch", undefined, undefined] : ["shadow-observed", "related", "followup-parent"],
    `${order}, the observation's own terminals`);
    // The formal operation started on its own budget: four requests, the independent
    // Affinity adopted, the same relation.
    expected.equal([run.formal.requests.length, trace.taskRelationParentAffinityExecutionStage, trace.taskRelationParentAffinityDisposition,
      trace.taskRelationParentAffinityBudgetRemaining, trace.taskRelationOrderedResolutionAffinityParentDisposition,
      trace.taskRelationOrderedResolutionCanonicalDisposition],
    [4, "product", "shadow-observed", 0, "available", "candidate-deadline-expired"], `${order}, formal stages`);
    expected.equal([trace.taskRelationOrderedResolutionStage, trace.taskRelationOrderedResolutionReason,
      run.formal.release.settlement?.relation], ["runtime-matrix", "same-type-independent-new-parent", "new-parent"],
    `${order}, formal Relation`);
    expected.equal([baseline.timersLeft, run.timersLeft], [0, 0], `${order}, timers left`);
    expected.same(run.formal, baseline.formal, `${order}, formal`);
  }
  assert.deepEqual(expected.failures, [], "an observation of the same revision changed the formal operation");
});

// ---- PC3: only formal work opens the session circuit breaker ----
//
// Formal and observation operations read one session circuit breaker. If an
// observation could open it, every later formal Affinity of that kind would be
// refused as a client error for the rest of the session: a formal outcome
// decided by an observation. An observation that finds no provider ends with
// that reason and leaves the circuit alone. A circuit opened by formal work
// still stops later observations, as it did before.

// The Relation routes, with a provider missing for the tiers `isMissing` names.
const routeUnlessMissing = (h, isMissing) => {
  h.environment.resolveRuntimeInferenceModelRouteFromSnapshot = ({ providerTier = "intelligent" }) => ({
    provider: isMissing(providerTier) ? undefined : {}, selectedProvider: { variables: { model: providerTier } },
    providerTier, configFingerprint: providerTier, missingRequiredVariables: [],
    fallbackReason: isMissing(providerTier) ? "provider-missing" : undefined });
};
// A short question that asks for no window is scheduled while the Fast route has
// no provider. The provider configuration is then whole again in the same
// session, and a formal question follows.
async function runFormalAfterUnroutableObservation({ entry, crossChecks }) {
  const h = st183Harness({ crossChecks });
  try {
    let missingTier = "fast";
    routeUnlessMissing(h, (tier) => tier === missingTier);
    scheduleRelation(h, { unit: observedUnit(), traceId: OBSERVED_TRACE });
    await h.clock.advanceTo(100);
    const afterObservation = plain({ circuitOpen: relationCircuitOpen(h), requests: h.executions.length,
      observedCanonical: h.otherTraces[OBSERVED_TRACE]?.taskRelationSplitCanonicalDisposition ?? null });
    missingTier = undefined;
    const handle = scheduleEntry(h, entry);
    const started = {};
    if (entry === "voice") startVoiceFor(h, handle, logicalQuestionUnit);
    else if (entry === "screen") started.wait = watch(h, startScreenConsumer(h, handle));
    else h.clock.setTimeout(() => { started.wait = watch(h, startCorrectionConsumer(h, handle)); }, 200);
    h.clock.setTimeout(() => {
      for (const execution of ofQuestion(h, logicalQuestionUnit.id, "affinity", "intelligent")) {
        completeCandidate(execution, { rawOutput: PARENT_INDEPENDENT });
      }
    }, 300);
    await h.clock.advanceTo(100 + 300 + 2 * STAGE_MS + 200);
    const formal = plain({
      relation: finalRelation(h, entry, started),
      waitEndedAt: entry === "voice" ? h.advisorCalls.map((call) => call.at) : [started.wait?.state, started.wait?.at],
      consumer: entry === "voice" ? voiceRelease(h) : started.wait?.value,
      trace: h.metadata,
      requests: requestsOf(h, logicalQuestionUnit.id),
      circuitOpen: relationCircuitOpen(h),
    });
    return { h, afterObservation, formal };
  } catch (error) {
    h.restore();
    throw error;
  }
}

for (const entry of ["voice", "screen", "correction"]) {
  test(`PC3 ${entry} session circuit: an observation that finds no provider leaves the circuit closed, and a later formal Relation ends as it does with Cross-checks off`, { concurrency: false }, async () => {
    const baseline = await runFormalAfterUnroutableObservation({ entry, crossChecks: false });
    baseline.h.restore();
    const run = await runFormalAfterUnroutableObservation({ entry, crossChecks: true });
    try {
      const expected = expectations();
      // The observation really ran into the missing provider; with the switch off nothing ran.
      expected.equal(baseline.afterObservation, { circuitOpen: [false, false, false], requests: 0, observedCanonical: null },
        "after the short question with Cross-checks off");
      expected.equal(run.afterObservation, { circuitOpen: [false, false, false], requests: 0,
        observedCanonical: "provider-configuration-error" }, "after the observation that found no provider");
      // The formal question that follows is not a client error: it runs and is released.
      expected.equal([run.formal.relation, run.formal.requests.length, run.formal.trace.taskRelationOrderedResolutionStage,
        run.formal.trace.taskRelationOrderedResolutionAffinityParentDisposition, run.formal.circuitOpen],
      ["new-parent", 4, "runtime-matrix", "available", [false, false, false]], "formal Relation after the observation");
      expected.same(run.formal, baseline.formal, "formal");
      assert.deepEqual(expected.failures, [], "an observation decided a formal Relation through the session circuit");
    } finally { run.h.restore(); }
  });
}

test("PC3 session circuit: a formal operation that finds no provider opens it, and later observations are refused without a request", { concurrency: false }, async () => {
  const h = st183Harness({ crossChecks: true });
  try {
    const expected = expectations();
    routeUnlessMissing(h, (tier) => tier === "fast");
    const handle = scheduleEntry(h, "screen");
    const wait = watch(h, startScreenConsumer(h, handle));
    await h.clock.advanceTo(100);
    expected.equal([relationCircuitOpen(h), h.metadata.taskRelationOrderedResolutionAffinityParentDisposition,
      h.metadata.taskRelationOrderedResolutionClientError, wait.state, h.executions.length],
    [[false, true, false], "provider-configuration-error", true, "resolved", 0], "formal operation with no provider");
    // The configuration is whole again; the circuit stays open for the session, as before.
    routeUnlessMissing(h, () => false);
    const operation = scheduleObservationOperation(h, { unit: observedUnit(), traceId: OBSERVED_TRACE });
    const affinity = watch(h, operation.affinityOutcome);
    await h.clock.advanceTo(200);
    expected.equal([affinity.state, affinity.value?.parent.unavailableReason, candidates(h, "affinity").length],
      ["resolved", "provider-circuit-open", 0], "observation Affinity behind the formally opened circuit");
    await h.clock.advanceTo(200 + STAGE_MS + 100);
    expected.equal(h.clock.timers.size, 0, "timers left");
    assert.deepEqual(expected.failures, [], "formal circuit and observation");
  } finally { h.restore(); }
});

test("PC3 session circuit: repeated observations with no provider each end with that reason, send nothing and never open the circuit", { concurrency: false }, async () => {
  const h = st183Harness({ crossChecks: true });
  try {
    const expected = expectations();
    routeUnlessMissing(h, (tier) => tier === "intelligent");
    for (const [index, id] of ["lqu-observed", "lqu-observed-2"].entries()) {
      const operation = scheduleObservationOperation(h, { unit: shortUnit({ id }), traceId: `${OBSERVED_TRACE}-${index}` });
      const affinity = watch(h, operation.affinityOutcome);
      const canonical = watch(h, operation.canonicalOutcome);
      await h.clock.advanceTo(100 * (index + 1));
      expected.equal([affinity.state, affinity.value?.parent.unavailableReason, canonical.state, canonical.value?.unavailableReason],
        ["resolved", "provider-configuration-error", "resolved", "provider-configuration-error"], `observation ${index + 1} terminals`);
      expected.equal([relationCircuitOpen(h), h.executions.length], [[false, false, false], 0],
        `session circuit and requests after observation ${index + 1}`);
    }
    expected.equal(h.clock.timers.size, 0, "timers left");
    assert.deepEqual(expected.failures, [], "observations with no provider");
  } finally { h.restore(); }
});

// ---- PC6: the switch's lifecycle, through the Hook's own setter ----

// The Hook's own setter, bound to this harness's ref and recorder. `settings` is
// what updateSettings would persist.
function crossChecksSwitch(h) {
  const setterSource = findNamedDeclaration(sourceFile, "setRuntimeCrossChecksEnabled")
    .initializer.arguments[0].getText(sourceFile);
  const settings = { runtimeCrossChecksEnabled: h.environment.runtimeCrossChecksEnabledRef.current };
  const set = vm.runInContext(transpile(`(${setterSource})`), vm.createContext({
    runtimeCrossChecksEnabledRef: h.environment.runtimeCrossChecksEnabledRef,
    sessionRecordingManagerRef: h.environment.sessionRecordingManagerRef,
    updateSettings: (resolve) => { Object.assign(settings, resolve(settings)); },
  }));
  return { set, settings };
}
// The executor's own handle of an observation operation. Its stage terminals can
// be watched here; the product handle never carries them.
function scheduleObservationOperation(h, { unit = shortUnit(), traceId = "trace" } = {}) {
  const state = h.environment.contextManagerRef.current.getState();
  return h.environment.scheduleTaskRelationSplitRuntime({
    traceId, taskId: state.activeMeetingTask.id, runtimeReleaseRequested: false, authorizeSourceOperation: sourceCurrent,
    request: relationModule.buildTaskRelationAdjudicationRequest({ logicalQuestionUnit: unit,
      activeMeetingTask: state.activeMeetingTask,
      currentQuestion: imports.createProvisionalCurrentQuestion({ logicalQuestionUnit: unit, sourceKind: "voice" }) }),
  });
}
const switchChanges = (h) => h.recorded.filter((row) => row.stage === "runtime-cross-checks-updated")
  .map((row) => [row.previousRuntimeCrossChecksEnabled, row.runtimeCrossChecksEnabled]);
// An observation writes Trace and Recording and nothing else.
function expectReadOnly(expected, h, stateBefore) {
  expected.equal([h.advisorCalls.length, h.events.filter((event) => event.ui).length,
    h.events.filter((event) => event.finish).length], [0, 0, 0], "Advisor handoffs, UI updates and trace terminals");
  expected.same(h.environment.contextManagerRef.current.getState(), stateBefore, "task and context state");
  expected.equal([...new Set(h.recorded.map((row) => row.kind))].filter((kind) =>
    !["model-input", "model-output", "lifecycle", "relation-decision"].includes(kind)), [], "recorder writers used");
}

for (const recording of [false, true]) {
  test(`PC6 recording=${recording}: Cross-checks switched off before the observation Affinity completes ends that Affinity under its start-time configuration and starts no observation Canonical`, { concurrency: false }, async () => {
    const h = st183Harness({ crossChecks: true, recording });
    try {
      const expected = expectations();
      const stateBefore = plain(h.environment.contextManagerRef.current.getState());
      const toggle = crossChecksSwitch(h);
      const operation = scheduleObservationOperation(h);
      const affinity = watch(h, operation.affinityOutcome);
      const canonical = watch(h, operation.canonicalOutcome);
      await h.clock.advanceTo(100);
      expected.equal(candidates(h, "affinity").length, 2, "observation Affinity requests in flight");
      toggle.set(false);
      expected.equal([h.environment.runtimeCrossChecksEnabledRef.current, toggle.settings.runtimeCrossChecksEnabled],
        [false, false], "switch after the setter");
      // Turning it off cancels nothing that already started.
      expected.equal(aborted(candidates(h, "affinity")), [false, false], "in-flight observation Affinity after switching off");
      completeCandidate(candidate(h, "affinity", "intelligent"), { rawOutput: PARENT_INDEPENDENT });
      await h.clock.advanceTo(200);
      expected.equal([affinity.state, affinity.at, affinity.value?.parent.adjudication?.decision], ["resolved", 100, "independent"],
        "in-flight Affinity terminal");
      expected.equal([h.metadata.taskRelationParentAffinityObservationTrigger, h.metadata.taskRelationParentAffinityDisposition,
        h.metadata.taskRelationParentAffinityLeaseAuthorized], ["runtime-cross-checks", "shadow-observed", true],
      "the Affinity keeps its start-time trigger");
      // The follow-up Canonical had not started: it is a new request and the switch is off.
      expected.equal([canonical.state, canonical.at, canonical.value?.unavailableReason], ["resolved", 100, "runtime-cross-checks-off"],
        "observation Canonical terminal");
      expected.equal([h.metadata.taskRelationSplitCanonicalDisposition, h.metadata.taskRelationSplitCanonicalOperationId],
        ["runtime-cross-checks-off", undefined], "named skip on the Canonical disposition");
      await h.clock.advanceTo(3 * STAGE_MS);
      expected.equal([candidates(h, "canonical").length, h.executions.length, h.clock.timers.size], [0, 2, 0],
        "Canonical requests, all physical requests and timers left");
      if (recording) {
        expected.equal(switchChanges(h), [[true, false]], "switch change recorded");
        expected.equal(h.recorded.filter((row) => row.kind === "relation-decision").at(-1)?.metadata.taskRelationSplitCanonicalDisposition,
          "runtime-cross-checks-off", "recorded skip");
      } else {
        expected.equal(h.recorded.length, 0, "written with Recording off");
      }
      expectReadOnly(expected, h, stateBefore);
      assert.deepEqual(expected.failures, [], "switch-off lifecycle");
    } finally { h.restore(); }
  });
}

test("PC6 rapid toggling: a question scheduled while off is never observed later, the follow-up Canonical reads the live switch, and each change is recorded once", { concurrency: false }, async () => {
  const h = st183Harness({ recording: true });
  try {
    const expected = expectations();
    const stateBefore = plain(h.environment.contextManagerRef.current.getState());
    const toggle = crossChecksSwitch(h);
    // Off: this question gets no observation, and turning the switch on does not go back for it.
    const offHandle = scheduleRelation(h, { unit: shortUnit() });
    toggle.set(true);
    await h.clock.advanceTo(100);
    expected.equal([h.executions.length, NO_WINDOW_HANDLE_FIELDS.filter((field) => offHandle[field] !== undefined)], [0, []],
      "requests for the question scheduled while off");
    // On, then off, on, off, on while the observation Affinity is in flight.
    const operation = scheduleObservationOperation(h, { unit: observedUnit(), traceId: OBSERVED_TRACE });
    const canonical = watch(h, operation.canonicalOutcome);
    await h.clock.advanceTo(200);
    for (const value of [false, true, false, true]) toggle.set(value);
    // Setting the value it already has is not a change.
    toggle.set(true);
    expected.equal(aborted(candidates(h, "affinity")), [false, false], "in-flight observation Affinity across the toggles");
    completeCandidate(candidate(h, "affinity", "intelligent"), { rawOutput: PARENT_RELATED });
    await h.clock.advanceTo(300);
    // The live value is on when the Affinity stage ends, so the follow-up starts.
    expected.equal(candidates(h, "canonical").length, 2, "observation Canonical requests");
    completeCandidate(candidate(h, "canonical", "intelligent"), { rawOutput: canonicalOutput("followup-parent") });
    await h.clock.advanceTo(400);
    const trace = h.otherTraces[OBSERVED_TRACE];
    expected.equal([canonical.state, canonical.value?.adjudication?.relation, trace.taskRelationSplitCanonicalObservationTrigger,
      trace.taskRelationSplitCanonicalDisposition], ["resolved", "followup-parent", "runtime-cross-checks", "shadow-observed"],
    "observation Canonical terminal");
    expected.equal(switchChanges(h), [[false, true], [true, false], [false, true], [true, false], [false, true]],
      "switch changes recorded in order");
    expected.equal([h.environment.runtimeCrossChecksEnabledRef.current, toggle.settings.runtimeCrossChecksEnabled, h.clock.timers.size],
      [true, true, 0], "final switch value and timers left");
    expectReadOnly(expected, h, stateBefore);
    assert.deepEqual(expected.failures, [], "rapid toggling");
  } finally { h.restore(); }
});

test("PC6 switching Cross-checks off or on cancels no formal request and does not change the formal result", { concurrency: false }, async () => {
  const h = st183Harness({ crossChecks: true });
  try {
    const expected = expectations();
    const toggle = crossChecksSwitch(h);
    const handle = scheduleEntry(h, "screen");
    const wait = watch(h, startScreenConsumer(h, handle));
    await h.clock.advanceTo(100);
    toggle.set(false);
    expected.equal(aborted(candidates(h, "affinity")), [false, false], "formal Affinity requests after switching off");
    completeCandidate(candidate(h, "affinity", "intelligent"), { rawOutput: PARENT_INDEPENDENT });
    await h.clock.advanceTo(300);
    for (const value of [true, false]) toggle.set(value);
    expected.equal(aborted(candidates(h, "canonical")), [false, false], "formal Canonical requests across the toggles");
    completeCandidate(candidate(h, "canonical", "intelligent"), { rawOutput: canonicalOutput("new-parent") });
    await h.clock.advanceTo(400);
    expected.equal([wait.state, wait.value?.decision.relation, h.metadata.taskRelationOrderedResolutionStage,
      h.metadata.taskRelationSplitCanonicalDisposition, h.metadata.taskRelationSplitCanonicalObservationTrigger],
    ["resolved", "new-parent", "canonical-relation", "shadow-observed", undefined], "formal result");
    expected.equal([h.executions.length, h.clock.timers.size], [4, 0], "physical requests and timers left");
    assert.deepEqual(expected.failures, [], "formal work under switch changes");
  } finally { h.restore(); }
});

// An observation already in flight when its owner changes ends on its own lease
// and stage deadline: a real terminal for both stages, nothing left running,
// nothing released.
// The context manager publishes a new state object on every change, as in production.
const publishState = (h, change) => {
  const manager = h.environment.contextManagerRef.current;
  const next = change(structuredClone(manager.getState()));
  manager.getState = () => next;
};
for (const [name, change, reason] of [
  ["the session changes", (h) => publishState(h, (state) => ({ ...state, sessionId: "session-b" })), "sessionId-mismatch"],
  ["the runtime epoch changes", (h) => { h.environment.runtimeEpochRef.current += 1; }, "runtimeEpoch-mismatch"],
  ["the manual-correction revision changes", (h) => { h.environment.manualCorrectionRevisionRef.current += 1; },
    "manualCorrectionRevision-mismatch"],
  ["the parent revision changes", (h) => publishState(h, (state) => {
    state.activeMeetingTask.parent.revisions += 1;
    return state;
  }), "parentRevision-mismatch"],
  ["Stop invalidates runtime work", (h) => { stop(h); }, "operation-id-mismatch"],
]) {
  test(`PC6 an in-flight observation reaches a real terminal when ${name}`, { concurrency: false }, async () => {
    const h = st183Harness({ crossChecks: true });
    try {
      const expected = expectations();
      const operation = scheduleObservationOperation(h);
      const affinity = watch(h, operation.affinityOutcome);
      const canonical = watch(h, operation.canonicalOutcome);
      await h.clock.advanceTo(100);
      change(h);
      const stateAfterChange = plain(h.environment.contextManagerRef.current.getState());
      // The provider still answers; an aborted request cannot.
      for (const execution of candidates(h, "affinity", "intelligent")) {
        if (!execution.signal.aborted) completeCandidate(execution, { rawOutput: PARENT_INDEPENDENT });
      }
      await h.clock.advanceTo(200);
      expected.equal([affinity.state, affinity.value?.parent.adjudication, h.metadata.taskRelationParentAffinityLeaseAuthorized],
        ["resolved", undefined, false], "Affinity terminal refuses the result");
      expected.equal([affinity.value?.parent.unavailableReason, h.metadata.taskRelationParentAffinityDisposition], [reason, reason],
        "Affinity terminal reason");
      // Its follow-up ends by the Canonical stage deadline at the latest.
      await h.clock.advanceTo(200 + STAGE_MS + 100);
      expected.equal([canonical.state, canonical.value?.adjudication, h.metadata.taskRelationSplitCanonicalLeaseAuthorized],
        ["resolved", undefined, false], "Canonical terminal refuses the result");
      expected.equal([h.clock.timers.size, h.advisorCalls.length, h.events.filter((event) => event.ui || event.finish).length],
        [0, 0, 0], "timers left, Advisor handoffs, UI updates and trace terminals");
      expected.same(h.environment.contextManagerRef.current.getState(), stateAfterChange, "task and context state");
      assert.deepEqual(expected.failures, [], "in-flight observation terminal");
    } finally { h.restore(); }
  });
}

test("PC6 Stop, application shutdown and unmount cancel the observation instances with the formal ones", { concurrency: false }, async () => {
  for (const name of OBSERVATION_RUNTIME_REFS) {
    assert.equal(invalidateRuntimeWorkRefs.includes(name), true, `invalidateRuntimeWork reads ${name}`);
    // Application shutdown and the unmount cleanup each dispose it.
    assert.equal(hookSource.split(`${name}.current?.cancelAll("disposed")`).length - 1, 2, `${name} disposed on shutdown and unmount`);
  }
  for (const name of RELATION_RUNTIME_REFS) {
    assert.equal(hookSource.split(`${name}.current?.cancelAll("disposed")`).length - 1, 2, `${name} disposed on shutdown and unmount`);
  }
  const h = st183Harness({ crossChecks: true });
  try {
    const cancelled = [];
    for (const name of [...RELATION_RUNTIME_REFS, ...OBSERVATION_RUNTIME_REFS]) {
      const runtime = h.environment[name].current;
      const cancelAll = runtime.cancelAll.bind(runtime);
      runtime.cancelAll = (reason) => { cancelled.push([name, reason]); return cancelAll(reason); };
    }
    const operation = scheduleObservationOperation(h);
    const terminal = watch(h, operation.affinityOutcome);
    await h.clock.advanceTo(1_000);
    expectEqual(aborted(candidates(h, "affinity")), [false, false], "observation Affinity requests in flight before Stop");
    stop(h);
    expectEqual(cancelled, [...RELATION_RUNTIME_REFS, ...OBSERVATION_RUNTIME_REFS].map((name) => [name, "superseded"]),
      "Relation runtimes cancelled by Stop");
    await h.clock.flush();
    expectEqual([terminal.state, terminal.at, terminal.value?.parent.unavailableReason], ["resolved", 1_000, "operation-id-mismatch"],
      "observation stage terminal after Stop");
    expectEqual(aborted(candidates(h, "affinity")), [true, true], "observation Affinity requests after Stop");
    expectEqual(OBSERVATION_RUNTIME_REFS.slice(0, 2).map((name) => h.environment[name].current.getCurrentOperationId()),
      [null, null], "current observation Affinity operations after Stop");
    await h.clock.advanceTo(1_000 + STAGE_MS + 100);
    expectEqual(h.clock.timers.size, 0, "timers left");
  } finally { h.restore(); }
});

// ---- PC6: dispose (application shutdown and unmount) ----
//
// The Hook's own dispose statements for the six Relation runtimes, exactly as
// they stand in the application-shutdown path and in the unmount cleanup, run
// here against the real runtime instances. A disposed runtime refuses every
// later schedule; cancelling it as superseded would arm it again.
const DISPOSE_PATHS = ["application shutdown", "unmount"];
const relationDisposeStatements = (() => {
  const byBlock = new Map();
  const visit = (node) => {
    if (ts.isExpressionStatement(node) &&
      /^taskRelation\w+RuntimeRef\.current\?\.cancelAll\("disposed"\)$/.test(node.expression.getText(sourceFile))) {
      byBlock.set(node.parent, [...(byBlock.get(node.parent) ?? []), node.expression.getText(sourceFile)]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...byBlock.values()];
})();
const dispose = (h, path) => vm.runInContext(transpile(relationDisposeStatements[DISPOSE_PATHS.indexOf(path)].join(";\n")),
  vm.createContext(Object.fromEntries([...RELATION_RUNTIME_REFS, ...OBSERVATION_RUNTIME_REFS].map((name) => [name, h.environment[name]]))));

test("PC6 application shutdown and unmount each dispose the three formal and the three observation Relation runtimes", () => {
  assert.equal(relationDisposeStatements.length, DISPOSE_PATHS.length, "dispose paths in the Hook");
  for (const statements of relationDisposeStatements) {
    assert.deepEqual(statements, [...RELATION_RUNTIME_REFS, ...OBSERVATION_RUNTIME_REFS].map((name) =>
      `${name}.current?.cancelAll("disposed")`));
  }
});

// A formal operation and an observation are both in flight when the runtimes are
// disposed. The formal operation goes on to its foreground Canonical, which is
// where it supersedes observation work of the same kind.
async function runDisposeInFlight({ path, entry, child, crossChecks }) {
  const h = st183Harness({ crossChecks, child });
  try {
    const handle = scheduleEntry(h, entry);
    const started = {};
    if (entry === "voice") startVoiceFor(h, handle, logicalQuestionUnit);
    else started.wait = watch(h, entry === "screen" ? startScreenConsumer(h, handle) : startCorrectionConsumer(h, handle));
    await h.clock.advanceTo(100);
    scheduleRelation(h, { unit: observedUnit(), traceId: OBSERVED_TRACE });
    await h.clock.advanceTo(500);
    const dispatchedBefore = h.executions.length;
    dispose(h, path);
    await h.clock.advanceTo(500 + 3 * STAGE_MS);
    return { h, started, dispatchedBefore,
      dispatchedAfter: h.executions.slice(dispatchedBefore).map((execution) =>
        [execution.request.identity.logicalQuestionUnitId, execution.request.operationKind, tierOf(execution),
          execution.dispatchedAt - 10_000]),
      formal: plain({
        relation: finalRelation(h, entry, started),
        waitEndedAt: entry === "voice" ? h.advisorCalls.map((call) => call.at) : [started.wait?.state, started.wait?.at],
        consumer: entry === "voice" ? voiceRelease(h) : started.wait?.value,
        trace: h.metadata,
        requests: requestsOf(h, logicalQuestionUnit.id),
      }) };
  } catch (error) {
    h.restore();
    throw error;
  }
}

for (const path of DISPOSE_PATHS) for (const entry of ["voice", "screen", "correction"]) for (const child of [false, true]) {
  test(`PC6 ${path} with a formal ${entry} operation and an observation in flight, ${child ? "child+parent" : "parent-only"}: no request is dispatched afterwards and no observation instance is armed again`, { concurrency: false }, async () => {
    const baseline = await runDisposeInFlight({ path, entry, child, crossChecks: false });
    baseline.h.restore();
    const run = await runDisposeInFlight({ path, entry, child, crossChecks: true });
    const { h } = run;
    try {
      const expected = expectations();
      // Both operations really were in flight at the dispose. The observation
      // adds two requests: with an active child the formal operation already
      // holds two of the three slots of each provider group.
      expected.equal([baseline.dispatchedBefore, run.dispatchedBefore], child ? [4, 6] : [2, 4],
        "physical requests in flight at the dispose, without and with the observation");
      expected.equal(ofQuestion(h, OBSERVED_UNIT_ID, "affinity").length, 2, "observation Affinity requests in flight");
      expected.equal(aborted(h.executions.slice(0, run.dispatchedBefore)), Array(run.dispatchedBefore).fill(true),
        "requests aborted by the dispose");
      expected.equal(run.dispatchedAfter, [], "physical requests dispatched after the dispose");
      expected.equal([formalRuntimeOperations(h), observationRuntimeOperations(h)],
        [[null, null, null], [null, null, null]], "current formal and observation operations after the dispose");
      // The observation ended on a real terminal for both stages, with nothing started.
      const observedTrace = h.otherTraces[OBSERVED_TRACE] ?? {};
      expected.equal([observedTrace.taskRelationParentAffinityDisposition, observedTrace.taskRelationParentAffinityLeaseAuthorized,
        observedTrace.taskRelationSplitCanonicalDisposition, observedTrace.taskRelationSplitCanonicalLeaseAuthorized],
      ["operation-id-mismatch", false, "operation-id-mismatch", false], "observation terminals after the dispose");
      expected.equal(h.clock.timers.size, 0, "timers left");
      // The formal operation ends exactly as it does with no observation beside it.
      expected.same(run.formal, baseline.formal, "formal");
      assert.deepEqual(expected.failures, [], "dispose with an observation in flight");
    } finally { h.restore(); }
  });
}

for (const path of DISPOSE_PATHS) {
  test(`PC6 after ${path} a formal schedule does not arm the observation instances again: a later observation dispatches nothing`, { concurrency: false }, async () => {
    const h = st183Harness({ crossChecks: true });
    try {
      const expected = expectations();
      dispose(h, path);
      scheduleRelation(h, { unit: observedUnit(), traceId: OBSERVED_TRACE });
      await h.clock.advanceTo(600);
      expected.equal(h.executions.length, 0, "requests for an observation scheduled after the dispose");
      // A formal schedule on the disposed runtimes, then a second observation.
      const handle = scheduleEntry(h, "screen");
      const wait = watch(h, startScreenConsumer(h, handle));
      await h.clock.advanceTo(1_200);
      const second = scheduleObservationOperation(h, { unit: shortUnit({ id: "lqu-observed-2" }), traceId: "trace-observed-2" });
      const affinity = watch(h, second.affinityOutcome);
      const canonical = watch(h, second.canonicalOutcome);
      await h.clock.advanceTo(1_200 + 3 * STAGE_MS);
      expected.equal([h.executions.length, wait.state], [0, "resolved"], "requests after the dispose and the formal wait");
      expected.equal([affinity.state, affinity.value?.parent.unavailableReason, canonical.state, canonical.value?.adjudication],
        ["resolved", "operation-id-mismatch", "resolved", undefined], "second observation terminals");
      expected.equal([formalRuntimeOperations(h), observationRuntimeOperations(h)],
        [[null, null, null], [null, null, null]], "current formal and observation operations");
      expected.equal(h.clock.timers.size, 0, "timers left");
      assert.deepEqual(expected.failures, [], "observation after dispose");
    } finally { h.restore(); }
  });
}

// ---- PC6 / PC8: the production admission settings ----
//
// Every other test in this file builds the coordinator with a zero grace, so a
// request is dispatched the moment it is admitted. The Hook builds it with the
// defaults: three slots per provider group and a 450 ms grace before a
// non-critical lane (evaluation, background) is dispatched. These two tests
// install that coordinator.
function installProductionAdmission(h) {
  const admission = new admissionModule.RuntimeInferenceProviderAdmissionCoordinator();
  admission.configureProviderGroups({ fastFingerprint: "fast", intelligentFingerprint: "intelligent" });
  h.environment.runtimeInferenceProviderAdmissionRef = { current: admission };
  return admission;
}
const dispatched = (h) => h.executions.map((execution) => [execution.request.identity.logicalQuestionUnitId,
  execution.request.operationKind, tierOf(execution), execution.dispatchedAt - 10_000]);

test("PC6 admission grace: an observation admitted before the switch went off still sends its Affinity requests when the grace ends, and no Canonical follows", { concurrency: false }, async () => {
  const h = st183Harness({ crossChecks: true });
  try {
    const expected = expectations();
    const admission = installProductionAdmission(h);
    const toggle = crossChecksSwitch(h);
    const operation = scheduleObservationOperation(h);
    const affinity = watch(h, operation.affinityOutcome);
    const canonical = watch(h, operation.canonicalOutcome);
    await h.clock.advanceTo(100);
    // The operation has started; its two physical requests wait out the grace.
    expected.equal([h.executions.length, admission.readSnapshot("fast").queuedCount, admission.readSnapshot("intelligent").queuedCount,
      h.metadata.taskRelationParentAffinityObservationTrigger, typeof h.metadata.taskRelationParentAffinityStartedAt],
    [0, 1, 1, "runtime-cross-checks", "number"], "requests dispatched, requests queued and the operation's start-time record at 100 ms");
    toggle.set(false);
    await h.clock.advanceTo(449);
    expected.equal(h.executions.length, 0, "requests dispatched before the grace ends");
    // Switching off is not a canceller: what was admitted goes out, 350 ms after the switch-off.
    await h.clock.advanceTo(450);
    expected.equal(dispatched(h), [["lqu-current", "task-relation-parent-affinity", "intelligent", 450],
      ["lqu-current", "task-relation-parent-affinity", "fast", 450]], "requests dispatched when the grace ends");
    completeCandidate(candidate(h, "affinity", "intelligent"), { rawOutput: PARENT_INDEPENDENT });
    await h.clock.advanceTo(500);
    expected.equal([affinity.state, affinity.value?.parent.adjudication?.decision, h.metadata.taskRelationParentAffinityDisposition,
      h.metadata.taskRelationParentAffinityObservationTrigger], ["resolved", "independent", "shadow-observed", "runtime-cross-checks"],
    "Affinity terminal under its start-time configuration");
    // The follow-up Canonical is a new request and the switch is off.
    expected.equal([canonical.state, canonical.value?.unavailableReason, h.metadata.taskRelationSplitCanonicalDisposition],
      ["resolved", "runtime-cross-checks-off", "runtime-cross-checks-off"], "Canonical terminal");
    await h.clock.advanceTo(3 * STAGE_MS);
    expected.equal([candidates(h, "canonical").length, h.executions.length, h.clock.timers.size], [0, 2, 0],
      "Canonical requests, all physical requests and timers left");
    assert.deepEqual(expected.failures, [], "switch-off inside the admission grace");
  } finally { h.restore(); }
});

// A measurement of existing coordinator behaviour, not a contract this slice
// introduces: the coordinator has no preemption, so an admitted evaluation-lane
// request holds its slot until it completes or reaches its 4 s stage deadline.
// The first scenario is the worst case found for Relation observations: an
// active child and parent, two short no-window questions 600 ms apart, and a
// provider that does not answer. Other critical-lane work cannot free those
// slots. A formal Relation supersedes observation Affinity of its own kind, so
// observation Affinity does not delay it. An observation Canonical is not
// superseded until the formal Canonical starts: it keeps its slot through the
// formal Affinity stage. The second scenario measures that.
async function measureContention({ crossChecks, arrival }) {
  const h = st183Harness({ crossChecks, child: true });
  try {
    const admission = installProductionAdmission(h);
    scheduleRelation(h, { unit: shortUnit({ id: "lqu-short-1" }), traceId: "trace-short-1" });
    await h.clock.advanceTo(600);
    scheduleRelation(h, { unit: shortUnit({ id: "lqu-short-2" }), traceId: "trace-short-2" });
    await h.clock.advanceTo(1_200);
    const slotsAt1200 = ["fast", "intelligent"].map((tier) => admission.readSnapshot(tier).activeCount);
    const observationRequests = dispatched(h);
    const receipts = {};
    if (arrival === "other critical work") {
      // A critical-lane request of another operation, for example Question Type.
      for (const providerTier of ["fast", "intelligent"]) {
        void admission.run({ operationId: `critical-${providerTier}`, lane: "critical", providerTier,
          signal: new AbortController().signal, execute: () => new Promise(() => {}),
          onAdmitted: (receipt) => { receipts[providerTier] = [receipt.waitMs, receipt.admittedAt - 10_000]; } })
          .catch(() => undefined);
      }
    } else {
      const handle = scheduleEntry(h, "screen");
      watch(h, startScreenConsumer(h, handle));
    }
    await h.clock.advanceTo(1_200 + 3 * STAGE_MS);
    return plain({ slotsAt1200, observationRequests, receipts,
      formalAffinityDispatchedAt: ofQuestion(h, logicalQuestionUnit.id, "affinity").map((execution) => execution.dispatchedAt - 10_000) });
  } finally { h.restore(); }
}

// One short question is observed: its Affinity goes out when the grace ends at
// 450 ms and answers at 500 ms, and its automatic Canonical goes out at 950 ms
// and does not answer. A formal Relation with an active child and parent
// arrives at 1000 ms, optionally with one other critical Intelligent request
// (for example another question's Type) in flight for 1.5 s.
async function measureFormalBehindObservationCanonical({ crossChecks, otherCritical }) {
  const h = st183Harness({ crossChecks, child: true });
  try {
    const admission = installProductionAdmission(h);
    scheduleRelation(h, { unit: observedUnit(), traceId: OBSERVED_TRACE });
    h.clock.setTimeout(() => {
      for (const execution of ofQuestion(h, OBSERVED_UNIT_ID, "affinity", "intelligent")) {
        completeCandidate(execution, { rawOutput: execution.request.affinityKind === "child" ? FAST_CHILD_UNRELATED : PARENT_RELATED });
      }
    }, 500);
    await h.clock.advanceTo(1_000);
    const slotsAt1000 = ["fast", "intelligent"].map((tier) => admission.readSnapshot(tier).activeCount);
    const observationInFlight = h.executions.filter((execution) => !execution.signal.aborted).map((execution) =>
      [execution.request.operationKind, tierOf(execution), execution.dispatchedAt - 10_000]);
    if (otherCritical) {
      void admission.run({ operationId: "other-critical", lane: "critical", providerTier: "intelligent",
        signal: new AbortController().signal, execute: () => new Promise((resolve) => h.clock.setTimeout(resolve, 1_500)) });
    }
    const handle = scheduleEntry(h, "screen");
    watch(h, startScreenConsumer(h, handle));
    await h.clock.advanceTo(1_000 + 2 * STAGE_MS + 200);
    return plain({ slotsAt1000, observationInFlight,
      // Kind, tier, dispatch time and the request's own budget, in dispatch order.
      formalAffinity: ofQuestion(h, logicalQuestionUnit.id, "affinity").map((execution) =>
        [execution.request.operationKind, tierOf(execution), execution.dispatchedAt - 10_000, execution.timeoutMs]) });
  } finally { h.restore(); }
}

test("PC8 contention measured at the production admission settings: unanswered Relation observations can hold every slot and other critical work then waits for the stage deadline; a formal Relation is not delayed by observation Affinity, but can wait behind an observation Canonical when another critical request holds a slot, until the next slot frees", { concurrency: false }, async () => {
  const expected = expectations();
  const off = await measureContention({ crossChecks: false, arrival: "other critical work" });
  expected.equal(off, { slotsAt1200: [0, 0], observationRequests: [], receipts: { fast: [0, 1_200], intelligent: [0, 1_200] },
    formalAffinityDispatchedAt: [] }, "Cross-checks off");
  const on = await measureContention({ crossChecks: true, arrival: "other critical work" });
  // The first question's Affinity goes out when the grace ends and is superseded by
  // the second question at 600 ms. From 1050 ms each provider group carries the
  // second question's two Affinity requests and the first question's automatic Canonical.
  expected.equal(on.observationRequests, [
    ["lqu-short-1", "task-relation-child-affinity", 450], ["lqu-short-1", "task-relation-parent-affinity", 450],
    ["lqu-short-2", "task-relation-child-affinity", 1_050], ["lqu-short-2", "task-relation-parent-affinity", 1_050],
    ["lqu-short-1", "task-relation-canonical-shadow", 1_050],
  ].flatMap(([unit, kind, at]) => ["intelligent", "fast"].map((tier) => [unit, kind, tier, at])),
  "observation requests dispatched by 1200 ms");
  expected.equal(on.slotsAt1200, [3, 3], "slots held at 1200 ms, Fast and Intelligent group");
  // Admitted at 4600 ms, when the requests started at 600 ms reach their 4 s stage deadline.
  expected.equal(on.receipts, { fast: [3_400, 4_600], intelligent: [3_400, 4_600] },
    "critical-lane wait and admission time behind the observations");
  // A formal Relation arriving at the same moment supersedes the observation Affinity of its own kind and is
  // dispatched at once: observation Affinity does not delay it.
  const formal = await measureContention({ crossChecks: true, arrival: "formal relation" });
  expected.equal([formal.slotsAt1200, formal.formalAffinityDispatchedAt], [[3, 3], [1_200, 1_200, 1_200, 1_200]],
    "formal Affinity dispatch behind the same observations");
  // An observation Canonical is different: nothing supersedes it during the formal Affinity stage.
  const AFFINITY_AT_ONCE = [["task-relation-child-affinity", "intelligent", 1_000, STAGE_MS],
    ["task-relation-child-affinity", "fast", 1_000, STAGE_MS], ["task-relation-parent-affinity", "intelligent", 1_000, STAGE_MS],
    ["task-relation-parent-affinity", "fast", 1_000, STAGE_MS]];
  const CANONICAL_IN_FLIGHT = [["task-relation-canonical-shadow", "intelligent", 950], ["task-relation-canonical-shadow", "fast", 950]];
  // With Cross-checks off, one other critical request leaves two Intelligent slots: nothing waits.
  expected.equal(await measureFormalBehindObservationCanonical({ crossChecks: false, otherCritical: true }),
    { slotsAt1000: [0, 0], observationInFlight: [], formalAffinity: AFFINITY_AT_ONCE }, "Cross-checks off with one other critical request");
  // With the observation Canonical alone holding a slot, two are left: nothing waits.
  expected.equal(await measureFormalBehindObservationCanonical({ crossChecks: true, otherCritical: false }),
    { slotsAt1000: [1, 1], observationInFlight: CANONICAL_IN_FLIGHT, formalAffinity: AFFINITY_AT_ONCE },
    "an observation Canonical in flight and no other critical request");
  // With both, the Intelligent group is full after the formal child Affinity: the formal parent Affinity's
  // Intelligent candidate is dispatched at 2500 ms, when the other critical request ends and frees a slot,
  // and has 2500 ms of its 4 s stage left. Its Fast candidate was dispatched at once.
  expected.equal(await measureFormalBehindObservationCanonical({ crossChecks: true, otherCritical: true }),
    { slotsAt1000: [1, 1], observationInFlight: CANONICAL_IN_FLIGHT,
      formalAffinity: [AFFINITY_AT_ONCE[0], AFFINITY_AT_ONCE[1], AFFINITY_AT_ONCE[3],
        ["task-relation-parent-affinity", "intelligent", 2_500, STAGE_MS - 1_500]] },
    "an observation Canonical in flight and one other critical request");
  assert.deepEqual(expected.failures, [], "contention measurement");
});

// ---- PC3: no parent, an invalid source, the Type wait and the other entries ----

for (const debug of [false, true]) {
  test(`PC3 voice no-window debug=${debug}: with no parent Cross-checks starts no request and the first-question release is unchanged`, { concurrency: false }, async () => {
    const baseline = await runNoWindowVoice({ debug, parent: false });
    baseline.h.restore();
    const run = await runNoWindowVoice({ debug, parent: false, crossChecks: true, observed: [20, PARENT_INDEPENDENT] });
    try {
      const expected = expectations();
      expected.equal([run.h.executions.length, baseline.h.executions.length], [0, 0], "physical requests");
      expected.equal([String(run.handle.operationId).startsWith("task-relation-local:"), run.handle.operationId],
        [true, baseline.handle.operationId], "local operation id");
      expected.equal(run.release.releasedAt, [50], "released at");
      expected.same(run.release, baseline.release, "released");
      assert.deepEqual(expected.failures, [], "no-parent release");
    } finally { run.h.restore(); }
  });

  test(`PC3 voice no-window debug=${debug}: a source that became invalid stays refused, whatever the observation returned`, { concurrency: false }, async () => {
    // The question's own source lease goes stale at 30 ms, before the Type window releases at 50 ms.
    const staleSource = () => {
      let stale = false;
      return { source: () => (stale ? { authorized: false, reason: "logical-question-revision-changed", mismatchedKey: "source" }
        : sourceCurrent()), during: (h) => { h.clock.setTimeout(() => { stale = true; }, 30); } };
    };
    const baseline = await runNoWindowVoice({ debug, ...staleSource() });
    baseline.h.restore();
    const run = await runNoWindowVoice({ debug, crossChecks: true, observed: [20, PARENT_INDEPENDENT], ...staleSource() });
    try {
      const expected = expectations();
      expected.equal([run.h.metadata.taskRelationParentAffinityDecision, run.h.metadata.taskRelationParentAffinityLeaseAuthorized],
        ["independent", true], "the observation had already returned independent");
      expected.equal([run.release.releasedAt, run.release.traceFinished.map((finish) => finish[0])], [[], ["cancelled"]],
        "nothing released and the trace cancelled");
      expected.same(run.release, baseline.release, "released");
      assert.deepEqual(expected.failures, [], "invalid source");
    } finally { run.h.restore(); }
  });
}

// The Type wait of a no-window question starts when its consumer starts. A
// product handle that carried the observation's stage deadline would measure it
// from the observation schedule instead and close it early.
for (const [name, typeAt, releasedAt, disposition] of [
  ["Type settles 1700 ms into its 2 s wait", 1_700, 2_200, "type-settled-and-released-before-deadline"],
  ["Type never settles", undefined, 2_500, "deadline-expired-finalized"],
]) {
  test(`PC3 voice no-window: with the consumer starting 500 ms after scheduling, ${name} and the full Type wait still applies under Cross-checks`, { concurrency: false }, async () => {
    const options = { consumerStartsAt: 500, typeAt, typeOutcome: typeAt === undefined ? () => new Promise(() => {}) : undefined };
    const baseline = await runNoWindowVoice(options);
    baseline.h.restore();
    const run = await runNoWindowVoice({ ...options, crossChecks: true, observed: [20, PARENT_INDEPENDENT] });
    try {
      const expected = expectations();
      expected.equal([run.release.releasedAt, run.h.metadata.questionTypeAdjudicationWaitDisposition,
        run.h.metadata.orderedSettlementForegroundDeadlineAt], [[releasedAt], disposition, 10_000 + 2_500], "Type wait");
      expected.equal(run.release.settlement?.relation, "followup-parent", "released relation");
      expected.same(run.release, baseline.release, "released");
      assert.deepEqual(expected.failures, [], "Type wait under an observation");
    } finally { run.h.restore(); }
  });
}

// Screen and Correction never read an Affinity without a release window. What
// they do hold is the handle, so it is compared whole, including what its
// authorizer answers.
const handleShape = (handle) => plain({ ...handle, authorizeOperation: undefined, authorization: handle.authorizeOperation(),
  functionFields: Object.entries(handle).filter(([, value]) => typeof value === "function").map(([key]) => key).sort(),
  promiseFields: Object.entries(handle).filter(([, value]) => value instanceof Promise).map(([key]) => key).sort() });
for (const [entry, options] of [["voice", {}], ["screen", { sourceKind: "screen" }], ["correction", { manualCorrectionOwned: true }]]) {
  for (const debug of [false, true]) {
    test(`PC3 ${entry} no-window debug=${debug}: the product handle under Cross-checks equals the handle without the observation`, { concurrency: false }, async () => {
      const shape = async (crossChecks) => {
        const h = st183Harness({ debug, crossChecks });
        try {
          const handle = scheduleRelation(h, { unit: shortUnit(), ...options });
          await h.clock.advanceTo(100);
          return { shape: handleShape(handle), requests: h.executions.length };
        } finally { h.restore(); }
      };
      const off = await shape(false);
      const on = await shape(true);
      expectEqual([off.requests, on.requests], [0, 2], "observation Affinity physical requests");
      expectEqual(on.shape.functionFields, ["authorizeOperation"], "functions on the handle");
      expectEqual([on.shape.promiseFields, on.shape.operationId, on.shape.affinityDeadlineAt, on.shape.releaseWindowRequested],
        [[], undefined, undefined, false], "model fields on the handle");
      assert.deepEqual(on.shape, off.shape, "handle with the observation admitted");
    });
  }
}

test("PC3 no Hook consumer passes an Affinity to the settlement coordinator or reads one from a relation handle", () => {
  const coordinatorCalls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === "coordinateOrderedSettlement") coordinatorCalls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.equal(coordinatorCalls.length, 5, "settlement coordinator call sites in the Hook");
  for (const call of coordinatorCalls) {
    const argument = call.arguments[0];
    assert.ok(ts.isObjectLiteralExpression(argument));
    assert.deepEqual(argument.properties.map((property) => property.name?.getText(sourceFile))
      .filter((name) => /Affinity/.test(String(name))), [], "Affinity passed to the settlement coordinator");
  }
  // The executor builds these two for the formal Ordered operation; no consumer in the Hook calls them.
  assert.doesNotMatch(hookSource, /[Hh]andle\??\.(readAffinityOutcome|revalidateAffinityOutcome)\??\.?\(/);
  const voiceConsumer = callbackSources[callbackNames.indexOf("scheduleAdvisorAfterQuestionTypeWindow")];
  assert.doesNotMatch(voiceConsumer, /readAffinityOutcome|revalidateAffinityOutcome|filterTaskRelationAffinityOutcomeAtCutoff/);
});

// ---- PC3: Screen and Correction through their own settlement regions ----
//
// The Voice consumer above is a whole Hook callback. Screen and Correction keep
// their Relation settlement inline in a larger entry, so the region itself is
// extracted by AST and run: for Screen, from the deterministic proposal through
// the scheduling call and the formal release block to the no-window settlement
// block of captureScreenContext; for Correction, from the settled Type through
// the Ordered operation and the settlement coordinator to the resettlement call
// of submitSpeechCorrection. The real settlement, coordinator, provenance and
// resettlement functions run. What the entry computed before the region (the
// Screen source and its Type, the Correction's Type outcome) is supplied as
// locals. Each run is compared with the same run with Cross-checks off.

const settlementModule = await compiledMeetingModule("current-question-settlement");
const coordinatorModule = await compiledMeetingModule("ordered-settlement-coordinator");
const provenanceModule = await compiledMeetingModule("relation-decision-provenance");
const correctionModule = await compiledMeetingModule("correction-owned-resettlement");
const typeModule = await compiledMeetingModule("question-type-adjudication");
const taxonomyModule = await compiledMeetingModule("task-taxonomy");

// The statements of one block from the declaration of `firstName` to the first
// later statement `isLast` accepts, as written in the Hook.
function regionSource(declaration, firstName, isLast, what) {
  let found;
  const visit = (node) => {
    if (!found && ts.isBlock(node)) {
      const start = node.statements.findIndex((statement) => ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some((candidate) => candidate.name.getText(sourceFile) === firstName));
      if (start >= 0) {
        const end = node.statements.findIndex((statement, index) => index > start && isLast(statement));
        if (end >= 0) found = node.statements.slice(start, end + 1).map((statement) => statement.getText(sourceFile)).join("\n");
      }
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(declaration);
  assert.ok(found, what);
  return found;
}
const screenRegionSource = regionSource(captureScreenDeclaration, "screenDeterministicSettlementProposal",
  (statement) => ts.isIfStatement(statement) &&
    statement.expression.getText(sourceFile).includes("!screenCurrentQuestionSettlement?.relationMutationAuthorized"),
  "Screen relation region");
const correctionRegionSource = regionSource(termCorrectionDeclaration, "correctionTypeResolution",
  (statement) => ts.isExpressionStatement(statement) && statement.getText(sourceFile).startsWith("correctionOwnedResettlement") &&
    statement.getText(sourceFile).includes("resolveCorrectionOwnedTypeResettlement"),
  "Correction relation region");

// The Screen region schedules its own Relation operation through the Hook's
// scheduleTaskRelationAdjudication and settles the current question.
function runScreenRegion(h, { unit, complete }) {
  const state = h.environment.contextManagerRef.current.getState();
  const screenCurrentQuestion = imports.createProvisionalCurrentQuestion({ logicalQuestionUnit: unit, sourceKind: "screen",
    sourceObservationIds: ["screen-observation"] });
  const context = vm.createContext({
    ...h.environment,
    settleCurrentQuestion: settlementModule.settleCurrentQuestion,
    coordinateOrderedSettlement: coordinatorModule.coordinateOrderedSettlement,
    formatOrderedSettlementCoordinatorForTrace: coordinatorModule.formatOrderedSettlementCoordinatorForTrace,
    createOrderedRelationProvenance: provenanceModule.createOrderedRelationProvenance,
    projectOrderedTaskRelationAdjudication: splitModule.projectOrderedTaskRelationAdjudication,
    formatOrderedTaskRelationResolutionForTrace: splitModule.formatOrderedTaskRelationResolutionForTrace,
    formatFirstBatchRelationReleaseForTrace: splitModule.formatFirstBatchRelationReleaseForTrace,
    createTaskRelationSettlementProposal: relationModule.createTaskRelationSettlementProposal,
    screenRelationQuestion: unit.normalizedText,
    screenRelationLogicalQuestionUnit: unit,
    screenCurrentQuestion,
    screenMemoryQuestionType: "coding",
    screenDirectRelationAuthority: false,
    localScreenTaskRelation: "unknown",
    screenTypeConfidence: 0.95,
    screenSectionHintConsumption: { disposition: "none" },
    screenTaskRelationDecision: { confidence: 0.5 },
    screenTypeEvidenceAuthorized: true,
    localScreenRelationEvidenceAuthorized: false,
    preflightContextState: state,
    screenTypeAuthoritySource: "screen-preflight",
    screenQuestionComplete: complete,
    trace: { id: "trace" },
    inferQuestionTypeDecisionFromText: () => ({ type: "coding" }),
    screenPreparationRuntime: {},
    screenSourcePacket: { visualEvidence: {} },
    toTaskRelationOperationAuthorization: (decision, mismatchedKey = "source") => ({ authorized: decision.authorized,
      reason: decision.reason, mismatchedKey: decision.authorized ? undefined : mismatchedKey }),
    readScreenAuthorization: () => ({ authorized: true, reason: "source-operation-current" }),
    rejectStaleScreenOperation: () => false,
    SCREEN_ORDERED_RELATION_FOREGROUND_BUDGET_MS: splitModule.SCREEN_ORDERED_RELATION_FOREGROUND_BUDGET_MS,
  });
  return vm.runInContext(transpile(`(async () => {
    let screenCurrentQuestionSettlement; let screenTerminalError; let returnedEarly = true;
    const body = async () => { ${screenRegionSource}
      returnedEarly = false; return { handle: taskRelationAdjudicationHandle, screenCoordinatorDecision,
        screenFirstBatchRelationRelease, waitDisposition: screenRelationSettlementWaitDisposition }; };
    const result = await body();
    return { ...(result ?? {}), returnedEarly, screenCurrentQuestionSettlement, screenTerminalError };
  })()`), context);
}

// The Correction region consumes the handle its entry scheduled before the
// Correction-owned Type adjudication. `typeOutcome` is that adjudication's result.
const CORRECTION_TYPE_OUTCOME = { settlement: { questionType: "coding", confidence: 0.95, typeMutationAuthorized: true },
  enforcement: { authorized: true }, candidate: { questionType: "coding", confidence: 0.95 }, operationLeaseAuthorized: true,
  disposition: "completed", providerTimedOut: false };
function runCorrectionRegion(h, { unit, handle, typeOutcome = CORRECTION_TYPE_OUTCOME }) {
  const state = h.environment.contextManagerRef.current.getState();
  const resettlementInputs = [];
  const coordinatorDecisions = [];
  const context = vm.createContext({
    ...h.environment,
    Error,
    // The region keeps its coordinator decision in a local; it is read here as it is made.
    coordinateOrderedSettlement: (input) => {
      const decision = coordinatorModule.coordinateOrderedSettlement(input);
      coordinatorDecisions.push(decision);
      return decision;
    },
    formatOrderedSettlementCoordinatorForTrace: coordinatorModule.formatOrderedSettlementCoordinatorForTrace,
    createOrderedRelationProvenance: provenanceModule.createOrderedRelationProvenance,
    decideOrderedVoiceQuestionTypeResolution: typeModule.decideOrderedVoiceQuestionTypeResolution,
    normalizeCanonicalQuestionType: taxonomyModule.normalizeCanonicalQuestionType,
    resolveCorrectionOwnedTypeResettlement: (input) => {
      resettlementInputs.push(input);
      return correctionModule.resolveCorrectionOwnedTypeResettlement(input);
    },
    CORRECTION_ORDERED_RELATION_FOREGROUND_BUDGET_MS: splitModule.CORRECTION_ORDERED_RELATION_FOREGROUND_BUDGET_MS,
    outcome: typeOutcome,
    latestContext: state,
    latestParent: state.activeMeetingTask?.parent,
    latestParentType: "coding",
    revisionStableTopologyBinding: undefined,
    correctionRelationHandle: handle,
    repairTrace: { id: "trace" },
    correctionSourceKind: "voice",
    application: { logicalQuestionUnit: unit },
    targetSourceObservationIds: [],
    correctionTargetOwnsActiveParent: false,
    correctionCurrentQuestion: handle.currentQuestion,
  });
  return vm.runInContext(transpile(`(async () => {
    let correctionOwnedResettlement; let correctionRelationTerminal; let error;
    try { ${correctionRegionSource} } catch (caught) { error = String(caught && caught.message || caught); }
    return { correctionOwnedResettlement, correctionRelationTerminal, error };
  })()`), context).then((value) => ({ ...value, resettlementInputs, coordinatorDecisions }));
}

// What the question's observation, or a neighbouring question's, answers, and when.
// No-window variants: this very question is observed and answers independent and
// new-parent, the opposite of the null hypothesis that settles it. Formal
// variants: a neighbouring short question is observed while the formal window is
// open and answers related and follow-up, the opposite of the formal independent.
function scriptRegionObservation(h, { formal, unit }) {
  const complete = (unitId, stage, rawOutput, at) => h.clock.setTimeout(() => {
    for (const execution of ofQuestion(h, unitId, stage, "intelligent")) {
      if (!execution.signal.aborted) completeCandidate(execution, { rawOutput });
    }
  }, at);
  if (formal) {
    h.clock.setTimeout(() => { scheduleRelation(h, { unit: observedUnit(), traceId: OBSERVED_TRACE }); }, 100);
    complete(OBSERVED_UNIT_ID, "affinity", PARENT_RELATED, 200);
    complete(OBSERVED_UNIT_ID, "canonical", canonicalOutput("followup-parent"), 250);
    complete(unit.id, "affinity", PARENT_INDEPENDENT, FORMAL_AFFINITY_AT);
  } else {
    complete(unit.id, "affinity", PARENT_INDEPENDENT, 20);
    complete(unit.id, "canonical", canonicalOutput("new-parent"), 40);
  }
}
// The observation's own record: on the question's trace when the question itself
// is observed, on the neighbour's trace otherwise.
const regionObservation = (h, { formal, unit }) => {
  const trace = (formal ? h.otherTraces[OBSERVED_TRACE] : h.metadata) ?? {};
  const unitId = formal ? OBSERVED_UNIT_ID : unit.id;
  return plain({ requests: [ofQuestion(h, unitId, "affinity").length, ofQuestion(h, unitId, "canonical").length],
    decision: trace.taskRelationParentAffinityDecision ?? null, canonicalRelation: trace.taskRelationSplitCanonicalRelation ?? null,
    trigger: trace.taskRelationParentAffinityObservationTrigger ?? null });
};
// A formal question's own trace is compared whole. A no-window question that is
// itself observed shares its trace with the observation, so the Trace-only
// observation fields are set aside there.
const regionTrace = (h, formal) => (formal ? h.metadata : formalTrace(h.metadata));
const OBSERVED = { noWindow: { requests: [2, 2], decision: "independent", canonicalRelation: "new-parent", trigger: "runtime-cross-checks" },
  neighbour: { requests: [2, 2], decision: "related", canonicalRelation: "followup-parent", trigger: "runtime-cross-checks" },
  none: { requests: [0, 0], decision: null, canonicalRelation: null, trigger: null } };

async function runScreenEntryRegion({ crossChecks, variant }) {
  const h = st183Harness({ crossChecks });
  try {
    if (variant === "manual-correction-active") {
      h.environment.manualCorrectionOperationCoordinatorRef.current.getActiveOperationId = () => "manual-correction-op";
    }
    const formal = variant === "formal";
    const unit = variant === "short" ? shortUnit() : logicalQuestionUnit;
    scriptRegionObservation(h, { formal, unit });
    const seen = watch(h, runScreenRegion(h, { unit, complete: variant !== "short" }));
    await h.clock.advanceTo(FORMAL_AFFINITY_AT + 2 * STAGE_MS + 300);
    if (seen.state === "rejected") throw seen.error;
    const value = seen.value ?? {};
    return plain({
      observation: regionObservation(h, { formal, unit }),
      ownRequests: requestsOf(h, unit.id), timersLeft: h.clock.timers.size,
      // Everything the region produced for the formal path.
      region: { state: seen.state, endedAt: seen.at, returnedEarly: value.returnedEarly,
        settlement: value.screenCurrentQuestionSettlement, coordinator: value.screenCoordinatorDecision,
        firstBatch: value.screenFirstBatchRelationRelease, waitDisposition: value.waitDisposition,
        terminalError: value.screenTerminalError, handle: value.handle && handleShape(value.handle),
        operationIds: { handle: value.handle?.operationId, settlement: value.screenCurrentQuestionSettlement?.operationId,
          provenance: value.screenCurrentQuestionSettlement?.orderedRelationProvenance?.operationId },
        trace: regionTrace(h, formal) },
    });
  } finally { h.restore(); }
}

for (const [variant, name] of [
  ["short", "a short question with no release window"],
  ["manual-correction-active", "a complete question with no release window because a manual correction is active"],
  ["formal", "a formal question with a neighbouring observation"],
]) {
  test(`PC3 screen settlement region, ${name}: the settlement, the coordinator decision and the operation ids equal the Cross-checks-off run`, { concurrency: false }, async () => {
    const off = await runScreenEntryRegion({ crossChecks: false, variant });
    const on = await runScreenEntryRegion({ crossChecks: true, variant });
    const formal = variant === "formal";
    const expected = expectations();
    // The observation really ran, with the opposite answers; with the switch off nothing was observed.
    expected.equal([off.observation, on.observation], [OBSERVED.none, formal ? OBSERVED.neighbour : OBSERVED.noWindow],
      "observation requests and answers, Cross-checks off and on");
    const { region } = on;
    expected.equal([region.state, region.returnedEarly, region.terminalError, region.handle?.releaseWindowRequested],
      ["resolved", false, undefined, formal], "region ran to its end");
    if (formal) {
      // The formal independent Affinity decides; Canonical never answers.
      expected.equal([region.settlement?.relation, region.coordinator?.relation.stage, region.coordinator?.relation.reason,
        region.trace.orderedSettlementCoordinatorRelationStage, region.waitDisposition, on.ownRequests.length],
      ["new-parent", "runtime-matrix", "same-type-independent-new-parent", "runtime-matrix", "settled-and-released-before-deadline", 4],
      "formal settlement");
      expected.equal([String(region.operationIds.handle).startsWith("task-relation-ordered:"),
        region.operationIds.settlement === region.operationIds.handle, region.operationIds.provenance === region.operationIds.handle],
      [true, true, true], "the formal operation's own id on the handle, the settlement and the provenance");
    } else {
      // The null hypothesis settles it at once; the observation's own requests are the only ones.
      expected.equal([region.endedAt, region.settlement?.relation, region.coordinator?.relation.stage,
        region.trace.orderedSettlementCoordinatorRelationStage, region.waitDisposition],
      [0, "followup-parent", NULL_HYPOTHESIS, NULL_HYPOTHESIS, "not-awaited"], "no-window settlement");
      // No observation operation id reaches the handle, the settlement or the provenance.
      expected.equal(region.operationIds, { handle: undefined, settlement: `screen-coordinator:${logicalQuestionUnit.id}:1`,
        provenance: undefined }, "operation ids");
      expected.equal([region.handle?.functionFields, region.handle?.promiseFields], [["authorizeOperation"], []],
        "model fields on the handle");
    }
    expected.equal([off.timersLeft, on.timersLeft], [0, 0], "timers left");
    expected.same(on.region, off.region, "region");
    assert.deepEqual(expected.failures, [], "observation changed the Screen settlement");
  });
}

// The Correction-owned Type adjudication ends 600 ms after the correction was
// submitted; the region starts then, with the Relation handle scheduled at 0.
const CORRECTION_REGION_STARTS_AT = 600;
async function runCorrectionEntryRegion({ crossChecks, variant }) {
  const h = st183Harness({ crossChecks });
  try {
    const formal = variant === "formal";
    const unit = formal ? logicalQuestionUnit : shortUnit();
    h.environment.logicalQuestionUnitRef.current = unit;
    const handle = scheduleRelation(h, { unit, manualCorrectionOwned: true });
    scriptRegionObservation(h, { formal, unit });
    const started = {};
    h.clock.setTimeout(() => { started.wait = watch(h, runCorrectionRegion(h, { unit, handle })); }, CORRECTION_REGION_STARTS_AT);
    await h.clock.advanceTo(CORRECTION_REGION_STARTS_AT + 2 * STAGE_MS + 300);
    if (started.wait?.state === "rejected") throw started.wait.error;
    const value = started.wait?.value ?? {};
    return plain({
      observation: regionObservation(h, { formal, unit }),
      ownRequests: requestsOf(h, unit.id), timersLeft: h.clock.timers.size,
      region: { state: started.wait?.state, endedAt: started.wait?.at, error: value.error, terminal: value.correctionRelationTerminal,
        resettlement: value.correctionOwnedResettlement, resettlementInputs: value.resettlementInputs,
        coordinator: value.coordinatorDecisions, handle: handleShape(handle),
        operationIds: { handle: handle.operationId, provenance: value.resettlementInputs?.[0]?.orderedRelationProvenance?.operationId,
          settlementProvenance: value.correctionOwnedResettlement?.settlement?.orderedRelationProvenance?.operationId,
          trace: h.metadata.correctionRelationOperationId },
        trace: regionTrace(h, formal) },
    });
  } finally { h.restore(); }
}

for (const [variant, name] of [
  ["short", "a short question with no release window"],
  ["formal", "a formal question with a neighbouring observation"],
]) {
  test(`PC3 correction settlement region, ${name}: the resettlement, the coordinator decision and the operation ids equal the Cross-checks-off run`, { concurrency: false }, async () => {
    const off = await runCorrectionEntryRegion({ crossChecks: false, variant });
    const on = await runCorrectionEntryRegion({ crossChecks: true, variant });
    const formal = variant === "formal";
    const expected = expectations();
    expected.equal([off.observation, on.observation], [OBSERVED.none, formal ? OBSERVED.neighbour : OBSERVED.noWindow],
      "observation requests and answers, Cross-checks off and on");
    const { region } = on;
    const input = region.resettlementInputs?.[0];
    const coordinator = region.coordinator?.[0];
    expected.equal([region.state, region.error, region.terminal, region.resettlementInputs?.length, region.coordinator?.length,
      region.handle.releaseWindowRequested], ["resolved", undefined, undefined, 1, 1, formal], "region ran to its resettlement call");
    if (formal) {
      expected.equal([input?.orderedRelation, input?.orderedRelationReason, region.resettlement?.relation,
        coordinator?.relation.stage, coordinator?.relation.reason, region.trace.orderedSettlementCoordinatorRelationStage,
        on.ownRequests.length],
      ["new-parent", "ordered-relation:runtime-matrix", "new-parent", "runtime-matrix", "same-type-independent-new-parent",
        "runtime-matrix", 4], "formal resettlement");
      expected.equal([String(region.operationIds.handle).startsWith("task-relation-ordered:"),
        region.operationIds.provenance === region.operationIds.handle, region.operationIds.trace === region.operationIds.handle],
      [true, true, true], "the formal operation's own id on the handle, the provenance and the trace");
    } else {
      // The observation had answered independent and new-parent 560 ms before the region started.
      expected.equal([region.endedAt, input?.orderedRelation, region.resettlement?.relation, coordinator?.relation.stage,
        region.trace.orderedSettlementCoordinatorRelationStage],
      [CORRECTION_REGION_STARTS_AT, "followup-parent", "followup-parent", NULL_HYPOTHESIS, NULL_HYPOTHESIS], "no-window resettlement");
      expected.equal(region.operationIds, { handle: undefined, provenance: undefined, settlementProvenance: undefined, trace: undefined },
        "operation ids");
      expected.equal([region.handle.functionFields, region.handle.promiseFields], [["authorizeOperation"], []],
        "model fields on the handle");
    }
    expected.equal([off.timersLeft, on.timersLeft], [0, 0], "timers left");
    expected.same(on.region, off.region, "region");
    assert.deepEqual(expected.failures, [], "observation changed the Correction resettlement");
  });
}

// ---- PC4: the formal Relation is the same under every switch combination ----

async function runFormalAlone({ entry, debug, recording, crossChecks, logLevel, logDelivery }) {
  const h = st183Harness({ debug, recording, crossChecks, logLevel, logDelivery });
  try {
    const handle = scheduleEntry(h, entry);
    const started = {};
    if (entry === "voice") startVoiceFor(h, handle, logicalQuestionUnit);
    else if (entry === "screen") started.wait = watch(h, startScreenConsumer(h, handle));
    else h.clock.setTimeout(() => { started.wait = watch(h, startCorrectionConsumer(h, handle)); }, 200);
    h.clock.setTimeout(() => completeCandidate(candidate(h, "affinity", "intelligent"), { rawOutput: PARENT_INDEPENDENT }),
      FORMAL_AFFINITY_AT);
    h.clock.setTimeout(() => completeCandidate(candidate(h, "canonical", "intelligent"),
      { rawOutput: canonicalOutput("new-parent") }), FORMAL_CANONICAL_AT);
    await h.clock.advanceTo(FORMAL_CANONICAL_AT + 200);
    return { h, formal: plain({
      relation: finalRelation(h, entry, started),
      consumer: entry === "voice" ? voiceRelease(h) : started.wait?.value,
      trace: h.metadata,
      // Prompt input, route, budget, lane-independent dispatch time and identity of every physical request.
      requests: h.executions.map((execution) => ({ request: execution.request, tier: tierOf(execution),
        selectedProvider: execution.selectedProvider, timeoutMs: execution.timeoutMs, dispatchedAt: execution.dispatchedAt - 10_000,
        identity: execution.executionIdentity, aborted: execution.signal.aborted })),
      handle: { operationId: handle.operationId, affinityDeadlineAt: handle.affinityDeadlineAt,
        releaseWindowRequested: handle.releaseWindowRequested },
    }) };
  } catch (error) {
    h.restore();
    throw error;
  }
}
const SWITCH_COMBINATIONS = [false, true].flatMap((debug) => [false, true].flatMap((recording) =>
  [false, true].map((crossChecks) => ({ debug, recording, crossChecks }))));

for (const entry of ["voice", "screen", "correction"]) {
  test(`PC4 ${entry} formal Relation: requests, routes, budgets, recorded stages and the release are identical for every Debug x Recording x Cross-checks combination`, { concurrency: false }, async () => {
    const runs = [];
    for (const switches of SWITCH_COMBINATIONS) {
      const run = await runFormalAlone({ entry, ...switches });
      run.h.restore();
      runs.push({ switches, ...run });
    }
    const reference = runs[0].formal;
    expectEqual([reference.relation, reference.trace.taskRelationOrderedResolutionStage, reference.requests.length,
      reference.requests.map((request) => request.tier).sort(), reference.requests.map((request) => request.timeoutMs),
      reference.trace.taskRelationParentAffinityAdmissionLane, reference.trace.taskRelationSplitCanonicalAdmissionLane,
      reference.trace.taskRelationParentAffinityObservationTrigger, reference.trace.taskRelationSplitCanonicalObservationTrigger],
    ["new-parent", "canonical-relation", 4, ["fast", "fast", "intelligent", "intelligent"],
      [STAGE_MS, STAGE_MS, STAGE_MS, STAGE_MS], "critical", "critical", undefined, undefined], "formal operation with every switch off");
    for (const { switches, formal, h } of runs) {
      assert.deepEqual(formal, reference, `formal Relation with ${JSON.stringify(switches)}`);
      // Each switch feeds only its own sink.
      expectEqual(h.debugOutputs.length > 0, switches.debug, `candidate outputs written to the trace with ${JSON.stringify(switches)}`);
      expectEqual(h.recorded.length > 0, switches.recording, `recorder written with ${JSON.stringify(switches)}`);
    }
  });
}

// ===========================================================================
// Task 178A (AE1, AE3, AE4, AE7): Relation provider candidates through the
// Hook's real schedule, the real operation runtimes and the real admission
// coordinator. Every event read below was emitted by that production code.
// ===========================================================================

const { awaitRuntimeCriticalFact, createFileBackedRecorder: aeCreateFileBackedRecorder } =
  await import(pathToFileURL(path.join(root, ".tmp-tests/tests/helpers/runtime-critical-events.js")));
const aeFormalStart = (unitId) => (event) => event.fact === "provider-request-started" &&
  event.purpose === "formal" && event.refs.logicalQuestionUnitId === unitId;
const aeProviderTerminal = (unitId) => (event) => event.fact === "terminal" &&
  event.terminal.object === "provider-request" && event.refs.logicalQuestionUnitId === unitId;
const aeRow = (event) => [event.fact, event.purpose, event.refs.operationKind, event.refs.providerTier,
  event.terminal?.disposition ?? event.stage];

test("AE1 Relation provider facts: each physical candidate whose request is really dispatched is one formal Provider-start fact, and its own completion or cancellation is its terminal", { concurrency: false }, async () => {
  const h = st183Harness();
  try {
    const handle = scheduleEntry(h, "voice");
    startVoiceFor(h, handle, logicalQuestionUnit);
    assert.deepEqual(h.criticalEvents.events(), [], "scheduling a Relation operation starts no provider request yet");
    h.clock.setTimeout(() => completeCandidate(candidate(h, "affinity", "intelligent"), { rawOutput: PARENT_INDEPENDENT }),
      FORMAL_AFFINITY_AT);
    h.clock.setTimeout(() => completeCandidate(candidate(h, "canonical", "intelligent"),
      { rawOutput: canonicalOutput("new-parent") }), FORMAL_CANONICAL_AT);
    await h.clock.advanceTo(FORMAL_CANONICAL_AT + 200);
    expectEqual(finalRelation(h, "voice", {}), "new-parent", "the formal Relation itself");
    const events = h.criticalEvents.events();
    expectEqual(events.map(aeRow), [
      ["provider-request-started", "formal", "task-relation-parent-affinity", "intelligent", "request-start"],
      ["provider-request-started", "formal", "task-relation-parent-affinity", "fast", "request-start"],
      ["terminal", "formal", "task-relation-parent-affinity", "intelligent", "completed"],
      ["terminal", "formal", "task-relation-parent-affinity", "fast", "cancelled"],
      ["provider-request-started", "formal", "task-relation-canonical-shadow", "intelligent", "request-start"],
      ["provider-request-started", "formal", "task-relation-canonical-shadow", "fast", "request-start"],
      ["terminal", "formal", "task-relation-canonical-shadow", "intelligent", "completed"],
      ["terminal", "formal", "task-relation-canonical-shadow", "fast", "cancelled"],
    ], "formal Relation provider facts");
    // Exactly the physical requests that were really dispatched.
    expectEqual(events.filter((event) => event.fact === "provider-request-started").length, h.executions.length,
      "one start per dispatched request");
    for (const event of events) {
      expectEqual([event.runtimeSessionId, event.runtimeEpoch, event.refs.logicalQuestionUnitId,
        event.refs.logicalQuestionRevision, event.refs.traceId],
      ["session-a", 1, logicalQuestionUnit.id, logicalQuestionUnit.revision, "trace"], "the operation's own identity");
      // The physical candidate and its logical operation, each by its own id.
      const dispatched = h.executions.find((execution) =>
        execution.request.operationKind === event.refs.operationKind && tierOf(execution) === event.refs.providerTier);
      const requestId = dispatched.executionIdentity.requestId;
      expectEqual([event.refs.requestId, event.omittedRefs, event.digestedRefs], [requestId, undefined, undefined], "candidate id");
      expectEqual(requestId, `${event.refs.operationId}:${event.refs.providerTier}`, "the candidate of that operation");
      expectEqual(JSON.stringify(event).includes(QUESTION), false, "no question text in an event");
    }
    // The start is the dispatch itself: produced at the time the request
    // function was called, in dispatch order.
    expectEqual(events.filter((event) => event.fact === "provider-request-started").map((event) =>
      [event.refs.requestId, event.occurredAt]),
    h.executions.map((execution) => [execution.executionIdentity.requestId, execution.dispatchedAt]), "start = dispatch");
    // A provider terminal is the candidate's own: it is not the Relation
    // settlement and not an answer.
    expectEqual(events.some((event) => ["relation-settled", "type-settled", "stable-answer-committed"].includes(event.fact)),
      false, "a provider terminal never stands for a settlement or an answer");
    expectEqual(h.clock.timers.size, 0, "no timer left behind by event delivery");
  } finally { h.restore(); }
});

// The same question unit and revision as a formal operation and, when Runtime
// Cross-checks admits it, as an observation that is scheduled FIRST. Operation
// ids are identical for both, so only the purpose tells them apart.
async function aeRunSwitches({ debug, recording, crossChecks, logLevel }) {
  const h = st183Harness({ debug, crossChecks, logLevel });
  const recorder = recording ? await aeCreateFileBackedRecorder() : undefined;
  try {
    if (recorder) {
      await recorder.start("session-a");
      h.environment.sessionRecordingManagerRef.current = recorder.manager;
    }
    tagRequestLanes(h);
    const lane = (name, stage, tier) => h.executions.filter((execution) => execution.lane === name &&
      execution.request.operationKind.includes(stage) && tierOf(execution) === tier);
    h.environment.scheduleTaskRelationAdjudication({
      turn: { speaker: "them", text: QUESTION }, traceId: SAME_REVISION_TRACE, turnGateAction: "phase-control",
      logicalQuestionUnit, lexical: { type: "coding" }, sourceKind: "voice", authorizeSourceOperation: sourceCurrent });
    await h.clock.advanceTo(100);
    const handle = scheduleEntry(h, "voice");
    startVoiceFor(h, handle, logicalQuestionUnit);
    const fromNow = (absolute) => absolute - 100;
    h.clock.setTimeout(() => {
      for (const execution of lane("evaluation", "canonical", "intelligent")) {
        completeCandidate(execution, { rawOutput: canonicalOutput("followup-parent") });
      }
    }, fromNow(250));
    h.clock.setTimeout(() => {
      for (const execution of lane("critical", "affinity", "intelligent")) completeCandidate(execution, { rawOutput: PARENT_INDEPENDENT });
    }, fromNow(100 + FORMAL_AFFINITY_AT));
    h.clock.setTimeout(() => {
      for (const execution of lane("critical", "canonical", "intelligent")) {
        completeCandidate(execution, { rawOutput: canonicalOutput("new-parent") });
      }
    }, fromNow(100 + FORMAL_CANONICAL_AT));
    await h.clock.advanceTo(100 + FORMAL_CANONICAL_AT + 200);
    const events = h.criticalEvents.events();
    let journal;
    if (recorder) {
      await recorder.stop();
      journal = await recorder.files.readCriticalEventJournal(recorder.files.folders[0]);
    }
    return plain({
      events,
      formal: normalizeRuntimeCriticalEvents(events, { purpose: "formal" }),
      formalTimes: events.filter((event) => event.purpose === "formal").map((event) => event.occurredAt - 10_000),
      observation: events.filter((event) => event.purpose === "observation").map(aeRow),
      business: { release: voiceRelease(h), requests: h.executions.filter((execution) => execution.lane === "critical")
        .map((execution) => [execution.request.operationKind, tierOf(execution), execution.dispatchedAt - 10_000, execution.timeoutMs]) },
      stats: h.criticalEvents.stream.getStats(),
      journal,
      timersLeft: h.clock.timers.size,
      // Task 178 LG: what the logger delivered in this run.
      diagnosticLog: h.diagnosticLog.entries().map((entry) => `${entry.level} ${entry.event}`),
    });
  } finally {
    h.restore();
    await recorder?.cleanup();
  }
}

test("AE3 Debug x Recording x Cross-checks: the eight combinations give the same formal facts in the same order at the same times; observation facts exist only with Cross-checks on, carry their purpose and never satisfy a formal barrier", { concurrency: false }, async () => {
  const runs = [];
  for (const switches of SWITCH_COMBINATIONS) runs.push({ switches, ...(await aeRunSwitches(switches)) });
  const reference = runs[0];
  expectEqual(reference.formal.map((event) => [event.fact, event.refs.operationKind, event.refs.providerTier,
    event.terminal?.disposition ?? event.stage]), [
    ["provider-request-started", "task-relation-parent-affinity", "intelligent", "request-start"],
    ["provider-request-started", "task-relation-parent-affinity", "fast", "request-start"],
    ["terminal", "task-relation-parent-affinity", "intelligent", "completed"],
    ["terminal", "task-relation-parent-affinity", "fast", "cancelled"],
    ["provider-request-started", "task-relation-canonical-shadow", "intelligent", "request-start"],
    ["provider-request-started", "task-relation-canonical-shadow", "fast", "request-start"],
    ["terminal", "task-relation-canonical-shadow", "intelligent", "completed"],
    ["terminal", "task-relation-canonical-shadow", "fast", "cancelled"],
  ], "formal facts with every switch off");
  expectEqual(reference.business.release.settlement?.relation, "new-parent", "the formal result");
  for (const run of runs) {
    const name = JSON.stringify(run.switches);
    assert.deepEqual(run.formal, reference.formal, `formal facts, relative order and normalized ids with ${name}`);
    assert.deepEqual(run.formalTimes, reference.formalTimes, `formal availability times with ${name}`);
    assert.deepEqual(run.business, reference.business, `formal requests and release with ${name}`);
    expectEqual(run.timersLeft, 0, `timers left with ${name}`);
    // Observation facts are present only when Cross-checks admitted the work.
    expectEqual(run.observation.length > 0, run.switches.crossChecks, `observation facts with ${name}`);
    if (run.switches.crossChecks) {
      expectEqual(run.observation, [
        ["provider-request-started", "observation", "task-relation-parent-affinity", "intelligent", "request-start"],
        ["provider-request-started", "observation", "task-relation-parent-affinity", "fast", "request-start"],
        // The formal schedule superseded the observation Affinity.
        ["terminal", "observation", "task-relation-parent-affinity", "intelligent", "cancelled"],
        ["terminal", "observation", "task-relation-parent-affinity", "fast", "cancelled"],
        ["provider-request-started", "observation", "task-relation-canonical-shadow", "intelligent", "request-start"],
        ["provider-request-started", "observation", "task-relation-canonical-shadow", "fast", "request-start"],
        ["terminal", "observation", "task-relation-canonical-shadow", "intelligent", "completed"],
        ["terminal", "observation", "task-relation-canonical-shadow", "fast", "cancelled"],
      ], `observation facts with ${name}`);
    }
    // A formal barrier: "the Parent Affinity request of this question started".
    // The observation of the same unit and revision started 100 ms earlier
    // under the same operation kind; it must not satisfy the barrier.
    const blind = run.events.find((event) => event.fact === "provider-request-started" &&
      event.refs.operationKind === "task-relation-parent-affinity" && event.refs.logicalQuestionUnitId === logicalQuestionUnit.id);
    const barrier = run.events.find((event) => aeFormalStart(logicalQuestionUnit.id)(event) &&
      event.refs.operationKind === "task-relation-parent-affinity");
    expectEqual([barrier.purpose, barrier.occurredAt - 10_000], ["formal", 100], `formal barrier with ${name}`);
    expectEqual(blind.occurredAt - 10_000, run.switches.crossChecks ? 0 : 100,
      `a purpose-blind match would fire on the observation with ${name}`);
    // Recording saves the same facts it was handed, in order; off saves nothing.
    expectEqual(run.journal?.status, run.switches.recording ? "ok" : undefined, `journal with ${name}`);
    if (run.journal) {
      expectEqual([run.journal.contiguous, run.journal.eventCount, run.journal.sessions[0].events.map((event) => event.eventId)],
        [true, run.events.length, run.events.map((event) => event.eventId)], `saved order and identity with ${name}`);
      expectEqual(run.stats.recording.accepted, run.events.length, `recorded count with ${name}`);
    } else expectEqual(run.stats.recording["not-recording"], run.events.length, `not-recording count with ${name}`);
  }
});

test("AE4 Relation isolation: with the interface idle, observed, failing by a throw or by a rejected promise, overflowing or unable to write, the formal requests, budgets, timers, trace and release are identical", { concurrency: false }, async () => {
  const idle = (mode) => mode === "idle" || mode === "idle-again";
  const run = async (mode) => {
    const h = st183Harness();
    const recorder = mode === "write-failure" ? await aeCreateFileBackedRecorder() : undefined;
    try {
      let thrown = 0;
      if (idle(mode) || mode === "overflow-capacity-1") {
        // The same real stream class: nobody subscribed, or a queue of one.
        h.criticalEvents = createRuntimeCriticalEventHarness({ sessionId: "session-a", observe: !idle(mode),
          now: () => h.clock.now, limits: idle(mode) ? undefined : { queueCapacity: 1 } });
        Object.assign(h.environment, h.criticalEvents.hookRefs);
      }
      if (mode === "throwing-observer") {
        h.criticalEvents.stream.subscribe(() => { thrown += 1; throw new Error("observer failure"); });
      }
      if (mode === "async-failing-observer") {
        // An async observer: every delivery it is handed rejects.
        h.criticalEvents.stream.subscribe(async () => { thrown += 1; throw new Error("async observer failure"); });
      }
      if (recorder) {
        await recorder.start("session-a");
        recorder.files.failWrite = (relativePath) => relativePath.startsWith("runtime-events/");
        // Only the event sink is handed to the real, failing Recording owner;
        // every other recorder call is the inert stand-in of an inactive one.
        h.environment.sessionRecordingManagerRef.current = new Proxy({
          getState: () => ({ active: false }),
          recordRuntimeCriticalEvent: (event) => recorder.manager.recordRuntimeCriticalEvent(event),
        }, { get: (target, key) => target[key] ?? (() => undefined) });
      }
      const handle = scheduleEntry(h, "voice");
      startVoiceFor(h, handle, logicalQuestionUnit);
      h.clock.setTimeout(() => completeCandidate(candidate(h, "affinity", "intelligent"), { rawOutput: PARENT_INDEPENDENT }),
        FORMAL_AFFINITY_AT);
      h.clock.setTimeout(() => completeCandidate(candidate(h, "canonical", "intelligent"),
        { rawOutput: canonicalOutput("new-parent") }), FORMAL_CANONICAL_AT);
      await h.clock.advanceTo(FORMAL_CANONICAL_AT + 200);
      h.criticalEvents.flush();
      // A rejection handler is a microtask; a macrotask later every one has run.
      await new Promise((resolve) => setImmediate(resolve));
      let manifest;
      if (recorder) {
        await recorder.stop();
        manifest = await recorder.files.readManifest(recorder.files.folders[0]);
      }
      return plain({
        business: { release: voiceRelease(h), trace: h.metadata, timersLeft: h.clock.timers.size,
          requests: h.executions.map((execution) => [execution.request.operationKind, tierOf(execution),
            execution.dispatchedAt - 10_000, execution.timeoutMs, execution.signal.aborted]) },
        stats: h.criticalEvents.stream.getStats(), thrown, delivered: h.criticalEvents.deliveries.map((delivery) => delivery.kind),
        integrity: manifest?.recordingIntegrity,
      });
    } finally {
      h.restore();
      await recorder?.cleanup();
    }
  };
  // The reference is the idle interface on this code: the real stream with
  // nobody subscribed. It runs twice, which is the comparison's own noise floor.
  const modes = ["idle", "idle-again", "observer", "throwing-observer", "async-failing-observer",
    "overflow-capacity-1", "write-failure"];
  const results = {};
  for (const mode of modes) results[mode] = await run(mode);
  const reference = results.idle;
  expectEqual(reference.business.release.settlement?.relation, "new-parent", "the formal result");
  expectEqual(reference.business.requests.length, 4, "the formal requests");
  for (const mode of ["idle", "idle-again"]) {
    expectEqual([results[mode].stats.produced, results[mode].stats.drainsScheduled, results[mode].stats.queuePeak],
      [8, 0, 0], `${mode}: produced, never queued or scheduled`);
  }
  for (const mode of modes) {
    assert.deepEqual(results[mode].business, reference.business, `${mode}: formal Relation`);
  }
  expectEqual(results.observer.delivered.length, 8, "observer deliveries");
  expectEqual([results["throwing-observer"].thrown, results["throwing-observer"].stats.subscriberFailures,
    results["throwing-observer"].delivered.length], [1, 1, 8], "a throwing observer is cut off; the other one is complete");
  // An observer that fails by a rejected promise is cut off with one failure
  // counted, whatever it was handed before its first rejection ran.
  expectEqual([results["async-failing-observer"].thrown >= 1, results["async-failing-observer"].stats.subscriberFailures,
    results["async-failing-observer"].stats.subscribers, results["async-failing-observer"].delivered.length],
  [true, 1, 1, 8], "an async-failing observer is cut off; the other one is complete");
  // A queue of one: the evidence is explicitly incomplete, the Relation untouched.
  expectEqual([results["overflow-capacity-1"].stats.produced, results["overflow-capacity-1"].stats.overflowDropped > 0,
    results["overflow-capacity-1"].delivered.includes("gap")], [8, true, true], "overflow is explicit");
  // Every journal append failed: the Recording owner's own integrity says so.
  expectEqual([results["write-failure"].stats.produced, results["write-failure"].stats.recording.accepted,
    results["write-failure"].integrity.status, results["write-failure"].integrity.failedWriteCount],
  [8, 8, "incomplete", 8], "write failure is the recording's own incomplete mark");
});

test("AE1/AE5 Relation ids of production length: every dispatched candidate's start and terminal carry the same bounded reference, apart from the other candidate and from the logical operation", { concurrency: false }, async () => {
  const h = st183Harness({ child: true });
  try {
    // Identifiers shaped like the ones the Hook allocates in production.
    const sessionId = "meeting_1791075101245_k3j9x2";
    const unit = { ...logicalQuestionUnit, id: "logical_question_1791075101301_q8w2e1", sessionId };
    h.environment.contextManagerRef.current.getState().sessionId = sessionId;
    h.environment.logicalQuestionUnitRef.current = unit;
    h.criticalEvents = createRuntimeCriticalEventHarness({ sessionId, now: () => h.clock.now });
    Object.assign(h.environment, h.criticalEvents.hookRefs);
    const handle = scheduleRelation(h, { sourceKind: "voice", unit });
    assert.ok(handle);
    await h.clock.advanceTo(200);
    assert.ok(h.executions.length >= 2, "the candidates were really dispatched");
    stop(h);
    await h.clock.advanceTo(2 * STAGE_MS + 500);
    const events = h.criticalEvents.events();
    const started = events.filter((event) => event.fact === "provider-request-started");
    expectEqual(started.length, h.executions.length, "one start per dispatched request");
    // Starts are produced in dispatch order, so each start has its raw id.
    const rawRequestIds = h.executions.map((execution) => execution.executionIdentity.requestId);
    assert.ok(rawRequestIds.some((requestId) => requestId.length > 128) && rawRequestIds.some((requestId) => requestId.length <= 128),
      `production-length candidate ids straddle the reference bound: ${rawRequestIds.map((requestId) => requestId.length)}`);
    started.forEach((event, index) => {
      const raw = rawRequestIds[index];
      if (raw.length > 128) {
        expectEqual([event.refs.requestId.length, event.refs.requestId.slice(0, 111), event.digestedRefs],
          [128, raw.slice(0, 111), ["requestId"]], "a longer candidate id is carried as a bounded digest and named");
      } else expectEqual([event.refs.requestId, event.digestedRefs], [raw, undefined], "a shorter one is carried as it is");
    });
    for (const event of events) {
      expectEqual(event.omittedRefs, undefined, "no identity is dropped");
      expectEqual([event.refs.requestId.length <= 128, event.refs.operationId.length <= 128], [true, true], "bounded");
      expectEqual(JSON.stringify(event).length <= 2048, true, "within the payload bound");
    }
    // Start and terminal pair by identity; candidates and operations stay apart.
    const terminals = events.filter((event) => event.fact === "terminal");
    expectEqual(terminals.length, started.length, "every started candidate has its terminal");
    expectEqual(terminals.map((event) => event.refs.requestId).sort(), started.map((event) => event.refs.requestId).sort(),
      "each terminal names the request that started");
    expectEqual(new Set(started.map((event) => event.refs.requestId)).size, started.length, "candidates are told apart");
    for (const event of started) {
      const siblings = started.filter((other) => other.refs.operationId === event.refs.operationId);
      expectEqual(siblings.map((other) => other.refs.providerTier).sort(), ["fast", "intelligent"], "one operation, two candidates");
      expectEqual(event.refs.requestId === event.refs.operationId, false, "candidate and operation are different references");
    }
    expectEqual(new Set(started.map((event) => event.refs.operationId)).size, started.length / 2, "operations are told apart");
  } finally { h.restore(); }
});

test("AE7 a test-side observer waits for A's real formal Provider-start fact, then submits B through the production Relation entry; A ends by the real latest-wins terminal and commits nothing", { concurrency: false }, async () => {
  const h = st183Harness();
  try {
    const current = { unit: logicalQuestionUnit };
    const ownerOf = (unit) => () => (current.unit === unit ? sourceCurrent()
      : { authorized: false, reason: "logical-question-revision-mismatch", mismatchedKey: "source" });
    const timersBefore = h.clock.timers.size;
    // Registered before A exists.
    const startOfA = awaitRuntimeCriticalFact(h.criticalEvents.stream, {
      matches: aeFormalStart(logicalQuestionUnit.id),
      endsOn: aeProviderTerminal(logicalQuestionUnit.id),
    });
    expectEqual(h.clock.timers.size, timersBefore, "the observer registers no timer");
    const handleA = scheduleRelation(h, { sourceKind: "screen", authorizeSourceOperation: ownerOf(logicalQuestionUnit) });
    const waitA = watch(h, startScreenConsumer(h, handleA));
    expectEqual(startOfA.settled(), false, "A is scheduled, its provider request has not started");
    await h.clock.advanceTo(500);
    const oldCandidates = [...h.executions];
    expectEqual(oldCandidates.length, 2, "A's candidates were really dispatched");
    // Delivery is its own macrotask: nothing was delivered inside A's stack.
    expectEqual(startOfA.settled(), false, "not delivered inside the producer's stack");
    h.criticalEvents.manualClock.runNext();
    const reached = await startOfA.promise;
    expectEqual([reached.status, reached.event.purpose, reached.event.refs.operationKind, reached.event.refs.logicalQuestionRevision],
      ["matched", "formal", "task-relation-parent-affinity", logicalQuestionUnit.revision], "A's Provider-start fact");
    // B, a newer revision, through the same production entry and its real guards.
    const unitB = nextUnit();
    current.unit = unitB;
    const handleB = scheduleRelation(h, { sourceKind: "screen", unit: unitB, authorizeSourceOperation: ownerOf(unitB) });
    const waitB = watch(h, startScreenConsumer(h, handleB));
    await h.clock.advanceTo(1_000);
    expectEqual(oldCandidates.every((execution) => execution.signal.aborted), true, "A's requests were aborted by B");
    const newAffinity = candidates(h, "affinity").filter((execution) => !oldCandidates.includes(execution));
    completeCandidate(newAffinity.find((execution) => tierOf(execution) === "fast"), { rawOutput: FAST_PARENT_INDEPENDENT });
    await h.clock.advanceTo(500 + STAGE_MS + 100);
    const consumedCanonical = candidates(h, "canonical").filter((execution) =>
      execution.request.identity.logicalQuestionUnitRevision === unitB.revision && tierOf(execution) === "intelligent");
    for (const execution of consumedCanonical) completeCandidate(execution, { rawOutput: canonicalOutput("unknown") });
    await h.clock.advanceTo(500 + STAGE_MS + 300);
    expectEqual([waitA.state, waitA.value?.terminalDisposition], ["resolved", "cancelled"], "A: superseded, commits nothing");
    expectEqual([waitB.state, waitB.value?.terminalDisposition], ["resolved", "resolved"], "B: the latest owner resolves");
    // The real latest-wins terminals, read from the stream.
    const events = h.criticalEvents.events();
    const ofRevision = (revision) => events.filter((event) => event.refs.logicalQuestionRevision === revision);
    const factsOfA = ofRevision(logicalQuestionUnit.revision);
    expectEqual(factsOfA.slice(0, 4).map(aeRow), [
      ["provider-request-started", "formal", "task-relation-parent-affinity", "intelligent", "request-start"],
      ["provider-request-started", "formal", "task-relation-parent-affinity", "fast", "request-start"],
      ["terminal", "formal", "task-relation-parent-affinity", "intelligent", "cancelled"],
      ["terminal", "formal", "task-relation-parent-affinity", "fast", "cancelled"],
    ], "A's facts: started, then cancelled by the newer question");
    // Whatever A's superseded operation still started, none of it completed.
    expectEqual([factsOfA.filter((event) => event.fact === "terminal").every((event) => event.terminal.disposition === "cancelled"),
      factsOfA.filter((event) => event.fact === "terminal").length,
      factsOfA.filter((event) => event.fact === "provider-request-started").length],
    [true, factsOfA.length / 2, factsOfA.length / 2], "every request of A ended cancelled");
    const firstOfB = events.findIndex((event) => event.refs.logicalQuestionRevision === unitB.revision);
    expectEqual(events[firstOfB].sequence > reached.event.sequence, true, "B started after A's Provider-start fact");
    expectEqual(ofRevision(unitB.revision).filter((event) => event.fact === "terminal" && event.terminal.disposition === "completed").length >= 1,
      true, "B's own candidates completed");
    expectEqual(h.clock.timers.size, 0, "no timer left behind");
  } finally { h.restore(); }
});

test("AE7 negatives: A cancelled while queued, A admitted and cancelled before its request is dispatched, A failing before any request, and a fact that never happens all end the observer explicitly, without a timer or an invented Provider fact", { concurrency: false }, async () => {
  // Cancelled while still queued for admission: no request started, so there
  // is neither a Provider-start fact nor a provider-request terminal. The
  // session is then stopped and the observer ends on the stream's own marker.
  const queued = st183Harness();
  try {
    saturateAdmission(queued);
    const waiter = awaitRuntimeCriticalFact(queued.criticalEvents.stream, {
      matches: aeFormalStart(logicalQuestionUnit.id), endsOn: aeProviderTerminal(logicalQuestionUnit.id) });
    const handle = scheduleRelation(queued, { sourceKind: "screen" });
    const wait = watch(queued, startScreenConsumer(queued, handle));
    await queued.clock.advanceTo(500);
    queued.criticalEvents.flush();
    expectEqual(waiter.settled(), false, "queued behind admission: no start, no terminal yet");
    const dispatchedBefore = queued.executions.length;
    stop(queued);
    await queued.clock.advanceTo(600);
    queued.criticalEvents.flush();
    expectEqual(queued.executions.length, dispatchedBefore, "the queued candidates were never dispatched");
    expectEqual(queued.criticalEvents.events().filter((event) => event.refs.logicalQuestionUnitId === logicalQuestionUnit.id &&
      (event.fact === "provider-request-started" || event.terminal?.object === "provider-request")), [],
    "no Provider fact was invented for a request that never left the queue");
    expectEqual(waiter.settled(), false, "nothing claims the fact happened or ended");
    queued.criticalEvents.stream.closeSubscriptions("meeting-assistant-stopped");
    queued.criticalEvents.flush();
    expectEqual(await waiter.promise, { status: "closed", reason: "meeting-assistant-stopped", discarded: 0 }, "cancel before start");
    await queued.clock.advanceTo(2 * STAGE_MS + 500);
    expectEqual(wait.state !== "pending", true, "the consumer ended by its own exit");
  } finally { queued.restore(); }

  // Admitted, then cancelled in the same tick, before its execution reached the
  // request: admission is not a request start.
  const admitted = st183Harness();
  try {
    // The Hook's own Stop runs in the turn that admitted the first candidate,
    // after the Hook's sink saw "admitted" and before the microtask that would
    // have dispatched the request.
    const selector = admitted.environment.requestTaskRelationProviderCandidates;
    const seen = [];
    admitted.environment.requestTaskRelationProviderCandidates = (input, dependencies) => selector({ ...input,
      onObservation(observation) {
        input.onObservation?.(observation);
        seen.push(`${observation.event}:${observation.providerTier}`);
        if (observation.event === "admitted" && !seen.includes("stopped")) { seen.push("stopped"); stop(admitted); }
      } }, dependencies);
    const handle = scheduleRelation(admitted, { sourceKind: "screen" });
    const wait = watch(admitted, startScreenConsumer(admitted, handle));
    await admitted.clock.advanceTo(2 * STAGE_MS + 500);
    admitted.criticalEvents.flush();
    expectEqual(seen.slice(0, 5), ["queued:intelligent", "admitted:intelligent", "stopped", "cancelled:intelligent", "cancelled:fast"],
      "admitted, then stopped in the same turn; the selector reports both candidates cancelled");
    const affinityRequests = admitted.executions.filter((execution) => execution.request.operationKind.includes("affinity"));
    expectEqual(affinityRequests.length, 0, "the admitted Affinity candidate never dispatched a request");
    const events = admitted.criticalEvents.events();
    expectEqual(events.filter((event) => event.refs.operationKind === "task-relation-parent-affinity"), [],
      "an admitted candidate that never dispatched has no start and no provider terminal");
    // The harness Stop cancels runtimes only, so the next stage still ran: its
    // candidates were really dispatched, and each has a start and a terminal.
    const later = events.filter((event) => event.refs.operationKind !== "task-relation-parent-affinity");
    expectEqual([later.filter((event) => event.fact === "provider-request-started").length,
      later.filter((event) => event.terminal?.object === "provider-request").length],
    [admitted.executions.length, admitted.executions.length], "only dispatched requests have Provider facts");
    expectEqual(wait.state !== "pending", true, "the consumer ended by its own exit");
  } finally { admitted.restore(); }

  // Early failure: the provider route is missing, so no request ever starts.
  // The session then stops; the observer ends on the stream's closed marker.
  const failing = st183Harness({ runtime: { missingProviderTier: "intelligent" } });
  try {
    const timers = failing.clock.timers.size;
    const waiter = awaitRuntimeCriticalFact(failing.criticalEvents.stream, {
      matches: aeFormalStart(logicalQuestionUnit.id), endsOn: aeProviderTerminal(logicalQuestionUnit.id) });
    const handle = scheduleRelation(failing, { sourceKind: "screen" });
    const wait = watch(failing, startScreenConsumer(failing, handle));
    await failing.clock.advanceTo(2 * STAGE_MS + 500);
    failing.criticalEvents.flush();
    expectEqual(failing.executions.length, 0, "no physical request was dispatched");
    expectEqual(failing.criticalEvents.events(), [], "no Provider fact exists for a request that never started");
    expectEqual(waiter.settled(), false, "the fact has not happened and nothing claims it did");
    expectEqual(wait.state !== "pending", true, "the consumer ended by its own error exit");
    // Stop, as the Hook does it: the subscriptions of the stopped run end.
    failing.criticalEvents.stream.closeSubscriptions("meeting-assistant-stopped");
    failing.criticalEvents.flush();
    expectEqual(await waiter.promise, { status: "closed", reason: "meeting-assistant-stopped", discarded: 0 }, "never-happening fact");
    expectEqual(failing.clock.timers.size, timers, "the observer added no timer");
    // After unmount the stream is released: nothing can be waited on.
    failing.criticalEvents.stream.release("meeting-hook-unmounted");
    const late = awaitRuntimeCriticalFact(failing.criticalEvents.stream, { matches: () => true });
    expectEqual(await late.promise, { status: "rejected", reason: "not-accepting" }, "released stream");
  } finally { failing.restore(); }
});

// ===========================================================================
// Task 178 LG, commit 2 (LG1, LG2, LG3, LG4): the selection reason in the trace
// and the graded summaries of the Relation and Type call sites.
//
// Real: the Hook's schedule, stage settles, Ordered operation binding and Voice
// foreground window, the Ordered operation, the candidate selector, the
// operation runtimes, the admission coordinator and the logger leaf.
// Controlled: the physical provider request, the clock and the sinks, as in the
// rest of this file, and the logger's delivery boundary (see the helper).
// Every entry read below was made by one of those production call sites.
// ===========================================================================

const lgEntries = (h) => h.diagnosticLog.entries();
const lgLines = (h) => lgEntries(h).map((entry) => `${entry.level} ${entry.event}`);
// Warnings and errors, from every layer that can log: there is no other.
const lgAlerts = (h) => lgEntries(h).filter((entry) => entry.level === "warn" || entry.level === "error");
const lgOf = (h, event) => lgEntries(h).filter((entry) => entry.event === event);
const lgStageReasons = (h) => [h.metadata.taskRelationChildAffinitySelectionReason,
  h.metadata.taskRelationParentAffinitySelectionReason, h.metadata.taskRelationSplitCanonicalSelectionReason];
// The stage selections of one operation as its own handle holds them: per stage
// [reason, tier selected], or null for a stage that ended with no selection.
const lgSelections = (handle) => ["childAffinity", "parentAffinity", "canonical"].map((stage) => {
  const selection = handle.stageSelections?.[stage];
  return selection ? [selection.selectionReason, selection.tierSelected] : null;
});
// The same three pairs as a formal summary carries them.
const lgSummarySelections = (summary) => ["child", "parent", "canonical"].map((stage) =>
  (`${stage}Selection` in summary.data || `${stage}TierSelected` in summary.data
    ? [summary.data[`${stage}Selection`], summary.data[`${stage}TierSelected`]] : null));
const lgPairs = (reasons, tiers) => reasons.map((reason, index) => (reason === undefined ? null : [reason, tiers[index]]));
const lgUsable = (summary) => [summary.data.childUsable, summary.data.parentUsable, summary.data.canonicalUsable];
// A stage is lost when its selector ended with no tier selected, at the deadline or with both candidates unusable.
const lgLost = (pair) => pair !== null && pair[1] === false && [DEADLINE, "candidates-ended-unusable"].includes(pair[0]);
// What a scenario's inputs hold and no entry may: provider error text (also
// given as an unparseable provider output), the transcript sentences of the
// question and of the active task, and a secret-shaped provider variable.
const LG_TEXTS = [...PLANTED_VALUES, QUESTION, PARENT];
const lgFailedOutcome = (failureClass) => ({ status: "failed", failureClass, safeErrorSummary: PLANTED.providerError });
function lgPlantSecret(h) {
  const resolveRoute = h.environment.resolveRuntimeInferenceModelRouteFromSnapshot;
  h.environment.resolveRuntimeInferenceModelRouteFromSnapshot = (input) => {
    const route = resolveRoute(input);
    return { ...route, selectedProvider: { ...route.selectedProvider,
      variables: { ...route.selectedProvider.variables, api_key: PLANTED.secret } } };
  };
}
// LG4 from the call sites of this file: each entry holds the ledger's fields
// alone, nothing planted reached one, the logger left nothing out and holds no
// timer, and it registered none on the harness clock.
function lgCheckEntries(h, label) {
  const entries = lgEntries(h);
  for (const entry of entries) assertEntryInLedger(entry, `${label}: ${entry.source} ${entry.event}`);
  assertNothingPlanted(entries, LG_TEXTS, label);
  const counters = h.diagnosticLog.snapshot();
  expectEqual([counters.refusedEntries, counters.refusedFields, counters.truncatedFields, counters.oversizeEntries,
    counters.detailFailures, counters.internalErrors, h.diagnosticLog.pendingTimers()], [0, 0, 0, 0, 0, 0, 0], `${label}: logger counters`);
  return entries;
}
// An abstention as the Affinity contract defines one: no evidence span and a stated ambiguity.
const PARENT_UNCLEAR = JSON.stringify({ v: 1, d: "u", c: 0.5, q: null, b: null, a: "insufficient-evidence" });
const DEADLINE = "candidate-deadline-expired";

// ---- LG3: the reason in the trace is the branch that ended the stage ----

// The Affinity stage of a formal operation, observed at its own terminal with no
// consumer attached. The stage settle of a formal operation logs nothing: its one
// summary is made where the Ordered operation writes its metadata.
for (const [name, spec, reason, expected] of [
  ["both candidates return invalid output", { drive: at(500, settleBothAffinity({ rawOutput: PLANTED.providerError })) },
    "candidates-ended-unusable", { at: 500, reason: "malformed-json", requests: 2 }],
  ["no candidate returns", {}, DEADLINE, { at: STAGE_MS, reason: DEADLINE, requests: 2 }],
  ["an invalid Intelligent is cached and Fast is silent until the deadline",
    { drive: at(700, (h) => completeCandidate(candidate(h, "affinity", "intelligent"), { rawOutput: PLANTED.providerError })) },
    DEADLINE, { at: STAGE_MS, reason: "malformed-json", requests: 2 }],
  ["a cached valid Fast is selected at the deadline", { drive: at(879, completeFastAffinity) },
    DEADLINE, { at: STAGE_MS, decision: "independent", settledAt: 10_879, requests: 2 }],
  ["an invalid Intelligent falls to the cached valid Fast before the deadline", { drive: async (h) => {
    await h.clock.advanceTo(879); completeFastAffinity(h);
    await h.clock.advanceTo(1_200); completeCandidate(candidate(h, "affinity", "intelligent"), { rawOutput: PLANTED.providerError });
  } }, "intelligent-invalid-fast-valid", { at: 1_200, decision: "independent", settledAt: 10_879, requests: 2 }],
  ["a timely valid Intelligent ends the stage at once", { drive: at(1_500, (h) => completeCandidate(
    candidate(h, "affinity", "intelligent"), { rawOutput: FAST_PARENT_INDEPENDENT })) },
    "intelligent-valid", { at: 1_500, decision: "independent", settledAt: 11_500, requests: 2 }],
  ["a parse-valid unclear Intelligent ends the stage at once", { drive: at(1_500, (h) => completeCandidate(
    candidate(h, "affinity", "intelligent"), { rawOutput: PARENT_UNCLEAR })) },
    "intelligent-valid", { at: 1_500, decision: "unclear", settledAt: 11_500, requests: 2 }],
  ["an exhausted admission queue dispatches nothing", { before: saturateAdmission },
    DEADLINE, { at: STAGE_MS, reason: DEADLINE, requests: 0 }],
  ["dispatch delayed past the deadline", { drive: (h) => { h.clock.now += 4_200; } },
    DEADLINE, { at: 4_200, reason: DEADLINE, requests: 0 }],
  ["an authentication failure", { drive: at(300, (h) => completeCandidate(candidate(h, "affinity", "fast"),
    { providerDisposition: "provider-auth-error", providerOutcome: lgFailedOutcome("authentication") })) },
    "client-error", { at: 300, reason: "not-run-provider-auth-error", clientError: true, requests: 2 }],
  // No selection, so no reason: the stage was cancelled, superseded or never ran.
  ["foreground cancellation", { drive: at(1_000, (_h, handle) => handle.cancelForegroundWork()) },
    undefined, { at: 1_000, reason: "operation-id-mismatch", requests: 2 }],
  ["Stop", { drive: at(1_000, stop) }, undefined, { at: 1_000, reason: "operation-id-mismatch", requests: 2 }],
  ["superseded by a newer question", { drive: at(1_000, (h) => { scheduleRelation(h, { unit: nextUnit() }); }) },
    undefined, { at: 1_000, reason: "operation-id-mismatch" }],
  ["provider circuit open", { runtime: { circuitOpen: true } },
    undefined, { at: 0, reason: "provider-circuit-open", clientError: true, requests: 0 }],
  ["an internal candidate failure", { drive: at(300, (h) => completeCandidate(candidate(h, "affinity", "fast"),
    { providerDisposition: "provider-error-content", providerOutcome: failedOutcome("unexpected") })) },
    undefined, { state: "rejected", at: 300, error: /summary-unexpected/, requests: 2 }],
]) {
  test(`LG3 Affinity stage reason in the trace: ${name}`, { concurrency: false }, async () => {
    const run = await affinityTerminal({ ...spec, before: async (h) => { lgPlantSecret(h); await spec.before?.(h); } });
    try {
      // The stage terminal itself is what it was: value, time and physical requests.
      expectAffinityTerminal(run, expected);
      // The trace holds the first operation's settle; a superseding question is another operation.
      if (name !== "superseded by a newer question") {
        expectEqual(run.h.metadata.taskRelationParentAffinitySelectionReason, reason, "selection reason in the trace");
        // Written once, by the stage settle, with the other stage facts.
        expectEqual(settlementCount(run.h, "taskRelationParentAffinitySelectionReason"),
          settlementCount(run.h, "taskRelationParentAffinityLeaseAuthorized"), "written with the stage settle");
      }
      expectEqual(lgCheckEntries(run.h, name), [], "a formal stage logs nothing at its own settle");
    } finally { run.h.restore(); }
  });
}

for (const [name, spec, reason, expected] of [
  ["a cached valid Fast is selected at the deadline", { drive: canonicalAt(900, (h) => completeCandidate(
    candidate(h, "canonical", "fast"), { rawOutput: canonicalOutput("followup-parent") })) },
    DEADLINE, { at: STAGE_MS, relation: "followup-parent", requests: 2 }],
  ["a timely valid Intelligent ends the stage at once", { drive: canonicalAt(1_500, (h) => completeCandidate(
    candidate(h, "canonical", "intelligent"), { rawOutput: canonicalOutput("new-parent") })) },
    "intelligent-valid", { at: 1_500, relation: "new-parent", requests: 2 }],
  ["a parse-valid unknown Intelligent ends the stage at once", { drive: canonicalAt(1_500, (h) => completeCandidate(
    candidate(h, "canonical", "intelligent"), { rawOutput: canonicalOutput("unknown") })) },
    "intelligent-valid", { at: 1_500, relation: "unknown", requests: 2 }],
  ["both candidates return invalid output", { drive: canonicalAt(500, settleBothCanonical({ rawOutput: PLANTED.providerError })) },
    "candidates-ended-unusable", { at: 500, reason: "malformed-json", requests: 2 }],
  ["no candidate returns", {}, DEADLINE, { at: STAGE_MS, reason: DEADLINE, requests: 2 }],
  ["an exhausted admission queue dispatches nothing", { beforeStart: saturateAdmission },
    DEADLINE, { at: STAGE_MS, reason: DEADLINE, requests: 0 }],
  ["an authentication failure", { drive: canonicalAt(300, (h) => completeCandidate(candidate(h, "canonical", "intelligent"),
    { providerDisposition: "provider-auth-error", providerOutcome: lgFailedOutcome("authentication") })) },
    "client-error", { at: 300, reason: "not-run-provider-auth-error", clientError: true, requests: 2 }],
  ["Stop", { drive: canonicalAt(1_000, stop) }, undefined, { at: 1_000, reason: "operation-id-mismatch", requests: 2 }],
  ["foreground window already closed", { beforeStart: (_h, handle) => handle.cancelForegroundWork() },
    undefined, { at: 0, reason: "foreground-window-closed", requests: 0 }],
]) {
  test(`LG3 Canonical stage reason in the trace: ${name}`, { concurrency: false }, async () => {
    const run = await canonicalTerminal(spec);
    try {
      expectCanonicalTerminal(run, expected);
      expectEqual(run.h.metadata.taskRelationSplitCanonicalSelectionReason, reason, "selection reason in the trace");
      // The Affinity stage of this run ended with both candidates invalid.
      expectEqual(run.h.metadata.taskRelationParentAffinitySelectionReason, "candidates-ended-unusable", "Affinity reason");
      expectEqual(lgCheckEntries(run.h, name), [], "a formal stage logs nothing at its own settle");
    } finally { run.h.restore(); }
  });
}

// ---- LG1 and LG3: one summary per formal Relation operation, graded by its outcome ----

// Each row runs one formal operation through the entry's real consumer. `business`
// is what the consumer ends with, stated as the ST183-4 rows state it, so the
// summary is read next to the unchanged result, dispositions and request count.
const lgValidCanonical = (relation) => (h) => completeCandidate(candidate(h, "canonical", "intelligent"), { rawOutput: canonicalOutput(relation) });
const lgIntelligentAffinity = (rawOutput) => (h) => completeCandidate(candidate(h, "affinity", "intelligent"), { rawOutput });
const LG_FORMAL_ROWS = [
  // Timeout table 3.1, row 2: no usable candidate, confirmed at the stage deadlines.
  { name: "Timeout 2: both stages end at their deadline with nothing usable", level: "warn", lostAll: true,
    spec: () => ({ endsAt: 2 * STAGE_MS, script: [
      [4_050, (h) => completeCandidate(candidate(h, "affinity", "fast"), { rawOutput: FAST_PARENT_INDEPENDENT })]] }),
    business: { terminal: "resolved", stage: NULL_HYPOTHESIS, parent: DEADLINE, canonical: DEADLINE, requests: 4 },
    selections: [undefined, DEADLINE, DEADLINE], tiers: [undefined, false, false], usable: [false, false, false], deadlineFinalized: true },
  { name: "the admission queue is exhausted in both stages and nothing is dispatched", level: "warn", lostAll: true,
    spec: () => ({ endsAt: 2 * STAGE_MS, before: saturateAdmission }),
    business: { terminal: "resolved", stage: NULL_HYPOTHESIS, parent: DEADLINE, canonical: DEADLINE, requests: 0 },
    selections: [undefined, DEADLINE, DEADLINE], tiers: [undefined, false, false], usable: [false, false, false], deadlineFinalized: true },
  { name: "an invalid Intelligent is cached, Fast is silent, and Canonical is silent", level: "warn", lostAll: true,
    spec: () => ({ endsAt: 2 * STAGE_MS, script: [[700, lgIntelligentAffinity(PLANTED.providerError)]] }),
    // The recorded parse reason is the cached candidate's; only the selection reason names the deadline.
    business: { terminal: "resolved", stage: NULL_HYPOTHESIS, parent: "malformed-json", canonical: DEADLINE, requests: 4 },
    selections: [undefined, DEADLINE, DEADLINE], tiers: [undefined, false, false], usable: [false, false, false], deadlineFinalized: true },
  { name: "both candidates end unusable in both stages, before any deadline", level: "warn", lostAll: true,
    spec: () => ({ endsAt: 700, script: [[500, settleBothAffinity({ rawOutput: PLANTED.providerError })],
      [700, settleBothCanonical({ rawOutput: PLANTED.providerError })]] }),
    business: { terminal: "resolved", stage: NULL_HYPOTHESIS, parent: "malformed-json", canonical: "malformed-json", requests: 4 },
    selections: [undefined, "candidates-ended-unusable", "candidates-ended-unusable"], tiers: [undefined, false, false],
    usable: [false, false, false] },
  { name: "an authentication failure in the Affinity stage", level: "warn", lostAll: true, clientError: true,
    spec: () => ({ endsAt: 300, script: [[300, (h) => completeCandidate(candidate(h, "affinity", "fast"),
      { providerDisposition: "provider-auth-error", providerOutcome: lgFailedOutcome("authentication") })]] }),
    business: { terminal: "client-error", parent: "not-run-provider-auth-error", canonical: undefined, requests: 2 },
    // The selector ends the stage on the candidate that failed, so that tier is the selected one.
    selections: [undefined, "client-error", undefined], tiers: [undefined, true, undefined], usable: [false, false, false] },
  { name: "an open provider circuit: no stage runs", level: "warn", lostAll: true, clientError: true,
    spec: (startsAt) => ({ endsAt: startsAt, runtime: { circuitOpen: true } }),
    business: { terminal: "client-error", parent: "provider-circuit-open", canonical: undefined, requests: 0 },
    selections: [undefined, undefined, undefined], tiers: [undefined, undefined, undefined], usable: [false, false, false] },
  // Timeout table 3.1, row 1: the Intelligent stage expires and a timely Fast settles normally.
  { name: "Timeout 1: a timely Fast is selected at the deadline in both stages", level: "debug",
    spec: () => ({ endsAt: 2 * STAGE_MS, script: [[879, completeFastAffinity],
      [STAGE_MS + 600, (h) => completeCandidate(candidate(h, "canonical", "fast"), { rawOutput: canonicalOutput("followup-parent") })]] }),
    business: { terminal: "resolved", stage: "canonical-relation", parent: "available", canonical: "available", requests: 4 },
    selections: [undefined, DEADLINE, DEADLINE], tiers: [undefined, true, true], usable: [false, true, true], deadlineFinalized: true },
  // Controls: a parse-valid abstention is a model result.
  { name: "control: a parse-valid unknown Canonical after a valid Affinity", level: "debug",
    spec: () => ({ endsAt: 1_300, script: [[300, lgIntelligentAffinity(FAST_PARENT_INDEPENDENT)], [1_300, lgValidCanonical("unknown")]] }),
    business: { terminal: "resolved", parent: "available", canonical: "available", requests: 4,
      source: { voice: ["runtime-matrix", "same-type-independent-new-parent", "new-parent"],
        screen: ["runtime-matrix", "same-type-independent-new-parent", "new-parent"] } },
    selections: [undefined, "intelligent-valid", "intelligent-valid"], tiers: [undefined, true, true], usable: [false, true, true] },
  { name: "control: a parse-valid unclear Affinity and a parse-valid unknown Canonical end at the null hypothesis", level: "debug",
    spec: () => ({ endsAt: 1_300, script: [[300, lgIntelligentAffinity(PARENT_UNCLEAR)], [1_300, lgValidCanonical("unknown")]] }),
    business: { terminal: "resolved", stage: NULL_HYPOTHESIS, parent: "available", canonical: "available", requests: 4 },
    selections: [undefined, "intelligent-valid", "intelligent-valid"], tiers: [undefined, true, true], usable: [false, true, true] },
  // The mixed case, which the brief does not grade: one stage usable, another lost at its deadline. One row for each
  // stage that can be the usable one.
  { name: "not graded: a valid Affinity is used and Canonical is lost at its deadline", level: "debug",
    spec: () => ({ endsAt: 300 + STAGE_MS, script: [[300, lgIntelligentAffinity(FAST_PARENT_INDEPENDENT)]] }),
    business: { terminal: "resolved", parent: "available", canonical: DEADLINE, requests: 4 },
    selections: [undefined, "intelligent-valid", DEADLINE], tiers: [undefined, true, false], usable: [false, true, false],
    deadlineFinalized: true, notGraded: "relation-mixed" },
  { name: "not graded: Affinity is lost at its deadline and a valid Canonical is used", level: "debug",
    spec: () => ({ endsAt: STAGE_MS + 600, script: [[STAGE_MS + 600, lgValidCanonical("new-parent")]] }),
    business: { terminal: "resolved", stage: "canonical-relation", parent: DEADLINE, canonical: "available", requests: 4 },
    selections: [undefined, DEADLINE, "intelligent-valid"], tiers: [undefined, false, true], usable: [false, false, true],
    deadlineFinalized: true, notGraded: "relation-mixed" },
  { name: "not graded: with an active Child, a valid child Affinity is used and the parent Affinity and Canonical are lost at their deadlines",
    level: "debug",
    spec: () => ({ child: true, endsAt: 2 * STAGE_MS, script: [
      [300, (h) => completeCandidate(sideCandidate(h, "child", "intelligent"), { rawOutput: FAST_CHILD_UNRELATED })]] }),
    business: { terminal: "resolved", child: "available", parent: DEADLINE, canonical: DEADLINE, requests: 6 },
    selections: ["intelligent-valid", DEADLINE, DEADLINE], tiers: [true, false, false], usable: [true, false, false],
    deadlineFinalized: true, notGraded: "relation-mixed" },
];
for (const entry of ["voice", "screen"]) for (const row of LG_FORMAL_ROWS) {
  test(`LG1 LG3 ${entry} formal Relation, ${row.name}: one ${row.level} summary, the real reasons, and the result and request count it had`, { concurrency: false }, async () => {
    const spec = row.spec(entry === "voice" ? 50 : 0);
    const run = await runConsumerWait({ entry, ...spec, before: async (h) => { lgPlantSecret(h); await spec.before?.(h); } });
    const { h } = run;
    try {
      // The consumer's own result first: terminal, final source, stage dispositions, physical requests.
      expectWaitOutcome(run, entry, row.business);
      const entries = lgCheckEntries(h, row.name);
      // Voice also reports its foreground window when the deadline finalizes the turn; Type had settled, so that is debug.
      expectEqual(lgLines(h), [`${row.level} formal-operation-settled`,
        ...(entry === "voice" && row.deadlineFinalized ? ["debug foreground-deadline-finalized"] : [])], "entries, in order");
      // One failure, one report: no other layer raises it again.
      expectEqual(lgAlerts(h).length, row.lostAll ? 1 : 0, "warnings and errors from every layer");
      expectEqual(lgStageReasons(h), row.selections, "selection reasons in the trace");
      const summary = entries[0];
      expectEqual(summary.refs, { traceId: "trace" }, "references");
      // Per stage the summary names the selector's reason and whether it selected a tier, as this operation's own
      // handle holds them, and whether the stage was usable.
      const pairs = lgPairs(row.selections, row.tiers);
      expectEqual(lgSummarySelections(summary), pairs, "the summary names each stage's reason and whether a tier was selected");
      expectEqual(lgSelections(run.handle), pairs, "the stage selections of the operation's own handle");
      expectEqual(lgUsable(summary), row.usable, "usable stages");
      expectEqual([summary.data.sourceKind, summary.data.operationAuthorized, summary.data.clientError, summary.data.stage],
        [entry, true, Boolean(row.clientError), h.metadata.taskRelationOrderedResolutionStage], "the summary's own outcome fields");
      expectEqual(summary.data.waitMs, h.metadata.taskRelationOrderedResolutionWaitMs, "wait");
      // The entry holds no dispatch claim: the same summary is made with four requests dispatched and with none.
      expectEqual(Object.keys(summary.data).filter((key) => /dispatch|request/i.test(key)), [], "no dispatch field");
      // The rule, read off the row: a warning exactly when no stage was usable and the operation recorded a client
      // error or lost at least one stage. Nothing else of the row grades it.
      expectEqual(row.level === "warn", !row.usable.some(Boolean) && (Boolean(row.clientError) || pairs.some(lgLost)), "the level follows the rule");
      expectEqual(row.lostAll, row.level === "warn" ? true : undefined, "row definition");
      if (row.notGraded) expectEqual([notGraded(row.notGraded).entry, row.level], ["debug", "debug"], "listed as not graded");
    } finally { h.restore(); }
  });
}

// Correction enters the shared chain when its Type adjudication ends (600 ms).
for (const row of LG_FORMAL_ROWS.filter((candidateRow) => candidateRow.name.includes("admission queue") ||
  candidateRow.name.startsWith("both candidates end unusable"))) {
  test(`LG1 LG3 correction formal Relation, ${row.name}: one ${row.level} summary`, { concurrency: false }, async () => {
    const spec = row.spec(600);
    const run = await runConsumerWait({ entry: "correction", ...spec, endsAt: row.name.includes("admission") ? 2 * STAGE_MS : 700,
      before: async (h) => { lgPlantSecret(h); await spec.before?.(h); } });
    try {
      expectWaitOutcome(run, "correction", row.business);
      const entries = lgCheckEntries(run.h, row.name);
      expectEqual(lgLines(run.h), ["warn formal-operation-settled"], "entries");
      expectEqual([entries[0].data.parentSelection, entries[0].data.canonicalSelection], row.selections.slice(1), "stage reasons");
    } finally { run.h.restore(); }
  });
}

// A turn that lost all its model evidence is a warning whichever stage then
// settled the relation (decisions A6). With an active Child the runtime matrix
// settles it from the question types: the resolution stage is "runtime-matrix"
// and the summary is still the one warning, naming the three lost stages.
for (const entry of ["voice", "screen"]) {
  test(`LG1 LG3 ${entry} formal Relation with an active Child, every stage lost to an exhausted admission queue and settled by the runtime matrix: one warn summary that names the three lost stages`, { concurrency: false }, async () => {
    const run = await runConsumerWait({ entry, child: true, endsAt: 2 * STAGE_MS, before: saturateAdmission });
    try {
      expectWaitOutcome(run, entry, { terminal: "resolved", child: DEADLINE, parent: DEADLINE, canonical: DEADLINE, requests: 0,
        source: { voice: ["runtime-matrix", "active-child-preserve-child", "child-probe"],
          screen: ["runtime-matrix", "type-location-unresolved", undefined] } });
      lgCheckEntries(run.h, "active Child");
      const summaries = lgOf(run.h, "formal-operation-settled");
      expectEqual(summaries.map((summary) => summary.level), ["warn"], "one warn summary");
      expectEqual(lgAlerts(run.h).length, 1, "warnings and errors from every layer");
      expectEqual([summaries[0].data.stage, lgSummarySelections(summaries[0]), lgUsable(summaries[0])],
        ["runtime-matrix", [[DEADLINE, false], [DEADLINE, false], [DEADLINE, false]], [false, false, false]], "summary");
      expectEqual(lgSelections(run.handle), lgSummarySelections(summaries[0]), "the stage selections of the operation's own handle");
    } finally { run.h.restore(); }
  });
}

// The same loss in every row: an exhausted admission queue, so each stage ends
// at its deadline and no request is dispatched. Only the current question type
// and the active Child differ, and with them the stage that settles the
// relation: the null hypothesis in four rows and the runtime matrix in six. The
// level is the same in all ten. The Hook's binding is called directly so the row
// can name the type.
const LG_TYPE_ROWS = [
  ["coding", false, [NULL_HYPOTHESIS, "voice-preserve-active-parent", "followup-parent"]],
  ["project", false, [NULL_HYPOTHESIS, "voice-preserve-active-parent", "followup-parent"]],
  ["unknown", false, [NULL_HYPOTHESIS, "voice-preserve-active-parent", "followup-parent"]],
  ["unknown", true, [NULL_HYPOTHESIS, "voice-preserve-active-child", "child-probe"]],
  ["behavioral", false, ["runtime-matrix", "type-excludes-existing-tree", "new-parent"]],
  ["system-design", false, ["runtime-matrix", "type-excludes-existing-tree", "new-parent"]],
  ["field-knowledge", false, ["runtime-matrix", "type-excludes-existing-tree", "new-parent"]],
  ["coding", true, ["runtime-matrix", "type-location-unresolved", undefined]],
  ["field-knowledge", true, ["runtime-matrix", "active-child-preserve-child", "child-probe"]],
  ["behavioral", true, ["runtime-matrix", "type-excludes-existing-tree", "new-parent"]],
];
for (const [type, child, source] of LG_TYPE_ROWS) {
  test(`LG1 LG3 formal Relation, every stage lost, current type ${type}, ${child ? "active Child" : "parent only"}: warn, settled by ${source[0]} (${source[1]})`, { concurrency: false }, async () => {
    const h = st183Harness({ child });
    try {
      saturateAdmission(h);
      const handle = scheduleEntry(h, "voice");
      const wait = watch(h, h.environment.resolveOrderedTaskRelationWithinWindow({ handle, traceId: "trace", currentQuestionType: type,
        sourceKind: "voice", activeMeetingTask: h.environment.contextManagerRef.current.getState().activeMeetingTask, waitBudgetMs: 8_000 }));
      await h.clock.advanceTo(2 * STAGE_MS + 100);
      expectEqual([wait.state, wait.value?.terminalDisposition, h.executions.length], ["resolved", "resolved", 0],
        "the operation and its physical requests");
      expectEqual([h.metadata.taskRelationOrderedResolutionStage, h.metadata.taskRelationOrderedResolutionReason,
        h.metadata.taskRelationOrderedResolutionRelation], source, "final Relation source");
      expectEqual([h.metadata.taskRelationOrderedResolutionAffinityChildDisposition, h.metadata.taskRelationOrderedResolutionAffinityParentDisposition,
        h.metadata.taskRelationOrderedResolutionCanonicalDisposition], [child ? DEADLINE : "no-active-child", DEADLINE, DEADLINE],
      "recorded stage dispositions");
      const entries = lgCheckEntries(h, `${type} ${child}`);
      expectEqual(lgLines(h), ["warn formal-operation-settled"], "entries");
      expectEqual(lgAlerts(h).length, 1, "warnings and errors from every layer");
      expectEqual([entries[0].data.stage, entries[0].data.reason, lgSummarySelections(entries[0]), lgUsable(entries[0])],
        [source[0], source[1], [child ? [DEADLINE, false] : null, [DEADLINE, false], [DEADLINE, false]], [false, false, false]], "summary");
    } finally { h.restore(); }
  });
}

// A client error is a warning for every question type as well. With an open provider circuit no stage runs and no
// stage has a selection: the operation's own client error makes the warning, whichever stage carries the decision
// that is then never applied.
test("LG1 formal Relation with an open provider circuit: one warn summary for every current question type and Child combination, with the null hypothesis and with the runtime matrix; the operation ends as a client error each time", { concurrency: false }, async () => {
  const stages = [];
  for (const [type, child] of LG_TYPE_ROWS) {
    const h = st183Harness({ child, runtime: { circuitOpen: true } });
    try {
      const handle = scheduleEntry(h, "voice");
      const wait = watch(h, h.environment.resolveOrderedTaskRelationWithinWindow({ handle, traceId: "trace", currentQuestionType: type,
        sourceKind: "voice", activeMeetingTask: h.environment.contextManagerRef.current.getState().activeMeetingTask, waitBudgetMs: 8_000 }));
      await h.clock.advanceTo(100);
      const name = `circuit open ${type} ${child ? "active Child" : "parent only"}`;
      expectEqual([wait.state, wait.value?.terminalDisposition, h.executions.length, h.metadata.taskRelationOrderedResolutionClientError],
        ["resolved", "client-error", 0, true], `the operation, ${name}`);
      const entries = lgCheckEntries(h, name);
      expectEqual(lgLines(h), ["warn formal-operation-settled"], `entries, ${name}`);
      expectEqual([entries[0].data.clientError, entries[0].data.stage, lgSummarySelections(entries[0]), lgSelections(handle), lgUsable(entries[0])],
        [true, h.metadata.taskRelationOrderedResolutionStage, [null, null, null], [null, null, null], [false, false, false]], `summary, ${name}`);
      stages.push(entries[0].data.stage);
    } finally { h.restore(); }
  }
  // Both resolution stages occur among the ten: the stage does not grade.
  expectEqual([...new Set(stages)].sort(), ["runtime-matrix", NULL_HYPOTHESIS].sort(), "resolution stages seen");
});

// The ledger says what the entry does not: a client error is a warning here, not an error.
test("LG1 formal Relation client error: the ledger lists as a known limit that it is a warning although Voice then shows a configuration error", () => {
  const row = ledgerRowOf({ source: "meeting.relation", event: "formal-operation-settled" });
  expectEqual([row.levels, row.knownLimits.some((limit) => /client error is warn/.test(limit))], [["warn", "debug"], true], "ledger row");
});

// ---- LG1 controls: stages cancelled or superseded while the operation itself stays authorized ----

// Dispose (application shutdown and unmount) cancels the stage runtimes and
// leaves the question's source lease alone, so the Ordered operation settles
// authorized with no usable stage, and with no Child at the null hypothesis.
// No stage was ended by its selector, so no stage settle wrote a selection:
// nothing was lost to a deadline, to unusable candidates or to a client error,
// and the summary is debug.
for (const path of DISPOSE_PATHS) for (const entry of ["voice", "screen", "correction"]) for (const child of [false, true]) {
  test(`LG1 control ${path} with a formal ${entry} operation and an observation in flight, ${child ? "child+parent" : "parent-only"}: zero warn or error; the formal summary is debug with the operation authorized and no selection reason`, { concurrency: false }, async () => {
    const run = await runDisposeInFlight({ path, entry, child, crossChecks: true });
    const { h } = run;
    try {
      // What the operation recorded: authorized, and each stage ended on the lease reason of cancelled work.
      expectEqual([h.metadata.taskRelationOrderedResolutionOperationAuthorized, h.metadata.taskRelationOrderedResolutionAffinityParentDisposition,
        h.metadata.taskRelationOrderedResolutionCanonicalDisposition], [true, "operation-id-mismatch", "operation-id-mismatch"],
      "recorded authorization and stage dispositions");
      if (!child) expectEqual(h.metadata.taskRelationOrderedResolutionStage, NULL_HYPOTHESIS, "final Relation source");
      expectEqual(lgStageReasons(h), [undefined, undefined, undefined], "selection reasons in the trace");
      lgCheckEntries(h, `${path} ${entry}`);
      expectEqual(lgAlerts(h), [], "warnings and errors");
      const summaries = lgOf(h, "formal-operation-settled");
      expectEqual(summaries.map((summary) => [summary.level, summary.refs.traceId]), [["debug", "trace"]], "one debug summary");
      expectEqual([summaries[0].data.operationAuthorized, summaries[0].data.stage, lgUsable(summaries[0]), lgSummarySelections(summaries[0])],
        [true, h.metadata.taskRelationOrderedResolutionStage, [false, false, false], [null, null, null]], "summary");
      // The observation beside it ended the same way, stage by stage.
      expectEqual(lgOf(h, "observation-stage-settled").map((settled) => [settled.level, settled.refs.traceId, settled.data.stage,
        settled.data.current, settled.data.selection ?? null]),
      [...(child ? ["child-affinity"] : []), "parent-affinity", "canonical"].map((stage) => ["debug", OBSERVED_TRACE, stage, false, null]),
      "observation stage entries");
    } finally { h.restore(); }
  });
}

// Latest-wins across sources. The Relation runtimes hold one operation each, so
// a Screen operation scheduled while a Voice operation is in flight supersedes
// the Voice stages. The Voice question's own lease stays current: its Ordered
// operation settles authorized, at the null hypothesis, with no usable stage.
function lgTwoSources(h, { secondAt, secondTraceId = "trace-b" }) {
  const activeMeetingTask = () => h.environment.contextManagerRef.current.getState().activeMeetingTask;
  const first = scheduleRelation(h, { sourceKind: "voice", traceId: "trace" });
  const waitFirst = watch(h, h.environment.resolveOrderedTaskRelationWithinWindow({ handle: first, traceId: "trace",
    currentQuestionType: "coding", sourceKind: "voice", activeMeetingTask: activeMeetingTask(), waitBudgetMs: 8_000 }));
  const second = {};
  h.clock.setTimeout(() => {
    second.dispatchedBefore = h.executions.length;
    second.handle = scheduleRelation(h, { sourceKind: "screen", unit: { ...logicalQuestionUnit, id: "lqu-screen-b" }, traceId: secondTraceId });
    second.wait = watch(h, h.environment.resolveOrderedTaskRelationWithinWindow({ handle: second.handle, traceId: secondTraceId,
      currentQuestionType: "coding", sourceKind: "screen", activeMeetingTask: activeMeetingTask(), waitBudgetMs: 8_000 }));
  }, secondAt);
  return { first, waitFirst, second };
}
const lgOfSecond = (h, stage, tier) => h.executions.filter((execution) => execution.request.operationKind.includes(stage) &&
  execution.request.identity.logicalQuestionUnitId === "lqu-screen-b" && tierOf(execution) === tier);
const lgSummaryRows = (h) => lgOf(h, "formal-operation-settled").map((summary) => [summary.level, summary.refs.traceId,
  summary.data.operationAuthorized, summary.data.stage, summary.data.parentSelection ?? null, summary.data.canonicalSelection ?? null]);

test("LG1 control latest-wins across sources: a Voice operation whose two stages are superseded by a Screen operation is debug, and the Screen operation that resolves from model evidence is debug", { concurrency: false }, async () => {
  const h = st183Harness();
  try {
    const { waitFirst, second } = lgTwoSources(h, { secondAt: 1_000 });
    await h.clock.advanceTo(1_100);
    for (const execution of lgOfSecond(h, "affinity", "intelligent")) completeCandidate(execution, { rawOutput: FAST_PARENT_INDEPENDENT });
    await h.clock.advanceTo(1_300);
    for (const execution of lgOfSecond(h, "canonical", "intelligent")) completeCandidate(execution, { rawOutput: canonicalOutput("new-parent") });
    await h.clock.advanceTo(1_000 + 3 * STAGE_MS);
    // The Voice operation: still authorized, both stages cancelled, settled at the null hypothesis at 1100 ms.
    expectEqual([waitFirst.state, waitFirst.at, waitFirst.value?.terminalDisposition, waitFirst.value?.operationAuthorization?.authorized,
      waitFirst.value?.metadata?.taskRelationOrderedResolutionAffinityParentDisposition,
      waitFirst.value?.metadata?.taskRelationOrderedResolutionCanonicalDisposition, waitFirst.value?.metadata?.taskRelationOrderedResolutionStage],
    ["resolved", 1_100, "resolved", true, "operation-id-mismatch", "operation-id-mismatch", NULL_HYPOTHESIS], "the superseded Voice operation");
    expectEqual([second.wait.state, second.wait.at, second.wait.value?.terminalDisposition,
      second.wait.value?.metadata?.taskRelationOrderedResolutionStage], ["resolved", 1_300, "resolved", "canonical-relation"],
    "the Screen operation");
    // Every physical request of the Voice operation was aborted by the supersession, none by a deadline.
    expectEqual(h.executions.filter((execution) => execution.request.identity.logicalQuestionUnitId === logicalQuestionUnit.id)
      .map((execution) => [execution.request.operationKind, tierOf(execution), execution.dispatchedAt - 10_000, execution.signal.aborted]),
    [["task-relation-parent-affinity", "intelligent", 0, true], ["task-relation-parent-affinity", "fast", 0, true],
      ["task-relation-canonical-shadow", "intelligent", 1_000, true], ["task-relation-canonical-shadow", "fast", 1_000, true]],
    "the Voice operation's physical requests");
    lgCheckEntries(h, "cross-source supersession");
    expectEqual(lgAlerts(h), [], "warnings and errors");
    expectEqual(lgSummaryRows(h), [["debug", "trace", true, NULL_HYPOTHESIS, null, null],
      ["debug", "trace-b", true, "canonical-relation", "intelligent-valid", "intelligent-valid"]], "summaries, in order");
  } finally { h.restore(); }
});

test("LG1 latest-wins across sources: the superseded Voice operation is debug and the superseding Screen operation, which then loses both stages at their deadlines, is the one warning", { concurrency: false }, async () => {
  const h = st183Harness();
  try {
    const { waitFirst, second } = lgTwoSources(h, { secondAt: 1_000 });
    await h.clock.advanceTo(1_000 + 3 * STAGE_MS);
    expectEqual([waitFirst.state, waitFirst.value?.operationAuthorization?.authorized, waitFirst.value?.metadata?.taskRelationOrderedResolutionStage],
      ["resolved", true, NULL_HYPOTHESIS], "the superseded Voice operation");
    expectEqual([second.wait.state, second.wait.at, second.wait.value?.metadata?.taskRelationOrderedResolutionStage],
      ["resolved", 1_000 + 2 * STAGE_MS, NULL_HYPOTHESIS], "the Screen operation");
    lgCheckEntries(h, "superseded, then lost");
    expectEqual(lgSummaryRows(h), [["debug", "trace", true, NULL_HYPOTHESIS, null, null],
      ["warn", "trace-b", true, NULL_HYPOTHESIS, DEADLINE, DEADLINE]], "summaries, in order");
    expectEqual(lgAlerts(h).length, 1, "warnings and errors");
  } finally { h.restore(); }
});

// The reverse order. The Voice Affinity is superseded by a Screen operation that is cancelled before it starts its
// own Canonical, so the Voice Canonical runs on. The disposition the operation records for that stage is the
// predecessor mismatch either way, since the Affinity it follows was superseded. What grades is what its selector
// ended with: no tier selected at the deadline is a lost stage and a warning; a parse-valid Fast selected at that
// deadline is a stage that selected a tier, unusable only because of the supersession, and debug (next test).
test("LG1 a Voice operation whose Affinity stage was superseded and whose Canonical stage then ran to its deadline is a warning by the Canonical reason; the cancelled Screen operation is debug", { concurrency: false }, async () => {
  const h = st183Harness();
  try {
    const { waitFirst, second } = lgTwoSources(h, { secondAt: 1_000 });
    await h.clock.advanceTo(1_050);
    second.handle.cancelForegroundWork();
    await h.clock.advanceTo(1_000 + 2 * STAGE_MS);
    expectEqual([waitFirst.state, waitFirst.at, waitFirst.value?.operationAuthorization?.authorized,
      waitFirst.value?.metadata?.taskRelationOrderedResolutionAffinityParentDisposition,
      waitFirst.value?.metadata?.taskRelationOrderedResolutionCanonicalDisposition, waitFirst.value?.metadata?.taskRelationOrderedResolutionStage],
    ["resolved", 1_000 + STAGE_MS, true, "operation-id-mismatch", "parent-predecessor-operation-mismatch", NULL_HYPOTHESIS], "the Voice operation");
    expectEqual([h.metadata.taskRelationParentAffinitySelectionReason, h.metadata.taskRelationSplitCanonicalSelectionReason,
      h.executions.filter((execution) => execution.request.operationKind.includes("canonical")).map((execution) =>
        [execution.request.identity.logicalQuestionUnitId, tierOf(execution), execution.dispatchedAt - 10_000])],
    [undefined, DEADLINE, [[logicalQuestionUnit.id, "intelligent", 1_000], [logicalQuestionUnit.id, "fast", 1_000]]],
    "selection reasons in the trace, and the Canonical requests that were dispatched");
    expectEqual([second.wait.state, second.wait.at, second.wait.value?.operationAuthorization?.authorized,
      second.wait.value?.metadata?.taskRelationOrderedResolutionCanonicalDisposition, second.wait.value?.metadata?.taskRelationOrderedResolutionStage],
    ["resolved", 1_050, true, "foreground-window-closed", NULL_HYPOTHESIS], "the cancelled Screen operation");
    lgCheckEntries(h, "superseded, then lost at the Canonical deadline");
    expectEqual(lgSummaryRows(h), [["debug", "trace-b", true, NULL_HYPOTHESIS, null, null],
      ["warn", "trace", true, NULL_HYPOTHESIS, null, DEADLINE]], "summaries, in order");
    expectEqual(lgOf(h, "formal-operation-settled").map(lgSummarySelections), [[null, null, null], [null, null, [DEADLINE, false]]],
      "stage selections in the summaries");
    expectEqual(lgAlerts(h).length, 1, "warnings and errors");
  } finally { h.restore(); }
});

test("LG1 a Voice operation whose Affinity stage was superseded and whose Canonical stage selected a parse-valid Fast at its deadline is debug: the stage selected a tier and its result is unusable only because its predecessor was superseded", { concurrency: false }, async () => {
  const h = st183Harness();
  try {
    const { first, waitFirst, second } = lgTwoSources(h, { secondAt: 1_000 });
    await h.clock.advanceTo(1_050);
    second.handle.cancelForegroundWork();
    await h.clock.advanceTo(2_000);
    // The Voice Canonical is the only Canonical that started: its Fast candidate answers with valid output.
    completeCandidate(candidate(h, "canonical", "fast"), { rawOutput: canonicalOutput("followup-parent") });
    await h.clock.advanceTo(1_000 + 2 * STAGE_MS);
    expectEqual([waitFirst.state, waitFirst.at, waitFirst.value?.operationAuthorization?.authorized,
      waitFirst.value?.metadata?.taskRelationOrderedResolutionAffinityParentDisposition,
      waitFirst.value?.metadata?.taskRelationOrderedResolutionCanonicalDisposition, waitFirst.value?.metadata?.taskRelationOrderedResolutionStage],
    ["resolved", 1_000 + STAGE_MS, true, "operation-id-mismatch", "parent-predecessor-operation-mismatch", NULL_HYPOTHESIS], "the Voice operation");
    // What the stage recorded: a parse-valid Fast, selected at the deadline, and discarded for its predecessor.
    expectEqual([h.metadata.taskRelationSplitCanonicalSelectedProviderTier, h.metadata.taskRelationSplitCanonicalParseDisposition,
      h.metadata.taskRelationSplitCanonicalSelectionReason, h.metadata.taskRelationSplitCanonicalDisposition,
      h.metadata.taskRelationParentAffinitySelectionReason],
    ["fast", "valid-json", DEADLINE, "parent-predecessor-operation-mismatch", undefined], "the Canonical stage in the trace");
    expectEqual(lgSelections(first), [null, null, [DEADLINE, true]], "the stage selections of the Voice handle");
    lgCheckEntries(h, "superseded, then a valid Fast at the Canonical deadline");
    expectEqual(lgSummaryRows(h), [["debug", "trace-b", true, NULL_HYPOTHESIS, null, null],
      ["debug", "trace", true, NULL_HYPOTHESIS, null, DEADLINE]], "summaries, in order");
    expectEqual(lgOf(h, "formal-operation-settled").map((summary) => [lgSummarySelections(summary), lgUsable(summary)]),
      [[[null, null, null], [false, false, false]], [[null, null, [DEADLINE, true]], [false, false, false]]], "stage selections and usable stages");
    expectEqual(lgAlerts(h), [], "warnings and errors");
  } finally { h.restore(); }
});

// Not cancelled only. The Voice Affinity really ended at its deadline with
// nothing usable; its Canonical was then superseded by the Screen operation. A
// stage was lost to its deadline, so this is a warning: only an operation whose
// stages were all cancelled is debug.
test("LG1 a Voice operation that lost its Affinity stage at the deadline and whose Canonical stage was then superseded is a warning that names both", { concurrency: false }, async () => {
  const h = st183Harness();
  try {
    const { waitFirst, second } = lgTwoSources(h, { secondAt: STAGE_MS + 500 });
    await h.clock.advanceTo(STAGE_MS + 600);
    for (const execution of lgOfSecond(h, "affinity", "intelligent")) completeCandidate(execution, { rawOutput: FAST_PARENT_INDEPENDENT });
    await h.clock.advanceTo(STAGE_MS + 800);
    for (const execution of lgOfSecond(h, "canonical", "intelligent")) completeCandidate(execution, { rawOutput: canonicalOutput("new-parent") });
    await h.clock.advanceTo(4 * STAGE_MS);
    expectEqual([waitFirst.state, waitFirst.at, waitFirst.value?.operationAuthorization?.authorized,
      waitFirst.value?.metadata?.taskRelationOrderedResolutionAffinityParentDisposition,
      waitFirst.value?.metadata?.taskRelationOrderedResolutionCanonicalDisposition, waitFirst.value?.metadata?.taskRelationOrderedResolutionStage],
    ["resolved", STAGE_MS + 600, true, DEADLINE, "operation-id-mismatch", NULL_HYPOTHESIS], "the Voice operation");
    expectEqual([second.wait.state, second.wait.value?.metadata?.taskRelationOrderedResolutionStage], ["resolved", "canonical-relation"],
      "the Screen operation");
    lgCheckEntries(h, "lost, then superseded");
    expectEqual(lgSummaryRows(h), [["warn", "trace", true, NULL_HYPOTHESIS, DEADLINE, null],
      ["debug", "trace-b", true, "canonical-relation", "intelligent-valid", "intelligent-valid"]], "summaries, in order");
    expectEqual(lgOf(h, "formal-operation-settled").map(lgSummarySelections),
      [[null, [DEADLINE, false], null], [null, ["intelligent-valid", true], ["intelligent-valid", true]]], "stage selections in the summaries");
  } finally { h.restore(); }
});

// Not graded. The same question revision was scheduled before and spent both of
// its budget slots, so the runtime refuses both stages of the new operation:
// no selector runs, no stage has a selection and nothing is dispatched for it.
// It ends authorized at the null hypothesis with no model result. That is
// neither a loss the selector reported nor a cancellation; the summary is debug.
test("LG1 not graded: a formal operation whose two stages are refused by the runtime budget is one debug summary with no stage selection", { concurrency: false }, async () => {
  const h = st183Harness();
  try {
    // The earlier operation of this revision: its Affinity started at 0 and its Canonical at 100.
    const earlier = scheduleRelation(h);
    await h.clock.advanceTo(100);
    const earlierCanonical = watch(h, earlier.startCanonical({ foreground: true, deadlineAt: h.clock.now + STAGE_MS }));
    await h.clock.advanceTo(200);
    expectEqual(h.executions.map((execution) => [execution.request.operationKind, tierOf(execution)]),
      [["task-relation-parent-affinity", "intelligent"], ["task-relation-parent-affinity", "fast"],
        ["task-relation-canonical-shadow", "intelligent"], ["task-relation-canonical-shadow", "fast"]], "the earlier operation's requests");
    const handle = scheduleRelation(h);
    const wait = watch(h, h.environment.resolveOrderedTaskRelationWithinWindow({ handle, traceId: "trace", currentQuestionType: "coding",
      sourceKind: "voice", activeMeetingTask: h.environment.contextManagerRef.current.getState().activeMeetingTask, waitBudgetMs: 8_000 }));
    await h.clock.advanceTo(300);
    expectEqual([wait.state, wait.value?.terminalDisposition, wait.value?.operationAuthorization?.authorized,
      h.metadata.taskRelationOrderedResolutionAffinityParentDisposition, h.metadata.taskRelationOrderedResolutionCanonicalDisposition,
      h.metadata.taskRelationOrderedResolutionStage, h.executions.length, earlierCanonical.value?.unavailableReason],
    ["resolved", "resolved", true, "budget-exhausted", "budget-exhausted", NULL_HYPOTHESIS, 4, "superseded"],
    "the refused operation, its recorded stage dispositions and the physical requests");
    expectEqual([lgSelections(handle), lgStageReasons(h)], [[null, null, null], [undefined, undefined, undefined]],
      "no stage selection, in the handle and in the trace");
    const entries = lgCheckEntries(h, "budget refused");
    expectEqual(lgLines(h), ["debug formal-operation-settled"], "entries");
    expectEqual([entries[0].data.operationAuthorized, entries[0].data.clientError, lgUsable(entries[0]), lgSummarySelections(entries[0])],
      [true, false, [false, false, false], [null, null, null]], "summary");
    expectEqual(notGraded("relation-runtime-budget-refused").entry, "debug", "listed as not graded");
  } finally { h.restore(); }
});

// One lost stage is enough, whichever it is. Here it is the child Affinity alone:
// the parent Affinity and the Canonical of this question revision are refused by
// the runtime budget, as above, and the child Affinity, which the earlier
// operation did not have, runs to its deadline with no candidate.
test("LG1 a lost child Affinity alone makes the warning: the parent Affinity and Canonical are refused by the runtime budget and have no selection", { concurrency: false }, async () => {
  const h = st183Harness({ child: true });
  try {
    // The earlier operation of this revision ran while the task had no Child: parent Affinity at 0, Canonical at 100.
    const state = h.environment.contextManagerRef.current.getState();
    const withChild = state.activeMeetingTask;
    state.activeMeetingTask = { ...withChild, child: undefined };
    const earlier = scheduleRelation(h);
    await h.clock.advanceTo(100);
    void earlier.startCanonical({ foreground: true, deadlineAt: h.clock.now + STAGE_MS });
    await h.clock.advanceTo(200);
    state.activeMeetingTask = withChild;
    const handle = scheduleRelation(h);
    const wait = watch(h, h.environment.resolveOrderedTaskRelationWithinWindow({ handle, traceId: "trace", currentQuestionType: "coding",
      sourceKind: "voice", activeMeetingTask: state.activeMeetingTask, waitBudgetMs: 8_000 }));
    await h.clock.advanceTo(3 * STAGE_MS);
    expectEqual([wait.state, wait.at, wait.value?.terminalDisposition, wait.value?.operationAuthorization?.authorized,
      h.metadata.taskRelationOrderedResolutionAffinityChildDisposition, h.metadata.taskRelationOrderedResolutionAffinityParentDisposition,
      h.metadata.taskRelationOrderedResolutionCanonicalDisposition],
    ["resolved", 200 + STAGE_MS, "resolved", true, DEADLINE, "budget-exhausted", "budget-exhausted"], "the operation and its recorded stage dispositions");
    // Its only physical requests are the two child Affinity candidates.
    expectEqual(h.executions.slice(4).map((execution) => [execution.request.operationKind, tierOf(execution), execution.dispatchedAt - 10_000]),
      [["task-relation-child-affinity", "intelligent", 200], ["task-relation-child-affinity", "fast", 200]], "physical requests of the operation");
    expectEqual(lgSelections(handle), [[DEADLINE, false], null, null], "the stage selections of the operation's own handle");
    const entries = lgCheckEntries(h, "child lost alone");
    expectEqual(lgLines(h), ["warn formal-operation-settled"], "entries");
    expectEqual([lgSummarySelections(entries[0]), lgUsable(entries[0])], [[[DEADLINE, false], null, null], [false, false, false]], "summary");
  } finally { h.restore(); }
});

// Two formal operations never share stage selections: each schedule has its own
// object, and a summary reads the object of its own handle. The trace keys are
// one per trace, so on a shared trace the later settle overwrites the earlier
// one there; the summaries are not read from the trace and are not affected.
const lgSourceRows = (h) => lgOf(h, "formal-operation-settled").map((summary) =>
  [summary.level, summary.data.sourceKind, summary.refs.traceId, ...lgSummarySelections(summary).slice(1)]);

test("LG1 two formal operations on one trace keep their own stage selections: the first lost its Affinity stage and is the warning, although the second then wrote its own reason over the same trace key", { concurrency: false }, async () => {
  const h = st183Harness();
  try {
    const { first, waitFirst, second } = lgTwoSources(h, { secondAt: 800, secondTraceId: "trace" });
    // The Voice Affinity ends with both candidates unusable at 500 ms; its Canonical starts.
    await h.clock.advanceTo(500);
    settleBothAffinity({ rawOutput: PLANTED.providerError })(h);
    await h.clock.advanceTo(700);
    expectEqual([lgSelections(first), h.metadata.taskRelationParentAffinitySelectionReason],
      [[null, ["candidates-ended-unusable", false], null], "candidates-ended-unusable"], "the Voice Affinity, in its handle and in the trace");
    // The Screen operation, on the same trace: a valid Affinity at 900 ms, whose settle overwrites the trace key, and
    // then its Canonical, which supersedes the Voice Canonical.
    await h.clock.advanceTo(900);
    for (const execution of lgOfSecond(h, "affinity", "intelligent")) completeCandidate(execution, { rawOutput: FAST_PARENT_INDEPENDENT });
    await h.clock.advanceTo(1_000);
    for (const execution of lgOfSecond(h, "canonical", "intelligent")) completeCandidate(execution, { rawOutput: canonicalOutput("new-parent") });
    await h.clock.advanceTo(3 * STAGE_MS);
    expectEqual([waitFirst.state, waitFirst.at, waitFirst.value?.operationAuthorization?.authorized,
      waitFirst.value?.metadata?.taskRelationOrderedResolutionAffinityParentDisposition,
      waitFirst.value?.metadata?.taskRelationOrderedResolutionCanonicalDisposition, waitFirst.value?.metadata?.taskRelationOrderedResolutionStage],
    ["resolved", 900, true, "malformed-json", "operation-id-mismatch", NULL_HYPOTHESIS], "the Voice operation");
    expectEqual([second.wait.state, second.wait.at, second.wait.value?.metadata?.taskRelationOrderedResolutionStage],
      ["resolved", 1_000, "canonical-relation"], "the Screen operation");
    // One trace, and it now holds the Screen operation's reasons alone.
    expectEqual(lgStageReasons(h), [undefined, "intelligent-valid", "intelligent-valid"], "selection reasons in the shared trace");
    // Two handles, two objects, each with its own operation's stages.
    expectEqual(first.stageSelections === second.handle.stageSelections, false, "the two handles do not share an object");
    expectEqual([lgSelections(first), lgSelections(second.handle)],
      [[null, ["candidates-ended-unusable", false], null], [null, ["intelligent-valid", true], ["intelligent-valid", true]]],
      "the stage selections of each handle");
    lgCheckEntries(h, "shared trace, first lost");
    expectEqual(lgSourceRows(h), [["warn", "voice", "trace", ["candidates-ended-unusable", false], null],
      ["debug", "screen", "trace", ["intelligent-valid", true], ["intelligent-valid", true]]], "summaries, in order");
    expectEqual(lgAlerts(h).length, 1, "warnings and errors");
  } finally { h.restore(); }
});

test("LG1 two formal operations on one trace keep their own stage selections: the second, whose stages were only cancelled, is debug although the trace still holds the Canonical reason of the first, which lost both stages", { concurrency: false }, async () => {
  const h = st183Harness();
  try {
    const { first, waitFirst, second } = lgTwoSources(h, { secondAt: 2 * STAGE_MS + 500, secondTraceId: "trace" });
    await h.clock.advanceTo(2 * STAGE_MS + 550);
    second.handle.cancelForegroundWork();
    await h.clock.advanceTo(5 * STAGE_MS);
    expectEqual([waitFirst.state, waitFirst.at, waitFirst.value?.metadata?.taskRelationOrderedResolutionStage],
      ["resolved", 2 * STAGE_MS, NULL_HYPOTHESIS], "the Voice operation");
    expectEqual([second.wait.state, second.wait.at, second.wait.value?.operationAuthorization?.authorized,
      second.wait.value?.metadata?.taskRelationOrderedResolutionAffinityParentDisposition,
      second.wait.value?.metadata?.taskRelationOrderedResolutionCanonicalDisposition],
    ["resolved", 2 * STAGE_MS + 550, true, "operation-id-mismatch", "foreground-window-closed"], "the cancelled Screen operation");
    // The Screen Canonical never ran, so the trace still holds the Voice operation's Canonical reason.
    expectEqual(lgStageReasons(h), [undefined, undefined, DEADLINE], "selection reasons in the shared trace");
    expectEqual(first.stageSelections === second.handle.stageSelections, false, "the two handles do not share an object");
    expectEqual([lgSelections(first), lgSelections(second.handle)], [[null, [DEADLINE, false], [DEADLINE, false]], [null, null, null]],
      "the stage selections of each handle");
    lgCheckEntries(h, "shared trace, second cancelled");
    expectEqual(lgSourceRows(h), [["warn", "voice", "trace", [DEADLINE, false], [DEADLINE, false]],
      ["debug", "screen", "trace", null, null]], "summaries, in order");
    expectEqual(lgAlerts(h).length, 1, "warnings and errors");
  } finally { h.restore(); }
});

// ---- LG1 controls: cancelled, stopped and superseded work is never raised ----

for (const entry of ["voice", "screen"]) for (const [name, invalidate, mismatchedKey] of [
  ["Stop", (h) => stop(h), "runtimeEpoch"],
  ["a manual correction (user cancel of the automatic decision)", (h) => { h.environment.manualCorrectionRevisionRef.current += 1; },
    "manualCorrectionRevision"],
  ["a newer question (latest-wins supersession)", (_h, source) => { source.current = false; }, "source"],
]) {
  test(`LG1 LG3 control ${entry}: ${name} during the Affinity stage, then a late candidate result: zero warn or error and one debug summary`, { concurrency: false }, async () => {
    const h = st183Harness();
    try {
      lgPlantSecret(h);
      const source = { current: true };
      const handle = scheduleRelation(h, { sourceKind: entry === "screen" ? "screen" : "voice",
        authorizeSourceOperation: () => (source.current ? sourceCurrent()
          : { authorized: false, reason: "logical-question-revision-mismatch", mismatchedKey: "source" }) });
      let wait;
      if (entry === "voice") startVoiceResolution(h, handle);
      else wait = watch(h, startScreenConsumer(h, handle));
      await h.clock.advanceTo(1_000);
      const dispatched = [...h.executions];
      invalidate(h, source);
      // A late result of the invalidated work, with a provider timeout as its physical terminal.
      await h.clock.advanceTo(1_500);
      for (const execution of dispatched) {
        if (!execution.signal.aborted) completeCandidate(execution, { providerDisposition: "provider-error-content",
          providerOutcome: { status: "timed-out", safeErrorSummary: PLANTED.providerError } });
      }
      await h.clock.advanceTo(2 * STAGE_MS + 200);
      expectEqual(h.advisorCalls.length, 0, "Advisor handoffs");
      expectEqual([h.metadata.taskRelationOrderedResolutionOperationAuthorized, h.metadata.taskRelationOrderedResolutionOperationMismatchedKey],
        [false, mismatchedKey], "operation authorization");
      if (wait) expectEqual([wait.state, wait.value?.terminalDisposition], ["resolved", "cancelled"], "Screen consumer");
      else expectEqual(h.events.filter((event) => event.finish).map((event) => event.finish[1]), ["cancelled"], "Voice trace");
      const entries = lgCheckEntries(h, name);
      expectEqual(lgAlerts(h), [], "warnings and errors");
      expectEqual(lgLines(h), ["debug formal-operation-settled"], "entries");
      expectEqual([entries[0].data.operationAuthorized, entries[0].data.parentUsable, entries[0].data.canonicalUsable],
        [false, false, false], "the summary says the operation was no longer authorized");
    } finally { h.restore(); }
  });
}

test("LG1 control: a handle with no release window is debug when it reaches the Ordered operation, with no model operation and no request", { concurrency: false }, async () => {
  const h = st183Harness();
  try {
    // No release window: the Hook lends the handle no model field, and its consumers do not call the Ordered operation.
    h.environment.contextManagerRef.current.getState().activeMeetingTask = undefined;
    const handle = scheduleRelation(h);
    expectEqual([handle.releaseWindowRequested, handle.affinityOutcome], [false, undefined], "handle");
    await settledValue(h, h.environment.resolveOrderedTaskRelationWithinWindow({ handle, traceId: "trace", currentQuestionType: "coding",
      sourceKind: "voice", activeMeetingTask: undefined, waitBudgetMs: 8_000 }), "Ordered operation");
    const entries = lgCheckEntries(h, "no window");
    expectEqual(lgLines(h), ["debug formal-operation-settled"], "entries");
    expectEqual([handle.stageSelections, lgSummarySelections(entries[0]), lgUsable(entries[0]), h.executions.length],
      [undefined, [null, null, null], [false, false, false], 0], "no model operation: no stage selection, no usable stage and no request");
  } finally { h.restore(); }
});

// The first clause of the rule: a formal model operation. Production never builds
// this handle; its consumers call the Ordered operation only with a release
// window, and a handle with one always has its model fields. It is built by hand
// here to pin the clause: with no release window, even an authorized operation
// that reports a client error and has no usable stage is debug.
test("LG1 control: an operation that is not a formal model operation is debug even when it reports a client error", { concurrency: false }, async () => {
  const h = st183Harness();
  try {
    const clientError = () => ({ child: { unavailableReason: "no-active-child" },
      parent: { unavailableReason: "provider-circuit-open", clientError: true } });
    const resolve = (handle) => settledValue(h, h.environment.resolveOrderedTaskRelationWithinWindow({ handle, traceId: "trace",
      currentQuestionType: "coding", sourceKind: "voice", activeMeetingTask: h.environment.contextManagerRef.current.getState().activeMeetingTask,
      waitBudgetMs: 8_000 }), "Ordered operation");
    const noWindow = await resolve({ releaseWindowRequested: false, authorizeOperation: sourceCurrent, readAffinityOutcome: clientError });
    expectEqual([noWindow.terminalDisposition, noWindow.operationAuthorization.authorized, h.metadata.taskRelationOrderedResolutionClientError],
      ["client-error", true, true], "the operation without a release window");
    // The same outcome from a handle with a release window and a stage terminal is the warning.
    const formal = await resolve({ releaseWindowRequested: true, authorizeOperation: sourceCurrent, affinityOutcome: Promise.resolve(clientError()) });
    expectEqual([formal.terminalDisposition, formal.operationAuthorization.authorized], ["client-error", true], "the formal operation");
    const entries = lgCheckEntries(h, "not a formal model operation");
    expectEqual(entries.map((entry) => [entry.level, entry.event, entry.data.clientError, entry.data.operationAuthorized, lgUsable(entry)]),
      [["debug", "formal-operation-settled", true, true, [false, false, false]],
        ["warn", "formal-operation-settled", true, true, [false, false, false]]], "entries, in order");
  } finally { h.restore(); }
});

// ---- LG1: the Type window of the Voice turn ----

for (const [name, options, lines, business] of [
  // Timeout table 3.1, row 2 for Type: still pending at the foreground deadline, the turn goes on with the prior type.
  ["Timeout 2: Type never settles", { typeOutcome: () => new Promise(() => {}) },
    ["warn foreground-deadline-finalized"], { releasedAt: [2_000], disposition: "deadline-expired-finalized" }],
  // Row 5 for Type: its result arrives after the turn was released.
  ["Timeout 2 then 5: Type settles 500 ms after the deadline", { typeAt: 2_500 },
    ["warn foreground-deadline-finalized", "debug late-result-discarded"], { releasedAt: [2_000], disposition: "settled-after-deadline-shadow-only" }],
  ["control: Type settles in time", {}, [], { releasedAt: [50], disposition: "type-settled-and-released-before-deadline" }],
]) {
  test(`LG1 Voice Type window, ${name}: ${lines.length ? lines.join(", then ") : "no entry"}`, { concurrency: false }, async () => {
    const run = await runNoWindowVoice(options);
    const { h } = run;
    try {
      expectEqual([run.release.releasedAt, h.metadata.questionTypeAdjudicationWaitDisposition, h.executions.length],
        [business.releasedAt, business.disposition, 0], "release, recorded wait disposition and physical requests");
      const entries = lgCheckEntries(h, name);
      expectEqual(lgLines(h), lines, "entries, in order");
      expectEqual(lgAlerts(h).length, lines.filter((line) => line.startsWith("warn")).length, "warnings and errors");
      if (lines.length) expectEqual([entries[0].refs, entries[0].data], [{ traceId: "trace" }, { typeWindowRequested: true,
        typeOutcomePending: true, relationWindowRequested: false, typeWaitBudgetMs: 2_000, foregroundBudgetMs: 2_000, waitMs: 2_000 }],
      "the deadline entry");
      if (lines.length > 1) expectEqual(entries[1].data, { waitMs: 2_500 }, "the late result entry");
    } finally { h.restore(); }
  });
}

test("LG1 Voice Type window: a late Type result carries its typed provider timeout and is still debug", { concurrency: false }, async () => {
  const run = await runNoWindowVoice({ typeOutcome: (h) => settlesAt(h, 2_700, { enforcement: { authorized: false, reason: "candidate-missing" },
    operationId: "type-operation", operationLeaseAuthorized: true, providerTimedOut: true, disposition: PLANTED.providerError }) });
  try {
    const entries = lgCheckEntries(run.h, "late timed-out Type");
    expectEqual(lgLines(run.h), ["warn foreground-deadline-finalized", "debug late-result-discarded"], "entries");
    expectEqual(entries[1].data, { providerTimedOut: true, leaseAuthorized: true, waitMs: 2_700 }, "the late result entry");
  } finally { run.h.restore(); }
});

for (const [name, invalidate] of [
  ["Stop", (h) => { stop(h); h.environment.runtimeActiveRef.current = false; }],
  ["a newer question", (h) => { h.environment.logicalQuestionUnitRef.current = nextUnit(); }],
]) {
  test(`LG1 control Voice Type window: ${name} while Type is pending produces no warn at the deadline`, { concurrency: false }, async () => {
    const h = st183Harness();
    try {
      const unit = shortUnit();
      h.environment.logicalQuestionUnitRef.current = unit;
      // The source lease of a Voice question, as scheduleQuestionRuntime builds it.
      const lease = imports.createLogicalQuestionUnitLease(unit);
      const handle = scheduleRelation(h, { unit, authorizeSourceOperation: () => {
        const authorization = imports.authorizeLogicalQuestionUnitLease(lease, h.environment.logicalQuestionUnitRef.current);
        return { authorized: authorization.authorized, reason: authorization.reason, mismatchedKey: authorization.authorized ? undefined : "source" };
      } });
      startVoiceFor(h, handle, unit, { typeOutcome: new Promise(() => {}) });
      await h.clock.advanceTo(1_000);
      invalidate(h);
      await h.clock.advanceTo(6_000);
      expectEqual(h.advisorCalls.length, 0, "Advisor handoffs");
      lgCheckEntries(h, name);
      expectEqual(lgAlerts(h), [], "warnings and errors");
      expectEqual(lgLines(h), [], "entries");
    } finally { h.restore(); }
  });
}

// The entry reports the deadline finalization, not the handoff. The meeting stops
// being active without an epoch change (a capture fault, as the native terminal
// handler leaves it): the wait still ends at the deadline with Type pending, the
// turn is not handed to the Advisor and its trace ends cancelled.
test("LG1 Voice Type window: Type pending at the deadline of a meeting that is no longer active: the warning is made and the turn is not handed to the Advisor", { concurrency: false }, async () => {
  const run = await runNoWindowVoice({ typeOutcome: () => new Promise(() => {}), during: async (h) => {
    await h.clock.advanceTo(1_000);
    h.environment.runtimeActiveRef.current = false;
  } });
  const { h } = run;
  try {
    expectEqual([h.advisorCalls.length, h.metadata.questionTypeAdjudicationWaitDisposition,
      h.events.filter((event) => event.finish).map((event) => event.finish.slice(1))],
    [0, "deadline-expired-finalized", [["cancelled", "Meeting stopped during question type wait."]]],
    "Advisor handoffs, recorded wait disposition and trace terminal");
    const entries = lgCheckEntries(h, "inactive meeting");
    expectEqual(lgLines(h), ["warn foreground-deadline-finalized"], "entries");
    // A known limit, stated in the ledger: the branch holds no typed fact of the handoff, so this is still a warning.
    assert.match(ledgerRowOf(entries[0]).knownLimits.join(" "), /no longer active.*is still warn/, "the limit is in the ledger");
    expectEqual(entries[0].data, { typeWindowRequested: true, typeOutcomePending: true, relationWindowRequested: false,
      typeWaitBudgetMs: 2_000, foregroundBudgetMs: 2_000, waitMs: 2_000 }, "the deadline entry");
  } finally { h.restore(); }
});

test("LG1 Voice formal window: Type pending and every Relation stage lost in a meeting that is no longer active: the two warnings are made and the turn is not handed to the Advisor", { concurrency: false }, async () => {
  const h = st183Harness();
  try {
    const handle = scheduleEntry(h, "voice");
    startVoiceResolution(h, handle, { outcome: new Promise(() => {}) });
    await h.clock.advanceTo(1_000);
    h.environment.runtimeActiveRef.current = false;
    await h.clock.advanceTo(2 * STAGE_MS + 100);
    expectEqual([h.advisorCalls.length, h.metadata.questionTypeAdjudicationWaitDisposition,
      h.events.filter((event) => event.finish).map((event) => event.finish.slice(1))],
    [0, "deadline-expired-finalized", [["cancelled", "Meeting stopped during question type wait."]]],
    "Advisor handoffs, recorded wait disposition and trace terminal");
    lgCheckEntries(h, "inactive meeting, formal window");
    expectEqual(lgLines(h), ["warn formal-operation-settled", "warn foreground-deadline-finalized"], "entries");
  } finally { h.restore(); }
});

test("LG1 Voice: Type pending at the deadline and a formal Relation that lost all evidence are two operations and two warnings, one each", { concurrency: false }, async () => {
  const h = st183Harness();
  try {
    const handle = scheduleEntry(h, "voice");
    startVoiceResolution(h, handle, { outcome: new Promise(() => {}) });
    await h.clock.advanceTo(2 * STAGE_MS + 100);
    expectEqual(h.advisorCalls.length, 1, "Advisor handoffs");
    lgCheckEntries(h, "two operations");
    expectEqual(lgLines(h), ["warn formal-operation-settled", "warn foreground-deadline-finalized"], "entries");
  } finally { h.restore(); }
});

// ---- LG1: observation Relation (Runtime Cross-checks), one entry per stage settle ----

for (const [name, options, lines, selections, tiers] of [
  // Timeout table 3.1, row 4: an extra cross-check that ends at its deadline with nothing usable.
  ["Timeout 4: the Affinity observation and its Canonical follow-up both end at their deadline",
    { until: 2 * STAGE_MS + 100 }, ["warn parent-affinity", "warn canonical"], [DEADLINE, DEADLINE]],
  ["a valid Affinity observation, then its Canonical follow-up ends at its deadline",
    { observed: [20, PARENT_INDEPENDENT], until: 20 + 2 * STAGE_MS + 100 }, ["debug parent-affinity", "warn canonical"], ["intelligent-valid", DEADLINE]],
  // Timeout table 3.1, row 1 for an observation: the deadline reason with a timely Fast is the expected switch, not a loss.
  ["Timeout 1: a timely Fast is selected at the deadline in both observation stages",
    { until: 2 * STAGE_MS + 100, during: (h) => {
      h.clock.setTimeout(() => completeFastAffinity(h), 879);
      h.clock.setTimeout(() => completeCandidate(candidate(h, "canonical", "fast"), { rawOutput: canonicalOutput("followup-parent") }), STAGE_MS + 600);
    } }, ["debug parent-affinity", "debug canonical"], [DEADLINE, DEADLINE], ["fast", "fast"]],
]) {
  test(`LG1 observation Relation, ${name}: the main release is what it is without the observation`, { concurrency: false }, async () => {
    const baseline = await runNoWindowVoice({ until: options.until });
    baseline.h.restore();
    const run = await runNoWindowVoice({ crossChecks: true, ...options });
    const { h } = run;
    try {
      // The observation changed nothing the turn released.
      assert.deepEqual(run.release, baseline.release, "release with the observation running");
      expectEqual(baseline.h.diagnosticLog.entries(), [], "no entry without the observation");
      const entries = lgCheckEntries(h, name);
      expectEqual(entries.map((entry) => `${entry.level} ${entry.data.stage}`), lines, "one entry per stage settle");
      expectEqual(entries.map((entry) => [entry.event, entry.refs.traceId, entry.data.disposition, entry.data.current, entry.data.selection]),
        selections.map((selection) => ["observation-stage-settled", "trace", "completed", true, selection]), "stage outcome");
      // A selected tier and a parse-valid result come together; with neither, the stage had nothing usable.
      expectEqual(entries.map((entry) => [entry.data.tier ?? null, entry.data.parseValid]),
        lines.map((line, index) => line.startsWith("warn") ? [null, false] : [tiers?.[index] ?? "intelligent", true]), "selected tier and parse result");
      expectEqual(lgStageReasons(h).slice(1), selections, "selection reasons in the trace");
    } finally { h.restore(); }
  });
}

test("LG1 LG4 observation Relation: both candidates end with a provider error before the deadline: debug, and neither the error text, the question nor the provider credential is in the entry", { concurrency: false }, async () => {
  const h = st183Harness({ crossChecks: true });
  try {
    lgPlantSecret(h);
    // The question is observed only: no release window is requested for this turn.
    h.environment.scheduleTaskRelationAdjudication({ turn: { speaker: "them", text: QUESTION }, traceId: "trace",
      turnGateAction: "phase-control", logicalQuestionUnit, lexical: { type: "coding" }, sourceKind: "voice",
      authorizeSourceOperation: sourceCurrent });
    await h.clock.advanceTo(500);
    expectEqual(h.executions.map((execution) => execution.selectedProvider.variables.api_key), [PLANTED.secret, PLANTED.secret],
      "the credential is in the request the provider layer was given");
    for (const execution of candidates(h, "affinity")) completeCandidate(execution, { rawOutput: PLANTED.providerError,
      providerOutcome: { status: "failed", failureClass: "provider-http", safeErrorSummary: PLANTED.providerError } });
    await h.clock.advanceTo(600);
    const entries = lgCheckEntries(h, "observation ended unusable");
    // Ended unusable, and not because of the deadline: an observation stage warns only for the deadline.
    expectEqual(entries.map((entry) => [entry.level, entry.event, entry.refs, entry.data]), [["debug", "observation-stage-settled", { traceId: "trace" },
      { stage: "parent-affinity", disposition: "completed", current: true, selection: "candidates-ended-unusable", parseValid: false,
        providerStatus: "failed", durationMs: 500 }]], "entry");
  } finally { h.restore(); }
});

test("LG1 control observation Relation: observation stages superseded by the formal operation of the same question are debug, and the one warning is the formal operation's own", { concurrency: false }, async () => {
  const h = st183Harness({ crossChecks: true });
  try {
    // An observation of the question, then the same question as a formal operation: the formal Affinity supersedes the
    // observation Affinity at 100 ms, and the formal Canonical supersedes the observation's Canonical follow-up at 4100 ms.
    h.environment.scheduleTaskRelationAdjudication({ turn: { speaker: "them", text: QUESTION }, traceId: SAME_REVISION_TRACE,
      turnGateAction: "phase-control", logicalQuestionUnit, lexical: { type: "coding" }, sourceKind: "voice",
      authorizeSourceOperation: sourceCurrent });
    await h.clock.advanceTo(100);
    const handle = scheduleEntry(h, "screen");
    const wait = watch(h, startScreenConsumer(h, handle));
    // No candidate answers: the formal operation loses both stages at their deadlines.
    await h.clock.advanceTo(100 + 2 * STAGE_MS + 100);
    expectEqual([wait.state, wait.value?.terminalDisposition], ["resolved", "resolved"], "formal consumer");
    const entries = lgCheckEntries(h, "superseded observation");
    expectEqual(entries.map((entry) => [entry.level, entry.event, entry.refs.traceId, entry.data.stage,
      entry.data.disposition ?? null, entry.data.current ?? null, entry.data.selection ?? null]), [
      ["debug", "observation-stage-settled", SAME_REVISION_TRACE, "parent-affinity", "superseded", false, null],
      ["debug", "observation-stage-settled", SAME_REVISION_TRACE, "canonical", "superseded", false, null],
      ["warn", "formal-operation-settled", "trace", "source-topology-null-hypothesis", null, null, null],
    ], "entries, in order");
  } finally { h.restore(); }
});

// ---- LG2: the log level changes what is logged and nothing else ----

// The levels a threshold lets through, written out.
const LG_PASSES = { error: ["error"], warn: ["error", "warn"], info: ["error", "warn", "info"],
  debug: ["error", "warn", "info", "debug"], trace: ["error", "warn", "info", "debug", "trace"] };
const lgPassing = (level, lines) => lines.filter((line) => LG_PASSES[level].includes(line.split(" ")[0]));
const LG_REASON_KEYS = ["taskRelationChildAffinitySelectionReason", "taskRelationParentAffinitySelectionReason",
  "taskRelationSplitCanonicalSelectionReason"];
// A recorder row as the recorder was handed it.
const lgRecorded = (h) => plain(h.recorded);

for (const entry of ["voice", "screen", "correction"]) {
  test(`LG2 ${entry} formal Relation at the five levels x Debug x Recording x Cross-checks: the result, the release, the whole trace, every physical request and every recorder row are identical; the selection reason is the same key and value in all forty runs`, { concurrency: false }, async () => {
    const runs = [];
    for (const logLevel of DIAGNOSTIC_LOG_SPY_LEVELS) for (const switches of SWITCH_COMBINATIONS) {
      const run = await runFormalAlone({ entry, ...switches, logLevel });
      run.h.restore();
      runs.push({ logLevel, switches, ...run });
    }
    expectEqual(runs.length, 40, "runs");
    const reference = runs.find((run) => run.logLevel === "info" && !run.switches.debug && !run.switches.recording && !run.switches.crossChecks);
    const recordedReference = lgRecorded(runs.find((run) => run.logLevel === "info" && run.switches.recording).h);
    // The business result of the reference, stated, so that "identical" is identical to something.
    expectEqual([reference.formal.relation, reference.formal.trace.taskRelationOrderedResolutionStage, reference.formal.requests.length,
      reference.formal.requests.map((request) => request.timeoutMs)],
    ["new-parent", "canonical-relation", 4, [STAGE_MS, STAGE_MS, STAGE_MS, STAGE_MS]], "the formal operation at info with every switch off");
    // The one additive key of this commit, per stage that ran.
    expectEqual(LG_REASON_KEYS.map((key) => reference.formal.trace[key]), [undefined, "intelligent-valid", "intelligent-valid"],
      "selection reasons in the trace");
    expectEqual(recordedReference.filter((row) => row.kind === "relation-decision" &&
      row.metadata.taskRelationSplitCanonicalSelectionReason !== undefined).map((row) =>
      LG_REASON_KEYS.map((key) => row.metadata[key] ?? null)).at(-1), [null, "intelligent-valid", "intelligent-valid"],
    "selection reasons in the recorded Relation decision");
    for (const { logLevel, switches, formal, h } of runs) {
      const name = `${logLevel} ${JSON.stringify(switches)}`;
      assert.deepEqual(formal, reference.formal, `result, release, trace, requests and handle with ${name}`);
      assert.deepEqual(lgRecorded(h), switches.recording ? recordedReference : [], `recorder rows with ${name}`);
      // Each switch still feeds only its own sink; the level feeds only the log.
      expectEqual([h.debugOutputs.length > 0, h.recorded.length > 0, h.clock.timers.size], [switches.debug, switches.recording, 0],
        `Debug sink, recorder and timers with ${name}`);
      for (const logged of lgCheckEntries(h, name)) expectEqual(logged.refs.traceId, "trace", `entry trace with ${name}`);
      expectEqual(lgLines(h), lgPassing(logLevel, ["debug formal-operation-settled"]), `log entries with ${name}`);
      // LG4: the operation made one logger call. Below its level that call is one comparison: nothing was built,
      // queued or sent, and the boundary was never called.
      const counters = h.diagnosticLog.snapshot();
      const passes = LG_PASSES[logLevel].includes("debug");
      expectEqual([counters.filtered, counters.accepted, counters.ipcCalls, counters.ipcEntries, h.diagnosticLog.mirrored.length],
        passes ? [0, 1, 1, 1, 1] : [1, 0, 0, 0, 0], `logger work with ${name}`);
    }
  });
}

// The path that warns: both stages lost at their deadline. `at` is where the consumer's wait ends.
async function lgRunLostEvidence({ entry, debug, recording, crossChecks, logLevel, logDelivery }) {
  const h = st183Harness({ debug, recording, crossChecks, logLevel, logDelivery });
  try {
    const handle = scheduleEntry(h, entry);
    const started = await startConsumerInOrder(h, handle, { entry });
    h.clock.setTimeout(() => completeCandidate(candidate(h, "affinity", "intelligent"),
      { rawOutput: PLANTED.providerError, providerOutcome: { status: "success", requestId: "candidate-request" } }), 700);
    await h.clock.advanceTo(3 * STAGE_MS);
    return { h, business: plain({
      relation: finalRelation(h, entry, started),
      consumer: entry === "voice" ? voiceRelease(h) : started.wait?.value,
      trace: h.metadata,
      traceUpdates: h.events,
      requests: h.executions.map((execution) => ({ request: execution.request, tier: tierOf(execution),
        selectedProvider: execution.selectedProvider, timeoutMs: execution.timeoutMs, dispatchedAt: execution.dispatchedAt - 10_000,
        identity: execution.executionIdentity, aborted: execution.signal.aborted })),
      critical: normalizeRuntimeCriticalEvents(h.criticalEvents.events(), { purpose: "formal" }),
      timersLeft: h.clock.timers.size,
    }) };
  } catch (error) {
    h.restore();
    throw error;
  }
}

for (const entry of ["voice", "screen", "correction"]) {
  test(`LG2 LG3 ${entry} formal Relation that loses all model evidence, at the five levels x Debug x Recording x Cross-checks: the fallback, every trace update, every physical request, the critical facts and every recorder row are identical; the warning is filtered only at error`, { concurrency: false }, async () => {
    const runs = [];
    for (const logLevel of DIAGNOSTIC_LOG_SPY_LEVELS) for (const switches of SWITCH_COMBINATIONS) {
      const run = await lgRunLostEvidence({ entry, ...switches, logLevel });
      run.h.restore();
      runs.push({ logLevel, switches, ...run });
    }
    const reference = runs.find((run) => run.logLevel === "info" && !run.switches.debug && !run.switches.recording && !run.switches.crossChecks);
    const recordedReference = lgRecorded(runs.find((run) => run.logLevel === "info" && run.switches.recording).h);
    const trace = reference.business.trace;
    // What the reference is: the null-hypothesis fallback after an invalid Intelligent Affinity cached at 700 ms and nothing else.
    expectEqual([trace.taskRelationOrderedResolutionStage, trace.taskRelationOrderedResolutionAffinityParentDisposition,
      trace.taskRelationOrderedResolutionCanonicalDisposition, reference.business.requests.length,
      reference.business.requests.map((request) => [request.tier, request.timeoutMs, request.aborted])],
    [NULL_HYPOTHESIS, "malformed-json", DEADLINE, 4,
      [["intelligent", STAGE_MS, true], ["fast", STAGE_MS, true], ["intelligent", STAGE_MS, true], ["fast", STAGE_MS, true]]],
    "the reference run");
    // The physical request facts the trace and the recorder hold for the cached candidate are the candidate's own.
    expectEqual([trace.taskRelationParentAffinityParseDisposition, trace.taskRelationParentAffinityProviderOutcomeStatus,
      trace.taskRelationParentAffinityProviderRequestId, trace.taskRelationParentAffinitySelectedProviderTier],
    ["malformed-json", "success", "candidate-request", undefined], "physical request facts in the trace");
    expectEqual(LG_REASON_KEYS.map((key) => trace[key]), [undefined, DEADLINE, DEADLINE], "selection reasons in the trace");
    const candidateRows = recordedReference.filter((row) => row.kind === "lifecycle" && row.stage === "task-relation-provider-candidate");
    expectEqual(candidateRows.filter((row) => row.taskRelationCandidateEvent === "completed" && row.taskRelationCandidateParseValid !== undefined)
      .map((row) => [row.taskRelationCandidateTier, row.taskRelationCandidateParseDisposition, row.taskRelationParentAffinityProviderOutcomeStatus]),
    [["intelligent", "malformed-json", "success"]], "the recorded completion of the cached candidate");
    expectEqual(candidateRows.some((row) => "selectionReason" in row), false, "no candidate row carries the reason: it is on the selection");
    for (const { logLevel, switches, business, h } of runs) {
      const name = `${logLevel} ${JSON.stringify(switches)}`;
      assert.deepEqual(business, reference.business, `fallback, trace updates, requests, critical facts and timers with ${name}`);
      assert.deepEqual(lgRecorded(h), switches.recording ? recordedReference : [], `recorder rows with ${name}`);
      lgCheckEntries(h, name);
      expectEqual(lgLines(h), lgPassing(logLevel, ["warn formal-operation-settled",
        ...(entry === "voice" ? ["debug foreground-deadline-finalized"] : [])]), `log entries with ${name}`);
      if (logLevel !== "error") expectEqual(lgSummarySelections(lgEntries(h)[0]), [null, [DEADLINE, false], [DEADLINE, false]],
        `the summary with ${name}`);
      // The warning itself costs one logger call. At the threshold that filters it, nothing was built, queued or sent.
      const counters = h.diagnosticLog.snapshot();
      if (logLevel === "error") expectEqual([counters.accepted, counters.ipcCalls, h.diagnosticLog.mirrored.length], [0, 0, 0],
        `logger work with ${name}`);
    }
  });
}

// ---- LG2: a failing delivery changes nothing either ----
//
// The logger's delivery boundary rejects the call, never answers it, answers
// something that is not a receipt, or throws. The call sites never read a
// delivery result, so the operation is what it is with a working delivery: the
// same result, trace updates, physical requests, critical facts, recorder rows
// and timers, and the same entries handed to the logger. What differs is the
// logger's own count of what it could not deliver.
const LG_DELIVERY_SWITCHES = [SWITCH_COMBINATIONS[0], SWITCH_COMBINATIONS[SWITCH_COMBINATIONS.length - 1]];
function lgExpectUndelivered(h, name) {
  const handedOver = lgEntries(h).length;
  const counters = h.diagnosticLog.snapshot();
  expectEqual([counters.undeliveredEntries, counters.ipcFailures + counters.ipcTimeouts + counters.ipcMalformedReceipts,
    counters.native.accepted, counters.queued, counters.inFlight],
  [handedOver, counters.ipcCalls, 0, 0, false], `undelivered entries, failed calls and the queue with ${name}`);
}
for (const entry of ["voice", "screen", "correction"]) {
  test(`LG2 ${entry} formal Relation with the log delivery failing (${DIAGNOSTIC_LOG_SPY_FAILING_DELIVERIES.join(", ")}) at the five levels, every switch off and every switch on: the lost-evidence fallback and the resolved operation are what they are with a working delivery, and so are the entries handed to the logger`, { concurrency: false }, async () => {
    expectEqual(LG_DELIVERY_SWITCHES, [{ debug: false, recording: false, crossChecks: false }, { debug: true, recording: true, crossChecks: true }],
      "switch combinations");
    for (const switches of LG_DELIVERY_SWITCHES) {
      const lostReference = await lgRunLostEvidence({ entry, ...switches, logLevel: "info" });
      lostReference.h.restore();
      const resolvedReference = await runFormalAlone({ entry, ...switches, logLevel: "info" });
      resolvedReference.h.restore();
      expectEqual([lostReference.h.diagnosticLog.delivery, lostReference.h.diagnosticLog.snapshot().undeliveredEntries], ["ok", 0],
        "the reference delivers");
      for (const logDelivery of DIAGNOSTIC_LOG_SPY_FAILING_DELIVERIES) for (const logLevel of DIAGNOSTIC_LOG_SPY_LEVELS) {
        const name = `${logDelivery} ${logLevel} ${JSON.stringify(switches)}`;
        const lost = await lgRunLostEvidence({ entry, ...switches, logLevel, logDelivery });
        lost.h.restore();
        assert.deepEqual(lost.business, lostReference.business, `fallback, trace updates, requests, critical facts and timers with ${name}`);
        assert.deepEqual(lgRecorded(lost.h), lgRecorded(lostReference.h), `recorder rows with ${name}`);
        lgCheckEntries(lost.h, name);
        expectEqual(lgLines(lost.h), lgPassing(logLevel, ["warn formal-operation-settled",
          ...(entry === "voice" ? ["debug foreground-deadline-finalized"] : [])]), `entries handed to the logger with ${name}`);
        lgExpectUndelivered(lost.h, name);
        const resolved = await runFormalAlone({ entry, ...switches, logLevel, logDelivery });
        resolved.h.restore();
        assert.deepEqual(resolved.formal, resolvedReference.formal, `result, release, trace, requests and handle with ${name}`);
        assert.deepEqual(lgRecorded(resolved.h), lgRecorded(resolvedReference.h), `recorder rows of the resolved operation with ${name}`);
        lgCheckEntries(resolved.h, name);
        expectEqual(lgLines(resolved.h), lgPassing(logLevel, ["debug formal-operation-settled"]),
          `entries of the resolved operation handed to the logger with ${name}`);
        lgExpectUndelivered(resolved.h, name);
        expectEqual([lost.h.clock.timers.size, resolved.h.clock.timers.size], [0, 0], `timers left with ${name}`);
      }
    }
  });
}

test("LG2 Voice Type window and observation Relation with the log delivery failing: the release is what it is with a working delivery, and the same entries are handed to the logger", { concurrency: false }, async () => {
  // Type never settles; with Cross-checks on, the observation Affinity and its Canonical follow-up end at their deadlines.
  const scenario = { crossChecks: true, typeOutcome: () => new Promise(() => {}), until: 2 * STAGE_MS + 100 };
  const reference = await runNoWindowVoice(scenario);
  reference.h.restore();
  const lines = lgLines(reference.h);
  expectEqual(lines, ["warn foreground-deadline-finalized", "warn observation-stage-settled", "warn observation-stage-settled"],
    "entries with a working delivery");
  // runNoWindowVoice builds its own harness: the delivery is set on the spy factory for the run.
  for (const logDelivery of DIAGNOSTIC_LOG_SPY_FAILING_DELIVERIES) {
    const h = st183Harness({ crossChecks: true, logDelivery });
    try {
      const unit = shortUnit();
      h.environment.logicalQuestionUnitRef.current = unit;
      const handle = scheduleRelation(h, { unit, authorizeSourceOperation: sourceCurrent });
      startVoiceFor(h, handle, unit, { typeOutcome: new Promise(() => {}) });
      await h.clock.advanceTo(scenario.until);
      assert.deepEqual(voiceRelease(h), reference.release, `release with ${logDelivery}`);
      lgCheckEntries(h, logDelivery);
      expectEqual(lgLines(h), lines, `entries handed to the logger with ${logDelivery}`);
      lgExpectUndelivered(h, logDelivery);
      expectEqual(h.clock.timers.size, 0, `timers left with ${logDelivery}`);
    } finally { h.restore(); }
  }
});

test("LG2 178A critical facts at the five levels x Debug x Recording x Cross-checks: the formal facts, their order and times, the observation facts, the saved journal and the formal release are identical at every level", { concurrency: false }, async () => {
  // One run per switch combination at each level. "info" is the reference for the facts; "trace" holds every log line.
  const runs = {};
  for (const logLevel of DIAGNOSTIC_LOG_SPY_LEVELS) for (const switches of SWITCH_COMBINATIONS) {
    runs[`${logLevel} ${JSON.stringify(switches)}`] = await aeRunSwitches({ ...switches, logLevel });
  }
  const at = (logLevel, switches) => runs[`${logLevel} ${JSON.stringify(switches)}`];
  const everyOff = at("info", SWITCH_COMBINATIONS[0]);
  expectEqual([everyOff.formal.length, everyOff.business.release.settlement?.relation], [8, "new-parent"], "the reference run");
  for (const logLevel of DIAGNOSTIC_LOG_SPY_LEVELS) for (const switches of SWITCH_COMBINATIONS) {
    const name = `${logLevel} ${JSON.stringify(switches)}`;
    const run = at(logLevel, switches), same = at("info", switches);
    // Across the switches: what AE3 states. Across the levels: everything.
    assert.deepEqual(run.formal, everyOff.formal, `formal facts with ${name}`);
    assert.deepEqual(run.formalTimes, everyOff.formalTimes, `formal availability times with ${name}`);
    assert.deepEqual(run.business, everyOff.business, `formal requests and release with ${name}`);
    assert.deepEqual([run.observation, run.stats, run.timersLeft], [same.observation, same.stats, 0],
      `observation facts, stream counters and timers with ${name}`);
    expectEqual([run.journal?.status, run.journal?.eventCount, run.journal?.contiguous],
      [same.journal?.status, same.journal?.eventCount, same.journal?.contiguous], `saved journal with ${name}`);
    expectEqual(run.events.map((event) => [event.fact, event.purpose, event.refs.requestId, event.occurredAt]),
      same.events.map((event) => [event.fact, event.purpose, event.refs.requestId, event.occurredAt]), `every fact with ${name}`);
    // The log differs by level alone: the lines of the trace-level run, filtered.
    expectEqual(run.diagnosticLog, lgPassing(logLevel, at("trace", switches).diagnosticLog), `log entries with ${name}`);
  }
  // What the log holds at trace: the formal summary, and with Cross-checks the observation stage settles.
  expectEqual(at("trace", SWITCH_COMBINATIONS[0]).diagnosticLog, ["debug formal-operation-settled"], "log at trace with every switch off");
  expectEqual(at("trace", { debug: false, recording: false, crossChecks: true }).diagnosticLog,
    ["debug observation-stage-settled", "debug observation-stage-settled", "debug formal-operation-settled"],
    "log at trace with Cross-checks on");
});
