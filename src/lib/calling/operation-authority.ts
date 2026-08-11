export type ModelRouteKind = "runtime" | "advisor" | "complex";

export interface RuntimeOwnerSnapshot {
  callSessionId: string;
  runtimeEpoch: number;
  momentUnitId?: string;
  evidenceRevision: number;
  logicalRevision: number;
}

export interface RuntimeOperationEnvelope<TInput> extends RuntimeOwnerSnapshot {
  operationId: string;
  operationKind: string;
  route: ModelRouteKind;
  contextSnapshotHash: string;
  timeoutMs: number;
  input: TInput;
}

export interface OperationLease extends RuntimeOwnerSnapshot {
  operationId: string;
  route: ModelRouteKind;
}

export function createOperationLease(input: {
  envelope: RuntimeOperationEnvelope<unknown>;
}): OperationLease {
  const { operationId, route, callSessionId, runtimeEpoch, momentUnitId, evidenceRevision, logicalRevision } =
    input.envelope;
  return {
    operationId,
    route,
    callSessionId,
    runtimeEpoch,
    momentUnitId,
    evidenceRevision,
    logicalRevision,
  };
}

export type CommitAuthorization =
  | { authorized: true }
  | {
      authorized: false;
      reason:
        | "runtime-epoch-mismatch"
        | "session-mismatch"
        | "moment-mismatch"
        | "evidence-revision-mismatch"
        | "logical-revision-mismatch"
        | "operation-owner-mismatch"
        | "route-mismatch";
    };

export function authorizeOperationCommit(input: {
  lease: OperationLease;
  current: RuntimeOwnerSnapshot;
  activeOperationId: string | null;
  expectedRoute: ModelRouteKind;
}): CommitAuthorization {
  if (input.lease.runtimeEpoch !== input.current.runtimeEpoch) {
    return { authorized: false, reason: "runtime-epoch-mismatch" };
  }
  if (input.lease.callSessionId !== input.current.callSessionId) {
    return { authorized: false, reason: "session-mismatch" };
  }
  if (input.lease.momentUnitId !== input.current.momentUnitId) {
    return { authorized: false, reason: "moment-mismatch" };
  }
  if (input.lease.evidenceRevision !== input.current.evidenceRevision) {
    return { authorized: false, reason: "evidence-revision-mismatch" };
  }
  if (input.lease.logicalRevision !== input.current.logicalRevision) {
    return { authorized: false, reason: "logical-revision-mismatch" };
  }
  if (input.lease.operationId !== input.activeOperationId) {
    return { authorized: false, reason: "operation-owner-mismatch" };
  }
  if (input.lease.route !== input.expectedRoute) {
    return { authorized: false, reason: "route-mismatch" };
  }
  return { authorized: true };
}
