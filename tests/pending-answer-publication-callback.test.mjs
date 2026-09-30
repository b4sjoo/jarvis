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

const callbackSources = {
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
