import assert from "node:assert/strict";
import test from "node:test";
import {
  buildActiveMeetingTask,
  collectActiveMeetingTaskIdentityIds,
  formatActiveMeetingTaskForPrompt,
  getActiveMeetingTaskTraceMetadata,
  resolveActiveMeetingTaskIdentity,
} from "../src/lib/meeting/active-meeting-task.js";
import type {
  ActiveInterviewParent,
  ActiveScreenTask,
  ScreenObservation,
} from "../src/lib/meeting/types.js";

const now = 1_779_000_000_000;

test("builds a screen-only active meeting task from legacy screen state", () => {
  const screenTask = makeScreenTask();
  const observation = makeObservation();
  const task = buildActiveMeetingTask({
    activeScreenTask: screenTask,
    latestObservation: observation,
  });

  assert.equal(task?.id, "screen_task_1");
  assert.equal(task?.source, "screen");
  assert.equal(task?.parent.id, "screen_task_1");
  assert.equal(task?.parent.questionType, "coding");
  assert.equal(task?.screen?.activeScreenTaskId, "screen_task_1");
  assert.equal(task?.screen?.captureTarget?.appName, "Cursor");
  assert.equal(task?.screen?.askFrame, "direct-answer");
  assert.equal(task?.screen?.topicDomain, "backend");
  assert.equal(task?.child, undefined);
});

test("does not treat playbook labels as supported fact anchors", () => {
  const task = buildActiveMeetingTask({
    activeScreenTask: makeScreenTask({
      kind: "project-deep-dive",
      classifier: {
        questionType: "project-deep-dive",
        askFrame: "past-project",
        topicDomain: "agentic-ai",
        confidence: 0.9,
      },
      playbook: {
        id: "project_deep_dive",
        label: "Project Deep Dive",
        phase: "project_narrative",
        questionType: "project-deep-dive",
        confidence: 0.9,
        reason: "test",
        memoryPolicy: { id: "project-deep-dive" },
        firstMove: "summarize the project",
        clarifyingStrategy: "ask only if needed",
        outputContract: "project narrative",
        followUpPolicy: "continue the parent task",
      },
    }),
  });

  assert.deepEqual(task?.parent.supportedFactAnchors, []);
});

test("builds a voice-only active meeting task from active interview parent", () => {
  const interviewTask = makeInterviewTask({ source: "voice" });
  const task = buildActiveMeetingTask({ activeInterviewTask: interviewTask });

  assert.equal(task?.id, "parent_1");
  assert.equal(task?.source, "voice");
  assert.equal(task?.parent.questionType, "behavioral");
  assert.equal(task?.parent.topic, "cost saving story");
  assert.equal(task?.screen, undefined);
});

test("uses interview parent as stable id for mixed screen and voice state", () => {
  const screenTask = makeScreenTask({ basedOnTurnIds: ["turn_1"] });
  const interviewTask = makeInterviewTask({
    source: "screen",
    stableKind: "coding",
    startObservationId: "obs_1",
  });
  const task = buildActiveMeetingTask({
    activeScreenTask: screenTask,
    activeInterviewTask: interviewTask,
    latestObservation: makeObservation(),
  });

  assert.equal(task?.id, "parent_1");
  assert.equal(task?.source, "mixed");
  assert.equal(task?.parent.id, "parent_1");
  assert.equal(task?.screen?.activeScreenTaskId, "screen_task_1");
});

test("keeps child probes under the parent without changing parent question type", () => {
  const interviewTask = makeInterviewTask({
    stableKind: "ai-ml-system-design",
    child: {
      id: "child_1",
      createdAt: now,
      updatedAt: now + 1,
      questionType: "field-knowledge",
      relation: "child-probe",
      intent: "concept-probe",
      question: "What is RAG?",
      compactSummary: "RAG concept probe",
      basedOnTurnIds: ["turn_2"],
      basedOnObservationIds: ["obs_1"],
    },
  });
  const task = buildActiveMeetingTask({ activeInterviewTask: interviewTask });

  assert.equal(task?.parent.questionType, "ai-ml-system-design");
  assert.equal(task?.child?.questionType, "field-knowledge");
  assert.equal(task?.child?.intent, "concept-probe");
});

test("exposes trace metadata and prompt text for evaluation corpus linking", () => {
  const task = buildActiveMeetingTask({
    activeScreenTask: makeScreenTask(),
    activeInterviewTask: makeInterviewTask({
      stableKind: "coding",
      startObservationId: "obs_1",
    }),
    latestObservation: makeObservation(),
  });

  const metadata = getActiveMeetingTaskTraceMetadata(task);
  assert.equal(metadata.activeMeetingTaskId, "parent_1");
  assert.equal(metadata.activeMeetingParentQuestionType, "coding");
  assert.equal(metadata.activeMeetingScreenTaskId, "screen_task_1");
  assert.equal(metadata.activeMeetingScreenAskFrame, "direct-answer");
  assert.match(formatActiveMeetingTaskForPrompt(task), /<|Task id: parent_1/);
  assert.match(formatActiveMeetingTaskForPrompt(task), /Ask frame: direct-answer/);
});

test("surfaces screen/interview divergence instead of silently hiding it", () => {
  const task = buildActiveMeetingTask({
    activeScreenTask: makeScreenTask({ kind: "coding" }),
    activeInterviewTask: makeInterviewTask({
      stableKind: "behavioral",
      startObservationId: "obs_1",
    }),
  });

  assert.equal(task?.divergence?.reason, "question-type-mismatch");
  assert.equal(task?.divergence?.screenQuestionType, "coding");
  assert.equal(task?.divergence?.parentQuestionType, "behavioral");
});

test("resolves active meeting task identity from canonical metadata first", () => {
  const task = buildActiveMeetingTask({
    activeScreenTask: makeScreenTask(),
    activeInterviewTask: makeInterviewTask({
      stableKind: "coding",
      startObservationId: "obs_1",
    }),
  });

  const identity = resolveActiveMeetingTaskIdentity({
    activeMeetingTask: task,
    metadata: {
      activeMeetingTaskId: "canonical_task",
      activeMeetingParentId: "canonical_parent",
      activeMeetingChildId: "canonical_child",
      activeMeetingTaskSource: "mixed",
      activeInterviewParentId: "legacy_parent",
      activeScreenTaskId: "legacy_screen",
    },
  });

  assert.deepEqual(identity, {
    taskId: "canonical_task",
    parentTaskId: "canonical_parent",
    childTaskId: "canonical_child",
    taskSource: "mixed",
  });
});

test("resolves legacy task identity when canonical metadata is absent", () => {
  const identity = resolveActiveMeetingTaskIdentity({
    metadata: {
      activeInterviewParentId: "legacy_parent",
      activeInterviewChildId: "legacy_child",
      activeScreenTaskId: "legacy_screen",
    },
  });

  assert.deepEqual(identity, {
    taskId: "legacy_parent",
    parentTaskId: "legacy_parent",
    childTaskId: "legacy_child",
    taskSource: undefined,
  });
  assert.deepEqual(
    collectActiveMeetingTaskIdentityIds({
      metadata: {
        activeInterviewParentId: "legacy_parent",
        activeInterviewChildId: "legacy_child",
        activeScreenTaskId: "legacy_screen",
      },
    }),
    ["legacy_parent", "legacy_child", "legacy_screen"]
  );
});

test("falls back to active meeting task only when trace metadata has no identity", () => {
  const task = buildActiveMeetingTask({
    activeInterviewTask: makeInterviewTask({
      source: "voice",
      child: {
        id: "child_1",
        createdAt: now,
        updatedAt: now + 1,
        questionType: "field-knowledge",
        relation: "child-probe",
        intent: "concept-probe",
        question: "What is RAG?",
        basedOnTurnIds: ["turn_1"],
        basedOnObservationIds: [],
      },
    }),
  });

  const identity = resolveActiveMeetingTaskIdentity({
    activeMeetingTask: task,
  });

  assert.deepEqual(identity, {
    taskId: "parent_1",
    parentTaskId: "parent_1",
    childTaskId: "child_1",
    taskSource: "voice",
  });
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

function makeObservation(): ScreenObservation {
  return {
    id: "obs_1",
    capturedAt: now,
    source: "hotkey",
    changed: true,
    captureTarget: {
      targetType: "active-window",
      captureMethod: "active-window-monitor-crop",
      appName: "Cursor",
      title: "interview.md",
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
    },
  };
}
