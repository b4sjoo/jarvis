import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyInterviewTransitionTurn,
  reconcileInterviewTransitionTurnWithPrimaryAsk,
} from "../src/lib/meeting/interview-section-transition.js";
import { decideInterviewTaskContinuityBranch } from "../src/lib/meeting/interview-task-continuity.js";
import { projectPrimaryAsk } from "../src/lib/meeting/primary-ask-projection.js";
import {
  canQuestionTypeDecisionOverrideParent,
  inferQuestionTypeDecisionFromText,
} from "../src/lib/meeting/task-taxonomy.js";
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
    const expectedLegacyLocalType =
      "expectedLegacyLocalType" in fixture
        ? fixture.expectedLegacyLocalType
        : fixture.expectedLocalType;
    assert.equal(
      outcome.localType.legacyType,
      expectedLegacyLocalType,
      `${fixture.id}: legacy`
    );
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

test("local type authority emits only exact-high or abstain", () => {
  for (const fixture of AMBIGUOUS_TYPE_AUTHORITY_CORPUS) {
    const decision = inferQuestionTypeDecisionFromText(fixture.text);
    assert.equal(decision.legacyType, fixture.currentLocalType, fixture.id);
    assert.equal(decision.certainty, fixture.targetDisposition, fixture.id);
    assert.equal(decision.type, fixture.targetType, fixture.id);
  }
});

test("exact-only multilingual and high-level decisions carry runtime authority", () => {
  for (const text of [
    "Give me a high-level design for a ticket selling system.",
    "请设计一个高并发的票务系统，并先澄清需求。",
  ]) {
    const decision = inferQuestionTypeDecisionFromText(text);
    assert.equal(decision.certainty, "exact-high", text);
    assert.equal(canQuestionTypeDecisionOverrideParent(decision), true, text);
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
