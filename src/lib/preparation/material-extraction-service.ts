import type {
  NativePreparationMaterialExtractionResult,
  PreparationExtractionCandidate,
  PreparationExtractionInspection,
  PreparationExtractionMetadata,
  PreparationExtractionTraceEvent,
  PreparationMaterialChunk,
  PreparationMaterialExtractionGateway,
  PreparationMaterialExtractionRepository,
  PreparationMaterialExtractionScheduler,
} from "./extraction-types.js";

const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_CONCURRENCY = 2;

export interface PreparationMaterialExtractionServiceDependencies {
  repository: PreparationMaterialExtractionRepository;
  gateway: PreparationMaterialExtractionGateway;
  now?: () => number;
  createId?: () => string;
  staleAfterMs?: number;
  concurrency?: number;
  onBackgroundError?: (error: unknown) => void;
  onEvent?: (event: PreparationExtractionTraceEvent) => void;
}

export function createPreparationMaterialExtractionService(
  dependencies: PreparationMaterialExtractionServiceDependencies
) {
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? (() => crypto.randomUUID());
  const staleAfterMs = dependencies.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const queue = createWorkQueue(dependencies.concurrency ?? DEFAULT_CONCURRENCY);
  const inFlight = new Map<
    string,
    Promise<PreparationExtractionInspection | undefined>
  >();

  const service: PreparationMaterialExtractionScheduler & {
    inspect(
      workspaceId: string,
      materialId: string
    ): Promise<PreparationExtractionInspection | undefined>;
    resumeWorkspace(workspaceId: string): Promise<number>;
  } = {
    schedule(workspaceId, materialId, options = {}) {
      const key = `${workspaceId}:${materialId}`;
      const existing = inFlight.get(key);
      if (existing) return existing;

      const work = queue
        .run(() => runExtraction(workspaceId, materialId, options.force ?? false))
        .catch((error) => {
          dependencies.onBackgroundError?.(error);
          throw error;
        })
        .finally(() => {
          if (inFlight.get(key) === work) inFlight.delete(key);
        });
      inFlight.set(key, work);
      return work;
    },

    async inspect(workspaceId, materialId) {
      const candidate = await dependencies.repository.getCurrent(materialId);
      if (!candidate || candidate.workspaceId !== workspaceId) return undefined;
      return {
        candidate,
        chunks: await dependencies.repository.listChunks(candidate.revisionId),
      };
    },

    async resumeWorkspace(workspaceId) {
      const recoverable = await dependencies.repository.listRecoverable(
        workspaceId,
        now() - staleAfterMs
      );
      for (const candidate of recoverable) {
        void service.schedule(workspaceId, candidate.materialId).catch(() => {});
      }
      return recoverable.length;
    },
  };

  async function runExtraction(
    workspaceId: string,
    materialId: string,
    force: boolean
  ): Promise<PreparationExtractionInspection | undefined> {
    const candidate = await dependencies.repository.getCurrent(materialId);
    if (!candidate || candidate.workspaceId !== workspaceId) return undefined;
    if (candidate.status === "ready" && !force) {
      return service.inspect(workspaceId, materialId);
    }

    const requestId = createId();
    const startedAt = now();
    const claimed = await dependencies.repository.claim({
      workspaceId,
      materialId,
      revisionId: candidate.revisionId,
      sourceChecksumSha256: candidate.sourceChecksumSha256,
      requestId,
      startedAt,
      staleBefore: startedAt - staleAfterMs,
      force,
    });
    if (!claimed) return service.inspect(workspaceId, materialId);

    emit({
      name: "Preparation extraction started",
      workspaceId,
      materialId,
      revisionId: candidate.revisionId,
      revision: candidate.revision,
      requestId,
      timestamp: startedAt,
      extension: candidate.extension,
      status: "extracting",
    });

    let nativeResult: NativePreparationMaterialExtractionResult | undefined;
    try {
      nativeResult = await dependencies.gateway.extract({
        workspaceKind: "interview",
        workspaceId,
        materialId,
        revision: candidate.revision,
        requestId,
        extension: candidate.extension,
      });
      const completedAt = now();
      const metadata: PreparationExtractionMetadata = {
        method: nativeResult.method,
        textChars: nativeResult.textChars,
        pageCount: nativeResult.pageCount,
        ocrPageCount: nativeResult.ocrPageCount,
        ocrAverageConfidence: nativeResult.ocrAverageConfidence,
        ocrCandidatePageCount: nativeResult.ocrCandidatePageCount,
        ocrProcessedPageCount: nativeResult.ocrProcessedPageCount,
        ocrFailedPageCount: nativeResult.ocrFailedPageCount,
        ocrSupplementChars: nativeResult.ocrSupplementChars,
        chunkCount: nativeResult.chunks.length,
        warningCodes: [...nativeResult.warningCodes],
        durationMs: nativeResult.durationMs,
        offsetUnit: "unicode-scalar",
      };
      const chunks: PreparationMaterialChunk[] = nativeResult.chunks.map((chunk) => ({
        ...chunk,
        id: createId(),
        workspaceId,
        materialId,
        materialRevisionId: candidate.revisionId,
        extractionRequestId: requestId,
        createdAt: completedAt,
      }));
      const committed = await dependencies.repository.complete({
        workspaceId,
        materialId,
        revisionId: candidate.revisionId,
        requestId,
        status: nativeResult.status,
        extractedTextRelativePath: nativeResult.extractedTextRelativePath,
        metadata,
        chunks,
        completedAt,
      });
      if (!committed) {
        await discardNativeOutput(candidate, requestId, nativeResult);
        await discardPreviousOutput(candidate, requestId);
        emit({
          name: "Preparation extraction stale result dropped",
          workspaceId,
          materialId,
          revisionId: candidate.revisionId,
          revision: candidate.revision,
          requestId,
          timestamp: completedAt,
          status: nativeResult.status,
          method: nativeResult.method,
          textChars: nativeResult.textChars,
          pageCount: nativeResult.pageCount,
          ocrPageCount: nativeResult.ocrPageCount,
          ocrAverageConfidence: nativeResult.ocrAverageConfidence,
          ocrCandidatePageCount: nativeResult.ocrCandidatePageCount,
          ocrProcessedPageCount: nativeResult.ocrProcessedPageCount,
          ocrFailedPageCount: nativeResult.ocrFailedPageCount,
          ocrSupplementChars: nativeResult.ocrSupplementChars,
          chunkCount: nativeResult.chunks.length,
          warningCodes: [...nativeResult.warningCodes],
          durationMs: completedAt - startedAt,
          committed: false,
        });
        return undefined;
      }
      await discardPreviousOutput(candidate, requestId);
      emit({
        name: "Preparation extraction finished",
        workspaceId,
        materialId,
        revisionId: candidate.revisionId,
        revision: candidate.revision,
        requestId,
        timestamp: completedAt,
        status: nativeResult.status,
        method: nativeResult.method,
        textChars: nativeResult.textChars,
        pageCount: nativeResult.pageCount,
        ocrPageCount: nativeResult.ocrPageCount,
        ocrAverageConfidence: nativeResult.ocrAverageConfidence,
        ocrCandidatePageCount: nativeResult.ocrCandidatePageCount,
        ocrProcessedPageCount: nativeResult.ocrProcessedPageCount,
        ocrFailedPageCount: nativeResult.ocrFailedPageCount,
        ocrSupplementChars: nativeResult.ocrSupplementChars,
        chunkCount: nativeResult.chunks.length,
        warningCodes: [...nativeResult.warningCodes],
        durationMs: completedAt - startedAt,
        committed: true,
      });
      return service.inspect(workspaceId, materialId);
    } catch (error) {
      const completedAt = now();
      if (nativeResult) {
        await discardNativeOutput(candidate, requestId, nativeResult);
      }
      await discardPreviousOutput(candidate, requestId);
      const failed = await dependencies.repository
        .fail({
          workspaceId,
          materialId,
          revisionId: candidate.revisionId,
          requestId,
          metadata: failedMetadata(error, completedAt - startedAt),
          completedAt,
        })
        .catch((settlementError) => {
          dependencies.onBackgroundError?.(settlementError);
          return false;
        });
      emit({
        name: "Preparation extraction failed",
        workspaceId,
        materialId,
        revisionId: candidate.revisionId,
        revision: candidate.revision,
        requestId,
        timestamp: completedAt,
        status: "failed",
        method: nativeResult?.method,
        textChars: nativeResult?.textChars,
        pageCount: nativeResult?.pageCount,
        ocrPageCount: nativeResult?.ocrPageCount,
        ocrAverageConfidence: nativeResult?.ocrAverageConfidence,
        ocrCandidatePageCount: nativeResult?.ocrCandidatePageCount,
        ocrProcessedPageCount: nativeResult?.ocrProcessedPageCount,
        ocrFailedPageCount: nativeResult?.ocrFailedPageCount,
        ocrSupplementChars: nativeResult?.ocrSupplementChars,
        chunkCount: nativeResult?.chunks.length,
        warningCodes: ["extraction-failed"],
        durationMs: completedAt - startedAt,
        committed: failed,
      });
      throw error;
    }
  }

  async function discardNativeOutput(
    candidate: PreparationExtractionCandidate,
    requestId: string,
    result: NativePreparationMaterialExtractionResult
  ) {
    if (!result.extractedTextRelativePath) return;
    await dependencies.gateway
      .discard({
        workspaceKind: "interview",
        workspaceId: candidate.workspaceId,
        materialId: candidate.materialId,
        revision: candidate.revision,
        requestId,
      })
      .catch((error) => dependencies.onBackgroundError?.(error));
  }

  async function discardPreviousOutput(
    candidate: PreparationExtractionCandidate,
    requestId: string
  ) {
    if (!candidate.requestId || candidate.requestId === requestId) return;
    await dependencies.gateway
      .discard({
        workspaceKind: "interview",
        workspaceId: candidate.workspaceId,
        materialId: candidate.materialId,
        revision: candidate.revision,
        requestId: candidate.requestId,
      })
      .catch((error) => dependencies.onBackgroundError?.(error));
  }

  function emit(event: PreparationExtractionTraceEvent) {
    dependencies.onEvent?.(event);
  }

  return service;
}

function failedMetadata(error: unknown, durationMs: number): PreparationExtractionMetadata {
  return {
    method: "none",
    textChars: 0,
    chunkCount: 0,
    warningCodes: ["extraction-failed"],
    durationMs: Math.max(0, durationMs),
    offsetUnit: "unicode-scalar",
    error: error instanceof Error ? error.message : String(error),
  };
}

function createWorkQueue(concurrency: number) {
  const limit = Math.max(1, Math.floor(concurrency));
  const pending: Array<() => void> = [];
  let active = 0;

  const settle = () => {
    active -= 1;
    pending.shift()?.();
  };

  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const start = () => {
          active += 1;
          void work().then(resolve, reject).finally(settle);
        };
        if (active < limit) start();
        else pending.push(start);
      });
    },
  };
}
