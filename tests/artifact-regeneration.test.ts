import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveArtifactRegenerationTarget } from "../src/lib/meeting/artifact-regeneration.js";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import type { StableAnswerRevision } from "../src/lib/meeting/stable-answer.js";
import type { CurrentQuestionSettlementDecision } from "../src/lib/meeting/current-question-settlement.js";

function settlement(
  questionType: CurrentQuestionSettlementDecision["questionType"],
  relation: CurrentQuestionSettlementDecision["relation"] =
    "followup-parent"
): CurrentQuestionSettlementDecision {
  return {
    settlementId: "settlement-a",
    logicalQuestionUnitId: "lqu-a",
    revision: 1,
    sessionId: "session-a",
    runtimeEpoch: 2,
    sourceKind: "voice",
    sourceTurnIds: ["turn-a"],
    sourceObservationIds: [],
    sourceHash: "source-a",
    questionType,
    relation,
    action: "answer",
    evidenceMode: "unknown",
    authority: "runtime-adjudication",
    authoritySource: "runtime-adjudication",
    typeAuthoritySource: "runtime-adjudication",
    relationAuthoritySource: "runtime-adjudication",
    actionAuthoritySource: "runtime-adjudication",
    typeMutationAuthorized: true,
    relationMutationAuthorized: true,
    parentMutationAuthorized: false,
    responseAuthorized: true,
    confidence: 0.95,
    activeParentId: "parent-a",
    activeParentRevision: 3,
    manualCorrectionRevision: 0,
    rejectedProposals: [],
    reasons: ["test"],
  };
}

function stable(
  questionType: CurrentQuestionSettlementDecision["questionType"],
  relation: CurrentQuestionSettlementDecision["relation"] =
    "followup-parent"
): StableAnswerRevision {
  const frozen = settlement(questionType, relation);
  return {
    revision: 5,
    sessionId: "session-a",
    runtimeEpoch: 2,
    taskId: "parent-a",
    logicalQuestionUnitId: "lqu-a",
    logicalQuestionRevision: 1,
    questionSourceHash: "source-a",
    settlementId: "settlement-a",
    settlementSnapshot: frozen,
    suggestion: {
      id: "answer-a",
      kind: "answer",
      content: "Answer: Existing answer.",
      createdAt: 1,
      basedOnTurnIds: ["turn-a"],
      basedOnObservationIds: [],
      confidence: "high",
    },
    sections: {} as StableAnswerRevision["sections"],
    committedAt: 1,
  };
}

function task(
  questionType: ActiveMeetingTask["parent"]["questionType"],
  phase: ActiveMeetingTask["parent"]["playbookPhase"]
): ActiveMeetingTask {
  return {
    id: "parent-a",
    runtimeRevision: 3,
    source: "voice",
    parent: {
      id: "parent-a",
      questionType,
      topic: "Current task",
      playbookPhase: phase,
      phaseProgress: {},
      supportedFactAnchors: [],
      createdAt: 1,
      updatedAt: 2,
      revisions: 3,
    },
  };
}

test("authorizes the current Design Whiteboard", () => {
  const decision = resolveArtifactRegenerationTarget({
    stableAnswer: stable("general-system-design"),
    activeMeetingTask: task("general-system-design", "design_framing"),
    sessionId: "session-a",
    runtimeEpoch: 2,
  });

  assert.equal(decision.authorized, true);
  assert.deepEqual(decision.target?.artifactFamilies, ["whiteboard"]);
});

test("authorizes Coding only in implementation phase", () => {
  const baseline = resolveArtifactRegenerationTarget({
    stableAnswer: stable("coding"),
    activeMeetingTask: task("coding", "baseline_reasoning"),
    sessionId: "session-a",
    runtimeEpoch: 2,
  });
  const implementation = resolveArtifactRegenerationTarget({
    stableAnswer: stable("coding"),
    activeMeetingTask: task("coding", "implementation_validation"),
    sessionId: "session-a",
    runtimeEpoch: 2,
  });

  assert.equal(baseline.reason, "artifact-not-owned-by-current-phase");
  assert.deepEqual(implementation.target?.artifactFamilies, [
    "code",
    "complexity",
  ]);
});

test("does not mutate a parent Artifact from a Field Knowledge child", () => {
  const activeTask = task("ai-ml-system-design", "design_framing");
  activeTask.child = {
    id: "child-field",
    createdAt: 2,
    updatedAt: 2,
    questionType: "field-knowledge",
    relation: "child-probe",
    intent: "concept-probe",
    question: "What is HNSW?",
    basedOnTurnIds: ["turn-a"],
    basedOnObservationIds: [],
  };
  const decision = resolveArtifactRegenerationTarget({
    stableAnswer: stable("field-knowledge", "child-probe"),
    activeMeetingTask: activeTask,
    sessionId: "session-a",
    runtimeEpoch: 2,
  });

  assert.equal(decision.reason, "no-regenerable-artifact");
});

test("rejects a visible Answer owned by another parent", () => {
  const activeTask = task("general-system-design", "design_framing");
  activeTask.parent.id = "parent-new";
  const decision = resolveArtifactRegenerationTarget({
    stableAnswer: stable("general-system-design"),
    activeMeetingTask: activeTask,
    sessionId: "session-a",
    runtimeEpoch: 2,
  });

  assert.equal(decision.reason, "visible-answer-owner-mismatch");
});

test("routes the manual action through the shared Advisor and atomic publisher", () => {
  const source = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
  const actionStart = source.indexOf(
    'if (responseAction === "regenerate-artifacts")'
  );
  const actionEnd = source.indexOf(
    'if (responseAction === "next-phase"',
    actionStart
  );
  const actionSource = source.slice(actionStart, actionEnd);

  assert.match(actionSource, /resolveArtifactRegenerationTarget\(/);
  assert.match(actionSource, /artifactRegenerationTarget: target/);
  assert.match(source, /commitStableArtifactOnlyRevision\(\{/);
  assert.match(source, /artifactOnly: Boolean\(/);
});
