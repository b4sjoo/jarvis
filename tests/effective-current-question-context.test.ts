import type { AdvisorPromptContext } from "../src/lib/meeting/meeting-context-contracts.js";
import assert from "node:assert/strict";
import test from "node:test";
import { applyActiveQuestionTermCorrection } from "../src/lib/meeting/active-question-term-correction.js";
import {
  applyEffectiveCurrentQuestionContext,
} from "../src/lib/meeting/effective-current-question-context.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";


test("isolates a current-only prompt without creating another task scope", () => {
  const projection = applyEffectiveCurrentQuestionContext({
    context: context(),
    logicalQuestionUnit: unit("What is HNSW?"),
  });

  assert.equal(projection.transcript, "Them: What is HNSW?");
  assert.deepEqual(projection.advisorPromptSourceTurnIds, ["turn-current"]);
  assert.equal(projection.activeMeetingTask, undefined);
  assert.equal(projection.interviewPlaybook, undefined);
  assert.equal(projection.memoryContext, undefined);
  assert.equal(projection.taskRuntime.revision, 4);
});

test("uses the corrected effective LQU instead of its raw source", () => {
  const corrected = applyActiveQuestionTermCorrection({
    correction: {
      id: "correction-rag",
      input: "RAG not rec",
      term: "RAG",
      from: "rec",
      to: "RAG",
      createdAt: 2,
      appliedCount: 0,
    },
    logicalQuestionUnit: unit("What is rec?"),
    correctionTraceId: "trace-correction",
    manualCorrectionRevision: 1,
  }).logicalQuestionUnit;
  const projection = applyEffectiveCurrentQuestionContext({
    context: context(),
    logicalQuestionUnit: corrected,
  });

  assert.match(projection.transcript, /What is RAG/);
  assert.doesNotMatch(projection.transcript, /What is rec/);
});

function context(): AdvisorPromptContext {
  return {
    transcript: "Them: stale parent context\nThem: What is HNSW?",
    advisorPromptSourceTurnIds: ["turn-parent", "turn-current"],
    screenContext: "stale screen",
    taskRuntime: { revision: 4 },
    activeMeetingTask: {
      id: "parent-code",
      runtimeRevision: 4,
      source: "voice",
      parent: {
        id: "parent-code",
        questionType: "coding",
        topic: "Implement an LRU cache.",
        playbookPhase: "implementation_validation",
        phaseProgress: {},
        supportedFactAnchors: [],
        createdAt: 1,
        updatedAt: 1,
      },
    },
    rollingSummary: "generated summary",
    userProfileContext: "profile",
    glossaryText: "",
    memoryContext: "stale memory",
  };
}

function unit(text: string): LogicalQuestionUnit {
  return {
    id: "lqu-current",
    revision: 1,
    sessionId: "session-1",
    runtimeEpoch: 1,
    currentTurnId: "turn-current",
    sourceTurnIds: ["turn-current"],
    sources: [
      {
        turnId: "turn-current",
        text,
        startedAt: 1,
        endedAt: 2,
      },
    ],
    normalizedText: text,
    startedAt: 1,
    updatedAt: 2,
    compositionReasons: ["independent-current-turn"],
    boundaryReason: "independent-current-turn",
    truncated: false,
  };
}
