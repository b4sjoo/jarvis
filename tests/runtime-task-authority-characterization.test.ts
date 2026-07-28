import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyInterviewTransitionTurn,
  reconcileInterviewTransitionTurnWithPrimaryAsk,
} from "../src/lib/meeting/interview-section-transition.js";
import { decideInterviewTaskContinuityBranch } from "../src/lib/meeting/interview-task-continuity.js";
import { projectPrimaryAsk } from "../src/lib/meeting/primary-ask-projection.js";
import { inferQuestionTypeDecisionFromText } from "../src/lib/meeting/task-taxonomy.js";
import {
  AMBIGUOUS_TYPE_AUTHORITY_CORPUS,
  EXPLICIT_ASK_AUTHORITY_CORPUS,
  LIFECYCLE_AUTHORITY_CORPUS,
  summarizeLocalTypeDecision,
} from "./fixtures/runtime-task-authority-corpus.js";

test("characterizes explicit source-owned asks before semantic authority changes", () => {
  const outcomes = EXPLICIT_ASK_AUTHORITY_CORPUS.map((fixture) => {
    const projection = projectPrimaryAsk({
      turnId: `turn:${fixture.id}`,
      text: fixture.text,
    });
    const transition = reconcileInterviewTransitionTurnWithPrimaryAsk(
      classifyInterviewTransitionTurn(fixture.text),
      projection.normalizedPrimaryAsk
    );
    const localType = inferQuestionTypeDecisionFromText(
      projection.normalizedPrimaryAsk ?? fixture.text
    );
    return {
      id: fixture.id,
      projection,
      transition,
      localType: summarizeLocalTypeDecision(localType),
    };
  });

  for (const [index, outcome] of outcomes.entries()) {
    const fixture = EXPLICIT_ASK_AUTHORITY_CORPUS[index];
    assert.ok(fixture);
    assert.equal(
      outcome.projection.disposition,
      fixture.currentDisposition,
      fixture.id
    );
    assert.equal(
      outcome.projection.normalizedPrimaryAsk,
      fixture.expectedPrimaryAsk,
      fixture.id
    );
    if (outcome.transition.detected && fixture.expectedPrimaryAsk) {
      assert.equal(
        outcome.transition.disposition,
        "complete-question",
        fixture.id
      );
    }
    assert.equal(outcome.localType.type, fixture.expectedLocalType, fixture.id);
  }

  assert.equal(
    outcomes.filter(
      (outcome) =>
        outcome.projection.disposition === "answer-primary-ask"
    ).length,
    EXPLICIT_ASK_AUTHORITY_CORPUS.length - 1
  );
  assert.equal(
    EXPLICIT_ASK_AUTHORITY_CORPUS.every(
      (fixture) => fixture.targetAdmission
    ),
    true
  );
});

test("records ambiguous local type outcomes separately from target authority", () => {
  for (const fixture of AMBIGUOUS_TYPE_AUTHORITY_CORPUS) {
    const decision = inferQuestionTypeDecisionFromText(fixture.text);
    assert.equal(decision.type, fixture.currentLocalType, fixture.id);
    assert.equal(
      fixture.targetDisposition === "exact-high",
      Boolean(fixture.targetType),
      fixture.id
    );
  }
});

test("records current lifecycle defaults and the no-unknown-mutation target", () => {
  for (const fixture of LIFECYCLE_AUTHORITY_CORPUS) {
    const decision = decideInterviewTaskContinuityBranch({
      hasExistingParent: fixture.hasExistingParent,
      existingParentQuestionType: fixture.existingParentQuestionType,
      candidateQuestionType: fixture.candidateQuestionType,
      relation: fixture.relation,
    });
    assert.equal(decision.branch, fixture.currentBranch, fixture.id);
  }

  const unsafeUnknownRelation = LIFECYCLE_AUTHORITY_CORPUS.find(
    (fixture) => fixture.id === "unknown-relation-must-not-create-parent"
  );
  assert.ok(unsafeUnknownRelation);
  assert.notEqual(
    unsafeUnknownRelation.currentBranch,
    unsafeUnknownRelation.targetBranch
  );
});
