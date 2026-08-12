import assert from "node:assert/strict";
import test from "node:test";
import {
  createCallPlanState,
  createInitialCaseState,
} from "../src/lib/preparation/case-service.js";
import {
  buildCallPlanTimeOptions,
  localCallPlanScheduleToTimestamp,
  timestampToLocalCallPlanSchedule,
} from "../src/lib/preparation/call-plan-scheduling.js";

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

test("call plan scheduling uses local dates and fifteen-minute choices", () => {
  const options = buildCallPlanTimeOptions();
  assert.equal(options.length, 96);
  assert.deepEqual(options.slice(0, 3), [
    { value: "00:00", label: "12:00 AM" },
    { value: "00:15", label: "12:15 AM" },
    { value: "00:30", label: "12:30 AM" },
  ]);
  assert.deepEqual(options.at(-1), { value: "23:45", label: "11:45 PM" });

  const timestamp = localCallPlanScheduleToTimestamp({
    date: "2026-08-12",
    time: "09:30",
  });
  assert.notEqual(timestamp, undefined);
  assert.deepEqual(timestampToLocalCallPlanSchedule(timestamp), {
    date: "2026-08-12",
    time: "09:30",
  });
  assert.throws(
    () => localCallPlanScheduleToTimestamp({ date: "2026-08-12", time: "" }),
    /Choose both/
  );
  assert.throws(
    () => localCallPlanScheduleToTimestamp({ date: "2026-02-31", time: "09:30" }),
    /not valid/
  );
});
