import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { MeetingTraceStore } from "../.tmp-tests/src/lib/meeting/trace.js";
import { SessionRecordingManager } from "../.tmp-tests/src/lib/meeting/session-recording.js";
import * as sufficiency from "../.tmp-tests/src/lib/meeting/answer-sufficiency.js";
import * as semantic from "../.tmp-tests/src/lib/meeting/semantic-taxonomy-runtime.js";

const source = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
let callback;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "scheduleAnswerSufficiencySemanticShadow") callback = node.initializer.arguments[0];
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(callback);
const compiled = ts.transpileModule(`(${callback.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const settle = () => new Promise(resolve => setImmediate(resolve));
const options = { meetingSessionId: "session", settings: {
  codingModel: { enabled: false, provider: "", variables: {} },
  taxonomyAdjudication: { enabled: true, provider: "", variables: {} },
}, providerSummary: {} };

for (const mode of ["late-timeout", "late-error", "late-stale", "early", "off", "sealed", "new-session", "unrecorded"]) {
  test(`late Sufficiency full trace refresh: ${mode}`, async () => {
    const writes = [];
    const manager = new SessionRecordingManager(undefined, async (command, args) => {
      writes.push({ command, ...args });
      return `/recordings/${args.folderName}`;
    });
    if (mode !== "off") await manager.start(options);
    const store = new MeetingTraceStore();
    const trace = store.startTrace("voice", {});
    let resolve, reject;
    const embedded = new Promise((res, rej) => { resolve = res; reject = rej; });
    let refreshCount = 0;
    const refresh = manager.refreshRecordedTrace.bind(manager);
    manager.refreshRecordedTrace = (...args) => { refreshCount++; return refresh(...args); };
    const run = vm.runInNewContext(compiled, {
      ...sufficiency, ...semantic, Date,
      contextManagerRef: { current: { getState: () => ({ sessionId: "session" }) } },
      runtimeEpochRef: { current: 1 }, semanticEmbeddingRevisionRef: { current: 0 },
      semanticTaxonomyRuntimeRef: { current: { pinSession() {}, embed: () => embedded } },
      answerRevisionByQuestionRef: { current: new Map([["question", 1]]) },
      traceStoreRef: { current: store }, sessionRecordingManagerRef: { current: manager },
      recordSemanticEmbeddingRuntimeEvent() {}, getAutoExportTrigger: () => "auto-slow",
    });
    run({ traceId: trace.id, questionText: "Explain a cache", parsedAnswer: { sections: { answer: "A cache stores values." } },
      decision: { operationId: "op", questionId: "question", logicalQuestionUnitId: "lqu", logicalQuestionUnitRevision: 1, answerRevision: 1, answerStatus: "sufficient" } });
    if (mode !== "early") store.finishTrace(trace.id, "success");
    if (!["off", "early", "unrecorded"].includes(mode)) manager.recordTrace(store.getTrace(trace.id), "manual");
    await settle();
    const traceWrites = () => writes.filter(write => write.relativePath === `traces/${trace.id}.json`);
    const before = traceWrites().length;
    if (["sealed", "new-session"].includes(mode)) await manager.stop();
    if (mode === "new-session") await manager.start({ ...options, meetingSessionId: "other" });
    if (mode === "late-error") reject(new Error("embedding failed"));
    else resolve({ status: mode === "late-stale" ? "stale" : "timeout", durationMs: 353, reason: "deadline", telemetry: undefined });
    await settle();
    await settle();
    const lateWritable = ["late-timeout", "late-error", "late-stale"].includes(mode);
    assert.equal(traceWrites().length - before, lateWritable ? 1 : 0);
    assert.equal(refreshCount, mode === "early" ? 0 : 1);
    assert.equal(store.getTrace(trace.id).steps[0].status === "running", false);
    assert.equal(store.getTrace(trace.id).status, mode === "early" ? "running" : "success");
    if (lateWritable) {
      const saved = JSON.parse(traceWrites().at(-1).payload).trace;
      assert.equal(saved.steps[0].status, mode === "late-error" ? "error" : mode === "late-stale" ? "cancelled" : "success");
      assert.equal(saved.status, "success");
      assert.equal(writes.filter(write => write.relativePath === "answer-sufficiency/decisions.jsonl").length, 1);
    }
    if (mode === "early") {
      store.finishTrace(trace.id, "success");
      manager.recordTrace(store.getTrace(trace.id), "manual");
      await settle();
      assert.equal(JSON.parse(traceWrites().at(-1).payload).trace.steps[0].status, "success");
    }
    if (manager.getState().active) await manager.stop();
  });
}
