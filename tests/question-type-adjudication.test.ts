import assert from "node:assert/strict";
import test from "node:test";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import {
  QUESTION_TYPE_ENFORCEMENT_WAIT_BUDGET_MS,
  SCREEN_FIELD_KNOWLEDGE_REVIEW_WAIT_BUDGET_MS,
  VOICE_FIRST_PARENT_QUESTION_TYPE_WAIT_BUDGET_MS,
  QuestionTypeAdjudicationCandidateCache,
  buildQuestionTypeAdjudicationCacheKey,
  buildQuestionTypeAdjudicationPrompts,
  buildQuestionTypeAdjudicationRequest,
  createQuestionTypeSettlementProposal,
  decideOrderedVoiceQuestionTypeResolution,
  decideQuestionTypeAdjudicationEligibility,
  decideQuestionTypeEnforcement,
  normalizeQuestionTypeAdjudicationMode,
  parseQuestionTypeAdjudicationOutput,
  resolveVoiceQuestionTypeForegroundBudget,
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
  assert.match(prompts.systemPrompt, /"v":1,"t":/i);
  assert.doesNotMatch(prompts.systemPrompt, /evidenceSpans must contain/i);
  assert.match(
    prompts.systemPrompt,
    /named candidate project.*actual project facts/i
  );
  assert.doesNotMatch(
    prompts.userMessage,
    /lexical|semantic|activeParent|playbookPhase/i
  );
});

test("passes current branch type only as a bounded prior for elliptical asks", () => {
  const request = buildQuestionTypeAdjudicationRequest({
    logicalQuestionUnit: unit("What would you monitor in production?"),
    structuredHints: {
      currentBranchType: "ai-ml-system-design",
      lexicalCandidateType: "project-deep-dive",
      lexicalPattern: "exact-project-deep-dive",
    },
  });
  const prompts = buildQuestionTypeAdjudicationPrompts(request);

  assert.deepEqual(request.structuredHints, {
    currentBranchType: "ai-ml-system-design",
    sectionHintType: undefined,
    sectionHintSource: undefined,
    openingRouteKind: undefined,
    openingRouteType: undefined,
    lexicalPattern: "exact-project-deep-dive",
    lexicalCandidateType: "project-deep-dive",
    preparationPriorType: undefined,
  });
  assert.match(prompts.systemPrompt, /elliptical or context-dependent/i);
  assert.match(prompts.systemPrompt, /currentBranchType/);
  assert.match(prompts.userMessage, /"currentBranchType":"ai-ml-system-design"/);
  assert.doesNotMatch(prompts.userMessage, /RAG|parent topic|previous answer/i);
});

test("Broad Type prompt defines required numeric confidence without changing its payload", () => {
  const request = buildQuestionTypeAdjudicationRequest({
    logicalQuestionUnit: unit("For this design, implement the retrieval API in Python."),
    structuredHints: { currentBranchType: "ai-ml-system-design" },
  });
  const prompts = buildQuestionTypeAdjudicationPrompts(request);
  assert.equal(request.promptVersion, "question-type-adjudication-v7");
  assert.match(prompts.systemPrompt, /c is your confidence that the selected t is the correct question type/);
  assert.match(prompts.systemPrompt, /required for every t, including unknown/);
  assert.match(prompts.systemPrompt, /JSON number between 0 and 1 inclusive/);
  assert.match(prompts.systemPrompt, /never a percentage or a string/);
  assert.match(prompts.systemPrompt, /Always include v, t, c, and e\. Only r is optional/);
  assert.deepEqual(JSON.parse(prompts.userMessage), {
    question: { sourceTexts: ["For this design, implement the retrieval API in Python."] },
    nonAuthoritativeHints: { currentBranchType: "ai-ml-system-design" },
  });
  const narrow = buildQuestionTypeAdjudicationPrompts({ ...request, reviewScope: "field-vs-coding" });
  assert.doesNotMatch(narrow.systemPrompt, /c is your confidence|Always include v, t, c, and e/);
  assert.match(narrow.systemPrompt, /three scores must sum to 1/);
});

test("Broad Type parser still rejects missing, nonnumeric and out-of-range confidence", () => {
  const request = buildQuestionTypeAdjudicationRequest({
    logicalQuestionUnit: unit("Implement the retrieval API in Python."),
  });
  for (const c of [undefined, null, "0.95", true, -0.01, 1.01, 10, 63]) {
    assert.deepEqual(parseQuestionTypeAdjudicationOutput(JSON.stringify({
      v: 1, t: "coding", c, e: "Implement the retrieval API",
    }), request), {
      ok: false, reason: "invalid-confidence", errorKind: "schema", evidenceSpansValid: false,
    }, `confidence ${String(c)}`);
  }
  assert.equal(parseQuestionTypeAdjudicationOutput(
    '{"v":1,"t":"coding","c":1e309,"e":"Implement the retrieval API"}', request
  ).ok, false);
});

test("Broad Type parser accepts inclusive confidence bounds for known and unknown types", () => {
  const request = buildQuestionTypeAdjudicationRequest({
    logicalQuestionUnit: unit("Implement the retrieval API in Python."),
  });
  for (const t of ["coding", "unknown"]) {
    for (const c of [0, 0.95, 1]) {
      const parsed = parseQuestionTypeAdjudicationOutput(JSON.stringify({
        v: 1, t, c, e: "Implement the retrieval API",
      }), request);
      assert.equal(parsed.ok, true);
      if (parsed.ok) assert.equal(parsed.value.confidence, c);
    }
  }
});

test("passes bounded source hints without granting them prompt authority", () => {
  const request = buildQuestionTypeAdjudicationRequest({
    logicalQuestionUnit: unit("Please design a URL shortener."),
    structuredHints: {
      sectionHintType: "general-system-design",
      sectionHintSource: "immediate-transition",
      openingRouteKind: "project-intro",
      openingRouteType: "project-deep-dive",
      lexicalPattern: "exact-general-system-design",
      lexicalCandidateType: "general-system-design",
    },
  });
  const prompts = buildQuestionTypeAdjudicationPrompts(request);

  assert.deepEqual(request.structuredHints, {
    currentBranchType: undefined,
    sectionHintType: "general-system-design",
    sectionHintSource: "immediate-transition",
    openingRouteKind: "project-intro",
    openingRouteType: "project-deep-dive",
    lexicalPattern: "exact-general-system-design",
    lexicalCandidateType: "general-system-design",
    preparationPriorType: undefined,
  });
  assert.match(prompts.systemPrompt, /nonAuthoritativeHints/i);
  assert.match(prompts.userMessage, /exact-general-system-design/);
  assert.doesNotMatch(prompts.systemPrompt, /direct-concept-question/);
});

test("orders Voice type resolution as LLM, section hint, current type, then Unknown", () => {
  assert.deepEqual(
    decideOrderedVoiceQuestionTypeResolution({
      llmSettlement: {
        questionType: "coding",
        confidence: 0.72,
        typeMutationAuthorized: true,
      },
      llmAuthorized: true,
      sectionHintType: "general-system-design",
      currentBranchType: "behavioral",
    }),
    {
      questionType: "coding",
      stage: "runtime-llm",
      reason: "valid-runtime-question-type",
      confidence: 0.72,
      typeEvidenceAuthorized: true,
    }
  );
  assert.equal(
    decideOrderedVoiceQuestionTypeResolution({
      llmAuthorized: false,
      sectionHintType: "ai-ml-system-design",
      currentBranchType: "coding",
    }).stage,
    "section-hint-fallback"
  );
  assert.deepEqual(
    decideOrderedVoiceQuestionTypeResolution({
      llmAuthorized: false,
      currentBranchType: "field-knowledge",
    }),
    {
      questionType: "field-knowledge",
      stage: "preserve-current-type",
      reason: "runtime-unresolved-preserve-current-type",
      confidence: 1,
      typeEvidenceAuthorized: true,
    }
  );
  assert.equal(
    decideOrderedVoiceQuestionTypeResolution({ llmAuthorized: false }).stage,
    "no-prior-unknown"
  );
});

test("uses correction-owned semantic text without changing LQU identity", () => {
  const logicalQuestionUnit = unit(
    "Design a ride-sharing system for trip planning.",
    2
  );
  const request = buildQuestionTypeAdjudicationRequest({
    logicalQuestionUnit,
    semanticQuestionText:
      'Design a RAG system for trip planning. [Manual term correction: "ride-sharing" means "RAG".]',
  });

  assert.equal(
    request.logicalQuestionUnitId,
    logicalQuestionUnit.id
  );
  assert.equal(request.logicalQuestionUnitRevision, 2);
  assert.deepEqual(request.question.sourceTurnIds, ["turn-a"]);
  assert.match(request.question.text, /Design a RAG system/);
  assert.doesNotMatch(
    request.question.text.split(" ").slice(0, 8).join(" "),
    /Design a ride-sharing system/
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

test("accepts a full-scope Field Knowledge result from the Voice resolver", () => {
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
        allowRuntimeTypeAdjudication: true,
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
    decideQuestionTypeEnforcement({ ...base, reviewScope: "full" }).authorized,
    true
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
      allowRuntimeTypeAdjudication: true,
      runtimeTypeAdjudicationMinConfidence: 0.5,
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

test("requires automatic Screen Field Knowledge review even when broad adjudication is off", () => {
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
    SCREEN_FIELD_KNOWLEDGE_REVIEW_WAIT_BUDGET_MS >
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

test("gives only the first Voice parent a four-second type foreground window", () => {
  assert.deepEqual(
    resolveVoiceQuestionTypeForegroundBudget({
      enforcementWindowRequested: true,
      scheduledWaitBudgetMs: QUESTION_TYPE_ENFORCEMENT_WAIT_BUDGET_MS,
      hasActiveParent: false,
    }),
    {
      waitBudgetMs: VOICE_FIRST_PARENT_QUESTION_TYPE_WAIT_BUDGET_MS,
      firstParentBudgetApplied: true,
    }
  );
  assert.deepEqual(
    resolveVoiceQuestionTypeForegroundBudget({
      enforcementWindowRequested: true,
      scheduledWaitBudgetMs: QUESTION_TYPE_ENFORCEMENT_WAIT_BUDGET_MS,
      hasActiveParent: true,
    }),
    {
      waitBudgetMs: QUESTION_TYPE_ENFORCEMENT_WAIT_BUDGET_MS,
      firstParentBudgetApplied: false,
    }
  );
  assert.deepEqual(
    resolveVoiceQuestionTypeForegroundBudget({
      enforcementWindowRequested: false,
      scheduledWaitBudgetMs: QUESTION_TYPE_ENFORCEMENT_WAIT_BUDGET_MS,
      hasActiveParent: false,
    }),
    {
      waitBudgetMs: 0,
      firstParentBudgetApplied: false,
    }
  );
});

test("strictly parses grounded type output and rejects broader authority", () => {
  const request = buildQuestionTypeAdjudicationRequest({
    logicalQuestionUnit: unit(
      "Design a RAG system for a trip planning app."
    ),
  });
  const valid = {
    v: 1,
    t: "ai-ml-system-design",
    c: 0.94,
    e: "RAG system",
  };

  const parsed = parseQuestionTypeAdjudicationOutput(
    JSON.stringify(valid),
    request
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.value : undefined, {
    schemaVersion: 1,
    questionType: "ai-ml-system-design",
    confidence: 0.94,
    evidenceSpans: ["RAG system"],
    ambiguityReason: undefined,
  });
  assert.ok(JSON.stringify(valid).length < 100);
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
        e: "vector database benchmark",
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
  assert.deepEqual(
    parseQuestionTypeAdjudicationOutput(
      JSON.stringify({
        schemaVersion: 1,
        questionType: "ai-ml-system-design",
        confidence: 0.94,
        evidenceSpans: ["RAG system"],
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
      '{"schemaVersion":1,"questionType":"behavioral","confidence":0.93,"evidence',
      request
    ),
    {
      ok: false,
      reason: "truncated-json",
      errorKind: "parse",
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

test("forces correction-owned Question Type through the registered enforcement window", () => {
  const request = buildQuestionTypeAdjudicationRequest({
    logicalQuestionUnit: unit("Design a RAG system for trip planning."),
  });
  const exactHigh = inferQuestionTypeDecisionFromText(request.question.text);
  const decision = decideQuestionTypeAdjudicationEligibility({
    mode: "off",
    speaker: "them",
    projection: request.question,
    lexical: exactHigh,
    manualCorrectionActive: false,
    turnGateAction: "answer-refresh",
    forceRuntimeExecution: true,
  });

  assert.equal(decision.eligible, true);
  assert.equal(decision.executionMode, "enforcement-window");
  assert.equal(decision.reason, "correction-owned-runtime-execution");
});

test("reviews every eligible substantive Voice question in enforcement mode", () => {
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
  assert.equal(simple.executionMode, "enforcement-window");
  assert.equal(simple.reason, "enforcement-review-required");
  assert.ok(simple.triggerReasons.includes("local-type-prompt-hint"));

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
      "local-type-prompt-hint"
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
    "enforcement"
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
      allowRuntimeTypeAdjudication: false,
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
      allowRuntimeTypeAdjudication: true,
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
    "runtime-adjudication"
  );
  assert.equal(enforcementPreview.relation, "unknown");
  assert.equal(enforcementPreview.typeMutationAuthorized, true);
  assert.equal(enforcementPreview.relationMutationAuthorized, false);
  assert.equal(enforcementPreview.parentMutationAuthorized, false);
});

test("authorizes a schema-valid concrete runtime type over the local proposal", () => {
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
      allowRuntimeTypeAdjudication: true,
      runtimeTypeAdjudicationMinConfidence: 0.95,
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
      minimumConfidence: 0,
    }
  );
});

test("keeps type enforcement bounded by authority and timing rather than heuristic confidence", () => {
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
      allowRuntimeTypeAdjudication: true,
      runtimeTypeAdjudicationMinConfidence: 0.95,
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
    }).authorized,
    true
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
