export type CancellableOperationEvent =
  | { type: "started"; operationId: string }
  | { type: "abort-requested"; operationId: string; reason: string }
  | { type: "completed"; operationId: string }
  | { type: "failed"; operationId: string; error: unknown }
  | { type: "timed-out"; operationId: string }
  | { type: "orphan-completion"; operationId: string };

export class OperationAbortError extends Error {
  constructor(readonly reason: string) {
    super(`Operation aborted: ${reason}`);
    this.name = "OperationAbortError";
  }
}

export function createCancellableOperation<T>(input: {
  operationId: string;
  timeoutMs: number;
  execute: (signal: AbortSignal) => Promise<T>;
  onEvent?: (event: CancellableOperationEvent) => void;
}) {
  const controller = new AbortController();
  let settled = false;
  let abortedReason: string | null = null;
  let rejectAbort!: (error: OperationAbortError) => void;
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const emit = (event: CancellableOperationEvent) => input.onEvent?.(event);
  emit({ type: "started", operationId: input.operationId });

  const providerPromise = input.execute(controller.signal).then(
    (value) => {
      if (abortedReason) {
        emit({ type: "orphan-completion", operationId: input.operationId });
        throw new OperationAbortError(abortedReason);
      }
      settled = true;
      emit({ type: "completed", operationId: input.operationId });
      return value;
    },
    (error) => {
      if (abortedReason) throw new OperationAbortError(abortedReason);
      settled = true;
      emit({ type: "failed", operationId: input.operationId, error });
      throw error;
    }
  );

  const timeout = setTimeout(() => {
    if (settled || abortedReason) return;
    abortedReason = "timeout";
    controller.abort(abortedReason);
    emit({ type: "timed-out", operationId: input.operationId });
    rejectAbort(new OperationAbortError(abortedReason));
  }, input.timeoutMs);

  const promise = Promise.race([providerPromise, abortPromise]).finally(() => {
    clearTimeout(timeout);
  });

  return {
    promise,
    signal: controller.signal,
    cancel(reason: string) {
      if (settled || abortedReason) return false;
      abortedReason = reason;
      controller.abort(reason);
      emit({ type: "abort-requested", operationId: input.operationId, reason });
      rejectAbort(new OperationAbortError(reason));
      return true;
    },
  };
}
