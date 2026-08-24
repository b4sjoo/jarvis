import type { RuntimeInferenceOperationKind } from "./runtime-inference.js";

export type RuntimeInferenceValidationKind =
  | "same-source"
  | "cross-source"
  | "same-artifact";

export interface RuntimeInferenceValidationDefinition {
  operationKind: RuntimeInferenceOperationKind;
  validationKind: RuntimeInferenceValidationKind;
  businessOwner: string;
  supportsAuthorityRevision: boolean;
}

export interface RuntimeInferenceSnapshotIdentity {
  operationKind: RuntimeInferenceOperationKind;
  sessionId: string;
  runtimeEpoch: number;
  contextSnapshotId: string;
  contextSnapshotHash: string;
  operationRevision: number;
}

export interface RuntimeInferenceSourceIdentity {
  logicalQuestionUnitId: string;
  logicalQuestionRevision: number;
  sourceHash: string;
  correctionRevision?: number;
}

export interface SameSourceInferenceLease
  extends RuntimeInferenceSnapshotIdentity {
  source?: RuntimeInferenceSourceIdentity;
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

export interface SameArtifactRepairLease {
  operationKind: RuntimeInferenceOperationKind;
  sessionId: string;
  runtimeEpoch: number;
  ownerId: string;
  artifactId: string;
  candidateRevision: number;
  candidateFingerprint: string;
}

export type RuntimeInferenceValidationFacet =
  | "operation-kind"
  | "session"
  | "runtime-epoch"
  | "context-snapshot-id"
  | "context-snapshot-hash"
  | "operation-revision"
  | "logical-question-unit"
  | "logical-question-revision"
  | "source-hash"
  | "correction-revision"
  | "transition-from-question"
  | "transition-from-revision"
  | "transition-from-source-hash"
  | "transition-to-evidence"
  | "transition-to-evidence-hash"
  | "transition-source-settlement"
  | "artifact-owner"
  | "artifact-id"
  | "artifact-revision"
  | "artifact-fingerprint";

export interface RuntimeInferenceValidationResult {
  authorized: boolean;
  reason: "authorized" | "identity-mismatch";
  mismatchedFacets: RuntimeInferenceValidationFacet[];
}

const DEFINITIONS = {
  "taxonomy-adjudication": definition(
    "taxonomy-adjudication",
    "same-source",
    "Tasks 131/137"
  ),
  "question-type-adjudication": definition(
    "question-type-adjudication",
    "same-source",
    "Tasks 122/131/175",
    true
  ),
  "response-opportunity-inference": definition(
    "response-opportunity-inference",
    "same-source",
    "Task 137"
  ),
  "meeting-metadata-inference": definition(
    "meeting-metadata-inference",
    "same-source",
    "Task 147"
  ),
  "whiteboard-syntax-repair": definition(
    "whiteboard-syntax-repair",
    "same-artifact",
    "Task 149"
  ),
  "task-relation-adjudication": definition(
    "task-relation-adjudication",
    "same-source",
    "Task 175",
    true
  ),
  "task-relation-child-affinity": definition(
    "task-relation-child-affinity",
    "same-source",
    "Task 175"
  ),
  "task-relation-parent-affinity": definition(
    "task-relation-parent-affinity",
    "same-source",
    "Task 175"
  ),
  "task-relation-canonical-shadow": definition(
    "task-relation-canonical-shadow",
    "same-source",
    "Task 175"
  ),
  "answer-resolution": definition(
    "answer-resolution",
    "same-source",
    "Task 61"
  ),
  "evidence-requirement": definition(
    "evidence-requirement",
    "same-source",
    "Task 61"
  ),
  "source-linkage-adjudication": definition(
    "source-linkage-adjudication",
    "cross-source",
    "Task 61"
  ),
} satisfies Record<
  RuntimeInferenceOperationKind,
  RuntimeInferenceValidationDefinition
>;

export const RUNTIME_INFERENCE_VALIDATION_DEFINITIONS =
  Object.freeze(DEFINITIONS);

export function getRuntimeInferenceValidationDefinition(
  operationKind: RuntimeInferenceOperationKind
) {
  return RUNTIME_INFERENCE_VALIDATION_DEFINITIONS[operationKind];
}

export function validateSameSourceInferenceLease(input: {
  lease: SameSourceInferenceLease;
  current: SameSourceInferenceLease;
}): RuntimeInferenceValidationResult {
  const mismatches: RuntimeInferenceValidationFacet[] = [];
  compareSnapshotIdentity(input.lease, input.current, mismatches);
  const expectedSource = input.lease.source;
  const currentSource = input.current.source;
  if (Boolean(expectedSource) !== Boolean(currentSource)) {
    mismatches.push("logical-question-unit");
  } else if (expectedSource && currentSource) {
    compareSourceIdentity(expectedSource, currentSource, mismatches);
  }
  return result(mismatches);
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

export function validateSameArtifactRepairLease(input: {
  lease: SameArtifactRepairLease;
  current: SameArtifactRepairLease;
}): RuntimeInferenceValidationResult {
  const mismatches: RuntimeInferenceValidationFacet[] = [];
  compare(input.lease.operationKind, input.current.operationKind, "operation-kind", mismatches);
  compare(input.lease.sessionId, input.current.sessionId, "session", mismatches);
  compare(input.lease.runtimeEpoch, input.current.runtimeEpoch, "runtime-epoch", mismatches);
  compare(input.lease.ownerId, input.current.ownerId, "artifact-owner", mismatches);
  compare(input.lease.artifactId, input.current.artifactId, "artifact-id", mismatches);
  compare(
    input.lease.candidateRevision,
    input.current.candidateRevision,
    "artifact-revision",
    mismatches
  );
  compare(
    input.lease.candidateFingerprint,
    input.current.candidateFingerprint,
    "artifact-fingerprint",
    mismatches
  );
  return result(mismatches);
}

export function formatRuntimeInferenceValidationForTrace(input: {
  definition: RuntimeInferenceValidationDefinition;
  result?: RuntimeInferenceValidationResult;
}) {
  return {
    runtimeInferenceValidationKind: input.definition.validationKind,
    runtimeInferenceValidationBusinessOwner: input.definition.businessOwner,
    runtimeInferenceValidationSupportsAuthorityRevision:
      input.definition.supportsAuthorityRevision,
    runtimeInferenceValidationAuthorized: input.result?.authorized,
    runtimeInferenceValidationReason: input.result?.reason,
    runtimeInferenceValidationMismatchedFacets:
      input.result?.mismatchedFacets ?? [],
  };
}

function definition(
  operationKind: RuntimeInferenceOperationKind,
  validationKind: RuntimeInferenceValidationKind,
  businessOwner: string,
  supportsAuthorityRevision = false
): RuntimeInferenceValidationDefinition {
  return {
    operationKind,
    validationKind,
    businessOwner,
    supportsAuthorityRevision,
  };
}

function compareSnapshotIdentity(
  expected: RuntimeInferenceSnapshotIdentity,
  current: RuntimeInferenceSnapshotIdentity,
  mismatches: RuntimeInferenceValidationFacet[]
) {
  compare(expected.operationKind, current.operationKind, "operation-kind", mismatches);
  compare(expected.sessionId, current.sessionId, "session", mismatches);
  compare(expected.runtimeEpoch, current.runtimeEpoch, "runtime-epoch", mismatches);
  compare(
    expected.contextSnapshotId,
    current.contextSnapshotId,
    "context-snapshot-id",
    mismatches
  );
  compare(
    expected.contextSnapshotHash,
    current.contextSnapshotHash,
    "context-snapshot-hash",
    mismatches
  );
  compare(
    expected.operationRevision,
    current.operationRevision,
    "operation-revision",
    mismatches
  );
}

function compareSourceIdentity(
  expected: RuntimeInferenceSourceIdentity,
  current: RuntimeInferenceSourceIdentity,
  mismatches: RuntimeInferenceValidationFacet[]
) {
  compare(
    expected.logicalQuestionUnitId,
    current.logicalQuestionUnitId,
    "logical-question-unit",
    mismatches
  );
  compare(
    expected.logicalQuestionRevision,
    current.logicalQuestionRevision,
    "logical-question-revision",
    mismatches
  );
  compare(expected.sourceHash, current.sourceHash, "source-hash", mismatches);
  compare(
    expected.correctionRevision,
    current.correctionRevision,
    "correction-revision",
    mismatches
  );
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
