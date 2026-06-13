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
    questionId: "task_parent",
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
