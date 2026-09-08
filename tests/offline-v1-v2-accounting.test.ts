import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskRelationAdjudicationReflectionReport as build } from "../src/lib/meeting/task-relation-adjudication-reflection.js";
import { createHumanGroundTruthEventV2, deriveHumanEvaluationProjectionV2 } from "../src/lib/meeting/human-ground-truth-v2.js";
import type { QuestionHumanEvaluation } from "../src/lib/meeting/types.js";

const decision = { recordedAt: 10, sessionId: "session_recording_a", traceId: "attempt", metadata: {
  currentQuestionSessionId: "runtime", currentQuestionRuntimeEpoch: 3,
  currentQuestionUnitId: "Q", currentQuestionRevision: 1,
  currentQuestionSourceHash: "source", currentQuestionSourceTurnIds: ["turn"],
  taskRelationSplitCanonicalOperationId: "C", taskRelationSplitCanonicalParsedRelation: "child-probe",
  taskRelationSplitCanonicalParseValid: true,
} };
const subject = { attemptId: "attempt", questionId: "trace:attempt", traceIds: ["attempt"], sourceTurnIds: ["turn"] };
const event = createHumanGroundTruthEventV2({ eventId: "truth", sessionId: "runtime", subject,
  fact: { kind: "expected-task-settlement", expectedQuestionType: "coding", expectedRelation: "child-probe", expectedParentAction: "attach-child" },
  source: "explicit-ui", sourceTraceId: "attempt", now: 20,
  evaluationTarget: { attemptId: "attempt", logicalQuestionUnitId: "Q", logicalQuestionUnitRevision: 1, sourceTurnIds: ["turn"], frozenAt: 20 },
});
const project = (events = [event]) => deriveHumanEvaluationProjectionV2({ sessionId: "runtime", subject, events, now: 30 });
const evaluation = { id: "v1", sessionId: "runtime", questionId: "trace:attempt", traceIds: ["attempt"], expectedRelation: "child-probe", updatedAt: 20 } as QuestionHumanEvaluation;

test("OJ1 verified V2 compatibility copies are covered once, not unmatched or scored again", () => {
  const input = { decisions: [decision, decision], evaluations: [evaluation], projections: [project()] };
  const raw = JSON.stringify(input);
  const report = build(input);
  assert.equal(report.metrics.unmatchedEvaluationCount, 0);
  assert.equal(report.metrics.coveredLegacyEvaluationCount, 1);
  assert.equal(report.metrics.evaluatedSubjects, 1);
  assert.equal(report.metrics.currentCandidateAccuracy.denominator, 1);
  assert.deepEqual(report.coveredLegacyEvaluations[0].truthEventIds, ["truth"]);
  assert.equal(JSON.stringify(input), raw);
});

test("OJ1 orphan, conflicting source/session/revision, suggested and empty truth stay unmatched", () => {
  for (const changed of [
    { ...event, confirmation: "suggested" as const },
    { ...event, sessionId: "other" },
    { ...event, subject: { ...subject, sourceTurnIds: ["other"] } },
    { ...event, provenance: { ...event.provenance, evaluationTarget: { ...event.provenance.evaluationTarget!, logicalQuestionUnitRevision: 2 } } },
  ]) assert.equal(build({ decisions: [decision], evaluations: [evaluation], projections: [project([changed])] }).metrics.unmatchedEvaluationCount, 1);
  for (const projections of [[], [project([])], [project([event, { ...event, eventId: "conflict", fact: { ...event.fact, expectedRelation: "new-parent" } as typeof event.fact }])]]) {
    const report = build({ decisions: [decision], evaluations: [evaluation], projections });
    assert.equal(report.metrics.unmatchedEvaluationCount, 1);
    assert.equal(report.rows[0].expectedRelation, undefined);
  }
  for (const changed of [{ ...evaluation, sessionId: "other" }, { ...evaluation, questionId: "other" }, { ...evaluation, traceIds: ["orphan"] }]) {
    assert.equal(build({ decisions: [decision], evaluations: [changed], projections: [project()] }).metrics.unmatchedEvaluationCount, 1);
  }
});

test("OJ1 legacy-only scoring remains available", () => {
  const legacy = { ...decision, sessionId: "runtime", metadata: { taskRelationAdjudicationOperationId: "old", taskRelationAdjudicationCandidateRelation: "child-probe" } };
  const report = build({ decisions: [legacy], evaluations: [evaluation] });
  assert.equal(report.metrics.unmatchedEvaluationCount, 0);
  assert.equal(report.metrics.llmAccuracy.denominator, 1);
});

test("OJ1 an evaluation referencing two verified subjects remains ambiguous", () => {
  const second = { ...decision, traceId: "second", metadata: { ...decision.metadata, taskRelationSplitCanonicalOperationId: "C2" } };
  const otherSubject = { ...subject, attemptId: "second", traceIds: ["second"] };
  const other = { ...event, eventId: "other", subject: otherSubject, provenance: { ...event.provenance,
    sourceTraceId: "second", evaluationTarget: { ...event.provenance.evaluationTarget!, attemptId: "second" } } };
  const otherProjection = deriveHumanEvaluationProjectionV2({ sessionId: "runtime", subject: otherSubject, events: [other], now: 30 });
  const report = build({ decisions: [decision, second], evaluations: [{ ...evaluation, traceIds: ["attempt", "second"] }], projections: [project(), otherProjection] });
  assert.equal(report.metrics.coveredLegacyEvaluationCount, 0);
  assert.equal(report.metrics.unmatchedEvaluationCount, 1);
});
