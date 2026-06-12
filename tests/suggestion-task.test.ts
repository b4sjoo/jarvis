import assert from "node:assert/strict";
import test from "node:test";
import {
  areSuggestionsForSameParentTask,
  buildSuggestionTaskMetadata,
} from "../src/lib/meeting/suggestion-task.js";
import type { ActiveMeetingTask, AdvisorSuggestion } from "../src/lib/meeting";

test("builds suggestion metadata from an active meeting task", () => {
  const task = makeActiveMeetingTask();
  const metadata = buildSuggestionTaskMetadata(task);

  assert.deepEqual(metadata, {
    taskId: "parent_1",
    parentTaskId: "parent_1",
    childTaskId: "child_1",
    taskSource: "mixed",
    questionType: "ai-ml-system-design",
  });
});

test("matches suggestions only within the same parent task when scoped", () => {
  const current = makeSuggestion({ parentTaskId: "parent_1" });
  const previousSame = makeSuggestion({ parentTaskId: "parent_1" });
  const previousDifferent = makeSuggestion({ parentTaskId: "parent_2" });
  const unscoped = makeSuggestion({});

  assert.equal(areSuggestionsForSameParentTask(previousSame, current), true);
  assert.equal(areSuggestionsForSameParentTask(previousDifferent, current), false);
  assert.equal(areSuggestionsForSameParentTask(unscoped, current), false);
  assert.equal(areSuggestionsForSameParentTask(makeSuggestion({}), unscoped), true);
});

function makeActiveMeetingTask(): ActiveMeetingTask {
  const now = 1_779_000_000_000;
  return {
    id: "parent_1",
    source: "mixed",
    parent: {
      id: "parent_1",
      questionType: "ai-ml-system-design",
      topic: "RAG trip planning system",
      playbookPhase: "design_framing",
      phaseProgress: { objective_metrics: true },
      supportedFactAnchors: ["Agentic Memory"],
      createdAt: now,
      updatedAt: now,
    },
    child: {
      id: "child_1",
      createdAt: now,
      updatedAt: now,
      questionType: "field-knowledge",
      relation: "child-probe",
      intent: "concept-probe",
      question: "What is RAG?",
      basedOnTurnIds: ["turn_1"],
      basedOnObservationIds: [],
    },
  };
}

function makeSuggestion(
  patch: Partial<Pick<AdvisorSuggestion, "parentTaskId" | "taskId">>
): AdvisorSuggestion {
  return {
    id: "suggestion_1",
    kind: "answer",
    content: "Answer",
    createdAt: 1_779_000_000_000,
    basedOnTurnIds: [],
    basedOnObservationIds: [],
    confidence: "medium",
    ...patch,
  };
}
