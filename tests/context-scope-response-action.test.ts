import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_SCOPE_MAX_CAPSULE_CHARS,
  CONTEXT_SCOPE_MAX_EXPANSION_CHARS,
  CONTEXT_SCOPE_MAX_RECENT_THEM_TURNS,
  composeCurrentOnlyAdvisorPromptContext,
  composeExpandedAdvisorPromptContext,
} from "../src/lib/meeting/context-scope-response-action.js";
import {
  compileSettledAdvisorPromptContext,
  resolveSettledResponseActionContextSelection,
} from "../src/lib/meeting/settled-advisor-context.js";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import type {
  AdvisorPromptContext,
  MeetingContextState,
  TranscriptTurn,
} from "../src/lib/meeting/types.js";

test("Narrow keeps the exact current LQU and excludes inherited generated context", () => {
  const current = turn("turn_current", "Explain consistent hashing.", 8_000);
  const unit = logicalQuestion(
    "logical_current",
    3,
    current,
    "Explain consistent hashing."
  );
  const task = activeTask({
    latestUsefulAnswer: "GENERATED_PREVIOUS_ANSWER",
    previousUsefulAnswer: "GENERATED_OLDER_ANSWER",
    childSummary: "GENERATED_CHILD_SUMMARY",
    whiteboardBody: "GENERATED_WHITEBOARD_BODY",
    screenAnswer: "GENERATED_SCREEN_ANSWER",
  });
  const base = baseContext(task);
  base.memoryContext = "PRIVATE_MEMORY_PAYLOAD";
  base.rollingSummary = "GENERATED_ROLLING_SUMMARY";

  const result = composeCurrentOnlyAdvisorPromptContext({
    baseContext: base,
    logicalQuestionUnit: unit,
    meetingContext: meetingContext([current], task),
    activeMeetingTask: task,
  });
  const serialized = JSON.stringify(result.promptContext);

  assert.equal(result.logicalQuestionUnitId, "logical_current");
  assert.equal(result.logicalQuestionUnitRevision, 3);
  assert.deepEqual(result.selectedKinds, ["current-lqu"]);
  assert.deepEqual(result.selectedTurnIds, ["turn_current"]);
  assert.match(result.promptContext.transcript, /Explain consistent hashing/);
  assert.equal(result.promptContext.latestTurn?.id, "turn_current");
  for (const forbidden of [
    "GENERATED_PREVIOUS_ANSWER",
    "GENERATED_OLDER_ANSWER",
    "GENERATED_CHILD_SUMMARY",
    "GENERATED_WHITEBOARD_BODY",
    "GENERATED_SCREEN_ANSWER",
    "PRIVATE_MEMORY_PAYLOAD",
    "GENERATED_ROLLING_SUMMARY",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden));
  }
  assert.equal(result.promptContext.memoryContext, undefined);
  assert.equal(result.promptContext.activeMeetingTask?.child, undefined);
  assert.equal(
    result.promptContext.activeMeetingTask?.parent.whiteboardArtifact,
    undefined
  );
});

test("Narrow preserves a visible screen question as screen evidence", () => {
  const task = activeTask({ screenAnswer: "GENERATED_SCREEN_ANSWER" });
  const unit: LogicalQuestionUnit = {
    id: "screen-scope-screen-task",
    revision: 2,
    sessionId: "session-test",
    runtimeEpoch: 1,
    currentTurnId: "screen:screen-task",
    sourceTurnIds: [],
    sources: [
      {
        turnId: "screen:screen-task",
        text: "Design a distributed rate limiter.",
        startedAt: 10,
        endedAt: 10,
      },
    ],
    normalizedText: "Design a distributed rate limiter.",
    startedAt: 10,
    updatedAt: 10,
    compositionReasons: ["visible-screen-question"],
    boundaryReason: "visible-screen-question",
    truncated: false,
  };

  const result = composeCurrentOnlyAdvisorPromptContext({
    baseContext: baseContext(task),
    logicalQuestionUnit: unit,
    meetingContext: meetingContext([], task),
    activeMeetingTask: task,
  });

  assert.equal(result.promptContext.transcript, "");
  assert.match(
    result.promptContext.screenContext,
    /Current visible screen question/
  );
  assert.match(
    result.promptContext.screenContext,
    /Design a distributed rate limiter/
  );
  assert.equal(result.promptContext.latestTurn, undefined);
});

test("Enhance selects a bounded recent source window for a referential request", () => {
  const priorThem = Array.from({ length: 6 }, (_, index) =>
    turn(
      `turn_them_${index + 1}`,
      index === 5
        ? "The function should recursively return every matching text file path."
        : `Earlier technical requirement ${index + 1} for the directory scanner.`,
      1_000 + index * 1_000
    )
  );
  const relevantMe = {
    ...turn(
      "turn_me_relevant",
      "I will use Python and preserve the recursive requirement.",
      6_500,
      "me"
    ),
    contextPromptEligible: true,
    contextTier: "me_clarification_medium" as const,
  };
  const irrelevantMe = {
    ...turn(
      "turn_me_long",
      "MY_LONG_ATTEMPT_SHOULD_NOT_BE_INCLUDED",
      6_700,
      "me"
    ),
    contextPromptEligible: true,
    contextTier: "me_attempted_answer_long" as const,
  };
  const current = turn(
    "turn_current",
    "Can you write the Python code for that?",
    8_000
  );
  const unit = logicalQuestion(
    "logical_referential",
    2,
    current,
    current.text,
    ["referential-completion"],
    "bounded-continuation"
  );
  const state = meetingContext([
    ...priorThem,
    relevantMe,
    irrelevantMe,
    current,
  ]);

  const result = composeExpandedAdvisorPromptContext({
    baseContext: baseContext(),
    logicalQuestionUnit: unit,
    meetingContext: state,
    questionRelation: "referential-follow-up",
  });
  const recent = result.candidates.find(
    (candidate) => candidate.kind === "recent-dialogue"
  );

  assert.equal(recent?.selected, true);
  assert.ok(recent);
  assert.ok(
    recent.turnIds.filter((id) => id.startsWith("turn_them_")).length <=
      CONTEXT_SCOPE_MAX_RECENT_THEM_TURNS
  );
  assert.ok(recent.turnIds.includes("turn_me_relevant"));
  assert.ok(!recent.turnIds.includes("turn_me_long"));
  assert.ok(!recent.turnIds.includes("turn_them_1"));
  assert.match(result.promptContext.transcript, /write the Python code/);
  assert.match(result.promptContext.transcript, /recursively return every/);
  assert.doesNotMatch(
    result.promptContext.transcript,
    /MY_LONG_ATTEMPT_SHOULD_NOT_BE_INCLUDED/
  );
});

test("Enhance preserves active Screen evidence through the final compiler", () => {
  const prior = turn(
    "turn_prior",
    "The highlighted method updates the cache order.",
    1_000
  );
  const current = turn(
    "turn_current",
    "Can you explain those highlighted lines?",
    2_000
  );
  const unit = logicalQuestion(
    "logical-screen-followup",
    1,
    current,
    current.text,
    ["independent-current-turn"],
    "independent-current-turn"
  );
  const task = activeTask({
    parentTurnIds: [prior.id],
    screenAnswer: "GENERATED_SCREEN_ANSWER",
  });
  const state = meetingContext([prior, current], task);
  const selection = composeExpandedAdvisorPromptContext({
    baseContext: baseContext(task),
    logicalQuestionUnit: unit,
    meetingContext: state,
    activeMeetingTask: task,
    questionRelation: "referential-follow-up",
  });
  const promptContext = {
    ...selection.promptContext,
    responseActionContextScope: {
      operationId: "scope-screen-enhance",
      action: "enhance-context" as const,
      mode: selection.contextScopeMode,
      logicalQuestionUnitId: selection.logicalQuestionUnitId,
      logicalQuestionUnitRevision: selection.logicalQuestionUnitRevision,
      selectedContextSourceKinds: selection.selectedKinds,
      selectedContextTurnIds: selection.selectedTurnIds,
      selectedContextChars: selection.selectedChars,
      selectionReason: selection.selectionReason,
      expansionBudget: selection.budgets.maxExpansionChars,
    },
  };
  const receipt = resolveSettledResponseActionContextSelection({
    snapshot: promptContext.responseActionContextScope,
    logicalQuestionUnit: unit,
  });
  const compiled = compileSettledAdvisorPromptContext({
    baseContext: promptContext,
    contextReadScope: "active-parent-read",
    logicalQuestionUnit: unit,
    transcriptTurns: state.transcriptTurns,
    screenScopeDecision: {
      action: "keep",
      reason: "explicit-action-preserve",
    },
    responseActionContextSelection: receipt,
  });

  assert.equal(selection.promptContext.screenContext, "OLD_SCREEN_CONTEXT");
  assert.equal(compiled.context.screenContext, "OLD_SCREEN_CONTEXT");
  assert.equal(compiled.screenContextReason, "settled-screen-scope-keep");
});

test("Enhance can use a source-only child capsule without compactSummary", () => {
  const childSource = turn(
    "turn_child",
    "How does the retrieval stage rank candidate documents?",
    3_000
  );
  const current = turn(
    "turn_current",
    "Back to retrieval, how do you improve its ranking quality?",
    5_000
  );
  const unit = logicalQuestion(
    "logical_child",
    1,
    current,
    current.text
  );
  const task = activeTask({
    childQuestion: childSource.text,
    childSummary: "GENERATED_CHILD_ANSWER_BODY",
    childTurnIds: [childSource.id],
  });

  const result = composeExpandedAdvisorPromptContext({
    baseContext: baseContext(task),
    logicalQuestionUnit: unit,
    meetingContext: meetingContext([childSource, current], task),
    activeMeetingTask: task,
    questionRelation: "continuation",
  });
  const child = result.candidates.find(
    (candidate) => candidate.kind === "child-capsule"
  );

  assert.equal(child?.selected, true);
  assert.ok((child?.chars ?? Infinity) <= CONTEXT_SCOPE_MAX_CAPSULE_CHARS);
  assert.match(result.promptContext.transcript, /retrieval stage rank/);
  assert.doesNotMatch(
    JSON.stringify(result),
    /GENERATED_CHILD_ANSWER_BODY/
  );
});

test("Enhance can use a source-only parent capsule without answers or artifacts", () => {
  const parentSource = turn(
    "turn_parent",
    "Design a ticket selling system for high-concurrency seat reservations.",
    1_000
  );
  const current = turn(
    "turn_current",
    "How should the overall architecture scale for peak QPS?",
    4_000
  );
  const unit = logicalQuestion(
    "logical_parent",
    4,
    current,
    current.text
  );
  const task = activeTask({
    parentTurnIds: [parentSource.id],
    latestUsefulAnswer: "GENERATED_ARCHITECTURE_ANSWER",
    whiteboardBody: "GENERATED_DIAGRAM_BODY",
  });

  const result = composeExpandedAdvisorPromptContext({
    baseContext: baseContext(task),
    logicalQuestionUnit: unit,
    meetingContext: meetingContext([parentSource, current], task),
    activeMeetingTask: task,
    questionRelation: "continuation",
  });
  const parent = result.candidates.find(
    (candidate) => candidate.kind === "parent-capsule"
  );
  const serialized = JSON.stringify(result);

  assert.equal(parent?.selected, true);
  assert.ok((parent?.chars ?? Infinity) <= CONTEXT_SCOPE_MAX_CAPSULE_CHARS);
  assert.match(result.promptContext.transcript, /ticket selling system/);
  assert.doesNotMatch(serialized, /GENERATED_ARCHITECTURE_ANSWER/);
  assert.doesNotMatch(serialized, /GENERATED_DIAGRAM_BODY/);
});

test("Enhance rejects stale parent and recent context for an independent question", () => {
  const oldParentTurn = turn(
    "turn_old_parent",
    "Design a ride-sharing service and estimate ride request QPS.",
    1_000
  );
  const current = turn(
    "turn_current",
    "Now design a compiler that optimizes arithmetic expressions.",
    5_000
  );
  const unit = logicalQuestion(
    "logical_new_parent",
    1,
    current,
    current.text,
    ["explicit-task-switch"],
    "explicit-task-switch"
  );
  const task = activeTask({ parentTurnIds: [oldParentTurn.id] });

  const result = composeExpandedAdvisorPromptContext({
    baseContext: baseContext(task),
    logicalQuestionUnit: unit,
    meetingContext: meetingContext([oldParentTurn, current], task),
    activeMeetingTask: task,
    questionRelation: "independent-new-question",
  });

  assert.equal(result.independentQuestionGuardApplied, true);
  assert.deepEqual(result.selectedKinds, ["current-lqu"]);
  assert.equal(result.selectionReason, "independent-question-current-only");
  assert.doesNotMatch(result.promptContext.transcript, /ride-sharing/);
  assert.equal(result.promptContext.activeMeetingTask, undefined);
  assert.equal(result.promptContext.interviewPlaybook, undefined);
  for (const candidate of result.candidates.slice(1)) {
    assert.equal(
      candidate.rejectedReason,
      "independent-question-stale-context-guard"
    );
  }
});

test("explicit Enhance selects the best bounded source when automatic sufficiency is low", () => {
  const prior = turn(
    "turn_prior",
    "A future team may use a separate analytics store.",
    1_000
  );
  const current = turn(
    "turn_current",
    "What would you monitor in production?",
    5_000
  );
  const unit = logicalQuestion(
    "logical_monitoring",
    1,
    current,
    current.text
  );

  const result = composeExpandedAdvisorPromptContext({
    baseContext: baseContext(),
    logicalQuestionUnit: unit,
    meetingContext: meetingContext([prior, current]),
    questionRelation: "continuation",
  });

  assert.deepEqual(result.selectedKinds, [
    "current-lqu",
    "recent-dialogue",
  ]);
  assert.equal(
    result.selectionReason,
    "manual-best-available-recent-dialogue"
  );
  assert.match(result.promptContext.transcript, /separate analytics store/);
});

test("Enhance enforces recent-window and capsule character budgets", () => {
  const priorThem = Array.from({ length: 8 }, (_, index) =>
    turn(
      `turn_prior_${index}`,
      `Technical context ${index} ${"x".repeat(500)}`,
      1_000 + index * 1_000
    )
  );
  const current = turn(
    "turn_current",
    "Can you continue that architecture analysis?",
    12_000
  );
  const unit = logicalQuestion(
    "logical_budget",
    7,
    current,
    current.text,
    ["referential-completion"],
    "bounded-continuation"
  );
  const task = activeTask({
    parentTurnIds: priorThem.map((item) => item.id),
    childQuestion: `Retrieval details ${"y".repeat(900)}`,
    childTurnIds: [priorThem[7].id],
  });

  const result = composeExpandedAdvisorPromptContext({
    baseContext: baseContext(task),
    logicalQuestionUnit: unit,
    meetingContext: meetingContext([...priorThem, current], task),
    activeMeetingTask: task,
    questionRelation: "referential-follow-up",
  });
  const recent = result.candidates.find(
    (candidate) => candidate.kind === "recent-dialogue"
  );
  const capsules = result.candidates.filter((candidate) =>
    candidate.kind.endsWith("capsule")
  );

  assert.ok((recent?.chars ?? Infinity) <= CONTEXT_SCOPE_MAX_EXPANSION_CHARS);
  assert.ok(
    (recent?.turnIds.filter((id) => id.startsWith("turn_prior_")).length ??
      Infinity) <= CONTEXT_SCOPE_MAX_RECENT_THEM_TURNS
  );
  assert.ok(
    capsules.every(
      (candidate) => candidate.chars <= CONTEXT_SCOPE_MAX_CAPSULE_CHARS
    )
  );
  const selectedExpansionChars = result.candidates
    .filter(
      (candidate) =>
        candidate.selected && candidate.kind !== "current-lqu"
    )
    .reduce((total, candidate) => total + candidate.chars, 0);
  assert.ok(selectedExpansionChars <= CONTEXT_SCOPE_MAX_EXPANSION_CHARS);
});

function baseContext(
  task?: ActiveMeetingTask
): AdvisorPromptContext {
  return {
    transcript: "Them: OLD_TRANSCRIPT",
    screenContext: "OLD_SCREEN_CONTEXT",
    activeMeetingTask: task,
    rollingSummary: "",
    userProfileContext: "OLD_USER_PROFILE",
    glossaryText: "OLD_GLOSSARY",
    taskRuntime: { revision: 0 },
    confirmedMeFacts: [{ id: "fact-old", text: "OLD_CONFIRMED_FACT" }],
  };
}

function meetingContext(
  transcriptTurns: TranscriptTurn[],
  task?: ActiveMeetingTask
): MeetingContextState {
  return {
    sessionId: "session-test",
    startedAt: 0,
    transcriptTurns,
    screenObservations: [],
    taskRuntime: { revision: 0 },
    activeMeetingTask: task,
    rollingSummary: "",
    userProfileContext: "",
    glossary: [],
  };
}

function logicalQuestion(
  id: string,
  revision: number,
  current: TranscriptTurn,
  normalizedText: string,
  compositionReasons: string[] = ["independent-current-turn"],
  boundaryReason = "independent-current-turn"
): LogicalQuestionUnit {
  return {
    id,
    revision,
    sessionId: "session-test",
    runtimeEpoch: 1,
    currentTurnId: current.id,
    sourceTurnIds: [current.id],
    sources: [
      {
        turnId: current.id,
        text: current.text,
        startedAt: current.startedAt,
        endedAt: current.endedAt,
      },
    ],
    normalizedText,
    startedAt: current.startedAt,
    updatedAt: current.endedAt,
    compositionReasons,
    boundaryReason,
    truncated: false,
  };
}

function activeTask(input: {
  parentTurnIds?: string[];
  latestUsefulAnswer?: string;
  previousUsefulAnswer?: string;
  childQuestion?: string;
  childSummary?: string;
  childTurnIds?: string[];
  whiteboardBody?: string;
  screenAnswer?: string;
} = {}): ActiveMeetingTask {
  return {
    id: "parent-task",
    runtimeRevision: 1,
    source: "voice",
    parent: {
      id: "parent-task",
      questionType: "general-system-design",
      topic: "GENERATED_PARENT_TOPIC",
      playbookPhase: "design_framing",
      phaseProgress: { requirement_clarification: true },
      supportedFactAnchors: ["PRIVATE_MEMORY_ANCHOR"],
      latestUsefulAnswer: input.latestUsefulAnswer,
      previousUsefulAnswer: input.previousUsefulAnswer,
      whiteboardArtifact: input.whiteboardBody
        ? {
            id: "whiteboard-1",
            parentTaskId: "parent-task",
            domainTrack: "general_sd",
            archetypeIds: [],
            selectedOverlayIds: [],
            currentPhase: "design_framing",
            title: "Generated diagram",
            content: input.whiteboardBody,
            summary: input.whiteboardBody,
            revision: 1,
            updateSource: "model-output",
            updatedAt: 10,
            createdAt: 10,
          }
        : undefined,
      createdAt: 1,
      updatedAt: 10,
      startTurnId: input.parentTurnIds?.[0],
      canonicalQuestionSourceTurnIds: input.parentTurnIds,
      revisions: 2,
    },
    child: input.childQuestion
      ? {
          id: "child-task",
          createdAt: 2,
          updatedAt: 9,
          questionType: "field-knowledge",
          relation: "child-probe",
          intent: "concept-probe",
          question: input.childQuestion,
          compactSummary: input.childSummary,
          basedOnTurnIds: input.childTurnIds ?? [],
          basedOnObservationIds: [],
        }
      : undefined,
    screen: input.screenAnswer
      ? {
          activeScreenTaskId: "screen-task",
          observationId: "observation-1",
          basedOnObservationId: "observation-1",
          question: "OLD_SCREEN_QUESTION",
          latestScreenAnswer: input.screenAnswer,
          content: input.screenAnswer,
        }
      : undefined,
  };
}

function turn(
  id: string,
  text: string,
  startedAt: number,
  speaker: "them" | "me" = "them"
): TranscriptTurn {
  return {
    id,
    speaker,
    text,
    startedAt,
    endedAt: startedAt + 200,
    isFinal: true,
    source: speaker === "them" ? "system-audio" : "microphone",
  };
}
