import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTaskGraphArtifactV1,
  type TaskGraphReplayEventV1,
  type TaskGraphStateRef,
} from "../scripts/lib/task-graph.js";

const source = {
  manifestHash: "manifest-a",
  recordingSchemaVersion: 7,
  traceSummaryVersion: 30,
};

function parent(
  revision: number,
  overrides: Partial<NonNullable<TaskGraphStateRef["parent"]>> = {}
) {
  return {
    id: "parent-a",
    revision,
    questionType: "general-system-design",
    topic: "Design a ride-sharing system",
    phase: "requirement_clarification",
    ...overrides,
  };
}

function child(
  revision: number,
  overrides: Partial<NonNullable<TaskGraphStateRef["child"]>> = {}
) {
  return {
    id: "child-a",
    revision,
    questionType: "field-knowledge",
    topic: "Explain consistent hashing",
    ...overrides,
  };
}

function event(
  input: Partial<TaskGraphReplayEventV1> &
    Pick<
      TaskGraphReplayEventV1,
      "eventId" | "transitionId" | "occurredAt" | "kind"
    >
): TaskGraphReplayEventV1 {
  return {
    schemaVersion: 1,
    sessionId: "session-a",
    stream: "runtime",
    status: "committed",
    authority: "runtime-transaction",
    before: {},
    after: {},
    traceId: `trace-${input.eventId}`,
    ...input,
  };
}

function productionFixture() {
  const parentV1 = parent(1);
  const parentV2 = parent(2);
  const parentV3 = parent(3);
  const parentV4 = parent(4, { phase: "high_level_design" });
  return [
    event({
      eventId: "event-1",
      transitionId: "transition-1",
      occurredAt: 10,
      sequence: 1,
      kind: "new-parent",
      before: {},
      after: { parent: parentV1 },
      sourceTurnIds: ["turn-parent"],
      logicalQuestion: {
        id: "trace:question-parent",
        canonicalId: "lqu:question-parent",
        questionType: "general-system-design",
        topic: "Design a ride-sharing system",
        sourceRefs: ["turn:turn-parent"],
      },
    }),
    event({
      eventId: "event-2",
      transitionId: "transition-2",
      occurredAt: 20,
      sequence: 2,
      kind: "child-probe",
      before: { parent: parentV1 },
      after: { parent: parentV2, child: child(1) },
      sourceTurnIds: ["turn-child"],
      logicalQuestion: {
        id: "lqu:question-child",
        questionType: "field-knowledge",
        topic: "Explain consistent hashing",
      },
    }),
    event({
      eventId: "event-3",
      transitionId: "transition-3",
      occurredAt: 30,
      sequence: 3,
      kind: "resume-parent",
      before: { parent: parentV2, child: child(1) },
      after: { parent: parentV3 },
      sourceTurnIds: ["turn-resume"],
    }),
    event({
      eventId: "event-4",
      transitionId: "transition-4",
      occurredAt: 40,
      sequence: 4,
      kind: "phase-progress",
      before: { parent: parentV3 },
      after: { parent: parentV4 },
      sourceTurnIds: ["turn-phase"],
      artifacts: [
        {
          id: "whiteboard-a",
          kind: "whiteboard",
          revision: 2,
          parentTaskId: "parent-a",
          identityQuality: "authoritative",
        },
      ],
    }),
    event({
      eventId: "event-5",
      transitionId: "transition-5",
      occurredAt: 50,
      sequence: 5,
      kind: "question-alias",
      before: { parent: parentV4 },
      after: { parent: parentV4 },
      sourceTurnIds: ["turn-alias"],
      logicalQuestion: {
        id: "trace:temporary-question",
        canonicalId: "lqu:canonical-question",
      },
    }),
  ];
}

test("replays parent, child, resume, phase, artifact, and alias transitions", () => {
  const graph = buildTaskGraphArtifactV1({
    mode: "observed-production",
    sessionId: "session-a",
    source,
    events: productionFixture(),
    generatedAt: 100,
  });

  assert.equal(graph.completeness.level, "authoritative");
  assert.equal(graph.transitions.length, 5);
  assert.equal(graph.metrics.authoritativeTransitionCount, 5);
  assert.equal(graph.metrics.counterfactualTransitionCount, 0);
  assert.equal(graph.metrics.aliasResolutionCount, 1);
  assert.ok(
    graph.nodes.some(
      (node) =>
        node.id === "parent-task:parent-a" &&
        node.phase === "high_level_design" &&
        node.artifactRefs.includes("whiteboard-a")
    )
  );
  assert.ok(
    graph.nodes.some(
      (node) =>
        node.id === "child-task:child-a" &&
        node.closedAt === 30
    )
  );
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.kind === "child-of" &&
        edge.from === "child-task:child-a" &&
        edge.to === "parent-task:parent-a"
    )
  );
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.kind === "resumes" &&
        edge.from === "child-task:child-a"
    )
  );
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.kind === "owns-artifact" &&
        edge.to === "artifact:whiteboard-a"
    )
  );
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.kind === "corrected-by" &&
        edge.from ===
          "logical-question:trace:temporary-question" &&
        edge.to ===
          "logical-question:lqu:canonical-question"
    )
  );
});

test("produces the same semantic graph for reversed input order", () => {
  const events = productionFixture();
  const chronological = buildTaskGraphArtifactV1({
    mode: "observed-production",
    sessionId: "session-a",
    source,
    events,
    generatedAt: 100,
  });
  const reversed = buildTaskGraphArtifactV1({
    mode: "observed-production",
    sessionId: "session-a",
    source,
    events: [...events].reverse(),
    generatedAt: 100,
  });

  assert.deepEqual(reversed, chronological);
  assert.deepEqual(events, productionFixture());
});

test("keeps shadow proposals out of observed production and admits explicit counterfactuals", () => {
  const parentEvent = productionFixture()[0];
  const shadowChild = event({
    eventId: "shadow-child",
    transitionId: "shadow-transition-child",
    occurredAt: 20,
    sequence: 2,
    kind: "child-probe",
    stream: "relation-shadow",
    status: "proposed",
    counterfactualEligible: true,
    authority: "task-150c3-shadow",
    before: { parent: parent(1) },
    after: { parent: parent(2), child: child(1) },
    sourceTurnIds: ["turn-child"],
  });

  const observed = buildTaskGraphArtifactV1({
    mode: "observed-production",
    sessionId: "session-a",
    source,
    events: [parentEvent, shadowChild],
    generatedAt: 30,
  });
  const counterfactual = buildTaskGraphArtifactV1({
    mode: "counterfactual-shadow",
    sessionId: "session-a",
    source,
    events: [parentEvent, shadowChild],
    generatedAt: 30,
  });

  assert.equal(observed.transitions.length, 1);
  assert.equal(observed.metrics.filteredTransitionCount, 1);
  assert.equal(
    observed.nodes.some((node) => node.kind === "child-task"),
    false
  );
  assert.equal(counterfactual.transitions.length, 2);
  assert.equal(counterfactual.metrics.counterfactualTransitionCount, 1);
  assert.equal(counterfactual.completeness.level, "best-effort");
});

test("does not let filtered shadow evidence degrade observed completeness", () => {
  const production = productionFixture()[0];
  const conflictingShadow = event({
    eventId: "shadow-conflict",
    transitionId: production.transitionId,
    occurredAt: 5,
    kind: "new-parent",
    stream: "relation-shadow",
    status: "proposed",
    counterfactualEligible: true,
    before: {},
    after: {
      parent: parent(1, {
        id: "shadow-parent",
        topic: "Shadow-only task",
      }),
    },
  });
  const malformedShadow = event({
    eventId: "",
    transitionId: "malformed-shadow",
    occurredAt: 10,
    kind: "new-parent",
    stream: "relation-shadow",
    status: "proposed",
    counterfactualEligible: true,
    before: {},
    after: { parent: parent(1, { id: "malformed-parent" }) },
  });
  const graph = buildTaskGraphArtifactV1({
    mode: "observed-production",
    sessionId: "session-a",
    source,
    events: [conflictingShadow, malformedShadow, production],
    generatedAt: 30,
  });

  assert.equal(graph.completeness.level, "authoritative");
  assert.equal(graph.transitions.length, 1);
  assert.equal(graph.metrics.filteredTransitionCount, 2);
  assert.equal(graph.metrics.conflictingDuplicateTransitionCount, 0);
  assert.equal(graph.completeness.warnings.length, 0);
});

test("deduplicates identical transitions and fails closed on conflicting duplicates", () => {
  const original = productionFixture()[0];
  const identical = structuredClone(original);
  const conflicting = {
    ...structuredClone(original),
    eventId: "event-conflict",
    after: {
      parent: parent(1, {
        id: "parent-conflict",
        topic: "A different task",
      }),
    },
  };
  const graph = buildTaskGraphArtifactV1({
    mode: "observed-production",
    sessionId: "session-a",
    source,
    events: [original, identical, conflicting],
    generatedAt: 30,
  });

  assert.equal(graph.transitions.length, 1);
  assert.equal(graph.metrics.duplicateTransitionCount, 2);
  assert.equal(graph.metrics.conflictingDuplicateTransitionCount, 1);
  assert.equal(graph.completeness.level, "partial");
  assert.ok(
    graph.completeness.warnings.some(
      (warning) =>
        warning.kind === "conflicting-duplicate-transition"
    )
  );
});

test("rejects an orphan child instead of inventing a parent", () => {
  const graph = buildTaskGraphArtifactV1({
    mode: "observed-production",
    sessionId: "session-a",
    source,
    events: [
      event({
        eventId: "orphan-child",
        transitionId: "orphan-child-transition",
        occurredAt: 10,
        kind: "child-probe",
        before: {},
        after: { parent: parent(1), child: child(1) },
        sourceTurnIds: ["turn-orphan"],
      }),
    ],
    generatedAt: 20,
  });

  assert.equal(graph.transitions.length, 0);
  assert.equal(graph.completeness.level, "partial");
  assert.ok(
    graph.completeness.warnings.some(
      (warning) => warning.kind === "parent-required"
    )
  );
});

test("counts rejected and no-op runtime events without projecting them", () => {
  const rejected = event({
    eventId: "rejected",
    transitionId: "rejected-transition",
    occurredAt: 10,
    kind: "new-parent",
    status: "rejected",
    before: {},
    after: { parent: parent(1) },
  });
  const noOp = event({
    eventId: "no-op",
    transitionId: "no-op-transition",
    occurredAt: 20,
    kind: "new-parent",
    status: "no-op",
    before: {},
    after: { parent: parent(1) },
  });
  const graph = buildTaskGraphArtifactV1({
    mode: "observed-production",
    sessionId: "session-a",
    source,
    events: [rejected, noOp],
    generatedAt: 30,
  });

  assert.equal(graph.metrics.inputEventCount, 2);
  assert.equal(graph.metrics.admittedEventCount, 0);
  assert.equal(graph.metrics.rejectedTransitionCount, 1);
  assert.equal(graph.metrics.noOpTransitionCount, 1);
  assert.equal(graph.transitions.length, 0);
});

test("marks a mid-session seed and unresolved source references as best effort", () => {
  const parentV2 = parent(2);
  const parentV3 = parent(3, { phase: "high_level_design" });
  const graph = buildTaskGraphArtifactV1({
    mode: "observed-production",
    sessionId: "session-a",
    source,
    events: [
      event({
        eventId: "mid-session",
        transitionId: "mid-session-transition",
        occurredAt: 20,
        kind: "phase-progress",
        before: { parent: parentV2 },
        after: { parent: parentV3 },
        traceId: "trace-missing",
      }),
    ],
    knownSourceRefs: ["trace:trace-known"],
    generatedAt: 30,
  });

  assert.equal(graph.transitions.length, 1);
  assert.equal(graph.completeness.level, "best-effort");
  assert.equal(graph.metrics.unresolvedSourceReferenceCount, 1);
  assert.ok(
    graph.completeness.warnings.some(
      (warning) => warning.kind === "initial-state-seeded"
    )
  );
  assert.ok(
    graph.completeness.warnings.some(
      (warning) => warning.kind === "unresolved-source-reference"
    )
  );
});

test("rejects before-state drift and leaves the prior graph intact", () => {
  const parentEvent = productionFixture()[0];
  const drift = event({
    eventId: "drift",
    transitionId: "drift-transition",
    occurredAt: 20,
    kind: "phase-progress",
    before: {
      parent: parent(99, { id: "different-parent" }),
    },
    after: {
      parent: parent(100, {
        id: "different-parent",
        phase: "high_level_design",
      }),
    },
    sourceTurnIds: ["turn-drift"],
  });
  const graph = buildTaskGraphArtifactV1({
    mode: "observed-production",
    sessionId: "session-a",
    source,
    events: [parentEvent, drift],
    generatedAt: 30,
  });

  assert.equal(graph.transitions.length, 1);
  assert.equal(graph.completeness.level, "partial");
  assert.equal(
    graph.nodes.some(
      (node) => node.id === "parent-task:different-parent"
    ),
    false
  );
  assert.ok(
    graph.completeness.warnings.some(
      (warning) => warning.kind === "before-state-mismatch"
    )
  );
});

test("replays parent and child retypes, linked extension, and runtime reset", () => {
  const parentGeneral = parent(1);
  const parentAi = parent(2, {
    questionType: "ai-ml-system-design",
    topic: "Design a travel recommendation agent",
  });
  const parentWithChild = parent(3, {
    questionType: "ai-ml-system-design",
    topic: "Design a travel recommendation agent",
  });
  const parentAfterChildRetype = parent(4, {
    questionType: "ai-ml-system-design",
    topic: "Design a travel recommendation agent",
  });
  const fieldChild = child(1);
  const codingChild = child(2, {
    questionType: "coding",
    topic: "Implement the retrieval scoring function",
  });
  const linkedParent = parent(1, {
    id: "parent-b",
    questionType: "project-deep-dive",
    topic: "Connect the design to Agentic Memory",
    phase: "follow_up",
  });
  const events = [
    event({
      eventId: "retype-1",
      transitionId: "retype-transition-1",
      occurredAt: 10,
      sequence: 1,
      kind: "new-parent",
      before: {},
      after: { parent: parentGeneral },
      sourceTurnIds: ["turn-1"],
    }),
    event({
      eventId: "retype-2",
      transitionId: "retype-transition-2",
      occurredAt: 20,
      sequence: 2,
      kind: "parent-retype",
      before: { parent: parentGeneral },
      after: { parent: parentAi },
      sourceTurnIds: ["turn-2"],
    }),
    event({
      eventId: "retype-3",
      transitionId: "retype-transition-3",
      occurredAt: 30,
      sequence: 3,
      kind: "child-probe",
      before: { parent: parentAi },
      after: { parent: parentWithChild, child: fieldChild },
      sourceTurnIds: ["turn-3"],
    }),
    event({
      eventId: "retype-4",
      transitionId: "retype-transition-4",
      occurredAt: 40,
      sequence: 4,
      kind: "child-retype",
      before: { parent: parentWithChild, child: fieldChild },
      after: {
        parent: parentAfterChildRetype,
        child: codingChild,
      },
      sourceTurnIds: ["turn-4"],
    }),
    event({
      eventId: "retype-5",
      transitionId: "retype-transition-5",
      occurredAt: 50,
      sequence: 5,
      kind: "linked-extension",
      before: {
        parent: parentAfterChildRetype,
        child: codingChild,
      },
      after: { parent: linkedParent },
      sourceTurnIds: ["turn-5"],
    }),
    event({
      eventId: "retype-6",
      transitionId: "retype-transition-6",
      occurredAt: 60,
      sequence: 6,
      kind: "runtime-reset",
      before: { parent: linkedParent },
      after: {},
      sourceTurnIds: ["turn-6"],
    }),
  ];

  const graph = buildTaskGraphArtifactV1({
    mode: "observed-production",
    sessionId: "session-a",
    source,
    events,
    generatedAt: 70,
  });

  assert.equal(graph.completeness.level, "authoritative");
  assert.equal(graph.transitions.length, 6);
  assert.ok(
    graph.nodes.some(
      (node) =>
        node.id === "parent-task:parent-a" &&
        node.questionType === "ai-ml-system-design" &&
        node.closedAt === 50
    )
  );
  assert.ok(
    graph.nodes.some(
      (node) =>
        node.id === "child-task:child-a" &&
        node.questionType === "coding" &&
        node.closedAt === 50
    )
  );
  assert.ok(
    graph.nodes.some(
      (node) =>
        node.id === "parent-task:parent-b" &&
        node.closedAt === 60
    )
  );
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.kind === "handoff-from" &&
        edge.from === "parent-task:parent-b" &&
        edge.to === "parent-task:parent-a"
    )
  );
});

test("marks relationships synthesized from a partial first before-state", () => {
  const priorParent = parent(3, { id: "parent-prior" });
  const nextParent = parent(1, { id: "parent-next" });
  const graph = buildTaskGraphArtifactV1({
    mode: "observed-production",
    sessionId: "session-a",
    source,
    events: [
      event({
        eventId: "partial-new-parent",
        transitionId: "partial-new-parent-transition",
        occurredAt: 20,
        kind: "new-parent",
        before: { parent: priorParent },
        after: { parent: nextParent },
        sourceTurnIds: ["turn-partial"],
      }),
    ],
    generatedAt: 30,
  });

  assert.equal(graph.transitions.length, 1);
  assert.equal(graph.completeness.level, "best-effort");
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.kind === "contains" &&
        edge.to === "parent-task:parent-prior" &&
        edge.projection === "synthetic"
    )
  );
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.kind === "handoff-from" &&
        edge.projection === "authoritative"
    )
  );
});
