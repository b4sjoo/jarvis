import { resolveHumanEvaluationAttemptIdentityV2 } from "./human-evaluation-attempt.js";
import {
  buildHumanEvaluationProjectionMaterializationRevisionV2,
} from "./human-evaluation-projection-materialization.js";
import {
  projectHumanEvaluationObservedFieldsV2,
  buildHumanGroundTruthSubjectV2,
  deriveHumanEvaluationProjectionV2,
  projectObservedPrimaryAskTargetV2,
  rehashHumanEvaluationObservedSnapshotV2,
  upsertHumanEvaluationProjectionV2,
  type HumanEvaluationProjectionV2,
  type HumanGroundTruthEventV2,
} from "./human-ground-truth-v2.js";
import type { MeetingTrace } from "./types.js";

interface PrimaryAskJoinIdentity {
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  revision: number;
  sourceHash: string;
}

type PrimaryAskTargetObservation = ReturnType<
  typeof projectObservedPrimaryAskTargetV2
>;

export interface HumanEvaluationAttemptEvidenceIndexV2 {
  tracesById: ReadonlyMap<string, MeetingTrace>;
  primaryAskTargetsByIdentity: ReadonlyMap<
    string,
    PrimaryAskTargetObservation[]
  >;
}

export function buildHumanEvaluationAttemptEvidenceIndexV2(
  traces: MeetingTrace[]
): HumanEvaluationAttemptEvidenceIndexV2 {
  const tracesById = new Map<string, MeetingTrace>();
  const primaryAskTargetsByIdentity = new Map<
    string,
    PrimaryAskTargetObservation[]
  >();
  for (const trace of traces) {
    tracesById.set(trace.id, trace);
    const metadata = trace.metadata ?? {};
    const identity = readLogicalQuestionIdentity(metadata);
    if (!identity) continue;
    const key = primaryAskJoinIdentityKey(identity);
    const targets = primaryAskTargetsByIdentity.get(key) ?? [];
    targets.push(projectObservedPrimaryAskTargetV2(metadata));
    primaryAskTargetsByIdentity.set(key, targets);
  }
  return { tracesById, primaryAskTargetsByIdentity };
}

export function buildHumanEvaluationAttemptEvidenceV2(input: {
  trace: MeetingTrace;
  traces?: MeetingTrace[];
  traceIndex?: HumanEvaluationAttemptEvidenceIndexV2;
}) {
  const observed = {
    ...projectHumanEvaluationObservedFieldsV2(input.trace),
    ...projectAttemptPrimaryAskTargetV2(input),
  };
  const traceIds = [input.trace.id];
  if (input.trace.metadata?.settledExecutionPlanTaskMutationCommand === "replace-parent" &&
    readString(input.trace.metadata?.parentCorrectionTraceId)) {
    const correctionTrace = resolveLinkedCorrectionLifecycleTrace({
      trace: input.trace, traces: input.traces ?? [], traceIndex: input.traceIndex,
    });
    observed.parentAction = correctionTrace
      ? projectHumanEvaluationObservedFieldsV2(correctionTrace).parentAction : undefined;
    if (correctionTrace) traceIds.unshift(correctionTrace.id);
  }
  return {
    observed: rehashHumanEvaluationObservedSnapshotV2(observed),
    traceIds,
  } as const;
}

export function selectAffectedEvaluationTraces(input: {
  traces: MeetingTrace[];
  previousTraces: MeetingTrace[];
  changed: MeetingTrace[];
  removedTraceIds: string[];
  reset?: boolean;
}) {
  if (input.reset) return input.traces;
  const changedIds = new Set([...input.changed.map((trace) => trace.id), ...input.removedTraceIds]);
  const identities = new Set<string>();
  for (const trace of [...input.previousTraces.filter((trace) => changedIds.has(trace.id)), ...input.changed]) {
    const identity = readLogicalQuestionIdentity(trace.metadata ?? {});
    if (identity) identities.add(primaryAskJoinIdentityKey(identity));
  }
  return input.traces.filter((trace) => {
    if (changedIds.has(trace.id) || changedIds.has(readString(trace.metadata?.parentCorrectionTraceId) ?? "")) return true;
    const identity = readLogicalQuestionIdentity(trace.metadata ?? {});
    return Boolean(identity && identities.has(primaryAskJoinIdentityKey(identity)));
  });
}

function projectAttemptPrimaryAskTargetV2(input: {
  trace: MeetingTrace;
  traces?: MeetingTrace[];
  traceIndex?: HumanEvaluationAttemptEvidenceIndexV2;
}) {
  const direct = projectObservedPrimaryAskTargetV2(
    input.trace.metadata ?? {}
  );
  const identity = readLogicalQuestionIdentity(input.trace.metadata ?? {});
  if (!identity) return direct;

  const traceIndex =
    input.traceIndex ??
    buildHumanEvaluationAttemptEvidenceIndexV2(input.traces ?? [input.trace]);
  const candidates =
    traceIndex.primaryAskTargetsByIdentity.get(
      primaryAskJoinIdentityKey(identity)
    ) ?? [direct];
  const runtimeTargets = candidates.filter(
    (candidate) =>
      candidate.primaryAsk &&
      (candidate.primaryAskTargetSource === "runtime-target" ||
        candidate.primaryAskTargetSource === "no-output-target")
  );
  const uniqueRuntimeTargets = Array.from(
    new Map(
      runtimeTargets.map((candidate) => [
        `${candidate.primaryAskTargetSource}:${candidate.primaryAsk}`,
        candidate,
      ])
    ).values()
  );
  if (uniqueRuntimeTargets.length === 1) return uniqueRuntimeTargets[0]!;
  if (uniqueRuntimeTargets.length > 1) {
    return { primaryAskTargetSource: "error" as const };
  }

  if (
    direct.primaryAsk &&
    direct.primaryAskTargetSource === "local-fallback"
  ) {
    return direct;
  }
  const localTargets = Array.from(
    new Set(
      candidates
        .filter(
          (candidate) =>
            candidate.primaryAskTargetSource === "local-fallback"
        )
        .map((candidate) => candidate.primaryAsk)
        .filter((value): value is string => Boolean(value))
    )
  );
  if (localTargets.length === 1) {
    return {
      primaryAsk: localTargets[0],
      primaryAskTargetSource: "local-fallback" as const,
    };
  }
  if (localTargets.length > 1) {
    return { primaryAskTargetSource: "error" as const };
  }
  return candidates.some(
    (candidate) => candidate.primaryAskTargetSource === "error"
  )
    ? { primaryAskTargetSource: "error" as const }
    : direct;
}

function readLogicalQuestionIdentity(metadata: Record<string, unknown>) {
  const sessionId = readString(
    metadata.effectiveCurrentQuestionSettlementSessionId ??
      metadata.currentQuestionSettlementSessionId ??
      metadata.meetingSessionId
  );
  const logicalQuestionUnitId = readString(
    metadata.effectiveCurrentQuestionSettlementUnitId ??
      metadata.currentQuestionSettlementUnitId ??
      metadata.logicalQuestionUnitId
  );
  const revision = readNumber(
    metadata.effectiveCurrentQuestionSettlementRevision ??
      metadata.currentQuestionSettlementRevision ??
      metadata.logicalQuestionUnitRevision
  );
  const runtimeEpoch = readNumber(
    metadata.effectiveCurrentQuestionSettlementRuntimeEpoch ??
      metadata.currentQuestionSettlementRuntimeEpoch ??
      metadata.runtimeEpoch
  );
  const sourceHash = readString(
    metadata.effectiveCurrentQuestionSettlementSourceHash ??
      metadata.currentQuestionSettlementSourceHash
  );
  return sessionId &&
    runtimeEpoch !== undefined &&
    logicalQuestionUnitId &&
    revision !== undefined &&
    sourceHash
    ? { sessionId, runtimeEpoch, logicalQuestionUnitId, revision, sourceHash }
    : undefined;
}

function primaryAskJoinIdentityKey(identity: PrimaryAskJoinIdentity) {
  return [
    identity.sessionId,
    identity.runtimeEpoch,
    identity.logicalQuestionUnitId,
    identity.revision,
    identity.sourceHash,
  ].join("\u001f");
}

export function materializeHumanEvaluationAttemptProjectionV2(input: {
  trace: MeetingTrace;
  traces?: MeetingTrace[];
  traceIndex?: HumanEvaluationAttemptEvidenceIndexV2;
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
    traceIndex: input.traceIndex,
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
  traceIndex?: HumanEvaluationAttemptEvidenceIndexV2;
}) {
  const metadata = input.trace.metadata ?? {};
  const correctionTraceId = readString(metadata.parentCorrectionTraceId);
  const correctionId = readString(metadata.manualQuestionTypeCorrectionId);
  if (!correctionTraceId || !correctionId) return undefined;

  const correctionTrace =
    input.traceIndex?.tracesById.get(correctionTraceId) ??
    input.traces.find((candidate) => candidate.id === correctionTraceId);
  const correctionMetadata = correctionTrace?.metadata ?? {};
  if (
    !correctionTrace ||
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
