import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as metadata from "../src/lib/meeting/meeting-metadata-inference.js";
import * as repair from "../src/lib/meeting/whiteboard-syntax-repair.js";
import * as inference from "../src/lib/meeting/runtime-inference.js";
import { hashTaxonomySourceTurnIds } from "../src/lib/meeting/taxonomy-adjudication.js";

const source = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
const ast = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);
function callback(name: string, env: object) {
  let node: ts.VariableDeclaration | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.name.getText(ast) === name) node ??= n;
    if (!node) ts.forEachChild(n, visit);
  };
  visit(ast); assert.ok(node);
  const fn = (node.initializer as ts.CallExpression).arguments[0].getText(ast);
  return vm.runInNewContext(ts.transpileModule(`(${fn})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, env);
}

function harness(debug: boolean, recording: boolean, knownCompany = true, mode = "shadow") {
  const turn = { id: "opening", speaker: "them", text: "Welcome to Oracle. I am the interviewer for the backend engineering role.",
    source: "system-audio", isFinal: true, startedAt: 100, endedAt: 200 };
  const context = { sessionId: "s", startedAt: 100, transcriptTurns: [turn],
    interviewSessionContext: { targetCompany: knownCompany ? { value: "Oracle", source: "manual" } : undefined } };
  const jobs: any[] = [], calls: any[] = [], writes: any[] = [];
  const observations: Record<string, unknown> = {};
  const runtime = { getCurrentOperationId: () => undefined, schedule: (scheduled: any) => {
    jobs.push(scheduled.job);
    scheduled.onStarted?.(scheduled.job, 300, { startsBefore: 0, startsAfter: 1, remaining: 1 });
    scheduled.execute(scheduled.job, new AbortController().signal);
  } };
  const env = { ...metadata, ...repair, ...inference, hashTaxonomySourceTurnIds,
    shutdownRequestedRef: { current: false }, debugModeRef: { current: debug },
    contextManagerRef: { current: { getState: () => context } }, runtimeEpochRef: { current: 1 },
    taxonomyAdjudicationSettingsRef: { current: { meetingMetadataMode: mode } },
    meetingModelProviderSnapshotRef: { current: {} },
    meetingMetadataInferenceCircuitRef: { current: { read: () => ({ open: false }) } },
    whiteboardSyntaxRepairCircuitRef: { current: { read: () => ({ open: false }) } },
    whiteboardSyntaxRepairAttemptKeysRef: { current: new Set() },
    meetingMetadataInferenceRuntimeRef: { current: runtime }, whiteboardSyntaxRepairRuntimeRef: { current: runtime },
    traceStoreRef: { current: { updateMetadata: (_id: string, value: object) => Object.assign(observations, value),
      recordInput() {}, startStep: () => "step" } },
    sessionRecordingManagerRef: { current: { getState: () => ({ active: recording }), recordModelInput: (value: unknown) => writes.push(value) } },
    resolveRuntimeInferenceModelRouteFromSnapshot: () => ({ provider: { id: "provider" }, selectedProvider: { provider: "provider", variables: { model: "fixture" } } }),
    formatRuntimeInferenceModelRouteForTrace: () => ({}), readSelectedProviderModelId: () => "fixture",
    requestMeetingMetadataInference: (args: unknown) => calls.push(args), requestWhiteboardSyntaxRepair: (args: unknown) => calls.push(args),
  };
  return { env, turn, jobs, calls, observations, writes };
}

for (const debug of [false, true]) for (const recording of [false, true]) {
  test(`D178 known-company observation debug=${debug} recording=${recording}`, () => {
    const h = harness(debug, recording);
    callback("scheduleMeetingMetadataInference", h.env)({ turn: h.turn, traceId: "trace" });
    assert.equal(h.calls.length, debug ? 1 : 0);
    assert.equal(h.jobs.length, h.calls.length);
    if (debug) {
      assert.equal(h.observations.meetingMetadataInferenceObservationTrigger, "legacy-debug-preview-trigger");
      assert.ok(h.observations.meetingMetadataInferenceOperationId);
      assert.equal(h.observations.meetingMetadataInferenceBudgetStartsAfter, 1);
    }
  });
  test(`D178 invalid Whiteboard observation debug=${debug} recording=${recording}`, () => {
    const h = harness(debug, recording);
    const validation = { valid: false, candidateKind: "mermaid", operationId: "validation", candidateFingerprint: "fp", parserErrorClass: "parse-error" };
    const parent = { id: "p", revisions: 1, whiteboardArtifact: { id: "wb", renderState: {
      validationOperationId: "validation", candidateFingerprint: "fp", candidateRevision: 2, visibleRevision: 1 } } };
    callback("scheduleWhiteboardSyntaxRepairShadow", h.env)({ traceId: "trace", source: "voice", parent, validation,
      candidateWhiteboard: "```mermaid\nflowchart TD\nA --> B\nend\n```" });
    assert.equal(h.calls.length, debug ? 1 : 0);
    if (debug) {
      assert.equal(h.observations.whiteboardRepairObservationTrigger, "legacy-debug-preview-trigger");
      assert.equal(h.jobs[0].operationKind, "whiteboard-syntax-repair");
      assert.ok(h.jobs[0].lease);
    }
  });
}

test("Metadata off stays off and unresolved-company product inference is independent of Recording/Debug", () => {
  let frozen: string | undefined;
  for (const debug of [false, true]) for (const recording of [false, true]) {
    const off = harness(debug, recording, true, "off");
    callback("scheduleMeetingMetadataInference", off.env)({ turn: off.turn, traceId: "trace" });
    assert.equal(off.calls.length, 0);
    const product = harness(debug, recording, false, "enforcement");
    callback("scheduleMeetingMetadataInference", product.env)({ turn: product.turn, traceId: "trace" });
    assert.equal(product.calls.length, 1);
    assert.equal(product.observations.meetingMetadataInferenceObservationTrigger, undefined);
    const request = JSON.stringify(product.calls[0]);
    frozen ??= request;
    assert.equal(request, frozen);
  }
});
