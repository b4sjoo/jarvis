import assert from "node:assert/strict";
import test from "node:test";
import {
  createCallPlanState,
  createInitialCaseState,
} from "../src/lib/preparation/case-service.js";

test("case creation requires an explicit title and primary objective", () => {
  assert.throws(
    () => createInitialCaseState({ title: "", primaryObjective: "Resolve it" }),
    /title is required/
  );
  assert.throws(
    () => createInitialCaseState({ title: "Claim", primaryObjective: "" }),
    /objective is required/
  );
  const created = createInitialCaseState({
    title: " Benefits appeal ",
    primaryObjective: " Obtain a written decision. ",
    acceptableFallbacks: [" Escalation path ", ""],
    caseType: " Benefits ",
    now: 10,
  });
  assert.equal(created.record.title, "Benefits appeal");
  assert.equal(created.record.currentRevisionId, created.revision.id);
  assert.equal(created.revision.primaryObjective, "Obtain a written decision.");
  assert.deepEqual(created.revision.acceptableFallbacks, ["Escalation path"]);
});

test("call plans are explicit case-scoped objects rather than a current tab", () => {
  const plan = createCallPlanState({
    caseId: "case-a",
    title: " Follow-up ",
    objective: " Confirm the review deadline. ",
    acceptableOutcomes: ["Written date"],
    questionsToAsk: ["Who owns the review?"],
    knownRisks: ["No case number"],
    now: 20,
  });
  assert.equal(plan.caseId, "case-a");
  assert.equal(plan.title, "Follow-up");
  assert.equal(plan.state, "draft");
  assert.equal(plan.rowRevision, 1);
});
