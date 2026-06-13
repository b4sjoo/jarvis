import assert from "node:assert/strict";
import test from "node:test";
import {
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
