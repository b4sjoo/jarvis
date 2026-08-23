import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeResponseArtifactMutation,
  formatResponseArtifactAuthorizationForTrace,
} from "../src/lib/meeting/response-artifact-authorization.js";

test("authorizes persistent answer and whiteboard updates for the canonical design parent", () => {
  const decision = authorizeResponseArtifactMutation({
    parentTaskId: "parent-design",
    parentQuestionType: "general-system-design",
    responseOwnerQuestionType: "general-system-design",
    responseOwnerSource: "committed-parent",
    relation: "followup-parent",
  });

  assert.equal(decision.disposition, "parent-owner-authorized");
  assert.equal(decision.allowLatestUsefulAnswer, true);
  assert.equal(decision.allowWhiteboard, true);
  assert.equal(decision.allowParentContextMutation, true);
});

test("authorizes artifacts while an eligible new parent is being created", () => {
  const decision = authorizeResponseArtifactMutation({
    parentQuestionType: "coding",
    responseOwnerQuestionType: "coding",
    responseOwnerSource: "current-question",
    relation: "new-parent",
    creatingParent: true,
  });

  assert.equal(decision.disposition, "parent-owner-authorized");
  assert.equal(decision.allowLatestUsefulAnswer, true);
  assert.equal(decision.allowCode, true);
  assert.equal(decision.allowComplexity, true);
});

test("keeps a field-knowledge child display-only under an AI/ML design parent", () => {
  const decision = authorizeResponseArtifactMutation({
    parentTaskId: "parent-aiml",
    parentQuestionType: "ai-ml-system-design",
    responseOwnerQuestionType: "field-knowledge",
    responseOwnerSource: "authorized-child",
    relation: "child-probe",
  });

  assert.equal(decision.disposition, "display-only-child");
  assert.equal(decision.allowLatestUsefulAnswer, false);
  assert.equal(decision.allowWhiteboard, false);
  assert.equal(decision.allowParentContextMutation, false);
});

test("allows a coding child to update only the code cache", () => {
  const decision = authorizeResponseArtifactMutation({
    parentTaskId: "parent-project",
    parentQuestionType: "project-deep-dive",
    responseOwnerQuestionType: "coding",
    responseOwnerSource: "authorized-child",
    relation: "child-probe",
    subtaskIntent: "implementation-probe",
  });

  assert.equal(decision.disposition, "coding-child-authorized");
  assert.equal(decision.allowCode, true);
  assert.equal(decision.allowComplexity, true);
  assert.equal(decision.allowLatestUsefulAnswer, false);
  assert.equal(decision.allowWhiteboard, false);
});

test("coding parent artifact authority follows the settled required artifact set", () => {
  const answerOnly = authorizeResponseArtifactMutation({
    parentQuestionType: "coding",
    responseOwnerQuestionType: "coding",
    responseOwnerSource: "current-question",
    relation: "new-parent",
    creatingParent: true,
    requiredArtifacts: ["answer", "complexity"],
  });
  const implementation = authorizeResponseArtifactMutation({
    parentQuestionType: "coding",
    responseOwnerQuestionType: "coding",
    responseOwnerSource: "current-question",
    relation: "new-parent",
    creatingParent: true,
    requiredArtifacts: ["answer", "code", "complexity"],
  });

  assert.equal(answerOnly.allowCode, false);
  assert.equal(answerOnly.allowComplexity, true);
  assert.equal(implementation.allowCode, true);
  assert.equal(implementation.allowComplexity, true);
});

test("allows a coding child complexity probe to preserve code", () => {
  const decision = authorizeResponseArtifactMutation({
    parentTaskId: "parent-project",
    parentQuestionType: "project-deep-dive",
    responseOwnerQuestionType: "coding",
    responseOwnerSource: "authorized-child",
    relation: "child-probe",
    subtaskIntent: "complexity-probe",
  });

  assert.equal(decision.disposition, "coding-child-authorized");
  assert.equal(decision.allowCode, false);
  assert.equal(decision.allowComplexity, true);
});

test("rejects a wrong-domain response from mutating the current parent", () => {
  const decision = authorizeResponseArtifactMutation({
    parentTaskId: "parent-gsd",
    parentQuestionType: "general-system-design",
    responseOwnerQuestionType: "behavioral",
    responseOwnerSource: "current-question",
    relation: "followup-parent",
  });

  assert.equal(decision.disposition, "rejected-incompatible-owner");
  assert.equal(decision.allowLatestUsefulAnswer, false);
  assert.equal(decision.allowWhiteboard, false);
  assert.equal(decision.allowCode, false);
  assert.equal(decision.allowComplexity, false);
});

test("treats logistics and independent field knowledge as transient responses", () => {
  for (const input of [
    {
      responseOwnerQuestionType: "unknown",
      relation: "logistics" as const,
    },
    {
      responseOwnerQuestionType: "field-knowledge",
      relation: "followup-parent" as const,
    },
  ]) {
    const decision = authorizeResponseArtifactMutation({
      parentTaskId: "parent-active",
      parentQuestionType: "project-deep-dive",
      responseOwnerSource: "current-question",
      ...input,
    });
    assert.equal(decision.disposition, "display-only-transient");
    assert.equal(decision.allowParentContextMutation, false);
  }
});

test("trace metadata exposes every artifact authorization surface", () => {
  const metadata = formatResponseArtifactAuthorizationForTrace(
    authorizeResponseArtifactMutation({
      parentTaskId: "parent-aiml",
      parentQuestionType: "ai-ml-system-design",
      responseOwnerQuestionType: "field-knowledge",
      responseOwnerSource: "authorized-child",
      relation: "child-probe",
    })
  );

  assert.equal(metadata.responseArtifactMutationDisposition, "display-only-child");
  assert.equal(metadata.responseArtifactWhiteboardAuthorized, false);
  assert.equal(metadata.responseArtifactComplexityAuthorized, false);
  assert.equal(metadata.responseArtifactParentContextAuthorized, false);
});

test("separates ordinary coding follow-ups from implementation and complexity mutations", () => {
  const base = {
    parentTaskId: "parent-coding",
    parentQuestionType: "coding",
    responseOwnerQuestionType: "coding",
    responseOwnerSource: "committed-parent" as const,
    relation: "followup-parent" as const,
  };
  const ordinary = authorizeResponseArtifactMutation(base);
  const implementation = authorizeResponseArtifactMutation({
    ...base,
    subtaskIntent: "implementation-probe",
  });
  const complexity = authorizeResponseArtifactMutation({
    ...base,
    subtaskIntent: "complexity-probe",
  });

  assert.equal(ordinary.allowCode, false);
  assert.equal(ordinary.allowComplexity, false);
  assert.equal(implementation.allowCode, true);
  assert.equal(implementation.allowComplexity, true);
  assert.equal(complexity.allowCode, false);
  assert.equal(complexity.allowComplexity, true);
});
