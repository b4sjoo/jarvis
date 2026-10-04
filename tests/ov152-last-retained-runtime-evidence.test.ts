import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import {
  authorizeAnswerGenerationLease,
  createAnswerGenerationLease,
  formatAnswerGenerationLeaseForTrace,
  type AnswerGenerationLease,
} from "../src/lib/meeting/answer-generation-lease.js";
import { createAdvisorTriggerJob } from "../src/lib/meeting/advisor-trigger-job.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import {
  buildGenerationAuthorizationRejection,
  formatGenerationResultLedgerForTrace,
  GenerationDerivedCommitCoordinator,
  GenerationResultLedger,
} from "../src/lib/meeting/generation-result-ledger.js";
import {
  createHumanGroundTruthEventV2,
  deriveHumanEvaluationProjectionV2,
} from "../src/lib/meeting/human-ground-truth-v2.js";
import {
  authorizeRuntimeCommit,
  buildRuntimeCommitSnapshot,
  createRuntimeCommitToken,
  formatRuntimeCommitAuthorizationForTrace,
  type RuntimeCommitSnapshot,
} from "../src/lib/meeting/runtime-commit-authorization.js";
import { ScreenOperationCoordinator } from "../src/lib/meeting/screen-operation-coordinator.js";
import {
  buildCompactTraceSummary,
  SessionRecordingManager,
  type SessionCompactTraceSummary,
  type SessionRecordingInvoke,
} from "../src/lib/meeting/session-recording.js";
import { buildSettledAdvisorExecutionPlan } from "../src/lib/meeting/settled-advisor-execution-plan.js";
import { MeetingTraceStore } from "../src/lib/meeting/trace.js";
import type {
  MeetingAssistantSettings,
  MeetingTrace,
} from "../src/lib/meeting/types.js";
import { readRecordedTraceSummaries } from "../scripts/lib/session-aggregate-evidence.js";
import { createRuntimeCriticalEventHarness } from "./helpers/runtime-critical-events.js";
import {
  buildSessionLongitudinalEvaluationReport,
  evaluateLongitudinalSessionEvidenceScope,
  LAST_RETAINED_RUNTIME_EVIDENCE_DERIVATION_VERSION,
  LAST_RETAINED_RUNTIME_EVIDENCE_FIRST_SUMMARY_SCHEMA,
  renderSessionLongitudinalEvaluationMarkdown,
  type LongitudinalSessionInput,
  type LongitudinalTraceSummary,
} from "../scripts/lib/session-longitudinal-evaluation.js";

// ---------------------------------------------------------------------------
// Production write paths, taken from the Hook source instead of re-typed here.
// ---------------------------------------------------------------------------

const HOOK_PATH = "src/hooks/useMeetingAssistant.ts";
const hook = ts.createSourceFile(
  HOOK_PATH,
  readFileSync(HOOK_PATH, "utf8"),
  ts.ScriptTarget.Latest,
  true
);

function onlyHookNode(label: string, predicate: (node: ts.Node) => boolean) {
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(hook);
  assert.equal(matches.length, 1, `Hook must contain exactly one ${label}`);
  return matches[0]!;
}

function hookStatement(label: string, predicate: (node: ts.Node) => boolean) {
  let node = onlyHookNode(label, predicate);
  while (!ts.isStatement(node)) node = node.parent;
  return node.getText(hook);
}

const declares =
  (name: string, initializer?: RegExp) => (node: ts.Node) =>
    ts.isVariableDeclaration(node) &&
    node.name.getText(hook) === name &&
    (!initializer || initializer.test(node.initializer?.getText(hook) ?? ""));

function hookDeclaration(name: string, initializer?: RegExp) {
  return hookStatement(name, declares(name, initializer));
}

function hookCallback(name: string) {
  const declaration = onlyHookNode(name, declares(name)) as ts.VariableDeclaration;
  assert.ok(
    declaration.initializer && ts.isCallExpression(declaration.initializer),
    `${name} must remain a callback`
  );
  return declaration.initializer.arguments[0]!.getText(hook);
}

function evaluate<T>(body: string, environment: Record<string, unknown>): T {
  const javascript = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return Function(...Object.keys(environment), javascript)(
    ...Object.values(environment)
  ) as T;
}

const VOICE_AUTHORIZATION = [
  hookDeclaration("readCommitDecision"),
  hookDeclaration("terminalizeAuthorizationRejection"),
  hookDeclaration("rejectStaleCommit"),
].join("\n");
const SCREEN_ADMISSION = [
  hookDeclaration("screenOperationClaim"),
  hookDeclaration("screenRuntimeToken"),
  hookDeclaration("trace", /startTrace\(\s*"screen"/),
  hookStatement(
    "Screen attachTrace",
    (node) =>
      ts.isExpressionStatement(node) &&
      node.expression
        .getText(hook)
        .startsWith("screenOperationCoordinatorRef.current.attachTrace(")
  ),
  hookStatement(
    "Screen supersede write",
    (node) =>
      ts.isIfStatement(node) &&
      node.expression.getText(hook) === "screenOperationClaim.supersedesTraceId"
  ),
].join("\n");
const SCREEN_AUTHORIZATION = [
  hookDeclaration("readScreenAuthorization"),
  hookDeclaration("rejectStaleScreenOperation"),
].join("\n");
/** The one root write that carries `screenOperationCommitReason`. */
function isScreenFinalCommitWrite(node: ts.Node) {
  if (
    !ts.isCallExpression(node) ||
    node.expression.getText(hook) !== "traceStoreRef.current.updateMetadata"
  ) {
    return false;
  }
  const metadata = node.arguments[1];
  return Boolean(
    metadata &&
      ts.isObjectLiteralExpression(metadata) &&
      metadata.properties.some(
        (property) =>
          property.name?.getText(hook) === "screenOperationCommitReason"
      )
  );
}
const SCREEN_FINAL_COMMIT = [
  hookDeclaration("screenVisibleAnswerCommitted"),
  hookStatement("Screen final commit write", isScreenFinalCommitWrite),
].join("\n");
/** The Screen partial-output guard: its decision read and its Token write. */
const SCREEN_PARTIAL_OUTPUT_GUARD = (() => {
  const guard = onlyHookNode(
    "Screen partial-output Token write",
    (node) =>
      ts.isIfStatement(node) &&
      node.expression.getText(hook) === "!runtimeDecision.authorized" &&
      node.thenStatement.getText(hook).includes('"partial-output"')
  ) as ts.IfStatement;
  const block = guard.parent;
  assert.ok(ts.isBlock(block));
  const decision = block.statements[block.statements.indexOf(guard) - 1];
  assert.equal(
    decision?.getText(hook),
    "const runtimeDecision = readScreenAuthorization();"
  );
  return `${decision.getText(hook)}\n${guard.getText(hook)}`;
})();
const VOICE_LEASE_REGISTRATION = hookStatement(
  "active advisor generation lease registration",
  (node) =>
    ts.isExpressionStatement(node) &&
    node.expression
      .getText(hook)
      .startsWith("activeAdvisorGenerationLeaseRef.current = {")
);

interface World {
  sessionId: string;
  runtimeEpoch: number;
  parent: { id: string; revisions: number } | undefined;
  visibleAnswerRevision: number;
  manualCorrectionRevision: number;
  responseActionRevision: number;
  activeAdvisorJobId: string | undefined;
}

type Runtime = ReturnType<typeof createRuntime>;

/** Real trace store, ledger and coordinators behind the Hook's own callbacks. */
function createRuntime() {
  const world: World = {
    sessionId: "meeting-a",
    runtimeEpoch: 1,
    parent: { id: "parent-a", revisions: 1 },
    visibleAnswerRevision: 1,
    manualCorrectionRevision: 0,
    responseActionRevision: 0,
    activeAdvisorJobId: undefined,
  };
  const store = new MeetingTraceStore();
  const ledger = new GenerationResultLedger();
  const commits = new GenerationDerivedCommitCoordinator(ledger);
  const screens = new ScreenOperationCoordinator();
  const lifecycleEvents: Array<Record<string, unknown>> = [];
  const displayed: unknown[] = [];
  const refs = {
    traceStoreRef: { current: store },
    generationResultLedgerRef: { current: ledger },
    screenOperationCoordinatorRef: { current: screens },
    contextManagerRef: {
      current: {
        getState: () => ({
          sessionId: world.sessionId,
          activeMeetingTask: world.parent ? { parent: world.parent } : undefined,
        }),
      },
    },
    runtimeEpochRef: { get current() { return world.runtimeEpoch; } },
    visibleAnswerRevisionRef: { get current() { return world.visibleAnswerRevision; } },
    manualCorrectionRevisionRef: { get current() { return world.manualCorrectionRevision; } },
    responseActionRevisionRef: { get current() { return world.responseActionRevision; } },
    preparationRuntimeContextRef: { current: { preparationContextRevision: 1 } },
    activeAdvisorJobRef: {
      get current() {
        return world.activeAdvisorJobId ? { id: world.activeAdvisorJobId } : null;
      },
      set current(job: { id: string } | null) {
        world.activeAdvisorJobId = job?.id;
      },
    },
    activeAdvisorGenerationLeaseRef: {
      current: undefined as
        | { advisorJobId: string; lease: AnswerGenerationLease }
        | undefined,
    },
    sessionRecordingManagerRef: {
      current: {
        recordCaptureLifecycle: (event: Record<string, unknown>) =>
          lifecycleEvents.push(event),
      },
    },
  };
  const useCallback = <T,>(callback: T) => callback;
  // Task 178A: the real stream and the real Hook emit callbacks. Every
  // evaluation below spreads refs, so the lifted Hook code reaches them.
  const criticalEvents = createRuntimeCriticalEventHarness({
    sessionId: world.sessionId,
  });
  criticalEvents.install(refs as Record<string, unknown>, (name) =>
    evaluate(`return (${hookCallback(name)});`, { ...refs }));
  const readRuntimeCommitSnapshot = evaluate<() => RuntimeCommitSnapshot>(
    `return (${hookCallback("readRuntimeCommitSnapshot")});`,
    { ...refs, buildRuntimeCommitSnapshot }
  );
  const publishGenerationResultProjection = evaluate<
    (lease: AnswerGenerationLease, traceId?: string) => unknown
  >(`return (${hookCallback("publishGenerationResultProjection")});`, {
    ...refs,
    formatGenerationResultLedgerForTrace,
    revokeIncompleteAdvisePin: () => {},
    setState: (update: (previous: object) => { generationResult: unknown }) =>
      displayed.push(update({}).generationResult),
  });
  const terminalizeGenerationLease = evaluate<(input: object) => unknown>(
    `return (${hookCallback("terminalizeGenerationLease")});`,
    { ...refs, publishGenerationResultProjection }
  );
  const finishRunningAdvisorJobTrace = evaluate<(...args: unknown[]) => void>(
    `return (${hookCallback("finishRunningAdvisorJobTrace")});`,
    { ...refs, useCallback }
  );
  // Same keys as the production formatter: an adjacent "commit authorized"
  // pair on the root and on steps that must never feed the Token group.
  const formatAdvisorTriggerJobForTrace = (
    job: { id: string; source?: string },
    outcome: string,
    extra: Record<string, unknown> = {}
  ) => ({
    advisorJobId: job.id,
    advisorJobSource: job.source,
    advisorJobOutcome: outcome,
    advisorJobCancellationReason: extra.cancellationReason,
    advisorJobCommitAuthorized: extra.commitAuthorized,
    advisorJobCommitAuthorizationReason: extra.commitAuthorizationReason,
  });
  // The Hook's own release: it writes the job's pair on the root and
  // terminalizes the job's still-active generation lease.
  const releaseAdvisorJob = evaluate<(...args: unknown[]) => void>(
    `return (${hookCallback("releaseAdvisorJob")});`,
    {
      ...refs,
      formatAdvisorTriggerJobForTrace,
      terminalizeGenerationLease,
      recordQuestionTypeAdjudicationOutcome: () => {},
      pendingAdvisorGenerationSupersessionRef: { current: null },
      promotePendingAdvisorGenerationRef: { current: () => {} },
      window: { setTimeout: () => 0 },
    }
  );

  const createLease = () =>
    createAnswerGenerationLease({
      sessionId: world.sessionId,
      runtimeEpoch: world.runtimeEpoch,
      preparationContextRevision: 1,
      taskId: world.parent?.id ?? null,
      taskRevision: world.parent?.revisions ?? null,
      logicalQuestionUnitId: "question-a",
      logicalQuestionRevision: 1,
      baseVisibleAnswerRevision: world.visibleAnswerRevision,
      sourceTurnIds: ["turn-a"],
      manualCorrectionRevision: world.manualCorrectionRevision,
      responseActionRevision: world.responseActionRevision,
      modelRoute: "fixture",
      artifactOwnerId: world.parent?.id ?? null,
      requestedArtifacts: ["answer"],
    });
  const leaseSnapshot = (lease: AnswerGenerationLease) => ({
    sessionId: world.sessionId,
    runtimeEpoch: world.runtimeEpoch,
    preparationContextRevision: 1,
    taskId: world.parent?.id ?? null,
    taskRevision: world.parent?.revisions ?? null,
    logicalQuestionUnitId: lease.logicalQuestionUnitId,
    logicalQuestionRevision: lease.logicalQuestionRevision,
    visibleAnswerRevision: world.visibleAnswerRevision,
    manualCorrectionRevision: world.manualCorrectionRevision,
    responseActionRevision: world.responseActionRevision,
    artifactOwnerId: world.parent?.id ?? null,
    authorizedArtifacts: ["answer" as const],
  });

  return {
    world,
    store,
    ledger,
    screens,
    refs,
    criticalEvents,
    lifecycleEvents,
    displayed,
    readRuntimeCommitSnapshot,
    publishGenerationResultProjection,
    terminalizeGenerationLease,
    finishRunningAdvisorJobTrace,
    formatAdvisorTriggerJobForTrace,
    releaseAdvisorJob,
    createLease,
    /** The Hook's order: ledger.begin, then the projection write on the trace. */
    beginGeneration(traceId: string) {
      const lease = createLease();
      ledger.begin({ lease, traceId });
      publishGenerationResultProjection(lease, traceId);
      return lease;
    },
    /** The Hook's order: derived commit, then the projection write. */
    commitGeneration(
      lease: AnswerGenerationLease,
      traceId: string,
      options: { candidateAccepted?: boolean } = {}
    ) {
      const result = commits.commit({
        lease,
        leaseAuthorization: authorizeAnswerGenerationLease(
          lease,
          leaseSnapshot(lease)
        ),
        expectedTaskRuntimeRevision: 1,
        currentTaskRuntimeRevision: 1,
        candidateAccepted: options.candidateAccepted ?? true,
        visibleAnswerRevision: world.visibleAnswerRevision + 1,
        apply: () => {
          world.visibleAnswerRevision += 1;
          return {
            revision: world.visibleAnswerRevision,
            sections: { code: { revision: 1 }, complexity: { revision: 1 } },
            suggestion: { content: "Answer" },
          };
        },
      });
      publishGenerationResultProjection(lease, traceId);
      return result;
    },
    markGenerationPending(lease: AnswerGenerationLease, traceId: string) {
      commits.markPending({
        lease,
        leaseAuthorization: authorizeAnswerGenerationLease(
          lease,
          leaseSnapshot(lease)
        ),
        expectedTaskRuntimeRevision: 1,
        currentTaskRuntimeRevision: 1,
        candidateAccepted: true,
        reason: "delivery-lock-active",
      });
      publishGenerationResultProjection(lease, traceId);
    },
    exported(traceId: string) {
      const trace = store.getTrace(traceId);
      assert.ok(trace, traceId);
      return trace;
    },
  };
}

function startVoiceAttempt(
  runtime: Runtime,
  jobId: string,
  options: {
    lease?: boolean;
    operationId?: string;
    selectedQuestionOnly?: boolean;
  } = {}
) {
  const { world, store } = runtime;
  world.activeAdvisorJobId = jobId;
  const trace = store.startTrace("voice", {
    advisorJobId: jobId,
    activeMeetingParentId: world.parent?.id,
    taskRelation: "followup-parent",
    logicalQuestionUnitId: "question-a",
  });
  const token = createRuntimeCommitToken({
    operationId: options.operationId ?? jobId,
    pipeline: "advisor",
    snapshot: runtime.readRuntimeCommitSnapshot(),
  });
  const lease = options.lease ? runtime.beginGeneration(trace.id) : undefined;
  const advisorJob = {
    id: jobId,
    traceId: trace.id,
    source: "live-turn",
    logicalQuestionUnit: { id: "question-a" },
  };
  if (lease) {
    evaluate<void>(VOICE_LEASE_REGISTRATION, {
      ...runtime.refs,
      advisorJob,
      answerGenerationLease: lease,
    });
  }
  // Whether a selected historical question is still the selected one.
  const selection = { held: true };
  const rejectStaleCommit = evaluate<(stage: string) => boolean>(
    `${VOICE_AUTHORIZATION}\nreturn rejectStaleCommit;`,
    {
      ...runtime.refs,
      authorizeRuntimeCommit,
      effectiveRuntimeCommitToken: token,
      readRuntimeCommitSnapshot: runtime.readRuntimeCommitSnapshot,
      buildGenerationAuthorizationRejection,
      formatRuntimeCommitAuthorizationForTrace,
      authorizeAnswerGenerationLease,
      formatAnswerGenerationLeaseForTrace,
      answerGenerationLease: lease,
      generationAuthorizedArtifacts: ["answer"],
      terminalizeGenerationLease: runtime.terminalizeGenerationLease,
      finishRunningAdvisorJobTrace: runtime.finishRunningAdvisorJobTrace,
      traceId: trace.id,
      advisorJob,
      selectedQuestionOnly: options.selectedQuestionOnly ?? false,
      isSelectedHistoricalQuestion: () => selection.held,
      options: {},
      logicalQuestionLease: undefined,
      settledExecutionPlan: undefined,
      readLogicalQuestionAuthorizationTarget: () => ({
        logicalQuestionUnit: { id: "question-a", revision: 1 },
      }),
      setState: () => {},
      updateForceAdviseTargetForAdvisorOutcome: () => {},
      releaseAdvisorJob: runtime.releaseAdvisorJob,
      formatAdvisorTriggerJobForTrace: runtime.formatAdvisorTriggerJobForTrace,
    }
  );
  return { trace, token, lease, jobId, selection, rejectStaleCommit };
}

interface ScreenOperation {
  trace: MeetingTrace;
  screenGenerationLease: AnswerGenerationLease | undefined;
  rejectStaleScreenOperation(stage: string): boolean;
  /** The Hook's partial-output guard: a Token write without a disposition. */
  partialOutput(): void;
  commitFinal(
    screenGenerationCommit: { reason: string } | undefined,
    screenStableCommitDecision: { reason: string },
    nextStableAnswer: unknown
  ): void;
}

function admitScreenOperation(
  runtime: Runtime,
  screenOperationId: string,
  options: { lease?: boolean } = {}
) {
  return evaluate<ScreenOperation>(
    `${SCREEN_ADMISSION}
     const screenGenerationLease = beginScreenGeneration(trace.id);
     ${SCREEN_AUTHORIZATION}
     const partialOutput = () => {
       ${SCREEN_PARTIAL_OUTPUT_GUARD}
     };
     const commitFinal = (screenGenerationCommit, screenStableCommitDecision, nextStableAnswer) => {
       ${SCREEN_FINAL_COMMIT}
     };
     return { trace, screenGenerationLease, rejectStaleScreenOperation, partialOutput, commitFinal };`,
    {
      ...runtime.refs,
      screenOperationId,
      screenOperationRequestedAt: Date.now(),
      source: "hotkey",
      options: {},
      latePreflightRepair: undefined,
      screenRefreshAuthority: undefined,
      screenVoiceQuestionBinding: undefined,
      selectedVisualRecovery: {},
      formatRefreshAuthorityForTrace: () => ({}),
      formatManualScreenVoiceQuestionBindingForTrace: () => ({}),
      formatAwaitingVisualEvidenceRecoveryForTrace: () => ({}),
      createRuntimeCommitToken,
      readRuntimeCommitSnapshot: runtime.readRuntimeCommitSnapshot,
      beginScreenGeneration: (traceId: string) =>
        options.lease === false ? undefined : runtime.beginGeneration(traceId),
      authorizeRuntimeCommit,
      formatRuntimeCommitAuthorizationForTrace,
      authorizeAnswerGenerationLease,
      formatAnswerGenerationLeaseForTrace,
      boundVisualRecoveryFact: undefined,
      readCurrentVisualRecoveryFact: () => undefined,
      screenGenerationRequestedArtifacts: ["answer"],
      screenSourceOwnedTransitionReceipt: undefined,
      sourceOwnedDurableTransitionSurvivesModelOutcome: () => false,
      formatSourceOwnedDurableTransitionForTrace: () => ({}),
      screenModelCompletedAt: undefined,
      screenResponseCandidate: undefined,
      screenTerminalError: undefined,
      recordScreenQuestionTypeOutcome: () => {},
      terminalizeGenerationLease: runtime.terminalizeGenerationLease,
      screenStableCommitMetadata: {},
      screenParentAuthorizedArtifacts: ["answer"],
      screenPresentationAuthorizedArtifacts: ["answer"],
      previousStableAnswer: undefined,
      isQuestionHiddenByPin: () => false,
      visibleAnswerRevisionBefore: runtime.world.visibleAnswerRevision,
      visibleAnswerRevisionAfter: runtime.world.visibleAnswerRevision,
      formatStagedAnswerDeliveryForTrace: () => ({}),
      screenStagedChunkCount: 0,
      screenStagedFirstChunkAt: undefined,
      screenStagedFirstVisiblePartialAt: undefined,
      screenStagedVisible: false,
      screenModelGenerationIdentity: {},
      formatModelGenerationTimingForTrace: () => ({}),
      screenModelRequestStartedAt: undefined,
      screenModelFirstContentAt: undefined,
    }
  );
}

/** Final guard, derived commit, projection write, final root write, finish. */
function finishScreenOperation(
  runtime: Runtime,
  operation: ScreenOperation,
  options: { candidateAccepted?: boolean } = {}
) {
  assert.equal(operation.rejectStaleScreenOperation("pre-commit"), false);
  assert.ok(operation.screenGenerationLease);
  const commit = runtime.commitGeneration(
    operation.screenGenerationLease,
    operation.trace.id,
    options
  );
  operation.commitFinal(
    commit,
    { reason: "authorized" },
    commit.committed ? commit.value : undefined
  );
  runtime.store.finishTrace(operation.trace.id, "success");
  return commit;
}

/**
 * A stale rejection that follows the final commit, with the Screen writes in
 * the Hook's own order: the pre-visible-commit guard passes, the derived
 * commit, its projection write and the final root write run, and the trace is
 * still running when the error boundary rejects the operation. `change` is
 * what made the Token stale in between. It is applied to the world directly:
 * the Hook reaches that call from its catch block, after a thrown error and
 * the catch block's own generation terminalization, which are not replayed.
 */
function rejectStaleAfterFinalCommit(
  screenOperationId: string,
  change: (world: World) => void,
  options: { candidateAccepted?: boolean } = {}
) {
  const runtime = createRuntime();
  const operation = admitScreenOperation(runtime, screenOperationId);
  assert.equal(operation.rejectStaleScreenOperation("pre-visible-commit"), false);
  assert.ok(operation.screenGenerationLease);
  const commit = runtime.commitGeneration(
    operation.screenGenerationLease,
    operation.trace.id,
    options
  );
  operation.commitFinal(
    commit,
    { reason: "authorized" },
    commit.committed ? commit.value : undefined
  );
  const atFinalCommit = runtime.exported(operation.trace.id);
  assert.equal(atFinalCommit.status, "running");
  change(runtime.world);
  assert.equal(operation.rejectStaleScreenOperation("error-boundary"), true);
  return { atFinalCommit, trace: runtime.exported(operation.trace.id) };
}

// ---------------------------------------------------------------------------
// Summary helpers
// ---------------------------------------------------------------------------

type Groups = Pick<
  SessionCompactTraceSummary,
  "runtimeCommit" | "screenOperation" | "generationCommit"
>;

/** What the writer persists: undefined members are not serialized. */
const stored = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function compact(trace: MeetingTrace) {
  return buildCompactTraceSummary({
    sessionId: "recording-a",
    trace,
    trigger: "manual",
    traceExportPath: `traces/${trace.id}.json`,
    summaryPath: `traces/${trace.id}/summary.json`,
  });
}

/** The stored summary's groups; a group that was not emitted has no key. */
function groupsOf(trace: MeetingTrace): Groups {
  const summary = compact(trace);
  return stored({
    runtimeCommit: summary.runtimeCommit,
    screenOperation: summary.screenOperation,
    generationCommit: summary.generationCommit,
  });
}

/** The Token group as the root states it, key by key. */
function rootRuntimeCommit(root: Record<string, unknown>) {
  return stored({
    operationId: root.runtimeOperationId,
    pipeline: root.runtimePipeline,
    stage: root.runtimeAuthorizationStage,
    authorized: root.runtimeCommitAuthorized,
    reason: root.runtimeCommitAuthorizationReason,
  });
}

function rootGenerationCommit(root: Record<string, unknown>) {
  return stored({
    ledgerEntryId: root.generationResultLedgerEntryId,
    disposition: root.generationResultCommitDisposition,
    reason: root.generationResultCommitReason,
  });
}

const GROUP_KEYS = ["runtimeCommit", "screenOperation", "generationCommit"] as const;

/** Each projected member and the one root key it may come from. */
const EVIDENCE_ROOT_KEYS = {
  runtimeCommit: {
    operationId: "runtimeOperationId",
    pipeline: "runtimePipeline",
    stage: "runtimeAuthorizationStage",
    authorized: "runtimeCommitAuthorized",
    reason: "runtimeCommitAuthorizationReason",
  },
  screenOperation: {
    operationId: "screenOperationId",
    disposition: "screenOperationDisposition",
    commitReason: "screenOperationCommitReason",
    supersededByOperationId: "supersededByScreenOperationId",
  },
  generationCommit: {
    ledgerEntryId: "generationResultLedgerEntryId",
    disposition: "generationResultCommitDisposition",
    reason: "generationResultCommitReason",
  },
} as const;
/** The member whose root key decides whether the group exists at all. */
const EVIDENCE_RESULT_MEMBER = {
  runtimeCommit: "authorized",
  screenOperation: "disposition",
  generationCommit: "disposition",
} as const;
/** A stable answer as the Screen final commit reads it. */
const SCREEN_STABLE_ANSWER = {
  sections: { code: { revision: 1 }, complexity: { revision: 1 } },
  suggestion: { content: "Answer" },
};

function withoutGroups<T extends object>(summary: T): T {
  const copy = { ...summary } as Record<string, unknown>;
  for (const key of GROUP_KEYS) delete copy[key];
  return copy as T;
}

function completedTrace(
  id: string,
  metadata: Record<string, unknown> = {},
  startedAt = Date.now()
): MeetingTrace {
  return {
    id,
    kind: "voice",
    status: "success",
    startedAt,
    endedAt: startedAt + 5,
    durationMs: 5,
    steps: [],
    inputs: [],
    outputs: [],
    metadata,
  };
}

function reportFor(
  traceSummaries: LongitudinalTraceSummary[],
  overrides: Partial<LongitudinalSessionInput> = {}
) {
  return buildSessionLongitudinalEvaluationReport([
    {
      directory: "fixture",
      manifest: { sessionId: "recording-a" },
      transcriptTurns: [],
      traceSummaries,
      questionEvaluations: [],
      ...overrides,
    },
  ]);
}

function diagnosticSection(markdown: string) {
  const start = markdown.indexOf("## Last Retained Runtime Evidence");
  assert.ok(start >= 0);
  return markdown.slice(start, markdown.indexOf("## Evidence Gaps"));
}

// ---------------------------------------------------------------------------
// OV152-1 original facts
// ---------------------------------------------------------------------------

test("OV152-1 Runtime Token: allowed, rejected and missing results equal the Voice trace root", () => {
  const runtime = createRuntime();

  const allowed = startVoiceAttempt(runtime, "job-allowed");
  assert.equal(allowed.rejectStaleCommit("pre-model"), false);
  runtime.store.finishTrace(allowed.trace.id, "success");
  const allowedTrace = runtime.exported(allowed.trace.id);
  assert.deepEqual(groupsOf(allowedTrace), {
    runtimeCommit: {
      operationId: "job-allowed",
      pipeline: "advisor",
      stage: "pre-model",
      authorized: true,
      reason: "authorized",
    },
  });
  assert.deepEqual(
    groupsOf(allowedTrace).runtimeCommit,
    rootRuntimeCommit(allowedTrace.metadata!)
  );

  const rejected = startVoiceAttempt(runtime, "job-rejected");
  runtime.world.parent = { id: "parent-a", revisions: 2 };
  assert.equal(rejected.rejectStaleCommit("pre-commit"), true);
  const rejectedTrace = runtime.exported(rejected.trace.id);
  assert.equal(rejectedTrace.status, "cancelled");
  const rejectedGroup = groupsOf(rejectedTrace).runtimeCommit;
  // `false` is a result and stays one.
  assert.equal(rejectedGroup?.authorized, false);
  assert.deepEqual(rejectedGroup, {
    operationId: "job-rejected",
    pipeline: "advisor",
    stage: "pre-commit",
    authorized: false,
    reason: "parent-revision-mismatch",
  });
  assert.deepEqual(rejectedGroup, rootRuntimeCommit(rejectedTrace.metadata!));

  // No authorization callback ran: nothing is provided, and nothing is derived
  // from the job, parent, Relation or question fields the root does carry.
  const silent = startVoiceAttempt(runtime, "job-silent");
  runtime.store.finishTrace(silent.trace.id, "success");
  const silentTrace = runtime.exported(silent.trace.id);
  assert.equal(silentTrace.metadata?.advisorJobId, "job-silent");
  assert.deepEqual(groupsOf(silentTrace), {});
  assert.equal("runtimeCommit" in stored(compact(silentTrace)), false);
});

test("OV152-1 Screen operation: committed, rejected, superseded and missing results equal the Screen trace root", () => {
  const committedRuntime = createRuntime();
  const committed = admitScreenOperation(committedRuntime, "screen-committed");
  assert.equal(finishScreenOperation(committedRuntime, committed).committed, true);
  const committedTrace = committedRuntime.exported(committed.trace.id);
  assert.equal(committedTrace.metadata?.screenOperationDisposition, "committed");
  assert.deepEqual(groupsOf(committedTrace).screenOperation, {
    operationId: "screen-committed",
    disposition: "committed",
    commitReason: committedTrace.metadata?.screenOperationCommitReason,
  });
  assert.equal(groupsOf(committedTrace).screenOperation?.commitReason, "authorized");

  const rejectedRuntime = createRuntime();
  const rejected = admitScreenOperation(rejectedRuntime, "screen-rejected");
  const rejectedCommit = finishScreenOperation(rejectedRuntime, rejected, {
    candidateAccepted: false,
  });
  assert.equal(rejectedCommit.committed, false);
  const rejectedTrace = rejectedRuntime.exported(rejected.trace.id);
  assert.deepEqual(groupsOf(rejectedTrace).screenOperation, {
    operationId: "screen-rejected",
    disposition: "rejected",
    commitReason: "candidate-not-accepted",
  });
  assert.equal(
    rejectedTrace.metadata?.screenOperationCommitReason,
    "candidate-not-accepted"
  );

  const supersededRuntime = createRuntime();
  const first = admitScreenOperation(supersededRuntime, "screen-first");
  const second = admitScreenOperation(supersededRuntime, "screen-second");
  assert.equal(first.rejectStaleScreenOperation("post-capture"), true);
  const firstTrace = supersededRuntime.exported(first.trace.id);
  assert.equal(firstTrace.status, "cancelled");
  assert.equal(firstTrace.metadata?.supersededByScreenOperationId, "screen-second");
  assert.deepEqual(groupsOf(firstTrace).screenOperation, {
    operationId: "screen-first",
    disposition: "superseded",
    supersededByOperationId: "screen-second",
  });
  supersededRuntime.store.finishTrace(second.trace.id, "success");

  // Admitted and authorized, but no disposition was ever written: the group is
  // not invented from the operation id the root does have.
  const openRuntime = createRuntime();
  const open = admitScreenOperation(openRuntime, "screen-open", { lease: false });
  assert.equal(open.rejectStaleScreenOperation("post-capture"), false);
  openRuntime.store.finishTrace(open.trace.id, "error", "capture failed");
  const openTrace = openRuntime.exported(open.trace.id);
  assert.equal(openTrace.metadata?.screenOperationId, "screen-open");
  assert.equal(openTrace.metadata?.screenOperationDisposition, undefined);
  assert.equal(groupsOf(openTrace).screenOperation, undefined);
  assert.equal(groupsOf(openTrace).runtimeCommit?.authorized, true);
});

test("OV152-1 Generation commit: committed, rejected, cancelled, unfinished and missing results equal the trace root", () => {
  const runtime = createRuntime();
  const traceFor = (label: string) =>
    runtime.store.startTrace("voice", { advisorJobId: label });
  const finished = (traceId: string) => {
    runtime.store.finishTrace(traceId, "success");
    return runtime.exported(traceId);
  };

  const committedTrace = traceFor("committed");
  const committedLease = runtime.beginGeneration(committedTrace.id);
  assert.equal(runtime.commitGeneration(committedLease, committedTrace.id).committed, true);
  const committed = finished(committedTrace.id);
  assert.deepEqual(groupsOf(committed).generationCommit, {
    ledgerEntryId: `generation_result:${committedLease.id}`,
    disposition: "committed",
    reason: "authorized",
  });

  const rejectedTrace = traceFor("rejected");
  const rejectedLease = runtime.beginGeneration(rejectedTrace.id);
  runtime.world.manualCorrectionRevision += 1;
  assert.equal(runtime.commitGeneration(rejectedLease, rejectedTrace.id).committed, false);
  const rejected = finished(rejectedTrace.id);
  assert.deepEqual(groupsOf(rejected).generationCommit, {
    ledgerEntryId: `generation_result:${rejectedLease.id}`,
    disposition: "rejected",
    reason: "manual-correction-revision-mismatch",
  });

  const cancelledTrace = traceFor("cancelled");
  const cancelledLease = runtime.beginGeneration(cancelledTrace.id);
  runtime.terminalizeGenerationLease({
    lease: cancelledLease,
    disposition: "cancelled",
    reason: "newer-advisor-job",
    source: "advisor-supersession",
    authority: "advisor-job-owner",
    traceId: cancelledTrace.id,
  });
  const cancelled = finished(cancelledTrace.id);
  assert.deepEqual(groupsOf(cancelled).generationCommit, {
    ledgerEntryId: `generation_result:${cancelledLease.id}`,
    disposition: "cancelled",
    reason: "newer-advisor-job",
  });

  // started/pending are the producer's own unfinished observations.
  const startedTrace = traceFor("started");
  const startedLease = runtime.beginGeneration(startedTrace.id);
  const started = finished(startedTrace.id);
  assert.deepEqual(groupsOf(started).generationCommit, {
    ledgerEntryId: `generation_result:${startedLease.id}`,
    disposition: "started",
    reason: "generation-started",
  });
  const pendingTrace = traceFor("pending");
  const pendingLease = runtime.beginGeneration(pendingTrace.id);
  runtime.markGenerationPending(pendingLease, pendingTrace.id);
  const pending = finished(pendingTrace.id);
  assert.deepEqual(groupsOf(pending).generationCommit, {
    ledgerEntryId: `generation_result:${pendingLease.id}`,
    disposition: "pending",
    reason: "delivery-lock-active",
  });

  for (const trace of [committed, rejected, cancelled, started, pending]) {
    assert.deepEqual(
      groupsOf(trace).generationCommit,
      rootGenerationCommit(trace.metadata!)
    );
    assert.equal(groupsOf(trace).runtimeCommit, undefined);
    assert.equal(groupsOf(trace).screenOperation, undefined);
  }

  // The real projection write with no ledger entry leaves no result on the
  // root. The group is absent; it is not a failure and not a commit.
  const missingTrace = traceFor("missing");
  runtime.publishGenerationResultProjection(runtime.createLease(), missingTrace.id);
  const missing = finished(missingTrace.id);
  assert.equal("generationResultCommitDisposition" in missing.metadata!, true);
  assert.equal(missing.metadata?.generationResultCommitDisposition, undefined);
  assert.equal(groupsOf(missing).generationCommit, undefined);
});

// ---------------------------------------------------------------------------
// OV152-2 no cross-source stitching
// ---------------------------------------------------------------------------

test("OV152-2 multi-stage and multi-pipeline: the group is the last root write, never a step value", () => {
  const runtime = createRuntime();
  const attempt = startVoiceAttempt(runtime, "job-stages");
  const memoryStep = runtime.store.startStep(attempt.trace.id, "Memory retrieval");
  assert.equal(attempt.rejectStaleCommit("pre-memory"), false);

  // The memory pipeline is rejected and, as in the Hook, records the decision
  // on the root and on its cancelled step.
  const memoryDecision = authorizeRuntimeCommit({
    token: { ...attempt.token, pipeline: "memory" },
    current: runtime.readRuntimeCommitSnapshot(),
    currentOperationId: "another-memory-owner",
  });
  const memoryMetadata = formatRuntimeCommitAuthorizationForTrace(
    memoryDecision,
    "post-memory"
  );
  runtime.store.updateMetadata(attempt.trace.id, memoryMetadata);
  runtime.store.finishStep(attempt.trace.id, memoryStep, "cancelled", memoryMetadata);
  const afterMemory = runtime.exported(attempt.trace.id);
  assert.deepEqual(stored(compact(afterMemory)).runtimeCommit, {
    operationId: "job-stages",
    pipeline: "memory",
    stage: "post-memory",
    authorized: false,
    reason: "pipeline-owner-mismatch",
  });

  // A later advisor stage is allowed. Every field now comes from that write;
  // the step still holds the earlier memory rejection.
  assert.equal(attempt.rejectStaleCommit("pre-commit"), false);
  runtime.store.finishTrace(attempt.trace.id, "success");
  const trace = runtime.exported(attempt.trace.id);
  assert.equal(trace.steps[0]?.metadata?.runtimeCommitAuthorized, false);
  assert.equal(trace.steps[0]?.metadata?.runtimeAuthorizationStage, "post-memory");
  assert.deepEqual(groupsOf(trace).runtimeCommit, {
    operationId: "job-stages",
    pipeline: "advisor",
    stage: "pre-commit",
    authorized: true,
    reason: "authorized",
  });
});

test("OV152-2 a root without the field keeps it missing although a step holds an older value", () => {
  const runtime = createRuntime();
  const attempt = startVoiceAttempt(runtime, "job-step-only", { lease: true });
  const step = runtime.store.startStep(attempt.trace.id, "Advisor model response");
  runtime.world.parent = { id: "parent-b", revisions: 1 };
  const decision = authorizeRuntimeCommit({
    token: attempt.token,
    current: runtime.readRuntimeCommitSnapshot(),
    currentOperationId: "job-step-only",
  });
  assert.equal(decision.reason, "parent-id-mismatch");
  // Only steps carry results; the root has none of the three result keys.
  runtime.store.finishStep(attempt.trace.id, step, "cancelled", {
    ...formatRuntimeCommitAuthorizationForTrace(decision, "partial-output"),
    ...formatGenerationResultLedgerForTrace(runtime.ledger.getEntry(attempt.lease!.id)),
    screenOperationId: "screen-in-step",
    screenOperationDisposition: "committed",
    screenOperationCommitReason: "authorized",
    supersededByScreenOperationId: "screen-older-superseder",
  });
  runtime.store.updateMetadata(attempt.trace.id, {
    generationResultLedgerEntryId: undefined,
    generationResultCommitDisposition: undefined,
    generationResultCommitReason: undefined,
  });
  runtime.store.finishTrace(attempt.trace.id, "cancelled", decision.reason);
  // As exported: a root key without a value is absent from the Trace file.
  const stepOnly = stored(runtime.exported(attempt.trace.id));
  for (const key of [
    "runtimeCommitAuthorized",
    "screenOperationDisposition",
    "generationResultCommitDisposition",
    "generationResultLedgerEntryId",
  ]) {
    assert.equal(key in stepOnly.metadata!, false, key);
    assert.equal(key in stepOnly.steps[0]!.metadata!, true, key);
  }
  assert.equal(stepOnly.steps[0]?.metadata?.runtimeCommitAuthorized, false);
  assert.equal(stepOnly.steps[0]?.metadata?.generationResultCommitDisposition, "started");
  assert.deepEqual(groupsOf(stepOnly), {});

  // The root has the result but lost its reason, stage and identity. The step
  // values are older observations of another moment and are not borrowed.
  const partialRoot = { ...stepOnly.metadata };
  partialRoot.runtimeCommitAuthorized = true;
  partialRoot.generationResultCommitDisposition = "committed";
  partialRoot.screenOperationDisposition = "rejected";
  const partial = { ...stepOnly, metadata: partialRoot };
  assert.deepEqual(groupsOf(partial), {
    runtimeCommit: { authorized: true },
    screenOperation: { disposition: "rejected" },
    generationCommit: { disposition: "committed" },
  });
  // A superseded root without its reference does not take the step's.
  assert.deepEqual(
    groupsOf({
      ...partial,
      metadata: { ...partialRoot, screenOperationDisposition: "superseded" },
    }).screenOperation,
    { disposition: "superseded" }
  );
});

test("OV152-2 Token allowed while Screen is rejected by the lease: no reason crosses families", () => {
  const runtime = createRuntime();
  const operation = admitScreenOperation(runtime, "screen-lease");
  runtime.world.visibleAnswerRevision += 1;
  assert.equal(operation.rejectStaleScreenOperation("generation-lease-start"), true);
  const trace = runtime.exported(operation.trace.id);
  const root = trace.metadata!;
  assert.equal(root.runtimeCommitAuthorized, true);
  assert.equal(root.runtimeCommitAuthorizationReason, "authorized");
  assert.equal(root.screenOperationDisposition, "stale-rejected");
  assert.equal(root.staleReason, "visible-answer-revision-mismatch");

  assert.deepEqual(groupsOf(trace), {
    runtimeCommit: {
      operationId: "screen-lease",
      pipeline: "screen",
      stage: "generation-lease-start",
      authorized: true,
      reason: "authorized",
    },
    // Its own disposition, without the Token's "authorized", the lease's stale
    // reason or the generation's rejection reason.
    screenOperation: { operationId: "screen-lease", disposition: "stale-rejected" },
    generationCommit: {
      ledgerEntryId: `generation_result:${operation.screenGenerationLease!.id}`,
      disposition: "rejected",
      reason: "visible-answer-revision-mismatch",
    },
  });

  // Voice: the Token is allowed, the lease rejects the job. The adjacent
  // advisorJobCommitAuthorized=false does not rewrite the Token result.
  const voiceRuntime = createRuntime();
  const attempt = startVoiceAttempt(voiceRuntime, "job-lease", { lease: true });
  voiceRuntime.world.responseActionRevision += 1;
  assert.equal(attempt.rejectStaleCommit("pre-commit"), true);
  const voice = voiceRuntime.exported(attempt.trace.id);
  assert.equal(voice.metadata?.advisorJobCommitAuthorized, false);
  assert.deepEqual(groupsOf(voice), {
    runtimeCommit: {
      operationId: "job-lease",
      pipeline: "advisor",
      stage: "pre-commit",
      authorized: true,
      reason: "authorized",
    },
    generationCommit: {
      ledgerEntryId: `generation_result:${attempt.lease!.id}`,
      disposition: "rejected",
      reason: "response-action-revision-mismatch",
    },
  });
});

test("OV152-2 superseded keeps only the superseding operation; a residual commitReason or reference is dropped", () => {
  // A commits, and is superseded before it releases the coordinator.
  const runtime = createRuntime();
  const first = admitScreenOperation(runtime, "screen-a");
  finishScreenOperation(runtime, first);
  assert.equal(
    groupsOf(runtime.exported(first.trace.id)).screenOperation?.commitReason,
    "authorized"
  );
  const second = admitScreenOperation(runtime, "screen-b");
  const superseded = runtime.exported(first.trace.id);
  assert.equal(superseded.metadata?.screenOperationDisposition, "superseded");
  assert.equal(superseded.metadata?.screenOperationCommitReason, "authorized");
  assert.deepEqual(groupsOf(superseded).screenOperation, {
    operationId: "screen-a",
    disposition: "superseded",
    supersededByOperationId: "screen-b",
  });
  // The other two families still report their own last results.
  assert.equal(groupsOf(superseded).runtimeCommit?.authorized, true);
  assert.equal(groupsOf(superseded).generationCommit?.disposition, "committed");

  // B is superseded by C, then rejected for a stale runtime epoch. The earlier
  // superseding reference belongs to the superseded disposition, not this one.
  admitScreenOperation(runtime, "screen-c");
  runtime.world.runtimeEpoch += 1;
  assert.equal(second.rejectStaleScreenOperation("post-model"), true);
  const stale = runtime.exported(second.trace.id);
  assert.equal(stale.metadata?.supersededByScreenOperationId, "screen-c");
  assert.equal(stale.metadata?.runtimeCommitAuthorizationReason, "runtime-epoch-mismatch");
  assert.deepEqual(groupsOf(stale).screenOperation, {
    operationId: "screen-b",
    disposition: "stale-rejected",
  });
  assert.equal(groupsOf(stale).runtimeCommit?.reason, "runtime-epoch-mismatch");
});

test("OV152-2 stale-rejected after the final commit drops the earlier commitReason and takes no Token reason", () => {
  // The fixture's order is the Hook's: the final commit write sits in the try
  // block whose catch holds the one "error-boundary" stale rejection.
  const finalCommitWrite = onlyHookNode(
    "Screen final commit write",
    isScreenFinalCommitWrite
  );
  let enclosing: ts.Node = finalCommitWrite;
  while (!ts.isTryStatement(enclosing)) enclosing = enclosing.parent;
  assert.ok(
    enclosing.tryBlock.getStart(hook) <= finalCommitWrite.getStart(hook) &&
      finalCommitWrite.getEnd() <= enclosing.tryBlock.getEnd()
  );
  assert.equal(
    enclosing.catchClause
      ?.getText(hook)
      .split('rejectStaleScreenOperation("error-boundary")').length,
    2
  );

  // Committed, then the runtime epoch moves while the trace is still running.
  const committed = rejectStaleAfterFinalCommit(
    "screen-committed-then-stale",
    (world) => {
      world.runtimeEpoch += 1;
    }
  );
  assert.deepEqual(groupsOf(committed.atFinalCommit).screenOperation, {
    operationId: "screen-committed-then-stale",
    disposition: "committed",
    commitReason: "authorized",
  });
  // Rejected by the derived commit, then the parent revision moves.
  const rejected = rejectStaleAfterFinalCommit(
    "screen-rejected-then-stale",
    (world) => {
      world.parent = { id: "parent-a", revisions: 2 };
    },
    { candidateAccepted: false }
  );
  assert.deepEqual(groupsOf(rejected.atFinalCommit).screenOperation, {
    operationId: "screen-rejected-then-stale",
    disposition: "rejected",
    commitReason: "candidate-not-accepted",
  });

  for (const { fixture, operationId, earlierCommitReason, tokenReason } of [
    {
      fixture: committed,
      operationId: "screen-committed-then-stale",
      earlierCommitReason: "authorized",
      tokenReason: "runtime-epoch-mismatch",
    },
    {
      fixture: rejected,
      operationId: "screen-rejected-then-stale",
      earlierCommitReason: "candidate-not-accepted",
      tokenReason: "parent-revision-mismatch",
    },
  ]) {
    const root = fixture.trace.metadata!;
    assert.equal(fixture.trace.status, "cancelled", operationId);
    // The stale rejection replaced the disposition. The final commit's reason
    // is still on the root, next to the Token's rejection reason.
    assert.equal(root.screenOperationDisposition, "stale-rejected", operationId);
    assert.equal(root.screenOperationCommitReason, earlierCommitReason, operationId);
    assert.equal("supersededByScreenOperationId" in root, false, operationId);
    assert.equal(root.runtimeAuthorizationStage, "error-boundary", operationId);
    assert.equal(root.runtimeCommitAuthorized, false, operationId);
    assert.equal(root.runtimeCommitAuthorizationReason, tokenReason, operationId);

    const groups = groupsOf(fixture.trace);
    // Exactly its own identity and disposition: the earlier disposition's
    // reason does not describe this one, and neither does the Token's.
    assert.deepEqual(
      groups.screenOperation,
      { operationId, disposition: "stale-rejected" },
      operationId
    );
    assert.deepEqual(
      Object.keys(groups.screenOperation!),
      ["operationId", "disposition"],
      operationId
    );
    for (const value of Object.values(groups.screenOperation!)) {
      assert.notEqual(value, earlierCommitReason, operationId);
      assert.notEqual(value, tokenReason, operationId);
    }
    // The other two families still state their own last root write.
    assert.deepEqual(groups.runtimeCommit, rootRuntimeCommit(root), operationId);
    assert.equal(groups.runtimeCommit?.reason, tokenReason, operationId);
    assert.deepEqual(groups.generationCommit, rootGenerationCommit(root), operationId);
  }
});

test("OV152-2 multi-operation: superseding and superseded Screen traces keep their own identity", () => {
  const runtime = createRuntime();
  const first = admitScreenOperation(runtime, "screen-old");
  const second = admitScreenOperation(runtime, "screen-new");
  assert.equal(first.rejectStaleScreenOperation("post-preflight"), true);
  finishScreenOperation(runtime, second);

  const oldGroups = groupsOf(runtime.exported(first.trace.id));
  const newTrace = runtime.exported(second.trace.id);
  const newGroups = groupsOf(newTrace);
  assert.equal(newTrace.metadata?.supersedesScreenOperationId, "screen-old");
  assert.deepEqual(newGroups.screenOperation, {
    operationId: "screen-new",
    disposition: "committed",
    commitReason: "authorized",
  });
  assert.deepEqual(oldGroups.screenOperation, {
    operationId: "screen-old",
    disposition: "superseded",
    supersededByOperationId: "screen-new",
  });
  assert.deepEqual(oldGroups.runtimeCommit, {
    operationId: "screen-old",
    pipeline: "screen",
    stage: "post-preflight",
    authorized: false,
    reason: "pipeline-owner-mismatch",
  });
  assert.equal(oldGroups.generationCommit?.disposition, "superseded");
  assert.equal(newGroups.generationCommit?.disposition, "committed");
  assert.notEqual(
    oldGroups.generationCommit?.ledgerEntryId,
    newGroups.generationCommit?.ledgerEntryId
  );

  // A is superseded by B, and B by C before A's callback runs. A keeps the
  // operation that superseded it, not whichever operation is active now.
  const chain = createRuntime();
  const a = admitScreenOperation(chain, "screen-a", { lease: false });
  admitScreenOperation(chain, "screen-b", { lease: false });
  admitScreenOperation(chain, "screen-c", { lease: false });
  assert.equal(a.rejectStaleScreenOperation("post-model"), true);
  const aTrace = chain.exported(a.trace.id);
  assert.equal(aTrace.metadata?.activeScreenOperationId, "screen-c");
  assert.deepEqual(groupsOf(aTrace).screenOperation, {
    operationId: "screen-a",
    disposition: "superseded",
    supersededByOperationId: "screen-b",
  });

  // The owner is gone without a successor: superseded, with no reference to
  // invent from the Token. Nothing is active here.
  const orphan = createRuntime();
  const lost = admitScreenOperation(orphan, "screen-lost", { lease: false });
  orphan.screens.reset();
  assert.equal(lost.rejectStaleScreenOperation("post-model"), true);
  const lostTrace = orphan.exported(lost.trace.id);
  assert.equal(lostTrace.metadata?.screenOperationDisposition, "superseded");
  assert.equal(lostTrace.metadata?.supersededByScreenOperationId, undefined);
  assert.equal(lostTrace.metadata?.activeScreenOperationId, null);
  assert.deepEqual(groupsOf(lostTrace).screenOperation, {
    operationId: "screen-lost",
    disposition: "superseded",
  });

  // The owner is reset and another operation claims afterwards. That claim
  // superseded nothing, so no supersede write reached this trace: the root
  // names the active operation but no superseding one, and none is invented.
  const reclaimed = createRuntime();
  const dropped = admitScreenOperation(reclaimed, "screen-dropped", { lease: false });
  reclaimed.screens.reset();
  const successor = admitScreenOperation(reclaimed, "screen-successor", { lease: false });
  assert.equal(
    reclaimed.exported(successor.trace.id).metadata?.supersedesScreenOperationId,
    undefined
  );
  assert.equal(dropped.rejectStaleScreenOperation("post-model"), true);
  const droppedRoot = reclaimed.exported(dropped.trace.id).metadata!;
  assert.equal(droppedRoot.screenOperationDisposition, "superseded");
  assert.equal(droppedRoot.activeScreenOperationId, "screen-successor");
  assert.equal("supersededByScreenOperationId" in droppedRoot, false);
  assert.deepEqual(groupsOf(reclaimed.exported(dropped.trace.id)).screenOperation, {
    operationId: "screen-dropped",
    disposition: "superseded",
  });

  // Two generations on one trace: the group is the last projection write, with
  // all three fields from that one ledger entry.
  const generations = createRuntime();
  const voice = generations.store.startTrace("voice", {});
  const firstLease = generations.beginGeneration(voice.id);
  generations.terminalizeGenerationLease({
    lease: firstLease,
    disposition: "aborted",
    reason: "provider-aborted",
    source: "advisor-runtime",
    authority: "advisor-job-owner",
    traceId: voice.id,
  });
  assert.equal(
    groupsOf(generations.exported(voice.id)).generationCommit?.reason,
    "provider-aborted"
  );
  const secondLease = generations.beginGeneration(voice.id);
  generations.commitGeneration(secondLease, voice.id);
  generations.store.finishTrace(voice.id, "success");
  assert.deepEqual(groupsOf(generations.exported(voice.id)).generationCommit, {
    ledgerEntryId: `generation_result:${secondLease.id}`,
    disposition: "committed",
    reason: "authorized",
  });
});

test("OV152-2 identity is never filled from the job, parent, Relation, lease or another family", () => {
  const runtime = createRuntime();
  // An operation without an identity: the formatter writes an empty id.
  const attempt = startVoiceAttempt(runtime, "job-anonymous", {
    lease: true,
    operationId: "",
  });
  runtime.world.activeAdvisorJobId = "";
  assert.equal(attempt.rejectStaleCommit("pre-commit"), true);
  const anonymous = runtime.exported(attempt.trace.id);
  assert.equal(anonymous.metadata?.advisorJobId, "job-anonymous");
  assert.equal(anonymous.metadata?.activeMeetingParentId, "parent-a");
  const anonymousGroup = groupsOf(anonymous).runtimeCommit;
  assert.equal(anonymousGroup?.operationId, undefined);
  assert.equal(anonymousGroup?.authorized, false);
  assert.equal(anonymousGroup?.reason, "pipeline-owner-mismatch");

  // A Screen root that lost its operation id and a generation root that lost
  // its ledger entry id. The Token's operationId is the same Screen operation
  // and the lease id names the same generation; neither is used.
  const screenRuntime = createRuntime();
  const operation = admitScreenOperation(screenRuntime, "screen-identity");
  finishScreenOperation(screenRuntime, operation);
  const complete = screenRuntime.exported(operation.trace.id);
  const { screenOperationId, generationResultLedgerEntryId, ...root } =
    complete.metadata!;
  assert.equal(screenOperationId, "screen-identity");
  assert.equal(root.runtimeOperationId, "screen-identity");
  assert.equal(
    generationResultLedgerEntryId,
    `generation_result:${root.answerGenerationLeaseId}`
  );
  assert.deepEqual(groupsOf({ ...complete, metadata: root }), {
    runtimeCommit: groupsOf(complete).runtimeCommit,
    screenOperation: { disposition: "committed", commitReason: "authorized" },
    generationCommit: { disposition: "committed", reason: "authorized" },
  });
});

test("OV152-2 a family whose own result key is absent stays absent although an adjacent result sits on the same root", () => {
  // Voice, selected question released: the Hook cancels the job with
  // commitAuthorized=false and never writes a Token result. The job's pair is
  // not a Token result; the lease it released keeps its own rejection.
  const runtime = createRuntime();
  const released = startVoiceAttempt(runtime, "job-released", {
    lease: true,
    selectedQuestionOnly: true,
  });
  released.selection.held = false;
  assert.equal(released.rejectStaleCommit("pre-commit"), true);
  const releasedTrace = runtime.exported(released.trace.id);
  const releasedRoot = releasedTrace.metadata!;
  assert.equal(releasedTrace.status, "cancelled");
  assert.equal(releasedRoot.publicationRejectionReason, "selected-question-released");
  assert.equal(releasedRoot.advisorJobCommitAuthorized, false);
  assert.equal(releasedRoot.advisorJobCommitAuthorizationReason, "selected-question-released");
  assert.equal("runtimeCommitAuthorized" in releasedRoot, false);
  assert.deepEqual(groupsOf(releasedTrace), {
    generationCommit: {
      ledgerEntryId: `generation_result:${released.lease!.id}`,
      disposition: "rejected",
      reason: "selected-question-released",
    },
  });

  // Allowed at one stage, released at a later one: the last retained Token
  // result is still the allowed one. The release is not a Token rejection.
  const later = startVoiceAttempt(runtime, "job-released-later", {
    selectedQuestionOnly: true,
  });
  assert.equal(later.rejectStaleCommit("pre-model"), false);
  later.selection.held = false;
  assert.equal(later.rejectStaleCommit("pre-commit"), true);
  const laterTrace = runtime.exported(later.trace.id);
  assert.equal(laterTrace.metadata?.advisorJobCommitAuthorized, false);
  assert.deepEqual(groupsOf(laterTrace), {
    runtimeCommit: {
      operationId: "job-released-later",
      pipeline: "advisor",
      stage: "pre-model",
      authorized: true,
      reason: "authorized",
    },
  });

  // Screen, partial-output guard: the Hook writes Token=false and returns
  // without any Screen disposition. No disposition is invented from the
  // rejected Token and the operation id; the generation stays unfinished.
  const screenRuntime = createRuntime();
  const partial = admitScreenOperation(screenRuntime, "screen-partial");
  screenRuntime.world.runtimeEpoch += 1;
  partial.partialOutput();
  screenRuntime.store.finishTrace(partial.trace.id, "cancelled", "aborted");
  const partialTrace = screenRuntime.exported(partial.trace.id);
  assert.equal(partialTrace.metadata?.screenOperationId, "screen-partial");
  assert.equal("screenOperationDisposition" in partialTrace.metadata!, false);
  assert.deepEqual(groupsOf(partialTrace), {
    runtimeCommit: {
      operationId: "screen-partial",
      pipeline: "screen",
      stage: "partial-output",
      authorized: false,
      reason: "runtime-epoch-mismatch",
    },
    generationCommit: {
      ledgerEntryId: `generation_result:${partial.screenGenerationLease!.id}`,
      disposition: "started",
      reason: "generation-started",
    },
  });
  // An authorized partial output writes nothing at all.
  const quietRuntime = createRuntime();
  const quiet = admitScreenOperation(quietRuntime, "screen-quiet", { lease: false });
  quiet.partialOutput();
  assert.equal(
    "runtimeCommitAuthorized" in quietRuntime.exported(quiet.trace.id).metadata!,
    false
  );

  // Screen committed with no generation result on the root: the generation
  // group is not derived from the Screen commit or the Token.
  const bareRuntime = createRuntime();
  const bare = admitScreenOperation(bareRuntime, "screen-no-generation", { lease: false });
  assert.equal(bare.rejectStaleScreenOperation("pre-commit"), false);
  bare.commitFinal(undefined, { reason: "authorized" }, SCREEN_STABLE_ANSWER);
  bareRuntime.store.finishTrace(bare.trace.id, "success");
  const bareTrace = bareRuntime.exported(bare.trace.id);
  assert.equal("generationResultCommitDisposition" in bareTrace.metadata!, false);
  assert.deepEqual(groupsOf(bareTrace), {
    runtimeCommit: {
      operationId: "screen-no-generation",
      pipeline: "screen",
      stage: "pre-commit",
      authorized: true,
      reason: "authorized",
    },
    screenOperation: {
      operationId: "screen-no-generation",
      disposition: "committed",
      commitReason: "authorized",
    },
  });
});

/** Real roots that hold all the keys a wrong projector could borrow from. */
function evidenceRichTraces() {
  // Voice: the Token is rejected; the job's pair and the generation's
  // rejection and terminal reason sit next to it.
  const tokenRuntime = createRuntime();
  const tokenRejected = startVoiceAttempt(tokenRuntime, "job-token-rejected", { lease: true });
  tokenRuntime.world.parent = { id: "parent-a", revisions: 2 };
  assert.equal(tokenRejected.rejectStaleCommit("pre-commit"), true);

  // Voice: the Token is allowed and the generation lease rejects.
  const leaseRuntime = createRuntime();
  const leaseRejected = startVoiceAttempt(leaseRuntime, "job-lease-rejected", { lease: true });
  leaseRuntime.world.responseActionRevision += 1;
  assert.equal(leaseRejected.rejectStaleCommit("pre-commit"), true);

  // Screen: A commits; B supersedes it before it releases (A keeps a residual
  // commitReason); C supersedes B and B is then rejected for a stale epoch
  // (B keeps a residual superseding reference).
  const screenRuntime = createRuntime();
  const first = admitScreenOperation(screenRuntime, "screen-a");
  finishScreenOperation(screenRuntime, first);
  const screenCommitted = screenRuntime.exported(first.trace.id);
  const second = admitScreenOperation(screenRuntime, "screen-b");
  const screenSupersededResidual = screenRuntime.exported(first.trace.id);
  admitScreenOperation(screenRuntime, "screen-c");
  screenRuntime.world.runtimeEpoch += 1;
  assert.equal(second.rejectStaleScreenOperation("post-model"), true);

  // Screen: A is superseded by B and B by C before A's own callback runs. The
  // root names both the operation that superseded it and the active one.
  const chainRuntime = createRuntime();
  const chained = admitScreenOperation(chainRuntime, "screen-a");
  admitScreenOperation(chainRuntime, "screen-b");
  admitScreenOperation(chainRuntime, "screen-c");
  assert.equal(chained.rejectStaleScreenOperation("post-model"), true);

  // Screen: the Token is allowed and the lease rejects the operation.
  const staleRuntime = createRuntime();
  const leaseStale = admitScreenOperation(staleRuntime, "screen-lease");
  staleRuntime.world.visibleAnswerRevision += 1;
  assert.equal(leaseStale.rejectStaleScreenOperation("generation-lease-start"), true);

  // Voice: the Token is allowed and the generation result is unfinished, as
  // beginGeneration (started) and markGenerationPending (pending) leave it.
  const unfinishedRuntime = createRuntime();
  const generationStarted = startVoiceAttempt(unfinishedRuntime, "job-generation-started", { lease: true });
  assert.equal(generationStarted.rejectStaleCommit("pre-model"), false);
  unfinishedRuntime.store.finishTrace(generationStarted.trace.id, "success");
  const generationPending = startVoiceAttempt(unfinishedRuntime, "job-generation-pending", { lease: true });
  assert.equal(generationPending.rejectStaleCommit("pre-model"), false);
  unfinishedRuntime.markGenerationPending(generationPending.lease!, generationPending.trace.id);
  unfinishedRuntime.store.finishTrace(generationPending.trace.id, "success");

  // Screen: the final commit rejects the candidate.
  const rejectedRuntime = createRuntime();
  const screenRejected = admitScreenOperation(rejectedRuntime, "screen-rejected");
  finishScreenOperation(rejectedRuntime, screenRejected, { candidateAccepted: false });

  // Screen: the final commit wrote committed (or rejected) with its reason and
  // the error boundary then rejected the operation as stale. The root keeps
  // the earlier disposition's commitReason as a residual.
  const staleAfterCommit = rejectStaleAfterFinalCommit("screen-committed-then-stale", (world) => {
    world.runtimeEpoch += 1;
  });
  const staleAfterRejection = rejectStaleAfterFinalCommit(
    "screen-rejected-then-stale",
    (world) => {
      world.parent = { id: "parent-a", revisions: 2 };
    },
    { candidateAccepted: false }
  );

  return {
    voiceTokenRejected: tokenRuntime.exported(tokenRejected.trace.id),
    voiceLeaseRejected: leaseRuntime.exported(leaseRejected.trace.id),
    voiceGenerationStarted: unfinishedRuntime.exported(generationStarted.trace.id),
    voiceGenerationPending: unfinishedRuntime.exported(generationPending.trace.id),
    screenCommitted,
    screenRejected: rejectedRuntime.exported(screenRejected.trace.id),
    screenSupersededResidual,
    screenStaleRejected: screenRuntime.exported(second.trace.id),
    screenChainSuperseded: chainRuntime.exported(chained.trace.id),
    screenLeaseRejected: staleRuntime.exported(leaseStale.trace.id),
    screenStaleAfterCommit: staleAfterCommit.trace,
    screenStaleAfterRejection: staleAfterRejection.trace,
  };
}

test("OV152-2 removing one root key removes exactly that member: nothing is filled from an adjacent key, another family or a step", () => {
  const traces = evidenceRichTraces();
  const root = (label: keyof typeof traces) => traces[label].metadata!;

  // The keys a wrong projector could fall back to are really on these roots.
  assert.equal(root("voiceTokenRejected").runtimeCommitAuthorized, false);
  assert.equal(root("voiceTokenRejected").advisorJobCommitAuthorized, false);
  assert.equal(root("voiceTokenRejected").advisorJobSource, "live-turn");
  assert.equal(root("voiceTokenRejected").advisorJobCommitAuthorizationReason, "parent-revision-mismatch");
  assert.equal(root("voiceTokenRejected").generationResultTerminalReason, "parent-revision-mismatch");
  assert.equal(root("voiceTokenRejected").generationResultTerminalDisposition, "rejected");
  assert.equal(root("voiceLeaseRejected").runtimeCommitAuthorized, true);
  assert.equal(root("voiceLeaseRejected").advisorJobCommitAuthorized, false);
  assert.equal(root("voiceLeaseRejected").leaseAuthorizedAtCommit, false);
  assert.equal(root("voiceLeaseRejected").staleCommitRejected, true);
  assert.equal(root("voiceLeaseRejected").staleReason, "response-action-revision-mismatch");
  assert.equal(root("screenCommitted").runtimeOperationId, "screen-a");
  assert.equal(root("screenCommitted").screenOperationId, "screen-a");
  assert.equal(root("screenCommitted").generationResultCommitReason, "authorized");
  assert.equal(typeof root("screenCommitted").answerGenerationLeaseId, "string");
  assert.equal(traces.screenCommitted.status, "success");
  assert.equal(root("screenSupersededResidual").screenOperationCommitReason, "authorized");
  assert.equal(root("screenSupersededResidual").supersededByScreenOperationId, "screen-b");
  assert.equal(root("screenStaleRejected").runtimeCommitAuthorized, false);
  assert.equal(root("screenStaleRejected").supersededByScreenOperationId, "screen-c");
  assert.equal(root("screenStaleRejected").activeScreenOperationId, "screen-c");
  assert.equal(root("screenChainSuperseded").supersededByScreenOperationId, "screen-b");
  assert.equal(root("screenChainSuperseded").activeScreenOperationId, "screen-c");
  assert.equal(root("screenLeaseRejected").runtimeCommitAuthorized, true);
  assert.equal(root("screenLeaseRejected").staleReason, "visible-answer-revision-mismatch");
  // An unfinished generation result keeps its own reason next to an allowed
  // Token whose reason a wrong projector could offer instead.
  assert.equal(root("voiceGenerationStarted").generationResultCommitReason, "generation-started");
  assert.equal(root("voiceGenerationStarted").runtimeCommitAuthorizationReason, "authorized");
  assert.equal(root("voiceGenerationPending").generationResultCommitReason, "delivery-lock-active");
  assert.equal(root("voiceGenerationPending").runtimeCommitAuthorizationReason, "authorized");
  assert.equal(root("screenRejected").screenOperationCommitReason, "candidate-not-accepted");
  assert.equal(root("screenRejected").generationResultCommitReason, "candidate-not-accepted");
  // A stale rejection after the final commit: the earlier commitReason and
  // the Token's rejection reason are both on the root.
  assert.equal(root("screenStaleAfterCommit").screenOperationCommitReason, "authorized");
  assert.equal(root("screenStaleAfterCommit").runtimeCommitAuthorizationReason, "runtime-epoch-mismatch");
  assert.equal(root("screenStaleAfterRejection").screenOperationCommitReason, "candidate-not-accepted");
  assert.equal(root("screenStaleAfterRejection").runtimeCommitAuthorizationReason, "parent-revision-mismatch");

  // What each root projects to, stated once and then varied below.
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(traces).map(([label, trace]) => {
        const groups = groupsOf(trace);
        return [
          label,
          [
            groups.runtimeCommit?.authorized,
            groups.screenOperation?.disposition,
            groups.generationCommit?.disposition,
          ],
        ];
      })
    ),
    {
      voiceTokenRejected: [false, undefined, "rejected"],
      voiceLeaseRejected: [true, undefined, "rejected"],
      voiceGenerationStarted: [true, undefined, "started"],
      voiceGenerationPending: [true, undefined, "pending"],
      screenCommitted: [true, "committed", "committed"],
      screenRejected: [true, "rejected", "rejected"],
      screenSupersededResidual: [true, "superseded", "committed"],
      screenStaleRejected: [false, "stale-rejected", "rejected"],
      screenChainSuperseded: [false, "superseded", "superseded"],
      screenLeaseRejected: [true, "stale-rejected", "rejected"],
      screenStaleAfterCommit: [false, "stale-rejected", "committed"],
      screenStaleAfterRejection: [false, "stale-rejected", "rejected"],
    }
  );

  // An older observation of every projected key, held by a step.
  const olderStep: MeetingTrace["steps"][number] = {
    id: "older-step",
    name: "Older observation",
    status: "cancelled",
    startedAt: 1,
    metadata: {
      runtimeOperationId: "older-operation",
      runtimePipeline: "memory",
      runtimeAuthorizationStage: "older-stage",
      runtimeCommitAuthorized: false,
      runtimeCommitAuthorizationReason: "session-mismatch",
      screenOperationId: "older-screen",
      screenOperationDisposition: "rejected",
      screenOperationCommitReason: "older-commit-reason",
      supersededByScreenOperationId: "older-superseder",
      generationResultLedgerEntryId: "generation_result:older",
      generationResultCommitDisposition: "failed",
      generationResultCommitReason: "older-generation-reason",
    },
  };

  let removals = 0;
  for (const [label, trace] of Object.entries(traces)) {
    const withStep = { ...trace, steps: [...trace.steps, olderStep] };
    const baseline = groupsOf(trace);
    assert.deepEqual(groupsOf(withStep), baseline, `${label}: a step changes no group`);
    for (const family of GROUP_KEYS) {
      for (const [member, rootKey] of Object.entries(EVIDENCE_ROOT_KEYS[family])) {
        if (trace.metadata![rootKey] === undefined) continue;
        const remaining = { ...trace.metadata };
        delete remaining[rootKey];
        // Exactly the member read from that key goes; the group goes only
        // when the key is its own result key. Every other member, in every
        // family, is what it was.
        const expected: Record<string, Record<string, unknown> | undefined> =
          structuredClone(baseline);
        if (member === EVIDENCE_RESULT_MEMBER[family]) delete expected[family];
        else delete expected[family]?.[member];
        assert.deepEqual(
          groupsOf({ ...withStep, metadata: remaining }),
          expected,
          `${label} without ${rootKey}`
        );
        removals++;
      }
    }
  }
  // 5 Token keys and 3 generation keys on all twelve roots, started and
  // pending included, and the Screen keys the eight Screen roots carry:
  // committed 3, rejected 3, superseded with a residual reason 4,
  // stale-rejected with a residual reference 3, chain superseded 3, lease
  // stale-rejected 2, and stale-rejected with a residual reason 3 twice.
  assert.equal(removals, 60 + 36 + 24);

  // Extra residual key pass. A key that only another disposition writes is
  // set on the root by hand, under a value that names itself as residual;
  // nothing else on the root changes. Where the real writes already left that
  // key, its value is replaced. The group does not carry it: the superseding
  // reference belongs to superseded alone and the commit reason to committed
  // and rejected alone. On a root without a Screen result the residual keys
  // form no group.
  const RESIDUAL_SUPERSEDER = "residual-superseding-operation";
  const RESIDUAL_COMMIT_REASON = "residual-commit-reason";
  const residualChecks: Record<string, number> = {};
  for (const [label, trace] of Object.entries(traces)) {
    const baseline = groupsOf(trace);
    const disposition = baseline.screenOperation?.disposition;
    const withResidual = (keys: Record<string, string>) =>
      groupsOf({ ...trace, metadata: { ...trace.metadata, ...keys } });
    const residual: Record<string, string> = {
      ...(disposition === "superseded"
        ? {}
        : { supersededByScreenOperationId: RESIDUAL_SUPERSEDER }),
      ...(disposition === "committed" || disposition === "rejected"
        ? {}
        : { screenOperationCommitReason: RESIDUAL_COMMIT_REASON }),
    };
    for (const [rootKey, value] of Object.entries(residual)) {
      assert.deepEqual(
        withResidual({ [rootKey]: value }),
        baseline,
        `${label} with a residual ${rootKey}`
      );
      const check = `${disposition ?? "no Screen result"}: ${rootKey}`;
      residualChecks[check] = (residualChecks[check] ?? 0) + 1;
    }
    assert.deepEqual(withResidual(residual), baseline, `${label} with every residual key`);
    // The same key is the root's own when the disposition is the one that
    // writes it, and then the group states that root value.
    if (disposition === "superseded") {
      assert.deepEqual(
        withResidual({ supersededByScreenOperationId: RESIDUAL_SUPERSEDER }).screenOperation,
        { ...baseline.screenOperation, supersededByOperationId: RESIDUAL_SUPERSEDER },
        label
      );
    }
    if (disposition === "committed" || disposition === "rejected") {
      assert.deepEqual(
        withResidual({ screenOperationCommitReason: RESIDUAL_COMMIT_REASON }).screenOperation,
        { ...baseline.screenOperation, commitReason: RESIDUAL_COMMIT_REASON },
        label
      );
    }
  }
  assert.deepEqual(residualChecks, {
    "no Screen result: supersededByScreenOperationId": 4,
    "no Screen result: screenOperationCommitReason": 4,
    "committed: supersededByScreenOperationId": 1,
    "rejected: supersededByScreenOperationId": 1,
    "superseded: screenOperationCommitReason": 2,
    "stale-rejected: supersededByScreenOperationId": 4,
    "stale-rejected: screenOperationCommitReason": 4,
  });
});

// ---------------------------------------------------------------------------
// OV152-3 round trip and history
// ---------------------------------------------------------------------------

const START_OPTIONS = {
  meetingSessionId: "meeting-a",
  settings: {
    codingModel: { enabled: false, provider: "", variables: {} },
    taxonomyAdjudication: { enabled: true, provider: "", variables: {} },
  } as unknown as MeetingAssistantSettings,
  providerSummary: {
    hasMainProvider: false,
    hasCodingProvider: false,
    hasTaxonomyAdjudicationProvider: false,
    hasSttProvider: false,
    mainSupportsImages: false,
    codingSupportsImages: false,
  },
};

/** Recorder I/O on a temporary directory, so the original reader can read it. */
class DiskRecording {
  folder = "";
  readonly writes: Array<{ relativePath: string; append: boolean; bytes: number }> = [];
  failWrite: (relativePath: string) => boolean = () => false;
  private barrierSerial = 0;
  private waiting = new Map<string, () => void>();
  constructor(readonly root: string) {}

  readonly invoke: SessionRecordingInvoke = async <T>(
    command: string,
    args: Record<string, unknown> = {}
  ) => {
    const folder = path.join(this.root, String(args.folderName));
    if (command === "start_meeting_session_recording") {
      this.folder = folder;
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, "manifest.json"), String(args.manifestPayload));
      return folder as T;
    }
    const relativePath = String(args.relativePath);
    const payload =
      command === "write_meeting_session_recording_base64"
        ? Buffer.from(String(args.base64Payload), "base64")
        : String(args.payload);
    if (this.failWrite(relativePath)) {
      throw new Error(`controlled write failure: ${relativePath}`);
    }
    const file = path.join(folder, relativePath);
    await mkdir(path.dirname(file), { recursive: true });
    if (args.append === true) await appendFile(file, payload);
    else await writeFile(file, payload);
    this.writes.push({
      relativePath,
      append: args.append === true,
      bytes: Buffer.byteLength(payload),
    });
    for (const [marker, release] of this.waiting) {
      if (relativePath === "timeline.jsonl" && String(payload).includes(marker)) {
        this.waiting.delete(marker);
        release();
      }
    }
    return file as T;
  };

  /** Resolves once every write accepted so far has reached the directory. */
  async drained(manager: SessionRecordingManager) {
    const marker = `ov152-barrier-${++this.barrierSerial}`;
    const reached = new Promise<void>((resolve) => this.waiting.set(marker, resolve));
    manager.recordCaptureLifecycle({ stage: marker });
    await reached;
  }

  async json<T>(relativePath: string) {
    return JSON.parse(await readFile(path.join(this.folder, relativePath), "utf8")) as T;
  }
}

async function fileHashes(root: string) {
  const hashes: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    hashes[path.relative(root, file)] = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  }
  return hashes;
}

/** One finished trace per family outcome, formed by the production write paths. */
function produceEvidenceTraces() {
  const runtime = createRuntime();
  const allowed = startVoiceAttempt(runtime, "job-allowed", { lease: true });
  assert.equal(allowed.rejectStaleCommit("pre-commit"), false);
  runtime.commitGeneration(allowed.lease!, allowed.trace.id);
  runtime.store.finishTrace(allowed.trace.id, "success");

  const pending = startVoiceAttempt(runtime, "job-pending", { lease: true });
  assert.equal(pending.rejectStaleCommit("pre-model"), false);
  runtime.markGenerationPending(pending.lease!, pending.trace.id);
  runtime.store.finishTrace(pending.trace.id, "success");

  const silent = startVoiceAttempt(runtime, "job-silent");
  runtime.store.finishTrace(silent.trace.id, "success");

  const screen = admitScreenOperation(runtime, "screen-committed");
  finishScreenOperation(runtime, screen);

  const rejected = startVoiceAttempt(runtime, "job-rejected", { lease: true });
  runtime.world.parent = { id: "parent-a", revisions: 9 };
  assert.equal(rejected.rejectStaleCommit("pre-commit"), true);

  return {
    allowed: runtime.exported(allowed.trace.id),
    pending: runtime.exported(pending.trace.id),
    silent: runtime.exported(silent.trace.id),
    screen: runtime.exported(screen.trace.id),
    rejected: runtime.exported(rejected.trace.id),
  };
}

test("OV152-3 real writer -> summary file, aggregate and journal -> original reader round trip", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-ov152-roundtrip-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const disk = new DiskRecording(root);
  const manager = new SessionRecordingManager(undefined, disk.invoke);
  await manager.start(START_OPTIONS);
  const traces = Object.values(produceEvidenceTraces());
  for (const trace of traces) manager.recordTrace(trace, "manual");

  // A confirmed Human Expected fact recorded by the same writer.
  const subject = {
    attemptId: traces[0]!.id,
    questionId: "question-a",
    traceIds: [traces[0]!.id],
    sourceTurnIds: ["turn-a"],
  };
  const event = createHumanGroundTruthEventV2({
    eventId: "ov152-truth",
    sessionId: "meeting-a",
    subject,
    source: "explicit-ui",
    sourceTraceId: traces[0]!.id,
    fact: {
      kind: "expected-task-settlement",
      expectedQuestionType: "coding",
      expectedRelation: "followup-parent",
      expectedParentAction: "preserve",
    },
  });
  const projection = deriveHumanEvaluationProjectionV2({
    sessionId: "meeting-a",
    subject,
    events: [event],
  });
  manager.recordHumanGroundTruthEventV2(event);
  manager.recordHumanEvaluationProjectionV2(projection);
  await manager.stop("ov152");

  const aggregate = await disk.json<{ version: number; traces: SessionCompactTraceSummary[] }>(
    "metrics/trace-summaries.latest.json"
  );
  const journal = (await readFile(path.join(disk.folder, "metrics/trace-summaries.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SessionCompactTraceSummary);
  const read = await readRecordedTraceSummaries<SessionCompactTraceSummary>(disk.folder);
  assert.equal(read.reconstructed, false);
  assert.deepEqual(read.warnings, []);
  assert.equal(read.traces.length, traces.length);
  assert.equal(journal.length, traces.length);
  assert.equal(aggregate.version, 45);

  for (const trace of traces) {
    const groups = groupsOf(trace);
    const independent = await disk.json<SessionCompactTraceSummary>(
      `traces/${trace.id}/summary.json`
    );
    const exportedRoot = (
      await disk.json<{ trace: MeetingTrace }>(`traces/${trace.id}.json`)
    ).trace.metadata!;
    assert.equal(independent.version, 45);
    for (const key of GROUP_KEYS) {
      assert.deepEqual(independent[key], groups[key], `${trace.id} ${key}`);
      assert.equal(key in independent, groups[key] !== undefined, `${trace.id} ${key}`);
    }
    // The aggregate and the original reader hold the same row. So does the
    // journal here, because each of these traces is written exactly once: the
    // journal keeps a trace's first recorded row (see the OV152-4 re-write
    // test), so it is not a carrier of the last retained result.
    for (const rows of [aggregate.traces, journal, read.traces]) {
      assert.deepEqual(rows.find((row) => row.traceId === trace.id), independent, trace.id);
    }
    // The groups are the exported Trace file's own root metadata.
    if (independent.runtimeCommit) {
      assert.deepEqual(independent.runtimeCommit, rootRuntimeCommit(exportedRoot));
    } else {
      assert.equal(exportedRoot.runtimeCommitAuthorized, undefined);
    }
    if (independent.generationCommit) {
      assert.deepEqual(independent.generationCommit, rootGenerationCommit(exportedRoot));
    } else {
      assert.equal(exportedRoot.generationResultCommitDisposition, undefined);
    }
    assert.equal(
      independent.screenOperation?.disposition,
      exportedRoot.screenOperationDisposition
    );
  }

  // Reading and reporting rewrites no recorded file, Human Expected included.
  const before = await fileHashes(disk.folder);
  const reread = await readRecordedTraceSummaries<LongitudinalTraceSummary>(disk.folder);
  const report = reportFor(reread.traces, {
    directory: disk.folder,
    manifest: await disk.json("manifest.json"),
    humanEvaluationProjectionsV2: [projection],
  });
  renderSessionLongitudinalEvaluationMarkdown(report);
  assert.deepEqual(await fileHashes(disk.folder), before);
  assert.ok(before["human-evaluation/ground-truth-v2.jsonl"]);
  assert.deepEqual(
    JSON.parse(
      (await readFile(path.join(disk.folder, "human-evaluation/ground-truth-v2.jsonl"), "utf8")).trim()
    ),
    stored(event)
  );

  const evidence = report.lastRetainedRuntimeEvidence;
  assert.equal(evidence.selectedTraceCount, 5);
  assert.equal(evidence.incompleteEvidenceTraceCount, 0);
  assert.deepEqual(evidence.families.runtimeCommit.availability, {
    numerator: 4,
    denominator: 5,
    rate: 0.8,
  });
  assert.deepEqual(evidence.families.runtimeCommit.results, {
    true: { numerator: 3, denominator: 4, rate: 0.75 },
    false: { numerator: 1, denominator: 4, rate: 0.25 },
  });
  assert.equal(evidence.families.screenOperation.availableCount, 1);
  assert.equal(evidence.families.screenOperation.notProvidedCount, 4);
  assert.deepEqual(evidence.families.screenOperation.reasons, { committed: { authorized: 1 } });
  assert.deepEqual(evidence.families.generationCommit.reasons, {
    committed: { authorized: 2 },
    pending: { "delivery-lock-active": 1 },
    rejected: { "parent-revision-mismatch": 1 },
  });
  for (const family of Object.values(evidence.families)) {
    assert.equal(family.reasonNotProvidedCount, 0);
    assert.equal(family.identityNotProvidedCount, 0);
  }
  // pending stays pending: neither a commit nor a failure.
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(evidence.families.generationCommit.results).map(([key, share]) => [
        key,
        share.numerator,
      ])
    ),
    { committed: 2, pending: 1, rejected: 1 }
  );
  // The Human Expected projection is the same object with or without groups.
  assert.deepEqual(
    reportFor(reread.traces.map(withoutGroups), {
      directory: disk.folder,
      manifest: await disk.json("manifest.json"),
      humanEvaluationProjectionsV2: [projection],
    }).humanEvidence,
    report.humanEvidence
  );
});

test("OV152-3 schema 44 and earlier, unknown versions and malformed groups are evidence not provided", () => {
  const { allowed, rejected, screen } = produceEvidenceTraces();
  const current = [allowed, rejected, screen].map((trace) => stored(compact(trace)));
  // The same rows as a later writer stamps them: the reader consumes every
  // integer version from 45 on, each in its own coverage row.
  const later = (version: number, suffix: string) =>
    current.map((summary) => ({
      ...summary,
      version,
      traceId: `${summary.traceId}-${suffix}`,
    })) as LongitudinalTraceSummary[];
  // What an older writer stored for the same traces: no groups, older version.
  const legacy = (version: unknown, suffix: string) =>
    current.map((summary) => ({
      ...withoutGroups(summary),
      version,
      traceId: `${summary.traceId}-${suffix}`,
    })) as unknown as LongitudinalTraceSummary[];
  // Rows of an unrecognized schema that happen to carry the group names.
  const unrecognized = (version: unknown, suffix: string) =>
    current.map((summary) => ({
      ...summary,
      version,
      traceId: `${summary.traceId}-${suffix}`,
    })) as unknown as LongitudinalTraceSummary[];
  const malformed = [
    { traceId: "malformed-a", version: 45, runtimeCommit: { authorized: "true", reason: "authorized" } },
    { traceId: "malformed-b", version: 45, runtimeCommit: { reason: "authorized" } },
    { traceId: "malformed-c", version: 45, screenOperation: { operationId: "screen-x" } },
    { traceId: "malformed-d", version: 45, generationCommit: "committed" },
    { traceId: "malformed-e", version: 45, generationCommit: { disposition: "" } },
  ] as unknown as LongitudinalTraceSummary[];

  const report = reportFor([
    ...(current as LongitudinalTraceSummary[]),
    ...later(46, "v46"),
    ...legacy(44, "v44"),
    ...legacy(43, "v43"),
    ...legacy(undefined, "none"),
    ...unrecognized("45", "string"),
    ...unrecognized(44.5, "fraction"),
    ...unrecognized(44, "v44-groups"),
    ...malformed,
  ]);
  const evidence = report.lastRetainedRuntimeEvidence;
  assert.equal(evidence.selectedTraceCount, 29);
  // Only the three schema-45 rows and the three schema-46 rows, all with
  // well-formed groups, provide evidence.
  assert.equal(evidence.families.runtimeCommit.availableCount, 6);
  assert.equal(evidence.families.runtimeCommit.notProvidedCount, 23);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(evidence.families.runtimeCommit.results).map(([key, share]) => [
        key,
        share.numerator,
      ])
    ),
    { true: 4, false: 2 }
  );
  assert.equal(evidence.families.screenOperation.availableCount, 2);
  assert.equal(evidence.families.generationCommit.availableCount, 6);
  assert.deepEqual(
    evidence.coverageBySummaryVersion.map((row) => [
      row.summaryVersion,
      row.groupsConsumed,
      row.selectedTraceCount,
      row.availability.runtimeCommit.numerator,
      row.availability.screenOperation.numerator,
      row.availability.generationCommit.numerator,
      row.ignoredGroupCount,
    ]),
    [
      [43, false, 3, 0, 0, 0, 0],
      [44, false, 6, 0, 0, 0, 7],
      [45, true, 8, 3, 1, 3, 0],
      [46, true, 3, 3, 1, 3, 0],
      ["unknown", false, 9, 0, 0, 0, 14],
    ]
  );
  // The schema-46 rows are consumed in a coverage row of their own and are
  // not folded into the schema-45 row.
  const section = diagnosticSection(renderSessionLongitudinalEvaluationMarkdown(report));
  assert.match(section, /\| 45 \| yes \| 8 \| 37\.5% \(3\/8\) \| 12\.5% \(1\/8\) \| 37\.5% \(3\/8\) \| 0 \|/);
  assert.match(section, /\| 46 \| yes \| 3 \| 100\.0% \(3\/3\) \| 33\.3% \(1\/3\) \| 100\.0% \(3\/3\) \| 0 \|/);
  // The hand-written malformed rows have no trace kind either.
  assert.deepEqual(evidence.families.runtimeCommit.byTraceKind["(not provided)"], {
    selected: 5,
    available: 0,
    results: {},
  });
  // Missing evidence is reported as such: no rejection, success or zero count
  // is produced for rows that never carried the groups.
  const legacyOnly = reportFor([...legacy(44, "v44"), ...legacy(43, "v43")])
    .lastRetainedRuntimeEvidence;
  for (const family of Object.values(legacyOnly.families)) {
    assert.equal(family.selectedTraceCount, 6);
    assert.equal(family.availableCount, 0);
    assert.equal(family.notProvidedCount, 6);
    assert.deepEqual(family.results, {});
    assert.deepEqual(family.availability, { numerator: 0, denominator: 6, rate: 0 });
  }
});

test("OV152-3 unsealed recording, reader rows only: the incomplete warning stays and an interrupted summary is not a row", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-ov152-unsealed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const disk = new DiskRecording(root);
  const manager = new SessionRecordingManager(undefined, disk.invoke);
  await manager.start(START_OPTIONS);
  const { allowed, pending, rejected } = produceEvidenceTraces();
  // The last summary write never completes.
  disk.failWrite = (relativePath) => relativePath === `traces/${rejected.id}/summary.json`;
  for (const trace of [allowed, pending, rejected]) manager.recordTrace(trace, "manual");
  await disk.drained(manager);
  await mkdir(path.join(disk.folder, `traces/${rejected.id}`), { recursive: true });
  await writeFile(path.join(disk.folder, `traces/${rejected.id}/summary.json`), '{"traceId":');
  try {
    const manifest = await disk.json<{ status?: string }>("manifest.json");
    assert.notEqual(manifest.status, "stopped");
    const read = await readRecordedTraceSummaries<LongitudinalTraceSummary>(disk.folder);
    assert.equal(read.reconstructed, true);
    assert.deepEqual(read.traces.map((trace) => trace.traceId).sort(), [allowed.id, pending.id].sort());
    assert.ok(read.warnings.some((warning) => warning.includes("Incomplete trace summary")));

    const evidenceScope = evaluateLongitudinalSessionEvidenceScope({
      manifestPresent: true,
      transcriptPresent: false,
      traceEvidencePresent: true,
      manifest,
    });
    const report = reportFor(read.traces, { directory: disk.folder, manifest, evidenceScope });
    assert.equal(report.evidenceScope.releaseEligible, false);
    assert.ok(
      report.evidenceScope.failures[0]?.reasons.includes("recording-integrity-incomplete")
    );
    const evidence = report.lastRetainedRuntimeEvidence;
    assert.equal(evidence.selectedTraceCount, 2);
    assert.equal(evidence.incompleteEvidenceTraceCount, 2);
    // This path feeds the reader's rows alone, and the interrupted summary is
    // not one of them. The report CLI also merges the raw trace exports, where
    // the same trace is counted as not provided (see the CLI test below). On
    // neither path does it become a rejection.
    assert.deepEqual(Object.keys(evidence.families.runtimeCommit.results), ["true"]);
    assert.deepEqual(
      Object.keys(evidence.families.generationCommit.results).sort(),
      ["committed", "pending"]
    );
    assert.match(
      diagnosticSection(renderSessionLongitudinalEvaluationMarkdown(report)),
      /Selected traces from incomplete or unsealed recordings: 2/
    );
  } finally {
    disk.failWrite = () => false;
    await manager.stop("cleanup");
  }
});

test("OV152-3 the real report CLI does not back-fill groups from raw traces, counts a raw-only or interrupted trace as not provided and rewrites no recorded file", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-ov152-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = process.cwd();
  const compiled = path.join(root, "compiled");
  const compilation = spawnSync(
    path.join(repository, "node_modules/.bin/tsc"),
    ["-p", "tsconfig.session-longitudinal-evaluation.json", "--outDir", compiled],
    { cwd: repository, encoding: "utf8" }
  );
  assert.equal(compilation.status, 0, compilation.stdout + compilation.stderr);

  const disk = new DiskRecording(path.join(root, "recordings"));
  const manager = new SessionRecordingManager(undefined, disk.invoke);
  await manager.start(START_OPTIONS);
  const startedAt = Date.now();
  manager.recordTranscriptTurn({
    id: "turn-a",
    text: "Explain the queue invariant.",
    speaker: "them",
    startedAt,
    endedAt: startedAt + 1,
    isFinal: true,
    source: "system-audio",
  });
  const traces = Object.values(produceEvidenceTraces());
  for (const trace of traces) manager.recordTrace(trace, "manual");
  await manager.stop("ov152");

  // The same recording as an older writer left it: raw traces unchanged,
  // summaries at schema 44 without the groups.
  const legacyFolder = path.join(root, "recordings", "legacy-schema-44");
  await cp(disk.folder, legacyFolder, { recursive: true });
  const downgrade = async (relativePath: string, wrapped: boolean) => {
    const file = path.join(legacyFolder, relativePath);
    const value = JSON.parse(await readFile(file, "utf8"));
    const strip = (summary: SessionCompactTraceSummary) => ({
      ...withoutGroups(summary),
      version: 44,
    });
    await writeFile(
      file,
      JSON.stringify(
        wrapped ? { ...value, version: 44, traces: value.traces.map(strip) } : strip(value),
        null,
        2
      )
    );
  };
  await downgrade("metrics/trace-summaries.latest.json", true);
  for (const trace of traces) await downgrade(`traces/${trace.id}/summary.json`, false);
  const legacyManifest = JSON.parse(await readFile(path.join(legacyFolder, "manifest.json"), "utf8"));
  await writeFile(
    path.join(legacyFolder, "manifest.json"),
    JSON.stringify({ ...legacyManifest, sessionId: "legacy-schema-44" }, null, 2)
  );

  // The same sealed recording where one trace kept its raw export but has no
  // compact summary row at all. Its raw root holds a Token rejection.
  const rawOnlyFolder = path.join(root, "recordings", "raw-only-trace");
  await cp(disk.folder, rawOnlyFolder, { recursive: true });
  const rawOnlyTrace = traces.find(
    (trace) => trace.metadata?.runtimeCommitAuthorized === false
  )!;
  const rawOnlyAggregate = path.join(rawOnlyFolder, "metrics/trace-summaries.latest.json");
  const sealedAggregate = JSON.parse(await readFile(rawOnlyAggregate, "utf8"));
  await writeFile(
    rawOnlyAggregate,
    JSON.stringify(
      {
        ...sealedAggregate,
        traces: sealedAggregate.traces.filter(
          (row: SessionCompactTraceSummary) => row.traceId !== rawOnlyTrace.id
        ),
      },
      null,
      2
    )
  );
  await rm(path.join(rawOnlyFolder, `traces/${rawOnlyTrace.id}`), { recursive: true });
  await writeFile(
    path.join(rawOnlyFolder, "manifest.json"),
    JSON.stringify({ ...legacyManifest, sessionId: "raw-only-trace" }, null, 2)
  );

  const before = {
    current: await fileHashes(disk.folder),
    legacy: await fileHashes(legacyFolder),
    rawOnly: await fileHashes(rawOnlyFolder),
  };
  const rawRoot = JSON.parse(
    await readFile(path.join(legacyFolder, `traces/${traces[0]!.id}.json`), "utf8")
  ).trace.metadata;
  assert.equal(rawRoot.runtimeCommitAuthorized, true);
  assert.equal(rawRoot.generationResultCommitDisposition, "committed");

  const cli = (session: string, output: string, flags: string[] = []) =>
    spawnSync(
      process.execPath,
      [
        path.join(compiled, "scripts/reflect-session-longitudinal-evaluation.js"),
        "--session",
        session,
        "--output",
        path.join(root, output),
        ...flags,
      ],
      { cwd: repository, encoding: "utf8" }
    );
  const run = (session: string, output: string, flags: string[] = []) => {
    const result = cli(session, output, flags);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(readFileSync(path.join(root, output, "report.json"), "utf8"))
      .lastRetainedRuntimeEvidence as ReturnType<typeof reportFor>["lastRetainedRuntimeEvidence"];
  };
  const coverage = (evidence: ReturnType<typeof run>) =>
    evidence.coverageBySummaryVersion.map((row) => [
      row.summaryVersion,
      row.groupsConsumed,
      row.selectedTraceCount,
      row.availability.runtimeCommit.numerator,
      row.availability.screenOperation.numerator,
      row.availability.generationCommit.numerator,
      row.ignoredGroupCount,
    ]);
  const current = run(disk.folder, "current-report");
  assert.equal(current.derivationVersion, "last-retained-runtime-evidence-v1");
  assert.equal(current.selectedTraceCount, 5);
  assert.equal(current.families.runtimeCommit.availableCount, 4);
  assert.equal(current.families.screenOperation.availableCount, 1);
  assert.equal(current.families.generationCommit.availableCount, 4);

  const legacy = run(legacyFolder, "legacy-report");
  assert.equal(legacy.selectedTraceCount, 5);
  for (const family of Object.values(legacy.families)) {
    assert.equal(family.availableCount, 0);
    assert.equal(family.notProvidedCount, 5);
    assert.deepEqual(family.results, {});
  }
  assert.deepEqual(
    legacy.coverageBySummaryVersion.map((row) => [row.summaryVersion, row.groupsConsumed, row.selectedTraceCount]),
    [[44, false, 5]]
  );
  assert.match(
    readFileSync(path.join(root, "legacy-report", "report.md"), "utf8"),
    /\| 44 \| no \| 5 \| 0\.0% \(0\/5\) \| 0\.0% \(0\/5\) \| 0\.0% \(0\/5\) \| 0 \|/
  );

  // A trace with a raw export and no compact summary row stays in the CLI's
  // retained set, in the row without a readable version, as not provided. Its
  // raw root's rejection is not read into the Token results.
  assert.equal(
    JSON.parse(
      await readFile(path.join(rawOnlyFolder, `traces/${rawOnlyTrace.id}.json`), "utf8")
    ).trace.metadata.runtimeCommitAuthorized,
    false
  );
  const rawOnly = run(rawOnlyFolder, "raw-only-report");
  assert.equal(rawOnly.selectedTraceCount, 5);
  assert.equal(rawOnly.incompleteEvidenceTraceCount, 0);
  assert.deepEqual(coverage(rawOnly), [
    [45, true, 4, 3, 1, 3, 0],
    ["unknown", false, 1, 0, 0, 0, 0],
  ]);
  assert.equal(rawOnly.families.runtimeCommit.availableCount, 3);
  assert.equal(rawOnly.families.runtimeCommit.notProvidedCount, 2);
  assert.deepEqual(Object.keys(rawOnly.families.runtimeCommit.results), ["true"]);
  assert.deepEqual(rawOnly.families.runtimeCommit.byTraceKind.voice, {
    selected: 4,
    available: 2,
    results: { true: 2 },
  });
  assert.deepEqual(
    Object.keys(rawOnly.families.generationCommit.results).sort(),
    ["committed", "pending"]
  );
  assert.match(
    readFileSync(path.join(root, "raw-only-report", "report.md"), "utf8"),
    /\| unknown \| no \| 1 \| 0\.0% \(0\/1\) \| 0\.0% \(0\/1\) \| 0\.0% \(0\/1\) \| 0 \|/
  );

  // Every recorded file is byte-identical; the CLI only adds derived output.
  const assertNothingRewritten = async (
    label: string,
    folder: string,
    recorded: Record<string, string>
  ) => {
    const after = await fileHashes(folder);
    for (const [file, hash] of Object.entries(recorded)) {
      assert.equal(after[file], hash, `${label}: ${file}`);
    }
    for (const file of Object.keys(after)) {
      if (!(file in recorded)) assert.match(file, /^evaluation\//, file);
    }
  };
  await assertNothingRewritten("current", disk.folder, before.current);
  await assertNothingRewritten("legacy", legacyFolder, before.legacy);
  await assertNothingRewritten("raw-only", rawOnlyFolder, before.rawOnly);

  // An unsealed recording through the same CLI: never stopped, and the last
  // summary write was interrupted. The raw export of that trace exists and
  // its root holds a Token rejection and a generation rejection.
  const unsealedDisk = new DiskRecording(path.join(root, "unsealed"));
  const unsealedManager = new SessionRecordingManager(undefined, unsealedDisk.invoke);
  await unsealedManager.start(START_OPTIONS);
  try {
    const unsealedStartedAt = Date.now();
    unsealedManager.recordTranscriptTurn({
      id: "turn-a",
      text: "Explain the queue invariant.",
      speaker: "them",
      startedAt: unsealedStartedAt,
      endedAt: unsealedStartedAt + 1,
      isFinal: true,
      source: "system-audio",
    });
    const unsealed = produceEvidenceTraces();
    unsealedDisk.failWrite = (relativePath) =>
      relativePath === `traces/${unsealed.rejected.id}/summary.json`;
    for (const trace of [unsealed.allowed, unsealed.pending, unsealed.rejected]) {
      unsealedManager.recordTrace(trace, "manual");
    }
    await unsealedDisk.drained(unsealedManager);
    await mkdir(path.join(unsealedDisk.folder, `traces/${unsealed.rejected.id}`), { recursive: true });
    await writeFile(
      path.join(unsealedDisk.folder, `traces/${unsealed.rejected.id}/summary.json`),
      '{"traceId":'
    );
    const interruptedRoot = JSON.parse(
      await readFile(path.join(unsealedDisk.folder, `traces/${unsealed.rejected.id}.json`), "utf8")
    ).trace.metadata;
    assert.equal(interruptedRoot.runtimeCommitAuthorized, false);
    assert.equal(interruptedRoot.generationResultCommitDisposition, "rejected");
    const unsealedBefore = await fileHashes(unsealedDisk.folder);

    // The existing strict exit is unchanged: no report for an unsealed
    // recording unless the caller asks for exploratory output.
    const strict = cli(unsealedDisk.folder, "unsealed-strict");
    assert.equal(strict.status, 1, strict.stdout);
    assert.match(strict.stderr, /recording-integrity-incomplete/);
    assert.equal(existsSync(path.join(root, "unsealed-strict", "report.json")), false);
    assert.deepEqual(await fileHashes(unsealedDisk.folder), unsealedBefore);

    const exploratory = cli(unsealedDisk.folder, "unsealed-report", ["--allow-incomplete"]);
    assert.equal(exploratory.status, 0, exploratory.stderr);
    assert.match(exploratory.stderr, /Incomplete trace summary/);
    const incomplete = JSON.parse(
      readFileSync(path.join(root, "unsealed-report", "report.json"), "utf8")
    ).lastRetainedRuntimeEvidence as ReturnType<typeof run>;
    // All three traces are selected and flagged incomplete. The interrupted
    // one has no readable summary row: it is not provided, never a rejection.
    assert.equal(incomplete.selectedTraceCount, 3);
    assert.equal(incomplete.incompleteEvidenceTraceCount, 3);
    assert.deepEqual(coverage(incomplete), [
      [45, true, 2, 2, 0, 2, 0],
      ["unknown", false, 1, 0, 0, 0, 0],
    ]);
    assert.equal(incomplete.families.runtimeCommit.availableCount, 2);
    assert.equal(incomplete.families.runtimeCommit.notProvidedCount, 1);
    assert.deepEqual(incomplete.families.runtimeCommit.results, {
      true: { numerator: 2, denominator: 2, rate: 1 },
    });
    assert.deepEqual(
      Object.keys(incomplete.families.generationCommit.results).sort(),
      ["committed", "pending"]
    );
    const unsealedMarkdown = readFileSync(path.join(root, "unsealed-report", "report.md"), "utf8");
    assert.match(unsealedMarkdown, /Selected traces from incomplete or unsealed recordings: 3/);
    assert.match(
      unsealedMarkdown,
      /\| unknown \| no \| 1 \| 0\.0% \(0\/1\) \| 0\.0% \(0\/1\) \| 0\.0% \(0\/1\) \| 0 \|/
    );
    await assertNothingRewritten("unsealed", unsealedDisk.folder, unsealedBefore);
  } finally {
    unsealedDisk.failWrite = () => false;
    await unsealedManager.stop("cleanup").catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// OV152-4 denominators
// ---------------------------------------------------------------------------

/** 65 allowed, 5 rejected, 30 without a Token result; all real builder rows. */
function fixedHundred() {
  const snapshot: RuntimeCommitSnapshot = {
    runtimeEpoch: 1,
    sessionId: "meeting-a",
    parentId: "parent-a",
    parentRevision: 1,
  };
  const rows: SessionCompactTraceSummary[] = [];
  for (let index = 0; index < 100; index++) {
    const operationId = `operation-${index}`;
    const token = createRuntimeCommitToken({ operationId, pipeline: "advisor", snapshot });
    const decision =
      index < 65
        ? authorizeRuntimeCommit({ token, current: snapshot, currentOperationId: operationId })
        : index < 70
          ? authorizeRuntimeCommit({
              token,
              current: { ...snapshot, parentRevision: 2 },
              currentOperationId: operationId,
            })
          : undefined;
    rows.push(
      stored(
        compact(
          completedTrace(
            `trace-${String(index).padStart(3, "0")}`,
            decision
              ? formatRuntimeCommitAuthorizationForTrace(
                  decision,
                  index % 2 === 0 ? "pre-model" : "pre-commit"
                )
              : { advisorJobId: operationId },
            1_000 + index
          )
        )
      )
    );
  }
  return rows;
}

test("OV152-4 a fixed 100-trace set reproduces 65/5/30, 70/100 and 5/70", () => {
  const rows = fixedHundred();
  const report = reportFor(rows as LongitudinalTraceSummary[]);
  const family = report.lastRetainedRuntimeEvidence.families.runtimeCommit;
  assert.equal(family.selectedTraceCount, 100);
  assert.equal(family.availableCount, 70);
  assert.equal(family.notProvidedCount, 30);
  assert.deepEqual(family.availability, { numerator: 70, denominator: 100, rate: 0.7 });
  assert.deepEqual(family.results, {
    true: { numerator: 65, denominator: 70, rate: 65 / 70 },
    false: { numerator: 5, denominator: 70, rate: 5 / 70 },
  });
  assert.deepEqual(family.reasons, {
    true: { authorized: 65 },
    false: { "parent-revision-mismatch": 5 },
  });
  assert.equal(family.reasonExpectedCount, 70);
  assert.equal(family.reasonNotProvidedCount, 0);
  assert.equal(family.identityNotProvidedCount, 0);
  assert.deepEqual(family.byStage, {
    "pre-model": { true: 33, false: 2 },
    "pre-commit": { true: 32, false: 3 },
  });
  assert.deepEqual(family.byTraceKind, {
    voice: { selected: 100, available: 70, results: { true: 65, false: 5 } },
  });

  // Not provided is never turned into a success (95/100) or a failure (35/100).
  const serialized = JSON.stringify(report.lastRetainedRuntimeEvidence);
  assert.doesNotMatch(serialized, /"numerator":(95|35|30),"denominator":100/);
  const section = diagnosticSection(renderSessionLongitudinalEvaluationMarkdown(report));
  assert.match(section, /Runtime Token \(authorized\) \| 70\.0% \(70\/100\) \| 30 \| 0 of 70 \| 0 of 70 \|/);
  // The two families nobody observed show their empty denominators.
  assert.match(section, /Screen operation \(disposition\) \| 0\.0% \(0\/100\) \| 100 \| 0 of 0 \| 0 of 0 \|/);
  assert.match(section, /Generation commit \(disposition\) \| 0\.0% \(0\/100\) \| 100 \| 0 of 0 \| 0 of 0 \|/);
  assert.match(section, /false=7\.1% \(5\/70\), true=92\.9% \(65\/70\)/);
  assert.match(
    section,
    /reasons: false \[parent-revision-mismatch=5\]; true \[authorized=65\]; without reason: none/
  );
  assert.match(section, /Runtime Token \(authorized\) available by trace kind: voice 70\/100/);
  assert.match(
    section,
    /Runtime Token results by stage: pre-commit \[false=3, true=32\]; pre-model \[false=2, true=33\]/
  );
  assert.doesNotMatch(section, /95\.0%|\(95\/100\)|35\.0%/);

  // The other two families were never observed on these traces.
  for (const key of ["screenOperation", "generationCommit"] as const) {
    assert.deepEqual(report.lastRetainedRuntimeEvidence.families[key].availability, {
      numerator: 0,
      denominator: 100,
      rate: 0,
    });
  }
});

test("OV152-4 re-written rows, scripted sessions and synthetic traces do not grow the denominator", async (t) => {
  const rows = fixedHundred() as LongitudinalTraceSummary[];
  // The first trace is re-written three times; its last retained row is a
  // rejection. Rows of other traces are untouched.
  const rejection = { ...rows[65]!, traceId: rows[0]!.traceId };
  const rewritten = [rows[0]!, ...rows, rows[0]!, rejection];
  const report = reportFor(rewritten);
  const evidence = report.lastRetainedRuntimeEvidence;
  assert.equal(report.cohort.productionTraceCount, 103);
  assert.equal(evidence.selectedTraceCount, 100);
  assert.equal(evidence.duplicateRowsCollapsed, 3);
  assert.match(
    diagnosticSection(renderSessionLongitudinalEvaluationMarkdown(report)),
    /Selected traces: 100 \(production-traces-one-row-per-session-trace; re-written rows collapsed: 3\)/
  );
  assert.deepEqual(evidence.families.runtimeCommit.availability, {
    numerator: 70,
    denominator: 100,
    rate: 0.7,
  });
  assert.equal(evidence.families.runtimeCommit.results.true?.numerator, 64);
  assert.equal(evidence.families.runtimeCommit.results.false?.numerator, 6);

  // Outside the retained set: a scripted session and synthetic-validation rows.
  const scoped = buildSessionLongitudinalEvaluationReport([
    { directory: "product", manifest: { sessionId: "product" }, transcriptTurns: [], traceSummaries: rows, questionEvaluations: [] },
    { directory: "scripted", manifest: { sessionId: "scripted", scriptedValidation: true }, transcriptTurns: [], traceSummaries: rows, questionEvaluations: [] },
    {
      directory: "synthetic",
      manifest: { sessionId: "synthetic" },
      transcriptTurns: [],
      traceSummaries: rows.slice(0, 10).map((row) => ({ ...row, syntheticValidation: true })),
      questionEvaluations: [],
    },
  ]).lastRetainedRuntimeEvidence;
  assert.equal(scoped.selectedTraceCount, 100);
  assert.equal(scoped.families.runtimeCommit.availableCount, 70);
  // The same trace id in two product sessions is two traces, not a re-write.
  const twoSessions = buildSessionLongitudinalEvaluationReport(
    ["first", "second"].map((sessionId) => ({
      directory: sessionId,
      manifest: { sessionId },
      transcriptTurns: [],
      traceSummaries: rows,
      questionEvaluations: [],
    }))
  ).lastRetainedRuntimeEvidence;
  assert.equal(twoSessions.selectedTraceCount, 200);
  assert.equal(twoSessions.duplicateRowsCollapsed, 0);

  // The real writer keeps one row per trace however often it is refreshed.
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-ov152-journal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const disk = new DiskRecording(root);
  const manager = new SessionRecordingManager(undefined, disk.invoke);
  await manager.start(START_OPTIONS);
  const snapshot = { runtimeEpoch: 1, sessionId: "meeting-a" };
  const token = createRuntimeCommitToken({ operationId: "job-a", pipeline: "advisor", snapshot });
  const allowed = formatRuntimeCommitAuthorizationForTrace(
    authorizeRuntimeCommit({ token, current: snapshot, currentOperationId: "job-a" }),
    "pre-model"
  );
  const refused = formatRuntimeCommitAuthorizationForTrace(
    authorizeRuntimeCommit({ token, current: snapshot, currentOperationId: "job-b" }),
    "pre-commit"
  );
  const startedAt = Date.now();
  manager.recordTrace(completedTrace("trace-journal", allowed, startedAt), "manual");
  for (const metadata of [allowed, { ...allowed, ...refused }, { ...allowed, ...refused }]) {
    manager.refreshRecordedTrace(completedTrace("trace-journal", metadata, startedAt), "manual");
  }
  manager.recordTrace(completedTrace("trace-journal", { ...allowed, ...refused }, startedAt), "manual");
  await manager.stop("ov152");
  const journal = (await readFile(path.join(disk.folder, "metrics/trace-summaries.jsonl"), "utf8"))
    .trim()
    .split("\n");
  assert.equal(journal.length, 1);
  assert.equal(
    disk.writes.filter((write) => write.relativePath === "traces/trace-journal/summary.json").length,
    5
  );
  const read = await readRecordedTraceSummaries<LongitudinalTraceSummary>(disk.folder);
  assert.equal(read.traces.length, 1);
  // The journal is append-once: its line is the first recorded row and still
  // says "allowed". The summary file, the aggregate and the reader hold the
  // last retained result, and only those feed the diagnostic.
  const firstRecorded = {
    operationId: "job-a",
    pipeline: "advisor",
    stage: "pre-model",
    authorized: true,
    reason: "authorized",
  };
  const lastRetained = {
    operationId: "job-a",
    pipeline: "advisor",
    stage: "pre-commit",
    authorized: false,
    reason: "pipeline-owner-mismatch",
  };
  assert.deepEqual(
    (JSON.parse(journal[0]!) as SessionCompactTraceSummary).runtimeCommit,
    firstRecorded
  );
  assert.deepEqual(read.traces[0]!.runtimeCommit, lastRetained);
  assert.deepEqual(
    (await disk.json<SessionCompactTraceSummary>("traces/trace-journal/summary.json")).runtimeCommit,
    lastRetained
  );
  assert.deepEqual(
    (
      await disk.json<{ traces: SessionCompactTraceSummary[] }>(
        "metrics/trace-summaries.latest.json"
      )
    ).traces.map((row) => row.runtimeCommit),
    [lastRetained]
  );
  const written = reportFor(read.traces).lastRetainedRuntimeEvidence;
  assert.equal(written.selectedTraceCount, 1);
  assert.deepEqual(written.families.runtimeCommit.results, {
    false: { numerator: 1, denominator: 1, rate: 1 },
  });
  assert.deepEqual(written.families.runtimeCommit.byStage, { "pre-commit": { false: 1 } });
});

test("OV152-4 a missing reason keeps the result, a zero denominator has no percentage, dispositions are not rewritten", () => {
  const rows = fixedHundred();
  // Three results lose their reason, two their identity, one its stage.
  for (const index of [0, 1, 66]) delete rows[index]!.runtimeCommit!.reason;
  for (const index of [2, 67]) delete rows[index]!.runtimeCommit!.operationId;
  delete rows[3]!.runtimeCommit!.stage;
  const family = reportFor(rows as LongitudinalTraceSummary[]).lastRetainedRuntimeEvidence
    .families.runtimeCommit;
  assert.deepEqual(family.availability, { numerator: 70, denominator: 100, rate: 0.7 });
  assert.equal(family.results.true?.numerator, 65);
  assert.equal(family.results.false?.numerator, 5);
  assert.equal(family.reasonExpectedCount, 70);
  assert.equal(family.reasonNotProvidedCount, 3);
  assert.deepEqual(family.reasonNotProvidedByResult, { true: 2, false: 1 });
  assert.deepEqual(family.reasons, {
    true: { authorized: 63 },
    false: { "parent-revision-mismatch": 4 },
  });
  assert.equal(family.identityNotProvidedCount, 2);
  assert.deepEqual(family.byStage?.["(not provided)"], { true: 1 });

  // No trace, and traces without any result: no percentage is produced.
  for (const empty of [
    reportFor([]),
    reportFor(fixedHundred().slice(70) as LongitudinalTraceSummary[]),
  ]) {
    const evidence = empty.lastRetainedRuntimeEvidence;
    for (const share of Object.values(evidence.families)) {
      assert.deepEqual(share.results, {});
      assert.equal(share.availableCount, 0);
    }
    const section = diagnosticSection(renderSessionLongitudinalEvaluationMarkdown(empty));
    assert.match(section, /results among observed: none/);
    // Zero missing reasons or identities out of zero results is shown as such,
    // not as a bare 0 that reads like complete evidence.
    for (const share of Object.values(evidence.families)) {
      assert.equal(share.reasonExpectedCount, 0);
    }
    assert.equal(section.match(/\| 0 of 0 \| 0 of 0 \|/g)?.length, 3);
    if (evidence.selectedTraceCount === 0) {
      assert.equal(evidence.families.runtimeCommit.availability.rate, null);
      assert.match(section, /N\/A \(0\/0\)/);
      assert.doesNotMatch(section, /%/);
    }
  }

  // Every original disposition is counted under its own name, including one
  // this reader has never seen.
  const screenDispositions = ["committed", "rejected", "superseded", "stale-rejected", "future-disposition"];
  const generationDispositions = [
    "started", "pending", "committed", "rejected", "failed", "timed-out", "aborted", "cancelled", "superseded",
  ];
  const dispositionRows = generationDispositions.flatMap((disposition, index) =>
    Array.from({ length: index + 1 }, (_, copy) => ({
      traceId: `generation-${disposition}-${copy}`,
      version: 45,
      traceKind: copy % 2 ? "screen" : "voice",
      // The first copy of each disposition has no ledger entry id, the second
      // pending one no reason.
      generationCommit: {
        ...(copy === 0 ? {} : { ledgerEntryId: `entry-${disposition}-${copy}` }),
        disposition,
        ...(disposition === "pending" && copy === 1 ? {} : { reason: `${disposition}-reason` }),
      },
      ...(screenDispositions[index]
        ? {
            screenOperation: {
              ...(copy === 1 ? {} : { operationId: `screen-${index}-${copy}` }),
              disposition: screenDispositions[index],
              ...(index < 2 && copy === 0
                ? { commitReason: index === 0 ? "authorized" : "candidate-not-accepted" }
                : {}),
              ...(screenDispositions[index] === "superseded" && copy === 0
                ? { supersededByOperationId: "screen-next" }
                : {}),
            },
          }
        : {}),
    }))
  ) as LongitudinalTraceSummary[];
  const dispositions = reportFor(dispositionRows).lastRetainedRuntimeEvidence;
  const counts = (results: Record<string, { numerator: number }>) =>
    Object.fromEntries(Object.entries(results).map(([key, share]) => [key, share.numerator]));
  assert.deepEqual(counts(dispositions.families.generationCommit.results), {
    started: 1, pending: 2, committed: 3, rejected: 4, failed: 5,
    "timed-out": 6, aborted: 7, cancelled: 8, superseded: 9,
  });
  assert.equal(dispositions.families.generationCommit.availableCount, 45);
  assert.deepEqual(counts(dispositions.families.screenOperation.results), {
    committed: 1, rejected: 2, superseded: 3, "stale-rejected": 4, "future-disposition": 5,
  });
  assert.equal(dispositions.families.screenOperation.availableCount, 15);
  assert.equal(dispositions.families.screenOperation.notProvidedCount, 30);
  assert.equal(dispositions.families.screenOperation.supersededWithoutReferenceCount, 2);
  assert.deepEqual(dispositions.families.screenOperation.reasons, {
    committed: { authorized: 1 },
    rejected: { "candidate-not-accepted": 1 },
  });
  // Only committed and rejected carry a reason. Of those three results one
  // rejected arrived without it; the other twelve have none by contract and
  // are listed apart, not as missing evidence.
  assert.equal(dispositions.families.screenOperation.reasonExpectedCount, 3);
  assert.equal(dispositions.families.screenOperation.reasonNotProvidedCount, 1);
  assert.deepEqual(dispositions.families.screenOperation.reasonNotProvidedByResult, {
    rejected: 1,
  });
  assert.deepEqual(dispositions.families.screenOperation.reasonNotCarriedByResult, {
    superseded: 3, "stale-rejected": 4, "future-disposition": 5,
  });
  assert.equal(dispositions.families.screenOperation.identityNotProvidedCount, 4);
  // Every Token and Generation result carries a reason.
  assert.equal(dispositions.families.generationCommit.reasonExpectedCount, 45);
  assert.equal(dispositions.families.generationCommit.reasonNotProvidedCount, 1);
  assert.equal(dispositions.families.generationCommit.reasonNotCarriedByResult, undefined);
  assert.equal(dispositions.families.runtimeCommit.reasonNotCarriedByResult, undefined);
  assert.deepEqual(dispositions.families.generationCommit.reasons.pending, { "pending-reason": 1 });
  assert.deepEqual(dispositions.families.generationCommit.reasons.superseded, { "superseded-reason": 9 });
  assert.deepEqual(dispositions.families.generationCommit.reasonNotProvidedByResult, { pending: 1 });
  assert.equal(dispositions.families.generationCommit.identityNotProvidedCount, 9);
  const dispositionSection = diagnosticSection(
    renderSessionLongitudinalEvaluationMarkdown(reportFor(dispositionRows))
  );
  assert.match(dispositionSection, /Superseded Screen operations without the superseding operation: 2/);
  assert.match(dispositionSection, /Screen operation \(disposition\) \| 33\.3% \(15\/45\) \| 30 \| 1 of 3 \| 4 of 15 \|/);
  assert.match(dispositionSection, /Generation commit \(disposition\) \| 100\.0% \(45\/45\) \| 0 \| 1 of 45 \| 9 of 45 \|/);
  assert.match(
    dispositionSection,
    /Screen operation \(disposition\) reasons: committed \[authorized=1\]; rejected \[candidate-not-accepted=1\]; without reason: rejected=1/
  );
  assert.match(
    dispositionSection,
    /Screen results that carry no reason by contract: future-disposition=5, stale-rejected=4, superseded=3/
  );
  assert.match(dispositionSection, /pending=4\.4% \(2\/45\)/);
  assert.deepEqual(dispositions.families.generationCommit.byTraceKind.screen, {
    selected: 20,
    available: 20,
    results: { pending: 1, committed: 1, rejected: 2, failed: 2, "timed-out": 3, aborted: 3, cancelled: 4, superseded: 4 },
  });
});

// ---------------------------------------------------------------------------
// OV152-5 no business impact
// ---------------------------------------------------------------------------

test("OV152-5 production publication callbacks decide the same, before and after the projector ran, under every recording switch and write failure", async () => {
  // The existing callback harness: production prepare/install/finalize
  // callbacks with real Stable, lease, ledger and context state. Here it also
  // runs the Hook's own projection write against a real trace store.
  //
  // What this comparison covers: the trace is recorded while the answer is
  // still pending, so where a recording accepts it the projector has already
  // run when the publication decision is taken. What it does not cover: this
  // harness calls no provider and models no budget. Provider calls, budgets
  // and every other later decision rest on the static proof in the next test
  // (no runtime module reads the groups; the projector is a synchronous leaf).
  const harnessSource = readFileSync("tests/pending-answer-publication-callback.test.mjs", "utf8");
  const parsed = ts.createSourceFile("pending.mjs", harnessSource, ts.ScriptTarget.Latest, true);
  const firstTest = parsed.statements.find(
    (node) =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(parsed) === "test"
  );
  assert.ok(firstTest);
  const harnessModule = await import(
    `data:text/javascript;base64,${Buffer.from(
      `${harnessSource.slice(0, firstTest.getStart(parsed))}\nexport { createHarness, lease, suggestion };\n`
    ).toString("base64")}`
  );
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  const publishSource = hookCallback("publishGenerationResultProjection");

  for (const stale of [false, true]) {
    let expected: unknown;
    for (const mode of ["disabled", "active", "write-failure", "close-failed"] as const) {
      const directory = await mkdtemp(path.join(tmpdir(), "jarvis-ov152-publication-"));
      const disk = new DiskRecording(directory);
      const manager = new SessionRecordingManager(undefined, disk.invoke);
      const h = harnessModule.createHarness();
      try {
        if (mode !== "disabled") await manager.start(START_OPTIONS);
        if (mode === "write-failure") {
          disk.failWrite = (relativePath) => /^(traces|metrics)\//.test(relativePath);
        }
        if (mode === "close-failed") {
          disk.failWrite = (relativePath) => relativePath === "manifest.json";
          await assert.rejects(manager.stop(), /controlled write failure/);
          assert.equal(manager.getState().lifecycle, "close-failed");
        }
        const store = new MeetingTraceStore();
        h.environment.traceStoreRef = { current: store };
        h.environment.sessionRecordingManagerRef.current = manager;
        h.evaluate(`publishGenerationResultProjection = (${publishSource})`, {
          formatGenerationResultLedgerForTrace,
        });
        let observerCalls = 0;
        const recordLifecycle = manager.recordCaptureLifecycle.bind(manager);
        manager.recordCaptureLifecycle = (...args: Parameters<typeof recordLifecycle>) => {
          // The test's own drain barrier is not a callback observation.
          if (!String(args[0]?.stage).startsWith("ov152-barrier-")) observerCalls++;
          return recordLifecycle(...args);
        };

        const context = new MeetingContextManager();
        context.reset({ sessionId: "session-a" });
        const seed = context.commitTaskRuntimeTransition({
          id: "ov152-fixture-parent", transition: "create-parent", expectedRevision: 0,
          reason: "test-seed-task-runtime", parent: {
            id: "parent-a", source: "voice", stableKind: "coding", topic: "Explain the queue invariant",
            playbookPhase: "baseline_reasoning", phaseProgress: {}, supportedFactAnchors: [],
            revisions: 1, createdAt: 1000, updatedAt: 1000,
          },
        });
        assert.equal(seed.authorized, true);
        h.environment.contextManagerRef.current = context;
        const before = plain(context.getState());
        const task = context.getState().activeMeetingTask!;
        const job = createAdvisorTriggerJob({
          source: "regenerate", mode: "regenerate", sessionId: "session-a", runtimeEpoch: 1,
          snapshotTurnCount: 1, taskMutationAuthority: "output-only-current-branch", scheduledAt: 2000,
          promptContext: { transcript: "Explain the queue invariant", screenContext: "",
            activeMeetingTask: task, taskRuntime: context.getTaskRuntimeState() },
        });
        const plan = buildSettledAdvisorExecutionPlan({
          settlement: {
            settlementId: "settlement-b", logicalQuestionUnitId: "lqu-current", revision: 1,
            sessionId: job.expectedSessionId, runtimeEpoch: job.runtimeCommitToken.runtimeEpoch,
            sourceKind: "voice", sourceTurnIds: ["turn-current"], sourceObservationIds: [], sourceHash: "source-b",
            questionType: "coding", relation: "followup-parent", action: "answer", evidenceMode: "unknown",
            authority: "deterministic-fast-path", authoritySource: "accepted-transcript",
            typeAuthoritySource: "deterministic-fast-path", relationAuthoritySource: "deterministic-fast-path",
            actionAuthoritySource: "deterministic-fast-path", typeMutationAuthorized: false,
            relationMutationAuthorized: false, parentMutationAuthorized: false, responseAuthorized: true,
            confidence: 0.95, manualCorrectionRevision: 0, rejectedProposals: [], reasons: ["response-authorized"],
          },
          activeMeetingTask: task, taskBoundaryCommitted: false, childOwnsResponse: false,
          providerSnapshot: { providers: [{ id: "fixture", curl: "https://fixture.invalid" }],
            selectedProvider: { provider: "fixture", variables: {} }, codingProvider: { provider: "", variables: {} } },
          memoryUseCase: "coding_interview", askFrame: "direct-answer", topicDomain: "backend",
          artifactRequest: { hardAnswerOnly: true }, createdAt: 2000,
        });
        const authorized = authorizeRuntimeCommit({
          token: job.runtimeCommitToken,
          currentOperationId: job.id,
          current: { sessionId: "session-a", runtimeEpoch: 1, parentId: task.parent.id, parentRevision: task.parent.revisions },
        });
        assert.equal(authorized.authorized, true);

        const trace = store.startTrace("voice", { advisorJobSource: job.source });
        store.updateMetadata(trace.id, formatRuntimeCommitAuthorizationForTrace(authorized, "pre-publication"));
        const generationLease = { ...harnessModule.lease(), taskRevision: task.parent.revisions,
          requestedArtifacts: plan.requestedArtifacts };
        h.generationResultLedger.begin({ lease: generationLease, traceId: trace.id });
        const queued = h.environment.queuePendingAnswerRevision({
          lease: generationLease,
          suggestion: { ...harnessModule.suggestion("visible-b", "Answer: The queue preserves FIFO order."), sourceTraceId: trace.id },
          authorizedArtifacts: plan.requestedArtifacts, taskId: task.id, resultTaskId: task.id,
          sectionOwner: { kind: "parent-mainline", parentId: task.parent.id }, taskRevision: task.parent.revisions,
          logicalQuestionUnitId: plan.logicalQuestionUnitId, logicalQuestionRevision: plan.logicalQuestionRevision,
          sessionId: plan.sessionId, runtimeEpoch: plan.runtimeEpoch,
          questionSourceHash: plan.sourceHash, settlementId: plan.settlementId,
          settlementSnapshot: { questionType: plan.questionType, relation: plan.relation },
          resetSections: false, reason: "delivery-lock-active", latestUsefulAnswerMutationAuthorized: false,
          taskRuntimeRevision: context.getTaskRuntimeState().revision,
        });
        assert.ok(queued);
        assert.equal(h.environment.tryCommitPendingAnswer(), "waiting");
        assert.equal(store.getTrace(trace.id)?.metadata?.generationResultCommitDisposition, "pending");
        // The trace ends while the answer waits on the delivery lock and is
        // recorded. Where a recording accepts it the projector runs now, over
        // the pending root, before the publication decision below.
        store.finishTrace(trace.id, "success");
        manager.recordTrace(store.getTrace(trace.id)!, "manual");
        let pendingSummary: SessionCompactTraceSummary | undefined;
        if (mode === "active") {
          await disk.drained(manager);
          pendingSummary = await disk.json<SessionCompactTraceSummary>(
            `traces/${trace.id}/summary.json`
          );
        }
        if (stale) h.refs.manualCorrectionRevisionRef.current++;
        h.unlock();
        const disposition = h.environment.tryCommitPendingAnswer();
        assert.equal(disposition, stale ? "stale" : "committed");
        const finished = store.getTrace(trace.id)!;
        manager.refreshRecordedTrace(finished, "manual");
        const callbackObserverCalls = observerCalls;
        if (mode === "active" || mode === "write-failure") await disk.drained(manager);

        assert.deepEqual(plain(context.getState()), before, "publication changes no Type, phase, task or source state");
        // Only wall-clock counters and the two generated ids vary between runs.
        const { commitDurationMs, prepareDurationMs, installDurationMs, ...ledger } =
          h.generationResultLedger.getEntry(generationLease.id);
        assert.equal(ledger.traceId, trace.id);
        for (const duration of [commitDurationMs, prepareDurationMs, installDurationMs]) {
          assert.ok(duration === undefined || (Number.isFinite(duration) && duration >= 0));
        }
        const { generationResultCommitDurationMs, generationResultPrepareDurationMs,
          generationResultInstallDurationMs, ...root } = finished.metadata!;
        const actual = JSON.parse(JSON.stringify({
          plan,
          job: { prompt: job.promptContextSnapshot, authority: job.taskMutationAuthority,
            responseAuthority: job.responseAuthoritySource, mode: job.mode },
          authorized: { authorized: authorized.authorized, reason: authorized.reason },
          disposition,
          stable: h.refs.stableAnswerRevisionRef.current,
          ui: { ...h.uiState, generationResult: undefined },
          display: h.uiState.generationResult?.disposition,
          uiUpdateCount: h.uiUpdates.length,
          ledger,
          providerAttempts: ledger.providerAttempts.length,
          observerCalls: callbackObserverCalls,
          context: context.getState(),
          trace: { kind: finished.kind, status: finished.status, error: finished.error, root, steps: finished.steps },
        }).replaceAll(trace.id, "trace-under-test").replaceAll(job.id, "job-under-test"));
        assert.ok(callbackObserverCalls >= 2, "the callbacks reach the recorder observation boundary");
        if (expected === undefined) expected = actual;
        else assert.deepEqual(actual, expected, `${mode}/stale=${stale}`);

        // The projector ran only where a recording accepted the trace, and what
        // it wrote is the trace root's own last results.
        const summaryWrites = disk.writes.filter(
          (write) => write.relativePath === `traces/${finished.id}/summary.json`
        );
        assert.equal(summaryWrites.length, mode === "active" ? 2 : 0, mode);
        if (mode === "active") {
          // The row written before the decision already carried the groups.
          assert.equal(pendingSummary?.runtimeCommit?.authorized, true);
          assert.equal(pendingSummary?.generationCommit?.disposition, "pending");
          assert.equal(pendingSummary?.generationCommit?.reason, "delivery-lock-active");
          const summary = await disk.json<SessionCompactTraceSummary>(`traces/${finished.id}/summary.json`);
          assert.deepEqual(summary.runtimeCommit, rootRuntimeCommit(finished.metadata!));
          assert.deepEqual(summary.generationCommit, rootGenerationCommit(finished.metadata!));
          assert.equal(summary.generationCommit?.disposition, stale ? "rejected" : "committed");
          assert.equal(summary.screenOperation, undefined);
        }
        if (mode === "disabled") assert.equal(disk.writes.length, 0);
        if (mode === "write-failure") {
          assert.equal(manager.getState().active, true);
          assert.match(manager.getState().lastError ?? "", /controlled write failure/);
        }
      } finally {
        h.restore();
        disk.failWrite = () => false;
        await manager.stop("fixture-cleanup").catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

test("OV152-5 no runtime module reads the groups; the projector adds no await, model call or event", () => {
  // Every property read or destructuring of the three group names under src/.
  const readers: string[] = [];
  const sourceFiles = readdirSync("src", { recursive: true, encoding: "utf8" }).filter(
    (file) => /\.(ts|tsx)$/.test(file) && !file.endsWith(".d.ts")
  );
  assert.ok(sourceFiles.includes(path.join("lib", "meeting", "session-recording.ts")));
  assert.ok(sourceFiles.includes(path.join("hooks", "useMeetingAssistant.ts")));
  const groupNames = new Set<string>(GROUP_KEYS);
  for (const file of sourceFiles) {
    const source = ts.createSourceFile(file, readFileSync(path.join("src", file), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      const read =
        (ts.isPropertyAccessExpression(node) && groupNames.has(node.name.text)) ||
        (ts.isElementAccessExpression(node) &&
          ts.isStringLiteralLike(node.argumentExpression) &&
          groupNames.has(node.argumentExpression.text)) ||
        (ts.isBindingElement(node) &&
          ts.isObjectBindingPattern(node.parent) &&
          groupNames.has((node.propertyName ?? node.name).getText(source)));
      if (read) readers.push(`${file}: ${node.getText(source)}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(readers, []);

  // The three projectors are synchronous leaf functions over the root record.
  const recorder = ts.createSourceFile(
    "session-recording.ts",
    readFileSync("src/lib/meeting/session-recording.ts", "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const projectors = recorder.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) &&
      /^build(RuntimeCommit|ScreenOperation|GenerationCommit)Evidence$/.test(node.name?.text ?? "")
  );
  assert.equal(projectors.length, 3);
  const familyOf = (name: string) =>
    (name.charAt(5).toLowerCase() + name.slice(6, -"Evidence".length)) as (typeof GROUP_KEYS)[number];
  for (const projector of projectors) {
    assert.equal(projector.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false, false);
    assert.equal(projector.parameters.length, 1);
    assert.equal(projector.parameters[0]!.name.getText(recorder), "root");
    const calls = new Set<string>();
    const rootKeys = new Set<string>();
    const visit = (node: ts.Node) => {
      assert.equal(ts.isAwaitExpression(node), false);
      assert.equal(ts.isNewExpression(node), false);
      assert.equal(ts.isElementAccessExpression(node), false);
      if (ts.isCallExpression(node)) calls.add(node.expression.getText(recorder));
      // The root is only ever read one named key at a time: never passed on,
      // spread, indexed or enumerated.
      if (ts.isIdentifier(node) && node.text === "root" && !ts.isParameter(node.parent)) {
        assert.ok(
          ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node,
          node.parent.getText(recorder)
        );
        rootKeys.add(node.parent.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(projector);
    for (const call of calls) assert.match(call, /^read(String|Boolean)$/);
    // Exactly its own family's keys: no adjacent key, no other family's key.
    const family = familyOf(projector.name!.text);
    assert.deepEqual(
      [...rootKeys].sort(),
      Object.values(EVIDENCE_ROOT_KEYS[family]).sort(),
      projector.name!.text
    );
  }
  // Each projector is called once, by the compact builder, with the root only,
  // and its return value is the group as is: nothing is added after the call.
  const text = recorder.getFullText();
  for (const projector of projectors) {
    const name = projector.name!.text;
    assert.deepEqual(text.match(new RegExp(`${name}\\([^)]*\\)`, "g"))?.filter((call) => !call.includes(":")), [
      `${name}(trace.metadata)`,
    ]);
    const assignments: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(recorder) === familyOf(name) &&
        node.initializer.getText(recorder).includes(name)
      ) {
        assignments.push(node.initializer.getText(recorder));
      }
      ts.forEachChild(node, visit);
    };
    visit(recorder);
    assert.deepEqual(assignments, [`${name}(trace.metadata)`], name);
  }
});

test("OV152-5 the same trace with and without the groups produces the same writes and event kinds", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-ov152-writes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { screen } = produceEvidenceTraces();
  const resultKeys = [
    "runtimeCommitAuthorized",
    "screenOperationDisposition",
    "generationResultCommitDisposition",
  ];
  const bare = {
    ...screen,
    metadata: Object.fromEntries(
      Object.entries(screen.metadata!).filter(([key]) => !resultKeys.includes(key))
    ),
  };
  assert.deepEqual(Object.keys(groupsOf(screen)), [...GROUP_KEYS]);
  assert.deepEqual(groupsOf(bare), {});
  // Building a summary never changes the trace it reads.
  const frozen = structuredClone(screen);
  compact(screen);
  assert.deepEqual(screen, frozen);

  const record = async (trace: MeetingTrace, label: string) => {
    const disk = new DiskRecording(path.join(root, label));
    const manager = new SessionRecordingManager(undefined, disk.invoke);
    await manager.start(START_OPTIONS);
    const startedAt = Date.now();
    const rebased = { ...trace, startedAt, endedAt: startedAt + 5 };
    manager.recordTrace(rebased, "manual");
    manager.refreshRecordedTrace(rebased, "manual");
    await manager.stop("ov152");
    const timeline = (await readFile(path.join(disk.folder, "timeline.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { kind: string }).kind);
    return {
      writes: disk.writes.map((write) => `${write.append ? "append" : "write"} ${write.relativePath}`),
      timeline,
      state: manager.getState(),
    };
  };
  const withGroups = await record(screen, "with-groups");
  const without = await record(bare, "without-groups");
  assert.deepEqual(withGroups.writes, without.writes);
  assert.deepEqual(withGroups.timeline, without.timeline);
  assert.equal(withGroups.state.eventCount, without.state.eventCount);
  assert.equal(withGroups.state.artifactCount, without.state.artifactCount);
  assert.equal(withGroups.state.lastError, undefined);
  assert.equal(
    withGroups.writes.filter((write) => write.endsWith(`traces/${screen.id}/summary.json`)).length,
    2
  );
});

test("OV152-5 the Debug logging switch does not change what is projected", (t) => {
  const info = t.mock.method(console, "info", () => {});
  const project = (debug: boolean) => {
    const runtime = createRuntime();
    runtime.store.setDebugEnabled(debug);
    const first = admitScreenOperation(runtime, "screen-debug-a", { lease: false });
    const second = admitScreenOperation(runtime, "screen-debug-b", { lease: false });
    assert.equal(first.rejectStaleScreenOperation("post-capture"), true);
    assert.equal(second.rejectStaleScreenOperation("pre-commit"), false);
    second.commitFinal(undefined, { reason: "stable-answer-candidate-invalid" }, undefined);
    runtime.store.finishTrace(second.trace.id, "success");
    const attempt = startVoiceAttempt(runtime, "job-debug");
    runtime.world.runtimeEpoch += 1;
    assert.equal(attempt.rejectStaleCommit("pre-commit"), true);
    return [first, second, attempt].map(({ trace }) => groupsOf(runtime.exported(trace.id)));
  };
  const quiet = project(false);
  assert.equal(info.mock.callCount(), 0);
  const verbose = project(true);
  assert.ok(info.mock.callCount() > 0);
  assert.deepEqual(verbose, quiet);
  assert.deepEqual(quiet, [
    {
      runtimeCommit: {
        operationId: "screen-debug-a",
        pipeline: "screen",
        stage: "post-capture",
        authorized: false,
        reason: "pipeline-owner-mismatch",
      },
      screenOperation: {
        operationId: "screen-debug-a",
        disposition: "superseded",
        supersededByOperationId: "screen-debug-b",
      },
    },
    {
      runtimeCommit: {
        operationId: "screen-debug-b",
        pipeline: "screen",
        stage: "pre-commit",
        authorized: true,
        reason: "authorized",
      },
      screenOperation: {
        operationId: "screen-debug-b",
        disposition: "rejected",
        commitReason: "stable-answer-candidate-invalid",
      },
    },
    {
      runtimeCommit: {
        operationId: "job-debug",
        pipeline: "advisor",
        stage: "pre-commit",
        authorized: false,
        reason: "runtime-epoch-mismatch",
      },
    },
  ]);
});

// ---------------------------------------------------------------------------
// OV152-6 version and cost
// ---------------------------------------------------------------------------

test("OV152-6 summary schema and derivation version are explicit and reported with coverage and limits", () => {
  const { allowed } = produceEvidenceTraces();
  const summary = compact(allowed);
  assert.equal(summary.version, 45);
  assert.equal(LAST_RETAINED_RUNTIME_EVIDENCE_FIRST_SUMMARY_SCHEMA, 45);
  assert.equal(LAST_RETAINED_RUNTIME_EVIDENCE_DERIVATION_VERSION, "last-retained-runtime-evidence-v1");

  const report = reportFor([stored(summary) as LongitudinalTraceSummary]);
  const evidence = report.lastRetainedRuntimeEvidence;
  assert.equal(evidence.derivationVersion, "last-retained-runtime-evidence-v1");
  assert.equal(evidence.firstSummarySchemaVersion, 45);
  assert.ok(summary.version >= evidence.firstSummarySchemaVersion);
  assert.equal(evidence.countingUnit, "last-retained-result-per-trace-per-family");
  assert.deepEqual(Object.keys(evidence.families), [...GROUP_KEYS]);
  assert.deepEqual(evidence.coverageBySummaryVersion, [
    {
      summaryVersion: 45,
      groupsConsumed: true,
      selectedTraceCount: 1,
      availability: {
        runtimeCommit: { numerator: 1, denominator: 1, rate: 1 },
        screenOperation: { numerator: 0, denominator: 1, rate: 0 },
        generationCommit: { numerator: 1, denominator: 1, rate: 1 },
      },
      ignoredGroupCount: 0,
    },
  ]);
  assert.equal(evidence.limits.length, 10);

  const section = diagnosticSection(renderSessionLongitudinalEvaluationMarkdown(report));
  assert.match(section, /Derivation: last-retained-runtime-evidence-v1; groups exist from compact summary schema 45/);
  assert.match(section, /\| 45 \| yes \| 1 \| 100\.0% \(1\/1\) \| 0\.0% \(0\/1\) \| 100\.0% \(1\/1\) \| 0 \|/);
  for (const limit of evidence.limits) assert.ok(section.includes(`- ${limit}`));
  assert.match(section, /not the rejection rate of all validation calls/);
  assert.match(section, /no product success rate or human truth reads this section/);
  // The limits the brief names: overwritten earlier calls, short-circuited
  // checks, stages that prove nothing about other stages, unknown versions,
  // family independence, Screen reasons by contract and the journal.
  assert.match(section, /Earlier calls on the same Trace were overwritten and are not counted/);
  assert.match(section, /Checks it did not reach after that short circuit were not evaluated and are not recorded/);
  assert.match(section, /A stage bucket shows where the last retained call ran, not which other stages ran/);
  assert.match(section, /A result without a stage is listed under `\(not provided\)` and is not assigned to any stage/);
  assert.match(section, /The `unknown` row also holds a Trace that has a raw export but no compact summary row/);
  assert.match(section, /History is not rebuilt from raw traces/);
  assert.match(section, /is not counted as a missing reason/);
  assert.match(section, /keeps a Trace's first recorded row, can show an earlier result and is not read here/);

  // The diagnostic is one more key. Every other part of the report is the same
  // with or without the groups, so no product rate depends on them.
  const strip = (value: ReturnType<typeof reportFor>) => {
    const { lastRetainedRuntimeEvidence, generatedAt, ...rest } = value;
    return rest;
  };
  const traces = Object.values(produceEvidenceTraces()).map(
    (trace) => stored(compact(trace)) as LongitudinalTraceSummary
  );
  assert.deepEqual(strip(reportFor(traces)), strip(reportFor(traces.map(withoutGroups))));
});

test("OV152-6 fixed traces: the byte delta is exactly the three groups and the write count is unchanged", async (t) => {
  const traces = produceEvidenceTraces();
  const rows = Object.entries(traces).map(([label, trace]) => {
    const summary = compact(trace);
    const full = JSON.stringify(summary);
    const base = JSON.stringify(withoutGroups(summary));
    const groups = groupsOf(trace);
    const members = GROUP_KEYS.filter((key) => groups[key]).map(
      (key) => `,${JSON.stringify(key)}:${JSON.stringify(groups[key])}`
    );
    assert.equal(full.length - base.length, members.join("").length, label);
    return { label, summaryBytes: Buffer.byteLength(full), groupBytes: Buffer.byteLength(members.join("")) };
  });
  assert.equal(rows.find((row) => row.label === "silent")?.groupBytes, 0);

  // One summary write per export and one journal line per trace, as before.
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-ov152-cost-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const disk = new DiskRecording(root);
  const manager = new SessionRecordingManager(undefined, disk.invoke);
  await manager.start(START_OPTIONS);
  const startedAt = Date.now();
  const recorded = Object.values(traces).map((trace) => ({ ...trace, startedAt, endedAt: startedAt + 5 }));
  for (const trace of recorded) manager.recordTrace(trace, "manual");
  await disk.drained(manager);
  for (const trace of recorded) {
    assert.equal(disk.writes.filter((write) => write.relativePath === `traces/${trace.id}/summary.json`).length, 1);
    assert.equal(disk.writes.filter((write) => write.relativePath === `traces/${trace.id}.json`).length, 1);
  }
  assert.equal(disk.writes.filter((write) => write.relativePath === "metrics/trace-summaries.jsonl").length, recorded.length);
  await manager.stop("ov152");
  t.diagnostic(JSON.stringify({ fixedTraceSummaryBytes: rows }));
});

// ===========================================================================
// Task 178A (AE1, AE2): explicit terminals of the generation result and of the
// Screen operation, from their own owners. The Hook's real projection writer,
// terminalizer and Screen authorization guard run against the real ledger and
// the real Screen operation coordinator; no event is built by this test.
// ===========================================================================

test("AE1/AE2 generation terminal: a started or pending lease has none; the ledger's first terminal is announced once with its own disposition", () => {
  const runtime = createRuntime();
  const events = () => runtime.criticalEvents.events();
  const voice = startVoiceAttempt(runtime, "job-a", { lease: true });
  assert.ok(voice.lease);
  assert.deepEqual(events(), [], "a started lease is not a terminal");
  runtime.markGenerationPending(voice.lease, voice.trace.id);
  assert.deepEqual(events(), [], "a pending answer is not a terminal");
  const commit = runtime.commitGeneration(voice.lease, voice.trace.id);
  assert.equal(commit.committed, true);
  assert.deepEqual(runtime.criticalEvents.facts(), ["terminal:generation:committed"]);
  const [committed] = events();
  assert.equal(committed.stage, "generation-result");
  assert.equal(committed.terminal?.reason, "authorized");
  assert.equal(committed.runtimeSessionId, voice.lease.sessionId);
  assert.equal(committed.runtimeEpoch, voice.lease.runtimeEpoch);
  assert.deepEqual({ ...committed.refs }, {
    traceId: voice.trace.id, logicalQuestionUnitId: "question-a", taskId: "parent-a",
    generationLeaseId: voice.lease.id, logicalQuestionRevision: 1,
    stableRevision: runtime.world.visibleAnswerRevision,
  });
  assert.equal(committed.occurredAt, runtime.ledger.getEntry(voice.lease.id)?.terminalization?.terminalizedAt);
  // The projection runs again for a terminal lease, and a later terminalize
  // cannot replace the first terminal: neither is a second fact.
  runtime.publishGenerationResultProjection(voice.lease, voice.trace.id);
  runtime.terminalizeGenerationLease({ lease: voice.lease, disposition: "superseded",
    reason: "late", source: "test", authority: "test", traceId: voice.trace.id });
  assert.equal(events().length, 1);

  // A rejected candidate is the generation's own rejected terminal, never a commit.
  const second = startVoiceAttempt(runtime, "job-b", { lease: true });
  assert.ok(second.lease);
  const rejected = runtime.commitGeneration(second.lease, second.trace.id, { candidateAccepted: false });
  assert.equal(rejected.committed, false);
  // A superseded generation carries the owner's reason.
  const third = startVoiceAttempt(runtime, "job-c", { lease: true });
  assert.ok(third.lease);
  runtime.terminalizeGenerationLease({ lease: third.lease, disposition: "superseded",
    reason: "newer-logical-question", source: "advisor-job", authority: "latest-wins", traceId: third.trace.id });
  assert.deepEqual(events().slice(1).map((event) =>
    [event.terminal?.object, event.terminal?.disposition, event.refs.generationLeaseId, event.refs.stableRevision]), [
    ["generation", "rejected", second.lease.id, undefined],
    ["generation", "superseded", third.lease.id, undefined],
  ]);
  assert.equal(events()[2]!.terminal?.reason, "newer-logical-question");
  assert.equal(events().every((event) => event.fact === "terminal" && event.purpose === "formal"), true,
    "a generation terminal is not a Stable Answer fact and not a visible fact");
  const sequences = events().map((event) => event.sequence);
  assert.deepEqual(sequences, [1, 2, 3]);
});

test("AE1/AE2 Screen operation terminal: a passing guard emits nothing; a stale or superseded operation is announced once by its own authorization boundary, before its generation terminal", () => {
  const stale = createRuntime();
  const operation = admitScreenOperation(stale, "screen-stale");
  assert.equal(operation.rejectStaleScreenOperation("pre-visible-commit"), false);
  assert.deepEqual(stale.criticalEvents.events(), [], "an authorized operation has no terminal");
  stale.world.runtimeEpoch += 1;
  assert.equal(operation.rejectStaleScreenOperation("error-boundary"), true);
  assert.equal(operation.rejectStaleScreenOperation("error-boundary"), true);
  assert.deepEqual(stale.criticalEvents.facts(), [
    "terminal:screen-operation:stale-rejected",
    "terminal:generation:rejected",
  ]);
  const [screenTerminal, generationTerminal] = stale.criticalEvents.events();
  assert.equal(screenTerminal!.terminal?.reason, "runtime-epoch-mismatch");
  assert.equal(screenTerminal!.refs.operationId, "screen-stale");
  assert.equal(screenTerminal!.refs.traceId, operation.trace.id);
  assert.equal(screenTerminal!.refs.generationLeaseId, operation.screenGenerationLease?.id);
  // The operation's own epoch, not the epoch that made it stale.
  assert.equal(screenTerminal!.runtimeEpoch, 1);
  assert.equal(stale.world.runtimeEpoch, 2);
  assert.equal(generationTerminal!.runtimeEpoch, 1);
  assert.equal(generationTerminal!.refs.generationLeaseId, operation.screenGenerationLease?.id);

  const superseded = createRuntime();
  const older = admitScreenOperation(superseded, "screen-older");
  const newer = admitScreenOperation(superseded, "screen-newer");
  assert.equal(newer.rejectStaleScreenOperation("pre-visible-commit"), false);
  assert.equal(older.rejectStaleScreenOperation("post-model"), true);
  const terminals = superseded.criticalEvents.events().filter((event) => event.terminal?.object === "screen-operation");
  assert.deepEqual(terminals.map((event) => [event.refs.operationId, event.terminal?.disposition, event.terminal?.reason]),
    [["screen-older", "superseded", "pipeline-owner-mismatch"]]);
});
