import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import {
  createProvisionalCurrentQuestion,
  settleCurrentQuestion,
} from "../src/lib/meeting/current-question-settlement.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import {
  buildTaskRelationAdjudicationRequest,
  createTaskRelationSettlementProposal,
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
      canonicalQuestionSourceTurnIds: ["turn-parent"],
      startTurnId: "turn-parent",
      promptTranscriptStartTurnId: "turn-parent",
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

test("keeps raw recent interviewer context when no lexical role matches", () => {
  const request = buildTaskRelationAdjudicationRequest({
    logicalQuestionUnit: unit("How should we proceed from here?"),
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
        id: "turn-raw",
        speaker: "them",
        text: "The traffic tends to be bursty around holiday weekends.",
        startedAt: 30,
        endedAt: 40,
        isFinal: true,
        source: "system-audio",
      },
    ],
  });

  assert.equal(request.recentEvidenceDiagnostics.eligiblePriorTurnCount, 2);
  assert.equal(request.recentEvidenceDiagnostics.falseEmpty, false);
  assert.equal(request.recentEvidenceDiagnostics.rawFallbackCount, 1);
  assert.deepEqual(request.recentSourceEvidence.at(-1), {
    turnId: "turn-raw",
    text: "The traffic tends to be bursty around holiday weekends.",
    role: undefined,
    selectionReason: "raw-recent-turn",
    sourceScope: "parent-scope",
  });
  assert.deepEqual(request.recentTransitions, []);
});

test("uses the current source instead of issuing a context-free relation request", () => {
  const request = buildTaskRelationAdjudicationRequest({
    logicalQuestionUnit: unit("How should we proceed from here?"),
    activeMeetingTask: activeTask(),
    recentTurns: [],
  });

  assert.equal(request.recentSourceEvidence.length, 1);
  assert.equal(
    request.recentSourceEvidence[0]?.sourceScope,
    "current-source-fallback"
  );
  assert.equal(request.recentEvidenceDiagnostics.eligiblePriorTurnCount, 0);
  assert.equal(request.recentEvidenceDiagnostics.emptyReason, undefined);
  assert.equal(request.recentEvidenceDiagnostics.falseEmpty, false);
  assert.equal(
    request.recentEvidenceDiagnostics.currentSourceFallbackCount,
    1
  );
});

test("caps a missing-parent-boundary fallback to one prior interviewer turn", () => {
  const task = activeTask();
  task.parent.canonicalQuestionSourceTurnIds = ["missing-parent-turn"];
  task.parent.startTurnId = "missing-parent-turn";
  task.parent.promptTranscriptStartTurnId = "missing-parent-turn";
  const request = buildTaskRelationAdjudicationRequest({
    logicalQuestionUnit: unit("How should we proceed from here?"),
    activeMeetingTask: task,
    recentTurns: [
      {
        id: "old-turn",
        speaker: "them",
        text: "This belongs to an older task.",
        startedAt: 10,
        endedAt: 20,
        isFinal: true,
        source: "system-audio",
      },
      {
        id: "nearest-turn",
        speaker: "them",
        text: "Now consider the latest requirement.",
        startedAt: 30,
        endedAt: 40,
        isFinal: true,
        source: "system-audio",
      },
    ],
  });

  assert.equal(request.recentSourceEvidence.length, 1);
  assert.equal(request.recentSourceEvidence[0]?.turnId, "nearest-turn");
  assert.equal(
    request.recentSourceEvidence[0]?.sourceScope,
    "cross-boundary-prior-turn"
  );
  assert.equal(request.recentEvidenceDiagnostics.parentBoundaryFound, false);
  assert.equal(
    request.recentEvidenceDiagnostics.crossBoundarySelectedCount,
    1
  );
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
      allowRuntimeTypeAdjudication: false,
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
    "runtime-adjudication"
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
      allowRuntimeTypeAdjudication: false,
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
  assert.equal(settlement.relationAuthoritySource, "runtime-adjudication");
  assert.equal(settlement.parentMutationAuthorized, true);
});
