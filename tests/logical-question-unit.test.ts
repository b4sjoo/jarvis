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
import { projectPrimaryAsk } from "../src/lib/meeting/primary-ask-projection.js";

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

test("composes a short referential action with recent technical context", () => {
  const problem = turn(
    "turn_problem",
    "Search a directory recursively and return every text file modified after a given date.",
    1_000
  );
  const constraint = turn(
    "turn_constraint",
    "The function should return all matching file paths instead of stopping after the first file.",
    2_000
  );
  const previous = composeLogicalQuestionUnit({
    currentTurn: constraint,
    sessionId: "session-a",
    runtimeEpoch: 1,
  });
  const current = turn(
    "turn_script",
    "So give me a Python script for that.",
    3_000
  );

  const unit = composeLogicalQuestionUnit({
    currentTurn: current,
    sessionId: "session-a",
    runtimeEpoch: 1,
    intentDecision: decideAdvisorTurnIntent(current.text, {
      hasActiveTask: false,
      hasRecentQuestionContext: true,
    }),
    previousUnit: previous,
    recentThemTurns: [problem, constraint],
  });

  assert.equal(unit.id, previous.id);
  assert.deepEqual(unit.sourceTurnIds, [
    "turn_problem",
    "turn_constraint",
    "turn_script",
  ]);
  assert.match(unit.normalizedText, /recursively/);
  assert.match(unit.normalizedText, /all matching file paths/);
  assert.match(unit.normalizedText, /script for that/);
  assert.ok(unit.compositionReasons.includes("referential-completion"));
});

test("does not treat a referential acknowledgement as an action request", () => {
  const previousTurn = turn(
    "turn_design",
    "Use a queue and a worker service to process every file in the directory.",
    1_000
  );
  const previous = composeLogicalQuestionUnit({
    currentTurn: previousTurn,
    sessionId: "session-a",
    runtimeEpoch: 1,
  });
  const current = turn("turn_ack", "That looks good.", 2_000);

  const unit = composeLogicalQuestionUnit({
    currentTurn: current,
    sessionId: "session-a",
    runtimeEpoch: 1,
    intentDecision: decideAdvisorTurnIntent(current.text, {
      hasActiveTask: true,
      hasRecentQuestionContext: true,
    }),
    previousUnit: previous,
    recentThemTurns: [previousTurn],
  });

  assert.notEqual(unit.id, previous.id);
  assert.deepEqual(unit.sourceTurnIds, ["turn_ack"]);
  assert.equal(unit.boundaryReason, "independent-current-turn");
});

test("referential completion respects parent and me-answer boundaries", () => {
  const previousTurn = turn(
    "turn_problem",
    "Implement a function that scans every file in a directory recursively.",
    1_000
  );
  const previous = composeLogicalQuestionUnit({
    currentTurn: previousTurn,
    sessionId: "session-a",
    runtimeEpoch: 1,
  });
  const current = turn("turn_script", "Write the code for that.", 3_000);
  const withParentBoundary = composeLogicalQuestionUnit({
    currentTurn: current,
    sessionId: "session-a",
    runtimeEpoch: 1,
    previousUnit: previous,
    recentThemTurns: [previousTurn],
    committedParentBoundary: true,
  });
  const withMeBoundary = composeLogicalQuestionUnit({
    currentTurn: current,
    sessionId: "session-a",
    runtimeEpoch: 1,
    previousUnit: previous,
    recentThemTurns: [previousTurn],
    interveningTurns: [
      {
        ...turn("turn_me", "x".repeat(180), 2_000, "me"),
        contextTier: "me_attempted_answer_long",
      },
    ],
  });

  assert.deepEqual(withParentBoundary.sourceTurnIds, ["turn_script"]);
  assert.equal(withParentBoundary.boundaryReason, "committed-parent-boundary");
  assert.deepEqual(withMeBoundary.sourceTurnIds, ["turn_script"]);
  assert.equal(withMeBoundary.boundaryReason, "substantive-me-answer-boundary");
});

test("referential completion uses its bounded 45 second window", () => {
  const previousTurn = turn(
    "turn_problem",
    "Implement a function that scans every file in a directory recursively.",
    1_000
  );
  const previous = composeLogicalQuestionUnit({
    currentTurn: previousTurn,
    sessionId: "session-a",
    runtimeEpoch: 1,
  });
  const withinWindow = turn(
    "turn_within",
    "Write the code for that.",
    40_000
  );
  const expired = turn("turn_expired", "Write the code for that.", 50_000);

  const composed = composeLogicalQuestionUnit({
    currentTurn: withinWindow,
    sessionId: "session-a",
    runtimeEpoch: 1,
    previousUnit: previous,
    recentThemTurns: [previousTurn],
  });
  const separated = composeLogicalQuestionUnit({
    currentTurn: expired,
    sessionId: "session-a",
    runtimeEpoch: 1,
    previousUnit: previous,
    recentThemTurns: [previousTurn],
  });

  assert.equal(composed.id, previous.id);
  assert.ok(composed.compositionReasons.includes("referential-completion"));
  assert.notEqual(separated.id, previous.id);
  assert.equal(separated.boundaryReason, "question-window-expired");
});

test("keeps dense recruiter setup as source context but classifies the terminal ask", () => {
  const current = turn(
    "turn_dense",
    "You can ask the team what their challenges are. How does this sound relative to what you're looking for?",
    1_000
  );
  const unit = composeLogicalQuestionUnit({
    currentTurn: current,
    sessionId: "session-a",
    runtimeEpoch: 1,
    primaryAskProjection: projectPrimaryAsk({
      turnId: current.id,
      text: current.text,
    }),
  });

  assert.equal(
    unit.normalizedText,
    "How does this sound relative to what you're looking for?"
  );
  assert.equal(unit.sources[0]?.text, current.text);
  assert.equal(
    unit.primaryAskProjection?.quotedOrFutureExampleSpans.length,
    1
  );
});

test("revises one logical question when a referential ask follows setup", () => {
  const setupTurn = turn(
    "turn_setup",
    "The role focuses on production AI infrastructure and platform reliability.",
    1_000
  );
  const setup = composeLogicalQuestionUnit({
    currentTurn: setupTurn,
    sessionId: "session-a",
    runtimeEpoch: 1,
    primaryAskProjection: projectPrimaryAsk({
      turnId: setupTurn.id,
      text: setupTurn.text,
    }),
  });
  const askTurn = turn(
    "turn_ask",
    "How does this sound relative to what you're looking for?",
    2_000
  );
  const askProjection = projectPrimaryAsk({
    turnId: askTurn.id,
    text: askTurn.text,
  });
  const revised = composeLogicalQuestionUnit({
    currentTurn: askTurn,
    sessionId: "session-a",
    runtimeEpoch: 1,
    previousUnit: setup,
    primaryAskProjection: askProjection,
    intentDecision: decideAdvisorTurnIntent(
      askProjection.normalizedPrimaryAsk ?? askTurn.text,
      { hasActiveTask: false, hasRecentQuestionContext: true }
    ),
  });

  assert.equal(revised.id, setup.id);
  assert.equal(revised.revision, 2);
  assert.equal(revised.boundaryReason, "bounded-continuation");
  assert.ok(revised.compositionReasons.includes("primary-ask-completion"));
  assert.equal(
    revised.primaryAskProjection?.disposition,
    "revise-existing-lqu"
  );
  assert.deepEqual(revised.sourceTurnIds, ["turn_setup", "turn_ask"]);
});
