import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import {
  createSourceOwnedSetupCandidate,
  selectSourceOwnedSemanticContext,
} from "../src/lib/meeting/source-owned-semantic-context.js";
import type { TranscriptTurn } from "../src/lib/meeting/types.js";

function task(parentId = "parent-oasis"): ActiveMeetingTask {
  return {
    id: parentId,
    runtimeRevision: 2,
    source: "voice",
    parent: {
      id: parentId,
      questionType: "project-deep-dive",
      topic: "Oasis reliability tradeoffs",
      playbookPhase: "architecture_decision",
      phaseProgress: {},
      supportedFactAnchors: [],
      createdAt: 1,
      updatedAt: 1,
      revisions: 4,
    },
  };
}

function turn(
  id: string,
  text: string,
  startedAt: number,
  endedAt: number
): TranscriptTurn {
  return {
    id,
    speaker: "them",
    text,
    startedAt,
    endedAt,
    isFinal: true,
    source: "system-audio",
  };
}

function unit(source: TranscriptTurn): LogicalQuestionUnit {
  return {
    id: "lqu-monitor",
    revision: 1,
    sessionId: "session-a",
    runtimeEpoch: 3,
    currentTurnId: source.id,
    sourceTurnIds: [source.id],
    sources: [
      {
        turnId: source.id,
        text: source.text,
        startedAt: source.startedAt,
        endedAt: source.endedAt,
      },
    ],
    normalizedText: source.text,
    startedAt: source.startedAt,
    updatedAt: source.endedAt,
    compositionReasons: ["independent-current-turn"],
    boundaryReason: "independent-current-turn",
    truncated: false,
  };
}

test("selects one adjacent same-parent non-acknowledgement setup turn", () => {
  const setup = turn(
    "turn-setup",
    "The key tradeoff is consistency and availability during partial failures.",
    100,
    200
  );
  const acknowledgement = turn("turn-ack", "Mm-hmm.", 210, 220);
  const ask = turn(
    "turn-ask",
    "How would you reason about it?",
    230,
    260
  );
  const candidate = createSourceOwnedSetupCandidate({
    turn: setup,
    sessionId: "session-a",
    runtimeEpoch: 3,
    activeMeetingTask: task(),
  });
  assert.ok(candidate);

  const selection = selectSourceOwnedSemanticContext({
    candidate,
    sessionId: "session-a",
    runtimeEpoch: 3,
    logicalQuestionUnit: unit(ask),
    activeMeetingTask: task(),
    transcriptTurns: [setup, acknowledgement, ask],
  });

  assert.equal(selection.reason, "selected-same-parent-adjacent-setup");
  assert.equal(selection.context?.text, setup.text);
  assert.deepEqual(selection.context?.sourceTurnIds, [setup.id]);
  assert.equal(selection.consumeCandidate, true);
});

test("rejects cross-parent or intervening substantive setup context", () => {
  const setup = turn("turn-setup", "The cache is write heavy.", 100, 200);
  const intervening = turn(
    "turn-intervening",
    "The interviewer supplied a new latency constraint.",
    210,
    220
  );
  const ask = turn("turn-ask", "What would you monitor?", 230, 260);
  const candidate = createSourceOwnedSetupCandidate({
    turn: setup,
    sessionId: "session-a",
    runtimeEpoch: 3,
    activeMeetingTask: task(),
  });
  assert.ok(candidate);

  assert.equal(
    selectSourceOwnedSemanticContext({
      candidate,
      sessionId: "session-a",
      runtimeEpoch: 3,
      logicalQuestionUnit: unit(ask),
      activeMeetingTask: task(),
      transcriptTurns: [setup, intervening, ask],
    }).reason,
    "intervening-source-turn"
  );
  assert.equal(
    selectSourceOwnedSemanticContext({
      candidate,
      sessionId: "session-a",
      runtimeEpoch: 3,
      logicalQuestionUnit: unit(ask),
      activeMeetingTask: task("parent-other"),
      transcriptTurns: [setup, ask],
    }).reason,
    "active-parent-mismatch"
  );
});

test("does not consume setup while it remains part of the current LQU", () => {
  const setup = turn("turn-setup", "The cache is write heavy.", 100, 200);
  const candidate = createSourceOwnedSetupCandidate({
    turn: setup,
    sessionId: "session-a",
    runtimeEpoch: 3,
    activeMeetingTask: task(),
  });
  assert.ok(candidate);
  const selection = selectSourceOwnedSemanticContext({
    candidate,
    sessionId: "session-a",
    runtimeEpoch: 3,
    logicalQuestionUnit: unit(setup),
    activeMeetingTask: task(),
    transcriptTurns: [setup],
  });

  assert.equal(selection.reason, "candidate-is-current-source");
  assert.equal(selection.consumeCandidate, false);
});
