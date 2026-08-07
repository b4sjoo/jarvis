import assert from "node:assert/strict";
import test from "node:test";
import {
  AdvisorResponseChallengeCoordinator,
  AdvisorResponseFingerprintCache,
  authorizeAdvisorResponseFingerprintLease,
  collectAdvisorIndependentChallengeEvidence,
  cosineSimilarity,
  createAdvisorHypothesisChallenge,
  createAdvisorResponseFingerprintLease,
  createAdvisorResponseFingerprintRecord,
  observeAdvisorResponseConsistency,
} from "../src/lib/meeting/advisor-response-consistency.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";

function fingerprint(input: {
  answerRevision: number;
  question?: string;
  answer?: string;
  code?: string;
  complexity?: string;
  whiteboard?: string;
  requiredArtifacts?: Array<"answer" | "code" | "complexity" | "whiteboard">;
  artifactIntent?: "none" | "preserve" | "revise-code" | "revise-complexity" | "revise-whiteboard";
  mutatedArtifacts?: Array<"answer" | "code" | "complexity" | "whiteboard">;
}) {
  const content = [
    `Question:\n${input.question ?? "Design a URL shortener."}`,
    `Answer:\n${input.answer ?? "Clarify scale, then propose an API and storage model."}`,
    input.code ? `Code:\n${input.code}` : "",
    input.complexity ? `Complexity:\n${input.complexity}` : "",
    input.whiteboard ? `Whiteboard:\n${input.whiteboard}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return createAdvisorResponseFingerprintRecord({
    sessionId: "session-a",
    runtimeEpoch: 3,
    logicalQuestionUnitId: "lqu-a",
    logicalQuestionRevision: 1,
    settlementId: `settlement-${input.answerRevision}`,
    executionPlanId: `plan-${input.answerRevision}`,
    answerRevision: input.answerRevision,
    sourceTraceId: `trace-${input.answerRevision}`,
    questionType: "general-system-design",
    relation: "followup-parent",
    parentTaskId: "parent-a",
    playbookPhase: "requirement_clarification",
    manualCorrectionRevision: 0,
    questionText: input.question ?? "Design a URL shortener.",
    parsedAnswer: parseMeetingAnswer(content),
    requiredArtifacts: input.requiredArtifacts,
    artifactIntent: input.artifactIntent ?? "preserve",
    artifactPolicy: {
      allowCode: input.artifactIntent === "revise-code",
      allowComplexity: input.artifactIntent === "revise-code",
      allowWhiteboard: input.artifactIntent === "revise-whiteboard",
    },
    mutatedArtifacts: input.mutatedArtifacts,
    createdAt: 100 + input.answerRevision,
  });
}

test("fingerprint persists bounded metadata without raw question or answer text", () => {
  const record = fingerprint({
    answerRevision: 1,
    question: "Explain my confidential architecture choice.",
    answer: "The confidential answer contains a private implementation detail.",
  });
  const serialized = JSON.stringify(record.fingerprint);

  assert.equal(serialized.includes("confidential architecture"), false);
  assert.equal(serialized.includes("private implementation"), false);
  assert.equal(record.fingerprint.questionChars > 0, true);
  assert.equal(record.fingerprint.answerProfile.answerChars > 0, true);
  assert.ok(record.fingerprint.questionHash);
  assert.ok(record.fingerprint.answerHash);
});

test("fingerprint normalization is stable across whitespace-only changes", () => {
  const first = fingerprint({
    answerRevision: 1,
    question: "Design   a URL\nshortener.",
    answer: "Start with   requirements.\nThen estimate QPS.",
  });
  const second = fingerprint({
    answerRevision: 1,
    question: "Design a URL shortener.",
    answer: "Start with requirements. Then estimate QPS.",
  });

  assert.equal(
    first.fingerprint.questionHash,
    second.fingerprint.questionHash
  );
  assert.equal(first.fingerprint.answerHash, second.fingerprint.answerHash);
  assert.equal(
    first.fingerprint.fingerprintId,
    second.fingerprint.fingerprintId
  );
});

test("bounded cache evicts oldest records and keeps session-local semantic source", () => {
  const cache = new AdvisorResponseFingerprintCache(2);
  const first = fingerprint({ answerRevision: 1 });
  const second = fingerprint({ answerRevision: 2 });
  const third = fingerprint({ answerRevision: 3 });

  cache.add(first);
  cache.add(second);
  cache.add(third);

  assert.equal(cache.size, 2);
  const previous = cache.findPreviousComparable(third.fingerprint);
  assert.equal(previous?.fingerprint.answerRevision, 2);
  assert.ok(previous?.semanticSource.answerText);
});

test("Complexity belongs to the Code artifact family", () => {
  const record = fingerprint({
    answerRevision: 1,
    code: "```python\nprint('ok')\n```",
    complexity: "O(n)",
    requiredArtifacts: ["complexity"],
    artifactIntent: "revise-code",
    mutatedArtifacts: ["complexity"],
  });

  assert.deepEqual(record.fingerprint.artifactSignature.requiredFamilies, [
    "code",
  ]);
  assert.deepEqual(record.fingerprint.artifactSignature.mutatedFamilies, [
    "code",
  ]);
  assert.deepEqual(
    record.fingerprint.artifactSignature.missingRequiredFamilies,
    []
  );
  assert.equal(record.fingerprint.artifactSignature.codeLanguage, "Python");
});

test("artifact contract mismatch is projected without exposing artifact text", () => {
  const record = fingerprint({
    answerRevision: 1,
    requiredArtifacts: ["whiteboard"],
    artifactIntent: "revise-whiteboard",
    mutatedArtifacts: [],
  });
  const observation = observeAdvisorResponseConsistency({
    previous: fingerprint({ answerRevision: 0 }).fingerprint,
    current: record.fingerprint,
    questionSimilarity: 0.9,
    answerSimilarity: 0.9,
    createdAt: 200,
  });

  assert.deepEqual(observation.artifactMismatchReasons, [
    "missing-required-whiteboard",
  ]);
  assert.deepEqual(observation.anomalyReasons, [
    "artifact-contract-mismatch",
  ]);
});

test("response similarity alone can challenge a hypothesis only with independent evidence", () => {
  const previous = fingerprint({
    answerRevision: 1,
    question: "Design a URL shortener.",
    answer: "Use an API gateway and a key-value store.",
  });
  const current = fingerprint({
    answerRevision: 2,
    question: "Explain a ranking model training pipeline.",
    answer: "Use an API gateway and a key-value store.",
  });
  const observation = observeAdvisorResponseConsistency({
    previous: previous.fingerprint,
    current: current.fingerprint,
    questionSimilarity: 0.2,
    answerSimilarity: 0.96,
  });

  const unsupported = createAdvisorHypothesisChallenge({
    observation,
    independentEvidence: [],
  });
  const supported = createAdvisorHypothesisChallenge({
    observation,
    independentEvidence: ["llm-type-disagreement"],
  });

  assert.equal(unsupported.challenged, false);
  assert.equal(unsupported.reason, "independent-evidence-missing");
  assert.equal(supported.challenged, true);
  assert.equal(supported.behaviorMutationBlocked, true);
});

test("independent evidence collector ignores unknown but keeps concrete disagreement", () => {
  const evidence = collectAdvisorIndependentChallengeEvidence({
    questionType: "coding",
    traceMetadata: {
      taxonomyKeywordType: "unknown",
      taxonomySemanticCandidateType: "general-system-design",
      questionTypeAdjudicationCandidateType: "coding",
    },
    artifactMismatch: true,
  });

  assert.deepEqual(evidence, [
    "semantic-type-disagreement",
    "artifact-contract-mismatch",
  ]);
});

test("single-flight coordinator and lease reject superseded answer work", () => {
  const coordinator = new AdvisorResponseChallengeCoordinator();
  const first = createAdvisorResponseFingerprintLease(
    fingerprint({ answerRevision: 1 }).fingerprint
  );
  const second = createAdvisorResponseFingerprintLease(
    fingerprint({ answerRevision: 2 }).fingerprint
  );

  assert.equal(coordinator.begin(first).accepted, true);
  assert.equal(coordinator.begin(second).accepted, true);
  assert.equal(coordinator.authorize(first), false);
  assert.equal(coordinator.authorize(second), true);
  assert.equal(coordinator.settle(second), true);
  assert.equal(coordinator.authorize(second), false);

  const authorization = authorizeAdvisorResponseFingerprintLease({
    lease: first,
    sessionId: "session-a",
    runtimeEpoch: 3,
    logicalQuestionUnitId: "lqu-a",
    logicalQuestionRevision: 1,
    visibleAnswerRevision: 2,
    manualCorrectionRevision: 0,
  });
  assert.equal(authorization.authorized, false);
  assert.deepEqual(authorization.rejectionReasons, [
    "visible-answer-revision-mismatch",
  ]);
});

test("cosine similarity is bounded and deterministic", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([], []), 0);
});
