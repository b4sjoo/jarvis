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

async function fixture(t: test.TestContext) {
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
    WHITEBOARD_REPAIR_OPERATION: inference.getRuntimeInferenceOperationDefinition("whiteboard-syntax-repair"),
    requestRuntimeInferenceResponse: async () => { requests++; started.resolve(); return { ...await delivery.promise, completedAt: Date.now() }; },
    validateWhiteboardRenderCandidate: async (input: artifact.WhiteboardRenderValidationInput) => {
      validations++; return artifact.validateWhiteboardRenderCandidate(input);
    },
    debugModeRef: { current: true }, contextManagerRef: { current: manager }, runtimeEpochRef: { current: 1 },
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
  return { manager, parent, runtime, shared, metadata, recoveries, delivery, started, terminal,
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
    h.delivery.resolve(scenario === "timeout" ? { rawOutput: "", providerDisposition: "provider-error-content", providerOutcome: { status: "timed-out" } }
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
  });
}
