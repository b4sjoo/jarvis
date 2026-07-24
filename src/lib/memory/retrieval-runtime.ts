import type { MemoryEntry } from "./types";

export interface MemorySnapshotLoadTimings {
  databaseAcquireMs: number;
  databaseReadMs: number;
  rowMappingMs: number;
}

export interface MemorySnapshotLoadResult {
  entries: MemoryEntry[];
  timings: MemorySnapshotLoadTimings;
}

export type MemorySnapshotCacheState =
  | "hit"
  | "miss"
  | "load-coalesced"
  | "stale-while-refresh"
  | "unavailable";

export type MemorySnapshotInvalidationKind = "soft" | "hard";

export type MemoryHardInvalidationDisposition =
  | "fail-closed-until-refresh"
  | "fresh-snapshot-loaded-after-fail-closed"
  | "fail-closed-load-failed";

export interface MemorySnapshotInvalidationRequest {
  kind: MemorySnapshotInvalidationKind;
  reason: string;
  affectedEntryIds?: string[];
}

export interface MemorySnapshotReadTelemetry
  extends MemorySnapshotLoadTimings {
  cacheState: MemorySnapshotCacheState;
  cacheHit: boolean;
  cacheLookupMs: number;
  snapshotVersion: number;
  snapshotGeneration: number;
  snapshotAgeMs: number;
  snapshotSessionId?: string;
  authorityRevision: number;
  invalidationKind?: MemorySnapshotInvalidationKind;
  invalidationReason?: string;
  invalidationPreviousSnapshotVersion?: number;
  invalidationNewSnapshotVersion?: number;
  invalidationToFirstReadMs?: number;
  invalidationFirstRead?: boolean;
  hardInvalidationDisposition?: MemoryHardInvalidationDisposition;
  hardInvalidationAffectedEntryIds?: string[];
  hardInvalidationTargetsExcluded?: boolean;
  hardInvalidationStaleSnapshotServed?: boolean;
  degradedReason?: string;
}

export interface MemorySnapshotReadResult {
  entries: readonly MemoryEntry[];
  telemetry: MemorySnapshotReadTelemetry;
}

export interface MemoryUsageFlushResult {
  batchId: string;
  entryCount: number;
  durationMs: number;
  queueDepthAfter: number;
  success: boolean;
  error?: string;
}

export interface MemoryUsageEnqueueResult {
  batchId?: string;
  addedEntryCount: number;
  queueDepth: number;
  enqueueMs: number;
  lastFlush?: MemoryUsageFlushResult;
}

type MemorySnapshotLoader = () => Promise<MemorySnapshotLoadResult>;
type MemoryUsageWriter = (entryIds: string[]) => Promise<void>;
type MemoryUsageFlushListener = (result: MemoryUsageFlushResult) => void;

interface MemorySnapshot {
  entries: readonly MemoryEntry[];
  version: number;
  generation: number;
  authorityRevision: number;
  loadedAt: number;
  sessionId?: string;
}

interface PendingSnapshotLoad {
  generation: number;
  promise: Promise<MemorySnapshot | undefined>;
}

interface PendingUsageBatch {
  id: string;
  entryIds: Set<string>;
  listeners: Set<MemoryUsageFlushListener>;
}

interface MemorySnapshotInvalidationState
  extends MemorySnapshotInvalidationRequest {
  generation: number;
  authorityRevision: number;
  previousSnapshotVersion: number;
  newSnapshotVersion?: number;
  invalidatedAt: number;
  firstReadObserved: boolean;
  hardDisposition?: MemoryHardInvalidationDisposition;
}

export interface MemoryRetrievalRuntimeOptions {
  usageDebounceMs?: number;
  wallNow?: () => number;
  monotonicNow?: () => number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (handle: ReturnType<typeof setTimeout>) => void;
}

const EMPTY_LOAD_TIMINGS: MemorySnapshotLoadTimings = {
  databaseAcquireMs: 0,
  databaseReadMs: 0,
  rowMappingMs: 0,
};

export class MemoryRetrievalRuntime {
  private readonly usageDebounceMs: number;
  private readonly wallNow: () => number;
  private readonly monotonicNow: () => number;
  private readonly schedule: MemoryRetrievalRuntimeOptions["schedule"];
  private readonly cancelSchedule: MemoryRetrievalRuntimeOptions["cancelSchedule"];
  private snapshot?: MemorySnapshot;
  private pendingSnapshotLoad?: PendingSnapshotLoad;
  private snapshotLoader?: MemorySnapshotLoader;
  private snapshotGeneration = 0;
  private snapshotVersion = 0;
  private authorityRevision = 0;
  private latestInvalidation?: MemorySnapshotInvalidationState;
  private pinnedSessionId?: string;
  private usageWriter?: MemoryUsageWriter;
  private pendingUsageBatch?: PendingUsageBatch;
  private usageFlushTimer?: ReturnType<typeof setTimeout>;
  private usageFlushInFlight?: Promise<MemoryUsageFlushResult | undefined>;
  private lastUsageFlush?: MemoryUsageFlushResult;
  private usageBatchSequence = 0;

  constructor(options: MemoryRetrievalRuntimeOptions = {}) {
    this.usageDebounceMs = options.usageDebounceMs ?? 750;
    this.wallNow = options.wallNow ?? (() => Date.now());
    this.monotonicNow =
      options.monotonicNow ??
      (() =>
        typeof performance !== "undefined" ? performance.now() : Date.now());
    this.schedule =
      options.schedule ??
      ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelSchedule =
      options.cancelSchedule ??
      ((handle) => clearTimeout(handle));
  }

  async readSnapshot({
    sessionId,
    loader,
  }: {
    sessionId?: string;
    loader: MemorySnapshotLoader;
  }): Promise<MemorySnapshotReadResult> {
    const lookupStartedAt = this.monotonicNow();
    this.snapshotLoader = loader;
    this.pinnedSessionId = sessionId ?? this.pinnedSessionId;

    if (
      this.snapshot &&
      this.snapshot.generation === this.snapshotGeneration
    ) {
      return this.buildReadResult(
        this.snapshot,
        "hit",
        lookupStartedAt,
        EMPTY_LOAD_TIMINGS
      );
    }

    if (this.snapshot) {
      void this.ensureSnapshotRefresh(
        loader,
        this.pinnedSessionId
      ).promise.catch(() => undefined);
      return this.buildReadResult(
        this.snapshot,
        "stale-while-refresh",
        lookupStartedAt,
        EMPTY_LOAD_TIMINGS,
        this.latestInvalidation?.reason
          ? `refresh-pending:${this.latestInvalidation.reason}`
          : "refresh-pending"
      );
    }

    const existingLoad =
      this.pendingSnapshotLoad?.generation === this.snapshotGeneration
        ? this.pendingSnapshotLoad
        : undefined;
    const pendingLoad =
      existingLoad ??
      this.startSnapshotRefresh(loader, this.pinnedSessionId);
    const cacheState: MemorySnapshotCacheState = existingLoad
      ? "load-coalesced"
      : "miss";

    try {
      const loadedSnapshot = await pendingLoad.promise;
      if (!loadedSnapshot) {
        return this.readSnapshot({ sessionId, loader });
      }
      return this.buildReadResult(
        loadedSnapshot,
        cacheState,
        lookupStartedAt,
        loadedSnapshotLoadTimings.get(loadedSnapshot) ?? EMPTY_LOAD_TIMINGS
      );
    } catch (error) {
      const invalidationTelemetry = this.consumeInvalidationTelemetry([], {
        loadFailed: true,
      });
      return {
        entries: [],
        telemetry: {
          ...EMPTY_LOAD_TIMINGS,
          cacheState: "unavailable",
          cacheHit: false,
          cacheLookupMs: elapsedMs(lookupStartedAt, this.monotonicNow()),
          snapshotVersion: this.snapshotVersion,
          snapshotGeneration: this.snapshotGeneration,
          snapshotAgeMs: 0,
          snapshotSessionId: this.pinnedSessionId,
          authorityRevision: this.authorityRevision,
          ...invalidationTelemetry,
          degradedReason: `snapshot-load-failed:${formatError(error)}`,
        },
      };
    }
  }

  prewarmSnapshot({
    sessionId,
    loader,
  }: {
    sessionId?: string;
    loader: MemorySnapshotLoader;
  }) {
    return this.readSnapshot({ sessionId, loader });
  }

  invalidateSnapshot(request: MemorySnapshotInvalidationRequest) {
    const previousInvalidation = this.latestInvalidation;
    const inheritsHardBarrier =
      !this.snapshot && previousInvalidation?.kind === "hard";
    const invalidationKind =
      request.kind === "hard" || inheritsHardBarrier ? "hard" : "soft";
    this.snapshotGeneration += 1;
    if (request.kind === "hard") {
      this.authorityRevision += 1;
    }
    this.latestInvalidation = {
      ...request,
      kind: invalidationKind,
      reason: inheritsHardBarrier
        ? mergeInvalidationReasons(
            previousInvalidation.reason,
            request.reason
          )
        : request.reason,
      affectedEntryIds: normalizeEntryIds([
        ...(inheritsHardBarrier
          ? previousInvalidation.affectedEntryIds ?? []
          : []),
        ...(request.affectedEntryIds ?? []),
      ]),
      generation: this.snapshotGeneration,
      authorityRevision: this.authorityRevision,
      previousSnapshotVersion: inheritsHardBarrier
        ? previousInvalidation.previousSnapshotVersion
        : this.snapshot?.version ?? this.snapshotVersion,
      invalidatedAt: this.wallNow(),
      firstReadObserved: false,
      hardDisposition:
        invalidationKind === "hard"
          ? "fail-closed-until-refresh"
          : undefined,
    };

    if (invalidationKind === "hard") {
      this.snapshot = undefined;
    }

    if (this.snapshotLoader) {
      void this.ensureSnapshotRefresh(
        this.snapshotLoader,
        this.pinnedSessionId
      ).promise.catch(() => undefined);
    }
  }

  enqueueUsage({
    entryIds,
    writer,
    onFlush,
  }: {
    entryIds: string[];
    writer: MemoryUsageWriter;
    onFlush?: MemoryUsageFlushListener;
  }): MemoryUsageEnqueueResult {
    const startedAt = this.monotonicNow();
    this.usageWriter = writer;
    const normalizedIds = Array.from(
      new Set(entryIds.map((id) => id.trim()).filter(Boolean))
    );
    if (!normalizedIds.length) {
      return {
        addedEntryCount: 0,
        queueDepth: this.pendingUsageBatch?.entryIds.size ?? 0,
        enqueueMs: elapsedMs(startedAt, this.monotonicNow()),
        lastFlush: this.lastUsageFlush,
      };
    }

    const batch =
      this.pendingUsageBatch ??
      {
        id: `memory_usage_${this.wallNow()}_${++this.usageBatchSequence}`,
        entryIds: new Set<string>(),
        listeners: new Set<MemoryUsageFlushListener>(),
      };
    this.pendingUsageBatch = batch;
    const previousSize = batch.entryIds.size;
    for (const id of normalizedIds) {
      batch.entryIds.add(id);
    }
    if (onFlush) {
      batch.listeners.add(onFlush);
    }
    this.scheduleUsageFlush();

    return {
      batchId: batch.id,
      addedEntryCount: batch.entryIds.size - previousSize,
      queueDepth: batch.entryIds.size,
      enqueueMs: elapsedMs(startedAt, this.monotonicNow()),
      lastFlush: this.lastUsageFlush,
    };
  }

  async flushUsage(): Promise<MemoryUsageFlushResult | undefined> {
    if (this.usageFlushTimer) {
      this.cancelSchedule?.(this.usageFlushTimer);
      this.usageFlushTimer = undefined;
    }

    if (this.usageFlushInFlight) {
      await this.usageFlushInFlight;
      if (!this.pendingUsageBatch) return this.lastUsageFlush;
    }

    const batch = this.pendingUsageBatch;
    const writer = this.usageWriter;
    if (!batch || !writer) return this.lastUsageFlush;
    this.pendingUsageBatch = undefined;

    const flushPromise = this.runUsageFlush(batch, writer);
    this.usageFlushInFlight = flushPromise;
    const result = await flushPromise;
    if (this.usageFlushInFlight === flushPromise) {
      this.usageFlushInFlight = undefined;
    }
    if (this.pendingUsageBatch) {
      this.scheduleUsageFlush();
    }
    return result;
  }

  getUsageQueueDepth() {
    return this.pendingUsageBatch?.entryIds.size ?? 0;
  }

  getLastUsageFlush() {
    return this.lastUsageFlush;
  }

  resetForTests() {
    if (this.usageFlushTimer) {
      this.cancelSchedule?.(this.usageFlushTimer);
    }
    this.snapshot = undefined;
    this.pendingSnapshotLoad = undefined;
    this.snapshotLoader = undefined;
    this.snapshotGeneration = 0;
    this.snapshotVersion = 0;
    this.authorityRevision = 0;
    this.latestInvalidation = undefined;
    this.pinnedSessionId = undefined;
    this.usageWriter = undefined;
    this.pendingUsageBatch = undefined;
    this.usageFlushTimer = undefined;
    this.usageFlushInFlight = undefined;
    this.lastUsageFlush = undefined;
    this.usageBatchSequence = 0;
  }

  private buildReadResult(
    snapshot: MemorySnapshot,
    cacheState: MemorySnapshotCacheState,
    lookupStartedAt: number,
    loadTimings: MemorySnapshotLoadTimings,
    degradedReason?: string
  ): MemorySnapshotReadResult {
    return {
      entries: snapshot.entries,
      telemetry: {
        ...loadTimings,
        cacheState,
        cacheHit:
          cacheState === "hit" || cacheState === "stale-while-refresh",
        cacheLookupMs: elapsedMs(lookupStartedAt, this.monotonicNow()),
        snapshotVersion: snapshot.version,
        snapshotGeneration: snapshot.generation,
        snapshotAgeMs: Math.max(0, this.wallNow() - snapshot.loadedAt),
        snapshotSessionId: this.pinnedSessionId ?? snapshot.sessionId,
        authorityRevision: snapshot.authorityRevision,
        ...this.consumeInvalidationTelemetry(snapshot.entries),
        degradedReason,
      },
    };
  }

  private ensureSnapshotRefresh(
    loader: MemorySnapshotLoader,
    sessionId?: string
  ) {
    if (
      this.pendingSnapshotLoad?.generation === this.snapshotGeneration
    ) {
      return this.pendingSnapshotLoad;
    }
    return this.startSnapshotRefresh(loader, sessionId);
  }

  private startSnapshotRefresh(
    loader: MemorySnapshotLoader,
    sessionId?: string
  ): PendingSnapshotLoad {
    const generation = this.snapshotGeneration;
    let pendingLoad: PendingSnapshotLoad;
    const promise = loader().then((loaded) => {
      if (generation !== this.snapshotGeneration) {
        return undefined;
      }
      const snapshot: MemorySnapshot = {
        entries: Object.freeze([...loaded.entries]),
        version: ++this.snapshotVersion,
        generation,
        authorityRevision: this.authorityRevision,
        loadedAt: this.wallNow(),
        sessionId,
      };
      if (this.latestInvalidation?.generation === generation) {
        this.latestInvalidation.newSnapshotVersion = snapshot.version;
        if (this.latestInvalidation.kind === "hard") {
          this.latestInvalidation.hardDisposition =
            "fresh-snapshot-loaded-after-fail-closed";
        }
      }
      loadedSnapshotLoadTimings.set(snapshot, loaded.timings);
      this.snapshot = snapshot;
      return snapshot;
    });
    pendingLoad = { generation, promise };
    this.pendingSnapshotLoad = pendingLoad;
    void promise.then(
      () => {
        if (this.pendingSnapshotLoad === pendingLoad) {
          this.pendingSnapshotLoad = undefined;
        }
      },
      () => {
        if (this.pendingSnapshotLoad === pendingLoad) {
          this.pendingSnapshotLoad = undefined;
        }
      }
    );
    return pendingLoad;
  }

  private consumeInvalidationTelemetry(
    entries: readonly MemoryEntry[],
    options: { loadFailed?: boolean } = {}
  ): Partial<MemorySnapshotReadTelemetry> {
    const invalidation = this.latestInvalidation;
    if (
      !invalidation ||
      invalidation.firstReadObserved ||
      invalidation.generation !== this.snapshotGeneration
    ) {
      return {};
    }

    invalidation.firstReadObserved = true;
    if (invalidation.kind === "hard" && options.loadFailed) {
      invalidation.hardDisposition = "fail-closed-load-failed";
    }

    const affectedEntryIds = invalidation.affectedEntryIds ?? [];
    const activeAuthorityIds = new Set(
      entries
        .filter(isEntryAuthorityEligible)
        .map((entry) => entry.id)
    );

    return {
      authorityRevision: invalidation.authorityRevision,
      invalidationKind: invalidation.kind,
      invalidationReason: invalidation.reason,
      invalidationPreviousSnapshotVersion:
        invalidation.previousSnapshotVersion,
      invalidationNewSnapshotVersion: invalidation.newSnapshotVersion,
      invalidationToFirstReadMs: Math.max(
        0,
        this.wallNow() - invalidation.invalidatedAt
      ),
      invalidationFirstRead: true,
      hardInvalidationDisposition: invalidation.hardDisposition,
      hardInvalidationAffectedEntryIds:
        invalidation.kind === "hard" && affectedEntryIds.length
          ? affectedEntryIds
          : undefined,
      hardInvalidationTargetsExcluded:
        invalidation.kind === "hard" && affectedEntryIds.length
          ? affectedEntryIds.every((id) => !activeAuthorityIds.has(id))
          : undefined,
      hardInvalidationStaleSnapshotServed:
        invalidation.kind === "hard" ? false : undefined,
    };
  }

  private scheduleUsageFlush() {
    if (this.usageFlushTimer) return;
    this.usageFlushTimer = this.schedule?.(() => {
      this.usageFlushTimer = undefined;
      void this.flushUsage();
    }, this.usageDebounceMs);
  }

  private async runUsageFlush(
    batch: PendingUsageBatch,
    writer: MemoryUsageWriter
  ): Promise<MemoryUsageFlushResult> {
    const startedAt = this.monotonicNow();
    let result: MemoryUsageFlushResult;
    try {
      await writer([...batch.entryIds]);
      result = {
        batchId: batch.id,
        entryCount: batch.entryIds.size,
        durationMs: elapsedMs(startedAt, this.monotonicNow()),
        queueDepthAfter: this.pendingUsageBatch?.entryIds.size ?? 0,
        success: true,
      };
    } catch (error) {
      result = {
        batchId: batch.id,
        entryCount: batch.entryIds.size,
        durationMs: elapsedMs(startedAt, this.monotonicNow()),
        queueDepthAfter: this.pendingUsageBatch?.entryIds.size ?? 0,
        success: false,
        error: formatError(error),
      };
    }
    this.lastUsageFlush = result;
    for (const listener of batch.listeners) {
      try {
        listener(result);
      } catch {
        // Usage telemetry must never fail the retrieval path.
      }
    }
    return result;
  }
}

const loadedSnapshotLoadTimings = new WeakMap<
  MemorySnapshot,
  MemorySnapshotLoadTimings
>();

const sharedMemoryRetrievalRuntime = new MemoryRetrievalRuntime();

export function getSharedMemoryRetrievalRuntime() {
  return sharedMemoryRetrievalRuntime;
}

export function invalidateMemoryRetrievalSnapshot(
  request: MemorySnapshotInvalidationRequest
) {
  sharedMemoryRetrievalRuntime.invalidateSnapshot(request);
}

function elapsedMs(startedAt: number, endedAt: number) {
  return Math.max(0, endedAt - startedAt);
}

function normalizeEntryIds(entryIds: string[] | undefined) {
  if (!entryIds?.length) return undefined;
  const normalized = Array.from(
    new Set(entryIds.map((id) => id.trim()).filter(Boolean))
  );
  return normalized.length ? normalized : undefined;
}

function mergeInvalidationReasons(left: string, right: string) {
  if (left === right) return left;
  return `${left}+${right}`;
}

function isEntryAuthorityEligible(entry: MemoryEntry) {
  return (
    entry.enabled &&
    (entry.curationStatus === "curated" ||
      entry.curationStatus === "verified")
  );
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
