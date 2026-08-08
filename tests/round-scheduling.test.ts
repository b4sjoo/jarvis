import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRoundTimeOptions,
  localRoundScheduleToTimestamp,
  timestampToLocalRoundSchedule,
} from "../src/lib/preparation/round-scheduling.js";

test("round schedule converts through local date and time fields", () => {
  const schedule = { date: "2026-08-08", time: "14:30" };
  const timestamp = localRoundScheduleToTimestamp(schedule);

  assert.equal(typeof timestamp, "number");
  assert.deepEqual(timestampToLocalRoundSchedule(timestamp), schedule);
});

test("round schedule requires date and time together", () => {
  assert.throws(
    () => localRoundScheduleToTimestamp({ date: "2026-08-08", time: "" }),
    /both a scheduled date and time/
  );
  assert.equal(
    localRoundScheduleToTimestamp({ date: "", time: "" }),
    undefined
  );
});

test("time selector offers quarter hours and preserves an existing odd minute", () => {
  const standard = buildRoundTimeOptions();
  const withExisting = buildRoundTimeOptions("09:07");

  assert.equal(standard.length, 96);
  assert.deepEqual(standard[0], { value: "00:00", label: "12:00 AM" });
  assert.deepEqual(standard.at(-1), { value: "23:45", label: "11:45 PM" });
  assert.equal(
    withExisting.find((option) => option.value === "09:07")?.label,
    "9:07 AM"
  );
});
