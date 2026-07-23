import assert from "node:assert/strict";
import test from "node:test";
import {
  detectAnswerSufficiencyShadow,
  formatAnswerSufficiencyDecisionForTrace,
} from "../src/lib/meeting/answer-sufficiency.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import { ANSWER_SUFFICIENCY_CORPUS } from "./fixtures/answer-sufficiency-corpus.js";

for (const fixture of ANSWER_SUFFICIENCY_CORPUS) {
  test(`answer sufficiency corpus: ${fixture.id}`, () => {
    const decision = detectAnswerSufficiencyShadow({
      operationId: `operation-${fixture.id}`,
      traceId: `trace-${fixture.id}`,
      questionId: `question-${fixture.id}`,
      logicalQuestionUnitId: `lqu-${fixture.id}`,
      logicalQuestionUnitRevision: 1,
      answerRevision: 1,
      questionText: fixture.question,
      questionType: fixture.questionType,
      parsedAnswer: parseMeetingAnswer(fixture.answer),
      currentTurnAction: fixture.currentTurnAction,
      factAnchorRequired: fixture.factAnchorRequired,
      factAnchorAvailable: fixture.factAnchorAvailable,
      executionStatus: fixture.executionStatus,
      createdAt: 100,
    });

    assert.equal(decision.answerStatus, fixture.expectedStatus);
    assert.equal(decision.recommendedRepair, fixture.expectedRepair);
    assert.equal(decision.schemaVersion, 1);
    assert.equal(decision.createdAt, 100);
  });
}

test("a missing-context phrase alone cannot classify a non-substantive turn", () => {
  const decision = detectAnswerSufficiencyShadow({
    operationId: "operation-short",
    traceId: "trace-short",
    questionId: "question-short",
    logicalQuestionUnitId: "lqu-short",
    logicalQuestionUnitRevision: 1,
    answerRevision: 1,
    questionText: "Okay.",
    questionType: "unknown",
    parsedAnswer: parseMeetingAnswer(
      "Answer:\nI don't have the original problem."
    ),
  });

  assert.equal(decision.answerStatus, "unknown");
  assert.equal(decision.recommendedRepair, "none");
});

test("trace projection carries identities and evidence without answer text", () => {
  const decision = detectAnswerSufficiencyShadow({
    operationId: "operation-trace",
    traceId: "trace-projection",
    questionId: "question-projection",
    logicalQuestionUnitId: "lqu-projection",
    logicalQuestionUnitRevision: 3,
    answerRevision: 2,
    questionText: "Give me a script on that.",
    questionType: "coding",
    parsedAnswer: parseMeetingAnswer(
      "Answer:\nThe specific task isn't clear yet."
    ),
  });
  const metadata = formatAnswerSufficiencyDecisionForTrace(decision);

  assert.equal(metadata.answerSufficiencyStatus, "context-insufficient");
  assert.equal(metadata.answerSufficiencyLogicalQuestionUnitRevision, 3);
  assert.equal(metadata.answerSufficiencyAnswerRevision, 2);
  assert.equal("answer" in metadata, false);
});
