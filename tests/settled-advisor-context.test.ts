import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import {
  compileSettledAdvisorPromptContext,
  formatSettledAdvisorContextCompilationForTrace,
} from "../src/lib/meeting/settled-advisor-context.js";
import type {
  AdvisorPromptContext,
  TranscriptTurn,
} from "../src/lib/meeting/types.js";

test("current-only removes raw transcript and task continuity bypasses", () => {
  const compilation = compileSettledAdvisorPromptContext({
    baseContext: context(),
    contextReadScope: "current-only",
    logicalQuestionUnit: lqu(),
    transcriptTurns: turns(),
    recentSourceContext: {
      text: "The corpus has access control lists.",
      sourceTurnIds: ["turn-context"],
      parentId: "parent-rag",
      parentRevision: 3,
      retentionReason: "same-parent-adjacent-setup",
    },
  });

  assert.equal(compilation.context.transcript, "Them: How would you index it?");
  assert.equal(compilation.context.activeMeetingTask, undefined);
  assert.equal(
    compilation.context.advisorEvidencePacket?.sourceOwnedSemanticContext,
    undefined
  );
  assert.equal(
    compilation.context.advisorEvidencePacket?.continuity,
    undefined
  );
  assert.equal(
    compilation.context.advisorEvidencePacket?.generatedContinuity,
    undefined
  );
  assert.deepEqual(compilation.selectedSourceTurnIds, ["turn-current"]);
  assert.equal(compilation.rawTranscriptBypassRemoved, true);
});

test("active-child scope includes only current, recent, parent, and child sources", () => {
  const compilation = compileSettledAdvisorPromptContext({
    baseContext: context(),
    contextReadScope: "active-child-read",
    logicalQuestionUnit: lqu(),
    transcriptTurns: turns(),
    recentSourceContext: {
      text: "The corpus has access control lists.",
      sourceTurnIds: ["turn-context"],
      parentId: "parent-rag",
      parentRevision: 3,
      retentionReason: "same-parent-adjacent-setup",
    },
  });

  assert.deepEqual(compilation.selectedSourceTurnIds, [
    "turn-parent",
    "turn-context",
    "turn-child",
    "turn-current",
  ]);
  assert.doesNotMatch(compilation.context.transcript, /unrelated old task/i);
  assert.equal(compilation.context.activeMeetingTask?.child?.id, "child-code");
  assert.equal(compilation.recentSourceContextIncluded, true);
  assert.deepEqual(
    formatSettledAdvisorContextCompilationForTrace(compilation),
    {
      settledAdvisorContextReadScope: "active-child-read",
      settledAdvisorContextSourceTurnIds: [
        "turn-parent",
        "turn-context",
        "turn-child",
        "turn-current",
      ],
      settledAdvisorContextSourceTurnCount: 4,
      settledAdvisorRecentSourceContextIncluded: true,
      settledAdvisorRawTranscriptBypassRemoved: true,
    }
  );
});

test("active-parent scope removes active child and generated continuity", () => {
  const compilation = compileSettledAdvisorPromptContext({
    baseContext: context(),
    contextReadScope: "active-parent-read",
    logicalQuestionUnit: lqu(),
    transcriptTurns: turns(),
  });

  assert.equal(compilation.context.activeMeetingTask?.child, undefined);
  assert.equal(
    compilation.context.advisorEvidencePacket?.generatedContinuity,
    undefined
  );
  assert.doesNotMatch(compilation.context.transcript, /child implementation/i);
});

test("persisted LQU context survives candidate consumption on regenerate", () => {
  const compilation = compileSettledAdvisorPromptContext({
    baseContext: context(),
    contextReadScope: "active-parent-read",
    logicalQuestionUnit: lqu(),
    transcriptTurns: turns(),
  });

  assert.match(
    compilation.context.transcript,
    /corpus has access control lists/i
  );
  assert.equal(compilation.recentSourceContextIncluded, true);
});

test("screen LQU preserves current screen context before task commit", () => {
  const compilation = compileSettledAdvisorPromptContext({
    baseContext: {
      ...context(),
      activeMeetingTask: undefined,
      screenContext: "Visible coding problem",
    },
    contextReadScope: "current-only",
    logicalQuestionUnit: {
      ...lqu(),
      id: "screen-answer-sufficiency:observation-1",
      currentTurnId: "screen:observation-1",
      sourceTurnIds: [],
      contextSourceTurnIds: undefined,
      sources: [
        {
          turnId: "screen:observation-1",
          text: "Implement an LRU cache.",
          startedAt: 40,
          endedAt: 40,
        },
      ],
      normalizedText: "Implement an LRU cache.",
    },
    transcriptTurns: turns(),
  });

  assert.equal(compilation.context.screenContext, "Visible coding problem");
  assert.equal(
    compilation.context.transcript,
    "Them: How would you index it?"
  );
});

function context(): AdvisorPromptContext {
  const activeMeetingTask = task();
  return {
    transcript: turns()
      .map((turn) => `Them: ${turn.text}`)
      .join("\n"),
    advisorPromptSourceTurnIds: turns().map((turn) => turn.id),
    screenContext: "old screen context",
    taskRuntime: { revision: 4 },
    activeMeetingTask,
    rollingSummary: "broad session summary",
    userProfileContext: "profile",
    glossaryText: "RAG: retrieval augmented generation",
    latestTurn: turns().at(-1),
    currentQuestionProjection: {
      answerFocusText: "How would you index it?",
      semanticEvidenceText: "How would you index it?",
      sourceTurnIds: ["turn-current"],
    },
    advisorEvidencePacket: {
      version: "advisor-evidence-v2",
      currentQuestion: {
        text: "How would you index it?",
        source: "voice-lqu",
        sourceTurnIds: ["turn-current"],
        logicalQuestionUnitId: "lqu-current",
        revision: 1,
      },
      sourceOwnedSemanticContext: {
        text: "The corpus has access control lists.",
        sourceTurnIds: ["turn-context"],
        parentId: "parent-rag",
        parentRevision: 3,
        retentionReason: "same-parent-adjacent-setup",
      },
      continuity: {
        parentTaskId: "parent-rag",
        childTaskId: "child-code",
        capsule: "parent and child continuity",
        sourceTurnIds: ["turn-parent"],
      },
      preparation: {
        interviewTypes: [],
        guidanceHints: [],
        activatedFactIds: [],
        rawGuidanceRejectedAsFactCount: 0,
      },
      generatedContinuity: {
        contextReadScope: "bounded-recent-history",
        decisionReason: "deictic",
        parentTaskId: "parent-rag",
        deicticEvidence: ["it"],
        capsules: [],
      },
      retrievalHints: [
        { role: "continuity", text: "old generated continuity" },
      ],
    },
  };
}

function task(): ActiveMeetingTask {
  return {
    id: "parent-rag",
    runtimeRevision: 4,
    source: "voice",
    parent: {
      id: "parent-rag",
      questionType: "ai-ml-system-design",
      topic: "Design an enterprise RAG system",
      playbookPhase: "design_framing",
      phaseProgress: {},
      canonicalQuestionSourceTurnIds: ["turn-parent"],
      supportedFactAnchors: [],
      createdAt: 1,
      updatedAt: 2,
      revisions: 3,
    },
    child: {
      id: "child-code",
      questionType: "coding",
      relation: "child-probe",
      intent: "implementation-probe",
      question: "Implement the retrieval merge function.",
      basedOnTurnIds: ["turn-child"],
      basedOnObservationIds: [],
      createdAt: 3,
      updatedAt: 4,
    },
  };
}

function lqu(): LogicalQuestionUnit {
  return {
    id: "lqu-current",
    revision: 1,
    sessionId: "session-a",
    runtimeEpoch: 2,
    currentTurnId: "turn-current",
    sourceTurnIds: ["turn-current"],
    contextSourceTurnIds: ["turn-context"],
    sources: [
      {
        turnId: "turn-current",
        text: "How would you index it?",
        startedAt: 40,
        endedAt: 41,
      },
    ],
    normalizedText: "How would you index it?",
    startedAt: 40,
    updatedAt: 41,
    compositionReasons: ["no-previous-logical-question"],
    boundaryReason: "no-previous-logical-question",
    truncated: false,
  };
}

function turns(): TranscriptTurn[] {
  return [
    turn("turn-old", "An unrelated old task.", 0),
    turn("turn-parent", "Design an enterprise RAG system.", 10),
    turn("turn-context", "The corpus has access control lists.", 20),
    turn("turn-child", "Implement the child implementation.", 30),
    turn("turn-current", "How would you index it?", 40),
  ];
}

function turn(id: string, text: string, startedAt: number): TranscriptTurn {
  return {
    id,
    text,
    speaker: "them",
    source: "system-audio",
    startedAt,
    endedAt: startedAt + 1,
    isFinal: true,
  };
}
