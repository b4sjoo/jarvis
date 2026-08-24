import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import {
  buildTaskRelationAdjudicationRequest,
} from "../src/lib/meeting/task-relation-adjudication.js";
import {
  authorizeTaskRelationSplitLease,
  authorizeTaskRelationCanonicalPredecessors,
  buildTaskRelationAffinityPrompts,
  buildTaskRelationAffinityRequests,
  buildTaskRelationCanonicalShadowPrompts,
  buildTaskRelationCanonicalShadowRequest,
  compareTaskRelationSplitShadow,
  createAblatedCanonicalRelationRequest,
  createShuffledCanonicalRelationRequest,
  createTaskRelationSplitLease,
  decideFirstBatchRelationRelease,
  hashTaskRelationSplitOutput,
  parseTaskRelationAffinityOutput,
  parseTaskRelationCanonicalShadowOutput,
} from "../src/lib/meeting/task-relation-split-shadow.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";

function unit(text: string): LogicalQuestionUnit {
  return {
    id: "lqu-current",
    revision: 2,
    sessionId: "session-a",
    runtimeEpoch: 4,
    currentTurnId: "turn-current",
    sourceTurnIds: ["turn-current"],
    sources: [
      { turnId: "turn-current", text, startedAt: 50, endedAt: 60 },
    ],
    normalizedText: text,
    startedAt: 50,
    updatedAt: 60,
    compositionReasons: ["independent-current-turn"],
    boundaryReason: "independent-current-turn",
    truncated: false,
  };
}

function task(): ActiveMeetingTask {
  return {
    id: "parent-rag",
    runtimeRevision: 3,
    source: "voice",
    parent: {
      id: "parent-rag",
      questionType: "ai-ml-system-design",
      topic: "Design a production RAG system",
      playbookPhase: "architecture_decision",
      phaseProgress: {},
      supportedFactAnchors: [],
      canonicalQuestionSourceTurnIds: ["turn-parent"],
      startTurnId: "turn-parent",
      promptTranscriptStartTurnId: "turn-parent",
      parentContextHandoff: {
        sourceParentId: "parent-old",
        transitionKind: "domain-extension",
        sourceQuestionId: "question-old",
        sharedScenarioContext: {
          productIdentity: "RAG",
          domainEntities: ["documents"],
          sharedRequirements: ["Documents change continuously."],
        },
        excludedContextKinds: [],
      },
      createdAt: 1,
      updatedAt: 1,
      revisions: 3,
    },
    child: {
      id: "child-hnsw",
      createdAt: 20,
      updatedAt: 20,
      questionType: "field-knowledge",
      relation: "child-probe",
      intent: "concept-probe",
      question: "Explain HNSW and efSearch.",
      basedOnTurnIds: ["turn-child"],
      basedOnObservationIds: [],
    },
  };
}

function request() {
  return buildTaskRelationAdjudicationRequest({
    logicalQuestionUnit: unit(
      "Back to the RAG system, how should we monitor freshness?"
    ),
    activeMeetingTask: task(),
    recentTurns: [
      {
        id: "turn-parent",
        speaker: "them",
        text: "Design a production RAG system.",
        startedAt: 0,
        endedAt: 10,
        isFinal: true,
        source: "system-audio",
      },
      {
        id: "turn-constraint",
        speaker: "them",
        text: "Documents change continuously.",
        startedAt: 10,
        endedAt: 15,
        isFinal: true,
        source: "system-audio",
      },
      {
        id: "turn-child",
        speaker: "them",
        text: "Explain HNSW and efSearch.",
        startedAt: 20,
        endedAt: 30,
        isFinal: true,
        source: "system-audio",
      },
    ],
  });
}

test("builds clean child and parent affinity prompts", () => {
  const split = buildTaskRelationAffinityRequests({
    request: request(),
    sessionId: "session-a",
    runtimeEpoch: 4,
    manualCorrectionRevision: 2,
  });
  assert.ok(split.child);
  const childPrompt = buildTaskRelationAffinityPrompts(split.child);
  const parentPrompt = buildTaskRelationAffinityPrompts(split.parent);
  for (const prompt of [childPrompt, parentPrompt]) {
    assert.equal(prompt.userMessage.includes("parent-rag"), false);
    assert.equal(prompt.userMessage.includes("child-hnsw"), false);
    assert.equal(prompt.userMessage.includes("sourceHash"), false);
    assert.equal(prompt.userMessage.includes("logicalQuestionUnitId"), false);
  }
  assert.match(childPrompt.systemPrompt, /active child question/i);
  assert.match(parentPrompt.systemPrompt, /active parent objective/i);
});

test("parses grounded affinity decisions with operation-specific evidence", () => {
  const split = buildTaskRelationAffinityRequests({
    request: request(),
    sessionId: "session-a",
    runtimeEpoch: 4,
    manualCorrectionRevision: 2,
  });
  assert.ok(split.child);
  const child = parseTaskRelationAffinityOutput(
    JSON.stringify({
      schemaVersion: 1,
      decision: "unrelated",
      confidence: 0.94,
      currentEvidenceSpans: ["Back to the RAG system"],
      childEvidenceSpans: [],
    }),
    split.child
  );
  const parent = parseTaskRelationAffinityOutput(
    JSON.stringify({
      schemaVersion: 1,
      decision: "related",
      confidence: 0.97,
      currentEvidenceSpans: ["monitor freshness"],
      parentEvidenceSpans: ["Documents change continuously"],
    }),
    split.parent
  );
  assert.equal(child.ok ? child.value.decision : undefined, "unrelated");
  assert.equal(parent.ok ? parent.value.decision : undefined, "related");
});

test("feeds affinity semantics into canonical relation without lineage hashes", () => {
  const base = request();
  const split = buildTaskRelationAffinityRequests({
    request: base,
    sessionId: "session-a",
    runtimeEpoch: 4,
    manualCorrectionRevision: 2,
  });
  assert.ok(split.child);
  const childAdjudication = {
    schemaVersion: 1 as const,
    affinityKind: "child" as const,
    decision: "unrelated" as const,
    confidence: 0.94,
    currentEvidenceSpans: ["Back to the RAG system"],
    branchEvidenceSpans: [],
  };
  const parentAdjudication = {
    schemaVersion: 1 as const,
    affinityKind: "parent" as const,
    decision: "related" as const,
    confidence: 0.97,
    currentEvidenceSpans: ["monitor freshness"],
    branchEvidenceSpans: ["Documents change continuously"],
  };
  const canonical = buildTaskRelationCanonicalShadowRequest({
    request: base,
    sessionId: "session-a",
    runtimeEpoch: 4,
    manualCorrectionRevision: 2,
    child: {
      operationId: "child-operation",
      outputHash: hashTaskRelationSplitOutput(childAdjudication),
      adjudication: childAdjudication,
    },
    parent: {
      operationId: "parent-operation",
      outputHash: hashTaskRelationSplitOutput(parentAdjudication),
      adjudication: parentAdjudication,
    },
  });
  const prompts = buildTaskRelationCanonicalShadowPrompts(canonical);
  assert.match(prompts.userMessage, /"decision":"unrelated"/);
  assert.match(prompts.userMessage, /"decision":"related"/);
  assert.doesNotMatch(prompts.userMessage, /child-operation|parent-operation/);
  assert.doesNotMatch(prompts.userMessage, /outputHash|sourceHash/);

  const parsed = parseTaskRelationCanonicalShadowOutput(
    JSON.stringify({
      schemaVersion: 3,
      relation: "resume-parent",
      confidence: 0.97,
      currentQuestionEvidenceSpans: ["Back to the RAG system"],
      parentEvidenceSpans: ["Documents change continuously"],
    }),
    canonical
  );
  assert.equal(parsed.ok ? parsed.value.relation : undefined, "resume-parent");

  const lease = createTaskRelationSplitLease({ request: canonical });
  assert.deepEqual(
    authorizeTaskRelationSplitLease(lease, {
      currentOperationId: lease.operationId,
      operationKind: canonical.operationKind,
      identity: canonical.identity,
      semanticPayloadDigest: canonical.semanticPayloadDigest,
    }),
    { authorized: true, reason: "authorized" }
  );
  assert.deepEqual(
    authorizeTaskRelationCanonicalPredecessors({
      request: canonical,
      currentChildOperationId: "child-operation",
      currentChildOutputHash: canonical.childPredecessorOutputHash,
      currentParentOperationId: "parent-operation",
      currentParentOutputHash: canonical.parentPredecessorOutputHash,
    }),
    { authorized: true, reason: "authorized" }
  );
  assert.equal(
    authorizeTaskRelationCanonicalPredecessors({
      request: canonical,
      currentChildOperationId: "newer-child-operation",
      currentChildOutputHash: canonical.childPredecessorOutputHash,
      currentParentOperationId: "parent-operation",
      currentParentOutputHash: canonical.parentPredecessorOutputHash,
    }).authorized,
    false
  );
});

test("exposes ablation and shuffle as causal harness variants", () => {
  const base = buildTaskRelationCanonicalShadowRequest({
    request: request(),
    sessionId: "session-a",
    runtimeEpoch: 4,
    manualCorrectionRevision: 0,
    parent: {
      operationId: "parent-operation",
      outputHash: "parent-output",
      adjudication: {
        schemaVersion: 1,
        affinityKind: "parent",
        decision: "related",
        confidence: 0.95,
        currentEvidenceSpans: ["monitor freshness"],
        branchEvidenceSpans: ["Documents change continuously"],
      },
    },
  });
  const ablated = createAblatedCanonicalRelationRequest(base);
  const shuffled = createShuffledCanonicalRelationRequest(base, {
    child: { status: "unavailable" },
    parent: { status: "unavailable" },
  });
  assert.notEqual(ablated.semanticPayloadDigest, base.semanticPayloadDigest);
  assert.notEqual(shuffled.semanticPayloadDigest, base.semanticPayloadDigest);
  const ablatedPrompt = buildTaskRelationCanonicalShadowPrompts(ablated);
  assert.match(ablatedPrompt.userMessage, /"status":"unavailable"/);
  assert.doesNotMatch(
    ablatedPrompt.userMessage,
    /ablation|operation|mismatch|reason/
  );
  assert.deepEqual(
    compareTaskRelationSplitShadow({
      monolithicRelation: "new-parent",
      canonicalRelation: "resume-parent",
      ablatedRelation: "new-parent",
      shuffledRelation: "followup-parent",
    }),
    {
      canonicalAvailable: true,
      canonicalDelta: true,
      ablationDelta: true,
      shuffleSensitive: true,
    }
  );
});

test("releases only the approved no-parent and parent-without-child matrix", () => {
  const parentRelated = affinity("parent", "related", 0.97);
  const parentIndependent = affinity("parent", "independent", 0.98);

  assert.equal(
    decideFirstBatchRelationRelease({
      currentQuestionType: "coding",
      hasActiveChild: false,
    }).relation,
    "new-parent"
  );
  assert.equal(
    decideFirstBatchRelationRelease({
      currentQuestionType: "field-knowledge",
      hasActiveChild: false,
    }).responseOnly,
    true
  );
  assert.equal(
    decideFirstBatchRelationRelease({
      currentQuestionType: "general-system-design",
      activeParentQuestionType: "general-system-design",
      hasActiveChild: false,
      parentAffinity: parentRelated,
    }).relation,
    "followup-parent"
  );
  assert.equal(
    decideFirstBatchRelationRelease({
      currentQuestionType: "field-knowledge",
      activeParentQuestionType: "general-system-design",
      hasActiveChild: false,
      parentAffinity: parentRelated,
    }).relation,
    "child-probe"
  );
  assert.equal(
    decideFirstBatchRelationRelease({
      currentQuestionType: "coding",
      activeParentQuestionType: "behavioral",
      hasActiveChild: false,
      parentAffinity: parentIndependent,
    }).relation,
    "new-parent"
  );
  assert.equal(
    decideFirstBatchRelationRelease({
      currentQuestionType: "field-knowledge",
      activeParentQuestionType: "behavioral",
      hasActiveChild: false,
      parentAffinity: parentIndependent,
    }).responseOnly,
    true
  );
});

test("releases only resume-parent while an active child exists", () => {
  const released = decideFirstBatchRelationRelease({
    currentQuestionType: "ai-ml-system-design",
    activeParentQuestionType: "ai-ml-system-design",
    hasActiveChild: true,
    childAffinity: affinity("child", "unrelated", 0.97),
    parentAffinity: affinity("parent", "related", 0.98),
  });
  const childFollowup = decideFirstBatchRelationRelease({
    currentQuestionType: "field-knowledge",
    activeParentQuestionType: "ai-ml-system-design",
    hasActiveChild: true,
    childAffinity: affinity("child", "related", 0.99),
    parentAffinity: affinity("parent", "related", 0.99),
  });

  assert.equal(released.relation, "resume-parent");
  assert.equal(released.authorized, true);
  assert.equal(childFollowup.authorized, false);
  assert.equal(
    childFollowup.reason,
    "active-child-combination-not-released"
  );
});

test("keeps uncertain affinity in Shadow and flags only the review band", () => {
  const possibleError = decideFirstBatchRelationRelease({
    currentQuestionType: "coding",
    activeParentQuestionType: "behavioral",
    hasActiveChild: false,
    parentAffinity: affinity("parent", "independent", 0.92),
  });
  const lowConfidence = decideFirstBatchRelationRelease({
    currentQuestionType: "coding",
    activeParentQuestionType: "behavioral",
    hasActiveChild: false,
    parentAffinity: affinity("parent", "independent", 0.82),
  });
  const sameTypeIndependent = decideFirstBatchRelationRelease({
    currentQuestionType: "coding",
    activeParentQuestionType: "coding",
    hasActiveChild: false,
    parentAffinity: affinity("parent", "independent", 0.99),
  });

  assert.equal(possibleError.authorized, false);
  assert.equal(possibleError.possibleRelationError, true);
  assert.equal(lowConfidence.possibleRelationError, false);
  assert.equal(sameTypeIndependent.authorized, false);
  assert.equal(sameTypeIndependent.reason, "same-type-independent-shadow");
});

function affinity(
  kind: "child" | "parent",
  decision: "related" | "unrelated" | "independent" | "unclear",
  confidence: number
) {
  return {
    schemaVersion: 1 as const,
    affinityKind: kind,
    decision,
    confidence,
    currentEvidenceSpans: decision === "unclear" ? [] : ["current"],
    branchEvidenceSpans: decision === "related" ? ["branch"] : [],
  };
}
