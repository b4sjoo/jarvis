import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as truth from "../src/lib/meeting/human-ground-truth-v2.js";
import {
  buildHumanEvaluationSelectionSnapshot,
  captureHumanGroundTruthEvaluationTarget,
  resolveSettledAttemptEvaluationTarget,
  type HumanEvaluationSelectionSnapshot,
} from "../src/lib/meeting/human-evaluation.js";
import {
  resolveHumanEvaluationAttemptIdentityV2,
  validateHumanEvaluationAttemptSubjectV2,
} from "../src/lib/meeting/human-evaluation-attempt.js";
import { buildHumanEvaluationAttemptEvidenceV2 } from "../src/lib/meeting/human-evaluation-attempt-projection.js";
import type { createHumanEvaluationStore } from "../src/lib/meeting/human-evaluation-store.js";
import { SessionRecordingManager } from "../src/lib/meeting/session-recording.js";
import { toHumanEvaluationCollectionProvenance } from "../src/lib/meeting/session-evaluation-provenance.js";
import type { AdvisorSuggestion, MeetingAssistantSettings, MeetingTrace } from "../src/lib/meeting/types.js";

const hookFile = "src/hooks/useMeetingAssistant.ts";
const uiFile = "src/pages/app/components/meeting/index.tsx";
const storeFile = "src/lib/meeting/human-evaluation-store.ts";
const sources = new Map<string, ts.SourceFile>();

function sourceFile(file: string) {
  if (!sources.has(file)) sources.set(file, ts.createSourceFile(
    file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  ));
  return sources.get(file)!;
}

function evaluate<T>(expression: string, env: Record<string, unknown>): T {
  return vm.runInNewContext(ts.transpileModule(expression, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, env);
}

// Same production callback extraction boundary as human-evaluation-store.test.ts.
function production<T>(file: string, name: string, env: Record<string, unknown>): T {
  const source = sourceFile(file);
  let expression = "";
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      expression = node.getText(source).replace(/^export\s+/, "") + `\n${name};`;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name
      && node.initializer && ts.isCallExpression(node.initializer)) {
      expression = `(${node.initializer.arguments[0]!.getText(source)});`;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(expression, `production callback ${name}`);
  return evaluate(expression, env);
}

type LabelOptions = {
  evaluationTarget?: truth.HumanGroundTruthEvaluationTargetV2;
  actionId?: string;
  uiSurface?: string;
};
type RecordLabel = (traceId: string, fact: truth.HumanGroundTruthFactV2, options?: LabelOptions) => void;
type SubmitLabel = (fact: truth.HumanGroundTruthFactV2, options: LabelOptions) => void;

function productionUiSubmit(env: Record<string, unknown>): SubmitLabel {
  const source = sourceFile(uiFile);
  let expression = "";
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "TraceHumanEvaluationPanel"
      && node.getText(source).includes("key={evaluationTrace.id}")) {
      for (const property of node.attributes.properties) {
        if (ts.isJsxAttribute(property) && property.name.getText(source) === "onRecordGroundTruthV2"
          && property.initializer && ts.isJsxExpression(property.initializer) && property.initializer.expression) {
          expression = `(${property.initializer.expression.getText(source)});`;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(expression, "Normal UI evaluation submit callback");
  return evaluate(expression, env);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

// Bounded identity-only extract from session-2026-09-23T08-51-17-332Z_fnslm0.
// Status/body changes below are synthetic test inputs, not recorded human truth.
const sessionId = "meeting_1790153477305_qr5xy1";
const currentQuestion = {
  sessionId, logicalQuestionUnitId: "logical_question_1790153516102_n06ni9", logicalQuestionRevision: 1,
};
const rawText = "SYNTHETIC PRIVATE PROMPT / TRANSCRIPT / ANSWER";
function fixture() {
  const traces: MeetingTrace[] = [
    ["voice_trace_1790153481312_ycktj7", "logical_question_1790153481331_yk871h", 0,
      "question_settlement_1nzwvtf", "question_source_5uktz7", "turn_1790153481317_gxru6l"],
    ["voice_trace_1790153516086_mckiir", currentQuestion.logicalQuestionUnitId, 1,
      "question_settlement_99cmxc", "question_source_133lir8", "turn_1790153516089_oo08n2"],
  ].map(([id, unitId, taskRuntimeRevision, settlementId, sourceHash, turnId]) => ({
    id: String(id), kind: "voice", status: "error", startedAt: 1,
    steps: [], inputs: [], outputs: [], metadata: {
      effectiveCurrentQuestionSettlementSessionId: sessionId,
      effectiveCurrentQuestionSettlementUnitId: unitId,
      effectiveCurrentQuestionSettlementRevision: taskRuntimeRevision,
      effectiveCurrentQuestionSettlementUnitRevision: 1,
      currentQuestionSettlementRevision: 1,
      logicalQuestionUnitRevision: 1,
      effectiveCurrentQuestionSettlementId: settlementId,
      effectiveCurrentQuestionSettlementSourceHash: sourceHash,
      questionInstanceId: `trace:${id}`, activeMeetingTaskId: "interview_parent_1790153481999_my6wkf",
      logicalQuestionCurrentTurnId: turnId, logicalQuestionSourceTurnIds: [turnId],
      rawPrompt: rawText, rawTranscript: rawText,
    },
  }));
  const [a, b] = traces;
  a.status = "success";
  const visible: AdvisorSuggestion = {
    id: "synthetic-visible-a", sourceTraceId: a.id, kind: "answer", content: rawText,
    createdAt: 1, basedOnTurnIds: [], basedOnObservationIds: [], confidence: "medium",
  };
  return { a, b, visible, traces: [b, a] };
}

const startOptions = {
  meetingSessionId: sessionId,
  settings: {
    codingModel: { enabled: false, provider: "", variables: {} },
    taxonomyAdjudication: { enabled: true, provider: "", variables: {} },
  } as unknown as MeetingAssistantSettings,
  providerSummary: { hasMainProvider: false, hasCodingProvider: false, hasTaxonomyAdjudicationProvider: false,
    hasSttProvider: false, mainSupportsImages: false, codingSupportsImages: false },
};

type Stored = {
  event: truth.HumanGroundTruthEventV2;
  projection: truth.HumanEvaluationProjectionV2;
};

async function harness() {
  const { a, b, visible, traces } = fixture();
  const native: Array<{ command: string; args: Record<string, unknown> }> = [];
  const files = new Map<string, string>();
  // Fake native IO captures actual recorder bytes in memory. No real file/SQLite writes.
  const recorder = new SessionRecordingManager(undefined, async <T>(command: string, args: Record<string, unknown> = {}) => {
    native.push({ command, args });
    if (command === "start_meeting_session_recording") return `/fake-io/${args.folderName}` as T;
    if (command === "write_meeting_session_recording_text") {
      const key = `${args.folderName}/${args.relativePath}`;
      files.set(key, (args.append ? files.get(key) ?? "" : "") + String(args.payload));
    }
    return undefined as T;
  });
  const recording = await recorder.start(startOptions);
  const oldExpected = truth.createHumanGroundTruthEventV2({
    eventId: "synthetic-old-expected-a", sessionId, subject: truth.buildHumanGroundTruthSubjectV2({ trace: a }),
    source: "explicit-ui", sourceTraceId: a.id,
    fact: { kind: "expected-question-type", expectedQuestionType: "coding" }, now: 1,
  });
  const events = new Map([[oldExpected.eventId, structuredClone(oldExpected)]]);
  const projections = new Map<string, truth.HumanEvaluationProjectionV2>();
  const appendCalls: Stored[] = [];
  let entered = deferred<Stored>();
  let release = deferred<boolean>();
  const store = production<typeof createHumanEvaluationStore>(storeFile, "createHumanEvaluationStore", {
    ...truth, structuredClone, IMPORT_SOURCE: "local-storage-human-evaluation-v2-retirement-1",
  })({
    initialize: async () => {},
    readLegacy: () => { throw new Error("Unexpected legacy read in fake IO fixture"); },
    invoke: async <T>(command: string, args: Record<string, unknown>) => {
      if (command === "evaluation_store_import_status") return { imported: true } as T;
      if (command === "evaluation_store_read") return structuredClone({
        events: [...events.values()].filter(event => event.sessionId === args.sessionId),
        projections: [...projections.values()].filter(projection => projection.sessionId === args.sessionId),
      }) as T;
      assert.equal(command, "evaluation_store_append");
      const input = args.input as Stored;
      appendCalls.push(input);
      entered.resolve(input);
      if (!await release.promise) throw new Error("fake IO: append failed");
      events.set(input.event.eventId, structuredClone(input.event));
      projections.set(input.projection.projectionId, structuredClone(input.projection));
      return structuredClone(input) as T;
    },
  });
  const saves = { current: new Map<string, { event: truth.HumanGroundTruthEventV2; run(): Promise<void>; running: boolean; error?: string }>() };
  const liveEvents = { current: [oldExpected] };
  const liveProjections = { current: [] as truth.HumanEvaluationProjectionV2[] };
  const readSession = { current: sessionId };
  const runtime = { sessionId, traces };
  let persistence = { pending: 0, error: null as string | null };
  let idle = deferred<void>();
  const env: Record<string, unknown> = {
    ...truth, structuredClone, resolveHumanEvaluationAttemptIdentityV2,
    validateHumanEvaluationAttemptSubjectV2, buildHumanEvaluationAttemptEvidenceV2,
    toHumanEvaluationCollectionProvenance, humanEvaluationStore: store,
    console: { error() {}, warn() {} }, scriptedValidationRef: { current: false },
    sessionRecordingManagerRef: { current: recorder },
    contextManagerRef: { current: { getState: () => ({ sessionId: runtime.sessionId }) } },
    traceStoreRef: { current: { getTraces: () => runtime.traces, updateMetadata() {} } },
    questionEvaluationsRef: { current: [] }, evaluationReadSessionRef: readSession,
    humanGroundTruthEventsV2Ref: liveEvents, humanEvaluationProjectionsV2Ref: liveProjections,
    evaluationSavesRef: saves, setHumanGroundTruthEventsV2() {}, setHumanEvaluationProjectionsV2() {},
    setEvaluationPersistence: (update: (previous: typeof persistence) => typeof persistence) => {
      persistence = update(persistence);
      if (persistence.pending === 0) idle.resolve();
    },
    loadHumanEvaluationSession: () => { throw new Error("Expected pending retry, not reload"); },
  };
  env.commitHumanGroundTruthV2 = production(hookFile, "commitHumanGroundTruthV2", env);
  const recordLabel = production<RecordLabel>(hookFile, "recordHumanGroundTruthV2", env);
  let captured: truth.HumanGroundTruthEvaluationTargetV2 | undefined;
  const target = resolveSettledAttemptEvaluationTarget({
    suggestion: visible, traces, currentSessionId: sessionId, currentQuestion,
  });
  const submit = productionUiSubmit({
    evaluationTrace: traces.find(trace => trace.id === target.traceId),
    answerQuestionEvaluation: undefined, captureHumanGroundTruthEvaluationTarget,
    meeting: { recordHumanGroundTruthV2: (id: string, fact: truth.HumanGroundTruthFactV2, options: LabelOptions) => {
      captured = options.evaluationTarget;
      return recordLabel(id, fact, options);
    } },
  });
  return {
    a, b, visible, traces, recorder, recording, native, files, runtime, readSession,
    oldExpected, events, store, appendCalls, saves, liveEvents, liveProjections, submit,
    recordSelection: production<(snapshot: HumanEvaluationSelectionSnapshot) => void>(hookFile, "recordHumanEvaluationSelection", env),
    retry: production<() => void>(hookFile, "retryHumanEvaluationSave", env),
    get captured() { assert.ok(captured); return captured; },
    get persistence() { return persistence; },
    get entered() { return entered.promise; },
    async finishSave(success: boolean) { release.resolve(success); await idle.promise; },
    prepareRetry() { entered = deferred<Stored>(); release = deferred<boolean>(); idle = deferred<void>(); },
    async close() {
      release.resolve(false);
      if (persistence.pending) await idle.promise;
      await recorder.stop();
    },
  };
}

function selection(h: Awaited<ReturnType<typeof harness>>) {
  return buildHumanEvaluationSelectionSnapshot({
    target: resolveSettledAttemptEvaluationTarget({
      suggestion: h.visible, traces: h.traces, currentSessionId: sessionId, currentQuestion,
    }),
    currentSessionId: sessionId, currentQuestion, locked: false, trace: h.b,
    displayTarget: { sessionId, logicalQuestionUnitId: String(h.a.metadata!.effectiveCurrentQuestionSettlementUnitId),
      logicalQuestionRevision: 1, traceId: h.a.id, suggestionId: h.visible.id },
  });
}

const quality: truth.HumanGroundTruthFactV2 = {
  kind: "answer-quality", outcome: "wrong", failureReasons: [], expectedContextTurnIds: [],
};

test("BE5 fake native IO: actual Hook selection records compact current B/display A/evaluation B without raw text or truth", { timeout: 5000 }, async (t) => {
  const h = await harness();
  t.after(() => h.close());
  h.recordSelection(selection(h));
  await h.recorder.flushAggregates();
  const timeline = h.files.get(`${h.recording.folderName}/timeline.jsonl`)!.trim().split("\n").map(line => JSON.parse(line));
  const selected = timeline.filter(event => event.kind === "capture-lifecycle"
    && event.metadata.stage === "human-evaluation-target-selected");
  assert.equal(selected.length, 1);
  assert.equal(selected[0].sessionId, h.recording.sessionId);
  const metadata = selected[0].metadata;
  assert.deepEqual(Object.keys(metadata).sort(), ["stage", "surface", "currentSessionId", "currentQuestion", "locked", "displayTarget", "target", "attempt"].sort());
  assert.equal(metadata.surface, "normal-debug-evaluation");
  assert.deepEqual(metadata.currentQuestion, currentQuestion);
  assert.equal(metadata.displayTarget.traceId, h.a.id);
  assert.equal(metadata.locked, false);
  assert.deepEqual(metadata.target, { status: "trace-only", reason: "latest-settled-attempt", traceId: h.b.id });
  assert.deepEqual(metadata.attempt, { attemptId: h.b.id, sessionId,
    logicalQuestionUnitId: currentQuestion.logicalQuestionUnitId, logicalQuestionRevision: 1, status: "error" });
  assert.equal(JSON.stringify(selected[0]).includes(rawText), false);
  assert.equal(h.appendCalls.length, 0, "observation cannot create human truth");
  assert.equal([...h.files.keys()].some(key => key.endsWith("ground-truth-v2.jsonl")), false);
  assert.equal(h.native.some(call => /provider|model|transcri/.test(call.command)), false);
});

test("BE6 fake backend/native IO: UI capture -> actual Hook -> store freezes delayed save and mirrors original B", { timeout: 5000 }, async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const oldBytes = JSON.stringify(h.oldExpected);
  const expected = captureHumanGroundTruthEvaluationTarget({ trace: h.b, frozenAt: 0 });
  const before = Date.now();
  h.submit(quality, { actionId: "synthetic-label-b" });
  const after = Date.now();
  assert.equal(h.persistence.pending, 1);
  const captured = structuredClone(h.captured);
  assert.deepEqual(captured, { ...expected, frozenAt: captured.frozenAt });
  assert.ok(captured.frozenAt >= before && captured.frozenAt <= after);

  // A later render/question cannot rebind either the normalized event or queued store input.
  h.captured.sourceTurnIds.push("later-turn");
  h.captured.attemptId = "later-attempt";
  h.b.metadata!.logicalQuestionSourceTurnIds = ["later-turn"];
  h.runtime.traces = [{ ...h.b, id: "trace-c" }, h.a];
  const input = await h.entered;
  const queued = [...h.saves.current.values()][0].event;
  assert.notEqual(input.event, queued, "production store owns a detached event copy");
  assert.notEqual(input.event.provenance.evaluationTarget, queued.provenance.evaluationTarget);
  assert.deepEqual(JSON.parse(JSON.stringify(input.event.provenance.evaluationTarget)), captured);
  assert.equal(input.event.subject.attemptId, h.b.id);
  assert.deepEqual(input.event.subject.sourceTurnIds, captured.sourceTurnIds);
  assert.equal(input.event.provenance.sourceTraceId, h.b.id);
  assert.equal(input.event.provenance.uiSurface, "normal-debug-evaluation");
  assert.equal(input.projection.observed?.traceId, h.b.id);
  assert.equal(h.events.size, 1, "delayed append is not reported as saved");
  await h.finishSave(true);
  await h.recorder.flushAggregates();

  const mirrored = JSON.parse(h.files.get(`${h.recording.folderName}/human-evaluation/ground-truth-v2.jsonl`)!.trim()) as truth.HumanGroundTruthEventV2;
  assert.deepEqual(mirrored, JSON.parse(JSON.stringify(input.event)));
  assert.deepEqual(mirrored.provenance.evaluationTarget, JSON.parse(JSON.stringify(captured)));
  const mirroredProjection = JSON.parse(h.files.get(`${h.recording.folderName}/human-evaluation/projections-v2.jsonl`)!.trim()) as truth.HumanEvaluationProjectionV2;
  assert.equal(mirroredProjection.subject.attemptId, mirrored.subject.attemptId);
  assert.equal(mirroredProjection.observed?.traceId, h.b.id);
  assert.ok(mirroredProjection.inputEventIds.includes(mirrored.eventId));
  const reread = await h.store.readSession(sessionId);
  assert.deepEqual(reread.events.find(event => event.eventId === mirrored.eventId), input.event);
  assert.equal(JSON.stringify(reread.events.find(event => event.eventId === h.oldExpected.eventId)), oldBytes);
  assert.equal(h.liveEvents.current.at(-1)?.subject.attemptId, h.b.id);
  assert.equal(h.persistence.pending, 0);
  assert.equal(h.persistence.error, null);
});

test("BE6 fake backend/native IO: failed UI save retries frozen B after session switch without mirroring into the new recorder", { timeout: 5000 }, async (t) => {
  const h = await harness();
  t.after(() => h.close());
  h.submit(quality, { actionId: "synthetic-retry-b" });
  const first = await h.entered;
  const frozenBytes = JSON.stringify(first.event);
  await h.finishSave(false);
  assert.match(h.persistence.error ?? "", /fake IO: append failed/);
  assert.equal(h.events.size, 1);
  assert.equal(h.saves.current.size, 1);
  await h.recorder.stop();
  h.runtime.sessionId = "new-runtime-session";
  h.runtime.traces = [];
  h.readSession.current = h.runtime.sessionId;
  h.liveEvents.current = [];
  const nextRecording = await h.recorder.start({ ...startOptions, meetingSessionId: h.runtime.sessionId });
  const nativeBeforeRetry = h.native.length;
  h.prepareRetry();
  h.retry();
  const retried = await h.entered;
  assert.equal(JSON.stringify(retried.event), frozenBytes);
  assert.equal(retried.event.sessionId, sessionId);
  assert.equal(retried.event.subject.attemptId, h.b.id);
  await h.finishSave(true);
  await h.recorder.flushAggregates();
  assert.equal(h.persistence.pending, 0);
  assert.equal(h.persistence.error, null);
  assert.equal(h.saves.current.size, 0);
  assert.equal(h.liveEvents.current.length, 0, "old truth does not enter new session's read model");
  assert.equal(h.liveProjections.current.length, 0);
  assert.equal(h.files.has(`${h.recording.folderName}/human-evaluation/ground-truth-v2.jsonl`), false);
  assert.equal(h.files.has(`${nextRecording.folderName}/human-evaluation/ground-truth-v2.jsonl`), false);
  assert.equal(h.native.slice(nativeBeforeRetry).some(call =>
    String(call.args.relativePath).endsWith("ground-truth-v2.jsonl")
    || String(call.args.relativePath).endsWith("projections-v2.jsonl")), false);
  assert.equal(JSON.stringify((await h.store.readSession(sessionId)).events.find(event => event.eventId === first.event.eventId)), frozenBytes);
  assert.equal((await h.store.readSession(h.runtime.sessionId)).events.length, 0);
});
