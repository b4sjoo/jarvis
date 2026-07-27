export type CaptureLifecycleAction = "start" | "resume" | "pause" | "stop";

export type CaptureLifecycleEventStage =
  | "claimed"
  | "coalesced"
  | "dequeued"
  | "skipped-before-run"
  | "authorization-checked"
  | "native-completed"
  | "stale-cleanup-started"
  | "stale-cleanup-finished"
  | "stale-cleanup-failed"
  | "finished";

export interface CaptureLifecycleOperation {
  id: number;
  action: CaptureLifecycleAction;
  claimedAt: number;
}

export interface CaptureLifecycleEvent {
  operationId: number;
  action: CaptureLifecycleAction;
  stage: CaptureLifecycleEventStage;
  occurredAt: number;
  authorized: boolean;
  detail?: string;
  error?: string;
}

export interface CaptureLifecycleRunResult<T> {
  executed: boolean;
  authorized: boolean;
  value?: T;
}

type CaptureLifecycleEventReporter = (event: CaptureLifecycleEvent) => void;

export class CaptureLifecycleCoordinator {
  private sequence = 0;
  private currentOperation: CaptureLifecycleOperation | null = null;
  private queueTail: Promise<void> = Promise.resolve();
  private coalescedRuns = new Map<
    CaptureLifecycleAction,
    {
      operation: CaptureLifecycleOperation;
      promise: Promise<CaptureLifecycleRunResult<unknown>>;
    }
  >();

  constructor(private readonly report?: CaptureLifecycleEventReporter) {}

  claim(action: CaptureLifecycleAction): CaptureLifecycleOperation {
    const operation: CaptureLifecycleOperation = {
      id: this.sequence + 1,
      action,
      claimedAt: Date.now(),
    };
    this.sequence = operation.id;
    this.currentOperation = operation;
    this.emit(operation, "claimed", true);
    return operation;
  }

  isCurrent(operation: CaptureLifecycleOperation) {
    return this.currentOperation?.id === operation.id;
  }

  authorize(operation: CaptureLifecycleOperation, detail: string) {
    const authorized = this.isCurrent(operation);
    this.emit(operation, "authorization-checked", authorized, detail);
    return authorized;
  }

  recordNativeCompletion(
    operation: CaptureLifecycleOperation,
    detail: string
  ) {
    const authorized = this.isCurrent(operation);
    this.emit(operation, "native-completed", authorized, detail);
    return authorized;
  }

  async cleanupStale(
    operation: CaptureLifecycleOperation,
    detail: string,
    cleanup: () => Promise<unknown>
  ) {
    this.emit(operation, "stale-cleanup-started", false, detail);
    try {
      await cleanup();
      this.emit(operation, "stale-cleanup-finished", false, detail);
    } catch (error) {
      this.emit(
        operation,
        "stale-cleanup-failed",
        false,
        detail,
        stringifyLifecycleError(error)
      );
    }
  }

  run<T>(
    operation: CaptureLifecycleOperation,
    execute: () => Promise<T>
  ): Promise<CaptureLifecycleRunResult<T>> {
    const task = this.queueTail
      .catch(() => undefined)
      .then(async (): Promise<CaptureLifecycleRunResult<T>> => {
        const authorized = this.isCurrent(operation);
        this.emit(operation, "dequeued", authorized);
        if (!authorized) {
          this.emit(operation, "skipped-before-run", false);
          return { executed: false, authorized: false };
        }

        const value = await execute();
        const stillAuthorized = this.isCurrent(operation);
        this.emit(operation, "finished", stillAuthorized);
        return {
          executed: true,
          authorized: stillAuthorized,
          value,
        };
      });

    this.queueTail = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  runCoalesced<T>(
    action: CaptureLifecycleAction,
    execute: (operation: CaptureLifecycleOperation) => Promise<T>
  ): Promise<CaptureLifecycleRunResult<T>> {
    const existing = this.coalescedRuns.get(action);
    if (existing && this.isCurrent(existing.operation)) {
      this.emit(existing.operation, "coalesced", true);
      return existing.promise as Promise<CaptureLifecycleRunResult<T>>;
    }

    const operation = this.claim(action);
    const promise = this.run(operation, () => execute(operation));
    const entry = {
      operation,
      promise: promise as Promise<CaptureLifecycleRunResult<unknown>>,
    };
    this.coalescedRuns.set(action, entry);

    const clear = () => {
      if (this.coalescedRuns.get(action) === entry) {
        this.coalescedRuns.delete(action);
      }
    };
    void promise.then(clear, clear);

    return promise;
  }

  getTraceMetadata() {
    return this.currentOperation
      ? {
          captureLifecycleOperationId: this.currentOperation.id,
          captureLifecycleAction: this.currentOperation.action,
          captureLifecycleClaimedAt: this.currentOperation.claimedAt,
        }
      : {};
  }

  private emit(
    operation: CaptureLifecycleOperation,
    stage: CaptureLifecycleEventStage,
    authorized: boolean,
    detail?: string,
    error?: string
  ) {
    this.report?.({
      operationId: operation.id,
      action: operation.action,
      stage,
      occurredAt: Date.now(),
      authorized,
      detail,
      error,
    });
  }
}

function stringifyLifecycleError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
