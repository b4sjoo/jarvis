import assert from "node:assert/strict";
import test from "node:test";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import {
  buildQuestionTypeAdjudicationPrompts,
  buildQuestionTypeAdjudicationRequest,
  createQuestionTypeSettlementProposal,
  decideQuestionTypeAdjudicationEligibility,
  decideQuestionTypeEnforcement,
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
  assert.match(
    prompts.systemPrompt,
    /named candidate project.*actual project facts/i
  );
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

test("always observes eligible type turns while manual authority stays shadow-only", () => {
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
  assert.equal(eligible.executionMode, "shadow-observation");

  const exactHigh = inferQuestionTypeDecisionFromText(
    "Implement a stack in Python."
  );
  assert.equal(exactHigh.certainty, "exact-high");
  const exactHighEligibility =
    decideQuestionTypeAdjudicationEligibility({
      mode: "shadow",
      speaker: "them",
      projection: request.question,
      lexical: exactHigh,
      manualCorrectionActive: false,
      turnGateAction: "answer-refresh",
    });
  assert.equal(exactHighEligibility.eligible, true);
  assert.equal(
    exactHighEligibility.executionMode,
    "shadow-observation"
  );
  const manualEligibility =
    decideQuestionTypeAdjudicationEligibility({
      mode: "shadow",
      speaker: "them",
      projection: request.question,
      lexical: abstainingLexical(),
      manualCorrectionActive: true,
      turnGateAction: "answer-refresh",
    });
  assert.equal(manualEligibility.eligible, true);
  assert.equal(
    manualEligibility.reason,
    "manual-correction-shadow-observation"
  );
});

test("waits only for lower-confidence, long, or multi-sentence type review", () => {
  const exactHigh = inferQuestionTypeDecisionFromText(
    "Implement a stack in Python."
  );
  const simpleRequest = buildQuestionTypeAdjudicationRequest({
    logicalQuestionUnit: unit("Implement a stack in Python."),
  });
  const simple = decideQuestionTypeAdjudicationEligibility({
    mode: "enforcement",
    speaker: "them",
    projection: simpleRequest.question,
    lexical: { ...exactHigh, confidence: 0.97 },
    manualCorrectionActive: false,
    turnGateAction: "answer-refresh",
  });
  assert.equal(simple.executionMode, "shadow-observation");
  assert.equal(simple.reason, "high-confidence-simple-local-shadow");

  const lowerConfidence = decideQuestionTypeAdjudicationEligibility({
    mode: "enforcement",
    speaker: "them",
    projection: simpleRequest.question,
    lexical: { ...exactHigh, confidence: 0.88 },
    manualCorrectionActive: false,
    turnGateAction: "answer-refresh",
  });
  assert.equal(lowerConfidence.executionMode, "enforcement-window");
  assert.ok(
    lowerConfidence.triggerReasons.includes(
      "local-confidence-below-enforcement-threshold"
    )
  );

  const multiSentenceRequest = buildQuestionTypeAdjudicationRequest({
    logicalQuestionUnit: unit(
      "Tell me about your project. What was the hardest decision?"
    ),
  });
  const multiSentence = decideQuestionTypeAdjudicationEligibility({
    mode: "enforcement",
    speaker: "them",
    projection: multiSentenceRequest.question,
    lexical: { ...exactHigh, confidence: 0.97 },
    manualCorrectionActive: false,
    turnGateAction: "answer-refresh",
  });
  assert.equal(multiSentence.executionMode, "enforcement-window");
  assert.ok(
    multiSentence.triggerReasons.includes(
      "multi-sentence-question-unit"
    )
  );

  const conflicting = decideQuestionTypeAdjudicationEligibility({
    mode: "enforcement",
    speaker: "them",
    projection: simpleRequest.question,
    lexical: { ...exactHigh, confidence: 0.97 },
    manualCorrectionActive: false,
    turnGateAction: "answer-refresh",
    sameAxisConflict: {
      axis: "question-type",
      conflict: true,
      reason: "eligible-proposals-disagree",
      eligibleProposalCount: 2,
      sources: ["question-type-lexical", "section-hint"],
      values: ["coding", "general-system-design"],
    },
  });
  assert.equal(conflicting.executionMode, "enforcement-window");
  assert.ok(
    conflicting.triggerReasons.includes("same-axis-proposal-conflict")
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

test("authorizes only high-confidence unknown-to-concrete type repair", () => {
  const logicalQuestionUnit = unit(
    "Design a URL shortener for me."
  );
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit,
    sourceKind: "voice",
  });
  const candidate = {
    schemaVersion: 1 as const,
    questionType: "general-system-design" as const,
    confidence: 0.97,
    evidenceSpans: ["URL shortener"],
  };
  const settlement = settleCurrentQuestion({
    currentQuestion,
    llmProposal: createQuestionTypeSettlementProposal({
      currentQuestion,
      adjudication: candidate,
    }),
    manualCorrectionRevision: 0,
    policy: {
      allowLlmTypeRepair: true,
      llmTypeRepairMinConfidence: 0.95,
      runtimeMutationAuthorized: false,
      questionComplete: true,
      commitParent: false,
    },
  });

  assert.deepEqual(
    decideQuestionTypeEnforcement({
      mode: "enforcement",
      localQuestionType: "unknown",
      candidate,
      settlement,
      sourceOwnedSubstantive: true,
      manualAuthorityConflict: false,
      operationLeaseAuthorized: true,
      advisorReleaseWindowOpen: true,
    }),
    {
      authorized: true,
      reason: "authorized",
      localQuestionType: "unknown",
      proposedQuestionType: "general-system-design",
      confidence: 0.97,
      minimumConfidence: 0.95,
    }
  );
});

test("keeps type enforcement narrow across confidence, authority, and timing guards", () => {
  const logicalQuestionUnit = unit(
    "Design a URL shortener for me."
  );
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit,
    sourceKind: "voice",
  });
  const candidate = {
    schemaVersion: 1 as const,
    questionType: "general-system-design" as const,
    confidence: 0.97,
    evidenceSpans: ["URL shortener"],
  };
  const settlement = settleCurrentQuestion({
    currentQuestion,
    llmProposal: createQuestionTypeSettlementProposal({
      currentQuestion,
      adjudication: candidate,
    }),
    manualCorrectionRevision: 0,
    policy: {
      allowLlmTypeRepair: true,
      llmTypeRepairMinConfidence: 0.95,
      runtimeMutationAuthorized: false,
      questionComplete: true,
      commitParent: false,
    },
  });
  const base = {
    mode: "enforcement" as const,
    localQuestionType: "unknown",
    candidate,
    settlement,
    sourceOwnedSubstantive: true,
    manualAuthorityConflict: false,
    operationLeaseAuthorized: true,
    advisorReleaseWindowOpen: true,
  };

  assert.equal(
    decideQuestionTypeEnforcement({
      ...base,
      localQuestionType: "coding",
    }).authorized,
    true
  );
  assert.equal(
    decideQuestionTypeEnforcement({
      ...base,
      candidate: { ...candidate, confidence: 0.94 },
    }).reason,
    "candidate-confidence-below-threshold"
  );
  assert.equal(
    decideQuestionTypeEnforcement({
      ...base,
      manualAuthorityConflict: true,
    }).reason,
    "manual-authority-conflict"
  );
  assert.equal(
    decideQuestionTypeEnforcement({
      ...base,
      operationLeaseAuthorized: false,
    }).reason,
    "operation-lease-not-authorized"
  );
  assert.equal(
    decideQuestionTypeEnforcement({
      ...base,
      advisorReleaseWindowOpen: false,
    }).reason,
    "advisor-release-window-closed"
  );
  assert.equal(
    decideQuestionTypeEnforcement({
      ...base,
      mode: "shadow",
    }).reason,
    "operation-not-enforcement"
  );
});
