import assert from "node:assert/strict";
import test from "node:test";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import type {
  ActiveInterviewParent,
  ActiveScreenTask,
} from "../src/lib/meeting/types.js";

const now = Date.now();

test("context manager exposes canonical active meeting task for screen state", () => {
  const manager = new MeetingContextManager();

  manager.setActiveScreenTask(makeScreenTask());

  const state = manager.getState();
  assert.equal(state.activeMeetingTask?.id, "screen_task_1");
  assert.equal(state.activeMeetingTask?.source, "screen");
  assert.equal(state.activeMeetingTask?.parent.questionType, "coding");
  assert.equal(state.activeMeetingTask?.screen?.activeScreenTaskId, "screen_task_1");
});

test("context manager exposes parent task as canonical id for mixed state", () => {
  const manager = new MeetingContextManager();

  manager.setActiveMeetingTaskState({
    activeScreenTask: makeScreenTask({ basedOnTurnIds: ["turn_1"] }),
    activeInterviewTask: makeInterviewTask({
      source: "screen",
      stableKind: "coding",
      startObservationId: "obs_1",
    }),
  });

  const state = manager.getState();
  assert.equal(state.activeMeetingTask?.id, "parent_1");
  assert.equal(state.activeMeetingTask?.source, "mixed");
  assert.equal(state.activeMeetingTask?.parent.id, "parent_1");
  assert.equal(state.activeMeetingTask?.screen?.activeScreenTaskId, "screen_task_1");
});

test("context manager clears canonical task when legacy task state is cleared", () => {
  const manager = new MeetingContextManager();

  manager.setActiveMeetingTaskState({
    activeScreenTask: makeScreenTask(),
    activeInterviewTask: makeInterviewTask(),
  });
  assert.ok(manager.getState().activeMeetingTask);

  manager.clearActiveMeetingTask();
  assert.equal(manager.getState().activeMeetingTask, undefined);
});

test("scopes advisor transcript to a re-rooted parent boundary", () => {
  const manager = new MeetingContextManager();
  manager.addTranscriptTurn(makeTurn("turn_old", "Estimate ride share GPS QPS"));
  manager.addTranscriptTurn(
    makeTurn(
      "turn_new",
      "Design a self-evolving travel recommendation agent"
    )
  );
  manager.addTranscriptTurn(
    makeTurn("turn_constraint", "Use offline and online evaluation")
  );
  manager.setActiveMeetingTaskState({
    activeInterviewTask: makeInterviewTask({
      id: "parent_travel_agent",
      stableKind: "ai-ml-system-design",
      topic: "Design a self-evolving travel recommendation agent",
      startTurnId: "turn_new",
      promptTranscriptStartTurnId: "turn_new",
    }),
  });

  const prompt = manager.buildAdvisorPromptContext();
  assert.doesNotMatch(prompt.transcript, /ride share GPS QPS/);
  assert.match(prompt.transcript, /self-evolving travel recommendation agent/);
  assert.match(prompt.transcript, /offline and online evaluation/);
});

function makeScreenTask(
  overrides: Partial<ActiveScreenTask> = {}
): ActiveScreenTask {
  return {
    id: "screen_task_1",
    observationId: "obs_1",
    createdAt: now,
    updatedAt: now + 1,
    expiresAt: now + 30_000,
    question: "Solve two sum",
    kind: "coding",
    language: "python",
    classifier: {
      questionType: "coding",
      askFrame: "direct-answer",
      topicDomain: "backend",
      confidence: 0.9,
    },
    content: "Question: Two Sum\nAnswer: Use a hash map.",
    basedOnTurnIds: [],
    basedOnObservationId: "obs_1",
    ...overrides,
  };
}

function makeInterviewTask(
  overrides: Partial<ActiveInterviewParent> = {}
): ActiveInterviewParent {
  return {
    id: "parent_1",
    source: "voice",
    stableKind: "behavioral",
    topic: "cost saving story",
    playbookPhase: "story_selection",
    phaseProgress: {},
    supportedFactAnchors: ["AOS cleanup"],
    latestUsefulAnswer: "Use AOS cleanup story.",
    previousUsefulAnswer: "Use model interface story.",
    createdAt: now,
    updatedAt: now + 1,
    expiresAt: now + 30_000,
    revisions: 1,
    ...overrides,
  };
}

function makeTurn(id: string, text: string) {
  return {
    id,
    speaker: "them" as const,
    text,
    startedAt: now,
    endedAt: now + 1,
    isFinal: true,
    source: "system-audio" as const,
  };
}
