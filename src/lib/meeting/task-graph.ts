export const TASK_GRAPH_SCHEMA_VERSION = 1 as const;
export const TASK_GRAPH_REPLAY_EVENT_SCHEMA_VERSION = 1 as const;
export const TASK_GRAPH_BUILDER_VERSION = "task-graph-replay-v1";

export type TaskGraphProjectionMode =
  | "observed-production"
  | "counterfactual-shadow";

export type TaskGraphTransitionKind =
  | "new-parent"
  | "child-probe"
  | "resume-parent"
  | "phase-progress"
  | "parent-retype"
  | "child-retype"
  | "linked-extension"
  | "task-clear"
  | "task-expire"
  | "runtime-reset"
  | "question-alias";

export type TaskGraphReplayEventStream =
  | "runtime"
  | "relation-shadow"
  | "human-expected"
  | "synthetic-legacy";

export type TaskGraphReplayEventStatus =
  | "committed"
  | "rejected"
  | "no-op"
  | "proposed";

export interface TaskGraphTaskRef {
  id: string;
  revision?: number;
  questionType?: string;
  topic?: string;
  phase?: string;
  sourceRefs?: string[];
}

export interface TaskGraphStateRef {
  parent?: TaskGraphTaskRef;
  child?: TaskGraphTaskRef;
}

export interface TaskGraphLogicalQuestionRef {
  id: string;
  canonicalId?: string;
  questionType?: string;
  topic?: string;
  sourceRefs?: string[];
}

export interface TaskGraphArtifactRef {
  id: string;
  kind: "code" | "complexity" | "whiteboard" | "other";
  revision?: number;
  parentTaskId?: string;
  identityQuality?: "authoritative" | "derived";
  sourceRefs?: string[];
}

export interface TaskGraphReplayEventV1 {
  schemaVersion: typeof TASK_GRAPH_REPLAY_EVENT_SCHEMA_VERSION;
  eventId: string;
  transitionId: string;
  sessionId: string;
  runtimeEpoch?: number;
  sequence?: number;
  occurredAt: number;
  stream: TaskGraphReplayEventStream;
  status: TaskGraphReplayEventStatus;
  kind: TaskGraphTransitionKind;
  authority: string;
  reason?: string;
  before: TaskGraphStateRef;
  after: TaskGraphStateRef;
  traceId?: string;
  settlementId?: string;
  sourceTurnIds?: string[];
  sourceObservationIds?: string[];
  logicalQuestion?: TaskGraphLogicalQuestionRef;
  artifacts?: TaskGraphArtifactRef[];
  correctionRef?: string;
  confidence?: number;
  counterfactualEligible?: boolean;
}

export interface TaskGraphSourceV1 {
  manifestHash: string;
  recordingSchemaVersion: number;
  traceSummaryVersion: number;
  builderVersion?: string;
}

export interface TaskGraphBuildInputV1 {
  mode: TaskGraphProjectionMode;
  sessionId: string;
  source: TaskGraphSourceV1;
  events: TaskGraphReplayEventV1[];
  knownSourceRefs?: string[];
  generatedAt?: number;
}

export type TaskGraphNodeKind =
  | "session"
  | "parent-task"
  | "child-task"
  | "logical-question"
  | "artifact";

export interface TaskGraphNode {
  id: string;
  kind: TaskGraphNodeKind;
  createdAt: number;
  closedAt?: number;
  questionType?: string;
  topic?: string;
  phase?: string;
  sourceRefs: string[];
  artifactRefs: string[];
  attributes: Record<string, unknown>;
}

export type TaskGraphEdgeKind =
  | "contains"
  | "child-of"
  | "originated-from"
  | "handoff-from"
  | "resumes"
  | "owns-artifact"
  | "corrected-by";

export interface TaskGraphEdge {
  id: string;
  kind: TaskGraphEdgeKind;
  from: string;
  to: string;
  projection:
    | "authoritative"
    | "counterfactual"
    | "synthetic";
  transitionId?: string;
  createdAt: number;
  authority?: string;
  confidence?: number;
  sourceRefs: string[];
}

export interface TaskGraphTransition {
  id: string;
  eventId: string;
  kind: TaskGraphTransitionKind;
  projection:
    | "authoritative"
    | "counterfactual"
    | "synthetic";
  stream: TaskGraphReplayEventStream;
  authority: string;
  reason?: string;
  runtimeEpoch?: number;
  occurredAt: number;
  before: TaskGraphStateRef;
  after: TaskGraphStateRef;
  sourceRefs: string[];
}

export type TaskGraphWarningSeverity = "info" | "warning" | "error";

export type TaskGraphWarningKind =
  | "session-mismatch"
  | "invalid-event"
  | "conflicting-duplicate-transition"
  | "ambiguous-event-order"
  | "initial-state-seeded"
  | "before-state-mismatch"
  | "parent-required"
  | "child-required"
  | "invalid-new-parent"
  | "invalid-child-transition"
  | "invalid-resume"
  | "invalid-phase-progress"
  | "invalid-retype"
  | "invalid-clear"
  | "missing-source-reference"
  | "unresolved-source-reference";

export interface TaskGraphWarning {
  id: string;
  kind: TaskGraphWarningKind;
  severity: TaskGraphWarningSeverity;
  message: string;
  eventId?: string;
  transitionId?: string;
  sourceRefs: string[];
}

export interface TaskGraphEvaluationLink {
  evaluationId: string;
  targetKind: "node" | "edge" | "transition" | "artifact";
  targetId: string;
  quality: "authoritative" | "best-effort";
}

export interface TaskGraphMetrics {
  inputEventCount: number;
  admittedEventCount: number;
  appliedTransitionCount: number;
  authoritativeTransitionCount: number;
  counterfactualTransitionCount: number;
  syntheticTransitionCount: number;
  rejectedTransitionCount: number;
  noOpTransitionCount: number;
  filteredTransitionCount: number;
  duplicateTransitionCount: number;
  conflictingDuplicateTransitionCount: number;
  nodeCount: number;
  edgeCount: number;
  orphanNodeCount: number;
  unresolvedSourceReferenceCount: number;
  aliasResolutionCount: number;
  warningCount: number;
  errorCount: number;
}

export interface TaskGraphArtifactV1 {
  schemaVersion: typeof TASK_GRAPH_SCHEMA_VERSION;
  projectionMode: TaskGraphProjectionMode;
  sessionId: string;
  generatedAt: number;
  source: {
    manifestHash: string;
    recordingSchemaVersion: number;
    traceSummaryVersion: number;
    builderVersion: string;
    eventCount: number;
  };
  completeness: {
    level: "authoritative" | "best-effort" | "partial";
    warnings: TaskGraphWarning[];
  };
  nodes: TaskGraphNode[];
  edges: TaskGraphEdge[];
  transitions: TaskGraphTransition[];
  evaluationLinks: TaskGraphEvaluationLink[];
  metrics: TaskGraphMetrics;
}

interface ReplayState {
  currentParent?: TaskGraphTaskRef;
  currentChild?: TaskGraphTaskRef;
  nodes: Map<string, TaskGraphNode>;
  edges: Map<string, TaskGraphEdge>;
  transitions: TaskGraphTransition[];
  warnings: TaskGraphWarning[];
  metrics: TaskGraphMetrics;
  knownSourceRefs?: Set<string>;
  unresolvedSourceRefs: Set<string>;
  warningSequence: number;
}

interface ApplyResult {
  applied: boolean;
  seededInitialState?: boolean;
}

export function buildTaskGraphArtifactV1(
  input: TaskGraphBuildInputV1
): TaskGraphArtifactV1 {
  const state = createReplayState(input.knownSourceRefs);
  state.metrics.inputEventCount = input.events.length;
  const sessionNodeId = toNodeId("session", input.sessionId);
  upsertNode(state, {
    id: sessionNodeId,
    kind: "session",
    createdAt: earliestTimestamp(input.events),
    sourceRefs: [],
    artifactRefs: [],
    attributes: {
      projectionMode: input.mode,
    },
  });

  const orderedEvents = [...input.events].sort(compareReplayEvents);
  const seenTransitions = new Map<string, string>();
  let priorOrderedAdmitted: TaskGraphReplayEventV1 | undefined;

  for (const event of orderedEvents) {
    const admission = resolveProjectionAdmission(input.mode, event);
    if (!admission.admitted) {
      if (event.status === "rejected") {
        state.metrics.rejectedTransitionCount += 1;
      } else if (event.status === "no-op") {
        state.metrics.noOpTransitionCount += 1;
      } else {
        state.metrics.filteredTransitionCount += 1;
      }
      continue;
    }
    state.metrics.admittedEventCount += 1;

    if (!isStructurallyValidEvent(event)) {
      addWarning(state, {
        kind: "invalid-event",
        severity: "error",
        message: "Replay event is missing a stable identity or timestamp.",
        event,
      });
      continue;
    }
    if (event.sessionId !== input.sessionId) {
      addWarning(state, {
        kind: "session-mismatch",
        severity: "error",
        message: "Replay event belongs to a different session.",
        event,
      });
      continue;
    }
    if (
      priorOrderedAdmitted &&
      priorOrderedAdmitted.occurredAt === event.occurredAt &&
      priorOrderedAdmitted.sequence === event.sequence &&
      priorOrderedAdmitted.transitionId !== event.transitionId
    ) {
      addWarning(state, {
        kind: "ambiguous-event-order",
        severity: "warning",
        message:
          "Multiple admitted transitions share the same timestamp and sequence; event id order was used.",
        event,
      });
    }
    priorOrderedAdmitted = event;

    const fingerprint = stableStringify(event);
    const priorFingerprint = seenTransitions.get(event.transitionId);
    if (priorFingerprint) {
      state.metrics.duplicateTransitionCount += 1;
      if (priorFingerprint !== fingerprint) {
        state.metrics.conflictingDuplicateTransitionCount += 1;
        addWarning(state, {
          kind: "conflicting-duplicate-transition",
          severity: "error",
          message:
            "The same transition id was reused with different event content.",
          event,
        });
      }
      continue;
    }
    seenTransitions.set(event.transitionId, fingerprint);

    const result = applyReplayEvent({
      state,
      sessionNodeId,
      event,
    });
    if (!result.applied) continue;

    const projection = resolveTransitionProjection(event);
    const sourceRefs = collectEventSourceRefs(event);
    validateEventSourceRefs(state, event, sourceRefs);
    state.transitions.push({
      id: event.transitionId,
      eventId: event.eventId,
      kind: event.kind,
      projection,
      stream: event.stream,
      authority: boundText(event.authority, 120),
      reason: cleanOptional(event.reason, 240),
      runtimeEpoch: event.runtimeEpoch,
      occurredAt: event.occurredAt,
      before: cloneStateRef(event.before),
      after: cloneStateRef(event.after),
      sourceRefs,
    });
    state.metrics.appliedTransitionCount += 1;
    if (projection === "authoritative") {
      state.metrics.authoritativeTransitionCount += 1;
    } else if (projection === "counterfactual") {
      state.metrics.counterfactualTransitionCount += 1;
    } else {
      state.metrics.syntheticTransitionCount += 1;
    }

    registerQuestionAndArtifacts({
      state,
      sessionNodeId,
      event,
    });
  }

  const nodes = [...state.nodes.values()].sort(compareGraphItems);
  const edges = [...state.edges.values()].sort(compareGraphItems);
  const transitions = [...state.transitions].sort(compareTransitions);
  state.metrics.nodeCount = nodes.length;
  state.metrics.edgeCount = edges.length;
  state.metrics.orphanNodeCount = countOrphanNodes(nodes, edges);
  state.metrics.warningCount = state.warnings.length;
  state.metrics.errorCount = state.warnings.filter(
    (warning) => warning.severity === "error"
  ).length;

  return {
    schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
    projectionMode: input.mode,
    sessionId: input.sessionId,
    generatedAt:
      input.generatedAt ?? latestTimestamp(orderedEvents),
    source: {
      manifestHash: input.source.manifestHash,
      recordingSchemaVersion: input.source.recordingSchemaVersion,
      traceSummaryVersion: input.source.traceSummaryVersion,
      builderVersion:
        input.source.builderVersion ?? TASK_GRAPH_BUILDER_VERSION,
      eventCount: input.events.length,
    },
    completeness: {
      level: resolveCompleteness(input.mode, state.warnings),
      warnings: [...state.warnings].sort(compareWarnings),
    },
    nodes,
    edges,
    transitions,
    evaluationLinks: [],
    metrics: { ...state.metrics },
  };
}

function applyReplayEvent(input: {
  state: ReplayState;
  sessionNodeId: string;
  event: TaskGraphReplayEventV1;
}): ApplyResult {
  const { state, sessionNodeId, event } = input;
  let seededInitialState = false;
  if (
    !state.currentParent &&
    event.before.parent
  ) {
    state.currentParent = cloneTaskRef(event.before.parent);
    state.currentChild = cloneTaskRef(event.before.child);
    registerTaskState(
      state,
      sessionNodeId,
      event.before,
      event,
      "synthetic"
    );
    seededInitialState = true;
    addWarning(state, {
      kind: "initial-state-seeded",
      severity: "warning",
      message:
        "Replay started after task creation and seeded state from the first before snapshot.",
      event,
    });
  }

  if (!beforeStateMatches(state, event.before)) {
    addWarning(state, {
      kind: "before-state-mismatch",
      severity: "error",
      message:
        "Event before-state does not match the state produced by prior transitions.",
      event,
    });
    return { applied: false, seededInitialState };
  }

  switch (event.kind) {
    case "new-parent":
      return applyNewParent(state, sessionNodeId, event);
    case "child-probe":
      return applyChildProbe(state, sessionNodeId, event);
    case "resume-parent":
      return applyResumeParent(state, event);
    case "phase-progress":
      return applyPhaseProgress(state, event);
    case "parent-retype":
      return applyParentRetype(state, event);
    case "child-retype":
      return applyChildRetype(state, event);
    case "linked-extension":
      return applyLinkedExtension(state, sessionNodeId, event);
    case "task-clear":
    case "task-expire":
    case "runtime-reset":
      return applyTaskClear(state, event);
    case "question-alias":
      return applyQuestionAlias(state, sessionNodeId, event);
  }
}

function applyNewParent(
  state: ReplayState,
  sessionNodeId: string,
  event: TaskGraphReplayEventV1
): ApplyResult {
  const nextParent = event.after.parent;
  if (!nextParent?.id || event.after.child) {
    addWarning(state, {
      kind: "invalid-new-parent",
      severity: "error",
      message:
        "A new-parent transition requires an after parent and cannot create an implicit child.",
      event,
    });
    return { applied: false };
  }

  const priorParent = state.currentParent;
  if (priorParent && priorParent.id !== nextParent.id) {
    closeNode(state, toNodeId("parent-task", priorParent.id), event.occurredAt);
    if (state.currentChild) {
      closeNode(
        state,
        toNodeId("child-task", state.currentChild.id),
        event.occurredAt
      );
    }
  }
  state.currentParent = cloneTaskRef(nextParent);
  state.currentChild = undefined;
  registerTaskState(state, sessionNodeId, event.after, event);
  if (priorParent && priorParent.id !== nextParent.id) {
    upsertEdge(state, {
      kind: "handoff-from",
      from: toNodeId("parent-task", nextParent.id),
      to: toNodeId("parent-task", priorParent.id),
      transitionId: event.transitionId,
      createdAt: event.occurredAt,
      authority: event.authority,
      confidence: event.confidence,
      projection: resolveTransitionProjection(event),
      sourceRefs: collectEventSourceRefs(event),
    });
  }
  return { applied: true };
}

function applyChildProbe(
  state: ReplayState,
  sessionNodeId: string,
  event: TaskGraphReplayEventV1
): ApplyResult {
  const parent = event.after.parent;
  const child = event.after.child;
  if (!state.currentParent || !parent || parent.id !== state.currentParent.id) {
    addWarning(state, {
      kind: "parent-required",
      severity: "error",
      message: "A child-probe transition requires the active parent.",
      event,
    });
    return { applied: false };
  }
  if (!child?.id) {
    addWarning(state, {
      kind: "child-required",
      severity: "error",
      message: "A child-probe transition requires an after child.",
      event,
    });
    return { applied: false };
  }
  if (state.currentChild && state.currentChild.id !== child.id) {
    addWarning(state, {
      kind: "invalid-child-transition",
      severity: "error",
      message:
        "A child-probe transition cannot silently replace a different active child.",
      event,
    });
    return { applied: false };
  }

  state.currentParent = cloneTaskRef(parent);
  state.currentChild = cloneTaskRef(child);
  registerTaskState(state, sessionNodeId, event.after, event);
  upsertEdge(state, {
    kind: "child-of",
    from: toNodeId("child-task", child.id),
    to: toNodeId("parent-task", parent.id),
    transitionId: event.transitionId,
    createdAt: event.occurredAt,
    authority: event.authority,
    confidence: event.confidence,
    projection: resolveTransitionProjection(event),
    sourceRefs: collectEventSourceRefs(event),
  });
  return { applied: true };
}

function applyResumeParent(
  state: ReplayState,
  event: TaskGraphReplayEventV1
): ApplyResult {
  const parent = event.after.parent;
  if (
    !state.currentParent ||
    !state.currentChild ||
    !parent ||
    parent.id !== state.currentParent.id ||
    event.after.child
  ) {
    addWarning(state, {
      kind: "invalid-resume",
      severity: "error",
      message:
        "A resume-parent transition requires an active child, the same parent, and no after child.",
      event,
    });
    return { applied: false };
  }
  upsertEdge(state, {
    kind: "resumes",
    from: toNodeId("child-task", state.currentChild.id),
    to: toNodeId("parent-task", parent.id),
    transitionId: event.transitionId,
    createdAt: event.occurredAt,
    authority: event.authority,
    confidence: event.confidence,
    projection: resolveTransitionProjection(event),
    sourceRefs: collectEventSourceRefs(event),
  });
  closeNode(
    state,
    toNodeId("child-task", state.currentChild.id),
    event.occurredAt
  );
  state.currentParent = cloneTaskRef(parent);
  state.currentChild = undefined;
  updateTaskNode(state, "parent-task", parent, event);
  return { applied: true };
}

function applyPhaseProgress(
  state: ReplayState,
  event: TaskGraphReplayEventV1
): ApplyResult {
  const parent = event.after.parent;
  if (
    !state.currentParent ||
    !parent ||
    parent.id !== state.currentParent.id ||
    !parent.phase ||
    !taskRefIdentitiesMatch(state.currentChild, event.after.child)
  ) {
    addWarning(state, {
      kind: "invalid-phase-progress",
      severity: "error",
      message:
        "A phase-progress transition requires the same active parent and an explicit after phase.",
      event,
    });
    return { applied: false };
  }
  state.currentParent = cloneTaskRef(parent);
  state.currentChild = cloneTaskRef(event.after.child);
  updateTaskNode(state, "parent-task", parent, event);
  if (event.after.child) {
    updateTaskNode(state, "child-task", event.after.child, event);
  }
  return { applied: true };
}

function applyParentRetype(
  state: ReplayState,
  event: TaskGraphReplayEventV1
): ApplyResult {
  const parent = event.after.parent;
  if (
    !state.currentParent ||
    !parent ||
    parent.id !== state.currentParent.id ||
    !parent.questionType ||
    parent.questionType === state.currentParent.questionType ||
    !taskRefIdentitiesMatch(state.currentChild, event.after.child)
  ) {
    addWarning(state, {
      kind: "invalid-retype",
      severity: "error",
      message:
        "A parent-retype transition requires the same parent and a changed explicit question type.",
      event,
    });
    return { applied: false };
  }
  state.currentParent = cloneTaskRef(parent);
  state.currentChild = cloneTaskRef(event.after.child);
  updateTaskNode(state, "parent-task", parent, event);
  return { applied: true };
}

function applyChildRetype(
  state: ReplayState,
  event: TaskGraphReplayEventV1
): ApplyResult {
  const parent = event.after.parent;
  const child = event.after.child;
  if (
    !state.currentParent ||
    !state.currentChild ||
    !parent ||
    parent.id !== state.currentParent.id ||
    !child ||
    child.id !== state.currentChild.id ||
    !child.questionType ||
    child.questionType === state.currentChild.questionType
  ) {
    addWarning(state, {
      kind: "invalid-retype",
      severity: "error",
      message:
        "A child-retype transition requires the same active parent and child with a changed explicit type.",
      event,
    });
    return { applied: false };
  }
  state.currentParent = cloneTaskRef(parent);
  state.currentChild = cloneTaskRef(child);
  updateTaskNode(state, "child-task", child, event);
  return { applied: true };
}

function applyLinkedExtension(
  state: ReplayState,
  sessionNodeId: string,
  event: TaskGraphReplayEventV1
): ApplyResult {
  const nextParent = event.after.parent;
  if (!state.currentParent || !nextParent) {
    addWarning(state, {
      kind: "parent-required",
      severity: "error",
      message:
        "A linked-extension transition requires both the prior and resulting parent.",
      event,
    });
    return { applied: false };
  }
  const priorParent = state.currentParent;
  const priorChild = state.currentChild;
  if (priorParent.id !== nextParent.id) {
    closeNode(state, toNodeId("parent-task", priorParent.id), event.occurredAt);
  }
  if (
    priorChild &&
    priorChild.id !== event.after.child?.id
  ) {
    closeNode(
      state,
      toNodeId("child-task", priorChild.id),
      event.occurredAt
    );
  }
  state.currentParent = cloneTaskRef(nextParent);
  state.currentChild = cloneTaskRef(event.after.child);
  registerTaskState(state, sessionNodeId, event.after, event);
  upsertEdge(state, {
    kind: "handoff-from",
    from: toNodeId("parent-task", nextParent.id),
    to: toNodeId("parent-task", priorParent.id),
    transitionId: event.transitionId,
    createdAt: event.occurredAt,
    authority: event.authority,
    confidence: event.confidence,
    projection: resolveTransitionProjection(event),
    sourceRefs: collectEventSourceRefs(event),
  });
  return { applied: true };
}

function applyTaskClear(
  state: ReplayState,
  event: TaskGraphReplayEventV1
): ApplyResult {
  if (event.after.parent || event.after.child) {
    addWarning(state, {
      kind: "invalid-clear",
      severity: "error",
      message:
        "A clear, expiration, or runtime reset transition cannot retain an after task.",
      event,
    });
    return { applied: false };
  }
  if (state.currentChild) {
    closeNode(
      state,
      toNodeId("child-task", state.currentChild.id),
      event.occurredAt
    );
  }
  if (state.currentParent) {
    closeNode(
      state,
      toNodeId("parent-task", state.currentParent.id),
      event.occurredAt
    );
  }
  state.currentParent = undefined;
  state.currentChild = undefined;
  return { applied: true };
}

function applyQuestionAlias(
  state: ReplayState,
  sessionNodeId: string,
  event: TaskGraphReplayEventV1
): ApplyResult {
  const question = event.logicalQuestion;
  if (!question?.id || !question.canonicalId) {
    addWarning(state, {
      kind: "invalid-event",
      severity: "error",
      message:
        "A question-alias transition requires provisional and canonical question ids.",
      event,
    });
    return { applied: false };
  }
  const sourceRefs = uniqueStrings([
    ...collectEventSourceRefs(event),
    ...(question.sourceRefs ?? []),
  ]);
  const provisionalId = toNodeId("logical-question", question.id);
  const canonicalId = toNodeId(
    "logical-question",
    question.canonicalId
  );
  upsertNode(state, {
    id: provisionalId,
    kind: "logical-question",
    createdAt: event.occurredAt,
    questionType: cleanOptional(question.questionType, 80),
    topic: cleanOptional(question.topic, 240),
    sourceRefs,
    artifactRefs: [],
    attributes: { identityQuality: "provisional" },
  });
  upsertNode(state, {
    id: canonicalId,
    kind: "logical-question",
    createdAt: event.occurredAt,
    questionType: cleanOptional(question.questionType, 80),
    topic: cleanOptional(question.topic, 240),
    sourceRefs,
    artifactRefs: [],
    attributes: { identityQuality: "canonical" },
  });
  attachToSession(state, sessionNodeId, canonicalId, event);
  upsertEdge(state, {
    kind: "corrected-by",
    from: provisionalId,
    to: canonicalId,
    transitionId: event.transitionId,
    createdAt: event.occurredAt,
    authority: event.authority,
    confidence: event.confidence,
    projection: resolveTransitionProjection(event),
    sourceRefs,
  });
  state.metrics.aliasResolutionCount += 1;
  return { applied: true };
}

function registerTaskState(
  state: ReplayState,
  sessionNodeId: string,
  taskState: TaskGraphStateRef,
  event: TaskGraphReplayEventV1,
  projectionOverride?: TaskGraphEdge["projection"]
) {
  if (taskState.parent) {
    updateTaskNode(state, "parent-task", taskState.parent, event);
    attachToSession(
      state,
      sessionNodeId,
      toNodeId("parent-task", taskState.parent.id),
      event,
      projectionOverride
    );
  }
  if (taskState.child) {
    updateTaskNode(state, "child-task", taskState.child, event);
    attachToSession(
      state,
      sessionNodeId,
      toNodeId("child-task", taskState.child.id),
      event,
      projectionOverride
    );
  }
}

function updateTaskNode(
  state: ReplayState,
  kind: "parent-task" | "child-task",
  task: TaskGraphTaskRef,
  event: TaskGraphReplayEventV1
) {
  upsertNode(state, {
    id: toNodeId(kind, task.id),
    kind,
    createdAt: event.occurredAt,
    questionType: cleanOptional(task.questionType, 80),
    topic: cleanOptional(task.topic, 240),
    phase: cleanOptional(task.phase, 80),
    sourceRefs: uniqueStrings([
      ...collectEventSourceRefs(event),
      ...(task.sourceRefs ?? []),
    ]),
    artifactRefs: [],
    attributes: {
      revision: task.revision,
      runtimeEpoch: event.runtimeEpoch,
    },
  });
}

function registerQuestionAndArtifacts(input: {
  state: ReplayState;
  sessionNodeId: string;
  event: TaskGraphReplayEventV1;
}) {
  const { state, sessionNodeId, event } = input;
  const question = event.logicalQuestion;
  if (question && event.kind !== "question-alias") {
    const questionNodeId = toNodeId(
      "logical-question",
      question.canonicalId ?? question.id
    );
    const sourceRefs = uniqueStrings([
      ...collectEventSourceRefs(event),
      ...(question.sourceRefs ?? []),
    ]);
    upsertNode(state, {
      id: questionNodeId,
      kind: "logical-question",
      createdAt: event.occurredAt,
      questionType: cleanOptional(question.questionType, 80),
      topic: cleanOptional(question.topic, 240),
      sourceRefs,
      artifactRefs: [],
      attributes: {
        identityQuality: question.canonicalId
          ? "canonical"
          : "provisional",
      },
    });
    attachToSession(state, sessionNodeId, questionNodeId, event);
    const owner = event.after.child
      ? toNodeId("child-task", event.after.child.id)
      : event.after.parent
        ? toNodeId("parent-task", event.after.parent.id)
        : undefined;
    if (owner) {
      upsertEdge(state, {
        kind: "originated-from",
        from: owner,
        to: questionNodeId,
        transitionId: event.transitionId,
        createdAt: event.occurredAt,
        authority: event.authority,
        confidence: event.confidence,
        projection: resolveTransitionProjection(event),
        sourceRefs,
      });
    }
  }

  for (const artifact of event.artifacts ?? []) {
    const parentId =
      artifact.parentTaskId ?? event.after.parent?.id;
    if (!parentId) continue;
    const artifactNodeId = toNodeId("artifact", artifact.id);
    const sourceRefs = uniqueStrings([
      ...collectEventSourceRefs(event),
      ...(artifact.sourceRefs ?? []),
    ]);
    const parentNodeId = toNodeId("parent-task", parentId);
    const parentNode = state.nodes.get(parentNodeId);
    if (!parentNode) {
      addWarning(state, {
        kind: "parent-required",
        severity: "error",
        message:
          "Artifact ownership references a parent absent from the replay graph.",
        event,
        sourceRefs,
      });
      continue;
    }
    upsertNode(state, {
      id: artifactNodeId,
      kind: "artifact",
      createdAt: event.occurredAt,
      sourceRefs,
      artifactRefs: [artifact.id],
      attributes: {
        artifactKind: artifact.kind,
        revision: artifact.revision,
        identityQuality:
          artifact.identityQuality ?? "authoritative",
      },
    });
    attachToSession(state, sessionNodeId, artifactNodeId, event);
    upsertEdge(state, {
      kind: "owns-artifact",
      from: toNodeId("parent-task", parentId),
      to: artifactNodeId,
      transitionId: event.transitionId,
      createdAt: event.occurredAt,
      authority: event.authority,
      confidence: event.confidence,
      projection: resolveTransitionProjection(event),
      sourceRefs,
    });
    parentNode.artifactRefs = uniqueStrings([
      ...parentNode.artifactRefs,
      artifact.id,
    ]);
  }
}

function attachToSession(
  state: ReplayState,
  sessionNodeId: string,
  nodeId: string,
  event: TaskGraphReplayEventV1,
  projectionOverride?: TaskGraphEdge["projection"]
) {
  upsertEdge(state, {
    kind: "contains",
    from: sessionNodeId,
    to: nodeId,
    transitionId: event.transitionId,
    projection:
      projectionOverride ?? resolveTransitionProjection(event),
    createdAt: event.occurredAt,
    authority: event.authority,
    sourceRefs: collectEventSourceRefs(event),
  });
}

function beforeStateMatches(
  state: ReplayState,
  before: TaskGraphStateRef
) {
  return (
    taskRefsMatch(state.currentParent, before.parent) &&
    taskRefsMatch(state.currentChild, before.child)
  );
}

function taskRefsMatch(
  current: TaskGraphTaskRef | undefined,
  expected: TaskGraphTaskRef | undefined
) {
  if (!current && !expected) return true;
  if (!current || !expected || current.id !== expected.id) return false;
  if (
    current.revision !== undefined &&
    expected.revision !== undefined &&
    current.revision !== expected.revision
  ) {
    return false;
  }
  if (
    current.questionType &&
    expected.questionType &&
    current.questionType !== expected.questionType
  ) {
    return false;
  }
  if (
    current.phase &&
    expected.phase &&
    current.phase !== expected.phase
  ) {
    return false;
  }
  return true;
}

function taskRefIdentitiesMatch(
  left: TaskGraphTaskRef | undefined,
  right: TaskGraphTaskRef | undefined
) {
  return left?.id === right?.id;
}

function resolveProjectionAdmission(
  mode: TaskGraphProjectionMode,
  event: TaskGraphReplayEventV1
) {
  if (event.stream === "runtime") {
    return { admitted: event.status === "committed" };
  }
  if (mode === "observed-production") return { admitted: false };
  return {
    admitted:
      event.counterfactualEligible === true &&
      (event.status === "proposed" || event.status === "committed"),
  };
}

function resolveTransitionProjection(
  event: TaskGraphReplayEventV1
): TaskGraphTransition["projection"] {
  if (event.stream === "runtime") return "authoritative";
  if (event.stream === "synthetic-legacy") return "synthetic";
  return "counterfactual";
}

function createReplayState(
  knownSourceRefs: string[] | undefined
): ReplayState {
  return {
    nodes: new Map(),
    edges: new Map(),
    transitions: [],
    warnings: [],
    metrics: {
      inputEventCount: 0,
      admittedEventCount: 0,
      appliedTransitionCount: 0,
      authoritativeTransitionCount: 0,
      counterfactualTransitionCount: 0,
      syntheticTransitionCount: 0,
      rejectedTransitionCount: 0,
      noOpTransitionCount: 0,
      filteredTransitionCount: 0,
      duplicateTransitionCount: 0,
      conflictingDuplicateTransitionCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      orphanNodeCount: 0,
      unresolvedSourceReferenceCount: 0,
      aliasResolutionCount: 0,
      warningCount: 0,
      errorCount: 0,
    },
    knownSourceRefs: knownSourceRefs
      ? new Set(uniqueStrings(knownSourceRefs))
      : undefined,
    unresolvedSourceRefs: new Set(),
    warningSequence: 0,
  };
}

function upsertNode(state: ReplayState, incoming: TaskGraphNode) {
  const current = state.nodes.get(incoming.id);
  if (!current) {
    state.nodes.set(incoming.id, cloneNode(incoming));
    return;
  }
  current.createdAt = Math.min(current.createdAt, incoming.createdAt);
  current.closedAt =
    current.closedAt === undefined
      ? incoming.closedAt
      : incoming.closedAt === undefined
        ? current.closedAt
        : Math.max(current.closedAt, incoming.closedAt);
  current.questionType = incoming.questionType ?? current.questionType;
  current.topic = incoming.topic ?? current.topic;
  current.phase = incoming.phase ?? current.phase;
  current.sourceRefs = uniqueStrings([
    ...current.sourceRefs,
    ...incoming.sourceRefs,
  ]);
  current.artifactRefs = uniqueStrings([
    ...current.artifactRefs,
    ...incoming.artifactRefs,
  ]);
  current.attributes = {
    ...current.attributes,
    ...dropUndefinedValues(incoming.attributes),
  };
}

function upsertEdge(
  state: ReplayState,
  incoming: Omit<TaskGraphEdge, "id">
) {
  const edge: TaskGraphEdge = {
    ...incoming,
    id: ["edge", incoming.kind, incoming.from, incoming.to].join(":"),
    sourceRefs: uniqueStrings(incoming.sourceRefs),
  };
  const current = state.edges.get(edge.id);
  if (!current) {
    state.edges.set(edge.id, edge);
    return;
  }
  current.createdAt = Math.min(current.createdAt, edge.createdAt);
  current.sourceRefs = uniqueStrings([
    ...current.sourceRefs,
    ...edge.sourceRefs,
  ]);
  current.authority = edge.authority ?? current.authority;
  current.confidence = edge.confidence ?? current.confidence;
  if (
    current.projection !== "authoritative" &&
    edge.projection === "authoritative"
  ) {
    current.projection = "authoritative";
  } else if (
    current.projection === "synthetic" &&
    edge.projection === "counterfactual"
  ) {
    current.projection = "counterfactual";
  }
}

function closeNode(
  state: ReplayState,
  nodeId: string,
  closedAt: number
) {
  const node = state.nodes.get(nodeId);
  if (!node) return;
  node.closedAt =
    node.closedAt === undefined
      ? closedAt
      : Math.max(node.closedAt, closedAt);
}

function addWarning(
  state: ReplayState,
  input: {
    kind: TaskGraphWarningKind;
    severity: TaskGraphWarningSeverity;
    message: string;
    event?: TaskGraphReplayEventV1;
    sourceRefs?: string[];
  }
) {
  state.warningSequence += 1;
  state.warnings.push({
    id: `warning:${String(state.warningSequence).padStart(4, "0")}:${input.kind}`,
    kind: input.kind,
    severity: input.severity,
    message: input.message,
    eventId: input.event?.eventId,
    transitionId: input.event?.transitionId,
    sourceRefs: uniqueStrings([
      ...(input.sourceRefs ?? []),
      ...(input.event ? collectEventSourceRefs(input.event) : []),
    ]),
  });
}

function collectEventSourceRefs(event: TaskGraphReplayEventV1) {
  const refs = uniqueStrings([
    event.traceId ? `trace:${event.traceId}` : undefined,
    event.settlementId
      ? `settlement:${event.settlementId}`
      : undefined,
    ...((event.sourceTurnIds ?? []).map((id) => `turn:${id}`)),
    ...((event.sourceObservationIds ?? []).map(
      (id) => `observation:${id}`
    )),
    event.correctionRef
      ? `correction:${event.correctionRef}`
      : undefined,
  ]);
  return refs;
}

function validateEventSourceRefs(
  state: ReplayState,
  event: TaskGraphReplayEventV1,
  sourceRefs: string[]
) {
  if (sourceRefs.length === 0) {
    addWarning(state, {
      kind: "missing-source-reference",
      severity: "warning",
      message:
        "Applied transition has no trace, turn, observation, settlement, or correction reference.",
      event,
    });
    return;
  }
  if (!state.knownSourceRefs) return;
  for (const sourceRef of sourceRefs) {
    if (
      state.knownSourceRefs.has(sourceRef) ||
      state.unresolvedSourceRefs.has(sourceRef)
    ) {
      continue;
    }
    state.unresolvedSourceRefs.add(sourceRef);
    state.metrics.unresolvedSourceReferenceCount += 1;
    addWarning(state, {
      kind: "unresolved-source-reference",
      severity: "warning",
      message: `Source reference is absent from the supplied source catalog: ${sourceRef}`,
      event,
      sourceRefs: [sourceRef],
    });
  }
}

function resolveCompleteness(
  mode: TaskGraphProjectionMode,
  warnings: TaskGraphWarning[]
) {
  if (warnings.some((warning) => warning.severity === "error")) {
    return "partial" as const;
  }
  if (
    mode === "counterfactual-shadow" ||
    warnings.some((warning) => warning.severity === "warning")
  ) {
    return "best-effort" as const;
  }
  return "authoritative" as const;
}

function countOrphanNodes(
  nodes: TaskGraphNode[],
  edges: TaskGraphEdge[]
) {
  const connected = new Set<string>();
  for (const edge of edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  return nodes.filter(
    (node) => node.kind !== "session" && !connected.has(node.id)
  ).length;
}

function isStructurallyValidEvent(event: TaskGraphReplayEventV1) {
  return Boolean(
    event.eventId.trim() &&
      event.transitionId.trim() &&
      event.sessionId.trim() &&
      event.authority.trim() &&
      Number.isFinite(event.occurredAt)
  );
}

function compareReplayEvents(
  left: TaskGraphReplayEventV1,
  right: TaskGraphReplayEventV1
) {
  return (
    left.occurredAt - right.occurredAt ||
    (left.sequence ?? Number.MAX_SAFE_INTEGER) -
      (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
    left.eventId.localeCompare(right.eventId)
  );
}

function compareGraphItems(
  left: { createdAt: number; id: string },
  right: { createdAt: number; id: string }
) {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function compareTransitions(
  left: TaskGraphTransition,
  right: TaskGraphTransition
) {
  return (
    left.occurredAt - right.occurredAt ||
    left.eventId.localeCompare(right.eventId) ||
    left.id.localeCompare(right.id)
  );
}

function compareWarnings(
  left: TaskGraphWarning,
  right: TaskGraphWarning
) {
  return left.id.localeCompare(right.id);
}

function earliestTimestamp(events: TaskGraphReplayEventV1[]) {
  return events.length > 0
    ? Math.min(...events.map((event) => event.occurredAt))
    : 0;
}

function latestTimestamp(events: TaskGraphReplayEventV1[]) {
  return events.length > 0
    ? Math.max(...events.map((event) => event.occurredAt))
    : 0;
}

function toNodeId(kind: TaskGraphNodeKind, id: string) {
  return `${kind}:${id}`;
}

function cloneTaskRef(
  value: TaskGraphTaskRef | undefined
): TaskGraphTaskRef | undefined {
  return value
    ? {
        ...value,
        sourceRefs: value.sourceRefs
          ? [...value.sourceRefs]
          : undefined,
      }
    : undefined;
}

function cloneStateRef(value: TaskGraphStateRef): TaskGraphStateRef {
  return {
    parent: cloneTaskRef(value.parent),
    child: cloneTaskRef(value.child),
  };
}

function cloneNode(value: TaskGraphNode): TaskGraphNode {
  return {
    ...value,
    sourceRefs: [...value.sourceRefs],
    artifactRefs: [...value.artifactRefs],
    attributes: { ...value.attributes },
  };
}

function boundText(value: string, maxChars: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function cleanOptional(
  value: string | undefined,
  maxChars: number
) {
  if (!value) return undefined;
  const cleaned = boundText(value, maxChars);
  return cleaned || undefined;
}

function uniqueStrings(
  values: Array<string | null | undefined>
) {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
    )
  ).sort();
}

function dropUndefinedValues(
  value: Record<string, unknown>
) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify(record[key])}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
