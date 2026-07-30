import assert from "node:assert/strict";
import test from "node:test";
import { decideAdvisorTurnIntent } from "../src/lib/meeting/advisor-turn-intent.js";
import {
  SHORT_INTENT_GATE_SESSION_START_LIMIT,
  ShortIntentGateSessionBudget,
  buildShortIntentGatePrompts,
  buildShortIntentGateRequest,
  createShortIntentGateAdvisorDecision,
  decideShortIntentLocalRoute,
  parseShortIntentGateOutput,
} from "../src/lib/meeting/short-intent-gate.js";
import type {
  LogicalQuestionUnit,
} from "../src/lib/meeting/logical-question-unit.js";
import type { TranscriptTurn } from "../src/lib/meeting/types.js";

function turn(
  id: string,
  text: string,
  speaker: TranscriptTurn["speaker"] = "them"
): TranscriptTurn {
  return {
    id,
    speaker,
    text,
    startedAt: 10,
    endedAt: 20,
    isFinal: true,
    source: speaker === "me" ? "microphone" : "system-audio",
  };
}

function logicalQuestionUnit(text: string): LogicalQuestionUnit {
  return {
    id: "lqu-a",
    revision: 3,
    sessionId: "session-a",
    runtimeEpoch: 2,
    currentTurnId: "turn-current",
    sourceTurnIds: ["turn-current"],
    sources: [
      {
        turnId: "turn-current",
        text,
        startedAt: 10,
        endedAt: 20,
      },
    ],
    normalizedText: text,
    startedAt: 10,
    updatedAt: 20,
    compositionReasons: ["initial-turn"],
    boundaryReason: "new-logical-question",
    truncated: false,
  };
}

test("routes canonical fillers, high-information shorts, and residual ambiguity separately", () => {
  for (const text of [
    "Mm-hmm.",
    "mm hmm",
    "mmhmm",
    "Uh-huh.",
    "Hello.",
    "Good Monday.",
    "Of course, of course.",
  ]) {
    const decision = decideAdvisorTurnIntent(text, {
      hasActiveTask: true,
    });
    const route = decideShortIntentLocalRoute({ text, decision });
    assert.equal(route.disposition, "deterministic-ignore", text);
  }

  for (const text of ["Why?", "RAG?", "HNSW", "Use Java"]) {
    const decision = decideAdvisorTurnIntent(text, {
      hasActiveTask: true,
    });
    const route = decideShortIntentLocalRoute({ text, decision });
    assert.equal(route.disposition, "deterministic-answer", text);
    assert.equal(route.highInformation, true, text);
  }

  const ambiguousText = "Kubernetes";
  const ambiguous = decideShortIntentLocalRoute({
    text: ambiguousText,
    decision: decideAdvisorTurnIntent(ambiguousText, {
      hasActiveTask: false,
    }),
  });
  assert.equal(ambiguous.disposition, "runtime-required");
});

test("lets a pending confirmation outrank an acknowledgement rule", () => {
  const text = "Yes.";
  const route = decideShortIntentLocalRoute({
    text,
    decision: decideAdvisorTurnIntent(text, {
      hasActiveTask: true,
    }),
    pendingConfirmation: true,
  });

  assert.equal(route.disposition, "deterministic-answer");
  assert.equal(route.reason, "pending-confirmation-response");
});

test("builds a bounded action-only request", () => {
  const request = buildShortIntentGateRequest({
    logicalQuestionUnit: logicalQuestionUnit("Kubernetes"),
    currentTurn: turn("turn-current", "Kubernetes"),
    previousTurns: [
      turn("turn-old", "Old unrelated context"),
      turn("turn-me", "Do you mean the deployment platform?", "me"),
      turn("turn-near", "Yes, in the active design"),
      turn("turn-current", "Kubernetes"),
    ],
    pendingConfirmation: true,
  });
  const prompts = buildShortIntentGatePrompts(request);

  assert.deepEqual(
    request.contextTurns.map((contextTurn) => contextTurn.turnId),
    ["turn-me", "turn-near"]
  );
  assert.equal(request.pendingConfirmation, true);
  assert.match(prompts.systemPrompt, /ignore, append-context, and answer/);
  assert.match(prompts.systemPrompt, /Do not classify question type/);
  assert.doesNotMatch(prompts.systemPrompt, /write an interview answer/i);
});

test("strictly parses source-grounded action output", () => {
  const request = buildShortIntentGateRequest({
    logicalQuestionUnit: logicalQuestionUnit("Kubernetes"),
    currentTurn: turn("turn-current", "Kubernetes"),
    previousTurns: [],
    pendingConfirmation: false,
  });
  const parsed = parseShortIntentGateOutput(
    JSON.stringify({
      schemaVersion: 1,
      action: "answer",
      confidence: 0.97,
      evidenceSpans: ["Kubernetes"],
    }),
    request
  );
  assert.equal(parsed.ok, true);

  const extraSemanticAuthority = parseShortIntentGateOutput(
    JSON.stringify({
      schemaVersion: 1,
      action: "answer",
      confidence: 0.97,
      evidenceSpans: ["Kubernetes"],
      questionType: "system-design",
    }),
    request
  );
  assert.equal(extraSemanticAuthority.ok, false);
  if (!extraSemanticAuthority.ok) {
    assert.equal(
      extraSemanticAuthority.reason,
      "non-intent-field-present"
    );
  }

  const inventedEvidence = parseShortIntentGateOutput(
    JSON.stringify({
      schemaVersion: 1,
      action: "answer",
      confidence: 0.97,
      evidenceSpans: ["Kubernetes architecture"],
    }),
    request
  );
  assert.equal(inventedEvidence.ok, false);
  if (!inventedEvidence.ok) {
    assert.equal(inventedEvidence.errorKind, "evidence");
  }
});

test("releases only an answer action as advisor refresh authority", () => {
  const original = decideAdvisorTurnIntent("Kubernetes", {
    hasActiveTask: false,
  });
  const answer = createShortIntentGateAdvisorDecision({
    original,
    result: {
      schemaVersion: 1,
      action: "answer",
      confidence: 0.93,
      evidenceSpans: ["Kubernetes"],
    },
  });
  const ignore = createShortIntentGateAdvisorDecision({
    original,
    result: {
      schemaVersion: 1,
      action: "ignore",
      confidence: 0.99,
      evidenceSpans: ["Kubernetes"],
    },
  });

  assert.equal(answer.action, "answer-refresh");
  assert.equal(answer.executionAuthorized, true);
  assert.equal(answer.authoritySource, "runtime-intent-gate");
  assert.equal(ignore.action, "ignore");
  assert.equal(ignore.executionAuthorized, false);
  assert.equal(ignore.authoritySource, "runtime-intent-gate");
});

test("deduplicates one source revision and enforces the session cap", () => {
  const budget = new ShortIntentGateSessionBudget();
  const first = budget.authorize("session-a", "turn-a:hash-a:1");
  const duplicate = budget.authorize("session-a", "turn-a:hash-a:1");

  assert.equal(first.authorized, true);
  assert.equal(duplicate.authorized, false);
  assert.equal(duplicate.reason, "duplicate-operation");

  for (let index = 1; index < SHORT_INTENT_GATE_SESSION_START_LIMIT; index += 1) {
    assert.equal(
      budget.authorize("session-a", `turn-${index}:hash-${index}:1`)
        .authorized,
      true
    );
  }
  const exhausted = budget.authorize(
    "session-a",
    "turn-over-limit:hash-over-limit:1"
  );
  assert.equal(exhausted.authorized, false);
  assert.equal(exhausted.reason, "session-limit-exhausted");
});
