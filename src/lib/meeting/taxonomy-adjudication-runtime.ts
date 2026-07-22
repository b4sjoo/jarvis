import type {
  TaxonomyAdjudicationLease,
  TaxonomyAdjudicationRequest,
} from "./taxonomy-adjudication.js";

export const TAXONOMY_ADJUDICATION_QUIESCENCE_MS = 450;
export const TAXONOMY_ADJUDICATION_MAX_STARTS_PER_UNIT = 2;

export interface TaxonomyAdjudicationRuntimeJob {
  traceId: string;
  lease: TaxonomyAdjudicationLease;
  request: TaxonomyAdjudicationRequest;
  triggerReasons: string[];
}

export type TaxonomyAdjudicationRuntimeDisposition =
  | "completed"
  | "error"
  | "superseded"
  | "budget-exhausted"
  | "disposed";

export interface TaxonomyAdjudicationRuntimeSettlement<Result> {
  job: TaxonomyAdjudicationRuntimeJob;
  disposition: TaxonomyAdjudicationRuntimeDisposition;
  result?: Result;
  error?: unknown;
  startedAt?: number;
  completedAt: number;
  durationMs?: number;
}

interface ScheduledJob<Result> {
  job: TaxonomyAdjudicationRuntimeJob;
  execute: (
    job: TaxonomyAdjudicationRuntimeJob,
    signal: AbortSignal
  ) => Promise<Result>;
  onStarted?: (job: TaxonomyAdjudicationRuntimeJob, startedAt: number) => void;
  onSettled: (
    settlement: TaxonomyAdjudicationRuntimeSettlement<Result>
  ) => void;
  scheduledAt: number;
}

interface ActiveJob<Result> extends ScheduledJob<Result> {
  controller: AbortController;
  startedAt: number;
  superseded: boolean;
}

export class TaxonomyAdjudicationRuntime<Result> {
  private pending?: ScheduledJob<Result>;
  private pendingTimer?: ReturnType<typeof setTimeout>;
  private active?: ActiveJob<Result>;
  private startsByUnitId = new Map<string, number>();
  private disposed = false;
  private currentOperationId?: string;

  schedule(
    scheduled: Omit<ScheduledJob<Result>, "scheduledAt">,
    quiescenceMs = TAXONOMY_ADJUDICATION_QUIESCENCE_MS
  ) {
    if (this.disposed) {
      scheduled.onSettled({
        job: scheduled.job,
        disposition: "disposed",
        completedAt: Date.now(),
      });
      return;
    }
    this.currentOperationId = scheduled.job.lease.operationId;
    this.clearPending("superseded");
    if (this.active) {
      this.active.superseded = true;
      this.active.controller.abort("superseded-by-newer-question-revision");
    }
    this.pending = { ...scheduled, scheduledAt: Date.now() };
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = undefined;
      this.startPendingIfIdle();
    }, quiescenceMs);
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
    pending.onSettled({
      job: pending.job,
      disposition,
      completedAt: Date.now(),
    });
  }

  private startPendingIfIdle() {
    if (this.disposed || this.active || !this.pending) return;
    const scheduled = this.pending;
    this.pending = undefined;
    const unitId = scheduled.job.lease.logicalQuestionUnitId;
    const starts = this.startsByUnitId.get(unitId) ?? 0;
    if (starts >= TAXONOMY_ADJUDICATION_MAX_STARTS_PER_UNIT) {
      scheduled.onSettled({
        job: scheduled.job,
        disposition: "budget-exhausted",
        completedAt: Date.now(),
      });
      return;
    }
    this.startsByUnitId.set(unitId, starts + 1);
    while (this.startsByUnitId.size > 32) {
      const oldest = this.startsByUnitId.keys().next().value;
      if (!oldest) break;
      this.startsByUnitId.delete(oldest);
    }

    const controller = new AbortController();
    const startedAt = Date.now();
    const active: ActiveJob<Result> = {
      ...scheduled,
      controller,
      startedAt,
      superseded: false,
    };
    this.active = active;
    active.onStarted?.(active.job, startedAt);
    void active
      .execute(active.job, controller.signal)
      .then((result) => {
        active.onSettled({
          job: active.job,
          disposition: active.superseded ? "superseded" : "completed",
          result: active.superseded ? undefined : result,
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        });
      })
      .catch((error) => {
        active.onSettled({
          job: active.job,
          disposition:
            active.superseded || controller.signal.aborted
              ? "superseded"
              : "error",
          error,
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        });
      })
      .finally(() => {
        if (this.active === active) this.active = undefined;
        this.startPendingIfIdle();
      });
  }
}
