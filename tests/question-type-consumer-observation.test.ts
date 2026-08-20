import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptQuestionTypePrior,
  buildQuestionTypeConsumerObservation,
  formatQuestionTypeConsumerObservationForTrace,
  projectQuestionTypeConsumerObservationFromTrace,
} from "../src/lib/meeting/question-type-consumer-observation.js";

test("keeps a conflicting Preparation prior observable without granting it execution authority", () => {
  const prior = adaptQuestionTypePrior({
    source: "preparation-snapshot",
    sourceId: "snapshot-1:question-type-prior",
    types: ["coding", "field-knowledge", "personal-logistics"],
    expectedTypePolicy: "restricted",
  });
  const observation = buildQuestionTypeConsumerObservation({
    prior,
    committedCurrentQuestionType: "behavioral",
    responseOwnerQuestionType: "behavioral",
    responsePlaybookQuestionType: "behavioral",
    kmbPolicyQuestionType: "behavioral",
    kmbPolicyFamilies: ["behavioral"],
    factAnchorPolicyQuestionType: "behavioral",
    modelRouteQuestionType: "behavioral",
    answerProfileQuestionType: "behavioral",
    artifactPolicyQuestionType: "behavioral",
    promptContractQuestionType: "behavioral",
  });

  assert.deepEqual(prior.canonicalTypes, ["coding", "field-knowledge"]);
  assert.deepEqual(prior.policyOnlyTypes, ["personal-logistics"]);
  assert.equal(observation.priorCompatibility, "conflict");
  assert.equal(observation.priorUsedAsExecutionGate, false);
  assert.deepEqual(observation.conflicts, ["prior-vs-committed"]);
});

test("allows a read-only parent trajectory to differ from an authorized child response", () => {
  const observation = buildQuestionTypeConsumerObservation({
    committedCurrentQuestionType: "field-knowledge",
    responseOwnerQuestionType: "field-knowledge",
    responsePlaybookQuestionType: "field-knowledge",
    parentTrajectoryPlaybookQuestionType: "ai-ml-system-design",
    parentTrajectoryReadOnly: true,
    kmbPolicyQuestionType: "field-knowledge",
    kmbPolicyFamilies: ["aiml-field-knowledge"],
    factAnchorPolicyQuestionType: "field-knowledge",
    modelRouteQuestionType: "field-knowledge",
    answerProfileQuestionType: "field-knowledge",
    artifactPolicyQuestionType: "field-knowledge",
    promptContractQuestionType: "field-knowledge",
  });

  assert.equal(observation.coherent, true);
  assert.deepEqual(observation.conflicts, []);
  assert.equal(observation.parentTrajectoryReadOnly, true);
});

test("projects trace metadata into the Human Evaluation observation contract", () => {
  const observation = buildQuestionTypeConsumerObservation({
    prior: adaptQuestionTypePrior({
      source: "interview-brief",
      types: ["system-design"],
    }),
    committedCurrentQuestionType: "general-system-design",
    responseOwnerQuestionType: "general-system-design",
    responsePlaybookQuestionType: "general-system-design",
    kmbPolicyQuestionType: "general-system-design",
    kmbPolicyFamilies: ["system-design"],
    factAnchorPolicyQuestionType: "general-system-design",
    modelRouteQuestionType: "general-system-design",
    answerProfileQuestionType: "general-system-design",
    artifactPolicyQuestionType: "general-system-design",
    promptContractQuestionType: "general-system-design",
    committedCurrentQuestionSourceHash: "source-a",
    questionTypeQuestionSourceHash: "source-a",
    relationQuestionSourceHash: "source-a",
    kmbQuestionSourceHash: "source-a",
    executionPlanQuestionSourceHash: "source-a",
    promptCurrentQuestionSourceHash: "source-a",
  });
  const metadata = formatQuestionTypeConsumerObservationForTrace(observation);
  const projected = projectQuestionTypeConsumerObservationFromTrace(metadata);

  assert.deepEqual(projected, observation);
  assert.equal(metadata.priorUsedAsExecutionGate, false);
  assert.equal(metadata.questionTypeConsumerCoherent, true);
  assert.equal(metadata.questionSourceConsumerCoherent, true);
});

test("flags a prompt that consumes a different question source than the settlement", () => {
  const observation = buildQuestionTypeConsumerObservation({
    committedCurrentQuestionType: "coding",
    responseOwnerQuestionType: "coding",
    responsePlaybookQuestionType: "coding",
    kmbPolicyQuestionType: "coding",
    factAnchorPolicyQuestionType: "coding",
    modelRouteQuestionType: "coding",
    answerProfileQuestionType: "coding",
    artifactPolicyQuestionType: "coding",
    promptContractQuestionType: "coding",
    committedCurrentQuestionSourceHash: "source-a",
    questionTypeQuestionSourceHash: "source-a",
    relationQuestionSourceHash: "source-a",
    kmbQuestionSourceHash: "source-a",
    executionPlanQuestionSourceHash: "source-a",
    promptCurrentQuestionSourceHash: "source-b",
  });

  assert.equal(observation.typeCoherent, true);
  assert.equal(observation.sourceCoherent, false);
  assert.equal(observation.coherent, false);
  assert.deepEqual(observation.sourceConflicts, [
    "settlement-vs-prompt-source",
  ]);
});

test("flags a KMB consumer that retrieves against a different question source", () => {
  const observation = buildQuestionTypeConsumerObservation({
    committedCurrentQuestionType: "project-deep-dive",
    responseOwnerQuestionType: "project-deep-dive",
    responsePlaybookQuestionType: "project-deep-dive",
    kmbPolicyQuestionType: "project-deep-dive",
    factAnchorPolicyQuestionType: "project-deep-dive",
    modelRouteQuestionType: "project-deep-dive",
    answerProfileQuestionType: "project-deep-dive",
    artifactPolicyQuestionType: "project-deep-dive",
    promptContractQuestionType: "project-deep-dive",
    committedCurrentQuestionSourceHash: "source-current",
    questionTypeQuestionSourceHash: "source-current",
    relationQuestionSourceHash: "source-current",
    kmbQuestionSourceHash: "source-previous",
    executionPlanQuestionSourceHash: "source-current",
    promptCurrentQuestionSourceHash: "source-current",
  });

  assert.equal(observation.typeCoherent, true);
  assert.equal(observation.sourceCoherent, false);
  assert.deepEqual(observation.sourceConflicts, [
    "settlement-vs-kmb-source",
  ]);
});

test("keeps legacy source observations evaluable before expanded consumer hashes", () => {
  const observation = buildQuestionTypeConsumerObservation({
    committedCurrentQuestionType: "coding",
    responseOwnerQuestionType: "coding",
    responsePlaybookQuestionType: "coding",
    kmbPolicyQuestionType: "coding",
    factAnchorPolicyQuestionType: "coding",
    modelRouteQuestionType: "coding",
    answerProfileQuestionType: "coding",
    artifactPolicyQuestionType: "coding",
    promptContractQuestionType: "coding",
    committedCurrentQuestionSourceHash: "legacy-source",
    executionPlanQuestionSourceHash: "legacy-source",
    promptCurrentQuestionSourceHash: "legacy-source",
  });

  assert.equal(observation.sourceCoherent, true);
  assert.deepEqual(observation.sourceConflicts, []);
});

test("flags any future trace that lets a prior become an execution gate", () => {
  const projected = projectQuestionTypeConsumerObservationFromTrace({
    ...formatQuestionTypeConsumerObservationForTrace(
      buildQuestionTypeConsumerObservation({
        committedCurrentQuestionType: "coding",
        responseOwnerQuestionType: "coding",
        responsePlaybookQuestionType: "coding",
        kmbPolicyQuestionType: "coding",
        factAnchorPolicyQuestionType: "coding",
        modelRouteQuestionType: "coding",
        answerProfileQuestionType: "coding",
        artifactPolicyQuestionType: "coding",
        promptContractQuestionType: "coding",
      })
    ),
    priorUsedAsExecutionGate: true,
  });

  assert.equal(projected?.coherent, false);
  assert.ok(projected?.conflicts.includes("prior-used-as-execution-gate"));
});
