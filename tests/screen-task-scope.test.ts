import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAdvisorScreenScopeToPromptContext,
  decideAdvisorScreenScope,
  decideScreenResultScope,
  resolveAdvisorRequestModeForScreenScope,
  resolveAdvisorTaskEvidenceSource,
} from "../src/lib/meeting/screen-task-scope.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import type {
  ActiveInterviewParent,
  ActiveScreenTask,
} from "../src/lib/meeting/types.js";

test("clears an existing screen scope when a live voice turn opens a new parent", () => {
  const decision = decideAdvisorScreenScope({
    triggerSource: "live-turn",
    relation: "new-parent",
    hasActiveScreenTask: true,
  });

  assert.deepEqual(decision, {
    action: "clear",
    durability: "none",
    mutationAuthorized: true,
    reason: "voice-new-parent",
  });
});

test("keeps screen scope for child, resume, follow-up, and explicit actions", () => {
  for (const relation of [
    "child-probe",
    "resume-parent",
    "followup-parent",
  ] as const) {
    assert.equal(
      decideAdvisorScreenScope({
        triggerSource: "live-turn",
        relation,
        hasActiveScreenTask: true,
      }).action,
      "keep"
    );
  }

  assert.equal(
    decideAdvisorScreenScope({
      triggerSource: "response-action",
      relation: "new-parent",
      hasActiveScreenTask: true,
    }).reason,
    "explicit-action-preserve"
  );
});

test("removes task-owned context from a new voice parent prompt projection", () => {
  const manager = new MeetingContextManager();
  manager.setActiveMeetingTaskState({
    activeScreenTask: makeScreenTask(),
    activeInterviewTask: makeParent(),
  });
  const original = manager.buildAdvisorPromptContext();
  const projected = applyAdvisorScreenScopeToPromptContext(
    original,
    decideAdvisorScreenScope({
      triggerSource: "live-turn",
      relation: "new-parent",
      hasActiveScreenTask: true,
    })
  );

  assert.ok(original.activeMeetingTask);
  assert.equal(projected.screenContext, "");
  assert.equal(projected.activeScreenTask, undefined);
  assert.equal(projected.activeInterviewTask, undefined);
  assert.equal(projected.activeMeetingTask, undefined);
  assert.equal(projected.interviewPlaybook, undefined);
  assert.equal(manager.getState().activeMeetingTask?.id, "parent-screen");
});

test("keeps unknown and ambiguous screen answers provisional", () => {
  for (const questionType of ["unknown", "ambiguous"] as const) {
    const decision = decideScreenResultScope({
      questionType,
      hasAnswer: true,
    });
    assert.equal(decision.action, "provisional");
    assert.equal(decision.durability, "provisional");
    assert.equal(decision.mutationAuthorized, false);
  }
});

test("allows only classified screen answers to replace durable task state", () => {
  assert.deepEqual(
    decideScreenResultScope({
      questionType: "general-system-design",
      hasAnswer: true,
    }),
    {
      action: "replace",
      durability: "durable",
      mutationAuthorized: true,
      reason: "screen-result-classified",
    }
  );
  assert.equal(
    decideScreenResultScope({
      questionType: "non-question",
      hasAnswer: true,
    }).action,
    "keep"
  );
  assert.equal(
    decideScreenResultScope({
      questionType: "coding",
      hasAnswer: false,
    }).action,
    "keep"
  );
});

test("treats live-turn evidence as voice even when a screen is active", () => {
  assert.equal(
    resolveAdvisorTaskEvidenceSource({
      triggerSource: "live-turn",
      hasActiveScreenTask: true,
    }),
    "voice"
  );
  assert.equal(
    resolveAdvisorTaskEvidenceSource({
      triggerSource: "response-action",
      hasActiveScreenTask: true,
    }),
    "screen"
  );
});

test("downgrades a cleared screen-anchored request to live mode", () => {
  const clearDecision = decideAdvisorScreenScope({
    triggerSource: "live-turn",
    relation: "new-parent",
    hasActiveScreenTask: true,
  });
  assert.equal(
    resolveAdvisorRequestModeForScreenScope(
      "screen-anchored",
      clearDecision
    ),
    "live"
  );
  assert.equal(
    resolveAdvisorRequestModeForScreenScope(
      "screen-anchored",
      decideAdvisorScreenScope({
        triggerSource: "live-turn",
        relation: "followup-parent",
        hasActiveScreenTask: true,
      })
    ),
    "screen-anchored"
  );
});

function makeParent(): ActiveInterviewParent {
  return {
    id: "parent-screen",
    source: "screen",
    stableKind: "general-system-design",
    topic: "Design a ticket service",
    playbookPhase: "requirement_clarification",
    phaseProgress: {},
    supportedFactAnchors: [],
    latestUsefulAnswer: "Clarify scale.",
    createdAt: 100,
    updatedAt: 110,
    revisions: 1,
  };
}

function makeScreenTask(): ActiveScreenTask {
  return {
    id: "screen-task-a",
    observationId: "screen-a",
    createdAt: 100,
    updatedAt: 110,
    question: "Design a ticket service",
    kind: "general-system-design",
    content: "Clarify scale.",
    basedOnTurnIds: [],
    basedOnObservationId: "screen-a",
  };
}
