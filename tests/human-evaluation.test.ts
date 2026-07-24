import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAdvisorIntentEvaluationFromTrace,
  buildQuestionEvaluationPatchFromTrace,
  resolveSuggestionQuestionLineage,
  resolveVisibleAnswerEvaluationTarget,
  upsertQuestionHumanEvaluation,
} from "../src/lib/meeting/human-evaluation.js";
import type {
  AdvisorSuggestion,
  MeetingTrace,
  TraceHumanEvaluation,
} from "../src/lib/meeting/types.js";

function buildSuggestion(
  id: string,
  sourceTraceId?: string
): AdvisorSuggestion {
  return {
    id,
    sourceTraceId,
    kind: "answer",
    content: "Answer: Use a queue.",
    createdAt: 1,
    basedOnTurnIds: [],
    basedOnObservationIds: [],
    confidence: "medium",
  };
}

test("binds evaluation to the visible answer instead of a newer trace", () => {
  assert.deepEqual(
    resolveVisibleAnswerEvaluationTarget({
      suggestion: buildSuggestion("suggestion_1", "trace_answer"),
      traces: [{ id: "trace_stt" }, { id: "trace_answer" }],
      latestTraceId: "trace_stt",
    }),
    {
      status: "ready",
      traceId: "trace_answer",
      reason: "visible-answer-source",
    }
  );
});

test("does not evaluate an old trace while a partial answer is visible", () => {
  assert.deepEqual(
    resolveVisibleAnswerEvaluationTarget({
      suggestion: buildSuggestion("suggestion_1", "trace_old"),
      answerInProgress: true,
      traces: [{ id: "trace_running" }, { id: "trace_old" }],
      latestTraceId: "trace_running",
    }),
    {
      status: "pending",
      reason: "partial-answer-in-progress",
    }
  );
});

test("does not fall back when the visible answer trace is unavailable", () => {
  assert.deepEqual(
    resolveVisibleAnswerEvaluationTarget({
      suggestion: buildSuggestion("suggestion_1", "trace_missing"),
      traces: [{ id: "trace_latest" }],
      latestTraceId: "trace_latest",
    }),
    {
      status: "unavailable",
      traceId: "trace_missing",
      reason: "suggestion-source-trace-missing",
    }
  );
});

test("preserves question lineage across chained answer actions", () => {
  assert.deepEqual(
    resolveSuggestionQuestionLineage({
      suggestion: buildSuggestion("suggestion_action", "trace_action"),
      traces: [
        {
          id: "trace_action",
          metadata: {
            questionInstanceId: "trace:trace_origin",
            questionOriginTraceId: "trace_origin",
          },
        },
      ],
    }),
    {
      questionInstanceId: "trace:trace_origin",
      questionOriginTraceId: "trace_origin",
      sourceSuggestionId: "suggestion_action",
    }
  );

  assert.deepEqual(
    resolveSuggestionQuestionLineage({
      suggestion: buildSuggestion("suggestion_origin", "trace_origin"),
      traces: [{ id: "trace_origin" }],
    }),
    {
      questionInstanceId: "trace:trace_origin",
      questionOriginTraceId: "trace_origin",
      sourceSuggestionId: "suggestion_origin",
    }
  );
});

test("keeps meaningful questions separate within one parent trajectory", () => {
  const first = upsertQuestionHumanEvaluation(
    [],
    {
      sessionId: "session_1",
      traceId: "trace_1",
      traceKind: "screen",
      taskId: "task_1",
      parentTaskId: "parent_1",
      taskSource: "screen",
      questionType: "behavioral",
      company: "Amazon",
      playbookId: "behavioral_story",
      playbookPhase: "story_selection",
    },
    {
      guardrail: { verdict: "ok", reasons: ["confirmed"] },
    }
  );

  const separated = upsertQuestionHumanEvaluation(
    first,
    {
      sessionId: "session_1",
      traceId: "trace_2",
      traceKind: "voice",
      taskId: "task_1",
      parentTaskId: "parent_1",
      taskSource: "mixed",
      questionType: "behavioral",
    },
    {
      memoryEntryLabels: [
        {
          memoryId: "mem_aos_cleanup",
          title: "AOS cleanup",
          label: "relevant",
        },
      ],
    }
  );

  assert.equal(separated.length, 2);
  assert.equal(separated[0].questionId, "trace:trace_1");
  assert.equal(separated[1].questionId, "trace:trace_2");
  assert.deepEqual(separated[0].traceIds, ["trace_1"]);
  assert.deepEqual(separated[1].traceIds, ["trace_2"]);
  assert.equal(separated[0].detectedPlaybookPhase, "story_selection");
  assert.equal(separated[0].guardrail.verdict, "ok");
  assert.equal(separated[1].memoryEntryLabels.length, 1);
  assert.equal(separated[1].memoryEntryLabels[0].memoryId, "mem_aos_cleanup");
  assert.equal(separated[1].memoryEntryLabels[0].title, "AOS cleanup");
  assert.equal(separated[1].memoryEntryLabels[0].label, "relevant");
});

test("preserves a legacy parent-scoped record when its trace is relabeled", () => {
  const existing = upsertQuestionHumanEvaluation(
    [],
    {
      traceId: "trace_legacy",
      traceKind: "voice",
      parentTaskId: "parent_legacy",
    },
    { questionId: "parent_legacy" }
  );

  const updated = upsertQuestionHumanEvaluation(
    existing,
    {
      traceId: "trace_legacy",
      traceKind: "voice",
      parentTaskId: "parent_legacy",
    },
    { answer: { verdict: "ok", reasons: ["confirmed"] } }
  );

  assert.equal(updated.length, 1);
  assert.equal(updated[0].questionId, "parent_legacy");
  assert.equal(updated[0].answer.verdict, "ok");
});

test("merges question-level LLM taxonomy adjudication labels", () => {
  const first = upsertQuestionHumanEvaluation(
    [],
    {
      traceId: "trace_adjudication",
      traceKind: "voice",
      questionId: "question_adjudication",
    },
    {
      taxonomyAdjudication: {
        needed: true,
        typeCorrect: false,
      },
    }
  );
  const updated = upsertQuestionHumanEvaluation(
    first,
    {
      traceId: "trace_adjudication",
      traceKind: "voice",
      questionId: "question_adjudication",
    },
    {
      taxonomyAdjudication: {
        relationCorrect: true,
        repairDisposition: "suggest-only",
        timely: false,
      },
    }
  );

  assert.deepEqual(updated[0].taxonomyAdjudication, {
    needed: true,
    typeCorrect: false,
    relationCorrect: true,
    repairDisposition: "suggest-only",
    timely: false,
  });
});

test("merges current-question settlement labels without replacing prior judgments", () => {
  const first = upsertQuestionHumanEvaluation(
    [],
    {
      traceId: "trace_settlement",
      traceKind: "voice",
      questionId: "question_settlement",
    },
    {
      currentQuestionSettlement: {
        questionTypeCorrect: true,
        relationCorrect: false,
      },
    }
  );
  const updated = upsertQuestionHumanEvaluation(
    first,
    {
      traceId: "trace_settlement",
      traceKind: "voice",
      questionId: "question_settlement",
    },
    {
      currentQuestionSettlement: {
        parentMutationCorrect: true,
        expectedDisposition: "committed-parent",
      },
    }
  );

  assert.deepEqual(updated[0]?.currentQuestionSettlement, {
    questionTypeCorrect: true,
    relationCorrect: false,
    parentMutationCorrect: true,
    expectedDisposition: "committed-parent",
  });
});

test("persists primary-ask correctness independently from advisor admission", () => {
  const first = upsertQuestionHumanEvaluation(
    [],
    {
      traceId: "trace_primary_ask",
      traceKind: "voice",
      questionId: "question_primary_ask",
    },
    { primaryAskCorrect: false }
  );
  const updated = upsertQuestionHumanEvaluation(
    first,
    {
      traceId: "trace_primary_ask",
      traceKind: "voice",
      questionId: "question_primary_ask",
    },
    {
      advisorIntent: buildAdvisorIntentEvaluationFromTrace({
        trace: {
          id: "trace_primary_ask",
          kind: "voice",
          status: "success",
          startedAt: 1,
          steps: [],
          inputs: [],
          outputs: [],
          metadata: {
            advisorExecutionAuthorized: false,
            logicalQuestionUnitId: "logical_primary_ask",
            logicalQuestionUnitRevision: 1,
            logicalQuestionSourceTurnIds: ["turn_primary_ask"],
          },
        },
        expectedAction: "advise",
        source: "explicit-human-label",
      }),
    }
  );

  assert.equal(updated[0]?.primaryAskCorrect, false);
  assert.equal(updated[0]?.advisorIntent?.verdict, "false-negative");
});

test("merges answer sufficiency labels without dropping context-source evidence", () => {
  const first = upsertQuestionHumanEvaluation(
    [],
    {
      traceId: "trace_sufficiency",
      traceKind: "voice",
      questionId: "question_sufficiency",
    },
    {
      answerSufficiency: {
        observedStatus: "insufficient",
        nearbyContextExisted: true,
        expectedRepair: "enhance",
        expectedContextKinds: ["recent-dialogue"],
        operationId: "answer-sufficiency:trace_sufficiency",
        answerRevision: 1,
      },
    }
  );
  const updated = upsertQuestionHumanEvaluation(
    first,
    {
      traceId: "trace_sufficiency",
      traceKind: "voice",
      questionId: "question_sufficiency",
    },
    {
      answerSufficiency: {
        expectedRepair: "narrow",
        expectedContextKinds: ["parent-capsule"],
        staleContextIntroduced: true,
      },
    }
  );

  assert.equal(updated[0].answerSufficiency?.observedStatus, "insufficient");
  assert.equal(updated[0].answerSufficiency?.expectedRepair, "narrow");
  assert.equal(updated[0].answerSufficiency?.staleContextIntroduced, true);
  assert.deepEqual(updated[0].answerSufficiency?.expectedContextKinds, [
    "recent-dialogue",
    "parent-capsule",
  ]);
});

test("persists trace-bound memory evidence with a question evaluation", () => {
  const evaluations = upsertQuestionHumanEvaluation(
    [],
    {
      traceId: "trace_1",
      traceKind: "screen",
      parentTaskId: "parent_1",
      memoryRetrievalSnapshot: {
        traceId: "trace_1",
        status: "available",
        entries: [
          {
            id: "mem_1",
            title: "Project evidence",
            score: 21,
            matchReason: ["project:fact-anchor"],
          },
        ],
      },
    },
    {
      memoryEntryLabels: [
        {
          memoryId: "mem_1",
          title: "Project evidence",
          label: "relevant",
        },
      ],
    }
  );

  assert.deepEqual(evaluations[0].memoryRetrievalSnapshot, {
    traceId: "trace_1",
    status: "available",
    entries: [
      {
        id: "mem_1",
        title: "Project evidence",
        score: 21,
        matchReason: ["project:fact-anchor"],
      },
    ],
  });
});

test("bridges legacy trace labels into question-level verdict blocks", () => {
  const traceEvaluation: TraceHumanEvaluation = {
    id: "human_eval_1",
    traceId: "trace_1",
    traceKind: "screen",
    taskId: "task_1",
    parentTaskId: "parent_1",
    taskSource: "screen",
    questionType: "behavioral",
    correctedQuestionType: "coding",
    playbookWrong: true,
    memoryMissing: true,
    advisorGateShouldAdvise: true,
    taskQuality: "partial",
    failureReasons: ["wrong-question-type", "too-short"],
    createdAt: 1,
    updatedAt: 2,
  };

  const patch = buildQuestionEvaluationPatchFromTrace(traceEvaluation);

  assert.equal(patch.questionType, "behavioral");
  assert.equal(patch.correctedQuestionType, "coding");
  assert.deepEqual(patch.classification, {
    verdict: "wrong",
    reasons: ["wrong-question-type"],
  });
  assert.deepEqual(patch.playbook, {
    verdict: "wrong",
    reasons: ["wrong-playbook"],
  });
  assert.deepEqual(patch.memory, {
    verdict: "missing",
    reasons: ["missing-memory"],
  });
  assert.deepEqual(patch.answer, {
    verdict: "partial",
    reasons: ["partially-useful"],
  });
  assert.deepEqual(patch.advisorIntent, {
    schemaVersion: 1,
    verdict: "false-negative",
    expectedAction: "advise",
    observedAction: "suppressed",
    failureReason: "advisor-false-negative",
    source: "explicit-human-label",
    originalTraceId: "trace_1",
    sourceTurnIds: [],
    createdAt: 1,
    updatedAt: 2,
  });
});

test("merges advisor intent repairs without losing original decision evidence", () => {
  const first = upsertQuestionHumanEvaluation(
    [],
    {
      traceId: "trace_suppressed",
      traceKind: "voice",
      questionId: "question_1",
    },
    {
      advisorIntent: {
        schemaVersion: 1,
        verdict: "false-negative",
        expectedAction: "advise",
        observedAction: "suppressed",
        failureReason: "advisor-false-negative",
        source: "manual-force-advise",
        originalTraceId: "trace_suppressed",
        logicalQuestionUnitId: "lqu_1",
        logicalQuestionUnitRevision: 2,
        sourceTurnIds: ["turn_1"],
        preDecision: {
          intent: "statement",
          wouldSuppress: true,
          executionAuthorized: false,
        },
        createdAt: 10,
        updatedAt: 10,
      },
    }
  );

  const repaired = upsertQuestionHumanEvaluation(
    first,
    {
      traceId: "trace_repair",
      traceKind: "voice",
      questionId: "question_1",
    },
    {
      advisorIntent: {
        ...first[0].advisorIntent!,
        sourceTurnIds: ["turn_1", "turn_2"],
        preDecision: {
          outputCommitAuthorized: true,
        },
        repairTraceId: "trace_repair",
        updatedAt: 20,
      },
    }
  );

  assert.deepEqual(repaired[0].advisorIntent?.sourceTurnIds, [
    "turn_1",
    "turn_2",
  ]);
  assert.deepEqual(repaired[0].advisorIntent?.preDecision, {
    intent: "statement",
    wouldSuppress: true,
    executionAuthorized: false,
    outputCommitAuthorized: true,
  });
  assert.equal(repaired[0].advisorIntent?.repairTraceId, "trace_repair");
});

test("stores whiteboard, manual next, and diagram overlay evaluation fields", () => {
  const evaluations = upsertQuestionHumanEvaluation(
    [],
    {
      sessionId: "session_1",
      traceId: "trace_1",
      traceKind: "screen",
      taskId: "task_1",
      parentTaskId: "parent_1",
      taskSource: "mixed",
      questionType: "general-system-design",
      playbookId: "general_system_design",
      playbookPhase: "design_framing",
      whiteboardArtifactId: "whiteboard_1",
      whiteboardArtifactRevision: 2,
      whiteboardArtifactDomainTrack: "general_sd",
      manualPhaseFrom: "requirement_clarification",
      manualPhaseTo: "design_framing",
      manualPhaseTargetArtifact: "whiteboard",
      manualPhaseGuardStatus: "advanced",
      selectedDiagramOverlayIds: ["mem_overlay_geo_dynamic_matching"],
      rejectedDiagramOverlayCount: 3,
    },
    {
      whiteboard: {
        verdict: "ok",
        reasons: ["whiteboard-useful"],
      },
      manualPhaseTransition: {
        verdict: "ok",
        reasons: ["manual-next-good"],
      },
      diagramOverlay: {
        verdict: "partial",
        reasons: ["overlay-distracting"],
      },
    }
  );

  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0].detectedWhiteboardArtifactId, "whiteboard_1");
  assert.equal(evaluations[0].detectedWhiteboardArtifactRevision, 2);
  assert.equal(evaluations[0].detectedWhiteboardArtifactDomainTrack, "general_sd");
  assert.equal(evaluations[0].detectedManualPhaseFrom, "requirement_clarification");
  assert.equal(evaluations[0].detectedManualPhaseTo, "design_framing");
  assert.equal(evaluations[0].detectedManualPhaseTargetArtifact, "whiteboard");
  assert.equal(evaluations[0].detectedManualPhaseGuardStatus, "advanced");
  assert.deepEqual(evaluations[0].selectedDiagramOverlayIds, [
    "mem_overlay_geo_dynamic_matching",
  ]);
  assert.equal(evaluations[0].rejectedDiagramOverlayCount, 3);
  assert.equal(evaluations[0].whiteboard.verdict, "ok");
  assert.deepEqual(evaluations[0].whiteboard.reasons, ["whiteboard-useful"]);
  assert.equal(evaluations[0].manualPhaseTransition.verdict, "ok");
  assert.deepEqual(evaluations[0].manualPhaseTransition.reasons, [
    "manual-next-good",
  ]);
  assert.equal(evaluations[0].diagramOverlay.verdict, "partial");
  assert.deepEqual(evaluations[0].diagramOverlay.reasons, [
    "overlay-distracting",
  ]);
});

test("stores manual runtime type correction as HITL classification feedback", () => {
  const evaluations = upsertQuestionHumanEvaluation(
    [],
    {
      sessionId: "session_1",
      traceId: "correction_trace_1",
      traceKind: "voice",
      taskId: "task_1",
      parentTaskId: "parent_1",
      taskSource: "voice",
      questionType: "project-deep-dive",
    },
    {
      questionId: "trace:answer_trace_1",
      traceIds: ["answer_trace_1", "regeneration_trace_1"],
      correctedQuestionType: "coding",
      manualQuestionTypeCorrectionId: "correction_1",
      manualQuestionTypeCorrectionTraceId: "correction_trace_1",
      manualQuestionTypeRegenerationTraceId: "regeneration_trace_1",
      manualQuestionTypeCorrectionSource: "focus-mode",
      classification: {
        verdict: "wrong",
        reasons: ["manual-runtime-correction"],
      },
    }
  );

  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0].questionId, "trace:answer_trace_1");
  assert.deepEqual(evaluations[0].traceIds, [
    "correction_trace_1",
    "answer_trace_1",
    "regeneration_trace_1",
  ]);
  assert.equal(evaluations[0].questionType, "project-deep-dive");
  assert.equal(evaluations[0].correctedQuestionType, "coding");
  assert.equal(
    evaluations[0].manualQuestionTypeCorrectionId,
    "correction_1"
  );
  assert.equal(
    evaluations[0].manualQuestionTypeCorrectionTraceId,
    "correction_trace_1"
  );
  assert.equal(
    evaluations[0].manualQuestionTypeRegenerationTraceId,
    "regeneration_trace_1"
  );
  assert.equal(
    evaluations[0].manualQuestionTypeCorrectionSource,
    "focus-mode"
  );
  assert.equal(evaluations[0].classification.verdict, "wrong");
  assert.deepEqual(evaluations[0].classification.reasons, [
    "manual-runtime-correction",
  ]);
});

test("labels an authorized advisor turn as a false positive when advice was not expected", () => {
  const evaluation = buildAdvisorIntentEvaluationFromTrace({
    trace: {
      id: "trace_advised",
      kind: "voice",
      status: "success",
      startedAt: 1,
      steps: [],
      inputs: [],
      outputs: [],
      metadata: {
        advisorTurnIntent: "direct-question",
        advisorTurnAction: "answer-refresh",
        advisorTurnEnforcement: "allow",
        advisorExecutionAuthorized: true,
        advisorOutputCommitAuthorized: true,
        logicalQuestionUnitId: "lqu_1",
        logicalQuestionRevision: 2,
        logicalQuestionSourceTurnIds: ["turn_1", "turn_2"],
      },
    } as MeetingTrace,
    expectedAction: "ignore",
    source: "manual-suppress",
    now: 100,
  });

  assert.equal(evaluation.verdict, "false-positive");
  assert.equal(evaluation.observedAction, "advised");
  assert.equal(evaluation.failureReason, "advisor-false-positive");
  assert.deepEqual(evaluation.sourceTurnIds, ["turn_1", "turn_2"]);
});

test("labels a suppressed advisor turn as a false negative when advice was expected", () => {
  const evaluation = buildAdvisorIntentEvaluationFromTrace({
    trace: {
      id: "trace_skipped",
      kind: "voice",
      status: "success",
      startedAt: 1,
      steps: [],
      inputs: [],
      outputs: [],
      metadata: {
        advisorTurnIntent: "informational",
        turnGateAction: "ignore",
        advisorTurnEnforcement: "enforce",
        advisorWouldSuppress: true,
        advisorExecutionAuthorized: false,
        triggerTurnId: "turn_3",
      },
    } as MeetingTrace,
    expectedAction: "advise",
    now: 200,
  });

  assert.equal(evaluation.verdict, "false-negative");
  assert.equal(evaluation.observedAction, "suppressed");
  assert.equal(evaluation.failureReason, "advisor-false-negative");
  assert.deepEqual(evaluation.sourceTurnIds, ["turn_3"]);
});
