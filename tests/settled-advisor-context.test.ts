import type { ActiveMeetingTask } from "../src/lib/meeting/meeting-task-contracts.js";
import type { AdvisorPromptContext } from "../src/lib/meeting/meeting-context-contracts.js";
import assert from "node:assert/strict";
import test from "node:test";

import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import {
  compileSettledAdvisorPromptContext as compileProductionSettledAdvisorPromptContext,
  formatSettledAdvisorContextCompilationForTrace,
  resolveSettledResponseActionContextSelection,
} from "../src/lib/meeting/settled-advisor-context.js";
import type { TranscriptTurn } from "../src/lib/meeting/types.js";
import type { EffectiveQuestionSourceRecord } from "../src/lib/meeting/effective-question-source-ledger.js";

function compileSettledAdvisorPromptContext(
  input: Parameters<typeof compileProductionSettledAdvisorPromptContext>[0]
) {
  const effectiveRecords: EffectiveQuestionSourceRecord[] = turns()
    .filter((source) => source.id === "turn-parent" || source.id === "turn-child")
    .map((source) => ({
      recordId: source.id,
      sessionId: "session-a",
      runtimeEpoch: 2,
      logicalQuestionUnitId: `lqu-${source.id}`,
      logicalQuestionRevision: 1,
      sourceHash: `hash-${source.id}`,
      sourceKind: "voice",
      sourceTurnIds: [source.id],
      currentTurnId: source.id,
      text: source.text,
      effectiveSourceTexts: [{ turnId: source.id, text: source.text }],
      startedAt: source.startedAt,
      updatedAt: source.endedAt,
      settledAt: source.endedAt,
      speechAct: "question",
      disposition: "answer-primary-ask",
      relation: source.id === "turn-child" ? "child-probe" : "new-parent",
      owner: source.id === "turn-child"
        ? { kind: "active-child", parentId: "parent-rag", childId: "child-code" }
        : { kind: "parent-mainline", parentId: "parent-rag" },
    }));
  return compileProductionSettledAdvisorPromptContext({
    effectiveRecords, sessionId: "session-a", runtimeEpoch: 2, ...input,
  });
}

test("current-only removes raw transcript and task continuity bypasses", () => {
  const compilation = compileSettledAdvisorPromptContext({
    baseContext: context(),
    contextReadScope: "current-only",
    logicalQuestionUnit: {
      ...lqu(),
      contextSourceTurnIds: undefined,
    },
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

test("current-only keeps setup explicitly owned by the current LQU", () => {
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

  assert.match(compilation.context.transcript, /access control lists/i);
  assert.equal(
    compilation.context.advisorEvidencePacket?.sourceOwnedSemanticContext
      ?.text,
    "The corpus has access control lists."
  );
  assert.doesNotMatch(compilation.context.transcript, /unrelated old task/i);
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
      settledAdvisorContextMissingSourceTurnIds: [],
      settledAdvisorContextRejectedSourceTurnIds: [],
      settledAdvisorRecentSourceContextIncluded: true,
      settledAdvisorRawTranscriptBypassRemoved: true,
      settledAdvisorScreenContextIncluded: false,
      settledAdvisorScreenContextReason: "settled-screen-owner-missing",
      settledAdvisorResponseActionContextSelectionApplied: false,
      settledAdvisorResponseActionContextSelectionReason:
        "no-response-action-context-receipt",
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

test("previous LQU context follows final scope instead of current-question ownership", () => {
  const logicalQuestionUnit = {
    ...lqu(),
    contextSourceTurnIds: undefined,
    recentLogicalQuestionSourceTurnIds: ["turn-old"],
  };
  const parentRead = compileSettledAdvisorPromptContext({
    baseContext: context(),
    contextReadScope: "active-parent-read",
    logicalQuestionUnit,
    transcriptTurns: turns(),
  });
  const newParentRead = compileSettledAdvisorPromptContext({
    baseContext: context(),
    contextReadScope: "current-only",
    logicalQuestionUnit,
    transcriptTurns: turns(),
  });

  assert.match(parentRead.context.transcript, /unrelated old task/i);
  assert.doesNotMatch(newParentRead.context.transcript, /unrelated old task/i);
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
  assert.equal(compilation.screenContextReason, "current-screen-source");
  assert.equal(
    compilation.context.transcript,
    "Screen: Implement an LRU cache."
  );
});

test("Voice follow-up keeps the active Screen context through settled scope", () => {
  const activeMeetingTask = {
    ...task(),
    source: "mixed" as const,
    screen: {
      activeScreenTaskId: "screen-task-1",
      observationId: "observation-1",
      basedOnObservationId: "observation-1",
      question: "Implement the visible cache method.",
    },
  };
  const compilation = compileSettledAdvisorPromptContext({
    baseContext: {
      ...context(),
      activeMeetingTask,
      screenContext: "Visible code lines 35 through 38",
    },
    contextReadScope: "active-parent-read",
    logicalQuestionUnit: lqu(),
    transcriptTurns: turns(),
    screenScopeDecision: {
      action: "keep",
      reason: "existing-task-continuity",
    },
  });

  assert.equal(
    compilation.context.screenContext,
    "Visible code lines 35 through 38"
  );
  assert.equal(compilation.screenContextIncluded, true);
  assert.equal(compilation.screenContextReason, "settled-screen-scope-keep");
});

test("Screen clear authority survives the final Context compiler", () => {
  const activeMeetingTask = {
    ...task(),
    source: "mixed" as const,
    screen: {
      activeScreenTaskId: "screen-task-1",
      observationId: "observation-1",
      basedOnObservationId: "observation-1",
    },
  };
  const compilation = compileSettledAdvisorPromptContext({
    baseContext: {
      ...context(),
      activeMeetingTask,
      screenContext: "Stale visible task",
    },
    contextReadScope: "active-parent-read",
    logicalQuestionUnit: lqu(),
    transcriptTurns: turns(),
    screenScopeDecision: {
      action: "clear",
      reason: "voice-new-parent",
    },
  });

  assert.equal(compilation.context.screenContext, "");
  assert.equal(compilation.screenContextIncluded, false);
  assert.equal(compilation.screenContextReason, "screen-scope-clear");
});

test("Enhance receipt owns the final transcript source IDs", () => {
  const base = context();
  const compilation = compileSettledAdvisorPromptContext({
    baseContext: {
      ...base,
      responseActionContextScope: {
        operationId: "scope-enhance",
        action: "enhance-context",
        mode: "expanded",
        logicalQuestionUnitId: "lqu-current",
        logicalQuestionUnitRevision: 1,
        selectedContextSourceKinds: ["current-lqu", "recent-dialogue"],
        selectedContextTurnIds: ["turn-old", "turn-current"],
        selectedContextChars: 120,
        selectionReason: "shortest-sufficient-recent-dialogue",
        expansionBudget: 1_600,
      },
    },
    contextReadScope: "active-parent-read",
    logicalQuestionUnit: {
      ...lqu(),
      contextSourceTurnIds: ["turn-context"],
    },
    transcriptTurns: turns(),
  });

  assert.equal(compilation.scope, "bounded-recent-history");
  assert.deepEqual(compilation.selectedSourceTurnIds, [
    "turn-old",
    "turn-current",
  ]);
  assert.doesNotMatch(compilation.context.transcript, /access control lists/i);
  assert.doesNotMatch(compilation.context.transcript, /enterprise RAG system/i);
  assert.equal(compilation.responseActionContextSelectionApplied, true);
});

test("Narrow receipt excludes automatic LQU-owned context", () => {
  const compilation = compileSettledAdvisorPromptContext({
    baseContext: {
      ...context(),
      responseActionContextScope: {
        operationId: "scope-narrow",
        action: "narrow-context",
        mode: "current-only",
        logicalQuestionUnitId: "lqu-current",
        logicalQuestionUnitRevision: 1,
        selectedContextSourceKinds: ["current-lqu"],
        selectedContextTurnIds: ["turn-current"],
        selectedContextChars: 40,
        selectionReason: "current-logical-question-only",
        expansionBudget: 1_600,
      },
    },
    contextReadScope: "active-parent-read",
    logicalQuestionUnit: lqu(),
    transcriptTurns: turns(),
  });

  assert.equal(compilation.scope, "current-only");
  assert.deepEqual(compilation.selectedSourceTurnIds, ["turn-current"]);
  assert.doesNotMatch(compilation.context.transcript, /access control lists/i);
  assert.equal(compilation.context.activeMeetingTask, undefined);
  assert.equal(compilation.recentSourceContextIncluded, false);
});

test("rejects a response-action receipt for another LQU revision", () => {
  const decision = resolveSettledResponseActionContextSelection({
    snapshot: {
      operationId: "scope-stale",
      action: "enhance-context",
      mode: "expanded",
      logicalQuestionUnitId: "lqu-current",
      logicalQuestionUnitRevision: 1,
      selectedContextSourceKinds: ["current-lqu"],
      selectedContextTurnIds: ["turn-current"],
      selectedContextChars: 40,
      selectionReason: "current-only",
      expansionBudget: 1_600,
    },
    logicalQuestionUnit: { ...lqu(), revision: 2 },
  });

  assert.equal(decision.authorized, false);
  assert.equal(decision.reason, "logical-question-revision-mismatch");
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
