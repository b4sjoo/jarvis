import assert from "node:assert/strict";
import test from "node:test";
import {
  decideCorrectionOwnedAdjudicationTrigger,
  correctionTargetOwnsParentOrigin,
  mapCorrectionOwnedPlaybookPhase,
  resolveCorrectionOwnedResettlement,
  resolveCorrectionOwnedTypeResettlement,
} from "../src/lib/meeting/correction-owned-resettlement.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import type { QuestionTypeInferenceDecision } from "../src/lib/meeting/task-taxonomy.js";
import type { LlmTaxonomyAdjudication } from "../src/lib/meeting/taxonomy-adjudication.js";

test("schedules semantic resettlement when RAG changes a General SD question", () => {
  const trigger = decideCorrectionOwnedAdjudicationTrigger({
    original: localDecision("general-system-design", 0.88),
    corrected: localDecision("ai-ml-system-design", 0.93),
    activeParentType: "general-system-design",
    activeParentTopic: "Design a rhyme system for trip planning",
    normalizedTerm: "RAG",
  });

  assert.equal(trigger.shouldAdjudicate, true);
  assert.equal(trigger.reason, "local-type-changed");
});

test("keeps Vector DB and HNSW corrections on an AI/ML parent fast path", () => {
  for (const normalizedTerm of ["Vector DB", "HNSW"]) {
    const trigger = decideCorrectionOwnedAdjudicationTrigger({
      original: localDecision("ai-ml-system-design", 0.9),
      corrected: localDecision("ai-ml-system-design", 0.94),
      activeParentType: "ai-ml-system-design",
      activeParentTopic: "Design a RAG system with vector retrieval",
      normalizedTerm,
    });

    assert.equal(trigger.shouldAdjudicate, false, normalizedTerm);
    assert.equal(trigger.reason, "same-domain-fast-path", normalizedTerm);
  }
});

test("authorizes a correction-owned General SD to AI/ML SD retype", () => {
  const logicalQuestionUnit = question(
    "Design a RAG system for trip planning."
  );
  const decision = resolveCorrectionOwnedResettlement({
    logicalQuestionUnit,
    adjudication: adjudication({
      questionType: "ai-ml-system-design",
      relation: "followup-parent",
      normalizedQuestion: logicalQuestionUnit.normalizedText,
      primaryAskSpans: [
        {
          turnId: "turn_1",
          text: "Design a RAG system for trip planning.",
        },
      ],
    }),
    operationAuthorized: true,
    activeParentId: "parent_1",
    activeParentRevision: 3,
    activeParentType: "general-system-design",
    targetOwnsActiveParent: true,
    manualCorrectionRevision: 4,
    sourceKind: "screen",
    sourceObservationIds: ["screen-a"],
  });

  assert.equal(decision.disposition, "same-question-retype");
  assert.equal(decision.parentMutationAuthorized, true);
  assert.equal(decision.correctedType, "ai-ml-system-design");
  assert.equal(decision.relation, "followup-parent");
  assert.equal(
    decision.settlement?.typeAuthoritySource,
    "llm-type-repair"
  );
  assert.equal(
    decision.settlement?.relationAuthoritySource,
    "llm-type-repair"
  );
});

test("authorizes the same parent retype from the compact Question Type result", () => {
  const logicalQuestionUnit = question(
    "Design a RAG system for trip planning."
  );
  const decision = resolveCorrectionOwnedTypeResettlement({
    logicalQuestionUnit,
    adjudication: {
      schemaVersion: 1,
      questionType: "ai-ml-system-design",
      confidence: 0.96,
      evidenceSpans: ["RAG system"],
    },
    operationAuthorized: true,
    activeParentId: "parent_1",
    activeParentRevision: 3,
    activeParentType: "general-system-design",
    targetOwnsActiveParent: true,
    manualCorrectionRevision: 4,
    sourceKind: "screen",
    sourceObservationIds: ["screen-a"],
    orderedRelation: "followup-parent",
    orderedRelationReason: "parent-origin-same-question",
  });

  assert.equal(decision.disposition, "same-question-retype");
  assert.equal(decision.parentMutationAuthorized, true);
  assert.equal(decision.correctedType, "ai-ml-system-design");
  assert.equal(decision.relation, "followup-parent");
  assert.equal(decision.settlement?.typeMutationAuthorized, true);
  assert.equal(decision.settlement?.relationMutationAuthorized, true);
  assert.equal(decision.settlement?.sourceKind, "mixed");
  assert.deepEqual(decision.settlement?.sourceObservationIds, ["screen-a"]);
});

test("rejects stale and low-confidence semantic resettlement results", () => {
  const unit = question("Design a RAG system.");
  const stale = resolveCorrectionOwnedResettlement({
    logicalQuestionUnit: unit,
    adjudication: adjudication(),
    operationAuthorized: false,
    operationAuthorizationReason: "logical-unit-revision-mismatch",
    activeParentType: "general-system-design",
    targetOwnsActiveParent: false,
    manualCorrectionRevision: 3,
  });
  const lowConfidence = resolveCorrectionOwnedResettlement({
    logicalQuestionUnit: unit,
    adjudication: adjudication({ confidence: 0.71 }),
    operationAuthorized: true,
    activeParentType: "general-system-design",
    targetOwnsActiveParent: false,
    manualCorrectionRevision: 3,
  });

  assert.equal(stale.disposition, "semantic-result-stale");
  assert.equal(stale.parentMutationAuthorized, false);
  assert.equal(lowConfidence.disposition, "semantic-result-rejected");
  assert.equal(lowConfidence.parentMutationAuthorized, false);
});

test("requires the corrected LQU lineage to own the active parent", () => {
  const unit = question("Design a RAG system.");
  const parent = {
    id: "parent_1",
    source: "voice" as const,
    stableKind: "general-system-design" as const,
    topic: "Design a rack system.",
    playbookPhase: "requirement_clarification" as const,
    phaseProgress: {},
    supportedFactAnchors: [],
    createdAt: 1,
    updatedAt: 2,
    revisions: 3,
    sourceQuestionUnitId: unit.id,
    sourceQuestionRevision: 1,
    canonicalQuestionSourceTurnIds: ["turn_1"],
  };

  assert.equal(
    correctionTargetOwnsParentOrigin({ logicalQuestionUnit: unit, parent }),
    true
  );
  assert.equal(
    correctionTargetOwnsParentOrigin({
      logicalQuestionUnit: { ...unit, id: "different_lqu" },
      parent,
    }),
    false
  );

  const rejected = resolveCorrectionOwnedResettlement({
    logicalQuestionUnit: unit,
    adjudication: adjudication(),
    operationAuthorized: true,
    activeParentId: parent.id,
    activeParentRevision: parent.revisions,
    activeParentType: parent.stableKind,
    targetOwnsActiveParent: false,
    manualCorrectionRevision: 4,
  });
  assert.equal(rejected.parentMutationAuthorized, false);
  assert.equal(
    rejected.reason,
    "correction-target-does-not-own-active-parent"
  );
});

test("maps equivalent system-design phases without carrying unrelated phases", () => {
  assert.equal(
    mapCorrectionOwnedPlaybookPhase({
      previousType: "general-system-design",
      correctedType: "ai-ml-system-design",
      previousPhase: "design_framing",
    }),
    "design_framing"
  );
  assert.equal(
    mapCorrectionOwnedPlaybookPhase({
      previousType: "behavioral",
      correctedType: "ai-ml-system-design",
      previousPhase: "story_selection",
    }),
    undefined
  );
});

function question(text: string): LogicalQuestionUnit {
  return {
    id: "lqu_1",
    revision: 2,
    sessionId: "session_1",
    runtimeEpoch: 5,
    currentTurnId: "turn_1",
    sourceTurnIds: ["turn_1"],
    sources: [
      {
        turnId: "turn_1",
        text,
        startedAt: 10,
        endedAt: 20,
      },
    ],
    normalizedText: text,
    startedAt: 10,
    updatedAt: 20,
    compositionReasons: ["independent-current-turn"],
    boundaryReason: "independent-current-turn",
    truncated: false,
  };
}

function localDecision(
  type: QuestionTypeInferenceDecision["type"],
  confidence: number
): QuestionTypeInferenceDecision {
  return {
    type,
    legacyType: type,
    certainty: type ? "exact-high" : "abstain",
    authorityReason: type ? `exact-${type}` : "no-exact-local-evidence",
    conflictingTypes: [],
    confidence,
    margin: 0.4,
    evidence: [],
    ambiguousTerms: [],
    scores: {},
    source: "lightweight-text",
    briefCompatibilityDecision: "not-applicable",
  };
}

function adjudication(
  overrides: Partial<LlmTaxonomyAdjudication> = {}
): LlmTaxonomyAdjudication {
  return {
    schemaVersion: 2,
    speechAct: "directive",
    questionType: "ai-ml-system-design",
    relation: "followup-parent",
    evidenceMode: "hypothetical-design",
    action: "answer",
    normalizedQuestion: "Design a RAG system.",
    primaryAskSpans: [
      {
        turnId: "turn_1",
        text: "Design a RAG system.",
      },
    ],
    standalone: true,
    evidenceSpans: ["Design a RAG system."],
    confidence: 0.96,
    ...overrides,
  };
}
