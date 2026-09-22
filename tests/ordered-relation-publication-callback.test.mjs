import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
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
  "resolveOrderedTaskRelationWithinWindow",
  "scheduleAdvisorAfterQuestionTypeWindow",
];
const callbackSources = callbackNames.map((name) => {
  const declaration = findNamedDeclaration(sourceFile, name);
  assert.ok(declaration.initializer && ts.isCallExpression(declaration.initializer));
  return declaration.initializer.arguments[0].getText(sourceFile);
});
const withTimeoutSource = findNamedDeclaration(
  sourceFile,
  "withTimeout"
).getText(sourceFile);
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
const typeCorrectionRelationTerminalSource = findDescendant(
  typeCorrectionDeclaration,
  (node) =>
    ts.isIfStatement(node) &&
    node.expression
      .getText(sourceFile)
      .includes('resolution.terminalDisposition !== "resolved"')
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
  withTimeoutSource,
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
  vm.runInContext(transpile(withTimeoutSource), context);
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

function productionRelationHandle(
  harness,
  {
    sourceKind = "voice",
    currentQuestion: suppliedCurrentQuestion,
    authorizeSourceOperation = () => ({
      authorized: true,
      reason: "source-operation-current",
    }),
  } = {}
) {
  const executions = [];
  harness.environment.meetingModelProviderSnapshotRef = { current: {} };
  harness.environment.resolveRuntimeInferenceModelRouteFromSnapshot = ({ providerTier = "intelligent" }) => ({
    provider: {},
    selectedProvider: { variables: { model: providerTier } },
    providerTier,
    configFingerprint: providerTier,
    missingRequiredVariables: [],
  });
  const admission = new admissionModule.RuntimeInferenceProviderAdmissionCoordinator(3, 0);
  admission.configureProviderGroups({ fastFingerprint: "fast", intelligentFingerprint: "intelligent" });
  harness.environment.runtimeInferenceProviderAdmissionRef = { current: admission };
  harness.environment.readSelectedProviderModelId = () => "test-provider";
  harness.environment.taskRelationSplitShadowCircuitRef = {
    current: { read: () => ({ open: false }), open: () => {} },
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
    const execution = { request, signal, selectedProvider, timeoutMs, executionIdentity, ...result };
    executions.push(execution);
    signal.addEventListener(
      "abort",
      () => result.reject(new Error("aborted")),
      { once: true }
    );
    return result.promise;
  };
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
    runtimeReleaseRequested: true,
    authorizeSourceOperation,
  });
  Object.assign(handle, {
    releaseWindowRequested: true,
    sourceKind,
    outcome: Promise.resolve({ operationId: handle.operationId }),
  });
  return { handle, executions };
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

for (const sourceKind of ["voice", "screen"]) for (const eventLoopDelay of [0, 200]) {
  test(`PA4 production ${sourceKind} gives Canonical4s after Affinity, event-loop delay=${eventLoopDelay}`, { concurrency: false }, async () => {
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
      resolveRelationProvider(executions[1], JSON.stringify({ v: 1, d: "r", c: 0.8, q: "Implement a queue.", b: "Implement a cache." }));
      await h.clock.advanceTo(3999);
      assert.equal(executions.length, 2, "Fast cache does not start Canonical");
      assert.equal(h.advisorCalls.length, 0);
      h.clock.now = 14000 + eventLoopDelay;
      await h.clock.advanceTo(4100 + eventLoopDelay);
      assert.equal(executions.length, 4);
      assert.equal(executions[0].signal.aborted, true);
      assert.equal(executions[2].timeoutMs, 4000);
      assert.equal(executions[3].timeoutMs, 4000);
      resolveRelationProvider(executions[3], JSON.stringify({ schemaVersion: 3, relation: "followup-parent", confidence: 0.8,
        currentQuestionEvidenceSpans: ["Implement a queue."], parentEvidenceSpans: ["Implement a cache."] }));
      await h.clock.advanceTo(7999 + eventLoopDelay);
      assert.equal(h.advisorCalls.length, 0, "no old4s/7s foreground release");
      resolveRelationProvider(executions[2], JSON.stringify({ schemaVersion: 3, relation: "new-parent", confidence: 0.8,
        currentQuestionEvidenceSpans: ["Implement a queue."], parentEvidenceSpans: [] }));
      await h.clock.flush();
      if (resolution) assert.equal((await resolution).decision.relation, "new-parent");
      else assert.equal(h.advisorCalls.length, 1);
      assert.equal(h.metadata.taskRelationParentAffinitySelectedProviderTier, "fast");
      assert.equal(h.metadata.taskRelationSplitCanonicalSelectedProviderTier, "intelligent");
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
    const outcome = await handle.affinityOutcome;

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
    const resolution = await resolutionPromise;
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
    const resolution = await resolutionPromise;

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

test("terminalizes Type Correction client errors before reading a Relation decision", { concurrency: false }, async () => {
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
      `(async (resolution) => { ${typeCorrectionRelationTerminalSource}; return "continued"; })`
    ),
    context
  );
  const result = await consume({
    terminalDisposition: "client-error",
    operationAuthorization: {
      authorized: true,
      reason: "source-operation-current",
    },
    decision: { relation: "new-parent" },
  });

  assert.equal(result, undefined);
  assert.equal(metadata.manualCorrectionRelationOperationAuthorized, false);
  assert.equal(metadata.manualCorrectionRelationTerminalDisposition, "client-error");
  assert.equal(ui.manualQuestionTypeCorrection.status, "failed");
  assert.equal(ui.manualQuestionTypeCorrection.regenerationStatus, "idle");
  assert.equal(ui.manualQuestionTypeCorrection.regenerationRetryable, false);
  assert.match(ui.error, /task type was not changed/);
  assert.equal(ui.partialSuggestion, "");
  assert.equal(recorded.length, 1);
  assert.deepEqual(finished, [
    [
      "type-correction-trace",
      "cancelled",
      "Runtime relation model configuration failed. The task type was not changed.",
    ],
  ]);
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
