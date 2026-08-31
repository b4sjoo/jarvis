import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  resolveVisibleAnswerResponseActionTarget,
} from "../src/lib/meeting/response-action-target.js";
import type { StableAnswerRevision } from "../src/lib/meeting/stable-answer.js";
import type { MeetingContextState } from "../src/lib/meeting/types.js";
import type { CurrentQuestionSettlementDecision } from "../src/lib/meeting/current-question-settlement.js";

const frozenSettlement = {
  settlementId: "settlement-voice",
  logicalQuestionUnitId: "question-voice",
  revision: 2,
  sessionId: "session-a",
  runtimeEpoch: 3,
  sourceKind: "voice",
  sourceTurnIds: ["turn-voice"],
  sourceObservationIds: [],
  sourceHash: "voice-source-hash",
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
  questionSourceHash: "voice-source-hash",
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

test("reconstructs Enhance target from the visible Answer owner", () => {
  const decision = resolveVisibleAnswerResponseActionTarget({
    stableAnswer: stable,
    currentLogicalQuestionUnit: undefined,
    meetingContext: context(),
    runtimeEpoch: 3,
  });

  assert.equal(decision.authorized, true);
  assert.equal(decision.logicalQuestionUnit?.id, "question-voice");
  assert.equal(
    decision.logicalQuestionUnit?.normalizedText,
    "Tell me about a time you earned trust."
  );
  assert.equal(decision.sourceHash, "voice-source-hash");
  assert.equal(decision.settlementSnapshot, frozenSettlement);
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
