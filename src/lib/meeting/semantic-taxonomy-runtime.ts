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

export type SemanticTaxonomyEmbeddingResult =
  | {
      status: "success";
      input: SemanticTaxonomyEmbeddingInput;
      embeddings: number[][];
      durationMs: number;
      modelVersion: string;
      cacheHit: boolean;
    }
  | {
      status: "unavailable" | "timeout" | "stale" | "error";
      input: SemanticTaxonomyEmbeddingInput;
      reason: string;
      durationMs: number;
      modelVersion: string;
      cacheHit: false;
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

interface PendingRequest {
  kind: "initialize" | "embed" | "dispose";
  startedAt: number;
  input?: SemanticTaxonomyEmbeddingInput;
  timeoutId?: ReturnType<typeof setTimeout>;
  resolve: (value: SemanticTaxonomyEmbeddingResult | void) => void;
  reject: (error: Error) => void;
}

export interface SemanticTaxonomyRuntimeOptions {
  workerFactory?: () => SemanticTaxonomyWorkerLike;
  now?: () => number;
  idleGraceMs?: number;
  warmupTimeoutMs?: number;
}

const DEFAULT_IDLE_GRACE_MS = 10 * 60_000;
const DEFAULT_WARMUP_TIMEOUT_MS = 90_000;
const MAX_EMBEDDING_CACHE_ENTRIES = 256;

export class SemanticTaxonomyRuntime {
  private worker?: SemanticTaxonomyWorkerLike;
  private pending = new Map<string, PendingRequest>();
  private initializePromise?: Promise<SemanticTaxonomyRuntimeSnapshot>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private requestSequence = 0;
  private embeddingCache = new Map<string, number[][]>();
  private activeIdentity?: SemanticTaxonomyRuntimeIdentity;
  private snapshot: SemanticTaxonomyRuntimeSnapshot = {
    readiness: typeof Worker === "undefined" ? "unavailable" : "idle",
    modelVersion: SEMANTIC_TAXONOMY_MODEL_VERSION,
    coldFallbackCount: 0,
    reusedAfterAudioRecovery: false,
  };

  private readonly workerFactory: () => SemanticTaxonomyWorkerLike;
  private readonly now: () => number;
  private readonly idleGraceMs: number;
  private readonly warmupTimeoutMs: number;

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
    if (changed) this.resolveStalePendingRequests();
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
    if (this.snapshot.readiness === "ready") return this.getSnapshot();
    if (this.initializePromise) return this.initializePromise;
    if (this.snapshot.readiness === "unavailable") return this.getSnapshot();

    this.initializePromise = this.initialize();
    try {
      return await this.initializePromise;
    } finally {
      this.initializePromise = undefined;
    }
  }

  async embed(
    input: SemanticTaxonomyEmbeddingInput,
    timeoutMs = 100
  ): Promise<SemanticTaxonomyEmbeddingResult> {
    if (this.snapshot.readiness !== "ready" || !this.worker) {
      this.snapshot = {
        ...this.snapshot,
        coldFallbackCount: this.snapshot.coldFallbackCount + 1,
      };
      return this.failureResult(
        input,
        "unavailable",
        `runtime-${this.snapshot.readiness}`,
        0
      );
    }
    if (!this.matchesActiveIdentity(input)) {
      return this.failureResult(input, "stale", "runtime-identity-mismatch", 0);
    }

    const cacheKey = embeddingCacheKey(input);
    const cached = this.embeddingCache.get(cacheKey);
    if (cached) {
      this.embeddingCache.delete(cacheKey);
      this.embeddingCache.set(cacheKey, cached);
      return {
        status: "success",
        input,
        embeddings: cached,
        durationMs: 0,
        modelVersion: SEMANTIC_TAXONOMY_MODEL_VERSION,
        cacheHit: true,
      };
    }

    const requestId = this.nextRequestId("embed");
    const startedAt = this.now();
    return new Promise<SemanticTaxonomyEmbeddingResult>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(
          this.failureResult(
            input,
            "timeout",
            "semantic-embedding-timeout",
            this.now() - startedAt
          )
        );
      }, timeoutMs);
      this.pending.set(requestId, {
        kind: "embed",
        startedAt,
        input,
        timeoutId,
        resolve: (value) => {
          if (value) resolve(value);
        },
        reject,
      });
      this.worker?.postMessage({ type: "embed", requestId, input });
    });
  }

  async dispose(reason = "explicit-dispose") {
    this.clearIdleTimer();
    const worker = this.worker;
    this.activeIdentity = undefined;
    this.resolveAllPending("runtime-disposed");
    if (worker) {
      const requestId = this.nextRequestId("dispose");
      worker.postMessage({ type: "dispose", requestId });
      worker.terminate();
    }
    this.worker = undefined;
    this.embeddingCache.clear();
    this.snapshot = {
      ...this.snapshot,
      readiness: "disposed",
      sessionId: undefined,
      runtimeEpoch: undefined,
      pinnedReason: undefined,
      disposedReason: reason,
    };
  }

  private async initialize() {
    const warmupStartedAt = this.now();
    this.snapshot = {
      ...this.snapshot,
      readiness: "warming",
      warmupStartedAt,
      error: undefined,
    };
    try {
      this.worker = this.workerFactory();
      this.worker.onmessage = (event) => this.handleWorkerMessage(event.data);
      this.worker.onerror = (event) => {
        this.failRuntime(event.message || "semantic worker failed");
      };
      const requestId = this.nextRequestId("initialize");
      await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          this.pending.delete(requestId);
          reject(new Error("Semantic taxonomy warmup timed out"));
        }, this.warmupTimeoutMs);
        this.pending.set(requestId, {
          kind: "initialize",
          startedAt: warmupStartedAt,
          timeoutId,
          resolve: () => resolve(),
          reject,
        });
        this.worker?.postMessage({
          type: "initialize",
          requestId,
          model: SEMANTIC_TAXONOMY_MODEL,
        });
      });
      return this.getSnapshot();
    } catch (error) {
      this.failRuntime(error instanceof Error ? error.message : String(error));
      return this.getSnapshot();
    }
  }

  private handleWorkerMessage(message: SemanticTaxonomyWorkerResponse) {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
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
      pending.resolve(undefined);
      return;
    }

    if (message.type === "embedding" && pending.input) {
      if (
        !this.matchesActiveIdentity(message.input) ||
        message.input.turnId !== pending.input.turnId
      ) {
        pending.resolve(
          this.failureResult(
            pending.input,
            "stale",
            "stale-semantic-worker-result",
            this.now() - pending.startedAt
          )
        );
        return;
      }
      pending.resolve({
        status: "success",
        input: pending.input,
        embeddings: message.embeddings,
        durationMs: message.durationMs,
        modelVersion: SEMANTIC_TAXONOMY_MODEL_VERSION,
        cacheHit: false,
      } satisfies SemanticTaxonomyEmbeddingResult);
      this.cacheEmbedding(pending.input, message.embeddings);
      return;
    }

    pending.resolve(undefined);
  }

  private failRuntime(message: string) {
    this.worker?.terminate();
    this.worker = undefined;
    this.resolveAllPending(message);
    this.snapshot = {
      ...this.snapshot,
      readiness: "failed",
      error: message,
    };
  }

  private resolveStalePendingRequests() {
    for (const [requestId, pending] of this.pending) {
      if (pending.kind !== "embed" || !pending.input) continue;
      if (this.matchesActiveIdentity(pending.input)) continue;
      this.pending.delete(requestId);
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      pending.resolve(
        this.failureResult(
          pending.input,
          "stale",
          "session-or-epoch-changed",
          this.now() - pending.startedAt
        )
      );
    }
  }

  private resolveAllPending(reason: string) {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      if (pending.kind === "embed" && pending.input) {
        pending.resolve(
          this.failureResult(
            pending.input,
            "stale",
            reason,
            this.now() - pending.startedAt
          )
        );
      } else {
        pending.reject(new Error(reason));
      }
    }
  }

  private matchesActiveIdentity(input: SemanticTaxonomyRuntimeIdentity) {
    return Boolean(
      this.activeIdentity &&
        this.activeIdentity.sessionId === input.sessionId &&
        this.activeIdentity.runtimeEpoch === input.runtimeEpoch
    );
  }

  private failureResult(
    input: SemanticTaxonomyEmbeddingInput,
    status: Exclude<SemanticTaxonomyEmbeddingResult["status"], "success">,
    reason: string,
    durationMs: number
  ): SemanticTaxonomyEmbeddingResult {
    return {
      status,
      input,
      reason,
      durationMs,
      modelVersion: SEMANTIC_TAXONOMY_MODEL_VERSION,
      cacheHit: false,
    };
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
