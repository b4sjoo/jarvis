import assert from "node:assert/strict";
import test from "node:test";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import {
  FIELD_KNOWLEDGE_REVIEW_WAIT_BUDGET_MS,
  QUESTION_TYPE_ENFORCEMENT_WAIT_BUDGET_MS,
  QuestionTypeAdjudicationCandidateCache,
  buildQuestionTypeAdjudicationCacheKey,
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
  assert.equal(request.reviewScope, "full");
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

test("builds and enforces a narrow Field Knowledge versus Coding review", () => {
  const request = buildQuestionTypeAdjudicationRequest({
    logicalQuestionUnit: unit(
      "Implement an LRU cache and analyze its time complexity."
    ),
    reviewScope: "field-vs-coding",
  });
  const prompts = buildQuestionTypeAdjudicationPrompts(request);
  assert.match(prompts.systemPrompt, /automatic Field Knowledge proposal/i);
  assert.match(prompts.systemPrompt, /cs is the Coding score/i);
  assert.match(prompts.systemPrompt, /three scores must sum to 1/i);
  assert.doesNotMatch(prompts.systemPrompt, /behavioral asks/i);

  const parsed = parseQuestionTypeAdjudicationOutput(
    JSON.stringify({
      v: 1,
      cs: 0.72,
      fs: 0.2,
      us: 0.08,
      e: "Implement an LRU cache",
    }),
    request
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.value.fieldCodingScores : undefined, {
    codingScore: 0.72,
    fieldKnowledgeScore: 0.2,
    unknownScore: 0.08,
    codingMajorityMargin: 0.44,
  });
  assert.equal(parsed.ok ? parsed.value.questionType : undefined, "coding");
  assert.deepEqual(
    parseQuestionTypeAdjudicationOutput(
      JSON.stringify({
        v: 1,
        cs: 0.6,
        fs: 0.3,
        us: 0.3,
        e: "LRU cache",
      }),
      request
    ),
    {
      ok: false,
      reason: "field-coding-scores-not-normalized",
      errorKind: "schema",
      evidenceSpansValid: false,
    }
  );
});

test("memoizes only cloned parsed candidates under provider and request identity", () => {
  const cache = new QuestionTypeAdjudicationCandidateCache(2);
  const key = buildQuestionTypeAdjudicationCacheKey({
    providerId: "gemini",
    modelId: "flash",
    requestHash: "request-a",
  });
  const candidate = {
    schemaVersion: 1 as const,
    questionType: "coding" as const,
    confidence: 0.7,
    evidenceSpans: ["implement the cache"],
    fieldCodingScores: {
      codingScore: 0.7,
      fieldKnowledgeScore: 0.2,
      unknownScore: 0.1,
      codingMajorityMargin: 0.4,
    },
  };
  cache.write(key, candidate);
  candidate.evidenceSpans[0] = "mutated";

  const firstRead = cache.read(key);
  assert.equal(firstRead?.evidenceSpans[0], "implement the cache");
  firstRead!.fieldCodingScores!.codingScore = 0;
  assert.equal(cache.read(key)?.fieldCodingScores?.codingScore, 0.7);

  cache.write(
    buildQuestionTypeAdjudicationCacheKey({ requestHash: "request-b" }),
    { ...candidate, evidenceSpans: ["b"] }
  );
  cache.write(
    buildQuestionTypeAdjudicationCacheKey({ requestHash: "request-c" }),
    { ...candidate, evidenceSpans: ["c"] }
  );
  assert.equal(cache.read(key), undefined);
  cache.clear();
  assert.equal(
    cache.read(
      buildQuestionTypeAdjudicationCacheKey({ requestHash: "request-c" })
    ),
    undefined
  );
});

test("keeps a full-scope Field Knowledge result observational", () => {
  const base = {
    mode: "enforcement" as const,
    localQuestionType: "unknown",
    candidate: {
      schemaVersion: 1 as const,
      questionType: "field-knowledge" as const,
      confidence: 0.99,
      evidenceSpans: ["explain HNSW"],
    },
    settlement: settleCurrentQuestion({
      currentQuestion: createProvisionalCurrentQuestion({
        logicalQuestionUnit: unit("Please explain HNSW."),
        sourceKind: "voice",
      }),
      llmProposal: createQuestionTypeSettlementProposal({
        currentQuestion: createProvisionalCurrentQuestion({
          logicalQuestionUnit: unit("Please explain HNSW."),
          sourceKind: "voice",
        }),
        adjudication: {
          schemaVersion: 1,
          questionType: "field-knowledge",
          confidence: 0.99,
          evidenceSpans: ["explain HNSW"],
        },
      }),
      manualCorrectionRevision: 0,
      policy: {
        allowLlmTypeRepair: true,
        runtimeMutationAuthorized: true,
        questionComplete: true,
        commitParent: false,
      },
    }),
    sourceOwnedSubstantive: true,
    manualAuthorityConflict: false,
    operationLeaseAuthorized: true,
    advisorReleaseWindowOpen: true,
  };

  assert.equal(
    decideQuestionTypeEnforcement({ ...base, reviewScope: "full" }).reason,
    "field-knowledge-requires-narrow-review"
  );
  const narrowCandidate = {
    schemaVersion: 1 as const,
    questionType: "coding" as const,
    confidence: 0.62,
    evidenceSpans: ["explain HNSW"],
    fieldCodingScores: {
      codingScore: 0.62,
      fieldKnowledgeScore: 0.28,
      unknownScore: 0.1,
      codingMajorityMargin: 0.24,
    },
  };
  const narrowCurrentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: unit("Please explain HNSW."),
    sourceKind: "voice",
  });
  const narrowSettlement = settleCurrentQuestion({
    currentQuestion: narrowCurrentQuestion,
    llmProposal: createQuestionTypeSettlementProposal({
      currentQuestion: narrowCurrentQuestion,
      adjudication: narrowCandidate,
    }),
    manualCorrectionRevision: 0,
    policy: {
      allowLlmTypeRepair: true,
      llmTypeRepairMinConfidence: 0.5,
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: false,
    },
  });
  assert.equal(
    decideQuestionTypeEnforcement({
      ...base,
      candidate: narrowCandidate,
      settlement: narrowSettlement,
      reviewScope: "field-vs-coding",
    }).authorized,
    true
  );
});

test("keeps Field when Coding does not beat Field and Unknown combined", () => {
  const request = buildQuestionTypeAdjudicationRequest({
    logicalQuestionUnit: unit("Explain how a stack differs from a queue."),
    reviewScope: "field-vs-coding",
  });
  const parsed = parseQuestionTypeAdjudicationOutput(
    JSON.stringify({
      v: 1,
      cs: 0.46,
      fs: 0.44,
      us: 0.1,
      e: "stack differs from a queue",
    }),
    request
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.questionType, "field-knowledge");
  assert.equal(
    decideQuestionTypeEnforcement({
      mode: "enforcement",
      localQuestionType: "field-knowledge",
      candidate: parsed.value,
      settlement: undefined,
      sourceOwnedSubstantive: true,
      manualAuthorityConflict: false,
      operationLeaseAuthorized: true,
      advisorReleaseWindowOpen: true,
      reviewScope: "field-vs-coding",
    }).reason,
    "field-coding-majority-not-met"
  );
});

test("requires automatic Field Knowledge review even when broad adjudication is off", () => {
  const request = buildQuestionTypeAdjudicationRequest({
    logicalQuestionUnit: unit("Implement an LRU cache."),
    reviewScope: "field-vs-coding",
  });
  const lexical = inferQuestionTypeDecisionFromText(
    "Explain how an LRU cache should be implemented."
  );
  const required = decideQuestionTypeAdjudicationEligibility({
    mode: "off",
    speaker: "them",
    projection: request.question,
    lexical,
    manualCorrectionActive: false,
    turnGateAction: "answer-refresh",
    mandatoryFieldKnowledgeReview: true,
  });
  assert.equal(required.eligible, true);
  assert.equal(required.executionMode, "enforcement-window");
  assert.equal(required.reason, "field-knowledge-review-required");
  assert.ok(
    FIELD_KNOWLEDGE_REVIEW_WAIT_BUDGET_MS >
      QUESTION_TYPE_ENFORCEMENT_WAIT_BUDGET_MS
  );

  const manual = decideQuestionTypeAdjudicationEligibility({
    mode: "off",
    speaker: "them",
    projection: request.question,
    lexical,
    manualCorrectionActive: true,
    turnGateAction: "answer-refresh",
    mandatoryFieldKnowledgeReview: true,
  });
  assert.equal(manual.executionMode, "shadow-observation");
  assert.equal(manual.reason, "manual-correction-shadow-observation");
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
