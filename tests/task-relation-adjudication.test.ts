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
  createTaskRelationSettlementProposal,
  decideTaskRelationAdjudicationEligibility,
  parseTaskRelationAdjudicationOutput,
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
  assert.match(prompts.systemPrompt, /Classify only the relationship/i);
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
  const valid = {
    schemaVersion: 1,
    relation: "followup-parent",
    confidence: 0.93,
    currentQuestionEvidenceSpans: ["fresh documents"],
    parentEvidenceSpans: ["RAG system for trip planning"],
    explicitBinding: true,
    standalone: false,
  };

  assert.equal(
    parseTaskRelationAdjudicationOutput(
      JSON.stringify(valid),
      request
    ).ok,
    true
  );
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

test("requires standalone new parents and grounded parent evidence for continuations", () => {
  const request = buildTaskRelationAdjudicationRequest({
    logicalQuestionUnit: unit(
      "Now design an unrelated notification service."
    ),
    activeMeetingTask: activeTask(),
  });
  const base = {
    schemaVersion: 1,
    confidence: 0.9,
    currentQuestionEvidenceSpans: ["notification service"],
    parentEvidenceSpans: [] as string[],
    explicitBinding: false,
    standalone: false,
  };

  assert.equal(
    parseTaskRelationAdjudicationOutput(
      JSON.stringify({ ...base, relation: "new-parent" }),
      request
    ).ok,
    false
  );
  assert.equal(
    parseTaskRelationAdjudicationOutput(
      JSON.stringify({
        ...base,
        relation: "new-parent",
        standalone: true,
      }),
      request
    ).ok,
    true
  );
  assert.equal(
    parseTaskRelationAdjudicationOutput(
      JSON.stringify({
        ...base,
        relation: "child-probe",
      }),
      request
    ).ok,
    false
  );
});

test("resume requires an active child and explicit binding", () => {
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
  const output = {
    schemaVersion: 1,
    relation: "resume-parent",
    confidence: 0.97,
    currentQuestionEvidenceSpans: ["return to the original architecture"],
    parentEvidenceSpans: ["RAG system for trip planning"],
    explicitBinding: true,
    standalone: false,
  };

  assert.equal(
    parseTaskRelationAdjudicationOutput(
      JSON.stringify(output),
      withoutChild
    ).ok,
    false
  );
  assert.equal(
    parseTaskRelationAdjudicationOutput(
      JSON.stringify(output),
      withChild
    ).ok,
    true
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
      evaluationActive: true,
      deterministicRelationAuthorized: true,
    }).reason,
    "deterministic-relation-authoritative"
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
      schemaVersion: 1,
      relation: "followup-parent",
      confidence: 0.95,
      currentQuestionEvidenceSpans: ["fresh documents"],
      parentEvidenceSpans: ["RAG system"],
      explicitBinding: true,
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
