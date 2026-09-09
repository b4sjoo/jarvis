import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { authorizeAnswerGenerationLease } from "../src/lib/meeting/answer-generation-lease.js";
import { authorizeRuntimeCommit, createRuntimeCommitToken } from "../src/lib/meeting/runtime-commit-authorization.js";
import { authorizeSettledAdvisorExecutionPlan, buildSettledAdvisorExecutionPlan } from "../src/lib/meeting/settled-advisor-execution-plan.js";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import type { CurrentQuestionSettlementDecision } from "../src/lib/meeting/current-question-settlement.js";

// Keep the former compensation test path, but exercise replacement behavior.
// Reuse the actual publication callbacks; never import the retired rebase.
async function publicationHarness() {
  const source = readFileSync("tests/pending-answer-publication-callback.test.mjs", "utf8");
  const parsed = ts.createSourceFile("publication.mjs", source, ts.ScriptTarget.Latest, true);
  const firstTest = parsed.statements.find((node) => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && node.expression.expression.getText(parsed) === "test");
  assert.ok(firstTest);
  return import(`data:text/javascript;base64,${Buffer.from(source.slice(0, firstTest.getStart(parsed))
    + "\nexport { createHarness, prepareOutputCandidate, publishImmediate, queueOutputCandidate };\n").toString("base64")}`);
}

function settlement(): CurrentQuestionSettlementDecision {
  return {
    settlementId: "settlement-b", logicalQuestionUnitId: "lqu-next", revision: 1,
    sessionId: "session-a", runtimeEpoch: 1, sourceKind: "voice",
    sourceTurnIds: ["turn-next"], sourceObservationIds: [], sourceHash: "source-b",
    questionType: "coding", relation: "followup-parent", action: "answer", evidenceMode: "unknown",
    authority: "runtime-adjudication", authoritySource: "runtime-adjudication",
    typeAuthoritySource: "runtime-adjudication", relationAuthoritySource: "runtime-adjudication",
    actionAuthoritySource: "runtime-adjudication", typeMutationAuthorized: false,
    relationMutationAuthorized: false, parentMutationAuthorized: false, responseAuthorized: true,
    confidence: 0.95, manualCorrectionRevision: 0, rejectedProposals: [], reasons: ["same-parent-followup"],
  };
}

function makePlan(task: ActiveMeetingTask) {
  return buildSettledAdvisorExecutionPlan({
    settlement: settlement(), activeMeetingTask: task, taskBoundaryCommitted: false, childOwnsResponse: false,
    providerSnapshot: { providers: [{ id: "main", curl: "https://fixture.invalid" }],
      selectedProvider: { provider: "main", variables: {} }, codingProvider: { provider: "", variables: {} } },
    memoryUseCase: "coding_interview", askFrame: "direct-answer", topicDomain: "backend",
    sourceQuestion: "Explain the next queue invariant", artifactRequest: { hardAnswerOnly: true }, createdAt: 60_000,
  });
}

function planAuthorization(plan: ReturnType<typeof makePlan>, task: ActiveMeetingTask, sourceHash = "source-b") {
  return authorizeSettledAdvisorExecutionPlan({
    plan, currentSettlement: settlement(), currentSessionId: "session-a", currentRuntimeEpoch: 1,
    currentLogicalQuestionUnitId: "lqu-next", currentLogicalQuestionRevision: 1,
    currentSourceHash: sourceHash, currentActiveMeetingTask: task,
  });
}

test("O2: earlier same-owner LQU publication leaves task token and Plan valid, while Visible dependency still rejects", async () => {
  const api = await publicationHarness();
  const h = api.createHarness({ now: 60_000 });
  try {
    const before = h.manager.getTaskRuntimeState();
    const task = h.manager.getState().activeMeetingTask;
    const plan = makePlan(task);
    const planBefore = JSON.stringify(plan);
    const token = createRuntimeCommitToken({ operationId: "job-next", pipeline: "advisor", snapshot: {
      sessionId: "session-a", runtimeEpoch: 1, parentId: task.parent.id, parentRevision: task.parent.revisions,
    } });
    const tokenBefore = JSON.stringify(token);
    const nextPreparedBeforeFirstCommit = api.prepareOutputCandidate(h, { id: "next-answer", leaseId: "lease-next", lqu: "lqu-next" });
    const first = api.prepareOutputCandidate(h, { id: "first-answer", leaseId: "lease-first" });
    assert.equal(api.publishImmediate(h, first).result.committed, true);
    assert.deepEqual(h.manager.getTaskRuntimeState(), before);
    assert.equal(h.refs.visibleAnswerRevisionRef.current, 2);
    assert.equal(h.manager.getTaskDeadlineControl().parent.deadline, 660_000);

    const currentTask = h.manager.getState().activeMeetingTask;
    assert.equal(authorizeRuntimeCommit({ token, currentOperationId: "job-next", current: {
      sessionId: "session-a", runtimeEpoch: 1, parentId: currentTask.parent.id, parentRevision: currentTask.parent.revisions,
    } }).authorized, true);
    assert.equal(planAuthorization(plan, currentTask).authorized, true);
    assert.equal(JSON.stringify(token), tokenBefore);
    assert.equal(JSON.stringify(plan), planBefore);

    const lease = nextPreparedBeforeFirstCommit.generationLease;
    const observed = h.environment.readGenerationLeaseSnapshot({ lease, authorizedArtifacts: ["answer"],
      candidateMutatedArtifacts: ["answer"], logicalQuestionUnitId: "lqu-next", logicalQuestionRevision: 1 });
    assert.equal(authorizeAnswerGenerationLease(lease, observed).reason, "visible-answer-revision-mismatch");
    const published = h.refs.stableAnswerRevisionRef.current;
    assert.equal(api.publishImmediate(h, nextPreparedBeforeFirstCommit).result.committed, false);
    assert.equal(h.refs.stableAnswerRevisionRef.current, published);

    // A later lawful construction observes current Visible; no old lease is rebased.
    h.refs.logicalQuestionUnitRef.current = { id: "lqu-next", revision: 1 };
    const fresh = api.prepareOutputCandidate(h, { id: "next-current-visible", leaseId: "lease-next-fresh", lqu: "lqu-next" });
    assert.equal(api.publishImmediate(h, fresh).result.committed, true);
    assert.equal(h.refs.visibleAnswerRevisionRef.current, 3);
    assert.equal(h.refs.stableAnswerRevisionRef.current.logicalQuestionUnitId, "lqu-next");
    assert.deepEqual(h.manager.getTaskRuntimeState(), before);
    assert.equal(planAuthorization(plan, h.manager.getState().activeMeetingTask).authorized, true);
  } finally { h.restore(); }
});

test("O2: task phase/source changes and correction/Visible drift retain distinct rejection boundaries", async () => {
  const api = await publicationHarness();
  for (const drift of ["phase", "source", "correction", "visible", "preparation", "lqu"]) {
    const h = api.createHarness({ now: 60_000 });
    try {
      const task = h.manager.getState().activeMeetingTask;
      const plan = makePlan(task);
      const candidate = api.prepareOutputCandidate(h);
      api.queueOutputCandidate(h, candidate);
      const runtime = h.manager.getTaskRuntimeState();
      if (drift === "phase") {
        assert.equal(h.manager.commitTaskRuntimeTransition({
          id: "phase", transition: "set-phase", reason: "accepted-phase", parent: {
            ...runtime.parent, playbookPhase: "optimized_pseudocode", revisions: runtime.parent.revisions + 1,
          },
        }).authorized, true);
        assert.equal(planAuthorization(plan, h.manager.getState().activeMeetingTask).authorized, false);
      }
      if (drift === "source") {
        h.refs.logicalQuestionUnitRef.current = { id: "lqu-current", revision: 2 };
        assert.equal(planAuthorization(plan, task, "changed-source").authorized, false);
      }
      if (drift === "correction") h.refs.manualCorrectionRevisionRef.current++;
      if (drift === "visible") h.refs.visibleAnswerRevisionRef.current++;
      if (drift === "preparation") h.refs.preparationRuntimeContextRef.current.preparationContextRevision++;
      if (drift === "lqu") h.refs.logicalQuestionUnitRef.current = { id: "different-question", revision: 1 };
      const deadlines = h.manager.getTaskDeadlineControl();
      const output = h.refs.recentAdvisorContinuityRef.current;
      h.unlock();
      assert.equal(h.environment.tryCommitPendingAnswer(), "stale", drift);
      assert.equal(h.refs.stableAnswerRevisionRef.current.suggestion.id, "visible-a");
      assert.equal(h.refs.recentAdvisorContinuityRef.current, output);
      assert.deepEqual(h.manager.getTaskDeadlineControl(), deadlines);
    } finally { h.restore(); }
  }
});

test("O5.8: pure-generation task writer and same-owner compensation are retired", () => {
  const hook = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
  assert.doesNotMatch(hook, /trySameOwnerAnswerCommitRebase|decideSameOwnerAnswerCommitRebase|same-owner-answer-commit-rebase/);
  assert.doesNotMatch(readFileSync("src/lib/meeting/interview-task-continuity.ts", "utf8"), /commitVisibleUsefulAnswerToParent/);
  assert.equal(existsSync("src/lib/meeting/same-owner-answer-commit-rebase.ts"), false);
});
