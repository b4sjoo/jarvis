import assert from "node:assert/strict";
import test from "node:test";
import { createPreparationConversationExecutionService } from "../src/lib/preparation/conversation-execution.js";

test("PREP-G1/G2 detaching a view retains the same request and returning sees partial then one commit", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const first = new Promise<void>((resolve) => { started = resolve; });
  let requests = 0, commits = 0, oldNotifications = 0;
  const service = createService({
    async *fetchResponse(input) {
      requests++; yield "First"; started(); await gate;
      assert.equal(input.signal?.aborted, false); yield " complete answer";
    },
    async commitAssistant(input) { commits++; return { committed: true, assistantMessage: { id: "answer", content: input.content } }; },
  });
  const detach = service.subscribe(() => { oldNotifications++; });
  const request = service.execute({ processId: "process-1", conversationId: "conversation-1", content: "Prepare", route: readyRoute() });
  await first; detach();
  const count = oldNotifications;
  assert.equal(service.getSnapshot()?.partial, "First");
  await assert.rejects(service.execute({ processId: "process-1", conversationId: "another", content: "Other", route: readyRoute() }), /still generating/);
  release(); await request;
  assert.equal(service.getSnapshot()?.status, "committed");
  assert.equal(service.getSnapshot()?.partial, "First complete answer");
  assert.equal(oldNotifications, count);
  assert.equal(requests, 1); assert.equal(commits, 1);
});

test("PREP-G3 explicit Stop aborts the original request without committing partial output", async () => {
  let started!: () => void;
  const first = new Promise<void>((resolve) => { started = resolve; });
  let commits = 0;
  const service = createService({
    async *fetchResponse(input) {
      yield "Partial"; started();
      await new Promise<void>((_resolve, reject) => input.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    },
    async commitAssistant() { commits++; return { committed: true }; },
  });
  const request = service.execute({ processId: "process-1", conversationId: "conversation-1", content: "Prepare", route: readyRoute() });
  const rejected = assert.rejects(request, /cancelled/);
  await first; service.cancel("unrelated"); assert.equal(service.getSnapshot()?.status, "running");
  await service.cancelAndWait(); await rejected;
  assert.equal(service.getSnapshot()?.status, "cancelled"); assert.equal(commits, 0);
});

test("streams a preparation preview but commits only the complete response", async () => {
  let commitCount = 0;
  const deltas: string[] = [];
  let capturedRequest:
    | {
        systemPrompt?: string;
        userMessage: string;
        requestOptions?: { timeoutMs?: number; maxOutputTokens?: number };
      }
    | undefined;
  const service = createService({
    async *fetchResponse(input) {
      capturedRequest = input;
      yield "First";
      yield " complete answer";
    },
    async commitAssistant(input: { content: string }) {
      commitCount += 1;
      assert.equal(input.content, "First complete answer");
      return {
        committed: true,
        assistantMessage: { id: "assistant-message", content: input.content },
      };
    },
  });

  const result = await service.execute({
    processId: "process-1",
    conversationId: "conversation-1",
    content: "Help me prepare.",
    route: readyRoute(),
    onDelta(content) {
      assert.equal(commitCount, 0);
      deltas.push(content);
    },
  });

  assert.deepEqual(deltas, ["First", "First complete answer"]);
  assert.equal(result.status, "committed");
  assert.equal(commitCount, 1);
  assert.match(capturedRequest?.systemPrompt ?? "", /untrusted source content/);
  assert.match(capturedRequest?.userMessage ?? "", /bounded_preparation_context/);
  assert.equal(capturedRequest?.requestOptions?.timeoutMs, 180_000);
  assert.equal(capturedRequest?.requestOptions?.maxOutputTokens, 16_384);
});

test("drops a stale preparation result instead of making it visible", async () => {
  const events: string[] = [];
  const service = createService({
    async *fetchResponse() {
      yield "Late answer";
    },
    async commitAssistant() {
      return { committed: false, assistantMessage: undefined };
    },
    onEvent(event: { name: string }) {
      events.push(event.name);
    },
  });

  const result = await service.execute({
    processId: "process-1",
    conversationId: "conversation-1",
    content: "New request superseded this one.",
    route: readyRoute(),
  });

  assert.equal(result.status, "stale");
  assert.ok(events.includes("Preparation model stale result dropped"));
  assert.ok(!events.includes("Preparation model request finished"));
});

test("does not commit a provider failure body as an assistant answer", async () => {
  let cancelCount = 0;
  let commitCount = 0;
  const service = createService({
    async *fetchResponse() {
      yield "API request failed: quota exceeded";
    },
    async commitAssistant() {
      commitCount += 1;
      return { committed: true };
    },
    onCancel() {
      cancelCount += 1;
    },
  });

  await assert.rejects(
    service.execute({
      processId: "process-1",
      conversationId: "conversation-1",
      content: "Help me prepare.",
      route: readyRoute(),
    }),
    /quota exceeded/
  );
  assert.equal(commitCount, 0);
  assert.equal(cancelCount, 1);
});

test("removes a material quality report from the visible answer and downgrades evidence", async () => {
  const flagged: string[] = [];
  const service = createService({
    async *fetchResponse() {
      yield 'Use the verified definition.\n<material_quality_report>{"materials":[{"materialId":"material-1","signals":[{"code":"page-gap","detail":"Pages 3-4 are missing","confidence":0.9}]}]}</material_quality_report>';
    },
    async commitAssistant(input) {
      assert.equal(input.content, "Use the verified definition.");
      return { committed: true, assistantMessage: { id: "answer", content: input.content } };
    },
    sourceRefs: [
      {
        kind: "material",
        id: "chunk-1",
        title: "Guide.pdf",
        materialId: "material-1",
        materialRevisionId: "revision-1",
        sourceMethod: "pdf-text",
        materialStatus: "ready",
        selectedChars: 20,
        truncated: false,
      },
    ],
    onFlagQuality(materialId) {
      flagged.push(materialId);
    },
  });

  const result = await service.execute({
    processId: "process-1",
    conversationId: "conversation-1",
    content: "Check the OCR extraction quality of this guide.",
    route: readyRoute(),
  });

  assert.equal(result.status, "committed");
  assert.deepEqual(flagged, ["material-1"]);
});

test("does not let a material inventory request downgrade cited evidence", async () => {
  const flagged: string[] = [];
  let systemPrompt = "";
  const service = createService({
    async *fetchResponse(input) {
      systemPrompt = input.systemPrompt ?? "";
      yield 'Two materials are visible.\n<material_quality_report>{"materials":[{"materialId":"material-1","signals":[{"code":"missing-page","detail":"Page 1 was not included in this request context","confidence":0.99}]}]}</material_quality_report>';
    },
    async commitAssistant(input) {
      assert.equal(input.content, "Two materials are visible.");
      return { committed: true, assistantMessage: { id: "answer", content: input.content } };
    },
    sourceRefs: [
      {
        kind: "material",
        id: "chunk-1",
        title: "Guide.pdf",
        materialId: "material-1",
        materialRevisionId: "revision-1",
        sourceMethod: "pdf-text",
        materialStatus: "ready",
        selectedChars: 20,
        truncated: false,
      },
    ],
    onFlagQuality(materialId) {
      flagged.push(materialId);
    },
  });

  const result = await service.execute({
    processId: "process-1",
    conversationId: "conversation-1",
    content: "What materials can you see now?",
    route: readyRoute(),
  });

  assert.equal(result.status, "committed");
  assert.deepEqual(flagged, []);
  assert.match(systemPrompt, /does not authorize a material-status change/i);
});

test("rejects document-wide quality conclusions from partial request coverage", async () => {
  const acceptedCodes: string[] = [];
  const service = createService({
    async *fetchResponse() {
      yield 'Review complete.\n<material_quality_report>{"materials":[{"materialId":"material-1","signals":[{"code":"missing-page","detail":"Page 1 is missing","confidence":0.99},{"code":"garbled-text","detail":"The supplied excerpt contains repeated replacement glyphs","confidence":0.9}]}]}</material_quality_report>';
    },
    async commitAssistant(input) {
      return { committed: true, assistantMessage: { id: "answer", content: input.content } };
    },
    sourceRefs: [
      {
        kind: "material",
        id: "chunk-1",
        title: "Guide.pdf",
        materialId: "material-1",
        materialRevisionId: "revision-1",
        sourceMethod: "pdf-text",
        materialStatus: "ready",
        selectedChars: 20,
        truncated: false,
      },
    ],
    omittedMaterialChunks: 3,
    onFlagQuality(_materialId, codes) {
      acceptedCodes.push(...codes);
    },
  });

  await service.execute({
    processId: "process-1",
    conversationId: "conversation-1",
    content: "Audit the OCR extraction quality and missing pages in this guide.",
    route: readyRoute(),
  });

  assert.deepEqual(acceptedCodes, ["garbled-text"]);
});

test("persists explicit multimodal recovery as review-required material text", async () => {
  const recovered: Array<{
    materialId: string;
    baseRevisionId: string;
    content: { kind: string; text?: string };
  }> = [];
  const service = createService({
    async *fetchResponse(input) {
      assert.equal(input.imagesBase64?.length, 1);
      yield '<material_recovery_result>{"summary":"Recovered one image for review.","materials":[{"materialId":"material-image","extractedText":"Visible heading\\nVisible body","qualitySignals":[]}]}</material_recovery_result>';
    },
    async commitAssistant(input) {
      assert.equal(input.content, "Recovered one image for review.");
      return { committed: true, assistantMessage: { id: "answer", content: input.content } };
    },
    materials: {
      "material-image": {
        id: "material-image",
        workspaceId: "process-1",
        scope: { kind: "workspace" },
        displayName: "diagram.png",
        originalFileName: "diagram.png",
        mimeType: "image/png",
        extension: "png",
        sizeBytes: 100,
        checksumSha256: "checksum",
        storageRelativePath: "materials/material-image/original.png",
        status: "needs-review",
        createdAt: 1,
        updatedAt: 1,
      },
    },
    async readVisuals() {
      return {
        materialKind: "image",
        pageCount: 1,
        pages: [
          {
            base64: "image-base64",
            mediaType: "image/png",
            pageNumber: 1,
            pageCount: 1,
          },
        ],
      };
    },
    onRecovered(materialId, baseRevisionId, content) {
      recovered.push({ materialId, baseRevisionId, content });
    },
  });

  const result = await service.execute({
    processId: "process-1",
    conversationId: "conversation-1",
    content: "Recover this file.",
    route: readyRoute(true),
    recovery: { materialIds: ["material-image"] },
  });

  assert.equal(result.status, "committed");
  assert.deepEqual(recovered, [
    {
      materialId: "material-image",
      baseRevisionId: "revision-material-image",
      content: { kind: "full", text: "Visible heading\nVisible body" },
    },
  ]);
});

test("persists PDF recovery as an exact page patch bound to the base revision", async () => {
  const recovered: Array<{
    baseRevisionId: string;
    content: { kind: string; pageCount?: number; pages?: unknown[] };
  }> = [];
  let requestMetadata: unknown;
  const service = createService({
    async *fetchResponse() {
      yield '<material_recovery_result>{"summary":"Recovered page 2.","materials":[{"materialId":"material-pdf","pages":[{"pageNumber":2,"extractedText":"Recovered second page","qualitySignals":[]}],"qualitySignals":[]}]}</material_recovery_result>';
    },
    async commitAssistant(input) {
      return {
        committed: true,
        assistantMessage: { id: "answer", content: input.content },
      };
    },
    materials: {
      "material-pdf": {
        id: "material-pdf",
        workspaceId: "process-1",
        scope: { kind: "workspace" },
        displayName: "guide.pdf",
        originalFileName: "guide.pdf",
        mimeType: "application/pdf",
        extension: "pdf",
        sizeBytes: 100,
        checksumSha256: "checksum",
        storageRelativePath: "materials/material-pdf/original.pdf",
        status: "needs-review",
        createdAt: 1,
        updatedAt: 1,
      },
    },
    recoveryChunks: [
      { page: 1, content: "First page" },
      { page: 2, content: "Old second page" },
      { page: 3, content: "Third page" },
    ],
    async readVisuals() {
      return {
        materialKind: "pdf",
        pageCount: 3,
        pages: [
          {
            base64: "page-2-base64",
            mediaType: "image/png",
            pageNumber: 2,
            pageCount: 3,
          },
        ],
      };
    },
    onRecovered(_materialId, baseRevisionId, content) {
      recovered.push({ baseRevisionId, content });
    },
    onRequestMetadata(metadata) {
      requestMetadata = metadata;
    },
  });

  const result = await service.execute({
    processId: "process-1",
    conversationId: "conversation-1",
    content: "Recover page 2.",
    route: readyRoute(true),
    recovery: { materialIds: ["material-pdf"] },
  });

  assert.equal(result.status, "committed");
  assert.deepEqual(recovered, [
    {
      baseRevisionId: "revision-material-pdf",
      content: {
        kind: "pdf-pages",
        pageCount: 3,
        pages: [{ pageNumber: 2, text: "Recovered second page" }],
      },
    },
  ]);
  assert.deepEqual(requestMetadata, {
    recovery: {
      materialIds: ["material-pdf"],
      requestedPages: [2],
      targets: [
        {
          materialId: "material-pdf",
          materialKind: "pdf-pages",
          baseRevisionId: "revision-material-pdf",
          pageCount: 3,
          pages: [2],
        },
      ],
    },
  });
});

test("rejects a whole-document replacement for a bounded PDF page recovery", async () => {
  const service = createService({
    async *fetchResponse() {
      yield '<material_recovery_result>{"summary":"Recovered.","materials":[{"materialId":"material-pdf","extractedText":"Only page 2"}]}</material_recovery_result>';
    },
    async commitAssistant() {
      throw new Error("Invalid recovery must not commit an assistant response.");
    },
    materials: {
      "material-pdf": {
        id: "material-pdf",
        workspaceId: "process-1",
        scope: { kind: "workspace" },
        displayName: "guide.pdf",
        originalFileName: "guide.pdf",
        mimeType: "application/pdf",
        extension: "pdf",
        sizeBytes: 100,
        checksumSha256: "checksum",
        storageRelativePath: "materials/material-pdf/original.pdf",
        status: "needs-review",
        createdAt: 1,
        updatedAt: 1,
      },
    },
    recoveryChunks: [{ page: 2, content: "Old second page" }],
    async readVisuals() {
      return {
        materialKind: "pdf",
        pageCount: 3,
        pages: [
          {
            base64: "page-2-base64",
            mediaType: "image/png",
            pageNumber: 2,
            pageCount: 3,
          },
        ],
      };
    },
  });

  await assert.rejects(
    service.execute({
      processId: "process-1",
      conversationId: "conversation-1",
      content: "Recover page 2.",
      route: readyRoute(true),
      recovery: { materialIds: ["material-pdf"] },
    }),
    /whole-document replacement|invalid PDF page-recovery contract/i
  );
});

function createService(overrides: {
  fetchResponse: (input: {
    signal?: AbortSignal;
    systemPrompt?: string;
    userMessage: string;
    imagesBase64?: Array<{ base64: string; mediaType: string }>;
    requestOptions?: { timeoutMs?: number; maxOutputTokens?: number };
  }) => AsyncIterable<string>;
  commitAssistant: (input: { content: string }) => Promise<{
    committed: boolean;
    assistantMessage?: { id: string; content: string };
  }>;
  onEvent?: (event: { name: string }) => void;
  onCancel?: () => void;
  sourceRefs?: Array<{
    kind: "material";
    id: string;
    title: string;
    materialId: string;
    materialRevisionId: string;
    sourceMethod: string;
    materialStatus: "ready" | "needs-review";
    selectedChars: number;
    truncated: boolean;
  }>;
  omittedMaterialChunks?: number;
  materials?: Record<string, {
    id: string;
    workspaceId: string;
    scope: { kind: "workspace" } | { kind: "round"; roundId: string };
    displayName: string;
    originalFileName: string;
    mimeType: string;
    extension?: string;
    sizeBytes: number;
    checksumSha256: string;
    storageRelativePath: string;
    status: "ready" | "needs-review";
    createdAt: number;
    updatedAt: number;
  }>;
  readVisuals?: () => Promise<{
    materialKind: "image" | "pdf";
    pageCount: number;
    pages: Array<{
      base64: string;
      mediaType: string;
      pageNumber: number;
      pageCount: number;
    }>;
  }>;
  recoveryChunks?: Array<{ page?: number; content: string }>;
  onRecovered?: (
    materialId: string,
    baseRevisionId: string,
    content: { kind: string; text?: string; pageCount?: number; pages?: unknown[] }
  ) => void;
  onRequestMetadata?: (metadata: unknown) => void;
  onFlagQuality?: (materialId: string, signalCodes: string[]) => void;
}) {
  const conversation = {
    id: "conversation-1",
    processId: "process-1",
    scope: { kind: "process" as const },
    title: "Entire process",
    titleSource: "automatic" as const,
    status: "active" as const,
    revision: 1,
    summaryRevision: 0,
    activeOperationId: "operation-1",
    createdAt: 1,
    updatedAt: 1,
  };
  const userMessage = {
    id: "user-message",
    conversationId: conversation.id,
    logicalTurnId: "turn-1",
    role: "user" as const,
    content: "Help me prepare.",
    materialRefs: [],
    sourceRefs: [],
    operationId: "operation-1",
    createdAt: 1,
    committedAt: 1,
  };

  return createPreparationConversationExecutionService({
    conversations: {
      async beginRequest(input: {
        content: string;
        materialRefs?: string[];
        requestMetadata?: unknown;
      }) {
        overrides.onRequestMetadata?.(input.requestMetadata);
        return {
          conversation,
          userMessage: {
            ...userMessage,
            content: input.content,
            materialRefs: input.materialRefs ?? [],
          },
          operationId: "operation-1",
          logicalTurnId: "turn-1",
          expectedRevision: 1,
        };
      },
      async load() {
        return { conversation, messages: [userMessage] };
      },
      async updateSummary() {
        return true;
      },
      commitAssistant: overrides.commitAssistant,
      async cancelRequest() {
        overrides.onCancel?.();
        return true;
      },
    } as never,
    contextComposer: {
      async compose() {
        return {
          systemContext: "<process_metadata>Test</process_metadata>",
          recentHistory: [],
          sourceRefs: overrides.sourceRefs ?? [],
          budget: {
            totalChars: 4,
            maxChars: 30_000,
            processMetadataChars: 4,
            rollingSummaryChars: 0,
            recentMessageChars: 0,
            materialChars: 0,
            kmbChars: 0,
            selectedMaterialChunks: 0,
            selectedKmbEntries: 0,
            omittedMaterialChunks: overrides.omittedMaterialChunks ?? 0,
            omittedKmbEntries: 0,
            truncationReasons: [],
          },
        };
      },
    },
    interviewProcesses: {
      async getProcess() {
        return {
          id: "process-1",
          workspaceId: "process-1",
          title: "Test interview",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
        };
      },
      async getRound() {
        return undefined;
      },
    } as never,
    materials: {
      async get(materialId: string) {
        return overrides.materials?.[materialId];
      },
    } as never,
    materialExtraction: {
      async inspect(_workspaceId: string, materialId: string) {
        const material = overrides.materials?.[materialId];
        if (!material) return undefined;
        return {
          candidate: {
            workspaceId: "process-1",
            materialId,
            extension: material.extension ?? "",
            revisionId: `revision-${materialId}`,
            revision: 1,
            sourceChecksumSha256: material.checksumSha256,
            status: material.status,
            reviewStatus:
              material.status === "needs-review" ? "needs-review" : "approved",
            qualitySignals: [],
            metadata:
              material.mimeType === "application/pdf"
                ? {
                    method: "pdf-text",
                    textChars: 100,
                    pageCount: 3,
                    chunkCount: overrides.recoveryChunks?.length ?? 0,
                    warningCodes: [],
                    durationMs: 1,
                    offsetUnit: "unicode-scalar",
                  }
                : undefined,
          },
          chunks: (overrides.recoveryChunks ?? []).map((chunk, ordinal) => ({
            id: `chunk-${ordinal}`,
            workspaceId: "process-1",
            materialId,
            materialRevisionId: `revision-${materialId}`,
            extractionRequestId: "request-1",
            ordinal,
            content: chunk.content,
            searchText: chunk.content.toLowerCase(),
            page: chunk.page,
            sourceMethod: "pdf-text",
            createdAt: 1,
          })),
        };
      },
      async commitCloudImageText() {
        throw new Error("Cloud OCR should not run in this test.");
      },
      async commitRecoveredText(input: {
        materialId: string;
        baseRevisionId: string;
        content: { kind: string; text?: string; pageCount?: number; pages?: unknown[] };
      }) {
        overrides.onRecovered?.(
          input.materialId,
          input.baseRevisionId,
          input.content
        );
        return undefined;
      },
      async flagQuality(input: {
        materialId: string;
        signals: Array<{ code: string }>;
      }) {
        overrides.onFlagQuality?.(
          input.materialId,
          input.signals.map((signal) => signal.code)
        );
        return true;
      },
    },
    imageGateway: {
      async read() {
        throw new Error("Image read should not run in this test.");
      },
      async readVisuals() {
        if (!overrides.readVisuals) {
          throw new Error("Visual read should not run in this test.");
        }
        return overrides.readVisuals();
      },
    },
    fetchResponse: overrides.fetchResponse as never,
    async *fetchQueryResponseEvents() { throw new Error("Stub composer should not rewrite queries."); },
    onEvent: overrides.onEvent as never,
    now: (() => {
      let timestamp = 100;
      return () => ++timestamp;
    })(),
    createId: () => "execution-1",
  });
}

function readyRoute(supportsVision = false) {
  return {
    status: "ready" as const,
    selectedProvider: {
      provider: "preparation-provider",
      variables: { API_KEY: "configured" },
    },
    provider: {
      id: "preparation-provider",
      name: "Preparation Provider",
      curl: "curl https://example.test -H 'Authorization: Bearer {{API_KEY}}'",
    } as never,
    missingRequiredVariables: [],
    supportsVision,
  };
}
