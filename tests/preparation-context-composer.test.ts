import assert from "node:assert/strict";
import test from "node:test";
import {
  createPreparationContextComposer,
  isMaterialInventoryQuery,
  selectMaterialInventoryContext,
  selectMaterialContext,
  tokenizePreparationQuery,
} from "../src/lib/preparation/context-composer.js";
import type { PreparationMaterialContextCandidate } from "../src/lib/preparation/context-types.js";
import type { MemoryRetrievalResult } from "../src/lib/memory/types.js";
import type { PreparationMaterial } from "../src/lib/preparation/types.js";

test("normalizes a preparation query without losing technical terms", () => {
  assert.deepEqual(
    tokenizePreparationQuery(
      "Please tell me how Agentic Memory uses hybrid BM25 + embedding retrieval."
    ),
    ["embedding", "retrieval", "agentic", "memory", "hybrid", "bm25"]
  );
});

test("recognizes explicit material inventory requests without capturing analysis requests", () => {
  assert.equal(isMaterialInventoryQuery("What materials can you see now?"), true);
  assert.equal(isMaterialInventoryQuery("列出当前范围内可见的文件"), true);
  assert.equal(isMaterialInventoryQuery("Analyze this material for me."), false);
  assert.equal(isMaterialInventoryQuery("Analyze the current materials."), false);
  assert.equal(isMaterialInventoryQuery("总结当前材料的内容"), false);
  assert.equal(isMaterialInventoryQuery("List the contents of this document."), false);
  assert.equal(isMaterialInventoryQuery("列出这个文件里的所有内容"), false);
  assert.equal(isMaterialInventoryQuery("What can you see now?"), false);
});

test("material inventory is deterministic, scope-aware, and metadata-only", async () => {
  let searchCalls = 0;
  let kmbCalls = 0;
  const composer = createPreparationContextComposer({
    materials: {
      async searchCandidates() {
        searchCalls += 1;
        return [];
      },
    },
    materialInventory: {
      async list() {
        return [
          material({
            id: "process-ready",
            displayName: "PROCESS_ALPHA.pdf",
            status: "ready",
            scope: { kind: "workspace" },
          }),
          material({
            id: "round-review",
            displayName: "IMAGE_DELTA.jpg",
            status: "needs-review",
            scope: { kind: "round", roundId: "round-1" },
          }),
          material({
            id: "other-round",
            displayName: "OTHER_ROUND.pdf",
            status: "ready",
            scope: { kind: "round", roundId: "round-2" },
          }),
          material({
            id: "deleted",
            displayName: "DELETED.pdf",
            status: "deleted",
          }),
        ];
      },
    },
    retrieveKmb: async () => {
      kmbCalls += 1;
      return memoryResult();
    },
  });

  const composition = await composer.compose({
    process: {
      id: "process-1",
      workspaceId: "process-1",
      title: "Interview",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    },
    round: {
      id: "round-1",
      processId: "process-1",
      title: "Behavioral",
      stage: "behavioral",
      expectedInterviewTypes: ["behavioral"],
      expectedTypePolicy: "advisory",
      createdAt: 1,
      updatedAt: 1,
    },
    lease: {
      conversation: {
        id: "conversation-1",
        processId: "process-1",
        scope: { kind: "round", roundId: "round-1" },
        title: "Behavioral",
        titleSource: "automatic",
        status: "active",
        revision: 1,
        summaryRevision: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      userMessage: {
        id: "message-1",
        conversationId: "conversation-1",
        logicalTurnId: "turn-1",
        role: "user",
        content: "What materials can you see now?",
        materialRefs: [],
        sourceRefs: [],
        createdAt: 1,
      },
      operationId: "operation-1",
      logicalTurnId: "turn-1",
      expectedRevision: 1,
    },
    messages: [],
  });

  assert.equal(searchCalls, 0);
  assert.equal(kmbCalls, 0);
  assert.match(composition.systemContext, /<material_inventory>/);
  assert.match(composition.systemContext, /PROCESS_ALPHA\.pdf/);
  assert.match(composition.systemContext, /IMAGE_DELTA\.jpg/);
  assert.match(composition.systemContext, /needs-review/);
  assert.doesNotMatch(composition.systemContext, /OTHER_ROUND\.pdf/);
  assert.doesNotMatch(composition.systemContext, /DELETED\.pdf/);
  assert.doesNotMatch(composition.systemContext, /untrusted_material_evidence/);
  assert.doesNotMatch(composition.systemContext, /curated_memory_evidence/);
  assert.equal(composition.budget.selectedMaterialChunks, 0);
  assert.equal(composition.budget.selectedMaterialInventoryItems, 2);
  assert.deepEqual(
    composition.sourceRefs.map((source) => [
      source.title,
      source.sourceMethod,
      source.materialStatus,
    ]),
    [
      ["IMAGE_DELTA.jpg", "material-inventory", "needs-review"],
      ["PROCESS_ALPHA.pdf", "material-inventory", "ready"],
    ]
  );
});

test("process-scoped inventory excludes every round-scoped material", () => {
  const selected = selectMaterialInventoryContext({
    materials: [
      material({ id: "process", scope: { kind: "workspace" } }),
      material({
        id: "round",
        displayName: "Round.pdf",
        scope: { kind: "round", roundId: "round-1" },
      }),
    ],
  });

  assert.deepEqual(
    selected.selectedItems.map((item) => item.id),
    ["process"]
  );
});

test("material selection enforces six chunks and three chunks per material", () => {
  const candidates = Array.from({ length: 10 }, (_, index) =>
    candidate({
      chunkId: `chunk-${index}`,
      materialId: index < 7 ? "material-a" : `material-${index}`,
      materialName: index < 7 ? "Agentic Memory" : `Supporting ${index}`,
      content: `agentic memory retrieval design ${index}`,
    })
  );

  const selected = selectMaterialContext({
    candidates,
    query: "agentic memory retrieval design",
    queryTokens: ["agentic", "memory", "retrieval", "design"],
    preferredMaterialIds: [],
    roundId: "round-1",
  });

  assert.equal(selected.selectedCount, 6);
  assert.equal(
    selected.sourceRefs.filter((source) => source.materialId === "material-a")
      .length,
    3
  );
  assert.ok(selected.selectedChars <= 8_000);
});

test("explicit document overview samples beyond the normal three-chunk cap", () => {
  const candidates = Array.from({ length: 12 }, (_, index) =>
    candidate({
      chunkId: `behavior-${index}`,
      materialId: "behavior-material",
      materialName: "BEHAVIOR_CHARLIE.pdf",
      content: `Leadership Principle ${index + 1}\nStrength signal ${index + 1}`,
      page: index + 1,
    })
  );

  const selected = selectMaterialContext({
    candidates,
    query: "Explain BEHAVIOR_CHARLIE and list all Leadership Principles.",
    queryTokens: ["behavior_charlie", "leadership", "principles"],
    preferredMaterialIds: [],
    roundId: "round-1",
  });

  assert.equal(selected.selectedCount, 12);
  assert.match(selected.text, /Leadership Principle 1/);
  assert.match(selected.text, /Leadership Principle 12/);
  assert.equal(selected.sourceRefs[0]?.availableChunks, 12);
  assert.equal(selected.sourceRefs[0]?.coveredChunks, 12);
  assert.ok(selected.selectedChars <= 8_000);
});

test("document overview keeps structural evidence after fragmented boilerplate", () => {
  const candidates = Array.from({ length: 12 }, (_, index) =>
    candidate({
      chunkId: `fragmented-${index}`,
      materialId: "behavior-material",
      materialName: "BEHAVIOR_CHARLIE.pdf",
      content:
        index === 0
          ? "Amazon\nConfidential\nAmazon\nInterview\nQuestion\nBank\n15\nSTRIVE\nTO\nBE\nEARTH'S\nBEST\nEMPLOYER\nDefinition and Indicators"
          : `Leadership Principle ${index + 1}\nDefinition ${index + 1}`,
      page: index + 1,
    })
  );

  const selected = selectMaterialContext({
    candidates,
    query: "List all Leadership Principles in BEHAVIOR_CHARLIE.",
    queryTokens: ["leadership", "principles", "behavior_charlie"],
    preferredMaterialIds: [],
    roundId: "round-1",
  });

  assert.match(selected.text, /STRIVE TO BE EARTH'S BEST EMPLOYER/);
  assert.equal(selected.sourceRefs[0]?.coveredChunks, 12);
});

test("PREP-C1 document overview preserves eligible bounded KMB selected by retrieval", async () => {
  const composer = createPreparationContextComposer({
    materials: {
      async searchCandidates() {
        return [
          candidate({
            materialId: "behavior-material",
            materialName: "BEHAVIOR_CHARLIE.pdf",
            content: "Customer Obsession definition and indicators",
          }),
        ];
      },
    },
    materialInventory: {
      async list() {
        return [];
      },
    },
    retrieveKmb: async () => memoryResult() as never,
  });

  const composition = await composer.compose({
    process: {
      id: "process-1",
      workspaceId: "process-1",
      title: "Interview",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    },
    round: {
      id: "round-1",
      processId: "process-1",
      title: "Behavioral",
      stage: "behavioral",
      expectedInterviewTypes: ["behavioral"],
      expectedTypePolicy: "advisory",
      createdAt: 1,
      updatedAt: 1,
    },
    lease: {
      conversation: {
        id: "conversation-1",
        processId: "process-1",
        scope: { kind: "round", roundId: "round-1" },
        title: "Behavioral",
        titleSource: "automatic",
        status: "active",
        revision: 1,
        summaryRevision: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      userMessage: {
        id: "message-1",
        conversationId: "conversation-1",
        logicalTurnId: "turn-1",
        role: "user",
        content: "List all Leadership Principles in BEHAVIOR_CHARLIE.",
        materialRefs: [],
        sourceRefs: [],
        createdAt: 1,
      },
      operationId: "operation-1",
      logicalTurnId: "turn-1",
      expectedRevision: 1,
    },
    messages: [],
  });

  assert.match(composition.systemContext, /curated_memory_evidence/);
  assert.deepEqual(
    composition.sourceRefs.map((source) => source.kind),
    ["material", "kmb"]
  );
  assert.equal(composition.budget.truncationReasons.includes("kmb-skipped-document-overview"), false);
});

test("composes bounded recent history, recap, material, and KMB context", async () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    id: `message-${index}`,
    conversationId: "conversation-1",
    logicalTurnId: `turn-${Math.floor(index / 2)}`,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `${index % 2 === 0 ? "Question" : "Answer"} ${index} ${"detail ".repeat(20)}`,
    materialRefs: [],
    sourceRefs: [],
    createdAt: index,
  }));
  messages.push({
    id: "current-message",
    conversationId: "conversation-1",
    logicalTurnId: "current-turn",
    role: "user",
    content: "How should I explain the Agentic Memory retrieval tradeoff?",
    materialRefs: [],
    sourceRefs: [],
    createdAt: 30,
  });
  const composer = createPreparationContextComposer({
    materials: {
      async searchCandidates() {
        return [
          candidate({
            chunkId: "material-chunk",
            materialId: "material-1",
            materialName: "Agentic Memory design",
            content: "The design uses bounded retrieval and explicit consolidation.",
          }),
        ];
      },
    },
    materialInventory: {
      async list() {
        return [];
      },
    },
    retrieveKmb: async () => memoryResult() as never,
  });

  const composition = await composer.compose({
    process: {
      id: "process-1",
      workspaceId: "process-1",
      title: "Snowflake interview",
      company: "Snowflake",
      role: "Senior AI Engineer",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    },
    round: {
      id: "round-1",
      processId: "process-1",
      title: "Expertise",
      stage: "project-deep-dive",
      expectedInterviewTypes: ["project-deep-dive"],
      expectedTypePolicy: "advisory",
      createdAt: 1,
      updatedAt: 1,
    },
    lease: {
      conversation: {
        id: "conversation-1",
        processId: "process-1",
        scope: { kind: "round", roundId: "round-1" },
        title: "Expertise",
        titleSource: "automatic",
        status: "active",
        revision: 1,
        summaryRevision: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      userMessage: messages[messages.length - 1],
      operationId: "operation-1",
      logicalTurnId: "current-turn",
      expectedRevision: 1,
    },
    messages,
  });

  assert.equal(composition.recentHistory.length, 16);
  assert.ok((composition.rollingSummary?.length ?? 0) <= 4_000);
  assert.equal(composition.sourceRefs.length, 2);
  assert.ok(composition.budget.totalChars <= 30_000);
  assert.match(composition.systemContext, /untrusted_material_evidence/);
  assert.match(composition.systemContext, /curated_memory_evidence/);
});

function candidate(
  overrides: Partial<PreparationMaterialContextCandidate>
): PreparationMaterialContextCandidate {
  return {
    chunkId: "chunk",
    processId: "process-1",
    materialId: "material",
    materialRevisionId: "revision-1",
    materialName: "Material",
    materialStatus: "ready",
    scopeKind: "round",
    scopeId: "round-1",
    content: "content",
    searchText: "content",
    sourceMethod: "markdown",
    warningCodes: [],
    ...overrides,
  };
}

function material(
  overrides: Partial<PreparationMaterial>
): PreparationMaterial {
  return {
    id: "material",
    workspaceId: "process-1",
    scope: { kind: "workspace" },
    displayName: "Material.pdf",
    originalFileName: "Material.pdf",
    mimeType: "application/pdf",
    extension: "pdf",
    sizeBytes: 100,
    checksumSha256: "checksum",
    storageRelativePath: "materials/material/Material.pdf",
    status: "ready",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test("PREP-C5: each request independently selects at most three KMB entries", async () => {
  let count = 0;
  const composer = createPreparationContextComposer({
    materials: { searchCandidates: async () => [] },
    materialInventory: { list: async () => [] },
    retrieveKmb: async (input) => {
      assert.equal(input.maxEntries, 3); assert.equal(input.maxChars, 4000);
      const batch = ++count, base = memoryResult();
      return { ...base, eligibleCount: 4, entries: [1, 2, 3, 4].map((n) => ({ ...base.entries[0], entry: { ...base.entries[0].entry, id: `batch-${batch}-${n}` } })) };
    },
  });
  for (const n of [1, 2]) {
    const composition = await composer.compose({
      process: { id: "p", workspaceId: "p", title: "Interview", status: "active", createdAt: 1, updatedAt: 1 },
      lease: {
        conversation: { id: "c", processId: "p", scope: { kind: "process" }, title: "Prepare", titleSource: "automatic", status: "active", revision: n, summaryRevision: 0, createdAt: 1, updatedAt: 1 },
        userMessage: { id: `m-${n}`, conversationId: "c", logicalTurnId: `t-${n}`, role: "user", content: `Explain my project experience ${n}`, materialRefs: [], sourceRefs: [], createdAt: n },
        operationId: `o-${n}`, logicalTurnId: `t-${n}`, expectedRevision: n,
      }, messages: [],
    });
    assert.equal(composition.budget.selectedKmbEntries, 3);
    assert.deepEqual(composition.sourceRefs.filter((ref) => ref.kind === "kmb").map((ref) => ref.id), [1, 2, 3].map((id) => `batch-${n}-${id}`));
    if (n === 2) assert.doesNotMatch(composition.systemContext, /batch-1-/);
  }
  assert.equal(count, 2);
});

function memoryResult(): MemoryRetrievalResult {
  return {
    entries: [
      {
        entry: {
          id: "memory-1",
          sourceIds: [],
          type: "project_context",
          title: "Agentic Memory overview",
          content: "Curated full content",
          scope: "project",
          projectId: "agentic-memory",
          projectName: "Agentic Memory",
          tags: ["memory"],
          keywords: ["retrieval"],
          priority: "high",
          enabled: true,
          injectionMode: "retrieval",
          useCases: ["general_chat"],
          confidentiality: "sensitive",
          curationStatus: "curated",
          relatedEntryIds: [],
          evidenceEntryIds: [],
          createdAt: 1,
          updatedAt: 1,
        },
        score: 20,
        matchReason: ["title"],
        injectedContent: "Curated bounded content",
      },
    ],
    contextText: "Curated bounded content",
    totalChars: 23,
    candidateCount: 1,
    eligibleCount: 1,
    rejectedCount: 0,
    rejectSummary: [],
    policySnapshot: {
      useCase: "general_chat",
      maxEntries: 3,
      maxChars: 4_000,
      perEntryMaxChars: 1_600,
    },
  };
}
