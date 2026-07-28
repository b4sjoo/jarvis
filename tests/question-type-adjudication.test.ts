import assert from "node:assert/strict";
import test from "node:test";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import {
  buildQuestionTypeAdjudicationPrompts,
  buildQuestionTypeAdjudicationRequest,
  createQuestionTypeSettlementProposal,
  decideQuestionTypeAdjudicationEligibility,
  normalizeQuestionTypeAdjudicationMode,
  parseQuestionTypeAdjudicationOutput,
} from "../src/lib/meeting/question-type-adjudication.js";
import {
  createProvisionalCurrentQuestion,
  settleCurrentQuestion,
} from "../src/lib/meeting/current-question-settlement.js";
import {
  inferQuestionTypeDecisionFromText,
  type QuestionTypeInferenceDecision,
} from "../src/lib/meeting/task-taxonomy.js";

function unit(text: string, revision = 1): LogicalQuestionUnit {
  return {
    id: "logical-question-a",
    revision,
    sessionId: "session-a",
    runtimeEpoch: 3,
    currentTurnId: "turn-a",
    sourceTurnIds: ["turn-a"],
    sources: [
      {
        turnId: "turn-a",
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

function abstainingLexical(): QuestionTypeInferenceDecision {
  return {
    certainty: "abstain",
    authorityReason: "no-exact-high-evidence",
    conflictingTypes: [],
    confidence: 0,
    margin: 0,
    source: "lightweight-text",
    evidence: [],
    ambiguousTerms: [],
    scores: {},
    briefCompatibilityDecision: "not-applicable",
  };
}

test("builds a bounded type-only request without local classifier evidence", () => {
  const request = buildQuestionTypeAdjudicationRequest({
    logicalQuestionUnit: unit(
      "How would you design retrieval for a trip planning assistant?"
    ),
  });
  const prompts = buildQuestionTypeAdjudicationPrompts(request);

  assert.equal(request.schemaVersion, 1);
  assert.equal(request.logicalQuestionUnitRevision, 1);
  assert.match(prompts.systemPrompt, /Classify only the question type/i);
  assert.match(prompts.systemPrompt, /Do not decide task relation/i);
  assert.doesNotMatch(
    prompts.userMessage,
    /lexical|semantic|activeParent|playbookPhase/i
  );
});

test("strictly parses grounded type output and rejects broader authority", () => {
  const request = buildQuestionTypeAdjudicationRequest({
    logicalQuestionUnit: unit(
      "Design a RAG system for a trip planning app."
    ),
  });
  const valid = {
    schemaVersion: 1,
    questionType: "ai-ml-system-design",
    confidence: 0.94,
    evidenceSpans: ["RAG system", "trip planning app"],
  };

  assert.equal(
    parseQuestionTypeAdjudicationOutput(
      `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``,
      request
    ).ok,
    true
  );
  assert.deepEqual(
    parseQuestionTypeAdjudicationOutput(
      JSON.stringify({
        ...valid,
        relation: "new-parent",
      }),
      request
    ),
    {
      ok: false,
      reason: "non-type-field-present",
      errorKind: "schema",
      evidenceSpansValid: false,
    }
  );
  assert.deepEqual(
    parseQuestionTypeAdjudicationOutput(
      JSON.stringify({
        ...valid,
        evidenceSpans: ["vector database benchmark"],
      }),
      request
    ),
    {
      ok: false,
      reason: "invalid-evidence-span",
      errorKind: "evidence",
      evidenceSpansValid: false,
    }
  );
});

test("runs on local abstention but skips exact-high and manual authority", () => {
  const logicalQuestionUnit = unit(
    "How would you approach this architecture?"
  );
  const request = buildQuestionTypeAdjudicationRequest({
    logicalQuestionUnit,
  });
  const eligible = decideQuestionTypeAdjudicationEligibility({
    mode: "shadow",
    speaker: "them",
    projection: request.question,
    lexical: abstainingLexical(),
    manualCorrectionActive: false,
    turnGateAction: "answer-refresh",
  });
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.reason, "local-type-abstained");

  const exactHigh = inferQuestionTypeDecisionFromText(
    "Implement a stack in Python."
  );
  assert.equal(exactHigh.certainty, "exact-high");
  assert.equal(
    decideQuestionTypeAdjudicationEligibility({
      mode: "shadow",
      speaker: "them",
      projection: request.question,
      lexical: exactHigh,
      manualCorrectionActive: false,
      turnGateAction: "answer-refresh",
    }).reason,
    "local-exact-high-authoritative"
  );
  assert.equal(
    decideQuestionTypeAdjudicationEligibility({
      mode: "shadow",
      speaker: "them",
      projection: request.question,
      lexical: abstainingLexical(),
      manualCorrectionActive: true,
      turnGateAction: "answer-refresh",
    }).reason,
    "manual-correction-authoritative"
  );
});

test("migrates the legacy enabled flag to an explicit operation mode", () => {
  assert.equal(
    normalizeQuestionTypeAdjudicationMode(undefined, true),
    "shadow"
  );
  assert.equal(
    normalizeQuestionTypeAdjudicationMode(undefined, false),
    "off"
  );
  assert.equal(
    normalizeQuestionTypeAdjudicationMode("enforcement", false),
    "enforcement"
  );
});

test("Task 144 accepts only the proposed type while relation and parent stay blocked", () => {
  const logicalQuestionUnit = unit(
    "Design a RAG system for a trip planning app."
  );
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit,
    sourceKind: "voice",
  });
  const llmProposal = createQuestionTypeSettlementProposal({
    currentQuestion,
    adjudication: {
      schemaVersion: 1,
      questionType: "ai-ml-system-design",
      confidence: 0.96,
      evidenceSpans: ["RAG system"],
    },
    expectedParentId: "parent-a",
    expectedParentRevision: 4,
  });
  const common = {
    currentQuestion,
    llmProposal,
    activeParentId: "parent-a",
    activeParentRevision: 4,
    manualCorrectionRevision: 0,
  };
  const shadow = settleCurrentQuestion({
    ...common,
    policy: {
      allowLlmTypeRepair: false,
      allowLlmRelationRepair: false,
      allowLlmActionRepair: false,
      runtimeMutationAuthorized: false,
      questionComplete: true,
      commitParent: false,
    },
  });
  assert.equal(shadow.questionType, "unknown");
  assert.equal(shadow.typeMutationAuthorized, false);

  const enforcementPreview = settleCurrentQuestion({
    ...common,
    policy: {
      allowLlmTypeRepair: true,
      allowLlmRelationRepair: false,
      allowLlmActionRepair: false,
      runtimeMutationAuthorized: false,
      questionComplete: true,
      commitParent: false,
    },
  });
  assert.equal(
    enforcementPreview.questionType,
    "ai-ml-system-design"
  );
  assert.equal(
    enforcementPreview.typeAuthoritySource,
    "llm-type-repair"
  );
  assert.equal(enforcementPreview.relation, "unknown");
  assert.equal(enforcementPreview.typeMutationAuthorized, true);
  assert.equal(enforcementPreview.relationMutationAuthorized, false);
  assert.equal(enforcementPreview.parentMutationAuthorized, false);
});
