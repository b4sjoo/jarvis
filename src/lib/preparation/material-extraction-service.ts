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
  PreparationRecoveredContent,
} from "./extraction-types.js";
import type { PreparationMaterialQualitySignal } from "./types.js";

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
    commitCloudImageText(
      workspaceId: string,
      materialId: string,
      text: string
    ): Promise<PreparationExtractionInspection | undefined>;
    commitRecoveredText(input: {
      workspaceId: string;
      materialId: string;
      baseRevisionId: string;
      content: PreparationRecoveredContent;
      qualitySignals?: PreparationMaterialQualitySignal[];
    }): Promise<PreparationExtractionInspection | undefined>;
    commitManualText(input: {
      workspaceId: string;
      materialId: string;
      text: string;
      markReady: boolean;
    }): Promise<PreparationExtractionInspection | undefined>;
    approve(workspaceId: string, materialId: string): Promise<boolean>;
    flagQuality(input: {
      workspaceId: string;
      materialId: string;
      signals: PreparationMaterialQualitySignal[];
      detail?: string;
    }): Promise<boolean>;
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

    async commitCloudImageText(workspaceId, materialId, text) {
      const candidate = await dependencies.repository.getCurrent(materialId);
      if (!candidate || candidate.workspaceId !== workspaceId) {
        throw new Error("Preparation image material not found.");
      }
      if (!['png', 'jpg', 'jpeg', 'heic', 'heif'].includes(candidate.extension)) {
        throw new Error("Cloud text extraction is available only for image materials.");
      }
      return commitDerivedText({
        workspaceId,
        materialId,
        text,
        method: "cloud-ocr",
        reviewStatus: "needs-review",
        reviewActor: "model",
        warningCodes: ["cloud-ocr-unverified"],
        action: "recovery-created",
      });
    },

    async commitRecoveredText(input) {
      const recoveredContent = input.content;
      if (recoveredContent.kind === "pdf-pages") {
        return commitRecoveredPdfPages({
          ...input,
          content: recoveredContent,
        });
      }
      const base = await requireCurrentBase(
        input.workspaceId,
        input.materialId,
        input.baseRevisionId
      );
      if (base.extension === "pdf") {
        throw new Error(
          "PDF recovery must provide page-addressed output; whole-document replacement is not allowed."
        );
      }
      return commitDerivedText({
        workspaceId: input.workspaceId,
        materialId: input.materialId,
        baseRevisionId: base.revisionId,
        text: recoveredContent.text,
        qualitySignals: input.qualitySignals,
        method: "multimodal-recovery",
        reviewStatus: "needs-review",
        reviewActor: "model",
        warningCodes: ["multimodal-recovery-unverified"],
        action: "recovery-created",
      });
    },

    async commitManualText(input) {
      return commitDerivedText({
        ...input,
        method: "manual-transcription",
        reviewStatus: input.markReady ? "approved" : "needs-review",
        reviewActor: "user",
        warningCodes: input.markReady ? [] : ["manual-transcription-unverified"],
        action: "manual-content-created",
      });
    },

    async approve(workspaceId, materialId) {
      const candidate = await dependencies.repository.getCurrent(materialId);
      if (!candidate || candidate.workspaceId !== workspaceId) return false;
      return dependencies.repository.setReviewState({
        workspaceId,
        materialId,
        revisionId: candidate.revisionId,
        reviewStatus: "approved",
        actor: "user",
        qualitySignals: [],
        eventId: createId(),
        action: "approved",
        updatedAt: now(),
      });
    },

    async flagQuality(input) {
      const candidate = await dependencies.repository.getCurrent(input.materialId);
      if (!candidate || candidate.workspaceId !== input.workspaceId) return false;
      const qualitySignals = mergeQualitySignals(
        candidate.qualitySignals,
        input.signals
      );
      return dependencies.repository.setReviewState({
        workspaceId: input.workspaceId,
        materialId: input.materialId,
        revisionId: candidate.revisionId,
        reviewStatus: "needs-review",
        actor: "model",
        qualitySignals,
        eventId: createId(),
        action: "quality-flagged",
        detail: input.detail,
        updatedAt: now(),
      });
    },
  };

  async function commitDerivedText(input: {
    workspaceId: string;
    materialId: string;
    baseRevisionId?: string;
    text: string;
    method: "cloud-ocr" | "multimodal-recovery" | "manual-transcription";
    reviewStatus: "needs-review" | "approved";
    reviewActor: "model" | "user";
    warningCodes: string[];
    qualitySignals?: PreparationMaterialQualitySignal[];
    action: "recovery-created" | "manual-content-created";
  }) {
    const base = await requireCurrentBase(
      input.workspaceId,
      input.materialId,
      input.baseRevisionId
    );
    const normalized = normalizeRecoveredText(input.text);
    if (!normalized) {
      throw new Error("The recovered material text is empty.");
    }
    const requestId = createId();
    const revisionId = createId();
    const startedAt = now();
    const candidate = await dependencies.repository.createDerivedRevision({
      workspaceId: input.workspaceId,
      materialId: input.materialId,
      baseRevisionId: base.revisionId,
      revisionId,
      requestId,
      createdAt: startedAt,
      reviewStatus: input.reviewStatus,
      reviewActor: input.reviewActor,
      qualitySignals: input.qualitySignals,
      action: input.action,
    });
    if (!candidate) {
      throw new Error("Preparation material changed; retry the recovery request.");
    }
    emit({
      name: "Preparation extraction started",
      workspaceId: input.workspaceId,
      materialId: input.materialId,
      revisionId,
      revision: candidate.revision,
      requestId,
      timestamp: startedAt,
      extension: candidate.extension,
      status: "extracting",
      method: input.method,
    });
    const completedAt = now();
    const chunks = createDerivedTextChunks({
      text: normalized,
      workspaceId: input.workspaceId,
      materialId: input.materialId,
      revisionId,
      requestId,
      sourceMethod: input.method,
      createdAt: completedAt,
      createId,
    });
    const metadata: PreparationExtractionMetadata = {
      method: input.method,
      textChars: normalized.length,
      chunkCount: chunks.length,
      warningCodes: input.warningCodes,
      durationMs: completedAt - startedAt,
      offsetUnit: "unicode-scalar",
      ...(input.method === "multimodal-recovery"
        ? {
            recoveryMode: "full-replacement" as const,
            baseRevisionId: base.revisionId,
            inheritedChunkCount: 0,
            replacedChunkCount: (
              await dependencies.repository.listChunks(base.revisionId)
            ).length,
            recoveredChunkCount: chunks.length,
          }
        : {}),
    };
    let committed = false;
    try {
      committed = await dependencies.repository.complete({
        workspaceId: input.workspaceId,
        materialId: input.materialId,
        revisionId,
        requestId,
        status: "ready",
        metadata,
        chunks,
        reviewStatus: input.reviewStatus,
        reviewActor: input.reviewActor,
        qualitySignals: input.qualitySignals,
        completedAt,
      });
    } catch (error) {
      await dependencies.repository.discardDerivedRevision({
        workspaceId: input.workspaceId,
        materialId: input.materialId,
        revisionId,
        requestId,
        baseRevisionId: base.revisionId,
      });
      throw error;
    }
    emit({
      name: committed
        ? "Preparation extraction finished"
        : "Preparation extraction stale result dropped",
      workspaceId: input.workspaceId,
      materialId: input.materialId,
      revisionId,
      revision: candidate.revision,
      requestId,
      timestamp: completedAt,
      status: input.reviewStatus === "approved" ? "ready" : "needs-review",
      method: input.method,
      textChars: normalized.length,
      chunkCount: chunks.length,
      warningCodes: input.warningCodes,
      durationMs: completedAt - startedAt,
      committed,
    });
    if (!committed) {
      await dependencies.repository.discardDerivedRevision({
        workspaceId: input.workspaceId,
        materialId: input.materialId,
        revisionId,
        requestId,
        baseRevisionId: base.revisionId,
      });
      throw new Error("Preparation material changed; retry the recovery request.");
    }
    return service.inspect(input.workspaceId, input.materialId);
  }

  async function commitRecoveredPdfPages(input: {
    workspaceId: string;
    materialId: string;
    baseRevisionId: string;
    content: Extract<PreparationRecoveredContent, { kind: "pdf-pages" }>;
    qualitySignals?: PreparationMaterialQualitySignal[];
  }) {
    const base = await requireCurrentBase(
      input.workspaceId,
      input.materialId,
      input.baseRevisionId
    );
    if (base.extension !== "pdf") {
      throw new Error("Page recovery is available only for PDF materials.");
    }
    if (
      !Number.isSafeInteger(input.content.pageCount) ||
      input.content.pageCount < 1
    ) {
      throw new Error("The recovered PDF page count is invalid.");
    }
    if (
      base.metadata?.pageCount !== undefined &&
      base.metadata.pageCount !== input.content.pageCount
    ) {
      throw new Error(
        "The recovered PDF page count does not match the base revision; re-run local extraction first."
      );
    }

    const normalizedPages = normalizeRecoveredPages(
      input.content.pages,
      input.content.pageCount
    );
    const baseChunks = await dependencies.repository.listChunks(base.revisionId);
    const targetPages = new Set(normalizedPages.map((page) => page.pageNumber));
    const pageAddressableBase =
      baseChunks.length > 0 &&
      baseChunks.every(
        (chunk) =>
          Number.isSafeInteger(chunk.page) &&
          (chunk.page ?? 0) >= 1 &&
          (chunk.page ?? 0) <= input.content.pageCount
      );
    const coversEveryPage =
      normalizedPages.length === input.content.pageCount &&
      normalizedPages.every((page, index) => page.pageNumber === index + 1);
    if (!pageAddressableBase && !coversEveryPage) {
      throw new Error(
        "The base revision has no reliable page map; re-run full local extraction before recovering selected pages."
      );
    }

    const requestId = createId();
    const revisionId = createId();
    const startedAt = now();
    const completedAt = now();
    const materialized = materializeRecoveredPdfChunks({
      baseChunks: pageAddressableBase ? baseChunks : [],
      recoveredPages: normalizedPages,
      targetPages,
      workspaceId: input.workspaceId,
      materialId: input.materialId,
      revisionId,
      requestId,
      createdAt: completedAt,
      createId,
    });
    const candidate = await dependencies.repository.createDerivedRevision({
      workspaceId: input.workspaceId,
      materialId: input.materialId,
      baseRevisionId: base.revisionId,
      revisionId,
      requestId,
      createdAt: startedAt,
      reviewStatus: "needs-review",
      reviewActor: "model",
      qualitySignals: input.qualitySignals,
      action: "recovery-created",
    });
    if (!candidate) {
      throw new Error("Preparation material changed; retry the recovery request.");
    }
    emit({
      name: "Preparation extraction started",
      workspaceId: input.workspaceId,
      materialId: input.materialId,
      revisionId,
      revision: candidate.revision,
      requestId,
      timestamp: startedAt,
      extension: candidate.extension,
      status: "extracting",
      method: "multimodal-recovery",
      baseRevisionId: base.revisionId,
      patchedPages: [...targetPages],
      inheritedChunkCount: materialized.inheritedChunkCount,
      replacedChunkCount: materialized.replacedChunkCount,
    });
    const metadata: PreparationExtractionMetadata = {
      method: "multimodal-recovery",
      textChars: materialized.textChars,
      pageCount: input.content.pageCount,
      chunkCount: materialized.chunks.length,
      warningCodes: ["multimodal-recovery-unverified"],
      durationMs: completedAt - startedAt,
      offsetUnit: "unicode-scalar",
      recoveryMode: pageAddressableBase ? "page-patch" : "full-replacement",
      baseRevisionId: base.revisionId,
      patchedPages: [...targetPages],
      inheritedChunkCount: materialized.inheritedChunkCount,
      replacedChunkCount: materialized.replacedChunkCount,
      recoveredChunkCount: materialized.recoveredChunkCount,
    };
    let committed = false;
    try {
      committed = await dependencies.repository.complete({
        workspaceId: input.workspaceId,
        materialId: input.materialId,
        revisionId,
        requestId,
        status: "ready",
        metadata,
        chunks: materialized.chunks,
        reviewStatus: "needs-review",
        reviewActor: "model",
        qualitySignals: input.qualitySignals,
        completedAt,
      });
    } catch (error) {
      await dependencies.repository.discardDerivedRevision({
        workspaceId: input.workspaceId,
        materialId: input.materialId,
        revisionId,
        requestId,
        baseRevisionId: base.revisionId,
      });
      throw error;
    }
    emit({
      name: committed
        ? "Preparation extraction finished"
        : "Preparation extraction stale result dropped",
      workspaceId: input.workspaceId,
      materialId: input.materialId,
      revisionId,
      revision: candidate.revision,
      requestId,
      timestamp: completedAt,
      extension: candidate.extension,
      status: committed ? "needs-review" : "extracting",
      method: "multimodal-recovery",
      textChars: materialized.textChars,
      pageCount: input.content.pageCount,
      chunkCount: materialized.chunks.length,
      warningCodes: ["multimodal-recovery-unverified"],
      durationMs: completedAt - startedAt,
      committed,
      baseRevisionId: base.revisionId,
      patchedPages: [...targetPages],
      inheritedChunkCount: materialized.inheritedChunkCount,
      replacedChunkCount: materialized.replacedChunkCount,
    });
    if (!committed) {
      await dependencies.repository.discardDerivedRevision({
        workspaceId: input.workspaceId,
        materialId: input.materialId,
        revisionId,
        requestId,
        baseRevisionId: base.revisionId,
      });
      throw new Error("Preparation material changed; retry the recovery request.");
    }
    return service.inspect(input.workspaceId, input.materialId);
  }

  async function requireCurrentBase(
    workspaceId: string,
    materialId: string,
    expectedRevisionId?: string
  ) {
    const candidate = await dependencies.repository.getCurrent(materialId);
    if (!candidate || candidate.workspaceId !== workspaceId) {
      throw new Error("Preparation material not found.");
    }
    if (expectedRevisionId && candidate.revisionId !== expectedRevisionId) {
      throw new Error("Preparation material changed; retry the recovery request.");
    }
    return candidate;
  }

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
        reviewStatus:
          nativeResult.status === "needs-review"
            ? "needs-review"
            : "unreviewed",
        reviewActor: "runtime",
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

function normalizeRecoveredText(value: string) {
  return value
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function createDerivedTextChunks(input: {
  text: string;
  workspaceId: string;
  materialId: string;
  revisionId: string;
  requestId: string;
  sourceMethod: string;
  page?: number;
  section?: string;
  createdAt: number;
  createId: () => string;
}) {
  const chunks: PreparationMaterialChunk[] = [];
  const maxChars = 1_800;
  for (let offset = 0, ordinal = 0; offset < input.text.length; ordinal += 1) {
    const end = Math.min(input.text.length, offset + maxChars);
    const content = input.text.slice(offset, end).trim();
    if (content) {
      chunks.push({
        id: input.createId(),
        workspaceId: input.workspaceId,
        materialId: input.materialId,
        materialRevisionId: input.revisionId,
        extractionRequestId: input.requestId,
        ordinal,
        content,
        searchText: content
          .normalize("NFKC")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim(),
        page: input.page,
        section: input.section,
        sourceMethod: input.sourceMethod,
        createdAt: input.createdAt,
      });
    }
    offset = end;
  }
  return chunks;
}

function normalizeRecoveredPages(
  pages: Array<{ pageNumber: number; text: string }>,
  pageCount: number
) {
  if (!pages.length) {
    throw new Error("The Preparation Model returned no recovered PDF pages.");
  }
  const normalized = pages.map((page) => ({
    pageNumber: Math.floor(page.pageNumber),
    text: normalizeRecoveredText(page.text),
  }));
  const seen = new Set<number>();
  for (const page of normalized) {
    if (
      !Number.isSafeInteger(page.pageNumber) ||
      page.pageNumber < 1 ||
      page.pageNumber > pageCount
    ) {
      throw new Error("The Preparation Model returned an out-of-range PDF page.");
    }
    if (seen.has(page.pageNumber)) {
      throw new Error("The Preparation Model returned a duplicate PDF page.");
    }
    if (!page.text) {
      throw new Error("The Preparation Model returned an empty recovered PDF page.");
    }
    seen.add(page.pageNumber);
  }
  return normalized.sort((left, right) => left.pageNumber - right.pageNumber);
}

function materializeRecoveredPdfChunks(input: {
  baseChunks: PreparationMaterialChunk[];
  recoveredPages: Array<{ pageNumber: number; text: string }>;
  targetPages: Set<number>;
  workspaceId: string;
  materialId: string;
  revisionId: string;
  requestId: string;
  createdAt: number;
  createId: () => string;
}) {
  const inherited = input.baseChunks
    .filter((chunk) => !input.targetPages.has(chunk.page ?? 0))
    .map((chunk) => ({
      ...chunk,
      id: input.createId(),
      materialRevisionId: input.revisionId,
      extractionRequestId: input.requestId,
      startOffset: undefined,
      endOffset: undefined,
      createdAt: input.createdAt,
    }));
  const replacedChunkCount = input.baseChunks.length - inherited.length;
  const recovered = input.recoveredPages.flatMap((page) =>
    createDerivedTextChunks({
      text: page.text,
      workspaceId: input.workspaceId,
      materialId: input.materialId,
      revisionId: input.revisionId,
      requestId: input.requestId,
      sourceMethod: "multimodal-recovery",
      page: page.pageNumber,
      section: `Recovered page ${page.pageNumber}`,
      createdAt: input.createdAt,
      createId: input.createId,
    })
  );
  const chunks = [...inherited, ...recovered]
    .sort(
      (left, right) =>
        (left.page ?? Number.MAX_SAFE_INTEGER) -
          (right.page ?? Number.MAX_SAFE_INTEGER) ||
        left.ordinal - right.ordinal
    )
    .map((chunk, ordinal) => ({ ...chunk, ordinal }));
  return {
    chunks,
    textChars: chunks.reduce((total, chunk) => total + chunk.content.length, 0),
    inheritedChunkCount: inherited.length,
    replacedChunkCount,
    recoveredChunkCount: recovered.length,
  };
}

function mergeQualitySignals(
  current: PreparationMaterialQualitySignal[],
  incoming: PreparationMaterialQualitySignal[]
) {
  const merged = new Map<string, PreparationMaterialQualitySignal>();
  for (const signal of [...current, ...incoming]) {
    merged.set(`${signal.code}:${signal.page ?? ""}`, signal);
  }
  return [...merged.values()];
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
