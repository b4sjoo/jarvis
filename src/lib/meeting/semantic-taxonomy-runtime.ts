import {
  SEMANTIC_TAXONOMY_MODEL,
  SEMANTIC_TAXONOMY_MODEL_VERSION,
} from "./semantic-taxonomy-model.js";
import type {
  SemanticTaxonomyEmbeddingInput,
  SemanticTaxonomyRuntimeIdentity,
  SemanticTaxonomyWorkerRequest,
  SemanticTaxonomyWorkerResponse,
} from "./semantic-taxonomy-runtime.protocol.js";

export type SemanticTaxonomyReadiness =
  | "idle"
  | "warming"
  | "ready"
  | "failed"
  | "disposed"
  | "unavailable";

export type SemanticEmbeddingConsumer =
  | "interviewer-intent"
  | "answer-sufficiency"
  | "advisor-response-consistency"
  | "benchmark"
  | "unspecified";

export type SemanticEmbeddingRuntimeOutcome =
  | "queued"
  | "started"
  | "success"
  | "cache-hit"
  | "timeout"
  | "stale"
  | "coalesced"
  | "abandoned"
  | "cancelled"
  | "recycled"
  | "error"
  | "unavailable";

export interface SemanticEmbeddingRuntimeTelemetry {
  requestId: string;
  event:
    | "queued"
    | "started"
    | "settled"
    | "late-result"
    | "cancelled"
    | "recycled";
  consumer: SemanticEmbeddingConsumer;
  coalescingKey: string;
  revision: number;
  outcome: SemanticEmbeddingRuntimeOutcome;
  queueWaitMs: number;
  computeMs?: number;
  totalMs: number;
  deadlineProfile: "cold" | "warm" | "cache";
  deadlinePhase?: "queue" | "compute";
  deadlineMs?: number;
  coalesced: boolean;
  stale: boolean;
  abandoned: boolean;
  cacheHit: boolean;
  queueDepth: number;
  maxQueueDepth: number;
  reason?: string;
}

export interface SemanticEmbeddingDeadlinePolicy {
  coldQueueWaitMs: number;
  warmQueueWaitMs: number;
  coldComputeMs: number;
  warmComputeMs: number;
}

export interface SemanticTaxonomyEmbeddingSchedule {
  consumer: SemanticEmbeddingConsumer;
  coalescingKey: string;
  revision: number;
  priority?: number;
  deadlines?: Partial<SemanticEmbeddingDeadlinePolicy>;
  onTelemetry?: (telemetry: SemanticEmbeddingRuntimeTelemetry) => void;
}

export type SemanticTaxonomyEmbeddingResult =
  | {
      status: "success";
      input: SemanticTaxonomyEmbeddingInput;
      embeddings: number[][];
      durationMs: number;
      modelVersion: string;
      cacheHit: boolean;
      telemetry: SemanticEmbeddingRuntimeTelemetry;
    }
  | {
      status: "unavailable" | "timeout" | "stale" | "error";
      input: SemanticTaxonomyEmbeddingInput;
      reason: string;
      durationMs: number;
      modelVersion: string;
      cacheHit: false;
      telemetry: SemanticEmbeddingRuntimeTelemetry;
    };

export interface SemanticTaxonomyRuntimeSnapshot {
  readiness: SemanticTaxonomyReadiness;
  modelVersion: string;
  sessionId?: string;
  runtimeEpoch?: number;
  pinnedReason?: string;
  warmupStartedAt?: number;
  readyAt?: number;
  warmupDurationMs?: number;
  disposedReason?: string;
  coldFallbackCount: number;
  reusedAfterAudioRecovery: boolean;
  queueDepth: number;
  maxQueueDepth: number;
  activeConsumer?: SemanticEmbeddingConsumer;
  coalescedCount: number;
  staleCount: number;
  timeoutCount: number;
  abandonedCount: number;
  error?: string;
}

export interface SemanticTaxonomyWorkerLike {
  onmessage:
    | ((event: MessageEvent<SemanticTaxonomyWorkerResponse>) => void)
    | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: SemanticTaxonomyWorkerRequest): void;
  terminate(): void;
}

interface PendingControlRequest {
  kind: "initialize" | "dispose";
  startedAt: number;
  timeoutId?: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface ScheduledEmbeddingRequest {
  requestId: string;
  sequence: number;
  input: SemanticTaxonomyEmbeddingInput;
  schedule: Required<
    Pick<
      SemanticTaxonomyEmbeddingSchedule,
      "consumer" | "coalescingKey" | "revision" | "priority"
    >
  > &
    Pick<SemanticTaxonomyEmbeddingSchedule, "onTelemetry"> & {
      deadlines: SemanticEmbeddingDeadlinePolicy;
    };
  enqueuedAt: number;
  startedAt?: number;
  callerSettled: boolean;
  abandoned: boolean;
  stale: boolean;
  coalesced: boolean;
  deadlineProfile?: "cold" | "warm";
  computeDeadlineMs?: number;
  queueTimeoutId?: ReturnType<typeof setTimeout>;
  computeTimeoutId?: ReturnType<typeof setTimeout>;
  hardStallTimeoutId?: ReturnType<typeof setTimeout>;
  resolve: (value: SemanticTaxonomyEmbeddingResult) => void;
}

export interface SemanticTaxonomyRuntimeOptions {
  workerFactory?: () => SemanticTaxonomyWorkerLike;
  now?: () => number;
  idleGraceMs?: number;
  warmupTimeoutMs?: number;
  maxQueuedRequests?: number;
  deadlinePolicy?: Partial<SemanticEmbeddingDeadlinePolicy>;
  hardStallGraceMs?: number;
}

const DEFAULT_IDLE_GRACE_MS = 10 * 60_000;
const DEFAULT_WARMUP_TIMEOUT_MS = 90_000;
const MAX_EMBEDDING_CACHE_ENTRIES = 256;
const DEFAULT_MAX_QUEUED_REQUESTS = 6;
const DEFAULT_HARD_STALL_GRACE_MS = 5_000;
const DEFAULT_DEADLINE_POLICY: SemanticEmbeddingDeadlinePolicy = {
  coldQueueWaitMs: 5_000,
  warmQueueWaitMs: 1_200,
  coldComputeMs: 2_500,
  warmComputeMs: 350,
};

export class SemanticTaxonomyRuntime {
  private worker?: SemanticTaxonomyWorkerLike;
  private pendingControls = new Map<string, PendingControlRequest>();
  private activeCompute?: ScheduledEmbeddingRequest;
  private queuedComputes = new Map<string, ScheduledEmbeddingRequest>();
  private initializePromise?: Promise<SemanticTaxonomyRuntimeSnapshot>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private requestSequence = 0;
  private workerGeneration = 0;
  private embeddingCache = new Map<string, number[][]>();
  private latestRevisionByKey = new Map<string, number>();
  private activeIdentity?: SemanticTaxonomyRuntimeIdentity;
  private hasCompletedCompute = false;
  private snapshot: SemanticTaxonomyRuntimeSnapshot = {
    readiness: typeof Worker === "undefined" ? "unavailable" : "idle",
    modelVersion: SEMANTIC_TAXONOMY_MODEL_VERSION,
    coldFallbackCount: 0,
    reusedAfterAudioRecovery: false,
    queueDepth: 0,
    maxQueueDepth: 0,
    coalescedCount: 0,
    staleCount: 0,
    timeoutCount: 0,
    abandonedCount: 0,
  };

  private readonly workerFactory: () => SemanticTaxonomyWorkerLike;
  private readonly now: () => number;
  private readonly idleGraceMs: number;
  private readonly warmupTimeoutMs: number;
  private readonly maxQueuedRequests: number;
  private readonly deadlinePolicy: SemanticEmbeddingDeadlinePolicy;
  private readonly hardStallGraceMs: number;

  constructor(options: SemanticTaxonomyRuntimeOptions = {}) {
    this.workerFactory =
      options.workerFactory ??
      (() =>
        new Worker(
          new URL("./taxonomy-embedding.worker.ts", import.meta.url),
          { type: "module", name: "jarvis-semantic-taxonomy" }
        ));
    this.now = options.now ?? (() => Date.now());
    this.idleGraceMs = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
    this.warmupTimeoutMs =
      options.warmupTimeoutMs ?? DEFAULT_WARMUP_TIMEOUT_MS;
    this.maxQueuedRequests =
      options.maxQueuedRequests ?? DEFAULT_MAX_QUEUED_REQUESTS;
    this.hardStallGraceMs =
      options.hardStallGraceMs ?? DEFAULT_HARD_STALL_GRACE_MS;
    this.deadlinePolicy = {
      ...DEFAULT_DEADLINE_POLICY,
      ...options.deadlinePolicy,
    };
    if (options.workerFactory && this.snapshot.readiness === "unavailable") {
      this.snapshot.readiness = "idle";
    }
  }

  readiness() {
    return this.snapshot.readiness;
  }

  getSnapshot(): SemanticTaxonomyRuntimeSnapshot {
    return { ...this.snapshot };
  }

  pinSession(
    identity: SemanticTaxonomyRuntimeIdentity,
    pinnedReason = "meeting-session"
  ) {
    this.clearIdleTimer();
    const changed =
      this.activeIdentity?.sessionId !== identity.sessionId ||
      this.activeIdentity.runtimeEpoch !== identity.runtimeEpoch;
    this.activeIdentity = { ...identity };
    this.snapshot = {
      ...this.snapshot,
      sessionId: identity.sessionId,
      runtimeEpoch: identity.runtimeEpoch,
      pinnedReason,
      disposedReason: undefined,
      reusedAfterAudioRecovery:
        this.snapshot.readiness === "ready" &&
        /recover|resume|fatal|circuit/i.test(pinnedReason),
    };
    if (changed) this.invalidateStaleEmbeddingRequests();
  }

  releaseSession({
    recoveryTokenActive,
    reason = "meeting-session-ended",
  }: {
    recoveryTokenActive: boolean;
    reason?: string;
  }) {
    if (recoveryTokenActive) {
      this.snapshot = {
        ...this.snapshot,
        pinnedReason: "native-audio-recovery-token",
      };
      return;
    }
    this.snapshot = { ...this.snapshot, pinnedReason: undefined };
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.dispose(`idle-grace:${reason}`);
    }, this.idleGraceMs);
  }

  async prewarm(): Promise<SemanticTaxonomyRuntimeSnapshot> {
    if (this.snapshot.readiness === "ready") {
      this.pumpQueue();
      return this.getSnapshot();
    }
    if (this.initializePromise) return this.initializePromise;
    if (this.snapshot.readiness === "unavailable") return this.getSnapshot();

    this.initializePromise = this.initialize();
    try {
      const snapshot = await this.initializePromise;
      this.pumpQueue();
      return snapshot;
    } finally {
      this.initializePromise = undefined;
    }
  }

  embed(
    input: SemanticTaxonomyEmbeddingInput,
    schedule: SemanticTaxonomyEmbeddingSchedule
  ): Promise<SemanticTaxonomyEmbeddingResult> {
    const requestId = this.nextRequestId("embed");
    const enqueuedAt = this.now();
    const normalizedSchedule = this.normalizeSchedule(schedule);

    if (this.snapshot.readiness === "unavailable") {
      this.snapshot = {
        ...this.snapshot,
        coldFallbackCount: this.snapshot.coldFallbackCount + 1,
      };
      return Promise.resolve(
        this.immediateFailureResult({
          requestId,
          input,
          schedule: normalizedSchedule,
          status: "unavailable",
          outcome: "unavailable",
          reason: `runtime-${this.snapshot.readiness}`,
          enqueuedAt,
        })
      );
    }
    if (!this.matchesActiveIdentity(input)) {
      return Promise.resolve(
        this.immediateFailureResult({
          requestId,
          input,
          schedule: normalizedSchedule,
          status: "stale",
          outcome: "stale",
          reason: "runtime-identity-mismatch",
          enqueuedAt,
          stale: true,
        })
      );
    }

    const key = schedulerKey(normalizedSchedule);
    const latestRevision = this.latestRevisionByKey.get(key);
    if (
      latestRevision !== undefined &&
      normalizedSchedule.revision <= latestRevision
    ) {
      return Promise.resolve(
        this.immediateFailureResult({
          requestId,
          input,
          schedule: normalizedSchedule,
          status: "stale",
          outcome: "stale",
          reason: "older-or-duplicate-submitted-revision",
          enqueuedAt,
          stale: true,
        })
      );
    }
    this.latestRevisionByKey.set(key, normalizedSchedule.revision);

    const cacheKey = embeddingCacheKey(input);
    const cached = this.embeddingCache.get(cacheKey);
    if (cached) {
      this.embeddingCache.delete(cacheKey);
      this.embeddingCache.set(cacheKey, cached);
      const telemetry = this.createTelemetry({
        requestId,
        event: "settled",
        schedule: normalizedSchedule,
        outcome: "cache-hit",
        enqueuedAt,
        deadlineProfile: "cache",
        cacheHit: true,
      });
      this.emitTelemetry(normalizedSchedule, telemetry);
      return Promise.resolve({
        status: "success",
        input,
        embeddings: cached,
        durationMs: 0,
        modelVersion: SEMANTIC_TAXONOMY_MODEL_VERSION,
        cacheHit: true,
        telemetry,
      });
    }

    const result = new Promise<SemanticTaxonomyEmbeddingResult>((resolve) => {
      const request: ScheduledEmbeddingRequest = {
        requestId,
        sequence: this.requestSequence,
        input,
        schedule: normalizedSchedule,
        enqueuedAt,
        callerSettled: false,
        abandoned: false,
        stale: false,
        coalesced: false,
        resolve,
      };
      this.enqueueCompute(request);
    });
    if (
      this.snapshot.readiness === "idle" ||
      this.snapshot.readiness === "disposed" ||
      this.snapshot.readiness === "failed"
    ) {
      void this.prewarm();
    }
    return result;
  }

  async dispose(reason = "explicit-dispose") {
    this.clearIdleTimer();
    const worker = this.worker;
    this.workerGeneration += 1;
    this.activeIdentity = undefined;
    this.resolveAllEmbeddingRequests("runtime-disposed");
    this.rejectAllControls("runtime-disposed");
    if (worker) {
      const requestId = this.nextRequestId("dispose");
      worker.postMessage({ type: "dispose", requestId });
      worker.terminate();
    }
    this.worker = undefined;
    this.embeddingCache.clear();
    this.latestRevisionByKey.clear();
    this.hasCompletedCompute = false;
    this.snapshot = {
      ...this.snapshot,
      readiness: "disposed",
      sessionId: undefined,
      runtimeEpoch: undefined,
      pinnedReason: undefined,
      disposedReason: reason,
      queueDepth: 0,
      activeConsumer: undefined,
    };
  }

  private async initialize() {
    const warmupStartedAt = this.now();
    let generation: number | undefined;
    this.snapshot = {
      ...this.snapshot,
      readiness: "warming",
      warmupStartedAt,
      error: undefined,
    };
    try {
      const worker = this.workerFactory();
      generation = this.workerGeneration + 1;
      this.workerGeneration = generation;
      this.worker = worker;
      this.hasCompletedCompute = false;
      worker.onmessage = (event) => {
        if (
          generation !== this.workerGeneration ||
          this.worker !== worker
        ) {
          return;
        }
        this.handleWorkerMessage(event.data);
      };
      worker.onerror = (event) => {
        if (
          generation !== this.workerGeneration ||
          this.worker !== worker
        ) {
          return;
        }
        this.failRuntime(
          event.message || "semantic worker failed",
          generation
        );
      };
      const requestId = this.nextRequestId("initialize");
      await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          this.pendingControls.delete(requestId);
          reject(new Error("Semantic taxonomy warmup timed out"));
        }, this.warmupTimeoutMs);
        this.pendingControls.set(requestId, {
          kind: "initialize",
          startedAt: warmupStartedAt,
          timeoutId,
          resolve,
          reject,
        });
        worker.postMessage({
          type: "initialize",
          requestId,
          model: SEMANTIC_TAXONOMY_MODEL,
        });
      });
      return this.getSnapshot();
    } catch (error) {
      if (
        (generation !== undefined &&
          generation !== this.workerGeneration) ||
        this.snapshot.readiness === "disposed"
      ) {
        return this.getSnapshot();
      }
      this.failRuntime(
        error instanceof Error ? error.message : String(error),
        generation
      );
      return this.getSnapshot();
    }
  }

  private handleWorkerMessage(message: SemanticTaxonomyWorkerResponse) {
    if (
      message.type === "embedding" ||
      (message.type === "error" &&
        this.activeCompute?.requestId === message.requestId)
    ) {
      this.handleComputeResponse(message);
      return;
    }

    const pending = this.pendingControls.get(message.requestId);
    if (!pending) return;
    this.pendingControls.delete(message.requestId);
    if (pending.timeoutId) clearTimeout(pending.timeoutId);

    if (message.type === "error") {
      pending.reject(new Error(message.message));
      if (pending.kind === "initialize") this.failRuntime(message.message);
      return;
    }

    if (message.type === "ready") {
      const readyAt = this.now();
      this.snapshot = {
        ...this.snapshot,
        readiness: "ready",
        readyAt,
        warmupDurationMs: readyAt - (this.snapshot.warmupStartedAt ?? readyAt),
        error: undefined,
      };
      pending.resolve();
      this.pumpQueue();
      return;
    }

    pending.resolve();
  }

  private failRuntime(message: string, expectedGeneration?: number) {
    if (
      expectedGeneration !== undefined &&
      expectedGeneration !== this.workerGeneration
    ) {
      return;
    }
    this.workerGeneration += 1;
    this.worker?.terminate();
    this.worker = undefined;
    this.hasCompletedCompute = false;
    this.resolveAllEmbeddingRequests(message, "error");
    this.rejectAllControls(message);
    this.snapshot = {
      ...this.snapshot,
      readiness: "failed",
      queueDepth: 0,
      activeConsumer: undefined,
      error: message,
    };
  }

  private normalizeSchedule(
    schedule: SemanticTaxonomyEmbeddingSchedule
  ): ScheduledEmbeddingRequest["schedule"] {
    return {
      consumer: schedule.consumer,
      coalescingKey: schedule.coalescingKey,
      revision: schedule.revision,
      priority:
        schedule.priority ?? defaultConsumerPriority(schedule.consumer),
      deadlines: {
        ...this.deadlinePolicy,
        ...schedule.deadlines,
      },
      onTelemetry: schedule.onTelemetry,
    };
  }

  private enqueueCompute(request: ScheduledEmbeddingRequest) {
    const key = schedulerKey(request.schedule);
    const active = this.activeCompute;
    if (active && schedulerKey(active.schedule) === key) {
      if (request.schedule.revision <= active.schedule.revision) {
        request.stale = true;
        this.settleFailure({
          request,
          status: "stale",
          outcome: "stale",
          reason: "older-or-duplicate-active-revision",
          deadlineProfile: this.queueDeadlineProfile(),
        });
        return;
      }
      this.markActiveAbandoned(
        active,
        "superseded-by-newer-revision",
        true
      );
    }

    const queued = this.queuedComputes.get(key);
    if (queued) {
      if (request.schedule.revision <= queued.schedule.revision) {
        request.stale = true;
        this.settleFailure({
          request,
          status: "stale",
          outcome: "stale",
          reason: "older-or-duplicate-queued-revision",
          deadlineProfile: this.queueDeadlineProfile(),
        });
        return;
      }
      this.removeQueuedRequest(queued);
      queued.coalesced = true;
      queued.stale = true;
      this.settleFailure({
        request: queued,
        status: "stale",
        outcome: "coalesced",
        reason: "coalesced-by-newer-revision",
        deadlineProfile: this.queueDeadlineProfile(),
        deadlinePhase: "queue",
        deadlineMs: this.queueDeadlineMs(queued),
      });
    }

    if (!this.admitWithinBackpressure(request)) return;

    this.queuedComputes.set(key, request);
    const deadlineProfile = this.queueDeadlineProfile();
    const deadlineMs = this.queueDeadlineMs(request);
    request.queueTimeoutId = setTimeout(() => {
      if (this.queuedComputes.get(key) !== request) return;
      this.removeQueuedRequest(request);
      request.abandoned = true;
      this.settleFailure({
        request,
        status: "timeout",
        outcome: "timeout",
        reason: "semantic-embedding-queue-timeout",
        deadlineProfile,
        deadlinePhase: "queue",
        deadlineMs,
      });
      this.pumpQueue();
    }, deadlineMs);
    this.updateQueueSnapshot();
    this.emitTelemetry(
      request.schedule,
      this.createTelemetry({
        requestId: request.requestId,
        event: "queued",
        schedule: request.schedule,
        outcome: "queued",
        enqueuedAt: request.enqueuedAt,
        deadlineProfile,
        deadlinePhase: "queue",
        deadlineMs,
      })
    );
    this.pumpQueue();
  }

  private admitWithinBackpressure(request: ScheduledEmbeddingRequest) {
    if (this.queuedComputes.size < this.maxQueuedRequests) return true;
    const victim = Array.from(this.queuedComputes.values()).sort(
      (left, right) =>
        right.schedule.priority - left.schedule.priority ||
        left.sequence - right.sequence
    )[0];
    if (
      !victim ||
      victim.schedule.priority < request.schedule.priority
    ) {
      request.stale = true;
      this.settleFailure({
        request,
        status: "stale",
        outcome: "stale",
        reason: "semantic-embedding-backpressure-rejected",
        deadlineProfile: this.queueDeadlineProfile(),
        deadlinePhase: "queue",
        deadlineMs: this.queueDeadlineMs(request),
      });
      return false;
    }

    this.removeQueuedRequest(victim);
    victim.stale = true;
    this.settleFailure({
      request: victim,
      status: "stale",
      outcome: "stale",
      reason: "semantic-embedding-backpressure-evicted",
      deadlineProfile: this.queueDeadlineProfile(),
      deadlinePhase: "queue",
      deadlineMs: this.queueDeadlineMs(victim),
    });
    return true;
  }

  private pumpQueue() {
    if (
      this.activeCompute ||
      this.snapshot.readiness !== "ready" ||
      !this.worker
    ) {
      return;
    }

    while (this.queuedComputes.size > 0) {
      const next = Array.from(this.queuedComputes.values()).sort(
        (left, right) =>
          left.schedule.priority - right.schedule.priority ||
          left.sequence - right.sequence
      )[0];
      if (!next) return;
      this.removeQueuedRequest(next);
      if (!this.matchesActiveIdentity(next.input)) {
        next.stale = true;
        this.settleFailure({
          request: next,
          status: "stale",
          outcome: "stale",
          reason: "runtime-identity-mismatch-before-compute",
          deadlineProfile: this.queueDeadlineProfile(),
        });
        continue;
      }
      this.startCompute(next);
      return;
    }
  }

  private startCompute(request: ScheduledEmbeddingRequest) {
    const worker = this.worker;
    if (!worker || this.snapshot.readiness !== "ready") {
      this.queuedComputes.set(schedulerKey(request.schedule), request);
      this.updateQueueSnapshot();
      return;
    }

    request.startedAt = this.now();
    request.deadlineProfile = this.hasCompletedCompute ? "warm" : "cold";
    request.computeDeadlineMs =
      request.deadlineProfile === "cold"
        ? request.schedule.deadlines.coldComputeMs
        : request.schedule.deadlines.warmComputeMs;
    this.activeCompute = request;
    this.snapshot = {
      ...this.snapshot,
      activeConsumer: request.schedule.consumer,
    };
    this.emitTelemetry(
      request.schedule,
      this.createTelemetry({
        requestId: request.requestId,
        event: "started",
        schedule: request.schedule,
        outcome: "started",
        enqueuedAt: request.enqueuedAt,
        startedAt: request.startedAt,
        deadlineProfile: request.deadlineProfile,
        deadlinePhase: "compute",
        deadlineMs: request.computeDeadlineMs,
      })
    );
    request.computeTimeoutId = setTimeout(() => {
      if (
        this.activeCompute !== request ||
        request.callerSettled
      ) {
        return;
      }
      request.abandoned = true;
      this.settleFailure({
        request,
        status: "timeout",
        outcome: "timeout",
        reason: "semantic-embedding-compute-timeout",
        deadlineProfile: request.deadlineProfile ?? "warm",
        deadlinePhase: "compute",
        deadlineMs: request.computeDeadlineMs,
        computeMs: this.now() - (request.startedAt ?? this.now()),
      });
      this.armHardStallWatchdog(
        request,
        "compute-timeout-without-worker-settlement"
      );
    }, request.computeDeadlineMs);
    try {
      worker.postMessage({
        type: "embed",
        requestId: request.requestId,
        input: request.input,
      });
    } catch (error) {
      if (request.computeTimeoutId) clearTimeout(request.computeTimeoutId);
      request.computeTimeoutId = undefined;
      this.settleFailure({
        request,
        status: "error",
        outcome: "error",
        reason: error instanceof Error ? error.message : String(error),
        deadlineProfile: request.deadlineProfile,
        deadlinePhase: "compute",
        deadlineMs: request.computeDeadlineMs,
        computeMs: Math.max(0, this.now() - request.startedAt),
      });
      this.finishActiveCompute(request);
    }
  }

  private handleComputeResponse(
    message: Extract<
      SemanticTaxonomyWorkerResponse,
      { type: "embedding" | "error" }
    >
  ) {
    const request = this.activeCompute;
    if (!request || request.requestId !== message.requestId) return;
    if (request.computeTimeoutId) clearTimeout(request.computeTimeoutId);
    request.computeTimeoutId = undefined;
    if (request.hardStallTimeoutId) {
      clearTimeout(request.hardStallTimeoutId);
    }
    request.hardStallTimeoutId = undefined;

    const computeMs =
      message.type === "embedding"
        ? message.durationMs
        : Math.max(0, this.now() - (request.startedAt ?? this.now()));
    if (message.type === "embedding") this.hasCompletedCompute = true;

    const identityStale =
      message.type === "embedding" &&
      (!this.matchesActiveIdentity(message.input) ||
        message.input.turnId !== request.input.turnId);
    if (identityStale) {
      request.stale = true;
      request.abandoned = true;
      if (!request.callerSettled) {
        this.settleFailure({
          request,
          status: "stale",
          outcome: "stale",
          reason: "stale-semantic-worker-result",
          deadlineProfile: request.deadlineProfile ?? "warm",
          deadlinePhase: "compute",
          deadlineMs: request.computeDeadlineMs,
          computeMs,
        });
      } else {
        this.emitLateAbandoned(
          request,
          computeMs,
          "stale-semantic-worker-result"
        );
      }
      this.finishActiveCompute(request);
      return;
    }

    if (message.type === "error") {
      if (!request.callerSettled) {
        this.settleFailure({
          request,
          status: "error",
          outcome: "error",
          reason: message.message,
          deadlineProfile: request.deadlineProfile ?? "warm",
          deadlinePhase: "compute",
          deadlineMs: request.computeDeadlineMs,
          computeMs,
        });
      } else {
        this.emitLateAbandoned(request, computeMs, message.message);
      }
      this.finishActiveCompute(request);
      return;
    }

    if (request.callerSettled || request.abandoned) {
      if (this.matchesActiveIdentity(request.input)) {
        this.cacheEmbedding(request.input, message.embeddings);
      }
      this.emitLateAbandoned(
        request,
        computeMs,
        request.stale
          ? "stale-compute-completed"
          : "timed-out-compute-completed"
      );
      this.finishActiveCompute(request);
      return;
    }

    this.cacheEmbedding(request.input, message.embeddings);
    const telemetry = this.createTelemetry({
      requestId: request.requestId,
      event: "settled",
      schedule: request.schedule,
      outcome: "success",
      enqueuedAt: request.enqueuedAt,
      startedAt: request.startedAt,
      computeMs,
      deadlineProfile: request.deadlineProfile ?? "warm",
      deadlinePhase: "compute",
      deadlineMs: request.computeDeadlineMs,
    });
    this.settleCaller(request, {
      status: "success",
      input: request.input,
      embeddings: message.embeddings,
      durationMs: telemetry.totalMs,
      modelVersion: SEMANTIC_TAXONOMY_MODEL_VERSION,
      cacheHit: false,
      telemetry,
    });
    this.emitTelemetry(request.schedule, telemetry);
    this.finishActiveCompute(request);
  }

  private markActiveAbandoned(
    request: ScheduledEmbeddingRequest,
    reason: string,
    coalesced: boolean
  ) {
    if (request.callerSettled) return;
    if (request.computeTimeoutId) clearTimeout(request.computeTimeoutId);
    request.computeTimeoutId = undefined;
    request.abandoned = true;
    request.stale = true;
    request.coalesced = coalesced;
    this.settleFailure({
      request,
      status: "stale",
      outcome: coalesced ? "coalesced" : "stale",
      reason,
      deadlineProfile: request.deadlineProfile ?? "warm",
      deadlinePhase: "compute",
      deadlineMs: request.computeDeadlineMs,
      computeMs: Math.max(
        0,
        this.now() - (request.startedAt ?? this.now())
      ),
    });
    this.armHardStallWatchdog(request, reason);
  }

  private emitLateAbandoned(
    request: ScheduledEmbeddingRequest,
    computeMs: number,
    reason: string
  ) {
    const telemetry = this.createTelemetry({
      requestId: request.requestId,
      event: "late-result",
      schedule: request.schedule,
      outcome: "abandoned",
      enqueuedAt: request.enqueuedAt,
      startedAt: request.startedAt,
      computeMs,
      deadlineProfile: request.deadlineProfile ?? "warm",
      deadlinePhase: "compute",
      deadlineMs: request.computeDeadlineMs,
      coalesced: request.coalesced,
      stale: request.stale,
      abandoned: true,
      reason,
    });
    this.emitTelemetry(request.schedule, telemetry);
  }

  private emitRuntimeTerminationEvent({
    request,
    event,
    outcome,
    reason,
  }: {
    request: ScheduledEmbeddingRequest;
    event: "cancelled" | "recycled";
    outcome: "cancelled" | "recycled";
    reason: string;
  }) {
    const telemetry = this.createTelemetry({
      requestId: request.requestId,
      event,
      schedule: request.schedule,
      outcome,
      enqueuedAt: request.enqueuedAt,
      startedAt: request.startedAt,
      computeMs: Math.max(
        0,
        this.now() - (request.startedAt ?? this.now())
      ),
      deadlineProfile: request.deadlineProfile ?? "warm",
      deadlinePhase: "compute",
      deadlineMs: request.computeDeadlineMs,
      coalesced: request.coalesced,
      stale: request.stale,
      abandoned: request.abandoned,
      reason,
    });
    this.emitTelemetry(request.schedule, telemetry);
  }

  private finishActiveCompute(request: ScheduledEmbeddingRequest) {
    if (this.activeCompute !== request) return;
    if (request.computeTimeoutId) clearTimeout(request.computeTimeoutId);
    request.computeTimeoutId = undefined;
    if (request.hardStallTimeoutId) {
      clearTimeout(request.hardStallTimeoutId);
    }
    request.hardStallTimeoutId = undefined;
    this.activeCompute = undefined;
    this.snapshot = {
      ...this.snapshot,
      activeConsumer: undefined,
    };
    this.pumpQueue();
  }

  private armHardStallWatchdog(
    request: ScheduledEmbeddingRequest,
    reason: string
  ) {
    if (
      this.activeCompute !== request ||
      request.hardStallTimeoutId
    ) {
      return;
    }
    request.hardStallTimeoutId = setTimeout(() => {
      request.hardStallTimeoutId = undefined;
      if (this.activeCompute !== request) return;
      this.recycleHardStalledWorker(request, reason);
    }, this.hardStallGraceMs);
  }

  private recycleHardStalledWorker(
    request: ScheduledEmbeddingRequest,
    reason: string
  ) {
    if (this.activeCompute !== request) return;
    const worker = this.worker;
    this.workerGeneration += 1;
    this.worker = undefined;
    this.hasCompletedCompute = false;
    if (request.computeTimeoutId) clearTimeout(request.computeTimeoutId);
    request.computeTimeoutId = undefined;
    if (request.hardStallTimeoutId) {
      clearTimeout(request.hardStallTimeoutId);
    }
    request.hardStallTimeoutId = undefined;
    request.abandoned = true;
    this.emitRuntimeTerminationEvent({
      request,
      event: "recycled",
      outcome: "recycled",
      reason: `semantic-worker-hard-stall:${reason}`,
    });
    this.activeCompute = undefined;
    worker?.terminate();
    this.snapshot = {
      ...this.snapshot,
      readiness: "idle",
      activeConsumer: undefined,
      error: undefined,
    };
    void this.prewarm();
  }

  private settleFailure({
    request,
    status,
    outcome,
    reason,
    deadlineProfile,
    deadlinePhase,
    deadlineMs,
    computeMs,
  }: {
    request: ScheduledEmbeddingRequest;
    status: Exclude<SemanticTaxonomyEmbeddingResult["status"], "success">;
    outcome: SemanticEmbeddingRuntimeOutcome;
    reason: string;
    deadlineProfile: "cold" | "warm";
    deadlinePhase?: "queue" | "compute";
    deadlineMs?: number;
    computeMs?: number;
  }) {
    if (request.callerSettled) return;
    const telemetry = this.createTelemetry({
      requestId: request.requestId,
      event: "settled",
      schedule: request.schedule,
      outcome,
      enqueuedAt: request.enqueuedAt,
      startedAt: request.startedAt,
      computeMs,
      deadlineProfile,
      deadlinePhase,
      deadlineMs,
      coalesced: request.coalesced || outcome === "coalesced",
      stale: request.stale || status === "stale",
      abandoned: request.abandoned,
      reason,
    });
    this.settleCaller(request, {
      status,
      input: request.input,
      reason,
      durationMs: telemetry.totalMs,
      modelVersion: SEMANTIC_TAXONOMY_MODEL_VERSION,
      cacheHit: false,
      telemetry,
    });
    this.emitTelemetry(request.schedule, telemetry);
  }

  private settleCaller(
    request: ScheduledEmbeddingRequest,
    result: SemanticTaxonomyEmbeddingResult
  ) {
    if (request.callerSettled) return;
    request.callerSettled = true;
    if (request.queueTimeoutId) clearTimeout(request.queueTimeoutId);
    request.queueTimeoutId = undefined;
    request.resolve(result);
  }

  private removeQueuedRequest(request: ScheduledEmbeddingRequest) {
    const key = schedulerKey(request.schedule);
    if (this.queuedComputes.get(key) === request) {
      this.queuedComputes.delete(key);
    }
    if (request.queueTimeoutId) clearTimeout(request.queueTimeoutId);
    request.queueTimeoutId = undefined;
    this.updateQueueSnapshot();
  }

  private invalidateStaleEmbeddingRequests() {
    const active = this.activeCompute;
    if (active && !this.matchesActiveIdentity(active.input)) {
      this.markActiveAbandoned(
        active,
        "session-or-epoch-changed",
        false
      );
    }
    for (const request of Array.from(this.queuedComputes.values())) {
      if (this.matchesActiveIdentity(request.input)) continue;
      this.removeQueuedRequest(request);
      request.stale = true;
      this.settleFailure({
        request,
        status: "stale",
        outcome: "stale",
        reason: "session-or-epoch-changed",
        deadlineProfile: this.queueDeadlineProfile(),
      });
    }
  }

  private resolveAllEmbeddingRequests(
    reason: string,
    status: "stale" | "error" = "stale"
  ) {
    const active = this.activeCompute;
    if (active) {
      if (active.computeTimeoutId) clearTimeout(active.computeTimeoutId);
      active.computeTimeoutId = undefined;
      if (active.hardStallTimeoutId) {
        clearTimeout(active.hardStallTimeoutId);
      }
      active.hardStallTimeoutId = undefined;
      active.abandoned = true;
      active.stale = status === "stale";
      if (!active.callerSettled) {
        this.settleFailure({
          request: active,
          status,
          outcome: status,
          reason,
          deadlineProfile: active.deadlineProfile ?? "warm",
          deadlinePhase: "compute",
          deadlineMs: active.computeDeadlineMs,
          computeMs: Math.max(
            0,
            this.now() - (active.startedAt ?? this.now())
          ),
        });
      } else {
        this.emitRuntimeTerminationEvent({
          request: active,
          event: "cancelled",
          outcome: "cancelled",
          reason,
        });
      }
    }
    this.activeCompute = undefined;
    for (const request of Array.from(this.queuedComputes.values())) {
      this.removeQueuedRequest(request);
      request.abandoned = true;
      request.stale = status === "stale";
      this.settleFailure({
        request,
        status,
        outcome: status,
        reason,
        deadlineProfile: this.queueDeadlineProfile(),
      });
    }
    this.updateQueueSnapshot();
  }

  private rejectAllControls(reason: string) {
    for (const [requestId, pending] of this.pendingControls) {
      this.pendingControls.delete(requestId);
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      pending.reject(new Error(reason));
    }
  }

  private immediateFailureResult({
    requestId,
    input,
    schedule,
    status,
    outcome,
    reason,
    enqueuedAt,
    stale = false,
  }: {
    requestId: string;
    input: SemanticTaxonomyEmbeddingInput;
    schedule: ScheduledEmbeddingRequest["schedule"];
    status: Exclude<SemanticTaxonomyEmbeddingResult["status"], "success">;
    outcome: SemanticEmbeddingRuntimeOutcome;
    reason: string;
    enqueuedAt: number;
    stale?: boolean;
  }): SemanticTaxonomyEmbeddingResult {
    const telemetry = this.createTelemetry({
      requestId,
      event: "settled",
      schedule,
      outcome,
      enqueuedAt,
      deadlineProfile: "warm",
      stale,
      reason,
    });
    this.emitTelemetry(schedule, telemetry);
    return {
      status,
      input,
      reason,
      durationMs: telemetry.totalMs,
      modelVersion: SEMANTIC_TAXONOMY_MODEL_VERSION,
      cacheHit: false,
      telemetry,
    };
  }

  private createTelemetry({
    requestId,
    event,
    schedule,
    outcome,
    enqueuedAt,
    startedAt,
    computeMs,
    deadlineProfile,
    deadlinePhase,
    deadlineMs,
    coalesced = false,
    stale = false,
    abandoned = false,
    cacheHit = false,
    reason,
  }: {
    requestId: string;
    event: SemanticEmbeddingRuntimeTelemetry["event"];
    schedule: ScheduledEmbeddingRequest["schedule"];
    outcome: SemanticEmbeddingRuntimeOutcome;
    enqueuedAt: number;
    startedAt?: number;
    computeMs?: number;
    deadlineProfile: SemanticEmbeddingRuntimeTelemetry["deadlineProfile"];
    deadlinePhase?: SemanticEmbeddingRuntimeTelemetry["deadlinePhase"];
    deadlineMs?: number;
    coalesced?: boolean;
    stale?: boolean;
    abandoned?: boolean;
    cacheHit?: boolean;
    reason?: string;
  }): SemanticEmbeddingRuntimeTelemetry {
    const now = this.now();
    return {
      requestId,
      event,
      consumer: schedule.consumer,
      coalescingKey: schedule.coalescingKey,
      revision: schedule.revision,
      outcome,
      queueWaitMs: Math.max(
        0,
        (startedAt ?? now) - enqueuedAt
      ),
      computeMs,
      totalMs: Math.max(0, now - enqueuedAt),
      deadlineProfile,
      deadlinePhase,
      deadlineMs,
      coalesced,
      stale,
      abandoned,
      cacheHit,
      queueDepth: this.queuedComputes.size,
      maxQueueDepth: Math.max(
        this.snapshot.maxQueueDepth,
        this.queuedComputes.size
      ),
      reason,
    };
  }

  private emitTelemetry(
    schedule: ScheduledEmbeddingRequest["schedule"],
    telemetry: SemanticEmbeddingRuntimeTelemetry
  ) {
    if (
      telemetry.event === "settled" ||
      telemetry.event === "late-result"
    ) {
      this.snapshot = {
        ...this.snapshot,
        coalescedCount:
          this.snapshot.coalescedCount +
          (telemetry.outcome === "coalesced" ? 1 : 0),
        staleCount:
          this.snapshot.staleCount +
          (telemetry.outcome === "stale" ? 1 : 0),
        timeoutCount:
          this.snapshot.timeoutCount +
          (telemetry.outcome === "timeout" ? 1 : 0),
        abandonedCount:
          this.snapshot.abandonedCount +
          (telemetry.outcome === "abandoned" ? 1 : 0),
      };
    }
    try {
      schedule.onTelemetry?.(telemetry);
    } catch (error) {
      console.warn("Semantic embedding telemetry callback failed", error);
    }
  }

  private queueDeadlineProfile(): "cold" | "warm" {
    return this.snapshot.readiness === "ready" && this.hasCompletedCompute
      ? "warm"
      : "cold";
  }

  private queueDeadlineMs(request: ScheduledEmbeddingRequest) {
    return this.queueDeadlineProfile() === "cold"
      ? request.schedule.deadlines.coldQueueWaitMs
      : request.schedule.deadlines.warmQueueWaitMs;
  }

  private updateQueueSnapshot() {
    this.snapshot = {
      ...this.snapshot,
      queueDepth: this.queuedComputes.size,
      maxQueueDepth: Math.max(
        this.snapshot.maxQueueDepth,
        this.queuedComputes.size
      ),
    };
  }

  private matchesActiveIdentity(input: SemanticTaxonomyRuntimeIdentity) {
    return Boolean(
      this.activeIdentity &&
        this.activeIdentity.sessionId === input.sessionId &&
        this.activeIdentity.runtimeEpoch === input.runtimeEpoch
    );
  }

  private cacheEmbedding(
    input: SemanticTaxonomyEmbeddingInput,
    embeddings: number[][]
  ) {
    const key = embeddingCacheKey(input);
    this.embeddingCache.delete(key);
    this.embeddingCache.set(key, embeddings);
    if (this.embeddingCache.size <= MAX_EMBEDDING_CACHE_ENTRIES) return;
    const oldest = this.embeddingCache.keys().next().value;
    if (oldest) this.embeddingCache.delete(oldest);
  }

  private nextRequestId(kind: string) {
    this.requestSequence += 1;
    return `semantic-taxonomy-${kind}-${this.requestSequence}`;
  }

  private clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}

export function formatSemanticEmbeddingRuntimeTelemetryForTrace(
  telemetry?: SemanticEmbeddingRuntimeTelemetry
): Record<string, unknown> {
  if (!telemetry) return {};
  return {
    semanticEmbeddingRequestId: telemetry.requestId,
    semanticEmbeddingEvent: telemetry.event,
    semanticEmbeddingConsumer: telemetry.consumer,
    semanticEmbeddingCoalescingKey: telemetry.coalescingKey,
    semanticEmbeddingRevision: telemetry.revision,
    semanticEmbeddingOutcome: telemetry.outcome,
    semanticEmbeddingQueueWaitMs: telemetry.queueWaitMs,
    semanticEmbeddingComputeMs: telemetry.computeMs,
    semanticEmbeddingTotalMs: telemetry.totalMs,
    semanticEmbeddingDeadlineProfile: telemetry.deadlineProfile,
    semanticEmbeddingDeadlinePhase: telemetry.deadlinePhase,
    semanticEmbeddingDeadlineMs: telemetry.deadlineMs,
    semanticEmbeddingCoalesced: telemetry.coalesced,
    semanticEmbeddingStale: telemetry.stale,
    semanticEmbeddingAbandoned: telemetry.abandoned,
    semanticEmbeddingCacheHit: telemetry.cacheHit,
    semanticEmbeddingQueueDepth: telemetry.queueDepth,
    semanticEmbeddingMaxQueueDepth: telemetry.maxQueueDepth,
    semanticEmbeddingReason: telemetry.reason,
  };
}

function defaultConsumerPriority(consumer: SemanticEmbeddingConsumer) {
  switch (consumer) {
    case "interviewer-intent":
      return 0;
    case "answer-sufficiency":
      return 1;
    case "benchmark":
      return 2;
    default:
      return 3;
  }
}

function schedulerKey(
  schedule: Pick<
    SemanticTaxonomyEmbeddingSchedule,
    "consumer" | "coalescingKey"
  >
) {
  return `${schedule.consumer}\u001f${schedule.coalescingKey}`;
}

function embeddingCacheKey(input: SemanticTaxonomyEmbeddingInput) {
  const normalized = input.texts
    .map((text) => text.trim().replace(/\s+/g, " ").toLocaleLowerCase())
    .join("\u001f");
  let hash = 2166136261;
  const value = `${SEMANTIC_TAXONOMY_MODEL_VERSION}\u001e${input.kind}\u001e${normalized}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${input.kind}:${(hash >>> 0).toString(16)}`;
}
