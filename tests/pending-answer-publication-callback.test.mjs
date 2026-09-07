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

const callbackSources = {
  tryCommitPendingAnswer: findCallbackSource("tryCommitPendingAnswer"),
  queuePendingAnswerRevision: findCallbackSource("queuePendingAnswerRevision"),
};

const identifiers = new Set();
for (const source of Object.values(callbackSources)) {
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
  let installed = 0;
  let finalized = 0;
  let id = 0;
  const ledgerEvents = [];
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
      current: {
        recordCandidateValidation: (...args) => ledgerEvents.push(["candidate", ...args]),
        recordCommitDisposition: (...args) => ledgerEvents.push(["commit", ...args]),
      },
    },
    generationDerivedCommitCoordinatorRef: {
      current: {
        markPending: () => ({ commitDisposition: "pending" }),
        commitStaged: (input) => {
          const prepared = input.publication.prepare();
          const value = input.publication.install(prepared);
          return { committed: true, reason: "authorized", value };
        },
      },
    },
    readGenerationLeaseSnapshot: ({
      authorizedArtifacts,
      candidateMutatedArtifacts,
      logicalQuestionUnitId,
      logicalQuestionRevision,
    }) => ({
      sessionId: contextState.sessionId,
      runtimeEpoch: refs.runtimeEpochRef.current,
      preparationContextRevision:
        refs.preparationRuntimeContextRef.current.preparationContextRevision,
      taskId: "parent-a",
      taskRevision: 1,
      logicalQuestionUnitId,
      logicalQuestionRevision,
      visibleAnswerRevision: refs.visibleAnswerRevisionRef.current,
      manualCorrectionRevision: refs.manualCorrectionRevisionRef.current,
      responseActionRevision: refs.responseActionRevisionRef.current,
      artifactOwnerId: "parent-a",
      authorizedArtifacts,
      candidateMutatedArtifacts,
    }),
    schedulePendingAnswerCommit: (...args) => scheduledPendingCommits.push(args),
    publishGenerationResultProjection: () => {},
    terminalizeGenerationLease: () => {},
    transitionForceAdviseTarget: () => {},
    recordQuestionTypeAdjudicationOutcome: () => {},
    refreshRecordedCompletedTrace: () => {},
    prepareGenerationDerivedTaskRuntimeTransition: () => ({
      transition: undefined,
      latestUsefulAnswerCommitted: false,
      latestUsefulAnswerChars: 0,
    }),
    prepareStableAnswerPublication: (stable, options) => ({
      stable,
      options,
      pending: refs.pendingAnswerRevisionRef.current,
      previousStable: refs.stableAnswerRevisionRef.current,
      previousVisibleAnswerRevision: refs.visibleAnswerRevisionRef.current,
      previousManualCorrectionTargetHistory: [],
      nextManualCorrectionTargetHistory: [],
      previousPendingAnswerRevision: refs.pendingAnswerRevisionRef.current,
      previousAnswerDeliveryProgress: refs.answerDeliveryProgressRef.current,
    }),
    installPreparedStableAnswerPublication: (prepared) => {
      installed += 1;
      refs.stableAnswerRevisionRef.current = prepared.stable;
      refs.visibleAnswerRevisionRef.current = prepared.stable.revision;
      refs.pendingAnswerRevisionRef.current = null;
      refs.answerDeliveryProgressRef.current = null;
      return prepared.stable;
    },
    rollbackPreparedStableAnswerPublication: () => true,
    finalizeStableAnswerPublication: (prepared) => {
      finalized += 1;
      uiState = {
        ...uiState,
        latestSuggestion: prepared.stable.suggestion,
        latestReliableSuggestion: prepared.stable.suggestion,
        partialSuggestion: "",
        answerDelivery: {
          visibleAnswerRevision: prepared.stable.revision,
        },
      };
      uiUpdates.push({ ...uiState });
    },
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
    ledgerEvents,
    get installed() {
      return installed;
    },
    get finalized() {
      return finalized;
    },
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
    assert.equal(harness.installed, 0);
    assert.equal(harness.scheduledPendingCommits.length, 1);
    assert.equal(harness.uiState.partialSuggestion, "");

    assert.equal(harness.environment.tryCommitPendingAnswer(), "waiting");
    assert.equal(harness.installed, 0);
    assert.equal(harness.refs.pendingAnswerRevisionRef.current, queued);
    assert.equal(harness.refs.stableAnswerRevisionRef.current.revision, 1);

    harness.unlock();
    assert.equal(harness.environment.tryCommitPendingAnswer(), "committed");
    assert.equal(harness.installed, 1);
    assert.equal(harness.finalized, 1);
    assert.equal(harness.refs.pendingAnswerRevisionRef.current, null);
    assert.equal(harness.refs.stableAnswerRevisionRef.current.revision, 2);
    assert.equal(
      harness.uiState.latestSuggestion.meetingAnswer.sections.answer,
      "New answer after delivery lock."
    );
    assert.equal(harness.environment.tryCommitPendingAnswer(), "none");
    assert.equal(harness.installed, 1);
    assert.equal(harness.finalized, 1);
  } finally {
    harness.restore();
  }
});
