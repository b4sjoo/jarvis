import assert from "node:assert/strict";
import test from "node:test";
import { buildQuestionTypeAdjudicationOutcomeReport, offlineIdentityMatches, type QuestionTypeAdjudicationRecordedDecision } from "../src/lib/meeting/question-type-adjudication-outcome.js";
import { buildTaskRelationAdjudicationReflectionReport } from "../src/lib/meeting/task-relation-adjudication-reflection.js";
import { createQuestionTypeAdjudicationOutcomeEvent } from "../src/lib/meeting/question-type-adjudication.js";
import { createHumanGroundTruthEventV2, deriveHumanEvaluationProjectionV2 } from "../src/lib/meeting/human-ground-truth-v2.js";

const identity = {
  currentQuestionSessionId: "runtime-a", currentQuestionRuntimeEpoch: 3,
  currentQuestionUnitId: "Q1", currentQuestionRevision: 2,
  currentQuestionSourceHash: "source-a", currentQuestionSourceTurnIds: ["turn-a"],
};

// Native qf3b6f shape: no Voice/current-question identity and no UI evaluationTarget.
function nativeScreenFixture() {
  const packet = {
    manualScreenQuestionPacketCommitted: true,
    manualScreenQuestionPacketSessionId: "runtime-screen",
    manualScreenQuestionPacketRuntimeEpoch: 3,
    manualScreenQuestionPacketLogicalQuestionUnitId: "screen-answer-sufficiency:observation-a",
    manualScreenQuestionPacketLogicalQuestionRevision: 1,
    manualScreenQuestionPacketSourceHash: "screen-source-a",
    manualScreenPrimaryAskSourceTurnIds: [],
    manualScreenVisualEvidenceObservationId: "observation-a",
  };
  const operation: QuestionTypeAdjudicationRecordedDecision = {
    recordedAt: 10, sessionId: "session_recording_screen", traceId: "screen-attempt",
    metadata: { ...packet, taskRelationParentAffinityOperationId: "screen-parent",
      taskRelationParentAffinityParseValid: true, taskRelationParentAffinityParsedDecision: "independent",
      taskRelationOrderedResolutionStatus: "resolved", taskRelationOrderedResolutionRelation: "new-parent" },
  };
  const terminal = { ...operation, exportedAt: 40, status: "success", metadata: {
    ...operation.metadata,
    currentQuestionSourceTurnIds: [], currentQuestionScreenObservationId: "observation-a",
    currentQuestionSettlementSessionId: "runtime-screen", currentQuestionSettlementRuntimeEpoch: 3,
    currentQuestionSettlementUnitId: packet.manualScreenQuestionPacketLogicalQuestionUnitId,
    currentQuestionSettlementRevision: 1, currentQuestionSettlementSourceHash: "screen-source-a",
    currentQuestionSettlementSourceTurnIds: [], currentQuestionSettlementSourceObservationIds: ["observation-a"],
    effectiveCurrentQuestionSettlementUnitId: packet.manualScreenQuestionPacketLogicalQuestionUnitId,
    effectiveCurrentQuestionSettlementUnitRevision: 1, effectiveCurrentQuestionSettlementRevision: 4,
    effectiveCurrentQuestionSettlementSourceHash: "screen-source-a",
  } };
  const subject = { attemptId: "screen-attempt", questionId: `lqu:${packet.manualScreenQuestionPacketLogicalQuestionUnitId}`,
    traceIds: ["screen-attempt"], sourceTurnIds: [] };
  const event = createHumanGroundTruthEventV2({ eventId: "screen-truth", sessionId: "runtime-screen", subject,
    fact: { kind: "expected-task-settlement", expectedQuestionType: "behavioral", expectedRelation: "new-parent", expectedParentAction: "create" },
    source: "explicit-ui", sourceTraceId: "screen-attempt", now: 50 });
  const projection = deriveHumanEvaluationProjectionV2({ sessionId: "runtime-screen", subject, events: [event], now: 60 });
  return { operation, terminal, event, projection };
}

test("O1 native Screen packet and terminal attempt retain confirmed truth in the actual Split report", () => {
  const { operation, terminal, projection } = nativeScreenFixture();
  const input = { decisions: [operation, terminal, terminal], settlements: [terminal], evaluations: [], projections: [projection] };
  const before = JSON.stringify(input);
  const report = buildTaskRelationAdjudicationReflectionReport(input);
  assert.equal(report.metrics.currentOperations, 1);
  assert.deepEqual(report.rows[0].identityConflicts, []);
  assert.equal(report.rows[0].expectedQuestionType, "behavioral");
  assert.equal(report.rows[0].expectedRelation, "new-parent");
  assert.equal(report.rows[0].expectedParentAction, "create");
  assert.equal(report.rows[0].orderedRelation, "new-parent");
  assert.equal(report.rows[0].truthDiagnostic, "confirmed-human-truth");
  assert.equal(JSON.stringify(input), before);
  assert.equal(offlineIdentityMatches(operation, terminal), true);
  assert.equal(offlineIdentityMatches(terminal, terminal), true);
});

test("O1 shared Type builder uses Screen proof only for a recorded Type operation", () => {
  const { operation, terminal, projection } = nativeScreenFixture();
  const proposal = { ...operation, metadata: { ...operation.metadata,
    questionTypeAdjudicationOperationId: "screen-type", questionTypeAdjudicationCandidateType: "behavioral",
    questionTypeAdjudicationParseValid: true,
  } };
  const linked = { ...terminal, metadata: { ...terminal.metadata, runtimeSettlementTypeOperationId: "screen-type" } };
  const run = (settlements = [linked], projections = [projection]) =>
    buildQuestionTypeAdjudicationOutcomeReport({ decisions: [proposal, proposal], settlements, projections, outcomes: [] });
  assert.equal(run().metrics.proposalOperations, 1);
  assert.equal(run().metrics.labeledProposals, 1);
  assert.equal(run().rows[0].typeCorrect, true);
  assert.equal(run().metrics.terminalCoverage, 0);
  assert.equal(run([]).rows[0].typeCorrect, undefined);
  assert.equal(run([linked], []).rows[0].typeCorrect, undefined);
  const competing = { ...linked, metadata: { ...linked.metadata, manualScreenVisualEvidenceObservationId: "other-observation" } };
  assert.equal(run([linked, competing]).rows[0].typeCorrect, undefined);
});

test("O1 native Screen requires exact source and unique terminal attempt, never empty turns alone", () => {
  const { operation, terminal, projection, event } = nativeScreenFixture();
  const run = (settlements: QuestionTypeAdjudicationRecordedDecision[], projections = [projection], decisions = [operation]) =>
    buildTaskRelationAdjudicationReflectionReport({ decisions, settlements, projections, evaluations: [] });
  for (const settlements of [[], [{ ...terminal, status: "running" }], [{ ...terminal, exportedAt: NaN }]]) {
    assert.equal(run(settlements).rows[0].expectedRelation, undefined);
  }
  for (const [key, value] of [
    ["manualScreenQuestionPacketSessionId", "other-session"], ["manualScreenQuestionPacketRuntimeEpoch", 4],
    ["manualScreenQuestionPacketLogicalQuestionUnitId", "other-unit"], ["manualScreenQuestionPacketLogicalQuestionRevision", 2],
    ["manualScreenQuestionPacketSourceHash", "other-hash"], ["manualScreenVisualEvidenceObservationId", "other-observation"],
    ["currentQuestionScreenObservationId", "other-observation"], ["currentQuestionSettlementSourceObservationIds", ["other-observation"]],
    ["effectiveCurrentQuestionSettlementUnitRevision", 2], ["currentQuestionSettlementSessionId", "other-session"],
    ["currentQuestionSettlementSourceTurnIds", ["other-turn"]],
  ] as const) {
    const competitor = { ...terminal, metadata: { ...terminal.metadata, [key]: value } };
    assert.equal(run([competitor]).rows[0].expectedRelation, undefined, key);
    assert.equal(run([terminal, competitor]).rows[0].expectedRelation, undefined, key);
    assert.equal(offlineIdentityMatches(terminal, competitor), false, key);
  }
  for (const key of ["manualScreenQuestionPacketSourceHash", "manualScreenVisualEvidenceObservationId",
    "manualScreenQuestionPacketLogicalQuestionUnitId", "manualScreenQuestionPacketLogicalQuestionRevision",
    "manualScreenQuestionPacketSessionId", "manualScreenQuestionPacketRuntimeEpoch"]) {
    const incomplete = { ...operation, metadata: { ...operation.metadata, [key]: undefined } };
    assert.equal(run([terminal], [projection], [incomplete]).rows[0].expectedRelation, undefined, key);
  }
  for (const changed of [{ ...event, confirmation: "suggested" as const },
    { ...event, provenance: { ...event.provenance, sourceTraceId: "another-attempt" } }]) {
    const p = deriveHumanEvaluationProjectionV2({ sessionId: event.sessionId, subject: event.subject, events: [changed], now: 60 });
    assert.equal(run([terminal], [p]).rows[0].expectedRelation, undefined);
  }
  assert.equal(run([terminal], []).rows[0].expectedRelation, undefined);
  const targeted = { ...event, provenance: { ...event.provenance, evaluationTarget: {
    attemptId: terminal.traceId, logicalQuestionUnitId: "screen-answer-sufficiency:observation-a",
    logicalQuestionUnitRevision: 1, sourceTurnIds: [], sourceTraceId: terminal.traceId, frozenAt: 50,
  } } };
  const targetedProjection = deriveHumanEvaluationProjectionV2({ sessionId: event.sessionId, subject: event.subject, events: [targeted], now: 60 });
  assert.equal(run([], [targetedProjection]).rows[0].expectedRelation, undefined);
  assert.equal(run([terminal], [targetedProjection]).rows[0].expectedRelation, "new-parent");
  assert.equal(run([{ ...terminal, sessionId: "session_recording_other" }]).rows[0].expectedRelation, undefined);
  const differentAttempt = { ...terminal, traceId: "other-attempt" };
  assert.equal(run([differentAttempt]).rows[0].expectedRelation, undefined);
  const otherObservation = { ...operation, metadata: { ...operation.metadata, manualScreenVisualEvidenceObservationId: "other-observation" } };
  assert.equal(offlineIdentityMatches(operation, otherObservation), false);
  assert.equal(run([terminal], [projection], [operation, otherObservation]).metrics.currentOperations, 1);
  assert.ok(run([terminal], [projection], [operation, otherObservation]).rows[0].identityConflicts.length > 0);
  // Two internally consistent revisions on one trace still cannot select a UI target.
  const nextRevision = { ...terminal, metadata: { ...terminal.metadata,
    manualScreenQuestionPacketLogicalQuestionRevision: 2, currentQuestionSettlementRevision: 2,
    effectiveCurrentQuestionSettlementUnitRevision: 2,
  } };
  assert.equal(run([terminal, nextRevision]).rows[0].expectedRelation, undefined);
  const voice = { ...decision, metadata: { ...decision.metadata, currentQuestionSourceObservationIds: [] } };
  assert.equal(offlineIdentityMatches(voice, voice), true);
  const noSource = { ...operation, metadata: { manualScreenPrimaryAskSourceTurnIds: [] } };
  assert.equal(offlineIdentityMatches(noSource, noSource), false);
  const missingObservationAndTurns = { ...operation, metadata: { ...operation.metadata,
    manualScreenVisualEvidenceObservationId: undefined, manualScreenPrimaryAskSourceTurnIds: undefined,
  } };
  assert.equal(run([terminal], [projection], [missingObservationAndTurns]).rows[0].expectedRelation, undefined);
});
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

test("current UI confirmed truth without evaluationTarget uses the exact terminal raw trace", () => {
  const event = createHumanGroundTruthEventV2({
    eventId: "ui-truth", sessionId: "runtime-a", subject,
    fact: { kind: "expected-task-settlement", expectedQuestionType: "coding",
      expectedRelation: "followup-parent", expectedParentAction: "preserve" },
    source: "explicit-ui", sourceTraceId: "origin", now: 30,
  });
  const uiProjection = deriveHumanEvaluationProjectionV2({ sessionId: "runtime-a", subject, events: [event], now: 40 });
  const operation = { ...settlement, metadata: { ...settlement.metadata,
    taskRelationSplitCanonicalOperationId: "C1", taskRelationSplitCanonicalParseValid: true,
    taskRelationSplitCanonicalParsedRelation: "new-parent",
  } };
  const terminal = { ...operation, status: "success", exportedAt: 40, metadata: {
    ...operation.metadata, currentQuestionSettlementRevision: 2,
    effectiveCurrentQuestionSettlementUnitRevision: 2,
    effectiveCurrentQuestionSettlementRevision: 77,
  } };
  const type = (traces: typeof terminal[], projections = [uiProjection]) =>
    buildQuestionTypeAdjudicationOutcomeReport({ decisions: [decision], settlements: traces, outcomes: [], projections });
  const relation = (traces: typeof terminal[]) => buildTaskRelationAdjudicationReflectionReport({
    decisions: [operation], settlements: traces, projections: [uiProjection], evaluations: [],
  });
  assert.equal(event.provenance.evaluationTarget, undefined);
  const before = JSON.stringify({ event, terminal });
  for (const status of ["success", "error", "cancelled"]) {
    assert.equal(type([{ ...terminal, status }]).rows[0].typeCorrect, true);
  }
  assert.equal(type([terminal, terminal]).metrics.labeledProposals, 1);
  assert.equal(relation([terminal]).rows[0].candidateCorrect, false);
  assert.equal(relation([terminal]).rows[0].expectedRelation, "followup-parent");
  assert.equal(JSON.stringify({ event, terminal }), before);

  assert.equal(type([]).rows[0].typeCorrect, undefined);
  assert.equal(type([{ ...terminal, status: "running" }]).rows[0].typeCorrect, undefined);
  assert.equal(type([{ ...terminal, exportedAt: NaN }]).rows[0].typeCorrect, undefined);
  assert.equal(type([terminal], [projection()]).rows[0].typeCorrect, undefined);
  for (const changed of [
    { ...event, confirmation: "suggested" as const },
    { ...event, provenance: { ...event.provenance, sourceTraceId: "another-attempt" } },
    { ...event, provenance: { ...event.provenance, evaluationTarget: {
      attemptId: "origin", logicalQuestionUnitId: "Q1", logicalQuestionUnitRevision: 3,
      sourceTurnIds: ["turn-a"], frozenAt: 30,
    } } },
  ]) {
    const p = deriveHumanEvaluationProjectionV2({ sessionId: "runtime-a", subject, events: [changed], now: 40 });
    assert.equal(type([terminal], [p]).rows[0].typeCorrect, undefined);
  }

  // The competing revision is excluded from the operation's exact links. It
  // must still veto the missing-target path using the unfiltered attempt input.
  for (const metadata of [
    { ...terminal.metadata, questionTypeAdjudicationUnitRevision: 3, currentQuestionRevision: 3,
      currentQuestionSettlementRevision: 3, effectiveCurrentQuestionSettlementUnitRevision: 3 },
    { ...terminal.metadata, currentQuestionSettlementRevision: 3 },
    { ...terminal.metadata, currentQuestionSourceHash: "other-source" },
    { ...terminal.metadata, currentQuestionSettlementSourceTurnIds: ["other-turn"] },
    { ...terminal.metadata, questionTypeAdjudicationRuntimeEpoch: 4, currentQuestionRuntimeEpoch: 4 },
    { ...terminal.metadata, currentQuestionSettlementSessionId: "other-runtime" },
  ]) {
    const competitor = { ...terminal, metadata, exportedAt: 5000 };
    assert.equal(type([terminal, competitor]).rows[0].typeCorrect, undefined);
    assert.equal(relation([terminal, competitor]).rows[0].candidateCorrect, undefined);
  }
  assert.equal(type([terminal, { ...terminal, traceId: "unrelated", metadata: {
    ...terminal.metadata, currentQuestionRevision: 3,
  } }]).rows[0].typeCorrect, true);
});

test("D4 cumulative source and Type-origin enrichment preserves one operation per stage and Type ID", () => {
  const early = { ...settlement, metadata: { ...settlement.metadata,
    currentQuestionSourceHash: undefined, currentQuestionSourceTurnIds: undefined,
    taskRelationChildAffinityOperationId: "CH1", taskRelationChildAffinityParsedDecision: "related",
    taskRelationParentAffinityOperationId: "P1", taskRelationParentAffinityParsedDecision: "related",
    taskRelationSplitCanonicalOperationId: "C1", taskRelationSplitCanonicalParseValid: true,
    taskRelationSplitCanonicalParsedRelation: "new-parent",
  } };
  const enriched = { ...early, recordedAt: 30, metadata: { ...early.metadata,
    currentQuestionSourceHash: "source-a", currentQuestionSourceTurnIds: ["turn-a"],
    questionTypeAdjudicationOriginTraceId: "type-envelope-origin",
  } };
  const final = { ...enriched, recordedAt: 40, metadata: { ...enriched.metadata,
    questionTypeAdjudicationOriginTraceId: "enriched-type-envelope-origin",
  } };
  const input = { decisions: [final, early, enriched, enriched], evaluations: [] };
  const before = JSON.stringify(input);
  const split = buildTaskRelationAdjudicationReflectionReport(input);
  assert.equal(split.metrics.currentOperations, 3);
  assert.deepEqual(split.metrics.operationFamilies, { child: 1, parent: 1, canonical: 1 });
  assert.ok(split.rows.every(row => row.identityConflicts.length === 0));
  assert.equal(split.rows.find(row => row.operationId === "C1")!.candidateRelation, "new-parent");
  assert.equal(JSON.stringify(input), before);

  const type = buildQuestionTypeAdjudicationOutcomeReport({ decisions: [early, enriched, enriched], outcomes: [] });
  assert.equal(type.metrics.proposalOperations, 1);
  assert.deepEqual(type.rows[0].identityConflicts, []);

  for (const metadata of [
    { ...enriched.metadata, currentQuestionSourceHash: "conflicting-source" },
    { ...enriched.metadata, questionTypeAdjudicationUnitRevision: 3, currentQuestionRevision: 3 },
  ]) {
    const conflicting = { ...enriched, recordedAt: 50, metadata };
    const badSplit = buildTaskRelationAdjudicationReflectionReport({ decisions: [early, enriched, conflicting], evaluations: [], projections: [projection("coding")] });
    assert.equal(badSplit.metrics.currentOperations, 3);
    assert.ok(badSplit.rows.every(row => row.identityConflicts.length > 0 && row.expectedQuestionType === undefined && row.mutationApplied === undefined));
    assert.ok(badSplit.diagnostics.some(row => row.reason.startsWith("conflicting-operation-identity:")));
    const badType = buildQuestionTypeAdjudicationOutcomeReport({ decisions: [early, enriched, conflicting], settlements: [settlement], outcomes: [release], projections: [projection("coding")] });
    assert.equal(badType.metrics.proposalOperations, 1);
    assert.equal(badType.rows[0].typeCorrect, undefined);
    assert.equal(badType.rows[0].outcomeCount, 0);
    assert.ok(badType.rows[0].identityConflicts.length > 0);
  }
});
