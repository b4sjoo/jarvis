import assert from "node:assert/strict";
import test from "node:test";
import type { AnswerSufficiencyDecision } from "../src/lib/meeting/answer-sufficiency.js";
import {
  ANSWER_SUFFICIENCY_LLM_SHADOW_DEFAULT_ENABLED,
  authorizeAnswerSufficiencyAdjudicationLease,
  buildAnswerSufficiencyAdjudicationPrompts,
  buildAnswerSufficiencyAdjudicationRequest,
  createAnswerSufficiencyAdjudicationLease,
  decideAnswerSufficiencyLlmEligibility,
  hashAnswerSufficiencySourceTurnIds,
  parseAnswerSufficiencyAdjudicationOutput,
} from "../src/lib/meeting/answer-sufficiency-adjudication.js";

test("keeps the LLM sufficiency shadow disabled until labeled gates pass", () => {
  assert.equal(ANSWER_SUFFICIENCY_LLM_SHADOW_DEFAULT_ENABLED, false);
  assert.deepEqual(
    decideAnswerSufficiencyLlmEligibility({
      enabled: false,
      decision: decision(),
    }),
    {
      eligible: false,
      reason: "llm-sufficiency-shadow-disabled",
    }
  );
});

test("admits only ambiguous non-terminal sufficiency candidates", () => {
  assert.equal(
    decideAnswerSufficiencyLlmEligibility({
      enabled: true,
      decision: decision({ answerStatus: "unknown", confidence: 0.4 }),
    }).eligible,
    true
  );
  assert.equal(
    decideAnswerSufficiencyLlmEligibility({
      enabled: true,
      decision: decision({
        answerStatus: "execution-failure",
        confidence: 1,
      }),
    }).eligible,
    false
  );
});

test("strictly parses grounded sufficiency judgments", () => {
  const request = buildAnswerSufficiencyAdjudicationRequest({
    decision: decision(),
    questionText: "Can you write the complete implementation?",
    answerText: "I need the earlier problem statement before I can write it.",
    nearbySourceContext: "Implement a stack using two queues.",
  });
  const raw = JSON.stringify({
    schemaVersion: 1,
    answerStatus: "context-insufficient",
    contextDefect: "missing-antecedent",
    recommendedRepair: "enhance",
    evidenceSpans: ["earlier problem statement", "stack using two queues"],
    confidence: 0.94,
  });
  assert.equal(
    parseAnswerSufficiencyAdjudicationOutput(raw, request).ok,
    true
  );
  assert.equal(
    parseAnswerSufficiencyAdjudicationOutput(
      JSON.stringify({
        ...JSON.parse(raw),
        evidenceSpans: ["invented source fact"],
      }),
      request
    ).ok,
    false
  );
  assert.doesNotMatch(
    buildAnswerSufficiencyAdjudicationPrompts(request).userMessage,
    /lexicalEvidence|semanticStatus|confidence/i
  );
});

test("drops a late judgment when answer or parent revision changed", () => {
  const currentDecision = decision();
  const lease = createAnswerSufficiencyAdjudicationLease({
    operationId: "operation-1",
    sessionId: "session-1",
    runtimeEpoch: 3,
    decision: currentDecision,
    sourceTurnIds: ["turn-1"],
    expectedParentId: "parent-1",
    expectedParentRevision: 2,
    manualCorrectionRevision: 4,
  });
  const snapshot = {
    currentOperationId: "operation-1",
    sessionId: "session-1",
    runtimeEpoch: 3,
    traceId: currentDecision.traceId,
    questionId: currentDecision.questionId,
    logicalQuestionUnitId: currentDecision.logicalQuestionUnitId,
    logicalQuestionUnitRevision:
      currentDecision.logicalQuestionUnitRevision,
    answerRevision: currentDecision.answerRevision,
    sourceTurnIdsHash: hashAnswerSufficiencySourceTurnIds(["turn-1"]),
    activeParentId: "parent-1",
    activeParentRevision: 2,
    manualCorrectionRevision: 4,
  };
  assert.deepEqual(
    authorizeAnswerSufficiencyAdjudicationLease(lease, snapshot),
    { authorized: true }
  );
  assert.deepEqual(
    authorizeAnswerSufficiencyAdjudicationLease(lease, {
      ...snapshot,
      answerRevision: 2,
    }),
    {
      authorized: false,
      reason: "answer-revision-mismatch",
    }
  );
  assert.deepEqual(
    authorizeAnswerSufficiencyAdjudicationLease(lease, {
      ...snapshot,
      activeParentRevision: 3,
    }),
    {
      authorized: false,
      reason: "parent-revision-mismatch",
    }
  );
});

function decision(
  patch: Partial<AnswerSufficiencyDecision> = {}
): AnswerSufficiencyDecision {
  return {
    schemaVersion: 1,
    detectorVersion: "test-detector",
    operationId: "sufficiency-1",
    traceId: "trace-1",
    questionId: "question-1",
    logicalQuestionUnitId: "lqu-1",
    logicalQuestionUnitRevision: 1,
    answerRevision: 1,
    answerStatus: "unknown",
    contextDefect: "none",
    recommendedRepair: "none",
    confidence: 0.4,
    lexicalEvidence: [],
    semanticPrototypeIds: [],
    expectedArtifactKinds: ["code"],
    missingArtifactKinds: ["code"],
    resolvableByNearbyContext: true,
    candidateContextKinds: ["recent-window"],
    candidateSourceTurnIds: ["turn-1"],
    contextDeltaChars: 34,
    createdAt: 1,
    ...patch,
  };
}
