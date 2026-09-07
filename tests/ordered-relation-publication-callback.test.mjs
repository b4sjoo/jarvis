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

const callbackNames = [
  "scheduleTaskRelationSplitRuntime",
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

const identifiers = new Set();
for (const source of [...callbackSources, withTimeoutSource]) {
  const file = parse(source);
  const visit = (node) => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
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
  "runtime-inference-runtime",
  "answer-generation-lease",
  "current-question-settlement",
  "ordered-settlement-coordinator",
  "meeting-model-route",
  "runtime-inference",
  "runtime-inference-response",
  "runtime-inference-provider-admission",
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
      this.now = timer.at;
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
    VOICE_ORDERED_RELATION_FOREGROUND_BUDGET_MS: 4_000,
    contextManagerRef: { current: { getState: () => state } },
    runtimeEpochRef: { current: 1 },
    manualCorrectionRevisionRef: { current: 0 },
    runtimeActiveRef: { current: true },
    debugModeRef: { current: false },
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

function productionRelationHandle(harness) {
  const executions = [];
  harness.environment.meetingModelProviderSnapshotRef = { current: {} };
  harness.environment.resolveRuntimeInferenceModelRouteFromSnapshot = () => ({
    provider: {},
    selectedProvider: {},
    missingRequiredVariables: [],
  });
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
  harness.environment.requestTaskRelationSplitShadow = ({ request, signal }) => {
    const result = deferred();
    const execution = { request, signal, ...result };
    executions.push(execution);
    signal.addEventListener(
      "abort",
      () => result.reject(new Error("aborted")),
      { once: true }
    );
    return result.promise;
  };
  const currentQuestion = imports.createProvisionalCurrentQuestion({
    logicalQuestionUnit,
    sourceKind: "voice",
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
    currentQuestion,
    runtimeReleaseRequested: true,
  });
  Object.assign(handle, {
    releaseWindowRequested: true,
    sourceKind: "voice",
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

function startVoiceResolution(harness, handle) {
  const typeOutcome = deferred();
  harness.clock.setTimeout(
    () => typeOutcome.resolve({ enforcement: { authorized: false } }),
    50
  );
  harness.environment.scheduleAdvisorAfterQuestionTypeWindow({
    handle: {
      questionType: {
        enforcementWindowRequested: true,
        waitBudgetMs: 2_000,
        outcome: typeOutcome.promise,
      },
      taskRelation: handle,
    },
    logicalQuestionUnit,
    traceId: "trace",
    mode: "voice",
    triggerTurnId: "turn-current",
  });
}

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

test("cancels a live Split Relation operation after manual correction invalidates its lease", { concurrency: false }, async () => {
  const harness = createHarness();
  try {
    const { handle, executions } = productionRelationHandle(harness);
    startVoiceResolution(harness, handle);
    await harness.clock.advanceTo(100);
    assert.equal(executions.length, 1);
    resolveRelationProvider(
      executions[0],
      JSON.stringify({ v: 1, d: "i", c: 0.99, q: "Implement a queue." })
    );
    await harness.clock.advanceTo(200);
    assert.equal(executions.length, 2);
    harness.environment.manualCorrectionRevisionRef.current += 1;
    resolveRelationProvider(
      executions[1],
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
