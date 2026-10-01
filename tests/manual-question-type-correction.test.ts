import type { ActiveMeetingTask } from "../src/lib/meeting/meeting-task-contracts.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createProvisionalCurrentQuestion } from "../src/lib/meeting/current-question-settlement.js";
import {
  applyManualQuestionTypeCorrectionToParent,
  buildBoundedParentContextHandoff,
  classifyManualCorrectionTarget,
  decideManualCorrectionTerminalState,
  decideManualQuestionTypeCorrection,
  decideProvisionalQuestionTypeCorrection,
  hasManualQuestionTypeCorrectionPresentationTarget,
  markManualCorrectionTargetResolved,
  resolveManualCorrectionTarget,
  selectManualCorrectionTargetFromHistory,
  upsertManualCorrectionTargetHistory,
  ManualCorrectionOperationCoordinator,
  type ManualQuestionTypeCorrectionDecision,
  type ManualCorrectionTargetHistoryEntry,
} from "../src/lib/meeting/manual-question-type-correction.js";
import {
  authorizeManualCorrectionLifecycle,
  settleManualQuestionTypeCorrection,
} from "../src/lib/meeting/manual-correction-settlement.js";
import type {
  ActiveInterviewChild,
  ActiveInterviewParent,
  SelectedInterviewPlaybook,
  WhiteboardArtifact,
  TranscriptTurn,
} from "../src/lib/meeting/types.js";
import type { CanonicalQuestionType } from "../src/lib/meeting/task-taxonomy.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import type { LlmTaskRelationAdjudication } from "../src/lib/meeting/task-relation-adjudication.js";

const now = 1_000;

test("settles manual type authority and relation authority in one correction transaction", () => {
  const unit = makeLogicalQuestion(
    "question-general-sd",
    "turn-general-sd",
    "Design a food delivery system."
  );
  const result = settleManualQuestionTypeCorrection({
    operationId: "correction-1",
    currentQuestion: createProvisionalCurrentQuestion({
      logicalQuestionUnit: unit,
      sourceKind: "voice",
    }),
    correctedType: "general-system-design",
    activeParentId: "parent-coding",
    activeParentRevision: 4,
    manualCorrectionRevision: 3,
    relationCandidate: relationCandidate({ relation: "new-parent" }),
    relationOperationLeaseAuthorized: true,
  });

  assert.equal(result.relationRelease?.authorized, true);
  assert.equal(
    result.relationRelease?.reason,
    "ordered-relation-authorized"
  );
  assert.equal(result.settlement.questionType, "general-system-design");
  assert.equal(result.settlement.relation, "new-parent");
  assert.equal(result.settlement.typeAuthoritySource, "manual-correction");
  assert.equal(result.settlement.relationAuthoritySource, "runtime-adjudication");
  assert.equal(result.settlement.parentMutationAuthorized, true);
});

test("reauthorizes correction-owned parent retypes without changing relation", () => {
  const unit = makeLogicalQuestion(
    "question-retype",
    "turn-retype",
    "Design a URL shortener."
  );
  const settled = settleManualQuestionTypeCorrection({
    operationId: "correction-retype",
    currentQuestion: createProvisionalCurrentQuestion({
      logicalQuestionUnit: unit,
      sourceKind: "voice",
    }),
    correctedType: "ai-ml-system-design",
    activeParentId: "parent-design",
    activeParentRevision: 2,
    manualCorrectionRevision: 1,
    revisionStableRelation: "new-parent",
  }).settlement;
  const projected = authorizeManualCorrectionLifecycle({
    settlement: { ...settled, parentMutationAuthorized: false },
    parentAction: "retype",
    activeParentId: "parent-design",
    activeParentType: "general-system-design",
  });

  assert.equal(projected.parentMutationAuthorized, true);
  assert.ok(
    projected.reasons.includes(
      "manual-correction-same-question-retype-authorized"
    )
  );

  const relatedFollowup = settleManualQuestionTypeCorrection({
    operationId: "correction-related-followup",
    currentQuestion: createProvisionalCurrentQuestion({
      logicalQuestionUnit: makeLogicalQuestion(
        "question-followup",
        "turn-followup",
        "A future team may use a separate analytics store."
      ),
      sourceKind: "voice",
    }),
    correctedType: "ai-ml-system-design",
    activeParentId: "parent-design",
    activeParentRevision: 2,
    manualCorrectionRevision: 2,
    revisionStableRelation: "followup-parent",
  }).settlement;
  const relatedProjected = authorizeManualCorrectionLifecycle({
    settlement: relatedFollowup,
    parentAction: "retype",
    activeParentId: "parent-design",
    activeParentType: "general-system-design",
  });

  assert.equal(relatedProjected.relation, "followup-parent");
  assert.equal(relatedProjected.parentMutationAuthorized, true);
  assert.equal(
    relatedProjected.reasons.includes("relation-does-not-create-parent"),
    false
  );
  assert.ok(relatedProjected.reasons.includes("parent-mutation-authorized"));
  assert.ok(
    relatedProjected.reasons.includes(
      "manual-correction-same-question-retype-authorized"
    )
  );
  assert.equal(
    authorizeManualCorrectionLifecycle({
      settlement: { ...settled, parentMutationAuthorized: false },
      parentAction: "create",
      activeParentId: "parent-design",
      activeParentType: "general-system-design",
    }).parentMutationAuthorized,
    false
  );
});

test("the still-live bounded handoff retains sourced scale and excludes subsystem QPS", () => {
  const parent = makeInterviewParent({ stableKind: "general-system-design" });
  const handoff = buildBoundedParentContextHandoff({ parent, sourceQuestionId: "q2",
    parentSourceQuestion: "Design a food delivery app", latestQuestionText: "Add recommendations to this app",
    transcriptTurns: [
      { id: "global", speaker: "them", text: "The food delivery app serves 10 million users.", source: "system-audio", isFinal: true, startedAt: 1, endedAt: 2 },
      { id: "subsystem", speaker: "them", text: "The payment service needs 10000 QPS.", source: "system-audio", isFinal: true, startedAt: 3, endedAt: 4 },
    ] });
  assert.deepEqual(handoff.sharedScenarioContext.applicableScaleAssumptions?.map(item => item.sourceTurnId), ["global"]);
  assert.ok(handoff.excludedContextKinds.includes("subsystem-qps"));
  assert.ok(handoff.excludedContextKinds.includes("generated-answers"));
});

test("shares one correction lifecycle commit boundary across correction paths", () => {
  const source = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
  assert.equal(
    source.match(/commitPlannedTaskRuntimeTransition\(/g)?.length,
    3
  );
  assert.match(
    source,
    /prepareManualCorrectionIntentTransition\([\s\S]*commitPlannedTaskRuntimeTransition\(/
  );
  assert.match(
    source,
    /explicitTaskMutationCommand: correctionIntentTransition\.command/
  );
  assert.match(
    source,
    /correctionOwnedResettlement\?\.parentMutationAuthorized[\s\S]*commitPlannedTaskRuntimeTransition\(/
  );
});

test("hands a no-parent Screen correction to Advisor from its committed source", () => {
  const source = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
  const correction = source.slice(
    source.indexOf("  const correctActiveQuestionType = useCallback"),
    source.indexOf("  const resolveCurrentSuggestionQuestionLineage")
  );
  const sourceAdmissionIndex = correction.indexOf(
    "const correctionSourceAdmission ="
  );
  const lifecycleCommitIndex = correction.indexOf(
    "const lifecycleCommit = commitPlannedTaskRuntimeTransition"
  );

  assert.ok(sourceAdmissionIndex >= 0);
  assert.ok(lifecycleCommitIndex > sourceAdmissionIndex);
  assert.match(
    correction.slice(sourceAdmissionIndex, lifecycleCommitIndex),
    /if \(!correctionSourceAdmission\.authorized\)[\s\S]*recordCorrectionHumanTypeTruth\(\{[\s\S]*finalizeCorrection\(\{[\s\S]*authorizationFailureReason: correctionSourceAdmission\.reason[\s\S]*return;/
  );
  assert.match(
    source,
    /advisorJob\.source === "manual-correction"[\s\S]*authorizeSettlementOwnedQuestionContext\(\{[\s\S]*sourceKind: settlementIdentitySource\.sourceKind[\s\S]*screenObservations:/
  );
  assert.match(
    source,
    /promptContext\.screenContext\.trim\(\) \|\|\s*advisorJob\.logicalQuestionUnit\?\.normalizedText\.trim\(\)/
  );
  assert.match(
    source,
    /const correctionRegenerationMode: AdvisorRequestMode =[\s\S]*correctionCurrentQuestionSourceKind === "voice"[\s\S]*"screen-anchored";/
  );
  assert.match(source, /mode: correctionRegenerationMode,/);
  assert.match(
    source,
    /const advisorSourceReadTask = settledExecutionPlan\s*\?\.taskMutationCommittedBeforeAdvisor[\s\S]*advisorSourceReadContext\.activeMeetingTask/
  );
});

test("stops manual correction before consuming a rejected explicit intent", () => {
  const source = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
  const correction = source.slice(
    source.indexOf("  const correctActiveQuestionType = useCallback"),
    source.indexOf("  const resolveCurrentSuggestionQuestionLineage")
  );
  const preparation = correction.indexOf(
    "const correctionIntentTransition = prepareManualCorrectionIntentTransition({"
  );
  const terminalGuard = correction.indexOf(
    'if (!correctionIntentTransition.authorized)',
    preparation
  );
  const relationRead = correction.indexOf(
    "correctionCurrentQuestionSettlement = correctionIntentTransition.settlement",
    preparation
  );

  assert.ok(preparation >= 0);
  assert.ok(terminalGuard > preparation && terminalGuard < relationRead);
  assert.match(
    correction.slice(terminalGuard, relationRead),
    /finalizeCorrection\([\s\S]*return;/
  );
  assert.doesNotMatch(correction, /await resolveOrderedTaskRelationWithinWindow\(/);
  assert.doesNotMatch(correction, /scheduleTaskRelationAdjudication\(/);
});

test("keeps the current parent when correction-owned relation adjudication abstains", () => {
  const unit = makeLogicalQuestion(
    "question-followup",
    "turn-followup",
    "Explain the consistency tradeoff."
  );
  const result = settleManualQuestionTypeCorrection({
    operationId: "correction-2",
    currentQuestion: createProvisionalCurrentQuestion({
      logicalQuestionUnit: unit,
      sourceKind: "voice",
    }),
    correctedType: "general-system-design",
    activeParentId: "parent-design",
    activeParentRevision: 2,
    manualCorrectionRevision: 4,
    relationCandidate: relationCandidate({
      relation: "unknown",
      confidence: 0.7,
    }),
    relationOperationLeaseAuthorized: true,
  });

  assert.equal(result.relationRelease?.authorized, false);
  assert.equal(
    result.relationRelease?.reason,
    "candidate-relation-unknown"
  );
  assert.equal(result.settlement.questionType, "general-system-design");
  assert.equal(result.settlement.relation, "unknown");
  assert.equal(result.settlement.typeMutationAuthorized, true);
  assert.equal(result.settlement.relationMutationAuthorized, false);
  assert.equal(result.settlement.parentMutationAuthorized, false);
});

test("deterministically creates or reseeds a parent only from exact source identity", () => {
  const unit = makeLogicalQuestion(
    "question-parent-origin",
    "turn-parent-origin",
    "Design a URL shortener."
  );
  const result = settleManualQuestionTypeCorrection({
    operationId: "correction-3",
    currentQuestion: createProvisionalCurrentQuestion({
      logicalQuestionUnit: unit,
      sourceKind: "screen",
      sourceObservationIds: ["observation-1"],
    }),
    correctedType: "general-system-design",
    activeParentId: "parent-wrong-type",
    activeParentRevision: 1,
    manualCorrectionRevision: 5,
    revisionStableRelation: "new-parent",
    revisionStableRelationReason: "active-parent-origin",
  });

  assert.equal(result.settlement.questionType, "general-system-design");
  assert.equal(result.settlement.relation, "new-parent");
  assert.equal(
    result.settlement.relationAuthoritySource,
    "deterministic-fast-path"
  );
  assert.equal(result.settlement.parentMutationAuthorized, true);
});

test("preserves an exact active child while applying the corrected current type", () => {
  const unit = makeLogicalQuestion(
    "question-child",
    "turn-child",
    "What does HNSW do?"
  );
  const result = settleManualQuestionTypeCorrection({
    operationId: "correction-4",
    currentQuestion: createProvisionalCurrentQuestion({
      logicalQuestionUnit: unit,
      sourceKind: "voice",
    }),
    correctedType: "field-knowledge",
    activeParentId: "parent-aiml",
    activeParentRevision: 7,
    manualCorrectionRevision: 6,
    revisionStableRelation: "child-probe",
    revisionStableRelationReason: "active-child-origin",
  });

  assert.equal(result.settlement.questionType, "field-knowledge");
  assert.equal(result.settlement.relation, "child-probe");
  assert.equal(
    result.settlement.relationAuthoritySource,
    "deterministic-fast-path"
  );
  assert.equal(result.settlement.relationMutationAuthorized, true);
  assert.equal(result.settlement.parentMutationAuthorized, false);
});

test("keeps a corrected follow-up on its revision-stable parent relation", () => {
  const unit = makeLogicalQuestion(
    "question-followup",
    "turn-followup",
    "What would you monitor in production?"
  );
  const result = settleManualQuestionTypeCorrection({
    operationId: "correction-followup",
    currentQuestion: createProvisionalCurrentQuestion({
      logicalQuestionUnit: unit,
      sourceKind: "voice",
    }),
    correctedType: "ai-ml-system-design",
    activeParentId: "parent-rag",
    activeParentRevision: 8,
    manualCorrectionRevision: 7,
    revisionStableRelation: "followup-parent",
    revisionStableRelationReason:
      "effective-question-source-ledger",
  });

  assert.equal(result.settlement.relation, "followup-parent");
  assert.equal(
    result.settlement.relationAuthoritySource,
    "deterministic-fast-path"
  );
  assert.equal(result.settlement.parentMutationAuthorized, false);
});

test("lets a newer manual correction replace the active operation", () => {
  const coordinator = new ManualCorrectionOperationCoordinator();

  assert.deepEqual(coordinator.claim("correction-a"), {
    operationId: "correction-a",
    accepted: true,
    supersedesOperationId: undefined,
  });
  assert.deepEqual(coordinator.claim("correction-b"), {
    operationId: "correction-b",
    accepted: true,
    supersedesOperationId: "correction-a",
  });
  assert.equal(coordinator.owns("correction-a"), false);
  assert.equal(coordinator.owns("correction-b"), true);
  assert.equal(coordinator.release("correction-a"), false);
  assert.equal(coordinator.getActiveOperationId(), "correction-b");
  assert.equal(coordinator.release("correction-b"), true);
  assert.equal(coordinator.getActiveOperationId(), null);
});

test("coalesces duplicate correction clicks for the same question revision", () => {
  const coordinator = new ManualCorrectionOperationCoordinator();

  assert.equal(
    coordinator.claim("correction-a", "session:question:1:coding").accepted,
    true
  );
  assert.deepEqual(
    coordinator.claim("correction-b", "session:question:1:coding"),
    {
      operationId: "correction-b",
      accepted: false,
      duplicateOfOperationId: "correction-a",
    }
  );
  assert.equal(coordinator.getActiveOperationId(), "correction-a");
  assert.equal(coordinator.release("correction-a"), true);
  assert.equal(
    coordinator.claim("correction-c", "session:question:1:coding").accepted,
    true
  );
});

test("keeps a meta-confirmation from stealing an unresolved substantive correction target", () => {
  const substantive = {
    logicalQuestionUnit: makeLogicalQuestion(
      "question-substantive",
      "turn-substantive",
      "Tell me about a time you missed a commitment."
    ),
    updatedAt: 10,
    targetKind: classifyManualCorrectionTarget({
      sourceKind: "voice",
      text: "Tell me about a time you missed a commitment.",
      intent: "direct-question",
    }),
  };
  const metaConfirmation = {
    logicalQuestionUnit: makeLogicalQuestion(
      "question-meta",
      "turn-meta",
      "Did you get my question?"
    ),
    updatedAt: 20,
    targetKind: classifyManualCorrectionTarget({
      sourceKind: "voice",
      text: "Did you get my question?",
      intent: "direct-question",
    }),
  };
  const history = upsertManualCorrectionTargetHistory(
    upsertManualCorrectionTargetHistory([], substantive),
    metaConfirmation
  );

  const selection = selectManualCorrectionTargetFromHistory({
    history,
    latestCanonical: metaConfirmation,
  });
  assert.equal(substantive.targetKind, "substantive");
  assert.equal(metaConfirmation.targetKind, "non-substantive");
  assert.equal(
    selection.target?.logicalQuestionUnit.id,
    "question-substantive"
  );
  assert.equal(selection.reason, "latest-unresolved-substantive");
});

test("keeps the latest resolved substantive question ahead of a phase-control turn", () => {
  const substantive = {
    logicalQuestionUnit: makeLogicalQuestion(
      "question-design",
      "turn-design",
      "Design a food delivery app."
    ),
    updatedAt: 10,
    targetKind: "substantive" as const,
    settlementDisposition: "domain-resolved-provisional" as const,
    resolvedAt: 15,
  };
  const phaseControl = {
    logicalQuestionUnit: makeLogicalQuestion(
      "question-phase-control",
      "turn-phase-control",
      "You can make reasonable assumptions."
    ),
    updatedAt: 20,
    targetKind: classifyManualCorrectionTarget({
      sourceKind: "voice",
      text: "You can make reasonable assumptions.",
      intent: "constraint-or-follow-up",
      followupScopeSource: "provisional-question",
      phaseControl: true,
    }),
  };
  const history = upsertManualCorrectionTargetHistory(
    upsertManualCorrectionTargetHistory([], substantive),
    phaseControl
  );

  const selection = selectManualCorrectionTargetFromHistory({
    history,
    latestCanonical: phaseControl,
    preferredLogicalQuestionUnitId: phaseControl.logicalQuestionUnit.id,
    preferredLogicalQuestionRevision:
      phaseControl.logicalQuestionUnit.revision,
  });

  assert.equal(phaseControl.targetKind, "non-substantive");
  assert.equal(selection.reason, "latest-substantive");
  assert.equal(selection.target?.logicalQuestionUnit.id, "question-design");
});

test("treats a scoped provisional follow-up as correction context", () => {
  assert.equal(
    classifyManualCorrectionTarget({
      sourceKind: "voice",
      text: "Use ten thousand requests per second.",
      intent: "constraint-or-follow-up",
      followupScopeSource: "provisional-question",
    }),
    "non-substantive"
  );
  assert.equal(
    classifyManualCorrectionTarget({
      sourceKind: "voice",
      text: "Also support multi-region failover.",
      intent: "constraint-or-follow-up",
      followupScopeSource: "active-task",
    }),
    "substantive"
  );
});

test("falls back to the visible answered question after unresolved targets resolve", () => {
  const target: ManualCorrectionTargetHistoryEntry = {
    logicalQuestionUnit: makeLogicalQuestion(
      "question-visible",
      "turn-visible",
      "Design a URL shortener."
    ),
    updatedAt: 10,
    targetKind: "substantive" as const,
  };
  const history = markManualCorrectionTargetResolved([target], {
    logicalQuestionUnitId: "question-visible",
    logicalQuestionRevision: 1,
    resolvedAt: 30,
  });
  const selection = selectManualCorrectionTargetFromHistory({
    history,
    preferredLogicalQuestionUnitId: "question-visible",
    preferredLogicalQuestionRevision: 1,
  });

  assert.equal(selection.reason, "preferred-visible-question");
  assert.equal(selection.target?.resolvedAt, 30);
});

test("prefers the explicitly clicked current question over an older unresolved target", () => {
  const oldUnresolved: ManualCorrectionTargetHistoryEntry = {
    logicalQuestionUnit: makeLogicalQuestion(
      "question-old",
      "turn-old",
      "Design a RAG system."
    ),
    updatedAt: 10,
    targetKind: "substantive",
  };
  const clicked: ManualCorrectionTargetHistoryEntry = {
    logicalQuestionUnit: makeLogicalQuestion(
      "question-clicked",
      "turn-clicked",
      "Explain HNSW."
    ),
    updatedAt: 20,
    targetKind: "substantive",
  };

  const selection = selectManualCorrectionTargetFromHistory({
    history: [oldUnresolved, clicked],
    latestCanonical: clicked,
    preferredLogicalQuestionUnitId: clicked.logicalQuestionUnit.id,
    preferredLogicalQuestionRevision: clicked.logicalQuestionUnit.revision,
  });

  assert.equal(selection.reason, "preferred-visible-question");
  assert.equal(
    selection.target?.logicalQuestionUnit.id,
    clicked.logicalQuestionUnit.id
  );
});

test("always terminalizes an applied correction after stale completion authorization", () => {
  assert.deepEqual(
    decideManualCorrectionTerminalState({
      mutationApplied: true,
      stableAnswerCommitted: false,
      regenerationTraceStatus: "cancelled",
      authorizationFailureReason: "parent-revision-mismatch",
    }),
    {
      status: "applied",
      regenerationStatus: "cancelled",
      regenerationRetryable: true,
      error:
        "Answer regeneration was cancelled because the correction lost runtime authority: parent-revision-mismatch. The corrected task type was kept and regeneration can be retried.",
    }
  );
  assert.deepEqual(
    decideManualCorrectionTerminalState({
      mutationApplied: true,
      stableAnswerCommitted: true,
      regenerationTraceStatus: "success",
      authorizationFailureReason: "parent-revision-mismatch",
    }),
    {
      status: "applied",
      regenerationStatus: "succeeded",
      regenerationRetryable: false,
    }
  );
});

test("treats selecting the effective question type as a no-op", () => {
  const decision = decideManualQuestionTypeCorrection(
    makeActiveTask({ questionType: "coding" }),
    "coding"
  );

  assert.equal(decision.noOp, true);
  assert.equal(decision.reason, "already-effective-question-type");
  assert.equal(decision.target, undefined);
});

test("promotes every parent-eligible provisional question", () => {
  const coding = decideProvisionalQuestionTypeCorrection("coding");
  assert.equal(coding.noOp, false);
  assert.equal(coding.target, "provisional-question");
  assert.equal(coding.detectedType, "unknown");
  assert.equal(coding.correctedType, "coding");

  const fieldKnowledge =
    decideProvisionalQuestionTypeCorrection("field-knowledge");
  assert.equal(fieldKnowledge.noOp, false);
  assert.equal(fieldKnowledge.target, "provisional-question");
  assert.equal(
    fieldKnowledge.reason,
    "manual-correction-promotes-provisional-question"
  );
});

test("shows correction controls for a canonical current question without a parent", () => {
  const lineage = {
    questionInstanceId: "lqu:question-current",
    questionOriginTraceId: "trace-current",
    sourceSuggestionId: "suggestion-current",
    identityState: "canonical" as const,
  };

  assert.equal(
    hasManualQuestionTypeCorrectionPresentationTarget({
      hasActiveTask: false,
      currentQuestionLineage: lineage,
      latestSuggestion: {
        id: "suggestion-current",
        questionLineage: lineage,
      },
    }),
    true
  );
  assert.equal(
    hasManualQuestionTypeCorrectionPresentationTarget({
      hasActiveTask: false,
      currentQuestionLineage: lineage,
      latestSuggestion: {
        id: "suggestion-newer",
        questionLineage: {
          ...lineage,
          sourceSuggestionId: "suggestion-newer",
          questionInstanceId: "lqu:question-newer",
        },
      },
    }),
    true
  );
});

test("hides correction controls when no current source-owned question exists", () => {
  assert.equal(
    hasManualQuestionTypeCorrectionPresentationTarget({
      hasActiveTask: false,
      latestSuggestion: {
        id: "suggestion-current",
      },
    }),
    false
  );
  assert.equal(
    hasManualQuestionTypeCorrectionPresentationTarget({
      hasActiveTask: false,
      currentQuestionLineage: {
        questionInstanceId: "lqu:question-old",
        questionOriginTraceId: "trace-old",
        sourceSuggestionId: "suggestion-old",
        identityState: "canonical",
      },
      latestSuggestion: {
        id: "suggestion-current",
      },
    }),
    false
  );
});


test("keeps current question lineage authoritative even when a parent is active", () => {
  const lineage = {
    questionInstanceId: "trace:trace_1",
    questionOriginTraceId: "trace_1",
    sourceSuggestionId: "suggestion_1",
    sessionId: "session_1",
    runtimeEpoch: 2,
    identityState: "provisional" as const,
  };
  const latestSuggestion = {
    id: "suggestion_1",
    sourceTraceId: "trace_1",
    kind: "answer" as const,
    content: "Current answer",
    createdAt: 1,
    basedOnTurnIds: [],
    basedOnObservationIds: [],
    confidence: "medium" as const,
    questionLineage: lineage,
  };

  assert.deepEqual(
    resolveManualCorrectionTarget({
      currentQuestionLineage: lineage,
      latestSuggestion,
      sessionId: "session_1",
      runtimeEpoch: 2,
    }),
    { source: "provisional-question", lineage }
  );
  assert.deepEqual(
    resolveManualCorrectionTarget({
      activeTask: makeActiveTask({ questionType: "behavioral" }),
      currentQuestionLineage: lineage,
      latestSuggestion,
      sessionId: "session_1",
      runtimeEpoch: 2,
    }),
    {
      source: "active-task",
      task: makeActiveTask({ questionType: "behavioral" }),
      lineage,
      targetSource: "current-question",
    }
  );
  assert.equal(
    resolveManualCorrectionTarget({
      currentQuestionLineage: lineage,
      latestSuggestion,
      sessionId: "session_1",
      runtimeEpoch: 1,
    }).source,
    "none"
  );
  assert.equal(resolveManualCorrectionTarget({ currentQuestionLineage: lineage,
    latestSuggestion, sessionId: "session_1", runtimeEpoch: 3 }).source, "provisional-question");
});

test("prefers a canonical logical question over stale suggestion lineage", () => {
  const logicalQuestionUnit: LogicalQuestionUnit = {
    id: "logical-question-current",
    revision: 2,
    sessionId: "session_1",
    runtimeEpoch: 2,
    currentTurnId: "turn_current",
    sourceTurnIds: ["turn_setup", "turn_current"],
    sources: [
      {
        turnId: "turn_setup",
        text: "Let us discuss the recommendation system.",
        startedAt: 1,
        endedAt: 2,
      },
      {
        turnId: "turn_current",
        text: "How would you evaluate it?",
        startedAt: 3,
        endedAt: 4,
      },
    ],
    normalizedText:
      "Let us discuss the recommendation system.\nHow would you evaluate it?",
    startedAt: 1,
    updatedAt: 4,
    compositionReasons: ["bounded-continuation"],
    boundaryReason: "bounded-continuation",
    truncated: false,
  };
  const canonicalLineage = {
    questionInstanceId: "lqu:logical-question-current",
    questionOriginTraceId: "trace_current",
    triggerTurnId: "turn_current",
    sessionId: "session_1",
    runtimeEpoch: 2,
    identityState: "canonical" as const,
  };
  const staleLineage = {
    questionInstanceId: "trace:trace_old",
    questionOriginTraceId: "trace_old",
    sourceSuggestionId: "suggestion_old",
    sessionId: "session_1",
    runtimeEpoch: 2,
    identityState: "provisional" as const,
  };
  const latestSuggestion = {
    id: "suggestion_old",
    sourceTraceId: "trace_old",
    kind: "answer" as const,
    content: "Old answer",
    createdAt: 1,
    basedOnTurnIds: [],
    basedOnObservationIds: [],
    confidence: "medium" as const,
    questionLineage: staleLineage,
  };
  const task = makeActiveTask({ questionType: "general-system-design" });

  assert.deepEqual(
    resolveManualCorrectionTarget({
      activeTask: task,
      currentQuestionLineage: staleLineage,
      canonicalLogicalQuestion: {
        logicalQuestionUnit,
        lineage: canonicalLineage,
      },
      latestSuggestion,
      sessionId: "session_1",
      runtimeEpoch: 2,
    }),
    {
      source: "active-task",
      task,
      lineage: canonicalLineage,
      targetSource: "current-question",
      logicalQuestionUnit,
    }
  );
});

test("PC4 canonical correction target retains its source birth epoch after Pause", () => {
  const logicalQuestionUnit = makeLogicalQuestion("historical-question", "turn-historical", "Design a RAG system.");
  const lineage = { ...makeLineage(logicalQuestionUnit.currentTurnId),
    questionInstanceId: `lqu:${logicalQuestionUnit.id}`, sessionId: logicalQuestionUnit.sessionId,
    runtimeEpoch: logicalQuestionUnit.runtimeEpoch };
  const input = { canonicalLogicalQuestion: { logicalQuestionUnit, lineage }, latestSuggestion: undefined,
    sessionId: logicalQuestionUnit.sessionId, runtimeEpoch: 3 };
  for (const activeTask of [undefined, makeActiveTask({ questionType: "general-system-design" })]) {
    const target = resolveManualCorrectionTarget({ ...input, activeTask });
    assert.notEqual(target.source, "none");
    if (target.source === "none") continue;
    assert.equal(target.logicalQuestionUnit, logicalQuestionUnit);
    assert.equal(target.logicalQuestionUnit?.runtimeEpoch, 1);
    assert.equal(target.lineage, lineage);
  }
  for (const patch of [{ runtimeEpoch: 4 }, { sessionId: "new-session" }, { id: "different-question" }, { currentTurnId: "different-turn" }]) {
    assert.equal(resolveManualCorrectionTarget({ ...input,
      canonicalLogicalQuestion: { logicalQuestionUnit: { ...logicalQuestionUnit, ...patch }, lineage } }).source, "none");
  }
});





test("authorizes a same-parent retype without rewriting historical resume topology", () => {
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: makeLogicalQuestion("lqu-resume", "turn-resume", "Back to the RAG architecture."),
    sourceKind: "voice",
  });
  const { settlement } = settleManualQuestionTypeCorrection({
    operationId: "correction-resume",
    currentQuestion,
    correctedType: "general-system-design",
    activeParentId: "parent-rag",
    activeParentRevision: 4,
    manualCorrectionRevision: 1,
    revisionStableRelation: "resume-parent",
  });
  const authorized = authorizeManualCorrectionLifecycle({
    settlement,
    parentAction: "retype",
    activeParentId: "parent-rag",
    activeParentType: "ai-ml-system-design",
  });
  assert.equal(settlement.parentMutationAuthorized, false);
  assert.equal(authorized.parentMutationAuthorized, true);
  assert.equal(authorized.relation, "resume-parent");
  assert.equal(authorized.sourceHash, settlement.sourceHash);
  assert.equal(authorized.manualCorrectionRevision, 1);
  assert.equal(authorized.activeParentRevision, 4);
  for (const parentAction of ["preserve", "resume", "attach-child"] as const) {
    assert.equal(authorizeManualCorrectionLifecycle({
      settlement, parentAction, activeParentId: "parent-rag", activeParentType: "ai-ml-system-design",
    }), settlement);
  }
  assert.equal(authorizeManualCorrectionLifecycle({
    settlement, parentAction: "retype", activeParentId: "different-parent", activeParentType: "ai-ml-system-design",
  }), settlement);
});











test("resumes the existing parent when a child probe is corrected to the parent type", () => {
  const whiteboard = makeWhiteboard("ml_sd");
  const parent = makeInterviewParent({
    stableKind: "ai-ml-system-design",
    playbookPhase: "design_framing",
    child: makeChild({ questionType: "field-knowledge" }),
    whiteboardArtifact: whiteboard,
  });
  const decision = decideManualQuestionTypeCorrection(
    makeActiveTask({
      questionType: "ai-ml-system-design",
      child: makeChild({ questionType: "field-knowledge" }),
    }),
    "ai-ml-system-design"
  );

  const next = applyManualQuestionTypeCorrectionToParent({
    parent,
    decision,
    now: now + 10,
  });

  assert.equal(decision.target, "resume-parent");
  assert.equal(next.id, parent.id);
  assert.equal(next.stableKind, "ai-ml-system-design");
  assert.equal(next.playbookPhase, "design_framing");
  assert.equal(next.child, undefined);
  assert.equal(next.whiteboardArtifact, whiteboard);
  assert.equal(next.revisions, parent.revisions + 1);
  assertPureParentPayload(next);
});


test("retypes a parent in place while resetting incompatible runtime state", () => {
  const parent = makeInterviewParent({
    stableKind: "coding",
    playbookPhase: "solution_planning",
    phaseProgress: { solution_planning: true },
    supportedFactAnchors: ["old-anchor"],
    whiteboardArtifact: makeWhiteboard("general_sd"),
  });
  const decision = decideManualQuestionTypeCorrection(
    makeActiveTask({ questionType: "coding" }),
    "project-deep-dive"
  );
  const playbook = makePlaybook("project-deep-dive", "project_summary");

  const next = applyManualQuestionTypeCorrectionToParent({
    parent,
    decision,
    correctedPlaybook: playbook,
    now: now + 20,
  });

  assert.equal(decision.target, "parent");
  assert.equal(next.id, parent.id);
  assert.equal(next.stableKind, "project-deep-dive");
  assert.equal(next.playbook, playbook);
  assert.equal(next.playbookPhase, "project_summary");
  assert.deepEqual(next.phaseProgress, { project_summary: true });
  assert.deepEqual(next.supportedFactAnchors, []);
  assertPureParentPayload(next);
  assert.equal(next.whiteboardArtifact, undefined);
});

test("clears the current whiteboard pointer when system-design type changes", () => {
  const whiteboard = makeWhiteboard("general_sd");
  const parent = makeInterviewParent({
    stableKind: "general-system-design",
    whiteboardArtifact: whiteboard,
  });
  const decision = decideManualQuestionTypeCorrection(
    makeActiveTask({ questionType: "general-system-design" }),
    "ai-ml-system-design"
  );

  const next = applyManualQuestionTypeCorrectionToParent({
    parent,
    decision,
    correctedPlaybook: makePlaybook(
      "ai-ml-system-design",
      "requirement_clarification"
    ),
  });

  assert.equal(next.stableKind, "ai-ml-system-design");
  assert.equal(next.whiteboardArtifact, undefined);
});

test("returns only parent state across compatible system-design retypes", () => {
  const parent = makeInterviewParent({
    stableKind: "general-system-design",
  });
  const decision = decideManualQuestionTypeCorrection(
    makeActiveTask({ questionType: "general-system-design" }),
    "ai-ml-system-design"
  );

  const next = applyManualQuestionTypeCorrectionToParent({
    parent,
    decision,
    correctedPlaybook: makePlaybook(
      "ai-ml-system-design",
      "requirement_clarification"
    ),
  });

  assert.equal(next.id, parent.id);
  assert.equal(next.stableKind, "ai-ml-system-design");
  assertPureParentPayload(next);
});


function assertPureParentPayload(parent: ActiveInterviewParent) {
  assert.equal("latestUsefulAnswer" in parent, false);
  assert.equal("previousUsefulAnswer" in parent, false);
  assert.equal("expiresAt" in parent, false);
  if (parent.child) assert.equal("compactSummary" in parent.child, false);
}

function makeActiveTask({
  questionType,
  child,
}: {
  questionType: CanonicalQuestionType;
  child?: ActiveInterviewChild;
}): ActiveMeetingTask {
  return {
    id: "meeting_task_1",
    runtimeRevision: 1,
    source: "voice",
    parent: {
      id: "parent_1",
      questionType,
      topic: "current question",
      playbookPhase: "follow_up",
      phaseProgress: {},
      supportedFactAnchors: [],
      createdAt: now,
      updatedAt: now,
      revisions: 1,
    },
    child,
  };
}

function makeInterviewParent(
  overrides: Partial<ActiveInterviewParent> = {}
): ActiveInterviewParent {
  return {
    id: "parent_1",
    source: "voice",
    stableKind: "behavioral",
    topic: "current question",
    playbookPhase: "story_selection",
    phaseProgress: { story_selection: true },
    supportedFactAnchors: ["anchor_1"],
    createdAt: now,
    updatedAt: now,
    revisions: 1,
    ...overrides,
  };
}

function makeChild(
  overrides: Partial<ActiveInterviewChild> = {}
): ActiveInterviewChild {
  return {
    id: "child_1",
    createdAt: now,
    updatedAt: now,
    questionType: "field-knowledge",
    relation: "child-probe",
    intent: "concept-probe",
    question: "How does retrieval work?",
    basedOnTurnIds: ["turn_1"],
    basedOnObservationIds: [],
    ...overrides,
  };
}

function makePlaybook(
  questionType: CanonicalQuestionType,
  phase: SelectedInterviewPlaybook["phase"]
): SelectedInterviewPlaybook {
  return {
    id:
      questionType === "project-deep-dive"
        ? "project_deep_dive"
        : "aiml_system_design",
    label: "Corrected playbook",
    phase,
    questionType,
    confidence: 1,
    reason: "manual question type correction",
    memoryPolicy: {
      id: `manual-correction-${questionType}`,
      allowedFamilies:
        questionType === "project-deep-dive"
          ? ["project-deep-dive"]
          : ["ai-ml-system-design"],
    },
    firstMove: "Apply the corrected playbook.",
    clarifyingStrategy: "Ask only when needed.",
    outputContract: "Return a direct answer.",
    followUpPolicy: "Continue from the corrected task.",
  };
}

function makeWhiteboard(
  domainTrack: WhiteboardArtifact["domainTrack"]
): WhiteboardArtifact {
  return {
    id: "whiteboard_1",
    parentTaskId: "parent_1",
    domainTrack,
    archetypeIds: [],
    selectedOverlayIds: [],
    currentPhase: "design_framing",
    title: "Architecture",
    content: "Client -> API -> Service",
    summary: "Current architecture",
    revision: 1,
    updateSource: "model-output",
    updatedAt: now,
    createdAt: now,
  };
}

function makeLineage(triggerTurnId: string) {
  return {
    questionInstanceId: `trace:${triggerTurnId}`,
    questionOriginTraceId: triggerTurnId,
    sourceSuggestionId: `suggestion_${triggerTurnId}`,
    triggerTurnId,
    sessionId: "session_1",
    runtimeEpoch: 1,
    identityState: "canonical" as const,
  };
}

function makeTurn(id: string, text: string): TranscriptTurn {
  return {
    id,
    speaker: "them",
    text,
    startedAt: now,
    endedAt: now + 1,
    isFinal: true,
    source: "system-audio",
  };
}

function makeLogicalQuestion(
  id: string,
  turnId: string,
  text: string
): LogicalQuestionUnit {
  return {
    id,
    revision: 1,
    sessionId: "session_1",
    runtimeEpoch: 1,
    currentTurnId: turnId,
    sourceTurnIds: [turnId],
    sources: [
      {
        turnId,
        text,
        startedAt: now,
        endedAt: now + 1,
      },
    ],
    normalizedText: text,
    startedAt: now,
    updatedAt: now + 1,
    compositionReasons: ["fresh-substantive-turn"],
    boundaryReason: "fresh-substantive-turn",
    truncated: false,
  };
}

function relationCandidate(
  overrides: Partial<LlmTaskRelationAdjudication> = {}
): LlmTaskRelationAdjudication {
  return {
    schemaVersion: 3,
    relation: "new-parent",
    dependency: "parent-independent",
    continuationShape: "mainline",
    returnIntent: "no-resume",
    switchIntent: "explicit-switch",
    standaloneSufficiency: "sufficient",
    confidence: 0.98,
    currentQuestionEvidenceSpans: ["Design a food delivery system."],
    parentEvidenceSpans: [],
    explicitBinding: false,
    standalone: true,
    ...overrides,
  };
}
