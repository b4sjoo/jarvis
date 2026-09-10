import type { MeetingAssistantState } from "../src/lib/meeting/meeting-context-contracts.js";
import type { ActiveMeetingTask } from "../src/lib/meeting/meeting-task-contracts.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  areSuggestionsForSameParentTask,
  buildSuggestionTaskMetadata,
  restoreSuggestionProjectionAfterFailedManualCorrection,
  stageSuggestionProjectionForManualCorrection,
} from "../src/lib/meeting/suggestion-task.js";
import type { AdvisorSuggestion } from "../src/lib/meeting/types.js";


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
  const current = makeSuggestion({
    parentTaskId: "parent_1",
    questionType: "coding",
  });
  const previousSame = makeSuggestion({
    parentTaskId: "parent_1",
    questionType: "coding",
  });
  const previousDifferent = makeSuggestion({
    parentTaskId: "parent_2",
    questionType: "coding",
  });
  const previousRetyped = makeSuggestion({
    parentTaskId: "parent_1",
    questionType: "behavioral",
  });
  const previousMissingType = makeSuggestion({ parentTaskId: "parent_1" });
  const unscoped = makeSuggestion({});

  assert.equal(areSuggestionsForSameParentTask(previousSame, current), true);
  assert.equal(areSuggestionsForSameParentTask(previousDifferent, current), false);
  assert.equal(areSuggestionsForSameParentTask(previousRetyped, current), false);
  assert.equal(areSuggestionsForSameParentTask(previousMissingType, current), false);
  assert.equal(areSuggestionsForSameParentTask(unscoped, current), false);
  assert.equal(areSuggestionsForSameParentTask(makeSuggestion({}), unscoped), true);
});

test("stages the visible answer as previous reliable content during correction", () => {
  const latestSuggestion: AdvisorSuggestion = {
    id: "suggestion_1",
    sourceTraceId: "trace_1",
    kind: "answer",
    content: "The last reliable answer",
    createdAt: 1,
    basedOnTurnIds: [],
    basedOnObservationIds: [],
    confidence: "medium",
  };
  const staged = stageSuggestionProjectionForManualCorrection({
    latestSuggestion,
    latestReliableSuggestion: null,
  } as MeetingAssistantState);

  assert.equal(staged.latestSuggestion, null);
  assert.equal(staged.latestReliableSuggestion, latestSuggestion);
  assert.equal(staged.partialSuggestion, "");
});

test("does not promote a clarifying question to reliable answer history", () => {
  const previousReliable: AdvisorSuggestion = {
    id: "suggestion_0",
    sourceTraceId: "trace_0",
    kind: "answer",
    content: "Previous answer",
    createdAt: 1,
    basedOnTurnIds: [],
    basedOnObservationIds: [],
    confidence: "medium",
  };
  const staged = stageSuggestionProjectionForManualCorrection({
    latestSuggestion: {
      ...previousReliable,
      id: "clarifying_1",
      kind: "clarifying-question",
      content: "Which option?",
    },
    latestReliableSuggestion: previousReliable,
  } as MeetingAssistantState);

  assert.equal(staged.latestReliableSuggestion, previousReliable);
});

test("restores the previous stable answer after correction regeneration has no commit", () => {
  const previousReliable = makeSuggestion({
    id: "suggestion_stable",
    content: "A reliable answer that must remain visible.",
  });
  const restored = restoreSuggestionProjectionAfterFailedManualCorrection(
    {
      latestSuggestion: null,
      latestReliableSuggestion: previousReliable,
      partialSuggestion: "-",
    } as MeetingAssistantState,
    previousReliable
  );

  assert.equal(restored.latestSuggestion, previousReliable);
  assert.equal(restored.latestReliableSuggestion, null);
  assert.equal(restored.partialSuggestion, "");
});

function makeActiveMeetingTask(): ActiveMeetingTask {
  const now = 1_779_000_000_000;
  return {
    id: "parent_1",
    runtimeRevision: 1,
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
  patch: Partial<
    Pick<
      AdvisorSuggestion,
      "id" | "content" | "parentTaskId" | "taskId" | "questionType"
    >
  >
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
