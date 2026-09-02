import assert from "node:assert/strict";
import test from "node:test";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import { buildSpeechBiasContext } from "../src/lib/meeting/speech-bias.js";
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
  setTestTaskRuntime(direct, { parent });
  setTestTaskRuntime(prepared, { parent });
  const before = prepared.getTaskRuntimeState();
  const input = {
    id: "generation-transition",
    transition: "update-parent-context" as const,
    reason: "generation-result-atomic-commit",
    expectedRevision: before.revision,
    parent: {
      ...parent,
      latestUsefulAnswer: "Use the committed answer.",
      revisions: parent.revisions + 1,
    },
    appliedAt: now + 20,
  };

  const directResult = direct.commitTaskRuntimeTransition(input);
  const preparedTransition = prepared.prepareTaskRuntimeTransition(input);
  assert.deepEqual(prepared.getTaskRuntimeState(), before);
  assert.deepEqual(preparedTransition.result, directResult);

  const preparedResult =
    prepared.commitPreparedTaskRuntimeTransition(preparedTransition);
  assert.deepEqual(preparedResult, directResult);
  assert.deepEqual(
    prepared.getTaskRuntimeState(),
    direct.getTaskRuntimeState()
  );

  assert.equal(
    prepared.rollbackPreparedTaskRuntimeTransition(preparedTransition),
    true
  );
  assert.deepEqual(prepared.getTaskRuntimeState(), before);
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

test("keeps generated screen answers out of source prompt and speech bias evidence", () => {
  const manager = new MeetingContextManager();
  setTestTaskRuntime(manager, {
    screenAttachment: makeScreenTask({
      question: "Implement a queue",
      content: "Answer: Use FAKEGEN as the generated implementation.",
    }),
    parent: makeInterviewTask({
      stableKind: "coding",
      topic: "Implement a queue",
      latestUsefulAnswer: "Use FAKEPARENT in the generated answer.",
    }),
  });

  const context = manager.buildAdvisorPromptContext();
  assert.match(context.screenContext, /Implement a queue/);
  assert.doesNotMatch(context.screenContext, /FAKEGEN/);

  const bias = buildSpeechBiasContext(manager.getState(), []);
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
        compactSummary: "Generated GENSUMMARY must not bias STT.",
        basedOnTurnIds: ["turn_child"],
        basedOnObservationIds: [],
      },
    }),
  });

  const terms = buildSpeechBiasContext(manager.getState(), []).terms.map(
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
