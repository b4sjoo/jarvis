import assert from "node:assert/strict";
import test from "node:test";
import {
  gateDiagramOverlayEntriesByDomain,
  getDiagramOverlayGateRejectReason,
  isDiagramOverlayMemoryEntry,
} from "../src/lib/memory/diagram-overlay.js";
import type { MemoryEntry } from "../src/lib/memory/types.js";

test("identifies architecture diagram and whiteboard overlay memory entries", () => {
  assert.equal(
    isDiagramOverlayMemoryEntry(makeMemoryEntry({ type: "architecture_diagram" })),
    true
  );
  assert.equal(
    isDiagramOverlayMemoryEntry(makeMemoryEntry({ type: "whiteboard_overlay" })),
    true
  );
  assert.equal(
    isDiagramOverlayMemoryEntry(makeMemoryEntry({ type: "evaluation_criteria" })),
    false
  );
});

test("allows diagram overlays for general and AI/ML system design tasks", () => {
  const entry = makeMemoryEntry({ type: "architecture_diagram" });

  assert.equal(
    getDiagramOverlayGateRejectReason(
      entry,
      "general-system-design",
      "Design a ticket selling system"
    ),
    undefined
  );
  assert.equal(
    getDiagramOverlayGateRejectReason(
      entry,
      "ai-ml-system-design",
      "Design a RAG trip planning assistant"
    ),
    undefined
  );
});

test("blocks diagram overlays for behavioral and coding tasks", () => {
  const entry = makeMemoryEntry({ type: "whiteboard_overlay" });

  assert.equal(
    getDiagramOverlayGateRejectReason(
      entry,
      "behavioral",
      "Tell me about a time you had conflict"
    ),
    "diagram-overlay-question-type-blocked"
  );
  assert.equal(
    getDiagramOverlayGateRejectReason(
      entry,
      "coding",
      "Solve sliding window maximum"
    ),
    "diagram-overlay-question-type-blocked"
  );
});

test("allows project or field probes only when they explicitly ask for architecture-style context", () => {
  const entry = makeMemoryEntry({ type: "architecture_diagram" });

  assert.equal(
    getDiagramOverlayGateRejectReason(
      entry,
      "project-deep-dive",
      "Can you draw the architecture for Agentic Memory?"
    ),
    undefined
  );
  assert.equal(
    getDiagramOverlayGateRejectReason(
      entry,
      "field-knowledge",
      "Explain the RAG pipeline layers"
    ),
    undefined
  );
  assert.equal(
    getDiagramOverlayGateRejectReason(
      entry,
      "project-deep-dive",
      "What was the hardest part?"
    ),
    "diagram-overlay-question-type-blocked"
  );
});

test("hard-gates mixed overlay candidates to the focused query domain", () => {
  const candidates = [
    makeOverlay("mem_overlay_geo", "Geo location driver matching"),
    makeOverlay("mem_overlay_inventory", "Ticket reservation inventory"),
    makeOverlay("mem_overlay_feed", "Social feed fanout timeline"),
    makeOverlay("mem_overlay_rag", "RAG retrieval indexing vector embeddings"),
    makeOverlay(
      "mem_overlay_ranking",
      "Retrieval and ranking candidate generation recommendation pipeline"
    ),
    makeOverlay(
      "mem_overlay_ml",
      "ML system design feature store model training serving drift"
    ),
  ];
  const cases = [
    {
      query: "Design an Uber-like location tracking system",
      expected: "mem_overlay_geo",
    },
    {
      query: "Design a ticket selling and seat reservation system",
      expected: "mem_overlay_inventory",
    },
    {
      query: "Design an Instagram social feed",
      expected: "mem_overlay_feed",
    },
    {
      query: "Design a RAG pipeline with vector retrieval",
      expected: "mem_overlay_rag",
    },
    {
      query: "Design a recommendation system with candidate generation and ranking",
      expected: "mem_overlay_ranking",
    },
    {
      query: "Design an ML system with a feature store, training, and serving",
      expected: "mem_overlay_ml",
    },
  ];

  for (const item of cases) {
    const result = gateDiagramOverlayEntriesByDomain(candidates, {
      query: item.query,
      questionType: "general-system-design",
    });
    assert.deepEqual(result.allowedEntryIds, [item.expected]);
    assert.equal(result.rejected.length, candidates.length - 1);
    assert.ok(
      result.rejected.every(
        (rejection) => rejection.reason === "diagram-overlay-domain-blocked"
      )
    );
  }
});

test("injects no overlay for an ambiguous system-design query", () => {
  const result = gateDiagramOverlayEntriesByDomain(
    [
      makeOverlay("mem_overlay_geo", "Geo location driver matching"),
      makeOverlay("mem_overlay_feed", "Social feed fanout timeline"),
    ],
    {
      query: "Design a scalable distributed system and draw the architecture",
      questionType: "general-system-design",
    }
  );

  assert.deepEqual(result.context.allowedFamilies, []);
  assert.deepEqual(result.allowedEntryIds, []);
  assert.deepEqual(
    result.rejected.map((item) => item.reason),
    ["diagram-overlay-domain-blocked", "diagram-overlay-domain-blocked"]
  );
  assert.ok(result.context.evidence.includes("query:architecture-intent"));
  assert.deepEqual(result.rejected[0]?.actualFamilies, ["geo-matching"]);
});

function makeOverlay(id: string, text: string) {
  return makeMemoryEntry({
    id,
    title: text,
    content: text,
    tags: text.toLowerCase().split(/\s+/),
    keywords: text.toLowerCase().split(/\s+/),
  });
}

function makeMemoryEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  const now = 1_779_000_000_000;
  return {
    id: "mem_overlay",
    sourceIds: [],
    type: "architecture_diagram",
    title: "Overlay",
    content: "Overlay content",
    scope: "global",
    tags: [],
    keywords: [],
    priority: "normal",
    enabled: true,
    injectionMode: "retrieval",
    useCases: ["meeting_assistant"],
    confidentiality: "normal",
    curationStatus: "curated",
    relatedEntryIds: [],
    evidenceEntryIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
