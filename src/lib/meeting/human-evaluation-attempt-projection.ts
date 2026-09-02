import { resolveHumanEvaluationAttemptIdentityV2 } from "./human-evaluation-attempt.js";
import {
  buildHumanEvaluationProjectionMaterializationRevisionV2,
} from "./human-evaluation-projection-materialization.js";
import {
  buildHumanEvaluationObservedSnapshotV2,
  buildHumanGroundTruthSubjectV2,
  deriveHumanEvaluationProjectionV2,
  upsertHumanEvaluationProjectionV2,
  type HumanEvaluationProjectionV2,
  type HumanGroundTruthEventV2,
} from "./human-ground-truth-v2.js";
import type { MeetingTrace } from "./types.js";

export function buildHumanEvaluationAttemptEvidenceV2(input: {
  trace: MeetingTrace;
  traces?: MeetingTrace[];
}) {
  const observed = buildHumanEvaluationObservedSnapshotV2(input.trace);
  if (
    input.trace.metadata?.settledExecutionPlanTaskMutationCommand !==
    "replace-parent"
  ) {
    return {
      observed,
      traceIds: [input.trace.id],
    } as const;
  }

  const correctionTraceId = readString(
    input.trace.metadata?.parentCorrectionTraceId
  );
  if (!correctionTraceId) {
    return {
      observed,
      traceIds: [input.trace.id],
    } as const;
  }
  const correctionTrace = resolveLinkedCorrectionLifecycleTrace({
    trace: input.trace,
    traces: input.traces ?? [],
  });
  if (!correctionTrace) {
    return {
      observed: {
        ...observed,
        parentAction: undefined,
      },
      traceIds: [input.trace.id],
    } as const;
  }

  const lifecycleObserved =
    buildHumanEvaluationObservedSnapshotV2(correctionTrace);
  return {
    observed: {
      ...observed,
      parentAction: lifecycleObserved.parentAction,
    },
    traceIds: [correctionTrace.id, input.trace.id],
  } as const;
}

export function materializeHumanEvaluationAttemptProjectionV2(input: {
  trace: MeetingTrace;
  traces?: MeetingTrace[];
  currentSessionId: string;
  events: HumanGroundTruthEventV2[];
  projections: HumanEvaluationProjectionV2[];
  now?: number;
}) {
  const identity = resolveHumanEvaluationAttemptIdentityV2(input.trace);
  if (!identity || identity.sessionId !== input.currentSessionId) {
    return {
      changed: false,
      projections: input.projections,
      projection: undefined,
      reason: identity ? "session-mismatch" : "settlement-incomplete",
    } as const;
  }

  const attemptEvidence = buildHumanEvaluationAttemptEvidenceV2({
    trace: input.trace,
    traces: input.traces,
  });
  const baseSubject = buildHumanGroundTruthSubjectV2({
    trace: input.trace,
  });
  const subject = {
    ...baseSubject,
    traceIds: Array.from(
      new Set([...baseSubject.traceIds, ...attemptEvidence.traceIds])
    ),
  };
  const projection = deriveHumanEvaluationProjectionV2({
    sessionId: identity.sessionId,
    subject,
    events: input.events,
    observed: attemptEvidence.observed,
    now: input.now,
  });
  const existing = input.projections.find(
    (candidate) => candidate.subject.attemptId === identity.attemptId
  );
  if (
    existing &&
    buildHumanEvaluationProjectionMaterializationRevisionV2(existing) ===
      buildHumanEvaluationProjectionMaterializationRevisionV2(projection)
  ) {
    return {
      changed: false,
      projections: input.projections,
      projection: existing,
      reason: "unchanged",
    } as const;
  }

  return {
    changed: true,
    projections: upsertHumanEvaluationProjectionV2(
      input.projections,
      projection
    ),
    projection,
    reason: existing ? "refreshed" : "created",
  } as const;
}

function resolveLinkedCorrectionLifecycleTrace(input: {
  trace: MeetingTrace;
  traces: MeetingTrace[];
}) {
  const metadata = input.trace.metadata ?? {};
  const correctionTraceId = readString(metadata.parentCorrectionTraceId);
  const correctionId = readString(metadata.manualQuestionTypeCorrectionId);
  if (!correctionTraceId || !correctionId) return undefined;

  const correctionTrace = input.traces.find(
    (candidate) => candidate.id === correctionTraceId
  );
  const correctionMetadata = correctionTrace?.metadata ?? {};
  if (
    !correctionTrace ||
    correctionTrace.status !== "success" ||
    readString(correctionMetadata.manualQuestionTypeCorrectionId) !==
      correctionId ||
    correctionMetadata.taskLifecycleAuthorized !== true ||
    correctionMetadata.taskLifecycleMutationApplied !== true ||
    correctionMetadata.settledExecutionPlanTaskMutationCommand !==
      "replace-parent"
  ) {
    return undefined;
  }

  const terminalIdentity = readSettlementIdentity(metadata);
  const correctionIdentity = readSettlementIdentity(correctionMetadata);
  if (
    !terminalIdentity ||
    !correctionIdentity ||
    terminalIdentity.sessionId !== correctionIdentity.sessionId ||
    terminalIdentity.runtimeEpoch !== correctionIdentity.runtimeEpoch ||
    terminalIdentity.logicalQuestionUnitId !==
      correctionIdentity.logicalQuestionUnitId ||
    terminalIdentity.sourceHash !== correctionIdentity.sourceHash
  ) {
    return undefined;
  }
  return correctionTrace;
}

function readSettlementIdentity(metadata: Record<string, unknown>) {
  const sessionId = readString(
    metadata.effectiveCurrentQuestionSettlementSessionId ??
      metadata.currentQuestionSettlementSessionId
  );
  const runtimeEpoch = readNumber(
    metadata.effectiveCurrentQuestionSettlementRuntimeEpoch ??
      metadata.currentQuestionSettlementRuntimeEpoch
  );
  const logicalQuestionUnitId = readString(
    metadata.effectiveCurrentQuestionSettlementUnitId ??
      metadata.currentQuestionSettlementUnitId
  );
  const sourceHash = readString(
    metadata.effectiveCurrentQuestionSettlementSourceHash ??
      metadata.currentQuestionSettlementSourceHash
  );
  return sessionId &&
    runtimeEpoch !== undefined &&
    logicalQuestionUnitId &&
    sourceHash
    ? { sessionId, runtimeEpoch, logicalQuestionUnitId, sourceHash }
    : undefined;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
