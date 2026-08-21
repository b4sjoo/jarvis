import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeAnswerGenerationLease,
  createAnswerGenerationLease,
} from "../src/lib/meeting/answer-generation-lease.js";
import {
  GenerationDerivedCommitCoordinator,
  GenerationResultLedger,
} from "../src/lib/meeting/generation-result-ledger.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import {
  collectStableAnswerMutationDelta,
  commitStableAnswerRevision,
} from "../src/lib/meeting/stable-answer.js";
import type { AdvisorSuggestion } from "../src/lib/meeting/types.js";

function suggestion(id: string, content: string): AdvisorSuggestion {
  return {
    id,
    kind: "answer",
    content,
    meetingAnswer: parseMeetingAnswer(content),
    createdAt: 100,
    basedOnTurnIds: [],
    basedOnObservationIds: [],
    confidence: "high",
  };
}

function buildCodingStable() {
  return commitStableAnswerRevision({
    candidate: suggestion(
      "coding-answer",
      "Answer: Use a hash map and list.\nCode:\n```python\nclass LRUCache: pass\n```\nComplexity: O(1)."
    ),
    authorizedArtifacts: ["answer", "code", "complexity"],
    taskId: "coding-parent",
    logicalQuestionUnitId: "coding-question",
    logicalQuestionRevision: 1,
    revision: 1,
  });
}

test("commits an Answer-only new parent while lifecycle-resetting old Code", () => {
  const coding = buildCodingStable();
  assert.ok(coding);
  const project = commitStableAnswerRevision({
    current: coding,
    candidate: suggestion(
      "project-answer",
      "Answer: I used NDJSON to preserve Bulk API framing and parsed per-item failures."
    ),
    authorizedArtifacts: ["answer"],
    taskId: "project-parent",
    logicalQuestionUnitId: "project-question",
    logicalQuestionRevision: 1,
    resetSections: true,
    revision: 2,
  });
  assert.ok(project);
  const delta = collectStableAnswerMutationDelta(coding, project, {
    resetSections: true,
  });
  assert.deepEqual(delta, {
    candidateMutatedArtifacts: ["answer"],
    lifecycleResetArtifacts: ["code", "complexity"],
  });

  const lease = createAnswerGenerationLease({
    sessionId: "session-a",
    runtimeEpoch: 2,
    preparationContextRevision: 1,
    taskId: "project-parent",
    taskRevision: 1,
    logicalQuestionUnitId: "project-question",
    logicalQuestionRevision: 1,
    baseVisibleAnswerRevision: 1,
    sourceTurnIds: ["project-turn"],
    manualCorrectionRevision: 0,
    responseActionRevision: 0,
    modelRoute: "main:provider",
    artifactOwnerId: "project-parent",
    requestedArtifacts: ["answer"],
  });
  const leaseAuthorization = authorizeAnswerGenerationLease(lease, {
    sessionId: "session-a",
    runtimeEpoch: 2,
    preparationContextRevision: 1,
    taskId: "project-parent",
    taskRevision: 1,
    logicalQuestionUnitId: "project-question",
    logicalQuestionRevision: 1,
    visibleAnswerRevision: 1,
    manualCorrectionRevision: 0,
    responseActionRevision: 0,
    artifactOwnerId: "project-parent",
    authorizedArtifacts: ["answer"],
    candidateMutatedArtifacts: delta.candidateMutatedArtifacts,
  });
  assert.equal(leaseAuthorization.authorized, true);

  let published = false;
  const coordinator = new GenerationDerivedCommitCoordinator(
    new GenerationResultLedger()
  );
  const result = coordinator.commit({
    lease,
    leaseAuthorization,
    expectedTaskRuntimeRevision: 1,
    currentTaskRuntimeRevision: 1,
    candidateAccepted: true,
    visibleAnswerRevision: 2,
    apply: () => {
      published = true;
    },
  });
  assert.equal(result.committed, true);
  assert.equal(published, true);
});

test("still rejects a real new-parent Code mutation without Code authority", () => {
  const coding = buildCodingStable();
  assert.ok(coding);
  const projectWithCode = commitStableAnswerRevision({
    current: coding,
    candidate: suggestion(
      "project-code-answer",
      "Answer: Proposed implementation.\nCode:\n```python\nretry()\n```"
    ),
    authorizedArtifacts: ["answer", "code"],
    taskId: "project-parent",
    logicalQuestionUnitId: "project-question",
    logicalQuestionRevision: 1,
    resetSections: true,
    revision: 2,
  });
  assert.ok(projectWithCode);
  const delta = collectStableAnswerMutationDelta(coding, projectWithCode, {
    resetSections: true,
  });
  assert.deepEqual(delta.candidateMutatedArtifacts, ["answer", "code"]);

  const lease = createAnswerGenerationLease({
    sessionId: "session-a",
    runtimeEpoch: 2,
    preparationContextRevision: 1,
    taskId: "project-parent",
    taskRevision: 1,
    logicalQuestionUnitId: "project-question",
    logicalQuestionRevision: 1,
    baseVisibleAnswerRevision: 1,
    sourceTurnIds: ["project-turn"],
    manualCorrectionRevision: 0,
    responseActionRevision: 0,
    modelRoute: "main:provider",
    artifactOwnerId: "project-parent",
    requestedArtifacts: ["answer"],
  });
  const authorization = authorizeAnswerGenerationLease(lease, {
    sessionId: "session-a",
    runtimeEpoch: 2,
    preparationContextRevision: 1,
    taskId: "project-parent",
    taskRevision: 1,
    logicalQuestionUnitId: "project-question",
    logicalQuestionRevision: 1,
    visibleAnswerRevision: 1,
    manualCorrectionRevision: 0,
    responseActionRevision: 0,
    artifactOwnerId: "project-parent",
    authorizedArtifacts: ["answer"],
    candidateMutatedArtifacts: delta.candidateMutatedArtifacts,
  });

  assert.equal(authorization.authorized, false);
  assert.equal(authorization.reason, "artifact-authority-revoked");
  assert.deepEqual(authorization.rejectedArtifacts, ["code"]);
});
