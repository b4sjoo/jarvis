import assert from "node:assert/strict";
import test from "node:test";
import { decideAdvisorTurnIntent } from "../src/lib/meeting/advisor-turn-intent.js";
import {
  extractInterviewerIntentKeywordEvidence,
  formatInterviewerIntentKeywordEvidenceForTrace,
} from "../src/lib/meeting/interviewer-intent-keyword-evidence.js";

test("factorizes coding evidence without changing the current gate decision", () => {
  const text = "Now write a stack implementation";
  const turnDecision = decideAdvisorTurnIntent(text, {
    hasActiveTask: false,
  });
  const evidence = extractInterviewerIntentKeywordEvidence({
    text,
    turnDecision,
    relation: "new-parent",
    currentTurnId: "turn_1",
  });

  assert.equal(turnDecision.executionAuthorized, true);
  assert.equal(evidence.questionTypeDecision.type, "coding");
  assert.ok(evidence.actionVerbs.includes("write"));
  assert.ok(evidence.actionObjects.includes("stack"));
  assert.ok(evidence.domainMarkers.includes("coding-domain"));
  assert.ok(evidence.temporalFrames.includes("current-follow-up"));
  assert.equal(evidence.counterfactual.action, "answer");
  assert.equal(evidence.counterfactual.questionType, "coding");
});

test("records transition and conflicting project evidence as separate factors", () => {
  const text =
    "Now let's move to your project. Walk me through the retrieval pipeline you built.";
  const turnDecision = decideAdvisorTurnIntent(text, {
    hasActiveTask: true,
  });
  const evidence = extractInterviewerIntentKeywordEvidence({
    text,
    turnDecision,
    relation: "followup-parent",
    currentTurnId: "turn_2",
  });

  assert.ok(
    evidence.transitionMarkers.includes("explicit-section-transition")
  );
  assert.ok(evidence.domainMarkers.includes("project-domain"));
  assert.ok(
    evidence.hardNegativeMarkers.includes("past-project-not-hypothetical")
  );
  assert.equal(
    evidence.questionTypeDecision.scores["project-deep-dive"],
    0.95
  );
  assert.equal(evidence.questionTypeDecision.type, "project-deep-dive");
});

test("serializes factor evidence as trace-only counterfactual metadata", () => {
  const text = "Looks good";
  const turnDecision = decideAdvisorTurnIntent(text, {
    hasActiveTask: true,
  });
  const evidence = extractInterviewerIntentKeywordEvidence({
    text,
    turnDecision,
    currentTurnId: "turn_3",
  });
  const metadata = formatInterviewerIntentKeywordEvidenceForTrace(evidence);

  assert.equal(metadata.interviewerIntentKeywordEvidenceSchemaVersion, 1);
  assert.deepEqual(metadata.interviewerIntentKeywordActionVerbs, []);
  assert.equal(
    metadata.interviewerIntentCounterfactual.schemaVersion,
    1
  );
});
