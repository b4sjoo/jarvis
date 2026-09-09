import assert from "node:assert/strict";
import test from "node:test";
import {
  appendAdvisorGeneratedContinuityCapsule,
  clearBoundedGeneratedContinuity,
  clearBoundedGeneratedSummaries,
  createAdvisorGeneratedContinuityCapsule,
  decideBoundedRecentHistoryRead,
  prepareBoundedGeneratedContinuity,
  readBoundedGeneratedContinuity,
  type BoundedGeneratedContinuityOwner,
  type BoundedGeneratedContinuityState,
} from "../src/lib/meeting/bounded-recent-history.js";
import { buildMeetingAnswerSummary, parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import { commitStableAnswerRevision } from "../src/lib/meeting/stable-answer.js";

const parent: BoundedGeneratedContinuityOwner = {
  sessionId: "session-a",
  runtimeEpoch: 3,
  parentTaskId: "parent-a",
};

function stableFor(
  owner = parent,
  revision = 1,
  text = "Prefer replication because availability matters more than write latency."
) {
  const content = `Answer: ${text}\nApproach: Compare the consistency trade-off.`;
  const stable = commitStableAnswerRevision({
    candidate: {
      id: `suggestion-${revision}`,
      kind: "answer",
      content,
      meetingAnswer: parseMeetingAnswer(content),
      createdAt: revision,
      basedOnTurnIds: [],
      basedOnObservationIds: [],
      confidence: "high",
    },
    authorizedArtifacts: ["answer"],
    sessionId: owner.sessionId,
    runtimeEpoch: owner.runtimeEpoch,
    taskId: owner.parentTaskId,
    sectionOwner: owner.childTaskId
      ? { kind: "active-child", parentId: owner.parentTaskId, childId: owner.childTaskId }
      : { kind: "parent-mainline", parentId: owner.parentTaskId },
    logicalQuestionUnitId: `lqu-${revision}`,
    logicalQuestionRevision: 1,
    committedAt: revision,
    revision,
  });
  assert.ok(stable);
  return stable;
}

function prepare(
  state: BoundedGeneratedContinuityState = { recentCapsules: [] },
  options: Partial<Parameters<typeof prepareBoundedGeneratedContinuity>[0]> = {}
) {
  return prepareBoundedGeneratedContinuity({
    state,
    stable: stableFor(),
    currentOwner: parent,
    parentRevision: 7,
    parentSummaryAllowed: true,
    ...options,
  });
}

test("prepares pending output without publishing or mutating prior state", () => {
  const published = prepare(undefined, { parentSummary: "First answer" });
  const snapshot = structuredClone(published);
  Object.freeze(published.owner);
  published.recentCapsules.forEach(Object.freeze);
  Object.freeze(published.recentCapsules);
  Object.freeze(published);
  const holder = { current: published };
  const prepared = prepare(holder.current, {
    stable: stableFor(parent, 2),
    parentSummary: "Pending second answer",
  });
  assert.deepEqual(holder.current, snapshot);
  assert.equal(readBoundedGeneratedContinuity({ state: holder.current, currentOwner: parent }).latestUsefulAnswer, "First answer");
  assert.equal(prepared.latestUsefulAnswer, "Pending second answer");
  prepared.recentCapsules[0].text = "Mutated candidate";
  assert.deepEqual(holder.current, snapshot);
  // Installation is deliberately outside the helper, at successful publication.
  holder.current = prepared;
  assert.equal(holder.current.latestUsefulAnswer, "Pending second answer");
});

test("artifact-only publication leaves every continuity lane untouched", () => {
  const state = prepare();
  assert.equal(prepare(state, {
    artifactOnly: true,
    stable: stableFor({ ...parent, parentTaskId: "other" }),
    parentSummary: "Forbidden parent summary",
    childSummary: "Forbidden child summary",
  }), state);
});

test("rejects mismatched Stable session, epoch, parent and exact child without altering state", () => {
  const state = prepare();
  const snapshot = structuredClone(state);
  for (const owner of [
    { ...parent, sessionId: "other" },
    { ...parent, runtimeEpoch: 4 },
    { ...parent, parentTaskId: "other" },
    { ...parent, childTaskId: "child-a" },
  ]) {
    assert.equal(prepare(state, { stable: stableFor(owner) }), state);
  }
  const child = { ...parent, childTaskId: "child-a" };
  assert.equal(prepare(state, { currentOwner: child }), state);
  assert.equal(prepare(state, {
    currentOwner: child,
    stable: stableFor({ ...child, childTaskId: "child-b" }),
  }), state);
  const wrongSection = stableFor();
  wrongSection.sections.answer.owner = { kind: "parent-mainline", parentId: "other" };
  assert.equal(prepare(state, { stable: wrongSection }), state);
  assert.equal(prepare(state, { currentOwner: undefined }), state);
  assert.deepEqual(state, snapshot);
});

test("owner changes deny old reads and valid new-owner publication replaces the bounded slots", () => {
  const state = prepare();
  for (const currentOwner of [
    undefined,
    { ...parent, sessionId: "other" },
    { ...parent, runtimeEpoch: 4 },
    { ...parent, parentTaskId: "other" },
  ]) {
    assert.deepEqual(readBoundedGeneratedContinuity({ state, currentOwner }), {
      source: "generated-continuity", recentCapsules: [],
    });
    if (!currentOwner) continue;
    const options = { currentOwner, stable: stableFor(currentOwner) };
    const cleared = clearBoundedGeneratedContinuity({ state, scope: "branch" });
    const next = prepare(state, options);
    assert.deepEqual(next, prepare(cleared, options));
    assert.equal(next.owner?.parentTaskId, currentOwner.parentTaskId);
    assert.equal(next.previousUsefulAnswer, undefined);
    assert.equal(state.owner?.parentTaskId, parent.parentTaskId);
  }
});

test("source-owned summary invalidation preserves the separately authorized recent history", () => {
  const first = prepare(undefined, { parentSummary: "Parent A" });
  const state = prepare(first, { parentSummary: "Parent B", stable: stableFor(parent, 2) });
  const cleared = clearBoundedGeneratedSummaries(state);
  assert.equal(cleared.latestUsefulAnswer, undefined);
  assert.equal(cleared.previousUsefulAnswer, undefined);
  assert.equal(cleared.child, undefined);
  assert.deepEqual(cleared.recentCapsules, state.recentCapsules);
  assert.deepEqual(cleared.owner, state.owner);
  assert.equal(state.latestUsefulAnswer, "Parent B");
  assert.equal(state.previousUsefulAnswer, "Parent A");
});

test("parent pair rotates only for a different authorized nonempty bounded summary", () => {
  const first = prepare(undefined, { parentSummary: "A".repeat(1200) });
  assert.equal(first.latestUsefulAnswer, "A".repeat(1000));
  const second = prepare(first, { parentSummary: "B" });
  assert.equal(second.previousUsefulAnswer, first.latestUsefulAnswer);
  const repeated = prepare(second, { parentSummary: "B" });
  assert.equal(repeated.previousUsefulAnswer, first.latestUsefulAnswer);
  const empty = prepare(repeated, { parentSummary: "  " });
  assert.equal(empty.latestUsefulAnswer, "B");
  assert.equal(empty.previousUsefulAnswer, first.latestUsefulAnswer);
  const denied = prepare(empty, { parentSummaryAllowed: false, parentSummary: "C" });
  assert.equal(denied.latestUsefulAnswer, "B");
  assert.equal(denied.previousUsefulAnswer, first.latestUsefulAnswer);
  const third = prepare(denied, { parentSummary: "C" });
  assert.equal(third.latestUsefulAnswer, "C");
  assert.equal(third.previousUsefulAnswer, "B");
});

test("default parent summary reuses the existing parser and retention contract", () => {
  const stable = stableFor(parent, 1, "Useful answer. ".repeat(150));
  const state = prepare(undefined, { stable });
  assert.equal(state.latestUsefulAnswer, buildMeetingAnswerSummary(stable.suggestion.meetingAnswer!).text);
  assert.ok(state.latestUsefulAnswer!.length <= 1000);
});

test("parent pair survives five child outputs and resume independently of recent retention", () => {
  let state = prepare(undefined, { parentSummary: "Previous parent answer" });
  state = prepare(state, { parentSummary: "Latest parent answer", stable: stableFor(parent, 2) });
  for (let index = 0; index < 5; index += 1) {
    const child = { ...parent, childTaskId: `child-${index}` };
    state = prepare(state, {
      stable: stableFor(child, index + 3),
      currentOwner: child,
      parentSummaryAllowed: true,
      parentSummary: "Child cannot overwrite parent even with parent permission",
      childSummary: `Child ${index}: ${"X".repeat(1000)}`,
    });
  }
  assert.equal(state.latestUsefulAnswer, "Latest parent answer");
  assert.equal(state.previousUsefulAnswer, "Previous parent answer");
  assert.equal(state.recentCapsules.length, 4);
  assert.ok(state.recentCapsules.every((capsule) => capsule.childTaskId && capsule.text.length <= 520));
  const childRead = readBoundedGeneratedContinuity({ state, currentOwner: { ...parent, childTaskId: "child-4" } });
  assert.equal(childRead.source, "generated-continuity");
  assert.equal(childRead.childCompactSummary?.length, 800);
  assert.equal(childRead.childCompactSummary?.slice(0, 500).length, 500);
  const wrongChild = readBoundedGeneratedContinuity({ state, currentOwner: { ...parent, childTaskId: "child-0" } });
  assert.equal(wrongChild.childCompactSummary, undefined);
  assert.equal(wrongChild.recentCapsules.length, 4);
  const resume = clearBoundedGeneratedContinuity({ state, scope: "child" });
  const parentRead = readBoundedGeneratedContinuity({ state: resume, currentOwner: parent });
  assert.equal(parentRead.latestUsefulAnswer, "Latest parent answer");
  assert.equal(parentRead.previousUsefulAnswer, "Previous parent answer");
  assert.equal(parentRead.childCompactSummary, undefined);
  assert.equal(resume.child, undefined);
  assert.equal(parentRead.recentCapsules.length, 4);
});

test("recent-only clear preserves parent and current child; branch clear removes all lanes", () => {
  const parentState = prepare();
  const child = { ...parent, childTaskId: "child-a" };
  const state = prepare(parentState, { currentOwner: child, stable: stableFor(child, 2), childSummary: "Current child summary" });
  const snapshot = structuredClone(state);
  const recent = clearBoundedGeneratedContinuity({ state, scope: "recent" });
  assert.equal(recent.latestUsefulAnswer, parentState.latestUsefulAnswer);
  assert.deepEqual(recent.child, state.child);
  assert.deepEqual(recent.recentCapsules, []);
  recent.child!.compactSummary = "Changed copy";
  assert.deepEqual(clearBoundedGeneratedContinuity({ state, scope: "branch" }), { recentCapsules: [] });
  assert.deepEqual(state, snapshot);
});

test("read DTO is detached and recent selection exactly matches the unchanged capsule path", () => {
  let state: BoundedGeneratedContinuityState = { recentCapsules: [] };
  let history = state.recentCapsules;
  for (let index = 1; index <= 5; index += 1) {
    const stable = stableFor(parent, index, index % 2 ? "Option offers lower latency. ".repeat(30) : "Choose availability because the service needs it.");
    state = prepare(state, { stable });
    history = appendAdvisorGeneratedContinuityCapsule({ history, capsule: createAdvisorGeneratedContinuityCapsule({ stable, parentRevision: 7 }) });
  }
  const read = readBoundedGeneratedContinuity({ state, currentOwner: parent });
  assert.deepEqual(read.recentCapsules, history);
  for (const options of [
    { questionText: "Explain that trade-off.", relation: "followup-parent" as const },
    { questionText: "More context", relation: "unknown" as const, responseAction: "enhance-context" as const },
    { questionText: "Explain that option.", relation: "resume-parent" as const, responseAction: "narrow-context" as const },
    { questionText: "Explain that option.", relation: "child-probe" as const, hasManualCorrection: true },
    { questionText: "An independent question", relation: "followup-parent" as const },
  ]) {
    const decision = decideBoundedRecentHistoryRead({ ...options, activeParentId: parent.parentTaskId, capsules: read.recentCapsules });
    assert.deepEqual(decision, decideBoundedRecentHistoryRead({ ...options, activeParentId: parent.parentTaskId, capsules: history }));
    assert.ok(decision.selectedCapsules.length <= 2);
    assert.ok(decision.selectedChars <= 900);
  }
  read.recentCapsules[0].text = "Mutated read DTO";
  assert.deepEqual(state.recentCapsules, history);
});
