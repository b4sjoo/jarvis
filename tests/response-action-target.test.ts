import type { MeetingContextState } from "../src/lib/meeting/meeting-context-contracts.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveResponseActionLogicalQuestionUnit, resolveVisibleAnswerResponseActionTarget } from "../src/lib/meeting/response-action-target.js";
import { getLogicalQuestionAnswerFocusText } from "../src/lib/meeting/logical-question-unit.js";
import { resolveAuthorizedEffectiveSourceContext } from "../src/lib/meeting/authorized-effective-source-context.js";
import type { StableAnswerRevision } from "../src/lib/meeting/stable-answer.js";

import {
  createProvisionalCurrentQuestion,
  type CurrentQuestionSettlementDecision,
} from "../src/lib/meeting/current-question-settlement.js";
import {
  createEffectiveQuestionSourceRecord,
  type EffectiveQuestionSourceRecord,
} from "../src/lib/meeting/effective-question-source-ledger.js";

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

for (const sourceKind of ["voice", "screen", "mixed"] as const) {
  test(`PC4 historical ${sourceKind} visible target preserves birth epoch, hash and provenance`, () => {
    const sourceObservationIds = sourceKind === "voice" ? [] : ["screen-observation"];
    const sourceHash = createProvisionalCurrentQuestion({ logicalQuestionUnit: voiceLogicalQuestion,
      sourceKind, sourceObservationIds }).sourceHash;
    const record = { ...effectiveVoiceRecord(), sourceKind, sourceObservationIds, sourceHash };
    const settlement = { ...frozenSettlement, sourceKind, sourceObservationIds, sourceHash };
    const original = structuredClone(record);
    for (const currentLogicalQuestionUnit of [undefined, voiceLogicalQuestion]) {
      // A regenerated answer can have a newer execution epoch than its source.
      for (const answerEpoch of [3, 4]) {
        const decision = resolveVisibleAnswerResponseActionTarget({
          stableAnswer: { ...stable, runtimeEpoch: answerEpoch, questionSourceHash: sourceHash, settlementSnapshot: settlement },
          currentLogicalQuestionUnit, effectiveQuestionSources: [record], meetingContext: context(), runtimeEpoch: 5,
        });
        assert.equal(decision.authorized, true, decision.reason);
        assert.equal(decision.logicalQuestionUnit?.runtimeEpoch, 3);
        assert.equal(decision.logicalQuestionUnit?.revision, 2);
        assert.equal(decision.logicalQuestionUnit?.id, voiceLogicalQuestion.id);
        assert.equal(decision.sourceRecordId, record.recordId);
        assert.equal(decision.sourceHash, sourceHash);
        assert.equal(decision.sourceKind, sourceKind);
        assert.deepEqual(decision.sourceObservationIds, sourceObservationIds);
        assert.equal(decision.settlementSnapshot, settlement);
        assert.equal(createProvisionalCurrentQuestion({ logicalQuestionUnit: decision.logicalQuestionUnit!,
          sourceKind, sourceObservationIds }).sourceHash, sourceHash);
      }
    }
    assert.deepEqual(record, original);
  });
}

test("PC4 retained exact parentless Voice target remains available after Pause", () => {
  const meetingContext = { ...context(), activeMeetingTask: undefined };
  const stableAnswer = { ...stable, taskId: null };
  const input = { stableAnswer, currentLogicalQuestionUnit: voiceLogicalQuestion,
    effectiveQuestionSources: [], meetingContext, runtimeEpoch: 5 };
  const decision = resolveVisibleAnswerResponseActionTarget(input);
  assert.equal(decision.authorized, true);
  assert.equal(decision.logicalQuestionUnit, voiceLogicalQuestion);
  assert.equal(decision.logicalQuestionUnit.runtimeEpoch, 3);
  for (const currentLogicalQuestionUnit of [
    { ...voiceLogicalQuestion, runtimeEpoch: 6 },
    { ...voiceLogicalQuestion, runtimeEpoch: 4 },
    { ...voiceLogicalQuestion, sessionId: "new-session" },
    { ...voiceLogicalQuestion, revision: 3 },
    { ...voiceLogicalQuestion, normalizedText: "A different source." },
  ]) {
    assert.equal(resolveVisibleAnswerResponseActionTarget({ ...input, currentLogicalQuestionUnit }).authorized, false);
  }
  assert.equal(resolveVisibleAnswerResponseActionTarget({ ...input, stableAnswer: { ...stableAnswer,
    settlementSnapshot: { ...frozenSettlement, sourceKind: "screen" } } }).authorized, false);
  assert.equal(resolveVisibleAnswerResponseActionTarget({ ...input, stableAnswer: { ...stableAnswer,
    taskId: "retired-parent" } }).authorized, false);
});

test("PC4 Correction and phase source selection preserve historical source identity", () => {
  const input = { currentLogicalQuestionUnit: voiceLogicalQuestion, effectiveQuestionSources: [effectiveVoiceRecord()],
    meetingContext: context(), runtimeEpoch: 5, preferScreen: false };
  assert.equal(resolveResponseActionLogicalQuestionUnit(input), voiceLogicalQuestion);
  for (const currentLogicalQuestionUnit of [undefined, voiceLogicalQuestion]) {
    const phaseTarget = resolveResponseActionLogicalQuestionUnit({ ...input, currentLogicalQuestionUnit,
      phaseOwner: { kind: "parent", id: "parent-a" } });
    assert.equal(phaseTarget?.runtimeEpoch, 3);
    assert.equal(phaseTarget?.id, voiceLogicalQuestion.id);
    assert.equal(phaseTarget?.revision, voiceLogicalQuestion.revision);
    assert.equal(createProvisionalCurrentQuestion({ logicalQuestionUnit: phaseTarget!, sourceKind: "voice" }).sourceHash, voiceSourceHash);
  }
  assert.equal(resolveResponseActionLogicalQuestionUnit({ ...input, phaseOwner: { kind: "parent", id: "retired" } }), undefined);
  assert.equal(resolveResponseActionLogicalQuestionUnit({ ...input, phaseOwner: { kind: "parent", id: "parent-a" },
    currentLogicalQuestionUnit: { ...voiceLogicalQuestion, revision: 3 } }), undefined);
});

test("PC5 historical manual targets reject future, foreign, superseded and retired sources", () => {
  const record = effectiveVoiceRecord();
  const input = { stableAnswer: stable, currentLogicalQuestionUnit: voiceLogicalQuestion,
    effectiveQuestionSources: [record], meetingContext: context(), runtimeEpoch: 5 };
  const futureStable = resolveVisibleAnswerResponseActionTarget({ ...input, stableAnswer: { ...stable, runtimeEpoch: 6 } });
  assert.equal(futureStable.reason, "visible-answer-runtime-epoch-mismatch");
  for (const patch of [
    { runtimeEpoch: 6 }, { runtimeEpoch: 4 }, { sessionId: "other-session" },
    { sourceHash: "different-hash" }, { logicalQuestionRevision: 3 },
    { owner: { kind: "parent-mainline" as const, parentId: "retired-parent" } },
    { owner: { kind: "active-child" as const, parentId: "parent-a", childId: "retired-child" } },
  ]) {
    const invalidRecord = { ...record, ...patch };
    assert.equal(resolveVisibleAnswerResponseActionTarget({ ...input, effectiveQuestionSources: [invalidRecord] }).authorized, false,
      JSON.stringify(patch));
    if (!("sourceHash" in patch)) {
      assert.equal(resolveResponseActionLogicalQuestionUnit({ ...input, effectiveQuestionSources: [invalidRecord], preferScreen: false }), undefined,
        JSON.stringify(patch));
    }
  }
  const superseding = { ...record, recordId: "later-owner", settledAt: record.settledAt + 1,
    owner: { kind: "active-child" as const, parentId: "parent-a", childId: "retired-child" } };
  assert.equal(resolveVisibleAnswerResponseActionTarget({ ...input, effectiveQuestionSources: [record, superseding] }).authorized, false);
  assert.equal(resolveResponseActionLogicalQuestionUnit({ ...input, effectiveQuestionSources: [record, superseding], preferScreen: false }), undefined);
  assert.equal(resolveVisibleAnswerResponseActionTarget({ ...input, effectiveQuestionSources: [] }).authorized, false);
  assert.equal(resolveVisibleAnswerResponseActionTarget({ ...input, meetingContext: { ...context(), activeMeetingTask: undefined } }).authorized, false);
});

test("preserves term-correction provenance through visible-source reconstruction and rewrite", () => {
  const correctedLogicalQuestion = {
    ...voiceLogicalQuestion,
    normalizedText: "Design a RAG system for document retrieval.",
    restoredAnswerFocusText: "Design a RAG system for document retrieval.",
    sources: [
      {
        turnId: "turn-voice",
        text: "Design a RAG system for document retrieval.",
        startedAt: 10,
        endedAt: 15,
      },
    ],
  };
  const correctedSourceHash = createProvisionalCurrentQuestion({
    logicalQuestionUnit: correctedLogicalQuestion,
    sourceKind: "voice",
  }).sourceHash;
  const correctedSettlement = {
    ...frozenSettlement,
    settlementId: "settlement-rag",
    sourceHash: correctedSourceHash,
    questionType: "ai-ml-system-design",
    effective: true,
    effectiveRevision: 1,
    rawQuestionType: "ai-ml-system-design",
    rawRelation: "followup-parent",
    nullHypothesisApplied: false,
    effectiveParentId: "parent-a",
    effectiveParentRevision: 1,
  } as const;
  const correctedStable = {
    ...stable,
    questionSourceHash: correctedSourceHash,
    settlementId: correctedSettlement.settlementId,
    settlementSnapshot: correctedSettlement,
  };
  const correctedRecord: EffectiveQuestionSourceRecord = {
    ...effectiveVoiceRecord(),
    recordId: "source-record-rag",
    sourceHash: correctedSourceHash,
    correctionIds: ["correction-rag"],
    effectiveSourceTexts: [
      {
        turnId: "turn-voice",
        text: "Design a RAG system for document retrieval.",
      },
    ],
    text: "Design a RAG system for document retrieval.",
    answerFocusText: "Design a RAG system for document retrieval.",
  };
  const meetingContext = context();
  meetingContext.transcriptTurns[0].text =
    "Design a car-sharing system for document retrieval.";
  const decision = resolveVisibleAnswerResponseActionTarget({
    stableAnswer: correctedStable,
    currentLogicalQuestionUnit: undefined,
    effectiveQuestionSources: [correctedRecord],
    meetingContext,
    runtimeEpoch: 3,
  });

  assert.equal(decision.authorized, true);
  assert.deepEqual(
    decision.logicalQuestionUnit?.sources[0]?.appliedSpeechCorrectionIds,
    ["correction-rag"]
  );
  const { transcriptProjection: transcript } = resolveAuthorizedEffectiveSourceContext({
    transcriptTurns: meetingContext.transcriptTurns,
    selectedSourceTurnIds: decision.logicalQuestionUnit!.sourceTurnIds,
    logicalQuestionUnit: decision.logicalQuestionUnit,
    sessionId: "session-a",
    runtimeEpoch: 3,
  });
  assert.match(transcript.transcript, /RAG system/);
  assert.doesNotMatch(transcript.transcript, /car-sharing system/);
  assert.deepEqual(transcript.correctionIds, ["correction-rag"]);

  const rewritten = createEffectiveQuestionSourceRecord({
    logicalQuestionUnit: decision.logicalQuestionUnit!,
    settlement: correctedSettlement,
    activeMeetingTask: meetingContext.activeMeetingTask,
    settledAt: 30,
  });
  assert.deepEqual(rewritten?.correctionIds, ["correction-rag"]);
  assert.equal(
    rewritten?.effectiveSourceTexts?.[0]?.text,
    "Design a RAG system for document retrieval."
  );
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
  const meetingContext = context();
  meetingContext.activeMeetingTask!.child = {
    id: "child-code", questionType: "coding", relation: "child-probe",
    question: "Implement the window.", intent: "implementation-probe",
    basedOnTurnIds: ["turn-voice"], basedOnObservationIds: [],
    createdAt: 1, updatedAt: 2,
  };
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
    meetingContext,
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
