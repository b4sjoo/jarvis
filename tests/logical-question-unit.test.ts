import assert from "node:assert/strict";
import test from "node:test";
import {
  LOGICAL_QUESTION_MAX_CHARS,
  composeLogicalQuestionUnit,
} from "../src/lib/meeting/logical-question-unit.js";
import { decideAdvisorTurnIntent } from "../src/lib/meeting/advisor-turn-intent.js";
import type { TranscriptTurn } from "../src/lib/meeting/types.js";
import {
  createPendingInterviewSectionHint,
  detectInterviewSectionTransition,
} from "../src/lib/meeting/interview-section-transition.js";

function turn(
  id: string,
  text: string,
  startedAt: number,
  speaker: TranscriptTurn["speaker"] = "them"
): TranscriptTurn {
  return {
    id,
    text,
    speaker,
    source: speaker === "me" ? "microphone" : "system-audio",
    startedAt,
    endedAt: startedAt + 100,
    isFinal: true,
  };
}

test("composes a bounded coding question with adjacent constraints", () => {
  const initial = composeLogicalQuestionUnit({
    currentTurn: turn(
      "turn_problem",
      "Find every text file below a directory and return the matching paths.",
      1_000
    ),
    sessionId: "session-a",
    runtimeEpoch: 1,
    intentDecision: decideAdvisorTurnIntent(
      "Find every text file below a directory and return the matching paths.",
      { hasActiveTask: false }
    ),
    now: 1_100,
  });
  const withLanguage = composeLogicalQuestionUnit({
    currentTurn: turn("turn_language", "Use Python without os.walk.", 2_000),
    sessionId: "session-a",
    runtimeEpoch: 1,
    intentDecision: decideAdvisorTurnIntent("Use Python without os.walk.", {
      hasActiveTask: false,
      hasRecentQuestionContext: true,
    }),
    previousUnit: initial,
    now: 2_100,
  });
  const withComplexity = composeLogicalQuestionUnit({
    currentTurn: turn(
      "turn_complexity",
      "Can you improve the time complexity?",
      3_000
    ),
    sessionId: "session-a",
    runtimeEpoch: 1,
    intentDecision: decideAdvisorTurnIntent(
      "Can you improve the time complexity?",
      { hasActiveTask: false, hasRecentQuestionContext: true }
    ),
    previousUnit: withLanguage,
    now: 3_100,
  });

  assert.deepEqual(withComplexity.sourceTurnIds, [
    "turn_problem",
    "turn_language",
    "turn_complexity",
  ]);
  assert.equal(initial.revision, 1);
  assert.equal(withLanguage.revision, 2);
  assert.equal(withComplexity.revision, 3);
  assert.match(withComplexity.normalizedText, /every text file/);
  assert.match(withComplexity.normalizedText, /without os\.walk/);
  assert.match(withComplexity.normalizedText, /time complexity/);
});

test("starts a new unit for an independent question or explicit switch", () => {
  const previous = composeLogicalQuestionUnit({
    currentTurn: turn("turn_old", "Implement a queue using two stacks.", 1_000),
    sessionId: "session-a",
    runtimeEpoch: 1,
  });
  const next = composeLogicalQuestionUnit({
    currentTurn: turn("turn_new", "Design a ride sharing service.", 2_000),
    sessionId: "session-a",
    runtimeEpoch: 1,
    intentDecision: decideAdvisorTurnIntent(
      "Design a ride sharing service.",
      { hasActiveTask: true }
    ),
    previousUnit: previous,
    explicitTaskSwitch: true,
  });

  assert.notEqual(next.id, previous.id);
  assert.equal(next.revision, 1);
  assert.deepEqual(next.sourceTurnIds, ["turn_new"]);
  assert.equal(next.boundaryReason, "explicit-task-switch");
});

test("freezes an applied section hint into the owned logical question", () => {
  const hint = createPendingInterviewSectionHint({
    detection: detectInterviewSectionTransition(
      "Now let's move on to general system design."
    ),
    sourceTurnId: "turn_section",
    sourceText: "Now let's move on to general system design.",
    sessionId: "session-a",
    runtimeEpoch: 1,
    observedAt: 1_000,
    id: "hint-general-design",
  });
  const unit = composeLogicalQuestionUnit({
    currentTurn: turn(
      "turn_question",
      "Design a food delivery app like DoorDash.",
      2_000
    ),
    sessionId: "session-a",
    runtimeEpoch: 1,
    explicitTaskSwitch: true,
    sectionHint: hint ? { ...hint, disposition: "applied" } : undefined,
  });

  assert.equal(unit.sectionHint?.id, "hint-general-design");
  assert.equal(unit.sectionHint?.questionType, "general-system-design");
  assert.equal(unit.boundaryReason, "no-previous-logical-question");
});

test("does not cross a substantive me answer or runtime boundary", () => {
  const previous = composeLogicalQuestionUnit({
    currentTurn: turn("turn_old", "Design a ranking service.", 1_000),
    sessionId: "session-a",
    runtimeEpoch: 1,
  });
  const next = composeLogicalQuestionUnit({
    currentTurn: turn("turn_followup", "What metrics would you use?", 3_000),
    sessionId: "session-a",
    runtimeEpoch: 1,
    intentDecision: decideAdvisorTurnIntent("What metrics would you use?", {
      hasActiveTask: true,
    }),
    previousUnit: previous,
    interveningTurns: [
      {
        ...turn("turn_me", "x".repeat(180), 2_000, "me"),
        contextTier: "me_attempted_answer_long",
      },
    ],
  });
  const newEpoch = composeLogicalQuestionUnit({
    currentTurn: turn("turn_epoch", "In Python?", 4_000),
    sessionId: "session-a",
    runtimeEpoch: 2,
    intentDecision: decideAdvisorTurnIntent("In Python?", {
      hasActiveTask: false,
      hasRecentQuestionContext: true,
    }),
    previousUnit: previous,
  });

  assert.deepEqual(next.sourceTurnIds, ["turn_followup"]);
  assert.equal(next.boundaryReason, "substantive-me-answer-boundary");
  assert.deepEqual(newEpoch.sourceTurnIds, ["turn_epoch"]);
  assert.equal(newEpoch.boundaryReason, "runtime-boundary");
});

test("caps source turns, age, and normalized characters", () => {
  let unit = composeLogicalQuestionUnit({
    currentTurn: turn("turn_0", "a".repeat(700), 1_000),
    sessionId: "session-a",
    runtimeEpoch: 1,
  });
  for (let index = 1; index <= 5; index += 1) {
    const current = turn(`turn_${index}`, `Use Python ${"b".repeat(200)}`, 1_000 + index * 1_000);
    unit = composeLogicalQuestionUnit({
      currentTurn: current,
      sessionId: "session-a",
      runtimeEpoch: 1,
      intentDecision: decideAdvisorTurnIntent(current.text, {
        hasActiveTask: false,
        hasRecentQuestionContext: true,
      }),
      previousUnit: unit,
    });
  }

  assert.equal(unit.sources.length, 4);
  assert.ok(unit.normalizedText.length <= LOGICAL_QUESTION_MAX_CHARS);
  assert.equal(unit.truncated, true);
});
