import assert from "node:assert/strict";
import test from "node:test";
import {
  collectStableAnswerMutationDelta,
  collectStableAnswerMutatedArtifacts,
  commitStableArtifactOnlyRevision,
  commitStableAnswerRevision,
  decideStableAnswerCommit,
  formatStableAnswerCommitForTrace,
  isAnswerDeliveryLockActive,
  resolveAuthorizedAnswerArtifacts,
  updateAnswerDeliveryProgress,
} from "../src/lib/meeting/stable-answer.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import type {
  AdvisorSuggestion,
  TranscriptTurn,
} from "../src/lib/meeting/types.js";

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

test("commits answer sections atomically while preserving unauthorized artifacts", () => {
  const first = commitStableAnswerRevision({
    candidate: suggestion(
      "answer-1",
      `Answer: Explain the monotonic deque.
Code:
\`\`\`python
def solve():
    return 1
\`\`\`
Complexity: O(n).`
    ),
    authorizedArtifacts: ["answer", "code", "complexity"],
    taskId: "coding-parent",
    logicalQuestionUnitId: "question-1",
    logicalQuestionRevision: 1,
    committedAt: 100,
  });
  assert.ok(first);

  const second = commitStableAnswerRevision({
    current: first,
    candidate: suggestion(
      "answer-2",
      `Answer: The duplicate-index edge case needs a strict deque invariant.
Code:
\`\`\`python
def wrong():
    return 0
\`\`\`
Complexity: O(n squared).`
    ),
    authorizedArtifacts: ["answer"],
    taskId: "coding-parent",
    logicalQuestionUnitId: "question-1",
    logicalQuestionRevision: 2,
    committedAt: 200,
  });
  assert.ok(second);
  assert.equal(
    second.suggestion.meetingAnswer?.sections.code,
    "def solve():\n    return 1"
  );
  assert.equal(second.suggestion.meetingAnswer?.sections.complexity, "O(n).");
  assert.equal(second.sections.answer.revision, 2);
  assert.equal(second.sections.code.revision, 1);
  assert.equal(second.sections.complexity.revision, 1);
});

test("publishes a Whiteboard without replacing the visible Answer", () => {
  const current = commitStableAnswerRevision({
    candidate: suggestion(
      "design-1",
      "Answer: Start with one region.\nWhiteboard:\n```mermaid\ngraph TD\nA-->B\n```"
    ),
    authorizedArtifacts: ["answer", "whiteboard"],
    taskId: "design-parent",
    logicalQuestionUnitId: "design-question",
    logicalQuestionRevision: 1,
  });
  assert.ok(current);

  const decision = commitStableArtifactOnlyRevision({
    current,
    candidate: suggestion(
      "design-artifact-2",
      "Answer: This candidate answer must stay hidden.\nWhiteboard:\n```mermaid\ngraph TD\nA-->B\nB-->C\n```"
    ),
    authorizedArtifacts: ["whiteboard"],
    expectedVisibleAnswerRevision: current.revision,
    expectedTaskId: current.taskId,
    expectedLogicalQuestionUnitId: current.logicalQuestionUnitId,
    expectedLogicalQuestionRevision: current.logicalQuestionRevision,
  });

  assert.equal(decision.disposition, "committed");
  assert.equal(
    decision.stable?.suggestion.meetingAnswer?.sections.answer,
    "Start with one region."
  );
  assert.equal(
    decision.stable?.sections.answer.revision,
    current.sections.answer.revision
  );
  assert.equal(
    decision.stable?.sections.whiteboard.revision,
    current.sections.whiteboard.revision + 1
  );
  assert.deepEqual(decision.mutatedArtifacts, ["whiteboard"]);
});

test("requires a complete Coding Artifact family and exact visible owner", () => {
  const current = commitStableAnswerRevision({
    candidate: suggestion(
      "coding-1",
      "Answer: Use a map.\nCode:\n```python\nprint(1)\n```\nComplexity: O(n)."
    ),
    authorizedArtifacts: ["answer", "code", "complexity"],
    taskId: "coding-parent",
    logicalQuestionUnitId: "coding-question",
    logicalQuestionRevision: 1,
  });
  assert.ok(current);

  const partial = commitStableArtifactOnlyRevision({
    current,
    candidate: suggestion(
      "coding-partial",
      "Answer: Ignore this.\nCode:\n```python\nprint(2)\n```"
    ),
    authorizedArtifacts: ["code", "complexity"],
    expectedVisibleAnswerRevision: current.revision,
    expectedTaskId: current.taskId,
    expectedLogicalQuestionUnitId: current.logicalQuestionUnitId,
    expectedLogicalQuestionRevision: current.logicalQuestionRevision,
  });
  assert.equal(partial.reason, "artifact-candidate-missing");

  const stale = commitStableArtifactOnlyRevision({
    current,
    candidate: suggestion(
      "coding-complete",
      "Answer: Ignore this.\nCode:\n```python\nprint(2)\n```\nComplexity: O(1)."
    ),
    authorizedArtifacts: ["code", "complexity"],
    expectedVisibleAnswerRevision: current.revision + 1,
    expectedTaskId: current.taskId,
    expectedLogicalQuestionUnitId: current.logicalQuestionUnitId,
    expectedLogicalQuestionRevision: current.logicalQuestionRevision,
  });
  assert.equal(stale.reason, "visible-answer-revision-mismatch");
});

test("projects the Code family into only its phase-authorized sections", () => {
  const authorized = resolveAuthorizedAnswerArtifacts({
    artifactPolicy: {
      disposition: "parent-owner-authorized",
      reason: "test",
      parentQuestionType: "coding",
      responseOwnerQuestionType: "coding",
      responseOwnerSource: "committed-parent",
      allowLatestUsefulAnswer: true,
      allowWhiteboard: false,
      allowCode: true,
      allowComplexity: false,
      allowParentContextMutation: true,
    },
    artifactIntent: "revise-code",
  });

  assert.deepEqual(authorized, ["answer", "code"]);

  const complexityOnly = resolveAuthorizedAnswerArtifacts({
    artifactPolicy: {
      disposition: "parent-owner-authorized",
      reason: "test",
      parentQuestionType: "coding",
      responseOwnerQuestionType: "coding",
      responseOwnerSource: "committed-parent",
      allowLatestUsefulAnswer: true,
      allowWhiteboard: false,
      allowCode: false,
      allowComplexity: true,
      allowParentContextMutation: true,
    },
    artifactIntent: "revise-code",
  });

  assert.deepEqual(complexityOnly, ["answer", "complexity"]);
});

test("does not advance an authorized artifact revision when the candidate omits it", () => {
  const first = commitStableAnswerRevision({
    candidate: suggestion(
      "answer-1",
      `Answer: Explain the monotonic deque.
Code:
\`\`\`python
def solve():
    return 1
\`\`\`
Complexity: O(n).`
    ),
    authorizedArtifacts: ["answer", "code", "complexity"],
    taskId: "coding-parent",
    logicalQuestionUnitId: "question-1",
    logicalQuestionRevision: 1,
    committedAt: 100,
  });
  assert.ok(first);

  const second = commitStableAnswerRevision({
    current: first,
    candidate: suggestion(
      "answer-2",
      "Answer: Keep the existing implementation and focus on the invariant."
    ),
    authorizedArtifacts: ["answer", "code", "complexity"],
    taskId: "coding-parent",
    logicalQuestionUnitId: "question-1",
    logicalQuestionRevision: 2,
    committedAt: 200,
  });
  assert.ok(second);
  assert.equal(second.sections.answer.revision, 2);
  assert.equal(second.sections.code.revision, 1);
  assert.equal(second.sections.complexity.revision, 1);
  assert.deepEqual(collectStableAnswerMutatedArtifacts(first, second), [
    "answer",
  ]);
});

test("separates a cross-owner artifact reset from candidate mutations", () => {
  const coding = commitStableAnswerRevision({
    candidate: suggestion(
      "coding-answer",
      `Answer: Use a hash map and doubly linked list.
Code:
\`\`\`python
class LRUCache:
    pass
\`\`\`
Complexity: O(1) get and put.`
    ),
    authorizedArtifacts: ["answer", "code", "complexity"],
    taskId: "coding-parent",
    logicalQuestionUnitId: "coding-question",
    logicalQuestionRevision: 1,
  });
  assert.ok(coding);
  const behavioral = commitStableAnswerRevision({
    current: coding,
    candidate: suggestion(
      "behavioral-answer",
      "Answer: I aligned the team around a smaller reversible milestone."
    ),
    authorizedArtifacts: ["answer"],
    taskId: "behavioral-parent",
    logicalQuestionUnitId: "behavioral-question",
    logicalQuestionRevision: 1,
    resetSections: true,
  });
  assert.ok(behavioral);

  assert.deepEqual(
    collectStableAnswerMutationDelta(coding, behavioral, {
      resetSections: true,
    }),
    {
      candidateMutatedArtifacts: ["answer"],
      lifecycleResetArtifacts: ["code", "complexity"],
    }
  );
});

test("detects new-owner Code even when its local revision equals the old revision", () => {
  const first = commitStableAnswerRevision({
    candidate: suggestion(
      "coding-one",
      "Answer: First.\nCode:\n```python\nprint(1)\n```"
    ),
    authorizedArtifacts: ["answer", "code"],
    taskId: "coding-parent-one",
    logicalQuestionUnitId: "question-one",
    logicalQuestionRevision: 1,
  });
  assert.ok(first);
  const second = commitStableAnswerRevision({
    current: first,
    candidate: suggestion(
      "coding-two",
      "Answer: Second.\nCode:\n```python\nprint(2)\n```"
    ),
    authorizedArtifacts: ["answer", "code"],
    taskId: "coding-parent-two",
    logicalQuestionUnitId: "question-two",
    logicalQuestionRevision: 1,
    resetSections: true,
  });
  assert.ok(second);
  assert.equal(first.sections.code.revision, second.sections.code.revision);
  assert.deepEqual(
    collectStableAnswerMutatedArtifacts(first, second, {
      resetSections: true,
    }),
    ["answer", "code"]
  );
});

test("does not report a stable commit when publication produced no stable or pending answer", () => {
  const trace = formatStableAnswerCommitForTrace({
    decision: { disposition: "committed", reason: "authorized" },
    authorizedArtifacts: ["answer"],
    requestedArtifacts: ["answer"],
    candidateMutatedArtifacts: ["answer"],
    lifecycleResetArtifacts: ["code", "complexity"],
  });

  assert.equal(trace.stableAnswerCommitDisposition, "rejected");
  assert.equal(trace.stableAnswerCommitReason, "candidate-not-published");
  assert.deepEqual(trace.candidateMutatedArtifacts, ["answer"]);
  assert.deepEqual(trace.lifecycleResetArtifacts, ["code", "complexity"]);
});

test("locks delivery after a sufficiently long overlapping me turn", () => {
  const stable = commitStableAnswerRevision({
    candidate: suggestion(
      "answer-1",
      "Answer: We use a monotonic deque to keep candidate indices in decreasing value order and remove expired indices."
    ),
    authorizedArtifacts: ["answer"],
    taskId: "coding-parent",
    logicalQuestionUnitId: "question-1",
    logicalQuestionRevision: 1,
    committedAt: 100,
  });
  assert.ok(stable);
  const turn: TranscriptTurn = {
    id: "me-1",
    speaker: "me",
    text: "We use a monotonic deque to keep candidate indices in decreasing value order and remove expired indices from the front.",
    startedAt: 1_000,
    endedAt: 8_000,
    isFinal: true,
    source: "microphone",
  };
  const progress = updateAnswerDeliveryProgress({
    stable,
    turn,
    now: 8_000,
  });

  assert.ok(progress.lockedAt);
  assert.equal(
    isAnswerDeliveryLockActive(progress, {
      visibleAnswerRevision: stable.revision,
      taskId: stable.taskId,
      now: 8_500,
    }),
    true
  );
  assert.equal(
    decideStableAnswerCommit({
      candidate: suggestion("answer-2", "Answer: A newer soft update."),
      refreshAuthority: {
        authorized: true,
        kind: "automatic-substantive",
        reason: "substantive-turn",
        hardOverride: false,
        maySupersedeGeneration: true,
      },
      deliveryLockActive: true,
    }).disposition,
    "pending"
  );
});

test("manual correction bypasses an active delivery lock", () => {
  const decision = decideStableAnswerCommit({
    candidate: suggestion("answer-2", "Answer: Corrected immediately."),
    refreshAuthority: {
      authorized: true,
      kind: "manual-hard-override",
      reason: "manual-correction",
      hardOverride: true,
      maySupersedeGeneration: true,
    },
    deliveryLockActive: true,
  });

  assert.equal(decision.disposition, "committed");
});
