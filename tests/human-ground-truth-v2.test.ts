import assert from "node:assert/strict";
import test from "node:test";
import {
  appendHumanGroundTruthEventV2,
  buildHumanEvaluationObservedSnapshotV2,
  buildHumanGroundTruthSubjectV2,
  createHumanGroundTruthEventV2,
  deriveHumanEvaluationProjectionV2,
  evaluateTaskSettlementTupleCompatibilityV2,
  freezeObservedTaskOwnerIdentityV2,
  importLegacyQuestionEvaluationV2,
  normalizeArtifactIntentEvaluationFamily,
  projectHumanGroundTruthEventsForSessionPurposeV2,
  resolveObservedQuestionSourceKind,
} from "../src/lib/meeting/human-ground-truth-v2.js";
import {
  buildHumanEvaluationProjectionMaterializationRevisionV2,
  canRefreshHumanEvaluationProjectionFromTraceV2,
  summarizeHumanEvaluationProjectionMaterializationV2,
} from "../src/lib/meeting/human-evaluation-projection-materialization.js";
import {
  resolveHumanEvaluationAttemptIdentityV2,
  validateHumanEvaluationAttemptSubjectV2,
} from "../src/lib/meeting/human-evaluation-attempt.js";
import { materializeHumanEvaluationAttemptProjectionV2 } from "../src/lib/meeting/human-evaluation-attempt-projection.js";
import type {
  MeetingTrace,
  QuestionHumanEvaluation,
} from "../src/lib/meeting/types.js";

const SUBJECT = {
  questionId: "question_1",
  taskId: "task_1",
  traceIds: ["trace_1"],
  sourceTurnIds: ["turn_1"],
};

function buildSettledAttemptTrace(input: {
  id: string;
  status: MeetingTrace["status"];
  questionId?: string;
  questionType?: string;
}): MeetingTrace {
  return {
    id: input.id,
    kind: "voice",
    status: input.status,
    startedAt: 1,
    steps: [],
    inputs: [],
    outputs: [],
    metadata: {
      questionInstanceId: input.questionId ?? "question_retry",
      activeMeetingTaskId: "task_retry",
      currentQuestionSettlementId: `settlement:${input.id}`,
      currentQuestionSettlementUnitId: "lqu_retry",
      currentQuestionSettlementSessionId: "session_retry",
      currentQuestionSettlementSourceHash: `hash:${input.id}`,
      effectiveCurrentQuestionSettlementMaterialized: true,
      effectiveCurrentQuestionSettlementId: `settlement:${input.id}`,
      effectiveCurrentQuestionSettlementUnitId: "lqu_retry",
      effectiveCurrentQuestionSettlementSessionId: "session_retry",
      effectiveCurrentQuestionSettlementSourceHash: `hash:${input.id}`,
      effectiveCurrentQuestionSettlementQuestionType:
        input.questionType ?? "general-system-design",
      effectiveCurrentQuestionSettlementRelation: "new-parent",
      effectiveCurrentQuestionSettlementParentMutationAuthorized: true,
      effectiveCurrentQuestionContextReadScope: "current-only",
      currentQuestionSettlementType:
        input.questionType ?? "general-system-design",
      currentQuestionSettlementRelation: "new-parent",
      currentQuestionSettlementParentMutationAuthorized: true,
      currentQuestionPreview: "Design a reliable service.",
    },
  };
}

test("creates attempt-scoped subjects after settlement identity is stable", () => {
  const trace = buildSettledAttemptTrace({
    id: "trace_attempt",
    status: "error",
  });
  assert.deepEqual(resolveHumanEvaluationAttemptIdentityV2(trace), {
    attemptId: "trace_attempt",
    sessionId: "session_retry",
    settlementId: "settlement:trace_attempt",
    logicalQuestionUnitId: "lqu_retry",
    sourceHash: "hash:trace_attempt",
  });
  assert.equal(
    buildHumanGroundTruthSubjectV2({ trace }).attemptId,
    "trace_attempt"
  );
});

test("derives question source from final settlement evidence before trace kind", () => {
  assert.equal(
    resolveObservedQuestionSourceKind("voice", {
      currentQuestionSettlementSourceTurnIds: [],
      currentQuestionSettlementSourceObservationIds: ["screen-a"],
      activeMeetingTaskSource: "mixed",
    }),
    "screen"
  );
  assert.equal(
    resolveObservedQuestionSourceKind("screen", {
      currentQuestionSettlementSourceTurnIds: ["turn-a"],
      currentQuestionSettlementSourceObservationIds: [],
    }),
    "voice"
  );
  assert.equal(
    resolveObservedQuestionSourceKind("screen", {
      currentQuestionSettlementSourceTurnIds: ["turn-a"],
      currentQuestionSettlementSourceObservationIds: ["screen-a"],
    }),
    "mixed"
  );
});

test("rejects a ground-truth subject that targets a different attempt", () => {
  assert.deepEqual(
    validateHumanEvaluationAttemptSubjectV2({
      subject: {
        attemptId: "trace_attempt_1",
        traceIds: ["trace_attempt_1"],
      },
      sourceTraceId: "trace_attempt_2",
    }),
    {
      valid: false,
      reason: "attempt-source-identity-mismatch",
    }
  );
  assert.deepEqual(
    validateHumanEvaluationAttemptSubjectV2({
      subject: {
        attemptId: "trace_attempt_1",
        traceIds: ["trace_attempt_1"],
      },
      sourceTraceId: "trace_attempt_1",
    }),
    { valid: true }
  );
});

test("keeps labels for repeated attempts on one question independent", () => {
  const firstSubject = {
    ...SUBJECT,
    attemptId: "trace_attempt_1",
  };
  const secondSubject = {
    ...SUBJECT,
    attemptId: "trace_attempt_2",
    traceIds: ["trace_attempt_2"],
  };
  const first = createHumanGroundTruthEventV2({
    eventId: "event_attempt_1",
    sessionId: "session_1",
    subject: firstSubject,
    source: "explicit-ui",
    fact: {
      kind: "expected-question-type",
      expectedQuestionType: "behavioral",
    },
    now: 1,
  });
  const second = createHumanGroundTruthEventV2({
    eventId: "event_attempt_2",
    sessionId: "session_1",
    subject: secondSubject,
    source: "explicit-ui",
    fact: {
      kind: "expected-question-type",
      expectedQuestionType: "coding",
    },
    now: 2,
  });
  const events = appendHumanGroundTruthEventV2(
    appendHumanGroundTruthEventV2([], first),
    second
  );

  const firstFact = deriveHumanEvaluationProjectionV2({
    sessionId: "session_1",
    subject: firstSubject,
    events,
  }).activeFacts["expected-question-type"]?.fact;
  const secondFact = deriveHumanEvaluationProjectionV2({
    sessionId: "session_1",
    subject: secondSubject,
    events,
  }).activeFacts["expected-question-type"]?.fact;
  assert.equal(
    firstFact?.kind === "expected-question-type"
      ? firstFact.expectedQuestionType
      : undefined,
    "behavioral"
  );
  assert.equal(
    secondFact?.kind === "expected-question-type"
      ? secondFact.expectedQuestionType
      : undefined,
    "coding"
  );
});

test("allows a correction to supersede a fact within the same attempt", () => {
  const subject = {
    ...SUBJECT,
    attemptId: "trace_attempt_1",
  };
  const first = createHumanGroundTruthEventV2({
    eventId: "event_attempt_original",
    sessionId: "session_1",
    subject,
    source: "explicit-ui",
    fact: {
      kind: "expected-question-type",
      expectedQuestionType: "behavioral",
    },
    now: 1,
  });
  const correction = createHumanGroundTruthEventV2({
    eventId: "event_attempt_correction",
    sessionId: "session_1",
    subject,
    source: "explicit-ui",
    fact: {
      kind: "expected-question-type",
      expectedQuestionType: "coding",
    },
    supersedesEventId: first.eventId,
    now: 2,
  });
  const projection = deriveHumanEvaluationProjectionV2({
    sessionId: "session_1",
    subject,
    events: [first, correction],
  });

  assert.equal(projection.conflicts.length, 0);
  assert.equal(
    projection.activeFacts["expected-question-type"]?.eventId,
    correction.eventId
  );
});

test("session scripted provenance keeps explicit labels but removes automatic correction truth", () => {
  const subject = {
    ...SUBJECT,
    attemptId: "trace_scripted",
    traceIds: ["trace_scripted"],
  };
  const automatic = createHumanGroundTruthEventV2({
    eventId: "event_scripted_correction",
    sessionId: "session_scripted",
    subject,
    source: "manual-type-correction",
    fact: {
      kind: "expected-question-type",
      expectedQuestionType: "coding",
    },
    now: 1,
  });
  const explicit = createHumanGroundTruthEventV2({
    eventId: "event_scripted_explicit",
    sessionId: "session_scripted",
    subject,
    source: "explicit-ui",
    fact: {
      kind: "answer-quality",
      outcome: "useful",
      failureReasons: [],
      expectedContextTurnIds: [],
    },
    now: 2,
  });
  const scriptedEvents =
    projectHumanGroundTruthEventsForSessionPurposeV2(
      [automatic, explicit],
      true
    );
  const scripted = deriveHumanEvaluationProjectionV2({
    sessionId: "session_scripted",
    subject,
    events: scriptedEvents,
    now: 3,
  });
  assert.equal(scripted.activeFacts["expected-question-type"], undefined);
  assert.equal(
    scripted.activeFacts["answer-quality"]?.eventId,
    explicit.eventId
  );
  assert.deepEqual(scripted.interventionOnlyEventIds, [automatic.eventId]);

  const organic = deriveHumanEvaluationProjectionV2({
    sessionId: "session_scripted",
    subject,
    events: projectHumanGroundTruthEventsForSessionPurposeV2(
      scriptedEvents,
      false
    ),
    now: 4,
  });
  assert.equal(
    organic.activeFacts["expected-question-type"]?.eventId,
    automatic.eventId
  );
});

test("materializes one projection per failed and successful retry attempt", () => {
  const failed = buildSettledAttemptTrace({
    id: "trace_retry_failed",
    status: "error",
  });
  const succeeded = buildSettledAttemptTrace({
    id: "trace_retry_success",
    status: "success",
  });
  const first = materializeHumanEvaluationAttemptProjectionV2({
    trace: failed,
    currentSessionId: "session_retry",
    events: [],
    projections: [],
    now: 2,
  });
  const second = materializeHumanEvaluationAttemptProjectionV2({
    trace: succeeded,
    currentSessionId: "session_retry",
    events: [],
    projections: first.projections,
    now: 3,
  });

  assert.equal(first.changed, true);
  assert.equal(second.changed, true);
  assert.equal(second.projections.length, 2);
  assert.deepEqual(
    second.projections.map((projection) => projection.subject.attemptId),
    ["trace_retry_failed", "trace_retry_success"]
  );
  assert.deepEqual(
    second.projections.map(
      (projection) => projection.observed?.attemptStatus
    ),
    ["error", "success"]
  );
});

test("materializes projections by semantic revision and one observed trace", () => {
  const event = createHumanGroundTruthEventV2({
    eventId: "event_projection_revision",
    sessionId: "session_1",
    subject: {
      ...SUBJECT,
      traceIds: ["trace_1", "trace_related"],
    },
    source: "explicit-ui",
    fact: {
      kind: "expected-runtime-action",
      expectedAction: "advise",
    },
    now: 1,
  });
  const first = deriveHumanEvaluationProjectionV2({
    sessionId: "session_1",
    subject: event.subject,
    events: [event],
    observed: {
      traceId: "trace_1",
      traceHash: "trace-hash-1",
      runtimeAction: "ignore",
    },
    now: 2,
  });
  const evidenceRefresh = {
    ...first,
    computedAt: 3,
    observed: {
      ...first.observed!,
      traceHash: "trace-hash-2",
    },
    inputTraceHashes: ["trace-hash-2"],
  };
  const changedFact = {
    ...evidenceRefresh,
    observed: {
      ...evidenceRefresh.observed,
      runtimeAction: "advise" as const,
    },
  };

  assert.equal(
    buildHumanEvaluationProjectionMaterializationRevisionV2(first),
    buildHumanEvaluationProjectionMaterializationRevisionV2(evidenceRefresh)
  );
  assert.notEqual(
    buildHumanEvaluationProjectionMaterializationRevisionV2(first),
    buildHumanEvaluationProjectionMaterializationRevisionV2(changedFact)
  );
  assert.equal(
    canRefreshHumanEvaluationProjectionFromTraceV2(first, "trace_1"),
    true
  );
  assert.equal(
    canRefreshHumanEvaluationProjectionFromTraceV2(
      first,
      "trace_related"
    ),
    false
  );
  assert.deepEqual(
    summarizeHumanEvaluationProjectionMaterializationV2({
      currentProjections: [changedFact],
      history: [first, evidenceRefresh, changedFact],
      groundTruthEventCount: 1,
    }),
    {
      schemaVersion: 1,
      groundTruthEventCount: 1,
      projectionAttemptCount: 3,
      projectionDeltaCount: 2,
      duplicateSuppressionCount: 0,
      uniqueProjectionCount: 1,
      supersededProjectionCount: 1,
      rawProjectionHistoryCount: 3,
      duplicateProjectionHistoryCount: 1,
    }
  );
});

test("normalizes legacy Complexity evaluation intent into the Code family", () => {
  assert.equal(
    normalizeArtifactIntentEvaluationFamily("revise-complexity"),
    "revise-code"
  );

  const legacyEvent = createHumanGroundTruthEventV2({
    eventId: "event_legacy_complexity",
    sessionId: "session_1",
    subject: SUBJECT,
    source: "imported-legacy",
    fact: {
      kind: "expected-artifact-intent",
      expectedIntent: "revise-complexity",
    },
    now: 2,
  });
  assert.deepEqual(legacyEvent.fact, {
    kind: "expected-artifact-intent",
    expectedIntent: "revise-code",
  });
});

test("compares observed Complexity mutation as part of the Code family", () => {
  const expectedCode = createHumanGroundTruthEventV2({
    eventId: "event_expected_code",
    sessionId: "session_1",
    subject: SUBJECT,
    source: "explicit-ui",
    fact: {
      kind: "expected-artifact-intent",
      expectedIntent: "revise-code",
    },
    now: 2,
  });
  const projection = deriveHumanEvaluationProjectionV2({
    sessionId: "session_1",
    subject: SUBJECT,
    events: [expectedCode],
    observed: {
      traceId: "trace_1",
      traceHash: "hash_1",
      artifactIntent: "revise-complexity",
    },
    now: 3,
  });

  assert.equal(projection.verdicts.artifactIntentCorrect, true);
});

test("validates relation and parent-action tuples before ground truth is saved", () => {
  const canonicalTuples = [
    ["new-parent", "create"],
    ["followup-parent", "preserve"],
    ["child-probe", "attach-child"],
    ["resume-parent", "resume"],
    ["logistics", "preserve"],
    ["correction", "preserve"],
    ["unknown", "none"],
    ["none", "preserve"],
  ] as const;

  for (const [relation, parentAction] of canonicalTuples) {
    assert.deepEqual(
      evaluateTaskSettlementTupleCompatibilityV2({
        relation,
        parentAction,
      }),
      {
        compatible: true,
        relation,
        parentAction,
        recommendedParentAction: parentAction,
        reason: undefined,
      }
    );
  }

  assert.deepEqual(
    evaluateTaskSettlementTupleCompatibilityV2({
      relation: "child-probe",
      parentAction: "preserve",
    }),
    {
      compatible: true,
      relation: "child-probe",
      parentAction: "preserve",
      recommendedParentAction: "attach-child",
      reason: undefined,
    }
  );

  for (const parentAction of ["preserve", "retype"] as const) {
    assert.deepEqual(
      evaluateTaskSettlementTupleCompatibilityV2({
        relation: "new-parent",
        parentAction,
      }),
      {
        compatible: true,
        relation: "new-parent",
        parentAction,
        recommendedParentAction: "create",
        reason: undefined,
      }
    );
  }
});

test("derives action and task verdicts from minimal expected facts", () => {
  const action = createHumanGroundTruthEventV2({
    eventId: "event_action",
    sessionId: "session_1",
    subject: SUBJECT,
    source: "explicit-ui",
    fact: {
      kind: "expected-runtime-action",
      expectedAction: "advise",
    },
    now: 1,
  });
  const settlement = createHumanGroundTruthEventV2({
    eventId: "event_settlement",
    sessionId: "session_1",
    subject: SUBJECT,
    source: "explicit-ui",
    fact: {
      kind: "expected-task-settlement",
      expectedQuestionType: "general-system-design",
      expectedRelation: "new-parent",
      expectedParentAction: "create",
    },
    interaction: {
      startedAt: 1,
      durationMs: 1,
      clickCount: 3,
      expandedRegions: ["human-evaluation", "expert-audit"],
    },
    now: 2,
  });
  const contextScope = createHumanGroundTruthEventV2({
    eventId: "event_context_scope",
    sessionId: "session_1",
    subject: SUBJECT,
    source: "explicit-ui",
    fact: {
      kind: "expected-context-read-scope",
      expectedScope: "active-parent-read",
    },
    now: 2,
  });
  const artifactIntent = createHumanGroundTruthEventV2({
    eventId: "event_artifact_intent",
    sessionId: "session_1",
    subject: SUBJECT,
    source: "explicit-ui",
    fact: {
      kind: "expected-artifact-intent",
      expectedIntent: "revise-whiteboard",
    },
    now: 2,
  });

  const projection = deriveHumanEvaluationProjectionV2({
    sessionId: "session_1",
    subject: SUBJECT,
    events: [action, settlement, contextScope, artifactIntent],
    observed: {
      traceId: "trace_1",
      traceHash: "hash_1",
      runtimeAction: "advise",
      questionType: "general-system-design",
      relation: "new-parent",
      parentAction: "create",
      contextReadScope: "active-parent-read",
      artifactIntent: "revise-whiteboard",
    },
    now: 3,
  });

  assert.equal(projection.verdicts.runtimeActionCorrect, true);
  assert.equal(projection.verdicts.questionTypeCorrect, true);
  assert.equal(projection.verdicts.relationCorrect, true);
  assert.equal(projection.verdicts.parentActionCorrect, true);
  assert.equal(projection.verdicts.contextReadScopeCorrect, true);
  assert.equal(projection.verdicts.artifactIntentCorrect, true);
  assert.equal(
    projection.observed?.contextReadScope,
    "active-parent-read"
  );
  assert.deepEqual(projection.inputEventIds, [
    "event_action",
    "event_settlement",
    "event_context_scope",
    "event_artifact_intent",
  ]);
  assert.deepEqual(projection.inputTraceHashes, ["hash_1"]);
  assert.deepEqual(projection.interaction, {
    startedAt: 1,
    durationMs: 1,
    clickCount: 3,
    expandedRegions: ["human-evaluation", "expert-audit"],
  });
});

test("does not turn missing expected facts into successful verdicts", () => {
  const projection = deriveHumanEvaluationProjectionV2({
    sessionId: "session_1",
    subject: SUBJECT,
    events: [],
    observed: {
      traceId: "trace_1",
      traceHash: "hash_1",
      runtimeAction: "advise",
      questionType: "coding",
      relation: "new-parent",
      parentAction: "create",
    },
  });

  assert.equal(projection.verdicts.runtimeActionCorrect, undefined);
  assert.equal(projection.verdicts.questionTypeCorrect, undefined);
  assert.equal(projection.verdicts.relationCorrect, undefined);
  assert.equal(projection.verdicts.parentActionCorrect, undefined);
});

test("scores metadata proposals separately from the effective target company", () => {
  const expected = createHumanGroundTruthEventV2({
    eventId: "event_expected_company",
    sessionId: "session_1",
    subject: SUBJECT,
    source: "explicit-ui",
    fact: {
      kind: "expected-meeting-metadata",
      sourceCompany: "Amazon",
      expectedEffectiveCompany: "Amazon",
      expectedMutationDisposition: "preserve",
      errorKind: "wrong-target-company",
    },
    now: 2,
  });
  const projection = deriveHumanEvaluationProjectionV2({
    sessionId: "session_1",
    subject: SUBJECT,
    events: [expected],
    observed: {
      traceId: "trace_1",
      traceHash: "hash_1",
      meetingMetadata: {
        operationObserved: true,
        mutationOutcome: "preserve",
        proposalCompany: "Google",
        authoritativeCompany: "Amazon",
        effectiveCompany: "Amazon",
        authoritySource: "brief",
        overrideOccurred: false,
      },
    },
    now: 3,
  });

  assert.equal(projection.verdicts.meetingMetadataProposalCorrect, false);
  assert.equal(projection.verdicts.meetingMetadataTargetCorrect, true);
  assert.equal(projection.verdicts.meetingMetadataMutationCorrect, true);
});

test("treats an explicit unknown company label as valid ground truth", () => {
  const expectedUnknown = createHumanGroundTruthEventV2({
    eventId: "event_expected_unknown_company",
    sessionId: "session_1",
    subject: SUBJECT,
    source: "explicit-ui",
    fact: {
      kind: "expected-meeting-metadata",
      sourceCompany: null,
      expectedEffectiveCompany: null,
      expectedMutationDisposition: "abstain",
    },
    now: 2,
  });
  const projection = deriveHumanEvaluationProjectionV2({
    sessionId: "session_1",
    subject: SUBJECT,
    events: [expectedUnknown],
    observed: {
      traceId: "trace_1",
      traceHash: "hash_1",
      meetingMetadata: {
        operationObserved: true,
        disposition: "shadow-observed",
        mutationOutcome: "abstain",
        overrideOccurred: false,
      },
    },
    now: 3,
  });

  assert.equal(projection.verdicts.meetingMetadataProposalCorrect, true);
  assert.equal(projection.verdicts.meetingMetadataTargetCorrect, true);
  assert.equal(projection.verdicts.meetingMetadataMutationCorrect, true);
});

test("retains same-priority conflicts until an explicit superseding event", () => {
  const first = createHumanGroundTruthEventV2({
    eventId: "event_first",
    sessionId: "session_1",
    subject: SUBJECT,
    source: "explicit-ui",
    fact: {
      kind: "expected-runtime-action",
      expectedAction: "advise",
    },
    now: 1,
  });
  const conflicting = createHumanGroundTruthEventV2({
    eventId: "event_conflicting",
    sessionId: "session_1",
    subject: SUBJECT,
    source: "explicit-ui",
    fact: {
      kind: "expected-runtime-action",
      expectedAction: "ignore",
    },
    now: 2,
  });
  const conflicted = deriveHumanEvaluationProjectionV2({
    sessionId: "session_1",
    subject: SUBJECT,
    events: [first, conflicting],
  });
  assert.equal(conflicted.conflicts.length, 1);
  assert.equal(
    conflicted.activeFacts["expected-runtime-action"],
    undefined
  );

  const replacement = createHumanGroundTruthEventV2({
    eventId: "event_replacement",
    sessionId: "session_1",
    subject: SUBJECT,
    source: "explicit-ui",
    fact: {
      kind: "expected-runtime-action",
      expectedAction: "ignore",
    },
    supersedesEventId: first.eventId,
    now: 3,
  });
  const resolved = deriveHumanEvaluationProjectionV2({
    sessionId: "session_1",
    subject: SUBJECT,
    events: [first, replacement],
  });
  assert.equal(resolved.conflicts.length, 0);
  assert.equal(
    resolved.activeFacts["expected-runtime-action"]?.eventId,
    "event_replacement"
  );
});

test("deduplicates action-derived facts without rewriting history", () => {
  const event = createHumanGroundTruthEventV2({
    eventId: "event_force_advise",
    sessionId: "session_1",
    subject: SUBJECT,
    source: "manual-force-advise",
    actionId: "force_advise_1",
    fact: {
      kind: "expected-runtime-action",
      expectedAction: "advise",
    },
  });
  const once = appendHumanGroundTruthEventV2([], event);
  const twice = appendHumanGroundTruthEventV2(once, {
    ...event,
    eventId: "event_force_advise_duplicate",
  });
  assert.equal(twice.length, 1);
});

test("keeps scripted intervention evidence out of semantic projection facts", () => {
  const scriptedForceAdvise = createHumanGroundTruthEventV2({
    eventId: "event_scripted_force_advise",
    sessionId: "session_1",
    subject: SUBJECT,
    source: "manual-force-advise",
    collection: "scripted-validation",
    fact: {
      kind: "expected-runtime-action",
      expectedAction: "advise",
    },
    evaluationTarget: {
      questionId: "question_1",
      taskId: "task_1",
      logicalQuestionUnitId: "lqu_1",
      logicalQuestionUnitRevision: 3,
      currentTurnId: "turn_1",
      sourceTurnIds: ["turn_1"],
      sourceTraceId: "trace_1",
      repairTraceId: "trace_repair",
      frozenAt: 10,
    },
    now: 10,
  });
  const projection = deriveHumanEvaluationProjectionV2({
    sessionId: "session_1",
    subject: SUBJECT,
    events: [scriptedForceAdvise],
    now: 11,
  });

  assert.equal(
    projection.activeFacts["expected-runtime-action"],
    undefined
  );
  assert.deepEqual(projection.semanticInputEventIds, []);
  assert.deepEqual(projection.interventionOnlyEventIds, [
    "event_scripted_force_advise",
  ]);
  assert.deepEqual(
    scriptedForceAdvise.provenance.evaluationTarget,
    {
      questionId: "question_1",
      taskId: "task_1",
      logicalQuestionUnitId: "lqu_1",
      logicalQuestionUnitRevision: 3,
      currentTurnId: "turn_1",
      sourceTurnIds: ["turn_1"],
      sourceTraceId: "trace_1",
      repairTraceId: "trace_repair",
      frozenAt: 10,
    }
  );
});

test("allows an explicit semantic label in a scripted validation session", () => {
  const explicitLabel = createHumanGroundTruthEventV2({
    eventId: "event_scripted_explicit_label",
    sessionId: "session_1",
    subject: SUBJECT,
    source: "explicit-ui",
    collection: "scripted-validation",
    fact: {
      kind: "expected-runtime-action",
      expectedAction: "ignore",
    },
    now: 12,
  });
  const projection = deriveHumanEvaluationProjectionV2({
    sessionId: "session_1",
    subject: SUBJECT,
    events: [explicitLabel],
    now: 13,
  });

  assert.equal(
    projection.activeFacts["expected-runtime-action"]?.eventId,
    explicitLabel.eventId
  );
  assert.deepEqual(projection.semanticInputEventIds, [explicitLabel.eventId]);
  assert.deepEqual(projection.interventionOnlyEventIds, []);
});

test("imports only exact legacy expectations", () => {
  const legacy = createLegacyEvaluation({
    correctedQuestionType: "coding",
    expectedRelation: "new-parent",
    expectedParentAction: "create",
    advisorIntent: {
      schemaVersion: 1,
      verdict: "false-negative",
      expectedAction: "advise",
      observedAction: "suppressed",
      source: "manual-force-advise",
      originalTraceId: "trace_1",
      sourceTurnIds: ["turn_1"],
      createdAt: 1,
      updatedAt: 1,
    },
    answer: {
      verdict: "partial",
      reasons: ["missing-context"],
    },
  });

  const imported = importLegacyQuestionEvaluationV2(legacy, "session_1");
  assert.deepEqual(
    imported.map((event) => event.fact.kind),
    [
      "expected-runtime-action",
      "expected-task-settlement",
      "answer-quality",
    ]
  );
  assert.ok(
    imported.every(
      (event) => event.provenance.source === "imported-legacy"
    )
  );
  assert.ok(
    imported.every((event) => event.provenance.collection === "replay")
  );
});

test("maps a legacy company label only to expected effective company", () => {
  const imported = importLegacyQuestionEvaluationV2(
    createLegacyEvaluation({ correctedCompany: "Amazon" }),
    "session_1"
  );
  const fact = imported.find(
    (event) => event.fact.kind === "expected-meeting-metadata"
  )?.fact;

  assert.deepEqual(fact, {
    kind: "expected-meeting-metadata",
    expectedEffectiveCompany: "Amazon",
  });
});

test("projects the observed runtime tuple from trace metadata", () => {
  const trace = {
    id: "trace_1",
    kind: "voice",
    status: "success",
    startedAt: 1,
    steps: [],
    inputs: [],
    outputs: [],
    metadata: {
      currentQuestionSettlementType: "ai-ml-system-design",
      currentQuestionSettlementRelation: "child-probe",
      currentQuestionSettlementParentMutationAuthorized: true,
      advisorExecutionAuthorized: false,
      turnGateAction: "append-only",
      questionTypeAdjudicationOutcomeOperationId: "operation-a",
      questionTypeAdjudicationOutcomeDisposition: "visible-committed",
      questionTypeAdjudicationOutcomeVisibleCommitted: true,
      advisorOutputCommittedToUi: true,
      primaryAskNormalizedText: "How would retrieval work?",
      settledExecutionPlanContextReadScope: "active-parent-read",
      settledExecutionPlanArtifactIntent: "revise-whiteboard",
    },
  } as MeetingTrace;
  const observed = buildHumanEvaluationObservedSnapshotV2(trace);
  assert.equal(observed.questionType, "ai-ml-system-design");
  assert.equal(observed.relation, "child-probe");
  assert.equal(observed.parentAction, "attach-child");
  assert.equal(observed.runtimeAction, "advise");
  assert.equal(observed.runtimeOperationId, "operation-a");
  assert.equal(observed.advisorOutcome, "visible-committed");
  assert.equal(observed.contextReadScope, "active-parent-read");
  assert.equal(observed.artifactIntent, "revise-whiteboard");
  assert.match(observed.traceHash, /^\d+:[0-9a-f]+$/);
});

test("projects only a same-parent cross-type replacement as retype", () => {
  const trace = buildSettledAttemptTrace({
    id: "trace_parent_retype",
    status: "success",
    questionType: "ai-ml-system-design",
  });
  trace.metadata = {
    ...trace.metadata,
    effectiveCurrentQuestionSettlementRelation: "new-parent",
    effectiveCurrentQuestionSettlementParentMutationAuthorized: true,
    settledExecutionPlanTaskMutationCommand: "replace-parent",
    taskLifecycleParentBeforeId: "parent-system-design",
    taskLifecycleParentAfterId: "parent-system-design",
    taskLifecycleParentBeforeType: "general-system-design",
    taskLifecycleParentAfterType: "ai-ml-system-design",
  };

  assert.equal(
    buildHumanEvaluationObservedSnapshotV2(trace).parentAction,
    "retype"
  );

  trace.metadata.taskLifecycleParentAfterId = "parent-new-question";
  assert.equal(
    buildHumanEvaluationObservedSnapshotV2(trace).parentAction,
    "create"
  );
});

test("prefers a committed source transition over provisional parent authorization", () => {
  const trace = buildSettledAttemptTrace({
    id: "trace_committed_resume",
    status: "success",
    questionType: "general-system-design",
  });
  trace.metadata = {
    ...trace.metadata,
    effectiveCurrentQuestionSettlementRelation: "resume-parent",
    effectiveCurrentQuestionSettlementParentMutationAuthorized: false,
    settledExecutionPlanTaskMutationCommand: "preserve",
    sourceTransitionRuntimeKind: "resume-parent",
    sourceTransitionDurableAuthorized: true,
    sourceTransitionDurableMutationApplied: true,
    sourceTransitionParentBeforeId: "parent-design",
    sourceTransitionParentAfterId: "parent-design",
    sourceTransitionChildBeforeId: "child-field",
  };

  assert.equal(
    buildHumanEvaluationObservedSnapshotV2(trace).parentAction,
    "resume"
  );

  trace.metadata.sourceTransitionDurableMutationApplied = false;
  assert.equal(
    buildHumanEvaluationObservedSnapshotV2(trace).parentAction,
    "preserve"
  );
});

test("uses the effective settlement while retaining raw abstention diagnostics", () => {
  const trace = buildSettledAttemptTrace({
    id: "trace_effective_followup",
    status: "success",
    questionType: "project-deep-dive",
  });
  trace.metadata = {
    ...trace.metadata,
    currentQuestionSettlementType: "unknown",
    currentQuestionSettlementRelation: "unknown",
    currentQuestionSettlementParentMutationAuthorized: false,
    effectiveCurrentQuestionSettlementQuestionType: "project-deep-dive",
    effectiveCurrentQuestionSettlementRelation: "followup-parent",
    effectiveCurrentQuestionSettlementParentMutationAuthorized: false,
    effectiveCurrentQuestionContextReadScope: "active-parent-read",
  };

  const observed = buildHumanEvaluationObservedSnapshotV2(trace);
  assert.equal(observed.questionType, "project-deep-dive");
  assert.equal(observed.relation, "followup-parent");
  assert.equal(observed.parentAction, "preserve");
  assert.equal(observed.contextReadScope, "active-parent-read");
});

test("projects current-only execution as parent preservation without borrowing an owner", () => {
  const trace = buildSettledAttemptTrace({
    id: "trace_current_only",
    status: "success",
    questionType: "behavioral",
  });
  trace.metadata = {
    ...trace.metadata,
    effectiveCurrentQuestionSettlementQuestionType: "behavioral",
    effectiveCurrentQuestionSettlementRelation: "unknown",
    effectiveCurrentQuestionSettlementParentMutationAuthorized: false,
    effectiveAdvisorCurrentOnly: true,
    effectiveCurrentQuestionContextReadScope: "current-only",
    settledExecutionPlanTaskMutationCommand: "preserve",
    activeMeetingParentId: "parent_coding",
  };

  const observed = buildHumanEvaluationObservedSnapshotV2(trace);
  assert.equal(observed.questionType, "behavioral");
  assert.equal(observed.relation, "none");
  assert.equal(observed.parentAction, "preserve");
  assert.equal(observed.settledParentId, undefined);
  assert.equal(observed.settledChildId, undefined);
  assert.equal(observed.contextReadScope, "current-only");
});

test("derives question source identity from committed evidence, not a stale label", () => {
  const trace = buildSettledAttemptTrace({
    id: "trace_voice_source",
    status: "success",
    questionType: "general-system-design",
  });
  trace.metadata = {
    ...trace.metadata,
    currentQuestionSettlementSourceKind: "screen",
    settledExecutionPlanSourceTurnIds: ["turn_voice_1"],
    settledExecutionPlanSourceObservationIds: [],
  };
  assert.equal(
    buildHumanEvaluationObservedSnapshotV2(trace).questionSourceKind,
    "voice"
  );

  trace.metadata = {
    ...trace.metadata,
    settledExecutionPlanSourceObservationIds: ["observation_1"],
  };
  assert.equal(
    buildHumanEvaluationObservedSnapshotV2(trace).questionSourceKind,
    "mixed"
  );
});

test("does not pass settlement when relation is right but parent owner is wrong", () => {
  const trace = buildSettledAttemptTrace({
    id: "trace_wrong_parent",
    status: "success",
    questionType: "behavioral",
  });
  trace.metadata = {
    ...trace.metadata,
    effectiveCurrentQuestionSettlementRelation: "followup-parent",
    effectiveCurrentQuestionSettlementParentMutationAuthorized: false,
    effectiveCurrentQuestionSettlementParentId: "parent_coding",
    effectiveCurrentQuestionContextReadScope: "active-parent-read",
  };
  const observed = buildHumanEvaluationObservedSnapshotV2(trace);
  const event = createHumanGroundTruthEventV2({
    sessionId: "session_retry",
    subject: SUBJECT,
    source: "explicit-ui",
    fact: {
      kind: "expected-task-settlement",
      expectedQuestionType: "behavioral",
      expectedRelation: "followup-parent",
      expectedParentAction: "preserve",
      expectedParentId: "parent_behavioral",
      expectedBranchId: "parent_behavioral",
      expectedContextOwnerId: "parent_behavioral",
    },
  });
  const projection = deriveHumanEvaluationProjectionV2({
    sessionId: "session_retry",
    subject: SUBJECT,
    events: [event],
    observed,
  });

  assert.equal(projection.verdicts.relationCorrect, true);
  assert.equal(projection.verdicts.parentActionCorrect, true);
  assert.equal(projection.verdicts.parentIdentityCorrect, false);
  assert.equal(projection.verdicts.branchIdentityCorrect, false);
  assert.equal(projection.verdicts.contextOwnerCorrect, false);
  assert.equal(projection.verdicts.taskSettlementCorrect, false);
});

test("freezes owner identity when the user confirms the observed settlement", () => {
  assert.deepEqual(
    freezeObservedTaskOwnerIdentityV2({
      traceId: "trace_1",
      traceHash: "hash_1",
      settledParentId: "parent_1",
      settledBranchId: "child_1",
      contextOwnerId: "child_1",
    }),
    {
      expectedParentId: "parent_1",
      expectedBranchId: "child_1",
      expectedContextOwnerId: "child_1",
    }
  );
});

test("delays attempt materialization until an effective settlement exists", () => {
  const trace = buildSettledAttemptTrace({
    id: "trace_raw_only",
    status: "running",
  });
  delete trace.metadata?.effectiveCurrentQuestionSettlementId;
  delete trace.metadata?.effectiveCurrentQuestionSettlementUnitId;
  delete trace.metadata?.effectiveCurrentQuestionSettlementSessionId;
  delete trace.metadata?.effectiveCurrentQuestionSettlementSourceHash;

  const result = materializeHumanEvaluationAttemptProjectionV2({
    trace,
    currentSessionId: "session_retry",
    events: [],
    projections: [],
  });
  assert.equal(result.changed, false);
  assert.equal(result.reason, "settlement-incomplete");
  assert.equal(result.projection, undefined);
});

test("projects committed screen response-only scope and code mutation", () => {
  const trace = {
    id: "trace_screen_code",
    kind: "screen",
    status: "success",
    startedAt: 1,
    steps: [],
    inputs: [],
    outputs: [],
    metadata: {
      screenOutputCommittedToUi: true,
      responseOnlyContextReadScope: "active-parent-read",
      previousCodeRevision: 3,
      nextCodeRevision: 4,
      previousComplexityRevision: 2,
      nextComplexityRevision: 2,
    },
  } as MeetingTrace;

  const observed = buildHumanEvaluationObservedSnapshotV2(trace);

  assert.equal(observed.runtimeAction, "advise");
  assert.equal(observed.advisorOutcome, "visible-committed");
  assert.equal(observed.contextReadScope, "active-parent-read");
  assert.equal(observed.artifactIntent, "revise-code");
});

test("projects a committed screen answer with unchanged artifacts as preserve", () => {
  const trace = {
    id: "trace_screen_preserve",
    kind: "screen",
    status: "success",
    startedAt: 1,
    steps: [],
    inputs: [],
    outputs: [],
    metadata: {
      advisorOutputCommittedToUi: true,
      previousCodeRevision: 4,
      nextCodeRevision: 4,
      previousComplexityRevision: 2,
      nextComplexityRevision: 2,
      answerWhiteboardArtifactDecision: "preserved",
    },
  } as MeetingTrace;

  const observed = buildHumanEvaluationObservedSnapshotV2(trace);

  assert.equal(observed.contextReadScope, "current-only");
  assert.equal(observed.artifactIntent, "preserve");
});

test("does not treat code lifecycle reset as a code mutation", () => {
  for (const [previousCodeRevision, nextCodeRevision] of [
    [1, 0],
    [undefined, 0],
  ] as const) {
    const trace = {
      id: `trace_screen_reset_${String(previousCodeRevision)}`,
      kind: "screen",
      status: "success",
      startedAt: 1,
      steps: [],
      inputs: [],
      outputs: [],
      metadata: {
        advisorOutputCommittedToUi: true,
        committedArtifacts: ["answer"],
        candidateMutatedArtifacts: ["answer"],
        lifecycleResetArtifacts: ["code", "complexity"],
        previousCodeRevision,
        nextCodeRevision,
      },
    } as MeetingTrace;

    assert.equal(
      buildHumanEvaluationObservedSnapshotV2(trace).artifactIntent,
      "preserve"
    );
  }
});

test("uses explicit committed code evidence before revision heuristics", () => {
  const trace = {
    id: "trace_screen_explicit_code",
    kind: "screen",
    status: "success",
    startedAt: 1,
    steps: [],
    inputs: [],
    outputs: [],
    metadata: {
      advisorOutputCommittedToUi: true,
      committedArtifacts: ["answer", "code"],
      previousCodeRevision: 0,
      nextCodeRevision: 0,
    },
  } as MeetingTrace;

  assert.equal(
    buildHumanEvaluationObservedSnapshotV2(trace).artifactIntent,
    "revise-code"
  );
});

test("projects actual Voice Artifact authority instead of the broader playbook plan", () => {
  const samePhase = {
    id: "trace_voice_same_phase",
    kind: "voice",
    status: "success",
    startedAt: 1,
    steps: [],
    inputs: [],
    outputs: [],
    metadata: {
      advisorOutputCommittedToUi: true,
      settledExecutionPlanArtifactIntent: "revise-whiteboard",
      advisorArtifactGenerationAnswerOnly: true,
      candidateMutatedArtifacts: ["answer"],
    },
  } as MeetingTrace;
  const artifactOnly = {
    ...samePhase,
    id: "trace_voice_artifact_only",
    metadata: {
      advisorOutputCommittedToUi: true,
      settledExecutionPlanArtifactIntent: "preserve",
      artifactOnlyMutatedArtifacts: ["whiteboard"],
    },
  } as MeetingTrace;

  assert.equal(
    buildHumanEvaluationObservedSnapshotV2(samePhase).artifactIntent,
    "preserve"
  );
  assert.equal(
    buildHumanEvaluationObservedSnapshotV2(artifactOnly).artifactIntent,
    "revise-whiteboard"
  );
});

test("projects a committed screen whiteboard update from the actual decision", () => {
  const trace = {
    id: "trace_screen_whiteboard",
    kind: "screen",
    status: "success",
    startedAt: 1,
    steps: [],
    inputs: [],
    outputs: [],
    metadata: {
      advisorOutputCommittedToUi: true,
      answerWhiteboardArtifactDecision: "updated",
    },
  } as MeetingTrace;

  const observed = buildHumanEvaluationObservedSnapshotV2(trace);

  assert.equal(observed.artifactIntent, "revise-whiteboard");
});

test("separates the current-question winner from an unresolved durable parent", () => {
  const trace = {
    id: "trace_response_only_parent",
    kind: "voice",
    status: "success",
    startedAt: 1,
    steps: [],
    inputs: [],
    outputs: [],
    metadata: {
      currentQuestionSettlementId: "settlement_1",
      currentQuestionSettlementType: "general-system-design",
      currentQuestionSettlementTypeAuthoritySource: "llm-type-repair",
      currentQuestionSettlementRelation: "new-parent",
      currentQuestionSettlementParentMutationAuthorized: false,
      currentQuestionSettlementParentAfterId: "parent_unknown",
      currentQuestionSettlementParentAfterType: "unknown",
      currentQuestionSettlementAppliedToResponse: true,
      currentQuestionSettlementAppliedToSettlement: true,
      currentQuestionSettlementAppliedToParent: false,
    },
  } as MeetingTrace;

  const observed = buildHumanEvaluationObservedSnapshotV2(trace);

  assert.equal(observed.questionType, "general-system-design");
  assert.equal(
    observed.observedCurrentQuestionType,
    "general-system-design"
  );
  assert.equal(
    observed.observedCurrentQuestionTypeAuthority,
    "runtime-adjudication"
  );
  assert.equal(observed.observedParentId, "parent_unknown");
  assert.equal(observed.observedParentType, "unknown");
  assert.equal(observed.typeAppliedToResponse, true);
  assert.equal(observed.typeAppliedToSettlement, true);
  assert.equal(observed.typeAppliedToParent, false);
  assert.equal(observed.durableOwnerMissing, true);
  assert.equal(
    observed.durableOwnerMissingReason,
    "durable-parent-type-unknown"
  );
});

test("does not treat an authorized child type as a missing durable parent", () => {
  const trace = {
    id: "trace_child_type",
    kind: "voice",
    status: "success",
    startedAt: 1,
    steps: [],
    inputs: [],
    outputs: [],
    metadata: {
      currentQuestionSettlementId: "settlement_child",
      currentQuestionSettlementType: "field-knowledge",
      currentQuestionSettlementRelation: "child-probe",
      currentQuestionSettlementParentAfterId: "parent_ml",
      currentQuestionSettlementParentAfterType: "ai-ml-system-design",
      currentQuestionSettlementAppliedToResponse: true,
      currentQuestionSettlementAppliedToSettlement: true,
      currentQuestionSettlementAppliedToParent: false,
    },
  } as MeetingTrace;

  const observed = buildHumanEvaluationObservedSnapshotV2(trace);

  assert.equal(observed.observedCurrentQuestionType, "field-knowledge");
  assert.equal(observed.observedParentType, "ai-ml-system-design");
  assert.equal(observed.durableOwnerMissing, false);
  assert.equal(observed.durableOwnerMissingReason, undefined);
});

test("projects type-prior and committed-consumer coherence without another manual label", () => {
  const trace = {
    id: "trace_type_consumer",
    kind: "voice",
    status: "success",
    startedAt: 1,
    steps: [],
    inputs: [],
    outputs: [],
    metadata: {
      currentQuestionSettlementType: "behavioral",
      committedCurrentQuestionType: "behavioral",
      responseOwnerQuestionType: "behavioral",
      responsePlaybookQuestionType: "behavioral",
      kmbPolicyQuestionType: "behavioral",
      kmbPolicyFamilies: ["behavioral"],
      factAnchorPolicyQuestionType: "behavioral",
      modelRouteQuestionType: "behavioral",
      answerProfileQuestionType: "behavioral",
      artifactPolicyQuestionType: "behavioral",
      promptContractQuestionType: "behavioral",
      questionTypePriorSource: "preparation-snapshot",
      questionTypePriorSourceId: "snapshot-1:question-type-prior",
      questionTypePriorRawTypes: ["coding", "personal-logistics"],
      questionTypePriorExpectedTypePolicy: "restricted",
      priorCompatibility: "conflict",
      priorUsedAsExecutionGate: false,
      questionTypeConsumerConflicts: ["prior-vs-committed"],
      questionTypeConsumerCoherent: false,
    },
  } as MeetingTrace;

  const observed = buildHumanEvaluationObservedSnapshotV2(trace);

  assert.deepEqual(observed.questionTypeConsumer?.prior?.canonicalTypes, [
    "coding",
  ]);
  assert.deepEqual(observed.questionTypeConsumer?.prior?.policyOnlyTypes, [
    "personal-logistics",
  ]);
  assert.equal(
    observed.questionTypeConsumer?.committedCurrentQuestionType,
    "behavioral"
  );
  assert.equal(observed.questionTypeConsumer?.priorCompatibility, "conflict");
  assert.equal(observed.questionTypeConsumer?.priorUsedAsExecutionGate, false);
  assert.deepEqual(observed.questionTypeConsumer?.conflicts, [
    "prior-vs-committed",
  ]);
});

function createLegacyEvaluation(
  patch: Partial<QuestionHumanEvaluation>
): QuestionHumanEvaluation {
  const verdict = { verdict: "not_applicable" as const, reasons: [] };
  return {
    id: "legacy_eval_1",
    sessionId: "session_1",
    questionId: "question_1",
    traceIds: ["trace_1"],
    selectedDiagramOverlayIds: [],
    classification: verdict,
    playbook: verdict,
    playbookPhase: verdict,
    memory: verdict,
    whiteboard: verdict,
    manualPhaseTransition: verdict,
    diagramOverlay: verdict,
    guardrail: verdict,
    answer: verdict,
    memoryEntryLabels: [],
    missingExpectedMemory: [],
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}
