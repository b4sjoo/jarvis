import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLocalInterviewerIntentBaseline,
  compareTaxonomyAdjudicationToLocalBaseline,
} from "../src/lib/meeting/taxonomy-adjudication-comparison.js";
import type { LlmTaxonomyAdjudication } from "../src/lib/meeting/taxonomy-adjudication.js";

function adjudication(
  overrides: Partial<LlmTaxonomyAdjudication> = {}
): LlmTaxonomyAdjudication {
  return {
    schemaVersion: 2,
    speechAct: "question",
    questionType: "general-system-design",
    relation: "followup-parent",
    evidenceMode: "hypothetical-design",
    action: "answer",
    normalizedQuestion: "How would you shard the location store?",
    primaryAskSpans: [],
    standalone: false,
    evidenceSpans: ["location store"],
    confidence: 0.9,
    ...overrides,
  };
}

test("compares every interviewer-intent factor independently", () => {
  const baseline = buildLocalInterviewerIntentBaseline({
    questionType: "general-system-design",
    relation: "followup-parent",
    turnGateAction: "answer-refresh",
    primaryAskProjection: {
      schemaVersion: 2,
      sourceTurnIds: ["turn_1"],
      sourceChars: 45,
      speechAct: "question",
      normalizedPrimaryAsk: "How would you shard the location store?",
      primaryAskSpans: [],
      setupSpans: [],
      quotedOrFutureExampleSpans: [],
      answerFocusText: "How would you shard the location store?",
      semanticEvidenceText: "How would you shard the location store?",
      answerFocusSpans: [],
      objectSpans: [],
      scenarioSpans: [],
      semanticEvidenceRetentionReasons: ["answer-focus"],
      semanticEvidenceDroppedReasons: [],
      disposition: "answer-primary-ask",
      reason: "test",
      confidence: 0.9,
    },
  });

  assert.deepEqual(
    compareTaxonomyAdjudicationToLocalBaseline({
      adjudication: adjudication(),
      baseline,
    }),
    { wouldRepair: false, factors: [] }
  );

  assert.deepEqual(
    compareTaxonomyAdjudicationToLocalBaseline({
      adjudication: adjudication({
        speechAct: "directive",
        questionType: "ai-ml-system-design",
        relation: "linked-parent-extension",
        evidenceMode: "factual-explanation",
        action: "append-context",
        normalizedQuestion: "Where should the embeddings live?",
      }),
      baseline,
    }),
    {
      wouldRepair: true,
      factors: [
        "speech-act",
        "question-type",
        "relation",
        "evidence-mode",
        "action",
        "primary-ask",
      ],
    }
  );
});

test("maps suppressed local turns into an action baseline", () => {
  const baseline = buildLocalInterviewerIntentBaseline({
    questionType: "unknown",
    relation: "none",
    turnGateAction: "ignore",
  });
  const result = compareTaxonomyAdjudicationToLocalBaseline({
    baseline,
    adjudication: adjudication({
      questionType: "unknown",
      relation: "none",
      evidenceMode: "unknown",
      action: "answer",
    }),
  });

  assert.equal(result.wouldRepair, true);
  assert.deepEqual(result.factors, ["action", "primary-ask"]);
});
