import assert from "node:assert/strict";
import test from "node:test";
import { buildQuestionTypeAdjudicationOutcomeReport as build, type QuestionTypeAdjudicationRecordedDecision } from "../scripts/lib/question-type-adjudication-outcome.js";

const decision: QuestionTypeAdjudicationRecordedDecision = { recordedAt: 1, sessionId: "session_recording_a", traceId: "type", metadata: {
  questionTypeAdjudicationOperationId: "T", questionTypeAdjudicationParseValid: false,
  questionTypeAdjudicationCandidateType: "unknown", questionTypeAdjudicationRetryAttemptCount: 1,
  questionTypeAdjudicationAttempts: [{ parseDisposition: "truncated-json", questionTypeAdjudicationProviderOutcomeStatus: "success" },
    { parseDisposition: "not-run-provider-error-content", questionTypeAdjudicationProviderOutcomeStatus: "timed-out" }],
  currentQuestionSessionId: "runtime", currentQuestionRuntimeEpoch: 3,
  currentQuestionUnitId: "Q", currentQuestionRevision: 1,
  currentQuestionSourceHash: "source", currentQuestionSourceTurnIds: ["turn"],
} };
const terminal: QuestionTypeAdjudicationRecordedDecision = { ...decision, traceId: "consumer", recordedAt: 3, exportedAt: 3, status: "success", metadata: {
  ...decision.metadata, runtimeSettlementTypeOperationId: "T", runtimeSettlementOperationId: "R",
  currentQuestionSettlementId: "S", currentQuestionSettlementType: "ai-ml-system-design",
  settledExecutionPlanId: "P", settledExecutionPlanSettlementId: "S",
  settledExecutionPlanSessionId: "runtime", settledExecutionPlanRuntimeEpoch: 3,
  settledExecutionPlanLogicalQuestionUnitId: "Q", settledExecutionPlanLogicalQuestionRevision: 1,
  settledExecutionPlanSourceHash: "source", settledExecutionPlanSourceTurnIds: ["turn"],
  settledExecutionPlanAuthorized: true, settledExecutionPlanResponseAuthorized: true,
  advisorJobId: "J", advisorJobExpectedSessionId: "runtime", advisorJobExpectedRuntimeEpoch: 3,
  advisorJobOutcome: "committed", advisorJobCommitAuthorized: true,
  generationResultCommitDisposition: "committed", leaseAuthorizedAtCommit: true,
  latestUsefulAnswerVisibleCommitAuthorized: true, latestUsefulAnswerVisibleCommitRevision: 2,
  advisorOutputCommittedToUi: true, visibleAnswerRevisionAfter: 2,
} };
const run = (settlements = [terminal], decisions = [decision]) => build({ decisions, settlements, outcomes: [], now: 50 });

test("OJ2 explicit product commit is separate from Type validity and dedicated event coverage", () => {
  const raw = JSON.stringify(terminal);
  const report = run([terminal, terminal], [decision, decision]);
  assert.equal(report.metrics.proposalOperations, 1);
  assert.equal(report.metrics.validProposalOperations, 0);
  assert.equal(report.metrics.terminalCoverage, 0);
  assert.equal(report.metrics.productTerminalCoverage, 1);
  assert.equal(report.rows[0].productTerminalState, "visible-committed");
  assert.equal(report.rows[0].productAdvisorJobId, "J");
  assert.equal(report.rows[0].settledCurrentQuestionType, "ai-ml-system-design");
  assert.equal(report.rows[0].typeCorrect, undefined);
  assert.deepEqual(report.rows[0].recordedAttempts, decision.metadata.questionTypeAdjudicationAttempts);
  assert.equal(JSON.stringify(terminal), raw);
});

test("OJ3 missing, conflicting and cross-identity links never borrow a successful trace", () => {
  for (const [key, value] of [
    ["runtimeSettlementTypeOperationId", "other"], ["runtimeSettlementOperationId", undefined],
    ["settledExecutionPlanSettlementId", "other"], ["settledExecutionPlanId", undefined],
    ["settledExecutionPlanSessionId", "other"], ["settledExecutionPlanRuntimeEpoch", 4],
    ["settledExecutionPlanLogicalQuestionUnitId", "other"], ["settledExecutionPlanLogicalQuestionRevision", 2],
    ["settledExecutionPlanSourceHash", "other"], ["settledExecutionPlanSourceTurnIds", ["other"]],
    ["advisorJobId", undefined], ["advisorJobExpectedSessionId", "other"], ["advisorJobExpectedRuntimeEpoch", 4],
    ["advisorJobCommitAuthorized", false], ["settledExecutionPlanAuthorized", false],
    ["generationResultCommitDisposition", undefined], ["leaseAuthorizedAtCommit", false],
    ["latestUsefulAnswerVisibleCommitAuthorized", undefined], ["advisorOutputCommittedToUi", undefined],
    ["visibleAnswerRevisionAfter", 3],
  ]) {
    const bad = { ...terminal, metadata: { ...terminal.metadata, [key as string]: value } };
    const report = run([bad]);
    assert.equal(report.metrics.productTerminalCoverage, 0, String(key));
    assert.ok(report.rows[0].productOutcomeDiagnostics.length, String(key));
  }
  assert.equal(run([{ ...terminal, sessionId: "session_recording_other" }]).metrics.productTerminalCoverage, 0);
  const conflict = { ...terminal, metadata: { ...terminal.metadata, settledExecutionPlanLogicalQuestionRevision: 2 } };
  assert.equal(run([terminal, conflict]).metrics.productTerminalCoverage, 0);
  const other = { ...decision, metadata: { ...decision.metadata, questionTypeAdjudicationOperationId: "T2" } };
  const ambiguous = { ...terminal, metadata: { ...terminal.metadata, runtimeSettlementTypeOperationId: "T2" } };
  assert.equal(run([terminal, ambiguous], [decision, other]).metrics.productTerminalCoverage, 0);
  for (const metadata of [
    { ...terminal.metadata, advisorJobCommitAuthorized: false },
    { ...terminal.metadata, settledExecutionPlanSourceTurnIds: ["other"] },
    { ...terminal.metadata, currentQuestionSettlementId: "other" },
  ]) assert.equal(run([terminal, { ...terminal, metadata }]).metrics.productTerminalCoverage, 0);
});

test("OJ3 executing snapshots do not add subjects or override explicit terminal evidence", () => {
  const executing = { ...terminal, recordedAt: 2, metadata: { ...terminal.metadata, advisorJobOutcome: "executing" } };
  assert.equal(run([executing, terminal]).metrics.productTerminalComplete, 1);
  assert.equal(run([executing]).metrics.productTerminalComplete, 0);
  for (const [outcome, state] of [["suppressed", "suppressed"], ["cancelled-by-new-job", "cancelled"],
    ["cancelled-by-runtime-boundary", "cancelled"], ["stale-commit-rejected", "stale-dropped"], ["error", "error"]]) {
    const report = run([{ ...terminal, metadata: { ...terminal.metadata, advisorJobOutcome: outcome,
      advisorOutputCommittedToUi: false, latestUsefulAnswerVisibleCommitAuthorized: false } }]);
    assert.equal(report.rows[0].productTerminalState, state);
    assert.equal(report.metrics.productVisibleCommitted, 0);
    assert.equal(report.metrics.validProposalOperations, 0);
  }
});

test("OJ3 no Type operation and suppressed Regenerate without a commit do not imply delivery", () => {
  assert.equal(run([terminal], []).metrics.proposalOperations, 0);
  assert.equal(run([]).metrics.productTerminalCoverage, 0);
  assert.equal(run([{ ...terminal, metadata: { advisorJobOutcome: "suppressed" } }]).metrics.productTerminalCoverage, 0);
});

test("OJ3 recording envelopes isolate reused operation and job IDs", () => {
  const secondDecision = { ...decision, sessionId: "session_recording_b" };
  const secondTerminal = { ...terminal, sessionId: "session_recording_b" };
  const report = run([terminal, secondTerminal], [decision, secondDecision]);
  assert.equal(report.metrics.proposalOperations, 2);
  assert.equal(report.metrics.productTerminalComplete, 2);
});

test("OJ4 RAG provisional settlement evolves into an explicit final Plan/job/commit", () => {
  const provisional = { ...decision, recordedAt: 2, metadata: { ...decision.metadata,
    runtimeSettlementTypeOperationId: "T", runtimeSettlementOperationId: "R",
    currentQuestionSettlementId: "provisional-S", currentQuestionSettlementRelation: "unknown",
    currentQuestionSettlementRelationAuthoritySource: "provisional",
  } };
  const raw = JSON.stringify(provisional);
  for (const records of [[provisional, terminal], [terminal, provisional, provisional]]) {
    const report = run(records);
    assert.equal(report.metrics.productTerminalComplete, 1);
    assert.equal(report.rows[0].productPlanId, "P");
    assert.equal(report.rows[0].productAdvisorJobId, "J");
    assert.deepEqual(report.rows[0].productOutcomeDiagnostics, []);
    assert.equal(report.metrics.terminalCoverage, 0);
  }
  assert.equal(run([provisional]).metrics.productTerminalComplete, 0);
  assert.equal(JSON.stringify(provisional), raw);
  // Source identity is immutable even while settlement content evolves.
  assert.equal(run([terminal, { ...provisional, metadata: { ...provisional.metadata,
    currentQuestionSourceHash: "conflicting-source" } }]).metrics.productTerminalComplete, 0);
});

test("OJ4 conflicting final settlement records cannot be dismissed as provisional evolution", () => {
  const conflicting = { ...terminal, recordedAt: 4, metadata: { ...terminal.metadata,
    currentQuestionSettlementId: "other-final-S", settledExecutionPlanSettlementId: "other-final-S",
  } };
  for (const records of [[terminal, conflicting], [conflicting, terminal]]) {
    const report = run(records);
    assert.equal(report.metrics.productTerminalComplete, 0);
    assert.ok(report.rows[0].productOutcomeDiagnostics.includes("ambiguous-or-conflicting-product-chain"));
  }
});
