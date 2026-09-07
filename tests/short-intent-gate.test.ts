import assert from "node:assert/strict";
import test from "node:test";
import { decideAdvisorTurnIntent } from "../src/lib/meeting/advisor-turn-intent.js";
import {
  RESPONSE_OPPORTUNITY_COMPACT_OUTPUT_WORST_CASE,
  RESPONSE_OPPORTUNITY_MAX_OUTPUT_CHARS,
  RESPONSE_OPPORTUNITY_MAX_OUTPUT_TOKENS,
  RESPONSE_OPPORTUNITY_MAX_CLARIFICATION_CHARS,
  RESPONSE_OPPORTUNITY_SESSION_START_LIMIT,
  ResponseOpportunitySessionBudget,
  authorizeResponseOpportunityLease,
  buildResponseOpportunityPrompts,
  buildResponseOpportunityRequest,
  selectResponseOpportunityContextSources,
  createResponseOpportunityLease,
  createResponseOpportunityContextCapsule,
  createResponseOpportunityProposal,
  applyResponseOpportunityDecisionTarget,
  decideResponseOpportunityLocalRoute,
  decideResponseOpportunityRelease,
  parseResponseOpportunityOutput,
  resolveResponseOpportunityExecutionMode,
} from "../src/lib/meeting/short-intent-gate.js";
import {
  getLogicalQuestionAnswerFocusText,
  getLogicalQuestionSemanticEvidenceText,
  type LogicalQuestionUnit,
} from "../src/lib/meeting/logical-question-unit.js";

function logicalQuestionUnit(
  currentText: string,
  previousText?: string
): LogicalQuestionUnit {
  const current = {
    turnId: "turn-current",
    text: currentText,
    startedAt: 30,
    endedAt: 40,
  };
  const previous = previousText
    ? [
        {
          turnId: "turn-previous",
          text: previousText,
          startedAt: 10,
          endedAt: 20,
        },
      ]
    : [];
  return {
    id: "lqu-a",
    revision: 3,
    sessionId: "session-a",
    runtimeEpoch: 2,
    currentTurnId: current.turnId,
    sourceTurnIds: [...previous.map((source) => source.turnId), current.turnId],
    sources: [...previous, current],
    normalizedText: [previousText, currentText].filter(Boolean).join(" "),
    startedAt: previous[0]?.startedAt ?? current.startedAt,
    updatedAt: current.endedAt,
    compositionReasons: previousText
      ? ["initial-turn", "sentence-completion"]
      : ["initial-turn"],
    boundaryReason: "new-logical-question",
    truncated: false,
  };
}

test("keeps exact fillers local while reviewing clear requests in runtime shadow", () => {
  const fillerText = "Mm-hmm.";
  const filler = decideResponseOpportunityLocalRoute({
    text: fillerText,
    decision: decideAdvisorTurnIntent(fillerText, {
      hasActiveTask: true,
    }),
  });
  assert.equal(filler.disposition, "deterministic-no-output");
  assert.equal(filler.decision, "no-output-request");
  assert.equal(filler.runtimeReviewRequired, false);

  const askText = "Please design a URL shortener.";
  const ask = decideResponseOpportunityLocalRoute({
    text: askText,
    decision: decideAdvisorTurnIntent(askText, {
      hasActiveTask: true,
    }),
  });
  assert.equal(ask.disposition, "deterministic-output");
  assert.equal(ask.decision, "output-request");
  assert.equal(ask.runtimeReviewRequired, true);
  assert.equal(
    resolveResponseOpportunityExecutionMode(ask),
    "speculative-authoritative"
  );
  assert.equal(resolveResponseOpportunityExecutionMode(filler), undefined);
});

test("reviews a direct ask with constraints without making Runtime authoritative", () => {
  const text =
    "Please implement an LRU cache with O(1) get and put in Python.";
  const route = decideResponseOpportunityLocalRoute({
    text,
    decision: decideAdvisorTurnIntent(text, {
      hasActiveTask: false,
      hasRecentQuestionContext: false,
    }),
  });

  assert.equal(route.disposition, "deterministic-output");
  assert.equal(route.decision, "output-request");
  assert.equal(
    resolveResponseOpportunityExecutionMode(route),
    "speculative-authoritative"
  );
});

test("sends contentful residual ambiguity to runtime regardless of length", () => {
  for (const text of [
    "The deployment environment uses Kubernetes.",
    "The system currently serves several regions and the traffic pattern changes throughout the day.",
  ]) {
    const localDecision = decideAdvisorTurnIntent(text, {
      hasActiveTask: true,
    });
    const route = decideResponseOpportunityLocalRoute({
      text,
      decision: {
        ...localDecision,
        intent: "informational",
        action: "append-only",
        recommendedAction: "append-only",
        reason: "contentful-statement",
        executionAuthorized: false,
      },
    });
    assert.equal(route.disposition, "runtime-required", text);
    assert.equal(route.decision, "unclear", text);
    assert.equal(route.runtimeReviewRequired, true, text);
    assert.equal(
      resolveResponseOpportunityExecutionMode(route),
      "authoritative",
      text
    );
  }
});

test("lets a pending confirmation outrank an acknowledgement rule", () => {
  const text = "Yes.";
  const route = decideResponseOpportunityLocalRoute({
    text,
    decision: decideAdvisorTurnIntent(text, {
      hasActiveTask: true,
    }),
    pendingConfirmation: true,
  });

  assert.equal(route.disposition, "deterministic-output");
  assert.equal(route.reason, "pending-confirmation-response");
  assert.equal(route.runtimeReviewRequired, true);
});

test("sends contentful logistics to runtime instead of granting local no-output authority", () => {
  const text = "The interview will end at 3 PM.";
  const localDecision = decideAdvisorTurnIntent(text, {
    hasActiveTask: true,
  });
  const route = decideResponseOpportunityLocalRoute({
    text,
    decision: {
      ...localDecision,
      intent: "logistics",
      confidence: 0.99,
      action: "append-only",
      recommendedAction: "append-only",
      executionAuthorized: false,
    },
  });

  assert.equal(route.disposition, "runtime-required");
  assert.equal(route.runtimeReviewRequired, true);
});

test("builds a bounded LQU-only request and preserves the terminal tail", () => {
  const terminalAsk = "Where should the RAG data be stored?";
  const longCurrent = `${"context ".repeat(300)}${terminalAsk}`;
  const request = buildResponseOpportunityRequest({
    logicalQuestionUnit: logicalQuestionUnit(
      longCurrent,
      "Earlier bounded source"
    ),
  });
  const prompts = buildResponseOpportunityPrompts(request);

  assert.deepEqual(
    request.decisionSpans.map((span) => span.turnId),
    ["turn-current"]
  );
  assert.equal(request.decisionSpans.length, 1);
  assert.equal(
    request.decisionSpans.at(-1)?.text.endsWith(terminalAsk),
    true
  );
  assert.equal(request.boundedContext.endsWith(terminalAsk), true);
  assert.match(request.boundedContext, /Earlier bounded source/);
  assert.equal("activeTask" in request, false);
  assert.equal("questionType" in request, false);
  assert.equal("contextTurns" in request, false);
  assert.equal("contextCapsule" in request, false);
  assert.match(prompts.systemPrompt, /one thing only/i);
  assert.match(prompts.systemPrompt, /Do not classify question type/i);
  const modelInput = JSON.parse(prompts.userMessage) as {
    decisionSpans: Array<{ index: number; text: string }>;
    boundedContext: string;
  };
  assert.deepEqual(
    modelInput.decisionSpans.map((span) => span.index),
    [0]
  );
  assert.equal(modelInput.decisionSpans[0].text.endsWith(terminalAsk), true);
  assert.equal(modelInput.boundedContext, request.boundedContext);
  assert.equal("logicalQuestionUnitId" in modelInput, false);
  assert.equal("sourceHash" in modelInput, false);
  assert.equal("turnId" in modelInput.decisionSpans[0], false);
  assert.equal("manualForceAdvise" in modelInput, false);
});

test("keeps frozen source context out of decision targets but inside bounded context", () => {
  const logicalUnit = logicalQuestionUnit("How about you?");
  const withoutContext = buildResponseOpportunityRequest({
    logicalQuestionUnit: logicalUnit,
  });
  const request = buildResponseOpportunityRequest({
    logicalQuestionUnit: logicalUnit,
    contextSources: [
      {
        turnId: "turn-setup",
        text: "I have been with the team for three years and build the storage control plane.",
      },
    ],
  });

  assert.deepEqual(
    request.decisionSpans.map((span) => span.text),
    ["How about you?"]
  );
  assert.match(request.boundedContext, /storage control plane/i);
  assert.match(request.boundedContext, /How about you\?/i);
  assert.deepEqual(request.boundedContextSourceTurnIds, [
    "turn-setup",
    "turn-current",
  ]);
  assert.notEqual(request.sourceHash, withoutContext.sourceHash);
});

test("reserves the current ask before bounded earlier source context", () => {
  const current = `begin ${"x".repeat(400)} MUST KEEP MIDDLE REQUIREMENT ${"x".repeat(450)} end?`;
  const request = buildResponseOpportunityRequest({
    logicalQuestionUnit: logicalQuestionUnit(current, "p".repeat(600)),
  });

  assert.equal(request.decisionSpans.length, 1);
  assert.equal(request.decisionSpans[0].turnId, "turn-current");
  assert.match(request.decisionSpans[0].text, /MUST KEEP MIDDLE REQUIREMENT/);
  assert.match(request.boundedContext, /MUST KEEP MIDDLE REQUIREMENT/);
  assert.match(request.boundedContext, /^p{600}/);
  assert.ok(request.boundedContext.length <= 1_800);
});

test("reads only the LQU's frozen source-context references in source order", () => {
  const sources = selectResponseOpportunityContextSources({
    logicalQuestionUnit: {
      contextSourceTurnIds: ["turn-setup"],
      recentLogicalQuestionSourceTurnIds: ["turn-previous"],
    },
    transcriptTurns: [
      { id: "turn-current", text: "How about you?", startedAt: 30 },
      {
        id: "turn-setup",
        text: "Storage needs regional failover.",
        startedAt: 10,
      },
      { id: "turn-unrelated", text: "Ignore this old task.", startedAt: 15 },
      {
        id: "turn-previous",
        text: "We discussed the storage layer.",
        startedAt: 20,
      },
    ],
  });

  assert.deepEqual(sources, [
    { turnId: "turn-setup", text: "Storage needs regional failover." },
    { turnId: "turn-previous", text: "We discussed the storage layer." },
  ]);
});

test("uses a source-backed terminal target without discarding bounded context", () => {
  const logicalUnit = logicalQuestionUnit(
    "I have been with the team for three years. We build the storage control plane. How about you?"
  );
  const request = buildResponseOpportunityRequest({
    logicalQuestionUnit: logicalUnit,
  });
  const targetIndex = request.decisionSpans.findIndex(
    (span) => span.text === "How about you?"
  );
  assert.ok(targetIndex >= 0);

  const parsed = parseResponseOpportunityOutput(
    JSON.stringify({
      v: 4,
      d: "o",
      c: 0.97,
      t: [targetIndex],
      r: "ask",
    }),
    request
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const targeted = applyResponseOpportunityDecisionTarget({
    logicalQuestionUnit: logicalUnit,
    request,
    result: parsed.value,
  });
  assert.equal(getLogicalQuestionAnswerFocusText(targeted), "How about you?");
  assert.equal(
    targeted.responseOpportunityTarget?.decision,
    "output-request"
  );
  assert.match(
    getLogicalQuestionSemanticEvidenceText(targeted),
    /storage control plane/
  );
});

test("keeps prior LQU text as context instead of granting it a decision target", () => {
  const request = buildResponseOpportunityRequest({
    logicalQuestionUnit: logicalQuestionUnit(
      "What should I build?",
      "The service must support regional failover."
    ),
  });
  assert.equal(request.decisionSpans.length, 1);

  const parsed = parseResponseOpportunityOutput(
    JSON.stringify({
      v: 4,
      d: "o",
      c: 0.96,
      t: [0],
      r: "ask",
    }),
    request
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.deepEqual(
    parsed.value.targetSpans.map((span) => span.turnId),
    ["turn-current"]
  );
  assert.equal(parsed.value.decisionTarget, "What should I build?");
  assert.match(request.boundedContext, /regional failover/);
});

test("preserves a no-output decision with its reusable target", () => {
  const logicalUnit = logicalQuestionUnit("Thanks, that makes sense.");
  const request = buildResponseOpportunityRequest({
    logicalQuestionUnit: logicalUnit,
  });
  const parsed = parseResponseOpportunityOutput(
    JSON.stringify({
      v: 4,
      d: "n",
      c: 0.98,
      t: [0],
      r: "acknowledgement",
    }),
    request
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const targeted = applyResponseOpportunityDecisionTarget({
    logicalQuestionUnit: logicalUnit,
    request,
    result: parsed.value,
  });
  assert.equal(
    targeted.responseOpportunityTarget?.decision,
    "no-output-request"
  );
});

test("adds a bounded pending-clarification capsule without widening output authority", () => {
  const clarification = `Which traffic scale should I use? ${"detail ".repeat(80)}`;
  const contextCapsule = createResponseOpportunityContextCapsule({
    clarification,
    logicalQuestionUnitId: "lqu-design",
    logicalQuestionUnitRevision: 2,
    parentId: "parent-design",
    playbookPhase: "requirement_clarification",
    createdAt: 1_000,
    unresolved: true,
  });
  const logicalUnit = logicalQuestionUnit(
    "Yeah, you can make reasonable assumptions."
  );
  const withoutCapsule = buildResponseOpportunityRequest({
    logicalQuestionUnit: logicalUnit,
  });
  const request = buildResponseOpportunityRequest({
    logicalQuestionUnit: logicalUnit,
    contextCapsule,
  });
  const prompts = buildResponseOpportunityPrompts(request);

  assert.equal(
    request.contextCapsule?.pendingClarification.summary.length,
    RESPONSE_OPPORTUNITY_MAX_CLARIFICATION_CHARS
  );
  assert.equal(
    request.contextCapsule?.pendingClarification.playbookPhase,
    "requirement_clarification"
  );
  assert.equal(
    request.contextCapsule?.pendingClarification.unresolved,
    true
  );
  assert.equal(
    request.contextCapsule?.pendingClarification.supportStatus,
    "final-output-authorized"
  );
  assert.notEqual(request.sourceHash, withoutCapsule.sourceHash);
  assert.match(prompts.systemPrompt, /pendingClarification summary/);
  assert.match(prompts.systemPrompt, /read-only context/);
  assert.match(prompts.systemPrompt, /Do not classify question type/);
  const modelInput = JSON.parse(prompts.userMessage) as {
    pendingClarification: { summary: string };
  };
  assert.equal(
    modelInput.pendingClarification.summary,
    request.contextCapsule?.pendingClarification.summary
  );
  assert.deepEqual(Object.keys(modelInput.pendingClarification), ["summary"]);
  assert.equal(prompts.userMessage.includes("parent-design"), false);
  assert.equal(prompts.userMessage.includes("requirement_clarification"), false);
});

test("omits a resolved or empty clarification capsule", () => {
  assert.equal(
    createResponseOpportunityContextCapsule({
      clarification: "-",
      createdAt: 1_000,
      unresolved: true,
    }),
    undefined
  );
  assert.equal(
    createResponseOpportunityContextCapsule({
      clarification: "Which scale should I use?",
      createdAt: 1_000,
      unresolved: false,
    }),
    undefined
  );
});

test("strictly parses exact turn-scoped evidence and rejects extra authority", () => {
  const request = buildResponseOpportunityRequest({
    logicalQuestionUnit: logicalQuestionUnit("Kubernetes"),
  });
  const validOutput = {
    v: 4,
    d: "o",
    c: 0.97,
    t: [0],
    r: "ask",
  };
  assert.equal(
    parseResponseOpportunityOutput(JSON.stringify(validOutput), request).ok,
    true
  );

  const extraAuthority = parseResponseOpportunityOutput(
    JSON.stringify({ ...validOutput, questionType: "system-design" }),
    request
  );
  assert.equal(extraAuthority.ok, false);
  if (!extraAuthority.ok) {
    assert.equal(extraAuthority.reason, "non-opportunity-field-present");
  }

  const inventedEvidence = parseResponseOpportunityOutput(
    JSON.stringify({
      ...validOutput,
      t: [1],
    }),
    request
  );
  assert.equal(inventedEvidence.ok, false);
  if (!inventedEvidence.ok) {
    assert.equal(inventedEvidence.errorKind, "evidence");
  }
});

test("rejects contradictory response-opportunity decisions and reasons", () => {
  const request = buildResponseOpportunityRequest({
    logicalQuestionUnit: logicalQuestionUnit(
      "Did you use any helper tools to implement this?"
    ),
  });
  const contradictory = parseResponseOpportunityOutput(
    JSON.stringify({
      v: 4,
      d: "n",
      c: 1,
      t: [0],
      r: "ask",
    }),
    request
  );
  assert.equal(contradictory.ok, false);
  if (!contradictory.ok) {
    assert.equal(contradictory.reason, "decision-reason-mismatch");
    assert.equal(contradictory.errorKind, "schema");
  }

  for (const valid of [
    { d: "o", r: "directive" },
    { d: "n", r: "acknowledgement" },
    { d: "u", r: "bounded-source-insufficient" },
  ] as const) {
    assert.equal(
      parseResponseOpportunityOutput(
        JSON.stringify({
          v: 4,
          c: 0.95,
          t: valid.d === "u" ? [] : [0],
          ...valid,
        }),
        request
      ).ok,
      true
    );
  }
});

test("compact output contract fits its derived provider budget", () => {
  assert.ok(
    RESPONSE_OPPORTUNITY_COMPACT_OUTPUT_WORST_CASE.length <=
      RESPONSE_OPPORTUNITY_MAX_OUTPUT_CHARS
  );
  assert.ok(
    RESPONSE_OPPORTUNITY_MAX_OUTPUT_TOKENS >=
      Math.ceil(RESPONSE_OPPORTUNITY_MAX_OUTPUT_CHARS / 2)
  );
});

test("accepts fenced compact provider output and rejects truncation", () => {
  const request = buildResponseOpportunityRequest({
    logicalQuestionUnit: logicalQuestionUnit("Explain HNSW."),
  });
  const fenced = parseResponseOpportunityOutput(
    '```json\n{"v":4,"d":"o","c":0.96,"t":[0],"r":"ask"}\n```',
    request
  );
  assert.equal(fenced.ok, true);
  if (fenced.ok) {
    assert.deepEqual(fenced.value.targetSpans, request.decisionSpans);
    assert.equal(fenced.value.decisionTarget, "Explain HNSW.");
  }

  const truncated = parseResponseOpportunityOutput(
    '{"v":4,"d":"o","c":0.96,"t":[0],"r":"ask"',
    request
  );
  assert.equal(truncated.ok, false);
  if (!truncated.ok) assert.equal(truncated.reason, "truncated-json");
});

test("response-opportunity lease is independent of parent and type state", () => {
  const logicalUnit = logicalQuestionUnit("Please explain that tradeoff.");
  const request = buildResponseOpportunityRequest({
    logicalQuestionUnit: logicalUnit,
  });
  const lease = createResponseOpportunityLease({
    sessionId: "session-a",
    runtimeEpoch: 2,
    logicalQuestionUnit: logicalUnit,
    request,
    manualCorrectionRevision: 4,
    createdAt: 100,
  });
  const current = {
    currentOperationId: lease.operationId,
    sessionId: "session-a",
    runtimeEpoch: 2,
    logicalQuestionUnit: logicalUnit,
    request,
    manualCorrectionRevision: 4,
    logicalUnitClosed: false,
  };

  assert.deepEqual(authorizeResponseOpportunityLease(lease, current), {
    authorized: true,
  });
  assert.equal(
    authorizeResponseOpportunityLease(lease, {
      ...current,
      logicalQuestionUnit: { ...logicalUnit, revision: 4 },
    }).authorized,
    false
  );
  assert.equal(
    authorizeResponseOpportunityLease(lease, {
      ...current,
      manualCorrectionRevision: 5,
    }).authorized,
    false
  );
  assert.equal(
    authorizeResponseOpportunityLease(lease, {
      ...current,
      logicalUnitClosed: true,
    }).authorized,
    false
  );
});

test("releases only high-confidence output requests", () => {
  const original = decideAdvisorTurnIntent("Kubernetes", {
    hasActiveTask: false,
  });
  const base = {
    schemaVersion: 4 as const,
    confidence: 0.93,
    decisionTarget: "Kubernetes",
    targetSpans: [{ turnId: "turn-current", text: "Kubernetes" }],
    reason: "output requested",
  };
  const output = decideResponseOpportunityRelease({
    original,
    result: { ...base, decision: "output-request" },
  });
  const noOutput = decideResponseOpportunityRelease({
    original,
    result: { ...base, decision: "no-output-request" },
  });
  const unclear = decideResponseOpportunityRelease({
    original,
    result: { ...base, decision: "unclear" },
  });
  const lowConfidence = decideResponseOpportunityRelease({
    original,
    result: { ...base, decision: "output-request", confidence: 0.7 },
  });

  assert.equal(output.released, true);
  assert.equal(output.generationDisposition, "output-authorized");
  assert.equal(output.advisorDecision?.action, "answer-refresh");
  assert.equal(output.advisorDecision?.executionAuthorized, true);
  assert.equal(noOutput.released, false);
  assert.equal(noOutput.reason, "high-confidence-no-output-request");
  assert.equal(noOutput.generationDisposition, "output-suppressed");
  assert.equal(unclear.released, false);
  assert.equal(unclear.generationDisposition, "unresolved");
  assert.equal(lowConfidence.released, false);
});

test("creates a bounded proposal and enforces per-session dedupe", () => {
  const logicalUnit = logicalQuestionUnit("Explain the storage choice.");
  const request = buildResponseOpportunityRequest({
    logicalQuestionUnit: logicalUnit,
  });
  const proposal = createResponseOpportunityProposal({
    operationId: "operation-a",
    request,
    result: {
      schemaVersion: 4,
      decision: "output-request",
      confidence: 0.95,
      decisionTarget: "storage choice",
      targetSpans: [
        { turnId: "turn-current", text: "storage choice" },
      ],
      reason: "The interviewer requests an explanation.",
    },
    createdAt: 1_000,
  });
  assert.equal(proposal.source, "runtime-llm");
  assert.equal(proposal.capability, "settlement-proposal");
  assert.ok(proposal.expiresAt > proposal.createdAt);

  const budget = new ResponseOpportunitySessionBudget();
  const first = budget.authorize("session-a", "lqu-a:3:hash-a");
  const duplicate = budget.authorize("session-a", "lqu-a:3:hash-a");
  assert.equal(first.authorized, true);
  assert.equal(duplicate.reason, "duplicate-operation");

  for (
    let index = 1;
    index < RESPONSE_OPPORTUNITY_SESSION_START_LIMIT;
    index += 1
  ) {
    assert.equal(
      budget.authorize("session-a", `lqu-${index}:1:hash-${index}`)
        .authorized,
      true
    );
  }
  assert.equal(
    budget.authorize("session-a", "over-limit").reason,
    "session-limit-exhausted"
  );
});

test("makes a substantive current request outrank polite framing in the RO prompt", () => {
  const request = buildResponseOpportunityRequest({
    logicalQuestionUnit: logicalQuestionUnit(
      "Hi, and could you explain how you would monitor this service?"
    ),
  });
  const prompts = buildResponseOpportunityPrompts(request);

  assert.match(
    prompts.systemPrompt,
    /First identify whether any current decisionSpan asks the candidate/i
  );
  assert.match(
    prompts.systemPrompt,
    /use output-request even when.*greeting.*polite framing/i
  );
  assert.match(
    prompts.systemPrompt,
    /Use no-output-request only when.*no request for candidate output/i
  );
});
