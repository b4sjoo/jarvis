import assert from "node:assert/strict";
import test from "node:test";
import { composeLogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import { projectPrimaryAsk } from "../src/lib/meeting/primary-ask-projection.js";
import {
  authorizeTaxonomyAdjudicationLease,
  buildTaxonomyAdjudicationPrompts,
  buildTaxonomyAdjudicationRequest,
  createTaxonomyAdjudicationLease,
  parseTaxonomyAdjudicationOutput,
  TAXONOMY_ADJUDICATION_PROMPT_VERSION,
  type LlmTaxonomyAdjudication,
} from "../src/lib/meeting/taxonomy-adjudication.js";
import type { TranscriptTurn } from "../src/lib/meeting/types.js";

const SESSION_ID = "session-recruiter-replay";
const RUNTIME_EPOCH = 3;

function turn(id: string, text: string, startedAt: number): TranscriptTurn {
  return {
    id,
    text,
    speaker: "them",
    source: "system-audio",
    startedAt,
    endedAt: startedAt + 100,
    isFinal: true,
  };
}

function output(
  overrides: Partial<LlmTaxonomyAdjudication>
): LlmTaxonomyAdjudication {
  return {
    schemaVersion: 2,
    speechAct: "question",
    questionType: "unknown",
    relation: "none",
    evidenceMode: "unknown",
    action: "answer",
    normalizedQuestion: "",
    primaryAskSpans: [],
    standalone: true,
    evidenceSpans: [],
    confidence: 0.95,
    ...overrides,
  };
}

test("replays recruiter openings, dense terminal asks, logistics, and split LQU ownership", () => {
  const openingText =
    "Could you walk me through your background and the work most relevant to this role?";
  const openingTurn = turn("turn-opening", openingText, 1_000);
  const openingUnit = composeLogicalQuestionUnit({
    currentTurn: openingTurn,
    sessionId: SESSION_ID,
    runtimeEpoch: RUNTIME_EPOCH,
    primaryAskProjection: projectPrimaryAsk({
      turnId: openingTurn.id,
      text: openingTurn.text,
    }),
  });
  const openingRequest = buildTaxonomyAdjudicationRequest({
    logicalQuestionUnit: openingUnit,
  });
  const openingResult = parseTaxonomyAdjudicationOutput(
    JSON.stringify(
      output({
        questionType: "project-deep-dive",
        evidenceMode: "personal-experience",
        normalizedQuestion: openingText,
        primaryAskSpans: [{ turnId: openingTurn.id, text: openingText }],
        evidenceSpans: ["walk me through your background"],
      })
    ),
    openingRequest
  );

  assert.equal(openingRequest.promptVersion, TAXONOMY_ADJUDICATION_PROMPT_VERSION);
  assert.equal(openingResult.ok, true);
  if (openingResult.ok) {
    assert.equal(openingResult.value.questionType, "project-deep-dive");
  }

  const denseText =
    "You can ask the team what challenges they face and what the scope looks like. How does this role sound relative to what you are looking for?";
  const denseAsk =
    "How does this role sound relative to what you are looking for?";
  const denseTurn = turn("turn-dense", denseText, 2_000);
  const denseUnit = composeLogicalQuestionUnit({
    currentTurn: denseTurn,
    sessionId: SESSION_ID,
    runtimeEpoch: RUNTIME_EPOCH,
    primaryAskProjection: projectPrimaryAsk({
      turnId: denseTurn.id,
      text: denseTurn.text,
    }),
  });
  const denseRequest = buildTaxonomyAdjudicationRequest({
    logicalQuestionUnit: denseUnit,
  });
  const densePrompt = buildTaxonomyAdjudicationPrompts(denseRequest);
  const densePacket = JSON.parse(densePrompt.userMessage);
  const denseResult = parseTaxonomyAdjudicationOutput(
    JSON.stringify(
      output({
        normalizedQuestion: denseAsk,
        primaryAskSpans: [{ turnId: denseTurn.id, text: denseAsk }],
        evidenceSpans: [denseAsk],
      })
    ),
    denseRequest
  );

  assert.deepEqual(densePacket.sources, [
    {
      i: 0,
      k: "q",
      t: "You can ask the team what challenges they face and what the scope looks like.",
    },
    { i: 1, k: "q", t: denseAsk },
  ]);
  assert.equal("evidence" in densePacket, false);
  assert.equal(denseResult.ok, true);
  if (denseResult.ok) {
    assert.deepEqual(denseResult.value.primaryAskSpans, [
      { turnId: denseTurn.id, text: denseAsk },
    ]);
  }

  const logisticsText =
    "The call is scheduled for thirty minutes and we will leave time for questions.";
  const logisticsTurn = turn("turn-logistics", logisticsText, 3_000);
  const logisticsUnit = composeLogicalQuestionUnit({
    currentTurn: logisticsTurn,
    sessionId: SESSION_ID,
    runtimeEpoch: RUNTIME_EPOCH,
    primaryAskProjection: projectPrimaryAsk({
      turnId: logisticsTurn.id,
      text: logisticsTurn.text,
    }),
  });
  const logisticsResult = parseTaxonomyAdjudicationOutput(
    JSON.stringify(
      output({
        speechAct: "logistics",
        action: "append-context",
        normalizedQuestion: "",
        standalone: false,
        evidenceSpans: ["scheduled for thirty minutes"],
      })
    ),
    buildTaxonomyAdjudicationRequest({
      logicalQuestionUnit: logisticsUnit,
    })
  );

  assert.equal(logisticsResult.ok, true);
  if (logisticsResult.ok) {
    assert.equal(logisticsResult.value.questionType, "unknown");
    assert.equal(logisticsResult.value.action, "append-context");
  }

  const setupText =
    "The role owns retrieval quality, ranking infrastructure, and partner integrations.";
  const setupTurn = turn("turn-setup", setupText, 4_000);
  const setupUnit = composeLogicalQuestionUnit({
    currentTurn: setupTurn,
    sessionId: SESSION_ID,
    runtimeEpoch: RUNTIME_EPOCH,
    primaryAskProjection: projectPrimaryAsk({
      turnId: setupTurn.id,
      text: setupTurn.text,
    }),
  });
  const splitAsk = "How does that align with what you are looking for?";
  const askTurn = turn("turn-split-ask", splitAsk, 5_000);
  const revisedUnit = composeLogicalQuestionUnit({
    currentTurn: askTurn,
    sessionId: SESSION_ID,
    runtimeEpoch: RUNTIME_EPOCH,
    previousUnit: setupUnit,
    primaryAskProjection: projectPrimaryAsk({
      turnId: askTurn.id,
      text: askTurn.text,
    }),
  });

  assert.equal(revisedUnit.id, setupUnit.id);
  assert.equal(revisedUnit.revision, 2);
  assert.deepEqual(revisedUnit.sourceTurnIds, [
    setupTurn.id,
    askTurn.id,
  ]);

  const lease = createTaxonomyAdjudicationLease({
    sessionId: SESSION_ID,
    runtimeEpoch: RUNTIME_EPOCH,
    logicalQuestionUnit: revisedUnit,
    taskBoundaryEpoch: 9,
    manualCorrectionRevision: 2,
    operationId: "operation-recruiter-replay",
  });
  assert.deepEqual(
    authorizeTaxonomyAdjudicationLease(lease, {
      currentOperationId: lease.operationId,
      sessionId: SESSION_ID,
      runtimeEpoch: RUNTIME_EPOCH,
      logicalQuestionUnit: revisedUnit,
      taskBoundaryEpoch: 9,
      manualCorrectionRevision: 2,
      logicalUnitClosed: false,
      selfHealingBudgetConsumed: false,
    }),
    { authorized: true }
  );
  assert.deepEqual(
    authorizeTaxonomyAdjudicationLease(lease, {
      currentOperationId: lease.operationId,
      sessionId: SESSION_ID,
      runtimeEpoch: RUNTIME_EPOCH,
      logicalQuestionUnit: { ...revisedUnit, revision: 3 },
      taskBoundaryEpoch: 9,
      manualCorrectionRevision: 2,
      logicalUnitClosed: false,
      selfHealingBudgetConsumed: false,
    }),
    { authorized: false, reason: "logical-unit-revision-mismatch" }
  );
});
