import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const output = process.env.JARVIS_TEST_OUTPUT_DIR ?? ".tmp-tests";
const production = file => import(pathToFileURL(path.resolve(output, `src/lib/meeting/${file}.js`)));
const { ManualAdviseDisplay: CurrentSelector } = await production("manual-advise-display");
const { buildMeetingAnswerDisplayModel, overlayMeetingAnswerArtifacts } = await production("meeting-answer-display");
const { buildClarifyingOptionDisplayModel, readProjectBindingClarifyingCandidates } = await production("clarifying-options");
const { createMeetingFocusDisplayModel } = await production("focus-display");
const { createMeetingFocusPublisher, createMeetingFocusConsumer } = await production("focus-window-protocol");
const { EMPTY_MEETING_FOCUS_SNAPSHOT: empty } = await production("focus-window");
const { commitStableAnswerRevision } = await production("stable-answer");
const { SessionRecordingManager } = await production("session-recording");

// Swap only the selector for a controlled old-fail run; all consumers stay identical.
function selector() {
  const revision = process.env.JARVIS_BF_SELECTOR_REVISION;
  if (!revision) return CurrentSelector;
  const source = execFileSync("git", ["show", `${revision}:src/lib/meeting/manual-advise-display.ts`], { encoding: "utf8" });
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText, { exports, structuredClone });
  return exports.ManualAdviseDisplay;
}
const Selector = selector();
const ast = file => ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const main = ast("src/pages/app/components/meeting/index.tsx");
const hook = ast("src/hooks/useMeetingAssistant.ts");
function findAll(root, predicate) {
  const found = [];
  function visit(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(root);
  return found;
}
function one(root, predicate, label) {
  const found = findAll(root, predicate);
  assert.equal(found.length, 1, label);
  return found[0];
}
function variable(root, name) {
  return one(root, node => ts.isVariableDeclaration(node) && node.name.getText(root) === name, name);
}
function evaluate(code, env) {
  return vm.runInNewContext(ts.transpileModule(code, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None,
  } }).outputText, env);
}
const hookCallback = (name, env) => evaluate(`(${variable(hook, name).initializer.arguments[0].getText(hook)})`, env);
const recorderCreation = one(hook, node => ts.isNewExpression(node) && node.expression.getText(hook) === "SessionRecordingManager", "recorder constructor");
const publisherCreation = one(main, node => ts.isCallExpression(node) && node.expression.getText(main) === "createMeetingFocusPublisher", "publisher constructor");
const observeSource = publisherCreation.arguments[0].properties.find(node => node.name?.getText(main) === "observe").initializer.getText(main);
const publishEffect = one(main, node => ts.isCallExpression(node) && node.expression.getText(main) === "useEffect" &&
  node.arguments[0]?.getText(main).includes("publish(focusSnapshot)"), "Focus publishing effect");

function stable(id, lqu = id, revision = 1) {
  const content = `Answer: ${id} answer\n\nCode:\n\`\`\`ts\n${id}();\n\`\`\`\n\nWhiteboard: ${id} diagram\n\nComplexity: O(n)`;
  const display = buildMeetingAnswerDisplayModel({ content });
  const result = commitStableAnswerRevision({
    candidate: { id, content, meetingAnswer: display.parsedAnswer, sourceTraceId: `trace-${id}`,
      kind: "answer", createdAt: 1, basedOnTurnIds: [], basedOnObservationIds: [], confidence: "high" },
    taskId: "parent", logicalQuestionUnitId: lqu, logicalQuestionRevision: 1,
    authorizedArtifacts: ["answer", "code", "complexity", "whiteboard"], sessionId: "session", revision,
  });
  assert.ok(result);
  return { ...result, display };
}

async function harness(t, replacement = false) {
  const display = new Selector();
  const messages = [], sent = [], observations = [], actions = [], writes = [], stateChanges = [];
  const listeners = { action: new Set(), snapshot: new Set() };
  const endpoint = (receive, send) => ({
    async subscribe(fn) { listeners[receive].add(fn); return () => listeners[receive].delete(fn); },
    async send(payload) { const message = { event: send, payload: structuredClone(payload) }; messages.push(message); sent.push(message); },
  });
  let pendingRender = false, renders = 0, memoIndex = 0;
  const memos = [];
  const env = {
    state: { partialSuggestion: replacement ? "" : "Answer: A first chunk", latestSuggestion: null },
    contextManagerRef: { current: { getState: () => ({ sessionId: "session" }) } },
    stableAnswerRevisionRef: { current: replacement ? stable("A") : null },
    displayedStreamRef: { current: { leaseId: "lease-A", generationId: "A", traceId: "trace-A",
      logicalQuestionUnitId: "A", logicalQuestionRevision: 1 } },
    generationResultLedgerRef: { current: { getEntry: () => ({ commitDisposition: "started" }) } },
    manualAdviseDisplayRef: { current: display },
    buildMeetingAnswerDisplayModel, overlayMeetingAnswerArtifacts,
    buildClarifyingOptionDisplayModel, readProjectBindingClarifyingCandidates, createMeetingFocusDisplayModel,
    // The native filesystem is the only recorder substitute; event/state transitions are production code.
    setState(update) { const previous = env.state; env.state = update(previous); stateChanges.push(env.state); pendingRender = true; },
    traceStoreRef: { current: { getTraces: () => [] } }, refreshRecordedCompletedTrace() {},
    sessionRecordingManagerRef: { current: null }, pinReleaseFrameRef: { current: null },
    meeting: { traces: [], taskRuntime: {}, speechCorrections: [], answerDelivery: empty.answerDelivery, status: "thinking", error: null },
    useMemo(factory, deps) {
      const index = memoIndex++, previous = memos[index];
      if (!previous || deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        memos[index] = { deps, value: factory() };
      }
      return memos[index].value;
    },
    useEffect(effect, deps) { env.useMemo(() => { effect(); }, deps); },
    focusModeActive: true, selectedTaskDisplay: undefined, latestReliableAnswerPreview: "",
    latestInterviewerTurnText: "First transcript", forceAdviseAvailable: true, forceAdvisePending: false, forceAdviseCompleted: false,
    meetingStatusLabel: "Thinking", factGuardrailNotice: undefined, artifactReuseNotice: undefined, isBusy: true,
    audioPauseResumeControl: empty.audioControl, audioWarningLabel: undefined, audioWarningDetail: undefined,
    activeClarifyingSelection: null, isTaskSwitchClarifyingQuestion: false, editableBriefForFocus: { interviewTypes: [] },
    effectiveQuestionType: "unknown", currentQuestionTypeObservation: { durableOwnerMissing: false }, transientPersonalStatusLabel: undefined,
    currentQuestionId: undefined, activeManualQuestionTypeCorrection: undefined, hasActiveMeetingTask: false,
    hasCorrectableQuestion: false, displayHasCorrectableQuestion: false, hasActiveMeetingScreenContext: false,
    currentQuestionTrace: undefined, activeTaskKind: undefined, whiteboardArtifactDisplay: { viewKey: "background" },
    formatClarifyingSelectionMessage: () => undefined, getActiveMeetingTaskFocusSummary: () => undefined,
  };
  const select = hookCallback("selectAdviseDisplay", env);
  env.meeting.recordAdviseDisplayApplied = hookCallback("recordAdviseDisplayApplied", env);
  const recorder = new SessionRecordingManager(evaluate(`(${recorderCreation.arguments[0].getText(hook)})`, env), async (command, args) => {
    writes.push({ command, args });
    if (command === "start_meeting_session_recording") return "/synthetic-bf-recording";
    assert.equal(command, "write_meeting_session_recording_text");
  });
  env.sessionRecordingManagerRef.current = recorder;
  await recorder.start({ meetingSessionId: "session", settings: {
    codingModel: { enabled: false, provider: "", variables: {} },
    taxonomyAdjudication: { enabled: true, provider: "", variables: {} },
  }, providerSummary: { hasMainProvider: false, hasCodingProvider: false, hasTaxonomyAdjudicationProvider: false,
    hasSttProvider: false, mainSupportsImages: false, codingSupportsImages: false } });
  const observe = evaluate(`(${observeSource})`, env);
  const publisher = createMeetingFocusPublisher({ transport: endpoint("action", "snapshot"), publisherInstanceId: "publisher-A",
    onAction: action => actions.push(action), onError: assert.fail,
    observe(event) { observations.push(event); observe(event); },
  });
  env.focusPublisherRef = { current: publisher };
  const consumers = new Map(), received = { answer: [], controls: [] };
  let request = 0;
  async function open(kind) {
    consumers.get(kind)?.dispose();
    const consumer = createMeetingFocusConsumer({ transport: endpoint("snapshot", "action"), windowKind: kind,
      createRequestId: () => `${kind}-${++request}`, onError: assert.fail,
      onSnapshot(envelope) {
        received[kind].push(envelope);
        // Deterministic post-commit boundary, not a claim about native painting/RAF latency.
        consumer.applied(envelope);
      },
    });
    consumers.set(kind, consumer);
    await consumer.start();
  }
  function read() {
    env.emptyAdviseDisplay = evaluate(`(${variable(hook, "emptyAdviseDisplay").initializer.getText(hook)})`, env);
    return select(buildMeetingAnswerDisplayModel({ content: env.state.partialSuggestion }));
  }
  read();
  assert.equal(display.toggle().accepted, true);
  if (replacement) {
    env.stableAnswerRevisionRef.current = stable("B", "B", 2);
    env.displayedStreamRef.current = { ...env.displayedStreamRef.current, generationId: "A-prime", traceId: "trace-A-prime" };
    env.state.partialSuggestion = "Answer: A replacement chunk";
  }
  function render() {
    renders++; memoIndex = 0;
    env.adviseDisplay = read();
    env.displaySuggestionSections = env.adviseDisplay.sections;
    env.displayTargetKey = JSON.stringify(env.adviseDisplay.target);
    env.clarifyingSourceTrace = undefined;
    for (const name of ["clarifyingQuestion", "rawClarifyingOptions", "projectBindingClarifyingCandidates", "clarifyingOptionDisplay", "clarifyingOptions"]) {
      env[name] = evaluate(`(${variable(main, name).initializer.getText(main)})`, env);
    }
    env.showClarifyingQuestion = Boolean(env.clarifyingQuestion);
    env.focusSnapshot = evaluate(`(${variable(main, "focusSnapshot").initializer.getText(main)})`, env);
    evaluate(publishEffect.getText(main), env);
  }
  const published = () => observations.filter(event => event.event === "published");
  const applied = () => observations.filter(event => event.event === "applied");
  async function drain() {
    // Test-only work bound detects nonquiescence; it never throttles production updates.
    for (let step = 0; step < 256; step++) {
      await Promise.resolve();
      if (pendingRender) { pendingRender = false; render(); continue; }
      const message = messages.shift();
      if (message) { for (const receive of listeners[message.event]) receive(message.payload); continue; }
      await Promise.resolve();
      if (!pendingRender && !messages.length) return;
    }
    assert.fail(`BF2 nonquiescence: ${renders} renders, ${published().length} payload sequences, ${applied().length} accepted ACKs with unchanged input`);
  }
  await publisher.start(); await open("answer"); await open("controls");
  t.after(async () => { publisher.dispose(); for (const consumer of consumers.values()) consumer.dispose(); await recorder.stop(); });
  pendingRender = true;
  return { env, display, recorder, received, sent, actions, writes, stateChanges, published, applied, drain, open,
    rerender() { pendingRender = true; },
    async update(change) { change(env); pendingRender = true; await drain(); },
  };
}

for (const replacement of [false, true]) {
  test(`BF2 production ACK/recorder/render composition becomes quiescent (${replacement ? "locked A replacement" : "initial locked stream"})`, async t => {
    const h = await harness(t, replacement);
    const stateChangesBefore = h.stateChanges.length, eventsBefore = h.recorder.getState().eventCount;
    await h.drain();
    assert.equal(h.published().length, 1);
    assert.equal(h.applied().length, 2, "each native consumer records its real sequence");
    assert.equal(h.stateChanges.length - stateChangesBefore, 2, "each ACK must update Hook state through the real recorder callback");
    assert.equal(h.recorder.getState().eventCount - eventsBefore, 2);
    const first = h.env.focusSnapshot;
    for (let i = 0; i < 20; i++) { h.rerender(); await h.drain(); }
    assert.equal(h.env.focusSnapshot, first);
    assert.equal(h.published().length, 1);
    assert.equal(h.actions.length, 0, "ACK never becomes a product/model action");
    await h.recorder.stop();
    const recorded = h.writes.filter(write => write.args.relativePath === "timeline.jsonl")
      .map(write => JSON.parse(write.args.payload)).filter(event => event.metadata?.stage === "advise-display-applied");
    assert.equal(recorded.length, 2, "neither ACK is suppressed by the recorder");
    t.diagnostic(`unchanged input: ${h.published().length} sequence, ${h.applied().length} window ACKs, ${recorded.length} recorder events`);
  });
}

test("BF1/3 real chunks, options, profile, Artifact overlays, controls and re-handshake still publish", async t => {
  const h = await harness(t, true);
  await h.drain();
  async function changed(change, check) {
    const before = h.published().length;
    await h.update(change);
    assert.equal(h.published().length, before + 1);
    for (const kind of ["answer", "controls"]) {
      const last = h.received[kind].at(-1);
      assert.equal(last.sequence, before + 1);
      check(last.payload);
      assert.equal(h.applied().filter(event => event.windowKind === kind && event.sequence === before + 1).length, 1);
    }
  }
  await changed(env => { env.state.partialSuggestion = "Answer: A replacement second chunk"; }, payload => {
    assert.equal(payload.sections.primaryAnswer, "A replacement second chunk");
  });
  await changed(env => { env.state.partialSuggestion += '\n\nClarifying Question: Pick one?\nClarifying Options: [{"id":"one","label":"One","value":"first"},{"id":"two","label":"Two","value":"second"}]'; }, payload => {
    assert.equal(payload.sections.clarifyingOptions.length, 2);
  });
  await changed(env => { env.state.partialSuggestion = env.state.partialSuggestion.replace('"One"', '"Changed one"'); }, payload => {
    assert.equal(payload.sections.clarifyingOptions[0].label, "Changed one");
  });
  // Same raw answer, new accepted base display and profile: the real Hook rebuilds its overlay.
  await changed(() => {
    const next = stable("A-prime-final", "A", 3);
    next.suggestion.answerProfile = "compact-spoken";
    h.display.complete({ target: { sessionId: "session", logicalQuestionUnitId: "A", logicalQuestionRevision: 1,
      generationId: next.suggestion.id, traceId: next.suggestion.sourceTraceId, suggestionId: next.suggestion.id, stableRevision: next.revision },
      sections: next.display, stable: next, streaming: false });
  }, payload => {
    assert.equal(payload.sections.profile, "compact-spoken");
    assert.match(payload.sections.code, /A-prime-final/);
    assert.equal(payload.sections.whiteboard, "A-prime-final diagram");
  });
  await changed(env => { env.latestInterviewerTurnText = "New transcript while locked"; }, payload => {
    assert.equal(payload.latestTurnText, "New transcript while locked");
  });
  await changed(env => { env.meeting.error = "Controlled failure"; env.audioPauseResumeControl = { ...empty.audioControl, label: "Resume" }; }, payload => {
    assert.equal(payload.error, "Controlled failure");
    assert.equal(payload.audioControl.label, "Resume");
  });
  const before = h.published().length, acks = h.applied().length;
  await h.open("answer"); await h.drain();
  assert.equal(h.published().length, before, "reopening responds with existing sequence");
  assert.equal(h.applied().length, acks + 1, "new handshake records a fresh per-window confirmation");
  assert.equal(h.received.answer.at(-1).sequence, before);
  assert.equal(h.actions.length, 0);
});

test("BF3 completion, rejected replacement, unlock B and relock retain existing selection/ACK behavior", async t => {
  const h = await harness(t, true);
  await h.drain();
  const completed = stable("A-prime", "A", 3);
  const target = { sessionId: "session", logicalQuestionUnitId: "A", logicalQuestionRevision: 1,
    generationId: "A-prime", traceId: "trace-A-prime", suggestionId: "A-prime", stableRevision: 3 };
  await h.update(env => {
    h.display.complete({ target, sections: completed.display, stable: completed, streaming: false });
    env.state.partialSuggestion = "";
  });
  assert.equal(h.env.adviseDisplay.streaming, false);
  assert.equal(h.env.focusSnapshot.advisePin.locked, true);
  assert.equal(h.env.focusSnapshot.sections.primaryAnswer, "A-prime answer");
  await h.update(env => {
    env.displayedStreamRef.current = { ...env.displayedStreamRef.current, generationId: "failed", traceId: "trace-failed" };
    env.state.partialSuggestion = "Answer: Failed replacement preview";
  });
  assert.equal(h.display.revokeIncomplete("trace-failed"), true);
  await h.update(env => { env.state.partialSuggestion = ""; });
  assert.equal(h.env.focusSnapshot.sections.primaryAnswer, "A-prime answer");
  assert.equal(h.display.toggle(target).reason, "manual-unlock");
  h.rerender(); await h.drain();
  assert.equal(h.env.focusSnapshot.sections.primaryAnswer, "B answer");
  assert.match(h.env.focusSnapshot.sections.code, /B\(\)/);
  assert.equal(h.env.focusSnapshot.sections.whiteboard, "B diagram");
  assert.equal(h.env.focusSnapshot.advisePin.locked, false);
  assert.equal(h.display.awaitingApplication(h.env.adviseDisplay.target), false);
  assert.equal(h.display.toggle(h.env.adviseDisplay.target).accepted, true);
  await h.update(() => {});
  assert.equal(h.env.focusSnapshot.advisePin.locked, true);
  assert.equal(h.actions.length, 0);
});

test("BF3 Clear/new session empty fallback becomes quiescent", async t => {
  const h = await harness(t, true);
  await h.drain();
  await h.update(env => {
    h.display.clear(); env.stableAnswerRevisionRef.current = null;
    env.state.partialSuggestion = ""; env.displayedStreamRef.current = null;
    env.contextManagerRef.current.getState = () => ({ sessionId: "next-session" });
  });
  assert.equal(h.env.focusSnapshot.advisePin.locked, false);
  assert.equal(h.env.focusSnapshot.advisePin.target.sessionId, "next-session");
  assert.equal(h.env.focusSnapshot.sections.primaryAnswer, "");
  assert.equal(h.published().length, 2, "one initial preview and one cleared display");
  assert.equal(h.applied().length, 4, "both windows acknowledge both actual sequences");
  const cleared = h.env.focusSnapshot;
  for (let i = 0; i < 20; i++) { h.rerender(); await h.drain(); }
  assert.equal(h.env.focusSnapshot, cleared);
  assert.equal(h.published().length, 2);
  assert.equal(h.applied().length, 4);
  assert.equal(h.actions.length, 0);
});
