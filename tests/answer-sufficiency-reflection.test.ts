import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnswerSufficiencyReflectionReport,
  type RecordedAnswerSufficiencyDecision,
} from "../src/lib/meeting/answer-sufficiency-reflection.js";
import type { AnswerSufficiencyDecision } from "../src/lib/meeting/answer-sufficiency.js";

test("answer sufficiency reflection prefers the semantic late join and separates detectors", () => {
  const lexical = decision({
    operationId: "operation-1",
    answerStatus: "context-insufficient",
  });
  const semantic = decision({
    ...lexical,
    semanticStatus: "not-context-insufficient",
    semanticDisposition: "lexical-semantic-conflict",
  });
  const report = buildAnswerSufficiencyReflectionReport({
    decisions: [
      record(lexical, 1),
      record(semantic, 2),
    ],
    evaluations: [
      {
        id: "evaluation-1",
        questionId: "question-1",
        traceIds: ["trace-1"],
        answerSufficiency: {
          observedStatus: "sufficient",
          nearbyContextExisted: false,
          expectedRepair: "none",
          operationId: "operation-1",
        },
      },
    ],
  });

  assert.equal(report.metrics.operations, 1);
  assert.equal(report.metrics.lexical.falsePositive, 1);
  assert.equal(report.metrics.semantic.trueNegative, 1);
  assert.equal(report.metrics.contextResolvability.trueNegative, 1);
});

test("answer sufficiency reflection reports legitimate-wait false positives and unmatched labels", () => {
  const report = buildAnswerSufficiencyReflectionReport({
    decisions: [
      record(
        decision({
          answerStatus: "context-insufficient",
          semanticStatus: "context-insufficient",
        }),
        1
      ),
    ],
    evaluations: [
      {
        id: "evaluation-1",
        questionId: "question-1",
        traceIds: ["trace-1"],
        answerSufficiency: {
          observedStatus: "sufficient",
          expectedRepair: "wait",
          operationId: "operation-1",
        },
      },
      {
        id: "evaluation-unmatched",
        questionId: "question-unmatched",
        traceIds: ["trace-unmatched"],
        answerSufficiency: {
          observedStatus: "insufficient",
          operationId: "operation-unmatched",
        },
      },
    ],
  });

  assert.equal(report.metrics.legitimateWaitFalsePositives, 1);
  assert.equal(report.metrics.unmatchedLabels, 1);
});

function record(
  value: AnswerSufficiencyDecision,
  recordedAt: number
): RecordedAnswerSufficiencyDecision {
  return {
    recordedAt,
    traceId: "trace-1",
    decision: value,
  };
}

function decision(
  patch: Partial<AnswerSufficiencyDecision> = {}
): AnswerSufficiencyDecision {
  return {
    schemaVersion: 1,
    detectorVersion: "test",
    operationId: "operation-1",
    traceId: "trace-1",
    questionId: "question-1",
    logicalQuestionUnitId: "lqu-1",
    logicalQuestionUnitRevision: 1,
    answerRevision: 1,
    answerStatus: "sufficient",
    contextDefect: "none",
    recommendedRepair: "none",
    confidence: 0.9,
    lexicalEvidence: [],
    semanticPrototypeIds: [],
    expectedArtifactKinds: [],
    missingArtifactKinds: [],
    resolvableByNearbyContext: false,
    candidateContextKinds: [],
    candidateSourceTurnIds: [],
    contextDeltaChars: 0,
    createdAt: 1,
    ...patch,
  };
}
