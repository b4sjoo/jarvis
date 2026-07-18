import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQuestionEvaluationPatchFromTrace,
  upsertQuestionHumanEvaluation,
} from "../src/lib/meeting/human-evaluation.js";
import type { TraceHumanEvaluation } from "../src/lib/meeting/types.js";

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
