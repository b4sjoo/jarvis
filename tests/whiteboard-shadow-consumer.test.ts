import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as repair from "../src/lib/meeting/whiteboard-syntax-repair.js";
import * as artifact from "../src/lib/meeting/whiteboard-artifact.js";
import * as inference from "../src/lib/meeting/runtime-inference.js";
import * as health from "../src/lib/meeting/runtime-inference-health.js";
import * as response from "../src/lib/meeting/runtime-inference-response.js";
import * as admission from "../src/lib/meeting/runtime-inference-provider-admission.js";
import { RuntimeInferenceOperationRuntime } from "../src/lib/meeting/runtime-inference-runtime.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import { commitStableAnswerRevision } from "../src/lib/meeting/stable-answer.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import type { ActiveInterviewParent } from "../src/lib/meeting/types.js";
import { assertEntryInLedger, assertNothingPlanted, createDiagnosticLogSpy, DIAGNOSTIC_LOG_SPY_FAILING_DELIVERIES, PLANTED, PLANTED_VALUES,
  type DiagnosticLogSpyDelivery } from "./helpers/diagnostic-log-spy.js";

function productionFunction(file: string, name: string, callback = false) {
  const source = readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(ast) === name) {
      found = callback ? (node as ts.VariableDeclaration).initializer &&
        ((node as ts.VariableDeclaration).initializer as ts.CallExpression).arguments[0] : node;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(found, `production function ${name}`);
  return ts.transpileModule(`(${found.getText(ast).replace(/^export\s+/, "")})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

const scheduleSource = productionFunction("src/hooks/useMeetingAssistant.ts", "scheduleWhiteboardSyntaxRepairShadow", true);
const requestSource = productionFunction("src/lib/meeting/whiteboard-syntax-repair-request.ts", "requestWhiteboardSyntaxRepair");
const validMermaid = "flowchart TD\nClient --> API\nAPI --> InventoryDB";
const fenced = (source: string) => `\`\`\`mermaid\n${source}\n\`\`\``;
const candidate = fenced(`${validMermaid}\nend`);
const validOutput = JSON.stringify({ mermaid: validMermaid, asciiFallback: "Client -> API -> InventoryDB", changedSyntaxOnly: true });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: test.TestContext, logLevel: "error" | "warn" | "info" | "debug" | "trace" = "trace",
  logDelivery?: DiagnosticLogSpyDelivery) {
  // Task 178 LG: the settle names the logger, so the environment supplies it by hand.
  const diagnosticLog = createDiagnosticLogSpy({ threshold: logLevel, delivery: logDelivery });
  const good = await artifact.validateWhiteboardRenderCandidate({ whiteboard: fenced(validMermaid), operationId: "valid-original" });
  assert.equal(good.valid, true, "real Mermaid parser accepts the original graph");
  const invalid = await artifact.validateWhiteboardRenderCandidate({ whiteboard: candidate, operationId: "invalid-candidate" });
  assert.equal(invalid.valid, false, "fixture must still need model repair after sanitation");
  const common = { parentTaskId: "parent", parentQuestionType: "general-system-design" as const,
    parentTopic: "Design an API", phase: "design_framing" as const, updateSource: "model-output" as const };
  const previous = artifact.updateWhiteboardArtifactFromAnswer({ ...common, finalContent: `Whiteboard:\n${fenced(validMermaid)}`, renderValidation: good });
  const preserved = artifact.updateWhiteboardArtifactFromAnswer({ ...common, existing: previous,
    finalContent: `Whiteboard:\n${candidate}`, renderValidation: invalid });
  assert.ok(preserved);
  assert.equal(preserved.content, previous!.content);
  const parent: ActiveInterviewParent = { id: "parent", source: "voice", stableKind: "general-system-design",
    topic: "Design an API", playbookPhase: "design_framing", phaseProgress: {}, supportedFactAnchors: [],
    createdAt: 1, updatedAt: 1, revisions: 1, whiteboardArtifact: preserved };
  const manager = new MeetingContextManager(); manager.reset({ sessionId: "repair-session" });
  assert.equal(manager.commitTaskRuntimeTransition({ id: "fixture-parent", transition: "create-parent", reason: "fixture", parent }).authorized, true);
  const shared = new admission.RuntimeInferenceProviderAdmissionCoordinator();
  const runtime = new RuntimeInferenceOperationRuntime<repair.WhiteboardSyntaxRepairJob, repair.WhiteboardSyntaxRepairRequestResult>("whiteboard-syntax-repair", shared);
  const delivery = deferred<{ rawOutput: string; providerDisposition: string; providerOutcome?: object }>();
  const started = deferred<void>(), terminal = deferred<Record<string, unknown>>();
  const metadata: Record<string, unknown>[] = [], recoveries: unknown[] = [];
  let requests = 0, validations = 0, finishes = 0;
  const realCommit = manager.commitTaskRuntimeTransition.bind(manager);
  let repairWrites = 0;
  manager.commitTaskRuntimeTransition = input => { repairWrites++; return realCommit(input); };
  const globals = {
    ...repair, ...artifact, ...inference, ...health, ...response, ...admission, Date, Math,
    logDiagnostic: diagnosticLog.logDiagnostic,
    WHITEBOARD_REPAIR_OPERATION: inference.getRuntimeInferenceOperationDefinition("whiteboard-syntax-repair"),
    requestRuntimeInferenceResponse: async () => { requests++; started.resolve(); return { ...await delivery.promise, completedAt: Date.now() }; },
    validateWhiteboardRenderCandidate: async (input: artifact.WhiteboardRenderValidationInput) => {
      validations++; return artifact.validateWhiteboardRenderCandidate(input);
    },
    // 178/168 PC: Runtime Cross-checks admits the repair observation; Debug only adds output detail.
    debugModeRef: { current: true }, runtimeCrossChecksEnabledRef: { current: true },
    contextManagerRef: { current: manager }, runtimeEpochRef: { current: 1 },
    whiteboardSyntaxRepairAttemptKeysRef: { current: new Set<string>() },
    whiteboardSyntaxRepairCircuitRef: { current: new health.RuntimeInferenceSessionCircuitBreaker() },
    whiteboardSyntaxRepairRuntimeRef: { current: runtime }, meetingModelProviderSnapshotRef: { current: {} },
    // Configuration/transport are external fixtures; request parsing and all business checks are real.
    resolveRuntimeInferenceModelRouteFromSnapshot: () => ({ provider: { id: "fixed" }, selectedProvider: { provider: "fixed", variables: { model: "fixed" } } }),
    formatRuntimeInferenceModelRouteForTrace: () => ({}), readSelectedProviderModelId: () => "fixed",
    traceStoreRef: { current: {
      updateMetadata: (_id: string, value: Record<string, unknown>) => metadata.push(value),
      recordInput() {}, recordOutput() {}, startStep: () => "repair-step", getTraces: () => [],
      finishStep: (_id: string, _step: string, _status: string, value: Record<string, unknown>) => { finishes++; terminal.resolve(value); },
    } },
    sessionRecordingManagerRef: { current: { getState: () => ({ active: true }), recordModelInput() {}, recordModelOutput() {},
      recordWhiteboardRenderRecovery: (row: unknown) => recoveries.push(row) } },
  };
  const context = vm.createContext(globals);
  Object.assign(globals, { requestWhiteboardSyntaxRepair: vm.runInContext(requestSource, context) });
  const schedule = vm.runInContext(scheduleSource, context);
  t.after(() => { runtime.cancelAll("disposed"); delivery.resolve({ rawOutput: "", providerDisposition: "completed-empty" }); });
  const input = { traceId: "trace", source: "voice", candidateWhiteboard: candidate, validation: invalid, parent };
  return { manager, parent, runtime, shared, metadata, recoveries, delivery, started, terminal, diagnosticLog,
    crossChecks: globals.runtimeCrossChecksEnabledRef,
    schedule: () => schedule(input),
    changeParent: (value: ActiveInterviewParent) => {
      const sameParent = value.id === parent.id;
      const result = realCommit({ id: `external-${Date.now()}`, transition: sameParent ? "update-parent-context" : "replace-parent",
        authorizedArtifacts: ["whiteboard"], reason: "fixture-change", parent: { ...value, revisions: sameParent ? value.revisions : value.revisions + 1 } });
      assert.equal(result.authorized && result.mutationApplied, true, "the external change must actually commit before releasing repair");
      return result;
    },
    get requests() { return requests; }, get validations() { return validations; }, get finishes() { return finishes; }, get repairWrites() { return repairWrites; } };
}

const cases = [
  ["W1 valid result", "valid", "shadow-valid"],
  ["W2 provider timeout", "timeout", "provider-error-content"],
  ["W3 invalid schema", "invalid", "invalid-output"],
  ["W4 semantic drift", "drift", "invalid-output"],
  ["W5 repeated failed revision", "repeat", "shadow-valid"],
  ["W6 newer artifact revision", "revision", "stale"],
  ["W7 replaced parent", "parent", "stale"],
  ["W8 reset session", "session", "stale"],
] as const;

for (const [name, scenario, expected] of cases) {
  test(`149 ${name}: actual scheduler, request parser and completion remain non-publishing`, { timeout: 8000 }, async t => {
    const h = await fixture(t);
    const before = structuredClone(h.manager.getState().taskRuntime);
    assert.equal(h.schedule(), undefined, "foreground caller does not await repair");
    if (scenario === "repeat") { h.schedule(); h.schedule(); }
    await h.started.promise;
    assert.equal(h.finishes, 0, "model is deliberately unresolved");
    assert.deepEqual(h.manager.getState().taskRuntime, before, "pending repair leaves foreground state readable");
    if (scenario === "valid") {
      const content = "Answer: Foreground output is ready while repair is pending.";
      const foreground = await h.shared.run({ operationId: "foreground", lane: "critical", signal: new AbortController().signal,
        execute: async () => commitStableAnswerRevision({ candidate: {
          id: "foreground-answer", kind: "answer", content, confidence: "high", createdAt: Date.now(),
          basedOnTurnIds: ["turn"], basedOnObservationIds: [], meetingAnswer: parseMeetingAnswer(content),
        }, authorizedArtifacts: ["answer"], taskId: "parent", logicalQuestionUnitId: "question", logicalQuestionRevision: 1 }) });
      assert.ok(foreground);
      assert.match(foreground.suggestion.content, /Foreground output is ready/);
      assert.equal(h.finishes, 0, "foreground admission and publication do not await the held repair");
    }
    if (scenario === "revision") h.changeParent({ ...h.parent, whiteboardArtifact: { ...h.parent.whiteboardArtifact!,
      renderState: { ...h.parent.whiteboardArtifact!.renderState!, candidateRevision: 3 } } });
    if (scenario === "parent") h.changeParent({ ...h.parent, id: "parent-next" });
    if (scenario === "session") h.manager.reset({ sessionId: "session-next" });
    const expectedState = structuredClone(h.manager.getState().taskRuntime);
    const rawOutput = scenario === "invalid" ? "{broken" : scenario === "drift"
      ? JSON.stringify({ mermaid: "flowchart TD\nOther --> Service", asciiFallback: "Other -> Service", changedSyntaxOnly: true }) : validOutput;
    h.delivery.resolve(scenario === "timeout" ? { rawOutput: "", providerDisposition: "provider-error-content",
      // The provider layer's terminal carries its error text; none of it may reach a log entry.
      providerOutcome: { status: "timed-out", safeErrorSummary: `${PLANTED.providerError} ${PLANTED.secret}` } }
      : { rawOutput, providerDisposition: "completed-with-content" });
    const final = await h.terminal.promise;
    assert.equal(final.whiteboardRepairDisposition, expected);
    assert.equal(final.whiteboardRepairBehaviorMutationBlocked, true);
    assert.equal(h.requests, 1); assert.equal(h.finishes, 1); assert.equal(h.recoveries.length, 1);
    assert.equal(h.validations, scenario === "valid" || scenario === "repeat" ? 1 : 0);
    if (scenario === "timeout") assert.equal(final.whiteboardRepairProviderOutcomeStatus, "timed-out");
    if (scenario === "drift") assert.equal(final.whiteboardRepairParseDisposition, "semantic-anchor-mismatch");
    if (scenario === "revision") assert.equal(final.whiteboardRepairAuthorizationReason, "candidate-revision-changed");
    if (scenario === "repeat") assert.equal(h.metadata.filter(m=>m.whiteboardRepairDisposition === "already-attempted").length, 2);
    assert.equal(h.repairWrites, 0); assert.deepEqual(h.manager.getState().taskRuntime, expectedState);
    // Task 178 LG, summary site 6 (LG1 Timeout 4 and 5, LG3, LG4): one entry at the settle, graded from the typed
    // provider status of a repair that is still current. W2 is the timed-out check; W6 to W8 are stale work.
    const stale = ["revision", "parent", "session"].includes(scenario);
    const entries = h.diagnosticLog.entries();
    assert.equal(entries.length, 1, "one entry for the repair operation");
    assertEntryInLedger(entries[0]!);
    assert.deepEqual([entries[0]!.level, entries[0]!.source, entries[0]!.event, entries[0]!.refs],
      [scenario === "timeout" ? "warn" : "debug", "meeting.whiteboard-repair", "repair-settled", { traceId: "trace" }]);
    const { durationMs, queueWaitMs, ...data } = entries[0]!.data!;
    assert.ok(typeof durationMs === "number" && durationMs >= 0 && typeof queueWaitMs === "number" && queueWaitMs >= 0);
    assert.deepEqual(data, { disposition: "completed", leaseAuthorized: !stale,
      ...(scenario === "timeout" ? { providerStatus: "timed-out" } : {}),
      parseValid: !["timeout", "invalid", "drift"].includes(scenario) });
    assertNothingPlanted(entries, [...PLANTED_VALUES, validMermaid, "Client --> API", "Design an API"], name);
    const counters = h.diagnosticLog.snapshot();
    assert.deepEqual([counters.refusedEntries, counters.refusedFields, counters.truncatedFields, counters.detailFailures], [0, 0, 0, 0]);
  });
}

// Timeout table 3.1, row 5 for the repair: the same typed timeout, for a candidate that is no longer the current one.
test("149 LG1 Timeout 5: a timed-out repair of a candidate that was replaced meanwhile is debug, and the same timeout of the current one is warn at every level but error", { timeout: 8000 }, async t => {
  const timedOut = { rawOutput: "", providerDisposition: "provider-error-content", providerOutcome: { status: "timed-out", safeErrorSummary: PLANTED.providerError } };
  const stale = await fixture(t);
  stale.schedule();
  await stale.started.promise;
  stale.changeParent({ ...stale.parent, whiteboardArtifact: { ...stale.parent.whiteboardArtifact!,
    renderState: { ...stale.parent.whiteboardArtifact!.renderState!, candidateRevision: 3 } } });
  stale.delivery.resolve(timedOut);
  assert.equal((await stale.terminal.promise).whiteboardRepairDisposition, "stale");
  assert.deepEqual(stale.diagnosticLog.entries().map(entry => [entry.level, entry.data!.leaseAuthorized, entry.data!.providerStatus]),
    [["debug", false, "timed-out"]]);
  // LG2: the settle's own record is the same at every level; only the entry is filtered. The same holds with the
  // log delivery failing: the call site reads no delivery result, and the same entry is handed to the logger.
  // Each run has its own context manager, admission coordinator and runtime, and waits out the real admission grace,
  // so the twenty-five runs are started together.
  const combinations = (["ok", ...DIAGNOSTIC_LOG_SPY_FAILING_DELIVERIES] as const).flatMap(logDelivery =>
    (["trace", "debug", "info", "warn", "error"] as const).map(level => ({ logDelivery, level })));
  const runs = await Promise.all(combinations.map(async ({ logDelivery, level }) => {
    const h = await fixture(t, level, logDelivery);
    h.schedule();
    await h.started.promise;
    h.delivery.resolve(timedOut);
    const final = await h.terminal.promise;
    const business = JSON.parse(JSON.stringify([final, h.recoveries.length, h.requests, h.finishes, h.repairWrites, h.manager.getState().taskRuntime],
      (key, value) => /(At|Ms|OperationId|operationId|Id|id)$/.test(key) ? undefined : value));
    return { logDelivery, level, h, final, business };
  }));
  assert.deepEqual([runs.length, runs[0]!.logDelivery, runs[0]!.level], [25, "ok", "trace"]);
  for (const { logDelivery, level, h, final, business } of runs) {
    const name = `${level} with delivery ${logDelivery}`;
    assert.deepEqual(business, runs[0]!.business, name);
    assert.equal(final.whiteboardRepairProviderOutcomeStatus, "timed-out");
    const handedOver = h.diagnosticLog.entries();
    assert.deepEqual(handedOver.map(entry => [entry.level, entry.data!.leaseAuthorized, entry.data!.providerStatus]),
      level === "error" ? [] : [["warn", true, "timed-out"]], name);
    const counters = h.diagnosticLog.snapshot();
    assert.deepEqual([counters.undeliveredEntries, counters.internalErrors, counters.queued, counters.inFlight],
      [logDelivery === "ok" ? 0 : handedOver.length, 0, 0, false], name);
  }
});

// 178/168 PC6: the switch is read once, when the repair observation starts. A
// repair already in flight when it is switched off ends as it would have, and
// nothing new starts afterwards.
test("149 PC6 W9 Cross-checks switched off with a repair admitted: its request is still sent after the admission grace, it completes under its start-time trigger without publishing, and a later schedule starts nothing", { timeout: 8000 }, async t => {
  const h = await fixture(t);
  const before = structuredClone(h.manager.getState().taskRuntime);
  h.schedule();
  // The repair is admitted; its request waits out the coordinator's grace for the background lane.
  assert.equal(h.requests, 0);
  h.crossChecks.current = false;
  // Off: a schedule for the same, still eligible candidate records the named
  // skip and nothing else. With the switch on it records "already-attempted" (W5).
  const recordedBefore = h.metadata.length;
  assert.equal(h.schedule(), undefined);
  // Compared as plain data: the update was built in the Hook callback's own realm.
  assert.deepEqual(JSON.parse(JSON.stringify(h.metadata.slice(recordedBefore))),
    [{ whiteboardRepairObservationSkipReason: "runtime-cross-checks-off" }], "recorded for a schedule made while off");
  // Switching off cancels nothing that was admitted: the request goes out when the grace ends.
  await h.started.promise;
  assert.equal(h.requests, 1);
  h.delivery.resolve({ rawOutput: validOutput, providerDisposition: "completed-with-content" });
  const final = await h.terminal.promise;
  assert.equal(final.whiteboardRepairDisposition, "shadow-valid");
  assert.equal(final.whiteboardRepairBehaviorMutationBlocked, true);
  // The trigger recorded at the start is what the trace still holds at the terminal.
  assert.equal(Object.assign({}, ...h.metadata).whiteboardRepairObservationTrigger, "runtime-cross-checks");
  assert.equal(h.metadata.some(update => update.whiteboardRepairDisposition === "already-attempted"), false);
  assert.deepEqual([h.requests, h.finishes, h.recoveries.length, h.validations, h.repairWrites], [1, 1, 1, 1, 0]);
  assert.deepEqual(h.manager.getState().taskRuntime, before, "the repair observation writes no task or Artifact state");
});
