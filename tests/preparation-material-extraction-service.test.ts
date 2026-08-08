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
  };
  let gatewayCalls = 0;
  const discardedRequests: string[] = [];
  const events: PreparationExtractionTraceEvent[] = [];

  const repository: PreparationMaterialExtractionRepository = {
    async getCurrent(materialId) {
      return materialId === candidate.materialId ? { ...candidate } : undefined;
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
        candidate.status === "ready"
      ) {
        return false;
      }
      candidate.status = "extracting";
      candidate.requestId = input.requestId;
      candidate.startedAt = input.startedAt;
      return true;
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
