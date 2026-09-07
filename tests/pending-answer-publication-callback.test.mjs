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

function findCallbackSource(name) {
  let declaration;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(sourceFile) === name
    ) {
      declaration = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(declaration, `missing ${name}`);
  assert.ok(
    declaration.initializer && ts.isCallExpression(declaration.initializer),
    `${name} must remain a callback`
  );
  return declaration.initializer.arguments[0].getText(sourceFile);
}

function findFunctionSource(name) {
  let declaration;
  const visit = (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.getText(sourceFile) === name
    ) {
      declaration = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(declaration, `missing ${name}`);
  return declaration.getText(sourceFile);
}

const callbackSources = {
  prepareStableAnswerPublication: findCallbackSource(
    "prepareStableAnswerPublication"
  ),
  installPreparedStableAnswerPublication: findCallbackSource(
    "installPreparedStableAnswerPublication"
  ),
  rollbackPreparedStableAnswerPublication: findCallbackSource(
    "rollbackPreparedStableAnswerPublication"
  ),
  finalizeStableAnswerPublication: findCallbackSource(
    "finalizeStableAnswerPublication"
  ),
  readGenerationLeaseSnapshot: findCallbackSource(
    "readGenerationLeaseSnapshot"
  ),
  terminalizeGenerationLease: findCallbackSource(
    "terminalizeGenerationLease"
  ),
  tryCommitPendingAnswer: findCallbackSource("tryCommitPendingAnswer"),
  queuePendingAnswerRevision: findCallbackSource("queuePendingAnswerRevision"),
};
const helperSources = {
  prepareGenerationDerivedTaskRuntimeTransition: findFunctionSource(
    "prepareGenerationDerivedTaskRuntimeTransition"
  ),
  isCacheableReliableSuggestion: findFunctionSource(
    "isCacheableReliableSuggestion"
  ),
  withLatestReliableSuggestion: findFunctionSource(
    "withLatestReliableSuggestion"
  ),
};

const identifiers = new Set();
for (const source of [
  ...Object.values(callbackSources),
  ...Object.values(helperSources),
]) {
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
  try {
    const loaded = await import(
      pathToFileURL(
        path.join(root, ".tmp-tests", "src", `${moduleName.slice(2)}.js`)
      )
    );
    for (const binding of bindings) {
      const exported = loaded[binding.propertyName?.text ?? binding.name.text];
      if (exported) imports[binding.name.text] = exported;
    }
  } catch {
    // Concrete meeting modules below satisfy the barrel's runtime exports.
  }
}
for (const moduleName of [
  "stable-answer",
  "answer-generation-lease",
  "meeting-answer",
  "generation-result-ledger",
  "manual-question-type-correction",
  "visual-evidence-recovery",
  "bounded-recent-history",
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

const stableAnswerModule = await import(
  pathToFileURL(
    path.join(root, ".tmp-tests", "src", "lib", "meeting", "stable-answer.js")
  )
);
const meetingAnswerModule = await import(
  pathToFileURL(
    path.join(root, ".tmp-tests", "src", "lib", "meeting", "meeting-answer.js")
  )
);
const parseMeetingAnswer = meetingAnswerModule.parseMeetingAnswer;
const commitStableAnswerRevision = stableAnswerModule.commitStableAnswerRevision;
assert.ok(parseMeetingAnswer && commitStableAnswerRevision);
const generationResultModule = await import(
  pathToFileURL(
    path.join(
      root,
      ".tmp-tests",
      "src",
      "lib",
      "meeting",
      "generation-result-ledger.js"
    )
  )
);

function suggestion(id, content) {
  return {
    id,
    kind: "answer",
    content,
    meetingAnswer: parseMeetingAnswer(content),
    createdAt: 1_000,
    basedOnTurnIds: ["turn-current"],
    basedOnObservationIds: [],
    confidence: "high",
    sourceTraceId: `trace-${id}`,
  };
}

function stableAnswer() {
  return commitStableAnswerRevision({
    candidate: suggestion("visible-a", "Answer: Existing visible answer."),
    authorizedArtifacts: ["answer"],
    taskId: "parent-a",
    sectionOwner: { kind: "parent-mainline", parentId: "parent-a" },
    logicalQuestionUnitId: "lqu-current",
    logicalQuestionRevision: 1,
    sessionId: "session-a",
    runtimeEpoch: 1,
    questionSourceHash: "source-a",
    settlementId: "settlement-a",
    committedAt: 1_000,
  });
}

function createHarness() {
  let now = 2_000;
  const realNow = Date.now;
  Date.now = () => now;
  const initialStable = stableAnswer();
  assert.ok(initialStable);
  const refs = {
    stableAnswerRevisionRef: { current: initialStable },
    visibleAnswerRevisionRef: { current: initialStable.revision },
    pendingAnswerRevisionRef: { current: null },
    answerDeliveryProgressRef: {
      current: {
        visibleAnswerRevision: initialStable.revision,
        taskId: "parent-a",
        wordEquivalent: 20,
        continuousSpeechMs: 2_000,
        answerTokenOverlap: 12,
        lastMeTurnEndedAt: now,
        lockedAt: now,
      },
    },
    runtimeEpochRef: { current: 1 },
    manualCorrectionRevisionRef: { current: 0 },
    responseActionRevisionRef: { current: 0 },
    microphoneSpeakingRef: { current: true },
    logicalQuestionUnitRef: {
      current: {
        id: "lqu-current",
        revision: 1,
      },
    },
    preparationRuntimeContextRef: {
      current: { preparationContextRevision: 0 },
    },
    manualCorrectionTargetHistoryRef: { current: [] },
    latestManualCorrectionTargetRef: { current: undefined },
    pendingAnswerResolutionCommitByTraceRef: { current: new Map() },
    recentAdvisorContinuityRef: { current: [] },
  };
  const taskRuntime = { revision: 1 };
  const contextState = {
    sessionId: "session-a",
    activeMeetingTask: {
      id: "parent-a",
      parent: { id: "parent-a", revisions: 1 },
    },
    taskRuntime,
  };
  let uiState = {
    latestSuggestion: initialStable.suggestion,
    latestReliableSuggestion: initialStable.suggestion,
    partialSuggestion: "",
    answerDelivery: { visibleAnswerRevision: initialStable.revision },
  };
  const uiUpdates = [];
  const scheduledPendingCommits = [];
  let id = 0;
  const generationResultLedger =
    new generationResultModule.GenerationResultLedger();
  const generationDerivedCommitCoordinator =
    new generationResultModule.GenerationDerivedCommitCoordinator(
      generationResultLedger
    );
  const environment = {
    ...imports,
    Date,
    performance: { now: () => now },
    PENDING_ANSWER_TTL_MS: 60_000,
    ANSWER_DELIVERY_IDLE_RELEASE_MS: 6_000,
    ...refs,
    contextManagerRef: {
      current: {
        getState: () => contextState,
        getTaskRuntimeState: () => taskRuntime,
      },
    },
    generationResultLedgerRef: {
      current: generationResultLedger,
    },
    generationDerivedCommitCoordinatorRef: {
      current: generationDerivedCommitCoordinator,
    },
    schedulePendingAnswerCommit: (...args) => scheduledPendingCommits.push(args),
    publishGenerationResultProjection: () => {},
    transitionForceAdviseTarget: () => {},
    recordQuestionTypeAdjudicationOutcome: () => {},
    refreshRecordedCompletedTrace: () => {},
    clearPendingAnswerCommitTimer: () => {},
    finalizeAnswerRecoveryAdjudication: () => {},
    scheduleAdvisorResponseConsistencyShadow: () => {},
    toAnswerDeliveryPresentation: ({ visibleAnswerRevision }) => ({
      visibleAnswerRevision,
    }),
    createMeetingId: (prefix) => `${prefix}-${++id}`,
    setState: (updater) => {
      uiState = updater(uiState);
      uiUpdates.push({ ...uiState });
    },
    sessionRecordingManagerRef: { current: undefined },
    traceStoreRef: {
      current: {
        getTraces: () => [],
        updateMetadata: () => {},
      },
    },
  };
  const context = vm.createContext(environment);
  for (const source of Object.values(helperSources)) {
    vm.runInContext(transpile(source), context);
  }
  for (const [name, source] of Object.entries(callbackSources)) {
    environment[name] = vm.runInContext(transpile(`(${source})`), context);
  }
  return {
    environment,
    refs,
    get uiState() {
      return uiState;
    },
    uiUpdates,
    scheduledPendingCommits,
    generationResultLedger,
    unlock() {
      refs.microphoneSpeakingRef.current = false;
      refs.answerDeliveryProgressRef.current = null;
      now += 10;
    },
    restore() {
      Date.now = realNow;
    },
  };
}

function lease() {
  return {
    id: "lease-b",
    sessionId: "session-a",
    runtimeEpoch: 1,
    preparationContextRevision: 0,
    taskId: "parent-a",
    taskRevision: 1,
    logicalQuestionUnitId: "lqu-current",
    logicalQuestionRevision: 1,
    baseVisibleAnswerRevision: 1,
    sourceTurnIds: ["turn-current"],
    manualCorrectionRevision: 0,
    responseActionRevision: 0,
    modelRoute: "test",
    artifactOwnerId: "parent-a",
    requestedArtifacts: ["answer"],
    startedAt: 2_000,
  };
}

test("runs pending delivery callbacks once from lock through final unlock publication", () => {
  const harness = createHarness();
  try {
    const queued = harness.environment.queuePendingAnswerRevision({
      lease: lease(),
      suggestion: suggestion("visible-b", "Answer: New answer after delivery lock."),
      authorizedArtifacts: ["answer"],
      taskId: "parent-a",
      resultTaskId: "parent-a",
      sectionOwner: { kind: "parent-mainline", parentId: "parent-a" },
      taskRevision: 1,
      logicalQuestionUnitId: "lqu-current",
      logicalQuestionRevision: 1,
      sessionId: "session-a",
      runtimeEpoch: 1,
      questionSourceHash: "source-b",
      settlementId: "settlement-b",
      resetSections: false,
      reason: "delivery-lock-active",
      latestUsefulAnswerMutationAuthorized: false,
      taskRuntimeRevision: 1,
    });

    assert.ok(queued);
    assert.equal(harness.refs.pendingAnswerRevisionRef.current, queued);
    assert.equal(harness.refs.stableAnswerRevisionRef.current.revision, 1);
    assert.equal(harness.scheduledPendingCommits.length, 1);
    assert.equal(harness.uiState.partialSuggestion, "");
    assert.equal(
      harness.generationResultLedger.getEntry("lease-b")?.commitDisposition,
      "pending"
    );

    assert.equal(harness.environment.tryCommitPendingAnswer(), "waiting");
    assert.equal(harness.refs.pendingAnswerRevisionRef.current, queued);
    assert.equal(harness.refs.stableAnswerRevisionRef.current.revision, 1);

    harness.unlock();
    assert.equal(harness.environment.tryCommitPendingAnswer(), "committed");
    assert.equal(harness.refs.pendingAnswerRevisionRef.current, null);
    assert.equal(harness.refs.stableAnswerRevisionRef.current.revision, 2);
    assert.equal(
      harness.uiState.latestSuggestion.meetingAnswer.sections.answer,
      "New answer after delivery lock."
    );
    assert.equal(harness.environment.tryCommitPendingAnswer(), "none");
    assert.equal(
      harness.generationResultLedger.getEntry("lease-b")?.commitDisposition,
      "committed"
    );
    assert.equal(
      harness.uiUpdates.filter(
        (state) => state.latestSuggestion?.id === "visible-b"
      ).length,
      1
    );
  } finally {
    harness.restore();
  }
});

test("rejects pending publication when Preparation changes before unlock", () => {
  const harness = createHarness();
  try {
    const pendingLease = { ...lease(), id: "lease-preparation-stale" };
    const queued = harness.environment.queuePendingAnswerRevision({
      lease: pendingLease,
      suggestion: suggestion(
        "visible-stale",
        "Answer: This candidate must not become visible."
      ),
      authorizedArtifacts: ["answer"],
      taskId: "parent-a",
      resultTaskId: "parent-a",
      sectionOwner: { kind: "parent-mainline", parentId: "parent-a" },
      taskRevision: 1,
      logicalQuestionUnitId: "lqu-current",
      logicalQuestionRevision: 1,
      sessionId: "session-a",
      runtimeEpoch: 1,
      questionSourceHash: "source-stale",
      settlementId: "settlement-stale",
      resetSections: false,
      reason: "delivery-lock-active",
      latestUsefulAnswerMutationAuthorized: false,
      taskRuntimeRevision: 1,
    });
    assert.ok(queued);

    harness.refs.preparationRuntimeContextRef.current.preparationContextRevision =
      1;
    harness.unlock();
    assert.equal(harness.environment.tryCommitPendingAnswer(), "stale");
    assert.equal(harness.refs.stableAnswerRevisionRef.current.revision, 1);
    assert.equal(
      harness.refs.stableAnswerRevisionRef.current.suggestion.id,
      "visible-a"
    );
    assert.equal(harness.refs.pendingAnswerRevisionRef.current, null);
    assert.equal(
      harness.generationResultLedger.getEntry(pendingLease.id)
        ?.commitDisposition,
      "rejected"
    );
    assert.equal(
      harness.uiUpdates.some(
        (state) => state.latestSuggestion?.id === "visible-stale"
      ),
      false
    );
  } finally {
    harness.restore();
  }
});

test("rejects pending publication after its question or manual revision becomes stale", () => {
  for (const staleCase of ["new-question", "manual-correction"]) {
    const harness = createHarness();
    try {
      const pendingLease = {
        ...lease(),
        id: `lease-${staleCase}`,
      };
      const queued = harness.environment.queuePendingAnswerRevision({
        lease: pendingLease,
        suggestion: suggestion(
          `visible-${staleCase}`,
          "Answer: This stale candidate must not become visible."
        ),
        authorizedArtifacts: ["answer"],
        taskId: "parent-a",
        resultTaskId: "parent-a",
        sectionOwner: { kind: "parent-mainline", parentId: "parent-a" },
        taskRevision: 1,
        logicalQuestionUnitId: "lqu-current",
        logicalQuestionRevision: 1,
        sessionId: "session-a",
        runtimeEpoch: 1,
        questionSourceHash: `source-${staleCase}`,
        settlementId: `settlement-${staleCase}`,
        resetSections: false,
        reason: "delivery-lock-active",
        latestUsefulAnswerMutationAuthorized: false,
        taskRuntimeRevision: 1,
      });
      assert.ok(queued);

      if (staleCase === "new-question") {
        harness.refs.logicalQuestionUnitRef.current = {
          id: "lqu-new",
          revision: 1,
        };
      } else {
        harness.refs.manualCorrectionRevisionRef.current = 1;
      }
      harness.unlock();

      assert.equal(harness.environment.tryCommitPendingAnswer(), "stale");
      assert.equal(harness.refs.pendingAnswerRevisionRef.current, null);
      assert.equal(
        harness.refs.stableAnswerRevisionRef.current.suggestion.id,
        "visible-a"
      );
      assert.equal(
        harness.generationResultLedger.getEntry(pendingLease.id)
          ?.commitDisposition,
        "rejected"
      );
    } finally {
      harness.restore();
    }
  }
});
