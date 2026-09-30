import type { RuntimeTaskRelation } from "../../src/lib/meeting/task-relation-adjudication.js";
import {
  buildTaskGraphArtifactV1,
  type TaskGraphArtifactV1,
  type TaskGraphReplayEventStream,
  type TaskGraphReplayEventV1,
  type TaskGraphSourceV1,
  type TaskGraphStateRef,
  type TaskGraphTaskRef,
} from "./task-graph.js";

export const TASK_RELATION_COUNTERFACTUAL_BRANCH_SCHEMA_VERSION = 1 as const;

export type TaskRelationSemanticValidity =
  | "valid"
  | "invalid"
  | "unavailable";

export type TaskRelationProductionApplicability =
  | "applicable"
  | "inapplicable"
  | "not-evaluated";

export type TaskRelationCounterfactualApplicability =
  | "applicable"
  | "inapplicable"
  | "not-evaluated";

export type TaskRelationCounterfactualAdmission =
  | "reviewed-shadow"
  | "human-expected"
  | "unreviewed";

export interface TaskRelationCounterfactualOperationV1 {
  schemaVersion: typeof TASK_RELATION_COUNTERFACTUAL_BRANCH_SCHEMA_VERSION;
  operationId: string;
  sessionId: string;
  occurredAt: number;
  sequence?: number;
  runtimeEpoch?: number;
  traceId?: string;
  logicalQuestionUnitId: string;
  logicalQuestionRevision: number;
  candidateRelation: RuntimeTaskRelation;
  semanticValidity: TaskRelationSemanticValidity;
  productionApplicability: TaskRelationProductionApplicability;
  productionApplicabilityReason?: string;
  admission: TaskRelationCounterfactualAdmission;
  stale?: boolean;
  confidence?: number;
  sourceParentId?: string;
  sourceParentRevision?: number;
  questionType?: string;
  topic?: string;
  sourceTurnIds?: string[];
  sourceObservationIds?: string[];
}

export interface TaskRelationCounterfactualBranchInputV1 {
  schemaVersion: typeof TASK_RELATION_COUNTERFACTUAL_BRANCH_SCHEMA_VERSION;
  sessionId: string;
  initialState: TaskGraphStateRef;
  source: TaskGraphSourceV1;
  operations: TaskRelationCounterfactualOperationV1[];
  knownSourceRefs?: string[];
  generatedAt?: number;
}

export type TaskRelationCounterfactualOperationStatus =
  | "applied"
  | "state-preserved"
  | "skipped";

export interface TaskRelationCounterfactualOperationResultV1 {
  operationId: string;
  candidateRelation: RuntimeTaskRelation;
  semanticValidity: TaskRelationSemanticValidity;
  productionApplicability: TaskRelationProductionApplicability;
  productionApplicabilityReason?: string;
  counterfactualShadowApplicability: TaskRelationCounterfactualApplicability;
  status: TaskRelationCounterfactualOperationStatus;
  reason: string;
  transitionId?: string;
  sourceParentId?: string;
  sourceParentRevision?: number;
  branchParentIdBefore?: string;
  branchParentRevisionBefore?: number;
  before: TaskGraphStateRef;
  after: TaskGraphStateRef;
}

export interface TaskRelationCounterfactualBranchV1 {
  schemaVersion: typeof TASK_RELATION_COUNTERFACTUAL_BRANCH_SCHEMA_VERSION;
  branchId: string;
  sessionId: string;
  initialState: TaskGraphStateRef;
  finalState: TaskGraphStateRef;
  events: TaskGraphReplayEventV1[];
  operationResults: TaskRelationCounterfactualOperationResultV1[];
  graph: TaskGraphArtifactV1;
}

export function buildTaskRelationCounterfactualBranchV1(
  input: TaskRelationCounterfactualBranchInputV1
): TaskRelationCounterfactualBranchV1 {
  const initialState = cloneState(input.initialState);
  let state = cloneState(initialState);
  const events: TaskGraphReplayEventV1[] = [];
  const operationResults: TaskRelationCounterfactualOperationResultV1[] = [];
  const operations = [...input.operations].sort(compareOperations);
  const operationIdCounts = countOperationIds(operations);

  for (const operation of operations) {
    const before = cloneState(state);
    const skipReason = getOperationSkipReason(input.sessionId, operation);
    if (skipReason) {
      operationResults.push(
        resultFor({
          operation,
          status: "skipped",
          applicability: "not-evaluated",
          reason: skipReason,
          before,
          after: before,
        })
      );
      continue;
    }
    if ((operationIdCounts.get(operation.operationId) ?? 0) > 1) {
      operationResults.push(
        resultFor({
          operation,
          status: "skipped",
          applicability: "inapplicable",
          reason: "duplicate-operation-id",
          before,
          after: before,
        })
      );
      continue;
    }

    if (!operation.sourceParentId) {
      operationResults.push(
        resultFor({
          operation,
          status: "skipped",
          applicability: "inapplicable",
          reason: "missing-source-parent-id",
          before,
          after: before,
        })
      );
      continue;
    }
    if (operation.sourceParentId !== state.parent?.id) {
      operationResults.push(
        resultFor({
          operation,
          status: "skipped",
          applicability: "inapplicable",
          reason: "source-parent-diverged",
          before,
          after: before,
        })
      );
      continue;
    }

    if (operation.candidateRelation === "followup-parent") {
      const applicable = Boolean(state.parent);
      operationResults.push(
        resultFor({
          operation,
          status: applicable ? "state-preserved" : "skipped",
          applicability: applicable ? "applicable" : "inapplicable",
          reason: applicable
            ? "followup-preserves-branch-state"
            : "followup-requires-parent",
          before,
          after: before,
        })
      );
      continue;
    }

    const transition = createCounterfactualTransition(operation, state);
    if (!transition.ok) {
      operationResults.push(
        resultFor({
          operation,
          status: "skipped",
          applicability: "inapplicable",
          reason: transition.reason,
          before,
          after: before,
        })
      );
      continue;
    }

    const trialEvents = [...events, transition.event];
    const trialGraph = buildTaskGraphArtifactV1({
      mode: "counterfactual-shadow",
      sessionId: input.sessionId,
      source: input.source,
      events: trialEvents,
      knownSourceRefs: input.knownSourceRefs,
      generatedAt: input.generatedAt,
    });
    const applied = trialGraph.transitions.some(
      (item) => item.id === transition.event.transitionId
    );
    if (!applied) {
      operationResults.push(
        resultFor({
          operation,
          status: "skipped",
          applicability: "inapplicable",
          reason: "task-graph-reducer-rejected",
          before,
          after: before,
        })
      );
      continue;
    }

    events.push(transition.event);
    state = cloneState(transition.event.after);
    operationResults.push(
      resultFor({
        operation,
        status: "applied",
        applicability: "applicable",
        reason: "counterfactual-transition-applied",
        transitionId: transition.event.transitionId,
        before,
        after: state,
      })
    );
  }

  const graph = buildTaskGraphArtifactV1({
    mode: "counterfactual-shadow",
    sessionId: input.sessionId,
    source: input.source,
    events,
    knownSourceRefs: input.knownSourceRefs,
    generatedAt: input.generatedAt,
  });

  return {
    schemaVersion: TASK_RELATION_COUNTERFACTUAL_BRANCH_SCHEMA_VERSION,
    branchId: createBranchId(input, operations),
    sessionId: input.sessionId,
    initialState,
    finalState: cloneState(state),
    events,
    operationResults,
    graph,
  };
}

function getOperationSkipReason(
  sessionId: string,
  operation: TaskRelationCounterfactualOperationV1
) {
  if (!operation.operationId.trim()) return "missing-operation-id";
  if (operation.sessionId !== sessionId) return "session-mismatch";
  if (!Number.isFinite(operation.occurredAt)) {
    return "invalid-operation-timestamp";
  }
  if (operation.stale) return "stale-operation";
  if (operation.admission === "unreviewed") {
    return "unreviewed-shadow-proposal";
  }
  if (operation.semanticValidity !== "valid") {
    return `semantic-candidate-${operation.semanticValidity}`;
  }
  if (operation.candidateRelation === "unknown") {
    return "unknown-relation";
  }
  return undefined;
}

function createCounterfactualTransition(
  operation: TaskRelationCounterfactualOperationV1,
  state: TaskGraphStateRef
):
  | { ok: true; event: TaskGraphReplayEventV1 }
  | { ok: false; reason: string } {
  const stream: TaskGraphReplayEventStream =
    operation.admission === "human-expected"
      ? "human-expected"
      : "relation-shadow";
  const transitionId = `counterfactual-relation:transition:${stableToken(
    operation.operationId
  )}`;
  const base = {
    schemaVersion: 1 as const,
    eventId: `counterfactual-relation:event:${stableToken(
      operation.operationId
    )}`,
    transitionId,
    sessionId: operation.sessionId,
    runtimeEpoch: operation.runtimeEpoch,
    sequence: operation.sequence,
    occurredAt: operation.occurredAt,
    stream,
    status: "proposed" as const,
    authority:
      operation.admission === "human-expected"
        ? "human-expected-relation"
        : "reviewed-shadow-relation",
    reason: `counterfactual-${operation.candidateRelation}`,
    before: cloneState(state),
    traceId: operation.traceId,
    sourceTurnIds: uniqueStrings(operation.sourceTurnIds),
    sourceObservationIds: uniqueStrings(
      operation.sourceObservationIds
    ),
    logicalQuestion: {
      id: operation.logicalQuestionUnitId,
      canonicalId: operation.logicalQuestionUnitId,
      questionType: cleanOptional(operation.questionType),
      topic: cleanOptional(operation.topic),
    },
    confidence: operation.confidence,
    counterfactualEligible: true,
  };

  if (operation.candidateRelation === "new-parent") {
    const questionType = cleanOptional(operation.questionType);
    const topic = cleanOptional(operation.topic);
    const parent: TaskGraphTaskRef = {
      id: `counterfactual-parent:${stableToken(operation.operationId)}`,
      revision: 1,
      sourceRefs: sourceRefsFor(operation),
    };
    if (questionType) parent.questionType = questionType;
    if (topic) parent.topic = topic;
    return {
      ok: true,
      event: {
        ...base,
        kind: "new-parent",
        after: { parent },
      },
    };
  }

  if (operation.candidateRelation === "child-probe") {
    if (!state.parent) {
      return { ok: false, reason: "child-requires-parent" };
    }
    if (state.child) {
      return {
        ok: false,
        reason: "child-cannot-replace-active-child",
      };
    }
    const questionType = cleanOptional(operation.questionType);
    const topic = cleanOptional(operation.topic);
    const parent = incrementRevision(state.parent);
    const child: TaskGraphTaskRef = {
      id: `counterfactual-child:${stableToken(operation.operationId)}`,
      revision: 1,
      sourceRefs: sourceRefsFor(operation),
    };
    if (questionType) child.questionType = questionType;
    if (topic) child.topic = topic;
    return {
      ok: true,
      event: {
        ...base,
        kind: "child-probe",
        after: { parent, child },
      },
    };
  }

  if (operation.candidateRelation === "resume-parent") {
    if (!state.parent || !state.child) {
      return {
        ok: false,
        reason: "resume-requires-counterfactual-child",
      };
    }
    return {
      ok: true,
      event: {
        ...base,
        kind: "resume-parent",
        after: { parent: incrementRevision(state.parent) },
      },
    };
  }

  return {
    ok: false,
    reason: "unsupported-counterfactual-relation",
  };
}

function resultFor(input: {
  operation: TaskRelationCounterfactualOperationV1;
  status: TaskRelationCounterfactualOperationStatus;
  applicability: TaskRelationCounterfactualApplicability;
  reason: string;
  transitionId?: string;
  before: TaskGraphStateRef;
  after: TaskGraphStateRef;
}): TaskRelationCounterfactualOperationResultV1 {
  return {
    operationId: input.operation.operationId,
    candidateRelation: input.operation.candidateRelation,
    semanticValidity: input.operation.semanticValidity,
    productionApplicability: input.operation.productionApplicability,
    productionApplicabilityReason:
      input.operation.productionApplicabilityReason,
    counterfactualShadowApplicability: input.applicability,
    status: input.status,
    reason: input.reason,
    transitionId: input.transitionId,
    sourceParentId: input.operation.sourceParentId,
    sourceParentRevision: input.operation.sourceParentRevision,
    branchParentIdBefore: input.before.parent?.id,
    branchParentRevisionBefore: input.before.parent?.revision,
    before: cloneState(input.before),
    after: cloneState(input.after),
  };
}

function incrementRevision(task: TaskGraphTaskRef): TaskGraphTaskRef {
  const revised = {
    ...task,
    revision: (task.revision ?? 0) + 1,
  };
  if (!task.sourceRefs) return revised;
  return { ...revised, sourceRefs: [...task.sourceRefs] };
}

function sourceRefsFor(
  operation: TaskRelationCounterfactualOperationV1
) {
  return uniqueStrings([
    operation.traceId ? `trace:${operation.traceId}` : undefined,
    ...(operation.sourceTurnIds ?? []).map((id) => `turn:${id}`),
    ...(operation.sourceObservationIds ?? []).map(
      (id) => `observation:${id}`
    ),
  ]);
}

function createBranchId(
  input: TaskRelationCounterfactualBranchInputV1,
  operations: TaskRelationCounterfactualOperationV1[]
) {
  const identity = [
    input.sessionId,
    input.initialState.parent?.id ?? "",
    input.initialState.child?.id ?? "",
    ...operations.map((operation) =>
      [
        operation.operationId,
        operation.occurredAt,
        operation.sequence ?? "",
        operation.logicalQuestionUnitId,
        operation.logicalQuestionRevision,
        operation.candidateRelation,
        operation.semanticValidity,
        operation.productionApplicability,
        operation.admission,
        operation.stale ? "stale" : "current",
        operation.sourceParentId ?? "",
        operation.sourceParentRevision ?? "",
        operation.questionType ?? "",
        operation.topic ?? "",
      ].join(":")
    ),
  ].join("|");
  return `counterfactual-relation-branch:${stableHash(identity)}`;
}

function countOperationIds(
  operations: TaskRelationCounterfactualOperationV1[]
) {
  const counts = new Map<string, number>();
  for (const operation of operations) {
    counts.set(
      operation.operationId,
      (counts.get(operation.operationId) ?? 0) + 1
    );
  }
  return counts;
}

function compareOperations(
  left: TaskRelationCounterfactualOperationV1,
  right: TaskRelationCounterfactualOperationV1
) {
  return (
    left.occurredAt - right.occurredAt ||
    (left.sequence ?? Number.MAX_SAFE_INTEGER) -
      (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
    left.logicalQuestionRevision - right.logicalQuestionRevision ||
    left.operationId.localeCompare(right.operationId)
  );
}

function cloneState(state: TaskGraphStateRef): TaskGraphStateRef {
  const cloned: TaskGraphStateRef = {};
  if (state.parent) cloned.parent = cloneTask(state.parent);
  if (state.child) cloned.child = cloneTask(state.child);
  return cloned;
}

function cloneTask(task: TaskGraphTaskRef | undefined) {
  if (!task) return undefined;
  if (!task.sourceRefs) return { ...task };
  return { ...task, sourceRefs: [...task.sourceRefs] };
}

function cleanOptional(value: string | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function uniqueStrings(values: Array<string | undefined> | undefined) {
  return [
    ...new Set(
      (values ?? [])
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
    ),
  ];
}

function stableToken(value: string) {
  return stableHash(value.trim() || "missing");
}

function stableHash(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}
