import type { RuntimeInferenceOperationKind } from "./runtime-inference.js";

export interface RuntimeInferenceSourceIdentity {
  logicalQuestionUnitId: string;
  logicalQuestionRevision: number;
  sourceHash: string;
  correctionRevision?: number;
}

export interface CrossSourceTransitionLease {
  operationKind: RuntimeInferenceOperationKind;
  sessionId: string;
  runtimeEpoch: number;
  operationRevision: number;
  from: RuntimeInferenceSourceIdentity;
  to: {
    evidenceId: string;
    evidenceHash: string;
    correctionRevision?: number;
  };
  sourceSettlementId?: string;
}

export type RuntimeInferenceValidationFacet =
  | "operation-kind"
  | "session"
  | "runtime-epoch"
  | "operation-revision"
  | "correction-revision"
  | "transition-from-question"
  | "transition-from-revision"
  | "transition-from-source-hash"
  | "transition-to-evidence"
  | "transition-to-evidence-hash"
  | "transition-source-settlement";

export interface RuntimeInferenceValidationResult {
  authorized: boolean;
  reason: "authorized" | "identity-mismatch";
  mismatchedFacets: RuntimeInferenceValidationFacet[];
}

export function validateCrossSourceTransitionLease(input: {
  lease: CrossSourceTransitionLease;
  current: CrossSourceTransitionLease;
}): RuntimeInferenceValidationResult {
  const mismatches: RuntimeInferenceValidationFacet[] = [];
  compare(input.lease.operationKind, input.current.operationKind, "operation-kind", mismatches);
  compare(input.lease.sessionId, input.current.sessionId, "session", mismatches);
  compare(input.lease.runtimeEpoch, input.current.runtimeEpoch, "runtime-epoch", mismatches);
  compare(
    input.lease.operationRevision,
    input.current.operationRevision,
    "operation-revision",
    mismatches
  );
  compare(
    input.lease.from.logicalQuestionUnitId,
    input.current.from.logicalQuestionUnitId,
    "transition-from-question",
    mismatches
  );
  compare(
    input.lease.from.logicalQuestionRevision,
    input.current.from.logicalQuestionRevision,
    "transition-from-revision",
    mismatches
  );
  compare(
    input.lease.from.sourceHash,
    input.current.from.sourceHash,
    "transition-from-source-hash",
    mismatches
  );
  compare(
    input.lease.from.correctionRevision,
    input.current.from.correctionRevision,
    "correction-revision",
    mismatches
  );
  compare(
    input.lease.to.evidenceId,
    input.current.to.evidenceId,
    "transition-to-evidence",
    mismatches
  );
  compare(
    input.lease.to.evidenceHash,
    input.current.to.evidenceHash,
    "transition-to-evidence-hash",
    mismatches
  );
  compare(
    input.lease.to.correctionRevision,
    input.current.to.correctionRevision,
    "correction-revision",
    mismatches
  );
  compare(
    input.lease.sourceSettlementId,
    input.current.sourceSettlementId,
    "transition-source-settlement",
    mismatches
  );
  return result(mismatches);
}

function compare(
  expected: unknown,
  current: unknown,
  facet: RuntimeInferenceValidationFacet,
  mismatches: RuntimeInferenceValidationFacet[]
) {
  if (expected !== current && !mismatches.includes(facet)) {
    mismatches.push(facet);
  }
}

function result(
  mismatchedFacets: RuntimeInferenceValidationFacet[]
): RuntimeInferenceValidationResult {
  return {
    authorized: mismatchedFacets.length === 0,
    reason:
      mismatchedFacets.length === 0 ? "authorized" : "identity-mismatch",
    mismatchedFacets,
  };
}
