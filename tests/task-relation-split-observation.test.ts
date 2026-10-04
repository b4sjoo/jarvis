import type { ActiveMeetingTask } from "../src/lib/meeting/meeting-task-contracts.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as split from "../src/lib/meeting/task-relation-split-shadow.js";
import * as operation from "../src/lib/meeting/runtime-inference.js";
import * as response from "../src/lib/meeting/runtime-inference-response.js";
import * as admission from "../src/lib/meeting/runtime-inference-provider-admission.js";
import { RuntimeInferenceSessionCircuitBreaker } from "../src/lib/meeting/runtime-inference-health.js";
import * as route from "../src/lib/meeting/meeting-model-route.js";
import * as taxonomy from "../src/lib/meeting/task-taxonomy.js";
import { requestTaskRelationProviderCandidates } from "../src/lib/meeting/task-relation-provider-candidates.js";
import { resolveOrderedTaskRelationWithinWindow } from "../src/lib/meeting/ordered-relation-operation.js";
import { RuntimeInferenceOperationRuntime } from "../src/lib/meeting/runtime-inference-runtime.js";
import {
  buildTaskRelationAdjudicationRequest,
  isRuntimeTaskRelation,
} from "../src/lib/meeting/task-relation-adjudication.js";
import {
  buildTaskRelationAdjudicationReflectionReport,
} from "../scripts/lib/task-relation-adjudication-reflection.js";
import {
  SessionRecordingManager,
  type SessionRecordingInvoke,
} from "../src/lib/meeting/session-recording.js";
import { AIResponseEventBuilder } from "../src/lib/functions/ai-response-events.js";
import {
  buildHumanEvaluationAttemptEvidenceIndexV2,
} from "../src/lib/meeting/human-evaluation-attempt-projection.js";
import { MeetingTraceStore } from "../src/lib/meeting/trace.js";
import { createRuntimeCriticalEventHarness, RUNTIME_CRITICAL_EVENT_HOOK_CALLBACKS } from "./helpers/runtime-critical-events.js";
import { assertEntryInLedger, assertNothingPlanted, createDiagnosticLogSpy } from "./helpers/diagnostic-log-spy.js";

import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import type { MeetingAssistantSettings } from "../src/lib/meeting/types.js";

// Execute the production closures, as in ordered-relation-publication-callback.
// Only transport, clock and native filesystem I/O are replaced; no test parser,
// authorization decision, recorder serialization or reader is substituted.
function declaration(source: string, name: string, callback = false): string {
  const file = ts.createSourceFile("production.ts", source, ts.ScriptTarget.Latest, true);
  let found: ts.VariableDeclaration | ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name?.getText(file) === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(found, `missing production declaration ${name}`);
  if (callback) {
    assert.ok(ts.isVariableDeclaration(found) && found.initializer && ts.isCallExpression(found.initializer));
    return found.initializer.arguments[0]!.getText(file);
  }
  return found.getText(file).replace(/^export\s+/, "");
}

const hookSource = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
const requestSource = readFileSync("src/lib/meeting/task-relation-split-shadow-request.ts", "utf8");
const readerSource = readFileSync("scripts/reflect-taxonomy-adjudication-session.ts", "utf8");
const baselineSource = process.env.TASK183_BASELINE_REV
  ? execFileSync("git", ["show", `${process.env.TASK183_BASELINE_REV}:src/hooks/useMeetingAssistant.ts`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
  : undefined;
const compile = (source: string, environment: Record<string, unknown>) => vm.runInNewContext(
  ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText,
  environment
);
const loadDecisions = compile([
  declaration(readerSource, "isMissingFile"),
  declaration(readerSource, "readOptionalJsonLines"),
  "readOptionalJsonLines",
].join("\n"), { readFile }) as (file: string) => Promise<any[]>;

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class Clock {
  now = 10_000;
  nextId = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  previous = { now: Date.now, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  constructor() {
    Date.now = () => this.now;
    globalThis.setTimeout = ((callback: () => void, delay = 0) => {
      const id = ++this.nextId;
      this.timers.set(id, { at: this.now + delay, callback });
      return id;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => this.timers.delete(id)) as unknown as typeof clearTimeout;
  }
  async flush() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
  async startPending() {
    await this.flush();
    for (const [id, timer] of [...this.timers].filter(([, timer]) => timer.at <= this.now)) {
      if (!this.timers.has(id)) continue;
      this.timers.delete(id);
      timer.callback();
      await this.flush();
    }
  }
  restore() {
    Date.now = this.previous.now;
    globalThis.setTimeout = this.previous.setTimeout;
    globalThis.clearTimeout = this.previous.clearTimeout;
  }
}

type Mode = "enabled" | "disabled" | "slow" | "failing" | "close-failed";
class DiskRecorder {
  calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  writeMs: number[] = [];
  blocked = gate<void>();
  blockedStarted = gate<void>();
  failures = 0;
  failTerminal = false;
  manager: SessionRecordingManager;
  folder = "";
  constructor(readonly root: string, readonly mode: Mode) {
    const invoke: SessionRecordingInvoke = async <T>(command: string, args: Record<string, unknown> = {}) => {
      this.calls.push({ command, args });
      const folder = path.join(root, String(args.folderName));
      if (command === "start_meeting_session_recording") {
        await mkdir(folder, { recursive: true });
        return folder as T;
      }
      if (command === "write_meeting_session_recording_text") {
        if (this.failTerminal && args.relativePath === "manifest.json") {
          this.failTerminal = false;
          throw new Error("controlled terminal publication failure");
        }
        if (mode === "slow" && String(args.relativePath).includes("task-relation-decisions")) {
          this.blockedStarted.resolve();
          await this.blocked.promise;
        }
        if (mode === "failing" && String(args.relativePath).includes("task-relation-decisions")) {
          this.failures++;
          throw new Error("controlled recorder write failure");
        }
        const filename = path.join(folder, String(args.relativePath));
        await mkdir(path.dirname(filename), { recursive: true });
        const before = performance.now();
        await (args.append ? appendFile : writeFile)(filename, String(args.payload));
        this.writeMs.push(performance.now() - before);
      }
      return folder as T;
    };
    this.manager = new SessionRecordingManager(undefined, invoke);
  }
  async start() {
    if (this.mode === "disabled") return;
    const state = await this.manager.start({
      meetingSessionId: "session-a",
      settings: { codingModel: { enabled: false, provider: "", variables: {} }, taxonomyAdjudication: { enabled: true, provider: "", variables: {} } } as unknown as MeetingAssistantSettings,
      providerSummary: { hasMainProvider: false, hasCodingProvider: false, hasTaxonomyAdjudicationProvider: false, hasSttProvider: false, mainSupportsImages: false, codingSupportsImages: false },
    });
    this.folder = path.join(this.root, state.folderName!);
    if (this.mode === "close-failed") {
      this.failTerminal = true;
      await assert.rejects(this.manager.stop(), /controlled terminal publication failure/);
      assert.equal(this.manager.getState().active, false);
      assert.equal(this.manager.getState().lifecycle, "close-failed");
    }
  }
  async stop() {
    this.blocked.resolve();
    await this.manager.stop("task183-test");
  }
  decisions() {
    return loadDecisions(path.join(this.folder, "runtime-inference/task-relation-decisions.jsonl"));
  }
}

const unit: LogicalQuestionUnit = {
  id: "lqu-current", revision: 1, sessionId: "session-a", runtimeEpoch: 1,
  currentTurnId: "turn-current", sourceTurnIds: ["turn-current"],
  sources: [{ turnId: "turn-current", text: "Implement a queue.", startedAt: 1, endedAt: 2 }],
  normalizedText: "Implement a queue.", startedAt: 1, updatedAt: 2,
  compositionReasons: ["independent-current-turn"], boundaryReason: "independent-current-turn", truncated: false,
};
function activeTask(child = true): ActiveMeetingTask {
  return {
    id: "parent-a", runtimeRevision: 1, source: "voice",
    parent: { id: "parent-a", questionType: "general-system-design", topic: "Implement a cache.",
      playbookPhase: "requirement_clarification", revisions: 1,
      createdAt: 1, updatedAt: 1, supportedFactAnchors: [], canonicalQuestionSourceTurnIds: ["turn-parent"],
      startTurnId: "turn-parent", promptTranscriptStartTurnId: "turn-parent", phaseProgress: {} },
    child: child ? { id: "child-a", createdAt: 1, updatedAt: 1, questionType: "field-knowledge", relation: "child-probe",
      intent: "concept-probe", question: "Explain cache eviction.", basedOnTurnIds: ["turn-child"], basedOnObservationIds: [] } : undefined,
  };
}
type Fault = "success" | "malformed" | "empty" | "provider" | "auth" | "partial-provider" | "cancel" | "oversize";
const canonicalBytes = JSON.stringify({ schemaVersion: 3, relation: "new-parent", confidence: 0.99,
  currentQuestionEvidenceSpans: ["Implement a queue."], parentEvidenceSpans: [] });
function bytes(kind: string, fault: Fault) {
  if (fault === "malformed") return "{broken";
  if (fault === "oversize") return "x".repeat(split.TASK_RELATION_SPLIT_MAX_OUTPUT_CHARS + 1);
  if (fault === "partial-provider") return "partial candidate";
  if (fault !== "success") return "";
  return kind === "task-relation-canonical-shadow" ? canonicalBytes
    : JSON.stringify({ v: 1, d: kind === "task-relation-child-affinity" ? "n" : "i", c: 0.99, q: "Implement a queue.", b: null });
}

async function harness(options: { mode?: Mode; child?: boolean; source?: string; omitObservation?: boolean; runtimeReleaseRequested?: boolean;
  runtimeCrossChecks?: boolean } = {}) {
  const root = await mkdtemp("/private/tmp/task183-evidence-");
  const disk = new DiskRecorder(root, options.mode ?? "enabled");
  const clock = new Clock();
  await disk.start();
  const state = { sessionId: "session-a", activeMeetingTask: activeTask(options.child ?? true) };
  const metadata: Record<string, unknown> = {};
  const trace = new MeetingTraceStore();
  trace.hydrate([{ id: "trace", kind: "voice", status: "running", startedAt: 10_000, steps: [], inputs: [], outputs: [] }]);
  const stepIds = new Map<string, string>();
  const effects: any[] = [];
  const refreshed: unknown[] = [];
  const callbackMs: number[] = [];
  const serializationMs: number[] = [];
  // Three logical operations own recorder decisions; each has two physical candidates.
  const executions: any[] = [];
  const physicalExecutions: any[] = [];
  const sharedAdmission = new admission.RuntimeInferenceProviderAdmissionCoordinator();
  const admissionReceipts: admission.RuntimeInferenceSharedAdmissionReceipt[] = [];
  const admit = sharedAdmission.run.bind(sharedAdmission);
  sharedAdmission.run = (input: any) => admit({ ...input, onAdmitted: (receipt) => {
    admissionReceipts.push(receipt);
    input.onAdmitted?.(receipt);
  } });
  const providerSnapshot = {
    providers: [{ id: "test-provider", curl: "curl https://fixture.invalid/{{MODEL}}" }],
    selectedProvider: { provider: "test-provider", variables: { MODEL: "test-intelligent" } },
    taxonomyAdjudicationProvider: { provider: "test-provider", variables: { MODEL: "test-fast" } },
    codingProvider: { provider: "", variables: {} },
  } as unknown as route.MeetingModelProviderSnapshot;
  sharedAdmission.configureProviderGroups({
    fastFingerprint: route.resolveRuntimeInferenceModelRouteFromSnapshot({ snapshot: providerSnapshot,
      operationKind: "task-relation-parent-affinity", providerTier: "fast" }).configFingerprint,
    intelligentFingerprint: route.resolveRuntimeInferenceModelRouteFromSnapshot({ snapshot: providerSnapshot,
      operationKind: "task-relation-parent-affinity", providerTier: "intelligent" }).configFingerprint,
  });
  // Task 178 LG: the stage settle names the logger, so the environment supplies it by hand.
  const diagnosticLog = createDiagnosticLogSpy({ threshold: "trace", now: () => clock.now });
  const environment: Record<string, any> = {
    ...split, ...operation, ...response, ...admission, ...route, ...taxonomy, isRuntimeTaskRelation,
    requestTaskRelationProviderCandidates,
    logDiagnostic: diagnosticLog.logDiagnostic,
    Date, Promise, Error, DOMException, console,
    debugModeRef: { current: false },
    // 178/168 PC: the one switch that admits an observation-only operation.
    runtimeCrossChecksEnabledRef: { current: options.runtimeCrossChecks ?? false },
    contextManagerRef: { current: { getState: () => state, clearExpiredActiveMeetingTask: () => false } },
    runtimeEpochRef: { current: 1 }, manualCorrectionRevisionRef: { current: 0 },
    meetingModelProviderSnapshotRef: { current: providerSnapshot },
    runtimeInferenceProviderAdmissionRef: { current: sharedAdmission },
    sessionRecordingManagerRef: { current: disk.manager },
    // The real session circuit breaker, as in the Hook.
    taskRelationSplitShadowCircuitRef: { current: new RuntimeInferenceSessionCircuitBreaker() },
    readSelectedProviderModelId: (selected: any) => selected.variables.MODEL,
    traceStoreRef: { current: {
      updateMetadata: (id: string, update: Record<string, unknown>) => {
        Object.assign(metadata, update);
        trace.updateMetadata(id, update);
      },
      recordInput: (...args: Parameters<MeetingTraceStore["recordInput"]>) => {
        effects.push(["input", ...args]);
        trace.recordInput(...args);
      },
      getTraces: () => trace.getTraces(),
      getObserverSnapshot: () => trace.getObserverSnapshot(),
      startStep: (...args: Parameters<MeetingTraceStore["startStep"]>) => {
        effects.push(["start", ...args]);
        const id = trace.startStep(...args);
        if (id) stepIds.set(id, `step-${stepIds.size + 1}`);
        return id;
      },
      finishStep: (...args: Parameters<MeetingTraceStore["finishStep"]>) => {
        effects.push(["finish", args[0], args[1] ? stepIds.get(args[1]) : undefined, ...args.slice(2)]);
        trace.finishStep(...args);
      },
    } },
    buildHumanEvaluationAttemptEvidenceIndexV2,
    refreshHumanEvaluationObservedProjectionForTrace: (...args: unknown[]) => refreshed.push(args),
    getAutoExportTrigger: () => "auto-success",
  };
  environment.refreshRecordedCompletedTrace = compile(
    `(${declaration(hookSource, "refreshRecordedCompletedTrace", true)})`, environment
  );
  if (options.omitObservation) environment.formatTaskRelationSplitObservationForTrace = () => ({});
  environment.fetchAIResponseEvents = (input: any) => {
    const completion = gate<Fault>();
    const execution = { input, completion, kind: "", raw: "", firstAt: undefined as number | undefined, completedAt: 0 };
    physicalExecutions.push(execution);
    input.signal.addEventListener("abort", () => completion.resolve("cancel"), { once: true });
    return (async function* () {
      const fault = await completion.promise;
      const builder = new AIResponseEventBuilder("test-provider", { ...input.executionIdentity, attemptId: `${input.executionIdentity.requestId}:attempt`, attemptNumber: 1, maxAttempts: 1 });
      execution.raw = bytes(execution.kind, fault);
      if (execution.raw) {
        execution.firstAt = ++clock.now;
        yield builder.content(execution.raw);
      }
      execution.completedAt = ++clock.now;
      yield builder.terminal({
        status: fault === "cancel" ? "aborted" : fault === "empty" ? "empty"
          : ["provider", "auth", "partial-provider"].includes(fault) ? "failed" : "success",
        failureClass: fault === "auth" ? "authentication" : ["provider", "partial-provider"].includes(fault) ? "transport" : undefined,
        retryable: false,
      });
    })();
  };
  const commonRequestSource = readFileSync("src/lib/meeting/runtime-inference-request.ts", "utf8");
  environment.requestRuntimeInferenceResponse = compile([
    declaration(commonRequestSource, "requestRuntimeInferenceResponse"), "requestRuntimeInferenceResponse",
  ].join("\n"), environment);
  const requestCandidate = compile([
    declaration(requestSource, "requestTaskRelationSplitShadow"), "requestTaskRelationSplitShadow",
  ].join("\n"), environment);
  environment.requestTaskRelationSplitShadow = (input: any) => {
    const promise = requestCandidate(input);
    const execution = physicalExecutions.find((item) => item.input.executionIdentity.requestId === input.executionIdentity.requestId);
    assert.ok(execution);
    execution.kind = input.request.operationKind;
    return promise.then((result: any) => { execution.result = result; return result; });
  };
  for (const [name, kind] of [
    ["taskRelationChildAffinityRuntimeRef", "task-relation-child-affinity"],
    ["taskRelationParentAffinityRuntimeRef", "task-relation-parent-affinity"],
    ["taskRelationCanonicalShadowRuntimeRef", "task-relation-canonical-shadow"],
    // 178/168 PC: observation runs on its own three instances of the same runtime class.
    ["taskRelationChildAffinityObservationRuntimeRef", "task-relation-child-affinity"],
    ["taskRelationParentAffinityObservationRuntimeRef", "task-relation-parent-affinity"],
    ["taskRelationCanonicalShadowObservationRuntimeRef", "task-relation-canonical-shadow"],
  ] as const) {
    const runtime = new RuntimeInferenceOperationRuntime<any, any>(kind);
    const schedule = runtime.schedule.bind(runtime);
    runtime.schedule = (scheduled, delay) => schedule({
      ...scheduled,
      execute: (job, signal) => {
        executions.push({ kind, operationId: job.operationId });
        return scheduled.execute(job, signal);
      },
      onSettled: (settlement) => {
        const execution = executions.find((item) => item.operationId === settlement.job.operationId);
        const physical = physicalExecutions.find(({ input }) => input.executionIdentity.requestId ===
          `${settlement.job.operationId}:${settlement.result?.selectedProviderTier ?? "intelligent"}`);
        if (execution) Object.assign(execution, { result: settlement.result, firstAt: physical?.firstAt,
          completedAt: physical?.completedAt, selectedRequestId: physical?.input.executionIdentity.requestId });
        const before = performance.now();
        scheduled.onSettled(settlement);
        callbackMs.push(performance.now() - before);
        const serializeAt = performance.now();
        JSON.stringify(metadata);
        serializationMs.push(performance.now() - serializeAt);
      },
    }, delay);
    environment[name] = { current: runtime };
  }
  // Task 178A: the schedule calls the Hook's own emit callback at each real
  // request start and candidate terminal. It runs here against the real stream,
  // with nobody subscribed, and the real recorder of this harness.
  const criticalEvents = createRuntimeCriticalEventHarness({ sessionId: state.sessionId, observe: false });
  criticalEvents.install(environment, (name) => compile(`(${declaration(hookSource, name, true)})`, environment));
  assert.deepEqual(RUNTIME_CRITICAL_EVENT_HOOK_CALLBACKS.filter((name) => typeof environment[name] !== "function"), []);
  const schedule = compile(`(${declaration(options.source ?? hookSource, "scheduleTaskRelationSplitRuntime", true)})`, environment);
  const request = buildTaskRelationAdjudicationRequest({ logicalQuestionUnit: unit, activeMeetingTask: state.activeMeetingTask });
  const handle = schedule({ traceId: "trace", taskId: "task-a", request, runtimeReleaseRequested: options.runtimeReleaseRequested ?? true,
    authorizeSourceOperation: () => ({ authorized: true, reason: "source-operation-current" }) });
  await clock.startPending();
  return {
    root, disk, clock, trace, state, metadata, effects, refreshed, callbackMs, serializationMs, executions, physicalExecutions, admissionReceipts, environment, handle,
    criticalEvents, diagnosticLog,
    async affinities(fault: Fault = "success") {
      if (fault === "cancel") {
        environment.taskRelationChildAffinityRuntimeRef.current.cancelAll("fixture-cancel");
        environment.taskRelationParentAffinityRuntimeRef.current.cancelAll("fixture-cancel");
      }
      for (const execution of physicalExecutions) execution.completion.resolve(fault);
      await clock.flush();
      return handle.affinityOutcome;
    },
    async canonical(fault: Fault = "success", beforeComplete?: () => void) {
      const previousPhysicalCount = physicalExecutions.length;
      const result = handle.startCanonical({ foreground: true });
      await clock.startPending();
      const candidates = physicalExecutions.slice(previousPhysicalCount);
      assert.equal(candidates.length, 2);
      for (const execution of candidates) assert.equal(execution.kind, "task-relation-canonical-shadow");
      beforeComplete?.();
      if (fault === "cancel") environment.taskRelationCanonicalShadowRuntimeRef.current.cancelAll("fixture-cancel");
      for (const execution of candidates) execution.completion.resolve(fault);
      await clock.flush();
      return result;
    },
    async close() {
      await disk.stop();
      clock.restore();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function prefix(kind: string) {
  return kind === "task-relation-canonical-shadow" ? "taskRelationSplitCanonical"
    : kind === "task-relation-child-affinity" ? "taskRelationChildAffinity" : "taskRelationParentAffinity";
}
function latest(decisions: any[], key: string) {
  const row = [...decisions].reverse().find((row) => row.metadata[`${key}OperationId`]);
  assert.ok(row, `missing ${key}`);
  return row.metadata;
}
function assertObserved(metadata: Record<string, unknown>, execution: any, valid: boolean) {
  const key = prefix(execution.kind);
  assert.equal(metadata[`${key}ParseValid`], valid);
  assert.equal(metadata[`${key}CompletedAt`], execution.result.completedAt);
  assert.ok(execution.result.completedAt >= execution.completedAt);
  assert.equal(metadata[`${key}FirstTokenAt`], execution.firstAt);
  assert.equal(metadata[`${key}ParsedDecision`], valid && execution.kind !== "task-relation-canonical-shadow"
    ? execution.kind === "task-relation-child-affinity" ? "unrelated" : "independent" : undefined);
  assert.equal(metadata[`${key}ParsedRelation`], valid && execution.kind === "task-relation-canonical-shadow" ? "new-parent" : undefined);
  assert.equal(metadata[`${key}NativeFinishReason`], undefined);
}

test("D5 request bytes -> real parser/runtime callbacks -> recorder files -> current CLI reader/builder", async () => {
  const h = await harness();
  try {
    const affinity = await h.affinities();
    assert.equal(affinity.child.adjudication.decision, "unrelated");
    assert.equal(affinity.parent.adjudication.decision, "independent");
    const canonical = await h.canonical();
    assert.equal(canonical.adjudication.relation, "new-parent");
    await h.disk.stop();
    const decisions = await h.disk.decisions();
    assert.equal(decisions.length, 3);
    for (const execution of h.executions) {
      const metadata = latest(decisions, prefix(execution.kind));
      assertObserved(metadata, execution, true);
      assert.equal(metadata[`${prefix(execution.kind)}ParseDisposition`], "valid-json");
      assert.equal(metadata[`${prefix(execution.kind)}LeaseAuthorized`], true);
    }
    const report = buildTaskRelationAdjudicationReflectionReport({ decisions, evaluations: [], now: 20_000 });
    assert.equal(report.metrics.currentOperations, 3);
    assert.equal(report.metrics.legacyOperations, 0);
    for (const execution of h.executions) {
        const row = report.rows.find((item) => item.operationId === execution.operationId);
        assert.ok(row);
        assert.equal(row.rawCandidate, execution.kind === "task-relation-canonical-shadow" ? "new-parent"
          : execution.kind === "task-relation-child-affinity" ? "unrelated" : "independent");
        assert.equal(row.parseValid, true);
        assert.equal(row.parseDisposition, "valid-json");
        assert.equal(row.firstTokenAt, execution.firstAt);
        assert.equal(row.completedAt, execution.result.completedAt);
        assert.equal(row.expectedRelation, undefined);
    }
  } finally { await h.close(); }
});

test("D5 valid candidates survive stale lease and canonical predecessor refusal without accepted fields", async () => {
  for (const refusal of ["lease", "predecessor"] as const) {
    const h = await harness();
    try {
      if (refusal === "lease") h.environment.manualCorrectionRevisionRef.current++;
      const affinity = await h.affinities();
      if (refusal === "lease") {
        assert.equal(affinity.child.adjudication, undefined);
        assert.equal(affinity.parent.adjudication, undefined);
      }
      const canonical = await h.canonical("success", () => {
        if (refusal === "predecessor") h.environment.taskRelationParentAffinityRuntimeRef.current.cancelAll("superseded");
      });
      assert.equal(canonical.adjudication, undefined);
      await h.disk.stop();
      const decisions = await h.disk.decisions();
      for (const execution of h.executions) assertObserved(latest(decisions, prefix(execution.kind)), execution, true);
      const metadata = latest(decisions, "taskRelationSplitCanonical");
      assert.equal(metadata.taskRelationSplitCanonicalRelation, undefined);
      assert.equal(metadata.taskRelationSplitCanonicalAvailable, false);
      assert.equal(refusal === "lease" ? metadata.taskRelationSplitCanonicalLeaseAuthorized
        : metadata.taskRelationSplitCanonicalPredecessorsAuthorized, false);
      if (refusal === "lease") {
        assert.equal(metadata.taskRelationChildAffinityDecision, undefined);
        assert.equal(metadata.taskRelationParentAffinityDecision, undefined);
      }
    } finally { await h.close(); }
  }
});

for (const fault of ["malformed", "oversize", "empty", "provider", "auth", "partial-provider"] as const) {
  test(`D5 all stages retain actual ${fault} parse/timing evidence`, async () => {
    const h = await harness();
    try {
      const affinity = await h.affinities(fault);
      const canonical = await h.canonical(fault);
      assert.equal(affinity.child.adjudication, undefined);
      assert.equal(affinity.parent.adjudication, undefined);
      assert.equal(canonical.adjudication, undefined);
      await h.disk.stop();
      const decisions = await h.disk.decisions();
      for (const execution of h.executions) {
        const metadata = latest(decisions, prefix(execution.kind));
        assertObserved(metadata, execution, false);
        const disposition = metadata[`${prefix(execution.kind)}ParseDisposition`];
        assert.equal(typeof disposition, "string");
        if (["empty", "provider", "auth", "partial-provider"].includes(fault)) assert.match(disposition as string, /^not-run-/);
        if (fault === "partial-provider") {
          assert.equal(metadata[`${prefix(execution.kind)}ProviderOutcomeStatus`], "failed");
          assert.equal(metadata[`${prefix(execution.kind)}ProviderObservedContentChars`], "partial candidate".length);
        }
      }
    } finally { await h.close(); }
  });
}

test("D5 cancellation before content has no invented parse or token/completion result; skipped stage is distinct", async () => {
  const h = await harness({ child: false });
  try {
    h.handle.cancelForegroundWork();
    await h.clock.flush();
    const affinity = await h.handle.affinityOutcome;
    assert.equal(affinity.child.unavailableReason, "no-active-child");
    assert.equal(affinity.parent.adjudication, undefined);
    assert.equal(h.executions.length, 1);
    await h.disk.stop();
    const decisions = await h.disk.decisions();
    assert.equal(decisions.length, 1);
    const metadata = decisions[0].metadata;
    assert.equal(typeof metadata.taskRelationParentAffinityOperationId, "string");
    assert.equal(typeof metadata.taskRelationParentAffinityStartedAt, "number");
    assert.equal(metadata.taskRelationParentAffinityParseValid, undefined);
    assert.equal(metadata.taskRelationParentAffinityCompletedAt, undefined);
    assert.equal(metadata.taskRelationParentAffinityFirstTokenAt, undefined);
    assert.equal(metadata.taskRelationChildAffinityOperationId, undefined);
    assert.equal(metadata.taskRelationSplitCanonicalOperationId, undefined);
    assert.equal(metadata.taskRelationSplitCanonicalParseValid, undefined);
  } finally { await h.close(); }
});

test("D5 cancellation at canonical before content preserves completed affinity observations", async () => {
  const h = await harness();
  try {
    await h.affinities();
    const canonical = await h.canonical("cancel", () => h.handle.cancelForegroundWork());
    assert.equal(canonical.adjudication, undefined);
    await h.disk.stop();
    const metadata = latest(await h.disk.decisions(), "taskRelationSplitCanonical");
    assert.equal(metadata.taskRelationSplitCanonicalParseValid, undefined);
    assert.equal(metadata.taskRelationSplitCanonicalFirstTokenAt, undefined);
    assert.equal(metadata.taskRelationSplitCanonicalCompletedAt, undefined);
    assert.equal(metadata.taskRelationParentAffinityParseValid, true);
  } finally { await h.close(); }
});

test("D5 delayed callback never writes to replacement recorder or restarted generation", async () => {
  for (const replacement of ["manager", "generation", "started-later"] as const) {
    const h = await harness({ mode: replacement === "started-later" ? "disabled" : "enabled" });
    const next = new DiskRecorder(h.root, "enabled");
    try {
      h.clock.now += 100;
      if (replacement === "generation") {
        await h.disk.stop();
        await h.disk.start();
      } else {
        await next.start();
        h.environment.sessionRecordingManagerRef.current = next.manager;
      }
      h.state.sessionId = "session-b";
      h.environment.runtimeEpochRef.current++;
      h.trace.finishTrace("trace", "success");
      let nextRecorderCallbacks = 0;
      const nextManager = replacement === "generation" ? h.disk.manager : next.manager;
      for (const name of ["recordTaskRelationAdjudicationDecision", "recordModelInput", "recordModelOutput", "refreshRecordedTrace"] as const) {
        const original = nextManager[name].bind(nextManager);
        (nextManager[name] as any) = (...args: any[]) => {
          nextRecorderCallbacks++;
          return (original as any)(...args);
        };
      }
      const affinity = await h.affinities();
      assert.equal(affinity.parent.adjudication, undefined);
      await h.canonical();
      await next.stop();
      await h.disk.stop();
      assert.equal((await (replacement === "generation" ? h.disk : next).decisions()).length, 0);
      assert.equal(h.refreshed.length, 0);
      assert.equal(nextRecorderCallbacks, 0);
      if (replacement === "manager") {
        const original = await h.disk.decisions();
        assert.equal(original.length, 3);
        assert.equal(original[0].metadata.taskRelationChildAffinityParseValid, true);
      }
    } finally { await next.stop(); await h.close(); }
  }
});

test("D5 sensitivity: omitting the independent observation spread fails the composed evidence assertion", async () => {
  const h = await harness({ omitObservation: true });
  try {
    await h.affinities();
    await h.disk.stop();
    const metadata = latest(await h.disk.decisions(), "taskRelationParentAffinity");
    assert.throws(() => assertObserved(metadata, h.executions[1], true), assert.AssertionError);
  } finally { await h.close(); }
});

test("ST183-7 deadline handoff reads back from recorder files: completed -> selected -> authorized -> consumed -> final", async () => {
  const h = await harness();
  try {
    const fast = (execution: any) => String(execution.input.executionIdentity.requestId).endsWith(":fast");
    let canonicalDeadlineAt = 0;
    // The real shared consumer over the real stage owner, recorder and request path.
    const resolution = resolveOrderedTaskRelationWithinWindow({
      handle: { ...h.handle, releaseWindowRequested: true, startCanonical: (input: any) => {
        canonicalDeadlineAt = input.deadlineAt;
        return h.handle.startCanonical(input);
      } },
      traceId: "trace", sourceKind: "voice", currentQuestionType: "general-system-design",
      activeMeetingTask: h.state.activeMeetingTask, waitBudgetMs: 8_000,
    }, { now: () => h.clock.now,
      recordMetadata: (id, update) => h.environment.traceStoreRef.current.updateMetadata(id, update) });
    // Only Fast answers. Intelligent stays silent, so each stage ends at its own deadline.
    for (const execution of h.physicalExecutions.filter(fast)) execution.completion.resolve("success");
    await h.clock.flush();
    assert.equal(h.metadata.taskRelationParentAffinitySelectedProviderTier, undefined, "cached, not yet selected");
    h.clock.now = 14_000;
    await h.clock.startPending();
    await h.clock.startPending();
    const canonical = h.physicalExecutions.filter((execution) => execution.kind === "task-relation-canonical-shadow");
    assert.equal(canonical.length, 2);
    assert.equal(canonicalDeadlineAt - 4_000 >= 14_000 && canonicalDeadlineAt - 4_000 <= h.clock.now, true);
    canonical.find(fast).completion.resolve("success");
    await h.clock.flush();
    h.clock.now = canonicalDeadlineAt;
    await h.clock.startPending();
    const result = await resolution;
    assert.equal(result.decision.stage, "canonical-relation");
    assert.equal(result.decision.relation, "new-parent");
    assert.equal(h.physicalExecutions.length, 6, "no extra model request");
    await h.disk.stop();
    const decisions = await h.disk.decisions();
    assert.equal(decisions.length, 3, "one recorded settlement per operation");
    const report = buildTaskRelationAdjudicationReflectionReport({ decisions, evaluations: [], now: 30_000 });
    const row = (family: string) => {
      const found = report.rows.filter((item) => item.operationFamily === family);
      assert.equal(found.length, 1, family);
      return found[0];
    };
    for (const [family, key, candidate] of [["child", "taskRelationChildAffinity", "unrelated"],
      ["parent", "taskRelationParentAffinity", "independent"]] as const) {
      const recorded = latest(decisions, key);
      const physical = h.physicalExecutions.find((execution) =>
        execution.input.executionIdentity.requestId === recorded[`${key}SelectedRequestId`]);
      // completed -> selected: the Fast candidate finished early and was selected at the stage deadline.
      assert.equal(recorded[`${key}SelectedProviderTier`], "fast");
      assert.equal(recorded[`${key}CompletedAt`], physical.result.completedAt);
      assert.ok((recorded[`${key}CompletedAt`] as number) < 14_000);
      assert.equal(recorded[`${key}StageDeadlineAt`], 14_000);
      // This harness's clock ticks once per provider event, including the sibling's cancellation.
      assert.ok((recorded[`${key}SelectedAt`] as number) >= 14_000 && (recorded[`${key}SelectedAt`] as number) <= 14_004);
      // selected -> authorized, as the offline reader sees it.
      assert.equal(row(family).operationId, recorded[`${key}OperationId`]);
      assert.equal(row(family).leaseAuthorized, true);
      assert.equal(row(family).rawCandidate, candidate);
      assert.equal(row(family).completedAt, physical.result.completedAt);
    }
    // authorized -> consumed: Canonical's predecessors are exactly those two recorded operations.
    const recordedCanonical = latest(decisions, "taskRelationSplitCanonical");
    assert.deepEqual(row("canonical").predecessorOperationIds, [row("child").operationId, row("parent").operationId]);
    assert.equal(row("canonical").predecessorsAuthorized, true);
    assert.equal(row("canonical").leaseAuthorized, true);
    assert.equal(row("canonical").rawCandidate, "new-parent");
    assert.equal(recordedCanonical.taskRelationSplitParentPredecessorOutputHash, recordedCanonical.taskRelationParentAffinityOutputHash);
    assert.equal(recordedCanonical.taskRelationSplitChildPredecessorOutputHash, recordedCanonical.taskRelationChildAffinityOutputHash);
    assert.equal(recordedCanonical.taskRelationSplitCanonicalSelectedProviderTier, "fast");
    assert.equal(recordedCanonical.taskRelationSplitCanonicalSelectedAt, canonicalDeadlineAt);
    // Task 178 LG3. The selection reason is the one additive key of the stage settle, read back here from the
    // recorder's own files: each stage ended at its deadline with a timely Fast, which the selected tier alone does not say.
    for (const key of ["taskRelationChildAffinity", "taskRelationParentAffinity", "taskRelationSplitCanonical"] as const) {
      assert.equal(latest(decisions, key)[`${key}SelectionReason`], "candidate-deadline-expired", key);
      assert.equal(h.metadata[`${key}SelectionReason`], "candidate-deadline-expired", `${key} in the trace`);
    }
    // Where the recording holds it: in the Relation decision file, and in the timeline lines of the three stage
    // settles, each a decision line and the line of that stage's saved model output, which carry the settle's
    // metadata. No candidate row and no other file has it.
    const holding: string[] = [];
    for (const file of await readdir(h.disk.folder, { recursive: true })) {
      const absolute = path.join(h.disk.folder, file);
      if (!(await stat(absolute)).isFile()) continue;
      const text = await readFile(absolute, "utf8");
      if (/taskRelation(?:ChildAffinity|ParentAffinity|SplitCanonical)SelectionReason/.test(text)) holding.push(file.split(path.sep).join("/"));
      assert.equal(text.includes('"selectionReason"'), false, `${file}: no candidate row carries the reason`);
    }
    assert.deepEqual(holding.sort(), ["runtime-inference/task-relation-decisions.jsonl", "timeline.jsonl"]);
    const timelineKinds = (await readFile(path.join(h.disk.folder, "timeline.jsonl"), "utf8")).split("\n")
      .filter((line) => line.includes("SelectionReason")).map((line) => JSON.parse(line).kind as string);
    assert.deepEqual(timelineKinds.sort(), ["model-output", "model-output", "model-output", "task-relation-adjudication-decision",
      "task-relation-adjudication-decision", "task-relation-adjudication-decision"]);
    // This test drives the shared Ordered operation with its own metadata writer, and the stages of a formal
    // operation log nothing at their own settle: the logger was never called.
    assert.deepEqual(h.diagnosticLog.entries(), []);
    assert.equal(h.diagnosticLog.snapshot().filtered + h.diagnosticLog.snapshot().accepted, 0);
    // consumed -> final source.
    assert.equal(h.metadata.taskRelationOrderedResolutionAffinityParentDisposition, "available");
    assert.equal(h.metadata.taskRelationOrderedResolutionAffinityChildDisposition, "available");
    assert.equal(h.metadata.taskRelationOrderedResolutionCanonicalDisposition, "available");
    assert.equal(h.metadata.taskRelationOrderedResolutionStage, "canonical-relation");
    assert.equal(h.metadata.taskRelationOrderedResolutionRelation, "new-parent");
  } finally { await h.close(); }
});

// Strip only the newly approved observation fields. Preserve IDs, timestamps,
// source/revision ownership, inputs, admission and every existing release field.
function business(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, item) =>
    /^taskRelation(?:ChildAffinity|ParentAffinity|SplitCanonical)(?:ParseDisposition|ParseValid|ParsedDecision|ParsedRelation|FirstTokenAt|CompletedAt)$/.test(key)
      ? undefined : item));
}
function percentile(values: number[], p: number) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * p))];
}

test("D6 paired completion effects match with disabled, slow and failing disk; bounded callback/serialization measurement", async (t) => {
  const samples: any[] = [];
  for (const fault of ["success", "malformed", "cancel"] as const) {
    let expected: unknown;
    for (const source of baselineSource ? [baselineSource, hookSource] : [hookSource]) {
      for (const mode of ["enabled", "disabled", "slow", "failing", "close-failed"] as const) {
        const h = await harness({ mode, source });
        try {
          const affinity = await h.affinities(fault);
          if (mode === "slow") await h.disk.blockedStarted.promise;
          const canonical = await h.canonical(fault);
          // No disk drain has occurred: even a indefinitely blocked native write
          // cannot delay either production completion or change its decision.
          const actual = business({ affinity, canonical, metadata: h.metadata, effects: h.effects,
            requests: h.physicalExecutions.map(({ input, kind }) => ({ kind, ...input, signal: { aborted: input.signal.aborted } })),
            state: h.state, authorization: h.handle.authorizeOperation() });
          if (expected === undefined) expected = actual;
          else assert.deepEqual(actual, expected, `${fault}/${mode}/${source === hookSource ? "candidate" : "baseline"}`);
          assert.equal(h.executions.length, 3);
          assert.equal(h.physicalExecutions.length, 6);
          assert.equal(h.admissionReceipts.length, 6);
          await h.disk.stop();
          if (mode === "failing") {
            assert.equal(h.disk.failures, 3);
            assert.match(h.disk.manager.getState().lastError ?? "", /controlled recorder write failure/);
          }
          const decisionWrites = h.disk.calls.filter(({ args }) => args.relativePath === "runtime-inference/task-relation-decisions.jsonl");
          const textWrites = h.disk.calls.filter(({ command }) => command === "write_meeting_session_recording_text");
          samples.push({ source: source === hookSource ? "candidate" : "baseline", mode, fault,
            decisionRecords: decisionWrites.length,
            decisionBytes: decisionWrites.reduce((sum, { args }) => sum + Buffer.byteLength(String(args.payload)), 0),
            totalTextWrites: textWrites.length,
            totalTextBytes: textWrites.reduce((sum, { args }) => sum + Buffer.byteLength(String(args.payload)), 0),
            callbackMedianMs: percentile(h.callbackMs, 0.5), callbackP95Ms: percentile(h.callbackMs, 0.95),
            serializationMedianMs: percentile(h.serializationMs, 0.5), serializationP95Ms: percentile(h.serializationMs, 0.95) });
        } finally { await h.close(); }
      }
    }
  }
  for (const sample of samples) t.diagnostic(JSON.stringify(sample));
});

test("RC3: a retained close-failed owner cannot activate observation-only inference", async () => {
  for (const mode of ["disabled", "close-failed"] as const) {
    const h = await harness({ mode, runtimeReleaseRequested: false });
    try {
      assert.equal(h.executions.length, 0);
      assert.equal(h.handle, undefined);
      assert.equal(h.disk.manager.getState().active, false);
    } finally { await h.close(); }
  }
});

test("PC2 RC3: Runtime Cross-checks, not the recorder's state, admits observation-only inference, and an inactive recorder is not written", async () => {
  for (const mode of ["disabled", "close-failed"] as const) {
    const h = await harness({ mode, runtimeReleaseRequested: false, runtimeCrossChecks: true });
    try {
      const writesBefore = h.disk.calls.length;
      assert.ok(h.handle, "observation admitted by Cross-checks");
      // Child and parent Affinity, each one logical operation with a Fast and an Intelligent candidate.
      // The observation runs on the evaluation lane: its physical requests yield for the
      // shared coordinator's 450 ms non-critical grace, exactly as before this change.
      assert.equal(h.physicalExecutions.length, 0, "no observation request inside the non-critical grace");
      h.clock.now += 450;
      await h.clock.startPending();
      assert.deepEqual(h.executions.map((execution: any) => execution.kind).sort(),
        ["task-relation-child-affinity", "task-relation-parent-affinity"]);
      assert.equal(h.physicalExecutions.length, 4);
      assert.equal(h.metadata.taskRelationParentAffinityObservationTrigger, "runtime-cross-checks");
      assert.equal(h.metadata.taskRelationParentAffinityAdmissionLane, "evaluation");
      const affinity = await h.affinities();
      assert.equal(affinity.parent.adjudication.decision, "independent");
      assert.equal(h.disk.manager.getState().active, false);
      assert.equal(h.disk.calls.length, writesBefore, "an inactive recorder receives nothing from the observation");
      // Task 178 LG, summary site 2: each observation stage logs one entry at its own settle. Both ended with a
      // parse-valid Intelligent result, so both are debug, whatever the recorder's state is.
      const entries = h.diagnosticLog.entries();
      for (const entry of entries) assertEntryInLedger(entry);
      assert.deepEqual(entries.map((entry) => [entry.level, entry.event, entry.refs, entry.data!.stage, entry.data!.disposition,
        entry.data!.current, entry.data!.selection, entry.data!.tier, entry.data!.parseValid, entry.data!.providerStatus])
        .sort((left, right) => String(left[3]).localeCompare(String(right[3]))), [
        ["debug", "observation-stage-settled", { traceId: "trace" }, "child-affinity", "completed", true, "intelligent-valid", "intelligent", true, "success"],
        ["debug", "observation-stage-settled", { traceId: "trace" }, "parent-affinity", "completed", true, "intelligent-valid", "intelligent", true, "success"],
      ]);
      assertNothingPlanted(entries, ["Implement a queue.", "Implement a cache.", "Explain cache eviction."], mode);
    } finally { await h.close(); }
  }
});
