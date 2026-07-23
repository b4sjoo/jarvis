import assert from "node:assert/strict";
import test from "node:test";
import { decideAdvisorTurnIntent } from "../src/lib/meeting/advisor-turn-intent.js";
import {
  projectInterviewerIntentDecision,
  projectIntentRelation,
} from "../src/lib/meeting/interviewer-intent.js";

test("projects current advisor and taxonomy decisions into one intent contract", () => {
  const turnDecision = decideAdvisorTurnIntent(
    "Design a ticket selling system",
    { hasActiveTask: false }
  );

  assert.deepEqual(
    projectInterviewerIntentDecision({
      turnDecision,
      questionType: "general-system-design",
      relation: "new-parent",
      contextTurnIds: ["turn_1", "turn_1"],
      evidenceSpans: [
        { turnId: "turn_1", text: "Design a ticket selling system" },
        { turnId: "turn_1", text: "Design a ticket selling system" },
      ],
    }),
    {
      schemaVersion: 1,
      speechAct: "question",
      questionType: "general-system-design",
      relation: "new-parent",
      evidenceMode: "hypothetical-design",
      action: "answer",
      contextTurnIds: ["turn_1"],
      evidenceSpans: [
        { turnId: "turn_1", text: "Design a ticket selling system" },
      ],
      confidence: 0.97,
    }
  );
});

test("projects incomplete and suppressed turns without granting answer authority", () => {
  const incomplete = decideAdvisorTurnIntent("Can you describe...", {
    hasActiveTask: false,
  });
  const acknowledgement = decideAdvisorTurnIntent("Yes", {
    hasActiveTask: true,
  });

  assert.equal(
    projectInterviewerIntentDecision({
      turnDecision: incomplete,
      relation: "unknown",
    }).action,
    "buffer"
  );
  assert.equal(
    projectInterviewerIntentDecision({
      turnDecision: acknowledgement,
      relation: "followup-parent",
    }).action,
    "ignore"
  );
});

test("normalizes runtime-only relation names at the shared contract boundary", () => {
  assert.equal(projectIntentRelation("resume-parent"), "followup-parent");
  assert.equal(projectIntentRelation("correction"), "followup-parent");
  assert.equal(
    projectIntentRelation("linked-parent-extension"),
    "linked-parent-extension"
  );
  assert.equal(projectIntentRelation("logistics"), "none");
});
