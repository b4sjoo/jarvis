import assert from "node:assert/strict";
import test from "node:test";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import {
  readBoundedGeneratedContinuity,
  type BoundedGeneratedContinuityState,
} from "../src/lib/meeting/bounded-recent-history.js";
import {
  decideCrossDomainParentTransition,
  formatCrossDomainParentTransitionForTrace,
} from "../src/lib/meeting/cross-domain-task-transition.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import { buildBoundedParentContextHandoff } from "../src/lib/meeting/manual-question-type-correction.js";
import {
  buildCommittedTaskBoundaryParent,
  createTaskBoundaryCandidate,
} from "../src/lib/meeting/task-boundary-transaction.js";
import { inferQuestionTypeDecisionFromText } from "../src/lib/meeting/task-taxonomy.js";
import type {
  ActiveInterviewParent,
  TranscriptTurn,
} from "../src/lib/meeting/types.js";
import { setTestActiveParent } from "./helpers/meeting-task-runtime.js";

function parent(
  stableKind: ActiveInterviewParent["stableKind"],
  topic: string
): ActiveInterviewParent {
  return {
    id: `parent-${stableKind}`,
    source: "voice",
    stableKind,
    topic,
    playbookPhase: "follow_up",
    phaseProgress: { follow_up: true },
    supportedFactAnchors: [],
    createdAt: 1,
    updatedAt: 2,
    startTurnId: "turn-general",
    revisions: 2,
  };
}

function logicalQuestion(
  manager: MeetingContextManager,
  turnId: string,
  text: string,
  runtimeEpoch = 1
): LogicalQuestionUnit {
  return {
    id: `logical-${turnId}`,
    revision: 1,
    sessionId: manager.getState().sessionId,
    runtimeEpoch,
    currentTurnId: turnId,
    sourceTurnIds: [turnId],
    sources: [{ turnId, text, startedAt: runtimeEpoch, endedAt: runtimeEpoch }],
    normalizedText: text,
    startedAt: runtimeEpoch,
    updatedAt: runtimeEpoch,
    compositionReasons: ["current-turn"],
    boundaryReason: "current-turn-only",
    truncated: false,
  };
}

test("keeps coding to general system design as an independent parent", () => {
  const decision = decideCrossDomainParentTransition({
    previousParent: parent("coding", "Implement sliding window maximum"),
    nextQuestionType: "general-system-design",
    nextQuestionText: "Now design a ride-sharing service.",
  });

  assert.equal(decision.kind, "independent-new-parent");
  assert.equal(
    decision.reason,
    "cross-domain-transition-is-not-general-sd-to-ai-ml-extension"
  );
});

test("does not link an unrelated AI/ML design to the prior general design", () => {
  const decision = decideCrossDomainParentTransition({
    previousParent: parent(
      "general-system-design",
      "Design a ride-sharing application"
    ),
    nextQuestionType: "ai-ml-system-design",
    nextQuestionText:
      "Next question: design a self-evolving travel recommendation agent.",
  });

  assert.equal(decision.kind, "independent-new-parent");
  assert.ok(decision.evidence.includes("explicit-independent-switch"));
});

test("links an AI/ML extension of the same product with bounded evidence", () => {
  const previousParent = parent(
    "general-system-design",
    "Design a food delivery app"
  );
  const decision = decideCrossDomainParentTransition({
    previousParent,
    nextQuestionType: "ai-ml-system-design",
    nextQuestionText:
      "For this app, design a self-evolving food recommendation agent.",
  });

  assert.equal(decision.kind, "linked-parent-extension");
  assert.ok(decision.evidence.includes("explicit-same-product-marker"));
  assert.equal(
    formatCrossDomainParentTransitionForTrace(decision)
      .parentContextHandoffKind,
    "bounded-source-backed"
  );
});

test("the linked handoff carries source facts but excludes old QPS and answers", () => {
  const previousParent = parent(
    "general-system-design",
    "Design a food delivery app"
  );
  const previousOwner = {
    sessionId: "session-output",
    runtimeEpoch: 1,
    parentTaskId: previousParent.id,
  };
  const output: BoundedGeneratedContinuityState = {
    owner: previousOwner,
    latestUsefulAnswer: "Generated answer that must not cross the boundary",
    recentCapsules: [],
  };
  assert.equal(readBoundedGeneratedContinuity({
    state: output, currentOwner: previousOwner,
  }).latestUsefulAnswer, output.latestUsefulAnswer);
  const transcriptTurns: TranscriptTurn[] = [
    {
      id: "turn-general",
      speaker: "them",
      source: "system-audio",
      text: "Design a food delivery app for 10 million daily active users.",
      startedAt: 1,
      endedAt: 2,
      isFinal: true,
    },
    {
      id: "turn-qps",
      speaker: "me",
      source: "microphone",
      text: "That is about 50 thousand GPS writes per second.",
      startedAt: 3,
      endedAt: 4,
      isFinal: true,
    },
    {
      id: "turn-ai",
      speaker: "them",
      source: "system-audio",
      text: "For this app, design a food recommendation agent.",
      startedAt: 5,
      endedAt: 6,
      isFinal: true,
    },
  ];
  const handoff = buildBoundedParentContextHandoff({
    parent: previousParent,
    sourceQuestionId: "question-ai",
    latestQuestionText: transcriptTurns[2].text,
    transcriptTurns,
    boundaryTurnId: "turn-ai",
  });
  const manager = new MeetingContextManager();
  transcriptTurns.forEach((turn) => manager.addTranscriptTurn(turn));
  const logicalQuestion: LogicalQuestionUnit = {
    id: "logical-ai",
    revision: 1,
    sessionId: manager.getState().sessionId,
    runtimeEpoch: 1,
    currentTurnId: "turn-ai",
    sourceTurnIds: ["turn-ai"],
    sources: [
      {
        turnId: "turn-ai",
        text: transcriptTurns[2].text,
        startedAt: 5,
        endedAt: 6,
      },
    ],
    normalizedText: transcriptTurns[2].text,
    startedAt: 5,
    updatedAt: 6,
    compositionReasons: ["current-turn"],
    boundaryReason: "current-turn-only",
    truncated: false,
  };
  const candidate = createTaskBoundaryCandidate({
    logicalQuestionUnit: logicalQuestion,
    proposedQuestionType: "ai-ml-system-design",
    proposedRelation: "new-parent",
    authoritySource: "accepted-transcript",
    confidence: 0.96,
    questionComplete: true,
    mutationAuthorized: true,
    commitParent: true,
  });
  assert.ok(candidate);
  const nextParent = buildCommittedTaskBoundaryParent({
    candidate,
    logicalQuestionUnit: logicalQuestion,
    source: "voice",
    parentContextHandoff: handoff,
  });
  assert.ok(nextParent);
  setTestActiveParent(manager, nextParent);

  const activeTask = manager.buildAdvisorPromptContext().activeMeetingTask;
  const serialized = JSON.stringify(activeTask);
  assert.match(serialized, /food delivery/);
  assert.match(serialized, /10 million daily active users/);
  assert.doesNotMatch(serialized, /50 thousand GPS writes/);
  assert.doesNotMatch(serialized, /Generated answer/);
  assert.ok(handoff.excludedContextKinds.includes("generated-answers"));
  assert.equal("latestUsefulAnswer" in nextParent, false);
  assert.deepEqual(readBoundedGeneratedContinuity({
    state: output,
    currentOwner: { ...previousOwner, parentTaskId: nextParent.id },
  }), { source: "generated-continuity", recentCapsules: [] });
  assert.equal(activeTask?.parent.playbookPhase, "follow_up");
});

test("replays coding to general SD to independent AI/ML SD without parent leakage", () => {
  const manager = new MeetingContextManager();
  const questions = [
    {
      turnId: "turn-coding",
      text: "Implement sliding window maximum using a deque",
      expectedType: "coding",
    },
    {
      turnId: "turn-rideshare",
      text: "Next question: design a ride-sharing service",
      expectedType: "general-system-design",
    },
    {
      turnId: "turn-travel-agent",
      text: "Now design a self-evolving travel recommendation agent",
      expectedType: "ai-ml-system-design",
    },
  ] as const;

  for (const [index, question] of questions.entries()) {
    manager.addTranscriptTurn({
      id: question.turnId,
      speaker: "them",
      source: "system-audio",
      text: question.text,
      startedAt: index + 1,
      endedAt: index + 1,
      isFinal: true,
    });
    const inferred = inferQuestionTypeDecisionFromText(question.text);
    assert.equal(inferred.type, question.expectedType);
    const unit = logicalQuestion(
      manager,
      question.turnId,
      question.text,
      index + 1
    );
    const currentParent = manager.getState().taskRuntime.parent;
    const transition = decideCrossDomainParentTransition({
      previousParent: currentParent,
      nextQuestionType: inferred.type,
      nextQuestionText: question.text,
    });
    assert.equal(transition.kind, "independent-new-parent");
    const candidate = createTaskBoundaryCandidate({
      logicalQuestionUnit: unit,
      proposedQuestionType: inferred.type,
      proposedRelation: "new-parent",
      authoritySource: "accepted-transcript",
      confidence: inferred.confidence,
      questionComplete: true,
      mutationAuthorized: true,
      commitParent: true,
    });
    assert.ok(candidate);
    const nextParent = buildCommittedTaskBoundaryParent({
      candidate,
      logicalQuestionUnit: unit,
      source: "voice",
    });
    assert.ok(nextParent);
    setTestActiveParent(manager, nextParent);
  }

  const prompt = manager.buildAdvisorPromptContext();
  assert.equal(prompt.activeMeetingTask?.parent.questionType, "ai-ml-system-design");
  assert.match(prompt.transcript, /self-evolving travel recommendation agent/);
  assert.doesNotMatch(prompt.transcript, /sliding window maximum/);
  assert.doesNotMatch(prompt.transcript, /ride-sharing service/);
  assert.equal(prompt.activeMeetingTask?.parent.parentContextHandoff, undefined);
});
