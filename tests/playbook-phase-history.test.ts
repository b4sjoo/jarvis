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
  type AppendPlaybookPhaseTransitionResult,
  type PlaybookPhaseHistoryState,
} from "../src/lib/meeting/playbook-phase-history.js";

test("appends immutable per-parent history idempotently and bounds retained entries", () => {
  const initial = createPlaybookPhaseHistoryState(2);
  const first = expectAppended(
    appendCommittedAutomaticPhaseTransition(initial, {
      operationId: "auto-1",
      parentTaskId: "parent-1",
      fromPhase: "requirement_clarification",
      toPhase: "design_framing",
      taskRevision: 4,
      expectedPhaseRevision: 0,
      committedAt: 10,
    })
  );

  assert.equal(initial.parents["parent-1"], undefined);
  assert.equal(first.entry.phaseRevision, 1);
  assert.equal(first.state.parents["parent-1"]?.phaseRevision, 1);

  const duplicate = appendCommittedAutomaticPhaseTransition(first.state, {
    operationId: "auto-1",
    parentTaskId: "parent-1",
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
      parentTaskId: "parent-1",
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
      parentTaskId: "parent-1",
      fromPhase: "follow_up",
      toPhase: "concept_explanation",
      taskRevision: 6,
      expectedPhaseRevision: 2,
      committedAt: 30,
    })
  );

  const parent = third.state.parents["parent-1"];
  assert.equal(parent?.phaseRevision, 3);
  assert.deepEqual(
    parent?.entries.map((entry) => entry.operationId),
    ["next-1", "auto-2"]
  );
});

test("Back no-ops when the parent has no committed phase history", () => {
  const decision = decideManualPlaybookPhaseBack({
    history: createPlaybookPhaseHistoryState(),
    request: {
      operationId: "back-empty",
      parentTaskId: "parent-1",
      expectedTaskRevision: 2,
      expectedPhaseRevision: 0,
      requestedAt: 100,
    },
    current: {
      parentTaskId: "parent-1",
      currentPhase: "requirement_clarification",
      taskRevision: 2,
      phaseRevision: 0,
    },
  });

  assert.equal(decision.status, "no-history");
  assert.equal(decision.action, "no-op");
  assert.equal(decision.targetPhase, undefined);
  assert.equal(decision.artifactDisposition, "preserve");
});

test("Back rejects stale task and phase revisions", () => {
  const history = oneTransitionHistory();
  const staleTask = decideManualPlaybookPhaseBack({
    history,
    request: {
      operationId: "back-stale-task",
      parentTaskId: "parent-1",
      expectedTaskRevision: 3,
      expectedPhaseRevision: 1,
      requestedAt: 100,
    },
    current: {
      parentTaskId: "parent-1",
      currentPhase: "design_framing",
      taskRevision: 4,
      phaseRevision: 1,
    },
  });
  const stalePhase = decideManualPlaybookPhaseBack({
    history,
    request: {
      operationId: "back-stale-phase",
      parentTaskId: "parent-1",
      expectedTaskRevision: 4,
      expectedPhaseRevision: 0,
      requestedAt: 100,
    },
    current: {
      parentTaskId: "parent-1",
      currentPhase: "design_framing",
      taskRevision: 4,
      phaseRevision: 1,
    },
  });

  assert.equal(staleTask.status, "stale-task-revision");
  assert.equal(stalePhase.status, "stale-phase-revision");
});

test("Back never crosses a parent boundary", () => {
  const decision = decideManualPlaybookPhaseBack({
    history: oneTransitionHistory(),
    request: {
      operationId: "back-wrong-parent",
      parentTaskId: "parent-1",
      expectedTaskRevision: 4,
      expectedPhaseRevision: 1,
      requestedAt: 100,
    },
    current: {
      parentTaskId: "parent-2",
      currentPhase: "design_framing",
      taskRevision: 4,
      phaseRevision: 1,
    },
  });

  assert.equal(decision.status, "parent-mismatch");
  assert.equal(decision.action, "no-op");
});

test("Back uses parent history while a child of the same parent is visible", () => {
  const decision = decideManualPlaybookPhaseBack({
    history: oneTransitionHistory(),
    request: {
      operationId: "back-from-child",
      parentTaskId: "parent-1",
      expectedTaskRevision: 4,
      expectedPhaseRevision: 1,
      requestedAt: 100,
    },
    current: {
      parentTaskId: "parent-1",
      currentPhase: "design_framing",
      taskRevision: 4,
      phaseRevision: 1,
      visibleChild: {
        childTaskId: "child-1",
        parentTaskId: "parent-1",
      },
    },
  });

  assert.equal(decision.status, "ready");
  assert.equal(decision.targetPhase, "requirement_clarification");
  assert.equal(decision.childPresentationDisposition, "resume-parent");
  assert.equal(decision.visibleChildTaskId, "child-1");
});

test("Back returns the prior committed phase and appends a manual-back entry", () => {
  const history = twoTransitionHistory();
  const decision = expectReadyBack(
    decideManualPlaybookPhaseBack({
      history,
      request: {
        operationId: "back-1",
        parentTaskId: "parent-1",
        expectedTaskRevision: 6,
        expectedPhaseRevision: 2,
        requestedAt: 100,
      },
      current: {
        parentTaskId: "parent-1",
        currentPhase: "follow_up",
        taskRevision: 6,
        phaseRevision: 2,
      },
    })
  );

  assert.equal(decision.targetPhase, "design_framing");
  assert.equal(decision.artifactDisposition, "preserve");

  const appended = expectAppended(
    appendCommittedManualBackPhaseTransition(history, {
      operationId: decision.operationId,
      parentTaskId: decision.parentTaskId,
      fromPhase: decision.fromPhase,
      toPhase: decision.targetPhase,
      taskRevision: 6,
      expectedPhaseRevision: decision.expectedPhaseRevision,
      committedAt: 110,
    })
  );
  assert.equal(appended.entry.source, "manual-back");
  assert.equal(appended.entry.phaseRevision, 3);
  assert.equal(
    lastEntry(appended.state)?.toPhase,
    "design_framing"
  );

  const trace = formatPlaybookPhaseNavigationDecisionForTrace(decision);
  assert.equal(trace.manualPhaseDirection, "back");
  assert.equal(trace.manualPhaseTo, "design_framing");
  assert.equal(trace.artifactDisposition, "preserve");
});

test("Next after Back targets the phase that Back just left", () => {
  const history = twoTransitionHistory();
  const back = expectReadyBack(
    decideManualPlaybookPhaseBack({
      history,
      request: {
        operationId: "back-round-trip",
        parentTaskId: "parent-1",
        expectedTaskRevision: 6,
        expectedPhaseRevision: 2,
        requestedAt: 100,
      },
      current: {
        parentTaskId: "parent-1",
        currentPhase: "follow_up",
        taskRevision: 6,
        phaseRevision: 2,
      },
    })
  );
  const afterBack = expectAppended(
    appendCommittedManualBackPhaseTransition(history, {
      operationId: back.operationId,
      parentTaskId: back.parentTaskId,
      fromPhase: back.fromPhase,
      toPhase: back.targetPhase,
      taskRevision: 6,
      expectedPhaseRevision: back.expectedPhaseRevision,
      committedAt: 110,
    })
  ).state;
  const next = decideManualPlaybookPhaseNextRoundTrip({
    history: afterBack,
    request: {
      operationId: "next-round-trip",
      parentTaskId: "parent-1",
      expectedTaskRevision: 7,
      expectedPhaseRevision: 3,
      requestedAt: 120,
    },
    current: {
      parentTaskId: "parent-1",
      currentPhase: "design_framing",
      taskRevision: 7,
      phaseRevision: 3,
    },
  });

  assert.equal(next.status, "ready");
  assert.equal(next.targetPhase, "follow_up");
  assert.equal(next.artifactDisposition, "preserve");

  if (next.status !== "ready") assert.fail("expected round-trip Next");
  const afterNext = expectAppended(
    appendCommittedManualNextPhaseTransition(afterBack, {
      operationId: next.operationId,
      parentTaskId: next.parentTaskId,
      fromPhase: next.fromPhase,
      toPhase: next.targetPhase,
      taskRevision: 7,
      expectedPhaseRevision: next.expectedPhaseRevision,
      committedAt: 130,
    })
  ).state;
  const noSecondRoundTrip = decideManualPlaybookPhaseNextRoundTrip({
    history: afterNext,
    request: {
      operationId: "next-again",
      parentTaskId: "parent-1",
      expectedTaskRevision: 8,
      expectedPhaseRevision: 4,
      requestedAt: 140,
    },
    current: {
      parentTaskId: "parent-1",
      currentPhase: "follow_up",
      taskRevision: 8,
      phaseRevision: 4,
    },
  });

  assert.equal(noSecondRoundTrip.status, "no-forward-history");
});

function oneTransitionHistory(): PlaybookPhaseHistoryState {
  return expectAppended(
    appendCommittedAutomaticPhaseTransition(
      createPlaybookPhaseHistoryState(),
      {
        operationId: "auto-base",
        parentTaskId: "parent-1",
        fromPhase: "requirement_clarification",
        toPhase: "design_framing",
        taskRevision: 4,
        expectedPhaseRevision: 0,
        committedAt: 10,
      }
    )
  ).state;
}

function twoTransitionHistory(): PlaybookPhaseHistoryState {
  const first = oneTransitionHistory();
  return expectAppended(
    appendCommittedManualNextPhaseTransition(first, {
      operationId: "next-base",
      parentTaskId: "parent-1",
      fromPhase: "design_framing",
      toPhase: "follow_up",
      taskRevision: 5,
      expectedPhaseRevision: 1,
      committedAt: 20,
    })
  ).state;
}

function lastEntry(state: PlaybookPhaseHistoryState) {
  const entries = state.parents["parent-1"]?.entries ?? [];
  return entries[entries.length - 1];
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
