import assert from "node:assert/strict";
import test from "node:test";
import type {
  NativePreparationMaterialExtractionResult,
  PreparationExtractionCandidate,
  PreparationMaterialChunk,
  PreparationMaterialExtractionGateway,
  PreparationMaterialExtractionRepository,
  PreparationExtractionTraceEvent,
} from "../src/lib/preparation/extraction-types.js";
import { createPreparationMaterialExtractionService } from "../src/lib/preparation/material-extraction-service.js";

test("extracts and commits revision-bound chunks with provenance", async () => {
  const harness = createHarness();
  const service = createPreparationMaterialExtractionService(harness.dependencies);

  const inspection = await service.schedule("workspace-1", "material-1");

  assert.equal(inspection?.candidate.status, "ready");
  assert.equal(inspection?.candidate.metadata?.method, "pdf-text");
  assert.equal(inspection?.candidate.metadata?.chunkCount, 1);
  assert.equal(inspection?.chunks[0].page, 2);
  assert.equal(inspection?.chunks[0].content, "Design a retrieval system.");
  assert.equal(harness.gatewayCalls, 1);
});

test("drops a completed native result after a newer request owns the revision", async () => {
  const deferred = createDeferred<NativePreparationMaterialExtractionResult>();
  const harness = createHarness({ gatewayResult: deferred.promise });
  const service = createPreparationMaterialExtractionService(harness.dependencies);

  const scheduled = service.schedule("workspace-1", "material-1");
  await waitUntil(() => harness.candidate.status === "extracting");
  harness.candidate.requestId = "newer-request";
  deferred.resolve(nativeResult());

  assert.equal(await scheduled, undefined);
  assert.equal(harness.chunks.length, 0);
  assert.equal(harness.candidate.requestId, "newer-request");
  assert.equal(harness.discardedRequests[0], "generated-1");
  assert.equal(
    harness.events.at(-1)?.name,
    "Preparation extraction stale result dropped"
  );
});

test("records extraction failure without claiming the material was read", async () => {
  const harness = createHarness({ gatewayError: new Error("invalid PDF xref") });
  const service = createPreparationMaterialExtractionService(harness.dependencies);

  await assert.rejects(
    service.schedule("workspace-1", "material-1"),
    /invalid PDF xref/
  );

  assert.equal(harness.candidate.status, "failed");
  assert.equal(harness.candidate.metadata?.warningCodes[0], "extraction-failed");
  assert.match(harness.candidate.metadata?.error ?? "", /invalid PDF xref/);
  assert.equal(harness.chunks.length, 0);
  assert.equal(harness.events.at(-1)?.name, "Preparation extraction failed");
});

test("coalesces concurrent requests for the same material", async () => {
  const deferred = createDeferred<NativePreparationMaterialExtractionResult>();
  const harness = createHarness({ gatewayResult: deferred.promise });
  const service = createPreparationMaterialExtractionService(harness.dependencies);

  const first = service.schedule("workspace-1", "material-1");
  const second = service.schedule("workspace-1", "material-1");
  await waitUntil(() => harness.gatewayCalls === 1);
  deferred.resolve(nativeResult());

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(harness.gatewayCalls, 1);
  assert.deepEqual(firstResult, secondResult);
});

test("resumes a stale extraction lease after a previous app run", async () => {
  const harness = createHarness();
  harness.candidate.status = "extracting";
  harness.candidate.requestId = "orphaned-request";
  harness.candidate.startedAt = 1;
  const service = createPreparationMaterialExtractionService({
    ...harness.dependencies,
    staleAfterMs: 10,
  });

  assert.equal(await service.resumeWorkspace("workspace-1"), 1);
  await waitUntil(() => harness.candidate.status === "ready");

  assert.equal(harness.gatewayCalls, 1);
  assert.notEqual(harness.candidate.requestId, "orphaned-request");
});

test("indexes explicit cloud image text as unverified review-required evidence", async () => {
  const harness = createHarness();
  harness.candidate.extension = "png";
  const service = createPreparationMaterialExtractionService(harness.dependencies);

  const inspection = await service.commitCloudImageText(
    "workspace-1",
    "material-1",
    "```text\nArchitecture diagram\nAPI -> Queue -> Worker\n```"
  );

  assert.equal(inspection?.candidate.status, "ready");
  assert.equal(inspection?.candidate.reviewStatus, "needs-review");
  assert.equal(inspection?.candidate.metadata?.method, "cloud-ocr");
  assert.deepEqual(inspection?.candidate.metadata?.warningCodes, [
    "cloud-ocr-unverified",
  ]);
  assert.equal(
    inspection?.chunks[0].content,
    "Architecture diagram\nAPI -> Queue -> Worker"
  );
  assert.equal(inspection?.chunks[0].sourceMethod, "cloud-ocr");
  assert.equal(harness.gatewayCalls, 0);
});

test("persists model recovery as a derived review-required revision", async () => {
  const harness = createHarness();
  harness.candidate.extension = "png";
  const service = createPreparationMaterialExtractionService(harness.dependencies);

  const inspection = await service.commitRecoveredText({
    workspaceId: "workspace-1",
    materialId: "material-1",
    baseRevisionId: "revision-1",
    content: { kind: "full", text: "Recovered image text" },
    qualitySignals: [
      {
        code: "unread-page",
        detail: "Page 2 remained unreadable",
        page: 2,
        source: "model",
      },
    ],
  });

  assert.equal(inspection?.candidate.revision, 2);
  assert.equal(inspection?.candidate.reviewStatus, "needs-review");
  assert.equal(inspection?.candidate.derivedFromRevisionId, "revision-1");
  assert.equal(inspection?.chunks[0].sourceMethod, "multimodal-recovery");
  assert.equal(inspection?.candidate.qualitySignals[0]?.code, "unread-page");
});

test("rejects a non-page-addressed PDF recovery at the service boundary", async () => {
  const harness = createHarness();
  harness.candidate.status = "ready";
  harness.candidate.extension = "pdf";
  const service = createPreparationMaterialExtractionService(harness.dependencies);

  await assert.rejects(
    service.commitRecoveredText({
      workspaceId: "workspace-1",
      materialId: "material-1",
      baseRevisionId: "revision-1",
      content: { kind: "full", text: "A partial page disguised as a document" },
    }),
    /page-addressed output/
  );
  assert.equal(harness.candidate.revision, 1);
});

test("materializes a PDF page patch without dropping untouched pages", async () => {
  const harness = createHarness();
  harness.candidate.status = "ready";
  harness.candidate.reviewStatus = "approved";
  harness.candidate.extension = "pdf";
  harness.candidate.metadata = {
    method: "pdf-text",
    textChars: 32,
    pageCount: 3,
    chunkCount: 3,
    warningCodes: [],
    durationMs: 1,
    offsetUnit: "unicode-scalar",
  };
  harness.chunks.push(
    baseChunk(0, 1, "First page"),
    baseChunk(1, 2, "Old second page"),
    baseChunk(2, 3, "Third page")
  );
  const service = createPreparationMaterialExtractionService(harness.dependencies);

  const inspection = await service.commitRecoveredText({
    workspaceId: "workspace-1",
    materialId: "material-1",
    baseRevisionId: "revision-1",
    content: {
      kind: "pdf-pages",
      pageCount: 3,
      pages: [{ pageNumber: 2, text: "Recovered second page" }],
    },
  });

  assert.equal(inspection?.candidate.revision, 2);
  assert.equal(inspection?.candidate.reviewStatus, "needs-review");
  assert.equal(inspection?.candidate.metadata?.recoveryMode, "page-patch");
  assert.deepEqual(inspection?.candidate.metadata?.patchedPages, [2]);
  assert.equal(inspection?.candidate.metadata?.inheritedChunkCount, 2);
  assert.equal(inspection?.candidate.metadata?.replacedChunkCount, 1);
  assert.deepEqual(
    inspection?.chunks.map((chunk) => [chunk.page, chunk.content, chunk.sourceMethod]),
    [
      [1, "First page", "pdf-text"],
      [2, "Recovered second page", "multimodal-recovery"],
      [3, "Third page", "pdf-text"],
    ]
  );
});

test("accumulates successive PDF page patches on the latest complete revision", async () => {
  const harness = createHarness();
  harness.candidate.status = "ready";
  harness.candidate.extension = "pdf";
  harness.candidate.metadata = {
    method: "pdf-text",
    textChars: 28,
    pageCount: 3,
    chunkCount: 3,
    warningCodes: [],
    durationMs: 1,
    offsetUnit: "unicode-scalar",
  };
  harness.chunks.push(
    baseChunk(0, 1, "First page"),
    baseChunk(1, 2, "Second page"),
    baseChunk(2, 3, "Third page")
  );
  const service = createPreparationMaterialExtractionService(harness.dependencies);

  await service.commitRecoveredText({
    workspaceId: "workspace-1",
    materialId: "material-1",
    baseRevisionId: "revision-1",
    content: {
      kind: "pdf-pages",
      pageCount: 3,
      pages: [{ pageNumber: 2, text: "Recovered page two" }],
    },
  });
  const secondBaseRevisionId = harness.candidate.revisionId;
  const inspection = await service.commitRecoveredText({
    workspaceId: "workspace-1",
    materialId: "material-1",
    baseRevisionId: secondBaseRevisionId,
    content: {
      kind: "pdf-pages",
      pageCount: 3,
      pages: [{ pageNumber: 3, text: "Recovered page three" }],
    },
  });

  assert.equal(inspection?.candidate.revision, 3);
  assert.deepEqual(
    inspection?.chunks.map((chunk) => [chunk.page, chunk.content]),
    [
      [1, "First page"],
      [2, "Recovered page two"],
      [3, "Recovered page three"],
    ]
  );
});

test("rejects a stale PDF page patch without creating a revision", async () => {
  const harness = createHarness();
  harness.candidate.status = "ready";
  harness.candidate.extension = "pdf";
  harness.candidate.metadata = {
    method: "pdf-text",
    textChars: 10,
    pageCount: 1,
    chunkCount: 1,
    warningCodes: [],
    durationMs: 1,
    offsetUnit: "unicode-scalar",
  };
  harness.chunks.push(baseChunk(0, 1, "Original"));
  const service = createPreparationMaterialExtractionService(harness.dependencies);

  await assert.rejects(
    service.commitRecoveredText({
      workspaceId: "workspace-1",
      materialId: "material-1",
      baseRevisionId: "stale-revision",
      content: {
        kind: "pdf-pages",
        pageCount: 1,
        pages: [{ pageNumber: 1, text: "Late replacement" }],
      },
    }),
    /changed/
  );

  assert.equal(harness.candidate.revisionId, "revision-1");
  assert.equal(harness.chunks[0]?.content, "Original");
});

test("rejects a partial PDF patch when the base has no page map", async () => {
  const harness = createHarness();
  harness.candidate.status = "ready";
  harness.candidate.extension = "pdf";
  harness.candidate.metadata = {
    method: "multimodal-recovery",
    textChars: 10,
    pageCount: 3,
    chunkCount: 1,
    warningCodes: ["multimodal-recovery-unverified"],
    durationMs: 1,
    offsetUnit: "unicode-scalar",
  };
  harness.chunks.push(baseChunk(0, undefined, "Legacy page-less recovery"));
  const service = createPreparationMaterialExtractionService(harness.dependencies);

  await assert.rejects(
    service.commitRecoveredText({
      workspaceId: "workspace-1",
      materialId: "material-1",
      baseRevisionId: "revision-1",
      content: {
        kind: "pdf-pages",
        pageCount: 3,
        pages: [{ pageNumber: 2, text: "Recovered second page" }],
      },
    }),
    /no reliable page map/
  );
});

test("allows a page-less PDF base only when every source page is recovered", async () => {
  const harness = createHarness();
  harness.candidate.status = "ready";
  harness.candidate.extension = "pdf";
  harness.candidate.metadata = {
    method: "multimodal-recovery",
    textChars: 10,
    pageCount: 2,
    chunkCount: 1,
    warningCodes: ["multimodal-recovery-unverified"],
    durationMs: 1,
    offsetUnit: "unicode-scalar",
  };
  harness.chunks.push(baseChunk(0, undefined, "Legacy incomplete text"));
  const service = createPreparationMaterialExtractionService(harness.dependencies);

  const inspection = await service.commitRecoveredText({
    workspaceId: "workspace-1",
    materialId: "material-1",
    baseRevisionId: "revision-1",
    content: {
      kind: "pdf-pages",
      pageCount: 2,
      pages: [
        { pageNumber: 1, text: "Recovered first page" },
        { pageNumber: 2, text: "Recovered second page" },
      ],
    },
  });

  assert.equal(inspection?.candidate.metadata?.recoveryMode, "full-replacement");
  assert.equal(inspection?.candidate.metadata?.inheritedChunkCount, 0);
  assert.deepEqual(
    inspection?.chunks.map((chunk) => [chunk.page, chunk.content]),
    [
      [1, "Recovered first page"],
      [2, "Recovered second page"],
    ]
  );
});

test("requires an explicit user action before recovered evidence is approved", async () => {
  const harness = createHarness();
  harness.candidate.extension = "png";
  const service = createPreparationMaterialExtractionService(harness.dependencies);
  await service.commitRecoveredText({
    workspaceId: "workspace-1",
    materialId: "material-1",
    baseRevisionId: "revision-1",
    content: { kind: "full", text: "Recovered text" },
  });

  assert.equal(harness.candidate.reviewStatus, "needs-review");
  assert.equal(await service.approve("workspace-1", "material-1", { ...harness.candidate }), true);
  assert.equal(harness.candidate.reviewStatus, "approved");
  assert.deepEqual(harness.candidate.qualitySignals, []);
});

test("force extraction uses the claimed output identity and never discards the previous text", async () => {
  const harness = createHarness();
  harness.candidate.status = "ready";
  harness.candidate.requestId = "old-request";
  harness.candidate.extractedTextRelativePath = "extraction/1/old.txt";
  const claim = harness.dependencies.repository.claim;
  harness.dependencies.repository.claim = async (input) => {
    assert.equal(input.revisionId, "revision-1");
    const candidate = await claim(input);
    assert.ok(candidate);
    harness.candidate.revisionId = input.newRevisionId;
    harness.candidate.revision = 2;
    return { ...harness.candidate };
  };
  const complete = harness.dependencies.repository.complete;
  harness.dependencies.repository.complete = async (input) => {
    assert.equal(input.revisionId, harness.candidate.revisionId);
    assert.notEqual(input.revisionId, "revision-1");
    assert.ok(input.chunks.every((chunk) => chunk.materialRevisionId === input.revisionId));
    return complete(input);
  };
  const service = createPreparationMaterialExtractionService(harness.dependencies);
  const result = await service.schedule("workspace-1", "material-1", { force: true });
  assert.equal(result?.candidate.revision, 2);
  assert.deepEqual(harness.discardedRequests, []);
});

test("a lost completion acknowledgement retains committed output instead of deleting it", async () => {
  const harness = createHarness();
  const complete = harness.dependencies.repository.complete;
  harness.dependencies.repository.complete = async (input) => {
    assert.equal(await complete(input), true);
    throw new Error("completion acknowledgement lost");
  };
  const service = createPreparationMaterialExtractionService(harness.dependencies);
  await assert.rejects(service.schedule("workspace-1", "material-1"), /acknowledgement lost/);
  assert.equal(harness.candidate.status, "ready");
  assert.equal(harness.chunks.length, 1);
  assert.deepEqual(harness.discardedRequests, []);
});

test("approval keeps the inspected revision instead of approving a newer candidate", async () => {
  const harness = createHarness();
  const inspected = { ...harness.candidate };
  harness.candidate.revisionId = "newer-revision";
  const service = createPreparationMaterialExtractionService(harness.dependencies);
  assert.equal(await service.approve("workspace-1", "material-1", inspected), false);
  assert.equal(harness.candidate.reviewStatus, "unreviewed");
});

test("manual edits reject a changed base revision", async () => {
  const harness = createHarness();
  harness.candidate.revisionId = "newer-revision";
  const service = createPreparationMaterialExtractionService(harness.dependencies);
  await assert.rejects(service.commitManualText({ workspaceId: "workspace-1", materialId: "material-1",
    baseRevisionId: "revision-1", text: "old edit", markReady: true }), /changed/);
});

function createHarness(
  options: {
    gatewayResult?: Promise<NativePreparationMaterialExtractionResult>;
    gatewayError?: Error;
  } = {}
) {
  let id = 0;
  let timestamp = 100;
  const chunks: PreparationMaterialChunk[] = [];
  const candidate: PreparationExtractionCandidate = {
    workspaceId: "workspace-1",
    materialId: "material-1",
    extension: "pdf",
    revisionId: "revision-1",
    revision: 1,
    sourceChecksumSha256: "checksum-1",
    status: "pending",
    reviewStatus: "unreviewed",
    qualitySignals: [],
  };
  let gatewayCalls = 0;
  const discardedRequests: string[] = [];
  const events: PreparationExtractionTraceEvent[] = [];

  const repository: PreparationMaterialExtractionRepository = {
    async getCurrent(materialId) {
      return materialId === candidate.materialId ? { ...candidate } : undefined;
    },
    async getSelected(materialId) {
      return materialId === candidate.materialId ? { ...candidate } : undefined;
    },
    async getRevision(materialId, revisionId) {
      return materialId === candidate.materialId && revisionId === candidate.revisionId ? { ...candidate } : undefined;
    },
    async listRecoverable(workspaceId, staleBefore) {
      const recoverable =
        candidate.status === "pending" ||
        (candidate.status === "extracting" &&
          (candidate.startedAt === undefined || candidate.startedAt <= staleBefore));
      return workspaceId === candidate.workspaceId && recoverable
        ? [{ ...candidate }]
        : [];
    },
    async claim(input) {
      if (
        input.materialId !== candidate.materialId ||
        input.revisionId !== candidate.revisionId ||
        (candidate.status === "ready" && !input.force)
      ) {
        return undefined;
      }
      candidate.status = "extracting";
      candidate.requestId = input.requestId;
      candidate.startedAt = input.startedAt;
      return { ...candidate };
    },
    async complete(input) {
      if (
        candidate.status !== "extracting" ||
        candidate.requestId !== input.requestId
      ) {
        return false;
      }
      candidate.status = input.status;
      candidate.completedAt = input.completedAt;
      candidate.extractedTextRelativePath = input.extractedTextRelativePath;
      candidate.metadata = input.metadata;
      candidate.reviewStatus = input.reviewStatus;
      candidate.reviewActor = input.reviewActor;
      candidate.qualitySignals = input.qualitySignals ?? [];
      chunks.splice(0, chunks.length, ...input.chunks);
      return true;
    },
    async fail(input) {
      if (
        candidate.status !== "extracting" ||
        candidate.requestId !== input.requestId
      ) {
        return false;
      }
      candidate.status = "failed";
      candidate.completedAt = input.completedAt;
      candidate.metadata = input.metadata;
      chunks.length = 0;
      return true;
    },
    async createDerivedRevision(input) {
      if (
        input.materialId !== candidate.materialId ||
        input.workspaceId !== candidate.workspaceId ||
        input.baseRevisionId !== candidate.revisionId
      ) {
        return undefined;
      }
      const previousRevisionId = candidate.revisionId;
      candidate.revision += 1;
      candidate.revisionId = input.revisionId;
      candidate.requestId = input.requestId;
      candidate.startedAt = input.createdAt;
      candidate.status = "extracting";
      candidate.reviewStatus = input.reviewStatus;
      candidate.reviewActor = input.reviewActor;
      candidate.qualitySignals = input.qualitySignals ?? [];
      candidate.derivedFromRevisionId = previousRevisionId;
      chunks.length = 0;
      return { ...candidate };
    },
    async discardDerivedRevision(input) {
      if (
        input.materialId !== candidate.materialId ||
        input.revisionId !== candidate.revisionId ||
        input.requestId !== candidate.requestId ||
        input.baseRevisionId !== candidate.derivedFromRevisionId
      ) {
        return false;
      }
      candidate.revision -= 1;
      candidate.revisionId = input.baseRevisionId;
      candidate.requestId = undefined;
      candidate.startedAt = undefined;
      candidate.status = "ready";
      candidate.derivedFromRevisionId = undefined;
      chunks.length = 0;
      return true;
    },
    async setReviewState(input) {
      if (
        input.materialId !== candidate.materialId ||
        input.revisionId !== candidate.revisionId
      ) {
        return false;
      }
      candidate.reviewStatus = input.reviewStatus;
      candidate.reviewActor = input.actor;
      candidate.reviewUpdatedAt = input.updatedAt;
      candidate.qualitySignals = input.qualitySignals ?? [];
      return true;
    },
    async listChunks() {
      return chunks.map((chunk) => ({ ...chunk }));
    },
  };

  const gateway: PreparationMaterialExtractionGateway = {
    async extract() {
      gatewayCalls += 1;
      if (options.gatewayError) throw options.gatewayError;
      return options.gatewayResult ?? nativeResult();
    },
    async discard(input) {
      discardedRequests.push(input.requestId);
      return true;
    },
  };

  return {
    candidate,
    chunks,
    discardedRequests,
    events,
    get gatewayCalls() {
      return gatewayCalls;
    },
    dependencies: {
      repository,
      gateway,
      now: () => ++timestamp,
      createId: () => `generated-${++id}`,
      onBackgroundError: () => {},
      onEvent: (event: PreparationExtractionTraceEvent) => events.push(event),
    },
  };
}

function nativeResult(): NativePreparationMaterialExtractionResult {
  return {
    method: "pdf-text",
    status: "ready",
    extractedTextRelativePath:
      "interview-preparation/workspace-1/materials/material-1/extraction/1/extracted.txt",
    textChars: 26,
    pageCount: 2,
    ocrPageCount: 0,
    ocrCandidatePageCount: 0,
    ocrProcessedPageCount: 0,
    ocrFailedPageCount: 0,
    ocrSupplementChars: 0,
    warningCodes: [],
    durationMs: 45,
    chunks: [
      {
        ordinal: 0,
        content: "Design a retrieval system.",
        searchText: "design a retrieval system.",
        page: 2,
        section: "Architecture",
        sourceMethod: "pdf-text",
        startOffset: 0,
        endOffset: 26,
      },
    ],
  };
}

function baseChunk(
  ordinal: number,
  page: number | undefined,
  content: string
): PreparationMaterialChunk {
  return {
    id: `base-chunk-${ordinal}`,
    workspaceId: "workspace-1",
    materialId: "material-1",
    materialRevisionId: "revision-1",
    extractionRequestId: "base-request",
    ordinal,
    content,
    searchText: content.toLowerCase(),
    page,
    sourceMethod: "pdf-text",
    createdAt: 1,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not reached.");
}
