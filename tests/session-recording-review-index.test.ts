import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionTaskReviewIndex,
  type TaskReviewTraceSummary,
} from "../src/lib/meeting/session-task-review-index.js";
import type { QuestionHumanEvaluation } from "../src/lib/meeting/types.js";

test("builds a task-level review index from trace summaries and evaluations", () => {
  const traceSummary: TaskReviewTraceSummary = {
    version: 1,
    sessionId: "session_1",
    traceId: "trace_1",
    traceKind: "screen",
    status: "success",
    startedAt: 1000,
    endedAt: 2000,
    taskIds: ["task_parent"],
    primaryTaskId: "task_parent",
    activeMeetingTaskId: "task_parent",
    activeMeetingTaskSource: "mixed",
    activeMeetingParentId: "task_parent",
    activeMeetingChildId: "task_child",
    questionType: "general-system-design",
    askFrame: "hypothetical-design",
    topicDomain: "backend",
    playbookId: "general_system_design",
    playbookPhase: "whiteboard",
    turnGateAction: "regenerate",
    turnGateReason: "meaningful-follow-up",
    taskMutationAuthorized: false,
    taskMutationAuthorizationReason: "turn-intent-would-suppress",
    currentQuestionSettlement: {
      settlementId: "settlement_1",
      questionType: "general-system-design",
      relation: "new-parent",
      authority: "deterministic-fast-path",
      disposition: "committed-parent",
      parentMutationAuthorized: true,
      responseAuthorized: true,
    },
    settledExecutionPlan: {
      planId: "plan_1",
      settlementId: "settlement_1",
      questionType: "general-system-design",
      modelRoute: "main",
      playbookId: "general_system_design",
      memoryUseCase: "system_design_interview",
      authorized: true,
      authorizationStage: "plan-created",
    },
    advisorOutputDisposition: "shadow-observation-only",
    adjacentConstraintInherited: true,
    adjacentConstraintDecisionReason: "inherited-explicit-constraint",
    adjacentConstraintKinds: "programming-language",
    adjacentConstraintDeltaMs: 2200,
    adjacentQuestionOriginTraceId: "trace_question",
    sentenceBufferOperationId: "sentence_buffer_1",
    sentenceBufferOperationRole: "terminal",
    sentenceBufferOutcome: "merged",
    sentenceBufferDisposition: "merged-and-bypassed",
    sentenceBufferFlushReason: "next-them-fragment",
    sentenceBufferFragmentCount: 2,
    sentenceBufferAddedLatencyMs: 850,
    modelRoute: "main",
    memory: {
      selectedEntries: 3,
      rejectedCount: 2,
      totalChars: 1500,
      useCase: "system_design_interview",
    },
    whiteboard: {
      artifactId: "whiteboard_1",
      revision: 2,
      domainTrack: "general_sd",
    },
    manualPhase: {
      from: "requirement_clarification",
      to: "whiteboard",
      targetArtifact: "whiteboard",
      guardStatus: "advanced",
      committed: true,
    },
    diagramOverlay: {
      selectedEntryIds: ["mem_overlay_geo"],
      rejectedCount: 1,
    },
    artifacts: {
      traceExportPath: "traces/trace_1.json",
      summaryPath: "traces/trace_1/summary.json",
    },
  };
  const evaluation = buildQuestionEvaluation();

  const index = buildSessionTaskReviewIndex("session_1", [traceSummary], [
    evaluation,
  ]);
  const task = index.tasks.find((candidate) => candidate.taskId === "task_parent");

  assert.equal(index.taskCount, 2);
  assert.ok(task);
  assert.deepEqual(task.traceIds, ["trace_1"]);
  assert.deepEqual(task.questionTypes, ["general-system-design"]);
  assert.deepEqual(task.taskSources, ["mixed"]);
  assert.deepEqual(task.playbookPhases, ["whiteboard"]);
  assert.equal(task.memorySelectedEntriesTotal, 3);
  assert.equal(task.memoryRejectedCountTotal, 2);
  assert.equal(task.sentenceBufferOperationCount, 1);
  assert.equal(task.sentenceBufferMergedCount, 1);
  assert.equal(task.sentenceBufferTimeoutCount, 0);
  assert.equal(task.sentenceBufferAddedLatencyMsTotal, 850);
  assert.equal(task.taskMutationSuppressedCount, 1);
  assert.deepEqual(task.settlementDispositions, ["committed-parent"]);
  assert.deepEqual(task.settlementQuestionTypes, [
    "general-system-design",
  ]);
  assert.equal(task.settlementStaleDropCount, 0);
  assert.deepEqual(task.settledExecutionPlanIds, ["plan_1"]);
  assert.equal(task.adjacentConstraintInheritanceCount, 1);
  assert.deepEqual(task.whiteboardArtifactIds, ["whiteboard_1"]);
  assert.deepEqual(task.manualPhaseTransitions, [
    {
      traceId: "trace_1",
      from: "requirement_clarification",
      to: "whiteboard",
      targetArtifact: "whiteboard",
      guardStatus: "advanced",
      committed: true,
    },
  ]);
  assert.deepEqual(task.diagramOverlayIds, ["mem_overlay_geo"]);
  assert.equal(task.diagramOverlayRejectedCountTotal, 1);
  assert.deepEqual(task.humanEvaluation?.classificationVerdicts, ["ok"]);
  assert.deepEqual(task.humanEvaluation?.memoryVerdicts, ["partial"]);
  assert.deepEqual(
    task.humanEvaluation?.settlementQuestionTypeLabels,
    ["correct"]
  );
  assert.deepEqual(
    task.humanEvaluation?.settlementRelationLabels,
    ["correct"]
  );
  assert.deepEqual(
    task.humanEvaluation?.settlementParentMutationLabels,
    ["wrong"]
  );
  assert.deepEqual(task.humanEvaluation?.memoryEntryLabelCounts, {
    relevant: 1,
    irrelevant: 1,
  });
  assert.deepEqual(task.artifacts.traceExportPaths, ["traces/trace_1.json"]);
  assert.equal(
    task.artifacts.reviewSummaryPath,
    "tasks/task_parent/review-summary.json"
  );
});

function buildQuestionEvaluation(): QuestionHumanEvaluation {
  const okBlock = { verdict: "ok" as const, reasons: [] };

  return {
    id: "question_eval_1",
    sessionId: "session_1",
    questionId: "question_instance_1",
    taskId: "task_parent",
    parentTaskId: "task_parent",
    childTaskId: "task_child",
    taskSource: "mixed",
    traceIds: ["trace_1"],
    questionType: "general-system-design",
    playbookId: "general_system_design",
    detectedPlaybookPhase: "whiteboard",
    selectedDiagramOverlayIds: ["mem_overlay_geo"],
    rejectedDiagramOverlayCount: 1,
    classification: okBlock,
    playbook: okBlock,
    playbookPhase: okBlock,
    memory: { verdict: "partial", reasons: ["missing-one-memory"] },
    whiteboard: okBlock,
    manualPhaseTransition: okBlock,
    diagramOverlay: okBlock,
    guardrail: okBlock,
    answer: okBlock,
    currentQuestionSettlement: {
      questionTypeCorrect: true,
      relationCorrect: true,
      parentMutationCorrect: false,
      expectedDisposition: "committed-parent",
    },
    memoryEntryLabels: [
      {
        memoryId: "mem_overlay_geo",
        label: "relevant",
      },
      {
        memoryId: "mem_behavioral",
        label: "irrelevant",
      },
    ],
    missingExpectedMemory: [],
    createdAt: 3000,
    updatedAt: 3000,
  };
}

test("keeps question identity out of task rows and aggregates one buffer operation", () => {
  const sourceTrace = buildBufferTrace({
    traceId: "trace_source",
    role: "source-fragment",
    disposition: "merged-into-next",
  });
  const terminalTrace = buildBufferTrace({
    traceId: "trace_terminal",
    role: "terminal",
    disposition: "merged-and-bypassed",
  });
  const evaluation = buildQuestionEvaluation();
  evaluation.questionId = "question_instance_not_a_task";
  evaluation.traceIds = ["trace_terminal"];

  const index = buildSessionTaskReviewIndex(
    "session_1",
    [sourceTrace, terminalTrace],
    [evaluation]
  );

  assert.equal(
    index.tasks.some((task) => task.taskId === "question_instance_not_a_task"),
    false
  );
  const parent = index.tasks.find((task) => task.taskId === "task_parent");
  assert.ok(parent);
  assert.equal(parent.sentenceBufferOperationCount, 1);
  assert.equal(parent.sentenceBufferMergedCount, 1);
  assert.equal(parent.sentenceBufferAddedLatencyMsTotal, 850);
});

test("leaves question-only evaluations unassigned instead of creating phantom tasks", () => {
  const evaluation = buildQuestionEvaluation();
  evaluation.questionId = "question_without_task";
  evaluation.taskId = undefined;
  evaluation.parentTaskId = undefined;
  evaluation.childTaskId = undefined;
  evaluation.traceIds = [];

  const index = buildSessionTaskReviewIndex("session_1", [], [evaluation]);

  assert.equal(index.taskCount, 0);
  assert.deepEqual(index.tasks, []);
});

test("counts a timeout terminal once and ignores its source evidence", () => {
  const sourceTrace = buildBufferTrace({
    traceId: "trace_timeout_source",
    role: "source-fragment",
    disposition: "buffered",
    outcome: undefined,
  });
  const terminalTrace = buildBufferTrace({
    traceId: "trace_timeout_terminal",
    role: "terminal",
    disposition: "flushed-incomplete",
    outcome: "timeout",
  });
  terminalTrace.sentenceBufferFlushReason = "timeout";

  const index = buildSessionTaskReviewIndex(
    "session_1",
    [sourceTrace, terminalTrace],
    []
  );
  const parent = index.tasks.find((task) => task.taskId === "task_parent");

  assert.ok(parent);
  assert.equal(parent.sentenceBufferOperationCount, 1);
  assert.equal(parent.sentenceBufferMergedCount, 0);
  assert.equal(parent.sentenceBufferTimeoutCount, 1);
  assert.equal(parent.sentenceBufferAddedLatencyMsTotal, 850);
});

function buildBufferTrace({
  traceId,
  role,
  disposition,
  outcome = "merged",
}: {
  traceId: string;
  role: "source-fragment" | "terminal";
  disposition: string;
  outcome?: "merged" | "timeout";
}): TaskReviewTraceSummary {
  return {
    version: 3,
    sessionId: "session_1",
    traceId,
    traceKind: "voice",
    status: "success",
    startedAt: traceId === "trace_source" ? 1000 : 1100,
    taskIds: ["task_parent"],
    primaryTaskId: "task_parent",
    activeMeetingTaskId: "task_parent",
    activeMeetingParentId: "task_parent",
    sentenceBufferOperationId: traceId.includes("timeout")
      ? "sentence_buffer_timeout"
      : "sentence_buffer_shared",
    sentenceBufferOperationRole: role,
    sentenceBufferOutcome: outcome,
    sentenceBufferDisposition: disposition,
    sentenceBufferFlushReason: "next-them-fragment",
    sentenceBufferFragmentCount: 2,
    sentenceBufferAddedLatencyMs: 850,
    artifacts: {
      traceExportPath: `traces/${traceId}.json`,
      summaryPath: `traces/${traceId}/summary.json`,
    },
  };
}
