export type SttRequestAbortReason =
  | "timeout"
  | "audio-session-invalidated"
  | "audio-session-replaced"
  | "stale-lease"
  | "runtime-boundary";

export type SttProviderOutcome = "resolved" | "rejected";

interface SttRequestLifecycleEventBase {
  requestId: string;
  occurredAt: number;
}

export type SttRequestLifecycleEvent =
  | (SttRequestLifecycleEventBase & {
      type: "started";
      timeoutMs: number;
    })
  | (SttRequestLifecycleEventBase & {
      type: "completed";
      durationMs: number;
    })
  | (SttRequestLifecycleEventBase & {
      type: "failed";
      durationMs: number;
      errorName: string;
    })
  | (SttRequestLifecycleEventBase & {
      type: "abort-requested";
      durationMs: number;
      reason: SttRequestAbortReason;
      providerTimeout: boolean;
    })
  | (SttRequestLifecycleEventBase & {
      type: "abort-observed";
      durationMs: number;
      reason: SttRequestAbortReason;
    })
  | (SttRequestLifecycleEventBase & {
      type: "orphan-completion";
      durationMs: number;
      reason: SttRequestAbortReason;
      providerOutcome: SttProviderOutcome;
    });

type SttRequestLifecycleEventPayload =
  SttRequestLifecycleEvent extends infer Event
    ? Event extends { requestId: string }
      ? Omit<Event, "requestId">
      : never
    : never;

export interface CancellableSttRequest<T> {
  requestId: string;
  signal: AbortSignal;
  promise: Promise<T>;
  cancel: (reason: SttRequestAbortReason) => boolean;
}

export interface CreateCancellableSttRequestOptions<T> {
  requestId: string;
  timeoutMs: number;
  execute: (signal: AbortSignal) => Promise<T>;
  onEvent?: (event: SttRequestLifecycleEvent) => void;
  now?: () => number;
}

export class SttRequestAbortError extends Error {
  readonly requestId: string;
  readonly reason: SttRequestAbortReason;

  constructor(requestId: string, reason: SttRequestAbortReason) {
    super(
      reason === "timeout"
        ? "Speech-to-text timed out. Jarvis is still listening."
        : `Speech-to-text request cancelled: ${reason}.`
    );
    this.name = "AbortError";
    this.requestId = requestId;
    this.reason = reason;
  }
}

export function createCancellableSttRequest<T>({
  requestId,
  timeoutMs,
  execute,
  onEvent,
  now = Date.now,
}: CreateCancellableSttRequestOptions<T>): CancellableSttRequest<T> {
  const controller = new AbortController();
  const startedAt = now();
  let abortReason: SttRequestAbortReason | undefined;
  let outerSettled = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let resolveOuter!: (value: T | PromiseLike<T>) => void;
  let rejectOuter!: (reason?: unknown) => void;

  const emit = (event: SttRequestLifecycleEventPayload) => {
    onEvent?.({ requestId, ...event } as SttRequestLifecycleEvent);
  };
  const clearRequestTimeout = () => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  };
  const settleOuter = () => {
    outerSettled = true;
    clearRequestTimeout();
  };

  const promise = new Promise<T>((resolve, reject) => {
    resolveOuter = resolve;
    rejectOuter = reject;
  });

  const cancel = (reason: SttRequestAbortReason) => {
    if (outerSettled) return false;

    abortReason = reason;
    const occurredAt = now();
    controller.abort(reason);
    emit({
      type: "abort-requested",
      occurredAt,
      durationMs: Math.max(0, occurredAt - startedAt),
      reason,
      providerTimeout: reason === "timeout",
    });
    settleOuter();
    rejectOuter(new SttRequestAbortError(requestId, reason));
    return true;
  };

  emit({
    type: "started",
    occurredAt: startedAt,
    timeoutMs,
  });

  const providerPromise = Promise.resolve().then(() => {
    if (controller.signal.aborted) {
      throw new SttRequestAbortError(
        requestId,
        abortReason ?? "runtime-boundary"
      );
    }
    return execute(controller.signal);
  });

  providerPromise.then(
    (value) => {
      const occurredAt = now();
      const durationMs = Math.max(0, occurredAt - startedAt);
      if (outerSettled) {
        if (abortReason) {
          emit({
            type: "orphan-completion",
            occurredAt,
            durationMs,
            reason: abortReason,
            providerOutcome: "resolved",
          });
        }
        return;
      }

      settleOuter();
      emit({ type: "completed", occurredAt, durationMs });
      resolveOuter(value);
    },
    (error) => {
      const occurredAt = now();
      const durationMs = Math.max(0, occurredAt - startedAt);
      if (outerSettled) {
        if (abortReason) {
          if (isAbortLikeError(error)) {
            emit({
              type: "abort-observed",
              occurredAt,
              durationMs,
              reason: abortReason,
            });
          } else {
            emit({
              type: "orphan-completion",
              occurredAt,
              durationMs,
              reason: abortReason,
              providerOutcome: "rejected",
            });
          }
        }
        return;
      }

      settleOuter();
      emit({
        type: "failed",
        occurredAt,
        durationMs,
        errorName: readErrorName(error),
      });
      rejectOuter(error);
    }
  );

  timeoutId = setTimeout(() => {
    cancel("timeout");
  }, Math.max(1, timeoutMs));

  return {
    requestId,
    signal: controller.signal,
    promise,
    cancel,
  };
}

export function formatSttRequestLifecycleEventForTrace(
  event: SttRequestLifecycleEvent
): Record<string, unknown> {
  const base = {
    sttRequestLifecycleEvent: event.type,
    sttRequestLifecycleAttemptId: event.requestId,
  };

  switch (event.type) {
    case "started":
      return {
        ...base,
        sttRequestStartedAt: event.occurredAt,
        sttRequestTimeoutMs: event.timeoutMs,
      };
    case "completed":
      return {
        ...base,
        sttRequestEndedAt: event.occurredAt,
        sttRequestDurationMs: event.durationMs,
      };
    case "failed":
      return {
        ...base,
        sttRequestEndedAt: event.occurredAt,
        sttRequestDurationMs: event.durationMs,
        sttRequestFailureName: event.errorName,
      };
    case "abort-requested":
      return {
        ...base,
        sttRequestAbortRequested: true,
        sttRequestAbortRequestedAt: event.occurredAt,
        sttRequestAbortReason: event.reason,
        sttProviderTimeout: event.providerTimeout,
        sttRequestDurationMs: event.durationMs,
      };
    case "abort-observed":
      return {
        ...base,
        sttRequestAbortObserved: true,
        sttRequestAbortObservedAt: event.occurredAt,
        sttRequestAbortReason: event.reason,
        sttProviderSettledAfterAbortMs: event.durationMs,
      };
    case "orphan-completion":
      return {
        ...base,
        sttRequestOrphanCompletion: true,
        sttRequestOrphanCompletedAt: event.occurredAt,
        sttRequestAbortReason: event.reason,
        sttRequestOrphanProviderOutcome: event.providerOutcome,
        sttProviderSettledAfterAbortMs: event.durationMs,
      };
  }
}

export interface AudioQueueDequeueSnapshot {
  authorized: boolean;
  queueDepthAtDequeue: number;
}

export class AudioSegmentQueueTracker {
  private sessionId = "";
  private depth = 0;

  reset(sessionId: string) {
    this.sessionId = sessionId;
    this.depth = 0;
  }

  enqueue(sessionId: string) {
    if (this.sessionId !== sessionId) {
      this.reset(sessionId);
    }
    this.depth += 1;
    return this.depth;
  }

  dequeue(sessionId: string): AudioQueueDequeueSnapshot {
    if (this.sessionId !== sessionId) {
      return {
        authorized: false,
        queueDepthAtDequeue: this.depth,
      };
    }
    this.depth = Math.max(0, this.depth - 1);
    return {
      authorized: true,
      queueDepthAtDequeue: this.depth,
    };
  }

  getDepth() {
    return this.depth;
  }
}

export function isAbortLikeError(error: unknown) {
  if (error instanceof SttRequestAbortError) return true;
  if (!error || typeof error !== "object") return false;
  return (error as { name?: unknown }).name === "AbortError";
}

function readErrorName(error: unknown) {
  if (error && typeof error === "object") {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name.trim()) {
      return name;
    }
  }
  return "Error";
}
