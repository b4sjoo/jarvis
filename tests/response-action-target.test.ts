import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  resolveVisibleAnswerResponseActionTarget,
} from "../src/lib/meeting/response-action-target.js";
import { getLogicalQuestionAnswerFocusText } from "../src/lib/meeting/logical-question-unit.js";
import type { StableAnswerRevision } from "../src/lib/meeting/stable-answer.js";
import type { MeetingContextState } from "../src/lib/meeting/types.js";
import {
  createProvisionalCurrentQuestion,
  type CurrentQuestionSettlementDecision,
} from "../src/lib/meeting/current-question-settlement.js";
import type { EffectiveQuestionSourceRecord } from "../src/lib/meeting/effective-question-source-ledger.js";

const voiceLogicalQuestion = {
  id: "question-voice",
  revision: 2,
  sessionId: "session-a",
  runtimeEpoch: 3,
  currentTurnId: "turn-voice",
  sourceTurnIds: ["turn-voice"],
  sources: [
    {
      turnId: "turn-voice",
      text: "Tell me about a time you earned trust.",
      startedAt: 10,
      endedAt: 15,
    },
  ],
  normalizedText: "Tell me about a time you earned trust.",
  restoredAnswerFocusText: "Tell me about a time you earned trust.",
  startedAt: 10,
  updatedAt: 15,
  compositionReasons: ["visible-answer-effective-source-record"],
  boundaryReason: "visible-answer-effective-source-record" as const,
  truncated: false,
};
const voiceSourceHash = createProvisionalCurrentQuestion({
  logicalQuestionUnit: voiceLogicalQuestion,
  sourceKind: "voice",
}).sourceHash;

const frozenSettlement = {
  settlementId: "settlement-voice",
  logicalQuestionUnitId: "question-voice",
  revision: 2,
  sessionId: "session-a",
  runtimeEpoch: 3,
  sourceKind: "voice",
  sourceTurnIds: ["turn-voice"],
  sourceObservationIds: [],
  sourceHash: voiceSourceHash,
  questionType: "behavioral",
  relation: "followup-parent",
  action: "answer",
  evidenceMode: "unknown",
  authority: "runtime-adjudication",
  authoritySource: "runtime-adjudication",
  typeAuthoritySource: "runtime-adjudication",
  relationAuthoritySource: "runtime-adjudication",
  actionAuthoritySource: "runtime-adjudication",
  typeMutationAuthorized: true,
  relationMutationAuthorized: true,
  parentMutationAuthorized: false,
  responseAuthorized: true,
  confidence: 0.95,
  activeParentId: "parent-a",
  activeParentRevision: 1,
  manualCorrectionRevision: 0,
  rejectedProposals: [],
  reasons: ["visible-answer-owner"],
} satisfies CurrentQuestionSettlementDecision;

const stable = {
  revision: 5,
  sessionId: "session-a",
  runtimeEpoch: 3,
  taskId: "parent-a",
  logicalQuestionUnitId: "question-voice",
  logicalQuestionRevision: 2,
  questionSourceHash: voiceSourceHash,
  settlementId: "settlement-voice",
  settlementSnapshot: frozenSettlement,
  suggestion: {
    id: "suggestion-a",
    kind: "answer",
    content: "Answer:\nUse a concrete story.",
    createdAt: 20,
    basedOnTurnIds: ["turn-voice"],
    basedOnObservationIds: [],
    confidence: "medium",
  },
  sections: {} as StableAnswerRevision["sections"],
  committedAt: 20,
} satisfies StableAnswerRevision;

function context(parentId = "parent-a"): MeetingContextState {
  return {
    sessionId: "session-a",
    startedAt: 0,
    transcriptTurns: [
      {
        id: "turn-voice",
        speaker: "them",
        text: "Tell me about a time you earned trust.",
        startedAt: 10,
        endedAt: 15,
        isFinal: true,
        source: "system-audio",
      },
    ],
    screenObservations: [],
    taskRuntime: { revision: 1 },
    activeMeetingTask: {
      id: parentId,
      runtimeRevision: 1,
      source: "voice",
      parent: {
        id: parentId,
        questionType: "behavioral",
        topic: "Earn Trust",
        playbookPhase: "story_selection",
        phaseProgress: {},
        supportedFactAnchors: [],
        createdAt: 1,
        updatedAt: 2,
        revisions: 1,
      },
    },
    rollingSummary: "",
    userProfileContext: "",
    glossary: [],
  };
}

function effectiveVoiceRecord(): EffectiveQuestionSourceRecord {
  return {
    recordId: "source-record-voice",
    sessionId: "session-a",
    runtimeEpoch: 3,
    logicalQuestionUnitId: "question-voice",
    logicalQuestionRevision: 2,
    sourceHash: voiceSourceHash,
    sourceKind: "voice",
    currentTurnId: "turn-voice",
    sourceTurnIds: ["turn-voice"],
    sourceObservationIds: [],
    contextSourceTurnIds: [],
    recentLogicalQuestionSourceTurnIds: [],
    effectiveSourceTexts: [
      {
        turnId: "turn-voice",
        text: "Tell me about a time you earned trust.",
      },
    ],
    text: "Tell me about a time you earned trust.",
    answerFocusText: "Tell me about a time you earned trust.",
    startedAt: 10,
    updatedAt: 15,
    speechAct: "question",
    disposition: "answer-primary-ask",
    relation: "followup-parent",
    owner: { kind: "parent-mainline", parentId: "parent-a" },
    settledAt: 20,
  };
}

test("reconstructs Enhance target from the visible Answer owner", () => {
  const decision = resolveVisibleAnswerResponseActionTarget({
    stableAnswer: stable,
    currentLogicalQuestionUnit: undefined,
    effectiveQuestionSources: [effectiveVoiceRecord()],
    meetingContext: context(),
    runtimeEpoch: 3,
  });

  assert.equal(decision.authorized, true);
  assert.equal(decision.logicalQuestionUnit?.id, "question-voice");
  assert.equal(
    decision.logicalQuestionUnit?.normalizedText,
    "Tell me about a time you earned trust."
  );
  assert.equal(decision.sourceHash, voiceSourceHash);
  assert.equal(decision.settlementSnapshot, frozenSettlement);
});

test("restores a full effective source and its original answer focus without rehashing", () => {
  const semanticText = [
    "The system serves regional traffic and must preserve tenant isolation.",
    "x".repeat(1_420),
    "What would you monitor in production?",
  ].join(" ");
  const answerFocusText = "What would you monitor in production?";
  const logicalQuestionUnit = {
    id: "question-long-screen",
    revision: 4,
    sessionId: "session-a",
    runtimeEpoch: 3,
    currentTurnId: "screen:observation-long",
    sourceTurnIds: [],
    contextSourceTurnIds: ["turn-setup"],
    recentLogicalQuestionSourceTurnIds: ["turn-parent"],
    sources: [
      {
        turnId: "screen:observation-long",
        text: semanticText,
        startedAt: 10,
        endedAt: 15,
      },
    ],
    normalizedText: semanticText,
    restoredAnswerFocusText: answerFocusText,
    startedAt: 10,
    updatedAt: 15,
    compositionReasons: ["visible-answer-effective-source-record"],
    boundaryReason: "visible-answer-effective-source-record" as const,
    truncated: false,
  };
  const sourceHash = createProvisionalCurrentQuestion({
    logicalQuestionUnit,
    sourceKind: "screen",
    sourceObservationIds: ["observation-long"],
  }).sourceHash;
  const settlement = {
    ...frozenSettlement,
    settlementId: "settlement-long-screen",
    logicalQuestionUnitId: logicalQuestionUnit.id,
    revision: logicalQuestionUnit.revision,
    sourceKind: "screen" as const,
    sourceTurnIds: [],
    sourceObservationIds: ["observation-long"],
    sourceHash,
  } satisfies CurrentQuestionSettlementDecision;
  const decision = resolveVisibleAnswerResponseActionTarget({
    stableAnswer: {
      ...stable,
      logicalQuestionUnitId: logicalQuestionUnit.id,
      logicalQuestionRevision: logicalQuestionUnit.revision,
      questionSourceHash: sourceHash,
      settlementId: settlement.settlementId,
      settlementSnapshot: settlement,
    },
    currentLogicalQuestionUnit: undefined,
    effectiveQuestionSources: [
      {
        ...effectiveVoiceRecord(),
        recordId: "source-record-long-screen",
        logicalQuestionUnitId: logicalQuestionUnit.id,
        logicalQuestionRevision: logicalQuestionUnit.revision,
        sourceHash,
        sourceKind: "screen",
        currentTurnId: logicalQuestionUnit.currentTurnId,
        sourceTurnIds: [],
        sourceObservationIds: ["observation-long"],
        contextSourceTurnIds: ["turn-setup"],
        recentLogicalQuestionSourceTurnIds: ["turn-parent"],
        effectiveSourceTexts: [
          {
            turnId: logicalQuestionUnit.currentTurnId,
            text: semanticText,
          },
        ],
        text: semanticText,
        answerFocusText,
      },
    ],
    meetingContext: context(),
    runtimeEpoch: 3,
  });

  assert.equal(decision.authorized, true);
  assert.equal(decision.logicalQuestionUnit?.normalizedText, semanticText);
  assert.equal(
    getLogicalQuestionAnswerFocusText(decision.logicalQuestionUnit),
    answerFocusText
  );
  assert.deepEqual(decision.logicalQuestionUnit?.contextSourceTurnIds, [
    "turn-setup",
  ]);
  assert.deepEqual(
    decision.logicalQuestionUnit?.recentLogicalQuestionSourceTurnIds,
    ["turn-parent"]
  );
});

test("rejects a legacy effective source that cannot restore its canonical target", () => {
  const decision = resolveVisibleAnswerResponseActionTarget({
    stableAnswer: stable,
    currentLogicalQuestionUnit: undefined,
    effectiveQuestionSources: [
      {
        ...effectiveVoiceRecord(),
        currentTurnId: undefined,
      },
    ],
    meetingContext: context(),
    runtimeEpoch: 3,
  });

  assert.equal(decision.authorized, false);
  assert.equal(
    decision.reason,
    "visible-answer-effective-source-incomplete"
  );
});

test("reads a Screen visible-answer target from its exact effective source record", () => {
  const screenLogicalQuestion = {
    id: "question-screen",
    revision: 1,
    sessionId: "session-a",
    runtimeEpoch: 3,
    currentTurnId: "screen:observation-screen",
    sourceTurnIds: [],
    sources: [
      {
        turnId: "screen:observation-screen",
        text: "Design a parking reservation system.",
        startedAt: 10,
        endedAt: 15,
      },
    ],
    normalizedText: "Design a parking reservation system.",
    restoredAnswerFocusText: "Design a parking reservation system.",
    startedAt: 10,
    updatedAt: 15,
    compositionReasons: ["visible-answer-effective-source-record"],
    boundaryReason: "visible-answer-effective-source-record" as const,
    truncated: false,
  };
  const screenSourceHash = createProvisionalCurrentQuestion({
    logicalQuestionUnit: screenLogicalQuestion,
    sourceKind: "screen",
    sourceObservationIds: ["observation-screen"],
  }).sourceHash;
  const screenSettlement = {
    ...frozenSettlement,
    settlementId: "settlement-screen",
    logicalQuestionUnitId: "question-screen",
    revision: 1,
    sourceKind: "screen" as const,
    sourceTurnIds: [],
    sourceObservationIds: ["observation-screen"],
    sourceHash: screenSourceHash,
  } satisfies CurrentQuestionSettlementDecision;
  const screenStable = {
    ...stable,
    logicalQuestionUnitId: "question-screen",
    logicalQuestionRevision: 1,
    questionSourceHash: screenSourceHash,
    settlementId: "settlement-screen",
    settlementSnapshot: screenSettlement,
    suggestion: {
      ...stable.suggestion,
      basedOnTurnIds: ["turn-voice"],
      basedOnObservationIds: ["observation-screen"],
    },
  } satisfies StableAnswerRevision;
  const decision = resolveVisibleAnswerResponseActionTarget({
    stableAnswer: screenStable,
    currentLogicalQuestionUnit: undefined,
    effectiveQuestionSources: [
      {
        ...effectiveVoiceRecord(),
        recordId: "source-record-screen",
        logicalQuestionUnitId: "question-screen",
        logicalQuestionRevision: 1,
        sourceHash: screenSourceHash,
        sourceKind: "screen",
        currentTurnId: "screen:observation-screen",
        sourceTurnIds: [],
        sourceObservationIds: ["observation-screen"],
        contextSourceTurnIds: [],
        recentLogicalQuestionSourceTurnIds: [],
        effectiveSourceTexts: [
          {
            turnId: "screen:observation-screen",
            text: "Design a parking reservation system.",
          },
        ],
        text: "Design a parking reservation system.",
        answerFocusText: "Design a parking reservation system.",
      },
    ],
    meetingContext: context(),
    runtimeEpoch: 3,
  });

  assert.equal(decision.authorized, true);
  assert.equal(
    decision.logicalQuestionUnit?.normalizedText,
    "Design a parking reservation system."
  );
  assert.equal(decision.sourceKind, "screen");
  assert.deepEqual(decision.sourceObservationIds, ["observation-screen"]);
  assert.equal(decision.sourceRecordId, "source-record-screen");
});

test("projects the exact active-child owner from the effective source record", () => {
  const decision = resolveVisibleAnswerResponseActionTarget({
    stableAnswer: stable,
    currentLogicalQuestionUnit: undefined,
    effectiveQuestionSources: [
      {
        ...effectiveVoiceRecord(),
        owner: {
          kind: "active-child",
          parentId: "parent-a",
          childId: "child-code",
        },
      },
    ],
    meetingContext: context(),
    runtimeEpoch: 3,
  });

  assert.deepEqual(decision.sourceOwner, {
    kind: "active-child",
    parentId: "parent-a",
    childId: "child-code",
  });
});

test("rejects a visible answer whose exact effective source is unavailable", () => {
  const decision = resolveVisibleAnswerResponseActionTarget({
    stableAnswer: stable,
    currentLogicalQuestionUnit: undefined,
    effectiveQuestionSources: [],
    meetingContext: context(),
    runtimeEpoch: 3,
  });

  assert.equal(decision.authorized, false);
  assert.equal(decision.reason, "visible-answer-effective-source-missing");
});

test("rejects an Enhance target after the visible owner parent changes", () => {
  const decision = resolveVisibleAnswerResponseActionTarget({
    stableAnswer: stable,
    meetingContext: context("parent-new"),
    runtimeEpoch: 3,
  });

  assert.equal(decision.authorized, false);
  assert.equal(decision.reason, "visible-answer-parent-changed");
  assert.deepEqual(decision.mismatchFacets, ["parent"]);
});

test("Narrow and Enhance consume the visible Answer settlement snapshot", () => {
  const source = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
  const start = source.indexOf(
    'responseAction === "narrow-context" ||'
  );
  const end = source.indexOf(
    'recordResponseAction({\n        stage: "accepted"',
    start
  );
  const responseActionSource = source.slice(start, end);

  assert.match(
    responseActionSource,
    /const committedSettlement = targetDecision\.settlementSnapshot;/
  );
  assert.doesNotMatch(
    responseActionSource,
    /settlement: currentQuestionSettlementRef\.current/
  );
});
