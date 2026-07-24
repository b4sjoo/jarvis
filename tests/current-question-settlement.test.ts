import assert from "node:assert/strict";
import test from "node:test";
import {
  createProvisionalCurrentQuestion,
  decideCurrentQuestionMutationAuthority,
  formatCurrentQuestionMutationAuthorityForTrace,
  formatCurrentQuestionSettlementForTrace,
  formatProvisionalCurrentQuestionForTrace,
  resolveCurrentQuestionSettlementDisposition,
  settleCurrentQuestion,
  type CurrentQuestionSettlementProposal,
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

function proposal(
  source: CurrentQuestionSettlementProposal["source"],
  overrides: Partial<CurrentQuestionSettlementProposal> = {}
): CurrentQuestionSettlementProposal {
  return {
    source,
    sessionId: "session-a",
    runtimeEpoch: 3,
    logicalQuestionUnitId: "logical-question-a",
    revision: 2,
    questionType: "general-system-design",
    relation: "new-parent",
    action: "answer",
    evidenceMode: "hypothetical-design",
    confidence: 0.95,
    typeEvidenceAuthorized: true,
    relationEvidenceAuthorized: true,
    actionEvidenceAuthorized: true,
    ...overrides,
  };
}

function settle(
  overrides: Partial<Parameters<typeof settleCurrentQuestion>[0]> = {}
) {
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: logicalQuestion(),
    sourceKind: "voice",
  });
  return settleCurrentQuestion({
    currentQuestion,
    manualCorrectionRevision: 0,
    policy: {
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: true,
    },
    ...overrides,
  });
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

test("manual evidence outranks deterministic and LLM proposals on the same revision", () => {
  const decision = settle({
    manualCorrectionRevision: 4,
    manualProposal: proposal("manual-correction", {
      questionType: "behavioral",
      relation: "followup-parent",
      evidenceMode: "personal-experience",
      manualCorrectionRevision: 4,
    }),
    deterministicProposal: proposal("deterministic-fast-path"),
    llmProposal: proposal("llm-type-repair", {
      questionType: "coding",
    }),
    policy: {
      allowLlmTypeRepair: true,
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: true,
    },
  });

  assert.equal(decision.questionType, "behavioral");
  assert.equal(decision.relation, "followup-parent");
  assert.equal(decision.authority, "explicit-manual");
  assert.equal(decision.typeAuthoritySource, "manual-correction");
  assert.equal(decision.parentMutationAuthorized, false);
  assert.equal(
    resolveCurrentQuestionSettlementDisposition({
      settlement: decision,
      parentCommitted: true,
    }),
    "manual-authority"
  );
});

test("distinguishes provisional, response-only, committed, and stale dispositions", () => {
  const unresolved = settle();
  const responseOnly = settle({
    deterministicProposal: proposal("deterministic-fast-path", {
      questionType: "field-knowledge",
      relation: "followup-parent",
    }),
  });
  const committed = settle({
    deterministicProposal: proposal("deterministic-fast-path"),
  });

  assert.equal(
    resolveCurrentQuestionSettlementDisposition({
      settlement: unresolved,
    }),
    "unresolved-provisional"
  );
  assert.equal(
    resolveCurrentQuestionSettlementDisposition({
      settlement: unresolved,
      transientDomainResolved: true,
    }),
    "domain-resolved-unknown"
  );
  assert.equal(
    resolveCurrentQuestionSettlementDisposition({
      settlement: responseOnly,
    }),
    "response-only"
  );
  assert.equal(
    resolveCurrentQuestionSettlementDisposition({
      settlement: committed,
      parentCommitted: true,
    }),
    "committed-parent"
  );
  assert.equal(
    resolveCurrentQuestionSettlementDisposition({
      settlement: committed,
      staleDropped: true,
    }),
    "stale-dropped"
  );
});

test("deterministic evidence outranks an enabled LLM type repair", () => {
  const decision = settle({
    deterministicProposal: proposal("deterministic-fast-path", {
      questionType: "general-system-design",
    }),
    llmProposal: proposal("llm-type-repair", {
      questionType: "coding",
    }),
    policy: {
      allowLlmTypeRepair: true,
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: true,
    },
  });

  assert.equal(decision.questionType, "general-system-design");
  assert.equal(
    decision.typeAuthoritySource,
    "deterministic-fast-path"
  );
  assert.equal(decision.parentMutationAuthorized, true);
});

test("LLM can repair type without receiving relation or parent authority", () => {
  const decision = settle({
    llmProposal: proposal("llm-type-repair", {
      questionType: "coding",
      relation: "new-parent",
    }),
    policy: {
      allowLlmTypeRepair: true,
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: true,
    },
  });

  assert.equal(decision.questionType, "coding");
  assert.equal(decision.relation, "unknown");
  assert.equal(decision.typeMutationAuthorized, true);
  assert.equal(decision.relationMutationAuthorized, false);
  assert.equal(decision.parentMutationAuthorized, false);
  assert.ok(
    decision.rejectedProposals.some((rejection) =>
      rejection.reasons.includes("llm-relation-shadow-only")
    )
  );
});

test("LLM type repair can combine with separately authorized deterministic relation evidence", () => {
  const decision = settle({
    deterministicProposal: proposal("deterministic-fast-path", {
      questionType: "unknown",
      relation: "new-parent",
    }),
    llmProposal: proposal("llm-type-repair", {
      questionType: "ai-ml-system-design",
      relation: "followup-parent",
    }),
    policy: {
      allowLlmTypeRepair: true,
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: true,
    },
  });

  assert.equal(decision.questionType, "ai-ml-system-design");
  assert.equal(decision.relation, "new-parent");
  assert.equal(decision.typeAuthoritySource, "llm-type-repair");
  assert.equal(
    decision.relationAuthoritySource,
    "deterministic-fast-path"
  );
  assert.equal(decision.parentMutationAuthorized, true);
});

test("LLM type repair stays shadowed unless the operation enables it", () => {
  const decision = settle({
    llmProposal: proposal("llm-type-repair", {
      questionType: "coding",
    }),
  });

  assert.equal(decision.questionType, "unknown");
  assert.equal(decision.typeMutationAuthorized, false);
  assert.equal(decision.responseAuthorized, true);
  assert.ok(
    decision.rejectedProposals.some((rejection) =>
      rejection.reasons.includes("llm-type-repair-disabled")
    )
  );
});

test("stale manual and LLM proposals are rejected without invalidating current deterministic evidence", () => {
  const decision = settle({
    activeParentId: "parent-current",
    activeParentRevision: 7,
    manualCorrectionRevision: 5,
    manualProposal: proposal("manual-correction", {
      questionType: "behavioral",
      manualCorrectionRevision: 4,
    }),
    deterministicProposal: proposal("deterministic-fast-path", {
      questionType: "general-system-design",
      expectedParentId: "parent-current",
      expectedParentRevision: 7,
    }),
    llmProposal: proposal("llm-type-repair", {
      questionType: "coding",
      revision: 1,
    }),
    policy: {
      allowLlmTypeRepair: true,
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: true,
    },
  });

  assert.equal(decision.questionType, "general-system-design");
  assert.ok(
    decision.rejectedProposals.some(
      (rejection) =>
        rejection.source === "manual-correction" &&
        rejection.reasons.includes(
          "manual-correction-revision-mismatch"
        )
    )
  );
  assert.ok(
    decision.rejectedProposals.some(
      (rejection) =>
        rejection.source === "llm-type-repair" &&
        rejection.reasons.includes(
          "logical-question-revision-mismatch"
        )
    )
  );
});

test("deterministic ignore action suppresses a response without discarding the question", () => {
  const decision = settle({
    deterministicProposal: proposal("deterministic-fast-path", {
      questionType: "unknown",
      relation: "unknown",
      action: "ignore",
    }),
  });

  assert.equal(decision.questionType, "unknown");
  assert.equal(decision.responseAuthorized, false);
  assert.equal(decision.action, "ignore");
  assert.ok(
    decision.reasons.includes("response-not-authorized:ignore")
  );
});

test("settlement IDs are deterministic and trace metadata carries proposal rejections", () => {
  const first = settle({
    llmProposal: proposal("llm-type-repair", {
      questionType: "coding",
    }),
  });
  const duplicate = settle({
    llmProposal: proposal("llm-type-repair", {
      questionType: "coding",
    }),
  });
  const trace = formatCurrentQuestionSettlementForTrace(first);

  assert.equal(first.settlementId, duplicate.settlementId);
  assert.equal(
    trace.currentQuestionSettlementId,
    first.settlementId
  );
  assert.equal(trace.currentQuestionSettlementType, "unknown");
  assert.deepEqual(
    trace.currentQuestionSettlementRejectedProposals,
    first.rejectedProposals
  );
});
