import assert from "node:assert/strict";
import test from "node:test";
import {
  detectAnswerSufficiencyShadow,
  evaluateAnswerContextResolvabilityShadow,
  formatAnswerSufficiencyDecisionForTrace,
  projectAnswerResolution,
} from "../src/lib/meeting/answer-sufficiency.js";
import type { ContextScopeResponseActionResult } from "../src/lib/meeting/context-scope-response-action.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import { ANSWER_SUFFICIENCY_CORPUS } from "./fixtures/answer-sufficiency-corpus.js";

for (const fixture of ANSWER_SUFFICIENCY_CORPUS) {
  test(`answer sufficiency corpus: ${fixture.id}`, () => {
    const decision = detectAnswerSufficiencyShadow({
      operationId: `operation-${fixture.id}`,
      traceId: `trace-${fixture.id}`,
      questionId: `question-${fixture.id}`,
      logicalQuestionUnitId: `lqu-${fixture.id}`,
      logicalQuestionUnitRevision: 1,
      answerRevision: 1,
      questionText: fixture.question,
      questionType: fixture.questionType,
      parsedAnswer: parseMeetingAnswer(fixture.answer),
      currentTurnAction: fixture.currentTurnAction,
      factAnchorRequired: fixture.factAnchorRequired,
      factAnchorAvailable: fixture.factAnchorAvailable,
      executionStatus: fixture.executionStatus,
      createdAt: 100,
    });

    assert.equal(decision.answerStatus, fixture.expectedStatus);
    assert.equal(decision.recommendedRepair, fixture.expectedRepair);
    assert.equal(decision.schemaVersion, 1);
    assert.equal(decision.createdAt, 100);
  });
}

test("a missing-context phrase alone cannot classify a non-substantive turn", () => {
  const decision = detectAnswerSufficiencyShadow({
    operationId: "operation-short",
    traceId: "trace-short",
    questionId: "question-short",
    logicalQuestionUnitId: "lqu-short",
    logicalQuestionUnitRevision: 1,
    answerRevision: 1,
    questionText: "Okay.",
    questionType: "unknown",
    parsedAnswer: parseMeetingAnswer(
      "Answer:\nI don't have the original problem."
    ),
  });

  assert.equal(decision.answerStatus, "unknown");
  assert.equal(decision.recommendedRepair, "none");
});

test("projects a line-visibility clarification into awaiting visual evidence", () => {
  const parsedAnswer = parseMeetingAnswer(
    "Answer:\nI cannot see lines 46 through 49. Please share the relevant code."
  );
  const decision = detectAnswerSufficiencyShadow({
    operationId: "operation-lines",
    traceId: "trace-lines",
    questionId: "question-lines",
    logicalQuestionUnitId: "lqu-lines",
    logicalQuestionUnitRevision: 2,
    answerRevision: 1,
    questionText: "Can you explain lines 46 through 49?",
    questionType: "coding",
    parsedAnswer,
  });
  const resolution = projectAnswerResolution({
    decision,
    questionText: "Can you explain lines 46 through 49?",
    parsedAnswer,
  });

  assert.equal(decision.answerStatus, "context-insufficient");
  assert.equal(resolution.state, "awaiting-evidence");
  assert.equal(resolution.awaitingVisualEvidence, true);
  assert.ok(resolution.evidence.includes("question-references-code-lines"));
  assert.ok(
    resolution.evidence.includes("answer-cannot-inspect-visual-evidence")
  );
});

test("does not create visual recovery from a generic request for more context", () => {
  const parsedAnswer = parseMeetingAnswer(
    "Answer:\nI need the original problem before comparing the algorithms."
  );
  const decision = detectAnswerSufficiencyShadow({
    operationId: "operation-generic",
    traceId: "trace-generic",
    questionId: "question-generic",
    logicalQuestionUnitId: "lqu-generic",
    logicalQuestionUnitRevision: 1,
    answerRevision: 1,
    questionText: "Can you compare the alternatives?",
    questionType: "coding",
    parsedAnswer,
  });
  const resolution = projectAnswerResolution({
    decision,
    questionText: "Can you compare the alternatives?",
    parsedAnswer,
  });

  assert.equal(resolution.state, "awaiting-evidence");
  assert.equal(resolution.awaitingVisualEvidence, false);
});

test("trace projection carries identities and evidence without answer text", () => {
  const decision = detectAnswerSufficiencyShadow({
    operationId: "operation-trace",
    traceId: "trace-projection",
    questionId: "question-projection",
    logicalQuestionUnitId: "lqu-projection",
    logicalQuestionUnitRevision: 3,
    answerRevision: 2,
    questionText: "Give me a script on that.",
    questionType: "coding",
    parsedAnswer: parseMeetingAnswer(
      "Answer:\nThe specific task isn't clear yet."
    ),
  });
  const metadata = formatAnswerSufficiencyDecisionForTrace(decision);

  assert.equal(metadata.answerSufficiencyStatus, "context-insufficient");
  assert.equal(metadata.answerSufficiencyLogicalQuestionUnitRevision, 3);
  assert.equal(metadata.answerSufficiencyAnswerRevision, 2);
  assert.equal("answer" in metadata, false);
});

test("context insufficiency is resolvable only with novel source-backed evidence", () => {
  const decision = detectAnswerSufficiencyShadow({
    operationId: "operation-resolvable",
    traceId: "trace-resolvable",
    questionId: "question-resolvable",
    logicalQuestionUnitId: "lqu-resolvable",
    logicalQuestionUnitRevision: 1,
    answerRevision: 1,
    questionText: "Can you write the Python code for that?",
    questionType: "coding",
    parsedAnswer: parseMeetingAnswer(
      "Answer:\nThe specific task and input/output are not clear yet.\n\nCode:\n-"
    ),
  });
  const resolved = evaluateAnswerContextResolvabilityShadow({
    decision,
    selection: contextSelection({
      kind: "recent-dialogue",
      turnIds: ["turn-spec"],
      text: "Recent source dialogue:\nThem: The task is to recursively return every text file.",
      score: 0.92,
    }),
    questionType: "coding",
    activeParentQuestionType: "coding",
    originalContextText: "Them: Can you write the Python code for that?",
    sourceTextByTurnId: {
      "turn-spec": "The task is to recursively return every text file.",
    },
  });

  assert.equal(resolved.resolvableByNearbyContext, true);
  assert.equal(resolved.recommendedRepair, "enhance");
  assert.deepEqual(resolved.candidateContextKinds, ["recent-dialogue"]);
  assert.deepEqual(resolved.candidateSourceTurnIds, ["turn-spec"]);
  assert.ok(resolved.contextDeltaChars > 0);
});

test("context already present or across a new-parent guard cannot authorize Enhance", () => {
  const decision = detectAnswerSufficiencyShadow({
    operationId: "operation-not-resolvable",
    traceId: "trace-not-resolvable",
    questionId: "question-not-resolvable",
    logicalQuestionUnitId: "lqu-not-resolvable",
    logicalQuestionUnitRevision: 1,
    answerRevision: 1,
    questionText: "Can you write the Python code for that?",
    questionType: "coding",
    parsedAnswer: parseMeetingAnswer(
      "Answer:\nThe specific task and input/output are not clear yet.\n\nCode:\n-"
    ),
  });
  const alreadyPresent = evaluateAnswerContextResolvabilityShadow({
    decision,
    selection: contextSelection({
      kind: "recent-dialogue",
      turnIds: ["turn-spec"],
      text: "Recent source dialogue:\nThem: Recursively return every text file.",
      score: 0.92,
    }),
    questionType: "coding",
    activeParentQuestionType: "coding",
    originalContextText:
      "Them: Recursively return every text file. Can you write the Python code for that?",
    sourceTextByTurnId: {
      "turn-spec": "Recursively return every text file.",
    },
  });
  const guarded = evaluateAnswerContextResolvabilityShadow({
    decision,
    selection: {
      ...contextSelection({
        kind: "parent-capsule",
        turnIds: ["turn-old-parent"],
        text: "Source-only parent task:\nQuestion: Design an old service.",
        score: 0.9,
      }),
      independentQuestionGuardApplied: true,
    },
    questionType: "coding",
    activeParentQuestionType: "general-system-design",
    originalContextText: "Them: Write the code for this array problem.",
    sourceTextByTurnId: {
      "turn-old-parent": "Design an old service.",
    },
  });

  assert.equal(alreadyPresent.resolvableByNearbyContext, false);
  assert.equal(alreadyPresent.recommendedRepair, "manual-clarification");
  assert.equal(guarded.resolvableByNearbyContext, false);
  assert.equal(guarded.recommendedRepair, "manual-clarification");
});

function contextSelection(
  candidate: {
    kind: "recent-dialogue" | "child-capsule" | "parent-capsule";
    turnIds: string[];
    text: string;
    score: number;
  }
): ContextScopeResponseActionResult {
  return {
    action: "enhance-context",
    contextScopeMode: "expanded",
    promptContext: {
      transcript: "",
      screenContext: "",



      taskRuntime: { revision: 0 },
    },
    logicalQuestionUnitId: "lqu",
    logicalQuestionUnitRevision: 1,
    candidates: [
      {
        kind: "current-lqu",
        text: "Current logical question",
        turnIds: ["turn-current"],
        chars: 24,
        score: 1,
        selected: true,
        reason: "required-current-logical-question",
      },
      {
        ...candidate,
        chars: candidate.text.length,
        selected: true,
        reason: "test-candidate",
      },
    ],
    selectedKinds: ["current-lqu", candidate.kind],
    selectedTurnIds: ["turn-current", ...candidate.turnIds],
    selectedChars: 24 + candidate.text.length,
    selectedScores: {
      "current-lqu": 1,
      [candidate.kind]: candidate.score,
    },
    selectionReason: `shortest-sufficient-${candidate.kind}`,
    independentQuestionGuardApplied: false,
    budgets: {
      maxRecentThemTurns: 5,
      maxExpansionChars: 1_600,
      maxCapsuleChars: 500,
    },
  };
}
