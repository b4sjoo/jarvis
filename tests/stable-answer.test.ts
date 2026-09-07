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
  updateAnswerDeliveryProgress,
} from "../src/lib/meeting/stable-answer.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import { resolveArtifactPolicySections } from "../src/lib/meeting/response-artifact-authorization.js";
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

test("keeps retained Code with its original child and rejects a different child artifact update", () => {
  const childA = {
    kind: "active-child" as const,
    parentId: "coding-parent",
    childId: "child-a",
  };
  const childB = {
    kind: "active-child" as const,
    parentId: "coding-parent",
    childId: "child-b",
  };
  const first = commitStableAnswerRevision({
    candidate: suggestion(
      "child-a-code",
      "Answer: Child A implementation.\nCode:\n```python\ndef lru():\n    return 1\n```\nComplexity: O(1)."
    ),
    authorizedArtifacts: ["answer", "code", "complexity"],
    taskId: "coding-parent",
    sectionOwner: childA,
    logicalQuestionUnitId: "question-a",
    logicalQuestionRevision: 1,
  });
  assert.ok(first);
  const answerOnly = commitStableAnswerRevision({
    current: first,
    candidate: suggestion("child-b-answer", "Answer: Child B follow-up."),
    authorizedArtifacts: ["answer"],
    taskId: "coding-parent",
    sectionOwner: childB,
    logicalQuestionUnitId: "question-b",
    logicalQuestionRevision: 1,
  });
  assert.ok(answerOnly);
  assert.deepEqual(answerOnly.sections.code.owner, childA);
  assert.deepEqual(answerOnly.sections.answer.owner, childB);

  const rejected = commitStableArtifactOnlyRevision({
    current: answerOnly,
    candidate: suggestion(
      "child-b-regeneration",
      "Answer: Hidden.\nCode:\n```python\ndef binary_search():\n    return 2\n```\nComplexity: O(log n)."
    ),
    authorizedArtifacts: ["code", "complexity"],
    expectedVisibleAnswerRevision: answerOnly.revision,
    expectedTaskId: "coding-parent",
    expectedLogicalQuestionUnitId: "question-b",
    expectedLogicalQuestionRevision: 1,
    sectionOwner: childB,
  });

  assert.equal(rejected.disposition, "rejected");
  assert.equal(rejected.reason, "artifact-section-owner-mismatch");
});

test("transfers authorized identical Code and Complexity to a new child owner", () => {
  const childA = {
    kind: "active-child" as const,
    parentId: "coding-parent",
    childId: "child-a",
  };
  const childB = {
    kind: "active-child" as const,
    parentId: "coding-parent",
    childId: "child-b",
  };
  const first = commitStableAnswerRevision({
    candidate: suggestion(
      "child-a-code",
      "Answer: Child A implementation.\nCode:\n```python\ndef solve():\n    return 1\n```\nComplexity: O(n)."
    ),
    authorizedArtifacts: ["answer", "code", "complexity"],
    taskId: "coding-parent",
    sectionOwner: childA,
    logicalQuestionUnitId: "question-a",
    logicalQuestionRevision: 1,
    committedAt: 100,
  });
  assert.ok(first);

  const second = commitStableAnswerRevision({
    current: first,
    candidate: suggestion(
      "child-b-code",
      "Answer: Child B implementation.\nCode:\n```python\ndef solve():\n    return 1\n```\nComplexity: O(n)."
    ),
    authorizedArtifacts: ["answer", "code", "complexity"],
    taskId: "coding-parent",
    sectionOwner: childB,
    logicalQuestionUnitId: "question-b",
    logicalQuestionRevision: 1,
    committedAt: 200,
  });
  assert.ok(second);
  assert.deepEqual(second.sections.code.owner, childB);
  assert.deepEqual(second.sections.complexity.owner, childB);
  assert.equal(second.sections.code.revision, first.sections.code.revision + 1);
  assert.equal(
    second.sections.complexity.revision,
    first.sections.complexity.revision + 1
  );
  assert.deepEqual(
    collectStableAnswerMutatedArtifacts(first, second),
    ["answer", "code", "complexity"]
  );

  const regenerated = commitStableArtifactOnlyRevision({
    current: second,
    candidate: suggestion(
      "child-b-regeneration",
      "Answer: Hidden.\nCode:\n```python\ndef solve():\n    return 2\n```\nComplexity: O(n)."
    ),
    authorizedArtifacts: ["code", "complexity"],
    expectedVisibleAnswerRevision: second.revision,
    expectedTaskId: "coding-parent",
    expectedLogicalQuestionUnitId: "question-b",
    expectedLogicalQuestionRevision: 1,
    sectionOwner: childB,
    committedAt: 300,
  });
  assert.equal(regenerated.disposition, "committed");
  assert.deepEqual(regenerated.stable?.sections.code.owner, childB);
  assert.deepEqual(regenerated.stable?.sections.complexity.owner, childB);
});

test("keeps a same-owner identical Artifact candidate as a no-change publication", () => {
  const child = {
    kind: "active-child" as const,
    parentId: "coding-parent",
    childId: "child-a",
  };
  const first = commitStableAnswerRevision({
    candidate: suggestion(
      "child-a-code",
      "Answer: Child A implementation.\nCode:\n```python\ndef solve():\n    return 1\n```\nComplexity: O(n)."
    ),
    authorizedArtifacts: ["answer", "code", "complexity"],
    taskId: "coding-parent",
    sectionOwner: child,
    logicalQuestionUnitId: "question-a",
    logicalQuestionRevision: 1,
  });
  assert.ok(first);
  const same = commitStableAnswerRevision({
    current: first,
    candidate: suggestion(
      "child-a-same-code",
      "Answer: Child A implementation.\nCode:\n```python\ndef solve():\n    return 1\n```\nComplexity: O(n)."
    ),
    authorizedArtifacts: ["answer", "code", "complexity"],
    taskId: "coding-parent",
    sectionOwner: child,
    logicalQuestionUnitId: "question-a",
    logicalQuestionRevision: 2,
  });
  assert.ok(same);
  assert.equal(same.sections.code.revision, first.sections.code.revision);
  assert.equal(
    same.sections.complexity.revision,
    first.sections.complexity.revision
  );
  assert.deepEqual(same.sections.code.owner, child);
});

test("allows an implementation child to generate its first Code without retained provenance", () => {
  const child = {
    kind: "active-child" as const,
    parentId: "coding-parent",
    childId: "child-new",
  };
  const answerOnly = commitStableAnswerRevision({
    candidate: suggestion("child-new-answer", "Answer: Ready to implement."),
    authorizedArtifacts: ["answer"],
    taskId: "coding-parent",
    sectionOwner: child,
    logicalQuestionUnitId: "question-new",
    logicalQuestionRevision: 1,
  });
  assert.ok(answerOnly);
  assert.equal(answerOnly.sections.code.owner, null);

  const generated = commitStableArtifactOnlyRevision({
    current: answerOnly,
    candidate: suggestion(
      "child-new-code",
      "Answer: Hidden.\nCode:\n```python\ndef solve():\n    return 1\n```\nComplexity: O(n)."
    ),
    authorizedArtifacts: ["code", "complexity"],
    expectedVisibleAnswerRevision: answerOnly.revision,
    expectedTaskId: "coding-parent",
    expectedLogicalQuestionUnitId: "question-new",
    expectedLogicalQuestionRevision: 1,
    sectionOwner: child,
  });
  assert.equal(generated.disposition, "committed");
  assert.deepEqual(generated.stable?.sections.code.owner, child);
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
  const authorized = resolveArtifactPolicySections({
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

  const complexityOnly = resolveArtifactPolicySections({
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

test("commits pseudocode in Approach without advancing the Code revision", () => {
  const stable = commitStableAnswerRevision({
    candidate: suggestion(
      "pseudocode-answer",
      `Answer: Use a sliding window.
Approach: Preserve a duplicate-free window.

Pseudocode:

\`\`\`text
for each right index:
    move left past the prior duplicate
\`\`\`

Code: -
Complexity: O(n) time and O(k) space.`
    ),
    authorizedArtifacts: ["answer", "complexity"],
    taskId: "coding-parent",
    logicalQuestionUnitId: "coding-question",
    logicalQuestionRevision: 2,
  });

  assert.ok(stable);
  assert.match(
    stable.suggestion.meetingAnswer?.sections.approach ?? "",
    /move left past/
  );
  assert.equal(stable.suggestion.meetingAnswer?.sections.code, undefined);
  assert.equal(stable.sections.code.revision, 0);
  assert.equal(stable.sections.complexity.revision, 1);
});

test("drops unmarked runnable Approach code without Code authority", () => {
  const stable = commitStableAnswerRevision({
    candidate: suggestion(
      "misplaced-code-answer",
      `Answer: Explain the implementation.
Approach: This block is misplaced runnable code.

\`\`\`python
print("must remain Code-owned")
\`\`\`

Code: -
Complexity: O(1).`
    ),
    authorizedArtifacts: ["answer", "complexity"],
    taskId: "coding-parent",
    logicalQuestionUnitId: "coding-question",
    logicalQuestionRevision: 2,
  });

  assert.ok(stable);
  assert.doesNotMatch(
    stable.suggestion.meetingAnswer?.sections.approach ?? "",
    /must remain Code-owned/
  );
  assert.equal(stable.suggestion.meetingAnswer?.sections.code, undefined);
  assert.equal(stable.sections.code.revision, 0);
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
  assert.deepEqual(trace.committedArtifacts, []);
  assert.deepEqual(trace.lifecycleResetArtifacts, ["code", "complexity"]);
});

test("reports only section deltas from a published stable answer as committed artifacts", () => {
  const stable = commitStableAnswerRevision({
    candidate: suggestion(
      "coding-visible",
      "Answer: Implement it.\nCode:\n```python\nprint(1)\n```\nComplexity: O(1)"
    ),
    authorizedArtifacts: ["answer", "code", "complexity"],
    taskId: "coding-parent",
    logicalQuestionUnitId: "coding-question",
    logicalQuestionRevision: 1,
  });
  assert.ok(stable);

  const trace = formatStableAnswerCommitForTrace({
    stable,
    decision: { disposition: "committed", reason: "authorized" },
    authorizedArtifacts: ["answer", "code", "complexity"],
    requestedArtifacts: ["answer", "code", "complexity"],
    candidateMutatedArtifacts: ["answer", "code", "complexity"],
  });

  assert.deepEqual(trace.committedArtifacts, [
    "answer",
    "code",
    "complexity",
  ]);
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

test("commits a generation already visible before the delivery lock began", () => {
  const decision = decideStableAnswerCommit({
    candidate: suggestion("answer-2", "Answer: Continue the same response."),
    refreshAuthority: {
      authorized: true,
      kind: "automatic-substantive",
      reason: "substantive-turn",
      hardOverride: false,
      maySupersedeGeneration: true,
    },
    deliveryLockActive: true,
    sameGenerationVisible: true,
  });

  assert.equal(decision.disposition, "committed");
});
