import type { RuntimeInferenceLane } from "./runtime-inference.js";

export interface RuntimeInferenceSharedAdmissionReceipt {
  operationId: string;
  lane: RuntimeInferenceLane;
  queuedAt: number;
  admittedAt: number;
  waitMs: number;
  queueDepthAtEnqueue: number;
  queueDepthAtAdmission: number;
  activeCountAtAdmission: number;
  maxConcurrent: number;
}

interface PendingAdmission<T> {
  sequence: number;
  operationId: string;
  lane: RuntimeInferenceLane;
  queuedAt: number;
  eligibleAt: number;
  queueDepthAtEnqueue: number;
  signal: AbortSignal;
  execute: () => Promise<T>;
  onAdmitted?: (receipt: RuntimeInferenceSharedAdmissionReceipt) => void;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  abortListener: () => void;
}

const LANE_PRIORITY: Record<RuntimeInferenceLane, number> = {
  critical: 0,
  evaluation: 1,
  background: 2,
};

export class RuntimeInferenceProviderAdmissionCoordinator {
  private readonly queue: PendingAdmission<unknown>[] = [];
  private activeCount = 0;
  private sequence = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly maxConcurrent = 3,
    private readonly nonCriticalGraceMs = 450
  ) {}

  run<T>(input: {
    operationId: string;
    lane: RuntimeInferenceLane;
    signal: AbortSignal;
    execute: () => Promise<T>;
    onAdmitted?: (receipt: RuntimeInferenceSharedAdmissionReceipt) => void;
  }): Promise<T> {
    if (input.signal.aborted) {
      return Promise.reject(createAbortError());
    }
    const queuedAt = Date.now();
    return new Promise<T>((resolve, reject) => {
      const pending: PendingAdmission<T> = {
        sequence: this.sequence++,
        operationId: input.operationId,
        lane: input.lane,
        queuedAt,
        eligibleAt:
          queuedAt +
          (input.lane === "critical" ? 0 : this.nonCriticalGraceMs),
        queueDepthAtEnqueue: this.queue.length,
        signal: input.signal,
        execute: input.execute,
        onAdmitted: input.onAdmitted,
        resolve,
        reject,
        abortListener: () => {
          const index = this.queue.indexOf(
            pending as PendingAdmission<unknown>
          );
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(createAbortError());
          this.drain();
        },
      };
      input.signal.addEventListener("abort", pending.abortListener, {
        once: true,
      });
      this.queue.push(pending as PendingAdmission<unknown>);
      this.drain();
    });
  }

  readSnapshot() {
    return {
      activeCount: this.activeCount,
      queuedCount: this.queue.length,
      maxConcurrent: this.maxConcurrent,
    };
  }

  private drain() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;

    while (this.activeCount < this.maxConcurrent && this.queue.length) {
      const now = Date.now();
      const eligible = this.queue
        .filter((candidate) => candidate.eligibleAt <= now)
        .sort(
          (left, right) =>
            LANE_PRIORITY[left.lane] - LANE_PRIORITY[right.lane] ||
            left.sequence - right.sequence
        );
      const next = eligible[0];
      if (!next) {
        const delayMs = Math.max(
          0,
          Math.min(...this.queue.map((candidate) => candidate.eligibleAt)) -
            now
        );
        this.timer = setTimeout(() => this.drain(), delayMs);
        return;
      }

      const index = this.queue.indexOf(next);
      if (index < 0) continue;
      this.queue.splice(index, 1);
      next.signal.removeEventListener("abort", next.abortListener);
      if (next.signal.aborted) {
        next.reject(createAbortError());
        continue;
      }

      const admittedAt = Date.now();
      const receipt: RuntimeInferenceSharedAdmissionReceipt = {
        operationId: next.operationId,
        lane: next.lane,
        queuedAt: next.queuedAt,
        admittedAt,
        waitMs: Math.max(0, admittedAt - next.queuedAt),
        queueDepthAtEnqueue: next.queueDepthAtEnqueue,
        queueDepthAtAdmission: this.queue.length,
        activeCountAtAdmission: this.activeCount + 1,
        maxConcurrent: this.maxConcurrent,
      };
      this.activeCount += 1;
      next.onAdmitted?.(receipt);
      void Promise.resolve()
        .then(next.execute)
        .then(next.resolve, next.reject)
        .finally(() => {
          this.activeCount = Math.max(0, this.activeCount - 1);
          this.drain();
        });
    }
  }
}

export function formatRuntimeInferenceSharedAdmissionForTrace(
  receipt: RuntimeInferenceSharedAdmissionReceipt | undefined
) {
  return {
    runtimeInferenceSharedAdmissionWaitMs: receipt?.waitMs,
    runtimeInferenceSharedQueueDepthAtEnqueue:
      receipt?.queueDepthAtEnqueue,
    runtimeInferenceSharedQueueDepthAtAdmission:
      receipt?.queueDepthAtAdmission,
    runtimeInferenceSharedActiveAtAdmission:
      receipt?.activeCountAtAdmission,
    runtimeInferenceSharedMaxConcurrent: receipt?.maxConcurrent,
    runtimeInferenceSharedAdmissionLane: receipt?.lane,
  };
}

function createAbortError() {
  const error = new Error("Runtime inference provider admission aborted.");
  error.name = "AbortError";
  return error;
}
