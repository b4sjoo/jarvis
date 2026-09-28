import type { ActiveMeetingTask } from "../src/lib/meeting/meeting-task-contracts.js";
import assert from "node:assert/strict";
import test from "node:test";

import type { EffectiveCurrentQuestionSettlement } from "../src/lib/meeting/current-question-settlement.js";
import {
  consumeRevisionStableTopologyBinding,
  createEffectiveQuestionSourceRecord,
  EffectiveQuestionSourceLedger,
  resolveRevisionStableTopologyBinding,
  selectLatestEffectiveQuestionSourceRecords,
  selectOwnerScopedRelationEvidence,
  type EffectiveQuestionSourceRecord,
} from "../src/lib/meeting/effective-question-source-ledger.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import type { TranscriptTurn } from "../src/lib/meeting/types.js";

function unit(id: string, turnId: string, text: string, at: number): LogicalQuestionUnit {
  return {
    id,
    revision: 1,
    sessionId: "session-a",
    runtimeEpoch: 3,
    currentTurnId: turnId,
    sourceTurnIds: [turnId],
    sources: [{ turnId, text, startedAt: at, endedAt: at + 10 }],
    normalizedText: text,
    startedAt: at,
    updatedAt: at + 10,
    compositionReasons: ["independent-current-turn"],
    boundaryReason: "independent-current-turn",
    truncated: false,
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
      topic: "Design a production RAG system",
      playbookPhase: "project_QA",
      phaseProgress: {},
      canonicalQuestionSourceTurnIds: ["turn-parent-root"],
      startTurnId: "turn-parent-root",
      promptTranscriptStartTurnId: "turn-parent-root",
      supportedFactAnchors: [],
      createdAt: 1,
      updatedAt: 1,
      revisions: 4,
    },
    child: {
      id: "child-hnsw",
      createdAt: 20,
      updatedAt: 20,
      questionType: "field-knowledge",
      relation: "child-probe",
      intent: "concept-probe",
      question: "Explain HNSW.",
      basedOnTurnIds: ["turn-child-root"],
      basedOnObservationIds: [],
    },
  };
}

function effective(
  relation: EffectiveCurrentQuestionSettlement["relation"]
): EffectiveCurrentQuestionSettlement {
  return {
    settlementId: `settlement-${relation}`,
    logicalQuestionUnitId: "lqu",
    revision: 1,
    sessionId: "session-a",
    runtimeEpoch: 3,
    sourceKind: "voice",
    sourceTurnIds: [],
    sourceObservationIds: [],
    sourceHash: `hash-${relation}`,
    questionType: "field-knowledge",
    relation,
    action: "answer",
    evidenceMode: "unknown",
    authority: "provisional-only",
    authoritySource: "provisional-only",
    typeAuthoritySource: "provisional",
    relationAuthoritySource: "provisional",
    actionAuthoritySource: "provisional",
    typeMutationAuthorized: false,
    relationMutationAuthorized: false,
    parentMutationAuthorized: false,
    responseAuthorized: true,
    confidence: 0,
    manualCorrectionRevision: 0,
    rejectedProposals: [],
    reasons: [],
    effective: true,
    effectiveRevision: 4,
    rawQuestionType: "unknown",
    rawRelation: "unknown",
    nullHypothesisApplied: true,
    nullHypothesisReason:
      relation === "child-probe"
        ? "active-child-preserved"
        : "active-parent-preserved",
    effectiveParentId: "parent-rag",
    effectiveParentRevision: 4,
    effectiveChildId:
      relation === "child-probe" ? "child-hnsw" : undefined,
  };
}

function turn(id: string, text: string, at: number): TranscriptTurn {
  return {
    id,
    speaker: "them",
    text,
    startedAt: at,
    endedAt: at + 5,
    isFinal: true,
    source: "system-audio",
  };
}

test("keeps a parent-origin relation stable across LQU revisions", () => {
  const activeTask = task();
  activeTask.parent.sourceQuestionUnitId = "lqu-parent";
  activeTask.parent.sourceQuestionRevision = 1;
  const revised = {
    ...unit("lqu-parent", "turn-parent-root", "Design a RAG system.", 100),
    revision: 4,
  };

  assert.deepEqual(
    resolveRevisionStableTopologyBinding({
      records: [],
      logicalQuestionUnit: revised,
      activeMeetingTask: activeTask,
    }),
    {
      relation: "new-parent",
      owner: { kind: "parent-mainline", parentId: "parent-rag" },
      source: "active-parent-origin",
      boundRevision: 1,
    }
  );
});

test("consumes a stable parent-origin relation on an existing settlement", () => {
  const revised = {
    ...unit("lqu-parent", "turn-parent-root", "Design a RAG system.", 100),
    revision: 4,
  };
  const settlement = {
    ...effective("followup-parent"),
    logicalQuestionUnitId: revised.id,
    revision: revised.revision,
    rawRelation: "followup-parent" as const,
    relationAuthoritySource: "runtime-adjudication" as const,
    relationMutationAuthorized: true,
    parentMutationAuthorized: true,
  };
  const result = consumeRevisionStableTopologyBinding({
    settlement,
    binding: {
      relation: "new-parent",
      owner: { kind: "parent-mainline", parentId: "parent-rag" },
      source: "active-parent-origin",
      boundRevision: 1,
    },
    logicalQuestionUnit: revised,
  });

  assert.equal(result.consumed, true);
  assert.equal(result.previousRelation, "followup-parent");
  assert.equal(result.settlement.relation, "new-parent");
  assert.equal(result.settlement.rawRelation, "followup-parent");
  assert.equal(
    result.settlement.relationAuthoritySource,
    "deterministic-fast-path"
  );
  assert.equal(result.settlement.parentMutationAuthorized, false);
  assert.equal(result.settlement.questionType, settlement.questionType);
  assert.equal(result.settlement.action, settlement.action);
  assert.equal(result.settlement.settlementId, settlement.settlementId);
});

test("does not consume a stable relation across settlement identity", () => {
  const revised = {
    ...unit("lqu-parent", "turn-parent-root", "Design a RAG system.", 100),
    revision: 4,
  };
  const settlement = {
    ...effective("followup-parent"),
    logicalQuestionUnitId: revised.id,
    revision: 3,
  };
  const result = consumeRevisionStableTopologyBinding({
    settlement,
    binding: {
      relation: "new-parent",
      owner: { kind: "parent-mainline", parentId: "parent-rag" },
      source: "effective-question-source-ledger",
      boundRevision: 1,
    },
    logicalQuestionUnit: revised,
  });

  assert.equal(result.consumed, false);
  assert.equal(result.reason, "settlement-identity-mismatch");
  assert.equal(result.settlement, settlement);
});

test("reuses the prior owner relation without treating revision as a boundary", () => {
  const activeTask = task();
  const revised = {
    ...unit("lqu-followup", "turn-followup", "What would you monitor?", 100),
    revision: 2,
  };
  const prior = record({
    recordId: "record-followup-revision-1",
    logicalQuestionUnitId: revised.id,
    logicalQuestionRevision: 1,
    relation: "followup-parent",
    owner: { kind: "parent-mainline", parentId: "parent-rag" },
  });

  assert.equal(
    resolveRevisionStableTopologyBinding({
      records: [prior],
      logicalQuestionUnit: revised,
      activeMeetingTask: activeTask,
    })?.relation,
    "followup-parent"
  );
});

test("keeps a child-origin revision on the same active child", () => {
  const activeTask = task();
  const revised = {
    ...unit("lqu-child", "turn-child-root", "Explain HNSW.", 100),
    revision: 3,
  };

  assert.deepEqual(
    resolveRevisionStableTopologyBinding({
      records: [],
      logicalQuestionUnit: revised,
      activeMeetingTask: activeTask,
    }),
    {
      relation: "child-probe",
      owner: {
        kind: "active-child",
        parentId: "parent-rag",
        childId: "child-hnsw",
      },
      source: "active-child-origin",
      boundRevision: 3,
    }
  );
});

test("does not revive a binding whose durable owner is no longer active", () => {
  const activeTask = task();
  const revised = {
    ...unit("lqu-old-child", "turn-new", "Explain the latest code.", 100),
    revision: 2,
  };
  const prior = record({
    recordId: "record-old-child",
    logicalQuestionUnitId: revised.id,
    logicalQuestionRevision: 1,
    relation: "child-probe",
    owner: {
      kind: "active-child",
      parentId: "parent-rag",
      childId: "child-replaced",
    },
  });

  assert.equal(
    resolveRevisionStableTopologyBinding({
      records: [prior],
      logicalQuestionUnit: revised,
      activeMeetingTask: activeTask,
    }),
    undefined
  );
});

test("does not fall back to an older revision after the winning child owner retires", () => {
  const activeTask = task();
  activeTask.child = undefined;
  const revised = {
    ...unit("lqu-rebound", "turn-current", "Continue the explanation.", 100),
    revision: 3,
  };
  activeTask.parent.sourceQuestionUnitId = revised.id;
  activeTask.parent.sourceQuestionRevision = 1;
  const parentRevision: EffectiveQuestionSourceRecord = record({
    recordId: "record-parent-revision-1",
    logicalQuestionUnitId: revised.id,
    logicalQuestionRevision: 1,
    relation: "followup-parent",
    owner: { kind: "parent-mainline", parentId: "parent-rag" },
  });
  const childRevision: EffectiveQuestionSourceRecord = record({
    recordId: "record-child-revision-2",
    logicalQuestionUnitId: revised.id,
    logicalQuestionRevision: 2,
    relation: "child-probe",
    owner: {
      kind: "active-child",
      parentId: "parent-rag",
      childId: "child-hnsw",
    },
  });

  assert.equal(
    resolveRevisionStableTopologyBinding({
      records: [parentRevision, childRevision],
      logicalQuestionUnit: revised,
      activeMeetingTask: activeTask,
    }),
    undefined
  );
});

test("records only source-owned effective LQU projections", () => {
  const ledger = new EffectiveQuestionSourceLedger(2);
  const record = createEffectiveQuestionSourceRecord({
    logicalQuestionUnit: unit(
      "lqu-child",
      "turn-child-detail",
      "How does efSearch affect recall?",
      30
    ),
    settlement: effective("child-probe"),
    activeMeetingTask: task(),
    settledAt: 40,
  });
  assert.ok(record);
  assert.equal(record.owner.kind, "active-child");
  assert.equal(
    record.owner.kind === "active-child" ? record.owner.childId : undefined,
    "child-hnsw"
  );
  assert.equal(record.currentTurnId, "turn-child-detail");
  assert.equal(record.answerFocusText, "How does efSearch affect recall?");
  assert.deepEqual(record.contextSourceTurnIds, []);
  assert.deepEqual(record.recentLogicalQuestionSourceTurnIds, []);
  ledger.upsert(record);
  ledger.upsert(record);
  assert.equal(ledger.list().length, 1);
});

test("records Screen observation identity in the shared effective source ledger", () => {
  const activeTask = task();
  activeTask.child = undefined;
  activeTask.source = "screen";
  const screenUnit: LogicalQuestionUnit = {
    ...unit(
      "screen-answer-sufficiency:screen-1",
      "screen:screen-1",
      "Design a URL shortener.",
      100
    ),
    sourceTurnIds: [],
  };
  const settlement: EffectiveCurrentQuestionSettlement = {
    ...effective("new-parent"),
    logicalQuestionUnitId: screenUnit.id,
    sourceKind: "screen",
    sourceTurnIds: [],
    sourceObservationIds: ["screen-1"],
  };

  const record = createEffectiveQuestionSourceRecord({
    logicalQuestionUnit: screenUnit,
    settlement,
    activeMeetingTask: activeTask,
    settledAt: 120,
  });

  assert.equal(record?.sourceKind, "screen");
  assert.deepEqual(record?.sourceTurnIds, []);
  assert.deepEqual(record?.sourceObservationIds, ["screen-1"]);
  assert.equal(record?.currentTurnId, "screen:screen-1");
  assert.equal(record?.answerFocusText, "Design a URL shortener.");
  assert.equal(record?.owner.kind, "parent-mainline");
});

test("uses a Screen observation timestamp as the raw transcript boundary", () => {
  const activeTask = task();
  activeTask.child = undefined;
  activeTask.parent.canonicalQuestionSourceTurnIds = [];
  activeTask.parent.startTurnId = undefined;
  activeTask.parent.promptTranscriptStartTurnId = undefined;
  const current = unit(
    "lqu-current-after-screen",
    "turn-current-after-screen",
    "What should we monitor?",
    200
  );
  const selection = selectOwnerScopedRelationEvidence({
    records: [
      record({
        recordId: "record-screen-parent",
        logicalQuestionUnitId: "screen-parent",
        sourceKind: "screen",
        sourceTurnIds: [],
        sourceObservationIds: ["screen-1"],
        text: "Design a URL shortener.",
        updatedAt: 100,
        settledAt: 101,
        owner: { kind: "parent-mainline", parentId: "parent-rag" },
      }),
    ],
    currentLogicalQuestionUnit: current,
    activeMeetingTask: activeTask,
    transcriptTurns: [
      turn("turn-before-screen", "Discuss an unrelated coding problem.", 20),
      turn("turn-after-screen", "The service spans three regions.", 150),
      turn(
        "turn-current-after-screen",
        "What should we monitor?",
        200
      ),
    ],
  });
  const parentText = selection.recentParentEvidence
    .map((evidence) => evidence.text)
    .join(" ");

  assert.doesNotMatch(parentText, /unrelated coding/i);
  assert.match(parentText, /three regions/i);
  assert.equal(
    selection.recentParentEvidence.some(
      (evidence) => evidence.sourceObservationIds[0] === "screen-1"
    ),
    true
  );
});

test("does not let a retired child Screen prune resumed parent evidence", () => {
  const activeTask = task();
  activeTask.child = undefined;
  activeTask.parent.canonicalQuestionSourceTurnIds = [];
  activeTask.parent.startTurnId = undefined;
  activeTask.parent.promptTranscriptStartTurnId = undefined;
  const current = unit(
    "lqu-current-after-resume",
    "turn-current-after-resume",
    "What would you monitor next?",
    400
  );
  const selection = selectOwnerScopedRelationEvidence({
    records: [
      record({
        recordId: "record-screen-parent",
        logicalQuestionUnitId: "screen-parent",
        sourceKind: "screen",
        sourceTurnIds: [],
        sourceObservationIds: ["screen-parent"],
        text: "Design a production RAG system.",
        updatedAt: 100,
        settledAt: 101,
        owner: { kind: "parent-mainline", parentId: "parent-rag" },
      }),
      record({
        recordId: "record-retired-child-screen",
        logicalQuestionUnitId: "screen-retired-child",
        sourceKind: "screen",
        sourceTurnIds: [],
        sourceObservationIds: ["screen-retired-child"],
        text: "Implement the retrieval helper.",
        updatedAt: 300,
        settledAt: 301,
        owner: {
          kind: "active-child",
          parentId: "parent-rag",
          childId: "child-retired",
        },
      }),
    ],
    currentLogicalQuestionUnit: current,
    activeMeetingTask: activeTask,
    transcriptTurns: [
      turn("turn-before-parent-screen", "Old unrelated task.", 20),
      turn(
        "turn-parent-after-screen",
        "The RAG service runs in three regions.",
        200
      ),
      turn(
        "turn-current-after-resume",
        "What would you monitor next?",
        400
      ),
    ],
  });
  const parentText = selection.recentParentEvidence
    .map((evidence) => evidence.text)
    .join(" ");

  assert.doesNotMatch(parentText, /Old unrelated task/i);
  assert.match(parentText, /three regions/i);
  assert.doesNotMatch(parentText, /retrieval helper/i);
});

test("selects LQU-first evidence without acknowledgement or logistics", () => {
  const records: EffectiveQuestionSourceRecord[] = [
    {
      recordId: "record-parent",
      sessionId: "session-a",
      runtimeEpoch: 3,
      logicalQuestionUnitId: "lqu-parent",
      logicalQuestionRevision: 1,
      sourceHash: "hash-parent",
      sourceTurnIds: ["turn-parent-detail"],
      text: "Documents change continuously.",
      startedAt: 10,
      updatedAt: 15,
      speechAct: "informational",
      disposition: "append-setup",
      relation: "followup-parent",
      owner: { kind: "parent-mainline", parentId: "parent-rag" },
      settledAt: 16,
    },
    {
      recordId: "record-child",
      sessionId: "session-a",
      runtimeEpoch: 3,
      logicalQuestionUnitId: "lqu-child",
      logicalQuestionRevision: 1,
      sourceHash: "hash-child",
      sourceTurnIds: ["turn-child-detail"],
      text: "How does efSearch affect recall?",
      startedAt: 30,
      updatedAt: 35,
      speechAct: "question",
      disposition: "answer-primary-ask",
      relation: "child-probe",
      owner: {
        kind: "active-child",
        parentId: "parent-rag",
        childId: "child-hnsw",
      },
      settledAt: 36,
    },
    {
      recordId: "record-logistics",
      sessionId: "session-a",
      runtimeEpoch: 3,
      logicalQuestionUnitId: "lqu-logistics",
      logicalQuestionRevision: 1,
      sourceHash: "hash-logistics",
      sourceTurnIds: ["turn-logistics"],
      text: "Give me a second while I share my screen.",
      startedAt: 40,
      updatedAt: 45,
      speechAct: "logistics",
      disposition: "append-setup",
      relation: "followup-parent",
      owner: { kind: "parent-mainline", parentId: "parent-rag" },
      settledAt: 46,
    },
  ];
  const current = unit(
    "lqu-current",
    "turn-current",
    "Back to the RAG system, what should we monitor?",
    60
  );
  const selection = selectOwnerScopedRelationEvidence({
    records,
    currentLogicalQuestionUnit: current,
    activeMeetingTask: task(),
    transcriptTurns: [
      turn("turn-parent-root", "Design a production RAG system.", 0),
      turn("turn-parent-detail", "Documents change continuously.", 10),
      turn("turn-child-root", "Explain HNSW.", 20),
      turn("turn-child-detail", "How does efSearch affect recall?", 30),
      turn("turn-ack", "Mm-hmm.", 40),
      turn("turn-logistics", "Give me a second while I share my screen.", 45),
      turn("turn-current", current.normalizedText, 60),
    ],
  });

  assert.deepEqual(
    selection.recentBranchEvidence.map((item) => item.text),
    ["How does efSearch affect recall?"]
  );
  assert.deepEqual(
    selection.recentParentEvidence.map((item) => item.text),
    ["Documents change continuously."]
  );
  assert.equal(selection.diagnostics.lquSelectedCount, 2);
  assert.equal(selection.diagnostics.acknowledgementExcludedCount, 1);
  assert.equal(selection.diagnostics.logisticsExcludedCount, 1);
  assert.equal(selection.diagnostics.rawSupplementCount, 0);
});

test("finds one exact committed Voice source for later Screen linkage", () => {
  const ledger = new EffectiveQuestionSourceLedger();
  const record: EffectiveQuestionSourceRecord = {
    recordId: "record-lines",
    sessionId: "session-a",
    runtimeEpoch: 3,
    logicalQuestionUnitId: "lqu-lines",
    logicalQuestionRevision: 2,
    sourceHash: "hash-lines",
    sourceTurnIds: ["turn-lines"],
    text: "Explain lines 35 through 38.",
    startedAt: 10,
    updatedAt: 20,
    speechAct: "directive",
    disposition: "answer-primary-ask",
    relation: "none",
    owner: { kind: "parent-mainline", parentId: "parent-code" },
    settledAt: 30,
  };
  ledger.upsert(record);

  const found = ledger.findLogicalQuestion({
    sessionId: "session-a",
    runtimeEpoch: 3,
    logicalQuestionUnitId: "lqu-lines",
    logicalQuestionRevision: 2,
  });
  assert.equal(found?.sourceHash, "hash-lines");
  assert.notEqual(found, record);
  assert.equal(
    ledger.findLogicalQuestion({
      sessionId: "session-a",
      runtimeEpoch: 3,
      logicalQuestionUnitId: "lqu-lines",
      logicalQuestionRevision: 3,
    }),
    undefined
  );
});

test("PC4 ledger lookup uses the execution ceiling and preserves latest source identity", () => {
  const ledger = new EffectiveQuestionSourceLedger();
  const first = record({ recordId: "first" });
  const latest = record({ recordId: "latest", logicalQuestionRevision: 2, sourceHash: "hash-latest" });
  ledger.upsert(first);
  ledger.upsert(latest);
  const history = ledger.listHistory();
  const input = { sessionId: latest.sessionId, logicalQuestionUnitId: latest.logicalQuestionUnitId,
    logicalQuestionRevision: latest.logicalQuestionRevision };
  for (const runtimeEpoch of [3, 4, 5]) {
    assert.deepEqual(ledger.findLogicalQuestion({ ...input, runtimeEpoch }), history[1]);
    assert.equal(ledger.findLogicalQuestion({ ...input, runtimeEpoch, logicalQuestionRevision: 1 }), undefined);
  }
  assert.equal(ledger.findLogicalQuestion({ ...input, runtimeEpoch: 2 }), undefined);
  assert.equal(ledger.findLogicalQuestion({ ...input, runtimeEpoch: 5, sessionId: "new-session" }), undefined);
  assert.deepEqual(ledger.listHistory(), history);
  ledger.clear();
  assert.equal(ledger.findLogicalQuestion({ ...input, runtimeEpoch: 5 }), undefined);
});

test("PC3 Relation retains historical parent and child revisions without widening branch scope", () => {
  const parent = record({ recordId: "parent", logicalQuestionUnitId: "parent-origin", sourceTurnIds: ["turn-parent-root"],
    text: "Design a RAG system.", owner: { kind: "parent-mainline", parentId: "parent-rag" } });
  const child = record({ recordId: "child-r1", logicalQuestionUnitId: "child-origin", sourceTurnIds: ["turn-child-root"],
    text: "Explain HNSW.", owner: { kind: "active-child", parentId: "parent-rag", childId: "child-hnsw" } });
  const revisedChild = { ...child, recordId: "child-r2", logicalQuestionRevision: 2, text: "Explain HNSW recall." };
  const current = { ...unit("current", "current-turn", "What would you monitor?", 100), runtimeEpoch: 5 };
  const activeTask = task();
  const input = { records: [parent, child, revisedChild], currentLogicalQuestionUnit: current, activeMeetingTask: activeTask,
    transcriptTurns: [turn("turn-parent-root", parent.text, 1), turn("turn-child-root", child.text, 2)] };
  const selected = selectOwnerScopedRelationEvidence(input);
  assert.deepEqual(selected.recentParentEvidence.map((source) => source.text), [parent.text]);
  assert.deepEqual(selected.recentBranchEvidence.map((source) => source.text), [revisedChild.text]);
  assert.equal(selected.diagnostics.rawSupplementCount, 0);
  const resumed = selectOwnerScopedRelationEvidence({ ...input, activeMeetingTask: { ...activeTask, child: undefined } });
  assert.deepEqual(resumed.recentParentEvidence.map((source) => source.text), [parent.text]);
  assert.deepEqual(resumed.recentBranchEvidence, []);
  assert.equal(resumed.diagnostics.rawSupplementCount, 0);
});

test("PC5 rejected historical Relation winners and removed source IDs cannot return as raw", () => {
  const base = record({ owner: { kind: "parent-mainline", parentId: "parent-rag" } });
  const current = { ...unit("current", "current-turn", "What would you monitor?", 100), runtimeEpoch: 5 };
  for (const patch of [
    { owner: { kind: "parent-mainline" as const, parentId: "retired-parent" } },
    { owner: { kind: "active-child" as const, parentId: "parent-rag", childId: "retired-child" } },
    { sourceTurnIds: ["replacement"] },
  ]) {
    const latest = { ...base, ...patch, recordId: "latest", logicalQuestionRevision: 2 };
    const selection = selectOwnerScopedRelationEvidence({ records: [base, latest], currentLogicalQuestionUnit: current,
      activeMeetingTask: task(), transcriptTurns: [turn("turn-parent-root", "Parent.", 0), turn("turn-shared", "Forbidden old raw.", 10)] });
    assert.equal(selection.diagnostics.rawSupplementCount, 0);
    assert.doesNotMatch(JSON.stringify(selection), /Forbidden old raw/);
    assert.ok([...selection.recentParentEvidence, ...selection.recentBranchEvidence].every((source) => source.sourceId === latest.recordId));
  }
  for (const patch of [{ runtimeEpoch: 6 }, { sessionId: "new-session" }]) {
    const selection = selectOwnerScopedRelationEvidence({ records: [{ ...base, ...patch }], currentLogicalQuestionUnit: current,
      activeMeetingTask: task(), transcriptTurns: [turn("turn-shared", "Forbidden raw.", 10)] });
    assert.deepEqual(selection.recentParentEvidence, []);
    assert.equal(selection.diagnostics.rawSupplementCount, 0);
  }
});

test("keeps append-only history while product selectors expose only the latest revision", () => {
  const ledger = new EffectiveQuestionSourceLedger();
  const revisionOne: EffectiveQuestionSourceRecord = {
    recordId: "record-revision-1",
    sessionId: "session-a",
    runtimeEpoch: 3,
    logicalQuestionUnitId: "lqu-corrected",
    logicalQuestionRevision: 1,
    sourceHash: "hash-revision-1",
    sourceTurnIds: ["turn-corrected"],
    text: "Design a ride-sharing system.",
    startedAt: 10,
    updatedAt: 20,
    speechAct: "directive",
    disposition: "answer-primary-ask",
    relation: "followup-parent",
    owner: { kind: "parent-mainline", parentId: "parent-design" },
    settledAt: 21,
  };
  const revisionTwo: EffectiveQuestionSourceRecord = {
    ...revisionOne,
    recordId: "record-revision-2",
    logicalQuestionRevision: 2,
    sourceHash: "hash-revision-2",
    text: "Design a RAG system.",
    updatedAt: 30,
    settledAt: 31,
  };

  ledger.upsert(revisionOne);
  ledger.upsert(revisionTwo);

  assert.equal(ledger.listHistory().length, 2);
  assert.deepEqual(
    ledger.list().map((record) => record.logicalQuestionRevision),
    [2]
  );
  assert.equal(
    ledger.findLogicalQuestion({
      sessionId: "session-a",
      runtimeEpoch: 3,
      logicalQuestionUnitId: "lqu-corrected",
      logicalQuestionRevision: 1,
    }),
    undefined
  );
  assert.equal(
    ledger.findLogicalQuestion({
      sessionId: "session-a",
      runtimeEpoch: 3,
      logicalQuestionUnitId: "lqu-corrected",
      logicalQuestionRevision: 2,
    })?.text,
    "Design a RAG system."
  );
});

test("drops superseded revisions before selecting relation evidence", () => {
  const base: EffectiveQuestionSourceRecord = {
    recordId: "record-old",
    sessionId: "session-a",
    runtimeEpoch: 3,
    logicalQuestionUnitId: "lqu-shared",
    logicalQuestionRevision: 1,
    sourceHash: "hash-old",
    sourceTurnIds: ["turn-old"],
    text: "Design a ride-sharing system.",
    startedAt: 10,
    updatedAt: 20,
    speechAct: "directive",
    disposition: "answer-primary-ask",
    relation: "followup-parent",
    owner: { kind: "parent-mainline", parentId: "parent-rag" },
    settledAt: 21,
  };
  const latest: EffectiveQuestionSourceRecord = {
    ...base,
    recordId: "record-latest",
    logicalQuestionRevision: 2,
    sourceHash: "hash-latest",
    sourceTurnIds: ["turn-old"],
    text: "Design a RAG system.",
    updatedAt: 30,
    settledAt: 31,
  };

  const selection = selectOwnerScopedRelationEvidence({
    records: [base, latest],
    currentLogicalQuestionUnit: unit(
      "lqu-current",
      "turn-current",
      "What should we monitor?",
      40
    ),
    activeMeetingTask: task(),
    transcriptTurns: [
      turn("turn-parent-root", "Design a production RAG system.", 0),
      turn("turn-old", "Design a ride-sharing system.", 10),
      turn("turn-current", "What should we monitor?", 40),
    ],
  });

  assert.deepEqual(
    selection.recentParentEvidence.map((record) => record.text),
    ["Design a RAG system."]
  );
  assert.equal(selection.diagnostics.supersededRecordCount, 1);
});

test("supersedes an old parent owner when the same LQU settles as a child", () => {
  const ledger = new EffectiveQuestionSourceLedger();
  const parentRecord = record({
    recordId: "record-parent-revision-1",
    logicalQuestionRevision: 1,
    sourceHash: "hash-parent",
    owner: { kind: "parent-mainline", parentId: "parent-rag" },
    relation: "followup-parent",
    settledAt: 20,
  });
  const childRecord = record({
    recordId: "record-child-revision-2",
    logicalQuestionRevision: 2,
    sourceHash: "hash-child",
    owner: {
      kind: "active-child",
      parentId: "parent-rag",
      childId: "child-hnsw",
    },
    relation: "child-probe",
    settledAt: 30,
  });

  ledger.upsert(parentRecord);
  ledger.upsert(childRecord);

  assert.equal(ledger.listHistory().length, 2);
  assert.deepEqual(
    ledger.list().map((candidate) => candidate.owner),
    [childRecord.owner]
  );
});

test("uses settlement time to supersede an owner at the same LQU revision", () => {
  const ledger = new EffectiveQuestionSourceLedger();
  ledger.upsert(
    record({
      recordId: "record-child-first",
      owner: {
        kind: "active-child",
        parentId: "parent-rag",
        childId: "child-hnsw",
      },
      relation: "child-probe",
      settledAt: 20,
    })
  );
  ledger.upsert(
    record({
      recordId: "record-parent-later",
      sourceHash: "hash-parent-later",
      owner: { kind: "parent-mainline", parentId: "parent-rag" },
      relation: "resume-parent",
      settledAt: 30,
    })
  );

  assert.deepEqual(ledger.list().map((candidate) => candidate.recordId), [
    "record-parent-later",
  ]);
});

test("supersedes an old parent id without merging sessions or runtime epochs", () => {
  const records = [
    record({
      recordId: "record-parent-old",
      owner: { kind: "parent-mainline", parentId: "parent-old" },
      settledAt: 10,
    }),
    record({
      recordId: "record-parent-new",
      sourceHash: "hash-parent-new",
      owner: { kind: "parent-mainline", parentId: "parent-new" },
      settledAt: 20,
    }),
    record({
      recordId: "record-other-epoch",
      runtimeEpoch: 4,
      owner: { kind: "parent-mainline", parentId: "parent-epoch-4" },
      settledAt: 30,
    }),
    record({
      recordId: "record-other-session",
      sessionId: "session-b",
      owner: { kind: "parent-mainline", parentId: "parent-session-b" },
      settledAt: 40,
    }),
  ];

  const latest = selectLatestEffectiveQuestionSourceRecords(records);

  assert.deepEqual(
    latest.map((candidate) => candidate.recordId).sort(),
    ["record-other-epoch", "record-other-session", "record-parent-new"]
  );
});

function record(
  overrides: Partial<EffectiveQuestionSourceRecord> = {}
): EffectiveQuestionSourceRecord {
  return {
    recordId: "record-default",
    sessionId: "session-a",
    runtimeEpoch: 3,
    logicalQuestionUnitId: "lqu-shared-owner-transition",
    logicalQuestionRevision: 1,
    sourceHash: "hash-default",
    sourceTurnIds: ["turn-shared"],
    text: "Explain the current topic.",
    startedAt: 1,
    updatedAt: 2,
    speechAct: "question",
    disposition: "answer-primary-ask",
    relation: "followup-parent",
    owner: { kind: "parent-mainline", parentId: "parent-default" },
    settledAt: 3,
    ...overrides,
  };
}
