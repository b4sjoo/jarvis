import {
  getRuntimeInferenceOperationDefinition,
  type RuntimeInferenceOperationKind,
} from "./runtime-inference.js";

export interface RuntimeInferenceRuntimeJob {
  operationId: string;
  operationKind: RuntimeInferenceOperationKind;
  sessionId: string;
  budgetKey: string;
  budgetSlot: string;
  budgetReason: string;
}

export interface RuntimeInferenceBudgetSnapshot {
  operationKind: RuntimeInferenceOperationKind;
  lane: string;
  budgetKey: string;
  slot: string;
  reason: string;
  startsBefore: number;
  startsAfter: number;
  limit: number;
  remaining: number;
  startsBySlot: Record<string, number>;
}

export type RuntimeInferenceRuntimeDisposition =
  | "completed"
  | "error"
  | "superseded"
  | "budget-exhausted"
  | "operation-mismatch"
  | "disposed";

export interface RuntimeInferenceRuntimeSettlement<
  Job extends RuntimeInferenceRuntimeJob,
  Result,
> {
  job: Job;
  disposition: RuntimeInferenceRuntimeDisposition;
  result?: Result;
  error?: unknown;
  scheduledAt: number;
  startedAt?: number;
  completedAt: number;
  queueWaitMs?: number;
  durationMs?: number;
  budget: RuntimeInferenceBudgetSnapshot;
}

interface ScheduledJob<
  Job extends RuntimeInferenceRuntimeJob,
  Result,
> {
  job: Job;
  execute: (job: Job, signal: AbortSignal) => Promise<Result>;
  onStarted?: (
    job: Job,
    startedAt: number,
    budget: RuntimeInferenceBudgetSnapshot
  ) => void;
  onSettled: (
    settlement: RuntimeInferenceRuntimeSettlement<Job, Result>
  ) => void;
  scheduledAt: number;
}

interface ActiveJob<
  Job extends RuntimeInferenceRuntimeJob,
  Result,
> extends ScheduledJob<Job, Result> {
  controller: AbortController;
  startedAt: number;
  superseded: boolean;
  budget: RuntimeInferenceBudgetSnapshot;
}

export class RuntimeInferenceOperationRuntime<
  Job extends RuntimeInferenceRuntimeJob,
  Result,
> {
  private pending?: ScheduledJob<Job, Result>;
  private pendingTimer?: ReturnType<typeof setTimeout>;
  private active?: ActiveJob<Job, Result>;
  private startsByBudgetKey = new Map<
    string,
    Record<string, number>
  >();
  private disposed = false;
  private currentOperationId?: string;
  private readonly definition;

  constructor(
    private readonly operationKind: RuntimeInferenceOperationKind
  ) {
    this.definition =
      getRuntimeInferenceOperationDefinition(operationKind);
  }

  schedule(
    scheduled: Omit<ScheduledJob<Job, Result>, "scheduledAt">,
    quiescenceMs = this.definition.quiescenceMs
  ) {
    const scheduledAt = Date.now();
    if (scheduled.job.operationKind !== this.operationKind) {
      scheduled.onSettled({
        job: scheduled.job,
        disposition: "operation-mismatch",
        scheduledAt,
        completedAt: scheduledAt,
        budget: this.readBudgetSnapshot(scheduled.job, false),
      });
      return;
    }
    if (this.disposed) {
      scheduled.onSettled({
        job: scheduled.job,
        disposition: "disposed",
        scheduledAt,
        completedAt: scheduledAt,
        budget: this.readBudgetSnapshot(scheduled.job, false),
      });
      return;
    }
    this.currentOperationId = scheduled.job.operationId;
    this.clearPending("superseded");
    if (this.active) {
      this.active.superseded = true;
      this.active.controller.abort(
        "superseded-by-newer-operation-revision"
      );
    }
    this.pending = { ...scheduled, scheduledAt };
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = undefined;
      this.startPendingIfIdle();
    }, Math.max(0, quiescenceMs));
  }

  getCurrentOperationId() {
    return this.currentOperationId;
  }

  cancelAll(reason: "disposed" | "superseded" = "disposed") {
    this.disposed = reason === "disposed";
    this.clearPending(reason);
    if (this.active) {
      this.active.superseded = reason === "superseded";
      this.active.controller.abort(reason);
    }
    this.currentOperationId = undefined;
  }

  private clearPending(disposition: "disposed" | "superseded") {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = undefined;
    const completedAt = Date.now();
    pending.onSettled({
      job: pending.job,
      disposition,
      scheduledAt: pending.scheduledAt,
      completedAt,
      queueWaitMs: completedAt - pending.scheduledAt,
      budget: this.readBudgetSnapshot(pending.job, false),
    });
  }

  private startPendingIfIdle() {
    if (this.disposed || this.active || !this.pending) return;
    const scheduled = this.pending;
    this.pending = undefined;
    const budgetBefore = this.readBudgetSnapshot(
      scheduled.job,
      false
    );
    if (budgetBefore.startsBefore >= budgetBefore.limit) {
      const completedAt = Date.now();
      scheduled.onSettled({
        job: scheduled.job,
        disposition: "budget-exhausted",
        scheduledAt: scheduled.scheduledAt,
        completedAt,
        queueWaitMs: completedAt - scheduled.scheduledAt,
        budget: budgetBefore,
      });
      return;
    }
    const budget = this.readBudgetSnapshot(scheduled.job, true);
    while (this.startsByBudgetKey.size > 64) {
      const oldest = this.startsByBudgetKey.keys().next().value;
      if (!oldest) break;
      this.startsByBudgetKey.delete(oldest);
    }

    const controller = new AbortController();
    const startedAt = Date.now();
    const active: ActiveJob<Job, Result> = {
      ...scheduled,
      controller,
      startedAt,
      superseded: false,
      budget,
    };
    this.active = active;
    active.onStarted?.(active.job, startedAt, budget);
    void active
      .execute(active.job, controller.signal)
      .then((result) => {
        const completedAt = Date.now();
        active.onSettled({
          job: active.job,
          disposition: active.superseded
            ? "superseded"
            : "completed",
          result: active.superseded ? undefined : result,
          scheduledAt: active.scheduledAt,
          startedAt,
          completedAt,
          queueWaitMs: startedAt - active.scheduledAt,
          durationMs: completedAt - startedAt,
          budget,
        });
      })
      .catch((error) => {
        const completedAt = Date.now();
        active.onSettled({
          job: active.job,
          disposition:
            active.superseded || controller.signal.aborted
              ? "superseded"
              : "error",
          error,
          scheduledAt: active.scheduledAt,
          startedAt,
          completedAt,
          queueWaitMs: startedAt - active.scheduledAt,
          durationMs: completedAt - startedAt,
          budget,
        });
      })
      .finally(() => {
        if (this.active === active) this.active = undefined;
        this.startPendingIfIdle();
      });
  }

  private readBudgetSnapshot(job: Job, consume: boolean) {
    const budgetKey = `${job.sessionId}:${job.budgetKey}`;
    const starts = this.startsByBudgetKey.get(budgetKey) ?? {};
    const startsBefore = starts[job.budgetSlot] ?? 0;
    const startsAfter = Math.min(
      this.definition.maxStartsPerBudgetSlot,
      startsBefore + (consume ? 1 : 0)
    );
    const nextStarts = consume
      ? {
          ...starts,
          [job.budgetSlot]: startsAfter,
        }
      : { ...starts };
    if (consume) {
      this.startsByBudgetKey.set(budgetKey, nextStarts);
    }
    return {
      operationKind: this.operationKind,
      lane: this.definition.lane,
      budgetKey: job.budgetKey,
      slot: job.budgetSlot,
      reason: job.budgetReason,
      startsBefore,
      startsAfter,
      limit: this.definition.maxStartsPerBudgetSlot,
      remaining: Math.max(
        0,
        this.definition.maxStartsPerBudgetSlot - startsAfter
      ),
      startsBySlot: nextStarts,
    } satisfies RuntimeInferenceBudgetSnapshot;
  }
}
