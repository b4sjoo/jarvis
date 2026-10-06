import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();
const compiledRoot = path.resolve(root, process.env.JARVIS_TEST_OUTPUT_DIR ?? ".tmp-tests");
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

// Task 178A: the shared helper builds the real critical event stream.
const {
  createRuntimeCriticalEventHarness,
  RUNTIME_CRITICAL_EVENT_HOOK_CALLBACKS,
} = await import(pathToFileURL(
  path.join(compiledRoot, "tests/helpers/runtime-critical-events.js")));
const callbackSources = {
  // The Hook's own emit callbacks, lifted like every other callback here.
  ...Object.fromEntries(RUNTIME_CRITICAL_EVENT_HOOK_CALLBACKS.map((name) =>
    [name, findCallbackSource(name)])),
  observeGenerationCodingManifest: findCallbackSource("observeGenerationCodingManifest"),
  validateGeneratedWhiteboard: findCallbackSource("validateGeneratedWhiteboard"),
  readStableAnswerForQuestion: findCallbackSource("readStableAnswerForQuestion"),
  isSelectedHistoricalQuestion: findCallbackSource("isSelectedHistoricalQuestion"),
  isQuestionHiddenByPin: findCallbackSource("isQuestionHiddenByPin"),
  prepareStableAnswerPublication: findCallbackSource(
    "prepareStableAnswerPublication"
  ),
  installPreparedStableAnswerPublication: findCallbackSource(
    "installPreparedStableAnswerPublication"
  ),
  rollbackPreparedStableAnswerPublication: findCallbackSource(
    "rollbackPreparedStableAnswerPublication"
  ),
  commitDirectGenerationAnswer: findCallbackSource("commitDirectGenerationAnswer"),
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
  selectAdviseDisplay: findCallbackSource("selectAdviseDisplay"),
  toggleAdvisePin: findCallbackSource("toggleAdvisePin"),
  revokeIncompleteAdvisePin: findCallbackSource("revokeIncompleteAdvisePin"),
  recordAdviseDisplayApplied: findCallbackSource("recordAdviseDisplayApplied"),
};
const helperSources = {
  updateInterviewTaskContinuityForAnswer: findFunctionSource("updateInterviewTaskContinuityForAnswer"),
  buildCompactChildSummary: findFunctionSource("buildCompactChildSummary"),
  mergeSupportedFactAnchors: findFunctionSource("mergeSupportedFactAnchors"),
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
        path.join(compiledRoot, "src", `${moduleName.slice(2)}.js`)
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
  "source-owned-transition-transaction",
  "interview-playbook",
  "playbook-phase",
  "whiteboard-artifact",
  "meeting-answer-display",
  "response-action-target",
  "artifact-regeneration",
  "coding-solution-manifest",
]) {
  const loaded = await import(
    pathToFileURL(
      path.join(compiledRoot, "src", "lib", "meeting", `${moduleName}.js`)
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
    path.join(compiledRoot, "src", "lib", "meeting", "stable-answer.js")
  )
);
const meetingAnswerModule = await import(
  pathToFileURL(
    path.join(compiledRoot, "src", "lib", "meeting", "meeting-answer.js")
  )
);
const parseMeetingAnswer = meetingAnswerModule.parseMeetingAnswer;
const commitStableAnswerRevision = stableAnswerModule.commitStableAnswerRevision;
assert.ok(parseMeetingAnswer && commitStableAnswerRevision);
const generationResultModule = await import(
  pathToFileURL(
    path.join(
      compiledRoot,
      "src",
      "lib",
      "meeting",
      "generation-result-ledger.js"
    )
  )
);
const { MeetingContextManager } = await import(pathToFileURL(
  path.join(compiledRoot, "src/lib/meeting/context-manager.js")
));
const { authorizeResponseArtifactMutation } = await import(pathToFileURL(
  path.join(compiledRoot, "src/lib/meeting/response-artifact-authorization.js")
));
const { ManualAdviseDisplay } = await import(pathToFileURL(path.join(compiledRoot, "src/lib/meeting/manual-advise-display.js")));
const { UnpublishedArtifactSlot } = await import(pathToFileURL(path.join(compiledRoot, "src/lib/meeting/unpublished-artifact.js")));

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

function createHarness(options = {}) {
  let now = options.now ?? 2_000;
  const realNow = Date.now;
  Date.now = () => now;
  const initialStable = stableAnswer();
  assert.ok(initialStable);
  const refs = {
    manualAdviseDisplayRef: { current: new ManualAdviseDisplay() },
    displayedStreamRef: { current: null },
    pinReleaseFrameRef: { current: null },
    unpublishedArtifactSlotRef: { current: new UnpublishedArtifactSlot() },
    effectiveQuestionSourceLedgerRef: { current: { list: () => [] } },
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
    recentAdvisorContinuityRef: { current: imports.prepareBoundedGeneratedContinuity({
      state: { recentCapsules: [] }, stable: initialStable,
      currentOwner: { sessionId: "session-a", runtimeEpoch: 1, parentTaskId: "parent-a" },
      parentRevision: 1, parentSummaryAllowed: true,
    }) },
  };
  const manager = new MeetingContextManager();
  manager.reset({ sessionId: "session-a" });
  const seeded = manager.commitTaskRuntimeTransition({
    id: "publication-fixture-source", transition: "create-parent", reason: "accepted-source",
    parent: {
      id: "parent-a", source: options.source ?? "voice", stableKind: "coding",
      topic: "Explain the queue invariant", playbookPhase: "baseline_reasoning",
      phaseProgress: {}, supportedFactAnchors: [], revisions: 1, createdAt: 1000, updatedAt: 1000,
      ...options.parent,
    },
    ...(options.source === "screen" ? { screenAttachment: {
      id: "screen-a", observationId: "screen-observation", basedOnObservationId: "screen-observation",
      basedOnTurnIds: [], createdAt: 1000, updatedAt: 1000, kind: "coding",
      question: "Explain the queue invariant", content: "Screen source",
    } } : {}),
    deadlineDelta: {
      parent: { ownerId: "parent-a", deadline: 600_000 },
      ...(options.source === "screen" ? { screen: { ownerId: "screen-a", deadline: 600_000 } } : {}),
    },
    appliedAt: 1000,
  });
  assert.equal(seeded.authorized, true);
  let uiState = {
    latestSuggestion: initialStable.suggestion,
    latestReliableSuggestion: initialStable.suggestion,
    partialSuggestion: "",
    answerDelivery: { visibleAnswerRevision: initialStable.revision },
  };
  const uiUpdates = [];
  const manualEvents = [];
  const scheduledPendingCommits = [];
  let id = 0;
  const generationResultLedger =
    new generationResultModule.GenerationResultLedger();
  const generationDerivedCommitCoordinator =
    new generationResultModule.GenerationDerivedCommitCoordinator(
      generationResultLedger
    );
  const environment = {
    shutdownRequestedRef: { current: false },
    factRiskReviewRuntimeRef: { current: null },
    ...imports,
    Date,
    performance: { now: () => now },
    PENDING_ANSWER_TTL_MS: 60_000,
    ANSWER_DELIVERY_IDLE_RELEASE_MS: 6_000,
    ...refs,
    state: uiState,
    recordManualRuntimeAction: (event) => manualEvents.push(event),
    readArtifactReuseInputs: () => ({ manualCorrectionRevision: refs.manualCorrectionRevisionRef.current,
      preparationContextRevision: refs.preparationRuntimeContextRef.current.preparationContextRevision, settings: {} }),
    contextManagerRef: { current: manager },
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
    toAnswerDeliveryPresentation: ({ visibleAnswerRevision }) => ({
      visibleAnswerRevision,
    }),
    createMeetingId: (prefix) => `${prefix}-${++id}`,
    setState: (updater) => {
      uiState = updater(uiState);
      environment.state = uiState;
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
  // Task 178A: the real stream, bound to this harness's runtime session.
  const criticalEvents = createRuntimeCriticalEventHarness({
    sessionId: "session-a",
    now: () => now,
    limits: options.criticalEventLimits,
    observe: options.criticalEventObserver,
  });
  Object.assign(environment, criticalEvents.hookRefs);
  const context = vm.createContext(environment);
  environment.emptyAdviseDisplay = vm.runInContext(
    transpile(`(${findCallbackSource("emptyAdviseDisplay")})()`), context
  );
  for (const source of Object.values(helperSources)) {
    vm.runInContext(transpile(source), context);
  }
  for (const [name, source] of Object.entries(callbackSources)) {
    environment[name] = vm.runInContext(transpile(`(${source})`), context);
  }
  return {
    environment,
    refs,
    manager,
    criticalEvents,
    setNow(value) { now = value; },
    evaluate(source, globals = {}) {
      Object.assign(environment, globals);
      return vm.runInContext(transpile(source), context);
    },
    get uiState() {
      return uiState;
    },
    uiUpdates,
    manualEvents,
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

function publicationCommitSource(source) {
  const callback = parse(findCallbackSource(source === "voice" ? "runAdvisor" : "captureScreenContext"));
  const matches = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === "commitDirectGenerationAnswer"
      && node.arguments[0]?.getText(callback).includes(source === "voice"
        ? "deadlineDelta: continuity.deadlineDelta" : "deadlineDelta: screenGenerationContinuity?.deadlineDelta")) {
      matches.push(node.getText(callback));
    }
    ts.forEachChild(node, visit);
  };
  visit(callback);
  assert.equal(matches.length, 1, `${source} production publication owner`);
  return matches[0];
}

function prepareOutputCandidate(h, options = {}) {
  const source = options.source ?? "voice";
  const parent = h.manager.getTaskRuntimeState().parent;
  assert.ok(parent);
  const child = parent.child;
  const relation = options.relation ?? (child ? "child-probe" : "followup-parent");
  const artifactAuthorization = authorizeResponseArtifactMutation({
    parentTaskId: parent.id, parentQuestionType: parent.stableKind,
    responseOwnerQuestionType: child?.questionType ?? parent.stableKind,
    responseOwnerSource: child ? "active-child" : "canonical-parent", relation,
    requiredArtifacts: ["answer"],
  });
  const candidate = suggestion(options.id ?? "visible-b", "Answer: The queue preserves FIFO order.");
  const continuity = h.evaluate("updateInterviewTaskContinuityForAnswer(continuityInput)", {
    continuityInput: {
      existingTask: parent, source,
      responseOwner: { questionType: child?.questionType ?? parent.stableKind,
        source: relation === "unknown" ? "current-question"
          : relation === "child-probe" ? "authorized-child" : "committed-parent", relation },
      finalContent: candidate.content, parsedAnswer: candidate.meetingAnswer,
      observationId: parent.latestScreenObservationId,
      expiresAt: options.deadline ?? Date.now() + 600_000,
      deadlineCalculatedAt: Date.now(),
      artifactAuthorization,
    },
  });
  const generationLease = { ...lease(), id: options.leaseId ?? "lease-b",
    sessionId: h.manager.getState().sessionId, runtimeEpoch: h.refs.runtimeEpochRef.current,
    taskRevision: parent.revisions, baseVisibleAnswerRevision: h.refs.visibleAnswerRevisionRef.current,
    logicalQuestionUnitId: options.lqu ?? h.refs.logicalQuestionUnitRef.current.id,
    manualCorrectionRevision: h.refs.manualCorrectionRevisionRef.current,
    responseActionRevision: h.refs.responseActionRevisionRef.current, startedAt: Date.now() };
  const sectionOwner = child ? { kind: "active-child", parentId: parent.id, childId: child.id }
    : { kind: "parent-mainline", parentId: parent.id };
  const stable = commitStableAnswerRevision({
    current: h.refs.stableAnswerRevisionRef.current, candidate, authorizedArtifacts: ["answer"],
    taskId: parent.id, sectionOwner, logicalQuestionUnitId: generationLease.logicalQuestionUnitId,
    logicalQuestionRevision: 1, sessionId: generationLease.sessionId, runtimeEpoch: generationLease.runtimeEpoch,
    questionSourceHash: "source-b", settlementId: "settlement-b", committedAt: Date.now(),
  });
  assert.ok(stable);
  const preparedTransition = h.evaluate("prepareGenerationDerivedTaskRuntimeTransition(transitionInput)", {
    transitionInput: { currentRevision: h.manager.getTaskRuntimeState().revision, currentParent: parent,
      stable, commitLatestUsefulAnswer: artifactAuthorization.allowLatestUsefulAnswer },
  });
  return { source, candidate, stable, continuity, preparedTransition, generationLease, sectionOwner,
    taskRuntimeRevision: h.manager.getTaskRuntimeState().revision,
    latestUsefulAnswerMutationAuthorized: artifactAuthorization.allowLatestUsefulAnswer };
}

function publishImmediate(h, candidate) {
  const state = h.manager.getState();
  const leaseAuthorization = imports.authorizeAnswerGenerationLease(candidate.generationLease,
    h.environment.readGenerationLeaseSnapshot({ lease: candidate.generationLease,
      authorizedArtifacts: ["answer"], candidateMutatedArtifacts: ["answer"],
      logicalQuestionUnitId: candidate.generationLease.logicalQuestionUnitId, logicalQuestionRevision: 1 }));
  const commit = h.evaluate(publicationCommitSource(candidate.source), {
    candidateStableAnswer: candidate.stable,
    answerGenerationLease: candidate.generationLease, screenGenerationLease: candidate.generationLease,
    advisorLeaseAuthorization: leaseAuthorization, screenLeaseAuthorization: leaseAuthorization,
    contextState: { ...state, taskRuntime: { ...state.taskRuntime, revision: candidate.taskRuntimeRevision } },
    advisorCommitTaskRuntimeState: h.manager.getTaskRuntimeState(), screenCommitTaskRuntimeState: h.manager.getTaskRuntimeState(),
    screenGenerationTaskRuntimeRevision: candidate.taskRuntimeRevision,
    advisorResponseCandidate: candidate.candidate, screenResponseCandidate: candidate.candidate,
    screenSourceRequiresPublication: false,
    parsedMeetingAnswer: candidate.candidate.meetingAnswer, nextSuggestion: candidate.candidate,
    generationAuthorizedArtifacts: ["answer"], screenPresentationAuthorizedArtifacts: ["answer"],
    artifactReuseInputs: h.environment.readArtifactReuseInputs(), screenArtifactReuseInputs: h.environment.readArtifactReuseInputs(),
    preparedAdvisorTransition: candidate.preparedTransition, preparedScreenTransition: candidate.preparedTransition,
    continuity: candidate.continuity, screenGenerationContinuity: candidate.continuity,
    resetVisibleSections: false, screenStartedNewInterviewParent: false, options: {},
    advisorPublication: undefined, screenPublication: undefined,
  });
  const {result, publication: prepared} = commit;
  if (result.committed) h.environment.finalizeStableAnswerPublication(prepared);
  return { result, prepared };
}

function queueOutputCandidate(h, candidate) {
  const l = candidate.generationLease;
  return h.environment.queuePendingAnswerRevision({
    lease: l, suggestion: candidate.candidate, authorizedArtifacts: ["answer"], taskId: l.taskId,
    resultTaskId: l.taskId, sectionOwner: candidate.sectionOwner, taskRevision: l.taskRevision,
    logicalQuestionUnitId: l.logicalQuestionUnitId, logicalQuestionRevision: l.logicalQuestionRevision,
    sessionId: l.sessionId, runtimeEpoch: l.runtimeEpoch, questionSourceHash: "source-b", settlementId: "settlement-b",
    resetSections: false, reason: "delivery-lock-active", taskRuntimeRevision: candidate.taskRuntimeRevision,
    latestUsefulAnswerMutationAuthorized: candidate.latestUsefulAnswerMutationAuthorized,
    childSummary: candidate.continuity.childSummary, deadlineDelta: candidate.continuity.deadlineDelta,
    deadlineCalculatedAt: candidate.continuity.deadlineCalculatedAt,
    taskRuntimeTransition: candidate.preparedTransition.transition,
  });
}

test("SG Whiteboard async validation preserves each real caller's late authorization check", async () => {
  for (const kind of ["voice", "screen"]) {
    let resolveValidation;
    const validation = new Promise(resolve => { resolveValidation = resolve; });
    const events = [];
    const env = {
      ...imports, Promise,
      traceStoreRef: { current: {
        startStep: () => { events.push("start"); return "step"; },
        updateMetadata: () => events.push("metadata"),
        finishStep: () => events.push("finish"),
      } },
      validateWhiteboardRenderCandidate: () => validation,
      parsedMeetingAnswer: { sections: { whiteboard: "Client -> Service" } },
      parsedScreenMeetingAnswer: { sections: { whiteboard: "Client -> Service" } },
      traceId: "voice", trace: { id: "screen" }, reusedArtifactCandidate: undefined,
      effectiveAdvisorSettlementView: {}, contextManagerRef: { current: { getState: () => ({}) } },
      whiteboardRenderValidation: undefined, screenWhiteboardRenderValidation: undefined,
      rejectStaleCommit: () => { events.push("stale"); return true; },
      rejectStaleScreenOperation: () => { events.push("stale"); return true; },
      rollbackStagedAnswerDelivery: () => events.push("rollback"),
    };
    const context = vm.createContext(env);
    const evaluate = text => vm.runInContext(ts.transpileModule(text, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText, context);
    env.validateGeneratedWhiteboard = evaluate(`(${callbackSources.validateGeneratedWhiteboard})`);
    const blocks = [];
    const visit = node => {
      if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === "validateGeneratedWhiteboard") {
        let parent = node.parent;
        while (!ts.isBlock(parent)) parent = parent.parent;
        blocks.push(parent);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    assert.equal(blocks.length, 2);
    const result = evaluate(`(async () => { ${blocks[kind === "voice" ? 0 : 1].getText(sourceFile)} return "continued"; })()`);
    assert.deepEqual(events, ["start"]);
    resolveValidation(await imports.validateWhiteboardRenderCandidate({ whiteboard: "Client -> Service" }));
    assert.equal(await result, undefined, "the real caller returns before later result/commit work");
    assert.deepEqual(events, ["start", "metadata", "finish", "stale", ...(kind === "voice" ? ["rollback"] : [])]);
    const cached = await imports.validateWhiteboardRenderCandidate({ whiteboard: "Client -> Service" });
    events.length = 0;
    env.validateWhiteboardRenderCandidate = () => { throw new Error("cached validation must not rerun"); };
    const reused = env.validateGeneratedWhiteboard({
      whiteboard: "Client -> Service", traceId: "reuse", reusedValidation: cached, readPrevious: () => undefined,
    });
    assert.equal(reused, cached);
    assert.equal(typeof reused.then, "undefined", "cache hit must not introduce an async release point");
    assert.deepEqual(events, ["start", "metadata", "finish"]);
  }
});

test("O1/O5.1 Voice/Screen actual commitStaged callsites install summary/Visible/deadline660 without task mutation", () => {
  for (const source of ["voice", "screen"]) {
    const h = createHarness({ now: 60_000, source });
    try {
      const before = h.manager.getTaskRuntimeState();
      const oldSummary = h.refs.recentAdvisorContinuityRef.current.latestUsefulAnswer;
      const candidate = prepareOutputCandidate(h, { source });
      assert.deepEqual(candidate.continuity.task, before.parent);
      assert.equal(candidate.preparedTransition.transition, undefined);
      assert.equal(h.manager.getTaskDeadlineControl().parent.deadline, 600_000);
      assert.equal(publishImmediate(h, candidate).result.committed, true);
      assert.deepEqual(h.manager.getTaskRuntimeState(), before);
      assert.equal(h.refs.visibleAnswerRevisionRef.current, 2);
      assert.match(h.refs.recentAdvisorContinuityRef.current.latestUsefulAnswer, /FIFO/);
      assert.equal(h.refs.recentAdvisorContinuityRef.current.previousUsefulAnswer, oldSummary);
      assert.equal(h.uiState.latestSuggestion.id, "visible-b");
      assert.equal(h.manager.getTaskDeadlineControl().parent.deadline, 660_000);
    } finally { h.restore(); }
  }
});

test("ML1/3/6 production publication and pin callbacks retain A across B/failure/D and unlock locally", () => {
  const h = createHarness();
  try {
    const select = () => h.environment.selectAdviseDisplay(imports.buildMeetingAnswerDisplayModel({
      content: h.uiState.latestSuggestion.content,
      parsedAnswer: h.uiState.latestSuggestion.meetingAnswer,
    }));
    const a = select();
    h.environment.toggleAdvisePin({ actionId: "pin-A", uiSurface: "normal-mode", displayTarget: a.target });
    for (const id of ["B", "D"]) {
      h.refs.logicalQuestionUnitRef.current = { id: `lqu-${id}`, revision: 1 };
      const s = commitStableAnswerRevision({ current: h.refs.stableAnswerRevisionRef.current,
        candidate: suggestion(id, `Answer: answer ${id}`), authorizedArtifacts: ["answer"],
        taskId: "parent-a", logicalQuestionUnitId: `lqu-${id}`, logicalQuestionRevision: 1,
        sessionId: "session-a", runtimeEpoch: 1 });
      const p = h.environment.prepareStableAnswerPublication(s);
      h.environment.installPreparedStableAnswerPublication(p);
      h.environment.finalizeStableAnswerPublication(p);
      assert.equal(select().stable.suggestion.id, "visible-a");
      assert.equal(h.refs.stableAnswerRevisionRef.current.suggestion.id, id);
      // A failed unrelated generation cannot revoke a completed pin or change latest.
      assert.equal(h.refs.manualAdviseDisplayRef.current.revokeIncomplete("failed-C"), false);
      h.setNow(100_000);
    }
    const before = h.manager.getTaskRuntimeState();
    h.environment.toggleAdvisePin({ actionId: "unlock-A", ingressSource: "shortcut", displayTarget: a.target });
    assert.equal(select().stable.suggestion.id, "D");
    assert.deepEqual(h.manager.getTaskRuntimeState(), before);
    assert.equal(h.manualEvents.filter(e => e.actionId === "unlock-A").map(e => e.stage).join(","), "requested,accepted,terminal");
    h.environment.toggleAdvisePin({ actionId: "stale-focus", uiSurface: "focus-mode", displayTarget: a.target });
    assert.equal(h.manualEvents.at(-1).terminalDisposition, "rejected");
  } finally { h.restore(); }
});

test("ML4 production selector never exposes terminal rejected partial when no legal answer exists", () => {
  const h=createHarness();
  try {
    const generation=lease();
    h.generationResultLedger.begin({lease:generation,traceId:"invalid-stream"});
    h.refs.stableAnswerRevisionRef.current=null;
    h.refs.displayedStreamRef.current={traceId:"invalid-stream",generationId:"request-invalid",leaseId:generation.id,
      logicalQuestionUnitId:generation.logicalQuestionUnitId,logicalQuestionRevision:generation.logicalQuestionRevision};
    h.environment.state={...h.uiState,partialSuggestion:"Answer: invalid partial"};
    const sections=imports.buildMeetingAnswerDisplayModel({content:"Answer: invalid partial"});
    h.environment.selectAdviseDisplay(sections);
    h.environment.toggleAdvisePin();
    h.generationResultLedger.terminalize({generationLeaseId:generation.id,disposition:"rejected",reason:"source-revoked",
      source:"test",authority:"existing-lease",candidateFormed:false});
    h.environment.revokeIncompleteAdvisePin("invalid-stream","source-revoked");
    h.environment.state={...h.uiState,partialSuggestion:"Answer: invalid partial"};
    const selected=h.environment.selectAdviseDisplay(sections);
    assert.equal(selected.streaming,false);
    assert.equal(selected.sections.primaryAnswer,"");
    assert.equal(selected.locked,false);
  } finally { h.restore(); }
});

test("ML3 real selector and display ACK keep D through repeated pre-paint renders while E streams", () => {
  const h=createHarness();
  try {
    const initial=h.environment.selectAdviseDisplay(imports.buildMeetingAnswerDisplayModel({content:h.uiState.latestSuggestion.content}));
    h.environment.toggleAdvisePin({displayTarget:initial.target});
    h.refs.logicalQuestionUnitRef.current={id:"lqu-D",revision:1};
    const d=commitStableAnswerRevision({current:h.refs.stableAnswerRevisionRef.current,
      candidate:suggestion("D","Answer: completed D"),authorizedArtifacts:["answer"],taskId:"parent-a",
      logicalQuestionUnitId:"lqu-D",logicalQuestionRevision:1,sessionId:"session-a",runtimeEpoch:1});
    const publication=h.environment.prepareStableAnswerPublication(d);
    h.environment.installPreparedStableAnswerPublication(publication);h.environment.finalizeStableAnswerPublication(publication);
    const e={...lease(),id:"lease-E",logicalQuestionUnitId:"lqu-E"};h.generationResultLedger.begin({lease:e,traceId:"trace-E"});
    h.refs.displayedStreamRef.current={traceId:"trace-E",generationId:"request-E",leaseId:e.id,
      logicalQuestionUnitId:e.logicalQuestionUnitId,logicalQuestionRevision:e.logicalQuestionRevision};
    h.environment.toggleAdvisePin({displayTarget:initial.target});
    h.environment.state={...h.uiState,partialSuggestion:"Answer: partial E"};
    const sections=imports.buildMeetingAnswerDisplayModel({content:"Answer: partial E"});
    const select=()=>h.environment.selectAdviseDisplay(sections);
    for(let render=0;render<5;render++) assert.equal(select().stable.suggestion.id,"D");
    const frames=[];h.environment.window={requestAnimationFrame:callback=>{frames.push(callback);return frames.length;}};
    h.environment.recordAdviseDisplayApplied(select().target,"normal-mode");
    assert.equal(select().stable.suggestion.id,"D");
    frames.shift()();
    assert.equal(select().stable.suggestion.id,"D","first frame paints D even after StrictMode-like retries");
    frames.shift()();
    assert.equal(select().sections.primaryAnswer,"partial E");
    assert.equal(h.refs.stableAnswerRevisionRef.current.suggestion.id,"D");
  } finally {h.restore();}
});

test("O1/O5.2 pending prepared at t60 commits at t80 with deadline660, never680", () => {
  const h = createHarness({ now: 60_000 });
  try {
    const observations = [];
    h.environment.sessionRecordingManagerRef.current = { recordCaptureLifecycle: (event) => observations.push(event) };
    const before = h.manager.getTaskRuntimeState();
    const outputBefore = h.refs.recentAdvisorContinuityRef.current;
    const candidate = prepareOutputCandidate(h);
    assert.ok(queueOutputCandidate(h, candidate));
    assert.equal(h.environment.tryCommitPendingAnswer(), "waiting");
    assert.equal(h.manager.getTaskDeadlineControl().parent.deadline, 600_000);
    assert.equal(h.refs.recentAdvisorContinuityRef.current, outputBefore);
    assert.equal(h.refs.visibleAnswerRevisionRef.current, 1);
    h.unlock(); h.setNow(80_000);
    assert.equal(h.environment.tryCommitPendingAnswer(), "committed");
    assert.equal(h.manager.getTaskDeadlineControl().parent.deadline, 660_000);
    assert.deepEqual(h.manager.getTaskRuntimeState(), before);
    assert.match(h.refs.recentAdvisorContinuityRef.current.latestUsefulAnswer, /FIFO/);
    const publication = observations.find((event) => event.stage === "stable-answer-visible-commit");
    assert.ok(publication);
    assert.equal(publication.generationDeadlineCalculatedAt, 60_000);
    assert.equal(publication.generationDeadlineCandidate.parent.deadline, 660_000);
    assert.equal(publication.generationDeadlineBefore.parent.deadline, 600_000);
    assert.equal(publication.generationDeadlineAfter.parent.deadline, 660_000);
    assert.equal(publication.generationDeadlineApplied, true);
  } finally { h.restore(); }
});

test("O1 generation cannot create a missing child after source settlement", () => {
  const h = createHarness({ now: 60_000 });
  try {
    const task = h.manager.getTaskRuntimeState();
    const output = h.refs.recentAdvisorContinuityRef.current;
    const deadline = h.manager.getTaskDeadlineControl();
    assert.throws(() => prepareOutputCandidate(h, { relation: "child-probe" }), /committed child owner/);
    assert.deepEqual(h.manager.getTaskRuntimeState(), task);
    assert.equal(h.refs.recentAdvisorContinuityRef.current, output);
    assert.deepEqual(h.manager.getTaskDeadlineControl(), deadline);
  } finally { h.restore(); }
});

test("O5.3 manual Screen timeout at t70 remains130 when old pending tries at t80", () => {
  const h = createHarness({ now: 60_000, source: "screen" });
  try {
    const oldSummary = h.refs.recentAdvisorContinuityRef.current.latestUsefulAnswer;
    const candidate = prepareOutputCandidate(h, { source: "screen" });
    candidate.continuity.deadlineDelta.screen = { ownerId: "screen-a", deadline: 660_000 };
    queueOutputCandidate(h, candidate);
    h.setNow(70_000);
    const runtime = h.manager.getTaskRuntimeState();
    const manual = h.manager.commitTaskRuntimeTransition({
      id: "manual-screen-timeout", transition: "update-source-attachment", reason: "manual-timeout",
      parent: runtime.parent, screenAttachment: runtime.screenAttachment,
      deadlineDelta: { screen: { ownerId: "screen-a", deadline: Date.now() + 60_000 } },
    });
    assert.equal(manual.authorized, true);
    assert.equal(manual.mutationApplied, true);
    const accepted = h.manager.getTaskRuntimeState();
    h.unlock(); h.setNow(80_000);
    assert.equal(h.environment.tryCommitPendingAnswer(), "stale");
    assert.equal(h.manager.getTaskDeadlineControl().screen.deadline, 130_000);
    assert.equal(h.manager.getTaskDeadlineControl().parent.deadline, 600_000);
    assert.deepEqual(h.manager.getTaskRuntimeState(), accepted);
    assert.equal(h.refs.visibleAnswerRevisionRef.current, 1);
    assert.equal(h.refs.recentAdvisorContinuityRef.current.latestUsefulAnswer, oldSummary);
  } finally { h.restore(); }
});

for (const kind of ["immediate-voice", "immediate-screen", "pending"]) {
  test(`O4/O5.7 ${kind} failed install rolls back Stable/output/deadline, preserving prior accepted source`, () => {
    const h = createHarness({ now: 60_000, source: kind === "immediate-screen" ? "screen" : "voice" });
    try {
      const beforeSource = h.manager.getTaskRuntimeState();
      assert.equal(h.manager.commitTaskRuntimeTransition({
        id: "accepted-facts", transition: "update-parent-context", reason: "accepted-source-facts",
        parent: { ...beforeSource.parent, supportedFactAnchors: ["accepted-fact"], revisions: 2, updatedAt: 59_000 },
      }).authorized, true);
      const accepted = h.manager.getTaskRuntimeState();
      const stable = h.refs.stableAnswerRevisionRef.current;
      const continuity = h.refs.recentAdvisorContinuityRef.current;
      const deadline = h.manager.getTaskDeadlineControl();
      const original = h.environment.installPreparedStableAnswerPublication;
      h.environment.installPreparedStableAnswerPublication = (prepared) => {
        original(prepared);
        assert.equal(h.manager.getTaskDeadlineControl().parent.deadline, 660_000);
        assert.equal(h.refs.visibleAnswerRevisionRef.current, 2);
        throw new Error("injected failure after real install");
      };
      const candidate = prepareOutputCandidate(h, { source: kind === "immediate-screen" ? "screen" : "voice" });
      if (kind === "pending") {
        queueOutputCandidate(h, candidate); h.unlock();
        assert.equal(h.environment.tryCommitPendingAnswer(), "stale");
      } else assert.equal(publishImmediate(h, candidate).result.committed, false);
      assert.equal(h.refs.stableAnswerRevisionRef.current, stable);
      assert.equal(h.refs.visibleAnswerRevisionRef.current, 1);
      assert.equal(h.refs.recentAdvisorContinuityRef.current, continuity);
      assert.deepEqual(h.manager.getTaskDeadlineControl(), deadline);
      assert.deepEqual(h.manager.getTaskRuntimeState(), accepted);
      assert.equal(h.generationResultLedger.getEntry(candidate.generationLease.id).applyFailure.rollbackSucceeded, true);
      assert.equal(h.uiState.latestSuggestion.id, "visible-a");
    } finally { h.restore(); }
  });
}

for (const change of ["clear", "new-parent", "session", "epoch", "phase", "source", "visible", "correction", "expired"]) {
  test(`O4/O5 pending ${change} rejects without output or deadline revival`, () => {
    const h = createHarness({ now: 60_000 });
    try {
      const candidate = prepareOutputCandidate(h);
      queueOutputCandidate(h, candidate);
      const state = h.manager.getTaskRuntimeState();
      if (change === "clear") h.manager.clearTaskRuntime({ id: "clear", scope: "all", reason: "user-clear" });
      if (change === "new-parent") assert.equal(h.manager.commitTaskRuntimeTransition({
        id: "replace", transition: "replace-parent", reason: "new-source",
        parent: { ...state.parent, id: "parent-b", revisions: 1 },
        deadlineDelta: { parent: { ownerId: "parent-b", deadline: 700_000 } },
      }).authorized, true);
      if (change === "session") h.manager.reset({ sessionId: "session-b" });
      if (change === "epoch") h.refs.runtimeEpochRef.current++;
      if (change === "phase" || change === "source") assert.equal(h.manager.commitTaskRuntimeTransition({
        id: "task-change", transition: change === "phase" ? "set-phase" : "update-parent-context", reason: "accepted-source",
        parent: { ...state.parent, revisions: 2, updatedAt: 70_000,
          ...(change === "phase" ? { playbookPhase: "optimized_pseudocode" } : { supportedFactAnchors: ["new-source-fact"] }) },
      }).authorized, true);
      if (change === "visible") h.refs.visibleAnswerRevisionRef.current++;
      if (change === "correction") h.refs.manualCorrectionRevisionRef.current++;
      const deadline = h.manager.getTaskDeadlineControl();
      const output = h.refs.recentAdvisorContinuityRef.current;
      const visible = h.refs.visibleAnswerRevisionRef.current;
      h.unlock(); h.setNow(change === "expired" ? 121_000 : 80_000);
      assert.equal(h.environment.tryCommitPendingAnswer(), "stale");
      assert.deepEqual(h.manager.getTaskDeadlineControl(), deadline);
      assert.equal(h.refs.recentAdvisorContinuityRef.current, output);
      assert.equal(h.refs.visibleAnswerRevisionRef.current, visible);
      assert.equal(h.uiState.latestSuggestion.id, "visible-a");
    } finally { h.restore(); }
  });
}

test("O5.4 successful unqualified continuation output does not renew deadline", () => {
  const h = createHarness({ now: 60_000 });
  try {
    const candidate = prepareOutputCandidate(h, { relation: "unknown" });
    assert.equal(candidate.continuity.deadlineDelta, undefined);
    const before = h.manager.getTaskRuntimeState();
    assert.equal(publishImmediate(h, candidate).result.committed, true);
    assert.equal(h.manager.getTaskDeadlineControl().parent.deadline, 600_000);
    assert.deepEqual(h.manager.getTaskRuntimeState(), before);
  } finally { h.restore(); }
});

test("O1/O4 child publication updates generated child summary while preserving parent continuity and task", () => {
  const h = createHarness({ now: 60_000, parent: {
    stableKind: "ai-ml-system-design", playbookPhase: "design_framing",
    child: { id: "child-a", questionType: "coding", relation: "child-probe", intent: "implementation-probe",
      question: "Implement a queue", basedOnTurnIds: ["turn-current"], basedOnObservationIds: [], createdAt: 1000, updatedAt: 1000 },
  } });
  try {
    const before = h.manager.getTaskRuntimeState();
    const parentSummary = h.refs.recentAdvisorContinuityRef.current.latestUsefulAnswer;
    const candidate = prepareOutputCandidate(h);
    assert.equal(candidate.preparedTransition.transition, undefined);
    assert.match(candidate.continuity.childSummary, /FIFO/);
    assert.equal(publishImmediate(h, candidate).result.committed, true);
    assert.deepEqual(h.manager.getTaskRuntimeState(), before);
    assert.equal(h.refs.recentAdvisorContinuityRef.current.latestUsefulAnswer, parentSummary);
    assert.equal(h.refs.recentAdvisorContinuityRef.current.child.childTaskId, "child-a");
    assert.match(h.refs.recentAdvisorContinuityRef.current.child.compactSummary, /FIFO/);
    assert.equal(h.manager.getTaskDeadlineControl().parent.deadline, 660_000);
  } finally { h.restore(); }
});

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

// ===========================================================================
// Task 178A: minimal critical runtime event contract.
//
// Every event read below was emitted by production Hook code that this harness
// lifted and executed. No test calls the stream's emit or builds an event.
// ===========================================================================

const { readdirSync } = await import("node:fs");
const { performance: aePerformance } = await import("node:perf_hooks");
const { createManualRuntimeActionEvent } = await import(pathToFileURL(
  path.join(compiledRoot, "src/lib/meeting/manual-runtime-action.js")));
// The real manual-action ledger writer, in place of the harness collector.
const aeUseRealManualActionLedger = (h) => {
  h.environment.recordManualRuntimeAction = h.evaluate(
    `(${findCallbackSource("recordManualRuntimeAction")})`, { createManualRuntimeActionEvent });
};
const {
  createFileBackedRecorder,
  describeRuntimeCriticalEventShape,
  normalizeRuntimeCriticalEvents,
} = await import(pathToFileURL(
  path.join(compiledRoot, "tests/helpers/runtime-critical-events.js")));

const AE_EMIT = "emitRuntimeCriticalEvent";
const AE_HELPERS = [
  "emitCurrentQuestionSettlementAdopted",
  "emitLogicalQuestionUnitCommitted",
  "announceStagedGenerationCommit",
  "observeTaskRuntimeWriter",
];

function aeEnclosingPath(node, file) {
  const names = [];
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer &&
      (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer) ||
        (ts.isCallExpression(current.initializer) &&
          ["useCallback", "useMemo"].includes(current.initializer.expression.getText(file))))) {
      names.unshift(current.name.text);
    } else if (ts.isPropertyAssignment(current) &&
      (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))) {
      names.unshift(current.name.getText(file));
    } else if (ts.isFunctionDeclaration(current) && current.name) {
      names.unshift(current.name.text);
    }
  }
  return names.filter((name) => name !== "useMeetingAssistant").join(">");
}

function aeCalls(file, names) {
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.includes(node.expression.text)) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

const aeProperty = (objectLiteral, name, file) =>
  objectLiteral.properties.find((property) => property.name?.getText(file) === name);

// The fact-to-producer table: one row per emit call site in the Hook, as
// "<fact>[:<terminal object>] @ <enclosing symbol>".
const AE_PRODUCER_TABLE = [
  "input-accepted @ processCanonicalTurnIngress",
  "input-accepted @ captureScreenContext",
  "input-accepted @ recordManualRuntimeAction",
  "lqu-committed @ emitLogicalQuestionUnitCommitted",
  "type-settled @ emitCurrentQuestionSettlementAdopted",
  "relation-settled @ emitCurrentQuestionSettlementAdopted",
  "lifecycle-committed @ observeTaskRuntimeWriter",
  "generation-admitted @ runAdvisor",
  "generation-admitted @ captureScreenContext",
  "provider-request-started @ runAdvisor>onRequest",
  "provider-request-started @ captureScreenContext>onRequest",
  "provider-request-started @ scheduleTaskRelationSplitRuntime>runCandidates>request",
  "stable-answer-committed @ finalizeStableAnswerPublication",
  "artifact-committed @ announceStagedGenerationCommit",
  "first-visible-content @ recordAdviseDisplayApplied",
  "terminal:provider-request @ runAdvisor>onTerminal",
  "terminal:provider-request @ captureScreenContext>onTerminal",
  "terminal:provider-request @ scheduleTaskRelationSplitRuntime>runCandidates>onObservation",
  "terminal:generation @ publishGenerationResultProjection",
  "terminal:screen-operation @ captureScreenContext>rejectStaleScreenOperation",
  // The flow's end: the owner's release, or its exit after it lost the slot.
  "terminal:screen-operation @ captureScreenContext",
  "terminal:screen-operation @ captureScreenContext",
  "terminal:manual-action @ recordManualRuntimeAction",
  "input-accepted @ submitSpeechCorrection",
  "input-accepted @ deactivateSpeechCorrection",
  "terminal:manual-action @ submitSpeechCorrection",
  "terminal:manual-action @ submitSpeechCorrection",
  "terminal:manual-action @ submitSpeechCorrection",
  "terminal:manual-action @ submitSpeechCorrection",
  "terminal:manual-action @ deactivateSpeechCorrection",
  "terminal:manual-action @ deactivateSpeechCorrection",
  "terminal:manual-action @ deactivateSpeechCorrection",
  "terminal:lifecycle-transition @ observeTaskRuntimeWriter",
];
// Where the owner confirmation points call the shared Hook producers.
const AE_PRODUCER_CALL_SITES = [
  "emitLogicalQuestionUnitCommitted @ publishCanonicalLogicalQuestionTarget",
  "emitLogicalQuestionUnitCommitted @ submitSpeechCorrection",
  "emitLogicalQuestionUnitCommitted @ deactivateSpeechCorrection",
  "emitCurrentQuestionSettlementAdopted @ runAdvisor",
  "emitCurrentQuestionSettlementAdopted @ runAdvisor",
  "emitCurrentQuestionSettlementAdopted @ runAdvisor>commitDeferredResponseAuthorizedState",
  "emitCurrentQuestionSettlementAdopted @ captureScreenContext",
  "emitCurrentQuestionSettlementAdopted @ correctActiveQuestionType",
  "emitCurrentQuestionSettlementAdopted @ correctActiveQuestionType",
  "emitCurrentQuestionSettlementAdopted @ submitSpeechCorrection",
  "announceStagedGenerationCommit @ commitDirectGenerationAnswer",
  "announceStagedGenerationCommit @ tryCommitPendingAnswer",
  "observeTaskRuntimeWriter @ announceStagedGenerationCommit",
  "observeTaskRuntimeWriter @ setActiveScreenTaskTimeoutMinutes",
  "observeTaskRuntimeWriter @ clearActiveTask",
  "observeTaskRuntimeWriter @ stop",
  "observeTaskRuntimeWriter @ runAdvisor",
  "observeTaskRuntimeWriter @ runAdvisor",
  "observeTaskRuntimeWriter @ runAdvisor",
  "observeTaskRuntimeWriter @ runAdvisor",
  "observeTaskRuntimeWriter @ captureScreenContext",
  "observeTaskRuntimeWriter @ captureScreenContext",
  "observeTaskRuntimeWriter @ correctActiveQuestionType",
  "observeTaskRuntimeWriter @ setPreparationRuntimeCapabilities",
  "observeTaskRuntimeWriter @ applyResponseAction",
  "observeTaskRuntimeWriter @ submitSpeechCorrection",
];

test("AE1 static gate: every emit call site is in the fact-to-producer table, with a literal fact and its own purpose", () => {
  // A per-invocation const snapshot can provide identity through an object spread.
  // Follow only local const object literals; arbitrary calls or mutable lookups do not qualify.
  const identityProperty = (input, name, scope, seen = new Set()) => {
    const direct = aeProperty(input, name, sourceFile);
    if (direct) return direct;
    for (const spread of input.properties.filter(ts.isSpreadAssignment)) {
      if (!ts.isIdentifier(spread.expression) || seen.has(spread.expression.text)) continue;
      const id = spread.expression.text;
      seen.add(id);
      let local;
      const visit = node => {
        if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === id &&
          ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const)) local = node;
        ts.forEachChild(node, visit);
      };
      visit(scope);
      if (local?.initializer && ts.isObjectLiteralExpression(local.initializer)) {
        const found = identityProperty(local.initializer, name, scope, seen);
        if (found) return found;
      }
    }
    return undefined;
  };
  const rows = aeCalls(sourceFile, [AE_EMIT]).map((call) => {
    const input = call.arguments[0];
    assert.ok(input && ts.isObjectLiteralExpression(input), "an emit takes one object literal");
    const fact = aeProperty(input, "fact", sourceFile)?.initializer;
    assert.ok(fact && ts.isStringLiteral(fact), "the fact is a string literal");
    const purpose = aeProperty(input, "purpose", sourceFile)?.initializer.getText(sourceFile).replace(/\s+/g, " ");
    const path = aeEnclosingPath(call, sourceFile);
    // Only the shared Relation candidate point runs observation work, and it
    // takes the purpose from the schedule's own entry.
    assert.equal(purpose, path.startsWith("scheduleTaskRelationSplitRuntime")
      ? 'runtimeReleaseRequested ? "formal" : "observation"' : '"formal"', path);
    let scope = call.parent;
    while (scope && !ts.isArrowFunction(scope) && !ts.isFunctionExpression(scope) && !ts.isFunctionDeclaration(scope)) scope = scope.parent;
    assert.ok(identityProperty(input, "runtimeSessionId", scope), `${path}: the fact names its own session`);
    const terminal = aeProperty(input, "terminal", sourceFile)?.initializer;
    const object = terminal ? aeProperty(terminal, "object", sourceFile).initializer.text : undefined;
    assert.equal(fact.text === "terminal", Boolean(object), path);
    return `${fact.text}${object ? `:${object}` : ""} @ ${path}`;
  });
  assert.deepEqual([...rows].sort(), [...AE_PRODUCER_TABLE].sort());
  assert.deepEqual(new Set(AE_PRODUCER_TABLE.map((row) => row.split(/[: ]/)[0])),
    new Set(["input-accepted", "lqu-committed", "type-settled", "relation-settled", "lifecycle-committed",
      "generation-admitted", "provider-request-started", "stable-answer-committed", "artifact-committed",
      "first-visible-content", "terminal"]), "all eleven facts have a producer");

  const sites = aeCalls(sourceFile, AE_HELPERS)
    .map((call) => `${call.expression.text} @ ${aeEnclosingPath(call, sourceFile)}`);
  assert.deepEqual([...sites].sort(), [...AE_PRODUCER_CALL_SITES].sort());

  // The sole task writer is called in five Hook places; each hands the writer's
  // own result to the observer or, for a staged install, announces only after
  // the coordinator returned.
  const writerCalls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      ["commitTaskRuntimeTransition", "commitPreparedTaskRuntimeTransition", "clearTaskRuntime"]
        .includes(node.expression.name.text)) writerCalls.push(aeEnclosingPath(node, sourceFile));
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.deepEqual(writerCalls.sort(), [
    "commitDirectGenerationAnswer>install", "commitPlannedTaskRuntimeTransition",
    "submitTaskRuntimeClear", "submitTaskRuntimeTransition", "tryCommitPendingAnswer>install",
  ]);
  for (const adapter of ["submitTaskRuntimeTransition", "commitPlannedTaskRuntimeTransition", "submitTaskRuntimeClear"]) {
    assert.match(findFunctionSource(adapter), /observeWriter\?\.\(\s*(result|runtimeResult),/, adapter);
  }
  for (const name of ["submitTaskRuntimeTransition", "submitTaskRuntimeClear"]) {
    for (const call of aeCalls(sourceFile, [name])) {
      assert.equal(call.arguments.length, 3, `${name} in ${aeEnclosingPath(call, sourceFile)} passes the observer`);
    }
  }
  for (const name of ["commitSourceOwnedTransitionWithManager", "commitPlannedTaskRuntimeTransition"]) {
    for (const call of aeCalls(sourceFile, [name])) {
      assert.ok(aeProperty(call.arguments[0], "observeWriter", sourceFile),
        `${name} in ${aeEnclosingPath(call, sourceFile)} passes the observer`);
    }
  }
  // No emit inside a staged-commit callback.
  for (const call of aeCalls(sourceFile, [AE_EMIT, ...AE_HELPERS])) {
    assert.doesNotMatch(aeEnclosingPath(call, sourceFile), />(install|rollback|prepare)$/);
  }

  // Type settled and Relation settled, one rule for every source: each
  // assignment of a settlement as the session's current settlement is followed
  // at once by its announcement, with that same settlement.
  const adoptions = [];
  const visitAdoption = (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText(sourceFile) === "currentQuestionSettlementRef.current" &&
      node.right.getText(sourceFile) !== "undefined") {
      const statement = node.parent;
      assert.ok(ts.isExpressionStatement(statement) && ts.isBlock(statement.parent));
      const next = statement.parent.statements[statement.parent.statements.indexOf(statement) + 1];
      const where = aeEnclosingPath(node, sourceFile);
      assert.ok(next && ts.isExpressionStatement(next) && ts.isCallExpression(next.expression) &&
        next.expression.expression.getText(sourceFile) === "emitCurrentQuestionSettlementAdopted",
        `${where}: the adoption is announced by the next statement`);
      assert.equal(next.expression.arguments[0].getText(sourceFile).replace(/\s+/g, ""),
        node.right.getText(sourceFile).replace(/\s+/g, ""), `${where}: the announced settlement is the adopted one`);
      adoptions.push(`${where} ${next.expression.arguments[2]?.getText(sourceFile).replace(/\s+/g, " ") ?? '"settlement-adopted"'}`);
    }
    ts.forEachChild(node, visitAdoption);
  };
  visitAdoption(sourceFile);
  assert.deepEqual(adoptions.sort(), [
    'captureScreenContext "settlement-adopted"',
    'correctActiveQuestionType "manual-retype-projection"',
    'correctActiveQuestionType "settlement-adopted"',
    'runAdvisor "effective-settlement-adopted"',
    'runAdvisor "settlement-adopted"',
    // The deferred adoption names what it assigns: the run's effective view, once that replaced its own settlement.
    'runAdvisor>commitDeferredResponseAuthorizedState currentQuestionSettlement === effectiveAdvisorSettlementView.effectiveSettlement ? "effective-settlement-adopted" : "settlement-adopted"',
    'submitSpeechCorrection "settlement-adopted"',
  ]);

  // A manual action's facts carry the identity of its first record, never the
  // session or epoch read when a later stage is recorded.
  const manualRecorder = parse(findCallbackSource("recordManualRuntimeAction"));
  for (const call of aeCalls(manualRecorder, [AE_EMIT])) {
    const input = call.arguments[0];
    assert.equal(aeProperty(input, "runtimeSessionId", manualRecorder).initializer.getText(manualRecorder), "origin.runtimeSessionId");
    assert.equal(aeProperty(input, "runtimeEpoch", manualRecorder).initializer.getText(manualRecorder), "origin.runtimeEpoch");
  }

  // AE3: the shared producers and the emit function read no Debug, Cross-checks
  // or Recording-enabled switch. Whether an event is saved is the Recording
  // owner's own answer to the one synchronous call.
  for (const name of [AE_EMIT, ...AE_HELPERS, "recordManualRuntimeAction", "recordAdviseDisplayApplied"]) {
    const source = name === "recordAdviseDisplayApplied"
      ? findCallbackSource(name).slice(0, findCallbackSource(name).indexOf("if (target.traceId && target.stableRevision"))
      : findCallbackSource(name);
    assert.doesNotMatch(source, /debugModeRef|runtimeCrossChecksEnabledRef|settings\.debugMode|sessionRecordingEnabled/, name);
  }
});

test("AE1/AE4 static gate: the stream is written only by the Hook, and the runtime never reads it", () => {
  // The Hook touches the stream to bind, close, release and emit. It never
  // subscribes and never reads counters to decide anything.
  const uses = [];
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && node.getText(sourceFile).replace(/\?/g, "")
      .startsWith("runtimeCriticalEventStreamRef.current.")) {
      uses.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  // bind: first render, the session reset and the effect's (re)mount.
  // closeSubscriptions: Stop and the scenario-runner stop. release: unmount.
  assert.deepEqual(uses.sort(), ["bind", "bind", "bind", "closeSubscriptions", "closeSubscriptions", "release"]);
  const emitter = parse(findCallbackSource(AE_EMIT));
  const streamMethods = [];
  const visitEmitter = (node) => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "stream") {
      streamMethods.push(node.name.text);
    }
    ts.forEachChild(node, visitEmitter);
  };
  visitEmitter(emitter);
  assert.deepEqual(streamMethods.sort(), ["emit", "noteRecording", "noteRecordingFailure"]);
  assert.equal((hookSource.match(/recordRuntimeCriticalEvent\(/g) ?? []).length, 1,
    "one synchronous Recording call, right after emit");
  assert.equal(hookSource.includes(".subscribe(") && /runtimeCriticalEventStream[^\n]*subscribe/.test(hookSource), false);
  assert.equal(/getStats\(/.test(hookSource), false);

  // The leaf imports nothing, and only the Hook and the Recording owner import it.
  const leaf = readFileSync(path.join(root, "src/lib/meeting/runtime-critical-event.ts"), "utf8");
  assert.equal(/^\s*import\s/m.test(leaf), false, "the leaf module has no imports");
  assert.doesNotMatch(leaf, /commitTaskRuntimeTransition|clearTaskRuntime|context-manager/);
  const importers = readdirSync(path.join(root, "src"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .filter((file) => readFileSync(path.join(root, file), "utf8").includes("runtime-critical-event"))
    .sort();
  assert.deepEqual(importers, [
    "src/hooks/useMeetingAssistant.ts",
    "src/lib/meeting/session-recording.ts",
  ]);
  const barrel = readFileSync(path.join(root, "src/lib/meeting/index.ts"), "utf8");
  assert.doesNotMatch(barrel, /runtime-critical-event/, "no barrel export");
});

test("AE4 static gate: no emit is awaited, every emit is a bare statement whose value is not used, and the Hook's own producers are synchronous", () => {
  const calls = aeCalls(sourceFile, [AE_EMIT, ...AE_HELPERS]);
  assert.ok(calls.length >= AE_PRODUCER_TABLE.length + AE_PRODUCER_CALL_SITES.length);
  for (const call of calls) {
    const where = `${call.expression.text} in ${aeEnclosingPath(call, sourceFile)}`;
    for (let current = call.parent; current && !ts.isFunctionLike(current); current = current.parent) {
      assert.equal(ts.isAwaitExpression(current), false, `${where} is not awaited`);
    }
    if (call.expression.text !== "observeTaskRuntimeWriter") {
      // The producer never branches on an emit: its value is discarded.
      assert.ok(ts.isExpressionStatement(call.parent), `${where} is a bare statement`);
      continue;
    }
    // The writer observer it returns is handed to a writer adapter, or called
    // at once with the writer's own result. Nothing else reads it.
    const handedOver = (ts.isCallExpression(call.parent) && call.parent.arguments.includes(call)) ||
      (ts.isPropertyAssignment(call.parent) && call.parent.name.getText(sourceFile) === "observeWriter");
    const calledAtOnce = ts.isCallExpression(call.parent) && call.parent.expression === call &&
      ts.isExpressionStatement(call.parent.parent);
    assert.ok(handedOver || calledAtOnce, `${where} is handed to the writer adapter or called as a bare statement`);
  }
  // The emit function and the shared producers neither await nor return a promise.
  for (const name of [AE_EMIT, ...AE_HELPERS]) {
    const producer = parse(`(${findCallbackSource(name)})`);
    let asynchronous = false;
    const visit = (node) => {
      if (ts.isAwaitExpression(node) ||
        (ts.isFunctionLike(node) && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))) {
        asynchronous = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(producer);
    assert.equal(asynchronous, false, `${name} is synchronous`);
  }
});

// A candidate that changes Code and Complexity, committed through the real
// direct commit owner (the same call Voice and Screen make).
function aeArtifactCandidate(h, { id, code }) {
  const parent = h.manager.getTaskRuntimeState().parent;
  const content = `Answer: Use a deque for ${id}.\n\nCode:\n\`\`\`ts\n${code}\n\`\`\`\n\nComplexity: O(1)`;
  const candidate = suggestion(id, content);
  const generationLease = { ...lease(), id: `lease-${id}`, taskRevision: parent.revisions,
    baseVisibleAnswerRevision: h.refs.visibleAnswerRevisionRef.current,
    requestedArtifacts: ["answer", "code", "complexity"], startedAt: Date.now() };
  const current = h.refs.stableAnswerRevisionRef.current;
  const stable = commitStableAnswerRevision({
    current, candidate, authorizedArtifacts: ["answer", "code", "complexity"], taskId: parent.id,
    sectionOwner: { kind: "parent-mainline", parentId: parent.id },
    logicalQuestionUnitId: "lqu-current", logicalQuestionRevision: 1, sessionId: "session-a", runtimeEpoch: 1,
    questionSourceHash: "source-b", settlementId: "settlement-b", committedAt: Date.now(),
  });
  assert.ok(stable);
  return { candidate, generationLease, stable,
    mutated: imports.collectStableAnswerMutationDelta(current, stable).candidateMutatedArtifacts };
}

function aeCommitDirect(h, prepared, { transition } = {}) {
  const authorizedArtifacts = ["answer", "code", "complexity"];
  const leaseAuthorization = imports.authorizeAnswerGenerationLease(prepared.generationLease,
    h.environment.readGenerationLeaseSnapshot({ lease: prepared.generationLease, authorizedArtifacts,
      candidateMutatedArtifacts: prepared.mutated, logicalQuestionUnitId: "lqu-current", logicalQuestionRevision: 1 }));
  const revision = h.manager.getTaskRuntimeState().revision;
  const commit = h.environment.commitDirectGenerationAnswer({
    lease: prepared.generationLease, leaseAuthorization,
    expectedTaskRuntimeRevision: revision, currentTaskRuntimeRevision: revision,
    candidateAccepted: true, candidate: prepared.stable, transition, authorizedArtifacts,
    publicationOptions: { clearPrevious: false },
  });
  if (commit.result.committed) h.environment.finalizeStableAnswerPublication(commit.publication);
  // As Voice and Screen do after their commit. The harness stubs this
  // projection unless a test installs the real one.
  h.environment.publishGenerationResultProjection(prepared.generationLease, prepared.candidate.sourceTraceId);
  return commit.result;
}

const aeFacts = (h, purpose) => h.criticalEvents.facts(purpose);
const aeEventsOf = (h, fact) => h.criticalEvents.events().filter((event) => event.fact === fact);

test("AE1/AE2 Stable Answer and Artifact: announced only after the real staged commit, one Artifact fact per section whose revision changed", () => {
  const h = createHarness({ now: 60_000 });
  try {
    assert.deepEqual(aeFacts(h), [], "building the harness and its fixtures emits nothing");
    const first = aeArtifactCandidate(h, { id: "code-a", code: "return queue.shift();" });
    assert.deepEqual(first.mutated, ["answer", "code", "complexity"]);
    // Building a candidate revision is not a commit: the pure builders stay silent.
    assert.deepEqual(aeFacts(h), []);
    assert.equal(aeCommitDirect(h, first).committed, true);
    assert.deepEqual(aeFacts(h), [
      "artifact-committed:section-revision-changed",
      "artifact-committed:section-revision-changed",
      "stable-answer-committed:stable-publication",
    ]);
    const artifacts = aeEventsOf(h, "artifact-committed");
    assert.deepEqual(artifacts.map((event) => [event.refs.artifact, event.refs.artifactRevision]),
      [["code", 1], ["complexity", 1]]);
    const stable = aeEventsOf(h, "stable-answer-committed")[0];
    assert.equal(stable.runtimeSessionId, "session-a");
    assert.equal(stable.runtimeEpoch, 1);
    assert.equal(stable.occurredAt, first.stable.committedAt, "the owner's own commit time");
    assert.deepEqual({ ...stable.refs }, {
      traceId: "trace-code-a", logicalQuestionUnitId: "lqu-current", settlementId: "settlement-b",
      taskId: "parent-a", suggestionId: "code-a", logicalQuestionRevision: 1, stableRevision: 2,
    });
    for (const event of h.criticalEvents.events()) {
      assert.deepEqual(describeRuntimeCriticalEventShape(event), []);
      assert.equal(event.purpose, "formal");
      assert.equal(JSON.stringify(event).includes("deque"), false, "no Answer text travels in an event");
      assert.equal(JSON.stringify(event).includes("queue.shift"), false, "no Code travels in an event");
    }

    // The same Code again: the Answer changes, the Artifact revision does not.
    const second = aeArtifactCandidate(h, { id: "code-b", code: "return queue.shift();" });
    assert.deepEqual(second.mutated, ["answer"]);
    assert.equal(aeCommitDirect(h, second).committed, true);
    assert.equal(aeEventsOf(h, "artifact-committed").length, 2, "no revision change, no Artifact fact");
    assert.equal(aeEventsOf(h, "stable-answer-committed").length, 2);

    // Only Code changes.
    const third = aeArtifactCandidate(h, { id: "code-c", code: "return queue.pop();" });
    assert.deepEqual(third.mutated, ["answer", "code"]);
    assert.equal(aeCommitDirect(h, third).committed, true);
    assert.deepEqual(aeEventsOf(h, "artifact-committed").slice(2)
      .map((event) => [event.refs.artifact, event.refs.artifactRevision, event.refs.stableRevision]), [["code", 2, 4]]);
    const sequences = h.criticalEvents.events().map((event) => event.sequence);
    assert.deepEqual(sequences, sequences.map((_, index) => index + 1), "one monotonic sequence for the session");
  } finally { h.restore(); }
});

test("AE1/AE2 Lifecycle through a staged commit: one fact from the writer's own receipt after the commit returned; a rolled-back install announces nothing", () => {
  for (const failInstall of [false, true]) {
    const h = createHarness({ now: 60_000 });
    try {
      h.evaluate(findFunctionSource("prepareGenerationDerivedTaskRuntimeCommit"));
      const before = h.manager.getTaskRuntimeState();
      const prepared = aeArtifactCandidate(h, { id: "code-a", code: "return 1;" });
      if (failInstall) {
        const original = h.environment.installPreparedStableAnswerPublication;
        h.environment.installPreparedStableAnswerPublication = (publication) => {
          original(publication);
          // The task writer has already committed inside the staged install.
          assert.equal(h.manager.getTaskRuntimeState().revision, before.revision + 1);
          throw new Error("injected failure after real install");
        };
      }
      const result = aeCommitDirect(h, prepared, { transition: {
        transition: "update-parent-context", reason: "generation-derived-context",
        expectedRevision: before.revision,
        parent: { ...before.parent, supportedFactAnchors: ["generated-fact"],
          revisions: before.parent.revisions + 1, updatedAt: 60_000 },
      } });
      assert.equal(result.committed, !failInstall);
      if (failInstall) {
        assert.deepEqual(h.manager.getTaskRuntimeState(), before, "the install was rolled back");
        assert.deepEqual(aeFacts(h), [], "a rolled-back staged commit announces no Lifecycle, Artifact or Stable fact");
        continue;
      }
      const after = h.manager.getTaskRuntimeState();
      assert.deepEqual(aeFacts(h), [
        "lifecycle-committed:task-writer-committed",
        "artifact-committed:section-revision-changed",
        "artifact-committed:section-revision-changed",
        "stable-answer-committed:stable-publication",
      ]);
      const lifecycle = aeEventsOf(h, "lifecycle-committed")[0];
      assert.equal(lifecycle.refs.receiptId, after.lastMutation.id, "the writer's receipt");
      assert.equal(lifecycle.refs.taskRuntimeRevision, after.revision);
      assert.equal(lifecycle.occurredAt, after.lastMutation.appliedAt);
      assert.equal(lifecycle.refs.transition, "update-parent-context");
      assert.equal(lifecycle.refs.generationLeaseId, "lease-code-a");
      assert.equal(lifecycle.refs.taskId, "parent-a");
    } finally { h.restore(); }
  }
});

test("AE2 delivery lock: a queued answer is not a Stable Answer fact until its real release commits; a stale release emits no success", () => {
  for (const stale of [false, true]) {
    const h = createHarness({ now: 60_000 });
    try {
      const candidate = prepareOutputCandidate(h);
      assert.ok(queueOutputCandidate(h, candidate));
      assert.equal(h.environment.tryCommitPendingAnswer(), "waiting");
      assert.deepEqual(aeFacts(h), [], "queued and waiting: nothing committed, nothing announced");
      if (stale) h.refs.manualCorrectionRevisionRef.current += 1;
      h.unlock(); h.setNow(80_000);
      assert.equal(h.environment.tryCommitPendingAnswer(), stale ? "stale" : "committed");
      assert.deepEqual(aeFacts(h), stale ? [] : ["stable-answer-committed:stable-publication"]);
      assert.equal(aeEventsOf(h, "first-visible-content").length, 0, "a commit is not a display");
    } finally { h.restore(); }
  }
});

test("AE2 a pinned answer: the background commit is a Stable Answer fact and no visible fact; repeated ACKs of one target are one first-visible fact", () => {
  const h = createHarness();
  try {
    h.environment.window = { requestAnimationFrame: () => 1, cancelAnimationFrame() {} };
    aeUseRealManualActionLedger(h);
    const select = () => h.environment.selectAdviseDisplay(imports.buildMeetingAnswerDisplayModel({
      content: h.uiState.latestSuggestion.content, parsedAnswer: h.uiState.latestSuggestion.meetingAnswer }));
    const a = select();
    for (let ack = 0; ack < 3; ack += 1) h.environment.recordAdviseDisplayApplied(a.target, "normal-mode");
    h.environment.recordAdviseDisplayApplied(a.target, "focus-mode", false);
    assert.deepEqual(aeFacts(h), ["first-visible-content:stable"], "four ACKs, one first-visible fact");
    const visibleA = aeEventsOf(h, "first-visible-content")[0];
    assert.equal(visibleA.refs.suggestionId, "visible-a");
    assert.equal(visibleA.refs.stableRevision, 1);
    assert.equal(visibleA.refs.displaySurface, "normal-mode");
    assert.equal("runtimeEpoch" in visibleA, false, "the display target carries no epoch, so none is invented");

    h.environment.toggleAdvisePin({ actionId: "pin-A", uiSurface: "normal-mode", displayTarget: a.target });
    // B commits in the background while A stays on screen.
    h.refs.logicalQuestionUnitRef.current = { id: "lqu-B", revision: 1 };
    const b = commitStableAnswerRevision({ current: h.refs.stableAnswerRevisionRef.current,
      candidate: suggestion("B", "Answer: answer B"), authorizedArtifacts: ["answer"], taskId: "parent-a",
      logicalQuestionUnitId: "lqu-B", logicalQuestionRevision: 1, sessionId: "session-a", runtimeEpoch: 1 });
    const publication = h.environment.prepareStableAnswerPublication(b);
    h.environment.installPreparedStableAnswerPublication(publication);
    h.environment.finalizeStableAnswerPublication(publication);
    assert.equal(select().stable.suggestion.id, "visible-a", "A is still the displayed answer");
    // The UI keeps acknowledging what it shows: still A.
    for (let ack = 0; ack < 3; ack += 1) h.environment.recordAdviseDisplayApplied(select().target, "normal-mode");
    assert.deepEqual(aeFacts(h), [
      "first-visible-content:stable",
      "input-accepted:manual-action-accepted",
      "terminal:manual-action:completed",
      "stable-answer-committed:stable-publication",
    ]);
    assert.equal(aeEventsOf(h, "stable-answer-committed")[0].refs.suggestionId, "B");
    assert.equal(aeEventsOf(h, "first-visible-content").some((event) => event.refs.suggestionId === "B"), false,
      "the locked background answer has no visible fact");

    // Unlock, render B, acknowledge it: now and only now B is visible.
    h.environment.toggleAdvisePin({ actionId: "unlock-A", displayTarget: a.target });
    const shown = select();
    assert.equal(shown.stable.suggestion.id, "B");
    h.environment.recordAdviseDisplayApplied(shown.target, "normal-mode");
    h.environment.recordAdviseDisplayApplied(shown.target, "normal-mode");
    const visible = aeEventsOf(h, "first-visible-content");
    assert.deepEqual(visible.map((event) => event.refs.suggestionId), ["visible-a", "B"]);
    // A display target from another session is refused by the event layer.
    h.environment.recordAdviseDisplayApplied({ ...shown.target, sessionId: "session-old", stableRevision: 9 }, "normal-mode");
    // An empty display shows no content.
    h.environment.recordAdviseDisplayApplied({ sessionId: "session-a" }, "normal-mode");
    assert.equal(aeEventsOf(h, "first-visible-content").length, 2);
    const stats = h.criticalEvents.stream.getStats();
    assert.equal(stats.staleSessionRejected, 1);
    assert.equal(stats.missingIdentityRejected, 1);
    assert.equal(stats.duplicateSuppressed, 7);
    // A rejected manual action is a terminal and never an acceptance.
    h.environment.toggleAdvisePin({ actionId: "stale-focus", uiSurface: "focus-mode", displayTarget: a.target });
    const manual = h.criticalEvents.events().filter((event) => event.refs.manualActionId === "stale-focus");
    assert.deepEqual(manual.map((event) => [event.fact, event.terminal?.disposition]), [["terminal", "rejected"]]);
  } finally { h.restore(); }
});

test("AE2 manual release of a pending candidate (pin toggle and the Force Advise branch): a Stable Answer fact with no Generation and no Provider fact", () => {
  // The Force Advise branch that releases an already generated pending candidate.
  const forceAdvise = parse(findCallbackSource("forceAdviseLatestTurn"));
  let releaseBranch;
  const visit = (node) => {
    if (ts.isIfStatement(node) && node.expression.getText(forceAdvise) === "pendingMatchesTarget") releaseBranch = node;
    ts.forEachChild(node, visit);
  };
  visit(forceAdvise);
  assert.ok(releaseBranch, "production Force Advise pending-release branch");
  const block = releaseBranch.parent.statements;
  const index = block.indexOf(releaseBranch);
  const releaseSource = block.slice(index - 2, index + 1).map((statement) => statement.getText(forceAdvise)).join("\n");
  assert.match(releaseSource, /const pendingCandidate = pendingAnswerRevisionRef\.current;/);

  for (const entry of ["pin-toggle", "force-advise"]) {
    const h = createHarness({ now: 60_000 });
    try {
      aeUseRealManualActionLedger(h);
      const select = () => h.environment.selectAdviseDisplay(imports.buildMeetingAnswerDisplayModel({
        content: h.uiState.latestSuggestion.content, parsedAnswer: h.uiState.latestSuggestion.meetingAnswer }));
      const candidate = prepareOutputCandidate(h);
      assert.ok(queueOutputCandidate(h, candidate));
      assert.equal(h.environment.tryCommitPendingAnswer(), "waiting");
      assert.deepEqual(aeFacts(h), []);
      if (entry === "pin-toggle") {
        h.environment.toggleAdvisePin({ actionId: "pin-A", uiSurface: "normal-mode", displayTarget: select().target });
      } else {
        h.environment.traceStoreRef.current.finishTrace = () => {};
        h.environment.recordManualRuntimeAction({ actionId: "force-1", action: "force-advise", stage: "accepted",
          traceId: "repair-trace", observedLogicalQuestionUnitId: "lqu-current", observedLogicalQuestionUnitRevision: 1 });
        h.evaluate(`(() => { ${releaseSource} return "advisor-would-run"; })()`, {
          target: { presentation: { targetId: "target-1" }, logicalQuestionUnit: { id: "lqu-current", revision: 1 } },
          repairTrace: { id: "repair-trace" }, manualActionId: "force-1", forceAdviseEvaluationActionId: "evaluation-1",
        });
      }
      assert.equal(h.refs.stableAnswerRevisionRef.current.suggestion.id, "visible-b", "the pending candidate was released");
      const facts = aeFacts(h);
      assert.deepEqual(facts, [
        "input-accepted:manual-action-accepted",
        "stable-answer-committed:stable-publication",
        "terminal:manual-action:completed",
      ]);
      for (const absent of ["generation-admitted", "provider-request-started", "first-visible-content", "lifecycle-committed"]) {
        assert.equal(facts.some((fact) => fact.startsWith(absent)), false, `${entry}: no ${absent}`);
      }
      const [accepted, , terminal] = h.criticalEvents.events();
      assert.equal(accepted.refs.manualAction, entry === "pin-toggle" ? "toggle-advise-pin" : "force-advise");
      assert.equal(accepted.refs.manualActionId, terminal.refs.manualActionId);
      assert.equal(terminal.terminal.object, "manual-action");
    } finally { h.restore(); }
  }
});

test("AE2 one generation is first visible once: the streaming ACK is the first, and the stable ACK of the same generation that follows is not a second (real selector and ACK)", () => {
  const h = createHarness({ now: 60_000 });
  try {
    h.environment.window = { requestAnimationFrame: () => 1, cancelAnimationFrame() {} };
    // Generation E is admitted and its partial is the displayed stream.
    const e = aeArtifactCandidate(h, { id: "request-E", code: "return stream;" });
    h.generationResultLedger.begin({ lease: e.generationLease, traceId: "trace-request-E" });
    h.refs.displayedStreamRef.current = { traceId: "trace-request-E", generationId: "request-E", leaseId: e.generationLease.id,
      logicalQuestionUnitId: e.generationLease.logicalQuestionUnitId,
      logicalQuestionRevision: e.generationLease.logicalQuestionRevision };
    h.environment.state = { ...h.uiState, partialSuggestion: "Answer: partial E" };
    const partial = imports.buildMeetingAnswerDisplayModel({ content: "Answer: partial E" });
    const streaming = h.environment.selectAdviseDisplay(partial);
    assert.equal(streaming.streaming, true);
    assert.deepEqual([streaming.target.generationId, streaming.target.stableRevision], ["request-E", undefined]);
    for (let ack = 0; ack < 3; ack += 1) h.environment.recordAdviseDisplayApplied(streaming.target, "normal-mode");
    assert.deepEqual(aeFacts(h), ["first-visible-content:streaming"], "three streaming ACKs, one first-visible fact");

    // E commits through the real direct commit; the selector now returns its
    // stable target and the UI acknowledges it.
    assert.equal(aeCommitDirect(h, e).committed, true);
    const stable = h.environment.selectAdviseDisplay(imports.buildMeetingAnswerDisplayModel({
      content: h.uiState.latestSuggestion.content, parsedAnswer: h.uiState.latestSuggestion.meetingAnswer }));
    assert.equal(stable.streaming, false);
    assert.deepEqual([stable.target.generationId, stable.target.suggestionId, stable.target.traceId],
      ["request-E", "request-E", "trace-request-E"]);
    assert.equal(typeof stable.target.stableRevision, "number");
    for (let ack = 0; ack < 3; ack += 1) h.environment.recordAdviseDisplayApplied(stable.target, "normal-mode");
    h.environment.recordAdviseDisplayApplied(stable.target, "focus-mode", false);
    const visible = aeEventsOf(h, "first-visible-content");
    assert.deepEqual(visible.map((event) => [event.stage, event.refs.generationId, event.refs.stableRevision]),
      [["streaming", "request-E", undefined]], "the content of E was already on screen: no second first-visible fact");
    assert.equal(aeEventsOf(h, "stable-answer-committed").length, 1, "the commit itself is its own fact");
    const stats = h.criticalEvents.stream.getStats();
    assert.equal(stats.duplicateSuppressed, 2 + 4, "every later ACK of E was suppressed as the same generation");

    // F is never streamed: its first visible content is its stable answer.
    const f = aeArtifactCandidate(h, { id: "request-F", code: "return stable;" });
    assert.equal(aeCommitDirect(h, f).committed, true);
    const shownF = h.environment.selectAdviseDisplay(imports.buildMeetingAnswerDisplayModel({
      content: h.uiState.latestSuggestion.content, parsedAnswer: h.uiState.latestSuggestion.meetingAnswer }));
    h.environment.recordAdviseDisplayApplied(shownF.target, "normal-mode");
    h.environment.recordAdviseDisplayApplied(shownF.target, "normal-mode");
    assert.deepEqual(aeEventsOf(h, "first-visible-content").map((event) => [event.stage, event.refs.generationId]),
      [["streaming", "request-E"], ["stable", "request-F"]]);
  } finally { h.restore(); }
});

test("AE1/AE2 an Artifact published without a model call (the reuse candidate, through the real artifact-only commit): Artifact facts, an artifact-only Stable Answer and the generation's own committed terminal, and no Provider fact", () => {
  const h = createHarness({ now: 60_000 });
  try {
    h.environment.publishGenerationResultProjection = h.evaluate(
      `(${findCallbackSource("publishGenerationResultProjection")})`,
      { formatGenerationResultLedgerForTrace: () => ({}) });
    const current = h.refs.stableAnswerRevisionRef.current;
    const parent = h.manager.getTaskRuntimeState().parent;
    // What the reuse branch builds: the visible answer with the reused Code and
    // Complexity sections, reduced by the production artifact-only builder.
    const content = `${current.suggestion.content}\n\nCode:\n\`\`\`ts\nreturn reused;\n\`\`\`\n\nComplexity: O(1)`;
    const decision = stableAnswerModule.commitStableArtifactOnlyRevision({
      current, revision: h.refs.visibleAnswerRevisionRef.current + 1,
      candidate: suggestion("artifact-reuse", content), authorizedArtifacts: ["code", "complexity"],
      expectedVisibleAnswerRevision: current.revision, expectedTaskId: current.taskId,
      expectedLogicalQuestionUnitId: current.logicalQuestionUnitId,
      expectedLogicalQuestionRevision: current.logicalQuestionRevision, expectedSettlementId: current.settlementId,
      sectionOwner: { kind: "parent-mainline", parentId: parent.id }, committedAt: Date.now(),
    });
    assert.equal(decision.disposition, "committed", decision.reason);
    assert.equal(decision.stable.sections.answer.revision, current.sections.answer.revision, "the Answer is not rewritten");
    const generationLease = { ...lease(), id: "lease-artifact-reuse", taskRevision: parent.revisions,
      baseVisibleAnswerRevision: h.refs.visibleAnswerRevisionRef.current,
      requestedArtifacts: ["code", "complexity"], startedAt: Date.now() };
    // The generation owner's own ledger entry for this lease.
    h.generationResultLedger.begin({ lease: generationLease, traceId: "trace-artifact-reuse" });
    const mutated = imports.collectStableAnswerMutationDelta(current, decision.stable).candidateMutatedArtifacts;
    assert.deepEqual(mutated, ["code", "complexity"]);
    const leaseAuthorization = imports.authorizeAnswerGenerationLease(generationLease,
      h.environment.readGenerationLeaseSnapshot({ lease: generationLease, authorizedArtifacts: ["code", "complexity"],
        candidateMutatedArtifacts: mutated, logicalQuestionUnitId: "lqu-current", logicalQuestionRevision: 1 }));
    const revision = h.manager.getTaskRuntimeState().revision;
    const commit = h.environment.commitDirectGenerationAnswer({
      lease: generationLease, leaseAuthorization, expectedTaskRuntimeRevision: revision,
      currentTaskRuntimeRevision: revision, candidateAccepted: true, candidate: decision.stable,
      authorizedArtifacts: ["code", "complexity"], publicationOptions: { clearPrevious: false, artifactOnly: true },
    });
    assert.equal(commit.result.committed, true, commit.result.reason);
    h.environment.finalizeStableAnswerPublication(commit.publication);
    h.environment.publishGenerationResultProjection(generationLease, "trace-artifact-reuse");
    assert.deepEqual(aeFacts(h), [
      "artifact-committed:section-revision-changed",
      "artifact-committed:section-revision-changed",
      "stable-answer-committed:artifact-only-publication",
      "terminal:generation:committed",
    ]);
    const events = h.criticalEvents.events();
    assert.deepEqual(events.slice(0, 2).map((event) => [event.refs.artifact, event.refs.artifactRevision, event.refs.generationLeaseId]),
      [["code", 1, "lease-artifact-reuse"], ["complexity", 1, "lease-artifact-reuse"]]);
    const [, , stable, terminal] = events;
    assert.deepEqual([stable.refs.suggestionId, stable.refs.stableRevision, stable.refs.traceId],
      ["artifact-reuse", decision.stable.revision, "trace-artifact-reuse"]);
    assert.deepEqual([terminal.refs.generationLeaseId, terminal.refs.stableRevision], ["lease-artifact-reuse", decision.stable.revision]);
    assert.equal(events.some((event) => event.fact === "provider-request-started" ||
      event.terminal?.object === "provider-request"), false, "no model was called, so no Provider fact exists");
  } finally { h.restore(); }
});

test("AE3/AE5 a manual action's facts keep the session and epoch of its first record: a terminal recorded after the session changed is refused as stale, and one recorded in a later epoch keeps the action's own epoch", () => {
  const h = createHarness({ now: 60_000 });
  try {
    aeUseRealManualActionLedger(h);
    const record = h.environment.recordManualRuntimeAction;
    const stream = h.criticalEvents.stream;
    // Same session, later epoch: Clear, a response action or Stop advanced it
    // while the action's own work was still awaited.
    record({ actionId: "regen-1", action: "regenerate", stage: "requested" });
    record({ actionId: "regen-1", action: "regenerate", stage: "accepted", traceId: "trace-regen-1" });
    h.refs.runtimeEpochRef.current = 4;
    record({ actionId: "regen-1", action: "regenerate", stage: "terminal", traceId: "trace-regen-1",
      terminalDisposition: "cancelled", reason: "cancelled-by-runtime-boundary" });
    const sameSession = h.criticalEvents.events();
    assert.deepEqual(sameSession.map((event) => [event.fact, event.runtimeSessionId, event.runtimeEpoch]), [
      ["input-accepted", "session-a", 1],
      ["terminal", "session-a", 1],
    ], "the terminal carries the epoch the action began in, not the epoch at record time");

    // The action is accepted in session A, then the runtime session changes
    // (the real context manager's reset and the Hook's rebind) before its
    // awaited work returns and records the terminal.
    record({ actionId: "regen-2", action: "regenerate", stage: "requested" });
    record({ actionId: "regen-2", action: "regenerate", stage: "accepted", traceId: "trace-regen-2" });
    h.manager.reset({ sessionId: "session-b" });
    h.refs.runtimeEpochRef.current = 6;
    stream.bind(h.manager.getState().sessionId);
    const later = [];
    assert.equal(stream.subscribe((delivery) => { later.push(delivery); }).runtimeSessionId, "session-b");
    const before = stream.getStats();
    record({ actionId: "regen-2", action: "regenerate", stage: "terminal", traceId: "trace-regen-2",
      terminalDisposition: "cancelled", reason: "cancelled-by-runtime-boundary" });
    // An action that begins in the new session is a fact of the new session.
    record({ actionId: "clear-1", action: "clear-task", stage: "accepted" });
    h.criticalEvents.flush();
    const after = stream.getStats();
    assert.equal(after.staleSessionRejected - before.staleSessionRejected, 1, "the old action's terminal was refused, with its own session");
    assert.deepEqual(later.map((delivery) => delivery.kind === "event" &&
      [delivery.event.sequence, delivery.event.fact, delivery.event.refs.manualActionId, delivery.event.runtimeSessionId, delivery.event.runtimeEpoch]),
      [[1, "input-accepted", "clear-1", "session-b", 6]], "the new session's sequence starts with its own fact");
    assert.equal(h.criticalEvents.events().some((event) => event.refs.manualActionId === "regen-2" && event.fact === "terminal"), false);
    // One remembered origin per action, in the Hook's own bounded ref.
    assert.deepEqual(JSON.parse(JSON.stringify([...h.criticalEvents.hookRefs.manualActionCriticalOriginRef.current.entries()])), [
      ["regen-1", { runtimeSessionId: "session-a", runtimeEpoch: 1 }],
      ["regen-2", { runtimeSessionId: "session-a", runtimeEpoch: 4 }],
      ["clear-1", { runtimeSessionId: "session-b", runtimeEpoch: 6 }],
    ]);
    // The memory is bounded: the oldest action is forgotten first.
    for (let index = 0; index < 100; index += 1) record({ actionId: `bulk-${index}`, action: "clear-task", stage: "requested" });
    const remembered = h.criticalEvents.hookRefs.manualActionCriticalOriginRef.current;
    assert.equal(remembered.size, 64);
    assert.deepEqual([remembered.has("regen-1"), remembered.has("bulk-36"), remembered.has("bulk-99")], [false, true, true]);
  } finally { h.restore(); }
});

test("AE5 a manual action's free-text reason (a trace error message) stays in the manual-action ledger and never enters the event; an owner code passes unchanged", () => {
  const h = createHarness({ now: 60_000 });
  try {
    aeUseRealManualActionLedger(h);
    const ledger = [];
    h.environment.sessionRecordingManagerRef.current = {
      recordManualRuntimeAction: (event) => { ledger.push(event); return true; },
      recordRuntimeCriticalEvent: () => "not-recording",
    };
    const errorText = "Provider error: Incorrect API key provided: sk-proj-abc123";
    h.environment.recordManualRuntimeAction({ actionId: "action-error", action: "regenerate", stage: "terminal",
      terminalDisposition: "failed", reason: errorText });
    h.environment.recordManualRuntimeAction({ actionId: "action-code", action: "regenerate", stage: "terminal",
      terminalDisposition: "cancelled", reason: "cancelled-by-runtime-boundary" });
    const [withText, withCode] = h.criticalEvents.events();
    assert.deepEqual(JSON.parse(JSON.stringify(withText.terminal)), { object: "manual-action", disposition: "failed" });
    assert.deepEqual([...withText.omittedRefs], ["terminal.reason"], "the refused reason is named");
    assert.equal(JSON.stringify(withText).includes("sk-proj"), false);
    assert.deepEqual(JSON.parse(JSON.stringify(withCode.terminal)),
      { object: "manual-action", disposition: "cancelled", reason: "cancelled-by-runtime-boundary" });
    assert.equal(withCode.omittedRefs, undefined);
    // The owner's own ledger keeps the full text, as before.
    assert.deepEqual(ledger.map((event) => event.reason), [errorText, "cancelled-by-runtime-boundary"]);
  } finally { h.restore(); }
});

// What the product decided, independent of any observer.
function aeBusinessProjection(h) {
  return JSON.parse(JSON.stringify({
    task: h.manager.getTaskRuntimeState(),
    deadline: h.manager.getTaskDeadlineControl(),
    stable: h.refs.stableAnswerRevisionRef.current,
    visible: h.refs.visibleAnswerRevisionRef.current,
    pending: h.refs.pendingAnswerRevisionRef.current,
    continuity: h.refs.recentAdvisorContinuityRef.current,
    ledger: h.generationResultLedger.listEntries().map(({ commitDurationMs, prepareDurationMs, installDurationMs, ...entry }) => entry),
    ui: h.uiState,
    uiUpdates: h.uiUpdates.length,
    scheduledPendingCommits: h.scheduledPendingCommits,
  }));
}

// One fixed formal input: a queued answer released after its lock, two direct
// commits with Artifacts and a staged Lifecycle transition, a failing install,
// and display acknowledgements.
function aeRunFixedScenario(h) {
  const errors = [];
  h.environment.window = { requestAnimationFrame: () => 1, cancelAnimationFrame() {} };
  h.evaluate(findFunctionSource("prepareGenerationDerivedTaskRuntimeCommit"));
  const pending = prepareOutputCandidate(h);
  queueOutputCandidate(h, pending);
  errors.push(h.environment.tryCommitPendingAnswer());
  h.unlock(); h.setNow(80_000);
  errors.push(h.environment.tryCommitPendingAnswer());
  const before = h.manager.getTaskRuntimeState();
  const first = aeArtifactCandidate(h, { id: "code-a", code: "return 1;" });
  errors.push(aeCommitDirect(h, first, { transition: {
    transition: "update-parent-context", reason: "generation-derived-context", expectedRevision: before.revision,
    parent: { ...before.parent, supportedFactAnchors: ["generated-fact"], revisions: before.parent.revisions + 1, updatedAt: 80_000 },
  } }).reason);
  h.setNow(90_000);
  const original = h.environment.installPreparedStableAnswerPublication;
  h.environment.installPreparedStableAnswerPublication = (publication) => {
    original(publication);
    throw new Error("injected failure after real install");
  };
  errors.push(aeCommitDirect(h, aeArtifactCandidate(h, { id: "code-failed", code: "return 2;" })).reason);
  h.environment.installPreparedStableAnswerPublication = original;
  // A stale lease is rejected by its own owner.
  const staleCandidate = aeArtifactCandidate(h, { id: "code-stale", code: "return 3;" });
  h.refs.responseActionRevisionRef.current += 1;
  errors.push(aeCommitDirect(h, staleCandidate).reason);
  h.refs.responseActionRevisionRef.current -= 1;
  const shown = h.environment.selectAdviseDisplay(imports.buildMeetingAnswerDisplayModel({
    content: h.uiState.latestSuggestion.content, parsedAnswer: h.uiState.latestSuggestion.meetingAnswer }));
  for (let ack = 0; ack < 3; ack += 1) h.environment.recordAdviseDisplayApplied(shown.target, "normal-mode");
  return errors;
}

test("AE4 semantic isolation: with the interface idle, observed, failing by a throw or by a rejected promise, overflowing or unable to write, the same input gives the same task, answer, artifact, ledger and error exits", async () => {
  // An Error whose message is not a string and throws when it is converted.
  const unreadable = () => Object.defineProperty(new Error("x"), "message",
    { value: { toString() { throw new Error("conversion failed"); } } });
  const recorderFor = async (mode) => {
    if (!["recording", "write-failure"].includes(mode)) return undefined;
    const recorder = await createFileBackedRecorder();
    if (mode === "write-failure") recorder.files.failWrite = (relativePath) => relativePath.startsWith("runtime-events/");
    return recorder;
  };
  // A rejection handler is a microtask; a macrotask later every one has run.
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  const results = {};
  // The reference is the idle interface on this code: nobody subscribed and
  // Recording off. It runs twice, which is the comparison's own noise floor.
  const modes = ["idle", "idle-again", "subscriber", "throwing-subscriber", "async-failing-subscriber",
    "overflow-capacity-1", "recording", "write-failure", "recorder-throws",
    "unreadable-failures", "stream-emit-throws", "stream-released"];
  for (const mode of modes) {
    const h = createHarness({ now: 60_000,
      criticalEventObserver: !["idle", "idle-again"].includes(mode),
      ...(mode === "overflow-capacity-1" ? { criticalEventLimits: { queueCapacity: 1 } } : {}) });
    const recorder = await recorderFor(mode);
    try {
      if (recorder) {
        await recorder.start("session-a");
        h.environment.sessionRecordingManagerRef.current = recorder.manager;
      }
      if (mode === "recorder-throws") {
        h.environment.sessionRecordingManagerRef.current = {
          recordCaptureLifecycle() {},
          recordRuntimeCriticalEvent() { throw new Error("recording owner failure"); },
        };
      }
      if (mode === "stream-released") h.criticalEvents.stream.release("unmounted");
      let thrown = 0;
      if (mode === "throwing-subscriber") {
        h.criticalEvents.stream.subscribe(() => { thrown += 1; throw new Error("observer failure"); });
      }
      if (mode === "async-failing-subscriber") {
        // An async observer: every delivery it is handed rejects.
        h.criticalEvents.stream.subscribe(async () => { thrown += 1; throw new Error("async observer failure"); });
      }
      if (mode === "unreadable-failures") {
        // The Recording owner and an observer both fail with an error that cannot be described.
        h.environment.sessionRecordingManagerRef.current = {
          recordCaptureLifecycle() {},
          recordRuntimeCriticalEvent() { throw unreadable(); },
        };
        h.criticalEvents.stream.subscribe(() => { thrown += 1; throw unreadable(); });
      }
      if (mode === "stream-emit-throws") {
        // The event layer itself fails inside the Hook's emit function.
        h.criticalEvents.stream.emit = () => { thrown += 1; throw unreadable(); };
      }
      const exits = aeRunFixedScenario(h);
      h.criticalEvents.flush();
      await settled();
      const stats = h.criticalEvents.stream.getStats();
      results[mode] = { business: aeBusinessProjection(h), exits, stats, thrown,
        facts: h.criticalEvents.facts(), deliveries: h.criticalEvents.deliveries.map((delivery) => delivery.kind) };
      if (recorder) {
        await recorder.stop();
        results[mode].manifest = await recorder.files.readManifest(recorder.files.folders[0]);
        results[mode].journal = await recorder.files.readCriticalEventJournal(recorder.files.folders[0]);
      }
    } finally {
      h.restore();
      await recorder?.cleanup();
    }
  }
  const reference = results.idle;
  assert.deepEqual(reference.exits, ["waiting", "committed", "authorized",
    "stable-answer-publication-install-exception", "response-action-revision-mismatch"],
    "the scenario reaches a commit, a rolled-back install and a lease rejection");
  assert.ok(reference.business.ledger.length >= 4 && reference.business.task && reference.business.stable,
    "the projection that is compared holds the task, the answer and the ledger");
  for (const mode of modes) {
    assert.deepEqual(results[mode].business, reference.business, `${mode}: business projection`);
    assert.deepEqual(results[mode].exits, reference.exits, `${mode}: original exits`);
  }
  const expectedFacts = [
    "stable-answer-committed:stable-publication",
    "lifecycle-committed:task-writer-committed",
    "artifact-committed:section-revision-changed",
    "artifact-committed:section-revision-changed",
    "stable-answer-committed:stable-publication",
    "first-visible-content:stable",
  ];
  assert.deepEqual(results.subscriber.facts, expectedFacts);
  for (const idle of ["idle", "idle-again"]) {
    assert.equal(results[idle].stats.produced, expectedFacts.length);
    assert.equal(results[idle].stats.queuePeak, 0);
    assert.equal(results[idle].stats.drainsScheduled, 0);
  }
  // A throwing observer: cut off after one delivery, the healthy one unaffected.
  assert.equal(results["throwing-subscriber"].thrown, 1);
  assert.equal(results["throwing-subscriber"].stats.subscriberFailures, 1);
  assert.deepEqual(results["throwing-subscriber"].facts, expectedFacts);
  // An observer that fails by a rejected promise: handed one batch, then cut
  // off with one failure counted; the healthy one and the producers unaffected.
  assert.equal(results["async-failing-subscriber"].thrown, expectedFacts.length, "one batch was handed over, never awaited");
  assert.deepEqual([results["async-failing-subscriber"].stats.subscriberFailures, results["async-failing-subscriber"].stats.subscribers],
    [1, 1]);
  assert.deepEqual(results["async-failing-subscriber"].facts, expectedFacts);
  // Overflow: the evidence is explicitly incomplete, the product untouched.
  assert.deepEqual(results["overflow-capacity-1"].deliveries, ["event", "gap"]);
  assert.equal(results["overflow-capacity-1"].stats.overflowDropped, expectedFacts.length - 1);
  assert.equal(results["overflow-capacity-1"].stats.produced, expectedFacts.length);
  // Recording on: every produced event is saved, in order.
  assert.equal(results.recording.stats.recording.accepted, expectedFacts.length);
  assert.equal(results.recording.journal.status, "ok");
  assert.equal(results.recording.journal.contiguous, true);
  assert.equal(results.recording.journal.eventCount, expectedFacts.length);
  assert.equal(results.recording.manifest.recordingIntegrity.status, "complete");
  // A write failure is the Recording owner's own incomplete mark; delivery is complete.
  assert.deepEqual(results["write-failure"].facts, expectedFacts);
  assert.equal(results["write-failure"].journal.status, "not-provided");
  assert.equal(results["write-failure"].manifest.recordingIntegrity.status, "incomplete");
  assert.equal(results["write-failure"].manifest.recordingIntegrity.failedWriteCount, expectedFacts.length);
  assert.ok(results["write-failure"].manifest.recordingIntegrity.failedWrites
    .every((failure) => failure.relativePath === "runtime-events/critical-events.v1.jsonl"));
  // A Recording owner that throws synchronously is counted, bounded and isolated.
  assert.equal(results["recorder-throws"].stats.recording.failed, expectedFacts.length);
  assert.deepEqual(results["recorder-throws"].facts, expectedFacts);
  assert.ok(results["recorder-throws"].stats.failureDetails.length <= 8);
  // Failures that cannot even be described: still counted, bounded and isolated.
  assert.equal(results["unreadable-failures"].thrown, 1, "the failing observer was cut off after one delivery");
  assert.deepEqual([results["unreadable-failures"].stats.subscriberFailures, results["unreadable-failures"].stats.recording.failed],
    [1, expectedFacts.length]);
  assert.deepEqual(results["unreadable-failures"].facts, expectedFacts, "the healthy observer still received every fact");
  assert.ok(results["unreadable-failures"].stats.failureDetails.every((detail) => detail.message === "unreadable failure"));
  assert.deepEqual([results["unreadable-failures"].stats.failureDetails.length,
    results["unreadable-failures"].stats.failureDetailsTruncated], [expectedFacts.length + 1, false]);
  // A throw of the event layer itself stays inside the Hook's emit function.
  assert.equal(results["stream-emit-throws"].thrown, expectedFacts.length + 2, "every emit call threw");
  assert.deepEqual([results["stream-emit-throws"].stats.produced, results["stream-emit-throws"].facts], [0, []]);
  // After release (unmount) producers still run; nothing is produced or delivered.
  assert.equal(results["stream-released"].stats.produced, 0);
  assert.equal(results["stream-released"].stats.lateAfterClose, expectedFacts.length + 2,
    "every fact and both repeated ACKs were refused after release");
  assert.deepEqual(results["stream-released"].deliveries, []);
});

test("AE6 Recording: the real writer saves and the real reader returns the same identity, order and terminal; off creates nothing; a late close and a new generation never receive an old event", async (t) => {
  // Recording off: no recording is created, memory is still readable.
  const off = createHarness({ now: 60_000 });
  const idle = await createFileBackedRecorder();
  try {
    off.environment.sessionRecordingManagerRef.current = idle.manager;
    aeRunFixedScenario(off);
    assert.equal(off.criticalEvents.events().length, 6, "the observer read every fact from memory");
    assert.equal(idle.files.startCalls, 0, "no recording was started by the event interface");
    assert.deepEqual(idle.files.writes, []);
    assert.equal(off.criticalEvents.stream.getStats().recording["not-recording"], 6);
  } finally { off.restore(); await idle.cleanup(); }

  const h = createHarness({ now: 60_000 });
  const recorder = await createFileBackedRecorder();
  try {
    await recorder.start("session-a");
    const firstFolder = recorder.files.folders[0];
    h.environment.sessionRecordingManagerRef.current = recorder.manager;
    aeUseRealManualActionLedger(h);
    h.environment.publishGenerationResultProjection = h.evaluate(
      `(${findCallbackSource("publishGenerationResultProjection")})`,
      { formatGenerationResultLedgerForTrace: () => ({}) });
    aeRunFixedScenario(h);
    const shown = h.environment.selectAdviseDisplay(imports.buildMeetingAnswerDisplayModel({
      content: h.uiState.latestSuggestion.content, parsedAnswer: h.uiState.latestSuggestion.meetingAnswer }));
    h.environment.toggleAdvisePin({ actionId: "pin-recorded", uiSurface: "normal-mode", displayTarget: shown.target });
    h.environment.recordManualRuntimeAction({ actionId: "owned-by-first", action: "force-advise", stage: "accepted",
      traceId: "trace-owned-by-first", observedLogicalQuestionUnitId: "lqu-current", observedLogicalQuestionUnitRevision: 1 });
    const produced = h.criticalEvents.events();
    assert.ok(produced.length >= 10);

    // Produced while the first generation is really closing: one aggregate
    // write of the close is held, so the fact is produced in the closing phase.
    const stream = h.criticalEvents.stream;
    let releaseClose;
    let enteredClosing;
    const closing = new Promise((resolve) => { enteredClosing = resolve; });
    recorder.files.blockWrite = (relativePath) => {
      if (releaseClose || relativePath !== "metrics/session-summary.json") return undefined;
      enteredClosing();
      return new Promise((resolve) => { releaseClose = resolve; });
    };
    const stopping = recorder.manager.stop("test-stop");
    await closing;
    assert.equal(recorder.manager.getState().lifecycle, "closing");
    const beforeClose = stream.getStats().recording;
    h.setNow(95_000);
    h.environment.toggleAdvisePin({ actionId: "during-close", displayTarget: shown.target });
    assert.equal(stream.getStats().recording.accepted - beforeClose.accepted, 2,
      "the closing generation took the acceptance and the terminal of this action");
    releaseClose();
    await stopping;
    recorder.files.blockWrite = undefined;
    // Then after it sealed and was released: nothing is recording.
    const beforeSeal = stream.getStats().recording;
    h.environment.toggleAdvisePin({ actionId: "after-close", displayTarget: shown.target });
    const producedAfterSeal = h.criticalEvents.events().filter((event) => event.refs.manualActionId === "after-close").length;
    assert.ok(producedAfterSeal > 0);
    assert.equal(stream.getStats().recording["not-recording"] - beforeSeal["not-recording"], producedAfterSeal);
    assert.equal(stream.getStats().recording.accepted, beforeSeal.accepted);
    const first = await recorder.files.readCriticalEventJournal(firstFolder);
    assert.equal(first.status, "ok");
    assert.equal(first.sessions.length, 1);
    const saved = first.sessions[0].events;
    const inMemory = h.criticalEvents.events();
    const savedIds = new Set(saved.map((event) => event.eventId));
    // Identity, order and the original terminal are the ones produced.
    assert.deepEqual(saved.map(({ recordingSessionId, recordingGenerationId, ...event }) => event),
      inMemory.filter((event) => savedIds.has(event.eventId)).map((event) => JSON.parse(JSON.stringify(event))));
    assert.deepEqual(saved.map((event) => event.sequence), saved.map((_, index) => index + 1));
    assert.ok(saved.some((event) => event.terminal?.object === "manual-action" && event.terminal.disposition === "completed"));
    assert.ok(saved.some((event) => event.terminal?.object === "generation" && event.terminal.disposition === "committed"));
    assert.ok(saved.some((event) => event.terminal?.object === "generation" && event.terminal.disposition === "failed"));
    const manifest = await recorder.files.readManifest(firstFolder);
    assert.equal(new Set(saved.map((event) => event.recordingGenerationId)).size, 1);
    assert.equal(saved[0].recordingGenerationId, manifest.recordingLifecycle.generationId);
    assert.equal(saved[0].recordingSessionId, manifest.sessionId);
    assert.equal(manifest.recordingIntegrity.status, "complete");
    assert.equal(first.contiguous, true);
    // The facts produced in the closing phase were saved by the generation
    // being closed, through its existing late-write drain.
    assert.deepEqual(saved.filter((event) => event.refs.manualActionId === "during-close").map((event) => event.fact),
      ["input-accepted", "terminal"]);
    t.diagnostic(JSON.stringify({ closingPhaseEvent: true, drainPasses: manifest.recordingLifecycle.drainPasses,
      sessionSummaryWrites: recorder.files.writes.filter((write) => write.relativePath === "metrics/session-summary.json").length }));
    // The event after the seal was produced and observed, and not recorded.
    const afterClose = inMemory.filter((event) => event.refs.manualActionId === "after-close");
    assert.ok(afterClose.length > 0);
    assert.equal(afterClose.some((event) => savedIds.has(event.eventId)), false);
    const timelineBefore = await recorder.files.readText(firstFolder, "timeline.jsonl");

    // A manual action whose trace the first generation owns, accepted there.
    const traced = { actionId: "owned-by-first", action: "force-advise", traceId: "trace-owned-by-first",
      observedLogicalQuestionUnitId: "lqu-current", observedLogicalQuestionUnitRevision: 1 };

    // A new generation in the same runtime session: only what is produced now.
    h.setNow(100_000);
    await recorder.start("session-a");
    const secondFolder = recorder.files.folders[1];
    assert.notEqual(secondFolder, firstFolder);
    h.environment.toggleAdvisePin({ actionId: "second-generation", displayTarget: shown.target });
    // Late facts of older work, produced by the real ledger callback while the
    // second generation is writable: one whose trace the first generation
    // owns, one whose own time is before the second generation began.
    const beforeLate = stream.getStats().recording;
    h.environment.recordManualRuntimeAction({ ...traced, stage: "terminal", terminalDisposition: "cancelled",
      reason: "cancelled-by-runtime-boundary" });
    h.environment.recordManualRuntimeAction({ actionId: "older-than-second", action: "clear-task", stage: "terminal",
      terminalDisposition: "completed", reason: "active-task-cleared", occurredAt: 96_000 });
    const afterLate = stream.getStats().recording;
    assert.equal(afterLate["rejected-late"] - beforeLate["rejected-late"], 2,
      "both were produced and observed in memory, and refused by the generation that does not own them");
    assert.equal(afterLate.accepted, beforeLate.accepted);
    assert.deepEqual(h.criticalEvents.events().filter((event) =>
      ["owned-by-first", "older-than-second"].includes(event.refs.manualActionId)).map((event) =>
      [event.refs.manualActionId, event.fact, event.terminal?.disposition]), [
      ["owned-by-first", "input-accepted", undefined],
      ["owned-by-first", "terminal", "cancelled"],
      ["older-than-second", "terminal", "completed"],
    ]);
    await recorder.stop();
    const second = await recorder.files.readCriticalEventJournal(secondFolder);
    const secondManifest = await recorder.files.readManifest(secondFolder);
    assert.ok(secondManifest.recordingLifecycle.rejectedLateWrites >= 2,
      "the second generation counts the refused late writes in its own manifest");
    assert.equal(second.status, "ok");
    assert.deepEqual([...new Set(second.sessions[0].events.map((event) => event.refs.manualActionId))], ["second-generation"]);
    assert.equal(second.contiguous, false, "the generation began mid-session: the hole before it is explicit");
    assert.equal(second.sessions[0].gaps[0].firstMissingSequence, 1);
    // The sealed recording was not rewritten by anything produced later.
    assert.deepEqual(await recorder.files.readCriticalEventJournal(firstFolder), first);
    assert.equal(await recorder.files.readText(firstFolder, "timeline.jsonl"), timelineBefore);
    // Append-only writes to the journal; no human-evaluation or manifest field came from an event.
    const journalWrites = recorder.files.criticalEventWrites();
    assert.equal(journalWrites.every((write) => write.append && write.command === "write_meeting_session_recording_text"), true);
    assert.equal(Object.keys(manifest).some((key) => /critical|runtimeEvent/i.test(key)), false);
    const timeline = (timelineBefore ?? "").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(timeline.some((entry) => /critical-event/.test(entry.kind)), false, "no timeline kind was added");
  } finally { h.restore(); await recorder.cleanup(); }

  // A generation whose close failed is sealed. It refuses the event as a late
  // write, and the fact is still produced and observed in memory.
  const sealed = createHarness({ now: 60_000 });
  const failing = await createFileBackedRecorder();
  try {
    await failing.start("session-a");
    sealed.environment.sessionRecordingManagerRef.current = failing.manager;
    sealed.environment.window = { requestAnimationFrame: () => 1, cancelAnimationFrame() {} };
    aeUseRealManualActionLedger(sealed);
    const target = sealed.environment.selectAdviseDisplay(imports.buildMeetingAnswerDisplayModel({
      content: sealed.uiState.latestSuggestion.content, parsedAnswer: sealed.uiState.latestSuggestion.meetingAnswer })).target;
    let failManifest = true;
    failing.files.failWrite = (relativePath) => failManifest && relativePath === "manifest.json";
    await assert.rejects(failing.manager.stop("test-stop"), /manifest\.json/);
    assert.equal(failing.manager.getState().lifecycle, "close-failed");
    sealed.environment.toggleAdvisePin({ actionId: "after-failed-close", displayTarget: target });
    const stats = sealed.criticalEvents.stream.getStats();
    assert.deepEqual({ ...stats.recording }, { accepted: 0, "not-recording": 0, "rejected-late": 2, failed: 0 });
    assert.deepEqual(sealed.criticalEvents.facts(), ["input-accepted:manual-action-accepted", "terminal:manual-action:completed"]);
    assert.deepEqual(failing.files.criticalEventWrites(), [], "the sealed generation wrote no event line");
    failManifest = false;
    await failing.manager.stop("test-retry");
    assert.equal((await failing.files.readCriticalEventJournal(failing.files.folders[0])).status, "not-provided");
  } finally { sealed.restore(); await failing.cleanup(); }

  // Zero rewrite: the Recording owner writes every other file the same number
  // of times whether or not the Hook hands it events; the journal is the only
  // addition. The run without events is this same code with the Hook's emit
  // function replaced by one that does nothing. This holds for a recording
  // with no fact in its closing phase: a fact accepted while closing is a late
  // write, and the owner's existing drain then repeats its aggregate pass
  // (reported above).
  const writesByPath = async ({ emitDisabled = false } = {}) => {
    const run = createHarness({ now: 60_000 });
    if (emitDisabled) run.environment.emitRuntimeCriticalEvent = () => undefined;
    const files = await createFileBackedRecorder();
    try {
      await files.start("session-a");
      run.environment.sessionRecordingManagerRef.current = files.manager;
      aeRunFixedScenario(run);
      await files.stop();
      const counts = {};
      for (const write of files.files.writes) {
        const key = `${write.append ? "append" : "write"} ${write.relativePath.replace(/[A-Za-z0-9_-]{20,}/g, "<id>")}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      return counts;
    } finally { run.restore(); await files.cleanup(); }
  };
  const withEvents = await writesByPath();
  const withoutEvents = await writesByPath({ emitDisabled: true });
  const journalKey = "append runtime-events/critical-events.v1.jsonl";
  assert.equal(withEvents[journalKey], 6);
  assert.equal(withoutEvents[journalKey], undefined);
  delete withEvents[journalKey];
  assert.deepEqual(withEvents, withoutEvents, "no other recording file gained or lost a write");
  assert.ok(Object.keys(withoutEvents).some((key) => key.includes("timeline.jsonl")));
});

test("AE8 cost: the same fixed steady and burst input with the Hook's emit function doing nothing, idle, observed and recorded (reported, never asserted as zero)", async (t) => {
  const quantiles = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
    return { count: sorted.length, p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(sorted.at(-1) ?? 0) };
  };
  // One formal input = one direct commit with Artifacts plus three display ACKs.
  // "emit-disabled" is this same code with the Hook's emit function replaced by
  // one that does nothing: the reference for what the interface adds.
  const runInputs = async (variant, shape, inputs) => {
    const h = createHarness({ now: 60_000, criticalEventObserver: ["with-observer", "with-recording"].includes(variant) });
    const recorder = variant === "with-recording" ? await createFileBackedRecorder() : undefined;
    try {
      h.environment.window = { requestAnimationFrame: () => 1, cancelAnimationFrame() {} };
      if (recorder) {
        await recorder.start("session-a");
        h.environment.sessionRecordingManagerRef.current = recorder.manager;
      }
      const stream = h.criticalEvents.stream;
      const hookEmitNs = [], deliverBatchNs = [], deliverItemNs = [], inputNs = [];
      if (variant === "emit-disabled") {
        h.environment.emitRuntimeCriticalEvent = () => undefined;
      } else {
        // Test-side timing of the Hook's own emit function: the event layer's
        // emit and the synchronous Recording call together, as every producer
        // pays for it. The production path is unchanged.
        const hookEmit = h.environment.emitRuntimeCriticalEvent;
        h.environment.emitRuntimeCriticalEvent = (input) => {
          const started = process.hrtime.bigint();
          hookEmit(input);
          hookEmitNs.push(Number(process.hrtime.bigint() - started));
        };
      }
      const drain = () => {
        while (h.criticalEvents.manualClock.pendingCount()) {
          const before = stream.getStats().delivered;
          const started = process.hrtime.bigint();
          h.criticalEvents.manualClock.runNext();
          const elapsed = Number(process.hrtime.bigint() - started);
          const items = stream.getStats().delivered - before;
          deliverBatchNs.push(elapsed);
          if (items > 0) deliverItemNs.push(elapsed / items);
        }
      };
      for (let index = 0; index < inputs; index += 1) {
        h.setNow(60_000 + index * 10);
        const started = aePerformance.now();
        const prepared = aeArtifactCandidate(h, { id: `input-${index}`, code: `return ${index};` });
        assert.equal(aeCommitDirect(h, prepared).committed, true);
        const shown = h.environment.selectAdviseDisplay(imports.buildMeetingAnswerDisplayModel({
          content: h.uiState.latestSuggestion.content, parsedAnswer: h.uiState.latestSuggestion.meetingAnswer }));
        for (let ack = 0; ack < 3; ack += 1) h.environment.recordAdviseDisplayApplied(shown.target, "normal-mode");
        inputNs.push((aePerformance.now() - started) * 1e6);
        if (shape === "steady") drain();
      }
      drain();
      const before = stream.getStats();
      const business = aeBusinessProjection(h);
      if (recorder) await recorder.stop();
      stream.release("measurement finished");
      const after = stream.getStats();
      const journal = recorder?.files.criticalEventWrites() ?? [];
      return {
        business,
        report: {
          variant, shape, inputs, producedEvents: before.produced, deliveredItems: before.delivered,
          overflowDropped: before.overflowDropped, gapMarkers: before.gapMarkers, queuePeak: before.queuePeak,
          hookEmitNs: quantiles(hookEmitNs), deliverBatchNs: quantiles(deliverBatchNs), deliverItemNs: quantiles(deliverItemNs),
          inputNs: quantiles(inputNs),
          journalAppends: journal.length, journalBytes: journal.reduce((sum, write) => sum + write.bytes, 0),
          otherRecordingWrites: recorder ? recorder.files.writes.length - journal.length : 0,
          retainedAfterRelease: { queueDepth: after.queueDepth, subscribers: after.subscribers,
            firstKeys: after.retainedFirstKeys, accepting: after.accepting },
        },
      };
    } finally { h.restore(); await recorder?.cleanup(); }
  };
  for (const [shape, inputs] of [["steady", 40], ["burst", 120]]) {
    const runs = {};
    for (const variant of ["emit-disabled", "with-idle", "with-observer", "with-recording"]) {
      runs[variant] = await runInputs(variant, shape, inputs);
      const { report } = runs[variant];
      // The difference of the per-input median from the run whose emit does nothing.
      report.inputP50DeltaNs = report.inputNs.p50 - runs["emit-disabled"].report.inputNs.p50;
      t.diagnostic(JSON.stringify(report));
    }
    const reference = runs["emit-disabled"];
    assert.equal(reference.report.producedEvents, 0);
    for (const variant of ["with-idle", "with-observer", "with-recording"]) {
      assert.deepEqual(runs[variant].business, reference.business, `${shape}/${variant}: same product result`);
      assert.equal(runs[variant].report.producedEvents, runs["with-idle"].report.producedEvents);
      assert.deepEqual(runs[variant].report.retainedAfterRelease,
        { queueDepth: 0, subscribers: 0, firstKeys: 0, accepting: false }, `${shape}/${variant}: nothing is retained after release`);
    }
    assert.equal(runs["with-idle"].report.queuePeak, 0, "no observer, nothing queued");
    assert.equal(runs["with-recording"].report.journalAppends, runs["with-recording"].report.producedEvents,
      "one appended line per produced event, no batching");
    if (shape === "steady") {
      assert.equal(runs["with-observer"].report.overflowDropped, 0);
      assert.ok(runs["with-observer"].report.queuePeak <= 8);
    } else {
      // A burst that nobody drains reaches the bound and says so.
      assert.ok(runs["with-observer"].report.queuePeak <= 257);
      assert.equal(runs["with-observer"].report.producedEvents >
        256 ? runs["with-observer"].report.gapMarkers >= 1 : true, true);
    }
  }

  // The closing phase. A fact accepted while a generation closes is a late
  // write for the Recording owner, whose existing drain then repeats its
  // aggregate pass. What the interface adds is measured with an event alone:
  // a manual action writes its own ledger line while closing whether or not
  // the Hook's emit function does anything, so it is reported beside the run
  // whose emit does nothing.
  const closingCost = async (late, count = 0, { emitDisabled = false } = {}) => {
    const h = createHarness({ now: 60_000 });
    const recorder = await createFileBackedRecorder();
    try {
      h.environment.window = { requestAnimationFrame: () => 1, cancelAnimationFrame() {} };
      aeUseRealManualActionLedger(h);
      if (emitDisabled) h.environment.emitRuntimeCriticalEvent = () => undefined;
      await recorder.start("session-a");
      h.environment.sessionRecordingManagerRef.current = recorder.manager;
      const target = h.environment.selectAdviseDisplay(imports.buildMeetingAnswerDisplayModel({
        content: h.uiState.latestSuggestion.content, parsedAnswer: h.uiState.latestSuggestion.meetingAnswer })).target;
      h.environment.toggleAdvisePin({ actionId: "before-close", displayTarget: target });
      let release;
      let entered;
      const closing = new Promise((resolve) => { entered = resolve; });
      recorder.files.blockWrite = (relativePath) => {
        if (release || relativePath !== "metrics/session-summary.json") return undefined;
        entered();
        return new Promise((resolve) => { release = resolve; });
      };
      const stopping = recorder.manager.stop("test-stop");
      await closing;
      for (let index = 0; index < count; index += 1) {
        if (late === "manual-action") {
          h.environment.toggleAdvisePin({ actionId: `while-closing-${index}`, displayTarget: target });
        }
        // The event alone: the terminal of a request that Stop cancelled, handed
        // to the Hook's own emit function as the provider terminal callback does.
        if (late === "event-only") {
          h.environment.emitRuntimeCriticalEvent({
            fact: "terminal", stage: "provider-attempt-final", purpose: "formal",
            runtimeSessionId: "session-a", runtimeEpoch: 1, occurredAt: Date.now(),
            terminal: { object: "provider-request", disposition: "aborted" },
            refs: { requestId: `request-${index}`, attemptId: `request-${index}:1`, attemptNumber: 1, operationKind: "main-advisor" },
          });
        }
      }
      release();
      await stopping;
      const manifest = await recorder.files.readManifest(recorder.files.folders[0]);
      const writes = (relativePath) => recorder.files.writes.filter((write) => write.relativePath === relativePath).length;
      return { late, count, emit: emitDisabled ? "disabled" : "real",
        drainPasses: manifest.recordingLifecycle.drainPasses,
        sessionSummaryWrites: writes("metrics/session-summary.json"),
        nonAppendWrites: recorder.files.writes.filter((write) => !write.append).length,
        journalAppends: recorder.files.criticalEventWrites().length,
        integrity: manifest.recordingIntegrity.status };
    } finally { h.restore(); await recorder.cleanup(); }
  };
  const closingPhase = {
    quietClose: await closingCost("none"),
    oneEvent: await closingCost("event-only", 1),
    fiveEvents: await closingCost("event-only", 5),
    manualWith: await closingCost("manual-action", 1),
    quietEmitDisabled: await closingCost("none", 0, { emitDisabled: true }),
    manualEmitDisabled: await closingCost("manual-action", 1, { emitDisabled: true }),
  };
  const { quietClose, oneEvent, fiveEvents, manualWith, quietEmitDisabled, manualEmitDisabled } = closingPhase;
  t.diagnostic(JSON.stringify({ closingPhase }));
  for (const run of Object.values(closingPhase)) assert.equal(run.integrity, "complete", JSON.stringify(run));
  // The interface's own closing-phase cost: an event alone is a late write.
  assert.equal(oneEvent.journalAppends, quietClose.journalAppends + 1, "the late event was saved");
  assert.equal(fiveEvents.journalAppends, quietClose.journalAppends + 5);
  assert.ok(oneEvent.drainPasses > quietClose.drainPasses && oneEvent.sessionSummaryWrites > quietClose.sessionSummaryWrites,
    "an event in the closing phase repeats the owner's aggregate pass: the cost is real and is reported");
  assert.deepEqual([fiveEvents.drainPasses, fiveEvents.sessionSummaryWrites, fiveEvents.nonAppendWrites],
    [oneEvent.drainPasses, oneEvent.sessionSummaryWrites, oneEvent.nonAppendWrites],
    "five events in the same window cost the same one extra pass as one");
  // A manual action in the closing phase: its own ledger line is a late write
  // when the emit function does nothing too, so the interface adds only its
  // journal lines.
  assert.equal(manualWith.journalAppends, quietClose.journalAppends + 2, "the action's two facts were saved");
  assert.deepEqual([quietEmitDisabled.journalAppends, manualEmitDisabled.journalAppends], [0, 0]);
  assert.deepEqual([manualWith.drainPasses, manualWith.sessionSummaryWrites, manualWith.nonAppendWrites],
    [manualEmitDisabled.drainPasses, manualEmitDisabled.sessionSummaryWrites, manualEmitDisabled.nonAppendWrites],
    "with a manual action the extra pass exists whether or not an event is emitted");
  assert.deepEqual([quietClose.drainPasses, quietClose.sessionSummaryWrites, quietClose.nonAppendWrites],
    [quietEmitDisabled.drainPasses, quietEmitDisabled.sessionSummaryWrites, quietEmitDisabled.nonAppendWrites],
    "a close with nothing late is the same whether or not events were emitted");
});
