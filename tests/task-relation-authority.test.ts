import assert from "node:assert/strict";
import test from "node:test";
import {
  applyResponseOnlyTaskScopeToPromptContext,
  createResponseOnlyTaskScope,
} from "../src/lib/meeting/response-only-task-scope.js";
import { decideCrossTypeTaskRelationAuthority } from "../src/lib/meeting/task-relation-authority.js";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import type { AdvisorPromptContext } from "../src/lib/meeting/types.js";

test("independent coding after system design is response-only without parent binding", () => {
  const decision = decideCrossTypeTaskRelationAuthority({
    activeQuestionType: "ai-ml-system-design",
    candidateQuestionType: "coding",
    currentText:
      "Write a Python function that recursively finds all text files.",
  });

  assert.equal(decision?.relation, "unknown");
  assert.equal(decision?.proposedRelation, "child-probe");
  assert.equal(decision?.disposition, "response-only");
  assert.equal(decision?.relationEvidenceAuthorized, false);
});

test("a locally bound coding request remains an authorized child", () => {
  const decision = decideCrossTypeTaskRelationAuthority({
    activeQuestionType: "ai-ml-system-design",
    candidateQuestionType: "coding",
    currentText:
      "For this retrieval pipeline, implement the reranking loss.",
  });

  assert.equal(decision?.relation, "child-probe");
  assert.equal(decision?.disposition, "authorized");
  assert.equal(decision?.relationEvidenceAuthorized, true);
  assert.deepEqual(decision?.evidenceSpans, [
    "For this retrieval pipeline",
  ]);
});

test("an explicit task switch authorizes a new parent relation", () => {
  const decision = decideCrossTypeTaskRelationAuthority({
    activeQuestionType: "general-system-design",
    candidateQuestionType: "coding",
    currentText:
      "Now let's move to a separate coding question.",
    explicitTaskSwitch: true,
  });

  assert.equal(decision?.relation, "new-parent");
  assert.equal(decision?.disposition, "authorized");
  assert.equal(decision?.relationEvidenceAuthorized, true);
});

test("an explicit same-type task switch authorizes a new parent", () => {
  const decision = decideCrossTypeTaskRelationAuthority({
    activeQuestionType: "coding",
    candidateQuestionType: "coding",
    currentText: "Next, let's move to a separate coding problem.",
    explicitTaskSwitch: true,
  });

  assert.equal(decision?.relation, "new-parent");
  assert.equal(decision?.disposition, "authorized");
  assert.equal(decision?.relationEvidenceAuthorized, true);
});

test("an explicit switch to a non-parent type uses response-only scope", () => {
  const decision = decideCrossTypeTaskRelationAuthority({
    activeQuestionType: "general-system-design",
    candidateQuestionType: "field-knowledge",
    currentText: "Next, let's move to a separate question about HNSW.",
    explicitTaskSwitch: true,
  });

  assert.equal(decision?.relation, "unknown");
  assert.equal(decision?.proposedRelation, "new-parent");
  assert.equal(decision?.disposition, "response-only");
  assert.equal(decision?.relationEvidenceAuthorized, true);
});

test("cross-type parent classification alone cannot create a new parent", () => {
  const decision = decideCrossTypeTaskRelationAuthority({
    activeQuestionType: "general-system-design",
    candidateQuestionType: "ai-ml-system-design",
    currentText: "Design a self-evolving recommendation agent.",
  });

  assert.equal(decision?.relation, "unknown");
  assert.equal(decision?.proposedRelation, "new-parent");
  assert.equal(decision?.disposition, "response-only");
  assert.equal(decision?.relationEvidenceAuthorized, false);
});

test("response-only prompt scope excludes durable parent continuity", () => {
  const activeMeetingTask = task();
  const scope = createResponseOnlyTaskScope({
    logicalQuestionUnitId: "question-new",
    revision: 2,
    sourceQuestion: "Explain HNSW.",
    sourceTurnIds: ["turn-new"],
    inferredType: "field-knowledge",
    relationDisposition: "ambiguous",
    preservedParent: activeMeetingTask,
    now: 100,
  });
  const context: AdvisorPromptContext = {
    transcript: "Them: Design a vector database.\nThem: Explain HNSW.",
    advisorPromptSourceTurnIds: ["turn-parent", "turn-new"],
    screenContext: "parent whiteboard",
    interviewSessionBrief: {
      targetCompany: "Example",
      companyLocked: true,
      interviewTypes: ["mixed"],
      focusAreas: "Use the vector database project",
      notes: "Inject the previous architecture",
    },
    activeMeetingTask,
    activeInterviewTask: {
      id: activeMeetingTask.parent.id,
      source: "voice",
      stableKind: "ai-ml-system-design",
      topic: activeMeetingTask.parent.topic,
      playbookPhase: "design_framing",
      phaseProgress: {},
      supportedFactAnchors: ["project-a"],
      createdAt: 1,
      updatedAt: 2,
      revisions: 3,
    },
    rollingSummary: "parent summary",
    userProfileContext: "private parent facts",
    glossaryText: "HNSW",
    confirmedMeFacts: [{ id: "fact-a", text: "parent fact" }],
  };

  const scoped = applyResponseOnlyTaskScopeToPromptContext(
    context,
    scope
  );

  assert.equal(scoped.transcript, "Them: Explain HNSW.");
  assert.deepEqual(scoped.advisorPromptSourceTurnIds, ["turn-new"]);
  assert.equal(scoped.activeMeetingTask, undefined);
  assert.equal(scoped.activeInterviewTask, undefined);
  assert.equal(scoped.screenContext, "");
  assert.equal(scoped.rollingSummary, "");
  assert.equal(scoped.userProfileContext, "");
  assert.equal(scoped.interviewSessionBrief?.targetCompany, "Example");
  assert.equal(scoped.interviewSessionBrief?.focusAreas, "");
  assert.equal(scoped.interviewSessionBrief?.notes, "");
  assert.equal(scoped.confirmedMeFacts, undefined);
  assert.equal(scope.preservedParentId, activeMeetingTask.parent.id);
});

function task(): ActiveMeetingTask {
  return {
    id: "task-parent",
    source: "voice",
    parent: {
      id: "task-parent",
      questionType: "ai-ml-system-design",
      topic: "Design a vector database",
      playbookPhase: "design_framing",
      phaseProgress: {},
      supportedFactAnchors: ["project-a"],
      createdAt: 1,
      updatedAt: 2,
      revisions: 3,
    },
  };
}
