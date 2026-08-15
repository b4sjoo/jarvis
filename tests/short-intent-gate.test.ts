import assert from "node:assert/strict";
import test from "node:test";
import { decideAdvisorTurnIntent } from "../src/lib/meeting/advisor-turn-intent.js";
import {
  RESPONSE_OPPORTUNITY_COMPACT_OUTPUT_WORST_CASE,
  RESPONSE_OPPORTUNITY_MAX_OUTPUT_CHARS,
  RESPONSE_OPPORTUNITY_MAX_OUTPUT_TOKENS,
  RESPONSE_OPPORTUNITY_SESSION_START_LIMIT,
  ResponseOpportunitySessionBudget,
  authorizeResponseOpportunityLease,
  buildResponseOpportunityPrompts,
  buildResponseOpportunityRequest,
  createResponseOpportunityLease,
  createResponseOpportunityProposal,
  decideResponseOpportunityFailureFallback,
  decideResponseOpportunityLocalRoute,
  decideResponseOpportunityRelease,
  parseResponseOpportunityOutput,
  resolveResponseOpportunityExecutionMode,
} from "../src/lib/meeting/short-intent-gate.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";

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
    request.sourceSpans.map((span) => span.turnId),
    ["turn-previous", "turn-current"]
  );
  assert.equal(request.sourceSpans.length, 2);
  assert.equal(
    request.sourceSpans.at(-1)?.text.endsWith(terminalAsk),
    true
  );
  assert.equal("activeTask" in request, false);
  assert.equal("questionType" in request, false);
  assert.equal("contextTurns" in request, false);
  assert.match(prompts.systemPrompt, /one thing only/i);
  assert.match(prompts.systemPrompt, /Do not classify question type/i);
});

test("strictly parses exact turn-scoped evidence and rejects extra authority", () => {
  const request = buildResponseOpportunityRequest({
    logicalQuestionUnit: logicalQuestionUnit("Kubernetes"),
  });
  const validOutput = {
    v: 3,
    d: "o",
    c: 0.97,
    e: [0],
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
      e: [1],
    }),
    request
  );
  assert.equal(inventedEvidence.ok, false);
  if (!inventedEvidence.ok) {
    assert.equal(inventedEvidence.errorKind, "evidence");
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
    '```json\n{"v":3,"d":"o","c":0.96,"e":[0],"r":"ask"}\n```',
    request
  );
  assert.equal(fenced.ok, true);
  if (fenced.ok) {
    assert.deepEqual(fenced.value.evidenceSpans, request.sourceSpans);
  }

  const truncated = parseResponseOpportunityOutput(
    '{"v":3,"d":"o","c":0.96,"e":[0],"r":"ask"',
    request
  );
  assert.equal(truncated.ok, false);
  if (!truncated.ok) assert.equal(truncated.reason, "invalid-json");
});

test("fails open only for explicit task actions with a concrete object", () => {
  const explicit = decideAdvisorTurnIntent(
    "Please refine the architecture with multi-region failover.",
    { hasActiveTask: true }
  );
  assert.deepEqual(
    decideResponseOpportunityFailureFallback({
      text: "Please refine the architecture with multi-region failover.",
      decision: explicit,
    }),
    {
      authorized: true,
      reason: "explicit-task-action-with-object",
    }
  );

  const metaCheck = decideAdvisorTurnIntent("Did you get my question?", {
    hasActiveTask: true,
  });
  assert.deepEqual(
    decideResponseOpportunityFailureFallback({
      text: "Did you get my question?",
      decision: metaCheck,
    }),
    {
      authorized: false,
      reason: "automatic-authority-not-concrete",
    }
  );
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
    schemaVersion: 3 as const,
    confidence: 0.93,
    evidenceSpans: [{ turnId: "turn-current", text: "Kubernetes" }],
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
      schemaVersion: 3,
      decision: "output-request",
      confidence: 0.95,
      evidenceSpans: [
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
