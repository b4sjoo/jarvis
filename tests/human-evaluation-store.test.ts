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

test("E167 actual Hook commit freezes retry target; Stop/new recorder cannot receive an old label", async () => {
  const native: Array<{ command: string; args: any }> = [];
  const recorder = new SessionRecordingManager(undefined, async <T>(command: string, args: Record<string, unknown> = {}) => {
    native.push({command,args});
    return (command === "start_meeting_session_recording" ? `/tmp/fixture-evaluation/${args.folderName}` : undefined) as T;
  });
  const options = { meetingSessionId: "session-a", settings: { codingModel: { enabled: false, provider: "", variables: {} }, taxonomyAdjudication: { enabled: true, provider: "", variables: {} } } as unknown as MeetingAssistantSettings,
    providerSummary: { hasMainProvider: false, hasCodingProvider: false, hasTaxonomyAdjudicationProvider: false, hasSttProvider: false, mainSupportsImages: false, codingSupportsImages: false } };
  await recorder.start(options);
  let sessionId = "session-a";
  let fail = true;
  let pending = deferred();
  const writes: truth.HumanGroundTruthEventV2[] = [];
  let persistence: any = { pending: 0, error: null };
  const env: Record<string, any> = { ...truth, validateHumanEvaluationAttemptSubjectV2, structuredClone,
    console: { error() {}, warn() {} },
    toHumanEvaluationCollectionProvenance: () => "organic",
    scriptedValidationRef: { current: false }, sessionRecordingManagerRef: { current: recorder },
    contextManagerRef: { current: { getState: () => ({ sessionId }) } },
    evaluationReadSessionRef: { current: "session-a" },
    traceStoreRef: { current: { updateMetadata() {} } },
    humanGroundTruthEventsV2Ref: { current: [] }, humanEvaluationProjectionsV2Ref: { current: [] },
    evaluationSavesRef: { current: new Map() },
    setHumanGroundTruthEventsV2() {}, setHumanEvaluationProjectionsV2() {},
    setEvaluationPersistence: (update: Function) => { persistence=update(persistence); },
    humanEvaluationStore: { commit: async (e: truth.HumanGroundTruthEventV2, observed: truth.HumanEvaluationObservedSnapshotV2) => {
      writes.push(e); await pending.promise;
      if (fail) throw new Error("fixture disk failure");
      return { event: e, projection: truth.deriveHumanEvaluationProjectionV2({ sessionId: e.sessionId, subject: e.subject, events: [e], observed }) };
    } },
  };
  const commit = production("src/hooks/useMeetingAssistant.ts", "commitHumanGroundTruthV2", env);
  const result = commit({ sessionId, subject: turn, fact: event().fact, sourceTraceId: "trace-a", observed: { traceId: "trace-a", traceHash: "click" } });
  assert.equal(result, undefined, "manual runtime never waits for evaluation storage");
  assert.equal(env.humanGroundTruthEventsV2Ref.current.length, 0);
  pending.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(persistence.error, /not saved/);
  await recorder.stop();
  sessionId = "session-b";
  env.evaluationReadSessionRef.current = sessionId;
  await recorder.start({ ...options, meetingSessionId: sessionId });
  const nativeBeforeRetry = native.length;
  pending = deferred(); fail = false;
  const retry = Array.from(env.evaluationSavesRef.current.values())[0] as {run():Promise<void>};
  const retried = retry.run(); pending.resolve(); await retried;
  assert.equal(writes[0], writes[1], "same event object/id/subject retries");
  assert.equal(writes[1]!.sessionId, "session-a");
  assert.equal(env.humanGroundTruthEventsV2Ref.current.length, 0);
  assert.equal(native.slice(nativeBeforeRetry).some(c => String(c.args.relativePath).includes("ground-truth")), false);
  assert.equal(persistence.pending, 0);
  await recorder.stop();
});
