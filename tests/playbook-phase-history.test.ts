import assert from "node:assert/strict";
import test from "node:test";
import {
  appendCommittedAutomaticPhaseTransition,
  appendCommittedManualBackPhaseTransition,
  appendCommittedManualNextPhaseTransition,
  createPlaybookPhaseHistoryState,
  decideManualPlaybookPhaseBack,
  decideManualPlaybookPhaseNextRoundTrip,
  formatPlaybookPhaseNavigationDecisionForTrace,
  toPlaybookPhaseOwnerKey,
  type AppendPlaybookPhaseTransitionResult,
  type PlaybookPhaseHistoryState,
  type PlaybookPhaseOwner,
} from "../src/lib/meeting/playbook-phase-history.js";
import type { InterviewPlaybookPhase } from "../src/lib/meeting/types.js";

const parentOwner = owner("parent", "parent-1", "parent-1");
const childOwner = owner("child", "child-1", "parent-1");

test("appends immutable per-branch history idempotently and bounds retained entries", () => {
  const initial = createPlaybookPhaseHistoryState(2);
  const first = expectAppended(
    appendCommittedAutomaticPhaseTransition(initial, {
      operationId: "auto-1",
      owner: parentOwner,
      fromPhase: "requirement_clarification",
      toPhase: "design_framing",
      taskRevision: 4,
      expectedPhaseRevision: 0,
      committedAt: 10,
    })
  );
  const key = toPlaybookPhaseOwnerKey(parentOwner);
  assert.equal(initial.branches[key], undefined);
  assert.equal(first.entry.phaseRevision, 1);
  assert.deepEqual(first.entry.owner, parentOwner);

  const duplicate = appendCommittedAutomaticPhaseTransition(first.state, {
    operationId: "auto-1",
    owner: parentOwner,
    fromPhase: "requirement_clarification",
    toPhase: "design_framing",
    taskRevision: 4,
    expectedPhaseRevision: 0,
    committedAt: 10,
  });
  assert.equal(duplicate.status, "duplicate-operation");
  assert.strictEqual(duplicate.state, first.state);

  const second = expectAppended(
    appendCommittedManualNextPhaseTransition(first.state, {
      operationId: "next-1",
      owner: parentOwner,
      fromPhase: "design_framing",
      toPhase: "follow_up",
      taskRevision: 5,
      expectedPhaseRevision: 1,
      committedAt: 20,
    })
  );
  const third = expectAppended(
    appendCommittedAutomaticPhaseTransition(second.state, {
      operationId: "auto-2",
      owner: parentOwner,
      fromPhase: "follow_up",
      toPhase: "concept_explanation",
      taskRevision: 6,
      expectedPhaseRevision: 2,
      committedAt: 30,
    })
  );
  assert.deepEqual(
    third.state.branches[key]?.entries.map((entry) => entry.operationId),
    ["next-1", "auto-2"]
  );
});

test("Back rejects missing history, stale revisions, and another branch", () => {
  const empty = decideManualPlaybookPhaseBack({
    history: createPlaybookPhaseHistoryState(),
    request: request("back-empty", parentOwner, 2, 0),
    current: snapshot(parentOwner, "requirement_clarification", 2, 0),
  });
  assert.equal(empty.status, "no-history");

  const history = oneTransitionHistory(parentOwner);
  const staleTask = decideManualPlaybookPhaseBack({
    history,
    request: request("back-stale-task", parentOwner, 3, 1),
    current: snapshot(parentOwner, "design_framing", 4, 1),
  });
  const stalePhase = decideManualPlaybookPhaseBack({
    history,
    request: request("back-stale-phase", parentOwner, 4, 0),
    current: snapshot(parentOwner, "design_framing", 4, 1),
  });
  const wrongOwner = decideManualPlaybookPhaseBack({
    history,
    request: request("back-wrong-owner", parentOwner, 4, 1),
    current: snapshot(childOwner, "implementation_validation", 4, 0),
  });
  assert.equal(staleTask.status, "stale-task-revision");
  assert.equal(stalePhase.status, "stale-phase-revision");
  assert.equal(wrongOwner.status, "owner-mismatch");
});

test("parent and child histories remain isolated", () => {
  const parentHistory = oneTransitionHistory(parentOwner);
  const childBack = decideManualPlaybookPhaseBack({
    history: parentHistory,
    request: request("child-back", childOwner, 4, 0),
    current: snapshot(childOwner, "implementation_validation", 4, 0),
  });
  assert.equal(childBack.status, "no-history");

  const childHistory = expectAppended(
    appendCommittedAutomaticPhaseTransition(parentHistory, {
      operationId: "child-phase",
      owner: childOwner,
      fromPhase: "optimized_pseudocode",
      toPhase: "implementation_validation",
      taskRevision: 5,
      expectedPhaseRevision: 0,
      committedAt: 20,
    })
  ).state;
  assert.equal(
    childHistory.branches[toPlaybookPhaseOwnerKey(parentOwner)]?.phaseRevision,
    1
  );
  assert.equal(
    childHistory.branches[toPlaybookPhaseOwnerKey(childOwner)]?.phaseRevision,
    1
  );
});

test("Back and Next round-trip within the same branch", () => {
  const history = twoTransitionHistory(parentOwner);
  const back = expectReadyBack(
    decideManualPlaybookPhaseBack({
      history,
      request: request("back-round-trip", parentOwner, 6, 2),
      current: snapshot(parentOwner, "follow_up", 6, 2),
    })
  );
  assert.equal(back.targetPhase, "design_framing");

  const afterBack = expectAppended(
    appendCommittedManualBackPhaseTransition(history, {
      operationId: back.operationId,
      owner: back.owner,
      fromPhase: back.fromPhase,
      toPhase: back.targetPhase,
      taskRevision: 7,
      expectedPhaseRevision: back.expectedPhaseRevision,
      committedAt: 110,
    })
  ).state;
  const next = decideManualPlaybookPhaseNextRoundTrip({
    history: afterBack,
    request: request("next-round-trip", parentOwner, 7, 3),
    current: snapshot(parentOwner, "design_framing", 7, 3),
  });
  assert.equal(next.status, "ready");
  assert.equal(next.targetPhase, "follow_up");
  if (next.status !== "ready") assert.fail("expected ready Next");

  const afterNext = expectAppended(
    appendCommittedManualNextPhaseTransition(afterBack, {
      operationId: next.operationId,
      owner: next.owner,
      fromPhase: next.fromPhase,
      toPhase: next.targetPhase,
      taskRevision: 8,
      expectedPhaseRevision: next.expectedPhaseRevision,
      committedAt: 130,
    })
  ).state;
  const noSecondRoundTrip = decideManualPlaybookPhaseNextRoundTrip({
    history: afterNext,
    request: request("next-again", parentOwner, 8, 4),
    current: snapshot(parentOwner, "follow_up", 8, 4),
  });
  assert.equal(noSecondRoundTrip.status, "no-forward-history");

  const trace = formatPlaybookPhaseNavigationDecisionForTrace(back);
  assert.equal(trace.phaseOwnerKind, "parent");
  assert.equal(trace.phaseOwnerId, "parent-1");
  assert.equal(trace.branchDisposition, "preserve-active-branch");
});

function oneTransitionHistory(
  branchOwner: PlaybookPhaseOwner
): PlaybookPhaseHistoryState {
  return expectAppended(
    appendCommittedAutomaticPhaseTransition(
      createPlaybookPhaseHistoryState(),
      {
        operationId: "auto-base",
        owner: branchOwner,
        fromPhase: "requirement_clarification",
        toPhase: "design_framing",
        taskRevision: 4,
        expectedPhaseRevision: 0,
        committedAt: 10,
      }
    )
  ).state;
}

function twoTransitionHistory(
  branchOwner: PlaybookPhaseOwner
): PlaybookPhaseHistoryState {
  const first = oneTransitionHistory(branchOwner);
  return expectAppended(
    appendCommittedManualNextPhaseTransition(first, {
      operationId: "next-base",
      owner: branchOwner,
      fromPhase: "design_framing",
      toPhase: "follow_up",
      taskRevision: 5,
      expectedPhaseRevision: 1,
      committedAt: 20,
    })
  ).state;
}

function owner(
  kind: PlaybookPhaseOwner["kind"],
  id: string,
  parentId: string
): PlaybookPhaseOwner {
  return { kind, id, parentId };
}

function request(
  operationId: string,
  branchOwner: PlaybookPhaseOwner,
  expectedTaskRevision: number,
  expectedPhaseRevision: number
) {
  return {
    operationId,
    owner: branchOwner,
    expectedTaskRevision,
    expectedPhaseRevision,
    requestedAt: 100,
  };
}

function snapshot(
  branchOwner: PlaybookPhaseOwner,
  currentPhase: InterviewPlaybookPhase,
  taskRevision: number,
  phaseRevision: number
) {
  return { owner: branchOwner, currentPhase, taskRevision, phaseRevision };
}

function expectAppended(result: AppendPlaybookPhaseTransitionResult) {
  if (result.status !== "appended") {
    assert.fail(`expected appended transition, got ${result.status}`);
  }
  return result;
}

function expectReadyBack(
  decision: ReturnType<typeof decideManualPlaybookPhaseBack>
) {
  if (decision.status !== "ready") {
    assert.fail(`expected ready Back, got ${decision.status}`);
  }
  return decision;
}
