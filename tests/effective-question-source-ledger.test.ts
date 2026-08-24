import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import type { EffectiveCurrentQuestionSettlement } from "../src/lib/meeting/current-question-settlement.js";
import {
  createEffectiveQuestionSourceRecord,
  EffectiveQuestionSourceLedger,
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
      playbookPhase: "architecture_decision",
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
  ledger.upsert(record);
  ledger.upsert(record);
  assert.equal(ledger.list().length, 1);
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
