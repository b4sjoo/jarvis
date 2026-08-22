import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import {
  applyManualQuestionTypeCorrectionToParent,
  buildManualCorrectionParentTransition,
  classifyManualCorrectionTarget,
  decideManualCorrectionTerminalState,
  decideManualQuestionTypeCorrection,
  decideManualCorrectionScope,
  decideProvisionalQuestionTypeCorrection,
  markManualCorrectionTargetResolved,
  resolveManualCorrectionTarget,
  selectManualCorrectionTargetFromHistory,
  upsertManualCorrectionTargetHistory,
  ManualCorrectionOperationCoordinator,
  type ManualCorrectionTargetHistoryEntry,
} from "../src/lib/meeting/manual-question-type-correction.js";
import type {
  ActiveInterviewChild,
  ActiveInterviewParent,
  SelectedInterviewPlaybook,
  WhiteboardArtifact,
  TranscriptTurn,
} from "../src/lib/meeting/types.js";
import type { CanonicalQuestionType } from "../src/lib/meeting/task-taxonomy.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";

const now = 1_000;

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

test("keeps a resolved response-only question ahead of a phase-control turn", () => {
  const responseOnly = {
    logicalQuestionUnit: makeLogicalQuestion(
      "question-design",
      "turn-design",
      "Design a food delivery app."
    ),
    updatedAt: 10,
    targetKind: "substantive" as const,
    settlementDisposition: "response-only" as const,
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
    upsertManualCorrectionTargetHistory([], responseOnly),
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
  assert.equal(selection.reason, "latest-response-only-substantive");
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

test("promotes an unknown provisional question only to a parent type", () => {
  const coding = decideProvisionalQuestionTypeCorrection("coding");
  assert.equal(coding.noOp, false);
  assert.equal(coding.target, "provisional-question");
  assert.equal(coding.detectedType, "unknown");
  assert.equal(coding.correctedType, "coding");

  const fieldKnowledge =
    decideProvisionalQuestionTypeCorrection("field-knowledge");
  assert.equal(fieldKnowledge.noOp, true);
  assert.equal(
    fieldKnowledge.reason,
    "provisional-correction-requires-parent-type"
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
      runtimeEpoch: 3,
    }).source,
    "none"
  );
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

test("keeps a same-origin system-design correction on the existing parent", () => {
  const task = makeActiveTask({ questionType: "general-system-design" });
  task.parent.startTurnId = "turn_origin";
  const decision = decideManualQuestionTypeCorrection(
    task,
    "ai-ml-system-design"
  );
  const scope = decideManualCorrectionScope({
    task,
    decision,
    lineage: makeLineage("turn_origin"),
    latestQuestionText: "Design a RAG system for trip planning.",
    parentQuestionText: "Design a RAG system for trip planning.",
    classifierConfidence: 0.9,
  });

  assert.equal(scope.scope, "same-question-retype");
  assert.equal(scope.currentQuestionIsParentOrigin, true);
});

test("keeps a same-origin screen correction on the existing parent", () => {
  const task = makeActiveTask({ questionType: "general-system-design" });
  task.parent.startObservationId = "obs_origin";
  const decision = decideManualQuestionTypeCorrection(
    task,
    "ai-ml-system-design"
  );
  const scope = decideManualCorrectionScope({
    task,
    decision,
    lineage: {
      ...makeLineage(""),
      triggerTurnId: undefined,
    },
    latestQuestionText: "Design a RAG system for trip planning.",
    parentQuestionText: "Design a RAG system for trip planning.",
    classifierConfidence: 0.9,
    currentQuestionMatchesParentOrigin: true,
  });

  assert.equal(scope.scope, "same-question-retype");
  assert.equal(scope.currentQuestionIsParentOrigin, true);
});

test("keeps standalone correction current-only without relation authority", () => {
  const task = makeActiveTask({ questionType: "general-system-design" });
  task.parent.topic = "Design a ride-sharing app with location tracking";
  task.parent.startTurnId = "turn_ride_share";
  const decision = decideManualQuestionTypeCorrection(
    task,
    "ai-ml-system-design"
  );
  const scope = decideManualCorrectionScope({
    task,
    decision,
    lineage: makeLineage("turn_travel_agent"),
    latestQuestionText:
      "Design a self-evolving travel recommendation agent.",
    classifierConfidence: 0.9,
  });

  assert.equal(scope.scope, "current-only");
  assert.equal(scope.reason, "type-correction-parent-mutation-not-authorized");
  assert.ok(scope.standaloneTaskScore >= 3);
  assert.ok(scope.continuityScore <= 0);
  assert.ok(
    scope.continuityEvidence.includes("no-shared-product-entity-or-data")
  );
});

test("uses an authorized new-parent settlement instead of retyping a stale parent", () => {
  const task = makeActiveTask({ questionType: "coding" });
  task.parent.topic = "Implement a multiset data structure";
  const decision = decideManualQuestionTypeCorrection(task, "behavioral");
  const scope = decideManualCorrectionScope({
    task,
    decision,
    lineage: makeLineage("screen:obs_behavioral"),
    latestQuestionText:
      "Tell me about a time you persuaded a skeptical stakeholder.",
    classifierConfidence: 0.99,
    currentQuestionRelation: "new-parent",
    currentQuestionSource: "screen",
  });

  assert.equal(scope.scope, "independent-new-parent");
  assert.equal(scope.reason, "authorized-new-parent-re-roots-current-question");
});

test("keeps a relation-unsettled screen correction current-only", () => {
  const task = makeActiveTask({ questionType: "coding" });
  const decision = decideManualQuestionTypeCorrection(task, "behavioral");
  const scope = decideManualCorrectionScope({
    task,
    decision,
    lineage: makeLineage("screen:obs_behavioral"),
    latestQuestionText:
      "Tell me about a time you persuaded a skeptical stakeholder.",
    classifierConfidence: 0.99,
    currentQuestionRelation: "unknown",
    currentQuestionSource: "screen",
  });

  assert.equal(scope.scope, "current-only");
  assert.equal(scope.reason, "screen-question-relation-unsettled");
});

test("promotes a provisional question even when its relation is unsettled", () => {
  const decision = decideProvisionalQuestionTypeCorrection("behavioral");
  const scope = decideManualCorrectionScope({
    decision,
    lineage: makeLineage("screen:obs_behavioral"),
    latestQuestionText:
      "Tell me about a time you persuaded a skeptical stakeholder.",
    classifierConfidence: 0.99,
    currentQuestionRelation: "unknown",
    currentQuestionSource: "screen",
  });

  assert.equal(scope.scope, "independent-new-parent");
  assert.equal(
    scope.reason,
    "manual-correction-promotes-question-without-active-parent"
  );
});

test("does not let a current-only correction mutate the active parent", () => {
  const parent = makeInterviewParent({
    id: "parent_coding",
    stableKind: "coding",
    topic: "Implement a multiset data structure",
  });
  const task = makeActiveTask({ questionType: "coding" });
  const decision = decideManualQuestionTypeCorrection(task, "behavioral");
  const scopeDecision = decideManualCorrectionScope({
    task,
    decision,
    lineage: makeLineage("screen:obs_behavioral"),
    latestQuestionText:
      "Tell me about a time you persuaded a skeptical stakeholder.",
    currentQuestionRelation: "unknown",
    currentQuestionSource: "screen",
  });
  const transition = buildManualCorrectionParentTransition({
    parent,
    decision,
    scopeDecision,
    latestQuestionText:
      "Tell me about a time you persuaded a skeptical stakeholder.",
    transcriptTurns: [],
    newParentId: "parent_behavioral",
  });

  assert.equal(transition.parent, parent);
  assert.equal(transition.startedNewParent, false);
  assert.equal(transition.previousParentId, "parent_coding");
  assert.equal(transition.nextParentId, "parent_coding");
});

test("creates a linked parent for a recommendation extension of the same app", () => {
  const task = makeActiveTask({ questionType: "general-system-design" });
  task.parent.topic = "Design a food delivery app";
  task.parent.startTurnId = "turn_food_delivery";
  const decision = decideManualQuestionTypeCorrection(
    task,
    "ai-ml-system-design"
  );
  const scope = decideManualCorrectionScope({
    task,
    decision,
    lineage: makeLineage("turn_food_recommendation"),
    latestQuestionText:
      "For this app, design a self-evolving food recommendation agent.",
    classifierConfidence: 0.9,
    currentQuestionRelation: "new-parent",
  });

  assert.equal(scope.scope, "linked-parent-extension");
  assert.ok(scope.continuityScore >= 4);
  assert.ok(scope.continuityEvidence.includes("explicit-same-system-marker"));
});

test("re-roots an independent correction without old answers, QPS, or artifacts", () => {
  const parent = makeInterviewParent({
    id: "parent_ride_share",
    stableKind: "general-system-design",
    topic: "Design a ride-sharing app",
    startTurnId: "turn_ride_share",
    latestUsefulAnswer: "Use GPS fanout at 50K QPS",
    previousUsefulAnswer: "Protect payment with idempotency",
    whiteboardArtifact: makeWhiteboard("general_sd"),
    phaseProgress: { deep_dive: true },
  });
  const task = makeActiveTask({ questionType: "general-system-design" });
  task.parent.id = parent.id;
  task.parent.topic = parent.topic;
  task.parent.startTurnId = parent.startTurnId;
  const decision = decideManualQuestionTypeCorrection(
    task,
    "ai-ml-system-design"
  );
  const lineage = makeLineage("turn_travel_agent");
  const scopeDecision = decideManualCorrectionScope({
    task,
    decision,
    lineage,
    latestQuestionText:
      "Design a self-evolving travel recommendation agent.",
    classifierConfidence: 0.9,
    currentQuestionRelation: "new-parent",
  });

  const transition = buildManualCorrectionParentTransition({
    parent,
    decision,
    scopeDecision,
    correctedPlaybook: makePlaybook(
      "ai-ml-system-design",
      "requirement_clarification"
    ),
    latestQuestionText:
      "Design a self-evolving travel recommendation agent.",
    lineage,
    transcriptTurns: [
      makeTurn("turn_ride_share", "Design a ride-sharing app"),
      makeTurn("turn_scale", "Assume 10 million DAU"),
      makeTurn("turn_qps", "Estimate GPS QPS"),
      makeTurn("turn_payment", "How do we avoid double payment?"),
      makeTurn(
        "turn_travel_agent",
        "Design a self-evolving travel recommendation agent."
      ),
    ],
    newParentId: "parent_travel_agent",
    now: now + 100,
  });

  assert.equal(transition.startedNewParent, true);
  assert.equal(transition.previousParentId, "parent_ride_share");
  assert.equal(transition.nextParentId, "parent_travel_agent");
  assert.equal(transition.parent.parentContextHandoff, undefined);
  assert.equal(transition.parent.latestUsefulAnswer, undefined);
  assert.equal(transition.parent.previousUsefulAnswer, undefined);
  assert.equal(transition.parent.whiteboardArtifact, undefined);
  assert.equal(
    transition.parent.promptTranscriptStartTurnId,
    "turn_travel_agent"
  );
  assert.deepEqual(transition.parent.phaseProgress, {
    requirement_clarification: true,
  });
});

test("creates a bounded linked handoff without subsystem QPS or generated answers", () => {
  const parent = makeInterviewParent({
    id: "parent_food_delivery",
    stableKind: "general-system-design",
    topic: "Design a food delivery app",
    startTurnId: "turn_food_delivery",
    latestUsefulAnswer: "Generated answer about order dispatch",
    whiteboardArtifact: makeWhiteboard("general_sd"),
  });
  const task = makeActiveTask({ questionType: "general-system-design" });
  task.parent.id = parent.id;
  task.parent.topic = parent.topic;
  task.parent.startTurnId = parent.startTurnId;
  const decision = decideManualQuestionTypeCorrection(
    task,
    "ai-ml-system-design"
  );
  const lineage = makeLineage("turn_food_recommendation");
  const latestQuestion =
    "For this app, design a self-evolving food recommendation agent.";
  const scopeDecision = decideManualCorrectionScope({
    task,
    decision,
    lineage,
    latestQuestionText: latestQuestion,
    classifierConfidence: 0.9,
    currentQuestionRelation: "new-parent",
  });

  const transition = buildManualCorrectionParentTransition({
    parent,
    decision,
    scopeDecision,
    correctedPlaybook: makePlaybook(
      "ai-ml-system-design",
      "requirement_clarification"
    ),
    latestQuestionText: latestQuestion,
    lineage,
    transcriptTurns: [
      makeTurn("turn_food_delivery", "Design a food delivery app"),
      makeTurn(
        "turn_entities",
        "The users browse restaurants and menus, then create orders."
      ),
      makeTurn("turn_scale", "Assume 10 million daily active users."),
      makeTurn("turn_qps", "Order placement is 5000 QPS."),
      makeTurn("turn_payment", "Use a payment idempotency key."),
      makeTurn("turn_food_recommendation", latestQuestion),
    ],
    newParentId: "parent_food_recommendation",
  });

  const handoff = transition.parent.parentContextHandoff;
  assert.equal(transition.startedNewParent, true);
  assert.equal(handoff?.sourceParentId, "parent_food_delivery");
  assert.equal(handoff?.sharedScenarioContext.productIdentity, "food delivery");
  assert.deepEqual(handoff?.sharedScenarioContext.domainEntities, [
    "users",
    "restaurants",
    "menus",
    "orders",
  ]);
  assert.deepEqual(handoff?.sharedScenarioContext.applicableScaleAssumptions, [
    {
      value: "Assume 10 million daily active users.",
      sourceTurnId: "turn_scale",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(handoff), /5000 QPS|payment|idempotency/i);
  assert.equal(transition.parent.latestUsefulAnswer, undefined);
  assert.equal(transition.parent.whiteboardArtifact, undefined);
});

test("keeps elliptical type corrections current-only without relation authority", () => {
  const task = makeActiveTask({ questionType: "general-system-design" });
  task.parent.topic = "Design a ride-sharing app";
  task.parent.startTurnId = "turn_origin";
  const decision = decideManualQuestionTypeCorrection(
    task,
    "ai-ml-system-design"
  );

  for (const [turnId, text] of [
    ["turn_scale", "How would you scale it?"],
    ["turn_language", "In Python."],
    ["turn_qps", "Estimate QPS."],
  ]) {
    const scope = decideManualCorrectionScope({
      task,
      decision,
      lineage: makeLineage(turnId),
      latestQuestionText: text,
    });
    assert.equal(scope.scope, "current-only", text);
    assert.ok(scope.standaloneTaskScore < 3, text);
  }
});

test("preserves child retype and resume-parent scopes", () => {
  const child = makeChild({
    questionType: "field-knowledge",
    basedOnTurnIds: ["turn_child"],
  });
  const task = makeActiveTask({
    questionType: "ai-ml-system-design",
    child,
  });
  const childDecision = decideManualQuestionTypeCorrection(task, "coding");
  const resumeDecision = decideManualQuestionTypeCorrection(
    task,
    "ai-ml-system-design"
  );

  assert.equal(
    decideManualCorrectionScope({
      task,
      decision: childDecision,
      lineage: makeLineage("turn_child"),
      latestQuestionText: child.question,
    }).scope,
    "child-retype"
  );
  assert.equal(
    decideManualCorrectionScope({
      task,
      decision: resumeDecision,
      lineage: makeLineage("turn_child"),
      latestQuestionText: child.question,
      currentQuestionRelation: "resume-parent",
    }).scope,
    "resume-parent"
  );
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
    expiresAt: now + 60_000,
  });

  assert.equal(decision.target, "resume-parent");
  assert.equal(next.id, parent.id);
  assert.equal(next.stableKind, "ai-ml-system-design");
  assert.equal(next.playbookPhase, "design_framing");
  assert.equal(next.child, undefined);
  assert.equal(next.whiteboardArtifact, whiteboard);
  assert.equal(next.revisions, parent.revisions + 1);
});

test("retypes a parent in place while resetting incompatible runtime state", () => {
  const parent = makeInterviewParent({
    stableKind: "coding",
    playbookPhase: "solution_planning",
    phaseProgress: { solution_planning: true },
    supportedFactAnchors: ["old-anchor"],
    latestUsefulAnswer: "latest coding answer",
    previousUsefulAnswer: "older answer",
    whiteboardArtifact: makeWhiteboard("general_sd"),
  });
  const decision = decideManualQuestionTypeCorrection(
    makeActiveTask({ questionType: "coding" }),
    "project-deep-dive"
  );
  const playbook = makePlaybook("project-deep-dive", "project_narrative");

  const next = applyManualQuestionTypeCorrectionToParent({
    parent,
    decision,
    correctedPlaybook: playbook,
    now: now + 20,
    expiresAt: now + 60_000,
  });

  assert.equal(decision.target, "parent");
  assert.equal(next.id, parent.id);
  assert.equal(next.stableKind, "project-deep-dive");
  assert.equal(next.playbook, playbook);
  assert.equal(next.playbookPhase, "project_narrative");
  assert.deepEqual(next.phaseProgress, { project_narrative: true });
  assert.deepEqual(next.supportedFactAnchors, []);
  assert.equal(next.previousUsefulAnswer, undefined);
  assert.equal(next.latestUsefulAnswer, undefined);
  assert.equal(next.whiteboardArtifact, undefined);
});

test("preserves the whiteboard when correcting between system-design parents", () => {
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
  assert.equal(next.whiteboardArtifact, whiteboard);
});

test("preserves useful-answer continuity only across compatible system-design retypes", () => {
  const parent = makeInterviewParent({
    stableKind: "general-system-design",
    latestUsefulAnswer: "Current architecture summary",
    previousUsefulAnswer: "Requirements summary",
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

  assert.equal(next.latestUsefulAnswer, "Current architecture summary");
  assert.equal(next.previousUsefulAnswer, "Requirements summary");
});

test("keeps a same-question whiteboard draft but removes generated answer context", () => {
  const parent = makeInterviewParent({
    stableKind: "general-system-design",
    startTurnId: "turn_origin",
    latestUsefulAnswer: "Generated GSD answer",
    previousUsefulAnswer: "Earlier generated answer",
    whiteboardArtifact: makeWhiteboard("general_sd"),
  });
  const task = makeActiveTask({ questionType: "general-system-design" });
  task.parent.startTurnId = "turn_origin";
  const decision = decideManualQuestionTypeCorrection(
    task,
    "ai-ml-system-design"
  );
  const lineage = makeLineage("turn_origin");
  const scopeDecision = decideManualCorrectionScope({
    task,
    decision,
    lineage,
    latestQuestionText: "Design a RAG system for trip planning.",
  });

  const transition = buildManualCorrectionParentTransition({
    parent,
    decision,
    scopeDecision,
    correctedPlaybook: makePlaybook(
      "ai-ml-system-design",
      "requirement_clarification"
    ),
    latestQuestionText: "Design a RAG system for trip planning.",
    lineage,
    transcriptTurns: [
      makeTurn("turn_origin", "Design a RAG system for trip planning."),
    ],
    newParentId: "unused_parent_id",
  });

  assert.equal(transition.startedNewParent, false);
  assert.equal(transition.parent.id, parent.id);
  assert.equal(transition.parent.latestUsefulAnswer, undefined);
  assert.equal(transition.parent.previousUsefulAnswer, undefined);
  assert.equal(
    transition.parent.whiteboardArtifact?.questionInstanceId,
    lineage.questionInstanceId
  );
});

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
