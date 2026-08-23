import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeAnswerRecoveryAdjudicationLease,
  buildAnswerRecoveryAdjudicationPrompts,
  buildAnswerRecoveryAdjudicationRequest,
  createAnswerRecoveryAdjudicationLease,
  parseAnswerRecoveryAdjudicationOutput,
} from "../src/lib/meeting/answer-recovery-adjudication.js";

const question = "Could you please explain lines 46 through 49?";
const answer =
  "I don't have those lines visible. Please paste or read out lines 46 through 49.";

test("keeps answer resolution and visual evidence as independent prompts", () => {
  const resolution = buildAnswerRecoveryAdjudicationRequest({
    operationKind: "answer-resolution",
    logicalQuestionUnitId: "lqu-1",
    logicalQuestionUnitRevision: 2,
    answerRevision: 3,
    questionText: question,
    answerText: answer,
  });
  const evidence = buildAnswerRecoveryAdjudicationRequest({
    operationKind: "evidence-requirement",
    logicalQuestionUnitId: "lqu-1",
    logicalQuestionUnitRevision: 2,
    answerRevision: 3,
    questionText: question,
    answerText: answer,
  });

  assert.ok(resolution);
  assert.ok(evidence);
  assert.equal(resolution.sourceHash, evidence.sourceHash);
  const resolutionPrompt = buildAnswerRecoveryAdjudicationPrompts(resolution);
  const evidencePrompt = buildAnswerRecoveryAdjudicationPrompts(evidence);
  assert.match(resolutionPrompt.systemPrompt, /resolves the substantive request/);
  assert.doesNotMatch(resolutionPrompt.systemPrompt, /visual-required/);
  assert.match(evidencePrompt.systemPrompt, /supplied directly by a screenshot/);
  assert.doesNotMatch(evidencePrompt.systemPrompt, /resolved'\|'unresolved/);
});

test("parses an unresolved answer with grounded paraphrase evidence", () => {
  const request = buildAnswerRecoveryAdjudicationRequest({
    operationKind: "answer-resolution",
    logicalQuestionUnitId: "lqu-1",
    logicalQuestionUnitRevision: 1,
    answerRevision: 1,
    questionText: question,
    answerText: answer,
  });
  assert.ok(request);
  const parsed = parseAnswerRecoveryAdjudicationOutput(
    JSON.stringify({
      schemaVersion: 1,
      decision: "unresolved",
      questionEvidenceSpans: ["lines 46 through 49"],
      answerEvidenceSpans: ["I don't have those lines visible"],
    }),
    request
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.value.decision : undefined, "unresolved");
});

test("parses visual-required independently from answer resolution", () => {
  const request = buildAnswerRecoveryAdjudicationRequest({
    operationKind: "evidence-requirement",
    logicalQuestionUnitId: "lqu-1",
    logicalQuestionUnitRevision: 1,
    answerRevision: 1,
    questionText: question,
    answerText: answer,
  });
  assert.ok(request);
  const parsed = parseAnswerRecoveryAdjudicationOutput(
    JSON.stringify({
      schemaVersion: 1,
      decision: "visual-required",
      questionEvidenceSpans: ["lines 46 through 49"],
      answerEvidenceSpans: ["paste or read out lines 46 through 49"],
    }),
    request
  );

  assert.equal(parsed.ok, true);
  assert.equal(
    parsed.ok ? parsed.value.decision : undefined,
    "visual-required"
  );
});

test("rejects ungrounded evidence and definite decisions without evidence", () => {
  const request = buildAnswerRecoveryAdjudicationRequest({
    operationKind: "answer-resolution",
    logicalQuestionUnitId: "lqu-1",
    logicalQuestionUnitRevision: 1,
    answerRevision: 1,
    questionText: question,
    answerText: answer,
  });
  assert.ok(request);
  const ungrounded = parseAnswerRecoveryAdjudicationOutput(
    JSON.stringify({
      schemaVersion: 1,
      decision: "unresolved",
      questionEvidenceSpans: ["the highlighted function"],
      answerEvidenceSpans: ["I don't have those lines visible"],
    }),
    request
  );
  const empty = parseAnswerRecoveryAdjudicationOutput(
    JSON.stringify({
      schemaVersion: 1,
      decision: "unresolved",
      questionEvidenceSpans: [],
      answerEvidenceSpans: [],
    }),
    request
  );

  assert.equal(ungrounded.ok, false);
  assert.equal(empty.ok, false);
});

test("lease rejects stale answer and correction revisions", () => {
  const request = buildAnswerRecoveryAdjudicationRequest({
    operationKind: "answer-resolution",
    logicalQuestionUnitId: "lqu-1",
    logicalQuestionUnitRevision: 1,
    answerRevision: 2,
    questionText: question,
    answerText: answer,
  });
  assert.ok(request);
  const lease = createAnswerRecoveryAdjudicationLease({
    sessionId: "meeting-1",
    runtimeEpoch: 4,
    request,
    manualCorrectionRevision: 1,
  });
  const current = {
    currentOperationId: lease.operationId,
    sessionId: "meeting-1",
    runtimeEpoch: 4,
    logicalQuestionUnitId: "lqu-1",
    logicalQuestionUnitRevision: 1,
    answerRevision: 2,
    sourceHash: request.sourceHash,
    manualCorrectionRevision: 1,
  };

  assert.equal(
    authorizeAnswerRecoveryAdjudicationLease(lease, current).authorized,
    true
  );
  assert.equal(
    authorizeAnswerRecoveryAdjudicationLease(lease, {
      ...current,
      answerRevision: 3,
    }).authorized,
    false
  );
  assert.equal(
    authorizeAnswerRecoveryAdjudicationLease(lease, {
      ...current,
      manualCorrectionRevision: 2,
    }).authorized,
    false
  );
});
