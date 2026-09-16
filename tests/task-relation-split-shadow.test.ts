import type { ActiveMeetingTask } from "../src/lib/meeting/meeting-task-contracts.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { buildTaskRelationAdjudicationRequest } from "../src/lib/meeting/task-relation-adjudication.js";
import {
  authorizeTaskRelationSplitLease,
  authorizeTaskRelationSplitIdentity,
  authorizeTaskRelationCanonicalPredecessors,
  buildTaskRelationAffinityPrompts,
  buildTaskRelationAffinityRequests,
  buildTaskRelationCanonicalShadowPrompts,
  buildTaskRelationCanonicalShadowRequest,
  compareTaskRelationSplitShadow,
  createTaskRelationOperationIdentity,
  createAblatedCanonicalRelationRequest,
  createShuffledCanonicalRelationRequest,
  createTaskRelationSplitLease,
  decideFirstBatchRelationRelease,
  decideOrderedTaskRelationResolution,
  filterTaskRelationAffinityOutcomeAtCutoff,
  hashTaskRelationSplitOutput,
  parseTaskRelationAffinityOutput,
  parseTaskRelationCanonicalShadowOutput,
  projectTaskRelationOperationCurrentIdentity,
  revalidateTaskRelationAffinityOutcome,
} from "../src/lib/meeting/task-relation-split-shadow.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";

const meetingHookSource = await readFile(
  path.join(process.cwd(), "src/hooks/useMeetingAssistant.ts"),
  "utf8"
);

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

test("keeps the operation source immutable while reading current topology", () => {
  const logicalQuestionUnit = unit("Explain the highlighted code.");
  const currentQuestion = {
    logicalQuestionUnitId: logicalQuestionUnit.id,
    revision: logicalQuestionUnit.revision,
    sessionId: logicalQuestionUnit.sessionId,
    runtimeEpoch: logicalQuestionUnit.runtimeEpoch,
    normalizedText: logicalQuestionUnit.normalizedText,
    sourceTurnIds: [...logicalQuestionUnit.sourceTurnIds],
    sourceObservationIds: ["screen-current"],
    sourceKind: "screen" as const,
    sourceHash: "screen-source-hash",
    createdAt: logicalQuestionUnit.startedAt,
    updatedAt: logicalQuestionUnit.updatedAt,
  };
  const scheduled = createTaskRelationOperationIdentity({
    currentQuestion,
    activeParent: { id: "parent-rag", revisions: 3 },
    activeChild: { id: "child-code" },
    manualCorrectionRevision: 4,
  });
  const current = projectTaskRelationOperationCurrentIdentity({
    scheduled,
    sessionId: "session-a",
    runtimeEpoch: 4,
    activeParent: { id: "parent-rag", revisions: 3 },
    activeChild: { id: "child-code" },
    manualCorrectionRevision: 4,
  });

  assert.equal(current.logicalQuestionUnitId, logicalQuestionUnit.id);
  assert.equal(current.sourceHash, "screen-source-hash");
  assert.equal(current.sourceSettlementId, scheduled.sourceSettlementId);
  assert.deepEqual(
    authorizeTaskRelationSplitIdentity({ scheduled, current }),
    { authorized: true, reason: "identity-current" }
  );
});

test("invalidates an operation only when its runtime or topology expectation changes", () => {
  const logicalQuestionUnit = unit("Explain the highlighted code.");
  const scheduled = createTaskRelationOperationIdentity({
    currentQuestion: {
      logicalQuestionUnitId: logicalQuestionUnit.id,
      revision: logicalQuestionUnit.revision,
      sessionId: logicalQuestionUnit.sessionId,
      runtimeEpoch: logicalQuestionUnit.runtimeEpoch,
      normalizedText: logicalQuestionUnit.normalizedText,
      sourceTurnIds: [...logicalQuestionUnit.sourceTurnIds],
      sourceObservationIds: [],
      sourceKind: "voice",
      sourceHash: "voice-source-hash",
      createdAt: logicalQuestionUnit.startedAt,
      updatedAt: logicalQuestionUnit.updatedAt,
    },
    manualCorrectionRevision: 4,
  });
  const current = projectTaskRelationOperationCurrentIdentity({
    scheduled,
    sessionId: "session-a",
    runtimeEpoch: 4,
    activeParent: { id: "parent-created-by-correction", revisions: 1 },
    manualCorrectionRevision: 5,
  });

  assert.deepEqual(
    authorizeTaskRelationSplitIdentity({ scheduled, current }),
    {
      authorized: false,
      reason: "identity-mismatch",
      mismatchedKey: "parentId",
    }
  );
});

function request(
  text = "Back to the RAG system, how should we monitor freshness?"
) {
  return buildTaskRelationAdjudicationRequest({
    logicalQuestionUnit: unit(text),
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
  assert.match(childPrompt.systemPrompt, /at most 180 characters/i);
  assert.match(parentPrompt.systemPrompt, /shorter identifying clause/i);
  assert.match(childPrompt.systemPrompt, /"d":"r\|n\|u"/i);
  assert.match(parentPrompt.systemPrompt, /"d":"r\|i\|u"/i);
});

test("shares bounded screen focus evidence across relation prompts without changing source identity", () => {
  const baseline = buildTaskRelationAdjudicationRequest({
    logicalQuestionUnit: unit("Implement LRU cache"),
    activeMeetingTask: task(),
  });
  const base = buildTaskRelationAdjudicationRequest({
    logicalQuestionUnit: unit("Implement LRU cache"),
    activeMeetingTask: task(),
    currentQuestionEvidenceTexts: [
      "LRUCache.put method lines 40-45 updating existing key in cache",
    ],
  });
  const split = buildTaskRelationAffinityRequests({
    request: base,
    sessionId: "session-a",
    runtimeEpoch: 4,
    manualCorrectionRevision: 2,
  });
  const parentPrompt = buildTaskRelationAffinityPrompts(split.parent);
  const canonical = buildTaskRelationCanonicalShadowRequest({
    request: base,
    sessionId: "session-a",
    runtimeEpoch: 4,
    manualCorrectionRevision: 2,
  });
  const canonicalPrompt = buildTaskRelationCanonicalShadowPrompts(canonical);

  assert.match(parentPrompt.userMessage, /LRUCache\.put method lines 40-45/);
  assert.match(canonicalPrompt.userMessage, /LRUCache\.put method lines 40-45/);
  assert.equal(base.currentQuestion.text.includes("LRUCache.put"), false);
  assert.equal(base.sourceHash, baseline.sourceHash);
});

test("wires committed screen focus evidence into the relation scheduler", () => {
  assert.match(
    meetingHookSource,
    /currentQuestionEvidenceTexts:\s*screenSourcePacket\.visualEvidence\s*\.focusedEvidenceSummary/
  );
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
      v: 1,
      d: "n",
      c: 0.94,
      q: "Back to the RAG system",
      b: null,
    }),
    split.child
  );
  const parent = parseTaskRelationAffinityOutput(
    JSON.stringify({
      v: 1,
      d: "r",
      c: 0.97,
      q: "monitor freshness",
      b: "Documents change continuously",
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

test("treats an omitted affinity as an unknown snapshot, not a stale predecessor", () => {
  const canonical = buildTaskRelationCanonicalShadowRequest({
    request: request(),
    sessionId: "session-a",
    runtimeEpoch: 4,
    manualCorrectionRevision: 2,
    parent: {
      operationId: "parent-op",
      outputHash: "parent-hash",
      adjudication: affinity("parent", "related", 0.99),
    },
  });

  const authorized = authorizeTaskRelationCanonicalPredecessors({
    request: canonical,
    currentChildOperationId: "child-still-running",
    currentParentOperationId: "parent-op",
    currentParentOutputHash: "parent-hash",
  });
  assert.equal(authorized.authorized, true);

  const staleParent = authorizeTaskRelationCanonicalPredecessors({
    request: canonical,
    currentParentOperationId: "different-parent-op",
    currentParentOutputHash: "parent-hash",
  });
  assert.equal(staleParent.authorized, false);
  assert.equal(staleParent.reason, "parent-predecessor-operation-mismatch");
});

test("omits child affinity when topology has no active child", () => {
  const parentOnlyTask = task();
  delete parentOnlyTask.child;
  const base = buildTaskRelationAdjudicationRequest({
    logicalQuestionUnit: unit("How should we monitor RAG freshness?"),
    activeMeetingTask: parentOnlyTask,
    recentTurns: [],
  });
  const canonical = buildTaskRelationCanonicalShadowRequest({
    request: base,
    sessionId: "session-a",
    runtimeEpoch: 4,
    manualCorrectionRevision: 0,
    parent: { unavailableReason: "timed-out" },
  });
  assert.equal("child" in canonical.semanticPayload.affinity, false);
  assert.equal(canonical.semanticPayload.affinity.parent.status, "unknown");
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
    child: { status: "unknown" },
    parent: { status: "unknown" },
  });
  assert.notEqual(ablated.semanticPayloadDigest, base.semanticPayloadDigest);
  assert.notEqual(shuffled.semanticPayloadDigest, base.semanticPayloadDigest);
  const ablatedPrompt = buildTaskRelationCanonicalShadowPrompts(ablated);
  assert.match(ablatedPrompt.userMessage, /"status":"unknown"/);
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
    }).relation,
    "new-parent"
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
      activeParentQuestionType: "general-system-design",
      hasActiveChild: false,
      parentAffinity: parentIndependent,
    }).relation,
    "new-parent"
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
    }).relation,
    "new-parent"
  );
  const blockedLongParent = decideFirstBatchRelationRelease({
    currentQuestionType: "field-knowledge",
    activeParentQuestionType: "general-system-design",
    hasActiveChild: false,
    parentAffinity: parentIndependent,
  });
  assert.equal(blockedLongParent.authorized, false);
  assert.equal("responseOnly" in blockedLongParent, false);
  assert.equal(
    blockedLongParent.reason,
    "field-parent-capability-conflict"
  );
  for (const activeParentQuestionType of [
    "general-system-design",
    "ai-ml-system-design",
    "project-deep-dive",
  ] as const) {
    const blocked = decideFirstBatchRelationRelease({
      currentQuestionType: "field-knowledge",
      activeParentQuestionType,
      hasActiveChild: false,
      parentAffinity: parentIndependent,
    });
    assert.equal(blocked.authorized, false);
    assert.equal("responseOnly" in blocked, false);
  }
});

test("releases active-child continuation and parent resume without a new relation", () => {
  const released = decideFirstBatchRelationRelease({
    currentQuestionType: "ai-ml-system-design",
    activeParentQuestionType: "ai-ml-system-design",
    activeChildQuestionType: "field-knowledge",
    hasActiveChild: true,
    childAffinity: affinity("child", "unrelated", 0.97),
    parentAffinity: affinity("parent", "related", 0.98),
  });
  const childFollowup = decideFirstBatchRelationRelease({
    currentQuestionType: "field-knowledge",
    activeParentQuestionType: "ai-ml-system-design",
    activeChildQuestionType: "field-knowledge",
    hasActiveChild: true,
    childAffinity: affinity("child", "related", 0.99),
    parentAffinity: affinity("parent", "related", 0.99),
  });

  assert.equal(released.relation, "resume-parent");
  assert.equal(released.authorized, true);
  assert.equal(childFollowup.authorized, true);
  assert.equal(childFollowup.relation, "child-probe");
  assert.equal(
    childFollowup.reason,
    "active-child-preserve-child"
  );
});

test("active-child harness reaches child continuation and parent resume contracts", () => {
  const childFollowupRequest = request(
    "Within HNSW, how does efSearch affect recall?"
  );
  const childFollowupSplit = buildTaskRelationAffinityRequests({
    request: childFollowupRequest,
    sessionId: "session-a",
    runtimeEpoch: 4,
    manualCorrectionRevision: 2,
  });
  assert.equal(childFollowupSplit.child?.identity.childId, "child-hnsw");
  const childRelated = parseTaskRelationAffinityOutput(
    JSON.stringify({
      schemaVersion: 1,
      decision: "related",
      confidence: 0.99,
      currentEvidenceSpans: ["efSearch"],
      childEvidenceSpans: ["Explain HNSW and efSearch."],
    }),
    childFollowupSplit.child!
  );
  assert.equal(childRelated.ok ? childRelated.value.decision : undefined, "related");

  const resumeRequest = request();
  const resumeSplit = buildTaskRelationAffinityRequests({
    request: resumeRequest,
    sessionId: "session-a",
    runtimeEpoch: 4,
    manualCorrectionRevision: 2,
  });
  const childUnrelated = parseTaskRelationAffinityOutput(
    JSON.stringify({
      schemaVersion: 1,
      decision: "unrelated",
      confidence: 0.98,
      currentEvidenceSpans: ["Back to the RAG system"],
      childEvidenceSpans: [],
    }),
    resumeSplit.child!
  );
  const parentRelated = parseTaskRelationAffinityOutput(
    JSON.stringify({
      schemaVersion: 1,
      decision: "related",
      confidence: 0.99,
      currentEvidenceSpans: ["monitor freshness"],
      parentEvidenceSpans: ["Documents change continuously"],
    }),
    resumeSplit.parent
  );
  const released = decideFirstBatchRelationRelease({
    currentQuestionType: "ai-ml-system-design",
    activeParentQuestionType: "ai-ml-system-design",
    hasActiveChild: true,
    childAffinity: childUnrelated.ok ? childUnrelated.value : undefined,
    parentAffinity: parentRelated.ok ? parentRelated.value : undefined,
  });

  assert.equal(released.authorized, true);
  assert.equal(released.relation, "resume-parent");
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
  assert.equal(sameTypeIndependent.authorized, true);
  assert.equal(sameTypeIndependent.relation, "new-parent");
  assert.equal(
    sameTypeIndependent.reason,
    "same-type-independent-new-parent"
  );
});

test("ordered relation resolution prefers matrix, then canonical, then source null hypothesis", () => {
  const matrix = decideOrderedTaskRelationResolution({
    sourceKind: "voice",
    currentQuestionType: "coding",
    activeParentQuestionType: "behavioral",
    hasActiveChild: false,
    parentAffinity: affinity("parent", "independent", 0.99),
  });
  assert.equal(matrix.stage, "runtime-matrix");
  assert.equal(matrix.relation, "new-parent");

  const canonical = decideOrderedTaskRelationResolution({
    sourceKind: "voice",
    currentQuestionType: "coding",
    activeParentQuestionType: "behavioral",
    hasActiveChild: false,
    parentAffinity: affinity("parent", "unclear", 0.99),
    canonical: {
      schemaVersion: 3,
      relation: "new-parent",
      confidence: 0.98,
      currentQuestionEvidenceSpans: ["Solve an LRU cache"],
      parentEvidenceSpans: [],
    },
  });
  assert.equal(canonical.stage, "canonical-relation");
  assert.equal(canonical.relation, "new-parent");

  const unresolved = decideOrderedTaskRelationResolution({
    sourceKind: "voice",
    currentQuestionType: "coding",
    activeParentQuestionType: "coding",
    hasActiveChild: false,
  });
  assert.equal(unresolved.status, "unresolved");

  const preserved = decideOrderedTaskRelationResolution({
    sourceKind: "voice",
    currentQuestionType: "coding",
    activeParentQuestionType: "coding",
    hasActiveChild: false,
    finalizeWithNullHypothesis: true,
  });
  assert.equal(preserved.stage, "source-topology-null-hypothesis");
  assert.equal(preserved.relation, "followup-parent");
});

test("defers same-type independent new-parent until Canonical or final fallback", () => {
  const base = {
    sourceKind: "voice" as const,
    currentQuestionType: "coding",
    activeParentQuestionType: "coding",
    hasActiveChild: false,
    parentAffinity: affinity("parent", "independent", 0.99),
  };

  const pending = decideOrderedTaskRelationResolution(base);
  assert.equal(pending.status, "unresolved");
  assert.equal(pending.reason, "canonical-missing");

  const canonical = decideOrderedTaskRelationResolution({
    ...base,
    canonical: {
      schemaVersion: 3,
      relation: "followup-parent",
      confidence: 0.98,
      currentQuestionEvidenceSpans: ["What edge cases should we test?"],
      parentEvidenceSpans: ["Implement an LRU cache"],
    },
  });
  assert.equal(canonical.stage, "canonical-relation");
  assert.equal(canonical.relation, "followup-parent");

  const fallback = decideOrderedTaskRelationResolution({
    ...base,
    finalizeWithNullHypothesis: true,
  });
  assert.equal(fallback.stage, "runtime-matrix");
  assert.equal(fallback.relation, "new-parent");
  assert.equal(fallback.reason, "same-type-independent-new-parent");
});

test("normalizes unresolved-like provider outcomes to the active-owner null hypothesis", () => {
  for (const fault of [
    "timeout",
    "invalid-output",
    "cancelled-provider-work",
    "stale-provider-result",
    "hook-provider-error",
  ]) {
    const decision = decideOrderedTaskRelationResolution({
      sourceKind: "voice",
      currentQuestionType: "coding",
      activeParentQuestionType: "general-system-design",
      hasActiveChild: false,
      canonical:
        fault === "invalid-output"
          ? {
              schemaVersion: 3,
              relation: "unknown",
              confidence: 0,
              currentQuestionEvidenceSpans: [],
              parentEvidenceSpans: [],
              ambiguityReason: fault,
            }
          : undefined,
      finalizeWithNullHypothesis: true,
    });

    assert.equal(decision.status, "resolved", fault);
    assert.equal(decision.stage, "runtime-matrix", fault);
    assert.equal(decision.relation, undefined, fault);
  }
});

test("wires provider faults to finalization while stale source ownership fails closed", () => {
  const resolverStart = meetingHookSource.indexOf(
    "const resolveOrderedTaskRelationWithinWindow"
  );
  const resolverEnd = meetingHookSource.indexOf(
    "const scheduleSemanticTaxonomyShadow",
    resolverStart
  );
  assert.ok(resolverStart >= 0);
  assert.ok(resolverEnd > resolverStart);
  const resolver = meetingHookSource.slice(resolverStart, resolverEnd);

  assert.match(resolver, /affinity-cutoff-expired/);
  assert.match(resolver, /freezeAffinityOutcome/);
  assert.match(resolver, /revalidateAffinityOutcome/);
  assert.match(resolver, /canonical-unresolved/);
  assert.match(resolver, /canonical-deadline-expired/);
  assert.match(resolver, /canonical-skipped-no-budget/);
  assert.match(resolver, /createOrderedRelationPhaseBudget/);
  assert.match(resolver, /finalizeWithNullHypothesis:\s*true/);
  assert.match(resolver, /cancelForegroundWork\?\.\(\)/);
  assert.match(meetingHookSource, /deadlineFinalizationRequested = true/);
  assert.match(meetingHookSource, /const relationResolution = startRelationResolution\(\)/);
  assert.match(meetingHookSource, /void relationResolution\?\.then/);
  assert.match(meetingHookSource, /deadline:\s*foregroundDeadline/);
  assert.match(
    meetingHookSource,
    /readOrderedSettlementRemainingMs\(foregroundDeadline\)/
  );
  assert.match(meetingHookSource, /ordered-chain-internal-error/);
  assert.doesNotMatch(meetingHookSource, /ordered-chain-error-unresolved/);
  assert.match(
    meetingHookSource,
    /rejectStaleScreenOperation\("post-relation-settlement"\)/
  );
});

test("ordered relation null hypothesis treats authoritative unbound Screen as a milestone", () => {
  const screen = decideOrderedTaskRelationResolution({
    sourceKind: "screen",
    currentQuestionType: "behavioral",
    activeParentQuestionType: "coding",
    hasActiveChild: false,
    screenBoundaryPrior: true,
    screenTypeEvidenceAuthorized: true,
    finalizeWithNullHypothesis: true,
  });
  assert.equal(screen.relation, "new-parent");
  assert.equal(screen.reason, "type-excludes-existing-tree");

  const activeChild = decideOrderedTaskRelationResolution({
    sourceKind: "screen",
    currentQuestionType: "coding",
    activeParentQuestionType: "coding",
    activeChildQuestionType: "field-knowledge",
    hasActiveChild: true,
    screenBoundaryPrior: true,
    screenTypeEvidenceAuthorized: true,
    finalizeWithNullHypothesis: true,
  });
  assert.equal(activeChild.relation, undefined);
  assert.equal(activeChild.reason, "type-location-unresolved");
});

test("freezes only Affinity results that existed at the coordinator cutoff", () => {
  const requests = buildTaskRelationAffinityRequests({
    request: request(),
    sessionId: "session-a",
    runtimeEpoch: 4,
    manualCorrectionRevision: 0,
  });
  const outcome = filterTaskRelationAffinityOutcomeAtCutoff(
    {
      child: { unavailableReason: "no-active-child" },
      parent: {
        operationId: "parent-op",
        identity: requests.parent.identity,
        settledAt: 2_500,
        adjudication: affinity("parent", "related", 0.99),
      },
    },
    2_000
  );

  assert.equal(outcome.parent.adjudication, undefined);
  assert.equal(outcome.parent.unavailableReason, "affinity-settled-after-cutoff");
});

test("does not reauthorize an Affinity candidate after manual correction changes its lease", () => {
  const requests = buildTaskRelationAffinityRequests({
    request: request(),
    sessionId: "session-a",
    runtimeEpoch: 4,
    manualCorrectionRevision: 0,
  });
  const outcome = revalidateTaskRelationAffinityOutcome({
    outcome: {
      child: { unavailableReason: "no-active-child" },
      parent: {
        operationId: "parent-op",
        identity: requests.parent.identity,
        settledAt: 1_000,
        adjudication: affinity("parent", "independent", 0.99),
      },
    },
    readCurrentOperationId: () => "parent-op",
    readCurrentIdentity: (identity) => ({
      ...identity,
      manualCorrectionRevision: identity.manualCorrectionRevision + 1,
    }),
  });

  assert.equal(outcome.parent.adjudication, undefined);
  assert.equal(
    outcome.parent.unavailableReason,
    "affinity-manualCorrectionRevision-stale"
  );
});

test("treats the original Relation operation as stale after any identity change", () => {
  const requests = buildTaskRelationAffinityRequests({
    request: request(),
    sessionId: "session-a",
    runtimeEpoch: 4,
    manualCorrectionRevision: 0,
  });
  for (const [mismatchedKey, current] of [
    [
      "manualCorrectionRevision",
      {
        ...requests.parent.identity,
        manualCorrectionRevision: 1,
      },
    ],
    [
      "sourceHash",
      {
        ...requests.parent.identity,
        sourceHash: "source-corrected",
      },
    ],
    [
      "parentRevision",
      {
        ...requests.parent.identity,
        parentRevision: requests.parent.identity.parentRevision + 1,
      },
    ],
  ] as const) {
    const authorization = authorizeTaskRelationSplitIdentity({
      scheduled: requests.parent.identity,
      current,
    });
    assert.equal(authorization.authorized, false, mismatchedKey);
    assert.equal(authorization.mismatchedKey, mismatchedKey);
  }
  assert.deepEqual(
    authorizeTaskRelationSplitIdentity({
      scheduled: requests.parent.identity,
      current: { ...requests.parent.identity },
    }),
    { authorized: true, reason: "identity-current" }
  );
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
