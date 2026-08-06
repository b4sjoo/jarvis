import assert from "node:assert/strict";
import test from "node:test";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import {
  authorizeTaxonomyAdjudicationLease,
  buildTaxonomyAdjudicationPrompts,
  buildTaxonomyAdjudicationRequest,
  createTaxonomyAdjudicationLease,
  decideTaxonomyAdjudicationBudget,
  decideTaxonomyAdjudicationEligibility,
  type LlmTaxonomyAdjudication,
  parseTaxonomyAdjudicationOutput,
  projectLogicalQuestionForAdjudication,
} from "../src/lib/meeting/taxonomy-adjudication.js";
import { projectPrimaryAsk } from "../src/lib/meeting/primary-ask-projection.js";
import { inferQuestionTypeDecisionFromText } from "../src/lib/meeting/task-taxonomy.js";
import { TAXONOMY_ADJUDICATION_CORPUS } from "./fixtures/taxonomy-adjudication-corpus.js";

function unit(text: string, revision = 1): LogicalQuestionUnit {
  return {
    id: "logical-a",
    revision,
    sessionId: "session-a",
    runtimeEpoch: 2,
    currentTurnId: "turn-a",
    sourceTurnIds: ["turn-a"],
    sources: [
      { turnId: "turn-a", text, startedAt: 10, endedAt: 20 },
    ],
    normalizedText: text,
    startedAt: 10,
    updatedAt: 20,
    compositionReasons: ["independent-current-turn"],
    boundaryReason: "independent-current-turn",
    truncated: false,
  };
}

function answerOutput(
  request: ReturnType<typeof buildTaxonomyAdjudicationRequest>,
  overrides: Partial<LlmTaxonomyAdjudication> = {}
): LlmTaxonomyAdjudication {
  const primarySource =
    request.question.sourceTurns[request.question.sourceTurns.length - 1]!;
  return {
    schemaVersion: 2,
    speechAct: "question",
    questionType: "field-knowledge",
    relation: "new-parent",
    evidenceMode: "factual-explanation",
    action: "answer",
    normalizedQuestion: primarySource.text,
    primaryAskSpans: [primarySource],
    standalone: true,
    evidenceSpans: [request.question.text],
    confidence: 0.9,
    ...overrides,
  };
}

test("isolates ambient adjudication from the reserved substantive slot", () => {
  const acknowledgement = unit("That looks good to me.");
  acknowledgement.primaryAskProjection = projectPrimaryAsk({
    turnId: acknowledgement.currentTurnId,
    text: acknowledgement.normalizedText,
  });
  assert.deepEqual(
    decideTaxonomyAdjudicationBudget({
      logicalQuestionUnit: acknowledgement,
      turnGateAction: "ignore",
    }),
    {
      slot: "ambient",
      reason: "high-confidence-acknowledgement",
      sourceOwnedSubstantive: false,
    }
  );

  const connectivity = unit("Can you hear me?");
  connectivity.primaryAskProjection = projectPrimaryAsk({
    turnId: connectivity.currentTurnId,
    text: connectivity.normalizedText,
  });
  assert.equal(
    decideTaxonomyAdjudicationBudget({
      logicalQuestionUnit: connectivity,
      turnGateAction: "answer-refresh",
    }).slot,
    "ambient"
  );

  for (const text of [
    "Can you explain reciprocal rank fusion?",
    "Thanks, and can you explain RAG?",
  ]) {
    const substantive = unit(text);
    substantive.primaryAskProjection = projectPrimaryAsk({
      turnId: substantive.currentTurnId,
      text,
    });
    assert.deepEqual(
      decideTaxonomyAdjudicationBudget({
        logicalQuestionUnit: substantive,
        turnGateAction: "answer-refresh",
      }),
      {
        slot: "substantive",
        reason: "source-owned-primary-ask",
        sourceOwnedSubstantive: true,
      }
    );
  }
});

test("strictly parses a grounded adjudication and rejects invented evidence", () => {
  const logicalUnit = unit("Design a RAG system for a trip planning app.");
  const request = buildTaxonomyAdjudicationRequest({
    logicalQuestionUnit: logicalUnit,
    activeParent: {
      idHash: "parent-hash",
      questionType: "general-system-design",
      topic: "Design a trip planning app",
    },
  });
  const output = JSON.stringify({
    schemaVersion: 2,
    speechAct: "directive",
    questionType: "ai-ml-system-design",
    relation: "linked-parent-extension",
    evidenceMode: "hypothetical-design",
    action: "answer",
    normalizedQuestion: logicalUnit.normalizedText,
    primaryAskSpans: [
      {
        turnId: "turn-a",
        text: logicalUnit.normalizedText,
      },
    ],
    standalone: true,
    evidenceSpans: ["RAG system", "trip planning app"],
    confidence: 0.92,
  });

  assert.equal(parseTaxonomyAdjudicationOutput(output, request).ok, true);
  const invalid = parseTaxonomyAdjudicationOutput(
    JSON.stringify({
      ...JSON.parse(output),
      evidenceSpans: ["vector database benchmark"],
    }),
    request
  );
  assert.deepEqual(invalid, {
    ok: false,
    reason: "invalid-evidence-span",
    errorKind: "evidence",
    evidenceSpansValid: false,
  });
  assert.doesNotMatch(
    buildTaxonomyAdjudicationPrompts(request).userMessage,
    /api.?key/i
  );
  assert.doesNotMatch(
    buildTaxonomyAdjudicationPrompts(request).userMessage,
    /lexical|semanticCandidate|hybridOutcome/i
  );
  const systemPrompt = buildTaxonomyAdjudicationPrompts(request).systemPrompt;
  for (const questionType of [
    "behavioral",
    "coding",
    "general-system-design",
    "ai-ml-system-design",
    "project-deep-dive",
    "field-knowledge",
    "unknown",
  ]) {
    assert.match(systemPrompt, new RegExp(questionType));
  }
  assert.match(systemPrompt, /logistics.*unknown/i);
});

test("sends the bounded source turn instead of a local primary-ask candidate", () => {
  const text =
    "You can ask team members what challenges they face. How does this role sound relative to what you are looking for?";
  const logicalUnit = unit("How does this role sound relative to what you are looking for?");
  logicalUnit.sources[0]!.text = text;
  logicalUnit.primaryAskProjection = {
    schemaVersion: 2,
    sourceTurnIds: ["turn-a"],
    sourceChars: text.length,
    speechAct: "question",
    normalizedPrimaryAsk:
      "How does this role sound relative to what you are looking for?",
    primaryAskSpans: [],
    setupSpans: [],
    quotedOrFutureExampleSpans: [],
    answerFocusText:
      "How does this role sound relative to what you are looking for?",
    semanticEvidenceText:
      "How does this role sound relative to what you are looking for?",
    answerFocusSpans: [],
    objectSpans: [],
    scenarioSpans: [],
    semanticEvidenceRetentionReasons: ["answer-focus"],
    semanticEvidenceDroppedReasons: [],
    disposition: "answer-primary-ask",
    reason: "test-local-candidate",
    confidence: 0.97,
  };

  const request = buildTaxonomyAdjudicationRequest({
    logicalQuestionUnit: logicalUnit,
  });
  assert.equal(request.question.text, text);
  assert.deepEqual(request.question.sourceTurns, [
    { turnId: "turn-a", text },
  ]);
  const promptPacket = JSON.parse(
    buildTaxonomyAdjudicationPrompts(request).userMessage
  );
  assert.equal("question" in promptPacket, false);
  assert.deepEqual(promptPacket.sources, [
    {
      i: 0,
      k: "q",
      t: "You can ask team members what challenges they face.",
    },
    {
      i: 1,
      k: "q",
      t: "How does this role sound relative to what you are looking for?",
    },
  ]);
  assert.doesNotMatch(
    buildTaxonomyAdjudicationPrompts(request).userMessage,
    /test-local-candidate|answer-primary-ask/
  );
});

test("parses compact v3 source references without requiring model text echoes", () => {
  const sourceText = "Design a RAG system for a trip planning app.";
  const request = buildTaxonomyAdjudicationRequest({
    logicalQuestionUnit: unit(sourceText),
    activeParent: {
      questionType: "general-system-design",
      topic: "Design a trip planning app",
    },
  });
  const prompts = buildTaxonomyAdjudicationPrompts(request);
  const packet = JSON.parse(prompts.userMessage);
  assert.deepEqual(packet.sources, [
    { i: 0, k: "q", t: sourceText },
    { i: 1, k: "p", t: "Design a trip planning app" },
  ]);
  assert.doesNotMatch(prompts.systemPrompt, /normalizedQuestion is/i);

  const parsed = parseTaxonomyAdjudicationOutput(
    JSON.stringify({
      v: 3,
      sa: "directive",
      qt: "ai-ml-system-design",
      rel: "linked-parent-extension",
      em: "hypothetical-design",
      act: "answer",
      pa: [0],
      ev: [0, 1],
      st: true,
      cf: 0.94,
      rc: "parent-link",
    }),
    request
  );

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.outputContractVersion, 3);
    assert.equal(parsed.value.normalizedQuestion, sourceText);
    assert.equal(parsed.value.normalizedQuestionSource, "source-catalog");
    assert.deepEqual(parsed.value.primaryAskSpans, [
      { turnId: "turn-a", text: sourceText },
    ]);
    assert.deepEqual(parsed.value.evidenceSpans, [
      sourceText,
      "Design a trip planning app",
    ]);
  }
});

test("rejects invalid compact references and distinguishes truncated JSON", () => {
  const request = buildTaxonomyAdjudicationRequest({
    logicalQuestionUnit: unit("Design a URL shortener."),
  });
  const compact = {
    v: 3,
    sa: "directive",
    qt: "general-system-design",
    rel: "new-parent",
    em: "hypothetical-design",
    act: "answer",
    pa: [0],
    ev: [0],
    st: true,
    cf: 0.96,
    rc: "clear",
  };

  assert.deepEqual(
    parseTaxonomyAdjudicationOutput(
      JSON.stringify({ ...compact, pa: [99] }),
      request
    ),
    {
      ok: false,
      reason: "invalid-primary-ask-reference",
      errorKind: "evidence",
      evidenceSpansValid: false,
    }
  );
  assert.deepEqual(
    parseTaxonomyAdjudicationOutput('{"v":3,"sa":"directive"', request),
    {
      ok: false,
      reason: "truncated-json",
      errorKind: "parse",
      evidenceSpansValid: false,
    }
  );
});

test("parses recruiter openings, logistics, and dense terminal asks with canonical types", () => {
  const recruiterText =
    "Could you walk me through your background and the work most relevant to this role?";
  const recruiterRequest = buildTaxonomyAdjudicationRequest({
    logicalQuestionUnit: unit(recruiterText),
  });
  const recruiter = parseTaxonomyAdjudicationOutput(
    JSON.stringify(
      answerOutput(recruiterRequest, {
        speechAct: "question",
        questionType: "project-deep-dive",
        evidenceMode: "personal-experience",
        normalizedQuestion: recruiterText,
        primaryAskSpans: [{ turnId: "turn-a", text: recruiterText }],
        evidenceSpans: ["walk me through your background"],
      })
    ),
    recruiterRequest
  );
  assert.equal(recruiter.ok, true);
  if (recruiter.ok) {
    assert.equal(recruiter.value.questionType, "project-deep-dive");
  }

  const logisticsText =
    "The call will take thirty minutes and we will leave time for questions.";
  const logisticsRequest = buildTaxonomyAdjudicationRequest({
    logicalQuestionUnit: unit(logisticsText),
  });
  const logistics = parseTaxonomyAdjudicationOutput(
    JSON.stringify({
      schemaVersion: 2,
      speechAct: "logistics",
      questionType: "unknown",
      relation: "none",
      evidenceMode: "unknown",
      action: "append-context",
      normalizedQuestion: "",
      primaryAskSpans: [],
      standalone: false,
      evidenceSpans: ["The call will take thirty minutes"],
      confidence: 0.97,
    }),
    logisticsRequest
  );
  assert.equal(logistics.ok, true);

  const fillerText = "Sounds good, thank you.";
  const fillerRequest = buildTaxonomyAdjudicationRequest({
    logicalQuestionUnit: unit(fillerText),
  });
  const filler = parseTaxonomyAdjudicationOutput(
    JSON.stringify({
      schemaVersion: 2,
      speechAct: "acknowledgement",
      questionType: "unknown",
      relation: "none",
      evidenceMode: "unknown",
      action: "ignore",
      normalizedQuestion: "",
      primaryAskSpans: [],
      standalone: false,
      evidenceSpans: ["Sounds good"],
      confidence: 0.99,
    }),
    fillerRequest
  );
  assert.equal(filler.ok, true);

  const denseText =
    "You can ask the team what are your challenges and what does the scope look like. How does this sound relative to what you are looking for?";
  const denseRequest = buildTaxonomyAdjudicationRequest({
    logicalQuestionUnit: unit(denseText),
  });
  const terminalAsk =
    "How does this sound relative to what you are looking for?";
  const dense = parseTaxonomyAdjudicationOutput(
    JSON.stringify(
      answerOutput(denseRequest, {
        questionType: "unknown",
        relation: "none",
        evidenceMode: "unknown",
        normalizedQuestion: terminalAsk,
        primaryAskSpans: [{ turnId: "turn-a", text: terminalAsk }],
        evidenceSpans: [terminalAsk],
      })
    ),
    denseRequest
  );
  assert.equal(dense.ok, true);
  if (dense.ok) {
    assert.equal(dense.value.normalizedQuestion, terminalAsk);
    assert.deepEqual(dense.value.primaryAskSpans, [
      { turnId: "turn-a", text: terminalAsk },
    ]);
  }
});

test("keeps duplicate quoted and terminal asks addressable by source turn", () => {
  const repeatedAsk = "How does this role sound relative to what you are looking for?";
  const terminalSpan = `Now for you: ${repeatedAsk}`;
  const logicalUnit = unit(repeatedAsk, 2);
  logicalUnit.currentTurnId = "turn-terminal";
  logicalUnit.sourceTurnIds = ["turn-example", "turn-terminal"];
  logicalUnit.sources = [
    {
      turnId: "turn-example",
      text: `Later you may ask candidates: ${repeatedAsk}`,
      startedAt: 10,
      endedAt: 20,
    },
    {
      turnId: "turn-terminal",
      text: terminalSpan,
      startedAt: 30,
      endedAt: 40,
    },
  ];
  const request = buildTaxonomyAdjudicationRequest({
    logicalQuestionUnit: logicalUnit,
  });

  assert.deepEqual(
    request.question.sourceTurns.map((source) => source.turnId),
    ["turn-example", "turn-terminal"]
  );
  const parsed = parseTaxonomyAdjudicationOutput(
    JSON.stringify(
      answerOutput(request, {
        questionType: "unknown",
        relation: "none",
        evidenceMode: "unknown",
        normalizedQuestion: repeatedAsk,
        primaryAskSpans: [
          { turnId: "turn-terminal", text: terminalSpan },
        ],
        evidenceSpans: [repeatedAsk],
      })
    ),
    request
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.value.primaryAskSpans, [
      { turnId: "turn-terminal", text: terminalSpan },
    ]);
  }

  const wrongSourceTurn = parseTaxonomyAdjudicationOutput(
    JSON.stringify(
      answerOutput(request, {
        questionType: "unknown",
        relation: "none",
        evidenceMode: "unknown",
        normalizedQuestion: repeatedAsk,
        primaryAskSpans: [
          { turnId: "turn-example", text: terminalSpan },
        ],
        evidenceSpans: [repeatedAsk],
      })
    ),
    request
  );
  assert.deepEqual(wrongSourceTurn, {
    ok: false,
    reason: "invalid-primary-ask-span",
    errorKind: "evidence",
    evidenceSpansValid: false,
  });
});

test("repairs a normalized primary ask that drops the source action-object pair", () => {
  const sourceText = "Maybe let's do ride-sharing backend.";
  const request = buildTaxonomyAdjudicationRequest({
    logicalQuestionUnit: unit(sourceText),
  });
  const parsed = parseTaxonomyAdjudicationOutput(
    JSON.stringify(
      answerOutput(request, {
        questionType: "general-system-design",
        relation: "new-parent",
        evidenceMode: "hypothetical-design",
        normalizedQuestion: "design question.",
        primaryAskSpans: [{ turnId: "turn-a", text: sourceText }],
        evidenceSpans: [sourceText],
      })
    ),
    request
  );

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.normalizedQuestion, sourceText);
    assert.equal(
      parsed.value.normalizedQuestionSource,
      "source-primary-ask-repair"
    );
    assert.equal(
      parsed.value.normalizedQuestionRepairReason,
      "action-object-not-preserved"
    );
  }
});

test("accepts direct, fenced, and bounded one-level JSON wrappers", () => {
  const request = buildTaxonomyAdjudicationRequest({
    logicalQuestionUnit: unit("What is reciprocal rank fusion?"),
  });
  const output = answerOutput(request);
  const fixtures = [
    {
      raw: JSON.stringify(output),
      envelope: "direct",
    },
    {
      raw: `\`\`\`json\n${JSON.stringify(output)}\n\`\`\``,
      envelope: "json-code-fence",
    },
    {
      raw: JSON.stringify({ result: output }),
      envelope: "result-wrapper",
    },
    {
      raw: JSON.stringify({
        output: `\`\`\`json\n${JSON.stringify(output)}\n\`\`\``,
      }),
      envelope: "output-wrapper",
    },
    {
      raw: JSON.stringify({ response: output }),
      envelope: "response-wrapper",
    },
  ] as const;

  for (const fixture of fixtures) {
    const parsed = parseTaxonomyAdjudicationOutput(fixture.raw, request);
    assert.equal(parsed.ok, true, fixture.envelope);
    if (parsed.ok) assert.equal(parsed.envelope, fixture.envelope);
  }
});

test("rejects invalid canonical enums and incomplete answer schemas", () => {
  const request = buildTaxonomyAdjudicationRequest({
    logicalQuestionUnit: unit("What is reciprocal rank fusion?"),
  });
  const valid = answerOutput(request);
  const invalidEnum = parseTaxonomyAdjudicationOutput(
    JSON.stringify({ ...valid, questionType: "logistical" }),
    request
  );
  assert.deepEqual(invalidEnum, {
    ok: false,
    reason: "invalid-question-type",
    errorKind: "schema",
    evidenceSpansValid: false,
  });

  const { primaryAskSpans: _omitted, ...missingPrimaryAskSpans } = valid;
  const invalidSchema = parseTaxonomyAdjudicationOutput(
    JSON.stringify(missingPrimaryAskSpans),
    request
  );
  assert.deepEqual(invalidSchema, {
    ok: false,
    reason: "invalid-primary-ask-spans",
    errorKind: "schema",
    evidenceSpansValid: false,
  });

  const invalidWrapper = parseTaxonomyAdjudicationOutput(
    JSON.stringify({ payload: valid }),
    request
  );
  assert.deepEqual(invalidWrapper, {
    ok: false,
    reason: "invalid-output-wrapper",
    errorKind: "parse",
    evidenceSpansValid: false,
  });

  const malformed = parseTaxonomyAdjudicationOutput("{not-json", request);
  assert.deepEqual(malformed, {
    ok: false,
    reason: "truncated-json",
    errorKind: "parse",
    evidenceSpansValid: false,
  });

  const invalidPrimaryAsk = parseTaxonomyAdjudicationOutput(
    JSON.stringify({
      ...valid,
      primaryAskSpans: [
        {
          turnId: "turn-missing",
          text: "invented terminal ask",
        },
      ],
    }),
    request
  );
  assert.deepEqual(invalidPrimaryAsk, {
    ok: false,
    reason: "invalid-primary-ask-span",
    errorKind: "evidence",
    evidenceSpansValid: false,
  });
});

test("preserves first anchor and latest constraint when projecting overflow", () => {
  const logicalUnit = unit("ignored");
  logicalUnit.sourceTurnIds = ["turn-a", "turn-b", "turn-c"];
  logicalUnit.sources = [
    {
      turnId: "turn-a",
      text: `Design an enterprise retrieval service ${"anchor ".repeat(120)}`,
      startedAt: 10,
      endedAt: 20,
    },
    {
      turnId: "turn-b",
      text: `Some repeated background ${"filler ".repeat(180)}`,
      startedAt: 30,
      endedAt: 40,
    },
    {
      turnId: "turn-c",
      text: "Now switch to hybrid search and keep p99 latency under 100ms.",
      startedAt: 50,
      endedAt: 60,
    },
  ];
  logicalUnit.normalizedText = logicalUnit.sources
    .map((source) => source.text)
    .join("\n");

  const projection = projectLogicalQuestionForAdjudication(logicalUnit, 420);
  assert.equal(projection.safe, true);
  assert.ok(projection.text.length <= 420);
  assert.ok(
    projection.sourceTurns.reduce(
      (total, source, index) =>
        total + source.text.length + (index > 0 ? 1 : 0),
      0
    ) <= 420
  );
  assert.deepEqual(
    projection.sourceTurnIds,
    projection.sourceTurns.map((source) => source.turnId)
  );
  assert.match(projection.text, /Design an enterprise retrieval service/);
  assert.match(projection.text, /hybrid search/);
  assert.equal(projection.projectionReason, "anchor-switch-latest-constraint");
});

test("only ambiguous substantive interviewer units are eligible", () => {
  const corpusCase = TAXONOMY_ADJUDICATION_CORPUS.find(
    (candidate) => candidate.id === "unknown-coding-design-algorithm"
  );
  assert.ok(corpusCase);
  const lexical = inferQuestionTypeDecisionFromText(corpusCase.text);
  const eligible = decideTaxonomyAdjudicationEligibility({
    enabled: true,
    evaluationActive: true,
    speaker: "them",
    turnGateAction: "answer-refresh",
    projection: projectLogicalQuestionForAdjudication(unit(corpusCase.text)),
    lexical: { ...lexical, type: undefined, confidence: 0.4, margin: 0.05 },
    manualCorrectionActive: false,
  });
  assert.equal(eligible.eligible, true);
  assert.deepEqual(eligible.triggerReasons, ["lexical-unknown"]);

  assert.equal(
    decideTaxonomyAdjudicationEligibility({
      enabled: true,
      evaluationActive: true,
      speaker: "me",
      turnGateAction: "answer-refresh",
      projection: projectLogicalQuestionForAdjudication(unit(corpusCase.text)),
      lexical,
      manualCorrectionActive: false,
    }).eligible,
    false
  );
});

test("sends substantive suppressed turns to independent shadow adjudication", () => {
  const text = "Where should the RAG source data be stored for this design";
  const lexical = inferQuestionTypeDecisionFromText(text);
  const decision = decideTaxonomyAdjudicationEligibility({
    enabled: true,
    evaluationActive: true,
    speaker: "them",
    turnGateAction: "ignore",
    projection: projectLogicalQuestionForAdjudication(unit(text)),
    lexical,
    manualCorrectionActive: false,
  });

  assert.equal(decision.eligible, true);
  assert.ok(
    decision.triggerReasons.includes("substantive-ignore-turn")
  );
});

test("treats substantive CJK questions as long enough for adjudication", () => {
  const text = "请设计一个支持高并发的推荐系统";
  const decision = decideTaxonomyAdjudicationEligibility({
    enabled: true,
    evaluationActive: true,
    speaker: "them",
    turnGateAction: "answer-refresh",
    projection: projectLogicalQuestionForAdjudication(unit(text)),
    lexical: {
      ...inferQuestionTypeDecisionFromText(text),
      type: undefined,
      confidence: 0.35,
      margin: 0.04,
    },
    manualCorrectionActive: false,
  });

  assert.equal(decision.eligible, true);
  assert.deepEqual(decision.triggerReasons, ["lexical-unknown"]);
});

test("does not escalate a strong lexical result for an isolated semantic rejection", () => {
  const text = "Implement a stack using two queues and analyze its complexity.";
  const lexical = inferQuestionTypeDecisionFromText(text);
  const decision = decideTaxonomyAdjudicationEligibility({
    enabled: true,
    evaluationActive: true,
    speaker: "them",
    turnGateAction: "answer-refresh",
    projection: projectLogicalQuestionForAdjudication(unit(text)),
    lexical: { ...lexical, type: "coding", confidence: 0.93, margin: 0.42 },
    semantic: {
      candidateType: "coding",
      calibratedConfidence: 0.79,
      margin: 0.01,
      accepted: false,
      rejectionReasons: ["positive-score-below-threshold"],
      perTypeScores: {},
      positivePrototypeIds: [],
      hardNegativePrototypeIds: [],
      modelVersion: "test-model",
      prototypeVersion: "test-prototypes",
      calibrationVersion: "test-calibration",
    },
    manualCorrectionActive: false,
  });

  assert.deepEqual(decision, {
    eligible: false,
    reason: "high-confidence-local-classification",
    triggerReasons: [],
  });
});

test("lease authorization drops stale revisions, boundaries, and corrections", () => {
  const logicalUnit = unit("Design an Uber-like service.", 2);
  const lease = createTaxonomyAdjudicationLease({
    operationId: "operation-a",
    sessionId: "session-a",
    runtimeEpoch: 2,
    logicalQuestionUnit: logicalUnit,
    taskBoundaryEpoch: 11,
    manualCorrectionRevision: 4,
    expectedParentId: "parent-a",
    requestedAt: 100,
  });
  const current = {
    currentOperationId: "operation-a",
    sessionId: "session-a",
    runtimeEpoch: 2,
    logicalQuestionUnit: logicalUnit,
    taskBoundaryEpoch: 11,
    manualCorrectionRevision: 4,
    activeParentId: "parent-a",
    activeParentRevision: undefined,
    logicalUnitClosed: false,
    selfHealingBudgetConsumed: false,
  };
  assert.deepEqual(authorizeTaxonomyAdjudicationLease(lease, current), {
    authorized: true,
  });
  assert.deepEqual(
    authorizeTaxonomyAdjudicationLease(lease, {
      ...current,
      logicalQuestionUnit: { ...logicalUnit, revision: 3 },
    }),
    {
      authorized: false,
      reason: "logical-unit-revision-mismatch",
    }
  );
  assert.deepEqual(
    authorizeTaxonomyAdjudicationLease(lease, {
      ...current,
      manualCorrectionRevision: 5,
    }),
    {
      authorized: false,
      reason: "manual-correction-revision-mismatch",
    }
  );
});

test("offline corpus covers multilingual, continuity, filler, and domain-switch cases", () => {
  assert.ok(TAXONOMY_ADJUDICATION_CORPUS.length >= 12);
  assert.ok(
    TAXONOMY_ADJUDICATION_CORPUS.some((item) =>
      /[\u4e00-\u9fff]/u.test(item.text)
    )
  );
  assert.ok(
    TAXONOMY_ADJUDICATION_CORPUS.some(
      (item) => item.expectedRelation === "linked-parent-extension"
    )
  );
  assert.ok(
    TAXONOMY_ADJUDICATION_CORPUS.some(
      (item) => item.expectedRelation === "child-probe"
    )
  );
  assert.ok(TAXONOMY_ADJUDICATION_CORPUS.some((item) => !item.shouldAdjudicate));
});
