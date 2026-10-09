import type {
  RuntimeInferenceLane,
  RuntimeInferenceProviderTier,
} from "./runtime-inference.js";

export interface RuntimeInferenceSharedAdmissionReceipt {
  operationId: string;
  lane: RuntimeInferenceLane;
  providerTier: RuntimeInferenceProviderTier;
  providerGroupKey: string;
  queuedAt: number;
  eligibleAt: number;
  admittedAt: number;
  waitMs: number;
  queueDepthAtEnqueue: number;
  queueDepthAtAdmission: number;
  activeCountAtAdmission: number;
  maxConcurrent: number;
}

export interface RuntimeInferenceAdmissionClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

interface PendingAdmission<T> {
  sequence: number;
  operationId: string;
  lane: RuntimeInferenceLane;
  providerTier: RuntimeInferenceProviderTier;
  providerGroupKey: string;
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
  private readonly activeCountByGroup = new Map<string, number>();
  private readonly nonCriticalEligibleAtByGroup = new Map<string, number>();
  private sequence = 0;
  private timer?: unknown;
  private fastFingerprint = "default";
  private intelligentFingerprint = "default";

  constructor(
    private readonly maxConcurrent = 3,
    private readonly nonCriticalGraceMs = 450,
    private readonly clock: RuntimeInferenceAdmissionClock = SYSTEM_ADMISSION_CLOCK
  ) {}

  configureProviderGroups(input: {
    fastFingerprint: string;
    intelligentFingerprint: string;
  }) {
    this.fastFingerprint = input.fastFingerprint || "default";
    this.intelligentFingerprint = input.intelligentFingerprint || "default";
  }

  run<T>(input: {
    operationId: string;
    lane: RuntimeInferenceLane;
    providerTier?: RuntimeInferenceProviderTier;
    providerConfigFingerprint?: string;
    signal: AbortSignal;
    execute: () => Promise<T>;
    onAdmitted?: (receipt: RuntimeInferenceSharedAdmissionReceipt) => void;
  }): Promise<T> {
    if (input.signal.aborted) {
      return Promise.reject(createAbortError());
    }
    const queuedAt = this.clock.now();
    const providerTier = input.providerTier ?? "fast";
    const providerGroupKey = input.providerConfigFingerprint
      ? `provider:${input.providerConfigFingerprint}`
      : this.resolveProviderGroupKey(providerTier);
    const eligibleAt = this.resolveEligibleAt({
      providerGroupKey,
      lane: input.lane,
      queuedAt,
    });
    return new Promise<T>((resolve, reject) => {
      const pending: PendingAdmission<T> = {
        sequence: this.sequence++,
        operationId: input.operationId,
        lane: input.lane,
        providerTier,
        providerGroupKey,
        queuedAt,
        eligibleAt,
        queueDepthAtEnqueue: this.queue.filter(
          (candidate) => candidate.providerGroupKey === providerGroupKey
        ).length,
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
          this.clearNonCriticalEpochWhenIdle(providerGroupKey);
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

  readSnapshot(providerTier: RuntimeInferenceProviderTier = "fast") {
    const providerGroupKey = this.resolveProviderGroupKey(providerTier);
    return {
      activeCount: this.readActiveCount(providerGroupKey),
      queuedCount: this.queue.filter(
        (candidate) => candidate.providerGroupKey === providerGroupKey
      ).length,
      maxConcurrent: this.maxConcurrent,
    };
  }

  private drain() {
    if (this.timer !== undefined) this.clock.cancel(this.timer);
    this.timer = undefined;

    while (this.queue.length) {
      const now = this.clock.now();
      const eligible = this.queue
        .filter(
          (candidate) =>
            candidate.eligibleAt <= now &&
            this.readActiveCount(candidate.providerGroupKey) <
              this.maxConcurrent
        )
        .sort(
          (left, right) =>
            LANE_PRIORITY[left.lane] - LANE_PRIORITY[right.lane] ||
            left.sequence - right.sequence
        );
      const next = eligible[0];
      if (!next) {
        const futureEligibleAt = this.queue
          .map((candidate) => candidate.eligibleAt)
          .filter((eligibleAt) => eligibleAt > now);
        if (futureEligibleAt.length) {
          const delayMs = Math.max(
            0,
            Math.min(...futureEligibleAt) - now
          );
          this.timer = this.clock.schedule(() => this.drain(), delayMs);
        }
        return;
      }

      const index = this.queue.indexOf(next);
      if (index < 0) continue;
      this.queue.splice(index, 1);
      this.clearNonCriticalEpochWhenIdle(next.providerGroupKey);
      next.signal.removeEventListener("abort", next.abortListener);
      if (next.signal.aborted) {
        next.reject(createAbortError());
        continue;
      }

      const admittedAt = this.clock.now();
      const receipt: RuntimeInferenceSharedAdmissionReceipt = {
        operationId: next.operationId,
        lane: next.lane,
        providerTier: next.providerTier,
        providerGroupKey: next.providerGroupKey,
        queuedAt: next.queuedAt,
        eligibleAt: next.eligibleAt,
        admittedAt,
        waitMs: Math.max(0, admittedAt - next.queuedAt),
        queueDepthAtEnqueue: next.queueDepthAtEnqueue,
        queueDepthAtAdmission: this.queue.filter(
          (candidate) =>
            candidate.providerGroupKey === next.providerGroupKey
        ).length,
        activeCountAtAdmission:
          this.readActiveCount(next.providerGroupKey) + 1,
        maxConcurrent: this.maxConcurrent,
      };
      this.incrementActiveCount(next.providerGroupKey);
      next.onAdmitted?.(receipt);
      void Promise.resolve()
        .then(next.execute)
        .then(next.resolve, next.reject)
        .finally(() => {
          this.decrementActiveCount(next.providerGroupKey);
          this.drain();
        });
    }
  }

  private resolveProviderGroupKey(tier: RuntimeInferenceProviderTier) {
    const fingerprint =
      tier === "intelligent"
        ? this.intelligentFingerprint
        : this.fastFingerprint;
    return `provider:${fingerprint}`;
  }

  private resolveEligibleAt(input: {
    providerGroupKey: string;
    lane: RuntimeInferenceLane;
    queuedAt: number;
  }) {
    if (input.lane === "critical") return input.queuedAt;
    const existingEpoch = this.nonCriticalEligibleAtByGroup.get(
      input.providerGroupKey
    );
    const hasQueuedNonCritical = this.queue.some(
      (candidate) =>
        candidate.providerGroupKey === input.providerGroupKey &&
        candidate.lane !== "critical"
    );
    if (existingEpoch !== undefined && hasQueuedNonCritical) {
      return existingEpoch;
    }
    const eligibleAt = input.queuedAt + this.nonCriticalGraceMs;
    this.nonCriticalEligibleAtByGroup.set(
      input.providerGroupKey,
      eligibleAt
    );
    return eligibleAt;
  }

  private clearNonCriticalEpochWhenIdle(providerGroupKey: string) {
    const hasQueuedNonCritical = this.queue.some(
      (candidate) =>
        candidate.providerGroupKey === providerGroupKey &&
        candidate.lane !== "critical"
    );
    if (!hasQueuedNonCritical) {
      this.nonCriticalEligibleAtByGroup.delete(providerGroupKey);
    }
  }

  private readActiveCount(groupKey: string) {
    return this.activeCountByGroup.get(groupKey) ?? 0;
  }

  private incrementActiveCount(groupKey: string) {
    this.activeCountByGroup.set(
      groupKey,
      this.readActiveCount(groupKey) + 1
    );
  }

  private decrementActiveCount(groupKey: string) {
    const next = Math.max(0, this.readActiveCount(groupKey) - 1);
    if (next === 0) {
      this.activeCountByGroup.delete(groupKey);
    } else {
      this.activeCountByGroup.set(groupKey, next);
    }
  }
}

export function formatRuntimeInferenceSharedAdmissionForTrace(
  receipt: RuntimeInferenceSharedAdmissionReceipt | undefined
) {
  return {
    runtimeInferenceSharedAdmissionWaitMs: receipt?.waitMs,
    runtimeInferenceSharedEligibleAt: receipt?.eligibleAt,
    runtimeInferenceSharedQueueDepthAtEnqueue:
      receipt?.queueDepthAtEnqueue,
    runtimeInferenceSharedQueueDepthAtAdmission:
      receipt?.queueDepthAtAdmission,
    runtimeInferenceSharedActiveAtAdmission:
      receipt?.activeCountAtAdmission,
    runtimeInferenceSharedMaxConcurrent: receipt?.maxConcurrent,
    runtimeInferenceSharedAdmissionLane: receipt?.lane,
    runtimeInferenceSharedAdmissionProviderTier: receipt?.providerTier,
    runtimeInferenceSharedAdmissionProviderGroupKey:
      receipt?.providerGroupKey,
  };
}

const SYSTEM_ADMISSION_CLOCK: RuntimeInferenceAdmissionClock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function createAbortError() {
  const error = new Error("Runtime inference provider admission aborted.");
  error.name = "AbortError";
  return error;
}
