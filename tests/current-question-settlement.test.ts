import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeSettlementOwnedQuestionContext,
  createProvisionalCurrentQuestion,
  decideCurrentQuestionMutationAuthority,
  formatCurrentQuestionMutationAuthorityForTrace,
  formatCurrentQuestionSettlementForTrace,
  formatCurrentQuestionSettlementIdentityValidationForTrace,
  formatProvisionalCurrentQuestionForTrace,
  resolveCurrentQuestionSourceKind,
  resolveSettlementOwnedQuestionSource,
  resolveCurrentQuestionSettlementDisposition,
  settlementAuthorizesFollowupParentScope,
  settlementAuthorizesTaskTransition,
  settleCurrentQuestion,
  selectCommittedSettlementForLogicalQuestionUnit,
  validateCurrentQuestionSettlementIdentity,
  type CurrentQuestionSettlementDisposition,
  type CurrentQuestionSettlementProposal,
} from "../src/lib/meeting/current-question-settlement.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import { projectPrimaryAsk } from "../src/lib/meeting/primary-ask-projection.js";

type ResponseOnlyIsNotLiveDisposition = Extract<
  CurrentQuestionSettlementDisposition,
  "response-only"
> extends never
  ? true
  : false;

const RESPONSE_ONLY_IS_NOT_LIVE_DISPOSITION: ResponseOnlyIsNotLiveDisposition =
  true;

test("keeps response-only outside the live settlement disposition contract", () => {
  assert.equal(RESPONSE_ONLY_IS_NOT_LIVE_DISPOSITION, true);
});

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

test("validates the complete settlement identity before consumer use", () => {
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: logicalQuestion(),
    sourceKind: "voice",
  });
  const settlement = settleCurrentQuestion({
    currentQuestion,
    deterministicProposal: proposal("deterministic-fast-path", {
      sourceHash: currentQuestion.sourceHash,
    }),
    manualCorrectionRevision: 0,
    policy: {
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: true,
    },
  });

  const valid = validateCurrentQuestionSettlementIdentity({
    settlement,
    currentQuestion,
  });
  assert.equal(valid.authorized, true);
  assert.deepEqual(valid.reasons, []);

  const revisedQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: logicalQuestion(3),
    sourceKind: "voice",
  });
  const stale = validateCurrentQuestionSettlementIdentity({
    settlement,
    currentQuestion: revisedQuestion,
  });
  assert.equal(stale.authorized, false);
  assert.deepEqual(stale.reasons, [
    "logical-question-revision-mismatch",
    "source-hash-mismatch",
  ]);
  assert.deepEqual(
    formatCurrentQuestionSettlementIdentityValidationForTrace(stale),
    {
      currentQuestionSettlementInputIdentityAuthorized: false,
      currentQuestionSettlementInputIdentityMismatchReasons: [
        "logical-question-revision-mismatch",
        "source-hash-mismatch",
      ],
    }
  );
});

test("derives source kind from owned evidence before compatibility fallback", () => {
  assert.equal(
    resolveCurrentQuestionSourceKind({
      sourceTurnIds: ["turn-a"],
      sourceObservationIds: [],
      fallback: "screen",
    }),
    "voice"
  );
  assert.equal(
    resolveCurrentQuestionSourceKind({
      sourceTurnIds: [],
      sourceObservationIds: ["screen-a"],
      fallback: "voice",
    }),
    "screen"
  );
  assert.equal(
    resolveCurrentQuestionSourceKind({
      sourceTurnIds: ["turn-a"],
      sourceObservationIds: ["screen-a"],
      fallback: "voice",
    }),
    "mixed"
  );
  assert.equal(
    resolveCurrentQuestionSourceKind({
      sourceTurnIds: [],
      sourceObservationIds: [],
      fallback: "screen",
    }),
    "screen"
  );

  const voiceQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: logicalQuestion(),
    sourceKind: "screen",
  });
  assert.equal(voiceQuestion.sourceKind, "voice");
});

test("keeps settlement-owned source identity intact over active-screen fallback", () => {
  const voiceSource = resolveSettlementOwnedQuestionSource({
    settlement: {
      sourceKind: "voice",
      sourceObservationIds: [],
    },
    fallbackSourceKind: "mixed",
    fallbackSourceObservationIds: ["active-screen"],
  });
  assert.deepEqual(voiceSource, {
    sourceKind: "voice",
    sourceObservationIds: [],
  });

  const boundScreenSource = resolveSettlementOwnedQuestionSource({
    settlement: {
      sourceKind: "mixed",
      sourceObservationIds: ["bound-screen"],
    },
    fallbackSourceKind: "mixed",
    fallbackSourceObservationIds: ["newer-active-screen"],
  });
  assert.deepEqual(boundScreenSource, {
    sourceKind: "mixed",
    sourceObservationIds: ["bound-screen"],
  });

  const fallbackSource = resolveSettlementOwnedQuestionSource({
    fallbackSourceKind: "mixed",
    fallbackSourceObservationIds: ["active-screen"],
  });
  assert.deepEqual(fallbackSource, {
    sourceKind: "mixed",
    sourceObservationIds: ["active-screen"],
  });
});

test("authorizes exact settlement-owned Screen context without an active parent", () => {
  assert.deepEqual(
    authorizeSettlementOwnedQuestionContext({
      sourceKind: "screen",
      sourceObservationIds: ["screen-1"],
      logicalQuestionText: "Implement an LRU cache",
      screenObservations: [{ id: "screen-1", imageBase64: "image" }],
    }),
    {
      authorized: true,
      reason: "authorized",
      sourceKind: "screen",
      sourceObservationIds: ["screen-1"],
      preferredObservationId: "screen-1",
    }
  );

  assert.equal(
    authorizeSettlementOwnedQuestionContext({
      sourceKind: "screen",
      sourceObservationIds: ["missing"],
      logicalQuestionText: "Implement an LRU cache",
      screenObservations: [],
    }).reason,
    "source-observation-not-found"
  );
  assert.equal(
    authorizeSettlementOwnedQuestionContext({
      sourceKind: "voice",
      logicalQuestionText: "Implement an LRU cache",
    }).authorized,
    true
  );
});

test("validates a voice settlement while an active-screen fallback exists", () => {
  const logicalQuestionUnit = logicalQuestion();
  const source = resolveSettlementOwnedQuestionSource({
    settlement: {
      sourceKind: "voice",
      sourceObservationIds: [],
    },
    fallbackSourceKind: "mixed",
    fallbackSourceObservationIds: ["active-screen"],
  });
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit,
    ...source,
  });
  const settlement = settleCurrentQuestion({
    currentQuestion,
    deterministicProposal: proposal("deterministic-fast-path", {
      sourceHash: currentQuestion.sourceHash,
    }),
    manualCorrectionRevision: 0,
    policy: {
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: true,
    },
  });

  assert.deepEqual(
    validateCurrentQuestionSettlementIdentity({
      settlement,
      currentQuestion,
    }),
    { authorized: true, reasons: [] }
  );
  assert.equal(currentQuestion.sourceKind, "voice");
  assert.deepEqual(currentQuestion.sourceObservationIds, []);
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
    llmProposal: proposal("runtime-adjudication", {
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
  assert.equal(settlementAuthorizesTaskTransition(settledFollowup), true);
  assert.equal(
    settlementAuthorizesTaskTransition({
      ...settledFollowup,
      relation: "child-probe",
    }),
    true
  );
  assert.equal(
    settlementAuthorizesTaskTransition({
      ...settledFollowup,
      relation: "resume-parent",
    }),
    true
  );
  assert.equal(
    settlementAuthorizesTaskTransition({
      ...settledFollowup,
      relationMutationAuthorized: false,
    }),
    false
  );
});

test("keeps runtime Type and Relation confidence independent", () => {
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: logicalQuestion(),
    sourceKind: "voice",
  });
  const identity = {
    sessionId: currentQuestion.sessionId,
    runtimeEpoch: currentQuestion.runtimeEpoch,
    logicalQuestionUnitId: currentQuestion.logicalQuestionUnitId,
    revision: currentQuestion.revision,
    sourceHash: currentQuestion.sourceHash,
    expectedParentId: "parent-a",
    expectedParentRevision: 3,
  };
  const settlement = settleCurrentQuestion({
    currentQuestion,
    runtimeTypeProposal: {
      ...identity,
      source: "runtime-adjudication",
      questionType: "coding",
      relation: "unknown",
      action: "answer",
      confidence: 0.9,
      typeEvidenceAuthorized: true,
      relationEvidenceAuthorized: false,
      actionEvidenceAuthorized: true,
    },
    runtimeRelationProposal: {
      ...identity,
      source: "runtime-adjudication",
      relation: "child-probe",
      confidence: 0.95,
      typeEvidenceAuthorized: false,
      relationEvidenceAuthorized: true,
      actionEvidenceAuthorized: false,
    },
    activeParentId: "parent-a",
    activeParentRevision: 3,
    manualCorrectionRevision: 0,
    policy: {
      allowRuntimeTypeAdjudication: true,
      allowLlmRelationRepair: true,
      allowLlmActionRepair: true,
      runtimeTypeAdjudicationMinConfidence: 0,
      llmRelationRepairMinConfidence: 0.95,
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: true,
    },
  });

  assert.equal(settlement.questionType, "coding");
  assert.equal(settlement.relation, "child-probe");
  assert.equal(settlement.typeMutationAuthorized, true);
  assert.equal(settlement.relationMutationAuthorized, true);
  assert.equal(settlement.rejectedProposals.length, 0);
});

test("combines an LLM type with a deterministic first-parent relation", () => {
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: logicalQuestion(),
    sourceKind: "voice",
  });
  const settlement = settleCurrentQuestion({
    currentQuestion,
    deterministicProposal: proposal("deterministic-fast-path", {
      sourceHash: currentQuestion.sourceHash,
      questionType: undefined,
      typeEvidenceAuthorized: false,
      relation: "new-parent",
      relationEvidenceAuthorized: true,
    }),
    llmProposal: proposal("runtime-adjudication", {
      sourceHash: currentQuestion.sourceHash,
      questionType: "general-system-design",
      typeEvidenceAuthorized: true,
      relation: "unknown",
      relationEvidenceAuthorized: false,
    }),
    manualCorrectionRevision: 0,
    policy: {
      allowRuntimeTypeAdjudication: true,
      runtimeTypeAdjudicationMinConfidence: 0,
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: true,
    },
  });

  assert.equal(settlement.questionType, "general-system-design");
  assert.equal(settlement.typeAuthoritySource, "runtime-adjudication");
  assert.equal(settlement.relation, "new-parent");
  assert.equal(
    settlement.relationAuthoritySource,
    "deterministic-fast-path"
  );
  assert.equal(settlement.relationMutationAuthorized, true);
  assert.equal(settlement.parentMutationAuthorized, true);
  assert.deepEqual(settlement.rejectedProposals, []);
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

test("does not let type adjudication implicitly authorize relation or parent mutation", () => {
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: logicalQuestion(),
    sourceKind: "voice",
  });
  const decision = decideCurrentQuestionMutationAuthority({
    currentQuestion,
    proposedQuestionType: "general-system-design",
    proposedRelation: "new-parent",
    authoritySource: "runtime-adjudication",
    typeEvidenceAuthorized: true,
    relationEvidenceAuthorized: false,
    runtimeMutationAuthorized: true,
    questionComplete: true,
    commitParent: true,
  });

  assert.equal(decision.authority, "runtime-adjudication");
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
  assert.equal(metadata.currentQuestionSourceKind, "mixed");
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
    llmProposal: proposal("runtime-adjudication", {
      questionType: "coding",
    }),
    policy: {
      allowRuntimeTypeAdjudication: true,
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

test("distinguishes unresolved, domain-resolved, committed, and stale dispositions", () => {
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
    "domain-resolved-provisional"
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

test("deterministic evidence outranks an enabled Runtime type adjudication", () => {
  const decision = settle({
    deterministicProposal: proposal("deterministic-fast-path", {
      questionType: "general-system-design",
    }),
    llmProposal: proposal("runtime-adjudication", {
      questionType: "coding",
    }),
    policy: {
      allowRuntimeTypeAdjudication: true,
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
    llmProposal: proposal("runtime-adjudication", {
      questionType: "coding",
      relation: "new-parent",
    }),
    policy: {
      allowRuntimeTypeAdjudication: true,
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
    llmProposal: proposal("runtime-adjudication", {
      questionType: "ai-ml-system-design",
      relation: "followup-parent",
      confidence: 0.96,
    }),
    policy: {
      allowRuntimeTypeAdjudication: true,
      allowLlmRelationRepair: true,
      runtimeTypeAdjudicationMinConfidence: 0.88,
      llmRelationRepairMinConfidence: 0.88,
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: false,
    },
  });

  assert.equal(decision.questionType, "ai-ml-system-design");
  assert.equal(decision.relation, "followup-parent");
  assert.equal(decision.relationMutationAuthorized, true);
  assert.equal(decision.relationAuthoritySource, "runtime-adjudication");
  assert.equal(decision.parentMutationAuthorized, false);
});

test("Runtime type adjudication can combine with separately authorized deterministic relation evidence", () => {
  const decision = settle({
    deterministicProposal: proposal("deterministic-fast-path", {
      questionType: "unknown",
      relation: "new-parent",
    }),
    llmProposal: proposal("runtime-adjudication", {
      questionType: "ai-ml-system-design",
      relation: "followup-parent",
    }),
    policy: {
      allowRuntimeTypeAdjudication: true,
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: true,
    },
  });

  assert.equal(decision.questionType, "ai-ml-system-design");
  assert.equal(decision.relation, "new-parent");
  assert.equal(decision.typeAuthoritySource, "runtime-adjudication");
  assert.equal(
    decision.relationAuthoritySource,
    "deterministic-fast-path"
  );
  assert.equal(decision.parentMutationAuthorized, true);
});

test("Runtime type adjudication stays shadowed unless the operation enables it", () => {
  const decision = settle({
    llmProposal: proposal("runtime-adjudication", {
      questionType: "coding",
    }),
  });

  assert.equal(decision.questionType, "unknown");
  assert.equal(decision.typeMutationAuthorized, false);
  assert.equal(decision.responseAuthorized, true);
  assert.ok(
    decision.rejectedProposals.some((rejection) =>
      rejection.reasons.includes("runtime-adjudication-disabled")
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
    llmProposal: proposal("runtime-adjudication", {
      questionType: "coding",
      revision: 1,
    }),
    policy: {
      allowRuntimeTypeAdjudication: true,
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
        rejection.source === "runtime-adjudication" &&
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
    llmProposal: proposal("runtime-adjudication", {
      questionType: "coding",
    }),
  });
  const duplicate = settle({
    llmProposal: proposal("runtime-adjudication", {
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

test("reuses committed source identity only for the exact response-action LQU", () => {
  const settlement = settle();

  assert.equal(
    selectCommittedSettlementForLogicalQuestionUnit({
      settlement,
      logicalQuestionUnit: {
        id: settlement.logicalQuestionUnitId,
        revision: settlement.revision,
      },
    }),
    settlement
  );
  assert.equal(
    selectCommittedSettlementForLogicalQuestionUnit({
      settlement,
      logicalQuestionUnit: {
        id: settlement.logicalQuestionUnitId,
        revision: settlement.revision + 1,
      },
    }),
    undefined
  );
});
