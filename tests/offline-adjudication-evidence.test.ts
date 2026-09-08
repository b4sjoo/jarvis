import assert from "node:assert/strict";
import test from "node:test";
import { buildQuestionTypeAdjudicationOutcomeReport } from "../src/lib/meeting/question-type-adjudication-outcome.js";
import { buildTaskRelationAdjudicationReflectionReport } from "../src/lib/meeting/task-relation-adjudication-reflection.js";
import { createQuestionTypeAdjudicationOutcomeEvent } from "../src/lib/meeting/question-type-adjudication.js";
import { createHumanGroundTruthEventV2, deriveHumanEvaluationProjectionV2 } from "../src/lib/meeting/human-ground-truth-v2.js";

const identity = {
  currentQuestionSessionId: "runtime-a", currentQuestionRuntimeEpoch: 3,
  currentQuestionUnitId: "Q1", currentQuestionRevision: 2,
  currentQuestionSourceHash: "source-a", currentQuestionSourceTurnIds: ["turn-a"],
};
const decision = { recordedAt: 10, sessionId: "session_recording_a", traceId: "origin", metadata: {
  ...identity, questionTypeAdjudicationOperationId: "T7",
  questionTypeAdjudicationUnitId: "Q1", questionTypeAdjudicationUnitRevision: 2,
  questionTypeAdjudicationRuntimeSessionId: "runtime-a", questionTypeAdjudicationRuntimeEpoch: 3,
  questionTypeAdjudicationCandidateType: "coding", questionTypeAdjudicationParseValid: true,
} };
const settlement = { ...decision, recordedAt: 20, metadata: {
  ...decision.metadata, runtimeSettlementTypeOperationId: "T7", runtimeSettlementOperationId: "R9",
  currentQuestionSettlementId: "S12", runtimeSettlementRelationOperationId: "R9",
} };
const release = createQuestionTypeAdjudicationOutcomeEvent({
  operationId: "R9", sessionId: "runtime-a", recordingSessionId: "session_recording_a",
  runtimeEpoch: 3, logicalQuestionUnitId: "Q1", logicalQuestionUnitRevision: 2,
  traceId: "consumer", originTraceId: "origin", settlementId: "S12", settlementOperationId: "R9",
  stage: "release", disposition: "settlement-applied", settlementApplied: true, recordedAt: 25,
});
const subject = { attemptId: "origin", questionId: "Q1", traceIds: ["origin"], sourceTurnIds: ["turn-a"] };
function projection(expected?: "coding" | "behavioral") {
  const events = expected ? [createHumanGroundTruthEventV2({
    eventId: "truth", sessionId: "runtime-a", subject,
    fact: { kind: "expected-question-type", expectedQuestionType: expected },
    source: "explicit-ui", collection: "organic", now: 30,
    evaluationTarget: { attemptId: "origin", logicalQuestionUnitId: "Q1", logicalQuestionUnitRevision: 2, sourceTurnIds: ["turn-a"], sourceTraceId: "origin", frozenAt: 30 },
  })] : [];
  return deriveHumanEvaluationProjectionV2({ sessionId: "runtime-a", subject, events, now: 40,
    observed: { traceId: "origin", traceHash: "hash", questionType: "coding" } });
}

test("D3/D4 explicit T7/R9/S12 joins, release is not terminal, observed is not expected", () => {
  const input = { decisions: [decision], settlements: [settlement], outcomes: [release, release], projections: [projection()] };
  const before = JSON.stringify(input);
  const report = buildQuestionTypeAdjudicationOutcomeReport(input);
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].operationId, "T7");
  assert.equal(report.rows[0].settlementOperationId, "R9");
  assert.equal(report.rows[0].outcomeCount, 1);
  assert.equal(report.rows[0].terminalComplete, false);
  assert.equal(report.rows[0].typeCorrect, undefined);
  assert.equal(report.metrics.joinCoverage, 1);
  assert.equal(report.metrics.terminalCoverage, 0);
  assert.equal(report.metrics.explicitNotApplied, 0);
  assert.equal(JSON.stringify(input), before);
  for (const [expected, correct] of [["coding", true], ["behavioral", false]] as const) {
    const labeled = buildQuestionTypeAdjudicationOutcomeReport({ ...input, projections: [projection(expected)] });
    assert.equal(labeled.rows[0].expectedQuestionType, expected);
    assert.equal(labeled.rows[0].typeCorrect, correct);
  }
});

test("D3 confirmed truth supersession, suggestion, conflict and source/attempt isolation", () => {
  const old = projection("behavioral").activeFacts["expected-question-type"]!;
  const newer = { ...old, eventId: "corrected", supersedesEventId: old.eventId,
    fact: { kind: "expected-question-type" as const, expectedQuestionType: "coding" as const } };
  const project = (events: typeof old[]) => deriveHumanEvaluationProjectionV2({ sessionId: "runtime-a", subject, events, now: 50 });
  const run = (p: ReturnType<typeof projection>) => buildQuestionTypeAdjudicationOutcomeReport({ decisions: [decision], outcomes: [], projections: [p] }).rows[0];
  assert.equal(run(project([old, newer])).typeCorrect, true);
  assert.equal(run(project([old, { ...newer, supersedesEventId: undefined }])).typeCorrect, undefined);
  assert.equal(run(project([{ ...newer, confirmation: "suggested" }])).typeCorrect, undefined);
  for (const changed of [
    { ...old, sessionId: "other" },
    { ...old, subject: { ...old.subject, attemptId: "other" } },
    { ...old, subject: { ...old.subject, sourceTurnIds: ["other"] } },
    { ...old, provenance: { ...old.provenance, evaluationTarget: { ...old.provenance.evaluationTarget!, logicalQuestionUnitRevision: 3 } } },
    { ...old, provenance: { ...old.provenance, evaluationTarget: undefined } },
  ]) assert.equal(run({ ...projection("coding"), activeFacts: { "expected-question-type": changed } }).typeCorrect, undefined);
});

test("D4 conflicting outcome IDs and ambiguous settlement references remain unresolved", () => {
  const report = buildQuestionTypeAdjudicationOutcomeReport({ decisions: [decision], settlements: [settlement], outcomes: [release, { ...release, visibleCommitted: true }] });
  assert.equal(report.metrics.unmatchedOutcomes, 2);
  assert.equal(report.rows[0].outcomeCount, 0);
  assert.ok(report.integrity.diagnostics.some(d => d.reason === "conflicting-outcome-id"));
  const second = { ...decision, metadata: { ...decision.metadata, questionTypeAdjudicationOperationId: "T8" } };
  const ambiguous = buildQuestionTypeAdjudicationOutcomeReport({ decisions: [decision, second], settlements: [settlement, { ...settlement, metadata: { ...settlement.metadata, runtimeSettlementTypeOperationId: "T8" } }], outcomes: [release] });
  assert.deepEqual(ambiguous.rows.map(row => row.outcomeCount), [0, 0]);
  assert.equal(ambiguous.metrics.unmatchedOutcomes, 1);
});

test("D4 explicit denial is terminal; repeated sessions cannot merge operation IDs", () => {
  const denied = { ...release, operationId: "T7", disposition: "enforcement-denied" as const, settlementApplied: false };
  const report = buildQuestionTypeAdjudicationOutcomeReport({ decisions: [decision, { ...decision, sessionId: "session_recording_b" }], outcomes: [denied, denied] });
  assert.equal(report.rows.length, 2);
  assert.equal(report.metrics.terminalComplete, 1);
  assert.equal(report.metrics.explicitNotApplied, 1);
  assert.equal(report.metrics.joinCoverage, 0.5);
  assert.equal(report.integrity.duplicateOutcomes, 1);
});

test("D3 missing or cross identity cannot borrow joint settlement outcomes", () => {
  for (const [field, value] of [
    ["currentQuestionSessionId", "other"], ["currentQuestionRuntimeEpoch", 4],
    ["questionTypeAdjudicationUnitId", "Q2"], ["questionTypeAdjudicationUnitRevision", 3],
    ["currentQuestionSourceHash", "other"], ["currentQuestionSourceHash", undefined],
    ["currentQuestionSourceTurnIds", ["other"]],
  ] as const) {
    const report = buildQuestionTypeAdjudicationOutcomeReport({ decisions: [decision], outcomes: [release],
      settlements: [{ ...settlement, metadata: { ...settlement.metadata, [field]: value } }] });
    assert.equal(report.rows[0].outcomeCount, 0, field);
    assert.equal(report.metrics.unmatchedOutcomes, 1, field);
  }
});

test("D3 explicit settlement links preserve different proposal, origin and consumer trace identities", () => {
  const report = buildQuestionTypeAdjudicationOutcomeReport({ decisions: [decision],
    settlements: [{ ...settlement, traceId: "joint-origin" }],
    outcomes: [{ ...release, originTraceId: "joint-origin" }],
  });
  assert.equal(report.rows[0].outcomeCount, 1);
  assert.equal(report.rows[0].originTraceId, "origin");
  assert.deepEqual(report.rows[0].outcomeOriginTraceIds, ["joint-origin"]);
  assert.deepEqual(report.rows[0].consumerTraceIds, ["consumer"]);
});

test("D4 retries do not multiply evaluated subjects and unsupported types remain inspectable", () => {
  const retry = { ...decision, metadata: { ...decision.metadata, questionTypeAdjudicationOperationId: "T8" } };
  const unknown = { ...decision, metadata: { ...decision.metadata, questionTypeAdjudicationOperationId: "T9", questionTypeAdjudicationCandidateType: "unsupported-historical-type" } };
  const report = buildQuestionTypeAdjudicationOutcomeReport({ decisions: [decision, retry, unknown], outcomes: [], projections: [projection("coding")] });
  assert.equal(report.metrics.proposalOperations, 3);
  assert.equal(report.metrics.labeledProposals, 2);
  assert.equal(report.metrics.evaluatedSubjects, 1);
  assert.equal(report.rows.find(row => row.operationId === "T9")!.rawProposedQuestionType, "unsupported-historical-type");
  assert.ok(report.integrity.diagnostics.some(d => d.reason === "unsupported-question-type:unsupported-historical-type"));
});

test("D4 the recorded legacy system-design alias is decoded without inventing human labels", () => {
  const report = buildQuestionTypeAdjudicationOutcomeReport({ decisions: [{ ...decision, metadata: { ...decision.metadata, questionTypeAdjudicationCandidateType: "system-design" } }], outcomes: [] });
  assert.equal(report.rows[0].proposedQuestionType, "general-system-design");
  assert.equal(report.rows[0].typeCorrect, undefined);
});

test("D4 missing outcome is unknown and empty denominator has no percentage", () => {
  const missing = buildQuestionTypeAdjudicationOutcomeReport({ decisions: [decision], outcomes: [] });
  assert.equal(missing.rows[0].terminalState, "outcome-missing");
  assert.equal(missing.rows[0].appliedToResponse, undefined);
  assert.equal(missing.metrics.explicitNotApplied, 0);
  const empty = buildQuestionTypeAdjudicationOutcomeReport({ decisions: [], outcomes: [] });
  assert.equal(empty.metrics.joinCoverage, null);
  assert.equal(empty.metrics.terminalCoverage, null);
});

test("D4 Split IDs survive repeated trace snapshots; Ordered effect remains separate", () => {
  const base = { ...settlement, metadata: { ...settlement.metadata,
    taskRelationParentAffinityOperationId: "P1", taskRelationParentAffinityDecision: "related",
    taskRelationParentAffinityDurationMs: 12, taskRelationParentAffinityLeaseAuthorized: true,
  } };
  const final = { ...base, recordedAt: 40, metadata: { ...base.metadata,
    taskRelationSplitCanonicalOperationId: "C1", taskRelationSplitParentPredecessorOperationId: "P1",
    taskRelationSplitCanonicalParsedRelation: "new-parent",
    taskRelationSplitCanonicalParseValid: true, taskRelationSplitCanonicalDisposition: "stale",
    taskRelationSplitCanonicalLeaseAuthorized: false,
    taskRelationOrderedResolutionRelation: "followup-parent", taskRelationOrderedResolutionStatus: "resolved",
    currentQuestionSettlementRelation: "followup-parent",
  } };
  const report = buildTaskRelationAdjudicationReflectionReport({ decisions: [base, final, final], evaluations: [], projections: [] });
  assert.deepEqual(report.rows.map(row => row.operationId).sort(), ["C1", "P1"]);
  assert.equal(report.metrics.currentOperations, 2);
  assert.equal(report.metrics.legacyOperations, 0);
  const canonical = report.rows.find(row => row.operationId === "C1")!;
  assert.equal(canonical.candidateRelation, "new-parent");
  assert.equal(canonical.orderedRelation, "followup-parent");
  assert.equal(canonical.parseValid, true);
  assert.equal(canonical.mutationApplied, undefined);
  assert.equal(canonical.firstBatchReleasedRelation, undefined);
  assert.equal(report.rows.find(row => row.operationId === "P1")!.parseValid, undefined);
});
