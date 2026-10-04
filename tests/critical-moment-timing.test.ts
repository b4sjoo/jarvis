import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as timing from "../src/lib/meeting/critical-moment-timing.js";
import * as evaluation from "../src/lib/meeting/critical-moment-evaluation.js";
import { validateTranscriptCandidate } from "../src/lib/meeting/transcript-validation.js";
import { createMeetingId } from "../src/lib/meeting/meeting-id.js";
import { SessionRecordingManager } from "../src/lib/meeting/session-recording.js";
import { buildSessionLongitudinalEvaluationReport } from "../scripts/lib/session-longitudinal-evaluation.js";
import type { MeetingAssistantSettings, MeetingTrace, TranscriptTurn } from "../src/lib/meeting/types.js";
import { createRuntimeCriticalEventHarness, RUNTIME_CRITICAL_EVENT_HOOK_CALLBACKS } from "./helpers/runtime-critical-events.js";

const hook = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
const ui = ts.createSourceFile("ui.tsx", readFileSync("src/pages/app/components/meeting/index.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => { if (predicate(node)) found ??= node; if (!found) ts.forEachChild(node, visit); };
  visit(root); assert.ok(found); return found;
}
function run(source: string, context: vm.Context): any {
  return vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
}
function callback(name: string, context: vm.Context) {
  const node = find(hook, n => ts.isVariableDeclaration(n) && n.name.getText(hook) === name) as ts.VariableDeclaration;
  return run(`(${(node.initializer as ts.CallExpression).arguments[0].getText(hook)})`, context);
}

// Task 178A: the Hook's own emit callbacks, extracted once.
const criticalEventCallbackSources = Object.fromEntries(RUNTIME_CRITICAL_EVENT_HOOK_CALLBACKS.map((name) => {
  const node = find(hook, n => ts.isVariableDeclaration(n) && n.name.getText(hook) === name) as ts.VariableDeclaration;
  return [name, `(${(node.initializer as ts.CallExpression).arguments[0].getText(hook)})`];
})) as Record<string, string>;

async function harness() {
  const writes = new Map<string, string>();
  const manager = new SessionRecordingManager(undefined, async <T>(command: string, args: Record<string, unknown> = {}) => {
    if (command === "start_meeting_session_recording") return "/fixture" as T;
    if (typeof args.relativePath === "string" && typeof args.payload === "string") writes.set(args.relativePath, args.payload);
    return "/fixture" as T;
  });
  await manager.start({ meetingSessionId: "session", settings: {
    codingModel: { enabled: false, provider: "", variables: {} },
    taxonomyAdjudication: { enabled: true, provider: "", variables: {} },
  } as unknown as MeetingAssistantSettings,
    providerSummary: { hasMainProvider: false, hasCodingProvider: false, hasTaxonomyAdjudicationProvider: false, hasSttProvider: false, mainSupportsImages: false, codingSupportsImages: false } });
  const base = Date.now();
  const turn: TranscriptTurn = { id: "them", text: "Explain the cache capacity and eviction tradeoff.", speaker: "them", source: "system-audio", startedAt: base + 100, endedAt: base + 200, isFinal: true };
  const runtime = { sessionId: "session", transcriptTurns: [turn] };
  const trace: MeetingTrace = { id: "answer", kind: "voice", status: "success", startedAt: 200, endedAt: 999999,
    steps: [], inputs: [], outputs: [], metadata: { logicalQuestionUnitId: "lqu", logicalQuestionUnitRevision: 1 } };
  const candidate = evaluation.buildCriticalMomentCandidates({ sessionId: "session", transcriptTurns: [turn],
    traces: [{ traceId: trace.id, sourceTurnIds: [turn.id], logicalQuestionUnitId: "lqu" }], now: 210 })[0];
  manager.recordTranscriptTurn(turn);
  manager.recordCriticalMomentCandidates([candidate]);
  const env: Record<string, any> = { ...evaluation, ...timing, validateTranscriptCandidate, createMeetingId, performance,
    Date: class extends Date { static now() { return base + 300; } }, window: {},
    fetchSTT: async () => "I would clarify the cache capacity before implementation.",
    criticalMomentCandidatesRef: { current: [candidate] }, criticalMomentEvaluationsRef: { current: [] },
    contextManagerRef: { current: { getState: () => runtime } }, sessionRecordingManagerRef: { current: manager },
    traceStoreRef: { current: { getTraces: () => [trace], updateMetadata: (_id: string, data: object) => Object.assign(trace.metadata!, data) } },
    setCriticalMomentEvaluations: () => {}, refreshRecordedCompletedTrace: () => {},
    manualAdviseDisplayRef: { current: { acknowledgeApplied() {}, awaitingApplication: () => false, capture: () => null, locked: false } },
    shutdownRequestedRef: { current: false }, state: { settings: { personalEvidenceGuardrailMode: "off" } },
  };
  const context = vm.createContext(env);
  const criticalEvents = createRuntimeCriticalEventHarness({ sessionId: "session" });
  criticalEvents.install(env, (name) => run(criticalEventCallbackSources[name], context));
  for (const name of ["updateCriticalMomentEvaluation", "readCriticalMomentTimingCandidates", "confirmCriticalMomentTiming", "recordAdviseDisplayApplied"]) env[name] = callback(name, context);
  const transcription = ts.createSourceFile("stt.ts", readFileSync("src/lib/meeting/transcription.service.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const transcribeNode = find(transcription, n => ts.isFunctionDeclaration(n) && n.name?.text === "transcribeMeetingAudio");
  const transcribe = run(`(${transcribeNode.getText(transcription).replace("export ", "")})`, context);
  const me = (await transcribe({ audio: {}, speaker: "me", source: "microphone", startedAt: base + 400, endedAt: base + 500 })).turn;
  assert.ok(me); runtime.transcriptTurns.push(me); manager.recordTranscriptTurn(me);
  const target = { sessionId: "session", traceId: trace.id, logicalQuestionUnitId: "lqu", logicalQuestionRevision: 1,
    suggestionId: "suggestion", generationId: "suggestion", stableRevision: 2 };
  env.readTiming = () => env.readCriticalMomentTimingCandidates(candidate.momentId);
  env.onConfirmTiming = (selection: timing.CriticalMomentTimingSelection) => env.confirmCriticalMomentTiming(candidate.momentId, selection);
  env.onUpdate = (patch: evaluation.CriticalMomentOutcomeEvaluationPatch) => env.updateCriticalMomentEvaluation(candidate.momentId, patch);
  env.setTiming = () => {}; env.trace = trace;
  return { env, context, runtime, trace, candidate, me, target, manager, writes, transcribe, base };
}

function uiEvent(attribute: string, contains: string, context: vm.Context) {
  const node = find(ui, n => ts.isJsxAttribute(n) && n.name.getText(ui) === attribute && n.getText(ui).includes(contains)) as ts.JsxAttribute;
  return run(`(${(node.initializer as ts.JsxExpression).expression!.getText(ui)})`, context);
}

test("capture timestamps -> real UI confirmation -> existing storage/recorder -> dual CMSR; clear survives reload", async () => {
  const store = new Map<string, string>();
  const globals = globalThis as any;
  globals.window = {}; globals.localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) };
  const h = await harness();
  try {
    for (const surface of ["normal-mode", "focus-mode"]) {
      delete h.trace.metadata!.advisorOutputAppliedToDisplay;
      h.env.recordAdviseDisplayApplied(h.target, surface, false);
      assert.equal(h.env.readTiming().answers[0].surface, surface);
    }
    assert.equal(h.env.readTiming().speech[0].startedAt, h.base + 400);
    assert.equal(h.env.criticalMomentEvaluationsRef.current.length, 0);
    uiEvent("onChange", "speech-start", h.context)({ target: { value: h.me.id } });
    uiEvent("onClick", "const current = readTiming()", h.context)();
    h.env.onUpdate({ eligibility: "critical", useful: true, trustworthy: true });
    const saved = evaluation.readCriticalMomentEvaluations()[0];
    assert.equal(saved.firstUsefulAt, h.base + 300);
    assert.equal(saved.userSpeechStartAt, h.base + 400);
    assert.equal(saved.userSpeechStartTurnId, h.me.id);
    assert.equal(saved.selectedUsefulDisplayTarget?.stableRevision, 2);
    const before = JSON.stringify(saved);
    h.env.readTiming(); assert.equal(JSON.stringify(evaluation.readCriticalMomentEvaluations()[0]), before);
    await h.manager.flushAggregates();
    for (let i = 0; i < 50 && !h.writes.has("human-evaluation/critical-moment-evaluations.json"); i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const recorded = JSON.parse(h.writes.get("human-evaluation/critical-moment-evaluations.json")!);
    const report = buildSessionLongitudinalEvaluationReport([{ directory: "/fixture", manifest: { sessionId: "session" },
      transcriptTurns: h.runtime.transcriptTurns, traceSummaries: [], questionEvaluations: [],
      criticalMomentCandidates: [h.candidate], criticalMomentEvaluations: recorded.evaluations }]);
    assert.equal(report.productOutcomes.strictWithTiming.rate, 1);
    assert.equal(report.productOutcomes.strictWithoutTiming.rate, 1);
    uiEvent("onChange", "speech-start", h.context)({ target: { value: "" } });
    uiEvent("onClick", 'traceId: null', h.context)();
    const cleared = evaluation.readCriticalMomentEvaluations()[0];
    assert.equal(cleared.firstUsefulAt, undefined);
    assert.equal(cleared.userSpeechStartAt, undefined);
    assert.equal(cleared.userSpeechStartTurnId, undefined);
    assert.equal(cleared.selectedUsefulDisplayTarget, undefined);
    await h.manager.stop();
    const clearedRecorded = JSON.parse(h.writes.get("human-evaluation/critical-moment-evaluations.json")!).evaluations[0];
    assert.equal(clearedRecorded.firstUsefulAt, undefined);
    assert.equal(clearedRecorded.userSpeechStartAt, undefined);
  } finally { await h.manager.stop(); delete globals.window; delete globals.localStorage; }
});

test("unconfirmed, wrong-session, later-task, missing capture time and stale display cannot create timing truth", async () => {
  const h = await harness();
  try {
    assert.equal(h.env.readTiming().answers.length, 0);
    h.env.recordAdviseDisplayApplied({ ...h.target, logicalQuestionRevision: 9 }, "normal-mode");
    assert.equal(h.env.readTiming().answers.length, 0);
    h.env.onConfirmTiming({ kind: "first-useful", traceId: "answer" });
    assert.equal(h.env.criticalMomentEvaluationsRef.current.length, 0);
    const withoutTime = (await h.transcribe({ audio: {}, speaker: "me", source: "microphone" })).turn;
    assert.equal(withoutTime.speechStartedAt, undefined);
    h.runtime.transcriptTurns.push(withoutTime);
    assert.equal(h.env.readTiming().speech.length, 1);
    h.env.criticalMomentCandidatesRef.current.push({ ...h.candidate, momentId: "next", sourceTurnIds: ["next"], opportunityStartAt: h.base + 350 });
    assert.equal(h.env.readTiming().speech.length, 0);
    h.env.onConfirmTiming({ kind: "speech-start", turnId: h.me.id });
    assert.equal(h.env.criticalMomentEvaluationsRef.current.length, 0);
    h.runtime.sessionId = "other";
    h.env.onConfirmTiming({ kind: "speech-start", turnId: null });
    assert.equal(h.env.criticalMomentEvaluationsRef.current.length, 0);
  } finally { await h.manager.stop(); }
});

test("multiple Me candidates require choice; duplicate/late suggestions preserve human selection and old precision", async () => {
  const h = await harness();
  try {
    h.env.fetchSTT = async () => "Could you clarify the expected cache capacity?";
    const clarification = (await h.transcribe({ audio: {}, speaker: "me", source: "microphone", startedAt: h.base + 210, endedAt: h.base + 240 })).turn;
    h.runtime.transcriptTurns.push(clarification);
    assert.equal(h.env.readTiming().speech.length, 2);
    assert.equal(h.env.criticalMomentEvaluationsRef.current.length, 0);
    h.env.onConfirmTiming({ kind: "speech-start", turnId: h.me.id });
    h.env.onConfirmTiming({ kind: "speech-start", turnId: h.me.id });
    const saved = structuredClone(h.env.criticalMomentEvaluationsRef.current);
    h.env.readTiming(); h.env.readTiming();
    assert.deepEqual(h.env.criticalMomentEvaluationsRef.current, saved);
    assert.equal(saved.length, 1);
    h.env.onConfirmTiming({ kind: "speech-start", turnId: clarification.id });
    assert.equal(h.env.criticalMomentEvaluationsRef.current[0].userSpeechStartAt, h.base + 210);
    // A legacy time without display identity remains readable but cannot become a new ACK candidate.
    Object.assign(h.trace.metadata!, { advisorOutputAppliedToDisplay: true,
      advisorOutputFirstDisplayAppliedAt: h.base + 250, advisorOutputFirstDisplaySurface: "normal-mode" });
    assert.equal(h.env.readTiming().answers.length, 0);
    h.runtime.transcriptTurns.length = 0;
    assert.equal(h.env.readTiming().speech.length, 0);
  } finally { await h.manager.stop(); }
});
