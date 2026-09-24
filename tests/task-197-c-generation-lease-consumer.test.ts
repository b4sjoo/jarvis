import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import {
  authorizeAnswerGenerationLease,
  createAnswerGenerationLease,
  formatAnswerGenerationLeaseForTrace,
} from "../src/lib/meeting/answer-generation-lease.js";

const hookPath = "src/hooks/useMeetingAssistant.ts";
const source = ts.createSourceFile(
  hookPath,
  readFileSync(hookPath, "utf8"),
  ts.ScriptTarget.Latest,
  true
);

function findAll(predicate: (node: ts.Node) => boolean): ts.Node[] {
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return matches;
}

function declaration(name: string): ts.VariableDeclaration {
  const matches = findAll(
    (node) =>
      ts.isVariableDeclaration(node) && node.name.getText(source) === name
  );
  assert.equal(matches.length, 1, name);
  return matches[0] as ts.VariableDeclaration;
}

function productionGuard(name: string, env: Record<string, unknown>): (stage: string) => boolean {
  const initializer = declaration(name).initializer;
  assert.ok(initializer, name);
  const compiled = ts.transpileModule(`return ${initializer.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return Function(...Object.keys(env), compiled)(...Object.values(env));
}

test("197C retains Plan authority and records lease creation without a prediction", () => {
  assert.ok(declaration("planCreationAuthorization"));
  assert.equal(
    findAll(
      (node) =>
        ts.isVariableDeclaration(node) &&
        ["leaseStartAuthorization", "screenLeaseStartAuthorization"].includes(
          node.name.getText(source)
        )
    ).length,
    0
  );
  const created = findAll(
    (node) =>
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "formatAnswerGenerationLeaseForTrace" &&
      node.arguments[2]?.getText(source) === '"lease-created"'
  ) as ts.CallExpression[];
  assert.equal(created.length, 2);
  assert.ok(created.every((call) => call.arguments[1]?.getText(source) === "undefined"));
  assert.equal(
    findAll(
      (node) =>
        ts.isCallExpression(node) &&
        ["rejectStaleCommit", "rejectStaleScreenOperation"].includes(
          node.expression.getText(source)
        ) &&
        node.arguments[0]?.getText(source) === '"generation-lease-start"'
    ).length,
    2
  );
});

function fixture(kind: "voice" | "screen") {
  const lease = createAnswerGenerationLease({
    sessionId: "session-a",
    runtimeEpoch: 1,
    preparationContextRevision: 1,
    taskId: "parent-a",
    taskRevision: 1,
    logicalQuestionUnitId: "question-a",
    logicalQuestionRevision: 1,
    baseVisibleAnswerRevision: 1,
    sourceTurnIds: ["turn-a"],
    manualCorrectionRevision: 0,
    responseActionRevision: 0,
    modelRoute: "fixture",
    artifactOwnerId: "parent-a",
    requestedArtifacts: ["answer"],
  });
  const current = {
    sessionId: "session-a",
    runtimeEpoch: 1,
    preparationContextRevision: 1,
    taskId: "parent-a",
    taskRevision: 1,
    logicalQuestionUnitId: "question-a",
    logicalQuestionRevision: 1,
    visibleAnswerRevision: 1,
    manualCorrectionRevision: 0,
    responseActionRevision: 0,
    authorizedArtifacts: ["answer"] as "answer"[],
  };
  const metadata: Record<string, unknown> = {};
  const terminal: unknown[] = [];
  const recovery = { current: true };
  let authorizationCalls = 0;
  const trace = { id: "trace-a", status: "running", steps: [] };
  const traceStore = {
    updateMetadata: (_id: string, update: Record<string, unknown>) =>
      Object.assign(metadata, update),
    getTraces: () => [trace],
    finishTrace: (_id: string, status: string, reason: string) =>
      terminal.push({ status, reason }),
  };
  const parent = () => ({ id: current.taskId, revisions: current.taskRevision });
  const contextManagerRef = {
    current: {
      getState: () => ({
        sessionId: current.sessionId,
        activeMeetingTask: { parent: parent() },
      }),
    },
  };
  const env: Record<string, unknown> = {
    answerGenerationLease: lease,
    screenGenerationLease: lease,
    generationAuthorizedArtifacts: current.authorizedArtifacts,
    screenGenerationRequestedArtifacts: current.authorizedArtifacts,
    contextManagerRef,
    runtimeEpochRef: { get current() { return current.runtimeEpoch; } },
    preparationRuntimeContextRef: {
      current: { get preparationContextRevision() { return current.preparationContextRevision; } },
    },
    visibleAnswerRevisionRef: { get current() { return current.visibleAnswerRevision; } },
    manualCorrectionRevisionRef: { get current() { return current.manualCorrectionRevision; } },
    responseActionRevisionRef: { get current() { return current.responseActionRevision; } },
    readLogicalQuestionAuthorizationTarget: () => ({
      logicalQuestionUnit: {
        id: current.logicalQuestionUnitId,
        revision: current.logicalQuestionRevision,
      },
    }),
    authorizeAnswerGenerationLease: (...args: Parameters<typeof authorizeAnswerGenerationLease>) => {
      authorizationCalls++;
      return authorizeAnswerGenerationLease(...args);
    },
    formatAnswerGenerationLeaseForTrace,
    traceStoreRef: { current: traceStore },
    traceId: trace.id,
    trace,
    readCommitDecision: () => ({ authorized: true, reason: "authorized" }),
    readScreenAuthorization: () => ({ authorized: true, reason: "authorized" }),
    formatRuntimeCommitAuthorizationForTrace: () => ({}),
    logicalQuestionLease: undefined,
    settledExecutionPlan: undefined,
    selectedQuestionOnly: false,
    advisorJob: { id: "job-a", source: "live-turn" },
    activeAdvisorJobRef: { current: { id: "job-a" } },
    terminalizeGenerationLease: (value: unknown) => terminal.push(value),
    terminalizeAuthorizationRejection: (value: unknown) => terminal.push(value),
    updateForceAdviseTargetForAdvisorOutcome: () => {},
    finishRunningAdvisorJobTrace: () => {},
    releaseAdvisorJob: () => {},
    formatAdvisorTriggerJobForTrace: () => ({}),
    options: {},
    setState: () => {},
    boundVisualRecoveryFact: kind === "screen" ? { id: "recovery-a" } : undefined,
    readCurrentVisualRecoveryFact: () =>
      recovery.current ? { id: "recovery-a" } : undefined,
    screenSourceOwnedTransitionReceipt: undefined,
    sourceOwnedDurableTransitionSurvivesModelOutcome: () => false,
    formatSourceOwnedDurableTransitionForTrace: () => ({}),
    screenOperationCoordinatorRef: {
      current: {
        getActiveOperationId: () => "screen-a",
        getActiveOperation: () => ({ traceId: trace.id }),
      },
    },
    screenModelCompletedAt: undefined,
    screenResponseCandidate: undefined,
    screenTerminalError: null,
    recordScreenQuestionTypeOutcome: () => {},
  };
  const guard = productionGuard(
    kind === "voice" ? "rejectStaleCommit" : "rejectStaleScreenOperation",
    env
  );
  return {
    lease,
    current,
    metadata,
    terminal,
    recovery,
    guard,
    authorizationCalls: () => authorizationCalls,
  };
}

test("197C Screen recovery revocation still rejects after a valid lease check", () => {
  const run = fixture("screen");
  run.recovery.current = false;
  assert.equal(run.guard("generation-lease-start"), true);
  assert.equal(run.authorizationCalls(), 1);
  assert.equal(run.metadata.leaseAuthorizedAtStart, true);
  assert.equal(run.metadata.sourceLinkageBoundSourceStillCurrent, false);
  assert.ok(run.terminal.length > 0);
});

for (const kind of ["voice", "screen"] as const) {
  test(`197C ${kind} final guard rejects changed lease and reports its own result`, () => {
    const run = fixture(kind);
    const creation = formatAnswerGenerationLeaseForTrace(
      run.lease,
      undefined,
      "lease-created"
    );
    assert.equal(creation.leaseAuthorizedAtStart, undefined);
    run.current.visibleAnswerRevision++;
    assert.equal(run.guard("generation-lease-start"), true);
    assert.equal(run.authorizationCalls(), 1);
    assert.equal(run.metadata.leaseAuthorizedAtStart, false);
    assert.equal(run.metadata.staleReason, "visible-answer-revision-mismatch");
    assert.ok(run.terminal.length > 0);
  });

  test(`197C ${kind} final guard accepts restored state without caching early rejection`, () => {
    const run = fixture(kind);
    run.current.visibleAnswerRevision++;
    assert.equal(
      authorizeAnswerGenerationLease(run.lease, {
        ...run.current,
        artifactOwnerId: run.current.taskId,
      }).authorized,
      false
    );
    run.current.visibleAnswerRevision--;
    assert.equal(run.guard("generation-lease-start"), false);
    assert.equal(run.authorizationCalls(), 1);
    assert.equal(run.metadata.leaseAuthorizedAtStart, true);
    assert.equal(run.terminal.length, 0);
  });
}
