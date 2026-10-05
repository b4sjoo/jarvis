import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as truth from "../src/lib/meeting/human-ground-truth-v2.js";
import { validateHumanEvaluationAttemptSubjectV2 } from "../src/lib/meeting/human-evaluation-attempt.js";
import { STORAGE_KEYS } from "../src/config/constants.js";
import { fromHumanEvalQuestionType } from "../src/lib/meeting/task-taxonomy.js";
import { upsertQuestionHumanEvaluation } from "../src/lib/meeting/human-evaluation.js";
import { SessionRecordingManager } from "../src/lib/meeting/session-recording.js";
import type { MeetingAssistantSettings } from "../src/lib/meeting/types.js";
import { assertEntryInLedger, assertPlantedOnlyInCause, createDiagnosticLogSpy, DIAGNOSTIC_LOG_SPY_FAILING_DELIVERIES, DIAGNOSTIC_LOG_SPY_LEVELS,
  PLANTED, type DiagnosticLogSpyDelivery } from "./helpers/diagnostic-log-spy.js";

function production(file: string, name: string, env: Record<string, unknown>) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  let expression = "";
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(source).replace(/^export\s+/, "") + `\n${name};`;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && ts.isCallExpression(node.initializer)) expression = `(${node.initializer.arguments[0]!.getText(source)});`;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(expression, name);
  return vm.runInNewContext(ts.transpileModule(expression, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, env);
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a,b) => { resolve=a; reject=b; });
  return { promise, resolve, reject };
}
const turn = { attemptId: "trace-a", questionId: "question-a", traceIds: ["trace-a"], sourceTurnIds: ["turn-a"] };
const event = () => truth.createHumanGroundTruthEventV2({ eventId: "event-a", sessionId: "session-a", subject: turn,
  fact: { kind: "answer-quality", outcome: "useful", failureReasons: [], expectedContextTurnIds: [] }, source: "explicit-ui", now: 1 });
const storeFile = "src/lib/meeting/human-evaluation-store.ts";
function storeEnvironment() {
  const env = { ...truth, STORAGE_KEYS, fromHumanEvalQuestionType, structuredClone, JSON, Error, IMPORT_SOURCE: "local-storage-human-evaluation-v2-retirement-1" } as Record<string, unknown>;
  env.buildHumanEvaluationImport = production(storeFile, "buildHumanEvaluationImport", env);
  return env;
}

test("E167 import keeps original V2 bytes and observed evidence; V1 boolean cannot invent primary ask truth", () => {
  const original = event();
  const projection = truth.deriveHumanEvaluationProjectionV2({ sessionId: original.sessionId, subject: turn, events: [original], observed: { traceId: "trace-a", traceHash: "frozen", primaryAsk: "original question" } });
  const legacy = upsertQuestionHumanEvaluation([], { sessionId: "legacy-session", questionId: "legacy-question", traceId: "legacy-trace", traceKind: "voice" }, { primaryAskCorrect: true, correctedQuestionType: "coding" });
  const bytes = new Map<string, string>([[STORAGE_KEYS.MEETING_HUMAN_GROUND_TRUTH_EVENTS_V2, JSON.stringify([original])],
    [STORAGE_KEYS.MEETING_HUMAN_EVALUATION_PROJECTIONS_V2, JSON.stringify([projection])],
    [STORAGE_KEYS.MEETING_QUESTION_HUMAN_EVALUATIONS, JSON.stringify(legacy)]]);
  const input = (storeEnvironment().buildHumanEvaluationImport as Function)((key: string) => bytes.get(key));
  assert.equal(JSON.stringify(input.events[0]), JSON.stringify(original));
  assert.equal(JSON.stringify(input.projections[0]), JSON.stringify(projection));
  assert.equal(input.events.some((e: truth.HumanGroundTruthEventV2) => e.fact.kind === "primary-ask-correction"), false);
  assert.equal(input.events.some((e: truth.HumanGroundTruthEventV2) => e.fact.kind === "expected-question-type"), true);
  assert.equal(bytes.size, 3);
});

test("E167 production store serializes writes, retries import, freezes input and never writes localStorage", async () => {
  const env = storeEnvironment();
  const calls: Array<{ command: string; args: any }> = [];
  const persisted: truth.HumanGroundTruthEventV2[] = [];
  let failImport = true;
  const blocked = deferred();
  const store = production(storeFile, "createHumanEvaluationStore", env)({
    initialize: async () => {}, readLegacy: () => null,
    invoke: async (command: string, args: any) => {
      calls.push({ command, args });
      if (command === "evaluation_store_import_status") return null;
      if (command === "evaluation_store_import" && failImport) throw new Error("disk unavailable");
      if (command === "evaluation_store_read") return { events: [...persisted], projections: [] };
      if (command === "evaluation_store_append") { await blocked.promise; persisted.push(args.input.event); return args.input; }
      if (command === "evaluation_store_project") return args.projection;
      return {};
    },
  });
  await assert.rejects(store.initialize(), /disk unavailable/);
  failImport = false;
  const frozen = event();
  const write = store.commit(frozen, { traceId: "trace-a", traceHash: "before" });
  frozen.subject.questionId = "changed-after-click";
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(persisted.length, 0);
  const readModel = truth.deriveHumanEvaluationProjectionV2({ sessionId: "session-a", subject: turn, events: [] });
  const project = store.saveObservation(readModel);
  blocked.resolve();
  const result = await write;
  await project;
  assert.equal(result.event.subject.questionId, "question-a");
  assert.equal(result.projection.observed.traceHash, "before");
  const projected = calls.find(c => c.command === "evaluation_store_project")!.args.projection;
  assert.deepEqual(Array.from(projected.inputEventIds), ["event-a"]);
  assert.equal(calls.filter(c => c.command === "evaluation_store_import").length, 2);
});

// Task 178 LG, commit 3: the commit callback logs its two outcomes through `logDiagnostic`. Each scenario is run with
// the real logger, its delivery boundary controlled (see the helper), at the level and delivery the caller asks for.
// Controlled: the store's commit, which waits for `control.pending` and then fails or answers as `control.fail` says,
// with a disk error that names a file, and the native writes of the real recorder, which are listed.
const STORE_FAILURE = `fixture disk failure at ${PLANTED.filePath}`;
function commitHarness(level: (typeof DIAGNOSTIC_LOG_SPY_LEVELS)[number], delivery?: DiagnosticLogSpyDelivery) {
  const diagnosticLog = createDiagnosticLogSpy({ threshold: level, delivery });
  const native: Array<{ command: string; args: any }> = [];
  const recorder = new SessionRecordingManager(undefined, async <T>(command: string, args: Record<string, unknown> = {}) => {
    native.push({command,args});
    return (command === "start_meeting_session_recording" ? `/tmp/fixture-evaluation/${args.folderName}` : undefined) as T;
  });
  const options = { meetingSessionId: "session-a", settings: { codingModel: { enabled: false, provider: "", variables: {} }, taxonomyAdjudication: { enabled: true, provider: "", variables: {} } } as unknown as MeetingAssistantSettings,
    providerSummary: { hasMainProvider: false, hasCodingProvider: false, hasTaxonomyAdjudicationProvider: false, hasSttProvider: false, mainSupportsImages: false, codingSupportsImages: false } };
  const control = { sessionId: "session-a", fail: true, pending: deferred() };
  const writes: truth.HumanGroundTruthEventV2[] = [];
  const panel: { persistence: any } = { persistence: { pending: 0, error: null } };
  const env: Record<string, any> = { ...truth, validateHumanEvaluationAttemptSubjectV2, structuredClone,
    console: { error() {}, warn() {} }, logDiagnostic: diagnosticLog.logDiagnostic, diagnosticLogCause: diagnosticLog.logger.diagnosticLogCause,
    toHumanEvaluationCollectionProvenance: () => "organic",
    scriptedValidationRef: { current: false }, sessionRecordingManagerRef: { current: recorder },
    contextManagerRef: { current: { getState: () => ({ sessionId: control.sessionId }) } },
    evaluationReadSessionRef: { current: "session-a" },
    traceStoreRef: { current: { updateMetadata() {} } },
    humanGroundTruthEventsV2Ref: { current: [] }, humanEvaluationProjectionsV2Ref: { current: [] },
    evaluationSavesRef: { current: new Map() },
    setHumanGroundTruthEventsV2() {}, setHumanEvaluationProjectionsV2() {},
    setEvaluationPersistence: (update: Function) => { panel.persistence=update(panel.persistence); },
    humanEvaluationStore: { commit: async (e: truth.HumanGroundTruthEventV2, observed: truth.HumanEvaluationObservedSnapshotV2) => {
      writes.push(e); await control.pending.promise;
      if (control.fail) throw new Error(STORE_FAILURE);
      return { event: e, projection: truth.deriveHumanEvaluationProjectionV2({ sessionId: e.sessionId, subject: e.subject, events: [e], observed }) };
    } },
  };
  const commit = production("src/hooks/useMeetingAssistant.ts", "commitHumanGroundTruthV2", env);
  const commitOnce = () => commit({ sessionId: control.sessionId, subject: turn, fact: event().fact, sourceTraceId: "trace-a", observed: { traceId: "trace-a", traceHash: "click" } });
  // The recorder's native writes by file.
  const recorded = () => native.map(c => [c.command, String(c.args.relativePath ?? "").replace(/\d{6,}/g, "<n>")]);
  return { diagnosticLog, native, recorder, options, control, writes, panel, env, commitOnce, recorded };
}

// The first commit fails while its recording is active. The retry succeeds after that recording has stopped and
// another has started.
async function hookCommitThenRetryAfterStop(level: (typeof DIAGNOSTIC_LOG_SPY_LEVELS)[number] = "trace", delivery?: DiagnosticLogSpyDelivery) {
  const { diagnosticLog, native, recorder, options, control, writes, panel, env, commitOnce, recorded } = commitHarness(level, delivery);
  await recorder.start(options);
  const result = commitOnce();
  assert.equal(result, undefined, "manual runtime never waits for evaluation storage");
  assert.equal(env.humanGroundTruthEventsV2Ref.current.length, 0);
  control.pending.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(panel.persistence.error, /not saved/);
  await recorder.stop();
  control.sessionId = "session-b";
  env.evaluationReadSessionRef.current = control.sessionId;
  await recorder.start({ ...options, meetingSessionId: control.sessionId });
  const nativeBeforeRetry = native.length;
  control.pending = deferred(); control.fail = false;
  const retry = Array.from(env.evaluationSavesRef.current.values())[0] as {run():Promise<void>};
  const retried = retry.run(); control.pending.resolve(); await retried;
  assert.equal(writes[0], writes[1], "same event object/id/subject retries");
  assert.equal(writes[1]!.sessionId, "session-a");
  assert.equal(env.humanGroundTruthEventsV2Ref.current.length, 0);
  assert.equal(native.slice(nativeBeforeRetry).some(c => String(c.args.relativePath).includes("ground-truth")), false);
  assert.equal(panel.persistence.pending, 0);
  await recorder.stop();
  return { entries: diagnosticLog.entries(), eventId: writes[0]!.eventId, persistence: panel.persistence,
    // What the commit did beside logging: the store writes, the recorder's native writes by file, and the panel state.
    observed: { writes: writes.length, sameEvent: writes[0] === writes[1], recorded: recorded(), pending: panel.persistence.pending,
      events: env.humanGroundTruthEventsV2Ref.current.length } };
}

// One commit in a recording state that does not change while it is saved: no recording at all, which is the ordinary
// state, or one recording that is still active when the save settles.
async function hookCommitOnce(recording: "none" | "active", fail: boolean, level: (typeof DIAGNOSTIC_LOG_SPY_LEVELS)[number] = "trace",
  delivery?: DiagnosticLogSpyDelivery) {
  const { diagnosticLog, recorder, options, control, writes, panel, env, commitOnce, recorded } = commitHarness(level, delivery);
  if (recording === "active") await recorder.start(options);
  control.fail = fail;
  assert.equal(commitOnce(), undefined);
  control.pending.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  if (recording === "active") await recorder.stop();
  return { entries: diagnosticLog.entries(), eventId: writes[0]!.eventId, persistence: panel.persistence,
    observed: { writes: writes.length, recorded: recorded(), pending: panel.persistence.pending, error: panel.persistence.error,
      events: env.humanGroundTruthEventsV2Ref.current.length, retryKept: env.evaluationSavesRef.current.size } };
}

test("E167 actual Hook commit freezes retry target; Stop/new recorder cannot receive an old label", async () => {
  await hookCommitThenRetryAfterStop();
});

// Task 178 LG, commit 3 (LG7, LG1, LG4, LG2, LG5): the two migrated call sites of the evaluation commit, through the
// real callback. The first commit fails: the evaluation is not saved, error, with the store's error as its cause
// (decisions A8). The retry succeeds after the recording it was made in has stopped and another has started: the
// evaluation is saved and its mirror is skipped, warn.
test("LG7 evaluation commit: a save that fails is one error entry with its cause and a mirror that is skipped one warn entry, with identifiers alone; the store, the recorder and the panel state are as before at every level and with a failing log delivery", async () => {
  const reference = await hookCommitThenRetryAfterStop("trace");
  const shown = (run: { entries: typeof reference.entries }) => run.entries.map(entry => [entry.level, `${entry.source} ${entry.event}`, Object.keys(entry.refs ?? {}).sort(), Object.keys(entry.data ?? {})]);
  assert.deepEqual(shown(reference), [
    ["error", "meeting.evaluation persistence-failed", ["runtimeSessionId"], ["eventId", "cause"]],
    ["warn", "meeting.evaluation recording-closed-before-mirror", ["recordingSessionId", "runtimeSessionId"], ["eventId"]],
  ]);
  for (const entry of reference.entries) {
    assertEntryInLedger(entry);
    assert.equal(entry.data!.eventId, reference.eventId, "the identifier of the evaluation event");
    assert.equal(entry.refs!.runtimeSessionId, "session-a", "the runtime session the evaluation was made in");
  }
  assert.match(reference.entries[1]!.refs!.recordingSessionId!, /^session_recording_/);
  // LG4 and A8: the failure text went to the panel state, as before; the entry has its bounded summary as the cause,
  // and the path it names is in no other part of any entry.
  assert.equal(reference.entries[0]!.data!.cause, `Error: ${STORE_FAILURE}`);
  assertPlantedOnlyInCause(reference.entries, "evaluation commit");
  assert.equal(JSON.stringify(reference.entries[1]).includes("fixture disk failure"), false);
  for (const level of DIAGNOSTIC_LOG_SPY_LEVELS) {
    const current = await hookCommitThenRetryAfterStop(level);
    assert.deepEqual(current.observed, reference.observed, `${level}: the commit did the same`);
    assert.deepEqual(shown(current), shown(reference).filter(([entryLevel]) => entryLevel === "error" || level !== "error"), `${level}: the entries that pass`);
  }
  for (const delivery of DIAGNOSTIC_LOG_SPY_FAILING_DELIVERIES) {
    const current = await hookCommitThenRetryAfterStop("trace", delivery);
    assert.deepEqual(current.observed, reference.observed, `${delivery}: the commit did the same`);
    assert.deepEqual(shown(current), shown(reference), `${delivery}: the same entries were handed over`);
  }

  // The same callback in the two recording states that harness never reaches. Neither logging condition depends on
  // more than it says: the error entry on the save alone, the warn entry on a recording that was active and is not
  // the active one any more.
  // No recording is active, the ordinary state, and the save fails: the one error entry, and nothing about a mirror.
  const failedWithoutRecording = await hookCommitOnce("none", true);
  assert.deepEqual(failedWithoutRecording.entries.map(entry => [entry.level, `${entry.source} ${entry.event}`, entry.refs, entry.data]),
    [["error", "meeting.evaluation persistence-failed", { runtimeSessionId: "session-a" },
      { eventId: failedWithoutRecording.eventId, cause: `Error: ${STORE_FAILURE}` }]]);
  for (const entry of failedWithoutRecording.entries) assertEntryInLedger(entry);
  assert.match(failedWithoutRecording.observed.error, /^Evaluation not saved: Error: fixture disk failure/);
  assert.deepEqual([failedWithoutRecording.observed.events, failedWithoutRecording.observed.retryKept, failedWithoutRecording.observed.recorded], [0, 1, []]);
  // No recording is active and the save succeeds: no entry. The mirror was never due, so none is reported as skipped.
  const savedWithoutRecording = await hookCommitOnce("none", false);
  assert.deepEqual(savedWithoutRecording.entries, []);
  assert.deepEqual([savedWithoutRecording.observed.error, savedWithoutRecording.observed.events, savedWithoutRecording.observed.retryKept,
    savedWithoutRecording.observed.recorded], [null, 1, 0, []]);
  // The recording the evaluation was made in is still the active one when the save settles: no entry, and the mirror
  // is written to that recording.
  const savedInSameRecording = await hookCommitOnce("active", false);
  assert.deepEqual(savedInSameRecording.entries, []);
  assert.deepEqual([savedInSameRecording.observed.error, savedInSameRecording.observed.events, savedInSameRecording.observed.retryKept], [null, 1, 0]);
  assert.ok(savedInSameRecording.observed.recorded.some(([, file]) => String(file).includes("ground-truth")), "the evaluation was mirrored");
  // The three do the same at every level and hand over the same entries with a failing delivery.
  for (const [name, recording, fail, expected] of [["failed, no recording", "none", true, failedWithoutRecording],
    ["saved, no recording", "none", false, savedWithoutRecording], ["saved, same recording", "active", false, savedInSameRecording]] as const) {
    for (const level of DIAGNOSTIC_LOG_SPY_LEVELS) {
      const current = await hookCommitOnce(recording, fail, level);
      assert.deepEqual(current.observed, expected.observed, `${name} at ${level}: the commit did the same`);
      assert.deepEqual(shown(current), shown(expected), `${name} at ${level}: an error entry passes every level`);
    }
    for (const delivery of DIAGNOSTIC_LOG_SPY_FAILING_DELIVERIES) {
      const current = await hookCommitOnce(recording, fail, "trace", delivery);
      assert.deepEqual(current.observed, expected.observed, `${name}, ${delivery}: the commit did the same`);
      assert.deepEqual(shown(current), shown(expected), `${name}, ${delivery}: the same entries were handed over`);
    }
  }
});
