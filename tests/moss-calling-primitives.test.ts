import assert from "node:assert/strict";
import test from "node:test";
import {
  HumanTruthLedger,
  StableGuidanceStore,
  appendConversationMessage,
  buildBoundedCallingContext,
  compileImmutableSnapshot,
  editConversationMessage,
  orderAudioSegments,
  pinSnapshot,
  reduceRecordingClose,
} from "../src/lib/calling/index.js";

test("dual-source audio uses capture time with a deterministic arrival tie-break", () => {
  const ordered = orderAudioSegments([
    { source: "me", sourceSequence: 1, capturedAtMs: 20, arrivalSequence: 2, payload: "b" },
    { source: "them", sourceSequence: 2, capturedAtMs: 10, arrivalSequence: 3, payload: "a" },
    { source: "them", sourceSequence: 3, capturedAtMs: 20, arrivalSequence: 1, payload: "c" },
  ]);
  assert.deepEqual(ordered.map((item) => item.payload), ["a", "c", "b"]);
});

test("stable guidance preserves the previous frame until a complete authorized replacement", () => {
  const store = new StableGuidanceStore();
  const first = {
    say: ["Confirm the account number."], ask: [], avoid: [], evidence: [],
    callState: "Identity verification", nextMove: "Wait for confirmation",
  };
  assert.equal(store.commit({ requestId: "a", frame: first, authorized: true, occurredAt: 1 }), true);
  assert.equal(store.commit({ requestId: "b", frame: { say: [] }, authorized: true, occurredAt: 2 }), false);
  assert.deepEqual(store.visible, first);
  assert.equal(store.revision, 1);
});

test("human truth is append-only and a correction explicitly supersedes the same fact", () => {
  const ledger = new HumanTruthLedger();
  ledger.append({ id: "h1", callSessionId: "c1", factKey: "deadline", value: "Friday", source: "human", occurredAt: 1 });
  ledger.append({ id: "h2", callSessionId: "c1", factKey: "deadline", value: "Monday", source: "human", occurredAt: 2, supersedesEventId: "h1" });
  assert.equal(ledger.events().length, 2);
  assert.equal(ledger.currentFacts("c1").get("deadline")?.value, "Monday");
});

test("failed recording close retains ownership and can retry", () => {
  const open = { callSessionId: "c1", recordingPath: "/recordings/c1", state: "open" as const, attempt: 0, pendingEventCount: 3 };
  const closing = reduceRecordingClose(open, { type: "request-close" });
  const failed = reduceRecordingClose(closing, { type: "close-failed", error: "disk busy" });
  assert.equal(failed.recordingPath, open.recordingPath);
  assert.equal(failed.pendingEventCount, 3);
  const retried = reduceRecordingClose(failed, { type: "retry-close" });
  assert.equal(retried.state, "closing");
  assert.equal(retried.attempt, 2);
});

test("conversation CAS rejects stale writes and editing branches from the edited turn", () => {
  const base = { id: "thread", revision: 0, messages: [] };
  const one = appendConversationMessage({ conversation: base, expectedRevision: 0, message: { id: "m1", role: "user", content: "Original" } });
  const two = appendConversationMessage({ conversation: one, expectedRevision: 1, message: { id: "m2", role: "assistant", content: "Reply" } });
  assert.throws(() => appendConversationMessage({ conversation: two, expectedRevision: 1, message: { id: "m3", role: "user", content: "stale" } }), /revision conflict/);
  const branch = editConversationMessage({ conversation: two, expectedRevision: 2, messageId: "m1", content: "Corrected" });
  assert.deepEqual(branch.messages.map((message) => message.id), ["m1"]);
  assert.equal(branch.messages[0].content, "Corrected");
});

test("immutable snapshots hash canonical content and pin an exact revision", async () => {
  const left = await compileImmutableSnapshot({ id: "s", revision: 1, content: { b: 2, a: 1 }, sourceReferences: ["z", "a"], createdAt: 1 });
  const right = await compileImmutableSnapshot({ id: "s", revision: 2, content: { a: 1, b: 2 }, sourceReferences: ["a", "z"], createdAt: 2 });
  assert.equal(left.contentHash, right.contentHash);
  assert.deepEqual(pinSnapshot({ callSessionId: "c", snapshot: right, pinnedAt: 3 }), {
    callSessionId: "c", snapshotId: "s", snapshotRevision: 2, contentHash: right.contentHash, pinnedAt: 3,
  });
});

test("bounded context keeps the newest source turns and marks truncation", () => {
  const context = buildBoundedCallingContext({
    turns: [
      { id: "1", speaker: "them", text: "old context that should be removed", occurredAt: 1 },
      { id: "2", speaker: "me", text: "new", occurredAt: 2 },
      { id: "3", speaker: "them", text: "latest request", occurredAt: 3 },
    ],
    maxChars: 40,
  });
  assert.deepEqual(context.turns.map((turn) => turn.id), ["3"]);
  assert.equal(context.truncated, true);
});
