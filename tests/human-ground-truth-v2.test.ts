import assert from "node:assert/strict";
import test from "node:test";
import {
  appendHumanGroundTruthEventV2,
  buildHumanEvaluationObservedSnapshotV2,
  createHumanGroundTruthEventV2,
  deriveHumanEvaluationProjectionV2,
  evaluateTaskSettlementTupleCompatibilityV2,
  importLegacyQuestionEvaluationV2,
} from "../src/lib/meeting/human-ground-truth-v2.js";
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

test("validates relation and parent-action tuples before ground truth is saved", () => {
  const canonicalTuples = [
    ["new-parent", "create"],
    ["followup-parent", "preserve"],
    ["child-probe", "attach-child"],
    ["resume-parent", "resume"],
    ["logistics", "preserve"],
    ["correction", "preserve"],
    ["unknown", "none"],
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
      compatible: false,
      relation: "child-probe",
      parentAction: "preserve",
      recommendedParentAction: "attach-child",
      reason:
        "child-probe normally requires attach-child, not preserve.",
    }
  );
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
