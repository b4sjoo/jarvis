import assert from "node:assert/strict";
import test from "node:test";
import {
  createProvisionalCurrentQuestion,
  decideCurrentQuestionMutationAuthority,
  formatCurrentQuestionMutationAuthorityForTrace,
  formatProvisionalCurrentQuestionForTrace,
} from "../src/lib/meeting/current-question-settlement.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";

function logicalQuestion(
  revision = 2,
  text = "Design a ride-sharing backend"
): LogicalQuestionUnit {
  return {
    id: "logical-question-a",
    revision,
    sessionId: "session-a",
    runtimeEpoch: 3,
    currentTurnId: "turn-b",
    sourceTurnIds: ["turn-a", "turn-b"],
    sources: [
      {
        turnId: "turn-a",
        text: "Design a ride-sharing",
        startedAt: 10,
        endedAt: 20,
      },
      {
        turnId: "turn-b",
        text: "backend",
        startedAt: 30,
        endedAt: 40,
      },
    ],
    normalizedText: text,
    startedAt: 10,
    updatedAt: 40,
    compositionReasons: ["bounded-continuation"],
    boundaryReason: "bounded-continuation",
    truncated: false,
  };
}

test("creates a stable versioned provisional question snapshot", () => {
  const first = createProvisionalCurrentQuestion({
    logicalQuestionUnit: logicalQuestion(),
    sourceKind: "mixed",
    sourceObservationIds: ["observation-a"],
    now: 50,
  });
  const duplicate = createProvisionalCurrentQuestion({
    logicalQuestionUnit: logicalQuestion(),
    sourceKind: "mixed",
    sourceObservationIds: ["observation-a"],
    now: 60,
  });
  const revised = createProvisionalCurrentQuestion({
    logicalQuestionUnit: logicalQuestion(3),
    sourceKind: "mixed",
    sourceObservationIds: ["observation-a"],
    now: 70,
  });

  assert.equal(first.logicalQuestionUnitId, "logical-question-a");
  assert.equal(first.revision, 2);
  assert.deepEqual(first.sourceTurnIds, ["turn-a", "turn-b"]);
  assert.equal(first.sourceKind, "mixed");
  assert.equal(first.sourceHash, duplicate.sourceHash);
  assert.notEqual(first.sourceHash, revised.sourceHash);
});

test("keeps an unknown question response-capable but parent-ineligible", () => {
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: logicalQuestion(2, "Could you explain that?"),
    sourceKind: "voice",
  });
  const decision = decideCurrentQuestionMutationAuthority({
    currentQuestion,
    proposedQuestionType: "unknown",
    proposedRelation: "new-parent",
    authoritySource: "accepted-transcript",
    typeEvidenceAuthorized: false,
    relationEvidenceAuthorized: true,
    runtimeMutationAuthorized: true,
    questionComplete: true,
    commitParent: true,
  });

  assert.equal(decision.responseAuthorized, true);
  assert.equal(decision.typeMutationAuthorized, false);
  assert.equal(decision.relationMutationAuthorized, true);
  assert.equal(decision.parentMutationAuthorized, false);
  assert.ok(decision.reasons.includes("question-type-unresolved"));
});

test("does not let type repair implicitly authorize relation or parent mutation", () => {
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: logicalQuestion(),
    sourceKind: "voice",
  });
  const decision = decideCurrentQuestionMutationAuthority({
    currentQuestion,
    proposedQuestionType: "general-system-design",
    proposedRelation: "new-parent",
    authoritySource: "llm-type-repair",
    typeEvidenceAuthorized: true,
    relationEvidenceAuthorized: false,
    runtimeMutationAuthorized: true,
    questionComplete: true,
    commitParent: true,
  });

  assert.equal(decision.authority, "llm-type-repair");
  assert.equal(decision.typeMutationAuthorized, true);
  assert.equal(decision.relationMutationAuthorized, false);
  assert.equal(decision.parentMutationAuthorized, false);
});

test("authorizes a complete deterministic parent mutation", () => {
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: logicalQuestion(),
    sourceKind: "voice",
  });
  const decision = decideCurrentQuestionMutationAuthority({
    currentQuestion,
    proposedQuestionType: "general-system-design",
    proposedRelation: "new-parent",
    authoritySource: "accepted-transcript",
    typeEvidenceAuthorized: true,
    relationEvidenceAuthorized: true,
    runtimeMutationAuthorized: true,
    questionComplete: true,
    commitParent: true,
  });

  assert.equal(decision.authority, "deterministic-fast-path");
  assert.equal(decision.parentMutationAuthorized, true);
  assert.ok(decision.reasons.includes("parent-mutation-authorized"));
});

test("formats provisional identity and authority for trace joins", () => {
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: logicalQuestion(),
    sourceKind: "screen",
    sourceObservationIds: ["observation-a"],
  });
  const decision = decideCurrentQuestionMutationAuthority({
    currentQuestion,
    proposedQuestionType: "general-system-design",
    proposedRelation: "new-parent",
    authoritySource: "opening-route",
    typeEvidenceAuthorized: true,
    relationEvidenceAuthorized: true,
    runtimeMutationAuthorized: true,
    questionComplete: true,
    commitParent: true,
  });
  const metadata = {
    ...formatProvisionalCurrentQuestionForTrace(currentQuestion),
    ...formatCurrentQuestionMutationAuthorityForTrace(decision),
  };

  assert.equal(metadata.currentQuestionUnitId, "logical-question-a");
  assert.equal(metadata.currentQuestionRevision, 2);
  assert.equal(metadata.currentQuestionSourceKind, "screen");
  assert.equal(metadata.currentQuestionAuthority, "deterministic-fast-path");
  assert.equal(metadata.currentQuestionParentMutationAuthorized, true);
});
