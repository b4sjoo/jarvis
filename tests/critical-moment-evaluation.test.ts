import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCriticalMomentCandidates,
  createCriticalMomentId,
  mergeCriticalMomentCandidates,
  upsertCriticalMomentEvaluation,
  type CriticalMomentTraceEvidence,
} from "../src/lib/meeting/critical-moment-evaluation.js";
import type { TranscriptTurn } from "../src/lib/meeting/types.js";

test("creates a stable candidate for a substantive turn with no trace", () => {
  const candidates = buildCriticalMomentCandidates({
    sessionId: "session-a",
    transcriptTurns: [
      turn("turn-1", "them", "How would you design a ticket system?", 100, 200),
    ],
    traces: [],
    now: 500,
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].traceJoinStatus, "none");
  assert.deepEqual(candidates[0].proposedTraceIds, []);
  assert.ok(candidates[0].candidateReasons.includes("zero-trace-opportunity"));
  assert.equal(candidates[0].proposedQuestionType, undefined);
});

test("deduplicates correction and regeneration traces under one moment", () => {
  const traces: CriticalMomentTraceEvidence[] = [
    trace("trace-initial", ["turn-1"], "unknown"),
    trace("trace-correction", ["turn-1"], "coding"),
    trace("trace-regeneration", ["turn-1"], "coding"),
  ];
  const candidates = buildCriticalMomentCandidates({
    sessionId: "session-a",
    transcriptTurns: [
      turn("turn-1", "them", "Implement a stack.", 100, 200),
    ],
    traces,
    now: 500,
  });

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].proposedTraceIds, [
    "trace-initial",
    "trace-correction",
    "trace-regeneration",
  ]);
  assert.equal(candidates[0].traceJoinStatus, "ambiguous");
});

test("composes a bounded split question but keeps adjacent parents separate", () => {
  const candidates = buildCriticalMomentCandidates({
    sessionId: "session-a",
    transcriptTurns: [
      turn("turn-1", "them", "For a ride sharing app,", 100, 200),
      turn("turn-2", "them", "how would you estimate write QPS?", 300, 450),
      turn("turn-3", "them", "Now design a cache.", 5_600, 5_800),
    ],
    traces: [],
    now: 6_000,
  });

  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates[0].sourceTurnIds, ["turn-1", "turn-2"]);
  assert.equal(candidates[1].sourceTurnIds[0], "turn-3");
});

test("uses source-turn identity instead of runtime type as human truth", () => {
  const candidate = buildCriticalMomentCandidates({
    sessionId: "session-a",
    transcriptTurns: [
      turn("turn-1", "them", "Tell me about a conflict.", 100, 200),
    ],
    traces: [trace("trace-1", ["turn-1"], "behavioral")],
    now: 500,
  })[0];
  const evaluations = upsertCriticalMomentEvaluation([], candidate, {
    eligibility: "critical",
  });

  assert.equal(candidate.proposedQuestionType, "behavioral");
  assert.equal(evaluations[0].expectedQuestionType, undefined);
  assert.equal(evaluations[0].eligibility, "critical");
});

test("retains old-window candidates while replacing recomposed current turns", () => {
  const oldCandidate = buildCriticalMomentCandidates({
    sessionId: "session-a",
    transcriptTurns: [
      turn("turn-old", "them", "Tell me about yourself.", 1, 2),
    ],
    traces: [],
    now: 10,
  })[0];
  const firstFragment = buildCriticalMomentCandidates({
    sessionId: "session-a",
    transcriptTurns: [
      turn("turn-1", "them", "For a ride sharing app,", 100, 200),
    ],
    traces: [],
    now: 300,
  })[0];
  const recomposed = buildCriticalMomentCandidates({
    sessionId: "session-a",
    transcriptTurns: [
      turn("turn-1", "them", "For a ride sharing app,", 100, 200),
      turn("turn-2", "them", "how would you estimate write QPS?", 300, 450),
    ],
    traces: [],
    now: 500,
  });
  const merged = mergeCriticalMomentCandidates(
    [oldCandidate, firstFragment],
    recomposed,
    "session-a"
  );

  assert.equal(merged.length, 2);
  assert.ok(merged.some((candidate) => candidate.momentId === oldCandidate.momentId));
  assert.ok(
    merged.some(
      (candidate) => candidate.sourceTurnIds.join(",") === "turn-1,turn-2"
    )
  );
  assert.ok(
    !merged.some((candidate) => candidate.momentId === firstFragment.momentId)
  );
});

test("moment identity is deterministic for canonical source turns", () => {
  assert.equal(
    createCriticalMomentId("session-a", ["turn-2", "turn-1", "turn-1"]),
    createCriticalMomentId("session-a", ["turn-1", "turn-2"])
  );
});

function turn(
  id: string,
  speaker: TranscriptTurn["speaker"],
  text: string,
  startedAt: number,
  endedAt: number
): TranscriptTurn {
  return {
    id,
    speaker,
    text,
    startedAt,
    endedAt,
    isFinal: true,
    source: speaker === "me" ? "microphone" : "system-audio",
  };
}

function trace(
  traceId: string,
  sourceTurnIds: string[],
  questionType: string
): CriticalMomentTraceEvidence {
  return {
    traceId,
    logicalQuestionUnitId: "lqu-1",
    sourceTurnIds,
    questionType,
  };
}
