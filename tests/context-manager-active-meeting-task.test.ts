import assert from "node:assert/strict";
import test from "node:test";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import { buildSpeechBiasContext } from "../src/lib/meeting/speech-bias.js";
import { projectBoundedGeneratedContinuityForTask } from "../src/lib/meeting/bounded-recent-history.js";
import type {
  ActiveInterviewParent,
  ActiveScreenTask,
  ScreenObservation,
} from "../src/lib/meeting/types.js";
import {
  clearTestTaskRuntime,
  setTestScreenAttachment,
  setTestTaskRuntime,
} from "./helpers/meeting-task-runtime.js";

const now = Date.now();

test("J1: expired state and prompt reads are pure until the explicit execution boundary", (t) => {
  let clock = now;
  t.mock.method(Date, "now", () => clock);
  const manager = new MeetingContextManager();
  setTestTaskRuntime(manager, {
    screenAttachment: makeScreenTask(),
    parent: makeInterviewTask({ source: "screen" }),
  }, {
    screen: { ownerId: "screen_task_1", deadline: now + 100 },
    parent: { ownerId: "parent_1", deadline: now + 100 },
  });
  const original = manager.getTaskRuntimeState();
  const originalDeadlines = manager.getTaskDeadlineControl();
  assert.equal("expiresAt" in original.parent!, false);
  assert.equal("expiresAt" in original.screenAttachment!, false);
  clock = now + 101;
  for (let count = 0; count < 5; count += 1) {
    manager.getState();
    manager.buildAdvisorPromptContext();
    assert.deepEqual(manager.getTaskRuntimeState(), original);
    assert.deepEqual(manager.getTaskDeadlineControl(), originalDeadlines);
  }
  assert.equal(manager.clearExpiredActiveMeetingTask(), true);
  const executionSnapshot = manager.getState();
  assert.equal(executionSnapshot.taskRuntime.revision, original.revision + 1);
  assert.equal(executionSnapshot.activeMeetingTask, undefined);
  assert.equal(executionSnapshot.taskRuntime.lastMutation?.kind, "expire");
  assert.equal(manager.clearExpiredActiveMeetingTask(), false);
  assert.equal(manager.getTaskRuntimeState().revision, original.revision + 1);
  assert.equal(manager.getTaskDeadlineControl().parent, undefined);
  assert.equal(manager.getTaskDeadlineControl().screen, undefined);
});

test("O1: output deadline updates preserve every canonical task field and revision", () => {
  const manager = new MeetingContextManager();
  setTestTaskRuntime(manager, {
    parent: makeInterviewTask(),
    screenAttachment: makeScreenTask(),
  }, {
    parent: { ownerId: "parent_1", deadline: now + 600_000 },
    screen: { ownerId: "screen_task_1", deadline: now + 600_000 },
  });
  const original = manager.getTaskRuntimeState();
  const update = manager.prepareTaskDeadlineUpdate({
    expectedSessionId: manager.getState().sessionId,
    deadlineDelta: { parent: { ownerId: "parent_1", deadline: now + 660_000 } },
  });
  assert.equal(manager.getTaskDeadlineControl().parent?.deadline, now + 600_000);
  assert.deepEqual(manager.getTaskRuntimeState(), original);
  assert.equal(manager.installPreparedTaskDeadlineUpdate(update), true);
  assert.equal(manager.getTaskDeadlineControl().parent?.deadline, now + 660_000);
  assert.equal(manager.getTaskDeadlineControl().screen?.deadline, now + 600_000);
  assert.deepEqual(manager.getTaskRuntimeState(), original);
  assert.equal("expiresAt" in manager.getState().activeMeetingTask!.parent, false);
  assert.equal("latestUsefulAnswer" in original.parent!, false);
  assert.equal("previousUsefulAnswer" in original.parent!, false);
  assert.equal(manager.rollbackPreparedTaskDeadlineUpdate(update), true);
  assert.equal(manager.getTaskDeadlineControl().parent?.deadline, now + 600_000);
  assert.deepEqual(manager.getTaskRuntimeState(), original);
});

test("context manager exposes canonical active meeting task for screen state", () => {
  const manager = new MeetingContextManager();

  setTestScreenAttachment(manager, makeScreenTask());

  const state = manager.getState();
  assert.equal(
    state.activeMeetingTask?.runtimeRevision,
    state.taskRuntime.revision
  );
  assert.equal(state.activeMeetingTask?.id, "screen_task_1");
  assert.equal(state.activeMeetingTask?.source, "screen");
  assert.equal(state.activeMeetingTask?.parent.questionType, "coding");
  assert.equal(state.activeMeetingTask?.screen?.activeScreenTaskId, "screen_task_1");
});

test("context manager exposes parent task as canonical id for mixed state", () => {
  const manager = new MeetingContextManager();

  setTestTaskRuntime(manager, {
    screenAttachment: makeScreenTask({ basedOnTurnIds: ["turn_1"] }),
    parent: makeInterviewTask({
      source: "screen",
      stableKind: "coding",
      startObservationId: "obs_1",
    }),
  });

  const state = manager.getState();
  assert.equal(
    state.activeMeetingTask?.runtimeRevision,
    state.taskRuntime.revision
  );
  assert.equal(state.activeMeetingTask?.id, "parent_1");
  assert.equal(state.activeMeetingTask?.source, "mixed");
  assert.equal(state.activeMeetingTask?.parent.id, "parent_1");
  assert.equal(state.activeMeetingTask?.screen?.activeScreenTaskId, "screen_task_1");
});

test("projects the latest authorized screen from the active branch", () => {
  const manager = new MeetingContextManager();
  manager.addScreenObservation(
    makeObservation("parent-screen", "PARENT_SCREEN_TEXT")
  );
  manager.addScreenObservation(
    makeObservation("child-screen", "CHILD_SCREEN_TEXT")
  );
  manager.addScreenObservation(
    makeObservation("unrelated-screen", "UNRELATED_SCREEN_TEXT")
  );
  const resumedManager = new MeetingContextManager();
  resumedManager.addScreenObservation(
    makeObservation("parent-screen", "PARENT_SCREEN_TEXT")
  );
  resumedManager.addScreenObservation(
    makeObservation("child-screen", "CHILD_SCREEN_TEXT")
  );
  setTestTaskRuntime(manager, {
    parent: makeInterviewTask({
      source: "screen",
      stableKind: "ai-ml-system-design",
      startObservationId: "parent-screen",
      latestScreenObservationId: "parent-screen",
      child: {
        id: "child-coding",
        createdAt: now,
        updatedAt: now + 1,
        questionType: "coding",
        relation: "child-probe",
        intent: "implementation-probe",
        question: "Implement the retrieval merge.",
        basedOnTurnIds: [],
        basedOnObservationIds: ["child-screen"],
        latestScreenObservationId: "child-screen",
      },
    }),
  });

  const childState = manager.getState();
  assert.equal(
    childState.activeMeetingTask?.screen?.observationId,
    "child-screen"
  );
  assert.equal(
    childState.activeMeetingTask?.screen?.question,
    "Implement the retrieval merge."
  );
  const childPrompt = manager.buildAdvisorPromptContext();
  assert.match(childPrompt.screenContext, /CHILD_SCREEN_TEXT/);
  assert.doesNotMatch(childPrompt.screenContext, /PARENT_SCREEN_TEXT/);
  assert.doesNotMatch(childPrompt.screenContext, /UNRELATED_SCREEN_TEXT/);

  setTestTaskRuntime(resumedManager, {
    parent: makeInterviewTask({
      source: "screen",
      stableKind: "ai-ml-system-design",
      startObservationId: "parent-screen",
      latestScreenObservationId: "parent-screen",
    }),
  });
  const resumedParentState = resumedManager.getState();
  assert.equal(
    resumedParentState.activeMeetingTask?.screen?.observationId,
    "parent-screen"
  );

  const inheritedManager = new MeetingContextManager();
  inheritedManager.addScreenObservation(
    makeObservation("parent-screen", "PARENT_SCREEN_TEXT")
  );
  setTestTaskRuntime(inheritedManager, {
    parent: makeInterviewTask({
      source: "screen",
      stableKind: "ai-ml-system-design",
      topic: "Design the RAG architecture.",
      latestScreenObservationId: "parent-screen",
      child: {
        id: "child-knowledge",
        createdAt: now,
        updatedAt: now + 1,
        questionType: "field-knowledge",
        relation: "child-probe",
        intent: "concept-probe",
        question: "Explain HNSW.",
        basedOnTurnIds: ["turn-hnsw"],
        basedOnObservationIds: [],
      },
    }),
  });
  const inheritedState = inheritedManager.getState();
  assert.equal(
    inheritedState.activeMeetingTask?.screen?.observationId,
    "parent-screen"
  );
  assert.equal(
    inheritedState.activeMeetingTask?.screen?.question,
    "Design the RAG architecture."
  );
  assert.notEqual(
    inheritedState.activeMeetingTask?.screen?.question,
    inheritedState.activeMeetingTask?.child?.question
  );
});

test("context manager clears the canonical task runtime", () => {
  const manager = new MeetingContextManager();

  setTestTaskRuntime(manager, {
    screenAttachment: makeScreenTask(),
    parent: makeInterviewTask(),
  });
  assert.ok(manager.getState().activeMeetingTask);

  clearTestTaskRuntime(manager);
  assert.equal(manager.getState().activeMeetingTask, undefined);
});

test("prepares task runtime transitions with reducer parity and bounded rollback", () => {
  const direct = new MeetingContextManager();
  const prepared = new MeetingContextManager();
  const parent = makeInterviewTask();
  const deadlines = { parent: { ownerId: parent.id, deadline: now + 30_000 } };
  setTestTaskRuntime(direct, { parent }, deadlines);
  setTestTaskRuntime(prepared, { parent }, deadlines);
  const before = prepared.getTaskRuntimeState();
  const beforeDeadlines = prepared.getTaskDeadlineControl();
  const input = {
    id: "source-context-transition",
    transition: "update-parent-context" as const,
    reason: "source-context-atomic-commit",
    expectedRevision: before.revision,
    parent: {
      ...parent,
      supportedFactAnchors: [...parent.supportedFactAnchors, "source-confirmed fact"],
      revisions: parent.revisions + 1,
    },
    deadlineDelta: { parent: { ownerId: parent.id, deadline: now + 60_000 } },
    appliedAt: now + 20,
  };

  const directResult = direct.commitTaskRuntimeTransition(input);
  const preparedTransition = prepared.prepareTaskRuntimeTransition(input);
  assert.deepEqual(prepared.getTaskRuntimeState(), before);
  assert.deepEqual(prepared.getTaskDeadlineControl(), beforeDeadlines);
  assert.deepEqual(preparedTransition.result, directResult);

  const preparedResult =
    prepared.commitPreparedTaskRuntimeTransition(preparedTransition);
  assert.deepEqual(preparedResult, directResult);
  assert.deepEqual(
    prepared.getTaskRuntimeState(),
    direct.getTaskRuntimeState()
  );
  assert.deepEqual(prepared.getTaskDeadlineControl(), direct.getTaskDeadlineControl());

  assert.equal(
    prepared.rollbackPreparedTaskRuntimeTransition(preparedTransition),
    true
  );
  assert.deepEqual(prepared.getTaskRuntimeState(), before);
  assert.deepEqual(prepared.getTaskDeadlineControl(), beforeDeadlines);
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
  setTestTaskRuntime(manager, {
    parent: makeInterviewTask({
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

test("freezes only later-confirmed Me facts into the advisor snapshot", () => {
  const manager = new MeetingContextManager();
  manager.addTranscriptTurn({
    id: "turn_me_confirmed",
    speaker: "me",
    text: "My palpitations have resolved.",
    startedAt: now,
    endedAt: now + 1,
    isFinal: true,
    source: "microphone",
    contextFusionStatus: "paired",
    relatedTurnIds: ["turn_them_confirmation"],
  });
  manager.addTranscriptTurn({
    id: "turn_me_unconfirmed",
    speaker: "me",
    text: "My salary expectation is one million dollars.",
    startedAt: now + 2,
    endedAt: now + 3,
    isFinal: true,
    source: "microphone",
    contextFusionStatus: "debug-only",
  });

  const prompt = manager.buildAdvisorPromptContext();

  assert.deepEqual(prompt.confirmedMeFacts, [
    {
      id: "turn_me_confirmed",
      text: "My palpitations have resolved.",
    },
  ]);
});

test("keeps screen scaffold and generated continuity out of source prompt and speech bias evidence", () => {
  const manager = new MeetingContextManager();
  setTestTaskRuntime(manager, {
    screenAttachment: makeScreenTask({
      question: "Implement a queue",
      content: "Manual scaffold: Use FAKEGEN as the implementation placeholder.",
    }),
    parent: makeInterviewTask({
      stableKind: "coding",
      topic: "Implement a queue",
    }),
  });

  const context = manager.buildAdvisorPromptContext();
  assert.equal(context.activeMeetingTask?.screen?.question, "Implement a queue");
  assert.doesNotMatch(context.screenContext, /Topic:|Screen question:/);
  assert.doesNotMatch(context.screenContext, /FAKEGEN/);

  const state = manager.getState();
  const projectedTask = projectBoundedGeneratedContinuityForTask({
    state: {
      owner: { sessionId: state.sessionId, runtimeEpoch: 1, parentTaskId: "parent_1" },
      latestUsefulAnswer: "Use FAKEPARENT in the generated answer.",
      recentCapsules: [],
    },
    task: state.activeMeetingTask,
    sessionId: state.sessionId,
    runtimeEpoch: 1,
  });
  assert.match(projectedTask!.parent.latestUsefulAnswer!, /FAKEPARENT/);
  assert.equal("latestUsefulAnswer" in state.taskRuntime.parent!, false);
  const bias = buildSpeechBiasContext({ ...state, activeMeetingTask: projectedTask }, []);
  assert.equal(
    bias.terms.some((term) =>
      ["FAKEGEN", "FAKEPARENT"].includes(term.term)
    ),
    false
  );
});

test("keeps full task text out of speech bias while extracting bounded technical terms", () => {
  const manager = new MeetingContextManager();
  const parentTopic = "Explain OASIS retry behavior in detail";
  const factAnchor = "The candidate implemented FAKEANCHOR retries with DLQ";
  setTestTaskRuntime(manager, {
    parent: makeInterviewTask({
      stableKind: "project-deep-dive",
      topic: parentTopic,
      supportedFactAnchors: [factAnchor],
      child: {
        id: "child_1",
        createdAt: now,
        updatedAt: now + 1,
        questionType: "field-knowledge",
        relation: "child-probe",
        intent: "concept-probe",
        question: "How does HNSW connect to OpenSearch?",
        basedOnTurnIds: ["turn_child"],
        basedOnObservationIds: [],
      },
    }),
  });

  const state = manager.getState();
  const projectedTask = projectBoundedGeneratedContinuityForTask({
    state: {
      owner: { sessionId: state.sessionId, runtimeEpoch: 1, parentTaskId: "parent_1" },
      child: { childTaskId: "child_1", compactSummary: "Generated GENSUMMARY must not bias STT." },
      recentCapsules: [],
    },
    task: state.activeMeetingTask,
    sessionId: state.sessionId,
    runtimeEpoch: 1,
  });
  assert.match(projectedTask!.child!.compactSummary!, /GENSUMMARY/);
  assert.equal("compactSummary" in state.taskRuntime.parent!.child!, false);
  const terms = buildSpeechBiasContext({ ...state, activeMeetingTask: projectedTask }, []).terms.map(
    (term) => term.term
  );
  assert.equal(terms.includes(parentTopic), false);
  assert.equal(terms.includes(factAnchor), false);
  assert.equal(terms.includes("GENSUMMARY"), false);
  for (const expected of ["OASIS", "FAKEANCHOR", "DLQ", "HNSW", "OpenSearch"]) {
    assert.equal(terms.includes(expected), true, expected);
  }
});

function makeScreenTask(
  overrides: Partial<ActiveScreenTask> = {}
): ActiveScreenTask {
  return {
    id: "screen_task_1",
    observationId: "obs_1",
    createdAt: now,
    updatedAt: now + 1,
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
    createdAt: now,
    updatedAt: now + 1,
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

function makeObservation(
  id: string,
  visualSummary?: string
): ScreenObservation {
  return {
    id,
    capturedAt: now,
    source: "hotkey",
    changed: true,
    visualSummary,
  };
}
