import assert from "node:assert/strict";
import test from "node:test";
import {
  appendAdvisorGeneratedContinuityCapsule,
  createAdvisorGeneratedContinuityCapsule,
  decideBoundedRecentHistoryRead,
  formatBoundedRecentHistoryForTrace,
  toAdvisorGeneratedContinuityEvidence,
} from "../src/lib/meeting/bounded-recent-history.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import { commitStableAnswerRevision } from "../src/lib/meeting/stable-answer.js";
import type {
  AdvisorGeneratedContinuityCapsule,
  AdvisorSuggestion,
} from "../src/lib/meeting/types.js";

function buildStableAnswer(content: string) {
  const suggestion: AdvisorSuggestion = {
    id: "suggestion-a",
    kind: "answer",
    content,
    meetingAnswer: parseMeetingAnswer(content),
    createdAt: 100,
    basedOnTurnIds: [],
    basedOnObservationIds: [],
    confidence: "high",
    sourceTraceId: "trace-a",
  };
  const stable = commitStableAnswerRevision({
    candidate: suggestion,
    authorizedArtifacts: [
      "answer",
      "code",
      "complexity",
      "whiteboard",
    ],
    taskId: "parent-a",
    logicalQuestionUnitId: "lqu-a",
    logicalQuestionRevision: 2,
    committedAt: 100,
  });
  assert.ok(stable);
  return stable;
}

function capsule(
  id: string,
  parentTaskId = "parent-a"
): AdvisorGeneratedContinuityCapsule {
  return {
    id,
    parentTaskId,
    parentRevision: 2,
    logicalQuestionUnitId: `lqu-${id}`,
    logicalQuestionRevision: 1,
    answerRevision: Number(id.replace(/\D/g, "")) || 1,
    sourceSuggestionId: `suggestion-${id}`,
    sourceTraceId: `trace-${id}`,
    text: `Option ${id} trades latency for stronger consistency.`,
    source: "generated-continuity",
    createdAt: 100,
  };
}

test("creates a bounded continuity capsule without code or whiteboard", () => {
  const stable = buildStableAnswer(`Answer: Prefer asynchronous replication because it reduces write latency, while synchronous replication provides stronger consistency.
Approach: The trade-off is lower latency versus fresher reads.
Whiteboard:
\`\`\`mermaid
graph TD
  Secret --> Diagram
\`\`\`
Code:
\`\`\`python
SECRET_CODE = True
\`\`\`
Complexity: O(1).`);

  const generated = createAdvisorGeneratedContinuityCapsule({
    stable,
    parentRevision: 3,
  });

  assert.ok(generated);
  assert.equal(generated.source, "generated-continuity");
  assert.equal(generated.parentTaskId, "parent-a");
  assert.match(generated.text, /asynchronous replication/);
  assert.match(generated.text, /trade-off/);
  assert.doesNotMatch(generated.text, /SECRET_CODE|Secret|Diagram/);
  assert.ok(generated.text.length <= 520);
});

test("keeps history bounded to one parent and resets on a hard boundary", () => {
  const sameParent = appendAdvisorGeneratedContinuityCapsule({
    history: [capsule("1"), capsule("old", "parent-old")],
    capsule: capsule("2"),
  });
  assert.deepEqual(
    sameParent.map((item) => item.parentTaskId),
    ["parent-a", "parent-a"]
  );

  const reset = appendAdvisorGeneratedContinuityCapsule({
    history: sameParent,
    capsule: capsule("3", "parent-b"),
    reset: true,
  });
  assert.deepEqual(
    reset.map((item) => item.parentTaskId),
    ["parent-b"]
  );
});

test("authorizes only a bounded same-parent deictic follow-up", () => {
  const decision = decideBoundedRecentHistoryRead({
    questionText: "Can you explain that trade-off in more detail?",
    activeParentId: "parent-a",
    relation: "followup-parent",
    capsules: [capsule("1"), capsule("2"), capsule("3")],
  });

  assert.equal(decision.authorized, true);
  assert.equal(decision.contextReadScope, "bounded-recent-history");
  assert.equal(decision.reason, "authorized-deictic-followup");
  assert.equal(decision.selectedCapsules.length, 2);
  assert.deepEqual(
    decision.selectedCapsules.map((item) => item.id),
    ["2", "3"]
  );
  assert.ok(toAdvisorGeneratedContinuityEvidence(decision));

  const trace = formatBoundedRecentHistoryForTrace(decision);
  assert.equal(trace.boundedRecentHistoryFactAuthority, false);
  assert.equal(trace.boundedRecentHistoryTaskMutationAuthority, false);
  assert.equal(trace.boundedRecentHistoryArtifactMutationAuthority, false);
  assert.equal(JSON.stringify(trace).includes(decision.selectedCapsules[0].text), false);
});

test("denies independent, corrected, narrowed, and cross-parent reads", () => {
  const base = {
    activeParentId: "parent-a",
    relation: "followup-parent" as const,
    capsules: [capsule("1")],
  };

  assert.equal(
    decideBoundedRecentHistoryRead({
      ...base,
      questionText: "What is consistent hashing?",
    }).reason,
    "not-deictic"
  );
  assert.equal(
    decideBoundedRecentHistoryRead({
      ...base,
      questionText: "Explain that option.",
      hasManualCorrection: true,
    }).reason,
    "manual-correction-current-only"
  );
  assert.equal(
    decideBoundedRecentHistoryRead({
      ...base,
      questionText: "Explain that option.",
      responseAction: "narrow-context",
    }).reason,
    "manual-narrow-current-only"
  );
  assert.equal(
    decideBoundedRecentHistoryRead({
      questionText: "Explain that option.",
      activeParentId: "parent-b",
      relation: "followup-parent",
      capsules: [capsule("1")],
    }).reason,
    "parent-mismatch"
  );
  assert.equal(
    decideBoundedRecentHistoryRead({
      ...base,
      questionText: "Explain that option.",
      relation: "new-parent",
    }).reason,
    "new-parent-boundary"
  );
  assert.equal(
    decideBoundedRecentHistoryRead({
      ...base,
      questionText: "Explain that option.",
      sourceConflict: true,
    }).reason,
    "source-conflict"
  );
});

test("explicit Enhance authorizes the same-parent capsule without a deictic phrase", () => {
  const decision = decideBoundedRecentHistoryRead({
    questionText: "Give me a more complete answer.",
    activeParentId: "parent-a",
    relation: "unknown",
    responseAction: "enhance-context",
    capsules: [capsule("1")],
  });

  assert.equal(decision.authorized, true);
  assert.equal(decision.reason, "authorized-explicit-enhance");
  assert.equal(decision.explicitEnhance, true);
});
