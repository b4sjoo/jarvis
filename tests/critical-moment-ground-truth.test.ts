import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCriticalMomentGroundTruthSubject,
  resolveCriticalMomentExpectedFacts,
} from "../src/lib/meeting/critical-moment-ground-truth.js";
import {
  createHumanGroundTruthEventV2,
  deriveHumanEvaluationProjectionV2,
} from "../src/lib/meeting/human-ground-truth-v2.js";
import type {
  CriticalMomentCandidate,
  CriticalMomentEvaluation,
} from "../src/lib/meeting/critical-moment-evaluation.js";

test("uses a moment-scoped V2 projection without requiring a trace", () => {
  const candidate = momentCandidate();
  const subject = buildCriticalMomentGroundTruthSubject(candidate);
  assert.deepEqual(subject, {
    momentId: "moment-1",
    traceIds: [],
    sourceTurnIds: ["turn-1"],
  });
  const events = [
    createHumanGroundTruthEventV2({
      eventId: "event-settlement",
      sessionId: candidate.sessionId,
      subject,
      source: "explicit-ui",
      fact: {
        kind: "expected-task-settlement",
        expectedQuestionType: "general-system-design",
        expectedRelation: "new-parent",
        expectedParentAction: "create",
      },
      now: 1,
    }),
    createHumanGroundTruthEventV2({
      eventId: "event-action",
      sessionId: candidate.sessionId,
      subject,
      source: "explicit-ui",
      fact: {
        kind: "expected-runtime-action",
        expectedAction: "advise",
      },
      now: 2,
    }),
    createHumanGroundTruthEventV2({
      eventId: "event-answer",
      sessionId: candidate.sessionId,
      subject,
      source: "explicit-ui",
      fact: {
        kind: "answer-quality",
        outcome: "useful",
        failureReasons: [],
        expectedContextTurnIds: ["turn-parent", "turn-1"],
      },
      now: 3,
    }),
  ];
  const projection = deriveHumanEvaluationProjectionV2({
    sessionId: candidate.sessionId,
    subject,
    events,
    now: 4,
  });
  const legacyEvaluation = legacyMomentEvaluation({
    expectedQuestionType: "coding",
    expectedAdvisorAction: "ignore",
    expectedRelation: "followup-parent",
  });

  const resolved = resolveCriticalMomentExpectedFacts({
    candidate,
    projections: [projection],
    legacyEvaluation,
  });

  assert.equal(resolved.authority, "v2");
  assert.equal(resolved.joinStatus, "exact-moment");
  assert.equal(resolved.expectedQuestionType, "general-system-design");
  assert.equal(resolved.expectedRuntimeAction, "advise");
  assert.equal(resolved.expectedRelation, "new-parent");
  assert.equal(resolved.expectedParentAction, "create");
  assert.deepEqual(resolved.expectedContextTurnIds, [
    "turn-parent",
    "turn-1",
  ]);
  assert.ok(
    resolved.warnings.some((warning) =>
      warning.includes("question types disagree")
    )
  );
});

test("falls back to an exact source-turn identity before trace proposals", () => {
  const candidate = momentCandidate({
    momentId: "moment-new",
    proposedTraceIds: ["trace-shared"],
  });
  const subject = {
    questionId: "question-old",
    traceIds: ["trace-unrelated"],
    sourceTurnIds: ["turn-1"],
  };
  const event = createHumanGroundTruthEventV2({
    eventId: "event-type",
    sessionId: candidate.sessionId,
    subject,
    source: "explicit-ui",
    fact: {
      kind: "expected-question-type",
      expectedQuestionType: "field-knowledge",
    },
    now: 1,
  });
  const projection = deriveHumanEvaluationProjectionV2({
    sessionId: candidate.sessionId,
    subject,
    events: [event],
    now: 2,
  });

  const resolved = resolveCriticalMomentExpectedFacts({
    candidate,
    projections: [projection],
  });

  assert.equal(resolved.joinStatus, "exact-source-turns");
  assert.equal(resolved.expectedQuestionType, "field-knowledge");
});

test("does not authorize a V2 truth join from trace overlap alone", () => {
  const candidate = momentCandidate({
    proposedTraceIds: ["trace-shared"],
  });
  const subject = {
    questionId: "question-other",
    traceIds: ["trace-shared"],
    sourceTurnIds: ["turn-other"],
  };
  const event = createHumanGroundTruthEventV2({
    eventId: "event-type",
    sessionId: candidate.sessionId,
    subject,
    source: "explicit-ui",
    fact: {
      kind: "expected-question-type",
      expectedQuestionType: "coding",
    },
    now: 1,
  });
  const projection = deriveHumanEvaluationProjectionV2({
    sessionId: candidate.sessionId,
    subject,
    events: [event],
    now: 2,
  });

  const resolved = resolveCriticalMomentExpectedFacts({
    candidate,
    projections: [projection],
  });

  assert.equal(resolved.authority, "none");
  assert.equal(resolved.joinStatus, "missing");
  assert.equal(resolved.expectedQuestionType, undefined);
  assert.match(resolved.warnings[0], /trace overlap is not authoritative/i);
});

test("keeps conflicting V2 facts unresolved instead of using legacy truth", () => {
  const candidate = momentCandidate();
  const subject = {
    momentId: candidate.momentId,
    traceIds: [],
    sourceTurnIds: candidate.sourceTurnIds,
  };
  const events = [
    createHumanGroundTruthEventV2({
      eventId: "event-type-a",
      sessionId: candidate.sessionId,
      subject,
      source: "explicit-ui",
      fact: {
        kind: "expected-question-type",
        expectedQuestionType: "coding",
      },
      now: 1,
    }),
    createHumanGroundTruthEventV2({
      eventId: "event-type-b",
      sessionId: candidate.sessionId,
      subject,
      source: "explicit-ui",
      fact: {
        kind: "expected-question-type",
        expectedQuestionType: "behavioral",
      },
      now: 1,
    }),
  ];
  const projection = deriveHumanEvaluationProjectionV2({
    sessionId: candidate.sessionId,
    subject,
    events,
    now: 2,
  });

  const resolved = resolveCriticalMomentExpectedFacts({
    candidate,
    projections: [projection],
    legacyEvaluation: legacyMomentEvaluation({
      expectedQuestionType: "field-knowledge",
    }),
  });

  assert.equal(resolved.authority, "v2");
  assert.equal(resolved.expectedQuestionType, undefined);
  assert.deepEqual(resolved.conflictFactKinds, [
    "expected-question-type",
  ]);
});

test("reads legacy expected facts without promoting clarify into runtime action", () => {
  const resolved = resolveCriticalMomentExpectedFacts({
    candidate: momentCandidate(),
    projections: [],
    legacyEvaluation: legacyMomentEvaluation({
      expectedQuestionType: "behavioral",
      expectedAdvisorAction: "clarify",
      expectedRelation: "new-parent",
      expectedContextTurnIds: ["turn-1"],
    }),
  });

  assert.equal(resolved.authority, "legacy");
  assert.equal(resolved.joinStatus, "legacy-fallback");
  assert.equal(resolved.expectedQuestionType, "behavioral");
  assert.equal(resolved.expectedRuntimeAction, undefined);
  assert.equal(resolved.legacyExpectedAdvisorAction, "clarify");
  assert.match(resolved.warnings.join(" "), /not a V2 runtime action/i);
});

function momentCandidate(
  patch: Partial<CriticalMomentCandidate> = {}
): CriticalMomentCandidate {
  return {
    momentId: "moment-1",
    sessionId: "session-1",
    sourceTurnIds: ["turn-1"],
    sourceText: "Design a queue.",
    candidateSource: "manual",
    candidateReasons: [],
    proposedTraceIds: [],
    traceJoinStatus: "none",
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function legacyMomentEvaluation(
  patch: Partial<CriticalMomentEvaluation>
): CriticalMomentEvaluation {
  return {
    momentId: "moment-1",
    sessionId: "session-1",
    sourceTurnIds: ["turn-1"],
    traceIds: [],
    failureReasons: [],
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}
