import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import {
  appendSourceOwnedSetupCandidate,
  createSourceOwnedSetupCandidate,
  selectPreviousLogicalQuestionContext,
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

test("consumes a setup candidate already owned by the current LQU", () => {
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
  assert.equal(selection.consumeCandidate, true);
});

test("groups multiple no-parent informative turns across a long question", () => {
  const first = createSourceOwnedSetupCandidate({
    turn: turn(
      "turn-context-1",
      "The corpus contains PDFs and wiki pages.",
      0,
      10_000
    ),
    sessionId: "session-a",
    runtimeEpoch: 3,
  });
  const second = createSourceOwnedSetupCandidate({
    turn: turn(
      "turn-context-2",
      "Documents have per-user access control lists.",
      50_000,
      60_000
    ),
    sessionId: "session-a",
    runtimeEpoch: 3,
  });
  const third = createSourceOwnedSetupCandidate({
    turn: turn(
      "turn-context-3",
      "Freshness matters because documents change frequently.",
      100_000,
      110_000
    ),
    sessionId: "session-a",
    runtimeEpoch: 3,
  });
  assert.ok(first);
  assert.ok(second);
  assert.ok(third);
  const group = appendSourceOwnedSetupCandidate(
    appendSourceOwnedSetupCandidate(first, second),
    third
  );
  assert.deepEqual(group.sourceTurnIds, [
    "turn-context-1",
    "turn-context-2",
    "turn-context-3",
  ]);

  const ask = turn(
    "turn-ask",
    "How would you chunk and index them?",
    140_000,
    141_000
  );
  const selection = selectSourceOwnedSemanticContext({
    candidate: group,
    sessionId: "session-a",
    runtimeEpoch: 3,
    logicalQuestionUnit: unit(ask),
    transcriptTurns: [
      ...group.sources.map((source) =>
        turn(source.turnId, source.text, source.startedAt, source.endedAt)
      ),
      ask,
    ],
  });
  assert.equal(selection.reason, "selected-recent-source-context");
  assert.deepEqual(selection.context?.sourceTurnIds, group.sourceTurnIds);
  assert.match(selection.context?.text ?? "", /PDFs/);
  assert.match(selection.context?.text ?? "", /Freshness/);
});

test("expires orphan context after a source gap greater than 45 seconds", () => {
  const setup = turn(
    "turn-context",
    "The corpus contains PDFs with access controls.",
    0,
    1_000
  );
  const candidate = createSourceOwnedSetupCandidate({
    turn: setup,
    sessionId: "session-a",
    runtimeEpoch: 3,
  });
  assert.ok(candidate);
  const ask = turn(
    "turn-late-ask",
    "How would you index them?",
    47_000,
    48_000
  );
  const selection = selectSourceOwnedSemanticContext({
    candidate,
    sessionId: "session-a",
    runtimeEpoch: 3,
    logicalQuestionUnit: unit(ask),
    transcriptTurns: [setup, ask],
  });
  assert.equal(selection.reason, "candidate-expired");
  assert.equal(selection.context, undefined);
  assert.equal(selection.consumeCandidate, true);
});

test("excludes explicit meeting logistics from recent source context", () => {
  const candidate = createSourceOwnedSetupCandidate({
    turn: turn(
      "turn-logistics",
      "Hold on one second while I share my screen.",
      0,
      1_000
    ),
    sessionId: "session-a",
    runtimeEpoch: 3,
  });
  assert.equal(candidate, undefined);
});

test("selects the previous effective LQU inside the rolling source window", () => {
  const previousTurn = turn(
    "turn-previous",
    "How would you evaluate retrieval quality?",
    1_000,
    2_000
  );
  const previous = {
    ...unit(previousTurn),
    id: "lqu-previous",
  };
  const currentTurn = turn(
    "turn-current",
    "What would you monitor in production?",
    30_000,
    31_000
  );
  const selection = selectPreviousLogicalQuestionContext({
    previousLogicalQuestionUnit: previous,
    currentLogicalQuestionUnit: unit(currentTurn),
    effectiveRecords: [
      {
        recordId: "record-previous",
        sessionId: "session-a",
        runtimeEpoch: 3,
        logicalQuestionUnitId: "lqu-previous",
        logicalQuestionRevision: 1,
        sourceHash: "source-previous",
        sourceTurnIds: [previousTurn.id],
        text: previousTurn.text,
        startedAt: previous.startedAt,
        updatedAt: previous.updatedAt,
        speechAct: "question",
        disposition: "answer-primary-ask",
        relation: "followup-parent",
        owner: { kind: "parent-mainline", parentId: "parent-oasis" },
        settledAt: 2_500,
      },
    ],
  });

  assert.equal(selection.reason, "selected-previous-logical-question");
  assert.deepEqual(selection.sourceTurnIds, [previousTurn.id]);
  assert.equal(selection.logicalQuestionUnitId, "lqu-previous");
});

test("rejects an expired or explicitly separated previous LQU", () => {
  const previousTurn = turn(
    "turn-previous",
    "How would you evaluate retrieval quality?",
    1_000,
    2_000
  );
  const previous = { ...unit(previousTurn), id: "lqu-previous" };
  const current = unit(
    turn(
      "turn-current",
      "Design a separate notification service.",
      48_000,
      49_000
    )
  );

  assert.equal(
    selectPreviousLogicalQuestionContext({
      previousLogicalQuestionUnit: previous,
      currentLogicalQuestionUnit: current,
      effectiveRecords: [],
    }).reason,
    "previous-source-expired"
  );
  assert.equal(
    selectPreviousLogicalQuestionContext({
      previousLogicalQuestionUnit: previous,
      currentLogicalQuestionUnit: { ...current, startedAt: 30_000 },
      effectiveRecords: [],
      explicitBoundary: true,
    }).reason,
    "explicit-boundary"
  );
});
