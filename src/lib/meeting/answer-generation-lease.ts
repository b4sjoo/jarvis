import type {
  AdvisorJobSource,
} from "./advisor-trigger-job.js";
import type {
  AdvisorTurnIntentDecision,
} from "./advisor-turn-intent.js";
import { createMeetingId } from "./context-manager.js";
import type {
  CurrentQuestionSettlementDecision,
} from "./current-question-settlement.js";

export type AnswerArtifactSection =
  | "answer"
  | "code"
  | "complexity"
  | "whiteboard";

export type AnswerArtifactFamily = "answer" | "code" | "whiteboard";

export type RefreshAuthorityKind =
  | "automatic-substantive"
  | "shadow-fail-open"
  | "runtime-intent-answer"
  | "runtime-type-adjudication-output-only"
  | "manual-hard-override"
  | "screen-hard-override"
  | "denied";

export interface RefreshAuthorityDecision {
  authorized: boolean;
  kind: RefreshAuthorityKind;
  reason:
    | "substantive-turn"
    | "shadow-fail-open"
    | "manual-correction"
    | "explicit-response-action"
    | "force-advise"
    | "screen-capture"
    | "runtime-intent-answer"
    | "runtime-type-adjudication-output-only"
    | "response-opportunity-pending"
    | "response-opportunity-output-authorized"
    | "response-opportunity-preserve-stable-answer"
    | "missing-turn-intent"
    | "turn-intent-not-authorized"
    | "turn-intent-not-answer-refresh"
    | "shadow-fail-open-disallowed";
  hardOverride: boolean;
  maySupersedeGeneration: boolean;
  authorityId?: string;
}

export interface RuntimeTypeAdjudicationOutputAuthority {
  id: string;
  operationId: string;
  settlementId: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionRevision: number;
  manualCorrectionRevision: number;
  typeAuthority: "runtime-adjudication";
  authorityScope: "type-only" | "type-and-relation";
  authorizedArtifacts: ["answer"];
  createdAt: number;
}

export interface RuntimeTypeAdjudicationOutputAuthoritySnapshot {
  settlementId?: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId?: string;
  logicalQuestionRevision?: number;
  manualCorrectionRevision: number;
}

export type RuntimeTypeAdjudicationOutputAuthorityReason =
  | "authorized"
  | "settlement-mismatch"
  | "session-mismatch"
  | "runtime-epoch-mismatch"
  | "logical-question-mismatch"
  | "logical-question-revision-mismatch"
  | "manual-correction-revision-mismatch";

export interface RuntimeTypeAdjudicationOutputAuthorization {
  authorized: boolean;
  reason: RuntimeTypeAdjudicationOutputAuthorityReason;
}

export interface AnswerGenerationLease {
  id: string;
  sessionId: string;
  runtimeEpoch: number;
  preparationContextRevision: number;
  taskId: string | null;
  taskRevision: number | null;
  logicalQuestionUnitId: string | null;
  logicalQuestionRevision: number | null;
  baseVisibleAnswerRevision: number;
  sourceTurnIds: string[];
  manualCorrectionRevision: number;
  responseActionRevision: number;
  modelRoute: string;
  artifactOwnerId: string | null;
  requestedArtifacts: AnswerArtifactSection[];
  startedAt: number;
}

export interface AnswerGenerationLeaseSnapshot {
  sessionId: string;
  runtimeEpoch: number;
  preparationContextRevision: number;
  taskId: string | null;
  taskRevision: number | null;
  logicalQuestionUnitId: string | null;
  logicalQuestionRevision: number | null;
  visibleAnswerRevision: number;
  manualCorrectionRevision: number;
  responseActionRevision: number;
  artifactOwnerId: string | null;
  authorizedArtifacts: AnswerArtifactSection[];
  candidateMutatedArtifacts?: AnswerArtifactSection[];
}

export type AnswerGenerationLeaseAuthorizationReason =
  | "authorized"
  | "session-mismatch"
  | "runtime-epoch-mismatch"
  | "preparation-context-revision-mismatch"
  | "task-owner-mismatch"
  | "task-revision-mismatch"
  | "logical-question-mismatch"
  | "logical-question-revision-mismatch"
  | "visible-answer-revision-mismatch"
  | "manual-correction-revision-mismatch"
  | "response-action-revision-mismatch"
  | "artifact-owner-mismatch"
  | "artifact-authority-revoked";

export interface AnswerGenerationLeaseAuthorization {
  authorized: boolean;
  reason: AnswerGenerationLeaseAuthorizationReason;
  rejectedArtifacts: AnswerArtifactSection[];
  authorizationBasis: "requested-artifacts" | "candidate-mutations";
  checkedArtifacts: AnswerArtifactSection[];
}

export function decideRefreshAuthority(input: {
  source: AdvisorJobSource | "screen";
  turnIntentDecision?: AdvisorTurnIntentDecision;
  runtimeTypeAdjudicationOutputAuthority?: RuntimeTypeAdjudicationOutputAuthority;
}): RefreshAuthorityDecision {
  if (input.runtimeTypeAdjudicationOutputAuthority) {
    return {
      authorized: true,
      kind: "runtime-type-adjudication-output-only",
      reason: "runtime-type-adjudication-output-only",
      hardOverride: false,
      maySupersedeGeneration: true,
      authorityId: input.runtimeTypeAdjudicationOutputAuthority.id,
    };
  }
  if (input.source === "screen") {
    return {
      authorized: true,
      kind: "screen-hard-override",
      reason: "screen-capture",
      hardOverride: true,
      maySupersedeGeneration: true,
    };
  }

  if (input.source === "manual-correction") {
    return {
      authorized: true,
      kind: "manual-hard-override",
      reason: "manual-correction",
      hardOverride: true,
      maySupersedeGeneration: true,
    };
  }

  if (input.source === "force-advise") {
    return {
      authorized: true,
      kind: "manual-hard-override",
      reason: "force-advise",
      hardOverride: true,
      maySupersedeGeneration: true,
    };
  }

  if (
    input.source === "regenerate" ||
    input.source === "response-action" ||
    input.source === "clarifying-answer"
  ) {
    return {
      authorized: true,
      kind: "manual-hard-override",
      reason: "explicit-response-action",
      hardOverride: true,
      maySupersedeGeneration: true,
    };
  }

  const decision = input.turnIntentDecision;
  if (!decision) {
    return {
      authorized: false,
      kind: "denied",
      reason: "missing-turn-intent",
      hardOverride: false,
      maySupersedeGeneration: false,
    };
  }
  if (
    !decision.executionAuthorized
  ) {
    return {
      authorized: false,
      kind: "denied",
      reason: "turn-intent-not-authorized",
      hardOverride: false,
      maySupersedeGeneration: false,
    };
  }
  if (decision.action !== "answer-refresh") {
    return {
      authorized: false,
      kind: "denied",
      reason: "turn-intent-not-answer-refresh",
      hardOverride: false,
      maySupersedeGeneration: false,
    };
  }
  if (decision.authoritySource === "runtime-intent-gate") {
    return {
      authorized: true,
      kind: "runtime-intent-answer",
      reason: "runtime-intent-answer",
      hardOverride: false,
      maySupersedeGeneration: true,
    };
  }
  if (decision.enforcement === "shadow") {
    return {
      authorized: false,
      kind: "denied",
      reason: "shadow-fail-open-disallowed",
      hardOverride: false,
      maySupersedeGeneration: false,
    };
  }

  return {
    authorized: true,
    kind: "automatic-substantive",
    reason: "substantive-turn",
    hardOverride: false,
    maySupersedeGeneration: true,
  };
}

export function createRuntimeTypeAdjudicationOutputAuthority(input: {
  operationId: string;
  settlement: CurrentQuestionSettlementDecision;
  manualCorrectionRevision: number;
  createdAt?: number;
}): RuntimeTypeAdjudicationOutputAuthority | undefined {
  const typeOnly =
    !input.settlement.relationMutationAuthorized &&
    !input.settlement.parentMutationAuthorized;
  const typeAndRelation =
    input.settlement.relationAuthoritySource === "runtime-adjudication" &&
    input.settlement.relationMutationAuthorized &&
    ((input.settlement.relation === "new-parent" &&
      input.settlement.parentMutationAuthorized) ||
      ((input.settlement.relation === "followup-parent" ||
        input.settlement.relation === "child-probe" ||
        input.settlement.relation === "resume-parent") &&
        !input.settlement.parentMutationAuthorized));
  if (
    input.settlement.typeAuthoritySource !== "runtime-adjudication" ||
    !input.settlement.typeMutationAuthorized ||
    (!typeOnly && !typeAndRelation) ||
    !input.settlement.responseAuthorized ||
    input.settlement.action !== "answer"
  ) {
    return undefined;
  }

  return {
    id: createMeetingId("runtime_type_repair_output_authority"),
    operationId: input.operationId,
    settlementId: input.settlement.settlementId,
    sessionId: input.settlement.sessionId,
    runtimeEpoch: input.settlement.runtimeEpoch,
    logicalQuestionUnitId:
      input.settlement.logicalQuestionUnitId,
    logicalQuestionRevision: input.settlement.revision,
    manualCorrectionRevision: input.manualCorrectionRevision,
    typeAuthority: "runtime-adjudication",
    authorityScope: typeAndRelation
      ? "type-and-relation"
      : "type-only",
    authorizedArtifacts: ["answer"],
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function authorizeRuntimeTypeAdjudicationOutputAuthority(
  authority: RuntimeTypeAdjudicationOutputAuthority,
  current: RuntimeTypeAdjudicationOutputAuthoritySnapshot
): RuntimeTypeAdjudicationOutputAuthorization {
  if (authority.settlementId !== current.settlementId) {
    return { authorized: false, reason: "settlement-mismatch" };
  }
  if (authority.sessionId !== current.sessionId) {
    return { authorized: false, reason: "session-mismatch" };
  }
  if (authority.runtimeEpoch !== current.runtimeEpoch) {
    return { authorized: false, reason: "runtime-epoch-mismatch" };
  }
  if (
    authority.logicalQuestionUnitId !==
    current.logicalQuestionUnitId
  ) {
    return { authorized: false, reason: "logical-question-mismatch" };
  }
  if (
    authority.logicalQuestionRevision !==
    current.logicalQuestionRevision
  ) {
    return {
      authorized: false,
      reason: "logical-question-revision-mismatch",
    };
  }
  if (
    authority.manualCorrectionRevision !==
    current.manualCorrectionRevision
  ) {
    return {
      authorized: false,
      reason: "manual-correction-revision-mismatch",
    };
  }
  return { authorized: true, reason: "authorized" };
}

export function runtimeTypeAdjudicationLimitsGenerationToAnswer(input: {
  authority?: RuntimeTypeAdjudicationOutputAuthority;
  taskBoundaryCommitted: boolean;
}) {
  return Boolean(
    input.authority?.authorityScope === "type-only" &&
      !input.taskBoundaryCommitted
  );
}

export function formatRuntimeTypeAdjudicationOutputAuthorityForTrace(
  authority: RuntimeTypeAdjudicationOutputAuthority | undefined,
  authorization?: RuntimeTypeAdjudicationOutputAuthorization
) {
  return {
    runtimeTypeAdjudicationOutputAuthorityId: authority?.id,
    runtimeTypeAdjudicationOperationId: authority?.operationId,
    runtimeTypeAdjudicationSettlementId: authority?.settlementId,
    runtimeTypeAdjudicationSessionId: authority?.sessionId,
    runtimeTypeAdjudicationRuntimeEpoch: authority?.runtimeEpoch,
    runtimeTypeAdjudicationLogicalQuestionUnitId:
      authority?.logicalQuestionUnitId,
    runtimeTypeAdjudicationLogicalQuestionRevision:
      authority?.logicalQuestionRevision,
    runtimeTypeAdjudicationManualCorrectionRevision:
      authority?.manualCorrectionRevision,
    runtimeTypeAdjudicationTypeAuthority: authority?.typeAuthority,
    runtimeTypeAdjudicationAuthorityScope: authority?.authorityScope,
    runtimeTypeAdjudicationAuthorizedArtifacts:
      authority?.authorizedArtifacts,
    runtimeTypeAdjudicationOutputAuthorized:
      authorization?.authorized,
    runtimeTypeAdjudicationOutputAuthorizationReason:
      authorization?.reason,
  };
}

export function createAnswerGenerationLease(
  input: Omit<AnswerGenerationLease, "id" | "startedAt"> & {
    startedAt?: number;
  }
): AnswerGenerationLease {
  return {
    ...input,
    id: createMeetingId("answer_generation_lease"),
    sourceTurnIds: [...input.sourceTurnIds],
    requestedArtifacts: [...new Set(input.requestedArtifacts)],
    startedAt: input.startedAt ?? Date.now(),
  };
}

export function rebaseAnswerGenerationLeaseAfterOwnedParentMutation(input: {
  lease: AnswerGenerationLease;
  taskId: string;
  taskRevision: number | undefined;
  expectedRevisionDelta?: number;
}): AnswerGenerationLease | undefined {
  if (
    input.lease.taskId !== input.taskId ||
    input.lease.artifactOwnerId !== input.taskId ||
    input.lease.taskRevision === null ||
    input.taskRevision === undefined ||
    input.taskRevision !==
      input.lease.taskRevision + (input.expectedRevisionDelta ?? 1)
  ) {
    return undefined;
  }
  return {
    ...input.lease,
    taskRevision: input.taskRevision,
  };
}

export function authorizeAnswerGenerationLease(
  lease: AnswerGenerationLease,
  current: AnswerGenerationLeaseSnapshot
): AnswerGenerationLeaseAuthorization {
  if (lease.sessionId !== current.sessionId) {
    return rejected("session-mismatch");
  }
  if (lease.runtimeEpoch !== current.runtimeEpoch) {
    return rejected("runtime-epoch-mismatch");
  }
  if (
    lease.preparationContextRevision !==
    current.preparationContextRevision
  ) {
    return rejected("preparation-context-revision-mismatch");
  }
  if (lease.taskId !== current.taskId) {
    return rejected("task-owner-mismatch");
  }
  if (lease.taskRevision !== current.taskRevision) {
    return rejected("task-revision-mismatch");
  }
  if (
    lease.logicalQuestionUnitId !== null &&
    lease.logicalQuestionUnitId !== current.logicalQuestionUnitId
  ) {
    return rejected("logical-question-mismatch");
  }
  if (
    lease.logicalQuestionRevision !== null &&
    lease.logicalQuestionRevision !== current.logicalQuestionRevision
  ) {
    return rejected("logical-question-revision-mismatch");
  }
  if (
    lease.baseVisibleAnswerRevision !== current.visibleAnswerRevision
  ) {
    return rejected("visible-answer-revision-mismatch");
  }
  if (
    lease.manualCorrectionRevision !== current.manualCorrectionRevision
  ) {
    return rejected("manual-correction-revision-mismatch");
  }
  if (
    lease.responseActionRevision !== current.responseActionRevision
  ) {
    return rejected("response-action-revision-mismatch");
  }
  if (lease.artifactOwnerId !== current.artifactOwnerId) {
    return rejected("artifact-owner-mismatch");
  }

  const authorizationBasis = current.candidateMutatedArtifacts
    ? "candidate-mutations"
    : "requested-artifacts";
  const authorizedFamilies = new Set(
    current.authorizedArtifacts.map(toAnswerArtifactFamily)
  );
  const artifactsToAuthorize =
    current.candidateMutatedArtifacts ?? lease.requestedArtifacts;
  const rejectedArtifacts = artifactsToAuthorize.filter(
    (artifact) =>
      !authorizedFamilies.has(toAnswerArtifactFamily(artifact))
  );
  if (rejectedArtifacts.length > 0) {
    return {
      authorized: false,
      reason: "artifact-authority-revoked",
      rejectedArtifacts,
      authorizationBasis,
      checkedArtifacts: [...artifactsToAuthorize],
    };
  }

  return {
    authorized: true,
    reason: "authorized",
    rejectedArtifacts: [],
    authorizationBasis,
    checkedArtifacts: [...artifactsToAuthorize],
  };
}

export function toAnswerArtifactFamily(
  artifact: AnswerArtifactSection
): AnswerArtifactFamily {
  return artifact === "complexity" ? "code" : artifact;
}

export function formatRefreshAuthorityForTrace(
  decision: RefreshAuthorityDecision
) {
  return {
    refreshAuthority: decision.kind,
    refreshAuthorityAuthorized: decision.authorized,
    refreshAuthorityReason: decision.reason,
    refreshAuthorityHardOverride: decision.hardOverride,
    ...(decision.authorityId
      ? { refreshAuthorityId: decision.authorityId }
      : {}),
    refreshAuthorityMaySupersedeGeneration:
      decision.maySupersedeGeneration,
  };
}

export function formatAnswerGenerationLeaseForTrace(
  lease: AnswerGenerationLease,
  authorization?: AnswerGenerationLeaseAuthorization,
  stage?: string
) {
  return {
    answerGenerationLeaseId: lease.id,
    answerGenerationLeaseStage: stage,
    answerGenerationLeaseSessionId: lease.sessionId,
    answerGenerationLeaseRuntimeEpoch: lease.runtimeEpoch,
    answerGenerationLeasePreparationContextRevision:
      lease.preparationContextRevision,
    answerGenerationLeaseTaskId: lease.taskId ?? undefined,
    answerGenerationLeaseTaskRevision: lease.taskRevision ?? undefined,
    answerGenerationLeaseLogicalQuestionUnitId:
      lease.logicalQuestionUnitId ?? undefined,
    answerGenerationLeaseLogicalQuestionRevision:
      lease.logicalQuestionRevision ?? undefined,
    baseVisibleAnswerRevision: lease.baseVisibleAnswerRevision,
    answerGenerationLeaseSourceTurnIds: lease.sourceTurnIds,
    answerGenerationLeaseManualCorrectionRevision:
      lease.manualCorrectionRevision,
    answerGenerationLeaseResponseActionRevision:
      lease.responseActionRevision,
    answerGenerationLeaseModelRoute: lease.modelRoute,
    answerGenerationLeaseArtifactOwnerId:
      lease.artifactOwnerId ?? undefined,
    requestedArtifacts: lease.requestedArtifacts,
    leaseAuthorizedAtStart:
      stage === "start" ? authorization?.authorized : undefined,
    leaseAuthorizedAtCommit:
      stage !== "start" ? authorization?.authorized : undefined,
    staleCommitRejected:
      authorization ? !authorization.authorized : undefined,
    staleReason:
      authorization && !authorization.authorized
        ? authorization.reason
        : undefined,
    answerGenerationLeaseRejectedArtifacts:
      authorization?.rejectedArtifacts,
    answerGenerationLeaseAuthorizationBasis:
      authorization?.authorizationBasis,
    answerGenerationLeaseCheckedArtifacts:
      authorization?.checkedArtifacts,
  };
}

function rejected(
  reason: Exclude<AnswerGenerationLeaseAuthorizationReason, "authorized">
): AnswerGenerationLeaseAuthorization {
  return {
    authorized: false,
    reason,
    rejectedArtifacts: [],
    authorizationBasis: "requested-artifacts",
    checkedArtifacts: [],
  };
}
