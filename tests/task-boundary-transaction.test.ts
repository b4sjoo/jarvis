import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCommittedTaskBoundaryParent,
  commitTaskBoundaryCandidate,
  createTaskBoundaryCandidate,
  expireTaskBoundaryCandidate,
  taskBoundarySurvivesAdvisorOutcome,
} from "../src/lib/meeting/task-boundary-transaction.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import {
  authorizeRuntimeCommit,
  buildRuntimeCommitSnapshot,
  createRuntimeCommitToken,
  rebaseRuntimeCommitToken,
} from "../src/lib/meeting/runtime-commit-authorization.js";

function logicalQuestion(
  text = "Design a food delivery service"
): LogicalQuestionUnit {
  return {
    id: "logical-question-a",
    revision: 2,
    sessionId: "session-a",
    runtimeEpoch: 3,
    currentTurnId: "turn-b",
    sourceTurnIds: ["turn-a", "turn-b"],
    sources: [
      { turnId: "turn-a", text: "Design a food", startedAt: 10, endedAt: 20 },
      { turnId: "turn-b", text: "delivery service", startedAt: 30, endedAt: 40 },
    ],
    normalizedText: text,
    startedAt: 10,
    updatedAt: 40,
    compositionReasons: ["replaced-advisor-question"],
    boundaryReason: "bounded-continuation",
    truncated: false,
  };
}

test("commits a complete high-authority new parent before advisor execution", () => {
  const unit = logicalQuestion();
  const candidate = createTaskBoundaryCandidate({
    logicalQuestionUnit: unit,
    proposedQuestionType: "general-system-design",
    proposedRelation: "new-parent",
    authoritySource: "accepted-transcript",
    confidence: 0.92,
    questionComplete: true,
    mutationAuthorized: true,
    commitParent: true,
    now: 100,
  });
  assert.ok(candidate);
  assert.equal(candidate.commitPolicy, "immediate");

  const parent = buildCommittedTaskBoundaryParent({
    candidate,
    logicalQuestionUnit: unit,
    source: "voice",
    questionInstanceId: "question-a",
    now: 110,
  });
  assert.ok(parent);
  const committed = commitTaskBoundaryCandidate(candidate, parent.id, 110);

  assert.equal(parent.topic, "Design a food delivery service");
  assert.deepEqual(parent.canonicalQuestionSourceTurnIds, ["turn-a", "turn-b"]);
  assert.equal(committed.state, "committed");
  assert.equal(taskBoundarySurvivesAdvisorOutcome(committed, "cancelled"), true);
  assert.equal(taskBoundarySurvivesAdvisorOutcome(committed, "error"), true);
});

test("keeps an incomplete boundary pending until its bounded completion", () => {
  const candidate = createTaskBoundaryCandidate({
    logicalQuestionUnit: logicalQuestion("Design a system that"),
    proposedQuestionType: "unknown",
    proposedRelation: "unknown",
    authoritySource: "accepted-transcript",
    confidence: 0.8,
    questionComplete: false,
    mutationAuthorized: true,
    commitParent: true,
    now: 100,
  });
  assert.ok(candidate);
  assert.equal(candidate.commitPolicy, "await-adjacent-completion");
  assert.equal(candidate.mutationDisposition, "pending-incomplete-question");
  assert.equal(expireTaskBoundaryCandidate(candidate, 1_000)?.state, "pending");
  assert.equal(expireTaskBoundaryCandidate(candidate, 16_000)?.state, "expired");
});

test("a committed boundary survives cancellation of its advisor owner", () => {
  const manager = new MeetingContextManager();
  const unit = logicalQuestion();
  const candidate = createTaskBoundaryCandidate({
    logicalQuestionUnit: unit,
    proposedQuestionType: "general-system-design",
    proposedRelation: "new-parent",
    authoritySource: "accepted-transcript",
    confidence: 0.9,
    questionComplete: true,
    mutationAuthorized: true,
    commitParent: true,
  });
  assert.ok(candidate);
  const token = createRuntimeCommitToken({
    operationId: "advisor-a",
    pipeline: "advisor",
    snapshot: buildRuntimeCommitSnapshot({
      runtimeEpoch: 3,
      contextState: manager.getState(),
    }),
  });
  assert.equal(
    authorizeRuntimeCommit({
      token,
      current: buildRuntimeCommitSnapshot({
        runtimeEpoch: 3,
        contextState: manager.getState(),
      }),
      currentOperationId: "advisor-a",
    }).authorized,
    true
  );
  const parent = buildCommittedTaskBoundaryParent({
    candidate,
    logicalQuestionUnit: unit,
    source: "voice",
  });
  assert.ok(parent);
  manager.setActiveInterviewTask(parent);
  const rebased = rebaseRuntimeCommitToken({
    token,
    snapshot: buildRuntimeCommitSnapshot({
      runtimeEpoch: 3,
      contextState: manager.getState(),
    }),
  });
  const committed = commitTaskBoundaryCandidate(candidate, parent.id);

  assert.equal(rebased.parentExpectation.kind, "exact");
  assert.equal(manager.getState().activeInterviewTask?.id, parent.id);
  assert.equal(taskBoundarySurvivesAdvisorOutcome(committed, "cancelled"), true);
});

test("a precommitted parent re-roots prompt transcript at its first source turn", () => {
  const manager = new MeetingContextManager();
  manager.addTranscriptTurn({
    id: "turn-old",
    speaker: "them",
    source: "system-audio",
    text: "Implement a queue using two stacks",
    startedAt: 1,
    endedAt: 2,
    isFinal: true,
  });
  manager.addTranscriptTurn({
    id: "turn-a",
    speaker: "them",
    source: "system-audio",
    text: "Design a food",
    startedAt: 10,
    endedAt: 20,
    isFinal: true,
  });
  manager.addTranscriptTurn({
    id: "turn-b",
    speaker: "them",
    source: "system-audio",
    text: "delivery service",
    startedAt: 30,
    endedAt: 40,
    isFinal: true,
  });
  const unit = logicalQuestion();
  const candidate = createTaskBoundaryCandidate({
    logicalQuestionUnit: unit,
    proposedQuestionType: "general-system-design",
    proposedRelation: "new-parent",
    authoritySource: "accepted-transcript",
    confidence: 0.9,
    questionComplete: true,
    mutationAuthorized: true,
    commitParent: true,
  });
  assert.ok(candidate);
  const parent = buildCommittedTaskBoundaryParent({
    candidate,
    logicalQuestionUnit: unit,
    source: "voice",
  });
  assert.ok(parent);
  manager.setActiveInterviewTask(parent);

  const prompt = manager.buildAdvisorPromptContext();
  assert.doesNotMatch(prompt.transcript, /queue using two stacks/);
  assert.match(prompt.transcript, /Design a food/);
  assert.match(prompt.transcript, /delivery service/);
});

test("abstains from precommitting follow-ups and non-parent task types", () => {
  const followup = createTaskBoundaryCandidate({
    logicalQuestionUnit: logicalQuestion(),
    proposedQuestionType: "general-system-design",
    proposedRelation: "followup-parent",
    authoritySource: "accepted-transcript",
    confidence: 0.9,
    questionComplete: true,
    mutationAuthorized: true,
    commitParent: true,
  });
  const fieldKnowledge = createTaskBoundaryCandidate({
    logicalQuestionUnit: logicalQuestion("What is RAG?"),
    proposedQuestionType: "field-knowledge",
    proposedRelation: "new-parent",
    authoritySource: "accepted-transcript",
    confidence: 0.9,
    questionComplete: true,
    mutationAuthorized: true,
    commitParent: true,
  });

  assert.equal(followup?.mutationDisposition, "abstained-non-boundary-relation");
  assert.equal(fieldKnowledge?.mutationDisposition, "abstained-non-parent-type");
});
