import type {
  AdvisorJobSource,
} from "./advisor-trigger-job.js";
import type {
  AdvisorTurnIntentDecision,
} from "./advisor-turn-intent.js";
import { createMeetingId } from "./context-manager.js";

export type AnswerArtifactSection =
  | "answer"
  | "code"
  | "complexity"
  | "whiteboard";

export type RefreshAuthorityKind =
  | "automatic-substantive"
  | "shadow-fail-open"
  | "runtime-intent-answer"
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
    | "missing-turn-intent"
    | "turn-intent-not-authorized"
    | "turn-intent-not-answer-refresh"
    | "shadow-fail-open-disallowed";
  hardOverride: boolean;
  maySupersedeGeneration: boolean;
}

export interface AnswerGenerationLease {
  id: string;
  sessionId: string;
  runtimeEpoch: number;
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
  taskId: string | null;
  taskRevision: number | null;
  logicalQuestionUnitId: string | null;
  logicalQuestionRevision: number | null;
  visibleAnswerRevision: number;
  manualCorrectionRevision: number;
  responseActionRevision: number;
  artifactOwnerId: string | null;
  authorizedArtifacts: AnswerArtifactSection[];
}

export type AnswerGenerationLeaseAuthorizationReason =
  | "authorized"
  | "session-mismatch"
  | "runtime-epoch-mismatch"
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
}

export function decideRefreshAuthority(input: {
  source: AdvisorJobSource | "screen";
  turnIntentDecision?: AdvisorTurnIntentDecision;
}): RefreshAuthorityDecision {
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

  const authorized = new Set(current.authorizedArtifacts);
  const rejectedArtifacts = lease.requestedArtifacts.filter(
    (artifact) => !authorized.has(artifact)
  );
  if (rejectedArtifacts.length > 0) {
    return {
      authorized: false,
      reason: "artifact-authority-revoked",
      rejectedArtifacts,
    };
  }

  return {
    authorized: true,
    reason: "authorized",
    rejectedArtifacts: [],
  };
}

export function formatRefreshAuthorityForTrace(
  decision: RefreshAuthorityDecision
) {
  return {
    refreshAuthority: decision.kind,
    refreshAuthorityAuthorized: decision.authorized,
    refreshAuthorityReason: decision.reason,
    refreshAuthorityHardOverride: decision.hardOverride,
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
  };
}

function rejected(
  reason: Exclude<AnswerGenerationLeaseAuthorizationReason, "authorized">
): AnswerGenerationLeaseAuthorization {
  return {
    authorized: false,
    reason,
    rejectedArtifacts: [],
  };
}
