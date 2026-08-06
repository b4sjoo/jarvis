import assert from "node:assert/strict";
import test from "node:test";
import {
  createHumanGroundTruthEventV2,
  deriveHumanEvaluationProjectionV2,
} from "../src/lib/meeting/human-ground-truth-v2.js";
import { projectHumanEvaluationsForLegacyConsumers } from "../src/lib/meeting/human-evaluation-v2-consumers.js";
import type { QuestionHumanEvaluation } from "../src/lib/meeting/types.js";

test("V2 projections override exact legacy consumer expectations", () => {
  const subject = {
    questionId: "question_1",
    taskId: "task_1",
    traceIds: ["trace_1"],
    sourceTurnIds: ["turn_1"],
  };
  const settlement = createHumanGroundTruthEventV2({
    eventId: "event_settlement",
    sessionId: "session_1",
    subject,
    source: "explicit-ui",
    fact: {
      kind: "expected-task-settlement",
      expectedQuestionType: "general-system-design",
      expectedRelation: "new-parent",
      expectedParentAction: "create",
    },
    now: 10,
  });
  const runtime = createHumanGroundTruthEventV2({
    eventId: "event_runtime",
    sessionId: "session_1",
    subject,
    source: "explicit-ui",
    fact: {
      kind: "expected-runtime-action",
      expectedAction: "advise",
    },
    interaction: {
      startedAt: 3,
      durationMs: 8,
      clickCount: 5,
      expandedRegions: ["human-evaluation"],
    },
    now: 11,
  });
  const projection = deriveHumanEvaluationProjectionV2({
    sessionId: "session_1",
    subject,
    events: [settlement, runtime],
    observed: {
      traceId: "trace_1",
      traceHash: "hash_1",
      questionType: "coding",
      relation: "followup-parent",
      parentAction: "preserve",
      runtimeAction: "ignore",
    },
    now: 12,
  });
  const legacy = createEvaluation({
    questionId: "question_1",
    traceIds: ["trace_1"],
    correctedQuestionType: "coding",
    expectedRelation: "followup-parent",
    expectedParentAction: "preserve",
  });

  const result = projectHumanEvaluationsForLegacyConsumers({
    evaluations: [legacy],
    projections: [projection],
    now: 13,
  });

  assert.equal(result.evaluations.length, 1);
  assert.equal(
    result.evaluations[0].correctedQuestionType,
    "general-system-design"
  );
  assert.equal(result.evaluations[0].expectedRelation, "new-parent");
  assert.equal(result.evaluations[0].expectedParentAction, "create");
  assert.equal(result.evaluations[0].advisorIntent?.expectedAction, "advise");
  assert.equal(result.evaluations[0].advisorIntent?.verdict, "false-negative");
  assert.equal(
    result.report.dimensions.questionType.disagreement,
    1
  );
  assert.equal(result.report.matchedProjectionCount, 1);
  assert.deepEqual(result.report.interaction, {
    measuredProjectionCount: 1,
    durationP50Ms: 8,
    durationP90Ms: 8,
    clickCountP50: 5,
    clickCountP90: 5,
    expertAuditExpandedCount: 0,
  });
});

test("V2-only projections produce explicit synthetic consumer rows", () => {
  const subject = {
    questionId: "question_v2_only",
    taskId: "task_v2_only",
    traceIds: ["trace_v2_only"],
    sourceTurnIds: [],
  };
  const answer = createHumanGroundTruthEventV2({
    eventId: "event_answer",
    sessionId: "session_2",
    subject,
    source: "explicit-ui",
    fact: {
      kind: "answer-quality",
      outcome: "partial",
      failureReasons: ["missing-domain-anchor"],
      expectedContextTurnIds: [],
    },
    now: 20,
  });
  const projection = deriveHumanEvaluationProjectionV2({
    sessionId: "session_2",
    subject,
    events: [answer],
    now: 21,
  });

  const result = projectHumanEvaluationsForLegacyConsumers({
    evaluations: [],
    projections: [projection],
    now: 22,
  });

  assert.equal(result.evaluations.length, 1);
  assert.equal(result.evaluations[0].answer.verdict, "partial");
  assert.equal(result.report.v2OnlyProjectionCount, 1);
  assert.equal(result.report.dimensions.answerOutcome.v2Only, 1);
  assert.equal(result.report.warnings[0]?.code, "v2-only-projection");
});

test("reports legacy observed-action drift without overriding the final trace", () => {
  const subject = {
    questionId: "question_observed_drift",
    traceIds: ["trace_observed_drift"],
    sourceTurnIds: ["turn_observed_drift"],
  };
  const runtime = createHumanGroundTruthEventV2({
    eventId: "event_observed_drift",
    sessionId: "session_1",
    subject,
    source: "explicit-ui",
    fact: {
      kind: "expected-runtime-action",
      expectedAction: "advise",
    },
    now: 10,
  });
  const projection = deriveHumanEvaluationProjectionV2({
    sessionId: "session_1",
    subject,
    events: [runtime],
    observed: {
      traceId: "trace_observed_drift",
      traceHash: "hash_final",
      runtimeAction: "advise",
      advisorOutcome: "visible-committed",
    },
    now: 11,
  });
  const legacy = createEvaluation({
    questionId: subject.questionId,
    traceIds: [...subject.traceIds],
    advisorIntent: {
      schemaVersion: 1,
      verdict: "false-negative",
      expectedAction: "advise",
      observedAction: "suppressed",
      source: "explicit-human-label",
      originalTraceId: "trace_observed_drift",
      sourceTurnIds: [...subject.sourceTurnIds],
      createdAt: 10,
      updatedAt: 10,
    },
  });

  const result = projectHumanEvaluationsForLegacyConsumers({
    evaluations: [legacy],
    projections: [projection],
  });

  assert.equal(
    result.report.dimensions.observedRuntimeAction.disagreement,
    1
  );
  assert.ok(
    result.report.warnings.some(
      (warning) => warning.code === "observed-runtime-mismatch"
    )
  );
  assert.equal(result.evaluations[0]?.advisorIntent?.observedAction, "advised");
});

test("independent context and artifact labels keep separate denominators", () => {
  const subject = {
    questionId: "question_planes",
    traceIds: ["trace_planes"],
    sourceTurnIds: [],
  };
  const events = [
    createHumanGroundTruthEventV2({
      eventId: "event_scope",
      sessionId: "session_3",
      subject,
      source: "explicit-ui",
      fact: {
        kind: "expected-context-read-scope",
        expectedScope: "active-child-read",
      },
      now: 30,
    }),
    createHumanGroundTruthEventV2({
      eventId: "event_artifact",
      sessionId: "session_3",
      subject,
      source: "explicit-ui",
      fact: {
        kind: "expected-artifact-intent",
        expectedIntent: "revise-code",
      },
      now: 31,
    }),
  ];
  const projection = deriveHumanEvaluationProjectionV2({
    sessionId: "session_3",
    subject,
    events,
    observed: {
      traceId: "trace_planes",
      traceHash: "hash_planes",
      contextReadScope: "current-only",
      artifactIntent: "preserve",
    },
    now: 32,
  });

  const result = projectHumanEvaluationsForLegacyConsumers({
    evaluations: [],
    projections: [projection],
    now: 33,
  });

  assert.equal(result.report.dimensions.contextReadScope.v2Labeled, 1);
  assert.equal(result.report.dimensions.contextReadScope.v1Labeled, 0);
  assert.equal(result.report.dimensions.artifactIntent.v2Labeled, 1);
  assert.equal(projection.verdicts.contextReadScopeCorrect, false);
  assert.equal(projection.verdicts.artifactIntentCorrect, false);
});

function createEvaluation(
  patch: Partial<QuestionHumanEvaluation>
): QuestionHumanEvaluation {
  const empty = { verdict: "not_applicable" as const, reasons: [] };
  return {
    id: "evaluation_1",
    sessionId: "session_1",
    questionId: "question_1",
    traceIds: [],
    selectedDiagramOverlayIds: [],
    classification: { ...empty },
    playbook: { ...empty },
    playbookPhase: { ...empty },
    memory: { ...empty },
    whiteboard: { ...empty },
    manualPhaseTransition: { ...empty },
    diagramOverlay: { ...empty },
    guardrail: { ...empty },
    answer: { ...empty },
    memoryEntryLabels: [],
    missingExpectedMemory: [],
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}
