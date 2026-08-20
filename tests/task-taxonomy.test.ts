import assert from "node:assert/strict";
import test from "node:test";
import {
  areCompatibleQuestionTypes,
  buildQuestionTypeKeywordView,
  canQuestionTypeDecisionOverrideParent,
  decideLatestTurnTaxonomyBoundary,
  fromHumanEvalQuestionType,
  fromInterviewBriefType,
  fromMemoryQuestionType,
  fromScreenTaskKind,
  inferCanonicalQuestionTypeFromText,
  inferQuestionTypeDecisionFromText,
  isParentCanonicalQuestionType,
  isQuestionTypeCompatibleWithMemoryFamily,
  memoryFamiliesForQuestionType,
  normalizeCanonicalQuestionType,
  normalizeInterviewBriefTypes,
  normalizeMemoryInterviewTypes,
  normalizeQuestionTypeAlias,
  readInterviewBriefType,
  readSingleConcreteInterviewTypeOverride,
  resolveTaskTaxonomyAuthority,
  toHumanEvalQuestionType,
  toInterviewBriefType,
  toMemoryQuestionType,
  toMemoryUseCaseForQuestionType,
  toScreenTaskKind,
} from "../src/lib/meeting/task-taxonomy.js";

test("accepts ordered source evidence and rejects generated-answer taxonomy", () => {
  assert.deepEqual(
    resolveTaskTaxonomyAuthority({
      candidates: [
        { source: "screen-preflight", questionType: "unknown" },
        {
          source: "screen-source-fallback",
          questionType: "general-system-design",
        },
        { source: "generated-answer", questionType: "coding" },
      ],
    }),
    {
      candidateType: "general-system-design",
      effectiveQuestionType: "general-system-design",
      authoritySource: "screen-source-fallback",
      mutationAuthorized: true,
      mutationApplied: true,
      reason: "authoritative-source-selected",
      generatedAnswerExcluded: true,
      blockedGeneratedAnswerType: "coding",
    }
  );
});

test("preserves an existing task when generated output proposes a retype", () => {
  assert.deepEqual(
    resolveTaskTaxonomyAuthority({
      candidates: [
        { source: "generated-answer", questionType: "coding" },
      ],
      existingQuestionType: "project-deep-dive",
    }),
    {
      effectiveQuestionType: "project-deep-dive",
      authoritySource: "existing-task",
      mutationAuthorized: false,
      mutationApplied: false,
      reason: "existing-task-preserved",
      generatedAnswerExcluded: true,
      blockedGeneratedAnswerType: "coding",
    }
  );
});

test("keeps unknown when generated output is the only classification signal", () => {
  assert.deepEqual(
    resolveTaskTaxonomyAuthority({
      candidates: [
        { source: "generated-answer", questionType: "coding" },
      ],
    }),
    {
      effectiveQuestionType: "unknown",
      authoritySource: "none",
      mutationAuthorized: false,
      mutationApplied: false,
      reason: "generated-answer-blocked",
      generatedAnswerExcluded: true,
      blockedGeneratedAnswerType: "coding",
    }
  );
});

test("keeps manual correction authoritative over generated answer content", () => {
  const decision = resolveTaskTaxonomyAuthority({
    candidates: [
      { source: "generated-answer", questionType: "coding" },
      { source: "manual-correction", questionType: "behavioral" },
    ],
    existingQuestionType: "project-deep-dive",
  });

  assert.equal(decision.effectiveQuestionType, "behavioral");
  assert.equal(decision.authoritySource, "manual-correction");
  assert.equal(decision.mutationAuthorized, true);
  assert.equal(decision.mutationApplied, true);
  assert.equal(decision.generatedAnswerExcluded, true);
  assert.equal(decision.blockedGeneratedAnswerType, "coding");
});

test("normalizes legacy system-design alias to the canonical general-system-design type", () => {
  assert.equal(
    normalizeCanonicalQuestionType("system-design"),
    "general-system-design"
  );
  assert.equal(
    normalizeQuestionTypeAlias("system-design"),
    "general-system-design"
  );
  assert.equal(
    fromScreenTaskKind("system-design"),
    "general-system-design"
  );
  assert.equal(
    fromMemoryQuestionType("system-design"),
    "general-system-design"
  );
  assert.equal(
    fromHumanEvalQuestionType("system-design"),
    "general-system-design"
  );
  assert.equal(
    areCompatibleQuestionTypes("system-design", "general-system-design"),
    true
  );
});

test("keeps transitional screen-only labels out of canonical question types", () => {
  assert.equal(normalizeCanonicalQuestionType("ambiguous"), undefined);
  assert.equal(normalizeCanonicalQuestionType("non-question"), undefined);
  assert.equal(normalizeQuestionTypeAlias("ambiguous"), "ambiguous");
  assert.equal(normalizeQuestionTypeAlias("non-question"), "non-question");
});

test("maps interview brief UI values through canonical runtime values", () => {
  assert.equal(
    readInterviewBriefType("general-system-design"),
    "system-design"
  );
  assert.equal(
    fromInterviewBriefType("system-design"),
    "general-system-design"
  );
  assert.equal(
    toInterviewBriefType("general-system-design"),
    "system-design"
  );
  assert.equal(toInterviewBriefType("field-knowledge"), undefined);
  assert.equal(
    readSingleConcreteInterviewTypeOverride({
      interviewTypes: ["system-design"],
    }),
    "general-system-design"
  );
  assert.equal(
    readSingleConcreteInterviewTypeOverride({
      interviewTypes: ["system-design", "mixed"],
    }),
    undefined
  );
});

test("normalizes interview brief selections to explicit concrete types", () => {
  assert.deepEqual(
    normalizeInterviewBriefTypes(["behavioral", "coding"]),
    ["behavioral", "coding"]
  );
  assert.deepEqual(
    normalizeInterviewBriefTypes(["mixed"]),
    [
      "behavioral",
      "coding",
      "system-design",
      "ai-ml-system-design",
      "project-deep-dive",
    ]
  );
  assert.deepEqual(
    normalizeInterviewBriefTypes([
      "behavioral",
      "coding",
      "system-design",
      "ai-ml-system-design",
      "project-deep-dive",
    ]),
    [
      "behavioral",
      "coding",
      "system-design",
      "ai-ml-system-design",
      "project-deep-dive",
    ]
  );
});

test("maps canonical question types to memory use cases and memory families", () => {
  assert.equal(
    toMemoryUseCaseForQuestionType("meeting_assistant", "behavioral"),
    "behavioral_interview"
  );
  assert.equal(
    toMemoryUseCaseForQuestionType("meeting_assistant", "coding"),
    "coding_interview"
  );
  assert.equal(
    toMemoryUseCaseForQuestionType(
      "behavioral_interview",
      "ai-ml-system-design"
    ),
    "aiml_system_design_interview"
  );
  assert.equal(
    toMemoryUseCaseForQuestionType(
      "coding_interview",
      "general-system-design"
    ),
    "system_design_interview"
  );
  assert.equal(
    toMemoryUseCaseForQuestionType(
      "coding_interview",
      "project-deep-dive"
    ),
    "project_deep_dive"
  );
  assert.equal(
    toMemoryUseCaseForQuestionType("coding_interview", "field-knowledge"),
    "meeting_assistant"
  );
  assert.deepEqual(memoryFamiliesForQuestionType("behavioral"), [
    "behavioral",
  ]);
  assert.deepEqual(memoryFamiliesForQuestionType("general-system-design"), [
    "system-design",
  ]);
  assert.deepEqual(memoryFamiliesForQuestionType("field-knowledge"), [
    "ai-ml-system-design",
    "system-design",
  ]);
  assert.equal(
    isQuestionTypeCompatibleWithMemoryFamily("system-design", "system-design"),
    true
  );
  assert.equal(
    isQuestionTypeCompatibleWithMemoryFamily("behavioral", "system-design"),
    false
  );
  assert.equal(
    isQuestionTypeCompatibleWithMemoryFamily(
      "field-knowledge",
      "project-deep-dive"
    ),
    false
  );
});

test("normalizes memory interview family lists without treating family labels as canonical question types", () => {
  assert.deepEqual(
    normalizeMemoryInterviewTypes(["system-design", "mixed", "system-design"]),
    ["system-design", "mixed"]
  );
  assert.equal(normalizeMemoryInterviewTypes(undefined), undefined);
});

test("maps canonical values to boundary types", () => {
  assert.equal(toScreenTaskKind("field-knowledge"), "field-knowledge");
  assert.equal(toScreenTaskKind("non-question"), "non-question");
  assert.equal(toMemoryQuestionType("general-system-design"), "general-system-design");
  assert.equal(toHumanEvalQuestionType("general-system-design"), "general-system-design");
});

test("identifies parent-eligible canonical task types", () => {
  assert.equal(isParentCanonicalQuestionType("behavioral"), true);
  assert.equal(isParentCanonicalQuestionType("coding"), true);
  assert.equal(isParentCanonicalQuestionType("field-knowledge"), false);
  assert.equal(isParentCanonicalQuestionType("unknown"), false);
});

test("infers canonical question type from lightweight text signals", () => {
  assert.equal(
    inferCanonicalQuestionTypeFromText("Design a ticket selling system"),
    "general-system-design"
  );
  assert.equal(
    inferCanonicalQuestionTypeFromText("Design a RAG evaluation platform"),
    "ai-ml-system-design"
  );
  assert.equal(
    inferCanonicalQuestionTypeFromText("Tell me about a time you missed a commitment"),
    "behavioral"
  );
  assert.equal(
    inferCanonicalQuestionTypeFromText("Walk me through your project architecture"),
    "project-deep-dive"
  );
  assert.equal(
    inferCanonicalQuestionTypeFromText("Explain the tradeoff between BM25 and dense retrieval"),
    "field-knowledge"
  );
  assert.equal(inferCanonicalQuestionTypeFromText("hello"), undefined);
});

test("uses a keyword-only canonical view for polite article-bearing design asks", () => {
  const source = "Please design a URL shortener for me.";
  const keywordView = buildQuestionTypeKeywordView(source);

  assert.equal(keywordView.text, "design url shortener for me");
  assert.equal(keywordView.sourceTextLength, source.length);
  assert.equal(keywordView.applied, true);
  assert.deepEqual(keywordView.transformations, [
    "leading-politeness",
    "command-object-article",
  ]);
  assert.equal(
    inferCanonicalQuestionTypeFromText(source),
    "general-system-design"
  );
  assert.equal(
    inferCanonicalQuestionTypeFromText("Design URL shortener."),
    "general-system-design"
  );
});

test("keeps coding and project hard negatives ahead of canonical design admission", () => {
  assert.equal(
    inferCanonicalQuestionTypeFromText("Please design an algorithm for top k"),
    "coding"
  );
  assert.equal(
    inferCanonicalQuestionTypeFromText(
      "Could you please walk me through the URL shortener you built?"
    ),
    "project-deep-dive"
  );
});

test("uses action, object, and frame together for implement and stack questions", () => {
  assert.equal(
    inferCanonicalQuestionTypeFromText(
      "How did you implement this feature in production?"
    ),
    "project-deep-dive"
  );
  assert.equal(
    inferCanonicalQuestionTypeFromText(
      "Implement a scalable ticketing service"
    ),
    "general-system-design"
  );
  assert.equal(
    inferCanonicalQuestionTypeFromText("Implement a stack using two queues"),
    "coding"
  );
  assert.equal(
    inferCanonicalQuestionTypeFromText("Explain the stack data structure"),
    "field-knowledge"
  );
  assert.equal(inferCanonicalQuestionTypeFromText("implement"), undefined);
  assert.equal(
    inferCanonicalQuestionTypeFromText("What is your tech stack?"),
    "project-deep-dive"
  );
});

test("keeps the recorded recruiter project sequence out of coding", () => {
  const projectQuestions = [
    "Have you shipped a production backend API for an AI product?",
    "What was your specific personal contribution to the stack?",
    "What backend systems, key-value stores, vector databases, or caches did you use?",
    "How did you test it before production?",
    "Who were your primary partners and stakeholders?",
  ];

  for (const question of projectQuestions) {
    assert.equal(
      inferCanonicalQuestionTypeFromText(question),
      "project-deep-dive",
      question
    );
  }
});

test("recognizes a generic past-project depth frame without phrase-specific recruiter rules", () => {
  for (const question of [
    "What is the hardest technical project you have worked on?",
    "What was the most challenging system you built?",
    "Which project in your work had the greatest impact?",
  ]) {
    const decision = inferQuestionTypeDecisionFromText(question);
    assert.equal(decision.type, "project-deep-dive", question);
    assert.ok(decision.confidence >= 0.95, question);
    assert.ok(
      decision.evidence.includes("past-project-depth-frame"),
      question
    );
  }
});

test("keeps generic complexity language out of the past-project signal", () => {
  for (const question of [
    "What is the hardest part of distributed systems?",
    "Design the most complex system you can for this workload.",
    "What makes this algorithm challenging?",
  ]) {
    const decision = inferQuestionTypeDecisionFromText(question);
    assert.notEqual(decision.type, "project-deep-dive", question);
    assert.ok(
      !decision.evidence.includes("past-project-depth-frame"),
      question
    );
  }
});

test("returns evidence and confidence without promoting ambiguous vocabulary", () => {
  const projectDecision = inferQuestionTypeDecisionFromText(
    "What was your specific personal contribution to the stack?"
  );
  assert.equal(projectDecision.type, "project-deep-dive");
  assert.ok(projectDecision.confidence >= 0.8);
  assert.ok(projectDecision.margin >= 0.25);
  assert.ok(projectDecision.evidence.includes("past-project-intent"));
  assert.ok(projectDecision.ambiguousTerms.includes("stack"));
  assert.equal(canQuestionTypeDecisionOverrideParent(projectDecision), true);

  const ambiguousDecision = inferQuestionTypeDecisionFromText(
    "We used Java and a graph in the backend stack"
  );
  assert.notEqual(ambiguousDecision.type, "coding");
  assert.ok(ambiguousDecision.ambiguousTerms.includes("java"));
  assert.ok(ambiguousDecision.ambiguousTerms.includes("graph"));
  assert.equal(canQuestionTypeDecisionOverrideParent(ambiguousDecision), false);
});

test("preserves explicit coding signals despite project vocabulary", () => {
  assert.equal(
    inferCanonicalQuestionTypeFromText(
      "Implement a stack using two queues and explain the time complexity"
    ),
    "coding"
  );
  assert.equal(
    inferCanonicalQuestionTypeFromText(
      "What is the time complexity of this monotonic stack solution?"
    ),
    "coding"
  );
});

test("recognizes algorithm design and explicit code output requests", () => {
  for (const question of [
    "Design an algorithm to find every text file under a directory",
    "Come up with an optimal algorithm for sliding window maximum",
    "Please write the complete code for this solution",
    "Implement a method that returns all matching paths",
    "Transformers, like, show how you write the transformers for me in Python.",
    "Can you show me how to implement multi-head attention in Python?",
  ]) {
    const decision = inferQuestionTypeDecisionFromText(question);
    assert.equal(decision.type, "coding", question);
    assert.ok(decision.confidence >= 0.9, question);
  }
});

test("keeps language-bound implementation evidence behind stronger conflict frames", () => {
  const projectDecision = inferQuestionTypeDecisionFromText(
    "Show me how you implemented the transformer service in your previous project using Python"
  );
  assert.equal(projectDecision.type, "project-deep-dive");
  assert.ok(
    !projectDecision.evidence.includes(
      "language-bound-implementation-demonstration"
    )
  );

  const systemDesignDecision = inferQuestionTypeDecisionFromText(
    "Show me how you would implement a scalable model serving platform in Python"
  );
  assert.equal(systemDesignDecision.type, "ai-ml-system-design");
  assert.ok(
    !systemDesignDecision.evidence.includes(
      "language-bound-implementation-demonstration"
    )
  );
});

test("uses a single Coding brief only as a compatible prior", () => {
  const compatible = inferQuestionTypeDecisionFromText(
    "Would the code be different if I need every matching file?",
    { interviewSessionBrief: { interviewTypes: ["coding"] } }
  );
  assert.equal(compatible.type, undefined);
  assert.equal(compatible.legacyType, "coding");
  assert.equal(compatible.certainty, "abstain");
  assert.equal(compatible.authorityReason, "legacy-score-only");
  assert.equal(compatible.briefPriorType, "coding");
  assert.equal(compatible.briefCompatibilityDecision, "applied-coding-prior");
  assert.ok(compatible.evidence.includes("coding-brief-compatible-prior"));

  const withoutEvidence = inferQuestionTypeDecisionFromText(
    "Tell me more about that",
    { interviewSessionBrief: { interviewTypes: ["coding"] } }
  );
  assert.equal(withoutEvidence.type, undefined);
  assert.equal(
    withoutEvidence.briefCompatibilityDecision,
    "no-compatible-coding-evidence"
  );
});

test("does not let a Coding brief override stronger interview frames", () => {
  const cases = [
    [
      "Tell me about a time you implemented a difficult feature",
      "behavioral",
      "blocked-by-behavioral-frame",
    ],
    [
      "How did you implement this feature in your previous project?",
      "project-deep-dive",
      "blocked-by-project-frame",
    ],
    [
      "Implement a scalable ticketing service with high availability",
      "general-system-design",
      "blocked-by-system-design-frame",
    ],
  ] as const;

  for (const [question, expectedType, expectedBriefDecision] of cases) {
    const decision = inferQuestionTypeDecisionFromText(question, {
      interviewSessionBrief: { interviewTypes: ["coding"] },
    });
    assert.equal(decision.type, expectedType, question);
    assert.equal(
      decision.briefCompatibilityDecision,
      expectedBriefDecision,
      question
    );
  }
});

test("blocks broad-history taxonomy fallback when the latest turn is unknown", () => {
  assert.equal(
    inferCanonicalQuestionTypeFromText(
      "Implement a stack using two queues and explain the time complexity"
    ),
    "coding"
  );

  const latestDecision = inferQuestionTypeDecisionFromText(
    "The control plane sends configuration to the data plane"
  );
  assert.equal(latestDecision.type, undefined);

  const boundary = decideLatestTurnTaxonomyBoundary({
    latestQuestionType: latestDecision.type ?? "unknown",
    hasLatestUsefulText: true,
    hasOpeningRoute: false,
  });

  assert.deepEqual(boundary, {
    questionType: "unknown",
    allowsNewTaskSignal: false,
    fallbackSuppressed: true,
    unknownTaskMutationBlocked: true,
    reason: "latest-turn-unknown",
  });
});

test("allows a strongly classified latest coding turn to open a task", () => {
  const latestDecision = inferQuestionTypeDecisionFromText(
    "Implement a stack using two queues"
  );
  assert.equal(latestDecision.type, "coding");

  assert.deepEqual(
    decideLatestTurnTaxonomyBoundary({
      latestQuestionType: latestDecision.type ?? "unknown",
      hasLatestUsefulText: true,
      hasOpeningRoute: false,
    }),
    {
      questionType: "coding",
      allowsNewTaskSignal: true,
      fallbackSuppressed: false,
      unknownTaskMutationBlocked: false,
      reason: "latest-turn-classified",
    }
  );
});

test("does not open a task when there is no latest useful interviewer turn", () => {
  assert.deepEqual(
    decideLatestTurnTaxonomyBoundary({
      latestQuestionType: "unknown",
      hasLatestUsefulText: false,
      hasOpeningRoute: false,
    }),
    {
      questionType: "unknown",
      allowsNewTaskSignal: false,
      fallbackSuppressed: true,
      unknownTaskMutationBlocked: false,
      reason: "missing-latest-turn",
    }
  );
});

test("classifies explicit AI/ML architecture objects without lowering thresholds", () => {
  const cases = [
    "Design a self-evolving travel recommendation agent",
    "For this app, design a ranking and personalization system",
    "Architect a RAG retrieval pipeline for trip planning",
  ];

  for (const question of cases) {
    const decision = inferQuestionTypeDecisionFromText(question);
    assert.equal(decision.type, "ai-ml-system-design", question);
    assert.ok(decision.confidence >= 0.9, question);
  }
});

test("keeps algorithm implementation distinct from AI/ML system design", () => {
  const decision = inferQuestionTypeDecisionFromText(
    "Design an efficient algorithm for top-k recommendations and implement it in Python"
  );

  assert.equal(decision.type, "coding");
  assert.ok(decision.evidence.includes("algorithm-design-request"));
});
