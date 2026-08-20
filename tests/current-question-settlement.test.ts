import assert from "node:assert/strict";
import test from "node:test";
import {
  createProvisionalCurrentQuestion,
  decideCurrentQuestionMutationAuthority,
  formatCurrentQuestionMutationAuthorityForTrace,
  formatCurrentQuestionSettlementForTrace,
  formatCurrentQuestionTerminalNoAnswerForTrace,
  formatProvisionalCurrentQuestionForTrace,
  resolveCurrentQuestionSettlementDisposition,
  settlementAuthorizesFollowupParentScope,
  settleCurrentQuestion,
  settleCurrentQuestionTerminalNoAnswer,
  type CurrentQuestionSettlementProposal,
} from "../src/lib/meeting/current-question-settlement.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import { projectPrimaryAsk } from "../src/lib/meeting/primary-ask-projection.js";

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

  const settlement = settleCurrentQuestion({
    currentQuestion: first,
    deterministicProposal: proposal("deterministic-fast-path", {
      sourceHash: first.sourceHash,
    }),
    manualCorrectionRevision: 0,
    policy: {
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: true,
    },
  });
  const trace = formatCurrentQuestionSettlementForTrace(settlement);

  assert.equal(settlement.sourceKind, "mixed");
  assert.deepEqual(settlement.sourceTurnIds, ["turn-a", "turn-b"]);
  assert.deepEqual(settlement.sourceObservationIds, ["observation-a"]);
  assert.equal(trace.currentQuestionSettlementSourceKind, "mixed");
  assert.deepEqual(trace.currentQuestionSettlementSourceTurnIds, [
    "turn-a",
    "turn-b",
  ]);
  assert.deepEqual(trace.currentQuestionSettlementSourceObservationIds, [
    "observation-a",
  ]);
});

test("authorizes active-parent scope only for a bound settled follow-up", () => {
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: logicalQuestion(),
    sourceKind: "screen",
    sourceObservationIds: ["observation-a"],
  });
  const settledFollowup = settleCurrentQuestion({
    currentQuestion,
    deterministicProposal: proposal("deterministic-fast-path", {
      relation: "unknown",
      relationEvidenceAuthorized: false,
      expectedParentId: "parent-a",
      expectedParentRevision: 3,
    }),
    llmProposal: proposal("llm-type-repair", {
      questionType: undefined,
      typeEvidenceAuthorized: false,
      relation: "followup-parent",
      relationEvidenceAuthorized: true,
      expectedParentId: "parent-a",
      expectedParentRevision: 3,
    }),
    activeParentId: "parent-a",
    activeParentRevision: 3,
    manualCorrectionRevision: 0,
    policy: {
      allowLlmRelationRepair: true,
      llmRelationRepairMinConfidence: 0.95,
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: true,
    },
  });

  assert.equal(settledFollowup.relation, "followup-parent");
  assert.equal(settledFollowup.relationMutationAuthorized, true);
  assert.equal(settledFollowup.parentMutationAuthorized, false);
  assert.equal(
    settlementAuthorizesFollowupParentScope(settledFollowup),
    true
  );
  assert.equal(
    settlementAuthorizesFollowupParentScope({
      ...settledFollowup,
      relationMutationAuthorized: false,
    }),
    false
  );
  assert.equal(
    settlementAuthorizesFollowupParentScope({
      ...settledFollowup,
      activeParentId: undefined,
    }),
    false
  );
});

test("settles current-question identity from semantic evidence, not only the terminal ask", () => {
  const text =
    "Now try to add a surge pricing and explain which components need to change.";
  const projection = projectPrimaryAsk({
    turnId: "turn-b",
    text,
  });
  const unit: LogicalQuestionUnit = {
    ...logicalQuestion(
      2,
      projection.normalizedPrimaryAsk ?? text
    ),
    currentTurnId: "turn-b",
    sourceTurnIds: ["turn-b"],
    sources: [
      {
        turnId: "turn-b",
        text,
        startedAt: 30,
        endedAt: 40,
      },
    ],
    primaryAskProjection: projection,
  };
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: unit,
    sourceKind: "voice",
  });

  assert.equal(
    currentQuestion.normalizedText,
    "try to add a surge pricing explain which components need to change."
  );
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

test("an operation-specific policy can authorize a high-confidence LLM relation", () => {
  const decision = settle({
    llmProposal: proposal("llm-type-repair", {
      questionType: "ai-ml-system-design",
      relation: "followup-parent",
      confidence: 0.96,
    }),
    policy: {
      allowLlmTypeRepair: true,
      allowLlmRelationRepair: true,
      llmTypeRepairMinConfidence: 0.88,
      llmRelationRepairMinConfidence: 0.88,
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: false,
    },
  });

  assert.equal(decision.questionType, "ai-ml-system-design");
  assert.equal(decision.relation, "followup-parent");
  assert.equal(decision.relationMutationAuthorized, true);
  assert.equal(decision.relationAuthoritySource, "llm-type-repair");
  assert.equal(decision.parentMutationAuthorized, false);
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

test("authorizes only an exact high-confidence ambient no-answer result", () => {
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: logicalQuestion(
      2,
      "That looks good to me."
    ),
    sourceKind: "voice",
  });
  const decision = settleCurrentQuestionTerminalNoAnswer({
    currentQuestion,
    operationAuthorized: true,
    manualCorrectionRevision: 0,
    candidate: {
      operationId: "operation-a",
      proposal: proposal("llm-type-repair", {
        sourceHash: currentQuestion.sourceHash,
        questionType: "unknown",
        relation: "none",
        action: "ignore",
        evidenceMode: "unknown",
        confidence: 0.99,
      }),
      speechAct: "acknowledgement",
      normalizedQuestion: "",
      primaryAskSpanCount: 0,
      budgetSlot: "ambient",
      sourceOwnedSubstantive: false,
    },
    now: 100,
  });
  const trace = formatCurrentQuestionTerminalNoAnswerForTrace(
    decision
  );

  assert.equal(decision.terminalNoAnswerAuthorized, true);
  assert.equal(decision.disposition, "terminal-no-answer");
  assert.equal(decision.operationKind, "filler-ignore");
  assert.equal(decision.displayDisposition, "hidden-eligible");
  assert.equal(decision.contextDisposition, "discard");
  assert.equal(decision.settledAt, 100);
  assert.equal(
    trace.currentQuestionTerminalNoAnswerAuthorized,
    true
  );
  assert.equal(
    trace.currentQuestionTerminalNoAnswerUnitId,
    "logical-question-a"
  );
});

test("keeps informational context visible while suppressing an answer opportunity", () => {
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: logicalQuestion(
      2,
      "The role works closely with the platform and search teams."
    ),
    sourceKind: "voice",
  });
  const decision = settleCurrentQuestionTerminalNoAnswer({
    currentQuestion,
    operationAuthorized: true,
    manualCorrectionRevision: 0,
    candidate: {
      operationId: "operation-info",
      proposal: proposal("llm-type-repair", {
        sourceHash: currentQuestion.sourceHash,
        questionType: "unknown",
        relation: "none",
        action: "append-context",
        evidenceMode: "unknown",
        confidence: 0.96,
      }),
      speechAct: "informational",
      normalizedQuestion: "",
      primaryAskSpanCount: 0,
      budgetSlot: "ambient",
      sourceOwnedSubstantive: false,
    },
  });
  const trace = formatCurrentQuestionTerminalNoAnswerForTrace(
    decision
  );

  assert.equal(decision.terminalNoAnswerAuthorized, true);
  assert.equal(
    decision.operationKind,
    "informational-no-primary-ask"
  );
  assert.equal(decision.displayDisposition, "visible");
  assert.equal(
    decision.contextDisposition,
    "append-bounded-context"
  );
  assert.equal(
    trace.currentQuestionTerminalNoAnswerOperationKind,
    "informational-no-primary-ask"
  );
});

test("fails open when informational speech contains a primary ask", () => {
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: logicalQuestion(
      2,
      "The role works with search. How would you design retrieval?"
    ),
    sourceKind: "voice",
  });
  const baseCandidate = {
    proposal: proposal("llm-type-repair", {
      sourceHash: currentQuestion.sourceHash,
      questionType: "unknown",
      relation: "none" as const,
      action: "append-context" as const,
      evidenceMode: "unknown" as const,
      confidence: 0.99,
    }),
    speechAct: "informational" as const,
    normalizedQuestion: "",
    primaryAskSpanCount: 0,
    budgetSlot: "ambient" as const,
    sourceOwnedSubstantive: false,
  };

  for (const candidate of [
    {
      ...baseCandidate,
      normalizedQuestion: "How would you design retrieval?",
    },
    {
      ...baseCandidate,
      primaryAskSpanCount: 1,
    },
    {
      ...baseCandidate,
      budgetSlot: "substantive" as const,
      sourceOwnedSubstantive: true,
    },
  ]) {
    const decision = settleCurrentQuestionTerminalNoAnswer({
      currentQuestion,
      operationAuthorized: true,
      manualCorrectionRevision: 0,
      candidate,
    });
    assert.equal(decision.terminalNoAnswerAuthorized, false);
  }
});

test("uses a stricter threshold for filler than informational context", () => {
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: logicalQuestion(2, "Background context."),
    sourceKind: "voice",
  });
  const informational = settleCurrentQuestionTerminalNoAnswer({
    currentQuestion,
    operationAuthorized: true,
    manualCorrectionRevision: 0,
    candidate: {
      proposal: proposal("llm-type-repair", {
        sourceHash: currentQuestion.sourceHash,
        questionType: "unknown",
        relation: "none",
        action: "append-context",
        evidenceMode: "unknown",
        confidence: 0.96,
      }),
      speechAct: "informational",
      normalizedQuestion: "",
      primaryAskSpanCount: 0,
      budgetSlot: "ambient",
      sourceOwnedSubstantive: false,
    },
  });
  const filler = settleCurrentQuestionTerminalNoAnswer({
    currentQuestion,
    operationAuthorized: true,
    manualCorrectionRevision: 0,
    candidate: {
      proposal: proposal("llm-type-repair", {
        sourceHash: currentQuestion.sourceHash,
        questionType: "unknown",
        relation: "none",
        action: "ignore",
        evidenceMode: "unknown",
        confidence: 0.96,
      }),
      speechAct: "acknowledgement",
      normalizedQuestion: "",
      primaryAskSpanCount: 0,
      budgetSlot: "ambient",
      sourceOwnedSubstantive: false,
    },
  });

  assert.equal(informational.terminalNoAnswerAuthorized, true);
  assert.equal(filler.terminalNoAnswerAuthorized, false);
  assert.equal(filler.disposition, "confidence-below-threshold");
});

test("fails open for stale, low-confidence, or substantive no-answer proposals", () => {
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: logicalQuestion(
      2,
      "Can you explain reciprocal rank fusion?"
    ),
    sourceKind: "voice",
  });
  const candidate = {
    operationId: "operation-a",
    proposal: proposal("llm-type-repair", {
      sourceHash: currentQuestion.sourceHash,
      questionType: "unknown",
      relation: "none" as const,
      action: "ignore" as const,
      evidenceMode: "unknown" as const,
      confidence: 0.99,
    }),
    speechAct: "logistics" as const,
    normalizedQuestion: "",
    primaryAskSpanCount: 0,
    budgetSlot: "ambient" as const,
    sourceOwnedSubstantive: false,
  };

  const stale = settleCurrentQuestionTerminalNoAnswer({
    currentQuestion,
    operationAuthorized: true,
    manualCorrectionRevision: 0,
    candidate: {
      ...candidate,
      proposal: {
        ...candidate.proposal,
        revision: 1,
      },
    },
  });
  assert.equal(stale.terminalNoAnswerAuthorized, false);
  assert.equal(stale.disposition, "proposal-stale-or-invalid");

  const lowConfidence = settleCurrentQuestionTerminalNoAnswer({
    currentQuestion,
    operationAuthorized: true,
    manualCorrectionRevision: 0,
    candidate: {
      ...candidate,
      proposal: {
        ...candidate.proposal,
        confidence: 0.8,
      },
    },
  });
  assert.equal(lowConfidence.terminalNoAnswerAuthorized, false);
  assert.equal(
    lowConfidence.disposition,
    "confidence-below-threshold"
  );

  const substantive = settleCurrentQuestionTerminalNoAnswer({
    currentQuestion,
    operationAuthorized: true,
    manualCorrectionRevision: 0,
    candidate: {
      ...candidate,
      budgetSlot: "substantive",
      sourceOwnedSubstantive: true,
    },
  });
  assert.equal(substantive.terminalNoAnswerAuthorized, false);
  assert.equal(
    substantive.disposition,
    "substantive-source-protected"
  );
});

test("keeps a source-owned add-on ask out of terminal no-answer settlement", () => {
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: logicalQuestion(
      2,
      "Thanks, and can you explain RAG?"
    ),
    sourceKind: "voice",
  });
  const decision = settleCurrentQuestionTerminalNoAnswer({
    currentQuestion,
    operationAuthorized: true,
    manualCorrectionRevision: 0,
    candidate: {
      proposal: proposal("llm-type-repair", {
        sourceHash: currentQuestion.sourceHash,
        questionType: "unknown",
        relation: "none",
        action: "ignore",
        evidenceMode: "unknown",
        confidence: 0.99,
      }),
      speechAct: "acknowledgement",
      normalizedQuestion: "",
      primaryAskSpanCount: 0,
      budgetSlot: "substantive",
      sourceOwnedSubstantive: true,
    },
  });

  assert.equal(decision.terminalNoAnswerAuthorized, false);
  assert.equal(
    decision.disposition,
    "substantive-source-protected"
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
