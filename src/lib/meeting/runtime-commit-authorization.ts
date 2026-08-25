import type { ActiveMeetingTask } from "./active-meeting-task.js";
import type { MeetingContextState } from "./types.js";

export type RuntimeCommitPipeline =
  | "advisor"
  | "screen"
  | "memory"
  | "correction";

export type RuntimeParentExpectation =
  | {
      kind: "exact";
      parentId: string;
      parentRevision: number;
    }
  | { kind: "absent" }
  | { kind: "session-only" };

export interface RuntimeCommitSnapshot {
  runtimeEpoch: number;
  sessionId: string;
  parentId?: string;
  parentRevision?: number;
}

export interface RuntimeCommitToken {
  operationId: string;
  pipeline: RuntimeCommitPipeline;
  runtimeEpoch: number;
  expectedSessionId: string;
  parentExpectation: RuntimeParentExpectation;
}

export type RuntimeCommitAuthorizationReason =
  | "authorized"
  | "runtime-epoch-mismatch"
  | "session-mismatch"
  | "parent-presence-mismatch"
  | "parent-id-mismatch"
  | "parent-revision-mismatch"
  | "pipeline-owner-mismatch";

export interface RuntimeCommitAuthorizationDecision {
  authorized: boolean;
  reason: RuntimeCommitAuthorizationReason;
  token: RuntimeCommitToken;
  current: RuntimeCommitSnapshot;
}

export function buildRuntimeCommitSnapshot(input: {
  runtimeEpoch: number;
  contextState: Pick<MeetingContextState, "sessionId" | "activeMeetingTask">;
}): RuntimeCommitSnapshot {
  return buildRuntimeCommitSnapshotFromTask({
    runtimeEpoch: input.runtimeEpoch,
    sessionId: input.contextState.sessionId,
    activeMeetingTask: input.contextState.activeMeetingTask,
  });
}

export function buildRuntimeCommitSnapshotFromTask(input: {
  runtimeEpoch: number;
  sessionId: string;
  activeMeetingTask?: ActiveMeetingTask;
}): RuntimeCommitSnapshot {
  return {
    runtimeEpoch: input.runtimeEpoch,
    sessionId: input.sessionId,
    parentId: input.activeMeetingTask?.parent.id,
    parentRevision: input.activeMeetingTask
      ? input.activeMeetingTask.parent.revisions ?? 0
      : undefined,
  };
}

export function createRuntimeCommitToken(input: {
  operationId: string;
  pipeline: RuntimeCommitPipeline;
  snapshot: RuntimeCommitSnapshot;
  parentPolicy?: "task-bound" | "session-only";
}): RuntimeCommitToken {
  return {
    operationId: input.operationId,
    pipeline: input.pipeline,
    runtimeEpoch: input.snapshot.runtimeEpoch,
    expectedSessionId: input.snapshot.sessionId,
    parentExpectation:
      input.parentPolicy === "session-only"
        ? { kind: "session-only" }
        : input.snapshot.parentId
          ? {
              kind: "exact",
              parentId: input.snapshot.parentId,
              parentRevision: input.snapshot.parentRevision ?? 0,
            }
          : { kind: "absent" },
  };
}

export function rebaseRuntimeCommitToken(input: {
  token: RuntimeCommitToken;
  snapshot: RuntimeCommitSnapshot;
  parentPolicy?: "task-bound" | "session-only";
}): RuntimeCommitToken {
  return createRuntimeCommitToken({
    operationId: input.token.operationId,
    pipeline: input.token.pipeline,
    snapshot: input.snapshot,
    parentPolicy: input.parentPolicy,
  });
}

export function rebaseRuntimeCommitTokenAfterOwnedParentMutation(input: {
  token: RuntimeCommitToken;
  snapshot: RuntimeCommitSnapshot;
  expectedRevisionDelta: number;
}): RuntimeCommitToken | undefined {
  const expectation = input.token.parentExpectation;
  if (expectation.kind !== "exact") return undefined;
  if (input.snapshot.parentId !== expectation.parentId) return undefined;
  if (
    (input.snapshot.parentRevision ?? 0) !==
    expectation.parentRevision + input.expectedRevisionDelta
  ) {
    return undefined;
  }

  return rebaseRuntimeCommitToken({
    token: input.token,
    snapshot: input.snapshot,
  });
}

export function rebaseRuntimeCommitTokenAfterOwnedParentReplacement(input: {
  token: RuntimeCommitToken;
  snapshot: RuntimeCommitSnapshot;
  previousParentId: string | undefined;
  nextParentId: string | undefined;
}) {
  if (
    input.token.pipeline !== "correction" ||
    !input.previousParentId ||
    !input.nextParentId ||
    input.previousParentId === input.nextParentId ||
    input.snapshot.parentId !== input.nextParentId
  ) {
    return undefined;
  }
  const expectation = input.token.parentExpectation;
  if (
    expectation.kind !== "exact" ||
    expectation.parentId !== input.previousParentId
  ) {
    return undefined;
  }
  return rebaseRuntimeCommitToken({
    token: input.token,
    snapshot: input.snapshot,
  });
}

export function authorizeRuntimeCommit(input: {
  token: RuntimeCommitToken;
  current: RuntimeCommitSnapshot;
  currentOperationId: string | null | undefined;
}): RuntimeCommitAuthorizationDecision {
  const reject = (
    reason: Exclude<RuntimeCommitAuthorizationReason, "authorized">
  ): RuntimeCommitAuthorizationDecision => ({
    authorized: false,
    reason,
    token: input.token,
    current: input.current,
  });

  if (input.current.runtimeEpoch !== input.token.runtimeEpoch) {
    return reject("runtime-epoch-mismatch");
  }

  if (input.current.sessionId !== input.token.expectedSessionId) {
    return reject("session-mismatch");
  }

  if (input.token.parentExpectation.kind === "absent") {
    if (input.current.parentId) {
      return reject("parent-presence-mismatch");
    }
  } else if (input.token.parentExpectation.kind === "exact") {
    if (!input.current.parentId) {
      return reject("parent-presence-mismatch");
    }
    if (input.current.parentId !== input.token.parentExpectation.parentId) {
      return reject("parent-id-mismatch");
    }
    if (
      (input.current.parentRevision ?? 0) !==
      input.token.parentExpectation.parentRevision
    ) {
      return reject("parent-revision-mismatch");
    }
  }

  if (input.currentOperationId !== input.token.operationId) {
    return reject("pipeline-owner-mismatch");
  }

  return {
    authorized: true,
    reason: "authorized",
    token: input.token,
    current: input.current,
  };
}

export function formatRuntimeCommitAuthorizationForTrace(
  decision: RuntimeCommitAuthorizationDecision,
  stage: string
): Record<string, unknown> {
  const expectation = decision.token.parentExpectation;
  return {
    runtimeOperationId: decision.token.operationId,
    runtimePipeline: decision.token.pipeline,
    runtimeAuthorizationStage: stage,
    runtimeExpectedEpoch: decision.token.runtimeEpoch,
    runtimeCurrentEpoch: decision.current.runtimeEpoch,
    runtimeExpectedSessionId: decision.token.expectedSessionId,
    runtimeCurrentSessionId: decision.current.sessionId,
    runtimeParentExpectation: expectation.kind,
    runtimeExpectedParentId:
      expectation.kind === "exact" ? expectation.parentId : undefined,
    runtimeExpectedParentRevision:
      expectation.kind === "exact" ? expectation.parentRevision : undefined,
    runtimeCurrentParentId: decision.current.parentId,
    runtimeCurrentParentRevision: decision.current.parentRevision,
    runtimeCommitAuthorized: decision.authorized,
    runtimeCommitAuthorizationReason: decision.reason,
  };
}
