import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  authorizeAnswerRecoveryAdjudicationLease,
  buildAnswerRecoveryAdjudicationPrompts,
  buildAnswerRecoveryAdjudicationRequest,
  buildVisualEvidenceCheckRequest,
  createAnswerRecoveryAdjudicationLease,
  decideAnswerRecoveryLedgerTransition,
  isAnswerRecoveryOutputTruncated,
  parseAnswerRecoveryAdjudicationOutput,
  shouldRunQuestionOnlyVisualEvidenceCheck,
} from "../src/lib/meeting/answer-recovery-adjudication.js";

const question = "Could you please explain lines 46 through 49?";
const answer =
  "I don't have those lines visible. Please paste or read out lines 46 through 49.";

test("AR1/AR2 exact long quotes remain evidence without weakening other operations", () => {
  for (const length of [173, 183, 210, 343]) {
    const quote = "A".repeat(length);
    const request = buildAnswerRecoveryAdjudicationRequest({ operationKind: "answer-resolution", logicalQuestionUnitId: "q", logicalQuestionUnitRevision: 1, answerRevision: 1, questionText: question, answerText: quote })!;
    const output = { schemaVersion: 2, decision: "resolved", questionEvidenceSpans: [question], answerEvidenceSpans: [quote] };
    const result = parseAnswerRecoveryAdjudicationOutput(JSON.stringify(output), request);
    assert.equal(result.ok, true);
    if (result.ok && "answerEvidenceSpans" in result.value) assert.equal(result.value.answerEvidenceSpans[0], quote);
    assert.equal(parseAnswerRecoveryAdjudicationOutput(JSON.stringify({ ...output, answerEvidenceSpans: [quote + "not in source"] }), request).ok, false);
    assert.equal(parseAnswerRecoveryAdjudicationOutput(JSON.stringify({ ...output, questionEvidenceSpans: [quote], answerEvidenceSpans: [question] }), request).ok, false);
    assert.equal(parseAnswerRecoveryAdjudicationOutput(JSON.stringify({ ...output, answerEvidenceSpans: [quote, quote] }), request).ok, false);
    const visual = buildVisualEvidenceCheckRequest({ logicalQuestionUnitId: "q", logicalQuestionUnitRevision: 1, questionSourceHash: "h", questionText: quote })!;
    assert.equal(parseAnswerRecoveryAdjudicationOutput(JSON.stringify({ schemaVersion: 2, decision: "visual-missing", questionEvidenceSpans: [quote], visualEvidenceSpans: [] }), visual).ok, false);
  }
});

test("AR3 prompt distinguishes the requested object from a useful hypothetical replacement", () => {
  const request = buildAnswerRecoveryAdjudicationRequest({ operationKind: "answer-resolution", logicalQuestionUnitId: "q", logicalQuestionUnitRevision: 1, answerRevision: 1, questionText: question, answerText: answer })!;
  const prompt = buildAnswerRecoveryAdjudicationPrompts(request);
  assert.match(prompt.systemPrompt, /exact requested object and deliverable/);
  assert.match(prompt.systemPrompt, /illustrative replacement/);
  assert.match(prompt.systemPrompt, /whole answer/);
  assert.deepEqual(JSON.parse(prompt.userMessage), { questionText: question, answerText: answer });
});

test("runs the question-only visual lease for automatic and manual recovery sources", () => {
  for (const source of [
    "live-turn",
    "manual-correction",
    "force-advise",
    "regenerate",
  ] as const) {
    assert.equal(shouldRunQuestionOnlyVisualEvidenceCheck(source), true);
  }
  for (const source of [
    "response-action",
    "clarifying-answer",
  ] as const) {
    assert.equal(shouldRunQuestionOnlyVisualEvidenceCheck(source), false);
  }
});

test("refreshes a completed trace after background visual evidence settles", () => {
  const source = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
  const start = source.indexOf(
    "const scheduleQuestionOnlyVisualEvidenceCheck"
  );
  const end = source.indexOf(
    "const scheduleAnswerRecoveryAdjudications",
    start
  );
  assert.ok(start >= 0 && end > start);
  assert.match(
    source.slice(start, end),
    /refreshRecordedCompletedTrace\(input\.traceId\)/
  );
});

test("keeps post-answer resolution separate from question-only visual evidence", () => {
  const resolution = buildAnswerRecoveryAdjudicationRequest({
    operationKind: "answer-resolution",
    logicalQuestionUnitId: "lqu-1",
    logicalQuestionUnitRevision: 2,
    answerRevision: 3,
    questionText: question,
    answerText: answer,
  });
  const evidence = buildVisualEvidenceCheckRequest({
    logicalQuestionUnitId: "lqu-1",
    logicalQuestionUnitRevision: 2,
    questionSourceHash: "question-source-1",
    questionText: question,
  });

  assert.ok(resolution);
  assert.ok(evidence);
  assert.notEqual(resolution.sourceHash, evidence.sourceHash);
  const resolutionPrompt = buildAnswerRecoveryAdjudicationPrompts(resolution);
  const evidencePrompt = buildAnswerRecoveryAdjudicationPrompts(evidence);
  assert.match(resolutionPrompt.systemPrompt, /resolves the substantive request/);
  assert.doesNotMatch(resolutionPrompt.systemPrompt, /visual-required/);
  assert.match(evidencePrompt.systemPrompt, /already-existing visible artifact/);
  assert.doesNotMatch(evidencePrompt.userMessage, /don.t have those lines/i);
  assert.doesNotMatch(evidencePrompt.systemPrompt, /resolved'\|'unresolved/);
  const resolutionInput = JSON.parse(resolutionPrompt.userMessage) as Record<
    string,
    unknown
  >;
  assert.deepEqual(resolutionInput, {
    answerText: answer,
    questionText: question,
  });
  assert.equal("operationKind" in resolutionInput, false);
  assert.equal("logicalQuestionUnitId" in resolutionInput, false);
  assert.equal("answerRevision" in resolutionInput, false);
  assert.equal("sourceHash" in resolutionInput, false);
});

test("distinguishes existing visual artifacts from new code implementation", () => {
  const implementation = buildVisualEvidenceCheckRequest({
    logicalQuestionUnitId: "lqu-implementation",
    logicalQuestionUnitRevision: 1,
    questionSourceHash: "question-source-implementation",
    questionText:
      "Within this RAG system, implement the access-aware retrieval merge function in Python.",
  });
  assert.ok(implementation);
  const prompt = buildAnswerRecoveryAdjudicationPrompts(implementation);

  assert.match(prompt.systemPrompt, /already-existing visible artifact/i);
  assert.match(prompt.systemPrompt, /create or implement new code/i);
  assert.match(prompt.systemPrompt, /generic noun such as function/i);
  assert.deepEqual(JSON.parse(prompt.userMessage), {
    questionText:
      "Within this RAG system, implement the access-aware retrieval merge function in Python.",
  });
});

test("parses an unresolved answer with grounded paraphrase evidence", () => {
  const request = buildAnswerRecoveryAdjudicationRequest({
    operationKind: "answer-resolution",
    logicalQuestionUnitId: "lqu-1",
    logicalQuestionUnitRevision: 1,
    answerRevision: 1,
    questionText: question,
    answerText: answer,
  });
  assert.ok(request);
  const parsed = parseAnswerRecoveryAdjudicationOutput(
    JSON.stringify({
      schemaVersion: 2,
      decision: "unresolved",
      questionEvidenceSpans: ["lines 46 through 49"],
      answerEvidenceSpans: ["I don't have those lines visible"],
    }),
    request
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.value.decision : undefined, "unresolved");
});

test("parses visual-missing without reading an answer", () => {
  const request = buildVisualEvidenceCheckRequest({
    logicalQuestionUnitId: "lqu-1",
    logicalQuestionUnitRevision: 1,
    questionSourceHash: "question-source-1",
    questionText: question,
  });
  assert.ok(request);
  const parsed = parseAnswerRecoveryAdjudicationOutput(
    JSON.stringify({
      schemaVersion: 2,
      decision: "visual-missing",
      questionEvidenceSpans: ["lines 46 through 49"],
      visualEvidenceSpans: [],
    }),
    request
  );

  assert.equal(parsed.ok, true);
  assert.equal(
    parsed.ok ? parsed.value.decision : undefined,
    "visual-missing"
  );
});

test("requires grounded visual evidence for visual-sufficient", () => {
  const request = buildVisualEvidenceCheckRequest({
    logicalQuestionUnitId: "lqu-1",
    logicalQuestionUnitRevision: 1,
    questionSourceHash: "question-source-1",
    questionText: question,
    screenQuestion: "Explain lines 46 through 49",
    screenEvidenceSummary: "Lines 46 through 49 show the eviction branch.",
  });
  assert.ok(request);
  const parsed = parseAnswerRecoveryAdjudicationOutput(
    JSON.stringify({
      schemaVersion: 2,
      decision: "visual-sufficient",
      questionEvidenceSpans: ["lines 46 through 49"],
      visualEvidenceSpans: ["Lines 46 through 49"],
    }),
    request
  );

  assert.equal(parsed.ok, true);
  assert.equal(
    parsed.ok ? parsed.value.decision : undefined,
    "visual-sufficient"
  );
});

test("rejects ungrounded evidence and definite decisions without evidence", () => {
  const request = buildAnswerRecoveryAdjudicationRequest({
    operationKind: "answer-resolution",
    logicalQuestionUnitId: "lqu-1",
    logicalQuestionUnitRevision: 1,
    answerRevision: 1,
    questionText: question,
    answerText: answer,
  });
  assert.ok(request);
  const ungrounded = parseAnswerRecoveryAdjudicationOutput(
    JSON.stringify({
      schemaVersion: 2,
      decision: "unresolved",
      questionEvidenceSpans: ["the highlighted function"],
      answerEvidenceSpans: ["I don't have those lines visible"],
    }),
    request
  );
  const empty = parseAnswerRecoveryAdjudicationOutput(
    JSON.stringify({
      schemaVersion: 2,
      decision: "unresolved",
      questionEvidenceSpans: [],
      answerEvidenceSpans: [],
    }),
    request
  );

  assert.equal(ungrounded.ok, false);
  assert.equal(empty.ok, false);
});

test("requires a reason-only compact unclear result", () => {
  const request = buildAnswerRecoveryAdjudicationRequest({
    operationKind: "answer-resolution",
    logicalQuestionUnitId: "lqu-1",
    logicalQuestionUnitRevision: 1,
    answerRevision: 1,
    questionText: question,
    answerText: answer,
  });
  assert.ok(request);
  const valid = parseAnswerRecoveryAdjudicationOutput(
    JSON.stringify({
      schemaVersion: 2,
      decision: "unclear",
      questionEvidenceSpans: [],
      answerEvidenceSpans: [],
      ambiguityReason: "The bounded answer is incomplete.",
    }),
    request
  );
  const invalid = parseAnswerRecoveryAdjudicationOutput(
    JSON.stringify({
      schemaVersion: 2,
      decision: "unclear",
      questionEvidenceSpans: ["lines 46 through 49"],
      answerEvidenceSpans: [],
      ambiguityReason: "The bounded answer is incomplete.",
    }),
    request
  );

  assert.equal(valid.ok, true);
  assert.equal(invalid.ok, false);
});

test("projects only definite current pairs to recovery ledger mutations", () => {
  assert.deepEqual(
    decideAnswerRecoveryLedgerTransition({
      revisionAuthorized: true,
      answerResolution: "unresolved",
      evidenceRequirement: "visual-missing",
    }),
    { action: "create", reason: "definite-visual-recovery" }
  );
  assert.deepEqual(
    decideAnswerRecoveryLedgerTransition({
      revisionAuthorized: true,
      answerResolution: "resolved",
      evidenceRequirement: "visual-missing",
    }),
    { action: "cancel", reason: "definite-non-recovery" }
  );
  assert.deepEqual(
    decideAnswerRecoveryLedgerTransition({
      revisionAuthorized: true,
      answerResolution: "unresolved",
      evidenceRequirement: "not-visual",
    }),
    { action: "cancel", reason: "definite-non-recovery" }
  );
  assert.deepEqual(
    decideAnswerRecoveryLedgerTransition({
      revisionAuthorized: true,
      answerResolution: "unclear",
      evidenceRequirement: "visual-missing",
    }),
    { action: "preserve", reason: "pair-not-definite" }
  );
  assert.deepEqual(
    decideAnswerRecoveryLedgerTransition({
      revisionAuthorized: false,
      answerResolution: "resolved",
      evidenceRequirement: "not-visual",
    }),
    { action: "preserve", reason: "revision-not-authorized" }
  );
});

test("makes visual recovery independent of result arrival order", () => {
  const events = ["answer", "evidence", "visible"] as const;
  const permutations = [
    events,
    ["answer", "visible", "evidence"] as const,
    ["evidence", "answer", "visible"] as const,
    ["evidence", "visible", "answer"] as const,
    ["visible", "answer", "evidence"] as const,
    ["visible", "evidence", "answer"] as const,
  ];

  for (const order of permutations) {
    let answerResolution: "unresolved" | undefined;
    let evidenceRequirement: "visual-missing" | undefined;
    let visibleAnswerRevision: number | undefined;
    const transitions = [];
    for (const event of order) {
      if (event === "answer") answerResolution = "unresolved";
      if (event === "evidence") evidenceRequirement = "visual-missing";
      if (event === "visible") visibleAnswerRevision = 2;
      if (
        answerResolution &&
        evidenceRequirement &&
        visibleAnswerRevision !== undefined
      ) {
        transitions.push(
          decideAnswerRecoveryLedgerTransition({
            revisionAuthorized: true,
            answerResolution,
            evidenceRequirement,
          })
        );
      }
    }
    assert.deepEqual(transitions, [
      { action: "create", reason: "definite-visual-recovery" },
    ]);
  }

  const hook = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
  const finalizer = hook.slice(
    hook.indexOf("const finalizeAnswerRecoveryAdjudication"),
    hook.indexOf("const prepareStableAnswerPublication")
  );
  assert.match(finalizer, /!candidate\.answerResolutionSettled/);
  assert.match(finalizer, /!candidate\.evidenceRequirementSettled/);
  assert.match(finalizer, /candidate\.visibleAnswerRevision === undefined/);
  assert.match(
    hook,
    /visualEvidenceCheckPromise\.then\([\s\S]*finalizeAnswerRecoveryAdjudication\(traceId\)/
  );
  assert.match(
    hook,
    /pending\.answerResolutionSettled = true;[\s\S]*finalizeAnswerRecoveryAdjudication\(traceId\)/
  );
  assert.match(
    hook,
    /answerResolutionCandidate\.visibleAnswerRevision = stable\.revision;[\s\S]*finalizeAnswerRecoveryAdjudication\(sourceTraceId\)/
  );
});

test("recognizes a structurally truncated provider response", () => {
  assert.equal(
    isAnswerRecoveryOutputTruncated(
      '{"schemaVersion":1,"decision":"unresolved"'
    ),
    true
  );
  assert.equal(
    isAnswerRecoveryOutputTruncated(
      '{"schemaVersion":1,"decision":"unresolved"}'
    ),
    false
  );
});

test("lease rejects stale answer and correction revisions", () => {
  const request = buildAnswerRecoveryAdjudicationRequest({
    operationKind: "answer-resolution",
    logicalQuestionUnitId: "lqu-1",
    logicalQuestionUnitRevision: 1,
    answerRevision: 2,
    questionText: question,
    answerText: answer,
  });
  assert.ok(request);
  const lease = createAnswerRecoveryAdjudicationLease({
    sessionId: "meeting-1",
    runtimeEpoch: 4,
    request,
    manualCorrectionRevision: 1,
  });
  const current = {
    currentOperationId: lease.operationId,
    sessionId: "meeting-1",
    runtimeEpoch: 4,
    logicalQuestionUnitId: "lqu-1",
    logicalQuestionUnitRevision: 1,
    answerRevision: 2,
    sourceHash: request.sourceHash,
    manualCorrectionRevision: 1,
  };

  assert.equal(
    authorizeAnswerRecoveryAdjudicationLease(lease, current).authorized,
    true
  );
  assert.equal(
    authorizeAnswerRecoveryAdjudicationLease(lease, {
      ...current,
      answerRevision: 3,
    }).authorized,
    false
  );
  assert.equal(
    authorizeAnswerRecoveryAdjudicationLease(lease, {
      ...current,
      manualCorrectionRevision: 2,
    }).authorized,
    false
  );
});
