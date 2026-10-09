import { createMeetingId } from "../src/lib/meeting/meeting-id.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import {
  SessionRecordingManager,
  buildSessionRecordingProviderSummary,
} from "../src/lib/meeting/session-recording.js";
import { createInterviewSessionContextFromBrief } from "../src/lib/meeting/interview-session-context.js";
import {
  createNeutralPreparationRuntimeContext,
  loadPreparationRuntimeContext,
  toPreparationRuntimePresentation,
} from "../src/lib/meeting/preparation-runtime-context.js";
import { PreparationRuntimeProvenanceLedger } from "../src/lib/meeting/preparation-runtime-provenance.js";
import { createPlaybookPhaseHistoryState } from "../src/lib/meeting/playbook-phase-history.js";
import { toAnswerDeliveryPresentation } from "../src/lib/meeting/stable-answer.js";
import { MeetingTraceStore } from "../src/lib/meeting/trace.js";
import {
  buildCommittedTaskBoundaryParent,
  createTaskBoundaryCandidate,
} from "../src/lib/meeting/task-boundary-transaction.js";
import { setTestActiveParent } from "./helpers/meeting-task-runtime.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import {
  buildPreparationSnapshotArtifactManifest,
} from "../src/lib/preparation/snapshot-artifact-manifest.js";
import type { InterviewPreparationSnapshot } from "../src/lib/preparation/snapshot-types.js";
import { CaptureLifecycleCoordinator } from "../src/lib/meeting/capture-lifecycle.js";
import { EffectiveQuestionSourceLedger } from "../src/lib/meeting/effective-question-source-ledger.js";
import { createProvisionalCurrentQuestion } from "../src/lib/meeting/current-question-settlement.js";
import { compileSettledAdvisorPromptContext } from "../src/lib/meeting/settled-advisor-context.js";
import { buildAdvisorUserMessage } from "../src/lib/meeting/advisor-prompt.js";
import { authorizeRuntimeCommit, buildRuntimeCommitSnapshot, createRuntimeCommitToken } from "../src/lib/meeting/runtime-commit-authorization.js";
import { createRuntimeCriticalEventHarness, RUNTIME_CRITICAL_EVENT_HOOK_CALLBACKS } from "./helpers/runtime-critical-events.js";
import { createDiagnosticLogSpy } from "./helpers/diagnostic-log-spy.js";
import { createManualRuntimeActionEvent } from "../src/lib/meeting/manual-runtime-action.js";
import { parseRuntimeCriticalEventJournal, RUNTIME_CRITICAL_EVENT_JOURNAL_PATH } from "../src/lib/meeting/runtime-critical-event.js";

// Execute the production callbacks, as in the existing publication callback
// tests. The reset, epoch boundary, pin loader and both managers remain real.
const hookPath = "src/hooks/useMeetingAssistant.ts";
const source = process.env.JARVIS_RECORDING_START_BASELINE === "1"
  ? execFileSync("git", ["show", `HEAD:${hookPath}`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
  : readFileSync(hookPath, "utf8");
const parsed = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);
const callbacks = [
  "pinPreparationRuntimeForSession",
  "invalidateRuntimeWork",
  "advanceRuntimeEpoch",
  "pause",
  "resetMeetingRuntimeForNewSession",
  "startSessionRecording",
  "stopSessionRecording",
];
// Task 178A: the Hook's emit callbacks and the manual-action ledger writer, a
// real producer that needs no model. Absent from an older baseline source.
const criticalEventCallbacks = [...RUNTIME_CRITICAL_EVENT_HOOK_CALLBACKS, "recordManualRuntimeAction"];
const nodes = new Map<string, ts.Node>();
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && [...callbacks, ...criticalEventCallbacks].includes(node.name.getText(parsed))) {
    assert.ok(node.initializer && ts.isCallExpression(node.initializer));
    nodes.set(node.name.getText(parsed), node.initializer.arguments[0]!);
  }
  ts.forEachChild(node, visit);
}
visit(parsed);

function gate() {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { waiting, entered, promise, release };
}

function harness() {
  const calls: Array<{ command: string; args: Record<string, any> }> = [];
  const cancellations: string[] = [];
  const states: any[] = [];
  const context = new MeetingContextManager({ interviewSessionBrief: {
    targetCompany: "Example", companyLocked: true, interviewTypes: ["coding"],
  } });
  const now = Date.now();
  const unit: LogicalQuestionUnit = {
    id: "question", revision: 1, sessionId: context.getState().sessionId,
    runtimeEpoch: 7, currentTurnId: "original", sourceTurnIds: ["original"],
    sources: [{ turnId: "original", text: "Implement a cache", startedAt: now, endedAt: now }],
    normalizedText: "Implement a cache", startedAt: now, updatedAt: now,
    compositionReasons: [], boundaryReason: "bounded-continuation", truncated: false,
  };
  const candidate = createTaskBoundaryCandidate({
    logicalQuestionUnit: unit, proposedQuestionType: "coding", proposedRelation: "new-parent",
    authoritySource: "accepted-transcript", confidence: 0.95, questionComplete: true,
    mutationAuthorized: true, commitParent: true, now,
  });
  assert.ok(candidate);
  const parent = buildCommittedTaskBoundaryParent({ candidate, logicalQuestionUnit: unit, source: "voice", now });
  assert.ok(parent);
  setTestActiveParent(context, parent);
  context.addTranscriptTurn({ id: "original", text: "Implement a cache", speaker: "them", startedAt: now, endedAt: now, isFinal: true, source: "system-audio" });
  let io: (command: string, args: Record<string, any>) => Promise<void> = async () => {};
  let selection: () => Promise<any> = async () => ({ revision: 1, updatedAt: now });
  let ui: any = {
    status: "listening", settings: { codingModel: { enabled: false, provider: "", variables: {} }, taxonomyAdjudication: { enabled: true, provider: "", variables: {} } },
    latestSuggestion: { answer: "Original answer", code: "original code", whiteboard: "original whiteboard" },
    latestReliableSuggestion: { answer: "Reliable" }, partialSuggestion: "Streaming",
    presentationArtifactResetRevision: 3, error: null,
  };
  const manager = new SessionRecordingManager((state) => {
    ui = { ...ui, sessionRecording: state };
    states.push(state);
  }, async <T>(command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    await io(command, args);
    return `/recordings/${args.folderName}` as T;
  });
  const globals: Record<string, any> = {};
  for (const node of nodes.values()) {
    const collect = (child: ts.Node) => {
      if (ts.isPropertyAccessExpression(child) && child.name.text === "current" && ts.isIdentifier(child.expression)) {
        globals[child.expression.text] ??= { current: Object.assign(new Map(), {
          cancelAll: () => cancellations.push(child.expression.getText(parsed)),
          cancel: () => cancellations.push(child.expression.getText(parsed)),
          reset: () => cancellations.push(child.expression.getText(parsed)),
        }) };
      }
      ts.forEachChild(child, collect);
    };
    collect(node);
  }
  const preparation = createNeutralPreparationRuntimeContext({ meetingSessionId: context.getState().sessionId, preparationContextRevision: 4 });
  // Task 178A: the real stream, bound to the runtime session as the Hook binds
  // it at mount. The auto-stubbed Map above must not stand in for it.
  const criticalEvents = createRuntimeCriticalEventHarness({ sessionId: context.getState().sessionId });
  // Task 178 LG: the Hook's recording stop makes one entry of the diagnostic log when the close fails, with the logger
  // leaf's summary of the error. The real logger, its delivery controlled; tests/diagnostic-log-migration.test.ts
  // drives that entry.
  const diagnosticLog = createDiagnosticLogSpy();
  Object.assign(globals, {
    ...criticalEvents.hookRefs,
    logDiagnostic: diagnosticLog.logDiagnostic, diagnosticLogCause: diagnosticLog.logger.diagnosticLogCause,
    console, Promise, Date, JSON, Map, Set, Error, AbortController,
    languageAdmissionControllerRef: { current: new AbortController() },
    sessionLanguageObservationRef: { current: undefined },
    createMeetingId, createInterviewSessionContextFromBrief,
    createNeutralPreparationRuntimeContext, loadPreparationRuntimeContext,
    toPreparationRuntimePresentation, PreparationRuntimeProvenanceLedger,
    createPlaybookPhaseHistoryState, toAnswerDeliveryPresentation,
    buildSessionRecordingProviderSummary,
    resolveTaxonomyAdjudicationModelRouteFromSnapshot: () => ({}),
    getActiveMeetingTaskTraceMetadata: () => ({}),
    interviewPreparationSnapshotService: {
      getCurrentContext: () => selection(),
      getCurrentSnapshotForRuntimePin: async () => undefined,
    },
    state: ui,
    setState: (update: (previous: any) => any) => { ui = update(ui); },
    setPreparationArtifactUses: () => {}, setPreparationArtifactEvaluations: () => {},
    setScriptedValidation: () => {},
    aiProvider: undefined, codingAiProvider: undefined, sttProvider: undefined,
    selectedAIProvider: { provider: "" }, selectedSttProvider: { provider: "" },
    contextManagerRef: { current: context }, sessionRecordingManagerRef: { current: manager },
    preparationRuntimeContextRef: { current: preparation },
    preparationProvenanceLedgerRef: { current: new PreparationRuntimeProvenanceLedger(preparation) },
    preparationContextRevisionRef: { current: 4 }, preparationPinRequestRef: { current: 2 },
    latestPreparationSelectionRevisionRef: { current: 1 },
    runtimeEpochRef: { current: 7 }, activeRef: { current: true }, runtimeActiveRef: { current: true },
    traceStoreRef: { current: new MeetingTraceStore() }, speechCorrectionsRef: { current: [] },
    pendingConfirmationRef: { current: null }, pendingSentenceCompletionRef: { current: null },
    screenAnalysisAbortRef: { current: new AbortController() },
    scriptedValidationRef: { current: false },
    shutdownRequestedRef: { current: false },
    microphoneVadDisposeRef: { current: async () => { cancellations.push("microphone-dispose"); } },
    microphoneSpeakingRef: { current: true },
    cancelActiveAdvisorJob: () => cancellations.push("advisor"),
    abortActiveSttRequests: () => cancellations.push("stt"),
    clearPendingAnswerCommitTimer: () => cancellations.push("answer-timer"),
    clearPendingConfirmationForRuntimeReset: () => {},
    clearPendingSentenceCompletionForRuntimeReset: () => {},
    revokeAudioDrainAuthorization: () => cancellations.push("audio-drain"),
    settleAwaitingVisualEvidenceRecovery: () => cancellations.push("visual-recovery"),
  });
  globals.codingSolutionManifestCacheRef.current.set("original", "code artifact");
  globals.generationResultLedgerRef.current.set("original", "whiteboard artifact");
  const screenController = globals.screenAnalysisAbortRef.current as AbortController;
  Object.assign(globals, { createManualRuntimeActionEvent, visibleAnswerRevisionRef: { current: 0 } });
  const sandbox = vm.createContext(globals);
  for (const name of [...callbacks, ...criticalEventCallbacks]) {
    const node = nodes.get(name);
    if (!node && criticalEventCallbacks.includes(name)) continue;
    assert.ok(node, name);
    const code = ts.transpileModule(`globalThis.${name} = ${node.getText(parsed)};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
    }).outputText;
    vm.runInContext(code, sandbox);
  }
  return {
    manager, context, unit, calls, cancellations, states, globals, screenController, criticalEvents,
    ui: () => ui,
    setIo: (next: typeof io) => { io = next; },
    setSelection: (next: typeof selection) => { selection = next; },
    start: () => globals.startSessionRecording(),
    stop: () => globals.stopSessionRecording("test-stop", { throwOnError: true }),
    progress: () => {
      context.addTranscriptTurn({ id: "during-io", text: "New legitimate input", speaker: "them", startedAt: now + 1, endedAt: now + 2, isFinal: true, source: "system-audio" });
      ui = { ...ui, latestSuggestion: { answer: "Answer completed during I/O", code: "new code", whiteboard: "new whiteboard" } };
    },
  };
}

test("PC1/PC2/PC5 real Pause preserves context while rejecting old execution tokens", async () => {
  const h = harness();
  const g = h.globals;
  const ledger = new EffectiveQuestionSourceLedger();
  const source = createProvisionalCurrentQuestion({ logicalQuestionUnit: h.unit, sourceKind: "voice" });
  const task = h.context.getState().activeMeetingTask!;
  ledger.upsert({ recordId: "source-before-pause", sessionId: source.sessionId, runtimeEpoch: source.runtimeEpoch,
    logicalQuestionUnitId: h.unit.id, logicalQuestionRevision: h.unit.revision, sourceHash: source.sourceHash,
    sourceKind: "voice", currentTurnId: h.unit.currentTurnId, sourceTurnIds: [...h.unit.sourceTurnIds],
    text: h.unit.normalizedText, effectiveSourceTexts: [{ turnId: h.unit.currentTurnId, text: h.unit.normalizedText }],
    startedAt: h.unit.startedAt, updatedAt: h.unit.updatedAt, settledAt: h.unit.updatedAt,
    speechAct: "question", disposition: "answer-primary-ask", relation: "new-parent",
    owner: { kind: "parent-mainline", parentId: task.parent.id } });
  const before = h.context.getState();
  const token = createRuntimeCommitToken({ operationId: "old-answer", pipeline: "advisor",
    snapshot: buildRuntimeCommitSnapshot({ contextState: before, runtimeEpoch: 7 }) });
  const latestManualTarget = { logicalQuestionUnit: h.unit };
  const audioOrder: string[] = [];
  Object.assign(g, {
    effectiveQuestionSourceLedgerRef: { current: ledger }, logicalQuestionUnitRef: { current: h.unit },
    latestManualCorrectionTargetRef: { current: latestManualTarget }, manualCorrectionRevisionRef: { current: 2 },
    captureLifecycleCoordinatorRef: { current: new CaptureLifecycleCoordinator() },
    readNativeCaptureLease: () => undefined, openAudioDrainAuthorization: () => {},
    cancelNativeAudioFaultTraces: () => {},
    microphoneVadDisposeRef: { current: async () => { audioOrder.push("microphone-dispose"); } },
    stopNativeMeetingCapture: async () => {
      audioOrder.push("native-stop");
      assert.equal(g.microphoneSpeakingRef.current, false);
      return { status: { active: false } };
    },
    drainSystemAudioQueueForNativeStop: async () => { audioOrder.push("queue-drain"); },
    invalidateAudioProcessingSession: () => {},
  });
  const history = ledger.listHistory();
  for (const epoch of [8, 9]) {
    g.microphoneSpeakingRef.current = true;
    await g.pause();
    assert.equal(g.runtimeEpochRef.current, epoch);
    assert.deepEqual(h.context.getState(), before);
    assert.deepEqual(ledger.listHistory(), history);
    assert.equal(g.logicalQuestionUnitRef.current, h.unit);
    assert.equal(g.latestManualCorrectionTargetRef.current, latestManualTarget);
    assert.equal(g.manualCorrectionRevisionRef.current, 2);
    assert.equal(h.ui().status, "paused");
    const snapshot = buildRuntimeCommitSnapshot({ contextState: h.context.getState(), runtimeEpoch: epoch });
    assert.equal(authorizeRuntimeCommit({ token, current: snapshot, currentOperationId: token.operationId }).authorized, false);
    const fresh = createRuntimeCommitToken({ operationId: `resumed-${epoch}`, pipeline: "advisor", snapshot });
    assert.equal(authorizeRuntimeCommit({ token: fresh, current: snapshot, currentOperationId: fresh.operationId }).authorized, true);
    const compiled = compileSettledAdvisorPromptContext({ baseContext: h.context.buildAdvisorPromptContext(),
      contextReadScope: "active-parent-read", logicalQuestionUnit: h.unit,
      transcriptTurns: before.transcriptTurns, effectiveRecords: ledger.listHistory(),
      sessionId: source.sessionId, runtimeEpoch: epoch });
    assert.match(buildAdvisorUserMessage(compiled.context), /Implement a cache/);
    assert.deepEqual(compiled.selectedSourceTurnIds, [h.unit.currentTurnId]);
  }
  assert.deepEqual(audioOrder, [
    "microphone-dispose", "native-stop", "queue-drain",
    "microphone-dispose", "native-stop", "queue-drain",
  ]);
  assert.ok(h.cancellations.includes("advisor"));
  assert.ok(!h.cancellations.includes("visual-recovery"));
  g.advanceRuntimeEpoch("active-task-cleared");
  assert.equal(ledger.listHistory().length, 0);
  assert.equal(g.logicalQuestionUnitRef.current, undefined);
  assert.ok(h.cancellations.includes("visual-recovery"));
});

for (const failure of ["folder", "manifest.json", "settings/meeting-assistant-settings.json", "settings/interview-brief.json", "settings/provider-summary.json", "preparation/runtime-context.latest.json", "preparation"] as const) {
  test(`RS1: real recording start preserves ongoing Meeting through ${failure} failure`, async () => {
    const h = harness();
    const pending = gate();
    const before = h.context.getState();
    const pin = h.globals.preparationRuntimeContextRef.current;
    if (failure === "preparation") {
      h.setSelection(async () => { pending.entered(); await pending.promise; throw new Error("controlled preparation failure"); });
    } else {
      let failed = false;
      h.setIo(async (command, args) => {
        if (!failed && (failure === "folder" ? command === "start_meeting_session_recording" : args.relativePath === failure)) {
          failed = true;
          pending.entered();
          await pending.promise;
          throw new Error("controlled file failure");
        }
      });
    }
    const start = h.start();
    await pending.waiting;
    h.progress();
    const withProgress = h.context.getState();
    const suggestion = h.ui().latestSuggestion;
    pending.release();
    assert.equal(await start, undefined);
    assert.equal(h.globals.runtimeEpochRef.current, 7);
    assert.deepEqual(h.context.getState(), withProgress);
    assert.equal(h.context.getState().sessionId, before.sessionId);
    assert.equal(h.ui().latestSuggestion, suggestion);
    assert.equal(h.ui().presentationArtifactResetRevision, 3);
    assert.equal(h.globals.preparationRuntimeContextRef.current, pin);
    assert.equal(h.globals.preparationContextRevisionRef.current, 4);
    assert.equal(h.globals.codingSolutionManifestCacheRef.current.get("original"), "code artifact");
    assert.equal(h.globals.generationResultLedgerRef.current.get("original"), "whiteboard artifact");
    assert.equal(h.screenController.signal.aborted, false);
    assert.deepEqual(h.cancellations, []);
    assert.equal(h.states.some((state) => state.active), false);
    assert.equal(h.manager.getState().lifecycle, "idle");
    assert.match(h.ui().error, /controlled/);
    if (failure !== "preparation") {
      assert.ok(h.calls.some((call) => call.args.relativePath === "startup-failure.json"));
    }
  });
}

for (const entry of ["recording", "session-pin"] as const) {
  test(`K4/RS1: ${entry} uses the checked Snapshot reader, not the inspection reader`, async () => {
    const h = harness();
    const before = h.context.getState();
    h.setSelection(async () => ({ revision: 8, updatedAt: 200, processId: "process", roundId: "round", selectedSnapshotId: "snapshot" }));
    let checkedReads = 0;
    h.globals.interviewPreparationSnapshotService.getCurrentSnapshot = async () => {
      throw new Error("Inspection reader must not authorize a runtime pin.");
    };
    h.globals.interviewPreparationSnapshotService.getCurrentSnapshotForRuntimePin = async () => {
      checkedReads += 1;
      throw new Error("Selected Snapshot evidence is unverified.");
    };
    if (entry === "recording") {
      assert.equal(await h.start(), undefined);
      assert.deepEqual(h.context.getState(), before);
      assert.deepEqual(h.cancellations, []);
      assert.equal(h.manager.getState().active, false);
      assert.match(h.ui().error, /unverified/);
    } else {
      const result = await h.globals.pinPreparationRuntimeForSession(before.sessionId);
      assert.equal(result.context.loadState, "failed");
    }
    assert.equal(checkedReads, 1);
  });
}

test("RS2: duplicate start commits one real fresh reset and matching runtime/pin/manifest identities", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const h = harness();
  h.setIo(async () => { now += 25; });
  const original = h.context.getState();
  const [first, duplicate] = await Promise.all([h.start(), h.start()]);
  assert.ok(first?.active, h.ui().error);
  assert.equal(first.sessionId, duplicate.sessionId);
  assert.equal(h.calls.filter((call) => call.command === "start_meeting_session_recording").length, 1);
  assert.equal(h.globals.runtimeEpochRef.current, 8);
  assert.equal(h.ui().presentationArtifactResetRevision, 4);
  assert.equal(h.cancellations.filter((reason) => reason === "advisor").length, 1);
  assert.equal(h.screenController.signal.aborted, true);
  const context = h.context.getState();
  assert.notEqual(context.sessionId, original.sessionId);
  assert.equal(context.transcriptTurns.length, 0);
  assert.equal(context.activeMeetingTask, undefined);
  const manifest = JSON.parse(h.calls.find((call) => call.args.relativePath === "manifest.json")!.args.payload);
  assert.equal(manifest.meetingSessionId, context.sessionId);
  assert.equal(first.meetingSessionId, context.sessionId);
  assert.equal(manifest.preparationRuntimeContext.meetingSessionId, context.sessionId);
  assert.equal(manifest.preparationRuntimeContext.preparationContextRevision, h.globals.preparationRuntimeContextRef.current.preparationContextRevision);
  assert.deepEqual(manifest.interviewSessionBrief, context.interviewSessionBrief);
  assert.deepEqual(manifest.interviewSessionContext, context.interviewSessionContext);
  await h.stop();
});

test("RS2: selected Preparation snapshot is pinned before reset and matches the required manifest", async () => {
  const h = harness();
  const payload = {
    runtimeBrief: {
      company: "Example", role: "Engineer", roundId: "round", roundTitle: "Coding",
      stage: "coding" as const, expectedInterviewTypes: ["coding" as const],
      expectedTypePolicy: "restricted" as const, focusAreas: [], compactNotes: [],
      unresolvedHighImpactAssumptions: [],
    },
    strategy: { priorities: ["Clarify first"], risks: [], questionsToAsk: [], likelyBranches: [], timeAllocation: [] },
    evidencePack: { items: [] }, speechBiasTerms: [], openingPack: { items: [] },
    narrativePack: { graphs: [] }, playbookOverlays: [], evidenceIndex: [], warnings: [],
    sessionLaunchPlan: {
      recommendedRuntimeConfiguration: { expectedInterviewTypes: ["coding" as const], expectedTypePolicy: "restricted" as const },
      smokeTests: [], interviewFlow: [], emergencyActions: [], warnings: [], promptExcluded: true as const,
    },
    sourceManifest: {
      process: { id: "process", contentHash: "process-hash" }, round: { id: "round", contentHash: "round-hash" },
      profile: { id: "profile", revision: 1, contentHash: "profile-hash", sourceFingerprint: "profile-source" },
      statements: [], narrativeNodes: [], materials: [], kmbEntries: [],
      compilerVersion: "compiler", playbookRegistryVersion: "playbook", runtimeCapabilityVersion: "runtime",
    },
  };
  const snapshot: InterviewPreparationSnapshot = {
    ...payload, id: "snapshot", processId: "process", roundId: "round", version: 2,
    profileRevisionId: "profile", profileRevision: 1, compilerVersion: "compiler",
    playbookRegistryVersion: "playbook", runtimeCapabilityVersion: "runtime", sourceFingerprint: "source",
    contentHash: "snapshot-hash", runtimeCharCount: 100, status: "active", createdAt: 100, activatedAt: 200,
    artifactManifest: buildPreparationSnapshotArtifactManifest({ snapshotId: "snapshot", payload }),
  };
  h.setSelection(async () => ({ revision: 8, updatedAt: 200, processId: "process", roundId: "round", selectedSnapshotId: "snapshot" }));
  h.globals.interviewPreparationSnapshotService.getCurrentSnapshotForRuntimePin = async () => snapshot;
  assert.ok((await h.start())?.active, h.ui().error);
  const pin = h.globals.preparationRuntimeContextRef.current;
  assert.equal(pin.mode, "prepared");
  assert.equal(pin.pinnedSnapshot.snapshotId, snapshot.id);
  assert.equal(pin.pinnedSnapshot.contentHash, snapshot.contentHash);
  assert.equal(pin.meetingSessionId, h.context.getState().sessionId);
  const manifest = JSON.parse(h.calls.find((call) => call.args.relativePath === "manifest.json")!.args.payload);
  assert.deepEqual(manifest.preparationRuntimeContext.pinnedSnapshot, pin.pinnedSnapshot);
  assert.equal(manifest.preparationRuntimeContext.preparationContextRevision, pin.preparationContextRevision);
  await h.stop();
});

test("RS2: delayed preparation cannot reset a replacement Meeting", async () => {
  const h = harness();
  const pending = gate();
  h.setIo(async (_command, args) => {
    if (args.relativePath === "settings/provider-summary.json") {
      pending.entered(); await pending.promise;
    }
  });
  const start = h.start();
  await pending.waiting;
  h.context.reset();
  h.globals.runtimeEpochRef.current += 1;
  h.progress();
  const replacement = h.context.getState();
  pending.release();
  assert.equal(await start, undefined);
  assert.deepEqual(h.context.getState(), replacement);
  assert.deepEqual(h.cancellations, []);
  assert.equal(h.manager.getState().active, false);
});

test("RC1/RC3: Hook strict close rejects, retained inactive owner leaves ongoing Meeting intact, retry resolves", async () => {
  const h = harness();
  await h.start();
  h.progress();
  const before = h.context.getState();
  const cancellations = [...h.cancellations];
  h.setIo(async (_command, args) => {
    if (args.relativePath === "manifest.json" && JSON.parse(args.payload).status === "stopped") {
      throw new Error("terminal failure");
    }
  });
  await assert.rejects(h.stop(), /terminal failure/);
  assert.equal(h.manager.getState().active, false);
  assert.equal(h.manager.getState().lifecycle, "close-failed");
  assert.equal(await h.start(), undefined);
  assert.deepEqual(h.context.getState(), before);
  assert.deepEqual(h.cancellations, cancellations);
  h.progress();
  const suggestion = h.ui().latestSuggestion;
  h.setIo(async () => {});
  const stopped = await h.stop();
  assert.equal(stopped.lifecycle, "idle");
  assert.equal(h.ui().latestSuggestion, suggestion);
});

// ===========================================================================
// Task 178A (AE3, AE5, AE6): the stream follows the runtime session through the
// Hook's real reset and the real Recording start and stop. The producer here
// is the Hook's real manual-action ledger writer.
// ===========================================================================

function journalWrites(h: ReturnType<typeof harness>) {
  return h.calls.filter((call) => call.args.relativePath === RUNTIME_CRITICAL_EVENT_JOURNAL_PATH);
}
// The recorder enqueues synchronously; its existing write queue performs the I/O.
const queuedWrites = () => new Promise<void>((resolve) => setImmediate(resolve));
function manualTerminal(h: ReturnType<typeof harness>, actionId: string) {
  h.globals.recordManualRuntimeAction({ actionId, action: "clear-task", stage: "terminal",
    terminalDisposition: "completed", reason: "active-task-cleared" });
}

test("AE5/AE6 a Recording start resets the runtime and rebinds the stream in the same commit: the old session's observer ends with one closed marker, the new session starts at sequence 1 and is saved with its recording generation; Recording off saves nothing", async () => {
  const h = harness();
  const stream = h.criticalEvents.stream;
  const oldSession = h.context.getState().sessionId;
  assert.equal(stream.getStats().boundSessionId, oldSession);
  manualTerminal(h, "before-recording");
  assert.equal(h.criticalEvents.events().length, 1);
  assert.equal(journalWrites(h).length, 0, "Recording is off: nothing is written and no recording is started");
  assert.equal(h.calls.length, 0);
  assert.equal(stream.getStats().recording["not-recording"], 1);

  assert.ok((await h.start())?.active, h.ui().error);
  const newSession = h.context.getState().sessionId;
  assert.notEqual(newSession, oldSession);
  const bound = stream.getStats();
  assert.equal(bound.boundSessionId, newSession, "bound where the runtime session id changed");
  assert.equal(bound.lastSequence, 0, "the new session's sequence starts over");
  h.criticalEvents.flush();
  // The old session's observer: its own fact, then closed. Nothing afterwards.
  assert.deepEqual(h.criticalEvents.deliveries.map((delivery) => delivery.kind), ["event", "closed"]);
  assert.deepEqual(h.criticalEvents.deliveries[1], { kind: "closed", schemaVersion: 1,
    runtimeSessionId: oldSession, reason: "session-rebound", lastSequence: 1, discarded: 0 });
  assert.equal(stream.getStats().subscribers, 0, "the old session's subscription was released");
  // The event of before the recording was not back-filled into it.
  assert.equal(journalWrites(h).length, 0);

  const observed: string[] = [];
  const subscription = stream.subscribe((delivery) => {
    observed.push(delivery.kind === "event" ? `${delivery.event.runtimeSessionId}#${delivery.event.sequence}` : delivery.kind);
  });
  assert.equal(subscription.runtimeSessionId, newSession);
  manualTerminal(h, "recorded-1");
  manualTerminal(h, "recorded-2");
  // Accepted synchronously where the fact was produced; nothing was awaited.
  assert.equal(stream.getStats().recording.accepted, 2);
  await queuedWrites();
  const recorded = journalWrites(h);
  assert.equal(recorded.length, 2, "one appended line per event through the existing write queue");
  assert.equal(recorded.every((call) => call.command === "write_meeting_session_recording_text" && call.args.append === true), true);
  const state = h.manager.getState();
  const journal = parseRuntimeCriticalEventJournal(recorded.map((call) => call.args.payload).join(""));
  assert.ok(journal.status === "ok");
  assert.equal(journal.contiguous, true);
  assert.deepEqual(journal.sessions.map((session) => [session.runtimeSessionId, session.firstSequence, session.lastSequence]),
    [[newSession, 1, 2]]);
  assert.deepEqual(journal.sessions[0]!.events.map((event) => [event.refs.manualActionId, event.terminal?.disposition]),
    [["recorded-1", "completed"], ["recorded-2", "completed"]]);
  assert.equal(journal.sessions[0]!.events.every((event) => event.recordingSessionId === state.sessionId), true);
  assert.equal(new Set(journal.sessions[0]!.events.map((event) => event.recordingGenerationId)).size, 1);
  // The recording's own counters and timeline were not touched by the events.
  const eventCountBefore = h.manager.getState().eventCount;
  manualTerminal(h, "recorded-3");
  assert.equal(h.manager.getState().eventCount - eventCountBefore, 1,
    "only the manual-action ledger's own timeline event counts; the critical event adds none");

  // Stopping the Recording does not stop the runtime: events stay in memory.
  await h.stop();
  manualTerminal(h, "after-recording");
  await queuedWrites();
  assert.equal(journalWrites(h).length, 3, "nothing is written after the recording stopped");
  h.criticalEvents.flush();
  assert.deepEqual(observed, [`${newSession}#1`, `${newSession}#2`, `${newSession}#3`, `${newSession}#4`]);
  assert.equal(stream.getStats().recording.accepted, 3);
  const manifest = JSON.parse(h.calls.filter((call) => call.args.relativePath === "manifest.json").at(-1)!.args.payload);
  assert.deepEqual(manifest.runtimeMeetingSessionIds, [newSession], "the runtime-session id set is the recording's own");
  assert.equal(manifest.recordingIntegrity.status, "complete");
});

test("AE5 real reset: an in-flight observer of the old session cannot be reached by the new session, a fact of the old session that was still queued is not handed over after the reset, and a late old-session fact is refused instead of renumbered", () => {
  const h = harness();
  const stream = h.criticalEvents.stream;
  const oldSession = h.context.getState().sessionId;
  manualTerminal(h, "old-1");
  manualTerminal(h, "old-2");
  // The first fact is delivered while its session is the current one. The
  // second is still queued when the real reset changes the session.
  assert.deepEqual(h.criticalEvents.events().map((event) => event.refs.manualActionId), ["old-1", "old-2"]);
  manualTerminal(h, "old-3");
  h.globals.resetMeetingRuntimeForNewSession("meeting-assistant-started");
  const newSession = h.context.getState().sessionId;
  assert.notEqual(newSession, oldSession);
  // A fact whose own token still names the old session, arriving late.
  h.globals.emitLogicalQuestionUnitCommitted(h.unit, "canonical-publish", "late-trace");
  manualTerminal(h, "new-1");
  h.criticalEvents.flush();
  assert.deepEqual(h.criticalEvents.deliveries.map((delivery) =>
    delivery.kind === "event" ? delivery.event.refs.manualActionId : delivery.kind), ["old-1", "old-2", "closed"]);
  // One closed marker, with the reason and the fact that was not handed over.
  assert.deepEqual(h.criticalEvents.deliveries.at(-1), { kind: "closed", schemaVersion: 1,
    runtimeSessionId: oldSession, reason: "session-rebound", lastSequence: 3, discarded: 1 });
  const stats = stream.getStats();
  assert.equal(stats.discardedUndelivered, 1);
  assert.equal(stats.staleSessionRejected, 1);
  assert.equal(stats.lastSequence, 1, "the late old fact did not take a sequence of the new session");
  assert.equal(stats.boundSessionId, newSession);
});
