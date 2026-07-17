import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import {
  applyManualQuestionTypeCorrectionToParent,
  decideManualQuestionTypeCorrection,
} from "../src/lib/meeting/manual-question-type-correction.js";
import type {
  ActiveInterviewChild,
  ActiveInterviewParent,
  SelectedInterviewPlaybook,
  WhiteboardArtifact,
} from "../src/lib/meeting/types.js";
import type { CanonicalQuestionType } from "../src/lib/meeting/task-taxonomy.js";

const now = 1_000;

test("treats selecting the effective question type as a no-op", () => {
  const decision = decideManualQuestionTypeCorrection(
    makeActiveTask({ questionType: "coding" }),
    "coding"
  );

  assert.equal(decision.noOp, true);
  assert.equal(decision.reason, "already-effective-question-type");
  assert.equal(decision.target, undefined);
});

test("resumes the existing parent when a child probe is corrected to the parent type", () => {
  const parent = makeInterviewParent({
    stableKind: "ai-ml-system-design",
    playbookPhase: "design_framing",
    child: makeChild({ questionType: "field-knowledge" }),
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
  assert.equal(next.previousUsefulAnswer, "latest coding answer");
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

function makeActiveTask({
  questionType,
  child,
}: {
  questionType: CanonicalQuestionType;
  child?: ActiveInterviewChild;
}): ActiveMeetingTask {
  return {
    id: "meeting_task_1",
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
