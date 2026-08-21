import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import {
  createProvisionalCurrentQuestion,
  settleCurrentQuestion,
} from "../src/lib/meeting/current-question-settlement.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import {
  buildTaskRelationAdjudicationPrompts,
  buildTaskRelationAdjudicationRequest,
  compareTaskRelationAdjudication,
  createTaskRelationSettlementProposal,
  decideNarrowScreenRelationRelease,
  decideNarrowVoiceRelationRelease,
  decideTaskRelationAdjudicationEligibility,
  deriveRuntimeTaskRelationFromAtomicDecision,
  formatTaskRelationAdjudicationForTrace,
  parseTaskRelationAdjudicationOutput,
  settleNarrowVoiceTypeRelation,
} from "../src/lib/meeting/task-relation-adjudication.js";

function unit(text: string, revision = 1): LogicalQuestionUnit {
  return {
    id: "logical-question-relation",
    revision,
    sessionId: "session-a",
    runtimeEpoch: 4,
    currentTurnId: "turn-current",
    sourceTurnIds: ["turn-current"],
    sources: [
      {
        turnId: "turn-current",
        text,
        startedAt: 100,
        endedAt: 200,
      },
    ],
    normalizedText: text,
    startedAt: 100,
    updatedAt: 200,
    compositionReasons: ["independent-current-turn"],
    boundaryReason: "independent-current-turn",
    truncated: false,
  };
}

function activeTask(withChild = false): ActiveMeetingTask {
  return {
    id: "parent-a",
    runtimeRevision: 1,
    source: "voice",
    parent: {
      id: "parent-a",
      questionType: "ai-ml-system-design",
      topic: "Design a RAG system for trip planning",
      playbookPhase: "design_framing",
      phaseProgress: { design_framing: true },
      projectBinding: {
        projectId: "secret-project",
        projectName: "Secret project",
        primaryEntryId: "secret-primary-entry",
        evidenceEntryIds: ["private evidence"],
        source: "memory",
        confidence: 1,
        lockedAt: 10,
        revision: 1,
        reason: "private binding reason",
      },
      supportedFactAnchors: ["private-fact-anchor"],
      latestUsefulAnswer: "private generated answer",
      previousUsefulAnswer: "older private generated answer",
      whiteboardArtifact: {
        id: "whiteboard-a",
        parentTaskId: "parent-a",
        domainTrack: "genai_sd",
        archetypeIds: [],
        selectedOverlayIds: [],
        currentPhase: "design_framing",
        title: "Private diagram",
        content: "graph TD; secret-->answer",
        summary: "private whiteboard summary",
        revision: 2,
        updateSource: "model-output",
        updatedAt: 20,
        createdAt: 10,
      },
      parentContextHandoff: {
        sourceParentId: "parent-before",
        transitionKind: "domain-extension",
        sourceQuestionId: "question-before",
        sharedScenarioContext: {
          productIdentity: "Trip planner",
          domainEntities: ["traveler", "itinerary"],
          sharedRequirements: ["support fresh travel content"],
        },
        excludedContextKinds: ["generated-answer"],
      },
      createdAt: 10,
      updatedAt: 20,
      revisions: 3,
    },
    child: withChild
      ? {
          id: "child-a",
          createdAt: 30,
          updatedAt: 30,
          questionType: "field-knowledge",
          relation: "child-probe",
          intent: "concept-probe",
          question: "Explain HNSW in the retrieval component",
          compactSummary: "Bounded HNSW concept probe",
          basedOnTurnIds: ["turn-child"],
          basedOnObservationIds: [],
        }
      : undefined,
  };
}

function atomicOutput(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    dependency: "parent-dependent",
    continuationShape: "mainline",
    returnIntent: "no-resume",
    switchIntent: "no-explicit-switch",
    standaloneSufficiency: "insufficient",
    confidence: 0.93,
    currentQuestionEvidenceSpans: ["fresh documents"],
    parentEvidenceSpans: ["RAG system for trip planning"],
    ...overrides,
  };
}

function directOutput(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schemaVersion: 3,
    relation: "followup-parent",
    confidence: 0.97,
    currentQuestionEvidenceSpans: ["fresh documents"],
    parentEvidenceSpans: ["RAG system for trip planning"],
    ...overrides,
  };
}

test("builds a bounded relation-only request without generated or factual context", () => {
  const request = buildTaskRelationAdjudicationRequest({
    logicalQuestionUnit: unit(
      "How would this retrieval design handle fresh documents?"
    ),
    activeMeetingTask: activeTask(),
    recentTurns: [
      {
        id: "turn-parent",
        speaker: "them",
        text: "Design a RAG system for trip planning.",
        startedAt: 10,
        endedAt: 20,
        isFinal: true,
        source: "system-audio",
      },
      {
        id: "constraint-a",
        speaker: "them",
        text: "Assume 10 million users and p99 latency under 200 ms.",
        startedAt: 30,
        endedAt: 40,
        isFinal: true,
        source: "system-audio",
      },
      {
        id: "transition-a",
        speaker: "them",
        text: "Now let's return to the original architecture.",
        startedAt: 50,
        endedAt: 60,
        isFinal: true,
        source: "system-audio",
      },
    ],
  });
  const prompts = buildTaskRelationAdjudicationPrompts(request);
  const serialized = JSON.stringify(request);

  assert.equal(request.activeParent.revision, 3);
  assert.equal(request.recentTransitions.length, 1);
  assert.deepEqual(
    request.recentSourceEvidence.map((item) => item.role),
    ["question", "constraint", "transition"]
  );
  assert.equal(request.activeChild, undefined);
  assert.deepEqual(request.activeParent.acceptedConstraints, [
    request.recentSourceEvidence[1],
  ]);
  assert.match(prompts.systemPrompt, /one canonical relation/i);
  assert.match(prompts.systemPrompt, /schemaVersion:3/i);
  assert.doesNotMatch(
    prompts.userMessage,
    /questionType|advisor action|memory|whiteboard/i
  );
  assert.doesNotMatch(
    serialized,
    /private generated answer|older private generated answer|private-fact-anchor|secret-project|graph TD/i
  );
  assert.match(serialized, /support fresh travel content/i);
  assert.match(serialized, /10 million users/i);
});

test("active child relation evidence includes only source-owned question text", () => {
  const request = buildTaskRelationAdjudicationRequest({
    logicalQuestionUnit: unit("How would that change the parent design?"),
    activeMeetingTask: activeTask(true),
    recentTurns: [
      {
        id: "turn-child",
        speaker: "them",
        text: "Explain HNSW in the retrieval component.",
        startedAt: 20,
        endedAt: 30,
        isFinal: true,
        source: "system-audio",
      },
    ],
  });
  const serialized = JSON.stringify(request);

  assert.equal(
    request.activeChild?.question,
    "Explain HNSW in the retrieval component"
  );
  assert.deepEqual(request.activeChild?.sourceTurnIds, ["turn-child"]);
  assert.doesNotMatch(serialized, /Bounded HNSW concept probe/i);
});

test("strictly parses grounded follow-up and rejects broader authority", () => {
  const request = buildTaskRelationAdjudicationRequest({
    logicalQuestionUnit: unit(
      "How would this retrieval design handle fresh documents?"
    ),
    activeMeetingTask: activeTask(),
  });
  const valid = atomicOutput();

  const parsed = parseTaskRelationAdjudicationOutput(
    JSON.stringify(valid),
    request
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.value.relation : undefined, "followup-parent");
  assert.deepEqual(
    parseTaskRelationAdjudicationOutput(
      JSON.stringify({
        ...valid,
        questionType: "ai-ml-system-design",
      }),
      request
    ),
    {
      ok: false,
      reason: "non-relation-field-present",
      errorKind: "schema",
      evidenceSpansValid: false,
    }
  );
  assert.deepEqual(
    parseTaskRelationAdjudicationOutput(
      JSON.stringify({
        ...valid,
        parentEvidenceSpans: ["invented parent context"],
      }),
      request
    ),
    {
      ok: false,
      reason: "invalid-parent-evidence",
      errorKind: "evidence",
      evidenceSpansValid: false,
    }
  );
});

test("parses one direct canonical relation without requiring atomic facets", () => {
  const request = buildTaskRelationAdjudicationRequest({
    logicalQuestionUnit: unit(
      "How would this retrieval design handle fresh documents?"
    ),
    activeMeetingTask: activeTask(),
  });
  const parsed = parseTaskRelationAdjudicationOutput(
    JSON.stringify(directOutput()),
    request
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.value.schemaVersion : undefined, 3);
  assert.equal(parsed.ok ? parsed.value.relation : undefined, "followup-parent");
  assert.equal(parsed.ok ? parsed.value.dependency : undefined, undefined);
  assert.deepEqual(
    parseTaskRelationAdjudicationOutput(
      JSON.stringify(
        directOutput({
          parentEvidenceSpans: [],
        })
      ),
      request
    ),
    {
      ok: false,
      reason: "parent-evidence-required",
      errorKind: "evidence",
      evidenceSpansValid: false,
    }
  );
});

test("normalizes only the known singular parent evidence alias and records it", () => {
  const request = buildTaskRelationAdjudicationRequest({
    logicalQuestionUnit: unit(
      "How would Redis support the URL shortener lookup path?"
    ),
    activeMeetingTask: activeTask(),
  });
  const parsed = parseTaskRelationAdjudicationOutput(
    JSON.stringify(
      atomicOutput({
        dependency: "parent-dependent",
        continuationShape: "bounded-detour",
        currentQuestionEvidenceSpans: ["Redis"],
        parentEvidenceSpans: undefined,
        parentEvidenceSpan: "RAG system for trip planning",
      })
    ),
    request
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.value.relation : undefined, "child-probe");
  assert.deepEqual(
    parsed.ok ? parsed.value.parentEvidenceSpans : undefined,
    ["RAG system for trip planning"]
  );
  assert.equal(parsed.ok ? parsed.schemaAliasApplied : undefined, true);
  const trace = formatTaskRelationAdjudicationForTrace({
    mode: "shadow",
    request,
    candidate: parsed.ok ? parsed.value : undefined,
    parseResult: parsed,
  });
  assert.equal(trace.taskRelationAdjudicationSchemaAliasApplied, true);
  assert.equal(
    trace.taskRelationAdjudicationSchemaAliasSourceField,
    "parentEvidenceSpan"
  );
  assert.equal(
    trace.taskRelationAdjudicationSchemaAliasCanonicalField,
    "parentEvidenceSpans"
  );
});

test("rejects conflicting or malformed parent evidence aliases", () => {
  const request = buildTaskRelationAdjudicationRequest({
    logicalQuestionUnit: unit(
      "How would this retrieval design handle fresh documents?"
    ),
    activeMeetingTask: activeTask(),
  });
  const valid = atomicOutput();

  assert.deepEqual(
    parseTaskRelationAdjudicationOutput(
      JSON.stringify({
        ...valid,
        parentEvidenceSpan: "RAG system for trip planning",
      }),
      request
    ),
    {
      ok: false,
      reason: "conflicting-parent-evidence-fields",
      errorKind: "schema",
      evidenceSpansValid: false,
    }
  );
  assert.deepEqual(
    parseTaskRelationAdjudicationOutput(
      JSON.stringify({
        ...valid,
        parentEvidenceSpans: undefined,
        parentEvidenceSpan: 42,
      }),
      request
    ),
    {
      ok: false,
      reason: "invalid-parent-evidence-alias",
      errorKind: "schema",
      evidenceSpansValid: false,
    }
  );
});

test("derives new parents only from independent standalone questions", () => {
  const request = buildTaskRelationAdjudicationRequest({
    logicalQuestionUnit: unit(
      "Now design an unrelated notification service."
    ),
    activeMeetingTask: activeTask(),
  });
  const insufficient = parseTaskRelationAdjudicationOutput(
    JSON.stringify(
      atomicOutput({
        dependency: "parent-independent",
        continuationShape: "unclear",
        switchIntent: "explicit-switch",
        standaloneSufficiency: "insufficient",
        currentQuestionEvidenceSpans: ["notification service"],
        parentEvidenceSpans: [],
      })
    ),
    request
  );
  const sufficient = parseTaskRelationAdjudicationOutput(
    JSON.stringify(
      atomicOutput({
        dependency: "parent-independent",
        continuationShape: "unclear",
        switchIntent: "explicit-switch",
        standaloneSufficiency: "sufficient",
        currentQuestionEvidenceSpans: ["notification service"],
        parentEvidenceSpans: [],
      })
    ),
    request
  );
  const ungroundedContinuation = parseTaskRelationAdjudicationOutput(
    JSON.stringify(
      atomicOutput({
        currentQuestionEvidenceSpans: ["notification service"],
        parentEvidenceSpans: [],
      })
    ),
    request
  );

  assert.equal(
    insufficient.ok ? insufficient.value.relation : undefined,
    "unknown"
  );
  assert.equal(
    sufficient.ok ? sufficient.value.relation : undefined,
    "new-parent"
  );
  assert.deepEqual(ungroundedContinuation, {
    ok: false,
    reason: "parent-evidence-required",
    errorKind: "evidence",
    evidenceSpansValid: false,
  });
});

test("resume intent is semantically valid without a production child", () => {
  const withoutChild = buildTaskRelationAdjudicationRequest({
    logicalQuestionUnit: unit(
      "Let's return to the original architecture."
    ),
    activeMeetingTask: activeTask(),
  });
  const withChild = buildTaskRelationAdjudicationRequest({
    logicalQuestionUnit: unit(
      "Let's return to the original architecture."
    ),
    activeMeetingTask: activeTask(true),
  });
  const output = atomicOutput({
    dependency: "parent-dependent",
    continuationShape: "unclear",
    returnIntent: "resume-suspended-parent",
    confidence: 0.97,
    currentQuestionEvidenceSpans: ["return to the original architecture"],
  });

  const parsedWithoutChild = parseTaskRelationAdjudicationOutput(
    JSON.stringify(output),
    withoutChild
  );
  assert.equal(parsedWithoutChild.ok, true);
  assert.equal(
    parsedWithoutChild.ok
      ? parsedWithoutChild.value.relation
      : undefined,
    "resume-parent"
  );
  const parsed = parseTaskRelationAdjudicationOutput(
    JSON.stringify(output),
    withChild
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.value.relation : undefined, "resume-parent");
});

test("keeps referential standalone counterfactuals unresolved", () => {
  const request = buildTaskRelationAdjudicationRequest({
    logicalQuestionUnit: unit("How would that change?"),
    activeMeetingTask: activeTask(),
  });
  const parsed = parseTaskRelationAdjudicationOutput(
    JSON.stringify(
      atomicOutput({
        dependency: "parent-independent",
        continuationShape: "unclear",
        standaloneSufficiency: "insufficient",
        currentQuestionEvidenceSpans: ["How would that change?"],
        parentEvidenceSpans: [],
      })
    ),
    request
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.value.relation : undefined, "unknown");
});

test("runtime derives relations from atomic decisions without switch authority", () => {
  assert.equal(
    deriveRuntimeTaskRelationFromAtomicDecision({
      dependency: "parent-dependent",
      continuationShape: "bounded-detour",
      returnIntent: "no-resume",
      switchIntent: "no-explicit-switch",
      standaloneSufficiency: "insufficient",
      hasActiveChild: false,
      hasParentEvidence: true,
    }),
    "child-probe"
  );
  assert.equal(
    deriveRuntimeTaskRelationFromAtomicDecision({
      dependency: "unclear",
      continuationShape: "unclear",
      returnIntent: "no-resume",
      switchIntent: "explicit-switch",
      standaloneSufficiency: "sufficient",
      hasActiveChild: false,
      hasParentEvidence: false,
    }),
    "unknown"
  );
});

test("runs only for evaluation-active unresolved source-owned questions", () => {
  const request = buildTaskRelationAdjudicationRequest({
    logicalQuestionUnit: unit(
      "How would that architecture handle a regional outage?"
    ),
    activeMeetingTask: activeTask(),
  });
  const common = {
    mode: "shadow" as const,
    speaker: "them" as const,
    request,
    manualCorrectionActive: false,
    deterministicRelationAuthorized: false,
    turnGateAction: "answer-refresh",
  };

  assert.equal(
    decideTaskRelationAdjudicationEligibility({
      ...common,
      evaluationActive: true,
    }).eligible,
    true
  );
  assert.equal(
    decideTaskRelationAdjudicationEligibility({
      ...common,
      evaluationActive: false,
    }).reason,
    "evaluation-inactive"
  );
  assert.equal(
    decideTaskRelationAdjudicationEligibility({
      ...common,
      evaluationActive: false,
      runtimeReleaseRequested: true,
    }).auditKind,
    "screen-release-candidate"
  );
  assert.equal(
    decideTaskRelationAdjudicationEligibility({
      ...common,
      evaluationActive: true,
      deterministicRelationAuthorized: true,
      deterministicRelation: "new-parent",
    }).auditKind,
    "deterministic-comparison"
  );
  assert.equal(
    decideTaskRelationAdjudicationEligibility({
      ...common,
      evaluationActive: true,
      deterministicRelationAuthorized: true,
      deterministicRelation: "new-parent",
    }).reason,
    "deterministic-relation-shadow-audit"
  );
  assert.equal(
    decideTaskRelationAdjudicationEligibility({
      ...common,
      evaluationActive: true,
      deterministicRelationAuthorized: true,
    }).reason,
    "deterministic-relation-not-auditable"
  );
  assert.equal(
    decideTaskRelationAdjudicationEligibility({
      ...common,
      evaluationActive: true,
      turnGateAction: "append-only",
    }).reason,
    "turn-gate-not-answer:append-only"
  );
});

test("narrowly releases a grounded cross-type manual screen boundary", () => {
  const candidate = {
    schemaVersion: 2 as const,
    relation: "new-parent" as const,
    dependency: "parent-independent" as const,
    continuationShape: "unclear" as const,
    returnIntent: "no-resume" as const,
    switchIntent: "no-explicit-switch" as const,
    standaloneSufficiency: "sufficient" as const,
    confidence: 0.98,
    currentQuestionEvidenceSpans: [
      "Tell me about a time you persuaded a stakeholder",
    ],
    parentEvidenceSpans: [],
    explicitBinding: false,
    standalone: true,
  };
  const common = {
    sourceKind: "screen" as const,
    screenBoundaryPrior: true,
    currentQuestionType: "behavioral",
    activeParentQuestionType: "coding",
    typeAuthoritySource: "screen-preflight",
    typeEvidenceAuthorized: true,
    typeConfidence: 0.99,
    questionComplete: true,
    manualCorrectionActive: false,
    hasActiveChild: false,
    operationLeaseAuthorized: true,
    releaseWindowOpen: true,
  };

  assert.deepEqual(
    decideNarrowScreenRelationRelease(common),
    {
      requested: true,
      authorized: false,
      reason: "eligible-awaiting-candidate",
      currentQuestionType: "behavioral",
      activeParentQuestionType: "coding",
      typeConfidence: 0.99,
      relationConfidence: 0,
      minimumConfidence: 0.95,
    }
  );
  assert.equal(
    decideNarrowScreenRelationRelease({
      ...common,
      candidate,
    }).authorized,
    true
  );
  assert.equal(
    decideNarrowScreenRelationRelease({
      ...common,
      candidate: {
        ...candidate,
        parentEvidenceSpans: [
          "Compare this answer with the previous coding response",
        ],
      },
    }).authorized,
    true
  );
});

test("narrowly converges authoritative voice type and relation into one parent settlement", () => {
  const logicalQuestionUnit = unit(
    "Tell me about a time you persuaded a skeptical stakeholder"
  );
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit,
    sourceKind: "voice",
  });
  const typeSettlement = settleCurrentQuestion({
    operationId: "type-operation-a",
    currentQuestion,
    llmProposal: {
      source: "llm-type-repair",
      sessionId: currentQuestion.sessionId,
      runtimeEpoch: currentQuestion.runtimeEpoch,
      logicalQuestionUnitId: currentQuestion.logicalQuestionUnitId,
      revision: currentQuestion.revision,
      sourceHash: currentQuestion.sourceHash,
      questionType: "behavioral",
      relation: "unknown",
      action: "answer",
      confidence: 0.99,
      typeEvidenceAuthorized: true,
      relationEvidenceAuthorized: false,
      actionEvidenceAuthorized: true,
      expectedParentId: "parent-a",
      expectedParentRevision: 3,
    },
    activeParentId: "parent-a",
    activeParentRevision: 3,
    manualCorrectionRevision: 0,
    policy: {
      allowLlmTypeRepair: true,
      allowLlmRelationRepair: false,
      allowLlmActionRepair: false,
      llmTypeRepairMinConfidence: 0.95,
      runtimeMutationAuthorized: false,
      questionComplete: true,
      commitParent: false,
    },
  });
  const candidate = {
    schemaVersion: 2 as const,
    relation: "new-parent" as const,
    dependency: "parent-independent" as const,
    continuationShape: "unclear" as const,
    returnIntent: "no-resume" as const,
    switchIntent: "no-explicit-switch" as const,
    standaloneSufficiency: "sufficient" as const,
    confidence: 0.98,
    currentQuestionEvidenceSpans: ["persuaded a skeptical stakeholder"],
    parentEvidenceSpans: ["the previous coding task is unrelated"],
    explicitBinding: false,
    standalone: true,
  };

  const release = decideNarrowVoiceRelationRelease({
    sourceKind: "voice",
    activeParentQuestionType: "coding",
    typeSettlement,
    candidate,
    manualCorrectionActive: false,
    operationLeaseAuthorized: true,
    releaseWindowOpen: true,
  });
  assert.equal(release.authorized, true);

  const settlement = settleNarrowVoiceTypeRelation({
    operationId: "type-operation-a",
    currentQuestion,
    typeSettlement,
    relationCandidate: candidate,
    activeParentId: "parent-a",
    activeParentRevision: 3,
    manualCorrectionRevision: 0,
  });
  assert.ok(settlement);
  assert.equal(settlement.operationId, "type-operation-a");
  assert.equal(settlement.questionType, "behavioral");
  assert.equal(settlement.relation, "new-parent");
  assert.equal(settlement.typeMutationAuthorized, true);
  assert.equal(settlement.relationMutationAuthorized, true);
  assert.equal(settlement.parentMutationAuthorized, true);
});

test("narrow voice relation release fails closed for same-type or non-parent relation", () => {
  const logicalQuestionUnit = unit("Design a notification system");
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit,
    sourceKind: "voice",
  });
  const typeSettlement = settleCurrentQuestion({
    currentQuestion,
    llmProposal: {
      source: "llm-type-repair",
      sessionId: currentQuestion.sessionId,
      runtimeEpoch: currentQuestion.runtimeEpoch,
      logicalQuestionUnitId: currentQuestion.logicalQuestionUnitId,
      revision: currentQuestion.revision,
      sourceHash: currentQuestion.sourceHash,
      questionType: "general-system-design",
      relation: "unknown",
      action: "answer",
      confidence: 0.99,
      typeEvidenceAuthorized: true,
      relationEvidenceAuthorized: false,
      actionEvidenceAuthorized: true,
    },
    manualCorrectionRevision: 0,
    policy: {
      allowLlmTypeRepair: true,
      allowLlmRelationRepair: false,
      allowLlmActionRepair: false,
      runtimeMutationAuthorized: false,
      questionComplete: true,
      commitParent: false,
    },
  });
  const candidate = {
    schemaVersion: 2 as const,
    relation: "new-parent" as const,
    dependency: "parent-independent" as const,
    continuationShape: "unclear" as const,
    returnIntent: "no-resume" as const,
    switchIntent: "explicit-switch" as const,
    standaloneSufficiency: "sufficient" as const,
    confidence: 0.99,
    currentQuestionEvidenceSpans: ["Design a notification system"],
    parentEvidenceSpans: [],
    explicitBinding: false,
    standalone: true,
  };

  assert.equal(
    decideNarrowVoiceRelationRelease({
      sourceKind: "voice",
      activeParentQuestionType: "general-system-design",
      typeSettlement,
      candidate,
      manualCorrectionActive: false,
      operationLeaseAuthorized: true,
      releaseWindowOpen: true,
    }).reason,
    "current-type-matches-parent"
  );
  assert.equal(
    decideNarrowVoiceRelationRelease({
      sourceKind: "voice",
      activeParentQuestionType: "coding",
      typeSettlement,
      candidate: { ...candidate, relation: "followup-parent" },
      manualCorrectionActive: false,
      operationLeaseAuthorized: true,
      releaseWindowOpen: true,
    }).reason,
    "candidate-relation-not-new-parent"
  );
});

test("narrowly releases a grounded same-type manual screen milestone", () => {
  const decision = decideNarrowScreenRelationRelease({
    sourceKind: "screen",
    screenBoundaryPrior: true,
    currentQuestionType: "coding",
    activeParentQuestionType: "coding",
    typeAuthoritySource: "screen-preflight",
    typeEvidenceAuthorized: true,
    typeConfidence: 0.99,
    questionComplete: true,
    manualCorrectionActive: false,
    hasActiveChild: false,
    operationLeaseAuthorized: true,
    releaseWindowOpen: true,
    candidate: {
      schemaVersion: 2,
      relation: "new-parent",
      dependency: "parent-independent",
      continuationShape: "unclear",
      returnIntent: "no-resume",
      switchIntent: "explicit-switch",
      standaloneSufficiency: "sufficient",
      confidence: 0.97,
      currentQuestionEvidenceSpans: ["Implement an LRU cache"],
      parentEvidenceSpans: [],
      explicitBinding: false,
      standalone: true,
    },
  });

  assert.equal(decision.authorized, true);
  assert.equal(decision.reason, "authorized");
  assert.equal(decision.releasedRelation, "new-parent");
});

test("narrowly releases a grounded same-parent screen follow-up", () => {
  const candidate = {
    schemaVersion: 2 as const,
    relation: "followup-parent" as const,
    dependency: "parent-dependent" as const,
    continuationShape: "mainline" as const,
    returnIntent: "no-resume" as const,
    switchIntent: "no-explicit-switch" as const,
    standaloneSufficiency: "insufficient" as const,
    confidence: 0.98,
    currentQuestionEvidenceSpans: ["Explain lines 35 through 38"],
    parentEvidenceSpans: ["Implement an LRU cache"],
    explicitBinding: false,
    standalone: false,
  };
  const common = {
    sourceKind: "screen" as const,
    screenBoundaryPrior: true,
    currentQuestionType: "coding",
    activeParentQuestionType: "coding",
    typeAuthoritySource: "screen-preflight",
    typeEvidenceAuthorized: true,
    typeConfidence: 0.99,
    questionComplete: true,
    manualCorrectionActive: false,
    hasActiveChild: false,
    operationLeaseAuthorized: true,
    releaseWindowOpen: true,
    candidate,
  };

  const decision = decideNarrowScreenRelationRelease(common);
  assert.equal(decision.authorized, true);
  assert.equal(decision.reason, "authorized");
  assert.equal(decision.releasedRelation, "followup-parent");

  for (const legacyFacetVariant of [
    { ...candidate, continuationShape: "bounded-detour" as const },
    { ...candidate, switchIntent: "explicit-switch" as const },
    {
      ...candidate,
      standaloneSufficiency: "sufficient" as const,
      standalone: true,
    },
  ]) {
    assert.equal(
      decideNarrowScreenRelationRelease({
        ...common,
        candidate: legacyFacetVariant,
      }).authorized,
      true
    );
  }
  assert.equal(
    decideNarrowScreenRelationRelease({
      ...common,
      candidate: { ...candidate, parentEvidenceSpans: [] },
    }).reason,
    "candidate-followup-parent-evidence-missing"
  );
  assert.equal(
    decideNarrowScreenRelationRelease({
      ...common,
      currentQuestionType: "behavioral",
    }).reason,
    "candidate-followup-parent-evidence-missing"
  );
});

test("narrow screen relation release fails closed on continuity or stale evidence", () => {
  const candidate = {
    schemaVersion: 2 as const,
    relation: "new-parent" as const,
    dependency: "parent-independent" as const,
    continuationShape: "unclear" as const,
    returnIntent: "no-resume" as const,
    switchIntent: "explicit-switch" as const,
    standaloneSufficiency: "sufficient" as const,
    confidence: 0.99,
    currentQuestionEvidenceSpans: ["Design a notification system"],
    parentEvidenceSpans: [],
    explicitBinding: false,
    standalone: true,
  };
  const common = {
    sourceKind: "screen" as const,
    screenBoundaryPrior: true,
    currentQuestionType: "general-system-design",
    activeParentQuestionType: "coding",
    typeAuthoritySource: "screen-preflight",
    typeEvidenceAuthorized: true,
    typeConfidence: 0.99,
    questionComplete: true,
    manualCorrectionActive: false,
    hasActiveChild: false,
    operationLeaseAuthorized: true,
    releaseWindowOpen: true,
    candidate,
  };

  assert.equal(
    decideNarrowScreenRelationRelease({
      ...common,
      hasActiveChild: true,
    }).reason,
    "active-child-conflict"
  );
  assert.equal(
    decideNarrowScreenRelationRelease({
      ...common,
      operationLeaseAuthorized: false,
    }).reason,
    "operation-lease-not-authorized"
  );
  assert.equal(
    decideNarrowScreenRelationRelease({
      ...common,
      releaseWindowOpen: false,
    }).reason,
    "release-window-closed"
  );
  assert.equal(
    decideNarrowScreenRelationRelease({
      ...common,
      candidate: {
        ...candidate,
        relation: "child-probe",
        parentEvidenceSpans: ["coding parent"],
      },
    }).reason,
    "candidate-relation-not-new-parent"
  );
  assert.equal(
    decideNarrowScreenRelationRelease({
      ...common,
      typeAuthoritySource: "screen-source-fallback",
    }).reason,
    "screen-type-source-not-authoritative"
  );
});

test("compares deterministic and Shadow relations without granting authority", () => {
  assert.deepEqual(
    compareTaskRelationAdjudication({
      deterministicRelation: "child-probe",
      candidateRelation: "child-probe",
    }),
    {
      eligible: true,
      outcome: "agreement",
      agreement: true,
      disagreement: false,
    }
  );
  assert.deepEqual(
    compareTaskRelationAdjudication({
      deterministicRelation: "new-parent",
      candidateRelation: "followup-parent",
    }),
    {
      eligible: true,
      outcome: "disagreement",
      agreement: false,
      disagreement: true,
    }
  );
  assert.deepEqual(
    compareTaskRelationAdjudication({
      deterministicRelation: "resume-parent",
    }),
    {
      eligible: true,
      outcome: "candidate-unavailable",
    }
  );
  assert.deepEqual(
    compareTaskRelationAdjudication({
      candidateRelation: "new-parent",
    }),
    {
      eligible: false,
      outcome: "not-applicable",
    }
  );
});

test("Task 144 accepts relation evidence for preview while parent mutation remains blocked", () => {
  const logicalQuestionUnit = unit(
    "How would this retrieval design handle fresh documents?"
  );
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit,
    sourceKind: "voice",
  });
  const llmProposal = createTaskRelationSettlementProposal({
    currentQuestion,
    adjudication: {
      schemaVersion: 2,
      relation: "followup-parent",
      dependency: "parent-dependent",
      continuationShape: "mainline",
      returnIntent: "no-resume",
      switchIntent: "no-explicit-switch",
      standaloneSufficiency: "insufficient",
      confidence: 0.95,
      currentQuestionEvidenceSpans: ["fresh documents"],
      parentEvidenceSpans: ["RAG system"],
      explicitBinding: false,
      standalone: false,
    },
    expectedParentId: "parent-a",
    expectedParentRevision: 3,
  });
  const preview = settleCurrentQuestion({
    currentQuestion,
    llmProposal,
    activeParentId: "parent-a",
    activeParentRevision: 3,
    manualCorrectionRevision: 0,
    policy: {
      allowLlmTypeRepair: false,
      allowLlmRelationRepair: true,
      allowLlmActionRepair: false,
      runtimeMutationAuthorized: false,
      questionComplete: true,
      commitParent: false,
    },
  });

  assert.equal(preview.questionType, "unknown");
  assert.equal(preview.relation, "followup-parent");
  assert.equal(
    preview.relationAuthoritySource,
    "llm-type-repair"
  );
  assert.equal(preview.relationMutationAuthorized, true);
  assert.equal(preview.parentMutationAuthorized, false);
  assert.equal(preview.responseAuthorized, true);
});

test("one settlement composes authoritative screen type with released LLM relation", () => {
  const logicalQuestionUnit = unit(
    "Tell me about a time you persuaded a skeptical stakeholder"
  );
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit,
    sourceKind: "screen",
    sourceObservationIds: ["observation-behavioral"],
  });
  const deterministicProposal = {
    source: "deterministic-fast-path" as const,
    sessionId: currentQuestion.sessionId,
    runtimeEpoch: currentQuestion.runtimeEpoch,
    logicalQuestionUnitId: currentQuestion.logicalQuestionUnitId,
    revision: currentQuestion.revision,
    sourceHash: currentQuestion.sourceHash,
    questionType: "behavioral",
    relation: "unknown" as const,
    action: "answer" as const,
    confidence: 0.99,
    typeEvidenceAuthorized: true,
    relationEvidenceAuthorized: false,
    actionEvidenceAuthorized: true,
    expectedParentId: "parent-a",
    expectedParentRevision: 3,
  };
  const llmProposal = createTaskRelationSettlementProposal({
    currentQuestion,
    adjudication: {
      schemaVersion: 2,
      relation: "new-parent",
      dependency: "parent-independent",
      continuationShape: "unclear",
      returnIntent: "no-resume",
      switchIntent: "no-explicit-switch",
      standaloneSufficiency: "sufficient",
      confidence: 0.98,
      currentQuestionEvidenceSpans: ["persuaded a skeptical stakeholder"],
      parentEvidenceSpans: [],
      explicitBinding: false,
      standalone: true,
    },
    expectedParentId: "parent-a",
    expectedParentRevision: 3,
  });

  const settlement = settleCurrentQuestion({
    currentQuestion,
    deterministicProposal,
    llmProposal,
    activeParentId: "parent-a",
    activeParentRevision: 3,
    manualCorrectionRevision: 0,
    policy: {
      allowLlmTypeRepair: false,
      allowLlmRelationRepair: true,
      allowLlmActionRepair: false,
      llmRelationRepairMinConfidence: 0.95,
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: true,
    },
  });

  assert.equal(settlement.questionType, "behavioral");
  assert.equal(settlement.typeAuthoritySource, "deterministic-fast-path");
  assert.equal(settlement.relation, "new-parent");
  assert.equal(settlement.relationAuthoritySource, "llm-type-repair");
  assert.equal(settlement.parentMutationAuthorized, true);
});
