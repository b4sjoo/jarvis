import assert from "node:assert/strict";
import test from "node:test";
import { createMeetingId } from "../src/lib/meeting/meeting-id.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";

test("the shared ID leaf preserves the existing format and per-call clock/random reads", (t) => {
  const clock = t.mock.method(Date, "now", () => 123456);
  const random = t.mock.method(Math, "random", () => 0.25);
  assert.equal(createMeetingId("logical_question"), "logical_question_123456_9");
  assert.equal(createMeetingId("advisor_job"), "advisor_job_123456_9");
  assert.equal(clock.mock.callCount(), 2);
  assert.equal(random.mock.callCount(), 2);
});

test("Context Manager uses the same ID contract without making source reads mutate runtime", (t) => {
  t.mock.method(Date, "now", () => 123456);
  t.mock.method(Math, "random", () => 0.25);
  const manager = new MeetingContextManager();
  const before = manager.getTaskRuntimeState();
  assert.equal(manager.getState().sessionId, "meeting_123456_9");
  assert.deepEqual(manager.getTaskRuntimeState(), before);
});
