import type {
  TaxonomyAdjudicationLease,
  TaxonomyAdjudicationRequest,
} from "./taxonomy-adjudication.js";
import { getRuntimeInferenceOperationDefinition } from "./runtime-inference.js";
import type {
  RuntimeInferenceProviderAdmissionCoordinator,
  RuntimeInferenceSharedAdmissionReceipt,
} from "./runtime-inference-provider-admission.js";

const TAXONOMY_OPERATION =
  getRuntimeInferenceOperationDefinition("taxonomy-adjudication");

export const TAXONOMY_ADJUDICATION_QUIESCENCE_MS =
  TAXONOMY_OPERATION.quiescenceMs;
export const TAXONOMY_ADJUDICATION_MAX_STARTS_PER_SLOT =
  TAXONOMY_OPERATION.maxStartsPerBudgetSlot;

export type TaxonomyAdjudicationBudgetSlot = "ambient" | "substantive";

export interface TaxonomyAdjudicationBudgetSnapshot {
  slot: TaxonomyAdjudicationBudgetSlot;
  reason: string;
  startsBefore: number;
  startsAfter: number;
  limit: number;
  remaining: number;
  ambientStarts: number;
  substantiveStarts: number;
  reservedSubstantiveAvailable: boolean;
}

export interface TaxonomyAdjudicationRuntimeJob {
  traceId: string;
  lease: TaxonomyAdjudicationLease;
  request: TaxonomyAdjudicationRequest;
  triggerReasons: string[];
  budgetSlot: TaxonomyAdjudicationBudgetSlot;
  budgetReason: string;
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
  sharedAdmission?: RuntimeInferenceSharedAdmissionReceipt;
  budget: TaxonomyAdjudicationBudgetSnapshot;
}

interface ScheduledJob<Result> {
  job: TaxonomyAdjudicationRuntimeJob;
  execute: (
    job: TaxonomyAdjudicationRuntimeJob,
    signal: AbortSignal
  ) => Promise<Result>;
  onStarted?: (
    job: TaxonomyAdjudicationRuntimeJob,
    startedAt: number,
    budget: TaxonomyAdjudicationBudgetSnapshot
  ) => void;
  onSettled: (
    settlement: TaxonomyAdjudicationRuntimeSettlement<Result>
  ) => void;
  scheduledAt: number;
}

interface ActiveJob<Result> extends ScheduledJob<Result> {
  controller: AbortController;
  startedAt?: number;
  superseded: boolean;
  budget: TaxonomyAdjudicationBudgetSnapshot;
  sharedAdmission?: RuntimeInferenceSharedAdmissionReceipt;
}

export class TaxonomyAdjudicationRuntime<Result> {
  private pending?: ScheduledJob<Result>;
  private pendingTimer?: ReturnType<typeof setTimeout>;
  private active?: ActiveJob<Result>;
  private startsByUnitId = new Map<
    string,
    Record<TaxonomyAdjudicationBudgetSlot, number>
  >();
  private disposed = false;
  private currentOperationId?: string;

  constructor(
    private readonly admissionCoordinator?: RuntimeInferenceProviderAdmissionCoordinator
  ) {}

  schedule(
    scheduled: Omit<ScheduledJob<Result>, "scheduledAt">,
    quiescenceMs = TAXONOMY_ADJUDICATION_QUIESCENCE_MS
  ) {
    if (this.disposed) {
      scheduled.onSettled({
        job: scheduled.job,
        disposition: "disposed",
        completedAt: Date.now(),
        budget: this.readBudgetSnapshot(scheduled.job, false),
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
      budget: this.readBudgetSnapshot(pending.job, false),
    });
  }

  private startPendingIfIdle() {
    if (this.disposed || this.active || !this.pending) return;
    const scheduled = this.pending;
    this.pending = undefined;
    const budgetBefore = this.readBudgetSnapshot(scheduled.job, false);
    if (
      budgetBefore.startsBefore >=
      TAXONOMY_ADJUDICATION_MAX_STARTS_PER_SLOT
    ) {
      scheduled.onSettled({
        job: scheduled.job,
        disposition: "budget-exhausted",
        completedAt: Date.now(),
        budget: budgetBefore,
      });
      return;
    }
    const controller = new AbortController();
    const active: ActiveJob<Result> = {
      ...scheduled,
      controller,
      superseded: false,
      budget: budgetBefore,
    };
    this.active = active;
    const execute = () => {
      const budget = this.readBudgetSnapshot(active.job, true);
      while (this.startsByUnitId.size > 32) {
        const oldest = this.startsByUnitId.keys().next().value;
        if (!oldest) break;
        this.startsByUnitId.delete(oldest);
      }
      const startedAt = Date.now();
      active.startedAt = startedAt;
      active.budget = budget;
      active.onStarted?.(active.job, startedAt, budget);
      return active.execute(active.job, controller.signal);
    };
    const execution = this.admissionCoordinator
      ? this.admissionCoordinator.run({
        operationId: active.job.lease.operationId,
        lane: TAXONOMY_OPERATION.lane,
        providerTier: TAXONOMY_OPERATION.providerTier,
          signal: controller.signal,
          execute,
          onAdmitted: (receipt) => {
            active.sharedAdmission = receipt;
          },
        })
      : execute();
    void execution
      .then((result) => {
        const completedAt = Date.now();
        const startedAt = active.startedAt;
        active.onSettled({
          job: active.job,
          disposition: active.superseded ? "superseded" : "completed",
          result: active.superseded ? undefined : result,
          startedAt,
          completedAt,
          durationMs:
            startedAt === undefined
              ? undefined
              : completedAt - startedAt,
          sharedAdmission: active.sharedAdmission,
          budget: active.budget,
        });
      })
      .catch((error) => {
        const completedAt = Date.now();
        const startedAt = active.startedAt;
        active.onSettled({
          job: active.job,
          disposition:
            active.superseded || controller.signal.aborted
              ? "superseded"
              : "error",
          error,
          startedAt,
          completedAt,
          durationMs:
            startedAt === undefined
              ? undefined
              : completedAt - startedAt,
          sharedAdmission: active.sharedAdmission,
          budget: active.budget,
        });
      })
      .finally(() => {
        if (this.active === active) this.active = undefined;
        this.startPendingIfIdle();
      });
  }

  private readBudgetSnapshot(
    job: TaxonomyAdjudicationRuntimeJob,
    consume: boolean
  ): TaxonomyAdjudicationBudgetSnapshot {
    const unitId = job.lease.logicalQuestionUnitId;
    const starts = this.startsByUnitId.get(unitId) ?? {
      ambient: 0,
      substantive: 0,
    };
    const startsBefore = starts[job.budgetSlot];
    const startsAfter = Math.min(
      TAXONOMY_ADJUDICATION_MAX_STARTS_PER_SLOT,
      startsBefore + (consume ? 1 : 0)
    );
    const nextStarts = consume
      ? {
          ...starts,
          [job.budgetSlot]: startsAfter,
        }
      : starts;
    if (consume) {
      this.startsByUnitId.set(unitId, nextStarts);
    }
    return {
      slot: job.budgetSlot,
      reason: job.budgetReason,
      startsBefore,
      startsAfter,
      limit: TAXONOMY_ADJUDICATION_MAX_STARTS_PER_SLOT,
      remaining: Math.max(
        0,
        TAXONOMY_ADJUDICATION_MAX_STARTS_PER_SLOT - startsAfter
      ),
      ambientStarts: nextStarts.ambient,
      substantiveStarts: nextStarts.substantive,
      reservedSubstantiveAvailable:
        nextStarts.substantive <
        TAXONOMY_ADJUDICATION_MAX_STARTS_PER_SLOT,
    };
  }
}
