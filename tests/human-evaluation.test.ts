import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQuestionEvaluationPatchFromTrace,
  upsertQuestionHumanEvaluation,
} from "../src/lib/meeting/human-evaluation.js";
import type { TraceHumanEvaluation } from "../src/lib/meeting/types.js";

test("merges question-level evaluations by stable parent task id", () => {
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

  const merged = upsertQuestionHumanEvaluation(
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

  assert.equal(merged.length, 1);
  assert.equal(merged[0].questionId, "parent_1");
  assert.deepEqual(merged[0].traceIds, ["trace_1", "trace_2"]);
  assert.equal(merged[0].detectedPlaybookPhase, "story_selection");
  assert.equal(merged[0].guardrail.verdict, "ok");
  assert.equal(merged[0].memoryEntryLabels.length, 1);
  assert.equal(merged[0].memoryEntryLabels[0].memoryId, "mem_aos_cleanup");
  assert.equal(merged[0].memoryEntryLabels[0].title, "AOS cleanup");
  assert.equal(merged[0].memoryEntryLabels[0].label, "relevant");
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
