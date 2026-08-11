import { buildBoundedCallingContext } from "./bounded-context.js";
import {
  createCancellableOperation,
  OperationAbortError,
} from "./cancellable-operation.js";
import { parseGuidanceFrame, parseRuntimeSettlement } from "./model-parsers.js";
import type { ChatModelRouteConfig } from "./model-routes.js";
import { createOperationLease } from "./operation-authority.js";
import { ADVISOR_SYSTEM_PROMPT, RUNTIME_SYSTEM_PROMPT } from "./prompts.js";
import { requestChatCompletion } from "./provider-client.js";
import { sha256 } from "./immutable-snapshot.js";
import type { ActiveCallRuntime } from "./active-call-runtime.js";
import type { CallRecordingEventKind } from "./call-recording.js";
import type { CallTurnSettlement } from "./types.js";

interface CancellableHandle {
  cancel: (reason: string) => boolean;
}

interface ModelOperationDependencies {
  owner: ActiveCallRuntime;
  apiKey: string;
  isCurrentOwner: () => boolean;
  publish: () => void;
  register: (operation: CancellableHandle) => void;
  unregister: (operation: CancellableHandle) => void;
  record: (
    kind: CallRecordingEventKind,
    payload: unknown,
    occurredAt?: number
  ) => void;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const recordReceipt = (
  input: ModelOperationDependencies,
  receipt: Parameters<ActiveCallRuntime["dispatch"]>[0] & {
    type: "RecordReceipt";
  }
) => {
  input.owner.dispatch(receipt);
  input.publish();
};

const recordDispatch = (input: {
  dependencies: ModelOperationDependencies;
  operationId: string;
  routeId: "runtime" | "advisor";
  route: ChatModelRouteConfig;
  contextSnapshotHash: string;
  systemPrompt: string;
  userPrompt: string;
  occurredAt: number;
}) => {
  input.dependencies.record(
    "model-operation-dispatched",
    {
      operationId: input.operationId,
      route: input.routeId,
      endpoint: input.route.endpoint,
      model: input.route.model,
      timeoutMs: input.route.timeoutMs,
      contextSnapshotHash: input.contextSnapshotHash,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
    },
    input.occurredAt
  );
};

const recordReturn = (input: {
  dependencies: ModelOperationDependencies;
  operationId: string;
  route: "runtime" | "advisor";
  dispatchedAt: number;
  status: "success" | "failed" | "cancelled";
  occurredAt: number;
  raw?: string;
  error?: string;
  fallbackUsed?: boolean;
}) => {
  input.dependencies.record(
    "model-operation-returned",
    {
      operationId: input.operationId,
      route: input.route,
      status: input.status,
      durationMs: input.occurredAt - input.dispatchedAt,
      raw: input.raw,
      error: input.error,
      fallbackUsed: input.fallbackUsed,
    },
    input.occurredAt
  );
};

export async function runAdvisorModelOperation(
  input: ModelOperationDependencies & { route: ChatModelRouteConfig }
) {
  const snapshot = input.owner.snapshot();
  const context = buildBoundedCallingContext({
    turns: snapshot.transcript,
    maxChars: 6_000,
  });
  const operationId = `advisor_${crypto.randomUUID()}`;
  const contextJson = JSON.stringify(context);
  const userPrompt = `Bounded call context:\n${contextJson}`;
  const envelope = input.owner.selectOperation({
    operationId,
    operationKind: "guidance",
    route: "advisor",
    contextSnapshotHash: await sha256(contextJson),
    timeoutMs: input.route.timeoutMs,
    input: context,
  });
  recordReceipt(input, {
    type: "RecordReceipt",
    receipt: {
      requestId: operationId,
      status: "selected",
      occurredAt: Date.now(),
    },
  });
  const dispatchedAt = Date.now();
  recordDispatch({
    dependencies: input,
    operationId,
    routeId: "advisor",
    route: input.route,
    contextSnapshotHash: envelope.contextSnapshotHash,
    systemPrompt: ADVISOR_SYSTEM_PROMPT,
    userPrompt,
    occurredAt: dispatchedAt,
  });
  const operation = createCancellableOperation({
    operationId,
    timeoutMs: envelope.timeoutMs,
    execute: (signal) =>
      requestChatCompletion({
        route: input.route,
        apiKey: input.apiKey,
        messages: [
          { role: "system", content: ADVISOR_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        signal,
      }),
  });
  input.register(operation);
  recordReceipt(input, {
    type: "RecordReceipt",
    receipt: {
      requestId: operationId,
      status: "dispatched",
      occurredAt: dispatchedAt,
    },
  });

  try {
    const raw = await operation.promise;
    const returnedAt = Date.now();
    recordReturn({
      dependencies: input,
      operationId,
      route: "advisor",
      dispatchedAt,
      status: "success",
      occurredAt: returnedAt,
      raw,
    });
    if (!input.isCurrentOwner()) return;
    recordReceipt(input, {
      type: "RecordReceipt",
      receipt: {
        requestId: operationId,
        status: "provider-returned",
        occurredAt: returnedAt,
      },
    });
    const frame = parseGuidanceFrame(raw);
    const authorization = input.owner.authorize(
      createOperationLease({ envelope }),
      "advisor"
    );
    recordReceipt(input, {
      type: "RecordReceipt",
      receipt: {
        requestId: operationId,
        status: authorization.authorized ? "commit-authorized" : "stale",
        occurredAt: Date.now(),
        reason: authorization.authorized ? undefined : authorization.reason,
      },
    });
    input.owner.commitGuidance({ envelope, frame });
    input.publish();
  } catch (error) {
    const failedAt = Date.now();
    const cancelled = error instanceof OperationAbortError;
    recordReturn({
      dependencies: input,
      operationId,
      route: "advisor",
      dispatchedAt,
      status: cancelled ? "cancelled" : "failed",
      occurredAt: failedAt,
      error: message(error),
    });
    if (input.isCurrentOwner()) {
      recordReceipt(input, {
        type: "RecordReceipt",
        receipt: {
          requestId: operationId,
          status: cancelled ? "cancelled" : "failed",
          occurredAt: failedAt,
          reason: message(error),
        },
      });
    }
  } finally {
    input.unregister(operation);
  }
}

export type RuntimeModelOperationOutcome =
  | { status: "settled"; settlement: CallTurnSettlement }
  | { status: "failed"; error: string }
  | { status: "cancelled" | "stale" };

export async function runRuntimeModelOperation(
  input: ModelOperationDependencies & {
    route: ChatModelRouteConfig;
    momentUnitId: string;
  }
): Promise<RuntimeModelOperationOutcome> {
  const snapshot = input.owner.snapshot();
  const context = buildBoundedCallingContext({
    turns: snapshot.transcript,
    maxChars: 3_200,
  });
  const contextJson = JSON.stringify(context);
  const operationId = `runtime_${crypto.randomUUID()}`;
  const userPrompt = `Bounded call evidence:\n${contextJson}`;
  const envelope = input.owner.selectOperation({
    operationId,
    operationKind: "turn-settlement",
    route: "runtime",
    contextSnapshotHash: await sha256(contextJson),
    timeoutMs: input.route.timeoutMs,
    input: context,
  });
  recordReceipt(input, {
    type: "RecordReceipt",
    receipt: {
      requestId: operationId,
      status: "selected",
      occurredAt: Date.now(),
    },
  });
  const dispatchedAt = Date.now();
  recordDispatch({
    dependencies: input,
    operationId,
    routeId: "runtime",
    route: input.route,
    contextSnapshotHash: envelope.contextSnapshotHash,
    systemPrompt: RUNTIME_SYSTEM_PROMPT,
    userPrompt,
    occurredAt: dispatchedAt,
  });
  const operation = createCancellableOperation({
    operationId,
    timeoutMs: envelope.timeoutMs,
    execute: (signal) =>
      requestChatCompletion({
        route: input.route,
        apiKey: input.apiKey,
        messages: [
          { role: "system", content: RUNTIME_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        signal,
      }),
  });
  input.register(operation);
  recordReceipt(input, {
    type: "RecordReceipt",
    receipt: {
      requestId: operationId,
      status: "dispatched",
      occurredAt: dispatchedAt,
    },
  });

  try {
    const raw = await operation.promise;
    const returnedAt = Date.now();
    recordReturn({
      dependencies: input,
      operationId,
      route: "runtime",
      dispatchedAt,
      status: "success",
      occurredAt: returnedAt,
      raw,
    });
    if (!input.isCurrentOwner()) return { status: "stale" };
    recordReceipt(input, {
      type: "RecordReceipt",
      receipt: {
        requestId: operationId,
        status: "provider-returned",
        occurredAt: returnedAt,
      },
    });
    const authorization = input.owner.authorize(
      createOperationLease({ envelope }),
      "runtime"
    );
    recordReceipt(input, {
      type: "RecordReceipt",
      receipt: {
        requestId: operationId,
        status: authorization.authorized ? "commit-authorized" : "stale",
        occurredAt: Date.now(),
        reason: authorization.authorized ? undefined : authorization.reason,
      },
    });
    if (!authorization.authorized) return { status: "stale" };
    return {
      status: "settled",
      settlement: parseRuntimeSettlement({
        raw,
        callSessionId: snapshot.callSessionId,
        momentUnitId: input.momentUnitId,
        evidenceRevision: snapshot.evidenceRevision,
        settledAt: Date.now(),
      }),
    };
  } catch (error) {
    const failedAt = Date.now();
    const cancelled = error instanceof OperationAbortError;
    recordReturn({
      dependencies: input,
      operationId,
      route: "runtime",
      dispatchedAt,
      status: cancelled ? "cancelled" : "failed",
      occurredAt: failedAt,
      error: message(error),
      fallbackUsed: !cancelled,
    });
    if (!input.isCurrentOwner()) return { status: "stale" };
    recordReceipt(input, {
      type: "RecordReceipt",
      receipt: {
        requestId: operationId,
        status: cancelled ? "cancelled" : "failed",
        occurredAt: failedAt,
        reason: message(error),
      },
    });
    return cancelled
      ? { status: "cancelled" }
      : { status: "failed", error: message(error) };
  } finally {
    input.unregister(operation);
  }
}
